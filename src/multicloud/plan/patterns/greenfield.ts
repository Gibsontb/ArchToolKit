/**
 * Greenfield patterns (addendum A.2.10): the templates a new application
 * starts from, as tier-pattern components. Each tier pattern maps per
 * platform to catalogue types (tier-patterns.ts); VMware Cloud Foundation
 * offers `vm` and `containers` (VKS), so a component whose tier pattern has no
 * VCF service falls back to its first alternative there (see
 * `defaultTierPattern` in catalog.ts).
 *
 * A greenfield app has no servers and no source: its components become
 * synthetic items (WP-19) sized from the load profile (WP-23's `load` engine),
 * and the same `decidePlan` recommends a platform for it.
 */

import type { AppPattern, Platform } from '../types.ts';
import { fact, type ComponentTemplate, type PatternEntry } from './model.ts';

const DNS_CERT: Readonly<Partial<Record<Platform, readonly string[]>>> = {
  aws: ['aws_route53_record', 'aws_acm_certificate'],
  azure: ['azurerm_dns_zone'],
  google: ['google_dns_record_set', 'google_certificate_manager_certificate'],
  oci: ['oci_dns_rrset', 'oci_certificates_management_certificate'],
};
const REGISTRY: Readonly<Partial<Record<Platform, readonly string[]>>> = {
  aws: ['aws_ecr_repository'], azure: ['azurerm_container_registry'], google: ['google_artifact_registry_repository'], oci: ['oci_artifacts_container_repository'],
};
const merge = (...maps: Readonly<Partial<Record<Platform, readonly string[]>>>[]): Partial<Record<Platform, readonly string[]>> => {
  const out: Partial<Record<Platform, string[]>> = {};
  for (const m of maps) for (const [p, list] of Object.entries(m) as [Platform, readonly string[]][]) out[p] = [...(out[p] ?? []), ...list];
  return out;
};

const LOAD_QUESTIONS: PatternEntry['questions'] = [
  { key: 'peakRps', label: 'Peak requests', kind: 'number', unit: 'req/s' },
  { key: 'costClass', label: 'Request cost', kind: 'select', options: ['static', 'light', 'typical', 'heavy'], default: 'typical' },
  { key: 'dataGib', label: 'Data', kind: 'number', unit: 'GiB' },
  { key: 'slo', label: 'Availability SLO', kind: 'select', options: ['99.0', '99.5', '99.9', '99.95', '99.99'], default: '99.9' },
];

/** Greenfield patterns whose template includes an app ingress (AppPlan.ingress, the `<p>_app_ingress` blueprint). */
export const GREENFIELD_INGRESS: ReadonlySet<AppPattern> = new Set(['web-app', 'microservices', 'api']);

const DB: ComponentTemplate = { name: 'data', tier: 'data', tierPattern: 'managed-db', alternatives: ['vm'] };

function entry(id: AppPattern, components: readonly ComponentTemplate[], terraform: PatternEntry['artefacts']['terraform'] = {}): PatternEntry {
  return {
    id,
    family: 'greenfield',
    kind: 'home-grown',
    detectFrom: [],
    questions: id === 'blank' ? [] : LOAD_QUESTIONS,
    rules: [],
    components,
    methods: ['deploy'],
    artefacts: { terraform, runbook: id === 'blank' ? [] : ['Deploy through the pipeline per environment (Deploy a new service); no waves.'] },
    sizing: 'load',
    status: 'automated',
    facts: id === 'blank' ? [] : [fact('Sizing from load uses planning assumptions (requests per vCPU by cost class, 60% target utilisation): replace them with load-test numbers.', 'https://learn.microsoft.com/en-us/azure/well-architected/performance-efficiency/capacity-planning', 'I')],
  };
}

export const GREENFIELD_PATTERNS: readonly PatternEntry[] = [
  entry('web-app', [
    { name: 'web', tier: 'web', tierPattern: 'paas-web', alternatives: ['containers', 'vm'] },
    DB,
    { name: 'cache', tier: 'data', tierPattern: 'managed-cache', alternatives: ['vm'] },
  ], DNS_CERT),
  entry('api', [
    { name: 'api', tier: 'app', tierPattern: 'serverless', alternatives: ['containers', 'paas-web', 'vm'] },
    { name: 'gateway', tier: 'edge', tierPattern: 'api-gateway', alternatives: ['containers'] },
    DB,
  ], DNS_CERT),
  entry('microservices', [
    { name: 'platform', tier: 'platform', tierPattern: 'containers' },
    DB,
    { name: 'messaging', tier: 'integration', tierPattern: 'managed-messaging', alternatives: ['managed-kafka', 'vm'] },
  ], merge(REGISTRY, DNS_CERT)),
  entry('batch-pipeline', [
    { name: 'compute', tier: 'app', tierPattern: 'batch', alternatives: ['containers', 'vm'] },
    { name: 'storage', tier: 'data', tierPattern: 'object-storage', alternatives: ['file-service'] },
    { name: 'orchestration', tier: 'app', tierPattern: 'workflow', alternatives: ['serverless', 'vm'] },
    DB,
  ]),
  entry('database', [DB]),
  entry('file-share', [{ name: 'file', tier: 'file', tierPattern: 'file-service', alternatives: ['vm'] }]),
  entry('vdi', [{ name: 'desktops', tier: 'vdi', tierPattern: 'vdi-service', alternatives: ['vm'] }]),
  entry('messaging', [{ name: 'broker', tier: 'integration', tierPattern: 'managed-messaging', alternatives: ['managed-kafka', 'vm'] }]),
  entry('static-site', [{ name: 'site', tier: 'web', tierPattern: 'static-site', alternatives: ['containers', 'vm'] }], DNS_CERT),
  entry('event-driven', [
    { name: 'functions', tier: 'app', tierPattern: 'serverless', alternatives: ['containers'] },
    { name: 'bus', tier: 'integration', tierPattern: 'managed-messaging', alternatives: ['managed-kafka', 'vm'] },
    { name: 'storage', tier: 'data', tierPattern: 'object-storage', alternatives: ['vm'] },
  ]),
  entry('blank', []),
];
