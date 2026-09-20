/**
 * VMware inventory page.
 *
 * Drop in RVTools CSVs or a collector JSON and get the estate's totals,
 * per-cluster rollup, licensing exposure, per-host VCF readiness, and a sizing
 * input ready to hand to the VCF engine.
 *
 * Everything runs in the page. Inventory data describes a real estate, so it is
 * never uploaded anywhere.
 */

import { el, append, replace, downloadFile, readFileAsText } from './dom.js';
import { card, findingsList, stat, statGrid, table,             } from './components.js';
import { formatCapacityGib, formatCount, roundTo } from '../core/units.js';
import { countBySeverity,              } from '../core/findings.js';
import { importRvToolsFiles } from '../vmware/rvtools.js';
import { importCollectorJson } from '../vmware/powercli.js';
import {
  computeTotals,
  rollupByCluster,
  mergeInventories,
                 
                     
} from '../vmware/inventory.js';
import { analyzeEstate, toSizingInput } from '../vmware/analyze.js';
import { assessEstate,                                      } from '../vmware/readiness.js';
import { sizeDeployment } from '../vcf/sizing.js';
import { putHandoff } from './handoff.js';

const STATUS_MARK                              = {
  pass: '✓',
  fail: '✗',
  warn: '!',
  unknown: '?',
};

const STATUS_TONE                              = {
  pass: 'badge badge-verified',
  fail: 'badge badge-inferred',
  warn: 'badge badge-community',
  unknown: 'badge',
};

export function mountInventoryPage(root             )       {
  const results = el('div', { class: 'stack' });
  let current                   = null;

  const fileInput = el('input', {
    attrs: { type: 'file', accept: '.csv,.json,text/csv,application/json', multiple: true },
  })                    ;

  const status = el('div', { class: 'field-hint' });

  async function handleFiles(files                 )                {
    if (!files || files.length === 0) return;

    const loaded = await Promise.all(
      Array.from(files).map(async (file) => ({
        name: file.name,
        content: await readFileAsText(file),
      })),
    );

    const findings            = [];
    const inventories              = [];

    // A collector JSON and a set of RVTools CSVs are both valid inputs, so
    // each file is routed by what it actually contains.
    const jsonFiles = loaded.filter(
      (f) => f.name.toLowerCase().endsWith('.json') || f.content.trimStart().startsWith('{'),
    );
    const csvFiles = loaded.filter((f) => !jsonFiles.includes(f));

    for (const file of jsonFiles) {
      const result = importCollectorJson(file.content);
      inventories.push(result.inventory);
      findings.push(...result.findings);
    }

    if (csvFiles.length > 0) {
      const result = importRvToolsFiles(csvFiles);
      inventories.push(result.inventory);
      findings.push(...result.findings);
    }

    current = mergeInventories(inventories);
    status.textContent = `Loaded ${loaded.length} file(s): ${current.hosts.length} hosts, ${current.vms.length} VMs.`;
    replace(results, ...buildResults(current, findings));
  }

  fileInput.addEventListener('change', () => void handleFiles(fileInput.files));

  const dropZone = el(
    'div',
    {
      class: 'card',
      style: {
        border: '1px dashed var(--border-strong)',
        textAlign: 'center',
        padding: 'var(--space-6)',
      },
    },
    el('h2', { text: 'Load an estate', style: { marginBottom: 'var(--space-2)' } }),
    el('p', {
      class: 'muted small',
      text: 'Drop RVTools CSV exports (vInfo, vHost, vCluster, vDatastore) or a JSON file from the PowerCLI collector. Sheets are identified by their contents, so filenames do not matter.',
    }),
    el('div', { style: { marginTop: 'var(--space-4)' } }, fileInput),
    status,
    el('div', {
      class: 'section-note',
      style: { textAlign: 'left', marginTop: 'var(--space-4)' },
      text: 'Nothing leaves this page. For the hardware facts that decide vSAN ESA eligibility — NVMe devices and NIC link speeds — use tools/collector/Export-AtkInventory.ps1; RVTools does not capture them.',
    }),
  );

  dropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropZone.style.borderColor = 'var(--accent)';
  });
  dropZone.addEventListener('dragleave', () => {
    dropZone.style.borderColor = 'var(--border-strong)';
  });
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropZone.style.borderColor = 'var(--border-strong)';
    void handleFiles((event             ).dataTransfer?.files ?? null);
  });

  append(root, dropZone, results);
  append(results, el('div', { class: 'empty', text: 'No estate loaded yet.' }));
}

