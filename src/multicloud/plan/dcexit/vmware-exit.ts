import type { Plan, WavePlan } from '../types.ts';

export const PROJECT_DESTINATION_KEY = 'migration:setup:destination';
export const HOSTED_VMWARE_SERVICES = [
  { value: 'evs', label: 'Amazon Elastic VMware Service (EVS)' },
  { value: 'avs', label: 'Azure VMware Solution (AVS)' },
  { value: 'gcve', label: 'Google Cloud VMware Engine (GCVE)' },
  { value: 'ocvs', label: 'Oracle Cloud VMware Solution (OCVS)' },
] as const;

export interface ExitTarget {
  readonly id: string;
  readonly name: string;
  readonly source: string;
  readonly delivery: 'existing-kit' | 'integration-needed';
  readonly landing: string;
  readonly transfer: string;
  readonly validate: string;
  readonly implementation: string;
  readonly reference?: string;
}

export const EXIT_TARGETS: readonly ExitTarget[] = [
  { id: 'ahv', name: 'Nutanix AOS / AHV', source: 'AHV source adapter', delivery: 'integration-needed',
    landing: 'Qualify hardware and build AOS/AHV capacity, Prism, storage containers, VLANs and Flow policies.',
    transfer: 'Use a supported Nutanix Move release. Map networks and storage, seed on a nonproduction wave, and schedule the final sync.',
    validate: 'Check guest drivers, boot, IP assignments, Flow policy, backup restore and application consistency.',
    implementation: 'Add Prism landing-zone modules and a Move job adapter with polling, test cleanup and rollback status.',
    reference: 'https://next.nutanix.com/product-updates/nutanix-move-6-3-45782' },
  { id: 'openshift', name: 'Red Hat OpenShift Virtualization', source: 'Inventory import requires mapping and an adapter', delivery: 'integration-needed',
    landing: 'Build OpenShift Virtualization with approved storage classes, ODF or alternate storage, and OVN network policy.',
    transfer: 'Use MTV with vCenter inventory, storage and network maps. Check the release-specific FIPS and vSphere constraints before choosing warm or cold.',
    validate: 'Test PVCs, guest boot, policy behavior, backups and application dependencies in an isolated namespace.',
    implementation: 'Generate Provider, NetworkMap, StorageMap, Plan and Migration resources. Watch Forklift conditions and report partial failures.',
    reference: 'https://docs.redhat.com/en/documentation/migration_toolkit_for_virtualization/2.11' },
  { id: 'azure-local', name: 'Microsoft Azure Local', source: 'Hyper-V source intake. Azure Local discovery needs qualification.', delivery: 'integration-needed',
    landing: 'Qualify nodes, Storage Spaces Direct, logical networks, Arc resource bridge and the approved Azure control plane.',
    transfer: 'Register the source and target Azure Migrate appliances. Use Microsoft’s Azure Local discovery, replication and planned-failover workflow.',
    validate: 'Check Arc projection, OS and data disks, virtual switch, failover clustering, backup and monitoring.',
    implementation: 'Integrate the documented Azure Local Terraform module or CLI with protected-item IDs and phase-specific state. Verify region and sovereign endpoint support.',
    reference: 'https://learn.microsoft.com/en-us/azure/azure-local/migrate/migrate-via-powershell' },
  { id: 'hyperv', name: 'Windows Server Hyper-V', source: 'Hyper-V source adapter', delivery: 'integration-needed',
    landing: 'Prepare approved Windows Server hosts, clustered storage, virtual switches, host hardening and backup.',
    transfer: 'Qualify a supported VMware conversion tool and pilot VMDK-to-VHDX with explicit firmware, disk and network mappings.',
    validate: 'Confirm Generation 1 or 2 boot, Secure Boot, guest services, failover and restore.',
    implementation: 'Build a separate Hyper-V conversion and PowerShell job adapter. Keep Azure Local operations distinct.' },
  { id: 'hpe', name: 'HPE Morpheus VM Essentials / Alletra dHCI', source: 'HVM inventory and lifecycle adapter needed', delivery: 'integration-needed',
    landing: 'Qualify supported HVM nodes, datastores, networks and the Alletra storage integration for the exact configuration.',
    transfer: 'Use the Morpheus VM Essentials VMware vCenter-to-HVM bulk migration workflow for supported versions.',
    validate: 'Verify replacement storage, guest boot, network policies and backup integration.',
    implementation: 'Qualify supported Morpheus APIs, produce HVM mapping and prerequisite artifacts, and integrate job status.',
    reference: 'https://support.hpe.com/hpesc/public/docDisplay?docId=sd00008374en_us&docLocale=en_US&page=GUID-4CCF6004-31A7-4B35-996D-5E12877CB443.html' },
  { id: 'openstack', name: 'Canonical / Mirantis OpenStack', source: 'Nova and Neutron inventory and lifecycle adapter needed', delivery: 'integration-needed',
    landing: 'Stand up Nova, Glance, Cinder and Neutron with approved networks, images, quotas, storage and Keystone roles.',
    transfer: 'Qualify VM conversion and Glance import or rebuild. Pilot conversion for the actual guest OS, boot firmware and disk layout.',
    validate: 'Check Neutron policy, IP allocation, boot, Cinder volumes and backup restore.',
    implementation: 'Build OpenStack Terraform landing-zone modules, an image conversion and import adapter, and Ansible guest baselines.',
    reference: 'https://docs.openstack.org/image-guide/convert-images.html' },
  { id: 'olvm', name: 'Oracle Linux Virtualization Manager', source: 'oVirt / OLVM source adapter', delivery: 'integration-needed',
    landing: 'Build approved OLVM clusters, storage domains and vNIC profiles. Review Oracle workload licensing boundaries.',
    transfer: 'Pilot Oracle’s virt-v2v flow or Oracle Linux Automation Manager on supported vSphere and OLVM versions.',
    validate: 'Verify driver injection, vNIC mapping, storage, fencing and database backups.',
    implementation: 'Generate controller inventory and a virt-v2v job adapter with storage/network mapping and result reconciliation.',
    reference: 'https://docs.oracle.com/en/learn/olam-virt-v2v/' },
  { id: 'proxmox', name: 'Proxmox VE', source: 'Proxmox source adapter', delivery: 'integration-needed',
    landing: 'Qualify cluster, storage, bridges, backups and the approved hardening baseline.',
    transfer: 'Pilot the ESXi import wizard or an offline OVF import with the associated disks. Record the required outage.',
    validate: 'Check firmware, boot order, disk controller, VirtIO drivers, networking and backup restore.',
    implementation: 'Add a Proxmox import task adapter and Terraform adoption. Model the offline import explicitly.',
    reference: 'https://pve.proxmox.com/pve-docs/pve-admin-guide.pdf' },
  { id: 'harvester', name: 'SUSE Virtualization / Harvester', source: 'KubeVirt inventory and lifecycle adapter needed', delivery: 'integration-needed',
    landing: 'Qualify storage and network mappings, cluster capacity, and space for import staging.',
    transfer: 'Pilot the VM Import add-on for the supported VMware and destination release pair.',
    validate: 'Check guest boot, storage attachment, network policies and recovery from backups.',
    implementation: 'Generate import resources and watch import status. Add target Terraform and Ansible configuration where supported.',
    reference: 'https://docs.harvesterhci.io/v1.6/advanced/addons/vmimport/' },
  { id: 'govcloud', name: 'AWS GovCloud (US)', source: 'AWS source adapter. GovCloud endpoint qualification needed.', delivery: 'integration-needed',
    landing: 'Use the authorized GovCloud account, service offering, region, connectivity, IAM, keys and logging boundary.',
    transfer: 'Qualify the existing AWS Transform MGN path against the approved partition, supported agent download and staging endpoints.',
    validate: 'Verify partition-aware ARNs, restricted connectivity, isolated test launch and recovery.',
    implementation: 'Cover GovCloud ARN and service endpoint handling, Terraform state and provider settings, and end-to-end tests for each authorized region.' },
  { id: 'azure-government', name: 'Azure Government', source: 'Azure source adapter. Government endpoint qualification needed.', delivery: 'integration-needed',
    landing: 'Use the authorized tenant, subscription, Azure environment, region, private connectivity, key vault and monitoring boundary.',
    transfer: 'Qualify the existing Azure Migrate path, appliances and agents against the approved Azure Government services and endpoints.',
    validate: 'Verify the Azure cloud context, vault and storage suffixes, isolated test network and recovery.',
    implementation: 'Qualify environment-aware PowerShell, Azure CLI and Terraform authentication, regional service availability and boundary-safe logging.' },
  ...[
    ['aws', 'AWS', 'AWS Transform MGN', 'VPC, security groups and private transfer connectivity'],
    ['azure', 'Azure', 'Azure Migrate', 'VNet, NSGs, firewall and approved identity endpoints'],
    ['google', 'Google Cloud', 'Migrate to Virtual Machines', 'VPC, service accounts and isolated test subnet'],
    ['oci', 'Oracle Cloud Infrastructure', 'Oracle Cloud Migrations', 'VCN, compartments, staging and IAM'],
    ['vcf', 'Broadcom VMware Cloud Foundation (VCF)', 'HCX / cross-vCenter vMotion as applicable', 'VCF workload domain, vSAN, NSX and network mappings'],
    ['vmware-cloud', 'Cloud-hosted VMware', 'HCX where the service and release support it', 'the provider VMware environment, permitted HCX topology and network mappings'],
  ].map(([id, name, tool, landing]): ExitTarget => ({
    id: id!, name: name!, source: 'Existing toolkit source intake', delivery: 'existing-kit',
    landing: `Prepare ${landing}. Confirm version, region, partition and service availability.`,
    transfer: `Use the existing toolkit path for ${tool}. Check path findings, onboard sources, replicate and test before cutover.`,
    validate: 'Check target health, restore, application smoke tests, security policies, telemetry and rollback.',
    implementation: 'Reuse Landing zones, Generate and Execute. Qualify any sovereign partition or enclave endpoints before use.',
  })),
];

