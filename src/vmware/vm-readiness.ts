/**
 * What stands between each VM and a move.
 *
 * The host checks in `readiness.ts` ask whether the estate's hardware can
 * become VCF. This asks the other question — whether each workload can be
 * moved, to a VCF target by vMotion or HCX, or to a cloud by replication —
 * and it can only be asked because the full RVTools import carries the detail:
 * which disks are RDMs and which are multi-writer, which NICs are passthrough,
 * which VMs still have an ISO mounted from a datastore, which run FT, which
 * sit in DRS rules that will have to exist again on the other side.
 *
 * Every check says what it found and what to do. Severity is about the move,
 * not the VM's health: a blocker stops a live migration as things stand, a
 * caution changes how the move is done, and a note is something the plan
 * should carry.
 */

import {
  isWorkload,
  scopedKey,
  type Inventory,
  type InventoryVm,
} from './inventory.ts';

export type MoveSeverity = 'blocker' | 'caution' | 'note';

/** Where a check matters: any move, or only a move off vSphere to a cloud. */
export type MoveTarget = 'vcf' | 'cloud';

export interface MoveCheck {
  readonly id: string;
  readonly severity: MoveSeverity;
  /** Only for moves off vSphere. Absent means it applies to both. */
  readonly cloudOnly?: boolean;
  readonly title: string;
  /** What to do about it. */
  readonly action: string;
}

export interface VmFinding {
  readonly check: MoveCheck;
  readonly detail: string;
}

export interface VmReadiness {
  readonly key: string;
  readonly name: string;
  readonly vcenter?: string;
  readonly cluster?: string;
  readonly powerState: InventoryVm['powerState'];
  readonly findings: readonly VmFinding[];
  readonly worst: MoveSeverity | 'ready';
}

export interface ReadinessSummary {
  readonly vms: readonly VmReadiness[];
  /** Per check: how many VMs, most affected first. */
  readonly byCheck: readonly { readonly check: MoveCheck; readonly count: number; readonly examples: readonly string[] }[];
  readonly ready: number;
  readonly withNotes: number;
  readonly withCautions: number;
  readonly blocked: number;
  /** Powered off long enough to ask whether they should move at all. */
  readonly retireCandidates: number;
}

const C = (id: string, severity: MoveSeverity, title: string, action: string, cloudOnly = false): MoveCheck => ({
  id,
  severity,
  title,
  action,
  ...(cloudOnly ? { cloudOnly } : {}),
});

