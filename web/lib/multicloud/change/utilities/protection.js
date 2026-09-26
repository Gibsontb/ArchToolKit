/**
 * Protection utilities: snapshot now / backup tier (addendum A.9.2) and
 * rotate a certificate (added).
 *
 * "Snapshot now" snapshots every disk of the servers, tags the snapshots
 * with the change id, and writes `remove-after-<n>-days.sh`, which deletes
 * them once they are that old (the rollback deletes them at once). A backup
 * tier change is the plan's `compute:<id>:backup` override (and the app
 * stack's diff) or, for a server outside the stacks, its `atk_backup` tag:
 * the backup selections follow the tag.
 *
 * A certificate is rotated in the guest (the files and a service reload on
 * Linux, the machine store and the IIS binding on Windows) or in the cloud's
 * certificate service (ACM re-import to the same ARN, a new Key Vault
 * version, a Certificate Manager update). The new certificate and key come
 * from files named in the environment when the scripts run; they are never
 * in the bundle.
 */

                                                                 
import { code } from '../../plan/execute/lib-sh.js';
import { BACKUP_TIER_OPTIONS, overrideKey } from '../../plan/options.js';
import { appWorkloads, findApp } from '../../plan/apps/components.js';
                                                
import {
  ALL_PLATFORMS, CLI_OF, OCI_COMPARTMENT_INPUT, PLATFORM_LABELS, RG_INPUT, ROUTE_INPUT, VSPHERE_INPUTS, ZONE_INPUT, ansibleProject, appInput, error, guestOs, info,
  locateSh, managingApp, numVal, opt, osInput, platformInput, platformOf, playbook, psq, routeOf, serverInput, shq, stackChange, val, vcfTool, warning, yq,
                                                                                                    
} from './common.js';
import { tagStepsSh } from './governance.js';

// ---------------------------------------------------------------------------
// Snapshot now / backup tier
// ---------------------------------------------------------------------------

