/**
 * The kit's manifest: every in-scope item with its path, its source and its
 * target (`manifest/items.json`, and `manifest/items.tsv` for the bash
 * library, which reads it without jq), and the waves (`manifest/waves.json`).
 *
 * Built from the plan, the decision, the target design, the waves and the
 * path resolutions. Items are sorted by wave, kind and name, so the files are
 * byte-for-byte reproducible; nothing about the machine or the user that
 * generated them is written.
 */

import { itemId } from '../options.ts';
import type {
  ComputeTarget, Criticality, DbEngine, DbServiceId, DbTarget, DbVersionId, DnsProvider, ExecutionMethod, FreezeWindow, GateId, ImageRef,
  ItemId, ItemState, LbKind, OsId, Plan, PlanDecision, Platform, PlatformDesign, SmokeKind, SourcePlatform, TargetDesign, Tracker,
  WaveKind, WavePlan,
} from '../types.ts';
import { planId8, resourceName, type ExecPath } from './contract.ts';
import type { ExecTarget } from './matrix.ts';
import type { PathResolution } from './paths.ts';
import { MANIFEST_KIND } from './schema.ts';

export interface ManifestSource {
  readonly platform: SourcePlatform;
  readonly manager?: string;
  readonly id?: string;
  readonly host?: string;
  readonly cluster?: string;
  readonly region?: string;
  /** Physical: the Redfish address (never credentials). */
  readonly bmc?: string;
  readonly ips?: readonly string[];
  readonly powerState?: string;
}
export interface ManifestTarget {
  readonly platform?: Platform;
  readonly exec?: ExecTarget;
  readonly region?: string;
  readonly size?: string;
  readonly vcpu?: number;
  readonly ramGib?: number;
  readonly disks?: readonly { readonly gib: number; readonly type: string }[];
  readonly network?: string;
  readonly tier?: string;
  readonly zone?: string;
  readonly image?: string;
  readonly service?: DbServiceId;
  readonly classOrShape?: string;
  readonly engineVersion?: string;
}
export interface ManifestDns { readonly fqdn: string; readonly zone?: string; readonly provider?: DnsProvider; readonly private?: boolean }
export interface ManifestLb { readonly kind: LbKind; readonly pool: string; readonly port: number }
export interface ManifestCheck { readonly kind: SmokeKind; readonly target: string; readonly expect?: string; readonly maxMs?: number }
export interface ManifestItem {
  readonly id: ItemId;
  readonly name: string;
  readonly kind: 'workload' | 'database';
  readonly app: string;
  readonly wave: number | null;
  readonly moveGroup?: string;
  readonly path: ExecPath;
  readonly method: ExecutionMethod;
  /** The script implementing the verbs for this item's path, relative to migration/execute/ (set by the kit). */
  readonly script?: string;
  /** `atk-<plan8>-<wave>-<slug>`: the name of anything created for it. */
  readonly resource: string;
  readonly criticality?: Criticality;
  readonly os?: OsId;
  readonly engine?: DbEngine;
  readonly version?: DbVersionId;
  /** Databases: the item ids of their host servers. */
  readonly hosts?: readonly ItemId[];
  readonly source: ManifestSource;
  readonly target: ManifestTarget;
  readonly dns: readonly ManifestDns[];
  readonly lb: readonly ManifestLb[];
  readonly services: readonly string[];
  readonly checks: readonly ManifestCheck[];
  /** The tracker's state when the kit was generated (informative: the scripts read live state). */
  readonly state?: ItemState;
}
export interface ManifestWave {
  readonly n: number;
  readonly name?: string;
  readonly kind?: WaveKind;
  readonly start?: string;
  readonly end?: string;
  readonly groups: readonly { readonly id: string; readonly name?: string; readonly items: readonly ItemId[] }[];
  /** The in-scope items of the wave (those with a path), in run order. */
  readonly items: readonly ItemId[];
  readonly gates: readonly GateId[];
  readonly freeze: readonly FreezeWindow[];
}
export interface Manifest {
  readonly kind: typeof MANIFEST_KIND;
  readonly v: 1;
  readonly planId: string;
  readonly planId8: string;
  readonly items: readonly ManifestItem[];
  readonly waves: readonly ManifestWave[];
}

const DEFAULT_GATES: readonly GateId[] = ['G1', 'G2', 'G3', 'G4'];

