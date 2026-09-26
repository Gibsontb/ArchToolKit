/**
 * Open-source databases on migrated hosts: postgres_server and mysql_server.
 *
 * PostgreSQL comes from the PGDG repository (RHEL family, Debian/Ubuntu) or
 * the distribution (SLES); MySQL from Oracle's repository, or MariaDB from
 * the distribution. Settings go in an include file beside the package's own
 * configuration (templates/databases.ts says why). Both listen on IPv4 and
 * IPv6, and admit clients from the app subnets of both families.
 *
 * Passwords are vault variables, set with no_log: vault_postgres_password
 * (the admin role), vault_postgres_replication_password (the streaming
 * replica), vault_mysql_root_password.
 */

import { MY_CNF, POSTGRESQL_CONF } from '../templates/databases.ts';
import { assertVault } from './ad_join.ts';
import { CHECK_MODE_TOLERANT, type Role, type Task } from './types.ts';

const RH = "ansible_facts.os_family == 'RedHat'";
const DEB = "ansible_facts.os_family == 'Debian'";
const SUSE = "ansible_facts.os_family == 'Suse'";
const AS_POSTGRES = { become: true, become_user: 'postgres' } as const;
const PG_PRIMARY = "postgres_ha != 'pg-streaming' or postgres_primary | length == 0 or inventory_hostname == postgres_primary";
const PG_STANDBY = ["postgres_ha == 'pg-streaming'", 'postgres_primary | length > 0', 'inventory_hostname != postgres_primary'];