function snapSh(platform          )                                 {
  switch (platform) {
    case 'aws':
      return {
        take: code`n="$(aws ec2 describe-snapshots --owner-ids self --filters "Name=tag:atk_change,Values=$CHANGE_ITEM" "Name=tag:atk_server,Values=$SERVER" --query 'length(Snapshots)' --output text)"
if (( n > 0 )); then
  atk_log "$SERVER has this change's snapshots already"
else
  atk_run aws ec2 create-snapshots --instance-specification "InstanceId=$SID" --description "$CHANGE_ITEM $SERVER" --copy-tags-from-source volume --tag-specifications "ResourceType=snapshot,Tags=[{Key=atk_change,Value=$CHANGE_ITEM},{Key=atk_server,Value=$SERVER}]" --output text
fi`,
        drop: code`for snap in $(aws ec2 describe-snapshots --owner-ids self --filters "Name=tag:atk_change,Values=$CHANGE_ITEM" "Name=tag:atk_server,Values=$SERVER" --query 'Snapshots[].SnapshotId' --output text); do
  atk_run aws ec2 delete-snapshot --snapshot-id "$snap"
done`,
      };
    case 'azure':
      return {
        take: code`for disk in $(az vm show --resource-group "$RG" --name "$SERVER" --query '[storageProfile.osDisk.managedDisk.id, storageProfile.dataDisks[].managedDisk.id][]' -o tsv); do
  name="$CHANGE_ITEM-$\{disk##*/}"
  name="$\{name:0:80}"
  if az snapshot show --resource-group "$RG" --name "$name" --output none 2> /dev/null; then atk_log "$name exists"; continue; fi
  atk_run az snapshot create --resource-group "$RG" --name "$name" --source "$disk" --incremental true --tags "atk_change=$CHANGE_ITEM" "atk_server=$SERVER" --output none
done`,
        drop: code`for snap in $(az snapshot list --resource-group "$RG" --query "[?tags.atk_change=='$CHANGE_ITEM' && tags.atk_server=='$SERVER'].id" -o tsv); do
  atk_run az snapshot delete --ids "$snap" --output none
done`,
      };
    case 'google':
      return {
        take: code`for disk in $(gcloud compute instances describe "$SERVER" --zone "$ZONE" --format='value(disks[].source.basename())' | tr ';' ' '); do
  name="$CHANGE_ITEM-$disk"
  name="$\{name:0:63}"
  if gcloud compute snapshots describe "$name" --format='value(name)' > /dev/null 2>&1; then atk_log "$name exists"; continue; fi
  atk_run gcloud compute disks snapshot "$disk" --zone "$ZONE" --snapshot-names "$name" --labels "atk_change=$CHANGE_ITEM" --quiet
done`,
        drop: code`for snap in $(gcloud compute snapshots list --filter="labels.atk_change=$CHANGE_ITEM AND name ~ ^$CHANGE_ITEM-" --format='value(name)'); do
  atk_run gcloud compute snapshots delete "$snap" --quiet
done`,
      };
    case 'oci':
      return {
        take: code`AD="$(oci compute instance get --instance-id "$SID" --query 'data."availability-domain"' --raw-output)"
tags="{\"atk_change\": \"$CHANGE_ITEM\", \"atk_server\": \"$SERVER\"}"
boot="$(oci compute boot-volume-attachment list --compartment-id "$COMPARTMENT" --availability-domain "$AD" --instance-id "$SID" --query 'data[0]."boot-volume-id"' --raw-output)"
if [[ -n "$(oci bv boot-volume-backup list --compartment-id "$COMPARTMENT" --boot-volume-id "$boot" --display-name "$CHANGE_ITEM-boot" --query 'data[0].id' --raw-output 2> /dev/null)" ]]; then
  atk_log "the boot volume backup exists"
else
  atk_run oci bv boot-volume-backup create --boot-volume-id "$boot" --display-name "$CHANGE_ITEM-boot" --type INCREMENTAL --freeform-tags "$tags"
fi
for vol in $(oci compute volume-attachment list --compartment-id "$COMPARTMENT" --instance-id "$SID" | jq -r '.data[] | select(."lifecycle-state" == "ATTACHED") | ."volume-id"'); do
  if [[ -n "$(oci bv backup list --compartment-id "$COMPARTMENT" --volume-id "$vol" --display-name "$CHANGE_ITEM-$\{vol: -8}" --query 'data[0].id' --raw-output 2> /dev/null)" ]]; then continue; fi
  atk_run oci bv backup create --volume-id "$vol" --display-name "$CHANGE_ITEM-$\{vol: -8}" --type INCREMENTAL --freeform-tags "$tags"
done`,
        drop: code`for b in $(oci bv boot-volume-backup list --compartment-id "$COMPARTMENT" --all | jq -r --arg c "$CHANGE_ITEM" --arg s "$SERVER" '.data[] | select(."freeform-tags".atk_change == $c and ."freeform-tags".atk_server == $s and ."lifecycle-state" != "TERMINATED") | .id'); do
  atk_run oci bv boot-volume-backup delete --boot-volume-backup-id "$b" --force
done
for b in $(oci bv backup list --compartment-id "$COMPARTMENT" --all | jq -r --arg c "$CHANGE_ITEM" --arg s "$SERVER" '.data[] | select(."freeform-tags".atk_change == $c and ."freeform-tags".atk_server == $s and ."lifecycle-state" != "TERMINATED") | .id'); do
  atk_run oci bv backup delete --volume-backup-id "$b" --force
done`,
      };
    default:
      return { take: '', drop: '' };
  }
}

