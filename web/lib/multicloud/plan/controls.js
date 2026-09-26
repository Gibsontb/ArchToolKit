/**
 * Cyber controls and DR patterns per platform, as typed data, for the decision
 * record.
 *
 * Ported from the retired wizard's `buildCyberChecklist` and
 * `buildDrPatternCard` (src/multicloud/wizard/engine.js), which wrote them as
 * HTML strings from about fifty DOM answers. The checks now read the plan's
 * Requirements, and the per-platform service names that were buried in the
 * wizard's prose (Security Hub, Defender for Cloud, Security Command Center,
 * Cloud Guard) are rows. The wizard's F5 and CI/CD questions are gone: F5 was
 * never generated, and the planner writes the infrastructure as code itself.
 *
 * VMware names are VCF 9.1's: VCF Operations, VCF Operations for logs,
 * vDefend, VMware Live Recovery.
 */

                                                
import { DR_PATTERN_OPTIONS, labelOf, PLATFORM_LABELS } from './options.js';
                                                                       

// ---------------------------------------------------------------------------
// The per-platform control rows
// ---------------------------------------------------------------------------

                         
             
                      
                   
                   
          
               
                
          
            
                       
                

                               
                      
                             
                         
                                                                        
                                                        
 

export const CYBER_CONTROLS                          = Object.freeze([
  {
    id: 'ctl.posture',
    area: 'posture',
    title: 'Security posture management against the baseline',
    services: {
      aws: 'AWS Security Hub, with AWS Config rules',
      azure: 'Microsoft Defender for Cloud, with Azure Policy',
      google: 'Security Command Center',
      oci: 'OCI Cloud Guard, with Security Zones',
      vmware: 'VCF Operations compliance (vSphere and NSX security configuration)',
    },
  },
  {
    id: 'ctl.threat-detection',
    area: 'threat-detection',
    title: 'Threat detection',
    services: {
      aws: 'Amazon GuardDuty',
      azure: 'Microsoft Defender for Cloud (Defender for Servers)',
      google: 'Security Command Center threat detection',
      oci: 'OCI Cloud Guard threat detectors',
      vmware: 'vDefend Advanced Threat Prevention',
    },
  },
  {
    id: 'ctl.audit-logging',
    area: 'audit-logging',
    title: 'Control-plane audit logging, kept for the log retention period',
    services: {
      aws: 'AWS CloudTrail (organisation trail)',
      azure: 'Azure Activity Log to Log Analytics',
      google: 'Cloud Audit Logs',
      oci: 'OCI Audit',
      vmware: 'VCF Operations for logs',
    },
  },
  {
    id: 'ctl.observability',
    area: 'observability',
    title: 'Metrics, logs and flow logs',
    services: {
      aws: 'Amazon CloudWatch and VPC Flow Logs',
      azure: 'Azure Monitor, Log Analytics and VNet flow logs',
      google: 'Cloud Monitoring, Cloud Logging and VPC Flow Logs',
      oci: 'OCI Monitoring, Logging and VCN flow logs',
      vmware: 'VCF Operations and VCF Operations for networks',
    },
  },
  {
    id: 'ctl.keys',
    area: 'keys',
    title: 'Encryption at rest with managed keys',
    services: {
      aws: 'AWS KMS (AWS CloudHSM for HSM-backed keys)',
      azure: 'Azure Key Vault (Managed HSM for HSM-backed keys)',
      google: 'Cloud KMS (Cloud HSM for HSM-backed keys)',
      oci: 'OCI Vault (HSM-protected keys)',
      vmware: 'vSphere VM Encryption with a key provider (native or an external KMS)',
    },
  },
  {
    id: 'ctl.perimeter',
    area: 'perimeter',
    title: 'Network perimeter: firewalls and WAF on internet-facing endpoints',
    services: {
      aws: 'AWS Network Firewall, security groups and AWS WAF',
      azure: 'Azure Firewall, network security groups and Azure WAF (Front Door / Application Gateway)',
      google: 'Cloud NGFW firewall policies and Cloud Armor',
      oci: 'OCI Network Firewall, network security groups and OCI WAF',
      vmware: 'vDefend Distributed Firewall and Gateway Firewall',
    },
  },
  {
    id: 'ctl.guardrails',
    area: 'guardrails',
    title: 'Guardrails as code: the generated Terraform, tagging and policy',
    services: {
      aws: 'AWS Organizations service control policies',
      azure: 'Azure Policy at the management group',
      google: 'Organization Policy constraints',
      oci: 'OCI IAM policies and Security Zones',
      vmware: 'VCF Automation policies',
    },
  },
  {
    id: 'ctl.siem',
    area: 'siem',
    title: 'Security events to the SIEM, with owners for critical alerts',
    services: {
      aws: 'Security Hub and CloudTrail forwarded to the SIEM',
      azure: 'Microsoft Sentinel data connectors, or forwarding to the SIEM',
      google: 'Google Security Operations, or forwarding to the SIEM',
      oci: 'OCI Logging connector hub forwarding to the SIEM',
      vmware: 'VCF Operations for logs forwarding to the SIEM',
    },
  },
  {
    id: 'ctl.backup',
    area: 'backup',
    title: 'Backup by tier, with immutable copies for gold',
    services: {
      aws: 'AWS Backup (vault lock for immutability)',
      azure: 'Azure Backup (immutable vaults)',
      google: 'Backup and DR Service (backup vaults)',
      oci: 'OCI Block Volume backups and Object Storage retention rules',
      vmware: 'Your backup product, with VMware Live Cyber Recovery for immutable copies',
    },
  },
  {
    id: 'ctl.disaster-recovery',
    area: 'disaster-recovery',
    title: 'Disaster recovery to the DR region, tested',
    services: {
      aws: 'AWS Elastic Disaster Recovery, cross-region replication and Route 53 failover',
      azure: 'Azure Site Recovery, geo-replication and Front Door / Traffic Manager',
      google: 'Backup and DR Service, regional replicas and Cloud DNS routing policies',
      oci: 'OCI Full Stack Disaster Recovery and Data Guard',
      vmware: 'VMware Live Site Recovery and vSphere Replication',
    },
  },
  {
    id: 'ctl.regulated',
    area: 'regulated',
    title: 'Regulated and government workloads in the right regions',
    services: {
      aws: 'AWS GovCloud (US) or the AWS European Sovereign Cloud, as the framework requires',
      azure: 'Azure Government or an Azure sovereign region, as the framework requires',
      google: 'Assured Workloads, with VPC Service Controls',
      oci: 'OCI US Government, National Security Regions or the OCI EU Sovereign Cloud',
      vmware: 'Your own data centres: the sovereignty is yours to evidence',
    },
  },
]);

