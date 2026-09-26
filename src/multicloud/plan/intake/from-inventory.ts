/**
 * The VMware inventory (RVTools, PowerCLI, vCenter) as planner rows: one
 * workload per VM in scope, databases suggested from names and notes, and one
 * app row per app name. Facts the rules need later (power state, RDMs,
 * multi-writer disks, passthrough, firmware, addresses, the move checks) ride
 * along on `Workload.facts`.
 *
 * `scopeInventory` moved here from `multicloud/estate-answers.ts`, and
 * `movableDisks` is this module's own (terraform/estate.ts keeps a private
 * copy; neither imports the other).
 */

import { info, warning, type Finding } from '../../../core/findings.ts';
import { isWorkload, scopedKey, type Inventory, type InventoryVm, type VmDisk } from '../../../vmware/inventory.ts';
import { assessVm } from '../../../vmware/vm-readiness.ts';
import { classifyVm, guestOsRaw } from '../os.ts';
import { ENV_OPTIONS, optionValue } from '../options.ts';
import type { Env, IntakeSettings, WorkloadFacts } from '../types.ts';
import { intakeFromServers, isoDay, type IntakeAdapter, type IntakeResult, type ServerRecord } from './adapter.ts';

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/** A folder path without its leading slash, so '/DC1/Apps' and 'DC1/Apps' match. */
const folderPath = (f: string | undefined): string => (f ?? '').replace(/^\/+/, '').replace(/\/+$/, '');

/**
 * The part of the estate in scope. `scope` is '' (all of it), a cluster name,
 * or a folder prefix ('/DC1/Apps' takes '/DC1/Apps' and everything under it).
 * A cluster name wins when a folder has the same name.
 */
export function scopeInventory(inventory: Inventory, scope?: string): Inventory {
  const s = (scope ?? '').trim();
  if (!s) return inventory;
  if (inventory.vms.some((v) => v.cluster === s) || inventory.clusters.some((c) => c.name === s)) {
    return {
      ...inventory,
      vms: inventory.vms.filter((v) => v.cluster === s),
      hosts: inventory.hosts.filter((h) => h.cluster === s),
      clusters: inventory.clusters.filter((c) => c.name === s),
    };
  }
  const prefix = folderPath(s).toLowerCase();
  const vms = inventory.vms.filter((v) => {
    const f = folderPath(v.folder).toLowerCase();
    return f === prefix || f.startsWith(`${prefix}/`);
  });
  const clusters = new Set(vms.map((v) => v.cluster).filter((c): c is string => !!c));
  return {
    ...inventory,
    vms,
    hosts: inventory.hosts.filter((h) => h.cluster !== undefined && clusters.has(h.cluster)),
    clusters: inventory.clusters.filter((c) => clusters.has(c.name)),
  };
}

/** The Sources screen's scope choices: every cluster, then every folder prefix, sorted. */
export function scopeChoices(inventory: Inventory): { readonly clusters: string[]; readonly folders: string[] } {
  const clusters = new Set<string>();
  const folders = new Set<string>();
  for (const vm of inventory.vms) {
    if (!isWorkload(vm)) continue;
    if (vm.cluster) clusters.add(vm.cluster);
    const parts = folderPath(vm.folder).split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i += 1) folders.add(`/${parts.slice(0, i).join('/')}`);
  }
  return { clusters: [...clusters].sort(), folders: [...folders].sort() };
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

/** Every custom attribute key the estate's workloads carry, sorted. */
export function attributeKeys(inventory: Inventory): string[] {
  const keys = new Set<string>();
  for (const vm of inventory.vms) if (isWorkload(vm)) for (const k of Object.keys(vm.customAttributes ?? {})) keys.add(k);
  return [...keys].sort();
}

/**
 * The Sources screen's attribute defaults: the first key that looks like an
 * app, environment or owner, else the pseudo-attribute ('folder-leaf',
 * 'name-pattern') or blank.
 */
export function defaultAttributes(inventory: Inventory): { readonly appAttribute: string; readonly envAttribute: string; readonly ownerAttribute: string } {
  const keys = attributeKeys(inventory);
  return {
    appAttribute: keys.find((k) => /app|application|service/i.test(k)) ?? 'folder-leaf',
    envAttribute: keys.find((k) => /env|environment|tier/i.test(k)) ?? 'name-pattern',
    ownerAttribute: keys.find((k) => /owner|contact/i.test(k)) ?? '',
  };
}

