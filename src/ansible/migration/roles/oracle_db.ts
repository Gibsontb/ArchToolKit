/**
 * oracle_db: Oracle Database on a VM, from media the user supplies.
 *
 * Oracle Linux 8/9 and RHEL 8/9 only (the releases Oracle certifies for 19c
 * and 23ai/26ai); anything else stops at the first task with a message.
 *
 * The media comes from oracle_media_url, an internal repository the user
 * names. The toolkit never downloads Oracle software: the download needs the
 * licence accepted on Oracle's site.
 *
 * The SYS, SYSTEM and PDBADMIN passwords come from the vault into dbca's
 * environment and onto its command line from there (dbca reads them from its
 * arguments in silent mode), with no_log on the task.
 */

import { DB_INSTALL_RSP, DBCA_RSP, ORACLE_SERVICE, RMAN_BACKUP_SH } from '../templates/oracle.ts';
import { assertVault } from './ad_join.ts';
import type { Role, Task } from './types.ts';

const ON_OL = "ansible_facts.distribution == 'OracleLinux'";
const ON_RHEL = "ansible_facts.distribution == 'RedHat'";
const AS_ORACLE = { become: true, become_user: 'oracle' } as const;

const RHEL_PACKAGES = [
  'bc', 'binutils', 'elfutils-libelf', 'elfutils-libelf-devel', 'fontconfig', 'glibc', 'glibc-devel', 'ksh',
  'libaio', 'libaio-devel', 'libgcc', 'libnsl', 'libstdc++', 'libstdc++-devel', 'libX11', 'libXau', 'libxcb',
  'libXi', 'libXrender', 'libXtst', 'make', 'net-tools', 'nfs-utils', 'policycoreutils', 'policycoreutils-python-utils',
  'smartmontools', 'sysstat', 'tar', 'unzip',
];

const GROUPS = [
  { name: 'oinstall', gid: 54321 },
  { name: 'dba', gid: 54322 },
  { name: 'oper', gid: 54323 },
  { name: 'backupdba', gid: 54324 },
  { name: 'dgdba', gid: 54325 },
  { name: 'kmdba', gid: 54326 },
  { name: 'racdba', gid: 54330 },
];

/** The kernel settings oracle-database-preinstall sets, for RHEL where that package is not available. */
const SYSCTL = {
  'fs.file-max': '6815744',
  'kernel.sem': '250 32000 100 128',
  'kernel.shmmni': '4096',
  'kernel.shmall': '1073741824',
  'kernel.shmmax': '4398046511104',
  'kernel.panic_on_oops': '1',
  'net.core.rmem_default': '262144',
  'net.core.rmem_max': '4194304',
  'net.core.wmem_default': '262144',
  'net.core.wmem_max': '1048576',
  'net.ipv4.conf.all.rp_filter': '2',
  'net.ipv4.conf.default.rp_filter': '2',
  'fs.aio-max-nr': '1048576',
  'net.ipv4.ip_local_port_range': '9000 65500',
};

const LIMITS = [
  { item: 'nofile', type: 'soft', value: '1024' },
  { item: 'nofile', type: 'hard', value: '65536' },
  { item: 'nproc', type: 'soft', value: '16384' },
  { item: 'nproc', type: 'hard', value: '16384' },
  { item: 'stack', type: 'soft', value: '10240' },
  { item: 'stack', type: 'hard', value: '32768' },
  { item: 'memlock', type: 'soft', value: '{{ oracle_memlock_kb }}' },
  { item: 'memlock', type: 'hard', value: '{{ oracle_memlock_kb }}' },
];

