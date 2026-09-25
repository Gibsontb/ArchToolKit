@echo off
setlocal EnableDelayedExpansion
title ArchToolKit - update Terraform
cd /d "%~dp0"

rem Brings the Terraform blueprints up to the providers' latest releases:
rem   1. The resource catalog (every provider's resource names and versions)
rem   2. The provider schemas - every argument of every resource, for AWS,
rem      Azure, Google Cloud, OCI, the six VMware providers and Linux/Windows
rem   3. The rules the providers check in code (discovered by running
rem      terraform validate over every per-resource blueprint)       ~1 hour
rem   4. terraform validate over every blueprint, every platform      ~1 hour
rem   5. Rebuild the pages and run the tests
rem   6. Commit and push, if you say so
rem
rem Needs Node 22.6+, terraform and git on PATH, and network access to
rem registry.terraform.io. Anything that fails stops the run before a commit.

set "NODE_NO_WARNINGS=1"
rem Older Node 22 releases need this to run the TypeScript the tools import;
rem newer ones accept it and ignore it.
set "NODE=node --experimental-strip-types --no-warnings"
set "STARTED=%TIME%"

rem ---- Tools present? --------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   ERROR: Node.js was not found on PATH. Install 22.6 or newer from
  echo   https://nodejs.org/ and reopen this window.
  goto :fail
)
node -e "var v=process.versions.node.split('.').map(Number);process.exit((v[0]>22||(v[0]===22&&v[1]>=6))?0:1)"
if errorlevel 1 (
  for /f %%v in ('node -p "process.versions.node"') do set "FOUND=%%v"
  echo.
  echo   ERROR: Node !FOUND! is too old. ArchToolKit needs 22.6 or newer.
  goto :fail
)
where terraform >nul 2>&1
if errorlevel 1 (
  echo.
  echo   ERROR: terraform was not found on PATH. Install it from
  echo   https://developer.hashicorp.com/terraform/install and reopen this window.
  goto :fail
)
where git >nul 2>&1
if errorlevel 1 (
  echo.
  echo   ERROR: git was not found on PATH. Install it from https://git-scm.com/
  goto :fail
)

echo.
echo   This takes about two hours, most of it steps 3 and 4.
echo.
choice /c YN /n /m "   Start? [Y/N] "
if errorlevel 2 goto :done

echo.
echo   [1/6] Resource catalog, from the Terraform Registry...
echo.
%NODE% tools\fetch-provider-catalog.mjs
if errorlevel 1 ( set "STEP=the resource catalog" & goto :stepfailed )

echo.
echo   [2/6] Provider schemas: every argument of every resource...
echo.
%NODE% tools\fetch-provider-schemas.mjs
if errorlevel 1 ( set "STEP=the provider schemas" & goto :stepfailed )

echo.
echo   [3/6] Provider rules, found with terraform validate (about an hour)...
echo.
%NODE% tools\discover-resource-rules.mjs
if errorlevel 1 ( set "STEP=rule discovery" & goto :stepfailed )

echo.
echo   [4/6] terraform validate over every blueprint, platform by platform...
set "INVALID="
for %%p in (vsphere vcf linux windows oci azure google aws) do (
  echo.
  echo   --- %%p
  %NODE% tools\validate-terraform-blueprints.mjs --platform %%p
  if errorlevel 1 set "INVALID=!INVALID! %%p"
)
if defined INVALID (
  echo.
  echo   Blueprints that did not validate on:!INVALID!
  echo   The failures are listed above. A new provider rule the discovery
  echo   could not read goes in RESOURCE_RULES in src\terraform\schema-blueprints.ts.
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
  echo   Nothing changed - the providers had no new releases. Nothing to commit.
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
git commit -q -m "Terraform: provider schemas, catalog and rules refreshed !TODAY!"
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
