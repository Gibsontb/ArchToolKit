@echo off
setlocal EnableDelayedExpansion
title ArchToolKit - update VCF Sizing and the Spec Builder
cd /d "%~dp0"

rem Brings VCF Sizing and the VCF Spec Builder up to Broadcom's latest:
rem   1. Appliance sizes from the VCF Planning and Preparation Workbook(s)
rem      linked on the TechDocs "Planning and Preparation" page (every
rem      release it links), into src\vcf\workbook-data.ts
rem   2. The Spec Builder's installer schema against Broadcom's published
rem      VCF Installer API (SddcSpec): stops if Broadcom has a field or value
rem      the builder does not
rem   3. Rebuild the pages and run the tests (they fail if a workbook table
rem      the sizing relies on has moved or been renamed)
rem   4. Commit and push, if anything changed and you say so
rem
rem Needs Node 22.6+, git, and network access to techdocs.broadcom.com and
rem developer.broadcom.com. Anything that fails stops the run before a commit.

set "NODE_NO_WARNINGS=1"
set "NODE=node --experimental-strip-types --no-warnings"
set "STARTED=%TIME%"

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

echo.
echo   This takes a minute or two.
echo.
choice /c YN /n /m "   Start? [Y/N] "
if errorlevel 2 goto :done

echo.
echo   [1/4] Appliance sizes from the Planning and Preparation Workbook...
echo.
%NODE% tools\fetch-vcf-workbook.mjs
if errorlevel 1 ( set "STEP=the workbook" & goto :stepfailed )

echo.
echo   [2/4] The Spec Builder against the published installer schema...
echo.
%NODE% tools\check-vcf-installer-schema.mjs
if errorlevel 1 (
  echo.
  echo   Broadcom publishes fields or values the Spec Builder does not have yet -
  echo   they are listed above. Add them to SDDC_SCHEMA in src\vcf\spec-validate.ts,
  echo   then to the builder and the page, and run this again.
  set "STEP=the schema check"
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
  echo   A failing sizing test after step 1 usually means the new workbook moved
  echo   or renamed a table that src\vcf\sizing-data.ts reads.
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
  echo   Nothing changed - the sizes and the schema are current. Nothing to commit.
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
git add src\vcf\workbook-data.ts web\lib
git commit -q -m "VCF: sizing figures and installer schema refreshed !TODAY!"
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