const postgresTasks: Task[] = [
  {
    name: 'Check the family is one this role knows',
    'ansible.builtin.assert': { that: ["ansible_facts.os_family in ['RedHat', 'Debian', 'Suse']"], fail_msg: 'postgres_server covers the RHEL family, Debian/Ubuntu and SLES.', quiet: true },
  },
  assertVault(['vault_postgres_password'], 'before creating the admin role'),
  {
    name: 'Add the PGDG repository (RHEL family)',
    'ansible.builtin.dnf': {
      name: 'https://download.postgresql.org/pub/repos/yum/reporpms/EL-{{ ansible_facts.distribution_major_version }}-{{ ansible_facts.architecture }}/pgdg-redhat-repo-latest.noarch.rpm',
      state: 'present',
    },
    when: RH,
  },
  {
    name: "Turn off the distribution's PostgreSQL module (RHEL family)",
    'ansible.builtin.command': { argv: ['dnf', '-qy', 'module', 'disable', 'postgresql'] },
    changed_when: false,
    when: RH,
  },
  {
    name: 'Add the PGDG repository (Debian family)',
    'ansible.builtin.deb822_repository': {
      install_python_debian: true,
      name: 'pgdg',
      types: ['deb'],
      uris: ['https://apt.postgresql.org/pub/repos/apt'],
      suites: ['{{ ansible_facts.distribution_release }}-pgdg'],
      components: ['main'],
      signed_by: 'https://www.postgresql.org/media/keys/ACCC4CF8.asc',
      state: 'present',
    },
    when: DEB,
  },
  { name: 'Refresh the package lists (Debian family)', 'ansible.builtin.apt': { update_cache: true }, when: DEB },
  { name: 'Install PostgreSQL', 'ansible.builtin.package': { name: '{{ postgres_packages[ansible_facts.os_family] }}', state: 'present' } },
  {
    name: 'Initialise the cluster (RHEL family)',
    'ansible.builtin.command': { argv: ['{{ postgres_bin_dir }}/postgresql-{{ postgres_version }}-setup', 'initdb'], creates: '{{ postgres_data_dir }}/PG_VERSION' },
    when: RH,
  },
  {
    name: 'Initialise the cluster (SLES)',
    'ansible.builtin.command': {
      argv: ['{{ postgres_bin_dir }}/initdb', '-D', '{{ postgres_data_dir }}', '--auth-local=peer', '--auth-host=scram-sha-256'],
      creates: '{{ postgres_data_dir }}/PG_VERSION',
    },
    when: SUSE,
    ...AS_POSTGRES,
  },
  {
    name: 'Read conf.d (RHEL family and SLES; Debian already does)',
    'ansible.builtin.lineinfile': { path: '{{ postgres_conf_dir }}/postgresql.conf', regexp: "^include_dir\\s*=\\s*'conf\\.d'", line: "include_dir = 'conf.d'" },
    notify: 'Restart PostgreSQL',
    when: `${RH} or ${SUSE}`,
  },
  { name: 'Create conf.d', 'ansible.builtin.file': { path: '{{ postgres_conf_dir }}/conf.d', state: 'directory', owner: 'postgres', group: 'postgres', mode: '0750' } },
  {
    name: 'Write the server settings',
    'ansible.builtin.template': { src: 'postgresql.conf.j2', dest: '{{ postgres_conf_dir }}/conf.d/50-server.conf', owner: 'postgres', group: 'postgres', mode: '0640' },
    notify: 'Restart PostgreSQL',
  },
  {
    name: 'Admit the app subnets (IPv4 and IPv6, scram-sha-256)',
    'community.postgresql.postgresql_pg_hba': {
      dest: '{{ postgres_conf_dir }}/pg_hba.conf',
      contype: 'host',
      databases: 'all',
      users: 'all',
      address: '{{ item }}',
      method: 'scram-sha-256',
      state: 'present',
    },
    loop: '{{ postgres_client_cidrs }}',
    notify: 'Reload PostgreSQL',
  },
  {
    name: 'Admit the replica',
    'community.postgresql.postgresql_pg_hba': {
      dest: '{{ postgres_conf_dir }}/pg_hba.conf',
      contype: 'host',
      databases: 'replication',
      users: 'replicator',
      address: '{{ item }}',
      method: 'scram-sha-256',
      state: 'present',
    },
    loop: '{{ postgres_replication_cidrs }}',
    notify: 'Reload PostgreSQL',
    when: "postgres_ha == 'pg-streaming'",
  },
  { name: 'Keep PostgreSQL running', ...CHECK_MODE_TOLERANT, 'ansible.builtin.service': { name: '{{ postgres_service }}', state: 'started', enabled: true } },
  { name: 'Apply the settings now', 'ansible.builtin.meta': 'flush_handlers' },
  {
    name: 'Create the admin role',
    'community.postgresql.postgresql_user': { name: '{{ postgres_admin_user }}', password: '{{ vault_postgres_password }}', role_attr_flags: 'SUPERUSER', state: 'present' },
    no_log: true,
    when: PG_PRIMARY,
    ...AS_POSTGRES,
  },
  {
    name: 'Create the replication role',
    'community.postgresql.postgresql_user': { name: 'replicator', password: '{{ vault_postgres_replication_password }}', role_attr_flags: 'REPLICATION', state: 'present' },
    no_log: true,
    when: ["postgres_ha == 'pg-streaming'", PG_PRIMARY],
    ...AS_POSTGRES,
  },
  {
    name: 'Build the streaming replica from the primary',
    when: PG_STANDBY,
    block: [
      { name: 'Look for an existing standby', 'ansible.builtin.stat': { path: '{{ postgres_data_dir }}/standby.signal' }, register: 'postgres_standby_signal' },
      {
        name: 'Stop the empty cluster',
        'ansible.builtin.service': { name: '{{ postgres_service }}', state: 'stopped' },
        when: 'not postgres_standby_signal.stat.exists',
      },
      {
        name: 'Clear the empty cluster',
        'ansible.builtin.file': { path: '{{ postgres_data_dir }}', state: 'absent' },
        when: 'not postgres_standby_signal.stat.exists',
      },
      {
        name: 'Copy the primary with pg_basebackup',
        'ansible.builtin.command': {
          argv: ['{{ postgres_bin_dir }}/pg_basebackup', '-h', '{{ hostvars[postgres_primary].ansible_host | default(postgres_primary) }}', '-p', '{{ postgres_port }}', '-U', 'replicator', '-D', '{{ postgres_data_dir }}', '-R', '-X', 'stream'],
          creates: '{{ postgres_data_dir }}/standby.signal',
        },
        environment: { PGPASSWORD: '{{ vault_postgres_replication_password }}' },
        no_log: true,
        ...AS_POSTGRES,
      },
      { name: 'Start the replica', 'ansible.builtin.service': { name: '{{ postgres_service }}', state: 'started', enabled: true } },
    ],
  },
  { name: 'Create the backup directory', 'ansible.builtin.file': { path: '{{ postgres_backup_dir }}', state: 'directory', owner: 'postgres', group: 'postgres', mode: '0750' } },
  {
    name: 'Schedule pg_dumpall for the backup tier',
    'ansible.builtin.cron': {
      name: 'PostgreSQL backup',
      user: 'postgres',
      minute: '15',
      hour: '{{ postgres_backup_schedule[postgres_backup_tier].hour | default("1") }}',
      weekday: '{{ postgres_backup_schedule[postgres_backup_tier].weekday | default("*") }}',
      job: "{{ postgres_bin_dir }}/pg_dumpall -p {{ postgres_port }} | gzip > {{ postgres_backup_dir }}/all-$(date +\\%Y\\%m\\%d\\%H\\%M).sql.gz && find {{ postgres_backup_dir }} -name 'all-*.sql.gz' -mtime +{{ postgres_backup_retention_days }} -delete",
    },
    when: PG_PRIMARY,
  },
  {
    name: 'Open PostgreSQL in firewalld (IPv4 and IPv6)', ...CHECK_MODE_TOLERANT,
    'ansible.posix.firewalld': { port: '{{ postgres_port }}/tcp', permanent: true, immediate: true, state: 'enabled' },
    when: `${RH} or ${SUSE}`,
  },
  { name: 'Open PostgreSQL in ufw (IPv4 and IPv6)', ...CHECK_MODE_TOLERANT, 'community.general.ufw': { rule: 'allow', port: '{{ postgres_port }}', proto: 'tcp' }, when: DEB },
];

