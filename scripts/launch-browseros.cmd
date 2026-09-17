@echo off
REM ============================================================
REM  Ark Web + BrowserOS Launcher
REM
REM  NOTE: this file must stay PURE ASCII. cmd.exe parses .cmd files
REM  with the system ANSI codepage (GBK on this machine), so Chinese
REM  comments become garbage commands and abort the script.
REM
REM  Flags used:
REM    --no-sandbox       Chromium sandbox is incompatible with this machine
REM                       (process gets killed at startup, exit code 3).
REM                       Acceptable for personal use on trusted sites.
REM    --load-extension   Load BOTH extensions, comma separated:
REM                         1) the bridge extension (control channel)
REM                         2) the Ark panel (the product UI itself)
REM                       Loading only one is a measured failure: modern Chromium
REM                       disables other unpacked extensions when started with
REM                       --load-extension, so the browser comes up without the
REM                       panel. Both are temporary loads -> always start the
REM                       browser through this script (reloading the extension
REM                       inside such a browser UNLOADS it instead).
REM
REM  Multi-browser routing is by connection label (extension popup) plus
REM  ?browser=<name> / X-Ark-Browser header on requests. Version numbers are
REM  no longer used to influence routing.
REM ============================================================

set "EXE=%LOCALAPPDATA%\BrowserClaw\Application\chrome.exe"
set "EXT=%USERPROFILE%\browser-debug-extension-bos\extension"
set "PANEL=%USERPROFILE%\ark-panel"

if not exist "%EXE%" (
  echo [ERROR] BrowserOS not found: %EXE%
  exit /b 1
)
if not exist "%EXT%\manifest.json" (
  echo [ERROR] bridge extension not found: %EXT%
  echo         run first: node scripts\sync.js --yes
  exit /b 1
)
if not exist "%PANEL%\manifest.json" (
  echo [ERROR] Ark panel not found: %PANEL%
  echo         run first: node scripts\sync-panel.js --yes
  exit /b 1
)

echo Starting BrowserOS with bridge extension + Ark panel ...
start "" "%EXE%" --no-sandbox --load-extension="%EXT%,%PANEL%" --no-first-run --no-default-browser-check %*

echo Done. Check the connection with:
echo   node "%USERPROFILE%\.agents\skills\ark-web\client\browser-client.js" status