const tasks: Task[] = [
  {
    name: 'Check the OS is one Oracle Database is certified on here',
    'ansible.builtin.assert': {
      that: ["ansible_facts.distribution in ['OracleLinux', 'RedHat']", "ansible_facts.distribution_major_version in ['8', '9']"],
      fail_msg: 'oracle_db installs on Oracle Linux 8/9 and RHEL 8/9 only; this host is {{ ansible_facts.distribution }} {{ ansible_facts.distribution_version }}.',
      quiet: true,
    },
  },
  {
    name: 'Check the media location is set',
    'ansible.builtin.assert': {
      that: ['oracle_media_url | length > 0'],
      fail_msg: 'Set oracle_media_url to the database home zip in your own repository. The toolkit does not download Oracle software.',
      quiet: true,
    },
  },
  assertVault(['vault_oracle_sys_password', 'vault_oracle_system_password', 'vault_oracle_pdbadmin_password'], 'before creating the database'),
  { name: 'Install the preinstall package (Oracle Linux)', 'ansible.builtin.dnf': { name: '{{ oracle_preinstall_package }}', state: 'present' }, when: ON_OL },
  {
    name: 'Create the Oracle groups (RHEL)',
    'ansible.builtin.group': { name: '{{ item.name }}', gid: '{{ item.gid }}', state: 'present' },
    loop: GROUPS,
    when: ON_RHEL,
  },
  {
    name: 'Create the oracle user (RHEL)',
    'ansible.builtin.user': { name: 'oracle', uid: 54321, group: 'oinstall', groups: GROUPS.slice(1).map((g) => g.name), append: true, state: 'present' },
    when: ON_RHEL,
  },
  { name: 'Install the packages the installer checks for (RHEL)', 'ansible.builtin.dnf': { name: RHEL_PACKAGES, state: 'present' }, when: ON_RHEL },
  {
    name: 'Set the kernel parameters (RHEL)',
    'ansible.posix.sysctl': { name: '{{ item.key }}', value: '{{ item.value }}', sysctl_file: '/etc/sysctl.d/97-oracle-database.conf', reload: true, state: 'present' },
    loop: '{{ oracle_sysctl | dict2items }}',
    when: ON_RHEL,
  },
  {
    name: 'Set the oracle user limits',
    'community.general.pam_limits': { domain: 'oracle', limit_item: '{{ item.item }}', limit_type: '{{ item.type }}', value: '{{ item.value }}' },
    loop: LIMITS,
  },
  {
    name: 'Create the Oracle directories',
    'ansible.builtin.file': { path: '{{ item }}', state: 'directory', owner: 'oracle', group: 'oinstall', mode: '0775' },
    loop: ['{{ oracle_base }}', '{{ oracle_inventory }}', '{{ oracle_home }}', '{{ oracle_data_dir }}', '{{ oracle_fra_dir }}', '{{ oracle_stage_dir }}'],
  },
  {
    name: 'Fetch the database home from the internal repository',
    'ansible.builtin.get_url': { url: '{{ oracle_media_url }}', dest: '{{ oracle_stage_dir }}/{{ oracle_media_url | basename }}', owner: 'oracle', group: 'oinstall', mode: '0644' },
  },
  {
    name: 'Unpack it into the Oracle home',
    'ansible.builtin.unarchive': {
      src: '{{ oracle_stage_dir }}/{{ oracle_media_url | basename }}',
      dest: '{{ oracle_home }}',
      remote_src: true,
      owner: 'oracle',
      group: 'oinstall',
      creates: '{{ oracle_home }}/runInstaller',
    },
    ...AS_ORACLE,
  },
  {
    name: 'Write the install response file',
    'ansible.builtin.template': { src: 'db_install.rsp.j2', dest: '{{ oracle_stage_dir }}/db_install.rsp', owner: 'oracle', group: 'oinstall', mode: '0640' },
  },
  {
    name: 'Install the database software',
    'ansible.builtin.command': {
      argv: ['{{ oracle_home }}/runInstaller', '-silent', '-responseFile', '{{ oracle_stage_dir }}/db_install.rsp', '-ignorePrereqFailure', '-waitforcompletion'],
      creates: '{{ oracle_inventory }}/orainstRoot.sh',
    },
    environment: '{{ oracle_install_env }}',
    register: 'oracle_runinstaller',
    // 6: installed, with warnings the prerequisite checks raised.
    failed_when: 'oracle_runinstaller.rc not in [0, 6]',
    ...AS_ORACLE,
  },
  { name: 'Run orainstRoot.sh', 'ansible.builtin.command': { argv: ['{{ oracle_inventory }}/orainstRoot.sh'], creates: '/etc/oraInst.loc' } },
  { name: 'Run root.sh', 'ansible.builtin.command': { argv: ['{{ oracle_home }}/root.sh'], creates: '/etc/oratab' } },
  {
    name: 'Create the listener',
    'ansible.builtin.command': {
      argv: ['{{ oracle_home }}/bin/netca', '-silent', '-responsefile', '{{ oracle_home }}/assistants/netca/netca.rsp'],
      creates: '{{ oracle_home }}/network/admin/listener.ora',
    },
    environment: '{{ oracle_env }}',
    ...AS_ORACLE,
  },
  {
    name: 'Write the database creation response file',
    'ansible.builtin.template': { src: 'dbca.rsp.j2', dest: '{{ oracle_stage_dir }}/dbca.rsp', owner: 'oracle', group: 'oinstall', mode: '0640' },
  },
  {
    name: 'Create the database',
    'ansible.builtin.command': {
      cmd: '{{ oracle_home }}/bin/dbca -silent -createDatabase -responseFile {{ oracle_stage_dir }}/dbca.rsp -sysPassword $ORACLE_SYS_PASSWORD -systemPassword $ORACLE_SYSTEM_PASSWORD -pdbAdminPassword $ORACLE_PDBADMIN_PASSWORD',
      creates: '{{ oracle_home }}/dbs/spfile{{ oracle_sid }}.ora',
    },
    environment: {
      ORACLE_HOME: '{{ oracle_home }}',
      ORACLE_SYS_PASSWORD: '{{ vault_oracle_sys_password }}',
      ORACLE_SYSTEM_PASSWORD: '{{ vault_oracle_system_password }}',
      ORACLE_PDBADMIN_PASSWORD: '{{ vault_oracle_pdbadmin_password }}',
    },
    no_log: true,
    // A standby is instantiated from the primary (RMAN DUPLICATE), not created.
    when: 'inventory_hostname != oracle_standby_host',
    ...AS_ORACLE,
  },
  {
    name: 'Start the database with the host',
    'ansible.builtin.lineinfile': { path: '/etc/oratab', regexp: '^{{ oracle_sid }}:', line: '{{ oracle_sid }}:{{ oracle_home }}:Y' },
  },
  {
    name: 'Write the systemd unit',
    'ansible.builtin.template': { src: 'oracle-database.service.j2', dest: '/etc/systemd/system/oracle-database.service', owner: 'root', group: 'root', mode: '0644' },
  },
  { name: 'Enable the unit', 'ansible.builtin.systemd_service': { name: 'oracle-database.service', enabled: true, daemon_reload: true } },
  {
    name: 'Write the RMAN backup script',
    'ansible.builtin.template': { src: 'rman_backup.sh.j2', dest: '/home/oracle/rman_backup.sh', owner: 'oracle', group: 'oinstall', mode: '0750' },
  },
  {
    name: 'Schedule RMAN backups for the backup tier',
    'ansible.builtin.cron': {
      name: 'RMAN level {{ item.level }} backup',
      user: 'oracle',
      weekday: '{{ item.weekday }}',
      hour: '{{ item.hour }}',
      minute: '0',
      job: '/home/oracle/rman_backup.sh {{ item.level }} >> /home/oracle/rman_backup.log 2>&1',
    },
    loop: '{{ oracle_backup_schedules[oracle_backup_tier] | default(oracle_backup_schedules.silver) }}',
    when: 'inventory_hostname != oracle_standby_host',
  },
  {
    name: 'Prepare the primary for Data Guard',
    'ansible.builtin.command': {
      argv: ['{{ oracle_home }}/bin/sqlplus', '-S', '-L', '/', 'as', 'sysdba'],
      stdin: 'ALTER DATABASE FORCE LOGGING;\nALTER SYSTEM SET dg_broker_start=TRUE SCOPE=BOTH;\nEXIT;',
    },
    environment: '{{ oracle_env }}',
    changed_when: false,
    when: ["oracle_dr == 'data-guard-remote'", 'oracle_standby_host | length > 0', 'inventory_hostname != oracle_standby_host'],
    ...AS_ORACLE,
  },
  {
    name: 'Create the Data Guard broker configuration',
    'ansible.builtin.command': {
      argv: ['{{ oracle_home }}/bin/dgmgrl', '-silent', '/'],
      stdin:
        "CREATE CONFIGURATION dg_{{ oracle_db_name | lower }} AS PRIMARY DATABASE IS {{ oracle_db_name }} CONNECT IDENTIFIER IS {{ oracle_db_name }};\nADD DATABASE {{ oracle_standby_db_unique_name }} AS CONNECT IDENTIFIER IS {{ oracle_standby_db_unique_name }};\nENABLE CONFIGURATION;\nEXIT;",
    },
    environment: '{{ oracle_env }}',
    register: 'oracle_dgmgrl',
    changed_when: "'already exists' not in oracle_dgmgrl.stdout",
    failed_when: "oracle_dgmgrl.rc != 0 and 'already exists' not in oracle_dgmgrl.stdout",
    when: ["oracle_dr == 'data-guard-remote'", 'oracle_standby_host | length > 0', 'inventory_hostname != oracle_standby_host', 'oracle_standby_ready | bool'],
    ...AS_ORACLE,
  },
];