export function imageText(ref: ImageRef): string {
  switch (ref.kind) {
    case 'aws-ssm': return `aws-ssm:${ref.parameter}`;
    case 'aws-ami-filter': return `aws-ami:${ref.owner}/${ref.namePattern}`;
    case 'azure-marketplace': return `azure:${ref.publisher}:${ref.offer}:${ref.sku}`;
    case 'gcp-family': return `gcp:${ref.project}/${ref.family}`;
    case 'oci-platform': return `oci:${ref.operatingSystem} ${ref.version}`;
    case 'vsphere-template': return `vsphere:${ref.template}`;
    case 'replicated': return 'replicated';
    case 'custom': return `var:${ref.variable}`;
  }
}

function waveOfItem(waves: WavePlan): (id: ItemId) => { wave: number | null; group?: string } {
  const by = new Map<ItemId, { wave: number; group: string }>();
  for (const g of waves.groups) for (const id of g.items) if (!by.has(id)) by.set(id, { wave: g.wave, group: g.id });
  return (id) => {
    const hit = by.get(id);
    return hit ? { wave: hit.wave, group: hit.group } : { wave: null };
  };
}

function computeOf(design: TargetDesign, platform: Platform | undefined, id: ItemId): { pd?: PlatformDesign; c?: ComputeTarget } {
  const pd = design.platforms.find((p) => p.platform === platform);
  return { ...(pd ? { pd } : {}), ...(pd ? { c: pd.compute.find((c) => c.workload === id) } : {}) };
}
function dbTargetOf(design: TargetDesign, platform: Platform | undefined, id: ItemId): { pd?: PlatformDesign; t?: DbTarget } {
  const pd = design.platforms.find((p) => p.platform === platform);
  return { ...(pd ? { pd } : {}), ...(pd ? { t: pd.databases.find((d) => d.database === id) } : {}) };
}

const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/**
 * The manifest for the resolved items. Items with no path (retained, or
 * without a target) are left out.
 */
