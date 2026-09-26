/**
 * Reports, exports and the evidence pack (addendum A.10.13), the KPIs
 * (research 6(b) G03) and the RAID / decision-log exports (A.8.5, A.8.6).
 *
 * | Report                     | Formats                      |
 * |----------------------------|------------------------------|
 * | Executive summary          | md, html (print to PDF), .doc |
 * | Application design (per app) | md, html, .doc             |
 * | Wave report                | md, html                     |
 * | Status report (weekly)     | md                           |
 * | Estate capacity            | md, csv, xlsx                |
 * | Data-centre exit           | md, xlsx                     |
 * | Grids                      | csv, xlsx                    |
 * | Evidence pack              | zip                          |
 *
 * The .doc is HTML that Word opens (the base design's method); it is not a
 * true .docx, and `DOC_NOTE` says so for the button's title.
 *
 * No footprints: nothing about the user or the machine is written. The only
 * date is the report date the user picks (or the plan's `savedAt`); the zip and
 * xlsx entries are stamped with the plan's `savedAt`, so a re-export of the same
 * plan is byte-identical.
 */

import { zip } from '../../../kit/archive.ts';
import { writeXlsx, type XlsxCellValue, type XlsxSheet } from '../../../kit/xlsx-write.ts';
import { PLATFORM_INFO } from '../../platforms.ts';
import { CYBER_CONTROLS } from '../controls.ts';
import { DISPOSITION_OPTIONS, ITEM_STATE_RANK, labelOf, strategyOf } from '../options.ts';
import type {
  AppPlan, AuditEntry, ChangeRecord, Disposition, ItemState, ItemStatus, Plan, Platform, RaciRow, RaidRisk, RateCard, TargetDesign, Tracker,
} from '../types.ts';
import { auditCsv } from './audit.ts';
import { cmdbFiles, rowsCsv } from './cmdb.ts';
import { appComplexity, appEdges, appScope, downtimeFromDecision } from './complexity.ts';
import { changeRequestFiles, changeRequests } from './changes.ts';
import { waveViews, type WaveView } from './comms.ts';
import { ledgerCsv, ledgerTotals, reclaimLedger } from './licences.ts';
import { OPS_BY_PLATFORM, appPlatform } from './ops-runbooks.ts';
import { defaultRaci, raciCsv, raciMarkdown, raciRoleLabel } from './raci.ts';
import { estimateLabel, exitedRunRate, rateCardCsv } from './ratecard.ts';
import { fileSlug, signOffFiles } from './signoffs.ts';
import { DR_PATTERNS } from '../controls.ts';

export const DOC_MIME = 'application/msword';
export const DOC_NOTE = 'Word opens this file: it is HTML saved as .doc, not a true .docx.';

export interface ReportContext {
  readonly plan: Plan;
  /** yyyy-mm-dd: the report date the user picked; default the plan's savedAt. */
  readonly date?: string;
  readonly tracker?: Tracker;
  /** Default: waveViews(plan). */
  readonly waves?: readonly WaveView[];
  readonly design?: TargetDesign;
  /** Default: plan.governance.raci, else defaultRaci(plan). */
  readonly raci?: readonly RaciRow[];
  readonly ratecard?: RateCard;
  readonly audit?: readonly AuditEntry[];
  readonly changes?: readonly ChangeRecord[];
}

export const reportDate = (ctx: Pick<ReportContext, 'plan' | 'date'>): string => (ctx.date ?? ctx.plan.savedAt).slice(0, 10);
const wavesOf = (ctx: ReportContext): readonly WaveView[] => ctx.waves ?? waveViews(ctx.plan);
const raciOf = (ctx: ReportContext): readonly RaciRow[] => (ctx.raci ?? (ctx.plan.governance?.raci.length ? ctx.plan.governance.raci : defaultRaci(ctx.plan)));

/** `<plan-slug>-<report>-<date>.<ext>`: the plan slug and the report date, nothing else. */
export function reportFileName(ctx: Pick<ReportContext, 'plan' | 'date'>, report: string, ext: string): string {
  return `${fileSlug(ctx.plan.name)}-${report}-${reportDate(ctx)}.${ext}`;
}

// ---------------------------------------------------------------------------
// Markdown → HTML (print CSS) and HTML-as-.doc
// ---------------------------------------------------------------------------

const esc = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function inline(t: string): string {
  return esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
}
const splitRow = (line: string): string[] => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

