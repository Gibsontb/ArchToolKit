/**
 * Azure blueprints for a migration plan: landing zone, identity, connectivity,
 * compute, databases, Oracle Database@Azure, backup and monitoring.
 *
 * See ./common.ts for the landing-zone contract and the grid formats. The
 * landing zone is the network foundation (src/terraform/azure.ts) per network,
 * with a network security group per tier in place of its single one, the
 * platform subnets (GatewaySubnet, AzureBastionSubnet) in the first network,
 * and the delegated subnets the managed services need (a `delegations` grid
 * the planner fills when SQL Managed Instance, a flexible server, Oracle
 * Database@Azure or a DNS resolver is used).
 */

import { error, info, warning,              } from '../../../core/findings.js';
import { familyOf } from '../../../core/ip.js';
                                                                            
import { num as numberOf, str as valueOf } from '../../../kit/blueprint.js';
import { AZURE_VM_SIZES } from '../../../kit/choices.js';
import { AZURE_REGIONS } from '../../../kit/regions.js';
import { subnetIpv6Ranges,                     } from '../../foundation.js';
                                             
import { emitFoundation } from '../../index.js';
import {
  DB_PORTS,
  DEFAULT_SITES,
  LANDING_ZONE_SOURCE,
  MIGRATION_GROUP,
  SITE_COLUMNS,
  ZONE_LETTERS,
  attrs,
  backupInputs,
  blk,
  carveNetwork,
  cloudInit,
  consumerPreamble,
  dat,
  dbColumns,
  e,
  gridInput,
  hcl,
  hlist,
  ident,
  ignoreChanges,
  landingZoneInputs,
  landingZoneLocal,
  landingZoneNote,
  lzRef,
  lzSource,
  mainTf,
  monitoringInputs,
  odbInputs,
  odbOciDatabases,
  opts,
  oracleRegionFinding,
  output,
  parseBackupTiers,
  parseDbs,
  parseGrid,
  parseLandingZone,
  parseSites,
  parseVms,
  q,
  res,
  reworkFoundation,
  rname,
  secretVariable,
  siteSources,
  sshKeyVariable,
  terraformBlock,
  ulaFor,
  variable,
  vmColumns,
  vmLocalEntry,
  vmSource,
  winrmBootstrap,
  withHost,
  words,
  x,
                  
                   
                  
              
} from './common.js';

const REGION = 'eastus';
const TF = () => terraformBlock(['azure']);

const SIZES = AZURE_VM_SIZES.filter((o) => /^Standard_(D|E|F)\d+(-\d+)?[a-z]*s_v[56]$/.test(o.value)).map((o) => o.value);

const failed = (id        , findings                    ) => ({
  files: { 'main.tf': `# ${id}: nothing was generated; see the findings.\n` },
  findings,
});

// ---------------------------------------------------------------------------
// Landing zone
// ---------------------------------------------------------------------------

/** What each delegation is for, and what Azure calls it. */
const DELEGATIONS                                                                                             = {
  sqlmi: {
    service: 'Microsoft.Sql/managedInstances',
    actions: ['Microsoft.Network/virtualNetworks/subnets/join/action', 'Microsoft.Network/virtualNetworks/subnets/prepareNetworkPolicies/action', 'Microsoft.Network/virtualNetworks/subnets/unprepareNetworkPolicies/action'],
    label: 'SQL Managed Instance',
  },
  postgres: { service: 'Microsoft.DBforPostgreSQL/flexibleServers', actions: ['Microsoft.Network/virtualNetworks/subnets/join/action'], label: 'PostgreSQL flexible server' },
  mysql: { service: 'Microsoft.DBforMySQL/flexibleServers', actions: ['Microsoft.Network/virtualNetworks/subnets/join/action'], label: 'MySQL flexible server' },
  oracle: { service: 'Oracle.Database/networkAttachments', actions: ['Microsoft.Network/networkinterfaces/*', 'Microsoft.Network/virtualNetworks/subnets/join/action'], label: 'Oracle Database@Azure' },
  'dns-resolver': { service: 'Microsoft.Network/dnsResolvers', actions: ['Microsoft.Network/virtualNetworks/subnets/join/action'], label: 'DNS resolver outbound endpoint' },
  aadds: { label: 'Microsoft Entra Domain Services (dedicated, not delegated)' },
};

const DELEGATION_COLUMNS                        = [{ name: 'Network' }, { name: 'Delegation', options: Object.keys(DELEGATIONS) }, { name: 'IPv4 CIDR' }];
const DEFAULT_DELEGATIONS                                 = [
  ['prod', 'sqlmi', ''],
  ['prod', 'postgres', ''],
  ['prod', 'mysql', ''],
  ['prod', 'oracle', ''],
  ['prod', 'dns-resolver', ''],
];

                     
                                
                        
                        
                         
 

/** Ports a domain controller in the mgmt tier needs open. */
const AD_TCP = ['53', '88', '135', '389', '445', '464', '636', '3268-3269', '49152-65535'];
const AD_UDP = ['53', '88', '123', '389', '464'];

                   
                        
                                               
                                    
                                   
                                     
 

/** One rule per family: an Azure rule's source prefixes may not mix IPv4 and IPv6. */
function byFamily(rule         )            {
  const v4 = rule.from.filter((c) => familyOf(c) !== 6);
  const v6 = rule.from.filter((c) => familyOf(c) === 6);
  return [
    ...(v4.length > 0 ? [{ ...rule, from: v4 }] : []),
    ...(v6.length > 0 ? [{ ...rule, name: `${rule.name}-v6`, from: v6 }] : []),
  ];
}

function tierNsgRules(n             , tier        , sites                   , cidrOf                            , v6range                    , bastion                    )            {
  const has = (t        ) => n.tiers.includes(t         );
  const vnet = [n.cidr, ...(v6range ? [v6range] : [])];
  const rules            = [];
  rules.push({ name: 'ansible-from-site', proto: 'Tcp', ports: ['22', '5986'], from: sites });
  if (tier === 'mgmt') rules.push({ name: 'rdp-from-site', proto: 'Tcp', ports: ['3389'], from: sites });
  if (bastion) rules.push({ name: 'from-bastion', proto: 'Tcp', ports: ['22', '3389'], from: [bastion] });
  if (tier === 'web') rules.push({ name: 'https', proto: 'Tcp', ports: ['443'], from: [...sites, ...vnet] });
  if (tier === 'app' && has('web')) rules.push({ name: 'from-web', proto: 'Tcp', ports: ['*'], from: cidrOf('web') });
  if (tier === 'db') {
    if (has('app')) rules.push({ name: 'db-from-app', proto: 'Tcp', ports: DB_PORTS.map(String), from: cidrOf('app') });
    if (has('mgmt')) rules.push({ name: 'db-from-mgmt', proto: 'Tcp', ports: DB_PORTS.map(String), from: cidrOf('mgmt') });
    rules.push({ name: 'db-cluster', proto: '*', ports: ['*'], from: cidrOf('db') });
  }
  if (tier !== 'mgmt' && has('mgmt')) rules.push({ name: 'admin-from-mgmt', proto: 'Tcp', ports: ['22', '3389', '5986'], from: cidrOf('mgmt') });
  if (tier === 'mgmt') {
    rules.push({ name: 'ad-tcp', proto: 'Tcp', ports: AD_TCP, from: [...vnet, ...sites] });
    rules.push({ name: 'ad-udp', proto: 'Udp', ports: AD_UDP, from: [...vnet, ...sites] });
  }
  rules.push({ name: 'icmp', proto: 'Icmp', ports: ['*'], from: [...vnet, ...sites] });
  return rules.flatMap(byFamily);
}

function nsgBlock(prefix        , n             , tier        , rules                    )           {
  let priority = 100;
  const rendered = rules.map((r) => {
    const p = priority;
    priority += 10;
    return blk('security_rule', {
      name: r.name,
      priority: p,
      direction: 'Inbound',
      access: r.access ?? 'Allow',
      protocol: r.proto,
      source_port_range: '*',
      ...(r.ports.length === 1 ? { destination_port_range: r.ports[0] } : { destination_port_ranges: [...r.ports] }),
      ...(r.from.length === 1 ? { source_address_prefix: r.from[0] } : { source_address_prefixes: [...r.from] }),
      destination_address_prefix: '*',
    });
  });
  // Azure allows everything inside the virtual network by default (AllowVnetInBound, 65000); the tiers mean nothing until that is denied.
  rendered.push(blk('security_rule', { name: 'deny-vnet', priority: 4000, direction: 'Inbound', access: 'Deny', protocol: '*', source_port_range: '*', destination_port_range: '*', source_address_prefix: 'VirtualNetwork', destination_address_prefix: '*' }));
  return res('azurerm_network_security_group', `${n.id}_${tier}`, {
    name: rname(prefix, n.name, tier, 'nsg'),
    location: x(`azurerm_resource_group.${n.id}.location`),
    resource_group_name: x(`azurerm_resource_group.${n.id}.name`),
  }, rendered);
}

