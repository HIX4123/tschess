import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, createWriteStream } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import PDFDocument from 'pdfkit';
import prettier from 'prettier';
import { createHighlighter } from 'shiki';
import ts from 'typescript';

const PROJECT_ROOT = process.cwd();
const DIST_DIR = path.resolve(PROJECT_ROOT, 'dist');
const ARTIFACTS_DIR = path.resolve(PROJECT_ROOT, 'artifacts');
const OUTPUT_FILE = path.resolve(ARTIFACTS_DIR, 'build-report.pdf');
const NODE_MODULES_DIR = path.resolve(PROJECT_ROOT, 'node_modules');
const FONT_REGULAR_PATH = path.resolve(
  PROJECT_ROOT,
  'assets',
  'fonts',
  'D2CodingLigature-Regular.ttf',
);
const FONT_BOLD_PATH = path.resolve(PROJECT_ROOT, 'assets', 'fonts', 'D2CodingLigature-Bold.ttf');
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

const CODE_FONT_SIZE = 8;
const CODE_LINE_HEIGHT = 10.8;
const COMMAND_MAX_BUFFER = 64 * 1024 * 1024;
const COMMAND_OUTPUT_PREVIEW_LENGTH = 12000;
const DIFF_TEMP_PREFIX = path.join(tmpdir(), 'tschess-dist-diff-');
const SHIKI_THEME = 'github-light';
const SHIKI_LANGS = ['javascript', 'typescript', 'css', 'scss', 'html', 'json', 'xml'];
const EXTENSION_TO_LANGUAGE = new Map([
  ['.js', 'javascript'],
  ['.mjs', 'javascript'],
  ['.ts', 'typescript'],
  ['.css', 'css'],
  ['.scss', 'scss'],
  ['.html', 'html'],
  ['.json', 'json'],
  ['.svg', 'xml'],
  ['.map', 'json'],
  ['.txt', null],
]);

const BRACKET_GRAY_BUCKETS = [
  'oklch(0% 0 0deg / 1)',
  'oklch(31% 0 0deg / 1)',
  'oklch(46% 0 0deg / 1)',
  'oklch(60% 0 0deg / 1)',
];
const OPEN_BRACKET_TO_CLOSE = new Map([
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
]);
const CLOSE_BRACKET_TO_OPEN = new Map([
  [')', '('],
  [']', '['],
  ['}', '{'],
]);
const NUMBER_TOKEN_PATTERN =
  /^[-+]?((\d[\d_]*)(\.\d[\d_]*)?|0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+)$/u;
const INLINE_WORKER_CONTENT_NAME = 'jsContent';
const INLINE_WORKER_SECTION_MARKER = ` :: inline worker ${INLINE_WORKER_CONTENT_NAME} #`;
const OKLCH_COLOR_PATTERN =
  /^oklch\(\s*(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)deg\s*\/\s*(0|1|(?:0?\.\d+))\s*\)$/u;
const PDF_COLOR_CACHE = new Map();

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function linearSrgbToByte(value) {
  const clamped = clamp(value, 0, 1);
  const encoded = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;

  return Math.round(encoded * 255);
}

function oklchToPdfColor(color) {
  const cachedColor = PDF_COLOR_CACHE.get(color);
  if (cachedColor) {
    return cachedColor;
  }

  const match = OKLCH_COLOR_PATTERN.exec(color);
  if (!match) {
    throw new Error(`Unsupported PDF color format: ${color}`);
  }

  const lightness = Number(match[1]) / 100;
  const chroma = Number(match[2]);
  const hueRadians = (Number(match[3]) * Math.PI) / 180;
  const alpha = clamp(Number(match[4]), 0, 1);
  const a = Math.cos(hueRadians) * chroma;
  const b = Math.sin(hueRadians) * chroma;

  const lPrime = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lPrime ** 3;
  const m = mPrime ** 3;
  const s = sPrime ** 3;

  const result = {
    channels: [
      linearSrgbToByte(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
      linearSrgbToByte(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
      linearSrgbToByte(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    ],
    opacity: alpha,
  };

  PDF_COLOR_CACHE.set(color, result);
  return result;
}

function truncateCommandOutput(value) {
  if (!value || value.length <= COMMAND_OUTPUT_PREVIEW_LENGTH) {
    return value;
  }

  return `${value.slice(0, COMMAND_OUTPUT_PREVIEW_LENGTH)}\n... <truncated>`;
}

function commandToString(command, args) {
  return [command, ...args].join(' ');
}

function execFileText(command, args, options = {}) {
  const { allowedExitCodes = [0], ...execOptions } = options;

  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        maxBuffer: COMMAND_MAX_BUFFER,
        ...execOptions,
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') {
          reject(error);
          return;
        }

        const exitCode = typeof error?.code === 'number' ? error.code : 0;

        if (error && !allowedExitCodes.includes(exitCode)) {
          const output = truncateCommandOutput(stderr || stdout || error.message);
          reject(new Error(`Command failed: ${commandToString(command, args)}\n${output}`));
          return;
        }

        resolve({ stdout, stderr, exitCode });
      },
    );
  });
}

function toDisplayPath(filePath) {
  return path.relative(PROJECT_ROOT, filePath) || '.';
}

function createSymbols(unicodeCapable) {
  if (!unicodeCapable) {
    return {
      treeBranch: '|-- ',
      treeLast: '\\-- ',
      treePipe: '|   ',
      treeSpace: '    ',
      visibleSpace: '.',
      visibleTab: '->',
      indentBoundary: '|',
      continuation: '-> ',
    };
  }

  return {
    treeBranch: '├── ',
    treeLast: '└── ',
    treePipe: '│   ',
    treeSpace: '    ',
    visibleSpace: '·',
    visibleTab: '→',
    indentBoundary: '┆',
    continuation: '↪ ',
  };
}

function createStyles(fonts) {
  return {
    treeTitle: { color: 'oklch(0% 0 0deg / 1)', font: fonts.bold },
    tree: { color: 'oklch(18% 0 0deg / 1)', font: fonts.regular },
    sectionHeader: { color: 'oklch(18% 0 0deg / 1)', font: fonts.bold },
    separator: { color: 'oklch(41% 0 0deg / 1)', font: fonts.regular },
    lineNumber: { color: 'oklch(51% 0 0deg / 1)', font: fonts.regular },
    continuation: { color: 'oklch(42% 0 0deg / 1)', font: fonts.regular },
    whitespaceMarker: { color: 'oklch(78% 0 0deg / 1)', font: fonts.regular },
    indentBoundary: { color: 'oklch(65% 0 0deg / 1)', font: fonts.regular },
    codeDefault: { color: 'oklch(18% 0 0deg / 1)', font: fonts.regular },
    comment: { color: 'oklch(63% 0 0deg / 1)', font: fonts.italic },
    keyword: { color: 'oklch(16% 0 0deg / 1)', font: fonts.bold },
    string: { color: 'oklch(41% 0 0deg / 1)', font: fonts.regular },
    number: { color: 'oklch(29% 0 0deg / 1)', font: fonts.bold },
    functionName: { color: 'oklch(23% 0 0deg / 1)', font: fonts.bold },
    typeName: { color: 'oklch(32% 0 0deg / 1)', font: fonts.bold },
    tagName: { color: 'oklch(26% 0 0deg / 1)', font: fonts.bold },
    attribute: { color: 'oklch(46% 0 0deg / 1)', font: fonts.regular },
    diffContextMarker: { color: 'oklch(51% 0 0deg / 1)', font: fonts.regular },
    diffAddMarker: { color: 'oklch(38% 0.12 150deg / 1)', font: fonts.bold },
    diffDeleteMarker: { color: 'oklch(43% 0.15 28deg / 1)', font: fonts.bold },
    diffAddBackground: 'oklch(94% 0.03 150deg / 1)',
    diffDeleteBackground: 'oklch(94% 0.04 28deg / 1)',
  };
}

