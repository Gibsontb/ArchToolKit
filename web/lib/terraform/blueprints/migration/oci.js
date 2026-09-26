/**
 * OCI blueprints for a migration plan: landing zone, connectivity, compute,
 * databases, backup and monitoring. There is no identity blueprint on OCI:
 * the domain controllers are compute rows (extend-dcs).
 *
 * See ./common.ts for the landing-zone contract and the grid formats. Every
 * argument written here was checked against the oci provider's own schema
 * (9.3) with `terraform validate`, by tools/validate-terraform-blueprints.mjs.
 *
 * OCI specifics worth knowing before reading:
 * - Everything lives in a compartment, which the landing zone creates under
 *   the parent it is given, and exposes as `compartment_id`.
 * - Subnets are regional, so the contract's `<network>/<tier>/<zone>` keys all
 *   point at the tier's one subnet; the zone picks the availability domain.
 * - Route rules live inside a route table, and another item cannot add its
 *   own without fighting over the table. So the DRG is created here, with the
 *   routes to on-premises through it, and connectivity only attaches VPN and
 *   FastConnect to it (`drg_id`).
 * - Security-rule protocols are IP protocol numbers as strings: "6" TCP,
 *   "17" UDP, "1" ICMP, "58" ICMPv6.
 */

import { info, warning,              } from '../../../core/findings.js';
import { familyOf } from '../../../core/ip.js';
                                                                            
import { num as numberOf, str as valueOf } from '../../../kit/blueprint.js';
import { OCI_REGIONS } from '../../../kit/regions.js';
                                             
import { emitFoundation } from '../../index.js';
import {
  backupInputs,
  monitoringInputs,
  DB_PORTS,
  DEFAULT_SITES,
  LANDING_ZONE_SOURCE,
  MIGRATION_GROUP,
  SITE_COLUMNS,
  ZONE_LETTERS,
  attrs,
  blk,
  carveNetwork,
  cloudInit,
  consumerPreamble,
  cutoverVariable,
  dat,
  dbColumns,
  e,
  gridInput,
  hcl,
  hobj,
  ident,
  ignoreChanges,
  insertBeforeClose,
  landingZoneInputs,
  landingZoneLocal,
  landingZoneNote,
  lzRef,
  mainTf,
  output,
  parseBackupTiers,
  parseDbs,
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
  variable,
  vmColumns,
  vmLocalEntry,
  vmSource,
  winrmBootstrap,
  withHost,
  x,
              
                   
                  
              
} from './common.js';

const REGION = 'us-ashburn-1';
const TF = () => terraformBlock(['oci']);

const failed = (id        , findings                    ) => ({
  files: { 'main.tf': `# ${id}: nothing was generated; see the findings.\n` },
  findings,
});

/** OCI Logging keeps a log for 30 to 180 days, in steps of 30. */
function logRetention(days        )         {
  const allowed = [30, 60, 90, 120, 150, 180];
  return allowed.find((d) => d >= days) ?? 180;
}

/** Something OCI accepts as a name inside another: letters and digits, starting with a letter. */
function alnum(s        , max        )         {
  const a = s.replace(/[^A-Za-z0-9]/g, '');
  return (/^[A-Za-z]/.test(a) ? a : `x${a}`).slice(0, max);
}

// ---------------------------------------------------------------------------
// Landing zone
// ---------------------------------------------------------------------------

                   
                         
                        
                                                  
                         
                         
                       
                         
                             
                        
                            
 

const TCP = '6';
const UDP = '17';
const ICMP = '1';
const ICMPV6 = '58';

/** Ports a domain controller in the mgmt tier needs open to the network and to on-premises DCs. */
const AD_PORTS                                                 = [
  [TCP, 53, 53], [UDP, 53, 53], [TCP, 88, 88], [UDP, 88, 88], [UDP, 123, 123], [TCP, 135, 135],
  [TCP, 389, 389], [UDP, 389, 389], [TCP, 445, 445], [TCP, 464, 464], [UDP, 464, 464],
  [TCP, 636, 636], [TCP, 3268, 3269], [TCP, 49152, 65535],
];

const PROTO_NAME                         = { [TCP]: 'TCP', [UDP]: 'UDP', [ICMP]: 'ICMP', [ICMPV6]: 'ICMPv6', all: 'all' };

function tierRules(n             , tier        , sites                   , bastionCidr               )            {
  const rules            = [];
  const has = (t        ) => n.tiers.includes(t         );
  const nsg = (t        ) => `oci_core_network_security_group.${n.id}_${t}.id`;
  const vcn6 = `oci_core_vcn.${n.id}.ipv6cidr_blocks[0]`;
  const siteRule = (port        ) => sites.forEach((c, i) => rules.push({ label: `site_tcp_${port}_${i}`, desc: `TCP ${port} from ${c}`, proto: TCP, from: port, to: port, cidr: c }));
  // Ansible (SSH, WinRM over HTTPS) from on-premises reaches every tier.
  siteRule(22);
  siteRule(5986);
  if (tier === 'mgmt') siteRule(3389);
  if (bastionCidr) {
    // The Bastion service's private endpoint sits in the mgmt subnet of the first network.
    rules.push({ label: 'bastion_22', desc: 'SSH from the Bastion service', proto: TCP, from: 22, to: 22, cidr: bastionCidr });
    rules.push({ label: 'bastion_3389', desc: 'RDP from the Bastion service', proto: TCP, from: 3389, to: 3389, cidr: bastionCidr });
  }
  if (tier === 'web') {
    siteRule(443);
    rules.push({ label: 'vcn_443', desc: 'HTTPS from inside the VCN (load balancers)', proto: TCP, from: 443, to: 443, cidr: n.cidr });
    if (n.ipv6) rules.push({ label: 'vcn_443_v6', desc: 'HTTPS from inside the VCN, IPv6', proto: TCP, from: 443, to: 443, cidrExpr: vcn6 });
  }
  if (tier === 'app' && has('web')) rules.push({ label: 'from_web', desc: 'All TCP from the web tier', proto: TCP, nsg: nsg('web') });
  if (tier === 'db') {
    for (const port of DB_PORTS) {
      if (has('app')) rules.push({ label: `from_app_${port}`, desc: `TCP ${port} from the app tier`, proto: TCP, from: port, to: port, nsg: nsg('app') });
      if (has('mgmt')) rules.push({ label: `from_mgmt_${port}`, desc: `TCP ${port} from the mgmt tier`, proto: TCP, from: port, to: port, nsg: nsg('mgmt') });
    }
    // Cluster traffic between database hosts: AG endpoints, RAC interconnect, replication.
    rules.push({ label: 'self', desc: 'Everything between database hosts', proto: 'all', nsg: nsg('db') });
  }
  if (tier !== 'mgmt' && has('mgmt')) {
    for (const port of [22, 3389, 5986]) rules.push({ label: `from_mgmt_admin_${port}`, desc: `TCP ${port} from the mgmt tier`, proto: TCP, from: port, to: port, nsg: nsg('mgmt') });
  }
  if (tier === 'mgmt') {
    // Domain controllers live here (extend-dcs): the directory ports from the network and from on-premises DCs.
    const sources                                  = [{ c: n.cidr }, ...(n.ipv6 ? [{ expr: vcn6 }] : []), ...sites.map((c) => ({ c }))];
    sources.forEach((s, si) => {
      for (const [proto, from, to] of AD_PORTS) {
        rules.push({ label: `ad_${PROTO_NAME[proto]?.toLowerCase()}_${from}_${si}`, desc: `AD ${PROTO_NAME[proto]} ${from === to ? from : `${from}-${to}`}`, proto, from, to, ...(s.c ? { cidr: s.c } : { cidrExpr: s.expr }) });
      }
    });
  }
  // ICMP from the network and on-premises: path MTU discovery needs it, IPv6 most of all.
  rules.push({ label: 'icmp', desc: 'ICMP from inside the VCN', proto: ICMP, cidr: n.cidr });
  if (n.ipv6) rules.push({ label: 'icmpv6', desc: 'ICMPv6 from inside the VCN', proto: ICMPV6, cidrExpr: vcn6 });
  sites.forEach((c, i) => rules.push({ label: `site_icmp_${i}`, desc: `ICMP from ${c}`, proto: familyOf(c) === 6 ? ICMPV6 : ICMP, cidr: c }));
  rules.push({ label: 'egress_all', desc: 'All outbound', proto: 'all', cidr: '0.0.0.0/0', egress: true });
  if (n.ipv6) rules.push({ label: 'egress_all_v6', desc: 'All outbound, IPv6', proto: 'all', cidr: '::/0', egress: true });
  return rules;
}

/** The NSG rules of one network, as entries of `local.mig_nsg_rules`: one line each. */
function nsgRuleEntries(n             , sites                   , bastionCidr               )                         {
  const out                         = {};
  const lit = (v                                    ) => (v === null || v === undefined ? 'null' : typeof v === 'number' ? String(v) : q(v));
  for (const tier of n.tiers) {
    for (const r of tierRules(n, tier, sites, bastionCidr)) {
      const peer = r.nsg ?? r.cidrExpr ?? lit(r.cidr);
      const peerType = q(r.nsg ? 'NETWORK_SECURITY_GROUP' : 'CIDR_BLOCK');
      const fields = [
        `nsg = oci_core_network_security_group.${n.id}_${tier}.id`,
        `direction = ${q(r.egress ? 'EGRESS' : 'INGRESS')}`,
        `protocol = ${q(r.proto)}`,
        `source = ${r.egress ? 'null' : peer}`,
        `source_type = ${r.egress ? 'null' : peerType}`,
        `destination = ${r.egress ? peer : 'null'}`,
        `destination_type = ${r.egress ? peerType : 'null'}`,
        `min = ${lit(r.from)}`,
        `max = ${lit(r.to)}`,
        `description = ${q(r.desc)}`,
      ];
      out[`${n.name}/${tier}/${r.label}`] = `{ ${fields.join(', ')} }`;
    }
  }
  return out;
}

