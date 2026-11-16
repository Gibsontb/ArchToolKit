@echo off
setlocal EnableDelayedExpansion
title ArchToolKit
cd /d "%~dp0"

rem Restore the Windows utilities this launcher uses when PATH omits System32.
set "PATH=%SystemRoot%\System32;%PATH%"

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

call :findnode
if not errorlevel 1 goto checknode

echo.
echo   Node.js was not found. Installing Node.js LTS with WinGet...
set "PATH=%PATH%;%LOCALAPPDATA%\Microsoft\WindowsApps"
where winget.exe >nul 2>&1
if errorlevel 1 (
  set "WHY=WinGet is unavailable. Node.js could not be installed automatically."
  goto nonode
)

winget.exe install --id OpenJS.NodeJS.LTS --exact --source winget --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
call :findnode
if errorlevel 1 (
  set "WHY=Node.js is still unavailable after the WinGet installation attempt."
  goto nonode
)

:checknode
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
echo   Serving the prebuilt pages with PowerShell instead.
echo.
set "PSEXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PSEXE%" (
  set "PSEXE="
  for /f "delims=" %%p in ('where pwsh.exe 2^>nul') do if not defined PSEXE set "PSEXE=%%p"
)
if not defined PSEXE (
  echo   ERROR: Windows PowerShell is unavailable and PowerShell 7 was not found on PATH.
  echo   Serving the prebuilt pages requires PowerShell or Node.js 22.6 or newer.
  echo.
  pause
  exit /b 1
)

set "PSARGS=-Port %FIRSTPORT%"
if "%OPEN%"=="0" set "PSARGS=!PSARGS! -NoOpen"
"%PSEXE%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\serve.ps1" !PSARGS!
set "PSSTATUS=%ERRORLEVEL%"
if not "%PSSTATUS%"=="0" (
  echo.
  echo   The PowerShell server exited with code %PSSTATUS%. See the output above.
  echo.
  pause
)
exit /b %PSSTATUS%

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
exit /b

:findnode
where node >nul 2>&1
if not errorlevel 1 exit /b 0

rem WinGet's MSI can update the machine PATH without updating this process.
for %%d in ("%ProgramW6432%\nodejs" "%ProgramFiles%\nodejs" "%ProgramFiles(x86)%\nodejs") do (
  if exist "%%~d\node.exe" (
    set "PATH=%%~d;!PATH!"
    exit /b 0
  )
)
exit /b 1
