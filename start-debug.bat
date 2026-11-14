@echo off
setlocal
cd /d "%~dp0"
rem Panel with debug port 9222 + a window showing the panel console and errors, see tools/panel-debug.
rem Close the panel first if it is open: a second instance does not start and the port will not open.
set PORT=9222
set ELECTRON_RUN_AS_NODE=
if not exist tools\panel-debug\node_modules\playwright-core (
  echo Installing playwright-core...
  pushd tools\panel-debug
  call npm install --no-audit --no-fund
  popd
)
start "MineBlaze Bot Panel (debug %PORT%)" cmd /c npx electron . --remote-debugging-port=%PORT%
node tools\panel-debug\panel-debug.js %PORT%
pause