function azureLandingZone()            {
  return {
    id: 'azure_mig_landing_zone',
    label: 'Landing zone (migration)',
    group: MIGRATION_GROUP,
    description: `Dual-stack virtual networks from the networks grid (built on the network foundation), a network security group per tier, NAT for outbound IPv4, the gateway and Bastion subnets, delegated subnets for managed databases, Key Vault with a disk encryption set, Log Analytics, VNet flow logs and a user-assigned identity for the VMs. ${landingZoneNote}`,
    inputs: [
      ...landingZoneInputs('azure', AZURE_REGIONS, REGION),
      gridInput('delegations', 'Delegated subnets', DELEGATION_COLUMNS, DEFAULT_DELEGATIONS, 'A dedicated subnet per managed service that needs one. IPv4 CIDR blank: a /24 carved after the tiers. Keyed "<network>/<delegation>" in the contract.'),
    ],
    emits: [
      'azurerm_resource_group', 'azurerm_virtual_network', 'azurerm_subnet', 'azurerm_network_security_group', 'azurerm_subnet_network_security_group_association',
      'azurerm_route_table', 'azurerm_subnet_route_table_association', 'azurerm_public_ip', 'azurerm_nat_gateway', 'azurerm_nat_gateway_public_ip_association',
      'azurerm_subnet_nat_gateway_association', 'azurerm_key_vault', 'azurerm_key_vault_key', 'azurerm_role_assignment', 'azurerm_disk_encryption_set',
      'azurerm_log_analytics_workspace', 'azurerm_monitor_diagnostic_setting', 'azurerm_storage_account', 'azurerm_network_watcher_flow_log', 'azurerm_bastion_host',
      'azurerm_user_assigned_identity',
    ],
    build: (values                 ) => {
      const findings            = [];
      const lz = parseLandingZone(values, REGION, findings);
      if (findings.some((f) => f.severity === 'error')) return failed('azure_mig_landing_zone', findings);
      const cmk = lz.keys !== 'provider-managed';
      const hub = lz.networks[0]               ;
      const location = lz.region;
      const shared = 'azurerm_resource_group.shared';
      const suffix = '${substr(md5(data.azurerm_client_config.current.subscription_id), 0, 6)}';
      const blocks                        = [
        TF(),
        { type: 'provider', labels: ['azurerm'], attributes: attrs({ subscription_id: lz.scope ? lz.scope : x('var.subscription_id') }), blocks: [blk('features')] },
        ...(lz.scope ? [] : [variable('subscription_id', 'string', 'The Azure subscription the landing zone is built in.')]),
        dat('azurerm_client_config', 'current', {}),
        res('azurerm_resource_group', 'shared', { name: `${lz.prefix}-shared-rg`, location }),
      ];

      // Delegated subnets, by network.
      const delegationRows = parseGrid(valueOf(values, 'delegations'), DELEGATION_COLUMNS.map((c) => c.name));
      const wanted = new Map                                          ();
      for (const r of delegationRows) {
        const net = rname(r['Network'] ?? '');
        const kind = (r['Delegation'] ?? '').toLowerCase();
        if (!DELEGATIONS[kind]) {
          findings.push(warning('tf.mig.azure-delegation', `"${r['Delegation']}" is not a delegation this knows (${Object.keys(DELEGATIONS).join(', ')}); left out.`, { path: 'delegations' }));
          continue;
        }
        if (!lz.networks.some((n) => n.name === net)) {
          findings.push(warning('tf.mig.azure-delegation-network', `Delegation ${kind}: there is no network called ${net}; left out.`, { path: 'delegations' }));
          continue;
        }
        const list = wanted.get(net) ?? [];
        if (!list.some((d) => d.kind === kind)) list.push({ kind, cidr: r['IPv4 CIDR'] ?? '' });
        wanted.set(net, list);
      }

      const subnetsByNet = new Map                      ();
      const delegated              = [];
      const platform = new Map                                               ();
      const v6RangeOf = new Map                ();
      for (const n of lz.networks) {
        const isHub = n === hub;
        const own = (wanted.get(n.name) ?? []).filter((d) => d.cidr === '');
        const extras = [
          ...(isHub && lz.bastion === 'cloud-native' ? [{ tier: 'AzureBastionSubnet', size: 26 }] : []),
          ...(isHub ? [{ tier: 'GatewaySubnet', size: 27 }] : []),
          ...own.map((d) => ({ tier: `d:${d.kind}`, size: Math.max(lz.prefixLen, 24) })),
        ];
        const carved = carveNetwork(n, lz.prefixLen, false, extras, findings);
        if (carved.length === 0) continue;
        const tiers = carved.filter((s) => (n.tiers                     ).includes(s.tier          ));
        subnetsByNet.set(n.id, tiers);
        const ipv6Cidr = n.ipv6 ? (n.ipv6Cidr ?? ulaFor(`${lz.prefix}/${n.name}`)) : undefined;
        if (ipv6Cidr) v6RangeOf.set(n.id, ipv6Cidr);
        const plan                 = {
          name: rname(lz.prefix, n.name),
          cidr: n.cidr,
          region: location,
          ipv6: n.ipv6,
          ...(ipv6Cidr ? { ipv6Cidr } : {}),
          subnets: tiers.map((s) => ({ name: s.short, cidr: s.cidr })),
          tags: { atk_network: n.name, atk_env: n.envs.join(' ') },
        };
        const out = emitFoundation('azure', plan);
        findings.push(...out.findings.filter((f) => f.severity !== 'info'));
        // The VNet's address space also holds the platform and delegated subnets carved outside the tiers.
        blocks.push(
          reworkFoundation(out.files['main.tf'] ?? '', n.id, {
            drop: (_kind, [type = '']) => type === 'azurerm_network_security_group' || type === 'azurerm_subnet_network_security_group_association',
          }),
        );
        const v6 = ipv6Cidr ? subnetIpv6Ranges(plan, 'azure').ranges : [];
        const cidrOf = (t        ) => tiers.flatMap((s, i) => (s.tier === t ? [s.cidr, ...(v6[i] ? [v6[i]          ] : [])] : []));
        const bastionCidr = carved.find((s) => s.tier === 'AzureBastionSubnet')?.cidr;
        for (const tier of n.tiers) {
          blocks.push(nsgBlock(lz.prefix, n, tier, tierNsgRules(n, tier, siteSources(lz, n), cidrOf, ipv6Cidr, bastionCidr)));
        }
        for (const s of tiers) {
          blocks.push(res('azurerm_subnet_network_security_group_association', s.label, { subnet_id: x(`azurerm_subnet.${s.label}.id`), network_security_group_id: x(`azurerm_network_security_group.${n.id}_${s.tier}.id`) }));
        }
        // Outbound IPv4: new virtual networks have no default outbound access.
        blocks.push(
          res('azurerm_public_ip', `${n.id}_nat`, { name: rname(lz.prefix, n.name, 'nat-pip'), location, resource_group_name: x(`azurerm_resource_group.${n.id}.name`), allocation_method: 'Static', sku: 'Standard', zones: ['1', '2', '3'] }),
          res('azurerm_nat_gateway', n.id, { name: rname(lz.prefix, n.name, 'nat'), location, resource_group_name: x(`azurerm_resource_group.${n.id}.name`), sku_name: 'Standard' }),
          res('azurerm_nat_gateway_public_ip_association', n.id, { nat_gateway_id: x(`azurerm_nat_gateway.${n.id}.id`), public_ip_address_id: x(`azurerm_public_ip.${n.id}_nat.id`) }),
        );
        for (const s of tiers) blocks.push(res('azurerm_subnet_nat_gateway_association', s.label, { subnet_id: x(`azurerm_subnet.${s.label}.id`), nat_gateway_id: x(`azurerm_nat_gateway.${n.id}.id`) }));

        // Platform subnets in the hub, named as Azure requires.
        const plat                                        = { gateway: '' };
        for (const s of carved.filter((c) => c.tier === 'GatewaySubnet' || c.tier === 'AzureBastionSubnet')) {
          const label = `${n.id}_${s.tier === 'GatewaySubnet' ? 'gateway' : 'bastion'}`;
          blocks.push(res('azurerm_subnet', label, { name: s.tier, resource_group_name: x(`azurerm_resource_group.${n.id}.name`), virtual_network_name: x(`azurerm_virtual_network.${n.id}.name`), address_prefixes: [s.cidr] }));
          if (s.tier === 'GatewaySubnet') plat.gateway = label;
          else plat.bastion = label;
        }
        platform.set(n.id, plat);
        // Delegated subnets: carved ones, and the ones given a range.
        for (const d of wanted.get(n.name) ?? []) {
          const cidr = d.cidr || carved.find((s) => s.tier === `d:${d.kind}`)?.cidr || '';
          if (familyOf(cidr) !== 4) {
            findings.push(error('tf.mig.azure-delegation-cidr', `Delegation ${d.kind} in ${n.name}: "${cidr}" is not an IPv4 CIDR.`, { path: 'delegations' }));
            continue;
          }
          delegated.push({ network: n, kind: d.kind, cidr, label: ident(n.id, d.kind) });
        }
      }
      if (findings.some((f) => f.severity === 'error')) return failed('azure_mig_landing_zone', findings);

      for (const d of delegated) {
        const spec = DELEGATIONS[d.kind] ?? { label: d.kind };
        blocks.push(
          res('azurerm_subnet', d.label, {
            name: rname(lz.prefix, d.network.name, d.kind),
            resource_group_name: x(`azurerm_resource_group.${d.network.id}.name`),
            virtual_network_name: x(`azurerm_virtual_network.${d.network.id}.name`),
            address_prefixes: [d.cidr],
          }, spec.service ? [blk('delegation', { name: d.kind }, [blk('service_delegation', { name: spec.service, actions: [...(spec.actions ?? [])] })])] : [], `${spec.label}.`),
        );
        if (d.kind === 'sqlmi') {
          // A managed instance's subnet must carry a security group and a route table; the service adds its own rules to both.
          blocks.push(
            res('azurerm_network_security_group', d.label, { name: rname(lz.prefix, d.network.name, 'sqlmi', 'nsg'), location, resource_group_name: x(`azurerm_resource_group.${d.network.id}.name`) }),
            res('azurerm_subnet_network_security_group_association', d.label, { subnet_id: x(`azurerm_subnet.${d.label}.id`), network_security_group_id: x(`azurerm_network_security_group.${d.label}.id`) }),
            res('azurerm_route_table', d.label, { name: rname(lz.prefix, d.network.name, 'sqlmi', 'rt'), location, resource_group_name: x(`azurerm_resource_group.${d.network.id}.name`) }),
            res('azurerm_subnet_route_table_association', d.label, { subnet_id: x(`azurerm_subnet.${d.label}.id`), route_table_id: x(`azurerm_route_table.${d.label}.id`) }),
          );
        }
      }

      // Keys: a vault always (secrets live there); a key and a disk encryption set when keys are customer-managed.
      blocks.push(
        res('azurerm_key_vault', 'landing_zone', {
          name: x(`"${lz.prefix.slice(0, 10)}-kv-${suffix}"`),
          location,
          resource_group_name: x(`${shared}.name`),
          tenant_id: x('data.azurerm_client_config.current.tenant_id'),
          sku_name: lz.keys === 'hsm' ? 'premium' : 'standard',
          rbac_authorization_enabled: true,
          purge_protection_enabled: true,
          soft_delete_retention_days: 90,
          enabled_for_disk_encryption: true,
        }),
        res('azurerm_role_assignment', 'deployer_crypto', { scope: x('azurerm_key_vault.landing_zone.id'), role_definition_name: 'Key Vault Administrator', principal_id: x('data.azurerm_client_config.current.object_id') }, [], 'Whoever applies this manages the vault\'s keys and secrets.'),
      );
      if (cmk) {
        blocks.push(
          res('azurerm_key_vault_key', 'landing_zone', {
            name: `${lz.prefix}-disks`,
            key_vault_id: x('azurerm_key_vault.landing_zone.id'),
            key_type: lz.keys === 'hsm' ? 'RSA-HSM' : 'RSA',
            key_size: 3072,
            key_opts: ['unwrapKey', 'wrapKey', 'encrypt', 'decrypt'],
            depends_on: x('[azurerm_role_assignment.deployer_crypto]'),
          }, [blk('rotation_policy', { expire_after: 'P2Y', notify_before_expiry: 'P30D' }, [blk('automatic', { time_before_expiry: 'P60D' })])]),
          res('azurerm_disk_encryption_set', 'landing_zone', {
            name: `${lz.prefix}-des`,
            location,
            resource_group_name: x(`${shared}.name`),
            key_vault_key_id: x('azurerm_key_vault_key.landing_zone.versionless_id'),
            auto_key_rotation_enabled: true,
          }, [blk('identity', { type: 'SystemAssigned' })]),
          res('azurerm_role_assignment', 'des_crypto', { scope: x('azurerm_key_vault.landing_zone.id'), role_definition_name: 'Key Vault Crypto Service Encryption User', principal_id: x('azurerm_disk_encryption_set.landing_zone.identity[0].principal_id') }),
        );
      }

      // Logs.
      blocks.push(
        res('azurerm_log_analytics_workspace', 'landing_zone', { name: `${lz.prefix}-law`, location, resource_group_name: x(`${shared}.name`), sku: 'PerGB2018', retention_in_days: Math.min(730, Math.max(30, lz.retention)) }),
        res('azurerm_storage_account', 'flow_logs', {
          name: x(`substr("${lz.prefix.replace(/[^a-z0-9]/g, '').slice(0, 10)}fl${suffix}", 0, 24)`),
          location,
          resource_group_name: x(`${shared}.name`),
          account_tier: 'Standard',
          account_replication_type: 'ZRS',
          min_tls_version: 'TLS1_2',
          https_traffic_only_enabled: true,
          allow_nested_items_to_be_public: false,
          shared_access_key_enabled: false,
        }),
      );
      for (const n of lz.networks) {
        if (!subnetsByNet.has(n.id)) continue;
        blocks.push(
          res('azurerm_monitor_diagnostic_setting', n.id, { name: 'to-log-analytics', target_resource_id: x(`azurerm_virtual_network.${n.id}.id`), log_analytics_workspace_id: x('azurerm_log_analytics_workspace.landing_zone.id') }, [
            blk('enabled_log', { category_group: 'allLogs' }),
            blk('enabled_metric', { category: 'AllMetrics' }),
          ]),
          res('azurerm_network_watcher_flow_log', n.id, {
            name: rname(lz.prefix, n.name, 'flow'),
            network_watcher_name: `NetworkWatcher_${location}`,
            resource_group_name: 'NetworkWatcherRG',
            target_resource_id: x(`azurerm_virtual_network.${n.id}.id`),
            storage_account_id: x('azurerm_storage_account.flow_logs.id'),
            enabled: true,
            version: 2,
          }, [
            blk('retention_policy', { enabled: true, days: Math.min(365, lz.retention) }),
            blk('traffic_analytics', { enabled: true, workspace_id: x('azurerm_log_analytics_workspace.landing_zone.workspace_id'), workspace_region: location, workspace_resource_id: x('azurerm_log_analytics_workspace.landing_zone.id'), interval_in_minutes: 10 }),
          ]),
        );
      }
      findings.push(info('tf.mig.azure-network-watcher', `VNet flow logs are written through NetworkWatcher_${location} in NetworkWatcherRG, which Azure creates with the first virtual network in a region.`, { path: 'networks' }));

      // Bastion.
      const hubPlat = platform.get(hub.id);
      if (lz.bastion === 'cloud-native' && hubPlat?.bastion) {
        blocks.push(
          res('azurerm_public_ip', 'bastion', { name: `${lz.prefix}-bastion-pip`, location, resource_group_name: x(`azurerm_resource_group.${hub.id}.name`), allocation_method: 'Static', sku: 'Standard', zones: ['1', '2', '3'] }),
          res('azurerm_bastion_host', 'landing_zone', { name: `${lz.prefix}-bastion`, location, resource_group_name: x(`azurerm_resource_group.${hub.id}.name`), sku: 'Standard', tunneling_enabled: true }, [
            blk('ip_configuration', { name: 'bastion', subnet_id: x(`azurerm_subnet.${hubPlat.bastion}.id`), public_ip_address_id: x('azurerm_public_ip.bastion.id') }),
          ]),
        );
      }
      blocks.push(res('azurerm_user_assigned_identity', 'vm', { name: `${lz.prefix}-vm-identity`, location, resource_group_name: x(`${shared}.name`) }));

      // The contract.
      const subnetIds                         = {};
      const sgIds                         = {};
      const mgmt           = lz.siteV4.map(q);
      if (lz.anyV6) mgmt.push(...lz.siteV6.map(q));
      for (const n of lz.networks) {
        const tiers = subnetsByNet.get(n.id) ?? [];
        for (const s of tiers) {
          for (let z = 0; z < n.zones; z++) subnetIds[`${n.name}/${s.tier}/${ZONE_LETTERS[z]}`] = `azurerm_subnet.${s.label}.id`;
          if (s.tier === 'mgmt') mgmt.push(q(s.cidr));
        }
        const plat = platform.get(n.id);
        if (plat?.gateway) subnetIds[`${n.name}/GatewaySubnet`] = `azurerm_subnet.${plat.gateway}.id`;
        if (plat?.bastion) subnetIds[`${n.name}/AzureBastionSubnet`] = `azurerm_subnet.${plat.bastion}.id`;
        for (const t of n.tiers) sgIds[`${n.name}/${t}`] = `azurerm_network_security_group.${n.id}_${t}.id`;
      }
      for (const d of delegated) subnetIds[`${d.network.name}/${d.kind}`] = `azurerm_subnet.${d.label}.id`;
      const byNet = (f                            , extra                         = {}) =>
        hcl({ ...Object.fromEntries(lz.networks.map((n) => [n.name, e(f(n))])), ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, e(v)])) }, 2);
      blocks.push(
        landingZoneLocal('azure', {
          prefix: q(lz.prefix),
          region: q(lz.region),
          network_ids: byNet((n) => `azurerm_virtual_network.${n.id}.id`),
          subnet_ids: hcl(Object.fromEntries(Object.entries(subnetIds).map(([k, v]) => [k, e(v)])), 2),
          security_group_ids: hcl(Object.fromEntries(Object.entries(sgIds).map(([k, v]) => [k, e(v)])), 2),
          kms_key_id: cmk ? 'azurerm_disk_encryption_set.landing_zone.id' : 'null',
          log_destination: 'azurerm_log_analytics_workspace.landing_zone.id',
          resource_group: byNet((n) => `azurerm_resource_group.${n.id}.name`, { shared: `${shared}.name` }),
          zones: hcl(['1', '2', '3'].slice(0, lz.maxZones)),
          mgmt_cidrs: `[${mgmt.join(', ')}]`,
          ipv6: byNet((n) => String(n.ipv6)),
          location: q(location),
          subscription_id: 'data.azurerm_client_config.current.subscription_id',
          network_names: byNet((n) => `azurerm_virtual_network.${n.id}.name`),
          identity_id: 'azurerm_user_assigned_identity.vm.id',
        }),
        output('landing_zone', 'local.landing_zone', 'The landing-zone contract: the value of the landing_zone variable of a blueprint used on its own.'),
        ...['network_ids', 'subnet_ids', 'security_group_ids', 'kms_key_id', 'log_destination', 'resource_group'].map((k) => output(k, `local.landing_zone.${k}`)),
        output('key_vault_id', 'azurerm_key_vault.landing_zone.id', 'The vault secrets go in.'),
      );
      findings.push(info('tf.mig.azure-ipv6-gateway', 'GatewaySubnet and AzureBastionSubnet are IPv4 only; the tier subnets are dual-stack where the network is.', { path: 'networks' }));
      return { files: { 'main.tf': mainTf(blocks, `Azure landing zone: ${lz.prefix} in ${location}`) }, findings };
    },
  };
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

