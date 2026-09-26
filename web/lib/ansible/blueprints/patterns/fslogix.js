/**
 * app_fslogix: FSLogix profile containers on the session hosts of a VDI
 * pattern (addendum A.4.2, VDI: AVD, or session hosts with Horizon / Citrix).
 *
 * FSLogix Apps installed when its service is missing (Microsoft's download
 * link, or the installer named), then the profile container settings as
 * registry values (HKLM\SOFTWARE\FSLogix\Profiles, ansible.windows.win_regedit):
 * Enabled, VHDLocations (or CCDLocations for Cloud Cache), VolumeType,
 * SizeInMBs, IsDynamic, ProfileType, DeleteLocalProfileWhenVHDShouldApply,
 * FlipFlopProfileDirectoryName, PreventLoginWithFailure /
 * PreventLoginWithTempProfile; optionally the Office container (ODFC); the
 * Microsoft Entra Kerberos settings for Azure Files with Entra-joined hosts;
 * and the Microsoft Defender exclusions FSLogix documents for its disks.
 *
 * Settings: https://learn.microsoft.com/en-us/fslogix/reference-configuration-settings
 * Defender exclusions: https://learn.microsoft.com/en-us/fslogix/overview-prerequisites#antivirus-exclusions
 * Entra Kerberos: https://learn.microsoft.com/en-us/azure/virtual-desktop/create-profile-container-azure-ad
 *
 * No secret: the share is reached as the user (AD DS or Entra Kerberos), so
 * there is no storage key to keep.
 */

                                                                
                                                                 
import { list, number, text, yes } from '../migration/common.js';
import { patternBlueprint, select, YES_NO } from './common.js';

const PROFILES = 'HKLM:\\SOFTWARE\\FSLogix\\Profiles';
const ODFC = 'HKLM:\\SOFTWARE\\Policies\\FSLogix\\ODFC';
const PRESENT_IF = (condition        )         => `{{ 'present' if ${condition} else 'absent' }}`;

