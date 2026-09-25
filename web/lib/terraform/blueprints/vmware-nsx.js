/**
 * Hand-written nsxt scenario blueprints: several resources built together.
 *
 * Each one is a build an NSX engineer reaches for as a unit rather than a
 * resource at a time:
 *
 *   Routing    a Tier-1 with its overlay segments (and segment DHCP); a Tier-0
 *              with uplink VLANs, edge interfaces, BGP peers and redistribution
 *   Security   a three-tier distributed firewall; a Tier-1 gateway firewall;
 *              tag, IP and nested groups; distributed IDS/IPS
 *   Services   SNAT/DNAT on a Tier-1; IP pools and IP blocks
 *   L2         VLAN-backed segments; a segment with security, SpoofGuard and
 *              QoS profiles bound to it
 *   Multi-tenancy  an NSX project with a VPC and its subnets
 *
 * Everything that normally already exists — the Tier-0, the edge cluster, the
 * transport zones, the predefined services — is looked up by display name with
 * a data source, never created. NSX's native load balancer is left out on
 * purpose: it is deprecated in favour of Avi (vmware-avi.ts).
 *
 * The HCL is assembled with the shared builder in hcl-builder.ts.
 */

                                                                        
import { error, warning,              } from '../../core/findings.js';
import { scenario, q, qlist, items, pairs, ident, on, n, YES_NO_OPTIONS } from './scenario-common.js';
import { data, list, map, output, render, resource, sensitiveVariable, uniqueIdents,                     } from './hcl-builder.js';

// --- NSX helpers ---------------------------------------------------------------

/** `tag {}` blocks from "scope=tag" lines. */
function tagBlocks(value         )        {
  return pairs(value).map(([scope, tag]) => ({ b: 'tag', body: [['scope', q(scope)], ['tag', q(tag)]]           }));
}

const TAGS_INPUT                 = {
  id: 'tags',
  label: 'Tags',
  control: 'textarea',
  default: 'environment=production\nmanaged-by=terraform',
  hint: 'scope=tag, one per line',
  section: 'Tags',
};

function ipToInt(ip        )                {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let v = 0;
  for (const p of parts) {
    const o = Number(p);
    if (!/^\d{1,3}$/.test(p) || o > 255) return null;
    v = v * 256 + o;
  }
  return v;
}

function intToIp(v        )         {
  return [24, 16, 8, 0].map((s) => Math.floor(v / 2 ** s) % 256).join('.');
}

/** An IPv4 address with a prefix, e.g. a gateway "10.10.10.1/24". */
function parseCidr(text        )                                                                   {
  const m = /^([\d.]+)\/(\d{1,2})$/.exec(text.trim());
  if (!m) return null;
  const ip = ipToInt(m[1]          );
  const prefix = Number(m[2]);
  if (ip === null || prefix > 32) return null;
  const size = 2 ** (32 - prefix);
  return { ip, prefix, net: ip - (ip % size), size };
}

const GATEWAY_FIREWALL_HINT = 'name,source,destination,service — one rule per line, in order';

/** Rule sources or destinations: "any", or IPs/CIDRs/ranges separated by spaces. */
function addresses(text        )           {
  const list = text.trim().split(/\s+/).filter(Boolean);
  return list.length === 1 && list[0]?.toLowerCase() === 'any' ? [] : list;
}

                       
                                               
                           
                                                                                  
                               
 

/**
 * "tcp/443 udp/53 icmp HTTPS" → inline port entries plus lookups of the
 * predefined services named. "any" (or nothing) matches every service.
 */
function services(text        )              {
  const named           = [];
  const l4 = new Map                  ();
  let icmp = false;
  for (const token of text.trim().split(/\s+/).filter(Boolean)) {
    const m = /^(tcp|udp)\/([\d-]+)$/i.exec(token);
    if (m) {
      const proto = (m[1]          ).toUpperCase();
      l4.set(proto, [...(l4.get(proto) ?? []), m[2]          ]);
    } else if (/^icmp$/i.test(token)) {
      icmp = true;
    } else if (!/^any$/i.test(token)) {
      named.push(token);
    }
  }
  const entries         = [...l4].map(([proto, ports]) => ({
    b: 'l4_port_set_entry',
    body: [['display_name', q(`${proto.toLowerCase()}-${ports.join('-')}`)], ['protocol', q(proto)], ['destination_ports', qlist(ports.join(','))]]          ,
  }));
  if (icmp) entries.push({ b: 'icmp_entry', body: [['display_name', q('icmp')], ['protocol', q('ICMPv4')]] });
  return { named, entries: entries.length > 0 ? { b: 'service_entries', body: entries } : null };
}

/** Data sources for predefined NSX services, keyed by Terraform name. */
function serviceLookups(names                  )                                                   {
  const unique = [...new Set(names)];
  const ids = uniqueIdents(unique, 'service');
  const byName = new Map(unique.map((name, i) => [name, ids[i]          ]));
  return {
    hcl: unique.map((name) => data('nsxt_policy_service', byName.get(name)          , [['display_name', q(name)]])),
    ref: (name) => `data.nsxt_policy_service.${byName.get(name)}.path`,
  };
}

// --- the scenarios -----------------------------------------------------------

const ROUTE_ADVERTISEMENT_OPTIONS = [
  { value: 'TIER1_CONNECTED', label: 'Connected segments' },
  { value: 'TIER1_STATIC_ROUTES', label: 'Static routes' },
  { value: 'TIER1_NAT', label: 'NAT IPs' },
  { value: 'TIER1_LB_VIP', label: 'Load balancer VIPs' },
  { value: 'TIER1_LB_SNAT', label: 'Load balancer SNAT IPs' },
  { value: 'TIER1_DNS_FORWARDER_IP', label: 'DNS forwarder IP' },
  { value: 'TIER1_IPSEC_LOCAL_ENDPOINT', label: 'IPsec local endpoint' },
];

const REDISTRIBUTION_OPTIONS = [
  { value: 'TIER0_CONNECTED', label: 'Tier-0 connected' },
  { value: 'TIER0_STATIC', label: 'Tier-0 static' },
  { value: 'TIER0_SEGMENT', label: 'Tier-0 segments' },
  { value: 'TIER0_NAT', label: 'Tier-0 NAT' },
  { value: 'TIER0_LOOPBACK_INTERFACE', label: 'Tier-0 loopbacks' },
  { value: 'TIER1_CONNECTED', label: 'Tier-1 connected' },
  { value: 'TIER1_STATIC', label: 'Tier-1 static' },
  { value: 'TIER1_NAT', label: 'Tier-1 NAT' },
  { value: 'TIER1_LB_VIP', label: 'Tier-1 LB VIPs' },
  { value: 'TIER1_LB_SNAT', label: 'Tier-1 LB SNAT' },
  { value: 'TIER1_DNS_FORWARDER_IP', label: 'Tier-1 DNS forwarder' },
  { value: 'TIER1_IPSEC_LOCAL_ENDPOINT', label: 'Tier-1 IPsec endpoints' },
];

const FIREWALL_ACTION_OPTIONS = [
  { value: 'DROP', label: 'Drop (silently)' },
  { value: 'REJECT', label: 'Reject (send RST / ICMP unreachable)' },
  { value: 'none', label: 'No default rule' },
];

