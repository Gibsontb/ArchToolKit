/**
 * Sources (`#sources`) on Application Migration (`migration.html`): bring in
 * servers, databases and applications from any source (addendum A.3.2).
 *
 * In order:
 * 1. Import the old portfolio (the retired Migration page's apps; first, A.1.5).
 * 2. The plan: its name, the merge mode every import uses, and the counts.
 * 3. The VMware estate: RVTools (or the PowerCLI collector) through the
 *    estate store, with scope, powered-off and the app / env / owner attributes.
 * 4. Provider and collector files: every intake adapter in
 *    `intake/sources` (collector JSON, Azure Migrate, Migration Center's four
 *    tables, the AWS import template, Prism, MGN, CMF, performance CSV, the
 *    Azure dependency export), each read by header, with its layout's
 *    verification shown.
 * 5. CSV and manual entry: the templates, a CSV of servers, databases or
 *    apps, or rows typed on Servers.
 * 6. The app grouping rules (A.2.1), and Regroup.
 * 7. Collectors: the bundle per source platform, and the coupling collectors.
 * 8. Coupling files, and 9. network flows: references and flows proposed as
 *    dependencies in a review grid; only the ticked ones are written.
 *
 * Every import is merged into the plan through `ctx.session.update`, so it is
 * saved and reaches Multi-Cloud Migration & Utilities; the result (what was
 * added and refreshed, and the import's findings) shows under it.
 */

import { el, append, clear, downloadFile } from '../dom.ts';
import { card, field, findingsList, select, stat, statGrid, verificationBadge } from '../components.ts';
import { tableEditor } from '../multi-editors.ts';
import { mountEstateBar } from '../estate-bar.ts';
import { portfolioImportCard } from '../legacy-portfolio.ts';
import type { PaneContext } from '../plan-shell.ts';
import { info, warning, type Finding } from '../../core/findings.ts';
import { zip } from '../../kit/archive.ts';
import { parseCsv } from '../../core/csv.ts';
import { loadInventory, type StoredEstate } from '../../kit/estate-store.ts';
import {
  APP_ATTRIBUTE_SOURCE_OPTIONS, ENV_ATTRIBUTE_SOURCE_OPTIONS, MERGE_MODE_OPTIONS, SOURCE_PLATFORM_OPTIONS, YES_NO_OPTIONS,
  labelOf,
} from '../../multicloud/plan/options.ts';
import type { GroupingRule, IntakeSettings, MergeMode, SourcePlatform } from '../../multicloud/plan/types.ts';
import { CSV_TEMPLATES, SERVERS_CSV_HEADER, intakeFromCsv } from '../../multicloud/plan/intake/csv.ts';
import { intakeStats, type IntakeResult } from '../../multicloud/plan/intake/adapter.ts';
import { attributeKeys, defaultAttributes, inventoryOptions, scopeChoices, workloadsFromInventory } from '../../multicloud/plan/intake/from-inventory.ts';
import { DEFAULT_GROUPING, validNameRegex } from '../../multicloud/plan/intake/grouping.ts';
import { validateScreen } from '../../multicloud/plan/intake/validate.ts';
import {
  BUNDLE_DATE, COLLECTORS, collectorBundle, collectorsFor, discoveryFlowsCsv, intakeFromAhvCsv, intakeFromAwsImport,
  intakeFromAzureMigrate, intakeFromDiscovery, intakeFromMigrationCenter, intakeFromTier2, parseAzureDependencyCsv,
  parseAzureMigrateCsv, parseDiscovery, parsePerfCsv, applyPerf, proposeEdges as proposeAzureEdges, type CollectorId,
} from '../../multicloud/plan/intake/sources/index.ts';
import { couplingBundle } from '../../multicloud/plan/coupling/collectors.ts';
import { importCoupling, resolveCoupling } from '../../multicloud/plan/coupling/import.ts';
import { couplingActions, couplingGrid, COUPLING_GRID_COLUMNS } from '../../multicloud/plan/coupling/rules.ts';
import {
  FLOW_HEADER_ALIASES, REQUIRED_FLOW_FIELDS, headerSetKey, importFlows, proposeEdges as proposeFlowEdges,
  type FlowField, type FlowMapping, type ProposedEdge,
} from '../../multicloud/plan/discovery/flows.ts';
import {
  BLANK_GROUPING_RULE, GROUPING_GRID, listFromGrid, listToGrid,
} from './grid-model.ts';
import { dropZone, pickFiles, whenShown } from './grid.ts';
import {
  REVIEW_CHOICES, REVIEW_GRID_COLUMNS, SOURCE_FORMATS, acceptReviewed, applyIntake, asReviewEdges, couplingReviewEdges,
  groupingRules, intakeSettings, jsonKind, migrationCenterFiles, nothingToReview, regroupPlan, reviewText, reviewedEdges,
  subjectsFromInventory, summaryText, type NamedText, type SourceFormatId,
} from './sources-model.ts';

