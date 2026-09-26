/**
 * The data-centre pane's grids, with no DOM (addendum A.5.5): every list in
 * the building as a " | " grid of `CellColumn`s (the same model the intake
 * grids use, so `planGrid` edits them), each closed set a dropdown, and each
 * grid's CSV export and import.
 *
 * The infrastructure grids are views of one list, `DcExit.infra`, filtered by
 * `category`; their category-specific columns live in `InfraItem.facts`
 * under the names the engines read (dcexit/sequence.ts, archive.ts, jobs.ts):
 *
 *   network-device  kind, platform (the Network page's ids), role, configFile
 *   circuit         kind, provider, bandwidth, sites, contractEnd, noticeDays,
 *                   device, neighbor, remoteAs, localAs, prefixes, nextHop,
 *                   interface, cutOrder, cutOn
 *   subnet          cidr, vlan, apps, strategy
 *   net-service     kind, servers
 *   storage-array   kind, rawTib, usedTib, protocols, replication, apps
 *   backup          appliances, protectedTib, retentionPolicy
 *   archive         media, location, content, retentionUntil, legalHold, obligation
 *   security-service kind, servers, keyMigration
 *   ops-tool        kind, servers
 *   job             scheduler, host, schedule, command, runsAs, app, target, dbTarget
 *   other           kind (the category: telephony, print, ot-iot, other), notes
 * and every grid has `done` (yes when the final disposition is carried out),
 * which the lights-out checklist reads.
 *
 * The rules a cell refuses rather than records: an archive under legal hold
 * cannot be `retire` (`dc.legal-hold`), and an asset holding data cannot be
 * marked disposed without a NIST SP 800-88 method and a certificate id
 * (`dc.sanitise`).
 *
 * CSV: the header is the grid's column headings; import maps by heading (or
 * the column key), never by position, and merges on the first column (name
 * or id): a row with a known name is updated, a new one is added.
 */

import { parseCsvRecords, toCsv } from '../../core/csv.ts';
import { error, warning, type Finding } from '../../core/findings.ts';
import { PLATFORMS as NETWORK_PLATFORMS } from '../../network/device.ts';
import {
  CONTRACT_KIND_OPTIONS, EXTERNAL_DIRECTION_OPTIONS, EXTERNAL_KIND_OPTIONS, INFRA_DISPOSITION_OPTIONS, IP_STRATEGY_OPTIONS,
  SANITISATION_OPTIONS, YES_NO_OPTIONS, optionValue, type PlanOption,
} from '../../multicloud/plan/options.ts';
import { ARCHIVE_MEDIA, RETENTION_OBLIGATIONS } from '../../multicloud/plan/dcexit/archive.ts';
import { CIRCUIT_KINDS, DEVICE_KINDS, NET_SERVICE_KINDS } from '../../multicloud/plan/dcexit/sequence.ts';
import { JOB_TARGETS, SCHEDULERS } from '../../multicloud/plan/dcexit/jobs.ts';
import type { Asset, Contract, ContractStatus, DcExit, ExternalLink, InfraCategory, InfraItem } from '../../multicloud/plan/types.ts';
import { applyCells, rowCells, type CellColumn, type CellResult } from '../multicloud/grid-model.ts';

export type { CellColumn };

/* ------------------------------------------------------------ closed sets --- */

const opts = (pairs: readonly (readonly [string, string])[]): readonly PlanOption[] => Object.freeze(pairs.map(([value, label]) => Object.freeze({ value, label })));

