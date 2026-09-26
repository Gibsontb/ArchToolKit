/**
 * `<p>_app_ingress` (addendum A.4.10, A.5.5.1 step 5): an app's way in. A
 * load balancer (layer 7 or 4, internal or public), its pool of members, a
 * health check, TLS, a WAF when asked, and the DNS names pointing at it.
 * WP-22's network translation writes one item per source VIP
 * (`IngressItem.blueprint`); a greenfield app gets one from its template.
 *
 *   AWS     aws_lb (ALB or NLB, dualstack), target group + attachments,
 *           listeners, a WAFv2 web ACL (AWS managed rules), Route 53 A / AAAA
 *   Azure   Application Gateway v2 (layer 7; WAF_v2 with a WAF policy) in its
 *           own subnet, or a Standard load balancer (layer 4, dual-stack
 *           frontends); private or public DNS A / AAAA records
 *   Google  a global external or regional internal Application load balancer
 *           (layer 7), or a passthrough network load balancer (layer 4), each
 *           over zonal NEGs; Cloud Armor for the WAF; Cloud DNS A / AAAA
 *   OCI     a flexible load balancer (IPv6 mode on a dual-stack network),
 *           backend set, backends, listener; OCI WAF; OCI DNS A / AAAA
 *   VCF     Avi Load Balancer: health monitor, pool, VS VIP (IPv4 and IPv6),
 *           virtual service, with the FQDN registered through the VIP
 *
 * Members are addresses (a server's name, its address, port and zone): the
 * servers are the app's VMs, rebuilt or replicated, so their addresses are
 * known to the plan. Certificates are references (an ACM ARN, a Key Vault
 * secret id, a certificate id or self link, an OCI certificate OCID, an Avi
 * certificate name), never key material.
 */

import { error, info, warning,              } from '../../../core/findings.js';
import { familyOf } from '../../../core/ip.js';
                                                                                            
import { num as numberOf, str as valueOf } from '../../../kit/blueprint.js';
import { CATALOG_DATA } from '../../catalog-data.js';
                                             
import {
  LANDING_ZONE_SOURCE,
  YES_NO,
  attrs,
  blk,
  dat,
  gridInput,
  hcl,
  ident,
  lzRef,
  output,
  parseGrid,
  q,
  res,
  rname,
  uniqueNames,
  variable,
  x,
  yes,
                  
                
} from '../migration/common.js';
import {
  NETWORK_INPUT,
  PATTERN_GROUP,
  TIER_OPTIONS,
  appInputs,
  appOf,
  ipv6Of,
  listOf,
  namePrefix,
  patternMainTf,
  preamble,
  securityGroupOf,
  subnetOf,
  subnetsOf,
  tagsExpr,
               
                       
} from './common.js';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export const MEMBER_COLUMNS                        = [{ name: 'Server' }, { name: 'Address' }, { name: 'Port' }, { name: 'Zone', options: ['a', 'b', 'c'] }];
const DEFAULT_MEMBERS                                 = [
  ['web01', '10.40.0.10', '443', 'a'],
  ['web02', '10.40.4.10', '443', 'b'],
];

                         
                          
                       
                           
                       
                        
                        
                             
 

export function parseMembers(text        , defaultPort        , findings           )           {
  const rows = uniqueNames(parseGrid(text, MEMBER_COLUMNS.map((c) => c.name)), 'Server', 'members', findings);
  const out           = [];
  for (const r of rows) {
    const address = (r['Address'] ?? '').replace(/^\[|\]$/g, '');
    const family = familyOf(address);
    if (family === null || address.includes('/')) {
      findings.push(error('tf.app.ingress-member', `Member ${r['Server']}: "${address}" is not an IP address.`, { path: 'members' }));
      continue;
    }
    const zone = (r['Zone'] || 'a').toLowerCase();
    const zi = Math.max(0, ['a', 'b', 'c'].indexOf(zone));
    const port = Number(r['Port']);
    out.push({
      server: r['Server']          ,
      key: rname(r['Server']          ) || `m${out.length + 1}`,
      address,
      v6: family === 6,
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : defaultPort,
      zone: ['a', 'b', 'c'][zi]          ,
      zoneIndex: zi,
    });
  }
  if (out.length === 0) findings.push(warning('tf.app.ingress-no-members', 'The ingress has no members yet: the load balancer is built with an empty pool.', { path: 'members' }));
  return out;
}

function ingressInputs(platform                 )                   {
  const cert                                  = {
    aws: 'An ACM certificate ARN.',
    azure: 'A Key Vault secret id (versionless) the landing zone identity can read.',
    google: 'Public: blank for a Google-managed certificate of the FQDNs. Internal: a regional SSL certificate self link.',
    oci: 'An OCI Certificates service certificate OCID.',
    vsphere: 'The name of an SSL key and certificate already on the Avi Controller.',
  };
  return [
    ...appInputs(),
    ...(platform === 'vsphere' ? [] : [NETWORK_INPUT]),
    ...(platform === 'vsphere' ? [] : [{ id: 'tier', label: 'Tier', control: 'select'         , default: 'web', options: TIER_OPTIONS, hint: 'The landing-zone tier whose subnets the load balancer sits in.' }]),
    { id: 'exposure', label: 'Exposure', control: 'select', default: 'internal', options: [{ value: 'internal', label: 'Internal (private addresses)' }, { value: 'public', label: 'Public (internet-facing)' }] },
    { id: 'lb', label: 'Load balancer', control: 'select', default: 'l7', options: [{ value: 'l7', label: 'Layer 7 (HTTP/HTTPS)' }, { value: 'l4', label: 'Layer 4 (TCP)' }] },
    { id: 'tls', label: 'TLS', control: 'select', default: 'terminate', options: [{ value: 'terminate', label: 'Terminate at the load balancer' }, { value: 'passthrough', label: 'Pass through to the servers' }] },
    { id: 'waf', label: 'Web application firewall', control: 'select', default: 'no', options: YES_NO, hint: 'Layer 7 only.' },
    { id: 'listener_port', label: 'Listener port', control: 'number', default: 443, min: 1, max: 65535 },
    { id: 'backend_port', label: 'Server port', control: 'number', default: 443, min: 1, max: 65535, hint: 'A member row\'s Port overrides it.' },
    { id: 'backend_protocol', label: 'Server protocol', control: 'select', default: 'https', options: [{ value: 'https', label: 'HTTPS' }, { value: 'http', label: 'HTTP' }, { value: 'tcp', label: 'TCP' }] },
    { id: 'health_path', label: 'Health check path', control: 'text', default: '/', hint: 'HTTP(S) checks; a TCP check ignores it.' },
    { id: 'persistence', label: 'Persistence', control: 'select', default: 'none', options: [{ value: 'none', label: 'None' }, { value: 'source-ip', label: 'Source IP' }, { value: 'cookie', label: 'Cookie' }] },
    gridInput('members', 'Members', MEMBER_COLUMNS, DEFAULT_MEMBERS, 'One row per server: its name, address (IPv4 or IPv6), port and zone.'),
    { id: 'fqdns', label: 'DNS names', control: 'text', default: 'shop.corp.example.com', hint: 'Space-separated; each gets A (and AAAA on a dual-stack ingress) records.' },
    { id: 'dns_zone', label: 'DNS zone', control: 'text', default: 'corp.example.com', hint: platform === 'vsphere' ? 'Registered through the Avi DNS profile of the cloud.' : 'The zone the names are in; blank writes no records.' },
    ...(platform === 'azure' ? [{ id: 'dns_resource_group', label: 'DNS zone resource group', control: 'text'         , default: '', hint: 'Blank: the landing zone\'s shared resource group.' }] : []),
    ...(platform === 'oci' ? [{ id: 'dns_view_id', label: 'Private DNS view OCID', control: 'text'         , default: '', hint: 'Internal: the VCN resolver\'s private view the zone is in.' }] : []),
    { id: 'certificate', label: 'Certificate', control: 'text', default: '', hint: `${cert[platform]} Blank: a variable you supply.` },
    ...(platform === 'azure' ? [{ id: 'gateway_subnet_cidr', label: 'Application Gateway subnet', control: 'text'         , default: '10.40.250.0/24', hint: 'A free range of the network for the gateway\'s own subnet (layer 7 only).' }] : []),
    ...(platform === 'google' ? [{ id: 'proxy_subnet_cidr', label: 'Proxy-only subnet', control: 'text'         , default: '10.40.251.0/24', hint: 'Internal layer 7 only: the region\'s proxy-only subnet range (one per network and region).' }] : []),
    ...(platform === 'vsphere'
      ? [
          { id: 'avi_cloud', label: 'Avi cloud', control: 'text'         , default: 'Default-Cloud' },
          { id: 'se_group', label: 'Service Engine group', control: 'text'         , default: 'Default-Group' },
          { id: 'vip_v4', label: 'VIP (IPv4)', control: 'text'         , default: '10.50.10.100' },
          { id: 'vip_v6', label: 'VIP (IPv6)', control: 'text'         , default: 'fd00:50:10::100', hint: 'Blank for IPv4 only.' },
        ]
      : [LANDING_ZONE_SOURCE]),
  ];
}

                
                        
                           
                        
                             
                       
                              
                        
                                
                               
                                                     
                              
                                                        
                                      
                                    
                        
                               
 

