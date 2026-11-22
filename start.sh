#!/bin/sh
# 单容器内起两个进程：
#   1. NeteaseCloudMusicApi  —— 内部 3377，只给 bridge 自己调，不对外
#   2. health.js             —— 监听平台注入的 $PORT，响应健康检查（免费平台要求必须绑端口）
#   3. bridge.js             —— 主动外连小智 MCP 接入点，成为容器主进程
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
API_PORT="${API_PORT:-3377}"
PUBLIC_PORT="${PORT:-10000}"

echo "[boot] 网易云 API -> 127.0.0.1:${API_PORT}"
cd "${APP_DIR}/node_modules/NeteaseCloudMusicApi"
PORT="${API_PORT}" node app.js &
API_PID=$!

# 等 API 就绪，最多 30 秒；没起来也继续，bridge 会自己重试
i=0
while [ "$i" -lt 60 ]; do
  if node -e "require('http').get('http://127.0.0.1:${API_PORT}/',function(r){process.exit(0)}).on('error',function(){process.exit(1)})" 2>/dev/null; then
    echo "[boot] API 就绪"
    break
  fi
  i=$((i + 1))
  sleep 0.5
done

if [ "$i" -ge 60 ]; then
  echo "[boot] 警告：API 30 秒内未就绪，继续启动 bridge"
fi

cd "${APP_DIR}"
echo "[boot] 健康检查端口 ${PUBLIC_PORT}"
node health.js &

echo "[boot] 启动 MCP bridge（播放模式 ${NCM_STREAM_MODE:-direct}）"
exec node bridge.js
