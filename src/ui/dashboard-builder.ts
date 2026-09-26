/**
 * The VCF Operations dashboard builder.
 *
 * The dashboard blueprint reads its widgets as rows of text — Type | Title |
 * Settings | Position | Provider | Receives from — which is exact and
 * round-trips, and is no way to lay out a dashboard. This is the workspace
 * the Automation and Operations page gives that blueprint instead:
 *
 *   Palette     every widget in the catalogue, searchable, by family.
 *   Canvas      the 12-column grid, widgets as boxes to select, drag and
 *               resize (or move with the arrow keys, Shift+arrows to resize).
 *   Inspector   the selected widget as a form built from the catalogue's own
 *               settings for its type: dropdowns for closed sets, numbers for
 *               numbers, metric keys with suggestions, required ones marked,
 *               its interactions, its help, and the findings about it.
 *   Settings    the dashboard's own options.
 *
 * It edits the same rows the blueprint reads (widgets_<template>), so "Edit as
 * text" is the rows themselves and nothing is lost going between the two. A
 * dashboard loaded from an export keeps its widget ids in a seventh cell and
 * the export itself in the `imported` value; the blueprint writes it back with
 * only the edits applied (vcf-ops-dashboard-import.ts).
 */

import { el, replace, clear } from './dom.ts';
import type { GeneratorWorkspace, WorkspaceContext } from './generator-page.ts';
import type { Blueprint, BlueprintValues } from '../kit/blueprint.ts';
import type { Finding } from '../core/findings.ts';
import { findingItem } from './components.ts';
import { readDashboardExports } from '../aria/parse.ts';
import { layoutWidgets, parseWidgetRows } from '../automation/blueprints/vcf-ops-build.ts';
import { dashboardChoices, loadDashboard, readStore, type ImportStore } from '../automation/blueprints/vcf-ops-dashboard-import.ts';
import { KIND_ALIASES, Settings, WIDGET_TYPES, metricKeyProblem, widgetType, type WidgetSetting, type WidgetType } from '../automation/blueprints/vcf-ops-widgets.ts';

const COLUMNS = 12;
const ROW_PX = 30;

/** Dashboard options shown in the settings card, in order. */
const DASHBOARD_FIELDS = ['dashboard_name', 'folder', 'description', 'sharing', 'share_groups', 'refresh', 'refresh_content', 'time_range', 'home_tab', 'locked', 'autoswitch', 'autoswitch_delay', 'navigations', 'max_widgets'];

const FAMILY_LABELS: Readonly<Record<string, string>> = {
  list: 'Lists and views',
  chart: 'Charts',
  badge: 'Badges and summaries',
  alert: 'Alerts',
  relationship: 'Relationships and topology',
  picker: 'Pickers',
  text: 'Text and sections',
  logs: 'Logs',
  other: 'Other',
};

const KIND_LABELS: Readonly<Record<string, string>> = {
  vm: 'Virtual machine',
  host: 'ESX host',
  cluster: 'Cluster',
  datastore: 'Datastore',
  datacenter: 'Datacenter',
  vcenter: 'vCenter',
  world: 'vSphere World',
  resourcepool: 'Resource pool',
  namespace: 'Supervisor namespace',
  vks: 'VKS cluster',
  'vsan-cluster': 'vSAN cluster',
  'vsan-diskgroup': 'vSAN disk group',
  'vsan-world': 'vSAN World',
  'nsx-world': 'NSX World',
  'nsx-node': 'NSX transport node',
  'nsx-manager': 'NSX Manager',
  'k8s-namespace': 'Kubernetes namespace',
  'vcf-world': 'VCF World',
  'ops-node': 'VCF Operations node',
};
const KIND_KEYS = Object.keys(KIND_ALIASES);

/** Metric keys seen in the standard dashboards, offered as suggestions. */
const COMMON_METRICS = [
  'cpu|usage_average',
  'cpu|demandPct',
  'cpu|readyPct',
  'cpu|demandmhz',
  'cpu|usagemhz_average',
  'mem|usage_average',
  'mem|guest_usage',
  'virtualDisk|totalLatency',
  'disk|read_average',
  'net|received_average',
  'diskspace|snapshot',
  'capacity|usedSpacePct',
  'badge|health',
  'badge|risk',
  'badge|efficiency',
  'OnlineCapacityAnalytics|capacityRemainingPercentage',
  'OnlineCapacityAnalytics|timeRemaining',
  'OnlineCapacityAnalytics|reclaimableCapacity',
  'summary|number_running_vms',
  'summary|tag',
  'summary|parentCluster',
  'summary|runtime|powerState',
  'config|name',
  'config|hardware|num_Cpu',
  'cost|totalCost',
  'cost|monthlyTotalCost',
];

// ---------------------------------------------------------------------------
// The rows
// ---------------------------------------------------------------------------

/** One widget row: the seven cells, as the blueprint reads them. */
interface Row {
  type: string;
  title: string;
  settings: string;
  position: string;
  provider: string;
  receives: string;
  source: string;
}

const clean = (text: string): string => text.replace(/[\r\n\t]+/g, ' ').replace(/\s+\|\s+/g, '|').trim();

function splitRows(text: string): { rows: Row[]; comments: string[] } {
  const comments: string[] = [];
  const rows: Row[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      comments.push(line);
      continue;
    }
    const [type = '', title = '', settings = '', position = '', provider = '', receives = '', source = ''] = ` ${line} `.split(/(?<=\s)\|(?=\s)/).map((c) => c.trim());
    rows.push({ type, title, settings, position: position || 'auto', provider: provider || 'no', receives, source });
  }
  return { rows, comments };
}

function joinRows(rows: readonly Row[], comments: readonly string[]): string {
  const lines = rows.map((row) => {
    const cells = [row.type, row.title, row.settings, row.position, row.provider, row.receives].map(clean);
    if (row.source) cells.push(clean(row.source));
    return cells.join(' | ');
  });
  return [...comments, ...lines].join('\n');
}

/** Settings as ordered key/value pairs, with what is not key=value kept as it was. */
function readSettings(text: string): { pairs: [string, string][]; malformed: string[] } {
  const s = new Settings(text);
  return { pairs: [...s.values.entries()], malformed: [...s.malformed] };
}

