/**
 * Stack & generate (`#stack`) and the workspace's Generate tab (addendum
 * A.2.5, A.10.11).
 *
 * One app or a stack of apps is the same code with a different selection:
 * `generateAppStack` builds the slice, places each app on its chosen cloud
 * (else its recommendation, so an app never straddles clouds), and writes one
 * root module per platform holding every selected app on it, the Ansible for
 * their servers, the README, `app-plan.json` and the decision record. The
 * CI/CD pipeline (and the state-store bootstrap) is added beside it. The
 * landing zone is shared (from the landing-zone project) or included.
 *
 * Before generating, the schemas of every resource and module component are
 * fetched, so a component added from the pickers is built into the stack. An
 * error finding blocks Download and names the app. The zip is dated from the
 * plan's savedAt: no footprint, the same plan gives the same bytes.
 *
 * `#stack` adds the selection grid (✓ | App | Platform | Status | Components |
 * Findings), its filters, Select planned, Save application plans and Export
 * selected (an app-slice envelope, loadable on both pages).
 */

import { el, append, downloadFile } from '../dom.ts';
import type { PaneContext } from '../plan-shell.ts';
import { findingsList } from '../components.ts';
import { appPlanOf } from '../../multicloud/plan/apps/components.ts';
import { plannedApps } from '../../multicloud/plan/apps/generate.ts';
import { saveAppPlans } from '../../multicloud/plan/apps/recommend.ts';
import { appSlice } from '../../multicloud/plan/apps/slice.ts';
import { variantFindings } from '../../multicloud/plan/apps/translate.ts';
import { APP_PATTERN_OPTIONS, APP_PLAN_STATUS_OPTIONS, ARCHIVE_FORMAT_OPTIONS, CICD_OPTIONS, LANDING_ZONE_MODE_OPTIONS, labelOf, slugName } from '../../multicloud/plan/options.ts';
import { planEnvelope } from '../../multicloud/plan/store.ts';
import type { AppRecommendation, ArchiveFormat, Cicd, LandingZoneMode, Plan, Platform } from '../../multicloud/plan/types.ts';
import { PLATFORM_CHOICES, PLATFORM_NAME, appHash, recommendationsOf, shownPlatform } from './app-model.ts';
import { buildStack, fileTree, loadComponentSchemas, stackArchive, type StackBuild } from './generate-model.ts';
import { button, buttonRow, chip, dropdown, fill, filterRow, labelled, note, rowsTable, saveBytes, watchPlan, type AppView } from './kit.ts';
import { moduleNamesOf } from './pickers.ts';

interface GenOptions { landingZone: LandingZoneMode | ''; cicd: Cicd; archive: ArchiveFormat; record: boolean }

