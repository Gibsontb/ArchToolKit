/**
 * Compute: each workload that moves by replication or rebuild becomes a
 * `ComputeTarget` on its platform: size, image, disks, network, tier, zone,
 * licence handling and backup tier.
 *
 * - **Size** from `rightsizeFor`, from allocated or active memory
 *   (Requirements.sizeBy). Hosts of an Oracle or SQL Server database that is
 *   BYOL on IaaS are licence-optimised: the smallest memory-optimised type with
 *   the memory, and ceil(vCPU / 2) active cores (AWS `cpu_options`, Azure a
 *   constrained-vCPU size, Google `visible_core_count`, OCI exact OCPUs).
 * - **Tier** from the role; **network** from the environment.
 * - **Zone** round-robin across the network's zones per app, starting at a
 *   stable offset per app, so an app's members spread and single-VM apps do
 *   not all land in the first zone. Hosts of one database are then forced
 *   into different zones (domain controllers are placed by identity.ts).
 * - **Disks** per the platform table (section 2.6.1), boot first.
 * - **Image** from `imageFor`, or `replicated` when the replication tool
 *   brings the disk.
 */

import { info, warning, type Finding } from '../../../core/findings.ts';
import { rightsizeFor, AZURE_CONSTRAINED_LADDER, type RehostCloud, type RightsizeFit } from '../../../kit/rightsize.ts';
import {
  AWS_INSTANCE_TYPE_GROUPS, AZURE_VM_SIZE_GROUPS, GCP_MACHINE_TYPE_GROUPS, OCI_SHAPE_GROUPS, type GroupedValues,
} from '../../../kit/sizes-data.ts';
import { VM_SERVICE } from '../db-catalog.ts';
import { imageFor, isUnavailable } from '../images.ts';
import { licenceNeed } from '../licensing-facts.ts';
import { BACKUP_TIER_BY_CRITICALITY, overrideKey } from '../options.ts';
import { osKind } from '../os.ts';
import type {
  ComputeTarget, Criticality, Database, DbServiceId, ImageRef, LicenceNeed, NetworkDesign, NetworkTier, Platform,
  PlatformDesign, Role, Workload,
} from '../types.ts';
import type { DesignContext, DesignMapper } from './index.ts';
import { networkForEnv, networkZones } from './network.ts';

// ---------------------------------------------------------------------------
// Tier
// ---------------------------------------------------------------------------

const TIER_BY_ROLE: Readonly<Record<Role, NetworkTier>> = {
  web: 'web',
  app: 'app',
  middleware: 'app',
  messaging: 'app',
  batch: 'app',
  db: 'db',
  'ad-dc': 'mgmt',
  'dns-dhcp': 'mgmt',
  jump: 'mgmt',
  monitoring: 'mgmt',
  backup: 'mgmt',
  file: 'app',
  'rds-vdi': 'app',
  appliance: 'app',
  other: 'app',
};
export const tierForRole = (role: Role): NetworkTier => TIER_BY_ROLE[role];

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

const catalog = (groups: GroupedValues): ReadonlySet<string> => new Set(Object.values(groups).flatMap((v) => v.split(',')));
const CATALOG: Readonly<Record<Exclude<Platform, 'vmware'>, ReadonlySet<string>>> = {
  aws: catalog(AWS_INSTANCE_TYPE_GROUPS),
  azure: catalog(AZURE_VM_SIZE_GROUPS),
  google: catalog(GCP_MACHINE_TYPE_GROUPS),
  oci: catalog(OCI_SHAPE_GROUPS),
};

/**
 * Is `size` one the platform sells: in the machine catalog (`sizes-data.ts`),
 * or, on Azure, a constrained-vCPU size of a catalogued parent. vSphere has no
 * catalog (any vCPU and memory), so every size is accepted there.
 */
export function sizeInCatalog(platform: Platform, size: string): boolean {
  if (platform === 'vmware') return size.trim() !== '';
  if (CATALOG[platform].has(size)) return true;
  if (platform === 'azure') {
    const c = AZURE_CONSTRAINED_LADDER.find((x) => x.name === size);
    return !!c && CATALOG.azure.has(c.parent);
  }
  return false;
}