function snapVcf(servers                   )         {
  return `$item = (Get-Content -LiteralPath (Join-Path $PSScriptRoot '../change.json') -Raw | ConvertFrom-Json).item
foreach ($name in @(${servers.map(psq).join(', ')})) {
  $vm = Get-ChangeVm -Name $name
  $snap = Get-Snapshot -VM $vm -Server $vc -Name $item -ErrorAction SilentlyContinue
  if ($Mode -eq 'apply') {
    if ($snap) { Write-AtkLog "$name has the snapshot $item already"; continue }
    Invoke-AtkStep "snapshot $name as $item" { New-Snapshot -VM $vm -Server $vc -Name $item -Description 'Change utility snapshot' -Memory:$false -Quiesce:$true -Confirm:$false | Out-Null }
  } else {
    if (-not $snap) { Write-AtkLog "$name has no snapshot $item"; continue }
    Invoke-AtkStep "delete the snapshot $item of $name" { Remove-Snapshot -Snapshot $snap -Confirm:$false | Out-Null }
  }
}`;
}

/** remove-after-<n>-days.sh: runs rollback.sh (which deletes the snapshots) once they are n days old. */
function removeAfter(days        )         {
  return `#!/usr/bin/env bash
# remove-after-${days}-days.sh: deletes this change's snapshots ${days} days after apply.sh took them (run it daily,
# for example from cron). --dry-run is passed on to rollback.sh.
set -Eeuo pipefail
CHANGE_HOME="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
export ATK_ROOT="\${ATK_ROOT:-$CHANGE_HOME}"
source "$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)/lib/atk.sh"
atk_init_tool change "$@"
atk_need jq date
item="$(jq -r '.item' "$CHANGE_HOME/change.json")"
taken="$(atk_ids_get change "$item:snapshot-at" || true)"
if [[ -z "$taken" ]]; then
  atk_log "no snapshots taken yet"
  exit 0
fi
age=$(( ( $(date -u +%s) - taken ) / 86400 ))
if (( age < ${days} )); then
  atk_log "the snapshots are $age days old; they go at ${days}"
  exit 0
fi
args=()
if (( ATK_DRY_RUN )); then args+=(--dry-run); fi
"$CHANGE_HOME/rollback.sh" "\${args[@]}"
`;
}

/** Snapshot steps for other utilities (a patch run's "snapshot first"): take in apply, delete in rollback. */
export function snapshotSteps(platform          , servers                   , values                 )                                                                            {
  if (platform === 'vmware') {
    return {
      files: { 'scripts/snapshot.ps1': vcfTool('scripts/snapshot.ps1', 'Snapshot (apply) or delete this change\'s snapshots (rollback).', snapVcf(servers)) },
      take: [{ kind: 'pwsh', title: 'Snapshot the VMs first', file: 'scripts/snapshot.ps1', args: ['apply'] }],
      drop: [{ kind: 'pwsh', title: 'Delete the change\'s snapshots', file: 'scripts/snapshot.ps1', args: ['rollback'] }],
    };
  }
  const sh = snapSh(platform);
  return {
    files: {},
    take: servers.map((s)             => ({ kind: 'sh', title: `Snapshot ${s} first`, body: `${locateSh(platform, s, values)}\n${sh.take}` })),
    drop: servers.map((s)             => ({ kind: 'sh', title: `Delete ${s}'s snapshots from this change`, body: `${locateSh(platform, s, values)}\n${sh.drop}` })),
  };
}

function scopeServers(values                 , plan                  )           {
  if (val(values, 'scope', 'servers') === 'app' && plan) {
    const app = findApp(plan, val(values, 'app', 'shop'));
    if (app) return appWorkloads(plan, app).map((w) => w.name);
  }
  return val(values, 'server', 'app01').split(/[\s,]+/).filter(Boolean);
}

