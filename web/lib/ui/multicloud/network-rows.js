/**
 * The network row editor: one cloud's networks and subnets, built by the user
 * row by row. Shared by Landing zones (Migration & Utilities) and the
 * wizard's step 6 Foundation (Application Migration), over the same stored
 * list (`plan.networks[<cloud>]`).
 *
 * The toolkit makes no choice here. Every closed field is a dropdown that
 * opens on "Select…"; the IPv4 base address is typed (or "next free in the
 * network"). Rows are added, removed and reordered. Nothing is created,
 * carved, sized or suggested: an empty list means no network, and a blocking
 * finding says so. Next to each row: the checks (overlap, outside the
 * network, size limits, Azure's platform subnet sizes, a zone on a regional
 * cloud, a field not answered), and for a subnet its range and the addresses
 * it leaves after the cloud's reservation. A read-only hint shows the hosts
 * per tier from the inventory; it is never applied.
 */

import { el, append, clear } from '../dom.js';
                                                      
import {
  CLOUD_NETWORK, NETWORK_ENV_CHOICES, blankNetworkRow, blankSubnetRow, cloudNetworksOf, moveRow, networkPrefixChoices, regionChoices,
  rowPath, subnetName, subnetPrefixChoices, subnetZoneChoices, withCloudNetworks,                             
} from '../../multicloud/plan/design/net-rows.js';
import { CLOUD_SIGN_IN_TEXT, extendsAd, dcNamesFor, identityKey } from '../../multicloud/plan/design/identity.js';
import { PLATFORM_LABELS } from '../../multicloud/plan/options.js';
                                                                                                                              

                                       
                              
                            
                                                 
                                                                                   
                                                                                                     
                                                                                 
                                         
                                                                                              
                                             
                            
 

const SELECT = 'Select…';
const TIER_LABEL                                   = { web: 'web', app: 'app', db: 'data', mgmt: 'management', batch: 'batch' };

function selectEl(value        , choices                   , onChange                     , key        , label        )                    {
  const node = el('select', { attrs: { 'data-key': key, 'aria-label': label }, style: { minWidth: '7rem' } })                     ;
  append(node, el('option', { text: SELECT, attrs: { value: '' } }));
  for (const c of choices) append(node, el('option', { text: c.label, attrs: { value: c.value } }));
  if (value && !choices.some((c) => c.value === value)) append(node, el('option', { text: `${value} (not offered)`, attrs: { value } }));
  node.value = value;
  node.addEventListener('change', () => onChange(node.value));
  return node;
}

function textEl(value        , onChange                     , key        , label        , placeholder = '', width = '8rem')                   {
  const node = el('input', { attrs: { type: 'text', 'data-key': key, 'aria-label': label, placeholder, spellcheck: 'false' }, style: { minWidth: width } })                    ;
  node.value = value;
  node.addEventListener('change', () => onChange(node.value.trim()));
  return node;
}

function iconButton(text        , title        , onClick            , key        , disabled = false)                    {
  return el('button', { class: 'btn btn-small', text, attrs: { type: 'button', title, 'aria-label': title, 'data-key': key, disabled }, on: { click: onClick } })                     ;
}

const findingLine = (f         )              =>
  el('div', { class: `small ${f.severity === 'error' ? 'net-row-error' : f.severity === 'warning' ? 'net-row-warn' : 'muted'}`, text: f.message.replace(/^\w+: /, '') });