function specOf(values                 , findings           )       {
  const l7 = valueOf(values, 'lb', 'l7') !== 'l4';
  const backendPort = numberOf(values, 'backend_port', 443);
  const bp = valueOf(values, 'backend_protocol', 'https');
  const waf = yes(valueOf(values, 'waf', 'no'));
  if (waf && !l7) findings.push(warning('tf.app.ingress-waf-l4', 'A web application firewall inspects HTTP: it is not attached to a layer 4 load balancer.', { path: 'waf' }));
  const zone = valueOf(values, 'dns_zone').replace(/\.$/, '');
  const fqdns = listOf(values, 'fqdns').map((f) => f.replace(/\.$/, ''));
  for (const f of fqdns) {
    if (zone && f !== zone && !f.endsWith(`.${zone}`)) findings.push(warning('tf.app.ingress-fqdn-zone', `${f} is not in ${zone}; no record is written for it.`, { path: 'fqdns' }));
  }
  const persistence = valueOf(values, 'persistence', 'none');
  return {
    app: appOf(values),
    network: rname(valueOf(values, 'network', 'prod')),
    tier: valueOf(values, 'tier', 'web'),
    internal: valueOf(values, 'exposure', 'internal') !== 'public',
    l7,
    terminate: valueOf(values, 'tls', 'terminate') === 'terminate',
    waf: waf && l7,
    listenerPort: numberOf(values, 'listener_port', 443),
    backendPort,
    backendProtocol: bp === 'http' || bp === 'tcp' ? bp : 'https',
    healthPath: valueOf(values, 'health_path', '/'),
    persistence: persistence === 'source-ip' || persistence === 'cookie' ? persistence : 'none',
    members: parseMembers(valueOf(values, 'members'), backendPort, findings),
    fqdns: zone ? fqdns.filter((f) => f === zone || f.endsWith(`.${zone}`)) : [],
    zone,
    certificate: valueOf(values, 'certificate'),
  };
}

/** The record name of an FQDN inside its zone (`@` for the apex). */
const relative = (fqdn        , zone        )         => (fqdn === zone ? '@' : fqdn.slice(0, -(zone.length + 1)));

/** The certificate expression: the input, else a variable (a reference, not a secret). */
function certificateRef(s      , blocks            , what        )         {
  if (s.certificate) return q(s.certificate);
  const name = `${s.app.id}_ingress_certificate`;
  blocks.push(variable(name, 'string', `${what} for ${s.app.name}'s ingress (a reference to the certificate, not the key).`));
  return `var.${name}`;
}

/** A load balancer name, cut to the cloud's limit without a trailing hyphen. */
const lbName = (prefix        , max        )         => `trimsuffix(substr("${prefix}", 0, ${max}), "-")`;

// ---------------------------------------------------------------------------
// AWS
// ---------------------------------------------------------------------------

function awsIngress(values                 , findings           )             {
  const s = specOf(values, findings);
  const lz = lzRef(values);
  const pfx = namePrefix(values, s.app);
  const v6 = ipv6Of(lz, s.network);
  const tags = x(tagsExpr(s.app, 'aws'));
  const blocks             = [...preamble('aws', values)];
  const lbProtocol = s.l7 ? (s.terminate ? 'HTTPS' : 'HTTP') : s.terminate ? 'TLS' : 'TCP';
  const tgProtocol = s.l7 ? (s.backendProtocol === 'http' ? 'HTTP' : 'HTTPS') : 'TCP';
  const allV6 = s.members.length > 0 && s.members.every((m) => m.v6);
  if (s.members.some((m) => m.v6) && !allV6) findings.push(warning('tf.app.ingress-mixed-family', 'A target group holds one address family: the IPv6 members are left out (the load balancer still answers on IPv6).', { path: 'members' }));
  const members = s.members.filter((m) => m.v6 === allV6);
  const cert = s.terminate ? certificateRef(s, blocks, 'The ACM certificate ARN') : '';
  // The load balancer's own security group: the listener from where the app is used, and out to the members.
  const from = s.internal ? `${lz}.network_cidrs[${q(s.network)}]` : '["0.0.0.0/0", "::/0"]';
  blocks.push(
    res('aws_security_group', 'ingress', { name: x(`"${pfx}-ingress"`), description: `Ingress of ${s.app.name}`, vpc_id: x(`${lz}.network_ids[${q(s.network)}]`), tags }),
    res('aws_vpc_security_group_ingress_rule', 'ingress_listener', {
      for_each: x(`toset(${from})`),
      security_group_id: x('aws_security_group.ingress.id'),
      cidr_ipv4: x('strcontains(each.value, ":") ? null : each.value'),
      cidr_ipv6: x('strcontains(each.value, ":") ? each.value : null'),
      ip_protocol: 'tcp',
      from_port: s.listenerPort,
      to_port: s.listenerPort,
      description: 'The listener',
    }),
    ...(s.l7 && s.terminate && !s.internal
      ? [
          res('aws_vpc_security_group_ingress_rule', 'ingress_http', {
            for_each: x(`toset(${from})`),
            security_group_id: x('aws_security_group.ingress.id'),
            cidr_ipv4: x('strcontains(each.value, ":") ? null : each.value'),
            cidr_ipv6: x('strcontains(each.value, ":") ? each.value : null'),
            ip_protocol: 'tcp',
            from_port: 80,
            to_port: 80,
            description: 'HTTP, redirected to HTTPS',
          }),
        ]
      : []),
    res('aws_vpc_security_group_egress_rule', 'ingress_members', {
      for_each: x(`toset(${lz}.network_cidrs[${q(s.network)}])`),
      security_group_id: x('aws_security_group.ingress.id'),
      cidr_ipv4: x('strcontains(each.value, ":") ? null : each.value'),
      cidr_ipv6: x('strcontains(each.value, ":") ? each.value : null'),
      ip_protocol: 'tcp',
      from_port: 0,
      to_port: 65535,
      description: 'To the members and their health checks',
    }),
    res('aws_lb', 'ingress', {
      name: x(lbName(pfx, 32)),
      internal: s.internal,
      load_balancer_type: s.l7 ? 'application' : 'network',
      ip_address_type: x(`${v6} ? "dualstack" : "ipv4"`),
      subnets: x(subnetsOf(lz, s.network, s.tier)),
      security_groups: x('[aws_security_group.ingress.id]'),
      enable_deletion_protection: s.app.criticality === 'tier0' || s.app.criticality === 'tier1',
      drop_invalid_header_fields: s.l7 ? true : undefined,
      enable_cross_zone_load_balancing: s.l7 ? undefined : true,
      tags,
    }),
    res('aws_lb_target_group', 'ingress', {
      name: x(lbName(pfx, 32)),
      port: s.backendPort,
      protocol: tgProtocol,
      target_type: 'ip',
      ip_address_type: allV6 ? 'ipv6' : 'ipv4',
      vpc_id: x(`${lz}.network_ids[${q(s.network)}]`),
      tags,
    }, [
      blk('health_check', {
        enabled: true,
        protocol: s.l7 ? tgProtocol : s.backendProtocol === 'tcp' ? 'TCP' : s.backendProtocol.toUpperCase(),
        path: s.l7 || s.backendProtocol !== 'tcp' ? s.healthPath : undefined,
        matcher: s.l7 ? '200-399' : undefined,
        healthy_threshold: 3,
        unhealthy_threshold: 3,
        interval: 15,
      }),
      ...(s.persistence !== 'none' ? [blk('stickiness', { enabled: true, type: s.l7 ? 'lb_cookie' : 'source_ip' })] : []),
    ]),
  );
  if (!s.l7 && s.persistence === 'cookie') findings.push(info('tf.app.ingress-l4-cookie', 'A network load balancer has no cookies: persistence is by source IP.', { path: 'persistence' }));
  for (const m of members) {
    blocks.push(res('aws_lb_target_group_attachment', ident('member', m.key), { target_group_arn: x('aws_lb_target_group.ingress.arn'), target_id: m.address, port: m.port }));
  }
  blocks.push(
    res('aws_lb_listener', 'ingress', {
      load_balancer_arn: x('aws_lb.ingress.arn'),
      port: s.listenerPort,
      protocol: lbProtocol,
      ssl_policy: s.terminate ? 'ELBSecurityPolicy-TLS13-1-2-2021-06' : undefined,
      certificate_arn: s.terminate ? x(cert) : undefined,
      tags,
    }, [blk('default_action', { type: 'forward', target_group_arn: x('aws_lb_target_group.ingress.arn') })]),
  );
  if (s.l7 && s.terminate && !s.internal) {
    blocks.push(
      res('aws_lb_listener', 'redirect', { load_balancer_arn: x('aws_lb.ingress.arn'), port: 80, protocol: 'HTTP', tags }, [
        blk('default_action', { type: 'redirect' }, [blk('redirect', { port: String(s.listenerPort), protocol: 'HTTPS', status_code: 'HTTP_301' })]),
      ]),
    );
  }
  if (s.waf) {
    const rule = (name        , priority        ) =>
      blk('rule', { name, priority }, [
        blk('override_action', {}, [blk('none')]),
        blk('statement', {}, [blk('managed_rule_group_statement', { name, vendor_name: 'AWS' })]),
        blk('visibility_config', { cloudwatch_metrics_enabled: true, metric_name: name, sampled_requests_enabled: true }),
      ]);
    blocks.push(
      res('aws_wafv2_web_acl', 'ingress', { name: x(`"${pfx}-ingress"`), scope: 'REGIONAL', tags }, [
        blk('default_action', {}, [blk('allow')]),
        rule('AWSManagedRulesCommonRuleSet', 10),
        rule('AWSManagedRulesKnownBadInputsRuleSet', 20),
        rule('AWSManagedRulesAmazonIpReputationList', 30),
        blk('visibility_config', { cloudwatch_metrics_enabled: true, metric_name: x(`"${pfx}-ingress"`), sampled_requests_enabled: true }),
      ]),
      res('aws_wafv2_web_acl_association', 'ingress', { resource_arn: x('aws_lb.ingress.arn'), web_acl_arn: x('aws_wafv2_web_acl.ingress.arn') }),
    );
  }
  if (s.fqdns.length > 0) {
    blocks.push(dat('aws_route53_zone', 'ingress', { name: s.zone, private_zone: s.internal }));
    const alias = blk('alias', { name: x('aws_lb.ingress.dns_name'), zone_id: x('aws_lb.ingress.zone_id'), evaluate_target_health: true });
    blocks.push(
      res('aws_route53_record', 'ingress_a', { for_each: x(`toset(${hcl(s.fqdns)})`), zone_id: x('data.aws_route53_zone.ingress.zone_id'), name: x('each.value'), type: 'A' }, [alias]),
      res('aws_route53_record', 'ingress_aaaa', { for_each: x(`${v6} ? toset(${hcl(s.fqdns)}) : toset([])`), zone_id: x('data.aws_route53_zone.ingress.zone_id'), name: x('each.value'), type: 'AAAA' }, [alias]),
    );
  }
  blocks.push(
    output('dns_name', 'aws_lb.ingress.dns_name', 'The load balancer\'s own name, for a CNAME where the zone is not in Route 53.'),
    output('lb_arn', 'aws_lb.ingress.arn'),
    output('target_group_arn', 'aws_lb_target_group.ingress.arn'),
  );
  return blocks;
}

