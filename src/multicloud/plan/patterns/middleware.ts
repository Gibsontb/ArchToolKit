/**
 * Middleware and messaging (addendum A.4.2): WebSphere, JBoss / WildFly,
 * Tomcat, IBM MQ, RabbitMQ and Kafka. (WebLogic is with the Oracle apps.)
 *
 * - `pattern.mq.amazon-mq`: Amazon MQ is ActiveMQ / RabbitMQ only, so IBM MQ
 *   is not eliminated on AWS but lands on a VM, or IBM MQ SaaS on AWS
 *   (report-only);
 * - `pattern.jboss.app-service`: Azure +2 (App Service runs JBoss EAP 7.4 / 8);
 * - `pattern.websphere.liberty`: WebSphere stays on a VM, or moves to Liberty
 *   on containers as a refactor (IBM Transformation Advisor): a finding.
 * Kafka moves with MirrorMaker 2; RabbitMQ with Shovel.
 */

import { info } from '../../../core/findings.ts';
import { rule, type AnyRule } from '../decide/engine.ts';
import type { AppPattern, Workload } from '../types.ts';
import { fact, patternOf, type PatternEntry } from './model.ts';

export const MIDDLEWARE_SOURCES = {
  amazonMq: 'https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/welcome.html',
  ibmMqSaas: 'https://www.ibm.com/products/mq/saas',
  jboss: 'https://learn.microsoft.com/en-us/azure/developer/java/migration/migrate-jboss-eap-to-jboss-eap-on-azure-app-service',
  transformationAdvisor: 'https://www.ibm.com/docs/en/cta',
  mm2: 'https://kafka.apache.org/documentation/#georeplication',
  shovel: 'https://www.rabbitmq.com/docs/shovel',
  clusterLinking: 'https://docs.confluent.io/platform/current/multi-dc-deployments/cluster-linking/index.html',
} as const;

const Q_APP: PatternEntry['questions'] = [
  { key: 'version', label: 'Version', kind: 'text' },
  { key: 'clustered', label: 'Clustered', kind: 'yesno', default: 'no' },
];
const Q_MSG: PatternEntry['questions'] = [
  ...Q_APP,
  { key: 'queues', label: 'Queues / topics', kind: 'number' },
  { key: 'throughput', label: 'Throughput', kind: 'number', unit: 'msg/s' },
];

function appServer(id: AppPattern, types: PatternEntry['detectFrom'], rules: readonly string[], extra: Partial<PatternEntry> = {}): PatternEntry {
  return {
    id,
    family: 'middleware',
    kind: 'packaged',
    detectFrom: types,
    questions: Q_APP,
    rules,
    components: [{ name: 'Application servers', tier: 'app', workloadTypes: types, tierPattern: 'vm', alternatives: ['paas-web', 'containers'] }],
    methods: ['rebuild', 'aws-mgn', 'azure-migrate', 'gcp-m2vm', 'oci-ocm'],
    artefacts: { ansibleModules: ['ansible.builtin.template', 'ansible.builtin.systemd_service'], runbook: ['Export the server configuration and redeploy the applications (rebuild), or replicate the VM.'] },
    sizing: 'server',
    status: 'automated',
    facts: [],
    ...extra,
  };
}