export const snapshotBackup                = {
  id: 'snapshot-backup',
  label: 'Snapshot now / backup policy',
  category: 'protection',
  description: 'Snapshot now: every disk of the servers (aws ec2 create-snapshots, az snapshot create, gcloud compute disks snapshot, oci bv backup create, New-Snapshot), tagged with the change, and a remove-after-<n>-days script. Change tier: the plan\'s backup override (and the app stack\'s diff) or the atk_backup tag the backup selections follow.',
  platforms: ALL_PLATFORMS,
  risk: 'low',
  reversible: true,
  rollback: 'Deletes the change\'s snapshots, or puts the old backup tier back.',
  source: 'A.9.2',
  inputs: [
    platformInput(ALL_PLATFORMS),
    { id: 'action', label: 'Action', control: 'select', default: 'snapshot', options: [opt('snapshot', 'Snapshot now'), opt('tier', 'Change the backup tier')] },
    { id: 'scope', label: 'Scope', control: 'select', default: 'servers', options: [opt('servers', 'Servers'), opt('app', 'Every server of an app')] },
    { ...serverInput('Servers', 'app01'), hint: 'Space-separated.', showWhen: { input: 'scope', equals: ['servers'] } },
    { ...appInput('shop'), showWhen: { input: 'scope', equals: ['app'] } },
    { id: 'retention_days', label: 'Keep the snapshots (days)', control: 'number', default: 7, min: 1, max: 365, showWhen: { input: 'action', equals: ['snapshot'] } },
    { id: 'tier', label: 'Backup tier', control: 'select', default: 'gold', options: BACKUP_TIER_OPTIONS.map((o) => opt(o.value, o.label)), showWhen: { input: 'action', equals: ['tier'] } },
    RG_INPUT, ZONE_INPUT, OCI_COMPARTMENT_INPUT, ...VSPHERE_INPUTS,
    ROUTE_INPUT,
  ],
  build(values, ctx)                {
    const platform = platformOf(values, snapshotBackup);
    const findings            = [];
    const servers = scopeServers(values, ctx.plan);
    if (!servers.length) findings.push(error('change.snapshot.no-servers', 'No servers in the scope.', { path: 'server' }));
    if (val(values, 'action', 'snapshot') === 'tier') {
      const tier = val(values, 'tier', 'gold');
      const ops           = [];
      let appId                    ;
      for (const s of servers) {
        const m = managingApp(ctx.plan, s, platform);
        if (!m || !ctx.plan) continue;
        appId ??= m.appId;
        const k = overrideKey('compute', m.workload.id, 'backup');
        ops.push({ op: 'override', key: k, ...(ctx.plan.designOverrides[k] !== undefined ? { from: ctx.plan.designOverrides[k] } : {}), to: tier });
      }
      const route = routeOf(values, ops.length > 0, findings);
      if (route === 'plan' && appId && ctx.plan) {
        const sc = stackChange(ctx.plan, ops, appId, platform, ctx);
        findings.push(...sc.findings);
        if (sc.changed) {
          if (ops.length < servers.length) findings.push(warning('change.snapshot.mixed', 'Some servers are outside the app stack: only the managed ones change; run the utility again for the others with the direct route.'));
          return { platform, target: servers.join(' '), route: 'plan', summary: `Backup tier ${tier} for ${servers.join(', ')} through the app stack`, files: sc.files, findings, apply: sc.apply, rollback: sc.rollback, needs: [], planOps: ops };
        }
      }
      if (platform === 'vmware') {
        findings.push(info('change.snapshot.vcf-tier', 'On VCF the backup product reads the atk_backup vSphere tag; the tags utility sets it.'));
      }
      const steps = platform === 'vmware' ? [] : servers.map((s) => ({ s, t: tagStepsSh(platform, s, values, { atk_backup: tier }, []) }));
      if (platform === 'vmware') {
        return {
          platform, target: servers.join(' '), route: 'cli', summary: `Backup tier ${tier} (atk_backup tag) for ${servers.join(', ')}`, findings, planOps: ops,
          files: {},
          apply: [{ kind: 'manual', title: 'Set the atk_backup tag', text: `run the Tag changes utility on VCF with atk_backup | ${tier}` }],
          rollback: [{ kind: 'manual', title: 'Put the old atk_backup tag back', text: 'roll back that Tag changes bundle' }],
          needs: [],
        };
      }
      return {
        platform, target: servers.join(' '), route: 'cli', summary: `Backup tier ${tier} (atk_backup tag) for ${servers.join(', ')} on ${PLATFORM_LABELS[platform]}`, findings, planOps: ops, files: {},
        apply: steps.map(({ s, t })             => ({ kind: 'sh', title: `atk_backup=${tier} on ${s}`, body: t.apply })),
        rollback: steps.map(({ s, t })             => ({ kind: 'sh', title: `The old atk_backup tag on ${s}`, body: t.rollback })),
        needs: [CLI_OF[platform], 'jq'],
      };
    }
    const days = numVal(values, 'retention_days', 7);
    const files                         = { [`remove-after-${days}-days.sh`]: removeAfter(days) };
    const summary = `Snapshot ${servers.join(', ')} now, kept ${days} days`;
    const stamp = 'change_remember snapshot-at "$(date -u +%s)"';
    if (platform === 'vmware') {
      files['scripts/snapshot.ps1'] = vcfTool('scripts/snapshot.ps1', 'Snapshot (apply) or delete this change\'s snapshots (rollback).', snapVcf(servers));
      return {
        platform, target: servers.join(' '), route: 'cli', summary, files, findings,
        apply: [{ kind: 'pwsh', title: 'Snapshot the VMs', file: 'scripts/snapshot.ps1', args: ['apply'] }, { kind: 'sh', title: 'Record when', body: stamp }],
        rollback: [{ kind: 'pwsh', title: 'Delete the change\'s snapshots', file: 'scripts/snapshot.ps1', args: ['rollback'] }],
        needs: ['jq'],
        notes: [`remove-after-${days}-days.sh deletes the snapshots once they are ${days} days old: run it daily. VCF snapshots are not backups; keep them short.`],
      };
    }
    const sh = snapSh(platform);
    return {
      platform, target: servers.join(' '), route: 'cli', summary: `${summary} (${PLATFORM_LABELS[platform]})`, files, findings,
      apply: [...servers.map((s)             => ({ kind: 'sh', title: `Snapshot ${s}`, body: `${locateSh(platform, s, values)}\n${sh.take}` })), { kind: 'sh', title: 'Record when', body: stamp }],
      rollback: servers.map((s)             => ({ kind: 'sh', title: `Delete ${s}'s snapshots from this change`, body: `${locateSh(platform, s, values)}\n${sh.drop}` })),
      needs: [CLI_OF[platform], 'jq'],
      notes: [`remove-after-${days}-days.sh deletes the snapshots once they are ${days} days old: run it daily (cron: 0 6 * * * <bundle>/remove-after-${days}-days.sh).`],
    };
  },
};