// ---------------------------------------------------------------------------
// Azure
// ---------------------------------------------------------------------------

function azureIngress(values                 , findings           )             {
  const s = specOf(values, findings);
  const lz = lzRef(values);
  const pfx = namePrefix(values, s.app);
  const v6 = ipv6Of(lz, s.network);
  const tags = x(tagsExpr(s.app, 'azure'));
  const rg = `${lz}.resource_group[${q(s.network)}]`;
  const blocks             = [...preamble('azure', values)];
  const v4Members = s.members.filter((m) => !m.v6);
  const v6Members = s.members.filter((m) => m.v6);
  let v4Address = '';
  let v6Address = '';
  if (s.l7) {
    const subnetCidr = valueOf(values, 'gateway_subnet_cidr', '10.40.250.0/24');
    if (familyOf(subnetCidr) !== 4 || !subnetCidr.includes('/')) findings.push(error('tf.app.ingress-appgw-subnet', `"${subnetCidr}" is not an IPv4 range for the Application Gateway subnet.`, { path: 'gateway_subnet_cidr' }));
    const cert = s.terminate ? certificateRef(s, blocks, 'The Key Vault secret id of the certificate') : '';
    const sku = s.waf ? 'WAF_v2' : 'Standard_v2';
    blocks.push(
      res('azurerm_subnet', 'appgw', {
        name: x(`"${pfx}-appgw"`),
        resource_group_name: x(rg),
        virtual_network_name: x(`${lz}.network_names[${q(s.network)}]`),
        address_prefixes: [subnetCidr],
      }, [], 'An Application Gateway has a subnet of its own.'),
      res('azurerm_public_ip', 'appgw', {
        name: x(`"${pfx}-appgw"`),
        resource_group_name: x(rg),
        location: x(`${lz}.location`),
        allocation_method: 'Static',
        sku: 'Standard',
        zones: x(`${lz}.zones`),
        tags,
      }, [], s.internal ? 'Application Gateway v2 has a public frontend address even when only its private frontend listens.' : undefined),
    );
    if (s.waf) {
      blocks.push(
        res('azurerm_web_application_firewall_policy', 'ingress', { name: x(`"${pfx}-waf"`), resource_group_name: x(rg), location: x(`${lz}.location`), tags }, [
          blk('policy_settings', { enabled: true, mode: 'Prevention', request_body_check: true }),
          blk('managed_rules', {}, [blk('managed_rule_set', { type: 'Microsoft_DefaultRuleSet', version: '2.1' }), blk('managed_rule_set', { type: 'Microsoft_BotManagerRuleSet', version: '1.1' })]),
        ]),
      );
    }
    const httpsBackend = s.backendProtocol === 'https';
    const fe = s.internal ? 'private' : 'public';
    const privateIp = `cidrhost(${q(subnetCidr)}, 10)`;
    blocks.push(
      res('azurerm_application_gateway', 'ingress', {
        name: x(`"${pfx}-appgw"`),
        resource_group_name: x(rg),
        location: x(`${lz}.location`),
        zones: x(`${lz}.zones`),
        http2_enabled: true,
        firewall_policy_id: s.waf ? x('azurerm_web_application_firewall_policy.ingress.id') : undefined,
        tags,
      }, [
        blk('sku', { name: sku, tier: sku }),
        blk('autoscale_configuration', { min_capacity: s.app.criticality === 'tier0' || s.app.criticality === 'tier1' ? 2 : 1, max_capacity: 10 }),
        ...(s.terminate ? [blk('identity', { type: 'UserAssigned', identity_ids: x(`[${lz}.identity_id]`) })] : []),
        blk('gateway_ip_configuration', { name: 'gateway', subnet_id: x('azurerm_subnet.appgw.id') }),
        blk('frontend_ip_configuration', { name: 'public', public_ip_address_id: x('azurerm_public_ip.appgw.id') }),
        ...(s.internal ? [blk('frontend_ip_configuration', { name: 'private', subnet_id: x('azurerm_subnet.appgw.id'), private_ip_address_allocation: 'Static', private_ip_address: x(privateIp) })] : []),
        blk('frontend_port', { name: 'listener', port: s.listenerPort }),
        ...(s.terminate ? [blk('ssl_certificate', { name: 'ingress', key_vault_secret_id: x(cert) })] : []),
        blk('ssl_policy', { policy_type: 'Predefined', policy_name: 'AppGwSslPolicy20220101' }),
        blk('backend_address_pool', { name: 'members', ip_addresses: s.members.map((m) => m.address) }),
        blk('probe', {
          name: 'health',
          protocol: httpsBackend ? 'Https' : 'Http',
          path: s.healthPath,
          interval: 15,
          timeout: 10,
          unhealthy_threshold: 3,
          pick_host_name_from_backend_http_settings: true,
        }, [blk('match', { status_code: ['200-399'] })]),
        blk('backend_http_settings', {
          name: 'members',
          port: s.backendPort,
          protocol: httpsBackend ? 'Https' : 'Http',
          cookie_based_affinity: s.persistence === 'cookie' ? 'Enabled' : 'Disabled',
          request_timeout: 60,
          probe_name: 'health',
          pick_host_name_from_backend_address: s.fqdns.length === 0,
          host_name: s.fqdns[0],
        }),
        blk('http_listener', {
          name: 'listener',
          frontend_ip_configuration_name: fe,
          frontend_port_name: 'listener',
          protocol: s.terminate ? 'Https' : 'Http',
          ssl_certificate_name: s.terminate ? 'ingress' : undefined,
        }),
        blk('request_routing_rule', { name: 'members', priority: 100, rule_type: 'Basic', http_listener_name: 'listener', backend_address_pool_name: 'members', backend_http_settings_name: 'members' }),
      ]),
    );
    if (v6Members.length > 0) findings.push(info('tf.app.ingress-appgw-v6-members', 'The Application Gateway reaches its members over IPv4 here; the IPv6 member addresses are in the pool as given.', { path: 'members' }));
    findings.push(info('tf.app.ingress-appgw-ipv6', 'Application Gateway v2 is written with an IPv4 frontend. An IPv6 frontend needs a dual-stack gateway subnet and an IPv6 public address; Azure documents it for v2 SKUs (verify the region and the provider\'s support before adding it).', { source: 'https://learn.microsoft.com/en-us/azure/application-gateway/ipv6-application-gateway-portal' }));
    v4Address = s.internal ? privateIp : 'azurerm_public_ip.appgw.ip_address';
  } else {
    // Standard load balancer, dual-stack frontends on a dual-stack network.
    const frontends             = [];
    if (s.internal) {
      frontends.push(blk('frontend_ip_configuration', { name: 'v4', subnet_id: x(subnetOf(lz, s.network, s.tier)), private_ip_address_allocation: 'Dynamic', private_ip_address_version: 'IPv4', zones: x(`${lz}.zones`) }));
      frontends.push({
        type: 'dynamic',
        labels: ['frontend_ip_configuration'],
        attributes: attrs({ for_each: x(`${v6} ? ["v6"] : []`) }),
        blocks: [blk('content', { name: 'v6', subnet_id: x(subnetOf(lz, s.network, s.tier)), private_ip_address_allocation: 'Dynamic', private_ip_address_version: 'IPv6', zones: x(`${lz}.zones`) })],
      });
    } else {
      blocks.push(
        res('azurerm_public_ip', 'lb_v4', { name: x(`"${pfx}-lb-v4"`), resource_group_name: x(rg), location: x(`${lz}.location`), allocation_method: 'Static', sku: 'Standard', ip_version: 'IPv4', zones: x(`${lz}.zones`), tags }),
        res('azurerm_public_ip', 'lb_v6', { count: x(`${v6} ? 1 : 0`), name: x(`"${pfx}-lb-v6"`), resource_group_name: x(rg), location: x(`${lz}.location`), allocation_method: 'Static', sku: 'Standard', ip_version: 'IPv6', zones: x(`${lz}.zones`), tags }),
      );
      frontends.push(blk('frontend_ip_configuration', { name: 'v4', public_ip_address_id: x('azurerm_public_ip.lb_v4.id') }));
      frontends.push({
        type: 'dynamic',
        labels: ['frontend_ip_configuration'],
        attributes: attrs({ for_each: x('azurerm_public_ip.lb_v6[*].id') }),
        blocks: [blk('content', { name: 'v6', public_ip_address_id: x('frontend_ip_configuration.value') })],
      });
    }
    blocks.push(
      res('azurerm_lb', 'ingress', { name: x(`"${pfx}-lb"`), resource_group_name: x(rg), location: x(`${lz}.location`), sku: 'Standard', sku_tier: 'Regional', tags }, frontends),
      res('azurerm_lb_backend_address_pool', 'v4', { name: 'members-v4', loadbalancer_id: x('azurerm_lb.ingress.id') }),
      res('azurerm_lb_backend_address_pool', 'v6', { count: x(`${v6} ? 1 : 0`), name: 'members-v6', loadbalancer_id: x('azurerm_lb.ingress.id') }),
      res('azurerm_lb_probe', 'ingress', {
        name: 'health',
        loadbalancer_id: x('azurerm_lb.ingress.id'),
        protocol: s.backendProtocol === 'tcp' ? 'Tcp' : s.backendProtocol === 'http' ? 'Http' : 'Https',
        port: s.backendPort,
        request_path: s.backendProtocol === 'tcp' ? undefined : s.healthPath,
        interval_in_seconds: 15,
        number_of_probes: 2,
      }),
    );
    for (const m of v4Members) {
      blocks.push(res('azurerm_lb_backend_address_pool_address', ident('member', m.key), { name: m.key, backend_address_pool_id: x('azurerm_lb_backend_address_pool.v4.id'), virtual_network_id: x(`${lz}.network_ids[${q(s.network)}]`), ip_address: m.address }));
    }
    for (const m of v6Members) {
      blocks.push(res('azurerm_lb_backend_address_pool_address', ident('member', m.key), { count: x(`${v6} ? 1 : 0`), name: m.key, backend_address_pool_id: x('azurerm_lb_backend_address_pool.v6[0].id'), virtual_network_id: x(`${lz}.network_ids[${q(s.network)}]`), ip_address: m.address }));
    }
    const rule = (fe        , pool        ) => ({
      loadbalancer_id: x('azurerm_lb.ingress.id'),
      frontend_ip_configuration_name: fe,
      backend_address_pool_ids: x(`[${pool}]`),
      probe_id: x('azurerm_lb_probe.ingress.id'),
      protocol: 'Tcp',
      frontend_port: s.listenerPort,
      backend_port: s.backendPort,
      load_distribution: s.persistence === 'none' ? 'Default' : 'SourceIP',
      disable_outbound_snat: true,
      idle_timeout_in_minutes: 4,
    });
    blocks.push(
      res('azurerm_lb_rule', 'v4', { name: 'listener-v4', ...rule('v4', 'azurerm_lb_backend_address_pool.v4.id') }),
      res('azurerm_lb_rule', 'v6', { count: x(`${v6} ? 1 : 0`), name: 'listener-v6', ...rule('v6', 'azurerm_lb_backend_address_pool.v6[0].id') }),
    );
    if (s.terminate) findings.push(info('tf.app.ingress-l4-tls', 'An Azure load balancer does not terminate TLS: the servers keep their certificates (pass-through).', { path: 'tls' }));
    v4Address = s.internal ? 'azurerm_lb.ingress.frontend_ip_configuration[0].private_ip_address' : 'azurerm_public_ip.lb_v4.ip_address';
    v6Address = s.internal ? `one([for f in azurerm_lb.ingress.frontend_ip_configuration : f.private_ip_address if f.name == "v6"])` : 'one(azurerm_public_ip.lb_v6[*].ip_address)';
  }
  if (s.fqdns.length > 0) {
    const zoneRg = valueOf(values, 'dns_resource_group') ? q(valueOf(values, 'dns_resource_group')) : `${lz}.resource_group["shared"]`;
    const names = hcl(Object.fromEntries(s.fqdns.map((f) => [f, relative(f, s.zone)])));
    const kind = s.internal ? 'azurerm_private_dns' : 'azurerm_dns';
    // A private zone's records name the zone by id; a public zone's by name and resource group.
    const zoneOf = s.internal ? { private_dns_zone_id: x('data.azurerm_private_dns_zone.ingress.id') } : { zone_name: s.zone, resource_group_name: x(zoneRg) };
    if (s.internal) blocks.push(dat('azurerm_private_dns_zone', 'ingress', { name: s.zone, resource_group_name: x(zoneRg) }));
    blocks.push(res(`${kind}_a_record`, 'ingress', { for_each: x(names), name: x('each.value'), ...zoneOf, ttl: 300, records: x(`[${v4Address}]`), tags }));
    if (v6Address) {
      blocks.push(res(`${kind}_aaaa_record`, 'ingress', { for_each: x(`${v6} ? ${names} : {}`), name: x('each.value'), ...zoneOf, ttl: 300, records: x(`[${v6Address}]`), tags }));
    }
  }
  blocks.push(output('address', v4Address, 'The ingress address (IPv4).'));
  if (v6Address) blocks.push(output('address_v6', `${v6} ? ${v6Address} : null`, 'The ingress address (IPv6), on a dual-stack network.'));
  return blocks;
}

