# Minimize the BrowserOS window without bringing it to the foreground.
# Pure ASCII on purpose: Windows PowerShell 5.1 parses BOM-less .ps1 with the
# system ANSI code page (GBK on this machine), so non-ASCII literals would break.
# Uses ShowWindow(SW_MINIMIZE=6) which does NOT activate the window.
param([string]$Match = 'BrowserOS')

Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Auto)]
public static extern int GetWindowText(System.IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
'@

$found = 0
$minimized = 0
foreach ($p in Get-Process) {
  if ($p.MainWindowHandle -eq 0) { continue }
  try {
    $sb = New-Object System.Text.StringBuilder 512
    [void][W.U]::GetWindowText($p.MainWindowHandle, $sb, 512)
    $title = $sb.ToString()
  } catch { continue }
  if ($title -like "*$Match*") {
    $found = $found + 1
    [void][W.U]::ShowWindow($p.MainWindowHandle, 6)   # SW_MINIMIZE: no activation
    $minimized = $minimized + 1
    Write-Output ("minimized pid=" + $p.Id + " title=" + $title)
  }
}
if ($found -eq 0) { Write-Output "no window matching '$Match'" }
exit 0
