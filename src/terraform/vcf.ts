/**
 * Emit Terraform for a VCF bring-up, from the same specification.
 *
 * The `vmware/vcf` provider's `vcf_instance` resource is the Terraform analogue
 * of `SddcSpec`, so a plan that produces one can produce the other. What it
 * cannot do is produce all of it.
 *
 * The provider's own compatibility matrix stops at **VCF 9.0.0** (provider
 * v0.17.0 and later); 9.1 is not listed. Its schema shows the same thing from
 * the inside: it carries `operations_fleet_management`, which 9.1 removed, and
 * has no block at all for the components 9.1 added — VCF management services,
 * the fleet lifecycle and depot services, the Identity Broker, the License
 * Server. A generated file therefore cannot stand alone for a 9.1 fleet, and
 * pretending otherwise would be the most damaging thing this module could do.
 *
 * So it emits what the provider really supports and reports precisely what it
 * had to leave behind, rather than inventing blocks that would fail at plan time
 * or, worse, apply and build the wrong thing.
 *
 * Verification: V-DOC (provider documentation and compatibility matrix,
 * retrieved 2026-09-20).
 */

import { error, info, warning, type Finding } from '../core/findings.ts';
import {
  renderFile,
  str,
  num,
  bool,
  strings,
  raw,
  type HclBlock,
  type HclAttribute,
} from './hcl.ts';
import { isPlaceholderSecret, type SddcSpec } from '../vcf/spec-types.ts';
import { compareVcfVersion } from '../vcf/version.ts';

/** The provider release this output is written against. */
export const VCF_PROVIDER_SOURCE = 'vmware/vcf';
export const VCF_PROVIDER_VERSION = '~> 0.18';
/** The highest VCF version the provider's compatibility matrix lists. */
export const VCF_PROVIDER_MAX_VCF = '9.0.0';

export interface TerraformOutput {
  /** The resource and provider configuration. */
  readonly mainTf: string;
  /** Declarations for every secret, so none is written into the configuration. */
  readonly variablesTf: string;
  /** What could not be expressed, and why. */
  readonly findings: readonly Finding[];
  /** Variable names the user must supply a value for. */
  readonly requiredVariables: readonly string[];
}

/**
 * Specification keys the provider has no representation for.
 *
 * Each is a 9.1 component. They are listed rather than silently dropped because
 * a person reading generated Terraform has no other way to discover that the
 * document they started from said more than the file does.
 */
const UNSUPPORTED_BY_PROVIDER: readonly { key: keyof SddcSpec; what: string }[] = [
  { key: 'vspClusterSpec', what: 'VCF management services (the vSphere Supervisor runtime)' },
  { key: 'fleetLcmSpec', what: 'Fleet lifecycle service' },
  { key: 'sddcLcmSpec', what: 'SDDC lifecycle service' },
  { key: 'fleetDepotSpec', what: 'Fleet depot service' },
  { key: 'telemetryAcceptorSpec', what: 'Telemetry acceptor' },
  { key: 'saltSpec', what: 'Salt' },
  { key: 'saltRaasSpec', what: 'Salt RaaS' },
  { key: 'vidbSpec', what: 'Identity Broker' },
  { key: 'licenseServerSpec', what: 'License Server' },
  {
    key: 'vcfManagementComponentsInfrastructureSpec',
    what: 'VCF management components networking',
  },
];

/** A variable reference, with the name recorded so it can be declared. */
class Secrets {
  readonly names: string[] = [];

  ref(name: string): ReturnType<typeof raw> {
    if (!this.names.includes(name)) this.names.push(name);
    return raw(`var.${name}`);
  }
}

function attr(name: string, value: HclAttribute['value'] | undefined): HclAttribute[] {
  return value === undefined ? [] : [{ name, value }];
}

