import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import prettier from 'prettier';
import * as sass from 'sass';
import ts from 'typescript';
import { build as viteBuild } from 'vite';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(PROJECT_ROOT, 'src');
const DIST_DIR = path.join(PROJECT_ROOT, 'dist');
const SOURCE_HTML_FILE = path.join(PROJECT_ROOT, 'index.html');
const DIST_HTML_FILE = path.join(DIST_DIR, 'index.html');

const INLINE_WORKER_CONTENT_NAME = 'jsContent';
const WORKER_SOURCE_ID = 'ai-worker-source-1';

/**
 * 운영 배포용 압축 정책입니다.
 * 번들 크기를 줄이되, 핵심 디버깅 이름은 보존하고 이후 prettier로 다시 포매팅합니다.
 */
const TERSER_OPTIONS = {
  compress: {
    passes: 3,
    drop_console: true,
    drop_debugger: true,
    pure_funcs: ['console.log', 'console.info', 'console.debug'],
  },
  mangle: false,
  keep_fnames: true,
  keep_classnames: true,
  format: {
    comments: false,
  },
};

const PRETTIER_JS_OPTIONS = {
  parser: 'babel',
  printWidth: 100,
  singleQuote: true,
};

/**
 * 메인 스레드 모듈 정의입니다. 원본 `src/` 폴더 구조를 그대로 미러링해 개별 classic script로
 * 빌드합니다. 각 파일은 자기 export를 전역 레지스트리에 등록하고, 의존성은 전역에서 읽습니다.
 *
 * `file://`에서는 ES 모듈 로딩이 CORS로 차단되므로, 순서대로 로드되는 classic script + 전역
 * 공유 방식만 사용할 수 있습니다.
 */
const MODULE_BUILDS = [
  {
    key: 'chess-core',
    entry: 'src/chess/chess-core.ts',
    out: 'src/chess/chess-core.js',
    globalName: 'TSChessShared',
    factoryName: '__TSChessCreateChessCore',
    // 워커와 공유하던 기존 전역 이름을 유지합니다.
    epilogue: [
      'globalThis.TSChessShared = TSChessShared;',
      'globalThis.__TSChess = globalThis.__TSChess || {};',
      'globalThis.__TSChess.factories = globalThis.__TSChess.factories || {};',
      'globalThis.__TSChess.factories.chessCore = __TSChessCreateChessCore;',
      'globalThis.__TSChess.chessCore = TSChessShared;',
    ],
    externals: {},
  },
  {
    key: 'chess-runtime',
    entry: 'src/chess/chess-runtime.global.ts',
    out: 'src/chess/chess-runtime.js',
    globalName: '__TSChessRuntime',
    epilogue: [
      'globalThis.__TSChess = globalThis.__TSChess || {};',
      'globalThis.__TSChess.chessRuntime = __TSChessRuntime;',
    ],
    externals: {},
  },
  {
    key: 'ai',
    entry: 'src/chess/ai.ts',
    out: 'src/chess/ai.js',
    globalName: '__TSChessAi',
    factoryName: '__TSChessCreateAi',
    epilogue: [
      'globalThis.__TSChess = globalThis.__TSChess || {};',
      'globalThis.__TSChess.factories = globalThis.__TSChess.factories || {};',
      'globalThis.__TSChess.factories.ai = __TSChessCreateAi;',
      'globalThis.__TSChess.ai = __TSChessAi;',
    ],
    externals: {
      './chess-runtime.ts': 'globalThis.__TSChess.chessRuntime',
    },
  },
  {
    key: 'app',
    entry: 'src/chess/app.ts',
    out: 'src/chess/app.js',
    globalName: '__TSChessApp',
    epilogue: [
      'globalThis.__TSChess = globalThis.__TSChess || {};',
      'globalThis.__TSChess.app = __TSChessApp;',
    ],
    externals: {
      './ai.ts': 'globalThis.__TSChess.ai',
      './chess-runtime.ts': 'globalThis.__TSChess.chessRuntime',
    },
  },
  {
    key: 'main',
    entry: 'src/main.ts',
    out: 'src/main.js',
    globalName: '__TSChessMain',
    epilogue: [],
    externals: {
      './chess/app.ts': 'globalThis.__TSChess.app',
    },
    // 스타일은 별도로 컴파일하므로 메인 번들에서는 제외합니다.
    sideEffectExternals: ['./styles/main.scss'],
  },
];

