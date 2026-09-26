/**
 * Storage utilities (addendum A.9.2): add a disk, extend a disk, add a file
 * share.
 *
 * A disk on a server an app stack manages is a plan update (the workload's
 * `disksGib`) and the stack's diff. Otherwise "add a disk" is its own
 * Terraform (the volume and its attachment, the server found by name), and
 * "extend a disk" is the platform's CLI after a snapshot. Ansible then
 * partitions, formats and mounts the new disk, or grows the partition and
 * the file system (idempotent: a mounted mount point or a full-size
 * partition is left alone).
 */

                                                                 
import { findTerraformBlueprint } from '../../../terraform/blueprints/index.js';
import { code } from '../../plan/execute/lib-sh.js';
import {
  ALL_PLATFORMS, CLI_OF, HYPERSCALERS, NETWORK_INPUTS, OCI_COMPARTMENT_INPUT, PLATFORM_LABELS, RG_INPUT, ROUTE_INPUT, VSPHERE_INPUTS, ZONE_INPUT,
  ansibleProject, appInput, error, guestOs, info, instanceLookup, landingZoneExample, locateSh, locationLocals, locationVars, managingApp, numVal, on, opt, opts,
  osInput, platformInput, platformOf, playbook, psq, routeOf, serverInput, shq, stackChange, tfRoot, val, vcfTool, warning, yq,
                                                                                                    
} from './common.js';

// ---------------------------------------------------------------------------
// Tiers and file systems
// ---------------------------------------------------------------------------

export const DISK_TIERS                                                = {
  aws: ['gp3', 'io2', 'st1', 'sc1'],
  azure: ['Premium_LRS', 'PremiumV2_LRS', 'StandardSSD_LRS', 'Premium_ZRS', 'StandardSSD_ZRS'],
  google: ['pd-balanced', 'pd-ssd', 'hyperdisk-balanced', 'pd-standard'],
  oci: ['balanced', 'higher-performance', 'lower-cost', 'ultra-high-performance'],
  vmware: ['vSAN Default Storage Policy'],
};
const OCI_VPUS                                   = { 'lower-cost': 0, balanced: 10, 'higher-performance': 20, 'ultra-high-performance': 30 };
const FILESYSTEMS = ['xfs', 'ext4', 'ntfs', 'refs']         ;

// ---------------------------------------------------------------------------
// Ansible: prepare a new disk, grow a file system
// ---------------------------------------------------------------------------

function newDiskLinux(mount        , fs        , label        , gib        )         {
  return playbook(`Prepare the new ${gib} GiB disk at ${mount}`, 'atk_change_linux', `    - name: Check whether ${mount} is mounted already
      ansible.builtin.set_fact:
        change_mounted: "{{ ansible_facts.mounts | selectattr('mount', 'equalto', change_mount) | list | length > 0 }}"

    - name: Prepare the disk
      when: not change_mounted
      block:
        - name: Find the new disk (no partitions, no holders, not mounted, the size asked for)
          ansible.builtin.set_fact:
            change_disk: >-
              {%- set found = [] -%}
              {%- for name, d in ansible_facts.devices.items() -%}
              {%- if not d.partitions and not d.holders and (d.sectors | int) * (d.sectorsize | int) == change_bytes
                    and (ansible_facts.mounts | selectattr('device', 'equalto', '/dev/' ~ name) | list | length) == 0 -%}
              {%- set _ = found.append('/dev/' ~ name) -%}
              {%- endif -%}
              {%- endfor -%}
              {{ found | first | default('') }}

        - name: Stop when no such disk is attached
          ansible.builtin.assert:
            that: change_disk | length > 0
            fail_msg: "No unpartitioned {{ change_gib }} GiB disk is attached; check the Terraform step ran."

        - name: Partition the disk (GPT, one partition)
          community.general.parted:
            device: "{{ change_disk }}"
            label: gpt
            number: 1
            state: present
            part_end: 100%

        - name: Create the file system
          community.general.filesystem:
            fstype: "{{ change_fs }}"
            dev: "{{ change_disk }}{{ 'p' if change_disk[-1] is match('[0-9]') else '' }}1"
            opts: "-L {{ change_label }}"

    - name: Mount it (by label, so a device rename after a reboot does not matter)
      ansible.posix.mount:
        path: "{{ change_mount }}"
        src: "LABEL={{ change_label }}"
        fstype: "{{ change_fs }}"
        opts: defaults,nofail
        state: mounted
`, {
    become: true,
    vars: `    change_mount: ${yq(mount)}
    change_fs: ${fs === 'ext4' ? 'ext4' : 'xfs'}
    change_label: ${yq(label)}
    change_gib: ${gib}
    change_bytes: ${gib * 1024 ** 3}`,
  });
}

