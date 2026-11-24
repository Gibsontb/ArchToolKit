/** Parse exported PowerShell with the native parser. Never dot-source or execute exported scripts. */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openZip } from '../src/core/zip.ts';
import { WORK_TMP } from './work.mjs';
const archives = process.argv.slice(2).map(file => resolve(file));
if (!archives.length) throw new Error('Supply one or more service deployment ZIP paths.');
const work = mkdtempSync(join(WORK_TMP, 'service-powershell-'));
const scripts = [];
for (const archive of archives) {
  const zip = openZip(new Uint8Array(readFileSync(archive)));
  const manifest = JSON.parse(await zip.text('service-deployment.json'));
  if (manifest.kind !== 'archtoolkit.service-deployment') throw new Error('Expected a service deployment ZIP.');
  for (const name of zip.names.filter(name => name.toLowerCase().endsWith('.ps1'))) {
    // Archive entry names are labels only, never extraction paths.
    const file = join(work, String(scripts.length) + '.ps1');
    writeFileSync(file, await zip.text(name));
    scripts.push({ archive, name, file });
  }
}
if (!scripts.length) throw new Error('No exported PowerShell scripts found.');
writeFileSync(join(work, 'manifest.json'), JSON.stringify(scripts));
writeFileSync(join(work, 'parse.ps1'), String.raw`param([Parameter(Mandatory=$true)][string]$Manifest)
$ErrorActionPreference = 'Stop'
$entries = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
$results = @()
foreach ($entry in $entries) {
  $tokens = $null
  $parseErrors = $null
  $null = [System.Management.Automation.Language.Parser]::ParseFile($entry.file, [ref]$tokens, [ref]$parseErrors)
  $results += [pscustomobject]@{ archive = $entry.archive; name = $entry.name; valid = ($parseErrors.Count -eq 0); errors = @($parseErrors | ForEach-Object { [pscustomobject]@{ line = $_.Extent.StartLineNumber; message = $_.Message } }) }
}
ConvertTo-Json -InputObject $results -Depth 6 | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'report.json') -Encoding UTF8
if (@($results | Where-Object { -not $_.valid }).Count -gt 0) { exit 1 }
Write-Output ('Parsed ' + $results.Count + ' exported scripts successfully; no script executed.')
`);
const executable = process.env.POWERSHELL_PATH || join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const check = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(work, 'parse.ps1'), '-Manifest', join(work, 'manifest.json')], { cwd: work, encoding: 'utf8', timeout: 60000, windowsHide: true });
if (check.error) throw check.error;
if (check.stdout) process.stdout.write(check.stdout);
if (check.stderr) process.stderr.write(check.stderr);
console.log('PowerShell syntax report: ' + join(work, 'report.json'));
if (check.status !== 0) process.exitCode = 1;
