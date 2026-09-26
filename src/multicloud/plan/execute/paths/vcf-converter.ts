/**
 * vCenter Converter (addendum A.3.4 / A.6.1, WP-11b): physical machines,
 * other hypervisors and cloud VMs into VCF, as a running guest converted
 * like a physical machine.
 *
 * vCenter Converter Standalone 9.0 runs on a Windows server; its automation
 * interface is the Converter SDK (Python support added in 9.0), and no
 * command line for 9.0 is documented. The kit therefore does not submit the
 * conversion itself: it writes one job sheet per VM and automates everything
 * around it on the vCenter side.
 *
 *   paths/vcf-converter/converter.ps1   the verbs
 *   paths/vcf-converter/jobs/<item>.json  what to enter in the Converter job
 *   paths/vcf-converter/README.md
 *
 *   prepare       the destination cluster, datastore (1.1 × the disks), folder
 *                 and port groups exist; the Converter server answers on 443
 *   replicate     the converted VM exists on the destination: in sync; else
 *                 the operator step (skipped, naming the job sheet)
 *   test          boot the converted VM with its NICs disconnected, wait for
 *                 VMware Tools, shut it down (test-cleanup powers it off)
 *   cutover       connect the NICs and start the converted VM (the final
 *                 synchronisation and the source power-off are before it)
 *   rollback      shut the converted VM down and disconnect its NICs; the
 *                 source was only read, so it is started again as it was
 *
 * Release notes: https://techdocs.broadcom.com/us/en/vmware-cis/vsphere/vcenter-converter/9-0/release-notes-conv/vmware-vcenter-converter-standalone-90-release-notes.html
 */

import { info, type Finding } from '../../../../core/findings.ts';
import type { ExecPath } from '../contract.ts';
import { code } from '../lib-sh.ts';
import { psScript } from '../lib-ps.ts';
import type { ManifestItem } from '../manifest.ts';
import type { PathContext, PathGenerator } from '../registry.ts';
import { POWERCLI_NEED, PS_VSPHERE_HELPERS } from './xvc.ts';

export const CONVERTER_SOURCE = 'https://techdocs.broadcom.com/us/en/vmware-cis/vsphere/vcenter-converter/9-0/release-notes-conv/vmware-vcenter-converter-standalone-90-release-notes.html';
export const CONVERTER_FILE = 'paths/vcf-converter/converter.ps1';
const PATHS: readonly ExecPath[] = ['vcf-converter'];

export const jobFile = (i: ManifestItem): string => `paths/vcf-converter/jobs/${i.resource}.json`;

export interface ConverterJob {
  readonly kind: 'archtoolkit.converter-job';
  readonly v: 1;
  readonly item: string;
  readonly name: string;
  readonly source: { readonly platform: string; readonly address: string | null; readonly os: string | null; readonly type: 'powered-on machine' };
  readonly destination: {
    readonly vcenter: 'VC_DST';
    readonly vmName: string;
    readonly cluster: string | null;
    readonly datastore: string | null;
    readonly folder: string | null;
    readonly diskProvisioning: 'thin';
    readonly vcpu: number | null;
    readonly ramGib: number | null;
    readonly networks: readonly { readonly from: string; readonly to: string }[];
    readonly powerOnAfter: false;
    readonly nicsConnectedAtPowerOn: false;
  };
  readonly synchronize: boolean;
  readonly note: string;
}

export function converterJob(i: ManifestItem, ctx: PathContext): ConverterJob {
  const hcx = ctx.settings.hcx;
  const windows = !!i.os && i.os.startsWith('win');
  return {
    kind: 'archtoolkit.converter-job',
    v: 1,
    item: i.id,
    name: i.name,
    source: { platform: i.source.platform, address: i.source.ips?.[0] ?? i.source.host ?? null, os: i.os ?? null, type: 'powered-on machine' },
    destination: {
      vcenter: 'VC_DST',
      vmName: i.name,
      cluster: hcx?.container ?? null,
      datastore: hcx?.datastore ?? null,
      folder: hcx?.folder ?? null,
      diskProvisioning: 'thin',
      vcpu: i.target.vcpu ?? null,
      ramGib: i.target.ramGib ?? null,
      networks: (hcx?.mappings ?? []).map((m) => ({ from: m.from, to: m.to })),
      powerOnAfter: false,
      nicsConnectedAtPowerOn: false,
    },
    synchronize: windows,
    note: windows
      ? 'Convert with "synchronize changes" so the final synchronisation at cutover copies only the delta; leave the VM powered off with its NICs disconnected at power-on (the kit connects them at cutover).'
      : 'Convert, then repeat the conversion (or run a final data copy) in the window; leave the VM powered off with its NICs disconnected at power-on (the kit connects them at cutover).',
  };
}