/** vSphere sizes are free-form: written as `<vCPU>x<GiB>GiB`. */
export const vsphereSize = (vcpu: number, ramGib: number): string => `${vcpu}x${ramGib}GiB`;

// ---------------------------------------------------------------------------
// Disks
// ---------------------------------------------------------------------------

/** Minimum boot disk per platform and OS kind, GiB (the images' own sizes; OCI's boot volume floor is 50 GB). */
const BOOT_MIN: Readonly<Record<Platform, { readonly windows: number; readonly linux: number }>> = {
  aws: { windows: 30, linux: 8 },
  azure: { windows: 128, linux: 30 },
  google: { windows: 50, linux: 10 },
  oci: { windows: 256, linux: 50 },
  vmware: { windows: 1, linux: 1 },
};
const BOOT_DEFAULT = { windows: 128, linux: 64 } as const;

/** Default vSphere storage policy; the design card's `vmware:lz:storage-policy` overrides it. */
export const DEFAULT_VSPHERE_POLICY = 'vSAN Default Storage Policy';

/**
 * The disk types (section 2.6.1): boot, data, and data on the db tier.
 * AWS io2 and Azure Premium SSD v2 only for tier0 / tier1 databases; Premium
 * SSD v2 needs a zone, which every Azure target here has.
 */
export function diskTypes(platform: Platform, tier: NetworkTier, criticality: Criticality, zoned: boolean, vspherePolicy = DEFAULT_VSPHERE_POLICY): { boot: string; data: string } {
  const top = criticality === 'tier0' || criticality === 'tier1';
  const db = tier === 'db';
  switch (platform) {
    case 'aws':
      return { boot: 'gp3', data: db && top ? 'io2' : 'gp3' };
    case 'azure':
      return { boot: 'Premium_LRS', data: db && top && zoned ? 'PremiumV2_LRS' : 'Premium_LRS' };
    case 'google':
      return { boot: 'pd-balanced', data: db ? 'pd-ssd' : 'pd-balanced' };
    case 'oci':
      // Balanced is vpus_per_gb 10; Higher Performance is 20.
      return { boot: 'balanced', data: db ? 'higher-performance' : 'balanced' };
    default:
      return { boot: vspherePolicy, data: vspherePolicy };
  }
}

function disksFor(w: Workload, platform: Platform, tier: NetworkTier, zoned: boolean, policy?: string): { gib: number; type: string }[] {
  const kind = osKind(w.os) === 'windows' ? 'windows' : 'linux';
  const types = diskTypes(platform, tier, w.criticality, zoned, policy);
  const [boot = BOOT_DEFAULT[kind], ...data] = w.disksGib;
  return [
    { gib: Math.max(Math.ceil(boot), BOOT_MIN[platform][kind]), type: types.boot },
    ...data.filter((g) => g > 0).map((g) => ({ gib: Math.ceil(g), type: types.data })),
  ];
}

// ---------------------------------------------------------------------------
// Licence handling
// ---------------------------------------------------------------------------

/** The compute grid's Licence column. */
export type LicenceHandlingKey = 'li' | 'ahb' | 'dedicated-host' | 'byol-image' | 'rhel-byos' | 'sles-byos';

/** The text shown, and written as the tag, per key and platform. `licenceKeyOf` reverses it. */
export const LICENCE_HANDLING_TEXT: Readonly<Record<LicenceHandlingKey, Readonly<Record<Platform, string>>>> = {
  li: { aws: 'LI', azure: 'LI', google: 'LI', oci: 'LI', vmware: 'LI' },
  ahb: {
    aws: 'AHB', google: 'AHB', oci: 'AHB', vmware: 'AHB',
    azure: 'AHB (license_type = Windows_Server)',
  },
  'dedicated-host': {
    aws: 'Dedicated host (BYOL pre-2019)',
    azure: 'Dedicated host (BYOL)',
    google: 'Sole-tenant node (BYOL pre-2019)',
    oci: 'Dedicated host (BYOL)',
    vmware: 'BYOL (licensed on your hosts)',
  },
  'byol-image': {
    aws: 'BYOL (imported image)',
    azure: 'BYOL (imported image)',
    google: 'BYOL (imported image)',
    oci: 'BYOL (imported image, Flexible Virtualization Benefit)',
    vmware: 'BYOL (licensed on your hosts)',
  },
  'rhel-byos': {
    aws: 'RHEL BYOS (Red Hat Cloud Access image)',
    azure: 'RHEL_BYOS (license_type)',
    google: 'RHEL BYOS (Red Hat Cloud Access image)',
    oci: 'RHEL BYOS (imported image)',
    vmware: 'RHEL subscription (your own)',
  },
  'sles-byos': {
    aws: 'SLES BYOS (SUSE image)',
    azure: 'SLES_BYOS (license_type)',
    google: 'SLES BYOS (SUSE image)',
    oci: 'SLES BYOS (imported image)',
    vmware: 'SLES subscription (your own)',
  },
};

