/**
 * Data centre (`#datacentre`, in `dc-exit` mode) on Multi-Cloud Migration &
 * Utilities (addendum A.5.5): everything in the building that is not a
 * server, what happens to it and when.
 *
 * Sub-views, by the hash argument (`#datacentre:<id>`):
 *   network     devices, circuits, subnets (and the re-IP / keep-IP decision
 *               per subnet), network services, DNS zone import → Terraform;
 *   storage     arrays, backup, archives and the retention register;
 *   security    security services (AD, PKI, HSM / keys, SIEM, EDR …);
 *   operations  operations tooling, scheduled jobs and the jobs playbook;
 *   other       telephony, print, OT and anything else (disposition only);
 *   partners    external partners and links;
 *   facility    contracts (terminate-by dates) and assets (sanitisation);
 *   netsec      firewall and load-balancer translation (netsec-view.ts);
 *   sequence    the exit waves with their rollbacks, the circuit-cut device
 *               changes for the Network page, the lights-out checklist and
 *               the DC-exit report;
 *   people      RACI, partner notices and the training plan.
 *
 * Every grid is a `planGrid` over datacentre-grids.ts, saved into
 * `Plan.dcExit` through the session; every computed view is recomputed from
 * the plan a moment after it changes.
 */

import { el, append, clear, downloadFile } from '../dom.ts';
import { card, field, findingsList, select, stat, statGrid } from '../components.ts';
import { planGrid, pickFiles, type PlanGrid } from '../multicloud/grid.ts';
import { planModel } from '../multicloud/plan-model.ts';
import { wavePlanFor } from '../multicloud/wave-model.ts';
import { putHandoff } from '../handoff.ts';
import type { PaneContext } from '../plan-shell.ts';
import { toCsv } from '../../core/csv.ts';
import type { Finding } from '../../core/findings.ts';
import { defaultDcExit, PLATFORM_LABELS, PLATFORM_OPTIONS } from '../../multicloud/plan/options.ts';
import type { DcExit, Plan, PlanDecision, Platform, WavePlan } from '../../multicloud/plan/types.ts';
import {
  exitSequence, exitSequenceMarkdown, exitWaves, lightsOut, lightsOutMarkdown, networkHandoff, wavesFromPlan,
  type ExitInput, type ExitSequence, type ExitStep, type LightsOutStatus, type NetworkHandoffChange,
} from '../../multicloud/plan/dcexit/sequence.ts';
import { assetRegisterCsv, canDispose, checkAssets, contractTasks, NIST_800_88 } from '../../multicloud/plan/dcexit/contracts.ts';
import { ARCHIVE_TIERS, checkArchives, retentionRegister } from '../../multicloud/plan/dcexit/archive.ts';
import { jobsPlaybook, planJobs } from '../../multicloud/plan/dcexit/jobs.ts';
import { applyReIp, dnsTerraform, parseDnsCsv, parseInfoblox, parseZoneFile, type DnsZone } from '../../multicloud/plan/dcexit/dns-import.ts';
import { dcExitReport, reportFileName } from '../../multicloud/plan/governance/reports.ts';
import { RACI_ROLES, defaultRaci, raciFiles, raciRoleLabel, validateRaci } from '../../multicloud/plan/governance/raci.ts';
import { partnerNotice, waveViews, type WaveView } from '../../multicloud/plan/governance/comms.ts';
import { trainingPlan } from '../../multicloud/plan/governance/ops-runbooks.ts';
import type { RaciRow } from '../../multicloud/plan/types.ts';
import {
  ARCHIVES_GRID, ARRAYS_GRID, ASSETS_GRID, BACKUP_GRID, CIRCUITS_GRID, CONTRACTS_GRID, DEVICES_GRID, EXTERNAL_GRID, JOBS_GRID,
  NET_SERVICES_GRID, OPS_GRID, OTHER_GRID, SECURITY_GRID, SUBNETS_GRID, contractStatuses, duplicateIds, gridFromCsv, gridToCsv,
  undecided, type DcGrid,
} from './datacentre-grids.ts';
import { mountNetsecView } from './netsec-view.ts';

/* ------------------------------------------------------------ pure helpers --- */

export const SUBTABS = [
  { id: 'network', label: 'Network' },
  { id: 'storage', label: 'Storage & data' },
  { id: 'security', label: 'Security' },
  { id: 'operations', label: 'Operations' },
  { id: 'other', label: 'Other' },
  { id: 'partners', label: 'External partners' },
  { id: 'facility', label: 'Facility & contracts' },
  { id: 'netsec', label: 'Firewall & LB' },
  { id: 'sequence', label: 'Sequence & lights-out' },
  { id: 'people', label: 'People & process' },
] as const;
export type SubtabId = (typeof SUBTABS)[number]['id'];

export const dcOf = (plan: Pick<Plan, 'dcExit'>): DcExit => plan.dcExit ?? defaultDcExit();
export const todayIso = (): string => new Date().toISOString().slice(0, 10);

/** The exit-sequence input from the plan, its decision and its wave plan. */
export function exitInputFor(plan: Plan, decision: PlanDecision | undefined, wavePlan: WavePlan | undefined, today: string): ExitInput {
  const { waveOf, waveEnds } = wavesFromPlan(plan, wavePlan ? { ...wavePlan, waves: wavePlan.waves.filter((w) => w.kind !== 'exit') } : undefined);
  const pins = new Map(plan.workloads.map((w) => [w.id, w.pin]));
  return {
    dcExit: dcOf(plan),
    workloads: plan.workloads,
    waveOf,
    waveEnds,
    targetOf: (id) => decision?.items[id]?.chosen?.platform ?? pins.get(id),
    today,
    planId: plan.id,
  };
}