// ---------------------------------------------------------------------------
// Rotate a certificate (added)
// ---------------------------------------------------------------------------

function certLinux(certPath        , keyPath        , service        )                                  {
  const vars = `    change_cert_path: ${yq(certPath)}
    change_key_path: ${yq(keyPath)}
    change_service: ${yq(service)}
    change_cert_src: "{{ lookup('ansible.builtin.env', 'CHANGE_CERT_FILE') }}"
    change_key_src: "{{ lookup('ansible.builtin.env', 'CHANGE_KEY_FILE') }}"`;
  return {
    apply: playbook(`Install the new certificate at ${certPath}`, 'atk_change_linux', `    - name: Stop when the new files are not named
      ansible.builtin.assert:
        that:
          - change_cert_src | length > 0
          - change_key_src | length > 0
        fail_msg: Set CHANGE_CERT_FILE and CHANGE_KEY_FILE on the controller to the new certificate (with its chain) and key.

    - name: Keep the current certificate and key for the rollback
      ansible.builtin.copy:
        src: "{{ item }}"
        dest: "{{ item }}.atk-prev"
        remote_src: true
        force: false
        mode: preserve
      loop:
        - "{{ change_cert_path }}"
        - "{{ change_key_path }}"

    - name: Install the new certificate
      ansible.builtin.copy:
        src: "{{ change_cert_src }}"
        dest: "{{ change_cert_path }}"
        mode: "0644"
      notify: Reload the service

    - name: Install the new key
      ansible.builtin.copy:
        src: "{{ change_key_src }}"
        dest: "{{ change_key_path }}"
        mode: "0600"
      no_log: true
      notify: Reload the service

  handlers:
    - name: Reload the service
      ansible.builtin.service:
        name: "{{ change_service }}"
        state: reloaded
      when: change_service | length > 0
`, { become: true, vars }),
    back: playbook(`Put the previous certificate back at ${certPath}`, 'atk_change_linux', `    - name: Put the kept certificate and key back
      ansible.builtin.copy:
        src: "{{ item }}.atk-prev"
        dest: "{{ item }}"
        remote_src: true
        mode: preserve
      loop:
        - "{{ change_cert_path }}"
        - "{{ change_key_path }}"
      notify: Reload the service

  handlers:
    - name: Reload the service
      ansible.builtin.service:
        name: "{{ change_service }}"
        state: reloaded
      when: change_service | length > 0
`, { become: true, vars: vars.split('\n').slice(0, 3).join('\n') }),
  };
}