/** name, type, data, state: one registry value each. */
const REGISTRY = [
  { path: PROFILES, name: 'Enabled', type: 'dword', data: 1, state: 'present' },
  { path: PROFILES, name: 'VHDLocations', type: 'multistring', data: '{{ fslogix_locations }}', state: PRESENT_IF("fslogix_storage == 'vhd-locations'") },
  { path: PROFILES, name: 'CCDLocations', type: 'multistring', data: '{{ fslogix_ccd_locations }}', state: PRESENT_IF("fslogix_storage == 'cloud-cache'") },
  { path: PROFILES, name: 'VolumeType', type: 'string', data: '{{ fslogix_volume_type }}', state: 'present' },
  { path: PROFILES, name: 'SizeInMBs', type: 'dword', data: '{{ (fslogix_size_gib | int) * 1024 }}', state: 'present' },
  { path: PROFILES, name: 'IsDynamic', type: 'dword', data: 1, state: 'present' },
  { path: PROFILES, name: 'ProfileType', type: 'dword', data: '{{ fslogix_profile_type | int }}', state: 'present' },
  { path: PROFILES, name: 'DeleteLocalProfileWhenVHDShouldApply', type: 'dword', data: '{{ fslogix_delete_local_profile | bool | int }}', state: 'present' },
  { path: PROFILES, name: 'FlipFlopProfileDirectoryName', type: 'dword', data: '{{ fslogix_flip_flop | bool | int }}', state: 'present' },
  { path: PROFILES, name: 'PreventLoginWithFailure', type: 'dword', data: '{{ fslogix_prevent_temp_profile | bool | int }}', state: 'present' },
  { path: PROFILES, name: 'PreventLoginWithTempProfile', type: 'dword', data: '{{ fslogix_prevent_temp_profile | bool | int }}', state: 'present' },
  { path: PROFILES, name: 'ClearCacheOnLogoff', type: 'dword', data: 1, state: PRESENT_IF("fslogix_storage == 'cloud-cache'") },
  { path: ODFC, name: 'Enabled', type: 'dword', data: 1, state: PRESENT_IF('fslogix_office_container | bool') },
  { path: ODFC, name: 'VHDLocations', type: 'multistring', data: '{{ fslogix_office_locations }}', state: PRESENT_IF("fslogix_office_container | bool and fslogix_storage == 'vhd-locations'") },
  { path: ODFC, name: 'CCDLocations', type: 'multistring', data: '{{ fslogix_office_ccd_locations }}', state: PRESENT_IF("fslogix_office_container | bool and fslogix_storage == 'cloud-cache'") },
  { path: ODFC, name: 'VolumeType', type: 'string', data: '{{ fslogix_volume_type }}', state: PRESENT_IF('fslogix_office_container | bool') },
  { path: ODFC, name: 'FlipFlopProfileDirectoryName', type: 'dword', data: '{{ fslogix_flip_flop | bool | int }}', state: PRESENT_IF('fslogix_office_container | bool') },
  // Entra-joined hosts reaching Azure Files through Microsoft Entra Kerberos.
  { path: 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Lsa\\Kerberos\\Parameters', name: 'CloudKerberosTicketRetrievalEnabled', type: 'dword', data: 1, state: PRESENT_IF("fslogix_auth == 'entra-kerberos'") },
  { path: 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\AzureADAccount', name: 'LoadCredKeyFromProfile', type: 'dword', data: 1, state: PRESENT_IF("fslogix_auth == 'entra-kerberos'") },
];

/** Defender exclusions for the FSLogix disks, added only where missing. */
const DEFENDER = `param([string[]]$Paths, [string[]]$Processes)
$Ansible.Changed = $false
if (-not (Get-Command Add-MpPreference -ErrorAction SilentlyContinue)) { return }
$pref = Get-MpPreference
$missing = @($Paths | Where-Object { $pref.ExclusionPath -notcontains $_ })
$missingProc = @($Processes | Where-Object { $pref.ExclusionProcess -notcontains $_ })
if ($missing.Count -gt 0) { Add-MpPreference -ExclusionPath $missing; $Ansible.Changed = $true }
if ($missingProc.Count -gt 0) { Add-MpPreference -ExclusionProcess $missingProc; $Ansible.Changed = $true }`;

const tasks         = [
  {
    name: 'Check the profile share is named',
    'ansible.builtin.assert': {
      that: ['fslogix_locations | length > 0'],
      fail_msg: 'Set the profile share (fslogix_locations), e.g. \\\\account.file.core.windows.net\\profiles.',
      quiet: true,
    },
  },
  { name: 'Look for the FSLogix service', 'ansible.windows.win_service_info': { name: 'frxsvc' }, register: 'fslogix_service' },
  {
    name: 'Install FSLogix Apps',
    when: 'not fslogix_service.exists',
    block: [
      {
        name: 'Fetch FSLogix',
        'ansible.windows.win_get_url': { url: '{{ fslogix_installer }}', dest: 'C:\\Windows\\Temp\\FSLogix_Apps.zip' },
        when: "fslogix_installer is match('https?://') and fslogix_installer is not match('.*\\.exe$')",
      },
      {
        name: 'Unpack it',
        'community.windows.win_unzip': { src: 'C:\\Windows\\Temp\\FSLogix_Apps.zip', dest: 'C:\\Windows\\Temp\\FSLogix_Apps', creates: 'C:\\Windows\\Temp\\FSLogix_Apps\\x64\\Release\\FSLogixAppsSetup.exe' },
        when: "fslogix_installer is match('https?://') and fslogix_installer is not match('.*\\.exe$')",
      },
      {
        name: 'Run the installer',
        'ansible.windows.win_package': {
          path: "{{ 'C:\\\\Windows\\\\Temp\\\\FSLogix_Apps\\\\x64\\\\Release\\\\FSLogixAppsSetup.exe' if (fslogix_installer is match('https?://') and fslogix_installer is not match('.*\\.exe$')) else fslogix_installer }}",
          arguments: ['/install', '/quiet', '/norestart'],
          creates_service: 'frxsvc',
          state: 'present',
        },
        register: 'fslogix_install',
      },
    ],
  },
  {
    name: 'Set the FSLogix profile container settings',
    'ansible.windows.win_regedit': { path: '{{ item.path }}', name: '{{ item.name }}', type: '{{ item.type }}', data: '{{ item.data }}', state: '{{ item.state }}' },
    loop: '{{ fslogix_registry }}',
    loop_control: { label: '{{ item.path }}\\{{ item.name }} ({{ item.state }})' },
  },
  {
    name: 'Exclude the FSLogix disks from Microsoft Defender',
    'ansible.windows.win_powershell': { script: DEFENDER, parameters: { Paths: '{{ fslogix_defender_paths }}', Processes: '{{ fslogix_defender_processes }}' } },
    when: 'fslogix_defender_exclusions | bool',
  },
  { name: 'Keep the FSLogix service running', 'ansible.windows.win_service': { name: 'frxsvc', state: 'started', start_mode: 'auto' }, when: 'not ansible_check_mode' },
  {
    name: 'Reboot when the install asks for it',
    'ansible.windows.win_reboot': { reboot_timeout: 1800 },
    when: 'fslogix_install.reboot_required | default(false)',
  },
];

export const FSLOGIX_ROLE       = {
  name: 'fslogix',
  description: 'FSLogix Apps installed, profile (and Office) containers configured in the registry, Defender exclusions.',
  tasks,
  defaults: {
    fslogix_locations: [],
    fslogix_storage: 'vhd-locations',
    fslogix_volume_type: 'VHDX',
    fslogix_size_gib: 30,
    fslogix_profile_type: 0,
    fslogix_delete_local_profile: true,
    fslogix_flip_flop: true,
    fslogix_prevent_temp_profile: true,
    fslogix_office_container: false,
    fslogix_auth: 'ad',
    fslogix_defender_exclusions: true,
    fslogix_installer: 'https://aka.ms/fslogix_download',
  },
  derived: {
    fslogix_office_locations: "{{ fslogix_locations | map('regex_replace', '[\\\\/]+$', '') | map('regex_replace', '$', '-office') | list }}",
    fslogix_ccd_locations: "{{ ['type=smb,name=\"profiles\",connectionString=' ~ (fslogix_locations | join(';type=smb,connectionString='))] }}",
    fslogix_office_ccd_locations: "{{ ['type=smb,name=\"office\",connectionString=' ~ (fslogix_office_locations | join(';type=smb,connectionString='))] }}",
    fslogix_registry: REGISTRY,
    fslogix_defender_paths:
      "{{ ['%ProgramFiles%\\\\FSLogix\\\\Apps\\\\frxdrv.sys', '%ProgramFiles%\\\\FSLogix\\\\Apps\\\\frxdrvvt.sys', '%ProgramFiles%\\\\FSLogix\\\\Apps\\\\frxccd.sys', '%TEMP%\\\\*.VHD', '%TEMP%\\\\*.VHDX', '%Windir%\\\\TEMP\\\\*.VHD', '%Windir%\\\\TEMP\\\\*.VHDX'] + (fslogix_locations | product(['\\\\*.VHD', '\\\\*.VHDX']) | map('join') | list) }}",
    fslogix_defender_processes: ['%ProgramFiles%\\FSLogix\\Apps\\frxccd.exe', '%ProgramFiles%\\FSLogix\\Apps\\frxccds.exe', '%ProgramFiles%\\FSLogix\\Apps\\frxsvc.exe'],
  },
};

export const APP_FSLOGIX = patternBlueprint({
  id: 'app_fslogix',
  label: 'VDI – FSLogix profile containers',
  description:
    'FSLogix on the session hosts: FSLogix Apps installed when missing, the profile container settings in the registry (Enabled, VHDLocations or Cloud Cache CCDLocations, VHDX, size, ProfileType, DeleteLocalProfileWhenVHDShouldApply, FlipFlopProfileDirectoryName, no temporary profiles), optionally the Office container, Entra Kerberos for Azure Files with Entra-joined hosts, and the Defender exclusions FSLogix documents.',
  hosts: { default: 'os_kind_windows', hint: 'The session hosts, e.g. role_session_host:&os_kind_windows' },
  inputs: [
    { id: 'locations', label: 'Profile share(s)', control: 'text', default: '', placeholder: '\\\\account.file.core.windows.net\\profiles', hint: 'UNC paths, comma separated; tried in order' },
    select('storage', 'Profile storage', [['vhd-locations', 'VHDLocations (one share at a time)'], ['cloud-cache', 'Cloud Cache (CCDLocations, every share)']], 'vhd-locations'),
    select('volume_type', 'Disk format', [['VHDX', 'VHDX'], ['VHD', 'VHD']], 'VHDX'),
    { id: 'size_gib', label: 'Profile disk size', control: 'number', default: 30, min: 1, max: 2048, hint: 'GiB, dynamic' },
    select('profile_type', 'Profile type', [['0', 'Normal (read-write, one session per user)'], ['3', 'Read-write, read-only when already in use']], '0'),
    select('delete_local_profile', 'Delete a local profile when the container applies', YES_NO, 'true'),
    select('flip_flop', 'Folder named username_SID (FlipFlopProfileDirectoryName)', YES_NO, 'true'),
    select('prevent_temp_profile', 'Refuse sign-in with a temporary profile', YES_NO, 'true'),
    select('office_container', 'Office container (ODFC) as well', YES_NO, 'false', { hint: 'In <share>-office' }),
    select('auth', 'Share access', [['ad', 'AD DS / Kerberos (domain-joined hosts)'], ['entra-kerberos', 'Microsoft Entra Kerberos (Entra-joined hosts, Azure Files)']], 'ad'),
    select('defender_exclusions', 'Add the Defender exclusions', YES_NO, 'true'),
    { id: 'installer', label: 'FSLogix installer', control: 'text', default: 'https://aka.ms/fslogix_download', hint: "Microsoft's download (a zip), or a path / URL to FSLogixAppsSetup.exe; used only where FSLogix is missing" },
  ],
  roles: () => [FSLOGIX_ROLE],
  vars: (v                ) => ({
    mig_fslogix_locations: list(v.locations),
    mig_fslogix_storage: text(v.storage, 'vhd-locations'),
    mig_fslogix_volume_type: text(v.volume_type, 'VHDX'),
    mig_fslogix_size_gib: number(v.size_gib, 30),
    mig_fslogix_profile_type: number(v.profile_type, 0),
    mig_fslogix_delete_local_profile: yes(v.delete_local_profile ?? 'true'),
    mig_fslogix_flip_flop: yes(v.flip_flop ?? 'true'),
    mig_fslogix_prevent_temp_profile: yes(v.prevent_temp_profile ?? 'true'),
    mig_fslogix_office_container: yes(v.office_container),
    mig_fslogix_auth: text(v.auth, 'ad'),
    mig_fslogix_defender_exclusions: yes(v.defender_exclusions ?? 'true'),
    mig_fslogix_installer: text(v.installer, 'https://aka.ms/fslogix_download'),
  }),
});
