/**
 * The guest software a VM needs on its new platform, and the software it no
 * longer needs: cloud_agents and vmware_tools_removal.
 *
 * cloud_agents makes sure the platform's own agent is installed and running
 * (the SSM Agent and EC2Launch v2 on AWS, the Azure VM agent, the Google
 * guest environment and OS Config agent, the Oracle Cloud Agent or
 * Cloudbase-Init on OCI), and on a replicated VM removes the agents of the
 * other clouds it may have carried. vmware_tools_removal removes VMware Tools
 * from a VM that has left vSphere. Both take the platform from the host's
 * platform_<p> group.
 */

import { CLOUD_PLATFORM,                      } from './types.js';

const LINUX = "ansible_facts.os_family != 'Windows'";
const WINDOWS = "ansible_facts.os_family == 'Windows'";
const RH = "ansible_facts.os_family == 'RedHat'";
const DEB = "ansible_facts.os_family == 'Debian'";
const UBUNTU = "ansible_facts.distribution == 'Ubuntu'";
const REPLICATED = "'method_replicate' in group_names";

const SSM = 'https://s3.amazonaws.com/ec2-downloads-windows/SSMAgent/latest';

/** Remove installed programs whose display name matches, by their uninstall entry. */
const UNINSTALL_BY_NAME = `param([string[]]$Names)
$roots = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
$found = Get-ItemProperty -Path $roots -ErrorAction SilentlyContinue | Where-Object { $n = $_.DisplayName; $n -and ($Names | Where-Object { $n -like $_ }) }
$Ansible.Changed = $false
foreach ($entry in $found) {
  if ($entry.PSChildName -match '^\\{[0-9A-Fa-f-]+\\}$') {
    $p = Start-Process -FilePath msiexec.exe -ArgumentList '/x', $entry.PSChildName, '/qn', '/norestart' -Wait -PassThru
    if ($p.ExitCode -notin 0, 1605, 3010) { throw "Removing $($entry.DisplayName) failed: $($p.ExitCode)" }
    $Ansible.Changed = $true
  }
}`;

