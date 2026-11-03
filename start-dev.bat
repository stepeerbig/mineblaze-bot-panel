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

call npm start