export const POSTGRES_SERVER: Role = {
  name: 'postgres_server',
  description: 'PostgreSQL from PGDG, tuned, with app-subnet access, an admin role, a streaming replica and scheduled dumps.',
  tasks: postgresTasks,
  handlers: [
    { name: 'Restart PostgreSQL', 'ansible.builtin.service': { name: '{{ postgres_service }}', state: 'restarted' } },
    { name: 'Reload PostgreSQL', 'ansible.builtin.service': { name: '{{ postgres_service }}', state: 'reloaded' } },
  ],
  defaults: {
    postgres_version: '16',
    postgres_port: 5432,
    postgres_listen_addresses: ['0.0.0.0', '::'],
    postgres_max_connections: 200,
    postgres_shared_buffers_percent: 25,
    postgres_effective_cache_percent: 75,
    postgres_client_cidrs: [],
    postgres_replication_cidrs: [],
    postgres_admin_user: 'dbadmin',
    postgres_ha: 'none',
    postgres_primary: '',
    postgres_backup_tier: 'silver',
    postgres_backup_dir: '/var/backups/postgresql',
  },
  derived: {
    postgres_data_dir:
      "{{ {'RedHat': '/var/lib/pgsql/' ~ postgres_version ~ '/data', 'Debian': '/var/lib/postgresql/' ~ postgres_version ~ '/main', 'Suse': '/var/lib/pgsql/data'}[ansible_facts.os_family] }}",
    postgres_conf_dir: "{{ '/etc/postgresql/' ~ postgres_version ~ '/main' if ansible_facts.os_family == 'Debian' else postgres_data_dir }}",
    postgres_bin_dir:
      "{{ {'RedHat': '/usr/pgsql-' ~ postgres_version ~ '/bin', 'Debian': '/usr/lib/postgresql/' ~ postgres_version ~ '/bin', 'Suse': '/usr/lib/postgresql' ~ postgres_version ~ '/bin'}[ansible_facts.os_family] }}",
    postgres_service: "{{ {'RedHat': 'postgresql-' ~ postgres_version, 'Debian': 'postgresql@' ~ postgres_version ~ '-main', 'Suse': 'postgresql'}[ansible_facts.os_family] }}",
    postgres_packages: {
      RedHat: ['postgresql{{ postgres_version }}-server', 'postgresql{{ postgres_version }}-contrib', 'python3-psycopg2', 'acl'],
      Debian: ['postgresql-{{ postgres_version }}', 'python3-psycopg2', 'acl'],
      Suse: ['postgresql{{ postgres_version }}-server', 'postgresql{{ postgres_version }}-contrib', 'python3-psycopg2', 'acl'],
    },
    postgres_backup_schedule: { gold: { hour: '*/6' }, silver: { hour: '1' }, bronze: { hour: '1', weekday: '0' } },
    postgres_backup_retention_days: '{{ mig_postgres_backup_retention_days | default({"gold": 35, "silver": 14, "bronze": 28}[postgres_backup_tier] | default(14)) }}',
  },
  templates: { 'postgresql.conf.j2': POSTGRESQL_CONF },
};