export const ORACLE_DB: Role = {
  name: 'oracle_db',
  description: 'Oracle Database software, listener and one database, with auto start, archive logging, RMAN backups and Data Guard.',
  tasks,
  defaults: {
    oracle_version: '19c',
    oracle_edition: 'ee',
    oracle_sid: 'ORCL',
    oracle_pdb_name: 'PDB1',
    oracle_character_set: 'AL32UTF8',
    oracle_media_url: '',
    oracle_base: '/u01/app/oracle',
    oracle_inventory: '/u01/app/oraInventory',
    oracle_stage_dir: '/u01/stage',
    oracle_data_dir: '/u02/oradata',
    oracle_fra_dir: '/u03/fra',
    oracle_fra_size_mb: 51200,
    oracle_memory_percent: 40,
    oracle_backup_tier: 'silver',
    oracle_dr: 'none',
    oracle_standby_host: '',
    oracle_standby_db_unique_name: '',
    oracle_standby_ready: false,
  },
  derived: {
    oracle_db_name: '{{ mig_oracle_db_name | default(oracle_sid) }}',
    oracle_release_major: "{{ 23 if (oracle_version | regex_search('^[0-9]+') | int) >= 23 else 19 }}",
    oracle_home: "{{ mig_oracle_home | default(oracle_base ~ '/product/' ~ ('23.0.0' if oracle_release_major | int >= 23 else '19.0.0') ~ '/dbhome_1') }}",
    oracle_preinstall_package:
      "{{ {'19c': 'oracle-database-preinstall-19c', '23ai': 'oracle-database-preinstall-23ai', '26ai': 'oracle-ai-database-preinstall-26ai'}[oracle_version] | default('oracle-database-preinstall-19c') }}",
    oracle_memory_mb: '{{ (ansible_facts.memtotal_mb * oracle_memory_percent / 100) | int }}',
    oracle_memlock_kb: '{{ (ansible_facts.memtotal_mb * 1024 * 0.9) | int }}',
    oracle_env: { ORACLE_HOME: '{{ oracle_home }}', ORACLE_SID: '{{ oracle_sid }}', PATH: '{{ oracle_home }}/bin:/usr/local/bin:/usr/bin:/bin' },
    // The 19.3 base release predates EL8/EL9 in the installer's checks.
    oracle_install_env: "{{ {'CV_ASSUME_DISTID': ('OL7' if ansible_facts.distribution_major_version == '8' else 'OL8')} if oracle_release_major | int < 23 else {} }}",
    oracle_backup_retention_days: '{{ mig_oracle_backup_retention_days | default({"gold": 35, "silver": 14, "bronze": 7}[oracle_backup_tier] | default(14)) }}',
    oracle_backup_schedules: {
      gold: [
        { level: 0, weekday: '0', hour: '1' },
        { level: 1, weekday: '1-6', hour: '1' },
      ],
      silver: [
        { level: 0, weekday: '0', hour: '1' },
        { level: 1, weekday: '1-6', hour: '1' },
      ],
      bronze: [{ level: 0, weekday: '0', hour: '1' }],
    },
    oracle_sysctl: SYSCTL,
  },
  templates: {
    'db_install.rsp.j2': DB_INSTALL_RSP,
    'dbca.rsp.j2': DBCA_RSP,
    'oracle-database.service.j2': ORACLE_SERVICE,
    'rman_backup.sh.j2': RMAN_BACKUP_SH,
  },
};
