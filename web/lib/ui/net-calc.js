/**
 * The network calculator: opened from the Network calculator button beside
 * Clear list in a page's build list, it is a panel with four tabs — Subnet,
 * Split, VLSM and Check. Every tab takes IPv4 or IPv6.
 */

import { el, replace } from './dom.js';
import { formatCidr, formatIPv4, parseIPv4, prefixToMask } from '../core/net.js';
import {
  addressClass,
  binaryOf,
  hexOf,
  hostsFor,
  subnetBitmap,
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
} from '../core/net-calc.js';

                                                 

const input = (placeholder        , value = '')                   => {
  const node = el('input', { attrs: { type: 'text', placeholder, spellcheck: 'false' } })                    ;
  node.value = value;
  return node;
};

const table = (head                   , rows                                           )              =>
  el(
    'div',
    { class: 'table-wrap netcalc-table' },
    el('table', { class: 'data-table' }, el('thead', {}, el('tr', {}, ...head.map((h) => el('th', { text: h })))), el('tbody', {}, ...rows.map((r) => el('tr', {}, ...r.map((c) => el('td', { text: String(c) })))))),
  );

const pairs = (list                                                 )              =>
  el('dl', { class: 'netcalc-pairs' }, ...list.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: String(v) })]));

const problem = (text        )              => el('p', { class: 'netcalc-error', text });

/** Copies the rows of the last table as tab-separated text, for a spreadsheet or a ticket. */
function copyButton(getText              )              {
  const b = el('button', { class: 'btn btn-small', text: 'Copy', attrs: { type: 'button' } })                     ;
  b.addEventListener('click', () => {
    void navigator.clipboard?.writeText(getText()).then(() => {
      b.textContent = 'Copied';
      setTimeout(() => (b.textContent = 'Copy'), 1200);
    });
  });
  return b;
}

/** A labelled select filled from [value, label] pairs. */
function selectOf(options                                        , value        )                    {
  const s = el('select')                     ;
  for (const [v, l] of options) {
    const o = el('option', { text: l, attrs: { value: v } })                     ;
    if (v === value) o.selected = true;
    s.appendChild(o);
  }
  return s;
}

const field = (label        , node             )              => el('div', { class: 'netcalc-field' }, el('label', { class: 'netcalc-label', text: label }), node);

/**
 * The classic subnet calculator: an address, its network class (or a parent
 * of your own), and five linked dropdowns — mask, subnet bits, mask bits,
 * maximum subnets, hosts per subnet. Changing any one moves the others.
 */
