/**
 * An application's Design (`#app:<slug>[/step-<n>]`) on Application Migration:
 * the Multi-Cloud Decision & Onboarding Wizard, for this application.
 *
 * The page is the original wizard's design: one cloud chosen in the header
 * ("Designing <app>, currently for Microsoft Azure", with the application
 * picker beside the cloud picker), the steps on the left, and on the right the
 * recommendation for THAT cloud, card by card, updating as you answer, with
 * Full view, Print and Save as Word.
 *
 * The initiative type in step 1 chooses the flow, and the steps and their
 * words follow the chosen provider's method (wording.ts):
 *   - Migrate an application: source & inventory → strategy → design (data,
 *     non-functionals, sizing) → foundation (landing zone, connectivity) →
 *     build (Terraform, Ansible) → replicate & test → cutover & rollback →
 *     hypercare & decommission;
 *   - Set up a new service: what it is and its load → design → foundation
 *     (reused or built) → build (with a pipeline) → deploy & smoke test →
 *     hand over;
 *   - Change a running service: the service or server and the change → apply
 *     it with rollback (the Utilities catalogue, on the same cloud) → record.
 *
 * The answers are prefilled from the plan (its servers, databases, OS,
 * criticality, RPO / RTO, source, data, environments, route, origin) and
 * stored on the plan (`AppPlan.design`: the cloud and the user's answers), so
 * they persist and sync like the rest of it. The cloud IS the app's chosen
 * platform, and the answers drive its components (wizard-map.ts), so what
 * the wizard recommends is what Generate builds. Everything the old tabs
 * showed is still here, inside the step it belongs to or an Advanced
 * disclosure: components and configuration, sizing, dependencies and
 * coupling, assessment, the target and the generator.
 */

import { el, append, downloadFile } from '../dom.ts';
import { renderBlueprintForm } from '../blueprint-form.ts';
import type { PaneContext } from '../plan-shell.ts';
import type { BlueprintInput } from '../../kit/blueprint.ts';
import { mountDecisionWizard, type DecisionWizardHandle } from '../decision-wizard.ts';
import { designResult, type DesignResult } from '../../multicloud/plan/apps/built.ts';
import { appDatabases, appWorkloads, setLoadProfile } from '../../multicloud/plan/apps/components.ts';
import { designAnswers, designCloud, setDesignAnswer, setDesignCloud } from '../../multicloud/plan/apps/design.ts';
import { recommendationChanged, saveAppPlans } from '../../multicloud/plan/apps/recommend.ts';
import { appSlice } from '../../multicloud/plan/apps/slice.ts';
import { findUtility, utilitiesFor } from '../../multicloud/change/index.ts';
import { providerTerm } from '../../multicloud/plan/methodology.ts';
import {
  APP_KIND_OPTIONS, APP_PATTERN_OPTIONS, APP_PLAN_STATUS_OPTIONS, CHANGE_WINDOW_OPTIONS, CRITICALITY_OPTIONS, EDGE_KIND_OPTIONS, FRAMEWORK_OPTIONS,
  LATENCY_OPTIONS, OS_OPTIONS, PLATFORM_LABELS, RESIDENCY_OPTIONS, RPO_OPTIONS, RTO_OPTIONS, SOURCE_PLATFORM_OPTIONS, SPECIAL_OPTIONS, labelOf, slugName,
} from '../../multicloud/plan/options.ts';
import { supportStatus } from '../../multicloud/plan/os.ts';
import { planEnvelope } from '../../multicloud/plan/store.ts';
import type { App, AppRecommendation, Plan, Platform } from '../../multicloud/plan/types.ts';
import { PROVIDER_FLOWS } from '../../multicloud/wizard/provider-flows.ts';
import { wizardCloudOf } from '../../multicloud/wizard/steps.ts';
import { flowKindOf, platformOfCloud } from '../../multicloud/wizard/wording.ts';
import {
  PLATFORM_NAME, appBySlug, appEdgeRows, appHash, appPlanOrDraft, appReadiness, parseAppArg, providerReadiness, recommendationOf, setAppField, setEdgeKind, shownPlatform,
} from './app-model.ts';
import { renderAssessment } from './assessment.ts';
import { networkEditor } from '../multicloud/network-rows.ts';
import { planModel, platformDesignFor } from '../multicloud/plan-model.ts';
import { hostsHint, platformRegions, tierForRole } from '../../multicloud/plan/design/index.ts';
import { renderComponents } from './components.ts';
import { renderConfiguration } from './configuration.ts';
import { renderCoupling } from './coupling.ts';
import {
  builtHtml, connectivityHtml, esc, gapsHtml, licensingHtml, pathsHtml, planBlock, providerFlowHtml, sizingPlanHtml,
} from './design-cards.ts';
import { button, buttonRow, chip, dropdown, factBadge, fill, judgedOn, note, rowsTable, sourceLink, watchPlan, type AppView } from './kit.ts';
import { loadProfileForm, newAppCard } from './new-app.ts';
import { renderSizingTab } from './sizing.ts';
import { generatorCard } from './stack.ts';
import { renderTarget } from './target.ts';

