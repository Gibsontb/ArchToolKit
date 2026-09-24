/**
 * The network calculator: a button in the header of every page, beside Clear
 * all, that opens a panel with four tabs — Subnet, Split, VLSM and Check.
 * Every tab takes IPv4 or IPv6 and works out which from what is typed.
 *
 * Every page loads this module; it mounts itself into `.app-header`.
 */

import { el, replace } from './dom.ts';
import {
  checkContains,
  checkContains6,
  checkOverlap,
  checkOverlap6,
  describeIPv6,
  describeSubnet,
  isV6,
  splitSubnet,
  splitSubnet6,
  supernet,
  supernet6,
  vlsm,
  vlsm6,
} from '../core/net-calc.ts';

type Tab = 'subnet' | 'split' | 'vlsm' | 'check';

const input = (placeholder: string, value = ''): HTMLInputElement => {
  const node = el('input', { attrs: { type: 'text', placeholder, spellcheck: 'false' } }) as HTMLInputElement;
  node.value = value;
  return node;
};

const table = (head: readonly string[], rows: readonly (readonly (string | number)[])[]): HTMLElement =>
  el(
    'div',
    { class: 'table-wrap netcalc-table' },
    el('table', { class: 'data-table' }, el('thead', {}, el('tr', {}, ...head.map((h) => el('th', { text: h })))), el('tbody', {}, ...rows.map((r) => el('tr', {}, ...r.map((c) => el('td', { text: String(c) })))))),
  );

const pairs = (list: readonly (readonly [string, string | number])[]): HTMLElement =>
  el('dl', { class: 'netcalc-pairs' }, ...list.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: String(v) })]));

const problem = (text: string): HTMLElement => el('p', { class: 'netcalc-error', text });

/** Copies the rows of the last table as tab-separated text, for a spreadsheet or a ticket. */
function copyButton(getText: () => string): HTMLElement {
  const b = el('button', { class: 'btn btn-small', text: 'Copy', attrs: { type: 'button' } }) as HTMLButtonElement;
  b.addEventListener('click', () => {
    void navigator.clipboard?.writeText(getText()).then(() => {
      b.textContent = 'Copied';
      setTimeout(() => (b.textContent = 'Copy'), 1200);
    });
  });
  return b;
}

function subnetTab(): HTMLElement {
  const box = input('10.20.30.40/22, 10.20.30.40 255.255.252.0, or 2001:db8::1/48', '10.20.30.40/22');
  const out = el('div', { class: 'netcalc-out' });
  const run = (): void => {
    const text = box.value.trim();
    if (isV6(text)) {
      const d = describeIPv6(text);
      replace(out, typeof d === 'string' ? problem(d) : pairs([['Network', d.network], ['Compressed', d.compressed], ['Expanded', d.expanded], ['Last address', d.last], ['/64 subnets inside', d.subnets64], ['Type', d.kind]]));
      return;
    }
    const d = describeSubnet(text);
    if (typeof d === 'string') return replace(out, problem(d));
    replace(
      out,
      pairs([
        ['Network', d.cidr],
        ['Netmask', `${d.netmask} (/${d.prefix})`],
        ['Wildcard', d.wildcard],
        ['First usable', d.firstHost],
        ['Last usable', d.lastHost],
        ['Broadcast', d.broadcast],
        ['Usable hosts', d.usable.toLocaleString()],
        ['Total addresses', d.total.toLocaleString()],
        ['Type', d.kind],
        ['Reverse DNS zone', d.reverseZone],
        ['Next subnet', d.next ?? 'none — end of the address space'],
        ['Mask in binary', d.binaryMask],
      ]),
      d.hostBitsSet ? el('p', { class: 'muted', text: `${d.address} is a host address; the network it is in is ${d.cidr}.` }) : null,
    );
  };
  box.addEventListener('input', run);
  run();
  return el('div', { class: 'netcalc-tab' }, el('label', { class: 'netcalc-label', text: 'Address and prefix or mask' }), box, out);
}