function newDiskWindows(letter        , fs        , label        , gib        )         {
  return playbook(`Prepare the new ${gib} GiB disk as ${letter}:`, 'atk_change_windows', `    - name: Initialise, partition and format the new disk (skipped when the volume label exists)
      ansible.windows.win_powershell:
        parameters:
          Letter: "{{ change_letter }}"
          Label: "{{ change_label }}"
          FileSystem: "{{ change_fs }}"
          SizeBytes: "{{ change_bytes }}"
        script: |
          param([string] $Letter, [string] $Label, [string] $FileSystem, [long] $SizeBytes)
          $Ansible.Changed = $false
          if (Get-Volume -FileSystemLabel $Label -ErrorAction SilentlyContinue) { return }
          $disk = Get-Disk | Where-Object { $_.PartitionStyle -eq 'RAW' -and $_.Size -eq $SizeBytes } | Sort-Object Number | Select-Object -First 1
          if (-not $disk) { throw "No RAW disk of $SizeBytes bytes is attached; check the Terraform step ran." }
          Initialize-Disk -Number $disk.Number -PartitionStyle GPT
          $part = New-Partition -DiskNumber $disk.Number -UseMaximumSize -DriveLetter $Letter
          Format-Volume -Partition $part -FileSystem $FileSystem -NewFileSystemLabel $Label -Confirm:$false | Out-Null
          $Ansible.Changed = $true
`, {
    vars: `    change_letter: ${yq(letter)}
    change_fs: ${fs === 'refs' ? 'ReFS' : 'NTFS'}
    change_label: ${yq(label)}
    change_bytes: ${gib * 1024 ** 3}`,
  });
}

function releaseDisk(windows         , where        , label        )         {
  if (windows) {
    return playbook(`Take the disk labelled ${label} offline`, 'atk_change_windows', `    - name: Take the volume's disk offline (its data stays until the disk is deleted)
      ansible.windows.win_powershell:
        parameters:
          Label: "{{ change_label }}"
        script: |
          param([string] $Label)
          $Ansible.Changed = $false
          $vol = Get-Volume -FileSystemLabel $Label -ErrorAction SilentlyContinue
          if (-not $vol) { return }
          $disk = $vol | Get-Partition | Get-Disk
          if (-not $disk.IsOffline) {
            Set-Disk -Number $disk.Number -IsOffline $true
            $Ansible.Changed = $true
          }
`, { vars: `    change_label: ${yq(label)}` });
  }
  return playbook(`Unmount ${where}`, 'atk_change_linux', `    - name: Unmount it and remove it from fstab
      ansible.posix.mount:
        path: "{{ change_mount }}"
        state: absent
`, { become: true, vars: `    change_mount: ${yq(where)}` });
}

function growLinux(mount        )         {
  return playbook(`Grow the partition and file system at ${mount}`, 'atk_change_linux', `    - name: Find the device mounted at {{ change_mount }}
      ansible.builtin.set_fact:
        change_dev: "{{ (ansible_facts.mounts | selectattr('mount', 'equalto', change_mount) | first).device }}"

    - name: Rescan the disks
      ansible.builtin.shell: |
        set -e
        for f in /sys/class/block/*/device/rescan; do echo 1 > "$f"; done
      changed_when: false

    - name: Split the device into disk and partition number
      ansible.builtin.set_fact:
        change_part: "{{ change_dev | regex_search('^(/dev/[a-z0-9]+?)(p?)([0-9]+)$', '\\\\1', '\\\\3') }}"
      when: not change_dev.startswith('/dev/mapper/')

    - name: Grow the partition to the end of the disk
      community.general.parted:
        device: "{{ change_part[0] }}"
        number: "{{ change_part[1] | int }}"
        part_end: 100%
        resize: true
        state: present
      when: change_part is defined and change_part | length == 2

    - name: Grow the logical volume and its file system (LVM)
      ansible.builtin.shell: |
        set -euo pipefail
        pv="$(pvs --noheadings -o pv_name -S vg_name="$(lvs --noheadings -o vg_name "{{ change_dev }}" | tr -d ' ')" | head -1 | tr -d ' ')"
        pvresize "$pv"
        lvextend -r -l +100%FREE "{{ change_dev }}" || true
      args:
        executable: /bin/bash
      when: change_dev.startswith('/dev/mapper/')
      changed_when: true

    - name: Grow the file system
      community.general.filesystem:
        fstype: "{{ (ansible_facts.mounts | selectattr('mount', 'equalto', change_mount) | first).fstype }}"
        dev: "{{ change_dev }}"
        resizefs: true
      when: not change_dev.startswith('/dev/mapper/')
`, { become: true, vars: `    change_mount: ${yq(mount)}` });
}

