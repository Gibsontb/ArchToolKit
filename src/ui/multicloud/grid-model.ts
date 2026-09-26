/**
 * The intake grids' model side, with no DOM: the plan's rows as " | " grid
 * text (what `tableEditor` in multi-editors.ts edits) and back.
 *
 * Every grid column is a `CellColumn`: how a row shows in the cell (`get`)
 * and what typing or picking a value does to the row (`set`, a patch, or the
 * reason the text was not taken). Closed sets are dropdowns; their options
 * come from options.ts, with a blank entry where blank has a meaning ("decided
 * by the rules", "not decided yet").
 *
 * The grids page through large lists (a 5,000-server estate), so an edit
 * arrives as the page's new text. `reconcilePage` turns the old and new page
 * into edits, removals and additions, and `applyCells` turns one row's
 * changed cells into a patch applied with `editRow`, which records the edited
 * columns so a later import keeps them.
 */

import { editRow } from '../../multicloud/plan/intake/merge.ts';
import { applySizingBasis } from '../../multicloud/plan/intake/sources/sizing-basis.ts';
import { defaultLicenceFor, roleFromName } from '../../multicloud/plan/os.ts';
import {
  BACKUP_FREQUENCY_OPTIONS, BACKUP_TIER_OPTIONS, BANDWIDTH_OPTIONS, CIRCUIT_OPTIONS, CRITICALITY_OPTIONS, DB_DR_OPTIONS,
  DB_EDITION_OPTIONS, DB_ENGINE_OPTIONS, DB_FEATURE_VALUES, DB_HA_OPTIONS, DB_LICENCE_OPTIONS, DB_SERVICE_LABELS,
  DB_VERSION_OPTIONS, DISPOSITION_OPTIONS, EDITIONS_BY_ENGINE, ENV_OPTIONS, GROUPING_RULE_OPTIONS, IP_STRATEGY_OPTIONS,
  AGREEMENT_OPTIONS, OS_LICENCE_OPTIONS, OS_OPTIONS, OS_UPGRADE_OPTIONS, PLATFORM_LABELS, PLATFORM_OPTIONS, RESIDENCY_OPTIONS,
  ROLE_OPTIONS, RPO_BY_CRITICALITY, RPO_OPTIONS, RTO_BY_CRITICALITY, RTO_OPTIONS, SIZING_BASIS_OPTIONS, SKILL_OPTIONS,
  SOURCE_PLATFORM_OPTIONS, WORKLOAD_TYPE_OPTIONS, YES_NO_OPTIONS, itemId, optionValue, platformOfService, versionsFor,
  type PlanOption,
} from '../../multicloud/plan/options.ts';
import { CATALOGUED_DB_SERVICES } from '../../multicloud/plan/db-catalog.ts';
import { familyOf, parseCidrAny } from '../../core/ip.ts';
import type {
  BackupTier, Commitment, Database, DbEngine, DbFeature, GroupingRule, Platform, Site, Skill, Workload,
} from '../../multicloud/plan/types.ts';

export type { PlanOption };

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/** What a cell's text does to a row: a patch, or why it was not taken. */
export type CellResult<T> =
  | {
      readonly patch: Partial<T>;
      /** Keys to record as edited although their value did not change (a confirmation). */
      readonly alsoEdited?: readonly string[];
      /** Keys changed but not recorded as edited (facts, which imports refresh). */
      readonly notEdited?: readonly string[];
    }
  | { readonly error: string };

export interface CellColumn<T> {
  /** Stable id (the model key it mostly writes). */
  readonly key: string;
  /** The grid's column heading. */
  readonly label: string;
  /** Dropdown values; undefined = a text cell. */
  readonly options?: readonly PlanOption[];
  readonly get: (row: T) => string;
  readonly set: (row: T, text: string) => CellResult<T>;
}

const blankOf = (label: string): PlanOption => ({ value: '', label });
const withBlank = (options: readonly PlanOption[], label: string): readonly PlanOption[] => [blankOf(label), ...options];
const ok = <T>(patch: Partial<T>): CellResult<T> => ({ patch });

/** A text cell that writes the trimmed text. */
function textCol<T>(key: keyof T & string, label: string): CellColumn<T> {
  return {
    key,
    label,
    get: (row) => String((row as Record<string, unknown>)[key] ?? ''),
    set: (_row, text) => ok<T>({ [key]: text.trim() } as Partial<T>),
  };
}

