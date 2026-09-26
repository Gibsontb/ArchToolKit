/**
 * app_mm2: Kafka MirrorMaker 2 on a Linux host, replicating topics, their
 * configuration and consumer group offsets from the source cluster to the
 * target (addendum A.4.2, Middleware: Kafka to MSK / Event Hubs / Google
 * Cloud Managed Service for Apache Kafka / OCI Streaming).
 *
 *   - a Java runtime and a `kafka` system user;
 *   - Apache Kafka unpacked under /opt (or one already on the host);
 *   - /etc/mm2/mm2.properties from a template: the two clusters' bootstrap
 *     servers (IPv6 literals in brackets), the topics and groups to mirror,
 *     the replication factor of the topics MM2 creates, the replication policy
 *     (identity keeps the topic names, which a migration wants), consumer
 *     offset sync, and each side's security (TLS, SASL SCRAM or PLAIN) with
 *     the credentials substituted from vault variables: the file is 0600,
 *     owned by kafka, and the task that writes it logs nothing;
 *   - a systemd unit, mm2.service, enabled and started, restarted when the
 *     configuration changes.
 *
 * MirrorMaker 2 in dedicated mode only connects out, so no inbound firewall
 * rule is needed.
 * https://kafka.apache.org/documentation/#georeplication
 */

                                                                
                                                                 
import { number, text } from '../migration/common.js';
import { patternBlueprint, select } from './common.js';

/** One side's client security, as properties prefixed with the cluster alias. */
function securityBlock(side                     )         {
  const v = `mm2_${side}_security`;
  return `{% if ${v} != 'none' %}
${side}.security.protocol = {{ 'SSL' if ${v} == 'ssl' else 'SASL_SSL' }}
{% if mm2_truststore | length > 0 %}
${side}.ssl.truststore.location = {{ mm2_truststore }}
{% endif %}
{% endif %}
{% if ${v} in ['scram-sha-512', 'scram-sha-256'] %}
${side}.sasl.mechanism = {{ 'SCRAM-SHA-512' if ${v} == 'scram-sha-512' else 'SCRAM-SHA-256' }}
${side}.sasl.jaas.config = org.apache.kafka.common.security.scram.ScramLoginModule required username="{{ vault_mm2_${side}_username }}" password="{{ vault_mm2_${side}_password }}";
{% elif ${v} == 'plain' %}
${side}.sasl.mechanism = PLAIN
${side}.sasl.jaas.config = org.apache.kafka.common.security.plain.PlainLoginModule required username="{{ vault_mm2_${side}_username }}" password="{{ vault_mm2_${side}_password }}";
{% endif %}
`;
}

const PROPERTIES = `clusters = source, target
source.bootstrap.servers = {{ mm2_source_bootstrap }}
target.bootstrap.servers = {{ mm2_target_bootstrap }}

source->target.enabled = true
target->source.enabled = false
source->target.topics = {{ mm2_topics }}
source->target.groups = {{ mm2_groups }}
source->target.sync.group.offsets.enabled = true
source->target.emit.checkpoints.enabled = true
source->target.emit.heartbeats.enabled = true
sync.topic.configs.enabled = true
refresh.topics.interval.seconds = 60
refresh.groups.interval.seconds = 60
tasks.max = {{ mm2_tasks_max }}

replication.policy.class = {{ 'org.apache.kafka.connect.mirror.IdentityReplicationPolicy' if mm2_replication_policy == 'identity' else 'org.apache.kafka.connect.mirror.DefaultReplicationPolicy' }}
replication.factor = {{ mm2_replication_factor }}
checkpoints.topic.replication.factor = {{ mm2_replication_factor }}
heartbeats.topic.replication.factor = {{ mm2_replication_factor }}
offset-syncs.topic.replication.factor = {{ mm2_replication_factor }}
offset.storage.replication.factor = {{ mm2_replication_factor }}
status.storage.replication.factor = {{ mm2_replication_factor }}
config.storage.replication.factor = {{ mm2_replication_factor }}

${securityBlock('source')}
${securityBlock('target')}`;

const UNIT = `[Unit]
Description=Kafka MirrorMaker 2 (source to target)
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=kafka
Group=kafka
Environment=LOG_DIR=/var/log/mm2
Environment="KAFKA_HEAP_OPTS=-Xms{{ mm2_heap }} -Xmx{{ mm2_heap }}"
ExecStart={{ mm2_kafka_dir }}/bin/connect-mirror-maker.sh /etc/mm2/mm2.properties
Restart=on-failure
RestartSec=10
LimitNOFILE=100000

[Install]
WantedBy=multi-user.target
`;