/** The Markdown this module writes (headings, paragraphs, lists, tables, code) as HTML. */
export function markdownToHtmlBody(md: string): string {
  const out: string[] = [];
  const lines = md.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.startsWith('```')) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? '').startsWith('```')) code.push(lines[i++] ?? '');
      i += 1;
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push(`<h${h[1]!.length}>${inline(h[2]!)}</h${h[1]!.length}>`);
      i += 1;
      continue;
    }
    if (line.trim().startsWith('|') && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1] ?? '') && (lines[i + 1] ?? '').includes('-')) {
      const head = splitRow(line);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && (lines[i] ?? '').trim().startsWith('|')) body.push(splitRow(lines[i++] ?? ''));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (/^\s*(- \[[ x]\] |- |\d+\. )/.test(line)) {
      const ordered = /^\s*\d+\. /.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*(- \[[ x]\] |- |\d+\. )/.test(lines[i] ?? '')) {
        const text = (lines[i] ?? '').replace(/^\s*(- \[([ x])\] |- |\d+\. )/, (_m, _all, box: string | undefined) => (box !== undefined ? (box === 'x' ? '☑ ' : '☐ ') : ''));
        items.push(`<li>${inline(text)}</li>`);
        i += 1;
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && (lines[i] ?? '').trim() && !/^(#|```|\s*\||\s*- |\s*\d+\. )/.test(lines[i] ?? '')) para.push(lines[i++] ?? '');
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}

const PRINT_CSS = [
  'body{font-family:"Segoe UI",Calibri,Arial,sans-serif;font-size:11pt;line-height:1.4;color:#1a1a1a;max-width:1000px;margin:24px auto;padding:0 16px}',
  'h1{font-size:20pt;border-bottom:2px solid #2f5597;padding-bottom:4px}h2{font-size:14pt;color:#2f5597;margin-top:20px}h3{font-size:12pt}',
  'table{border-collapse:collapse;width:100%;margin:8px 0;font-size:9.5pt}th,td{border:1px solid #bbb;padding:4px 6px;text-align:left;vertical-align:top}th{background:#d9e1f2}',
  'code,pre{font-family:Consolas,"Courier New",monospace;font-size:9pt}pre{background:#f4f4f4;padding:8px;white-space:pre-wrap}',
  '@media print{body{margin:0;max-width:none}h2{page-break-after:avoid}table,pre{page-break-inside:avoid}a{color:inherit;text-decoration:none}}',
].join('\n');

/** A standalone HTML page with print CSS (the browser's Save as PDF). */
export function markdownToHtml(md: string, title: string): string {
  return `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>${esc(title)}</title>\n<style>\n${PRINT_CSS}\n</style>\n</head>\n<body>\n${markdownToHtmlBody(md)}\n</body>\n</html>\n`;
}

/** HTML that Word opens as a document (saved as .doc, with a BOM added by the download). */
export function htmlAsDoc(md: string, title: string): string {
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">\n<head>\n<meta charset="utf-8">\n<title>${esc(title)}</title>\n<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->\n<style>\n${PRINT_CSS}\n</style>\n</head>\n<body>\n${markdownToHtmlBody(md)}\n</body>\n</html>\n`;
}

export interface RenderedReport { readonly title: string; readonly markdown: string; readonly html: string; readonly doc: string }
function render(title: string, md: string): RenderedReport {
  return { title, markdown: md, html: markdownToHtml(md, title), doc: htmlAsDoc(md, title) };
}

const cell = (t: unknown): string => String(t ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const table = (head: readonly string[], rows: readonly (readonly unknown[])[]): string[] =>
  [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)];
const pct = (n: number, d: number): string => (d > 0 ? `${Math.round((n / d) * 100)}%` : '—');

// ---------------------------------------------------------------------------
// KPIs and tiles (A.8.6; G03)
// ---------------------------------------------------------------------------

const atOrPast = (s: ItemStatus | undefined, state: ItemState): boolean => !!s && !s.removed && ITEM_STATE_RANK[s.state] >= ITEM_STATE_RANK[state];

export interface Kpis {
  readonly inScope: number;
  readonly cutOver: number;
  readonly validated: number;
  readonly accepted: number;
  readonly decommissioned: number;
  readonly failed: number;
  readonly blocked: number;
  readonly rolledBack: number;
  readonly pctByCount: number;
  readonly pctByVcpu: number;
  readonly moved: { readonly vcpu: number; readonly ramGib: number; readonly storageGib: number };
  readonly hostsFreed: number;
  readonly retained: number;
  readonly retired: number;
  /** Migrated vs plan: items whose wave has ended, and how many of them are cut over (G03). */
  readonly migratedVsPlan: { readonly planned: number; readonly done: number };
  readonly decommissionedVsPlan: { readonly planned: number; readonly done: number };
  readonly byStrategy: Readonly<Record<string, number>>;
  readonly licencesFreed: Readonly<Record<string, number>>;
}

export function kpis(ctx: ReportContext): Kpis {
  const { plan } = ctx;
  const items = ctx.tracker?.items ?? {};
  const date = reportDate(ctx);
  const moving = [...plan.workloads, ...plan.databases].filter((i) => !('disposition' in i) || (i.disposition !== 'retire' && i.disposition !== 'retain'));
  const st = (id: string) => items[id];
  const count = (state: ItemState) => moving.filter((i) => atOrPast(st(i.id), state)).length;
  const flag = (f: ItemStatus['flags'][number]) => Object.values(items).filter((s) => !s.removed && s.flags.includes(f)).length;
  const vcpuAll = moving.reduce((s, i) => s + i.vcpu, 0);
  const cut = moving.filter((i) => atOrPast(st(i.id), 'cut-over'));
  const waveEnd = new Map<string, string | undefined>();
  for (const w of wavesOf(ctx)) for (const it of w.items) waveEnd.set(it.id, w.end);
  const due = moving.filter((i) => (waveEnd.get(i.id) ?? '9999') <= date);
  const decomDue = (id: string) => {
    const end = waveEnd.get(id);
    const crit = plan.workloads.find((w) => w.id === id)?.criticality ?? 'tier2';
    const keep = plan.execution?.keepDays[crit] ?? 14;
    if (!end) return false;
    const d = new Date(`${end.slice(0, 10)}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + keep);
    return d.toISOString().slice(0, 10) <= date;
  };
  const byStrategy: Record<string, number> = {};
  for (const w of plan.workloads) {
    const s = strategyOf({ ...(w.strategy ? { strategy: w.strategy } : {}), disposition: (plan.decision?.items[w.id]?.disposition ?? w.disposition ?? 'rehost') as Disposition }) ?? 'new';
    byStrategy[s] = (byStrategy[s] ?? 0) + 1;
  }
  const ledger = ctx.tracker ? reclaimLedger(plan, ctx.tracker) : [];
  const totals = ledgerTotals(ledger);
  return {
    inScope: moving.length,
    cutOver: cut.length,
    validated: count('validated'),
    accepted: count('accepted'),
    decommissioned: count('decommissioned'),
    failed: flag('failed'),
    blocked: flag('blocked'),
    rolledBack: flag('rolled-back'),
    pctByCount: moving.length ? Math.round((cut.length / moving.length) * 100) : 0,
    pctByVcpu: vcpuAll ? Math.round((cut.reduce((s, i) => s + i.vcpu, 0) / vcpuAll) * 100) : 0,
    moved: {
      vcpu: cut.reduce((s, i) => s + i.vcpu, 0),
      ramGib: cut.reduce((s, i) => s + i.ramGib, 0),
      storageGib: cut.reduce((s, i) => s + ('disksGib' in i ? i.disksGib.reduce((a, b) => a + b, 0) : i.sizeGib), 0),
    },
    hostsFreed: (ctx.tracker?.decommissions ?? []).reduce((s, d) => s + (d.hostsFreed ?? 0), 0),
    retained: plan.workloads.filter((w) => (plan.decision?.items[w.id]?.disposition ?? w.disposition) === 'retain').length,
    retired: plan.workloads.filter((w) => (plan.decision?.items[w.id]?.disposition ?? w.disposition) === 'retire').length,
    migratedVsPlan: { planned: due.length, done: due.filter((i) => atOrPast(st(i.id), 'cut-over')).length },
    decommissionedVsPlan: { planned: moving.filter((i) => decomDue(i.id)).length, done: moving.filter((i) => decomDue(i.id) && atOrPast(st(i.id), 'decommissioned')).length },
    byStrategy,
    licencesFreed: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, v.freed + v.reassigned + v.terminated])),
  };
}

export function kpiMarkdown(k: Kpis): string[] {
  return [
    ...table(['KPI', 'Value'], [
      ['In scope', k.inScope], ['Cut over', `${k.cutOver} (${k.pctByCount}% by count, ${k.pctByVcpu}% by vCPU)`], ['Validated', k.validated], ['Accepted', k.accepted], ['Decommissioned', k.decommissioned],
      ['Failed / blocked / rolled back', `${k.failed} / ${k.blocked} / ${k.rolledBack}`],
      ['Migrated vs plan (waves ended)', `${k.migratedVsPlan.done} of ${k.migratedVsPlan.planned}`],
      ['Decommissioned vs plan (retention ended)', `${k.decommissionedVsPlan.done} of ${k.decommissionedVsPlan.planned}`],
      ['Moved', `${k.moved.vcpu} vCPU, ${k.moved.ramGib} GiB RAM, ${k.moved.storageGib} GiB storage`],
      ['Source hosts freed', k.hostsFreed], ['Retained / retired', `${k.retained} / ${k.retired}`],
      ['Servers per strategy', Object.entries(k.byStrategy).sort().map(([s, n]) => `${s} ${n}`).join(', ') || '—'],
      ['Licences reclaimed', Object.entries(k.licencesFreed).sort().map(([s, n]) => `${s} ${n}`).join(', ') || '—'],
    ]),
  ];
}

// ---------------------------------------------------------------------------
// Wave progress, RAG and risks
// ---------------------------------------------------------------------------

export interface WaveProgress { readonly wave: number; readonly items: number; readonly plannedEnd: string; readonly cutOver: number; readonly validated: number; readonly decommissioned: number; readonly pct: number; readonly forecastEnd: string; readonly onTrack: boolean }

export function waveProgress(ctx: ReportContext): WaveProgress[] {
  const items = ctx.tracker?.items ?? {};
  const date = reportDate(ctx);
  return wavesOf(ctx).map((w) => {
    const sts = w.items.map((i) => items[i.id]);
    const cut = sts.filter((s) => atOrPast(s, 'cut-over')).length;
    const pctDone = w.items.length ? Math.round((cut / w.items.length) * 100) : 0;
    const plannedEnd = (w.end ?? '').slice(0, 10);
    const late = !!plannedEnd && plannedEnd < date && pctDone < 100;
    return {
      wave: w.n, items: w.items.length, plannedEnd, cutOver: cut,
      validated: sts.filter((s) => atOrPast(s, 'validated')).length,
      decommissioned: sts.filter((s) => atOrPast(s, 'decommissioned')).length,
      pct: pctDone, forecastEnd: late ? 'late' : plannedEnd, onTrack: !late && !sts.some((s) => s?.flags.includes('blocked') || s?.flags.includes('failed')),
    };
  });
}

export const riskScore = (r: Pick<RaidRisk, 'probability' | 'impact'>): number => r.probability * r.impact;
export function topRisks(tracker: Pick<Tracker, 'raid'> | undefined, n = 5): RaidRisk[] {
  return [...(tracker?.raid.risks ?? [])].filter((r) => r.status !== 'closed').sort((a, b) => riskScore(b) - riskScore(a) || a.id.localeCompare(b.id)).slice(0, n);
}

export type Rag = 'Green' | 'Amber' | 'Red';
export function rag(ctx: ReportContext): { rag: Rag; reason: string } {
  const issues = (ctx.tracker?.raid.issues ?? []).filter((i) => i.status === 'open' || i.status === 'in-progress');
  const late = waveProgress(ctx).filter((w) => w.forecastEnd === 'late');
  if (issues.some((i) => i.severity === 'sev1')) return { rag: 'Red', reason: `${issues.filter((i) => i.severity === 'sev1').length} open Sev 1 issue(s).` };
  if (late.length > 0) return { rag: 'Red', reason: `Wave ${late.map((w) => w.wave).join(', ')} past its planned end and not complete.` };
  const k = kpis(ctx);
  if (issues.some((i) => i.severity === 'sev2') || k.blocked > 0 || k.failed > 0) return { rag: 'Amber', reason: `${k.blocked} blocked, ${k.failed} failed item(s); ${issues.filter((i) => i.severity === 'sev2').length} open Sev 2 issue(s).` };
  return { rag: 'Green', reason: 'On plan: no late waves, no open Sev 1 / Sev 2 issues, nothing blocked.' };
}

// ---------------------------------------------------------------------------
// The reports
// ---------------------------------------------------------------------------

function platformLabelList(ps: readonly Platform[]): string {
  return ps.map((p) => PLATFORM_INFO[p].label).join(', ') || 'not decided yet';
}

export function executiveSummary(ctx: ReportContext): RenderedReport {
  const { plan } = ctx;
  const date = reportDate(ctx);
  const d = plan.decision;
  const byDisp = new Map<string, Map<string, number>>();
  for (const w of plan.workloads) {
    const di = d?.items[w.id];
    const disp = labelOf(DISPOSITION_OPTIONS, di?.disposition ?? w.disposition ?? 'rehost');
    const p = di?.chosen?.platform ? PLATFORM_INFO[di.chosen.platform].label : '—';
    const m = byDisp.get(disp) ?? new Map<string, number>();
    m.set(p, (m.get(p) ?? 0) + 1);
    byDisp.set(disp, m);
  }
  const platforms = [...new Set([...byDisp.values()].flatMap((m) => [...m.keys()]))].sort();
  const r = rag(ctx);
  const complexity = plan.apps.map((a) => appComplexity(plan, a.name, { on: date })).filter((c) => c.risk === 'High');
  const licenceNeeds = new Map<string, number>();
  for (const i of Object.values(d?.items ?? {})) if (i.chosen?.licence && i.chosen.licence.count > 0) licenceNeeds.set(i.chosen.licence.kind, (licenceNeeds.get(i.chosen.licence.kind) ?? 0) + i.chosen.licence.count);
  const exited = ctx.ratecard ? exitedRunRate(ctx.ratecard) : [];
  const md = [
    `# Executive summary: ${plan.name}`, '', `Report date: ${date}`, '',
    '## Scope', '',
    `Mode: ${plan.mode ?? 'migrate'}. ${plan.apps.length} application(s), ${plan.workloads.length} server(s), ${plan.databases.length} database(s).`, '',
    '## Platforms and why', '',
    `Chosen: ${platformLabelList(d?.platforms ?? [])}.${d?.subsetScores[0] ? ` The chosen set scored ${d.subsetScores[0].score} against the alternatives the rules considered.` : ''}`, '',
    '## Applications by disposition and platform', '',
    ...(platforms.length ? table(['Disposition', ...platforms], [...byDisp.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([disp, m]) => [disp, ...platforms.map((p) => m.get(p) ?? 0)])) : ['No servers yet.']), '',
    '## Timeline and status', '',
    `**RAG: ${r.rag}.** ${r.reason}`, '',
    ...table(['Wave', 'Items', 'Planned end', 'Cut over', '%', 'On track'], waveProgress(ctx).map((w) => [w.wave, w.items, w.plannedEnd || '—', w.cutOver, `${w.pct}%`, w.onTrack ? 'yes' : 'no'])), '',
    ...kpiMarkdown(kpis(ctx)), '',
    '## Top risks', '',
    ...(topRisks(ctx.tracker).length ? table(['ID', 'Risk', 'Score', 'Response', 'Status'], topRisks(ctx.tracker).map((x) => [x.id, x.risk, riskScore(x), x.response, x.status])) : ['No risks logged.']), '',
    ...(complexity.length ? [`High-risk applications (complexity or criticality): ${complexity.map((c) => `${c.app} (${c.score})`).join(', ')}.`, ''] : []),
    '## Licence position', '',
    ...(licenceNeeds.size ? table(['Licence', 'Needed on the targets'], [...licenceNeeds.entries()].sort().map(([k, n]) => [k, n])) : ['No bring-your-own licences needed on the targets.']), '',
    ...(ctx.ratecard ? ['## Your rates', '', ...exited.map((e) => `- On-premises run-rate being exited: ${e.total} ${e.currency} per ${e.unit} — ${estimateLabel(e.sources.join('; '))}`), ...(exited.length ? [] : ['- Rate card loaded; estimates appear in Compare and Capacity.']), ''] : []),
  ].join('\n');
  return render(`Executive summary — ${plan.name}`, md);
}

export function appDesignDocument(ctx: ReportContext, appName: string, appPlan?: AppPlan): RenderedReport {
  const { plan } = ctx;
  const scope = appScope(plan, appName);
  const app = scope.app;
  const date = reportDate(ctx);
  const platform = appPlatform(plan, appName, appPlan);
  const design = ctx.design?.platforms.find((p) => p.platform === platform);
  const cx = appComplexity(plan, appName, { on: date });
  const edges = appEdges(plan, appName);
  const comps = appPlan?.variants[platform] ?? [];
  const crit = app?.criticality ?? 'tier2';
  const dr = DR_PATTERNS[plan.requirements.drPattern[crit]];
  const md = [
    `# Application design: ${appName}`, '', `Report date: ${date}`, '',
    '## Overview and non-functional requirements', '',
    ...table(['Item', 'Value'], [
      ['Owner', app?.owner ?? '—'], ['Criticality', crit], ['RPO / RTO', `${app?.rpo ?? '—'} / ${app?.rto ?? '—'}`], ['Residency', app?.residency ?? plan.requirements.defaultResidency],
      ['Users (concurrent)', `${app?.users ?? '—'} (${app?.concurrentUsers ?? '—'})`], ['Frameworks', (app?.frameworks ?? plan.requirements.frameworks).join(', ') || '—'],
      ['Pattern', app?.pattern ?? 'generic'], ['Complexity', `${cx.score} (${cx.band}); risk ${cx.risk}`],
    ]), '',
    '## Components', '',
    ...(comps.length ? table(['Component', 'Kind', 'Tier', 'Detail'], comps.map((c) => [c.name, c.kind, c.tier, c.kind === 'resource' ? c.type : c.kind === 'config' ? c.blueprintId : (c.tierPattern ?? 'default')])) : ['No components recorded; the servers and databases below are the app.']), '',
    `## Target: ${PLATFORM_INFO[platform].label}`, '',
    ...table(['Server', 'Size', 'vCPU', 'RAM GiB', 'Disks', 'Zone', 'Licence'], scope.workloads.map((w) => {
      const c = design?.compute.find((x) => x.workload === w.id);
      return [w.rename ?? w.name, c?.size ?? '—', c?.vcpu ?? w.vcpu, c?.ramGib ?? w.ramGib, (c?.disks ?? w.disksGib.map((g) => ({ gib: g, type: '' }))).map((x) => `${x.gib}${x.type ? ` ${x.type}` : ''}`).join(', '), c?.zone ?? '—', c?.licenceHandling ?? '—'];
    })), '',
    ...(scope.databases.length ? [...table(['Database', 'Engine', 'Service', 'Class / shape', 'Storage GiB', 'HA'], scope.databases.map((db) => {
      const t = design?.databases.find((x) => x.database === db.id);
      return [db.name, `${db.engine} ${db.version}`, t?.service ?? plan.decision?.items[db.id]?.chosen?.service ?? '—', t?.classOrShape ?? '—', t?.storageGib ?? db.sizeGib, t?.ha ?? db.ha];
    })), ''] : []),
    '## Comparison and reasons', '',
    ...scope.workloads.slice(0, 20).flatMap((w) => {
      const di = plan.decision?.items[w.id];
      if (!di) return [];
      return [`- ${w.name}: ${di.options.slice(0, 3).map((o) => `${PLATFORM_INFO[o.platform].label} ${o.score}${o.eliminated ? ` (out: ${o.eliminated})` : ''}`).join('; ')}. ${(di.chosen?.hits ?? []).slice(0, 3).map((h) => h.reason).join(' ')}`];
    }), '',
    '## Migration path and downtime', '',
    `Method: ${[...new Set([...scope.workloads, ...scope.databases].map((i) => plan.decision?.items[i.id]?.method ?? '—'))].join(', ')}. Expected downtime class: ${downtimeFromDecision(scope, plan.decision)}.`, '',
    '## Coupling and remediation', '',
    ...(edges.length ? table(['From', 'To app', 'Via', 'Kind'], edges.map((e) => [e.from, e.to, e.toItem, e.kind])) : ['No dependencies on other applications.']), '',
    ...scope.workloads.flatMap((w) => (w.facts?.readiness ?? []).filter((r) => r.severity !== 'note').map((r) => `- ${w.name}: ${r.id} (${r.severity})`)), '',
    '## Security rules', '',
    ...(edges.length ? edges.map((e) => `- Allow ${e.from} → ${e.toItem} (${e.kind}); ports from the accepted flows.`) : ['- Inbound per the ingress; no app-to-app rules.']), '',
    '## Monitoring', '', `- ${OPS_BY_PLATFORM[platform].logs}`, `- ${OPS_BY_PLATFORM[platform].dashboard}`, '',
    '## Backup and DR', '', `DR pattern: ${dr.label}. ${dr.perPlatform[platform]}`, '',
    '## Runbooks', '', `- runbooks/ops/${fileSlug(appName)}.md`, `- governance/signoffs/${fileSlug(appName)}.md`, '',
  ].join('\n');
  return render(`Application design — ${appName}`, md);
}

export function waveReport(ctx: ReportContext, n: number): RenderedReport {
  const wave = wavesOf(ctx).find((w) => w.n === n);
  const t = ctx.tracker;
  const items = wave?.items ?? [];
  const ids = new Set(items.map((i) => i.id));
  const events = (t?.events ?? []).filter((e) => e.wave === n || (e.item !== null && ids.has(e.item)));
  const md = [
    `# Wave ${n}${wave?.name ? `: ${wave.name}` : ''}`, '', `Report date: ${reportDate(ctx)}. Window: ${wave?.start?.slice(0, 10) ?? '—'} to ${wave?.end?.slice(0, 10) ?? '—'}.`, '',
    '## Items', '',
    ...table(['Item', 'Kind', 'Path', 'State', 'Flags', 'Rollbacks'], items.map((i) => {
      const s = t?.items[i.id];
      return [i.name, i.kind, s?.path ?? '—', s?.state ?? 'planned', s?.flags.join(' ') || '—', s?.rollbacks ?? 0];
    })), '',
    '## Gates', '',
    ...table(['Gate', 'Decision', 'Date', 'Role', 'Criteria met'], (t?.gates ?? []).filter((g) => g.wave === n).map((g) => [g.gate, g.decision, g.at.slice(0, 10), raciRoleLabel(g.role), `${g.criteria.filter((c) => c.met).length} of ${g.criteria.length}`])), '',
    '## Validation', '',
    ...table(['Item', 'Step', 'Outcome', 'At', 'Detail'], events.filter((e) => e.source === 'validation' || e.step === 'validate').map((e) => [e.name ?? e.item ?? '—', e.step, e.outcome, e.at, e.detail ?? ''])), '',
    '## Events', '',
    ...table(['At', 'Item', 'Step', 'Outcome', 'Dry run', 'Detail'], events.slice(-50).map((e) => [e.at, e.name ?? e.item ?? '—', e.step, e.outcome, e.dryRun ? 'yes' : 'no', e.detail ?? ''])), '',
    '## Issues', '',
    ...table(['ID', 'Issue', 'Severity', 'Status', 'Blocks'], (t?.raid.issues ?? []).filter((i) => i.wave === n).map((i) => [i.id, i.issue, i.severity, i.status, i.blocks.join(' ')])), '',
  ].join('\n');
  return render(`Wave ${n} report — ${ctx.plan.name}`, md);
}

/** The weekly status report (A.8.6). `periodDays` is the "this period" window, default 7. */
export function statusReport(ctx: ReportContext, periodDays = 7): string {
  const date = reportDate(ctx);
  const from = new Date(`${date}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - periodDays);
  const since = from.toISOString().slice(0, 10);
  const ahead = new Date(`${date}T00:00:00Z`);
  ahead.setUTCDate(ahead.getUTCDate() + 14);
  const until = ahead.toISOString().slice(0, 10);
  const t = ctx.tracker;
  const r = rag(ctx);
  const done = (t?.events ?? []).filter((e) => e.at.slice(0, 10) > since && e.at.slice(0, 10) <= date && e.outcome === 'succeeded' && ['cutover', 'validate', 'accept', 'decommission'].includes(e.step));
  const next = wavesOf(ctx).filter((w) => w.start && w.start.slice(0, 10) > date && w.start.slice(0, 10) <= until);
  const issues = (t?.raid.issues ?? []).filter((i) => (i.severity === 'sev1' || i.severity === 'sev2') && (i.status === 'open' || i.status === 'in-progress'));
  const blockers = (t?.raid.issues ?? []).filter((i) => i.blocks.length > 0 && i.status !== 'resolved' && i.status !== 'closed');
  const decisions = (t?.raid.decisions ?? []).filter((d) => d.date.slice(0, 10) > since && d.date.slice(0, 10) <= date);
  const k = kpis(ctx);
  const decomDue = wavesOf(ctx).flatMap((w) => w.items.filter((i) => atOrPast(t?.items[i.id], 'accepted') && !atOrPast(t?.items[i.id], 'decommissioned')).map((i) => [w.n, i.name]));
  return [
    `# Status report: ${ctx.plan.name}`, '', `Week ending ${date}.`, '',
    `**RAG: ${r.rag}.** ${r.reason}`, '',
    '## Progress by wave', '',
    ...table(['Wave', 'Items', 'Planned end', 'Cut over', 'Validated', 'Decommissioned', '%', 'Forecast end', 'On track'], waveProgress(ctx).map((w) => [w.wave, w.items, w.plannedEnd || '—', w.cutOver, w.validated, w.decommissioned, `${w.pct}%`, w.forecastEnd || '—', w.onTrack ? 'yes' : 'no'])), '',
    '## Done this period', '', ...(done.length ? done.map((e) => `- ${e.at.slice(0, 10)} ${e.name ?? e.item}: ${e.step}`) : ['- Nothing completed.']), '',
    '## Planned next period', '', ...(next.length ? next.map((w) => `- Wave ${w.n} from ${w.start!.slice(0, 10)}: ${w.apps.join(', ')}`) : ['- No wave starts in the next 14 days.']), '',
    '## Top five risks', '', ...table(['ID', 'Risk', 'Score', 'Owner', 'Status'], topRisks(t).map((x) => [x.id, x.risk, riskScore(x), x.owner ?? '—', x.status])), '',
    '## Open Sev 1 / Sev 2 issues', '', ...table(['ID', 'Issue', 'Severity', 'Owner', 'Opened'], issues.map((i) => [i.id, i.issue, i.severity, i.owner ?? '—', i.opened])), '',
    '## Blockers', '', ...table(['Issue', 'Blocks', 'Status'], blockers.map((i) => [i.id, i.blocks.join(' '), i.status])), '',
    '## Decisions this period', '', ...table(['ID', 'Decision', 'By', 'Date', 'Source'], decisions.map((d) => [d.id, d.decision, d.by ? raciRoleLabel(d.by) : '—', d.date.slice(0, 10), d.source])), '',
    '## Burn-down', '', ...table(['In scope', 'Cut over', 'Validated', 'Accepted', 'Decommissioned', 'Remaining'], [[k.inScope, k.cutOver, k.validated, k.accepted, k.decommissioned, k.inScope - k.cutOver]]), '',
    '## Decommission due', '', ...(decomDue.length ? table(['Wave', 'Item'], decomDue) : ['- Nothing waiting for decommission.']), '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Grids: capacity, DC exit, RAID
// ---------------------------------------------------------------------------

export interface Grid { readonly name: string; readonly columns: readonly string[]; readonly rows: readonly (readonly XlsxCellValue[])[] }

export function gridCsv(g: Grid): string {
  const f = (v: XlsxCellValue) => {
    const t = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return `${[g.columns.map(f).join(','), ...g.rows.map((r) => r.map(f).join(','))].join('\n')}\n`;
}
export const gridSheet = (g: Grid): XlsxSheet => ({ name: g.name, rows: [g.columns, ...g.rows] });

/** Any set of grids as one workbook, stamped with the plan's savedAt. */
export function gridsWorkbook(grids: readonly Grid[], plan: Pick<Plan, 'savedAt'>): Promise<Uint8Array> {
  return writeXlsx(grids.map(gridSheet), { when: plan.savedAt });
}

/** Estate capacity per platform (from the decision), and per app. */
export function capacityGrids(ctx: ReportContext): Grid[] {
  const { plan } = ctx;
  const per = new Map<string, { servers: number; vcpu: number; ram: number; storage: number; dbs: number; dbGib: number }>();
  const bump = (p: string) => per.get(p) ?? { servers: 0, vcpu: 0, ram: 0, storage: 0, dbs: 0, dbGib: 0 };
  for (const w of plan.workloads) {
    const p = plan.decision?.items[w.id]?.chosen?.platform ?? 'undecided';
    const x = bump(p);
    per.set(p, { ...x, servers: x.servers + 1, vcpu: x.vcpu + w.vcpu, ram: x.ram + w.ramGib, storage: x.storage + w.disksGib.reduce((a, b) => a + b, 0) });
  }
  for (const d of plan.databases) {
    const p = plan.decision?.items[d.id]?.chosen?.platform ?? 'undecided';
    const x = bump(p);
    per.set(p, { ...x, dbs: x.dbs + 1, dbGib: x.dbGib + d.sizeGib });
  }
  const label = (p: string) => (p in PLATFORM_INFO ? PLATFORM_INFO[p as Platform].label : p);
  return [
    { name: 'By platform', columns: ['Platform', 'Servers', 'vCPU', 'RAM GiB', 'Storage GiB', 'Databases', 'Database GiB'], rows: [...per.entries()].sort().map(([p, x]) => [label(p), x.servers, x.vcpu, x.ram, x.storage, x.dbs, x.dbGib]) },
    {
      name: 'By app', columns: ['App', 'Servers', 'vCPU', 'RAM GiB', 'Storage GiB', 'Databases', 'Complexity', 'Risk'],
      rows: [...plan.apps].sort((a, b) => a.name.localeCompare(b.name)).map((a) => {
        const s = appScope(plan, a.name);
        const c = appComplexity(plan, a.name, { on: reportDate(ctx) });
        return [a.name, s.workloads.length, s.workloads.reduce((t, w) => t + w.vcpu, 0), s.workloads.reduce((t, w) => t + w.ramGib, 0), s.workloads.reduce((t, w) => t + w.disksGib.reduce((x, y) => x + y, 0), 0), s.databases.length, c.score, c.risk];
      }),
    },
  ];
}

export async function capacityReport(ctx: ReportContext): Promise<{ markdown: string; csv: string; xlsx: Uint8Array }> {
  const grids = capacityGrids(ctx);
  const md = [`# Estate capacity: ${ctx.plan.name}`, '', `Report date: ${reportDate(ctx)}.`, '', ...grids.flatMap((g) => [`## ${g.name}`, '', ...table(g.columns, g.rows), ''])].join('\n');
  return { markdown: md, csv: gridCsv(grids[0]!), xlsx: await gridsWorkbook(grids, ctx.plan) };
}

export function dcExitGrids(plan: Pick<Plan, 'dcExit'>): Grid[] {
  const x = plan.dcExit;
  if (!x) return [];
  return [
    { name: 'Infrastructure', columns: ['ID', 'Category', 'Name', 'Vendor', 'Model', 'Site', 'Owner', 'Disposition', 'Target', 'After wave', 'Date'], rows: x.infra.map((i) => [i.id, i.category, i.name, i.vendor, i.model, i.site, i.owner, i.disposition, i.target, i.afterWave, i.date]) },
    { name: 'External links', columns: ['ID', 'Kind', 'Party', 'Direction', 'Protocol', 'Endpoint', 'Current IPs', 'App', 'Owner', 'Notice days'], rows: x.external.map((e) => [e.id, e.kind, e.party, e.direction, e.protocol, e.endpoint, e.currentIps.join(' '), e.app, e.owner, e.noticeDays]) },
    { name: 'Contracts', columns: ['ID', 'Kind', 'Vendor', 'Ends', 'Notice days'], rows: x.contracts.map((c) => [c.id, c.kind, c.vendor, c.ends, c.noticeDays]) },
    { name: 'Assets', columns: ['ID', 'Kind', 'Serial', 'Location', 'Contains data', 'Sanitisation', 'Certificate', 'Disposed on', 'Register updated'], rows: x.assets.map((a) => [a.id, a.kind, a.serial, a.location, a.containsData, a.sanitisation, a.certificateId, a.disposedOn, a.registerUpdated ?? false]) },
  ];
}

export async function dcExitReport(ctx: ReportContext): Promise<{ markdown: string; xlsx: Uint8Array }> {
  const grids = dcExitGrids(ctx.plan);
  const x = ctx.plan.dcExit;
  const seq = [...(x?.infra ?? [])].filter((i) => i.afterWave !== undefined).sort((a, b) => (a.afterWave ?? 0) - (b.afterWave ?? 0) || a.name.localeCompare(b.name));
  const md = [
    `# Data-centre exit: ${ctx.plan.name}`, '', `Report date: ${reportDate(ctx)}. Exit date: ${x?.exitDate ?? '—'}. Dual running: ${x?.dualRunningDays ?? 0} days; hardware removal: ${x?.hardwareRemovalDays ?? 0} days.`, '',
    '## Sequence', '', ...(seq.length ? table(['After wave', 'Item', 'Category', 'Disposition'], seq.map((i) => [i.afterWave, i.name, i.category, i.disposition ?? '—'])) : ['No exit steps placed after waves yet.']), '',
    '## Lights out', '', '- [ ] Every app wave accepted and decommissioned', '- [ ] Every infrastructure item migrated, replaced or retired', '- [ ] Every data-bearing asset sanitised, with a certificate id', '- [ ] Contracts terminated inside their notice periods', '- [ ] Sign-off lights-out (G5)', '',
    ...grids.flatMap((g) => [`## ${g.name}`, '', ...table(g.columns, g.rows), '']),
  ].join('\n');
  return { markdown: md, xlsx: await gridsWorkbook(grids, ctx.plan) };
}

/** The four RAID grids in the A.8.5 column order, as the #raid page exports them. */
export function raidGrids(tracker: Pick<Tracker, 'raid'>): Grid[] {
  const r = tracker.raid;
  return [
    { name: 'Risks', columns: ['ID', 'Risk', 'Wave', 'App', 'Probability', 'Impact', 'Score', 'Owner', 'Response', 'Mitigation', 'Status', 'Review by'], rows: r.risks.map((x) => [x.id, x.risk, x.wave, x.app, x.probability, x.impact, riskScore(x), x.owner, x.response, x.mitigation, x.status, x.reviewBy]) },
    { name: 'Assumptions', columns: ['ID', 'Assumption', 'Owner', 'Validate by', 'Status', 'Evidence'], rows: r.assumptions.map((x) => [x.id, x.assumption, x.owner, x.validateBy, x.status, x.evidence]) },
    { name: 'Issues', columns: ['ID', 'Issue', 'Severity', 'Wave', 'Blocks', 'Owner', 'Opened', 'Status', 'Resolution'], rows: r.issues.map((x) => [x.id, x.issue, x.severity, x.wave, x.blocks.join(' '), x.owner, x.opened, x.status, x.resolution]) },
    { name: 'Decisions', columns: ['ID', 'Decision', 'Rationale', 'Decided by', 'Date', 'Source', 'Links'], rows: r.decisions.map((x) => [x.id, x.decision, x.rationale, x.by ? raciRoleLabel(x.by) : '', x.date, x.source, x.links.join(' ')]) },
  ];
}
export function raidFiles(tracker: Pick<Tracker, 'raid'>): Record<string, string> {
  const [risks, assumptions, issues, decisions] = raidGrids(tracker) as [Grid, Grid, Grid, Grid];
  return { 'raid-risks.csv': gridCsv(risks), 'raid-assumptions.csv': gridCsv(assumptions), 'raid-issues.csv': gridCsv(issues), 'raid-decisions.csv': gridCsv(decisions) };
}

// ---------------------------------------------------------------------------
// The evidence pack
// ---------------------------------------------------------------------------

/** Which evidence in the pack supports each control area, per framework in the plan (A.10.19). */
function controlsMap(plan: Plan): string {
  const evidence: Readonly<Record<string, string>> = {
    'audit-logging': 'audit/audit.csv; tracker events',
    backup: 'validation/backup-verification.csv',
    'disaster-recovery': 'runbooks and DR patterns in the app design documents',
    guardrails: 'signoffs/, gates/, changes/',
    posture: 'decisions/ and the security rules in the app design documents',
  };
  const frameworks = [...new Set([...plan.requirements.frameworks, ...plan.apps.flatMap((a) => a.frameworks ?? [])])].sort();
  const lines = ['# Controls and evidence', '', frameworks.length ? `Frameworks in the plan: ${frameworks.join(', ')}.` : 'No frameworks selected in the plan.', ''];
  lines.push(...table(['Control', 'Area', 'Evidence in this pack'], CYBER_CONTROLS.map((c) => [c.title, c.area, evidence[c.area] ?? '—'])), '');
  return lines.join('\n');
}

/**
 * The evidence pack: decision records, gate files, sign-off sheets, CRs,
 * validation reports, backup-verification events, the utility log, the audit
 * trail, the asset register with sanitisation certificate ids — plus the RACI,
 * the licence ledger and the controls map. Zipped at the plan's savedAt.
 */
export async function evidencePack(ctx: ReportContext): Promise<{ bytes: Uint8Array; files: Record<string, string> }> {
  const { plan } = ctx;
  const t = ctx.tracker;
  const raci = raciOf(ctx);
  const waves = wavesOf(ctx);
  const waveOf: Record<string, number> = {};
  for (const w of waves) for (const a of w.apps) waveOf[a] ??= w.n;
  const files: Record<string, string> = {};
  const put = (path: string, text: string) => {
    files[path] = text;
  };
  if (t) {
    for (const [p, text] of Object.entries(raidFiles(t))) put(`decisions/${p}`, text);
    for (const g of t.gates) put(`gates/${g.wave === 'programme' ? 'programme' : `wave-${g.wave}`}-${g.gate}-${g.at.slice(0, 10)}.json`, `${JSON.stringify({ kind: 'archtoolkit.migration-gate', v: 1, planId: plan.id, ...g }, null, 2)}\n`);
    for (const [p, text] of Object.entries(signOffFiles(plan, raci, t, waveOf))) put(p.replace(/^governance\//, ''), text);
    const validation = t.events.filter((e) => e.source === 'validation' || e.step === 'validate');
    put('validation/validation-events.csv', rowsCsv(['at', 'wave', 'item', 'name', 'step', 'outcome', 'detail'], validation.map((e) => ({ at: e.at, wave: String(e.wave ?? ''), item: e.item ?? '', name: e.name ?? '', step: e.step, outcome: e.outcome, detail: e.detail ?? '' }))));
    put('validation/backup-verification.csv', rowsCsv(['item', 'decommissioned_at', 'backup_verified', 'cmdb_updated', 'hosts_freed'], t.decommissions.map((d) => ({ item: d.item, decommissioned_at: d.at, backup_verified: d.backupVerified ? 'yes' : 'no', cmdb_updated: d.cmdbUpdated ? 'yes' : 'no', hosts_freed: String(d.hostsFreed ?? '') }))));
    put('licences/licence-ledger.csv', ledgerCsv(reclaimLedger(plan, t)));
  }
  const crs = changeRequests(plan, waves, { on: reportDate(ctx), ...(plan.execution ? { execution: plan.execution } : {}), ...(ctx.changes ? { changeRecords: ctx.changes } : {}) });
  for (const [p, text] of Object.entries(changeRequestFiles(crs, { script: false }))) put(p.replace(/^governance\//, ''), text);
  put('changes/utility-log.csv', rowsCsv(['id', 'utility', 'target', 'summary', 'generated_at', 'applied_at', 'rolled_back_at', 'cr'], (ctx.changes ?? []).map((c) => ({ id: c.id, utility: c.utility, target: c.target, summary: c.summary, generated_at: c.generatedAt, applied_at: c.appliedAt ?? '', rolled_back_at: c.rolledBackAt ?? '', cr: c.cr ?? '' }))));
  put('audit/audit.csv', auditCsv(ctx.audit ?? []));
  const cmdb = cmdbFiles(plan, { ...(ctx.design ? { design: ctx.design } : {}), ...(t ? { tracker: t } : {}), script: false });
  put('assets/asset-register.csv', cmdb.files['governance/cmdb/asset-register.csv'] ?? '');
  put('governance/raci.md', raciMarkdown(raci));
  put('governance/raci.csv', raciCsv(raci));
  if (ctx.ratecard) put('governance/ratecard.csv', rateCardCsv(ctx.ratecard));
  put('controls.md', controlsMap(plan));
  const index = [
    `# Evidence pack: ${plan.name}`, '', `Plan saved ${plan.savedAt.slice(0, 10)}. Report date ${reportDate(ctx)}.`, '',
    ...Object.keys(files).sort().map((p) => `- ${p}`), '',
  ].join('\n');
  put('README.md', index);
  const stamp = new Date(plan.savedAt);
  const zoneFree = Number.isNaN(stamp.getTime()) ? new Date(1980, 0, 1) : new Date(stamp.getUTCFullYear(), stamp.getUTCMonth(), stamp.getUTCDate(), stamp.getUTCHours(), stamp.getUTCMinutes(), stamp.getUTCSeconds());
  return { bytes: await zip(files, zoneFree), files };
}