function toChars(text, style) {
  const chars = [];
  for (const char of text) {
    chars.push({ char, style });
  }
  return chars;
}

function sameStyle(left, right) {
  return left.color === right.color && left.font === right.font;
}

class PdfLineRenderer {
  constructor(doc, baseFont) {
    this.doc = doc;
    this.currentY = doc.page.margins.top;
    this.leftX = doc.page.margins.left;
    this.rightX = doc.page.width - doc.page.margins.right;
    this.bottomY = doc.page.height - doc.page.margins.bottom;

    doc.font(baseFont).fontSize(CODE_FONT_SIZE);
    this.charWidth = doc.widthOfString('M');
    this.maxColumns = Math.max(24, Math.floor((this.rightX - this.leftX) / this.charWidth));
  }

  ensureLineSpace() {
    if (this.currentY + CODE_LINE_HEIGHT <= this.bottomY) {
      return;
    }

    this.doc.addPage();
    this.currentY = this.doc.page.margins.top;
    this.leftX = this.doc.page.margins.left;
    this.rightX = this.doc.page.width - this.doc.page.margins.right;
    this.bottomY = this.doc.page.height - this.doc.page.margins.bottom;
  }

  writeLine(chars, options = {}) {
    this.ensureLineSpace();
    if (options.backgroundColor) {
      const backgroundColor = oklchToPdfColor(options.backgroundColor);
      this.doc
        .save()
        .rect(this.leftX, this.currentY, this.rightX - this.leftX, CODE_LINE_HEIGHT)
        .fillColor(backgroundColor.channels, backgroundColor.opacity)
        .fill()
        .restore();
    }

    if (chars.length === 0) {
      this.currentY += CODE_LINE_HEIGHT;
      return;
    }

    let x = this.leftX;
    let index = 0;

    while (index < chars.length) {
      const startStyle = chars[index].style;
      let text = '';

      while (index < chars.length && sameStyle(chars[index].style, startStyle)) {
        text += chars[index].char;
        index += 1;
      }

      const fillColor = oklchToPdfColor(startStyle.color);

      this.doc
        .font(startStyle.font)
        .fontSize(CODE_FONT_SIZE)
        .fillColor(fillColor.channels, fillColor.opacity)
        .text(text, x, this.currentY, { lineBreak: false });

      x += this.doc.widthOfString(text);
    }

    this.currentY += CODE_LINE_HEIGHT;
  }
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

function readUtf8Strict(buffer) {
  return UTF8_DECODER.decode(buffer);
}

function detectSpaceIndentUnit(content) {
  const lines = content.split(/\r?\n/u);
  const indentCounts = [];

  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }

    const match = line.match(/^( +)/u);
    if (!match) {
      continue;
    }

    indentCounts.push(match[1].length);
  }

  if (indentCounts.length === 0) {
    return 2;
  }

  const hasNonMultipleOfFour = indentCounts.some((count) => count % 4 !== 0);
  return hasNonMultipleOfFour ? 2 : 4;
}

function normalizeLeadingForHash(leading, spaceIndentUnit) {
  let indentLevel = 0;
  let spaces = 0;

  for (const char of leading) {
    if (char === '\t') {
      indentLevel += 1;
      continue;
    }
    if (char === ' ') {
      spaces += 1;
    }
  }

  indentLevel += Math.floor(spaces / spaceIndentUnit);
  const residualSpaces = spaces % spaceIndentUnit;

  return `${' '.repeat(indentLevel * 4)}${' '.repeat(residualSpaces)}`;
}

function normalizeIndentForHash(content) {
  const spaceIndentUnit = detectSpaceIndentUnit(content);
  return content.replace(/^[ \t]+/gmu, (leading) =>
    normalizeLeadingForHash(leading, spaceIndentUnit),
  );
}

function computeSha12(content) {
  const normalized = normalizeIndentForHash(content);
  const digest = createHash('sha256').update(normalized, 'utf8').digest('hex');
  return digest.slice(0, 12);
}

function computeBufferSha12(buffer) {
  const digest = createHash('sha256').update(buffer).digest('hex');
  return digest.slice(0, 12);
}