function certWindows(site        )                                  {
  const vars = `    change_site: ${yq(site)}
    change_pfx_src: "{{ lookup('ansible.builtin.env', 'CHANGE_PFX_FILE') }}"`;
  return {
    apply: playbook(`Import the new certificate and bind it to ${site}`, 'atk_change_windows', `    - name: Stop when the new PFX is not named
      ansible.builtin.assert:
        that: change_pfx_src | length > 0
        fail_msg: Set CHANGE_PFX_FILE on the controller; its password is the vault variable vault_pfx_password.

    - name: Make the working folder
      ansible.windows.win_file:
        path: C:\ProgramData\atk
        state: directory

    - name: Copy the PFX to the server
      ansible.windows.win_copy:
        src: "{{ change_pfx_src }}"
        dest: C:\\ProgramData\\atk\\change.pfx

    - name: Import it into the machine store
      ansible.windows.win_certificate_store:
        path: C:\\ProgramData\\atk\\change.pfx
        password: "{{ vault_pfx_password }}"
        key_exportable: false
        key_storage: machine
        store_location: LocalMachine
        store_name: My
        state: present
      register: change_cert
      no_log: true

    - name: Bind it to the site's HTTPS binding (the old thumbprint is kept for the rollback)
      ansible.windows.win_powershell:
        parameters:
          Site: "{{ change_site }}"
          Thumbprint: "{{ change_cert.thumbprints[0] }}"
        script: |
          param([string] $Site, [string] $Thumbprint)
          Import-Module WebAdministration
          $Ansible.Changed = $false
          $binding = Get-WebBinding -Name $Site -Protocol https | Select-Object -First 1
          if (-not $binding) { throw "The site $Site has no https binding." }
          if ($binding.certificateHash -eq $Thumbprint) { return }
          Set-Content -LiteralPath 'C:\\ProgramData\\atk\\previous-thumbprint.txt' -Value $binding.certificateHash
          $binding.AddSslCertificate($Thumbprint, 'My')
          $Ansible.Changed = $true

    - name: Remove the copied PFX
      ansible.windows.win_file:
        path: C:\\ProgramData\\atk\\change.pfx
        state: absent
`, { vars }),
    back: playbook(`Bind the previous certificate to ${site} again`, 'atk_change_windows', `    - name: Rebind the kept thumbprint
      ansible.windows.win_powershell:
        parameters:
          Site: "{{ change_site }}"
        script: |
          param([string] $Site)
          Import-Module WebAdministration
          $Ansible.Changed = $false
          $file = 'C:\\ProgramData\\atk\\previous-thumbprint.txt'
          if (-not (Test-Path -LiteralPath $file)) { return }
          $old = (Get-Content -LiteralPath $file -Raw).Trim()
          $binding = Get-WebBinding -Name $Site -Protocol https | Select-Object -First 1
          if ($binding.certificateHash -ne $old) {
            $binding.AddSslCertificate($old, 'My')
            $Ansible.Changed = $true
          }
`, { vars: vars.split('\n')[0]  }),
  };
}

