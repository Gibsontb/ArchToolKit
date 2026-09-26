/**
 * SQL Server on migrated hosts: mssql_windows, mssql_linux and mssql_ag.
 *
 * Windows: setup.exe from the user's media (mssql_media_path: a folder with
 * setup.exe the host can read, local or on a share its account reaches),
 * driven by ConfigurationFile.ini. Service accounts are gMSAs by default
 * (<NETBIOS>\gmsa-sql$), created here when the domain has a KDS root key, so
 * there is no service password; the sa password goes to setup.exe from the
 * vault with no_log. Where SQL Server came with the image (Azure SQL VM
 * images, the AWS and Google SQL licence-included images), mssql_preinstalled
 * skips setup and only the configuration runs.
 *
 * Configuration uses the lowlydba.sqlserver collection (dbatools underneath,
 * installed from the PowerShell Gallery) with the connecting account's
 * Windows login, which setup made a sysadmin through mssql_sysadmins.
 */

import { CONFIGURATION_FILE_INI } from '../templates/mssql.js';
import { assertVault } from './ad_join.js';
import { CHECK_MODE_TOLERANT, CLOUD_PLATFORM,                      } from './types.js';

const NOT_PREINSTALLED = 'not (mssql_preinstalled | bool)';
const LOGIN = { sql_instance: '{{ mssql_sql_instance }}' };

const windowsTasks         = [
  {
    name: 'Check the media location is set',
    'ansible.builtin.assert': {
      that: ['mssql_media_path | length > 0'],
      fail_msg: 'Set mssql_media_path to the folder holding setup.exe (your own media), or mssql_preinstalled to true when the image already has SQL Server.',
      quiet: true,
    },
    when: NOT_PREINSTALLED,
  },
  { ...assertVault(['vault_mssql_sa_password'], 'before installing SQL Server'), when: NOT_PREINSTALLED },
  {
    name: 'Add the AD PowerShell module for the gMSA',
    'ansible.windows.win_feature': { name: 'RSAT-AD-PowerShell', state: 'present' },
    when: [NOT_PREINSTALLED, "mssql_service_account_mode == 'gmsa'"],
  },
  {
    name: 'Create the SQL Server gMSA and let this host use it',
    'microsoft.ad.service_account': {
      name: '{{ mssql_gmsa_name }}',
      dns_hostname: '{{ mssql_gmsa_name }}.{{ mssql_domain }}',
      allowed_to_retrieve_password: { add: ['{{ ansible_facts.hostname }}$'] },
      domain_username: '{{ vault_domain_join_user }}',
      domain_password: '{{ vault_domain_join_password }}',
      state: 'present',
    },
    no_log: true,
    when: [NOT_PREINSTALLED, "mssql_service_account_mode == 'gmsa'"],
  },
  {
    name: 'Install the gMSA on this host',
    'ansible.windows.win_powershell': {
      script:
        "param([string]$Name)\n& klist.exe -li 0x3e7 purge | Out-Null\nif (-not (Test-ADServiceAccount -Identity $Name)) { Install-ADServiceAccount -Identity $Name; $Ansible.Changed = $true } else { $Ansible.Changed = $false }",
      parameters: { Name: '{{ mssql_gmsa_name }}' },
    },
    when: [NOT_PREINSTALLED, "mssql_service_account_mode == 'gmsa'"],
  },
  {
    name: 'Create the data, log, TempDB and backup folders',
    'ansible.windows.win_file': { path: '{{ item }}', state: 'directory' },
    loop: ['{{ mssql_setup_dir }}', '{{ mssql_data_dir }}', '{{ mssql_log_dir }}', '{{ mssql_tempdb_dir }}', '{{ mssql_backup_dir }}'],
  },
  {
    name: 'Write ConfigurationFile.ini',
    'ansible.windows.win_template': { src: 'ConfigurationFile.ini.j2', dest: '{{ mssql_setup_dir }}\\ConfigurationFile.ini' },
    when: NOT_PREINSTALLED,
  },
  {
    name: 'Look for the SQL Server service',
    'ansible.windows.win_service_info': { name: '{{ mssql_service_name }}' },
    register: 'mssql_service',
  },
  {
    name: 'Install SQL Server',
    'ansible.windows.win_command': {
      argv: "{{ [mssql_media_path ~ '\\\\setup.exe','/ConfigurationFile=' ~ mssql_setup_dir ~ '\\\\ConfigurationFile.ini', '/IAcceptSQLServerLicenseTerms', '/SAPWD=' ~ vault_mssql_sa_password] + mssql_service_password_args }}",
    },
    no_log: true,
    when: [NOT_PREINSTALLED, 'not mssql_service.exists'],
  },
  {
    name: 'Install dbatools for the configuration modules',
    'community.windows.win_psmodule': { name: 'dbatools', state: 'present', accept_license: true },
  },
  { name: 'Set max server memory', 'lowlydba.sqlserver.memory': { ...LOGIN, max: '{{ mssql_max_memory_mb }}' } },
  { name: 'Set cost threshold for parallelism', 'lowlydba.sqlserver.sp_configure': { ...LOGIN, name: 'cost threshold for parallelism', value: 50 } },
  { name: 'Set MAXDOP', 'lowlydba.sqlserver.sp_configure': { ...LOGIN, name: 'max degree of parallelism', value: '{{ mssql_maxdop }}' } },
  { name: 'Listen on TCP {{ mssql_port }}', 'lowlydba.sqlserver.tcp_port': { ...LOGIN, port: '{{ mssql_port }}' } },
  {
    name: 'Install the Ola Hallengren maintenance solution and its jobs',
    'lowlydba.sqlserver.maintenance_solution': { ...LOGIN, database: 'master', backup_location: '{{ mssql_backup_dir }}', cleanup_time: '{{ mssql_backup_retention_hours }}', install_jobs: true, replace_existing: false },
  },
  {
    name: 'Schedule the backup jobs for the backup tier',
    'lowlydba.sqlserver.agent_job_schedule': {
      ...LOGIN,
      job: '{{ item.job }}',
      schedule: '{{ item.schedule }}',
      frequency_type: '{{ item.type }}',
      frequency_interval: '{{ item.interval }}',
      frequency_recurrence_factor: 1,
      frequency_subday_type: '{{ item.subday_type | default(omit) }}',
      frequency_subday_interval: '{{ item.subday_interval | default(omit) }}',
      start_time: '{{ item.start }}',
      enabled: true,
      force: true,
      state: 'present',
    },
    loop: '{{ mssql_backup_schedules[mssql_backup_tier] | default(mssql_backup_schedules.silver) }}',
  },
  {
    name: 'Open SQL Server and the AG endpoint in the firewall (IPv4 and IPv6)',
    'community.windows.win_firewall_rule': {
      name: 'SQL Server TCP {{ item }}',
      localport: '{{ item }}',
      protocol: 'tcp',
      direction: 'in',
      action: 'allow',
      profiles: ['domain', 'private', 'public'],
      enabled: true,
      state: 'present',
    },
    loop: ['{{ mssql_port }}', '5022'],
  },
];

