/**
 * Per-host VCF 9.1 readiness assessment.
 *
 * Estate-level analysis (analyze.ts) answers "can this estate become VCF".
 * This answers "can *this host* participate", which is the question that
 * actually blocks deployments: one host without NVMe rules out vSAN ESA for
 * the whole cluster.
 *
 * Only the detailed collector populates the hardware fields this reads. An
 * RVTools import will produce mostly "unknown" verdicts, which is reported
 * honestly rather than being presented as a pass.
 */

import { error, warning, info,              } from '../core/findings.js';
import { VSAN_ESA_MIN_HOST_RAM_GIB, LICENSE_MIN_CORES_PER_CPU } from '../vcf/sizing-data.js';
                                                               

                                                               

                                 
                      
                         
                               
                          
                                
 

                                
                        
                                    
                            
                            
                            
                                          
                           
 

/** 25GbE is the vSAN ESA recommendation; 10GbE is the practical floor. */
const ESA_RECOMMENDED_NIC_MB = 25000;
const MIN_NIC_MB = 10000;
const MIN_ESX_MAJOR = 8;

function fastestNicMb(host               )                {
  const nics = host.physicalNics ?? [];
  const speeds = nics.map((n) => n.speedMb).filter((s)              => typeof s === 'number');
  return speeds.length > 0 ? Math.max(...speeds) : null;
}

function nvmeCount(host               )                {
  if (!host.storageDevices || host.storageDevices.length === 0) return null;
  return host.storageDevices.filter((d) => d.type === 'NVMe').length;
}

export function assessHost(host               )                {
  const checks                   = [];

  // --- ESX version ---------------------------------------------------------
  const major = /(\d+)\./.exec(host.esxVersion ?? '')?.[1];
  checks.push(
    major === undefined
      ? {
          id: 'esx-version',
          label: 'ESX version',
          status: 'unknown',
          detail: 'No version reported.',
        }
      : Number(major) >= MIN_ESX_MAJOR
        ? {
            id: 'esx-version',
            label: 'ESX version',
            status: 'pass',
            detail: `${host.esxVersion} meets the 8.0 U3a minimum for VCF 9.1 conversion.`,
          }
        : {
            id: 'esx-version',
            label: 'ESX version',
            status: 'fail',
            detail: `${host.esxVersion} is below 8.0; VCF 9.1 cannot converge this host as-is.`,
            requiredFor: 'Brownfield conversion',
          },
  );

  // --- memory --------------------------------------------------------------
  checks.push(
    host.memoryGib <= 0
      ? { id: 'memory', label: 'Memory', status: 'unknown', detail: 'No memory reported.' }
      : host.memoryGib >= VSAN_ESA_MIN_HOST_RAM_GIB
        ? {
            id: 'memory',
            label: 'Memory',
            status: 'pass',
            detail: `${host.memoryGib} GiB meets the ${VSAN_ESA_MIN_HOST_RAM_GIB} GiB vSAN ESA floor.`,
          }
        : {
            id: 'memory',
            label: 'Memory',
            status: 'fail',
            detail: `${host.memoryGib} GiB is below the ${VSAN_ESA_MIN_HOST_RAM_GIB} GiB vSAN ESA requires.`,
            requiredFor: 'vSAN ESA',
          },
  );

  // --- NVMe ----------------------------------------------------------------
  const nvme = nvmeCount(host);
  checks.push(
    nvme === null
      ? {
          id: 'nvme',
          label: 'NVMe devices',
          status: 'unknown',
          detail: 'No storage device inventory. Run the PowerCLI collector to capture this.',
          requiredFor: 'vSAN ESA',
        }
      : nvme > 0
        ? {
            id: 'nvme',
            label: 'NVMe devices',
            status: 'pass',
            detail: `${nvme} NVMe device(s) present.`,
          }
        : {
            id: 'nvme',
            label: 'NVMe devices',
            status: 'fail',
            detail: 'No NVMe devices. vSAN ESA requires NVMe TLC; this host could still use OSA or external storage.',
            requiredFor: 'vSAN ESA',
          },
  );

  // --- NIC speed -----------------------------------------------------------
  const nicMb = fastestNicMb(host);
  checks.push(
    nicMb === null
      ? {
          id: 'nic-speed',
          label: 'NIC speed',
          status: 'unknown',
          detail: 'No physical NIC inventory. Run the PowerCLI collector to capture link speeds.',
        }
      : nicMb >= ESA_RECOMMENDED_NIC_MB
        ? {
            id: 'nic-speed',
            label: 'NIC speed',
            status: 'pass',
            detail: `${nicMb / 1000} GbE meets the 25GbE vSAN ESA recommendation.`,
          }
        : nicMb >= MIN_NIC_MB
          ? {
              id: 'nic-speed',
              label: 'NIC speed',
              status: 'warn',
              detail: `${nicMb / 1000} GbE is above the 10GbE floor but below the 25GbE recommended for vSAN ESA.`,
              requiredFor: 'vSAN ESA at full performance',
            }
          : {
              id: 'nic-speed',
              label: 'NIC speed',
              status: 'fail',
              detail: `${nicMb / 1000} GbE is below the 10GbE minimum.`,
              requiredFor: 'VCF networking',
            },
  );

  // --- NIC redundancy ------------------------------------------------------
  const nicCount = host.physicalNics?.length ?? host.nicCount ?? null;
  checks.push(
    nicCount === null
      ? { id: 'nic-count', label: 'NIC redundancy', status: 'unknown', detail: 'NIC count not reported.' }
      : nicCount >= 2
        ? {
            id: 'nic-count',
            label: 'NIC redundancy',
            status: 'pass',
            detail: `${nicCount} physical NICs allow redundant uplinks.`,
          }
        : {
            id: 'nic-count',
            label: 'NIC redundancy',
            status: 'warn',
            detail: `Only ${nicCount} physical NIC; there is no uplink redundancy.`,
          },
  );

  // --- licensing efficiency ------------------------------------------------
  checks.push(
    host.coresPerSocket <= 0
      ? { id: 'core-density', label: 'Core density', status: 'unknown', detail: 'Core count not reported.' }
      : host.coresPerSocket >= LICENSE_MIN_CORES_PER_CPU
        ? {
            id: 'core-density',
            label: 'Core density',
            status: 'pass',
            detail: `${host.coresPerSocket} cores per CPU, at or above the ${LICENSE_MIN_CORES_PER_CPU}-core licensing floor.`,
          }
        : {
            id: 'core-density',
            label: 'Core density',
            status: 'warn',
            detail: `${host.coresPerSocket} cores per CPU is below the ${LICENSE_MIN_CORES_PER_CPU}-core minimum, so licensing bills ${LICENSE_MIN_CORES_PER_CPU * host.cpuSockets} cores for ${host.coresPerSocket * host.cpuSockets}.`,
          },
  );

  // --- TPM -----------------------------------------------------------------
  checks.push(
    host.tpmPresent === undefined
      ? { id: 'tpm', label: 'TPM', status: 'unknown', detail: 'TPM presence not reported.' }
      : host.tpmPresent
        ? { id: 'tpm', label: 'TPM', status: 'pass', detail: 'TPM present.' }
        : {
            id: 'tpm',
            label: 'TPM',
            status: 'warn',
            detail: 'No TPM. Required for some vSphere security baselines, not for VCF itself.',
          },
  );

  const blockers = checks.filter((c) => c.status === 'fail').length;
  const warnings = checks.filter((c) => c.status === 'warn').length;
  const unknowns = checks.filter((c) => c.status === 'unknown').length;

  return { host: host.name, checks, blockers, warnings, unknowns, viable: blockers === 0 };
}

                                  
                                  
                              
                                
                                                    
                              
                                        
 

