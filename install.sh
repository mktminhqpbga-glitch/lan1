#!/usr/bin/env bash
# Muse + 无限画布 + 服务端 Agent 一键安装（Debian / Ubuntu，1Panel 主机）
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$APP_DIR/agent"
AGENT_CONFIG="$AGENT_DIR/.infinite-canvas/canvas-agent.json"
API_PORT="${API_PORT:-1314}"
CANVAS_PORT="${CANVAS_PORT:-521}"
AGENT_PUBLIC_URL="${AGENT_PUBLIC_URL:-https://agent.example.com}"
AGENT_ORIGINS="${AGENT_ORIGINS:-https://muse.example.com https://canvas.example.com}"
cd "$APP_DIR"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

if [ "$(id -u)" -ne 0 ]; then
  die "请用 root 运行：sudo -E bash install.sh"
fi

say "1/7 安装系统依赖（Python、Chromium、Node.js、字体）"
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y || warn "apt-get update 失败，继续尝试安装"
  apt-get install -y python3 python3-venv python3-pip ca-certificates curl openssl git ripgrep bubblewrap fonts-wqy-zenhei || true
  apt-get install -y chromium || apt-get install -y chromium-browser || \
    warn "Chromium 自动安装失败，请手动安装：Debian 用 apt install chromium，Ubuntu 可用 snap install chromium"
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y python3 python3-pip python3-virtualenv nodejs npm openssl git ripgrep bubblewrap chromium google-noto-sans-cjk-fonts || true
elif command -v yum >/dev/null 2>&1; then
  yum install -y python3 python3-pip nodejs npm openssl git ripgrep bubblewrap chromium google-noto-sans-cjk-fonts || true
else
  warn "未识别包管理器，请自行确保 python3 / venv / chromium / node / npm 已安装"
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1 || [ "$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)" -lt 18 ]; then
  say "安装 Node.js 20（Agent 需要 Node 18+ 和 npm）"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v
npm -v

CHROME_BIN="$(command -v chromium || command -v chromium-browser || command -v google-chrome || command -v google-chrome-stable || true)"
if [ -n "$CHROME_BIN" ]; then
  say "Chromium: $CHROME_BIN"
else
  warn "未找到 Chromium。muse2api 无法启动浏览器，请安装后在 .env 里设置 MUSE2API_CHROMIUM"
fi

say "2/7 创建 Python 虚拟环境并安装 Muse API 依赖"
PY_VER="$(python3 -c 'import sys;print("%d.%d" % sys.version_info[:2])' 2>/dev/null || echo "0.0")"
case "$PY_VER" in
  3.10|3.11|3.12|3.13|3.14) ;;
  *) die "当前 Python $PY_VER，muse2api 需要 Python 3.10+（推荐 Ubuntu 22.04+ / Debian 12+）" ;;
esac
if [ ! -x "$APP_DIR/.venv/bin/python" ]; then
  python3 -m venv "$APP_DIR/.venv"
fi
"$APP_DIR/.venv/bin/python" -m pip install --disable-pip-version-check -q -r "$APP_DIR/muse2api/requirements.txt"

say "3/7 生成本地配置 .env"
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [ -z "${IP:-}" ]; then
  IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
fi
IP="${PUBLIC_HOST:-${IP:-127.0.0.1}}"

if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  KEY="$(openssl rand -hex 24 2>/dev/null || "$APP_DIR/.venv/bin/python" -c 'import secrets;print(secrets.token_hex(24))')"
  sed -i "s|^MUSE_API_KEY=.*|MUSE_API_KEY=$KEY|" "$APP_DIR/.env"
  sed -i "s|^MUSE_API_BASE=.*|MUSE_API_BASE=http://$IP:$API_PORT|" "$APP_DIR/.env"
  sed -i "s|^MUSE2API_PORT=.*|MUSE2API_PORT=$API_PORT|" "$APP_DIR/.env"
  sed -i "s|^CANVAS_PORT=.*|CANVAS_PORT=$CANVAS_PORT|" "$APP_DIR/.env"
  say "已生成 .env（API Key 已随机化）"
else
  warn ".env 已存在，保留原配置未覆盖"
fi
chmod 600 "$APP_DIR/.env"

# Agent 的地址和 Token 只认 canvas-agent.json；清掉旧版本写在 .env 里的副本，避免双份配置冲突。
sed -i '/^AGENT_URL=/d;/^AGENT_TOKEN=/d' "$APP_DIR/.env"

if ! grep -qE '^DEEPSEEK_API_KEY=sk-[^[:space:]]+' "$APP_DIR/.env"; then
  DS_KEY="${DEEPSEEK_API_KEY:-}"
  if [ -z "$DS_KEY" ] && [ -t 0 ]; then
    printf '请输入 DeepSeek API Key（sk- 开头，输入时不显示）：'
    read -r -s DS_KEY
    printf '\n'
  fi
  if [ -n "$DS_KEY" ]; then
    sed -i '/^DEEPSEEK_API_KEY=/d' "$APP_DIR/.env"
    printf 'DEEPSEEK_API_KEY=%s\n' "$DS_KEY" >> "$APP_DIR/.env"
  else
    die "未配置 DEEPSEEK_API_KEY。请重新运行：DEEPSEEK_API_KEY=sk-... sudo -E bash install.sh"
  fi
fi