export const DEVICE_KIND_OPTIONS = opts(DEVICE_KINDS.map((k) => [k, { switch: 'Switch', router: 'Router', firewall: 'Firewall', 'load-balancer': 'Load balancer', wlc: 'Wireless LAN controller', proxy: 'Proxy' }[k]] as const));
/** The Network page's platform ids, and `other` for a device it has no blueprints for. */
export const NETWORK_PLATFORM_OPTIONS = opts([...Object.values(NETWORK_PLATFORMS).map((p) => [p.id, p.label] as const), ['other', 'Other']]);
/** Circuits in the grid's order (the cut order is internet first, MPLS last: `CIRCUIT_KINDS`). */
export const CIRCUIT_KIND_OPTIONS = opts((['mpls', 'internet', 'p2p', 'dark-fibre', 'vpn'] as const).filter((k) => (CIRCUIT_KINDS as readonly string[]).includes(k)).map((k) => [k, { mpls: 'MPLS', internet: 'Internet', p2p: 'Point to point', 'dark-fibre': 'Dark fibre', vpn: 'VPN' }[k]] as const));
export const NET_SERVICE_KIND_OPTIONS = opts(NET_SERVICE_KINDS.map((k) => [k, k === 'proxy' ? 'Proxy' : k.toUpperCase()] as const));
export const STORAGE_KIND_OPTIONS = opts([['san', 'SAN (block)'], ['nas', 'NAS (file)'], ['object', 'Object']]);
export const ARCHIVE_MEDIA_OPTIONS = opts(ARCHIVE_MEDIA.map((m) => [m, { tape: 'Tape', 'disk-archive': 'Disk archive', optical: 'Optical' }[m]] as const));
export const OBLIGATION_OPTIONS = opts(RETENTION_OBLIGATIONS.map((o) => [o, { 'migrate-to-archive-tier': 'Migrate to an archive tier', 'keep-until-expiry': 'Keep until expiry (third party)', 'restore-and-migrate': 'Restore and migrate' }[o]] as const));
export const SECURITY_KIND_OPTIONS = opts([
  ['ad', 'Active Directory'], ['pam', 'PAM'], ['pki', 'PKI / CA'], ['hsm', 'HSM / keys'], ['siem', 'SIEM'], ['vuln-scanning', 'Vulnerability scanning'],
  ['edr', 'EDR'], ['mfa', 'MFA'], ['nac', 'NAC'], ['proxy', 'Proxy'],
]);
/** HSM / key sets: the key-migration decision (a runbook, never automated). */
export const KEY_MIGRATION_OPTIONS = opts([['re-key', 'Re-key in the target KMS / HSM'], ['import', 'Import the key material (where the service accepts it)']]);
export const OPS_KIND_OPTIONS = opts([
  ['monitoring', 'Monitoring'], ['ticketing', 'Ticketing'], ['cmdb', 'CMDB'], ['scheduler', 'Scheduler'], ['patching', 'Patching'], ['backup', 'Backup'],
  ['jump', 'Jump host'], ['config-mgmt', 'Configuration management'],
]);
export const SCHEDULER_OPTIONS = opts(SCHEDULERS.map((s) => [s, { 'control-m': 'Control-M', cron: 'cron', 'task-scheduler': 'Task Scheduler', 'sql-agent': 'SQL Agent', other: 'Other' }[s]] as const));
export const JOB_TARGET_OPTIONS = opts(JOB_TARGETS.map((t) => [t, { 'same-host': 'Same host (its new home)', 'eventbridge-scheduler': 'EventBridge Scheduler (AWS)', 'cloud-scheduler': 'Cloud Scheduler (Google Cloud (GCP))', 'oci-resource-scheduler': 'OCI Resource Scheduler' }[t]] as const));
export const DB_TARGET_OPTIONS = opts([['vm', 'SQL Server on a VM'], ['managed-instance', 'SQL Managed Instance'], ['paas', 'Another managed database']]);
export const OTHER_CATEGORIES: readonly InfraCategory[] = ['other', 'telephony', 'print', 'ot-iot'];
export const OTHER_KIND_OPTIONS = opts([['telephony', 'Telephony / UC'], ['print', 'Print'], ['ot-iot', 'OT / building / IoT'], ['other', 'Other']]);
export const CONTRACT_STATUS_OPTIONS = opts([['active', 'Active'], ['notice-given', 'Notice given'], ['terminated', 'Terminated']]);

/* ---------------------------------------------------------- column helpers --- */

const ok = <T>(patch: Partial<T>): CellResult<T> => ({ patch });
const withBlank = (options: readonly PlanOption[], label: string): readonly PlanOption[] => [{ value: '', label }, ...options];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const yes = (v: string | undefined): boolean => /^(yes|y|true|1)$/i.test((v ?? '').trim());

function checkValue(label: string, text: string, kind: 'date' | 'number' | 'decimal' | undefined): string | undefined {
  const t = text.trim();
  if (t === '' || kind === undefined) return undefined;
  if (kind === 'date' && !(ISO.test(t) && !Number.isNaN(Date.parse(`${t}T00:00:00Z`)))) return `${label}: “${t}” is not a date (yyyy-mm-dd).`;
  if (kind === 'number' && !/^\d+$/.test(t)) return `${label}: “${t}” is not a whole number of 0 or more.`;
  if (kind === 'decimal' && !(Number.isFinite(Number(t)) && Number(t) >= 0)) return `${label}: “${t}” is not a number of 0 or more.`;
  return undefined;
}

/** A fact of an infra item, as text (blank removes it). */
function fact(key: string, label: string, kind?: 'date' | 'number' | 'decimal'): CellColumn<InfraItem> {
  return {
    key,
    label,
    get: (row) => row.facts[key] ?? '',
    set: (row, text) => {
      const bad = checkValue(label, text, kind);
      if (bad) return { error: bad };
      const { [key]: _old, ...rest } = row.facts;
      const t = text.trim();
      return ok<InfraItem>({ facts: t ? { ...rest, [key]: t } : rest });
    },
  };
}