/** The old tab names, which still open: each lands on the step that now holds it. */
export const TAB_TO_STEP: Readonly<Record<string, number>> = {
  overview: 1, assessment: 2, target: 10, components: 3, configuration: 3, sizing: 5, dependencies: 6, coupling: 6, compare: 1, generate: 7,
};

/** The step a `#app:<slug>/<tab>` argument asks for, if any. */
export function stepOfTab(tab: string): number | undefined {
  const m = /^step-(\d+)$/.exec(tab);
  if (m) return Number(m[1]);
  return TAB_TO_STEP[tab];
}

// ---------------------------------------------------------------------------
// The application's non-functionals (the old Overview form, now in step 4)
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
];

function appValues(app: App): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of NF_INPUTS) {
    const v = (app as unknown as Record<string, unknown>)[i.id];
    if (v === undefined || v === null) continue;
    out[i.id] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  if (!out.kind) out.kind = 'unknown';
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

/** An Advanced disclosure: drawn when opened, and again on refresh while open. */
function advanced(title: string, render: () => HTMLElement, control: string): { node: HTMLElement; refresh: () => void } {
  const body = el('div');
  const node = el('details', { class: 'wizard-advanced', attrs: { 'data-control': control } }, el('summary', { text: `Advanced: ${title}` }), body);
  const draw = (): void => {
    if (!(node as HTMLDetailsElement).open) return;
    try {
      fill(body, render());
    } catch (e) {
      fill(body, el('div', { class: 'tip warn', text: `This could not be drawn: ${e instanceof Error ? e.message : String(e)}` }));
    }
  };
  node.addEventListener('toggle', draw);
  return { node, refresh: draw };
}

// ---------------------------------------------------------------------------
// The pane
// ---------------------------------------------------------------------------

export function mount(root: HTMLElement, ctx: PaneContext): void {
  const body = el('div', { attrs: { 'data-control': 'app-design' } });
  append(root, body);
  let handle: DecisionWizardHandle | null = null;
  const stepOf = new Map<string, number>();
  let refreshers: (() => void)[] = [];
  let last: DesignResult | undefined;
  let drawnFor = '';

  const refreshAll = (): void => {
    for (const r of refreshers) {
      try {
        r();
      } catch {
        // A block that cannot redraw keeps its last content.
      }
    }
  };

  /** A block of a step that redraws when the design changes. */
  const live = (render: () => HTMLElement | string): HTMLElement => {
    const box = el('div', { class: 'wizard-live' });
    const draw = (): void => {
      const out = render();
      if (typeof out === 'string') box.innerHTML = out;
      else fill(box, out);
    };
    draw();
    refreshers.push(draw);
    return box;
  };

  const startCard = (plan: Plan): HTMLElement => {
    const slot = el('div');
    const showNew = (): void => {
      fill(slot, newAppCard(() => ctx.session.plan(), (next, appId) => {
        const app = next.apps.find((a) => a.id === appId);
        watcher.edit(() => next, { immediate: true });
        if (app) {
          watcher.edit((p) => setDesignAnswer(p, app.id, 'initiativeType', 'new-service', designCloud(p, app.id, p.requirements.allowed[0] ?? 'aws')).plan, { immediate: true });
          ctx.go(appHash(app, 'step-1'));
        }
      }, () => fill(slot)));
    };
    return el('section', { class: 'card', attrs: { 'data-control': 'design-start' } },
      el('div', { class: 'card-title' }, el('h2', { text: 'Multi-Cloud Decision & Onboarding Wizard' })),
      el('p', { text: 'Design one application on the cloud you choose: the services card by card, the connectors, the playbook, and the Terraform, Ansible and pipeline for it.' }),
      el('div', { class: 'design-start-choices' },
        el('div', { class: 'card design-choice' },
          el('h3', { text: 'Set up a new service' }),
          el('p', { class: 'small', text: 'Nothing to move: pick what it is and its load, choose the cloud, design it, and generate its stack and pipeline. No inventory needed.' }),
          button('Set up a new service', showNew, { primary: true, control: 'design-start-new' })),
        el('div', { class: 'card design-choice' },
          el('h3', { text: 'Migrate an application' }),
          el('p', { class: 'small', text: 'Bring the servers in first (RVTools, a CSV, a cloud or hypervisor export): they are grouped into applications, and each gets its design here.' }),
          buttonRow(button('Bring servers in', () => ctx.go('sources'), { control: 'design-start-sources' }), button('All applications', () => ctx.go('applications')))),
        el('div', { class: 'card design-choice' },
          el('h3', { text: 'Change a running service' }),
          el('p', { class: 'small', text: 'Resize, add a disk, open a port, change DNS, patch: pick the application, choose "Change to existing service" in step 1, and the change goes to the Utilities catalogue.' }),
          plan.apps.length > 0 ? note('Pick the application below.') : note('Add or import the application first.'))),
      plan.apps.length > 0 ? el('ul', { attrs: { 'data-control': 'design-app-list' } }, ...plan.apps.map((a) => el('li', {}, el('a', { text: a.name, attrs: { href: `#${appHash(a)}` } })))) : null,
      slot);
  };

  const draw = (): void => {
    const { slug, tab } = parseAppArg(ctx.arg());
    const plan = ctx.session.plan();
    const app = appBySlug(plan, slug);
    refreshers = [];
    if (!app) {
      handle?.destroy();
      handle = null;
      drawnFor = '';
      fill(body,
        slug ? el('div', { class: 'tip warn', text: `There is no application called "${slug}".` }) : null,
        startCard(plan));
      return;
    }
    const ap = appPlanOrDraft(plan, app);
    const rec = recommendationOf(plan, app.id);
    const platform = designCloud(plan, app.id, shownPlatform(plan, app.id, rec));
    const da = designAnswers(plan, app.id);
    if (!da.answers.initiativeType) da.answers.initiativeType = ap.origin === 'new' ? 'new-service' : 'migration';
    const asked = stepOfTab(tab);
    const step = asked ?? stepOf.get(app.id) ?? 1;
    drawnFor = app.id;

    const view = (): AppView => {
      const p = ctx.session.plan();
      const a = p.apps.find((x) => x.id === app.id) ?? app;
      return {
        ctx, app: a, plan: p, appPlan: appPlanOrDraft(p, a), rec, platform,
        current: () => ctx.session.plan(),
        edit: (change, options) => { watcher.edit(change, options?.redraw ? { ...options, redraw: false } : options); if (options?.redraw) refreshAll(); },
        redraw: () => refreshAll(),
        go: (t) => { const n = stepOfTab(t); if (n) handle?.goTo(n); },
      };
    };
    const adv = (title: string, render: (v: AppView) => HTMLElement, control: string): HTMLElement => {
      const a = advanced(title, () => render(view()), control);
      refreshers.push(a.refresh);
      return a.node;
    };

    // ---- the header: the application picker, and the plan's buttons
    const picker = el('select', { attrs: { 'aria-label': 'Application', 'data-control': 'design-app-picker' } }) as HTMLSelectElement;
    for (const a of plan.apps) picker.appendChild(el('option', { text: a.name, attrs: { value: a.id } }));
    picker.appendChild(el('option', { text: '+ Set up a new service…', attrs: { value: '__new' } }));
    picker.value = app.id;
    picker.addEventListener('change', () => {
      if (picker.value === '__new') { ctx.go('app:'); return; }
      const next = plan.apps.find((a) => a.id === picker.value);
      if (next) ctx.go(appHash(next));
    });
    const message = el('span', { class: 'small', attrs: { role: 'status', 'data-control': 'design-message' } });
    const changed = ap.recommendation ? recommendationChanged(ap, rec) : false;
    const headerExtra = el('div', { class: 'wizard-app-controls' },
      el('label', { class: 'cloud-picker' }, el('span', { class: 'cloud-picker-label', text: 'Application:' }), picker),
      el('div', { class: 'btn-row wizard-app-buttons' },
        chip(ap.origin === 'new' ? 'New service' : 'Migrating', ap.origin === 'new' ? 'good' : 'neutral'),
        chip(labelOf(APP_PLAN_STATUS_OPTIONS, ap.status), ap.status === 'draft' ? 'neutral' : 'good'),
        rec.recommended && rec.recommended !== platform ? chip(`Engine prefers ${PLATFORM_NAME[rec.recommended]}`, 'warn', 'The decision engine\'s recommendation from the constraints; see step 1, Why this cloud.') : null,
        changed ? chip('Recommendation changed since saved', 'warn') : null,
        button('Save application plan', () => {
          watcher.edit((p) => saveAppPlans(p, [app.id], { [app.id]: rec }, new Date().toISOString()), { immediate: true });
          message.textContent = 'Saved: the plan is marked planned, and Migration & Utilities reads it from here.';
        }, { small: true, control: 'workspace-save' }),
        button('Export', () => {
          downloadFile(`${slugName(app.name) || 'app'}-app-plan.json`, JSON.stringify(planEnvelope(appSlice(ctx.session.plan(), [app.id])), null, 2));
          message.textContent = 'Exported the app slice (loadable on both pages).';
        }, { small: true, control: 'workspace-export' }),
        message));

    const cloudName = PLATFORM_LABELS[platform];

    // ---- what each step holds besides its questions
    const stepExtras: Record<number, () => HTMLElement | null> = {
      1: () => el('div', {},
        note(`The engine's recommendation from the constraints: ${rec.recommended ? `${PLATFORM_NAME[rec.recommended]}${rec.tooClose ? ' (too close to call)' : ''}` : 'no eligible cloud'}. The cloud in the header is the one this design is for; changing it re-does the recommendation for that cloud only.`),
        adv('why this cloud (the decision engine\'s scores)', () => recommendationTable(rec), 'design-why-cloud')),
      2: () => el('div', {},
        live(() => inventoryBlock(ctx.session.plan(), app, platform)),
        adv('assessment (readiness, coupling answers)', renderAssessment, 'design-assessment')),
      9: () => el('div', {},
        el('h3', { class: 'wizard-extra-title', text: 'Load profile' }),
        note('The new service is sized from this (planning assumptions; replace them with load-test numbers on Sizing).'),
        loadProfileForm(appPlanOrDraft(ctx.session.plan(), app).load, (load) => watcher.edit((p) => setLoadProfile(p, app.id, load).plan))),
      8: () => changeBlock(),
      10: () => el('div', {},
        live(() => last ? pathsHtml(last, 'migration') : ''),
        adv('target (the components on this cloud, ingress, what must exist first)', renderTarget, 'design-target')),
      3: () => el('div', {},
        adv('components (what the design builds, editable)', renderComponents, 'design-components'),
        adv('configuration (Ansible roles and modules)', renderConfiguration, 'design-configuration')),
      4: () => el('div', {}, adv('the application\'s non-functionals on the plan', () => nfForm(), 'design-nonfunctionals')),
      5: () => el('div', {},
        live(() => last ? sizingPlanHtml(last) : ''),
        adv('sizing grid, policy and overrides', renderSizingTab, 'design-sizing')),
      6: () => el('div', {},
        el('h3', { class: 'wizard-extra-title', text: `Networks and subnets on ${cloudName}` }),
        note('The same rows as Landing zones on Migration & Utilities: the landing zone this application builds (or attaches to). Nothing is filled in for you.'),
        networkRows(),
        live(() => last ? connectivityHtml(last) : ''),
        el('h3', { class: 'wizard-extra-title', text: 'Dependencies' }),
        live(() => dependenciesBlock()),
        adv('coupling (what the dependencies mean for the move)', renderCoupling, 'design-coupling')),
      7: () => el('div', {},
        live(() => el('p', {}, el('strong', { text: `How ${cloudName} takes it: ` }), last?.deploy ?? '', last ? el('br') : null, last ? el('span', { class: 'small', text: last.landingZone.text }) : null)),
        generatorCard(() => ctx.session.plan(), () => [app.id], `Generate ${app.name} on ${cloudName}`)),
      11: () => live(() => executionBlock('replicate')),
      12: () => live(() => executionBlock('cutover')),
      13: () => live(() => executionBlock('hypercare')),
      14: () => el('div', {},
        note(`Apply the stack through the pipeline chosen on Build (it runs terraform plan, then apply on approval) or, on ${cloudName}, as the cloud takes it: ${last?.deploy ?? ''}`),
        live(() => smokeBlock())),
      15: () => el('div', {},
        note('Hand the service to operations: its owner and support group, its monitoring (the app\'s alerts are in the stack), its runbook and its SLO.'),
        adv('ownership and non-functionals', () => nfForm(), 'design-handover')),
      16: () => changeApplyBlock(),
      17: () => el('div', {},
        note('Record the change: the Utilities page keeps the utility log (generated, applied, rolled back) with the change request number; the scripts\' status events import into it.'),
        buttonRow(el('a', { class: 'btn', text: 'Open the utility log →', attrs: { href: 'multicloud.html#utilities', 'data-control': 'design-utility-log' } }))),
    };

    /** The shared network row editor for the header's cloud (the landing zone this app builds or reuses). */
    const networkRows = (): HTMLElement => {
      const editor = networkEditor({
        platform,
        plan: () => ctx.session.plan(),
        edit: (fn) => {
          watcher.edit(fn, { immediate: true });
          editor.refresh();
        },
        design: () => {
          const cur = ctx.session.plan();
          const one = platformDesignFor(cur, platform);
          return { ...(one ? { design: one.design } : {}), findings: [...(one?.findings ?? []), ...planModel(cur).design.findings.filter((f) => (f.path ?? '').startsWith(`net:${platform}:`))] };
        },
        hint: () => hostsHint(ctx.session.plan(), planModel(ctx.session.plan()).decision, platform, tierForRole, new Set([app.name])),
        regions: () => {
          const pd = platformDesignFor(ctx.session.plan(), platform)?.design;
          return pd ? platformRegions(pd) : [];
        },
        control: `design-networks-${platform}`,
      });
      refreshers.push(editor.refresh);
      return editor.node;
    };

    const nfForm = (): HTMLElement => {
      const a = ctx.session.plan().apps.find((x) => x.id === app.id) ?? app;
      let values = appValues(a);
      const form = el('div', { class: 'two', attrs: { 'data-control': 'app-nonfunctionals' } });
      append(form, ...renderBlueprintForm({ inputs: NF_INPUTS }, {
        values: () => values,
        set: (id, v) => {
          values = { ...values, [id]: v };
          watcher.edit((p) => setAppField(p, app.id, id as Parameters<typeof setAppField>[2], v));
        },
      }));
      return form;
    }

    const dependenciesBlock = (): HTMLElement => {
      const rows = appEdgeRows(ctx.session.plan(), app.id);
      return rowsTable(['Direction', 'From', 'To', 'Kind'], rows.map((r) => [
        r.direction === 'out' ? 'Out' : 'In', r.from, r.to,
        dropdown(EDGE_KIND_OPTIONS, r.kind, (v) => { watcher.edit((p) => setEdgeKind(p, r.index, v as 'sync' | 'async')); handle?.regenerate(); }, { label: `Kind of ${r.from} → ${r.to}` }),
      ]), { control: 'app-dependencies', empty: 'No dependencies recorded for this application. Flows imported on Sources propose them.' });
    }

    const executionBlock = (stage: 'replicate' | 'cutover' | 'hypercare'): HTMLElement => {
      const f = PROVIDER_FLOWS[platform];
      const words = stage === 'replicate' ? providerTerm('test-run', platform) : stage === 'cutover' ? providerTerm('cutover', platform) : providerTerm('hypercare', platform);
      const link = stage === 'replicate' ? ['multicloud.html#execute', 'Open the execution kit →'] : stage === 'cutover' ? ['multicloud.html#board', 'Open the cutover board →'] : ['multicloud.html#board', 'Open the tracker →'];
      const box = el('div', { attrs: { 'data-control': `design-${stage}` } });
      box.innerHTML = [
        stage === 'replicate' ? `<p>Each server replicates with its path below; then the <strong>${esc(words)}</strong> runs on the target, the findings are fixed, and it is marked ready.</p>${last ? pathsHtml(last, 'migration') : ''}` : '',
        stage === 'cutover' ? `<p><strong>${esc(words)}.</strong> ${esc(f.cutover)}</p><p><strong>Gates:</strong> ${esc(f.gates)}</p><p>The way back: <strong>${esc(providerTerm('rollback', platform))}</strong>. DNS and load-balancer switching are generated per ${esc(f.waveLabel.toLowerCase())} on Migration &amp; Utilities.</p>` : '',
        stage === 'hypercare' ? `<p><strong>${esc(words)}</strong> after the move, then the hand-over to operations and the source retired (decommission: archive, backups and monitoring removed, licences reclaimed).</p>` : '',
        `<p class="muted">The execution itself runs from Migration &amp; Utilities, which reads this design: the app's cloud, its components and connectors, the landing-zone decision and each server's path.</p>`,
      ].join('');
      append(box, buttonRow(el('a', { class: 'btn', text: link[1]!, attrs: { href: link[0]! } }), el('a', { class: 'btn', text: `${f.waveLabel}s →`, attrs: { href: 'multicloud.html#waves' } })));
      return box;
    }

    const smokeBlock = (): HTMLElement => {
      const smoke = appPlanOrDraft(ctx.session.plan(), app).smoke ?? [];
      return el('div', {},
        smoke.length > 0
          ? rowsTable(['Check', 'Target', 'Expect'], smoke.map((s) => [s.kind, s.target, s.expect ?? '']))
          : note('No smoke checks yet: the ingress names get an HTTP check once the stack is up; add others on Migration & Utilities → Execute.'),
        buttonRow(el('a', { class: 'btn', text: 'Deploy a new service in Utilities →', attrs: { href: `multicloud.html#utilities:deploy-service/app=${encodeURIComponent(app.name)}&platform=${platform}` } })));
    }

    const changeBlock = (): HTMLElement => {
      const p = ctx.session.plan();
      const answers = designAnswers(p, app.id).answers;
      const servers = appWorkloads(p, app).filter((w) => !w.synthetic);
      const target = el('select', { attrs: { 'aria-label': 'Service or server', 'data-control': 'design-change-target' } }) as HTMLSelectElement;
      target.appendChild(el('option', { text: `The whole service (${app.name})`, attrs: { value: '' } }));
      for (const w of servers) target.appendChild(el('option', { text: `${w.name} (${labelOf(OS_OPTIONS, w.os)})`, attrs: { value: w.name } }));
      target.value = String(answers.changeTarget ?? '');
      const util = el('select', { attrs: { 'aria-label': 'Change', 'data-control': 'design-change-utility' } }) as HTMLSelectElement;
      for (const u of utilitiesFor(platform)) util.appendChild(el('option', { text: u.label, attrs: { value: u.id } }));
      if (answers.changeUtility) util.value = String(answers.changeUtility);
      const save = (id: string, v: string): void => watcher.edit((q) => setDesignAnswer(q, app.id, id, v, platform).plan);
      target.addEventListener('change', () => save('changeTarget', target.value));
      util.addEventListener('change', () => { save('changeUtility', util.value); describe(); });
      const about = el('p', { class: 'small' });
      const describe = (): void => {
        const u = findUtility(util.value);
        about.textContent = u ? `${u.description} Risk: ${u.risk}; ${u.reversible ? 'reversible (rollback.sh restores it)' : `compensating rollback: ${u.rollback}`}.` : '';
      };
      describe();
      return el('div', { class: 'field-grid' },
        el('div', { class: 'field' }, el('div', { class: 'field-head' }, el('label', { text: 'Service or server' })), target, el('div', { class: 'field-hint', text: 'The running service, or one of its servers.' })),
        el('div', { class: 'field' }, el('div', { class: 'field-head' }, el('label', { text: `The change (on ${cloudName})` })), util, el('div', { class: 'field-hint', text: 'From the Utilities catalogue: only the changes this cloud supports.' })),
        el('div', { style: { gridColumn: '1 / -1' } }, about));
    }

    const changeApplyBlock = (): HTMLElement => {
      const answers = designAnswers(ctx.session.plan(), app.id).answers;
      const u = findUtility(String(answers.changeUtility ?? '')) ?? utilitiesFor(platform)[0];
      const params = new URLSearchParams({ platform, app: app.name, ...(answers.changeTarget ? { server: String(answers.changeTarget), workload: String(answers.changeTarget) } : {}) });
      return el('div', { attrs: { 'data-control': 'design-change-apply' } },
        note(`The change goes into the stack that manages ${app.name} on ${cloudName}: Utilities generates a change bundle (Terraform and / or Ansible against the landing zone) with apply.sh, which applies by default (--dry-run previews), rollback.sh, and a status event. A change to a plan-managed target updates the plan, so the app's stack regenerates with it.`),
        u ? buttonRow(el('a', { class: 'btn btn-primary', text: `Open "${u.label}" in Utilities →`, attrs: { href: `multicloud.html#utilities:${u.id}/${params.toString()}`, 'data-control': 'design-open-utility' } })) : note(`No utility supports ${cloudName} yet.`));
    }

    // ---- the wizard
    handle = mountDecisionWizard(body, {
      cloud: wizardCloudOf(platform),
      answers: da.answers,
      prefilled: da.prefilled,
      subject: app.name,
      headerExtra,
      step,
      stepExtras,
      onChange: (id, value) => {
        watcher.edit((p) => {
          let q = setDesignAnswer(p, app.id, id, value as string | readonly string[], platform).plan;
          if (id === 'appPattern' && typeof value === 'string' && value && (APP_PATTERN_OPTIONS as readonly { value: string }[]).some((o) => o.value === value)) q = setAppField(q, app.id, 'pattern', value);
          return q;
        });
      },
      onCloud: (cloud) => {
        const p = platformOfCloud(cloud);
        watcher.edit((plan0) => setDesignCloud(plan0, app.id, p).plan, { immediate: true });
        // Everything on the page is for one cloud: draw it again for the new one (the step is kept).
        setTimeout(draw, 0);
      },
      onStep: (n) => {
        stepOf.set(app.id, n);
        try {
          globalThis.history?.replaceState(null, '', `#${appHash(app, `step-${n}`)}`);
        } catch {
          // A sandboxed page: the step is still remembered for this session.
        }
      },
      onRecommendation: (state, cloud, write) => {
        const p = platformOfCloud(cloud);
        const kind = flowKindOf(state.initiativeType);
        const r = designResult(ctx.session.plan(), app.id, p);
        last = r;
        write('computePlan', planBlock(r, 'compute'));
        write('dataPlan', planBlock(r, 'data'));
        write('integrationPlan', planBlock(r, 'integration'));
        write('opsPlan', planBlock(r, 'ops'));
        write('securityPlan', planBlock(r, 'security'));
        write('migrationPlan', providerFlowHtml(p, kind) + planBlock(r, 'migration'));
        write('pathsMain', pathsHtml(r, kind));
        write('connectivityMain', connectivityHtml(r));
        write('connectivityPlan', '');
        write('licensingMain', licensingHtml(r));
        write('sizingPlan', sizingPlanHtml(r));
        write('assumptionsPlan', gapsHtml(r));
        write('drPlan', ctx.session.plan().requirements.regions[p]?.dr ? `<p class="muted">DR region on ${esc(PLATFORM_LABELS[p])}: ${esc(ctx.session.plan().requirements.regions[p]?.dr)} (the DR stack is generated).</p>` : '');
        write('builtMain', builtHtml(r));
        const t = document.querySelector('[data-section-title="built"]');
        if (t) t.textContent = `What gets built on ${PLATFORM_LABELS[p]}`;
        refreshAll();
      },
    });
  };

  /** The servers and databases the app brings, with the facts the plan knows about them. */
  function inventoryBlock(plan: Plan, app: App, platform: Platform): HTMLElement {
    const ws = appWorkloads(plan, app).filter((w) => !w.synthetic);
    const dbs = appDatabases(plan, app);
    const on = judgedOn(plan);
    const r = appReadiness(plan, app.id, on);
    const pr = providerReadiness(platform, r);
    const eol = (os: string): string => {
      try {
        return supportStatus(os as Parameters<typeof supportStatus>[0], on);
      } catch {
        return '';
      }
    };
    return el('div', { attrs: { 'data-control': 'design-inventory' } },
      el('p', {}, el('strong', { text: `${pr.term}: ` }), pr.verdict, ` (${ws.length} server(s), ${dbs.length} database(s)).`),
      ws.length === 0 && dbs.length === 0 ? note('This application has no servers or databases in the plan yet: bring them in on Sources, or choose "New service" in step 1.') : null,
      ws.length > 0 ? rowsTable(['Server', 'Env', 'Role', 'OS', 'Support', 'vCPU · GiB', 'Disks (GiB)', 'Source'], ws.map((w) => [
        w.name, w.env, w.role, labelOf(OS_OPTIONS, w.os), eol(w.os) === 'end-of-life' ? chip('end of life', 'danger') : eol(w.os) === 'extended' ? chip('extended support', 'warn') : '',
        `${w.vcpu} · ${w.ramGib}`, w.disksGib.join(' + '), labelOf(SOURCE_PLATFORM_OPTIONS, w.origin ?? 'vsphere'),
      ]), { control: 'design-servers', numeric: [5] }) : null,
      dbs.length > 0 ? rowsTable(['Database', 'Engine', 'Version', 'Size (GiB)', 'HA', 'Hosts'], dbs.map((d) => [d.name, d.engine, d.version, String(d.sizeGib), d.ha, d.hosts.join(', ')]), { control: 'design-databases', numeric: [3] }) : null);
  }

  const watcher = watchPlan(root, ctx, () => {
    // Another page (or pane) changed the plan: redraw only when the app on show is affected enough to need it.
    const { slug } = parseAppArg(ctx.arg());
    const app = appBySlug(ctx.session.plan(), slug);
    if (!app || app.id !== drawnFor) draw();
    else refreshAll();
  });
  ctx.onArg(() => {
    const { slug } = parseAppArg(ctx.arg());
    const app = appBySlug(ctx.session.plan(), slug);
    if (app && app.id === drawnFor && handle) {
      const n = stepOfTab(parseAppArg(ctx.arg()).tab);
      if (n) handle.goTo(n);
      return;
    }
    draw();
  });
  draw();
}
