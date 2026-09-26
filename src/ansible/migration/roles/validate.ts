/**
 * validate: after a wave, check each host does what its roles say, and write
 * what was found to reports/validation-<host>.json at the top of the project
 * on the control node (beside the inventory folder).
 *
 * Per host, from its inventory groups (role_*, db_*):
 *   - the role's ports answer on the host's IPv4 and IPv6 addresses;
 *   - the role's services are running;
 *   - the database answers (SQL Server instance_info, postgresql_ping,
 *     mysql_info, and `select status from v$instance` for Oracle);
 *   - the domain resolves, when there is one;
 *   - the clock is within 5 seconds of the control node's.
 * Every check runs and is reported before the last task fails the host if
 * any did not pass.
 */

import type { Role, Task } from './types.ts';

const LINUX = "ansible_facts.os_family != 'Windows'";
const WINDOWS = "ansible_facts.os_family == 'Windows'";

const tasks: Task[] = [
  {
    name: "Check the host's ports (Linux, IPv4 and IPv6)",
    'ansible.builtin.wait_for': { host: '{{ item.0 }}', port: '{{ item.1 }}', timeout: 10, state: 'started' },
    loop: '{{ validate_addresses | product(validate_ports) | list }}',
    register: 'validate_ports_linux',
    ignore_errors: true,
    check_mode: false,
    when: LINUX,
  },
  {
    name: "Check the host's ports (Windows, IPv4 and IPv6)",
    'ansible.windows.win_wait_for': { host: '{{ item.0 }}', port: '{{ item.1 }}', timeout: 10, state: 'started' },
    loop: '{{ validate_addresses | product(validate_ports) | list }}',
    register: 'validate_ports_windows',
    ignore_errors: true,
    check_mode: false,
    when: WINDOWS,
  },
  {
    name: 'Record the port checks',
    'ansible.builtin.set_fact': {
      validate_port_results:
        "{{ validate_port_results | default({}) | combine({(item.item[0] ~ ' port ' ~ item.item[1] | string): not (item.failed | default(false))}) }}",
    },
    loop: "{{ (validate_ports_linux if ansible_facts.os_family != 'Windows' else validate_ports_windows).results | default([]) }}",
    loop_control: { label: "{{ item.item | default('') }}" },
  },
  { name: 'Read the services (Linux)', 'ansible.builtin.service_facts': {}, when: LINUX },
  {
    name: "Check the host's services (Linux)",
    'ansible.builtin.set_fact': {
      validate_service_results:
        "{{ validate_service_results | default({}) | combine({item.key: (ansible_facts.services | dict2items | selectattr('key', 'match', item.value) | selectattr('value.state', 'equalto', 'running') | list | length > 0)}) }}",
    },
    loop: '{{ validate_linux_expected | dict2items }}',
    when: LINUX,
  },
  { name: 'Read the services (Windows)', 'ansible.windows.win_service_info': {}, register: 'validate_windows_services', when: WINDOWS },
  {
    name: "Check the host's services (Windows)",
    'ansible.builtin.set_fact': {
      validate_service_results:
        "{{ validate_service_results | default({}) | combine({item.key: (validate_windows_services.services | selectattr('name', 'match', item.value) | selectattr('state', 'equalto', 'started') | list | length > 0)}) }}",
    },
    loop: '{{ validate_windows_expected | dict2items }}',
    when: WINDOWS,
  },
  {
    name: 'Ask SQL Server for its instance details',
    'lowlydba.sqlserver.instance_info': { sql_instance: "{{ 'localhost' if validate_mssql_instance == 'MSSQLSERVER' else 'localhost\\\\' ~ validate_mssql_instance }}" },
    register: 'validate_mssql',
    ignore_errors: true,
    when: [WINDOWS, "'db_sqlserver' in group_names"],
  },
  {
    name: 'Ping PostgreSQL',
    'community.postgresql.postgresql_ping': { login_port: '{{ validate_postgres_port }}' },
    register: 'validate_postgres',
    ignore_errors: true,
    become: true,
    become_user: 'postgres',
    when: [LINUX, "'db_postgres' in group_names"],
  },
  {
    name: 'Ask MySQL for its version',
    'ansible.mysql.mysql_info': { login_user: 'root', login_password: '{{ vault_mysql_root_password }}', login_unix_socket: '{{ validate_mysql_socket | default(omit, true) }}', filter: ['version'] },
    register: 'validate_mysql',
    ignore_errors: true,
    no_log: true,
    when: [LINUX, "'db_mysql' in group_names"],
  },
  {
    name: 'Find the Oracle database in oratab',
    'ansible.builtin.command': { argv: ['grep', '-m1', '-E', '^[A-Za-z0-9_]+:[^:]+:Y', '/etc/oratab'] },
    register: 'validate_oratab',
    changed_when: false,
    check_mode: false,
    ignore_errors: true,
    when: [LINUX, "'db_oracle' in group_names"],
  },
  {
    name: 'Ask Oracle for the instance status',
    'ansible.builtin.command': {
      argv: ["{{ validate_oratab.stdout.split(':')[1] }}/bin/sqlplus", '-S', '-L', '/', 'as', 'sysdba'],
      stdin: 'set heading off feedback off pagesize 0\nselect status from v$instance;\nexit;',
    },
    environment: { ORACLE_SID: "{{ validate_oratab.stdout.split(':')[0] }}", ORACLE_HOME: "{{ validate_oratab.stdout.split(':')[1] }}" },
    register: 'validate_oracle',
    changed_when: false,
    check_mode: false,
    ignore_errors: true,
    become: true,
    become_user: 'oracle',
    when: [LINUX, "'db_oracle' in group_names", 'validate_oratab.rc | default(1) == 0', "validate_oratab.stdout | default('') | length > 0"],
  },
  {
    name: 'Resolve the domain (Linux)',
    'ansible.builtin.command': { argv: ['getent', 'hosts', '{{ validate_domain }}'] },
    register: 'validate_dns_linux',
    changed_when: false,
    check_mode: false,
    ignore_errors: true,
    when: [LINUX, 'validate_domain | length > 0'],
  },
  {
    name: 'Resolve the domain (Windows)',
    'ansible.windows.win_powershell': { script: 'param([string]$Name)\n$Ansible.Changed = $false\nResolve-DnsName -Name $Name -ErrorAction Stop | Out-Null', parameters: { Name: '{{ validate_domain }}' } },
    register: 'validate_dns_windows',
    check_mode: false,
    ignore_errors: true,
    when: [WINDOWS, 'validate_domain | length > 0'],
  },
  // The host's clock is read between two readings of the control node's, so
  // the time the tasks take is not counted as skew.
  { name: "Note the control node's time", 'ansible.builtin.set_fact': { validate_clock_before: '{{ now().timestamp() | int }}' } },
  { name: "Read the host's clock", 'ansible.builtin.setup': { filter: ['ansible_date_time'] } },
  {
    name: 'Measure the clock against the control node',
    'ansible.builtin.set_fact': {
      validate_time_skew:
        '{{ [0, (validate_clock_before | int) - (ansible_facts.date_time.epoch | int), (ansible_facts.date_time.epoch | int) - (now().timestamp() | int)] | max }}',
    },
  },
  {
    name: 'Record the database checks',
    'ansible.builtin.set_fact': {
      validate_database_results:
        "{{ {} | combine({'sqlserver': validate_mssql is succeeded} if (validate_mssql is defined and validate_mssql is not skipped) else {}) | combine({'postgres': validate_postgres.is_available | default(false)} if (validate_postgres is defined and validate_postgres is not skipped) else {}) | combine({'mysql': validate_mysql is succeeded} if (validate_mysql is defined and validate_mysql is not skipped) else {}) | combine({'oracle': 'OPEN' in (validate_oracle.stdout | default(''))} if 'db_oracle' in group_names and ansible_facts.os_family != 'Windows' else {}) }}",
    },
  },
  {
    name: 'Put the results together',
    'ansible.builtin.set_fact': {
      validate_report: {
        host: '{{ inventory_hostname }}',
        groups: '{{ group_names }}',
        ports: '{{ validate_port_results | default({}) }}',
        services: '{{ validate_service_results | default({}) }}',
        databases: '{{ validate_database_results }}',
        dns: "{{ none if validate_domain | length == 0 else ((validate_dns_windows is succeeded) if ansible_facts.os_family == 'Windows' else (validate_dns_linux is succeeded)) }}",
        time_skew_seconds: '{{ validate_time_skew | int }}',
      },
    },
  },
  {
    name: 'Decide whether the host passed',
    'ansible.builtin.set_fact': {
      validate_passed:
        "{{ (validate_report.ports.values() | reject | list | length == 0) and (validate_report.services.values() | reject | list | length == 0) and (validate_report.databases.values() | reject | list | length == 0) and (validate_report.dns is none or validate_report.dns) and (validate_report.time_skew_seconds | int < 5) }}",
    },
  },
  {
    name: 'Create the reports directory on the control node',
    'ansible.builtin.file': { path: '{{ validate_report_path }}', state: 'directory', mode: '0755' },
    delegate_to: 'localhost',
    become: false,
    // The report is written in a --check run too: it only touches the control node.
    check_mode: false,
    run_once: true,
  },
  {
    name: 'Write the report',
    'ansible.builtin.copy': {
      content: "{{ validate_report | combine({'passed': validate_passed | bool}) | to_nice_json }}\n",
      dest: '{{ validate_report_path }}/validation-{{ inventory_hostname }}.json',
      mode: '0644',
    },
    delegate_to: 'localhost',
    become: false,
    // The report is written in a --check run too: it only touches the control node.
    check_mode: false,
  },
  {
    name: 'Fail the host when a check did not pass',
    'ansible.builtin.assert': {
      that: ['validate_passed | bool'],
      fail_msg: 'Validation failed on {{ inventory_hostname }}; see {{ validate_report_path }}/validation-{{ inventory_hostname }}.json.',
      success_msg: '{{ inventory_hostname }} passed.',
    },
  },
];