function azureIdentity()            {
  return {
    id: 'azure_mig_identity',
    label: 'Identity (migration)',
    group: MIGRATION_GROUP,
    description: 'Microsoft Entra Domain Services, or only DNS: a Private DNS Resolver whose forwarding ruleset sends the domain to the domain controllers, linked to every network.',
    inputs: [
      { id: 'strategy', label: 'Strategy', control: 'select', default: 'resolver-only', options: [{ value: 'managed-ad', label: 'Microsoft Entra Domain Services' }, { value: 'resolver-only', label: 'Forward DNS to our own DCs (extend-dcs)' }] },
      { id: 'domain', label: 'Domain', control: 'text', default: 'corp.example.com' },
      { id: 'edition', label: 'SKU', control: 'select', default: 'Enterprise', options: opts(['Standard', 'Enterprise', 'Premium']), showWhen: { input: 'strategy', equals: ['managed-ad'] } },
      { id: 'dns_forwarders', label: 'Domain controller addresses', control: 'text', default: '10.0.0.10 10.0.0.11', hint: 'Space-separated.', showWhen: { input: 'strategy', equals: ['resolver-only'] } },
      { id: 'network', label: 'Network', control: 'text', default: 'prod', hint: 'Where the directory or resolver sits: its aadds or dns-resolver delegated subnet.' },
      LANDING_ZONE_SOURCE,
    ],
    emits: ['azurerm_active_directory_domain_service', 'azurerm_private_dns_resolver', 'azurerm_private_dns_resolver_outbound_endpoint', 'azurerm_private_dns_resolver_dns_forwarding_ruleset', 'azurerm_private_dns_resolver_forwarding_rule', 'azurerm_private_dns_resolver_virtual_network_link'],
    build: (values                 ) => {
      const findings            = [];
      const lz = lzRef(values);
      const managed = valueOf(values, 'strategy', 'resolver-only') === 'managed-ad';
      const domain = valueOf(values, 'domain', 'corp.example.com');
      const net = rname(valueOf(values, 'network', 'prod'));
      const rg = `${lz}.resource_group["shared"]`;
      const blocks             = [TF(), ...consumerPreamble('azure', values)];
      if (managed) {
        blocks.push(
          res('azurerm_active_directory_domain_service', 'managed_ad', {
            name: x(`"\${${lz}.prefix}-aadds"`),
            location: x(`${lz}.location`),
            resource_group_name: x(rg),
            domain_name: domain,
            sku: valueOf(values, 'edition', 'Enterprise'),
            filtered_sync_enabled: false,
          }, [
            blk('initial_replica_set', { subnet_id: x(`${lz}.subnet_ids[${q(`${net}/aadds`)}]`) }),
            blk('security', { ntlm_v1_enabled: false, tls_v1_enabled: false, sync_ntlm_passwords: false, sync_on_prem_passwords: true, kerberos_armoring_enabled: true, kerberos_rc4_encryption_enabled: false }),
          ]),
          output('domain_controller_ips', 'azurerm_active_directory_domain_service.managed_ad.initial_replica_set[0].domain_controller_ip_addresses'),
        );
        findings.push(info('tf.mig.azure-aadds-prereq', 'Domain Services needs its service principal in the tenant and the aadds subnet in the landing zone\'s delegations grid; users sign in with Entra ID passwords once synchronised.', { path: 'strategy' }));
      } else {
        const forwarders = words(valueOf(values, 'dns_forwarders'));
        if (forwarders.length === 0) findings.push(error('tf.mig.identity-no-forwarders', 'Forwarding the domain needs the domain controllers\' addresses.', { path: 'dns_forwarders' }));
        const v6 = forwarders.filter((f) => familyOf(f) === 6);
        if (v6.length > 0) findings.push(info('tf.mig.azure-resolver-ipv4', `The DNS resolver forwards to IPv4 addresses only; ${v6.join(', ')} left out.`, { path: 'dns_forwarders' }));
        blocks.push(
          res('azurerm_private_dns_resolver', 'hub', { name: x(`"\${${lz}.prefix}-resolver"`), location: x(`${lz}.location`), resource_group_name: x(rg), virtual_network_id: x(`${lz}.network_ids[${q(net)}]`) }),
          res('azurerm_private_dns_resolver_outbound_endpoint', 'hub', { name: 'outbound', private_dns_resolver_id: x('azurerm_private_dns_resolver.hub.id'), location: x(`${lz}.location`), subnet_id: x(`${lz}.subnet_ids[${q(`${net}/dns-resolver`)}]`) }),
          res('azurerm_private_dns_resolver_dns_forwarding_ruleset', 'hub', { name: x(`"\${${lz}.prefix}-ruleset"`), resource_group_name: x(rg), location: x(`${lz}.location`), private_dns_resolver_outbound_endpoint_ids: x('[azurerm_private_dns_resolver_outbound_endpoint.hub.id]') }),
          res('azurerm_private_dns_resolver_forwarding_rule', 'domain', { name: ident(domain), dns_forwarding_ruleset_id: x('azurerm_private_dns_resolver_dns_forwarding_ruleset.hub.id'), domain_name: `${domain.replace(/\.$/, '')}.`, enabled: true }, forwarders.filter((f) => familyOf(f) === 4).map((f) => blk('target_dns_servers', { ip_address: f, port: 53 }))),
          res('azurerm_private_dns_resolver_virtual_network_link', 'network', { for_each: x(`${lz}.network_ids`), name: x('"link-${each.key}"'), dns_forwarding_ruleset_id: x('azurerm_private_dns_resolver_dns_forwarding_ruleset.hub.id'), virtual_network_id: x('each.value') }),
          output('resolver_id', 'azurerm_private_dns_resolver.hub.id'),
        );
      }
      return { files: { 'main.tf': mainTf(blocks, `Azure identity: ${managed ? 'Entra Domain Services' : 'DNS forwarding'} for ${domain}`) }, findings };
    },
  };
}

