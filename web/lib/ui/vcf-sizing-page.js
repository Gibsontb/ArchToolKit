/**
 * VCF 9.1 sizing calculator page.
 *
 * Left: the design inputs — target version, the fleet, the management domain,
 * vSAN, stretched clusters, memory tiering, growth, workload domains, manual
 * workload clusters, add-ons, licensing and a recovery site. Right: live
 * results from the engine — the per-appliance breakdown with the provenance of
 * each line, host minimums, capacity after failures, storage, licensing for one
 * instance and for the fleet, addresses, and every finding.
 *
 * The page only reads and writes controls; turning them into engine inputs is
 * `vcf-sizing-form.ts`, which is tested without a DOM.
 */

import { el, append, replace, downloadFile } from './dom.js';
import {
  card,
  field,
  findingsList,
  numberInput,
  select,
  checkbox,
  stat,
  statGrid,
  table,
} from './components.js';
import { tableEditor } from './multi-editors.js';
import { formatCapacityGib, formatCount, roundTo } from '../core/units.js';
                                                                                                                     
import { addFootprints, ZERO_FOOTPRINT,                            } from '../vcf/sizing-data.js';
import { putHandoff, takeHandoff, rememberLatest } from './handoff.js';
import { sizingToPlan, describeSizingHandoff, estateToPlan } from '../vcf/bridge.js';
import { mountEstateBar } from './estate-bar.js';
import { buildEstatePlanner, fleetCard,                    } from './estate-planner.js';
import { planEstate, sourceClusters,                 } from '../vcf/estate-plan.js';
                                                        
import {
  SIZING_FORM_DEFAULTS,
  VERSION_OPTIONS,
  PATH_OPTIONS,
  PROFILE_OPTIONS,
  TOPOLOGY_OPTIONS,
  STORAGE_OPTIONS,
  FAILURE_OPTIONS,
  EDGE_OPTIONS,
  AUTOMATION_SIZES,
  OSA_POLICIES,
  WITNESS_SIZES,
  NSX_MANAGER_SIZES_LIST,
  LOG_REPLICA_SIZES,
  OPS_NETWORKS_SIZES,
  AVI_SIZES,
  OPS_SIZES_LIST,
  OPS_COLLECTOR_SIZES_LIST,
  NIC_SPEEDS,
  INSTANCE_GRID,
  WORKLOAD_DOMAIN_GRID,
  WORKLOAD_CLUSTER_GRID,
  ESTATE_EXTRAS_DEFAULTS,
  estateOptions,
  formFromSizingInput,
  managementLines,
  sizeFromForm,
                    
                  
                
                     
} from './vcf-sizing-form.js';

/** The estate the page is planning from, for the spec builder handoff. */
let estate                                                                          = null;

                                                                          

                
                             
                                      
                            
 

/** The form: every control by key, the grids by key, and what shows or hides with what. */
                
                                             
                                       
                     
                                           
                                                                  
               
 

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------