export const MIDDLEWARE_PATTERNS: readonly PatternEntry[] = [
  appServer('websphere', ['websphere'], ['pattern.websphere.liberty'], {
    facts: [fact('IBM Transformation Advisor assesses WebSphere applications for Liberty on containers.', MIDDLEWARE_SOURCES.transformationAdvisor, 'C')],
  }),
  appServer('jboss', ['jboss'], ['pattern.jboss.app-service'], {
    components: [{ name: 'Application servers', tier: 'app', workloadTypes: ['jboss'], tierPattern: 'vm', perPlatform: { azure: 'paas-web' }, alternatives: ['paas-web', 'containers'] }],
    facts: [fact('Azure App Service runs JBoss EAP 7.4 and 8.', MIDDLEWARE_SOURCES.jboss)],
    preferences: [{ tierPattern: 'paas-web', delta: 2, rule: 'pattern.jboss.app-service', reason: 'App Service runs JBoss EAP.', source: MIDDLEWARE_SOURCES.jboss, verification: 'V-DOC', platforms: ['azure'] }],
  }),
  appServer('tomcat', ['tomcat'], [], { components: [{ name: 'Application servers', tier: 'app', workloadTypes: ['tomcat'], tierPattern: 'vm', alternatives: ['paas-web', 'containers'] }] }),
  {
    id: 'ibm-mq',
    family: 'middleware',
    kind: 'packaged',
    detectFrom: ['ibm-mq'],
    questions: Q_MSG,
    rules: ['pattern.mq.amazon-mq'],
    components: [{ name: 'Queue managers', tier: 'integration', workloadTypes: ['ibm-mq'], tierPattern: 'vm', alternatives: ['containers'] }],
    methods: ['rebuild'],
    artefacts: { ansibleModules: ['ansible.builtin.command'], runbook: ['Rebuild the queue managers from exported definitions (dmpmqcfg), drain, and switch the channels.'] },
    sizing: 'server',
    status: 'partial',
    facts: [
      fact('Amazon MQ supports ActiveMQ and RabbitMQ only.', MIDDLEWARE_SOURCES.amazonMq),
      fact('IBM MQ SaaS runs on AWS (generally available 2025-11-28).', MIDDLEWARE_SOURCES.ibmMqSaas, 'C'),
    ],
  },
  {
    id: 'rabbitmq',
    family: 'middleware',
    kind: 'packaged',
    detectFrom: ['rabbitmq'],
    questions: Q_MSG,
    rules: [],
    components: [{ name: 'Broker', tier: 'integration', workloadTypes: ['rabbitmq'], tierPattern: 'vm', perPlatform: { aws: 'managed-messaging' }, alternatives: ['managed-messaging', 'vm'] }],
    methods: ['rebuild'],
    artefacts: { terraform: { aws: ['aws_mq_broker'] }, ansibleModules: ['ansible.builtin.command'], runbook: ['Shovel from the old broker: rabbitmqctl set_parameter shovel … (generated), then switch the clients.'] },
    status: 'automated',
    facts: [fact('Amazon MQ for RabbitMQ is the managed target on AWS.', MIDDLEWARE_SOURCES.amazonMq), fact('The Shovel plugin moves messages between brokers.', MIDDLEWARE_SOURCES.shovel)],
  },
  {
    id: 'kafka',
    family: 'middleware',
    kind: 'packaged',
    detectFrom: ['kafka'],
    questions: Q_MSG,
    rules: [],
    components: [{ name: 'Kafka cluster', tier: 'integration', workloadTypes: ['kafka'], tierPattern: 'managed-kafka', perPlatform: { vmware: 'vm' }, alternatives: ['vm', 'containers'] }],
    methods: ['rebuild'],
    artefacts: { ansibleModules: ['ansible.builtin.template', 'ansible.builtin.command'], runbook: ['MirrorMaker 2 (generated mm2.properties; SASL credentials from the environment) until the consumers switch; Confluent Cluster Linking is a report-only alternative.'] },
    status: 'automated',
    facts: [fact('MirrorMaker 2 replicates topics between Kafka clusters.', MIDDLEWARE_SOURCES.mm2), fact('Confluent Cluster Linking is an alternative for Confluent Platform.', MIDDLEWARE_SOURCES.clusterLinking, 'C')],
  },
];

export const MIDDLEWARE_RULES: readonly AnyRule[] = [
  rule<Workload>({
    id: 'pattern.mq.amazon-mq',
    kind: 'workload',
    verification: 'V-DOC',
    source: MIDDLEWARE_SOURCES.amazonMq,
    applies: (w, ctx) => patternOf(w, ctx) === 'ibm-mq',
    review: (w, chosen) =>
      chosen?.platform === 'aws'
        ? [info('pattern.mq.amazon-mq', `${w.name}: Amazon MQ runs ActiveMQ and RabbitMQ only, so IBM MQ runs on EC2, or as IBM MQ SaaS on AWS (report-only).`, { source: `${MIDDLEWARE_SOURCES.amazonMq} ; ${MIDDLEWARE_SOURCES.ibmMqSaas}` })]
        : [],
  }),
  rule<Workload>({
    id: 'pattern.jboss.app-service',
    kind: 'workload',
    verification: 'V-DOC',
    source: MIDDLEWARE_SOURCES.jboss,
    applies: (w, ctx) => patternOf(w, ctx) === 'jboss',
    evaluate: (_w, o) => (o.platform === 'azure' ? { delta: 2, reason: 'Azure App Service runs JBoss EAP 7.4 / 8 as a managed platform.' } : undefined),
  }),
  rule<Workload>({
    id: 'pattern.websphere.liberty',
    kind: 'workload',
    verification: 'C',
    source: MIDDLEWARE_SOURCES.transformationAdvisor,
    applies: (w, ctx) => patternOf(w, ctx) === 'websphere',
    findings: (w) => [info('pattern.websphere.liberty', `${w.name}: WebSphere traditional moves as a VM; Liberty on containers is a refactor — assess it with IBM Transformation Advisor.`, { source: MIDDLEWARE_SOURCES.transformationAdvisor })],
  }),
];