/** A fact with a closed set of values. */
function factSelect(key: string, label: string, options: readonly PlanOption[], blank: string): CellColumn<InfraItem> {
  return {
    key,
    label,
    options: withBlank(options, blank),
    get: (row) => row.facts[key] ?? '',
    set: (row, text) => {
      const { [key]: _old, ...rest } = row.facts;
      if (text.trim() === '') return ok<InfraItem>({ facts: rest });
      const v = optionValue(options, text);
      if (v === undefined) return { error: `${label}: “${text.trim()}” is not one of the choices.` };
      return ok<InfraItem>({ facts: { ...rest, [key]: v } });
    },
  };
}

/** A text field of the record (blank = undefined, or '' when required). */
function field<T>(key: keyof T & string, label: string, opt: { readonly required?: boolean; readonly kind?: 'date' } = {}): CellColumn<T> {
  return {
    key,
    label,
    get: (row) => String((row as Record<string, unknown>)[key] ?? ''),
    set: (_row, text) => {
      const t = text.trim();
      if (opt.required && t === '') return { error: `${label} cannot be blank.` };
      const bad = checkValue(label, t, opt.kind);
      if (bad) return { error: bad };
      return ok<T>({ [key]: opt.required ? t : t || undefined } as Partial<T>);
    },
  };
}

function numberField<T>(key: keyof T & string, label: string, optional: boolean): CellColumn<T> {
  return {
    key,
    label,
    get: (row) => {
      const v = (row as Record<string, unknown>)[key];
      return v === undefined || v === null ? '' : String(v);
    },
    set: (_row, text) => {
      const t = text.trim();
      if (t === '') return optional ? ok<T>({ [key]: undefined } as Partial<T>) : { error: `${label} needs a number.` };
      const bad = checkValue(label, t, 'number');
      return bad ? { error: bad } : ok<T>({ [key]: Number(t) } as Partial<T>);
    },
  };
}

function selectField<T>(key: keyof T & string, label: string, options: readonly PlanOption[], blank?: string): CellColumn<T> {
  return {
    key,
    label,
    options: blank !== undefined ? withBlank(options, blank) : options,
    get: (row) => String((row as Record<string, unknown>)[key] ?? ''),
    set: (_row, text) => {
      if (text.trim() === '') return blank !== undefined ? ok<T>({ [key]: undefined } as Partial<T>) : { error: `${label} cannot be blank.` };
      const v = optionValue(options, text);
      return v === undefined ? { error: `${label}: “${text.trim()}” is not one of the choices.` } : ok<T>({ [key]: v } as Partial<T>);
    },
  };
}

/** Yes / no, stored as a boolean. */
function yesNoField<T>(key: keyof T & string, label: string): CellColumn<T> {
  return {
    key,
    label,
    options: YES_NO_OPTIONS,
    get: (row) => ((row as Record<string, unknown>)[key] ? 'yes' : 'no'),
    set: (_row, text) => {
      const t = text.trim().toLowerCase();
      if (t === '' || t === 'no' || t === 'n' || t === 'false' || t === '0') return ok<T>({ [key]: false } as Partial<T>);
      if (yes(t)) return ok<T>({ [key]: true } as Partial<T>);
      return { error: `${label}: “${text.trim()}” is not yes or no.` };
    },
  };
}

const nameCol = (label: string): CellColumn<InfraItem> => field<InfraItem>('name', label, { required: true });
const text = (key: 'vendor' | 'model' | 'site' | 'owner' | 'target', label: string): CellColumn<InfraItem> => field<InfraItem>(key, label);

/** The disposition, a closed set; `retire` is refused for an archive under legal hold. */
const dispositionCol: CellColumn<InfraItem> = {
  key: 'disposition',
  label: 'Disposition',
  options: withBlank(INFRA_DISPOSITION_OPTIONS, 'Not decided'),
  get: (row) => row.disposition ?? '',
  set: (row, t) => {
    if (t.trim() === '') return ok<InfraItem>({ disposition: undefined });
    const v = optionValue(INFRA_DISPOSITION_OPTIONS, t);
    if (v === undefined) return { error: `Disposition: “${t.trim()}” is not one of the choices.` };
    if (v === 'retire' && row.category === 'archive' && yes(row.facts.legalHold)) {
      return { error: `Disposition: ${row.name} is under legal hold and cannot be retired (dc.legal-hold).` };
    }
    return ok<InfraItem>({ disposition: v });
  },
};

