/**
 * Application workspace (`#app:<slug>[/<tab>]`) on Application Migration
 * (addendum A.2.2): one application, and its target presence on the one cloud
 * chosen for it (else the engine's recommendation), switchable at any time.
 *
 * Tabs, in order: Overview · Components · Configuration · Dependencies ·
 * Coupling · Assessment · Target · Sizing · Compare · Generate. A new
 * application (greenfield) has no servers, so Dependencies, Coupling and
 * Assessment are hidden for it.
 *
 * Overview and Dependencies are drawn here; each other tab is its own module
 * (components.ts, configuration.ts, coupling.ts, assessment.ts, target.ts,
 * sizing.ts, compare.ts, stack.ts), handed an `AppView`.
 */

import { el, append, downloadFile } from '../dom.ts';
import { renderBlueprintForm } from '../blueprint-form.ts';
import type { PaneContext } from '../plan-shell.ts';
import type { BlueprintInput } from '../../kit/blueprint.ts';
import { setLoadProfile } from '../../multicloud/plan/apps/components.ts';
import { recommendationChanged, saveAppPlans } from '../../multicloud/plan/apps/recommend.ts';
import { appSlice } from '../../multicloud/plan/apps/slice.ts';
import {
  APP_KIND_OPTIONS, APP_PATTERN_OPTIONS, APP_PLAN_STATUS_OPTIONS, CHANGE_WINDOW_OPTIONS, CRITICALITY_OPTIONS, EDGE_KIND_OPTIONS, FRAMEWORK_OPTIONS,
  LATENCY_OPTIONS, RESIDENCY_OPTIONS, RPO_OPTIONS, RTO_OPTIONS, SPECIAL_OPTIONS, WORKLOAD_TYPE_OPTIONS, labelOf, slugName,
} from '../../multicloud/plan/options.ts';
import { planEnvelope } from '../../multicloud/plan/store.ts';
import type { App, AppRecommendation, Plan } from '../../multicloud/plan/types.ts';
import {
  PLATFORM_NAME, appBySlug, appEdgeRows, appHash, appPlanOrDraft, parseAppArg, recommendationOf, setAppField, setEdgeKind, shownPlatform,
} from './app-model.ts';
import { renderAssessment } from './assessment.ts';
import { renderCompare } from './compare.ts';
import { renderComponents } from './components.ts';
import { renderConfiguration } from './configuration.ts';
import { renderCoupling } from './coupling.ts';
import { button, buttonRow, chip, dropdown, factBadge, fill, note, rowsTable, sourceLink, watchPlan, type AppView } from './kit.ts';
import { loadProfileForm } from './new-app.ts';
import { renderSizingTab } from './sizing.ts';
import { renderGenerateTab } from './stack.ts';
import { renderTarget } from './target.ts';

export type WorkspaceTab = 'overview' | 'components' | 'configuration' | 'dependencies' | 'coupling' | 'assessment' | 'target' | 'sizing' | 'compare' | 'generate';

export const WORKSPACE_TABS: readonly { readonly id: WorkspaceTab; readonly label: string; readonly migratingOnly?: boolean }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'components', label: 'Components' },
  { id: 'configuration', label: 'Configuration' },
  { id: 'dependencies', label: 'Dependencies', migratingOnly: true },
  { id: 'coupling', label: 'Coupling', migratingOnly: true },
  { id: 'assessment', label: 'Assessment', migratingOnly: true },
  { id: 'target', label: 'Target' },
  { id: 'sizing', label: 'Sizing' },
  { id: 'compare', label: 'Compare' },
  { id: 'generate', label: 'Generate' },
];

/** The tabs an app shows: a new application has no Dependencies, Coupling or Assessment. */
export function tabsFor(origin: 'migrate' | 'new'): WorkspaceTab[] {
  return WORKSPACE_TABS.filter((t) => origin === 'migrate' || !t.migratingOnly).map((t) => t.id);
}

