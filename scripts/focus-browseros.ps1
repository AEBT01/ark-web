# focus-browseros.ps1 - bring the BrowserOS window to the foreground
#
# Why: when the BrowserOS window is minimized or behind other windows, Chromium
# throttles rendering and every tab reports a 0x0 viewport. In that state
# getBoundingClientRect() returns document-layout coordinates instead of
# viewport coordinates, so real-mouse clicks land on the wrong element.
# Run this before any UI-level verification.
#
# Note: kept pure ASCII on purpose - PowerShell 5.1 parses BOM-less .ps1 files
# using the system ANSI code page (GBK on this machine), which mangles CJK text.

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinFocus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
"@

$procs = Get-Process -Name chrome -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -like "*BrowserClaw*" -and $_.MainWindowHandle -ne 0 }

if (-not $procs) {
  Write-Output "BrowserOS window not found (is it running?)"
  exit 1
}

foreach ($p in $procs) {
  if ([WinFocus]::IsIconic($p.MainWindowHandle)) {
    [WinFocus]::ShowWindow($p.MainWindowHandle, 9) | Out-Null   # SW_RESTORE
  }
  [WinFocus]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
  Write-Output ("focused: PID " + $p.Id + "  " + $p.MainWindowTitle)
}