function writeSettings(pairs: readonly [string, string][], malformed: readonly string[]): string {
  const kept = pairs.filter(([, v]) => v.trim() !== '');
  const rest = kept.filter(([k]) => k === 'text' || k === 'html');
  const plain = kept.filter(([k]) => k !== 'text' && k !== 'html').map(([k, v]) => `${k}=${v.replace(/;/g, ',').trim()}`);
  return [...plain, ...malformed, ...rest.map(([k, v]) => `${k}=${v.trim()}`)].join('; ');
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
const overlap = (a: Box, b: Box): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// ---------------------------------------------------------------------------
// Small controls
// ---------------------------------------------------------------------------

function select(options: readonly { value: string; label: string; group?: string }[], current: string, label: string, onChange: (value: string) => void): HTMLSelectElement {
  const node = el('select', { attrs: { 'aria-label': label } }) as HTMLSelectElement;
  let group: HTMLOptGroupElement | null = null;
  let groupName: string | undefined;
  const all = options.some((o) => o.value === current) ? options : [{ value: current, label: `${current} (as written)` }, ...options];
  for (const option of all) {
    if (option.group !== groupName) {
      groupName = option.group;
      group = groupName ? (el('optgroup', { attrs: { label: groupName } }) as HTMLOptGroupElement) : null;
      if (group) node.appendChild(group);
    }
    const opt = el('option', { text: option.label, attrs: { value: option.value } }) as HTMLOptionElement;
    if (option.value === current) opt.selected = true;
    (group ?? node).appendChild(opt);
  }
  node.addEventListener('change', () => onChange(node.value));
  return node;
}

function numberBox(value: string, label: string, onChange: (value: string) => void, min?: number, max?: number): HTMLInputElement {
  const node = el('input', { attrs: { type: 'number', 'aria-label': label, ...(min !== undefined ? { min: String(min) } : {}), ...(max !== undefined ? { max: String(max) } : {}) } }) as HTMLInputElement;
  node.value = value;
  node.addEventListener('input', () => onChange(node.value));
  return node;
}

function textBox(value: string, label: string, onChange: (value: string) => void, placeholder = '', list?: string): HTMLInputElement {
  const node = el('input', { attrs: { type: 'text', 'aria-label': label, placeholder, spellcheck: 'false', ...(list ? { list } : {}) } }) as HTMLInputElement;
  node.value = value;
  node.addEventListener('input', () => onChange(node.value));
  return node;
}

// ---------------------------------------------------------------------------
// The workspace
// ---------------------------------------------------------------------------

export function dashboardWorkspace(blueprint: Blueprint): GeneratorWorkspace | undefined {
  if (blueprint.id !== 'vcfops_dashboard') return undefined;
  return {
    owns: (id) => id === 'template' || id === 'imported' || id.startsWith('widgets_') || DASHBOARD_FIELDS.includes(id),
    mount: (context) => mountBuilder(context),
  };
}

function mountBuilder(context: WorkspaceContext): HTMLElement {
  const { blueprint } = context;
  const templateInput = blueprint.inputs.find((i) => i.id === 'template');
  const templates = templateInput?.options ?? [];
  const uid = `db${Math.random().toString(36).slice(2, 8)}`;

  let template = String(context.values()['template'] ?? templateInput?.default ?? 'capacity');
  let rows: Row[] = [];
  let comments: string[] = [];
  let selected = -1;
  let asText = false;
  let findings: readonly Finding[] = [];
  let store: ImportStore | undefined;
  let message: { text: string; tone: 'ok' | 'bad' | '' } = { text: '', tone: '' };
  let search = '';

  const gridKey = (): string => `widgets_${template}`;
  const defaultRows = (): string => String(blueprint.inputs.find((i) => i.id === gridKey())?.default ?? '');
  const readFromValues = (): void => {
    const v = context.values();
    const text = v[gridKey()];
    const parsed = splitRows(typeof text === 'string' ? text : defaultRows());
    rows = parsed.rows;
    comments = parsed.comments;
    store = template === 'custom' ? readStore(v['imported']) : undefined;
    if (selected >= rows.length) selected = rows.length - 1;
  };
  readFromValues();

  // Suggestions for metric keys and view names, from the standard dashboards.
  const metricSuggestions = new Set(COMMON_METRICS);
  const viewSuggestions = new Set<string>();
  for (const input of blueprint.inputs.filter((i) => i.id.startsWith('widgets_'))) {
    for (const row of splitRows(String(input.default ?? '')).rows) {
      const s = new Settings(row.settings);
      for (const key of ['metric', 'metrics', 'colorby', 'sizeby', 'columns', 'props']) for (const k of s.list(key)) metricSuggestions.add(k);
      if (s.has('view')) viewSuggestions.add(s.get('view'));
    }
  }
  const metricList = el('datalist', { id: `${uid}-metrics` }, ...[...metricSuggestions].sort().map((m) => el('option', { attrs: { value: m } })));
  const viewList = el('datalist', { id: `${uid}-views` }, ...[...viewSuggestions].sort().map((m) => el('option', { attrs: { value: m } })));

  const toolbar = el('div', { class: 'dbb-toolbar' });
  const status = el('div', { class: 'dbb-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  const palette = el('div', { class: 'dbb-palette' });
  const canvasWrap = el('div', { class: 'dbb-canvas-wrap' });
  const canvas = el('div', { class: 'dbb-canvas', attrs: { role: 'application', 'aria-label': 'Dashboard grid, 12 columns' } });
  canvasWrap.appendChild(canvas);
  const offGrid = el('div', { class: 'dbb-offgrid' });
  const dashFindings = el('div', { class: 'dbb-dash-findings' });
  const inspector = el('div', { class: 'dbb-inspector' });
  const settingsCard = el('div', { class: 'dbb-settings' });
  const textArea = el('div', { class: 'dbb-text' });
  const picker = el('div', { class: 'dbb-picker' });
  const main = el(
    'div',
    { class: 'dbb-main' },
    el('section', { class: 'card dbb-card', attrs: { 'aria-label': 'Widget palette' } }, el('div', { class: 'card-title' }, el('h2', { text: 'Widgets' })), palette),
    el('section', { class: 'card dbb-card dbb-canvas-card', attrs: { 'aria-label': 'Dashboard layout' } }, el('div', { class: 'card-title' }, el('h2', { text: 'Layout' })), canvasWrap, offGrid, dashFindings),
    el('section', { class: 'card dbb-card', attrs: { 'aria-label': 'Selected widget' } }, inspector),
  );
  const root = el('div', { class: 'dbb', attrs: { 'data-control': 'dashboard-builder' } }, metricList, viewList, toolbar, picker, status, main, textArea, settingsCard);

  // --- keeping the values in step ----------------------------------------------
  let checkTimer: ReturnType<typeof setTimeout> | undefined;
  const commit = (redraw: 'all' | 'canvas' | 'none' = 'all'): void => {
    context.set({ [gridKey()]: joinRows(rows, comments) });
    if (redraw === 'all') renderAll();
    else if (redraw === 'canvas') renderCanvas();
    if (checkTimer) clearTimeout(checkTimer);
    checkTimer = setTimeout(check, 250);
  };

  /** Build quietly to find what is wrong, and show it beside the widgets it is about. */
  function check(): void {
    try {
      findings = blueprint.build(context.values(), '').findings ?? [];
    } catch (error) {
      findings = [{ code: 'dashboard.builder', severity: 'error', message: error instanceof Error ? error.message : String(error) }];
    }
    renderCanvas();
    renderFindings();
    renderStatus();
    renderOwnFindings();
  }

  /** The findings about the selected widget, redrawn without disturbing the form being typed into. */
  let ownFindings: HTMLElement | null = null;
  function renderOwnFindings(): void {
    if (!ownFindings) return;
    const own = selected >= 0 ? findingsFor(selected) : [];
    replace(ownFindings, ...own.map(findingItem));
    ownFindings.hidden = own.length === 0;
  }

  const findingsFor = (index: number): Finding[] => findings.filter((f) => f.severity !== 'info' && (f.path ?? '').split(/,\s*/).includes(`row ${index + 1}`));

  // --- layout -------------------------------------------------------------------
  function placement(): { boxes: (Box | undefined)[] } {
    const parsed = parseWidgetRows(joinRows(rows, []));
    // A loaded widget of a type the catalogue lacks is still placed where its row says.
    const withTypes = parsed.map((row) => (row.type || !row.source ? row : { ...row, type: WIDGET_TYPES[0]! }));
    const { placed } = layoutWidgets(withTypes);
    const boxes: (Box | undefined)[] = rows.map(() => undefined);
    for (const p of placed) boxes[p.index] = { x: p.x, y: p.y, w: p.w, h: p.h };
    return { boxes };
  }

  function typeOf(row: Row): WidgetType | undefined {
    return widgetType(row.type);
  }

  function firstFree(w: number, h: number, boxes: readonly (Box | undefined)[]): Box {
    const placed = boxes.filter((b): b is Box => !!b);
    const bottom = placed.reduce((m, b) => Math.max(m, b.y + b.h), 1);
    for (let y = 1; y <= bottom; y += 1) {
      for (let x = 1; x + w - 1 <= COLUMNS; x += 1) {
        const box = { x, y, w, h };
        if (!placed.some((b) => overlap(b, box))) return box;
      }
    }
    return { x: 1, y: bottom, w, h };
  }

  function uniqueTitle(base: string, skip = -1): string {
    const taken = new Set(rows.filter((_, i) => i !== skip).map((r) => r.title.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    let n = 2;
    while (taken.has(`${base} ${n}`.toLowerCase())) n += 1;
    return `${base} ${n}`;
  }

  function addWidget(type: WidgetType, at?: { x: number; y: number }): void {
    const { boxes } = placement();
    const w = Math.min(type.size.w, COLUMNS);
    const box = at ? { x: Math.max(1, Math.min(COLUMNS - w + 1, at.x)), y: Math.max(1, at.y), w, h: type.size.h } : firstFree(w, type.size.h, boxes);
    const settings = type.settings.filter((s) => s.required && (s.type === 'kind' || s.type === 'kinds')).map((s) => `${s.key}=${s.type === 'kinds' ? 'cluster' : 'cluster'}`);
    const provider = type.provides && !type.needsSubject ? 'yes' : 'no';
    rows.push({ type: type.type, title: uniqueTitle(type.label), settings: settings.join('; '), position: `${box.x},${box.y},${box.w},${box.h}`, provider, receives: '', source: '' });
    selected = rows.length - 1;
    commit();
    focusSelected();
  }

  function setBox(index: number, box: Box, redraw: 'all' | 'canvas' = 'all'): void {
    const row = rows[index];
    if (!row) return;
    const w = Math.max(1, Math.min(COLUMNS, box.w));
    const x = Math.max(1, Math.min(COLUMNS - w + 1, box.x));
    row.position = `${x},${Math.max(1, box.y)},${w},${Math.max(1, box.h)}`;
    commit(redraw);
  }

  function focusSelected(): void {
    (canvas.querySelector(`[data-index="${selected}"]`) as HTMLElement | null)?.focus();
  }

  // --- toolbar --------------------------------------------------------------------
  function renderToolbar(): void {
    const fileInput = el('input', { class: 'dbb-file', attrs: { type: 'file', accept: '.zip,.json,application/zip,application/json', 'aria-label': 'Load a dashboard from an export file', 'data-control': 'dashboard-load-file' } }) as HTMLInputElement;
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) void loadFile(file);
      fileInput.value = '';
    });
    replace(
      toolbar,
      el(
        'label',
        { class: 'dbb-start' },
        el('span', { text: 'Start from' }),
        select(templates, template, 'Start from', (value) => {
          template = value;
          selected = -1;
          context.set({ template: value });
          readFromValues();
          commit();
        }),
      ),
      el(
        'div',
        { class: 'btn-row' },
        el('button', { class: 'btn btn-small', text: 'Load from export…', attrs: { type: 'button', title: 'A VCF Operations content export (.zip), a dashboard .json, or a file this builder generated', 'data-control': 'dashboard-load' }, on: { click: () => fileInput.click() } }),
        fileInput,
        el('button', {
          class: `btn btn-small${asText ? ' is-active' : ''}`,
          text: asText ? 'Back to the builder' : 'Edit as text',
          attrs: { type: 'button', 'aria-pressed': asText ? 'true' : 'false', 'data-control': 'dashboard-text', title: 'The widget rows as text: Type | Title | Settings | Position | Provider | Receives from' },
          on: {
            click: () => {
              asText = !asText;
              if (!asText) readFromValues();
              renderAll();
            },
          },
        }),
        el('button', { class: 'btn btn-primary btn-small', text: 'Generate', attrs: { type: 'button', 'data-control': 'dashboard-generate' }, on: { click: () => context.generate() } }),
      ),
    );
  }

  function renderStatus(): void {
    const errors = findings.filter((f) => f.severity === 'error').length;
    const warnings = findings.filter((f) => f.severity === 'warning').length;
    const parts = [`${rows.length} widget${rows.length === 1 ? '' : 's'}`, errors ? `${errors} error${errors === 1 ? '' : 's'}` : 'no errors', warnings ? `${warnings} warning${warnings === 1 ? '' : 's'}` : ''];
    replace(
      status,
      message.text ? el('div', { class: `dbb-message ${message.tone === 'bad' ? 'is-bad' : message.tone === 'ok' ? 'is-ok' : ''}`, text: message.text }) : null,
      el('span', { class: `dbb-count${errors ? ' is-bad' : ''}`, text: parts.filter(Boolean).join(' · ') }),
      store ? el('span', { class: 'pill', text: `Loaded: ${String(store.dashboard['name'] ?? '')}`, attrs: { title: `From ${store.file}. What the builder does not edit is written back as exported.` } }) : null,
    );
  }

  // --- loading an export -------------------------------------------------------------
  async function loadFile(file: File): Promise<void> {
    message = { text: `Reading ${file.name}…`, tone: '' };
    renderStatus();
    try {
      const exports = await readDashboardExports(file.name, new Uint8Array(await file.arrayBuffer()));
      const choices = dashboardChoices(exports);
      if (choices.length === 0) {
        message = { text: `${file.name} holds no dashboard. Export one from Dashboards → Manage, or the content from Content Management.`, tone: 'bad' };
        clear(picker);
        renderStatus();
        return;
      }
      const apply = (index: number): void => {
        const choice = choices[index]!;
        const loaded = loadDashboard(exports[choice.exportIndex]!, choice.dashboardIndex, exports);
        context.set(loaded.values as BlueprintValues);
        template = 'custom';
        selected = -1;
        asText = false;
        readFromValues();
        clear(picker);
        message = { text: loaded.summary, tone: 'ok' };
        renderAll();
        check();
      };
      if (choices.length === 1) {
        apply(0);
        return;
      }
      // Several dashboards: pick one.
      let chosen = 0;
      const filter = textBox('', 'Filter dashboards', (q) => {
        const query = q.trim().toLowerCase();
        for (const item of list.querySelectorAll<HTMLElement>('[data-name]')) item.hidden = !!query && !(item.dataset['name'] ?? '').includes(query);
      }, `Filter ${choices.length} dashboards by name`);
      const list = el('div', { class: 'dbb-choice-list', attrs: { role: 'radiogroup', 'aria-label': 'Dashboards in the file' } });
      choices.forEach((choice, index) => {
        const radio = el('input', { attrs: { type: 'radio', name: `${uid}-pick`, value: String(index) } }) as HTMLInputElement;
        radio.checked = index === 0;
        radio.addEventListener('change', () => (chosen = index));
        list.appendChild(el('label', { class: 'dbb-choice', dataset: { name: choice.name.toLowerCase() } }, radio, el('span', { class: 'dbb-choice-name', text: choice.name }), el('span', { class: 'muted small', text: `${choice.widgets} widget${choice.widgets === 1 ? '' : 's'}` })));
      });
      replace(
        picker,
        el(
          'div',
          { class: 'callout dbb-pick' },
          el('strong', { text: `${file.name} holds ${choices.length} dashboards. Pick the one to edit.` }),
          filter,
          list,
          el('div', { class: 'btn-row' }, el('button', { class: 'btn btn-primary btn-small', text: 'Load this dashboard', attrs: { type: 'button', 'data-control': 'dashboard-pick' }, on: { click: () => apply(chosen) } }), el('button', { class: 'btn btn-small', text: 'Cancel', attrs: { type: 'button' }, on: { click: () => clear(picker) } })),
        ),
      );
      message = { text: '', tone: '' };
      renderStatus();
    } catch (error) {
      message = { text: `${file.name} could not be read: ${error instanceof Error ? error.message : String(error)}`, tone: 'bad' };
      renderStatus();
    }
  }

  // --- palette -----------------------------------------------------------------------
  function renderPalette(): void {
    const box = textBox(search, 'Search widgets', (q) => {
      search = q;
      renderPaletteList(listNode);
    }, 'Search widgets');
    box.type = 'search';
    const listNode = el('div', { class: 'dbb-palette-list' });
    replace(palette, box, el('p', { class: 'muted small', text: 'Click to add, or drag onto the layout.' }), listNode);
    renderPaletteList(listNode);
  }

  function renderPaletteList(listNode: HTMLElement): void {
    const q = search.trim().toLowerCase();
    const groups = new Map<string, WidgetType[]>();
    for (const type of WIDGET_TYPES) {
      if (q && !`${type.label} ${type.type} ${FAMILY_LABELS[type.family] ?? ''}`.toLowerCase().includes(q)) continue;
      groups.set(type.family, [...(groups.get(type.family) ?? []), type]);
    }
    clear(listNode);
    if (groups.size === 0) listNode.appendChild(el('div', { class: 'muted small', text: 'No widget matches.' }));
    for (const [family, types] of groups) {
      listNode.appendChild(el('div', { class: 'dbb-family', text: FAMILY_LABELS[family] ?? family }));
      for (const type of types) {
        const item = el(
          'button',
          {
            class: 'dbb-item',
            attrs: { type: 'button', draggable: 'true', title: `${type.label}${type.label === type.type ? '' : ` (${type.type})`} — ${type.size.w}×${type.size.h}`, 'data-type': type.type },
            on: { click: () => addWidget(type) },
          },
          el('span', { class: 'dbb-item-name', text: type.label }),
          type.deprecated ? el('span', { class: 'dbb-tag is-warn', text: 'deprecated' }) : null,
          !type.verified ? el('span', { class: 'dbb-tag', text: 'unverified' }) : null,
        );
        item.addEventListener('dragstart', (event) => {
          (event as DragEvent).dataTransfer?.setData('application/x-dashboard-widget', type.type);
          (event as DragEvent).dataTransfer?.setData('text/plain', type.type);
        });
        listNode.appendChild(item);
      }
    }
  }

  // --- canvas ------------------------------------------------------------------------
  canvas.addEventListener('dragover', (event) => {
    if ((event as DragEvent).dataTransfer?.types.includes('application/x-dashboard-widget')) event.preventDefault();
  });
  canvas.addEventListener('drop', (event) => {
    const drag = event as DragEvent;
    const typeName = drag.dataTransfer?.getData('application/x-dashboard-widget');
    const type = typeName ? widgetType(typeName) : undefined;
    if (!type) return;
    drag.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const col = rect.width / COLUMNS;
    addWidget(type, { x: Math.floor((drag.clientX - rect.left) / col) + 1, y: Math.floor((drag.clientY - rect.top) / ROW_PX) + 1 });
  });
  canvas.addEventListener('pointerdown', (event) => {
    if (event.target === canvas) {
      selected = -1;
      renderCanvas();
      renderInspector();
    }
  });

  function renderCanvas(): void {
    const hadFocus = canvas.contains(document.activeElement);
    drawCanvas();
    if (hadFocus) focusSelected();
  }

  function drawCanvas(): void {
    const { boxes } = placement();
    const bottom = boxes.reduce((m, b) => (b ? Math.max(m, b.y + b.h - 1) : m), 0);
    const rowsShown = Math.max(bottom + 4, 12);
    canvas.style.height = `${rowsShown * ROW_PX}px`;
    clear(canvas);
    // Column guides.
    for (let c = 0; c < COLUMNS; c += 1) canvas.appendChild(el('div', { class: 'dbb-col', style: { left: `${(c / COLUMNS) * 100}%`, width: `${100 / COLUMNS}%` } }));
    const clashes = new Set<number>();
    boxes.forEach((a, i) => {
      if (!a) return;
      boxes.forEach((b, j) => {
        if (b && i !== j && overlap(a, b)) clashes.add(i);
      });
    });
    const offs: HTMLElement[] = [];
    rows.forEach((row, index) => {
      const box = boxes[index];
      const type = typeOf(row);
      const own = findingsFor(index);
      const errors = own.filter((f) => f.severity === 'error').length;
      const warnings = own.filter((f) => f.severity === 'warning').length;
      if (!box) {
        offs.push(
          el('button', { class: `dbb-off${selected === index ? ' is-selected' : ''}`, attrs: { type: 'button' }, on: { click: () => select_(index) } }, el('strong', { text: row.title || '(no title)' }), el('span', { class: 'muted small', text: ` ${row.type || 'no type'} — not on the grid: ${own[0]?.message ?? 'its position or type is not one the grid can place'}` })),
        );
        return;
      }
      const loaded = !!row.source && !!store?.rows[row.source];
      const node = el(
        'div',
        {
          class: `dbb-widget${selected === index ? ' is-selected' : ''}${clashes.has(index) ? ' is-overlap' : ''}${errors ? ' has-error' : warnings ? ' has-warning' : ''}`,
          attrs: {
            tabindex: '0',
            role: 'button',
            'data-index': String(index),
            'aria-label': `${row.title || '(no title)'}, ${type?.label ?? row.type}, column ${box.x}, row ${box.y}, ${box.w} wide, ${box.h} high${clashes.has(index) ? ', overlaps another widget' : ''}${errors ? `, ${errors} error${errors === 1 ? '' : 's'}` : ''}. Arrow keys move it, Shift and arrow keys resize it.`,
            'aria-pressed': selected === index ? 'true' : 'false',
          },
          style: { left: `${((box.x - 1) / COLUMNS) * 100}%`, width: `${(box.w / COLUMNS) * 100}%`, top: `${(box.y - 1) * ROW_PX}px`, height: `${box.h * ROW_PX}px` },
        },
        el('div', { class: 'dbb-widget-title', text: row.title || '(no title)' }),
        box.h > 1 ? el('div', { class: 'dbb-widget-type', text: `${type?.label ?? row.type}${row.receives ? ` ← ${row.receives}` : ''}` }) : null,
        el(
          'div',
          { class: 'dbb-widget-badges' },
          errors ? el('span', { class: 'dbb-badge is-bad', text: String(errors), attrs: { title: `${errors} error${errors === 1 ? '' : 's'}` } }) : null,
          !errors && warnings ? el('span', { class: 'dbb-badge is-warn', text: String(warnings), attrs: { title: `${warnings} warning${warnings === 1 ? '' : 's'}` } }) : null,
          clashes.has(index) ? el('span', { class: 'dbb-badge is-bad', text: 'overlap' }) : null,
          loaded && store?.kept[row.source] ? el('span', { class: 'dbb-badge', text: 'kept', attrs: { title: 'Parts of this widget are kept exactly as exported' } }) : null,
        ),
        el('div', { class: 'dbb-resize', attrs: { 'aria-hidden': 'true', title: 'Drag to resize' } }),
      );
      node.addEventListener('pointerdown', (event) => startDrag(event as PointerEvent, index, box, (event.target as HTMLElement).classList.contains('dbb-resize') ? 'resize' : 'move'));
      node.addEventListener('keydown', (event) => onKey(event as KeyboardEvent, index, box));
      node.addEventListener('focus', () => {
        if (selected !== index) select_(index, false);
      });
      canvas.appendChild(node);
    });
    replace(offGrid, ...(offs.length ? [el('div', { class: 'muted small', text: 'Not on the grid:' }), ...offs] : []));
    if (rows.length === 0) canvas.appendChild(el('div', { class: 'dbb-empty', text: 'No widgets yet. Add one from the list, or start from a standard dashboard.' }));
  }

  function select_(index: number, focus = true): void {
    selected = index;
    renderCanvas();
    renderInspector();
    if (focus) focusSelected();
  }

  function onKey(event: KeyboardEvent, index: number, box: Box): void {
    const moves: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      const next = event.shiftKey ? { ...box, w: box.w + move[0], h: box.h + move[1] } : { ...box, x: box.x + move[0], y: box.y + move[1] };
      if (next.w < 1 || next.h < 1 || next.y < 1 || next.x < 1 || next.x + next.w - 1 > COLUMNS) return;
      selected = index;
      setBox(index, next, 'canvas');
      renderInspector();
      focusSelected();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      select_(index);
      (inspector.querySelector('input, select, textarea') as HTMLElement | null)?.focus();
    } else if (event.key === 'Delete') {
      event.preventDefault();
      removeWidget(index);
    }
  }

  function startDrag(event: PointerEvent, index: number, box: Box, mode: 'move' | 'resize'): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const node = event.currentTarget as HTMLElement;
    const rect = canvas.getBoundingClientRect();
    const col = rect.width / COLUMNS;
    const startX = event.clientX;
    const startY = event.clientY;
    let next = { ...box };
    if (selected !== index) {
      selected = index;
      canvas.querySelectorAll('.dbb-widget.is-selected').forEach((n) => n.classList.remove('is-selected'));
      node.classList.add('is-selected');
    }
    node.classList.add('is-dragging');
    try {
      node.setPointerCapture(event.pointerId);
    } catch {
      // Capture is a nicety; the move still tracks without it.
    }
    const onMove = (e: PointerEvent): void => {
      const dx = Math.round((e.clientX - startX) / col);
      const dy = Math.round((e.clientY - startY) / ROW_PX);
      if (mode === 'move') {
        next = { ...box, x: Math.max(1, Math.min(COLUMNS - box.w + 1, box.x + dx)), y: Math.max(1, box.y + dy) };
      } else {
        next = { ...box, w: Math.max(1, Math.min(COLUMNS - box.x + 1, box.w + dx)), h: Math.max(1, box.h + dy) };
      }
      node.style.left = `${((next.x - 1) / COLUMNS) * 100}%`;
      node.style.width = `${(next.w / COLUMNS) * 100}%`;
      node.style.top = `${(next.y - 1) * ROW_PX}px`;
      node.style.height = `${next.h * ROW_PX}px`;
    };
    const onUp = (): void => {
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerup', onUp);
      node.removeEventListener('pointercancel', onUp);
      node.classList.remove('is-dragging');
      if (next.x !== box.x || next.y !== box.y || next.w !== box.w || next.h !== box.h) setBox(index, next, 'canvas');
      else renderCanvas();
      renderInspector();
      focusSelected();
    };
    node.addEventListener('pointermove', onMove);
    node.addEventListener('pointerup', onUp);
    node.addEventListener('pointercancel', onUp);
  }

  function removeWidget(index: number): void {
    const gone = rows[index];
    if (!gone) return;
    rows.splice(index, 1);
    for (const row of rows) if (gone.title && row.receives.toLowerCase() === gone.title.toLowerCase()) row.receives = '';
    selected = Math.min(index, rows.length - 1);
    commit();
  }

  // --- inspector -----------------------------------------------------------------------
  function renderInspector(): void {
    const row = rows[selected];
    if (!row) {
      ownFindings = null;
      replace(
        inspector,
        el('div', { class: 'card-title' }, el('h2', { text: 'Widget' })),
        el('p', { class: 'muted', text: rows.length ? 'Select a widget on the layout to edit it: its settings, where it sits, and what drives it.' : 'Add a widget from the list.' }),
        el('p', { class: 'muted small', text: 'Keyboard: Tab to a widget, arrow keys move it, Shift and arrow keys resize it, Enter edits it, Delete removes it.' }),
      );
      return;
    }
    const index = selected;
    const type = typeOf(row);
    const { boxes } = placement();
    const box = boxes[index];
    const own = findingsFor(index);
    const edit = (patch: Partial<Row>, redraw: 'all' | 'canvas' | 'none' = 'canvas'): void => {
      const before = row.title;
      Object.assign(row, patch);
      // Renaming a widget carries its receivers along.
      if (patch.title !== undefined && before && before !== patch.title) for (const other of rows) if (other !== row && other.receives.toLowerCase() === before.toLowerCase()) other.receives = patch.title;
      commit(redraw);
    };

    const typeOptions = WIDGET_TYPES.map((t) => ({ value: t.type, label: `${t.label}${t.deprecated ? ' (deprecated)' : ''}`, group: FAMILY_LABELS[t.family] ?? t.family }));
    const others = rows.filter((_, i) => i !== index && rows[i]!.title);
    const receiveOptions = [{ value: '', label: 'Nothing — it provides for itself or stands alone' }, ...others.map((o) => ({ value: o.title, label: `${o.title}${typeOf(o) && !typeOf(o)!.provides ? ' (cannot send)' : ''}` }))];

    const position = el(
      'div',
      { class: 'dbb-xywh' },
      ...(['x', 'y', 'w', 'h'] as const).map((key) => {
        const current = box ? String(box[key]) : '';
        const input = numberBox(current, `${key === 'x' ? 'Column' : key === 'y' ? 'Row' : key === 'w' ? 'Width' : 'Height'} (${key})`, (value) => {
          const n = Number(value);
          if (!box || !Number.isInteger(n) || n < 1) return;
          setBox(index, { ...box, [key]: n }, 'canvas');
        }, 1, key === 'x' || key === 'w' ? COLUMNS : undefined);
        return el('label', { class: 'dbb-mini' }, el('span', { text: key }), input);
      }),
    );

    const loadedKept = row.source ? store?.kept[row.source] : undefined;
    replace(
      inspector,
      el('div', { class: 'card-title' }, el('h2', { text: row.title || 'Widget' })),
      (ownFindings = el('div', { class: 'findings dbb-own-findings', attrs: own.length ? {} : { hidden: true } }, ...own.map(findingItem))),
      el('div', { class: 'field' }, el('div', { class: 'field-head' }, el('label', { text: 'Type' })), select(type ? typeOptions : [...typeOptions], row.type, 'Widget type', (value) => edit({ type: value }, 'all'))),
      el('div', { class: 'field' }, el('div', { class: 'field-head' }, el('label', { text: 'Title' }), el('span', { class: 'field-hint', text: 'Unique; Receives from names it' })), textBox(row.title, 'Title', (value) => edit({ title: value }))),
      el('div', { class: 'field' }, el('div', { class: 'field-head' }, el('label', { text: 'Place on the grid' }), el('span', { class: 'field-hint', text: 'Column, row, width, height' })), box ? position : el('p', { class: 'muted small', text: `Position "${row.position}" is not one the grid can place.` })),
      el(
        'div',
        { class: 'dbb-pair' },
        el('div', { class: 'field' }, el('div', { class: 'field-head' }, el('label', { text: 'Provider' })), select([{ value: 'yes', label: 'Yes — picks its own objects' }, { value: 'no', label: 'No' }], /^(yes|y|true|on|1)$/i.test(row.provider) ? 'yes' : /^(no|n|false|off|0|)$/i.test(row.provider) ? 'no' : row.provider, 'Provider', (value) => edit({ provider: value }, 'all'))),
        el('div', { class: 'field' }, el('div', { class: 'field-head' }, el('label', { text: 'Receives from' })), select(receiveOptions, row.receives, 'Receives from', (value) => edit({ receives: value, ...(value ? { provider: 'no' } : {}) }, 'all'))),
      ),
      type ? settingsForm(row, type, (text) => edit({ settings: text })) : el('div', { class: 'callout' }, el('p', { text: row.source && store?.rows[row.source] ? `${row.type} is a widget type the builder does not know. It is written back exactly as it was loaded; its title and place can be changed here.` : `"${row.type}" is not a VCF Operations widget type. Pick one from the Type list.` })),
      loadedKept && loadedKept.length ? el('details', { class: 'dbb-kept' }, el('summary', { text: 'Kept exactly as exported' }), el('ul', {}, ...loadedKept.map((item) => el('li', { text: item })))) : null,
      type ? helpFor(type) : null,
      el(
        'div',
        { class: 'btn-row' },
        el('button', {
          class: 'btn btn-small',
          text: 'Duplicate',
          attrs: { type: 'button' },
          on: {
            click: () => {
              const copy = { ...row, title: uniqueTitle(`${row.title} copy`), source: '' };
              const w = box?.w ?? 4;
              const h = box?.h ?? 4;
              const free = firstFree(w, h, placement().boxes);
              copy.position = `${free.x},${free.y},${free.w},${free.h}`;
              rows.splice(index + 1, 0, copy);
              selected = index + 1;
              commit();
              focusSelected();
            },
          },
        }),
        el('button', { class: 'btn btn-small btn-danger', text: 'Remove', attrs: { type: 'button', 'data-control': 'dashboard-remove' }, on: { click: () => removeWidget(index) } }),
      ),
    );
  }

  /** What the catalogue says about the type: shown for the selected widget only. */
  function helpFor(type: WidgetType): HTMLElement {
    return el(
      'details',
      { class: 'dbb-help' },
      el('summary', { text: `About the ${type.label}` }),
      el('p', { class: 'small', text: `${type.label}${type.label === type.type ? '' : ` (${type.type} in the export)`}. ${type.provides ? 'It can drive other widgets: selecting in it sends an object.' : 'It cannot drive other widgets.'} ${type.needsSubject ? 'It shows nothing until it provides for itself or is sent an object.' : ''}` }),
      type.note ? el('p', { class: 'small', text: type.note }) : null,
      type.deprecated ? el('p', { class: 'small', text: 'Deprecated in VCF Operations 9, and will be removed.' }) : null,
      !type.verified ? el('p', { class: 'small', text: 'No real export of this widget was found, so its config is what the product documentation implies. Open it after import and save it once.' }) : null,
      el('p', { class: 'muted small', text: `Config shape from: ${type.source}.` }),
    );
  }

  /** The settings of one widget, as a form built from the catalogue. */
  function settingsForm(row: Row, type: WidgetType, onText: (text: string) => void): HTMLElement {
    const { pairs, malformed } = readSettings(row.settings);
    const map = new Map(pairs);
    const known = new Set(type.settings.map((s) => s.key));
    const write = (): void => {
      const ordered: [string, string][] = [...type.settings.map((s) => [s.key, map.get(s.key) ?? ''] as [string, string]), ...[...map.entries()].filter(([k]) => !known.has(k))];
      onText(writeSettings(ordered, malformed));
    };
    const set = (key: string, value: string): void => {
      map.set(key, value);
      write();
    };
    const fields = type.settings.map((setting) => settingField(setting, map.get(setting.key) ?? '', (value) => set(setting.key, value)));
    const unknown = [...map.entries()].filter(([k]) => !known.has(k));
    return el(
      'div',
      { class: 'dbb-settings-form' },
      el('div', { class: 'dbb-subhead', text: type.settings.length ? 'Settings' : 'This widget takes no settings.' }),
      ...fields,
      unknown.length || malformed.length
        ? el(
            'div',
            { class: 'field' },
            el('div', { class: 'field-head' }, el('label', { text: 'Other settings in the row' }), el('span', { class: 'field-hint', text: `Not ${type.label} settings; kept, and ignored` })),
            textBox(writeSettings(unknown, malformed), 'Other settings', (value) => {
              for (const [k] of unknown) map.delete(k);
              const extra = readSettings(value);
              for (const [k, v] of extra.pairs) map.set(k, v);
              malformed.splice(0, malformed.length, ...extra.malformed);
              write();
            }),
          )
        : null,
    );
  }

  function settingField(setting: WidgetSetting, value: string, onChange: (value: string) => void): HTMLElement {
    const label = el('label', { text: setting.key }, setting.required ? el('span', { class: 'dbb-required', text: ' *', attrs: { title: 'Required', 'aria-label': 'required' } }) : null);
    const problem = el('div', { class: 'dbb-problem' });
    const showProblem = (text: string): void => {
      if (setting.type !== 'metric' && setting.type !== 'metrics') return;
      const keys = setting.type === 'metric' ? [text.trim()] : text.split(',').map((k) => k.trim());
      const bad = keys.filter(Boolean).map((k) => [k, metricKeyProblem(k)] as const).find(([, p]) => p);
      problem.textContent = bad ? `"${bad[0]}" ${bad[1]}` : '';
    };
    let control: HTMLElement;
    const withDefault = (options: readonly string[]) => [{ value: '', label: '(default)' }, ...options.map((o) => ({ value: o, label: o }))];
    switch (setting.type) {
      case 'kind': {
        const options = [{ value: '', label: '(choose)' }, ...KIND_KEYS.map((k) => ({ value: k, label: KIND_LABELS[k] ?? k }))];
        control = comboBox(options, value, setting.key, onChange, 'Adapter/Kind');
        break;
      }
      case 'kinds':
        control = multiBox(KIND_KEYS.map((k) => ({ value: k, label: KIND_LABELS[k] ?? k })), value, setting.key, onChange, 'Adapter/Kind, comma separated');
        break;
      case 'choice':
        control = select(withDefault(setting.options ?? []), value, setting.key, onChange);
        break;
      case 'choices':
        control = multiBox((setting.options ?? []).map((o) => ({ value: o, label: o })), value, setting.key, onChange);
        break;
      case 'yesno':
        control = select([{ value: '', label: '(default)' }, { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }], /^(yes|true|on|1)$/i.test(value) ? 'yes' : /^(no|false|off|0)$/i.test(value) ? 'no' : value, setting.key, onChange);
        break;
      case 'number':
        control = numberBox(value, setting.key, onChange, setting.min, setting.max);
        break;
      case 'numbers':
        if (setting.key === 'thresholds') {
          const parts = value.split(',').map((p) => p.trim());
          const boxes = ['Yellow', 'Orange', 'Red'].map((name, i) =>
            el('label', { class: 'dbb-mini' }, el('span', { text: name }), numberBox(parts[i] ?? '', `Threshold ${name.toLowerCase()}`, (v) => {
              parts[i] = v;
              onChange(parts.every((p) => !p) ? '' : parts.slice(0, 3).map((p) => p ?? '').join(','));
            })),
          );
          control = el('div', { class: 'dbb-xywh dbb-three' }, ...boxes);
        } else control = textBox(value, setting.key, onChange, 'Numbers, comma separated');
        break;
      case 'metric':
        control = textBox(value, setting.key, (v) => {
          showProblem(v);
          onChange(v);
        }, 'group|name, e.g. cpu|usage_average', `${uid}-metrics`);
        break;
      case 'metrics':
        control = metricsBox(value, setting.key, (v) => {
          showProblem(v);
          onChange(v);
        });
        break;
      case 'colors': {
        const swatches = el('span', { class: 'dbb-swatches' });
        const paint = (text: string): void => {
          replace(swatches, ...text.split(',').map((c) => c.trim()).filter((c) => /^#[0-9a-f]{6}$/i.test(c)).map((c) => el('span', { class: 'dbb-swatch', style: { background: c }, attrs: { title: c } })));
        };
        paint(value);
        control = el('div', { class: 'dbb-colors' }, textBox(value, setting.key, (v) => {
          paint(v);
          onChange(v);
        }, '#8ABF5B,#EACC58,#E4695E'), swatches);
        break;
      }
      case 'rest': {
        const area = el('textarea', { attrs: { rows: '3', spellcheck: 'false', 'aria-label': setting.key } }) as HTMLTextAreaElement;
        area.value = value;
        area.addEventListener('input', () => onChange(area.value.replace(/\n+/g, ' ')));
        control = area;
        break;
      }
      default:
        control = textBox(value, setting.key, onChange, '', setting.key === 'view' ? `${uid}-views` : undefined);
    }
    showProblem(value);
    return el('div', { class: 'field dbb-setting' }, el('div', { class: 'field-head' }, label), control, el('div', { class: 'dbb-setting-help', text: setting.help }), problem);
  }

  /** A dropdown of the common answers, and a text box for any other. */
  function comboBox(options: readonly { value: string; label: string }[], value: string, label: string, onChange: (value: string) => void, placeholder: string): HTMLElement {
    const known = options.some((o) => o.value === value);
    const other = el('input', { attrs: { type: 'text', 'aria-label': `${label} (other)`, placeholder } }) as HTMLInputElement;
    other.value = known ? '' : value;
    other.hidden = known;
    const pick = select([...options, { value: '__other__', label: 'Other — type a value…' }], known ? value : '__other__', label, (v) => {
      other.hidden = v !== '__other__';
      if (v === '__other__') other.focus();
      else onChange(v);
    });
    other.addEventListener('input', () => onChange(other.value.trim()));
    return el('div', { class: 'dbb-combo' }, pick, other);
  }

  /** Tick any of the options; anything else written in the row stays in a text box. */
  function multiBox(options: readonly { value: string; label: string }[], value: string, label: string, onChange: (value: string) => void, otherPlaceholder?: string): HTMLElement {
    const picked = value.split(',').map((v) => v.trim()).filter(Boolean);
    const known = new Set(options.map((o) => o.value.toLowerCase()));
    let extra = picked.filter((p) => !known.has(p.toLowerCase()));
    const ticked = new Set(picked.filter((p) => known.has(p.toLowerCase())).map((p) => p.toLowerCase()));
    const emit = (): void => onChange([...options.filter((o) => ticked.has(o.value.toLowerCase())).map((o) => o.value), ...extra].join(','));
    const boxes = options.map((option) => {
      const box = el('input', { attrs: { type: 'checkbox' } }) as HTMLInputElement;
      box.checked = ticked.has(option.value.toLowerCase());
      box.addEventListener('change', () => {
        if (box.checked) ticked.add(option.value.toLowerCase());
        else ticked.delete(option.value.toLowerCase());
        emit();
      });
      return el('label', { class: 'tag-check' }, box, el('span', { text: option.label }));
    });
    const other = otherPlaceholder || extra.length
      ? textBox(extra.join(','), `${label} (others)`, (v) => {
          extra = v.split(',').map((p) => p.trim()).filter(Boolean);
          emit();
        }, otherPlaceholder ?? 'Others, comma separated')
      : null;
    return el('div', { class: 'dbb-multi' }, el('div', { class: 'checklist tag-chips' }, ...boxes), other);
  }

  /** Metric keys, one per line of the list, each with suggestions; order kept (labels follow it). */
  function metricsBox(value: string, label: string, onChange: (value: string) => void): HTMLElement {
    let keys = value.split(',').map((k) => k.trim()).filter(Boolean);
    const wrap = el('div', { class: 'dbb-metrics' });
    const emit = (): void => onChange(keys.filter(Boolean).join(','));
    const draw = (): void => {
      clear(wrap);
      keys.forEach((key, i) => {
        wrap.appendChild(
          el(
            'div',
            { class: 'dbb-metric' },
            textBox(key, `${label} ${i + 1}`, (v) => {
              keys[i] = v.trim();
              emit();
            }, 'group|name', `${uid}-metrics`),
            el('button', {
              class: 'tag-cat-x',
              text: '×',
              attrs: { type: 'button', 'aria-label': `Remove ${key || `metric ${i + 1}`}` },
              on: {
                click: () => {
                  keys = keys.filter((_, j) => j !== i);
                  emit();
                  draw();
                },
              },
            }),
          ),
        );
      });
      wrap.appendChild(
        el('button', {
          class: 'btn btn-small',
          text: 'Add metric',
          attrs: { type: 'button' },
          on: {
            click: () => {
              keys = [...keys, ''];
              draw();
              (wrap.querySelectorAll('input')[keys.length - 1] as HTMLInputElement | undefined)?.focus();
            },
          },
        }),
      );
    };
    draw();
    return wrap;
  }

  // --- findings not about one widget ---------------------------------------------------
  function renderFindings(): void {
    const general = findings.filter((f) => f.severity !== 'info' && !/row \d+/.test(f.path ?? ''));
    replace(dashFindings, ...(general.length ? [el('div', { class: 'findings' }, ...general.map(findingItem))] : []));
  }

  // --- dashboard settings ---------------------------------------------------------------
  function renderSettings(): void {
    const fields: HTMLElement[] = [];
    for (const id of DASHBOARD_FIELDS) {
      const input = blueprint.inputs.find((i) => i.id === id);
      const node = context.field(id, () => {
        // A follow-up question may have appeared or gone.
        if (blueprint.inputs.some((i) => i.showWhen?.input === id)) renderSettings();
        if (checkTimer) clearTimeout(checkTimer);
        checkTimer = setTimeout(check, 250);
      });
      if (node && input) fields.push(node);
    }
    const loadedNotes = store?.notes ?? [];
    replace(
      settingsCard,
      el(
        'section',
        { class: 'card dbb-card' },
        el('div', { class: 'card-title' }, el('h2', { text: 'Dashboard settings' })),
        el('div', { class: 'dbb-settings-grid' }, ...fields),
        loadedNotes.length ? el('details', { class: 'dbb-kept' }, el('summary', { text: 'Kept exactly as exported' }), el('ul', {}, ...loadedNotes.map((n) => el('li', { text: n })))) : null,
      ),
    );
  }

  // --- edit as text -----------------------------------------------------------------------
  function renderText(): void {
    if (!asText) {
      clear(textArea);
      return;
    }
    const area = el('textarea', { class: 'mono dbb-textarea', attrs: { spellcheck: 'false', rows: String(Math.max(8, rows.length + comments.length + 2)), 'aria-label': 'Widget rows as text', 'data-control': 'dashboard-rows' } }) as HTMLTextAreaElement;
    area.value = joinRows(rows, comments);
    area.addEventListener('input', () => {
      context.set({ [gridKey()]: area.value });
      if (checkTimer) clearTimeout(checkTimer);
      checkTimer = setTimeout(check, 400);
    });
    replace(
      textArea,
      el(
        'section',
        { class: 'card dbb-card' },
        el('div', { class: 'card-title' }, el('h2', { text: 'Widget rows' })),
        el('p', { class: 'muted small', text: 'Type | Title | Settings (key=value; …) | Position (x,y,w,h, w,h or auto) | Provider (yes/no) | Receives from (a widget title) | Loaded widget (an id from a loaded export; leave it as it is). "Back to the builder" reads the rows again.' }),
        area,
      ),
    );
  }

  function renderAll(): void {
    renderToolbar();
    renderStatus();
    main.hidden = asText;
    if (!asText) {
      renderPalette();
      renderCanvas();
      renderFindings();
      renderInspector();
    }
    renderText();
    renderSettings();
  }

  renderAll();
  check();
  return root;
}

// Exposed for tests.
export const __test = { splitRows, joinRows, readSettings, writeSettings };