// ---------------------------------------------------------------------------
// Connectivity
// ---------------------------------------------------------------------------

function azureConnectivity()            {
  return {
    id: 'azure_mig_connectivity',
    label: 'Connectivity (migration)',
    group: MIGRATION_GROUP,
    description: 'An active-active, zone-redundant VPN gateway with BGP in the hub network, a connection per VPN site, ExpressRoute (circuit, private peering with IPv6, gateway and connection) for circuit sites, and hub-and-spoke peering that lets every network use the gateways.',
    inputs: [
      gridInput('sites', 'Sites', SITE_COLUMNS, DEFAULT_SITES, 'One row per on-premises site. Method: vpn, circuit (ExpressRoute), or circuit with a VPN backup. The circuit id is an existing ExpressRoute circuit\'s resource id; blank creates one.'),
      { id: 'cloud_asn', label: 'Azure side ASN', control: 'number', default: 65515, min: 1, max: 4294967295 },
      { id: 'network', label: 'Hub network', control: 'text', default: 'prod', hint: 'The network holding GatewaySubnet; every other network peers to it.' },
      LANDING_ZONE_SOURCE,
    ],
    emits: ['azurerm_public_ip', 'azurerm_virtual_network_gateway', 'azurerm_local_network_gateway', 'azurerm_virtual_network_gateway_connection', 'azurerm_express_route_circuit', 'azurerm_express_route_circuit_peering', 'azurerm_virtual_network_peering'],
    build: (values                 ) => {
      const findings            = [];
      const lz = lzRef(values);
      const sites = parseSites(valueOf(values, 'sites'), findings);
      const asn = numberOf(values, 'cloud_asn', 65515);
      const hub = rname(valueOf(values, 'network', 'prod'));
      const rg = `${lz}.resource_group[${q(hub)}]`;
      const loc = `${lz}.location`;
      const gwSubnet = `${lz}.subnet_ids[${q(`${hub}/GatewaySubnet`)}]`;
      const blocks             = [TF(), ...consumerPreamble('azure', values)];
      const vpnSites = sites.filter((s) => s.vpn);
      const erSites = sites.filter((s) => s.usesCircuit);
      if (vpnSites.length > 0) {
        blocks.push(
          res('azurerm_public_ip', 'vpn', { count: 2, name: x(`"\${${lz}.prefix}-vpngw-pip-\${count.index + 1}"`), location: x(loc), resource_group_name: x(rg), allocation_method: 'Static', sku: 'Standard', zones: ['1', '2', '3'] }),
          res('azurerm_virtual_network_gateway', 'vpn', {
            name: x(`"\${${lz}.prefix}-vpngw"`),
            location: x(loc),
            resource_group_name: x(rg),
            type: 'Vpn',
            vpn_type: 'RouteBased',
            sku: 'VpnGw2AZ',
            generation: 'Generation2',
            active_active: true,
            bgp_enabled: true,
          }, [
            blk('ip_configuration', { name: 'gw1', subnet_id: x(gwSubnet), public_ip_address_id: x('azurerm_public_ip.vpn[0].id'), private_ip_address_allocation: 'Dynamic' }),
            blk('ip_configuration', { name: 'gw2', subnet_id: x(gwSubnet), public_ip_address_id: x('azurerm_public_ip.vpn[1].id'), private_ip_address_allocation: 'Dynamic' }),
            // APIPA BGP addresses, so any peer (and the other clouds) can reach them the same way.
            blk('bgp_settings', { asn }, [
              blk('peering_addresses', { ip_configuration_name: 'gw1', apipa_addresses: ['169.254.21.1'] }),
              blk('peering_addresses', { ip_configuration_name: 'gw2', apipa_addresses: ['169.254.22.1'] }),
            ]),
          ]),
        );
        vpnSites.forEach((s, i) => {
          blocks.push(
            secretVariable(`vpn_psk_${s.id}_1`, `Pre-shared key for the connection to ${s.name}.`),
            res('azurerm_local_network_gateway', s.id, { name: x(`"\${${lz}.prefix}-${s.name}"`), location: x(loc), resource_group_name: x(rg), gateway_address: s.peer }, [
              blk('bgp_settings', { asn: s.asn, bgp_peering_address: `169.254.21.${4 * i + 2}` }),
            ]),
            res('azurerm_virtual_network_gateway_connection', s.id, {
              name: x(`"\${${lz}.prefix}-${s.name}"`),
              location: x(loc),
              resource_group_name: x(rg),
              type: 'IPsec',
              virtual_network_gateway_id: x('azurerm_virtual_network_gateway.vpn.id'),
              local_network_gateway_id: x(`azurerm_local_network_gateway.${s.id}.id`),
              shared_key: x(`var.vpn_psk_${s.id}_1`),
              connection_protocol: 'IKEv2',
              bgp_enabled: true,
            }),
          );
          if (s.cidrs.some((c) => familyOf(c) === 6)) findings.push(info('tf.mig.azure-vpn-ipv6', `Site ${s.name}: IPv6 over the VPN gateway is not configured here; its IPv6 ranges reach Azure over ExpressRoute or not at all.`, { path: 'sites' }));
        });
        findings.push(info('tf.mig.azure-apipa', 'The gateway\'s BGP addresses are 169.254.21.1 and 169.254.22.1; each site\'s is 169.254.21.(4n+2). Configure the on-premises peers to match.', { path: 'sites' }));
      }
      if (erSites.length > 0) {
        blocks.push(
          res('azurerm_public_ip', 'er', { name: x(`"\${${lz}.prefix}-ergw-pip"`), location: x(loc), resource_group_name: x(rg), allocation_method: 'Static', sku: 'Standard', zones: ['1', '2', '3'] }),
          res('azurerm_virtual_network_gateway', 'er', { name: x(`"\${${lz}.prefix}-ergw"`), location: x(loc), resource_group_name: x(rg), type: 'ExpressRoute', sku: 'ErGw1AZ' }, [
            blk('ip_configuration', { name: 'er', subnet_id: x(gwSubnet), public_ip_address_id: x('azurerm_public_ip.er.id'), private_ip_address_allocation: 'Dynamic' }),
          ]),
        );
        erSites.forEach((s, i) => {
          let circuit = s.circuit;
          if (!circuit) {
            blocks.push(
              variable(`er_provider_${s.id}`, 'string', `ExpressRoute connectivity provider for ${s.name} (as Azure lists it, e.g. Equinix).`),
              variable(`er_location_${s.id}`, 'string', `ExpressRoute peering location for ${s.name} (e.g. Washington DC).`),
              variable(`er_bandwidth_${s.id}`, 'number', `ExpressRoute circuit bandwidth for ${s.name}, Mbps.`, { default: '1000' }),
              res('azurerm_express_route_circuit', s.id, {
                name: x(`"\${${lz}.prefix}-${s.name}"`),
                location: x(loc),
                resource_group_name: x(rg),
                service_provider_name: x(`var.er_provider_${s.id}`),
                peering_location: x(`var.er_location_${s.id}`),
                bandwidth_in_mbps: x(`var.er_bandwidth_${s.id}`),
              }, [blk('sku', { tier: 'Standard', family: 'MeteredData' })]),
            );
            circuit = `azurerm_express_route_circuit.${s.id}.id`;
            blocks.push(
              res('azurerm_express_route_circuit_peering', s.id, {
                peering_type: 'AzurePrivatePeering',
                express_route_circuit_name: x(`azurerm_express_route_circuit.${s.id}.name`),
                resource_group_name: x(rg),
                peer_asn: s.asn,
                primary_peer_address_prefix: `192.168.${100 + i}.0/30`,
                secondary_peer_address_prefix: `192.168.${100 + i}.4/30`,
                vlan_id: 100 + i,
                ipv4_enabled: true,
              }, [blk('ipv6', { primary_peer_address_prefix: `fd00:ffff:${(100 + i).toString(16)}::/126`, secondary_peer_address_prefix: `fd00:ffff:${(100 + i).toString(16)}::4/126`, enabled: true })]),
            );
            findings.push(info('tf.mig.azure-er-peering', `Site ${s.name}: private peering uses 192.168.${100 + i}.0/29 and fd00:ffff:${(100 + i).toString(16)}::/125, VLAN ${100 + i}; change them to what the provider and your routers use. Give the provider the circuit's service key.`, { path: 'sites' }));
          } else {
            circuit = q(circuit);
          }
          blocks.push(
            res('azurerm_virtual_network_gateway_connection', `${s.id}_er`, {
              name: x(`"\${${lz}.prefix}-${s.name}-er"`),
              location: x(loc),
              resource_group_name: x(rg),
              type: 'ExpressRoute',
              virtual_network_gateway_id: x('azurerm_virtual_network_gateway.er.id'),
              express_route_circuit_id: x(circuit),
              ...(s.circuit ? {} : { depends_on: x(`[azurerm_express_route_circuit_peering.${s.id}]`) }),
            }),
          );
        });
      }
      // Hub and spoke.
      const gateways = [...(vpnSites.length > 0 ? ['azurerm_virtual_network_gateway.vpn'] : []), ...(erSites.length > 0 ? ['azurerm_virtual_network_gateway.er'] : [])];
      blocks.push(
        res('azurerm_virtual_network_peering', 'hub_to_spoke', {
          for_each: x(`{ for k, v in ${lz}.network_ids : k => v if k != ${q(hub)} }`),
          name: x('"to-${each.key}"'),
          resource_group_name: x(rg),
          virtual_network_name: x(`${lz}.network_names[${q(hub)}]`),
          remote_virtual_network_id: x('each.value'),
          allow_forwarded_traffic: true,
          allow_gateway_transit: gateways.length > 0,
        }),
        res('azurerm_virtual_network_peering', 'spoke_to_hub', {
          for_each: x(`{ for k, v in ${lz}.network_ids : k => v if k != ${q(hub)} }`),
          name: `to-${hub}`,
          resource_group_name: x(`${lz}.resource_group[each.key]`),
          virtual_network_name: x(`${lz}.network_names[each.key]`),
          remote_virtual_network_id: x(`${lz}.network_ids[${q(hub)}]`),
          allow_forwarded_traffic: true,
          use_remote_gateways: gateways.length > 0,
          ...(gateways.length > 0 ? { depends_on: x(hlist(gateways)) } : {}),
        }),
      );
      if (vpnSites.length > 0) blocks.push(output('vpn_gateway_public_ips', '[for p in azurerm_public_ip.vpn : p.ip_address]', 'Configure these as the peers of each on-premises VPN device.'));
      if (sites.length === 0) findings.push(warning('tf.mig.no-sites', 'The sites grid is empty, so only the peering was built.', { path: 'sites' }));
      return { files: { 'main.tf': mainTf(blocks, `Azure connectivity: ${sites.length} site(s) through the hub ${hub}`) }, findings };
    },
  };
}

// ---------------------------------------------------------------------------
// Compute
// ---------------------------------------------------------------------------

