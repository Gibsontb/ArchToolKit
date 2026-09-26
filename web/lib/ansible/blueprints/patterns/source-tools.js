/**
 * mig_source_tools: what a replication tool leaves behind when the
 * hypervisor changes (addendum A.3.5), run after cutover on replicated hosts.
 *
 * The replication tools adapt the guest so it boots (AWS MGN injects ENA and
 * NVMe drivers, Azure Migrate puts the hv_* drivers in the initramfs, Migrate
 * to Virtual Machines adds virtio and gVNIC and removes VMware Tools). What
 * none of them promise, this play does:
 *
 *   - removes the source platform's guest tools: VMware Tools / open-vm-tools,
 *     the Hyper-V daemons on Linux (Integration Services are part of Windows
 *     Server 2016 and later, so nothing to remove there), Nutanix Guest
 *     Tools, XenServer / Citrix VM Tools, and the QEMU guest agent when the
 *     host has moved to vSphere; each kept where the target platform needs it
 *     (open-vm-tools on vSphere, the Hyper-V daemons on Azure);
 *   - removes the replication agents after cutover (the AWS Replication
 *     Agent, the Azure Site Recovery / Azure Migrate Mobility service);
 *   - on a host that moved *to* vSphere (HCX OSAM, VCF Converter), installs
 *     open-vm-tools or VMware Tools;
 *   - keeps the target platform's storage and network drivers in the
 *     initramfs, so a kernel update does not drop what the tool injected;
 *   - drops the old NIC's identity: the stale persistent-net udev rule, and
 *     HWADDR / mac-address lines naming a MAC this host no longer has;
 *   - on Windows, removes the source platform's non-present (ghost) network
 *     and storage adapters, which otherwise hold the old static address.
 *
 * Google Migrate to Virtual Machines and OCI Oracle Cloud Migrations replicate
 * without an agent in the guest, so there is nothing of theirs to remove.
 */

                                                                
import { CLOUD_PLATFORM,                      } from '../../migration/roles/types.js';
import { MIGRATION_GROUP, PLATFORM_INPUT, text, yes } from '../migration/common.js';
import { LINUX, WINDOWS, patternBlueprint, select, YES_NO } from './common.js';

/** One kind of guest software, and where it stays. */
                             
                        
                                                                                                     
                                                                             
                                       
                                     
                                            
                                                        
                                              
                                                      
                                              
 

export const SOURCE_TOOLS                        = [
  {
    name: 'VMware Tools',
    source: 'vmware',
    keepOn: ['vmware'],
    linuxPackages: ['open-vm-tools', 'open-vm-tools-desktop', 'open-vm-tools-sdmp'],
    // The tarball install of VMware Tools, where it predates open-vm-tools.
    linuxUninstall: ['/usr/bin/vmware-uninstall-tools.pl'],
    windowsPrograms: ['VMware Tools'],
  },
  {
    name: 'Hyper-V daemons',
    source: 'hyperv',
    keepOn: ['azure'],
    linuxPackages: ['hyperv-daemons', 'hyperv-daemons-license', 'hypervkvpd', 'hypervvssd', 'hypervfcopyd', 'hyper-v'],
    windowsPrograms: [],
  },
  {
    name: 'Nutanix Guest Tools',
    source: 'nutanix',
    keepOn: [],
    linuxPackages: [],
    linuxUninstall: ['/usr/local/nutanix/ngt/python/bin/uninstall_ngt.py'],
    // Not "Nutanix VirtIO": those drivers serve the KVM clouds too.
    windowsPrograms: ['Nutanix Guest Tools*', 'Nutanix Guest Agent*'],
  },
  {
    name: 'XenServer / Citrix VM Tools',
    source: 'xen',
    keepOn: [],
    linuxPackages: ['xe-guest-utilities', 'xe-guest-utilities-xenstore', 'xen-guest-agent'],
    windowsPrograms: ['XenServer VM Tools*', 'Citrix VM Tools*', 'Citrix XenServer Windows Management Agent*', 'XenServer Windows Management Agent*'],
  },
  {
    name: 'QEMU guest agent',
    source: 'kvm',
    // Needed on the KVM-based clouds; only a host now on vSphere or Azure loses it.
    keepOn: ['aws', 'google', 'oci'],
    linuxPackages: ['qemu-guest-agent'],
    windowsPrograms: ['QEMU guest agent*'],
  },
  {
    name: 'AWS Replication Agent (Application Migration Service)',
    source: 'agent',
    keepOn: [],
    linuxPackages: [],
    linuxUninstall: ['/var/lib/aws-replication-agent/uninstall-agent.sh'],
    windowsPrograms: ['AWS Replication Agent*'],
  },
  {
    name: 'Azure Site Recovery / Azure Migrate Mobility service',
    source: 'agent',
    keepOn: [],
    linuxPackages: [],
    linuxUninstall: ['/usr/local/ASR/uninstall.sh', '-Y'],
    windowsPrograms: ['Microsoft Azure Site Recovery Mobility Service*'],
  },
];

