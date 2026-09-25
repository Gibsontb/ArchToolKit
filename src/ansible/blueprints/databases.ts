/**
 * Hand-written databases and messaging playbooks: an application database
 * with its owner and grants on PostgreSQL, MySQL/MariaDB, SQL Server,
 * MongoDB and ClickHouse; a dated PostgreSQL backup with retention; and a
 * RabbitMQ vhost with its user, permissions and policy.
 *
 * Every password comes from a vault_ variable, and every task that carries
 * one has no_log set so it never reaches the output.
 */

import type { Blueprint, BlueprintInput } from '../../kit/blueprint.ts';
import { HOSTS_INPUT } from './common.ts';
import { items, on, pairs, playbookScenario } from './scenario.ts';

const hosts = (group: string): BlueprintInput => ({ ...HOSTS_INPUT, default: group });

const AS_POSTGRES = { become: true, become_user: 'postgres' } as const;

const PG_PRIVS: Record<string, string> = {
  readwrite: 'SELECT,INSERT,UPDATE,DELETE',
  readonly: 'SELECT',
  all: 'ALL',
};

const postgres_db_user = playbookScenario({
  id: 'db_postgres_database_user',
  label: 'PostgreSQL database, user and grants',
  group: 'Playbooks · PostgreSQL',
  description:
    'Create an application role and a database it owns, grant table privileges to a second role if wanted, and allow it in pg_hba.conf.',
  inputs: [
    hosts('postgres'),
    { id: 'db_name', label: 'Database', control: 'text', default: 'appdb' },
    { id: 'owner', label: 'Owner role', control: 'text', default: 'app', hint: 'Created with LOGIN; password from vault_pg_owner_password' },
    { id: 'encoding', label: 'Encoding', control: 'text', default: 'UTF8' },
    { id: 'grantee', label: 'Extra role to grant to', control: 'text', default: 'app_reader', hint: 'Empty for none; password from vault_pg_grantee_password' },
    {
      id: 'grantee_privs',
      label: 'Its table privileges',
      control: 'select',
      default: 'readonly',
      options: [
        { value: 'readonly', label: 'Read only (SELECT)' },
        { value: 'readwrite', label: 'Read/write (SELECT, INSERT, UPDATE, DELETE)' },
        { value: 'all', label: 'All' },
      ],
      showWhen: { input: 'grantee', notEquals: [''] },
    },
    { id: 'schema', label: 'Schema', control: 'text', default: 'public', showWhen: { input: 'grantee', notEquals: [''] } },
    { id: 'hba', label: 'Add a pg_hba.conf rule', control: 'toggle', default: true },
    { id: 'hba_path', label: 'pg_hba.conf path', control: 'text', default: '/etc/postgresql/16/main/pg_hba.conf', hint: 'RHEL: /var/lib/pgsql/16/data/pg_hba.conf', showWhen: { input: 'hba', equals: ['true'] } },
    { id: 'hba_source', label: 'Client network', control: 'text', default: '10.0.0.0/8', hint: 'CIDR the app connects from', showWhen: { input: 'hba', equals: ['true'] } },
    {
      id: 'hba_method',
      label: 'Authentication method',
      control: 'select',
      default: 'scram-sha-256',
      options: [
        { value: 'scram-sha-256', label: 'scram-sha-256' },
        { value: 'md5', label: 'md5 (legacy clients)' },
        { value: 'cert', label: 'cert (client certificates)' },
      ],
      showWhen: { input: 'hba', equals: ['true'] },
    },
    {
      id: 'hba_type',
      label: 'Connection type',
      control: 'select',
      default: 'hostssl',
      options: [
        { value: 'hostssl', label: 'hostssl (TLS only)' },
        { value: 'host', label: 'host (TLS or plain)' },
      ],
      showWhen: { input: 'hba', equals: ['true'] },
    },
    { id: 'service_name', label: 'PostgreSQL service', control: 'text', default: 'postgresql', hint: 'Reloaded after pg_hba changes; RHEL: postgresql-16', showWhen: { input: 'hba', equals: ['true'] } },
  ],
  plays: (v) => {
    const grantee = String(v.grantee ?? '').trim();
    const roles = [v.owner, ...(grantee ? [grantee] : [])].join(',');
    return [
      {
        name: `Provision the ${v.db_name} PostgreSQL database`,
        hosts: v.hosts,
        become: true,
        tasks: [
          { name: 'Install the Python driver the modules use', 'ansible.builtin.package': { name: 'python3-psycopg2', state: 'present' } },
          {
            name: `Create the ${v.owner} role`,
            'community.postgresql.postgresql_user': {
              name: v.owner,
              password: '{{ vault_pg_owner_password }}',
              role_attr_flags: 'LOGIN,NOSUPERUSER,NOCREATEROLE,NOCREATEDB',
              state: 'present',
            },
            ...AS_POSTGRES,
            no_log: true,
          },
          ...(grantee
            ? [
                {
                  name: `Create the ${grantee} role`,
                  'community.postgresql.postgresql_user': {
                    name: grantee,
                    password: '{{ vault_pg_grantee_password }}',
                    role_attr_flags: 'LOGIN,NOSUPERUSER,NOCREATEROLE,NOCREATEDB',
                    state: 'present',
                  },
                  ...AS_POSTGRES,
                  no_log: true,
                },
              ]
            : []),
          {
            name: `Create ${v.db_name}`,
            'community.postgresql.postgresql_db': { name: v.db_name, owner: v.owner, encoding: v.encoding, template: 'template0', state: 'present' },
            ...AS_POSTGRES,
          },
          {
            name: 'Revoke CONNECT from PUBLIC',
            'community.postgresql.postgresql_privs': { login_db: v.db_name, type: 'database', privs: 'CONNECT', roles: 'PUBLIC', state: 'absent' },
            ...AS_POSTGRES,
          },
          {
            name: 'Grant CONNECT to the application roles',
            'community.postgresql.postgresql_privs': { login_db: v.db_name, type: 'database', privs: 'CONNECT', roles, state: 'present' },
            ...AS_POSTGRES,
          },
          ...(grantee
            ? [
                {
                  name: `Grant USAGE on ${v.schema} to ${grantee}`,
                  'community.postgresql.postgresql_privs': { login_db: v.db_name, type: 'schema', objs: v.schema, privs: 'USAGE', roles: grantee },
                  ...AS_POSTGRES,
                },
                {
                  name: `Grant ${PG_PRIVS[v.grantee_privs] ?? 'SELECT'} on existing tables to ${grantee}`,
                  'community.postgresql.postgresql_privs': {
                    login_db: v.db_name,
                    type: 'table',
                    schema: v.schema,
                    objs: 'ALL_IN_SCHEMA',
                    privs: PG_PRIVS[v.grantee_privs] ?? 'SELECT',
                    roles: grantee,
                  },
                  ...AS_POSTGRES,
                },
                {
                  name: `Grant the same on tables ${v.owner} creates later`,
                  'community.postgresql.postgresql_privs': {
                    login_db: v.db_name,
                    type: 'default_privs',
                    schema: v.schema,
                    objs: 'TABLES',
                    privs: PG_PRIVS[v.grantee_privs] ?? 'SELECT',
                    roles: grantee,
                    target_roles: v.owner,
                  },
                  ...AS_POSTGRES,
                },
              ]
            : []),
          ...(on(v.hba)
            ? [
                {
                  name: 'Allow the application roles in pg_hba.conf',
                  'community.postgresql.postgresql_pg_hba': {
                    dest: v.hba_path,
                    contype: v.hba_type,
                    databases: v.db_name,
                    users: roles,
                    address: v.hba_source,
                    method: v.hba_method,
                    comment: 'managed by Ansible',
                    backup: true,
                    state: 'present',
                  },
                  ...AS_POSTGRES,
                  notify: 'Reload postgresql',
                },
              ]
            : []),
        ],
        handlers: on(v.hba) ? [{ name: 'Reload postgresql', 'ansible.builtin.service': { name: v.service_name, state: 'reloaded' } }] : undefined,
      },
    ];
  },
  needs: (v) => ({
    vault_pg_owner_password: `Password for the ${v.owner} role`,
    ...(String(v.grantee ?? '').trim() ? { vault_pg_grantee_password: `Password for the ${v.grantee} role` } : {}),
  }),
});

