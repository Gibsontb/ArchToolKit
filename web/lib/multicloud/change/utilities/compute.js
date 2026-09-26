/**
 * Server utilities (addendum A.9.2): add a server, resize a server, power
 * (start / stop / restart), and remove a server (added: the day-2 change an
 * operator expects next to "add").
 *
 * A server an app stack manages is changed through the plan (a new workload,
 * a `compute:<id>:size` override, a removed workload) and the stack's diff;
 * any other server through the platform's own CLI or VCF PowerCLI, reading
 * the current state first so a second run changes nothing, and recording the
 * old value for rollback.sh.
 */

import { findAnsibleBlueprint } from '../../../ansible/blueprints/index.js';
                                                                 
import { findTerraformBlueprint } from '../../../terraform/blueprints/index.js';
import { planTagValue } from '../../../terraform/blueprints/migration/common.js';
import { diskTypes } from '../../plan/design/compute.js';
import { imageFor, isUnavailable } from '../../plan/images.js';
import { code } from '../../plan/execute/lib-sh.js';
import { renderImageRef,               } from '../../../terraform/blueprints/migration/common.js';
import { BACKUP_TIER_OPTIONS, OS_OPTIONS, itemId, overrideKey } from '../../plan/options.js';
import { osKind } from '../../plan/os.js';
import { DEFAULT_SIZING_POLICY, chooseInstance, policyOf, sizeServer } from '../../plan/sizing/server.js';
import { appPlanOf, findApp } from '../../plan/apps/components.js';
                                                                     
import {
  ALL_PLATFORMS, CLI_OF, NETWORK_INPUTS, OCI_COMPARTMENT_INPUT, PLATFORM_LABELS, RG_INPUT, ROUTE_INPUT, SIZE_OPTIONS, VSPHERE_INPUTS, ZONE_INPUT,
  ansibleFromBlueprints, appInput, envInput, error, findWorkload, guestOs, info, landingZoneExample, locateSh, managingApp, managingAppOf, numVal, on, opt, opts,
  parseFlex, platformInput, platformOf, psq, routeOf, safeName, serverInput, shq, stackChange, val, vcfTool, warning,
                                                                                                                         
} from './common.js';

const TF_PREFIX                                     = { aws: 'aws', azure: 'azure', google: 'google', oci: 'oci', vmware: 'vsphere' };
const ROLE_OF_TIER                                 = { web: 'web', app: 'app', db: 'db', mgmt: 'other' };

// ---------------------------------------------------------------------------
// Add a server / VM
// ---------------------------------------------------------------------------

function newWorkload(values                 , platform          )           {
  const name = val(values, 'name', 'app03');
  const disks = val(values, 'disks', '64').split(/\s+/).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  return {
    id: itemId('workload', name),
    name,
    app: val(values, 'app'),
    env: val(values, 'env', 'prod')       ,
    role: ROLE_OF_TIER[val(values, 'tier', 'app')] ?? 'app',
    os: val(values, 'os_id', 'rhel-9')        ,
    vcpu: numVal(values, 'vcpu', 2),
    ramGib: numVal(values, 'ram_gib', 8),
    disksGib: disks.length ? disks : [64],
    criticality: 'tier2',
    rpo: '4h',
    rto: '4h',
    licence: 'li',
    dependsOn: [],
    source: 'manual',
    disposition: 'new',
    pin: platform,
  };
}

function sizeFor(w          , platform          , values                 , ctx                , findings           )         {
  const chosen = val(values, 'size');
  if (chosen) return chosen;
  if (platform === 'vmware') return `${w.vcpu} vCPU / ${w.ramGib} GiB`;
  const policy = ctx.plan ? policyOf(ctx.plan) : DEFAULT_SIZING_POLICY;
  const s = sizeServer(w, platform, policy);
  findings.push(...s.findings);
  if (s.row.choice) {
    findings.push(info('change.size.recommended', `${w.name}: the sizing engine recommends ${s.row.choice} for ${w.vcpu} vCPU / ${w.ramGib} GiB${s.row.alternatives.length ? ` (alternatives: ${s.row.alternatives.join(', ')})` : ''}.`));
    if (platform === 'oci') {
      const d = s.row.detail;
      return `${s.row.choice}:${d.ocpus ?? Math.max(1, Math.ceil(w.vcpu / 2))}:${d.ramGib ?? w.ramGib}`;
    }
    return s.row.choice;
  }
  return SIZE_OPTIONS[platform][1] ;
}

const imageKey = (os      , platform          , findings           )         => {
  const e = imageFor(os, platform);
  if (isUnavailable(e)) {
    findings.push(error('change.server.no-image', `No ${PLATFORM_LABELS[platform]} image for ${os}: ${e.unavailable}`));
    return '';
  }
  return renderImageRef(e            );
};

function addServerAnsible(w          , platform          , values                 , findings           )                         {
  const windows = osKind(w.os) === 'windows';
  const join = val(values, 'domain_join', 'yes') === 'yes';
  const domain = val(values, 'domain', 'corp.example.com');
  const parts = [
    { blueprint: windows ? 'mig_windows_baseline' : 'mig_linux_baseline', values: { platform, ...(windows ? { domain_join: join ? 'true' : 'false' } : {}) } },
    ...(join ? [{ blueprint: windows ? 'mig_windows_domain_join' : 'mig_linux_domain_join', values: { domain } }] : []),
    { blueprint: 'mig_monitoring', values: { platform } },
  ];
  return ansibleFromBlueprints(parts, [{ name: w.name, windows }], findAnsibleBlueprint, findings);
}