// ---------------------------------------------------------------------------
// Google Cloud (GCP)
// ---------------------------------------------------------------------------

function googleIngress(values                 , findings           )             {
  const s = specOf(values, findings);
  const lz = lzRef(values);
  const pfx = namePrefix(values, s.app);
  const v6 = ipv6Of(lz, s.network);
  const labels = x(tagsExpr(s.app, 'google'));
  const project = `${lz}.project`;
  const network = `${lz}.network_ids[${q(s.network)}]`;
  const subnet = subnetOf(lz, s.network, s.tier);
  const blocks             = [...preamble('google', values)];
  const zones = [...new Set(s.members.map((m) => m.zoneIndex))].sort();
  const passthrough = !s.l7;
  const negType = passthrough ? 'GCE_VM_IP' : 'GCE_VM_IP_PORT';
  // One zonal NEG per zone the members are in.
  for (const zi of zones) {
    blocks.push(
      res('google_compute_network_endpoint_group', `z${zi}`, {
        name: x(`"${pfx}-neg-${'abc'[zi]}"`),
        project: x(project),
        network: x(network),
        subnetwork: x(subnet),
        zone: x(`${lz}.zones[${zi}]`),
        network_endpoint_type: negType,
        default_port: passthrough ? undefined : s.backendPort,
      }),
    );
  }
  for (const m of s.members) {
    blocks.push(
      res('google_compute_network_endpoint', ident('member', m.key), {
        project: x(project),
        zone: x(`${lz}.zones[${m.zoneIndex}]`),
        network_endpoint_group: x(`google_compute_network_endpoint_group.z${m.zoneIndex}.name`),
        instance: m.server,
        ip_address: m.address,
        port: passthrough ? undefined : m.port,
      }),
    );
    if (m.v6) findings.push(warning('tf.app.ingress-gcp-v6-endpoint', `${m.server}: a NEG endpoint is the VM's primary IPv4 address; its IPv6 address ${m.address} is not one.`, { path: 'members' }));
  }
  const backends = zones.map((zi) => blk('backend', { group: x(`google_compute_network_endpoint_group.z${zi}.id`), balancing_mode: passthrough ? 'CONNECTION' : 'RATE', max_rate_per_endpoint: passthrough ? undefined : 1000 }));
  const hcProtocol = s.backendProtocol;
  const hcBlock = (kind        ) =>
    kind === 'tcp' ? blk('tcp_health_check', { port: s.backendPort }) : blk(`${kind}_health_check`, { port: s.backendPort, request_path: s.healthPath });
  const armor = ()                     => {
    if (!s.waf) return undefined;
    blocks.push(
      res('google_compute_security_policy', 'ingress', { name: x(`"${pfx}-armor"`), project: x(project), description: `WAF of ${s.app.name}` }, [
        ...['sqli-v33-stable', 'xss-v33-stable', 'lfi-v33-stable', 'rce-v33-stable'].map((rule, i) =>
          blk('rule', { action: 'deny(403)', priority: 1000 + i * 10, description: `Preconfigured WAF: ${rule}` }, [blk('match', {}, [blk('expr', { expression: `evaluatePreconfiguredWaf('${rule}')` })])]),
        ),
        blk('rule', { action: 'allow', priority: 2147483647, description: 'Default: allow' }, [blk('match', { versioned_expr: 'SRC_IPS_V1' }, [blk('config', { src_ip_ranges: ['*'] })])]),
      ]),
    );
    return 'google_compute_security_policy.ingress.id';
  };
  let v4Address = '';
  let v6Address = '';
  if (s.l7 && !s.internal) {
    // Global external Application load balancer, dual-stack by two forwarding rules.
    blocks.push(
      res('google_compute_global_address', 'v4', { name: x(`"${pfx}-v4"`), project: x(project), ip_version: 'IPV4' }),
      res('google_compute_global_address', 'v6', { name: x(`"${pfx}-v6"`), project: x(project), ip_version: 'IPV6' }),
      res('google_compute_health_check', 'ingress', { name: x(`"${pfx}-hc"`), project: x(project), check_interval_sec: 15, timeout_sec: 5 }, [hcBlock(hcProtocol), blk('log_config', { enable: true })]),
    );
    const policy = armor();
    blocks.push(
      res('google_compute_backend_service', 'ingress', {
        name: x(`"${pfx}-be"`),
        project: x(project),
        load_balancing_scheme: 'EXTERNAL_MANAGED',
        protocol: s.backendProtocol === 'http' ? 'HTTP' : 'HTTPS',
        health_checks: x('[google_compute_health_check.ingress.id]'),
        security_policy: policy ? x(policy) : undefined,
        session_affinity: s.persistence === 'cookie' ? 'GENERATED_COOKIE' : s.persistence === 'source-ip' ? 'CLIENT_IP' : 'NONE',
      }, [...backends, blk('log_config', { enable: true, sample_rate: 1 })]),
      res('google_compute_url_map', 'ingress', { name: x(`"${pfx}-map"`), project: x(project), default_service: x('google_compute_backend_service.ingress.id') }),
    );
    let proxy        ;
    if (s.terminate) {
      let cert        ;
      if (s.certificate === '' && s.fqdns.length > 0) {
        blocks.push(res('google_compute_managed_ssl_certificate', 'ingress', { name: x(`"${pfx}-cert"`), project: x(project) }, [blk('managed', { domains: [...s.fqdns] })]));
        cert = 'google_compute_managed_ssl_certificate.ingress.id';
      } else cert = certificateRef(s, blocks, 'The SSL certificate self link');
      blocks.push(res('google_compute_target_https_proxy', 'ingress', { name: x(`"${pfx}-proxy"`), project: x(project), url_map: x('google_compute_url_map.ingress.id'), ssl_certificates: x(`[${cert}]`) }));
      proxy = 'google_compute_target_https_proxy.ingress.id';
    } else {
      blocks.push(res('google_compute_target_http_proxy', 'ingress', { name: x(`"${pfx}-proxy"`), project: x(project), url_map: x('google_compute_url_map.ingress.id') }));
      proxy = 'google_compute_target_http_proxy.ingress.id';
    }
    for (const fam of ['v4', 'v6']) {
      blocks.push(
        res('google_compute_global_forwarding_rule', fam, {
          name: x(`"${pfx}-${fam}"`),
          project: x(project),
          load_balancing_scheme: 'EXTERNAL_MANAGED',
          ip_address: x(`google_compute_global_address.${fam}.id`),
          ip_protocol: 'TCP',
          port_range: String(s.listenerPort),
          target: x(proxy),
          labels,
        }),
      );
    }
    v4Address = 'google_compute_global_address.v4.address';
    v6Address = 'google_compute_global_address.v6.address';
  } else if (s.l7) {
    // Regional internal Application load balancer: Envoy proxies in the region's proxy-only subnet.
    const proxyCidr = valueOf(values, 'proxy_subnet_cidr', '10.40.251.0/24');
    blocks.push(
      res('google_compute_subnetwork', 'proxy_only', {
        name: x(`"${pfx}-proxy-only"`),
        project: x(project),
        region: x(`${lz}.region`),
        network: x(network),
        ip_cidr_range: proxyCidr,
        purpose: 'REGIONAL_MANAGED_PROXY',
        role: 'ACTIVE',
      }, [], 'One proxy-only subnet per network and region: if the region has one already, remove this and keep the depends_on pointing at it.'),
      res('google_compute_region_health_check', 'ingress', { name: x(`"${pfx}-hc"`), project: x(project), region: x(`${lz}.region`), check_interval_sec: 15, timeout_sec: 5 }, [hcBlock(hcProtocol), blk('log_config', { enable: true })]),
      res('google_compute_region_backend_service', 'ingress', {
        name: x(`"${pfx}-be"`),
        project: x(project),
        region: x(`${lz}.region`),
        load_balancing_scheme: 'INTERNAL_MANAGED',
        protocol: s.backendProtocol === 'http' ? 'HTTP' : 'HTTPS',
        health_checks: x('[google_compute_region_health_check.ingress.id]'),
        session_affinity: s.persistence === 'cookie' ? 'GENERATED_COOKIE' : s.persistence === 'source-ip' ? 'CLIENT_IP' : 'NONE',
      }, [...backends.map((b) => ({ ...b, attributes: [...(b.attributes ?? []), { name: 'capacity_scaler', value: x('1') }] })), blk('log_config', { enable: true, sample_rate: 1 })]),
      res('google_compute_region_url_map', 'ingress', { name: x(`"${pfx}-map"`), project: x(project), region: x(`${lz}.region`), default_service: x('google_compute_region_backend_service.ingress.id') }),
    );
    let proxy        ;
    if (s.terminate) {
      const cert = certificateRef(s, blocks, 'The regional SSL certificate self link');
      blocks.push(res('google_compute_region_target_https_proxy', 'ingress', { name: x(`"${pfx}-proxy"`), project: x(project), region: x(`${lz}.region`), url_map: x('google_compute_region_url_map.ingress.id'), ssl_certificates: x(`[${cert}]`) }));
      proxy = 'google_compute_region_target_https_proxy.ingress.id';
    } else {
      blocks.push(res('google_compute_region_target_http_proxy', 'ingress', { name: x(`"${pfx}-proxy"`), project: x(project), region: x(`${lz}.region`), url_map: x('google_compute_region_url_map.ingress.id') }));
      proxy = 'google_compute_region_target_http_proxy.ingress.id';
    }
    blocks.push(
      res('google_compute_forwarding_rule', 'v4', {
        name: x(`"${pfx}-v4"`),
        project: x(project),
        region: x(`${lz}.region`),
        load_balancing_scheme: 'INTERNAL_MANAGED',
        network: x(network),
        subnetwork: x(subnet),
        ip_protocol: 'TCP',
        port_range: String(s.listenerPort),
        target: x(proxy),
        labels,
        depends_on: x('[google_compute_subnetwork.proxy_only]'),
      }),
    );
    if (s.waf) findings.push(info('tf.app.ingress-gcp-internal-waf', 'Cloud Armor policies attach to external load balancers; an internal Application load balancer has no WAF here.', { path: 'waf' }));
    findings.push(info('tf.app.ingress-gcp-internal-v6', 'The regional internal Application load balancer is written with an IPv4 frontend (IPv6 frontends for it are not written here; verify their availability in the region).', { source: 'https://cloud.google.com/load-balancing/docs/l7-internal' }));
    v4Address = 'google_compute_forwarding_rule.v4.ip_address';
  } else {
    // Passthrough network load balancer (layer 4), internal or external, dual-stack by a second forwarding rule.
    const scheme = s.internal ? 'INTERNAL' : 'EXTERNAL';
    blocks.push(
      res('google_compute_region_health_check', 'ingress', { name: x(`"${pfx}-hc"`), project: x(project), region: x(`${lz}.region`), check_interval_sec: 15, timeout_sec: 5 }, [hcBlock(s.backendProtocol === 'tcp' ? 'tcp' : s.backendProtocol), blk('log_config', { enable: true })]),
      res('google_compute_region_backend_service', 'ingress', {
        name: x(`"${pfx}-be"`),
        project: x(project),
        region: x(`${lz}.region`),
        load_balancing_scheme: scheme,
        protocol: 'TCP',
        health_checks: x('[google_compute_region_health_check.ingress.id]'),
        session_affinity: s.persistence === 'none' ? 'NONE' : 'CLIENT_IP',
      }, backends),
    );
    for (const fam of ['v4', 'v6']) {
      blocks.push(
        res('google_compute_forwarding_rule', fam, {
          count: fam === 'v6' ? x(`${v6} ? 1 : 0`) : undefined,
          name: x(`"${pfx}-${fam}"`),
          project: x(project),
          region: x(`${lz}.region`),
          load_balancing_scheme: scheme,
          network: s.internal ? x(network) : undefined,
          subnetwork: s.internal || fam === 'v6' ? x(subnet) : undefined,
          ip_version: fam === 'v6' ? 'IPV6' : 'IPV4',
          ip_protocol: 'TCP',
          ports: [String(s.listenerPort)],
          backend_service: x('google_compute_region_backend_service.ingress.id'),
          labels,
        }),
      );
    }
    if (s.terminate) findings.push(info('tf.app.ingress-l4-tls', 'A passthrough network load balancer does not terminate TLS: the servers keep their certificates.', { path: 'tls' }));
    v4Address = 'google_compute_forwarding_rule.v4.ip_address';
    v6Address = 'one(google_compute_forwarding_rule.v6[*].ip_address)';
  }
  if (s.fqdns.length > 0) {
    const zoneName = rname(s.zone);
    blocks.push(
      res('google_dns_record_set', 'ingress_a', { for_each: x(`toset(${hcl(s.fqdns)})`), project: x(project), managed_zone: zoneName, name: x('"${each.value}."'), type: 'A', ttl: 300, rrdatas: x(`[${v4Address}]`) }, [], `Cloud DNS zone "${zoneName}" holds ${s.zone}.`),
    );
    if (v6Address) {
      const cond = s.l7 && !s.internal ? `toset(${hcl(s.fqdns)})` : `${v6} ? toset(${hcl(s.fqdns)}) : toset([])`;
      // An IPv6 forwarding rule's address is written as a range (…/96): the record takes the address.
      blocks.push(res('google_dns_record_set', 'ingress_aaaa', { for_each: x(cond), project: x(project), managed_zone: zoneName, name: x('"${each.value}."'), type: 'AAAA', ttl: 300, rrdatas: x(`[split("/", ${v6Address})[0]]`) }));
    }
  }
  blocks.push(output('address', v4Address, 'The ingress address (IPv4).'));
  if (v6Address) blocks.push(output('address_v6', v6Address, 'The ingress address (IPv6).'));
  return blocks;
}