const postgres_backup = playbookScenario({
  id: 'db_postgres_backup',
  label: 'PostgreSQL backup to a dated file',
  group: 'Playbooks · PostgreSQL',
  description: 'Dump a database with pg_dump to a timestamped file, prune dumps past the retention period, and optionally copy the new one back to the control node.',
  inputs: [
    hosts('postgres'),
    { id: 'db_name', label: 'Database', control: 'text', default: 'appdb' },
    { id: 'backup_dir', label: 'Backup directory', control: 'text', default: '/var/backups/postgresql' },
    {
      id: 'format',
      label: 'Dump format',
      control: 'select',
      default: 'custom',
      options: [
        { value: 'custom', label: 'Custom (.pgc, restore with pg_restore)' },
        { value: 'plain_gz', label: 'Plain SQL, gzipped (.sql.gz)' },
        { value: 'tar', label: 'Tar (.tar)' },
      ],
    },
    { id: 'retention_days', label: 'Keep dumps for (days)', control: 'number', default: 14, min: 1, max: 3650 },
    { id: 'fetch', label: 'Copy the dump to the control node', control: 'toggle', default: false },
    { id: 'fetch_dir', label: 'Local directory', control: 'text', default: '{{ playbook_dir }}/backups', showWhen: { input: 'fetch', equals: ['true'] } },
  ],
  plays: (v) => {
    // postgresql_db picks pg_dump's format from the extension: .pgc custom, .tar tar, .gz compressed plain.
    const ext = v.format === 'plain_gz' ? 'sql.gz' : v.format === 'tar' ? 'tar' : 'pgc';
    const target = `${v.backup_dir}/${v.db_name}_{{ ansible_facts['date_time']['iso8601_basic_short'] }}.${ext}`;
    return [
      {
        name: `Back up the ${v.db_name} PostgreSQL database`,
        hosts: v.hosts,
        become: true,
        vars: { backup_file: target },
        tasks: [
          {
            name: 'Create the backup directory',
            'ansible.builtin.file': { path: v.backup_dir, state: 'directory', owner: 'postgres', group: 'postgres', mode: '0750' },
          },
          {
            name: `Dump ${v.db_name}`,
            'community.postgresql.postgresql_db': { name: v.db_name, state: 'dump', target: '{{ backup_file }}' },
            ...AS_POSTGRES,
          },
          {
            name: 'Find dumps past retention',
            'ansible.builtin.find': { paths: v.backup_dir, patterns: `${v.db_name}_*`, age: `${Number(v.retention_days)}d` },
            register: 'old_dumps',
          },
          {
            name: 'Remove dumps past retention',
            'ansible.builtin.file': { path: '{{ item.path }}', state: 'absent' },
            loop: '{{ old_dumps.files }}',
            loop_control: { label: '{{ item.path }}' },
          },
          ...(on(v.fetch)
            ? [
                {
                  name: 'Copy the dump to the control node',
                  'ansible.builtin.fetch': { src: '{{ backup_file }}', dest: `${v.fetch_dir}/{{ inventory_hostname }}/`, flat: true },
                },
              ]
            : []),
        ],
      },
    ];
  },
});

