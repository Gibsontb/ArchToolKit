@echo off
setlocal EnableDelayedExpansion
title ArchToolKit - update
cd /d "%~dp0"
rem ---------------------------------------------------------------------------
rem  One update for the whole toolkit. Pick the areas (or everything); each
rem  shared step runs once: the WSL tools, each download, the rebuild, the
rem  tests, and a single commit at the end.
rem
rem    T  Terraform       catalog, provider schemas, rules, validate every blueprint
rem    A  Ansible         catalog, module schemas, rules, lint every blueprint
rem    N  Network         validate every network blueprint (WSL collections)
rem    S  Splunk          spec files, release check, validate every app
rem    E  Data Editor     F5, CloudFormation, Kubernetes and ARM schemas, validate
rem    V  VCF             sizing workbook, installer schema check
rem    C  Catalogs        Terraform registry modules and machine sizes
rem    L  Cloud services  service catalog for AWS, Azure, Google Cloud and OCI
rem
rem  A step that fails is recorded and the rest carry on; nothing is committed
rem  unless every step and the tests pass.
rem
rem  Unattended:  update.bat all /yes      (or letters, e.g.  update.bat NSV /yes)
rem  picks the areas without asking, starts at once, commits and pushes only if
rem  everything passed, and never waits for a key.
rem
rem  What is current is skipped: a download that passed in the last 20 hours,
rem  and a check whose inputs have not changed since it last passed
rem  (tools\update-state.mjs). /force runs every step anyway.
rem
rem  Everything it downloads, caches and builds stays in .work\ in this folder.
rem ---------------------------------------------------------------------------

set "NODE_NO_WARNINGS=1"
set "NODE=node --experimental-strip-types --no-warnings"
set "STARTED=%TIME%"
set "WORKDIR=%~dp0.work"
if not exist "%WORKDIR%\tmp" mkdir "%WORKDIR%\tmp"
if not defined ARCHTOOLKIT_WSL_DISTRO set "ARCHTOOLKIT_WSL_DISTRO=Ubuntu-24.04"
set "FAILED="
set "SKIPPED="
set "DONE="
set "AUTO="
set "FORCE="
set "ARGPICK="
set "KEY="
set "CHECK="
for %%x in (%*) do (
  if /i "%%~x"=="/yes" ( set "AUTO=1" ) else if /i "%%~x"=="/force" ( set "FORCE=1" ) else if /i "%%~x"=="all" ( set "ARGPICK=T A N S E V C L" ) else ( set "ARGPICK=%%~x" )
)
rem How long a download stays current, and what each check reads.
set "FRESH=--within 20"
set "VERSIONS=.work/ansible-versions.txt"

rem --- Node 22.6 or newer is required for everything ------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   ERROR: Node.js was not found on PATH. Install 22.6 or newer from https://nodejs.org/
  goto :fail
)
node -e "var v=process.versions.node.split('.').map(Number);process.exit((v[0]>22||(v[0]===22&&v[1]>=6))?0:1)"
if errorlevel 1 (
  for /f %%v in ('node -p "process.versions.node"') do set "FOUND=%%v"
  echo.
  echo   ERROR: Node !FOUND! is too old. ArchToolKit needs 22.6 or newer.
  goto :fail
)
set "HASGIT=1" & where git >nul 2>&1 || set "HASGIT="
set "HASTF=1" & where terraform >nul 2>&1 || set "HASTF="
set "HASWSL=1" & where wsl >nul 2>&1 || set "HASWSL="