/** An optional text cell: blank = undefined. */
function optTextCol<T>(key: keyof T & string, label: string): CellColumn<T> {
  return {
    key,
    label,
    get: (row) => String((row as Record<string, unknown>)[key] ?? ''),
    set: (_row, text) => ok<T>({ [key]: text.trim() || undefined } as Partial<T>),
  };
}

/** A dropdown cell. With `blank`, the blank entry means undefined. */
function selectCol<T>(key: keyof T & string, label: string, options: readonly PlanOption[], blank?: string): CellColumn<T> {
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

/** A whole number ≥ 0 (or any number ≥ 0 with `decimals`). */
function numberCol<T>(key: keyof T & string, label: string, opts: { readonly optional?: boolean; readonly decimals?: boolean } = {}): CellColumn<T> {
  return {
    key,
    label,
    get: (row) => {
      const v = (row as Record<string, unknown>)[key];
      return v === undefined || v === null ? '' : String(v);
    },
    set: (_row, text) => {
      const t = text.trim();
      if (t === '') return opts.optional ? ok<T>({ [key]: undefined } as Partial<T>) : { error: `${label} needs a number.` };
      const n = Number(t);
      if (!Number.isFinite(n) || n < 0 || (!opts.decimals && !Number.isInteger(n))) return { error: `${label}: “${t}” is not a ${opts.decimals ? '' : 'whole '}number of 0 or more.` };
      return ok<T>({ [key]: n } as Partial<T>);
    },
  };
}

/** Space-separated tokens (commas also split). */
export function tokens(text: string): string[] {
  return text.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean);
}

/** Space-separated numbers. */
function numbersCol<T>(key: keyof T & string, label: string): CellColumn<T> {
  return {
    key,
    label,
    get: (row) => ((row as Record<string, unknown>)[key] as readonly number[] | undefined ?? []).join(' '),
    set: (_row, text) => {
      const parts = tokens(text);
      const nums = parts.map(Number);
      const bad = parts.filter((_, i) => !Number.isFinite(nums[i]) || (nums[i] as number) < 0);
      return bad.length > 0 ? { error: `${label}: ${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} not a size in GiB.` } : ok<T>({ [key]: nums } as Partial<T>);
    },
  };
}

/** Space-separated text tokens. */
function listCol<T>(key: keyof T & string, label: string): CellColumn<T> {
  return {
    key,
    label,
    get: (row) => ((row as Record<string, unknown>)[key] as readonly string[] | undefined ?? []).join(' '),
    set: (_row, text) => ok<T>({ [key]: tokens(text) } as Partial<T>),
  };
}

// ---------------------------------------------------------------------------
// The Servers grid (base Screen 2 plus the addendum's columns)
// ---------------------------------------------------------------------------

/** The Type check cell of a detected, unconfirmed type: `? 85%`. */
export function typeCheckText(w: Workload): string {
  if (w.typeConfirmed || (w.edited ?? []).includes('workloadType')) return 'confirmed';
  const d = w.facts?.detection;
  // A generic type (detection under 40%) is the OS's default, not a claim to confirm.
  if (w.workloadType === 'generic-windows' || w.workloadType === 'generic-linux') return '';
  if (!d) return w.workloadType ? '?' : '';
  return `? ${Math.round(d.confidence * 100)}%`;
}

/** An IP address list as typed: each must be IPv4 or IPv6. */
export function readAddresses(text: string): { readonly ok: string[]; readonly bad: string[] } {
  const parts = tokens(text);
  return { ok: parts.filter((p) => familyOf(p) !== null), bad: parts.filter((p) => familyOf(p) === null) };
}

/** The origin a row shows: estate rows without one are vSphere (A.11.1). */
export function originOf(w: Workload): string {
  return w.origin ?? (w.source === 'estate' && w.sourceKey ? 'vsphere' : '');
}

