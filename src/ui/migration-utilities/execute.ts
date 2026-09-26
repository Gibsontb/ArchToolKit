/**
 * Execute (`#execute`) on Multi-Cloud Migration & Utilities (addendum A.6.1,
 * A.7.6): the execution settings and the wave console.
 *
 * - `#execute:settings`: every §A.6.1 setting kept in `plan.execution`, as one
 *   form (every closed set a dropdown, the lists " | " grids); the path of
 *   every item with its override dropdown, where a refused override says why;
 *   and the execution kit (`migration/execute/`) to download. One cloud at a
 *   time: the landing-zone state and the migration-tool settings are the
 *   chosen cloud's (the cloud dropdown of multicloud/cloud-choice.ts); the
 *   rest applies to every cloud.
 * - `#execute:<wave>/<stage>`: one wave at a time. A wave dropdown and the
 *   stage tabs (pre-check, replicate, test, cutover, validate, commit,
 *   rollback, decommission). Per stage: the exact commands from the kit, with
 *   a copy button, and what each path script is called with; the runbook
 *   tasks as a checklist (a tick is a manual event); the gate panel (criteria
 *   evaluated from the tracker, the attestations, the sign-off, and Record
 *   decision, which downloads the gate file); Import status; the wave's
 *   items and their states; and the stage's notices.
 */

import { el, append, clear, downloadFile } from '../dom.ts';
import { card, findingsList } from '../components.ts';
import { renderBlueprintForm } from '../blueprint-form.ts';
import type { PaneContext } from '../plan-shell.ts';
import type { BlueprintInput, SelectOption } from '../../kit/blueprint.ts';
import { zip } from '../../kit/archive.ts';
import {
  AZURE_MIGRATE_DISK_TYPE_OPTIONS, AZURE_SECURITY_TYPE_OPTIONS, CRITICALITY_OPTIONS, CRITICALITY_VALUES, DATA_COPY_METHOD_OPTIONS,
  DMS_CAPACITY_UNITS_OPTIONS, DNS_PROVIDER_OPTIONS, GATE_DECISION_OPTIONS, GATE_ID_OPTIONS, HCX_WINDOW_HOURS_OPTIONS, ITEM_STATE_OPTIONS,
  LANDING_ZONE_STATE_OPTIONS, LB_KIND_OPTIONS, MGN_IP_PROTOCOL_OPTIONS, MGN_REPLICATION_OPTIONS, PLATFORM_LABELS, RACI_ROLE_OPTIONS,
  SIGN_OFF_DECISION_OPTIONS, SIGN_OFF_KIND_OPTIONS, YES_NO_OPTIONS, defaultExecution, labelOf,
} from '../../multicloud/plan/options.ts';
import type {
  Criticality, DataCopyMethod, DmsCapacityUnits, DnsProvider, ExecutionSettings, GateDecision, GateId, HcxWindowHours, LbKind,
  LandingZoneState, MgnIpProtocol, MgnReplication, Plan, Platform, RaciRole, SignOffDecision, SignOffKind, Tracker,
  AzureMigrateDiskType, AzureSecurityType, DbMovePath, MovePath, ItemId, PlanDecision,
} from '../../multicloud/plan/types.ts';
import { executionKit, EXECUTE_DIR, type ExecutionKit } from '../../multicloud/plan/execute/kit.ts';
import { checkPathOverride, pathLabel, type PathResolution } from '../../multicloud/plan/execute/paths.ts';
import type { ExecPath, Verb } from '../../multicloud/plan/execute/contract.ts';
import { waveSpecs, type WaveSpec } from '../../multicloud/plan/execute/waves/common.ts';
import {
  CUTOVER, PRE_MIGRATION, ROLLBACK, providerSteps, waveTimeline as waveTMinus, type RunbookTask,
} from '../../multicloud/plan/execute/waves/timeline.ts';
import {
  FOUNDATION_ITEMS, WAVE_GATES, evaluateLandingZoneGate, landingZoneGateFile,
} from '../../multicloud/plan/execute/waves/gates.ts';
import { boardRows } from '../../multicloud/plan/track/board.ts';
import { gateFilePath, signOffId } from '../../multicloud/plan/track/gates.ts';
import { recordDecision } from '../../multicloud/plan/track/raid.ts';
import { newRunId } from '../../multicloud/plan/track/states.ts';
import { accountable, defaultRaci, raciRoleLabel, type RaciActivityId } from '../../multicloud/plan/governance/raci.ts';
import { recordSignOff, whoCanSign } from '../../multicloud/plan/governance/signoffs.ts';
import { COMMS_TEMPLATES, renderNotice, waveViews, type CommsTemplateId } from '../../multicloud/plan/governance/comms.ts';
import { fill, note, rowsTable, subhead } from '../multicloud/pane-kit.ts';
import { CLOUD_NAMES, cloudPicker, cloudUsage, onCloudChange, resolveCloud, viewerCloud } from '../multicloud/cloud-choice.ts';
import {
  commitTracker, decideGate, gateCriteria, gateDownloadName, importStatusControl, nowIso, otherPlanNode, todayIso, watchTrack,
  waveEvent, withEvent, type TrackView,
} from './track-kit.ts';

// ---------------------------------------------------------------------------
// Stages (pure)
// ---------------------------------------------------------------------------

export const STAGES = ['precheck', 'replicate', 'test', 'cutover', 'validate', 'commit', 'rollback', 'decommission'] as const;
export type Stage = (typeof STAGES)[number];

export interface StageInfo {
  readonly label: string;
  /** The wave script, in `waves/wave-<n>/`. */
  readonly file: string;
  /** Extra forms of the command worth showing. */
  readonly variants: readonly { readonly args: string; readonly why: string }[];
  /** The path-script verbs the wave script calls. */
  readonly verbs: readonly Verb[];
  /** The gate decided at this stage. */
  readonly gate?: GateId;
  readonly runbook: 'pre' | 'cutover' | 'rollback';
  /** The runbook task ids shown (all of the runbook when empty). */
  readonly tasks?: readonly string[];
  readonly comms: readonly CommsTemplateId[];
}

export const STAGE_INFO: Readonly<Record<Stage, StageInfo>> = {
  precheck: {
    label: 'Pre-check', file: 'precheck.sh', verbs: [], gate: 'G1', runbook: 'pre',
    variants: [{ args: '--stage replicate', why: 'before replication starts' }, { args: '--stage cutover', why: 'at G1 and again at T−0' }],
    comms: ['t-28-commit', 't-21-replication'],
  },
  replicate: {
    label: 'Replicate', file: 'replicate.sh', verbs: ['prepare', 'replicate', 'status'], runbook: 'pre', tasks: ['P3', 'P4', 'P7'],
    variants: [{ args: '--once', why: 'poll once and exit (for cron), recording progress' }],
    comms: ['t-21-replication', 't-14-announce'],
  },
  test: {
    label: 'Test', file: 'test.sh', verbs: ['test', 'test-cleanup'], gate: 'G1', runbook: 'pre', tasks: ['P9', 'P10', 'P12', 'P13'],
    variants: [],
    comms: ['t-14-announce', 't-7-readiness', 't-2-reminder', 'user-access-change'],
  },
  cutover: {
    label: 'Cutover', file: 'cutover.sh', verbs: ['cutover'], gate: 'G2', runbook: 'cutover',
    variants: [{ args: '--item <name>', why: 'one item only' }, { args: '--continue-on-item-failure', why: 'carry on with the other items when one fails' }],
    comms: ['t-1-go-no-go', 'freeze-start', 'cutover-start', 'cutover-complete'],
  },
  validate: {
    label: 'Validate', file: 'validate.sh', verbs: [], gate: 'G3', runbook: 'cutover', tasks: ['C11', 'C12', 'C13'],
    variants: [{ args: '--baseline', why: 'capture the performance baseline (T−7 and T−1)' }],
    comms: ['cutover-complete'],
  },
  commit: {
    label: 'Commit', file: 'commit.sh', verbs: ['commit'], gate: 'G3', runbook: 'cutover', tasks: ['C12', 'C13'],
    variants: [],
    comms: ['hypercare-end'],
  },
  rollback: {
    label: 'Rollback', file: 'rollback.sh', verbs: ['rollback'], runbook: 'rollback',
    variants: [{ args: '--rehearse --item <nonprod item>', why: 'the rollback rehearsal G1 needs for paths without a test' }, { args: '--after-commit "<reason>"', why: 'after commit: prints the data-loss statement first' }],
    comms: ['rollback-notice'],
  },
  decommission: {
    label: 'Decommission', file: 'decommission.sh', verbs: ['finalize'], gate: 'G4', runbook: 'rollback', tasks: [],
    variants: [{ args: '--check-backups', why: 'only check the target backups' }],
    comms: ['decommission-notice'],
  },
};