function growWindows(letter        )         {
  return playbook(`Grow ${letter}: to the end of its disk`, 'atk_change_windows', `    - name: Resize the partition to its largest supported size
      ansible.windows.win_powershell:
        parameters:
          Letter: "{{ change_letter }}"
        script: |
          param([string] $Letter)
          $Ansible.Changed = $false
          Update-HostStorageCache
          $part = Get-Partition -DriveLetter $Letter
          $max = (Get-PartitionSupportedSize -DriveLetter $Letter).SizeMax
          if ($part.Size -lt $max) {
            Resize-Partition -DriveLetter $Letter -Size $max
            $Ansible.Changed = $true
          }
`, { vars: `    change_letter: ${yq(letter)}` });
}

// ---------------------------------------------------------------------------
// Add a disk
// ---------------------------------------------------------------------------

function addDiskTf(platform          , server        , gib        , tier        , label        , values                 )                         {
  const t = instanceLookup(platform);
  const vars = [
    ...locationVars(platform, values),
    { name: 'server', type: 'string'         , description: 'The server the disk is for (found by name).', value: server },
    { name: 'size_gib', type: 'number'         , description: 'The disk size, GiB.', value: gib },
    { name: 'disk_type', type: 'string'         , description: 'The disk type (the storage tier).', value: tier },
    { name: 'label', type: 'string'         , description: 'The disk\'s name suffix and file-system label.', value: label },
  ];
  let main        ;
  switch (platform) {
    case 'aws':
      vars.push({ name: 'device', type: 'string', description: 'The device name the volume is attached as.', value: val(values, 'device', '/dev/sdf') });
      main = `${locationLocals(platform)}

${t.hcl}

resource "aws_ebs_volume" "disk" {
  availability_zone = ${t.zone}
  size              = var.size_gib
  type              = var.disk_type
  iops              = var.disk_type == "io2" ? 3000 : null
  encrypted         = true
  kms_key_id        = var.landing_zone.kms_key_id != "" ? var.landing_zone.kms_key_id : null
  tags = {
    Name       = "\${var.server}-\${var.label}"
    atk_server = var.server
  }
}

resource "aws_volume_attachment" "disk" {
  device_name = var.device
  instance_id = ${t.id}
  volume_id   = aws_ebs_volume.disk.id
}`;
      break;
    case 'azure':
      vars.push({ name: 'lun', type: 'number', description: 'The data disk\'s LUN.', value: numVal(values, 'lun', 1) });
      vars.push({ name: 'azure_zone', type: 'string', description: 'The VM\'s availability zone (1, 2 or 3); blank for a regional VM.', value: val(values, 'azure_zone') });
      main = `${locationLocals(platform)}

${t.hcl}

resource "azurerm_managed_disk" "disk" {
  name                 = "\${var.server}-\${var.label}"
  location             = var.landing_zone.location
  resource_group_name  = local.rg
  storage_account_type = var.disk_type
  create_option        = "Empty"
  disk_size_gb         = var.size_gib
  zone                 = var.azure_zone != "" ? var.azure_zone : null
  tags = {
    atk_server = var.server
  }
}

resource "azurerm_virtual_machine_data_disk_attachment" "disk" {
  managed_disk_id    = azurerm_managed_disk.disk.id
  virtual_machine_id = ${t.id}
  lun                = var.lun
  caching            = var.disk_type == "PremiumV2_LRS" ? "None" : "ReadOnly"
}`;
      break;
    case 'google':
      main = `${locationLocals(platform)}

${t.hcl}

resource "google_compute_disk" "disk" {
  name = "\${var.server}-\${var.label}"
  type = var.disk_type
  zone = local.zone
  size = var.size_gib
  labels = {
    atk_server = var.server
  }
}

resource "google_compute_attached_disk" "disk" {
  disk        = google_compute_disk.disk.id
  instance    = ${t.id}
  device_name = var.label
}`;
      break;
    default:
      vars.push({ name: 'vpus_per_gb', type: 'number', description: 'The volume performance units per GB (0 lower cost, 10 balanced, 20 higher performance, 30+ ultra high).', value: OCI_VPUS[tier] ?? 10 });
      main = `${locationLocals(platform)}

${t.hcl}

resource "oci_core_volume" "disk" {
  compartment_id      = var.landing_zone.compartment_id
  availability_domain = ${t.ad}
  display_name        = "\${var.server}-\${var.label}"
  size_in_gbs         = var.size_gib
  vpus_per_gb         = var.vpus_per_gb
  freeform_tags = {
    atk_server = var.server
  }
}

resource "oci_core_volume_attachment" "disk" {
  attachment_type = "paravirtualized"
  instance_id     = ${t.id}
  volume_id       = oci_core_volume.disk.id
}`;
  }
  return tfRoot({ platform, header: `Add a ${gib} GiB ${tier} disk to the server named in var.server (found by name).`, main, variables: vars });
}

