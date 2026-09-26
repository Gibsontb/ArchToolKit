/**
 * SAP (addendum A.4.2, A.4.4): the patterns and their placement rules.
 *
 * - `pattern.sap.hana-certified` eliminates a platform with no certified type
 *   ≥ the HANA memory (AWS, Azure, Google Cloud (GCP), and VCF 9 within its
 *   limits), naming the largest certified type in the reason;
 * - `pattern.sap.hana-certified-oci` does the same for OCI, whose certified
 *   list is unverified ([U]), so it is a separate rule with its own tag;
 * - `pattern.sap.anydb-support`: SAP on Oracle (anyDB) is not supported on
 *   Compute Engine (only Bare Metal Solution [U]); OCI is Oracle's own;
 * - `pattern.sap.vcf-notes`: VCF within the SAP notes (report).
 */

import { info } from '../../../core/findings.ts';
import { isDatabase, type PlanItem } from '../decide/disposition.ts';
import { rule, type AnyRule, type RuleContext } from '../decide/engine.ts';
import type { AppPattern } from '../types.ts';
import { answersOf, numberAnswer, patternOf, workloadTypeOf, type AssessQuestion, type PatternEntry } from './model.ts';
import { SAP_FACTS, SAP_FETCHED_AT, SAP_SOURCES, VCF_HANA_LIMITS, sapFit } from './sap-data.ts';

export const SAP_PATTERN_IDS: readonly AppPattern[] = ['sap-s4hana', 'sap-ecc-hana', 'sap-ecc-anydb', 'sap-bw', 'sap-netweaver-java', 'sap-po', 'sap-hana-native'];
/** Patterns whose database is HANA unless the answers say otherwise. */
const HANA_BASED: ReadonlySet<AppPattern> = new Set(['sap-s4hana', 'sap-ecc-hana', 'sap-bw', 'sap-hana-native']);

export const SAP_QUESTIONS: readonly AssessQuestion[] = [
  { key: 'sids', label: 'SAP system IDs (SIDs)', kind: 'text' },
  { key: 'landscape', label: 'Landscape', kind: 'select', options: ['prod', 'qa', 'dev', 'sbx'], default: 'prod' },
  { key: 'db', label: 'Database', kind: 'select', options: ['hana', 'oracle', 'sqlserver', 'db2', 'ase', 'maxdb'], default: 'hana' },
  { key: 'hanaMemoryGib', label: 'HANA memory', kind: 'number', unit: 'GiB' },
  { key: 'use', label: 'HANA workload', kind: 'select', options: ['oltp', 'olap'], default: 'oltp' },
  { key: 'saps', label: 'SAPS (optional)', kind: 'number' },
  { key: 'ha', label: 'High availability', kind: 'yesno', default: 'no' },
  { key: 'method', label: 'Method preference', kind: 'select', options: ['hsr', 'backup-restore', 'dmo-system-move', 'hetero-copy'], default: 'hsr' },
];

const SAP_ARTEFACTS: PatternEntry['artefacts'] = {
  terraform: { azure: ['azurerm_workloads_sap_three_tier_virtual_instance', 'azurerm_netapp_volume_group_sap_hana'] },
  ansibleModules: ['community.sap_libs.sap_hdbsql', 'community.sap_libs.sap_control_exec', 'ansible.builtin.command'],
  ansibleRoles: ['community.sap_install.sap_general_preconfigure', 'community.sap_install.sap_hana_preconfigure', 'community.sap_install.sap_netweaver_preconfigure'],
  runbook: [
    'Check SAP\'s certified hardware directory for the chosen type before ordering.',
    'HANA system replication: hdbnsutil -sr_enable on the source; hdbnsutil -sr_register --remoteHost=<source> --replicationMode=async --operationMode=logreplay on the target; cutover with hdbnsutil -sr_takeover.',
    'DMO with System Move and heterogeneous system copy (SWPM / R3load) are run by SAP Basis with SAP\'s tools.',
    'SAP disk layout: /hana/data, /hana/log, /hana/shared, /usr/sap, /sapmnt, sized from the HANA memory by the cloud\'s SAP storage guide.',
    'RISE with SAP (repurchase) is the SaaS alternative: a commercial decision with SAP, not generated.',
  ],
};