function certCloudSh(platform          , name        , old         )         {
  const cert = old ? 'CHANGE_OLD_CERT_FILE' : 'CHANGE_CERT_FILE';
  const key = old ? 'CHANGE_OLD_KEY_FILE' : 'CHANGE_KEY_FILE';
  const chain = old ? 'CHANGE_OLD_CHAIN_FILE' : 'CHANGE_CHAIN_FILE';
  const pem = old ? 'CHANGE_OLD_PEM_FILE' : 'CHANGE_PEM_FILE';
  switch (platform) {
    case 'aws':
      return code`for v in ${cert} ${key}; do if [[ -z "$\{!v:-}" || ! -r "$\{!v}" ]]; then change_stop 3 "set $v to a readable PEM file"; fi; done
ARN="$(aws acm list-certificates --query "CertificateSummaryList[?DomainName=='${name}'].CertificateArn | [0]" --output text)"
if [[ -z "$ARN" || "$ARN" == None ]]; then change_stop 5 "no ACM certificate for ${name}"; fi
chain=()
if [[ -n "$\{${chain}:-}" ]]; then chain=(--certificate-chain "fileb://$${chain}"); fi
atk_run aws acm import-certificate --certificate-arn "$ARN" --certificate "fileb://$${cert}" --private-key "fileb://$${key}" "$\{chain[@]}" --output text`;
    case 'azure':
      return code`if [[ -z "$\{${pem}:-}" || ! -r "$\{${pem}}" ]]; then change_stop 3 "set ${pem} to a PEM file holding the key and the certificate chain"; fi
if [[ -z "$\{CHANGE_KEY_VAULT:-}" ]]; then change_stop 3 "set CHANGE_KEY_VAULT to the Key Vault's name"; fi
atk_run az keyvault certificate import --vault-name "$CHANGE_KEY_VAULT" --name ${shq(name.replace(/[^A-Za-z0-9-]/g, '-'))} --file "$${pem}" --output none`;
    case 'google':
      return code`for v in ${cert} ${key}; do if [[ -z "$\{!v:-}" || ! -r "$\{!v}" ]]; then change_stop 3 "set $v to a readable PEM file"; fi; done
atk_run gcloud certificate-manager certificates update ${shq(name.replace(/\./g, '-'))} --location "$\{CHANGE_CERT_LOCATION:-global}" --certificate-file "$${cert}" --private-key-file "$${key}" --quiet`;
    default:
      return '';
  }
}