export const MSSQL_WINDOWS       = {
  name: 'mssql_windows',
  description: 'SQL Server on Windows from your media (or preinstalled), then memory, MAXDOP, port, maintenance and backups.',
  tasks: windowsTasks,
  defaults: {
    mssql_version: '2022',
    mssql_edition: 'Enterprise',
    mssql_media_path: '',
    mssql_preinstalled: false,
    mssql_instance_name: 'MSSQLSERVER',
    mssql_collation: 'SQL_Latin1_General_CP1_CI_AS',
    mssql_features: ['SQLENGINE', 'FULLTEXT'],
    mssql_domain: '',
    mssql_domain_netbios: '',
    mssql_service_account_mode: 'gmsa',
    mssql_gmsa_name: 'gmsa-sql',
    mssql_service_account_name: '',
    mssql_sysadmins: ['BUILTIN\\Administrators'],
    mssql_setup_dir: 'C:\\SQLSetup',
    mssql_data_dir: 'D:\\SQLData',
    mssql_log_dir: 'E:\\SQLLogs',
    mssql_tempdb_dir: 'F:\\TempDB',
    mssql_backup_dir: 'G:\\SQLBackup',
    mssql_port: 1433,
    mssql_backup_tier: 'silver',
  },
  derived: {
    mssql_netbios: "{{ mssql_domain_netbios if mssql_domain_netbios | length > 0 else (mssql_domain.split('.') | first | upper) }}",
    mssql_service_name: "{{ 'MSSQLSERVER' if mssql_instance_name == 'MSSQLSERVER' else 'MSSQL$' ~ mssql_instance_name }}",
    mssql_sql_instance: "{{ 'localhost' if mssql_instance_name == 'MSSQLSERVER' else 'localhost\\\\' ~ mssql_instance_name }}",
    mssql_service_account:
      "{{ (mssql_netbios ~ '\\\\' ~ mssql_gmsa_name ~ '$') if mssql_service_account_mode == 'gmsa' else (mssql_service_account_name if mssql_service_account_mode == 'domain' else ('NT Service\\\\' ~ mssql_service_name)) }}",
    mssql_agent_account:
      "{{ (mssql_netbios ~ '\\\\' ~ mssql_gmsa_name ~ '$') if mssql_service_account_mode == 'gmsa' else (mssql_service_account_name if mssql_service_account_mode == 'domain' else ('NT Service\\\\SQL' ~ ('SERVERAGENT' if mssql_instance_name == 'MSSQLSERVER' else 'Agent$' ~ mssql_instance_name))) }}",
    // Only a domain (non-managed) account has a password; it comes from the vault.
    mssql_service_password_args:
      "{{ ['/SQLSVCPASSWORD=' ~ vault_mssql_service_password, '/AGTSVCPASSWORD=' ~ vault_mssql_service_password] if mssql_service_account_mode == 'domain' else [] }}",
    mssql_tempdb_file_count: '{{ [8, ansible_facts.processor_vcpus | default(ansible_facts.processor_count) | int] | min }}',
    mssql_max_memory_mb: '{{ [ansible_facts.memtotal_mb - 4096, (ansible_facts.memtotal_mb * 0.9) | int] | min }}',
    mssql_maxdop: '{{ [8, ansible_facts.processor_cores | default(ansible_facts.processor_count) | int] | min }}',
    mssql_backup_retention_hours: '{{ {"gold": 840, "silver": 336, "bronze": 168}[mssql_backup_tier] | default(336) }}',
    mssql_backup_schedules: {
      gold: [
        { job: 'DatabaseBackup - USER_DATABASES - FULL', schedule: 'Daily full', type: 'Daily', interval: '1', start: '010000' },
        { job: 'DatabaseBackup - SYSTEM_DATABASES - FULL', schedule: 'Daily system full', type: 'Daily', interval: '1', start: '003000' },
        { job: 'DatabaseBackup - USER_DATABASES - LOG', schedule: 'Log every 15 minutes', type: 'Daily', interval: '1', subday_type: 'Minutes', subday_interval: 15, start: '000000' },
      ],
      silver: [
        { job: 'DatabaseBackup - USER_DATABASES - FULL', schedule: 'Daily full', type: 'Daily', interval: '1', start: '010000' },
        { job: 'DatabaseBackup - SYSTEM_DATABASES - FULL', schedule: 'Daily system full', type: 'Daily', interval: '1', start: '003000' },
        { job: 'DatabaseBackup - USER_DATABASES - LOG', schedule: 'Log hourly', type: 'Daily', interval: '1', subday_type: 'Hours', subday_interval: 1, start: '000000' },
      ],
      bronze: [
        { job: 'DatabaseBackup - USER_DATABASES - FULL', schedule: 'Weekly full', type: 'Weekly', interval: 'Sunday', start: '010000' },
        { job: 'DatabaseBackup - SYSTEM_DATABASES - FULL', schedule: 'Weekly system full', type: 'Weekly', interval: 'Sunday', start: '003000' },
      ],
    },
  },
  templates: { 'ConfigurationFile.ini.j2': CONFIGURATION_FILE_INI },
};