function resolveLanguage(relativePath) {
  const extension = path.extname(relativePath).toLowerCase();
  return EXTENSION_TO_LANGUAGE.get(extension) ?? null;
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

async function extractInlineWorkerSections(relativePath, content) {
  if (path.extname(relativePath).toLowerCase() !== '.js') {
    return { displayContent: content, sections: [] };
  }

  const sourceFile = ts.createSourceFile(
    relativePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const literals = collectInlineWorkerLiterals(sourceFile);

  if (literals.length === 0) {
    return { displayContent: content, sections: [] };
  }

  const replacements = [];
  const sections = [];
  let workerIndex = 0;

  for (const literal of literals) {
    const rawWorkerContent = literal.text;

    try {
      const formattedWorkerContent = await prettier.format(rawWorkerContent, {
        parser: 'babel',
        printWidth: 100,
        singleQuote: true,
      });
      workerIndex += 1;

      const workerLineCount = formattedWorkerContent.split(/\r?\n/u).length;
      const workerSize = Buffer.byteLength(rawWorkerContent, 'utf8');
      const title = `${relativePath} :: inline worker ${INLINE_WORKER_CONTENT_NAME} #${workerIndex}`;
      const placeholder = `[${title} extracted below: ${workerSize} B / ${workerLineCount} lines]`;

      replacements.push({
        start: literal.getStart(sourceFile),
        end: literal.end,
        text: JSON.stringify(placeholder),
      });
      sections.push({
        title,
        syntaxPath: `${relativePath}.inline-worker-${workerIndex}.js`,
        content: formattedWorkerContent,
        size: workerSize,
        lineCount: workerLineCount,
      });
      console.log(
        `[inline-worker] ${relativePath}: extracted ${INLINE_WORKER_CONTENT_NAME} #${workerIndex}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[inline-worker-skip] ${relativePath}: ${message}`);
    }
  }

  if (sections.length === 0) {
    return { displayContent: content, sections: [] };
  }

  return {
    displayContent: applyStringLiteralReplacements(content, replacements),
    sections,
  };
}

async function createTextFileEntry(filePath, relativePath, content, options = {}) {
  let finalContent = content;

  try {
    const prettierConfig = (await prettier.resolveConfig(filePath)) ?? {};
    const formatted = await prettier.format(content, {
      ...prettierConfig,
      filepath: filePath,
    });
    if (options.writeFormatted && formatted !== content) {
      await writeFile(filePath, formatted, 'utf8');
    }
    finalContent = formatted;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[format-skip] ${relativePath}: ${message}`);
  }

  const { displayContent, sections } = await extractInlineWorkerSections(
    relativePath,
    finalContent,
  );

  return {
    relativePath,
    size: Buffer.byteLength(finalContent, 'utf8'),
    content: finalContent,
    displayContent,
    inlineWorkerSections: sections,
    sha12: computeSha12(finalContent),
  };
}

async function collectDistTextFiles(distDir, options = {}) {
  const filePaths = await listFilesRecursively(distDir);
  const sortedFilePaths = filePaths.sort((a, b) => a.localeCompare(b));
  const textFiles = [];
  const fileMetas = new Map();

  for (const filePath of sortedFilePaths) {
    const relativePath = path.relative(distDir, filePath);
    const buffer = await readFile(filePath);
    const rawSha12 = computeBufferSha12(buffer);

    try {
      const content = readUtf8Strict(buffer);
      fileMetas.set(relativePath, {
        kind: 'text',
        size: buffer.length,
        sha12: rawSha12,
      });
      textFiles.push(
        await createTextFileEntry(filePath, relativePath, content, {
          writeFormatted: options.writeFormatted,
        }),
      );
    } catch {
      fileMetas.set(relativePath, {
        kind: 'binary',
        size: buffer.length,
        sha12: rawSha12,
      });
      console.warn(`[skip] ${relativePath}: not valid UTF-8 text`);
    }
  }

  return { textFiles, fileMetas };
}

function createComparableEntries(textFiles) {
  const entries = new Map();

  for (const file of textFiles) {
    const displayContent = file.displayContent ?? file.content;
    entries.set(file.relativePath, {
      relativePath: file.relativePath,
      syntaxPath: file.relativePath,
      content: displayContent,
      size: Buffer.byteLength(displayContent, 'utf8'),
      sha12: computeSha12(displayContent),
    });

    for (const section of file.inlineWorkerSections ?? []) {
      entries.set(section.title, {
        relativePath: section.title,
        syntaxPath: section.syntaxPath,
        content: section.content,
        size: Buffer.byteLength(section.content, 'utf8'),
        sha12: computeSha12(section.content),
      });
    }
  }

  return entries;
}

async function collectDistSnapshot(distDir, label) {
  const { textFiles, fileMetas } = await collectDistTextFiles(distDir, {
    writeFormatted: false,
  });

  return {
    label,
    textFiles,
    fileMetas,
    entries: createComparableEntries(textFiles),
  };
}

function ensureRelativeAssetReference(relativePath) {
  return relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
}

function assetReferenceMappings(fromRelativePath, move) {
  const fromDirectory = path.posix.dirname(fromRelativePath);
  const oldLocalReference = path.posix.relative(fromDirectory, move.oldRelativePath);
  const newLocalReference = path.posix.relative(fromDirectory, move.newRelativePath);
  const mappings = new Map([
    [`/${move.oldRelativePath}`, `/${move.newRelativePath}`],
    [
      ensureRelativeAssetReference(oldLocalReference),
      ensureRelativeAssetReference(newLocalReference),
    ],
    [oldLocalReference, newLocalReference],
  ]);

  return [...mappings].sort(([left], [right]) => right.length - left.length);
}

function replaceAssetReferences(content, fromRelativePath, move) {
  if (move.oldRelativePath === move.newRelativePath) {
    return content;
  }

  let output = content;

  for (const [oldReference, newReference] of assetReferenceMappings(fromRelativePath, move)) {
    output = output.replaceAll(oldReference, newReference);
  }

  return output;
}

function normalizeDistAssetReference(reference) {
  if (reference.includes('://') || reference.startsWith('../')) {
    return null;
  }

  if (reference.startsWith('/') || reference.startsWith('./') || !reference.startsWith('.')) {
    return reference.replace(/^\.?\//u, '');
  }

  return null;
}

function extractAttributeReferences(html, tagName, attributeName) {
  const references = [];
  const tagPattern = new RegExp(`<${tagName}\\b([^>]*)>`, 'giu');
  const attributePattern = new RegExp(
    `${attributeName}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s"'>]+)`,
    'iu',
  );
  let match;

  while ((match = tagPattern.exec(html)) !== null) {
    const attributeMatch = attributePattern.exec(match[1]);
    if (!attributeMatch) {
      continue;
    }

    const rawValue = attributeMatch[1];
    references.push(rawValue.replace(/^["']|["']$/gu, ''));
  }

  return references;
}

function collectReferencedBundles(html) {
  const references = [
    ...extractAttributeReferences(html, 'script', 'src'),
    ...extractAttributeReferences(html, 'link', 'href'),
  ];

  return [
    ...new Set(
      references
        .map((reference) => normalizeDistAssetReference(reference))
        .filter(
          (reference) =>
            reference && ['.js', '.css'].includes(path.extname(reference).toLowerCase()),
        ),
    ),
  ];
}

async function moveBundleFile(distDir, sourceRelativePath, targetRelativePath) {
  const sourceFile = path.join(distDir, sourceRelativePath);
  const targetFile = path.join(distDir, targetRelativePath);
  const oldRelativePath = distRelativePath(distDir, sourceFile);

  if (sourceRelativePath !== targetRelativePath) {
    try {
      accessSync(targetFile);
      throw new Error(
        `Cannot canonicalize ${oldRelativePath}; ${targetRelativePath} already exists in dist.`,
      );
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }

    await rename(sourceFile, targetFile);
  }

  return {
    oldRelativePath,
    newRelativePath: targetRelativePath,
  };
}

function removeViteHash(fileName) {
  const extension = path.extname(fileName);
  const baseName = fileName.slice(0, -extension.length);
  return `${baseName.replace(/-[A-Za-z0-9_-]{8}$/u, '')}${extension}`;
}

function appendCollisionSuffix(relativePath, suffix) {
  const extension = path.posix.extname(relativePath);
  return `${relativePath.slice(0, -extension.length)}-${suffix}${extension}`;
}

async function createCanonicalBundleMoves(distDir) {
  const files = await listFilesRecursively(distDir);
  const bundleFiles = files
    .filter((filePath) => ['.js', '.css'].includes(path.extname(filePath).toLowerCase()))
    .sort((a, b) => distRelativePath(distDir, a).localeCompare(distRelativePath(distDir, b)));
  const occupiedPaths = new Set(files.map((filePath) => distRelativePath(distDir, filePath)));
  const moves = [];

  for (const filePath of bundleFiles) {
    const oldRelativePath = distRelativePath(distDir, filePath);
    const stableBaseName = removeViteHash(path.posix.basename(oldRelativePath));
    const stableRelativePath = path.posix.join(path.posix.dirname(oldRelativePath), stableBaseName);
    if (stableRelativePath === oldRelativePath) {
      continue;
    }

    let newRelativePath = stableRelativePath;
    let collisionIndex = 2;
    while (occupiedPaths.has(newRelativePath)) {
      newRelativePath = appendCollisionSuffix(stableRelativePath, collisionIndex);
      collisionIndex += 1;
    }

    occupiedPaths.add(newRelativePath);
    moves.push({ oldRelativePath, newRelativePath });
  }

  return moves;
}

async function assertReferencedBundlesExist(distDir, html) {
  const references = collectReferencedBundles(html);
  if (references.length === 0) {
    throw new Error('Expected at least one referenced JS or CSS bundle in dist/index.html.');
  }

  for (const reference of references) {
    accessSync(path.join(distDir, reference));
  }
}

async function rewriteMovedAssetReferences(distDir, moves) {
  if (moves.length === 0) {
    return;
  }

  const files = await listFilesRecursively(distDir);
  const textFiles = files.filter((filePath) =>
    ['.html', '.js', '.css'].includes(path.extname(filePath).toLowerCase()),
  );

  for (const filePath of textFiles) {
    const relativePath = distRelativePath(distDir, filePath);
    const content = await readFile(filePath, 'utf8');
    let nextContent = content;

    for (const move of moves) {
      nextContent = replaceAssetReferences(nextContent, relativePath, move);
    }

    if (nextContent !== content) {
      await writeFile(filePath, nextContent, 'utf8');
    }
  }
}

async function canonicalizeDistBundleNames(distDir) {
  const htmlFile = path.join(distDir, 'index.html');
  const html = await readFile(htmlFile, 'utf8');
  await assertReferencedBundlesExist(distDir, html);

  const plannedMoves = await createCanonicalBundleMoves(distDir);
  const moves = [];
  for (const move of plannedMoves) {
    moves.push(await moveBundleFile(distDir, move.oldRelativePath, move.newRelativePath));
  }

  await rewriteMovedAssetReferences(distDir, moves);
  await assertReferencedBundlesExist(distDir, await readFile(htmlFile, 'utf8'));
}

function extractScopes(token) {
  const scopes = [];
  if (!Array.isArray(token.explanation)) {
    return scopes;
  }

  for (const fragment of token.explanation) {
    if (!Array.isArray(fragment.scopes)) {
      continue;
    }

    for (const scope of fragment.scopes) {
      if (typeof scope.scopeName === 'string') {
        scopes.push(scope.scopeName);
      }
    }
  }

  return scopes;
}

function hasScope(scopes, needle) {
  return scopes.some((scope) => scope.includes(needle));
}

function styleFromToken(token, styles) {
  const scopes = extractScopes(token);

  if (hasScope(scopes, 'comment')) {
    return styles.comment;
  }
  if (hasScope(scopes, 'keyword') || hasScope(scopes, 'storage') || hasScope(scopes, 'control')) {
    return styles.keyword;
  }
  if (hasScope(scopes, 'string')) {
    return styles.string;
  }
  if (
    hasScope(scopes, 'constant.numeric') ||
    hasScope(scopes, 'constant.language') ||
    NUMBER_TOKEN_PATTERN.test(token.content.trim())
  ) {
    return styles.number;
  }
  if (
    hasScope(scopes, 'entity.name.function') ||
    hasScope(scopes, 'support.function') ||
    hasScope(scopes, 'meta.function-call')
  ) {
    return styles.functionName;
  }
  if (
    hasScope(scopes, 'entity.name.type') ||
    hasScope(scopes, 'storage.type') ||
    hasScope(scopes, 'support.type')
  ) {
    return styles.typeName;
  }
  if (hasScope(scopes, 'entity.name.tag') || hasScope(scopes, 'punctuation.definition.tag')) {
    return styles.tagName;
  }
  if (hasScope(scopes, 'attribute-name')) {
    return styles.attribute;
  }

  return styles.codeDefault;
}

function buildLineCharsFromTokens(rawLine, tokens, styles) {
  const chars = [];
  for (const token of tokens) {
    const tokenStyle = styleFromToken(token, styles);
    for (const char of token.content) {
      chars.push({ char, style: tokenStyle });
    }
  }

  const joined = chars.map((item) => item.char).join('');
  if (joined !== rawLine) {
    return toChars(rawLine, styles.codeDefault);
  }

  return chars;
}

function visualizeWhitespace(chars, symbols, styles, spaceIndentUnit) {
  const visualizedChars = [];
  let inLeadingIndent = true;
  let leadingSpaceCount = 0;

  for (const item of chars) {
    if (item.char === ' ') {
      if (inLeadingIndent) {
        const isIndentBoundary = leadingSpaceCount % spaceIndentUnit === 0;
        visualizedChars.push({
          char: isIndentBoundary ? symbols.indentBoundary : symbols.visibleSpace,
          style: isIndentBoundary ? styles.indentBoundary : styles.whitespaceMarker,
        });
        leadingSpaceCount += 1;
        continue;
      }

      visualizedChars.push({ char: symbols.visibleSpace, style: styles.whitespaceMarker });
      continue;
    }

    if (item.char === '\t') {
      visualizedChars.push(...toChars(symbols.visibleTab, styles.whitespaceMarker));
      if (inLeadingIndent) {
        leadingSpaceCount = 0;
      }
      continue;
    }

    inLeadingIndent = false;
    visualizedChars.push(item);
  }

  return visualizedChars;
}

function applyBracketDepthEmphasis(chars, stack) {
  for (let index = 0; index < chars.length; index += 1) {
    const value = chars[index].char;
    if (OPEN_BRACKET_TO_CLOSE.has(value)) {
      const color = BRACKET_GRAY_BUCKETS[stack.length % BRACKET_GRAY_BUCKETS.length];
      chars[index] = {
        ...chars[index],
        style: { ...chars[index].style, color },
      };
      stack.push(value);
      continue;
    }

    if (!CLOSE_BRACKET_TO_OPEN.has(value)) {
      continue;
    }

    const expectedOpen = CLOSE_BRACKET_TO_OPEN.get(value);
    const lastOpen = stack[stack.length - 1];
    if (lastOpen !== expectedOpen) {
      continue;
    }

    const color =
      BRACKET_GRAY_BUCKETS[
        (stack.length - 1 + BRACKET_GRAY_BUCKETS.length) % BRACKET_GRAY_BUCKETS.length
      ];
    chars[index] = {
      ...chars[index],
      style: { ...chars[index].style, color },
    };
    stack.pop();
  }
}

function buildWrappedLines(contentChars, maxColumns, firstPrefixChars, continuationPrefixChars) {
  const lines = [];
  const safeMaxColumns = Math.max(16, maxColumns);
  let offset = 0;
  let firstLine = true;

  if (contentChars.length === 0) {
    lines.push([...firstPrefixChars]);
    return lines;
  }

  while (offset < contentChars.length) {
    const prefixChars = firstLine ? firstPrefixChars : continuationPrefixChars;
    const capacity = Math.max(1, safeMaxColumns - prefixChars.length);
    const chunk = contentChars.slice(offset, offset + capacity);
    lines.push([...prefixChars, ...chunk]);
    offset += chunk.length;
    firstLine = false;
  }

  return lines;
}

async function tokenizeByLine(highlighter, file) {
  const language = resolveLanguage(file.syntaxPath ?? file.relativePath);
  if (!language) {
    return null;
  }

  try {
    const result = highlighter.codeToTokens(file.content, {
      lang: language,
      theme: SHIKI_THEME,
      includeExplanation: true,
    });
    return result.tokens;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[highlight-fallback] ${file.relativePath}: ${message}`);
    return null;
  }
}

function createTreeRoot() {
  return {
    directories: new Map(),
    files: [],
  };
}

function insertTreePath(root, relativePath, size, sha12) {
  const segments = relativePath.split(path.sep);
  let current = root;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const isFile = index === segments.length - 1;
    if (isFile) {
      current.files.push({ name: segment, size, sha12 });
      continue;
    }

    if (!current.directories.has(segment)) {
      current.directories.set(segment, createTreeRoot());
    }
    current = current.directories.get(segment);
  }
}

function renderTreeLinesFromNode(node, symbols, prefix = '') {
  const directoryEntries = [...node.directories.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const fileEntries = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
  const entries = [
    ...directoryEntries.map(([name, value]) => ({ type: 'directory', name, value })),
    ...fileEntries.map((value) => ({ type: 'file', ...value })),
  ];

  const lines = [];
  for (const [index, entry] of entries.entries()) {
    const isLast = index === entries.length - 1;
    const connector = isLast ? symbols.treeLast : symbols.treeBranch;
    const childPrefix = prefix + (isLast ? symbols.treeSpace : symbols.treePipe);

    if (entry.type === 'directory') {
      lines.push(`${prefix}${connector}${entry.name}/`);
      lines.push(...renderTreeLinesFromNode(entry.value, symbols, childPrefix));
      continue;
    }

    lines.push(`${prefix}${connector}${entry.name} (${entry.size} B / ${entry.sha12})`);
  }

  return lines;
}

function buildTreeLines(textFiles, symbols) {
  const root = createTreeRoot();
  for (const file of textFiles) {
    insertTreePath(root, file.relativePath, file.size, file.sha12);
  }

  return [
    'File Tree',
    '해시 확인: certutil -hashfile <dist> SHA256',
    'dist/',
    ...renderTreeLinesFromNode(root, symbols),
  ];
}

function writePlainWrappedLine(renderer, text, lineStyle, styles, symbols) {
  const contentChars = toChars(text, lineStyle);
  const continuationPrefix = toChars(symbols.continuation, styles.continuation);
  const wrapped = buildWrappedLines(contentChars, renderer.maxColumns, [], continuationPrefix);
  for (const line of wrapped) {
    renderer.writeLine(line);
  }
}

function writeCodeLines(renderer, rawLines, tokenLines, styles, symbols) {
  const bracketStack = [];
  const gutterWidth = String(Math.max(1, rawLines.length)).length;
  const spaceIndentUnit = detectSpaceIndentUnit(rawLines.join('\n'));

  for (const [lineIndex, rawLine] of rawLines.entries()) {
    const lineNumber = String(lineIndex + 1).padStart(gutterWidth, ' ');
    const firstPrefix = toChars(`${lineNumber} | `, styles.lineNumber);
    const continuationPrefix = [
      ...toChars(`${' '.repeat(gutterWidth)} | `, styles.lineNumber),
      ...toChars(symbols.continuation, styles.continuation),
    ];
    const tokens = tokenLines?.[lineIndex] ?? [{ content: rawLine, explanation: [] }];
    const lineChars = visualizeWhitespace(
      buildLineCharsFromTokens(rawLine, tokens, styles),
      symbols,
      styles,
      spaceIndentUnit,
    );

    applyBracketDepthEmphasis(lineChars, bracketStack);

    const wrappedLines = buildWrappedLines(
      lineChars,
      renderer.maxColumns,
      firstPrefix,
      continuationPrefix,
    );
    for (const physicalLine of wrappedLines) {
      renderer.writeLine(physicalLine);
    }
  }
}

function splitDiffLines(content) {
  if (content.length === 0) {
    return [];
  }

  const normalized = content.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');
  const lines = normalized.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }

  return lines;
}

function parseDiffRange(value, fallbackCount) {
  const [startText, countText] = value.split(',');
  return {
    start: Number(startText),
    count: countText === undefined ? fallbackCount : Number(countText),
  };
}

function parseUnifiedDiffHunks(diffText) {
  const hunks = [];
  let currentHunk = null;

  for (const line of diffText.split(/\r?\n/u)) {
    const headerMatch = line.match(/^@@ -(\d+(?:,\d+)?) \+(\d+(?:,\d+)?) @@/u);
    if (headerMatch) {
      const oldRange = parseDiffRange(headerMatch[1], 1);
      const newRange = parseDiffRange(headerMatch[2], 1);
      currentHunk = {
        oldStart: oldRange.start,
        oldCount: oldRange.count,
        newStart: newRange.start,
        newCount: newRange.count,
        changes: [],
      };
      hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk || line.length === 0 || line.startsWith('\\')) {
      continue;
    }

    const marker = line[0];
    if (marker === '+' || marker === '-' || marker === ' ') {
      currentHunk.changes.push({
        marker,
        text: line.slice(1),
      });
    }
  }

  return hunks;
}

function addContextRows(rows, oldLines, newLines, cursors, oldTarget, newTarget) {
  while (cursors.oldLine < oldTarget && cursors.newLine < newTarget) {
    rows.push({
      kind: 'context',
      oldLine: cursors.oldLine,
      newLine: cursors.newLine,
      rawLine: newLines[cursors.newLine - 1] ?? oldLines[cursors.oldLine - 1] ?? '',
    });
    cursors.oldLine += 1;
    cursors.newLine += 1;
  }
}

function createDiffRows(oldLines, newLines, hunks) {
  const rows = [];
  const cursors = { oldLine: 1, newLine: 1 };

  for (const hunk of hunks) {
    const oldTarget = hunk.oldCount === 0 ? hunk.oldStart + 1 : hunk.oldStart;
    const newTarget = hunk.newCount === 0 ? hunk.newStart + 1 : hunk.newStart;
    addContextRows(rows, oldLines, newLines, cursors, oldTarget, newTarget);

    for (const change of hunk.changes) {
      if (change.marker === ' ') {
        rows.push({
          kind: 'context',
          oldLine: cursors.oldLine,
          newLine: cursors.newLine,
          rawLine: newLines[cursors.newLine - 1] ?? change.text,
        });
        cursors.oldLine += 1;
        cursors.newLine += 1;
        continue;
      }

      if (change.marker === '-') {
        rows.push({
          kind: 'delete',
          oldLine: cursors.oldLine,
          newLine: null,
          rawLine: oldLines[cursors.oldLine - 1] ?? change.text,
        });
        cursors.oldLine += 1;
        continue;
      }

      rows.push({
        kind: 'add',
        oldLine: null,
        newLine: cursors.newLine,
        rawLine: newLines[cursors.newLine - 1] ?? change.text,
      });
      cursors.newLine += 1;
    }
  }

  while (cursors.oldLine <= oldLines.length && cursors.newLine <= newLines.length) {
    rows.push({
      kind: 'context',
      oldLine: cursors.oldLine,
      newLine: cursors.newLine,
      rawLine: newLines[cursors.newLine - 1] ?? oldLines[cursors.oldLine - 1] ?? '',
    });
    cursors.oldLine += 1;
    cursors.newLine += 1;
  }

  while (cursors.oldLine <= oldLines.length) {
    rows.push({
      kind: 'delete',
      oldLine: cursors.oldLine,
      newLine: null,
      rawLine: oldLines[cursors.oldLine - 1] ?? '',
    });
    cursors.oldLine += 1;
  }

  while (cursors.newLine <= newLines.length) {
    rows.push({
      kind: 'add',
      oldLine: null,
      newLine: cursors.newLine,
      rawLine: newLines[cursors.newLine - 1] ?? '',
    });
    cursors.newLine += 1;
  }

  return rows;
}

function createDiffPrefix(row, oldWidth, newWidth, styles) {
  const oldText =
    row.oldLine === null ? ''.padStart(oldWidth, ' ') : String(row.oldLine).padStart(oldWidth, ' ');
  const newText =
    row.newLine === null ? ''.padStart(newWidth, ' ') : String(row.newLine).padStart(newWidth, ' ');
  const marker = row.kind === 'add' ? '+' : row.kind === 'delete' ? '-' : ' ';
  const markerStyle =
    row.kind === 'add'
      ? styles.diffAddMarker
      : row.kind === 'delete'
        ? styles.diffDeleteMarker
        : styles.diffContextMarker;

  return [
    ...toChars(`${oldText} ${newText} `, styles.lineNumber),
    ...toChars(marker, markerStyle),
    ...toChars(' | ', styles.lineNumber),
  ];
}

function diffRowBackground(row, styles) {
  if (row.kind === 'add') {
    return styles.diffAddBackground;
  }
  if (row.kind === 'delete') {
    return styles.diffDeleteBackground;
  }

  return null;
}

async function writeDiffCodeRows(renderer, file, highlighter, styles, symbols) {
  if (file.rows.length === 0) {
    writePlainWrappedLine(renderer, '[empty file]', styles.tree, styles, symbols);
    return;
  }

  const rawLines = file.rows.map((row) => row.rawLine);
  const tokenLines = await tokenizeByLine(highlighter, {
    relativePath: file.relativePath,
    syntaxPath: file.syntaxPath,
    content: rawLines.join('\n'),
  });
  const bracketStack = [];
  const oldWidth = String(Math.max(1, file.oldLineCount)).length;
  const newWidth = String(Math.max(1, file.newLineCount)).length;
  const continuationPrefix = [
    ...toChars(`${' '.repeat(oldWidth)} ${' '.repeat(newWidth)}   | `, styles.lineNumber),
    ...toChars(symbols.continuation, styles.continuation),
  ];
  const spaceIndentUnit = detectSpaceIndentUnit(rawLines.join('\n'));

  for (const [rowIndex, row] of file.rows.entries()) {
    const tokens = tokenLines?.[rowIndex] ?? [{ content: row.rawLine, explanation: [] }];
    const lineChars = visualizeWhitespace(
      buildLineCharsFromTokens(row.rawLine, tokens, styles),
      symbols,
      styles,
      spaceIndentUnit,
    );

    applyBracketDepthEmphasis(lineChars, bracketStack);

    const wrappedLines = buildWrappedLines(
      lineChars,
      renderer.maxColumns,
      createDiffPrefix(row, oldWidth, newWidth, styles),
      continuationPrefix,
    );
    const backgroundColor = diffRowBackground(row, styles);
    for (const physicalLine of wrappedLines) {
      renderer.writeLine(physicalLine, { backgroundColor });
    }
  }
}

function setupFonts(doc) {
  const fonts = {
    regular: 'Courier',
    bold: 'Courier-Bold',
    italic: 'Courier-Oblique',
  };

  if (process.env.PDF_FORCE_ASCII === '1') {
    console.warn('[font] PDF_FORCE_ASCII=1 detected. Using ASCII fallback symbols.');
    return { fonts, unicodeCapable: false };
  }

  try {
    accessSync(FONT_REGULAR_PATH);
    accessSync(FONT_BOLD_PATH);
    doc.registerFont('D2Regular', FONT_REGULAR_PATH);
    doc.registerFont('D2Bold', FONT_BOLD_PATH);
    fonts.regular = 'D2Regular';
    fonts.bold = 'D2Bold';
    fonts.italic = 'D2Regular';
    return { fonts, unicodeCapable: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[font-fallback] ${message}`);
    return { fonts, unicodeCapable: false };
  }
}

async function createCodeHighlighter() {
  return createHighlighter({
    themes: [SHIKI_THEME],
    langs: SHIKI_LANGS,
  });
}

async function generatePdf(textFiles, highlighter, outputFile = OUTPUT_FILE) {
  await mkdir(path.dirname(outputFile), { recursive: true });

  const doc = new PDFDocument({
    size: 'A4',
    layout: 'portrait',
    margin: 36,
    autoFirstPage: true,
  });
  const outputStream = createWriteStream(outputFile);
  doc.pipe(outputStream);

  const { fonts, unicodeCapable } = setupFonts(doc);
  const styles = createStyles(fonts);
  const symbols = createSymbols(unicodeCapable);
  const renderer = new PdfLineRenderer(doc, fonts.regular);
  const treeLines = buildTreeLines(textFiles, symbols);

  for (const line of treeLines) {
    const style = line === 'File Tree' ? styles.treeTitle : styles.tree;
    writePlainWrappedLine(renderer, line, style, styles, symbols);
  }
  renderer.writeLine([]);
  writePlainWrappedLine(
    renderer,
    '-'.repeat(renderer.maxColumns),
    styles.separator,
    styles,
    symbols,
  );

  for (const file of textFiles) {
    renderer.writeLine([]);
    writePlainWrappedLine(
      renderer,
      `==== ${file.relativePath} (${file.size} B / ${file.sha12}) ====`,
      styles.sectionHeader,
      styles,
      symbols,
    );

    const rawLines = (file.displayContent ?? file.content).split(/\r?\n/u);
    const tokenLines = await tokenizeByLine(highlighter, {
      ...file,
      content: file.displayContent ?? file.content,
    });
    writeCodeLines(renderer, rawLines, tokenLines, styles, symbols);

    for (const section of file.inlineWorkerSections ?? []) {
      renderer.writeLine([]);
      writePlainWrappedLine(
        renderer,
        `==== ${section.title} (display-only / ${section.size} B / ${section.lineCount} lines) ====`,
        styles.sectionHeader,
        styles,
        symbols,
      );

      const sectionLines = section.content.split(/\r?\n/u);
      const sectionTokens = await tokenizeByLine(highlighter, {
        relativePath: section.title,
        syntaxPath: section.syntaxPath,
        content: section.content,
      });
      writeCodeLines(renderer, sectionLines, sectionTokens, styles, symbols);
    }
  }

  await new Promise((resolve, reject) => {
    outputStream.on('finish', resolve);
    outputStream.on('error', reject);
    doc.on('error', reject);
    doc.end();
  });
}

function distRelativePath(distDir, filePath) {
  return path.relative(distDir, filePath).split(path.sep).join('/');
}

function statusShort(status) {
  if (status === 'added') {
    return 'A';
  }
  if (status === 'deleted') {
    return 'D';
  }
  return 'M';
}

function sideSummary(side) {
  if (!side.exists) {
    return '-';
  }
  return `${side.size} B / ${side.sha12}`;
}

function statusForEntries(oldEntry, newEntry) {
  if (!oldEntry) {
    return 'added';
  }
  if (!newEntry) {
    return 'deleted';
  }
  return 'modified';
}

function entryToDiffSide(entry) {
  if (!entry) {
    return {
      exists: false,
      content: '',
      lines: [],
      size: 0,
      sha12: null,
    };
  }

  return {
    exists: true,
    content: entry.content,
    lines: splitDiffLines(entry.content),
    size: entry.size,
    sha12: entry.sha12,
  };
}

function diffTempFileName(index, relativePath, side) {
  const digest = createHash('sha256').update(relativePath).digest('hex').slice(0, 12);
  return `${String(index).padStart(4, '0')}-${digest}.${side}`;
}

async function writeEntryDiffTempFile(diffWorkDir, index, relativePath, side, entry) {
  if (!entry) {
    return '/dev/null';
  }

  const filePath = path.join(diffWorkDir, diffTempFileName(index, relativePath, side));
  await writeFile(filePath, entry.content, 'utf8');
  return filePath;
}

async function buildEntryDiff(relativePath, oldEntry, newEntry, diffWorkDir, index) {
  const status = statusForEntries(oldEntry, newEntry);

  if (oldEntry && newEntry && oldEntry.content === newEntry.content) {
    return null;
  }

  const oldSide = entryToDiffSide(oldEntry);
  const newSide = entryToDiffSide(newEntry);
  const oldDiffPath = await writeEntryDiffTempFile(
    diffWorkDir,
    index,
    relativePath,
    'old',
    oldEntry,
  );
  const newDiffPath = await writeEntryDiffTempFile(
    diffWorkDir,
    index,
    relativePath,
    'new',
    newEntry,
  );
  const { stdout } = await execFileText(
    'git',
    ['diff', '--no-index', '--unified=0', '--no-color', '--', oldDiffPath, newDiffPath],
    { allowedExitCodes: [0, 1] },
  );
  const hunks = parseUnifiedDiffHunks(stdout);
  const rows = createDiffRows(oldSide.lines, newSide.lines, hunks);
  const syntaxPath = newEntry?.syntaxPath ?? oldEntry?.syntaxPath ?? relativePath;

  return {
    relativePath,
    syntaxPath,
    status,
    oldSide,
    newSide,
    oldLineCount: oldSide.lines.length,
    newLineCount: newSide.lines.length,
    rows,
  };
}

function buildSnapshotSkippedFiles(oldSnapshot, newSnapshot) {
  const relativePaths = [
    ...new Set([...oldSnapshot.fileMetas.keys(), ...newSnapshot.fileMetas.keys()]),
  ].sort((a, b) => a.localeCompare(b));
  const skippedFiles = [];

  for (const relativePath of relativePaths) {
    const oldMeta = oldSnapshot.fileMetas.get(relativePath);
    const newMeta = newSnapshot.fileMetas.get(relativePath);

    if (oldMeta?.kind !== 'binary' && newMeta?.kind !== 'binary') {
      continue;
    }
    if (oldMeta && newMeta && oldMeta.size === newMeta.size && oldMeta.sha12 === newMeta.sha12) {
      continue;
    }

    skippedFiles.push({
      relativePath,
      status: statusForEntries(oldMeta, newMeta),
      reason: 'not valid UTF-8 text',
    });
  }

  return skippedFiles;
}

async function buildSnapshotDiffFiles(oldSnapshot, newSnapshot, diffWorkDir) {
  await mkdir(diffWorkDir, { recursive: true });

  const relativePaths = [
    ...new Set([...oldSnapshot.entries.keys(), ...newSnapshot.entries.keys()]),
  ].sort((a, b) => a.localeCompare(b));
  const files = [];

  for (const [index, relativePath] of relativePaths.entries()) {
    const diffFile = await buildEntryDiff(
      relativePath,
      oldSnapshot.entries.get(relativePath),
      newSnapshot.entries.get(relativePath),
      diffWorkDir,
      index + 1,
    );

    if (diffFile) {
      files.push(diffFile);
    }
  }

  return {
    files,
    skippedFiles: buildSnapshotSkippedFiles(oldSnapshot, newSnapshot),
  };
}

function diffOutputFileName(fromCommit, toCommit) {
  return path.join(ARTIFACTS_DIR, `dist-diff-${fromCommit.short}-${toCommit.short}.pdf`);
}

async function resolveCommit(ref) {
  const { stdout: fullStdout } = await execFileText('git', [
    'rev-parse',
    '--verify',
    `${ref}^{commit}`,
  ]);
  const sha = fullStdout.trim();
  const { stdout: shortStdout } = await execFileText('git', ['rev-parse', '--short=12', sha]);

  return {
    ref,
    sha,
    short: shortStdout.trim(),
  };
}

async function extractCommitArchive(commit, checkoutDir, tempRoot) {
  await mkdir(checkoutDir, { recursive: true });
  const archivePath = path.join(tempRoot, `${commit.short}.tar`);
  await execFileText('git', ['archive', '--format=tar', `--output=${archivePath}`, commit.sha]);
  await execFileText('tar', ['-xf', archivePath, '-C', checkoutDir]);
  await rm(archivePath, { force: true });
}

async function linkCurrentNodeModules(checkoutDir) {
  try {
    accessSync(NODE_MODULES_DIR);
    await symlink(NODE_MODULES_DIR, path.join(checkoutDir, 'node_modules'), 'dir');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[node_modules-skip] ${message}`);
    return false;
  }
}

async function runBuildWithDependencyFallback(commit, checkoutDir) {
  const nodeModulesPath = path.join(checkoutDir, 'node_modules');
  const linkedNodeModules = await linkCurrentNodeModules(checkoutDir);

  try {
    console.log(`[build] ${commit.ref} (${commit.short}) using current node_modules`);
    await execFileText('npm', ['run', 'build'], { cwd: checkoutDir });
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[build-retry] ${commit.ref} (${commit.short}): ${message}`);
  }

  if (linkedNodeModules) {
    await rm(nodeModulesPath, { recursive: true, force: true });
  }

  console.log(`[npm-ci] ${commit.ref} (${commit.short})`);
  await execFileText('npm', ['ci'], { cwd: checkoutDir });
  console.log(`[build] ${commit.ref} (${commit.short}) after npm ci`);
  await execFileText('npm', ['run', 'build'], { cwd: checkoutDir });
}

async function buildCommitDist(commit, tempRoot) {
  const checkoutDir = path.join(tempRoot, commit.short);
  await extractCommitArchive(commit, checkoutDir, tempRoot);
  await runBuildWithDependencyFallback(commit, checkoutDir);

  const distDir = path.join(checkoutDir, 'dist');
  accessSync(distDir);
  await canonicalizeDistBundleNames(distDir);
  return { checkoutDir, distDir };
}

function resolveOutputFile(outputFile) {
  if (!outputFile) {
    return null;
  }
  return path.isAbsolute(outputFile) ? outputFile : path.resolve(PROJECT_ROOT, outputFile);
}

function parseCliArgs(argv) {
  if (argv.length === 0) {
    return { mode: 'report' };
  }

  if (argv[0] !== '--diff') {
    throw new Error(
      'Usage: node scripts/generate-dist-pdf.mjs [--diff <from> <to> [--output <pdf>] [--keep-temp]]',
    );
  }

  const refs = [];
  let outputFile = null;
  let keepTemp = false;

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--keep-temp') {
      keepTemp = true;
      continue;
    }

    if (arg === '--output') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--output requires a PDF path.');
      }
      outputFile = resolveOutputFile(value);
      index += 1;
      continue;
    }

    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    }

    refs.push(arg);
  }

  if (refs.length !== 2) {
    throw new Error('--diff requires exactly two refs: <from> <to>.');
  }

  return {
    mode: 'diff',
    fromRef: refs[0],
    toRef: refs[1],
    outputFile,
    keepTemp,
  };
}