/** Lights-out status: the servers' power state from the latest estate, contract statuses, and the two confirmations. */
export function lightsOutStatus(plan: Plan, flags: { readonly cmdb: boolean; readonly evidence: boolean }, today: string): LightsOutStatus {
  const known = plan.workloads.some((w) => w.facts?.powerState !== undefined);
  return {
    ...(known ? { poweredOnSources: plan.workloads.filter((w) => w.facts?.powerState === 'poweredOn').map((w) => w.name) } : {}),
    contractStatus: contractStatuses(dcOf(plan)),
    cmdbUpdated: flags.cmdb,
    evidenceComplete: flags.evidence,
    today,
  };
}

/** Every check on the pane, once each. */
export function dcFindings(plan: Plan, seq: ExitSequence, today: string): Finding[] {
  const dc = dcOf(plan);
  const all = [...seq.findings, ...checkArchives(dc.infra, today), ...checkAssets(dc.assets), ...planJobs(dc.infra).findings, ...duplicateIds(dc)];
  const seen = new Set<string>();
  const rank = { error: 0, warning: 1, info: 2 } as const;
  return all
    .filter((f) => {
      const k = `${f.code}|${f.path ?? ''}|${f.message}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** The exit waves as CSV (one row per step), the exit part of waves.csv. */
export function exitWavesCsv(seq: ExitSequence): string {
  const headers = ['wave', 'label', 'after_app_wave', 'date', 'step', 'kind', 'title', 'action', 'rollback'];
  const rows = seq.waves.flatMap((w) => w.steps.map((s) => ({ wave: w.n, label: w.label, after_app_wave: w.afterWave, date: s.date ?? w.date ?? '', step: s.id, kind: s.kind, title: s.title, action: s.action, rollback: s.rollback })));
  return rows.length ? toCsv(rows, headers) : `${headers.join(',')}\n`;
}

/** A re-IP map typed as `old new`, `old | new` or `old,new`, one pair a line. */
export function parseReIpMap(text: string): { readonly map: Map<string, string>; readonly bad: readonly string[] } {
  const map = new Map<string, string>();
  const bad: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const parts = t.split(/[\s,|]+/).filter(Boolean);
    if (parts.length !== 2) bad.push(t);
    else map.set(parts[0] as string, parts[1] as string);
  }
  return { map, bad };
}

/** The wave a partner notice belongs to: the link's app's wave, else the first app wave. */
export function noticeWave(views: readonly WaveView[], app: string | undefined): WaveView {
  return (app ? views.find((v) => v.apps.includes(app)) : undefined) ?? views.find((v) => v.kind !== 'exit') ?? { n: 0, apps: [], items: [] };
}

/* ---------------------------------------------------------------- the pane --- */

const note = (text: string): HTMLElement => el('p', { class: 'small muted', text });
const btn = (text: string, control: string, onClick: () => void, extra = ''): HTMLButtonElement =>
  el('button', { class: `btn btn-small ${extra}`.trim(), text, attrs: { type: 'button', 'data-control': control }, on: { click: onClick } }) as HTMLButtonElement;
function simpleTable(headers: readonly string[], rows: readonly (readonly (string | Node)[])[], control: string): HTMLElement {
  const body = el('tbody');
  for (const r of rows) append(body, el('tr', {}, ...r.map((c) => el('td', {}, c))));
  return el('div', { class: 'table-wrap', attrs: { 'data-control': control } }, el('table', { class: 'data-table' }, el('thead', {}, el('tr', {}, ...headers.map((h) => el('th', { text: h })))), body));
}
const badge = (text: string, tone: '' | 'good' | 'warn' | 'bad'): HTMLElement =>
  el('span', { class: tone === 'bad' ? 'badge badge-inferred' : `badge ${tone}`.trim(), text });
const pre = (text: string, control: string): HTMLElement => el('pre', { class: 'code-block', text, attrs: { 'data-control': control }, style: { maxWidth: '100%', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } });

interface Engines {
  readonly keys: readonly unknown[];
  readonly decision: PlanDecision | undefined;
  readonly wavePlan: WavePlan | undefined;
  readonly failure?: string;
}

interface Section {
  readonly node: HTMLElement;
  readonly grids: { readonly grid: PlanGrid; readonly sig: () => string; last: string }[];
  readonly derived: (() => void)[];
}

const FLAG_KEY = (planId: string): string => `archtoolkit.dcexit.lightsout.${planId}`;
function readFlags(planId: string): { cmdb: boolean; evidence: boolean } {
  try {
    const raw = globalThis.localStorage?.getItem(FLAG_KEY(planId));
    const v = raw ? (JSON.parse(raw) as { cmdb?: boolean; evidence?: boolean }) : {};
    return { cmdb: v.cmdb === true, evidence: v.evidence === true };
  } catch {
    return { cmdb: false, evidence: false };
  }
}
function writeFlags(planId: string, flags: { cmdb: boolean; evidence: boolean }): void {
  try {
    globalThis.localStorage?.setItem(FLAG_KEY(planId), JSON.stringify(flags));
  } catch {
    // A convenience; the checklist still works without it.
  }
}

export function mount(root: HTMLElement, ctx: PaneContext): void {
  const session = ctx.session;
  let engines: Engines | null = null;
  let dnsZones: DnsZone[] = [];
  let dnsFindings: Finding[] = [];

  /** The decision and wave plan, recomputed only when what they read changed (not for data-centre edits). */
  const enginesOf = (plan: Plan): Engines => {
    const keys = [plan.workloads, plan.databases, plan.apps, plan.edges, plan.requirements, plan.appPlans, plan.designOverrides, plan.waveSettings, plan.decision];
    if (engines && engines.keys.length === keys.length && engines.keys.every((k, i) => k === keys[i])) return engines;
    const model = planModel(plan);
    let wavePlan: WavePlan | undefined;
    let failure = model.failure;
    try {
      wavePlan = model.failure ? undefined : wavePlanFor(plan, model.decision);
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    }
    engines = { keys, decision: model.failure ? undefined : model.decision, wavePlan, ...(failure ? { failure } : {}) };
    return engines;
  };
  const sequenceOf = (plan: Plan): ExitSequence => {
    const e = enginesOf(plan);
    return exitSequence(exitInputFor(plan, e.decision, e.wavePlan, todayIso()));
  };

  const update = (change: (dc: DcExit) => DcExit, immediate = false): void =>
    session.update((p) => ({ ...p, dcExit: change(dcOf(p)) }), { immediate });

  // ---- header: the exit settings and the summary ---------------------------------------
  const modeSlot = el('div');
  const summarySlot = el('div', { attrs: { 'data-control': 'dc-summary' } });
  const exitDate = el('input', { attrs: { type: 'date', 'data-control': 'dc-exit-date' } }) as HTMLInputElement;
  const dualDays = el('input', { attrs: { type: 'number', min: '0', step: '1', 'data-control': 'dc-dual-days' } }) as HTMLInputElement;
  const removalDays = el('input', { attrs: { type: 'number', min: '0', step: '1', 'data-control': 'dc-removal-days' } }) as HTMLInputElement;
  const fillHeader = (): void => {
    const dc = dcOf(session.plan());
    if (document.activeElement !== exitDate) exitDate.value = dc.exitDate ?? '';
    if (document.activeElement !== dualDays) dualDays.value = String(dc.dualRunningDays);
    if (document.activeElement !== removalDays) removalDays.value = String(dc.hardwareRemovalDays);
  };
  exitDate.addEventListener('change', () => update((dc) => {
    const { exitDate: _x, ...rest } = dc;
    return exitDate.value ? { ...rest, exitDate: exitDate.value } : rest;
  }, true));
  const days = (v: string): number => Math.max(0, Math.floor(Number(v) || 0));
  dualDays.addEventListener('change', () => update((dc) => ({ ...dc, dualRunningDays: days(dualDays.value) }), true));
  removalDays.addEventListener('change', () => update((dc) => ({ ...dc, hardwareRemovalDays: days(removalDays.value) }), true));

  const subBar = el('div', { class: 'btn-row', attrs: { role: 'tablist', 'aria-label': 'Data centre areas', 'data-control': 'dc-subtabs' }, style: { marginBottom: 'var(--space-4)' } });
  const body = el('div', { class: 'stack' });
  const checksSlot = el('div', { attrs: { 'data-control': 'dc-checks' } });

  append(
    root,
    card(
      'Data centre exit',
      modeSlot,
      note('Everything in the building that is not a server: what happens to it (migrate, replace with a cloud service, retire, stays), and when. Servers and databases are planned on Application Migration; their waves drive the exit waves here.'),
      el('div', { class: 'row3', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(12rem, 1fr))' } },
        field('Exit date', exitDate, 'Contracts count their notice back from this or their end, whichever is first.'),
        field('Dual-running days', dualDays, 'Sources stay powered off (not deleted) and circuits live this long after their last wave.'),
        field('Hardware removal days', removalDays, 'The window to remove and sanitise the hardware.'),
      ),
      summarySlot,
    ),
    subBar,
    body,
    card('Checks', checksSlot),
  );

  // ---- grids ------------------------------------------------------------------------------
  const sections = new Map<SubtabId, Section>();
  let current: SubtabId = 'network';
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(refreshDerived, 300);
  };

  function gridCard<T extends { readonly id: string }>(g: DcGrid<T>, section: Section, ...extra: (HTMLElement | null)[]): HTMLElement {
    const read = (): readonly T[] => g.read(dcOf(session.plan()));
    const taken = (rows: readonly T[]): Set<string> => new Set([...g.ids(dcOf(session.plan())), ...rows.map((r) => r.id)]);
    const grid = planGrid<T>({
      id: g.id,
      noun: g.noun,
      columns: g.columns,
      read,
      write: (rows) => update((dc) => g.write(dc, rows)),
      create: (rows) => g.create(taken(rows)),
      ...(g.after ? { after: (b: T, n: T) => (g.after as (b: T, n: T) => T)(b, n) } : {}),
      filterKeys: g.filterKeys ?? [],
      bulkKeys: g.columns.slice(1).map((c) => c.key),
      pageSize: 50,
      csv: {
        fileName: `${g.id.replace(/^dc-/, '')}.csv`,
        export: (rows) => gridToCsv(g, rows),
        import: (text, rows) => gridFromCsv(g, text, rows, g.ids(dcOf(session.plan()))),
      },
      onChange: schedule,
    });
    const sig = (): string => JSON.stringify(read());
    section.grids.push({ grid, sig, last: sig() });
    return card(g.title, note(g.hint), grid.root, ...extra);
  }

  const slot = (control: string): HTMLElement => el('div', { attrs: { 'data-control': control } });

  function build(id: SubtabId): Section {
    const node = el('div', { class: 'stack', dataset: { sub: id } });
    const section: Section = { node, grids: [], derived: [] };
    const derived = (fn: () => void): void => {
      section.derived.push(fn);
    };
    switch (id) {
      case 'network': {
        const subnetSlot = slot('dc-subnet-decisions');
        append(node, gridCard(DEVICES_GRID, section), gridCard(CIRCUITS_GRID, section), gridCard(SUBNETS_GRID, section, el('h3', { text: 'Re-IP or keep-IP, per subnet' }), subnetSlot), gridCard(NET_SERVICES_GRID, section), dnsCard());
        derived(() => {
          clear(subnetSlot);
          const seq = sequenceOf(session.plan());
          if (seq.subnets.length === 0) {
            append(subnetSlot, note('No subnets yet.'));
            return;
          }
          append(subnetSlot, simpleTable(
            ['Subnet', 'CIDR', 'Site', 'Strategy', 'App waves', 'Last wave', 'Servers in it', 'Partner notices'],
            seq.subnets.map((s) => [s.name, s.cidr ?? '—', s.site ?? '—', s.strategy, s.waves.join(', ') || '—', String(s.lastWave), s.workloads.join(', ') || '—', s.notices.join(', ') || '—']),
            'dc-subnet-table',
          ), findingsList(seq.findings.filter((f) => f.code.startsWith('ip.') || f.code === 'dc.subnet-cidr'), 'No issue with the IP strategies.'));
        });
        break;
      }
      case 'storage': {
        const regSlot = slot('dc-retention-register');
        append(node, gridCard(ARRAYS_GRID, section), gridCard(BACKUP_GRID, section), gridCard(ARCHIVES_GRID, section), card('Retention obligation register', note('Every archive with a retention date or a legal hold. Under legal hold an archive cannot be retired (dc.legal-hold): the Disposition cell refuses it.'), regSlot));
        derived(() => {
          clear(regSlot);
          const today = todayIso();
          const rows = retentionRegister(dcOf(session.plan()).infra, today);
          if (rows.length === 0) append(regSlot, note('No archive has a retention date or a legal hold.'));
          else {
            append(regSlot, simpleTable(
              ['Archive', 'Media', 'Location', 'Content', 'Retention until', 'Legal hold', 'Obligation', 'Disposition', 'Owner'],
              rows.map((r) => [r.name, r.media || '—', r.location || '—', r.content || '—', r.retentionUntil ?? '—', r.legalHold ? badge('legal hold', 'bad') : r.expired ? badge('expired', 'good') : 'no', r.obligation ?? badge('not decided', 'warn'), r.disposition ?? '—', r.owner ?? '—']),
              'dc-retention-table',
            ));
          }
          const tiers = (Object.entries(ARCHIVE_TIERS) as [Platform, (typeof ARCHIVE_TIERS)[Platform]][]).map(([p, t]) => `${PLATFORM_LABELS[p]}: ${'none' in t ? t.none : `${t.name} (${t.terraform}, ${t.setting})`}`);
          append(regSlot, el('details', {}, el('summary', { class: 'small', text: 'Archive tiers per platform (migrate-to-archive-tier)' }), el('ul', { class: 'small' }, ...tiers.map((t) => el('li', { text: t })))));
          append(regSlot, findingsList(checkArchives(dcOf(session.plan()).infra, today), 'Every archive obligation is planned.'));
        });
        break;
      }
      case 'security':
        append(node, gridCard(SECURITY_GRID, section, note('AD and PKI move through the infrastructure patterns; SIEM goes to the landing zone’s SIEM choice; EDR and vulnerability-scanning agents are added to the post-cutover Ansible (edr_agents / scanner_agents). HSM / key sets are a runbook.')));
        break;
      case 'operations': {
        const jobsSlot = slot('dc-jobs-plan');
        append(node, gridCard(OPS_GRID, section), gridCard(JOBS_GRID, section, el('h3', { text: 'Jobs plan' }), jobsSlot));
        derived(() => {
          clear(jobsSlot);
          const { jobs, findings } = planJobs(dcOf(session.plan()).infra);
          if (jobs.length === 0) {
            append(jobsSlot, note('No scheduled jobs yet.'));
            return;
          }
          const pb = jobsPlaybook(jobs);
          append(
            jobsSlot,
            simpleTable(['Job', 'Scheduler', 'Host', 'Schedule', 'Becomes', 'How'], jobs.map((j) => [j.name, j.scheduler, j.host || '—', j.schedule || '—', j.mechanism, j.how]), 'dc-jobs-table'),
            el('div', { class: 'btn-row', style: { marginTop: 'var(--space-2)' } }, btn('Download jobs playbook (jobs.yml)', 'dc-jobs-playbook', () => downloadFile('jobs.yml', pb.text, 'text/yaml'), 'btn-primary')),
            pb.vaultVars.length ? note(`Passwords come from vault variables (no_log): ${pb.vaultVars.join(', ')}.`) : null,
            findingsList([...findings, ...pb.findings], 'Every job has a mechanism.'),
          );
        });
        break;
      }
      case 'other':
        append(node, gridCard(OTHER_GRID, section));
        break;
      case 'partners':
        append(node, gridCard(EXTERNAL_GRID, section, note('Partner notices for these links are on People & process; the translated NAT gives the egress addresses they allow-list (Firewall & LB).')));
        break;
      case 'facility': {
        const termSlot = slot('dc-terminate-by');
        const sanSlot = slot('dc-sanitisation');
        append(
          node,
          gridCard(CONTRACTS_GRID, section, el('h3', { text: 'Terminate by' }), termSlot),
          gridCard(ASSETS_GRID, section, el('h3', { text: 'Sanitisation register' }), sanSlot),
        );
        derived(() => {
          clear(termSlot);
          const plan = session.plan();
          const dc = dcOf(plan);
          const today = todayIso();
          const { tasks, findings } = contractTasks(dc, today);
          if (tasks.length === 0) append(termSlot, note('No contracts yet (circuits with a contract end appear here too).'));
          else {
            append(termSlot, simpleTable(
              ['Contract', 'From', 'Kind', 'Vendor', 'Ends', 'Notice days', 'Terminate by', 'Status', ''],
              tasks.map((t) => [t.source === 'circuit' ? (dc.infra.find((i) => i.id === t.id)?.name ?? t.id) : t.id, t.source, t.kind, t.vendor, t.ends, String(t.noticeDays), t.terminateBy ?? '—', t.status, t.overdue ? badge('overdue', 'bad') : t.status === 'terminated' ? badge('done', 'good') : '']),
              'dc-terminate-table',
            ), findingsList(findings, 'Every contract can still be terminated in time.'));
          }
          clear(sanSlot);
          const data = dc.assets.filter((a) => a.containsData);
          append(sanSlot, note(`NIST SP 800-88 (clear, purge or destroy): ${NIST_800_88}. ${data.length} of ${dc.assets.length} asset${dc.assets.length === 1 ? '' : 's'} hold data.`));
          if (data.length) {
            append(sanSlot, simpleTable(
              ['Asset', 'Kind', 'Serial', 'Method', 'Certificate', 'Disposed on', 'Register', ''],
              data.map((a) => [a.id, a.kind, a.serial ?? '—', a.sanitisation ?? '—', a.certificateId ?? '—', a.disposedOn ?? '—', a.registerUpdated ? 'updated' : '—', canDispose(a) ? badge('can dispose', 'good') : badge('needs method and certificate', 'warn')]),
              'dc-sanitisation-table',
            ));
          }
          append(sanSlot,
            el('div', { class: 'btn-row', style: { marginTop: 'var(--space-2)' } }, btn('Download asset register (asset-register.csv)', 'dc-asset-register', () => downloadFile('asset-register.csv', assetRegisterCsv(dc.assets), 'text/csv'))),
            findingsList(checkAssets(dc.assets), 'Every data-bearing asset is sanitised with a certificate.'));
        });
        break;
      }
      case 'netsec': {
        const refresh = mountNetsecView(node, { plan: () => session.plan(), decision: () => enginesOf(session.plan()).decision, today: todayIso });
        derived(refresh);
        break;
      }
      case 'sequence': {
        const seqSlot = slot('dc-sequence');
        const loSlot = slot('dc-lights-out');
        const repSlot = slot('dc-report');
        append(node, card('Exit waves', note('After the application waves: each step goes after the last app wave that still uses what it retires, dated at that wave’s end plus the dual-running days. Circuit cuts go internet first, MPLS last; each has its rollback, prefilled as a device change on the Network page.'), seqSlot), card('Lights-out checklist (gate G5)', loSlot), card('Data-centre exit report', repSlot));
        derived(() => renderSequence(seqSlot, loSlot, repSlot));
        break;
      }
      case 'people': {
        const raciSlot = slot('dc-raci');
        const commsSlot = slot('dc-comms');
        const trainSlot = slot('dc-training');
        append(node, card('RACI', raciSlot), card('Partner notices', commsSlot), card('Training', trainSlot));
        derived(() => renderPeople(raciSlot, commsSlot, trainSlot));
        break;
      }
    }
    return section;
  }

  // ---- DNS ------------------------------------------------------------------------------
  function dnsCard(): HTMLElement {
    const format = select([
      { value: 'infoblox', label: 'Infoblox WAPI JSON (zone_auth, record:a / aaaa / cname)' },
      { value: 'zone', label: 'Zone file (Windows Export-DnsServerZone or BIND)' },
      { value: 'csv', label: 'CSV (Get-DnsServerResourceRecord)' },
    ], 'infoblox');
    format.setAttribute('data-control', 'dns-format');
    const zoneName = el('input', { attrs: { type: 'text', placeholder: 'corp.example', 'data-control': 'dns-zone' } }) as HTMLInputElement;
    const text = el('textarea', { class: 'mono', attrs: { rows: '5', spellcheck: 'false', placeholder: 'Paste the export…', 'data-control': 'dns-paste' }, style: { width: '100%' } }) as HTMLTextAreaElement;
    const reip = el('textarea', { class: 'mono', attrs: { rows: '3', spellcheck: 'false', placeholder: '10.1.1.10 10.100.1.10\n2001:db8:1:1::10 2001:db8:100::10', 'data-control': 'dns-reip' }, style: { width: '100%' } }) as HTMLTextAreaElement;
    const platform = select(PLATFORM_OPTIONS, 'aws');
    platform.setAttribute('data-control', 'dns-platform');
    const out = slot('dns-output');
    const read = (name: string, body: string): void => {
      const zone = zoneName.value.trim() || name.replace(/\.(txt|dns|zone|csv|json)$/i, '');
      const r = format.value === 'infoblox' ? parseInfoblox(body) : format.value === 'zone' ? parseZoneFile(body, zone) : parseDnsCsv(body, zone);
      for (const z of r.zones) dnsZones = [...dnsZones.filter((x) => x.zone !== z.zone), z];
      dnsFindings = [...r.findings];
    };
    const render = (): void => {
      clear(out);
      if (dnsZones.length === 0) {
        append(out, findingsList(dnsFindings, ''), note('No zones imported.'));
        return;
      }
      const map = parseReIpMap(reip.value);
      const { zones, changed } = applyReIp(dnsZones, map.map);
      const tf = dnsTerraform(zones, platform.value as Platform);
      append(
        out,
        simpleTable(['Zone', 'View', 'A', 'AAAA', 'CNAME', ''], dnsZones.map((z) => [z.zone, z.view ?? '—', String(z.records.filter((r) => r.type === 'A').length), String(z.records.filter((r) => r.type === 'AAAA').length), String(z.records.filter((r) => r.type === 'CNAME').length), btn('Remove', `dns-remove-${z.zone}`, () => {
          dnsZones = dnsZones.filter((x) => x !== z);
          render();
        })]), 'dns-zones'),
        note(`Re-IP: ${changed} address${changed === 1 ? '' : 'es'} rewritten${map.bad.length ? `; lines not read: ${map.bad.join('; ')}` : ''}.`),
        el('div', { class: 'btn-row' }, tf.text ? btn(`Download dns-${platform.value}.tf`, 'dns-download', () => downloadFile(`dns-${platform.value}.tf`, tf.text, 'text/plain'), 'btn-primary') : null),
        tf.text ? el('details', {}, el('summary', { class: 'small', text: 'Terraform preview' }), pre(tf.text, 'dns-preview')) : null,
        findingsList([...dnsFindings, ...tf.findings], 'No issues found.'),
      );
    };
    reip.addEventListener('input', () => render());
    platform.addEventListener('change', render);
    const c = card(
      'DNS zones',
      note('Import the data-centre zones and write them as cloud private zones (Route 53, Azure Private DNS, Cloud DNS, OCI private views). A, AAAA and CNAME are carried; the rest is counted for review. The re-IP map rewrites addresses on the way. Zones stay in this page (they are not saved in the plan).'),
      el('div', { class: 'two' }, field('Format', format), field('Zone', zoneName, 'Zone file and CSV only: the zone they are for.')),
      text,
      el('div', { class: 'btn-row', style: { marginTop: 'var(--space-2)' } },
        btn('Import pasted', 'dns-import', () => {
          if (!text.value.trim()) return;
          read('pasted', text.value);
          text.value = '';
          render();
        }, 'btn-primary'),
        btn('Upload export…', 'dns-upload', () => void pickFiles('.json,.txt,.dns,.zone,.csv', true).then((files) => {
          for (const f of files) read(f.name, f.text);
          render();
        })),
      ),
      el('div', { class: 'two', style: { marginTop: 'var(--space-3)' } }, field('Re-IP map (old new, one a line)', reip), field('Target platform', platform)),
      out,
    );
    render();
    return c;
  }

  // ---- sequence, lights-out and report --------------------------------------------------
  function openOnNetwork(step: ExitStep, change: NetworkHandoffChange): void {
    const plan = session.plan();
    const rest = (step.handoff ?? []).filter((c) => c !== change);
    const ok = putHandoff('plan-to-network', `Data-centre exit (${plan.name}): ${step.title}`, { planId: plan.id, changes: [change, ...rest] });
    if (ok) globalThis.location.assign('network.html');
    else globalThis.alert?.('This browser does not allow the page to hand the change over (session storage is blocked).');
  }

  function renderSequence(seqSlot: HTMLElement, loSlot: HTMLElement, repSlot: HTMLElement): void {
    const plan = session.plan();
    const today = todayIso();
    const e = enginesOf(plan);
    const seq = sequenceOf(plan);
    clear(seqSlot);
    if (e.failure) append(seqSlot, el('div', { class: 'tip warn', text: `The app waves could not be worked out (${e.failure}); exit waves follow wave 0.` }));
    if (seq.waves.length === 0) append(seqSlot, note('Nothing in the data centre is marked to leave yet: give items a disposition (migrate, replace or retire).'));
    for (const w of seq.waves) {
      append(seqSlot, el('h3', { text: `${w.label}: after app wave ${w.afterWave}${w.date ? ` · ${w.date}` : ''}`, attrs: { 'data-control': `dc-wave-${w.label}` } }));
      append(seqSlot, simpleTable(
        ['Step', 'Date', 'Do', 'Rollback', 'Network page'],
        w.steps.map((s) => [
          s.title,
          s.date ?? w.date ?? '—',
          s.action,
          s.rollback,
          s.handoff?.length
            ? el('div', { class: 'btn-row' }, ...s.handoff.map((c, i) => btn(`Open on the Network page: ${c.label.split(': ').slice(1).join(': ') || c.blueprint}`, `dc-open-network-${s.id}-${i}`, () => openOnNetwork(s, c)))) as Node
            : '—',
        ]),
        `dc-steps-${w.label}`,
      ));
    }
    const payload = networkHandoff(seq, plan.id);
    append(seqSlot, el('div', { class: 'btn-row', style: { marginTop: 'var(--space-3)' } },
      btn('Download exit-sequence.md', 'dc-seq-md', () => downloadFile('exit-sequence.md', exitSequenceMarkdown(seq), 'text/markdown')),
      btn('Download exit waves (CSV)', 'dc-seq-csv', () => downloadFile('exit-waves.csv', exitWavesCsv(seq), 'text/csv')),
      payload.changes.length
        ? btn(`Open all ${payload.changes.length} circuit changes on the Network page`, 'dc-open-network-all', () => {
          if (putHandoff('plan-to-network', `Data-centre exit (${plan.name}): circuit cuts`, payload)) globalThis.location.assign('network.html');
        })
        : null,
    ));
    append(seqSlot, note(`Exit waves in the wave plan: ${exitWaves(seq).map((w) => `${w.name} (wave ${w.n}${w.gates?.length ? `, gate ${w.gates.join(', ')}` : ''})`).join(', ') || 'none'}.`));

    // Lights-out.
    clear(loSlot);
    const flags = readFlags(plan.id);
    const criteria = lightsOut(dcOf(plan), lightsOutStatus(plan, flags, today));
    const list = el('ul', { class: 'checks', attrs: { 'data-control': 'dc-lights-out-list' }, style: { listStyle: 'none', paddingLeft: '0' } });
    for (const c of criteria) {
      append(list, el('li', { dataset: { criterion: c.id, met: String(c.met) }, style: { marginBottom: 'var(--space-2)' } },
        badge(c.met ? 'met' : 'open', c.met ? 'good' : 'warn'), ' ',
        el('strong', { text: lightsOutMarkdown([c]).split('\n')[2]?.replace(/^- \[[ x]\] /, '').split(':')[0] ?? c.id }), ' ',
        el('span', { class: 'small', text: c.detail }),
        c.auto ? null : el('span', { class: 'small muted', text: ' (confirmed by hand)' })));
    }
    const cmdb = el('input', { attrs: { type: 'checkbox', 'data-control': 'dc-lo-cmdb' } }) as HTMLInputElement;
    cmdb.checked = flags.cmdb;
    const evidence = el('input', { attrs: { type: 'checkbox', 'data-control': 'dc-lo-evidence' } }) as HTMLInputElement;
    evidence.checked = flags.evidence;
    const flip = (): void => {
      writeFlags(plan.id, { cmdb: cmdb.checked, evidence: evidence.checked });
      renderSequence(seqSlot, loSlot, repSlot);
    };
    cmdb.addEventListener('change', flip);
    evidence.addEventListener('change', flip);
    append(loSlot,
      note('Computed from every grid: dispositions done (the Done column), circuits cut, contracts terminated (Status), assets sanitised with a certificate, archives dispositioned, and the servers’ power state from the latest estate import.'),
      list,
      el('div', { class: 'btn-row' },
        el('label', { class: 'checkbox' }, cmdb, el('span', { text: 'The CMDB is updated' })),
        el('label', { class: 'checkbox' }, evidence, el('span', { text: 'The evidence pack is complete' })),
      ),
      el('div', { class: 'btn-row', style: { marginTop: 'var(--space-2)' } }, btn('Download lights-out.md', 'dc-lo-md', () => downloadFile('lights-out.md', lightsOutMarkdown(criteria), 'text/markdown'))),
    );

    // Report.
    clear(repSlot);
    const rctx = { plan, date: today };
    append(repSlot,
      note('The data-centre exit report: the exit settings, the sequence, and every grid (infrastructure, external links, contracts, assets), as Markdown or as a workbook.'),
      el('div', { class: 'btn-row' },
        btn('Download report (.md)', 'dc-report-md', () => void dcExitReport(rctx).then((r) => downloadFile(reportFileName(rctx, 'dc-exit', 'md'), r.markdown, 'text/markdown')), 'btn-primary'),
        btn('Download report (.xlsx)', 'dc-report-xlsx', () => void dcExitReport(rctx).then((r) => downloadFile(reportFileName(rctx, 'dc-exit', 'xlsx'), r.xlsx, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))),
      ),
    );
  }

  // ---- people and process ---------------------------------------------------------------
  function renderPeople(raciSlot: HTMLElement, commsSlot: HTMLElement, trainSlot: HTMLElement): void {
    const plan = session.plan();
    const raci: readonly RaciRow[] = plan.governance?.raci.length ? plan.governance.raci : defaultRaci(plan);
    clear(raciSlot);
    const files = raciFiles(raci);
    append(raciSlot,
      note(`${plan.governance?.raci.length ? 'The plan’s RACI' : 'The default RACI (the plan has none yet)'}: R responsible, A accountable (exactly one), C consulted, I informed. Roles, not people. It is edited on Waves › Governance.`),
      simpleTable(['Activity', 'Phase', ...RACI_ROLES.map(raciRoleLabel)], raci.map((r) => [r.activity, r.phase, ...RACI_ROLES.map((role) => r.cells[role] ?? '')]), 'dc-raci-table'),
      el('div', { class: 'btn-row', style: { marginTop: 'var(--space-2)' } },
        btn('Edit on Governance', 'dc-raci-edit', () => ctx.go('waves:governance')),
        btn('Download raci.md', 'dc-raci-md', () => downloadFile('raci.md', files['governance/raci.md'] ?? '', 'text/markdown')),
        btn('Download raci.csv', 'dc-raci-csv', () => downloadFile('raci.csv', files['governance/raci.csv'] ?? '', 'text/csv')),
      ),
      findingsList(validateRaci(raci), 'Every activity has one accountable role.'),
    );

    clear(commsSlot);
    const dc = dcOf(plan);
    const views = waveViews(plan, enginesOf(plan).wavePlan);
    if (dc.external.length === 0) append(commsSlot, note('No external links yet (External partners): partners that allow-list the data centre’s addresses get a notice here.'));
    else {
      const notices = dc.external.map((link) => ({
        link,
        notice: partnerNotice(link, { plan, wave: noticeWave(views, link.app), raci, ...(plan.execution ? { execution: plan.execution } : {}), ...(plan.governance ? { governance: plan.governance } : {}) }),
      }));
      append(commsSlot,
        note('One notice per external link: the new addresses and the date, sent the link’s notice days before its app’s wave. The helpdesk and sender lines come from Governance.'),
        simpleTable(['Party', 'Link', 'Subject', 'Send by', ''], notices.map(({ link, notice }) => [
          link.party, `${link.kind} ${link.endpoint}`, notice.subject, /\*\*Send by:\*\* (.*)/.exec(notice.markdown)?.[1] ?? '—',
          btn('Download', `dc-notice-${link.id}`, () => downloadFile(`${notice.id}.md`, notice.markdown, 'text/markdown')),
        ]), 'dc-notices'),
        el('div', { class: 'btn-row', style: { marginTop: 'var(--space-2)' } }, btn('Download all notices', 'dc-notices-all', () => downloadFile('partner-notices.md', notices.map((n) => n.notice.markdown).join('\n---\n\n'), 'text/markdown'))),
      );
    }

    clear(trainSlot);
    const training = trainingPlan(plan, raci);
    append(trainSlot,
      note('Per platform in use: the team’s skill (from the requirements), the gap, and the roles that run something there.'),
      training.rows.length
        ? simpleTable(['Platform', 'Skill', 'Gap', 'Roles with run activities', 'Learning portal'], training.rows.map((r) => [
          PLATFORM_LABELS[r.platform], r.skill, r.gap ? badge('gap', 'warn') : badge('none', 'good'), r.roles.join(', ') || '—',
          el('a', { text: r.portal, attrs: { href: r.url, target: '_blank', rel: 'noopener noreferrer' } }),
        ]), 'dc-training-table')
        : note('No platform chosen yet.'),
      el('div', { class: 'btn-row', style: { marginTop: 'var(--space-2)' } }, btn('Download training-plan.md', 'dc-training-md', () => downloadFile('training-plan.md', training.markdown, 'text/markdown'))),
    );
  }

  // ---- summary and checks ----------------------------------------------------------------
  function renderSummary(seq: ExitSequence): void {
    const plan = session.plan();
    const dc = dcOf(plan);
    clear(modeSlot);
    if (plan.mode !== 'dc-exit') {
      append(modeSlot, el('div', { class: 'tip warn', attrs: { 'data-control': 'dc-mode-note' } }, el('span', { text: 'The plan is not in data-centre exit mode, so the exit waves are not added to the wave plan. Set Plan mode to “Data-centre exit” above to use them.' })));
    }
    clear(summarySlot);
    const today = todayIso();
    const open = undecided(dc).reduce((n, x) => n + x.count, 0);
    const overdue = contractTasks(dc, today).tasks.filter((t) => t.overdue).length;
    const unsanitised = dc.assets.filter((a) => !canDispose(a)).length;
    const steps = seq.waves.reduce((n, w) => n + w.steps.length, 0);
    append(summarySlot, statGrid(
      stat({ label: 'Items', value: dc.infra.length, sub: open ? `${open} without a disposition` : 'every one decided', tone: open ? 'warn' : 'neutral' }),
      stat({ label: 'Exit waves', value: seq.waves.length, sub: `${steps} step${steps === 1 ? '' : 's'}` }),
      stat({ label: 'Contracts', value: dc.contracts.length, sub: overdue ? `${overdue} past terminate-by` : 'none overdue', tone: overdue ? 'danger' : 'neutral' }),
      stat({ label: 'Assets', value: dc.assets.length, sub: unsanitised ? `${unsanitised} need sanitisation records` : 'records complete', tone: unsanitised ? 'warn' : 'neutral' }),
      stat({ label: 'External links', value: dc.external.length }),
    ));
  }

  function refreshDerived(): void {
    timer = undefined;
    const plan = session.plan();
    fillHeader();
    const seq = sequenceOf(plan);
    renderSummary(seq);
    clear(checksSlot);
    append(checksSlot, findingsList(dcFindings(plan, seq, todayIso()), 'No issues found.'));
    for (const fn of sections.get(current)?.derived ?? []) fn();
  }

  // ---- sub-tabs ---------------------------------------------------------------------------
  const buttons = new Map<SubtabId, HTMLButtonElement>();
  for (const t of SUBTABS) {
    const b = el('button', { class: 'btn btn-small', text: t.label, attrs: { type: 'button', role: 'tab', 'data-control': `dc-sub-${t.id}` }, on: { click: () => ctx.go(`datacentre:${t.id}`) } }) as HTMLButtonElement;
    buttons.set(t.id, b);
    append(subBar, b);
  }
  const show = (arg: string): void => {
    const wanted = (arg.split('/')[0] ?? '') as SubtabId;
    const id: SubtabId = SUBTABS.some((t) => t.id === wanted) ? wanted : current;
    current = id;
    for (const [k, b] of buttons) {
      b.setAttribute('aria-selected', String(k === id));
      b.classList.toggle('btn-primary', k === id);
    }
    let section = sections.get(id);
    if (!section) {
      section = build(id);
      sections.set(id, section);
      append(body, section.node);
    }
    for (const [k, s] of sections) s.node.style.display = k === id ? '' : 'none';
    // A grid that changed while hidden is rebuilt when shown.
    for (const g of section.grids) {
      const now = g.sig();
      if (now !== g.last && !g.grid.busy()) {
        g.grid.render();
        g.last = now;
      }
    }
    refreshDerived();
  };
  ctx.onArg(show);
  show(ctx.arg());

  session.subscribe((_plan, kind) => {
    if (kind === 'saved') return;
    const section = sections.get(current);
    for (const g of section?.grids ?? []) {
      if (g.grid.busy()) {
        g.last = g.sig();
        continue;
      }
      const now = g.sig();
      if (now !== g.last) {
        g.grid.render();
        g.last = now;
      }
    }
    schedule();
  });
}
