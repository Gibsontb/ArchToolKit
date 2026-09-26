/**
 * Communication templates (addendum A.10.3; AWS gate e-mails, research 1.8).
 *
 * `governance/comms/wave-<n>/` holds Markdown and plain text for each notice,
 * rendered from the plan: the app names, the window, the impact, the rollback
 * window, the contacts (RACI roles, never people) and the helpdesk text the
 * user typed. **Nothing is sent**; the operator sends them, and records the
 * notice as sent in the tracker (a manual event). G1 checks that the T−14 and
 * T−2 notices went out.
 *
 * The addendum's notices are joined by AWS's gate e-mails (T−28 commit, T−21
 * replication start, T−7 readiness, T−1 go / no-go), from the large-migration
 * governance playbook's communication gates.
 */

import { PLATFORM_INFO } from '../../platforms.ts';
import type {
  Criticality, ExecutionSettings, ExternalLink, GateCriterion, Governance, ItemId, Plan, Platform, RaciRow, Tracker, WaveKind, WavePlan,
} from '../types.ts';
import { downtimeFromDecision, appScope, type DowntimeClass } from './complexity.ts';
import { accountable, raciRoleLabel, rolesWith, raciRowFor } from './raci.ts';

export const COMMS_SOURCE = 'https://docs.aws.amazon.com/prescriptive-guidance/latest/large-migration-governance-playbook/task-follow-communication-gates.html';

// ---------------------------------------------------------------------------
// The waves, as the governance outputs see them
// ---------------------------------------------------------------------------

export interface WaveView {
  readonly n: number;
  readonly name?: string;
  readonly kind?: WaveKind;
  readonly start?: string;
  readonly end?: string;
  readonly apps: readonly string[];
  readonly items: readonly { readonly id: ItemId; readonly name: string; readonly kind: 'workload' | 'database' }[];
}

/**
 * The waves from the wave plan (WP-9 / WP-12). Without one, apps pinned to a
 * wave (`App.wave`) are grouped by it; unpinned apps are in no wave yet.
 */
export function waveViews(plan: Pick<Plan, 'apps' | 'workloads' | 'databases'>, wavePlan?: Pick<WavePlan, 'waves' | 'groups'>): WaveView[] {
  const items = new Map<string, { id: string; name: string; kind: 'workload' | 'database'; app: string }>();
  for (const w of plan.workloads) items.set(w.id, { id: w.id, name: w.name, kind: 'workload', app: w.app });
  for (const d of plan.databases) items.set(d.id, { id: d.id, name: d.name, kind: 'database', app: d.app });
  if (wavePlan && wavePlan.waves.length > 0) {
    const groups = new Map(wavePlan.groups.map((g) => [g.id, g]));
    return [...wavePlan.waves].sort((a, b) => a.n - b.n).map((w) => {
      const ids = w.groups.flatMap((g) => groups.get(g)?.items ?? []);
      const list = ids.map((id) => items.get(id)).filter((x): x is NonNullable<typeof x> => !!x);
      const apps = [...new Set([...list.map((i) => i.app), ...w.groups.flatMap((g) => groups.get(g)?.apps ?? [])])].filter(Boolean).sort();
      return {
        n: w.n, apps, items: list.map(({ id, name, kind }) => ({ id, name, kind })),
        ...(w.name ? { name: w.name } : {}), ...(w.kind ? { kind: w.kind } : {}), ...(w.start ? { start: w.start } : {}), ...(w.end ? { end: w.end } : {}),
      };
    });
  }
  const byWave = new Map<number, string[]>();
  for (const a of plan.apps) if (a.wave !== undefined) byWave.set(a.wave, [...(byWave.get(a.wave) ?? []), a.name]);
  return [...byWave.entries()].sort(([a], [b]) => a - b).map(([n, apps]) => ({
    n, apps: apps.sort(),
    items: [...items.values()].filter((i) => apps.includes(i.app)).map(({ id, name, kind }) => ({ id, name, kind })),
  }));
}

