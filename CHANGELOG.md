# Changelog

형식: [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/) · 버전: [SemVer](https://semver.org/lang/ko/)

## [Unreleased]
### Changed
- Gemini를 새 Gemini CLI `agy`로 호출(기존 `gemini` 명령 대신). 로그인은 `agy`, 모델 목록은 `agy models`에서 Gemini 모델만 자동으로 불러오고 생각 깊이(낮음·보통·높음)를 고를 수 있음
### Fixed
- agy가 답을 낸 뒤 종료하지 않고 멈추는 경우, 5초 뒤 강제 종료하고 받은 답으로 진행(턴이 시간 제한까지 묶이던 문제)
- 빈 응답 턴도 stderr를 turns/*.reply.md에 남김
- agy 읽기 턴에 "셸 명령은 막혀 있으니 파일 보기·검색 도구만 쓸 것" 안내를 덧붙여, 명령이 거부되며 빈 응답이 나던 문제를 줄임

## [0.5.0] - 2026-10-19
### Added
- 🤖 자동 모드(기본): 화두만 던지면 토론 → 합의 후 모더레이터가 구현 필요 여부(NEXT: BUILD/TALK) 판단 → 계획 → 구현
- 사람에게 되묻는 질문(ASK OWNER): 질문 카드 + [답하기], 데스크탑 알림, 답을 기다리지 않고 가정으로 계속 진행
- 모델·생각 깊이(effort) 목록 선택: Claude(--effort), Codex(설치된 CLI에서 모델 목록과 모델별 effort 자동 수집), Gemini, DeepSeek
- 평가 기준: 쓸모(실제 사용자 문제), 디자인 품질, 한 모델 취향 쏠림 점검. 계획서에 "사용자와 문제", "디자인 원칙" 섹션 추가
- 고급 모델 투입: 모더레이터의 ASSIGN 또는 테스트 2연속 실패 시 Claude→Codex→Gemini 순으로 한 라운드 대신 구현
- 계획서에서 테스트 명령 자동 인식
### Changed
- 구현 전담 모델(DeepSeek)은 리뷰에서도 제외(구현만 담당)
- 메시지 본문에서 VOTE/NEXT/ASK OWNER 줄을 숨기고 배지·카드로 표시

## [0.4.0] - 2026-10-19
### Added
- 원클릭 설치 스크립트 `council-setup.sh` (Ubuntu): Node·git·AI CLI 3종·앱 설치, GitHub 업로드(선택), 앱 실행
- 앱 안에서 바로 고치기: CLI 미설치 시 [설치], 로그인 필요 시 [로그인], 키 없을 때 [키 설정] 버튼 (터미널 창을 열어 처리)
- Ubuntu용 .deb / AppImage 패키지, 프로그램 메뉴 등록
### Changed
- 페르소나 기본값과 투표 표시(동의/계속)를 한국어로

## [0.3.0] - 2026-10-19
### Added
- 역할 구성: Claude 모더레이터 · Codex/Gemini 토론·리뷰 · DeepSeek 전담 구현(계획 토론에는 불참). DeepSeek 장애 시 Codex가 대신 구현
- 세션 시작 시 실제 호출 점검(preflight)
- 실패 분류(한도/네트워크/인증/인자/미설치/시간초과)와 대응: 한도는 쉬었다 자동 복귀하고 역할 대행, 네트워크는 재시도, 고장 난 에이전트는 제외 후 역할 승계
- 재시작·크래시 복구(원자적 상태 저장 + jsonl 대화록), "이어서 진행"
- 프로젝트별 동시 세션, 세션 기록 사이드바, 체크포인트 되돌리기, 브랜치 이탈 감지
- API 키 저장(`~/.council/secrets.json`, 0600, 쓰기 전용 UI), 앱 내 설정 편집기(검증 + .bak), 에이전트별 모델 선택
- 데스크탑 알림, 단일 인스턴스, 자동 업데이트(electron-updater), 파일 로그
- e2e 시나리오 14개
### Fixed
- 최신 Codex CLI에서 제거된 `--full-auto` 대신 `--sandbox workspace-write` 사용
- Gemini 헤드리스 실행에 `--skip-trust`와 읽기 전용 `--approval-mode plan` 적용

## [0.2.0] - 2026-10-19
### Added
- 앱 아이콘(svg/png/ico)
- GitHub 연동: 이슈 → 미션, 세션 전용 브랜치, 자동 PR, 토론 결과 이슈 코멘트
- Windows(NSIS·portable)/macOS/Linux 패키징, CI(Win/Mac/Linux), 태그 기반 릴리스

## [0.1.0] - 2026-10-19
### Added
- 토론/개발 모드, 모더레이터·워커·리뷰어 역할, 블라인드 오프닝, 무자비 모드, 무제한 라운드
- git 체크포인트, 테스트 자동 실행, 누적 요약, 중재자 끼어들기
- 웹 UI + Electron 래퍼, 가짜 에이전트 모드