function addServerTerraform(w          , platform          , size        , values                 , ctx                , findings           )                         {
  const lookup = ctx.lookup ?? findTerraformBlueprint;
  const tier = val(values, 'tier', 'app');
  const types = diskTypes(platform, tier         , w.criticality, true);
  let id        ;
  let v                        ;
  if (platform === 'vmware') {
    const f = parseFlex(size);
    id = 'vsphere_mig_vms';
    const row = [w.name, w.os, val(values, 'template', `${w.os}-template`), String(f.a ?? w.vcpu), String(f.b ?? w.ramGib), w.disksGib.join(' '),
      val(values, 'port_group', 'wld01-app'), val(values, 'ipv4', ''), val(values, 'ipv6', ''), val(values, 'gateway', ''), ''];
    v = {
      vms: row.join(' | '), vsphere_server: val(values, 'vcenter', 'wld01-vc01.corp.example.com'), datacenter: val(values, 'datacenter', 'wld01-dc'),
      cluster: val(values, 'cluster', 'wld01-cl01'), datastore_or_policy: val(values, 'datastore', 'wld01-cl01-ds-vsan01'), folder: val(values, 'folder', ''),
      domain: val(values, 'domain', 'corp.example.com'), dns_servers: val(values, 'dns_servers', '10.50.0.10 fd00:50::10'),
    };
  } else {
    id = `${TF_PREFIX[platform]}_mig_compute`;
    const disks = w.disksGib.map((g, i) => `${i === 0 ? types.boot : types.data}:${g}`).join(' ');
    const row = [w.name, w.os, imageKey(w.os, platform, findings), size, '', disks, val(values, 'network', 'prod'), tier, val(values, 'zone_letter', 'a'),
      'li', val(values, 'backup', 'silver'), 'rebuild', w.app, w.role, w.env, '', val(values, 'component', '')];
    v = { vms: row.join(' | '), landing_zone_source: 'variables', plan_id: planTagValue(ctx.plan?.id ?? '') };
  }
  const bp = lookup(id);
  if (!bp) {
    findings.push(error('change.server.blueprint', `The Terraform blueprint ${id} is not in the toolkit.`));
    return {};
  }
  const r = bp.build(v, 'change');
  findings.push(...(r.findings ?? []));
  const files                         = {};
  for (const [f, t] of Object.entries(r.files)) files[`terraform/${f}`] = t;
  if (platform !== 'vmware') files['terraform/landing_zone.auto.tfvars.json.example'] = landingZoneExample(platform === 'azure' ? 'azure' : platform);
  return files;
}