const tier1Segments = scenario('nsxt', {
  id: 'nsx_t1_segments',
  label: 'Tier-1 gateway + overlay segments',
  description:
    'A Tier-1 gateway attached to an existing Tier-0, with one overlay segment per subnet, route advertisement to the Tier-0, and optionally a DHCP server handing out addresses on every segment.',
  inputs: [
    { id: 't1_name', label: 'Tier-1 gateway name', control: 'text', default: 't1-app01' },
    { id: 't0_name', label: 'Existing Tier-0 gateway', control: 'text', default: 't0-gw01', hint: 'display name, looked up' },
    {
      id: 'edge_cluster_name',
      label: 'Edge cluster',
      control: 'text',
      default: 'edge-cluster-01',
      hint: 'display name, looked up',
      help: 'Leave empty for a distributed-only Tier-1: routing only, no DHCP, NAT or gateway firewall.',
    },
    { id: 'overlay_tz_name', label: 'Overlay transport zone', control: 'text', default: 'nsx-overlay-transportzone', hint: 'display name, looked up' },
    { id: 'segments', label: 'Segments', control: 'textarea', default: 'web=10.10.10.1/24\napp=10.10.20.1/24\ndb=10.10.30.1/24', hint: 'name=gateway CIDR, one per line' },
    { id: 'route_advertisement', label: 'Advertise to the Tier-0', control: 'checklist', options: ROUTE_ADVERTISEMENT_OPTIONS, default: 'TIER1_CONNECTED,TIER1_STATIC_ROUTES,TIER1_NAT' },
    { id: 'dhcp', label: 'DHCP on the segments', control: 'toggle', default: false, hint: 'segment DHCP server on the edge cluster' },
    {
      id: 'dhcp_server_cidr',
      label: 'DHCP server address',
      control: 'text',
      default: '100.96.0.1/30',
      hint: 'gateway DHCP server, CIDR',
      showWhen: { input: 'dhcp', equals: ['true'] },
      help: 'Each segment also gets a DHCP address inside its own subnet (.2, or .3 when .2 is the gateway) and a pool of the upper half of the subnet. Add ",start-end" after a segment\'s CIDR to choose the pool yourself.',
    },
    { id: 'dns_servers', label: 'DNS servers (DHCP)', control: 'text', default: '10.0.0.53, 10.0.1.53', showWhen: { input: 'dhcp', equals: ['true'] } },
    { id: 'lease_time', label: 'Lease time', control: 'number', default: 86400, hint: 'seconds', showWhen: { input: 'dhcp', equals: ['true'] } },
    { id: 'domain_name', label: 'DNS domain', control: 'text', default: 'app.example.com', section: 'Advanced' },
    {
      id: 'failover_mode',
      label: 'Failover mode',
      control: 'select',
      options: [
        { value: 'NON_PREEMPTIVE', label: 'Non-preemptive' },
        { value: 'PREEMPTIVE', label: 'Preemptive' },
      ],
      default: 'NON_PREEMPTIVE',
      section: 'Advanced',
    },
    {
      id: 'pool_allocation',
      label: 'Edge pool allocation',
      control: 'select',
      options: [
        { value: 'ROUTING', label: 'Routing' },
        { value: 'LB_SMALL', label: 'LB small' },
        { value: 'LB_MEDIUM', label: 'LB medium' },
        { value: 'LB_LARGE', label: 'LB large' },
        { value: 'LB_XLARGE', label: 'LB extra large' },
      ],
      default: 'ROUTING',
      section: 'Advanced',
    },
    TAGS_INPUT,
  ],
  emits: ['nsxt_policy_tier1_gateway', 'nsxt_policy_segment', 'nsxt_policy_dhcp_server'],
  body: (v) => {
    const findings            = [];
    const edge = String(v.edge_cluster_name ?? '').trim();
    let dhcp = on(v.dhcp);
    if (dhcp && edge === '') {
      findings.push(error('nsx.t1.dhcp-needs-edge', 'A DHCP server runs on an edge cluster, and none was named.', { path: 'edge_cluster_name', remediation: 'Name the edge cluster, or turn DHCP off.' }));
      dhcp = false;
    }
    const lease = n(v.lease_time, 86400);
    const dns = items(v.dns_servers);
    const segments = pairs(v.segments);
    const names = uniqueIdents(segments.map(([name]) => name), 'segment');
    const tags = tagBlocks(v.tags);
    const out           = [
      data('nsxt_policy_tier0_gateway', 't0', [['display_name', q(v.t0_name)]]),
      edge ? data('nsxt_policy_edge_cluster', 'edge', [['display_name', q(edge)]]) : '',
      data('nsxt_policy_transport_zone', 'overlay', [['display_name', q(v.overlay_tz_name)]]),
    ];
    if (dhcp) {
      out.push(
        resource('nsxt_policy_dhcp_server', 't1', [
          ['display_name', q(`${v.t1_name}-dhcp`)],
          ['edge_cluster_path', 'data.nsxt_policy_edge_cluster.edge.path'],
          ['server_addresses', qlist(v.dhcp_server_cidr)],
          ['lease_time', String(lease)],
          ...tags,
        ]),
      );
    }
    const advertise = items(v.route_advertisement);
    out.push(
      resource('nsxt_policy_tier1_gateway', 't1', [
        ['display_name', q(v.t1_name)],
        ['description', q(`Tier-1 for ${segments.map(([s]) => s).join(', ') || 'application'} segments`)],
        edge && ['edge_cluster_path', 'data.nsxt_policy_edge_cluster.edge.path'],
        ['tier0_path', 'data.nsxt_policy_tier0_gateway.t0.path'],
        edge && ['failover_mode', q(v.failover_mode)],
        edge && ['pool_allocation', q(v.pool_allocation)],
        advertise.length > 0 && ['route_advertisement_types', qlist(advertise.join(','))],
        ...tags,
      ]),
    );
    segments.forEach(([name, rest], i) => {
      const [gatewayText = '', rangeText = ''] = rest.split(',').map((s) => s.trim());
      const cidr = parseCidr(gatewayText);
      if (!cidr) findings.push(error('nsx.t1.segment-cidr', `Segment "${name}" needs its gateway as an IPv4 CIDR, such as 10.10.10.1/24.`, { path: 'segments' }));
      let subnet         = [['cidr', q(gatewayText)]];
      if (dhcp && cidr) {
        if (cidr.prefix > 29) {
          findings.push(warning('nsx.t1.segment-too-small', `Segment "${name}" (/${cidr.prefix}) is too small for a DHCP pool, so it gets none.`, { path: 'segments' }));
        } else {
          const server = cidr.net + (cidr.ip === cidr.net + 2 ? 3 : 2);
          const pool = rangeText || `${intToIp(cidr.net + cidr.size / 2)}-${intToIp(cidr.net + cidr.size - 2)}`;
          subnet = [
            ...subnet,
            ['dhcp_ranges', qlist(pool)],
            {
              b: 'dhcp_v4_config',
              body: [['server_address', q(`${intToIp(server)}/${cidr.prefix}`)], dns.length > 0 && ['dns_servers', qlist(dns.join(','))], ['lease_time', String(lease)]],
            },
          ];
        }
      }
      out.push(
        resource('nsxt_policy_segment', names[i]          , [
          ['display_name', q(name)],
          ['connectivity_path', 'nsxt_policy_tier1_gateway.t1.path'],
          ['transport_zone_path', 'data.nsxt_policy_transport_zone.overlay.path'],
          String(v.domain_name ?? '').trim() !== '' && ['domain_name', q(v.domain_name)],
          dhcp && ['dhcp_config_path', 'nsxt_policy_dhcp_server.t1.path'],
          { b: 'subnet', body: subnet },
          ...tags,
        ]),
      );
    });
    out.push(output('tier1_path', 'nsxt_policy_tier1_gateway.t1.path', 'Policy path of the Tier-1 gateway'));
    out.push(output('segment_paths', map(segments.map(([name], i)                   => [name, `nsxt_policy_segment.${names[i]}.path`])), 'Policy path of each segment, by name'));
    return { hcl: out.filter(Boolean).join('\n\n'), findings };
  },
});