function ociLandingZone()            {
  return {
    id: 'oci_mig_landing_zone',
    label: 'Landing zone (migration)',
    group: MIGRATION_GROUP,
    description: `A compartment with dual-stack VCNs from the networks grid (built on the network foundation), a network security group per tier, NAT and service gateways, a DRG with the routes to on-premises, a vault and key, flow logs and the Bastion service. ${landingZoneNote}`,
    inputs: landingZoneInputs('oci', OCI_REGIONS, REGION),
    emits: [
      'oci_identity_compartment', 'oci_identity_policy', 'oci_core_vcn', 'oci_core_subnet', 'oci_core_security_list',
      'oci_core_network_security_group', 'oci_core_network_security_group_security_rule',
      'oci_core_nat_gateway', 'oci_core_service_gateway', 'oci_core_internet_gateway', 'oci_core_default_route_table',
      'oci_core_drg', 'oci_core_drg_attachment', 'oci_kms_vault', 'oci_kms_key',
      'oci_logging_log_group', 'oci_logging_log', 'oci_bastion_bastion',
    ],
    build: (values                 ) => {
      const findings            = [];
      const lz = parseLandingZone(values, REGION, findings);
      if (findings.some((f) => f.severity === 'error')) return failed('oci_mig_landing_zone', findings);
      const cmk = lz.keys !== 'provider-managed';
      const parent = lz.scope ? q(lz.scope) : 'var.parent_compartment_ocid';
      const comp = 'oci_identity_compartment.landing_zone.id';
      const drg = 'oci_core_drg.landing_zone.id';
      const blocks                        = [
        TF(),
        { type: 'provider', labels: ['oci'], attributes: attrs({ region: lz.region }) },
        ...(lz.scope ? [] : [variable('parent_compartment_ocid', 'string', 'The compartment (or the tenancy) the landing-zone compartment is created in.')]),
        res('oci_identity_compartment', 'landing_zone', {
          compartment_id: x(parent),
          name: lz.prefix,
          description: `The ${lz.prefix} landing zone`,
          // Deleting the compartment with the stack would take whatever else was put in it.
          enable_delete: false,
        }),
        dat('oci_identity_availability_domains', 'landing_zone', { compartment_id: x(parent) }),
        dat('oci_core_services', 'all', {}, [blk('filter', { name: 'name', values: ['All .* Services In Oracle Services Network'], regex: true })], 'The service gateway reaches every service in the Oracle Services Network.'),
        res('oci_core_drg', 'landing_zone', { compartment_id: x(comp), display_name: rname(lz.prefix, 'drg') }, [], 'The DRG the VPN and FastConnect attach to: here, so the VCN route tables can send on-premises ranges to it.'),
      ];

      // The Bastion service sits in the mgmt subnet of the first network; every tier admits it.
      const first = lz.networks[0];
      const bastionTier = first ? (first.tiers.includes('mgmt') ? 'mgmt' : first.tiers[0]) : undefined;
      let bastionCidr                = null;

      const subnetsByNet = new Map                      ();
      const nsgRules                         = {};
      for (const n of lz.networks) {
        const subnets = carveNetwork(n, lz.prefixLen, false, [], findings);
        if (subnets.length === 0) continue;
        subnetsByNet.set(n.id, subnets);
        if (n === first && lz.bastion === 'cloud-native') bastionCidr = subnets.find((s) => s.tier === bastionTier)?.cidr ?? null;
        const out = emitFoundation('oci', {
          name: rname(lz.prefix, n.name),
          cidr: n.cidr,
          ipv6: n.ipv6,
          subnets: subnets.map((s) => ({ name: s.short, cidr: s.cidr })),
          compartmentId: 'placeholder',
        });
        findings.push(...out.findings.filter((f) => f.severity !== 'info'));
        blocks.push(
          reworkFoundation(out.files['main.tf'] ?? '', n.id, {
            edit: (type, _label, text) => {
              // The compartment the landing zone creates, not the emitter's variable.
              let t = text.replace(/var\.oci_compartment_ocid/g, comp);
              // A DNS label per subnet: database systems need hostnames in the subnet.
              if (type === 'oci_core_subnet') {
                const s = subnets.find((sub) => t.includes(`"oci_core_subnet" "${sub.label}"`));
                const pad = /^ {2}(\w+\s*)= /m.exec(t)?.[1]?.length ?? 10;
                if (s) t = insertBeforeClose(t, `  ${'dns_label'.padEnd(pad)}= ${q(alnum(String(s.tier), 15).toLowerCase())}`);
              }
              return t;
            },
          }),
        );

        const vcn = `oci_core_vcn.${n.id}.id`;
        blocks.push(
          res('oci_core_nat_gateway', n.id, { compartment_id: x(comp), vcn_id: x(vcn), display_name: rname(lz.prefix, n.name, 'nat'), block_traffic: false }),
          res('oci_core_service_gateway', n.id, { compartment_id: x(comp), vcn_id: x(vcn), display_name: rname(lz.prefix, n.name, 'sgw') }, [
            blk('services', { service_id: x('data.oci_core_services.all.services[0].id') }),
          ]),
          res('oci_core_drg_attachment', n.id, { drg_id: x(drg), vcn_id: x(vcn), display_name: rname(lz.prefix, n.name, 'drg') }),
        );
        if (n.ipv6) {
          blocks.push(
            res('oci_core_internet_gateway', `${n.id}_v6`, { compartment_id: x(comp), vcn_id: x(vcn), display_name: rname(lz.prefix, n.name, 'igw-v6'), enabled: true }, [],
              'IPv6 out: the NAT gateway is IPv4 only. The subnets prohibit internet ingress, so nothing comes in this way.'),
          );
        }
        const routes             = [
          blk('route_rules', { network_entity_id: x(`oci_core_nat_gateway.${n.id}.id`), destination: '0.0.0.0/0', destination_type: 'CIDR_BLOCK', description: 'IPv4 out through the NAT gateway' }),
          blk('route_rules', { network_entity_id: x(`oci_core_service_gateway.${n.id}.id`), destination: x('data.oci_core_services.all.services[0].cidr_block'), destination_type: 'SERVICE_CIDR_BLOCK', description: 'Oracle services through the service gateway' }),
          ...(n.ipv6 ? [blk('route_rules', { network_entity_id: x(`oci_core_internet_gateway.${n.id}_v6.id`), destination: '::/0', destination_type: 'CIDR_BLOCK', description: 'IPv6 out' })] : []),
          ...siteSources(lz, n).map((c) => blk('route_rules', { network_entity_id: x(drg), destination: c, destination_type: 'CIDR_BLOCK', description: `On-premises ${c} through the DRG` })),
        ];
        blocks.push(
          res('oci_core_default_route_table', n.id, {
            manage_default_resource_id: x(`oci_core_vcn.${n.id}.default_route_table_id`),
            compartment_id: x(comp),
            display_name: rname(lz.prefix, n.name, 'private'),
            depends_on: x(`[oci_core_drg_attachment.${n.id}]`),
          }, routes, 'The private subnets use the VCN\'s default route table: out through NAT, to Oracle services, and to on-premises through the DRG.'),
        );
        for (const tier of n.tiers) {
          blocks.push(res('oci_core_network_security_group', `${n.id}_${tier}`, { compartment_id: x(comp), vcn_id: x(vcn), display_name: rname(lz.prefix, n.name, tier), freeform_tags: x(hcl({ atk_tier: tier, atk_network: n.name })) }));
        }
        Object.assign(nsgRules, nsgRuleEntries(n, siteSources(lz, n), n === first ? bastionCidr : null));
      }
      if (findings.some((f) => f.severity === 'error')) return failed('oci_mig_landing_zone', findings);

      blocks.push(
        { type: 'locals', comment: 'Every NSG rule of every tier, by network/tier/rule.', attributes: [{ name: 'mig_nsg_rules', value: x(hobj(nsgRules, 1)) }] },
        res('oci_core_network_security_group_security_rule', 'landing_zone', {
          for_each: x('local.mig_nsg_rules'),
          network_security_group_id: x('each.value.nsg'),
          direction: x('each.value.direction'),
          protocol: x('each.value.protocol'),
          source: x('each.value.source'),
          source_type: x('each.value.source_type'),
          destination: x('each.value.destination'),
          destination_type: x('each.value.destination_type'),
          stateless: false,
          description: x('each.value.description'),
        }, [
          {
            type: 'dynamic',
            labels: ['tcp_options'],
            attributes: attrs({ for_each: x(`each.value.protocol == "${TCP}" && each.value.min != null ? [each.value] : []`) }),
            blocks: [blk('content', {}, [blk('destination_port_range', { min: x('tcp_options.value.min'), max: x('tcp_options.value.max') })])],
          },
          {
            type: 'dynamic',
            labels: ['udp_options'],
            attributes: attrs({ for_each: x(`each.value.protocol == "${UDP}" && each.value.min != null ? [each.value] : []`) }),
            blocks: [blk('content', {}, [blk('destination_port_range', { min: x('udp_options.value.min'), max: x('udp_options.value.max') })])],
          },
        ]),
      );

      // The vault: keys when customer-managed, and in every case the secrets the databases read.
      blocks.push(
        res('oci_kms_vault', 'landing_zone', { compartment_id: x(comp), display_name: rname(lz.prefix, 'vault'), vault_type: lz.keys === 'hsm' ? 'VIRTUAL_PRIVATE' : 'DEFAULT' }),
      );
      if (cmk) {
        blocks.push(
          res('oci_kms_key', 'landing_zone', {
            compartment_id: x(comp),
            display_name: rname(lz.prefix, 'key'),
            management_endpoint: x('oci_kms_vault.landing_zone.management_endpoint'),
            protection_mode: lz.keys === 'hsm' ? 'HSM' : 'SOFTWARE',
          }, [blk('key_shape', { algorithm: 'AES', length: 32 })]),
          res('oci_identity_policy', 'landing_zone_keys', {
            compartment_id: x(parent),
            name: `${lz.prefix}-landing-zone-keys`,
            description: `Block Volume and Object Storage may use the ${lz.prefix} landing-zone key.`,
            statements: x(hcl([
              e(`"Allow service blockstorage, objectstorage-${lz.region} to use keys in compartment id \${${comp}} where target.key.id = '\${oci_kms_key.landing_zone.id}'"`),
            ], 1)),
          }),
        );
        findings.push(info('tf.mig.oci-key-rotation', 'Rotate the landing-zone key on a schedule (a new key version); volumes keep working through a rotation.', { path: 'keys' }));
      }

      // Flow logs, one per subnet, into the landing zone's log group.
      const retention = logRetention(lz.retention);
      if (retention < lz.retention) {
        findings.push(info('tf.mig.oci-log-retention', `OCI Logging keeps logs for at most 180 days, so ${lz.retention} became ${retention}. For longer, archive the log group to Object Storage with a Service Connector.`, { path: 'log_retention_days' }));
      }
      blocks.push(res('oci_logging_log_group', 'landing_zone', { compartment_id: x(comp), display_name: rname(lz.prefix, 'logs'), description: `Flow logs and agent logs of the ${lz.prefix} landing zone` }));
      for (const n of lz.networks) {
        for (const s of subnetsByNet.get(n.id) ?? []) {
          blocks.push(
            res('oci_logging_log', `${s.label}_flow`, {
              display_name: rname(lz.prefix, n.name, String(s.tier), 'flow'),
              log_group_id: x('oci_logging_log_group.landing_zone.id'),
              log_type: 'SERVICE',
              is_enabled: true,
              retention_duration: retention,
            }, [blk('configuration', { compartment_id: x(comp) }, [blk('source', { category: 'all', resource: x(`oci_core_subnet.${s.label}.id`), service: 'flowlogs', source_type: 'OCISERVICE' })])]),
          );
        }
      }

      if (lz.bastion === 'cloud-native' && first && bastionTier) {
        blocks.push(
          res('oci_bastion_bastion', 'landing_zone', {
            bastion_type: 'STANDARD',
            compartment_id: x(comp),
            target_subnet_id: x(`oci_core_subnet.${ident(first.id, bastionTier)}.id`),
            name: alnum(`${lz.prefix}bastion`, 32),
            client_cidr_block_allow_list: lz.siteV4.length > 0 ? [...lz.siteV4] : [first.cidr],
            max_session_ttl_in_seconds: 10800,
          }),
        );
        if (lz.siteV4.length === 0) findings.push(warning('tf.mig.oci-bastion-clients', 'No IPv4 on-premises range was given, so the Bastion service admits only the first network\'s own range.', { path: 'site_cidrs' }));
      }

      // The contract.
      const subnetIds                         = {};
      const nsgIds                         = {};
      const mgmt           = lz.siteV4.map(q);
      if (lz.anyV6) mgmt.push(...lz.siteV6.map(q));
      for (const n of lz.networks) {
        for (const s of subnetsByNet.get(n.id) ?? []) {
          for (const z of ZONE_LETTERS.slice(0, n.zones)) subnetIds[`${n.name}/${s.tier}/${z}`] = `oci_core_subnet.${s.label}.id`;
          if (s.tier === 'mgmt') {
            mgmt.push(q(s.cidr));
            if (n.ipv6) mgmt.push(`oci_core_subnet.${s.label}.ipv6cidr_blocks[0]`);
          }
        }
        for (const t of n.tiers) nsgIds[`${n.name}/${t}`] = `oci_core_network_security_group.${n.id}_${t}.id`;
      }
      const byNet = (f                            ) => hcl(Object.fromEntries(lz.networks.map((n) => [n.name, e(f(n))])), 2);
      blocks.push(
        landingZoneLocal('oci', {
          prefix: q(lz.prefix),
          region: q(lz.region),
          network_ids: byNet((n) => `oci_core_vcn.${n.id}.id`),
          subnet_ids: hcl(Object.fromEntries(Object.entries(subnetIds).map(([k, v]) => [k, e(v)])), 2),
          security_group_ids: hcl(Object.fromEntries(Object.entries(nsgIds).map(([k, v]) => [k, e(v)])), 2),
          // Through the policy, so nothing encrypts with the key before Block Volume may use it.
          kms_key_id: cmk ? 'oci_identity_policy.landing_zone_keys.id == null ? null : oci_kms_key.landing_zone.id' : 'null',
          log_destination: 'oci_logging_log_group.landing_zone.id',
          resource_group: 'null',
          // Every availability domain: some regions have one, and element() wraps a zone index round them.
          zones: '[for ad in data.oci_identity_availability_domains.landing_zone.availability_domains : ad.name]',
          mgmt_cidrs: `[${mgmt.join(', ')}]`,
          ipv6: byNet((n) => String(n.ipv6)),
          compartment_id: comp,
          drg_id: drg,
          vault_id: 'oci_kms_vault.landing_zone.id',
        }),
        output('landing_zone', 'local.landing_zone', 'The landing-zone contract: the value of the landing_zone variable of a blueprint used on its own.'),
        ...['network_ids', 'subnet_ids', 'security_group_ids', 'kms_key_id', 'log_destination', 'zones', 'compartment_id', 'drg_id', 'vault_id'].map((k) => output(k, `local.landing_zone.${k}`)),
      );
      if (lz.bastion === 'cloud-native') {
        findings.push(info('tf.mig.oci-bastion', 'Administrative access is the OCI Bastion service: managed SSH and port-forwarding sessions, no bastion host and no inbound port from the internet.', { path: 'bastion' }));
      }
      if (!lz.scope) findings.push(info('tf.mig.oci-parent', 'The parent compartment is a variable (parent_compartment_ocid); the tenancy OCID works too.', { path: 'scope' }));
      findings.push(info('tf.mig.oci-drg-here', 'The DRG is created by the landing zone, not by connectivity: OCI keeps route rules inside the route table, so the routes to on-premises are written here and connectivity attaches the VPN and FastConnect to this DRG.', { path: 'networks' }));
      return { files: { 'main.tf': mainTf(blocks, `OCI landing zone: ${lz.prefix} in ${lz.region}`) }, findings };
    },
  };
}