const note = (text: string) => el('p', { class: 'small muted', text });

/** A result block: the summary line, the format's verification, and the findings. */
function resultBlock(slot: HTMLElement, lines: readonly string[], findings: readonly Finding[], badge?: HTMLElement): void {
  clear(slot);
  append(
    slot,
    el('div', { class: 'callout', attrs: { 'data-control': 'sources-result' } },
      ...lines.map((l, i) => el('p', { class: 'small', style: { margin: i === 0 ? '0' : 'var(--space-1) 0 0' } }, i === 0 && badge ? badge : null, i === 0 && badge ? ' ' : null, l))),
    findingsList(findings, 'The import raised nothing to check.'),
  );
}

export function mount(root: HTMLElement, ctx: PaneContext): void {
  const session = ctx.session;
  let estate: StoredEstate | null = null;

  const settings = (): IntakeSettings => intakeSettings(session.plan());
  const setSettings = (patch: Partial<IntakeSettings>) =>
    session.update((p) => ({ ...p, intake: { ...intakeSettings(p), ...patch } }));

  /** Merge an intake result into the plan and show what happened. */
  const merge = (slot: HTMLElement, result: IntakeResult, what: string, badge?: HTMLElement, extra: readonly Finding[] = []) => {
    const mode = settings().mergeMode;
    const r = applyIntake(session.plan(), result, mode);
    session.update(() => r.plan, { immediate: true });
    resultBlock(slot, [`${what}. ${summaryText(r.summary)}`], [...extra, ...r.findings], badge);
  };

  // ---- 1. the old portfolio (first) ----------------------------------------------
  append(root, card('Import the old portfolio',
    note('The applications the retired Migration page kept in this browser, or a portfolio file it exported. They are merged by name; an app already in the plan keeps what was typed into it.'),
    portfolioImportCard(session)));

  // ---- 2. the plan ----------------------------------------------------------------
  const nameInput = el('input', { attrs: { type: 'text', 'data-control': 'plan-name' } }) as HTMLInputElement;
  nameInput.value = session.plan().name;
  nameInput.addEventListener('input', () => {
    const name = nameInput.value;
    session.update((p) => ({ ...p, name }));
  });
  const modeSel = select(MERGE_MODE_OPTIONS, settings().mergeMode);
  modeSel.setAttribute('data-control', 'merge-mode');
  modeSel.addEventListener('change', () => setSettings({ mergeMode: modeSel.value as MergeMode }));
  const stats = el('div', { attrs: { 'data-control': 'sources-stats' } });
  const planChecks = el('div');
  append(root, card('The plan',
    el('div', { class: 'field-grid' },
      field('Plan name', nameInput),
      field('Importing again', modeSel, 'Add new rows, keep edited ones: rows are matched by name and every cell you edited is kept.')),
    stats,
    planChecks));

  // ---- 3. the VMware estate ---------------------------------------------------------
  const estateBarSlot = el('div');
  const estateControls = el('div', { class: 'stack' });
  const estateResult = el('div');
  append(root, card('VMware estate (RVTools)',
    note('RVTools as it is (.xlsx or its tabs as CSV), or the PowerCLI collector JSON. The estate is shared by every page; load it here or on VMware Inventory.'),
    estateBarSlot, estateControls, estateResult));

  const renderEstate = () => {
    clear(estateControls);
    if (!estate) {
      append(estateControls, note('No estate is loaded yet.'));
      return;
    }
    const inv = estate.inventory;
    const s = settings();
    const choices = scopeChoices(inv);
    const keys = attributeKeys(inv);
    const defaults = defaultAttributes(inv);
    const scopeSel = select([
      { value: '', label: 'The whole estate' },
      ...choices.clusters.map((c) => ({ value: c, label: `Cluster ${c}` })),
      ...choices.folders.map((f) => ({ value: f, label: `Folder ${f}` })),
    ], s.scope);
    scopeSel.setAttribute('data-control', 'estate-scope');
    const offSel = select(YES_NO_OPTIONS, s.includePoweredOff ? 'yes' : 'no');
    const keyOptions = keys.map((k) => ({ value: k, label: k }));
    const appSel = select([{ value: '', label: '(none)' }, ...keyOptions, ...APP_ATTRIBUTE_SOURCE_OPTIONS], s.appAttribute || defaults.appAttribute);
    const envSel = select([{ value: '', label: '(none: all prod)' }, ...keyOptions, ...ENV_ATTRIBUTE_SOURCE_OPTIONS], s.envAttribute || defaults.envAttribute);
    const ownerSel = select([{ value: '', label: '(none)' }, ...keyOptions], s.ownerAttribute || defaults.ownerAttribute);
    const save = () => setSettings({
      scope: scopeSel.value, includePoweredOff: offSel.value === 'yes',
      appAttribute: appSel.value, envAttribute: envSel.value, ownerAttribute: ownerSel.value,
    });
    for (const s2 of [scopeSel, offSel, appSel, envSel, ownerSel]) s2.addEventListener('change', save);
    const load = el('button', {
      class: 'btn btn-primary', text: 'Load from the estate', attrs: { type: 'button', 'data-control': 'estate-load' },
      on: {
        click: () => {
          save();
          const result = workloadsFromInventory(inv, { ...inventoryOptions(settings()) });
          merge(estateResult, result, `Read ${result.workloads.length} VM(s) from ${estate?.origin ?? 'the estate'}`);
        },
      },
    });
    append(estateControls,
      el('div', { class: 'field-grid' },
        field('Scope', scopeSel),
        field('Include powered-off VMs', offSel, 'No: powered-off VMs are left out as candidates to retire.'),
        field('App attribute', appSel, 'Which custom attribute (or the folder leaf, or the vApp) names the application.'),
        field('Environment attribute', envSel),
        field('Owner attribute', ownerSel)),
      el('div', { class: 'btn-row' }, load));
  };
  void mountEstateBar(estateBarSlot, {
    purpose: 'plan its VMs',
    onEstate: (e) => {
      estate = e;
      renderEstate();
    },
  });
  void loadInventory().then((e) => {
    estate = e;
    renderEstate();
  });

  // ---- 4. provider and collector files --------------------------------------------------
  const formatSel = select(SOURCE_FORMATS.map((f) => ({ value: f.id, label: f.title })), 'discovery');
  formatSel.setAttribute('data-control', 'source-format');
  const formatInfo = el('div', { class: 'stack' });
  const formatResult = el('div');
  const reviewSlot = el('div');
  const utilDays = select([
    { value: '0', label: 'Not stated (keep, do not size from it)' },
    ...[1, 7, 14, 30, 31, 90].map((d) => ({ value: String(d), label: `${d} day${d === 1 ? '' : 's'}` })),
  ], '0');
  utilDays.setAttribute('data-control', 'azure-util-days');
  const originSel = select([{ value: '', label: 'Not stated' }, ...SOURCE_PLATFORM_OPTIONS], '');
  originSel.setAttribute('data-control', 'tier2-origin');

  const renderFormat = () => {
    const f = SOURCE_FORMATS.find((x) => x.id === formatSel.value) ?? SOURCE_FORMATS[0]!;
    clear(formatInfo);
    append(formatInfo,
      el('p', { class: 'small' },
        f.verification ? verificationBadge(f.verification) : null, f.verification ? ' ' : null,
        f.what, ' ',
        f.source ? el('a', { text: 'Format reference', attrs: { href: f.source, target: '_blank', rel: 'noopener' } }) : null),
      f.note ? note(f.note) : null,
      f.id === 'azure-migrate' ? field('Window the utilisation figures cover', utilDays, 'Azure Migrate’s import file does not say; the sizing basis uses utilisation only over 3 days or more.') : null,
      f.id === 'mgn' || f.id === 'cmf' ? field('Where the servers run today', originSel, 'The sheet does not say; used for the Source column.') : null,
      el('div', { class: 'btn-row' },
        el('button', { class: 'btn btn-primary', text: f.multiple ? 'Choose files…' : 'Choose a file…', attrs: { type: 'button', 'data-control': 'source-import' }, on: { click: () => void importFormat(f.id) } })));
  };
  formatSel.addEventListener('change', renderFormat);

  const importFormat = async (id: SourceFormatId) => {
    const f = SOURCE_FORMATS.find((x) => x.id === id)!;
    const files = await pickFiles(f.accept, f.multiple);
    if (files.length === 0) return;
    runFormat(id, files);
  };

  /** One format's files through its adapter (exported to the page for tests through `importSourceFiles`). */
  const runFormat = (id: SourceFormatId, files: readonly NamedText[]) => {
    const f = SOURCE_FORMATS.find((x) => x.id === id)!;
    const badge = f.verification ? verificationBadge(f.verification) : undefined;
    const grouping = groupingRules(session.plan());
    const names = files.map((x) => x.name).join(', ');
    clear(reviewSlot);
    try {
      switch (id) {
        case 'discovery': {
          const json = files.filter((x) => jsonKind(x.text) === 'discovery');
          const other = files.filter((x) => jsonKind(x.text) !== 'discovery');
          const extra: Finding[] = other.map((x) => warning('sources.discovery.not-discovery', `${x.name} is not an archtoolkit.discovery file${jsonKind(x.text) === 'coupling' ? ' (it is a coupling file: import it under Coupling files)' : ''}.`));
          merge(formatResult, intakeFromDiscovery(json.map((x) => x.text), { grouping }), `Read ${json.length} collector file(s) (${names})`, badge, extra);
          const parses = json.map((x) => parseDiscovery(x.text));
          if (parses.some((p) => p.connections.length > 0)) {
            append(formatResult, el('div', { class: 'btn-row' }, el('button', {
              class: 'btn', text: 'Propose dependencies from their connections', attrs: { type: 'button', 'data-control': 'discovery-flows' },
              on: { click: () => runFlows(discoveryFlowsCsv(parses), 'The collector files’ connections') },
            })));
          }
          break;
        }
        case 'azure-migrate': {
          const days = Number(utilDays.value) || 0;
          const assessment = files.flatMap((x) => parseAzureMigrateCsv(x.text, { utilDays: days }).assessment);
          const extra = assessment.length > 0 ? [info('sources.azure-assessment', `${assessment.length} row(s) carry assessment columns (readiness, recommended size, cost); the layout is unpublished [U], so check them in Azure Migrate.`)] : [];
          merge(formatResult, intakeFromAzureMigrate(files.map((x) => x.text), { utilDays: days, grouping }), `Read ${names}`, badge, extra);
          break;
        }
        case 'migration-center': {
          const mc = migrationCenterFiles(files);
          if (!mc.files) {
            resultBlock(formatResult, [mc.problem ?? 'Not read.'], []);
            break;
          }
          merge(formatResult, intakeFromMigrationCenter(mc.files, { grouping }), `Read ${names}`, badge);
          break;
        }
        case 'aws-import':
          merge(formatResult, intakeFromAwsImport(files.map((x) => x.text), { grouping }), `Read ${names}`, badge);
          break;
        case 'ahv':
          merge(formatResult, intakeFromAhvCsv(files.map((x) => x.text), { grouping }), `Read ${names}`, badge);
          break;
        case 'mgn':
        case 'cmf': {
          const origin = (originSel.value || undefined) as SourcePlatform | undefined;
          merge(formatResult, intakeFromTier2(id, files.map((x) => x.text), { grouping, ...(origin ? { origin } : {}) }), `Read ${names}`, badge);
          break;
        }
        case 'perf': {
          let rows = [...session.plan().workloads];
          const findings: Finding[] = [];
          for (const x of files) {
            const r = applyPerf(rows, parsePerfCsv(x.text));
            rows = r.workloads;
            findings.push(...r.findings);
          }
          session.update((p) => ({ ...p, workloads: rows }), { immediate: true });
          resultBlock(formatResult, [`Read ${names} against the ${rows.length} server(s) in the plan.`], findings, badge);
          break;
        }
        case 'azure-dependency': {
          const deps = files.flatMap((x) => parseAzureDependencyCsv(x.text).dependencies);
          const parseFindings = files.flatMap((x) => parseAzureDependencyCsv(x.text).findings);
          const plan = session.plan();
          const p = proposeAzureEdges(deps, plan.workloads);
          const edges = asReviewEdges(p.edges.map((e) => ({ from: e.from, to: e.to, port: e.port, kind: e.kind, observations: e.observations, process: e.process })), plan.workloads, 'Seen by Azure Migrate dependency analysis.');
          resultBlock(formatResult, [`Read ${deps.length} dependency row(s) from ${names}.`], [...parseFindings, ...p.findings], badge);
          showReview(reviewSlot, 'Azure Migrate dependencies', edges);
          break;
        }
      }
    } catch (error) {
      resultBlock(formatResult, [`Not imported: ${(error as Error).message}`], []);
    }
  };

  append(root, dropZone(card('Provider and collector files',
    note('Every file is read by its column headers, never by position. Pick the format, then the files (or drop them on this card).'),
    field('Format', formatSel),
    formatInfo, formatResult, reviewSlot), (files) => runFormat(formatSel.value as SourceFormatId, files)));
  renderFormat();

  // ---- 5. CSV and manual entry --------------------------------------------------
  const csvKind = select([
    { value: 'workloads', label: 'Servers (workloads.csv / servers.csv)' },
    { value: 'databases', label: 'Databases (databases.csv)' },
    { value: 'apps', label: 'Applications (apps.csv)' },
  ], 'workloads');
  csvKind.setAttribute('data-control', 'csv-kind');
  const csvResult = el('div');
  const importCsvFiles = (files: readonly NamedText[]) => {
    const kind = csvKind.value as 'workloads' | 'databases' | 'apps';
    for (const x of files) merge(csvResult, intakeFromCsv({ kind, text: x.text, workloads: session.plan().workloads }), `Read ${x.name}`);
  };
  append(root, dropZone(card('CSV and manual entry',
    note('The toolkit’s own templates: one row per server, database or application; closed columns take the value or its label. servers.csv is workloads.csv with the source columns (origin, source_manager, host, bmc, workload_type, cpu_p95_pct … ports), for IBM Power, SPARC, HP-UX and mainframe servers, which have no collector.'),
    el('div', { class: 'field-grid' }, field('Which list', csvKind)),
    el('div', { class: 'btn-row' },
      el('button', {
        class: 'btn btn-primary', text: 'Import a CSV…', attrs: { type: 'button', 'data-control': 'csv-import' },
        on: {
          click: () => void pickFiles('.csv,text/csv', true).then(importCsvFiles),
        },
      }),
      el('button', {
        class: 'btn', text: 'Download the CSV templates', attrs: { type: 'button', 'data-control': 'csv-templates' },
        on: { click: () => void zip({ ...CSV_TEMPLATES, 'servers.csv': `${SERVERS_CSV_HEADER}\n` }, BUNDLE_DATE).then((bytes) => downloadFile('migration-csv-templates.zip', bytes, 'application/zip')) },
      }),
      el('button', { class: 'btn', text: 'Type servers in by hand →', attrs: { type: 'button' }, on: { click: () => ctx.go('servers') } }),
      el('button', { class: 'btn', text: 'Type databases in by hand →', attrs: { type: 'button' }, on: { click: () => ctx.go('databases') } })),
    csvResult), importCsvFiles));

  // ---- 6. app grouping rules ------------------------------------------------------
  const groupingSlot = el('div');
  const groupingResult = el('div');
  const renderGrouping = () => {
    clear(groupingSlot);
    const editor = tableEditor(
      { separator: ' | ', columns: GROUPING_GRID.map((c) => c.label), headerInValue: false, spaced: true, choices: GROUPING_GRID.map((c) => c.options) },
      listToGrid(groupingRules(session.plan()), GROUPING_GRID),
      () => {
        const hidden = editor.querySelector<HTMLTextAreaElement>('textarea.multi-value');
        const { rows, errors } = listFromGrid(hidden?.value ?? '', GROUPING_GRID, BLANK_GROUPING_RULE);
        const bad = rows.filter((r) => r.rule === 'name-regex' && r.key && !validNameRegex(r.key)).map((r) => `The pattern “${r.key}” does not compile or has no (?<app>…) group.`);
        grouping.busy = true;
        session.update((p) => ({ ...p, intake: { ...intakeSettings(p), grouping: rows as GroupingRule[] } }));
        grouping.busy = false;
        clear(groupingResult);
        if (errors.length + bad.length > 0) append(groupingResult, el('ul', { class: 'small' }, ...[...errors, ...bad].map((e) => el('li', { text: e }))));
      },
    );
    editor.setAttribute('data-control', 'grouping-editor');
    append(groupingSlot, editor);
  };
  const grouping = { busy: false };
  append(root, card('App grouping rules',
    note('Which application a server belongs to: the first rule that yields a name wins; a server no rule names goes to “Unassigned”. Keys: attribute or cloud-tag = a key (a|b = either); name-regex = a pattern with a named group app and an optional tier. An App cell you typed is never changed.'),
    groupingSlot,
    el('div', { class: 'btn-row' },
      el('button', {
        class: 'btn btn-primary', text: 'Regroup the servers now', attrs: { type: 'button', 'data-control': 'regroup' },
        on: {
          click: () => {
            const r = regroupPlan(session.plan(), subjectsFromInventory(estate?.inventory));
            session.update(() => r.plan, { immediate: true });
            resultBlock(groupingResult, [`${r.changed} server(s) moved to another application.`], r.findings);
          },
        },
      }),
      el('button', {
        class: 'btn', text: 'Back to the default rules', attrs: { type: 'button' },
        on: {
          click: () => {
            session.update((p) => ({ ...p, intake: { ...intakeSettings(p), grouping: [...DEFAULT_GROUPING] } }));
            renderGrouping();
          },
        },
      })),
    groupingResult));
  renderGrouping();

  // ---- 7. collectors ----------------------------------------------------------------
  const platformSel = select(SOURCE_PLATFORM_OPTIONS, 'hyperv');
  platformSel.setAttribute('data-control', 'collector-platform');
  const collectorInfo = el('div');
  const renderCollectors = () => {
    const platform = platformSel.value as SourcePlatform;
    const list = collectorsFor(platform);
    clear(collectorInfo);
    if (list.length === 0) {
      append(collectorInfo, el('p', { class: 'small', text: `${labelOf(SOURCE_PLATFORM_OPTIONS, platform)} has no collector: the honest intake is the customer’s own CMDB, HMC or LDom export, as servers.csv with the origin column set.` }));
      return;
    }
    append(collectorInfo,
      el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {}, ...['Script', 'Runs on', 'Needs', 'Credentials (environment, never written)'].map((h) => el('th', { text: h })))),
        el('tbody', {}, ...list.map((c) => el('tr', {},
          el('td', {}, el('a', { text: c.file, attrs: { href: c.source, target: '_blank', rel: 'noopener', title: 'The API or command reference it follows' } })),
          el('td', { text: c.runsOn }),
          el('td', { text: c.needs.join(', ') }),
          el('td', { text: c.credentials.length > 0 ? c.credentials.join(', ') : 'none' })))))),
      el('div', { class: 'btn-row', style: { marginTop: 'var(--space-2)' } },
        el('button', {
          class: 'btn btn-primary', text: `Download the ${labelOf(SOURCE_PLATFORM_OPTIONS, platform)} collectors`, attrs: { type: 'button', 'data-control': 'collector-download' },
          on: { click: () => void collectorBundle(list.map((c) => c.id as CollectorId)).then((b) => downloadFile(`collectors-${platform}.zip`, b, 'application/zip')) },
        })));
  };
  platformSel.addEventListener('change', renderCollectors);
  append(root, card('Collectors',
    note('For platforms with no standard export, and for what only the guest knows (software, services, listening ports, connections, utilisation). Every collector writes one archtoolkit.discovery file with no user name, host name or path in it; import the files above as “Collector files”.'),
    field('Source platform', platformSel),
    collectorInfo,
    el('div', { class: 'btn-row', style: { marginTop: 'var(--space-2)' } },
      el('button', {
        class: 'btn', text: `Download every collector (${COLLECTORS.length})`, attrs: { type: 'button', 'data-control': 'collector-download-all' },
        on: { click: () => void collectorBundle().then((b) => downloadFile('collectors.zip', b, 'application/zip')) },
      }),
      el('button', {
        class: 'btn', text: 'Download the coupling collectors', attrs: { type: 'button', 'data-control': 'coupling-download' },
        on: { click: () => void couplingBundle().then((b) => downloadFile('coupling-collectors.zip', b, 'application/zip')) },
      }))));
  renderCollectors();

  // ---- 8. coupling files -----------------------------------------------------------------
  const domainsInput = el('input', { attrs: { type: 'text', placeholder: 'corp.example.com', 'data-control': 'coupling-domains' } }) as HTMLInputElement;
  domainsInput.value = session.plan().requirements.identity.domain ?? '';
  const couplingResult = el('div');
  const couplingReview = el('div');
  const runCoupling = (files: readonly NamedText[]) => {
    const domains = domainsInput.value.split(/[\s,]+/).map((d) => d.trim()).filter(Boolean);
    const imported = importCoupling(files.map((x) => x.text), domains);
    const plan = session.plan();
    const resolved = resolveCoupling(imported.refs, { workloads: plan.workloads, sites: plan.requirements.sites });
    const acts = couplingActions(resolved, { workloads: plan.workloads, domains });
    const grid = couplingGrid(acts.actions);
    clear(couplingResult);
    resultBlock(couplingResult, [`${imported.refs.length} reference(s) from ${files.length} file(s); ${acts.actions.length} action(s). Secrets are masked again on import.`], [...imported.findings, ...acts.findings]);
    if (grid.length > 0) {
      append(couplingResult, el('div', { class: 'table-wrap', style: { marginTop: 'var(--space-2)' } }, el('table', {},
        el('thead', {}, el('tr', {}, ...COUPLING_GRID_COLUMNS.map((h) => el('th', { text: h })))),
        el('tbody', {}, ...grid.slice(0, 200).map((r) => el('tr', {}, ...r.map((c) => el('td', { class: 'small', text: c }))))))),
      grid.length > 200 ? note(`The first 200 of ${grid.length} actions; the application workspace’s Coupling tab lists them per app.`) : null);
    }
    showReview(couplingReview, 'References between servers', couplingReviewEdges(acts.edges, plan.workloads));
  };
  append(root, dropZone(card('Coupling files',
    note('The archtoolkit.coupling files the coupling collectors write: hosts entries, connection strings, shares, jobs, service accounts, certificates and licences that tie a server to others. References to other servers are proposed as dependencies below.'),
    field('DNS suffixes of the estate', domainsInput, 'Names in these are internal even when not in the plan. Space or comma separated.'),
    el('div', { class: 'btn-row' }, el('button', {
      class: 'btn btn-primary', text: 'Choose coupling files…', attrs: { type: 'button', 'data-control': 'coupling-import' },
      on: { click: () => void pickFiles('.json,application/json', true).then((f) => f.length > 0 && runCoupling(f)) },
    })),
    couplingResult, couplingReview), (files) => runCoupling(files)));

  // ---- 9. network flows ---------------------------------------------------------------------
  const flowsResult = el('div');
  const flowsReview = el('div');
  const runFlows = (text: string, what: string, mapping?: FlowMapping) => {
    const remembered = mapping ?? rememberedMapping(text);
    const imp = importFlows(text, remembered ? { mapping: remembered } : {});
    clear(flowsReview);
    if (imp.missing.length > 0) {
      resultBlock(flowsResult, [`${what}: choose the columns to use.`], imp.findings);
      append(flowsResult, mappingDialog(imp.headers, imp.missing, imp.mapping, (m) => {
        rememberMapping(imp.key, m);
        runFlows(text, what, m);
      }));
      return;
    }
    const plan = session.plan();
    const p = proposeFlowEdges(imp.flows, plan);
    resultBlock(flowsResult, [`${what}: ${imp.flows.length} flow(s) read, ${p.edges.length} proposed dependenc${p.edges.length === 1 ? 'y' : 'ies'}, ${p.external.length} external address(es).`], [...imp.findings, ...p.findings]);
    showReview(flowsReview, 'Dependencies from flows', [...p.edges]);
  };
  append(root, dropZone(card('Dependencies from network flows',
    note('flows.csv from VCF Operations for Networks (networks-flows.sh), any NetFlow / IPFIX collector’s CSV (nfdump, VPC flow logs, a SIEM export) or the guest capture. Columns are found by header; when one is missing you choose it, and the choice is remembered for files with the same headers.'),
    el('p', { class: 'small' }, verificationBadge('I'), ' The VCF Operations for Networks and nfdump column names are read by alias and still to be checked against your collector’s version [U].'),
    el('div', { class: 'btn-row' }, el('button', {
      class: 'btn btn-primary', text: 'Choose a flows file…', attrs: { type: 'button', 'data-control': 'flows-import' },
      on: { click: () => void pickFiles('.csv,.txt,text/csv', false).then((f) => f[0] && runFlows(f[0].text, f[0].name)) },
    })),
    flowsResult, flowsReview), (files) => files[0] && runFlows(files[0].text, files[0].name)));

  /** The review grid: From | To | Port | Proto | Observations | Process | Proposed kind | Accept. */
  function showReview(slot: HTMLElement, title: string, edges: ProposedEdge[]): void {
    clear(slot);
    if (edges.length === 0) {
      append(slot, findingsList([nothingToReview(title)]));
      return;
    }
    let current = edges;
    const editor = tableEditor(
      { separator: ' | ', columns: [...REVIEW_GRID_COLUMNS], headerInValue: false, spaced: true, choices: [...REVIEW_CHOICES] },
      reviewText(current),
      () => {
        const hidden = editor.querySelector<HTMLTextAreaElement>('textarea.multi-value');
        current = reviewedEdges(current, hidden?.value ?? '');
      },
    );
    editor.setAttribute('data-control', 'review-editor');
    const out = el('div');
    append(slot,
      el('h3', { text: `${title}: review`, style: { fontSize: '0.95rem', margin: 'var(--space-3) 0 var(--space-1)' } }),
      note('Nothing is written until you accept. Set Accept to Yes on the dependencies that are real (and the kind: synchronous moves together, asynchronous can be split across waves).'),
      el('div', { style: { maxWidth: '100%', overflowX: 'auto' } }, editor),
      el('div', { class: 'btn-row' },
        el('button', {
          class: 'btn', text: 'Tick every row', attrs: { type: 'button' },
          on: { click: () => { current = current.map((e) => ({ ...e, accept: true })); showReviewAgain(); } },
        }),
        el('button', {
          class: 'btn btn-primary', text: 'Accept the ticked dependencies', attrs: { type: 'button', 'data-control': 'review-accept' },
          on: {
            click: () => {
              const r = acceptReviewed(session.plan(), current);
              session.update(() => r.plan, { immediate: true });
              clear(out);
              append(out, el('p', { class: 'small', text: `${r.accepted} dependenc${r.accepted === 1 ? 'y' : 'ies'} written to the plan (edges and each server’s Depends on). Rows from sites or external addresses are for the security rules, not Depends on.` }));
            },
          },
        })),
      out);
    function showReviewAgain(): void {
      showReview(slot, title, current);
    }
  }

  // ---- stats and checks, kept current ------------------------------------------------
  const renderStats = () => {
    const plan = session.plan();
    const s = intakeStats(plan.workloads, plan.databases);
    clear(stats);
    append(stats, statGrid(
      stat({ label: 'Servers', value: s.workloads, sub: `${s.windows} Windows · ${s.linux} Linux · ${s.unknownOs} unknown OS` }),
      stat({ label: 'vCPU', value: s.vcpu }),
      stat({ label: 'RAM', value: `${s.ramGib} GiB` }),
      stat({ label: 'Storage', value: `${Math.round(s.storageGib)} GiB` }),
      stat({ label: 'Databases', value: plan.databases.length, sub: `${s.dbCandidates} suggested, to confirm` }),
      stat({ label: 'Applications', value: plan.apps.length }),
      stat({ label: 'Blocked', value: s.blocked, tone: s.blocked > 0 ? 'warn' : 'neutral' }),
      stat({ label: 'OS past support', value: s.eolOs, tone: s.eolOs > 0 ? 'warn' : 'neutral' }),
    ));
    clear(planChecks);
    append(planChecks, findingsList(validateScreen(plan, 'sources'), 'The plan has rows to work with.'));
    if (document.activeElement !== nameInput && nameInput.value !== plan.name) nameInput.value = plan.name;
    if (modeSel.value !== intakeSettings(plan).mergeMode) modeSel.value = intakeSettings(plan).mergeMode;
  };
  const refresh = whenShown(root, () => {
    renderStats();
  });
  renderStats();
  session.subscribe((_plan, kind) => {
    refresh();
    if (kind === 'reload' || kind === 'replace') {
      renderGrouping();
      renderEstate();
    } else if (!grouping.busy && kind === 'edit') {
      // Another pane may have changed the rules (not usual); the editor keeps its own text otherwise.
    }
  });
}