export function assessEstate(inventory           )                  {
  const hosts = inventory.hosts.map(assessHost);
  const findings            = [];

  const blocked = hosts.filter((h) => !h.viable);
  const readyHosts = hosts.length - blocked.length;

  // vSAN is a cluster-wide decision, so one unsuitable host rules ESA out for
  // every host in that cluster.
  const withoutNvme = inventory.hosts.filter((h) => nvmeCount(h) === 0);
  const unknownNvme = inventory.hosts.filter((h) => nvmeCount(h) === null);
  const esaViable = inventory.hosts.length > 0 && withoutNvme.length === 0 && unknownNvme.length === 0;

  if (withoutNvme.length > 0) {
    findings.push(
      error(
        'readiness.esa.no-nvme',
        `${withoutNvme.length} host(s) have no NVMe devices, so vSAN ESA is not possible for their cluster.`,
        {
          remediation: 'Use vSAN OSA or external storage for those clusters, or add NVMe devices.',
          source: 'vSAN 9.1 hardware requirements',
        },
      ),
    );
  }

  if (unknownNvme.length > 0 && withoutNvme.length === 0) {
    findings.push(
      warning(
        'readiness.esa.unknown-storage',
        `Storage device detail is missing for ${unknownNvme.length} host(s), so vSAN ESA eligibility cannot be confirmed.`,
        {
          remediation: 'Run tools/collector/Export-AtkInventory.ps1, which captures NVMe presence. RVTools does not.',
        },
      ),
    );
  }

  const slowNics = inventory.hosts.filter((h) => {
    const speed = fastestNicMb(h);
    return speed !== null && speed < ESA_RECOMMENDED_NIC_MB;
  });
  if (slowNics.length > 0) {
    findings.push(
      warning(
        'readiness.nic.below-25gbe',
        `${slowNics.length} host(s) have no NIC at 25GbE or above, which is the vSAN ESA recommendation.`,
        { source: 'vSAN 9.1 network guidance' },
      ),
    );
  }

  if (blocked.length > 0) {
    findings.push(
      error(
        'readiness.hosts.blocked',
        `${blocked.length} of ${hosts.length} host(s) have a blocking issue: ${blocked
          .slice(0, 5)
          .map((h) => h.host)
          .join(', ')}${blocked.length > 5 ? '…' : ''}`,
      ),
    );
  } else if (hosts.length > 0) {
    findings.push(
      info('readiness.hosts.all-viable', `All ${hosts.length} host(s) pass the blocking checks.`),
    );
  }

  const totalUnknown = hosts.reduce((sum, h) => sum + h.unknowns, 0);
  if (totalUnknown > 0) {
    findings.push(
      info(
        'readiness.incomplete-data',
        `${totalUnknown} check(s) could not be evaluated because the source data does not carry those fields.`,
        {
          remediation:
            'The PowerCLI collector captures NVMe devices, NIC link speeds, VMkernel adapters and TPM state; an RVTools export does not.',
        },
      ),
    );
  }

  return { hosts, readyHosts, blockedHosts: blocked.length, esaViable, findings };
}