/** The generator: options, Generate, the file tree and findings, and Download. `appIds` is read when Generate is pressed. */
export function generatorCard(plan: () => Plan, appIds: () => readonly string[], title: string): HTMLElement {
  const initial = plan();
  const opts: GenOptions = {
    landingZone: '',
    cicd: initial.governance?.cicd && initial.governance.cicd !== 'none' ? initial.governance.cicd : 'github-actions',
    archive: initial.generate?.archive ?? 'zip',
    record: true,
  };
  const out = el('div', { attrs: { 'data-control': 'stack-output' } });
  const status = el('p', { class: 'small', attrs: { role: 'status', 'data-control': 'stack-status' } });
  let last: StackBuild | undefined;

  const show = (build: StackBuild) => {
    const blocked = build.result.blocked;
    const tree = fileTree(build.files);
    const download = button(`Download ${opts.archive}`, () => {
      void stackArchive(plan(), build.files, opts.archive).then((bytes) => saveBytes(`${build.result.folder}.${opts.archive === 'zip' ? 'zip' : 'tar.gz'}`, bytes, opts.archive === 'zip' ? 'application/zip' : 'application/gzip'));
    }, { primary: true, control: 'stack-download', disabled: blocked.length > 0, title: blocked.length > 0 ? `Blocked by errors in: ${blocked.join(', ')}` : '' });
    fill(out,
      el('p', {},
        chip(`${Object.keys(build.files).length} files`),
        chip(`${tree.filter((t) => /\/terraform\/[a-z]+$/.test(t.folder)).length} Terraform root module(s)`),
        build.pipeline.length > 0 ? chip(`pipeline: ${build.pipeline.length} files`, 'good') : chip('no pipeline'),
        blocked.length > 0 ? chip(`Download blocked: ${blocked.join(', ')}`, 'danger') : chip('ready to download', 'good')),
      buttonRow(download),
      el('details', { attrs: { 'data-control': 'stack-tree' } }, el('summary', { text: 'Files' }),
        el('ul', { class: 'small' }, ...tree.map((t) => el('li', {}, el('code', { text: `${t.folder}/` }), ` ${t.files.join(', ')}`)))),
      findingsList(build.findings, 'No findings: everything generated cleanly.'));
  };

  const run = () => {
    const ids = appIds();
    if (ids.length === 0) {
      status.textContent = 'Select at least one application.';
      return;
    }
    status.textContent = 'Loading the schemas of the resource and module components…';
    fill(out);
    void loadComponentSchemas(plan(), ids, moduleNamesOf).then((loadFindings) => {
      status.textContent = 'Generating…';
      setTimeout(() => {
        try {
          const build = buildStack(plan(), ids, {
            ...(opts.landingZone ? { landingZone: opts.landingZone } : {}),
            cicd: opts.cicd,
            record: opts.record,
          });
          last = loadFindings.length > 0 ? { ...build, findings: [...loadFindings, ...build.findings], result: { ...build.result, blocked: [...new Set([...build.result.blocked, ...loadFindings.map((f) => f.message.split(':')[0]!)])] } } : build;
          status.textContent = `Generated ${ids.length} application(s) into ${build.result.folder}/.`;
          show(last);
        } catch (e) {
          status.textContent = `Generation failed: ${String(e instanceof Error ? e.message : e)}`;
        }
      }, 0);
    });
  };
  void last;

  return el('section', { class: 'card', attrs: { 'data-control': 'stack-generator' } },
    el('div', { class: 'card-title' }, el('h2', { text: title })),
    note('Terraform (one root module per cloud), Ansible, the README, the app plan and its decision record, and the CI/CD pipeline. Everything applies as generated; credentials are never written into the files.'),
    filterRow(
      labelled('Landing zone', dropdown(LANDING_ZONE_MODE_OPTIONS, opts.landingZone, (v) => { opts.landingZone = v as LandingZoneMode | ''; }, { blank: 'Shared where designed, else included', control: 'stack-landing-zone', label: 'Landing zone' })),
      labelled('CI/CD pipeline', dropdown(CICD_OPTIONS, opts.cicd, (v) => { opts.cicd = v as Cicd; }, { control: 'stack-cicd', label: 'CI/CD pipeline' })),
      labelled('Archive', dropdown(ARCHIVE_FORMAT_OPTIONS, opts.archive, (v) => { opts.archive = v as ArchiveFormat; }, { control: 'stack-archive', label: 'Archive' })),
      labelled('Decision record', dropdown([{ value: 'yes', label: 'Include' }, { value: 'no', label: 'Leave out' }], 'yes', (v) => { opts.record = v === 'yes'; }, { label: 'Decision record' }))),
    buttonRow(button('Generate', run, { primary: true, control: 'stack-generate' })),
    status, out);
}

/** The workspace's Generate tab: this app's stack. */
export function renderGenerateTab(view: AppView): HTMLElement {
  const findings = view.appPlan.variants[view.platform] ? variantFindings(view.appPlan, view.platform) : [];
  return el('div', {},
    findings.length > 0 ? el('section', { class: 'card' }, el('div', { class: 'card-title' }, el('h2', { text: 'Before generating' })), findingsList(findings)) : null,
    generatorCard(() => view.current(), () => [view.app.id], `Generate ${view.app.name} on ${PLATFORM_NAME[view.platform]}`));
}

// ---------------------------------------------------------------------------
// #stack
// ---------------------------------------------------------------------------

