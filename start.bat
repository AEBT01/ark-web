@echo off
echo ========================================
echo   Ark Web - 启动脚本
echo ========================================
echo.

echo [1/3] 安装服务器依赖...
cd /d "%~dp0server"
call npm install
if %errorlevel% neq 0 (
    echo 依赖安装失败！
    pause
    exit /b 1
)

echo.
echo [2/3] 启动 Bridge Server...
echo 服务器将运行在: http://localhost:9333
echo WebSocket 将运行在: ws://localhost:9334
echo.
echo [3/3] 请确保:
echo   1. 已在 Chrome 中安装 extension 目录的插件 (chrome://extensions 重新加载)
echo   2. Chrome 浏览器已打开, 点击插件图标
echo   3. 点击插件弹窗中的「启用调试」按钮 (Chrome 136+ 必需, 开启真实控制能力)
echo.
echo ========================================
echo   按 Ctrl+C 停止服务器
echo ========================================
echo.

node bridge-server.js
