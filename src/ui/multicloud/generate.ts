/**
 * Generate (`#generate`) on Multi-Cloud Migration & Utilities (addendum
 * A.5.3): the migration project, as one archive.
 *
 * Pick the parts — the plan, the landing zones, the app stacks per platform
 * and environment, per-app projects (`generateAppStack`), Ansible, the
 * execution kit, the waves, governance, reports, the pipeline and the
 * collectors — then Generate shows the file tree, a viewer and each part's
 * findings, and Download writes the zip (or tar.gz), dated from the plan so
 * the same plan gives the same bytes.
 *
 * The gluing is `assembleMigrationProject` (project.ts), the one function
 * WP-9's `generateProject` replaces.
 */

import { el, append, clear, downloadFile } from '../dom.ts';
import { card, findingsList } from '../components.ts';
import { renderBlueprintForm } from '../blueprint-form.ts';
import type { PaneContext } from '../plan-shell.ts';
import type { BlueprintInput, BlueprintValues, SelectOption } from '../../kit/blueprint.ts';
import {
  ARCHIVE_FORMAT_OPTIONS, CICD_OPTIONS, DEFAULT_GENERATE, ENV_OPTIONS, NONPROD_PCT_OPTIONS, STATE_BACKEND_OPTIONS, defaultGovernance,
} from '../../multicloud/plan/options.ts';
import type { ArchiveFormat, Cicd, Env, NonprodPct, StateBackend } from '../../multicloud/plan/types.ts';
import { migrationApps, planModel } from './plan-model.ts';
import { fill, note, rowsTable } from './pane-kit.ts';
import { PROJECT_PARTS, archiveProject, assembleMigrationProject, type MigrationProject, type ProjectPart } from './project.ts';
import { wavePlanFor } from './wave-model.ts';

const opts = (list: readonly { value: string; label: string }[]): SelectOption[] => list.map((o) => ({ value: o.value, label: o.label }));
const split = (v: unknown): string[] => String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean);

/** The parts ticked when the pane opens: all but the per-app projects, which need apps picked. */
export const DEFAULT_PARTS: readonly ProjectPart[] = PROJECT_PARTS.map((p) => p.id).filter((id) => id !== 'app-slices');