// ---------------------------------------------------------------- Linux ---

const RH = "ansible_facts.os_family == 'RedHat'";
const DEB = "ansible_facts.os_family == 'Debian'";
const SUSE = "ansible_facts.os_family == 'Suse'";
const MS_KEY = 'https://packages.microsoft.com/keys/microsoft.asc';

const linuxTasks         = [
  {
    name: 'Check the distribution is one SQL Server supports',
    'ansible.builtin.assert': {
      that: ["ansible_facts.distribution in ['RedHat', 'OracleLinux', 'Rocky', 'AlmaLinux', 'Ubuntu', 'SLES', 'SLES_SAP']"],
      fail_msg: 'SQL Server on Linux runs on RHEL (and rebuilds), Ubuntu and SLES; this host is {{ ansible_facts.distribution }}.',
      quiet: true,
    },
  },
  assertVault(['vault_mssql_sa_password'], 'before installing SQL Server'),
  { name: "Trust Microsoft's package key (RHEL family and SUSE)", 'ansible.builtin.rpm_key': { key: MS_KEY, state: 'present' }, when: `${RH} or ${SUSE}` },
  {
    name: 'Add the SQL Server and tools repositories (RHEL family)',
    'ansible.builtin.yum_repository': {
      name: '{{ item.name }}',
      description: '{{ item.name }}',
      baseurl: 'https://packages.microsoft.com/rhel/{{ ansible_facts.distribution_major_version }}/{{ item.path }}/',
      gpgcheck: true,
      gpgkey: MS_KEY,
      enabled: true,
    },
    loop: '{{ mssql_linux_repos }}',
    when: RH,
  },
  {
    name: 'Add the SQL Server and tools repositories (Ubuntu)',
    'ansible.builtin.deb822_repository': {
      install_python_debian: true,
      name: '{{ item.name }}',
      types: ['deb'],
      uris: ['https://packages.microsoft.com/ubuntu/{{ ansible_facts.distribution_version }}/{{ item.path }}'],
      suites: ['{{ ansible_facts.distribution_release }}'],
      components: ['main'],
      signed_by: MS_KEY,
      state: 'present',
    },
    loop: '{{ mssql_linux_repos }}',
    when: DEB,
  },
  {
    name: 'Add the SQL Server and tools repositories (SLES)',
    'community.general.zypper_repository': {
      name: '{{ item.name }}',
      repo: 'https://packages.microsoft.com/sles/{{ ansible_facts.distribution_major_version }}/{{ item.path }}/',
      auto_import_keys: true,
      state: 'present',
    },
    loop: '{{ mssql_linux_repos }}',
    when: SUSE,
  },
  {
    name: 'Install SQL Server and the command-line tools',
    'ansible.builtin.package': { name: '{{ mssql_linux_packages[ansible_facts.os_family] }}', state: 'present' },
    environment: { ACCEPT_EULA: 'Y' },
  },
  {
    name: 'Set up SQL Server (edition and sa password)',
    'ansible.builtin.command': { argv: ['/opt/mssql/bin/mssql-conf', '-n', 'setup', 'accept-eula'], creates: '/var/opt/mssql/data/master.mdf' },
    environment: { MSSQL_SA_PASSWORD: '{{ vault_mssql_sa_password }}', MSSQL_PID: '{{ mssql_edition }}', ACCEPT_EULA: 'Y' },
    no_log: true,
  },
  {
    name: 'Set the memory limit',
    'community.general.ini_file': { path: '/var/opt/mssql/mssql.conf', section: 'memory', option: 'memorylimitmb', value: '{{ mssql_linux_memory_mb }}', mode: '0644' },
    notify: 'Restart mssql-server',
  },
  {
    name: 'Set the TCP port',
    'community.general.ini_file': { path: '/var/opt/mssql/mssql.conf', section: 'network', option: 'tcpport', value: '{{ mssql_port }}', mode: '0644' },
    notify: 'Restart mssql-server',
  },
  { name: 'Keep SQL Server running', ...CHECK_MODE_TOLERANT, 'ansible.builtin.service': { name: 'mssql-server', state: 'started', enabled: true } },
  {
    name: 'Open SQL Server in firewalld (IPv4 and IPv6)', ...CHECK_MODE_TOLERANT,
    'ansible.posix.firewalld': { port: '{{ mssql_port }}/tcp', permanent: true, immediate: true, state: 'enabled' },
    when: `${RH} or ${SUSE}`,
  },
  { name: 'Open SQL Server in ufw (IPv4 and IPv6)', ...CHECK_MODE_TOLERANT, 'community.general.ufw': { rule: 'allow', port: '{{ mssql_port }}', proto: 'tcp' }, when: DEB },
];

