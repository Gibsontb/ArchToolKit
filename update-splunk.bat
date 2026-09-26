@echo off
setlocal EnableDelayedExpansion
title ArchToolKit - update Splunk
cd /d "%~dp0"

rem Checks the Splunk page against the latest Splunk release and Splunk's own tools:
rem   1. Update the tools in WSL: ~/archtoolkit-ansible, now with Splunk AppInspect
rem   2. Refresh the Splunk Enterprise .conf.spec settings (src\splunk\conf-spec-data.ts)
rem   3. Compare the latest Splunk Enterprise and Splunk Cloud Platform releases
rem      with the ones the page targets (a newer one is flagged, not failed)
rem   4. Every Splunk blueprint, every choice: builds, every .conf file parses,
rem      every setting is in Splunk's spec files, no credential in any file,
rem      and each app packaged and inspected with Splunk AppInspect   ~2 min
rem   5. Rebuild the pages and run the tests
rem   6. Commit and push, if anything changed and you say so
rem
rem Needs Node 22.6+, git, and WSL with Ubuntu (AppInspect does not run on
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
  echo   ERROR: WSL is not installed. Splunk AppInspect runs on Linux; install
  echo   WSL with Ubuntu:  wsl --install -d Ubuntu-24.04
  goto :fail
)

echo.
echo   This takes about five minutes.
echo.
choice /c YN /n /m "   Start? [Y/N] "
if errorlevel 2 goto :done

echo.
echo   [1/6] The tools and Splunk AppInspect, in WSL (%ARCHTOOLKIT_WSL_DISTRO%)...
echo.
wsl -d %ARCHTOOLKIT_WSL_DISTRO% -- bash tools/setup-ansible-wsl.sh
if errorlevel 1 ( set "STEP=the tool setup in WSL" & goto :stepfailed )

echo.
echo   [2/6] The Splunk Enterprise spec files...
echo.
%NODE% tools\fetch-splunk-specs.mjs
if errorlevel 1 ( set "STEP=the spec files" & goto :stepfailed )

echo.
echo   [3/6] The latest Splunk releases...
echo.
%NODE% tools\check-splunk-versions.mjs
if errorlevel 1 ( set "STEP=the version check" & goto :stepfailed )

echo.
echo   [4/6] Every Splunk blueprint: build, conf, spec, credentials, AppInspect...
echo.
%NODE% tools\validate-splunk-blueprints.mjs
if errorlevel 1 (
  echo.
  echo   Some blueprints did not pass - they are listed above. A setting that
  echo   Splunk renamed or dropped shows here first; fix the blueprint in
  echo   src\splunk\blueprints, or the allow lists in
  echo   tools\validate-splunk-blueprints.mjs if the spec or AppInspect is wrong.
  set "STEP=validation"
  goto :stepfailed
)

echo.
echo   [5/6] Rebuilding the pages and running the tests...
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
echo   [6/6] Commit and push
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
  echo   Nothing changed - every Splunk blueprint still passes. Nothing to commit.
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
git commit -q -m "Splunk: revalidated against the latest spec files and AppInspect !TODAY!"
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
