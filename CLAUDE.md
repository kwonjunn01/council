# Council

Claude(모더레이터) · Codex · Gemini가 토론·계획·리뷰하고 DeepSeek이 구현하는 데스크탑 앱. 사용자에게는 **항상 한국어로** 답한다.

## 구조
- `server.js`: 127.0.0.1 HTTP API + SSE. POST는 `X-Council: 1` 헤더 필수(CSRF 방지)
- `lib/session.js`: 세션 하나의 전체 흐름(자동/토론/개발 모드, 라운드, 합의, git 체크포인트, 테스트, 요약, 실패 대응, 질문, 고급 모델 투입)
- `lib/council.js`: 여러 세션 관리, 기록 목록, 재시작 복구, 실제 호출 점검(preflight)
- `lib/prompts.js`: 에이전트 프롬프트와 출력 규약 파싱(`VOTE:`, `NEXT:`, `ASK OWNER:`, `ASSIGN:`)
- `lib/runner.js`: CLI 실행(`claude -p`, `codex exec`, `gemini -p`), 출력 파싱, 시간 제한
- `lib/errors.js`: 실패 분류(한도/네트워크/인증/인자/미설치/시간초과)
- `lib/models.js`: 모델·생각 깊이 목록(Codex는 `codex debug models`로 실시간 수집)
- `lib/config.js`: 설정 병합, API 키(`~/.council/secrets.json`, 0600)
- `lib/github.js`, `lib/terminal.js`, `lib/log.js`
- `public/`: UI(바닐라 JS), `electron/`: 데스크탑 래퍼, `mock/mock-agent.js`: 가짜 에이전트
- `config.default.json`: 에이전트별 cmd/args/model/effort 정의. CLI가 바뀌면 여기부터 고친다

## 명령
- `npm test`: 가짜 에이전트로 e2e 18개 시나리오. 변경 후 반드시 통과시킬 것
- `npm start` / `npm run mock` / `npm run desktop` (우분투 24.04에서 샌드박스 오류 시 `npx electron . --no-sandbox`)
- `npm run dist:linux` / `npm run dist:win`: 설치 파일 빌드
- 릴리스 절차는 `RELEASING.md`, 변경 기록은 `CHANGELOG.md` (`[Unreleased]`에 먼저 적는다)

## 규칙
- 런타임 의존성은 `electron-updater` 하나뿐. 서버·UI에 새 의존성을 추가하지 않는다
- 사용자에게 보이는 문구는 한국어, 코드·주석·커밋 메시지는 영어
- 에이전트 CLI 인자를 바꾸면 실제 CLI로 `--help` 확인 후 앱의 "🔌 실제 호출 점검"으로 검증한다

## 이어서 할 일 (2026-10-19 로컬 세션 기준)
완료: main push + CI(Win/Mac/Linux) 통과, Claude·Codex·DeepSeek 실제 호출 점검, 실제 모델 자동 모드 세션(토론 → `NEXT: BUILD` → 계획 → DeepSeek 구현 → 테스트 통과 → 합의), `v0.5.0` 태그 → Release 워크플로가 설치 파일 생성

남은 것:
1. Gemini CLI 로그인(`gemini` 실행) 후 "🔌 실제 호출 점검"으로 4개 모두 확인
2. `v0.5.0` 릴리스가 Draft로 생성됨(electron-builder 기본값). 공개해야 자동 업데이트가 동작한다. 앞으로 바로 공개하려면 `package.json` build.publish에 `"releaseType": "release"` 추가 검토
3. 실제 모델로 `ASK OWNER`·`ASSIGN`은 아직 관찰하지 못했다(작은 과제라 나오지 않음)
4. Actions의 `actions/checkout@v4`·`setup-node@v4`가 Node 20 지원 종료 경고를 낸다. v5로 올리기 검토