export const EXIT_PROFILES = ['Commercial', 'Federal civilian', 'Department of State', 'DoD'] as const;
export const DATA_HANDLING = ['Unassessed', 'Public', 'Nonpublic unclassified', 'CUI', 'Classified'] as const;
export type ExitProfile = (typeof EXIT_PROFILES)[number];
export type DataHandling = (typeof DATA_HANDLING)[number];
export const EXIT_POLICY_REFERENCES = [
  ['State IT acquisition', 'https://fam.state.gov/fam/05fam/05fam0910.html'],
  ['State authorization', 'https://fam.state.gov/fam/05fah11/05fah110410.html'],
  ['DoDIN APL transition', 'https://aplits.disa.mil/docs/DoD_CIO_APL_Sunset_Memo.pdf'],
  ['CISA CDM APL', 'https://www.cisa.gov/sites/default/files/2024-04/CDM_%20APL_%20Submission_%20Instructions_2023_v2.pdf'],
  ['NARA CUI guidance', 'https://www.archives.gov/cui/registry/policy-guidance'],
  ['FIPS 199', 'https://csrc.nist.gov/pubs/fips/199/final'],
  ['Validated cryptographic modules', 'https://csrc.nist.gov/Projects/cryptographic-module-validation-program/validated-modules'],
  ['FedRAMP Marketplace guide', 'https://www.fedramp.gov/marketplace/guide/'],
  ['DoD Cloud Computing SRG', 'https://public.cyber.mil/dccs/dccs-documents/'],
  ['Media sanitization', 'https://csrc.nist.gov/pubs/sp/800/88/r2/final'],
] as const;