const tasks         = [
  // ------------------------------------------------------------ Linux ---
  {
    name: 'Linux agents',
    when: LINUX,
    become: true,
    block: [
      {
        name: 'Install the SSM Agent (AWS, RPM)',
        'ansible.builtin.dnf': { name: `${SSM}/linux_{{ cloud_agents_arch }}/amazon-ssm-agent.rpm`, state: 'present' },
        when: ["cloud_platform == 'aws'", RH],
      },
      {
        name: 'Install the SSM Agent (AWS, Ubuntu snap)',
        'community.general.snap': { name: 'amazon-ssm-agent', classic: true, state: 'present' },
        when: ["cloud_platform == 'aws'", UBUNTU],
      },
      {
        name: 'Install the SSM Agent (AWS, Debian package)',
        'ansible.builtin.apt': { deb: `${SSM}/debian_{{ cloud_agents_arch }}/amazon-ssm-agent.deb`, state: 'present' },
        when: ["cloud_platform == 'aws'", DEB, `not (${UBUNTU})`],
      },
      {
        name: 'Install the Azure Linux agent',
        'ansible.builtin.package': { name: "{{ 'walinuxagent' if ansible_facts.os_family == 'Debian' else 'WALinuxAgent' }}", state: 'present' },
        when: "cloud_platform == 'azure'",
      },
      {
        name: 'Add the Google guest environment repository (RHEL family)',
        'ansible.builtin.yum_repository': {
          name: 'google-compute-engine',
          description: 'Google Compute Engine',
          baseurl: 'https://packages.cloud.google.com/yum/repos/google-compute-engine-el{{ ansible_facts.distribution_major_version }}-{{ ansible_facts.architecture }}-stable',
          gpgcheck: true,
          gpgkey: 'https://packages.cloud.google.com/yum/doc/yum-key.gpg',
          enabled: true,
        },
        when: ["cloud_platform == 'google'", RH],
      },
      {
        name: 'Add the Google guest environment repository (Debian family)',
        'ansible.builtin.deb822_repository': {
          install_python_debian: true,
          name: 'google-compute-engine',
          types: ['deb'],
          uris: ['https://packages.cloud.google.com/apt'],
          suites: ['google-compute-engine-{{ ansible_facts.distribution_release }}-stable'],
          components: ['main'],
          signed_by: 'https://packages.cloud.google.com/apt/doc/apt-key.gpg',
          state: 'present',
        },
        when: ["cloud_platform == 'google'", DEB],
      },
      {
        name: 'Install the Google guest environment and OS Config agent',
        'ansible.builtin.package': { name: ['google-guest-agent', 'google-osconfig-agent'], state: 'present' },
        when: "cloud_platform == 'google'",
      },
      {
        name: 'Install the Oracle Cloud Agent (Oracle Linux)',
        'ansible.builtin.dnf': { name: 'oracle-cloud-agent', state: 'present' },
        when: ["cloud_platform == 'oci'", "ansible_facts.distribution == 'OracleLinux'"],
      },
      {
        name: 'Install the Oracle Cloud Agent (Ubuntu snap)',
        'community.general.snap': { name: 'oracle-cloud-agent', classic: true, state: 'present' },
        when: ["cloud_platform == 'oci'", UBUNTU],
      },
      { name: 'Read the services', 'ansible.builtin.service_facts': {} },
      {
        name: "Keep the platform's agents running",
        'ansible.builtin.service': { name: '{{ item }}', state: 'started', enabled: true },
        loop: '{{ cloud_agents_linux_services[cloud_platform] | default([]) | select("in", ansible_facts.services.keys() | map("regex_replace", "\\\\.service$", "") | list) | list }}',
      },
      {
        name: "Remove the other clouds' agents from a replicated VM",
        'ansible.builtin.package': { name: '{{ cloud_agents_linux_remove }}', state: 'absent' },
        when: [REPLICATED, 'cloud_agents_linux_remove | length > 0'],
      },
    ],
  },
  // ---------------------------------------------------------- Windows ---
  {
    name: 'Windows agents',
    when: WINDOWS,
    block: [
      {
        name: 'Install the SSM Agent (AWS)',
        'ansible.windows.win_package': { path: `${SSM}/windows_amd64/AmazonSSMAgentSetup.exe`, arguments: ['/install', '/quiet', '/norestart'], creates_service: 'AmazonSSMAgent', state: 'present' },
        when: "cloud_platform == 'aws'",
      },
      {
        name: 'Install EC2Launch v2 (AWS)',
        'ansible.windows.win_package': {
          path: 'https://s3.amazonaws.com/amazon-ec2launch-v2/windows/amd64/latest/AmazonEC2Launch.msi',
          creates_path: 'C:\\Program Files\\Amazon\\EC2Launch\\EC2Launch.exe',
          state: 'present',
        },
        when: "cloud_platform == 'aws'",
      },
      {
        name: 'Look for the Azure VM agent',
        'ansible.windows.win_service_info': { name: 'WindowsAzureGuestAgent' },
        register: 'cloud_agents_azure_agent',
        when: "cloud_platform == 'azure'",
      },
      {
        name: 'Fetch the Azure VM agent',
        'ansible.windows.win_get_url': { url: 'https://go.microsoft.com/fwlink/?LinkID=394789', dest: 'C:\\Windows\\Temp\\WindowsAzureVmAgent.msi' },
        when: ["cloud_platform == 'azure'", 'not cloud_agents_azure_agent.exists'],
      },
      {
        name: 'Install the Azure VM agent',
        'ansible.windows.win_package': { path: 'C:\\Windows\\Temp\\WindowsAzureVmAgent.msi', creates_service: 'WindowsAzureGuestAgent', state: 'present' },
        when: ["cloud_platform == 'azure'", 'not cloud_agents_azure_agent.exists'],
      },
      {
        name: 'Install the Google guest environment with GooGet',
        'ansible.windows.win_command': {
          argv: ['C:\\ProgramData\\GooGet\\googet.exe', '-noconfirm', 'install', 'google-compute-engine-windows', 'google-osconfig-agent'],
          creates: 'C:\\Program Files\\Google\\Compute Engine\\agent\\GCEWindowsAgent.exe',
        },
        when: "cloud_platform == 'google'",
      },
      {
        name: 'Fetch Cloudbase-Init (OCI)',
        'ansible.windows.win_get_url': { url: 'https://www.cloudbase.it/downloads/CloudbaseInitSetup_Stable_x64.msi', dest: 'C:\\Windows\\Temp\\CloudbaseInitSetup_x64.msi' },
        when: "cloud_platform == 'oci'",
      },
      {
        name: 'Install Cloudbase-Init (OCI)',
        'ansible.windows.win_package': {
          path: 'C:\\Windows\\Temp\\CloudbaseInitSetup_x64.msi',
          arguments: ['RUN_SERVICE_AS_LOCAL_SYSTEM=1'],
          creates_service: 'cloudbase-init',
          state: 'present',
        },
        when: "cloud_platform == 'oci'",
      },
      { name: 'Read the services', 'ansible.windows.win_service_info': {}, register: 'cloud_agents_services' },
      {
        name: "Keep the platform's agents running",
        'ansible.windows.win_service': { name: '{{ item }}', state: 'started', start_mode: 'auto' },
        loop: "{{ cloud_agents_windows_services[cloud_platform] | default([]) | select('in', cloud_agents_services.services | map(attribute='name') | list) | list }}",
      },
      {
        name: "Remove the other clouds' agents from a replicated VM",
        'ansible.windows.win_powershell': { script: UNINSTALL_BY_NAME, parameters: { Names: '{{ cloud_agents_windows_remove }}' } },
        when: [REPLICATED, 'cloud_agents_windows_remove | length > 0'],
      },
    ],
  },
];