// ---------------------------------------------------------------------------
// Connectivity
// ---------------------------------------------------------------------------

/** Link-local /30 inside addresses: Oracle takes .1, the customer .2. */
const insideV4 = (site        , tunnel        , base        ) => {
  const at = tunnel * 4;
  return { oracle: `169.254.${base + site}.${at + 1}/30`, customer: `169.254.${base + site}.${at + 2}/30` };
};

function ociConnectivity()            {
  return {
    id: 'oci_mig_connectivity',
    label: 'Connectivity (migration)',
    group: MIGRATION_GROUP,
    description: 'Site-to-Site VPN (two IKEv2 tunnels with BGP) and FastConnect private virtual circuits, on the DRG the landing zone created and routes to.',
    inputs: [
      gridInput('sites', 'Sites', SITE_COLUMNS, DEFAULT_SITES, 'One row per on-premises site. Method: vpn, circuit (FastConnect), or circuit with a VPN backup. The circuit column is the FastConnect partner\'s service key, when it has issued one.'),
      { id: 'cloud_asn', label: 'Oracle side ASN', control: 'number', default: 31898, min: 1, max: 4294967295, hint: 'Oracle\'s side is fixed at 31898 in commercial regions; for your records.' },
      LANDING_ZONE_SOURCE,
    ],
    emits: ['oci_core_cpe', 'oci_core_ipsec', 'oci_core_ipsec_connection_tunnel_management', 'oci_core_virtual_circuit'],
    build: (values                 ) => {
      const findings            = [];
      const lz = lzRef(values);
      const sites = parseSites(valueOf(values, 'sites'), findings);
      const asn = numberOf(values, 'cloud_asn', 31898);
      if (asn !== 31898) findings.push(info('tf.mig.oci-asn', `OCI's BGP ASN is 31898 in commercial regions and cannot be chosen; ${asn} was not used.`, { path: 'cloud_asn' }));
      const blocks             = [TF(), ...consumerPreamble('oci', values)];
      const vpnSites = sites.filter((s) => s.vpn);
      vpnSites.forEach((s, si) => {
        const v4 = s.cidrs.filter((c) => familyOf(c) === 4);
        if (familyOf(s.peer) === 6) findings.push(warning('tf.mig.oci-cpe-ipv6', `Site ${s.name}: OCI Site-to-Site VPN needs an IPv4 peer address; "${s.peer}" will be refused.`, { path: 'sites' }));
        if (s.cidrs.some((c) => familyOf(c) === 6)) {
          findings.push(info('tf.mig.oci-vpn-ipv6', `Site ${s.name}: IPv6 ranges reach OCI over BGP on the IPv4 tunnels once the peer advertises them; the routes to them are in the landing zone's route tables.`, { path: 'sites' }));
        }
        blocks.push(
          res('oci_core_cpe', s.id, { compartment_id: x(`${lz}.compartment_id`), ip_address: s.peer, display_name: s.name }),
          res('oci_core_ipsec', s.id, {
            compartment_id: x(`${lz}.compartment_id`),
            cpe_id: x(`oci_core_cpe.${s.id}.id`),
            drg_id: x(`${lz}.drg_id`),
            display_name: s.name,
            // Required even with BGP, which the tunnels then use instead.
            static_routes: v4.length > 0 ? v4 : ['0.0.0.0/0'],
          }),
          dat('oci_core_ipsec_connection_tunnels', s.id, { ipsec_id: x(`oci_core_ipsec.${s.id}.id`) }),
        );
        for (const n of [1, 2]) {
          const psk = `vpn_psk_${s.id}_${n}`;
          const inside = insideV4(si, n - 1, 10);
          blocks.push(
            secretVariable(psk, `Pre-shared key for tunnel ${n} to ${s.name}.`),
            res('oci_core_ipsec_connection_tunnel_management', `${s.id}_${n}`, {
              ipsec_id: x(`oci_core_ipsec.${s.id}.id`),
              tunnel_id: x(`data.oci_core_ipsec_connection_tunnels.${s.id}.ip_sec_connection_tunnels[${n - 1}].id`),
              display_name: `${s.name}-${n}`,
              routing: 'BGP',
              ike_version: 'V2',
              shared_secret: x(`var.${psk}`),
            }, [blk('bgp_session_info', { customer_bgp_asn: String(s.asn), customer_interface_ip: inside.customer, oracle_interface_ip: inside.oracle })]),
          );
        }
        if (v4.length === 0) findings.push(info('tf.mig.oci-static-routes', `Site ${s.name}: no IPv4 range was given; the IPsec connection's required static route is 0.0.0.0/0, unused with BGP.`, { path: 'sites' }));
      });

      const circuits = sites.filter((s) => s.usesCircuit);
      circuits.forEach((s, si) => {
        const providerVar = `fastconnect_provider_service_id_${s.id}`;
        const inside = insideV4(si, 0, 200);
        const v6 = s.cidrs.some((c) => familyOf(c) === 6);
        blocks.push(
          variable(providerVar, 'string', `The OCID of the FastConnect provider service (partner or colocation) for ${s.name}: list them with the oci_core_fast_connect_provider_services data source.`),
          res('oci_core_virtual_circuit', s.id, {
            compartment_id: x(`${lz}.compartment_id`),
            type: 'PRIVATE',
            display_name: s.name,
            gateway_id: x(`${lz}.drg_id`),
            bandwidth_shape_name: '1 Gbps',
            provider_service_id: x(`var.${providerVar}`),
            provider_service_key_name: s.circuit || undefined,
            customer_asn: String(s.asn),
            routing_policy: ['ORACLE_SERVICE_NETWORK', 'REGIONAL'],
          }, [
            blk('cross_connect_mappings', {
              customer_bgp_peering_ip: inside.customer,
              oracle_bgp_peering_ip: inside.oracle,
              // IPv6 BGP on the same circuit, from a ULA /126 per site.
              customer_bgp_peering_ipv6: v6 ? `fd00:a9fe:${(200 + si).toString(16)}::2/126` : undefined,
              oracle_bgp_peering_ipv6: v6 ? `fd00:a9fe:${(200 + si).toString(16)}::1/126` : undefined,
            }),
          ]),
        );
      });
      if (sites.length === 0) findings.push(warning('tf.mig.no-sites', 'The sites grid is empty, so nothing was built.', { path: 'sites' }));
      if (vpnSites.length > 0) {
        blocks.push(output('vpn_tunnels', `{\n    ${vpnSites.map((s) => `${s.id} = [for t in data.oci_core_ipsec_connection_tunnels.${s.id}.ip_sec_connection_tunnels : t.vpn_ip]`).join('\n    ')}\n  }`, 'The Oracle tunnel endpoints to configure on each on-premises peer.'));
      }
      if (circuits.length > 0) {
        blocks.push(output('virtual_circuits', `{\n    ${circuits.map((s) => `${s.id} = oci_core_virtual_circuit.${s.id}.id`).join('\n    ')}\n  }`, 'The FastConnect virtual circuits: give their OCIDs to the partner.'));
      }
      return { files: { 'main.tf': mainTf(blocks, `OCI connectivity: ${sites.length} site(s) on the landing zone's DRG`) }, findings };
    },
  };
}

