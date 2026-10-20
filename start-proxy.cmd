@echo off
setlocal
cd /d "%~dp0"

echo Starting Qoder Proxy...
echo   Project: %CD%
echo.

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found on PATH.
  echo Install Node.js or run this from a shell where npm is available.
  echo.
  pause
  exit /b 1
)

netstat -ano | findstr /R /C:":1300 .*LISTENING" >nul 2>nul
if not errorlevel 1 goto :port_busy
goto :port_ok
:port_busy
echo [WARN] Port 1300 is already in use.
echo The proxy may already be running. Close the existing window first.
echo.
pause
exit /b 0
:port_ok

if exist ".env" goto :env_ok
echo [WARN] .env file not found.
echo Run: Copy-Item .env.example .env
echo.
:env_ok

echo Qoder accounts (with encrypted PATs) are managed in the admin console:
echo   http://127.0.0.1:1300/ui/accounts
echo.

echo Proxy will listen on:
echo   http://127.0.0.1:1300
echo Keep this service local. Do not bind to 0.0.0.0 or expose it publicly.
echo.
echo Endpoints:
echo   GET  http://127.0.0.1:1300/health
echo   GET  http://127.0.0.1:1300/v1/models
echo   POST http://127.0.0.1:1300/v1/chat/completions
echo   POST http://127.0.0.1:1300/v1/messages
echo.

npm.cmd start
set EXIT_CODE=%ERRORLEVEL%

echo.
echo Proxy exited with code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%