const WORKER_BOOTSTRAP_BUILD = {
  key: 'ai-worker-bootstrap',
  entry: 'src/chess/ai.worker.ts',
  globalName: '__TSChessAiWorkerBootstrap',
  epilogue: [],
  externals: {
    './ai.ts': 'globalThis.__TSChess.ai',
  },
};

const SCRIPT_LOAD_ORDER = [
  'src/chess/chess-core.js',
  'src/chess/chess-runtime.js',
  'src/chess/ai.js',
  'src/chess/app.js',
  'src/main.js',
];

const STYLE_LOAD_ORDER = ['src/styles/reset.css', 'src/styles/main.css'];
const EXPECTED_DIST_FILES = ['index.html', ...SCRIPT_LOAD_ORDER, ...STYLE_LOAD_ORDER].sort();

const SCRIPT_CLOSE_PATTERN = /<\/script/giu;
const MODULE_SCRIPT_PATTERN = /<script\b[^>]*\bsrc=["'][^"']*\/src\/main\.ts["'][^>]*><\/script>/iu;

function escapeScriptCloseSequence(content) {
  return content.replace(SCRIPT_CLOSE_PATTERN, '<\\/script');
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

function assertClassicScriptParseable(content, label) {
  try {
    new Function(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not parseable as a classic script: ${message}`);
  }
}

function assertWorkerRuntimeExecutable(workerSource) {
  let messageListener = null;
  const postedMessages = [];
  const workerGlobal = {
    addEventListener(type, listener) {
      if (type === 'message') {
        messageListener = listener;
      }
    },
    postMessage(message) {
      postedMessages.push(message);
    },
  };

  try {
    new Function('globalThis', workerSource)(workerGlobal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Assembled AI worker failed to initialize: ${message}`);
  }

  if (typeof messageListener !== 'function') {
    throw new Error('Assembled AI worker did not register a message listener.');
  }

  messageListener({
    data: {
      id: -1,
      fen: workerGlobal.TSChessShared.DEFAULT_POSITION,
      settings: {
        preset: 'easy',
        maxDepth: 1,
        timeLimitMs: 1_000,
        randomness: 30,
        quiescence: true,
      },
    },
  });

  const result = postedMessages.find((message) => message.kind === 'result');
  if (!result?.move) {
    throw new Error('Assembled AI worker did not return a validation move.');
  }
}

async function formatJs(content, label) {
  try {
    return await prettier.format(content, PRETTIER_JS_OPTIONS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[format-skip] ${label}: ${message}`);
    return content;
  }
}

async function listFilesRecursively(rootDir) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(rootDir, entry.name);
      if (entry.isDirectory()) {
        return listFilesRecursively(entryPath);
      }

      return entry.isFile() ? [entryPath] : [];
    }),
  );

  return nestedFiles.flat();
}

function toPosixRelative(rootDir, filePath) {
  return path.relative(rootDir, filePath).split(path.sep).join('/');
}

function assertModuleRegistry(moduleContents) {
  const expectedAssignments = new Map([
    ['chess-core', 'globalThis.TSChessShared = TSChessShared;'],
    ['chess-runtime', 'globalThis.__TSChess.chessRuntime = __TSChessRuntime;'],
    ['ai', 'globalThis.__TSChess.ai = __TSChessAi;'],
    ['app', 'globalThis.__TSChess.app = __TSChessApp;'],
  ]);

  for (const [moduleKey, assignment] of expectedAssignments) {
    if (!moduleContents.get(moduleKey)?.includes(assignment)) {
      throw new Error(`Missing global registry assignment in ${moduleKey}: ${assignment}`);
    }
  }

  if (
    !moduleContents
      .get('chess-core')
      ?.includes('globalThis.__TSChess.factories.chessCore = __TSChessCreateChessCore;') ||
    !moduleContents.get('ai')?.includes('globalThis.__TSChess.factories.ai = __TSChessCreateAi;')
  ) {
    throw new Error('Missing serializable chess worker factory registrations.');
  }

  const mainContent = moduleContents.get('main') ?? '';
  if (!mainContent.includes('globalThis.__TSChess.app.createChessApp()')) {
    throw new Error('Main bootstrap does not call __TSChess.app.createChessApp().');
  }
}

function collectHtmlAssetReferences(html, tagName, attributeName) {
  const tagPattern = new RegExp(
    `<${tagName}\\b[^>]*\\b${attributeName}=["']([^"']+)["'][^>]*>`,
    'giu',
  );
  return [...html.matchAll(tagPattern)].map((match) => match[1].replace(/^\.\//u, ''));
}

function assertOrderedReferences(actual, expected, label) {
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new Error(
      `Unexpected ${label} load order: expected ${expected.join(', ')}, found ${actual.join(', ') || '<none>'}.`,
    );
  }
}

function assertHtmlLayout(html) {
  assertOrderedReferences(
    collectHtmlAssetReferences(html, 'link', 'href'),
    STYLE_LOAD_ORDER,
    'stylesheet',
  );
  assertOrderedReferences(
    collectHtmlAssetReferences(html, 'script', 'src'),
    SCRIPT_LOAD_ORDER,
    'script',
  );

  const workerSourceCount = [...html.matchAll(new RegExp(`id=["']${WORKER_SOURCE_ID}["']`, 'gu'))]
    .length;
  if (workerSourceCount !== 1) {
    throw new Error(`Expected one inline worker bootstrap block, found ${workerSourceCount}.`);
  }

  if (/\btype=["']module["']/iu.test(html)) {
    throw new Error('file:// dist must not contain module scripts.');
  }
}

async function assertDistFileLayout() {
  const actualFiles = (await listFilesRecursively(DIST_DIR))
    .map((filePath) => toPosixRelative(DIST_DIR, filePath))
    .sort();

  if (
    actualFiles.length !== EXPECTED_DIST_FILES.length ||
    actualFiles.some((value, index) => value !== EXPECTED_DIST_FILES[index])
  ) {
    throw new Error(
      `Unexpected dist file layout: expected ${EXPECTED_DIST_FILES.join(', ')}, found ${actualFiles.join(', ') || '<none>'}.`,
    );
  }
}

/**
 * 지정한 import 지정자를 external(전역 참조)로 강제하는 플러그인입니다.
 * Vite 기본 resolve가 절대 경로로 바꾸기 전에 원본 지정자 그대로 external 처리해
 * `output.globals` 키 매칭이 안정적으로 동작하게 합니다.
 */
function externalGlobalsPlugin(specifiers) {
  const externalSet = new Set(specifiers);
  return {
    name: 'tschess-external-globals',
    enforce: 'pre',
    resolveId(source) {
      if (externalSet.has(source)) {
        return { id: source, external: true };
      }

      return null;
    },
  };
}

async function buildModuleIife(moduleBuild) {
  const externalEntries = Object.entries(moduleBuild.externals ?? {});
  const sideEffectExternals = moduleBuild.sideEffectExternals ?? [];
  const externalSpecifiers = [
    ...externalEntries.map(([specifier]) => specifier),
    ...sideEffectExternals,
  ];

  const result = await viteBuild({
    configFile: false,
    logLevel: 'silent',
    plugins: [externalGlobalsPlugin(externalSpecifiers)],
    build: {
      write: false,
      emptyOutDir: false,
      target: 'es2022',
      minify: 'terser',
      terserOptions: TERSER_OPTIONS,
      cssMinify: false,
      sourcemap: false,
      reportCompressedSize: false,
      lib: {
        entry: path.join(PROJECT_ROOT, moduleBuild.entry),
        name: moduleBuild.globalName,
        formats: ['iife'],
        fileName: () => 'module.js',
      },
      rollupOptions: {
        output: {
          extend: false,
          globals: Object.fromEntries(externalEntries),
        },
      },
    },
  });

  const outputs = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;
  const chunks = outputs.filter((item) => item.type === 'chunk');
  const entryChunk = chunks.find((chunk) => chunk.isEntry) ?? chunks[0];

  if (!entryChunk) {
    throw new Error(`No JS chunk produced for module ${moduleBuild.key}.`);
  }

  let moduleCode = entryChunk.code;
  let factorySource = null;

  if (moduleBuild.factoryName) {
    factorySource = [
      `function ${moduleBuild.factoryName}() {`,
      entryChunk.code,
      `return ${moduleBuild.globalName};`,
      '}',
    ].join('\n');
    moduleCode = `${factorySource}\nvar ${moduleBuild.globalName} = ${moduleBuild.factoryName}();`;
  }

  const epilogue = moduleBuild.epilogue.length > 0 ? `\n${moduleBuild.epilogue.join('\n')}\n` : '';
  return { code: `${moduleCode}${epilogue}`, factorySource };
}

function createWorkerRuntimeSource(chessCoreFactorySource, aiFactorySource, workerBootstrap) {
  return [
    'globalThis.__TSChess = globalThis.__TSChess || {};',
    `globalThis.TSChessShared = (${chessCoreFactorySource})();`,
    'globalThis.__TSChess.chessRuntime = {',
    '  Chess: globalThis.TSChessShared.Chess,',
    '  SQUARES: globalThis.TSChessShared.SQUARES,',
    '};',
    `globalThis.__TSChess.ai = (${aiFactorySource})();`,
    workerBootstrap,
  ].join('\n');
}

function createWorkerRuntimeFromBuiltModules(moduleContents, workerBootstrap) {
  const mainThreadGlobal = {};

  for (const moduleKey of ['chess-core', 'chess-runtime', 'ai']) {
    new Function('globalThis', moduleContents.get(moduleKey))(mainThreadGlobal);
  }

  const chessCoreFactory = mainThreadGlobal.__TSChess?.factories?.chessCore;
  const aiFactory = mainThreadGlobal.__TSChess?.factories?.ai;
  if (!chessCoreFactory || !aiFactory) {
    throw new Error('Built modules did not expose serializable chess worker factories.');
  }

  return createWorkerRuntimeSource(
    chessCoreFactory.toString(),
    aiFactory.toString(),
    workerBootstrap,
  );
}

function createWorkerSourceExpression() {
  return [
    '(() => {',
    `  const element = document.getElementById(${JSON.stringify(WORKER_SOURCE_ID)});`,
    '  const registry = globalThis.__TSChess;',
    '  const chessCoreFactory = registry?.factories?.chessCore;',
    '  const aiFactory = registry?.factories?.ai;',
    '  if (!element) {',
    `    throw new Error(${JSON.stringify(`Missing inline worker bootstrap: ${WORKER_SOURCE_ID}`)});`,
    '  }',
    '  if (!chessCoreFactory || !aiFactory) {',
    "    throw new Error('Missing serializable chess worker factories');",
    '  }',
    '  return [',
    "    'globalThis.__TSChess = globalThis.__TSChess || {};',",
    '    `globalThis.TSChessShared = (${chessCoreFactory.toString()})();`,',
    "    'globalThis.__TSChess.chessRuntime = {',",
    "    '  Chess: globalThis.TSChessShared.Chess,',",
    "    '  SQUARES: globalThis.TSChessShared.SQUARES,',",
    "    '};',",
    '    `globalThis.__TSChess.ai = (${aiFactory.toString()})();`,',
    "    element.textContent || '',",
    "  ].join('\\n');",
    '})()',
  ].join('\n');
}

async function extractInlineWorker(appJsContent) {
  const sourceFile = ts.createSourceFile(
    'app.js',
    appJsContent,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const literals = collectInlineWorkerLiterals(sourceFile);

  if (literals.length !== 1) {
    throw new Error(
      `Expected exactly one inline worker source (${INLINE_WORKER_CONTENT_NAME}) in app.js, found ${literals.length}.`,
    );
  }

  const [literal] = literals;
  const replacedAppJs = applyStringLiteralReplacements(appJsContent, [
    {
      start: literal.getStart(sourceFile),
      end: literal.end,
      text: createWorkerSourceExpression(),
    },
  ]);

  return await formatJs(replacedAppJs, 'src/chess/app.js after worker extraction');
}

function createWorkerSourceElement(workerBootstrap) {
  return [
    `<script id="${WORKER_SOURCE_ID}" type="text/plain">`,
    escapeScriptCloseSequence(workerBootstrap.trimEnd()),
    '</script>',
  ].join('\n');
}

async function compileStyles() {
  const resetScssFile = path.join(SRC_DIR, 'styles/reset.scss');
  const mainScssFile = path.join(SRC_DIR, 'styles/main.scss');

  const resetCss = sass.compile(resetScssFile, { style: 'expanded' }).css;

  // main.scss는 reset을 @use로 포함하므로, 분리 출력 시 중복을 피하려고 해당 줄만 제거합니다.
  const mainScssSource = (await readFile(mainScssFile, 'utf8')).replace(
    /^[^\S\n]*@use\s+['"]\.\/reset\.scss['"]\s*;?[^\S\n]*$/mu,
    '',
  );
  const mainCss = sass.compileString(mainScssSource, {
    url: pathToFileURL(mainScssFile),
    style: 'expanded',
  }).css;

  return { 'src/styles/reset.css': resetCss, 'src/styles/main.css': mainCss };
}

function buildHtml(sourceHtml, workerBootstrap) {
  if (!MODULE_SCRIPT_PATTERN.test(sourceHtml)) {
    throw new Error('Could not find the module entry script (/src/main.ts) in index.html.');
  }

  const styleLinks = STYLE_LOAD_ORDER.map(
    (href) => `    <link rel="stylesheet" href="./${href}" />`,
  ).join('\n');

  const htmlWithStyles = sourceHtml.replace(/([^\S\n]*)<\/head>/iu, `${styleLinks}\n$1</head>`);

  const scriptTags = SCRIPT_LOAD_ORDER.map(
    (src) => `    <script src="./${src}" defer></script>`,
  ).join('\n');
  const runtimeBlock = createWorkerSourceElement(workerBootstrap);

  return htmlWithStyles.replace(MODULE_SCRIPT_PATTERN, () => `${runtimeBlock}\n${scriptTags}`);
}

async function main() {
  await rm(DIST_DIR, { recursive: true, force: true });
  await mkdir(DIST_DIR, { recursive: true });

  const moduleContents = new Map();
  for (const moduleBuild of MODULE_BUILDS) {
    const { code } = await buildModuleIife(moduleBuild);
    moduleContents.set(moduleBuild.key, await formatJs(code, moduleBuild.out));
  }

  const workerBuild = await buildModuleIife(WORKER_BOOTSTRAP_BUILD);
  const workerBootstrap = await formatJs(workerBuild.code, 'ai worker bootstrap');
  moduleContents.set('app', await extractInlineWorker(moduleContents.get('app')));

  const workerRuntimeSource = createWorkerRuntimeFromBuiltModules(moduleContents, workerBootstrap);

  const styles = await compileStyles();

  // 검증: 모든 스크립트가 classic script로 파싱 가능해야 합니다.
  for (const moduleBuild of MODULE_BUILDS) {
    assertClassicScriptParseable(moduleContents.get(moduleBuild.key), moduleBuild.out);
  }
  assertClassicScriptParseable(workerBootstrap, 'ai worker bootstrap');
  assertClassicScriptParseable(workerRuntimeSource, 'assembled ai worker');
  assertWorkerRuntimeExecutable(workerRuntimeSource);
  assertModuleRegistry(moduleContents);

  // 파일 기록: 원본 폴더 구조 그대로 dist/src/** 아래에 배치합니다.
  for (const moduleBuild of MODULE_BUILDS) {
    const targetFile = path.join(DIST_DIR, moduleBuild.out);
    await mkdir(path.dirname(targetFile), { recursive: true });
    await writeFile(targetFile, moduleContents.get(moduleBuild.key), 'utf8');
  }

  for (const [relativePath, css] of Object.entries(styles)) {
    const targetFile = path.join(DIST_DIR, relativePath);
    await mkdir(path.dirname(targetFile), { recursive: true });
    await writeFile(targetFile, css, 'utf8');
  }

  const sourceHtml = await readFile(SOURCE_HTML_FILE, 'utf8');
  const html = buildHtml(sourceHtml, workerBootstrap);
  assertHtmlLayout(html);
  await writeFile(DIST_HTML_FILE, html, 'utf8');
  await assertDistFileLayout();

  console.log(
    `Prepared file:// dist with split assets: ${SCRIPT_LOAD_ORDER.length} JS + ${STYLE_LOAD_ORDER.length} CSS files (worker assembled from shared factories).`,
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to prepare file-url dist: ${message}`);
  process.exit(1);
});
