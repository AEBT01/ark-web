@echo off
REM ============================================================
REM  Ark Web 服务 —— 隐藏窗口启动（供启动文件夹/手动调用）
REM  node 路径与仓库位置在此处固化，避免依赖 PATH 与工作目录。
REM  由 scripts/install-autostart.js 生成，可安全重复生成。
REM ============================================================
setlocal
set "NODE_EXE=__NODE_EXE__"
set "SERVER_DIR=__SERVER_DIR__"
set "LOG_DIR=%USERPROFILE%\.ark-web"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
start "" /b "%NODE_EXE%" "%SERVER_DIR%\bridge-server.js" >> "%LOG_DIR%\server.log" 2>&1
endlocal
