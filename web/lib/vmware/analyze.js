/**
 * Estate analysis.
 *
 * Turns a canonical inventory into the things an architect actually needs: what
 * it would cost to license under VCF's per-core model, whether the estate is
 * over-committed, what would block a VCF brownfield conversion, and a starting
 * sizing input for the VCF engine.
 */

import { error, warning, info,              } from '../core/findings.js';
import {
  LICENSE_MIN_CORES_PER_CPU,
  VSAN_ESA_MIN_HOST_RAM_GIB,
} from '../vcf/sizing-data.js';
                                                    
import {
  computeTotals,
  rollupByCluster,
  toSizingHostProfile,
                 
                     
} from './inventory.js';

                                    
                                 
                                 
                                     
                                                                                
                                                                                         
 

/**
 * VCF 9.1 bills per core with a 16-core-per-CPU minimum, applied per physical
 * CPU rather than per host. An estate of small CPUs therefore pays for cores it
 * does not have, and consolidating onto denser CPUs can cut the bill without
 * losing capacity.
 */
export function estimateLicensing(inventory           )                    {
  let physicalCores = 0;
  let billableCores = 0;
  const hostsBelowFloor                                       = [];

  for (const host of inventory.hosts) {
    const sockets = host.cpuSockets;
    const coresPerCpu = host.coresPerSocket;
    if (sockets <= 0 || coresPerCpu <= 0) continue;

    const actual = sockets * coresPerCpu;
    const billed = sockets * Math.max(coresPerCpu, LICENSE_MIN_CORES_PER_CPU);
    physicalCores += actual;
    billableCores += billed;

    if (coresPerCpu < LICENSE_MIN_CORES_PER_CPU) {
      hostsBelowFloor.push({ name: host.name, coresPerCpu, wastedCores: billed - actual });
    }
  }

  return {
    physicalCores,
    billableCores,
    floorPenaltyCores: billableCores - physicalCores,
    hostsBelowFloor,
  };
}

                                 
                                                    
                                                        
                                        
                                        
 

/** ESX versions that cannot be converged into VCF 9.1 without upgrading first. */
const MIN_CONVERGE_ESX_MAJOR = 8;

function esxMajorVersion(host               )                {
  const match = /(\d+)\./.exec(host.esxVersion ?? '');
  return match?.[1] ? Number(match[1]) : null;
}