const RUNBOOKS: Readonly<Record<StageInfo['runbook'], readonly RunbookTask[]>> = { pre: PRE_MIGRATION, cutover: CUTOVER, rollback: ROLLBACK };

/** The runbook tasks a stage shows. */
export function stageTasks(stage: Stage): RunbookTask[] {
  const info = STAGE_INFO[stage];
  if (stage === 'decommission') return [];
  const all = RUNBOOKS[info.runbook];
  return info.tasks && info.tasks.length ? all.filter((t) => info.tasks?.includes(t.id)) : [...all];
}

export type ExecuteRoute = { readonly settings: true } | { readonly settings: false; readonly wave?: number; readonly stage: Stage };

/** `settings`, `<wave>/<stage>`, `<wave>` or '' (the first wave, pre-check). */
export function parseExecuteArg(arg: string): ExecuteRoute {
  const a = arg.trim();
  if (a === 'settings') return { settings: true };
  const [w, s] = a.split('/');
  const wave = w && /^\d+$/.test(w) ? Number(w) : undefined;
  const stage = (STAGES as readonly string[]).includes(s ?? '') ? (s as Stage) : 'precheck';
  return { settings: false, ...(wave !== undefined ? { wave } : {}), stage };
}

/** The hash of a console view. */
export const consoleHash = (wave: number, stage: Stage): string => `execute:${wave}/${stage}`;

export interface PathScript {
  readonly script: string;
  readonly path: ExecPath;
  readonly items: number;
}

/**
 * The commands a stage runs, relative to `migration/execute/`: the wave script
 * (and its useful variants), then each path script with the verbs the wave
 * script calls, PowerShell scripts through `pwsh -File`.
 */
export function stageCommands(wave: number, stage: Stage, scripts: readonly PathScript[] = []): { main: string; dryRun: string; variants: { command: string; why: string }[]; paths: string[] } {
  const info = STAGE_INFO[stage];
  const main = `./waves/wave-${wave}/${info.file}`;
  const paths: string[] = [];
  for (const s of scripts) {
    for (const verb of info.verbs) {
      paths.push(s.script.endsWith('.ps1')
        ? `pwsh -File ./${s.script} ${verb} -Wave ${wave}${verb === 'status' ? ' -Once' : ''}`
        : `./${s.script} ${verb} --wave ${wave}${verb === 'status' ? ' --once' : ''}`);
    }
  }
  return {
    main,
    dryRun: `${main} --dry-run`,
    variants: info.variants.map((v) => ({ command: `${main} ${v.args}`, why: v.why })),
    paths,
  };
}

/** The path scripts of a wave's items (from the kit's manifest). */
export function pathScripts(kit: Pick<ExecutionKit, 'manifest'>, wave: number): PathScript[] {
  const by = new Map<string, PathScript>();
  for (const i of kit.manifest.items) {
    if (i.wave !== wave || !i.script) continue;
    const had = by.get(i.script);
    by.set(i.script, { script: i.script, path: i.path, items: (had?.items ?? 0) + 1 });
  }
  return [...by.values()].sort((a, b) => a.script.localeCompare(b.script));
}

/** Which runbook tasks are ticked for a wave: the latest manual event per task wins. */
export function tickedTasks(tracker: Pick<Tracker, 'events'>, wave: number): Set<string> {
  const latest = new Map<string, { at: string; done: boolean }>();
  for (const e of tracker.events) {
    if (e.wave !== wave || e.item !== null || e.source !== 'manual' || typeof e.data?.task !== 'string') continue;
    const had = latest.get(e.data.task);
    if (!had || had.at <= e.at) latest.set(e.data.task, { at: e.at, done: e.data.done !== false });
  }
  return new Set([...latest.entries()].filter(([, v]) => v.done).map(([k]) => k));
}

/** Criteria the operator attests (the tracker cannot see them). */
export const ATTESTABLE: Readonly<Record<string, string>> = {
  'g2.rollback-owner': 'The rollback decision-maker is named and present',
  'g1.change-request': 'The change request is approved (outside the tracker)',
};

/** The sign-off a gate needs, and the RACI activity whose roles decide it. */
export const GATE_SIGN_OFF: Readonly<Partial<Record<GateId, { kind: SignOffKind; scope: 'app' | 'wave'; activity: RaciActivityId }>>> = {
  G1: { kind: 'test-passed', scope: 'app', activity: 'gate-g1' },
  G2: { kind: 'go', scope: 'wave', activity: 'gate-g2' },
  G3: { kind: 'accepted', scope: 'app', activity: 'gate-g3' },
  G4: { kind: 'decom-approved', scope: 'wave', activity: 'gate-g4' },
};

// ---------------------------------------------------------------------------
// Execution settings as a form (pure)
// ---------------------------------------------------------------------------

const opt = (value: string, label = value, group?: string): SelectOption => (group ? { value, label, group } : { value, label });
const grouped = (options: readonly { value: string; label: string }[], group: string): SelectOption[] => options.map((o) => opt(o.value, o.label, group));
/**
 * A " | " grid by declaration: a textarea with options makes the form draw a
 * grid; a grid with no dropdown column still needs one option, grouped under
 * no column, to be drawn as a grid.
 */
const NO_COLUMN = opt('', '', '__none__');

const crit = (c: Criticality): string => labelOf(CRITICALITY_OPTIONS, c);
const SECTION_TOOLS = 'Migration tools';

/** The cloud each migration tool's settings belong to (by input id prefix). */
export function toolCloud(id: string): Platform | undefined {
  if (/^(mgn|dms)\./.test(id)) return 'aws';
  if (id.startsWith('azure.')) return 'azure';
  if (id.startsWith('m2vm.')) return 'google';
  if (id.startsWith('ocm.')) return 'oci';
  if (id.startsWith('hcx.') || id === 'vcfImportClusters') return 'vmware';
  return undefined;
}

/**
 * The settings form's inputs (the plan's apps and workloads feed the grids'
 * dropdowns). `tools`, when given, keeps only those clouds' migration-tool
 * settings (one cloud at a time on the pane); without it every tool shows.
 */