const TAB_RENDERERS: Readonly<Record<Exclude<WorkspaceTab, 'overview' | 'dependencies'>, (view: AppView) => HTMLElement>> = {
  components: renderComponents,
  configuration: renderConfiguration,
  coupling: renderCoupling,
  assessment: renderAssessment,
  target: renderTarget,
  sizing: renderSizingTab,
  compare: renderCompare,
  generate: renderGenerateTab,
};

export function mount(root: HTMLElement, ctx: PaneContext): void {
  const head = el('div');
  const strip = el('div', { class: 'tabs', attrs: { role: 'tablist', 'aria-label': 'Application workspace', 'data-control': 'workspace-tabs' }, style: { margin: 'var(--space-3) 0' } });
  const body = el('div', { attrs: { 'data-control': 'workspace-body' } });
  append(root, head, strip, body);

  const draw = () => {
    const { slug, tab } = parseAppArg(ctx.arg());
    const plan = ctx.session.plan();
    const app = appBySlug(plan, slug);
    if (!app) {
      fill(strip);
      fill(body);
      fill(head, el('section', { class: 'card' },
        el('div', { class: 'card-title' }, el('h2', { text: slug ? `No application called "${slug}"` : 'Choose an application' })),
        note('Open one from the catalogue.'),
        plan.apps.length > 0
          ? el('ul', {}, ...plan.apps.map((a) => el('li', {}, el('a', { text: a.name, attrs: { href: `#${appHash(a)}` } }))))
          : null,
        buttonRow(button('All applications', () => ctx.go('applications')))));
      return;
    }
    const ap = appPlanOrDraft(plan, app);
    const tabs = tabsFor(ap.origin);
    const current: WorkspaceTab = (tabs as string[]).includes(tab) ? (tab as WorkspaceTab) : 'overview';
    const rec = recommendationOf(plan, app.id);
    const platform = shownPlatform(plan, app.id, rec);
    const view: AppView = {
      ctx, app, plan, appPlan: ap, rec, platform,
      current: () => ctx.session.plan(),
      edit: (change, options) => watcher.edit(change, options),
      redraw: () => draw(),
      go: (t) => ctx.go(appHash(app, t)),
    };
    drawHead(view);
    fill(strip, ...tabs.map((t) => {
      const b = el('button', {
        class: t === current ? 'tab active' : 'tab',
        text: WORKSPACE_TABS.find((x) => x.id === t)!.label,
        attrs: { type: 'button', role: 'tab', 'aria-selected': t === current ? 'true' : 'false', 'data-tab': t },
      });
      b.addEventListener('click', () => ctx.go(appHash(app, t)));
      return b;
    }));
    let content: HTMLElement;
    try {
      content = current === 'overview' ? renderOverview(view) : current === 'dependencies' ? renderDependencies(view) : TAB_RENDERERS[current](view);
    } catch (e) {
      content = el('div', { class: 'tip warn' }, el('strong', { text: 'This tab could not be drawn. ' }), el('span', { text: String(e instanceof Error ? e.message : e) }));
    }
    fill(body, content);
  };

  function drawHead(view: AppView): void {
    const { app, appPlan: ap, rec, platform } = view;
    const chosen = ap.platform;
    const changed = ap.recommendation ? recommendationChanged(ap, rec) : false;
    const message = el('span', { class: 'small', attrs: { role: 'status' } });
    fill(head, el('section', { class: 'card', attrs: { 'data-control': 'workspace-head' } },
      el('div', { class: 'card-title' }, el('h2', { text: app.name })),
      el('div', { class: 'pill-row' },
        chip(ap.origin === 'new' ? 'New application' : 'Migrating', ap.origin === 'new' ? 'good' : 'neutral'),
        chip(labelOf(APP_PATTERN_OPTIONS, app.pattern ?? 'generic')),
        chip(labelOf(APP_KIND_OPTIONS, app.kind ?? 'unknown')),
        chip(labelOf(APP_PLAN_STATUS_OPTIONS, ap.status), ap.status === 'draft' ? 'neutral' : 'good'),
        chip(`${PLATFORM_NAME[platform]} (${chosen ? 'chosen' : rec.recommended ? 'recommended' : 'first allowed'})`, chosen ? 'good' : 'neutral'),
        rec.recommended && chosen && rec.recommended !== chosen ? chip(`Engine recommends ${PLATFORM_NAME[rec.recommended]}`, 'warn') : null,
        changed ? chip('Recommendation changed since saved', 'warn') : null),
      buttonRow(
        button('Save application plan', () => {
          view.edit((p) => saveAppPlans(p, [app.id], { [app.id]: rec }, new Date().toISOString()), { immediate: true, redraw: true });
        }, { primary: true, control: 'workspace-save' }),
        button('Export this application', () => {
          const slice = appSlice(view.current(), [app.id]);
          downloadFile(`${slugName(app.name) || 'app'}-app-plan.json`, JSON.stringify(planEnvelope(slice), null, 2));
          message.textContent = 'Exported the app slice (loadable on both pages).';
        }, { control: 'workspace-export' }),
        button('All applications', () => ctx.go('applications'), { control: 'workspace-back' }),
        message)));
  }

  const watcher = watchPlan(root, ctx, draw);
  ctx.onArg(() => draw());
  draw();
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

const NF_INPUTS: readonly BlueprintInput[] = [
  { id: 'criticality', label: 'Criticality', control: 'select', options: CRITICALITY_OPTIONS },
  { id: 'rpo', label: 'RPO', control: 'select', options: RPO_OPTIONS, blankLabel: '(the servers\')' },
  { id: 'rto', label: 'RTO', control: 'select', options: RTO_OPTIONS, blankLabel: '(the servers\')' },
  { id: 'residency', label: 'Residency', control: 'select', options: RESIDENCY_OPTIONS },
  { id: 'frameworks', label: 'Compliance frameworks', control: 'checklist', options: FRAMEWORK_OPTIONS },
  { id: 'latencyToOnPrem', label: 'Latency to on-premises', control: 'select', options: LATENCY_OPTIONS },
  { id: 'users', label: 'Users (named)', control: 'number', min: 0 },
  { id: 'concurrentUsers', label: 'Peak concurrent users', control: 'number', min: 0 },
  { id: 'deadlineMonths', label: 'Deadline', control: 'number', min: 0, hint: 'months' },
  { id: 'changeWindow', label: 'Change window', control: 'select', options: CHANGE_WINDOW_OPTIONS, blankLabel: '(not set)' },
  { id: 'special', label: 'Special requirement', control: 'select', options: SPECIAL_OPTIONS },
  { id: 'owner', label: 'Owner', control: 'text' },
  { id: 'businessOwner', label: 'Business owner', control: 'text' },
  { id: 'supportGroup', label: 'Support group', control: 'text' },
  { id: 'kind', label: 'Kind', control: 'select', options: APP_KIND_OPTIONS },
  { id: 'pattern', label: 'Pattern', control: 'select', options: APP_PATTERN_OPTIONS },
];

function appValues(app: App): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of NF_INPUTS) {
    const v = (app as unknown as Record<string, unknown>)[i.id];
    if (v === undefined || v === null) continue;
    out[i.id] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  if (!out.kind) out.kind = 'unknown';
  if (!out.pattern) out.pattern = 'generic';
  return out;
}