rem --- Which areas ----------------------------------------------------------
echo.
echo   What to update:
echo     T  Terraform     (about 2 hours)
echo     A  Ansible       (about 2.5 hours)
echo     N  Network       (about 10 minutes)
echo     S  Splunk        (about 5 minutes)
echo     E  Data Editor   (about 20 minutes)
echo     V  VCF           (a minute or two)
echo     C  Catalogs      (Terraform modules and machine sizes, a few minutes)
echo     L  Cloud services (AWS, Azure, Google Cloud and OCI service lists, about 5 minutes)
echo.
echo   Press Enter for everything, or type the letters, e.g.  N S V
set "PICK=!ARGPICK!"
if not defined ARGPICK set /p "PICK=   Areas: "
if not defined PICK set "PICK=T A N S E V C L"
set "PICK=!PICK: =!"
for %%a in (T A N S E V C L) do set "DO_%%a="
for %%a in (T A N S E V C L) do (
  echo !PICK! | findstr /i "%%a" >nul && set "DO_%%a=1"
)
if not defined DO_T if not defined DO_A if not defined DO_N if not defined DO_S if not defined DO_E if not defined DO_V if not defined DO_C if not defined DO_L (
  echo.
  echo   Nothing recognised in "!PICK!". Use the letters T A N S E V C L.
  goto :fail
)

rem --- Tools each area needs -------------------------------------------------
set "NEEDWSL="
for %%a in (A N S E) do if defined DO_%%a set "NEEDWSL=1"
if defined NEEDWSL if not defined HASWSL (
  echo.
  echo   WSL is not installed, so Ansible, Network, Splunk and the Data Editor
  echo   are skipped. Install it with:  wsl --install -d Ubuntu-24.04
  for %%a in (A N S E) do if defined DO_%%a set "SKIPPED=!SKIPPED! %%a-needs-WSL" & set "DO_%%a="
  set "NEEDWSL="
)
if defined DO_T if not defined HASTF (
  echo.
  echo   terraform is not on PATH, so the Terraform area is skipped. Install it from
  echo   https://developer.hashicorp.com/terraform/install
  set "SKIPPED=!SKIPPED! Terraform-needs-terraform" & set "DO_T="
)

echo.
if defined AUTO goto :started
choice /c YN /n /m "   Start? [Y/N] "
if errorlevel 2 goto :done
:started

rem ===========================================================================
rem  1. Tools in WSL, once
rem ===========================================================================
if defined NEEDWSL (
  set "LABEL=WSL tools (Ansible, collections, ansible-lint, cfn-lint, kubeconform, AppInspect)"
  set "CMD=wsl -d %ARCHTOOLKIT_WSL_DISTRO% -- bash tools/setup-ansible-wsl.sh"
  set "KEY=wsl-tools" & set "CHECK=!FRESH! --inputs tools/setup-ansible-wsl.sh !VERSIONS!"
  call :step
)