function addDiskVcf(server        , gib        , policy        )         {
  return `$name = ${psq(server)}
$vm = Get-ChangeVm -Name $name
$key = "$($name):disk"
$have = Get-AtkId -Path 'change' -Key $key
if ($Mode -eq 'apply') {
  if ($have -and (Get-HardDisk -VM $vm -Server $vc | Where-Object { $_.Filename -eq $have })) {
    Write-AtkLog "$name already has the disk ($have)"
  } else {
    $params = @{ VM = $vm; Server = $vc; CapacityGB = ${gib}; StorageFormat = 'Thin'; Confirm = $false }
    $policy = Get-SpbmStoragePolicy -Server $vc -Name ${psq(policy)} -ErrorAction SilentlyContinue
    if ($policy) { $params.StoragePolicy = $policy }
    $disk = Invoke-AtkStep "add a ${gib} GiB disk to $name" { New-HardDisk @params }
    if ($disk) { Set-AtkId -Path 'change' -Key $key -Value $disk.Filename }
  }
} else {
  if (-not $have) { Stop-Atk 5 "no disk recorded for $($name): apply.sh has not run (or ran with -DryRun)" }
  $disk = Get-HardDisk -VM $vm -Server $vc | Where-Object { $_.Filename -eq $have }
  if (-not $disk) { Write-AtkLog "the disk is gone already" } else { Invoke-AtkStep "remove and delete the added disk of $name" { Remove-HardDisk -HardDisk $disk -DeletePermanently -Confirm:$false } }
}`;
}