export const EXIT_PHASES = [
  { name: 'Discovery and dependency mapping', owner: 'Inventory and application owners', work: 'Import vCenter or RVTools inventory and usage. Map VM, database and application dependencies, and inventory vSAN policies, NSX segments and firewall rules, IAM, Aria, backups, WAN and licensing. Size swing capacity from measured demand and rollback needs.', evidence: 'Inventory complete, dependencies reviewed, hardware support and capacity validated' },
  { name: 'Security and authorization', owner: 'ISSO, security, network and acquisition leads', work: 'Map data flows and system boundaries. Qualify the exact target release, appliances, endpoints and support chain. Record architecture, procurement and authorization decisions. Validate key management, hardening and monitoring.', evidence: 'Approved test boundary and data handling evidence recorded' },
  { name: 'Landing zone and pilot', owner: 'Platform, network and security teams', work: 'Build the target network, storage, identity, backup and logging. Review Terraform plans, apply the approved Ansible baseline, and test expected allow and deny traffic before a nonproduction pilot.', evidence: 'Pilot passed with tested backup, restore, and rollback' },
  { name: 'Wave migration and cutover', owner: 'Migration lead, application owners and change authority', work: 'Keep synchronous dependencies together. Replicate or convert, test in isolation, rehearse rollback, approve the outage and cutover, freeze writes, perform the final sync, switch endpoints, and validate service and data.', evidence: 'Cutover decisions, integrity checks and application sign-offs recorded' },
  { name: 'Hypercare and decommission', owner: 'Operations, records and asset owners', work: 'Monitor SLOs and security telemetry. Commit after acceptance and the approved retention period. Check legal holds and recovery before sanitization, disposition and CMDB/contract updates.', evidence: 'Retention, backups, sanitization and asset disposition approved' },
] as const;

