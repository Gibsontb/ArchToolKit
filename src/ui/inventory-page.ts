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

import { el, append, replace, downloadFile } from './dom.ts';
import { card, findingsList, stat, statGrid, table, type Column } from './components.ts';
import { formatCapacityGib, formatCount, roundTo } from '../core/units.ts';
import { countBySeverity, type Finding } from '../core/findings.ts';
import {
  computeTotals,
  rollupByCluster,
  type Inventory,
  type ClusterRollup,
} from '../vmware/inventory.ts';
import { assessMoves, type MoveSeverity } from '../vmware/vm-readiness.ts';
import { mountEstateBar } from './estate-bar.ts';
import { mountFlowSteps } from './flow-steps.ts';
import { analyzeEstate } from '../vmware/analyze.ts';
import { sourceClusters, commonHostProfile, planEstate, suggestManagementSource } from '../vcf/estate-plan.ts';
import { assessEstate, type HostReadiness, type CheckStatus } from '../vmware/readiness.ts';
import { sizeDeployment } from '../vcf/sizing.ts';

const STATUS_MARK: Record<CheckStatus, string> = {
  pass: '✓',
  fail: '✗',
  warn: '!',
  unknown: '?',
};

const STATUS_TONE: Record<CheckStatus, string> = {
  pass: 'badge badge-verified',
  fail: 'badge badge-inferred',
  warn: 'badge badge-community',
  unknown: 'badge',
};

export function mountInventoryPage(root: HTMLElement): void {
  const results = el('div', { class: 'stack' });
  append(root, results);
  append(results, el('div', { class: 'empty', text: 'No estate loaded yet.' }));

  void mountEstateBar(root, {
    purpose: 'see its totals, clusters, VCF readiness and what stands in the way of moving each VM',
    onEstate: (entry) => {
      if (!entry) {
        replace(results, el('div', { class: 'empty', text: 'No estate loaded yet.' }));
        return;
      }
      replace(results, ...buildResults(entry.inventory, [...entry.findings]));
    },
  });
  // Above the estate strip: where this page sits on the VCF path.
  mountFlowSteps(root, 'inventory');

  append(
    root,
    el('div', {
      class: 'section-note',
      text: 'Nothing leaves this page: the estate is read in the browser and kept in this browser only, until you forget it. For the hardware facts that decide vSAN ESA eligibility — NVMe devices and NIC firmware — also run tools/collector/Export-AtkInventory.ps1; RVTools does not capture them.',
    }),
  );
}