const DEFAULT_VMS                                 = [
  ['web01', 'win-2022', 'mkt:MicrosoftWindowsServer:WindowsServer:2022-datacenter-azure-edition', 'Standard_D2s_v5', '', 'Premium_LRS:128', 'prod', 'web', 'a', 'ahb', 'silver', 'rebuild', 'shop', 'web', 'prod', '1'],
  ['app01', 'ubuntu-24.04', 'mkt:Canonical:ubuntu-24_04-lts:server', 'Standard_D4s_v5', '', 'Premium_LRS:64 Premium_LRS:256', 'prod', 'app', 'b', 'li', 'gold', 'rebuild', 'shop', 'app', 'prod', '1'],
  ['sql01', 'win-2022', 'mkt:MicrosoftSQLServer:sql2022-ws2022:enterprise-gen2', 'Standard_E16-8ds_v5', '', 'Premium_LRS:128 PremiumV2_LRS:1024', 'prod', 'db', 'a', 'ahb', 'gold', 'rebuild', 'erp', 'sqlserver', 'prod', '2'],
  ['db01', 'rhel-8', 'replicated', 'Standard_E8s_v5', '', 'Premium_LRS:128', 'prod', 'db', 'b', 'rhel-byos', 'gold', 'replicate', 'shop', 'oracle', 'prod', '2'],
];

const LICENCE_TYPE                                   = { ahb: 'Windows_Server', 'rhel-byos': 'RHEL_BYOS', 'sles-byos': 'SLES_BYOS' };

/** The dedicated host SKU that fits a size's family, for the rare dedicated-host row. */
const hostSku = (size        )         => (/^Standard_E/.test(size) ? 'Esv5-Type1' : /^Standard_F/.test(size) ? 'Fsv2-Type2' : 'Dsv5-Type1');

function azureCompute()            {
  return {
    id: 'azure_mig_compute',
    label: 'Compute (migration)',
    group: MIGRATION_GROUP,
    description: 'A Linux or Windows VM per rebuild row (Trusted Launch, platform patching, Azure Hybrid Benefit or BYOS from the licence column, dual-stack NIC, customer-managed disk encryption), data disks, and the replicated rows adopted after cutover with import blocks. Writes local.mig_vms.',
    inputs: [
      gridInput('vms', 'VMs', vmColumns(SIZES, ['Premium_LRS', 'PremiumV2_LRS', 'StandardSSD_LRS']), DEFAULT_VMS, 'One row per VM. Image: mkt:<publisher>:<offer>:<sku> or var:<name>. Disks: type:GiB, the first is the OS disk.'),
      { id: 'ssh_public_key_var', label: 'SSH key variable', control: 'text', default: 'ssh_public_key' },
      { id: 'windows_admin_password_var', label: 'Windows admin password variable', control: 'text', default: 'windows_admin_password', hint: 'Azure requires one at create: a sensitive variable, set as TF_VAR_… and never written.' },
      LANDING_ZONE_SOURCE,
    ],
    emits: ['azurerm_network_interface', 'azurerm_linux_virtual_machine', 'azurerm_windows_virtual_machine', 'azurerm_virtual_machine_extension', 'azurerm_managed_disk', 'azurerm_virtual_machine_data_disk_attachment', 'azurerm_dedicated_host_group', 'azurerm_dedicated_host'],
    build: (values                 ) => {
      const findings            = [];
      const lz = lzRef(values);
      const vms = parseVms(valueOf(values, 'vms'), 'Premium_LRS', findings);
      const sshVar = ident(valueOf(values, 'ssh_public_key_var', 'ssh_public_key'));
      const pwVar = ident(valueOf(values, 'windows_admin_password_var', 'windows_admin_password'));
      const anyWindows = vms.some((v) => v.kind === 'windows' && v.method === 'rebuild');
      const hostKey = (vm        ) => (vm.licence === 'dedicated-host' && vm.method === 'rebuild' ? `${hostSku(vm.size)}-${vm.zone}` : '');
      const hosts = new Map                                            ();
      for (const vm of vms) if (hostKey(vm)) hosts.set(hostKey(vm), { sku: hostSku(vm.size), zoneIndex: vm.zoneIndex });
      const imageVars             = [];
      const entries                         = {};
      for (const vm of vms) {
        const img = vm.image;
        let image = 'null';
        let imageId = 'null';
        if (vm.method === 'rebuild') {
          if (img?.kind === 'azure-marketplace') image = hcl({ publisher: img.publisher, offer: img.offer, sku: img.sku }, 3);
          else {
            const v = img?.kind === 'custom' ? img.variable : `image_${ident(vm.name)}`;
            if (!imageVars.some((b) => b.labels?.[0] === v)) imageVars.push(variable(v, 'string', `The image id (gallery or managed image) for ${vm.name} (${vm.os}).`));
            imageId = `var.${v}`;
          }
        }
        const dataType = vm.data.some((d) => d.type === 'PremiumV2_LRS');
        if (dataType && vm.zone === '') findings.push(warning('tf.mig.azure-premiumv2-zone', `${vm.name}: Premium SSD v2 needs a zone.`, { path: 'vms' }));
        entries[vm.key] = vmLocalEntry(vm, {
          subnet: `${lz}.subnet_ids[${q(`${vm.network}/${vm.tier}/${vm.zone}`)}]`,
          resource_group: `${lz}.resource_group[${q(vm.network)}]`,
          image,
          image_id: imageId,
          licence_type: LICENCE_TYPE[vm.licence] ? q(LICENCE_TYPE[vm.licence]          ) : 'null',
          boot_type: q(vm.boot.type === 'PremiumV2_LRS' ? 'Premium_LRS' : vm.boot.type),
          boot_gib: String(vm.boot.gib),
          host_key: q(hostKey(vm)),
        });
        if (vm.cores) findings.push(info('tf.mig.azure-cores', `${vm.name}: Azure limits active cores with a constrained size (e.g. Standard_E16-8ds_v5) rather than a core count; use one in the Size column.`, { path: 'vms' }));
      }
      const disks                          = {};
      for (const vm of vms.filter((v) => v.method === 'rebuild')) {
        vm.data.forEach((d, i) => {
          disks[`${vm.key}-data${i + 1}`] = { vm: vm.key, type: d.type, gib: d.gib, lun: i, caching: d.type === 'PremiumV2_LRS' || d.type.startsWith('Ultra') ? 'None' : 'ReadOnly' };
        });
      }
      const blocks                        = [
        TF(),
        ...consumerPreamble('azure', values),
        sshKeyVariable(sshVar),
        ...(anyWindows ? [secretVariable(pwVar, 'The local administrator password of the Windows VMs (Azure requires one at create; Ansible replaces it with the domain\'s).')] : []),
        // Azure cannot look a VM's NIC or OS disk up from the VM, so each adopted VM brings all three ids.
        variable(
          'cutover_instance_ids',
          'map(object({\n    vm_id      = string\n    nic_id     = string\n    os_disk_id = string\n  }))',
          'Replicated VMs to adopt after cutover: name (as in the grid) to the resource ids Azure Migrate created (the VM, its network interface and its OS disk). Fill cutover.auto.tfvars once they are running, and apply again. Empty adopts nothing.',
          { default: '{}' },
        ),
        ...imageVars,
        {
          type: 'locals',
          comment: 'Every VM in the grid, by name: the compute contract (local.mig_vms) the backup and monitoring blueprints read.',
          attributes: [
            { name: 'mig_vms', value: x(hcl(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, e(v)])), 1)) },
            { name: 'mig_rebuild', value: x('{ for k, v in local.mig_vms : k => v if v.method == "rebuild" }') },
            { name: 'mig_replicated', value: x('{ for k, v in local.mig_vms : k => v if v.method == "replicate" }') },
            { name: 'mig_data_disks', value: x(hcl(disks, 1)) },
            { name: 'mig_bootstrap_linux', value: x(cloudInit(`var.${sshVar}`)) },
            { name: 'mig_bootstrap_windows', value: x(winrmBootstrap(`${lz}.mgmt_cidrs`)) },
            {
              name: 'mig_vm_ids',
              value: x('merge(\n    { for k, v in azurerm_linux_virtual_machine.vm : k => v.id },\n    { for k, v in azurerm_windows_virtual_machine.vm : k => v.id },\n    { for k, v in azurerm_linux_virtual_machine.replicated : k => v.id },\n    { for k, v in azurerm_windows_virtual_machine.replicated : k => v.id },\n  )'),
            },
          ],
        },
      ];
      if (hosts.size > 0) {
        blocks.push(
          res('azurerm_dedicated_host_group', 'mig', {
            for_each: x(hcl(Object.fromEntries([...hosts].map(([k, h]) => [k, { zone_index: h.zoneIndex }])), 1)),
            name: x(`"\${${lz}.prefix}-hosts-\${each.key}"`),
            location: x(`${lz}.location`),
            resource_group_name: x(`${lz}.resource_group["shared"]`),
            platform_fault_domain_count: 1,
            zone: x(`element(${lz}.zones, each.value.zone_index)`),
          }),
          res('azurerm_dedicated_host', 'mig', {
            for_each: x(hcl(Object.fromEntries([...hosts].map(([k, h]) => [k, { sku: h.sku }])), 1)),
            name: x(`"\${${lz}.prefix}-host-\${each.key}"`),
            location: x(`${lz}.location`),
            dedicated_host_group_id: x('azurerm_dedicated_host_group.mig[each.key].id'),
            sku_name: x('each.value.sku'),
            platform_fault_domain: 0,
          }, [], 'Dedicated hosts: only for licences that must be on hardware you control.'),
        );
      }
      const nic = res('azurerm_network_interface', 'vm', {
        for_each: x('local.mig_rebuild'),
        name: x('"${each.key}-nic"'),
        location: x(`${lz}.location`),
        resource_group_name: x('each.value.resource_group'),
        accelerated_networking_enabled: true,
        tags: x('each.value.tags'),
      }, [
        blk('ip_configuration', { name: 'ipv4', subnet_id: x('each.value.subnet'), private_ip_address_allocation: 'Dynamic', private_ip_address_version: 'IPv4', primary: true }),
        { type: 'dynamic', labels: ['ip_configuration'], attributes: attrs({ for_each: x(`${lz}.ipv6[each.value.network] ? ["ipv6"] : []`) }), blocks: [blk('content', { name: 'ipv6', subnet_id: x('each.value.subnet'), private_ip_address_allocation: 'Dynamic', private_ip_address_version: 'IPv6' })] },
      ]);
      const osDisk = blk('os_disk', { caching: 'ReadWrite', storage_account_type: x('each.value.boot_type'), disk_size_gb: x('each.value.boot_gib'), disk_encryption_set_id: x(`${lz}.kms_key_id`) });
      const imageRef = { type: 'dynamic', labels: ['source_image_reference'], attributes: attrs({ for_each: x('each.value.image == null ? [] : [each.value.image]') }), blocks: [blk('content', { publisher: x('source_image_reference.value.publisher'), offer: x('source_image_reference.value.offer'), sku: x('source_image_reference.value.sku'), version: 'latest' })] }            ;
      const identity = blk('identity', { type: 'SystemAssigned, UserAssigned', identity_ids: x(`[${lz}.identity_id]`) });
      const vmCommon = {
        location: x(`${lz}.location`),
        resource_group_name: x('each.value.resource_group'),
        size: x('each.value.size'),
        zone: x(`element(${lz}.zones, each.value.zone_index)`),
        network_interface_ids: x('[azurerm_network_interface.vm[each.key].id]'),
        source_image_id: x('each.value.image_id'),
        license_type: x('each.value.licence_type'),
        patch_mode: 'AutomaticByPlatform',
        patch_assessment_mode: 'AutomaticByPlatform',
        secure_boot_enabled: true,
        vtpm_enabled: true,
        encryption_at_host_enabled: false,
        ...(hosts.size > 0 ? { dedicated_host_id: x('try(azurerm_dedicated_host.mig[each.value.host_key].id, null)') } : {}),
        tags: x('each.value.tags'),
      };
      blocks.push(
        nic,
        res('azurerm_linux_virtual_machine', 'vm', {
          for_each: x('{ for k, v in local.mig_rebuild : k => v if v.kind == "linux" }'),
          name: x('each.key'),
          ...vmCommon,
          admin_username: 'ansible',
          disable_password_authentication: true,
          custom_data: x(`base64encode(${withHost('local.mig_bootstrap_linux')})`),
        }, [blk('admin_ssh_key', { username: 'ansible', public_key: x(`var.${sshVar}`) }), osDisk, imageRef, identity, ignoreChanges(['custom_data', 'source_image_reference', 'admin_ssh_key'])]),
        res('azurerm_windows_virtual_machine', 'vm', {
          for_each: x('{ for k, v in local.mig_rebuild : k => v if v.kind == "windows" }'),
          name: x('each.key'),
          computer_name: x('substr(each.key, 0, 15)'),
          ...vmCommon,
          admin_username: 'azureadmin',
          admin_password: anyWindows ? x(`var.${pwVar}`) : undefined,
          hotpatching_enabled: false,
        }, [osDisk, imageRef, identity, ignoreChanges(['source_image_reference', 'admin_password'])]),
        res('azurerm_virtual_machine_extension', 'winrm', {
          for_each: x('azurerm_windows_virtual_machine.vm'),
          name: 'winrm-bootstrap',
          virtual_machine_id: x('each.value.id'),
          publisher: 'Microsoft.Compute',
          type: 'CustomScriptExtension',
          type_handler_version: '1.10',
          auto_upgrade_minor_version: true,
          // An encoded command: the script needs no file, and no quoting survives three shells.
          protected_settings: x('jsonencode({ commandToExecute = "powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${textencodebase64(local.mig_bootstrap_windows, "UTF-16LE")}" })'),
        }, [ignoreChanges(['protected_settings'])], 'WinRM over HTTPS for Ansible, from the management ranges only.'),
        res('azurerm_managed_disk', 'data', {
          for_each: x('local.mig_data_disks'),
          name: x('each.key'),
          location: x(`${lz}.location`),
          resource_group_name: x('local.mig_vms[each.value.vm].resource_group'),
          storage_account_type: x('each.value.type'),
          create_option: 'Empty',
          disk_size_gb: x('each.value.gib'),
          zone: x(`element(${lz}.zones, local.mig_vms[each.value.vm].zone_index)`),
          disk_encryption_set_id: x(`${lz}.kms_key_id`),
          tags: x('local.mig_vms[each.value.vm].tags'),
        }),
        res('azurerm_virtual_machine_data_disk_attachment', 'data', {
          for_each: x('local.mig_data_disks'),
          managed_disk_id: x('azurerm_managed_disk.data[each.key].id'),
          virtual_machine_id: x('local.mig_vm_ids[each.value.vm]'),
          lun: x('each.value.lun'),
          caching: x('each.value.caching'),
        }),
      );
      // Adopting what Azure Migrate launched.
      const replicated = (kind                     ) => `{ for k, v in var.cutover_instance_ids : k => v if local.mig_vms[k].kind == "${kind}" }`;
      const adoptCommon = (kind                     ) => ({
        for_each: x(replicated(kind)),
        name: x('data.azurerm_virtual_machine.replicated[each.key].name'),
        location: x('data.azurerm_virtual_machine.replicated[each.key].location'),
        resource_group_name: x('data.azurerm_virtual_machine.replicated[each.key].resource_group_name'),
        size: x('local.mig_replicated[each.key].size'),
        network_interface_ids: x('[each.value.nic_id]'),
        // The replicated disk: no image, and no administrator account to create.
        os_managed_disk_id: x('each.value.os_disk_id'),
        license_type: x('local.mig_replicated[each.key].licence_type'),
        tags: x('local.mig_replicated[each.key].tags'),
      });
      const adoptIgnore = (kind                     ) =>
        ignoreChanges(['name', 'location', 'resource_group_name', 'zone', 'os_disk', 'os_managed_disk_id', 'custom_data', 'identity', 'computer_name', 'secure_boot_enabled', 'vtpm_enabled', 'patch_mode', 'patch_assessment_mode', ...(kind === 'linux' ? ['admin_ssh_key', 'disable_password_authentication'] : [])]);
      blocks.push(
        dat('azurerm_virtual_machine', 'replicated', { for_each: x('var.cutover_instance_ids'), name: x('split("/", each.value.vm_id)[8]'), resource_group_name: x('split("/", each.value.vm_id)[4]') }),
        { type: 'import', comment: 'Replicated Linux VMs, adopted after cutover (Terraform 1.7 or later).', attributes: attrs({ for_each: x(replicated('linux')), to: x('azurerm_linux_virtual_machine.replicated[each.key]'), id: x('each.value.vm_id') }) },
        { type: 'import', comment: 'Replicated Windows VMs, adopted after cutover.', attributes: attrs({ for_each: x(replicated('windows')), to: x('azurerm_windows_virtual_machine.replicated[each.key]'), id: x('each.value.vm_id') }) },
        res('azurerm_linux_virtual_machine', 'replicated', adoptCommon('linux'), [blk('os_disk', { caching: 'ReadWrite' }), adoptIgnore('linux')]),
        res('azurerm_windows_virtual_machine', 'replicated', adoptCommon('windows'), [blk('os_disk', { caching: 'ReadWrite' }), adoptIgnore('windows')]),
        output('vms', '{ for k, v in merge(azurerm_linux_virtual_machine.vm, azurerm_windows_virtual_machine.vm) : k => { id = v.id, private_ip = v.private_ip_address, ipv6 = [for a in v.private_ip_addresses : a if can(regex(":", a))], os = local.mig_vms[k].os } }', 'Each built VM: id and addresses, for the Ansible inventory.'),
      );
      for (const vm of vms) {
        if (vm.licence === 'rhel-byos' || vm.licence === 'sles-byos') {
          if (vm.image?.kind === 'azure-marketplace') findings.push(info('tf.mig.azure-byos-plan', `${vm.name}: a BYOS marketplace image needs its plan terms accepted once per subscription (az vm image terms accept).`, { path: 'vms' }));
        }
      }
      findings.push(info('tf.mig.azure-cutover-ids', 'Adopting a replicated VM takes three ids in cutover_instance_ids: the VM, its network interface and its OS disk (Azure cannot look the last two up from the VM). Empty adopts nothing.', { path: 'vms' }));
      return { files: { 'main.tf': mainTf(blocks, `Azure compute: ${vms.length} VM(s)`) }, findings };
    },
  };
}