export const addServer                = {
  id: 'add-server',
  label: 'Add a server / VM',
  category: 'compute',
  description: 'A new server in an existing landing zone: one row of the platform\'s compute blueprint (or the app stack, when one manages the app), then the baseline, the domain join and monitoring by Ansible. The server is added to the plan as a new workload.',
  platforms: ALL_PLATFORMS,
  risk: 'low',
  reversible: true,
  rollback: 'Destroys the server (terraform destroy of the change\'s module, or the app stack without it) and removes it from the plan; the domain computer object is left for you to delete.',
  source: 'A.9.2',
  inputs: [
    platformInput(ALL_PLATFORMS),
    appInput('shop'),
    { id: 'component', label: 'Component', control: 'combo', default: '', from: 'component', hint: 'The app component it belongs to (optional).' },
    { id: 'name', label: 'Name', control: 'text', default: 'app03' },
    { id: 'os_id', label: 'OS', control: 'select', default: 'rhel-9', options: OS_OPTIONS.map((o) => opt(o.value, o.label, o.group)) },
    { id: 'vcpu', label: 'vCPU', control: 'number', default: 2, min: 1, max: 448 },
    { id: 'ram_gib', label: 'Memory GiB', control: 'number', default: 8, min: 1, max: 12288 },
    { id: 'size', label: 'Size', control: 'combo', default: '', options: [], hint: 'Blank: the sizing engine\'s recommendation for the vCPU and memory.' },
    { id: 'disks', label: 'Disks GiB', control: 'text', default: '64 100', hint: 'Space-separated; the first is the OS disk.' },
    envInput('prod'),
    ...NETWORK_INPUTS,
    { id: 'zone_letter', label: 'Zone', control: 'select', default: 'a', options: opts(['a', 'b', 'c']), ...on('aws', 'azure', 'google', 'oci') },
    { id: 'backup', label: 'Backup tier', control: 'select', default: 'silver', options: BACKUP_TIER_OPTIONS.map((o) => opt(o.value, o.label)) },
    { id: 'domain_join', label: 'Join the domain', control: 'select', default: 'yes', options: [opt('yes', 'Yes'), opt('no', 'No')] },
    { id: 'domain', label: 'Domain', control: 'text', default: 'corp.example.com', showWhen: { input: 'domain_join', equals: ['yes'] } },
    ...VSPHERE_INPUTS,
    { id: 'cluster', label: 'Cluster', control: 'text', default: 'wld01-cl01', ...on('vmware') },
    { id: 'datastore', label: 'Datastore (and storage policy)', control: 'text', default: 'wld01-cl01-ds-vsan01 policy:vSAN Default Storage Policy', ...on('vmware') },
    { id: 'template', label: 'Template', control: 'text', default: 'tpl-rhel9', ...on('vmware') },
    { id: 'port_group', label: 'Port group', control: 'text', default: 'wld01-app', ...on('vmware') },
    { id: 'ipv4', label: 'IPv4/prefix', control: 'text', default: '10.50.20.31/24', ...on('vmware') },
    { id: 'ipv6', label: 'IPv6/prefix', control: 'text', default: 'fd00:50:20::31/64', ...on('vmware') },
    { id: 'gateway', label: 'Gateways', control: 'text', default: '10.50.20.1 fd00:50:20::1', hint: 'An IPv4 and an IPv6 gateway.', ...on('vmware') },
    ROUTE_INPUT,
  ],
  optionsFor(id, values, ctx) {
    if (id !== 'size') return undefined;
    const p = platformOf(values, addServer);
    const vcpu = numVal(values, 'vcpu', 2);
    const ram = numVal(values, 'ram_gib', 8);
    const policy = ctx.plan ? policyOf(ctx.plan) : DEFAULT_SIZING_POLICY;
    const c = chooseInstance(p, vcpu, ram, { families: policy.families, allowArm: policy.allowArm, latest: policy.latestGeneration, burstable: true });
    const rec = c.fit ? [opt(c.fit.type, `${c.fit.type} (recommended)`, 'Sizing engine'), ...c.alternatives.map((a) => opt(a, a, 'Sizing engine'))] : [];
    return [...rec, ...SIZE_OPTIONS[p].map((s) => opt(s, s, 'Common sizes'))];
  },
  build(values, ctx)                {
    const platform = platformOf(values, addServer);
    const findings            = [];
    const w0 = newWorkload(values, platform);
    if (findWorkload(ctx.plan, w0.name)) findings.push(error('change.server.exists', `The plan already has a server named ${w0.name}.`, { path: 'name' }));
    const size = sizeFor(w0, platform, values, ctx, findings);
    const w           = w0;
    const ops           = [{ op: 'workload-add', workload: w }];
    if (val(values, 'size')) ops.push({ op: 'override', key: overrideKey('compute', w.id, 'size'), to: size });
    ops.push({ op: 'override', key: overrideKey('compute', w.id, 'backup'), to: val(values, 'backup', 'silver') });
    const appId = managingAppOf(ctx.plan, w.app, platform);
    const comp = val(values, 'component');
    if (appId && comp && ctx.plan) {
      const ap = appPlanOf(ctx.plan, appId);
      const c = ap?.variants[platform]?.find((x) => x.id === comp || x.name === comp || `${findApp(ctx.plan , appId)?.name}/${x.name}` === comp);
      if (c && c.kind === 'pattern') ops.push({ op: 'component-server', app: appId, platform, component: c.id, server: w.name });
    }
    const ansible = addServerAnsible(w, platform, values, findings);
    const an             = { kind: 'ansible', title: 'Baseline, domain join and monitoring', playbook: 'site.yml' };
    const route = routeOf(values, !!appId, findings);
    if (route === 'plan' && ctx.plan && appId) {
      const sc = stackChange(ctx.plan, ops, appId, platform, ctx);
      findings.push(...sc.findings);
      if (sc.changed) {
        return {
          platform, target: w.name, route: 'plan', summary: `Add ${w.name} (${size}) to ${w.app} on ${PLATFORM_LABELS[platform]} through its app stack`,
          files: { ...sc.files, ...ansible }, findings, apply: [...sc.apply, an], rollback: sc.rollback, needs: [], planOps: ops,
          notes: ['The domain join leaves a computer object; delete it in Active Directory after a rollback.'],
        };
      }
    }
    if (ctx.plan && w.app && !findApp(ctx.plan, w.app)) findings.push(warning('change.server.app', `No app named ${w.app} in the plan; the server is added without one.`, { path: 'app' }));
    const tf = addServerTerraform(w, platform, size, values, ctx, findings);
    findings.push(info('change.server.own-state', `${w.name} is built by this change's own Terraform state. If its app gets an app stack later, import it there (terraform import) rather than building a second one.`));
    return {
      platform, target: w.name, route: 'mixed', summary: `Add ${w.name} (${size}, ${w.os}) to ${w.app || 'no app'} on ${PLATFORM_LABELS[platform]}`,
      files: { ...tf, ...ansible }, findings,
      apply: [{ kind: 'terraform', title: `Build ${w.name}`, dir: 'terraform', lz: platform !== 'vmware' }, an],
      rollback: [{ kind: 'terraform-destroy', title: `Destroy ${w.name}`, dir: 'terraform', lz: platform !== 'vmware' }],
      needs: [], planOps: ops,
      notes: ['The domain join leaves a computer object; delete it in Active Directory after a rollback.', ...(platform !== 'vmware' ? ['The compute module asks for the SSH public key of the ansible user (see terraform/terraform.tfvars.example).'] : [])],
    };
  },
};