export function executionInputs(plan: Pick<Plan, 'apps' | 'workloads' | 'decision'>, platforms: readonly Platform[], tools?: readonly Platform[]): BlueprintInput[] {
  const apps = plan.apps.map((a) => opt(a.name, a.name, 'App'));
  const servers = plan.workloads.map((w) => opt(w.name, w.name, 'Workload'));
  const inputs: BlueprintInput[] = [];
  for (const c of CRITICALITY_VALUES) inputs.push({ id: `keep.${c}`, label: `Keep the source after cutover: ${crit(c)} (days)`, control: 'number', min: 0, max: 365 });
  for (const c of CRITICALITY_VALUES) inputs.push({ id: `hyper.${c}`, label: `Hypercare: ${crit(c)} (days)`, control: 'number', min: 0, max: 90 });
  inputs.push({ id: 'lag.server', label: 'Replication lag allowed at cutover: servers (seconds)', control: 'number', min: 0 });
  inputs.push({ id: 'lag.db', label: 'Replication lag allowed at cutover: databases (seconds)', control: 'number', min: 0, hint: '0 = the final sync waits for zero lag' });
  for (const p of platforms) {
    inputs.push({ id: `lz.${p}`, label: `Landing zone: ${p === 'vmware' ? 'VMware Cloud Foundation (VCF 9.1)' : PLATFORM_LABELS[p]}`, control: 'select', options: LANDING_ZONE_STATE_OPTIONS.map((o) => opt(o.value, o.label)), blankLabel: 'Missing', hint: 'Generated lets production waves pass the landing-zone gate' });
  }
  inputs.push(
    { id: 'dnsZones', label: 'DNS zones', control: 'textarea', hint: 'Zone | Provider | Zone id | View | Private', options: [...grouped(DNS_PROVIDER_OPTIONS, 'Provider'), ...grouped(YES_NO_OPTIONS, 'Private')], help: 'The zones dns.sh switches at cutover (A and AAAA; CNAMEs for moved services). Zone id: the Route 53 hosted zone id, the Azure resource group, or the OCI zone OCID; View: Infoblox view or OCI private view.' },
    { id: 'lbs', label: 'Load balancers', control: 'textarea', hint: 'App | Kind | Pool | Port', options: [...apps, ...grouped(LB_KIND_OPTIONS, 'Kind')], help: 'The pools lb.sh drains at the freeze and switches after cutover.' },
    { id: 'dataSets', label: 'File data sets (rebuild paths)', control: 'textarea', hint: 'Workload | Source | Target | Method | Exclude', options: [...servers, ...grouped(DATA_COPY_METHOD_OPTIONS, 'Method')] },
    { id: 'vcfImportClusters', label: 'Clusters imported into VCF 9.1 (VCF Import)', control: 'text', hint: 'comma-separated cluster names' },
    // AWS Transform MGN
    { id: 'mgn.replication', label: 'AWS Transform MGN: replication', control: 'select', options: MGN_REPLICATION_OPTIONS.map((o) => opt(o.value, o.label)), section: SECTION_TOOLS },
    { id: 'mgn.ip', label: 'AWS Transform MGN: replication IP protocol', control: 'select', options: MGN_IP_PROTOCOL_OPTIONS.map((o) => opt(o.value, o.label)), section: SECTION_TOOLS },
    { id: 'mgn.serverType', label: 'AWS Transform MGN: replication server instance type', control: 'combo', options: ['t3.small', 't3.medium', 'm5.large', 'c5.large'].map((v) => opt(v)), section: SECTION_TOOLS },
    { id: 'mgn.bandwidthMbps', label: 'AWS Transform MGN: bandwidth throttle (Mbit/s, 0 = none)', control: 'number', min: 0, section: SECTION_TOOLS },
    // Azure Migrate
    { id: 'azure.project', label: 'Azure Migrate: project', control: 'text', section: SECTION_TOOLS },
    { id: 'azure.appliance', label: 'Azure Migrate: appliance', control: 'text', section: SECTION_TOOLS },
    { id: 'azure.diskType', label: 'Azure Migrate: target disk type', control: 'select', options: AZURE_MIGRATE_DISK_TYPE_OPTIONS.map((o) => opt(o.value, o.label)), section: SECTION_TOOLS },
    { id: 'azure.securityType', label: 'Azure Migrate: security type', control: 'select', options: AZURE_SECURITY_TYPE_OPTIONS.map((o) => opt(o.value, o.label)), section: SECTION_TOOLS },
    // Google Cloud (GCP) Migrate to Virtual Machines
    { id: 'm2vm.source', label: 'Google Cloud (GCP) Migrate to Virtual Machines: source', control: 'text', section: SECTION_TOOLS },
    { id: 'm2vm.targetProject', label: 'Google Cloud (GCP) Migrate to Virtual Machines: target project', control: 'text', section: SECTION_TOOLS },
    // Oracle Cloud Migrations
    { id: 'ocm.environment', label: 'Oracle Cloud Migrations: source environment', control: 'text', section: SECTION_TOOLS },
    { id: 'ocm.bucket', label: 'Oracle Cloud Migrations: replication bucket', control: 'text', section: SECTION_TOOLS },
    { id: 'ocm.schedule', label: 'Oracle Cloud Migrations: replication schedule', control: 'text', section: SECTION_TOOLS },
    { id: 'dms.maxCapacityUnits', label: 'AWS DMS Serverless: maximum capacity units', control: 'select', options: DMS_CAPACITY_UNITS_OPTIONS.map((o) => opt(o.value, o.label)), section: SECTION_TOOLS },
    // HCX
    { id: 'hcx.sourceSite', label: 'HCX: source site', control: 'text', section: SECTION_TOOLS },
    { id: 'hcx.destSite', label: 'HCX: destination site', control: 'text', section: SECTION_TOOLS },
    { id: 'hcx.windowHours', label: 'HCX: switchover window', control: 'select', options: HCX_WINDOW_HOURS_OPTIONS.map((o) => opt(o.value, o.label)), section: SECTION_TOOLS },
    { id: 'hcx.extend', label: 'HCX: networks to extend (Network Extension)', control: 'text', hint: 'comma-separated port groups', section: SECTION_TOOLS },
    { id: 'hcx.mappings', label: 'HCX: network mappings', control: 'textarea', hint: 'From | To', options: [NO_COLUMN], section: SECTION_TOOLS },
    { id: 'hcx.container', label: 'HCX: target cluster or resource pool', control: 'text', section: SECTION_TOOLS },
    { id: 'hcx.datastore', label: 'HCX: target datastore', control: 'text', section: SECTION_TOOLS },
    { id: 'hcx.folder', label: 'HCX: target folder', control: 'text', section: SECTION_TOOLS },
  );
  if (!tools) return inputs;
  return inputs.filter((i) => {
    const c = toolCloud(i.id);
    return !c || tools.includes(c);
  });
}

const cells = (line: string, n: number): string[] => {
  const parts = ` ${line} `.split(/(?<=\s)\|(?=\s)/).map((c) => c.trim());
  return Array.from({ length: n }, (_, i) => parts[i] ?? '');
};
const rowsOf = (text: string, n: number): string[][] => text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => cells(l, n));
const joinRows = (rows: readonly (readonly string[])[]): string => rows.map((r) => r.join(' | ')).join('\n');
const list = (text: string): string[] => text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
const has = <T extends string>(options: readonly { value: string }[], v: string): v is T => options.some((o) => o.value === v);

