#!/usr/bin/env bash
set -euo pipefail

AGENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$AGENT_DIR")"
ENV_FILE="$ROOT_DIR/.env"

if [[ ! -f "$ENV_FILE" ]]; then
    echo "缺少 $ENV_FILE，请先运行 $ROOT_DIR/install.sh" >&2
    exit 1
fi

# shellcheck disable=SC1090
set -a
. "$ENV_FILE"
set +a

# Agent 的所有运行数据都放在 /Muse/agent 下：
# 配置、Codex 状态、工作区、缓存、临时文件都不再写 /root。
export HOME="$AGENT_DIR"
export XDG_CONFIG_HOME="$AGENT_DIR/.config"
export XDG_CACHE_HOME="$AGENT_DIR/.cache"
export CODEX_HOME="$AGENT_DIR/.codex"
export npm_config_cache="$AGENT_DIR/.npm"
export TMPDIR="$AGENT_DIR/tmp"
mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$CODEX_HOME" "$npm_config_cache" "$TMPDIR"

if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
    echo "错误：$ENV_FILE 中没有 DEEPSEEK_API_KEY。" >&2
    echo "请执行：sudo -E bash $ROOT_DIR/install.sh，或手动写入该文件后重启 muse-agent。" >&2
    exit 1
fi
if [[ "$DEEPSEEK_API_KEY" != sk-* ]]; then
    echo "错误：DEEPSEEK_API_KEY 应以 sk- 开头，请检查 $ENV_FILE。" >&2
    exit 1
fi
export DEEPSEEK_API_KEY
export PORT="${PORT:-17371}"

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
[[ -n "$NODE_BIN" ]] || { echo "未找到 node，请重新运行 $ROOT_DIR/install.sh" >&2; exit 1; }

cd "$AGENT_DIR"
exec "$NODE_BIN" "$AGENT_DIR/node_modules/@basketikun/canvas-agent/dist/index.js"
