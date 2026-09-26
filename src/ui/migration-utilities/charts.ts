/**
 * Inline SVG charts for the Track panes (addendum A.8.4): the burn-down, the
 * cumulative flow, the wave timeline with its T-minus milestones and freeze
 * windows, and the small stacked state bar of a wave card. No library.
 *
 * Every chart is built in two steps, so it can be tested without a browser:
 *   1. a pure function lays the chart out as an `SvgNode` tree;
 *   2. `renderSvg` turns the tree into DOM nodes (`createElementNS`, text
 *      through `textContent`, never markup), and `svgMarkup` into text.
 *
 * Colours are the page's theme tokens (`var(--accent)` …) set through the
 * `style` attribute, so the charts follow the light and dark themes; the
 * item states use one fixed ramp that reads on both. The charts scale to
 * their container (`viewBox`, width 100%), so a phone never scrolls sideways.
 */

import { ITEM_STATE_OPTIONS, ITEM_STATE_VALUES, labelOf } from '../../multicloud/plan/options.ts';
import type { FreezeWindow, GateDecision, GateId, ItemState } from '../../multicloud/plan/types.ts';

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

export interface SvgNode {
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string | number>>;
  readonly children?: readonly SvgNode[];
  /** Text content (for `text` and `title`). */
  readonly text?: string;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

const n = (tag: string, attrs: Record<string, string | number>, children?: readonly SvgNode[], text?: string): SvgNode =>
  ({ tag, attrs, ...(children ? { children } : {}), ...(text !== undefined ? { text } : {}) });

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The tree as SVG text (tests, and anything that wants a file). */
export function svgMarkup(node: SvgNode): string {
  const attrs = Object.entries(node.attrs).map(([k, v]) => ` ${k}="${esc(String(v))}"`).join('');
  const inner = `${node.text !== undefined ? esc(node.text) : ''}${(node.children ?? []).map(svgMarkup).join('')}`;
  const xmlns = node.tag === 'svg' ? ` xmlns="${SVG_NS}"` : '';
  return `<${node.tag}${xmlns}${attrs}>${inner}</${node.tag}>`;
}

/** The tree as DOM nodes. */
export function renderSvg(node: SvgNode): SVGElement {
  const out = document.createElementNS(SVG_NS, node.tag) as SVGElement;
  for (const [k, v] of Object.entries(node.attrs)) out.setAttribute(k, String(v));
  if (node.text !== undefined) out.textContent = node.text;
  for (const c of node.children ?? []) out.appendChild(renderSvg(c));
  return out;
}

/** Every node of a tree, depth first (tests count marks with it). */
export function walk(node: SvgNode): SvgNode[] {
  return [node, ...(node.children ?? []).flatMap(walk)];
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

/** One ramp for the item states: grey (not started) through blue (moving) and amber (cutting over) to green (done). */
export const STATE_COLORS: Readonly<Record<ItemState, string>> = Object.freeze({
  planned: '#8b95a7',
  prepared: '#a5b4cb',
  replicating: '#7fb0ff',
  'in-sync': '#4d8dff',
  testing: '#b69cff',
  tested: '#8b5cf6',
  'cutting-over': '#f59e0b',
  'cut-over': '#eab308',
  validated: '#34d399',
  accepted: '#10b981',
  decommissioned: '#047857',
});

const GATE_COLOR: Readonly<Record<GateDecision, string>> = { go: 'var(--ok)', 'no-go': 'var(--danger)' };

const fill = (c: string): string => `fill:${c}`;
const stroke = (c: string, w = 1.5): string => `fill:none;stroke:${c};stroke-width:${w}`;
const TEXT = 'fill:var(--text-muted);font-size:11px;font-family:var(--font)';
const TEXT_STRONG = 'fill:var(--text);font-size:11px;font-family:var(--font)';

// ---------------------------------------------------------------------------
// Axes
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const dayNum = (d: string): number => Date.parse(`${d.slice(0, 10)}T00:00:00Z`) / DAY;

/** Round a maximum up to a tidy axis top. */
export function niceMax(max: number): number {
  if (max <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= max) return m * p;
  return 10 * p;
}

/** Up to `count` evenly spaced labels of a day list (first and last always). */
export function dayTicks(days: readonly string[], count = 6): { index: number; day: string }[] {
  if (days.length === 0) return [];
  if (days.length <= count) return days.map((day, index) => ({ index, day }));
  const step = (days.length - 1) / (count - 1);
  const out: { index: number; day: string }[] = [];
  for (let i = 0; i < count; i += 1) {
    const index = Math.round(i * step);
    out.push({ index, day: days[index] as string });
  }
  return out;
}

interface Frame { readonly w: number; readonly h: number; readonly left: number; readonly right: number; readonly top: number; readonly bottom: number }
const FRAME: Frame = { w: 640, h: 260, left: 40, right: 12, top: 14, bottom: 40 };
const plotW = (f: Frame): number => f.w - f.left - f.right;
const plotH = (f: Frame): number => f.h - f.top - f.bottom;

function frameSvg(f: Frame, title: string, children: SvgNode[]): SvgNode {
  return n('svg', {
    viewBox: `0 0 ${f.w} ${f.h}`, width: '100%', role: 'img', 'aria-label': title,
    preserveAspectRatio: 'xMidYMid meet', style: 'max-width:100%;height:auto;display:block',
  }, [n('title', {}, undefined, title), ...children]);
}

function yAxis(f: Frame, top: number): SvgNode[] {
  const out: SvgNode[] = [];
  for (let i = 0; i <= 4; i += 1) {
    const v = (top * i) / 4;
    const y = f.top + plotH(f) - (plotH(f) * i) / 4;
    out.push(n('line', { x1: f.left, x2: f.w - f.right, y1: y, y2: y, style: `stroke:var(--border);stroke-width:1` }));
    out.push(n('text', { x: f.left - 6, y: y + 4, 'text-anchor': 'end', style: TEXT }, undefined, String(Math.round(v * 10) / 10)));
  }
  return out;
}

function xAxis(f: Frame, days: readonly string[], xOf: (i: number) => number): SvgNode[] {
  return dayTicks(days, 5).map((t) => n('text', { x: xOf(t.index), y: f.h - f.bottom + 16, 'text-anchor': 'middle', style: TEXT }, undefined, t.day.slice(5)));
}

function legend(f: Frame, items: readonly { label: string; color: string; dash?: boolean }[]): SvgNode[] {
  const out: SvgNode[] = [];
  let x = f.left;
  const y = f.h - 8;
  for (const it of items) {
    out.push(n('line', { x1: x, x2: x + 16, y1: y - 4, y2: y - 4, style: `${stroke(it.color, 3)}${it.dash ? ';stroke-dasharray:4 3' : ''}` }));
    out.push(n('text', { x: x + 20, y, style: TEXT }, undefined, it.label));
    x += 28 + it.label.length * 6;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Burn-down (A.8.4 chart 2)
// ---------------------------------------------------------------------------

export interface BurnInput {
  readonly day: string;
  readonly actual?: number;
  readonly ideal?: number;
}

/** The burn-down: items not yet at the target state per day (actual, to today), and the ideal line from the wave plan. */
export function burnDownChart(points: readonly BurnInput[], targetLabel: string): SvgNode {
  const f = FRAME;
  const title = `Burn-down: items not yet ${targetLabel}`;
  if (points.length === 0) return frameSvg(f, title, [n('text', { x: f.w / 2, y: f.h / 2, 'text-anchor': 'middle', style: TEXT }, undefined, 'No items to chart yet.')]);
  const days = points.map((p) => p.day);
  const top = niceMax(Math.max(1, ...points.map((p) => Math.max(p.actual ?? 0, p.ideal ?? 0))));
  const xOf = (i: number): number => f.left + (days.length === 1 ? plotW(f) / 2 : (plotW(f) * i) / (days.length - 1));
  const yOf = (v: number): number => f.top + plotH(f) - (plotH(f) * v) / top;
  const path = (pick: (p: BurnInput) => number | undefined): string => {
    let d = '';
    let pen = false;
    points.forEach((p, i) => {
      const v = pick(p);
      if (v === undefined) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${xOf(i).toFixed(1)} ${yOf(v).toFixed(1)} `;
      pen = true;
    });
    return d.trim();
  };
  const ideal = path((p) => p.ideal);
  const actual = path((p) => p.actual);
  const children: SvgNode[] = [...yAxis(f, top), ...xAxis(f, days, xOf)];
  if (ideal) children.push(n('path', { d: ideal, 'data-series': 'ideal', style: `${stroke('var(--text-faint)', 2)};stroke-dasharray:6 4` }));
  if (actual) children.push(n('path', { d: actual, 'data-series': 'actual', style: stroke('var(--accent)', 2.5) }));
  const last = [...points].reverse().find((p) => p.actual !== undefined);
  if (last) {
    const i = points.indexOf(last);
    children.push(n('circle', { cx: xOf(i), cy: yOf(last.actual as number), r: 3.5, style: fill('var(--accent)') }, [n('title', {}, undefined, `${last.day}: ${last.actual} left`)]));
  }
  children.push(...legend(f, [{ label: 'Actual (from the events)', color: 'var(--accent)' }, ...(ideal ? [{ label: 'Ideal (wave plan)', color: 'var(--text-faint)', dash: true }] : [])]));
  return frameSvg(f, title, children);
}

// ---------------------------------------------------------------------------
// Cumulative flow (A.8.4 chart 3)
// ---------------------------------------------------------------------------

export interface FlowInput {
  readonly day: string;
  readonly counts: Readonly<Record<ItemState, number>>;
}

/** A stacked area of the count per state per day: where the work queues. */
export function cumulativeFlowChart(rows: readonly FlowInput[]): SvgNode {
  const f: Frame = { ...FRAME, h: 300, bottom: 78 };
  const title = 'Cumulative flow: items per state per day';
  if (rows.length === 0) return frameSvg(f, title, [n('text', { x: f.w / 2, y: f.h / 2, 'text-anchor': 'middle', style: TEXT }, undefined, 'No items to chart yet.')]);
  const days = rows.map((r) => r.day);
  const totals = rows.map((r) => ITEM_STATE_VALUES.reduce((s, st) => s + (r.counts[st] ?? 0), 0));
  const top = niceMax(Math.max(1, ...totals));
  const xOf = (i: number): number => f.left + (days.length === 1 ? plotW(f) / 2 : (plotW(f) * i) / (days.length - 1));
  const yOf = (v: number): number => f.top + plotH(f) - (plotH(f) * v) / top;
  // Done states at the bottom, so progress rises from the axis.
  const order = [...ITEM_STATE_VALUES].reverse();
  const present = order.filter((st) => rows.some((r) => (r.counts[st] ?? 0) > 0));
  const base = rows.map(() => 0);
  const children: SvgNode[] = [...yAxis(f, top), ...xAxis(f, days, xOf)];
  for (const st of present) {
    const lower = [...base];
    rows.forEach((r, i) => { base[i] = (base[i] as number) + (r.counts[st] ?? 0); });
    const pts = rows.length === 1
      ? [`${f.left} ${yOf(base[0] as number)}`, `${f.w - f.right} ${yOf(base[0] as number)}`, `${f.w - f.right} ${yOf(lower[0] as number)}`, `${f.left} ${yOf(lower[0] as number)}`]
      : [
        ...rows.map((_r, i) => `${xOf(i).toFixed(1)} ${yOf(base[i] as number).toFixed(1)}`),
        ...rows.map((_r, i) => `${xOf(rows.length - 1 - i).toFixed(1)} ${yOf(lower[rows.length - 1 - i] as number).toFixed(1)}`),
      ];
    children.push(n('path', { d: `M${pts.join(' L')} Z`, 'data-state': st, style: `${fill(STATE_COLORS[st])};opacity:0.85` }, [n('title', {}, undefined, labelOf(ITEM_STATE_OPTIONS, st))]));
  }
  // Legend: two rows of swatches under the axis.
  const per = Math.max(1, Math.ceil(present.length / 2));
  [...present].reverse().forEach((st, i) => {
    const row = Math.floor(i / per);
    const col = i % per;
    const x = f.left + col * 110;
    const y = f.h - f.bottom + 34 + row * 18;
    children.push(n('rect', { x, y: y - 9, width: 10, height: 10, style: fill(STATE_COLORS[st]) }));
    children.push(n('text', { x: x + 14, y, style: TEXT }, undefined, labelOf(ITEM_STATE_OPTIONS, st)));
  });
  return frameSvg(f, title, children);
}

// ---------------------------------------------------------------------------
// The stacked state bar of a wave card
// ---------------------------------------------------------------------------

/** A thin bar: one segment per state, in state order, with its count as the tooltip. */
export function stateBarChart(bar: readonly { readonly state: ItemState; readonly count: number }[]): SvgNode {
  const total = bar.reduce((s, b) => s + b.count, 0);
  const w = 300;
  const h = 14;
  const title = `States: ${bar.map((b) => `${b.count} ${labelOf(ITEM_STATE_OPTIONS, b.state)}`).join(', ') || 'no items'}`;
  let x = 0;
  const segs: SvgNode[] = total === 0
    ? [n('rect', { x: 0, y: 0, width: w, height: h, rx: 3, style: fill('var(--border)') })]
    : bar.filter((b) => b.count > 0).map((b) => {
      const width = (w * b.count) / total;
      const seg = n('rect', { x: x.toFixed(2), y: 0, width: width.toFixed(2), height: h, 'data-state': b.state, style: fill(STATE_COLORS[b.state]) },
        [n('title', {}, undefined, `${labelOf(ITEM_STATE_OPTIONS, b.state)}: ${b.count}`)]);
      x += width;
      return seg;
    });
  return n('svg', { viewBox: `0 0 ${w} ${h}`, width: '100%', height: h, preserveAspectRatio: 'none', role: 'img', 'aria-label': title, style: 'display:block;border-radius:3px' },
    [n('title', {}, undefined, title), ...segs]);
}

// ---------------------------------------------------------------------------
// The wave timeline (A.8.4 chart 1)
// ---------------------------------------------------------------------------

export interface TimelineMilestone {
  readonly date: string;
  /** 'T-14', 'G2' … */
  readonly label: string;
  readonly title: string;
  readonly kind: 'comms-gate' | 'gate' | 'kit' | 'hypercare';
}

export interface TimelineWave {
  readonly wave: number;
  readonly label: string;
  readonly plannedStart?: string;
  readonly plannedEnd?: string;
  readonly actualStart?: string;
  readonly actualEnd?: string;
  readonly gates: readonly { readonly gate: GateId; readonly at: string; readonly decision: GateDecision }[];
  readonly decomDue: readonly string[];
  readonly milestones: readonly TimelineMilestone[];
}

/** The dates the chart spans: every bar, milestone, freeze, gate and tick, plus today. */
export function timelineSpan(waves: readonly TimelineWave[], freezes: readonly FreezeWindow[], today: string): { first: string; last: string } | undefined {
  const days: string[] = [today];
  for (const w of waves) {
    for (const d of [w.plannedStart, w.plannedEnd, w.actualStart, w.actualEnd]) if (d) days.push(d.slice(0, 10));
    for (const g of w.gates) days.push(g.at.slice(0, 10));
    for (const d of w.decomDue) days.push(d.slice(0, 10));
    for (const m of w.milestones) days.push(m.date.slice(0, 10));
  }
  for (const fr of freezes) days.push(fr.from.slice(0, 10), fr.to.slice(0, 10));
  const valid = days.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (valid.length === 0) return undefined;
  return { first: valid[0] as string, last: valid[valid.length - 1] as string };
}

/**
 * Waves on a date axis: the planned bar (outline), the actual bar (first
 * replicate to last validate, filled), gate diamonds (green go, red no-go),
 * T-minus milestones (small ticks with labels on hover), hatched freeze
 * windows across every row, decommission-due ticks and a line for today.
 */
export function timelineChart(waves: readonly TimelineWave[], freezes: readonly FreezeWindow[], today: string): SvgNode {
  const rowH = 34;
  const f: Frame = { w: 640, h: 44 + rowH * Math.max(1, waves.length) + 30, left: 64, right: 12, top: 24, bottom: 30 };
  const title = 'Wave timeline: planned and actual windows, gates, T-minus milestones and freezes';
  const span = timelineSpan(waves, freezes, today);
  if (!span || waves.length === 0) return frameSvg(f, title, [n('text', { x: f.w / 2, y: f.h / 2, 'text-anchor': 'middle', style: TEXT }, undefined, 'No waves to chart yet.')]);
  const d0 = dayNum(span.first) - 1;
  const d1 = dayNum(span.last) + 1;
  const xOf = (d: string): number => f.left + (plotW(f) * (dayNum(d) - d0)) / Math.max(1, d1 - d0);
  const children: SvgNode[] = [
    n('defs', {}, [n('pattern', { id: 'atk-hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
      [n('line', { x1: 0, y1: 0, x2: 0, y2: 6, style: 'stroke:var(--warn);stroke-width:2;opacity:0.45' })])]),
  ];
  // Month-ish ticks across the top.
  const allDays: string[] = [];
  for (let d = d0 + 1; d <= d1 - 1; d += 1) allDays.push(new Date(d * DAY).toISOString().slice(0, 10));
  for (const t of dayTicks(allDays, 6)) {
    const x = xOf(t.day);
    children.push(n('line', { x1: x, x2: x, y1: f.top - 4, y2: f.h - f.bottom, style: 'stroke:var(--border);stroke-width:1' }));
    children.push(n('text', { x, y: f.top - 8, 'text-anchor': 'middle', style: TEXT }, undefined, t.day));
  }
  // Freeze windows: hatching over every row.
  for (const fr of freezes) {
    const x = xOf(fr.from);
    const w = Math.max(2, xOf(fr.to) - x);
    children.push(n('rect', { x, y: f.top, width: w, height: rowH * waves.length, 'data-mark': 'freeze', style: 'fill:url(#atk-hatch)' },
      [n('title', {}, undefined, `Freeze ${fr.from} to ${fr.to}${fr.reason ? `: ${fr.reason}` : ''}`)]));
  }
  waves.forEach((w, i) => {
    const y = f.top + i * rowH;
    const mid = y + rowH / 2;
    children.push(n('text', { x: 4, y: mid + 4, style: TEXT_STRONG }, undefined, `Wave ${w.wave}`));
    if (w.plannedStart && w.plannedEnd) {
      const x = xOf(w.plannedStart);
      children.push(n('rect', { x, y: y + 6, width: Math.max(3, xOf(w.plannedEnd) - x + 2), height: rowH - 12, rx: 3, 'data-mark': 'planned', style: 'fill:var(--accent-dim);stroke:var(--accent);stroke-width:1' },
        [n('title', {}, undefined, `Wave ${w.wave} planned: ${w.label}`)]));
    }
    if (w.actualStart) {
      const x = xOf(w.actualStart);
      const end = w.actualEnd ?? today;
      children.push(n('rect', { x, y: y + 12, width: Math.max(3, xOf(end) - x + 2), height: rowH - 24, rx: 2, 'data-mark': 'actual', style: fill('var(--ok)') },
        [n('title', {}, undefined, `Wave ${w.wave} actual: ${w.actualStart.slice(0, 10)} to ${w.actualEnd ? w.actualEnd.slice(0, 10) : 'now'}`)]));
    }
    for (const m of w.milestones) {
      const x = xOf(m.date);
      const color = m.kind === 'gate' ? 'var(--accent)' : m.kind === 'hypercare' ? 'var(--ok)' : 'var(--text-faint)';
      children.push(n('line', { x1: x, x2: x, y1: y + 3, y2: y + 9, 'data-mark': 'milestone', style: `stroke:${color};stroke-width:1.5` },
        [n('title', {}, undefined, `${m.label} ${m.date}: ${m.title}`)]));
    }
    for (const d of w.decomDue) {
      const x = xOf(d);
      children.push(n('line', { x1: x, x2: x, y1: y + rowH - 9, y2: y + rowH - 2, 'data-mark': 'decom', style: 'stroke:var(--danger);stroke-width:2' },
        [n('title', {}, undefined, `Decommission due ${d}`)]));
    }
    for (const g of w.gates) {
      const x = xOf(g.at.slice(0, 10));
      const s = 5;
      children.push(n('path', { d: `M${x} ${mid - s} L${x + s} ${mid} L${x} ${mid + s} L${x - s} ${mid} Z`, 'data-mark': 'gate', style: `${fill(GATE_COLOR[g.decision])};stroke:var(--bg);stroke-width:1` },
        [n('title', {}, undefined, `${g.gate} ${g.decision === 'go' ? 'Go' : 'No go'} ${g.at.slice(0, 10)}`)]));
    }
  });
  const tx = xOf(today);
  children.push(n('line', { x1: tx, x2: tx, y1: f.top - 2, y2: f.top + rowH * waves.length, 'data-mark': 'today', style: 'stroke:var(--text);stroke-width:1;stroke-dasharray:3 3' }, [n('title', {}, undefined, `Today ${today}`)]));
  // Legend.
  const ly = f.h - 10;
  const keys: { label: string; node: (x: number) => SvgNode }[] = [
    { label: 'Planned', node: (x) => n('rect', { x, y: ly - 9, width: 14, height: 10, style: 'fill:var(--accent-dim);stroke:var(--accent)' }) },
    { label: 'Actual', node: (x) => n('rect', { x, y: ly - 9, width: 14, height: 10, style: fill('var(--ok)') }) },
    { label: 'Gate', node: (x) => n('path', { d: `M${x + 7} ${ly - 10} L${x + 12} ${ly - 5} L${x + 7} ${ly} L${x + 2} ${ly - 5} Z`, style: fill('var(--ok)') }) },
    { label: 'Freeze', node: (x) => n('rect', { x, y: ly - 9, width: 14, height: 10, style: 'fill:url(#atk-hatch);stroke:var(--warn)' }) },
    { label: 'Decom due', node: (x) => n('line', { x1: x + 7, x2: x + 7, y1: ly - 10, y2: ly, style: 'stroke:var(--danger);stroke-width:2' }) },
  ];
  let lx = f.left;
  for (const k of keys) {
    children.push(k.node(lx), n('text', { x: lx + 18, y: ly, style: TEXT }, undefined, k.label));
    lx += 30 + k.label.length * 6;
  }
  return frameSvg(f, title, children);
}
