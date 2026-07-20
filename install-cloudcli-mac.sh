#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# CloudCLI(James 的 fork)一键安装 —— macOS
#
# 用法(在要安装的那台 Mac 上,打开「终端」粘贴运行;RELAY_TOKEN 由 James 给):
#   RELAY_TOKEN='xxxxx' bash <(curl -fsSL https://raw.githubusercontent.com/iamzhaozheng/claudecodeui/james-patches/install-cloudcli-mac.sh)
# 不带 RELAY_TOKEN 直接运行也行,脚本会让你粘贴。
#
# 做的事:装 Node/git → 拉 fork 源码 → build → 配 Claude 中转 → 开机自启+看门狗
#        → 加入 Tailscale(会让你点一次授权)→ 建你的登录账号。
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── 配置(共用 James 的 Claude 中转账号)───────────────────────────────────────
FORK_REPO="https://github.com/iamzhaozheng/claudecodeui.git"
FORK_BRANCH="james-patches"
INSTALL_DIR="$HOME/claudecodeui"
PORT="3001"
RELAY_URL="https://cc.hisrv.com:8443"
RELAY_TOKEN="${RELAY_TOKEN:-}"   # 不写死密钥;从环境变量传入,或下面提示粘贴
LABEL="com.cloudcli.server"
WD_LABEL="com.cloudcli.watchdog"

