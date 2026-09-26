/**
 * The guest software a VM needs on its new platform, and the software it no
 * longer needs: cloud_agents and vmware_tools_removal.
 *
 * cloud_agents makes sure the platform's own agent is installed and running
 * (the SSM Agent and EC2Launch v2 on AWS, the Azure VM agent, the Google
 * guest environment and OS Config agent, the Oracle Cloud Agent or
 * Cloudbase-Init on OCI), and on a replicated VM removes the agents of the
 * other clouds it may have carried. It also installs the EDR and
 * vulnerability-scanner agents the plan names (`edr_agents`,
 * `scanner_agents` in group_vars/all/), registers them, and keeps them enabled
 * and running, on every host it runs on, VMware ones included.
 * vmware_tools_removal removes VMware Tools from a VM that has left vSphere.
 * Both take the platform from the host's platform_<p> group.
 *
 * A security agent entry (group_vars shape):
 *
 *   name              what it is, for the log
 *   linux_package     the package name (installed from the host's repositories
 *                     when there is no linux_source)
 *   linux_source      a URL or a path on the host to the .rpm / .deb
 *   windows_package   the MSI product code ({GUID}) when there is one, so the
 *                     install is skipped where it is already present
 *   windows_source    a URL, UNC path or local path to the .msi / .exe
 *   service           the service to keep enabled and running
 *                     (linux_service / windows_service override it per OS)
 *   token_var         optional: the vault_* variable holding the registration
 *                     token or customer id; `%TOKEN%` in the two fields below
 *                     is replaced with its value
 *   linux_register    optional: the command that registers the agent after
 *                     the install (linux_creates: a file that says it is done)
 *   windows_arguments optional: the installer arguments (they often carry the
 *                     token, so the task logs nothing)
 *
 * The tasks that see a token run with no_log, and no token is ever written
 * outside the vault.
 */

import { CLOUD_PLATFORM,                      } from './types.js';

const LINUX = "ansible_facts.os_family != 'Windows'";
const WINDOWS = "ansible_facts.os_family == 'Windows'";
const RH = "ansible_facts.os_family == 'RedHat'";
const DEB = "ansible_facts.os_family == 'Debian'";
const UBUNTU = "ansible_facts.distribution == 'Ubuntu'";
const REPLICATED = "'method_replicate' in group_names";
const ON_A_CLOUD = "cloud_platform in ['aws', 'azure', 'google', 'oci']";

/** The token for an agent entry, from its vault variable; empty when it names none. */
const AGENT_TOKEN = "{{ lookup('ansible.builtin.vars', item.token_var, default='') if (item.token_var | default('')) != '' else '' }}";
const LINUX_SOURCE = "(item.linux_source | default('')) != ''";
const LINUX_ANY = "((item.linux_source | default('')) != '' or (item.linux_package | default('')) != '')";
const WINDOWS_SOURCE = "(item.windows_source | default('')) != ''";
const LINUX_SERVICE = "item.linux_service | default(item.service | default(''), true)";
const WINDOWS_SERVICE = "item.windows_service | default(item.service | default(''), true)";
const AGENT_LOOP = { loop: '{{ cloud_agents_security }}', loop_control: { label: '{{ item.name }}' } };

/** EDR and scanner agents on Linux: install, register, enabled and running. */
const LINUX_SECURITY         = [
  {
    name: 'Install the EDR and scanner agents from their source (RHEL family)',
    'ansible.builtin.dnf': { name: '{{ item.linux_source }}', state: 'present' },
    ...AGENT_LOOP,
    when: [LINUX_SOURCE, RH],
  },
  {
    name: 'Install the EDR and scanner agents from their source (Debian family)',
    'ansible.builtin.apt': { deb: '{{ item.linux_source }}', state: 'present' },
    ...AGENT_LOOP,
    when: [LINUX_SOURCE, DEB],
  },
  {
    name: 'Install the EDR and scanner agents from their source (SUSE)',
    'community.general.zypper': { name: '{{ item.linux_source }}', state: 'present' },
    ...AGENT_LOOP,
    when: [LINUX_SOURCE, "ansible_facts.os_family == 'Suse'"],
  },
  {
    name: 'Install the EDR and scanner agents from the repositories',
    'ansible.builtin.package': { name: '{{ item.linux_package }}', state: 'present' },
    ...AGENT_LOOP,
    when: [`not ${LINUX_SOURCE}`, "(item.linux_package | default('')) != ''"],
  },
  {
    name: 'Register the EDR and scanner agents',
    'ansible.builtin.command': {
      cmd: "{{ item.linux_register | replace('%TOKEN%', cloud_agents_token) }}",
      creates: '{{ item.linux_creates | default(omit, true) }}',
    },
    vars: { cloud_agents_token: AGENT_TOKEN },
    ...AGENT_LOOP,
    when: [LINUX_ANY, "(item.linux_register | default('')) != ''"],
    changed_when: true,
    no_log: true,
  },
  {
    name: 'Keep the EDR and scanner agents enabled and running',
    'ansible.builtin.service': { name: `{{ ${LINUX_SERVICE} }}`, state: 'started', enabled: true },
    ...AGENT_LOOP,
    when: [LINUX_ANY, `(${LINUX_SERVICE}) != ''`],
  },
];

/** An MSI product code: the install is skipped where it is already present. */
const PRODUCT_CODE = "^\\{[0-9A-Fa-f-]+\\}$";

/** EDR and scanner agents on Windows: install (with the token in the arguments), enabled and running. */
const WINDOWS_SECURITY         = [
  {
    name: 'Install the EDR and scanner agents',
    'ansible.windows.win_package': {
      path: '{{ item.windows_source }}',
      product_id: `{{ item.windows_package if (item.windows_package | default('')) is match('${PRODUCT_CODE}') else omit }}`,
      arguments: "{{ (item.windows_arguments | replace('%TOKEN%', cloud_agents_token)) if (item.windows_arguments | default('')) != '' else omit }}",
      creates_service: `{{ (${WINDOWS_SERVICE}) if (${WINDOWS_SERVICE}) != '' else omit }}`,
      state: 'present',
    },
    vars: { cloud_agents_token: AGENT_TOKEN },
    ...AGENT_LOOP,
    when: WINDOWS_SOURCE,
    no_log: true,
  },
  {
    name: 'Keep the EDR and scanner agents enabled and running',
    'ansible.windows.win_service': { name: `{{ ${WINDOWS_SERVICE} }}`, state: 'started', start_mode: 'auto' },
    ...AGENT_LOOP,
    when: [WINDOWS_SOURCE, `(${WINDOWS_SERVICE}) != ''`],
  },
];

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
        when: [REPLICATED, ON_A_CLOUD, 'cloud_agents_linux_remove | length > 0'],
      },
      ...LINUX_SECURITY,
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
        when: [REPLICATED, ON_A_CLOUD, 'cloud_agents_windows_remove | length > 0'],
      },
      ...WINDOWS_SECURITY,
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
  description: "the platform's guest agents present and running; other clouds' agents removed from replicated VMs; the EDR and scanner agents installed, registered, enabled and running.",
  tasks,
  derived: {
    cloud_platform: CLOUD_PLATFORM,
    // edr_agents and scanner_agents come from group_vars/all/security_agents.yml; the role runs without them.
    cloud_agents_security: '{{ (edr_agents | default([])) + (scanner_agents | default([])) }}',
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
