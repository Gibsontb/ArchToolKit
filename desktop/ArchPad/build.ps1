<#
.SYNOPSIS
  Builds ArchPad.exe: toolkit build, then a self-contained single-file publish.

.DESCRIPTION
  1. node tools/build.mjs in the repo root, so web/lib holds the current
     ArchPad core, tools and vendor editor bundle.
  2. dotnet publish of desktop/ArchPad. The project's ArchPadStageWeb target
     zips web/archpad, web/lib and web/styles into the exe, so the result is
     one file with no 'app' folder to carry around.

  Output: desktop/ArchPad/publish/ArchPad.exe

.PARAMETER SkipWeb
  Do not run the toolkit build (web/lib is already current).

.PARAMETER Runtime
  Target runtime; win-x64 by default, win-arm64 for ARM devices.

.EXAMPLE
  pwsh desktop/ArchPad/build.ps1
#>
param(
  [switch]$SkipWeb,
  [string]$Runtime = 'win-x64',
  [string]$Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'
$project = $PSScriptRoot
$repo = (Resolve-Path (Join-Path $project '..\..')).Path
$out = Join-Path $project 'publish'

if (-not (Test-Path (Join-Path $project 'ArchPad.ico'))) {
  & (Join-Path $project 'tools\make-icon.ps1')
}

if (-not $SkipWeb) {
  Write-Host '== Toolkit build (node tools/build.mjs)'
  Push-Location $repo
  try {
    node tools/build.mjs
    if ($LASTEXITCODE -ne 0) { throw "Toolkit build failed (exit $LASTEXITCODE)." }
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path (Join-Path $repo 'web\archpad\index.html'))) {
  Write-Warning 'web\archpad\index.html does not exist yet; the exe will show a placeholder page.'
}

Write-Host "== dotnet publish ($Configuration, $Runtime, self-contained single file)"
dotnet publish (Join-Path $project 'ArchPad.csproj') `
  -c $Configuration `
  -r $Runtime `
  --self-contained true `
  -p:PublishSingleFile=true `
  -p:IncludeNativeLibrariesForSelfExtract=true `
  -o $out
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed (exit $LASTEXITCODE)." }

$exe = Get-Item (Join-Path $out 'ArchPad.exe')
Write-Host ('== {0} ({1:N1} MB)' -f $exe.FullName, ($exe.Length / 1MB))
