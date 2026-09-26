@echo off
setlocal EnableDelayedExpansion
title ArchToolKit - update the Data Editor
cd /d "%~dp0"

rem Brings the Data Editor up to the latest published schemas:
rem   1. Update the tools in WSL: Ansible, cfn-lint, kubeconform
rem   2. F5 AS3/DO, CloudFormation, Kubernetes and Azure ARM schemas
rem   3. The editor against the real tools, over tools\editor-corpus:
rem      terraform validate, ansible-lint, cfn-lint, kubeconform
rem   4. Rebuild the pages and run the tests
rem   5. Commit and push, if anything changed and you say so
rem
rem Needs Node 22.6+, git, terraform, and WSL with Ubuntu. Set GITHUB_TOKEN
rem for the ARM schemas if GitHub rate limits the download. Anything that
rem fails stops the run before a commit.

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
echo   This takes about twenty minutes.
echo.
choice /c YN /n /m "   Start? [Y/N] "
if errorlevel 2 goto :done

echo.
echo   [1/5] The tools, in WSL (%ARCHTOOLKIT_WSL_DISTRO%)...
echo.
wsl -d %ARCHTOOLKIT_WSL_DISTRO% -- bash tools/setup-ansible-wsl.sh
if errorlevel 1 ( set "STEP=the tool setup in WSL" & goto :stepfailed )

echo.
echo   [2/5] The schemas: F5, CloudFormation, Kubernetes, Azure ARM...
echo.
%NODE% tools\fetch-editor-schemas.mjs
if errorlevel 1 ( set "STEP=the F5 schemas" & goto :stepfailed )
%NODE% tools\fetch-editor-cloudformation.mjs
if errorlevel 1 ( set "STEP=the CloudFormation schemas" & goto :stepfailed )
%NODE% tools\fetch-editor-kubernetes.mjs
if errorlevel 1 ( set "STEP=the Kubernetes schemas" & goto :stepfailed )
%NODE% tools\fetch-editor-arm.mjs
if errorlevel 1 ( set "STEP=the Azure ARM schemas" & goto :stepfailed )

echo.
echo   [3/5] The editor against the real tools...
echo.
%NODE% tools\validate-data-editor.mjs
if errorlevel 1 (
  echo.
  echo   The editor and a real tool disagree on the files listed above.
  set "STEP=validation"
  goto :stepfailed
)

echo.
echo   [4/5] Rebuilding the pages and running the tests...
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
echo   [5/5] Commit and push
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
  echo   Nothing changed - the schemas are current. Nothing to commit.
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
git commit -q -m "Data Editor: schemas refreshed and revalidated !TODAY!"
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
