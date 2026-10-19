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

## 이어서 할 일 (2026-10-19 클라우드 세션에서 넘어옴)
1. GitHub `kwonjunn01/council`에 push. 워크플로 파일 때문에 `gh auth refresh -h github.com -s workflow`가 필요할 수 있다. push 후 Actions의 CI(Win/Mac/Linux) 결과를 확인하고, 실패하면 고친다
2. 실제 모델 4개로 점검: 각 CLI 로그인, DeepSeek 키는 앱 ⚙에서 입력. 클라우드에서는 네트워크가 막혀 Codex·Gemini·DeepSeek 실제 호출은 검증하지 못했다
3. 실제 모델이 출력 규약(`VOTE/NEXT/ASK OWNER/ASSIGN`)을 지키는지 자동 모드 세션 하나로 확인
4. `v0.5.0` 태그 push → Release 워크플로가 설치 파일을 만드는지 확인