const FUNCTIONS = code`
${PS_VSPHERE_HELPERS.trim()}

function Get-ConverterJob {
  param($It)
  return (Read-AtkJson "jobs/$($It.resource).json")
}

function Get-ConverterProblems {
  param($Job, $Dst)
  $problems = @()
  $d = $Job.destination
  if (-not $d.cluster) { return @('no destination cluster: set the target container under Execute > Settings > HCX (the VMware placement)') }
  if (-not (Get-Cluster -Server $Dst -Name $d.cluster -ErrorAction SilentlyContinue)) { $problems += "the destination cluster $($d.cluster) does not exist" }
  if ($d.datastore) {
    $ds = Get-Datastore -Server $Dst -Name $d.datastore -ErrorAction SilentlyContinue | Select-Object -First 1
    $need = 0
    $it = Get-AtkItem -Id $Job.item
    foreach ($disk in @(Get-AtkProp $it.target 'disks')) { if ($disk) { $need += [double] $disk.gib } }
    if (-not $ds) { $problems += "the destination datastore $($d.datastore) does not exist" }
    elseif ($need -gt 0 -and [double] $ds.FreeSpaceGB -lt 1.1 * $need) { $problems += "datastore $($ds.Name) has $([math]::Round($ds.FreeSpaceGB)) GB free; the disks need 1.1 x $need GB" }
  } else { $problems += 'no destination datastore: set it under Execute > Settings > HCX' }
  if ($d.folder -and -not (Get-Folder -Server $Dst -Name $d.folder -Type VM -ErrorAction SilentlyContinue)) { $problems += "the destination VM folder $($d.folder) does not exist" }
  foreach ($n in @($d.networks)) { if (-not (Get-AtkPortGroup $Dst $n.to)) { $problems += "the destination port group $($n.to) does not exist" } }
  return $problems
}

function Wait-ConverterTools {
  param($Vm, $Dst)
  return (Wait-AtkUntil -Minutes 15 -IntervalSeconds 20 { [string] (Get-VM -Server $Dst -Id $Vm.Id).ExtensionData.Guest.ToolsRunningStatus -eq 'guestToolsRunning' })
}

function Stop-ConverterVm {
  param($Vm, $Dst)
  if ((Get-VM -Server $Dst -Id $Vm.Id).PowerState -ne 'PoweredOn') { return }
  Invoke-AtkStep "shut down $($Vm.Name) (guest shutdown)" { $null = Stop-VMGuest -VM $Vm -Confirm:$false }
  $null = Wait-AtkUntil -Minutes 10 -IntervalSeconds 15 { (Get-VM -Server $Dst -Id $Vm.Id).PowerState -eq 'PoweredOff' }
  if ((Get-VM -Server $Dst -Id $Vm.Id).PowerState -ne 'PoweredOff') { Invoke-AtkStep "power off $($Vm.Name)" { $null = Stop-VM -VM $Vm -Confirm:$false } }
}
`;

const OPERATOR = 'operator step: run the conversion in vCenter Converter with the job sheet paths/vcf-converter/jobs/$($it.resource).json (the kit does not drive the Converter SDK), then run replicate again';