export const MOVE_CHECKS = {
  disconnected: C(
    'disconnected',
    'blocker',
    'Not connected, orphaned or inaccessible',
    'Fix the registration or remove the VM; nothing can migrate a VM vCenter cannot reach.',
  ),
  rdmPhysical: C(
    'rdm-physical',
    'blocker',
    'Physical-mode raw device mapping',
    'Present the LUN to the target hosts and remap it, or copy the data to VMDKs first. Storage vMotion and cloud replication cannot carry a physical RDM.',
  ),
  rdmVirtual: C(
    'rdm-virtual',
    'caution',
    'Virtual-mode raw device mapping',
    'Storage vMotion converts a virtual RDM to a VMDK when asked — size the target datastore for the full LUN.',
  ),
  multiWriter: C(
    'multi-writer',
    'blocker',
    'Disk shared between VMs (multi-writer or shared SCSI bus)',
    'A clustered application (WSFC, Oracle RAC, GPFS). Move the cluster as a unit, with its shared disks, in an outage.',
  ),
  passthrough: C(
    'passthrough',
    'blocker',
    'PCI passthrough device',
    'The VM is tied to a physical device. Remove it, or rebuild the VM on a target host with the same device.',
  ),
  usb: C('usb', 'caution', 'USB device attached', 'Disconnect it before migrating, and re-attach on the target if it is still needed.'),
  cdConnected: C(
    'cd-connected',
    'caution',
    'CD/DVD connected',
    'Disconnect the drive. A mounted ISO on a datastore the target cannot see stops vMotion.',
  ),
  faultTolerance: C(
    'fault-tolerance',
    'caution',
    'Fault Tolerance enabled',
    'Turn FT off to migrate and re-enable it on the target; clouds that do not offer FT need another answer.',
  ),
  latencySensitive: C(
    'latency-sensitive',
    'caution',
    'Latency sensitivity set to high',
    'Needs full CPU and memory reservations on the target; plan capacity for them.',
  ),
  snapshots: C(
    'snapshots',
    'caution',
    'Snapshots present',
    'Delete or consolidate snapshots before moving; replication tools copy the chain or refuse it.',
  ),
  consolidation: C('consolidation', 'caution', 'Disk consolidation needed', 'Consolidate the disks before migrating.'),
  independent: C(
    'independent-disk',
    'note',
    'Independent disk',
    'Independent disks are skipped by snapshot-based backup and replication. Confirm how that disk moves.',
  ),
  ftRole: C('ft-secondary', 'note', 'Fault Tolerance secondary', 'Moves with its primary.'),
  oldHardware: C(
    'old-hardware',
    'note',
    'Virtual hardware older than version 11',
    'Upgrade the VM hardware version in a maintenance window before or after the move.',
  ),
  toolsMissing: C(
    'tools-missing',
    'caution',
    'VMware Tools not running or not installed',
    'Install or start Tools. Guest customisation, quiesced replication and IP re-addressing depend on them.',
  ),
  unsupportedOs: C(
    'unsupported-os',
    'caution',
    'Guest OS past end of support',
    'Check the target’s guest OS compatibility list; clouds refuse some, and VCF 9 drops others. Upgrade, or accept it as unsupported.',
  ),
  legacyNic: C(
    'legacy-nic',
    'note',
    'Legacy NIC type (E1000 or Flexible)',
    'Replace with VMXNET3; cloud instance types do not offer the legacy adapters.',
    true,
  ),
  large: C('large', 'note', 'Large VM (over 32 vCPU or 512 GiB)', 'Check it fits the target host after N+1, and move it in its own window.'),
  drsRules: C('drs-rules', 'note', 'In DRS affinity or anti-affinity rules', 'Recreate the rules on the target cluster before the members arrive.'),
  vApp: C('vapp', 'note', 'Member of a vApp', 'Move the vApp as a unit, or dissolve it first.'),
  srmProtected: C('srm-protected', 'note', 'Protected by Site Recovery Manager', 'Replan protection on the target before cutting over, or the move breaks DR.'),
  bios: C(
    'bios-firmware',
    'note',
    'BIOS firmware',
    'Some cloud instance types boot UEFI only; convert during migration, or choose a type that supports BIOS boot.',
    true,
  ),
  retire: C(
    'retire',
    'note',
    'Powered off for over 90 days',
    'Ask the owner whether it should move at all. Leaving it behind is the cheapest migration.',
  ),
} as const;

/** Guest operating systems past vendor support, by the names vSphere gives them. */
const UNSUPPORTED_OS = [
  /windows (server )?200[038]/i,
  /windows (server )?2012/i,
  /windows (xp|vista|7|8)\b/i,
  /centos( linux)? [4-8]\b/i,
  /centos 4\/5|centos 4\/5\/6|centos 6|centos 7/i,
  /red hat enterprise linux [3-7]\b/i,
  /suse linux enterprise 1[01]\b/i,
  /ubuntu linux .*1[0-8]\./i,
  /debian gnu\/linux [5-9]\b/i,
  /oracle linux [4-7]\b/i,
];

function osName(vm: InventoryVm): string {
  return vm.guestOsTools ?? vm.guestDetail?.prettyName ?? vm.guestOs ?? '';
}

function daysBetween(a: string, b: string): number {
  return (Date.parse(b) - Date.parse(a)) / 86_400_000;
}