export function buildManifest(
  plan: Plan,
  decision: PlanDecision,
  design: TargetDesign,
  waves: WavePlan,
  resolutions: readonly PathResolution<ExecPath>[],
  tracker?: Tracker,
): Manifest {
  const waveOf = waveOfItem(waves);
  const exec = plan.execution;
  const domain = plan.requirements.identity.domain?.trim().toLowerCase();
  const zones = [...(exec?.dnsZones ?? [])].sort((a, b) => b.zone.length - a.zone.length);
  const byId = new Map(resolutions.map((r) => [r.item, r]));
  const items: ManifestItem[] = [];
  const appId = (name: string): string | undefined => plan.apps.find((a) => a.name === name)?.id;
  const checksFor = (app: string): ManifestCheck[] => {
    const id = appId(app) ?? itemId('app', app);
    const ap = (plan.appPlans ?? []).find((p) => p.app === id);
    return (ap?.smoke ?? []).map((s) => clean({ kind: s.kind, target: s.target, expect: s.expect, maxMs: s.maxMs }));
  };
  const lbsFor = (app: string): ManifestLb[] =>
    (exec?.lbs ?? []).filter((l) => l.app === app && l.kind !== 'none').map((l) => ({ kind: l.kind, pool: l.pool, port: l.port }));

  for (const w of plan.workloads) {
    const r = byId.get(w.id);
    if (!r?.path || r.kind !== 'workload') continue;
    const d = decision.items[w.id];
    const platform = d?.chosen?.platform;
    const { pd, c } = computeOf(design, platform, w.id);
    const { wave, group } = waveOf(w.id);
    const ref = w.sourceRef;
    const fqdn = domain ? `${w.name.toLowerCase()}.${domain}` : undefined;
    const zone = fqdn ? zones.find((z) => fqdn.endsWith(`.${z.zone.toLowerCase()}`)) : undefined;
    const checks = [
      ...checksFor(w.app),
      ...(w.facts?.listening ?? []).filter((l) => l.proto === 'tcp').slice(0, 5).map((l) => ({ kind: 'tcp' as const, target: `${w.name}:${l.port}` })),
    ];
    items.push(clean({
      id: w.id, name: w.name, kind: 'workload' as const, app: w.app, wave, moveGroup: group ?? w.moveGroup,
      path: r.path, method: r.method!, resource: resourceName(plan.id, wave, w.name),
      criticality: w.criticality, os: w.os,
      source: clean({
        platform: r.source ?? 'vsphere', manager: ref?.manager, id: ref?.id, host: ref?.host, cluster: ref?.cluster, region: ref?.region,
        bmc: ref?.bmc, ips: w.facts?.ipAddresses, powerState: w.facts?.powerState,
      }),
      target: clean({
        platform, exec: r.target, region: pd?.region, size: c?.size, vcpu: c?.vcpu, ramGib: c?.ramGib, disks: c?.disks, network: c?.network,
        tier: c?.tier, zone: c?.zone, image: c ? imageText(c.image) : undefined,
      }),
      dns: fqdn ? [clean({ fqdn, zone: zone?.zone, provider: zone?.provider, private: zone?.private })] : [],
      lb: lbsFor(w.app),
      services: w.facts?.services ?? [],
      checks,
      state: tracker?.items[w.id]?.state,
    }) as ManifestItem);
  }
  for (const db of plan.databases) {
    const r = byId.get(db.id);
    if (!r?.path || r.kind !== 'database') continue;
    const d = decision.items[db.id];
    const platform = d?.chosen?.platform;
    const { pd, t } = dbTargetOf(design, platform, db.id);
    const { wave, group } = waveOf(db.id);
    const hosts = plan.workloads.filter((w) => db.hosts.includes(w.name));
    const hostRef = hosts[0]?.sourceRef;
    items.push(clean({
      id: db.id, name: db.name, kind: 'database' as const, app: db.app, wave, moveGroup: group ?? db.moveGroup,
      path: r.path, method: r.method!, resource: resourceName(plan.id, wave, db.name),
      engine: db.engine, version: db.version, hosts: hosts.map((h) => h.id),
      source: clean({ platform: hosts[0] ? (hosts[0].origin ?? hostRef?.platform ?? 'vsphere') : 'vsphere', host: hosts[0]?.name, cluster: hostRef?.cluster }),
      target: clean({ platform, region: pd?.region, service: t?.service ?? r.service, classOrShape: t?.classOrShape, engineVersion: t?.engineVersion }),
      dns: [],
      lb: [],
      services: [],
      checks: checksFor(db.app).filter((c) => c.kind === 'sql'),
      state: tracker?.items[db.id]?.state,
    }) as ManifestItem);
  }
  const rank = (w: number | null): number => (w === null ? Number.MAX_SAFE_INTEGER : w);
  items.sort((a, b) => rank(a.wave) - rank(b.wave) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  const inScope = new Set(items.map((i) => i.id));
  const groupsById = new Map(waves.groups.map((g) => [g.id, g]));
  const manifestWaves: ManifestWave[] = [...waves.waves].sort((a, b) => a.n - b.n).map((wv) => {
    const groups = wv.groups.map((id) => groupsById.get(id)).filter((g) => !!g).map((g) => clean({ id: g!.id, name: g!.name, items: g!.items.filter((i) => inScope.has(i)) }));
    const freeze = wv.start && wv.end ? waves.settings.freezes.filter((f) => f.from <= wv.end! && f.to >= wv.start!) : [];
    return {
      n: wv.n,
      ...(wv.name ? { name: wv.name } : {}),
      ...(wv.kind ? { kind: wv.kind } : {}),
      ...(wv.start ? { start: wv.start } : {}),
      ...(wv.end ? { end: wv.end } : {}),
      groups,
      items: groups.flatMap((g) => g.items),
      gates: wv.gates ?? DEFAULT_GATES,
      freeze,
    };
  });
  return { kind: MANIFEST_KIND, v: 1, planId: plan.id, planId8: planId8(plan.id), items, waves: manifestWaves };
}

export function renderItemsJson(m: Manifest): string {
  const { waves: _waves, ...rest } = m;
  return `${JSON.stringify(rest, null, 2)}\n`;
}

export function renderWavesJson(m: Manifest): string {
  return `${JSON.stringify({ kind: 'archtoolkit.migration-waves', v: 1, planId: m.planId, waves: m.waves }, null, 2)}\n`;
}

/** The TSV columns `lib/atk.sh` reads (a `-` stands for an empty value). */
export const TSV_COLUMNS = Object.freeze(['id', 'name', 'kind', 'app', 'wave', 'path', 'script', 'resource', 'source', 'target'] as const);

const cell = (v: string | number | null | undefined): string => {
  const s = v === null || v === undefined ? '' : String(v);
  const t = s.replace(/[\t\r\n]+/g, ' ').trim();
  return t || '-';
};

export function renderItemsTsv(m: Manifest): string {
  const lines = [
    `#plan\t${cell(m.planId)}\t${m.planId8}`,
    `#${TSV_COLUMNS.join('\t')}`,
    ...m.items.map((i) => [
      i.id, i.name, i.kind, i.app, i.wave, i.path, i.script, i.resource, i.source.platform,
      [i.target.platform, i.target.region].filter(Boolean).join(':'),
    ].map(cell).join('\t')),
  ];
  return `${lines.join('\n')}\n`;
}