export const addDisk                = {
  id: 'add-disk',
  label: 'Add a disk',
  category: 'storage',
  description: 'A new data disk: the volume and its attachment in Terraform (the server found by name), or a plan update and the app stack\'s diff when a stack manages the server; then Ansible partitions, formats and mounts it (Linux: parted, filesystem, mount by label; Windows: Initialize-Disk, New-Partition, Format-Volume).',
  platforms: ALL_PLATFORMS,
  risk: 'low',
  reversible: true,
  rollback: 'Unmounts the disk (Windows: takes it offline), then detaches and deletes it; its data is lost.',
  source: 'A.9.2',
  inputs: [
    platformInput(ALL_PLATFORMS),
    serverInput(),
    osInput(),
    { id: 'size_gib', label: 'Size GiB', control: 'number', default: 100, min: 1, max: 65536 },
    { id: 'tier', label: 'Tier', control: 'combo', default: '', options: [], hint: 'The storage tier; blank: the platform\'s general-purpose SSD.' },
    { id: 'mount', label: 'Mount point / drive letter', control: 'text', default: '/data', hint: 'Linux: a path; Windows: a letter such as E.' },
    { id: 'filesystem', label: 'File system', control: 'select', default: 'xfs', options: opts(FILESYSTEMS) },
    { id: 'label', label: 'Label', control: 'text', default: 'data1', hint: 'The disk name suffix and the file-system label (12 characters at most for xfs).' },
    { id: 'device', label: 'Device', control: 'text', default: '/dev/sdf', ...on('aws') },
    { id: 'lun', label: 'LUN', control: 'number', default: 1, min: 0, max: 63, ...on('azure') },
    { id: 'azure_zone', label: 'Availability zone', control: 'select', default: '', options: [opt('', 'None (regional VM)'), opt('1'), opt('2'), opt('3')], ...on('azure') },
    ...NETWORK_INPUTS, RG_INPUT, ZONE_INPUT, ...VSPHERE_INPUTS,
    ROUTE_INPUT,
  ],
  optionsFor(id, values) {
    if (id !== 'tier') return undefined;
    return DISK_TIERS[platformOf(values, addDisk)].map((t) => opt(t));
  },
  build(values, ctx)                {
    const platform = platformOf(values, addDisk);
    const findings            = [];
    const server = val(values, 'server', 'app01');
    const gib = numVal(values, 'size_gib', 100);
    const tier = val(values, 'tier') || DISK_TIERS[platform][0] ;
    const label = val(values, 'label', 'data1').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 12) || 'data1';
    const windows = guestOs(ctx.plan, server, values) === 'windows';
    const fs = val(values, 'filesystem', windows ? 'ntfs' : 'xfs');
    if (windows !== (fs === 'ntfs' || fs === 'refs')) findings.push(warning('change.disk.filesystem', `${fs} does not suit a ${windows ? 'Windows' : 'Linux'} server; ${windows ? 'NTFS' : 'xfs'} is used.`, { path: 'filesystem' }));
    const mount = val(values, 'mount', windows ? 'E' : '/data');
    const letter = mount.replace(/[:\\/]/g, '').slice(0, 1).toUpperCase() || 'E';
    const prep = windows ? newDiskWindows(letter, fs === 'refs' ? 'refs' : 'ntfs', label, gib) : newDiskLinux(mount.startsWith('/') ? mount : `/${mount}`, fs === 'ext4' ? 'ext4' : 'xfs', label, gib);
    const release = releaseDisk(windows, windows ? letter : mount, label);
    const an = ansibleProject([{ name: server, windows }], { 'disk.yml': prep, 'release.yml': release }, windows ? ['ansible.windows'] : ['community.general', 'ansible.posix']);
    const prepStep             = { kind: 'ansible', title: windows ? `Initialise and format ${letter}:` : `Partition, format and mount ${mount}`, playbook: 'disk.yml' };
    const releaseStep             = { kind: 'ansible', title: windows ? 'Take the disk offline' : `Unmount ${mount}`, playbook: 'release.yml' };
    const managed = managingApp(ctx.plan, server, platform);
    const route = routeOf(values, !!managed, findings);
    if (route === 'plan' && managed && ctx.plan) {
      const w = managed.workload;
      const ops           = [{ op: 'workload-set', id: w.id, from: { disksGib: w.disksGib }, to: { disksGib: [...w.disksGib, gib] } }];
      const sc = stackChange(ctx.plan, ops, managed.appId, platform, ctx);
      findings.push(...sc.findings);
      if (sc.changed) {
        findings.push(info('change.disk.tier-from-design', 'Through the plan, the disk type comes from the design (the tier and criticality of the server).'));
        return {
          platform, target: server, route: 'plan', summary: `Add a ${gib} GiB disk to ${server} at ${mount} through its app stack`, files: { ...sc.files, ...an }, findings,
          apply: [...sc.apply, prepStep], rollback: [releaseStep, ...sc.rollback], needs: [], planOps: ops,
        };
      }
    }
    if (platform === 'vmware') {
      const tool = vcfTool('scripts/disk.ps1', `Add a ${gib} GiB disk to ${server} (apply) or remove it (rollback).`, addDiskVcf(server, gib, val(values, 'tier', DISK_TIERS.vmware[0] )));
      return {
        platform, target: server, route: 'mixed', summary: `Add a ${gib} GiB disk to ${server} at ${mount} (VCF PowerCLI and Ansible)`, files: { 'scripts/disk.ps1': tool, ...an }, findings,
        apply: [{ kind: 'pwsh', title: `Add the disk to ${server}`, file: 'scripts/disk.ps1', args: ['apply'] }, prepStep],
        rollback: [releaseStep, { kind: 'pwsh', title: `Remove the disk from ${server}`, file: 'scripts/disk.ps1', args: ['rollback'] }],
        needs: [],
      };
    }
    const tf = addDiskTf(platform, server, gib, tier, label, values);
    return {
      platform, target: server, route: 'mixed', summary: `Add a ${gib} GiB ${tier} disk to ${server} at ${mount} on ${PLATFORM_LABELS[platform]}`, files: { ...tf, ...an }, findings,
      apply: [{ kind: 'terraform', title: `Create and attach the ${gib} GiB disk`, dir: 'terraform', lz: true }, prepStep],
      rollback: [releaseStep, { kind: 'terraform-destroy', title: 'Detach and delete the disk', dir: 'terraform', lz: true }],
      needs: [],
    };
  },
};

// ---------------------------------------------------------------------------
// Extend a disk
// ---------------------------------------------------------------------------