const MYSQL_PRIVS: Record<string, string> = {
  all: 'ALL',
  readwrite: 'SELECT,INSERT,UPDATE,DELETE,EXECUTE,SHOW VIEW',
  readonly: 'SELECT,SHOW VIEW',
};

const mysql_db_user = playbookScenario({
  id: 'db_mysql_database_user',
  label: 'MySQL / MariaDB database and user',
  group: 'Playbooks · MySQL and MariaDB',
  description: 'Create a database and an application user with privileges on it, logging in as root over the Unix socket or with a vaulted admin password.',
  inputs: [
    hosts('mysql'),
    {
      id: 'flavour',
      label: 'Server',
      control: 'select',
      default: 'mysql',
      options: [
        { value: 'mysql', label: 'MySQL (ansible.mysql)' },
        { value: 'mariadb', label: 'MariaDB (ansible.mariadb)' },
      ],
    },
    {
      id: 'login_method',
      label: 'Log in as admin via',
      control: 'select',
      default: 'socket',
      options: [
        { value: 'socket', label: 'Unix socket as root (auth_socket / unix_socket)' },
        { value: 'password', label: 'Admin user and vaulted password' },
      ],
    },
    { id: 'socket', label: 'Socket path', control: 'text', default: '/run/mysqld/mysqld.sock', hint: 'RHEL: /var/lib/mysql/mysql.sock', showWhen: { input: 'login_method', equals: ['socket'] } },
    { id: 'admin_user', label: 'Admin user', control: 'text', default: 'admin', hint: 'Password from vault_mysql_admin_password', showWhen: { input: 'login_method', equals: ['password'] } },
    { id: 'admin_host', label: 'Server address', control: 'text', default: '127.0.0.1', showWhen: { input: 'login_method', equals: ['password'] } },
    { id: 'db_name', label: 'Database', control: 'text', default: 'appdb' },
    { id: 'encoding', label: 'Character set', control: 'text', default: 'utf8mb4' },
    { id: 'collation', label: 'Collation', control: 'text', default: 'utf8mb4_unicode_ci' },
    { id: 'app_user', label: 'Application user', control: 'text', default: 'app', hint: 'Password from vault_mysql_app_password' },
    { id: 'app_host', label: 'Connects from', control: 'text', default: '10.%', hint: "Host part of the account: %, 10.%, an IP or 'localhost'" },
    {
      id: 'privileges',
      label: 'Privileges on the database',
      control: 'select',
      default: 'readwrite',
      options: [
        { value: 'readwrite', label: 'Read/write (DML, EXECUTE)' },
        { value: 'readonly', label: 'Read only' },
        { value: 'all', label: 'All (owner, can run migrations)' },
      ],
    },
  ],
  plays: (v) => {
    const maria = v.flavour === 'mariadb';
    const mod = (m: 'db' | 'user') => (maria ? `ansible.mariadb.mariadb_${m}` : `ansible.mysql.mysql_${m}`);
    const login =
      v.login_method === 'password'
        ? { login_host: v.admin_host, login_user: v.admin_user, login_password: '{{ vault_mysql_admin_password }}' }
        : { login_unix_socket: v.socket, login_user: 'root' };
    return [
      {
        name: `Provision the ${v.db_name} database`,
        hosts: v.hosts,
        become: true,
        tasks: [
          { name: 'Install the Python driver the modules use', 'ansible.builtin.package': { name: 'python3-pymysql', state: 'present' } },
          {
            name: `Create ${v.db_name}`,
            [mod('db')]: { name: v.db_name, encoding: v.encoding, collation: v.collation, state: 'present', ...login },
            no_log: v.login_method === 'password',
          },
          {
            name: `Create ${v.app_user}@${v.app_host} with its privileges`,
            [mod('user')]: {
              name: v.app_user,
              host: v.app_host,
              password: '{{ vault_mysql_app_password }}',
              priv: `${v.db_name}.*:${MYSQL_PRIVS[v.privileges] ?? 'ALL'}`,
              state: 'present',
              ...login,
            },
            no_log: true,
          },
        ],
      },
    ];
  },
  needs: (v) => ({
    vault_mysql_app_password: `Password for ${v.app_user}`,
    ...(v.login_method === 'password' ? { vault_mysql_admin_password: `Password for the ${v.admin_user} admin account` } : {}),
  }),
});

