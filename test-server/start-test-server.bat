@echo off
setlocal
cd /d "%~dp0"

rem Downloads or updates Paper and GrimAC, then starts the test server in this window.
rem Another Minecraft version: start-test-server.bat -McVersion 1.21.4
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
if errorlevel 1 (
  echo [ERROR] The test stand is not ready. Read the messages above.
  pause
  exit /b 1
)

cd /d "%~dp0server"
echo.
echo Test server: 127.0.0.1:25565, offline mode. In the panel set the server address to localhost.
echo GrimAC alerts appear in this window and in test-server\server\logs\latest.log.
echo Type "stop" and press Enter to shut the server down.
echo.
java -Xms1G -Xmx2G -jar paper.jar --nogui
pause