// ---------------------------------------------------------------------------
// Resize a server
// ---------------------------------------------------------------------------

/** Bash that resizes the located server to `$1`, keeping the size it had for rollback.sh first. */
function resizeFnSh(platform          )         {
  switch (platform) {
    case 'aws':
      return code`resize_to() {
  local want="$1" cur state
  cur="$(aws ec2 describe-instances --instance-ids "$SID" --query 'Reservations[0].Instances[0].InstanceType' --output text)"
  change_remember size "$cur"
  if [[ "$cur" == "$want" ]]; then atk_log "$SERVER is already $want"; return 0; fi
  state="$(aws ec2 describe-instances --instance-ids "$SID" --query 'Reservations[0].Instances[0].State.Name' --output text)"
  if [[ "$state" != stopped ]]; then
    atk_run aws ec2 stop-instances --instance-ids "$SID" --output text
    if (( ! ATK_DRY_RUN )); then aws ec2 wait instance-stopped --instance-ids "$SID"; fi
  fi
  atk_run aws ec2 modify-instance-attribute --instance-id "$SID" --instance-type "Value=$want"
  if [[ "$state" != stopped ]]; then atk_run aws ec2 start-instances --instance-ids "$SID" --output text; fi
}`;
    case 'azure':
      return code`resize_to() {
  local want="$1" cur
  cur="$(az vm show --resource-group "$RG" --name "$SERVER" --query hardwareProfile.vmSize -o tsv)"
  change_remember size "$cur"
  if [[ "$cur" == "$want" ]]; then atk_log "$SERVER is already $want"; return 0; fi
  # az vm resize restarts the VM; a size not offered on its current hardware cluster needs a deallocate first.
  atk_run az vm resize --resource-group "$RG" --name "$SERVER" --size "$want" --output none
}`;
    case 'google':
      return code`resize_to() {
  local want="$1" cur status
  cur="$(gcloud compute instances describe "$SERVER" --zone "$ZONE" --format='value(machineType.basename())')"
  change_remember size "$cur"
  if [[ "$cur" == "$want" ]]; then atk_log "$SERVER is already $want"; return 0; fi
  status="$(gcloud compute instances describe "$SERVER" --zone "$ZONE" --format='value(status)')"
  if [[ "$status" != TERMINATED ]]; then atk_run gcloud compute instances stop "$SERVER" --zone "$ZONE" --quiet; fi
  atk_run gcloud compute instances set-machine-type "$SERVER" --zone "$ZONE" --machine-type "$want" --quiet
  if [[ "$status" != TERMINATED ]]; then atk_run gcloud compute instances start "$SERVER" --zone "$ZONE" --quiet; fi
}`;
    case 'oci':
      return code`resize_to() {
  local want="$1" cur shape ocpus mem cfg
  cur="$(oci compute instance get --instance-id "$SID" | jq -r '.data | "\(.shape):\(.["shape-config"].ocpus | floor):\(.["shape-config"]["memory-in-gbs"] | floor)"')"
  change_remember size "$cur"
  if [[ "$cur" == "$want" ]]; then atk_log "$SERVER is already $want"; return 0; fi
  IFS=: read -r shape ocpus mem <<< "$want"
  if [[ -n "$ocpus" ]]; then
    cfg="{\"ocpus\": $ocpus, \"memoryInGBs\": $mem}"
    # A shape change reboots the instance.
    atk_run oci compute instance update --instance-id "$SID" --shape "$shape" --shape-config "$cfg" --force
  else
    atk_run oci compute instance update --instance-id "$SID" --shape "$shape" --force
  fi
}`;
    default:
      return '';
  }
}

function resizeVcf(server        , size        )         {
  const f = parseFlex(size);
  return `$name = ${psq(server)}
$vm = Get-ChangeVm -Name $name
if ($Mode -eq 'apply') {
  $cpu = ${f.a ?? 2}
  $mem = ${f.b ?? 8}
  if (-not (Get-AtkId -Path 'change' -Key "$($name):size")) { Set-AtkId -Path 'change' -Key "$($name):size" -Value "$($vm.NumCpu):$($vm.MemoryGB)" }
} else {
  $prev = Get-AtkId -Path 'change' -Key "$($name):size"
  if (-not $prev) { Stop-Atk 5 "no size recorded for $($name): apply.sh has not run (or ran with -DryRun)" }
  $cpu, $mem = $prev -split ':'
  $cpu = [int] $cpu
  $mem = [decimal] $mem
}
if ($vm.NumCpu -eq $cpu -and $vm.MemoryGB -eq $mem) {
  Write-AtkLog "$name is already $cpu vCPU / $mem GiB"
} else {
  $view = Get-View -Server $vc -Id $vm.Id -Property Config.CpuHotAddEnabled, Config.MemoryHotAddEnabled
  $hot = $view.Config.CpuHotAddEnabled -and $view.Config.MemoryHotAddEnabled -and $cpu -ge $vm.NumCpu -and $mem -ge $vm.MemoryGB
  $wasOn = $vm.PowerState -eq 'PoweredOn'
  if ($wasOn -and -not $hot) {
    Invoke-AtkStep "shut down the guest of $name (no hot-add for this change)" { Stop-VMGuest -VM $vm -Server $vc -Confirm:$false | Out-Null }
    if (-not $script:Atk.DryRun) { Wait-AtkUntil -Minutes 10 -IntervalSeconds 10 { (Get-VM -Server $vc -Id $vm.Id).PowerState -eq 'PoweredOff' } | Out-Null }
  }
  Invoke-AtkStep "set $name to $cpu vCPU / $mem GiB" { Set-VM -VM $vm -Server $vc -NumCpu $cpu -MemoryGB $mem -Confirm:$false | Out-Null }
  if ($wasOn -and -not $hot) { Invoke-AtkStep "start $name" { Start-VM -VM $vm -Server $vc -Confirm:$false | Out-Null } }
}`;
}

