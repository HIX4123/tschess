import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import prettier from 'prettier';
import ts from 'typescript';
import { build as viteBuild } from 'vite';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = path.join(PROJECT_ROOT, 'dist');
const HTML_FILE = path.join(DIST_DIR, 'index.html');
const SHARED_CORE_ENTRY = path.join(PROJECT_ROOT, 'src/chess/chess-core.ts');
const ASSETS_DIR_NAME = 'assets';
const INLINE_WORKER_CONTENT_NAME = 'jsContent';
const SHARED_CORE_GLOBAL_NAME = 'TSChessShared';
const SHARED_CORE_SOURCE_ID = 'ts-chess-shared-core-source';
const WORKER_SOURCE_ID_PREFIX = 'ai-worker-source';
const CORE_BUNDLE_MARKERS = ['class Chess', 'MASK64'];
const ROOT_ASSET_NAMES = new Set(['main.js', 'style.css']);

const SCRIPT_TAG_PATTERN = /<script\b([^>]*)><\/script>/giu;
const LINK_TAG_PATTERN = /<link\b([^>]*)>/giu;
const ATTRIBUTE_PATTERN = /([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>`]+))?/gu;
const SCRIPT_CLOSE_PATTERN = /<\/script/giu;

function decodeAttributeValue(rawValue) {
  if (rawValue === undefined) {
    return '';
  }

  const firstChar = rawValue[0];
  const lastChar = rawValue.at(-1);

  if ((firstChar === '"' && lastChar === '"') || (firstChar === "'" && lastChar === "'")) {
    return rawValue.slice(1, -1);
  }

  return rawValue;
}

function parseAttributes(source) {
  const attributes = new Map();
  let match;

  while ((match = ATTRIBUTE_PATTERN.exec(source)) !== null) {
    attributes.set(match[1].toLowerCase(), {
      name: match[1],
      value: decodeAttributeValue(match[2]),
      hasValue: match[2] !== undefined,
    });
  }

  return attributes;
}

function serializeAttributes(attributes) {
  return [...attributes.values()]
    .map((attribute) => {
      if (!attribute.hasValue) {
        return attribute.name;
      }

      return `${attribute.name}="${attribute.value.replaceAll('"', '&quot;')}"`;
    })
    .join(' ');
}

function normalizeAssetReference(value) {
  if (value.startsWith(`/${ASSETS_DIR_NAME}/`)) {
    return `.${value}`;
  }

  if (value.startsWith(`${ASSETS_DIR_NAME}/`)) {
    return `./${value}`;
  }

  const absoluteRootAsset = value.startsWith('/') ? value.slice(1) : value;
  if (ROOT_ASSET_NAMES.has(absoluteRootAsset)) {
    return `./${absoluteRootAsset}`;
  }

  return value;
}

function assetPathFromReference(reference) {
  const normalized = reference.startsWith('./') ? reference.slice(2) : reference;
  const isRootAsset = ROOT_ASSET_NAMES.has(normalized);
  const isNestedAsset = normalized.startsWith(`${ASSETS_DIR_NAME}/`);

  if (
    normalized.startsWith('/') ||
    normalized.includes('://') ||
    (!isRootAsset && !isNestedAsset)
  ) {
    throw new Error(`Unsupported dist asset reference: ${reference}`);
  }

  return path.join(DIST_DIR, normalized);
}

async function listFilesRecursively(rootDir) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(rootDir, entry.name);
      if (entry.isDirectory()) {
        return listFilesRecursively(entryPath);
      }

      if (entry.isFile()) {
        return [entryPath];
      }

      return [];
    }),
  );

  return files.flat();
}

async function assertFileExists(filePath) {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    throw new Error(`Expected file does not exist: ${path.relative(PROJECT_ROOT, filePath)}`);
  }
}

function assertRelativeAssetReference(reference) {
  const normalized = reference.startsWith('./') ? reference.slice(2) : reference;
  if (
    !reference.startsWith('./') ||
    (!ROOT_ASSET_NAMES.has(normalized) && !normalized.startsWith(`${ASSETS_DIR_NAME}/`))
  ) {
    throw new Error(`Expected relative dist asset reference, found: ${reference}`);
  }
}