const tier0Bgp = scenario('nsxt', {
  id: 'nsx_t0_bgp',
  label: 'Tier-0 gateway with BGP uplinks',
  description:
    'A Tier-0 gateway on an existing edge cluster: VLAN uplink segments, an external interface per edge node and uplink, BGP with ECMP to the physical routers, and route redistribution of the Tier-1 networks.',
  inputs: [
    { id: 't0_name', label: 'Tier-0 gateway name', control: 'text', default: 't0-gw01' },
    {
      id: 'ha_mode',
      label: 'HA mode',
      control: 'select',
      options: [
        { value: 'ACTIVE_ACTIVE', label: 'Active-active (ECMP, no stateful services)' },
        { value: 'ACTIVE_STANDBY', label: 'Active-standby (stateful NAT, VPN, firewall)' },
      ],
      default: 'ACTIVE_ACTIVE',
    },
    { id: 'edge_cluster_name', label: 'Edge cluster', control: 'text', default: 'edge-cluster-01', hint: 'display name, looked up' },
    { id: 'vlan_tz_name', label: 'VLAN transport zone', control: 'text', default: 'nsx-vlan-transportzone', hint: 'edge uplink TZ, looked up' },
    { id: 'uplinks', label: 'Uplink segments', control: 'textarea', default: 'uplink-a=100\nuplink-b=200', hint: 'name=VLAN, one per line' },
    {
      id: 'interfaces',
      label: 'Edge interfaces',
      control: 'textarea',
      default: '0,uplink-a,192.0.2.2/28\n0,uplink-b,198.51.100.2/28\n1,uplink-a,192.0.2.3/28\n1,uplink-b,198.51.100.3/28',
      hint: 'edge node index,uplink,IP/prefix — one per line',
      help: 'The edge node index is its position in the edge cluster (0 for the first member).',
    },
    { id: 'local_as', label: 'Local AS', control: 'text', default: '65001', hint: 'ASPLAIN or ASDOT' },
    { id: 'neighbors', label: 'BGP neighbors', control: 'textarea', default: '192.0.2.1=65000\n198.51.100.1=65000', hint: 'neighbor IP=remote AS, one per line' },
    { id: 'redistribute', label: 'Redistribute into BGP', control: 'checklist', options: REDISTRIBUTION_OPTIONS, default: 'TIER0_CONNECTED,TIER0_STATIC,TIER1_CONNECTED,TIER1_STATIC,TIER1_NAT,TIER1_LB_VIP' },
    { id: 'bfd', label: 'BFD on the BGP sessions', control: 'toggle', default: true },
    { id: 'bgp_md5_auth', label: 'MD5 password on the sessions', control: 'toggle', default: false, hint: 'read from var.bgp_neighbor_password' },
    {
      id: 'failover_mode',
      label: 'Failover mode',
      control: 'select',
      options: [
        { value: 'NON_PREEMPTIVE', label: 'Non-preemptive' },
        { value: 'PREEMPTIVE', label: 'Preemptive' },
      ],
      default: 'NON_PREEMPTIVE',
      showWhen: { input: 'ha_mode', equals: ['ACTIVE_STANDBY'] },
    },
    {
      id: 'graceful_restart',
      label: 'Graceful restart',
      control: 'select',
      options: [
        { value: 'HELPER_ONLY', label: 'Helper only' },
        { value: 'GR_AND_HELPER', label: 'Restart and helper' },
        { value: 'DISABLE', label: 'Disabled' },
      ],
      default: 'HELPER_ONLY',
      section: 'BGP timers',
    },
    { id: 'keep_alive', label: 'Keepalive', control: 'number', default: 4, hint: 'seconds', section: 'BGP timers' },
    { id: 'hold_down', label: 'Hold-down', control: 'number', default: 12, hint: 'seconds', section: 'BGP timers' },
    { id: 'bfd_interval', label: 'BFD interval', control: 'number', default: 500, hint: 'ms', section: 'BGP timers' },
    { id: 'bfd_multiple', label: 'BFD multiplier', control: 'number', default: 3, section: 'BGP timers' },
    { id: 'mtu', label: 'Uplink MTU', control: 'number', default: 1500, section: 'Advanced' },
    {
      id: 'urpf_mode',
      label: 'uRPF on uplinks',
      control: 'select',
      options: [
        { value: 'NONE', label: 'None (asymmetric ECMP paths)' },
        { value: 'STRICT', label: 'Strict' },
      ],
      default: 'NONE',
      section: 'Advanced',
    },
    TAGS_INPUT,
  ],
  emits: ['nsxt_policy_vlan_segment', 'nsxt_policy_tier0_gateway', 'nsxt_policy_tier0_gateway_interface', 'nsxt_policy_bgp_neighbor', 'nsxt_policy_gateway_redistribution_config'],
  body: (v) => {
    const findings            = [];
    const activeActive = v.ha_mode === 'ACTIVE_ACTIVE';
    const tags = tagBlocks(v.tags);
    const uplinks = pairs(v.uplinks);
    const uplinkIds = uniqueIdents(uplinks.map(([name]) => name), 'uplink');
    const uplinkId = new Map(uplinks.map(([name], i) => [name, uplinkIds[i]          ]));
    const out           = [
      data('nsxt_policy_edge_cluster', 'edge', [['display_name', q(v.edge_cluster_name)]]),
      data('nsxt_policy_transport_zone', 'vlan', [['display_name', q(v.vlan_tz_name)]]),
    ];

    const interfaces = String(v.interfaces ?? '')
      .split('\n')
      .map((line) => line.split(/[,\s]+/).filter(Boolean))
      .filter((f) => f.length > 0);
    const edgeIndexes = [...new Set(interfaces.map((f) => f[0]          ))];
    for (const index of edgeIndexes) {
      if (!/^\d+$/.test(index)) {
        findings.push(error('nsx.t0.edge-index', `"${index}" is not an edge node index (0, 1, …).`, { path: 'interfaces' }));
        continue;
      }
      out.push(data('nsxt_policy_edge_node', `edge_${index}`, [['edge_cluster_path', 'data.nsxt_policy_edge_cluster.edge.path'], ['member_index', index]]));
    }

    uplinks.forEach(([name, vlan], i) => {
      out.push(
        resource('nsxt_policy_vlan_segment', uplinkIds[i]          , [
          ['display_name', q(`${v.t0_name}-${name}`)],
          ['transport_zone_path', 'data.nsxt_policy_transport_zone.vlan.path'],
          ['vlan_ids', qlist(vlan)],
          ...tags,
        ]),
      );
    });

    out.push(
      resource('nsxt_policy_tier0_gateway', 't0', [
        ['display_name', q(v.t0_name)],
        ['ha_mode', q(v.ha_mode)],
        !activeActive && ['failover_mode', q(v.failover_mode)],
        ['edge_cluster_path', 'data.nsxt_policy_edge_cluster.edge.path'],
        {
          b: 'bgp_config',
          body: [
            ['enabled', 'true'],
            ['local_as_num', q(v.local_as)],
            ['ecmp', String(activeActive)],
            ['multipath_relax', String(activeActive)],
            activeActive && ['inter_sr_ibgp', 'true'],
            ['graceful_restart_mode', q(v.graceful_restart)],
          ],
        },
        ...tags,
      ]),
    );

    const ifaceRefs           = [];
    for (const f of interfaces) {
      const [index = '', uplink = '', address = ''] = f;
      const seg = uplinkId.get(uplink);
      if (!seg) {
        findings.push(error('nsx.t0.unknown-uplink', `Interface on edge ${index} names uplink "${uplink}", which is not in the uplink segments.`, { path: 'interfaces' }));
        continue;
      }
      if (!/^\d+$/.test(index)) continue;
      const name = `edge_${index}_${seg}`;
      ifaceRefs.push(`nsxt_policy_tier0_gateway_interface.${name}`);
      out.push(
        resource('nsxt_policy_tier0_gateway_interface', name, [
          ['display_name', q(`en${index}-${uplink}`)],
          ['type', q('EXTERNAL')],
          ['gateway_path', 'nsxt_policy_tier0_gateway.t0.path'],
          ['segment_path', `nsxt_policy_vlan_segment.${seg}.path`],
          ['edge_node_path', `data.nsxt_policy_edge_node.edge_${index}.path`],
          ['subnets', qlist(address)],
          ['mtu', String(n(v.mtu, 1500))],
          ['urpf_mode', q(v.urpf_mode)],
        ]),
      );
    }

    const password = on(v.bgp_md5_auth);
    if (password) out.push(sensitiveVariable('bgp_neighbor_password', 'MD5 password shared with the BGP neighbors'));
    for (const [address, remoteAs] of pairs(v.neighbors)) {
      out.push(
        resource('nsxt_policy_bgp_neighbor', ident(`peer_${address}`), [
          ['display_name', q(`peer-${address}`)],
          ['bgp_path', 'nsxt_policy_tier0_gateway.t0.bgp_config[0].path'],
          ['neighbor_address', q(address)],
          ['remote_as_num', q(remoteAs)],
          ['keep_alive_time', String(n(v.keep_alive, 4))],
          ['hold_down_time', String(n(v.hold_down, 12))],
          ['graceful_restart_mode', q(v.graceful_restart)],
          password && ['password', 'var.bgp_neighbor_password'],
          on(v.bfd) && { b: 'bfd_config', body: [['enabled', 'true'], ['interval', String(n(v.bfd_interval, 500))], ['multiple', String(n(v.bfd_multiple, 3))]] },
          // Peering only comes up once the interfaces facing the neighbor exist.
          ifaceRefs.length > 0 && ['depends_on', list(ifaceRefs)],
        ]),
      );
    }

    const types = items(v.redistribute);
    out.push(
      resource('nsxt_policy_gateway_redistribution_config', 't0', [
        ['gateway_path', 'nsxt_policy_tier0_gateway.t0.path'],
        ['bgp_enabled', 'true'],
        types.length > 0 && { b: 'rule', body: [['name', q('to-bgp')], ['bgp', 'true'], ['types', qlist(types.join(','))]] },
      ]),
    );
    out.push(output('tier0_path', 'nsxt_policy_tier0_gateway.t0.path', 'Policy path of the Tier-0 gateway, for Tier-1s to attach to'));
    return { hcl: out.join('\n\n'), findings };
  },
});

