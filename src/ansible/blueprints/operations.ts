/**
 * Hand-written monitoring, security and secrets playbooks: Zabbix, Grafana,
 * Icinga Director, Splunk ES, HashiCorp Vault and CyberArk — the handful of
 * API calls an engineer strings together to onboard a host or wire up a
 * dashboard, rather than one module at a time.
 *
 * Everything talks to an API from localhost. Zabbix and Splunk ES go through
 * an httpapi connection, so their plays set the connection variables.
 */

import type { Blueprint } from '../../kit/blueprint.ts';
import { items, on, pairs, playbookScenario } from './scenario.ts';

const LOCAL = { hosts: 'localhost', connection: 'local', gather_facts: false } as const;

export const OPERATIONS_PLAYBOOKS: readonly Blueprint[] = [
  playbookScenario({
    id: 'ops_zabbix_host',
    label: 'Zabbix – host group and monitored host',
    description: 'Create host groups, then a host with linked templates, agent (and optional SNMP) interfaces, tags and macros.',
    group: 'Playbooks · Zabbix',
    inputs: [
      { id: 'zabbix_server', label: 'Zabbix server', control: 'text', default: 'zabbix.example.com' },
      { id: 'url_path', label: 'Frontend path', control: 'text', default: '', hint: "Empty for '/', else e.g. zabbix" },
      {
        id: 'auth',
        label: 'Authentication',
        control: 'select',
        options: [
          { value: 'token', label: 'API token' },
          { value: 'password', label: 'User and password' },
        ],
        default: 'token',
      },
      { id: 'api_user', label: 'API user', control: 'text', default: 'ansible', showWhen: { input: 'auth', equals: ['password'] } },
      { id: 'host_groups', label: 'Host groups', control: 'textarea', default: 'Linux servers\nExample/Web', hint: 'One per line; created if missing' },
      { id: 'host_name', label: 'Host name', control: 'text', default: 'web01.example.com' },
      { id: 'visible_name', label: 'Visible name', control: 'text', default: 'web01' },
      { id: 'ip', label: 'IP address', control: 'text', default: '192.0.2.10' },
      { id: 'templates', label: 'Templates', control: 'textarea', default: 'Linux by Zabbix agent', hint: 'One per line' },
      {
        id: 'monitored_by',
        label: 'Monitored by',
        control: 'select',
        options: [
          { value: 'zabbix_server', label: 'Zabbix server' },
          { value: 'proxy', label: 'Proxy' },
        ],
        default: 'zabbix_server',
      },
      { id: 'proxy', label: 'Proxy', control: 'text', default: 'proxy01.example.com', showWhen: { input: 'monitored_by', equals: ['proxy'] } },
      { id: 'snmp', label: 'Add SNMPv2 interface', control: 'toggle', default: false },
      { id: 'tags', label: 'Tags', control: 'textarea', default: 'env=prod\nservice=web', hint: 'name=value, one per line' },
      { id: 'macros', label: 'Macros', control: 'textarea', default: '{$CPU.UTIL.CRIT}=90', hint: 'MACRO=value, one per line' },
    ],
    needs: (v) =>
      v.auth === 'password'
        ? { vault_zabbix_password: 'Zabbix API user password' }
        : { vault_zabbix_api_token: 'Zabbix API token (Users → API tokens)' },
    plays: (v) => {
      const token = v.auth !== 'password';
      const snmp = on(v.snmp);
      const interfaces = [
        { type: 'agent', main: 1, useip: 1, ip: v.ip, dns: '', port: '10050' },
        ...(snmp ? [{ type: 'snmp', main: 1, useip: 1, ip: v.ip, dns: '', port: '161', details: { version: 2, bulk: 1, community: '{$SNMP_COMMUNITY}' } }] : []),
      ];
      const proxy = v.monitored_by === 'proxy';
      return [
        {
          name: 'Register a host in Zabbix',
          hosts: 'localhost',
          gather_facts: false,
          vars: {
            ansible_connection: 'httpapi',
            ansible_network_os: 'community.zabbix.zabbix',
            ansible_host: v.zabbix_server,
            ansible_httpapi_port: 443,
            ansible_httpapi_use_ssl: true,
            ansible_httpapi_validate_certs: true,
            ansible_zabbix_url_path: String(v.url_path ?? ''),
            ...(token
              ? { ansible_zabbix_auth_key: '{{ vault_zabbix_api_token }}' }
              : { ansible_user: v.api_user, ansible_httpapi_pass: '{{ vault_zabbix_password }}' }),
          },
          tasks: [
            { name: 'Create the host groups', 'community.zabbix.zabbix_group': { host_groups: items(v.host_groups), state: 'present' } },
            {
              name: 'Create the host',
              'community.zabbix.zabbix_host': {
                host_name: v.host_name,
                visible_name: v.visible_name,
                host_groups: items(v.host_groups),
                link_templates: items(v.templates),
                status: 'enabled',
                monitored_by: v.monitored_by,
                ...(proxy ? { proxy: v.proxy } : {}),
                interfaces,
                tags: pairs(v.tags).map(([tag, value]) => ({ tag, value })),
                macros: pairs(v.macros).map(([macro, value]) => ({ macro, value })),
                inventory_mode: 'automatic',
                state: 'present',
              },
            },
          ],
        },
      ];
    },
  }),

  playbookScenario({
    id: 'ops_grafana_dashboard',
    label: 'Grafana – datasource, folder and dashboard',
    description: 'Add a Prometheus, Loki or InfluxDB datasource, a folder, and import a dashboard JSON that ships with the playbook.',
    group: 'Playbooks · Grafana',
    inputs: [
      { id: 'grafana_url', label: 'Grafana URL', control: 'text', default: 'https://grafana.example.com' },
      {
        id: 'auth',
        label: 'Authentication',
        control: 'select',
        options: [
          { value: 'token', label: 'Service account token' },
          { value: 'password', label: 'User and password' },
        ],
        default: 'token',
      },
      { id: 'username', label: 'User', control: 'text', default: 'admin', showWhen: { input: 'auth', equals: ['password'] } },
      { id: 'org_id', label: 'Organization ID', control: 'number', default: 1, min: 1 },
      {
        id: 'ds_type',
        label: 'Datasource type',
        control: 'select',
        options: [
          { value: 'prometheus', label: 'Prometheus' },
          { value: 'loki', label: 'Loki' },
          { value: 'influxdb', label: 'InfluxDB' },
        ],
        default: 'prometheus',
      },
      { id: 'ds_name', label: 'Datasource name', control: 'text', default: 'Prometheus' },
      { id: 'ds_uid', label: 'Datasource UID', control: 'text', default: 'prometheus-main', hint: 'The dashboard refers to this' },
      { id: 'ds_url', label: 'Datasource URL', control: 'text', default: 'http://prometheus.example.com:9090' },
      { id: 'database', label: 'Database', control: 'text', default: 'telegraf', showWhen: { input: 'ds_type', equals: ['influxdb'] } },
      { id: 'is_default', label: 'Default datasource', control: 'toggle', default: true },
      { id: 'folder', label: 'Folder', control: 'text', default: 'Platform' },
      { id: 'folder_uid', label: 'Folder UID', control: 'text', default: 'platform' },
      { id: 'dashboard_title', label: 'Dashboard title', control: 'text', default: 'Service overview' },
      { id: 'dashboard_uid', label: 'Dashboard UID', control: 'text', default: 'service-overview' },
      { id: 'overwrite', label: 'Overwrite if changed', control: 'toggle', default: true },
    ],
    needs: (v) =>
      v.auth === 'password' ? { vault_grafana_password: 'Grafana admin password' } : { vault_grafana_token: 'Grafana service account token' },
    extraFiles: (v) => {
      const query = v.ds_type === 'loki' ? 'sum(rate({job="app"}[5m]))' : v.ds_type === 'influxdb' ? 'SELECT mean("usage_idle") FROM "cpu" WHERE $timeFilter GROUP BY time($__interval)' : 'sum(rate(http_requests_total[5m])) by (job)';
      const dashboard = {
        uid: v.dashboard_uid,
        title: v.dashboard_title,
        schemaVersion: 39,
        time: { from: 'now-6h', to: 'now' },
        refresh: '1m',
        tags: ['ansible'],
        panels: [
          {
            id: 1,
            type: 'timeseries',
            title: 'Request rate',
            gridPos: { h: 8, w: 24, x: 0, y: 0 },
            datasource: { type: v.ds_type, uid: v.ds_uid },
            targets: [{ refId: 'A', datasource: { type: v.ds_type, uid: v.ds_uid }, expr: query, query }],
          },
        ],
      };
      return { [`files/dashboards/${v.dashboard_uid}.json`]: `${JSON.stringify(dashboard, null, 2)}\n` };
    },
    plays: (v) => {
      const auth =
        v.auth === 'password'
          ? { url: v.grafana_url, url_username: v.username, url_password: '{{ vault_grafana_password }}' }
          : { url: v.grafana_url, grafana_api_key: '{{ vault_grafana_token }}' };
      const org = Number(v.org_id);
      return [
        {
          name: 'Wire up a Grafana datasource and dashboard',
          ...LOCAL,
          tasks: [
            {
              name: 'Create the datasource',
              'community.grafana.grafana_datasource': {
                ...auth,
                org_id: org,
                name: v.ds_name,
                uid: v.ds_uid,
                ds_type: v.ds_type,
                ds_url: v.ds_url,
                access: 'proxy',
                is_default: on(v.is_default),
                ...(v.ds_type === 'influxdb' ? { database: v.database } : {}),
                state: 'present',
              },
              no_log: true,
            },
            {
              name: 'Create the folder',
              'community.grafana.grafana_folder': { ...auth, org_id: org, name: v.folder, uid: v.folder_uid, state: 'present' },
              no_log: true,
            },
            {
              name: 'Import the dashboard',
              'community.grafana.grafana_dashboard': {
                ...auth,
                org_id: org,
                folder: v.folder_uid,
                path: `{{ playbook_dir }}/files/dashboards/${v.dashboard_uid}.json`,
                overwrite: on(v.overwrite),
                commit_message: 'Updated by Ansible',
                state: 'present',
              },
              no_log: true,
            },
          ],
        },
      ];
    },
  }),

  playbookScenario({
    id: 'ops_hashi_vault_kv',
    label: 'HashiCorp Vault – read and write KV secrets',
    description:
      'Read a KV v2 secret and render it into an application env file on the target hosts; optionally generate and write a new secret first.',
    group: 'Playbooks · HashiCorp Vault',
    inputs: [
      { id: 'vault_url', label: 'Vault URL', control: 'text', default: 'https://vault.example.com:8200' },
      { id: 'namespace', label: 'Namespace', control: 'text', default: '', hint: 'Vault Enterprise / HCP only' },
      {
        id: 'auth_method',
        label: 'Authentication',
        control: 'select',
        options: [
          { value: 'approle', label: 'AppRole' },
          { value: 'token', label: 'Token' },
          { value: 'userpass', label: 'Username and password' },
        ],
        default: 'approle',
      },
      { id: 'role_id', label: 'Role ID', control: 'text', default: 'app-deployer', showWhen: { input: 'auth_method', equals: ['approle'] } },
      { id: 'username', label: 'Username', control: 'text', default: 'ansible', showWhen: { input: 'auth_method', equals: ['userpass'] } },
      { id: 'mount', label: 'KV mount', control: 'text', default: 'secret' },
      { id: 'path', label: 'Secret path', control: 'text', default: 'apps/web/database' },
      { id: 'write_new', label: 'Generate and write a new password first', control: 'toggle', default: false },
      { id: 'db_user', label: 'Database user', control: 'text', default: 'webapp', showWhen: { input: 'write_new', equals: ['true'] } },
      { id: 'target_hosts', label: 'Target hosts', control: 'text', default: 'webservers', hint: 'Inventory group' },
      { id: 'env_file', label: 'Env file', control: 'text', default: '/etc/webapp/database.env' },
      { id: 'owner', label: 'File owner', control: 'text', default: 'webapp' },
      { id: 'service', label: 'Restart service', control: 'text', default: 'webapp', hint: 'Empty for none' },
    ],
    needs: (v) =>
      v.auth_method === 'token'
        ? { vault_hashi_token: 'HashiCorp Vault token' }
        : v.auth_method === 'userpass'
          ? { vault_hashi_password: 'HashiCorp Vault userpass password' }
          : { vault_hashi_secret_id: 'HashiCorp Vault AppRole secret ID' },
    plays: (v) => {
      const ns = String(v.namespace ?? '').trim();
      const auth = {
        url: v.vault_url,
        ...(ns ? { namespace: ns } : {}),
        auth_method: v.auth_method,
        ...(v.auth_method === 'token'
          ? { token: '{{ vault_hashi_token }}' }
          : v.auth_method === 'userpass'
            ? { username: v.username, password: '{{ vault_hashi_password }}' }
            : { role_id: v.role_id, secret_id: '{{ vault_hashi_secret_id }}' }),
      };
      const service = String(v.service ?? '').trim();
      return [
        {
          name: 'Read (and optionally rotate) the secret',
          ...LOCAL,
          tasks: [
            ...(on(v.write_new)
              ? [
                  {
                    name: 'Write a newly generated password',
                    'community.hashi_vault.vault_kv2_write': {
                      ...auth,
                      engine_mount_point: v.mount,
                      path: v.path,
                      data: {
                        username: v.db_user,
                        password: "{{ lookup('ansible.builtin.password', '/dev/null', length=32, chars=['ascii_letters', 'digits']) }}",
                      },
                    },
                    no_log: true,
                  },
                ]
              : []),
            {
              name: 'Read the secret',
              'community.hashi_vault.vault_kv2_get': { ...auth, engine_mount_point: v.mount, path: v.path },
              register: 'app_secret',
              no_log: true,
            },
          ],
        },
        {
          name: 'Hand the secret to the application',
          hosts: v.target_hosts,
          become: true,
          vars: { secret_data: "{{ hostvars['localhost'].app_secret.secret }}" },
          tasks: [
            {
              name: 'Write the env file',
              'ansible.builtin.copy': {
                dest: v.env_file,
                owner: v.owner,
                group: v.owner,
                mode: '0600',
                content: "{% for k, val in secret_data.items() %}{{ k | upper }}={{ val }}\n{% endfor %}",
              },
              no_log: true,
              ...(service ? { notify: 'Restart the service' } : {}),
            },
          ],
          ...(service
            ? { handlers: [{ name: 'Restart the service', 'ansible.builtin.service': { name: service, state: 'restarted' } }] }
            : {}),
        },
      ];
    },
  }),

  playbookScenario({
    id: 'ops_icinga_director_host',
    label: 'Icinga Director – host, services and deploy',
    description: 'A host group, a host from a template, a service on it and a service apply rule for the group, then deploy the config.',
    group: 'Playbooks · Icinga Director',
    inputs: [
      { id: 'director_url', label: 'Director URL', control: 'text', default: 'https://icinga.example.com/icingaweb2/director' },
      { id: 'username', label: 'User', control: 'text', default: 'director-api', hint: 'Password in vault_icinga_password' },
      { id: 'hostgroup', label: 'Host group', control: 'text', default: 'linux-web' },
      { id: 'host_name', label: 'Host', control: 'text', default: 'web01.example.com' },
      { id: 'address', label: 'Address', control: 'text', default: '192.0.2.10' },
      { id: 'host_template', label: 'Host template', control: 'text', default: 'generic-linux-host' },
      { id: 'zone', label: 'Zone', control: 'text', default: 'master' },
      { id: 'has_agent', label: 'Icinga agent installed', control: 'toggle', default: true },
      { id: 'host_vars', label: 'Host vars', control: 'textarea', default: 'os=Linux\nrole=web', hint: 'name=value, one per line' },
      { id: 'service_name', label: 'Service on the host', control: 'text', default: 'https' },
      { id: 'service_template', label: 'Service template', control: 'text', default: 'generic-service' },
      { id: 'check_command', label: 'Check command', control: 'text', default: 'http' },
      { id: 'apply_name', label: 'Apply rule name', control: 'text', default: 'disk' },
      { id: 'apply_command', label: 'Apply rule check command', control: 'text', default: 'disk' },
      { id: 'deploy', label: 'Deploy after changes', control: 'toggle', default: true },
    ],
    needs: () => ({ vault_icinga_password: 'Icinga Director API user password' }),
    plays: (v) => {
      const api = { url: v.director_url, url_username: v.username, url_password: '{{ vault_icinga_password }}', force_basic_auth: true };
      const agent = on(v.has_agent);
      return [
        {
          name: 'Configure a host in Icinga Director',
          ...LOCAL,
          tasks: [
            {
              name: 'Create the host group',
              'telekom_mms.icinga_director.icinga_hostgroup': { ...api, object_name: v.hostgroup, display_name: v.hostgroup, state: 'present' },
              no_log: true,
            },
            {
              name: 'Create the host',
              'telekom_mms.icinga_director.icinga_host': {
                ...api,
                object_name: v.host_name,
                display_name: v.host_name,
                address: v.address,
                imports: [v.host_template],
                groups: [v.hostgroup],
                zone: v.zone,
                has_agent: agent,
                ...(agent ? { master_should_connect: true, accept_config: true } : {}),
                vars: Object.fromEntries(pairs(v.host_vars)),
                state: 'present',
              },
              no_log: true,
            },
            {
              name: 'Add a service to the host',
              'telekom_mms.icinga_director.icinga_service': {
                ...api,
                object_name: v.service_name,
                host: v.host_name,
                imports: [v.service_template],
                check_command: v.check_command,
                state: 'present',
              },
              no_log: true,
            },
            {
              name: 'Apply a service to the whole host group',
              'telekom_mms.icinga_director.icinga_service_apply': {
                ...api,
                object_name: v.apply_name,
                imports: [v.service_template],
                check_command: v.apply_command,
                assign_filter: `host.groups="${v.hostgroup}"`,
                state: 'present',
              },
              no_log: true,
            },
            ...(on(v.deploy)
              ? [{ name: 'Deploy the configuration', 'telekom_mms.icinga_director.icinga_deploy': { url: api.url, url_username: api.url_username, url_password: api.url_password }, no_log: true }]
              : []),
          ],
        },
      ];
    },
  }),

  playbookScenario({
    id: 'ops_splunk_es_detection',
    label: 'Splunk ES – correlation search and monitored input',
    description: 'A scheduled correlation search that raises notables, and a file monitor input feeding the index it searches.',
    group: 'Playbooks · Splunk ES',
    inputs: [
      { id: 'splunk_host', label: 'Splunk search head', control: 'text', default: 'splunk-es.example.com' },
      { id: 'api_port', label: 'Management port', control: 'number', default: 8089 },
      { id: 'api_user', label: 'API user', control: 'text', default: 'ansible', hint: 'Password in vault_splunk_password' },
      { id: 'search_name', label: 'Correlation search', control: 'text', default: 'Excessive failed SSH logins' },
      {
        id: 'search',
        label: 'SPL search',
        control: 'textarea',
        default: 'index=linux_secure sourcetype=linux_secure "Failed password" | stats count by src, host | where count > 20',
      },
      { id: 'cron', label: 'Schedule (cron)', control: 'text', default: '*/15 * * * *' },
      { id: 'earliest', label: 'Earliest time', control: 'text', default: '-15m' },
      { id: 'mitre', label: 'MITRE ATT&CK IDs', control: 'textarea', default: 'T1110', hint: 'One per line' },
      { id: 'throttle', label: 'Throttle by fields', control: 'textarea', default: 'src', hint: 'One per line; empty for none' },
      { id: 'monitor', label: 'Add a file monitor input', control: 'toggle', default: true },
      { id: 'monitor_path', label: 'Monitored path', control: 'text', default: '/var/log/secure', showWhen: { input: 'monitor', equals: ['true'] } },
      { id: 'index', label: 'Index', control: 'text', default: 'linux_secure', showWhen: { input: 'monitor', equals: ['true'] } },
      { id: 'sourcetype', label: 'Sourcetype', control: 'text', default: 'linux_secure', showWhen: { input: 'monitor', equals: ['true'] } },
    ],
    needs: () => ({ vault_splunk_password: 'Splunk API user password' }),
    plays: (v) => {
      const throttle = items(v.throttle);
      return [
        {
          name: 'Configure Splunk Enterprise Security detections',
          hosts: 'localhost',
          gather_facts: false,
          vars: {
            ansible_connection: 'httpapi',
            ansible_network_os: 'splunk.es.splunk',
            ansible_host: v.splunk_host,
            ansible_httpapi_port: Number(v.api_port),
            ansible_httpapi_use_ssl: true,
            ansible_httpapi_validate_certs: true,
            ansible_user: v.api_user,
            ansible_httpapi_pass: '{{ vault_splunk_password }}',
          },
          tasks: [
            ...(on(v.monitor)
              ? [
                  {
                    name: 'Monitor the log file',
                    'splunk.es.splunk_data_inputs_monitor': {
                      config: [{ name: v.monitor_path, index: v.index, sourcetype: v.sourcetype, check_path: true, disabled: false }],
                      state: 'merged',
                    },
                  },
                ]
              : []),
            {
              name: 'Create the correlation search',
              'splunk.es.splunk_correlation_searches': {
                config: [
                  {
                    name: v.search_name,
                    description: `${v.search_name} (managed by Ansible)`,
                    search: String(v.search).replace(/\s*\n\s*/g, ' '),
                    app: 'SplunkEnterpriseSecuritySuite',
                    cron_schedule: v.cron,
                    scheduling: 'continuous',
                    time_earliest: v.earliest,
                    time_latest: 'now',
                    trigger_alert: 'once',
                    trigger_alert_when: 'number of results',
                    trigger_alert_when_condition: 'greater than',
                    trigger_alert_when_value: '0',
                    ...(throttle.length > 0 ? { throttle_fields_to_group_by: throttle, throttle_window_duration: '3600' } : {}),
                    annotations: { mitre_attack: items(v.mitre) },
                    disabled: false,
                  },
                ],
                state: 'merged',
              },
            },
          ],
        },
      ];
    },
  }),

  playbookScenario({
    id: 'ops_cyberark_credential',
    label: 'CyberArk – fetch a credential and use it',
    description: 'Retrieve a password from the Central Credential Provider and use it for an API call, never printing it.',
    group: 'Playbooks · CyberArk',
    inputs: [
      { id: 'ccp_url', label: 'CCP base URL', control: 'text', default: 'https://ccp.example.com' },
      { id: 'app_id', label: 'Application ID', control: 'text', default: 'Ansible' },
      { id: 'safe', label: 'Safe', control: 'text', default: 'Linux-Service-Accounts' },
      { id: 'object', label: 'Account object', control: 'text', default: 'Operating System-UnixSSH-app01-svc_deploy' },
      { id: 'reason', label: 'Reason', control: 'text', default: 'Scheduled deployment' },
      { id: 'client_cert', label: 'Client certificate', control: 'text', default: '/etc/pki/ansible/ccp-client.pem', hint: 'On the control node; empty for none' },
      { id: 'client_key', label: 'Client key', control: 'text', default: '/etc/pki/ansible/ccp-client.key' },
      { id: 'target_url', label: 'Use it against URL', control: 'text', default: 'https://app01.example.com/api/health' },
    ],
    plays: (v) => {
      const cert = String(v.client_cert ?? '').trim();
      return [
        {
          name: 'Fetch a credential from CyberArk',
          ...LOCAL,
          tasks: [
            {
              name: 'Retrieve the credential',
              'cyberark.pas.cyberark_credential': {
                api_base_url: v.ccp_url,
                app_id: v.app_id,
                query: `Safe=${v.safe};Object=${v.object}`,
                reason: v.reason,
                validate_certs: true,
                ...(cert ? { client_cert: cert, client_key: v.client_key } : {}),
              },
              register: 'ccp',
              no_log: true,
            },
            {
              name: 'Call the application with it',
              'ansible.builtin.uri': {
                url: v.target_url,
                user: '{{ ccp.result.UserName }}',
                password: '{{ ccp.result.Content }}',
                force_basic_auth: true,
                status_code: 200,
              },
              no_log: true,
            },
          ],
        },
      ];
    },
  }),
];