/** The form's values from the settings. */
export function executionValues(e: ExecutionSettings): Record<string, string> {
  const v: Record<string, string> = {};
  for (const c of CRITICALITY_VALUES) {
    v[`keep.${c}`] = String(e.keepDays[c]);
    v[`hyper.${c}`] = String(e.hypercareDays[c]);
  }
  v['lag.server'] = String(e.lagSeconds.server);
  v['lag.db'] = String(e.lagSeconds.db);
  for (const [p, s] of Object.entries(e.landingZones)) v[`lz.${p}`] = s ?? '';
  v.dnsZones = joinRows(e.dnsZones.map((z) => [z.zone, z.provider, z.zoneId ?? '', z.view ?? '', z.private ? 'yes' : 'no']));
  v.lbs = joinRows(e.lbs.map((l) => [l.app, l.kind, l.pool, String(l.port)]));
  v.dataSets = joinRows(e.dataSets.map((d) => [d.workload, d.source, d.target, d.method, d.exclude ?? '']));
  v.vcfImportClusters = e.vcfImportClusters.join(', ');
  v['mgn.replication'] = e.mgn?.replication ?? 'agent';
  v['mgn.ip'] = e.mgn?.ip ?? 'IPV4';
  v['mgn.serverType'] = e.mgn?.serverType ?? 't3.small';
  v['mgn.bandwidthMbps'] = String(e.mgn?.bandwidthMbps ?? 0);
  v['azure.project'] = e.azureMigrate?.project ?? '';
  v['azure.appliance'] = e.azureMigrate?.appliance ?? '';
  v['azure.diskType'] = e.azureMigrate?.diskType ?? 'Premium_LRS';
  v['azure.securityType'] = e.azureMigrate?.securityType ?? 'TrustedLaunch';
  v['m2vm.source'] = e.m2vm?.source ?? '';
  v['m2vm.targetProject'] = e.m2vm?.targetProject ?? '';
  v['ocm.environment'] = e.ocm?.environment ?? '';
  v['ocm.bucket'] = e.ocm?.bucket ?? '';
  v['ocm.schedule'] = e.ocm?.schedule ?? '';
  v['dms.maxCapacityUnits'] = String(e.dms?.maxCapacityUnits ?? 16);
  v['hcx.sourceSite'] = e.hcx?.sourceSite ?? '';
  v['hcx.destSite'] = e.hcx?.destSite ?? '';
  v['hcx.windowHours'] = String(e.hcx?.windowHours ?? 4);
  v['hcx.extend'] = (e.hcx?.extend ?? []).join(', ');
  v['hcx.mappings'] = joinRows((e.hcx?.mappings ?? []).map((m) => [m.from, m.to]));
  v['hcx.container'] = e.hcx?.container ?? '';
  v['hcx.datastore'] = e.hcx?.datastore ?? '';
  v['hcx.folder'] = e.hcx?.folder ?? '';
  return v;
}

const num = (s: string, fallback: number): number => {
  const n = Number(s);
  return s.trim() !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
};
const optional = <K extends string>(key: K, value: string): Partial<Record<K, string>> => (value.trim() ? ({ [key]: value.trim() } as Record<K, string>) : {});

/** The settings with one form value applied (a value that is not valid leaves them as they were). */
export function applyExecutionValue(e: ExecutionSettings, id: string, value: string): ExecutionSettings {
  const [head, key = ''] = id.split('.');
  switch (head) {
    case 'keep':
      return has<Criticality>(CRITICALITY_OPTIONS, key) ? { ...e, keepDays: { ...e.keepDays, [key]: num(value, e.keepDays[key]) } } : e;
    case 'hyper':
      return has<Criticality>(CRITICALITY_OPTIONS, key) ? { ...e, hypercareDays: { ...e.hypercareDays, [key]: num(value, e.hypercareDays[key]) } } : e;
    case 'lag':
      return key === 'server' || key === 'db' ? { ...e, lagSeconds: { ...e.lagSeconds, [key]: num(value, e.lagSeconds[key]) } } : e;
    case 'lz': {
      const next = { ...e.landingZones } as Record<string, LandingZoneState>;
      if (has<LandingZoneState>(LANDING_ZONE_STATE_OPTIONS, value)) next[key] = value;
      else delete next[key];
      return { ...e, landingZones: next };
    }
    case 'dnsZones':
      return {
        ...e,
        dnsZones: rowsOf(value, 5).filter((r) => r[0]).map(([zone, provider, zoneId, view, priv]) => ({
          zone: zone as string, provider: has<DnsProvider>(DNS_PROVIDER_OPTIONS, provider ?? '') ? provider as DnsProvider : 'route53',
          ...optional('zoneId', zoneId ?? ''), ...optional('view', view ?? ''), private: priv === 'yes',
        })),
      };
    case 'lbs':
      return {
        ...e,
        lbs: rowsOf(value, 4).filter((r) => r[0] || r[2]).map(([app, kind, pool, port]) => ({
          app: app ?? '', kind: has<LbKind>(LB_KIND_OPTIONS, kind ?? '') ? kind as LbKind : 'none', pool: pool ?? '', port: num(port ?? '', 443),
        })),
      };
    case 'dataSets':
      return {
        ...e,
        dataSets: rowsOf(value, 5).filter((r) => r[0]).map(([workload, source, target, method, exclude]) => ({
          workload: workload ?? '', source: source ?? '', target: target ?? '', method: has<DataCopyMethod>(DATA_COPY_METHOD_OPTIONS, method ?? '') ? method as DataCopyMethod : 'rsync',
          ...optional('exclude', exclude ?? ''),
        })),
      };
    case 'vcfImportClusters':
      return { ...e, vcfImportClusters: list(value) };
    case 'mgn': {
      const m = e.mgn ?? { replication: 'agent' as MgnReplication, serverType: 't3.small', bandwidthMbps: 0, ip: 'IPV4' as MgnIpProtocol };
      if (key === 'replication' && has<MgnReplication>(MGN_REPLICATION_OPTIONS, value)) return { ...e, mgn: { ...m, replication: value } };
      if (key === 'ip' && has<MgnIpProtocol>(MGN_IP_PROTOCOL_OPTIONS, value)) return { ...e, mgn: { ...m, ip: value } };
      if (key === 'serverType') return { ...e, mgn: { ...m, serverType: value.trim() || 't3.small' } };
      if (key === 'bandwidthMbps') return { ...e, mgn: { ...m, bandwidthMbps: num(value, m.bandwidthMbps) } };
      return e;
    }
    case 'azure': {
      const a = e.azureMigrate ?? { project: '', appliance: '', diskType: 'Premium_LRS' as AzureMigrateDiskType, securityType: 'TrustedLaunch' as AzureSecurityType };
      if (key === 'diskType') return has<AzureMigrateDiskType>(AZURE_MIGRATE_DISK_TYPE_OPTIONS, value) ? { ...e, azureMigrate: { ...a, diskType: value } } : e;
      if (key === 'securityType') return has<AzureSecurityType>(AZURE_SECURITY_TYPE_OPTIONS, value) ? { ...e, azureMigrate: { ...a, securityType: value } } : e;
      if (key === 'project' || key === 'appliance') return { ...e, azureMigrate: { ...a, [key]: value.trim() } };
      return e;
    }
    case 'm2vm': {
      const g = e.m2vm ?? { source: '', targetProject: '' };
      return key === 'source' || key === 'targetProject' ? { ...e, m2vm: { ...g, [key]: value.trim() } } : e;
    }
    case 'ocm': {
      const o = e.ocm ?? { environment: '', bucket: '', schedule: '' };
      return key === 'environment' || key === 'bucket' || key === 'schedule' ? { ...e, ocm: { ...o, [key]: value.trim() } } : e;
    }
    case 'dms':
      return has(DMS_CAPACITY_UNITS_OPTIONS, value) ? { ...e, dms: { maxCapacityUnits: Number(value) as DmsCapacityUnits } } : e;
    case 'hcx': {
      const h = e.hcx ?? { sourceSite: '', destSite: '', extend: [], mappings: [], windowHours: 4 as HcxWindowHours };
      if (key === 'windowHours') return has(HCX_WINDOW_HOURS_OPTIONS, value) ? { ...e, hcx: { ...h, windowHours: Number(value) as HcxWindowHours } } : e;
      if (key === 'extend') return { ...e, hcx: { ...h, extend: list(value) } };
      if (key === 'mappings') return { ...e, hcx: { ...h, mappings: rowsOf(value, 2).filter((r) => r[0] && r[1]).map(([from, to]) => ({ from: from as string, to: to as string })) } };
      if (key === 'sourceSite' || key === 'destSite') return { ...e, hcx: { ...h, [key]: value.trim() } };
      if (key === 'container' || key === 'datastore' || key === 'folder') {
        const { [key]: _old, ...rest } = h;
        return { ...e, hcx: { ...rest, ...optional(key, value) } };
      }
      return e;
    }
    default:
      return e;
  }
}