/** The target platform's storage and network drivers, kept in the initramfs. */
export const TARGET_DRIVERS                                              = {
  aws: ['nvme', 'nvme_core', 'ena'],
  azure: ['hv_vmbus', 'hv_storvsc', 'hv_netvsc'],
  google: ['virtio_pci', 'virtio_scsi', 'virtio_net', 'nvme', 'gve'],
  oci: ['virtio_pci', 'virtio_blk', 'virtio_scsi', 'virtio_net'],
  vmware: ['vmw_pvscsi', 'vmxnet3'],
};

/** Ghost adapters of each source platform (Windows, FriendlyName), and the targets that keep that hardware. */
const GHOSTS                                                                                                       = [
  { source: 'vmware', pattern: 'vmxnet|VMware', keepOn: ['vmware'] },
  { source: 'hyperv', pattern: 'Hyper-V', keepOn: ['azure'] },
  { source: 'nutanix', pattern: 'Nutanix|VirtIO', keepOn: ['google', 'oci'] },
  { source: 'xen', pattern: 'XenServer|Citrix|Xen ', keepOn: [] },
  { source: 'kvm', pattern: 'VirtIO|Red Hat', keepOn: ['google', 'oci'] },
];

const RH = "ansible_facts.os_family in ['RedHat', 'Suse']";
const DEB = "ansible_facts.os_family == 'Debian'";
/** The tools that go from this host (source_tools_selected: the chosen source's, not kept by the target). */
const TOOL_LOOP = { loop: '{{ source_tools_selected }}', loop_control: { label: '{{ item.name }}' } };

/** Remove Windows programs by DisplayName: MSI by product code, anything else by its quiet uninstall string. */
const UNINSTALL_BY_NAME = `param([string[]]$Names)
$roots = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
$found = Get-ItemProperty -Path $roots -ErrorAction SilentlyContinue | Where-Object { $n = $_.DisplayName; $n -and ($Names | Where-Object { $n -like $_ }) }
$removed = @(); $skipped = @(); $reboot = $false
$Ansible.Changed = $false
foreach ($entry in $found) {
  if ($entry.PSChildName -match '^\\{[0-9A-Fa-f-]+\\}$') {
    $p = Start-Process -FilePath msiexec.exe -ArgumentList '/x', $entry.PSChildName, '/qn', '/norestart' -Wait -PassThru
    $code = $p.ExitCode
  } elseif ($entry.QuietUninstallString) {
    $p = Start-Process -FilePath cmd.exe -ArgumentList '/c', $entry.QuietUninstallString -Wait -PassThru
    $code = $p.ExitCode
  } else {
    $skipped += $entry.DisplayName
    continue
  }
  if ($code -notin 0, 1605, 1641, 3010) { throw "Removing $($entry.DisplayName) failed: $code" }
  if ($code -in 1641, 3010) { $reboot = $true }
  $removed += $entry.DisplayName
  $Ansible.Changed = $true
}
$Ansible.Result = @{ removed = $removed; skipped = $skipped; reboot = $reboot }`;

/**
 * Remove non-present network and storage adapters whose name belongs to a
 * source platform (pnputil /remove-device: Windows Server 2022 and later).
 */
const REMOVE_GHOSTS = `param([string]$Pattern)
$Ansible.Changed = $false
$removed = @()
if ([Environment]::OSVersion.Version.Build -lt 20348) { $Ansible.Result = @{ removed = $removed; note = 'pnputil /remove-device needs Windows Server 2022 or later; ghost adapters left.' }; return }
$ghosts = Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { -not $_.Present -and $_.Class -in 'Net', 'SCSIAdapter' -and $_.FriendlyName -match $Pattern }
foreach ($d in $ghosts) {
  & pnputil.exe /remove-device $d.InstanceId | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "pnputil /remove-device $($d.InstanceId) failed: $LASTEXITCODE" }
  $removed += $d.FriendlyName
  $Ansible.Changed = $true
}
$Ansible.Result = @{ removed = $removed }`;