// ----------------------------------------------------------------- MySQL ---

const mysqlTasks: Task[] = [
  {
    name: 'Check the family is one this role knows',
    'ansible.builtin.assert': { that: ["ansible_facts.os_family in ['RedHat', 'Debian', 'Suse']"], fail_msg: 'mysql_server covers the RHEL family, Debian/Ubuntu and SLES.', quiet: true },
  },
  assertVault(['vault_mysql_root_password'], 'before securing root'),
  { name: "Trust Oracle's MySQL package key (RHEL family and SLES)", 'ansible.builtin.rpm_key': { key: '{{ mysql_repo_key }}', state: 'present' }, when: [`${RH} or ${SUSE}`, "mysql_flavour == 'mysql'"] },
  {
    name: 'Add the MySQL repository (RHEL family)',
    'ansible.builtin.yum_repository': {
      name: 'mysql-community',
      description: 'MySQL {{ mysql_version }} Community Server',
      baseurl: 'https://repo.mysql.com/yum/mysql-{{ mysql_version }}-community/el/{{ ansible_facts.distribution_major_version }}/$basearch/',
      gpgcheck: true,
      gpgkey: '{{ mysql_repo_key }}',
      enabled: true,
    },
    when: [RH, "mysql_flavour == 'mysql'"],
  },
  {
    name: "Turn off the distribution's MySQL module (RHEL family)",
    'ansible.builtin.command': { argv: ['dnf', '-qy', 'module', 'disable', 'mysql'] },
    changed_when: false,
    when: [RH, "mysql_flavour == 'mysql'"],
  },
  {
    name: 'Add the MySQL repository (Debian family)',
    'ansible.builtin.deb822_repository': {
      install_python_debian: true,
      name: 'mysql',
      types: ['deb'],
      uris: ['https://repo.mysql.com/apt/{{ ansible_facts.distribution | lower }}'],
      suites: ['{{ ansible_facts.distribution_release }}'],
      components: ['mysql-{{ mysql_repo_series }}'],
      signed_by: '{{ mysql_repo_key }}',
      state: 'present',
    },
    when: [DEB, "mysql_flavour == 'mysql'"],
  },
  {
    name: 'Add the MySQL repository (SLES)',
    'community.general.zypper_repository': {
      name: 'mysql-community',
      repo: 'https://repo.mysql.com/yum/mysql-{{ mysql_version }}-community/sles/{{ ansible_facts.distribution_major_version }}/$basearch/',
      state: 'present',
    },
    when: [SUSE, "mysql_flavour == 'mysql'"],
  },
  { name: 'Refresh the package lists (Debian family)', 'ansible.builtin.apt': { update_cache: true }, when: DEB },
  {
    name: 'Install the server',
    'ansible.builtin.package': { name: '{{ mysql_packages[mysql_flavour][ansible_facts.os_family] }}', state: 'present' },
    environment: { DEBIAN_FRONTEND: 'noninteractive' },
  },
  { name: 'Create the include directory', 'ansible.builtin.file': { path: '{{ mysql_include_dir }}', state: 'directory', owner: 'root', group: 'root', mode: '0755' } },
  {
    name: 'Write the server settings',
    'ansible.builtin.template': { src: 'my.cnf.j2', dest: '{{ mysql_include_dir }}/50-server.cnf', owner: 'root', group: 'root', mode: '0644' },
    notify: 'Restart MySQL',
  },
  {
    name: 'Initialise the data directory without a temporary root password (RHEL family and SLES, MySQL)',
    'ansible.builtin.command': { argv: ['mysqld', '--initialize-insecure', '--user=mysql'], creates: '/var/lib/mysql/mysql' },
    when: [`${RH} or ${SUSE}`, "mysql_flavour == 'mysql'"],
  },
  { name: 'Keep the server running', ...CHECK_MODE_TOLERANT, 'ansible.builtin.service': { name: '{{ mysql_service }}', state: 'started', enabled: true } },
  { name: 'Apply the settings now', 'ansible.builtin.meta': 'flush_handlers' },
  {
    name: 'Set the root password',
    'ansible.mysql.mysql_user': {
      name: 'root',
      host: 'localhost',
      password: '{{ vault_mysql_root_password }}',
      login_user: 'root',
      login_password: '{{ vault_mysql_root_password }}',
      login_unix_socket: '{{ mysql_socket }}',
      check_implicit_admin: true,
      state: 'present',
    },
    no_log: true,
  },
  {
    name: 'Say how group replication is started',
    'ansible.builtin.debug': {
      msg: 'Group replication is configured but not started: bootstrap it once on the first member (SET GLOBAL group_replication_bootstrap_group=ON; START GROUP_REPLICATION; ...=OFF), then START GROUP_REPLICATION on the others. The runbook has the step.',
    },
    when: "mysql_ha == 'group-replication'",
  },
  {
    name: 'Open MySQL in firewalld (IPv4 and IPv6)', ...CHECK_MODE_TOLERANT,
    'ansible.posix.firewalld': { port: '{{ mysql_port }}/tcp', permanent: true, immediate: true, state: 'enabled' },
    when: `${RH} or ${SUSE}`,
  },
  { name: 'Open MySQL in ufw (IPv4 and IPv6)', ...CHECK_MODE_TOLERANT, 'community.general.ufw': { rule: 'allow', port: '{{ mysql_port }}', proto: 'tcp' }, when: DEB },
];