/** Legal hold: turning it on is refused while the archive is set to retire. */
const legalHoldCol: CellColumn<InfraItem> = {
  key: 'legalHold',
  label: 'Legal hold',
  options: YES_NO_OPTIONS,
  get: (row) => (yes(row.facts.legalHold) ? 'yes' : 'no'),
  set: (row, t) => {
    const on = yes(t);
    if (!on && !/^(no|n|false|0|)$/i.test(t.trim())) return { error: `Legal hold: “${t.trim()}” is not yes or no.` };
    if (on && row.disposition === 'retire') return { error: `Legal hold: ${row.name} is set to retire; choose another disposition first (dc.legal-hold).` };
    return ok<InfraItem>({ facts: { ...row.facts, legalHold: on ? 'yes' : 'no' } });
  },
};

const afterWaveCol = (label: string): CellColumn<InfraItem> => numberField<InfraItem>('afterWave', label, true);
const doneCol: CellColumn<InfraItem> = factSelect('done', 'Done', YES_NO_OPTIONS, 'Not yet');

/* ------------------------------------------------------------------ grids --- */

type Row = { readonly id: string };

export interface DcGrid<T extends Row> {
  /** `data-control` prefix and CSV file stem. */
  readonly id: string;
  readonly title: string;
  readonly noun: string;
  readonly hint: string;
  readonly columns: readonly CellColumn<T>[];
  readonly filterKeys?: readonly string[];
  read(dc: DcExit): readonly T[];
  /** The data centre with this grid's rows replaced. */
  write(dc: DcExit, rows: readonly T[]): DcExit;
  /** A blank row whose id is not in `taken`. */
  create(taken: ReadonlySet<string>): T;
  /** What follows from an edit. */
  after?(before: T, next: T): T;
  /** The ids a new row must not reuse. */
  ids(dc: DcExit): Set<string>;
}

/** `edited` / `inferred` are intake bookkeeping; the data-centre records do not carry them. */
function tidy<T>(row: T): T {
  const { edited: _e, inferred: _i, ...rest } = row as T & { edited?: unknown; inferred?: unknown };
  return rest as T;
}

function uniqueId(prefix: string, taken: ReadonlySet<string>): string {
  let n = 1;
  while (taken.has(`${prefix}-${n}`)) n += 1;
  return `${prefix}-${n}`;
}

function infraGrid(spec: {
  readonly id: string;
  readonly title: string;
  readonly noun: string;
  readonly hint: string;
  readonly categories: readonly InfraCategory[];
  readonly columns: readonly CellColumn<InfraItem>[];
  readonly defaults?: Readonly<Record<string, string>>;
  readonly filterKeys?: readonly string[];
}): DcGrid<InfraItem> {
  const cats = new Set(spec.categories);
  const first = spec.categories[0] as InfraCategory;
  return {
    id: spec.id,
    title: spec.title,
    noun: spec.noun,
    hint: spec.hint,
    columns: spec.columns,
    filterKeys: spec.filterKeys ?? ['disposition'],
    read: (dc) => dc.infra.filter((i) => cats.has(i.category)),
    write: (dc, rows) => {
      // Keep every other category where it was; this grid's rows replace its own, in the grid's order.
      const out: InfraItem[] = [];
      let placed = false;
      for (const i of dc.infra) {
        if (!cats.has(i.category)) out.push(i);
        else if (!placed) {
          out.push(...rows.map(tidy));
          placed = true;
        }
      }
      if (!placed) out.push(...rows.map(tidy));
      return { ...dc, infra: out };
    },
    create: (taken) => ({ id: uniqueId(first, taken), category: first, name: '', facts: { ...(spec.defaults ?? {}) } }),
    after: (_before, next) => tidy(next),
    ids: (dc) => new Set(dc.infra.map((i) => i.id)),
  };
}

export const DEVICES_GRID = infraGrid({
  id: 'dc-devices',
  title: 'Network devices',
  noun: 'device',
  hint: 'Switches, routers, firewalls, load balancers, WLCs and proxies. The platform is the Network page’s; firewall and load-balancer configurations are translated on the Firewall & LB tab.',
  categories: ['network-device'],
  columns: [
    nameCol('Name'),
    factSelect('kind', 'Kind', DEVICE_KIND_OPTIONS, '—'),
    factSelect('platform', 'Vendor / platform', NETWORK_PLATFORM_OPTIONS, '—'),
    text('model', 'Model'),
    text('site', 'Site'),
    fact('role', 'Role'),
    fact('configFile', 'Config file'),
    dispositionCol,
    text('target', 'Target'),
    afterWaveCol('Retire after wave'),
    doneCol,
  ],
  filterKeys: ['kind', 'platform', 'disposition'],
});