rem ===========================================================================
rem  2. Downloads, each once (current for 20 hours after it passes)
rem ===========================================================================
if defined DO_T (
  set "LABEL=Terraform resource catalog" & set "CMD=%NODE% tools\fetch-provider-catalog.mjs" & set "KEY=tf-catalog" & set "CHECK=!FRESH!" & call :step
  set "LABEL=Terraform provider schemas" & set "CMD=%NODE% tools\fetch-provider-schemas.mjs" & set "KEY=tf-schemas" & set "CHECK=!FRESH!" & call :step
)
if defined DO_C (
  if defined HASGIT (
    set "LABEL=Terraform registry modules" & set "CMD=%NODE% tools\fetch-module-catalog.mjs" & set "KEY=tf-modules" & set "CHECK=!FRESH!" & call :step
  ) else ( set "SKIPPED=!SKIPPED! Terraform-modules-needs-git" )
  call :sizes
)
if defined DO_A (
  set "LABEL=Ansible module catalog" & set "CMD=%NODE% tools\fetch-ansible-catalog.mjs" & set "KEY=ansible-catalog" & set "CHECK=!FRESH!" & call :step
  set "LABEL=Ansible module schemas" & set "CMD=%NODE% tools\fetch-ansible-schemas.mjs" & set "KEY=ansible-schemas" & set "CHECK=!FRESH! --inputs !VERSIONS!" & call :step
)
if defined DO_E (
  set "LABEL=F5 AS3 and DO schemas" & set "CMD=%NODE% tools\fetch-editor-schemas.mjs" & set "KEY=editor-f5" & set "CHECK=!FRESH!" & call :step
  set "LABEL=CloudFormation schemas" & set "CMD=%NODE% tools\fetch-editor-cloudformation.mjs" & set "KEY=editor-cfn" & set "CHECK=!FRESH!" & call :step
  set "LABEL=Kubernetes schemas" & set "CMD=%NODE% tools\fetch-editor-kubernetes.mjs" & set "KEY=editor-k8s" & set "CHECK=!FRESH!" & call :step
  set "LABEL=Azure ARM schemas" & set "CMD=%NODE% tools\fetch-editor-arm.mjs" & set "KEY=editor-arm" & set "CHECK=!FRESH!" & call :step
)
if defined DO_S (
  set "LABEL=Splunk spec files" & set "CMD=%NODE% tools\fetch-splunk-specs.mjs" & set "KEY=splunk-specs" & set "CHECK=!FRESH!" & call :step
  set "LABEL=Splunk releases" & set "CMD=%NODE% tools\check-splunk-versions.mjs" & set "KEY=splunk-releases" & set "CHECK=!FRESH!" & call :step
)
if defined DO_V (
  set "LABEL=VCF sizing workbook" & set "CMD=%NODE% tools\fetch-vcf-workbook.mjs" & set "KEY=vcf-workbook" & set "CHECK=!FRESH!" & call :step
)
rem Last of the downloads: it reads the Terraform catalog and the CloudFormation
rem and ARM schemas that the steps above may just have refreshed.
if defined DO_L (
  for %%c in (aws azure google oci) do (
    set "LABEL=Cloud services: %%c" & set "CMD=%NODE% tools\fetch-service-catalog.mjs --cloud %%c" & set "KEY=services-%%c" & set "CHECK=!FRESH!" & call :step
  )
)

rem ===========================================================================
rem  3. Rule discovery (the slow part; skipped when nothing it reads changed)
rem ===========================================================================
if defined DO_T (
  set "LABEL=Terraform provider rules (about an hour)" & set "CMD=%NODE% tools\discover-resource-rules.mjs"
  set "KEY=tf-rules" & set "CHECK=--inputs src/terraform src/kit tools/discover-resource-rules.mjs tools/validate-terraform-blueprints.mjs tools/terraform-init.mjs"
  call :step
)
if defined DO_A (
  set "LABEL=Ansible module rules (about an hour)" & set "CMD=%NODE% tools\discover-module-rules.mjs"
  set "KEY=ansible-rules" & set "CHECK=--inputs src/ansible src/kit tools/discover-module-rules.mjs tools/validate-ansible-blueprints.mjs !VERSIONS!"
  call :step
)

