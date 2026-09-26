/**
 * The translated rules as Terraform, per target platform (addendum A.5.5.1).
 *
 *   AWS     security groups + `aws_vpc_security_group_ingress_rule` / `_egress_rule`
 *           (a Terraform-managed group has no default egress), and the landing
 *           zone's `aws_networkfirewall_rule_group` (stateful PASS rules).
 *   Azure   an application security group per tier + `azurerm_network_security_rule`,
 *           NIC associations, and an `azurerm_firewall_policy_rule_collection_group`.
 *   Google  `google_compute_firewall` by network tag (`<app>-<tier>`), and
 *           `google_compute_network_firewall_policy_rule` for the landing zone.
 *   OCI     a network security group per tier + `oci_core_network_security_group_security_rule`,
 *           and the Network Firewall policy's address lists, services and security rules.
 *   VMware  NSX distributed firewall: an `nsxt_policy_group` per tier (by VM tag
 *           `<app>|<tier>`) or address set, `nsxt_policy_service`s, and one
 *           `nsxt_policy_security_policy` per app (Application category), plus
 *           one Environment-category policy for site and cross-platform rules.
 *
 * Every type is one the committed provider catalogue has (the tests check each
 * block against the provider schema). Both address families are written: a
 * rule's IPv4 and IPv6 addresses become separate rules where the resource takes
 * one family, and ICMP becomes ICMPv6 on the IPv6 side. No credentials, no
 * footprints: ids come in as variables.
 */

import { renderFile, str, num, bool, list, raw, strings, quote,                                  } from '../../../terraform/hcl.js';
import { toCsv } from '../../../core/csv.js';
import { info, warning,              } from '../../../core/findings.js';
                                            
import { serviceText,                } from './model.js';
import { byFamilyOf,                                                      } from './translate.js';

                                  
                              
                        
                                       
                        
                                     
                                    
 

                              
                                          
                           
 

                                
                                                   
                                                 
                                        
 

/* ----------------------------------------------------------------- naming --- */