const threeTierDfw = scenario('nsxt', {
  id: 'nsx_dfw_three_tier',
  label: 'Three-tier distributed firewall',
  description:
    'Tag-based groups for the web, app and database tiers of one application and an Application-category security policy that allows only any→web, web→app and app→db (plus optional admin access), then drops the rest.',
  inputs: [
    { id: 'app_name', label: 'Application', control: 'text', default: 'shop', hint: 'names the groups and the policy' },
    { id: 'app_scope', label: 'Application tag scope', control: 'text', default: 'app', hint: 'VMs carry scope|application, e.g. app|shop' },
    { id: 'tier_scope', label: 'Tier tag scope', control: 'text', default: 'tier' },
    { id: 'web_tag', label: 'Web tier tag', control: 'text', default: 'web' },
    { id: 'app_tag', label: 'App tier tag', control: 'text', default: 'app' },
    { id: 'db_tag', label: 'Database tier tag', control: 'text', default: 'db' },
    {
      id: 'web_services',
      label: 'Web tier services',
      control: 'checklist',
      options: [
        { value: 'HTTPS', label: 'HTTPS (443)' },
        { value: 'HTTP', label: 'HTTP (80)' },
      ],
      default: 'HTTPS',
      hint: 'predefined services, looked up',
    },
    { id: 'app_port', label: 'App tier port', control: 'text', default: '8443', hint: 'TCP, port or range' },
    { id: 'db_port', label: 'Database port', control: 'text', default: '5432', hint: 'TCP, port or range' },
    { id: 'admin_access', label: 'Admin SSH to every tier', control: 'toggle', default: true },
    { id: 'admin_cidrs', label: 'Admin networks', control: 'text', default: '10.0.0.0/24', hint: 'comma-separated CIDRs', showWhen: { input: 'admin_access', equals: ['true'] } },
    { id: 'default_action', label: 'Everything else to the tiers', control: 'select', options: FIREWALL_ACTION_OPTIONS, default: 'DROP' },
    { id: 'logged', label: 'Log the rules', control: 'toggle', default: true },
    { id: 'domain', label: 'Domain', control: 'text', default: 'default', section: 'Advanced' },
  ],
  emits: ['nsxt_policy_group', 'nsxt_policy_service', 'nsxt_policy_security_policy'],
  body: (v) => {
    const app = String(v.app_name ?? 'app').trim() || 'app';
    const domain = q(v.domain || 'default');
    const logged = String(on(v.logged));
    const tiers                     = [
      ['web', String(v.web_tag)],
      ['app', String(v.app_tag)],
      ['db', String(v.db_tag)],
    ];
    const webServices = items(v.web_services);
    const lookups = serviceLookups([...webServices, ...(on(v.admin_access) ? ['SSH'] : [])]);
    const out           = [...lookups.hcl];
    for (const [tier, tag] of tiers) {
      out.push(
        resource('nsxt_policy_group', tier, [
          ['display_name', q(`${app}-${tier}`)],
          ['description', q(`VMs tagged ${v.app_scope}|${app} and ${v.tier_scope}|${tag}`)],
          ['domain', domain],
          {
            b: 'criteria',
            // Two conditions in one criteria are ANDed.
            body: [
              { b: 'condition', body: [['key', q('Tag')], ['member_type', q('VirtualMachine')], ['operator', q('EQUALS')], ['value', q(`${v.app_scope}|${app}`)]] },
              { b: 'condition', body: [['key', q('Tag')], ['member_type', q('VirtualMachine')], ['operator', q('EQUALS')], ['value', q(`${v.tier_scope}|${tag}`)]] },
            ],
          },
        ]),
      );
    }
    if (on(v.admin_access)) {
      out.push(
        resource('nsxt_policy_group', 'admins', [
          ['display_name', q(`${app}-admins`)],
          ['domain', domain],
          ['group_type', q('IPAddress')],
          { b: 'criteria', body: [{ b: 'ipaddress_expression', body: [['ip_addresses', qlist(v.admin_cidrs)]] }] },
        ]),
      );
    }
    const portService = (name        , port        )         =>
      resource('nsxt_policy_service', name, [
        ['display_name', q(`${app}-${name}-tcp-${port}`)],
        { b: 'l4_port_set_entry', body: [['display_name', q(`tcp-${port}`)], ['protocol', q('TCP')], ['destination_ports', qlist(port)]] },
      ]);
    out.push(portService('app', String(v.app_port)), portService('db', String(v.db_port)));

    const group = (tier        )         => `nsxt_policy_group.${tier}.path`;
    const allTiers = list(tiers.map(([t]) => group(t)));
    const rule = (name        , body        )      => ({ b: 'rule', body: [['display_name', q(name)], ...body, ['logged', logged]] });
    const rules        = [
      rule('any-to-web', [
        ['destination_groups', list([group('web')])],
        webServices.length > 0 && ['services', list(webServices.map(lookups.ref))],
        ['action', q('ALLOW')],
      ]),
      rule('web-to-app', [['source_groups', list([group('web')])], ['destination_groups', list([group('app')])], ['services', list(['nsxt_policy_service.app.path'])], ['action', q('ALLOW')]]),
      rule('app-to-db', [['source_groups', list([group('app')])], ['destination_groups', list([group('db')])], ['services', list(['nsxt_policy_service.db.path'])], ['action', q('ALLOW')]]),
    ];
    if (on(v.admin_access)) {
      rules.push(rule('admin-ssh', [['source_groups', list([group('admins')])], ['destination_groups', allTiers], ['services', list([lookups.ref('SSH')])], ['action', q('ALLOW')]]));
    }
    if (v.default_action !== 'none') {
      rules.push(rule('deny-rest', [['destination_groups', allTiers], ['action', q(v.default_action)]]));
    }
    out.push(
      resource('nsxt_policy_security_policy', 'app', [
        ['display_name', q(app)],
        ['description', q(`Three-tier micro-segmentation for ${app}`)],
        ['domain', domain],
        ['category', q('Application')],
        ['stateful', 'true'],
        ['tcp_strict', 'true'],
        ['scope', allTiers],
        ...rules,
      ]),
    );
    out.push(output('group_paths', map(tiers.map(([t])                   => [t, group(t)])), 'Policy path of each tier group'));
    return out.join('\n\n');
  },
});

/** "name,source,destination,service" lines as rule blocks, with the service lookups they need. */
function firewallRules(text         , scopeRef               , logged         , findings           , path        )                                      {
  const lines = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const specs = lines.map((line) => line.split(',').map((s) => s.trim()));
  const svc = specs.map((f) => services(f[3] ?? 'any'));
  const lookups = serviceLookups(svc.flatMap((s) => s.named));
  const rules = specs.map((f, i)      => {
    if (f.length < 4) findings.push(warning('nsx.firewall.short-rule', `Rule "${f[0]}" has fewer than four fields; the missing ones mean "any".`, { path }));
    const s = svc[i]               ;
    const src = addresses(f[1] ?? 'any');
    const dst = addresses(f[2] ?? 'any');
    return {
      b: 'rule',
      body: [
        ['display_name', q(f[0] || `rule-${i + 1}`)],
        src.length > 0 && ['source_groups', qlist(src.join(','))],
        dst.length > 0 && ['destination_groups', qlist(dst.join(','))],
        s.named.length > 0 && ['services', list(s.named.map(lookups.ref))],
        scopeRef !== null && ['scope', list([scopeRef])],
        ['action', q('ALLOW')],
        ['logged', String(logged)],
        s.entries,
      ],
    };
  });
  return { rules, lookups: lookups.hcl };
}

const gatewayFirewall = scenario('nsxt', {
  id: 'nsx_t1_gateway_firewall',
  label: 'Gateway firewall on a Tier-1',
  description:
    'A LocalGatewayRules gateway firewall policy applied to an existing Tier-1: ordered allow rules for the traffic crossing it, written as source, destination and ports, and a default drop at the end.',
  inputs: [
    { id: 't1_name', label: 'Existing Tier-1 gateway', control: 'text', default: 't1-app01', hint: 'display name, looked up' },
    { id: 'policy_name', label: 'Policy name', control: 'text', default: 't1-app01-perimeter' },
    {
      id: 'rules',
      label: 'Allow rules',
      control: 'textarea',
      default:
        'https-in,any,10.10.10.0/24,tcp/443\nadmin-ssh,10.0.0.0/24,10.10.0.0/16,tcp/22\ndns-out,10.10.0.0/16,10.0.0.53 10.0.1.53,udp/53 tcp/53\nntp-out,10.10.0.0/16,any,NTP\nicmp-in,10.0.0.0/8,10.10.0.0/16,icmp',
      hint: GATEWAY_FIREWALL_HINT,
      help: 'Source and destination are "any" or IPs/CIDRs separated by spaces. Service is "any", tcp/port, udp/port (ranges like tcp/8000-8100), icmp, or the name of a predefined NSX service such as HTTPS or NTP — several separated by spaces.',
    },
    { id: 'default_action', label: 'Everything else', control: 'select', options: FIREWALL_ACTION_OPTIONS, default: 'DROP' },
    { id: 'logged', label: 'Log the rules', control: 'toggle', default: true },
    { id: 'stateful', label: 'Stateful', control: 'select', options: YES_NO_OPTIONS, default: 'true', section: 'Advanced' },
    { id: 'domain', label: 'Domain', control: 'text', default: 'default', section: 'Advanced' },
  ],
  emits: ['nsxt_policy_gateway_policy'],
  body: (v) => {
    const findings            = [];
    const scope = 'data.nsxt_policy_tier1_gateway.t1.path';
    const { rules, lookups } = firewallRules(v.rules, scope, on(v.logged), findings, 'rules');
    if (v.default_action !== 'none') {
      rules.push({ b: 'rule', body: [['display_name', q('default-deny')], ['scope', list([scope])], ['action', q(v.default_action)], ['logged', 'true']] });
    }
    const out = [
      data('nsxt_policy_tier1_gateway', 't1', [['display_name', q(v.t1_name)]]),
      ...lookups,
      resource('nsxt_policy_gateway_policy', 't1', [
        ['display_name', q(v.policy_name)],
        ['domain', q(v.domain || 'default')],
        ['category', q('LocalGatewayRules')],
        ['stateful', on(v.stateful) ? 'true' : 'false'],
        ...rules,
      ]),
    ];
    return { hcl: out.join('\n\n'), findings };
  },
});

                    
                            
                              
                             
                               
                            
 

