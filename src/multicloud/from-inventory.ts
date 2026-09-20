/**
 * What an imported estate can and cannot tell the decision matrix.
 *
 * An RVTools export knows how many virtual machines there are, what they run
 * and how big they are. It does not know why they exist, what they talk to, or
 * when the hardware lease expires — and those are the inputs that actually
 * decide the platform.
 *
 * So this fills in what the inventory genuinely supports and says plainly what
 * it could not determine, rather than defaulting the unknowns and producing a
 * recommendation that looks like it was based on the data.
 */

import { info, warning, type Finding } from '../core/findings.ts';
import type { Inventory, InventoryVm } from '../vmware/inventory.ts';
import type { Disposition, WorkloadProfile } from './decide.ts';

/** Memory beyond which the instance shapes available start to narrow. */
const LARGE_MEMORY_GIB = 384;

/**
 * Guest OS family, from whatever the collector wrote.
 *
 * RVTools reports the configured guest OS, which is a VMware identifier
 * (`windows2019srvNext_64Guest`) or a human string ("Microsoft Windows Server
 * 2019"). Both contain the word, so matching on it is enough, and a guest
 * nobody configured correctly is counted as neither rather than guessed.
 */
function osFamilyOf(vm: InventoryVm): 'linux' | 'windows' | undefined {
  const text = (vm.guestOs ?? '').toLowerCase();
  if (!text) return undefined;
  if (text.includes('windows') || text.includes('win')) return 'windows';
  if (
    text.includes('linux') ||
    text.includes('rhel') ||
    text.includes('centos') ||
    text.includes('ubuntu') ||
    text.includes('debian') ||
    text.includes('suse') ||
    text.includes('oracle')
  ) {
    return 'linux';
  }
  return undefined;
}

export interface InventoryProfileOptions {
  /** The disposition being considered. The inventory cannot tell you this. */
  readonly disposition: Disposition;
  /** Only these clusters. Omitted means the whole estate. */
  readonly clusters?: readonly string[];
}

export interface InventoryProfile {
  readonly profile: WorkloadProfile;
  readonly findings: readonly Finding[];
  /** Counts behind the profile, so the numbers can be checked. */
  readonly evidence: {
    readonly vmCount: number;
    readonly windows: number;
    readonly linux: number;
    readonly unknownOs: number;
    readonly largeMemory: number;
    readonly poweredOff: number;
  };
}

export function profileFromInventory(
  inventory: Inventory,
  options: InventoryProfileOptions,
): InventoryProfile {
  const findings: Finding[] = [];
  const vms = options.clusters
    ? inventory.vms.filter((vm) => vm.cluster !== undefined && options.clusters?.includes(vm.cluster))
    : inventory.vms;

  let windows = 0;
  let linux = 0;
  let unknownOs = 0;
  let largeMemory = 0;
  let poweredOff = 0;

  for (const vm of vms) {
    const family = osFamilyOf(vm);
    if (family === 'windows') windows += 1;
    else if (family === 'linux') linux += 1;
    else unknownOs += 1;
    if (vm.memoryGib >= LARGE_MEMORY_GIB) largeMemory += 1;
    if (vm.powerState === 'poweredOff') poweredOff += 1;
  }

  const osFamily: WorkloadProfile['osFamily'] =
    windows > 0 && linux > 0 ? 'mixed' : windows > 0 ? 'windows' : linux > 0 ? 'linux' : undefined;

  const profile: WorkloadProfile = {
    disposition: options.disposition,
    vmCount: vms.length,
    ...(osFamily ? { osFamily } : {}),
    ...(largeMemory > 0 ? { specialHardware: ['large-memory' as const] } : {}),
  };

  findings.push(
    info(
      'multicloud.inventory.counted',
      `${vms.length} virtual machines: ${windows} Windows, ${linux} Linux, ${unknownOs} with no usable guest OS recorded.`,
      { source: `Inventory imported from ${inventory.source.kind}` },
    ),
  );

  if (unknownOs > 0) {
    findings.push(
      warning(
        'multicloud.inventory.unknown-guest-os',
        `${unknownOs} virtual machine(s) have no guest OS recorded, so the Windows licensing position is understated.`,
        {
          remediation:
            'Windows licensing usually decides a platform, so it is worth resolving these before deciding.',
          source: 'ArchToolKit',
        },
      ),
    );
  }

  if (poweredOff > 0) {
    findings.push(
      info(
        'multicloud.inventory.powered-off',
        `${poweredOff} of them are powered off and may not need moving at all.`,
        {
          remediation: 'Decommissioning first is cheaper than migrating and then decommissioning.',
          source: 'ArchToolKit',
        },
      ),
    );
  }

  if (largeMemory > 0) {
    findings.push(
      info(
        'multicloud.inventory.large-memory',
        `${largeMemory} virtual machine(s) have ${LARGE_MEMORY_GIB} GiB or more of memory, which narrows the instance shapes available.`,
        { source: 'ArchToolKit' },
      ),
    );
  }

  // The three inputs that move the answer most, and that no export contains.
  findings.push(
    warning(
      'multicloud.inventory.cannot-determine',
      'An inventory cannot tell you the databases in use, the latency tolerance, or the deadline — and those three move the answer more than anything it can tell you.',
      {
        remediation: 'Supply them alongside the inventory; the matrix reports what it was given.',
        source: 'ArchToolKit',
      },
    ),
  );

  return {
    profile,
    findings,
    evidence: { vmCount: vms.length, windows, linux, unknownOs, largeMemory, poweredOff },
  };
}