// ---------------------------------------------------------------------------
// Compute
// ---------------------------------------------------------------------------

/**
 * The Size cell: `shape[:ocpus[:memory GB]]`, e.g. `VM.Standard.E5.Flex:4:64`.
 * A flexible shape without them takes the Cores column (OCPUs), else 1 OCPU,
 * and 16 GB per OCPU. A fixed shape takes neither.
 */
export function parseShape(cell        , cores                    , fallback = 'VM.Standard.E5.Flex')                                                                  {
  const [shape = '', o = '', m = ''] = cell.trim().split(':');
  const name = shape || fallback;
  const flex = /\.Flex$/i.test(name);
  const ocpusCell = Number(o);
  const ocpus = cores ?? (Number.isFinite(ocpusCell) && ocpusCell > 0 ? ocpusCell : 1);
  const memCell = Number(m);
  const memory = Number.isFinite(memCell) && memCell > 0 ? memCell : ocpus * 16;
  return { shape: name, flex, ocpus, memory };
}

/** Block Volume performance, in VPUs per GB: balanced 10, higher 20, ultra 30 and up. */
function vpusOf(type        )         {
  const t = type.toLowerCase();
  if (/^\d+$/.test(t)) return Number(t);
  if (t === 'lower') return 0;
  if (t === 'higher' || t === 'high') return 20;
  if (t.startsWith('ultra')) return 30;
  return 10;
}

const SHAPES = [
  'VM.Standard.E5.Flex', 'VM.Standard.E5.Flex:1:16', 'VM.Standard.E5.Flex:2:16', 'VM.Standard.E5.Flex:2:32', 'VM.Standard.E5.Flex:4:64', 'VM.Standard.E5.Flex:8:128',
  'VM.Standard.E4.Flex', 'VM.Standard.E4.Flex:2:32', 'VM.Standard.E4.Flex:4:64',
  'VM.Standard3.Flex', 'VM.Standard3.Flex:2:32', 'VM.Standard3.Flex:4:64',
];

const DEFAULT_VMS                                 = [
  ['web01', 'win-2022', 'oci:Windows:Server 2022 Standard', 'VM.Standard.E5.Flex:2:32', '', 'balanced:256', 'prod', 'web', 'a', 'li', 'silver', 'rebuild', 'shop', 'web', 'prod', '1'],
  ['app01', 'ol-9', 'oci:Oracle Linux:9', 'VM.Standard.E5.Flex:2:32', '', 'balanced:50 balanced:200', 'prod', 'app', 'b', 'li', 'gold', 'rebuild', 'shop', 'app', 'prod', '1'],
  ['db01', 'ol-8', 'replicated', 'VM.Standard.E5.Flex:4:64', '4', 'balanced:100 higher:500', 'prod', 'db', 'a', 'byol-image', 'gold', 'replicate', 'shop', 'oracle', 'prod', '2'],
];

const PLUGINS = ['Management Agent', 'OS Management Hub Agent', 'Vulnerability Scanning', 'Custom Logs Monitoring', 'Compute Instance Monitoring', 'Bastion'];

function ociImageData(vms                   , lz        )                                                       {
  const blocks             = [];
  const exprFor = new Map                ();
  let n = 0;
  for (const vm of vms) {
    if (vm.method === 'replicate') continue;
    const key = imageKeyOf(vm);
    if (exprFor.has(key)) continue;
    const img = imageOf(vm);
    if (img.kind === 'oci-platform') {
      n += 1;
      const label = `image_${n}`;
      blocks.push(
        dat('oci_core_images', label, {
          compartment_id: x(`${lz}.compartment_id`),
          operating_system: img.operatingSystem,
          operating_system_version: img.version,
          shape: parseShape(vm.size, vm.cores).shape,
          state: 'AVAILABLE',
          sort_by: 'TIMECREATED',
          sort_order: 'DESC',
        }, [], vm.imageKey),
      );
      exprFor.set(key, `data.oci_core_images.${label}.images[0].id`);
    } else if (img.kind === 'custom') {
      blocks.push(variable(img.variable, 'string', `The image OCID for ${vm.name} (${vm.os}).`));
      exprFor.set(key, `var.${img.variable}`);
    }
  }
  return { blocks, exprFor };
}

/** A rebuild row's image: an OCI platform image, or a variable (a BYOL Windows image, or a key this does not read). */
function imageOf(vm        )                                                                                                            {
  const img = vm.image;
  if (img?.kind === 'oci-platform' && !(vm.kind === 'windows' && vm.licence === 'byol-image')) return img;
  if (img?.kind === 'custom') return img;
  return { kind: 'custom', variable: `image_${ident(vm.name)}` };
}

const imageKeyOf = (vm        ) => {
  const img = imageOf(vm);
  return img.kind === 'custom' ? `var:${img.variable}` : `${vm.imageKey}@${parseShape(vm.size, vm.cores).shape}`;
};