// ---------------------------------------------------------------------------
// OCI
// ---------------------------------------------------------------------------

function ociIngress(values                 , findings           )             {
  const s = specOf(values, findings);
  const lz = lzRef(values);
  const pfx = namePrefix(values, s.app);
  const v6 = ipv6Of(lz, s.network);
  const tags = x(tagsExpr(s.app, 'oci'));
  const comp = `${lz}.compartment_id`;
  const blocks             = [...preamble('oci', values)];
  const listenerProtocol = s.l7 ? 'HTTP' : 'TCP';
  blocks.push(
    res('oci_load_balancer_load_balancer', 'ingress', {
      compartment_id: x(comp),
      display_name: x(`"${pfx}-lb"`),
      shape: 'flexible',
      subnet_ids: x(`[${subnetOf(lz, s.network, s.tier)}]`),
      is_private: s.internal,
      ip_mode: x(`${v6} ? "IPV6" : "IPV4"`),
      network_security_group_ids: x(`[${securityGroupOf(lz, s.network, s.tier)}]`),
      is_delete_protection_enabled: s.app.criticality === 'tier0' || s.app.criticality === 'tier1',
      freeform_tags: tags,
    }, [blk('shape_details', { minimum_bandwidth_in_mbps: 10, maximum_bandwidth_in_mbps: s.app.criticality === 'tier0' ? 1000 : 100 })]),
    res('oci_load_balancer_backend_set', 'ingress', {
      load_balancer_id: x('oci_load_balancer_load_balancer.ingress.id'),
      name: 'members',
      policy: 'LEAST_CONNECTIONS',
    }, [
      blk('health_checker', {
        protocol: s.backendProtocol === 'tcp' || !s.l7 ? 'TCP' : 'HTTP',
        port: s.backendPort,
        url_path: s.backendProtocol === 'tcp' || !s.l7 ? undefined : s.healthPath,
        return_code: s.backendProtocol === 'tcp' || !s.l7 ? undefined : 200,
        interval_ms: 15000,
        retries: 3,
      }),
      ...(s.l7 && s.persistence === 'cookie' ? [blk('lb_cookie_session_persistence_configuration', { cookie_name: 'X-Oracle-BMC-LBS-Route', is_secure: true, is_http_only: true })] : []),
      ...(s.l7 && s.backendProtocol === 'https' ? [blk('ssl_configuration', { protocols: ['TLSv1.2', 'TLSv1.3'], verify_peer_certificate: false })] : []),
    ]),
  );
  if (s.persistence === 'source-ip') findings.push(info('tf.app.ingress-oci-source-ip', 'OCI load balancer persistence is by cookie; source-IP affinity is the IP_HASH policy, which is not written here.', { path: 'persistence' }));
  for (const m of s.members) {
    blocks.push(res('oci_load_balancer_backend', ident('member', m.key), { load_balancer_id: x('oci_load_balancer_load_balancer.ingress.id'), backendset_name: x('oci_load_balancer_backend_set.ingress.name'), ip_address: m.address, port: m.port }));
  }
  const cert = s.terminate && s.l7 ? certificateRef(s, blocks, 'The OCI certificate OCID') : '';
  blocks.push(
    res('oci_load_balancer_listener', 'ingress', {
      load_balancer_id: x('oci_load_balancer_load_balancer.ingress.id'),
      name: 'listener',
      default_backend_set_name: x('oci_load_balancer_backend_set.ingress.name'),
      port: s.listenerPort,
      protocol: listenerProtocol,
    }, cert ? [blk('ssl_configuration', { certificate_ids: x(`[${cert}]`), protocols: ['TLSv1.2', 'TLSv1.3'], verify_peer_certificate: false })] : []),
  );
  if (s.terminate && !s.l7) findings.push(info('tf.app.ingress-l4-tls', 'A layer 4 listener passes TLS through: the servers keep their certificates.', { path: 'tls' }));
  if (s.waf) {
    blocks.push(
      res('oci_waf_web_app_firewall_policy', 'ingress', { compartment_id: x(comp), display_name: x(`"${pfx}-waf"`), freeform_tags: tags }, [
        blk('actions', { name: 'allow', type: 'ALLOW' }),
        blk('actions', { name: 'block', type: 'RETURN_HTTP_RESPONSE', code: 403 }),
        blk('request_protection', {}, [
          blk('rules', { name: 'owasp', type: 'PROTECTION', action_name: 'block', is_body_inspection_enabled: true }, [
            blk('protection_capabilities', { key: '9300000', version: 1 }),
            blk('protection_capabilities', { key: '9410000', version: 1 }),
            blk('protection_capabilities', { key: '941140', version: 1 }),
          ]),
        ]),
      ]),
      res('oci_waf_web_app_firewall', 'ingress', {
        compartment_id: x(comp),
        display_name: x(`"${pfx}-waf"`),
        backend_type: 'LOAD_BALANCER',
        load_balancer_id: x('oci_load_balancer_load_balancer.ingress.id'),
        web_app_firewall_policy_id: x('oci_waf_web_app_firewall_policy.ingress.id'),
        freeform_tags: tags,
      }),
    );
    findings.push(info('tf.app.ingress-oci-waf-capabilities', 'The OCI WAF protection capability keys (9300000 collaborative, 9410000 XSS, 941140) are from the OCI WAF capability list: check them against the tenancy\'s list before applying.', { source: 'https://docs.oracle.com/en-us/iaas/Content/WAF/Policies/protections.htm' }));
  }
  if (s.fqdns.length > 0) {
    const view = valueOf(values, 'dns_view_id');
    const addrs = (family             ) => `[for d in oci_load_balancer_load_balancer.ingress.ip_address_details : d.ip_address if ${family === 'v6' ? '' : '!'}strcontains(d.ip_address, ":")]`;
    for (const [rtype, fam] of [['A', 'v4'], ['AAAA', 'v6']]         ) {
      blocks.push(
        res('oci_dns_rrset', `ingress_${rtype.toLowerCase()}`, {
          for_each: x(fam === 'v6' ? `${v6} ? toset(${hcl(s.fqdns)}) : toset([])` : `toset(${hcl(s.fqdns)})`),
          zone_name_or_id: s.zone,
          domain: x('each.value'),
          rtype,
          view_id: s.internal && view ? view : undefined,
        }, [
          {
            type: 'dynamic',
            labels: ['items'],
            attributes: attrs({ for_each: x(addrs(fam)) }),
            blocks: [blk('content', { domain: x('each.value'), rdata: x('items.value'), rtype, ttl: 300 })],
          },
        ]),
      );
    }
    if (s.internal && !view) findings.push(warning('tf.app.ingress-oci-view', 'An internal ingress\'s records go in a private zone: give the private DNS view OCID, or the records are written to a public zone of that name.', { path: 'dns_view_id' }));
  }
  blocks.push(output('addresses', 'oci_load_balancer_load_balancer.ingress.ip_address_details[*].ip_address', 'The load balancer\'s addresses (IPv4, and IPv6 in IPv6 mode).'));
  return blocks;
}

