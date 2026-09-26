/**
 * mig_monitoring: monitoring agents on migrated hosts.
 *
 * On a hyperscaler the agent is Terraform's (SSM association, Azure Monitor
 * Agent extension, Ops Agent policy, OCI agent plugin), so this only checks
 * it is running and says so when it is not yet.
 *
 * On VCF the VCF Operations in-guest agent is pushed from VCF Operations
 * through its cloud proxy, not by Ansible: this checks what that needs (VMware
 * Tools / open-vm-tools, and the cloud proxy reachable on 443) and says what
 * to do in VCF Operations.
 *
 * With siem = splunk it installs the Splunk Universal Forwarder from the
 * user's own package repository, sends to the indexers, and enrols with the
 * deployment server, which serves the apps built on the Splunk page.
 */

import { info } from '../../../core/findings.ts';
import type { Task } from '../../migration/roles/index.ts';
import { list, migrationBlueprint, PLATFORM_INPUT, text } from './common.ts';

const LINUX = "ansible_facts.os_family != 'Windows'";
const WINDOWS = "ansible_facts.os_family == 'Windows'";
const SPLUNK = "monitoring_siem == 'splunk'";
const HOME = '/opt/splunkforwarder';

const PLATFORM = "(group_names | select('match', '^platform_') | first | default('platform_' ~ monitoring_platform)) | regex_replace('^platform_', '')";

const OUTPUTS = `# Managed by Ansible (mig_monitoring)
[tcpout]
defaultGroup = primary_indexers

[tcpout:primary_indexers]
server = {{ monitoring_splunk_indexers | join(',') }}
useACK = true
`;

const DEPLOYMENT_CLIENT = `# Managed by Ansible (mig_monitoring)
[deployment-client]

[target-broker:deploymentServer]
targetUri = {{ monitoring_splunk_deployment_server }}
`;

const USER_SEED = `[user_info]
USERNAME = admin
PASSWORD = {{ vault_splunk_uf_admin_password }}
`;