const tasks         = [
  {
    name: 'Check both clusters are named',
    'ansible.builtin.assert': {
      that: ['mm2_source_bootstrap | length > 0', 'mm2_target_bootstrap | length > 0'],
      fail_msg: 'Set the source and target bootstrap servers (host:port, [IPv6]:port; comma separated).',
      quiet: true,
    },
  },
  { name: 'Install a Java runtime', 'ansible.builtin.package': { name: '{{ mm2_java_package[ansible_facts.os_family] | default(mm2_java_package.RedHat) }}', state: 'present' } },
  { name: 'Add the kafka group', 'ansible.builtin.group': { name: 'kafka', system: true, state: 'present' } },
  {
    name: 'Add the kafka user',
    'ansible.builtin.user': { name: 'kafka', group: 'kafka', system: true, shell: '/sbin/nologin', home: '/var/lib/kafka', create_home: true, state: 'present' },
  },
  {
    name: 'Unpack Apache Kafka',
    'ansible.builtin.unarchive': {
      src: '{{ mm2_kafka_mirror }}/{{ mm2_kafka_version }}/kafka_{{ mm2_scala_version }}-{{ mm2_kafka_version }}.tgz',
      dest: '/opt',
      remote_src: true,
      creates: '/opt/kafka_{{ mm2_scala_version }}-{{ mm2_kafka_version }}/bin/connect-mirror-maker.sh',
      owner: 'root',
      group: 'root',
    },
    when: 'mm2_kafka_home | length == 0',
  },
  {
    name: 'Check MirrorMaker 2 is where the unit runs it',
    'ansible.builtin.stat': { path: '{{ mm2_kafka_dir }}/bin/connect-mirror-maker.sh' },
    register: 'mm2_script',
  },
  {
    name: 'Refuse a Kafka directory without MirrorMaker 2',
    'ansible.builtin.assert': { that: ['mm2_script.stat.exists'], fail_msg: '{{ mm2_kafka_dir }}/bin/connect-mirror-maker.sh is missing.', quiet: true },
    when: 'not ansible_check_mode',
  },
  { name: 'Make the configuration folder', 'ansible.builtin.file': { path: '/etc/mm2', state: 'directory', owner: 'kafka', group: 'kafka', mode: '0750' } },
  { name: 'Make the log folder', 'ansible.builtin.file': { path: '/var/log/mm2', state: 'directory', owner: 'kafka', group: 'kafka', mode: '0750' } },
  {
    name: 'Write mm2.properties (with the cluster credentials)',
    'ansible.builtin.template': { src: 'mm2.properties.j2', dest: '/etc/mm2/mm2.properties', owner: 'kafka', group: 'kafka', mode: '0600' },
    no_log: true,
    notify: 'Restart MirrorMaker 2',
  },
  {
    name: 'Write the mm2 service',
    'ansible.builtin.template': { src: 'mm2.service.j2', dest: '/etc/systemd/system/mm2.service', owner: 'root', group: 'root', mode: '0644' },
    notify: 'Restart MirrorMaker 2',
  },
  {
    name: 'Enable and start MirrorMaker 2',
    'ansible.builtin.systemd_service': { name: 'mm2', enabled: true, state: 'started', daemon_reload: true },
    when: 'not ansible_check_mode or mm2_script.stat.exists',
  },
];

export const MM2_ROLE       = {
  name: 'mm2',
  description: 'Kafka MirrorMaker 2 as a systemd service, mm2.properties with the credentials from the vault.',
  tasks,
  handlers: [{ name: 'Restart MirrorMaker 2', 'ansible.builtin.systemd_service': { name: 'mm2', state: 'restarted', daemon_reload: true } }],
  templates: { 'mm2.properties.j2': PROPERTIES, 'mm2.service.j2': UNIT },
  defaults: {
    mm2_source_bootstrap: '',
    mm2_target_bootstrap: '',
    mm2_topics: '.*',
    mm2_groups: '.*',
    mm2_replication_factor: 3,
    mm2_replication_policy: 'identity',
    mm2_source_security: 'none',
    mm2_target_security: 'scram-sha-512',
    mm2_truststore: '',
    mm2_tasks_max: 4,
    mm2_heap: '2g',
    mm2_kafka_home: '',
    mm2_kafka_version: '4.1.0',
    mm2_scala_version: '2.13',
    mm2_kafka_mirror: 'https://archive.apache.org/dist/kafka',
  },
  derived: {
    mm2_kafka_dir: "{{ mm2_kafka_home if mm2_kafka_home | length > 0 else '/opt/kafka_' ~ mm2_scala_version ~ '-' ~ mm2_kafka_version }}",
    mm2_java_package: { RedHat: 'java-21-openjdk-headless', Debian: 'openjdk-21-jre-headless', Suse: 'java-21-openjdk-headless' },
  },
};

