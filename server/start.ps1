# Ark Web Bridge 启动器
#
# 为什么需要这个文件：
#   计划任务若直接把 node.exe 作为动作，Windows 会在交互会话里创建**可见控制台窗口**，
#   每次重启都会在用户屏幕上弹一个黑框（打游戏时会直接打断）。
#   把动作改成 `powershell -WindowStyle Hidden -File start.ps1` 后，控制台自创建起就是隐藏的。
#   这里用 `& node`（同进程树）而不是 Start-Process，保证「停止任务」能连带杀掉 node，
#   不会留下孤儿进程占住 9333 端口。

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
$js = Join-Path $here 'bridge-server.js'

Set-Location $root
& $node $js