function buildResults(inventory: Inventory, importFindings: Finding[]): HTMLElement[] {
  const totals = computeTotals(inventory);
  const clusters = rollupByCluster(inventory);
  const analysis = analyzeEstate(inventory);
  const readiness = assessEstate(inventory);
  const allFindings = [...importFindings, ...analysis.findings, ...readiness.findings];
  const counts = countBySeverity(allFindings);

  const overview = card(
    'Estate',
    statGrid(
      stat({
        label: 'Hosts',
        value: formatCount(totals.hostCount),
        sub: `${totals.clusterCount} clusters${totals.vcenterCount > 1 ? `, ${totals.vcenterCount} vCenters` : ''}`,
      }),
      stat({
        label: 'Virtual machines',
        value: formatCount(totals.vmCount),
        sub: `${formatCount(totals.poweredOnVmCount)} powered on${totals.templateCount ? `, ${formatCount(totals.templateCount)} templates` : ''}`,
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
      ...(totals.rdmGib > 0
        ? [
            stat({
              label: 'Raw device mappings',
              value: formatCapacityGib(totals.rdmGib),
              sub: 'each LUN once, not in the figures above',
              tone: 'warn',
            }),
          ]
        : []),
      stat({
        label: 'Active memory',
        value: formatCapacityGib(totals.activeMemoryGib),
        sub: 'at the moment of capture',
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

  const multiVcenter = totals.vcenterCount > 1;
  const clusterColumns: Column<ClusterRollup>[] = [
    { header: 'Cluster', render: (c) => c.name },
    ...(multiVcenter
      ? [{ header: 'vCenter', render: (c: ClusterRollup) => (c.vcenter ?? '—').split('.')[0] ?? '—' }]
      : []),
    { header: 'Hosts', numeric: true, render: (c) => String(c.hostCount) },
    { header: 'VMs', numeric: true, render: (c) => `${c.poweredOnVmCount} / ${c.vmCount}` },
    { header: 'Cores', numeric: true, render: (c) => formatCount(c.physicalCores) },
    { header: 'Memory', numeric: true, render: (c) => formatCapacityGib(c.memoryGib) },
    { header: 'vCPU', numeric: true, render: (c) => formatCount(c.allocatedVcpu) },
    { header: 'vRAM', numeric: true, render: (c) => formatCapacityGib(c.allocatedMemoryGib) },
    { header: 'Used storage', numeric: true, render: (c) => formatCapacityGib(c.usedStorageGib) },
    { header: 'RDM', numeric: true, render: (c) => (c.rdmGib > 0 ? formatCapacityGib(c.rdmGib) : '—') },
    { header: 'vCPU:pCPU', numeric: true, render: (c) => `${roundTo(c.cpuOvercommit, 2)}:1` },
    {
      header: 'CPU / mem use',
      numeric: true,
      render: (c) =>
        c.cpuUsage === undefined ? '—' : `${Math.round(c.cpuUsage * 100)}% / ${Math.round((c.memoryUsage ?? 0) * 100)}%`,
    },
    {
      header: 'CPU models',
      render: (c) =>
        c.cpuModels.length > 1
          ? el('span', { class: 'badge badge-community', text: `${c.cpuModels.length} mixed` })
          : (c.cpuModels[0] ?? '—'),
    },
  ];

  const clustersCard = card(
    'Clusters',
    table(clusterColumns, clusters),
    el('div', {
      class: 'section-note',
      text: 'VMs are running / all workloads (templates apart). Storage is consumed VMDK; raw device mappings are counted once per LUN in their own column. CPU and memory use are what the hosts reported at capture.',
    }),
  );

  // --- where it came from -----------------------------------------------------
  const source = inventory.source;
  const vcenters = inventory.vcenters ?? [];
  const sourceCard = card(
    'Source',
    el('p', {
      class: 'small',
      text: `${source.label ?? source.kind}${source.toolVersion ? ` · ${source.toolVersion}` : ''}${source.tabs ? ` · ${Object.keys(source.tabs).length} tabs read` : ''}`,
    }),
    vcenters.length > 0
      ? table(
          [
            { header: 'vCenter', render: (v) => v.name },
            { header: 'Version', render: (v) => [v.version, v.build ? `build ${v.build}` : ''].filter(Boolean).join(' ') || '—' },
            { header: 'Collected', render: (v) => (source.collectedPerVcenter?.[v.name] ?? '—').replace('T', ' ').slice(0, 16) },
          ],
          vcenters,
        )
      : null,
    source.tabs
      ? el('div', {
          class: 'section-note',
          text: Object.entries(source.tabs)
            .map(([tab, rows]) => `${tab} ${formatCount(rows)}`)
            .join(' · '),
        })
      : null,
  );

  // --- moving the VMs ---------------------------------------------------------
  const moves = assessMoves(inventory, 'vcf');
  const cloudMoves = assessMoves(inventory, 'cloud');
  const TONE: Record<MoveSeverity, string> = {
    blocker: 'badge badge-inferred',
    caution: 'badge badge-community',
    note: 'badge',
  };
  const movesCard =
    moves.vms.length > 0
      ? card(
          'Moving the VMs',
          statGrid(
            stat({ label: 'Ready as they are', value: formatCount(moves.ready + moves.withNotes), sub: `of ${formatCount(moves.vms.length)}`, tone: 'ok' }),
            stat({ label: 'Need attention', value: formatCount(moves.withCautions), sub: 'change how they move', tone: moves.withCautions > 0 ? 'warn' : 'ok' }),
            stat({ label: 'Blocked', value: formatCount(moves.blocked), sub: 'as things stand', tone: moves.blocked > 0 ? 'danger' : 'ok' }),
            stat({ label: 'Blocked for a cloud', value: formatCount(cloudMoves.blocked), sub: `${formatCount(cloudMoves.withCautions)} more need attention` }),
          ),
          el(
            'div',
            { style: { marginTop: 'var(--space-4)' } },
            table(
              [
                { header: '', render: (r) => el('span', { class: TONE[r.check.severity], text: r.check.severity }) },
                { header: 'What', render: (r) => r.check.title + (r.check.cloudOnly ? ' (cloud only)' : '') },
                { header: 'VMs', numeric: true, render: (r) => formatCount(r.count) },
                { header: 'What to do', render: (r) => el('span', { class: 'small', text: r.check.action }) },
                { header: 'For example', render: (r) => el('span', { class: 'small muted', text: r.examples.slice(0, 3).join(', ') }) },
              ],
              cloudMoves.byCheck,
            ),
          ),
          el('div', {
            class: 'section-note',
            text: 'Counts are for a move to VCF by vMotion or HCX; the "cloud only" rows apply only to moving off vSphere. Every VM\'s findings are in the canonical inventory export below.',
          }),
        )
      : null;

  // --- health and licences ------------------------------------------------------
  const health = inventory.health ?? [];
  const healthByType = new Map<string, number>();
  for (const h of health) healthByType.set(h.type ?? 'Other', (healthByType.get(h.type ?? 'Other') ?? 0) + 1);
  const licenses = inventory.licenses ?? [];
  const healthCard =
    health.length > 0 || licenses.length > 0
      ? card(
          'Health and licences',
          health.length > 0
            ? table(
                [
                  { header: 'RVTools health check', render: (r: [string, number]) => r[0] },
                  { header: 'Messages', numeric: true, render: (r: [string, number]) => formatCount(r[1]) },
                ],
                [...healthByType.entries()].sort((a, b) => b[1] - a[1]),
              )
            : null,
          licenses.length > 0
            ? el(
                'div',
                { style: { marginTop: 'var(--space-4)' } },
                table(
                  [
                    { header: 'Licence', render: (l) => l.name },
                    { header: 'Key', render: (l) => (l.keyTail ? `…${l.keyTail}` : '—') },
                    { header: 'Used / total', numeric: true, render: (l) => `${formatCount(l.used ?? 0)} / ${formatCount(l.total ?? 0)} ${l.costUnit ?? ''}` },
                    { header: 'Expires', render: (l) => (l.expires ?? '—').slice(0, 10) },
                  ],
                  dedupeLicenses(licenses),
                ),
              )
            : null,
          el('div', {
            class: 'section-note',
            text: 'Zombie VMDKs are files on a datastore that no VM references — capacity to reclaim before sizing the target. Licence keys are kept to their last five characters.',
          }),
        )
      : null;

  const nextCard = card(
    'Take it further',
    el(
      'div',
      { class: 'btn-row' },
      el('a', { class: 'btn btn-primary', text: 'Size VCF from this estate', attrs: { href: 'vcf-sizing.html' } }),
      el('a', { class: 'btn', text: 'Decide where it goes', attrs: { href: 'multicloud.html' } }),
      el('a', { class: 'btn', text: 'Terraform from the estate', attrs: { href: 'terraform.html' } }),
      el('a', { class: 'btn', text: 'Ansible from the estate', attrs: { href: 'ansible.html' } }),
    ),
    el('div', {
      class: 'section-note',
      text: 'Every page reads this estate: sizing fills itself in per cluster, the spec builder takes the management cluster\'s hosts, DNS, NTP and networks, the generators offer its names and build from its VMs, and the decision matrix starts from its workloads.',
    }),
  );

  // --- readiness -----------------------------------------------------------
  const checkIds = readiness.hosts[0]?.checks.map((c) => c.id) ?? [];
  const readinessColumns: Column<HostReadiness>[] = [
    { header: 'Host', render: (h) => h.host },
    ...checkIds.map((id): Column<HostReadiness> => {
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

  // --- as a VCF fleet ------------------------------------------------------
  const sources = sourceClusters(inventory);
  const target = commonHostProfile(inventory.hosts);
  const sizingCard =
    target && sources.length > 0
      ? (() => {
          const plan = planEstate(inventory, { host: target, managementSource: suggestManagementSource(sources) });
          const mgmt = sizeDeployment(plan.management);
          const workloadDomains = plan.domains.filter((d) => d.kind === 'workload');
          return card(
            'As a VCF fleet',
            statGrid(
              stat({
                label: 'Workload domains',
                value: workloadDomains.length,
                sub: `${workloadDomains.reduce((n, d) => n + d.clusters.length, 0)} clusters`,
              }),
              stat({
                label: 'Target hosts',
                value: formatCount(plan.workloadHosts + (plan.management.path === 'greenfield' ? plan.management.hostCount : 0)),
                sub: `against ${formatCount(plan.sourceHosts)} today`,
              }),
              stat({
                label: 'Billable cores',
                value: formatCount(plan.billableCores),
                sub: target.label,
              }),
              stat({
                label: 'Management domain',
                value: plan.management.path === 'greenfield' ? 'New hosts' : 'Converged',
                sub: `${plan.management.hostCount} hosts · ${mgmt.findings.filter((f) => f.severity === 'error').length} blocking`,
              }),
            ),
            el(
              'div',
              { class: 'btn-row', style: { marginTop: 'var(--space-4)' } },
              el('a', { class: 'btn btn-primary', text: 'Open in sizing', attrs: { href: 'vcf-sizing.html' } }),
              el('button', {
                class: 'btn',
                text: 'Download sizing input (JSON)',
                on: {
                  click: () => downloadFile('vcf-estate-plan.json', JSON.stringify(plan, null, 2)),
                },
              }),
            ),
            el('div', {
              class: 'section-note',
              text: 'A first pass on defaults: the most common host in the estate as the target, each source cluster resized onto it at 4:1 vCPU per core and 90% memory with 20% growth and N+1, one workload domain per vCenter. The sizing page lets you change every one of those.',
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
    nextCard,
    sourceCard,
    consolidation,
    clustersCard,
    ...(movesCard ? [movesCard] : []),
    ...(healthCard ? [healthCard] : []),
    readinessCard,
    licensingCard,
    ...(sizingCard ? [sizingCard] : []),
    findingsCard,
    exportCard,
  ];
}

/** One row per licence and key: every vCenter in a linked group lists the same ones. */
function dedupeLicenses<T extends { name: string; keyTail?: string }>(licenses: readonly T[]): T[] {
  const seen = new Map<string, T>();
  for (const l of licenses) {
    const key = `${l.name}|${l.keyTail ?? ''}`;
    if (!seen.has(key)) seen.set(key, l);
  }
  return [...seen.values()];
}

const target = typeof document !== 'undefined' ? document.getElementById('inventory-root') : null;
if (target) mountInventoryPage(target as HTMLElement);