const tier1Nat = scenario('nsxt', {
  id: 'nsx_t1_nat',
  label: 'NAT on a Tier-1 (SNAT + DNAT)',
  description:
    'Source NAT for the subnets behind an existing Tier-1 to one public address, a NO_SNAT exemption for internal destinations, and port-forwarding DNAT rules from public IP:port to private IP:port.',
  inputs: [
    { id: 't1_name', label: 'Existing Tier-1 gateway', control: 'text', default: 't1-app01', hint: 'display name, looked up; needs an edge cluster' },
    { id: 'snat_sources', label: 'Internal subnets', control: 'text', default: '10.10.0.0/16', hint: 'comma-separated CIDRs to SNAT' },
    { id: 'snat_ip', label: 'SNAT address', control: 'text', default: '203.0.113.5', hint: 'public IP they leave as' },
    { id: 'no_snat', label: 'Exempt internal destinations', control: 'toggle', default: true, hint: 'NO_SNAT, keeps east-west traffic un-NATed' },
    { id: 'no_snat_destinations', label: 'Internal destinations', control: 'text', default: '10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16', showWhen: { input: 'no_snat', equals: ['true'] } },
    {
      id: 'dnat',
      label: 'DNAT rules',
      control: 'textarea',
      default: '203.0.113.10:443=10.10.10.10:8443\n203.0.113.10:80=10.10.10.10:8080\n203.0.113.11:53=10.10.30.53:53/udp\n203.0.113.20=10.10.10.20',
      hint: 'publicIP[:port]=privateIP[:port][/udp], one per line',
      help: 'Without ports the rule is a 1:1 destination NAT of every port.',
    },
    {
      id: 'firewall_match',
      label: 'Gateway firewall matches',
      control: 'select',
      options: [
        { value: 'MATCH_INTERNAL_ADDRESS', label: 'Internal address (post-DNAT)' },
        { value: 'MATCH_EXTERNAL_ADDRESS', label: 'External address (pre-DNAT)' },
        { value: 'BYPASS', label: 'Bypass the gateway firewall' },
      ],
      default: 'MATCH_INTERNAL_ADDRESS',
      section: 'Advanced',
    },
    { id: 'logging', label: 'Log NAT hits', control: 'toggle', default: false, section: 'Advanced' },
  ],
  emits: ['nsxt_policy_nat_rule', 'nsxt_policy_service'],
  body: (v) => {
    const findings            = [];
    const gw = 'data.nsxt_policy_tier1_gateway.t1.path';
    const logging = String(on(v.logging));
    const out           = [data('nsxt_policy_tier1_gateway', 't1', [['display_name', q(v.t1_name)]])];
    if (on(v.no_snat)) {
      out.push(
        resource('nsxt_policy_nat_rule', 'no_snat_internal', [
          ['display_name', q('no-snat-internal')],
          ['gateway_path', gw],
          ['action', q('NO_SNAT')],
          ['source_networks', qlist(v.snat_sources)],
          ['destination_networks', qlist(v.no_snat_destinations)],
          ['rule_priority', '100'],
          ['logging', logging],
        ]),
      );
    }
    out.push(
      resource('nsxt_policy_nat_rule', 'snat', [
        ['display_name', q('snat-internal')],
        ['gateway_path', gw],
        ['action', q('SNAT')],
        ['source_networks', qlist(v.snat_sources)],
        ['translated_networks', qlist(v.snat_ip)],
        ['rule_priority', '1000'],
        ['firewall_match', q(v.firewall_match)],
        ['logging', logging],
      ]),
    );
    const rules             = [];
    for (const line of String(v.dnat ?? '').split('\n').map((l) => l.trim()).filter(Boolean)) {
      const m = /^([\d.]+)(?::([\d-]+))?\s*=\s*([\d.]+)(?::([\d-]+))?(?:\s*\/\s*(tcp|udp))?$/i.exec(line);
      if (!m) {
        findings.push(error('nsx.nat.dnat-line', `"${line}" is not publicIP[:port]=privateIP[:port][/udp].`, { path: 'dnat' }));
        continue;
      }
      rules.push({ publicIp: m[1]          , publicPort: m[2] ?? '', privateIp: m[3]          , privatePort: m[4] ?? '', protocol: (m[5] ?? 'tcp').toUpperCase() });
    }
    const names = uniqueIdents(rules.map((r) => `dnat_${r.publicIp}${r.publicPort ? `_${r.publicPort}` : ''}_${r.protocol.toLowerCase()}`), 'dnat');
    rules.forEach((r, i) => {
      const name = names[i]          ;
      if (r.publicPort) {
        // The service is what a DNAT rule matches the original destination port with.
        out.push(
          resource('nsxt_policy_service', name, [
            ['display_name', q(`${name.replace(/_/g, '-')}`)],
            { b: 'l4_port_set_entry', body: [['display_name', q(`${r.protocol.toLowerCase()}-${r.publicPort}`)], ['protocol', q(r.protocol)], ['destination_ports', qlist(r.publicPort)]] },
          ]),
        );
      }
      out.push(
        resource('nsxt_policy_nat_rule', name, [
          ['display_name', q(`dnat-${r.publicIp}${r.publicPort ? `-${r.publicPort}` : ''}`)],
          ['gateway_path', gw],
          ['action', q('DNAT')],
          ['destination_networks', qlist(r.publicIp)],
          ['translated_networks', qlist(r.privateIp)],
          r.publicPort !== '' && ['service', `nsxt_policy_service.${name}.path`],
          r.privatePort !== '' && r.privatePort !== r.publicPort && ['translated_ports', q(r.privatePort)],
          ['rule_priority', String(500 + i)],
          ['firewall_match', q(v.firewall_match)],
          ['logging', logging],
        ]),
      );
      if (r.privatePort && !r.publicPort) findings.push(warning('nsx.nat.port-without-match', `DNAT to ${r.privateIp}:${r.privatePort} has no public port to match, so the private port is ignored.`, { path: 'dnat' }));
    });
    return { hcl: out.join('\n\n'), findings };
  },
});

const vlanSegments = scenario('nsxt', {
  id: 'nsx_vlan_segments',
  label: 'VLAN-backed segments',
  description:
    'VLAN segments on an existing VLAN transport zone, one per line — access VLANs or trunks — for workloads that sit on the physical network rather than an overlay.',
  inputs: [
    { id: 'vlan_tz_name', label: 'VLAN transport zone', control: 'text', default: 'nsx-vlan-transportzone', hint: 'display name, looked up' },
    { id: 'segments', label: 'Segments', control: 'textarea', default: 'vlan110-mgmt-vms=110\nvlan120-backup=120\nvm-trunk=200-210', hint: 'name=VLAN, ranges and lists for trunks (200-210 or 200,210), one per line' },
    { id: 'teaming_policy', label: 'Uplink teaming policy', control: 'text', default: '', hint: 'named teaming in the TZ; empty for the default', section: 'Advanced' },
    { id: 'domain_name', label: 'DNS domain', control: 'text', default: '', section: 'Advanced' },
    TAGS_INPUT,
  ],
  emits: ['nsxt_policy_vlan_segment'],
  body: (v) => {
    const segments = pairs(v.segments);
    const names = uniqueIdents(segments.map(([name]) => name), 'segment');
    const teaming = String(v.teaming_policy ?? '').trim();
    const out           = [data('nsxt_policy_transport_zone', 'vlan', [['display_name', q(v.vlan_tz_name)]])];
    segments.forEach(([name, vlans], i) => {
      out.push(
        resource('nsxt_policy_vlan_segment', names[i]          , [
          ['display_name', q(name)],
          ['transport_zone_path', 'data.nsxt_policy_transport_zone.vlan.path'],
          ['vlan_ids', qlist(vlans)],
          String(v.domain_name ?? '').trim() !== '' && ['domain_name', q(v.domain_name)],
          teaming !== '' && { b: 'advanced_config', body: [['uplink_teaming_policy', q(teaming)]] },
          ...tagBlocks(v.tags),
        ]),
      );
    });
    out.push(output('segment_paths', map(segments.map(([name], i)                   => [name, `nsxt_policy_vlan_segment.${names[i]}.path`])), 'Policy path of each segment, by name'));
    return out.join('\n\n');
  },
});