function ociCompute()            {
  return {
    id: 'oci_mig_compute',
    label: 'Compute (migration)',
    group: MIGRATION_GROUP,
    description: 'An instance per rebuild row (flexible shapes with exact OCPUs, encrypted boot and block volumes, in-transit encryption, the monitoring, OS Management Hub, scanning and Bastion plugins, bootstrap without secrets), and the replicated rows adopted after cutover with import blocks. Writes local.mig_vms.',
    inputs: [
      gridInput('vms', 'VMs', vmColumns(SHAPES, ['balanced', 'higher']), DEFAULT_VMS, 'One row per VM. Size: shape, or shape:OCPUs:memory GB for a flexible shape (VM.Standard.E5.Flex:4:64); Cores, when set, is the OCPU count. Disks: balanced:GiB or higher:GiB, the first is the boot volume. Method replicate: the replication tool builds it; list it in cutover_instance_ids after cutover to adopt it.'),
      { id: 'ssh_public_key_var', label: 'SSH key variable', control: 'text', default: 'ssh_public_key', hint: 'The variable holding the ansible user\'s public key.' },
      LANDING_ZONE_SOURCE,
    ],
    emits: ['oci_core_instance', 'oci_core_volume', 'oci_core_volume_attachment'],
    build: (values                 ) => {
      const findings            = [];
      const lz = lzRef(values);
      const vms = parseVms(valueOf(values, 'vms'), 'balanced', findings);
      const sshVar = ident(valueOf(values, 'ssh_public_key_var', 'ssh_public_key'));
      const { blocks: imageBlocks, exprFor } = ociImageData(vms, lz);

      const entries                         = {};
      for (const vm of vms) {
        const s = parseShape(vm.size, vm.cores);
        const minBoot = vm.kind === 'windows' ? 256 : 50;
        if (vm.method === 'rebuild' && vm.boot.gib < minBoot) {
          findings.push(info('tf.mig.oci-boot-size', `${vm.name}: an OCI ${vm.kind} boot volume is at least ${minBoot} GB, so it was raised from ${vm.boot.gib}.`, { path: 'vms' }));
        }
        entries[vm.key] = vmLocalEntry(vm, {
          image: vm.method === 'rebuild' ? (exprFor.get(imageKeyOf(vm)) ?? 'null') : 'null',
          subnet: `${lz}.subnet_ids[${q(`${vm.network}/${vm.tier}/${vm.zone}`)}]`,
          security_group: `${lz}.security_group_ids[${q(`${vm.network}/${vm.tier}`)}]`,
          ipv6: `${lz}.ipv6[${q(vm.network)}]`,
          shape: q(s.shape),
          flex: String(s.flex),
          ocpus: String(s.ocpus),
          memory: String(s.memory),
          boot_gib: String(Math.max(minBoot, vm.boot.gib)),
          boot_vpus: String(vpusOf(vm.boot.type)),
        });
        if (vm.licence === 'ahb' || vm.licence === 'rhel-byos' || vm.licence === 'sles-byos' || vm.licence === 'dedicated-host') {
          findings.push(info('tf.mig.oci-licence', `${vm.name}: "${vm.licence}" has no OCI equivalent here; the platform image is licence-included.`, { path: 'vms' }));
        }
        if (vm.kind === 'windows' && vm.licence === 'byol-image' && vm.method === 'rebuild') {
          findings.push(info('tf.mig.oci-windows-byol', `${vm.name}: Windows BYOL runs from your own imported image, so it is a variable (image_${ident(vm.name)}).`, { path: 'vms' }));
        }
        if (vm.method === 'replicate' && vm.data.length > 0) {
          findings.push(info('tf.mig.replicated-disks', `${vm.name}: its data disks come with the replication and are not created here.`, { path: 'vms' }));
        }
      }
      const disks                          = {};
      for (const vm of vms.filter((v) => v.method === 'rebuild')) {
        vm.data.forEach((d, i) => {
          disks[`${vm.key}/${i + 1}`] = { vm: vm.key, gib: Math.max(50, d.gib), vpus: vpusOf(d.type) };
        });
      }
      const blocks                        = [
        TF(),
        ...consumerPreamble('oci', values),
        sshKeyVariable(sshVar),
        cutoverVariable('the instance OCID it was launched as'),
        ...imageBlocks,
        {
          type: 'locals',
          comment: 'Every VM in the grid, by name: the compute contract (local.mig_vms) the backup and monitoring blueprints read.',
          attributes: [
            { name: 'mig_vms', value: x(hcl(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, e(v)])), 1)) },
            { name: 'mig_rebuild', value: x('{ for k, v in local.mig_vms : k => v if v.method == "rebuild" }') },
            { name: 'mig_replicated', value: x('{ for k, v in local.mig_vms : k => v if v.method == "replicate" }') },
            { name: 'mig_data_disks', value: x(hcl(disks, 1)) },
            { name: 'mig_bootstrap_linux', value: x(cloudInit(`var.${sshVar}`)) },
            { name: 'mig_bootstrap_windows', value: x(winrmBootstrap(`${lz}.mgmt_cidrs`, 'ps1-sysnative')) },
            { name: 'mig_vm_ids', value: x('merge({ for k, v in oci_core_instance.vm : k => v.id }, { for k, v in oci_core_instance.replicated : k => v.id })') },
            {
              name: 'mig_vm_volumes',
              value: x('merge(\n    { for k, v in oci_core_instance.vm : k => concat([v.boot_volume_id], [for dk, d in local.mig_data_disks : oci_core_volume.data[dk].id if d.vm == k]) },\n    { for k, v in oci_core_instance.replicated : k => [v.boot_volume_id] },\n  )'),
            },
          ],
        },
      ];
      blocks.push(
        res('oci_core_instance', 'vm', {
          for_each: x('local.mig_rebuild'),
          availability_domain: x(`element(${lz}.zones, each.value.zone_index)`),
          compartment_id: x(`${lz}.compartment_id`),
          display_name: x('each.key'),
          shape: x('each.value.shape'),
          is_pv_encryption_in_transit_enabled: true,
          metadata: x(`{
    ssh_authorized_keys = var.${sshVar}
    user_data           = base64encode(each.value.kind == "windows" ? ${withHost('local.mig_bootstrap_windows', 'substr(each.key, 0, 15)')} : ${withHost('local.mig_bootstrap_linux')})
  }`),
          freeform_tags: x('merge(each.value.tags, { Name = each.key })'),
        }, [
          {
            type: 'dynamic',
            labels: ['shape_config'],
            attributes: attrs({ for_each: x('each.value.flex ? [each.value] : []') }),
            blocks: [blk('content', { ocpus: x('shape_config.value.ocpus'), memory_in_gbs: x('shape_config.value.memory') })],
          },
          blk('create_vnic_details', {
            subnet_id: x('each.value.subnet'),
            nsg_ids: x('[each.value.security_group]'),
            assign_public_ip: 'false',
            assign_ipv6ip: x('each.value.ipv6'),
            display_name: x('each.key'),
          }),
          blk('source_details', {
            source_type: 'image',
            source_id: x('each.value.image'),
            boot_volume_size_in_gbs: x('each.value.boot_gib'),
            boot_volume_vpus_per_gb: x('each.value.boot_vpus'),
            kms_key_id: x(`${lz}.kms_key_id`),
          }),
          blk('instance_options', { are_legacy_imds_endpoints_disabled: true }),
          blk('agent_config', { is_management_disabled: false, is_monitoring_disabled: false }, PLUGINS.map((p) => blk('plugins_config', { desired_state: 'ENABLED', name: p }))),
          // A newer image or a changed bootstrap must not replace a running server.
          ignoreChanges(['source_details[0].source_id', 'metadata']),
        ]),
        res('oci_core_volume', 'data', {
          for_each: x('local.mig_data_disks'),
          availability_domain: x('oci_core_instance.vm[each.value.vm].availability_domain'),
          compartment_id: x(`${lz}.compartment_id`),
          display_name: x('each.key'),
          size_in_gbs: x('each.value.gib'),
          vpus_per_gb: x('each.value.vpus'),
          kms_key_id: x(`${lz}.kms_key_id`),
          freeform_tags: x('merge(local.mig_vms[each.value.vm].tags, { Name = each.key })'),
        }),
        res('oci_core_volume_attachment', 'data', {
          for_each: x('local.mig_data_disks'),
          attachment_type: 'paravirtualized',
          instance_id: x('oci_core_instance.vm[each.value.vm].id'),
          volume_id: x('oci_core_volume.data[each.key].id'),
          is_pv_encryption_in_transit_enabled: true,
          display_name: x('each.key'),
        }),
        // Adopting what the replication tool launched: the empty map adopts nothing and applies cleanly.
        dat('oci_core_instance', 'replicated', { for_each: x('var.cutover_instance_ids'), instance_id: x('each.value') }),
        { type: 'import', comment: 'Replicated VMs, adopted after cutover (Terraform 1.7 or later).', attributes: attrs({ for_each: x('var.cutover_instance_ids'), to: x('oci_core_instance.replicated[each.key]'), id: x('each.value') }) },
        res('oci_core_instance', 'replicated', {
          for_each: x('var.cutover_instance_ids'),
          availability_domain: x('data.oci_core_instance.replicated[each.key].availability_domain'),
          compartment_id: x('data.oci_core_instance.replicated[each.key].compartment_id'),
          shape: x('data.oci_core_instance.replicated[each.key].shape'),
          display_name: x('each.key'),
          freeform_tags: x('merge(try(local.mig_replicated[each.key].tags, {}), { Name = each.key })'),
        }, [
          // What the replication tool decided stays as it made it.
          ignoreChanges([
            'source_details', 'create_vnic_details', 'metadata', 'extended_metadata', 'shape_config', 'agent_config', 'launch_options',
            'availability_config', 'instance_options', 'platform_config', 'fault_domain', 'is_pv_encryption_in_transit_enabled', 'defined_tags',
          ]),
        ]),
        output('vms', '{ for k, v in oci_core_instance.vm : k => { id = v.id, private_ip = v.private_ip, os = local.mig_vms[k].os } }', 'Each built VM: id and address, for the Ansible inventory.'),
        output('replicated', '{ for k, v in oci_core_instance.replicated : k => { id = v.id, private_ip = v.private_ip, os = try(local.mig_vms[k].os, null) } }', 'Each adopted VM.'),
      );
      return { files: { 'main.tf': mainTf(blocks, `OCI compute: ${vms.length} VM(s)`) }, findings };
    },
  };
}