export const CIRCUITS_GRID = infraGrid({
  id: 'dc-circuits',
  title: 'Circuits',
  noun: 'circuit',
  hint: 'WAN, internet and point-to-point links. Device, BGP neighbour / AS or prefixes / next hop fill the rollback change on the Network page. Sites are space separated. Cut on: the date the circuit was cut.',
  categories: ['circuit'],
  columns: [
    nameCol('Circuit'),
    factSelect('kind', 'Kind', CIRCUIT_KIND_OPTIONS, '—'),
    fact('provider', 'Provider'),
    fact('bandwidth', 'Bandwidth'),
    fact('sites', 'Sites'),
    fact('contractEnd', 'Contract end', 'date'),
    fact('noticeDays', 'Notice days', 'number'),
    afterWaveCol('Cut after wave'),
    fact('device', 'Device'),
    fact('neighbor', 'BGP neighbour'),
    fact('remoteAs', 'Remote AS', 'number'),
    fact('localAs', 'Local AS', 'number'),
    fact('prefixes', 'Static prefixes'),
    fact('nextHop', 'Next hop'),
    fact('interface', 'Interface'),
    fact('cutOrder', 'Cut order', 'number'),
    dispositionCol,
    fact('cutOn', 'Cut on', 'date'),
  ],
  filterKeys: ['kind', 'disposition'],
});

export const SUBNETS_GRID = infraGrid({
  id: 'dc-subnets',
  title: 'Subnets',
  noun: 'subnet',
  hint: 'Each subnet’s IP strategy: re-IP (the default), keep the address with an HCX network extension (VMware targets only), or keep the same CIDR in the cloud (once the subnet is empty on-premises). Apps are space separated.',
  categories: ['subnet'],
  columns: [
    nameCol('Subnet'),
    fact('cidr', 'CIDR'),
    fact('vlan', 'VLAN', 'number'),
    text('site', 'Site'),
    fact('apps', 'Apps'),
    factSelect('strategy', 'Strategy', IP_STRATEGY_OPTIONS, 'Re-IP (default)'),
    dispositionCol,
    afterWaveCol('Retire after wave'),
    doneCol,
  ],
  filterKeys: ['strategy', 'site'],
  defaults: {},
});

export const NET_SERVICES_GRID = infraGrid({
  id: 'dc-netservices',
  title: 'Network services',
  noun: 'service',
  hint: 'DNS, DHCP, IPAM, NTP and proxy servers. DNS zones are imported below; DHCP is retired once every subnet it serves has moved.',
  categories: ['net-service'],
  columns: [nameCol('Service'), factSelect('kind', 'Kind', NET_SERVICE_KIND_OPTIONS, '—'), text('vendor', 'Product'), fact('servers', 'Servers'), text('site', 'Site'), dispositionCol, text('target', 'Target'), afterWaveCol('Retire after wave'), doneCol],
  filterKeys: ['kind', 'disposition'],
});

export const ARRAYS_GRID = infraGrid({
  id: 'dc-arrays',
  title: 'Storage arrays',
  noun: 'array',
  hint: 'SAN, NAS and object storage. An array is retired after the apps that use it, once its backups and archives have a disposition.',
  categories: ['storage-array'],
  columns: [
    nameCol('Array'),
    factSelect('kind', 'Kind', STORAGE_KIND_OPTIONS, '—'),
    text('vendor', 'Vendor'),
    fact('rawTib', 'Raw TiB', 'decimal'),
    fact('usedTib', 'Used TiB', 'decimal'),
    fact('protocols', 'Protocols'),
    fact('replication', 'Replication'),
    fact('apps', 'Apps'),
    text('site', 'Site'),
    dispositionCol,
    text('target', 'Target'),
    afterWaveCol('Retire after wave'),
    doneCol,
  ],
  filterKeys: ['kind', 'disposition'],
});

export const BACKUP_GRID = infraGrid({
  id: 'dc-backup',
  title: 'Backup',
  noun: 'backup product',
  hint: 'Backup products and appliances. They are replaced by the landing zone’s cloud backup; what they hold under retention goes in Archives.',
  categories: ['backup'],
  columns: [nameCol('Product'), fact('appliances', 'Appliances'), fact('protectedTib', 'Protected TiB', 'decimal'), fact('retentionPolicy', 'Retention policy'), text('site', 'Site'), dispositionCol, text('target', 'Target'), doneCol],
});

export const ARCHIVES_GRID = infraGrid({
  id: 'dc-archives',
  title: 'Archives',
  noun: 'archive',
  hint: 'Tape, disk archive and optical media. An archive with a retention date or a legal hold is on the retention register; under legal hold it cannot be retired.',
  categories: ['archive'],
  columns: [
    nameCol('Archive'),
    factSelect('media', 'Media', ARCHIVE_MEDIA_OPTIONS, '—'),
    fact('location', 'Location'),
    fact('content', 'Content'),
    fact('retentionUntil', 'Retention until', 'date'),
    legalHoldCol,
    factSelect('obligation', 'Obligation', OBLIGATION_OPTIONS, 'Not decided'),
    text('owner', 'Owner'),
    dispositionCol,
    doneCol,
  ],
  filterKeys: ['media', 'legalHold', 'disposition'],
  defaults: { legalHold: 'no' },
});