export function mount(root: HTMLElement, ctx: PaneContext): void {
  const selected = new Set<string>();
  let filter = { platform: '', status: '', pattern: '' };
  let recs: Record<string, AppRecommendation> = {};
  let recsFor: Plan | undefined;
  const listSlot = el('div');
  const message = el('p', { class: 'small', attrs: { role: 'status', 'data-control': 'stack-message' } });
  const gen = generatorCard(() => ctx.session.plan(), () => ctx.session.plan().apps.filter((a) => selected.has(a.id)).map((a) => a.id), 'Generate the stack');
  append(root, listSlot, gen);

  const draw = () => {
    const plan = ctx.session.plan();
    if (recsFor !== plan) {
      recs = recommendationsOf(plan);
      recsFor = plan;
    }
    for (const id of [...selected]) if (!plan.apps.some((a) => a.id === id)) selected.delete(id);
    const rows = plan.apps.map((a) => {
      const ap = appPlanOf(plan, a.id);
      const p: Platform = shownPlatform(plan, a.id, recs[a.id]);
      const errs = ap?.variants[p] ? variantFindings(ap, p).filter((f) => f.severity === 'error').length : 0;
      return { a, ap, p, status: ap?.status ?? 'draft', components: ap?.variants[p]?.length ?? 0, errs };
    }).filter((r) => (!filter.platform || r.p === filter.platform) && (!filter.status || r.status === filter.status) && (!filter.pattern || (r.a.pattern ?? 'generic') === filter.pattern));
    const table = rowsTable(['', 'App', 'Platform', 'Status', 'Components', 'Findings'], rows.map((r) => {
      const box = el('input', { attrs: { type: 'checkbox', 'aria-label': `Select ${r.a.name}`, 'data-control': 'stack-select' } }) as HTMLInputElement;
      box.checked = selected.has(r.a.id);
      box.addEventListener('change', () => { if (box.checked) selected.add(r.a.id); else selected.delete(r.a.id); counter.textContent = `${selected.size} selected`; });
      return [
        box,
        el('a', { text: r.a.name, attrs: { href: `#${appHash(r.a, 'generate')}` } }),
        el('span', {}, PLATFORM_NAME[r.p], r.ap?.platform ? null : chip('recommended')),
        chip(labelOf(APP_PLAN_STATUS_OPTIONS, r.status), r.status === 'draft' ? 'neutral' : 'good'),
        String(r.components),
        r.errs > 0 ? chip(`${r.errs} error(s)`, 'danger') : chip('none', 'good'),
      ];
    }), { control: 'stack-grid', numeric: [4], empty: plan.apps.length === 0 ? 'No applications yet.' : 'No application matches the filters.' });
    const counter = el('span', { class: 'small muted', text: `${selected.size} selected` });
    fill(listSlot, el('section', { class: 'card', attrs: { 'data-control': 'stack' } },
      el('div', { class: 'card-title' }, el('h2', { text: 'Stack & generate' })),
      note('Select the applications to generate together: apps on the same cloud share one root module, its state and the landing-zone contract.'),
      filterRow(
        labelled('Cloud', dropdown(PLATFORM_CHOICES, filter.platform, (v) => { filter = { ...filter, platform: v }; draw(); }, { blank: 'Any cloud', label: 'Cloud' })),
        labelled('Status', dropdown(APP_PLAN_STATUS_OPTIONS, filter.status, (v) => { filter = { ...filter, status: v }; draw(); }, { blank: 'Any status', label: 'Status' })),
        labelled('Pattern', dropdown(APP_PATTERN_OPTIONS, filter.pattern, (v) => { filter = { ...filter, pattern: v }; draw(); }, { blank: 'Any pattern', label: 'Pattern' }))),
      buttonRow(
        counter,
        button('Select all shown', () => { for (const r of rows) selected.add(r.a.id); draw(); }, { control: 'stack-select-all' }),
        button('Select planned', () => { selected.clear(); for (const id of plannedApps(ctx.session.plan())) selected.add(id); draw(); }, { control: 'stack-select-planned' }),
        button('Clear', () => { selected.clear(); draw(); }),
        button('Save application plans', () => {
          const ids = [...selected];
          if (ids.length === 0) { message.textContent = 'Select one or more applications first.'; return; }
          watcher.edit((p) => saveAppPlans(p, ids, recs, new Date().toISOString()), { immediate: true, redraw: true });
          message.textContent = `Saved ${ids.length} application plan(s).`;
        }, { control: 'stack-save' }),
        button('Export selected', () => {
          const ids = [...selected];
          if (ids.length === 0) { message.textContent = 'Select one or more applications first.'; return; }
          const plan0 = ctx.session.plan();
          downloadFile(`${slugName(plan0.name) || 'plan'}-apps.json`, JSON.stringify(planEnvelope(appSlice(plan0, ids)), null, 2));
          message.textContent = `Exported ${ids.length} application(s) as an app slice.`;
        }, { control: 'stack-export' })),
      message, table));
  };

  const watcher = watchPlan(root, ctx, draw);
  draw();
}
