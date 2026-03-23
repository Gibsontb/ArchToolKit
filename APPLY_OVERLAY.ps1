$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Read-Host "Enter path to ArchToolKit repo root"

if (!(Test-Path $target)) {
  throw "Target path does not exist: $target"
}

Copy-Item "$here\11_DataModels\*" "$target\11_DataModels" -Recurse -Force
Copy-Item "$here\12_Scripts\*" "$target\12_Scripts" -Recurse -Force
Copy-Item "$here\13_Web\*" "$target\13_Web" -Recurse -Force

Write-Host "Overlay applied to $target"