const mongodb_rs_user = playbookScenario({
  id: 'db_mongodb_replicaset_user',
  label: 'MongoDB replica set and users',
  group: 'Playbooks · MongoDB',
  description:
    'Initiate a replica set from one member, wait for it to elect a primary, create the first admin user through the localhost exception, then an application user.',
  inputs: [
    hosts('mongodb'),
    { id: 'replica_set', label: 'Replica set name', control: 'text', default: 'rs0', hint: 'Must match replication.replSetName in mongod.conf' },
    { id: 'members', label: 'Members', control: 'textarea', default: 'mongo1.example.com:27017\nmongo2.example.com:27017\nmongo3.example.com:27017', hint: 'One host:port per line; an odd number' },
    { id: 'admin_user', label: 'Admin user', control: 'text', default: 'admin', hint: 'Password from vault_mongodb_admin_password' },
    { id: 'app_db', label: 'Application database', control: 'text', default: 'appdb' },
    { id: 'app_user', label: 'Application user', control: 'text', default: 'app', hint: 'Password from vault_mongodb_app_password' },
    {
      id: 'app_role',
      label: 'Its role',
      control: 'select',
      default: 'readWrite',
      options: [
        { value: 'readWrite', label: 'readWrite' },
        { value: 'read', label: 'read' },
        { value: 'dbOwner', label: 'dbOwner' },
      ],
    },
  ],
  plays: (v) => {
    const admin = { login_user: v.admin_user, login_password: '{{ vault_mongodb_admin_password }}', login_database: 'admin' };
    return [
      {
        name: `Initialise the ${v.replica_set} replica set`,
        hosts: v.hosts,
        become: true,
        tasks: [
          { name: 'Install the Python driver the modules use', 'ansible.builtin.package': { name: 'python3-pymongo', state: 'present' } },
          {
            name: 'Initiate the replica set',
            'community.mongodb.mongodb_replicaset': { replica_set: v.replica_set, members: items(v.members), login_host: 'localhost' },
            run_once: true,
          },
          {
            name: 'Wait for a primary',
            'community.mongodb.mongodb_status': { replica_set: v.replica_set, validate: 'minimal', poll: 10, interval: 10 },
            run_once: true,
          },
          {
            // Allowed without credentials only until the first user exists; the marker file makes reruns log in.
            name: `Create the ${v.admin_user} admin user`,
            'community.mongodb.mongodb_user': {
              database: 'admin',
              name: v.admin_user,
              password: '{{ vault_mongodb_admin_password }}',
              roles: ['root'],
              replica_set: v.replica_set,
              create_for_localhost_exception: '/root/.mongodb_admin_created',
              update_password: 'on_create',
              state: 'present',
              ...admin,
            },
            run_once: true,
            no_log: true,
          },
          {
            name: `Create the ${v.app_user} user in ${v.app_db}`,
            'community.mongodb.mongodb_user': {
              database: v.app_db,
              name: v.app_user,
              password: '{{ vault_mongodb_app_password }}',
              roles: [{ db: v.app_db, role: v.app_role }],
              replica_set: v.replica_set,
              update_password: 'on_create',
              state: 'present',
              ...admin,
            },
            run_once: true,
            no_log: true,
          },
        ],
      },
    ];
  },
  needs: (v) => ({
    vault_mongodb_admin_password: `Password for the ${v.admin_user} admin user`,
    vault_mongodb_app_password: `Password for ${v.app_user}`,
  }),
});