const VERBS = {
  prepare: code`
$it = Get-AtkItem -Id $Id
$dst = Connect-AtkVc DST
$job = Get-ConverterJob $it
$problems = @(Get-ConverterProblems $job $dst)
if ($env:CONVERTER_SERVER -and -not (Test-Connection -TargetName $env:CONVERTER_SERVER -TcpPort 443 -Quiet)) { $problems += "the Converter server $($env:CONVERTER_SERVER) does not answer on 443" }
if ($problems.Count) { Set-AtkOutcome failed ($problems -join '; '); return }
Set-AtkOutcome succeeded 'the destination is ready for the conversion' -State prepared`,
  replicate: code`
$it = Get-AtkItem -Id $Id
$vm = Find-AtkVm (Connect-AtkVc DST) $it.name
if ($vm) { Set-AtkOutcome succeeded 'converted: the VM is on the destination' -State 'in-sync' -Data @{ targetMoref = (Get-AtkMoRef $vm) }; return }
Set-AtkOutcome skipped "${OPERATOR}"`,
  test: code`
$it = Get-AtkItem -Id $Id
$dst = Connect-AtkVc DST
$vm = Find-AtkVm $dst $it.name
if (-not $vm) { Set-AtkOutcome failed 'not converted yet: nothing to test'; return }
if ($vm.PowerState -eq 'PoweredOn') { Set-AtkOutcome skipped 'already running' -State testing; return }
Invoke-AtkStep "disconnect the NICs of $($it.name) for the test boot" { $null = Get-NetworkAdapter -VM $vm | Set-NetworkAdapter -StartConnected:$false -Confirm:$false }
Invoke-AtkStep "boot $($it.name) isolated" { $null = Start-VM -VM $vm -Confirm:$false }
if ($DryRun) { Set-AtkOutcome succeeded 'dry run: the test boot was printed' -State testing; return }
if (-not (Wait-ConverterTools $vm $dst)) { Set-AtkOutcome failed 'the converted VM booted but VMware Tools did not start within 15 minutes'; return }
Set-AtkOutcome succeeded 'the converted VM boots and VMware Tools runs (NICs disconnected)' -State testing`,
  'test-cleanup': code`
$it = Get-AtkItem -Id $Id
$dst = Connect-AtkVc DST
$vm = Find-AtkVm $dst $it.name
if (-not $vm) { Set-AtkOutcome skipped 'no converted VM'; return }
Stop-ConverterVm $vm $dst
Set-AtkOutcome succeeded 'the test boot is shut down' -State tested`,
  cutover: code`
$it = Get-AtkItem -Id $Id
$dst = Connect-AtkVc DST
$vm = Find-AtkVm $dst $it.name
if (-not $vm) { Set-AtkOutcome failed 'not converted: run the conversion first'; return }
$nics = @(Get-NetworkAdapter -VM $vm)
if ($vm.PowerState -eq 'PoweredOn' -and -not ($nics | Where-Object { -not $_.ConnectionState.Connected })) { Set-AtkOutcome skipped 'already running with its NICs connected' -State 'cut-over' -Data @{ targetMoref = (Get-AtkMoRef $vm) }; return }
Invoke-AtkStep "connect the NICs of $($it.name) at power-on" { $null = $nics | Set-NetworkAdapter -StartConnected:$true -Confirm:$false }
if ($vm.PowerState -ne 'PoweredOn') { Invoke-AtkStep "start $($it.name)" { $null = Start-VM -VM $vm -Confirm:$false } }
Invoke-AtkStep "connect the NICs of $($it.name)" { $null = Get-NetworkAdapter -VM (Get-VM -Server $dst -Id $vm.Id) | Set-NetworkAdapter -Connected:$true -Confirm:$false }
if (-not $DryRun -and -not (Wait-ConverterTools $vm $dst)) { Set-AtkOutcome failed 'the VM started but VMware Tools did not start within 15 minutes'; return }
Set-AtkOutcome succeeded 'the converted VM runs on the network' -State 'cut-over' -Data @{ targetMoref = (Get-AtkMoRef $vm) }`,
  commit: `Set-AtkOutcome skipped 'nothing to commit: Converter keeps no replication'`,
  rollback: code`
$it = Get-AtkItem -Id $Id
$dst = Connect-AtkVc DST
$vm = Find-AtkVm $dst $it.name
if (-not $vm) { Set-AtkOutcome skipped 'no converted VM running'; return }
Stop-ConverterVm $vm $dst
Invoke-AtkStep "disconnect the NICs of $($it.name) at power-on" { $null = Get-NetworkAdapter -VM $vm | Set-NetworkAdapter -StartConnected:$false -Confirm:$false }
Set-AtkOutcome succeeded 'the converted VM is shut down and kept; the source was only read: start it again with its source adapter'`,
  finalize: `Set-AtkOutcome skipped 'nothing to tear down: decommission removes the source'`,
  status: code`
$it = Get-AtkItem -Id $Id
$vm = Find-AtkVm (Connect-AtkVc DST) $it.name
if (-not $vm) { Set-AtkOutcome skipped 'not converted yet'; return }
$state = if ($vm.PowerState -eq 'PoweredOn') { 'cut-over' } else { 'in-sync' }
Set-AtkOutcome succeeded "converted ($($vm.PowerState))" -State $state -Data @{ targetMoref = (Get-AtkMoRef $vm) }`,
};