/** Checks for one VM. `collectedAt` is when the estate was captured. */
export function assessVm(vm: InventoryVm, collectedAt?: string): VmFinding[] {
  const out: VmFinding[] = [];
  const add = (check: MoveCheck, detail: string): void => {
    out.push({ check, detail });
  };

  if (vm.connectionState && vm.connectionState !== 'connected') {
    add(MOVE_CHECKS.disconnected, vm.connectionState);
  }

  const disks = vm.disks ?? [];
  const physical = disks.filter((d) => d.raw && /physical/i.test(d.rawCompatibilityMode ?? ''));
  const virtual = disks.filter((d) => d.raw && !/physical/i.test(d.rawCompatibilityMode ?? ''));
  if (physical.length > 0) {
    const tib = physical.reduce((s, d) => s + d.capacityGib, 0) / 1024;
    add(MOVE_CHECKS.rdmPhysical, `${physical.length} disk(s), ${tib >= 1 ? `${tib.toFixed(1)} TiB` : `${Math.round(tib * 1024)} GiB`}`);
  }
  if (virtual.length > 0) add(MOVE_CHECKS.rdmVirtual, `${virtual.length} disk(s)`);
  const shared = disks.filter(
    (d) => /multiwriter/i.test(d.sharing ?? '') || (d.sharedBus !== undefined && !/nosharing/i.test(d.sharedBus)),
  );
  if (shared.length > 0) add(MOVE_CHECKS.multiWriter, shared.map((d) => d.label).slice(0, 3).join(', '));
  const independent = disks.filter((d) => /independent/i.test(d.mode ?? ''));
  if (independent.length > 0) add(MOVE_CHECKS.independent, independent.map((d) => `${d.label} (${d.mode})`).slice(0, 3).join(', '));

  // RVTools' "Direct Path IO" column says DirectPath is *allowed* on a VMXNET3
  // adapter, which it is by default, so only the fixed-passthrough flag counts.
  if (vm.passthroughHotplug) add(MOVE_CHECKS.passthrough, 'fixed passthrough device configured');
  const usb = (vm.usbDevices ?? []).filter((d) => d.connected !== false);
  if (usb.length > 0) add(MOVE_CHECKS.usb, usb.map((d) => d.type ?? d.node).join(', '));
  const cd = (vm.cdroms ?? []).filter((d) => d.connected);
  if (cd.length > 0) add(MOVE_CHECKS.cdConnected, cd.map((d) => d.type ?? d.node).join(', '));

  if (vm.ftState && !/notconfigured/i.test(vm.ftState)) {
    if (/secondary/i.test(vm.ftRole ?? '')) add(MOVE_CHECKS.ftRole, vm.ftRole ?? 'secondary');
    else add(MOVE_CHECKS.faultTolerance, vm.ftState);
  }
  if (vm.latencySensitivity && /high/i.test(vm.latencySensitivity)) add(MOVE_CHECKS.latencySensitive, vm.latencySensitivity);

  if ((vm.snapshotCount ?? 0) > 0) {
    const oldest = (vm.snapshots ?? []).map((s) => s.createdAt).filter(Boolean).sort()[0];
    const age = oldest && collectedAt ? Math.floor(daysBetween(oldest, collectedAt)) : undefined;
    add(
      MOVE_CHECKS.snapshots,
      `${vm.snapshotCount}${vm.snapshotGib ? `, ${Math.round(vm.snapshotGib)} GiB` : ''}${age !== undefined ? `, oldest ${age} days` : ''}`,
    );
  }
  if (vm.consolidationNeeded) add(MOVE_CHECKS.consolidation, 'vCenter reports consolidation needed');

  const hw = Number(/(\d+)/.exec(vm.hardwareVersion ?? '')?.[1]);
  if (Number.isFinite(hw) && hw > 0 && hw < 11) add(MOVE_CHECKS.oldHardware, `vmx-${hw}`);

  if (vm.powerState === 'poweredOn') {
    const tools = (vm.tools?.status ?? vm.toolsStatus ?? '').toLowerCase();
    if (/notinstalled|notrunning/.test(tools)) add(MOVE_CHECKS.toolsMissing, vm.tools?.status ?? vm.toolsStatus ?? '');
  }

  const os = osName(vm);
  if (os && UNSUPPORTED_OS.some((re) => re.test(os))) add(MOVE_CHECKS.unsupportedOs, os);

  const legacy = (vm.nics ?? []).filter((n) => /e1000(?!e)|flexible|vlance|pcnet/i.test(n.adapter ?? ''));
  if (legacy.length > 0) add(MOVE_CHECKS.legacyNic, legacy.map((n) => n.adapter).join(', '));

  if (vm.vcpu > 32 || vm.memoryGib > 512) add(MOVE_CHECKS.large, `${vm.vcpu} vCPU, ${Math.round(vm.memoryGib)} GiB`);
  if ((vm.clusterRuleNames ?? []).length > 0) add(MOVE_CHECKS.drsRules, (vm.clusterRuleNames ?? []).join(', '));
  if (vm.vApp) add(MOVE_CHECKS.vApp, vm.vApp);

  const srm = Object.entries(vm.customAttributes ?? {}).find(([k, v]) => /vcdr|srm/i.test(k) && v.trim() !== '');
  if (srm) add(MOVE_CHECKS.srmProtected, srm[1]);
  if (vm.firmware && /bios/i.test(vm.firmware)) add(MOVE_CHECKS.bios, 'BIOS');

  if (vm.powerState === 'poweredOff' && collectedAt) {
    const offSince =
      Object.entries(vm.customAttributes ?? {}).find(([k]) => /lastpoweredoff/i.test(k))?.[1] ?? undefined;
    const since = offSince && !Number.isNaN(Date.parse(offSince)) ? offSince : undefined;
    const reference = since ?? vm.poweredOnAt;
    if (reference && daysBetween(reference, collectedAt) > 90) {
      add(MOVE_CHECKS.retire, `off since ${reference.slice(0, 10)}`);
    }
  }
  return out;
}