export function mountVcfSizingPage(root             )       {
  /**
   * Serialized inputs from the last render, so an unchanged form is not redrawn.
   *
   * Controls fire both `input` and `change`, and `change` also fires on blur —
   * including the blur caused by clicking a button in the results pane. Redrawing
   * then destroys the very button being clicked, and the click is lost partway
   * through. Skipping a redraw that would change nothing removes that entirely.
   *
   * Declared before anything that can reach `render`, since a `let` is not
   * hoisted the way a function declaration is.
   */
  let lastRenderKey = '';
  /** The version, profile and failures the estate was last planned with. */
  let lastEstateKey = '';
  const resultsPane = el('div', { class: 'stack' });

  const form = buildForm(() => onChange());
  const estateSlot = el('div', { class: 'stack' });
  form.wrap.prepend(estateSlot);
  let plan                    = null;
  let planVersion = 0;
  let extras               = ESTATE_EXTRAS_DEFAULTS;

  const estateKey = (v            )         => `${v.version}|${v.profile}|${v.hostFailures}`;

  function onChange()       {
    form.sync();
    if (estate && estateKey(form.read()) !== lastEstateKey) {
      onPlanChange();
      return;
    }
    render();
  }

  function onPlanChange()       {
    if (!estate) return;
    const values = form.read();
    const base = estate.planner.plan();
    plan = planEstate(estate.inventory, estateOptions(base.options, extras, values));
    lastEstateKey = estateKey(values);
    planVersion += 1;
    form.write(formFromSizingInput(plan.management));
    form.sync();
    render();
  }

  // An inventory import can hand its derived sizing input straight over, so the
  // estate does not have to be described twice.
  const inbound = takeHandoff             ('inventory-to-sizing');
  if (inbound) {
    form.write(formFromSizingInput(inbound.payload));
    form.sync();
    append(
      root,
      el(
        'div',
        { class: 'section-note', style: { marginBottom: 'var(--space-4)' } },
        el('strong', { text: 'Prefilled from your inventory. ' }),
        el('span', { text: `${inbound.origin}. Every value below can still be changed.` }),
      ),
    );
  }

  append(root, el('div', { class: 'split' }, el('div', {}, form.wrap), resultsPane));

  function render()       {
    const values = form.read();
    const key = `${planVersion}|${JSON.stringify(values)}`;
    if (key === lastRenderKey) return;
    lastRenderKey = key;
    let outcome               ;
    try {
      outcome = sizeFromForm(values);
    } catch (err) {
      replace(resultsPane, card('Sizing failed', el('div', { class: 'finding is-error', text: String(err) })));
      return;
    }
    replace(resultsPane, ...(plan ? [fleetCard(plan)] : []), ...buildResults(outcome));
    // With an estate loaded, the spec builder follows this page: whatever was
    // sized last is what it opens on, without Continue having to be pressed.
    if (estate) {
      rememberLatest('sizing-to-spec', `${describeSizingHandoff(outcome.result)} — from ${estate.origin}`, {
        ...sizingToPlan(outcome.result),
        ...estateToPlan(estate.inventory, estate.planner.managementCluster()?.key),
      });
    }
  }

  form.sync();
  render();

  // The estate, when one has been imported — here or on any other page —
  // fills the form in: the management domain and workload domains below, the
  // planned clusters in the results.
  void mountEstateBar(root, {
    purpose: 'size the VCF fleet from it, cluster by cluster',
    onEstate: (entry) => {
      if (entry) {
        const planner = buildEstatePlanner(entry.inventory, onPlanChange);
        estate = { inventory: entry.inventory, planner, origin: entry.origin };
        extras = ESTATE_EXTRAS_DEFAULTS;
        const extrasCard = buildEstateExtras(entry.inventory, (next) => {
          extras = next;
          onPlanChange();
        });
        replace(estateSlot, planner.panel, extrasCard);
        onPlanChange();
      } else {
        estate = null;
        plan = null;
        planVersion += 1;
        replace(estateSlot);
        render();
      }
    },
  });
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

function buildForm(onChange            )                               {
  const controls                          = {};
  const grids                       = {};
  const d = SIZING_FORM_DEFAULTS;

  const bind =                    (key        , node   )    => {
    node.addEventListener('change', onChange);
    node.addEventListener('input', onChange);
    controls[key] = node;
    return node;
  };
  const num = (key        , attrs                                  = {})                   => {
    const node = numberInput(0, attrs);
    node.value = d[key] ?? '';
    return bind(key, node);
  };
  const sel = (key        , options                                             )                    =>
    bind(key, select(options                                      , d[key] ?? ''));
  const opts = (values                   , blank         )                                     => [
    ...(blank !== undefined ? [{ value: '', label: blank }] : []),
    ...values.map((v) => ({ value: v, label: v })),
  ];
  const chk = (key        , label        )              => {
    const c = checkbox(label, d[key] === 'true');
    bind(key, c.input);
    return el('div', { class: 'field' }, c.wrap);
  };
  const row = (...children               )              => el('div', { class: 'field-row' }, ...children);
  const note = (text        )              => el('div', { class: 'section-note', text });
  const grid = (key        , spec          )              => {
    const g = gridEditor(spec, d[key] ?? '', onChange);
    grids[key] = g;
    return g.wrap;
  };
  /** A collapsed section for inputs most designs leave at their defaults. */
  const section = (title        , open         , ...children               )              =>
    el(
      'details',
      { class: 'input-section', attrs: open ? { open: '' } : {} },
      el('summary', { text: title }),
      el('div', { class: 'input-section-list', style: { maxHeight: 'none' } }, ...children),
    );

  // --- target and management domain -------------------------------------------
  const deployment = card(
    'Target and management domain',
    row(field('Target version', sel('version', VERSION_OPTIONS)), field('Deployment path', sel('path', PATH_OPTIONS))),
    field('Profile', sel('profile', PROFILE_OPTIONS), 'HA-Small exists from 9.1.1 only.'),
    row(
      field('Hosts in management cluster', num('hostCount', { min: 1, max: 64 })),
      field('Host failures to tolerate', sel('hostFailures', FAILURE_OPTIONS)),
    ),
    row(
      field('Cluster topology', sel('topology', TOPOLOGY_OPTIONS), 'Two-node is not a VCF 9.1 management topology.'),
      field('Principal storage', sel('storage', STORAGE_OPTIONS), 'vSAN ESA or OSA sets the vSAN architecture.'),
    ),
    row(
      field('Target vCPU per physical core', num('targetCpuRatio', { min: 0.5, max: 16, step: 0.5 }), 'On the hosts left after failures. 2:1 is the design target.'),
      el('div', { class: 'field' }, chk('loadBalancer', 'Load balancer for VCF Operations (HA: one more FQDN)')),
    ),
  );

  // --- fleet ---------------------------------------------------------------------
  const fleet = card(
    'Fleet: additional VCF instances',
    note(
      'The form describes the first instance. Each row here is one more VCF instance with its own management domain on its own hosts. Leave Hosts blank for the smallest that works; blank Profile, Storage or Topology follows the first instance.',
    ),
    grid('instances', INSTANCE_GRID),
    chk('addDepot', 'Each additional instance runs its own Software Depot (9.1.1)'),
    chk('addIdentityBroker', 'Each additional instance runs its own Identity Broker (9.1.1)'),
  );

  // --- per-host hardware ------------------------------------------------------------
  const hardware = card(
    'Per-host hardware',
    row(field('CPU sockets', num('cpuSockets', { min: 1, max: 8 })), field('Cores per CPU', num('coresPerCpu', { min: 1, max: 256 }))),
    chk('hyperthreading', 'Hyperthreading enabled (not counted as capacity)'),
    row(field('RAM (GiB)', num('ramGib', { min: 16, step: 16 })), field('Raw vSAN storage (GiB)', num('rawStorageGib', { min: 0, step: 512 }))),
    row(
      field('Physical NICs per host', num('pnicsPerHost', { min: 1, max: 8 }), 'Sets the host TEP pool.'),
      field('NIC speed', sel('nicSpeedGbps', [{ value: '', label: 'Not set' }, ...NIC_SPEEDS.map((s) => ({ value: s, label: `${s} GbE` }))]), 'vSAN ESA on 10 GbE is ESA-AF-0 only.'),
    ),
  );

  // --- vSAN, stretched, tiering ---------------------------------------------------------
  const osaField = field('vSAN OSA storage policy', sel('osaPolicy', [{ value: '', label: 'Automatic (RAID-1 at 3 hosts, RAID-5 from 4)' }, ...OSA_POLICIES]));
  const vsan = section(
    'vSAN',
    false,
    osaField,
    row(
      field('Dedup and compression ratio', num('dedupRatio', { min: 1, max: 10, step: 0.1 }), '1 assumes none.'),
      field('Operations reserve (%)', num('operationsReservePct', { min: 0, max: 50 }), 'No 9.1 percentage is published; 0 adds none.'),
    ),
  );
  const stretched = section(
    'Stretched cluster',
    true,
    chk('reserveAzFailure', 'Reserve a whole availability zone (half the CPU and memory)'),
    row(
      field('Inter-AZ bandwidth (Gbps)', num('interAzBandwidthGbps', { min: 0 }), 'At least 10.'),
      field('Inter-AZ round trip (ms)', num('interAzRttMs', { min: 0, step: 0.5 }), 'Under 5.'),
    ),
    field('vSAN witness size', sel('witnessSize', opts(WITNESS_SIZES)), 'The witness runs at a third site.'),
  );
  const tieringFields = el(
    'div',
    { class: 'stack' },
    row(
      field('NVMe tier to DRAM ratio', num('tieringRatio', { min: 0.25, max: 4, step: 0.25 }), '1 = 1:1; up to 4.'),
      field('Active memory (%)', num('tieringActivePct', { min: 0, max: 100 })),
    ),
    chk('tieringNvmeShared', 'The tiering NVMe device is also a vSAN device'),
  );
  const tiering = section(
    'Memory tiering (NVMe)',
    false,
    chk('tiering', 'Enable memory tiering'),
    tieringFields,
    note('Applies to the management domain and to every workload cluster sized here. Management appliances are sized on DRAM.'),
  );

  // --- workloads, growth ---------------------------------------------------------------
  const tenant = card(
    'Tenant workloads on the management cluster',
    note('For a converged cluster: workloads that share the management domain’s hosts. Workload domains are below.'),
    row(field('vCPU', num('workloadVcpu', { min: 0 })), field('RAM (GiB)', num('workloadRamGib', { min: 0 }))),
    field('Capacity (GiB)', num('workloadCapacityGib', { min: 0, step: 100 }), 'Data to store, before RAID overhead.'),
  );
  const growth = section(
    'Growth',
    false,
    row(
      field('CPU per year (%)', num('growthCpuPct', { min: 0, max: 100 })),
      field('RAM per year (%)', num('growthRamPct', { min: 0, max: 100 })),
      field('Storage per year (%)', num('growthStoragePct', { min: 0, max: 100 })),
    ),
    field('Years', num('growthYears', { min: 0, max: 20 }), 'Compounded. Applies to tenant workloads, workload-domain VMs and clusters; the results show each year.'),
  );

  // --- workload domains and clusters --------------------------------------------------
  const domains = card(
    'Workload domains',
    note(
      'Each VI workload domain puts a vCenter and (unless NSX is shared) an NSX Manager cluster in its instance’s management domain. Instance: blank for the first, or an additional instance’s name. The edge cluster and Supervisor (VKS) control planes run in the domain’s first cluster below.',
    ),
    grid('workloadDomains', WORKLOAD_DOMAIN_GRID),
  );
  const clusters = card(
    'Workload clusters',
    note(
      'Size a cluster from its demand. Domain: a workload domain above, to place it there, or blank to size it on its own. Blank Hosts finds the smallest; blank host columns use the per-host hardware above. vCPU per core defaults to 4:1, failures to N+1.',
    ),
    grid('workloadClusters', WORKLOAD_CLUSTER_GRID),
  );

  // --- management options -------------------------------------------------------------
  const automationFields = row(
    field('VCF Automation size', sel('automationSize', opts(AUTOMATION_SIZES, 'Profile default'))),
    field('Nodes', sel('automationNodes', [{ value: '', label: 'Profile default' }, { value: '1', label: '1' }, { value: '3', label: '3' }])),
  );
  const edgeFields = row(field('Edge size', sel('edgeSize', EDGE_OPTIONS)), field('Edge nodes', num('edgeNodeCount', { min: 1, max: 10 })));
  const management = card(
    'Management components',
    chk('includeAutomation', 'Include VCF Automation (first instance only)'),
    automationFields,
    note('The published totals include the profile’s VCF Automation; a different size or node count adds or removes the difference, and excluding it takes it off.'),
    chk('includeEdge', 'NSX Edge cluster in the management domain'),
    edgeFields,
  );

  // --- add-ons ---------------------------------------------------------------------------
  const addOn = (key        , label        , ...fields               )                                                  => {
    const body = fields.length > 0 ? el('div', { class: 'stack', style: { marginLeft: 'var(--space-5)' } }, ...fields) : null;
    return { wrap: el('div', {}, chk(key, label), ...(body ? [body] : [])), body };
  };
  const addOns = [
    addOn(
      'addLog',
      'Log management',
      row(field('Replica size', sel('logReplicaSize', opts(LOG_REPLICA_SIZES))), field('Replicas', num('logReplicas', { min: 0, max: 19 }), 'Blank: from events per second.')),
      row(field('Events per second', num('logEps', { min: 0, step: 1000 })), field('GB per day', num('logDailyGib', { min: 0 })), field('Retention (days)', num('logRetentionDays', { min: 0 }))),
      chk('logNPlusOne', 'One spare replica (N+1)'),
    ),
    addOn('addRtm', 'Real-time metrics (6 addresses; compute unconfirmed)'),
    addOn(
      'addOpsNet',
      'VCF Operations for Networks',
      row(field('Platform size', sel('opsNetSize', opts(OPS_NETWORKS_SIZES))), field('Nodes', num('opsNetNodes', { min: 0, max: 15 }), 'Blank: 1, or 3 when a cluster is needed.')),
      row(field('VMs', num('opsNetVms', { min: 0 })), field('Flows', num('opsNetFlows', { min: 0, step: 100000 }))),
      row(
        field('Collectors', num('opsNetCollectors', { min: 0 }), 'Blank: 1.'),
        field('Collector size', sel('opsNetCollectorSize', opts(OPS_NETWORKS_SIZES, 'Same as platform'))),
      ),
    ),

    addOn(
      'addAvi',
      'Avi Load Balancer',
      row(field('Controller size', sel('aviSize', opts(AVI_SIZES))), field('Controllers', sel('aviNodes', [{ value: '3', label: '3' }, { value: '1', label: '1' }]))),
    ),
    addOn(
      'addPr',
      'Protection and Recovery',
      row(field('Protected VMs', num('prProtectedVms', { min: 0 })), field('Scale-out appliances', num('prScaleOut', { min: 0 }))),
    ),
    addOn(
      'addHcx',
      'HCX',
      row(field('Site pairs', num('hcxSitePairs', { min: 1 })), field('Network extension appliances', num('hcxNetworkExtensions', { min: 0 }))),
      chk('hcxWanOpt', 'WAN optimization'),
      chk('hcxSgw', 'Sentinel gateway'),
    ),
    addOn(
      'addOpsScale',
      'VCF Operations scale-out',
      row(field('Data nodes', num('opsDataNodes', { min: 0 })), field('Data node size', sel('opsDataNodeSize', opts(OPS_SIZES_LIST)))),
      row(field('Cloud proxies', num('opsCloudProxies', { min: 0 })), field('Cloud proxy size', sel('opsCloudProxySize', opts(OPS_COLLECTOR_SIZES_LIST)))),
    ),
  ];
  const addOnsCard = card(
    'Add-ons in the management domain',
    ...addOns.map((a) => a.wrap),
  );

  // --- licensing -------------------------------------------------------------------------
  const edgeSitesField = field('VCF Edge sites', num('edgeSites', { min: 0 }), 'At least 10.');
  const licensing = card(
    'Licensing options',
    chk('vcfEdge', 'License as VCF Edge (8-core per-CPU floor, 256 cores per site)'),
    row(edgeSitesField, field('Subscription years', num('subscriptionYears', { min: 0, max: 10 }), 'For core-years.')),
  );

  // --- recovery site ----------------------------------------------------------------------
  const drFields = el(
    'div',
    { class: 'stack' },
    row(field('Protected vCPU', num('drVcpu', { min: 0 })), field('Protected RAM (GiB)', num('drRamGib', { min: 0 }))),
    row(field('Protected storage (GiB)', num('drStorageGib', { min: 0, step: 100 })), field('Protected VMs', num('drVms', { min: 0 }))),
    row(
      field('CPU and memory held at recovery (%)', num('drReservePct', { min: 0, max: 100 }), 'Storage is always held in full.'),
      field('Recovery storage', sel('drStorage', STORAGE_OPTIONS)),
      field('Failures', sel('drHostFailures', FAILURE_OPTIONS)),
    ),
  );
  const dr = section(
    'Disaster recovery site',
    false,
    chk('dr', 'Size a recovery site (Protection and Recovery)'),
    drFields,
    note('The recovery cluster uses the per-host hardware above, and carries the Protection and Recovery appliance.'),
  );

  const wrap = el('div', { class: 'stack' }, deployment, fleet, hardware, card('Design options', vsan, stretched, tiering, growth, dr), tenant, domains, clusters, management, addOnsCard, licensing);

  const read = ()             => {
    const out             = {};
    for (const [key, c] of Object.entries(controls)) {
      out[key] = c instanceof HTMLInputElement && c.type === 'checkbox' ? String(c.checked) : c.value;
    }
    for (const [key, g] of Object.entries(grids)) out[key] = g.value.value;
    return out;
  };
  const write = (values                     )       => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) continue;
      const g = grids[key];
      if (g) {
        if (g.value.value !== value) g.reset(value);
        continue;
      }
      const c = controls[key];
      if (!c) continue;
      if (c instanceof HTMLInputElement && c.type === 'checkbox') c.checked = value === 'true';
      else c.value = value;
    }
  };
  const sync = ()       => {
    const v = read();
    show(osaField, v.storage === 'vsan-osa');
    show(vsan, v.storage === 'vsan-esa' || v.storage === 'vsan-osa');
    show(stretched, v.topology === 'stretched');
    show(tieringFields, v.tiering === 'true');
    show(automationFields, v.includeAutomation !== 'false');
    show(edgeFields, v.includeEdge === 'true');
    show(edgeSitesField, v.vcfEdge === 'true');
    show(drFields, v.dr === 'true');
    const keys = ['addLog', 'addRtm', 'addOpsNet', 'addAvi', 'addPr', 'addHcx', 'addOpsScale'];
    addOns.forEach((a, i) => {
      if (a.body) show(a.body, v[keys[i]          ] === 'true');
    });
  };

  return { wrap, controls, grids, read, write, sync };
}