function extendSh(platform          , disk        , gib        )         {
  const d = shq(disk);
  switch (platform) {
    case 'aws':
      return code`out="$(aws ec2 describe-volumes --filters "Name=attachment.instance-id,Values=$SID" "Name=attachment.device,Values="${d} --query 'Volumes[0].[VolumeId,Size]' --output text)"
VOL="$\{out%%[[:space:]]*}"
SIZE="$\{out##*[[:space:]]}"
if [[ -z "$VOL" || "$VOL" == None ]]; then change_stop 5 "no volume attached to $SERVER as "${d}; fi
if (( SIZE >= ${gib} )); then atk_log "$VOL is already $SIZE GiB"; return 0; fi
atk_run aws ec2 create-snapshot --volume-id "$VOL" --description "before extend $CHANGE_ITEM" --output text
atk_run aws ec2 modify-volume --volume-id "$VOL" --size ${gib} --output text`;
    case 'azure': {
      const tick = '`';
      const q = disk === 'os' ? 'storageProfile.osDisk.managedDisk.id' : `'storageProfile.dataDisks[?lun==${tick}${Number(disk) || 0}${tick}].managedDisk.id | [0]'`;
      return code`DISK_ID="$(az vm show --resource-group "$RG" --name "$SERVER" --query ${q} -o tsv)"
if [[ -z "$DISK_ID" ]]; then change_stop 5 "no disk ${disk} on $SERVER"; fi
SIZE="$(az disk show --ids "$DISK_ID" --query diskSizeGB -o tsv)"
if (( SIZE >= ${gib} )); then atk_log "the disk is already $SIZE GiB"; return 0; fi
atk_run az snapshot create --resource-group "$RG" --name "pre-extend-$\{DISK_ID##*/}" --source "$DISK_ID" --incremental true --output none
atk_run az disk update --ids "$DISK_ID" --size-gb ${gib} --output none`;
    }
    case 'google':
      return code`DISK=${d}
SIZE="$(gcloud compute disks describe "$DISK" --zone "$ZONE" --format='value(sizeGb)')"
if [[ -z "$SIZE" ]]; then change_stop 5 "no disk $DISK in $ZONE"; fi
if (( SIZE >= ${gib} )); then atk_log "$DISK is already $SIZE GiB"; return 0; fi
atk_run gcloud compute disks snapshot "$DISK" --zone "$ZONE" --snapshot-names "pre-extend-$DISK" --quiet
atk_run gcloud compute disks resize "$DISK" --zone "$ZONE" --size ${gib}GB --quiet`;
    case 'oci':
      return code`out="$(oci bv volume list --compartment-id "$COMPARTMENT" --display-name ${d} --lifecycle-state AVAILABLE | jq -r '.data[0] | "\(.id) \(.["size-in-gbs"])"')"
VOL="$\{out%% *}"
SIZE="$\{out##* }"
if [[ -z "$VOL" || "$VOL" == null ]]; then change_stop 5 "no block volume named "${d}; fi
if (( SIZE >= ${gib} )); then atk_log "the volume is already $SIZE GiB"; return 0; fi
atk_run oci bv backup create --volume-id "$VOL" --display-name "pre-extend-$CHANGE_ITEM" --type INCREMENTAL
atk_run oci bv volume update --volume-id "$VOL" --size-in-gbs ${gib} --force`;
    default:
      return '';
  }
}

