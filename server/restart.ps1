# 重启 Ark Web Bridge —— 必须用这个脚本，不要用 Start-ScheduledTask
#
# 为什么：
#   计划任务的动作是「直接运行 node.exe」，且 LogonType=Interactive，
#   Start-ScheduledTask 会在当前会话创建一个**可见的控制台窗口**——
#   用户打游戏时会被直接打断。
#   本脚本改为：停任务 → 清残留 node → 以 -WindowStyle Hidden 重新拉起。
#
# 注意：改计划任务动作需要管理员权限（Set-ScheduledTask 会返回「拒绝访问」），
#      所以这里绕过任务，直接以隐藏方式起进程。开机时任务仍会按登录触发器启动
#      （那时用户正在登录，出现窗口不打扰）。

param([int]$WaitSec = 6)

$ErrorActionPreference = 'Stop'
$taskName = 'ArkWeb Bridge'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
$js = Join-Path $root 'server\bridge-server.js'

Write-Host '[1/4] 停止计划任务（若有）' -ForegroundColor Cyan
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Write-Host '[2/4] 清理残留 node 进程（精确匹配本项目 bridge-server.js）' -ForegroundColor Cyan
$escapedJs = [regex]::Escape($js)
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match $escapedJs } |
    ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Host "      停止 PID $($_.ProcessId)"
    }
Start-Sleep -Seconds 1

Write-Host '[3/4] 隐藏方式启动' -ForegroundColor Cyan
$p = Start-Process -FilePath $node -ArgumentList "`"$js`"" -WorkingDirectory $root -WindowStyle Hidden -PassThru
Write-Host "      PID $($p.Id)"

Write-Host '[4/4] 等待健康检查' -ForegroundColor Cyan
Start-Sleep -Seconds $WaitSec
try {
    $h = (Invoke-WebRequest 'http://127.0.0.1:9333/health' -UseBasicParsing -TimeoutSec 6).Content
    Write-Host "      $h" -ForegroundColor Green
    exit 0
} catch {
    Write-Host "      健康检查失败：$($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
