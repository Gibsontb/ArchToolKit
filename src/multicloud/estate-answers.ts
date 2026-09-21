/**
 * What the imported estate can answer in the decision wizard.
 *
 * The wizard asks forty-odd questions. An estate answers some of them outright
 * — it is a migration, from on-premises VMware, of VM-centric workloads, of
 * this much data, across these environments — and informs others with facts
 * the wizard never asks for: how many VMs cannot be moved by replication at
 * all, how much of the storage is raw LUNs, how many run an operating system
 * the clouds no longer support. Those facts go into the free-text description,
 * where the recommendation carries them into its output.
 *
 * What it cannot answer it leaves alone: criticality, uptime targets, data
 * sensitivity, deadlines. `profileFromInventory` says the same thing for the
 * decision matrix; this reuses its counts.
 */

import { info, type Finding } from '../core/findings.ts';
import { computeTotals, isWorkload, type Inventory } from '../vmware/inventory.ts';
import { assessMoves } from '../vmware/vm-readiness.ts';
import { profileFromInventory } from './from-inventory.ts';

export interface EstateFacts {
  readonly vms: number;
  readonly poweredOn: number;
  readonly windows: number;
  readonly linux: number;
  readonly vcpu: number;
  readonly ramGib: number;
  readonly usedGib: number;
  readonly rdmGib: number;
  readonly cloudBlocked: number;
  readonly cloudCautions: number;
  readonly unsupportedOs: number;
  readonly srmProtected: number;
  readonly environments: readonly string[];
}

export interface EstateAnswers {
  /** Wizard field id to value; a list for checkbox groups. */
  readonly answers: Readonly<Record<string, string | readonly string[]>>;
  readonly facts: EstateFacts;
  readonly findings: readonly Finding[];
}

const ENVIRONMENTS: readonly [string, RegExp][] = [
  ['prod', /(^|[^a-z])(prd|prod|production)([^a-z]|$)/i],
  ['dev', /(^|[^a-z])(dev|development|tdv)([^a-z]|$)/i],
  ['test', /(^|[^a-z])(tst|test|qa|uat|tdv)([^a-z]|$)/i],
  ['stage', /(^|[^a-z])(stg|stage|staging|preprod|pre-prod)([^a-z]|$)/i],
  ['dr', /(^|[^a-z])(dr|drt|recovery)([^a-z]|$)/i],
];

function band(gib: number): string {
  if (gib < 100) return 'xs';
  if (gib < 1024) return 's';
  if (gib < 5 * 1024) return 'm';
  if (gib < 20 * 1024) return 'l';
  return 'xl';
}

/** The part of the estate in scope: one cluster, or all of it. */
export function scopeInventory(inventory: Inventory, cluster?: string): Inventory {
  if (!cluster) return inventory;
  return {
    ...inventory,
    vms: inventory.vms.filter((v) => v.cluster === cluster),
    hosts: inventory.hosts.filter((h) => h.cluster === cluster),
    clusters: inventory.clusters.filter((c) => c.name === cluster),
  };
}

export function answersFromEstate(inventory: Inventory, cluster?: string): EstateAnswers {
  const scoped = scopeInventory(inventory, cluster);
  const totals = computeTotals(scoped);
  const moves = assessMoves(scoped, 'cloud');
  const profile = profileFromInventory(
    { ...scoped, vms: scoped.vms.filter(isWorkload) },
    { disposition: 'rehost', ...(cluster ? { clusters: [cluster] } : {}) },
  );
  const count = (id: string) => moves.byCheck.find((c) => c.check.id === id)?.count ?? 0;

  const names = [
    ...new Set([
      ...scoped.vms.filter(isWorkload).map((v) => `${v.cluster ?? ''} ${v.datacenter ?? ''} ${v.folder ?? ''}`),
      ...scoped.hosts.map((h) => `${h.cluster ?? ''} ${h.datacenter ?? ''}`),
    ]),
  ].join(' | ');
  const environments = ENVIRONMENTS.filter(([, re]) => re.test(names)).map(([env]) => env);

  const facts: EstateFacts = {
    vms: totals.vmCount,
    poweredOn: totals.poweredOnVmCount,
    windows: profile.evidence.windows,
    linux: profile.evidence.linux,
    vcpu: totals.allocatedVcpu,
    ramGib: totals.allocatedMemoryGib,
    usedGib: totals.usedStorageGib,
    rdmGib: totals.rdmGib,
    cloudBlocked: moves.blocked,
    cloudCautions: moves.withCautions,
    unsupportedOs: count('unsupported-os'),
    srmProtected: count('srm-protected'),
    environments,
  };

  const tib = (g: number) => `${(g / 1024).toFixed(1)} TiB`;
  const lines = [
    `Imported estate${cluster ? `, cluster ${cluster}` : ''}: ${facts.vms} VMs (${facts.poweredOn} running; ${facts.windows} Windows, ${facts.linux} Linux).`,
    `Running allocation ${Math.round(facts.vcpu)} vCPU and ${Math.round(facts.ramGib)} GiB memory; ${tib(facts.usedGib)} consumed VMDK storage${facts.rdmGib > 0 ? ` plus ${tib(facts.rdmGib)} on raw device mappings` : ''}.`,
    `Moving to a cloud by replication: ${facts.cloudBlocked} VM(s) blocked (RDMs, shared disks, passthrough), ${facts.cloudCautions} need changes first; ${facts.unsupportedOs} run an OS past vendor support.`,
    ...(facts.srmProtected > 0 ? [`${facts.srmProtected} VM(s) are protected by SRM today, so DR has to be replanned on the target.`] : []),
  ];

  const answers: Record<string, string | readonly string[]> = {
    initiativeType: 'migration',
    workloadName: cluster ?? inventory.source.label ?? 'Imported estate',
    architectureType: 'legacy-vm',
    teamSkills: 'vms',
    sourceEnv: 'onprem-vmware',
    // A large share of VMs that replication cannot carry points at running the
    // estate as VMware on the cloud instead.
    migrationApproach: facts.vms > 0 && (facts.cloudBlocked / facts.vms > 0.05 || facts.rdmGib > facts.usedGib * 0.1) ? 'relocate' : 'rehost',
    dataVolumeBand: band(facts.usedGib + facts.rdmGib),
    description: lines.join(' '),
    ...(environments.length > 0 ? { envScope: environments } : {}),
    ...(facts.srmProtected > 0 || environments.includes('dr') ? { regionCount: '2' } : {}),
  };

  const findings: Finding[] = [
    ...profile.findings,
    info(
      'multicloud.estate.answered',
      `Answered ${Object.keys(answers).length} questions from the estate. Criticality, uptime, data sensitivity and deadlines are for you.`,
      { source: 'ArchToolKit' },
    ),
  ];
  return { answers, facts, findings };
}