/** The editor. `refresh` redraws it from the plan (keeping the focused field). */
export function networkEditor(o                      )                                                  {
  const p = o.platform;
  const facts = CLOUD_NETWORK[p];
  const node = el('div', { class: 'stack net-rows', attrs: { 'data-control': o.control ?? `net-rows-${p}`, 'data-platform': p } });

  const rows = ()                   => cloudNetworksOf(o.plan(), p);
  const save = (next                  )       => o.edit((plan) => withCloudNetworks(plan, p, next));
  const setNet = (id        , patch                     )       => {
    const r = rows();
    save({ ...r, networks: r.networks.map((n) => (n.id === id ? { ...n, ...patch } : n)) });
  };
  const setSub = (id        , patch                    )       => {
    const r = rows();
    save({ ...r, subnets: r.subnets.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
  };

  const draw = ()       => {
    const focused = (document.activeElement                      )?.getAttribute?.('data-key') ?? null;
    const plan = o.plan();
    const r = rows();
    const d = o.design();
    const byPath = new Map                   ();
    for (const f of d.findings) {
      if (!f.path?.startsWith(`net:${p}:`)) continue;
      byPath.set(f.path, [...(byPath.get(f.path) ?? []), f]);
    }
    const general = byPath.get(rowPath(p, '')) ?? [];
    const resolved = new Map((d.design?.networks ?? []).flatMap((n) => n.subnets.map((s) => [s.id, { s, n }]         )));
    const netChoices           = r.networks.map((n, i) => ({ value: n.id, label: n.name.trim() || `${facts.kind} row ${i + 1}` }));
    const regions = regionChoices(p).map((x) => ({ value: x, label: x }));

    clear(node);
    append(node, el('p', { class: 'small' },
      el('strong', { text: `Networks (${facts.kind}) and subnets on ${PLATFORM_LABELS[p]}. ` }),
      `Add each network your network team assigned to this cloud, then its subnets. Nothing is filled in for you; every choice starts on "${SELECT}". ${facts.regional ? `${PLATFORM_LABELS[p]} subnets are regional: one subnet serves every zone.` : 'AWS subnets are zonal: each lives in one Availability Zone.'} Each subnet loses ${facts.reserved} addresses to the cloud (${facts.source}).`,
      o.regions ? ` Regions for this cloud: ${o.regions().join(', ') || 'none set'}.` : ''));

    // The hint.
    const hint = o.hint?.();
    if (hint && hint.total > 0) {
      append(node, el('div', { class: 'tip', attrs: { 'data-control': `net-hint-${p}` } },
        el('strong', { text: 'Hosts in this plan on this cloud (a hint for sizing; never applied): ' }),
        Object.entries(hint.byTier).map(([t, n]) => `${TIER_LABEL[t] ?? t} ${n}`).join(', '), '.'));
    }

    // General findings (no network; a platform subnet a service needs).
    if (general.length > 0) append(node, el('div', { attrs: { 'data-control': `net-blocking-${p}` } }, ...general.map((f) => el('div', { class: `tip ${f.severity === 'error' ? 'warn' : ''}`, text: f.message }))));

    // Networks.
    const netRows = r.networks.map((n, i) => {
      const k = (f        )         => `n:${n.id}:${f}`;
      const checks = byPath.get(rowPath(p, n.id)) ?? [];
      return el('tr', { attrs: { 'data-row': n.id } },
        el('td', { class: 'num', text: String(i + 1) }),
        el('td', {}, textEl(n.name, (v) => setNet(n.id, { name: v }), k('name'), 'Network name', 'your name')),
        el('td', {}, selectEl(n.role, facts.roles, (v) => setNet(n.id, { role: v                       }), k('role'), 'Role')),
        el('td', {}, p === 'vmware'
          ? textEl(n.region, (v) => setNet(n.id, { region: v }), k('region'), 'vCenter', 'vCenter FQDN', '10rem')
          : selectEl(n.region, regions, (v) => setNet(n.id, { region: v }), k('region'), 'Region')),
        el('td', {}, selectEl(n.env, NETWORK_ENV_CHOICES, (v) => setNet(n.id, { env: v                      }), k('env'), 'Environment')),
        el('td', {}, selectEl(n.state, [{ value: 'new', label: 'New' }, { value: 'existing', label: 'Existing (attach)' }], (v) => setNet(n.id, { state: v                        }), k('state'), 'New or existing'),
          n.state === 'existing' ? textEl(n.existingId ?? '', (v) => setNet(n.id, { existingId: v }), k('existing'), 'Existing id', p === 'aws' ? 'tgw-… (hub) or vpc-…' : p === 'azure' ? '/subscriptions/…/virtualNetworks/…' : p === 'google' ? 'projects/…/global/networks/…' : 'ocid1.drg…', '12rem') : null),
        el('td', {}, textEl(n.base, (v) => setNet(n.id, { base: v }), k('base'), 'IPv4 base address', 'e.g. 10.40.0.0')),
        el('td', {}, selectEl(n.prefix ? String(n.prefix) : '', networkPrefixChoices(p).map((x) => ({ value: String(x), label: `/${x}` })), (v) => setNet(n.id, { prefix: Number(v) || 0 }), k('prefix'), 'Prefix')),
        el('td', {}, selectEl(n.ipv6, [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }], (v) => setNet(n.id, { ipv6: v                       }), k('ipv6'), 'IPv6')),
        el('td', { style: { minWidth: '14rem' } }, ...(checks.length > 0 ? checks.map(findingLine) : [el('span', { class: 'small net-row-ok', text: 'OK' })])),
        el('td', { style: { whiteSpace: 'nowrap' } },
          iconButton('↑', 'Move up', () => save({ ...rows(), networks: moveRow(rows().networks, n.id, -1) }), k('up'), i === 0),
          iconButton('↓', 'Move down', () => save({ ...rows(), networks: moveRow(rows().networks, n.id, 1) }), k('down'), i === r.networks.length - 1),
          iconButton('✕', 'Remove this network (and its subnets)', () => save({ networks: rows().networks.filter((x) => x.id !== n.id), subnets: rows().subnets.filter((s) => s.network !== n.id) }), k('remove'))),
      );
    });
    append(node,
      el('h3', { text: `Networks (${facts.kind})`, style: { margin: 'var(--space-3) 0 var(--space-2)' } }),
      r.networks.length === 0
        ? el('p', { class: 'small muted', attrs: { 'data-control': `net-none-${p}` }, text: 'No network yet.' })
        : el('div', { class: 'table-wrap' }, el('table', { attrs: { 'data-control': `net-networks-${p}` } },
          el('thead', {}, el('tr', {}, ...['#', 'Name', 'Role', p === 'vmware' ? 'vCenter' : 'Region', 'Environment', 'New / existing', 'IPv4 base', 'Prefix', 'IPv6', 'Checks', ''].map((h) => el('th', { text: h })))),
          el('tbody', {}, ...netRows))),
      el('div', { class: 'btn-row' }, iconButton('+ Add network', `Add a ${facts.kind}`, () => save({ ...rows(), networks: [...rows().networks, blankNetworkRow()] }), `add-network-${p}`)),
    );

    // Subnets.
    const subRows = r.subnets.map((s, i) => {
      const k = (f        )         => `s:${s.id}:${f}`;
      const parent = r.networks.find((n) => n.id === s.network);
      const checks = byPath.get(rowPath(p, s.id)) ?? [];
      const res = resolved.get(s.id);
      return el('tr', { attrs: { 'data-row': s.id } },
        el('td', { class: 'num', text: String(i + 1) }),
        el('td', {}, selectEl(s.network, netChoices, (v) => setSub(s.id, { network: v }), k('network'), 'Network')),
        el('td', {}, textEl(s.name, (v) => setSub(s.id, { name: v }), k('name'), 'Subnet name', s.purpose ? subnetName(p, s) : 'optional')),
        el('td', {}, selectEl(s.purpose, facts.purposes, (v) => setSub(s.id, { purpose: v }), k('purpose'), 'Purpose')),
        el('td', {}, selectEl(s.zone, subnetZoneChoices(p, parent?.region ?? ''), (v) => setSub(s.id, { zone: v }), k('zone'), 'Zone')),
        el('td', {}, selectEl(s.prefix ? String(s.prefix) : '', subnetPrefixChoices(p).map((x) => ({ value: String(x), label: `/${x}` })), (v) => setSub(s.id, { prefix: Number(v) || 0 }), k('prefix'), 'Prefix')),
        el('td', { style: { whiteSpace: 'nowrap' } },
          textEl(s.base, (v) => setSub(s.id, { base: v.toLowerCase() === 'next' ? 'next' : v }), k('base'), 'IPv4 address, or next', 'address or next'),
          iconButton('Next free', 'The next free block in the network, after the rows above', () => setSub(s.id, { base: 'next' }), k('next'))),
        el('td', {}, selectEl(s.ipv6, [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }], (v) => setSub(s.id, { ipv6: v                      }), k('ipv6'), 'IPv6')),
        el('td', { class: 'num', attrs: { 'data-control': `net-subnet-result-${s.id}` } }, res
          ? el('div', {}, el('div', { text: res.s.cidr }), el('div', { class: 'small muted', text: `${res.s.usable} usable (${facts.reserved} reserved)${res.s.ipv6Cidr ? ` · ${res.s.ipv6Cidr}` : res.s.ipv6 ? ' · IPv6 /64 by the cloud' : ''}` }))
          : el('span', { class: 'small muted', text: '—' })),
        el('td', { style: { minWidth: '14rem' } }, ...(checks.length > 0 ? checks.map(findingLine) : res ? [el('span', { class: 'small net-row-ok', text: 'OK' })] : [])),
        el('td', { style: { whiteSpace: 'nowrap' } },
          iconButton('↑', 'Move up', () => save({ ...rows(), subnets: moveRow(rows().subnets, s.id, -1) }), k('up'), i === 0),
          iconButton('↓', 'Move down', () => save({ ...rows(), subnets: moveRow(rows().subnets, s.id, 1) }), k('down'), i === r.subnets.length - 1),
          iconButton('✕', 'Remove this subnet', () => save({ ...rows(), subnets: rows().subnets.filter((x) => x.id !== s.id) }), k('remove'))),
      );
    });
    append(node,
      el('h3', { text: 'Subnets', style: { margin: 'var(--space-3) 0 var(--space-2)' } }),
      r.subnets.length === 0
        ? el('p', { class: 'small muted', text: r.networks.length === 0 ? 'Add a network first.' : 'No subnet yet.' })
        : el('div', { class: 'table-wrap' }, el('table', { attrs: { 'data-control': `net-subnets-${p}` } },
          el('thead', {}, el('tr', {}, ...['#', 'Network', 'Name', 'Purpose', facts.regional ? 'Zone (regional)' : 'Zone', 'Prefix', 'IPv4', 'IPv6', 'Range · usable', 'Checks', ''].map((h) => el('th', { text: h })))),
          el('tbody', {}, ...subRows))),
      el('div', { class: 'btn-row' }, iconButton('+ Add subnet', 'Add a subnet', () => save({ ...rows(), subnets: [...rows().subnets, blankSubnetRow(rows().networks.length === 1 ? rows().networks[0] .id : '')] }), `add-subnet-${p}`, r.networks.length === 0)),
    );

    // Identity on this cloud: domain controllers only when the user extends AD here and names them.
    if (p !== 'vmware') {
      const strategy = plan.requirements.identity.adStrategy;
      const extend = plan.designOverrides[identityKey(p, 'extend-ad')] ?? '';
      const setOverride = (key        , v        )       => o.edit((cur) => {
        const overrides = { ...cur.designOverrides };
        if (v.trim() === '') delete overrides[key];
        else overrides[key] = v.trim();
        return { ...cur, designOverrides: overrides };
      });
      append(node, el('h3', { text: `Identity on ${PLATFORM_LABELS[p]}`, style: { margin: 'var(--space-3) 0 var(--space-2)' } }));
      if (strategy === 'extend-dcs') {
        append(node, el('div', { class: 'field-row', attrs: { 'data-control': `net-identity-${p}` } },
          el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Extend Active Directory into this cloud' }),
            selectEl(extend, [{ value: 'yes', label: 'Yes: domain controllers here' }, { value: 'no', label: 'No' }], (v) => setOverride(identityKey(p, 'extend-ad'), v), `id:${p}:extend`, 'Extend AD into this cloud')),
          extendsAd(plan, p)
            ? el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Domain controller names (your naming convention)' }),
              textEl(dcNamesFor(plan, p).join(', '), (v) => setOverride(identityKey(p, 'dc-names'), v), `id:${p}:dcs`, 'Domain controller names', 'e.g. your names, comma-separated', '14rem'))
            : null));
      }
      append(node, el('p', { class: 'small muted', attrs: { 'data-control': `net-identity-text-${p}` }, text: strategy === 'extend-dcs' && extendsAd(plan, p)
        ? `Domain controllers are built only with the names you give, in a management subnet you added.`
        : strategy === 'managed-ad'
          ? `A managed directory is used (chosen in the plan's identity); no domain controller is built.`
          : `Sign-in is ${CLOUD_SIGN_IN_TEXT[p]}; nothing is built for identity.` }));
    }

    if (focused) {
      const again = node.querySelector             (`[data-key="${CSS.escape(focused)}"]`);
      again?.focus();
    }
  };

  draw();
  let last = JSON.stringify(rows()) + JSON.stringify(o.design().findings.map((f) => f.message));
  return {
    node,
    refresh: () => {
      const now = JSON.stringify(rows()) + JSON.stringify(o.design().findings.map((f) => f.message)) + JSON.stringify(o.plan().designOverrides[identityKey(p, 'extend-ad')] ?? '');
      if (now === last) return;
      last = now;
      draw();
    },
  };
}