// ---------------------------------------------------------------------------
// VCF (Avi Load Balancer)
// ---------------------------------------------------------------------------

const AVI = CATALOG_DATA.avi                                       ;
const aviVersion = ()         => `~> ${AVI.version.split('.').slice(0, 2).join('.')}`;

const aviIp = (block        , addr        )           => blk(block, { addr, type: familyOf(addr) === 6 ? 'V6' : 'V4' });

function vsphereIngress(values                 , findings           )             {
  const s = specOf(values, findings);
  const name = rname(s.app.slug, 'ingress');
  const vip4 = valueOf(values, 'vip_v4');
  const vip6 = valueOf(values, 'vip_v6');
  if (vip4 && familyOf(vip4) !== 4) findings.push(error('tf.app.ingress-avi-vip', `"${vip4}" is not an IPv4 address.`, { path: 'vip_v4' }));
  if (vip6 && familyOf(vip6) !== 6) findings.push(error('tf.app.ingress-avi-vip', `"${vip6}" is not an IPv6 address.`, { path: 'vip_v6' }));
  if (!vip4 && !vip6) findings.push(error('tf.app.ingress-avi-no-vip', 'The virtual service needs a VIP.', { path: 'vip_v4' }));
  const tls = s.terminate;
  const profile = s.l7 ? (tls ? 'System-Secure-HTTP' : 'System-HTTP') : 'System-L4-Application';
  const serverTls = s.l7 && s.backendProtocol === 'https';
  const monitorType = s.backendProtocol === 'tcp' || !s.l7 ? 'HEALTH_MONITOR_TCP' : serverTls ? 'HEALTH_MONITOR_HTTPS' : 'HEALTH_MONITOR_HTTP';
  const blocks             = [
    {
      type: 'terraform',
      attributes: attrs({ required_version: '>= 1.7.0' }),
      blocks: [{ type: 'required_providers', attributes: [{ name: 'avi', value: x(`{\n      source  = ${q(AVI.source)}\n      version = ${q(aviVersion())}\n    }`) }] }],
      comment: 'Avi Load Balancer (VCF): the controller and its credentials come from AVI_CONTROLLER, AVI_USERNAME, AVI_PASSWORD, AVI_TENANT and AVI_VERSION in the environment.',
    },
    dat('avi_cloud', 'cloud', { name: valueOf(values, 'avi_cloud', 'Default-Cloud') }),
    dat('avi_serviceenginegroup', 'se', { name: valueOf(values, 'se_group', 'Default-Group'), cloud_ref: x('data.avi_cloud.cloud.id') }),
    dat('avi_applicationprofile', 'ingress', { name: profile }),
    ...(tls || serverTls ? [dat('avi_sslprofile', 'standard', { name: 'System-Standard' })] : []),
  ];
  if (tls && s.l7) {
    if (!s.certificate) findings.push(warning('tf.app.ingress-avi-cert', 'Name the SSL key and certificate on the Avi Controller; "System-Default-Cert" (self-signed) is used until then.', { path: 'certificate' }));
    blocks.push(dat('avi_sslkeyandcertificate', 'ingress', { name: s.certificate || 'System-Default-Cert' }));
  }
  const monitorBody =
    monitorType === 'HEALTH_MONITOR_TCP'
      ? [blk('tcp_monitor', { tcp_half_open: 'false' })]
      : [blk(serverTls ? 'https_monitor' : 'http_monitor', { http_request: `GET ${s.healthPath} HTTP/1.0`, http_response_code: ['HTTP_2XX', 'HTTP_3XX'] }, serverTls ? [blk('ssl_attributes', { ssl_profile_ref: x('data.avi_sslprofile.standard.id') })] : [])];
  blocks.push(
    res('avi_healthmonitor', 'ingress', { name: `${name}-hm`, type: monitorType, send_interval: '10', receive_timeout: '4', successful_checks: '2', failed_checks: '3' }, monitorBody),
    res('avi_pool', 'ingress', {
      name: `${name}-pool`,
      cloud_ref: x('data.avi_cloud.cloud.id'),
      lb_algorithm: s.persistence === 'source-ip' ? 'LB_ALGORITHM_CONSISTENT_HASH' : 'LB_ALGORITHM_LEAST_CONNECTIONS',
      lb_algorithm_hash: s.persistence === 'source-ip' ? 'LB_ALGORITHM_CONSISTENT_HASH_SOURCE_IP_ADDRESS' : undefined,
      default_server_port: String(s.backendPort),
      health_monitor_refs: x('[avi_healthmonitor.ingress.id]'),
      ssl_profile_ref: serverTls ? x('data.avi_sslprofile.standard.id') : undefined,
    }, s.members.map((m) => blk('servers', { port: String(m.port), enabled: 'true', hostname: m.server }, [aviIp('ip', m.address)]))),
    res('avi_vsvip', 'ingress', { name: `${name}-vip`, cloud_ref: x('data.avi_cloud.cloud.id') }, [
      blk('vip', { vip_id: '0', enabled: 'true' }, [...(vip4 ? [aviIp('ip_address', vip4)] : []), ...(vip6 ? [aviIp('ip6_address', vip6)] : [])]),
      ...s.fqdns.map((f) => blk('dns_info', { fqdn: f })),
    ]),
    res('avi_virtualservice', 'ingress', {
      name,
      enabled: 'true',
      cloud_ref: x('data.avi_cloud.cloud.id'),
      se_group_ref: x('data.avi_serviceenginegroup.se.id'),
      vsvip_ref: x('avi_vsvip.ingress.id'),
      pool_ref: x('avi_pool.ingress.id'),
      application_profile_ref: x('data.avi_applicationprofile.ingress.id'),
      ssl_profile_ref: tls && s.l7 ? x('data.avi_sslprofile.standard.id') : undefined,
      ssl_key_and_certificate_refs: tls && s.l7 ? x('[data.avi_sslkeyandcertificate.ingress.id]') : undefined,
    }, [blk('services', { port: String(s.listenerPort), enable_ssl: tls && s.l7 ? 'true' : 'false' })]),
    output('virtualservice_id', 'avi_virtualservice.ingress.id'),
  );
  if (s.waf) findings.push(info('tf.app.ingress-avi-waf', 'Avi WAF needs a WAF policy and profile of the controller (and its licence tier): attach one to the virtual service on the controller; none is created here.', { path: 'waf' }));
  if (s.persistence === 'cookie') findings.push(info('tf.app.ingress-avi-cookie', 'Cookie persistence is a persistence profile of the pool on the controller (System-Persistence-Http-Cookie): add it there.', { path: 'persistence' }));
  if (!s.l7 && tls) findings.push(info('tf.app.ingress-l4-tls', 'The layer 4 virtual service passes TLS through.', { path: 'tls' }));
  return blocks;
}