function writeDiffSummary(renderer, report, styles, symbols) {
  const summaryLines = [
    'Dist Diff',
    `from: ${report.from.ref} (${report.from.short})`,
    `to: ${report.to.ref} (${report.to.short})`,
    `changed rendered sections: ${report.files.length}`,
    `skipped binary/non-UTF-8 files: ${report.skippedFiles.length}`,
  ];

  for (const [index, line] of summaryLines.entries()) {
    writePlainWrappedLine(
      renderer,
      line,
      index === 0 ? styles.treeTitle : styles.tree,
      styles,
      symbols,
    );
  }

  if (report.files.length > 0) {
    renderer.writeLine([]);
    writePlainWrappedLine(renderer, 'Changed Files', styles.treeTitle, styles, symbols);
    for (const file of report.files) {
      writePlainWrappedLine(
        renderer,
        `${statusShort(file.status)} ${file.relativePath} (${sideSummary(file.oldSide)} -> ${sideSummary(
          file.newSide,
        )})`,
        styles.tree,
        styles,
        symbols,
      );
    }
  }

  if (report.skippedFiles.length > 0) {
    renderer.writeLine([]);
    writePlainWrappedLine(renderer, 'Skipped Files', styles.treeTitle, styles, symbols);
    for (const file of report.skippedFiles) {
      writePlainWrappedLine(
        renderer,
        `${statusShort(file.status)} ${file.relativePath}: ${file.reason}`,
        styles.tree,
        styles,
        symbols,
      );
    }
  }
}