// ---------------------------------------------------------------------------
// Databases
// ---------------------------------------------------------------------------

const AZURE_DB_SERVICES = ['azure-sqldb', 'azure-sqlmi', 'azure-sqlvm', 'azure-pg-flex', 'azure-mysql-flex', 'azure-vm', 'azure-odb-exadata', 'azure-odb-adb'];
const DEFAULT_DBS                                 = [
  ['crm', 'azure-sqlmi', 'sqlserver', 'sql-enterprise', '2022', 'BC_Gen5_8', '512', 'business-critical', 'ahb', '14', 'prod', 'crm'],
  ['shopdb', 'azure-sqldb', 'sqlserver', 'sql-standard', '', 'GP_Gen5_4', '250', 'zone-redundant', 'ahb', '7', 'prod', 'shop'],
  ['orders', 'azure-pg-flex', 'postgres', 'community', '16', 'GP_Standard_D4ds_v5', '256', 'zone-redundant', 'li', '14', 'prod', 'shop'],
  ['inventory', 'azure-mysql-flex', 'mysql', 'community', '8.0.21', 'GP_Standard_D2ds_v4', '128', 'none', 'li', '7', 'prod', 'shop'],
  ['sql01', 'azure-sqlvm', 'sqlserver', 'sql-enterprise', '2022', '', '', 'none', 'ahb', '7', 'prod', 'erp'],
];

/** PostgreSQL flexible server storage sizes, MB. */
const PG_STORAGE_MB = [32768, 65536, 131072, 262144, 524288, 1048576, 2097152, 4193280, 4194304, 8388608, 16777216, 33553408];

