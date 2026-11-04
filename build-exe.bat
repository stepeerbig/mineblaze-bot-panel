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
echo [1/3] Installing dependencies. The first run can take a few minutes...
call npm install --no-audit --no-fund
if errorlevel 1 (
  if exist node_modules\electron-builder\package.json (
    echo [WARN] npm install failed, building with the packages that are already installed.
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

echo [2/3] Running tests...
call npm test
if errorlevel 1 (
  echo [ERROR] Tests failed, the exe was NOT built. Scroll up to see which test failed.
  pause
  exit /b 1
)

echo [3/3] Building exe...
call npm run dist
if errorlevel 1 (
  echo [ERROR] Build failed. Scroll up and read the first error message.
  echo If it says EBUSY or "file is being used", close MineBlaze Bot Panel and run this file again.
  pause
  exit /b 1
)

echo.
echo DONE. Your file: dist\MineBlazeBotPanel.exe
explorer dist
pause