export function mount(root: HTMLElement, ctx: PaneContext): void {
  // What is picked here but not kept in the plan: the parts and the apps.
  let local: { parts: string; apps: string } = { parts: DEFAULT_PARTS.join(', '), apps: '' };
  let project: MigrationProject | null = null;
  let nonprodPct: NonprodPct = 25;

  const scope = el('div');
  const form = el('div');
  const result = el('div', { class: 'stack', attrs: { 'data-control': 'project-result' } });
  const status = el('span', { class: 'small muted', attrs: { role: 'status', 'data-control': 'generate-status' } });
  append(root, el('div', { class: 'stack' }, card('Migration project', el('p', { text: 'The files that run the migration: the landing zones, the application stacks, the execution kit and the governance around them. Pick the parts, generate, look through the files, then download one archive.' }), scope), form, result));

  const inputs = (): BlueprintInput[] => {
    const plan = ctx.session.plan();
    return [
      { id: 'parts', label: 'Parts', control: 'checklist', options: PROJECT_PARTS.map((p) => ({ value: p.id, label: `${p.label} (${p.folder})` })) },
      { id: 'apps', label: 'Per-app projects for', control: 'checklist', options: plan.apps.map((a) => ({ value: a.id, label: a.name })), hint: 'With the Per-app projects part' },
      { id: 'backend', label: 'Terraform state backend', control: 'select', options: opts(STATE_BACKEND_OPTIONS) },
      { id: 'archive', label: 'Archive', control: 'select', options: opts(ARCHIVE_FORMAT_OPTIONS) },
      { id: 'cicd', label: 'CI/CD pipeline', control: 'select', options: opts(CICD_OPTIONS).filter((o) => o.value !== 'none'), hint: 'With the Pipeline part' },
      { id: 'environments', label: 'App-stack environments', control: 'checklist', options: opts(ENV_OPTIONS).filter((o) => o.value !== 'dr') },
      { id: 'nonprodPct', label: 'Non-production size', control: 'select', options: opts(NONPROD_PCT_OPTIONS) },
    ];
  };
  const values = (): BlueprintValues => {
    const plan = ctx.session.plan();
    const gen = plan.generate ?? DEFAULT_GENERATE;
    const gov = plan.governance ?? defaultGovernance();
    return {
      parts: local.parts, apps: local.apps, backend: gen.backend, archive: gen.archive,
      cicd: gov.cicd === 'none' ? 'github-actions' : gov.cicd, environments: gov.environments.join(', '), nonprodPct: String(nonprodPct),
    };
  };
  const set = (id: string, v: string): void => {
    if (id === 'parts' || id === 'apps') {
      local = { ...local, [id]: v };
      return;
    }
    if (id === 'nonprodPct') {
      nonprodPct = Number(v) as NonprodPct;
      return;
    }
    ctx.session.update((p) => {
      const gen = p.generate ?? DEFAULT_GENERATE;
      const gov = p.governance ?? defaultGovernance();
      if (id === 'backend') return { ...p, generate: { ...gen, backend: v as StateBackend } };
      if (id === 'archive') return { ...p, generate: { ...gen, archive: v as ArchiveFormat } };
      if (id === 'cicd') return { ...p, governance: { ...gov, cicd: v as Cicd } };
      if (id === 'environments') return { ...p, governance: { ...gov, environments: split(v) as Env[] } };
      return p;
    });
  };

  const drawScope = (): void => {
    const plan = ctx.session.plan();
    const m = migrationApps(plan);
    fill(scope, note(
      plan.apps.length === 0
        ? 'The plan has no applications yet.'
        : m.planned
          ? `${m.ids.length} planned application${m.ids.length === 1 ? '' : 's'} of ${plan.apps.length}; the per-app projects can be generated for any of them.`
          : `No application plan is saved as planned yet, so every application (${plan.apps.length}) is taken as it stands.`,
      'generate-scope',
    ));
  };

  const drawForm = (): void => {
    const [parts, apps, ...rest] = renderBlueprintForm({ inputs: inputs() }, { values, set });
    const generate = el('button', { class: 'btn btn-primary', text: 'Generate', attrs: { type: 'button', 'data-control': 'generate-project' }, on: { click: () => run() } });
    fill(form, card('Parts', parts ?? null, apps ?? null, el('div', { class: 'two' }, ...rest), el('div', { class: 'btn-row', style: { marginTop: 'var(--space-4)' } }, generate, status)));
  };

  const run = (): void => {
    status.textContent = 'Generating…';
    // Let the status paint before the engines run.
    setTimeout(() => {
      try {
        const plan = ctx.session.plan();
        const model = planModel(plan);
        if (model.failure) throw new Error(model.failure);
        const waves = wavePlanFor(plan, model.decision);
        const gov = plan.governance ?? defaultGovernance();
        const partList = split(local.parts) as ProjectPart[];
        project = assembleMigrationProject(
          { plan, decision: model.decision, design: model.design, waves },
          {
            parts: partList,
            apps: split(local.apps),
            backend: (plan.generate ?? DEFAULT_GENERATE).backend,
            cicd: gov.cicd === 'none' ? 'github-actions' : gov.cicd,
            environments: gov.environments,
            nonprodPct,
          },
        );
        status.textContent = `${Object.keys(project.files).length} files.`;
        drawResult();
      } catch (e) {
        project = null;
        status.textContent = '';
        fill(result, card('Generate', el('div', { class: 'tip warn' }, el('strong', { text: 'The project could not be generated: ' }), el('span', { text: e instanceof Error ? e.message : String(e) }))));
      }
    }, 20);
  };

  const drawResult = (): void => {
    clear(result);
    if (!project) return;
    const p = project;
    const plan = ctx.session.plan();
    const format = (plan.generate ?? DEFAULT_GENERATE).archive;
    const errors = p.findings.filter((f) => f.severity === 'error').length;
    const download = el('button', {
      class: 'btn btn-primary',
      text: `Download ${p.root}.${format === 'tar.gz' ? 'tar.gz' : 'zip'}`,
      attrs: { type: 'button', 'data-control': 'download-project' },
      on: {
        click: () => {
          void archiveProject(plan, p.files, format).then((bytes) => downloadFile(`${p.root}.${format === 'tar.gz' ? 'tar.gz' : 'zip'}`, bytes, format === 'tar.gz' ? 'application/gzip' : 'application/zip'));
        },
      },
    });
    append(result, card(
      'Project',
      rowsTable(['Part', 'Files', 'Errors', 'Warnings'], p.parts.map((x) => [
        PROJECT_PARTS.find((y) => y.id === x.part)?.label ?? x.part,
        String(x.paths.length),
        String(x.findings.filter((f) => f.severity === 'error').length),
        String(x.findings.filter((f) => f.severity === 'warning').length),
      ]), { numeric: [1, 2, 3], control: 'project-parts' }),
      errors > 0 ? el('div', { class: 'tip warn' }, `${errors} error finding${errors === 1 ? '' : 's'}: the files are written, but read the findings before applying them.`) : null,
      el('div', { class: 'btn-row', style: { marginTop: 'var(--space-3)' } }, download),
    ));
    append(result, fileBrowser(p));
    append(result, card('Findings', ...p.parts.filter((x) => x.findings.length > 0).map((x) => el(
      'details',
      { attrs: { 'data-part': x.part }, style: { overflowWrap: 'anywhere', wordBreak: 'break-word' } },
      el('summary', { text: `${PROJECT_PARTS.find((y) => y.id === x.part)?.label ?? x.part} (${x.findings.length})` }),
      findingsList(x.findings),
    )), p.findings.length === 0 ? note('No issues found.') : null));
  };

  drawScope();
  drawForm();
  ctx.session.subscribe((_plan, kind) => {
    if (kind === 'reload' || kind === 'replace') {
      project = null;
      clear(result);
      drawScope();
      drawForm();
    }
  });
}

