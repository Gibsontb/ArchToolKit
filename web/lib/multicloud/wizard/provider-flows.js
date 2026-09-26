/**
 * How each provider migrates, as the user approved it in the flow review
 * (research 6(a) and 6(d); the "cloud flows" comparison): its framework, its
 * phases, what is set up first, how it connects to the data centre, how it
 * discovers, the tools per source, how it cuts over and rolls back, its gates
 * and its words. The wizard's step labels and the Migration card read it, so
 * the page says what the chosen provider says.
 *
 * Facts as of 2026-09-26.
 */

                                                 

                               
                        
                             
                                                                
                                                          
                         
                           
                            
                       
                                                         
                           
                         
                         
                        
                                                                  
                             
 

export const PROVIDER_FLOWS                                           = {
  aws: {
    name: 'Amazon Web Services (AWS)',
    framework: 'AWS Cloud Adoption Framework, Migration Acceleration Program, AWS Prescriptive Guidance',
    phases: [
      ['Assess', 'Readiness assessment, rapid discovery, high-level TCO and business case.'],
      ['Mobilize', 'Landing zone, security, operations and people workstreams; a pilot of 10 to 30 apps.'],
      ['Migrate: Initialize', 'Runbooks per pattern, automation, health checks (1 to 3 months).'],
      ['Migrate: Implement', 'Waves at scale: portfolio stays about five waves ahead of migration.'],
      ['Hypercare', 'Stabilise, hand over to cloud operations, then decommission.'],
    ],
    first: 'Landing zone: AWS Control Tower with the Landing Zone Accelerator (accounts, guardrails, logging, network).',
    connect: 'AWS Direct Connect, or Site-to-Site VPN.',
    discover: 'AWS Transform (Migration Hub and Application Discovery Service are closed to new customers).',
    tools: [
      ['VMware, Hyper-V, physical', 'AWS Transform MGN (formerly Application Migration Service): agent, or agentless for vCenter'],
      ['Keep it on VMware', 'Amazon Elastic VMware Service (EVS), moved with HCX'],
      ['Databases', 'AWS DMS with Schema Conversion; native backup and restore'],
      ['Files and bulk data', 'DataSync online; Data Transfer Terminal or a partner offline (Snowball is closed to new customers)'],
      ['Containers', 'App2Container, or rebuild on EKS'],
    ],
    cutover: 'Launch a test instance, mark ready for cutover, launch cutover, finalize. Rollback reverts to ready-for-cutover while replication still runs.',
    gates: 'T-minus gates: T-21, T-14, T-7, go/no-go at T-1, cutover at T-0, then hypercare.',
    words: 'Move group, wave, test instance, cutover, hypercare. Strategy "Repurchase".',
    note: 'AWS renamed Application Migration Service to "AWS Transform MGN" on 8 June 2026. The APIs are unchanged.',
    waveLabel: 'Wave',
  },
  azure: {
    name: 'Microsoft Azure',
    framework: 'Cloud Adoption Framework (CAF) and Azure Migrate',
    phases: [
      ['Strategy and Plan', 'Business case, discover the inventory, assess each workload, choose the strategy.'],
      ['Ready', 'Azure landing zone: platform and application landing zones, governance and security baselines.'],
      ['Migrate: plan and prepare', 'Wave plan; prepare each workload (fix blockers found by assessment).'],
      ['Migrate: execute', 'Replicate, test migration, cut over, keep a fallback, support during stabilisation.'],
      ['Optimize and decommission', 'Right-size and tune, then decommission the source.'],
    ],
    first: 'Azure landing zone: management groups, policy, identity, hub network, logging.',
    connect: 'ExpressRoute, or VPN Gateway.',
    discover: 'Azure Migrate appliance (agentless) or the collector; readiness as Ready / Conditionally ready / Not ready.',
    tools: [
      ['VMware, Hyper-V', 'Azure Migrate agentless replication'],
      ['Physical and other clouds', 'Azure Migrate agent-based replication (Mobility service)'],
      ['Keep it on VMware', 'Azure VMware Solution (AVS), moved with HCX'],
      ['Databases', 'Azure Database Migration Service; SQL Managed Instance link or Log Replay Service'],
      ['Files and bulk data', 'Storage Mover, AzCopy, Data Box (the new 120 TB / 525 TB devices; Heavy is retired)'],
    ],
    cutover: 'Test migration in an isolated network, then Migrate (can shut the source down), then Complete migration. Keep the fallback until stabilisation ends.',
    gates: 'Stakeholder approvals per wave; test migration before every production move.',
    words: 'Dependency group, migration wave, test migration, migrate, stabilization. Strategy "Replace".',
    note: 'CAF Migrate was rewritten in 2025 into five steps: plan, prepare, execute, optimize, decommission.',
    waveLabel: 'Migration wave',
  },
  google: {
    name: 'Google Cloud (GCP)',
    framework: 'Migrate to Google Cloud, Migration Center, Google Cloud Adoption Framework',
    phases: [
      ['Assess', 'Inventory and catalogue, technical fit, TCO report, proof of concept.'],
      ['Plan', 'Build the foundation; move groups and waves in Migration Center.'],
      ['Deploy', 'Replicate, test-clone, cut over, finalize; databases with Database Migration Service.'],
      ['Optimize', 'Right-size, minimise costs, lessons learned.'],
    ],
    first: 'Foundation: the enterprise foundations blueprint (organisation, folders, projects, Shared VPC, logging).',
    connect: 'Cloud Interconnect, or HA VPN.',
    discover: 'Migration Center with the discovery client; sizing preference None / Moderate / Aggressive.',
    tools: [
      ['VMware, AWS, Azure', 'Migrate to Virtual Machines'],
      ['Physical and others', 'Image import (disk images into Compute Engine)'],
      ['Keep it on VMware', 'Google Cloud VMware Engine (GCVE), moved with HCX'],
      ['Databases', 'Database Migration Service (one-time or continuous)'],
      ['Files and bulk data', 'Storage Transfer Service; Transfer Appliance offline'],
    ],
    cutover: 'Test-clone, then cut-over, then finalize. Databases promote the replica; the fallback is the source.',
    gates: 'Migration sprints: plan, deploy, optimize, each with RACI and cadence.',
    words: 'Move group, wave, test-clone, cut-over, finalize. Strategy "Repurchase".',
    note: 'The execution API for VMs is vmmigration.googleapis.com; Migration Center holds the planning.',
    waveLabel: 'Wave',
  },
  oci: {
    name: 'Oracle Cloud Infrastructure (OCI)',
    framework: 'Oracle Cloud Adoption Framework, OCI Cloud Migrations, Zero Downtime Migration',
    phases: [
      ['Manage assets', 'Discovery and inventory with the remote agent appliance.'],
      ['Plan and migrate', 'Migration project and plan, target assets, replication.'],
      ['Verify', 'Deploy the stack, test, mark the migration complete.'],
    ],
    first: 'Landing zone: OCI Core Landing Zone, or the Operating Entities landing zone (compartments, IAM, network, logging).',
    connect: 'FastConnect, or Site-to-Site VPN.',
    discover: 'Remote agent appliance; compatibility as ERROR / WARNING / INFO.',
    tools: [
      ['VMware, AWS', 'Oracle Cloud Migrations (OCM)'],
      ['Keep it on VMware', 'Oracle Cloud VMware Solution (OCVS), moved with HCX'],
      ['Oracle databases', 'Zero Downtime Migration (physical or logical); Data Guard'],
      ['Other databases', 'OCI Database Migration Service'],
      ['Files and bulk data', 'oci os object sync; Roving Edge (the Data Transfer appliance is end of life)'],
    ],
    cutover: 'Deploy the Resource Manager stack, validate, then mark the migration complete. ZDM switches over, with a fallback to the source.',
    gates: 'No waves of its own: one migration project per cutover event.',
    words: 'Migration project, migration plan, target asset, mark migration complete. Strategy "Replace".',
    note: 'OCI has no wave concept. The toolkit keeps its waves and labels them as its own on OCI.',
    waveLabel: 'Wave (ArchToolKit wave)',
  },
  vmware: {
    name: 'VMware Cloud Foundation (VCF) 9.1',
    framework: 'VCF deploy, converge and import; HCX; VCF Operations for networks',
    phases: [
      ['Analyze', 'Workloads and flows in VCF Operations for networks.'],
      ['Waves', 'Group by dependency into waves.'],
      ['Mobility Groups', 'HCX Mobility Groups: destination, migration type, schedule.'],
      ['Migrate and switchover', 'Replicate, then switchover in the window.'],
      ['Commit', 'Clean up, unextend networks, decommission.'],
    ],
    first: 'Management domain and workload domain (or converge / import the existing vSphere); HCX site pairing and service mesh.',
    connect: 'HCX network extension, NSX, and VPN or a routed link.',
    discover: 'VCF Operations for networks collector; HCX pre-migration checks.',
    tools: [
      ['vSphere', 'HCX Bulk, vMotion, Replication Assisted vMotion, Cold'],
      ['Hyper-V, KVM, physical', 'HCX OS Assisted Migration, or vCenter Converter'],
      ['Existing vSphere into VCF', 'VCF Import / Converge (no copy)'],
      ['To a hyperscaler', 'AVS, GCVE, EVS or OCVS through HCX'],
      ['Databases', 'Move with the VM, or the native tools'],
    ],
    cutover: 'Scheduled switchover. Rollback is a reverse migration, or the retained source VM (Bulk).',
    gates: 'Pre-migration checks; underlay minimums (vMotion and RAV 150 to 250 Mbps, Bulk 50 Mbps, 150 ms or less).',
    words: 'Mobility Group, migration wave, switchover. Management and workload domains.',
    note: 'HCX WAN Optimization is back in VCF 9.1, inside the enhanced service mesh.',
    waveLabel: 'Migration wave',
  },
};
