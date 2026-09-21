/**
 * The sizing page's "from your estate" panel.
 *
 * Choose which source clusters are in scope, where the management domain comes
 * from, what host the target runs on and the few ratios that decide the host
 * counts; the plan recomputes on every change, writes the management domain
 * into the sizing form below it, and lays the workload domains out beside the
 * result. Every control is a dropdown or a checkbox: each has a small, known
 * set of sensible answers.
 */

import { el, replace } from './dom.js';
import { card, checkbox, field, numberInput, select, stat, statGrid, table, findingsList } from './components.js';
import { formatCapacityGib, formatCount } from '../core/units.js';
                                                        
                                                              
import {
  hostProfiles,
  planEstate,
  sourceClusters,
  suggestManagementSource,
                      
                  
                      
                     
} from '../vcf/estate-plan.js';

                                
                              
                     
                                                                             
                                                 
 

const RATIOS = ['2', '3', '4', '5', '6', '8'];
const CEILINGS = ['0.8', '0.85', '0.9', '0.95'];
const GROWTH = ['0', '0.1', '0.2', '0.3', '0.5'];

export function buildEstatePlanner(inventory           , onChange            )                {
  const sources = sourceClusters(inventory).filter((c) => c.name !== '(standalone)' || c.vmCount > 0);
  const profiles = hostProfiles(inventory.hosts);
  const suggested = suggestManagementSource(sources);

  const bind =                        (node   )    => {
    node.addEventListener('change', onChange);
    return node;
  };

  const management = bind(
    select(
      [
        { value: 'new', label: 'New hosts (greenfield management domain)' },
        ...sources
          .filter((c) => c.hostCount > 0)
          .map((c) => ({
            value: c.key,
            label: `Converge ${c.name} — ${c.hostCount} hosts${c.vcenter ? `, ${c.vcenter.split('.')[0]}` : ''}${c.looksLikeManagement ? ' (management)' : ''}`,
          })),
      ],
      suggested,
    ),
  );
  const hostChoice = bind(
    select(
      profiles.map((p, i) => ({ value: String(i), label: `${p.label} (${p.count} in estate)` })),
      '0',
    ),
  );
  const raw = bind(numberInput(0, { min: 0, step: 1024 }));
  const grouping = bind(
    select                (
      [
        { value: 'vcenter', label: 'One workload domain per source vCenter' },
        { value: 'datacenter', label: 'One workload domain per source datacenter' },
        { value: 'single', label: 'One workload domain for everything' },
      ],
      'vcenter',
    ),
  );
  const ratio = bind(select(RATIOS.map((r) => ({ value: r, label: `${r} : 1` })), '4'));
  const ceiling = bind(select(CEILINGS.map((c) => ({ value: c, label: `${Math.round(Number(c) * 100)}%` })), '0.9'));
  const growth = bind(select(GROWTH.map((g) => ({ value: g, label: `${Math.round(Number(g) * 100)}%` })), '0.2'));
  const basis = bind(
    select                        (
      [
        { value: 'used', label: 'Consumed (thin)' },
        { value: 'provisioned', label: 'Provisioned (thick)' },
      ],
      'used',
    ),
  );
  const storage = bind(
    select                                (
      [
        { value: 'same-as-source', label: 'Same as each source cluster' },
        { value: 'vsan-esa', label: 'vSAN ESA' },
        { value: 'vsan-osa', label: 'vSAN OSA' },
        { value: 'vmfs-fc', label: 'VMFS on FC' },
        { value: 'nfs', label: 'NFS' },
      ],
      'same-as-source',
    ),
  );
  const poweredOff = checkbox('Count powered-off VMs’ CPU and memory too', false);
  bind(poweredOff.input);

  // --- scope: every source cluster, grouped by vCenter ------------------------
  const boxes = new Map                          ();
  const byVcenter = new Map                         ();
  for (const c of sources) {
    const v = c.vcenter ?? '(no vCenter)';
    (byVcenter.get(v) ?? byVcenter.set(v, []).get(v) ).push(c);
  }
  const scopeList = el('div', { class: 'scope-list' });
  for (const [vcenter, clusters] of [...byVcenter.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    scopeList.appendChild(el('div', { class: 'scope-vcenter', text: vcenter }));
    for (const c of clusters.sort((a, b) => a.name.localeCompare(b.name))) {
      const box = el('input', { attrs: { type: 'checkbox' } })                    ;
      box.checked = true;
      bind(box);
      boxes.set(c.key, box);
      scopeList.appendChild(
        el(
          'label',
          {},
          box,
          el('span', { text: c.name }),
          el('span', {
            class: 'muted',
            text: `${c.hostCount} hosts · ${formatCount(c.poweredOnVmCount)} VMs on · ${formatCount(Math.round(c.vcpu))} vCPU`,
          }),
        ),
      );
    }
  }
  const setAll = (on         ) => () => {
    for (const box of boxes.values()) box.checked = on;
    onChange();
  };

  const panel = card(
    'From your estate',
    field('Management domain', management, 'A cluster named for management is suggested; converging keeps its VMs where they are.'),
    field('Target host', hostChoice, 'The host profiles already in the estate, most common first.'),
    field('Raw vSAN capacity per target host (GiB)', raw, 'Leave 0 when the target uses external storage or the figure is not known yet.'),
    field('Workload domains', grouping),
    el(
      'div',
      { class: 'field-row' },
      field('vCPU per core', ratio),
      field('Memory to use', ceiling),
      field('Growth', growth),
    ),
    el('div', { class: 'field-row' }, field('Storage basis', basis), field('Workload storage', storage)),
    el('div', { class: 'field' }, poweredOff.wrap),
    el(
      'div',
      { class: 'field' },
      el('label', { class: 'field-label', text: `Source clusters in scope (${sources.length})` }),
      el(
        'div',
        { class: 'btn-row', style: { marginBottom: 'var(--space-2)' } },
        el('button', { class: 'btn btn-small', text: 'All', on: { click: setAll(true) } }),
        el('button', { class: 'btn btn-small', text: 'None', on: { click: setAll(false) } }),
      ),
      scopeList,
    ),
  );

  function targetHost()           {
    const p = profiles[Number(hostChoice.value)] ?? profiles[0];
    return {
      cpuSockets: p?.cpuSockets ?? 2,
      coresPerCpu: p?.coresPerCpu ?? 32,
      hyperthreading: p?.hyperthreading ?? true,
      ramGib: p?.ramGib ?? 1024,
      rawStorageGib: Math.max(0, Number(raw.value) || 0),
    };
  }

  function plan()             {
    const selected = [...boxes.entries()].filter(([, b]) => b.checked).map(([k]) => k);
    return planEstate(inventory, {
      selected: selected.length > 0 ? selected : ['(none)'],
      managementSource: management.value,
      host: targetHost(),
      cpuRatio: Number(ratio.value),
      memoryCeiling: Number(ceiling.value),
      growth: Number(growth.value),
      storageBasis: basis.value                          ,
      workloadStorage: storage.value                                  ,
      grouping: grouping.value                  ,
      includePoweredOff: poweredOff.input.checked,
    });
  }

  return {
    panel,
    plan,
    managementCluster: () => sources.find((c) => c.key === management.value),
  };
}

/** The fleet laid out: domains, their clusters, and what decided each. */
export function fleetCard(plan            )              {
  const rows                                                              = [];
  for (const d of plan.domains) for (const c of d.clusters) rows.push({ domain: d.name, cluster: c, kind: d.kind });
  const newHosts = plan.workloadHosts + (plan.management.path === 'greenfield' ? plan.management.hostCount : 0);
  const BIND                                            = {
    cpu: 'CPU',
    memory: 'memory',
    storage: 'storage',
    minimum: 'minimum',
  };
  const body = el('div', {});
  replace(
    body,
    statGrid(
      stat({ label: 'Workload domains', value: plan.domains.length - 1, sub: `${rows.length - 1} clusters` }),
      stat({ label: 'New hosts', value: formatCount(newHosts), sub: `${formatCount(plan.sourceHosts)} in scope today` }),
      stat({ label: 'Physical cores', value: formatCount(plan.physicalCores) }),
      stat({
        label: 'Billable cores',
        value: formatCount(plan.billableCores),
        tone: plan.billableCores > plan.physicalCores ? 'warn' : 'ok',
        sub: '16-core per-CPU minimum',
      }),
    ),
    el(
      'div',
      { style: { marginTop: 'var(--space-4)' } },
      table(
        [
          { header: 'Domain', render: (r) => r.domain },
          { header: 'Cluster', render: (r) => r.cluster.name + (r.cluster.part ? ` (${r.cluster.part.n}/${r.cluster.part.of})` : '') },
          { header: 'vCPU', numeric: true, render: (r) => formatCount(Math.round(r.cluster.vcpu)) },
          { header: 'RAM', numeric: true, render: (r) => formatCapacityGib(r.cluster.ramGib) },
          { header: 'Storage', numeric: true, render: (r) => formatCapacityGib(r.cluster.storageGib) },
          { header: 'On', render: (r) => r.cluster.storage },
          {
            header: 'Hosts',
            numeric: true,
            render: (r) =>
              r.kind === 'management'
                ? String(r.cluster.hosts)
                : el('span', {
                    text: String(r.cluster.hosts),
                    attrs: {
                      title: `CPU needs ${r.cluster.byCpu}, memory ${r.cluster.byMemory}${r.cluster.byStorage ? `, storage ${r.cluster.byStorage}` : ''}, minimum ${r.cluster.minimum}`,
                    },
                  }),
          },
          { header: 'Set by', render: (r) => (r.kind === 'management' ? 'sizing below' : BIND[r.cluster.binding]) },
          { header: 'Today', numeric: true, render: (r) => (r.cluster.sourceHosts ? String(r.cluster.sourceHosts) : '—') },
        ],
        rows,
      ),
    ),
    el('div', { style: { marginTop: 'var(--space-4)' } }, findingsList(plan.findings)),
    el('div', {
      class: 'section-note',
      text: 'Demand includes the growth allowance. Hover a host count for what CPU, memory and storage each needed; the largest, plus one host for failure, sets it. The management domain is sized by the form and results below.',
    }),
  );
  return card('VCF fleet from the estate', body);
}
