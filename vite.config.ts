import path from 'node:path';

import { defineConfig } from 'vite';

import type { MinifyOptions } from 'terser';

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

/**
 * Vite 빌드 설정입니다.
 */
export default defineConfig({
  build: {
    modulePreload: false,
    minify: 'terser',
    terserOptions,
    cssMinify: true,
    sourcemap: false,
    reportCompressedSize: false,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
});