async function generateDiffPdf(report, highlighter) {
  await mkdir(path.dirname(report.outputFile), { recursive: true });

  const doc = new PDFDocument({
    size: 'A4',
    layout: 'portrait',
    margin: 36,
    autoFirstPage: true,
  });
  const outputStream = createWriteStream(report.outputFile);
  doc.pipe(outputStream);

  const { fonts, unicodeCapable } = setupFonts(doc);
  const styles = createStyles(fonts);
  const symbols = createSymbols(unicodeCapable);
  const renderer = new PdfLineRenderer(doc, fonts.regular);

  writeDiffSummary(renderer, report, styles, symbols);
  renderer.writeLine([]);
  writePlainWrappedLine(
    renderer,
    '-'.repeat(renderer.maxColumns),
    styles.separator,
    styles,
    symbols,
  );

  for (const file of report.files) {
    renderer.writeLine([]);
    writePlainWrappedLine(
      renderer,
      `==== ${statusShort(file.status)} ${file.relativePath} (${sideSummary(
        file.oldSide,
      )} -> ${sideSummary(file.newSide)}) ====`,
      styles.sectionHeader,
      styles,
      symbols,
    );

    if (file.rows.length === 0) {
      writePlainWrappedLine(renderer, '[no text rows]', styles.tree, styles, symbols);
      continue;
    }

    await writeDiffCodeRows(renderer, file, highlighter, styles, symbols);
  }

  await new Promise((resolve, reject) => {
    outputStream.on('finish', resolve);
    outputStream.on('error', reject);
    doc.on('error', reject);
    doc.end();
  });
}