const linuxTasks         = [
  { name: 'Read the installed packages', 'ansible.builtin.package_facts': { manager: 'auto' } },
  {
    name: 'Remove the source platform tools and replication agents (packages)',
    'ansible.builtin.package': { name: "{{ item.linux_packages | select('in', ansible_facts.packages) | list }}", state: 'absent' },
    ...TOOL_LOOP,
    when: "item.linux_packages | select('in', ansible_facts.packages) | list | length > 0",
  },
  {
    name: 'Run their uninstallers where they were installed without a package',
    'ansible.builtin.command': { argv: '{{ item.linux_uninstall }}', removes: '{{ item.linux_uninstall | first }}' },
    ...TOOL_LOOP,
    when: 'item.linux_uninstall | length > 0',
  },
  {
    name: 'Install open-vm-tools on a host that moved to vSphere',
    'ansible.builtin.package': { name: 'open-vm-tools', state: 'present' },
    when: "cloud_platform == 'vmware'",
  },
  {
    name: 'Keep open-vm-tools running on vSphere',
    'ansible.builtin.service': { name: "{{ 'open-vm-tools' if ansible_facts.os_family == 'Debian' else 'vmtoolsd' }}", state: 'started', enabled: true },
    when: ["cloud_platform == 'vmware'", 'not ansible_check_mode'],
  },
  // --- the target's drivers in the initramfs -------------------------------
  {
    name: "Find which of the target platform's drivers this kernel has",
    'ansible.builtin.command': { argv: ['modinfo', '-n', '{{ item }}'] },
    loop: '{{ source_tools_drivers[cloud_platform] | default([]) }}',
    register: 'source_tools_modinfo',
    changed_when: false,
    failed_when: false,
    check_mode: false,
    when: 'source_tools_fix_drivers | bool',
  },
  {
    name: 'Keep them in the initramfs (dracut)',
    'ansible.builtin.copy': {
      dest: '/etc/dracut.conf.d/90-target-platform-drivers.conf',
      content: 'add_drivers+=" {{ source_tools_present_drivers | join(\' \') }} "\n',
      owner: 'root',
      group: 'root',
      mode: '0644',
    },
    when: ['source_tools_fix_drivers | bool', RH, 'source_tools_present_drivers | length > 0'],
    notify: 'Rebuild the initramfs (dracut)',
  },
  {
    name: 'Keep them in the initramfs (initramfs-tools)',
    'ansible.builtin.lineinfile': { path: '/etc/initramfs-tools/modules', line: '{{ item }}', create: true, owner: 'root', group: 'root', mode: '0644' },
    loop: '{{ source_tools_present_drivers }}',
    when: ['source_tools_fix_drivers | bool', DEB],
    notify: 'Rebuild the initramfs (initramfs-tools)',
  },
  // --- the old NIC's identity ------------------------------------------------
  {
    name: 'Drop the persistent-net rule that pins the old NIC',
    'ansible.builtin.file': { path: '/etc/udev/rules.d/70-persistent-net.rules', state: 'absent' },
    when: 'source_tools_fix_network | bool',
  },
  {
    name: 'Find interface configurations that name a MAC address',
    'ansible.builtin.find': {
      paths: ['/etc/sysconfig/network-scripts', '/etc/sysconfig/network', '/etc/NetworkManager/system-connections'],
      patterns: ['ifcfg-*', '*.nmconnection'],
      contains: '(?im)^(HWADDR|mac-address)=',
      read_whole_file: true,
    },
    register: 'source_tools_nic_files',
    when: ['source_tools_fix_network | bool', 'source_tools_macs | length > 0'],
  },
  {
    name: 'Drop MAC addresses this host no longer has from them',
    'ansible.builtin.replace': {
      path: '{{ item.path }}',
      regexp: "{{ '(?im)^(HWADDR|mac-address)=\"?(?!(' ~ (source_tools_macs | map('regex_escape') | join('|')) ~ ')\"?$).*\\n' }}",
      replace: '',
    },
    loop: '{{ source_tools_nic_files.files | default([]) }}',
    loop_control: { label: '{{ item.path }}' },
    when: ['source_tools_fix_network | bool', 'source_tools_macs | length > 0'],
  },
];

