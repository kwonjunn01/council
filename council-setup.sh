#!/usr/bin/env bash
# Council 원클릭 설치 (Ubuntu/Debian)
#   bash council-setup.sh
# Node.js · git · Claude/Codex/Gemini CLI · Council 앱을 설치하고 앱을 엽니다.
# 같은 폴더에 Council-*.deb 가 있으면 그것을, 없으면 GitHub Releases의 최신 .deb를 씁니다.
# 같은 폴더에 council-*.bundle 이 있으면 GitHub 저장소에 올릴지 물어봅니다.
set -euo pipefail

REPO="kwonjunn01/council"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
say()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

say "1/5 기본 도구 (curl, git)"
need=()
for p in curl git ca-certificates; do dpkg -s "$p" >/dev/null 2>&1 || need+=("$p"); done
if [ ${#need[@]} -gt 0 ]; then $SUDO apt-get update -qq && $SUDO apt-get install -y -qq "${need[@]}"; fi
ok "준비됨"

say "2/5 Node.js"
node_major() { node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || echo 0; }
if ! command -v node >/dev/null || [ "$(node_major)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash -
  $SUDO apt-get install -y -qq nodejs
fi
ok "Node $(node -v)"

say "3/5 AI CLI (Claude Code · Codex · Gemini/agy)"
NPM_SUDO=""
[ -w "$(npm prefix -g)/lib" ] || NPM_SUDO="$SUDO"
for pkg in @anthropic-ai/claude-code @openai/codex; do
  if npm ls -g --depth=0 "$pkg" >/dev/null 2>&1; then ok "$pkg 이미 설치됨"
  else $NPM_SUDO npm install -g --no-fund --no-audit "$pkg" >/dev/null && ok "$pkg 설치"; fi
done
# The Gemini CLI (agy) is not an npm package.
if command -v agy >/dev/null; then ok "agy $(agy --version 2>/dev/null) 이미 설치됨"
else echo "  ⚠ Gemini CLI(agy)가 없습니다. 따로 설치한 뒤 터미널에서 agy 를 한 번 실행해 로그인하세요."; fi

say "4/5 Council 앱"
DEB="$(ls -t "$HERE"/Council*.deb "$HERE"/council*.deb 2>/dev/null | head -1 || true)"
if [ -z "$DEB" ]; then
  url="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null | grep -oE '"browser_download_url": *"[^"]+amd64\.deb"' | head -1 | sed -E 's/.*"(https[^"]+)"/\1/' || true)"
  if [ -n "$url" ]; then DEB="/tmp/$(basename "$url")"; curl -fL --progress-bar -o "$DEB" "$url"
  else echo "Council .deb 파일을 찾지 못했습니다. 이 스크립트와 같은 폴더에 Council-*.deb 를 두고 다시 실행하세요."; exit 1; fi
fi
$SUDO apt-get install -y -qq "$DEB" >/dev/null
ok "$(basename "$DEB") 설치"

say "5/5 GitHub 저장소 (선택)"
BUNDLE="$(ls -t "$HERE"/council-*.bundle 2>/dev/null | head -1 || true)"
if [ -n "$BUNDLE" ] && [ -t 0 ]; then
  read -r -p "  $(basename "$BUNDLE") 을(를) github.com/$REPO 에 올릴까요? [y/N] " yn
  if [[ "$yn" =~ ^[Yy] ]]; then
    command -v gh >/dev/null || $SUDO apt-get install -y -qq gh
    # Ubuntu 22.04 ships an old gh without -p / setup-git, so fall back step by step.
    gh auth status >/dev/null 2>&1 || gh auth login -h github.com -p https -w 2>/dev/null || gh auth login -h github.com -w
    gh auth setup-git >/dev/null 2>&1 || git config --global credential.helper '!gh auth git-credential'
    SRC="$HOME/council"
    [ -d "$SRC/.git" ] || git clone -q "$BUNDLE" "$SRC"
    git -C "$SRC" fetch -q "$BUNDLE" 'refs/heads/*:refs/remotes/bundle/*' 'refs/tags/*:refs/tags/*' || true
    git -C "$SRC" checkout -q main && git -C "$SRC" merge -q --ff-only bundle/main 2>/dev/null || true
    git -C "$SRC" remote set-url origin "https://github.com/$REPO.git"
    git -C "$SRC" push -u origin main --follow-tags && ok "올림 → https://github.com/$REPO (소스: $SRC)"
  else warn "건너뜀"; fi
else warn "건너뜀 (bundle 없음)"; fi

say "완료! Council을 엽니다"
echo "  앱에서: ⚙ → API 키에 DEEPSEEK_API_KEY 입력 → 각 에이전트 옆 [로그인] 버튼 → 🔌 실제 호출 점검 → 시작"
echo "  다음부터는 프로그램 목록에서 'Council'을 누르거나 터미널에서 council 을 입력하세요."
(nohup council >/dev/null 2>&1 &) || true