/** Environment name patterns (the ENVIRONMENTS regexes of estate-answers.ts, mapped to `Env`). */
const ENV_PATTERNS: readonly (readonly [Env, RegExp])[] = [
  ['prod', /(^|[^a-z])(prd|prod|production)([^a-z]|$)/i],
  ['preprod', /(^|[^a-z])(stg|stage|staging|preprod|pre-prod)([^a-z]|$)/i],
  ['dev', /(^|[^a-z])(dev|development)([^a-z]|$)/i],
  ['test', /(^|[^a-z])(tst|test|qa|uat|tdv)([^a-z]|$)/i],
  ['dr', /(^|[^a-z])(dr|drt|recovery)([^a-z]|$)/i],
];

/** An environment from free text: an option value or label, else a name pattern. Undefined when neither. */
export function envFromText(text: string): Env | undefined {
  const t = text.trim();
  if (!t) return undefined;
  return optionValue(ENV_OPTIONS, t) ?? ENV_PATTERNS.find(([, re]) => re.test(t))?.[0];
}

const folderLeaf = (vm: InventoryVm): string => folderPath(vm.folder).split('/').filter(Boolean).pop() ?? '';

function attribute(vm: InventoryVm, key: string): string {
  const attrs = vm.customAttributes ?? {};
  if (key in attrs) return (attrs[key] ?? '').trim();
  const lower = key.toLowerCase();
  const found = Object.keys(attrs).find((k) => k.toLowerCase() === lower);
  return found ? (attrs[found] ?? '').trim() : '';
}

function appOf(vm: InventoryVm, source: string): string {
  if (source === '') return '';
  if (source === 'folder-leaf') return folderLeaf(vm);
  if (source === 'vapp') return (vm.vApp ?? '').trim();
  return attribute(vm, source);
}

/** Env from the attribute when it reads as one, else the name and folder patterns; undefined when nothing matches. */
function envOf(vm: InventoryVm, source: string): { env?: Env; unread?: string } {
  if (source !== '' && source !== 'name-pattern') {
    const value = attribute(vm, source);
    const env = envFromText(value);
    if (env) return { env };
    if (value) return { unread: value };
  }
  if (source === '') return {};
  const env = envFromText(vm.name) ?? envFromText(vm.folder ?? '') ?? envFromText(vm.resourcePool ?? '');
  return env ? { env } : {};
}

// ---------------------------------------------------------------------------
// Disks and facts
// ---------------------------------------------------------------------------

/** "Hard disk 1" is the boot disk whatever controller it sits on; device keys sort SCSI before NVMe and SATA. */
const diskOrdinal = (d: VmDisk): number => Number(/(\d+)\s*$/.exec(d.label)?.[1] ?? Number(d.key ?? 0));

/**
 * The disks that move with the VM, in GiB, boot disk first: VMDKs only (an RDM
 * is a LUN, not a file). With no disk detail, one disk of the allocated size
 * less the RDMs.
 */
export function movableDisks(vm: InventoryVm): { readonly sizes: number[]; readonly rdm: number; readonly rdmGib: number } {
  const disks = [...(vm.disks ?? [])].sort((a, b) => diskOrdinal(a) - diskOrdinal(b));
  const sizes = disks.filter((d) => !d.raw).map((d) => Math.max(1, Math.ceil(d.capacityGib)));
  const raw = disks.filter((d) => d.raw);
  if (sizes.length === 0) {
    const whole = Math.ceil(Math.max(vm.totalDiskGib ?? 0, vm.provisionedGib - (vm.rdmGib ?? 0)));
    if (whole > 0) sizes.push(whole);
  }
  const rdmGib = raw.length > 0 ? raw.reduce((s, d) => s + d.capacityGib, 0) : (vm.rdmGib ?? 0);
  return { sizes, rdm: raw.length, rdmGib };
}