function assertClassicScriptParseable(content, label) {
  try {
    new Function(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not parseable as a classic script: ${message}`);
  }
}

function assertCoreMarkersAbsent(content, label) {
  const foundMarker = CORE_BUNDLE_MARKERS.find((marker) => content.includes(marker));
  if (foundMarker) {
    throw new Error(`${label} still contains shared chess core marker: ${foundMarker}`);
  }
}

function isStringLiteralLike(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function collectInlineWorkerLiterals(sourceFile) {
  const literals = [];

  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === INLINE_WORKER_CONTENT_NAME &&
      node.initializer &&
      isStringLiteralLike(node.initializer)
    ) {
      literals.push(node.initializer);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return literals;
}

function applyStringLiteralReplacements(content, replacements) {
  let output = content;
  const sortedReplacements = [...replacements].sort((left, right) => right.start - left.start);

  for (const replacement of sortedReplacements) {
    output = `${output.slice(0, replacement.start)}${replacement.text}${output.slice(replacement.end)}`;
  }

  return output;
}

function escapeScriptCloseSequence(content) {
  return content.replace(SCRIPT_CLOSE_PATTERN, '<\\/script');
}

function createWorkerSourceElement(workerSourceId, workerContent) {
  return [
    `<script id="${workerSourceId}" type="text/plain">`,
    escapeScriptCloseSequence(workerContent.trimEnd()),
    '</script>',
  ].join('\n');
}

function createSharedCoreSourceElement(sharedCoreContent) {
  return [
    `<script id="${SHARED_CORE_SOURCE_ID}" type="text/plain">`,
    escapeScriptCloseSequence(sharedCoreContent.trimEnd()),
    '</script>',
  ].join('\n');
}

function createSharedCoreBootstrapElement() {
  return [
    '<script>',
    '(() => {',
    `  const element = document.getElementById(${JSON.stringify(SHARED_CORE_SOURCE_ID)});`,
    '  if (!element) {',
    `    throw new Error(${JSON.stringify(`Missing shared chess runtime source: ${SHARED_CORE_SOURCE_ID}`)});`,
    '  }',
    '  new Function(element.textContent || "")();',
    '})();',
    '</script>',
  ].join('\n');
}

function createWorkerSourceExpression(workerSourceId) {
  return [
    '(() => {',
    `  const sharedElement = document.getElementById(${JSON.stringify(SHARED_CORE_SOURCE_ID)});`,
    `  const workerElement = document.getElementById(${JSON.stringify(workerSourceId)});`,
    '  if (!sharedElement) {',
    `    throw new Error(${JSON.stringify(`Missing shared chess runtime source: ${SHARED_CORE_SOURCE_ID}`)});`,
    '  }',
    '  if (!workerElement) {',
    `    throw new Error(${JSON.stringify(`Missing inline worker source: ${workerSourceId}`)});`,
    '  }',
    '  return (sharedElement.textContent || "") + "\\n" + (workerElement.textContent || "");',
    '})()',
  ].join('\n');
}

async function formatWorkerContent(content, relativePath, index) {
  try {
    return await prettier.format(content, {
      parser: 'babel',
      printWidth: 100,
      singleQuote: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[worker-html-format-skip] ${relativePath} #${index}: ${message}`);
    return content;
  }
}

async function buildSharedCoreContent() {
  const result = await viteBuild({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      emptyOutDir: false,
      target: 'es2022',
      minify: false,
      sourcemap: false,
      reportCompressedSize: false,
      lib: {
        entry: SHARED_CORE_ENTRY,
        name: SHARED_CORE_GLOBAL_NAME,
        formats: ['iife'],
        fileName: 'shared-chess-core',
      },
      rollupOptions: {
        output: {
          extend: false,
        },
      },
    },
  });
  const outputs = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;
  const chunks = outputs.filter((item) => item.type === 'chunk');

  if (chunks.length !== 1) {
    throw new Error(`Expected one shared chess core chunk, found ${chunks.length}.`);
  }

  const source = `${chunks[0].code}\nglobalThis.${SHARED_CORE_GLOBAL_NAME} = ${SHARED_CORE_GLOBAL_NAME};\n`;

  return prettier.format(source, {
    parser: 'babel',
    printWidth: 100,
    singleQuote: true,
  });
}