rem ===========================================================================
rem  4. Validation with the real tools (skipped when nothing it checks changed)
rem ===========================================================================
if defined DO_T (
  for %%p in (vsphere vcf linux windows oci azure google aws) do (
    set "LABEL=terraform validate: %%p" & set "CMD=%NODE% tools\validate-terraform-blueprints.mjs --platform %%p"
    set "KEY=tf-validate-%%p" & set "CHECK=--inputs src/terraform src/kit tools/validate-terraform-blueprints.mjs tools/terraform-init.mjs"
    call :step
  )
  set "LABEL=Generated Terraform against the provider schemas" & set "CMD=%NODE% tools\verify-foundation-schemas.mjs"
  set "KEY=tf-foundation" & set "CHECK=--inputs src/terraform src/kit tools/verify-foundation-schemas.mjs"
  call :step
)
if defined DO_A (
  set "LABEL=ansible-lint over every blueprint (about an hour)" & set "CMD=%NODE% tools\validate-ansible-blueprints.mjs"
  set "KEY=ansible-lint" & set "CHECK=--inputs src/ansible src/kit tools/validate-ansible-blueprints.mjs !VERSIONS!"
  call :step
)
if defined DO_N (
  set "LABEL=Every network blueprint" & set "CMD=%NODE% tools\validate-network-blueprints.mjs"
  set "KEY=network" & set "CHECK=--inputs src/network src/ansible src/kit tools/validate-network-blueprints.mjs !VERSIONS!"
  call :step
)
if defined DO_S (
  set "LABEL=Every Splunk app" & set "CMD=%NODE% tools\validate-splunk-blueprints.mjs"
  set "KEY=splunk" & set "CHECK=--inputs src/splunk src/kit tools/validate-splunk-blueprints.mjs !VERSIONS!"
  call :step
)
if defined DO_E (
  set "LABEL=The Data Editor against the real tools" & set "CMD=%NODE% tools\validate-data-editor.mjs"
  set "KEY=editor" & set "CHECK=--inputs src/editor web/data/editor tools/validate-data-editor.mjs !VERSIONS!"
  call :step
)
if defined DO_V (
  set "LABEL=Spec Builder against the published installer schema" & set "CMD=%NODE% tools\check-vcf-installer-schema.mjs"
  set "KEY=vcf-installer" & set "CHECK=!FRESH! --inputs src/vcf tools/check-vcf-installer-schema.mjs"
  call :step
)

rem ===========================================================================
rem  5. Rebuild and test, once
rem ===========================================================================
set "LABEL=Rebuild the pages" & set "CMD=%NODE% tools\build.mjs" & call :step
echo.
echo   ---- Tests (the full output goes to .work\tests.log)
%NODE% --test "src/**/*.test.ts" > "%WORKDIR%\tests.log" 2>&1
if errorlevel 1 (
  set "FAILED=!FAILED!;Tests (see .work\tests.log)"
) else (
  set "DONE=!DONE!;Tests"
)
for /f "tokens=2,3" %%a in ('findstr /b /c:"# pass" /c:"# fail" "%WORKDIR%\tests.log"') do echo   %%a %%b

rem ===========================================================================
rem  6. Summary, and one commit
rem ===========================================================================
echo.
echo   ===========================================================================
echo   Summary
if defined DONE for %%s in ("!DONE:;=" "!") do if not "%%~s"=="" echo     OK      %%~s
if defined FAILED for %%s in ("!FAILED:;=" "!") do if not "%%~s"=="" echo     FAILED  %%~s
if defined SKIPPED echo     Skipped:!SKIPPED!
echo   ===========================================================================

if defined FAILED (
  echo.
  echo   Something failed, so nothing is committed. What the steps rewrote is
  echo   still in the working copy: git status shows it, git checkout -- . puts
  echo   it back. Fix the failures and run this again for those areas.
  goto :finished
)
if not defined HASGIT (
  echo.
  echo   git is not on PATH, so nothing is committed. Commit the changes by hand.
  goto :finished
)
set "TOP="
for /f "delims=" %%t in ('git rev-parse --show-toplevel 2^>nul') do set "TOP=%%~ft"
if /i not "!TOP!\"=="%~dp0" (
  echo.
  echo   This folder is not the top of the ArchToolKit git repository, so nothing
  echo   is committed. Commit the changes by hand.
  goto :finished
)
git status --short > "%WORKDIR%\status.txt"
for %%s in ("%WORKDIR%\status.txt") do if %%~zs==0 (
  echo.
  echo   Nothing changed - everything is current. Nothing to commit.
  goto :finished
)
echo.
git status --short
echo.
if defined AUTO goto :commit
choice /c YN /n /m "   Commit these and push to GitHub? [Y/N] "
if errorlevel 2 (
  echo.
  echo   Left uncommitted. Review with: git status
  goto :finished
)
:commit
set "AREAS="
if defined DO_T set "AREAS=!AREAS! Terraform,"
if defined DO_A set "AREAS=!AREAS! Ansible,"
if defined DO_N set "AREAS=!AREAS! Network,"
if defined DO_S set "AREAS=!AREAS! Splunk,"
if defined DO_E set "AREAS=!AREAS! Data Editor,"
if defined DO_V set "AREAS=!AREAS! VCF,"
if defined DO_C set "AREAS=!AREAS! catalogs,"
if defined DO_L set "AREAS=!AREAS! cloud services,"
set "AREAS=!AREAS:~1,-1!"
for /f %%d in ('node -p "new Date().toISOString().slice(0,10)"') do set "TODAY=%%d"
for /f %%b in ('git branch --show-current') do set "BRANCH=%%b"
git add -A
git commit -q -m "Update !TODAY!: !AREAS! refreshed and revalidated"
if errorlevel 1 ( echo   The commit failed - see above. & goto :fail )
git push origin !BRANCH!
if errorlevel 1 ( echo   The push failed - see above. & goto :fail )
echo.
echo   Committed and pushed to !BRANCH!.

