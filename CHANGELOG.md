# Changelog

형식: [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/) · 버전: [SemVer](https://semver.org/lang/ko/)

## [Unreleased]

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
