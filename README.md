<p align="center"><img src="build/icon.png" width="120" alt="Council"></p>

# Council

**Claude Code · Codex · Gemini CLI**를 한 프로젝트에 투입해서 서로 무자비하게 토론하고, 비판하고, 코드를 개선하게 만드는 데스크탑 앱.

API 키 없이 **이미 로그인해둔 각 CLI(구독제)를 헤드리스 모드로 호출**합니다 (`claude -p`, `codex exec`, `gemini -p`).

```
           ┌──────────── Council (orchestrator) ────────────┐
 사람 ───▶ │  턴 순서 · 역할 · 합의 판정 · git 체크포인트 · 요약 │
 (끼어들기) └──┬──────────────┬──────────────┬───────────────┘
              ▼              ▼              ▼
          claude -p      codex exec      gemini -p      (+ DeepSeek 선택)
          모더레이터       메인 워커        리뷰어
              └──────── 같은 프로젝트 폴더 · 같은 대화록 ────────┘
```

## 기본 구성 (왜 이렇게?)

| 역할 | 기본값 | 하는 일 |
|---|---|---|
| **모더레이터** | Claude | 매 라운드 입장을 먼저 내고, 끝나면 *합의된 것 / 남은 쟁점(누가 어떤 입장) / 다음 질문*을 정리. 개발 모드에선 리뷰들을 중복 제거하고 충돌을 **판정**해서 우선순위가 매겨진 **작업 지시서**로 만듦 |
| **메인 워커** | Codex | 유일하게 코드를 쓰는 쪽. `codex exec --full-auto`의 샌드박스 자율 실행이 헤드리스에 가장 안정적 |
| **리뷰어** | Gemini | 반대 논리, 대안, 리서치. 긴 컨텍스트로 전체 코드를 보고 `[BLOCKER]/[MAJOR]/[MINOR]/[UPGRADE]`로 지적 |
| DeepSeek (선택) | 꺼짐 | 저렴한 추가 리뷰어. 에이전트 도구 사용 안정성 때문에 메인 워커로는 비추천 |

- 모더레이터와 워커를 **분리**하는 이유: 구현한 사람이 자기 결과를 판정하지 않게 하려고.
- 코드를 쓰는 건 **한 명뿐**(나머지는 read-only): 셋이 동시에 같은 파일을 고치면 충돌하므로.
- 모든 역할은 UI에서 변경 가능 (워커를 "라운드마다 교대"로 두면 셋이 돌아가며 구현).

## 모드

### 💬 토론
1. **블라인드 오프닝**: 셋이 서로 안 보고 동시에 독립 제안 (앵커링 방지)
2. 매 라운드: 모더레이터가 입장 → 나머지가 이름을 불러가며 반박 → 모더레이터가 정리
3. 각자 마지막 줄에 `VOTE: AGREE | CONTINUE`. **전원 AGREE면 합의** → 최종 보고서(`FINAL.md`)

### 🛠 개발
1. **계획 단계**: 블라인드 계획 → 셋이 계획 토론 → 모더레이터가 `PLAN.md` 확정 (최대 N라운드)
2. **빌드 루프** (매 라운드):
   워커 구현 → **git 자동 커밋** → 테스트 명령 실행 → 리뷰어들이 diff+테스트 결과를 비판 → 모더레이터 작업 지시서 → 다음 라운드 워커가 지시서대로 수정·개선
3. 리뷰어 전원 + 모더레이터 AGREE **그리고** 테스트 통과 → 완료

### 🔥 무자비 모드 / 무제한
- **최대 라운드 0** = 무제한.
- **무자비 모드**: 합의해도 멈추지 않음. 토론은 레드팀 라운드로 합의안을 다시 공격, 개발은 "기준 올리기"로 다음 개선을 구현.
- 둘 다 켜면 **직접 멈출 때까지 영원히** 돕니다. 구독 사용량이 빠르게 소모되니 주의하세요.
- 대화가 길어지면 모더레이터가 오래된 발언을 **자동 요약**해서 컨텍스트를 일정하게 유지합니다. (전체 원문은 `transcript.md`에 남아 있음)

### 🧑 끼어들기
하단 입력창에 쓰면 다음 턴부터 모든 에이전트가 **최우선 지시**로 봅니다. 끝난 세션에 보내면 **이어서 계속** 진행합니다.
`⏸ 일시정지`, `🏁 마무리`(현재 턴 후 최종 보고서), `⛔ 중단`(즉시 kill).

## 🐙 GitHub 연동

`git` + `gh` CLI를 그대로 사용합니다 (`gh auth login` 한 번이면 끝, Council은 토큰을 저장하지 않음).

| 기능 | 설명 |
|---|---|
| **이슈 → 미션** | `#12`, `owner/repo#12`, 이슈 URL을 넣으면 제목·본문·최근 코멘트를 미션으로 가져옴. 주제 칸은 추가 지시로 사용 |
| **세션 전용 브랜치** | 개발 모드는 `council/<세션id>` 브랜치를 만들어 작업. 원래 브랜치는 그대로 |
| **자동 PR** | 끝나면 push + PR 생성. 본문 = 최종 보고서 + 합의된 계획 + `Closes #12` |
| **이슈에 판정 게시** | 토론 모드는 결론을 이슈 코멘트로 게시 |
| **수동 게시** | 세션이 끝난 뒤 왼쪽 `🐙` 버튼. 다시 누르면 PR 본문 업데이트 |

