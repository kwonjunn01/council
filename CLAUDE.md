# Council

Claude(모더레이터) · Codex · Gemini가 토론·계획·리뷰하고 DeepSeek이 구현하는 데스크탑 앱. 사용자에게는 **항상 한국어로** 답한다.

## 구조
- `server.js`: 127.0.0.1 HTTP API + SSE. POST는 `X-Council: 1` 헤더 필수(CSRF 방지)
- `lib/session.js`: 세션 하나의 전체 흐름(자동/토론/개발 모드, 라운드, 합의, git 체크포인트, 테스트, 요약, 실패 대응, 질문, 고급 모델 투입)
- `lib/council.js`: 여러 세션 관리, 기록 목록, 재시작 복구, 실제 호출 점검(preflight)
- `lib/prompts.js`: 에이전트 프롬프트와 출력 규약 파싱(`VOTE:`, `NEXT:`, `ASK OWNER:`, `ASSIGN:`, `FINDING:`), 작업 계약(`## Contract`) 렌더·파싱
- `lib/runner.js`: CLI 실행(`claude -p`, `codex exec`, `gemini -p`), 출력 파싱, 시간 제한
- `lib/errors.js`: 실패 분류(한도/네트워크/인증/인자/미설치/시간초과)
- `lib/models.js`: 모델·생각 깊이 목록(Codex는 `codex debug models`로 실시간 수집)
- `lib/config.js`: 설정 병합, API 키(`~/.council/secrets.json`, 0600)
- `lib/github.js`: `gh`/`git` 호출, PR 초안·준비 상태 게이트. e2e는 `COUNCIL_GH_STUB`(JS 파일 경로)로 gh를 대체한다
- `lib/terminal.js`, `lib/log.js`
- `public/`: UI(바닐라 JS), `electron/`: 데스크탑 래퍼, `mock/mock-agent.js`: 가짜 에이전트
- `config.default.json`: 에이전트별 cmd/args/model/effort 정의. CLI가 바뀌면 여기부터 고친다

## 명령
- `npm test`: 가짜 에이전트로 e2e 27개 시나리오. 변경 후 반드시 통과시킬 것
- `npm start` / `npm run mock` / `npm run desktop` (우분투 24.04에서 샌드박스 오류 시 `npx electron . --no-sandbox`)
- `npm run dist:linux` / `npm run dist:win`: 설치 파일 빌드
- 릴리스 절차는 `RELEASING.md`, 변경 기록은 `CHANGELOG.md` (`[Unreleased]`에 먼저 적는다)

## 규칙
- 런타임 의존성은 `electron-updater` 하나뿐. 서버·UI에 새 의존성을 추가하지 않는다
- 사용자에게 보이는 문구는 한국어, 코드·주석·커밋 메시지는 영어
- 에이전트 CLI 인자를 바꾸면 실제 CLI로 `--help` 확인 후 앱의 "🔌 실제 호출 점검"으로 검증한다

## 이어서 할 일 (2026-10-21 로컬 세션 기준, v0.5.3 공개됨)
- v0.6.0(결과·증거·게시 게이트, 작업 계약, 병렬 리뷰, 결과 중심 UI)은 아직 릴리스하지 않았다. 실제 모델로 결과 카드·계약 패널·병렬 리뷰를 한 번 확인한 뒤 버전을 올린다
- Gemini는 `agy`(Gemini CLI)로 호출한다. 읽기 턴 `--mode plan`, 쓰기 턴 `--dangerously-skip-permissions`. 쓰기 턴은 아직 실제로 검증하지 못했다
- agy는 답을 낸 뒤 종료하지 않고 멈출 때가 있어 runner가 result 이벤트 후 5초 뒤 강제 종료한다(`exitGraceSec`)
- Claude 턴이 느리다(모더레이터 요약 2~12분). 생각 깊이 기본값 조정 검토
- 실제 모델로 `ASSIGN`(Opus 투입)은 아직 관찰하지 못했다
- Actions `checkout`·`setup-node`를 v5로 올렸다 — 다음 CI 실행에서 Node 20 경고가 사라지는지 확인
- `v0.5.0` 릴리스는 Draft로 남아 있다(0.5.3이 최신)
