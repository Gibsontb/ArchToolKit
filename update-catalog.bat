@echo off
setlocal EnableDelayedExpansion
title ArchToolKit - update catalogs
cd /d "%~dp0"

rem Refreshes every catalog the toolkit consults:
rem   1. Terraform resources and data sources, from registry.terraform.io
rem   2. Ansible modules, from galaxy.ansible.com
rem   3. Terraform registry modules' inputs, cloned from each module's GitHub repo
rem   4. Machine sizes - AWS from the EC2 API model in botocore (GitHub);
rem      Azure, GCP and OCI from the ladders in tools\fetch-compute-catalog.mjs
rem   5. F5 AS3 and Declarative Onboarding answer sets, from F5's GitHub schemas
rem   6. Provider schemas - every argument of every resource in the six
rem      VMware providers and the Linux/Windows ones (AD, DNS, TLS, cloud-init,
rem      Ansible, ...), from the providers themselves (terraform providers
rem      schema) and their registry docs
rem
rem All are committed to the repository so the toolkit still works offline.
rem This is the only part of ArchToolKit that touches the network, and it
rem sends nothing - it only reads public registries and repositories.
rem Steps 3-5 need git on PATH and step 6 needs terraform on PATH; without
rem them those steps are skipped, not failed.

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

rem ---- git present? --------------------------------------------------------
set "HASGIT=1"
where git >nul 2>&1
if errorlevel 1 set "HASGIT="

rem ---- terraform present? --------------------------------------------------
set "HASTF=1"
where terraform >nul 2>&1
if errorlevel 1 set "HASTF="

set "NODE_NO_WARNINGS=1"
set "FAILED="
set "SKIPPED="
set "UPDATED="

echo.
echo   [1/6] Terraform resources, from the Terraform Registry...
echo.
node tools\fetch-provider-catalog.mjs
if errorlevel 1 ( set "FAILED=!FAILED! Terraform-resources" ) else ( set "UPDATED=!UPDATED! src\terraform\catalog-data.ts" )

echo.
echo   [2/6] Ansible modules, from Ansible Galaxy...
echo.
node tools\fetch-ansible-catalog.mjs
if errorlevel 1 ( set "FAILED=!FAILED! Ansible" ) else ( set "UPDATED=!UPDATED! src\ansible\catalog-data.ts" )

echo.
echo   [3/6] Terraform registry modules, from their GitHub repositories...
echo.
if not defined HASGIT (
  echo   Skipped: git was not found on PATH.
  set "SKIPPED=!SKIPPED! Terraform-modules"
) else (
  node tools\fetch-module-catalog.mjs
  if errorlevel 1 ( set "FAILED=!FAILED! Terraform-modules" ) else ( set "UPDATED=!UPDATED! src\terraform\module-catalog-data.ts" )
)

echo.
echo   [4/6] Machine sizes: AWS from botocore, Azure/GCP/OCI from the ladders...
echo.
set "BOTO=%TEMP%\archtoolkit-botocore-%RANDOM%%RANDOM%"
set "BOTOARG="
if not defined HASGIT (
  echo   git was not found on PATH - keeping the AWS list already committed.
  set "SKIPPED=!SKIPPED! AWS-sizes"
) else (
  git clone -q --depth 1 --filter=blob:none --no-checkout https://github.com/boto/botocore.git "!BOTO!"
  if errorlevel 1 (
    echo   Could not clone botocore - keeping the AWS list already committed.
    set "FAILED=!FAILED! AWS-sizes"
  ) else (
    git -C "!BOTO!" sparse-checkout set botocore/data/ec2 && git -C "!BOTO!" checkout -q
    if errorlevel 1 (
      echo   Could not check out botocore's EC2 model - keeping the AWS list already committed.
      set "FAILED=!FAILED! AWS-sizes"
    ) else (
      set "BOTOARG=--botocore "!BOTO!""
    )
  )
)
node tools\fetch-compute-catalog.mjs !BOTOARG!
if errorlevel 1 ( set "FAILED=!FAILED! Machine-sizes" ) else ( set "UPDATED=!UPDATED! src\kit\sizes-data.ts" )
if exist "!BOTO!" rmdir /s /q "!BOTO!"

echo.
echo   [5/6] F5 AS3 and DO answer sets, from F5's schemas...
echo.
if not defined HASGIT (
  echo   Skipped: git was not found on PATH.
  set "SKIPPED=!SKIPPED! F5-schemas"
) else (
  node tools\fetch-editor-schemas.mjs
  if errorlevel 1 ( set "FAILED=!FAILED! F5-schemas" ) else ( set "UPDATED=!UPDATED! src\editor\f5-schema-data.ts" )
)

echo.
echo   [6/6] Provider schemas: VMware, Active Directory, DNS, TLS, cloud-init, Ansible...
echo.
if not defined HASTF (
  echo   Skipped: terraform was not found on PATH.
  set "SKIPPED=!SKIPPED! Provider-schemas"
) else (
  node tools\fetch-provider-schemas.mjs
  if errorlevel 1 ( set "FAILED=!FAILED! Provider-schemas" ) else ( set "UPDATED=!UPDATED! src\terraform\vmware-schema-data.ts src\terraform\os-schema-data.ts" )
)

echo.
if defined UPDATED (
  echo   Rewritten:
  for %%f in (!UPDATED!) do echo     %%f
  echo.
)
if defined SKIPPED (
  echo   Skipped, a tool is not on PATH:!SKIPPED!
  echo   git from https://git-scm.com/ and terraform from
  echo   https://developer.hashicorp.com/terraform/install refresh these too.
  echo.
)
if defined FAILED (
  echo   Could not update:!FAILED!
  echo.
  echo   The most likely cause is no route to registry.terraform.io,
  echo   galaxy.ansible.com or github.com - a proxy, a firewall, or simply
  echo   being offline. Whatever could not be fetched was left as it was.
  echo.
)
if not defined UPDATED goto :done

choice /c YN /n /m "   Check the generated Terraform against the provider schemas? [Y/N] "
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