const sqlserver_db_login = playbookScenario({
  id: 'db_sqlserver_database_login',
  label: 'SQL Server database, login and user',
  group: 'Playbooks · SQL Server',
  description:
    'Create a database, a server login (SQL or Windows), map it to a database user and add it to database roles. Needs the dbatools PowerShell module on the target.',
  inputs: [
    hosts('sqlservers'),
    { id: 'sql_instance', label: 'SQL instance', control: 'text', default: 'localhost', hint: 'Server or server\\instance' },
    {
      id: 'connect_as',
      label: 'Connect as',
      control: 'select',
      default: 'windows',
      options: [
        { value: 'windows', label: 'The Ansible Windows account (integrated)' },
        { value: 'sql', label: 'SQL login with vaulted password' },
      ],
    },
    { id: 'admin_login', label: 'Admin SQL login', control: 'text', default: 'sa_ansible', hint: 'Password from vault_sqlserver_admin_password', showWhen: { input: 'connect_as', equals: ['sql'] } },
    { id: 'db_name', label: 'Database', control: 'text', default: 'AppDb' },
    {
      id: 'recovery_model',
      label: 'Recovery model',
      control: 'select',
      default: 'Full',
      options: [
        { value: 'Full', label: 'Full (log backups)' },
        { value: 'Simple', label: 'Simple' },
        { value: 'BulkLogged', label: 'Bulk-logged' },
      ],
    },
    {
      id: 'login_type',
      label: 'Login type',
      control: 'select',
      default: 'sql',
      options: [
        { value: 'sql', label: 'SQL authentication' },
        { value: 'windows', label: 'Windows account or group' },
      ],
    },
    { id: 'login', label: 'Login', control: 'text', default: 'app_user', hint: 'DOMAIN\\name for Windows; SQL password from vault_sqlserver_login_password' },
    { id: 'roles', label: 'Database roles', control: 'textarea', default: 'db_datareader\ndb_datawriter', hint: 'One per line' },
  ],
  plays: (v) => {
    const conn = { sql_instance: v.sql_instance, ...(v.connect_as === 'sql' ? { sql_username: v.admin_login, sql_password: '{{ vault_sqlserver_admin_password }}' } : {}) };
    const secret = v.connect_as === 'sql';
    const username = String(v.login).split('\\').pop() as string;
    const sqlLogin = v.login_type === 'sql';
    return [
      {
        name: `Provision ${v.db_name} on ${v.sql_instance}`,
        hosts: v.hosts,
        gather_facts: false,
        tasks: [
          {
            name: `Create ${v.db_name}`,
            'lowlydba.sqlserver.database': { database: v.db_name, recovery_model: v.recovery_model, state: 'present', ...conn },
            no_log: secret,
          },
          {
            name: `Create the ${v.login} login`,
            'lowlydba.sqlserver.login': {
              login: v.login,
              default_database: v.db_name,
              password: sqlLogin ? '{{ vault_sqlserver_login_password }}' : undefined,
              password_policy_enforced: sqlLogin ? true : undefined,
              skip_password_reset: sqlLogin ? true : undefined,
              enabled: true,
              state: 'present',
              ...conn,
            },
            no_log: secret || sqlLogin,
          },
          {
            name: `Map ${v.login} to a user in ${v.db_name}`,
            'lowlydba.sqlserver.user': { database: v.db_name, login: v.login, username, default_schema: 'dbo', state: 'present', ...conn },
            no_log: secret,
          },
          {
            name: 'Add the user to its database roles',
            'lowlydba.sqlserver.user_role': { database: v.db_name, username, roles: { add: items(v.roles) }, ...conn },
            no_log: secret,
          },
        ],
      },
    ];
  },
  needs: (v) => ({
    ...(v.login_type === 'sql' ? { vault_sqlserver_login_password: `Password for the ${v.login} SQL login` } : {}),
    ...(v.connect_as === 'sql' ? { vault_sqlserver_admin_password: `Password for the ${v.admin_login} admin login` } : {}),
  }),
});