/** Set (or clear, with '') an item's path override; refused paths keep the settings as they were and say why. */
export function setPathOverride(plan: Plan, item: ItemId, path: string, decision: PlanDecision | undefined = plan.decision): { plan: Plan; refused?: string } {
  const e = plan.execution ?? defaultExecution();
  const next = { ...e.pathOverrides } as Record<ItemId, MovePath | DbMovePath>;
  if (!path) {
    delete next[item];
    return { plan: { ...plan, execution: { ...e, pathOverrides: next } } };
  }
  const target = plan.workloads.find((w) => w.id === item) ?? plan.databases.find((d) => d.id === item);
  if (!target || !decision) {
    return { plan, refused: target ? 'The plan has no decision yet.' : 'That item is not in the plan.' };
  }
  const ok = checkPathOverride(target, plan, decision, path as ExecPath);
  if (!ok.ok) return { plan, refused: ok.reason };
  next[item] = path as MovePath | DbMovePath;
  return { plan: { ...plan, execution: { ...e, pathOverrides: next } } };
}

// ---------------------------------------------------------------------------
// The kit, worked out once per plan and tracker
// ---------------------------------------------------------------------------

const kitCache = new WeakMap<Plan, { tracker: Tracker; kit: ExecutionKit | { error: string } }>();

export function kitFor(view: TrackView): ExecutionKit | { error: string } {
  const hit = kitCache.get(view.plan);
  if (hit && hit.tracker === view.tracker) return hit.kit;
  let kit: ExecutionKit | { error: string };
  try {
    kit = executionKit({ ...view.plan, decision: view.decision }, view.decision, view.design, view.waves, view.stored ? view.tracker : undefined);
  } catch (e) {
    kit = { error: e instanceof Error ? e.message : String(e) };
  }
  kitCache.set(view.plan, { tracker: view.tracker, kit });
  return kit;
}

function specsOf(view: TrackView, kit: ExecutionKit): WaveSpec[] {
  return waveSpecs({ plan: view.plan, manifest: kit.manifest, settings: view.plan.execution ?? defaultExecution(), waves: view.waves });
}

// ---------------------------------------------------------------------------
// The pane
// ---------------------------------------------------------------------------

const copyButton = (text: () => string, control: string): HTMLElement => el('button', {
  class: 'btn btn-small', text: 'Copy', attrs: { type: 'button', 'data-control': control, title: 'Copy to the clipboard' },
  on: {
    click: (e: Event) => {
      const b = e.currentTarget as HTMLButtonElement;
      void navigator.clipboard?.writeText(text()).then(() => {
        b.textContent = 'Copied';
        setTimeout(() => { b.textContent = 'Copy'; }, 1200);
      }, () => { b.textContent = 'Copy failed'; });
    },
  },
});

const pre = (text: string, control?: string): HTMLElement => el('pre', {
  class: 'code', text, attrs: control ? { 'data-control': control } : {},
  style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxWidth: '100%', margin: '0' },
});

const selectOf = (label: string, options: readonly { value: string; label: string }[], value: string, control: string, onChange: (v: string) => void): HTMLSelectElement => {
  const s = el('select', { attrs: { 'aria-label': label, 'data-control': control } }) as HTMLSelectElement;
  for (const o of options) append(s, el('option', { text: o.label, attrs: { value: o.value } }));
  s.value = value;
  s.addEventListener('change', () => onChange(s.value));
  return s;
};

const raciOf = (plan: Plan) => (plan.governance?.raci.length ? plan.governance.raci : defaultRaci(plan));