// ---------------------------------------------------------------------------
// DR patterns
// ---------------------------------------------------------------------------

                                
                              
                         
                           
                                                                
                         
                                                           
 

export const DR_PATTERNS                                             = Object.freeze({
  'backup-restore': {
    pattern: 'backup-restore',
    label: labelOf(DR_PATTERN_OPTIONS, 'backup-restore'),
    summary: 'Nothing runs in the DR region; backups are copied there and restored on declaration.',
    suits: 'RTO of a day or more; RPO of the backup frequency.',
    perPlatform: {
      aws: 'AWS Backup cross-region copies; restore with the generated Terraform in the DR region.',
      azure: 'Azure Backup with cross-region restore; the generated Terraform rebuilds the landing zone.',
      google: 'Backup and DR Service copies to the DR region; restore into the DR landing zone.',
      oci: 'Block volume and database backups copied cross-region; restore into the DR compartment.',
      vmware: 'Backups replicated to the second site; restore there.',
    },
  },
  'pilot-light': {
    pattern: 'pilot-light',
    label: labelOf(DR_PATTERN_OPTIONS, 'pilot-light'),
    summary: 'Data is replicated continuously; the compute is defined but off until declaration.',
    suits: 'RTO of hours; RPO of minutes.',
    perPlatform: {
      aws: 'AWS Elastic Disaster Recovery keeps staging replicas; databases replicate cross-region.',
      azure: 'Azure Site Recovery replicates the VMs; databases geo-replicate.',
      google: 'Regional disk replication and database cross-region replicas; instances created on failover.',
      oci: 'OCI Full Stack Disaster Recovery with Data Guard standbys and replicated volumes.',
      vmware: 'VMware Live Site Recovery with vSphere Replication; VMs power on at the recovery site.',
    },
  },
  'warm-standby': {
    pattern: 'warm-standby',
    label: labelOf(DR_PATTERN_OPTIONS, 'warm-standby'),
    summary: 'A scaled-down copy runs in the DR region and is scaled up on failover.',
    suits: 'RTO under an hour; RPO of minutes or less.',
    perPlatform: {
      aws: 'A smaller running stack in the DR region, Route 53 failover records, cross-region database replicas.',
      azure: 'A smaller running stack in the paired region, Front Door / Traffic Manager failover, geo-replication.',
      google: 'A smaller running stack in the DR region, global load balancing, cross-region replicas.',
      oci: 'A smaller running stack in the DR region, DNS steering, Data Guard standbys.',
      vmware: 'Running standby VMs at the second site, VMware Live Site Recovery for orchestration.',
    },
  },
  'active-active': {
    pattern: 'active-active',
    label: labelOf(DR_PATTERN_OPTIONS, 'active-active'),
    summary: 'Both regions serve traffic; losing one loses capacity, not service.',
    suits: 'RTO and RPO near zero; the application must tolerate it.',
    perPlatform: {
      aws: 'Both regions live behind Route 53 latency or weighted routing; multi-Region data stores.',
      azure: 'Both regions live behind Front Door; zone- and geo-redundant data.',
      google: 'Global load balancing across regions; multi-region data stores.',
      oci: 'Both regions live behind DNS traffic steering; Active Data Guard or GoldenGate.',
      vmware: 'Stretched clusters or both sites live; the application replicates its own data.',
    },
  },
});