export function federalChecks(profile: ExitProfile, handling: DataHandling): readonly string[] {
  const checks = ['Record the data owner, allowed destinations, transfer boundary and disposal requirements for disks, exports, metadata, logs, backups and keys.'];
  if (profile !== 'Commercial') checks.push(
    'Record applicable FIPS 199 impact and RMF or agency baseline, SSP and authorization scope. Review privacy, residency, interconnection and cloud offering authorization as applicable.',
    'Verify applicable STIG/SRG controls for exact versions, CMVP module certificates and approved modes, and monitoring, endpoint and vulnerability evidence.',
  );
  if (profile === 'Department of State') checks.push(
    'Record the internal DT architecture or product approval and any approved exception. Obtain the applicable acquisition, IT CCB and AO decisions under 5 FAM and 12 FAM.',
    'Record CISA CDM applicability and integration evidence, and CDM APL evidence where the acquisition requires it. Record whether a DoD interconnection invokes an interoperability requirement and the current authority.',
    'Check the approved OpenNet or ClassNet boundary, including migration appliances, control planes, staging, logs, backup and operational support.',
  );
  if (profile === 'DoD') checks.push(
    'Confirm current DoD interoperability rules with the authorizing program and document any applicable legacy APL evidence.',
    'For cloud, record the service offering, partition and applicable DoD Cloud SRG impact level, current authorization and mission-owner approval.',
  );
  if (handling === 'CUI') checks.push('Record the NARA CUI category and applicable markings, dissemination controls and contract requirements. Assess SP 800-171 where applicable to nonfederal systems.');
  if (handling === 'Unassessed') checks.push('Hold all workload transfer until the data owner determines handling and the receiving boundary is approved.');
  if (handling === 'Classified') checks.push('Use this export only for unclassified planning. Route execution through the authorized classified workflow. Any cross-domain transfer requires separate approval and an approved transfer mechanism.');
  return checks;
}