function sapEntry(id: AppPattern, detectFrom: PatternEntry['detectFrom'], hana: boolean): PatternEntry {
  return {
    id,
    family: 'sap',
    kind: 'cots',
    detectFrom,
    questions: SAP_QUESTIONS,
    rules: hana ? ['pattern.sap.hana-certified', 'pattern.sap.hana-certified-oci', 'pattern.sap.vcf-notes'] : ['pattern.sap.anydb-support', 'pattern.sap.vcf-notes'],
    components: [
      ...(hana ? [{ name: 'HANA database', tier: 'data' as const, workloadTypes: ['sap-hana' as const], tierPattern: 'sap-certified' as const }] : [{ name: 'Database', tier: 'data' as const, workloadTypes: ['db-host' as const], tierPattern: 'vm' as const, alternatives: ['managed-db' as const] }]),
      { name: 'Application servers', tier: 'app', workloadTypes: id === 'sap-netweaver-java' || id === 'sap-po' ? ['sap-java', 'sap-netweaver'] : ['sap-netweaver'], tierPattern: hana ? 'sap-certified' : 'vm', alternatives: ['vm', 'vmware-service'] },
    ],
    methods: hana ? ['sap-hsr', 'sap-backup-restore'] : ['rebuild', 'with-vm', 'oracle-rman'],
    artefacts: SAP_ARTEFACTS,
    sizing: 'sap',
    status: 'partial',
    facts: SAP_FACTS,
  };
}

export const SAP_PATTERNS: readonly PatternEntry[] = [
  sapEntry('sap-s4hana', ['sap-hana', 'sap-netweaver'], true),
  sapEntry('sap-ecc-hana', ['sap-hana', 'sap-netweaver'], true),
  sapEntry('sap-ecc-anydb', ['sap-netweaver'], false),
  sapEntry('sap-bw', ['sap-hana', 'sap-netweaver'], true),
  sapEntry('sap-netweaver-java', ['sap-java'], false),
  sapEntry('sap-po', ['sap-java'], false),
  sapEntry('sap-hana-native', ['sap-hana'], true),
];

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const isSap = (item: PlanItem, ctx: RuleContext): boolean => {
  const p = patternOf(item, ctx);
  return !!p && SAP_PATTERN_IDS.includes(p);
};

/** A HANA item: a sap-hana database, a sap-hana workload, or the db-role server of a HANA-based SAP app. */
export function isHanaItem(item: PlanItem, ctx: RuleContext): boolean {
  if (isDatabase(item)) return item.engine === 'sap-hana';
  const type = workloadTypeOf(item);
  if (type) return type === 'sap-hana';
  const p = patternOf(item, ctx);
  if (!p || item.role !== 'db') return false;
  const db = answersOf(item, ctx)['db'];
  return db ? db === 'hana' : HANA_BASED.has(p);
}

/** HANA memory: the component setting, then the app's answer, else the item's memory. */
export function hanaMemoryOf(item: PlanItem, ctx: RuleContext): number {
  return numberAnswer(item, ctx, 'sap.hanaMemoryGib', 'hanaMemoryGib') ?? item.ramGib;
}

function useOf(item: PlanItem, ctx: RuleContext): 'oltp' | 'olap' | undefined {
  const u = answersOf(item, ctx)['use'];
  if (u === 'oltp' || u === 'olap') return u;
  return patternOf(item, ctx) === 'sap-bw' ? 'olap' : undefined;
}

