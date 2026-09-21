/**
 * VCF 9.1 sizing calculator page.
 *
 * Left: the design inputs. Right: live results — management-plane demand,
 * host capacity, storage with RAID overhead, IP/FQDN requirements, licensing,
 * and the findings that explain every constraint that was checked.
 */

import { el, append, replace, downloadFile } from './dom.ts';
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
  verificationBadge,
} from './components.ts';
import { formatCapacityGib, formatCount, roundTo } from '../core/units.ts';
import { sizeDeployment, recommendHostCount, minimumHosts, type SizingInput, type SizingResult } from '../vcf/sizing.ts';
import {
  DEPLOYMENT_PROFILE_LABELS,
  type DeploymentProfile,
  type DeploymentPath,
  type ClusterTopology,
  type NsxEdgeSize,
} from '../vcf/sizing-data.ts';
import type { StorageType } from '../vcf/sizing.ts';
import type { AutomationSize } from '../vcf/sizing-data.ts';
import { putHandoff, takeHandoff, rememberLatest } from './handoff.ts';
import { sizingToPlan, describeSizingHandoff, estateToPlan } from '../vcf/bridge.ts';
import { mountEstateBar } from './estate-bar.ts';
import { mountFlowSteps } from './flow-steps.ts';
import { buildEstatePlanner, fleetCard, type EstatePlanner } from './estate-planner.ts';
import type { EstatePlan } from '../vcf/estate-plan.ts';
import type { Inventory } from '../vmware/inventory.ts';

/** The estate the page is planning from, for the spec builder handoff. */
let estate: { inventory: Inventory; planner: EstatePlanner; origin: string } | null = null;

interface Controls {
  path: HTMLSelectElement;
  profile: HTMLSelectElement;
  instanceCount: HTMLInputElement;
  topology: HTMLSelectElement;
  storage: HTMLSelectElement;
  hostCount: HTMLInputElement;
  cpuSockets: HTMLInputElement;
  coresPerCpu: HTMLInputElement;
  hyperthreading: HTMLInputElement;
  ramGib: HTMLInputElement;
  rawStorageGib: HTMLInputElement;
  pnicsPerHost: HTMLInputElement;
  workloadVcpu: HTMLInputElement;
  workloadRamGib: HTMLInputElement;
  workloadCapacityGib: HTMLInputElement;
  includeEdge: HTMLInputElement;
  edgeSize: HTMLSelectElement;
  edgeNodeCount: HTMLInputElement;
  includeAutomation: HTMLInputElement;
  automationSize: HTMLSelectElement;
  reserveHostFailure: HTMLInputElement;
  targetCpuRatio: HTMLInputElement;
}

const PATH_OPTIONS: { value: DeploymentPath; label: string }[] = [
  { value: 'greenfield', label: 'Greenfield — net-new deployment' },
  { value: 'brownfield-converge', label: 'Brownfield — converge to management domain' },
  { value: 'brownfield-import', label: 'Brownfield — import as workload domain' },
];

const PROFILE_OPTIONS = (Object.keys(DEPLOYMENT_PROFILE_LABELS) as DeploymentProfile[]).map((value) => ({
  value,
  label: DEPLOYMENT_PROFILE_LABELS[value],
}));

const TOPOLOGY_OPTIONS: { value: ClusterTopology; label: string }[] = [
  { value: 'standard', label: 'Standard cluster' },
  { value: 'stretched', label: 'Stretched cluster (2 AZ)' },
  { value: 'two-node', label: 'Two-node (ROBO)' },
];

const STORAGE_OPTIONS: { value: StorageType; label: string }[] = [
  { value: 'vsan-esa', label: 'vSAN ESA' },
  { value: 'vsan-osa', label: 'vSAN OSA' },
  { value: 'nfs', label: 'NFS v3' },
  { value: 'vmfs-fc', label: 'VMFS on FC' },
];