/** Policy values as RabbitMQ wants them: integers as numbers, the rest as strings. */
function policyTags(value: unknown): Record<string, string | number> {
  return Object.fromEntries(pairs(value).map(([k, val]) => [k, /^\d+$/.test(val) ? Number(val) : val]));
}

const rabbitmq_vhost_user = playbookScenario({
  id: 'db_rabbitmq_vhost_user',
  label: 'RabbitMQ vhost, user, permissions and policy',
  group: 'Playbooks · RabbitMQ',
  description: 'Create a vhost and an application user with regex permissions on it, and apply a queue policy. Runs rabbitmqctl on the broker node.',
  inputs: [
    hosts('rabbitmq'),
    { id: 'management', label: 'Enable the management plugin', control: 'toggle', default: true },
    { id: 'vhost', label: 'Vhost', control: 'text', default: 'orders' },
    { id: 'user', label: 'User', control: 'text', default: 'orders_app', hint: 'Password from vault_rabbitmq_user_password' },
    {
      id: 'tags',
      label: 'User tags',
      control: 'select',
      default: 'none',
      options: [
        { value: 'none', label: 'None (AMQP only)' },
        { value: 'management', label: 'management' },
        { value: 'monitoring', label: 'monitoring' },
        { value: 'policymaker', label: 'policymaker' },
        { value: 'administrator', label: 'administrator' },
      ],
    },
    { id: 'configure_priv', label: 'Configure permission', control: 'text', default: '^orders\\..*', hint: 'Regex of resource names; ^$ for none' },
    { id: 'write_priv', label: 'Write permission', control: 'text', default: '^orders\\..*' },
    { id: 'read_priv', label: 'Read permission', control: 'text', default: '^orders\\..*' },
    { id: 'policy', label: 'Apply a policy', control: 'toggle', default: true },
    { id: 'policy_name', label: 'Policy name', control: 'text', default: 'orders-limits', showWhen: { input: 'policy', equals: ['true'] } },
    { id: 'policy_pattern', label: 'Applies to names matching', control: 'text', default: '^orders\\.', showWhen: { input: 'policy', equals: ['true'] } },
    {
      id: 'apply_to',
      label: 'Applies to',
      control: 'select',
      default: 'queues',
      options: [
        { value: 'queues', label: 'Queues' },
        { value: 'quorum_queues', label: 'Quorum queues' },
        { value: 'classic_queues', label: 'Classic queues' },
        { value: 'streams', label: 'Streams' },
        { value: 'exchanges', label: 'Exchanges' },
        { value: 'all', label: 'Queues and exchanges' },
      ],
      showWhen: { input: 'policy', equals: ['true'] },
    },
    {
      id: 'policy_definition',
      label: 'Policy definition',
      control: 'textarea',
      default: 'max-length=100000\noverflow=reject-publish\ndead-letter-exchange=orders.dlx',
      hint: 'One key=value per line; whole numbers are sent as numbers',
      showWhen: { input: 'policy', equals: ['true'] },
    },
  ],
  plays: (v) => [
    {
      name: `Configure the ${v.vhost} RabbitMQ vhost`,
      hosts: v.hosts,
      become: true,
      tasks: [
        ...(on(v.management)
          ? [{ name: 'Enable the management plugin', 'community.rabbitmq.rabbitmq_plugin': { names: 'rabbitmq_management', state: 'enabled' } }]
          : []),
        { name: `Create the ${v.vhost} vhost`, 'community.rabbitmq.rabbitmq_vhost': { name: v.vhost, state: 'present' } },
        {
          name: `Create ${v.user} with permissions on ${v.vhost}`,
          'community.rabbitmq.rabbitmq_user': {
            user: v.user,
            password: '{{ vault_rabbitmq_user_password }}',
            update_password: 'always',
            tags: v.tags === 'none' ? undefined : v.tags,
            permissions: [{ vhost: v.vhost, configure_priv: v.configure_priv, write_priv: v.write_priv, read_priv: v.read_priv }],
            state: 'present',
          },
          no_log: true,
        },
        ...(on(v.policy)
          ? [
              {
                name: `Apply the ${v.policy_name} policy`,
                'community.rabbitmq.rabbitmq_policy': {
                  name: v.policy_name,
                  vhost: v.vhost,
                  pattern: v.policy_pattern,
                  apply_to: v.apply_to,
                  tags: policyTags(v.policy_definition),
                  priority: '0',
                  state: 'present',
                },
              },
            ]
          : []),
      ],
    },
  ],
  needs: (v) => ({ vault_rabbitmq_user_password: `Password for the ${v.user} RabbitMQ user` }),
});