export const SECURITY_GRID = infraGrid({
  id: 'dc-security',
  title: 'Security services',
  noun: 'service',
  hint: 'AD, PAM, PKI, HSM / keys, SIEM, vulnerability scanning, EDR, MFA, NAC and proxies. HSM / key sets need the key-migration decision (re-key, or import where the target accepts imported key material): a runbook, never automated.',
  categories: ['security-service'],
  columns: [
    nameCol('Service'),
    factSelect('kind', 'Kind', SECURITY_KIND_OPTIONS, '—'),
    text('vendor', 'Product'),
    fact('servers', 'Servers'),
    dispositionCol,
    text('target', 'Target'),
    factSelect('keyMigration', 'Key migration', KEY_MIGRATION_OPTIONS, 'Not applicable'),
    text('owner', 'Owner'),
    doneCol,
  ],
  filterKeys: ['kind', 'disposition'],
});

export const OPS_GRID = infraGrid({
  id: 'dc-ops',
  title: 'Operations tooling',
  noun: 'tool',
  hint: 'Monitoring, ticketing, CMDB, schedulers, patching, backup consoles, jump hosts and configuration management.',
  categories: ['ops-tool'],
  columns: [nameCol('Tool'), factSelect('kind', 'Kind', OPS_KIND_OPTIONS, '—'), text('vendor', 'Product'), fact('servers', 'Servers'), dispositionCol, text('target', 'Target'), text('owner', 'Owner'), doneCol],
  filterKeys: ['kind', 'disposition'],
});

export const JOBS_GRID = infraGrid({
  id: 'dc-jobs',
  title: 'Scheduled jobs',
  noun: 'job',
  hint: 'Every scheduled job: cron and Task Scheduler jobs are recreated by the playbook; SQL Agent jobs move with the database; Control-M gets a re-point runbook. Schedule: five-field cron or @daily.',
  categories: ['job'],
  columns: [
    nameCol('Job'),
    factSelect('scheduler', 'Scheduler', SCHEDULER_OPTIONS, '—'),
    fact('host', 'Host'),
    fact('schedule', 'Schedule'),
    fact('command', 'Command'),
    fact('runsAs', 'Runs as'),
    fact('app', 'App'),
    factSelect('target', 'Target', JOB_TARGET_OPTIONS, 'Same host (default)'),
    factSelect('dbTarget', 'SQL Agent target', DB_TARGET_OPTIONS, 'SQL Server on a VM (default)'),
    dispositionCol,
    doneCol,
  ],
  filterKeys: ['scheduler', 'target'],
  defaults: {},
});

/** The Kind column of the Other grid is the item's category. */
const otherKindCol: CellColumn<InfraItem> = {
  key: 'category',
  label: 'Kind',
  options: OTHER_KIND_OPTIONS,
  get: (row) => row.category,
  set: (_row, t) => {
    const v = optionValue(OTHER_KIND_OPTIONS, t.trim() || 'other');
    return v === undefined ? { error: `Kind: “${t.trim()}” is not one of the choices.` } : ok<InfraItem>({ category: v as InfraCategory });
  },
};

export const OTHER_GRID = infraGrid({
  id: 'dc-other',
  title: 'Telephony, print, OT and other',
  noun: 'item',
  hint: 'Disposition only: nothing is generated. A print server goes to Universal Print / PrintBRM through the print pattern.',
  categories: OTHER_CATEGORIES,
  columns: [nameCol('Item'), otherKindCol, fact('location', 'Location'), text('owner', 'Owner'), dispositionCol, fact('notes', 'Notes'), doneCol],
  filterKeys: ['category', 'disposition'],
});

/** Every infrastructure grid. */
export const INFRA_GRIDS: readonly DcGrid<InfraItem>[] = [DEVICES_GRID, CIRCUITS_GRID, SUBNETS_GRID, NET_SERVICES_GRID, ARRAYS_GRID, BACKUP_GRID, ARCHIVES_GRID, SECURITY_GRID, OPS_GRID, JOBS_GRID, OTHER_GRID];

/* ------------------------------------------------------- external coupling --- */

const ipsCol: CellColumn<ExternalLink> = {
  key: 'currentIps',
  label: 'Current IPs',
  get: (row) => row.currentIps.join(' '),
  set: (_row, t) => ok<ExternalLink>({ currentIps: t.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean) }),
};