export const resizeServer                = {
  id: 'resize-server',
  label: 'Resize a server',
  category: 'compute',
  description: 'A new instance size: through the plan (a compute:<id>:size override and the app stack\'s diff) when an app stack manages the server, else with the platform\'s CLI (AWS stop, modify, start; Azure az vm resize; Google Cloud set-machine-type while stopped; OCI shape config; VCF Set-VM, hot-add when enabled, else a guest shutdown).',
  platforms: ALL_PLATFORMS,
  risk: 'medium',
  reversible: true,
  rollback: 'Puts the old size back (the stack\'s old files, or the size recorded before the change).',
  source: 'A.9.2',
  inputs: [
    platformInput(ALL_PLATFORMS),
    serverInput(),
    { id: 'size', label: 'New size', control: 'combo', default: '', options: [], hint: 'The sizing engine\'s alternatives for the server, and common sizes. OCI: shape:ocpus:memory; VCF: N vCPU / M GiB.' },
    RG_INPUT, ZONE_INPUT, OCI_COMPARTMENT_INPUT,
    ROUTE_INPUT,
  ],
  optionsFor(id, values, ctx) {
    if (id !== 'size') return undefined;
    const p = platformOf(values, resizeServer);
    const w = findWorkload(ctx.plan, val(values, 'server'));
    const rec = w && ctx.plan ? sizeServer(w, p, policyOf(ctx.plan)).row : undefined;
    return [
      ...(rec?.choice ? [opt(rec.choice, `${rec.choice} (recommended)`, 'Sizing engine'), ...rec.alternatives.map((a) => opt(a, a, 'Sizing engine'))] : []),
      ...SIZE_OPTIONS[p].map((s) => opt(s, s, 'Common sizes')),
    ];
  },
  build(values, ctx)                {
    const platform = platformOf(values, resizeServer);
    const findings            = [];
    const server = val(values, 'server', 'app01');
    const size = val(values, 'size') || SIZE_OPTIONS[platform][2] ;
    if (!val(values, 'size')) findings.push(info('change.resize.default-size', `No size chosen: ${size} is used.`, { path: 'size' }));
    const managed = managingApp(ctx.plan, server, platform);
    const route = routeOf(values, !!managed, findings);
    if (route === 'plan' && managed && ctx.plan) {
      const key = overrideKey('compute', managed.workload.id, 'size');
      const ops           = [{ op: 'override', key, ...(ctx.plan.designOverrides[key] !== undefined ? { from: ctx.plan.designOverrides[key] } : {}), to: size }];
      const sc = stackChange(ctx.plan, ops, managed.appId, platform, ctx);
      findings.push(...sc.findings);
      if (sc.changed) {
        return { platform, target: server, route: 'plan', summary: `Resize ${server} to ${size} through its app stack`, files: sc.files, findings, apply: sc.apply, rollback: sc.rollback, needs: [], planOps: ops };
      }
    }
    if (platform === 'vmware') {
      return {
        platform, target: server, route: 'cli', summary: `Resize ${server} to ${size} (VCF PowerCLI)`,
        files: { 'scripts/resize.ps1': vcfTool('scripts/resize.ps1', `Resize ${server} (apply) or put its old size back (rollback).`, resizeVcf(server, size)) },
        findings,
        apply: [{ kind: 'pwsh', title: `Resize ${server} to ${size}`, file: 'scripts/resize.ps1', args: ['apply'] }],
        rollback: [{ kind: 'pwsh', title: `Put ${server}'s old size back`, file: 'scripts/resize.ps1', args: ['rollback'] }],
        needs: [],
      };
    }
    const locate = locateSh(platform, server, values);
    const fn = resizeFnSh(platform);
    return {
      platform, target: server, route: 'cli', summary: `Resize ${server} to ${size} (${CLI_OF[platform]} CLI)`,
      files: {}, findings,
      apply: [{ kind: 'sh', title: `Resize ${server} to ${size}`, body: `${locate}\n${fn}\nresize_to ${shq(size)}` }],
      rollback: [{ kind: 'sh', title: `Put ${server}'s old size back`, body: `${locate}\n${fn}\nprev="$(change_recall size)"\nif [[ -z "$prev" ]]; then change_stop 5 "no old size recorded: apply.sh has not run (or ran with --dry-run)"; fi\nresize_to "$prev"` }],
      needs: [CLI_OF[platform], 'jq'],
      notes: ['The server restarts (AWS and Google Cloud stop and start it; Azure and OCI restart it).'],
    };
  },
};