export function renderConverterScript(): string {
  return psScript({
    file: CONVERTER_FILE,
    paths: PATHS,
    summary: 'vCenter Converter into VCF: the destination checks, a job sheet per VM, an isolated test boot, and the cutover of the converted VM.',
    modules: ['VMware.VimAutomation.Core'],
    functions: FUNCTIONS,
    verbs: VERBS,
  });
}

export function renderConverterReadme(items: readonly ManifestItem[]): string {
  return [
    '# vCenter Converter',
    '',
    `${items.length} machine(s) are converted into VCF with vCenter Converter Standalone 9.0, which takes a running Windows or Linux guest as a physical machine (physical servers, Hyper-V, KVM, Xen, cloud VMs).`,
    '',
    'Converter 9.0 is automated through its SDK (Python support is new in 9.0); no command line is documented for 9.0, so the kit does not submit the conversion. `jobs/<vm>.json` holds what to enter in each job; `converter.ps1` does everything around it on the vCenter side.',
    '',
    '## Order',
    '',
    '1. `converter.ps1 prepare`: the destination cluster, datastore, folder and port groups exist, and the Converter server answers (`CONVERTER_SERVER`).',
    '2. In vCenter Converter: one conversion job per job sheet. Destination vCenter `VC_DST`, thin disks, the VM left powered off, its NICs not connected at power-on. For Windows sources, turn on "synchronize changes".',
    '3. `converter.ps1 replicate` (or `status --once`): records the conversion once the VM is on the destination.',
    '4. `converter.ps1 test`: boots the VM with its NICs disconnected and waits for VMware Tools; `test-cleanup` shuts it down.',
    '5. In the window: stop the applications on the source, run the final synchronisation (Windows) or convert again, stop the source (the wave orchestrator does it with the source adapter), then `converter.ps1 cutover`: connects the NICs and starts the VM.',
    '6. `rollback`: shuts the converted VM down and disconnects its NICs; the source was only read, so starting it again is the way back.',
    '',
    '## Environment',
    '',
    '| Variable | What |',
    '|---|---|',
    '| `VC_DST`, `VC_DST_USER`, `VC_DST_PASSWORD` | the destination vCenter |',
    '| `CONVERTER_SERVER` | the vCenter Converter server (checked on port 443) |',
    '',
    `Source: ${CONVERTER_SOURCE}`,
    '',
  ].join('\n');
}

export const VCF_CONVERTER_GENERATOR: PathGenerator = Object.freeze({
  id: 'vcf-converter',
  owner: 'WP-11b' as const,
  paths: PATHS,
  needs: [POWERCLI_NEED],
  entry: () => CONVERTER_FILE,
  files(items: readonly ManifestItem[], ctx: PathContext): Readonly<Record<string, string>> {
    const out: Record<string, string> = {
      [CONVERTER_FILE]: renderConverterScript(),
      'paths/vcf-converter/README.md': renderConverterReadme(items),
    };
    for (const i of items) out[jobFile(i)] = `${JSON.stringify(converterJob(i, ctx), null, 2)}\n`;
    return out;
  },
  findings(items: readonly ManifestItem[]): readonly Finding[] {
    return [info('exec.converter.operator-step', `${items.length} machine(s) move with vCenter Converter: the conversion itself is an operator step (job sheets in paths/vcf-converter/jobs/), because Converter 9.0 documents no command line; the kit checks, tests and cuts over around it.`, { source: CONVERTER_SOURCE })];
  },
});

export const GENERATORS: readonly PathGenerator[] = Object.freeze([VCF_CONVERTER_GENERATOR]);
