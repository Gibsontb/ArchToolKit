/**
 * Runs every source adapter (A.3.3) against mock platform CLIs: the verbs
 * reach the right calls, read the state first (skipping what is already
 * done), print instead of changing under --dry-run, and write status events.
 * Bash adapters need bash and jq; the PowerShell ones need pwsh.
 */
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from '../../../testing/expect.ts';
import type { SourcePlatform } from '../types.ts';
import { renderSourceAdapter } from './adapters.ts';
import { renderLibSh } from '../execute/lib-sh.ts';
import { renderLibPs } from '../execute/lib-ps.ts';
import { renderItemsJson, renderItemsTsv, type Manifest } from '../execute/manifest.ts';

const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;
const hasJq = hasBash && spawnSync('bash', ['-c', 'command -v jq']).status === 0;
const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0;
const SEP = process.platform === 'win32' ? ';' : ':';

interface Kit { dir: string; kit: string; log: string; script: string }

/** A kit with the core library, one item's manifest (JSON and TSV) and the adapter, as `<dir>/migration/execute/`. */
function kit(platform: SourcePlatform, source: Record<string, string>, mocks: Record<string, string>): Kit {
  const dir = mkdtempSync(join(tmpdir(), `atk-ad-${platform}-`));
  const k = join(dir, 'migration', 'execute');
  mkdirSync(join(k, 'source'), { recursive: true });
  mkdirSync(join(k, 'manifest'));
  mkdirSync(join(k, 'lib'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(k, 'lib', 'atk.sh'), renderLibSh());
  writeFileSync(join(k, 'lib', 'Atk.psm1'), renderLibPs());
  const item = {
    id: 'w:app01', name: 'app01', kind: 'workload', app: 'crm', wave: 2, path: 'aws-mgn', method: 'replicate', script: 'paths/aws-mgn/mgn.sh',
    resource: 'atk-01234567-2-app01', source: { platform, ...source }, target: {}, dns: [], lb: [], services: [], checks: [],
  };
  const manifest = { kind: 'archtoolkit.migration-manifest', v: 1, planId: '0123456789abcdef', planId8: '01234567', items: [item], waves: [] };
  writeFileSync(join(k, 'manifest', 'items.json'), renderItemsJson(manifest as unknown as Manifest));
  writeFileSync(join(k, 'manifest', 'items.tsv'), renderItemsTsv(manifest as unknown as Manifest));
  const log = join(dir, 'calls.log');
  for (const [name, body] of Object.entries(mocks)) {
    writeFileSync(join(dir, 'bin', name), `#!/usr/bin/env bash\necho "${name} $*" >> "$MOCKLOG"\n${body}`);
    chmodSync(join(dir, 'bin', name), 0o755);
  }
  const { path, content } = renderSourceAdapter(platform);
  const script = join(k, path);
  writeFileSync(script, content);
  return { dir, kit: k, log, script };
}

function run(k: Kit, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [k.script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(k.dir, 'bin')}${SEP}${process.env.PATH}`, MOCKLOG: k.log, ...env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
const calls = (k: Kit): string[] => (existsSync(k.log) ? readFileSync(k.log, 'utf8').trim().split('\n').filter((l) => l !== '') : []);
const events = (k: Kit): [string, string, boolean][] => {
  const f = join(k.dir, 'status', 'events.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { step: string; outcome: string; dryRun: boolean }).map((e) => [e.step, e.outcome, e.dryRun]);
};
const done = (k: Kit): void => rmSync(k.dir, { recursive: true, force: true });

describe('bash source adapters against mocks', { skip: !hasJq }, () => {
  it('kvm.sh: stop (graceful), snapshot once, dry-run delete, rename needs shut off', () => {
    const k = kit('kvm', { host: 'kvm01', id: 'app01' }, {
      ssh: String.raw`shift 2; case "$*" in *domstate*) cat "$STATE" ;; *snapshot-list*) printf 'atk-01234567-2-app01\n' ;; *shutdown*) echo 'shut off' > "$STATE" ;; *) : ;; esac`,
    });
    const state = join(k.dir, 'state');
    writeFileSync(state, 'running\n');
    const env = { STATE: state };
    expect(run(k, ['state', '--item', 'app01'], env).stdout).toBe('app01\trunning\n');
    expect(run(k, ['stop', '--item', 'app01'], env).status).toBe(0);
    expect(calls(k).some((c) => c.includes('virsh -c qemu:///system shutdown app01'))).toBe(true);
    expect(run(k, ['stop', '--item', 'app01'], env).status).toBe(0);
    expect(run(k, ['snapshot', '--item', 'app01'], env).status).toBe(0);
    expect(calls(k).some((c) => c.includes('snapshot-create-as'))).toBe(false);
    const del = run(k, ['delete', '--item', 'w:app01', '--dry-run'], env);
    expect(del.status).toBe(0);
    expect(del.stderr).toContain('undefine app01 --remove-all-storage --nvram');
    expect(calls(k).some((c) => c.includes('undefine'))).toBe(false);
    expect(events(k)).toEqual([
      ['stop-source', 'started', false], ['stop-source', 'succeeded', false],
      ['stop-source', 'started', false], ['stop-source', 'skipped', false],
      ['freeze', 'started', false], ['freeze', 'skipped', false],
      ['decommission', 'started', true], ['decommission', 'succeeded', true],
    ]);
    done(k);
  });

  it('proxmox.sh: finds the type, shuts down, snapshots with a Proxmox-safe name', () => {
    const k = kit('proxmox', { host: 'pve1', id: '101' }, {
      ssh: String.raw`shift 2; case "$*" in
        *cluster/resources*) echo '[{"vmid":101,"type":"qemu","node":"pve1"}]' ;;
        *status/current*) cat "$STATE" ;;
        *status/shutdown*) echo '{"status":"stopped"}' > "$STATE" ;;
        *snapshot\ --snapname*) : ;;
        *snapshot*) echo '[{"name":"current"}]' ;;
        *) : ;; esac`,
    });
    const state = join(k.dir, 'state');
    writeFileSync(state, '{"status":"running"}');
    expect(run(k, ['stop', '--item', 'app01'], { STATE: state }).status).toBe(0);
    expect(calls(k).some((c) => c.includes('pvesh create /nodes/pve1/qemu/101/status/shutdown'))).toBe(true);
    expect(run(k, ['snapshot', '--item', 'app01'], { STATE: state }).status).toBe(0);
    expect(calls(k).some((c) => c.includes('--snapname atk_01234567_2_app01'))).toBe(true);
    expect(run(k, ['rename', '--item', 'app01', '--new-name', 'app01-old'], { STATE: state }).status).toBe(0);
    expect(calls(k).some((c) => c.includes('pvesh set /nodes/pve1/qemu/101/config --name app01-old'))).toBe(true);
    done(k);
  });

  it('xen.sh: clean shutdown, snapshot, uninstall', () => {
    const k = kit('xen', { id: 'u1' }, {
      xe: String.raw`case "$*" in *power-state*) cat "$STATE" ;; *vm-shutdown*) echo halted > "$STATE" ;; *snapshot-list*) echo '' ;; *param-name=uuid*) echo u1 ;; *) : ;; esac`,
      timeout: String.raw`shift; "$@"`,
    });
    const state = join(k.dir, 'state');
    writeFileSync(state, 'running\n');
    expect(run(k, ['stop', '--item', 'app01'], { STATE: state }).status).toBe(0);
    expect(run(k, ['snapshot', '--item', 'app01'], { STATE: state }).status).toBe(0);
    expect(run(k, ['delete', '--item', 'app01'], { STATE: state }).status).toBe(0);
    const c = calls(k);
    expect(c.some((x) => x === 'xe vm-shutdown uuid=u1')).toBe(true);
    expect(c.some((x) => x === 'xe vm-snapshot uuid=u1 new-name-label=atk-01234567-2-app01')).toBe(true);
    expect(c.some((x) => x === 'xe vm-uninstall uuid=u1 force=true')).toBe(true);
    done(k);
  });

  it('ovirt.sh: REST calls with the credentials on stdin, never in arguments', () => {
    const k = kit('ovirt', { id: 'vm-9', manager: 'engine.corp.example' }, {
      curl: String.raw`cat > "$MOCKLOG.stdin"; for url; do :; done
        case "$*" in *-X\ GET*/vms/vm-9/snapshots) echo '{"snapshot":[]}' ;; *-X\ GET*) cat "$STATE" ;; *shutdown*) echo '{"status":"down"}' > "$STATE" ;; *) echo '{}' ;; esac`,
    });
    const state = join(k.dir, 'state');
    writeFileSync(state, '{"status":"up"}');
    const env = { STATE: state, OVIRT_USER: 'admin@internal', OVIRT_PASSWORD: 'S3cret' };
    expect(run(k, ['stop', '--item', 'app01'], env).status).toBe(0);
    expect(run(k, ['snapshot', '--item', 'app01'], env).status).toBe(0);
    const c = calls(k);
    expect(c.some((x) => x.includes('-X POST') && x.includes('/ovirt-engine/api/vms/vm-9/shutdown'))).toBe(true);
    expect(c.some((x) => x.includes('/vms/vm-9/snapshots') && x.includes('atk-01234567-2-app01'))).toBe(true);
    expect(c.join('\n').includes('S3cret')).toBe(false);
    expect(readFileSync(`${k.log}.stdin`, 'utf8')).toContain('S3cret');
    done(k);
  });

  it('ahv.sh: v4 actions carry the ETag and a request id', () => {
    const k = kit('ahv', { id: 'vm-1', manager: 'pc01' }, {
      curl: String.raw`cat >/dev/null; hdr=""; prev=""; for a; do [ "$prev" = -D ] && hdr="$a"; prev="$a"; done
        [ -n "$hdr" ] && printf 'HTTP/1.1 200 OK\r\nETag: "e-42"\r\n\r\n' > "$hdr"
        case "$*" in *-X\ GET*) cat "$STATE" ;; *power-on*) echo '{"data":{"powerState":"ON"}}' > "$STATE" ;; *) echo '{}' ;; esac`,
    });
    const state = join(k.dir, 'state');
    writeFileSync(state, '{"data":{"powerState":"OFF"}}');
    expect(run(k, ['start', '--item', 'app01'], { STATE: state, PRISM_USER: 'svc', PRISM_PASSWORD: 'pw' }).status).toBe(0);
    const post = calls(k).find((x) => x.includes('-X POST'))!;
    expect(post).toContain('If-Match: "e-42"');
    expect(post).toContain('NTNX-Request-Id:');
    expect(post).toContain('/api/vmm/v4.1/ahv/config/vms/vm-1/$actions/power-on');
    expect(run(k, ['start', '--item', 'app01'], { STATE: state, PRISM_USER: 'svc', PRISM_PASSWORD: 'pw' }).status).toBe(0);
    expect(events(k).map((e) => e[1])).toEqual(['started', 'succeeded', 'started', 'skipped']);
    done(k);
  });

  it('physical.sh: stop in the guest, start through Redfish, delete is an operator step', () => {
    const k = kit('physical', { bmc: 'bmc01.corp.example' }, {
      curl: String.raw`cat >/dev/null; for url; do :; done; case "$url" in */Systems) echo '{"Members":[{"@odata.id":"/redfish/v1/Systems/1"}]}' ;; *) cat "$STATE" ;; esac`,
      ansible: String.raw`case "$*" in *setup*) echo 'app01 | SUCCESS => {"ansible_facts": {"ansible_os_family": "RedHat"}}' ;; *redfish_command*) echo '{"PowerState":"On"}' > "$STATE"; env | grep -c '^BMC_PASSWORD=' >> "$MOCKLOG" ;; *shutdown*) echo '{"PowerState":"Off"}' > "$STATE" ;; esac`,
    });
    const state = join(k.dir, 'state');
    writeFileSync(state, '{"PowerState":"On"}');
    const env = { STATE: state, BMC_USER: 'root', BMC_PASSWORD: 'Bmc!pw' };
    expect(run(k, ['stop', '--item', 'app01'], env).status).toBe(0);
    expect(calls(k).some((c) => c.includes('ansible.builtin.command -a shutdown -h +1'))).toBe(true);
    expect(run(k, ['start', '--item', 'app01'], env).status).toBe(0);
    const c = calls(k);
    expect(c.some((x) => x.includes('community.general.redfish_command'))).toBe(true);
    expect(c.includes('1')).toBe(true); // the password reached Ansible in the environment
    expect(c.join('\n').includes('Bmc!pw')).toBe(false);
    expect(run(k, ['delete', '--item', 'app01'], env).status).toBe(0);
    expect(events(k).slice(-1)[0]).toEqual(['decommission', 'skipped', false]);
    done(k);
  });

  it('aws.sh: stop and wait, snapshot once, terminate reports surviving volumes', () => {
    const k = kit('aws', { id: 'i-0abc', region: 'eu-west-1' }, {
      aws: String.raw`case "$*" in
        *describe-instances*) printf '{"Reservations":[{"Instances":[{"State":{"Name":"%s"},"BlockDeviceMappings":[{"Ebs":{"VolumeId":"vol-1","DeleteOnTermination":true}},{"Ebs":{"VolumeId":"vol-2","DeleteOnTermination":false}}]}]}]}' "$(cat "$STATE")" ;;
        *stop-instances*) echo stopped > "$STATE"; echo '{}' ;;
        *describe-snapshots*) echo '{"Snapshots":[]}' ;;
        *) echo '{}' ;; esac`,
    });
    const state = join(k.dir, 'state');
    writeFileSync(state, 'running');
    expect(run(k, ['stop', '--item', 'app01'], { STATE: state }).status).toBe(0);
    expect(run(k, ['snapshot', '--item', 'app01'], { STATE: state }).status).toBe(0);
    const del = run(k, ['delete', '--item', 'app01'], { STATE: state });
    expect(del.status).toBe(0);
    expect(del.stderr).toContain('vol-2');
    const c = calls(k);
    expect(c.some((x) => x.includes('ec2 stop-instances --instance-ids i-0abc'))).toBe(true);
    expect(c.some((x) => x.includes('create-snapshots') && x.includes('Value=atk-01234567-2-app01'))).toBe(true);
    expect(c.some((x) => x.includes('terminate-instances --instance-ids i-0abc'))).toBe(true);
    done(k);
  });

  it('gcp.sh: stop, snapshot each disk, delete with its disks', () => {
    const k = kit('google', { manager: 'acme-prod', cluster: 'europe-west2-a' }, {
      gcloud: String.raw`case "$*" in
        *instances\ describe*disks*) echo 'app01-boot;app01-data' ;;
        *instances\ describe*status*) cat "$STATE" ;;
        *instances\ describe*) echo '{}' ;;
        *snapshots\ describe*) exit 1 ;;
        *instances\ stop*) echo TERMINATED > "$STATE" ;;
        *) : ;; esac`,
    });
    const state = join(k.dir, 'state');
    writeFileSync(state, 'RUNNING');
    expect(run(k, ['stop', '--item', 'app01'], { STATE: state }).status).toBe(0);
    expect(run(k, ['snapshot', '--item', 'app01'], { STATE: state }).status).toBe(0);
    expect(run(k, ['delete', '--item', 'app01'], { STATE: state }).status).toBe(0);
    const c = calls(k);
    expect(c.some((x) => x.includes('compute instances stop app01 --zone europe-west2-a'))).toBe(true);
    expect(c.filter((x) => x.includes('snapshots create')).length).toBe(2);
    expect(c.some((x) => x.includes('instances delete app01 --delete-disks=all'))).toBe(true);
    done(k);
  });

  it('oci.sh: soft stop, backups, terminate', () => {
    const k = kit('oci', { id: 'ocid1.instance.1', region: 'uk-london-1' }, {
      oci: String.raw`case "$*" in
        *instance\ get*) printf '{"data":{"lifecycle-state":"%s","compartment-id":"c1","availability-domain":"AD-1"}}' "$(cat "$STATE")" ;;
        *action*SOFTSTOP*) echo STOPPED > "$STATE"; echo '{}' ;;
        *boot-volume-backup\ list*) echo '{"data":[]}' ;;
        *boot-volume-attachment\ list*) echo '{"data":[{"boot-volume-id":"bv1"}]}' ;;
        *volume-attachment\ list*) echo '{"data":[{"volume-id":"v1","lifecycle-state":"ATTACHED"}]}' ;;
        *) echo '{}' ;; esac`,
    });
    const state = join(k.dir, 'state');
    writeFileSync(state, 'RUNNING');
    expect(run(k, ['stop', '--item', 'app01'], { STATE: state }).status).toBe(0);
    expect(run(k, ['snapshot', '--item', 'app01'], { STATE: state }).status).toBe(0);
    expect(run(k, ['delete', '--item', 'app01'], { STATE: state }).status).toBe(0);
    const c = calls(k);
    expect(c.some((x) => x.includes('--action SOFTSTOP'))).toBe(true);
    expect(c.some((x) => x.includes('boot-volume-backup create --boot-volume-id bv1'))).toBe(true);
    expect(c.some((x) => x.includes('bv backup create --volume-id v1'))).toBe(true);
    expect(c.some((x) => x.includes('instance terminate --instance-id ocid1.instance.1 --preserve-boot-volume false'))).toBe(true);
    done(k);
  });

  it('operator.sh: every verb is an operator step; bad usage and unknown items exit 2; --wave serves its platforms', () => {
    const k = kit('power', {}, {});
    expect(run(k, ['stop', '--item', 'app01']).status).toBe(0);
    expect(events(k)).toEqual([['stop-source', 'started', false], ['stop-source', 'skipped', false]]);
    expect(run(k, ['reboot', '--item', 'app01']).status).toBe(2);
    expect(run(k, ['stop', '--item', 'nope']).status).toBe(2);
    expect(run(k, ['stop', '--wave', '2']).status).toBe(0);
    expect(events(k).length).toBe(4);
    done(k);
  });

  it('the WP-12 call: --wave, --step and --path land in the events; state prints name<TAB>state and writes none', () => {
    const k = kit('aws', { id: 'i-0abc', region: 'eu-west-1' }, {
      aws: String.raw`case "$*" in *describe-instances*) echo '{"Reservations":[{"Instances":[{"State":{"Name":"stopped"}}]}]}' ;; *) echo '{}' ;; esac`,
    });
    expect(run(k, ['state', '--item', 'w:app01', '--wave', '2', '--step', 'precheck', '--path', 'aws-mgn']).stdout).toBe('app01\tstopped\n');
    expect(events(k)).toEqual([]);
    expect(run(k, ['stop', '--item', 'w:app01', '--wave', '2', '--step', 'stop-source', '--path', 'aws-mgn', '--timeout', '1']).status).toBe(0);
    const e = readFileSync(join(k.dir, 'status', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(e.map((x) => [x.path, x.step, x.outcome, x.wave, x.planId, x.item])).toEqual([
      ['aws-mgn', 'stop-source', 'started', 2, '0123456789abcdef', 'w:app01'],
      ['aws-mgn', 'stop-source', 'skipped', 2, '0123456789abcdef', 'w:app01'],
    ]);
    done(k);
  });
});

describe('PowerShell source adapters against mocked cmdlets', { skip: !hasPwsh }, () => {
  function ps(platform: SourcePlatform, source: Record<string, string>, mocks: string, args: string): { calls: string[]; events: [string, string, boolean][]; out: string; code: number | null } {
    const k = kit(platform, source, {});
    const r = spawnSync('pwsh', ['-NoProfile', '-Command', `$global:calls = [System.Collections.Generic.List[string]]::new()\n${mocks}\n& '${k.script}' ${args}\n$code = $LASTEXITCODE\n'CALLS:' + ($global:calls -join '|')\nexit $code`], { encoding: 'utf8' });
    const line = r.stdout.split(/\r?\n/).find((l: string) => l.startsWith('CALLS:')) ?? 'CALLS:';
    const out = { calls: line.slice(6).split('|').filter((c: string) => c !== ''), events: events(k), out: r.stdout + r.stderr, code: r.status };
    done(k);
    return out;
  }
  const VSPHERE = `
    function global:Get-Module { param([switch]$ListAvailable, $Name) [pscustomobject]@{ Name = 'VCF.PowerCLI' } }
    function global:Connect-VIServer { param($Server, $Credential) $global:calls.Add("connect $Server"); 'conn' }
    $global:vm = [pscustomobject]@{ Name = 'app01'; PowerState = 'PoweredOn' }
    function global:Get-VM { param($Server, $Id, $Name) $global:calls.Add("get $Id"); $global:vm }
    function global:Stop-VMGuest { param($VM, [switch]$Confirm) $global:calls.Add('Stop-VMGuest'); $global:vm.PowerState = 'PoweredOff' }
    function global:Get-Snapshot { param($VM, $Name) $null }
    function global:New-Snapshot { param($VM, $Name, $Description, $Memory, $Quiesce, $Confirm) $global:calls.Add("New-Snapshot $Name") }
    function global:Remove-VM { param($VM, [switch]$DeletePermanently, $Confirm) $global:calls.Add('Remove-VM') }`;
  it('vsphere.ps1: stop, snapshot with the kit name, dry-run delete', () => {
    const env = '$env:VCENTER_USER = "svc"; $env:VCENTER_PASSWORD = "pw"';
    const stop = ps('vsphere', { manager: 'vc01', id: 'vm-42' }, `${env}\n${VSPHERE}`, 'stop -Item app01');
    expect(stop.code).toBe(0);
    expect(stop.calls).toContain('connect vc01');
    expect(stop.calls).toContain('get VirtualMachine-vm-42');
    expect(stop.calls).toContain('Stop-VMGuest');
    expect(stop.events).toEqual([['stop-source', 'started', false], ['stop-source', 'succeeded', false]]);
    const snap = ps('vsphere', { manager: 'vc01', id: 'vm-42' }, `${env}\n${VSPHERE}`, 'snapshot -Item app01');
    expect(snap.calls).toContain('New-Snapshot atk-01234567-2-app01');
    const del = ps('vsphere', { manager: 'vc01', id: 'vm-42' }, `${env}\n${VSPHERE}\n$global:vm.PowerState = 'PoweredOff'`, 'delete -Item app01 -DryRun');
    expect(del.calls.includes('Remove-VM')).toBe(false);
    expect(del.out).toContain('dry-run, not run: Remove-VM');
    expect(del.events).toEqual([['decommission', 'started', true], ['decommission', 'succeeded', true]]);
  });
  it('vsphere.ps1 state: the power state and the live check (tools, old snapshots, ISO, legacy NIC)', () => {
    const env = '$env:VCENTER_USER = "svc"; $env:VCENTER_PASSWORD = "pw"';
    const live = `
      $global:vm | Add-Member -NotePropertyName ExtensionData -NotePropertyValue ([pscustomobject]@{ Guest = [pscustomobject]@{ ToolsRunningStatus = 'guestToolsNotRunning' } })
      function global:Get-Snapshot { param($VM, $Name, $ErrorAction) @([pscustomobject]@{ Created = (Get-Date).AddDays(-3) }, [pscustomobject]@{ Created = (Get-Date) }) }
      function global:Get-CDDrive { param($VM, $ErrorAction) [pscustomobject]@{ IsoPath = '[ds1] iso/win.iso'; ConnectionState = [pscustomobject]@{ Connected = $true } } }
      function global:Get-NetworkAdapter { param($VM, $ErrorAction) @([pscustomobject]@{ Type = 'e1000' }, [pscustomobject]@{ Type = 'Vmxnet3' }) }`;
    const r = ps('vsphere', { manager: 'vc01', id: 'vm-42' }, `${env}\n${VSPHERE}\n${live}`, 'state -Item app01 -Step precheck -Path hcx-bulk');
    expect(r.code).toBe(0);
    expect(r.out).toContain('app01\tPoweredOn\ttools=guestToolsNotRunning old-snapshots=1 iso=connected legacy-nic=e1000');
    expect(r.events).toEqual([]);
  });
  it('hyperv.ps1: runs on the owning host through CIM; an already-off VM is skipped, a running one is stopped', () => {
    const mocks = `
      function global:New-CimSession { param($ComputerName, $ErrorAction, $Credential) $global:calls.Add("cim $ComputerName"); 'cim' }
      $global:state = 'Off'
      function global:Get-VM { param($CimSession, $Name, $Id, $ErrorAction) [pscustomobject]@{ Name = 'app01'; State = $global:state } }
      function global:Stop-VM { param($CimSession, $Name, [switch]$Force, [switch]$AsJob, [switch]$TurnOff) $global:calls.Add("Stop-VM $Name"); $global:state = 'Off' }`;
    const off = ps('hyperv', { host: 'hv03' }, mocks, 'stop -Item app01');
    expect(off.code).toBe(0);
    expect(off.calls).toContain('cim hv03');
    expect(off.events).toEqual([['stop-source', 'started', false], ['stop-source', 'skipped', false]]);
    const on = ps('hyperv', { host: 'hv03' }, `${mocks}\n$global:state = 'Running'`, 'stop -Item app01');
    expect(on.calls).toContain('Stop-VM app01');
    expect(on.events).toEqual([['stop-source', 'started', false], ['stop-source', 'succeeded', false]]);
  });
  it('azure.ps1: deallocates a running VM', () => {
    const mocks = `
      function global:Get-Module { param([switch]$ListAvailable, $Name) [pscustomobject]@{ Name = 'Az.Compute' } }
      function global:Get-AzContext { 'ctx' }
      function global:Get-AzVM { param($ResourceGroupName, $Name, [switch]$Status, $ErrorAction) [pscustomobject]@{ Name = $Name; ResourceGroupName = $ResourceGroupName; Statuses = @([pscustomobject]@{ Code = 'PowerState/running' }) } }
      function global:Stop-AzVM { param($ResourceGroupName, $Name, [switch]$Force) $global:calls.Add("Stop-AzVM $ResourceGroupName/$Name") }`;
    const r = ps('azure', { id: '/subscriptions/s/resourceGroups/rg-hr/providers/Microsoft.Compute/virtualMachines/hr-sql01' }, mocks, 'stop -Item app01');
    expect(r.code).toBe(0);
    expect(r.calls).toEqual(['Stop-AzVM rg-hr/hr-sql01']);
  });
});