const tasks: Task[] = [
  { name: 'Work out the platform', 'ansible.builtin.set_fact': { monitoring_host_platform: `{{ ${PLATFORM} }}` } },
  // ------------------------------------------------------------ Linux ---
  {
    name: 'Monitoring on Linux',
    when: LINUX,
    become: true,
    block: [
      { name: 'Read the services', 'ansible.builtin.service_facts': {} },
      {
        name: "Say when the platform's monitoring agent is not running yet",
        'ansible.builtin.debug': { msg: '{{ monitoring_linux_agent[monitoring_host_platform] }} is not running yet; Terraform installs it (it can take a few minutes after launch).' },
        when: [
          'monitoring_host_platform in monitoring_linux_agent',
          "(ansible_facts.services[monitoring_linux_agent[monitoring_host_platform] ~ '.service'].state | default('absent')) != 'running'",
        ],
      },
      { name: 'Read the packages (VCF)', 'ansible.builtin.package_facts': {}, when: "monitoring_host_platform == 'vmware'" },
      {
        name: 'Say when open-vm-tools is missing (VCF)',
        'ansible.builtin.debug': { msg: 'open-vm-tools is not installed; the VCF Operations agent needs it.' },
        when: ["monitoring_host_platform == 'vmware'", "'open-vm-tools' not in ansible_facts.packages"],
      },
      {
        name: 'Check the VCF Operations cloud proxy answers on 443',
        'ansible.builtin.wait_for': { host: '{{ monitoring_vcf_cloud_proxy }}', port: 443, timeout: 10 },
        when: ["monitoring_host_platform == 'vmware'", 'monitoring_vcf_cloud_proxy | length > 0'],
      },
      {
        name: 'Install the Universal Forwarder (RHEL family, SLES)',
        'ansible.builtin.package': { name: '{{ monitoring_splunk_rpm_url }}', state: 'present' },
        when: [SPLUNK, "ansible_facts.os_family in ['RedHat', 'Suse']", 'monitoring_splunk_rpm_url | length > 0'],
      },
      {
        name: 'Install the Universal Forwarder (Debian family)',
        'ansible.builtin.apt': { deb: '{{ monitoring_splunk_deb_url }}', state: 'present' },
        when: [SPLUNK, "ansible_facts.os_family == 'Debian'", 'monitoring_splunk_deb_url | length > 0'],
      },
      {
        name: 'Look for an existing forwarder admin',
        'ansible.builtin.stat': { path: `${HOME}/etc/passwd` },
        register: 'monitoring_splunk_passwd',
        when: SPLUNK,
      },
      {
        name: 'Seed the forwarder admin (first start only)',
        'ansible.builtin.copy': { content: USER_SEED, dest: `${HOME}/etc/system/local/user-seed.conf`, owner: '{{ monitoring_splunk_user }}', group: '{{ monitoring_splunk_user }}', mode: '0600' },
        no_log: true,
        when: [SPLUNK, 'not monitoring_splunk_passwd.stat.exists'],
      },
      {
        name: 'Send to the indexers',
        'ansible.builtin.template': { src: 'splunk-outputs.conf.j2', dest: `${HOME}/etc/system/local/outputs.conf`, owner: '{{ monitoring_splunk_user }}', group: '{{ monitoring_splunk_user }}', mode: '0644' },
        when: [SPLUNK, 'monitoring_splunk_indexers | length > 0'],
      },
      {
        name: 'Enrol with the deployment server',
        'ansible.builtin.template': { src: 'splunk-deploymentclient.conf.j2', dest: `${HOME}/etc/system/local/deploymentclient.conf`, owner: '{{ monitoring_splunk_user }}', group: '{{ monitoring_splunk_user }}', mode: '0644' },
        when: [SPLUNK, 'monitoring_splunk_deployment_server | length > 0'],
      },
      {
        name: 'Start the forwarder with the host',
        'ansible.builtin.command': {
          argv: [`${HOME}/bin/splunk`, 'enable', 'boot-start', '-systemd-managed', '1', '-user', '{{ monitoring_splunk_user }}', '--accept-license', '--answer-yes', '--no-prompt'],
          creates: '/etc/systemd/system/SplunkForwarder.service',
        },
        when: SPLUNK,
      },
      { name: 'Keep the forwarder running', 'ansible.builtin.service': { name: 'SplunkForwarder', state: 'started', enabled: true }, when: SPLUNK },
    ],
  },
  // ---------------------------------------------------------- Windows ---
  {
    name: 'Monitoring on Windows',
    when: WINDOWS,
    block: [
      { name: 'Read the services', 'ansible.windows.win_service_info': {}, register: 'monitoring_services' },
      {
        name: "Say when the platform's monitoring agent is not running yet",
        'ansible.builtin.debug': { msg: '{{ monitoring_windows_agent[monitoring_host_platform] }} is not running yet; Terraform installs it (it can take a few minutes after launch).' },
        when: [
          'monitoring_host_platform in monitoring_windows_agent',
          "monitoring_services.services | selectattr('name', 'equalto', monitoring_windows_agent[monitoring_host_platform]) | selectattr('state', 'equalto', 'started') | list | length == 0",
        ],
      },
      {
        name: 'Say when VMware Tools is missing (VCF)',
        'ansible.builtin.debug': { msg: 'VMware Tools is not running; the VCF Operations agent needs it.' },
        when: ["monitoring_host_platform == 'vmware'", "monitoring_services.services | selectattr('name', 'equalto', 'VMTools') | list | length == 0"],
      },
      {
        name: 'Check the VCF Operations cloud proxy answers on 443',
        'ansible.windows.win_wait_for': { host: '{{ monitoring_vcf_cloud_proxy }}', port: 443, timeout: 10 },
        when: ["monitoring_host_platform == 'vmware'", 'monitoring_vcf_cloud_proxy | length > 0'],
      },
      {
        name: 'Install the Universal Forwarder',
        'ansible.windows.win_package': {
          path: '{{ monitoring_splunk_msi_url }}',
          arguments:
            "{{ ['AGREETOLICENSE=Yes', 'SPLUNKUSERNAME=admin', 'SPLUNKPASSWORD=' ~ vault_splunk_uf_admin_password, 'LAUNCHSPLUNK=1', '/quiet'] + (['RECEIVING_INDEXER=' ~ (monitoring_splunk_indexers | first)] if monitoring_splunk_indexers | length > 0 else []) + (['DEPLOYMENT_SERVER=' ~ monitoring_splunk_deployment_server] if monitoring_splunk_deployment_server | length > 0 else []) }}",
          creates_service: 'SplunkForwarder',
          state: 'present',
        },
        no_log: true,
        when: [SPLUNK, 'monitoring_splunk_msi_url | length > 0'],
      },
    ],
  },
  {
    name: 'Say what to do in VCF Operations',
    'ansible.builtin.debug': {
      msg: 'In VCF Operations, install the in-guest (Telegraf) agent on this VM from Inventory > Manage Agents, through the cloud proxy {{ monitoring_vcf_cloud_proxy | default("") }}; Ansible does not push it.',
    },
    when: "monitoring_host_platform == 'vmware'",
  },
];