// ---------------------------------------------------------------------------
// The flows mapping dialog
// ---------------------------------------------------------------------------

const MAPPING_PREFIX = 'archtoolkit.flows-mapping.';

function rememberMapping(key: string, mapping: FlowMapping): void {
  try {
    globalThis.localStorage?.setItem(MAPPING_PREFIX + key, JSON.stringify(mapping));
  } catch {
    // A private window: the choice is simply not remembered.
  }
}

function rememberedMapping(text: string): FlowMapping | undefined {
  try {
    const k = headerSetKey(parseCsv(text).headers.map((h) => h.trim()));
    const raw = globalThis.localStorage?.getItem(MAPPING_PREFIX + k);
    return raw ? (JSON.parse(raw) as FlowMapping) : undefined;
  } catch {
    return undefined;
  }
}

const FIELD_LABELS: Readonly<Record<FlowField, string>> = {
  sourceIp: 'Source IP', destIp: 'Destination IP', destPort: 'Destination port', sourcePort: 'Source port', protocol: 'Protocol',
  observations: 'Observations', firstSeen: 'First seen', lastSeen: 'Last seen', bytes: 'Bytes', process: 'Process', destName: 'Destination name',
};

function mappingDialog(headers: readonly string[], missing: readonly FlowField[], mapping: FlowMapping, done: (m: FlowMapping) => void): HTMLElement {
  const fields = [...new Set<FlowField>([...REQUIRED_FLOW_FIELDS, ...missing, ...(Object.keys(FLOW_HEADER_ALIASES) as FlowField[])])];
  const selects = new Map<FlowField, HTMLSelectElement>();
  const grid = el('div', { class: 'field-grid' });
  for (const f of fields) {
    const s = select([{ value: '', label: '(not in the file)' }, ...headers.map((h) => ({ value: h, label: h }))], mapping[f] ?? '');
    s.setAttribute('data-control', `flows-map-${f}`);
    selects.set(f, s);
    append(grid, field(`${FIELD_LABELS[f]}${REQUIRED_FLOW_FIELDS.includes(f) ? ' (required)' : ''}`, s));
  }
  return el('div', { class: 'callout', attrs: { 'data-control': 'flows-mapping' } },
    el('p', { class: 'small', text: 'Which column holds each field:' }),
    grid,
    el('div', { class: 'btn-row' }, el('button', {
      class: 'btn btn-primary', text: 'Use these columns', attrs: { type: 'button', 'data-control': 'flows-map-apply' },
      on: {
        click: () => {
          const m: Partial<Record<FlowField, string>> = {};
          for (const [f, s] of selects) if (s.value) m[f] = s.value;
          done(m);
        },
      },
    })));
}