export const MSSQL_LINUX       = {
  name: 'mssql_linux',
  description: "SQL Server on Linux from Microsoft's repository, with the edition, sa password from the vault, memory limit and firewall.",
  tasks: linuxTasks,
  handlers: [{ name: 'Restart mssql-server', 'ansible.builtin.service': { name: 'mssql-server', state: 'restarted' } }],
  defaults: {
    mssql_version: '2022',
    mssql_edition: 'Enterprise',
    mssql_port: 1433,
    mssql_memory_percent: 80,
  },
  derived: {
    mssql_linux_repos: [
      { name: 'mssql-server-{{ mssql_version }}', path: 'mssql-server-{{ mssql_version }}' },
      { name: 'packages-microsoft-prod', path: 'prod' },
    ],
    mssql_linux_packages: {
      RedHat: ['mssql-server', 'mssql-tools18', 'unixODBC-devel'],
      Debian: ['mssql-server', 'mssql-tools18', 'unixodbc-dev'],
      Suse: ['mssql-server', 'mssql-tools18', 'unixODBC-devel'],
    },
    mssql_linux_memory_mb: '{{ (ansible_facts.memtotal_mb * mssql_memory_percent / 100) | int }}',
  },
};

// ------------------------------------------------------------ AG (Windows) ---

