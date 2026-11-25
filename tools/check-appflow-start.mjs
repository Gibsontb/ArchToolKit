/** Run the actual exported operator script under PS5 with fake python/aws functions only. */
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_APPFLOW_SERVICE as blueprint} from '../src/cloud/aws-appflow-service.ts';
import {WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'appflow-start-'));
const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',name:'reviewed-export',account:'123456789012',profile:'approved-private-salesforce',instance:'https://approved.my.salesforce.com',bucket:'approved-flow-output',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc'});
for(const mode of ['no-approval','preflight-fail','ambiguous','wrong-arn','success']){
 const dir=join(work,mode);mkdirSync(dir);for(const name of ['START-APPROVED.ps1','FLOW-CONFIG.json'])writeFileSync(join(dir,name),result.files[name]);
}
writeFileSync(join(work,'test.ps1'),String.raw`param([string]$Root)
$ErrorActionPreference = 'Stop'
$env:AWS_MAX_ATTEMPTS = '7'
function global:python {
    if ($args[-1] -ne '--check') { throw 'Unexpected fake metadata check request.' }
    $global:LASTEXITCODE = $(if ($global:Mode -eq 'preflight-fail') { 1 } else { 0 })
}
function global:aws {
    $global:Calls++
    if (($args[0] -ne 'appflow') -or ($args[1] -ne 'start-flow')) { throw 'Unexpected fake AWS action.' }
    if ($env:AWS_MAX_ATTEMPTS -ne '1') { throw 'Blind network retries not disabled.' }
    $index = [Array]::IndexOf($args, '--client-token')
    $parsed = [guid]::Empty
    if (($index -lt 0) -or (-not [guid]::TryParse([string]$args[$index + 1], [ref]$parsed))) { throw 'Missing saved idempotency token.' }
    $saved = Get-Content -LiteralPath (Join-Path $global:CaseDir 'TRANSFER-REQUEST.json') -Raw | ConvertFrom-Json
    if ($saved.clientToken -ne $args[$index + 1]) { throw 'Token not saved before network call.' }
    $endpointIndex = [Array]::IndexOf($args, '--endpoint-url')
    if (($endpointIndex -lt 0) -or ($args[$endpointIndex + 1] -ne 'https://appflow-fips.us-east-1.amazonaws.com')) { throw 'Expected FIPS API endpoint.' }
    $global:LASTEXITCODE = $(if ($global:Mode -eq 'ambiguous') { 1 } else { 0 })
    @{ flowArn = $(if ($global:Mode -eq 'wrong-arn') { 'other' } else { 'arn:aws:appflow:us-east-1:123456789012:flow/reviewed-export' }); executionId = 'exec-1234' } | ConvertTo-Json -Compress
}
foreach ($case in @('no-approval','preflight-fail','ambiguous','wrong-arn','success')) {
    $global:Mode = $case; $global:Calls = 0; $global:CaseDir = Join-Path $Root $case
    $failed = $false
    try {
        if ($case -eq 'no-approval') { & (Join-Path $global:CaseDir 'START-APPROVED.ps1') }
        else { & (Join-Path $global:CaseDir 'START-APPROVED.ps1') -ApproveTransfer }
    } catch { $failed = $true }
    if ($failed -ne ($case -ne 'success')) { throw ('Unexpected result for ' + $case) }
    $expectedCalls = $(if ($case -in @('no-approval','preflight-fail')) { 0 } else { 1 })
    if ($global:Calls -ne $expectedCalls) { throw ('Unexpected network call count for ' + $case) }
    if ((Test-Path -LiteralPath (Join-Path $global:CaseDir 'TRANSFER-REQUEST.json')) -ne ($expectedCalls -eq 1)) { throw 'Incorrect persisted request state.' }
    if ((Test-Path -LiteralPath (Join-Path $global:CaseDir 'TRANSFER-RECEIPT.json')) -ne ($case -eq 'success')) { throw 'Incorrect persisted receipt state.' }
    if ($env:AWS_MAX_ATTEMPTS -ne '7') { throw 'Retry environment was not restored.' }
    if ($expectedCalls -eq 1) {
        $failed = $false
        try { & (Join-Path $global:CaseDir 'START-APPROVED.ps1') -ApproveTransfer } catch { $failed = $true }
        if ((-not $failed) -or ($global:Calls -ne 1)) { throw 'Repeated/ambiguous start was not blocked.' }
    }
}
Write-Host 'Five actual PS5 operator cases plus repeated-start rejection passed; only fake python/aws functions executed.'
`);
const check=spawnSync(process.env.POWERSHELL_PATH||'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(work,'test.ps1'),'-Root',work],{encoding:'utf8',windowsHide:true,timeout:30000});process.stdout.write((check.stdout||'')+(check.stderr||''));if(check.error)throw check.error;if(check.status!==0)throw new Error('Inspect '+work);console.log(work);