function subnetV4()              {
  let address = parseIPv4('10.20.30.40') ;
  let parent = 8;
  let prefix = 22;
  const form = el('div', { class: 'netcalc-form' });
  const out = el('div', { class: 'netcalc-out' });
  const listOut = el('div', { class: 'netcalc-out' });
  const ipBox = input('e.g. 10.20.30.40', '10.20.30.40');

  const render = ()       => {
    const cls = addressClass(address);
    const parentOptions                     = [
      ...(cls.cls === 'A' || cls.cls === 'B' || cls.cls === 'C' ? [[String(cls.prefix), `Class ${cls.cls} (/${cls.prefix}) — first octet ${cls.range}`]                    ] : []),
      ...Array.from({ length: 32 }, (_, i) => [String(i), `Custom parent /${i}`]                    ).filter(([v]) => !(cls.cls <= 'C' && v === String(cls.prefix))),
    ];
    if (prefix < parent) prefix = parent;
    const masks = Array.from({ length: 33 - parent }, (_, i) => parent + i);
    const mk = (fmt                       )                     => masks.map((p) => [String(p), fmt(p)]);
    const pSel = selectOf(parentOptions, String(parent));
    const maskSel = selectOf(mk((p) => `${formatIPv4(prefixToMask(p))}  (/${p})`), String(prefix));
    const sbSel = selectOf(mk((p) => String(p - parent)), String(prefix));
    const mbSel = selectOf(mk((p) => String(p)), String(prefix));
    const maxSel = selectOf(mk((p) => (2 ** (p - parent)).toLocaleString()), String(prefix));
    const hostsSel = selectOf(mk((p) => hostsFor(p).toLocaleString()), String(prefix));
    pSel.addEventListener('change', () => {
      parent = Number(pSel.value);
      render();
    });
    for (const s of [maskSel, sbSel, mbSel, maxSel, hostsSel]) {
      s.addEventListener('change', () => {
        prefix = Number(s.value);
        render();
      });
    }
    replace(
      form,
      field('IP address', ipBox),
      field('Network class', pSel),
      field('Subnet mask', maskSel),
      field('Subnet bits', sbSel),
      field('Mask bits', mbSel),
      field('Maximum subnets', maxSel),
      field('Hosts per subnet', hostsSel),
    );

    const c = { network: (address & prefixToMask(prefix)) >>> 0, prefix };
    const d = describeSubnet(`${formatIPv4(address)}/${prefix}`)                                                      ;
    const parentNet = { network: (address & prefixToMask(parent)) >>> 0, prefix: parent };
    replace(
      out,
      pairs([
        ['Subnet ID', formatCidr(c)],
        ['Host address range', `${d.firstHost} – ${d.lastHost}`],
        ['Broadcast', d.broadcast],
        ['Subnet mask', `${d.netmask}  (/${prefix})`],
        ['Wildcard mask', d.wildcard],
        ['Usable hosts', d.usable.toLocaleString()],
        ['Subnets in the network', `${(2 ** (prefix - parent)).toLocaleString()} in ${formatCidr(parentNet)}`],
        ['Subnet bitmap', subnetBitmap(parent, prefix)],
        ['Address type', d.kind],
        ['Hex address', hexOf(address)],
        ['Binary address', binaryOf(address)],
        ['Reverse DNS zone', d.reverseZone],
      ]),
      el('div', { class: 'btn-row' }, el('button', { class: 'btn btn-small btn-primary', text: 'List all subnets', attrs: { type: 'button' }, on: { click: () => list(parentNet) } })),
    );
    replace(listOut);
  };

  const list = (parentNet                                     )       => {
    const r = splitSubnet(formatCidr(parentNet), { prefix });
    if (typeof r === 'string') return replace(listOut, problem(r));
    const rows = r.rows.map((x, i) => {
      const net = parseIPv4(x.cidr.split('/')[0] ) ;
      const bc = prefix >= 31 ? '—' : formatIPv4((net + 2 ** (32 - prefix) - 1) >>> 0);
      return [i + 1, x.cidr, x.firstHost, x.lastHost, bc];
    });
    const text = rows.map((row) => row.join('\t')).join('\n');
    replace(
      listOut,
      el('p', { class: 'muted', text: `${r.total.toLocaleString()} subnets of /${prefix} in ${formatCidr(parentNet)}${r.total > 1024 ? ' — the first 1,024 listed' : ''}.` }),
      table(['#', 'Subnet ID', 'First host', 'Last host', 'Broadcast'], rows),
      copyButton(() => text),
    );
  };

  ipBox.addEventListener('input', () => {
    const v = parseIPv4(ipBox.value.trim());
    if (v === null) return replace(out, problem(`"${ipBox.value}" is not an IPv4 address.`));
    const before = addressClass(address);
    address = v;
    // Moving to another class moves the parent with it, unless a custom parent was chosen.
    const now = addressClass(address);
    if (parent === before.prefix && now.cls <= 'C') parent = now.prefix;
    render();
    ipBox.focus();
  });
  render();
  return el('div', { class: 'netcalc-tab' }, form, out, listOut);
}

/** The same questions for IPv6: an address, a prefix, and subnetting it into longer prefixes. */
function subnetV6()              {
  const ipBox = input('e.g. 2001:db8:abcd:12::1', '2001:db8:abcd:12::1');
  const common = new Set([32, 40, 44, 48, 52, 56, 60, 64, 112, 126, 127, 128]);
  const prefixSel = selectOf(Array.from({ length: 129 }, (_, i) => [String(i), `/${i}${common.has(i) ? ' •' : ''}`]                    ), '48');
  const intoSel = selectOf(Array.from({ length: 129 }, (_, i) => [String(i), `/${i}${common.has(i) ? ' •' : ''}`]                    ), '64');
  const out = el('div', { class: 'netcalc-out' });
  const listOut = el('div', { class: 'netcalc-out' });
  const run = ()       => {
    const d = describeIPv6(`${ipBox.value.trim()}/${prefixSel.value}`);
    if (typeof d === 'string') return replace(out, problem(d));
    replace(
      out,
      pairs([
        ['Network', d.network],
        ['First address', d.network.split('/')[0] ],
        ['Last address', d.last],
        ['Addresses', `2^${128 - d.prefix}`],
        ['/64 subnets inside', d.subnets64],
        ['Address (compressed)', d.compressed],
        ['Address (expanded)', d.expanded],
        ['Address type', d.kind],
      ]),
      el('div', { class: 'btn-row' }, el('button', { class: 'btn btn-small btn-primary', text: 'List the subnets', attrs: { type: 'button' }, on: { click: list } })),
    );
    replace(listOut);
  };
  const list = ()       => {
    const d = describeIPv6(`${ipBox.value.trim()}/${prefixSel.value}`);
    if (typeof d === 'string') return;
    const r = splitSubnet6(d.network, { prefix: Number(intoSel.value) });
    if (typeof r === 'string') return replace(listOut, problem(r));
    const rows = r.rows.map((x, i) => [i + 1, x.cidr, x.first, x.last]);
    replace(
      listOut,
      el('p', { class: 'muted', text: `${r.total.toLocaleString()} subnets of /${intoSel.value} in ${d.network}${r.total > 1024n ? ' — the first 1,024 listed' : ''}.` }),
      table(['#', 'Subnet', 'First address', 'Last address'], rows),
      copyButton(() => rows.map((row) => row.join('\t')).join('\n')),
    );
  };
  ipBox.addEventListener('input', run);
  prefixSel.addEventListener('change', run);
  intoSel.addEventListener('change', () => replace(listOut));
  run();
  return el(
    'div',
    { class: 'netcalc-tab' },
    el('div', { class: 'netcalc-form' }, field('IPv6 address', ipBox), field('Prefix length', prefixSel), field('Subnet it into', intoSel)),
    out,
    listOut,
    el('p', { class: 'muted', text: '• marks the usual sizes: /48 a site, /56 a small site, /64 a LAN (SLAAC needs it), /127 a point-to-point link.' }),
  );
}