const slug = (text        )         => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
/** A Terraform block label. */
const label = (...parts          )         => {
  const l = parts.map((p) => p.toLowerCase().replace(/[^a-z0-9]+/g, '_')).join('_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return /^[a-z_]/.test(l) ? l : `r_${l}`;
};
const tierKey = (e          )         => `${e.app}|${e.component}`;
const tierLabel = (e          )         => label(e.app ?? 'app', e.component ?? 'tier');
const tierName = (prefix        , e          )         => `${prefix}-${slug(e.app ?? 'app')}-${slug(e.component ?? 'tier')}`;
/** A Google resource name: lowercase, starts with a letter, at most 63 characters. */
const gname = (text        )         => {
  const s = slug(text).slice(0, 63).replace(/-+$/, '');
  return /^[a-z]/.test(s) ? s : `r-${s}`.slice(0, 63);
};
const tagsMap = (pairs                        )               => ({
  name: 'tags',
  value: raw(`{\n${Object.entries(pairs).map(([k, v]) => `    ${k} = ${quote(v)}`).join('\n')}\n  }`),
});
const variable = (name        , description        , type = 'string')           => ({
  type: 'variable',
  labels: [name],
  attributes: [
    { name: 'description', value: str(description) },
    { name: 'type', value: raw(type) },
  ],
});
const attr = (name        , value                       )               => ({ name, value });

const SG_SCOPES = new Set(['app-internal', 'app-to-app']);
const isSgRule = (r                )          => r.action === 'allow' && (SG_SCOPES.has(r.scope) || (r.scope === 'cloud-firewall' && !!r.alsoSecurityGroup));
const isFwRule = (r                )          => r.action === 'allow' && r.scope === 'cloud-firewall';

/** The CIDRs of an endpoint that is not a tier (a site, the internet, any), by family. */
const cidrsOf = (e          )                          => byFamilyOf(e.kind === 'any' ? ['0.0.0.0/0', '::/0'] : e.cidrs);
const hasV6 = (e          )          => cidrsOf(e)[6].length > 0;

const portRange = (s           )         => (s.from === undefined ? '*' : s.to !== undefined && s.to !== s.from ? `${s.from}-${s.to}` : String(s.from));

/* -------------------------------------------------------------------- AWS --- */

function awsProto(s           , family       )         {
  if (s.protocol === 'any') return '-1';
  if (s.protocol === 'icmp') return family === 6 ? 'icmpv6' : 'icmp';
  return s.protocol;
}
function awsPorts(s           )                 {
  if (s.protocol === 'any') return [];
  if (s.protocol === 'icmp') return [attr('from_port', num(-1)), attr('to_port', num(-1))];
  return [attr('from_port', num(s.from ?? 0)), attr('to_port', num(s.to ?? s.from ?? 65535))];
}

function emitAws(rules                           , prefix        , findings           )             {
  const blocks             = [variable('vpc_id', 'The VPC the app security groups are created in (the landing zone output).')];
  const tiers = new Map                  ();
  const sgRules = rules.filter(isSgRule);
  for (const r of sgRules) {
    if (r.to.kind === 'tier') tiers.set(tierKey(r.to), r.to);
    if (r.from.kind === 'tier' && r.from.platform === 'aws') tiers.set(tierKey(r.from), r.from);
  }
  for (const t of tiers.values()) {
    blocks.push({
      type: 'resource',
      labels: ['aws_security_group', tierLabel(t)],
      attributes: [attr('name', str(tierName(prefix, t))), attr('description', str(`${t.app} ${t.component} tier`)), attr('vpc_id', raw('var.vpc_id')), tagsMap({ app: t.app ?? '', component: t.component ?? '' })],
    });
  }
  const sgRef = (e          )         => `aws_security_group.${tierLabel(e)}.id`;
  let n = 0;
  for (const r of sgRules) {
    const sameVpcPeer = r.from.kind === 'tier' && r.from.platform === 'aws';
    for (const s of r.services) {
      const families            = s.protocol === 'icmp' ? [4, 6] : [4];
      if (sameVpcPeer) {
        for (const fam of families) {
          if (fam === 6 && !hasV6(r.from)) continue;
          n += 1;
          const desc = str(`${r.id} ${r.from.app}/${r.from.component} to ${r.to.app}/${r.to.component} ${serviceText(s)}`);
          blocks.push({
            type: 'resource',
            labels: ['aws_vpc_security_group_ingress_rule', label(r.id, String(n))],
            attributes: [attr('security_group_id', raw(sgRef(r.to))), attr('referenced_security_group_id', raw(sgRef(r.from))), attr('ip_protocol', str(awsProto(s, fam))), ...awsPorts(s), attr('description', desc)],
          });
          // A Terraform-managed security group starts with no egress: the source needs the matching rule out.
          blocks.push({
            type: 'resource',
            labels: ['aws_vpc_security_group_egress_rule', label(r.id, String(n))],
            attributes: [attr('security_group_id', raw(sgRef(r.from))), attr('referenced_security_group_id', raw(sgRef(r.to))), attr('ip_protocol', str(awsProto(s, fam))), ...awsPorts(s), attr('description', desc)],
          });
        }
        continue;
      }
      const cidrs = cidrsOf(r.from);
      for (const fam of [4, 6]         ) {
        for (const c of cidrs[fam]) {
          n += 1;
          blocks.push({
            type: 'resource',
            labels: ['aws_vpc_security_group_ingress_rule', label(r.id, String(n))],
            attributes: [
              attr('security_group_id', raw(sgRef(r.to))),
              attr(fam === 4 ? 'cidr_ipv4' : 'cidr_ipv6', str(c)),
              attr('ip_protocol', str(awsProto(s, fam))),
              ...awsPorts(s),
              attr('description', str(`${r.id} ${r.from.site ?? r.from.kind} to ${r.to.app}/${r.to.component} ${serviceText(s)}`)),
            ],
          });
        }
      }
    }
  }
  // Egress from a tier to a site or the internet: the tier's own group lets it out; the firewall decides.
  for (const r of rules.filter((x) => isFwRule(x) && x.from.kind === 'tier' && x.from.platform === 'aws' && x.to.kind !== 'tier')) {
    if (!tiers.has(tierKey(r.from))) {
      tiers.set(tierKey(r.from), r.from);
      blocks.push({
        type: 'resource',
        labels: ['aws_security_group', tierLabel(r.from)],
        attributes: [attr('name', str(tierName(prefix, r.from))), attr('description', str(`${r.from.app} ${r.from.component} tier`)), attr('vpc_id', raw('var.vpc_id')), tagsMap({ app: r.from.app ?? '', component: r.from.component ?? '' })],
      });
    }
    const cidrs = cidrsOf(r.to);
    for (const s of r.services) {
      for (const fam of [4, 6]         ) {
        for (const c of cidrs[fam]) {
          n += 1;
          blocks.push({
            type: 'resource',
            labels: ['aws_vpc_security_group_egress_rule', label(r.id, String(n))],
            attributes: [attr('security_group_id', raw(sgRef(r.from))), attr(fam === 4 ? 'cidr_ipv4' : 'cidr_ipv6', str(c)), attr('ip_protocol', str(awsProto(s, fam))), ...awsPorts(s), attr('description', str(`${r.id} ${serviceText(s)}`))],
          });
        }
      }
    }
  }

  const fw = rules.filter(isFwRule);
  if (fw.length) {
    const stateful             = [];
    let sid = 0;
    for (const r of fw) {
      const src = r.from.kind === 'tier' ? byFamilyOf(r.from.cidrs) : cidrsOf(r.from);
      const dst = r.to.kind === 'tier' ? byFamilyOf(r.to.cidrs) : cidrsOf(r.to);
      for (const s of r.services) {
        for (const fam of [4, 6]         ) {
          for (const a of src[fam]) {
            for (const b of dst[fam]) {
              sid += 1;
              stateful.push({
                type: 'stateful_rule',
                attributes: [attr('action', str('PASS'))],
                blocks: [
                  {
                    type: 'header',
                    attributes: [
                      attr('protocol', str(s.protocol === 'any' ? 'IP' : s.protocol.toUpperCase())),
                      attr('source', str(a)),
                      attr('source_port', str('ANY')),
                      attr('direction', str('FORWARD')),
                      attr('destination', str(b)),
                      attr('destination_port', str(s.from === undefined || s.protocol === 'icmp' || s.protocol === 'any' ? 'ANY' : s.to !== s.from ? `${s.from}:${s.to}` : String(s.from))),
                    ],
                  },
                  { type: 'rule_option', attributes: [attr('keyword', str('sid')), attr('settings', strings([String(sid)]))] },
                ],
              });
            }
          }
        }
      }
    }
    blocks.push({
      type: 'resource',
      labels: ['aws_networkfirewall_rule_group', 'migration'],
      comment: 'Attach this rule group to the landing zone firewall policy (stateful_rule_group_reference).',
      attributes: [attr('name', str(`${prefix}-migration`)), attr('type', str('STATEFUL')), attr('capacity', num(Math.max(100, Math.ceil((sid * 2) / 100) * 100)))],
      blocks: [{ type: 'rule_group', blocks: [{ type: 'rules_source', blocks: stateful }] }],
    });
    if (sid === 0) findings.push(info('netsec.emit.empty', 'AWS: the cloud-firewall rules have no address pairs in one family.'));
  }
  return blocks;
}

/* ------------------------------------------------------------------ Azure --- */

const azProto = (s           )         => (s.protocol === 'any' ? '*' : s.protocol === 'icmp' ? 'Icmp' : s.protocol === 'tcp' ? 'Tcp' : 'Udp');

function emitAzure(rules                           , prefix        , findings           )             {
  const blocks             = [
    variable('resource_group_name', 'The resource group of the landing zone network.'),
    variable('location', 'The Azure region.'),
    variable('network_security_group_name', 'The NSG on the app subnets (the landing zone output).'),
    variable('firewall_policy_id', 'The landing zone Azure Firewall policy.'),
    { ...variable('asg_nic_ids', 'Per tier ("<app>|<tier>"), the NIC ids that join its application security group.', 'map(list(string))'), attributes: [attr('description', str('Per tier ("<app>|<tier>"), the NIC ids that join its application security group.')), attr('type', raw('map(list(string))')), attr('default', raw('{}'))] },
  ];
  const sgRules = rules.filter(isSgRule);
  const tiers = new Map                  ();
  for (const r of sgRules) {
    tiers.set(tierKey(r.to), r.to);
    if (r.from.kind === 'tier' && r.from.platform === 'azure') tiers.set(tierKey(r.from), r.from);
  }
  for (const t of tiers.values()) {
    blocks.push({
      type: 'resource',
      labels: ['azurerm_application_security_group', tierLabel(t)],
      attributes: [attr('name', str(tierName(prefix, t))), attr('location', raw('var.location')), attr('resource_group_name', raw('var.resource_group_name')), tagsMap({ app: t.app ?? '', component: t.component ?? '' })],
    });
    blocks.push({
      type: 'resource',
      labels: ['azurerm_network_interface_application_security_group_association', tierLabel(t)],
      attributes: [
        attr('for_each', raw(`toset(lookup(var.asg_nic_ids, ${quote(tierKey(t))}, []))`)),
        attr('network_interface_id', raw('each.value')),
        attr('application_security_group_id', raw(`azurerm_application_security_group.${tierLabel(t)}.id`)),
      ],
    });
  }
  let priority = 100;
  const asg = (e          )                        => list([raw(`azurerm_application_security_group.${tierLabel(e)}.id`)]);
  for (const r of sgRules) {
    for (const s of r.services) {
      const base = (name        , source                )           => {
        priority += 10;
        return {
          type: 'resource',
          labels: ['azurerm_network_security_rule', label(name)],
          attributes: [
            attr('name', str(name)),
            attr('priority', num(Math.min(priority, 4096))),
            attr('direction', str('Inbound')),
            attr('access', str('Allow')),
            attr('protocol', str(azProto(s))),
            attr('source_port_range', str('*')),
            attr('destination_port_range', str(s.protocol === 'tcp' || s.protocol === 'udp' ? portRange(s) : '*')),
            ...source,
            attr('destination_application_security_group_ids', asg(r.to)),
            attr('resource_group_name', raw('var.resource_group_name')),
            attr('network_security_group_name', raw('var.network_security_group_name')),
            attr('description', str(`${r.id} ${serviceText(s)}`)),
          ],
        };
      };
      if (r.from.kind === 'tier' && r.from.platform === 'azure') {
        blocks.push(base(`${prefix}-${r.id}-${slug(serviceText(s))}`, [attr('source_application_security_group_ids', asg(r.from))]));
      } else {
        const c = cidrsOf(r.from);
        for (const fam of [4, 6]         ) {
          if (c[fam].length) blocks.push(base(`${prefix}-${r.id}-${slug(serviceText(s))}-v${fam}`, [attr('source_address_prefixes', strings(c[fam]))]));
        }
      }
    }
  }
  if (priority > 4096) findings.push(warning('netsec.emit.azure-priority', 'Azure: more NSG rules than priorities 110–4096 allow; split the NSG.'));

  const fw = rules.filter(isFwRule);
  if (fw.length) {
    const ruleBlocks             = [];
    let v6Dropped = 0;
    for (const r of fw) {
      const src = r.from.kind === 'tier' ? byFamilyOf(r.from.cidrs) : cidrsOf(r.from);
      const dst = r.to.kind === 'tier' ? byFamilyOf(r.to.cidrs) : cidrsOf(r.to);
      v6Dropped += src[6].length + dst[6].length;
      if (!src[4].length || !dst[4].length) continue;
      for (const s of r.services) {
        ruleBlocks.push({
          type: 'rule',
          attributes: [
            attr('name', str(`${r.id}-${slug(serviceText(s))}`)),
            attr('protocols', strings([s.protocol === 'any' ? 'Any' : s.protocol.toUpperCase()])),
            attr('source_addresses', strings(src[4])),
            attr('destination_addresses', strings(dst[4])),
            attr('destination_ports', strings([s.protocol === 'tcp' || s.protocol === 'udp' ? portRange(s) : '*'])),
          ],
        });
      }
    }
    if (v6Dropped) {
      findings.push(
        warning('netsec.emit.azure-firewall-ipv6', 'Azure: IPv6 addresses in cloud-firewall rules are not written to the Azure Firewall policy (Azure Firewall is IPv4-only, unverified: https://learn.microsoft.com/azure/firewall/firewall-faq); the NSG rules carry the IPv6 side.', {
          source: 'https://learn.microsoft.com/azure/firewall/firewall-faq',
        }),
      );
    }
    if (ruleBlocks.length) {
      blocks.push({
        type: 'resource',
        labels: ['azurerm_firewall_policy_rule_collection_group', 'migration'],
        attributes: [attr('name', str(`${prefix}-migration`)), attr('firewall_policy_id', raw('var.firewall_policy_id')), attr('priority', num(500))],
        blocks: [{ type: 'network_rule_collection', attributes: [attr('name', str('migration-network')), attr('priority', num(100)), attr('action', str('Allow'))], blocks: ruleBlocks }],
      });
    }
  }
  return blocks;
}

/* ----------------------------------------------------------------- Google --- */

function gAllow(s           , family       )           {
  const protocol = s.protocol === 'any' ? 'all' : s.protocol === 'icmp' ? (family === 6 ? '58' : 'icmp') : s.protocol;
  return { type: 'allow', attributes: [attr('protocol', str(protocol)), ...(s.from !== undefined && (s.protocol === 'tcp' || s.protocol === 'udp') ? [attr('ports', strings([portRange(s)]))] : [])] };
}

function emitGoogle(rules                           , prefix        )             {
  const blocks             = [variable('network', 'The VPC network (self link or name, the landing zone output).'), variable('firewall_policy', 'The landing zone network firewall policy.')];
  const tag = (e          )         => gname(`${e.app}-${e.component}`);
  for (const r of rules.filter(isSgRule)) {
    for (const s of r.services) {
      const base = (suffix        , source                , family       )           => ({
        type: 'resource',
        labels: ['google_compute_firewall', label(r.id, suffix)],
        comment: `Instances carry the network tag of their tier (${tag(r.to)}).`,
        attributes: [attr('name', str(gname(`${prefix}-${r.id}-${suffix}`))), attr('network', raw('var.network')), attr('direction', str('INGRESS')), ...source, attr('target_tags', strings([tag(r.to)])), attr('description', str(`${r.id} ${serviceText(s)}`))],
        blocks: [gAllow(s, family), { type: 'log_config', attributes: [attr('metadata', str('INCLUDE_ALL_METADATA'))] }],
      });
      const svc = slug(serviceText(s));
      if (r.from.kind === 'tier' && r.from.platform === 'google') {
        blocks.push(base(svc, [attr('source_tags', strings([tag(r.from)]))], 4));
        if (s.protocol === 'icmp') blocks.push(base(`${svc}-v6`, [attr('source_tags', strings([tag(r.from)]))], 6));
      } else {
        const c = cidrsOf(r.from);
        for (const fam of [4, 6]         ) if (c[fam].length) blocks.push(base(`${svc}-v${fam}`, [attr('source_ranges', strings(c[fam]))], fam));
      }
    }
  }
  let priority = 1000;
  for (const r of rules.filter(isFwRule)) {
    const src = r.from.kind === 'tier' ? byFamilyOf(r.from.cidrs) : cidrsOf(r.from);
    const dst = r.to.kind === 'tier' ? byFamilyOf(r.to.cidrs) : cidrsOf(r.to);
    const ingress = r.to.kind === 'tier';
    for (const s of r.services) {
      for (const fam of [4, 6]         ) {
        if (!src[fam].length || !dst[fam].length) continue;
        priority += 1;
        const l4           = {
          type: 'layer4_configs',
          attributes: [attr('ip_protocol', str(s.protocol === 'any' ? 'all' : s.protocol === 'icmp' ? (fam === 6 ? '58' : 'icmp') : s.protocol)), ...(s.from !== undefined && (s.protocol === 'tcp' || s.protocol === 'udp') ? [attr('ports', strings([portRange(s)]))] : [])],
        };
        blocks.push({
          type: 'resource',
          labels: ['google_compute_network_firewall_policy_rule', label(r.id, slug(serviceText(s)), `v${fam}`)],
          attributes: [
            attr('firewall_policy', raw('var.firewall_policy')),
            attr('rule_name', str(gname(`${prefix}-${r.id}-${serviceText(s)}-v${fam}`))),
            attr('priority', num(priority)),
            attr('action', str('allow')),
            attr('direction', str(ingress ? 'INGRESS' : 'EGRESS')),
            attr('enable_logging', bool(true)),
            attr('description', str(r.why)),
          ],
          blocks: [{ type: 'match', attributes: [attr('src_ip_ranges', strings(src[fam])), attr('dest_ip_ranges', strings(dst[fam]))], blocks: [l4] }],
        });
      }
    }
  }
  return blocks;
}

/* -------------------------------------------------------------------- OCI --- */

/** IANA protocol numbers, as OCI wants them. */
const ociProto = (s           , family       )         => (s.protocol === 'any' ? 'all' : s.protocol === 'tcp' ? '6' : s.protocol === 'udp' ? '17' : family === 6 ? '58' : '1');
function ociPorts(s           )             {
  if ((s.protocol !== 'tcp' && s.protocol !== 'udp') || s.from === undefined) return [];
  return [{ type: `${s.protocol}_options`, blocks: [{ type: 'destination_port_range', attributes: [attr('min', num(s.from)), attr('max', num(s.to ?? s.from))] }] }];
}

function emitOci(rules                           , prefix        , findings           )             {
  const blocks             = [
    variable('compartment_id', 'The compartment of the app network security groups.'),
    variable('vcn_id', 'The VCN (the landing zone output).'),
    variable('network_firewall_policy_id', 'The landing zone OCI Network Firewall policy.'),
  ];
  const sgRules = rules.filter(isSgRule);
  const tiers = new Map                  ();
  for (const r of sgRules) {
    tiers.set(tierKey(r.to), r.to);
    if (r.from.kind === 'tier' && r.from.platform === 'oci') tiers.set(tierKey(r.from), r.from);
  }
  for (const t of tiers.values()) {
    blocks.push({
      type: 'resource',
      labels: ['oci_core_network_security_group', tierLabel(t)],
      attributes: [attr('compartment_id', raw('var.compartment_id')), attr('vcn_id', raw('var.vcn_id')), attr('display_name', str(tierName(prefix, t)))],
    });
  }
  let n = 0;
  for (const r of sgRules) {
    for (const s of r.services) {
      const add = (source        , sourceType        , fam       )       => {
        n += 1;
        blocks.push({
          type: 'resource',
          labels: ['oci_core_network_security_group_security_rule', label(r.id, String(n))],
          attributes: [
            attr('network_security_group_id', raw(`oci_core_network_security_group.${tierLabel(r.to)}.id`)),
            attr('direction', str('INGRESS')),
            attr('protocol', str(ociProto(s, fam))),
            attr('source', sourceType === 'NETWORK_SECURITY_GROUP' ? raw(source) : str(source)),
            attr('source_type', str(sourceType)),
            attr('stateless', bool(false)),
            attr('description', str(`${r.id} ${serviceText(s)}`)),
          ],
          blocks: ociPorts(s),
        });
      };
      if (r.from.kind === 'tier' && r.from.platform === 'oci') {
        add(`oci_core_network_security_group.${tierLabel(r.from)}.id`, 'NETWORK_SECURITY_GROUP', 4);
        if (s.protocol === 'icmp') add(`oci_core_network_security_group.${tierLabel(r.from)}.id`, 'NETWORK_SECURITY_GROUP', 6);
      } else {
        const c = cidrsOf(r.from);
        for (const fam of [4, 6]         ) for (const cidr of c[fam]) add(cidr, 'CIDR_BLOCK', fam);
      }
    }
  }

  const fw = rules.filter(isFwRule);
  if (fw.length) {
    const lists = new Map                  ();
    const services = new Map                   ();
    let icmpSkipped = false;
    for (const r of fw) {
      const src = r.from.kind === 'tier' ? r.from.cidrs : r.from.kind === 'any' ? ['0.0.0.0/0', '::/0'] : r.from.cidrs;
      const dst = r.to.kind === 'tier' ? r.to.cidrs : r.to.kind === 'any' ? ['0.0.0.0/0', '::/0'] : r.to.cidrs;
      lists.set(`${r.id}-src`, [...src]);
      lists.set(`${r.id}-dst`, [...dst]);
      const named           = [];
      for (const s of r.services) {
        if (s.protocol === 'tcp' || s.protocol === 'udp') {
          const name = gname(`${s.protocol}-${portRange(s)}`);
          services.set(name, s);
          named.push(name);
        } else if (s.protocol === 'icmp') icmpSkipped = true;
      }
      blocks.push({
        type: 'resource',
        labels: ['oci_network_firewall_network_firewall_policy_security_rule', label(r.id)],
        attributes: [attr('name', str(`${prefix}-${r.id}`)), attr('network_firewall_policy_id', raw('var.network_firewall_policy_id')), attr('action', str('ALLOW')), attr('description', str(r.why))],
        blocks: [
          {
            type: 'condition',
            attributes: [
              attr('source_address', list([raw(`oci_network_firewall_network_firewall_policy_address_list.${label(r.id, 'src')}.name`)])),
              attr('destination_address', list([raw(`oci_network_firewall_network_firewall_policy_address_list.${label(r.id, 'dst')}.name`)])),
              ...(named.length ? [attr('service', list(named.map((x) => raw(`oci_network_firewall_network_firewall_policy_service.${label(x)}.name`))))] : []),
            ],
          },
        ],
      });
    }
    for (const [name, addresses] of lists) {
      blocks.push({
        type: 'resource',
        labels: ['oci_network_firewall_network_firewall_policy_address_list', label(name)],
        attributes: [attr('name', str(`${prefix}-${name}`)), attr('network_firewall_policy_id', raw('var.network_firewall_policy_id')), attr('type', str('IP')), attr('addresses', strings(addresses))],
      });
    }
    for (const [name, s] of services) {
      blocks.push({
        type: 'resource',
        labels: ['oci_network_firewall_network_firewall_policy_service', label(name)],
        attributes: [attr('name', str(name)), attr('network_firewall_policy_id', raw('var.network_firewall_policy_id')), attr('type', str(s.protocol === 'tcp' ? 'TCP_SERVICE' : 'UDP_SERVICE'))],
        blocks: [{ type: 'port_ranges', attributes: [attr('minimum_port', num(s.from ?? 0)), attr('maximum_port', num(s.to ?? s.from ?? 65535))] }],
      });
    }
    if (icmpSkipped) findings.push(info('netsec.emit.oci-icmp', 'OCI: Network Firewall services are TCP or UDP port ranges; ICMP in cloud-firewall rules is left to the NSG and the security list.'));
  }
  return blocks;
}

/* ----------------------------------------------------------------- VMware --- */

function nsxEntry(s           )             {
  if (s.protocol === 'tcp' || s.protocol === 'udp') {
    return [{ type: 'l4_port_set_entry', attributes: [attr('display_name', str(serviceText(s))), attr('protocol', str(s.protocol.toUpperCase())), ...(s.from !== undefined ? [attr('destination_ports', strings([portRange(s)]))] : [])] }];
  }
  if (s.protocol === 'icmp') {
    return [
      { type: 'icmp_entry', attributes: [attr('display_name', str('ICMPv4')), attr('protocol', str('ICMPv4'))] },
      { type: 'icmp_entry', attributes: [attr('display_name', str('ICMPv6')), attr('protocol', str('ICMPv6'))] },
    ];
  }
  return [];
}

const endName = (e          )         => (e.kind === 'tier' ? `${e.app}/${e.component}` : e.site ?? e.kind);

function emitVmware(rules                           , prefix        )             {
  const blocks             = [];
  const groups = new Map                  ();
  const groupFor = (e          , id        )                => {
    if (e.kind === 'any') return null;
    // A tier that lands elsewhere is matched by its addresses, not by a VM tag.
    if (e.kind === 'tier' && e.platform === 'vmware') {
      const l = tierLabel(e);
      if (!groups.has(l)) {
        groups.set(l, {
          type: 'resource',
          labels: ['nsxt_policy_group', l],
          comment: `VMs tagged ${e.app}|${e.component} (scope|tag) are this tier.`,
          attributes: [attr('display_name', str(tierName(prefix, e))), attr('description', str(`${e.app} ${e.component} tier`))],
          blocks: [{ type: 'criteria', blocks: [{ type: 'condition', attributes: [attr('key', str('Tag')), attr('member_type', str('VirtualMachine')), attr('operator', str('EQUALS')), attr('value', str(`${e.app}|${e.component}`))] }] }],
        });
      }
      return `nsxt_policy_group.${l}.path`;
    }
    const l = label(id, 'addresses');
    groups.set(l, {
      type: 'resource',
      labels: ['nsxt_policy_group', l],
      attributes: [attr('display_name', str(`${prefix}-${id}-${e.site ? slug(e.site) : e.kind === 'tier' ? `${slug(e.app ?? '')}-${slug(e.component ?? '')}` : e.kind}`))],
      blocks: [{ type: 'criteria', blocks: [{ type: 'ipaddress_expression', attributes: [attr('ip_addresses', strings(e.cidrs))] }] }],
    });
    return `nsxt_policy_group.${l}.path`;
  };
  const servicesSeen = new Map                ();
  const serviceFor = (s           )                => {
    if (s.protocol === 'any') return null;
    const l = label('svc', serviceText(s));
    if (!servicesSeen.has(l)) {
      servicesSeen.set(l, l);
      blocks.push({ type: 'resource', labels: ['nsxt_policy_service', l], attributes: [attr('display_name', str(`${prefix}-${serviceText(s)}`))], blocks: nsxEntry(s) });
    }
    return `nsxt_policy_service.${l}.path`;
  };

  const policies = new Map                                                 ();
  for (const r of rules.filter((x) => isSgRule(x) || isFwRule(x))) {
    const key = r.scope === 'cloud-firewall' ? '__environment' : (r.to.app ?? 'app');
    const policy = policies.get(key) ?? { category: r.scope === 'cloud-firewall' ? 'Environment' : 'Application', rules: [] };
    policies.set(key, policy);
    const src = groupFor(r.from, `${r.id}-src`);
    const dst = groupFor(r.to, `${r.id}-dst`);
    const svcs = r.services.map(serviceFor).filter((x)              => x !== null);
    policy.rules.push({
      type: 'rule',
      attributes: [
        attr('display_name', str(`${r.id} ${endName(r.from)} to ${endName(r.to)}`.slice(0, 255))),
        attr('action', str('ALLOW')),
        attr('direction', str('IN_OUT')),
        attr('ip_version', str('IPV4_IPV6')),
        attr('logged', bool(true)),
        ...(src ? [attr('source_groups', list([raw(src)]))] : []),
        ...(dst ? [attr('destination_groups', list([raw(dst)]))] : []),
        ...(svcs.length ? [attr('services', list(svcs.map(raw)))] : []),
        attr('notes', str(r.why)),
      ],
    });
  }
  blocks.unshift(...groups.values());
  for (const [key, p] of policies) {
    blocks.push({
      type: 'resource',
      labels: ['nsxt_policy_security_policy', label(key === '__environment' ? 'migration_environment' : key)],
      attributes: [attr('display_name', str(key === '__environment' ? `${prefix}-migration-environment` : `${prefix}-${slug(key)}`)), attr('category', str(p.category)), attr('stateful', bool(true))],
      blocks: p.rules,
    });
  }
  return blocks;
}

/* ------------------------------------------------------------------- files --- */

const HEADER                                     = {
  aws: 'Security groups and Network Firewall rules translated from the source firewalls.',
  azure: 'Application security groups, NSG rules and Azure Firewall rules translated from the source firewalls.',
  google: 'VPC firewall rules and network firewall policy rules translated from the source firewalls.',
  oci: 'Network security groups and Network Firewall policy rules translated from the source firewalls.',
  vmware: 'NSX distributed firewall groups, services and policies translated from the source firewalls.',
};

function typesIn(blocks                     )           {
  return [...new Set(blocks.filter((b) => b.type === 'resource').map((b) => b.labels?.[0]          ))].sort();
}

/** Every file: `netsec/<platform>.tf`, and the review, rule, ingress and egress lists. */
export function emitTerraform(t             , options              = {})                {
  const prefix = slug(options.prefix ?? 'mig');
  const findings            = [];
  const files                         = {};
  const platforms                    = [];
  const byPlatform = new Map                            ();
  for (const r of t.rules) if (r.platform && (isSgRule(r) || isFwRule(r))) byPlatform.set(r.platform, [...(byPlatform.get(r.platform) ?? []), r]);
  for (const p of ['aws', 'azure', 'google', 'oci', 'vmware']         ) {
    const rules = byPlatform.get(p);
    if (!rules?.length) continue;
    const blocks = p === 'aws' ? emitAws(rules, prefix, findings) : p === 'azure' ? emitAzure(rules, prefix, findings) : p === 'google' ? emitGoogle(rules, prefix) : p === 'oci' ? emitOci(rules, prefix, findings) : emitVmware(rules, prefix);
    const path = `netsec/${p}.tf`;
    const text = renderFile(blocks, HEADER[p]);
    files[path] = text;
    platforms.push({ platform: p, path, blocks, text, types: typesIn(blocks) });
  }

  files['netsec/rules.csv'] = toCsv(
    t.rules.map((r) => ({
      id: r.id,
      scope: r.scope,
      platform: r.platform ?? '',
      from: r.from.kind === 'tier' ? `${r.from.app}/${r.from.component}` : r.from.site ?? r.from.kind,
      to: r.to.kind === 'tier' ? `${r.to.app}/${r.to.component}` : r.to.site ?? r.to.kind,
      services: r.services.map(serviceText).join(' '),
      action: r.action,
      origin: r.origin,
      sources: r.sources.join('; '),
      why: r.why,
    })),
    ['id', 'scope', 'platform', 'from', 'to', 'services', 'action', 'origin', 'sources', 'why'],
  ) || 'id,scope,platform,from,to,services,action,origin,sources,why\n';
  const review = t.rules.filter((r) => r.scope === 'review');
  files['netsec/review.csv'] = toCsv(
    review.map((r) => ({ id: r.id, from: r.from.written.join(' '), to: r.to.written.join(' '), services: r.services.map(serviceText).join(' '), sources: r.sources.join('; '), why: r.why })),
    ['id', 'from', 'to', 'services', 'sources', 'why'],
  ) || 'id,from,to,services,sources,why\n';
  files['netsec/egress-ips.csv'] = toCsv(
    t.egress.map((e) => ({ current_egress: e.current, inside: e.inside.join(' '), apps: e.apps.join(' '), platform: e.platform ?? '', notify: e.notices.join(' ') })),
    ['current_egress', 'inside', 'apps', 'platform', 'notify'],
  ) || 'current_egress,inside,apps,platform,notify\n';
  files['netsec/ingress.json'] = `${JSON.stringify(
    t.ingress.map((i) => ({ name: i.name, app: i.app ?? null, platform: i.platform ?? null, blueprint: i.blueprint ?? null, listener: i.listener, members: i.members, healthCheck: i.healthCheck, persistence: i.persistence, ingress: i.ingress, types: i.types })),
    null,
    2,
  )}\n`;
  return { files, platforms, findings };
}