function splitTab(): HTMLElement {
  const net = input('10.0.0.0/16 or 2001:db8::/48', '10.0.0.0/22');
  const mode = el('select') as HTMLSelectElement;
  for (const [v, l] of [
    ['prefix', 'into subnets of prefix'],
    ['count', 'into this many subnets'],
  ])
    mode.appendChild(el('option', { text: l, attrs: { value: v } }));
  const n = input('24', '24');
  const out = el('div', { class: 'netcalc-out' });
  let lastText = '';
  const run = (): void => {
    const value = Number(n.value.replace(/^\//, ''));
    const by = mode.value === 'count' ? { count: value } : { prefix: value };
    if (isV6(net.value)) {
      const r = splitSubnet6(net.value, by);
      if (typeof r === 'string') return replace(out, problem(r));
      lastText = r.rows.map((x) => [x.cidr, x.first, x.last].join('\t')).join('\n');
      replace(out, el('p', { class: 'muted', text: `${r.total.toLocaleString()} subnet${r.total === 1n ? '' : 's'}${r.total > 1024n ? ', the first 1,024 listed' : ''}.` }), table(['Subnet', 'First address', 'Last address'], r.rows.map((x) => [x.cidr, x.first, x.last])), copyButton(() => lastText));
      return;
    }
    const r = splitSubnet(net.value, by);
    if (typeof r === 'string') return replace(out, problem(r));
    lastText = r.rows.map((x) => [x.cidr, x.firstHost, x.lastHost, x.usable].join('\t')).join('\n');
    replace(out, el('p', { class: 'muted', text: `${r.total.toLocaleString()} subnet${r.total === 1 ? '' : 's'}${r.total > 1024 ? ', the first 1,024 listed' : ''}.` }), table(['Subnet', 'First usable', 'Last usable', 'Usable'], r.rows.map((x) => [x.cidr, x.firstHost, x.lastHost, x.usable.toLocaleString()])), copyButton(() => lastText));
  };
  for (const node of [net, mode, n]) node.addEventListener('input', run);
  mode.addEventListener('change', run);
  run();
  return el('div', { class: 'netcalc-tab' }, el('label', { class: 'netcalc-label', text: 'Network to split' }), net, el('div', { class: 'netcalc-row' }, mode, n), out);
}

function vlsmTab(): HTMLElement {
  const parent = input('10.10.0.0/22 or 2001:db8:100::/56', '10.10.0.0/22');
  const needs = el('textarea', { attrs: { rows: '6', spellcheck: 'false', placeholder: 'name | hosts, one per line' } }) as HTMLTextAreaElement;
  needs.value = ['management | 60', 'vmotion | 120', 'vsan | 120', 'edge uplink | 2', 'nsx tep | 200'].join('\n');
  const out = el('div', { class: 'netcalc-out' });
  let lastText = '';
  const run = (): void => {
    const list = needs.value
      .split('\n')
      .map((l) => l.split('|').map((c) => c.trim()))
      .filter((c) => c[0] || c[1])
      .map(([name = '', hosts = '']) => ({ name, hosts: Number(hosts) }));
    if (isV6(parent.value)) {
      const r = vlsm6(parent.value, list);
      if (typeof r === 'string') return replace(out, problem(r));
      lastText = r.rows.map((x) => [x.name, x.needed, x.cidr].join('\t')).join('\n');
      replace(out, table(['Name', 'Needs', 'Subnet', 'First', 'Last'], r.rows.map((x) => [x.name, x.needed, x.cidr, x.first, x.last])), ...r.unallocated.map(problem), el('p', { class: 'muted', text: 'LANs get a /64 (SLAAC needs it); two-host links get a /127.' }), copyButton(() => lastText));
      return;
    }
    const r = vlsm(parent.value, list);
    if (typeof r === 'string') return replace(out, problem(r));
    lastText = r.rows.map((x) => [x.name, x.needed, x.cidr, x.firstHost, x.lastHost].join('\t')).join('\n');
    replace(out, table(['Name', 'Needs', 'Subnet', 'First usable', 'Last usable', 'Usable'], r.rows.map((x) => [x.name, x.needed, x.cidr, x.firstHost, x.lastHost, x.usable])), ...r.unallocated.map(problem), el('p', { class: 'muted', text: r.free ? `Still free: ${r.free}` : 'Nothing left over.' }), copyButton(() => lastText));
  };
  parent.addEventListener('input', run);
  needs.addEventListener('input', run);
  run();
  return el('div', { class: 'netcalc-tab' }, el('label', { class: 'netcalc-label', text: 'Allocate from' }), parent, el('label', { class: 'netcalc-label', text: 'What you need (name | hosts), biggest are placed first' }), needs, out);
}

function checkTab(): HTMLElement {
  const net = input('10.0.0.0/16 or 2001:db8::/32', '10.0.0.0/16');
  const addr = input('10.0.4.7 or 2001:db8:5::7', '10.0.4.7');
  const a = input('10.0.0.0/16', '10.0.0.0/16');
  const b = input('10.0.128.0/20', '10.0.128.0/20');
  const list = el('textarea', { attrs: { rows: '4', spellcheck: 'false', placeholder: 'One network per line' } }) as HTMLTextAreaElement;
  list.value = ['10.1.0.0/24', '10.1.1.0/24', '10.1.3.0/24'].join('\n');
  const inOut = el('p', { class: 'netcalc-answer' });
  const overOut = el('p', { class: 'netcalc-answer' });
  const superOut = el('p', { class: 'netcalc-answer' });
  const run = (): void => {
    inOut.textContent = isV6(net.value) || isV6(addr.value) ? checkContains6(net.value, addr.value) : checkContains(net.value, addr.value);
    overOut.textContent = isV6(a.value) || isV6(b.value) ? checkOverlap6(a.value, b.value) : checkOverlap(a.value, b.value);
    const items = list.value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
    superOut.textContent = items.some(isV6) ? supernet6(items) : supernet(items);
  };
  for (const node of [net, addr, a, b, list]) node.addEventListener('input', run);
  run();
  return el(
    'div',
    { class: 'netcalc-tab' },
    el('label', { class: 'netcalc-label', text: 'Is this address inside this network?' }),
    el('div', { class: 'netcalc-row' }, net, addr),
    inOut,
    el('label', { class: 'netcalc-label', text: 'Do these two networks overlap?' }),
    el('div', { class: 'netcalc-row' }, a, b),
    overOut,
    el('label', { class: 'netcalc-label', text: 'The smallest network that covers all of these' }),
    list,
    superOut,
  );
}

const TABS: readonly (readonly [Tab, string, () => HTMLElement])[] = [
  ['subnet', 'Subnet', subnetTab],
  ['split', 'Split', splitTab],
  ['vlsm', 'VLSM', vlsmTab],
  ['check', 'Check', checkTab],
];

function openCalculator(): void {
  const existing = document.querySelector<HTMLDialogElement>('dialog.netcalc');
  if (existing) {
    existing.showModal();
    return;
  }
  const body = el('div', { class: 'netcalc-body' });
  const tabBar = el('div', { class: 'netcalc-tabs', attrs: { role: 'tablist' } });
  const show = (tab: Tab): void => {
    for (const b of tabBar.querySelectorAll('button')) b.classList.toggle('is-active', b.getAttribute('data-tab') === tab);
    replace(body, TABS.find(([id]) => id === tab)![2]());
    (body.querySelector('input, textarea') as HTMLElement | null)?.focus();
  };
  for (const [id, label] of TABS) {
    tabBar.appendChild(el('button', { class: 'netcalc-tab-btn', text: label, attrs: { type: 'button', role: 'tab', 'data-tab': id }, on: { click: () => show(id) } }));
  }
  const dialog = el(
    'dialog',
    { class: 'netcalc', attrs: { 'aria-label': 'Network calculator' } },
    el(
      'div',
      { class: 'netcalc-head' },
      el('strong', { text: 'Network calculator' }),
      el('span', { class: 'muted', text: 'IPv4 and IPv6' }),
      el('button', { class: 'tag-cat-x netcalc-close', text: '×', attrs: { type: 'button', 'aria-label': 'Close' }, on: { click: () => dialog.close() } }),
    ),
    tabBar,
    body,
  ) as HTMLDialogElement;
  // A click on the backdrop closes it.
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
  document.body.appendChild(dialog);
  show('subnet');
  dialog.showModal();
}

export function mountNetCalc(header: Element): HTMLButtonElement {
  const button = el('button', {
    class: 'btn btn-small btn-netcalc',
    text: 'Network calculator',
    attrs: { type: 'button', title: 'Subnets, splits, VLSM and overlap checks — IPv4 and IPv6', 'data-control': 'netcalc' },
    on: { click: openCalculator },
  }) as HTMLButtonElement;
  // Beside Clear all, which stays the last thing in the header.
  const clear = header.querySelector('[data-control="clear-all"]');
  if (clear) header.insertBefore(button, clear);
  else header.appendChild(button);
  return button;
}

const header = typeof document !== 'undefined' ? document.querySelector('.app-header') : null;
if (header && !header.querySelector('[data-control="netcalc"]')) mountNetCalc(header);