// ---------------------------------------------------------------------------
// The blueprints
// ---------------------------------------------------------------------------

const EMITS                                                       = {
  aws: ['aws_security_group', 'aws_vpc_security_group_ingress_rule', 'aws_vpc_security_group_egress_rule', 'aws_lb', 'aws_lb_target_group', 'aws_lb_target_group_attachment', 'aws_lb_listener', 'aws_wafv2_web_acl', 'aws_wafv2_web_acl_association', 'aws_route53_record'],
  azure: [
    'azurerm_subnet', 'azurerm_public_ip', 'azurerm_web_application_firewall_policy', 'azurerm_application_gateway', 'azurerm_lb', 'azurerm_lb_backend_address_pool',
    'azurerm_lb_backend_address_pool_address', 'azurerm_lb_probe', 'azurerm_lb_rule', 'azurerm_private_dns_a_record', 'azurerm_private_dns_aaaa_record', 'azurerm_dns_a_record', 'azurerm_dns_aaaa_record',
  ],
  google: [
    'google_compute_network_endpoint_group', 'google_compute_network_endpoint', 'google_compute_global_address', 'google_compute_health_check', 'google_compute_region_health_check',
    'google_compute_security_policy', 'google_compute_backend_service', 'google_compute_region_backend_service', 'google_compute_url_map', 'google_compute_region_url_map',
    'google_compute_managed_ssl_certificate', 'google_compute_target_https_proxy', 'google_compute_target_http_proxy', 'google_compute_region_target_https_proxy',
    'google_compute_region_target_http_proxy', 'google_compute_global_forwarding_rule', 'google_compute_forwarding_rule', 'google_compute_subnetwork', 'google_dns_record_set',
  ],
  oci: ['oci_load_balancer_load_balancer', 'oci_load_balancer_backend_set', 'oci_load_balancer_backend', 'oci_load_balancer_listener', 'oci_waf_web_app_firewall_policy', 'oci_waf_web_app_firewall', 'oci_dns_rrset'],
  vsphere: ['avi_healthmonitor', 'avi_pool', 'avi_vsvip', 'avi_virtualservice'],
};

