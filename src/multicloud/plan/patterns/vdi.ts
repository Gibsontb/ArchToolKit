/**
 * Virtual desktops (addendum A.4.2, A.4.5): Citrix Virtual Apps and Desktops,
 * Remote Desktop Services and Omnissa Horizon.
 *
 * - `pattern.vdi.density`: session hosts = ceil(concurrent users / (users per
 *   vCPU × host vCPU)), with light 6, medium 4, heavy 2 users per vCPU and
 *   hosts of 8–24 vCPU (Microsoft's session-host sizing guidelines). The
 *   numbers are WP-23's (`sizing/vdi.ts`), reused here.
 * - `pattern.vdi.horizon`: Horizon (Omnissa) is supported on VCF, Azure
 *   VMware Solution and Google Cloud VMware Engine, so VMware and the VMware
 *   services score +2 for Horizon. Citrix DaaS and Amazon WorkSpaces Core are
 *   report-only.
 */

import { info } from '../../../core/findings.ts';
import type { PlanItem } from '../decide/disposition.ts';
import { rule, type AnyRule, type RuleContext } from '../decide/engine.ts';
import { SESSION_DENSITY, VDI_SOURCES, type Persona } from '../sizing/vdi.ts';
import type { AppPattern, Workload } from '../types.ts';
import { answersOf, fact, patternOf, type AssessQuestion, type PatternEntry } from './model.ts';

export const VDI_PATTERN_IDS: readonly AppPattern[] = ['citrix-vad', 'rds', 'horizon'];
const HORIZON_SOURCE = 'https://techzone.omnissa.com/resource/horizon-8-azure-vmware-solution-architecture';
const WORKSPACES_CORE = 'https://aws.amazon.com/workspaces/core/';
const CITRIX_DAAS = 'https://docs.citrix.com/en-us/citrix-daas';

export const VDI_QUESTIONS: readonly AssessQuestion[] = [
  { key: 'users', label: 'Users', kind: 'number' },
  { key: 'concurrentPct', label: 'Concurrent users', kind: 'number', unit: '%', default: '100' },
  { key: 'persona', label: 'Persona', kind: 'select', options: ['light', 'medium', 'heavy'], default: 'medium' },
  { key: 'persistent', label: 'Persistent desktops', kind: 'yesno', default: 'no' },
  { key: 'profileGib', label: 'Profile size per user', kind: 'number', unit: 'GiB', default: '30' },
  { key: 'gpu', label: 'GPU', kind: 'yesno', default: 'no' },
  { key: 'keepBroker', label: 'Keep the current broker (Citrix / Horizon)', kind: 'yesno', default: 'no' },
];

export const VDI_FACTS = [
  fact('Session-host density: light 6, medium 4, heavy 2 users per vCPU; hosts of 8–24 vCPU.', VDI_SOURCES.density),
  fact('AWS maps persistent desktops to WorkSpaces Personal and non-persistent ones to WorkSpaces Pools.', VDI_SOURCES.workspaces),
  fact('FSLogix profile containers on Azure Files (premium) for Azure Virtual Desktop.', VDI_SOURCES.fslogix),
  fact('Omnissa Horizon 8 is supported on Azure VMware Solution (KB 80850) and Google Cloud VMware Engine (KB 81922).', HORIZON_SOURCE),
  fact('Amazon WorkSpaces Core runs a third-party broker (Citrix, Horizon) on WorkSpaces infrastructure: report-only.', WORKSPACES_CORE, 'C'),
  fact('Citrix DaaS (the Citrix cloud service) is a report-only alternative for Citrix estates.', CITRIX_DAAS, 'C'),
];

const ARTEFACTS: PatternEntry['artefacts'] = {
  ansibleModules: ['ansible.windows.win_regedit', 'ansible.windows.win_powershell', 'ansible.windows.win_package'],
  runbook: [
    'New golden images and FSLogix profile containers (a service replacement, not a replication).',
    'Copy profile data with robocopy /COPY:DATSOU.',
  ],
};

