@echo off
setlocal EnableDelayedExpansion
title ArchToolKit - update catalogs
cd /d "%~dp0"

rem Refreshes both catalogs the toolkit consults:
rem   Terraform resources and data sources, from registry.terraform.io
rem   Ansible modules, from galaxy.ansible.com
rem
rem Both are committed to the repository so the toolkit still works offline.
rem This is the only part of ArchToolKit that touches the network, and it
rem sends nothing - it only reads the public provider and collection indexes.

rem ---- Node present? -------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   ERROR: Node.js was not found on PATH.
  echo   ArchToolKit needs Node 22.6 or newer.
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
  echo   ERROR: Node !FOUND! is too old. ArchToolKit needs 22.6 or newer.
  echo.
  pause
  exit /b 1
)

set "NODE_NO_WARNINGS=1"
set "FAILED="

echo.
echo   [1/2] Terraform resources, from the Terraform Registry...
echo.
node tools\fetch-provider-catalog.mjs
if errorlevel 1 set "FAILED=!FAILED! Terraform"

echo.
echo   [2/2] Ansible modules, from Ansible Galaxy...
echo.
node tools\fetch-ansible-catalog.mjs
if errorlevel 1 set "FAILED=!FAILED! Ansible"

echo.
if defined FAILED (
  echo   Could not update:!FAILED!
  echo.
  echo   The most likely cause is no route to registry.terraform.io or
  echo   galaxy.ansible.com - a proxy, a firewall, or simply being offline.
  echo   Whatever could not be fetched has been left exactly as it was.
  echo.
  goto :done
)

echo   Done. Both catalogs have been rewritten:
echo     src\terraform\catalog-data.ts
echo     src\ansible\catalog-data.ts
echo.
choice /c YN /n /m "   Also check the generated Terraform against the provider schemas? [Y/N] "
if errorlevel 2 goto :afterverify
echo.
node tools\verify-foundation-schemas.mjs
echo.
:afterverify
echo   Two things worth doing now:
echo     1. Rebuild so the pages pick it up:   npm run build
echo     2. Commit the change, so the catalogs travel with the repo.
echo.
choice /c YN /n /m "   Rebuild now? [Y/N] "
if errorlevel 2 goto :done
echo.
node tools\build.mjs
if errorlevel 1 (
  echo.
  echo   The build failed - see the errors above.
) else (
  echo.
  echo   Rebuilt. The catalogs are live in the pages.
)

:done
echo.
pause
endlocal