// ---------------------------------------------------------------------------
// Power: start / stop / restart
// ---------------------------------------------------------------------------

function powerSh(platform          )         {
  switch (platform) {
    case 'aws':
      return code`power_state() { aws ec2 describe-instances --instance-ids "$SID" --query 'Reservations[0].Instances[0].State.Name' --output text; }
power_do() {
  case "$1" in
    start) if [[ "$(power_state)" == running ]]; then atk_log "$SERVER is running"; else atk_run aws ec2 start-instances --instance-ids "$SID" --output text; fi ;;
    stop) if [[ "$(power_state)" == stopped ]]; then atk_log "$SERVER is stopped"; else atk_run aws ec2 stop-instances --instance-ids "$SID" --output text; fi ;;
    restart) atk_run aws ec2 reboot-instances --instance-ids "$SID" ;;
  esac
}`;
    case 'azure':
      return code`power_state() { az vm get-instance-view --resource-group "$RG" --name "$SERVER" --query "instanceView.statuses[?starts_with(code,'PowerState/')].code | [0]" -o tsv | sed 's#PowerState/##'; }
power_do() {
  case "$1" in
    start) if [[ "$(power_state)" == running ]]; then atk_log "$SERVER is running"; else atk_run az vm start --resource-group "$RG" --name "$SERVER" --output none; fi ;;
    stop) if [[ "$(power_state)" == deallocated ]]; then atk_log "$SERVER is deallocated"; else atk_run az vm deallocate --resource-group "$RG" --name "$SERVER" --output none; fi ;;
    restart) atk_run az vm restart --resource-group "$RG" --name "$SERVER" --output none ;;
  esac
}`;
    case 'google':
      return code`power_state() { gcloud compute instances describe "$SERVER" --zone "$ZONE" --format='value(status)'; }
power_do() {
  case "$1" in
    start) if [[ "$(power_state)" == RUNNING ]]; then atk_log "$SERVER is running"; else atk_run gcloud compute instances start "$SERVER" --zone "$ZONE" --quiet; fi ;;
    stop) if [[ "$(power_state)" == TERMINATED ]]; then atk_log "$SERVER is stopped"; else atk_run gcloud compute instances stop "$SERVER" --zone "$ZONE" --quiet; fi ;;
    restart)
      atk_run gcloud compute instances stop "$SERVER" --zone "$ZONE" --quiet
      atk_run gcloud compute instances start "$SERVER" --zone "$ZONE" --quiet ;;
  esac
}`;
    case 'oci':
      return code`power_state() { oci compute instance get --instance-id "$SID" --query 'data."lifecycle-state"' --raw-output; }
power_do() {
  case "$1" in
    start) if [[ "$(power_state)" == RUNNING ]]; then atk_log "$SERVER is running"; else atk_run oci compute instance action --instance-id "$SID" --action START; fi ;;
    stop) if [[ "$(power_state)" == STOPPED ]]; then atk_log "$SERVER is stopped"; else atk_run oci compute instance action --instance-id "$SID" --action SOFTSTOP; fi ;;
    restart) atk_run oci compute instance action --instance-id "$SID" --action SOFTRESET ;;
  esac
}`;
    default:
      return '';
  }
}

const RUNNING                                     = { aws: 'running', azure: 'running', google: 'RUNNING', oci: 'RUNNING', vmware: 'PoweredOn' };

function powerVcf(server        , action        )         {
  return `$name = ${psq(server)}
$vm = Get-ChangeVm -Name $name
$action = ${psq(action)}
if ($Mode -eq 'apply') {
  if (-not (Get-AtkId -Path 'change' -Key "$($name):power")) { Set-AtkId -Path 'change' -Key "$($name):power" -Value ([string] $vm.PowerState) }
} else {
  $prev = Get-AtkId -Path 'change' -Key "$($name):power"
  if (-not $prev) { Stop-Atk 5 "no power state recorded for $($name): apply.sh has not run (or ran with -DryRun)" }
  $action = if ($prev -eq 'PoweredOn') { 'start' } else { 'stop' }
}
switch ($action) {
  'start' { if ($vm.PowerState -eq 'PoweredOn') { Write-AtkLog "$name is on" } else { Invoke-AtkStep "start $name" { Start-VM -VM $vm -Server $vc -Confirm:$false | Out-Null } } }
  'stop' { if ($vm.PowerState -eq 'PoweredOff') { Write-AtkLog "$name is off" } else { Invoke-AtkStep "shut down the guest of $name" { Stop-VMGuest -VM $vm -Server $vc -Confirm:$false | Out-Null } } }
  'restart' { Invoke-AtkStep "restart the guest of $name" { Restart-VMGuest -VM $vm -Server $vc -Confirm:$false | Out-Null } }
}`;
}