function subnetTab()              {
  const body = el('div');
  const v4 = el('button', { class: 'netcalc-family is-active', text: 'IPv4', attrs: { type: 'button' } });
  const v6 = el('button', { class: 'netcalc-family', text: 'IPv6', attrs: { type: 'button' } });
  const pick = (six         )       => {
    v4.classList.toggle('is-active', !six);
    v6.classList.toggle('is-active', six);
    replace(body, six ? subnetV6() : subnetV4());
  };
  v4.addEventListener('click', () => pick(false));
  v6.addEventListener('click', () => pick(true));
  pick(false);
  return el('div', { class: 'netcalc-tab' }, el('div', { class: 'netcalc-families' }, v4, v6), body);
}

function splitTab()              {
  const net = input('10.0.0.0/16 or 2001:db8::/48', '10.0.0.0/22');
  const mode = el('select')                     ;
  for (const [v, l] of [
    ['prefix', 'into subnets of prefix'],
    ['count', 'into this many subnets'],
  ])
    mode.appendChild(el('option', { text: l, attrs: { value: v } }));
  const n = input('24', '24');
  const out = el('div', { class: 'netcalc-out' });
  let lastText = '';
  const run = ()       => {
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

function vlsmTab()              {
  const parent = input('10.10.0.0/22 or 2001:db8:100::/56', '10.10.0.0/22');
  const needs = el('textarea', { attrs: { rows: '6', spellcheck: 'false', placeholder: 'name | hosts, one per line' } })                       ;
  needs.value = ['management | 60', 'vmotion | 120', 'vsan | 120', 'edge uplink | 2', 'nsx tep | 200'].join('\n');
  const out = el('div', { class: 'netcalc-out' });
  let lastText = '';
  const run = ()       => {
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

function checkTab()              {
  const net = input('10.0.0.0/16 or 2001:db8::/32', '10.0.0.0/16');
  const addr = input('10.0.4.7 or 2001:db8:5::7', '10.0.4.7');
  const a = input('10.0.0.0/16', '10.0.0.0/16');
  const b = input('10.0.128.0/20', '10.0.128.0/20');
  const list = el('textarea', { attrs: { rows: '4', spellcheck: 'false', placeholder: 'One network per line' } })                       ;
  list.value = ['10.1.0.0/24', '10.1.1.0/24', '10.1.3.0/24'].join('\n');
  const inOut = el('p', { class: 'netcalc-answer' });
  const overOut = el('p', { class: 'netcalc-answer' });
  const superOut = el('p', { class: 'netcalc-answer' });
  const run = ()       => {
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

const TABS                                                         = [
  ['subnet', 'Subnet', subnetTab],
  ['split', 'Split', splitTab],
  ['vlsm', 'VLSM', vlsmTab],
  ['check', 'Check', checkTab],
];

export function openCalculator()       {
  const existing = document.querySelector                   ('dialog.netcalc');
  if (existing) {
    existing.showModal();
    return;
  }
  const body = el('div', { class: 'netcalc-body' });
  const tabBar = el('div', { class: 'netcalc-tabs', attrs: { role: 'tablist' } });
  const show = (tab     )       => {
    for (const b of tabBar.querySelectorAll('button')) b.classList.toggle('is-active', b.getAttribute('data-tab') === tab);
    replace(body, TABS.find(([id]) => id === tab) [2]());
    (body.querySelector('input, textarea')                      )?.focus();
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
  )                     ;
  // A click on the backdrop closes it.
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
  document.body.appendChild(dialog);
  show('subnet');
  dialog.showModal();
}