function factsOf(vm: InventoryVm, collectedAt: string | undefined): WorkloadFacts {
  const { rdmGib } = movableDisks(vm);
  const shared = (vm.disks ?? []).some((d) => /multiwriter/i.test(d.sharing ?? '') || (d.sharedBus !== undefined && !/nosharing/i.test(d.sharedBus)));
  const ips = vm.ipAddresses && vm.ipAddresses.length > 0 ? vm.ipAddresses : vm.ipAddress ? [vm.ipAddress] : [];
  const active = vm.activeMemoryGib ?? vm.memory?.activeGib;
  const firmware = /efi/i.test(vm.firmware ?? '') ? 'efi' : /bios/i.test(vm.firmware ?? '') ? 'bios' : undefined;
  const raw = guestOsRaw(vm);
  return {
    powerState: vm.powerState,
    ...(rdmGib > 0 ? { rdmGib } : {}),
    ...(shared ? { sharedDisks: true } : {}),
    // RVTools' DirectPath column only says DirectPath is allowed; the fixed-passthrough flag is what counts.
    ...(vm.passthroughHotplug ? { passthrough: true } : {}),
    ...(active !== undefined ? { activeMemoryGib: active } : {}),
    ...(firmware ? { firmware } : {}),
    ...(ips.length > 0 ? { ipAddresses: [...ips] } : {}),
    readiness: assessVm(vm, collectedAt).map((f) => ({ id: f.check.id, severity: f.check.severity })),
    ...(raw ? { guestOsRaw: raw } : {}),
  };
}

/**
 * VM-to-VM affinity rules as dependency hints: each member of a "keep
 * together" rule depends on the others. Anti-affinity and VM-host rules say
 * nothing about dependencies and are left out.
 */