export const power                = {
  id: 'power',
  label: 'Power: start, stop or restart',
  category: 'compute',
  description: 'Starts, stops (Azure: deallocates) or restarts servers with the platform\'s CLI or VCF PowerCLI; a guest OS shutdown where the platform has one.',
  platforms: ALL_PLATFORMS,
  risk: 'medium',
  reversible: true,
  rollback: 'Puts each server back in the power state it was in before (a restart has nothing to undo; the rollback starts the server if it is down).',
  source: 'A.9.2',
  inputs: [
    platformInput(ALL_PLATFORMS),
    { ...serverInput('Servers', 'app01'), hint: 'One or more names, space-separated.' },
    { id: 'action', label: 'Action', control: 'select', default: 'restart', options: [opt('start', 'Start'), opt('stop', 'Stop (Azure: deallocate)'), opt('restart', 'Restart')] },
    RG_INPUT, ZONE_INPUT, OCI_COMPARTMENT_INPUT,
  ],
  build(values)                {
    const platform = platformOf(values, power);
    const servers = val(values, 'server', 'app01').split(/[\s,]+/).filter(Boolean);
    const action = val(values, 'action', 'restart');
    const findings            = [];
    if (action !== 'restart' && findings.length === 0) findings.push(info('change.power.users', `Tell the users of ${servers.join(', ')} before a ${action}.`));
    if (platform === 'vmware') {
      const body = servers.map((s) => powerVcf(s, action)).join('\n\n');
      return {
        platform, target: servers.join(' '), route: 'cli', summary: `${action} ${servers.join(', ')} (VCF PowerCLI)`,
        files: { 'scripts/power.ps1': vcfTool('scripts/power.ps1', `Power: ${action} (apply), or back to the recorded state (rollback).`, body) },
        findings,
        apply: [{ kind: 'pwsh', title: `${action} ${servers.join(', ')}`, file: 'scripts/power.ps1', args: ['apply'] }],
        rollback: [{ kind: 'pwsh', title: 'Back to the power state before', file: 'scripts/power.ps1', args: ['rollback'] }],
        needs: [],
      };
    }
    const fn = powerSh(platform);
    const per = (s        , body        )         => `${locateSh(platform, s, values)}\n${body}`;
    return {
      platform, target: servers.join(' '), route: 'cli', summary: `${action} ${servers.join(', ')} on ${PLATFORM_LABELS[platform]}`,
      files: {}, findings,
      apply: servers.map((s)             => ({ kind: 'sh', title: `${action} ${s}`, body: per(s, `${fn}\nchange_remember ${safeName(s)}:power "$(power_state)"\npower_do ${action}`) })),
      rollback: servers.map((s)             => ({
        kind: 'sh', title: `${s} back to its power state before`,
        body: per(s, `${fn}\nprev="$(change_recall ${safeName(s)}:power)"\nif [[ -z "$prev" ]]; then change_stop 5 "no power state recorded for ${s}: apply.sh has not run (or ran with --dry-run)"; fi\nif [[ "$prev" == ${RUNNING[platform]} ]]; then power_do start; else power_do stop; fi`),
      })),
      needs: [CLI_OF[platform], 'jq'],
    };
  },
};

// ---------------------------------------------------------------------------
// Remove a server (added)
// ---------------------------------------------------------------------------

function removeSh(platform          )                                   {
  switch (platform) {
    case 'aws':
      return {
        snap: code`atk_run aws ec2 create-snapshots --instance-specification "InstanceId=$SID" --description "final $SERVER $CHANGE_ITEM" --copy-tags-from-source volume --output text`,
        remove: code`atk_run aws ec2 terminate-instances --instance-ids "$SID" --output text`,
      };
    case 'azure':
      return {
        snap: code`for disk in $(az vm show --resource-group "$RG" --name "$SERVER" --query '[storageProfile.osDisk.managedDisk.id, storageProfile.dataDisks[].managedDisk.id][]' -o tsv); do
  atk_run az snapshot create --resource-group "$RG" --name "final-$\{disk##*/}" --source "$disk" --incremental true --output none
done`,
        remove: code`atk_run az resource delete --ids "$(az vm show --resource-group "$RG" --name "$SERVER" --query id -o tsv)" --output none`,
      };
    case 'google':
      return {
        snap: code`for disk in $(gcloud compute instances describe "$SERVER" --zone "$ZONE" --format='value(disks[].source.basename())' | tr ';' ' '); do
  atk_run gcloud compute disks snapshot "$disk" --zone "$ZONE" --snapshot-names "final-$disk" --quiet
done`,
        remove: code`atk_run gcloud compute instances delete "$SERVER" --zone "$ZONE" --keep-disks=all --quiet`,
      };
    case 'oci':
      return {
        snap: code`boot="$(oci compute boot-volume-attachment list --compartment-id "$COMPARTMENT" --availability-domain "$(oci compute instance get --instance-id "$SID" --query 'data."availability-domain"' --raw-output)" --instance-id "$SID" --query 'data[0]."boot-volume-id"' --raw-output)"
atk_run oci bv boot-volume-backup create --boot-volume-id "$boot" --display-name "final-$SERVER" --type FULL`,
        remove: code`atk_run oci compute instance terminate --instance-id "$SID" --preserve-boot-volume true --force`,
      };
    default:
      return { snap: '', remove: '' };
  }
}