const CH_PRIVS: Record<string, readonly string[]> = {
  readonly: ['SELECT'],
  readwrite: ['SELECT', 'INSERT', 'ALTER UPDATE', 'ALTER DELETE'],
  owner: ['SELECT', 'INSERT', 'ALTER', 'CREATE TABLE', 'DROP TABLE', 'TRUNCATE'],
};

const clickhouse_db_user = playbookScenario({
  id: 'db_clickhouse_database_user',
  label: 'ClickHouse database, user and grants',
  group: 'Playbooks · ClickHouse',
  description: 'Create a ClickHouse database and a password-authenticated user limited to a network, with grants on that database.',
  inputs: [
    hosts('clickhouse'),
    { id: 'admin_user', label: 'Admin user', control: 'text', default: 'default', hint: 'Password from vault_clickhouse_admin_password' },
    { id: 'db_name', label: 'Database', control: 'text', default: 'analytics' },
    { id: 'user', label: 'User', control: 'text', default: 'analytics_app', hint: 'Password from vault_clickhouse_user_password' },
    { id: 'networks', label: 'Allowed networks', control: 'textarea', default: '10.0.0.0/8', hint: 'One CIDR per line; empty allows any host' },
    {
      id: 'privileges',
      label: 'Privileges on the database',
      control: 'select',
      default: 'readwrite',
      options: [
        { value: 'readwrite', label: 'Read/write (SELECT, INSERT, mutations)' },
        { value: 'readonly', label: 'Read only' },
        { value: 'owner', label: 'Owner (DDL too)' },
      ],
    },
  ],
  plays: (v) => {
    const login = { login_host: 'localhost', login_user: v.admin_user, login_password: '{{ vault_clickhouse_admin_password }}' };
    const networks = items(v.networks);
    return [
      {
        name: `Provision the ${v.db_name} ClickHouse database`,
        hosts: v.hosts,
        tasks: [
          {
            name: `Create ${v.db_name}`,
            'community.clickhouse.clickhouse_db': { name: v.db_name, state: 'present', ...login },
            no_log: true,
          },
          {
            name: `Create ${v.user}`,
            'community.clickhouse.clickhouse_user': {
              name: v.user,
              authentication: { type: 'sha256_password', password: '{{ vault_clickhouse_user_password }}' },
              user_hosts: networks.length > 0 ? [{ type: 'IP', hosts: networks }] : undefined,
              update_password: 'on_create',
              state: 'present',
              ...login,
            },
            no_log: true,
          },
          {
            name: `Grant ${v.user} its privileges on ${v.db_name}`,
            'community.clickhouse.clickhouse_grants': {
              grantee: v.user,
              privileges: [{ object: `${v.db_name}.*`, privs: Object.fromEntries((CH_PRIVS[v.privileges] ?? ['SELECT']).map((p) => [p, false])) }],
              exclusive: true,
              state: 'present',
              ...login,
            },
            no_log: true,
          },
        ],
      },
    ];
  },
  needs: (v) => ({
    vault_clickhouse_admin_password: `Password for the ${v.admin_user} ClickHouse user`,
    vault_clickhouse_user_password: `Password for ${v.user}`,
  }),
});

export const DATABASES_PLAYBOOKS: readonly Blueprint[] = [
  postgres_db_user,
  postgres_backup,
  mysql_db_user,
  mongodb_rs_user,
  sqlserver_db_login,
  rabbitmq_vhost_user,
  clickhouse_db_user,
];
