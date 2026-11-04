#!/usr/bin/env bash
# 启动 muse2api（供 1Panel「进程守护」调用，也可手动执行）
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi

# .env 只维护一份密钥/对外地址，这里同步给 muse2api 认识的环境变量
export MUSE2API_KEY="${MUSE_API_KEY:-}"
export MUSE2API_PUBLIC_BASE="${MUSE_API_BASE:-}"
export MUSE2API_HOST="${MUSE2API_HOST:-0.0.0.0}"
export MUSE2API_PORT="${MUSE2API_PORT:-1314}"

cd "$ROOT/muse2api"
exec "$ROOT/.venv/bin/python" -m uvicorn app:app \
  --host "$MUSE2API_HOST" \
  --port "$MUSE2API_PORT" \
  --proxy-headers \
  --forwarded-allow-ips='*'