function vlanNumber(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function emitTerraform(spec: SddcSpec): TerraformOutput {
  const findings: Finding[] = [];
  const secrets = new Secrets();

  // --- what this provider cannot carry -------------------------------------
  const version = spec.version ?? '';
  if (version && compareVcfVersion(version, VCF_PROVIDER_MAX_VCF) > 0) {
    findings.push(
      warning(
        'vcf.terraform.version-beyond-provider',
        `This specification targets ${version}, but the ${VCF_PROVIDER_SOURCE} provider's compatibility matrix stops at ${VCF_PROVIDER_MAX_VCF}. The generated configuration is a starting point, not a substitute for the JSON specification.`,
        {
          path: 'version',
          remediation:
            'Deploy with the JSON specification, and use Terraform for the parts the provider supports.',
          source: 'terraform-provider-vcf compatibility matrix',
        },
      ),
    );
  }

  const dropped = UNSUPPORTED_BY_PROVIDER.filter(({ key }) => spec[key] !== undefined);
  for (const { key, what } of dropped) {
    findings.push(
      warning(
        'vcf.terraform.unsupported-component',
        `${what} is in the specification but the provider has no block for it, so it is absent from the generated configuration.`,
        {
          path: key,
          remediation: 'Deploy this component through the JSON specification or the API.',
          source: 'terraform-provider-vcf — vcf_instance schema',
        },
      ),
    );
  }

  if (spec.workflowType && spec.workflowType !== 'VCF') {
    findings.push(
      warning(
        'vcf.terraform.workflow-type-not-expressible',
        `workflowType "${spec.workflowType}" has no equivalent in vcf_instance, which only models a first bring-up.`,
        {
          path: 'workflowType',
          remediation: 'Use the JSON specification for anything other than a new VCF instance.',
          source: 'terraform-provider-vcf — vcf_instance schema',
        },
      ),
    );
  }

  // --- blocks ---------------------------------------------------------------
  const blocks: HclBlock[] = [];

  blocks.push({
    type: 'terraform',
    blocks: [
      {
        type: 'required_providers',
        attributes: [
          {
            name: 'vcf',
            value: raw(
              `{\n      source  = "${VCF_PROVIDER_SOURCE}"\n      version = "${VCF_PROVIDER_VERSION}"\n    }`,
            ),
          },
        ],
      },
    ],
  });

  blocks.push({
    type: 'provider',
    labels: ['vcf'],
    comment:
      'Point this at the installer appliance performing the bring-up.\nCredentials come from variables; nothing secret is written into this file.',
    attributes: [
      { name: 'installer_host', value: secrets.ref('installer_host') },
      { name: 'installer_username', value: secrets.ref('installer_username') },
      { name: 'installer_password', value: secrets.ref('installer_password') },
      { name: 'allow_unverified_tls', value: bool(true) },
    ],
  });

  const resourceAttributes: HclAttribute[] = [
    { name: 'instance_id', value: str(spec.sddcId) },
    ...attr('version', spec.version ? str(spec.version) : undefined),
    ...attr(
      'management_pool_name',
      str(spec.managementPoolName ?? `${spec.sddcId}-np01`),
    ),
    ...attr('ntp_servers', spec.ntpServers ? strings(spec.ntpServers) : undefined),
    ...attr('ceip_enabled', spec.ceipEnabled === undefined ? undefined : bool(spec.ceipEnabled)),
    {
      name: 'skip_esx_thumbprint_validation',
      value: bool(spec.skipEsxThumbprintValidation ?? true),
    },
  ];

  const resourceBlocks: HclBlock[] = [];

  // dns
  resourceBlocks.push({
    type: 'dns',
    attributes: [
      { name: 'domain', value: str(spec.dnsSpec.subdomain) },
      ...attr(
        'name_server',
        spec.dnsSpec.nameservers?.[0] ? str(spec.dnsSpec.nameservers[0]) : undefined,
      ),
      ...attr(
        'secondary_name_server',
        spec.dnsSpec.nameservers?.[1] ? str(spec.dnsSpec.nameservers[1]) : undefined,
      ),
    ],
  });

  // networks
  for (const network of spec.networkSpecs) {
    const vlan = vlanNumber(network.vlanId);
    resourceBlocks.push({
      type: 'network',
      attributes: [
        { name: 'network_type', value: str(String(network.networkType)) },
        ...attr('vlan_id', vlan === undefined ? undefined : num(vlan)),
        // The provider requires mtu; the API leaves it optional and defaults it.
        { name: 'mtu', value: num(network.mtu ?? 1500) },
        ...attr('subnet', network.subnet ? str(network.subnet) : undefined),
        ...attr('subnet_mask', network.subnetMask ? str(network.subnetMask) : undefined),
        ...attr('gateway', network.gateway ? str(network.gateway) : undefined),
        ...attr(
          'teaming_policy',
          network.teamingPolicy ? str(network.teamingPolicy) : undefined,
        ),
        ...attr(
          'active_uplinks',
          network.activeUplinks ? strings(network.activeUplinks) : undefined,
        ),
        ...attr(
          'standby_uplinks',
          network.standbyUplinks ? strings(network.standbyUplinks) : undefined,
        ),
        ...attr('port_group_key', network.portGroupKey ? str(network.portGroupKey) : undefined),
      ],
      blocks: (network.includeIpAddressRanges ?? []).map((range) => ({
        type: 'include_ip_address_ranges',
        attributes: [
          { name: 'start_ip_address', value: str(range.startIpAddress) },
          { name: 'end_ip_address', value: str(range.endIpAddress) },
        ],
      })),
    });
  }

  // hosts
  (spec.hostSpecs ?? []).forEach((hostSpec, i) => {
    const password = hostSpec.credentials?.password;
    const useVariable = password === undefined || isPlaceholderSecret(password);
    resourceBlocks.push({
      type: 'host',
      attributes: [
        { name: 'hostname', value: str(hostSpec.hostname) },
        ...attr('ssh_thumbprint', hostSpec.sshThumbprint ? str(hostSpec.sshThumbprint) : undefined),
        ...attr('ssl_thumbprint', hostSpec.sslThumbprint ? str(hostSpec.sslThumbprint) : undefined),
      ],
      blocks: [
        {
          type: 'credentials',
          attributes: [
            { name: 'username', value: str(hostSpec.credentials?.username ?? 'root') },
            {
              name: 'password',
              value: useVariable ? secrets.ref('esx_root_password') : str(password as string),
            },
          ],
        },
      ],
      comment: i === 0 ? 'ESXi hosts for the management cluster.' : undefined,
    });
  });

  // cluster
  resourceBlocks.push({
    type: 'cluster',
    attributes: [
      { name: 'cluster_name', value: str(spec.clusterSpec?.clusterName ?? `${spec.sddcId}-cl01`) },
      {
        name: 'datacenter_name',
        value: str(spec.clusterSpec?.datacenterName ?? `${spec.sddcId}-dc01`),
      },
      ...attr(
        'cluster_evc_mode',
        spec.clusterSpec?.clusterEvcMode ? str(String(spec.clusterSpec.clusterEvcMode)) : undefined,
      ),
    ],
  });

  // dvs
  for (const dvs of spec.dvsSpecs ?? []) {
    resourceBlocks.push({
      type: 'dvs',
      attributes: [
        { name: 'dvs_name', value: str(dvs.dvsName ?? `${spec.sddcId}-vds01`) },
        { name: 'networks', value: strings((dvs.networks ?? []).map(String)) },
        ...attr('mtu', dvs.mtu === undefined ? undefined : num(dvs.mtu)),
      ],
      blocks: [
        ...(dvs.vmnicsToUplinks ?? []).map((mapping) => ({
          type: 'vmnic_mapping',
          attributes: [
            { name: 'vmnic', value: str(mapping.id) },
            { name: 'uplink', value: str(mapping.uplink) },
          ],
        })),
        ...(dvs.nsxTeamings ?? []).map((teaming) => ({
          type: 'nsx_teaming',
          attributes: [
            { name: 'policy', value: str(teaming.policy) },
            { name: 'active_uplinks', value: strings(teaming.activeUplinks) },
            ...attr(
              'standby_uplinks',
              teaming.standByUplinks ? strings(teaming.standByUplinks) : undefined,
            ),
          ],
        })),
        ...(dvs.lagSpecs ?? []).map((lag) => ({
          type: 'lag',
          attributes: [
            { name: 'name', value: str(lag.name) },
            { name: 'uplink_count', value: num(lag.uplinksCount) },
            { name: 'lacp_mode', value: str(lag.lacpMode) },
            { name: 'timeout_mode', value: str(lag.lacpTimeoutMode) },
            { name: 'load_balancing_mode', value: str(lag.loadBalancingMode) },
          ],
        })),
      ],
    });
  }

  // vcenter
  resourceBlocks.push({
    type: 'vcenter',
    attributes: [
      { name: 'vcenter_hostname', value: str(spec.vcenterSpec.vcenterHostname) },
      { name: 'root_vcenter_password', value: secrets.ref('vcenter_root_password') },
      ...attr('vm_size', spec.vcenterSpec.vmSize ? str(spec.vcenterSpec.vmSize) : undefined),
      ...attr(
        'storage_size',
        spec.vcenterSpec.storageSize ? str(spec.vcenterSpec.storageSize) : undefined,
      ),
    ],
  });

  // nsx
  if (spec.nsxtSpec) {
    const nsx = spec.nsxtSpec;
    const transportVlan = vlanNumber(nsx.transportVlanId);
    resourceBlocks.push({
      type: 'nsx',
      attributes: [
        { name: 'vip_fqdn', value: str(nsx.vipFqdn) },
        { name: 'nsx_manager_size', value: str(nsx.nsxtManagerSize ?? 'medium') },
        { name: 'transport_vlan_id', value: num(transportVlan ?? 0) },
        { name: 'root_nsx_manager_password', value: secrets.ref('nsx_root_password') },
        { name: 'nsx_admin_password', value: secrets.ref('nsx_admin_password') },
        { name: 'nsx_audit_password', value: secrets.ref('nsx_audit_password') },
      ],
      blocks: [
        ...nsx.nsxtManagers.map((manager) => ({
          type: 'nsx_manager',
          attributes: [...attr('hostname', manager.hostname ? str(manager.hostname) : undefined)],
        })),
        ...(nsx.ipAddressPoolSpec
          ? [
              {
                type: 'ip_address_pool',
                attributes: [
                  { name: 'name', value: str(nsx.ipAddressPoolSpec.name) },
                  ...attr(
                    'description',
                    nsx.ipAddressPoolSpec.description
                      ? str(nsx.ipAddressPoolSpec.description)
                      : undefined,
                  ),
                ],
                blocks: (nsx.ipAddressPoolSpec.subnets ?? []).map((subnet) => ({
                  type: 'subnet',
                  attributes: [
                    { name: 'cidr', value: str(subnet.cidr) },
                    { name: 'gateway', value: str(subnet.gateway) },
                  ],
                  blocks: subnet.ipAddressPoolRanges.map((range) => ({
                    type: 'ip_address_pool_range',
                    attributes: [
                      { name: 'start', value: str(range.start) },
                      { name: 'end', value: str(range.end) },
                    ],
                  })),
                })),
              },
            ]
          : []),
      ],
    });
  }

  // sddc manager
  if (spec.sddcManagerSpec) {
    resourceBlocks.push({
      type: 'sddc_manager',
      attributes: [
        ...attr('hostname', str(spec.sddcManagerSpec.hostname)),
        { name: 'root_user_password', value: secrets.ref('sddc_manager_root_password') },
        { name: 'ssh_password', value: secrets.ref('sddc_manager_ssh_password') },
        { name: 'local_user_password', value: secrets.ref('sddc_manager_local_password') },
      ],
    });
  }

  // vsan
  const vsan = spec.datastoreSpec?.vsanSpec;
  if (vsan) {
    resourceBlocks.push({
      type: 'vsan',
      attributes: [
        { name: 'datastore_name', value: str(vsan.datastoreName ?? `${spec.sddcId}-vsan01`) },
        ...attr(
          'failures_to_tolerate',
          vsan.failuresToTolerate === undefined ? undefined : num(vsan.failuresToTolerate),
        ),
        ...attr('esa_enabled', vsan.esaConfig ? bool(vsan.esaConfig.enabled) : undefined),
        ...attr('vsan_dedup', vsan.vsanDedup === undefined ? undefined : bool(vsan.vsanDedup)),
      ],
    });
  }

  if (spec.datastoreSpec?.nfsDatastoreSpec || spec.datastoreSpec?.vmfsDatastoreSpec) {
    findings.push(
      warning(
        'vcf.terraform.storage-not-expressible',
        'vcf_instance models vSAN only; NFS and VMFS principal storage have no block in the provider.',
        {
          path: 'datastoreSpec',
          remediation: 'Deploy with the JSON specification when principal storage is not vSAN.',
          source: 'terraform-provider-vcf — vcf_instance schema',
        },
      ),
    );
  }

  // operations
  if (spec.vcfOperationsSpec) {
    resourceBlocks.push({
      type: 'operations',
      attributes: [
        ...attr(
          'appliance_size',
          spec.vcfOperationsSpec.applianceSize
            ? str(spec.vcfOperationsSpec.applianceSize)
            : undefined,
        ),
        { name: 'admin_user_password', value: secrets.ref('operations_admin_password') },
        ...attr(
          'load_balancer_fqdn',
          spec.vcfOperationsSpec.loadBalancerFqdn
            ? str(spec.vcfOperationsSpec.loadBalancerFqdn)
            : undefined,
        ),
      ],
      blocks: spec.vcfOperationsSpec.nodes.map((node) => ({
        type: 'node',
        attributes: [
          { name: 'hostname', value: str(node.hostname) },
          { name: 'type', value: str(node.type ?? 'master') },
          { name: 'root_user_password', value: secrets.ref('operations_root_password') },
        ],
      })),
    });
  }

  if (spec.vcfOperationsCollectorSpec) {
    resourceBlocks.push({
      type: 'operations_collector',
      attributes: [
        { name: 'hostname', value: str(spec.vcfOperationsCollectorSpec.hostname) },
        ...attr(
          'appliance_size',
          spec.vcfOperationsCollectorSpec.applianceSize
            ? str(spec.vcfOperationsCollectorSpec.applianceSize)
            : undefined,
        ),
        { name: 'root_user_password', value: secrets.ref('operations_collector_root_password') },
      ],
    });
  }

  // automation
  if (spec.vcfAutomationSpec) {
    resourceBlocks.push({
      type: 'automation',
      attributes: [
        { name: 'hostname', value: str(spec.vcfAutomationSpec.hostname) },
        { name: 'internal_cluster_cidr', value: str(spec.vcfAutomationSpec.internalClusterCidr) },
        { name: 'ip_pool', value: strings(spec.vcfAutomationSpec.ipPool ?? []) },
        ...attr(
          'node_prefix',
          spec.vcfAutomationSpec.nodePrefix ? str(spec.vcfAutomationSpec.nodePrefix) : undefined,
        ),
        { name: 'admin_user_password', value: secrets.ref('automation_admin_password') },
      ],
    });
  }

  // security
  if (spec.securitySpec?.esxiCertsMode) {
    resourceBlocks.push({
      type: 'security',
      attributes: [{ name: 'esxi_certs_mode', value: str(spec.securitySpec.esxiCertsMode) }],
    });
  }

  blocks.push({
    type: 'resource',
    labels: ['vcf_instance', spec.sddcId.replace(/[^a-zA-Z0-9_-]/g, '_')],
    attributes: resourceAttributes,
    blocks: resourceBlocks,
  });

  const header = [
    ' from a VCF 9.1 SddcSpec.',
    '',
    `Provider: ${VCF_PROVIDER_SOURCE} ${VCF_PROVIDER_VERSION}.`,
    `Its compatibility matrix lists VCF up to ${VCF_PROVIDER_MAX_VCF}; anything newer is`,
    'not covered, and the components 9.1 added have no blocks here at all.',
    'Read the findings alongside this file before relying on it.',
  ].join('\n');

  const mainTf = renderFile(blocks, header);

  const variableBlocks: HclBlock[] = secrets.names.map((name) => ({
    type: 'variable',
    labels: [name],
    attributes: [
      { name: 'type', value: raw('string') },
      { name: 'description', value: str(describeVariable(name)) },
      ...(name.endsWith('password') ? [{ name: 'sensitive', value: bool(true) }] : []),
    ],
  }));

  const variablesTf = renderFile(
    variableBlocks,
    'Every credential is a variable, so none is written into the configuration.\nSupply them with a tfvars file kept out of version control, or the environment.',
  );

  if (secrets.names.length > 0) {
    findings.push(
      info(
        'vcf.terraform.credentials-as-variables',
        `${secrets.names.length} credential(s) are declared as variables rather than written into the configuration.`,
        { source: 'ArchToolKit' },
      ),
    );
  }

  if (!spec.hostSpecs || spec.hostSpecs.length === 0) {
    findings.push(
      error(
        'vcf.terraform.no-hosts',
        'vcf_instance requires at least one host block, and the specification carries none.',
        { path: 'hostSpecs' },
      ),
    );
  }

  return { mainTf, variablesTf, findings, requiredVariables: secrets.names };
}

function describeVariable(name: string): string {
  const known: Record<string, string> = {
    installer_host: 'FQDN or address of the VCF Installer appliance.',
    installer_username: 'Installer appliance user, typically admin@local.',
    installer_password: 'Password for the installer appliance user.',
    esx_root_password: 'Root password shared by the ESXi hosts.',
    vcenter_root_password: 'Root password for the vCenter appliance.',
    nsx_root_password: 'Root password for the NSX Manager appliances.',
    nsx_admin_password: 'NSX admin password.',
    nsx_audit_password: 'NSX audit password.',
    sddc_manager_root_password: 'Root password for SDDC Manager.',
    sddc_manager_ssh_password: 'Password for the vcf user on SDDC Manager.',
    sddc_manager_local_password: 'SDDC Manager local administrator password.',
    operations_admin_password: 'VCF Operations admin password.',
    operations_root_password: 'Root password for VCF Operations nodes.',
    operations_collector_root_password: 'Root password for the VCF Operations collector.',
    automation_admin_password: 'VCF Automation admin password.',
  };
  return known[name] ?? name.replace(/_/g, ' ');
}