export const WORKLOAD_GRID: readonly CellColumn<Workload>[] = Object.freeze([
  textCol<Workload>('name', 'Name'),
  textCol<Workload>('app', 'App'),
  {
    key: 'origin',
    label: 'Source',
    options: withBlank(SOURCE_PLATFORM_OPTIONS, 'Not known'),
    get: originOf,
    set: (_w, text) => {
      if (!text.trim()) return ok<Workload>({ origin: undefined });
      const v = optionValue(SOURCE_PLATFORM_OPTIONS, text);
      return v ? ok<Workload>({ origin: v }) : { error: `Source: “${text.trim()}” is not a source platform.` };
    },
  },
  {
    key: 'workloadType',
    label: 'Type',
    options: withBlank(WORKLOAD_TYPE_OPTIONS, 'Not detected'),
    get: (w) => w.workloadType ?? '',
    set: (w, text) => {
      if (!text.trim()) return ok<Workload>({ workloadType: undefined, typeConfirmed: undefined });
      const v = optionValue(WORKLOAD_TYPE_OPTIONS, text);
      if (!v) return { error: `Type: “${text.trim()}” is not a workload type.` };
      // Choosing the type is confirming it.
      return { patch: { workloadType: v, typeConfirmed: true }, alsoEdited: v === w.workloadType ? ['workloadType'] : [] };
    },
  },
  {
    key: 'typeConfirmed',
    label: 'Type check',
    // The cell shows the detection (`? 85%`) until Confirmed is picked.
    options: [{ value: 'confirmed', label: 'Confirmed' }],
    get: typeCheckText,
    set: (w, text) => (text.trim().toLowerCase() === 'confirmed'
      ? { patch: { typeConfirmed: true }, alsoEdited: ['workloadType'] }
      : ok<Workload>({ typeConfirmed: w.typeConfirmed })),
  },
  selectCol<Workload>('env', 'Env', ENV_OPTIONS),
  selectCol<Workload>('role', 'Role', ROLE_OPTIONS),
  selectCol<Workload>('os', 'OS', OS_OPTIONS),
  numberCol<Workload>('vcpu', 'vCPU'),
  numberCol<Workload>('ramGib', 'RAM GiB'),
  selectCol<Workload>('basis', 'Basis', SIZING_BASIS_OPTIONS, 'Default for the source'),
  numbersCol<Workload>('disksGib', 'Disks GiB'),
  {
    key: 'ipAddresses',
    label: 'IP addresses',
    get: (w) => (w.facts?.ipAddresses ?? []).join(' '),
    set: (w, text) => {
      const { ok: good, bad } = readAddresses(text);
      if (bad.length > 0) return { error: `IP addresses: ${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} not an IPv4 or IPv6 address.` };
      return { patch: { facts: { ...(w.facts ?? {}), ipAddresses: good } }, notEdited: ['facts'] };
    },
  },
  selectCol<Workload>('ipStrategy', 'IP strategy', IP_STRATEGY_OPTIONS, 'Not decided'),
  optTextCol<Workload>('rename', 'Rename'),
  selectCol<Workload>('upgrade', 'Upgrade', OS_UPGRADE_OPTIONS, 'Not decided'),
  selectCol<Workload>('criticality', 'Criticality', CRITICALITY_OPTIONS),
  selectCol<Workload>('rpo', 'RPO', RPO_OPTIONS),
  selectCol<Workload>('rto', 'RTO', RTO_OPTIONS),
  selectCol<Workload>('licence', 'Licence', OS_LICENCE_OPTIONS),
  selectCol<Workload>('residency', 'Residency', RESIDENCY_OPTIONS, 'App’s / any'),
  selectCol<Workload>('disposition', 'Disposition', DISPOSITION_OPTIONS, 'Decided by rules'),
  listCol<Workload>('dependsOn', 'Depends on'),
  selectCol<Workload>('pin', 'Pin', PLATFORM_OPTIONS, 'Decided'),
]);

/** A hostname a target accepts: RFC 1123 labels; Windows keeps 15 characters for the NetBIOS name. */
export function renameProblem(name: string, windows: boolean): string | undefined {
  const n = name.trim();
  if (!n) return undefined;
  const label = n.split('.')[0] ?? '';
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) return `“${n}” is not a valid host name (letters, digits and hyphens; not starting or ending with a hyphen).`;
  if (windows && label.length > 15) return `“${n}” is longer than the 15 characters a Windows computer name keeps.`;
  return undefined;
}

// ---------------------------------------------------------------------------
// The Databases grid (base Screen 3)
// ---------------------------------------------------------------------------

/** Pin service choices: every catalogued service (core and A.4.9), by platform. */
export const PIN_SERVICE_OPTIONS: readonly PlanOption[] = Object.freeze(
  CATALOGUED_DB_SERVICES.map((id) => ({ value: id, label: `${PLATFORM_LABELS[platformOfService(id)]}: ${DB_SERVICE_LABELS[id]}`, group: PLATFORM_LABELS[platformOfService(id)] })),
);

export const DB_FEATURE_SET: ReadonlySet<string> = new Set(DB_FEATURE_VALUES);