async function moveInlineWorkersToHtml(html, jsContent, jsRelativePath, sharedCoreContent) {
  const sourceFile = ts.createSourceFile(
    jsRelativePath,
    jsContent,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const literals = collectInlineWorkerLiterals(sourceFile);

  if (literals.length === 0) {
    return { html, jsContent, movedCount: 0, workerSourceContents: [] };
  }

  const replacements = [];
  const workerSourceElements = [];
  const workerSourceContents = [];

  for (const [literalIndex, literal] of literals.entries()) {
    const workerIndex = literalIndex + 1;
    const workerSourceId = `${WORKER_SOURCE_ID_PREFIX}-${workerIndex}`;
    const formattedWorkerContent = await formatWorkerContent(
      literal.text,
      jsRelativePath,
      workerIndex,
    );

    replacements.push({
      start: literal.getStart(sourceFile),
      end: literal.end,
      text: createWorkerSourceExpression(workerSourceId),
    });
    workerSourceElements.push(createWorkerSourceElement(workerSourceId, formattedWorkerContent));
    workerSourceContents.push(formattedWorkerContent);
    assertCoreMarkersAbsent(
      formattedWorkerContent,
      `${jsRelativePath} worker source #${workerIndex}`,
    );
    console.log(
      `[worker-html] ${jsRelativePath}: moved ${INLINE_WORKER_CONTENT_NAME} #${workerIndex}`,
    );
  }

  const transformedJsContent = applyStringLiteralReplacements(jsContent, replacements);
  const runtimeSourceBlock = `${[
    createSharedCoreSourceElement(sharedCoreContent),
    ...workerSourceElements,
    createSharedCoreBootstrapElement(),
  ].join('\n\n')}\n`;
  let insertedWorkerSourceBlock = false;
  const transformedHtml = html.replace(SCRIPT_TAG_PATTERN, (fullTag, attributeSource) => {
    if (insertedWorkerSourceBlock || !parseAttributes(attributeSource).has('src')) {
      return fullTag;
    }

    insertedWorkerSourceBlock = true;
    return `${runtimeSourceBlock}${fullTag}`;
  });

  return {
    html: transformedHtml,
    jsContent: transformedJsContent,
    movedCount: literals.length,
    workerSourceContents,
  };
}

async function main() {
  let html = await readFile(HTML_FILE, 'utf8');
  const referencedScripts = [];
  const referencedStylesheets = [];

  html = html.replace(SCRIPT_TAG_PATTERN, (fullTag, attributeSource) => {
    const attributes = parseAttributes(attributeSource);
    const src = attributes.get('src');

    if (!src) {
      return fullTag;
    }

    const normalizedSrc = normalizeAssetReference(src.value);
    src.value = normalizedSrc;
    attributes.set('src', src);
    attributes.delete('type');
    attributes.delete('crossorigin');

    if (!attributes.has('defer')) {
      attributes.set('defer', { name: 'defer', value: '', hasValue: false });
    }

    referencedScripts.push(normalizedSrc);
    return `<script ${serializeAttributes(attributes)}></script>`;
  });

  html = html.replace(LINK_TAG_PATTERN, (fullTag, attributeSource) => {
    const attributes = parseAttributes(attributeSource);
    const href = attributes.get('href');

    if (!href) {
      return fullTag;
    }

    const normalizedHref = normalizeAssetReference(href.value);
    href.value = normalizedHref;
    attributes.set('href', href);
    attributes.delete('crossorigin');

    const rel = attributes.get('rel')?.value.toLowerCase();
    if (rel === 'stylesheet') {
      referencedStylesheets.push(normalizedHref);
    }

    return `<link ${serializeAttributes(attributes)}>`;
  });

  if (referencedScripts.length !== 1) {
    throw new Error(`Expected exactly one JS entry script, found ${referencedScripts.length}.`);
  }

  for (const reference of [...referencedScripts, ...referencedStylesheets]) {
    assertRelativeAssetReference(reference);
    await assertFileExists(assetPathFromReference(reference));
  }

  const jsFile = assetPathFromReference(referencedScripts[0]);
  const originalJsContent = await readFile(jsFile, 'utf8');
  const sharedCoreContent = await buildSharedCoreContent();
  const {
    html: htmlWithWorkerSources,
    jsContent,
    movedCount,
    workerSourceContents,
  } = await moveInlineWorkersToHtml(
    html,
    originalJsContent,
    referencedScripts[0],
    sharedCoreContent,
  );
  html = htmlWithWorkerSources;

  assertClassicScriptParseable(jsContent, 'JS entry');
  assertClassicScriptParseable(sharedCoreContent, 'Shared chess core source');
  assertCoreMarkersAbsent(jsContent, 'JS entry');
  for (const [index, workerSourceContent] of workerSourceContents.entries()) {
    assertClassicScriptParseable(
      `${sharedCoreContent}\n${workerSourceContent}`,
      `Shared chess core + worker source #${index + 1}`,
    );
  }

  const distFiles = await listFilesRecursively(DIST_DIR);
  const jsFiles = distFiles.filter((filePath) => path.extname(filePath).toLowerCase() === '.js');

  if (jsFiles.length !== 1 || path.resolve(jsFiles[0]) !== path.resolve(jsFile)) {
    const relativeFiles = jsFiles.map((filePath) => path.relative(DIST_DIR, filePath)).join(', ');
    throw new Error(`Expected one self-contained JS bundle, found: ${relativeFiles}`);
  }

  await writeFile(HTML_FILE, html, 'utf8');
  await writeFile(jsFile, jsContent, 'utf8');
  console.log(
    `Prepared dist/index.html for file:// execution with split JS/CSS assets (${movedCount} worker source block${movedCount === 1 ? '' : 's'} embedded).`,
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to prepare file-url dist: ${message}`);
  process.exit(1);
});