:finished
echo.
echo   Started %STARTED%, finished %TIME%.
goto :done

rem ---------------------------------------------------------------------------
rem  :step - run CMD under LABEL, record OK or FAILED, and carry on.
rem ---------------------------------------------------------------------------
rem  With KEY set, a step that is current (tools\update-state.mjs check KEY
rem  CHECK) is skipped, and a step that passes is recorded as current.
rem ---------------------------------------------------------------------------
:step
echo.
echo   ---- !LABEL!
if defined KEY if not defined FORCE (
  %NODE% tools\update-state.mjs check !KEY! !CHECK!
  if not errorlevel 1 (
    set "DONE=!DONE!;!LABEL! - current, skipped"
    set "KEY=" & set "CHECK="
    exit /b 0
  )
)
echo.
rem Clear the check's exit code, so only the step's own decides.
(call )
!CMD!
if errorlevel 1 (
  set "FAILED=!FAILED!;!LABEL!"
) else (
  set "DONE=!DONE!;!LABEL!"
  if defined KEY %NODE% tools\update-state.mjs record !KEY! !CHECK!
)
set "KEY=" & set "CHECK="
exit /b 0

rem ---------------------------------------------------------------------------
rem  :sizes - machine sizes: AWS from botocore's EC2 model, the rest from the
rem  ladders. Without git the AWS list already committed is kept.
rem ---------------------------------------------------------------------------
:sizes
set "BOTOARG="
if not defined FORCE (
  %NODE% tools\update-state.mjs check sizes !FRESH! >nul
  if not errorlevel 1 (
    echo.
    echo   ---- Machine sizes
    echo   Current - skipped.
    set "DONE=!DONE!;Machine sizes - current, skipped"
    exit /b 0
  )
)
if not defined HASGIT (
  set "SKIPPED=!SKIPPED! AWS-sizes-need-git"
) else (
  set "BOTO=%WORKDIR%\tmp\botocore-%RANDOM%%RANDOM%"
  git clone -q --depth 1 --filter=blob:none --no-checkout https://github.com/boto/botocore.git "!BOTO!" && git -C "!BOTO!" sparse-checkout set botocore/data/ec2 && git -C "!BOTO!" checkout -q && set "BOTOARG=--botocore "!BOTO!""
  if not defined BOTOARG set "FAILED=!FAILED!;AWS machine sizes (could not fetch botocore)"
)
set "LABEL=Machine sizes" & set "CMD=%NODE% tools\fetch-compute-catalog.mjs !BOTOARG!" & set "KEY=sizes" & set "CHECK=!FRESH!" & set "FORCE_WAS=!FORCE!" & set "FORCE=1" & call :step
set "FORCE=!FORCE_WAS!"
if defined BOTO if exist "!BOTO!" rmdir /s /q "!BOTO!"
exit /b 0

:fail
echo.
if not defined AUTO pause
endlocal
exit /b 1

:done
echo.
if not defined AUTO pause
endlocal