const EDGE_OPTIONS: { value: NsxEdgeSize; label: string }[] = [
  { value: 'small', label: 'Small (lab only)' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
  { value: 'xlarge', label: 'X-Large' },
];

export function mountVcfSizingPage(root: HTMLElement): void {
  const controls = {} as Controls;
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
  const resultsPane = el('div', { class: 'stack' });

  const inputsPane = buildInputs(controls, () => render());
  const estateSlot = el('div', {});
  inputsPane.prepend(estateSlot);
  let plan: EstatePlan | null = null;
  let planVersion = 0;

  function onPlanChange(): void {
    if (!estate) return;
    plan = estate.planner.plan();
    planVersion += 1;
    applySizingInput(controls, plan.management);
    render();
  }

  // An inventory import can hand its derived sizing input straight over, so the
  // estate does not have to be described twice.
  const inbound = takeHandoff<SizingInput>('inventory-to-sizing');
  if (inbound) {
    applySizingInput(controls, inbound.payload);
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

  append(
    root,
    el('div', { class: 'split' }, el('div', {}, inputsPane), resultsPane),
  );

  function currentInput(): SizingInput {
    const num = (input: HTMLInputElement, fallback: number): number => {
      const parsed = Number(input.value);
      return Number.isFinite(parsed) ? parsed : fallback;
    };

    return {
      path: controls.path.value as DeploymentPath,
      profile: controls.profile.value as DeploymentProfile,
      instanceCount: Math.max(1, num(controls.instanceCount, 1)),
      topology: controls.topology.value as ClusterTopology,
      storage: controls.storage.value as StorageType,
      hostCount: Math.max(1, num(controls.hostCount, 4)),
      host: {
        cpuSockets: Math.max(1, num(controls.cpuSockets, 2)),
        coresPerCpu: Math.max(1, num(controls.coresPerCpu, 32)),
        hyperthreading: controls.hyperthreading.checked,
        ramGib: Math.max(1, num(controls.ramGib, 1024)),
        rawStorageGib: Math.max(0, num(controls.rawStorageGib, 15360)),
      },
      pnicsPerHost: Math.max(1, num(controls.pnicsPerHost, 2)),
      workloadVcpu: Math.max(0, num(controls.workloadVcpu, 0)),
      workloadRamGib: Math.max(0, num(controls.workloadRamGib, 0)),
      workloadCapacityGib: Math.max(0, num(controls.workloadCapacityGib, 0)),
      includeEdgeCluster: controls.includeEdge.checked,
      edgeSize: controls.edgeSize.value as NsxEdgeSize,
      edgeNodeCount: Math.max(1, num(controls.edgeNodeCount, 2)),
      includeAutomation: controls.includeAutomation.checked,
      automationSize: controls.automationSize.value as AutomationSize,
      reserveHostFailure: controls.reserveHostFailure.checked,
      targetCpuRatio: Math.max(0.1, num(controls.targetCpuRatio, 2)),
    };
  }

  function render(): void {
    const input = currentInput();
    const key = `${planVersion}|${JSON.stringify(input)}`;
    if (key === lastRenderKey) return;
    lastRenderKey = key;
    const result = sizeDeployment(input);
    replace(resultsPane, ...(plan ? [fleetCard(plan)] : []), ...buildResults(result));
    // With an estate loaded, the spec builder follows this page: whatever was
    // sized last is what it opens on, without Continue having to be pressed.
    if (estate) {
      rememberLatest('sizing-to-spec', `${describeSizingHandoff(result)} — from ${estate.origin}`, {
        ...sizingToPlan(result),
        ...estateToPlan(estate.inventory, estate.planner.managementCluster()?.key),
      });
    }
  }

  render();

  // The estate, when one has been imported — here or on any other page —
  // fills the form in: the management domain below, the workload domains in
  // the results.
  void mountEstateBar(root, {
    purpose: 'size the VCF fleet from it, cluster by cluster',
    onEstate: (entry) => {
      if (entry) {
        const planner = buildEstatePlanner(entry.inventory, onPlanChange);
        estate = { inventory: entry.inventory, planner, origin: entry.origin };
        replace(estateSlot, planner.panel);
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
  // Above the estate strip: where this page sits on the VCF path.
  mountFlowSteps(root, 'sizing');
}

function buildInputs(controls: Controls, onChange: () => void): HTMLElement {
  const bind = <T extends HTMLElement>(node: T): T => {
    node.addEventListener('change', onChange);
    node.addEventListener('input', onChange);
    return node;
  };

  controls.path = bind(select(PATH_OPTIONS, 'greenfield'));
  controls.profile = bind(select(PROFILE_OPTIONS, 'simple'));
  controls.instanceCount = bind(numberInput(1, { min: 1, max: 50 }));
  controls.topology = bind(select(TOPOLOGY_OPTIONS, 'standard'));
  controls.storage = bind(select(STORAGE_OPTIONS, 'vsan-esa'));
  controls.hostCount = bind(numberInput(4, { min: 1, max: 64 }));

  controls.cpuSockets = bind(numberInput(2, { min: 1, max: 8 }));
  controls.coresPerCpu = bind(numberInput(32, { min: 1, max: 128 }));
  const ht = checkbox('Hyperthreading enabled', true);
  controls.hyperthreading = bind(ht.input);
  controls.ramGib = bind(numberInput(1024, { min: 16, step: 16 }));
  controls.rawStorageGib = bind(numberInput(15360, { min: 0, step: 512 }));
  controls.pnicsPerHost = bind(numberInput(2, { min: 1, max: 8 }));

  controls.workloadVcpu = bind(numberInput(0, { min: 0 }));
  controls.workloadRamGib = bind(numberInput(0, { min: 0 }));
  controls.workloadCapacityGib = bind(numberInput(0, { min: 0, step: 100 }));

  const edge = checkbox('Include NSX Edge cluster', false);
  controls.includeEdge = bind(edge.input);
  controls.edgeSize = bind(select(EDGE_OPTIONS, 'large'));
  controls.edgeNodeCount = bind(numberInput(2, { min: 1, max: 10 }));

  const automation = checkbox('Include VCF Automation', true);
  controls.includeAutomation = bind(automation.input);
  controls.automationSize = bind(
    select(
      (['small', 'medium', 'large'] as AutomationSize[]).map((v) => ({ value: v, label: v })),
      'small',
    ),
  );
  const reserve = checkbox('Reserve one host for failure (N+1)', true);
  controls.reserveHostFailure = bind(reserve.input);
  controls.targetCpuRatio = bind(numberInput(2, { min: 0.5, max: 16, step: 0.5 }));

  const deployment = card(
    'Deployment',
    field('Deployment path', controls.path),
    field('Profile', controls.profile),
    el(
      'div',
      { class: 'field-row' },
      field('VCF instances in fleet', controls.instanceCount),
      field('Hosts in mgmt cluster', controls.hostCount),
    ),
    field('Cluster topology', controls.topology),
    field('Principal storage', controls.storage),
  );

  const hardware = card(
    'Per-host hardware',
    el(
      'div',
      { class: 'field-row' },
      field('CPU sockets', controls.cpuSockets),
      field('Cores per CPU', controls.coresPerCpu),
    ),
    el('div', { class: 'field' }, ht.wrap),
    el(
      'div',
      { class: 'field-row' },
      field('RAM (GiB)', controls.ramGib),
      field('Raw storage (GiB)', controls.rawStorageGib),
    ),
    field('Physical NICs per host', controls.pnicsPerHost, 'Drives host TEP pool sizing.'),
  );

  const workload = card(
    'Tenant workload',
    el(
      'div',
      { class: 'field-row' },
      field('vCPU', controls.workloadVcpu),
      field('RAM (GiB)', controls.workloadRamGib),
    ),
    field('Capacity (GiB)', controls.workloadCapacityGib, 'Before RAID overhead and slack.'),
  );

  const options = card(
    'Options',
    el('div', { class: 'field' }, automation.wrap),
    el('div', { class: 'field' }, edge.wrap),
    el(
      'div',
      { class: 'field-row' },
      field('Edge size', controls.edgeSize),
      field('VCF Automation size', controls.automationSize),
      field('Edge nodes', controls.edgeNodeCount),
    ),
    el('div', { class: 'field' }, reserve.wrap),
    field('Target vCPU:pCPU ratio', controls.targetCpuRatio),
  );

  return el('div', { class: 'stack' }, deployment, hardware, workload, options);
}

/**
 * Push a derived sizing input into the form.
 *
 * Only the fields the estate actually determines are written; anything the
 * inventory cannot know keeps the form's own default rather than being
 * overwritten with a guess.
 */
function applySizingInput(controls: Controls, input: SizingInput): void {
  controls.path.value = input.path;
  controls.profile.value = input.profile;
  controls.topology.value = input.topology;
  controls.storage.value = input.storage;
  controls.instanceCount.value = String(input.instanceCount);
  controls.hostCount.value = String(input.hostCount);
  controls.cpuSockets.value = String(input.host.cpuSockets);
  controls.coresPerCpu.value = String(input.host.coresPerCpu);
  controls.hyperthreading.checked = input.host.hyperthreading;
  controls.ramGib.value = String(Math.round(input.host.ramGib));
  controls.rawStorageGib.value = String(Math.round(input.host.rawStorageGib));
  if (input.workloadVcpu !== undefined) {
    controls.workloadVcpu.value = String(Math.round(input.workloadVcpu));
  }
  if (input.workloadRamGib !== undefined) {
    controls.workloadRamGib.value = String(Math.round(input.workloadRamGib));
  }
  if (input.workloadCapacityGib !== undefined) {
    controls.workloadCapacityGib.value = String(Math.round(input.workloadCapacityGib));
  }
  if (input.pnicsPerHost !== undefined) controls.pnicsPerHost.value = String(input.pnicsPerHost);
  if (input.reserveHostFailure !== undefined) {
    controls.reserveHostFailure.checked = input.reserveHostFailure;
  }
}

function buildResults(result: SizingResult): HTMLElement[] {
  const { capacity, storage, licensing, ips, totalDemand, input } = result;
  const errors = result.findings.filter((f) => f.severity === 'error').length;
  const warnings = result.findings.filter((f) => f.severity === 'warning').length;

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
        value: minimumHosts(input).hosts,
        sub: `configured: ${input.hostCount}`,
        tone: input.hostCount >= minimumHosts(input).hosts ? 'ok' : 'danger',
      }),
      stat({
        label: 'Smallest viable cluster',
        value: recommendHostCount(input) ?? '—',
        sub: 'hosts, given this hardware',
      }),
    ),
  );

  const demand = card(
    'Management plane demand',
    statGrid(
      stat({
        label: 'vCPU required',
        value: Math.round(totalDemand.vcpu),
        sub: `${formatCount(capacity.logicalProcessors)} logical available`,
        fill: result.cpuRatio / (input.targetCpuRatio ?? 2),
        tone: result.cpuRatio > (input.targetCpuRatio ?? 2) ? 'warn' : 'ok',
      }),
      stat({
        label: 'Memory required',
        value: formatCapacityGib(totalDemand.ramGib),
        sub: `${formatCapacityGib(capacity.usableRamGib)} usable`,
        fill: result.memoryUtilization,
        tone: result.memoryUtilization > 1 ? 'danger' : result.memoryUtilization > 0.8 ? 'warn' : 'ok',
      }),
      stat({
        label: 'vCPU : pCPU',
        value: `${roundTo(result.cpuRatio, 2)} : 1`,
        sub: `target ${input.targetCpuRatio ?? 2}:1`,
      }),
    ),
    el('div', { style: { marginTop: 'var(--space-4)' } }),
    table(
      [
        { header: 'Component', render: (c) => c.name },
        { header: 'vCPU', numeric: true, render: (c) => formatCount(Math.round(c.footprint.vcpu)) },
        { header: 'RAM', numeric: true, render: (c) => formatCapacityGib(c.footprint.ramGib) },
        { header: 'Disk', numeric: true, render: (c) => formatCapacityGib(c.footprint.diskGib) },
        { header: 'Source', render: (c) => verificationBadge(c.verification) },
      ],
      result.components,
    ),
    el('div', {
      class: 'section-note',
      text:
        'The management-plane figure is Broadcom’s published fleet aggregate, not a sum of per-component estimates. Where a live VCF Installer is reachable, POST /v1/sddcs/resources-calculation is authoritative and should be preferred.',
    }),
  );

  const storageCard = card(
    'Storage',
    statGrid(
      stat({
        label: 'Raw required',
        value: formatCapacityGib(storage.rawRequiredGib),
        sub: `${storage.raid}, FTT=${storage.ftt}`,
        tone: storage.sufficient ? 'ok' : 'danger',
      }),
      stat({
        label: 'Raw available',
        value: Number.isFinite(storage.availableRawGib)
          ? formatCapacityGib(storage.availableRawGib)
          : 'External',
        sub: Number.isFinite(storage.availableRawGib)
          ? `${input.hostCount} hosts${input.reserveHostFailure === false ? '' : ' less N+1'}`
          : 'not vSAN-backed',
      }),
      stat({
        label: 'Overhead',
        value: `${storage.multiplier}x`,
        sub: `plus ${Math.round(storage.slackFraction * 100)}% slack`,
      }),
    ),
    el('div', {
      class: 'section-note',
      text: `Usable data ${formatCapacityGib(storage.required)} — management plane ${formatCapacityGib(totalDemand.diskGib)} plus workload ${formatCapacityGib(input.workloadCapacityGib ?? 0)}. VCF 9.1 Auto-RAID applies the same 1.5x overhead to RAID-5 and RAID-6.`,
    }),
  );

  const licensingCard = card(
    'Licensing',
    statGrid(
      stat({ label: 'Physical cores', value: licensing.physicalCores }),
      stat({
        label: 'Billable cores',
        value: licensing.billableCores,
        tone: licensing.floorPenaltyCores > 0 ? 'warn' : 'ok',
        sub: `${licensing.minPerCpuApplied}-core per-CPU minimum`,
      }),
      stat({
        label: 'Floor penalty',
        value: licensing.floorPenaltyCores,
        tone: licensing.floorPenaltyCores > 0 ? 'warn' : 'ok',
        sub: 'cores paid for, not present',
      }),
    ),
  );

  const ipCard = card(
    'IP and FQDN requirements',
    table(
      [
        { header: 'Purpose', render: (r: [string, number | string]) => r[0] },
        { header: 'Count', numeric: true, render: (r: [string, number | string]) => String(r[1]) },
      ],
      [
        ['Host VMkernel (mgmt, vMotion, vSAN)', ips.hostIps],
        ['Host TEP pool', ips.tepIps],
        ['VCF Management Services (minimum)', ips.vcfmsIps],
        ['VCF Management Services (recommended)', ips.vcfmsRecommended],
        ['VCF Automation nodes', ips.automationIps],
        ['Component FQDNs', ips.componentFqdns],
        ['Total — minimum', ips.totalMinimum],
        ['Total — recommended', ips.totalRecommended],
      ] as [string, number][],
    ),
  );

  const findingsCard = card(
    'Findings',
    findingsList(result.findings, 'No constraints violated. This design is viable as specified.'),
  );

  const exportCard = card(
    'Export',
    el(
      'div',
      { class: 'btn-row' },
      el('button', {
        class: 'btn btn-primary',
        text: 'Download sizing report (JSON)',
        on: {
          click: () =>
            downloadFile(
              `vcf-sizing-${input.path}-${input.hostCount}host.json`,
              JSON.stringify(serializeResult(result), null, 2),
            ),
        },
      }),
      el('button', {
        class: 'btn',
        text: 'Continue in the spec builder',
        on: {
          click: () => {
            const fromEstate = estate
              ? estateToPlan(estate.inventory, estate.planner.managementCluster()?.key)
              : {};
            putHandoff('sizing-to-spec', describeSizingHandoff(result), { ...sizingToPlan(result), ...fromEstate });
            globalThis.location.assign('vcf-spec.html');
          },
        },
      }),
    ),
    el('div', {
      class: 'section-note',
      text: 'The report records every input, every computed figure, and the provenance of each number, so a reviewer can reproduce and challenge the result.',
    }),
  );

  return [verdict, demand, storageCard, licensingCard, ipCard, findingsCard, exportCard];
}

function serializeResult(result: SizingResult): unknown {
  return {
    generatedAt: new Date().toISOString(),
    generatedBy: 'ArchToolKit VCF 9.1 sizing engine',
    input: result.input,
    managementFootprint: result.managementFootprint,
    components: result.components,
    totalDemand: result.totalDemand,
    capacity: result.capacity,
    cpuRatio: roundTo(result.cpuRatio, 3),
    memoryUtilization: roundTo(result.memoryUtilization, 3),
    storage: {
      ...result.storage,
      availableRawGib: Number.isFinite(result.storage.availableRawGib)
        ? result.storage.availableRawGib
        : 'external',
    },
    licensing: result.licensing,
    ipRequirements: result.ips,
    findings: result.findings,
    overallVerification: result.verification,
  };
}

// Auto-mount when the page provides a target.
const target = typeof document !== 'undefined' ? document.getElementById('vcf-sizing-root') : null;
if (target) mountVcfSizingPage(target as HTMLElement);