export function vmwareExitProject(plan: Plan, waves: WavePlan, selected: readonly ExitTarget[], source: string, profile: ExitProfile, handling: DataHandling, choices: { readonly activity?: string; readonly cutover?: string; readonly paths?: Readonly<Record<string, string>>; readonly environments?: Readonly<Record<string, string>>; readonly hostedService?: string } = {}): string {
  if (handling === 'Classified' && (plan.apps.length || plan.workloads.length || plan.databases.length || waves.waves.length)) {
    throw new Error('Use an empty plan to export a generic planning template for a classified boundary.');
  }
  return [
    /^(?:Broadcom )?VMware|^Cloud-hosted VMware/.test(source) ? '# VMware exit project plan' : '# Migration project plan', '',
    ...(choices.activity ? [`- Activity: ${choices.activity}`] : []),
    `- Source: ${source}`, `- Governance: ${profile}`, `- Data handling: ${handling}`,
    ...(choices.cutover ? [`- Cutover preference: ${choices.cutover}`] : []),
    `- Inventory in the current plan: ${plan.apps.length} applications, ${plan.workloads.length} servers, ${plan.databases.length} databases.`,
    '- Planning record for review. Use unclassified information in this export. Approvals must be recorded in the organization’s system of record.', '',
    '## Authorization and data handling', '', ...federalChecks(profile, handling).map((s) => `- [ ] ${s}`), '',
    '## Project phases', '',
    ...EXIT_PHASES.flatMap((phase, i) => [`### ${i + 1}. ${phase.name}`, '', `Owner: ${phase.owner}`, '', phase.work, '', `- [ ] ${phase.evidence}`, '']),
    '## Waves from the current plan', '',
    ...(waves.waves.length ? waves.waves.map((w) => `- Wave ${w.n}: ${w.groups.length} move groups. ${w.start ?? 'Start TBD'} through ${w.end ?? 'end TBD'}. Gates: ${w.gates?.join(', ') || 'confirm in Execute'}.`) : ['- No waves are scheduled. Build the groups from discovery and place a nonproduction pilot first.']),
    '- Revalidate wave dates, staffing, outage budgets and dependencies after assigning destination platforms.', '',
    '## Destination workstreams', '',
    ...selected.flatMap((target) => [
      `### ${target.name}`, '',
      ...(target.id === 'vmware-cloud' && choices.hostedService ? [`Hosted service: ${choices.hostedService}.`, ''] : []),
      ...(choices.environments?.[target.id] ? [`Cloud environment: ${choices.environments[target.id]}.`, ''] : []),
      `Delivery: ${target.delivery === 'existing-kit' ? 'Existing ArchToolKit workflow, subject to environment qualification' : 'Vendor workflow with ArchToolKit integration still required'}`, '',
      ...(choices.paths?.[target.id] ? [`Preferred path: ${choices.paths[target.id]}. Confirm in execution settings against the actual workloads.`, ''] : []),
      `1. Landing zone. ${target.landing}`,
      `2. Migration. ${target.transfer}`,
      `3. Acceptance. ${target.validate}`, '',
      `Engineering work: ${target.implementation}`, '',
      ...(target.reference ? [`[Vendor documentation](${target.reference})`, ''] : []),
    ]),
    '## Acceptance criteria for new adapters', '',
    '- Use typed inventory identifiers, approved endpoints, and provider credentials from environment or vault. Keep Terraform state and logs inside the approved boundary.',
    '- Validate public API calls against a mock, simulate job failure and retries, and prove resume, rollback, and source retention in a nonproduction migration.',
    '- Require scoped authorization and a signed cutover decision before changing production. Keep unsupported or unqualified paths out of automatic placement.',
    '- Prove equivalence of storage, identity, firewall behavior, monitoring and recovery before releasing the source estate.', '',
    ...(profile === 'Commercial' ? [] : ['## Policy references', '', ...EXIT_POLICY_REFERENCES.map(([title, url]) => `- [${title}](${url})`), '']),
  ].join('\n');
}