/** App name → wave number. */
export function waveOfApps(waves: readonly WaveView[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const w of waves) for (const a of w.apps) if (out[a] === undefined) out[a] = w.n;
  return out;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export type CommsTemplateId =
  | 't-28-commit' | 't-21-replication' | 't-14-announce' | 't-7-readiness' | 't-2-reminder' | 't-1-go-no-go'
  | 'freeze-start' | 'cutover-start' | 'cutover-complete' | 'rollback-notice' | 'hypercare-end' | 'decommission-notice'
  | 'partner-ip-change' | 'user-access-change' | 'dc-exit-milestone';

export interface CommsTemplate {
  readonly id: CommsTemplateId;
  readonly title: string;
  readonly when: string;
  /** Days relative to the wave start; undefined = on an event. */
  readonly offsetDays?: number;
  readonly audience: string;
  readonly source: 'addendum A.10.3' | 'AWS communication gates' | 'both';
}

export const COMMS_TEMPLATES: readonly CommsTemplate[] = Object.freeze([
  { id: 't-28-commit', title: 'Wave commitment (T−28)', when: '28 days before the wave', offsetDays: -28, audience: 'App owners, migration team', source: 'AWS communication gates' },
  { id: 't-21-replication', title: 'Replication starts (T−21)', when: '21 days before the wave', offsetDays: -21, audience: 'App owners, infrastructure', source: 'AWS communication gates' },
  { id: 't-14-announce', title: 'Migration announcement (T−14)', when: '14 days before the wave', offsetDays: -14, audience: 'Users, app owners, service desk', source: 'both' },
  { id: 't-7-readiness', title: 'Readiness confirmed (T−7)', when: '7 days before the wave', offsetDays: -7, audience: 'App owners, change management', source: 'AWS communication gates' },
  { id: 't-2-reminder', title: 'Reminder (T−2)', when: '2 days before the wave', offsetDays: -2, audience: 'Users, app owners, service desk', source: 'addendum A.10.3' },
  { id: 't-1-go-no-go', title: 'Go / no-go outcome (T−1)', when: '1 day before the wave, after the go / no-go', offsetDays: -1, audience: 'Everyone in the RACI', source: 'AWS communication gates' },
  { id: 'freeze-start', title: 'Change freeze starts', when: 'At the freeze', audience: 'App owners, change management', source: 'addendum A.10.3' },
  { id: 'cutover-start', title: 'Cutover starting (T−0)', when: 'At the cutover start', offsetDays: 0, audience: 'Users, app owners, service desk', source: 'both' },
  { id: 'cutover-complete', title: 'Cutover complete', when: 'At the cutover end', audience: 'Users, app owners, service desk', source: 'both' },
  { id: 'rollback-notice', title: 'Rollback', when: 'On a rollback', audience: 'Users, app owners, service desk', source: 'addendum A.10.3' },
  { id: 'hypercare-end', title: 'Hypercare complete', when: 'At the end of hypercare', audience: 'App owners, operations, service desk', source: 'both' },
  { id: 'decommission-notice', title: 'Source decommission', when: 'Before decommission', audience: 'App owners, infrastructure, security', source: 'addendum A.10.3' },
  { id: 'partner-ip-change', title: 'Partner notice: address change', when: 'Per external link, at T−notice-days', audience: 'The external party', source: 'addendum A.10.3' },
  { id: 'user-access-change', title: 'How you reach the application is changing', when: 'With the T−14 notice', offsetDays: -14, audience: 'Users', source: 'addendum A.10.3' },
  { id: 'dc-exit-milestone', title: 'Data-centre exit milestone', when: 'In dc-exit mode, at each exit milestone', audience: 'Steering, facilities, finance', source: 'addendum A.10.3' },
]);
const TEMPLATE = new Map(COMMS_TEMPLATES.map((t) => [t.id, t]));

export interface CommsContext {
  readonly plan: Plan;
  readonly wave: WaveView;
  readonly raci: readonly RaciRow[];
  readonly execution?: ExecutionSettings;
  readonly governance?: Governance;
}

const DOWNTIME_TEXT: Readonly<Record<DowntimeClass, string>> = {
  none: 'no planned outage (live migration)',
  minutes: 'a short outage, minutes, while the final sync and switch run',
  hours: 'an outage of hours while the service is rebuilt or restored',
};

const CRIT_ORDER: readonly Criticality[] = ['tier0', 'tier1', 'tier2', 'tier3'];

function waveCriticality(ctx: CommsContext): Criticality {
  const crit = ctx.wave.apps.map((a) => ctx.plan.apps.find((x) => x.name === a)?.criticality ?? 'tier2');
  return CRIT_ORDER.find((c) => crit.includes(c)) ?? 'tier2';
}

/** Dates as yyyy-mm-dd offset by days from an ISO date; '' when unknown. */
export function addDays(iso: string | undefined, days: number): string {
  if (!iso) return '';
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** When a notice is due for a wave; '' when the wave has no dates or the notice is on an event. */
export function noticeDue(id: CommsTemplateId, wave: Pick<WaveView, 'start' | 'end'>, ctx?: { readonly hypercareDays?: number; readonly keepDays?: number }): string {
  const t = TEMPLATE.get(id);
  if (!t) return '';
  if (t.offsetDays !== undefined) return addDays(wave.start, t.offsetDays);
  if (id === 'cutover-complete') return (wave.end ?? '').slice(0, 10);
  if (id === 'hypercare-end') return addDays(wave.end, ctx?.hypercareDays ?? 4);
  if (id === 'decommission-notice') return addDays(wave.end, Math.max(0, (ctx?.keepDays ?? 14) - 5));
  return '';
}

function contacts(ctx: CommsContext): string[] {
  const lines: string[] = [];
  for (const [id, what] of [['cutover', 'Cutover'], ['communications', 'Communications'], ['hypercare', 'Hypercare']] as const) {
    const row = raciRowFor(ctx.raci, id);
    const a = accountable(ctx.raci, id);
    const r = rolesWith(row, 'R');
    lines.push(`- ${what}: accountable ${a ? raciRoleLabel(a) : '—'}${r.length ? `; responsible ${r.map(raciRoleLabel).join(', ')}` : ''}`);
  }
  return lines;
}

function platformsOf(ctx: CommsContext): string {
  const set = new Set<Platform>();
  for (const i of ctx.wave.items) {
    const p = ctx.plan.decision?.items[i.id]?.chosen?.platform;
    if (p) set.add(p);
  }
  return [...set].map((p) => PLATFORM_INFO[p].label).join(', ') || 'the target platform';
}

function impactLines(ctx: CommsContext): string[] {
  return ctx.wave.apps.map((a) => `- ${a}: ${DOWNTIME_TEXT[downtimeFromDecision(appScope(ctx.plan, a), ctx.plan.decision)]}`);
}

export interface RenderedNotice { readonly id: CommsTemplateId | string; readonly subject: string; readonly markdown: string; readonly text: string }

/** Markdown → plain text for the .txt copy: headings, emphasis and table pipes removed. */
export function plainText(md: string): string {
  return md
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1'))
    .join('\n');
}

/** Render one wave notice. */
export function renderNotice(id: CommsTemplateId, ctx: CommsContext): RenderedNotice {
  const t = TEMPLATE.get(id)!;
  const w = ctx.wave;
  const apps = w.apps.join(', ') || '(no apps yet)';
  const window = w.start ? `${w.start.slice(0, 10)}${w.end ? ` to ${w.end.slice(0, 10)}` : ''}` : `Wave ${w.n} (dates to be confirmed)`;
  const crit = waveCriticality(ctx);
  const keep = ctx.execution?.keepDays[crit];
  const hyper = ctx.execution?.hypercareDays[crit];
  const helpdesk = ctx.governance?.comms.helpdesk?.trim() || '[helpdesk contact]';
  const sender = ctx.governance?.comms.sender?.trim() || 'The migration team';
  const subject = `${t.title}: wave ${w.n}${w.name ? ` (${w.name})` : ''} — ${apps}`;
  const body: string[] = [];
  const common = [
    `**Applications:** ${apps}`,
    `**Window:** ${window}`,
    `**Moving to:** ${platformsOf(ctx)}`,
  ];
  switch (id) {
    case 't-28-commit':
      body.push('The applications below are planned for this wave. Please confirm your commitment and send your test plan by T−14.', '', ...common, '',
        'Before T−21: raise the change requests and book the T−14, T−1 and T−0 meetings. The escalation plan is attached to the wave pack.');
      break;
    case 't-21-replication':
      body.push('Replication for this wave starts now. The source servers have been checked against the replication prerequisites.', '', ...common, '',
        'No action is needed from users. Application owners: tell us of any change planned on these servers before the cutover.');
      break;
    case 't-14-announce':
      body.push('These applications will move in the window below.', '', ...common, '', '**Expected impact:**', ...impactLines(ctx), '',
        `**If something goes wrong** the move can be reversed${keep ? ` for ${keep} days after the cutover` : ''}.`);
      break;
    case 't-7-readiness':
      body.push('Readiness for this wave is confirmed: the change requests are approved, the target is validated and the cutover task list is final.', '', ...common);
      break;
    case 't-2-reminder':
      body.push('A reminder: these applications move in two days.', '', ...common, '', '**Expected impact:**', ...impactLines(ctx));
      break;
    case 't-1-go-no-go':
      body.push('The go / no-go meeting for this wave has been held.', '', ...common, '', '**Decision:** [GO / NO-GO]', '',
        'On a no-go, the next steps and the new date follow in a separate notice.');
      break;
    case 'freeze-start':
      body.push('The change freeze for these applications starts now and lasts until the cutover is complete.', '', ...common, '',
        'Only emergency changes, approved by the change manager, until then.');
      break;
    case 'cutover-start':
      body.push('The cutover for this wave is starting.', '', ...common, '', '**Expected impact:**', ...impactLines(ctx));
      break;
    case 'cutover-complete':
      body.push('The cutover for this wave is complete and the applications are running on the new platform.', '', ...common, '',
        `Hypercare runs${hyper ? ` for ${hyper} days` : ''}: report anything unusual to the helpdesk and mention the wave number.`);
      break;
    case 'rollback-notice':
      body.push('The cutover has been rolled back. The applications are running from their original location again.', '', ...common, '',
        '**Reason:** [reason]', '', 'The items return to the wave backlog and will be re-planned into a later wave.');
      break;
    case 'hypercare-end':
      body.push('Hypercare for this wave is complete. Operations have taken over the applications, and the CMDB has been updated.', '', ...common, '',
        'Decommissioning of the source servers starts after the fallback retention period.');
      break;
    case 'decommission-notice':
      body.push(`The source servers for this wave will be decommissioned${keep ? ` ${keep} days after the cutover` : ''}. After that the move cannot be reversed.`, '', ...common, '',
        `**Servers:** ${w.items.filter((i) => i.kind === 'workload').map((i) => i.name).join(', ') || '—'}`, '',
        'Tell us now of any data or configuration still needed from the source.');
      break;
    case 'user-access-change':
      body.push('How you reach these applications is changing.', '', ...common, '',
        '**What changes:** [new URLs / VPN profile / client settings]', '**What you need to do:** [steps]');
      break;
    case 'dc-exit-milestone':
      body.push(`Data-centre exit milestone: wave ${w.n} is complete.`, '', ...common, '', `**Exit date:** ${ctx.plan.dcExit?.exitDate ?? '[exit date]'}`);
      break;
    case 'partner-ip-change':
      body.push('See the per-link notices.');
      break;
  }
  const md = [
    `# ${subject}`, '',
    ...body, '',
    '**Contacts (roles):**', ...contacts(ctx), '',
    `**Help:** ${helpdesk}`, '',
    sender, '',
  ].join('\n');
  return { id, subject, markdown: md, text: plainText(md) };
}

/** A partner notice for one external link: new egress addresses and the date. */
export function partnerNotice(link: ExternalLink, ctx: CommsContext, newIps: readonly string[] = []): RenderedNotice {
  const date = ctx.wave.start?.slice(0, 10) ?? '[date]';
  const sendBy = addDays(ctx.wave.start, -link.noticeDays) || `${link.noticeDays} days before ${date}`;
  const helpdesk = ctx.governance?.comms.helpdesk?.trim() || '[helpdesk contact]';
  const subject = `Address change for ${link.protocol} ${link.direction === 'in' ? 'to' : 'from'} us — ${link.party}`;
  const md = [
    `# ${subject}`, '',
    `**Send by:** ${sendBy}`, '',
    `On ${date} the ${link.app ?? 'service'} ${link.kind === 'inbound-api' ? 'API' : 'connection'} (${link.endpoint}) moves.`, '',
    `**Current addresses:** ${link.currentIps.join(', ') || '—'}`,
    `**New addresses:** ${newIps.length ? newIps.join(', ') : '[new egress addresses, IPv4 and IPv6]'}`, '',
    'Please add the new addresses to your allow list before that date and keep the current ones until we confirm the move.', '',
    `**Contact:** ${helpdesk}`, '',
    ctx.governance?.comms.sender?.trim() || 'The migration team', '',
  ].join('\n');
  return { id: `partner-ip-change-${link.id}`, subject, markdown: md, text: plainText(md) };
}

/** Every notice for a wave, path → text, under governance/comms/wave-<n>/. */
export function commsFiles(ctx: CommsContext): Record<string, string> {
  const files: Record<string, string> = {};
  const dir = `governance/comms/wave-${ctx.wave.n}`;
  for (const t of COMMS_TEMPLATES) {
    if (t.id === 'partner-ip-change') continue;
    if (t.id === 'dc-exit-milestone' && ctx.plan.mode !== 'dc-exit') continue;
    const n = renderNotice(t.id, ctx);
    files[`${dir}/${t.id}.md`] = n.markdown;
    files[`${dir}/${t.id}.txt`] = n.text;
  }
  for (const link of (ctx.plan.dcExit?.external ?? []).filter((l) => l.app && ctx.wave.apps.includes(l.app))) {
    const n = partnerNotice(link, ctx);
    files[`${dir}/${n.id}.md`] = n.markdown;
    files[`${dir}/${n.id}.txt`] = n.text;
  }
  const crit = waveCriticality(ctx);
  const schedule = COMMS_TEMPLATES.map((t) => `| ${t.id} | ${t.title} | ${t.when} | ${noticeDue(t.id, ctx.wave, { hypercareDays: ctx.execution?.hypercareDays[crit], keepDays: ctx.execution?.keepDays[crit] }) || '—'} | ${t.audience} |`);
  files[`${dir}/README.md`] = [
    `# Notices for wave ${ctx.wave.n}`, '',
    'Nothing here is sent automatically. Send each notice yourself and record it as sent in the tracker; G1 checks the T−14 and T−2 notices.', '',
    '| Template | Notice | When | Due | Audience |', '|---|---|---|---|---|', ...schedule, '',
    `Gate e-mails follow AWS's communication gates: ${COMMS_SOURCE}`, '',
  ].join('\n');
  return files;
}

/** G1's notice criteria: the T−14 and T−2 notices recorded as sent for the wave. */
export function noticeCriteria(tracker: Pick<Tracker, 'notices'>, wave: number): GateCriterion[] {
  return (['t-14-announce', 't-2-reminder'] as const).map((id) => {
    const sent = tracker.notices.find((n) => n.template === id && n.wave === wave);
    return { id: `notice.${id}`, auto: true, met: !!sent, detail: sent ? `${TEMPLATE.get(id)!.title} sent ${sent.sentAt.slice(0, 10)}.` : `${TEMPLATE.get(id)!.title} not recorded as sent.` };
  });
}