const ipPoolsBlocks = scenario('nsxt', {
  id: 'nsx_ip_pools_blocks',
  label: 'IP pools and IP blocks',
  description:
    'An IP address pool with static subnets and allocation ranges (TEPs, load balancer VIPs), and an IP block for Kubernetes pods or VPCs — optionally with a second pool that carves its subnets out of the block.',
  inputs: [
    { id: 'pool_name', label: 'IP pool name', control: 'text', default: 'tep-pool-01' },
    {
      id: 'pool_subnets',
      label: 'Static subnets',
      control: 'textarea',
      default: '172.16.10.0/24,172.16.10.10-172.16.10.200,172.16.10.1\n172.16.11.0/24,172.16.11.10-172.16.11.200,172.16.11.1',
      hint: 'CIDR,start-end[ start-end],gateway — one subnet per line',
    },
    { id: 'dns_servers', label: 'DNS servers', control: 'text', default: '10.0.0.53, 10.0.1.53', hint: 'up to three', section: 'DNS' },
    { id: 'dns_suffix', label: 'DNS suffix', control: 'text', default: 'example.com', section: 'DNS' },
    { id: 'ip_block', label: 'Also create an IP block', control: 'toggle', default: true },
    { id: 'block_name', label: 'IP block name', control: 'text', default: 'k8s-pod-block', showWhen: { input: 'ip_block', equals: ['true'] } },
    { id: 'block_cidr', label: 'IP block CIDR', control: 'text', default: '10.244.0.0/16', showWhen: { input: 'ip_block', equals: ['true'] } },
    {
      id: 'block_visibility',
      label: 'Visibility',
      control: 'select',
      options: [
        { value: 'PRIVATE', label: 'Private (VPC private subnets)' },
        { value: 'EXTERNAL', label: 'External (VPC public subnets, NSX 4.2+)' },
      ],
      blankLabel: 'Not set (NSX before 4.2)',
      showWhen: { input: 'ip_block', equals: ['true'] },
    },
    { id: 'block_pool', label: 'Pool carved from the block', control: 'toggle', default: false, showWhen: { input: 'ip_block', equals: ['true'] } },
    { id: 'block_pool_size', label: 'Addresses per carved subnet', control: 'number', default: 256, hint: 'power of two', showWhen: { input: 'block_pool', equals: ['true'] } },
  ],
  emits: ['nsxt_policy_ip_pool', 'nsxt_policy_ip_pool_static_subnet', 'nsxt_policy_ip_block', 'nsxt_policy_ip_pool_block_subnet'],
  body: (v) => {
    const findings            = [];
    const dns = items(v.dns_servers);
    if (dns.length > 3) findings.push(warning('nsx.pool.dns', 'An IP pool subnet takes at most three DNS servers; the rest are dropped.', { path: 'dns_servers' }));
    const out           = [resource('nsxt_policy_ip_pool', 'pool', [['display_name', q(v.pool_name)]])];
    const subnets = String(v.pool_subnets ?? '')
      .split('\n')
      .map((l) => l.split(',').map((s) => s.trim()))
      .filter((f) => (f[0] ?? '') !== '');
    subnets.forEach(([cidr = '', ranges = '', gateway = ''], i) => {
      const allocation = ranges
        .split(/\s+/)
        .filter(Boolean)
        .map((r)      => {
          const [start = '', end = start] = r.split('-');
          return { b: 'allocation_range', body: [['start', q(start)], ['end', q(end)]] };
        });
      if (allocation.length === 0) findings.push(error('nsx.pool.no-range', `Subnet ${cidr} needs at least one allocation range (start-end).`, { path: 'pool_subnets' }));
      out.push(
        resource('nsxt_policy_ip_pool_static_subnet', `subnet_${i + 1}`, [
          ['display_name', q(cidr)],
          ['pool_path', 'nsxt_policy_ip_pool.pool.path'],
          ['cidr', q(cidr)],
          gateway !== '' && ['gateway', q(gateway)],
          dns.length > 0 && ['dns_nameservers', qlist(dns.slice(0, 3).join(','))],
          String(v.dns_suffix ?? '').trim() !== '' && ['dns_suffix', q(v.dns_suffix)],
          ...allocation,
        ]),
      );
    });
    out.push(output('ip_pool_path', 'nsxt_policy_ip_pool.pool.path', 'Policy path of the IP pool'));
    if (on(v.ip_block)) {
      const visibility = String(v.block_visibility ?? '').trim();
      out.push(
        resource('nsxt_policy_ip_block', 'block', [
          ['display_name', q(v.block_name)],
          ['cidr', q(v.block_cidr)],
          visibility !== '' && ['visibility', q(visibility)],
        ]),
      );
      if (on(v.block_pool)) {
        out.push(
          resource('nsxt_policy_ip_pool', 'block_pool', [['display_name', q(`${v.block_name}-pool`)]]),
          resource('nsxt_policy_ip_pool_block_subnet', 'block_pool', [
            ['display_name', q(`${v.block_name}-subnet-1`)],
            ['pool_path', 'nsxt_policy_ip_pool.block_pool.path'],
            ['block_path', 'nsxt_policy_ip_block.block.path'],
            ['size', String(n(v.block_pool_size, 256))],
            ['auto_assign_gateway', 'true'],
          ]),
        );
      }
      out.push(output('ip_block_path', 'nsxt_policy_ip_block.block.path', 'Policy path of the IP block'));
    }
    return { hcl: out.join('\n\n'), findings };
  },
});

const groupsTags = scenario('nsxt', {
  id: 'nsx_groups_tags',
  label: 'Groups and VM tags',
  description:
    'Security groups the firewall rules refer to: dynamic groups by VM tag, IP-address groups, one umbrella group nesting the tag groups, a compound group (name prefix AND tag, OR an IP range), and the tags themselves applied to existing VMs.',
  inputs: [
    { id: 'tag_groups', label: 'Tag groups', control: 'textarea', default: 'shop-web=tier|web\nshop-app=tier|app\nshop-db=tier|db', hint: 'group=scope|tag, one per line' },
    {
      id: 'ip_groups',
      label: 'IP groups',
      control: 'textarea',
      default: 'corp-networks=10.0.0.0/8 172.16.0.0/12\ndns-servers=10.0.0.53 10.0.1.53',
      hint: 'group=IPs, CIDRs or ranges separated by spaces',
      help: 'IPv4 and IPv6 cannot be mixed in one group.',
    },
    { id: 'umbrella_group', label: 'Umbrella group', control: 'text', default: 'shop-all', hint: 'contains every tag group; empty for none' },
    { id: 'compound', label: 'Compound group', control: 'toggle', default: true, hint: 'VM name prefix AND tag, OR IPs' },
    { id: 'compound_name', label: 'Compound group name', control: 'text', default: 'prod-web', showWhen: { input: 'compound', equals: ['true'] } },
    { id: 'compound_prefix', label: 'VM name starts with', control: 'text', default: 'web-', showWhen: { input: 'compound', equals: ['true'] } },
    { id: 'compound_tag', label: 'and is tagged', control: 'text', default: 'env|prod', hint: 'scope|tag', showWhen: { input: 'compound', equals: ['true'] } },
    { id: 'compound_ips', label: 'or has an address in', control: 'text', default: '10.20.0.0/24', hint: 'space-separated; empty for none', showWhen: { input: 'compound', equals: ['true'] } },
    {
      id: 'vm_tags',
      label: 'Tag these VMs',
      control: 'textarea',
      default: 'web-01=tier|web env|prod\napp-01=tier|app env|prod\ndb-01=tier|db env|prod',
      hint: 'VM name=scope|tag scope|tag — empty to tag none',
      help: 'The VMs are looked up by display name in the NSX inventory. Terraform then owns all NSX tags on them.',
    },
    { id: 'domain', label: 'Domain', control: 'text', default: 'default', section: 'Advanced' },
  ],
  emits: ['nsxt_policy_group', 'nsxt_policy_vm_tags'],
  body: (v) => {
    const domain = q(v.domain || 'default');
    const out           = [];
    const condition = (key        , operator        , value        )      => ({
      b: 'condition',
      body: [['key', q(key)], ['member_type', q('VirtualMachine')], ['operator', q(operator)], ['value', q(value)]],
    });
    const tagGroups = pairs(v.tag_groups);
    const tagIds = uniqueIdents(tagGroups.map(([name]) => name), 'group');
    tagGroups.forEach(([name, tag], i) => {
      out.push(
        resource('nsxt_policy_group', tagIds[i]          , [
          ['display_name', q(name)],
          ['description', q(`VMs tagged ${tag}`)],
          ['domain', domain],
          { b: 'criteria', body: [condition('Tag', 'EQUALS', tag)] },
        ]),
      );
    });
    const ipGroups = pairs(v.ip_groups);
    const ipIds = uniqueIdents(ipGroups.map(([name]) => `ip_${name}`), 'ip_group');
    ipGroups.forEach(([name, addrs], i) => {
      out.push(
        resource('nsxt_policy_group', ipIds[i]          , [
          ['display_name', q(name)],
          ['domain', domain],
          ['group_type', q('IPAddress')],
          { b: 'criteria', body: [{ b: 'ipaddress_expression', body: [['ip_addresses', qlist(addrs.split(/\s+/).join(','))]] }] },
        ]),
      );
    });
    const umbrella = String(v.umbrella_group ?? '').trim();
    if (umbrella !== '' && tagIds.length > 0) {
      out.push(
        resource('nsxt_policy_group', 'umbrella', [
          ['display_name', q(umbrella)],
          ['description', q(`Every member of ${tagGroups.map(([g]) => g).join(', ')}`)],
          ['domain', domain],
          { b: 'criteria', body: [{ b: 'path_expression', body: [['member_paths', list(tagIds.map((id) => `nsxt_policy_group.${id}.path`))]] }] },
        ]),
      );
    }
    if (on(v.compound)) {
      const ips = String(v.compound_ips ?? '').trim().split(/\s+/).filter(Boolean);
      out.push(
        resource('nsxt_policy_group', 'compound', [
          ['display_name', q(v.compound_name)],
          ['domain', domain],
          // Conditions within a criteria are ANDed; criteria are joined by the conjunction between them.
          { b: 'criteria', body: [condition('Name', 'STARTSWITH', String(v.compound_prefix)), condition('Tag', 'EQUALS', String(v.compound_tag))] },
          ips.length > 0 && { b: 'conjunction', body: [['operator', q('OR')]] },
          ips.length > 0 && { b: 'criteria', body: [{ b: 'ipaddress_expression', body: [['ip_addresses', qlist(ips.join(','))]] }] },
        ]),
      );
    }
    const vms = pairs(v.vm_tags);
    const vmIds = uniqueIdents(vms.map(([name]) => name), 'vm');
    vms.forEach(([name, tags], i) => {
      const id = vmIds[i]          ;
      out.push(
        data('nsxt_policy_vm', id, [['display_name', q(name)]]),
        resource('nsxt_policy_vm_tags', id, [
          ['instance_id', `data.nsxt_policy_vm.${id}.instance_id`],
          ...tags
            .split(/\s+/)
            .filter(Boolean)
            .map((t)      => {
              const [scope = '', tag = ''] = t.split('|');
              return { b: 'tag', body: [['scope', q(scope)], ['tag', q(tag)]] };
            }),
        ]),
      );
    });
    return out.join('\n\n');
  },
});

