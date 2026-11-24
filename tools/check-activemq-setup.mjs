/** Generated MQ scripts with local CLI/TLS/XML stubs only. No broker or messaging connection. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultValues } from '../src/kit/blueprint.ts';
import { AWS_ACTIVEMQ_SERVICE } from '../src/cloud/aws-activemq-service.ts';
import { WORK_TMP } from './work.mjs';
const work = mkdtempSync(join(WORK_TMP, 'activemq-setup-test-'));
const result = AWS_ACTIVEMQ_SERVICE.build({ ...defaultValues(AWS_ACTIVEMQ_SERVICE), aws_region: 'us-east-1', name: 'mock-active', version: '5.18', clients: 'sg-0123456789abcdef0', admins: 'sg-0123456789abcdef1', subnets: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1', protocols: 'OPENWIRE,STOMP', topics: 'events' });
if (result.findings.length) throw new Error('Invalid ActiveMQ fixture.');
for (const name of ['PREFLIGHT.ps1','LOG-RETENTION.ps1','CHECK-TLS.py','BROKER-CONFIG.xml']) writeFileSync(join(work, name), result.files[name]);
writeFileSync(join(work, 'harness.ps1'), String.raw`$ErrorActionPreference = 'Stop'
function global:aws {
  $request = @($args); $global:LASTEXITCODE = 0; $global:requests++
  if ($global:case -eq 'api') { $global:LASTEXITCODE = 1; return '{}' }
  if ($request[0] -ne 'mq' -or $request -notcontains 'ACTIVEMQ' -or $request -notcontains 'us-east-1') { throw 'Unexpected metadata query.' }
  $second = [Array]::IndexOf($request, '--next-token') -ge 0
  if ($request[1] -eq 'describe-broker-engine-types') {
    $response = @{ BrokerEngineTypes = @(@{ EngineType = 'ACTIVEMQ'; EngineVersions = @(@{ Name = $(if ($global:case -eq 'version' -or ($global:case -eq 'pagination' -and -not $second)) { '0.0' } else { '5.18' }) }) }) }
  } elseif ($request[1] -eq 'describe-broker-instance-options') {
    if ($request -notcontains 'EFS') { throw 'Missing storage offering filter.' }
    $response = @{ BrokerInstanceOptions = @(@{ EngineType = 'ACTIVEMQ'; HostInstanceType = $(if ($global:case -eq 'type') { 'mq.other.large' } else { 'mq.m5.large' }); SupportedEngineVersions = @('5.18'); SupportedDeploymentModes = @($(if ($global:case -eq 'mode' -or ($global:case -eq 'pagination' -and -not $second)) { 'SINGLE_INSTANCE' } else { 'ACTIVE_STANDBY_MULTI_AZ' })) }) }
  } else { throw 'Unexpected metadata operation.' }
  if ($global:case -eq 'pagination' -and -not $second) { $response.NextToken = 'second-page' }
  $response | ConvertTo-Json -Depth 8 -Compress
}
foreach ($scenario in @('valid','pagination','version','mode','type','api')) {
  $global:case = $scenario; $global:requests = 0; $failure = $null
  try { $null = & (Join-Path $PSScriptRoot 'PREFLIGHT.ps1') 6>$null } catch { $failure = $_.Exception.Message }
  if ($scenario -in @('valid','pagination')) {
    if ($failure) { throw ('Valid metadata rejected: ' + $failure) }
    $expected = if ($scenario -eq 'pagination') { 4 } else { 2 }
    if ($global:requests -ne $expected) { throw 'Skipped or duplicated metadata pages.' }
  } elseif (-not $failure) { throw ('Unsupported metadata accepted: ' + $scenario) }
}
Write-Output 'Passed six ActiveMQ metadata cases, including pagination.'
function global:terraform {
  if (($args -join ' ') -ne 'output -json mq_job') { throw 'Unexpected state query.' }
  $global:LASTEXITCODE = 0
  @{ name = 'mock-active'; region = 'us-east-1'; account = '123456789012'; id = 'b-mock'; arn = 'mock-broker' } | ConvertTo-Json -Compress
}
function global:aws {
  $request = @($args); $global:LASTEXITCODE = 0
  if ($request[0] -eq 'sts') { @{ Account = $(if ($global:case -eq 'account') { '000000000000' } else { '123456789012' }) } | ConvertTo-Json -Compress; return }
  if ($request -notcontains 'us-east-1') { throw 'Unscoped regional request.' }
  if ($request[0] -eq 'mq') {
    if ($request[1] -ne 'describe-broker' -or $request -notcontains 'b-mock') { throw 'Unexpected broker query.' }
    @{ BrokerArn = $(if ($global:case -eq 'broker') { 'other-broker' } else { 'mock-broker' }); BrokerName = 'mock-active'; EngineType = 'ACTIVEMQ' } | ConvertTo-Json -Compress; return
  }
  if ($request[0] -ne 'logs') { throw 'Unexpected AWS service.' }
  $parameter = if ($request[1] -eq 'describe-log-groups') { '--log-group-name-prefix' } else { '--log-group-name' }
  $index = [Array]::IndexOf($request, $parameter); $name = $request[$index + 1]
  if ($name -notin @('/aws/amazonmq/broker/b-mock/general','/aws/amazonmq/broker/b-mock/audit')) { throw 'Out-of-scope log group.' }
  if ($request[1] -eq 'describe-log-groups') {
    $groups = @(@{ logGroupName = $name; retentionInDays = 365 }, @{ logGroupName = $name + '-unrelated'; retentionInDays = 7 })
    if (($global:case -eq 'missing' -and $name.EndsWith('/audit')) -or $global:case -eq 'prefix-only') { $groups = @($groups[1]) }
    @{ logGroups = $groups } | ConvertTo-Json -Depth 5 -Compress; return
  }
  if ($request[1] -ne 'put-retention-policy' -or $request -notcontains '90') { throw 'Unexpected retention operation.' }
  $global:writes++
  if ($global:case -eq 'partial' -and $name.EndsWith('/audit')) { $global:LASTEXITCODE = 1 }
  '{}'
}
foreach ($scenario in @('inspect','apply','account','broker','missing','prefix-only','partial')) {
  $global:case = $scenario; $global:writes = 0; $failure = $null
  try { if ($scenario -eq 'inspect') { $null = & (Join-Path $PSScriptRoot 'LOG-RETENTION.ps1') 6>$null } else { $null = & (Join-Path $PSScriptRoot 'LOG-RETENTION.ps1') -Apply 6>$null } } catch { $failure = $_.Exception.Message }
  if ($scenario -in @('inspect','apply')) { if ($failure) { throw ('Valid retention case failed: ' + $failure) } } elseif (-not $failure) { throw ('Unsafe retention accepted: ' + $scenario) }
  if ($global:writes -ne $(if ($scenario -in @('apply','partial')) { 2 } else { 0 })) { throw 'Unexpected retention write count.' }
}
Write-Output 'Passed seven retention cases; no actual AWS commands executed.'
`);
writeFileSync(join(work, 'harness.py'), String.raw`import contextlib, io, json, pathlib, runpy, socket, ssl, subprocess, xml.etree.ElementTree as ET
root = pathlib.Path(__file__).resolve().parent
tree = ET.parse(root / "BROKER-CONFIG.xml").getroot()
ns = {"a":"http://activemq.apache.org/schema/core"}
assert tree.attrib["advisorySupport"] == "false"
assert tree.find("a:destinations/a:queue",ns).attrib["physicalName"] == "application.jobs"
assert tree.find("a:destinations/a:topic",ns).attrib["physicalName"] == "application.events"
temporary = tree.find(".//a:tempDestinationAuthorizationEntry/a:tempDestinationAuthorizationEntry",ns)
assert temporary is not None and set(temporary.attrib.values()) == {"broker-admins"}
for entry in tree.findall(".//a:authorizationEntry",ns):
    assert entry.attrib["admin"] == "broker-admins"
    if entry.attrib.get("queue") == ">" or entry.attrib.get("topic") == ">":
        assert entry.attrib["read"] == "broker-admins" and entry.attrib["write"] == "broker-admins"
    else: assert entry.attrib.get("queue",entry.attrib.get("topic")) == "application.>"
def state(arguments, **kwargs):
    assert arguments == ["terraform","output","-json","broker_endpoints"]
    return json.dumps(["ssl://standby.example:61617","ssl://active.example:61617","stomp+ssl://standby.example:61614","stomp+ssl://active.example:61614"] if scenario != "insecure" else ["tcp://active.example:61616"])
subprocess.check_output = state
class Connection:
    def __init__(self, host, port): self.host, self.port = host, port
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def version(self): return "TLSv1.3"
def connect(address, timeout):
    assert timeout == 10 and address[1] in [61617,61614]
    if scenario == "failover" and address[0] == "standby.example": raise OSError("standby unavailable")
    calls.append(address)
    return Connection(*address)
socket.create_connection = connect
class Context:
    check_hostname = True
    verify_mode = ssl.CERT_REQUIRED
    minimum_version = None
    def wrap_socket(self, raw, server_hostname):
        assert self.check_hostname and self.verify_mode == ssl.CERT_REQUIRED
        assert self.minimum_version == ssl.TLSVersion.TLSv1_2 and server_hostname == raw.host
        if scenario == "certificate" or (scenario == "one-port" and raw.port == 61614): raise ssl.SSLCertVerificationError("mock untrusted certificate")
        return raw
ssl.create_default_context = lambda: Context()
compile((root / "CHECK-TLS.py").read_text(encoding="utf-8"), "CHECK-TLS.py", "exec")
for scenario in ["valid","failover","certificate","one-port","insecure"]:
    calls, failure = [], None
    with contextlib.redirect_stdout(io.StringIO()):
        try: runpy.run_path(str(root / "CHECK-TLS.py"), run_name="__main__")
        except Exception as error: failure = error
    assert bool(failure) == (scenario not in ["valid","failover"]), (scenario,failure)
    if scenario in ["valid","failover"]: assert {port for _,port in calls} == {61617,61614}
    if scenario == "insecure": assert calls == []
print("XML authorization and five local TLS/failover cases passed; no sockets, broker login or messages.")
`);
const powershell = process.env.POWERSHELL_PATH || join(process.env.SystemRoot || 'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
for (const [executable,args] of [[powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(work,'harness.ps1')]],[process.env.PYTHON_PATH || 'python',[join(work,'harness.py')]]]) {
  const check = spawnSync(executable,args,{ cwd:work,encoding:'utf8',timeout:60000,windowsHide:true });
  if (check.stdout) process.stdout.write(check.stdout);
  if (check.stderr) process.stderr.write(check.stderr);
  if (check.error) throw check.error;
  if (check.status !== 0) throw new Error('ActiveMQ generated checks failed: ' + work);
}
console.log('Mock artifacts: ' + work);