/** The Licence column's key for a target's text (the reverse of LICENCE_HANDLING_TEXT). */
export function licenceKeyOf(target: Pick<ComputeTarget, 'licenceHandling'>, platform: Platform): LicenceHandlingKey {
  for (const key of Object.keys(LICENCE_HANDLING_TEXT) as LicenceHandlingKey[]) {
    if (LICENCE_HANDLING_TEXT[key][platform] === target.licenceHandling) return key;
  }
  return 'li';
}

function licenceKey(w: Workload, platform: Platform, need: LicenceNeed): LicenceHandlingKey {
  if (need.kind === 'windows-core') {
    if (need.model === 'ahb') return 'ahb';
    if (need.model === 'dedicated-host') return 'dedicated-host';
    if (need.model === 'fvb' || need.model === 'byol' || need.model === 'licence-mobility') return platform === 'vmware' ? 'dedicated-host' : 'byol-image';
    return 'li';
  }
  if (need.kind === 'rhel' && need.model === 'byol') return 'rhel-byos';
  if (need.kind === 'sles' && need.model === 'byol') return 'sles-byos';
  return w.licence === 'rhel-byos' && w.os.startsWith('rhel-') ? 'rhel-byos' : w.licence === 'sles-byos' && w.os.startsWith('sles-') ? 'sles-byos' : 'li';
}

// ---------------------------------------------------------------------------
// Licence-optimised hosts
// ---------------------------------------------------------------------------

/** The IaaS database services: the database runs on compute targets. */
export const IAAS_DB_SERVICES: readonly DbServiceId[] = Object.freeze(['aws-ec2', 'azure-vm', 'azure-sqlvm', 'google-gce', 'oci-compute', 'vmware-vm']);
export const isIaasService = (s: DbServiceId | undefined): boolean => !!s && IAAS_DB_SERVICES.includes(s);

/** Oracle (not XE) or SQL Server (paid edition) on a licence the customer brings: per-core licensing makes fewer cores cheaper. */
export function isPerCoreByol(db: Database): boolean {
  if (db.engine === 'oracle') return db.edition !== 'oracle-xe' && db.licence !== 'li';
  if (db.engine === 'sqlserver') {
    return (db.licence === 'byol-sa' || db.licence === 'byol-perpetual') && db.edition !== 'sql-express' && db.edition !== 'sql-developer';
  }
  return false;
}

/** The workloads (by name) hosting a per-core BYOL database on IaaS on this platform. */
export function licenceOptimisedHosts(ctx: DesignContext): Set<string> {
  const names = new Set<string>();
  for (const db of ctx.databases) {
    const service = ctx.decisionOf(db.id)?.chosen?.service ?? VM_SERVICE[ctx.platform];
    if (isIaasService(service) && isPerCoreByol(db)) for (const h of db.hosts) names.add(h);
  }
  return names;
}

// ---------------------------------------------------------------------------
// One target
// ---------------------------------------------------------------------------

export interface TargetOptions {
  readonly network: NetworkDesign;
  readonly zone: string;
  readonly licenceOptimised?: boolean;
  /** Replicated by the migration tool (the tool brings the disk). */
  readonly replicate?: boolean;
}

const REPLICATION_TOOL: Readonly<Record<Platform, string>> = {
  aws: 'AWS Application Migration Service (MGN)',
  azure: 'Azure Migrate',
  google: 'Migrate to Virtual Machines',
  oci: 'Oracle Cloud Migrations',
  vmware: 'HCX / vSphere Replication',
};