function azureDatabases()            {
  return {
    id: 'azure_mig_databases',
    label: 'Databases (migration)',
    group: MIGRATION_GROUP,
    description: 'Azure SQL Database (Entra-only authentication, private endpoint), SQL Managed Instance (Entra-only, delegated subnet), SQL Server on Azure VMs registered with the SQL IaaS extension, and PostgreSQL / MySQL flexible servers on delegated subnets with zone-redundant HA.',
    inputs: [
      gridInput('databases', 'Databases', dbColumns(AZURE_DB_SERVICES, ['sqlserver', 'postgres', 'mysql', 'oracle'], ['GP_Gen5_4', 'GP_Gen5_8', 'BC_Gen5_8', 'BC_Gen5_16', 'GP_Standard_D2ds_v5', 'GP_Standard_D4ds_v5', 'MO_Standard_E8ds_v5'], ['li', 'ahb']), DEFAULT_DBS, 'One row per database. Class: the SKU (GP_Gen5_8 is General Purpose, 8 vCores). azure-sqlvm rows name the compute row that runs SQL Server.'),
      { id: 'admin_group_object_id', label: 'Database administrators group (object id)', control: 'text', default: '', hint: 'The Entra ID group that administers every database. Blank: a variable.' },
      { id: 'admin_group_name', label: 'Database administrators group (name)', control: 'text', default: 'db-admins' },
      LANDING_ZONE_SOURCE,
    ],
    emits: [
      'azurerm_mssql_server', 'azurerm_mssql_database', 'azurerm_private_endpoint', 'azurerm_private_dns_zone', 'azurerm_private_dns_zone_virtual_network_link', 'azurerm_mssql_managed_instance',
      'azurerm_mssql_virtual_machine', 'azurerm_postgresql_flexible_server', 'azurerm_postgresql_flexible_server_active_directory_administrator', 'azurerm_mysql_flexible_server',
    ],
    build: (values                 ) => {
      const findings            = [];
      const lz = lzRef(values);
      const dbs = parseDbs(valueOf(values, 'databases'), findings);
      const groupId = valueOf(values, 'admin_group_object_id') ? q(valueOf(values, 'admin_group_object_id')) : 'var.db_admin_group_object_id';
      const groupName = valueOf(values, 'admin_group_name', 'db-admins');
      const blocks             = [TF(), ...consumerPreamble('azure', values), dat('azurerm_client_config', 'db', {})];
      if (!valueOf(values, 'admin_group_object_id')) blocks.push(variable('db_admin_group_object_id', 'string', 'Object id of the Entra ID group that administers the databases.'));
      const suffix = '${substr(md5(data.azurerm_client_config.db.subscription_id), 0, 6)}';
      const rgOf = (net        ) => `${lz}.resource_group[${q(net)}]`;
      const tags = (db                                                                   ) => x(hcl({ atk_app: db.app, atk_db: db.engine, atk_backup_days: String(db.backupDays) }));
      const zones                         = {};
      const zone = (name        , dns        ) => {
        if (zones[name]) return zones[name]          ;
        blocks.push(
          res('azurerm_private_dns_zone', name, { name: dns, resource_group_name: x(`${lz}.resource_group["shared"]`) }),
          res('azurerm_private_dns_zone_virtual_network_link', name, { for_each: x(`${lz}.network_ids`), name: x('"link-${each.key}"'), private_dns_zone_id: x(`azurerm_private_dns_zone.${name}.id`), virtual_network_id: x('each.value'), registration_enabled: false }),
        );
        zones[name] = `azurerm_private_dns_zone.${name}.id`;
        return zones[name]          ;
      };
      const needVmIds = dbs.some((d) => d.service === 'azure-sqlvm');
      if (needVmIds && lzSource(values) !== 'stack') blocks.push(variable('mig_vm_ids', 'map(string)', 'The VMs SQL Server runs on, name to VM resource id: the compute blueprint\'s vms output.', { default: '{}' }));
      const vmIds = lzSource(values) === 'stack' ? 'local.mig_vm_ids' : 'var.mig_vm_ids';
      for (const db of dbs) {
        const ha = db.ha !== 'none';
        const ahb = db.licence === 'ahb' || db.licence.startsWith('byol');
        const net = db.network;
        if (db.service === 'azure-sqldb') {
          const sqlZone = zone('sql', 'privatelink.database.windows.net');
          blocks.push(
            res('azurerm_mssql_server', db.id, {
              name: x(`"\${${lz}.prefix}-${db.name}-${suffix}"`),
              resource_group_name: x(rgOf(net)),
              location: x(`${lz}.location`),
              version: '12.0',
              minimum_tls_version: '1.2',
              public_network_access_enabled: false,
              tags: tags(db),
            }, [
              blk('azuread_administrator', { login_username: groupName, object_id: x(groupId), azuread_authentication_only: true }),
              blk('identity', { type: 'SystemAssigned' }),
            ]),
            res('azurerm_mssql_database', db.id, {
              name: db.name,
              server_id: x(`azurerm_mssql_server.${db.id}.id`),
              sku_name: db.cls || 'GP_Gen5_4',
              max_size_gb: db.storage,
              zone_redundant: ha,
              license_type: /^(GP|BC|HS)_/.test(db.cls || 'GP_') ? (ahb ? 'BasePrice' : 'LicenseIncluded') : undefined,
              tags: tags(db),
            }, [blk('short_term_retention_policy', { retention_days: Math.min(35, Math.max(1, db.backupDays)) })]),
            res('azurerm_private_endpoint', db.id, {
              name: x(`"\${${lz}.prefix}-${db.name}-pe"`),
              location: x(`${lz}.location`),
              resource_group_name: x(rgOf(net)),
              subnet_id: x(`${lz}.subnet_ids[${q(`${net}/db/a`)}]`),
            }, [
              blk('private_service_connection', { name: 'sql', private_connection_resource_id: x(`azurerm_mssql_server.${db.id}.id`), subresource_names: ['sqlServer'], is_manual_connection: false }),
              blk('private_dns_zone_group', { name: 'sql', private_dns_zone_ids: x(`[${sqlZone}]`) }),
            ]),
          );
        } else if (db.service === 'azure-sqlmi') {
          const m = /^(GP|BC)_(Gen\w+?)_(\d+)$/.exec(db.cls || 'GP_Gen5_8');
          const sku = m ? `${m[1]}_${m[2]}` : 'GP_Gen5';
          const vcores = m ? Number(m[3]) : 8;
          blocks.push(
            res('azurerm_mssql_managed_instance', db.id, {
              name: x(`"\${${lz}.prefix}-${db.name}-${suffix}"`),
              resource_group_name: x(rgOf(net)),
              location: x(`${lz}.location`),
              license_type: ahb ? 'BasePrice' : 'LicenseIncluded',
              sku_name: sku,
              vcores,
              storage_size_in_gb: Math.max(32, Math.ceil(db.storage / 32) * 32),
              subnet_id: x(`${lz}.subnet_ids[${q(`${net}/sqlmi`)}]`),
              minimum_tls_version: '1.2',
              public_data_endpoint_enabled: false,
              zone_redundant_enabled: ha,
              storage_account_type: ha ? 'ZRS' : 'GRS',
              tags: tags(db),
            }, [
              // Entra-only: no SQL login and no password is created at all.
              blk('azure_active_directory_administrator', { login_username: groupName, object_id: x(groupId), principal_type: 'Group', azuread_authentication_only_enabled: true, tenant_id: x('data.azurerm_client_config.db.tenant_id') }),
              blk('identity', { type: 'SystemAssigned' }),
            ]),
          );
          if (!m) findings.push(warning('tf.mig.azure-mi-class', `${db.name}: "${db.cls}" is not GP_Gen5_<vCores> or BC_Gen5_<vCores>; written as GP_Gen5 with 8 vCores.`, { path: 'databases' }));
        } else if (db.service === 'azure-sqlvm') {
          blocks.push(
            res('azurerm_mssql_virtual_machine', db.id, {
              virtual_machine_id: x(`${vmIds}[${q(db.name)}]`),
              sql_license_type: ahb ? 'AHUB' : 'PAYG',
              sql_connectivity_type: 'PRIVATE',
              sql_connectivity_port: 1433,
              tags: tags(db),
            }, [blk('auto_patching', { day_of_week: 'Sunday', maintenance_window_starting_hour: 2, maintenance_window_duration_in_minutes: 60 })]),
          );
          if (ha) findings.push(info('tf.mig.azure-sqlvm-ag', `${db.name}: the availability group across SQL VMs is built by Ansible (the mssql_ag role) with the vaulted domain credentials, not here.`, { path: 'databases' }));
        } else if (db.service === 'azure-pg-flex') {
          const pgZone = zone('postgres', 'privatelink.postgres.database.azure.com');
          const mb = PG_STORAGE_MB.find((s) => s >= db.storage * 1024) ?? 33553408;
          blocks.push(
            res('azurerm_postgresql_flexible_server', db.id, {
              name: x(`"\${${lz}.prefix}-${db.name}-${suffix}"`),
              resource_group_name: x(rgOf(net)),
              location: x(`${lz}.location`),
              version: db.version || '16',
              sku_name: db.cls || 'GP_Standard_D4ds_v5',
              storage_mb: mb,
              delegated_subnet_id: x(`${lz}.subnet_ids[${q(`${net}/postgres`)}]`),
              private_dns_zone_id: x(pgZone),
              public_network_access_enabled: false,
              backup_retention_days: Math.min(35, Math.max(7, db.backupDays)),
              zone: '1',
              tags: tags(db),
              depends_on: x('[azurerm_private_dns_zone_virtual_network_link.postgres]'),
            }, [
              // Entra ID only: no administrator password exists.
              blk('authentication', { active_directory_auth_enabled: true, password_auth_enabled: false, tenant_id: x('data.azurerm_client_config.db.tenant_id') }),
              ...(ha ? [blk('high_availability', { mode: 'ZoneRedundant', standby_availability_zone: '2' })] : []),
            ]),
            res('azurerm_postgresql_flexible_server_active_directory_administrator', db.id, {
              server_name: x(`azurerm_postgresql_flexible_server.${db.id}.name`),
              resource_group_name: x(rgOf(net)),
              tenant_id: x('data.azurerm_client_config.db.tenant_id'),
              object_id: x(groupId),
              principal_name: groupName,
              principal_type: 'Group',
            }),
          );
        } else if (db.service === 'azure-mysql-flex') {
          const myZone = zone('mysql', 'privatelink.mysql.database.azure.com');
          const pw = `mysql_admin_password_${db.id}`;
          blocks.push(
            secretVariable(pw, `The administrator password of the ${db.name} MySQL flexible server (write-only: never stored in state).`),
            res('azurerm_mysql_flexible_server', db.id, {
              name: x(`"\${${lz}.prefix}-${db.name}-${suffix}"`),
              resource_group_name: x(rgOf(net)),
              location: x(`${lz}.location`),
              version: db.version || '8.0.21',
              sku_name: db.cls || 'GP_Standard_D2ds_v4',
              delegated_subnet_id: x(`${lz}.subnet_ids[${q(`${net}/mysql`)}]`),
              private_dns_zone_id: x(myZone),
              administrator_login: 'dbadmin',
              administrator_password_wo: x(`var.${pw}`),
              administrator_password_wo_version: 1,
              backup_retention_days: Math.min(35, Math.max(1, db.backupDays)),
              zone: '1',
              tags: tags(db),
              depends_on: x('[azurerm_private_dns_zone_virtual_network_link.mysql]'),
            }, [blk('storage', { size_gb: Math.max(20, db.storage), auto_grow_enabled: true }), ...(ha ? [blk('high_availability', { mode: 'ZoneRedundant', standby_availability_zone: '2' })] : [])]),
          );
        } else if (db.service === 'azure-vm') {
          findings.push(info('tf.mig.db-on-vm', `${db.name} runs on a VM: its hosts are compute rows, and Ansible installs it.`, { path: 'databases' }));
        } else if (db.service.startsWith('azure-odb')) {
          findings.push(info('tf.mig.db-odb', `${db.name} is on Oracle Database@Azure: see the Oracle Database@Azure blueprint.`, { path: 'databases' }));
        } else {
          findings.push(warning('tf.mig.db-service', `${db.name}: "${db.service}" is not an Azure database service; left out.`, { path: 'databases' }));
        }
      }
      return { files: { 'main.tf': mainTf(blocks, `Azure databases: ${dbs.length} row(s)`) }, findings };
    },
  };
}

// ---------------------------------------------------------------------------
// Oracle Database@Azure
// ---------------------------------------------------------------------------