export const rotateCertificate                = {
  id: 'rotate-certificate',
  label: 'Rotate a certificate',
  category: 'protection',
  description: 'Puts a renewed certificate in place: on the servers (the files and a service reload on Linux; the machine store and the IIS binding on Windows) or in the cloud\'s certificate service (ACM re-import to the same ARN, a new Key Vault version, a Certificate Manager update). The certificate and key come from files named in the environment at run time, never from the bundle.',
  platforms: ALL_PLATFORMS,
  risk: 'medium',
  reversible: true,
  rollback: 'Puts the previous certificate back: the kept files or thumbprint on the servers; in the cloud, the old certificate files named in CHANGE_OLD_* (the service cannot give a private key back).',
  source: 'added',
  inputs: [
    platformInput(ALL_PLATFORMS),
    { id: 'where', label: 'Where', control: 'select', default: 'guest', options: [opt('guest', 'On the servers'), opt('service', 'In the cloud\'s certificate service')] },
    { id: 'name', label: 'Certificate (domain)', control: 'text', default: 'shop.corp.example.com', hint: 'ACM: its domain; Key Vault and Certificate Manager: the name (dots become hyphens).' },
    { ...serverInput('Servers', 'web01'), hint: 'Space-separated.', showWhen: { input: 'where', equals: ['guest'] } },
    osInput(),
    { id: 'cert_path', label: 'Certificate file on the server', control: 'text', default: '/etc/pki/tls/certs/shop.crt', showWhen: { input: 'os', equals: ['linux'] } },
    { id: 'key_path', label: 'Key file on the server', control: 'text', default: '/etc/pki/tls/private/shop.key', showWhen: { input: 'os', equals: ['linux'] } },
    { id: 'service', label: 'Service to reload', control: 'text', default: 'nginx', showWhen: { input: 'os', equals: ['linux'] } },
    { id: 'site', label: 'IIS site', control: 'text', default: 'Default Web Site', showWhen: { input: 'os', equals: ['windows'] } },
    ...VSPHERE_INPUTS,
  ],
  build(values, ctx)                {
    let platform = platformOf(values, rotateCertificate);
    const findings            = [];
    const name = val(values, 'name', 'shop.corp.example.com');
    const where = val(values, 'where', 'guest');
    if (where === 'service' && (platform === 'aws' || platform === 'azure' || platform === 'google')) {
      const notes = platform === 'aws'
        ? 'Run with CHANGE_CERT_FILE, CHANGE_KEY_FILE (and CHANGE_CHAIN_FILE) naming the new PEM files; for a rollback, CHANGE_OLD_CERT_FILE, CHANGE_OLD_KEY_FILE (and CHANGE_OLD_CHAIN_FILE). Re-importing keeps the ARN, so the load balancers keep using it.'
        : platform === 'azure'
          ? 'Run with CHANGE_KEY_VAULT and CHANGE_PEM_FILE (the key and the chain in one PEM); for a rollback, CHANGE_OLD_PEM_FILE. The import is a new version; services that follow the versionless id pick it up.'
          : 'Run with CHANGE_CERT_FILE and CHANGE_KEY_FILE (and CHANGE_CERT_LOCATION if not global); for a rollback, CHANGE_OLD_CERT_FILE and CHANGE_OLD_KEY_FILE.';
      return {
        platform, target: name, route: 'cli', summary: `Rotate the ${name} certificate in ${platform === 'aws' ? 'ACM' : platform === 'azure' ? 'Key Vault' : 'Certificate Manager'}`, files: {}, findings,
        apply: [{ kind: 'sh', title: `Import the new ${name} certificate`, body: certCloudSh(platform, name, false) }],
        rollback: [{ kind: 'sh', title: `Import the previous ${name} certificate again`, body: certCloudSh(platform, name, true) }],
        needs: [CLI_OF[platform]], notes: [notes],
      };
    }
    if (where === 'service') {
      findings.push(warning('change.cert.service', `${PLATFORM_LABELS[platform]}: the certificate is rotated on the servers (OCI Certificates and the VCF load balancers are changed in their consoles).`, { path: 'where' }));
    }
    const servers = val(values, 'server', 'web01').split(/[\s,]+/).filter(Boolean);
    const windows = servers.length > 0 && guestOs(ctx.plan, servers[0] , values) === 'windows';
    const pb = windows ? certWindows(val(values, 'site', 'Default Web Site')) : certLinux(val(values, 'cert_path', '/etc/pki/tls/certs/shop.crt'), val(values, 'key_path', '/etc/pki/tls/private/shop.key'), val(values, 'service', 'nginx'));
    const files = ansibleProject(servers.map((s) => ({ name: s, windows })), { 'certificate.yml': pb.apply, 'previous.yml': pb.back }, windows ? ['ansible.windows'] : []);
    platform = platformOf(values, rotateCertificate);
    return {
      platform, target: name, route: 'ansible', summary: `Rotate the ${name} certificate on ${servers.join(', ')}`, files, findings,
      apply: [{ kind: 'ansible', title: 'Install the new certificate', playbook: 'certificate.yml' }],
      rollback: [{ kind: 'ansible', title: 'Put the previous certificate back', playbook: 'previous.yml' }],
      needs: [],
      notes: [windows
        ? 'Run with CHANGE_PFX_FILE naming the new PFX on the controller; its password is the ansible-vault variable vault_pfx_password.'
        : 'Run with CHANGE_CERT_FILE (the certificate and its chain) and CHANGE_KEY_FILE naming the new files on the controller.'],
    };
  },
};

export const PROTECTION_UTILITIES                           = [snapshotBackup, rotateCertificate];
