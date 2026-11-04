@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node.js LTS from https://nodejs.org and run this file again.
  pause
  exit /b 1
)

rem npm install runs every time: it is quick when nothing changed and repairs a broken node_modules.
echo Checking dependencies...
call npm install --no-audit --no-fund
if errorlevel 1 (
  if exist node_modules\electron\package.json (
    echo [WARN] npm install failed, starting with the packages that are already installed.
  ) else (
    echo [ERROR] npm install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

rem Newer npm versions may skip install scripts, so Electron itself is never downloaded.
if not exist node_modules\electron\dist\electron.exe (
  echo Downloading Electron...
  call node node_modules\electron\install.js
  if not exist node_modules\electron\dist\electron.exe (
    echo [ERROR] Electron could not be downloaded. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

rem Set by some tools (for example VS Code): Electron would start as plain Node and the panel would not open.
set ELECTRON_RUN_AS_NODE=
call npm start