const ON_PRIMARY = 'inventory_hostname == mssql_ag_primary';
const AS_DOMAIN = {
  become: true,
  become_method: 'ansible.builtin.runas',
  become_user: '{{ vault_domain_join_user }}',
  vars: { ansible_become_password: '{{ vault_domain_join_password }}' },
  no_log: true,
}         ;

const agTasks         = [
  {
    name: 'Say that an Always On AG on Linux is not built here',
    'ansible.builtin.debug': {
      msg: 'Availability groups on Linux need Pacemaker, which is out of scope. Use a contained AG with CLUSTER_TYPE = NONE (read scale) or place the database on Windows.',
    },
    when: "ansible_facts.os_family != 'Windows'",
  },
  {
    name: 'Build the AG on Windows',
    when: "ansible_facts.os_family == 'Windows'",
    block: [
      assertVault(['vault_domain_join_user', 'vault_domain_join_password'], 'to create the cluster'),
      {
        name: 'Add Failover Clustering',
        'ansible.windows.win_feature': { name: 'Failover-Clustering', state: 'present', include_management_tools: true },
        register: 'mssql_ag_feature',
      },
      { name: 'Reboot when the feature needs it', 'ansible.windows.win_reboot': {}, when: 'mssql_ag_feature.reboot_required' },
      {
        name: 'Create the Windows failover cluster',
        'ansible.windows.win_powershell': {
          script: [
            'param([string]$Name, [string[]]$Nodes, [string[]]$Addresses, [bool]$Distributed)',
            'if (Get-Cluster -Name $Name -ErrorAction SilentlyContinue) { $Ansible.Changed = $false; return }',
            // A distributed network name needs no static address: Azure's way, and the fallback anywhere none is given.
            'if ($Distributed -or -not $Addresses) { New-Cluster -Name $Name -Node $Nodes -NoStorage -ManagementPointNetworkType Distributed | Out-Null }',
            'else { New-Cluster -Name $Name -Node $Nodes -NoStorage -StaticAddress $Addresses | Out-Null }',
            '$Ansible.Changed = $true',
          ].join('\n'),
          parameters: {
            Name: '{{ mssql_cluster_name }}',
            Nodes: '{{ mssql_ag_node_names }}',
            Addresses: '{{ mssql_cluster_ips }}',
            Distributed: "{{ cloud_platform == 'azure' }}",
          },
        },
        when: ON_PRIMARY,
        ...AS_DOMAIN,
      },
      {
        name: 'Use a cloud witness (Azure)',
        'ansible.windows.win_powershell': {
          script: 'param([string]$Account, [securestring]$Key)\n$plain = [System.Net.NetworkCredential]::new(\'\', $Key).Password\nSet-ClusterQuorum -Cluster $env:COMPUTERNAME -CloudWitness -AccountName $Account -AccessKey $plain | Out-Null',
          parameters: { Account: '{{ mssql_cloud_witness_account }}' },
          sensitive_parameters: [{ name: 'Key', value: '{{ vault_cluster_witness_storage_key }}' }],
        },
        when: [ON_PRIMARY, "cloud_platform == 'azure'", 'mssql_cloud_witness_account | length > 0'],
        ...AS_DOMAIN,
      },
      {
        name: 'Use a file share witness',
        'ansible.windows.win_powershell': {
          script: 'param([string]$Path)\nSet-ClusterQuorum -Cluster $env:COMPUTERNAME -FileShareWitness $Path | Out-Null',
          parameters: { Path: '{{ mssql_file_share_witness }}' },
        },
        when: [ON_PRIMARY, "cloud_platform != 'azure'", 'mssql_file_share_witness | length > 0'],
        ...AS_DOMAIN,
      },
      { name: 'Enable Always On', 'lowlydba.sqlserver.hadr': { ...LOGIN, enabled: true, force: true } },
      {
        name: 'Create the availability group on the primary',
        'lowlydba.sqlserver.availability_group': {
          ...LOGIN,
          ag_name: '{{ mssql_ag_name }}',
          database: '{{ mssql_ag_database | default(omit, true) }}',
          availability_mode: 'SynchronousCommit',
          failover_mode: 'Automatic',
          seeding_mode: 'Automatic',
          cluster_type: 'Wsfc',
          automated_backup_preference: 'Secondary',
          state: 'present',
        },
        when: ON_PRIMARY,
        ...AS_DOMAIN,
      },
      {
        name: 'Add the secondaries (synchronous in region, asynchronous for DR)',
        'lowlydba.sqlserver.ag_replica': {
          ...LOGIN,
          ag_name: '{{ mssql_ag_name }}',
          sql_instance_replica: "{{ hostvars[item].ansible_facts.hostname ~ ('' if mssql_instance_name == 'MSSQLSERVER' else '\\\\' ~ mssql_instance_name) }}",
          availability_mode: "{{ 'AsynchronousCommit' if item in mssql_ag_async_replicas else 'SynchronousCommit' }}",
          failover_mode: "{{ 'Manual' if item in mssql_ag_async_replicas else 'Automatic' }}",
          seeding_mode: 'Automatic',
          cluster_type: 'Wsfc',
          state: 'present',
        },
        loop: '{{ mssql_ag_nodes | reject("equalto", mssql_ag_primary) | list }}',
        when: ON_PRIMARY,
        ...AS_DOMAIN,
      },
      {
        name: 'Create the listener (not on Azure: the load balancer from Terraform is the listener there)',
        'lowlydba.sqlserver.ag_listener': {
          ...LOGIN,
          ag_name: '{{ mssql_ag_name }}',
          listener_name: '{{ mssql_ag_listener_name }}',
          ip_address: '{{ mssql_ag_listener_ips }}',
          subnet_mask: '{{ mssql_ag_listener_masks }}',
          port: '{{ mssql_port }}',
          state: 'present',
        },
        when: [ON_PRIMARY, "cloud_platform != 'azure'", 'mssql_ag_listener_ips | length > 0'],
        ...AS_DOMAIN,
      },
      {
        name: 'Say where the listener comes from on Azure',
        'ansible.builtin.debug': { msg: 'On Azure the AG listener is the load balancer (or DNN) that Terraform creates; no listener is made here.' },
        when: [ON_PRIMARY, "cloud_platform == 'azure'"],
      },
    ],
  },
];