/** The file tree, one folder per part, with a viewer. */
function fileBrowser(project: MigrationProject): HTMLElement {
  const viewer = el('pre', { class: 'code', attrs: { 'data-control': 'file-viewer' }, style: { maxHeight: '28rem', overflow: 'auto', whiteSpace: 'pre', maxWidth: '100%' } });
  const title = el('div', { class: 'small muted', text: 'Pick a file to see it.' });
  const folders = new Map<string, string[]>();
  for (const path of Object.keys(project.files)) {
    const rel = path.slice(project.root.length + 1);
    const top = rel.includes('/') ? rel.split('/')[0] as string : '.';
    folders.set(top, [...(folders.get(top) ?? []), path]);
  }
  const tree = el('div', { attrs: { 'data-control': 'file-tree' } });
  for (const [folder, paths] of [...folders.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const list = el('ul', { style: { margin: '0', paddingLeft: 'var(--space-4)', listStyle: 'none' } });
    for (const path of paths) {
      const rel = path.slice(project.root.length + 1);
      append(list, el('li', {}, el('a', {
        text: rel,
        attrs: { href: '#generate', 'data-path': rel },
        style: { wordBreak: 'break-all' },
        on: {
          click: (e) => {
            e.preventDefault();
            title.textContent = rel;
            viewer.textContent = project.files[path] ?? '';
          },
        },
      })));
    }
    append(tree, el('details', {}, el('summary', { text: `${folder === '.' ? project.root : `${folder}/`} (${paths.length})` }), list));
  }
  return card('Files', tree, title, viewer);
}