const vpc = scenario('nsxt', {
  id: 'nsx_vpc',
  label: 'NSX project + VPC + subnets',
  description:
    'Multi-tenancy the NSX 4.2+ way: a project on an existing Tier-0 and edge cluster, an external IP block for public subnets, a VPC connectivity profile on the project transit gateway with default SNAT, and a VPC with public, private and isolated subnets.',
  inputs: [
    { id: 'project_name', label: 'Project', control: 'text', default: 'tenant-a' },
    { id: 't0_name', label: 'Existing Tier-0 gateway', control: 'text', default: 't0-gw01', hint: 'display name, looked up' },
    { id: 'edge_cluster_name', label: 'Edge cluster', control: 'text', default: 'edge-cluster-01', hint: 'display name, looked up' },
    { id: 'external_block', label: 'External IP block', control: 'text', default: '203.0.113.0/26', hint: 'public subnets and NAT addresses come from here' },
    { id: 'vpc_name', label: 'VPC', control: 'text', default: 'tenant-a-vpc01' },
    { id: 'private_ips', label: 'VPC private CIDRs', control: 'text', default: '172.16.0.0/16', hint: 'comma-separated' },
    {
      id: 'subnets',
      label: 'Subnets',
      control: 'textarea',
      default: 'web,Public,16\napp,Private,64\ndb,Private,64\nbackup,Isolated,172.31.0.0/24',
      hint: 'name,access mode,size or CIDR — one per line',
      help: 'Access mode is Public, Private, Isolated or Private_TGW. The third field is a number of addresses (a power of two) carved from the VPC\'s blocks, or an explicit CIDR — which Isolated subnets require.',
    },
    {
      id: 'dhcp_mode',
      label: 'Subnet DHCP',
      control: 'select',
      options: [
        { value: 'DHCP_SERVER', label: 'DHCP server' },
        { value: 'DHCP_DEACTIVATED', label: 'Off (static addresses)' },
      ],
      default: 'DHCP_SERVER',
    },
    { id: 'default_snat', label: 'Default SNAT for private subnets', control: 'select', options: YES_NO_OPTIONS, default: 'true' },
    { id: 'short_id', label: 'Project short ID', control: 'text', default: 'tena', hint: 'up to 8 characters, fixed once created', section: 'Advanced' },
  ],
  emits: ['nsxt_policy_ip_block', 'nsxt_policy_project', 'nsxt_vpc_connectivity_profile', 'nsxt_vpc', 'nsxt_vpc_attachment', 'nsxt_vpc_subnet'],
  body: (v) => {
    const findings            = [];
    const context = (vpcId         )      => ({
      b: 'context',
      body: [['project_id', 'nsxt_policy_project.project.id'], vpcId !== undefined && ['vpc_id', vpcId]],
    });
    const out           = [
      data('nsxt_policy_tier0_gateway', 't0', [['display_name', q(v.t0_name)]]),
      data('nsxt_policy_edge_cluster', 'edge', [['display_name', q(v.edge_cluster_name)]]),
      resource('nsxt_policy_ip_block', 'external', [
        ['display_name', q(`${v.project_name}-external`)],
        ['cidr', q(v.external_block)],
        ['visibility', q('EXTERNAL')],
      ]),
      resource('nsxt_policy_project', 'project', [
        ['display_name', q(v.project_name)],
        String(v.short_id ?? '').trim() !== '' && ['short_id', q(v.short_id)],
        ['tier0_gateway_paths', list(['data.nsxt_policy_tier0_gateway.t0.path'])],
        ['external_ipv4_blocks', list(['nsxt_policy_ip_block.external.path'])],
        { b: 'site_info', body: [['edge_cluster_paths', list(['data.nsxt_policy_edge_cluster.edge.path'])]] },
      ]),
      // Every project gets a default transit gateway; the VPCs attach to it.
      data('nsxt_policy_transit_gateway', 'default', [['is_default', 'true'], context()]),
      resource('nsxt_vpc_connectivity_profile', 'vpc', [
        ['display_name', q(`${v.vpc_name}-connectivity`)],
        ['transit_gateway_path', 'data.nsxt_policy_transit_gateway.default.path'],
        ['external_ip_blocks', list(['nsxt_policy_ip_block.external.path'])],
        context(),
        {
          b: 'service_gateway',
          body: [['enable', 'true'], ['edge_cluster_paths', list(['data.nsxt_policy_edge_cluster.edge.path'])], { b: 'nat_config', body: [['enable_default_snat', on(v.default_snat) ? 'true' : 'false']] }],
        },
      ]),
      resource('nsxt_vpc', 'vpc', [['display_name', q(v.vpc_name)], ['private_ips', qlist(v.private_ips)], context()]),
      resource('nsxt_vpc_attachment', 'vpc', [
        ['display_name', q(`${v.vpc_name}-attachment`)],
        ['parent_path', 'nsxt_vpc.vpc.path'],
        ['vpc_connectivity_profile', 'nsxt_vpc_connectivity_profile.vpc.path'],
      ]),
    ];
    const modes = new Set(['Public', 'Private', 'Isolated', 'Private_TGW', 'L2_ONLY']);
    const subnets = String(v.subnets ?? '')
      .split('\n')
      .map((l) => l.split(',').map((s) => s.trim()))
      .filter((f) => (f[0] ?? '') !== '');
    const ids = uniqueIdents(subnets.map((f) => f[0]          ), 'subnet');
    subnets.forEach(([name = '', modeText = 'Private', size = ''], i) => {
      const mode = [...modes].find((m) => m.toLowerCase() === modeText.toLowerCase()) ?? 'Private';
      if (!modes.has(modeText)) findings.push(warning('nsx.vpc.access-mode', `Subnet "${name}": "${modeText}" is not an access mode; using ${mode}.`, { path: 'subnets' }));
      const cidr = size.includes('/');
      if (mode === 'Isolated' && !cidr) findings.push(error('nsx.vpc.isolated-cidr', `Isolated subnet "${name}" needs an explicit CIDR.`, { path: 'subnets' }));
      out.push(
        resource('nsxt_vpc_subnet', ids[i]          , [
          ['display_name', q(name)],
          ['access_mode', q(mode)],
          cidr ? ['ip_addresses', qlist(size)] : ['ipv4_subnet_size', String(n(size, 64))],
          context('nsxt_vpc.vpc.id'),
          mode !== 'Isolated' && mode !== 'L2_ONLY' && { b: 'dhcp_config', body: [['mode', q(v.dhcp_mode)]] },
          // The subnets are carved from the blocks the attachment makes available.
          ['depends_on', list(['nsxt_vpc_attachment.vpc'])],
        ]),
      );
    });
    out.push(output('vpc_path', 'nsxt_vpc.vpc.path', 'Policy path of the VPC'));
    out.push(output('subnet_paths', map(subnets.map((f, i)                   => [f[0]          , `nsxt_vpc_subnet.${ids[i]}.path`])), 'Policy path of each subnet, by name'));
    return { hcl: out.join('\n\n'), findings };
  },
});