/** Show or hide; `hidden` loses to the stylesheet's display rules. */
function show(node             , visible         )       {
  node.style.display = visible ? '' : 'none';
}

/** A grid of " | " rows (src/ui/multi-editors.ts), kept in a textarea the page reads like any control. */
function gridEditor(spec          , initial        , onChange            )       {
  const columns = spec.hint.split(' | ');
  const shape                                    = {
    separator: ' | ',
    columns,
    headerInValue: false,
    spaced: true,
    choices: columns.map((col) => {
      const offered = spec.options.filter((o) => o.group === col);
      return offered.length > 0 ? offered : undefined;
    }),
  };
  const value = el('textarea', { attrs: { hidden: true } })                       ;
  const host = el('div', {});
  const mount = (text        )       => {
    value.value = text;
    const editor = tableEditor(shape, text, () => {
      const inner = editor.querySelector('textarea.multi-value')                              ;
      value.value = inner?.value ?? '';
      onChange();
    });
    replace(host, editor);
  };
  mount(initial);
  return { wrap: el('div', {}, host, value), value, reset: mount };
}

/** The estate plan options the planner panel does not carry. */
function buildEstateExtras(inventory           , onChange                                )              {
  const arch = select                    (
    [
      { value: '', label: 'ESA (assumed; RVTools cannot tell)' },
      { value: 'esa', label: 'ESA' },
      { value: 'osa', label: 'OSA' },
    ],
    '',
  );
  const nsx = select                        (
    [
      { value: 'dedicated', label: 'Its own NSX Manager cluster per domain' },
      { value: 'shared', label: 'All but the first share one' },
    ],
    'dedicated',
  );
  const nsxSize = select(NSX_MANAGER_SIZES_LIST.map((s) => ({ value: s, label: s })), 'medium');
  const perCluster = new Map                           ();
  const rows = sourceClusters(inventory)
    .filter((c) => c.hostCount > 0 || c.vmCount > 0)
    .map((c) => {
      const s = select                  ([{ value: '', label: `As planned (${c.storage})` }, ...STORAGE_OPTIONS], '');
      perCluster.set(c.key, s);
      return field(`${c.name}${c.vcenter ? ` (${c.vcenter.split('.')[0]})` : ''}`, s);
    });
  const emit = ()       => {
    const clusterStorage                              = {};
    for (const [key, s] of perCluster) if (s.value) clusterStorage[key] = s.value               ;
    onChange({
      vsanArchitecture: arch.value                      ,
      nsxPerDomain: nsx.value                          ,
      nsxManagerSize: nsxSize.value                                  ,
      clusterStorage,
    });
  };
  for (const s of [arch, nsx, nsxSize, ...perCluster.values()]) s.addEventListener('change', emit);
  return card(
    'Estate plan: storage and NSX',
    field('vSAN clusters become', arch),
    el('div', { class: 'field-row' }, field('Workload-domain NSX', nsx), field('NSX Manager size', nsxSize)),
    el(
      'details',
      { class: 'input-section' },
      el('summary', { text: `Target storage per source cluster (${rows.length})` }),
      el('div', { class: 'input-section-list' }, ...rows),
    ),
    el('div', {
      class: 'section-note',
      text: 'The profile, target version and host failures come from the form below. The estate’s own growth allowance is applied to its demand; the Growth section adds to it.',
    }),
  );
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

const BASIS_TEXT                                                               = {
  published: { cls: 'badge badge-verified', label: 'Published', title: 'Broadcom publishes this figure' },
  derived: { cls: 'badge badge-community', label: 'Derived', title: 'Computed from published figures' },
  unconfirmed: { cls: 'badge badge-inferred', label: 'Unconfirmed', title: 'Not published for VCF 9.1; indicative only' },
};

function basisBadge(basis                   )              {
  const b = BASIS_TEXT[basis ?? 'unconfirmed'];
  return el('span', { class: b.cls, text: b.label, attrs: { title: b.title } });
}

function sourceLink(url                    , text = 'source')              {
  if (!url || !/^https?:\/\//.test(url)) return el('span', { class: 'muted', text: '—' });
  return el('a', { text, attrs: { href: url, target: '_blank', rel: 'noopener noreferrer' } });
}

const cores = (n        )         => `${formatCount(Math.round(n))}`;
const pct = (f                    )         => (f === undefined || !Number.isFinite(f) ? '—' : `${Math.round(f * 100)}%`);
const ratio = (r        )         => (Number.isFinite(r) ? `${roundTo(r, 2)} : 1` : '—');
const sum = (lines                          )            => lines.reduce((s, l) => addFootprints(s, l.footprint), ZERO_FOOTPRINT);
const spacer = ()              => el('div', { style: { marginTop: 'var(--space-4)' } });

function componentTable(lines                          , withNote = true)              {
  return table               (
    [
      { header: 'Component', render: (c) => c.name },
      { header: 'vCPU', numeric: true, render: (c) => formatCount(Math.round(c.footprint.vcpu)) },
      { header: 'RAM', numeric: true, render: (c) => formatCapacityGib(c.footprint.ramGib) },
      { header: 'Disk', numeric: true, render: (c) => formatCapacityGib(c.footprint.diskGib) },
      { header: 'Basis', render: (c) => basisBadge(c.basis) },
      { header: 'Source', render: (c) => sourceLink(c.sourceUrl) },
      ...(withNote ? [{ header: 'Note', render: (c               ) => el('span', { class: 'small muted', text: c.note ?? '' }) }] : []),
    ],
    lines,
  );
}

function buildResults(o               )                {
  const { result, fleet } = o;
  const { capacity, storage, licensing, ips, input, hostMinimum } = result;
  const errors = o.findings.filter((f) => f.severity === 'error').length;
  const warnings = o.findings.filter((f) => f.severity === 'warning').length;
  const many = fleet.instances.length > 1;
  const instanceName = (i        )         => (i === 0 ? 'instance 1 (first)' : (o.plan.instanceNames[i - 1] ?? `instance ${i + 1}`));

  // --- verdict ------------------------------------------------------------------
  const verdict = card(
    'Verdict',
    statGrid(
      stat({
        label: 'Status',
        value: errors > 0 ? 'Blocked' : warnings > 0 ? 'Review' : 'Viable',
        tone: errors > 0 ? 'danger' : warnings > 0 ? 'warn' : 'ok',
        sub: `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`,
      }),
      stat({
        label: 'Minimum hosts',
        value: hostMinimum.hosts,
        sub: `configured: ${input.hostCount}${hostMinimum.recommended ? `, ${hostMinimum.recommended} recommended` : ''}`,
        tone: input.hostCount >= hostMinimum.hosts ? 'ok' : 'danger',
      }),
      stat({
        label: 'Smallest viable cluster',
        value: o.recommendedHosts ?? '—',
        sub: 'hosts, with this hardware and everything placed here',
      }),
      stat({
        label: 'Fleet hosts',
        value: fleet.totals.hosts + o.clusters.reduce((s, c) => s + c.hosts, 0) + (o.recovery?.cluster.hosts ?? 0),
        sub: `${fleet.totals.instances} instance${fleet.totals.instances === 1 ? '' : 's'}, VCF ${result.release}`,
      }),
    ),
    el(
      'div',
      { class: 'section-note' },
      el('strong', { text: `Why ${hostMinimum.hosts}: ` }),
      el('span', { text: `${hostMinimum.source}${hostMinimum.note ? ` — ${hostMinimum.note}` : ''}. ` }),
      basisBadge(hostMinimum.basis),
      ' ',
      sourceLink(hostMinimum.sourceUrl),
    ),
  );

  // --- fleet ---------------------------------------------------------------------
  const cards                = [verdict];
  if (many || fleet.totals.workloadHosts > 0) {
    cards.push(
      card(
        'Fleet',
        statGrid(
          stat({ label: 'Instances', value: fleet.totals.instances }),
          stat({ label: 'Management hosts', value: fleet.totals.managementHosts }),
          stat({ label: 'Workload-domain hosts', value: fleet.totals.workloadHosts, sub: 'clusters sized in workload domains' }),
          stat({ label: 'Addresses', value: fleet.totals.ipsRecommended, sub: `recommended; ${formatCount(fleet.totals.ipsMinimum)} minimum` }),
        ),
        spacer(),
        table                                (
          [
            { header: 'Instance', render: (x) => instanceName(x.i) },
            { header: 'Role', render: (x) => x.r.role },
            { header: 'Profile', render: (x) => x.r.input.profile },
            { header: 'Storage', render: (x) => x.r.input.storage },
            { header: 'Hosts', numeric: true, render: (x) => String(x.r.input.hostCount) },
            { header: 'Minimum', numeric: true, render: (x) => String(x.r.hostMinimum.hosts) },
            { header: 'vCPU', numeric: true, render: (x) => formatCount(Math.round(x.r.totalDemand.vcpu)) },
            { header: 'RAM', numeric: true, render: (x) => formatCapacityGib(x.r.totalDemand.ramGib) },
            { header: 'vCPU : core', numeric: true, render: (x) => ratio(x.r.cpuRatio) },
            { header: 'Memory', numeric: true, render: (x) => pct(x.r.memoryUtilization) },
            { header: 'Domains', numeric: true, render: (x) => String(x.r.workloadDomains.length) },
            {
              header: 'Status',
              render: (x) => {
                const e = x.r.findings.filter((f) => f.severity === 'error').length;
                return el('span', { class: e > 0 ? 'badge danger' : 'badge good', text: e > 0 ? `${e} error${e === 1 ? '' : 's'}` : 'OK' });
              },
            },
          ],
          fleet.instances.map((r, i) => ({ r, i })),
        ),
        el('div', {
          class: 'section-note',
          text: 'Each instance is its own management domain on its own hosts. Additional instances carry no VCF Automation and fewer fleet services. The cards below are the first instance.',
        }),
      ),
    );
  }

  // --- the management domain: management vs tenant ----------------------------------
  const mgmtLines = managementLines(result);
  const mgmt = sum(mgmtLines);
  const tenantLine = result.components.find((c) => c.name === 'Tenant workloads');
  const tenant = tenantLine?.footprint ?? ZERO_FOOTPRINT;
  const target = input.targetCpuRatio ?? 2;
  const usable = capacity.usablePhysicalCores;
  const demand = card(
    'Management domain: what runs on it',
    statGrid(
      stat({
        label: 'Management components',
        value: `${formatCount(Math.round(mgmt.vcpu))} vCPU`,
        sub: `${formatCapacityGib(mgmt.ramGib)} RAM, ${formatCapacityGib(mgmt.diskGib)} disk`,
      }),
      stat({
        label: 'Tenant workloads (converged)',
        value: `${formatCount(Math.round(tenant.vcpu))} vCPU`,
        sub: `${formatCapacityGib(tenant.ramGib)} RAM, ${formatCapacityGib(input.workloadCapacityGib ?? 0)} data before growth`,
      }),
      stat({
        label: 'Total vCPU : core',
        value: ratio(result.cpuRatio),
        sub: `management alone ${ratio(usable > 0 ? mgmt.vcpu / usable : Number.POSITIVE_INFINITY)}; target ${target}:1`,
        fill: result.cpuRatio / target,
        tone: result.cpuRatio > target ? 'warn' : 'ok',
      }),
      stat({
        label: 'Total memory',
        value: formatCapacityGib(result.totalDemand.ramGib),
        sub: `${pct(result.memoryUtilization)} of ${formatCapacityGib(capacity.usableMemoryGib)} usable`,
        fill: result.memoryUtilization,
        tone: result.memoryUtilization > 1 ? 'danger' : result.memoryUtilization > 0.8 ? 'warn' : 'ok',
      }),
    ),
    spacer(),
    componentTable(result.components),
    el('div', {
      class: 'section-note',
      text: `The management plane is Broadcom’s published ${result.release} aggregate for a${result.role === 'first' ? ' first' : 'n additional'} instance, not a sum of per-appliance estimates. Workload-domain vCenters and NSX Managers, edges and add-ons are added to it; tenant workloads are shown apart. Where a live VCF Installer is reachable, POST /v1/sddcs/resources-calculation is authoritative.`,
    }),
  );
  cards.push(demand);

  // --- automation --------------------------------------------------------------------
  const a = result.automation;
  cards.push(
    card(
      'VCF Automation',
      statGrid(
        stat({ label: 'Included', value: a.applicable ? (a.included ? 'Yes' : 'No') : 'n/a', sub: a.applicable ? 'first instance' : 'additional instances carry none' }),
        stat({ label: 'Size', value: a.included ? `${a.size} × ${a.nodes}` : '—', sub: `profile default ${a.profileDefault.size} × ${a.profileDefault.nodes}` }),
        stat({
          label: 'Change to the total',
          value: `${a.delta.vcpu > 0 ? '+' : ''}${formatCount(Math.round(a.delta.vcpu))} vCPU`,
          sub: `${a.delta.ramGib > 0 ? '+' : ''}${formatCapacityGib(a.delta.ramGib)} RAM`,
        }),
      ),
      el('div', { class: 'section-note' }, 'Basis of the change: ', basisBadge(a.basis)),
    ),
  );

  // --- per-appliance breakdown ------------------------------------------------------------
  cards.push(
    card(
      'Per-appliance breakdown of the published total',
      componentTable(result.breakdown),
      el('div', {
        class: 'section-note',
        text: 'Where Broadcom publishes only the total, the split per appliance is derived or unconfirmed; the last line is what the published total holds beyond the listed appliances.',
      }),
    ),
  );

  // --- capacity ----------------------------------------------------------------------
  const tier = input.memoryTiering?.enabled === true;
  cards.push(
    card(
      'Capacity after failures',
      statGrid(
        stat({
          label: 'Surviving hosts',
          value: capacity.survivingHosts,
          sub: `of ${input.hostCount}: N+${capacity.hostFailuresReserved}${input.topology === 'stretched' && input.stretched?.reserveAzFailure !== false ? ', one AZ reserved' : ''} (${pct(capacity.haReserveFraction)} held back)`,
        }),
        stat({
          label: 'Physical cores',
          value: cores(capacity.usablePhysicalCores),
          sub: `usable of ${cores(capacity.physicalCores)}; ${cores(capacity.logicalProcessors)} logical (not counted)`,
        }),
        stat({
          label: tier ? 'Memory (DRAM + NVMe tier)' : 'Memory',
          value: formatCapacityGib(capacity.usableMemoryGib),
          sub: `usable of ${formatCapacityGib(capacity.totalRamGib)} DRAM${tier ? `; ${formatCapacityGib(capacity.usableRamGib)} DRAM usable` : ''}`,
        }),
        ...(result.dramUtilization !== undefined
          ? [
              stat({
                label: 'DRAM utilization',
                value: pct(result.dramUtilization),
                sub: 'appliances plus active workload memory',
                fill: result.dramUtilization,
                tone: result.dramUtilization > 1 ? 'danger' : result.dramUtilization > 0.8 ? 'warn' : 'ok',
              }),
            ]
          : []),
      ),
    ),
  );

  // --- storage -----------------------------------------------------------------------
  const external = !Number.isFinite(storage.availableRawGib);
  cards.push(
    card(
      'Storage',
      statGrid(
        stat({
          label: 'Architecture',
          value: external ? 'External' : storage.architecture === 'osa' ? 'vSAN OSA' : 'vSAN ESA',
          sub: `${storage.raid}, FTT=${storage.ftt}${storage.valid ? '' : ' — not valid on this host count'}`,
          tone: storage.valid ? 'neutral' : 'danger',
        }),
        stat({
          label: 'Raw required',
          value: formatCapacityGib(storage.rawRequiredGib),
          sub: `${formatCapacityGib(storage.required)} data × ${roundTo(storage.multiplier, 2)}${storage.dedupRatio > 1 ? ` ÷ ${storage.dedupRatio} dedup` : ''}`,
          tone: storage.sufficient ? 'ok' : 'danger',
        }),
        stat({
          label: 'Raw available',
          value: external ? 'Array' : formatCapacityGib(storage.availableRawGib),
          sub: external ? 'not vSAN-backed' : `after a ${formatCapacityGib(storage.rebuildReserveGib)} rebuild reserve`,
        }),
        stat({
          label: 'Effective capacity',
          value: external ? '—' : formatCapacityGib(storage.effectiveCapacityGib),
          sub: storage.slackFraction > 0 ? `with a ${pct(storage.slackFraction)} operations reserve` : 'no operations reserve added',
        }),
      ),
      el('div', { class: 'section-note' }, el('span', { text: `${storage.note} ` }), basisBadge(storage.basis)),
      ...(result.witness
        ? [
            spacer(),
            el('h3', { class: 'small', text: 'vSAN witness (third site, not in the cluster demand)' }),
            componentTable([result.witness]),
          ]
        : []),
    ),
  );

  // --- workload domains -----------------------------------------------------------------
  const allDomains = fleet.instances.flatMap((r, i) => r.workloadDomains.map((d) => ({ d, i })));
  if (allDomains.length > 0) {
    const allClusters = allDomains.flatMap(({ d, i }) => d.clusters.map((c) => ({ c, d: d.name, i })));
    cards.push(
      card(
        'Workload domains',
        table                                                           (
          [
            ...(many ? [{ header: 'Instance', render: (x               ) => instanceName(x.i) }] : []),
            { header: 'Domain', render: (x) => x.d.name },
            { header: 'vCenter', render: (x) => x.d.vcenterSize },
            { header: 'Hosts', numeric: true, render: (x) => String(x.d.hosts) },
            { header: 'Clusters', numeric: true, render: (x) => String(x.d.clusters.length) },
            { header: 'In management: vCPU', numeric: true, render: (x) => formatCount(Math.round(x.d.overheadFootprint.vcpu)) },
            { header: 'RAM', numeric: true, render: (x) => formatCapacityGib(x.d.overheadFootprint.ramGib) },
            { header: 'Edge TEPs', numeric: true, render: (x) => String(x.d.edgeTepIps) },
          ],
          allDomains,
        ),
        ...(allClusters.length > 0 ? [spacer(), clusterTable(allClusters.map((x) => ({ c: x.c, where: x.d })))] : []),
        el('div', {
          class: 'section-note',
          text: 'Each domain’s vCenter and NSX Managers run in its instance’s management domain and are counted there. Edge clusters and Supervisor control planes are part of the domain’s first cluster.',
        }),
      ),
    );
  }

  // --- standalone clusters ------------------------------------------------------------------
  if (o.clusters.length > 0) {
    cards.push(card('Workload clusters', clusterTable(o.clusters.map((c) => ({ c, where: '' })))));
  }

  // --- growth ------------------------------------------------------------------------------
  if (o.growth.length > 0) {
    cards.push(
      card(
        'Growth projection',
        table(
          [
            { header: 'Year', render: (y                                 ) => String(y.year) },
            { header: 'Management hosts', numeric: true, render: (y) => (y.managementHosts === null ? '> 64' : String(y.managementHosts)) },
            { header: 'Workload-domain hosts', numeric: true, render: (y) => String(y.workloadHosts) },
            { header: 'vCPU', numeric: true, render: (y) => formatCount(Math.round(y.demand.vcpu)) },
            { header: 'RAM', numeric: true, render: (y) => formatCapacityGib(y.demand.ramGib) },
            { header: 'Disk', numeric: true, render: (y) => formatCapacityGib(y.demand.diskGib) },
          ],
          o.growth,
        ),
        el('div', { class: 'section-note', text: 'The first instance’s management domain, re-sized each year at the compounded growth. Demand is what the management cluster carries.' }),
      ),
    );
  }

  // --- recovery site --------------------------------------------------------------------
  if (o.recovery) {
    const rc = o.recovery.cluster;
    cards.push(
      card(
        'Disaster recovery site',
        statGrid(
          stat({ label: 'Recovery hosts', value: rc.hosts, sub: `set by ${rc.binding}; minimum ${rc.minimum}` }),
          stat({ label: 'vCPU : core', value: ratio(rc.cpuRatio) }),
          stat({ label: 'Memory', value: pct(rc.memoryUtilization), fill: rc.memoryUtilization }),
          stat({ label: 'Storage', value: rc.storage.raid, sub: rc.storage.sufficient ? 'fits' : 'does not fit', tone: rc.storage.sufficient ? 'ok' : 'danger' }),
        ),
        spacer(),
        componentTable(o.recovery.appliances),
      ),
    );
  }

  // --- licensing -------------------------------------------------------------------------
  const fl = o.licensing;
  cards.push(
    card(
      'Licensing',
      el('h3', { class: 'small', text: `This instance: ${instanceName(0)}, management domain only` }),
      statGrid(
        stat({ label: 'Physical cores', value: licensing.physicalCores }),
        stat({
          label: 'Billable cores',
          value: licensing.billableCores,
          tone: licensing.floorPenaltyCores > 0 ? 'warn' : 'ok',
          sub: `${licensing.minPerCpuApplied}-core per-CPU minimum; ${licensing.floorPenaltyCores} floor penalty`,
        }),
        stat({ label: 'vSAN entitlement', value: `${formatCount(licensing.vsanEntitlementTib)} TiB`, sub: '1 TiB per licensed core' }),
        stat({
          label: 'vSAN add-on',
          value: `${formatCount(licensing.vsanAddOnTib)} TiB`,
          sub: `${roundTo(licensing.vsanRawTib, 1)} TiB raw`,
          tone: licensing.vsanAddOnTib > 0 ? 'warn' : 'ok',
        }),
      ),
      spacer(),
      el('h3', { class: 'small', text: `Whole fleet: ${fleet.totals.instances} management domain(s), every workload cluster${o.recovery ? ' and the recovery site' : ''}` }),
      statGrid(
        stat({ label: 'Physical cores', value: fl.physicalCores }),
        stat({ label: 'Billable cores', value: fl.billableCores, sub: `${fl.floorPenaltyCores} floor penalty`, tone: fl.floorPenaltyCores > 0 ? 'warn' : 'ok' }),
        stat({ label: 'vSAN entitlement', value: `${formatCount(fl.vsanEntitlementTib)} TiB`, sub: `${roundTo(fl.vsanRawTib, 1)} TiB raw` }),
        stat({ label: 'vSAN add-on', value: `${formatCount(fl.vsanAddOnTib)} TiB`, tone: fl.vsanAddOnTib > 0 ? 'warn' : 'ok' }),
        ...(fl.coreYears !== undefined ? [stat({ label: 'Core-years', value: fl.coreYears, sub: `${fl.subscriptionYears} year subscription` })] : []),
      ),
      spacer(),
      table(
        [
          { header: 'Licensed', render: (r                           ) => r.name },
          { header: 'Cores', numeric: true, render: (r) => formatCount(r.physicalCores) },
          { header: 'Billable', numeric: true, render: (r) => formatCount(r.billableCores) },
          { header: 'vSAN raw TiB', numeric: true, render: (r) => String(roundTo(r.vsanRawTib, 1)) },
        ],
        fl.items,
      ),
      el('div', {
        class: 'section-note',
        text: `${input.vcfEdge ? 'VCF Edge: 8-core per-CPU floor, 256 cores per site, 10 sites minimum. ' : ''}Workload domains given only as a host count (no cluster rows) are not licensed here. Whether vSAN add-on capacity is metered on raw claimed capacity is unconfirmed (KB 95927).`,
      }),
    ),
  );

  // --- addresses -----------------------------------------------------------------------------
  cards.push(
    card(
      `IP and FQDN requirements (${ips.role} instance)`,
      table(
        [
          { header: 'Purpose', render: (r                           ) => r[0] },
          { header: 'Count', numeric: true, render: (r                           ) => String(r[1]) },
        ],
        [
          [`Host VMkernel (${ips.hostVmkernelPerHost} per host)`, ips.hostIps],
          ['Host TEP pool', ips.tepIps],
          ['Edge TEPs (management domain)', ips.edgeTepIps],
          ['VCF Management Services (minimum)', ips.vcfmsIps],
          ['VCF Management Services (recommended)', ips.vcfmsRecommended],
          ['VCF Automation', ips.automationIps],
          ['Log management', ips.logManagementIps],
          ['Real-time metrics', ips.realTimeMetricsIps],
          ['Component FQDNs', ips.componentFqdns],
          ['Total — minimum', ips.totalMinimum],
          ['Total — recommended', ips.totalRecommended],
          ...(many || fleet.totals.workloadHosts > 0
            ? ([
                ['Fleet total — minimum (every instance and workload cluster)', fleet.totals.ipsMinimum],
                ['Fleet total — recommended', fleet.totals.ipsRecommended],
              ]                      )
            : []),
        ]                      ,
      ),
      el('div', { class: 'section-note', text: 'IPv4 counts. On dual stack the host, VCF Management Services and component counts apply again in each network’s IPv6 prefix.' }),
    ),
  );

  // --- findings and export ----------------------------------------------------------------------
  cards.push(card('Findings', findingsList(o.findings, 'No constraints violated. This design is viable as specified.')));
  cards.push(
    card(
      'Export',
      el(
        'div',
        { class: 'btn-row' },
        el('button', {
          class: 'btn btn-primary',
          text: 'Download sizing report (JSON)',
          on: {
            click: () =>
              downloadFile(`vcf-sizing-${input.path}-${input.hostCount}host.json`, JSON.stringify(serializeOutcome(o), null, 2)),
          },
        }),
        el('button', {
          class: 'btn',
          text: 'Continue in the spec builder',
          on: {
            click: () => {
              const fromEstate = estate ? estateToPlan(estate.inventory, estate.planner.managementCluster()?.key) : {};
              putHandoff('sizing-to-spec', describeSizingHandoff(result), { ...sizingToPlan(result), ...fromEstate });
              globalThis.location.assign('vcf-spec.html');
            },
          },
        }),
      ),
      el('div', {
        class: 'section-note',
        text: 'The report records every input, every computed figure, and the provenance of each number, so a reviewer can reproduce and challenge the result. The spec builder takes the first instance.',
      }),
    ),
  );
  return cards;
}

function clusterTable(rows                                                        )              {
  const withWhere = rows.some((r) => r.where);
  return table(
    [
      { header: 'Cluster', render: (r                                             ) => r.c.name },
      ...(withWhere ? [{ header: 'Domain', render: (r                   ) => r.where }] : []),
      {
        header: 'Hosts',
        numeric: true,
        render: (r) =>
          el('span', {
            text: String(r.c.hosts),
            attrs: { title: `CPU needs ${r.c.byCpu}, memory ${r.c.byMemory}${r.c.byStorage ? `, storage ${r.c.byStorage}` : ''}, minimum ${r.c.minimum}` },
          }),
      },
      { header: 'Set by', render: (r) => r.c.binding },
      { header: 'Surviving', numeric: true, render: (r) => String(r.c.capacity.survivingHosts) },
      { header: 'vCPU : core', numeric: true, render: (r) => ratio(r.c.cpuRatio) },
      { header: 'Memory', numeric: true, render: (r) => pct(r.c.memoryUtilization) },
      { header: 'vSAN', render: (r) => (Number.isFinite(r.c.storage.availableRawGib) ? `${r.c.storage.raid}${r.c.storage.sufficient ? '' : ' (short)'}` : 'external') },
      { header: 'Billable cores', numeric: true, render: (r) => formatCount(r.c.licensing.billableCores) },
    ],
    rows,
  );
}

function finite(n        )                  {
  return Number.isFinite(n) ? n : 'external';
}

function serializeOutcome(o               )          {
  const r = o.result;
  return {
    generatedAt: new Date().toISOString(),
    generatedBy: 'ArchToolKit VCF 9.1 sizing engine',
    version: r.version,
    release: r.release,
    input: o.plan.primary,
    fleetInput: o.plan.fleet,
    managementFootprint: r.managementFootprint,
    components: r.components,
    breakdown: r.breakdown,
    totalDemand: r.totalDemand,
    hostMinimum: r.hostMinimum,
    recommendedHosts: o.recommendedHosts,
    capacity: r.capacity,
    cpuRatio: roundTo(r.cpuRatio, 3),
    memoryUtilization: roundTo(r.memoryUtilization, 3),
    automation: r.automation,
    storage: { ...r.storage, availableRawGib: finite(r.storage.availableRawGib), effectiveCapacityGib: finite(r.storage.effectiveCapacityGib) },
    witness: r.witness,
    workloadDomains: r.workloadDomains,
    licensing: r.licensing,
    fleetLicensing: o.licensing,
    ipRequirements: r.ips,
    fleet: {
      totals: o.fleet.totals,
      instances: o.fleet.instances.map((i) => ({
        role: i.role,
        input: i.input,
        hostMinimum: i.hostMinimum,
        totalDemand: i.totalDemand,
        capacity: i.capacity,
        ips: i.ips,
        licensing: i.licensing,
      })),
    },
    workloadClusters: o.clusters,
    growth: o.growth,
    recovery: o.recovery,
    findings: o.findings,
    overallVerification: r.verification,
  };
}

// Auto-mount when the page provides a target.
const target = typeof document !== 'undefined' ? document.getElementById('vcf-sizing-root') : null;
if (target) mountVcfSizingPage(target               );