export function analyzeEstate(inventory           )                 {
  const findings            = [];
  const totals = computeTotals(inventory);
  const clusters = rollupByCluster(inventory);
  const licensing = estimateLicensing(inventory);

  // --- licensing -----------------------------------------------------------
  if (licensing.floorPenaltyCores > 0) {
    findings.push(
      info(
        'estate.licensing.core-floor',
        `VCF would bill ${licensing.billableCores} cores against ${licensing.physicalCores} physical, because ${licensing.hostsBelowFloor.length} host(s) have CPUs below the ${LICENSE_MIN_CORES_PER_CPU}-core minimum.`,
        {
          remediation: `That is ${licensing.floorPenaltyCores} cores paid for and unused. Consolidating onto CPUs of at least ${LICENSE_MIN_CORES_PER_CPU} cores removes the penalty.`,
          source: 'VCF 9.1 per-core subscription licensing',
        },
      ),
    );
  }

  // --- consolidation -------------------------------------------------------
  if (totals.cpuOvercommit > 4) {
    findings.push(
      warning(
        'estate.cpu.high-overcommit',
        `The estate runs ${totals.cpuOvercommit.toFixed(1)} vCPU per physical core, well above typical guidance.`,
        {
          remediation:
            'Verify actual CPU utilisation before sizing a target; a high allocation ratio with low real usage is normal and safe to consolidate.',
        },
      ),
    );
  }

  if (totals.memoryOvercommit > 1) {
    findings.push(
      warning(
        'estate.memory.overcommitted',
        `Allocated VM memory (${Math.round(totals.allocatedMemoryGib)} GiB) exceeds physical memory (${Math.round(totals.physicalMemoryGib)} GiB).`,
        {
          remediation:
            'Memory overcommit relies on ballooning and swapping. Size the VCF target against allocated memory, not physical.',
        },
      ),
    );
  }

  // --- storage -------------------------------------------------------------
  if (totals.thinProvisioningGib > 0 && totals.provisionedStorageGib > 0) {
    const pct = (totals.thinProvisioningGib / totals.provisionedStorageGib) * 100;
    if (pct > 30) {
      findings.push(
        info(
          'estate.storage.thin-provisioning',
          `${Math.round(pct)}% of provisioned capacity is unconsumed (${Math.round(totals.thinProvisioningGib)} GiB).`,
          {
            remediation:
              'Size vSAN against consumed capacity plus growth rather than provisioned, or the target will be substantially oversized.',
          },
        ),
      );
    }
  }

  const fullDatastores = inventory.datastores.filter(
    (ds) => ds.capacityGib > 0 && ds.freeGib / ds.capacityGib < 0.1,
  );
  if (fullDatastores.length > 0) {
    findings.push(
      warning(
        'estate.storage.datastores-near-full',
        `${fullDatastores.length} datastore(s) are above 90% used: ${fullDatastores
          .slice(0, 5)
          .map((d) => d.name)
          .join(', ')}${fullDatastores.length > 5 ? '…' : ''}`,
        { remediation: 'Free capacity before a migration; vMotion and snapshots both need headroom.' },
      ),
    );
  }

  // --- brownfield conversion blockers --------------------------------------
  const oldHosts = inventory.hosts.filter((h) => {
    const major = esxMajorVersion(h);
    return major !== null && major < MIN_CONVERGE_ESX_MAJOR;
  });
  if (oldHosts.length > 0) {
    findings.push(
      error(
        'estate.vcf.esx-too-old',
        `${oldHosts.length} host(s) run ESX below ${MIN_CONVERGE_ESX_MAJOR}.x and cannot be converged into VCF 9.1 as they are.`,
        {
          remediation: 'Upgrade to ESX 8.0 U3a or later before attempting a VCF conversion.',
          source: 'VCF 9.1 brownfield conversion prerequisites',
        },
      ),
    );
  }

  const lowMemoryHosts = inventory.hosts.filter(
    (h) => h.memoryGib > 0 && h.memoryGib < VSAN_ESA_MIN_HOST_RAM_GIB,
  );
  if (lowMemoryHosts.length > 0) {
    findings.push(
      warning(
        'estate.vsan.esa-memory-floor',
        `${lowMemoryHosts.length} host(s) have less than the ${VSAN_ESA_MIN_HOST_RAM_GIB} GiB vSAN ESA requires.`,
        {
          remediation: 'Those hosts can still use vSAN OSA or external storage.',
          source: 'vSAN 9.1 hardware requirements',
        },
      ),
    );
  }

  // Mixed CPU models inside a cluster constrain EVC and therefore vMotion.
  for (const cluster of clusters) {
    if (cluster.cpuModels.length > 1) {
      findings.push(
        warning(
          'estate.cluster.mixed-cpu-models',
          `Cluster "${cluster.name}" mixes ${cluster.cpuModels.length} CPU models, which constrains EVC baseline and vMotion compatibility.`,
          { remediation: 'Check the EVC mode covers every model, or group hosts by generation.' },
        ),
      );
    }
  }

  const maintenanceHosts = inventory.hosts.filter((h) => h.inMaintenanceMode);
  if (maintenanceHosts.length > 0) {
    findings.push(
      info(
        'estate.hosts.in-maintenance',
        `${maintenanceHosts.length} host(s) are in maintenance mode and their capacity is currently unavailable.`,
      ),
    );
  }

  if (inventory.hosts.length === 0) {
    findings.push(
      warning('estate.no-hosts', 'No hosts in the inventory, so capacity analysis is unavailable.'),
    );
  }

  return { totals, clusters, licensing, findings };
}

/**
 * Derive a starting VCF sizing input from an existing estate.
 *
 * This is the bridge between "what I have" and "what I need". The workload
 * figures come from allocated rather than provisioned values, and capacity uses
 * consumed rather than provisioned, because sizing against provisioned numbers
 * in a thin-provisioned estate produces a wildly oversized target.
 */
export function toSizingInput(
  inventory           ,
  overrides                       = {},
)                     {
  const host = toSizingHostProfile(inventory);
  if (!host) return null;

  const totals = computeTotals(inventory);

  return {
    path: 'brownfield-converge',
    profile: 'simple',
    instanceCount: 1,
    topology: 'standard',
    storage: 'vsan-esa',
    hostCount: inventory.hosts.length,
    host,
    workloadVcpu: totals.allocatedVcpu,
    workloadRamGib: totals.allocatedMemoryGib,
    // Consumed, not provisioned — see the note above.
    workloadCapacityGib: totals.usedStorageGib,
    reserveHostFailure: true,
    ...overrides,
  };
}