export const MSSQL_AG       = {
  name: 'mssql_ag',
  description: 'Windows failover cluster, quorum witness and an Always On availability group with its replicas and listener.',
  tasks: agTasks,
  defaults: {
    mssql_ag_name: 'ag1',
    mssql_ag_database: '',
    mssql_cluster_name: 'sqlclu1',
    mssql_cluster_ips: [],
    mssql_ag_async_replicas: [],
    mssql_ag_listener_name: 'aglistener',
    mssql_ag_listener_ips: [],
    mssql_ag_listener_masks: [],
    mssql_cloud_witness_account: '',
    mssql_file_share_witness: '',
    mssql_instance_name: 'MSSQLSERVER',
    mssql_port: 1433,
  },
  derived: {
    cloud_platform: CLOUD_PLATFORM,
    mssql_sql_instance: "{{ 'localhost' if mssql_instance_name == 'MSSQLSERVER' else 'localhost\\\\' ~ mssql_instance_name }}",
    mssql_ag_nodes: '{{ mig_mssql_ag_nodes | default(ansible_play_hosts_all) }}',
    mssql_ag_node_names: "{{ mssql_ag_nodes | map('extract', hostvars, ['ansible_facts', 'hostname']) | list }}",
    mssql_ag_primary:'{{ mig_mssql_ag_primary | default(mssql_ag_nodes | first, true) }}',
  },
};
