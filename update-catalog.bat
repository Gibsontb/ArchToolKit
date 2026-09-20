@echo off
setlocal EnableDelayedExpansion
title ArchToolKit - update Terraform catalog
cd /d "%~dp0"

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

echo.
echo   Fetching the resource catalog from the Terraform Registry...
echo   This needs internet access. Nothing else is sent.
echo.

set "NODE_NO_WARNINGS=1"
node tools\fetch-provider-catalog.mjs
set "RESULT=%errorlevel%"

echo.
if "%RESULT%"=="0" (
  echo   Done. src\terraform\catalog-data.ts has been rewritten.
  echo.
  echo   Two things worth doing now:
  echo     1. Rebuild so the pages pick it up:   npm run build
  echo     2. Commit the change, so the catalog travels with the repo.
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
    echo   Rebuilt. The catalog is live in the pages.
  )
) else (
  echo   The catalog could not be updated.
  echo.
  echo   The most likely cause is no route to registry.terraform.io -
  echo   a proxy, a firewall, or simply being offline. The previous
  echo   catalog has been left exactly as it was.
)

:done
echo.
pause
endlocal