const DESCRIPTION                                            = {
  aws: 'An Application or Network Load Balancer (dualstack on a dual-stack network) with its own security group, a target group of the members by address, HTTPS with a TLS 1.3 policy (and an HTTP redirect when public), a WAFv2 web ACL of AWS managed rules when asked, and Route 53 A / AAAA alias records.',
  azure: 'Layer 7: an Application Gateway v2 (WAF_v2 with a WAF policy when asked) in its own subnet, TLS from Key Vault. Layer 4: a Standard load balancer with IPv4 and IPv6 frontends on a dual-stack network. Private or public DNS A / AAAA records.',
  google: 'Layer 7: a global external Application load balancer (IPv4 and IPv6 addresses, a Google-managed certificate, Cloud Armor when asked) or a regional internal one. Layer 4: a passthrough network load balancer with IPv4 and IPv6 forwarding rules. Zonal NEGs of the members; Cloud DNS A / AAAA records.',
  oci: 'A flexible load balancer (IPv6 mode on a dual-stack network), a backend set with its health check, the members, a listener with TLS from the Certificates service, OCI WAF when asked, and DNS A / AAAA records.',
  vsphere: 'Avi Load Balancer on VCF: health monitor, pool of the members, a VS VIP with IPv4 and IPv6 addresses and the FQDNs, and the virtual service with TLS from a controller certificate.',
};

function ingress(platform                 )            {
  return {
    id: `${platform}_app_ingress`,
    label: 'App ingress (load balancer and DNS)',
    group: PATTERN_GROUP,
    description: DESCRIPTION[platform],
    inputs: ingressInputs(platform),
    emits: EMITS[platform],
    build: (values                 ) => {
      const findings            = [];
      const blocks =
        platform === 'aws' ? awsIngress(values, findings)
        : platform === 'azure' ? azureIngress(values, findings)
        : platform === 'google' ? googleIngress(values, findings)
        : platform === 'oci' ? ociIngress(values, findings)
        : [...vsphereIngress(values, findings)];
      const app = appOf(values);
      return { files: { 'main.tf': patternMainTf(blocks, `${platform === 'vsphere' ? 'VCF' : platform === 'google' ? 'Google Cloud (GCP)' : platform === 'oci' ? 'OCI' : platform === 'aws' ? 'AWS' : 'Azure'} ingress: ${app.name}`) }, findings };
    },
  };
}

export const INGRESS_BLUEPRINTS                       = (['aws', 'azure', 'google', 'oci', 'vsphere']         ).map(ingress);

/** For the other files: the member grid, parsed the same way. */
                         