const LINUX_PACKAGES                           = {
  aws: ['amazon-ssm-agent'],
  azure: ['WALinuxAgent', 'walinuxagent'],
  google: ['google-guest-agent', 'google-osconfig-agent', 'google-compute-engine'],
  oci: ['oracle-cloud-agent'],
};
const WINDOWS_PROGRAMS                           = {
  aws: ['Amazon SSM Agent*', 'Amazon EC2Launch*'],
  azure: ['Windows Azure VM Agent*'],
  google: [],
  oci: ['Cloudbase-Init*'],
};

export const CLOUD_AGENTS       = {
  name: 'cloud_agents',
  description: "the platform's guest agents present and running; other clouds' agents removed from replicated VMs.",
  tasks,
  derived: {
    cloud_platform: CLOUD_PLATFORM,
    cloud_agents_arch: "{{ 'arm64' if ansible_facts.architecture in ['aarch64', 'arm64'] else 'amd64' }}",
    cloud_agents_linux_services: {
      aws: ['amazon-ssm-agent', 'snap.amazon-ssm-agent.amazon-ssm-agent'],
      azure: ['waagent', 'walinuxagent'],
      google: ['google-guest-agent', 'google-osconfig-agent'],
      oci: ['oracle-cloud-agent', 'snap.oracle-cloud-agent.oracle-cloud-agent'],
    },
    cloud_agents_windows_services: {
      aws: ['AmazonSSMAgent'],
      azure: ['WindowsAzureGuestAgent'],
      google: ['GCEAgent', 'google_osconfig_agent'],
      oci: ['cloudbase-init'],
    },
    cloud_agents_linux_all: LINUX_PACKAGES,
    cloud_agents_windows_all: WINDOWS_PROGRAMS,
    cloud_agents_linux_remove:
      "{{ cloud_agents_linux_all | dict2items | rejectattr('key', 'equalto', cloud_platform) | map(attribute='value') | flatten }}",
    cloud_agents_windows_remove:
      "{{ cloud_agents_windows_all | dict2items | rejectattr('key', 'equalto', cloud_platform) | map(attribute='value') | flatten }}",
  },
};

// -------------------------------------------------- VMware Tools removal ---

const FIND_VMWARE_TOOLS = `$roots = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
$Ansible.Changed = $false
Get-ItemProperty -Path $roots -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -eq 'VMware Tools' -and $_.PSChildName -match '^\\{[0-9A-Fa-f-]+\\}$' } |
  Select-Object -ExpandProperty PSChildName -First 1`;

export const VMWARE_TOOLS_REMOVAL       = {
  name: 'vmware_tools_removal',
  description: 'remove VMware Tools from a VM that now runs on a hyperscaler.',
  tasks: [
    {
      name: 'Say why nothing is removed on vSphere',
      'ansible.builtin.debug': { msg: 'This host is still on vSphere (platform {{ cloud_platform }}); VMware Tools stays.' },
      when: "cloud_platform == 'vmware'",
    },
    {
      name: 'Remove open-vm-tools',
      'ansible.builtin.package': { name: ['open-vm-tools', 'open-vm-tools-desktop'], state: 'absent' },
      become: true,
      when: [LINUX, "cloud_platform != 'vmware'"],
    },
    {
      name: 'Find the VMware Tools product code',
      'ansible.windows.win_powershell': { script: FIND_VMWARE_TOOLS },
      register: 'vmware_tools_product',
      changed_when: false,
      check_mode: false,
      when: [WINDOWS, "cloud_platform != 'vmware'"],
    },
    {
      name: 'Remove VMware Tools',
      'ansible.windows.win_package': { product_id: '{{ vmware_tools_product.output | first }}', state: 'absent' },
      register: 'vmware_tools_removed',
      when: [WINDOWS, "cloud_platform != 'vmware'", 'vmware_tools_product.output | default([]) | length > 0'],
    },
    {
      name: 'Reboot when the removal needs it',
      'ansible.windows.win_reboot': { reboot_timeout: 1200 },
      when: [WINDOWS, 'vmware_tools_removed.reboot_required | default(false)'],
    },
  ],
  derived: { cloud_platform: CLOUD_PLATFORM },
};