export const VALIDATE: Role = {
  name: 'validate',
  description: 'ports, services, database, DNS and clock checks per host, written to reports/ on the control node.',
  tasks,
  defaults: {
    validate_domain: '',
    validate_extra_ports: [],
    validate_report_dir: '',
    validate_mssql_instance: 'MSSQLSERVER',
    validate_postgres_port: 5432,
    validate_mysql_socket: '',
  },
  derived: {
    // reports/ at the top of the project: beside the inventory folder, whichever folder the playbook is in.
    validate_report_path:
      "{{ validate_report_dir if validate_report_dir | length > 0 else ((((inventory_dir ~ '/..') if (inventory_dir | default('', true)) | length > 0 else playbook_dir)) ~ '/reports') }}",
    validate_role_ports: {
      db_oracle: [1521],
      db_sqlserver: [1433],
      db_postgres: [5432],
      db_mysql: [3306],
      role_web: [80],
      role_ad_dc: [53, 88, 389, 445, 636],
    },
    validate_ports:
      "{{ (([5986] if ansible_facts.os_family == 'Windows' else [22]) + (validate_role_ports | dict2items | selectattr('key', 'in', group_names) | map(attribute='value') | flatten) + validate_extra_ports) | unique }}",
    validate_addresses:
      "{{ ([ansible_facts.default_ipv4.address | default(''), ansible_facts.default_ipv6.address | default('')] if ansible_facts.os_family != 'Windows' else [ansible_facts.ip_addresses | default([]) | select('match', '^[0-9.]+$') | first | default(''), ansible_facts.ip_addresses | default([]) | reject('match', '^[0-9.]+$') | reject('match', '^fe80') | first | default('')]) | select | list }}",
    validate_linux_services: {
      ssh: '^sshd?\\.service$',
      time: '^chronyd?\\.service$',
    },
    validate_linux_by_group: {
      db_oracle: '^oracle-database\\.service$',
      db_sqlserver: '^mssql-server\\.service$',
      db_postgres: '^postgresql',
      db_mysql: '^(mysqld|mysql|mariadb)\\.service$',
      role_web: '^(nginx|httpd|apache2)\\.service$',
    },
    validate_windows_services: { winrm: '^WinRM$' },
    validate_windows_by_group: {
      db_sqlserver: '^MSSQL(SERVER|\\$)',
      role_web: '^W3SVC$',
      role_ad_dc: '^NTDS$',
    },
    validate_linux_expected:
      "{{ validate_linux_services | combine(validate_linux_by_group | dict2items | selectattr('key', 'in', group_names) | items2dict) }}",
    validate_windows_expected:
      "{{ validate_windows_services | combine(validate_windows_by_group | dict2items | selectattr('key', 'in', group_names) | items2dict) }}",
  },
};
