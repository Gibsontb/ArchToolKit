/**
 * The imported estate, so the rest of the toolkit can offer it.
 *
 * A generator asking you to type a datastore name is asking you to remember
 * something the toolkit already knows. Once an inventory has been imported, the
 * vSphere blueprints should be offering your actual datacenters, clusters,
 * datastores, port groups, templates and virtual machines rather than a text box
 * with `datastore1` in it.
 *
 * Only the names are kept, not the inventory itself. The names are all the
 * dropdowns need, they are small enough to carry between pages without thinking
 * about it, and keeping less of someone's estate around is the right default.
 *
 * `sessionStorage` is the right lifetime here, as it is for the platform
 * selection: it survives moving between pages in a tab and goes away with the
 * tab. Every access is wrapped, because storage throws in a private window and
 * with site data blocked, and a generator that failed to load because it could
 * not read a convenience would be a poor trade.
 */

import type { Inventory } from '../vmware/inventory.ts';

const KEY = 'archtoolkit.estate';
const VERSION = 2;

export interface EstateNames {
  readonly version: number;
  /** Where it came from, shown so the suggestions are not mysterious. */
  readonly origin: string;
  readonly datacenters: readonly string[];
  readonly clusters: readonly string[];
  readonly datastores: readonly string[];
  readonly networks: readonly string[];
  readonly hosts: readonly string[];
  readonly vms: readonly string[];
  /**
   * Virtual machines whose name looks like a template. vSphere does not mark
   * templates in most exports, so this is a guess and is offered alongside the
   * full VM list rather than instead of it.
   */
  readonly templates: readonly string[];
  readonly vcenters: readonly string[];
  readonly folders: readonly string[];
  readonly resourcePools: readonly string[];
  readonly switches: readonly string[];
}

function store(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** Unique, sorted, blank-free — the shape a dropdown wants. */
function names(values: readonly (string | undefined)[], limit = 400): string[] {
  const set = new Set<string>();
  for (const value of values) {
    const name = (value ?? '').trim();
    if (name) set.add(name);
  }
  return [...set].sort((a, b) => a.localeCompare(b)).slice(0, limit);
}

export function saveEstate(inventory: Inventory): void {
  try {
    const label = inventory.source.label ?? inventory.source.kind;
    const payload: EstateNames = {
      version: VERSION,
      origin: label,
      datacenters: names([
        ...inventory.clusters.map((c) => c.datacenter),
        ...inventory.hosts.map((h) => h.datacenter),
        ...inventory.vms.map((v) => v.datacenter),
      ]),
      clusters: names([...inventory.clusters.map((c) => c.name), ...inventory.hosts.map((h) => h.cluster)]),
      datastores: names(inventory.datastores.map((d) => d.name)),
      networks: names(inventory.networks.map((n) => n.name)),
      hosts: names(inventory.hosts.map((h) => h.name)),
      vms: names(
        inventory.vms.filter((v) => !v.template).map((v) => v.name),
        25000,
      ),
      // RVTools marks templates; older sources do not, so fall back to names.
      templates: names(
        inventory.vms.some((v) => v.template)
          ? inventory.vms.filter((v) => v.template).map((v) => v.name)
          : inventory.vms.filter((v) => /template|golden|gold-|-tmpl/i.test(v.name)).map((v) => v.name),
        2000,
      ),
      vcenters: names([
        ...(inventory.vcenters ?? []).map((v) => v.name),
        ...inventory.hosts.map((h) => h.vcenter),
      ]),
      // A folder path's leaf is what vSphere modules ask for, relative to the datacenter.
      folders: names(
        inventory.vms.map((v) => v.folder?.split('/').slice(2).join('/')),
        2000,
      ),
      resourcePools: names(
        [
          ...(inventory.resourcePools ?? []).map((p) => p.name),
          ...inventory.vms.map((v) => v.resourcePool?.split('/').pop()),
        ],
        2000,
      ),
      switches: names([
        ...(inventory.distributedSwitches ?? []).map((d) => d.name),
        ...inventory.networks.map((n) => n.switchName),
      ]),
    };
    store()?.setItem(KEY, JSON.stringify(payload));
  } catch {
    // Not remembering the estate is survivable; failing to import is not.
  }
}

export function loadEstate(): EstateNames | null {
  try {
    const raw = store()?.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as EstateNames;
    return parsed?.version === VERSION ? parsed : null;
  } catch {
    return null;
  }
}

export function clearEstate(): void {
  try {
    store()?.removeItem(KEY);
  } catch {
    // As above.
  }
}

/**
 * Which part of the estate answers a given input.
 *
 * Matched on the input id, so it covers the blueprints' various spellings —
 * `datastore`, `datastore_name`, `datacenter`, `datacenter_name` and the rest —
 * without a per-blueprint list to keep in step.
 */
export function estateOptionsFor(
  target: string,
  inputId: string,
): { readonly values: readonly string[]; readonly origin: string } | null {
  const estate = loadEstate();
  if (!estate) return null;
  // Inputs that choose part of the estate to build from exist on every
  // platform's estate blueprints, not only vSphere's.
  const scopeId = inputId.toLowerCase();
  if (scopeId === 'source_cluster') {
    return estate.clusters.length > 0 ? { values: estate.clusters, origin: estate.origin } : null;
  }
  if (scopeId === 'source_folder') {
    return (estate.folders ?? []).length > 0 ? { values: estate.folders, origin: estate.origin } : null;
  }
  if (target !== 'vsphere') return null;
  const optional = (values: readonly string[] | undefined): readonly string[] => values ?? [];

  const id = inputId.toLowerCase();
  const pick = (values: readonly string[]) =>
    values.length > 0 ? { values, origin: estate.origin } : null;

  // Templates first: a template input wants the template-looking names, and
  // falls back to every VM, because the guess is only a guess.
  if (/template/.test(id)) {
    return pick(estate.templates.length > 0 ? estate.templates : estate.vms);
  }
  if (/vcenter|vsphere_server|^server$/.test(id)) return pick(optional(estate.vcenters));
  if (/resource_pool|resourcepool/.test(id)) return pick(optional(estate.resourcePools));
  if (/folder/.test(id)) return pick(optional(estate.folders));
  if (/dvs|distributed_switch|vswitch|switch_name/.test(id)) return pick(optional(estate.switches));
  if (/datacenter/.test(id)) return pick(estate.datacenters);
  if (/datastore/.test(id)) return pick(estate.datastores);
  if (/cluster/.test(id)) return pick(estate.clusters);
  if (/network|portgroup|port_group/.test(id)) return pick(estate.networks);
  if (/esxi|^host$|host_name|host_system/.test(id)) return pick(estate.hosts);
  if (/^vm_name$|^vm$|guest_name/.test(id)) return pick(estate.vms);
  return null;
}