const RANK: Record<MoveSeverity | 'ready', number> = { ready: 0, note: 1, caution: 2, blocker: 3 };

export function assessMoves(inventory: Inventory, target: MoveTarget = 'vcf'): ReadinessSummary {
  const collectedAt = inventory.source.collectedAt;
  const vms: VmReadiness[] = [];
  const tally = new Map<string, { check: MoveCheck; count: number; examples: string[] }>();

  for (const vm of inventory.vms) {
    if (!isWorkload(vm)) continue;
    const findings = assessVm(vm, collectedAt).filter((f) => target === 'cloud' || !f.check.cloudOnly);
    let worst: VmReadiness['worst'] = 'ready';
    for (const f of findings) {
      if (RANK[f.check.severity] > RANK[worst]) worst = f.check.severity;
      const t = tally.get(f.check.id) ?? { check: f.check, count: 0, examples: [] };
      t.count += 1;
      if (t.examples.length < 5) t.examples.push(vm.name);
      tally.set(f.check.id, t);
    }
    vms.push({
      key: scopedKey(vm.vcenter, vm.uuid ?? vm.name),
      name: vm.name,
      ...(vm.vcenter ? { vcenter: vm.vcenter } : {}),
      ...(vm.cluster ? { cluster: vm.cluster } : {}),
      powerState: vm.powerState,
      findings,
      worst,
    });
  }

  const byCheck = [...tally.values()].sort(
    (a, b) => RANK[b.check.severity] - RANK[a.check.severity] || b.count - a.count,
  );
  return {
    vms,
    byCheck,
    ready: vms.filter((v) => v.worst === 'ready').length,
    withNotes: vms.filter((v) => v.worst === 'note').length,
    withCautions: vms.filter((v) => v.worst === 'caution').length,
    blocked: vms.filter((v) => v.worst === 'blocker').length,
    retireCandidates: tally.get('retire')?.count ?? 0,
  };
}