function azureOracleDatabase()            {
  return {
    id: 'azure_mig_oracle_database',
    label: 'Oracle Database@Azure (migration)',
    group: MIGRATION_GROUP,
    description: 'Exadata infrastructure, an Exadata VM cluster and an Autonomous Database on the landing zone\'s Oracle delegated subnet; the database homes and databases in the VM cluster are created through OCI.',
    inputs: [...odbInputs('azure'), { id: 'ssh_public_key_var', label: 'SSH key variable', control: 'text', default: 'ssh_public_key' }],
    emits: ['azurerm_oracle_exadata_infrastructure', 'azurerm_oracle_cloud_vm_cluster', 'azurerm_oracle_autonomous_database', 'oci_database_db_home', 'oci_database_database'],
    build: (values                 ) => {
      const findings            = [oracleRegionFinding('Azure', 'the region')];
      const lz = lzRef(values);
      const net = rname(valueOf(values, 'network', 'prod'));
      const pw = ident(valueOf(values, 'admin_password_var', 'odb_admin_password'));
      const ssh = ident(valueOf(values, 'ssh_public_key_var', 'ssh_public_key'));
      const create = valueOf(values, 'create_databases', 'yes') === 'yes';
      const licence = valueOf(values, 'licence', 'BRING_YOUR_OWN_LICENSE') === 'LICENSE_INCLUDED' ? 'LicenseIncluded' : 'BringYourOwnLicense';
      const rg = `${lz}.resource_group[${q(net)}]`;
      const subnet = `${lz}.subnet_ids[${q(`${net}/oracle`)}]`;
      const blocks             = [
        terraformBlock(create ? ['azure', 'oci'] : ['azure']),
        ...consumerPreamble('azure', values),
        sshKeyVariable(ssh),
        secretVariable(pw, 'The ADMIN password of the Autonomous Database and the SYS password of the databases created in the VM cluster.'),
        res('azurerm_oracle_exadata_infrastructure', 'odb', {
          name: x(`"\${${lz}.prefix}-exadata"`),
          display_name: x(`"\${${lz}.prefix}-exadata"`),
          resource_group_name: x(rg),
          location: x(`${lz}.location`),
          zones: ['1'],
          shape: valueOf(values, 'exadata_shape', 'Exadata.X11M'),
          compute_count: numberOf(values, 'compute_count', 2),
          storage_count: numberOf(values, 'storage_count', 3),
        }),
        dat('azurerm_oracle_db_servers', 'odb', { resource_group_name: x(rg), cloud_exadata_infrastructure_name: x('azurerm_oracle_exadata_infrastructure.odb.name') }),
        res('azurerm_oracle_cloud_vm_cluster', 'odb', {
          name: x(`"\${${lz}.prefix}-vmc"`),
          display_name: x(`"\${${lz}.prefix}-vmc"`),
          resource_group_name: x(rg),
          location: x(`${lz}.location`),
          cloud_exadata_infrastructure_id: x('azurerm_oracle_exadata_infrastructure.odb.id'),
          cpu_core_count: numberOf(values, 'vm_cluster_cores', 16),
          db_servers: x('[for s in data.azurerm_oracle_db_servers.odb.db_servers : s.ocid]'),
          gi_version: '23.0.0.0',
          hostname: 'odb',
          license_model: licence,
          ssh_public_keys: x(`[var.${ssh}]`),
          subnet_id: x(subnet),
          virtual_network_id: x(`${lz}.network_ids[${q(net)}]`),
        }, [blk('data_collection_options', { diagnostics_events_enabled: true, health_monitoring_enabled: true, incident_logs_enabled: true })]),
        res('azurerm_oracle_autonomous_database', 'odb', {
          // Letters and numbers only, for both.
          name: x(`"\${replace(${lz}.prefix, "-", "")}adb"`),
          display_name: x(`"\${replace(${lz}.prefix, "-", "")}adb"`),
          resource_group_name: x(rg),
          location: x(`${lz}.location`),
          admin_password: x(`var.${pw}`),
          compute_model: 'ECPU',
          compute_count: 2,
          data_storage_size_in_tbs: 1,
          db_version: '23ai',
          db_workload: 'OLTP',
          license_model: licence,
          character_set: 'AL32UTF8',
          national_character_set: 'AL16UTF16',
          auto_scaling_enabled: true,
          auto_scaling_for_storage_enabled: true,
          backup_retention_period_in_days: 30,
          mtls_connection_required: false,
          subnet_id: x(subnet),
          virtual_network_id: x(`${lz}.network_ids[${q(net)}]`),
        }),
        ...odbOciDatabases(values, 'azurerm_oracle_cloud_vm_cluster.odb.ocid', 'azurerm_oracle_cloud_vm_cluster.odb'),
        output('vm_cluster_ocid', 'azurerm_oracle_cloud_vm_cluster.odb.ocid'),
      ];
      return { files: { 'main.tf': mainTf(blocks, 'Oracle Database@Azure') }, findings };
    },
  };
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

function azureBackup()            {
  return {
    id: 'azure_mig_backup',
    label: 'Backup (migration)',
    group: MIGRATION_GROUP,
    description: 'A Recovery Services vault (immutable and geo-redundant with cross-region restore where the tiers ask), a VM backup policy per tier (Enhanced for hourly), every VM protected by its tier, and SQL Server in VM workload policies.',
    inputs: backupInputs(),
    emits: ['azurerm_recovery_services_vault', 'azurerm_backup_policy_vm', 'azurerm_backup_protected_vm', 'azurerm_backup_policy_vm_workload'],
    build: (values                 ) => {
      const findings            = [];
      const lz = lzRef(values);
      const tiers = parseBackupTiers(valueOf(values, 'tiers'), findings);
      const dr = valueOf(values, 'dr_region');
      const src = vmSource(values);
      const rg = `${lz}.resource_group["shared"]`;
      const immutable = tiers.some((t) => t.immutable);
      const copy = tiers.some((t) => t.copy);
      const blocks             = [TF(), ...consumerPreamble('azure', values), ...src.blocks];
      blocks.push(
        res('azurerm_recovery_services_vault', 'landing_zone', {
          name: x(`"\${${lz}.prefix}-rsv"`),
          location: x(`${lz}.location`),
          resource_group_name: x(rg),
          sku: 'Standard',
          storage_mode_type: copy ? 'GeoRedundant' : 'ZoneRedundant',
          cross_region_restore_enabled: copy ? true : undefined,
          immutability: immutable ? 'Locked' : 'Unlocked',
          public_network_access_enabled: false,
        }, [blk('monitoring', { alerts_for_all_job_failures_enabled: true, alerts_for_critical_operation_failures_enabled: true })], immutable ? 'Locked immutability cannot be undone: recovery points are kept until they expire, whatever anyone does.' : undefined),
      );
      if (copy && dr) findings.push(info('tf.mig.azure-dr-pair', `Geo-redundant vault storage copies to the region's pair, not to ${dr}; cross-region restore restores there.`, { path: 'dr_region' }));
      for (const t of tiers) {
        const hourly = t.hours < 24;
        blocks.push(
          res('azurerm_backup_policy_vm', t.tier.replace(/-/g, '_'), {
            name: `${t.tier}`,
            resource_group_name: x(rg),
            recovery_vault_name: x('azurerm_recovery_services_vault.landing_zone.name'),
            policy_type: hourly ? 'V2' : 'V1',
            timezone: 'UTC',
            instant_restore_retention_days: hourly ? 7 : 2,
          }, [
            blk('backup', hourly ? { frequency: 'Hourly', time: '00:00', hour_interval: Math.max(4, t.hours), hour_duration: 24 } : { frequency: 'Daily', time: '23:00' }),
            blk('retention_daily', { count: Math.max(7, t.retention) }),
          ]),
          res('azurerm_backup_policy_vm_workload', `${t.tier.replace(/-/g, '_')}_sql`, {
            name: `${t.tier}-sql`,
            resource_group_name: x(rg),
            recovery_vault_name: x('azurerm_recovery_services_vault.landing_zone.name'),
            workload_type: 'SQLDataBase',
          }, [
            blk('settings', { time_zone: 'UTC', compression_enabled: true }),
            blk('protection_policy', { policy_type: 'Full' }, [blk('backup', { frequency: 'Daily', time: '22:00' }), blk('retention_daily', { count: Math.max(7, t.retention) })]),
            blk('protection_policy', { policy_type: 'Log' }, [blk('backup', { frequency_in_minutes: 60 }), blk('simple_retention', { count: Math.min(35, Math.max(7, t.retention)) })]),
          ]),
        );
      }
      const known = hcl(tiers.map((t) => t.tier));
      blocks.push(
        res('azurerm_backup_protected_vm', 'vm', {
          for_each: x(`{ for k, v in ${src.expr} : k => v if contains(${known}, v.backup) }`),
          resource_group_name: x(rg),
          recovery_vault_name: x('azurerm_recovery_services_vault.landing_zone.name'),
          source_vm_id: x('each.value.id'),
          backup_policy_id: x(`{ ${tiers.map((t) => `${q(t.tier)} = azurerm_backup_policy_vm.${t.tier.replace(/-/g, '_')}.id`).join(', ')} }[each.value.backup]`),
        }),
        output('vault_id', 'azurerm_recovery_services_vault.landing_zone.id'),
      );
      return { files: { 'main.tf': mainTf(blocks, `Azure backup: ${tiers.length} tier(s)`) }, findings };
    },
  };
}

// ---------------------------------------------------------------------------
// Monitoring
// ---------------------------------------------------------------------------

function azureMonitoring()            {
  return {
    id: 'azure_mig_monitoring',
    label: 'Monitoring (migration)',
    group: MIGRATION_GROUP,
    description: 'The Azure Monitor Agent on every VM, with a data collection rule sending performance counters, syslog and Windows events to the landing zone\'s Log Analytics workspace.',
    inputs: [...monitoringInputs(), LANDING_ZONE_SOURCE],
    emits: ['azurerm_monitor_data_collection_rule', 'azurerm_monitor_data_collection_rule_association', 'azurerm_virtual_machine_extension'],
    build: (values                 ) => {
      const findings            = [];
      const lz = lzRef(values);
      const src = vmSource(values);
      const siem = valueOf(values, 'siem', 'none');
      const blocks             = [
        TF(),
        ...consumerPreamble('azure', values),
        ...src.blocks,
        res('azurerm_monitor_data_collection_rule', 'vms', {
          name: x(`"\${${lz}.prefix}-vms"`),
          location: x(`${lz}.location`),
          resource_group_name: x(`${lz}.resource_group["shared"]`),
          description: 'Performance, syslog and Windows events from the migrated VMs',
        }, [
          blk('destinations', {}, [blk('log_analytics', { name: 'workspace', workspace_resource_id: x(`${lz}.log_destination`) })]),
          blk('data_flow', { streams: ['Microsoft-Perf', 'Microsoft-Syslog', 'Microsoft-Event'], destinations: ['workspace'] }),
          blk('data_sources', {}, [
            blk('performance_counter', { name: 'perf', streams: ['Microsoft-Perf'], sampling_frequency_in_seconds: 60, counter_specifiers: ['\\Processor Information(_Total)\\% Processor Time', '\\Memory\\% Committed Bytes In Use', '\\LogicalDisk(_Total)\\% Free Space', 'Processor(*)\\% Processor Time', 'Memory(*)\\% Used Memory', 'Logical Disk(*)\\% Used Space'] }),
            blk('syslog', { name: 'syslog', streams: ['Microsoft-Syslog'], facility_names: ['auth', 'authpriv', 'daemon', 'kern', 'syslog'], log_levels: ['Warning', 'Error', 'Critical', 'Alert', 'Emergency'] }),
            blk('windows_event_log', { name: 'events', streams: ['Microsoft-Event'], x_path_queries: ['System!*[System[(Level=1 or Level=2 or Level=3)]]', 'Application!*[System[(Level=1 or Level=2)]]', 'Security!*[System[(band(Keywords,13510798882111488))]]'] }),
          ]),
        ]),
        res('azurerm_virtual_machine_extension', 'ama', {
          for_each: x(src.expr),
          name: x('each.value.kind == "windows" ? "AzureMonitorWindowsAgent" : "AzureMonitorLinuxAgent"'),
          virtual_machine_id: x('each.value.id'),
          publisher: 'Microsoft.Azure.Monitor',
          type: x('each.value.kind == "windows" ? "AzureMonitorWindowsAgent" : "AzureMonitorLinuxAgent"'),
          type_handler_version: '1.0',
          auto_upgrade_minor_version: true,
          automatic_upgrade_enabled: true,
        }),
        res('azurerm_monitor_data_collection_rule_association', 'vms', {
          for_each: x(src.expr),
          name: x('"${each.key}-dcr"'),
          target_resource_id: x('each.value.id'),
          data_collection_rule_id: x('azurerm_monitor_data_collection_rule.vms.id'),
          depends_on: x('[azurerm_virtual_machine_extension.ama]'),
        }),
        output('data_collection_rule_id', 'azurerm_monitor_data_collection_rule.vms.id'),
      ];
      if (siem === 'sentinel') findings.push(info('tf.mig.siem', 'Microsoft Sentinel is enabled on the landing zone\'s workspace (onboarding is a separate step); these VMs\' events land there.', { path: 'siem' }));
      else if (siem !== 'none') findings.push(info('tf.mig.siem', `Forwarding to ${siem} is configured in the SIEM, which reads the Log Analytics workspace or an event hub export; nothing is written here for it.`, { path: 'siem' }));
      return { files: { 'main.tf': mainTf(blocks, 'Azure monitoring: the Azure Monitor Agent and a data collection rule') }, findings };
    },
  };
}

export const MIGRATION_TERRAFORM_AZURE                       = [
  azureLandingZone(),
  azureIdentity(),
  azureConnectivity(),
  azureCompute(),
  azureDatabases(),
  azureOracleDatabase(),
  azureBackup(),
  azureMonitoring(),
];

/** The delegations the landing zone knows, for the planner's validation. */
export const AZURE_DELEGATIONS                    = Object.keys(DELEGATIONS);