// ---------------------------------------------------------------------------
// Databases
// ---------------------------------------------------------------------------

const OCI_DB_SERVICES = ['oci-adb', 'oci-basedb', 'oci-exacs', 'oci-mysql-heatwave', 'oci-pg', 'oci-compute'];
const OCI_DB_ENGINES = ['oracle', 'postgres', 'mysql'];
const OCI_DB_CLASSES = [
  'VM.Standard.E5.Flex:2', 'VM.Standard.E5.Flex:4', 'VM.Standard.E5.Flex:8', 'VM.Standard.E4.Flex:4',
  'Exadata.X11M:8', 'Exadata.X9M:8',
  'MySQL.2', 'MySQL.4', 'MySQL.8', 'MySQL.16',
  'PostgreSQL.VM.Standard.E5.Flex:2:32', 'PostgreSQL.VM.Standard.E5.Flex:4:64',
  '2', '4', '8', '16',
];

const DEFAULT_DBS                                 = [
  ['erp', 'oci-basedb', 'oracle', 'enterprise', '19', 'VM.Standard.E5.Flex:4', '512', 'standby', 'byol', '15', 'prod', 'erp'],
  ['crm', 'oci-adb', 'oracle', '', '26ai', '4', '1024', 'none', 'li', '30', 'prod', 'crm'],
  ['orders', 'oci-pg', 'postgres', '', '16', 'PostgreSQL.VM.Standard.E5.Flex:2:32', '200', 'regional', 'li', '7', 'prod', 'shop'],
  ['web', 'oci-mysql-heatwave', 'mysql', '', '', 'MySQL.4', '100', 'regional', 'li', '7', 'prod', 'shop'],
];

const LICENCE = (db        ) => (/byol|bring/.test(db.licence) ? 'BRING_YOUR_OWN_LICENSE' : 'LICENSE_INCLUDED');

/** Base Database / ExaCS edition from the Edition cell. */
function dbEdition(edition        )         {
  const e1 = edition.toLowerCase();
  if (/extreme|ee-ep|rac/.test(e1)) return 'ENTERPRISE_EDITION_EXTREME_PERFORMANCE';
  if (/high|ee-hp/.test(e1)) return 'ENTERPRISE_EDITION_HIGH_PERFORMANCE';
  if (/standard|^se2?$/.test(e1)) return 'STANDARD_EDITION';
  return 'ENTERPRISE_EDITION';
}

/** "19" → 19.0.0.0; 23, 23ai and 26ai → 23.0.0.0 (26ai is delivered as a 23 release update). */
function oracleVersion(v        )         {
  return /^(23|26)/.test(v.trim()) ? '23.0.0.0' : '19.0.0.0';
}

