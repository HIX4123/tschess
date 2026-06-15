import path from 'node:path';

import { defineConfig, type Plugin } from 'vite';

import type { MinifyOptions } from 'terser';

const CHESS_SOURCE_DIR = path.resolve(__dirname, 'src/chess');
const CHESS_RUNTIME_GLOBAL_PATH = path.join(CHESS_SOURCE_DIR, 'chess-runtime.global.ts');
const MAIN_BUNDLE_FILE = 'main.js';
const STYLE_BUNDLE_FILE = 'style.css';

/**
 * 운영 배포용 압축 정책입니다.
 * 번들 크기를 줄이되, 핵심 디버깅 이름은 일부 보존합니다.
 */
const terserOptions: MinifyOptions = {
  compress: {
    passes: 3,
    drop_console: true,
    drop_debugger: true,
    pure_funcs: ['console.log', 'console.info', 'console.debug'],
  },
  mangle: false, // 식별자 축소 활성화
  keep_fnames: true,
  keep_classnames: true,
  format: {
    comments: false, // 주석 제거(라이선스 이슈 있으면 조심)
  },
};

function createChessRuntimeBuildAliasPlugin(): Plugin {
  return {
    name: 'tschess-chess-runtime-build-alias',
    apply: 'build',
    enforce: 'pre',
    resolveId(source) {
      if (source !== './chess-runtime.ts') {
        return null;
      }

      return CHESS_RUNTIME_GLOBAL_PATH;
    },
  };
}

/**
 * Vite 빌드 설정입니다.
 */
export default defineConfig(({ command }) => ({
  base: './',
  plugins: [createChessRuntimeBuildAliasPlugin()],
  build: {
    modulePreload: false,
    minify: 'terser',
    terserOptions,
    cssMinify: true,
    sourcemap: false,
    reportCompressedSize: false,
    rollupOptions: {
      output: {
        entryFileNames: MAIN_BUNDLE_FILE,
        chunkFileNames: '[name].js',
        assetFileNames(assetInfo) {
          if (assetInfo.names.some((name) => path.extname(name).toLowerCase() === '.css')) {
            return STYLE_BUNDLE_FILE;
          }

          return 'assets/[name][extname]';
        },
      },
    },
  },
  resolve: {
    alias: [
      ...(command === 'build'
        ? [{ find: './chess-runtime.ts', replacement: CHESS_RUNTIME_GLOBAL_PATH }]
        : []),
      { find: '@', replacement: path.resolve(__dirname, 'src') },
    ],
  },
}));