const windowsTasks         = [
  {
    name: 'Remove the source platform tools and replication agents',
    'ansible.windows.win_powershell': { script: UNINSTALL_BY_NAME, parameters: { Names: '{{ source_tools_windows_remove }}' } },
    register: 'source_tools_removed',
    when: 'source_tools_windows_remove | length > 0',
  },
  {
    name: 'Say what has no quiet uninstaller and is left for a person',
    'ansible.builtin.debug': { msg: 'Left installed (no MSI product code or quiet uninstall string): {{ source_tools_removed.result.skipped | join(", ") }}' },
    when: 'source_tools_removed.result.skipped | default([]) | length > 0',
  },
  {
    name: 'Install VMware Tools on a host that moved to vSphere',
    'ansible.windows.win_package': {
      path: '{{ source_tools_vmware_tools_installer }}',
      arguments: '/S /v "/qn REBOOT=R"',
      creates_service: 'VMTools',
      state: 'present',
    },
    register: 'source_tools_vmware_tools',
    when: ["cloud_platform == 'vmware'", "source_tools_vmware_tools_installer | length > 0"],
  },
  {
    name: 'Say where VMware Tools comes from when no installer is named',
    'ansible.builtin.debug': { msg: 'Mount VMware Tools from vCenter (Guest OS > Install VMware Tools) or set source_tools_vmware_tools_installer to setup64.exe.' },
    when: ["cloud_platform == 'vmware'", 'source_tools_vmware_tools_installer | length == 0'],
  },
  {
    name: 'Install or update the virtio-win drivers (OCI)',
    'ansible.windows.win_package': { path: '{{ source_tools_virtio_win_msi }}', arguments: ['/qn', '/norestart'], state: 'present' },
    register: 'source_tools_virtio',
    when: ["cloud_platform == 'oci'", 'source_tools_virtio_win_msi | length > 0', 'source_tools_fix_drivers | bool'],
  },
  {
    name: "Remove the source platform's ghost network and storage adapters",
    'ansible.windows.win_powershell': { script: REMOVE_GHOSTS, parameters: { Pattern: '{{ source_tools_ghost_pattern }}' } },
    when: ['source_tools_fix_network | bool', 'source_tools_ghost_pattern | length > 0'],
  },
  {
    name: 'Reboot when a removal or install asks for it',
    'ansible.windows.win_reboot': { reboot_timeout: 1800 },
    when: [
      'source_tools_reboot | bool',
      '(source_tools_removed.result.reboot | default(false)) or (source_tools_vmware_tools.reboot_required | default(false)) or (source_tools_virtio.reboot_required | default(false))',
    ],
  },
];

export const SOURCE_TOOLS_ROLE       = {
  name: 'source_tools',
  description: "the source platform's guest tools and the replication agents removed after cutover, the target's drivers kept, the old NIC identity dropped.",
  tasks: [
    { name: 'Linux guests', when: LINUX, become: true, block: linuxTasks },
    { name: 'Windows guests', when: WINDOWS, block: windowsTasks },
  ],
  handlers: [
    { name: 'Rebuild the initramfs (dracut)', 'ansible.builtin.command': { argv: ['dracut', '--force', '--regenerate-all'] }, become: true, changed_when: true },
    { name: 'Rebuild the initramfs (initramfs-tools)', 'ansible.builtin.command': { argv: ['update-initramfs', '-u', '-k', 'all'] }, become: true, changed_when: true },
  ],
  defaults: {
    source_tools_source: 'auto',
    source_tools_remove_agents: true,
    source_tools_fix_drivers: true,
    source_tools_fix_network: true,
    source_tools_reboot: true,
    source_tools_vmware_tools_installer: '',
    source_tools_virtio_win_msi: '',
  },
  derived: {
    cloud_platform: CLOUD_PLATFORM,
    source_tools_catalog: SOURCE_TOOLS.map((t) => ({
      name: t.name,
      source: t.source,
      keep_on: [...t.keepOn],
      linux_packages: [...t.linuxPackages],
      linux_uninstall: [...(t.linuxUninstall ?? [])],
      windows_programs: [...t.windowsPrograms],
    })),
    source_tools_drivers: Object.fromEntries(Object.entries(TARGET_DRIVERS).map(([k, v]) => [k, [...v]])),
    source_tools_present_drivers:
      "{{ source_tools_modinfo.results | default([]) | selectattr('rc', 'defined') | selectattr('rc', 'equalto', 0) | map(attribute='item') | list }}",
    source_tools_macs:
      "{{ ansible_facts.interfaces | default([]) | map('replace', '-', '_') | select('in', ansible_facts) | map('extract', ansible_facts) | selectattr('macaddress', 'defined') | map(attribute='macaddress') | map('lower') | unique | list }}",
    source_tools_sources: "{{ ['vmware', 'hyperv', 'nutanix', 'xen', 'kvm'] if source_tools_source == 'auto' else [source_tools_source] }}",
    source_tools_selected:
      "{{ ((source_tools_catalog | rejectattr('source', 'equalto', 'agent') | selectattr('source', 'in', source_tools_sources) | list) + ((source_tools_catalog | selectattr('source', 'equalto', 'agent') | list) if source_tools_remove_agents | bool else [])) | rejectattr('keep_on', 'contains', cloud_platform) | list }}",
    source_tools_windows_remove: "{{ source_tools_selected | map(attribute='windows_programs') | flatten }}",
    source_tools_ghosts: GHOSTS.map((g) => ({ source: g.source, pattern: g.pattern, keep_on: [...g.keepOn] })),
    source_tools_ghost_pattern:
      "{{ source_tools_ghosts | selectattr('source', 'in', source_tools_sources) | rejectattr('keep_on', 'contains', cloud_platform) | map(attribute='pattern') | join('|') }}",
  },
};