function recommendationTable(rec: AppRecommendation): HTMLElement {
  return rowsTable(['Cloud', 'Eligible', 'Score', 'Top reasons', 'Eliminated by'], rec.perPlatform.map((x) => [
    el('span', {}, PLATFORM_NAME[x.platform], rec.recommended === x.platform ? chip('recommended', 'good') : null),
    x.eligible ? 'yes' : chip('no', 'danger'),
    String(x.score),
    x.topHits.length === 0 ? '' : el('ul', { style: { margin: '0', paddingLeft: '1.1rem' } }, ...x.topHits.map((h) => el('li', { class: 'small' },
      el('code', { text: h.rule }), ` ${h.delta > 0 ? '+' : ''}${h.delta}: ${h.reason} `, factBadge(h.verification, h.source), ' ', sourceLink(h.source)))),
    x.eliminatedBy.join(', '),
  ]), { control: 'recommendation-table', numeric: [2], empty: 'No platform is allowed: set the platforms on Constraints.' });
}

function renderOverview(view: AppView): HTMLElement {
  const { app, appPlan: ap, rec, plan } = view;
  let values = appValues(app);
  const form = el('div', { class: 'two', attrs: { 'data-control': 'app-nonfunctionals' } });
  append(form, ...renderBlueprintForm({ inputs: NF_INPUTS }, {
    values: () => values,
    set: (id, v) => {
      values = { ...values, [id]: v };
      view.edit((p) => setAppField(p, app.id, id as Parameters<typeof setAppField>[2], v), { redraw: id === 'pattern' || id === 'kind' });
    },
  }));
  const detections = plan.workloads.filter((w) => w.app === app.name && !w.synthetic && (w.facts?.detection || w.workloadType));
  const top = rec.recommended ? rec.perPlatform.find((x) => x.platform === rec.recommended) : undefined;
  return el('div', {},
    el('section', { class: 'card', attrs: { 'data-control': 'app-recommendation' } },
      el('div', { class: 'card-title' }, el('h2', { text: 'Recommendation' })),
      rec.recommended
        ? el('p', {}, el('strong', { text: PLATFORM_NAME[rec.recommended] }), ` leads by ${rec.margin >= 99 ? 'being the only eligible cloud' : `${rec.margin} point(s)`}${top ? ` (score ${top.score})` : ''}. `,
          rec.tooClose ? chip('Too close to call: compare before choosing', 'warn') : null)
        : el('p', { text: 'No allowed cloud can take every item of this application; the table says which rules eliminate each.' }),
      note('Reasons are the rules that scored the app\'s items, summed. [U] marks an inferred fact and [C] a community source; both are shown, never presented as published.'),
      recommendationTable(rec),
      buttonRow(button('Compare side by side', () => view.go('compare'), { control: 'overview-compare' }), button('Choose the cloud on Target', () => view.go('target')))),
    ap.origin === 'new'
      ? el('section', { class: 'card' },
        el('div', { class: 'card-title' }, el('h2', { text: 'Load profile' })),
        note('The components are sized from this (planning assumptions: replace them with your load-test numbers on Sizing → Assumptions).'),
        loadProfileForm(ap.load, (load) => view.edit((p) => setLoadProfile(p, app.id, load).plan)))
      : null,
    el('section', { class: 'card' },
      el('div', { class: 'card-title' }, el('h2', { text: 'Non-functionals' })),
      form,
      detections.length > 0
        ? el('div', {}, el('h3', { text: 'Detection evidence', style: { fontSize: '1rem', margin: 'var(--space-3) 0 var(--space-2)' } }),
          rowsTable(['Server', 'Type', 'Confidence', 'Evidence'], detections.map((w) => [
            w.name,
            labelOf(WORKLOAD_TYPE_OPTIONS, w.workloadType ?? w.facts?.detection?.type ?? 'unknown'),
            w.facts?.detection ? `${Math.round(w.facts.detection.confidence * 100)}%${w.typeConfirmed ? ' (confirmed)' : ''}` : 'set by hand',
            (w.facts?.detection?.evidence ?? []).join('; '),
          ])))
        : null));
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

function renderDependencies(view: AppView): HTMLElement {
  const rows = appEdgeRows(view.plan, view.app.id);
  return el('section', { class: 'card', attrs: { 'data-control': 'app-dependencies' } },
    el('div', { class: 'card-title' }, el('h2', { text: 'Dependencies' })),
    note('The app\'s edges in and out. Synchronous edges keep apps together (and are flagged when they cross clouds); asynchronous ones tolerate the distance.'),
    rowsTable(['Direction', 'From', 'To', 'Kind'], rows.map((r) => [
      r.direction === 'out' ? 'Out' : 'In', r.from, r.to,
      dropdown(EDGE_KIND_OPTIONS, r.kind, (v) => view.edit((p) => setEdgeKind(p, r.index, v as 'sync' | 'async')), { label: `Kind of ${r.from} → ${r.to}` }),
    ]), { empty: 'No dependencies recorded for this application. Flows imported on Sources propose them.' }));
}