/** BYOS Linux on AWS / Google needs the vendor's BYOS image (Red Hat Cloud Access gold images, SUSE BYOS), not the PAYG one. */
function byosImage(w: Workload, platform: Platform, key: LicenceHandlingKey): ImageRef | undefined {
  if ((key !== 'rhel-byos' && key !== 'sles-byos') || (platform !== 'aws' && platform !== 'google')) return undefined;
  return {
    kind: 'custom',
    variable: `image_byos_${w.os.replace(/[^a-z0-9]+/g, '_')}`,
    note: key === 'rhel-byos'
      ? 'RHEL BYOS: enable Red Hat Cloud Access and give the gold image shared to your account (the pay-as-you-go image would bill the subscription twice).'
      : 'SLES BYOS: give the SUSE BYOS image (the pay-as-you-go image would bill the subscription twice).',
  };
}

/**
 * The target for one workload. Pure: the caller chooses network and zone.
 * Returns findings for what could not be sized or imaged.
 */
export function computeTargetFor(ctx: DesignContext, w: Workload, o: TargetOptions): { target: ComputeTarget; findings: Finding[] } {
  const findings: Finding[] = [];
  const { platform, plan } = ctx;
  const tier = tierForRole(w.role);
  const req = plan.requirements;
  const active = req.sizeBy === 'active-memory' && (w.facts?.activeMemoryGib ?? 0) > 0;
  const ram = active ? w.facts!.activeMemoryGib! : w.ramGib;

  let fit: RightsizeFit | null;
  if (platform === 'vmware') {
    const r = active ? Math.max(2, Math.ceil(ram * 1.2)) : Math.ceil(ram);
    fit = { type: vsphereSize(Math.max(1, Math.ceil(w.vcpu)), r), vcpu: Math.max(1, Math.ceil(w.vcpu)), ramGib: r };
  } else {
    fit = rightsizeFor(platform as RehostCloud, w.vcpu, ram, { memoryBasis: active ? 'active' : 'allocated', licenceOptimised: !!o.licenceOptimised });
    if (!fit) {
      findings.push(warning('design.compute.no-size', `${w.name}: no ${platform} type in the ladder has ${w.vcpu} vCPU and ${w.ramGib} GiB; pick one by hand.`, {
        path: overrideKey('compute', w.id, 'size'),
        remediation: 'Set an override size from the catalog, or split the workload.',
      }));
    }
  }

  const decided = ctx.decisionOf(w.id)?.chosen;
  const need = decided?.platform === platform && decided.licence
    ? decided.licence
    : licenceNeed(w, platform, undefined, { licensing: req.licensing, ...(fit?.ocpus ? { ocpus: fit.ocpus } : {}) });
  const key = licenceKey(w, platform, need);

  let image: ImageRef;
  if (o.replicate) {
    image = { kind: 'replicated', note: `${REPLICATION_TOOL[platform]} brings the disk; the instance is adopted at cutover.` };
  } else {
    const byos = byosImage(w, platform, key);
    // A BYOL image only where the licence is actually brought; a stranded licence runs on the LI image.
    const brought = key === 'dedicated-host' || key === 'byol-image';
    const entry = byos ?? imageFor(w.os, platform, { licence: brought ? w.licence : 'li' });
    if (isUnavailable(entry)) {
      image = { kind: 'custom', variable: `image_${w.os.replace(/[^a-z0-9]+/g, '_')}`, note: entry.unavailable };
      findings.push(warning('design.compute.no-image', `${w.name}: ${entry.unavailable}`, {
        path: overrideKey('compute', w.id, 'image'),
        remediation: 'Give a custom image in the variable, replicate the workload instead, or upgrade the OS first.',
      }));
    } else {
      image = entry;
    }
  }

  const policy = plan.designOverrides[overrideKey('vmware', 'lz', 'storage-policy')]?.trim() || undefined;
  const dedicatedHost = key === 'dedicated-host' && (platform === 'aws' || platform === 'google');
  const target: ComputeTarget = {
    workload: w.id,
    size: fit?.type ?? '',
    vcpu: fit?.vcpu ?? w.vcpu,
    ramGib: fit?.ramGib ?? w.ramGib,
    ...(fit?.ocpus !== undefined ? { ocpus: fit.ocpus } : {}),
    ...(fit?.coreCount !== undefined ? { coreCount: fit.coreCount } : {}),
    image,
    disks: disksFor(w, platform, tier, o.zone !== '' && o.zone !== 'default', policy),
    network: o.network.name,
    tier,
    zone: o.zone,
    licenceHandling: LICENCE_HANDLING_TEXT[key][platform],
    backupTier: BACKUP_TIER_BY_CRITICALITY[w.criticality],
    ...(dedicatedHost ? { dedicatedHost: true } : {}),
  };
  if (fit?.constrained) {
    findings.push(info('design.compute.constrained-vcpu', `${w.name}: ${fit.type} runs ${fit.vcpu} active vCPU with ${fit.constrained}'s memory, to license ${fit.vcpu} vCPU; it is billed as ${fit.constrained}.`, {
      path: overrideKey('compute', w.id, 'size'),
      source: 'https://learn.microsoft.com/en-us/azure/virtual-machines/constrained-vcpu',
    }));
  }
  return { target, findings };
}

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit, for a stable per-app starting zone. */
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Find a design network by name, else the first. */
export function networkOf(design: PlatformDesign, name: string): NetworkDesign | undefined {
  return design.networks.find((n) => n.name === name) ?? design.networks[0];
}

