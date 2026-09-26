@echo off
setlocal EnableDelayedExpansion
title ArchToolKit - update network devices
cd /d "%~dp0"

rem Checks the network device blueprints against the latest vendor collections:
rem   1. Update Ansible and the network collections (Cisco, Juniper, Aruba,
rem      Arista, FMC, ASA, PAN-OS, FortiOS, F5) in WSL: ~/archtoolkit-ansible
rem   2. Every network blueprint, every choice: builds, option check against
rem      the modules, whole-device merge per platform, and
rem      ansible-playbook --syntax-check with the real collections      ~5 min
rem   3. Rebuild the pages and run the tests
rem   4. Commit and push, if anything changed and you say so
rem
rem Needs Node 22.6+, git, and WSL with Ubuntu (Ansible does not run on
rem Windows itself). Anything that fails stops the run before a commit.

set "NODE_NO_WARNINGS=1"
set "NODE=node --experimental-strip-types --no-warnings"
set "STARTED=%TIME%"
if not defined ARCHTOOLKIT_WSL_DISTRO set "ARCHTOOLKIT_WSL_DISTRO=Ubuntu-24.04"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   ERROR: Node.js was not found on PATH. Install 22.6 or newer from https://nodejs.org/
  goto :fail
)
where git >nul 2>&1
if errorlevel 1 (
  echo.
  echo   ERROR: git was not found on PATH. Install it from https://git-scm.com/
  goto :fail
)
where wsl >nul 2>&1
if errorlevel 1 (
  echo.
  echo   ERROR: WSL is not installed. Ansible runs on Linux; install WSL with
  echo   Ubuntu:  wsl --install -d Ubuntu-24.04
  goto :fail
)

echo.
echo   This takes about ten minutes.
echo.
choice /c YN /n /m "   Start? [Y/N] "
if errorlevel 2 goto :done

echo.
echo   [1/4] Ansible and the network collections, in WSL (%ARCHTOOLKIT_WSL_DISTRO%)...
echo.
wsl -d %ARCHTOOLKIT_WSL_DISTRO% -- bash tools/setup-ansible-wsl.sh
if errorlevel 1 ( set "STEP=the Ansible setup in WSL" & goto :stepfailed )

echo.
echo   [2/4] Every network blueprint: build, options, merge, syntax check...
echo.
%NODE% tools\validate-network-blueprints.mjs
if errorlevel 1 (
  echo.
  echo   Some blueprints did not pass - they are listed above. A module that
  echo   renamed or dropped an option shows here first; fix the blueprint in
  echo   src\network\blueprints, or the option list in
  echo   tools\validate-network-blueprints.mjs if the collection changed.
  set "STEP=validation"
  goto :stepfailed
)

echo.
echo   [3/4] Rebuilding the pages and running the tests...
echo.
%NODE% tools\build.mjs
if errorlevel 1 ( set "STEP=the build" & goto :stepfailed )
%NODE% --test "src/**/*.test.ts" > "%TEMP%\archtoolkit-tests.log" 2>&1
if errorlevel 1 (
  echo   Some tests failed. The full output is in %TEMP%\archtoolkit-tests.log
  set "STEP=the tests"
  goto :stepfailed
)
for /f "tokens=2,3" %%a in ('findstr /b /c:"# pass" /c:"# fail" "%TEMP%\archtoolkit-tests.log"') do echo   %%a %%b

echo.
echo   [4/4] Commit and push
echo.
rem Only ever commit ArchToolKit itself: this file's folder must be the repo's top.
set "TOP="
for /f "delims=" %%t in ('git rev-parse --show-toplevel 2^>nul') do set "TOP=%%~ft"
if /i not "!TOP!\"=="%~dp0" (
  echo   This folder is not the top of the ArchToolKit git repository, so
  echo   nothing is committed. Commit the changes by hand.
  goto :finished
)
git status --short > "%TEMP%\archtoolkit-status.txt"
for %%s in ("%TEMP%\archtoolkit-status.txt") do if %%~zs==0 (
  echo   Nothing changed - every network blueprint still passes. Nothing to commit.
  goto :finished
)
git status --short
echo.
choice /c YN /n /m "   Commit these and push to GitHub? [Y/N] "
if errorlevel 2 (
  echo.
  echo   Left uncommitted. Review with: git status
  goto :finished
)
for /f %%d in ('node -p "new Date().toISOString().slice(0,10)"') do set "TODAY=%%d"
for /f %%b in ('git branch --show-current') do set "BRANCH=%%b"
git add -A
git commit -q -m "Network: revalidated against the latest collections !TODAY!"
if errorlevel 1 ( set "STEP=the commit" & goto :stepfailed )
git push origin !BRANCH!
if errorlevel 1 ( set "STEP=the push" & goto :stepfailed )
echo.
echo   Committed and pushed to !BRANCH!.

:finished
echo.
echo   Done. Started %STARTED%, finished %TIME%.
goto :done

:stepfailed
echo.
echo   Stopped: !STEP! failed - see the messages above. Nothing was committed.
echo   Whatever the earlier steps rewrote is still in the working copy;
echo   git status shows it, and git checkout -- . puts it back.

:fail
echo.
pause
endlocal
exit /b 1

:done
echo.
pause
endlocal
