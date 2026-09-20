@echo off
setlocal EnableDelayedExpansion
title ArchToolKit
cd /d "%~dp0"

set "MODE=serve"
set "OPEN=1"
set "FIRSTPORT=8080"

:parse
if "%~1"=="" goto parsed
if /i "%~1"=="--dev"     ( set "MODE=dev" & shift & goto parse )
if /i "%~1"=="--no-open" ( set "OPEN=0" & shift & goto parse )
if /i "%~1"=="--port"    ( set "FIRSTPORT=%~2" & shift & shift & goto parse )
if /i "%~1"=="--help"    ( goto usage )
echo Unknown option: %~1
:usage
echo.
echo   start.bat              Build once, then serve web/ and open a browser.
echo   start.bat --dev        Build, watch for changes, and serve.
echo   start.bat --port 3000  Start looking for a free port at 3000.
echo   start.bat --no-open    Do not launch a browser.
echo.
exit /b 1
:parsed

rem ---- Node present? -------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   ERROR: Node.js was not found on PATH.
  echo   ArchToolKit needs Node 22.6 or newer - it compiles TypeScript with
  echo   Node's built-in type stripper and has no npm dependencies at all.
  echo   Install from https://nodejs.org/ and reopen this window.
  echo.
  pause
  exit /b 1
)

rem ---- Node new enough? ----------------------------------------------------
node -e "var v=process.versions.node.split('.').map(Number);process.exit((v[0]>22||(v[0]===22&&v[1]>=6))?0:1)"
if errorlevel 1 (
  for /f %%v in ('node -p "process.versions.node"') do set "FOUND=%%v"
  echo.
  echo   ERROR: Node !FOUND! is too old. ArchToolKit needs 22.6 or newer
  echo   for the built-in TypeScript type stripper.
  echo.
  pause
  exit /b 1
)

rem ---- Find a free port ----------------------------------------------------
set /a "LASTPORT=FIRSTPORT+11"
set "PORT="
for /l %%p in (%FIRSTPORT%,1,%LASTPORT%) do (
  if not defined PORT (
    netstat -a -n -p tcp | findstr /c:":%%p " >nul
    if errorlevel 1 set "PORT=%%p"
  )
)
if not defined PORT (
  echo.
  echo   ERROR: no free port between %FIRSTPORT% and %LASTPORT%.
  echo   Pick another range:  start.bat --port 9000
  echo.
  pause
  exit /b 1
)

rem The experimental-type-stripper warning is expected noise, not a problem.
set "NODE_NO_WARNINGS=1"
set "URL=http://127.0.0.1:%PORT%/"

if "%MODE%"=="serve" (
  echo Building...
  node tools\build.mjs
  if errorlevel 1 (
    echo.
    echo   Build failed - see the errors above. The server was not started.
    echo.
    pause
    exit /b 1
  )
)

if "%OPEN%"=="1" start "" /b cmd /c "timeout /t 2 /nobreak >nul & start "" "%URL%""

echo.
echo   ArchToolKit is at %URL%
echo   Ctrl-C to stop.
echo.

if "%MODE%"=="dev" (
  node tools\dev.mjs --port %PORT% --tries 0
) else (
  node tools\serve.mjs --port %PORT% --tries 0
)

endlocal
