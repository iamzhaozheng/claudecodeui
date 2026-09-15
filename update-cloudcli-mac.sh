#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# CloudCLI(James 的 fork)更新到最新版 —— macOS
#
# 用法(在装了 CloudCLI 的那台 Mac 上运行):
#   bash <(curl -fsSL https://raw.githubusercontent.com/iamzhaozheng/claudecodeui/james-patches/update-cloudcli-mac.sh)
#
# 加 --auto-update 会顺便装上「每天自动更新」的后台任务:
#   bash <(curl -fsSL .../update-cloudcli-mac.sh) --auto-update
#
# 和安装脚本的区别:只更新代码并重建,不碰 Tailscale、不碰登录账号、不需要 token。
# 构建失败会自动退回原来的版本,服务继续用旧版跑着,不会把人晾在坏掉的状态。
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

FORK_BRANCH="james-patches"
PORT="3001"
LABEL="com.cloudcli.server"
UPDATE_LABEL="com.cloudcli.autoupdate"
WANT_AUTO_UPDATE="no"
[ "${1:-}" = "--auto-update" ] && WANT_AUTO_UPDATE="yes"

say() { printf "\n\033[1;36m▶ %s\033[0m\n" "$1"; }
ok()  { printf "\033[1;32m✓ %s\033[0m\n" "$1"; }
die() { printf "\n\033[1;31m✗ %s\033[0m\n" "$1"; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "这个脚本只用于 macOS"

# ── 找到装在哪 ───────────────────────────────────────────────────────────────
# 安装脚本用的是 ~/claudecodeui,但手工装的可能在别处,所以多找几个常见位置。
INSTALL_DIR=""
for d in "$HOME/claudecodeui" "$HOME/claude-workspace/claudecodeui" "$HOME/Documents/claudecodeui"; do
  if [ -d "$d/.git" ]; then INSTALL_DIR="$d"; break; fi
done
[ -n "$INSTALL_DIR" ] || die "找不到 CloudCLI 的安装目录(找过 ~/claudecodeui 等位置)"
cd "$INSTALL_DIR"
say "安装目录:$INSTALL_DIR"

# brew 装的 node 不一定在 launchd 的 PATH 里,这里先补上
if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi
if [ -x /usr/local/bin/brew ]; then eval "$(/usr/local/bin/brew shellenv)"; fi
command -v node >/dev/null 2>&1 || die "找不到 node"
command -v git  >/dev/null 2>&1 || die "找不到 git"

# ── 看看有没有新版本 ─────────────────────────────────────────────────────────
say "检查更新..."
git fetch --quiet origin "$FORK_BRANCH" || die "拉取远端失败(网络?)"

OLD_SHA="$(git rev-parse HEAD)"
NEW_SHA="$(git rev-parse "origin/$FORK_BRANCH")"

if [ "$OLD_SHA" = "$NEW_SHA" ]; then
  ok "已经是最新版($(git rev-parse --short HEAD)),不用更新。"
  [ "$WANT_AUTO_UPDATE" = "yes" ] || exit 0
fi

if [ "$OLD_SHA" != "$NEW_SHA" ]; then
  echo "  当前:$(git rev-parse --short "$OLD_SHA")  →  最新:$(git rev-parse --short "$NEW_SHA")"
  git --no-pager log --oneline "$OLD_SHA..$NEW_SHA" 2>/dev/null | head -10 || true

  # 本地如果有人手改过文件,先存起来,免得 reset 时丢掉
  if ! git diff --quiet || ! git diff --cached --quiet; then
    say "发现本地改动,先备份到 git stash"
    git stash push -u -m "auto-stash before update $(date +%Y%m%d-%H%M%S)" || true
  fi

  say "更新代码..."
  git checkout --quiet "$FORK_BRANCH" 2>/dev/null || git checkout --quiet -b "$FORK_BRANCH" "origin/$FORK_BRANCH"
  git reset --hard --quiet "origin/$FORK_BRANCH"

  # ── 构建;失败就退回旧版 ───────────────────────────────────────────────────
  # 这台机器平时没人盯着,所以宁可继续跑旧版,也不能停在构建了一半的状态。
  rollback() {
    printf "\n\033[1;31m✗ 构建失败,正在退回原来的版本...\033[0m\n"
    git reset --hard --quiet "$OLD_SHA"
    npm ci --no-audit --no-fund --silent >/dev/null 2>&1 || true
    npm run build >/dev/null 2>&1 || true
    launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null || true
    die "已退回旧版本($(git rev-parse --short HEAD)),服务仍在运行。请把上面的报错发给 James。"
  }

  say "安装依赖(几分钟,请耐心等)..."
  npm ci --no-audit --no-fund || rollback

  say "构建..."
  npm run build || rollback

  say "重启服务..."
  launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null || true

  say "等待服务起来..."
  UP="no"
  for _ in $(seq 1 40); do
    if curl -sf -m 3 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then UP="yes"; break; fi
    sleep 1
  done
  [ "$UP" = "yes" ] || rollback

  ok "更新完成:$(git rev-parse --short HEAD)"
fi

# ── 可选:每天自动更新 ───────────────────────────────────────────────────────
if [ "$WANT_AUTO_UPDATE" = "yes" ]; then
  say "设置每天自动更新..."
  SELF="$HOME/.cloudcli-update.sh"
  curl -fsSL "https://raw.githubusercontent.com/iamzhaozheng/claudecodeui/$FORK_BRANCH/update-cloudcli-mac.sh" -o "$SELF"
  chmod +x "$SELF"

  # 挑 04:17 这种不整点的时间:整点大家都在拉,而且这台机器夜里通常闲着
  cat > "$HOME/Library/LaunchAgents/$UPDATE_LABEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$UPDATE_LABEL</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>$SELF</string>
  </array>
  <key>StartCalendarInterval</key><dict>
    <key>Hour</key><integer>4</integer><key>Minute</key><integer>17</integer>
  </dict>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/cloudcli-update.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/cloudcli-update.log</string>
</dict></plist>
PLIST
  chmod 600 "$HOME/Library/LaunchAgents/$UPDATE_LABEL.plist"
  launchctl unload "$HOME/Library/LaunchAgents/$UPDATE_LABEL.plist" 2>/dev/null || true
  launchctl load -w "$HOME/Library/LaunchAgents/$UPDATE_LABEL.plist"
  ok "已设置:每天凌晨 4:17 自动检查更新(日志 ~/Library/Logs/cloudcli-update.log)"
fi

printf "\n\033[1;32m全部完成。打开 http://localhost:%s 确认能用。\033[0m\n" "$PORT"