/** A number of CPUs from a Class cell: the `:n` after the shape, or the cell itself. */
function classCpus(cls        , fallback        )         {
  const parts = cls.split(':');
  const n = Number(parts.length > 1 ? parts[1] : parts[0]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const clamp = (n        , lo        , hi        ) => Math.min(hi, Math.max(lo, n));

function ociDatabases()            {
  return {
    id: 'oci_mig_databases',
    label: 'Databases (migration)',
    group: MIGRATION_GROUP,
    description: 'Autonomous Database, Base Database (Data Guard or RAC as the HA column asks), Exadata Database Service, MySQL HeatWave and PostgreSQL per row, on private endpoints in the db tier; admin passwords from OCI Vault secrets or sensitive variables, never written.',
    inputs: [
      gridInput('databases', 'Databases', dbColumns(OCI_DB_SERVICES, OCI_DB_ENGINES, OCI_DB_CLASSES, ['li', 'byol']), DEFAULT_DBS, 'One row per database. Class: the shape with :OCPUs (Base Database, Exadata), :OCPUs:GB (PostgreSQL), the MySQL shape, or the ECPU count (Autonomous). HA: standby is Data Guard (Autonomous: local Data Guard); any other value but none is two nodes (RAC, HA).'),
      LANDING_ZONE_SOURCE,
    ],
    emits: [
      'oci_database_autonomous_database', 'oci_database_db_system', 'oci_database_data_guard_association',
      'oci_database_cloud_exadata_infrastructure', 'oci_database_cloud_vm_cluster', 'oci_database_db_home', 'oci_database_database',
      'oci_mysql_mysql_db_system', 'oci_psql_db_system',
    ],
    build: (values                 ) => {
      const findings            = [];
      const lz = lzRef(values);
      const dbs = parseDbs(valueOf(values, 'databases'), findings);
      const blocks             = [TF(), ...consumerPreamble('oci', values)];
      const comp = x(`${lz}.compartment_id`);
      const ad = (i        ) => x(`element(${lz}.zones, ${i})`);
      const subnet = (db        , tier = 'db') => x(`${lz}.subnet_ids[${q(`${db.network}/${tier}/a`)}]`);
      const nsg = (db        ) => x(`[${lz}.security_group_ids[${q(`${db.network}/db`)}]]`);
      const tags = (db        ) => x(hcl({ atk_app: db.app, atk_db: db.engine || 'oracle', atk_backup_days: String(db.backupDays) }));
      const outs                         = {};
      let ssh = false;
      const secretOcid = (db        , what        ) => {
        const name = `${db.id}_admin_secret_ocid`;
        blocks.push(variable(name, 'string', `The OCID of the OCI Vault secret holding the ${what} password of ${db.name}. Create it in the landing zone's vault; the value is read by the service, never written here.`));
        return x(`var.${name}`);
      };
      for (const db of dbs) {
        const ha = db.ha !== 'none';
        if (db.service === 'oci-adb') {
          const version = /^(23|26)/.test(db.version) ? '26ai' : '19c';
          blocks.push(
            res('oci_database_autonomous_database', db.id, {
              compartment_id: comp,
              db_name: alnum(db.name, 14),
              display_name: x(`"\${${lz}.prefix}-${db.name}"`),
              compute_model: 'ECPU',
              compute_count: Math.max(2, classCpus(db.cls, 2)),
              data_storage_size_in_gb: Math.max(20, db.storage),
              db_workload: 'OLTP',
              db_version: version,
              license_model: LICENCE(db),
              database_edition: LICENCE(db) === 'BRING_YOUR_OWN_LICENSE' ? dbEdition(db.edition) === 'STANDARD_EDITION' ? 'STANDARD_EDITION' : 'ENTERPRISE_EDITION' : undefined,
              is_mtls_connection_required: true,
              subnet_id: subnet(db),
              nsg_ids: nsg(db),
              private_endpoint_label: alnum(db.name, 30).toLowerCase(),
              secret_id: secretOcid(db, 'ADMIN'),
              backup_retention_period_in_days: clamp(db.backupDays, 1, 60),
              is_auto_scaling_enabled: true,
              is_auto_scaling_for_storage_enabled: true,
              is_local_data_guard_enabled: db.ha === 'standby' ? true : undefined,
              freeform_tags: tags(db),
            }),
          );
          outs[db.name] = `oci_database_autonomous_database.${db.id}.private_endpoint`;
        } else if (db.service === 'oci-basedb') {
          ssh = true;
          const pw = `db_admin_password_${db.id}`;
          const rac = ha && db.ha !== 'standby';
          let edition = dbEdition(db.edition);
          if (rac && edition !== 'ENTERPRISE_EDITION_EXTREME_PERFORMANCE') {
            findings.push(warning('tf.mig.oci-rac-edition', `${db.name}: a two-node (RAC) DB system needs Enterprise Edition Extreme Performance, so it is written as that.`, { path: 'databases' }));
            edition = 'ENTERPRISE_EDITION_EXTREME_PERFORMANCE';
          }
          const shape = parseShape(db.cls.split(':')[0] ?? '', undefined).shape;
          const cores = classCpus(db.cls, 2);
          const host = alnum(db.name, 12).toLowerCase();
          const dbName = alnum(db.name, 8).toUpperCase();
          const database = blk('database', {
            admin_password: x(`var.${pw}`),
            db_name: dbName,
            pdb_name: `${dbName.slice(0, 5)}PDB`,
            db_workload: 'OLTP',
            character_set: 'AL32UTF8',
            ncharacter_set: 'AL16UTF16',
            // The landing-zone key, when it has one (the database service needs a policy to use it).
            kms_key_id: x(`${lz}.kms_key_id`),
            vault_id: x(`${lz}.kms_key_id == null ? null : ${lz}.vault_id`),
          }, [blk('db_backup_config', { auto_backup_enabled: true, recovery_window_in_days: [7, 15, 30, 45, 60].find((d) => d >= db.backupDays) ?? 60 })]);
          blocks.push(
            secretVariable(pw, `The SYS/SYSTEM password of ${db.name}.`),
            res('oci_database_db_system', db.id, {
              availability_domain: ad(0),
              compartment_id: comp,
              display_name: x(`"\${${lz}.prefix}-${db.name}"`),
              hostname: host,
              shape,
              cpu_core_count: cores,
              subnet_id: subnet(db),
              nsg_ids: nsg(db),
              ssh_public_keys: x('[var.ssh_public_key]'),
              database_edition: edition,
              node_count: rac ? 2 : 1,
              license_model: LICENCE(db),
              data_storage_size_in_gb: Math.max(256, db.storage),
              storage_volume_performance_mode: 'BALANCED',
              freeform_tags: tags(db),
            }, [blk('db_home', { db_version: oracleVersion(db.version), display_name: `${db.name}-home` }, [database])]),
          );
          if (db.ha === 'standby') {
            blocks.push(
              dat('oci_database_databases', db.id, { compartment_id: comp, system_id: x(`oci_database_db_system.${db.id}.id`) }),
              res('oci_database_data_guard_association', db.id, {
                database_id: x(`data.oci_database_databases.${db.id}.databases[0].id`),
                database_admin_password: x(`var.${pw}`),
                creation_type: 'NewDbSystem',
                delete_standby_db_home_on_delete: 'true',
                protection_mode: 'MAXIMUM_PERFORMANCE',
                transport_type: 'ASYNC',
                availability_domain: ad(1),
                display_name: x(`"\${${lz}.prefix}-${db.name}-standby"`),
                hostname: `${host.slice(0, 10)}sb`,
                shape,
                cpu_core_count: cores,
                subnet_id: subnet(db),
                nsg_ids: nsg(db),
                license_model: LICENCE(db),
                is_active_data_guard_enabled: false,
              }, [], 'The standby, in the next availability domain (the same one in a single-domain region).'),
            );
          }
          outs[db.name] = `oci_database_db_system.${db.id}.id`;
          if (db.version && /^(26|23)/.test(db.version)) findings.push(info('tf.mig.oci-26ai', `${db.name}: Oracle AI Database 26ai is delivered as a 23 release update, so the DB home is 23.0.0.0.`, { path: 'databases' }));
        } else if (db.service === 'oci-exacs') {
          ssh = true;
          const shape = (db.cls.split(':')[0] || 'Exadata.X11M').trim();
          const x11 = shape === 'Exadata.X11M';
          const pw = `db_admin_password_${db.id}`;
          const dbName = alnum(db.name, 8).toUpperCase();
          blocks.push(
            secretVariable(pw, `The SYS/SYSTEM password of ${db.name}.`),
            res('oci_database_cloud_exadata_infrastructure', db.id, {
              availability_domain: ad(0),
              compartment_id: comp,
              display_name: x(`"\${${lz}.prefix}-${db.name}-exadata"`),
              shape,
              compute_count: 2,
              storage_count: 3,
              database_server_type: x11 ? 'X11M' : undefined,
              storage_server_type: x11 ? 'X11M-HC' : undefined,
              freeform_tags: tags(db),
            }),
            res('oci_database_cloud_vm_cluster', db.id, {
              cloud_exadata_infrastructure_id: x(`oci_database_cloud_exadata_infrastructure.${db.id}.id`),
              compartment_id: comp,
              display_name: x(`"\${${lz}.prefix}-${db.name}-vmc"`),
              hostname: alnum(db.name, 12).toLowerCase(),
              cpu_core_count: Math.max(4, classCpus(db.cls, 4)),
              gi_version: oracleVersion(db.version),
              ssh_public_keys: x('[var.ssh_public_key]'),
              subnet_id: subnet(db),
              // The backup network is the mgmt subnet: it must differ from the client one.
              backup_subnet_id: subnet(db, 'mgmt'),
              nsg_ids: nsg(db),
              backup_network_nsg_ids: x(`[${lz}.security_group_ids[${q(`${db.network}/mgmt`)}]]`),
              license_model: LICENCE(db),
              is_local_backup_enabled: false,
              freeform_tags: tags(db),
            }),
            res('oci_database_db_home', db.id, {
              vm_cluster_id: x(`oci_database_cloud_vm_cluster.${db.id}.id`),
              source: 'VM_CLUSTER_NEW',
              db_version: oracleVersion(db.version),
              display_name: `${db.name}-home`,
            }),
            res('oci_database_database', db.id, { db_home_id: x(`oci_database_db_home.${db.id}.id`), source: 'NONE' }, [
              blk('database', { db_name: dbName, admin_password: x(`var.${pw}`), character_set: 'AL32UTF8', ncharacter_set: 'AL16UTF16', db_workload: 'OLTP' }),
            ]),
          );
          outs[db.name] = `oci_database_database.${db.id}.id`;
        } else if (db.service === 'oci-mysql-heatwave') {
          const pw = `mysql_admin_password_${db.id}`;
          const version = /^\d+\.\d+\.\d+/.test(db.version) ? db.version : undefined;
          if (db.version && !version) findings.push(info('tf.mig.oci-mysql-version', `${db.name}: "${db.version}" is not a full MySQL version (8.4.3), so the service's default is used.`, { path: 'databases' }));
          blocks.push(
            secretVariable(pw, `The administrator password of the MySQL HeatWave DB system ${db.name}.`),
            res('oci_mysql_mysql_db_system', db.id, {
              availability_domain: ad(0),
              compartment_id: comp,
              display_name: x(`"\${${lz}.prefix}-${db.name}"`),
              shape_name: db.cls || 'MySQL.4',
              subnet_id: subnet(db),
              nsg_ids: nsg(db),
              admin_username: 'dbadmin',
              admin_password: x(`var.${pw}`),
              data_storage_size_in_gb: Math.max(50, db.storage),
              is_highly_available: ha,
              mysql_version: version,
              crash_recovery: 'ENABLED',
              freeform_tags: tags(db),
            }, [
              blk('backup_policy', { is_enabled: true, retention_in_days: clamp(db.backupDays, 1, 35) }, [blk('pitr_policy', { is_enabled: true })]),
              blk('deletion_policy', { is_delete_protected: true, final_backup: 'REQUIRE_FINAL_BACKUP', automatic_backup_retention: 'RETAIN' }),
              {
                type: 'dynamic',
                labels: ['encrypt_data'],
                attributes: attrs({ for_each: x(`${lz}.kms_key_id == null ? [] : [${lz}.kms_key_id]`) }),
                blocks: [blk('content', { key_generation_type: 'BYOK', key_id: x('encrypt_data.value') })],
              },
            ]),
          );
          outs[db.name] = `oci_mysql_mysql_db_system.${db.id}.ip_address`;
        } else if (db.service === 'oci-pg') {
          const [shapeCell = '', o = '', m = ''] = db.cls.split(':');
          const ocpus = Number(o) > 0 ? Number(o) : 2;
          const memory = Number(m) > 0 ? Number(m) : ocpus * 16;
          blocks.push(
            res('oci_psql_db_system', db.id, {
              compartment_id: comp,
              db_version: (db.version.split('.')[0] || '16').trim(),
              display_name: x(`"\${${lz}.prefix}-${db.name}"`),
              shape: shapeCell || 'PostgreSQL.VM.Standard.E5.Flex',
              instance_count: ha ? 2 : 1,
              instance_ocpu_count: ocpus,
              instance_memory_size_in_gbs: memory,
              freeform_tags: tags(db),
            }, [
              blk('network_details', { subnet_id: subnet(db), nsg_ids: nsg(db) }),
              blk('storage_details', { is_regionally_durable: true, system_type: 'OCI_OPTIMIZED_STORAGE', kms_key_id: x(`${lz}.kms_key_id`) }),
              blk('credentials', { username: 'dbadmin' }, [blk('password_details', { password_type: 'VAULT_SECRET', secret_id: secretOcid(db, 'dbadmin'), secret_version: '1' })]),
              blk('management_policy', {}, [blk('backup_policy', { kind: 'DAILY', backup_start: '02:00', retention_days: clamp(db.backupDays, 1, 35) })]),
            ]),
          );
          outs[db.name] = `oci_psql_db_system.${db.id}.network_details[0].primary_db_endpoint_private_ip`;
        } else if (db.service === 'oci-compute') {
          findings.push(info('tf.mig.db-on-compute', `${db.name} runs on OCI compute: its hosts are compute rows, and Ansible installs it.`, { path: 'databases' }));
        } else {
          findings.push(warning('tf.mig.db-service', `${db.name}: "${db.service}" is not an OCI database service here; it was left out.`, { path: 'databases' }));
        }
      }
      if (ssh) blocks.push(sshKeyVariable('ssh_public_key'));
      if (Object.keys(outs).length > 0) {
        blocks.push(output('databases', `{\n    ${Object.entries(outs).map(([k, v]) => `${q(k)} = ${v}`).join('\n    ')}\n  }`, 'Each database: its private endpoint, address or OCID.'));
        findings.push(info('tf.mig.oci-db-policies', 'Autonomous Database and PostgreSQL read their admin password from the Vault secret, and the database services use the landing-zone key: both need IAM policies for the service in the landing-zone compartment (see the OCI Vault documentation for each service).', { path: 'databases' }));
      }
      return { files: { 'main.tf': mainTf(blocks, `OCI databases: ${Object.keys(outs).length} managed`) }, findings };
    },
  };
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

/** One schedule per run in a day: every `hours` hours, or hourly. */
function schedules(hours        , retentionDays        , immutable         )             {
  const common = { backup_type: 'INCREMENTAL', retention_seconds: retentionDays * 86400, time_zone: 'UTC', is_retention_lock_enabled: immutable ? true : undefined };
  if (hours <= 1) return [blk('schedules', { ...common, period: 'ONE_HOUR' })];
  const runs             = [];
  for (let h = 0; h < 24; h += Math.min(24, hours)) runs.push(blk('schedules', { ...common, period: 'ONE_DAY', hour_of_day: hours >= 24 ? 2 : h }));
  return runs;
}

function ociBackup()            {
  return {
    id: 'oci_mig_backup',
    label: 'Backup (migration)',
    group: MIGRATION_GROUP,
    description: 'A Block Volume backup policy per tier (incremental, at the tier\'s frequency and retention, copied to the DR region when asked), assigned to the boot and block volumes of every VM whose atk_backup tag matches.',
    inputs: backupInputs(),
    emits: ['oci_core_volume_backup_policy', 'oci_core_volume_backup_policy_assignment'],
    build: (values                 ) => {
      const findings            = [];
      const lz = lzRef(values);
      const tiers = parseBackupTiers(valueOf(values, 'tiers'), findings);
      const dr = valueOf(values, 'dr_region');
      const vms = vmSource(values, true);
      const blocks             = [TF(), ...consumerPreamble('oci', values), ...vms.blocks];
      for (const t of tiers) {
        const label = ident(t.tier);
        blocks.push(
          res('oci_core_volume_backup_policy', label, {
            compartment_id: x(`${lz}.compartment_id`),
            display_name: x(`"\${${lz}.prefix}-${t.tier}"`),
            destination_region: t.copy && dr ? dr : undefined,
          }, schedules(t.hours, t.retention, t.immutable)),
        );
        if (t.copy && !dr) findings.push(info('tf.mig.backup-no-dr', `Tier ${t.tier} asks for a DR copy but no DR region is set.`, { path: 'dr_region' }));
        if (t.immutable) findings.push(info('tf.mig.oci-retention-lock', `Tier ${t.tier}: its backups are retention-locked (is_retention_lock_enabled): they cannot be deleted before they expire.`, { path: 'tiers' }));
      }
      if (tiers.length === 0) findings.push(warning('tf.mig.no-tiers', 'The backup tiers grid is empty, so nothing is backed up.', { path: 'tiers' }));
      if (dr && tiers.some((t) => t.copy)) {
        findings.push(info('tf.mig.oci-dr-key', 'Copies of volumes encrypted with the landing-zone key need a key in the DR region: set xrc_kms_key_id on the assignments once it exists.', { path: 'dr_region' }));
      }
      blocks.push({
        type: 'locals',
        attributes: [
          { name: 'mig_backup_policies', value: x(hcl(Object.fromEntries(tiers.map((t) => [t.tier, e(`oci_core_volume_backup_policy.${ident(t.tier)}.id`)])), 1)) },
          {
            name: 'mig_backup_volumes',
            value: x(`{
    for p in flatten([
      for k, v in ${vms.expr} : [
        for i, vol in v.volumes : { key = "\${k}/\${i}", asset = vol, backup = v.backup }
      ]
    ]) : p.key => p if contains(keys(local.mig_backup_policies), p.backup)
  }`),
          },
        ],
      });
      blocks.push(
        res('oci_core_volume_backup_policy_assignment', 'volume', {
          for_each: x('local.mig_backup_volumes'),
          asset_id: x('each.value.asset'),
          policy_id: x('local.mig_backup_policies[each.value.backup]'),
        }),
        output('backup_policies', 'local.mig_backup_policies', 'The backup policy of each tier.'),
      );
      return { files: { 'main.tf': mainTf(blocks, `OCI backup: ${tiers.length} tier(s)`) }, findings };
    },
  };
}

// ---------------------------------------------------------------------------
// Monitoring
// ---------------------------------------------------------------------------

function ociMonitoring()            {
  return {
    id: 'oci_mig_monitoring',
    label: 'Monitoring (migration)',
    group: MIGRATION_GROUP,
    description: 'The Unified Monitoring Agent collecting Linux logs and Windows event logs into custom logs in the landing zone\'s log group, and alarms on CPU, memory and missing heartbeats sent to a notification topic.',
    inputs: [...monitoringInputs(), LANDING_ZONE_SOURCE],
    emits: ['oci_identity_dynamic_group', 'oci_identity_policy', 'oci_logging_log', 'oci_logging_unified_agent_configuration', 'oci_ons_notification_topic', 'oci_monitoring_alarm'],
    build: (values                 ) => {
      const findings            = [];
      const lz = lzRef(values);
      const prefix = '${' + lz + '.prefix}';
      const comp = x(`${lz}.compartment_id`);
      const retention = logRetention(Number(valueOf(values, 'retention_days', '90')) || 90);
      const siem = valueOf(values, 'siem', 'none');
      const blocks             = [
        TF(),
        ...consumerPreamble('oci', values),
        variable('tenancy_ocid', 'string', 'The tenancy OCID: dynamic groups are created at the tenancy.'),
        res('oci_identity_dynamic_group', 'mig_instances', {
          compartment_id: x('var.tenancy_ocid'),
          name: x(`"${prefix}-instances"`),
          description: 'Every instance in the landing-zone compartment: the agents write logs as it.',
          matching_rule: x(`"ALL {instance.compartment.id = '\${${lz}.compartment_id}'}"`),
        }),
        res('oci_identity_policy', 'mig_monitoring', {
          compartment_id: comp,
          name: x(`"${prefix}-monitoring"`),
          description: 'The instances may write their logs and metrics.',
          statements: x(hcl([
            e(`"Allow dynamic-group \${oci_identity_dynamic_group.mig_instances.name} to use log-content in compartment id \${${lz}.compartment_id}"`),
            e(`"Allow dynamic-group \${oci_identity_dynamic_group.mig_instances.name} to use metrics in compartment id \${${lz}.compartment_id}"`),
          ], 1)),
        }),
        ...['linux', 'windows'].map((k) =>
          res('oci_logging_log', `mig_${k}`, {
            display_name: x(`"${prefix}-${k}"`),
            log_group_id: x(`${lz}.log_destination`),
            log_type: 'CUSTOM',
            is_enabled: true,
            retention_duration: retention,
          }),
        ),
        res('oci_logging_unified_agent_configuration', 'mig_linux', {
          compartment_id: comp,
          display_name: x(`"${prefix}-linux"`),
          description: 'System and authentication logs of every Linux VM.',
          is_enabled: true,
        }, [
          blk('service_configuration', { configuration_type: 'LOGGING' }, [
            blk('destination', { log_object_id: x('oci_logging_log.mig_linux.id') }),
            blk('sources', { source_type: 'LOG_TAIL', name: 'syslog', paths: ['/var/log/messages', '/var/log/secure', '/var/log/syslog', '/var/log/auth.log'] }, [blk('parser', { parser_type: 'NONE' })]),
          ]),
          blk('group_association', { group_list: x('[oci_identity_dynamic_group.mig_instances.id]') }),
        ]),
        res('oci_logging_unified_agent_configuration', 'mig_windows', {
          compartment_id: comp,
          display_name: x(`"${prefix}-windows"`),
          description: 'System, Security and Application event logs of every Windows VM.',
          is_enabled: true,
        }, [
          blk('service_configuration', { configuration_type: 'LOGGING' }, [
            blk('destination', { log_object_id: x('oci_logging_log.mig_windows.id') }),
            blk('sources', { source_type: 'WINDOWS_EVENT_LOG', name: 'events', channels: ['System', 'Security', 'Application'] }),
          ]),
          blk('group_association', { group_list: x('[oci_identity_dynamic_group.mig_instances.id]') }),
        ]),
        res('oci_ons_notification_topic', 'mig_alarms', { compartment_id: comp, name: x(`"${prefix}-alarms"`), description: 'Alarms of the migrated VMs.' }),
      ];
      const alarms                                     = [
        ['cpu', 'CpuUtilization[5m].mean() > 90', 'WARNING', 'CPU above 90% for five minutes'],
        ['memory', 'MemoryUtilization[5m].mean() > 90', 'WARNING', 'Memory above 90% for five minutes'],
        ['heartbeat', 'CpuUtilization[5m].absent()', 'CRITICAL', 'No metrics from the VM for five minutes: stopped, or its agent is'],
      ];
      for (const [k, query, severity, body] of alarms) {
        blocks.push(
          res('oci_monitoring_alarm', `mig_${k}`, {
            compartment_id: comp,
            display_name: x(`"${prefix}-${k}"`),
            metric_compartment_id: comp,
            namespace: 'oci_computeagent',
            query,
            severity,
            body,
            destinations: x('[oci_ons_notification_topic.mig_alarms.id]'),
            is_enabled: true,
            pending_duration: 'PT5M',
            message_format: 'ONS_OPTIMIZED',
            is_notifications_per_metric_dimension_enabled: true,
          }),
        );
      }
      blocks.push(output('alarm_topic', 'oci_ons_notification_topic.mig_alarms.id', 'The notification topic the alarms publish to: subscribe people or a pager to it.'));
      findings.push(info('tf.mig.oci-disk-alarm', 'The Compute Instance Monitoring plugin has no file-system-full metric; watch disk space with a Management Agent or the Ops Insights host metrics.', { path: 'siem' }));
      findings.push(info('tf.mig.oci-topic', 'The alarm topic has no subscription: add who is told (email, PagerDuty, Slack) once, in the console or with oci_ons_subscription.'));
      if (siem !== 'none') findings.push(info('tf.mig.siem', `Forwarding to ${siem} is configured in the SIEM (a Service Connector from the log group to a stream it reads); nothing is written here for it.`, { path: 'siem' }));
      return { files: { 'main.tf': mainTf(blocks, 'OCI monitoring: the Unified Monitoring Agent and alarms') }, findings };
    },
  };
}

export const MIGRATION_TERRAFORM_OCI                       = [
  ociLandingZone(),
  ociConnectivity(),
  ociCompute(),
  ociDatabases(),
  ociBackup(),
  ociMonitoring(),
];