export const DATABASE_GRID: readonly CellColumn<Database>[] = Object.freeze([
  textCol<Database>('name', 'Name'),
  {
    key: 'inferred',
    label: 'Check',
    options: [{ value: 'confirmed', label: 'Confirmed' }],
    get: (d) => (d.inferred ? '? Suggested' : 'confirmed'),
    set: (_d, text) => ok<Database>(text.trim().toLowerCase() === 'confirmed' ? { inferred: false } : {}),
  },
  {
    ...selectCol<Database>('engine', 'Engine', DB_ENGINE_OPTIONS),
    set: (d, text) => {
      const engine = optionValue(DB_ENGINE_OPTIONS, text);
      if (!engine) return { error: `Engine: “${text.trim()}” is not an engine.` };
      if (engine === d.engine) return ok<Database>({});
      // A new engine brings an edition and version that belong to it (not recorded as edited).
      const editions = EDITIONS_BY_ENGINE[engine as DbEngine] ?? [];
      const versions = versionsFor(engine as DbEngine);
      const patch: Partial<Database> = { engine: engine as DbEngine };
      const notEdited: string[] = [];
      if (!editions.includes(d.edition) && editions[0]) { (patch as Record<string, unknown>).edition = editions[0]; notEdited.push('edition'); }
      if (!versions.includes(d.version)) { (patch as Record<string, unknown>).version = versions[0] ?? 'other'; notEdited.push('version'); }
      return { patch, notEdited };
    },
  },
  selectCol<Database>('edition', 'Edition', DB_EDITION_OPTIONS),
  selectCol<Database>('version', 'Version', DB_VERSION_OPTIONS),
  listCol<Database>('hosts', 'Hosts'),
  numberCol<Database>('vcpu', 'vCPU'),
  numberCol<Database>('ramGib', 'RAM GiB'),
  numberCol<Database>('sizeGib', 'Size GiB', { decimals: true }),
  selectCol<Database>('ha', 'HA', DB_HA_OPTIONS),
  selectCol<Database>('dr', 'DR', DB_DR_OPTIONS),
  {
    key: 'features',
    label: 'Features',
    get: (d) => d.features.join(' '),
    set: (_d, text) => {
      const parts = tokens(text.toLowerCase());
      const bad = parts.filter((p) => !DB_FEATURE_SET.has(p));
      return bad.length > 0
        ? { error: `Features: ${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} not in the list (${[...DB_FEATURE_SET].join(' ')}).` }
        : ok<Database>({ features: [...new Set(parts)] as DbFeature[] });
    },
  },
  selectCol<Database>('licence', 'Licence', DB_LICENCE_OPTIONS),
  textCol<Database>('app', 'App'),
  selectCol<Database>('pinService', 'Pin service', PIN_SERVICE_OPTIONS, 'Decided'),
]);

// ---------------------------------------------------------------------------
// The constraint grids (sites, backup tiers, commitments, skills, grouping)
// ---------------------------------------------------------------------------

export const SITE_GRID: readonly CellColumn<Site>[] = Object.freeze([
  textCol<Site>('name', 'Site'),
  optTextCol<Site>('vpnPeer', 'VPN peer address (IPv4 or IPv6)'),
  numberCol<Site>('bgpAsn', 'BGP ASN', { optional: true }),
  listCol<Site>('cidrs', 'On-prem CIDRs (either family)'),
  selectCol<Site>('bandwidth', 'Bandwidth', BANDWIDTH_OPTIONS),
  selectCol<Site>('circuit', 'Private circuit', CIRCUIT_OPTIONS),
  optTextCol<Site>('circuitLocation', 'Circuit location'),
]);
export const BLANK_SITE: Site = Object.freeze({ name: '', cidrs: [], bandwidth: '1g', circuit: 'none' });

const yesNoCol = <T>(key: keyof T & string, label: string): CellColumn<T> => ({
  key,
  label,
  options: YES_NO_OPTIONS,
  get: (row) => ((row as Record<string, unknown>)[key] ? 'yes' : 'no'),
  set: (_row, text) => {
    const v = optionValue(YES_NO_OPTIONS, text);
    return v ? ok<T>({ [key]: v === 'yes' } as Partial<T>) : { error: `${label}: choose Yes or No.` };
  },
});