export const SAP_RULES: readonly AnyRule[] = [
  rule<PlanItem>({
    id: 'pattern.sap.hana-certified',
    kind: 'any',
    verification: 'V-DOC',
    source: `${SAP_SOURCES.directory} ; ${SAP_SOURCES.aws} ; ${SAP_SOURCES.azure} ; ${SAP_SOURCES.google} ; ${SAP_SOURCES.vcf}`,
    applies: isHanaItem,
    evaluate: (item, o, ctx) => {
      if (o.platform === 'oci') return undefined;
      const need = hanaMemoryOf(item, ctx);
      const f = sapFit(o.platform, need, useOf(item, ctx));
      if (o.platform === 'vmware') {
        return f.type
          ? { delta: 1, reason: `A VCF 9 VM carries ${need} GiB of HANA within SAP's limits (${VCF_HANA_LIMITS.memoryGib} GiB, ${VCF_HANA_LIMITS.vcpu} vCPU; SAP notes 3663150, 3703816).` }
          : { eliminate: true, reason: `HANA at ${need} GiB is above the ${VCF_HANA_LIMITS.memoryGib} GiB a VCF 9 VM is supported for.` };
      }
      return f.type
        ? { delta: 1, reason: `${f.type} (${f.memoryGib} GiB) is the smallest SAP HANA certified type with ${need} GiB.` }
        : { eliminate: true, reason: `No SAP HANA certified ${o.platform} type has ${need} GiB${f.largest ? `; the largest is ${f.largest.type} (${f.largest.memoryGib} GiB)` : ''}.` };
    },
    findings: (item) => [
      info('pattern.sap.check-directory', `${item.name}: SAP HANA certification changes monthly (the lists were read ${SAP_FETCHED_AT}); check SAP's certified hardware directory before ordering.`, { source: SAP_SOURCES.directory }),
    ],
  }),

  rule<PlanItem>({
    id: 'pattern.sap.hana-certified-oci',
    kind: 'any',
    verification: 'I',
    source: SAP_SOURCES.directory,
    applies: isHanaItem,
    evaluate: (item, o, ctx) => {
      if (o.platform !== 'oci') return undefined;
      const need = hanaMemoryOf(item, ctx);
      const f = sapFit('oci', need, useOf(item, ctx));
      return f.type
        ? { delta: 0, reason: `${f.type} (${f.memoryGib} GiB) would carry ${need} GiB, but OCI's certified shapes are not confirmed from an Oracle page [U].` }
        : { eliminate: true, reason: `No OCI shape recorded as SAP HANA certified has ${need} GiB${f.largest ? `; the largest recorded is ${f.largest.type} (${f.largest.memoryGib} GiB) [U]` : ''}.` };
    },
  }),

  rule<PlanItem>({
    id: 'pattern.sap.anydb-support',
    kind: 'any',
    verification: 'I',
    source: 'https://docs.cloud.google.com/solutions/sap/docs/sap-on-google-cloud-bare-metal-solution',
    applies: (item, ctx) => {
      if (!isSap(item, ctx)) return false;
      return isDatabase(item) ? item.engine === 'oracle' : item.role === 'db' && answersOf(item, ctx)['db'] === 'oracle';
    },
    evaluate: (_item, o) => {
      if (o.platform === 'google') return { eliminate: true, reason: 'SAP on Oracle Database runs on Google Cloud (GCP) only on Bare Metal Solution, not on Compute Engine [U].' };
      if (o.platform === 'oci') return { delta: 2, reason: 'SAP on Oracle Database is supported natively on OCI.' };
      return undefined;
    },
  }),

  rule<PlanItem>({
    id: 'pattern.sap.vcf-notes',
    kind: 'any',
    verification: 'V-DOC',
    source: SAP_SOURCES.vcf,
    applies: (item, ctx) => isSap(item, ctx) && isHanaItem(item, ctx),
    findings: (item) => [
      info('pattern.sap.vcf-notes', `${item.name}: on VMware Cloud Foundation 9, SAP HANA and NetWeaver are supported within SAP notes 3663150 and 3703816 (general VM guidance: 2652670).`, { source: SAP_SOURCES.vcf }),
    ],
  }),
];
