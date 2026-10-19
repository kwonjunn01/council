# 버전 관리 & 릴리스

- `main`은 항상 배포 가능한 상태로 유지합니다. 작업은 브랜치 → PR → CI(Win/Mac/Linux e2e) 통과 → 머지 순서입니다.
- 버전은 SemVer를 따릅니다: 호환이 깨지는 설정·동작 변경은 major, 기능 추가는 minor, 버그 수정은 patch.

## 릴리스 절차
1. `CHANGELOG.md`의 `[Unreleased]` 내용을 새 버전 섹션으로 옮깁니다.
2. 버전을 올리고 태그를 만듭니다: `npm version minor` (또는 `patch`/`major`). `package.json` 변경, 커밋, `vX.Y.Z` 태그가 한 번에 생깁니다.
3. `git push --follow-tags`
4. GitHub Actions `Release`가 Windows/macOS/Linux 설치 파일을 빌드해 GitHub Releases에 올립니다.
5. 설치된 앱은 다음 실행 때 새 버전을 감지해 자동 업데이트합니다 (Windows 설치형, Linux AppImage).