export const BACKUP_TIER_GRID: readonly CellColumn<BackupTier>[] = Object.freeze([
  selectCol<BackupTier>('tier', 'Tier', BACKUP_TIER_OPTIONS),
  selectCol<BackupTier>('frequency', 'Frequency', BACKUP_FREQUENCY_OPTIONS),
  numberCol<BackupTier>('retentionDays', 'Retention days'),
  yesNoCol<BackupTier>('copyToDr', 'Copy to DR region'),
  yesNoCol<BackupTier>('immutable', 'Immutable'),
]);
export const BLANK_BACKUP_TIER: BackupTier = Object.freeze({ tier: 'silver', frequency: '24h', retentionDays: 30, copyToDr: false, immutable: false });

export const COMMITMENT_GRID: readonly CellColumn<Commitment>[] = Object.freeze([
  selectCol<Commitment>('platform', 'Platform', PLATFORM_OPTIONS),
  selectCol<Commitment>('agreement', 'Agreement', AGREEMENT_OPTIONS),
  numberCol<Commitment>('annual', 'Annual commit', { optional: true, decimals: true }),
  {
    key: 'ends',
    label: 'Ends (yyyy-mm)',
    get: (c) => c.ends ?? '',
    set: (_c, text) => {
      const t = text.trim();
      if (!t) return ok<Commitment>({ ends: undefined });
      return /^\d{4}-(0[1-9]|1[0-2])$/.test(t) ? ok<Commitment>({ ends: t }) : { error: `Ends: “${t}” is not a month as yyyy-mm.` };
    },
  },
]);
export const BLANK_COMMITMENT: Commitment = Object.freeze({ platform: 'aws', agreement: 'edp' });

export interface SkillRow { readonly platform: Platform; readonly skill: Skill }
export const SKILL_GRID: readonly CellColumn<SkillRow>[] = Object.freeze([
  selectCol<SkillRow>('platform', 'Platform', PLATFORM_OPTIONS),
  selectCol<SkillRow>('skill', 'Skill', SKILL_OPTIONS),
]);
export const BLANK_SKILL: SkillRow = Object.freeze({ platform: 'aws', skill: 'none' });

export const GROUPING_GRID: readonly CellColumn<GroupingRule>[] = Object.freeze([
  selectCol<GroupingRule>('rule', 'Rule', GROUPING_RULE_OPTIONS),
  optTextCol<GroupingRule>('key', 'Key or pattern'),
]);
export const BLANK_GROUPING_RULE: GroupingRule = Object.freeze({ rule: 'attribute' });

// ---------------------------------------------------------------------------
// Grid text
// ---------------------------------------------------------------------------

/** One grid line's cells, split as `tableEditor` splits a spaced table (on " | " only). */
export function splitGridLine(line: string, n: number): string[] {
  const cells = ` ${line} `.split(/(?<=\s)\|(?=\s)/);
  return Array.from({ length: n }, (_, i) => (cells[i] ?? '').trim());
}

/** What `tableEditor` does to a cell before joining: no newlines, and a spaced pipe closes up. */
export function cleanCell(cell: string): string {
  return cell.replace(/\n/g, ' ').replace(/\s+\|\s+/g, '|').trim();
}

/** Rows of cells as the grid's value. */
export function gridText(rows: readonly (readonly string[])[]): string {
  return rows.map((r) => r.map(cleanCell).join(' | ')).join('\n');
}

/** The grid's value as rows of cells (blank lines and comments skipped, as the editor does). */
export function parseGridText(text: string, n: number): string[][] {
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => splitGridLine(l, n));
}

export function rowCells<T>(row: T, columns: readonly CellColumn<T>[]): string[] {
  return columns.map((c) => cleanCell(c.get(row)));
}

const sameRow = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((c, i) => c === b[i]);

export type PageOp =
  | { readonly kind: 'edit'; readonly index: number; readonly cells: readonly string[] }
  | { readonly kind: 'remove'; readonly index: number }
  | { readonly kind: 'add'; readonly cells: readonly string[] };

/**
 * The page's rows before and after one change, as operations on the page's
 * row indices: an edit (same count), a removal (× on a row, or a row whose
 * cells were all cleared), additions (Add row, then typing), or anything
 * after "Edit as text" (matched by position).
 */