export const EXTERNAL_GRID: DcGrid<ExternalLink> = {
  id: 'dc-external',
  title: 'External partners and links',
  noun: 'link',
  hint: 'Partners and services outside the building that know it by address: allow-lists, EDI, SFTP, inbound APIs, vendor support and SaaS. A link whose IPs change needs notice (partner notices are on People & process).',
  columns: [
    field<ExternalLink>('id', 'ID', { required: true }),
    selectField<ExternalLink>('kind', 'Kind', EXTERNAL_KIND_OPTIONS),
    field<ExternalLink>('party', 'Party', { required: true }),
    selectField<ExternalLink>('direction', 'Direction', EXTERNAL_DIRECTION_OPTIONS),
    field<ExternalLink>('protocol', 'Protocol', { required: true }),
    field<ExternalLink>('endpoint', 'Endpoint', { required: true }),
    ipsCol,
    field<ExternalLink>('app', 'App'),
    field<ExternalLink>('owner', 'Owner'),
    numberField<ExternalLink>('noticeDays', 'Notice days', false),
  ],
  filterKeys: ['kind', 'direction'],
  read: (dc) => dc.external,
  write: (dc, rows) => ({ ...dc, external: rows.map(tidy) }),
  create: (taken) => ({ id: uniqueId('link', taken), kind: 'partner-allowlist', party: '', direction: 'out', protocol: '', endpoint: '', currentIps: [], noticeDays: 30 }),
  after: (_b, n) => tidy(n),
  ids: (dc) => new Set(dc.external.map((e) => e.id)),
};

/* ---------------------------------------------------- facility and contracts --- */

export const CONTRACTS_GRID: DcGrid<Contract> = {
  id: 'dc-contracts',
  title: 'Contracts',
  noun: 'contract',
  hint: 'Support, maintenance, colocation, power, circuit, licence and lease contracts. Terminate by = min(ends, exit date) − notice days; a circuit’s own contract end is counted too.',
  columns: [
    field<Contract>('id', 'Contract', { required: true }),
    selectField<Contract>('kind', 'Kind', CONTRACT_KIND_OPTIONS),
    field<Contract>('vendor', 'Vendor', { required: true }),
    field<Contract>('ends', 'Ends', { required: true, kind: 'date' }),
    numberField<Contract>('noticeDays', 'Notice days', false),
    {
      key: 'status',
      label: 'Status',
      options: CONTRACT_STATUS_OPTIONS,
      get: (row) => row.status ?? 'active',
      set: (_row, t) => {
        const v = optionValue(CONTRACT_STATUS_OPTIONS, t.trim() || 'active');
        return v === undefined ? { error: `Status: “${t.trim()}” is not one of the choices.` } : ok<Contract>({ status: v as ContractStatus });
      },
    },
  ],
  filterKeys: ['kind', 'status'],
  read: (dc) => dc.contracts,
  write: (dc, rows) => ({ ...dc, contracts: rows.map(tidy) }),
  create: (taken) => ({ id: uniqueId('contract', taken), kind: 'support', vendor: '', ends: '', noticeDays: 90 }),
  after: (_b, n) => tidy(n),
  ids: (dc) => new Set(dc.contracts.map((c) => c.id)),
};

/** Disposed on: refused for a data-bearing asset without a method and a certificate (dc.sanitise). */
const disposedCol: CellColumn<Asset> = {
  key: 'disposedOn',
  label: 'Disposed on',
  get: (row) => row.disposedOn ?? '',
  set: (row, t) => {
    const v = t.trim();
    if (v === '') return ok<Asset>({ disposedOn: undefined });
    const bad = checkValue('Disposed on', v, 'date');
    if (bad) return { error: bad };
    if (row.containsData && (!row.sanitisation || !row.certificateId)) {
      return { error: `Disposed on: ${row.id} holds data; record the NIST SP 800-88 method and the certificate id first (dc.sanitise).` };
    }
    return ok<Asset>({ disposedOn: v });
  },
};

export const ASSETS_GRID: DcGrid<Asset> = {
  id: 'dc-assets',
  title: 'Assets and sanitisation',
  noun: 'asset',
  hint: 'Every piece of hardware leaving the building. An asset holding data needs a NIST SP 800-88 method (clear, purge or destroy) and a certificate id before it can be marked disposed.',
  columns: [
    field<Asset>('id', 'Asset', { required: true }),
    field<Asset>('kind', 'Kind', { required: true }),
    field<Asset>('serial', 'Serial'),
    field<Asset>('location', 'Location'),
    yesNoField<Asset>('containsData', 'Contains data'),
    selectField<Asset>('sanitisation', 'Sanitisation', SANITISATION_OPTIONS, 'Not yet'),
    field<Asset>('certificateId', 'Certificate id'),
    disposedCol,
    yesNoField<Asset>('registerUpdated', 'Register updated'),
  ],
  filterKeys: ['containsData', 'sanitisation'],
  read: (dc) => dc.assets,
  write: (dc, rows) => ({ ...dc, assets: rows.map(tidy) }),
  create: (taken) => ({ id: uniqueId('asset', taken), kind: 'server', containsData: true }),
  after: (_b, n) => tidy(n),
  ids: (dc) => new Set(dc.assets.map((a) => a.id)),
};