추천 워크플로: 할 일을 GitHub 이슈로 쌓아두고 → 이슈 번호만 넣고 개발 모드 실행 → PR 리뷰 후 머지.

## 설치 & 실행

### 데스크탑 앱 (Windows / macOS / Linux)
[Releases](../../releases)에서 받기:
- **Windows**: `Council-x.y.z-win-x64.exe` (설치형) 또는 `Council-x.y.z-portable.exe` (설치 없이 실행)
- **macOS**: `.dmg` (서명 안 됨 → 처음 한 번 우클릭 → 열기)
- **Linux**: `.AppImage` / `.deb`

### 소스에서

```bash
# 사전: 각 CLI 설치 + 로그인 (한 번씩 대화형으로 실행해서 로그인해 두세요)
npm i -g @anthropic-ai/claude-code @openai/codex @google/gemini-cli

git clone <this repo> council && cd council
npm start            # 브라우저: http://127.0.0.1:4517  (의존성 0개)
npm run mock         # 토큰 안 쓰는 가짜 에이전트로 UI/흐름 체험

npm install          # 데스크탑 앱(Electron)을 쓸 때만
npm run desktop      # 폴더 선택 다이얼로그 포함 데스크탑 창
```

왼쪽 패널에서 각 에이전트 옆 점이 초록이면 CLI가 인식된 것입니다.

### Windows 메모
- `npm i -g`로 설치한 CLI(`claude.cmd`, `codex.cmd`, `gemini.cmd`)를 그대로 인식합니다. PowerShell에서 `claude --version`이 되면 OK.
- Codex CLI의 Windows 네이티브 지원은 아직 실험적입니다. 워커로 불안정하면 메인 워커를 Claude로 바꾸세요.
- 테스트 명령은 `cmd.exe`로 실행됩니다 (`npm test`, `pytest -q` 등은 그대로 동작).

### 빌드 & 릴리스
```bash
npm test                 # 가짜 에이전트로 전체 흐름 e2e 테스트
npm run dist:win         # dist/ 에 Windows 설치 파일 (Linux/macOS에서도 빌드 가능)
git tag v0.2.0 && git push --tags   # GitHub Actions가 Win/Mac/Linux 설치 파일을 Releases에 업로드
```
CI(`.github/workflows/ci.yml`)는 push/PR마다 Windows·macOS·Linux에서 e2e 테스트를 돌립니다.

## 설정

`~/.council/config.json` 또는 실행 폴더의 `council.config.json`으로 `config.default.json`을 덮어씁니다 (`council.config.example.json` 참고).

```jsonc
{
  "language": "Korean",
  "contextBudgetChars": 60000,   // 이 이상 쌓이면 요약
  "turnTimeoutSec": 1800,
  "agents": {
    "deepseek": { "enabled": true },                      // DEEPSEEK_API_KEY 환경변수 필요
    "gemini":   { "cmd": "agy" },                          // 다른 바이너리로 교체 가능
    "codex":    { "role": "Performance-obsessed engineer" } // 페르소나 변경
  }
}
```

각 에이전트는 `cmd` + `args.base / read / write / tail`로 정의됩니다. `read`는 토론·리뷰용(파일 수정 불가), `write`는 워커용. 새 CLI(aider, opencode, Qwen Code 등)도 같은 방식으로 추가할 수 있습니다.

> **agy(Antigravity)에 대해**: Council에는 프롬프트를 받아 답을 출력하고 종료하는 **헤드리스 모드**가 필요합니다. agy가 그런 모드를 지원하지 않으면 같은 Gemini 모델을 쓰는 `gemini` CLI를 쓰세요 (기본값).

## 결과물 위치

```
<project>/.council/runs/<id>/
  transcript.md   전체 대화록 (에이전트들도 이 파일을 참고)
  PLAN.md         확정된 계획 (개발 모드)
  FINAL.md        최종 보고서
  summary.md      누적 요약
  turns/          매 턴 실제로 보낸 프롬프트와 원본 응답 (디버깅용)
```
`.council/`은 git에서 자동 제외됩니다. 개발 모드의 체크포인트는 `council R3: Codex` 같은 커밋으로 남으니 `git reset --hard <sha>`로 언제든 되돌릴 수 있습니다.

## ⚠️ 주의

- 워커는 **권한 확인 없이** 파일을 수정하고 명령을 실행합니다 (`--full-auto`, `bypassPermissions`, `--yolo`). 반드시 git으로 관리되는 폴더에서, 가능하면 별도 브랜치에서 돌리세요.
- 첫 체크포인트 커밋은 그 시점의 커밋 안 된 변경까지 포함합니다 (세션 브랜치로 함께 옮겨감). 시작 전에 커밋해 두세요.
- 서버는 `127.0.0.1`에만 바인딩되고, 다른 웹사이트가 로컬 에이전트를 조작하지 못하도록 POST에 커스텀 헤더를 요구합니다.
- CLI 플래그는 버전마다 바뀔 수 있습니다. 에이전트가 계속 실패하면(3회 연속 실패 시 자동 제외) `turns/*.reply.md`의 stderr를 보고 `args`를 조정하세요.