export const removeServer                = {
  id: 'remove-server',
  label: 'Remove a server',
  category: 'compute',
  description: 'Takes a final snapshot, then removes the server: through the plan (the workload leaves the plan and the app stack\'s next apply destroys it) or with the platform\'s CLI (disks kept where the platform can keep them).',
  platforms: ALL_PLATFORMS,
  risk: 'high',
  reversible: false,
  rollback: 'Puts the server back in the plan and the stack (a new, empty server) or leaves the kept disks and the final snapshot for a restore by hand; the data comes back only from the final snapshot.',
  source: 'added',
  inputs: [
    platformInput(ALL_PLATFORMS),
    serverInput(),
    { id: 'confirm', label: 'Type the server\'s name to confirm', control: 'text', default: '', hint: 'Removing a server cannot be undone without its final snapshot.' },
    RG_INPUT, ZONE_INPUT, OCI_COMPARTMENT_INPUT,
    ROUTE_INPUT,
  ],
  build(values, ctx)                {
    const platform = platformOf(values, removeServer);
    const server = val(values, 'server', 'app01');
    const findings            = [];
    if (val(values, 'confirm') !== server) {
      findings.push(warning('change.remove.confirm', `Type ${server} in the confirmation box: the bundle's apply.sh refuses to run until the name is confirmed.`, { path: 'confirm' }));
    }
    const guard             = { kind: 'sh', title: 'Check the confirmation', body: val(values, 'confirm') === server ? 'atk_log "removal confirmed"' : `change_stop 5 ${shq(`removal of ${server} was not confirmed: regenerate the change with the name typed`)}` };
    const managed = managingApp(ctx.plan, server, platform);
    const route = routeOf(values, !!managed, findings);
    const sh = removeSh(platform);
    const snapStep             = platform === 'vmware'
      ? { kind: 'pwsh', title: `Final snapshot of ${server}`, file: 'scripts/remove.ps1', args: ['apply'] }
      : { kind: 'sh', title: `Final snapshot of ${server}`, body: `${locateSh(platform, server, values)}\n${sh.snap}` };
    const vcfBody = `$name = ${psq(server)}
$vm = Get-ChangeVm -Name $name
if ($Mode -eq 'apply') {
  Invoke-AtkStep "final snapshot of $name" { New-Snapshot -VM $vm -Server $vc -Name 'final' -Description 'Before removal' -Memory:$false -Quiesce:$false -Confirm:$false | Out-Null }
${route === 'plan' ? '' : `  if ($vm.PowerState -eq 'PoweredOn') { Invoke-AtkStep "power off $name" { Stop-VM -VM $vm -Server $vc -Confirm:$false | Out-Null } }
  Invoke-AtkStep "remove $name from the inventory (its files stay on the datastore)" { Remove-VM -VM $vm -Server $vc -DeletePermanently:$false -Confirm:$false | Out-Null }`}
} else {
  Write-AtkLog "the VM's files and its final snapshot stay on the datastore: register the .vmx again (New-VM -VMFilePath) to bring it back"
}`;
    const files                         = platform === 'vmware' ? { 'scripts/remove.ps1': vcfTool('scripts/remove.ps1', `Final snapshot and removal of ${server}.`, vcfBody) } : {};
    if (route === 'plan' && managed && ctx.plan) {
      const ops           = [{ op: 'workload-remove', workload: managed.workload }];
      const sc = stackChange(ctx.plan, ops, managed.appId, platform, ctx);
      findings.push(...sc.findings);
      if (sc.changed) {
        return {
          platform, target: server, route: 'plan', summary: `Remove ${server} (final snapshot first) through its app stack`, files: { ...files, ...sc.files }, findings,
          apply: [guard, snapStep, ...sc.apply],
          rollback: [...sc.rollback, { kind: 'manual', title: 'Restore the data', text: `restore ${server}'s disks from the final snapshot onto the rebuilt server` }],
          needs: platform === 'vmware' ? [] : [CLI_OF[platform]], planOps: ops,
        };
      }
    }
    if (platform === 'vmware') {
      return {
        platform, target: server, route: 'cli', summary: `Remove ${server} (final snapshot first, files kept)`, files, findings,
        apply: [guard, { kind: 'pwsh', title: `Final snapshot and removal of ${server}`, file: 'scripts/remove.ps1', args: ['apply'] }],
        rollback: [{ kind: 'pwsh', title: 'How to bring it back', file: 'scripts/remove.ps1', args: ['rollback'] }],
        needs: [], planOps: managed ? [{ op: 'workload-remove', workload: managed.workload }] : [],
      };
    }
    return {
      platform, target: server, route: 'cli', summary: `Remove ${server} (final snapshot first) on ${PLATFORM_LABELS[platform]}`, files, findings,
      apply: [guard, snapStep, { kind: 'sh', title: `Remove ${server}`, body: `${locateSh(platform, server, values)}\n${sh.remove}` }],
      rollback: [{ kind: 'manual', title: 'Bring the server back', text: `create ${server} again from its final snapshot (and the kept disks), then run the add-server utility's Ansible` }],
      needs: [CLI_OF[platform]],
    };
  },
};

export const COMPUTE_UTILITIES                           = [addServer, resizeServer, power, removeServer];