export const MIG_MONITORING = migrationBlueprint({
  id: 'mig_monitoring',
  label: 'Migration – Monitoring agents',
  description:
    "Check the platform's monitoring agent is running (Terraform installs it on the hyperscalers), check the VCF Operations prerequisites on VCF, and install the Splunk Universal Forwarder from your own package repository when Splunk is the SIEM.",
  inputs: [
    PLATFORM_INPUT,
    {
      id: 'siem',
      label: 'SIEM',
      control: 'select',
      options: [
        { value: 'none', label: 'None (platform monitoring only)' },
        { value: 'splunk', label: 'Splunk (Universal Forwarder)' },
      ],
      default: 'none',
    },
    { id: 'splunk_indexers', label: 'Indexers', control: 'text', default: '', hint: 'host:9997 or [IPv6]:9997, comma separated', showWhen: { input: 'siem', equals: ['splunk'] } },
    { id: 'splunk_deployment_server', label: 'Deployment server', control: 'text', default: '', hint: 'host:8089; it serves the apps from the Splunk page', showWhen: { input: 'siem', equals: ['splunk'] } },
    { id: 'splunk_rpm_url', label: 'Forwarder .rpm (your repository)', control: 'text', default: '', showWhen: { input: 'siem', equals: ['splunk'] } },
    { id: 'splunk_deb_url', label: 'Forwarder .deb (your repository)', control: 'text', default: '', showWhen: { input: 'siem', equals: ['splunk'] } },
    { id: 'splunk_msi_url', label: 'Forwarder .msi (your repository)', control: 'text', default: '', showWhen: { input: 'siem', equals: ['splunk'] } },
    { id: 'vcf_cloud_proxy', label: 'VCF Operations cloud proxy', control: 'text', default: '', hint: 'VCF targets: host name or address' },
  ],
  vars: (v) => ({
    monitoring_platform: text(v.platform, 'aws'),
    monitoring_siem: text(v.siem, 'none'),
    monitoring_splunk_indexers: list(v.splunk_indexers),
    monitoring_splunk_deployment_server: text(v.splunk_deployment_server),
    monitoring_splunk_rpm_url: text(v.splunk_rpm_url),
    monitoring_splunk_deb_url: text(v.splunk_deb_url),
    monitoring_splunk_msi_url: text(v.splunk_msi_url),
    monitoring_splunk_user: 'splunkfwd',
    monitoring_vcf_cloud_proxy: text(v.vcf_cloud_proxy),
    monitoring_linux_agent: { aws: 'amazon-cloudwatch-agent', azure: 'azuremonitoragent', google: 'google-cloud-ops-agent', oci: 'oracle-cloud-agent' },
    monitoring_windows_agent: { aws: 'AmazonCloudWatchAgent', azure: 'AzureMonitorAgent', google: 'google-cloud-ops-agent', oci: 'OCA' },
  }),
  tasks: () => tasks,
  extraFiles: () => ({
    'templates/splunk-outputs.conf.j2': OUTPUTS,
    'templates/splunk-deploymentclient.conf.j2': DEPLOYMENT_CLIENT,
  }),
  findings: (v) =>
    text(v.siem, 'none') === 'splunk'
      ? [
          info(
            'ansible.migration.splunk-apps',
            'The forwarder enrols with the deployment server, which serves the inputs and apps built on the Splunk page. The forwarder packages come from your own repository; the admin password is vault_splunk_uf_admin_password.',
            {},
          ),
        ]
      : [],
});