const SECURITY                                         = [
  ['none', 'None (PLAINTEXT)'],
  ['ssl', 'TLS only'],
  ['scram-sha-512', 'SASL/SCRAM-SHA-512 over TLS (Amazon MSK)'],
  ['scram-sha-256', 'SASL/SCRAM-SHA-256 over TLS'],
  ['plain', 'SASL/PLAIN over TLS (Event Hubs, Google Cloud (GCP) Managed Kafka, OCI Streaming)'],
];

const SASL = ['scram-sha-512', 'scram-sha-256', 'plain'];

export const APP_MM2 = patternBlueprint({
  id: 'app_mm2',
  label: 'Kafka – MirrorMaker 2 replication',
  description:
    'MirrorMaker 2 on a Linux host: Java and Apache Kafka (or the Kafka already there), mm2.properties with the source and target bootstrap servers (IPv6 in brackets), topics and groups, replication factor, identity replication policy, offset sync and each side\'s TLS / SASL settings with the credentials from the vault (0600, not logged), and mm2.service enabled and started.',
  hosts: { default: 'all', hint: 'The MirrorMaker 2 host(s), e.g. role_mm2' },
  become: true,
  inputs: [
    { id: 'source_bootstrap', label: 'Source bootstrap servers', control: 'text', default: '', placeholder: 'kafka1:9092,[2001:db8::10]:9092' },
    select('source_security', 'Source security', SECURITY, 'none'),
    { id: 'target_bootstrap', label: 'Target bootstrap servers', control: 'text', default: '', placeholder: 'b-1.msk.example:9096' },
    select('target_security', 'Target security', SECURITY, 'scram-sha-512'),
    { id: 'topics', label: 'Topics (regex)', control: 'text', default: '.*' },
    { id: 'groups', label: 'Consumer groups (regex)', control: 'text', default: '.*' },
    { id: 'replication_factor', label: 'Replication factor', control: 'number', default: 3, min: 1, max: 5 },
    select('replication_policy', 'Topic names on the target', [['identity', 'The same (IdentityReplicationPolicy)'], ['default', 'Prefixed with source. (DefaultReplicationPolicy)']], 'identity'),
    { id: 'truststore', label: 'Truststore (JKS / PKCS12)', control: 'text', default: '', hint: 'Only for a private CA; empty = the JVM default' },
    { id: 'tasks_max', label: 'Tasks', control: 'number', default: 4, min: 1, max: 64 },
    { id: 'kafka_home', label: 'Existing Kafka directory', control: 'text', default: '', placeholder: '/opt/kafka', hint: 'Empty = install Apache Kafka' },
    { id: 'kafka_version', label: 'Apache Kafka version', control: 'combo', default: '4.1.0', options: [{ value: '4.1.0', label: '4.1.0' }, { value: '4.0.0', label: '4.0.0' }, { value: '3.9.1', label: '3.9.1' }], showWhen: { input: 'kafka_home', equals: [''] } },
  ],
  roles: () => [MM2_ROLE],
  vars: (v                ) => ({
    mig_mm2_source_bootstrap: text(v.source_bootstrap),
    mig_mm2_target_bootstrap: text(v.target_bootstrap),
    mig_mm2_source_security: text(v.source_security, 'none'),
    mig_mm2_target_security: text(v.target_security, 'scram-sha-512'),
    mig_mm2_topics: text(v.topics, '.*'),
    mig_mm2_groups: text(v.groups, '.*'),
    mig_mm2_replication_factor: number(v.replication_factor, 3),
    mig_mm2_replication_policy: text(v.replication_policy, 'identity'),
    mig_mm2_truststore: text(v.truststore),
    mig_mm2_tasks_max: number(v.tasks_max, 4),
    mig_mm2_kafka_home: text(v.kafka_home),
    mig_mm2_kafka_version: text(v.kafka_version, '4.1.0'),
  }),
  vaults: {
    vault_mm2_source_username: 'SASL user name on the source cluster',
    vault_mm2_source_password: 'its password',
    vault_mm2_target_username: 'SASL user name on the target cluster ($ConnectionString for Event Hubs)',
    vault_mm2_target_password: 'its password (the connection string for Event Hubs, the auth token for OCI Streaming)',
  },
  vaultsFor: (v                ) => [
    ...(SASL.includes(text(v.source_security, 'none')) ? ['vault_mm2_source_username', 'vault_mm2_source_password'] : []),
    ...(SASL.includes(text(v.target_security, 'scram-sha-512')) ? ['vault_mm2_target_username', 'vault_mm2_target_password'] : []),
  ],
});