export const extendDisk                = {
  id: 'extend-disk',
  label: 'Extend a disk',
  category: 'storage',
  description: 'A bigger disk: a plan update and the app stack\'s diff when a stack manages the server, else a snapshot and the platform\'s CLI (aws ec2 modify-volume, az disk update, gcloud compute disks resize, oci bv volume update, Set-HardDisk); then Ansible grows the partition and the file system.',
  platforms: ALL_PLATFORMS,
  risk: 'medium',
  reversible: false,
  rollback: 'A disk cannot be made smaller: rollback.sh names the snapshot taken before the change to restore from (the plan route also puts the plan\'s size back, which Terraform will refuse to shrink).',
  source: 'A.9.2',
  inputs: [
    platformInput(ALL_PLATFORMS),
    serverInput(),
    osInput(),
    { id: 'disk', label: 'Disk', control: 'text', default: '1', hint: 'AWS: the device (/dev/sdf); Azure: the LUN (os for the OS disk); Google Cloud: the disk name; OCI: the volume name; VCF: Hard disk N. Through the plan: the disk\'s number, 0 for the OS disk.' },
    { id: 'size_gib', label: 'New size GiB', control: 'number', default: 200, min: 1, max: 65536 },
    { id: 'mount', label: 'Mount point / drive letter', control: 'text', default: '/data' },
    RG_INPUT, ZONE_INPUT, OCI_COMPARTMENT_INPUT, ...VSPHERE_INPUTS,
    ROUTE_INPUT,
  ],
  build(values, ctx)                {
    const platform = platformOf(values, extendDisk);
    const findings            = [];
    const server = val(values, 'server', 'app01');
    const gib = numVal(values, 'size_gib', 200);
    const disk = val(values, 'disk', '1');
    const windows = guestOs(ctx.plan, server, values) === 'windows';
    const mount = val(values, 'mount', windows ? 'E' : '/data');
    const letter = mount.replace(/[:\\/]/g, '').slice(0, 1).toUpperCase() || 'E';
    const an = ansibleProject([{ name: server, windows }], { 'grow.yml': windows ? growWindows(letter) : growLinux(mount) }, windows ? ['ansible.windows'] : ['community.general']);
    const grow             = { kind: 'ansible', title: `Grow the file system at ${mount}`, playbook: 'grow.yml' };
    const restore             = { kind: 'manual', title: 'Restore the smaller disk if it must be undone', text: `a disk cannot shrink: restore ${server}'s disk ${disk} from the snapshot taken before the change (named pre-extend-…, or the snapshot of the change id)` };
    const managed = managingApp(ctx.plan, server, platform);
    const route = routeOf(values, !!managed, findings);
    if (route === 'plan' && managed && ctx.plan) {
      const w = managed.workload;
      const i = Math.max(0, Math.min(w.disksGib.length - 1, Number(disk) || 0));
      if ((w.disksGib[i] ?? 0) >= gib) findings.push(error('change.disk.smaller', `Disk ${i} of ${server} is ${w.disksGib[i]} GiB already; a disk can only grow.`, { path: 'size_gib' }));
      const next = w.disksGib.map((g, k) => (k === i ? gib : g));
      const ops           = [{ op: 'workload-set', id: w.id, from: { disksGib: w.disksGib }, to: { disksGib: next } }];
      const sc = stackChange(ctx.plan, ops, managed.appId, platform, ctx);
      findings.push(...sc.findings);
      if (sc.changed) {
        return {
          platform, target: server, route: 'plan', summary: `Extend disk ${i} of ${server} to ${gib} GiB through its app stack`, files: { ...sc.files, ...an }, findings,
          apply: [...sc.apply, grow], rollback: [restore], needs: [], planOps: ops,
          notes: ['Rolling the change back on the page puts the plan\'s old size back; Terraform cannot shrink a disk, so restore from a snapshot instead.'],
        };
      }
    }
    if (platform === 'vmware') {
      const body = `$name = ${psq(server)}
$vm = Get-ChangeVm -Name $name
if ($Mode -ne 'apply') { Write-AtkLog 'a disk cannot shrink: restore from a backup'; return }
$disk = Get-HardDisk -VM $vm -Server $vc -Name ${psq(/^\d+$/.test(disk) ? `Hard disk ${Number(disk) + 1}` : disk)} -ErrorAction SilentlyContinue
if (-not $disk) { Stop-Atk 5 "no such disk on $name" }
if (Get-Snapshot -VM $vm -Server $vc -ErrorAction SilentlyContinue) { Stop-Atk 5 "$name has snapshots: a disk with snapshots cannot be extended; consolidate them first" }
if ($disk.CapacityGB -ge ${gib}) { Write-AtkLog "the disk is already $($disk.CapacityGB) GiB" } else { Invoke-AtkStep "extend the disk of $name to ${gib} GiB" { Set-HardDisk -HardDisk $disk -CapacityGB ${gib} -Confirm:$false | Out-Null } }`;
      findings.push(info('change.disk.vcf-snapshot', 'On VCF no snapshot is taken first: a disk with snapshots cannot be extended. Take a backup before.'));
      return {
        platform, target: server, route: 'cli', summary: `Extend a disk of ${server} to ${gib} GiB (VCF PowerCLI)`, files: { 'scripts/extend.ps1': vcfTool('scripts/extend.ps1', `Extend a disk of ${server}.`, body), ...an }, findings,
        apply: [{ kind: 'pwsh', title: `Extend the disk to ${gib} GiB`, file: 'scripts/extend.ps1', args: ['apply'] }, grow],
        rollback: [restore], needs: [],
      };
    }
    const body = `extend_disk() {\n${locateSh(platform, server, values).split('\n').map((l) => `  ${l}`).join('\n')}\n${extendSh(platform, disk, gib).split('\n').map((l) => `  ${l}`).join('\n')}\n}\nextend_disk`;
    return {
      platform, target: server, route: 'cli', summary: `Extend disk ${disk} of ${server} to ${gib} GiB on ${PLATFORM_LABELS[platform]}`, files: an, findings,
      apply: [{ kind: 'sh', title: `Snapshot and extend disk ${disk} to ${gib} GiB`, body }, grow],
      rollback: [restore], needs: [CLI_OF[platform]],
    };
  },
};

// ---------------------------------------------------------------------------
// Add a file share
// ---------------------------------------------------------------------------

const FILE_PLATFORMS                      = HYPERSCALERS;