/** Every grid on the pane, in the order the sub-tabs show them. */
export const ALL_GRIDS: readonly DcGrid<Row>[] = [...INFRA_GRIDS, EXTERNAL_GRID, CONTRACTS_GRID, ASSETS_GRID] as unknown as readonly DcGrid<Row>[];

/* --------------------------------------------------------------------- CSV --- */

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** A grid's rows as CSV: the column headings, and each cell as the grid shows it. */
export function gridToCsv<T extends Row>(grid: DcGrid<T>, rows: readonly T[]): string {
  const headers = grid.columns.map((c) => c.label);
  if (rows.length === 0) return `${headers.join(',')}\n`;
  return toCsv(rows.map((r) => Object.fromEntries(grid.columns.map((c) => [c.label, c.get(r)]))), headers);
}

/**
 * A CSV into a grid's rows: columns by heading (or key), merged on the first
 * column. Cells a column refuses are reported and left as they were.
 */
export function gridFromCsv<T extends Row>(grid: DcGrid<T>, text: string, rows: readonly T[], taken: ReadonlySet<string>): { rows: T[]; findings: Finding[] } {
  const findings: Finding[] = [];
  const records = parseCsvRecords(text);
  if (records.length === 0) return { rows: [...rows], findings: [warning('dc.csv-empty', `The file has no ${grid.noun} rows.`)] };
  const headers = Object.keys(records[0] as Record<string, string>);
  const colFor = grid.columns.map((c) => headers.find((h) => norm(h) === norm(c.label) || norm(h) === norm(c.key)));
  const key = grid.columns[0] as CellColumn<T>;
  if (colFor[0] === undefined) {
    return { rows: [...rows], findings: [error('dc.csv-columns', `The file has no “${key.label}” column, so its rows cannot be matched. Its columns: ${headers.join(', ')}.`)] };
  }
  const missing = grid.columns.filter((_, i) => colFor[i] === undefined).map((c) => c.label);
  if (missing.length) findings.push(warning('dc.csv-missing', `Columns not in the file (kept as they are): ${missing.join(', ')}.`));
  const out = [...rows];
  const ids = new Set([...taken, ...rows.map((r) => r.id)]);
  records.forEach((rec, n) => {
    const keyText = (rec[colFor[0] as string] ?? '').trim();
    if (!keyText) return;
    let at = out.findIndex((r) => key.get(r).trim().toLowerCase() === keyText.toLowerCase());
    let base: T;
    if (at < 0) {
      base = grid.create(ids);
      ids.add(base.id);
      at = out.length;
      out.push(base);
    } else base = out[at] as T;
    const cells = rowCells(base, grid.columns).map((cell, i) => (colFor[i] === undefined ? cell : (rec[colFor[i] as string] ?? '').trim()));
    // Apply in two passes so a cell that depends on another (Disposed on on the method) sees it.
    let r = applyCells(base, grid.columns, cells);
    if (r.errors.length) {
      const again = applyCells(r.row, grid.columns, cells);
      r = again;
    }
    for (const e of r.errors) findings.push(warning('dc.csv-cell', `Row ${n + 2}: ${e}`));
    out[at] = grid.after ? grid.after(base, r.row) : r.row;
  });
  return { rows: out, findings };
}

/** Ids used twice in one list (a contract or asset typed twice). */
export function duplicateIds(dc: DcExit): Finding[] {
  const out: Finding[] = [];
  const check = (what: string, ids: readonly string[]): void => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) out.push(error('dc.duplicate-id', `${what} “${id}” appears more than once; each needs its own id.`, { path: `${what.toLowerCase()}.${id}` }));
      seen.add(id);
    }
  };
  check('Contract', dc.contracts.map((c) => c.id));
  check('Asset', dc.assets.map((a) => a.id));
  check('Link', dc.external.map((e) => e.id));
  return out;
}

/** The contract statuses as the lights-out check reads them. */
export function contractStatuses(dc: DcExit): Record<string, ContractStatus> {
  return Object.fromEntries(dc.contracts.filter((c) => c.status).map((c) => [c.id, c.status as ContractStatus]));
}

/** Every infra item without a disposition, by grid title, for the summary. */
export function undecided(dc: DcExit): { readonly grid: string; readonly count: number }[] {
  return INFRA_GRIDS.map((g) => ({ grid: g.title, count: g.read(dc).filter((i) => !i.disposition).length })).filter((x) => x.count > 0);
}