export function mount(root: HTMLElement, ctx: PaneContext): void {
  let current: TrackView | undefined;
  let route = parseExecuteArg(ctx.arg());
  const attest: Record<string, boolean> = {};
  const lzAttest: Record<string, boolean> = {};
  let lastGate: { path: string; text: string } | undefined;
  let gateNote = '';
  let pathFilter = '';
  let pathPage = 0;

  const banner = el('div');
  const nav = el('div', { class: 'stack' });
  const body = el('div', { class: 'stack', style: { overflowWrap: 'anywhere', minWidth: '0' } });
  append(root, el('div', { class: 'stack', style: { minWidth: '0' } }, banner, nav, body));

  const draw = (v: TrackView): void => {
    current = v;
    fill(banner, otherPlanNode(v, ctx));
    if (route.settings) drawSettings(v);
    else drawConsole(v);
  };

  ctx.onArg((arg) => {
    route = parseExecuteArg(arg);
    lastGate = undefined;
    gateNote = '';
    if (current) draw(current);
  });

  // ---- settings ------------------------------------------------------------------
  function drawSettings(v: TrackView): void {
    const waves = [...new Set(Object.values(v.tracker.items).filter((s) => !s.removed).map((s) => s.wave))].sort((a, b) => a - b);
    fill(nav, el('div', { class: 'btn-row' },
      el('span', { class: 'badge good', text: 'Settings' }),
      waves.length ? el('a', { class: 'btn btn-small', text: `Wave console (wave ${waves.find((w) => w > 0) ?? waves[0]}) →`, attrs: { href: `#${consoleHash(waves.find((w) => w > 0) ?? waves[0] as number, 'precheck')}` } }) : null));
    clear(body);
    const plan = v.plan;
    // One cloud at a time: the landing-zone state and the migration tools of the chosen cloud only.
    const usage = cloudUsage(plan, v.decision);
    const cloud = resolveCloud('', viewerCloud(), usage);
    const platforms = cloud ? [cloud] : [];
    const inputs = executionInputs(plan, platforms, platforms);
    const values = () => executionValues(ctx.session.plan().execution ?? defaultExecution());
    const form = el('div', { class: 'stack', attrs: { 'data-control': 'execution-settings' } });
    const renderForm = () => {
      fill(form, ...renderBlueprintForm({ inputs }, {
        values,
        set: (id, value) => ctx.session.update((p) => ({ ...p, execution: applyExecutionValue(p.execution ?? defaultExecution(), id, value) })),
        rerender: renderForm,
      }));
    };
    renderForm();
    append(body, card('Execution settings',
      note('Kept in the plan and used by the execution kit. Everything the kit generates applies by default; each script takes --dry-run to preview.'),
      cloudPicker({
        cloud, usage, control: 'execute-cloud-choice', onChange: () => undefined,
        prompt: 'Choose a cloud for its landing-zone state and its migration tool settings. The settings below apply to every cloud.',
      }),
      cloud ? note(`${CLOUD_NAMES[cloud]}: its landing-zone state and migration tools are listed with the settings every cloud shares.`) : null,
      form));

    // Paths and overrides.
    append(body, pathsCard(v));

    // The kit.
    const kitBox = el('div', { class: 'stack', attrs: { 'data-control': 'execution-kit' } });
    const build = el('button', {
      class: 'btn btn-primary', text: 'Generate the execution kit', attrs: { type: 'button', 'data-control': 'kit-generate' },
      on: { click: () => drawKit(v, kitBox) },
    });
    append(body, card('Execution kit (migration/execute/)', note('The path scripts, the wave orchestrators (pre-check, replicate, test, cutover, validate, commit, rollback, decommission), DNS and load-balancer switching, the Ansible plays, the manifest and the controller check.'), el('div', { class: 'btn-row' }, build), kitBox));
  }

  function drawKit(v: TrackView, box: HTMLElement): void {
    const kit = kitFor(v);
    if ('error' in kit) {
      fill(box, el('div', { class: 'tip warn', text: `The kit could not be generated: ${kit.error}` }));
      return;
    }
    const names = Object.keys(kit.files);
    const errors = kit.findings.filter((f) => f.severity === 'error').length;
    const preview = el('div');
    const pick = selectOf('File', names.map((n) => ({ value: n, label: n })), names.find((n) => n === 'README.md') ?? names[0] ?? '', 'kit-file', (name) => fill(preview, pre(kit.files[name] ?? '', 'kit-file-text')));
    fill(preview, pre(kit.files[pick.value] ?? '', 'kit-file-text'));
    fill(box,
      note(`${names.length} files, ${kit.manifest.items.length} items, ${errors} error${errors === 1 ? '' : 's'}.`, 'kit-summary'),
      el('div', { class: 'btn-row' },
        el('button', {
          class: 'btn btn-small', text: 'Download the kit (.zip)', attrs: { type: 'button', 'data-control': 'kit-download' },
          on: {
            click: () => {
              const files: Record<string, string> = {};
              for (const [k, t] of Object.entries(kit.files)) files[`${EXECUTE_DIR}/${k}`] = t;
              void zip(files, new Date(v.plan.savedAt)).then((bytes) => downloadFile(`${slug(v.plan.name)}-execution-kit.zip`, bytes, 'application/zip'));
            },
          },
        })),
      el('div', { class: 'field' }, el('label', { text: 'Look inside' }), pick),
      preview,
      findingsList(kit.findings, 'The kit has no findings.'),
    );
  }

  function pathsCard(v: TrackView): HTMLElement {
    const plan = v.plan;
    const kit = kitFor(v);
    const resolutions: PathResolution<ExecPath>[] = 'error' in kit ? [] : [...kit.resolutions.values()];
    const names = new Map([...plan.workloads, ...plan.databases].map((x) => [x.id, x.name] as const));
    const apps = [...new Set([...plan.workloads, ...plan.databases].map((x) => x.app).filter(Boolean))].sort();
    const appOf = new Map([...plan.workloads, ...plan.databases].map((x) => [x.id, x.app] as const));
    const rows = resolutions.filter((r) => r.valid.length > 0 && (!pathFilter || appOf.get(r.item) === pathFilter))
      .sort((a, b) => (names.get(a.item) ?? '').localeCompare(names.get(b.item) ?? ''));
    const size = 100;
    const pages = Math.max(1, Math.ceil(rows.length / size));
    pathPage = Math.min(pathPage, pages - 1);
    const msg = el('div', { class: 'small', attrs: { role: 'status', 'data-control': 'path-override-message' } });
    const override = plan.execution?.pathOverrides ?? {};
    const table = rowsTable(['Item', 'Kind', 'Path', 'Override', 'Why'], rows.slice(pathPage * size, (pathPage + 1) * size).map((r) => {
      const s = el('select', { attrs: { 'aria-label': `Path for ${names.get(r.item) ?? r.item}`, 'data-control': 'path-override', 'data-item': r.item } }) as HTMLSelectElement;
      append(s, el('option', { text: `Default: ${r.default ? pathLabel(r.default) : '—'}`, attrs: { value: '' } }));
      for (const p of r.valid) if (p !== r.default) append(s, el('option', { text: pathLabel(p), attrs: { value: p } }));
      s.value = override[r.item] && r.valid.includes(override[r.item] as ExecPath) ? override[r.item] as string : '';
      s.addEventListener('change', () => {
        const res = setPathOverride(ctx.session.plan(), r.item, s.value, current?.decision ?? v.decision);
        if (res.refused) {
          msg.textContent = `${names.get(r.item) ?? r.item}: ${res.refused}`;
          s.value = '';
          return;
        }
        msg.textContent = s.value ? `${names.get(r.item) ?? r.item} now moves by ${pathLabel(s.value as ExecPath)}.` : `${names.get(r.item) ?? r.item} is back on its default path.`;
        ctx.session.update(() => res.plan);
      });
      return [
        names.get(r.item) ?? r.item, r.kind === 'database' ? 'Database' : 'Server', r.path ? pathLabel(r.path) : '—', s,
        el('span', {}, r.why, r.refused ? el('span', { class: 'badge danger', text: ` Override ${r.refused.path} refused: ${r.refused.reason}` }) : null),
      ];
    }), { control: 'path-overrides' });
    return card('Move paths',
      note('Each item’s path comes from the rules; an override is offered only where the source and target allow it, and a refused one names the reason.'),
      el('div', { class: 'filter-row' },
        selectOf('Application', [{ value: '', label: 'Application: any' }, ...apps.map((a) => ({ value: a, label: a }))], pathFilter, 'path-filter-app', (a) => {
          pathFilter = a;
          pathPage = 0;
          if (current) drawSettings(current);
        })),
      rows.length === 0 ? note('No item has a path yet: decide the plan first.') : table,
      pages > 1 ? el('div', { class: 'btn-row' },
        el('button', { class: 'btn btn-small', text: '← Previous', attrs: { type: 'button', disabled: pathPage === 0 }, on: { click: () => { pathPage -= 1; if (current) drawSettings(current); } } }),
        el('span', { class: 'small muted', text: `Page ${pathPage + 1} of ${pages}` }),
        el('button', { class: 'btn btn-small', text: 'Next →', attrs: { type: 'button', disabled: pathPage >= pages - 1 }, on: { click: () => { pathPage += 1; if (current) drawSettings(current); } } })) : null,
      msg,
    );
  }

  // ---- console -------------------------------------------------------------------
  function drawConsole(v: TrackView): void {
    const r = route as Extract<ExecuteRoute, { settings: false }>;
    const waves = [...new Set(Object.values(v.tracker.items).filter((s) => !s.removed).map((s) => s.wave))].sort((a, b) => a - b);
    const wave = r.wave ?? waves.find((w) => w > 0) ?? waves[0] ?? 1;
    const stage = r.stage;
    fill(nav,
      el('div', { class: 'filter-row' },
        selectOf('Wave', (waves.length ? waves : [wave]).map((w) => ({ value: String(w), label: w === 0 ? 'No wave' : `Wave ${w}` })), String(wave), 'console-wave', (w) => ctx.go(consoleHash(Number(w), stage))),
        el('a', { class: 'btn btn-small', text: 'Settings, paths and the kit', attrs: { href: '#execute:settings', 'data-control': 'execute-settings-link' } })),
      el('div', { class: 'btn-row', attrs: { role: 'tablist', 'aria-label': 'Stages', 'data-control': 'console-stages' } },
        ...STAGES.map((s) => el('a', {
          class: `btn btn-small${s === stage ? ' btn-primary' : ''}`, text: STAGE_INFO[s].label,
          attrs: { href: `#${consoleHash(wave, s)}`, role: 'tab', 'aria-selected': s === stage ? 'true' : 'false', 'data-stage': s },
        }))),
    );
    clear(body);
    if (!waves.includes(wave)) {
      append(body, card('Wave console', note(waves.length ? `Wave ${wave} has no items.` : 'Nothing is tracked yet: plan the waves first.')));
      return;
    }
    const kit = kitFor(v);
    const info = STAGE_INFO[stage];
    // Commands.
    const scripts = 'error' in kit ? [] : pathScripts(kit, wave);
    const cmds = stageCommands(wave, stage, scripts);
    const scriptText = 'error' in kit ? undefined : kit.files[`waves/wave-${wave}/${info.file}`];
    const cmdText = `cd ${EXECUTE_DIR}\n${cmds.main}`;
    append(body, card(`${info.label}: wave ${wave}`,
      subhead('The command to run'),
      el('div', { class: 'stack' },
        pre(cmdText, 'console-command'),
        el('div', { class: 'btn-row' }, copyButton(() => cmdText, 'console-copy'), el('span', { class: 'small muted', text: `Preview first: ${cmds.dryRun}` }))),
      cmds.variants.length ? el('ul', { class: 'small' }, ...cmds.variants.map((x) => el('li', {}, el('code', { text: x.command }), ` — ${x.why}`))) : null,
      cmds.paths.length ? el('details', {}, el('summary', { text: `What it calls per path (${cmds.paths.length})` }), pre(cmds.paths.join('\n'), 'console-path-commands')) : null,
      providerNotes(scripts, stage),
      scriptText ? el('details', {}, el('summary', { text: `Read ${info.file}` }), pre(scriptText, 'console-script')) : 'error' in kit ? el('div', { class: 'tip warn', text: `The kit could not be generated: ${kit.error}` }) : null,
    ));
    append(body, runbookCard(v, wave, stage));
    if (info.gate) append(body, gateCard(v, wave, info.gate));
    if (stage === 'precheck' && !('error' in kit)) {
      const spec = specsOf(v, kit).find((s) => s.n === wave);
      if (spec?.production) append(body, landingZoneCard(v, specsOf(v, kit)));
    }
    append(body, card('Import status', importStatusControl(() => current, ctx, 'console-import')));
    append(body, itemsCard(v, wave));
    append(body, commsCard(v, wave, stage));
    if (!('error' in kit)) {
      const spec = specsOf(v, kit).find((s) => s.n === wave);
      if (spec) {
        const tl = waveTMinus(spec);
        append(body, card('T-minus timeline', rowsTable(['When', 'Date', 'Step', 'Command'], tl.map((t) => [t.label, t.date ?? '—', t.title, t.command ? el('code', { text: t.command }) : ''])), note('Seeded from the AWS migration governance playbook’s communication gates and the kit’s own steps.')));
      }
    }
  }

  function providerNotes(scripts: readonly PathScript[], stage: Stage): HTMLElement | null {
    const lines = scripts.map((s) => [s.path, providerSteps(s.path)] as const).filter((x) => !!x[1]).map(([p, st]) => {
      const text = stage === 'test' ? st?.test : stage === 'cutover' ? st?.cutover : stage === 'commit' || stage === 'decommission' ? st?.finalize : undefined;
      return text ? `${pathLabel(p)}: ${text}` : '';
    }).filter(Boolean);
    return lines.length ? el('p', { class: 'small muted', text: `In the provider’s own words: ${lines.join('; ')}.` }) : null;
  }

  function runbookCard(v: TrackView, wave: number, stage: Stage): HTMLElement {
    const tasks = stageTasks(stage);
    const ticked = tickedTasks(v.tracker, wave);
    if (tasks.length === 0) return card('Runbook', note('The decommission steps are in decommission.sh: target backup check, path finalize, source removal, snapshots, AD, DNS, CMDB and licence reclaim; each writes its own events.'));
    return card('Runbook',
      note('Tick a task when it is done; the tick is recorded as a manual event for the wave.'),
      el('ul', { class: 'stack', style: { listStyle: 'none', padding: '0' }, attrs: { 'data-control': 'runbook' } }, ...tasks.map((t) => {
        const box = el('input', { attrs: { type: 'checkbox', 'data-task': t.id } }) as HTMLInputElement;
        box.checked = ticked.has(t.id);
        box.addEventListener('change', () => {
          const e = waveEvent(v.tracker.planId, wave, `${t.id} ${box.checked ? 'done' : 'reopened'}: ${t.task}`, { task: t.id, done: box.checked }, new Date().toISOString(), newRunId());
          void commitTracker(withEvent(v, e), ctx);
        });
        return el('li', {}, el('label', { class: 'checkbox' }, box, el('span', {},
          el('strong', { text: `${t.id} ` }), t.task, el('span', { class: 'small muted', text: ` · ${t.team}${t.command ? ` · ${t.command.replace(/<n>/g, String(wave))}` : ''}${t.reconstructed ? ' · reconstructed (verify)' : ''}` }))),
        t.milestone ? el('div', { class: 'small', text: t.milestone }) : null);
      })),
    );
  }

  function gateCard(v: TrackView, wave: number, gate: GateId): HTMLElement {
    const raci = raciOf(v.plan);
    const criteria = gateCriteria(v, wave, gate, attest, todayIso());
    const gi = WAVE_GATES.find((g) => g.gate === gate);
    const so = GATE_SIGN_OFF[gate];
    const act: RaciActivityId = so?.activity ?? 'gate-g2';
    const defaultRole = accountable(raci, act) ?? 'migration-lead';
    const role = selectOf('Decided by (role)', RACI_ROLE_OPTIONS, defaultRole, 'gate-role', () => undefined);
    const decision = selectOf('Decision', GATE_DECISION_OPTIONS, criteria.every((c) => c.met) ? 'go' : 'no-go', 'gate-decision', () => undefined);
    const comment = el('input', { attrs: { type: 'text', placeholder: 'Comment (optional; a name only if you want one)', 'aria-label': 'Comment', 'data-control': 'gate-comment' }, style: { flex: '1 1 12rem', minWidth: '0' } }) as HTMLInputElement;
    const msg = el('div', { class: 'small', text: gateNote, attrs: { role: 'status', 'data-control': 'gate-message' } });
    const attestBoxes = criteria.filter((c) => ATTESTABLE[c.id]).map((c) => {
      const b = el('input', { attrs: { type: 'checkbox', 'data-control': `attest-${c.id}` } }) as HTMLInputElement;
      b.checked = attest[c.id] === true;
      b.addEventListener('change', () => {
        attest[c.id] = b.checked;
        if (current) drawConsole(current);
      });
      return el('label', { class: 'checkbox small' }, b, el('span', { text: ATTESTABLE[c.id] as string }));
    });
    const record = () => {
      const r = decideGate(v, { wave, gate, decision: decision.value as GateDecision, role: role.value as RaciRole, at: nowIso(), comment: comment.value, attest });
      if (r.problems.length) {
        msg.textContent = `Not recorded: the gate file failed its schema check (${r.problems.join(', ')}).`;
        return;
      }
      lastGate = r.file;
      downloadFile(gateDownloadName(r.file.path), r.file.text);
      gateNote = `Recorded ${gate} ${decision.value === 'go' ? 'Go' : 'No go'} for wave ${wave}; downloaded ${gateDownloadName(r.file.path)}. Put it in the project’s status/gates/ folder.`;
      msg.textContent = gateNote;
      void commitTracker(r.tracker, ctx);
    };
    const recorded = v.tracker.gates.filter((g) => g.wave === wave && g.gate === gate).sort((a, b) => a.at.localeCompare(b.at));
    return card(`Gate ${labelOf(GATE_ID_OPTIONS, gate)}`,
      gi ? note(`When: ${gi.when}. Checked by: ${gi.checkedBy}. File: status/${gateFilePath(wave, gate)}.`) : null,
      rowsTable(['', 'Criterion', 'How', 'Detail'], criteria.map((c) => [
        el('span', { class: `badge ${c.met ? 'good' : 'danger'}`, text: c.met ? 'Met' : 'Not met' }), c.id, c.auto ? 'From the tracker' : 'Manual', c.detail,
      ]), { control: 'gate-criteria' }),
      attestBoxes.length ? el('div', { class: 'stack' }, subhead('Attestations'), ...attestBoxes) : null,
      so ? signOffForm(v, wave, so.kind, so.scope) : null,
      subhead('Record the decision'),
      el('div', { class: 'filter-row' }, role, decision, comment),
      el('div', { class: 'btn-row' },
        el('button', { class: 'btn btn-primary', text: 'Record decision and download the gate file', attrs: { type: 'button', 'data-control': 'gate-record' }, on: { click: record } }),
        lastGate ? el('button', { class: 'btn btn-small', text: `Download ${gateDownloadName(lastGate.path)} again`, attrs: { type: 'button', 'data-control': 'gate-download-again' }, on: { click: () => lastGate && downloadFile(gateDownloadName(lastGate.path), lastGate.text) } }) : null),
      note('A go with criteria unmet is allowed (the operator owns it); the Decisions log says which were unmet. The file names the role, never a person.'),
      msg,
      recorded.length ? rowsTable(['At', 'Decision', 'Role', 'Unmet', 'Comment'], recorded.map((g) => [g.at.replace('T', ' ').slice(0, 16), g.decision === 'go' ? 'Go' : 'No go', raciRoleLabel(g.role), g.criteria.filter((c) => !c.met).map((c) => c.id).join(', ') || '—', g.comment ?? '']), { control: 'gate-history' }) : null,
    );
  }

  function signOffForm(v: TrackView, wave: number, kind: SignOffKind, scope: 'app' | 'wave'): HTMLElement {
    const raci = raciOf(v.plan);
    const roles = whoCanSign(raci, kind);
    const apps = [...new Set(Object.values(v.tracker.items).filter((s) => !s.removed && s.wave === wave).map((s) => v.ctx.apps.get(s.item)).filter((a): a is string => !!a))].sort();
    const targets = scope === 'wave' ? [{ value: String(wave), label: `Wave ${wave}` }] : apps.map((a) => ({ value: signOffId(a, wave), label: a }));
    const target = selectOf('For', targets, targets[0]?.value ?? '', 'signoff-target', () => undefined);
    const role = selectOf('Role', roles.map((r) => ({ value: r, label: raciRoleLabel(r) })), roles[0] ?? '', 'signoff-role', () => undefined);
    const decision = selectOf('Decision', SIGN_OFF_DECISION_OPTIONS, 'approved', 'signoff-decision', () => undefined);
    const msg = el('div', { class: 'small', attrs: { role: 'status' } });
    return el('div', { class: 'stack', attrs: { 'data-control': 'gate-signoff' } },
      subhead(`Sign-off: ${labelOf(SIGN_OFF_KIND_OPTIONS, kind)}`),
      targets.length === 0 ? note('No apps in this wave.') : el('div', { class: 'filter-row' }, target, role, decision,
        el('button', {
          class: 'btn btn-small', text: 'Record sign-off', attrs: { type: 'button', 'data-control': 'signoff-record' },
          on: {
            click: () => {
              const r = recordSignOff(v.tracker, raci, { scope, id: target.value, kind, role: role.value as RaciRole, decision: decision.value as SignOffDecision, at: new Date().toISOString() });
              if (r.findings.some((f) => f.severity === 'error')) {
                msg.textContent = r.findings.map((f) => f.message).join(' ');
                return;
              }
              void commitTracker(r.tracker, ctx);
            },
          },
        })),
      roles.length === 0 ? note('No role may give this sign-off: fix the RACI on Waves › Governance.') : null,
      msg,
    );
  }

  function landingZoneCard(v: TrackView, specs: readonly WaveSpec[]): HTMLElement {
    const criteria = evaluateLandingZoneGate({ plan: v.plan, waves: specs, tracker: v.tracker, attest: lzAttest });
    const role = selectOf('Decided by (role)', RACI_ROLE_OPTIONS, accountable(raciOf(v.plan), 'landing-zone') ?? 'cloud-platform', 'lz-gate-role', () => undefined);
    const msg = el('div', { class: 'small', attrs: { role: 'status' } });
    return card('Landing-zone gate (production waves)',
      note('Production waves wait until the foundation items F01–F14 are green: precheck.sh needs status/gates/programme-landing-zone.json with decision go.'),
      el('ul', { class: 'stack', style: { listStyle: 'none', padding: '0' }, attrs: { 'data-control': 'lz-gate' } }, ...FOUNDATION_ITEMS.map((f) => {
        const c = criteria.find((x) => x.id === `lz.${f.id}`);
        const box = el('input', { attrs: { type: 'checkbox', disabled: f.auto && f.id !== 'F13' } }) as HTMLInputElement;
        box.checked = c?.met === true;
        box.addEventListener('change', () => {
          lzAttest[f.id] = box.checked;
          if (current) drawConsole(current);
        });
        return el('li', {}, el('label', { class: 'checkbox small' }, box, el('span', { text: `${f.id} ${f.text}${c ? ` — ${c.detail}` : ''}` })));
      })),
      el('div', { class: 'filter-row' }, role, el('button', {
        class: 'btn btn-small', text: 'Record and download the landing-zone gate file', attrs: { type: 'button', 'data-control': 'lz-gate-record' },
        on: {
          click: () => {
            const go = criteria.every((c) => c.met);
            const file = landingZoneGateFile(v.tracker.planId, go ? 'go' : 'no-go', nowIso(), role.value as RaciRole, criteria);
            downloadFile('programme-landing-zone.json', file.text);
            const t = recordDecision(v.tracker, { decision: `Landing-zone gate ${go ? 'Go' : 'No go'}.`, by: role.value as RaciRole, date: todayIso(), source: 'gate', links: ['gate:programme:landing-zone'] });
            void commitTracker(t, ctx).then(() => { msg.textContent = `Downloaded programme-landing-zone.json (${go ? 'go' : 'no-go'}).`; });
          },
        },
      })),
      msg,
    );
  }

  function itemsCard(v: TrackView, wave: number): HTMLElement {
    const rows = boardRows(v.tracker, v.ctx, { wave });
    return card(`Items in wave ${wave}`, rows.length === 0 ? note('No items.') : rowsTable(
      ['Name', 'App', 'Path', 'State', 'Flag', 'Sync', 'Last event'],
      rows.map((r) => [r.name, r.app || '—', pathLabel(r.path), `${labelOf(ITEM_STATE_OPTIONS, r.state)}${r.providerState ? ` (${r.providerState})` : ''}`, r.flag, r.sync, r.lastEvent]),
      { control: 'console-items' },
    ));
  }

  function commsCard(v: TrackView, wave: number, stage: Stage): HTMLElement {
    const ids = STAGE_INFO[stage].comms;
    const views = waveViews(v.plan, v.waves);
    const wv = views.find((w) => w.n === wave);
    if (!wv || ids.length === 0) return card('Notices', note('No notices for this stage.'));
    const raci = raciOf(v.plan);
    const preview = el('div');
    const show = (id: CommsTemplateId) => {
      const n = renderNotice(id, { plan: v.plan, wave: wv, raci, ...(v.plan.execution ? { execution: v.plan.execution } : {}), ...(v.plan.governance ? { governance: v.plan.governance } : {}) });
      const sent = v.tracker.notices.find((x) => x.template === id && x.wave === wave);
      fill(preview,
        pre(n.text, 'notice-text'),
        el('div', { class: 'btn-row' },
          copyButton(() => n.text, 'notice-copy'),
          el('button', { class: 'btn btn-small', text: 'Download .md', attrs: { type: 'button' }, on: { click: () => downloadFile(`wave-${wave}-${id}.md`, n.markdown, 'text/markdown') } }),
          sent ? el('span', { class: 'badge good', text: `Sent ${sent.sentAt.slice(0, 10)}` }) : el('button', {
            class: 'btn btn-small', text: 'Mark as sent', attrs: { type: 'button', 'data-control': 'notice-sent' },
            on: {
              click: () => {
                const at = new Date().toISOString();
                const t: Tracker = { ...v.tracker, notices: [...v.tracker.notices, { template: id, wave, sentAt: at }] };
                const e = { ...waveEvent(v.tracker.planId, wave, `Notice sent: ${id}`, { template: id }, at, newRunId()), step: 'notice' as const };
                void commitTracker(withEvent({ tracker: t, ctx: v.ctx }, e), ctx);
              },
            },
          })));
    };
    const pick = selectOf('Notice', ids.map((id) => ({ value: id, label: COMMS_TEMPLATES.find((t) => t.id === id)?.title ?? id })), ids[0] as string, 'notice-template', (id) => show(id as CommsTemplateId));
    show(ids[0] as CommsTemplateId);
    return card('Notices', note('Nothing is sent from here: copy or download the notice, send it yourself, then mark it as sent (G1 checks the T−14 and T−2 notices).'), el('div', { class: 'field' }, el('label', { text: 'Notice' }), pick), preview);
  }

  onCloudChange(() => {
    if (current && route.settings) draw(current);
  });
  watchTrack(ctx, draw);
}

const slug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'migration-plan';