function entry(id: AppPattern, types: PatternEntry['detectFrom']): PatternEntry {
  return {
    id,
    family: 'vdi',
    kind: 'infrastructure',
    detectFrom: types,
    questions: VDI_QUESTIONS,
    rules: ['pattern.vdi.density', ...(id === 'horizon' ? ['pattern.vdi.horizon'] : []), ...(id === 'citrix-vad' || id === 'horizon' ? ['pattern.vdi.broker'] : [])],
    components: [
      { name: 'Session hosts / desktops', tier: 'vdi', workloadTypes: types, tierPattern: 'vdi-service', perPlatform: { google: 'vm', vmware: id === 'horizon' ? 'vdi-service' : 'vm' }, alternatives: ['vm', 'vmware-service'] },
      ...(id === 'citrix-vad' ? [{ name: 'Citrix infrastructure', tier: 'infra' as const, workloadTypes: ['citrix-infra' as const], tierPattern: 'vm' as const }] : []),
    ],
    methods: ['rebuild'],
    artefacts: ARTEFACTS,
    sizing: 'vdi',
    status: 'automated',
    facts: VDI_FACTS,
    ...(id === 'horizon'
      ? { preferences: [{ tierPattern: 'vmware-service' as const, delta: 2, rule: 'pattern.vdi.horizon', reason: 'Horizon is supported on VCF and the VMware services.', source: HORIZON_SOURCE, verification: 'V-DOC' as const }] }
      : {}),
  };
}

export const VDI_PATTERNS: readonly PatternEntry[] = [
  entry('citrix-vad', ['citrix-vda', 'citrix-infra']),
  entry('rds', ['rds-host']),
  entry('horizon', ['horizon']),
];

/** Session hosts for concurrent users (A.4.5): ceil(concurrent / (density × host vCPU)); host vCPU clamped to 8–24. */
export function sessionHosts(concurrentUsers: number, persona: Persona, hostVcpu = 16): number {
  const vcpu = Math.min(24, Math.max(8, hostVcpu));
  return Math.max(1, Math.ceil(concurrentUsers / (SESSION_DENSITY[persona] * vcpu)));
}

const isVdi = (item: PlanItem, ctx: RuleContext): boolean => VDI_PATTERN_IDS.includes(patternOf(item, ctx) ?? 'generic');
const personaOf = (a: Readonly<Record<string, string>>): Persona => (a['persona'] === 'light' || a['persona'] === 'heavy' ? a['persona'] : 'medium');

export const VDI_RULES: readonly AnyRule[] = [
  rule<Workload>({
    id: 'pattern.vdi.density',
    kind: 'workload',
    verification: 'V-DOC',
    source: VDI_SOURCES.density,
    applies: (w, ctx) => isVdi(w, ctx) && Number(answersOf(w, ctx)['users'] ?? ctx.appOf(w)?.users ?? 0) > 0,
    findings: (w, ctx) => {
      const a = answersOf(w, ctx);
      const users = Number(a['users'] ?? ctx.appOf(w)?.users ?? 0);
      const concurrent = Math.ceil(users * Number(a['concurrentPct'] ?? 100) / 100);
      const persona = personaOf(a);
      return [info('pattern.vdi.density', `${w.app}: ${concurrent} concurrent ${persona} users need ${sessionHosts(concurrent, persona)} multi-session host(s) of 16 vCPU (${SESSION_DENSITY[persona]} users per vCPU).`, { source: VDI_SOURCES.density })];
    },
  }),
  rule<Workload>({
    id: 'pattern.vdi.horizon',
    kind: 'workload',
    verification: 'V-DOC',
    source: HORIZON_SOURCE,
    applies: (w, ctx) => patternOf(w, ctx) === 'horizon',
    evaluate: (w, o, ctx) => {
      if (o.platform === 'vmware') return { delta: 2, reason: 'Omnissa Horizon is supported on VMware Cloud Foundation.' };
      if ((o.platform === 'azure' || o.platform === 'google') && ctx.placementOf(w).disposition === 'relocate') {
        return { delta: 2, reason: `Omnissa Horizon is supported on ${o.platform === 'azure' ? 'Azure VMware Solution (KB 80850)' : 'Google Cloud VMware Engine (KB 81922)'}.` };
      }
      return undefined;
    },
  }),
  rule<Workload>({
    id: 'pattern.vdi.broker',
    kind: 'workload',
    verification: 'C',
    source: `${WORKSPACES_CORE} ; ${CITRIX_DAAS}`,
    applies: (w, ctx) => {
      const p = patternOf(w, ctx);
      return (p === 'citrix-vad' || p === 'horizon') && answersOf(w, ctx)['keepBroker'] === 'yes';
    },
    review: (w, chosen, ctx) => {
      const p = patternOf(w, ctx);
      const out = [];
      if (chosen?.platform === 'aws') out.push(info('pattern.vdi.workspaces-core', `${w.name}: keeping the ${p === 'horizon' ? 'Horizon' : 'Citrix'} broker on AWS points to Amazon WorkSpaces Core (report-only).`, { source: WORKSPACES_CORE }));
      if (p === 'citrix-vad') out.push(info('pattern.vdi.citrix-daas', `${w.name}: Citrix DaaS is an alternative to running the Citrix infrastructure yourself (report-only).`, { source: CITRIX_DAAS }));
      return out;
    },
  }),
];