say "4/7 安装服务端 Agent（canvas-agent + Codex）"
mkdir -p "$AGENT_DIR" "$AGENT_DIR/logs" "$AGENT_DIR/tmp" "$AGENT_DIR/.infinite-canvas"
cd "$AGENT_DIR"
npm_config_cache="$AGENT_DIR/.npm" npm install --prefix "$AGENT_DIR" --omit=dev --ignore-scripts --legacy-peer-deps --no-audit --no-fund
mkdir -p "$AGENT_DIR/.codex" "$AGENT_DIR/.config" "$AGENT_DIR/.cache" "$AGENT_DIR/workspace"
cp "$AGENT_DIR/codex/models.json" "$AGENT_DIR/.codex/models.json"
sed "s|^model_catalog_json = .*|model_catalog_json = \"$AGENT_DIR/.codex/models.json\"|" \
  "$AGENT_DIR/codex/config.toml" > "$AGENT_DIR/.codex/config.toml"
chmod 600 "$AGENT_DIR/.codex/models.json" "$AGENT_DIR/.codex/config.toml"

# 把旧版本写在 /root/.infinite-canvas 下的 Agent 运行数据搬进 /Muse。
if [ -d /root/.infinite-canvas ]; then
  if [ ! -d "$AGENT_DIR/.infinite-canvas" ] || [ -z "$(ls -A "$AGENT_DIR/.infinite-canvas" 2>/dev/null || true)" ]; then
    rm -rf "$AGENT_DIR/.infinite-canvas"
    mv /root/.infinite-canvas "$AGENT_DIR/.infinite-canvas"
    say "已把 /root/.infinite-canvas 迁移到 $AGENT_DIR/.infinite-canvas"
  else
    BACKUP="$AGENT_DIR/.infinite-canvas/root-backup-$(date +%s)"
    mv /root/.infinite-canvas "$BACKUP"
    say "已把 /root/.infinite-canvas 备份到 $BACKUP"
  fi
fi

say "5/7 生成 Agent 配置（地址和 Token 的唯一来源）"
node - "$AGENT_CONFIG" "$AGENT_PUBLIC_URL" "$AGENT_DIR/workspace" "$AGENT_ORIGINS" <<'NODE'
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const [file, publicUrl, workspace, originsRaw] = process.argv.slice(2);
let config = {};
if (fs.existsSync(file)) {
  try { config = JSON.parse(fs.readFileSync(file, "utf8")); } catch { config = {}; }
}
if (!config.token) config.token = crypto.randomBytes(18).toString("hex");
if (!config.url) config.url = "http://127.0.0.1:17371";
if (!config.publicUrl) config.publicUrl = publicUrl;
const origins = originsRaw.split(/\s+/).filter(Boolean);
config.origins = Array.from(new Set([...(Array.isArray(config.origins) ? config.origins : []), ...origins]));
const oldWorkspace = config.workspace && config.workspace.workspacePath;
if (!oldWorkspace || String(oldWorkspace).startsWith("/root/")) {
  config.workspace = { ...(config.workspace || {}), workspacePath: workspace };
}
fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
fs.chmodSync(path.dirname(file), 0o700);
fs.chmodSync(file, 0o600);
NODE

say "6/7 检查构建产物"
if [ ! -f "$APP_DIR/canvas/dist/index.html" ]; then
  die "缺少 canvas/dist/index.html：请把前端构建产物放到该目录"
fi

say "7/7 设置权限"
chmod +x "$APP_DIR/start-api.sh" "$APP_DIR/start-canvas.sh" "$AGENT_DIR/start-agent.sh" "$APP_DIR/install.sh" 2>/dev/null || true
chmod 700 "$AGENT_DIR/.infinite-canvas" "$AGENT_DIR/.codex" 2>/dev/null || true
mkdir -p "$APP_DIR/logs"
chmod 700 "$APP_DIR/logs" 2>/dev/null || true

KEY_LINE="$(grep -E '^MUSE_API_KEY=' "$APP_DIR/.env" | cut -d= -f2- || true)"
TOKEN="$(node -e 'console.log(require(process.argv[1]).token)' "$AGENT_CONFIG")"
AGENT_URL="$(node -e 'console.log(require(process.argv[1]).publicUrl || require(process.argv[1]).url)' "$AGENT_CONFIG")"

cat <<EOF

============================================================
安装完成
------------------------------------------------------------
目录：        $APP_DIR
Muse API：    http://$IP:$API_PORT
画布：        http://$IP:$CANVAS_PORT
Agent 本机：  http://127.0.0.1:17371
Agent 公网：  $AGENT_URL
Agent 配置：  $AGENT_CONFIG
Agent Token： $TOKEN

下一步（1Panel 工具箱 -> 进程守护，运行用户 root，进程数 1）：
  muse2api     目录 $APP_DIR        命令 /bin/bash $APP_DIR/start-api.sh
  muse-canvas  目录 $APP_DIR        命令 /bin/bash $APP_DIR/start-canvas.sh
  muse-agent   目录 $AGENT_DIR      命令 /bin/bash $AGENT_DIR/start-agent.sh

放行防火墙/安全组：$CANVAS_PORT、$API_PORT
Muse 管理台：  http://$IP:$API_PORT/admin?key=$KEY_LINE

Agent 面板默认连接地址和 Token 只从
  $AGENT_CONFIG
读取；改地址改 publicUrl，换 Token 改 token，然后重启 muse-agent 和 muse-canvas。
============================================================
EOF
