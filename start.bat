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
rem Without Node (a locked-down work PC, an air-gapped jump box) the pages still
rem run: web\lib is committed prebuilt, and tools\serve.ps1 serves it with
rem Windows PowerShell. Only --dev, which rebuilds on change, needs Node.
where node >nul 2>&1
if errorlevel 1 (
  set "WHY=Node.js was not found on PATH."
  goto nonode
)

rem ---- Node new enough? ----------------------------------------------------
node -e "var v=process.versions.node.split('.').map(Number);process.exit((v[0]>22||(v[0]===22&&v[1]>=6))?0:1)"
if errorlevel 1 (
  for /f %%v in ('node -p "process.versions.node"') do set "FOUND=%%v"
  set "WHY=Node !FOUND! is too old to build; 22.6 or newer is needed."
  goto nonode
)
goto hasnode

:nonode
if "%MODE%"=="dev" (
  echo.
  echo   ERROR: !WHY!
  echo   --dev rebuilds on every change, which needs Node 22.6 or newer.
  echo   Without --dev, start.bat serves the prebuilt pages with PowerShell instead.
  echo.
  pause
  exit /b 1
)
echo.
echo   !WHY!
echo   Serving the prebuilt pages with PowerShell instead - nothing to install.
echo.
set "PSARGS=-Port %FIRSTPORT%"
if "%OPEN%"=="0" set "PSARGS=!PSARGS! -NoOpen"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\serve.ps1" !PSARGS!
if errorlevel 1 (
  echo.
  echo   The PowerShell server could not start. If a policy blocks scripts, run:
  echo     powershell -NoProfile -ExecutionPolicy Bypass -File tools\serve.ps1
  echo.
  pause
)
exit /b

:hasnode
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