export function reconcilePage(before: readonly (readonly string[])[], after: readonly (readonly string[])[]): PageOp[] {
  const ops: PageOp[] = [];
  if (after.length < before.length) {
    // Rows taken out, the rest unchanged: find them in order.
    const removed: number[] = [];
    let j = 0;
    for (let i = 0; i < before.length; i += 1) {
      if (j < after.length && sameRow(before[i]!, after[j]!)) j += 1;
      else removed.push(i);
    }
    if (j === after.length && removed.length === before.length - after.length) {
      return removed.map((index) => ({ kind: 'remove', index }));
    }
  }
  const common = Math.min(before.length, after.length);
  for (let i = 0; i < common; i += 1) if (!sameRow(before[i]!, after[i]!)) ops.push({ kind: 'edit', index: i, cells: after[i]! });
  for (let i = common; i < before.length; i += 1) ops.push({ kind: 'remove', index: i });
  for (let i = common; i < after.length; i += 1) ops.push({ kind: 'add', cells: after[i]! });
  return ops;
}

/** Row patch helpers the grids share. */
export interface ApplyResult<T> {
  readonly row: T;
  readonly errors: readonly string[];
  /** The model keys the edit changed. */
  readonly changed: readonly string[];
}

/**
 * One row's changed cells applied: each changed column's `set`, merged into
 * one patch, then `editRow` (which records the edited keys). Cells whose text
 * is not taken leave the row as it was and report why.
 */
export function applyCells<T extends { readonly id: string; readonly name?: string; readonly edited?: readonly string[] }>(
  row: T, columns: readonly CellColumn<T>[], cells: readonly string[],
): ApplyResult<T> {
  const before = rowCells(row, columns);
  const patch: Record<string, unknown> = {};
  const alsoEdited = new Set<string>();
  const notEdited = new Set<string>();
  const errors: string[] = [];
  columns.forEach((col, i) => {
    const text = cells[i] ?? '';
    if (text === before[i]) return;
    const r = col.set({ ...row, ...(patch as Partial<T>) }, text);
    if ('error' in r) {
      errors.push(r.error);
      return;
    }
    Object.assign(patch, r.patch);
    for (const k of r.alsoEdited ?? []) alsoEdited.add(k);
    for (const k of r.notEdited ?? []) notEdited.add(k);
  });
  const trackEdits = 'edited' in row || 'name' in row;
  let out: T = row;
  if (trackEdits) {
    out = editRow(row as T & { name: string }, patch as Partial<T & { name: string }>) as T;
  } else {
    out = { ...row, ...(patch as Partial<T>) };
  }
  const changed = Object.keys(patch).filter((k) => JSON.stringify((row as Record<string, unknown>)[k]) !== JSON.stringify((out as Record<string, unknown>)[k]));
  if (trackEdits && (alsoEdited.size > 0 || notEdited.size > 0)) {
    const prior = new Set(row.edited ?? []);
    const edited = new Set<string>(out.edited ?? []);
    for (const k of alsoEdited) edited.add(k);
    for (const k of notEdited) if (!prior.has(k)) edited.delete(k);
    out = { ...out, edited: [...edited] } as T;
    if (edited.size === 0) {
      const { edited: _e, ...rest } = out as Record<string, unknown>;
      out = rest as unknown as T;
    }
  }
  return { row: out, errors, changed };
}

/** Rows of a small list grid (no ids) read whole: each line's cells applied to the blank row. */
export function listFromGrid<T>(text: string, columns: readonly CellColumn<T>[], blank: T): { rows: T[]; errors: string[] } {
  const errors: string[] = [];
  const rows = parseGridText(text, columns.length).map((cells, r) => {
    let row: T = { ...blank };
    columns.forEach((col, i) => {
      const cell = cells[i] ?? '';
      if (cell === '' && col.options && !col.options.some((o) => o.value === '')) return;
      const res = col.set(row, cell);
      if ('error' in res) errors.push(`Row ${r + 1}: ${res.error}`);
      else row = { ...row, ...res.patch };
    });
    return row;
  });
  return { rows, errors };
}

/** A small list as grid text. */
export function listToGrid<T>(rows: readonly T[], columns: readonly CellColumn<T>[]): string {
  return gridText(rows.map((r) => rowCells(r, columns)));
}

// ---------------------------------------------------------------------------
// Rows added in the grid
// ---------------------------------------------------------------------------