function buildResults(inventory           , importFindings           )                {
  const totals = computeTotals(inventory);
  const clusters = rollupByCluster(inventory);
  const analysis = analyzeEstate(inventory);
  const readiness = assessEstate(inventory);
  const allFindings = [...importFindings, ...analysis.findings, ...readiness.findings];
  const counts = countBySeverity(allFindings);

  const overview = card(
    'Estate',
    statGrid(
      stat({ label: 'Hosts', value: totals.hostCount, sub: `${totals.clusterCount} clusters` }),
      stat({
        label: 'Virtual machines',
        value: totals.vmCount,
        sub: `${totals.poweredOnVmCount} powered on`,
      }),
      stat({
        label: 'Physical cores',
        value: totals.physicalCores,
        sub: `${totals.physicalSockets} sockets`,
      }),
      stat({
        label: 'Physical memory',
        value: formatCapacityGib(totals.physicalMemoryGib),
        sub: `${formatCapacityGib(totals.allocatedMemoryGib)} allocated`,
      }),
    ),
  );

  const consolidation = card(
    'Consolidation',
    statGrid(
      stat({
        label: 'vCPU : pCPU',
        value: `${roundTo(totals.cpuOvercommit, 2)} : 1`,
        sub: `${formatCount(totals.allocatedVcpu)} vCPU allocated`,
        tone: totals.cpuOvercommit > 4 ? 'warn' : 'ok',
      }),
      stat({
        label: 'Memory commitment',
        value: `${Math.round(totals.memoryOvercommit * 100)}%`,
        sub: 'of physical memory',
        tone: totals.memoryOvercommit > 1 ? 'danger' : totals.memoryOvercommit > 0.8 ? 'warn' : 'ok',
        fill: totals.memoryOvercommit,
      }),
      stat({
        label: 'Provisioned storage',
        value: formatCapacityGib(totals.provisionedStorageGib),
        sub: `${formatCapacityGib(totals.usedStorageGib)} consumed`,
      }),
      stat({
        label: 'Thin provisioning gap',
        value: formatCapacityGib(totals.thinProvisioningGib),
        sub: 'unconsumed but allocated',
      }),
    ),
    el('div', {
      class: 'section-note',
      text: 'Size a VCF target against consumed capacity rather than provisioned. In a thin-provisioned estate the difference is often most of the total.',
    }),
  );

  const licensingCard = card(
    'VCF licensing exposure',
    statGrid(
      stat({ label: 'Physical cores', value: analysis.licensing.physicalCores }),
      stat({
        label: 'Billable cores',
        value: analysis.licensing.billableCores,
        tone: analysis.licensing.floorPenaltyCores > 0 ? 'warn' : 'ok',
        sub: '16-core per-CPU minimum',
      }),
      stat({
        label: 'Floor penalty',
        value: analysis.licensing.floorPenaltyCores,
        tone: analysis.licensing.floorPenaltyCores > 0 ? 'warn' : 'ok',
        sub: `${analysis.licensing.hostsBelowFloor.length} host(s) below the floor`,
      }),
    ),
    analysis.licensing.hostsBelowFloor.length > 0
      ? el(
          'div',
          { style: { marginTop: 'var(--space-4)' } },
          table(
            [
              { header: 'Host', render: (h) => h.name },
              { header: 'Cores per CPU', numeric: true, render: (h) => String(h.coresPerCpu) },
              { header: 'Cores wasted', numeric: true, render: (h) => String(h.wastedCores) },
            ],
            analysis.licensing.hostsBelowFloor,
          ),
        )
      : null,
  );

  const clusterColumns                          = [
    { header: 'Cluster', render: (c) => c.name },
    { header: 'Hosts', numeric: true, render: (c) => String(c.hostCount) },
    { header: 'VMs', numeric: true, render: (c) => String(c.vmCount) },
    { header: 'Cores', numeric: true, render: (c) => formatCount(c.physicalCores) },
    { header: 'Memory', numeric: true, render: (c) => formatCapacityGib(c.memoryGib) },
    { header: 'vCPU:pCPU', numeric: true, render: (c) => `${roundTo(c.cpuOvercommit, 2)}:1` },
    {
      header: 'CPU models',
      render: (c) =>
        c.cpuModels.length > 1
          ? el('span', { class: 'badge badge-community', text: `${c.cpuModels.length} mixed` })
          : (c.cpuModels[0] ?? '—'),
    },
  ];

  const clustersCard = card('Clusters', table(clusterColumns, clusters));

  // --- readiness -----------------------------------------------------------
  const checkIds = readiness.hosts[0]?.checks.map((c) => c.id) ?? [];
  const readinessColumns                          = [
    { header: 'Host', render: (h) => h.host },
    ...checkIds.map((id)                        => {
      const label = readiness.hosts[0]?.checks.find((c) => c.id === id)?.label ?? id;
      return {
        header: label,
        render: (h) => {
          const check = h.checks.find((c) => c.id === id);
          if (!check) return '—';
          return el('span', {
            class: STATUS_TONE[check.status],
            text: STATUS_MARK[check.status],
            attrs: { title: check.detail },
          });
        },
      };
    }),
  ];

  const readinessCard = card(
    'VCF 9.1 host readiness',
    statGrid(
      stat({
        label: 'Ready hosts',
        value: readiness.readyHosts,
        sub: `of ${readiness.hosts.length}`,
        tone: readiness.blockedHosts === 0 ? 'ok' : 'warn',
      }),
      stat({
        label: 'Blocked hosts',
        value: readiness.blockedHosts,
        tone: readiness.blockedHosts > 0 ? 'danger' : 'ok',
      }),
      stat({
        label: 'vSAN ESA',
        value: readiness.esaViable ? 'Viable' : 'Not viable',
        tone: readiness.esaViable ? 'ok' : 'warn',
        sub: 'every host needs NVMe',
      }),
    ),
    readiness.hosts.length > 0
      ? el('div', { style: { marginTop: 'var(--space-4)' } }, table(readinessColumns, readiness.hosts))
      : el('div', { class: 'empty', text: 'No hosts to assess.' }),
    el('div', {
      class: 'section-note',
      text: 'Hover any marker for the detail behind it. A "?" means the source data does not carry that field — an RVTools export has no NVMe or NIC-speed information, so those checks cannot be evaluated from one.',
    }),
  );

  // --- sizing bridge -------------------------------------------------------
  const sizingInput = toSizingInput(inventory);
  const sizingCard = sizingInput
    ? (() => {
        const result = sizeDeployment(sizingInput);
        return card(
          'As a VCF target',
          statGrid(
            stat({
              label: 'Management plane',
              value: `${Math.round(result.managementFootprint.vcpu)} vCPU`,
              sub: formatCapacityGib(result.managementFootprint.ramGib),
            }),
            stat({
              label: 'Total demand',
              value: `${Math.round(result.totalDemand.vcpu)} vCPU`,
              sub: `${formatCapacityGib(result.totalDemand.ramGib)} including workloads`,
            }),
            stat({
              label: 'vSAN raw needed',
              value: formatCapacityGib(result.storage.rawRequiredGib),
              sub: `${result.storage.raid}, ${Math.round(result.storage.slackFraction * 100)}% slack`,
              tone: result.storage.sufficient ? 'ok' : 'danger',
            }),
          ),
          el('div', { style: { marginTop: 'var(--space-4)' } }, findingsList(result.findings, 'No sizing constraints violated.')),
          el(
            'div',
            { class: 'btn-row', style: { marginTop: 'var(--space-4)' } },
            el('button', {
              class: 'btn btn-primary',
              text: 'Continue in sizing',
              on: {
                click: () => {
                  const label = inventory.source.label ?? inventory.source.kind;
                  putHandoff(
                    'inventory-to-sizing',
                    `${formatCount(inventory.hosts.length)} hosts and ${formatCount(inventory.vms.length)} VMs from ${label}`,
                    sizingInput,
                  );
                  globalThis.location.assign('vcf-sizing.html');
                },
              },
            }),
            el('button', {
              class: 'btn',
              text: 'Decide where it goes',
              on: {
                click: () => {
                  const label = inventory.source.label ?? inventory.source.kind;
                  // The decision page needs the estate, not the sizing result:
                  // guest OS families and machine sizes are what it reads.
                  putHandoff(
                    'inventory-to-multicloud',
                    `${formatCount(inventory.vms.length)} VMs from ${label}`,
                    inventory,
                  );
                  globalThis.location.assign('multicloud.html');
                },
              },
            }),
            el('button', {
              class: 'btn',
              text: 'Download sizing input (JSON)',
              on: {
                click: () =>
                  downloadFile('vcf-sizing-input.json', JSON.stringify(sizingInput, null, 2)),
              },
            }),
          ),
          el('div', {
            class: 'section-note',
            text: 'Derived by treating the estate as a brownfield conversion: the weakest host sets the per-host profile, and workload capacity uses consumed rather than provisioned storage.',
          }),
        );
      })()
    : null;

  const findingsCard = card(
    `Findings (${counts.error} errors, ${counts.warning} warnings)`,
    findingsList(allFindings, 'No issues found in this estate.'),
  );

  const exportCard = card(
    'Export',
    el(
      'div',
      { class: 'btn-row' },
      el('button', {
        class: 'btn btn-primary',
        text: 'Download canonical inventory (JSON)',
        on: {
          click: () => downloadFile('atk-inventory.json', JSON.stringify(inventory, null, 2)),
        },
      }),
    ),
    el('div', {
      class: 'section-note',
      text: 'The canonical form merges every source into one schema, so an RVTools export and a collector run can be combined and re-imported later.',
    }),
  );

  return [
    overview,
    consolidation,
    clustersCard,
    readinessCard,
    licensingCard,
    ...(sizingCard ? [sizingCard] : []),
    findingsCard,
    exportCard,
  ];
}

const target = typeof document !== 'undefined' ? document.getElementById('inventory-root') : null;
if (target) mountInventoryPage(target               );