export const fileShare                = {
  id: 'file-share',
  label: 'Add a file share',
  category: 'storage',
  description: 'A managed file service with its shares in the landing zone: FSx for Windows File Server or FSx for NetApp ONTAP, Azure Files or Azure NetApp Files, Filestore or Google Cloud NetApp Volumes, OCI File Storage (the file-services pattern\'s Terraform).',
  platforms: FILE_PLATFORMS,
  risk: 'low',
  reversible: true,
  rollback: 'Destroys the file service and its shares (terraform destroy); copy the data off first.',
  source: 'A.9.2',
  inputs: [
    platformInput(FILE_PLATFORMS),
    appInput('shop'),
    { id: 'service', label: 'Service', control: 'combo', default: '', options: [], hint: 'Blank: the platform\'s first (FSx for Windows, Azure Files, Filestore, OCI File Storage).' },
    { id: 'protocol', label: 'Protocol', control: 'select', default: 'smb', options: [opt('smb', 'SMB'), opt('nfs', 'NFS'), opt('both', 'SMB and NFS')] },
    { id: 'capacity_gib', label: 'Size GiB', control: 'number', default: 1024, min: 32 },
    { id: 'shares', label: 'Shares', control: 'text', default: 'data', hint: 'Space-separated share names.' },
    { id: 'ad_join', label: 'Join the domain (SMB)', control: 'select', default: 'yes', options: [opt('yes', 'Yes'), opt('no', 'No')] },
    { id: 'domain', label: 'AD domain', control: 'text', default: 'corp.example.com', showWhen: { input: 'ad_join', equals: ['yes'] } },
    { id: 'dns_ips', label: 'Domain controllers', control: 'text', default: '10.0.0.10 10.0.0.11', showWhen: { input: 'ad_join', equals: ['yes'] } },
    { id: 'ad_user', label: 'Join account', control: 'text', default: 'svc-filejoin', hint: 'Its password is a sensitive variable.', showWhen: { input: 'ad_join', equals: ['yes'] } },
    ...NETWORK_INPUTS,
  ],
  optionsFor(id, values) {
    if (id !== 'service') return undefined;
    const p = platformOf(values, fileShare);
    const b = findTerraformBlueprint(`${p}_app_file_service`);
    return b?.inputs.find((i) => i.id === 'service')?.options;
  },
  build(values, ctx)                {
    const platform = platformOf(values, fileShare);
    const findings            = [];
    const lookup = ctx.lookup ?? findTerraformBlueprint;
    const bp = lookup(`${platform}_app_file_service`);
    const app = val(values, 'app', 'shop');
    const protocol = val(values, 'protocol', 'smb');
    if ((platform === 'oci' || (platform === 'google' && val(values, 'service', 'filestore') === 'filestore')) && protocol !== 'nfs') {
      findings.push(warning('change.share.nfs-only', `${PLATFORM_LABELS[platform]}'s ${platform === 'oci' ? 'File Storage' : 'Filestore'} serves NFS only: the share is NFS.`, { path: 'protocol' }));
    }
    if (val(values, 'ad_join', 'yes') === 'no' && protocol !== 'nfs') findings.push(warning('change.share.no-ad', 'An SMB share without a domain has no identity-based access; join it to the domain.', { path: 'ad_join' }));
    const files                         = {};
    if (!bp) {
      findings.push(error('change.share.blueprint', `The file-service blueprint for ${PLATFORM_LABELS[platform]} is not in the toolkit.`));
    } else {
      const v                         = {
        app, component: 'files', network: val(values, 'network', 'prod'), tier: val(values, 'tier', 'app'), protocol: platform === 'oci' ? 'nfs' : protocol,
        capacity_gib: String(numVal(values, 'capacity_gib', 1024)), shares: val(values, 'shares', 'data'), domain: val(values, 'domain', 'corp.example.com'),
        dns_ips: val(values, 'dns_ips', '10.0.0.10 10.0.0.11'), ad_user: val(values, 'ad_user', 'svc-filejoin'), landing_zone_source: 'variables',
        ...(val(values, 'service') ? { service: val(values, 'service') } : {}),
      };
      const r = bp.build(v, 'change');
      findings.push(...(r.findings ?? []));
      for (const [f, t] of Object.entries(r.files)) files[`terraform/${f}`] = t;
      files['terraform/landing_zone.auto.tfvars.json.example'] = landingZoneExample(platform === 'azure' ? 'azure' : platform         );
    }
    return {
      platform, target: `${app}-files`, route: 'terraform', summary: `Add a ${numVal(values, 'capacity_gib', 1024)} GiB ${protocol.toUpperCase()} file service for ${app} (${val(values, 'shares', 'data')}) on ${PLATFORM_LABELS[platform]}`,
      files, findings,
      apply: [{ kind: 'terraform', title: 'Create the file service and its shares', dir: 'terraform', lz: true }],
      rollback: [{ kind: 'terraform-destroy', title: 'Destroy the file service', dir: 'terraform', lz: true }],
      needs: [],
      notes: ['VCF: vSAN File Service shares have no Terraform resource; create them in vCenter (a runbook step), so this utility does not offer VCF.'],
    };
  },
};

export const STORAGE_UTILITIES                           = [addDisk, extendDisk, fileShare];