/**
 * Put the named targets in different zones of their network, in the order
 * given. Returns the targets and a finding when there are fewer zones than
 * members.
 */
export function spreadAcrossZones(design: PlatformDesign, ids: readonly string[], what: string): { compute: ComputeTarget[]; findings: Finding[] } {
  const findings: Finding[] = [];
  const members = ids.map((id) => design.compute.find((c) => c.workload === id)).filter((c): c is ComputeTarget => !!c);
  const byId = new Map<string, string>();
  const perNetwork = new Map<string, ComputeTarget[]>();
  for (const m of members) perNetwork.set(m.network, [...(perNetwork.get(m.network) ?? []), m]);
  for (const [name, group] of perNetwork) {
    const zones = networkZones(networkOf(design, name)!);
    if (group.length > 1 && zones.length < 2) {
      findings.push(info('design.compute.ha-single-zone', `${what}: the ${name} network has one zone, so its ${group.length} members share it; spread them with an anti-affinity rule (placement group / availability set / fault domains).`));
    }
    group.forEach((m, i) => byId.set(m.workload, zones[i % zones.length] ?? m.zone));
  }
  return { compute: design.compute.map((c) => (byId.has(c.workload) ? { ...c, zone: byId.get(c.workload)! } : c)), findings };
}

// ---------------------------------------------------------------------------
// The mapper
// ---------------------------------------------------------------------------

export const computeMapper: DesignMapper = {
  id: 'compute',
  map(ctx, design) {
    const findings: Finding[] = [];
    const optimised = licenceOptimisedHosts(ctx);
    const counters = new Map<string, number>();
    const compute: ComputeTarget[] = [];
    for (const w of ctx.workloads) {
      const network = networkOf(design, networkForEnv(w.env));
      if (!network) {
        findings.push(warning('design.compute.no-network', `${w.name}: ${ctx.platform} has no network to place it in.`));
        continue;
      }
      const zones = networkZones(network);
      const key = `${network.name}\u0000${w.app}`;
      const n = counters.get(key) ?? 0;
      counters.set(key, n + 1);
      const zone = zones.length > 0 ? zones[(hash32(w.app) + n) % zones.length]! : '';
      const method = ctx.decisionOf(w.id)?.method;
      const r = computeTargetFor(ctx, w, { network, zone, licenceOptimised: optimised.has(w.name), replicate: method === 'replicate' });
      compute.push(r.target);
      findings.push(...r.findings);
    }

    // Hosts of one database go to different zones.
    let next: PlatformDesign = { ...design, compute };
    for (const db of ctx.databases) {
      const ids = db.hosts.map((h) => ctx.workloadByName(h)?.id).filter((id): id is string => !!id && compute.some((c) => c.workload === id));
      if (ids.length < 2) continue;
      const r = spreadAcrossZones(next, [...new Set(ids)].sort(), `Database ${db.name}'s hosts`);
      next = { ...next, compute: r.compute };
      findings.push(...r.findings);
    }
    return { design: next, findings };
  },
};