function affinityPeers(vms: readonly InventoryVm[]): Map<InventoryVm, string[]> {
  const groups = new Map<string, InventoryVm[]>();
  for (const vm of vms) {
    const kinds = vm.clusterRules ?? [];
    const rules = vm.clusterRuleNames ?? [];
    rules.forEach((rule, i) => {
      const kind = kinds[i] ?? kinds[0] ?? '';
      if (!/affinity/i.test(kind) || /anti/i.test(kind) || /host/i.test(kind)) return;
      const key = `${(vm.vcenter ?? '').toLowerCase()}|${vm.cluster ?? ''}|${rule}`;
      groups.set(key, [...(groups.get(key) ?? []), vm]);
    });
  }
  const out = new Map<InventoryVm, string[]>();
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    for (const vm of members) {
      const peers = members.filter((m) => m !== vm).map((m) => m.name);
      out.set(vm, [...new Set([...(out.get(vm) ?? []), ...peers])].sort());
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface InventoryIntakeOptions {
  /** '' or undefined = the whole estate; else a cluster name or folder prefix. */
  readonly scope?: string;
  readonly includePoweredOff: boolean;
  /** '' = none; a custom attribute key; 'folder-leaf'; 'vapp'. Undefined = `defaultAttributes`. */
  readonly appAttribute?: string;
  /** '' = none (all prod); a key; 'name-pattern'. Undefined = `defaultAttributes`. */
  readonly envAttribute?: string;
  /** '' = none; a key. Undefined = `defaultAttributes`. */
  readonly ownerAttribute?: string;
  /** ISO date for the end-of-support count; default the collection date, else today. */
  readonly on?: string;
}

/** The plan's saved Sources settings as options. */
export function inventoryOptions(settings: IntakeSettings): InventoryIntakeOptions {
  return {
    scope: settings.scope,
    includePoweredOff: settings.includePoweredOff,
    appAttribute: settings.appAttribute,
    envAttribute: settings.envAttribute,
    ownerAttribute: settings.ownerAttribute,
  };
}

/** One server record per VM (the shared mapping takes it from there). */
export function serverFromVm(
  vm: InventoryVm,
  attrs: { readonly appAttribute: string; readonly envAttribute: string; readonly ownerAttribute: string },
  collectedAt?: string,
  dependsOn: readonly string[] = [],
): { record: ServerRecord; envUnread?: string } {
  const { sizes, rdmGib } = movableDisks(vm);
  const { env, unread } = envOf(vm, attrs.envAttribute);
  const app = appOf(vm, attrs.appAttribute);
  const owner = attrs.ownerAttribute ? attribute(vm, attrs.ownerAttribute) : '';
  const record: ServerRecord = {
    name: vm.name,
    ...(app ? { app } : {}),
    ...(env ? { env } : {}),
    ...(owner ? { owner } : {}),
    os: classifyVm(vm),
    vcpu: vm.vcpu,
    memoryGib: vm.memoryGib,
    disksGib: sizes,
    provisionedGib: Math.max(0, vm.provisionedGib - rdmGib),
    powerState: vm.powerState,
    ...(vm.annotation ? { annotation: vm.annotation } : {}),
    ...(vm.customAttributes ? { attributes: vm.customAttributes } : {}),
    dependsOn,
    sourceKey: scopedKey(vm.vcenter, vm.name),
    facts: factsOf(vm, collectedAt),
    ...(vm.guestOsTools || vm.guestOs ? { guestOs: vm.guestOsTools ?? vm.guestOs ?? '' } : {}),
  };
  return unread ? { record, envUnread: unread } : { record };
}

/**
 * The estate as rows. One workload per `isWorkload` VM in scope (powered-off
 * ones only when asked), inferred databases, app rows, and the import's
 * findings.
 */
export function workloadsFromInventory(inv: Inventory, opts: InventoryIntakeOptions): IntakeResult {
  const scoped = scopeInventory(inv, opts.scope);
  const defaults = defaultAttributes(inv);
  const attrs = {
    appAttribute: opts.appAttribute ?? defaults.appAttribute,
    envAttribute: opts.envAttribute ?? defaults.envAttribute,
    ownerAttribute: opts.ownerAttribute ?? defaults.ownerAttribute,
  };
  const collectedAt = inv.source.collectedAt;
  const findings: Finding[] = [];

  const workloadVms = scoped.vms.filter(isWorkload);
  const off = workloadVms.filter((v) => v.powerState === 'poweredOff');
  const vms = opts.includePoweredOff ? workloadVms : workloadVms.filter((v) => v.powerState !== 'poweredOff');

  if ((opts.scope ?? '').trim() && workloadVms.length === 0) {
    findings.push(warning('plan.sources.scope-empty', `No VMs are in the scope “${opts.scope}”.`, {
      remediation: 'Pick a cluster or folder from the list, or the whole estate.',
    }));
  }

  const peers = affinityPeers(vms);
  const unreadEnv: string[] = [];
  const records = vms.map((vm) => {
    const { record, envUnread } = serverFromVm(vm, attrs, collectedAt, peers.get(vm) ?? []);
    if (envUnread) unreadEnv.push(`${vm.name} (“${envUnread}”)`);
    return record;
  });

  const result = intakeFromServers(records, { source: 'estate', noun: 'VM', on: opts.on ?? isoDay(collectedAt) });

  if (!opts.includePoweredOff && off.length > 0) {
    findings.push(info('plan.sources.powered-off-skipped', `${off.length} powered-off VM${off.length === 1 ? ' was' : 's were'} left out; they are candidates to retire.`, {
      remediation: 'Set “Include powered-off VMs” to Yes to plan them too.',
    }));
  }
  if (unreadEnv.length > 0) {
    const shown = unreadEnv.slice(0, 5).join(', ');
    findings.push(warning('plan.sources.env-unread', `The environment attribute did not read as an environment on ${unreadEnv.length} VM(s), so they are marked prod: ${shown}${unreadEnv.length > 5 ? ' …' : ''}.`, {
      remediation: 'Set Env on the Workloads screen.',
    }));
  }
  const withAffinity = [...peers.keys()].length;
  if (withAffinity > 0) {
    findings.push(info('plan.sources.affinity-hints', `${withAffinity} VM(s) are in DRS keep-together rules; their “Depends on” is filled from those rules as a hint.`));
  }
  return { ...result, findings: [...findings, ...result.findings] };
}

export const VMWARE_ADAPTER: IntakeAdapter<Inventory, InventoryIntakeOptions> = {
  id: 'vmware',
  label: 'VMware estate (RVTools, PowerCLI or vCenter)',
  itemSource: 'estate',
  parse: workloadsFromInventory,
};