say() { printf "\n\033[1;36m▶ %s\033[0m\n" "$1"; }
die() { printf "\n\033[1;31m✗ %s\033[0m\n" "$1"; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "这个脚本只用于 macOS"

if [ -z "$RELAY_TOKEN" ]; then
  read -r -p "粘贴 Claude 中转 token(James 给你): " RELAY_TOKEN
fi
[ -n "$RELAY_TOKEN" ] || die "需要 Claude 中转 token 才能继续"

# ── 1. Homebrew ──────────────────────────────────────────────────────────────
if ! command -v brew >/dev/null 2>&1; then
  say "安装 Homebrew(会让你输一次 Mac 密码)..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
# 让 brew 进当前 shell 的 PATH(Apple Silicon 在 /opt/homebrew)
if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi
if [ -x /usr/local/bin/brew ]; then eval "$(/usr/local/bin/brew shellenv)"; fi

# ── 2. Node 22+ 和 git ───────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  say "安装 Node..."; brew install node
fi
command -v git >/dev/null 2>&1 || { say "安装 git..."; brew install git; }
NODE_BIN="$(command -v node)"
say "Node: $($NODE_BIN -v)  ($NODE_BIN)"

# ── 3. 拉源码 + 构建 ─────────────────────────────────────────────────────────
if [ -d "$INSTALL_DIR/.git" ]; then
  say "更新已有源码..."; git -C "$INSTALL_DIR" fetch origin && git -C "$INSTALL_DIR" checkout "$FORK_BRANCH" && git -C "$INSTALL_DIR" reset --hard "origin/$FORK_BRANCH"
else
  say "拉取源码到 $INSTALL_DIR ..."; git clone --branch "$FORK_BRANCH" --depth 1 "$FORK_REPO" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"
say "安装依赖(几分钟)..."; npm ci --no-audit --no-fund
say "构建..."; npm run build

# ── 4. Tailscale ─────────────────────────────────────────────────────────────
if [ ! -d "/Applications/Tailscale.app" ]; then
  say "安装 Tailscale(会让你输 Mac 密码)..."; brew install --cask tailscale-app
fi
TS="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
open -a Tailscale || true; sleep 3
if ! sudo "$TS" status >/dev/null 2>&1; then
  say "把这台 Mac 加入 Tailscale —— 会弹出/打印一个授权链接,请用【和 James 同一个账号】登录确认。"
  sudo "$TS" up --accept-dns=false || true
fi
TS_IP="$(sudo "$TS" ip -4 2>/dev/null | head -1 || echo '（未获取到，稍后 tailscale ip -4 查看）')"

# ── 5. 开机自启(launchd)+ 防睡眠 ────────────────────────────────────────────
say "配置开机自启..."
CLAUDE_BIN="$(command -v claude || echo /usr/local/bin/claude)"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$HOME/Library/LaunchAgents/$LABEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/caffeinate</string><string>-s</string>
    <string>$NODE_BIN</string>
    <string>$INSTALL_DIR/dist-server/server/cli.js</string>
    <string>--port</string><string>$PORT</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>CLAUDE_CLI_PATH</key><string>$CLAUDE_BIN</string>
    <key>HOME</key><string>$HOME</string>
    <key>ANTHROPIC_BASE_URL</key><string>$RELAY_URL</string>
    <key>ANTHROPIC_AUTH_TOKEN</key><string>$RELAY_TOKEN</string>
  </dict>
  <key>WorkingDirectory</key><string>$INSTALL_DIR</string>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/cloudcli.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/cloudcli.log</string>
</dict></plist>
PLIST
chmod 600 "$HOME/Library/LaunchAgents/$LABEL.plist"

cat > "$HOME/Library/LaunchAgents/$WD_LABEL.plist" <<WD
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$WD_LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string>
    <string>/usr/bin/curl -sf -m 6 http://127.0.0.1:$PORT/ >/dev/null 2>&1 || { /bin/launchctl load -w $HOME/Library/LaunchAgents/$LABEL.plist 2>/dev/null; /bin/launchctl kickstart -k gui/\$(/usr/bin/id -u)/$LABEL 2>/dev/null; }</string>
  </array>
  <key>RunAtLoad</key><true/><key>StartInterval</key><integer>120</integer>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/cloudcli-watchdog.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/cloudcli-watchdog.log</string>
</dict></plist>
WD

launchctl unload "$HOME/Library/LaunchAgents/$LABEL.plist" 2>/dev/null || true
launchctl load -w "$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl unload "$HOME/Library/LaunchAgents/$WD_LABEL.plist" 2>/dev/null || true
launchctl load -w "$HOME/Library/LaunchAgents/$WD_LABEL.plist"

say "等待服务启动..."
for i in $(seq 1 40); do curl -sf -m 3 "http://127.0.0.1:$PORT/" >/dev/null 2>&1 && break; sleep 1; done
curl -sf -m 3 "http://127.0.0.1:$PORT/" >/dev/null 2>&1 || die "服务没起来,看日志 ~/Library/Logs/cloudcli.log"

# ── 6. 建登录账号 ────────────────────────────────────────────────────────────
STATUS="$(curl -s "http://127.0.0.1:$PORT/api/auth/status" 2>/dev/null || echo '')"
if echo "$STATUS" | grep -q '"needsSetup":true'; then
  say "创建你的登录账号"
  # 非交互:GW_USER / GW_PASS 环境变量可预置(方便 Claude Code 一条命令跑完)
  GU="${GW_USER:-}"; GP="${GW_PASS:-}"
  [ -n "$GU" ] || read -r -p "  用户名(建议用 wife): " GU
  [ -n "$GP" ] || { read -r -s -p "  密码: " GP; echo; }
  curl -s -X POST "http://127.0.0.1:$PORT/api/auth/register" -H "Content-Type: application/json" \
    -d "{\"username\":\"$GU\",\"password\":\"$GP\"}" >/dev/null && echo "  ✓ 账号已创建($GU)"
else
  echo "  (已存在账号,跳过创建)"
fi

# ── 完成 ─────────────────────────────────────────────────────────────────────
cat <<DONE

────────────────────────────────────────────────
✅ 安装完成!

这台 Mac 的 Tailscale 内网 IP: $TS_IP
本机测试:  在浏览器打开  http://localhost:$PORT

把上面这个【Tailscale IP】发给 James,他会在网关里加一行,
之后你就能在手机/电脑上用统一网址 https://claude.hisrv.com:8444 登录了。

提示:出门在外要保持这台 Mac 开机、插电、盖子别完全合上(或跑
      sudo pmset -c disablesleep 1 让它插电永不睡)。
────────────────────────────────────────────────
DONE
