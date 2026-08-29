#!/usr/bin/env bash
# Ark Web — macOS / Linux 启动脚本 (Windows 用 start.bat)
set -e
cd "$(dirname "$0")/server"

echo "[1/2] 安装服务器依赖..."
npm install

echo "[2/2] 启动 Bridge Server"
echo "  HTTP API : http://localhost:9333"
echo "  WebSocket: ws://localhost:9334"
echo ""
echo "  请确保:"
echo "    1. 已在 Chrome 中加载 extension/ 目录的插件 (chrome://extensions → 开发者模式 → 加载已解压)"
echo "    2. 点击插件图标 → 「启用调试」(Chrome 136+ 必须, 开启 CDP 真实控制)"
echo ""
echo "  验证: curl http://localhost:9333/status   → {\"connected\":true,...}"
echo "  按 Ctrl+C 停止服务器"
echo ""
node bridge-server.js