function uniqueId(prefix: 'workload' | 'database', name: string, taken: ReadonlySet<string>): string {
  const base = itemId(prefix, name || 'new');
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** A workload typed into the grid: the documented defaults, then the typed cells. */
export function newWorkload(existing: readonly Workload[]): Workload {
  const taken = new Set(existing.map((w) => w.id));
  const id = uniqueId('workload', '', taken);
  return {
    id,
    name: '',
    app: '',
    env: 'prod',
    role: 'other',
    os: 'unknown',
    vcpu: 2,
    ramGib: 4,
    disksGib: [],
    criticality: 'tier2',
    rpo: RPO_BY_CRITICALITY.tier2,
    rto: RTO_BY_CRITICALITY.tier2,
    licence: defaultLicenceFor('unknown'),
    dependsOn: [],
    source: 'manual',
  };
}

export function newDatabase(existing: readonly Database[]): Database {
  const taken = new Set(existing.map((d) => d.id));
  return {
    id: uniqueId('database', '', taken),
    name: '',
    engine: 'sqlserver',
    edition: 'sql-standard',
    version: 'sql-2022',
    hosts: [],
    vcpu: 0,
    ramGib: 0,
    sizeGib: 0,
    ha: 'none',
    dr: 'none',
    features: [],
    licence: 'li',
    app: '',
    source: 'manual',
  };
}

/**
 * What follows from a workload edit:
 * - a new name gives a new id when the old id came from the old name (and
 *   the new one is free), and a role from the name for a row typed in;
 * - criticality brings its RPO and RTO unless those were edited;
 * - a basis change re-applies the sizing basis (A.3.6).
 */
export function afterWorkloadEdit(before: Workload, after: Workload, all: readonly Workload[]): Workload {
  let w = after;
  const edited = new Set(w.edited ?? []);
  if (before.name !== w.name) {
    const taken = new Set(all.filter((x) => x.id !== before.id).map((x) => x.id));
    const derived = before.id === itemId('workload', before.name) || /^w:new(-\d+)?$/.test(before.id);
    const next = itemId('workload', w.name);
    if (derived && w.name.trim() && !taken.has(next)) w = { ...w, id: next };
    if (w.source === 'manual' && !edited.has('role')) w = { ...w, role: roleFromName(w.name) };
  }
  if (before.criticality !== w.criticality) {
    if (!edited.has('rpo')) w = { ...w, rpo: RPO_BY_CRITICALITY[w.criticality] };
    if (!edited.has('rto')) w = { ...w, rto: RTO_BY_CRITICALITY[w.criticality] };
  }
  if (before.os !== w.os && !edited.has('licence')) w = { ...w, licence: defaultLicenceFor(w.os) };
  if (before.basis !== w.basis && !edited.has('vcpu') && !edited.has('ramGib')) {
    w = applySizingBasis(w, w.basis ? { basis: w.basis } : {}).workload;
  }
  return w;
}

/** A database's id follows its name the same way. */
export function afterDatabaseEdit(before: Database, after: Database, all: readonly Database[]): Database {
  if (before.name === after.name) return after;
  const taken = new Set(all.filter((x) => x.id !== before.id).map((x) => x.id));
  const derived = before.id === itemId('database', before.name) || /^d:new(-\d+)?$/.test(before.id);
  const next = itemId('database', after.name);
  return derived && after.name.trim() && !taken.has(next) ? { ...after, id: next } : after;
}

// ---------------------------------------------------------------------------
// Filters, pages and bulk edits
// ---------------------------------------------------------------------------

export interface GridFilter {
  /** Column key → the value it must have ('' = any). */
  readonly equals: Readonly<Record<string, string>>;
  /** Free text matched against every cell. */
  readonly text: string;
}

/** The indices of the rows that pass the filter, in order. */
export function filterRows<T>(rows: readonly T[], columns: readonly CellColumn<T>[], filter: GridFilter): number[] {
  const wanted = Object.entries(filter.equals).filter(([, v]) => v !== '');
  const byKey = new Map(columns.map((c) => [c.key, c]));
  const q = filter.text.trim().toLowerCase();
  const out: number[] = [];
  rows.forEach((row, i) => {
    for (const [key, value] of wanted) {
      const col = byKey.get(key);
      if (!col) continue;
      const got = col.get(row);
      if (value === '(blank)' ? got !== '' : got !== value) return;
    }
    if (q && !columns.some((c) => c.get(row).toLowerCase().includes(q))) return;
    out.push(i);
  });
  return out;
}

export interface Page {
  readonly indices: readonly number[];
  readonly page: number;
  readonly pages: number;
}

export function pageOf(indices: readonly number[], page: number, size: number): Page {
  const pages = Math.max(1, Math.ceil(indices.length / size));
  const p = Math.min(Math.max(0, page), pages - 1);
  return { indices: indices.slice(p * size, p * size + size), page: p, pages };
}

/** "Set column … to …" on the given rows. */
export function bulkSet<T extends { readonly id: string; readonly name?: string; readonly edited?: readonly string[] }>(
  rows: readonly T[], indices: readonly number[], columns: readonly CellColumn<T>[], key: string, value: string,
  after?: (before: T, next: T, all: readonly T[]) => T,
): { rows: T[]; changed: number; errors: string[] } {
  const colIndex = columns.findIndex((c) => c.key === key);
  if (colIndex < 0) return { rows: [...rows], changed: 0, errors: [`No column ${key}.`] };
  const out = [...rows];
  let changed = 0;
  const errors = new Set<string>();
  for (const i of indices) {
    const row = out[i];
    if (!row) continue;
    const cells = rowCells(row, columns);
    cells[colIndex] = value;
    const r = applyCells(row, columns, cells);
    for (const e of r.errors) errors.add(e);
    if (r.row !== row) {
      out[i] = after ? after(row, r.row, out) : r.row;
      changed += 1;
    }
  }
  return { rows: out, changed, errors: [...errors] };
}

/** The distinct values of a column, for its filter dropdown (with labels from the options). */
export function columnValues<T>(rows: readonly T[], column: CellColumn<T>): PlanOption[] {
  const seen = new Map<string, number>();
  for (const r of rows) {
    const v = column.get(r);
    seen.set(v, (seen.get(v) ?? 0) + 1);
  }
  const labelFor = (v: string): string => (v === '' ? '(blank)' : column.options?.find((o) => o.value === v)?.label ?? v);
  return [...seen.entries()]
    .sort((a, b) => labelFor(a[0]).localeCompare(labelFor(b[0])))
    .map(([v, n]) => ({ value: v === '' ? '(blank)' : v, label: `${labelFor(v)} (${n})` }));
}

// ---------------------------------------------------------------------------
// Checks the grids show that the plan validation does not
// ---------------------------------------------------------------------------

/** Site cells that must be addresses: the VPN peer (IPv4 or IPv6) and each CIDR (either family). */
export function siteProblems(sites: readonly Site[]): string[] {
  const out: string[] = [];
  sites.forEach((s, i) => {
    const label = s.name || `row ${i + 1}`;
    if (!s.name.trim()) out.push(`Site on row ${i + 1} has no name.`);
    if (s.vpnPeer && familyOf(s.vpnPeer) === null) out.push(`${label}: VPN peer “${s.vpnPeer}” is not an IPv4 or IPv6 address.`);
    for (const c of s.cidrs) if (!parseCidrAny(c)) out.push(`${label}: “${c}” is not a CIDR (IPv4 or IPv6, as network/prefix).`);
    if (s.bgpAsn !== undefined && (s.bgpAsn < 1 || s.bgpAsn > 4294967295)) out.push(`${label}: BGP ASN ${s.bgpAsn} is outside 1–4294967295.`);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Type detection on the Servers grid (A.3.7)
// ---------------------------------------------------------------------------

/** A detected type is shown with "?" until confirmed; this is confidence ≥ 0.7 (detect-data.ts). */
export const DETECTED_AT = 0.7;

/** Servers whose type still waits for a person: detected-but-unconfirmed and "unknown — confirm". */
export function typesToConfirm(rows: readonly Workload[]): { readonly index: number; readonly workload: Workload }[] {
  const out: { index: number; workload: Workload }[] = [];
  rows.forEach((w, index) => {
    if (w.typeConfirmed || (w.edited ?? []).includes('workloadType')) return;
    if (!w.facts?.detection) return;
    const t = w.workloadType;
    if (t === 'generic-windows' || t === 'generic-linux') return;
    out.push({ index, workload: w });
  });
  return out;
}

/**
 * Confirm the types of the given rows: a detected type (≥ 0.7) is confirmed
 * as it is; `type` sets and confirms another. Rows in the confirm band with no
 * `type` given are left for a person.
 */
export function confirmTypes(rows: readonly Workload[], indices: readonly number[], type?: Workload['workloadType']): { rows: Workload[]; changed: number } {
  const out = [...rows];
  let changed = 0;
  for (const i of indices) {
    const w = out[i];
    if (!w) continue;
    const next = type ?? (w.workloadType && w.workloadType !== 'unknown' ? w.workloadType : undefined);
    if (!next) continue;
    if (w.typeConfirmed && w.workloadType === next) continue;
    const edited = [...new Set([...(w.edited ?? []), 'workloadType', 'typeConfirmed'])] as Workload['edited'];
    out[i] = { ...w, workloadType: next, typeConfirmed: true, edited };
    changed += 1;
  }
  return { rows: out, changed };
}