export const SOURCE_INPUT = select(
  'source',
  'Source platform',
  [
    ['auto', 'Any (remove every source platform tool found)'],
    ['vmware', 'VMware vSphere / VCF'],
    ['hyperv', 'Microsoft Hyper-V'],
    ['nutanix', 'Nutanix AHV'],
    ['xen', 'XenServer / Citrix Hypervisor'],
    ['kvm', 'KVM / OpenStack'],
  ],
  'auto',
  { hint: 'The tools of the other platforms are left alone; the target platform always keeps its own' },
);

export const MIG_SOURCE_TOOLS = patternBlueprint({
  id: 'mig_source_tools',
  label: 'Migration – Source platform tools after cutover',
  description:
    "After a replication tool's cutover: remove the source platform's guest tools (VMware Tools / open-vm-tools, the Hyper-V daemons, Nutanix Guest Tools, XenServer / Citrix VM Tools, the QEMU guest agent on vSphere) and the replication agents (AWS Replication Agent, Azure Mobility service), keep the target's storage and network drivers in the initramfs, drop the old NIC identity (persistent-net rule, stale HWADDR / mac-address lines, Windows ghost adapters), and install VMware Tools on hosts that moved to vSphere. The target platform keeps its own tools.",
  group: MIGRATION_GROUP,
  hosts: { default: 'method_replicate', hint: 'Replicated hosts, after cutover (inventory group method_replicate)' },
  inputs: [
    PLATFORM_INPUT,
    SOURCE_INPUT,
    select('remove_agents', 'Remove the replication agents', YES_NO, 'true', { hint: 'AWS Replication Agent, Azure Site Recovery / Azure Migrate Mobility service' }),
    select('fix_drivers', "Keep the target's drivers in the initramfs", YES_NO, 'true'),
    select('fix_network', 'Drop the old NIC identity', YES_NO, 'true', { hint: 'udev persistent-net rule, stale MACs, Windows ghost adapters' }),
    select('reboot', 'Reboot Windows when a removal asks for it', YES_NO, 'true'),
    { id: 'vmware_tools_installer', label: 'VMware Tools installer (Windows, to vSphere)', control: 'text', default: '', placeholder: '\\\\share\\vmware-tools\\setup64.exe', hint: 'Only for hosts that moved to vSphere; empty = mount it from vCenter', showWhen: { input: 'platform', equals: ['vmware'] } },
    { id: 'virtio_win_msi', label: 'virtio-win MSI (Windows, OCI)', control: 'text', default: '', placeholder: 'https://…/virtio-win-gt-x64.msi', hint: 'Keeps the virtio drivers current on OCI; empty = leave them as installed before replication', showWhen: { input: 'platform', equals: ['oci'] } },
  ],
  roles: () => [SOURCE_TOOLS_ROLE],
  vars: (v                ) => ({
    mig_cloud_platform: text(v.platform, 'aws'),
    mig_source_tools_source: text(v.source, 'auto'),
    mig_source_tools_remove_agents: yes(v.remove_agents ?? 'true'),
    mig_source_tools_fix_drivers: yes(v.fix_drivers ?? 'true'),
    mig_source_tools_fix_network: yes(v.fix_network ?? 'true'),
    mig_source_tools_reboot: yes(v.reboot ?? 'true'),
    mig_source_tools_vmware_tools_installer: text(v.vmware_tools_installer),
    mig_source_tools_virtio_win_msi: text(v.virtio_win_msi),
  }),
});