export const MYSQL_SERVER: Role = {
  name: 'mysql_server',
  description: "MySQL from Oracle's repository (or MariaDB), tuned, listening on IPv4 and IPv6, with root secured from the vault.",
  tasks: mysqlTasks,
  handlers: [{ name: 'Restart MySQL', 'ansible.builtin.service': { name: '{{ mysql_service }}', state: 'restarted' } }],
  defaults: {
    mysql_flavour: 'mysql',
    mysql_version: '8.4',
    mysql_port: 3306,
    mysql_bind_address: '::',
    mysql_max_connections: 500,
    mysql_buffer_pool_percent: 70,
    mysql_ha: 'none',
    mysql_group_replication_name: '',
    mysql_group_replication_seeds: [],
  },
  derived: {
    mysql_repo_series: "{{ '8.4-lts' if mysql_version is match('^8\\.4') else mysql_version }}",
    mysql_repo_key: 'https://repo.mysql.com/RPM-GPG-KEY-mysql-2023',
    mysql_server_id: "{{ 1 + ((inventory_hostname | hash('md5'))[0:6] | int(base=16)) }}",
    mysql_packages: {
      mysql: { RedHat: ['mysql-community-server', 'python3-PyMySQL'], Debian: ['mysql-server', 'python3-pymysql'], Suse: ['mysql-community-server', 'python3-PyMySQL'] },
      mariadb: { RedHat: ['mariadb-server', 'python3-PyMySQL'], Debian: ['mariadb-server', 'python3-pymysql'], Suse: ['mariadb', 'python3-PyMySQL'] },
    },
    mysql_service:
      "{{ 'mariadb' if mysql_flavour == 'mariadb' else ('mysql' if ansible_facts.os_family == 'Debian' else 'mysqld') }}",
    mysql_include_dir:
      "{{ ('/etc/mysql/mariadb.conf.d' if mysql_flavour == 'mariadb' else '/etc/mysql/mysql.conf.d') if ansible_facts.os_family == 'Debian' else '/etc/my.cnf.d' }}",
    mysql_socket: "{{ '/var/run/mysqld/mysqld.sock' if ansible_facts.os_family == 'Debian' else '/var/lib/mysql/mysql.sock' }}",
  },
  templates: { 'my.cnf.j2': MY_CNF },
};
