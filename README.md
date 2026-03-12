# TypeScript + SCSS Template (Vite)

Vite 기반 `TypeScript + SCSS` 보일러플레이트 템플릿입니다.

## Scripts

- `npm run dev`: 개발 서버 실행
- `npm run build`: 타입 체크 후 프로덕션 빌드
- `npm run build:pdf`: 빌드 후 `dist` 텍스트 파일 PDF 리포트 생성
- `npm run preview`: 빌드 결과 미리보기
- `npm run lint`: ESLint 실행
- `npm run format`: Prettier 포맷팅
- `npm run rg -- <pattern>`: ripgrep 검색 (`예: npm run rg -- "TODO" src`)

## Dist PDF Report

`npm run build:pdf`를 실행하면 아래 작업이 순서대로 수행됩니다.

1. `npm run build`
2. `dist` 하위 UTF-8 텍스트 파일을 Prettier 기본값으로 포맷(실제 파일 수정)
3. 단일 PDF 리포트 생성

출력 파일:

- `artifacts/build-report.pdf`

PDF 구성:

- `File Tree` 소제목 + `dist/` 파일 트리
- 파일 트리에 `(용량 / 해시)` 형식으로 `(<size> B / <sha12>)` 표시
- 파일 구분 헤더(`==== path (<size> B / <sha12>) ====`) 기반 연속 본문 출력
- 코드 라인 번호/전체 공백 가시화(`·`) + 들여쓰기 단위 경계 표시 + 탭 기호화(`→`)
- 흑백(회색조) 문법 하이라이트 + 괄호쌍 깊이 강조

참고:

- UTF-8이 아닌 파일은 콘솔에 `[skip]` 로그를 남기고 제외됩니다.
- Prettier parser를 찾지 못한 파일은 `[format-skip]` 경고 후 원문으로 계속 진행합니다.
- 텍스트 파일이 하나도 없으면 스크립트는 실패 코드로 종료됩니다.
- 기본 출력 폰트는 `assets/fonts/D2CodingLigature-*.ttf`를 사용하며, 로드 실패 시 ASCII 심볼로 폴백합니다.
- `sha12`는 선행 들여쓰기를 4칸 기준으로 정규화한 텍스트의 SHA-256 해시 앞 12자리입니다.
- `build:pdf` 포맷 단계는 VSCode 사용자 로컬 설정을 읽지 않고 레포의 `.prettierrc` 설정을 사용합니다.

에어갭 검증:

- `sha12`는 들여쓰기 정규화가 포함되어 단순 `sha256sum`/`certutil` 결과와 다를 수 있습니다.