/** Everything this module holds, for the decision record. */
export const CONTROLS = Object.freeze({ cyber: CYBER_CONTROLS, dr: DR_PATTERNS });

// ---------------------------------------------------------------------------
// The checklist: the ported checks, reading the plan's requirements
// ---------------------------------------------------------------------------

                                          
                                
                      
                              
                               
                        
 

const BASELINE_LABEL                                                             = {
  'cis-l1': 'CIS Level 1',
  'cis-l2': 'CIS Level 2',
  stig: 'DISA STIG',
  internal: 'the internal standard',
};

/**
 * The cyber checklist for each platform in the result, as the wizard wrote it,
 * but from the plan: baseline, SIEM, keys, perimeter, DR posture, guardrails.
 */
export function cyberChecklist(requirements              , platforms                     , hasTier01          = true)                  {
  const items                  = [];
  const regulated = requirements.frameworks.length > 0 || requirements.sovereignty !== 'none';
  const service = (id        , p          ) => CYBER_CONTROLS.find((c) => c.id === id)?.services[p] ?? '';

  for (const p of platforms) {
    const add = (id        , status             , text        ) => items.push({ id, platform: p, status, text });
    const name = PLATFORM_LABELS[p];

    // Baseline (the wizard's "minimal" baseline no longer exists: every choice is a real standard).
    if (regulated && requirements.securityBaseline === 'internal') {
      add('ctl.posture', 'action', `${name}: regulated data under an internal baseline; map it to CIS or STIG controls and check it with ${service('ctl.posture', p)}.`);
    } else {
      add('ctl.posture', 'ok', `${name}: security baseline ${BASELINE_LABEL[requirements.securityBaseline]}, checked by ${service('ctl.posture', p)}.`);
    }

    // SecOps: was "basic / central SIEM / mature DevSecOps".
    if (requirements.siem === 'none') {
      add('ctl.siem', 'action', `${name}: no SIEM; centralise ${service('ctl.audit-logging', p)} and threat findings, define alert routing and write the first runbooks.`);
    } else {
      add('ctl.siem', 'ok', `${name}: onboard to the SIEM (${requirements.siem}) with owners for critical alerts: ${service('ctl.siem', p)}.`);
    }

    // Perimeter: cloud-native only now; the F5 variants are gone.
    add('ctl.perimeter', 'ok', `${name}: ${service('ctl.perimeter', p)} on every internet-facing endpoint.`);

    // Data protection: was "at rest / in transit and at rest / field-level".
    if (requirements.keys === 'provider-managed' && regulated) {
      add('ctl.keys', 'action', `${name}: regulated data on provider-managed keys; move to customer-managed keys in ${service('ctl.keys', p)}.`);
    } else {
      const which = requirements.keys === 'hsm' ? 'HSM-backed' : requirements.keys === 'customer-managed' ? 'customer-managed' : 'provider-managed';
      add('ctl.keys', 'ok', `${name}: encryption at rest with ${which} keys (${service('ctl.keys', p)}) and TLS in transit, including internal APIs.`);
    }

    // DR posture: was "multi-region and tight RTO/RPO".
    const drRegion = requirements.regions[p]?.dr;
    const tight = requirements.drPattern.tier0 !== 'backup-restore' || requirements.drPattern.tier1 !== 'backup-restore';
    if (drRegion && tight) {
      const pattern = requirements.drPattern.tier0;
      add('ctl.disaster-recovery', 'ok', `${name}: ${DR_PATTERNS[pattern].label.toLowerCase()} for Tier 0 to ${drRegion}; rehearse failover and failback, and test the DNS or traffic switch.`);
    } else if (!drRegion && hasTier01 && p !== 'vmware') {
      add('ctl.disaster-recovery', 'action', `${name}: Tier 0/1 in a single region; either accept that risk explicitly or add a DR region.`);
    } else {
      add('ctl.disaster-recovery', 'ok', `${name}: a backup-and-restore pattern is acceptable for this criticality and RTO/RPO band.`);
    }

    // IaC: the planner generates it, so this is always met.
    add('ctl.guardrails', 'ok', `${name}: landing zone and guardrails are generated as Terraform; enforce tags and policy through ${service('ctl.guardrails', p)}.`);

    if (regulated && p !== 'vmware' && requirements.sovereignty !== 'none') {
      add('ctl.regulated', 'action', `${name}: sovereignty "${requirements.sovereignty}" needs ${service('ctl.regulated', p)}.`);
    }
  }
  return items;
}

/** The DR pattern a criticality tier gets, with its text for a platform. */
export function drPatternFor(criticality             , requirements              , platform          )                                                                                 {
  const pattern = requirements.drPattern[criticality];
  const info = DR_PATTERNS[pattern];
  return { pattern, label: info.label, text: `${info.summary} ${info.perPlatform[platform]}` };
}