async function generateDistDiffReport(options) {
  const from = await resolveCommit(options.fromRef);
  const to = await resolveCommit(options.toRef);
  const outputFile = options.outputFile ?? diffOutputFileName(from, to);
  const tempRoot = await mkdtemp(DIFF_TEMP_PREFIX);

  try {
    const fromBuild = await buildCommitDist(from, tempRoot);
    const toBuild = await buildCommitDist(to, tempRoot);
    const fromSnapshot = await collectDistSnapshot(fromBuild.distDir, from.short);
    const toSnapshot = await collectDistSnapshot(toBuild.distDir, to.short);
    const { files, skippedFiles } = await buildSnapshotDiffFiles(
      fromSnapshot,
      toSnapshot,
      path.join(tempRoot, 'rendered-diff'),
    );
    const highlighter = await createCodeHighlighter();

    await generateDiffPdf(
      {
        from,
        to,
        files,
        skippedFiles,
        outputFile,
      },
      highlighter,
    );
    console.log(
      `PDF diff report generated: ${toDisplayPath(outputFile)} (${files.length} changed rendered sections, ${skippedFiles.length} skipped)`,
    );
  } finally {
    if (options.keepTemp) {
      console.log(`[keep-temp] ${tempRoot}`);
    } else {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}

async function generateCurrentDistReport() {
  const { textFiles } = await collectDistTextFiles(DIST_DIR, { writeFormatted: false });

  if (textFiles.length === 0) {
    throw new Error('No UTF-8 text files found under dist.');
  }

  const highlighter = await createCodeHighlighter();

  await generatePdf(textFiles, highlighter);
  console.log(`PDF report generated: ${toDisplayPath(OUTPUT_FILE)} (${textFiles.length} files)`);
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.mode === 'diff') {
    await generateDistDiffReport(options);
    return;
  }

  await generateCurrentDistReport();
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to generate PDF report: ${message}`);
  process.exit(1);
});