const hardenedSegment = scenario('nsxt', {
  id: 'nsx_segment_profiles',
  label: 'Segment with security, SpoofGuard and QoS profiles',
  description:
    'A hardened overlay segment on an existing Tier-1: a segment security profile (BPDU filter, DHCP server block, RA guard, broadcast/multicast rate limits), a SpoofGuard profile and a QoS profile with DSCP and rate shaping, all bound to it.',
  inputs: [
    { id: 'segment_name', label: 'Segment name', control: 'text', default: 'dmz-web' },
    { id: 'gateway_cidr', label: 'Gateway CIDR', control: 'text', default: '10.10.50.1/24' },
    { id: 't1_name', label: 'Existing Tier-1 gateway', control: 'text', default: 't1-app01', hint: 'display name, looked up' },
    { id: 'overlay_tz_name', label: 'Overlay transport zone', control: 'text', default: 'nsx-overlay-transportzone', hint: 'display name, looked up' },
    { id: 'dhcp_server_block', label: 'Block rogue DHCP servers', control: 'toggle', default: true },
    { id: 'ra_guard', label: 'IPv6 RA guard', control: 'toggle', default: true },
    { id: 'non_ip_block', label: 'Block non-IP traffic', control: 'toggle', default: false, hint: 'everything but IP, ARP and BPDU' },
    { id: 'rate_limits', label: 'Broadcast/multicast rate limits', control: 'toggle', default: true },
    { id: 'rx_broadcast', label: 'Rx broadcast', control: 'number', default: 1000, hint: 'packets/s', showWhen: { input: 'rate_limits', equals: ['true'] } },
    { id: 'rx_multicast', label: 'Rx multicast', control: 'number', default: 1000, hint: 'packets/s', showWhen: { input: 'rate_limits', equals: ['true'] } },
    { id: 'spoofguard', label: 'SpoofGuard (only bound addresses)', control: 'toggle', default: true },
    { id: 'qos', label: 'QoS profile', control: 'toggle', default: true },
    { id: 'dscp_priority', label: 'DSCP priority', control: 'number', default: 26, hint: '0–63, applied when not trusted', showWhen: { input: 'qos', equals: ['true'] } },
    { id: 'class_of_service', label: 'Class of service', control: 'number', default: 3, hint: '0–7', showWhen: { input: 'qos', equals: ['true'] } },
    { id: 'egress_mbps', label: 'Egress average', control: 'number', default: 1000, hint: 'Mbps, from the VMs', showWhen: { input: 'qos', equals: ['true'] } },
    { id: 'ingress_mbps', label: 'Ingress average', control: 'number', default: 1000, hint: 'Mbps, to the VMs', showWhen: { input: 'qos', equals: ['true'] } },
    TAGS_INPUT,
  ],
  emits: ['nsxt_policy_segment_security_profile', 'nsxt_policy_spoofguard_profile', 'nsxt_policy_qos_profile', 'nsxt_policy_segment'],
  body: (v) => {
    const seg = String(v.segment_name);
    const rate = on(v.rate_limits);
    const qos = on(v.qos);
    const shaper = (block        , mbps        )      => ({
      b: block,
      body: [['enabled', 'true'], ['average_bw_mbps', String(mbps)], ['peak_bw_mbps', String(mbps * 2)], ['burst_size', String(102400)]],
    });
    const out           = [
      data('nsxt_policy_tier1_gateway', 't1', [['display_name', q(v.t1_name)]]),
      data('nsxt_policy_transport_zone', 'overlay', [['display_name', q(v.overlay_tz_name)]]),
      resource('nsxt_policy_segment_security_profile', 'this', [
        ['display_name', q(`${seg}-security`)],
        ['bpdu_filter_enable', 'true'],
        ['dhcp_server_block_enabled', String(on(v.dhcp_server_block))],
        ['dhcp_server_block_v6_enabled', String(on(v.dhcp_server_block))],
        ['ra_guard_enabled', String(on(v.ra_guard))],
        ['non_ip_traffic_block_enabled', String(on(v.non_ip_block))],
        ['rate_limits_enabled', String(rate)],
        rate && { b: 'rate_limit', body: [['rx_broadcast', String(n(v.rx_broadcast, 1000))], ['rx_multicast', String(n(v.rx_multicast, 1000))]] },
      ]),
    ];
    if (on(v.spoofguard)) {
      out.push(resource('nsxt_policy_spoofguard_profile', 'this', [['display_name', q(`${seg}-spoofguard`)], ['address_binding_allowlist', 'true']]));
    }
    if (qos) {
      out.push(
        resource('nsxt_policy_qos_profile', 'this', [
          ['display_name', q(`${seg}-qos`)],
          ['class_of_service', String(n(v.class_of_service, 0))],
          ['dscp_trusted', 'false'],
          ['dscp_priority', String(n(v.dscp_priority, 0))],
          shaper('egress_rate_shaper', n(v.egress_mbps, 1000)),
          shaper('ingress_rate_shaper', n(v.ingress_mbps, 1000)),
        ]),
      );
    }
    out.push(
      resource('nsxt_policy_segment', 'this', [
        ['display_name', q(seg)],
        ['connectivity_path', 'data.nsxt_policy_tier1_gateway.t1.path'],
        ['transport_zone_path', 'data.nsxt_policy_transport_zone.overlay.path'],
        { b: 'subnet', body: [['cidr', q(v.gateway_cidr)]] },
        {
          b: 'security_profile',
          body: [['security_profile_path', 'nsxt_policy_segment_security_profile.this.path'], on(v.spoofguard) && ['spoofguard_profile_path', 'nsxt_policy_spoofguard_profile.this.path']],
        },
        qos && { b: 'qos_profile', body: [['qos_profile_path', 'nsxt_policy_qos_profile.this.path']] },
        ...tagBlocks(v.tags),
      ]),
    );
    out.push(output('segment_path', 'nsxt_policy_segment.this.path', 'Policy path of the segment'));
    return out.join('\n\n');
  },
});

const idsIps = scenario('nsxt', {
  id: 'nsx_ids_ips',
  label: 'Distributed IDS/IPS',
  description:
    'Distributed IDS/IPS turned on for the vSphere clusters named, a profile of the signature severities to act on, and a ThreatRules policy that detects — or detects and prevents — on traffic to the groups you protect.',
  inputs: [
    { id: 'clusters', label: 'Clusters to enable', control: 'textarea', default: 'domain-c8\ndomain-c1006', hint: 'vCenter cluster MoRef IDs, one per line' },
    {
      id: 'severities',
      label: 'Signature severities',
      control: 'checklist',
      options: [
        { value: 'CRITICAL', label: 'Critical' },
        { value: 'HIGH', label: 'High' },
        { value: 'MEDIUM', label: 'Medium' },
        { value: 'LOW', label: 'Low' },
        { value: 'SUSPICIOUS', label: 'Suspicious' },
      ],
      default: 'CRITICAL,HIGH,MEDIUM',
    },
    { id: 'protected_groups', label: 'Protect these groups', control: 'text', default: 'shop-web, shop-app', hint: 'existing group names, comma-separated, looked up' },
    {
      id: 'action',
      label: 'Action',
      control: 'select',
      options: [
        { value: 'DETECT', label: 'Detect only' },
        { value: 'DETECT_PREVENT', label: 'Detect and prevent' },
      ],
      default: 'DETECT',
    },
    {
      id: 'oversubscription',
      label: 'When the engine is oversubscribed',
      control: 'select',
      options: [
        { value: 'INHERIT_GLOBAL', label: 'Use the global setting' },
        { value: 'BYPASSED', label: 'Let traffic bypass IDS' },
        { value: 'DROPPED', label: 'Drop traffic' },
      ],
      default: 'INHERIT_GLOBAL',
      section: 'Advanced',
    },
    { id: 'auto_update', label: 'Auto-update signatures', control: 'toggle', default: true, hint: 'global IDS/IPS setting', section: 'Advanced' },
    { id: 'domain', label: 'Domain', control: 'text', default: 'default', section: 'Advanced' },
  ],
  emits: ['nsxt_policy_idps_settings', 'nsxt_policy_idps_cluster_config', 'nsxt_policy_intrusion_service_profile', 'nsxt_policy_intrusion_service_policy'],
  body: (v) => {
    const domain = q(v.domain || 'default');
    const groups = items(v.protected_groups);
    const groupIds = uniqueIdents(groups, 'group');
    const clusters = items(v.clusters);
    const out           = [
      ...groups.map((g, i) => data('nsxt_policy_group', groupIds[i]          , [['display_name', q(g)], ['domain', domain]])),
      resource('nsxt_policy_idps_settings', 'this', [['auto_update_signatures', String(on(v.auto_update))]]),
      ...clusters.map((c) =>
        resource('nsxt_policy_idps_cluster_config', ident(c.replace(/-/g, '_')), [
          ['display_name', q(`ids-${c}`)],
          ['ids_enabled', 'true'],
          { b: 'cluster', body: [['target_id', q(c)], ['target_type', q('VC_Cluster')]] },
        ]),
      ),
      resource('nsxt_policy_intrusion_service_profile', 'this', [
        ['display_name', q(`ids-${items(v.severities).join('-').toLowerCase() || 'profile'}`)],
        ['severities', qlist(v.severities)],
      ]),
    ];
    const refs = list(groupIds.map((id) => `data.nsxt_policy_group.${id}.path`));
    out.push(
      resource('nsxt_policy_intrusion_service_policy', 'this', [
        ['display_name', q('ids-protected-workloads')],
        ['domain', domain],
        ['category', q('ThreatRules')],
        {
          b: 'rule',
          body: [
            ['display_name', q(v.action === 'DETECT_PREVENT' ? 'detect-and-prevent' : 'detect')],
            groups.length > 0 && ['destination_groups', refs],
            groups.length > 0 && ['scope', refs],
            ['action', q(v.action)],
            ['oversubscription', q(v.oversubscription)],
            ['ids_profiles', list(['nsxt_policy_intrusion_service_profile.this.path'])],
            ['logged', 'true'],
          ],
        },
        // IDS rules only take effect once the clusters are enabled for it.
        clusters.length > 0 && ['depends_on', list(clusters.map((c) => `nsxt_policy_idps_cluster_config.${ident(c.replace(/-/g, '_'))}`))],
      ]),
    );
    return out.join('\n\n');
  },
});

export const NSX_SCENARIOS                       = [
  tier1Segments,
  tier0Bgp,
  threeTierDfw,
  gatewayFirewall,
  tier1Nat,
  vlanSegments,
  ipPoolsBlocks,
  groupsTags,
  vpc,
  hardenedSegment,
  idsIps,
];
