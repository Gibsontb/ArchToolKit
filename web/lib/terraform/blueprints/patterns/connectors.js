/**
 * `<p>_app_connector` (the decision wizard's "Connectivity & cross-cloud
 * connectors" card): this app's end of a connection to an application on
 * another cloud. The peer app's own stack builds the other end, from the same
 * catalogue (`multicloud/plan/apps/connectors.ts`), so each stack owns what
 * lives in its cloud and nothing reaches across.
 *
 * method = interconnect (the clouds' own interconnect, where one exists)
 *   AWS     A Direct Connect gateway associated with the VPC's virtual private
 *           gateway: AWS Interconnect – multicloud (Google Cloud, OCI)
 *           attaches to it. The interconnect itself has no hashicorp/aws
 *           resource yet, so accepting it is a console / API step (a finding).
 *   Azure   Oracle Interconnect for Microsoft Azure: an ExpressRoute circuit
 *           with the provider "Oracle Cloud FastConnect". Google Cloud
 *           Cross-Cloud Interconnect: ExpressRoute Direct ports and a circuit
 *           on them. Either way an ExpressRoute gateway and its connection.
 *   Google  To OCI: two Partner Interconnect VLAN attachments (their pairing
 *           keys go to OCI) on a Cloud Router with ASN 16550. To AWS: a
 *           Partner Cross-Cloud Interconnect transport. To Azure: a
 *           Cross-Cloud Interconnect and a VLAN attachment on it.
 *   OCI     A FastConnect private virtual circuit on the landing zone's DRG,
 *           given the peer's service key / pairing key / activation key.
 *
 * method = vpn (site-to-site IPsec, BGP; the fallback everywhere)
 *   AWS     virtual private gateway, customer gateway, VPN connection (two
 *           tunnels), route propagation into the network's route table
 *   Azure   VPN Gateway (active-active, BGP), local network gateway, IPsec
 *           connection
 *   Google  HA VPN gateway, external VPN gateway, Cloud Router, two tunnels
 *           with their BGP interfaces and peers
 *   OCI     CPE and IPSec connection on the DRG
 *   vSphere NSX IPsec VPN (route-based) on the Tier-0 gateway (VCF 9.1)
 *
 * The peer's public address, pre-shared keys and service / pairing keys are
 * variables (sensitive where they are secrets); nothing is written that only
 * the other cloud knows. A virtual network has one VPN gateway and one
 * ExpressRoute gateway, and a VPC one virtual private gateway: when the
 * landing zone's Connectivity item already built one, give its id in
 * `existing_gateway_id` and the connector uses it.
 */

import { info,              } from '../../../core/findings.js';
                                                                                            
import { num as numberOf, str as valueOf } from '../../../kit/blueprint.js';
                                             
import { LANDING_ZONE_SOURCE, blk, dat, hcl, ident, lzRef, output, q, res, rname, secretVariable, variable, x,               } from '../migration/common.js';
import { NETWORK_INPUT, PATTERN_GROUP, VSPHERE_SERVER_INPUT, appInputs, appOf, listOf, namePrefix, patternMainTf, preamble, tagsExpr } from './common.js';

                                              

const PEERS = [
  { value: 'aws', label: 'AWS' },
  { value: 'azure', label: 'Azure' },
  { value: 'google', label: 'Google Cloud (GCP)' },
  { value: 'oci', label: 'OCI' },
  { value: 'vmware', label: 'VMware Cloud Foundation' },
  { value: 'on-prem', label: 'The data centre' },
];

function inputs(platform                   )                   {
  return [
    ...appInputs(),
    ...(platform === 'vsphere' ? [VSPHERE_SERVER_INPUT] : [NETWORK_INPUT]),
    { id: 'peer', label: 'Peer', control: 'text', default: 'peer', hint: 'The application (or site) on the other end; names the resources and variables.' },
    { id: 'peer_cloud', label: 'Peer cloud', control: 'select', default: 'azure', options: PEERS },
    { id: 'method', label: 'Method', control: 'select', default: 'vpn', options: [{ value: 'interconnect', label: 'The clouds\' interconnect' }, { value: 'vpn', label: 'Site-to-site IPsec VPN' }] },
    { id: 'peer_cidrs', label: 'Peer CIDRs', control: 'text', default: '', hint: 'Space-separated address ranges on the other end (blank: a variable to supply).' },
    { id: 'peer_asn', label: 'Peer BGP ASN', control: 'number', default: 65010, min: 1 },
    { id: 'cloud_asn', label: 'This side\'s BGP ASN', control: 'number', default: platform === 'azure' ? 65515 : platform === 'google' ? 64514 : 64512, min: 1, hint: 'Google Partner Interconnect needs 16550 on the Cloud Router; the connector sets it.' },
    { id: 'bandwidth_mbps', label: 'Bandwidth (Mbps)', control: 'number', default: 1000, min: 50 },
    ...(platform === 'azure' || platform === 'google'
      ? [{ id: 'peering_location', label: 'Peering / interconnect location', control: 'text'         , default: '', hint: 'Azure ExpressRoute peering location (e.g. Washington DC); Google Cross-Cloud Interconnect location URL. Blank: a variable.' }]
      : []),
    ...(platform === 'google' ? [{ id: 'remote_profile', label: 'Transport remote profile', control: 'text'         , default: '', hint: 'Partner Cross-Cloud Interconnect for AWS: the AWS remote profile (region) to connect to. Blank: a variable.' }] : []),
    ...(platform === 'vsphere'
      ? [
          { id: 'nsx_manager', label: 'NSX Manager', control: 'text'         , default: 'wld01-nsx01.example.com' },
          { id: 'tier0', label: 'Tier-0 gateway', control: 'text'         , default: 'wld01-t0', hint: 'The Tier-0 gateway the VPN runs on.' },
          { id: 'local_address', label: 'VPN local endpoint address', control: 'text'         , default: '', hint: 'An address on the Tier-0 uplink (blank: a variable).' },
        ]
      : [{ id: 'existing_gateway_id', label: 'Existing gateway id', control: 'text'         , default: '', hint: 'Use a gateway the landing zone already has (VPC virtual private gateway, Azure VNet gateway) instead of creating one.' }]),
    ...(platform === 'vsphere' ? [] : [LANDING_ZONE_SOURCE]),
  ];
}

               
                                   
                               
                      
                       
                        
                             
                                                       
                     
                           
 

function ctxOf(values                 , findings           )      {
  const app = appOf(values);
  const peer = rname(valueOf(values, 'peer', 'peer')) || 'peer';
  return {
    values, findings,
    lz: lzRef(values),
    net: rname(valueOf(values, 'network', 'prod')),
    peer,
    peerCloud: valueOf(values, 'peer_cloud', 'azure'),
    v: ident(app.id, 'to', peer),
    cidrs: listOf(values, 'peer_cidrs'),
  };
}

/** The peer's ranges: the input, else a variable. */
function cidrsExpr(c     , blocks            )         {
  if (c.cidrs.length > 0) return `[${c.cidrs.map(q).join(', ')}]`;
  blocks.push(variable(`${c.v}_cidrs`, 'list(string)', `The address ranges of ${c.peer} on ${c.peerCloud}.`));
  return `var.${c.v}_cidrs`;
}

/** A value from an input, else a variable of that name. */
function inputOrVar(c     , blocks            , input        , name        , description        )         {
  const v = valueOf(c.values, input).trim();
  if (v) return q(v);
  blocks.push(variable(`${c.v}_${name}`, 'string', description));
  return `var.${c.v}_${name}`;
}

const PEER_LABEL                                   = { aws: 'AWS', azure: 'Azure', google: 'Google Cloud', oci: 'OCI', vmware: 'VCF', 'on-prem': 'the data centre' };

// ---------------------------------------------------------------------------
// AWS
// ---------------------------------------------------------------------------

function aws(values                 , findings           )             {
  const c = ctxOf(values, findings);
  const app = appOf(values);
  const pfx = namePrefix(values, app);
  const tags = x(tagsExpr(app, 'aws', { atk_peer: c.peer }));
  const blocks             = [...preamble('aws', values)];
  const existing = valueOf(values, 'existing_gateway_id').trim();
  const vgw = existing ? q(existing) : 'aws_vpn_gateway.connector.id';
  if (!existing) {
    blocks.push(res('aws_vpn_gateway', 'connector', { vpc_id: x(`${c.lz}.network_ids[${q(c.net)}]`), amazon_side_asn: numberOf(values, 'cloud_asn', 64512), tags }));
    blocks.push(res('aws_vpn_gateway_route_propagation', 'connector', {
      for_each: x(`{ for k, v in ${c.lz}.route_table_ids : k => v if k == ${q(c.net)} }`),
      vpn_gateway_id: x(vgw),
      route_table_id: x('each.value'),
    }));
  }
  if (valueOf(values, 'method', 'vpn') === 'interconnect' && (c.peerCloud === 'google' || c.peerCloud === 'oci')) {
    blocks.push(
      res('aws_dx_gateway', 'connector', { name: x(`"${pfx}-${c.peer}-dxgw"`), amazon_side_asn: String(numberOf(values, 'cloud_asn', 64512) + 1) }),
      res('aws_dx_gateway_association', 'connector', { dx_gateway_id: x('aws_dx_gateway.connector.id'), associated_gateway_id: x(vgw), allowed_prefixes: x(`[${c.lz}.network_cidrs[${q(c.net)}][0]]`) }),
      output('dx_gateway_id', 'aws_dx_gateway.connector.id', `The Direct Connect gateway AWS Interconnect – multicloud to ${PEER_LABEL[c.peerCloud]} attaches to.`),
    );
    findings.push(info('tf.app.connector.aws-interconnect', `${app.name} ↔ ${c.peer}: AWS Interconnect – multicloud has no hashicorp/aws resource yet (terraform-provider-aws issue #47458). Create or accept it in the console or API with the activation key from ${PEER_LABEL[c.peerCloud]}, attached to the Direct Connect gateway this stack outputs.`, { source: 'https://aws.amazon.com/blogs/aws/aws-interconnect-is-now-generally-available-with-a-new-option-to-simplify-last-mile-connectivity/' }));
    return blocks;
  }
  blocks.push(
    secretVariable(`${c.v}_psk_1`, `Pre-shared key for tunnel 1 to ${c.peer}.`),
    secretVariable(`${c.v}_psk_2`, `Pre-shared key for tunnel 2 to ${c.peer}.`),
    variable(`${c.v}_peer_address`, 'string', `The public address of ${c.peer}'s VPN gateway on ${PEER_LABEL[c.peerCloud] ?? c.peerCloud}.`),
    res('aws_customer_gateway', 'connector', { bgp_asn: String(numberOf(values, 'peer_asn', 65010)), ip_address: x(`var.${c.v}_peer_address`), type: 'ipsec.1', tags }),
    res('aws_vpn_connection', 'connector', {
      vpn_gateway_id: x(vgw),
      customer_gateway_id: x('aws_customer_gateway.connector.id'),
      type: 'ipsec.1',
      static_routes_only: false,
      tunnel1_preshared_key: x(`var.${c.v}_psk_1`),
      tunnel2_preshared_key: x(`var.${c.v}_psk_2`),
      tunnel1_ike_versions: ['ikev2'],
      tunnel2_ike_versions: ['ikev2'],
      tags,
    }),
    output('tunnel_addresses', '[aws_vpn_connection.connector.tunnel1_address, aws_vpn_connection.connector.tunnel2_address]', `Give these to ${c.peer}'s side as its peer addresses.`),
  );
  return blocks;
}

// ---------------------------------------------------------------------------
// Azure
// ---------------------------------------------------------------------------

function azure(values                 , findings           )             {
  const c = ctxOf(values, findings);
  const app = appOf(values);
  const pfx = namePrefix(values, app);
  const tags = x(tagsExpr(app, 'azure', { atk_peer: c.peer }));
  const rg = `${c.lz}.resource_group[${q(c.net)}]`;
  const loc = `${c.lz}.location`;
  const gwSubnet = `${c.lz}.subnet_ids[${q(`${c.net}/GatewaySubnet`)}]`;
  const blocks             = [...preamble('azure', values)];
  const existing = valueOf(values, 'existing_gateway_id').trim();
  const interconnect = valueOf(values, 'method', 'vpn') === 'interconnect' && (c.peerCloud === 'oci' || c.peerCloud === 'google');

  if (interconnect) {
    const bw = numberOf(values, 'bandwidth_mbps', 1000);
    const location = inputOrVar(c, blocks, 'peering_location', 'peering_location', `The ExpressRoute peering location for ${c.peer} (a location the ${c.peerCloud === 'oci' ? 'Oracle Interconnect region pair' : 'Cross-Cloud Interconnect'} offers).`);
    if (c.peerCloud === 'oci') {
      blocks.push(res('azurerm_express_route_circuit', 'connector', {
        name: x(`"${pfx}-${c.peer}-er"`), resource_group_name: x(rg), location: x(loc),
        service_provider_name: 'Oracle Cloud FastConnect', peering_location: x(location), bandwidth_in_mbps: bw, tags,
      }, [blk('sku', { tier: 'Standard', family: 'MeteredData' })]));
      blocks.push(output('service_key', 'azurerm_express_route_circuit.connector.service_key', `Give it to OCI: the FastConnect virtual circuit to ${c.peer} (provider Microsoft Azure: ExpressRoute) takes it.`, true));
      findings.push(info('tf.app.connector.azure-oci', `${app.name} ↔ ${c.peer}: Oracle Interconnect for Microsoft Azure. OCI provisions the private peering from the service key; the connection completes once both sides are provisioned.`, { source: 'https://docs.oracle.com/en-us/iaas/Content/multicloud/interconnect-azure.htm' }));
    } else {
      const gbps = bw >= 100000 ? 100 : 10;
      blocks.push(
        res('azurerm_express_route_port', 'connector', { name: x(`"${pfx}-${c.peer}-erd"`), resource_group_name: x(rg), location: x(loc), peering_location: x(location), bandwidth_in_gbps: gbps, encapsulation: 'Dot1Q', tags }),
        res('azurerm_express_route_circuit', 'connector', {
          name: x(`"${pfx}-${c.peer}-er"`), resource_group_name: x(rg), location: x(loc),
          express_route_port_id: x('azurerm_express_route_port.connector.id'), bandwidth_in_gbps: gbps, tags,
        }, [blk('sku', { tier: 'Standard', family: 'MeteredData' })]),
      );
      findings.push(info('tf.app.connector.azure-google', `${app.name} ↔ ${c.peer}: Google Cross-Cloud Interconnect lands on these ExpressRoute Direct ports (${gbps} Gbps); give Google the port's Letter of Authorization.`, { source: 'https://docs.cloud.google.com/network-connectivity/docs/interconnect/concepts/cci-overview' }));
    }
    const gw = existing ? q(existing) : 'azurerm_virtual_network_gateway.connector.id';
    if (!existing) {
      blocks.push(
        res('azurerm_public_ip', 'connector', { name: x(`"${pfx}-${c.peer}-ergw-pip"`), location: x(loc), resource_group_name: x(rg), allocation_method: 'Static', sku: 'Standard', zones: ['1', '2', '3'], tags }),
        res('azurerm_virtual_network_gateway', 'connector', { name: x(`"${pfx}-${c.peer}-ergw"`), location: x(loc), resource_group_name: x(rg), type: 'ExpressRoute', sku: 'ErGw1AZ', tags }, [
          blk('ip_configuration', { name: 'er', subnet_id: x(gwSubnet), public_ip_address_id: x('azurerm_public_ip.connector.id'), private_ip_address_allocation: 'Dynamic' }),
        ]),
      );
    }
    blocks.push(res('azurerm_virtual_network_gateway_connection', 'connector', {
      name: x(`"${pfx}-${c.peer}"`), location: x(loc), resource_group_name: x(rg), type: 'ExpressRoute',
      virtual_network_gateway_id: x(gw), express_route_circuit_id: x('azurerm_express_route_circuit.connector.id'), tags,
    }));
    return blocks;
  }

  // VPN.
  const gw = existing ? q(existing) : 'azurerm_virtual_network_gateway.connector.id';
  if (!existing) {
    blocks.push(
      res('azurerm_public_ip', 'connector', { count: 2, name: x(`"${pfx}-${c.peer}-vpngw-pip-\${count.index + 1}"`), location: x(loc), resource_group_name: x(rg), allocation_method: 'Static', sku: 'Standard', zones: ['1', '2', '3'], tags }),
      res('azurerm_virtual_network_gateway', 'connector', {
        name: x(`"${pfx}-${c.peer}-vpngw"`), location: x(loc), resource_group_name: x(rg),
        type: 'Vpn', vpn_type: 'RouteBased', sku: 'VpnGw2AZ', generation: 'Generation2', active_active: true, bgp_enabled: true, tags,
      }, [
        blk('ip_configuration', { name: 'gw1', subnet_id: x(gwSubnet), public_ip_address_id: x('azurerm_public_ip.connector[0].id'), private_ip_address_allocation: 'Dynamic' }),
        blk('ip_configuration', { name: 'gw2', subnet_id: x(gwSubnet), public_ip_address_id: x('azurerm_public_ip.connector[1].id'), private_ip_address_allocation: 'Dynamic' }),
        blk('bgp_settings', { asn: numberOf(values, 'cloud_asn', 65515) }, [
          blk('peering_addresses', { ip_configuration_name: 'gw1', apipa_addresses: ['169.254.21.1'] }),
          blk('peering_addresses', { ip_configuration_name: 'gw2', apipa_addresses: ['169.254.22.1'] }),
        ]),
      ]),
      output('gateway_addresses', 'azurerm_public_ip.connector[*].ip_address', `Give these to ${c.peer}'s side as its peer addresses.`),
    );
  }
  blocks.push(
    variable(`${c.v}_peer_address`, 'string', `The public address of ${c.peer}'s VPN gateway on ${PEER_LABEL[c.peerCloud] ?? c.peerCloud}.`),
    secretVariable(`${c.v}_psk`, `Pre-shared key for the connection to ${c.peer}.`),
  );
  const cidrs = cidrsExpr(c, blocks);
  blocks.push(
    res('azurerm_local_network_gateway', 'connector', {
      name: x(`"${pfx}-${c.peer}"`), location: x(loc), resource_group_name: x(rg), gateway_address: x(`var.${c.v}_peer_address`), address_space: x(cidrs), tags,
    }, [blk('bgp_settings', { asn: numberOf(values, 'peer_asn', 65010), bgp_peering_address: '169.254.21.2' })]),
    res('azurerm_virtual_network_gateway_connection', 'connector', {
      name: x(`"${pfx}-${c.peer}"`), location: x(loc), resource_group_name: x(rg), type: 'IPsec',
      virtual_network_gateway_id: x(gw), local_network_gateway_id: x('azurerm_local_network_gateway.connector.id'),
      shared_key: x(`var.${c.v}_psk`), connection_protocol: 'IKEv2', bgp_enabled: true, tags,
    }),
  );
  return blocks;
}

// ---------------------------------------------------------------------------
// Google Cloud
// ---------------------------------------------------------------------------

function google(values                 , findings           )             {
  const c = ctxOf(values, findings);
  const app = appOf(values);
  const pfx = namePrefix(values, app);
  const network = `${c.lz}.network_ids[${q(c.net)}]`;
  const region = `${c.lz}.region`;
  const blocks             = [...preamble('google', values)];
  const method = valueOf(values, 'method', 'vpn');

  if (method === 'interconnect' && c.peerCloud === 'aws') {
    const profile = inputOrVar(c, blocks, 'remote_profile', 'remote_profile', `The AWS remote profile (region) of the Partner Cross-Cloud Interconnect transport to ${c.peer}.`);
    blocks.push(
      res('google_network_connectivity_transport', 'connector', { name: x(`"${pfx}-${c.peer}"`), region: x(region), network: x(network), remote_profile: x(profile), description: `Partner Cross-Cloud Interconnect for AWS to ${c.peer}` }),
      output('transport', 'google_network_connectivity_transport.connector.id', `The transport; its activation key goes to AWS Interconnect – multicloud for ${c.peer}.`),
    );
    findings.push(info('tf.app.connector.google-aws', `${app.name} ↔ ${c.peer}: Partner Cross-Cloud Interconnect for AWS is Preview on Google Cloud's side (AWS lists AWS Interconnect – multicloud as GA since 2026-04-14). Check the remote profile names in the Google Cloud documentation.`, { source: 'https://docs.cloud.google.com/network-connectivity/docs/interconnect/concepts/partner-cci-for-aws-overview' }));
    return blocks;
  }
  if (method === 'interconnect' && c.peerCloud === 'oci') {
    blocks.push(
      res('google_compute_router', 'connector', { name: x(`"${pfx}-${c.peer}-cr"`), region: x(region), network: x(network) }, [blk('bgp', { asn: 16550 })]),
      ...[1, 2].map((n) => res('google_compute_interconnect_attachment', `connector_${n}`, {
        name: x(`"${pfx}-${c.peer}-${n}"`), region: x(region), router: x('google_compute_router.connector.id'),
        type: 'PARTNER', edge_availability_domain: `AVAILABILITY_DOMAIN_${n}`, admin_enabled: true, mtu: '1500',
      })),
      output('pairing_keys', '[google_compute_interconnect_attachment.connector_1.pairing_key, google_compute_interconnect_attachment.connector_2.pairing_key]', `Give these to OCI: the FastConnect partner virtual circuits to ${c.peer} take them.`, true),
    );
    findings.push(info('tf.app.connector.google-oci', `${app.name} ↔ ${c.peer}: Oracle Interconnect for Google Cloud. Partner Interconnect needs ASN 16550 on the Cloud Router; OCI completes the circuits from the pairing keys.`, { source: 'https://docs.oracle.com/en-us/iaas/Content/multicloud/interconnect-gcp.htm' }));
    return blocks;
  }
  if (method === 'interconnect' && c.peerCloud === 'azure') {
    const location = inputOrVar(c, blocks, 'peering_location', 'interconnect_location', `The Cross-Cloud Interconnect location URL for ${c.peer} (Azure).`);
    const gbps = numberOf(values, 'bandwidth_mbps', 10000) >= 100000 ? '100G' : '10G';
    blocks.push(
      variable(`${c.v}_remote_location`, 'string', `The Azure remote location of the Cross-Cloud Interconnect to ${c.peer}.`),
      res('google_compute_interconnect', 'connector', {
        name: x(`"${pfx}-${c.peer}-cci"`), interconnect_type: 'DEDICATED', link_type: `LINK_TYPE_ETHERNET_${gbps}_LR`, requested_link_count: 1,
        location: x(location), remote_location: x(`var.${c.v}_remote_location`), admin_enabled: true,
      }),
      res('google_compute_router', 'connector', { name: x(`"${pfx}-${c.peer}-cr"`), region: x(region), network: x(network) }, [blk('bgp', { asn: numberOf(values, 'cloud_asn', 64514) })]),
      res('google_compute_interconnect_attachment', 'connector', {
        name: x(`"${pfx}-${c.peer}"`), region: x(region), router: x('google_compute_router.connector.id'),
        type: 'DEDICATED', interconnect: x('google_compute_interconnect.connector.id'), vlan_tag8021q: 100, admin_enabled: true,
      }),
    );
    return blocks;
  }

  // HA VPN.
  blocks.push(
    variable(`${c.v}_peer_address`, 'string', `The public address of ${c.peer}'s VPN gateway on ${PEER_LABEL[c.peerCloud] ?? c.peerCloud}.`),
    secretVariable(`${c.v}_psk`, `Pre-shared key for the tunnels to ${c.peer}.`),
    res('google_compute_ha_vpn_gateway', 'connector', { name: x(`"${pfx}-${c.peer}-vpn"`), region: x(region), network: x(network) }),
    res('google_compute_external_vpn_gateway', 'connector', { name: x(`"${pfx}-${c.peer}-peer"`), redundancy_type: 'SINGLE_IP_INTERNALLY_REDUNDANT' }, [
      blk('interface', { id: 0, ip_address: x(`var.${c.v}_peer_address`) }),
    ]),
    res('google_compute_router', 'connector', { name: x(`"${pfx}-${c.peer}-cr"`), region: x(region), network: x(network) }, [blk('bgp', { asn: numberOf(values, 'cloud_asn', 64514) })]),
  );
  for (const n of [0, 1]) {
    blocks.push(
      res('google_compute_vpn_tunnel', `connector_${n}`, {
        name: x(`"${pfx}-${c.peer}-t${n}"`), region: x(region), vpn_gateway: x('google_compute_ha_vpn_gateway.connector.id'), vpn_gateway_interface: n,
        peer_external_gateway: x('google_compute_external_vpn_gateway.connector.id'), peer_external_gateway_interface: 0,
        shared_secret: x(`var.${c.v}_psk`), router: x('google_compute_router.connector.id'), ike_version: 2,
      }),
      res('google_compute_router_interface', `connector_${n}`, {
        name: x(`"${pfx}-${c.peer}-if${n}"`), region: x(region), router: x('google_compute_router.connector.name'),
        ip_range: `169.254.3${n}.1/30`, vpn_tunnel: x(`google_compute_vpn_tunnel.connector_${n}.name`),
      }),
      res('google_compute_router_peer', `connector_${n}`, {
        name: x(`"${pfx}-${c.peer}-bgp${n}"`), region: x(region), router: x('google_compute_router.connector.name'),
        peer_ip_address: `169.254.3${n}.2`, peer_asn: numberOf(values, 'peer_asn', 65010), interface: x(`google_compute_router_interface.connector_${n}.name`),
      }),
    );
  }
  blocks.push(output('gateway_addresses', 'google_compute_ha_vpn_gateway.connector.vpn_interfaces[*].ip_address', `Give these to ${c.peer}'s side as its peer addresses.`));
  return blocks;
}

// ---------------------------------------------------------------------------
// OCI
// ---------------------------------------------------------------------------

function oci(values                 , findings           )             {
  const c = ctxOf(values, findings);
  const app = appOf(values);
  const pfx = namePrefix(values, app);
  const tags = x(tagsExpr(app, 'oci', { atk_peer: c.peer }));
  const comp = `${c.lz}.compartment_id`;
  const blocks             = [...preamble('oci', values)];
  if (valueOf(values, 'method', 'vpn') === 'interconnect' && (c.peerCloud === 'azure' || c.peerCloud === 'google' || c.peerCloud === 'aws')) {
    const provider = c.peerCloud === 'azure' ? 'Microsoft Azure: ExpressRoute' : c.peerCloud === 'google' ? 'Google Cloud: OCI Interconnect' : 'AWS Interconnect';
    const keyName = c.peerCloud === 'azure' ? 'service key of the ExpressRoute circuit' : c.peerCloud === 'google' ? 'pairing key of the Partner Interconnect VLAN attachment' : 'activation key of AWS Interconnect – multicloud';
    const bw = numberOf(values, 'bandwidth_mbps', 1000);
    blocks.push(
      variable(`${c.v}_provider_service_id`, 'string', `The OCID of the FastConnect provider service "${provider}" (oci network fast-connect-provider-service list).`),
      secretVariable(`${c.v}_provider_key`, `The ${keyName} to ${c.peer}.`),
      res('oci_core_virtual_circuit', 'connector', {
        compartment_id: x(comp), display_name: x(`"${pfx}-${c.peer}"`), type: 'PRIVATE', gateway_id: x(`${c.lz}.drg_id`),
        provider_service_id: x(`var.${c.v}_provider_service_id`), provider_service_key_name: x(`var.${c.v}_provider_key`),
        bandwidth_shape_name: bw >= 1000 ? `${Math.round(bw / 1000)} Gbps` : `${bw} Mbps`, freeform_tags: tags,
      }, c.peerCloud === 'azure'
        ? [
            blk('cross_connect_mappings', { customer_bgp_peering_ip: '10.255.250.2/30', oracle_bgp_peering_ip: '10.255.250.1/30' }),
            blk('cross_connect_mappings', { customer_bgp_peering_ip: '10.255.250.6/30', oracle_bgp_peering_ip: '10.255.250.5/30' }),
          ]
        : []),
    );
    findings.push(info('tf.app.connector.oci-interconnect', `${app.name} ↔ ${c.peer}: a FastConnect virtual circuit (${provider}) on the landing zone's DRG. ${c.peerCloud === 'azure' ? 'The BGP /30s are 10.255.250.0/29: change them to what you give Azure\'s private peering.' : ''}`.trim(), { source: c.peerCloud === 'azure' ? 'https://docs.oracle.com/en-us/iaas/Content/multicloud/interconnect-azure.htm' : c.peerCloud === 'google' ? 'https://docs.oracle.com/en-us/iaas/Content/multicloud/interconnect-gcp.htm' : 'https://docs.oracle.com/en-us/iaas/Content/multicloud/interconnect-aws.htm' }));
    return blocks;
  }
  blocks.push(variable(`${c.v}_peer_address`, 'string', `The public address of ${c.peer}'s VPN gateway on ${PEER_LABEL[c.peerCloud] ?? c.peerCloud}.`));
  const cidrs = cidrsExpr(c, blocks);
  blocks.push(
    res('oci_core_cpe', 'connector', { compartment_id: x(comp), ip_address: x(`var.${c.v}_peer_address`), display_name: x(`"${pfx}-${c.peer}"`), freeform_tags: tags }),
    res('oci_core_ipsec', 'connector', { compartment_id: x(comp), cpe_id: x('oci_core_cpe.connector.id'), drg_id: x(`${c.lz}.drg_id`), static_routes: x(cidrs), display_name: x(`"${pfx}-${c.peer}"`), freeform_tags: tags }),
    output('ipsec_id', 'oci_core_ipsec.connector.id', `The IPSec connection to ${c.peer}; its tunnels' Oracle addresses are on the connection's details.`),
  );
  findings.push(info('tf.app.connector.oci-vpn', `${app.name} ↔ ${c.peer}: the IPSec connection routes statically to the peer's ranges; switch the tunnels to BGP in the tunnel management settings if the peer speaks BGP.`));
  return blocks;
}

// ---------------------------------------------------------------------------
// vSphere (VCF 9.1): NSX IPsec VPN
// ---------------------------------------------------------------------------

function vsphere(values                 , findings           )             {
  const c = ctxOf(values, findings);
  const app = appOf(values);
  const name = `${rname(app.name)}-${c.peer}`;
  const blocks             = [
    {
      type: 'terraform',
      attributes: [{ name: 'required_version', value: x('">= 1.7.0"') }],
      blocks: [{ type: 'required_providers', attributes: [{ name: 'nsxt', value: x('{\n      source  = "vmware/nsxt"\n      version = "~> 3.12"\n    }') }] }],
    },
    { type: 'provider', labels: ['nsxt'], attributes: [
      { name: 'host', value: x(q(valueOf(values, 'nsx_manager', 'nsx.example.com'))) },
      { name: 'username', value: x('var.nsxt_username') },
      { name: 'password', value: x('var.nsxt_password') },
    ] },
    variable('nsxt_username', 'string', 'The NSX Manager account Terraform signs in with (TF_VAR_nsxt_username).'),
    secretVariable('nsxt_password', 'The password of the NSX Manager account.'),
    dat('nsxt_policy_tier0_gateway', 'connector', { display_name: valueOf(values, 'tier0', 'wld01-t0') }),
    variable(`${c.v}_peer_address`, 'string', `The public address of ${c.peer}'s VPN gateway on ${PEER_LABEL[c.peerCloud] ?? c.peerCloud}.`),
    secretVariable(`${c.v}_psk`, `Pre-shared key for the session to ${c.peer}.`),
  ];
  const local = inputOrVar(c, blocks, 'local_address', 'local_address', `An address on the Tier-0 uplink for the VPN to ${c.peer}.`);
  blocks.push(
    res('nsxt_policy_ipsec_vpn_service', 'connector', { display_name: `${name}-vpn`, gateway_path: x('data.nsxt_policy_tier0_gateway.connector.path'), enabled: true }),
    res('nsxt_policy_ipsec_vpn_local_endpoint', 'connector', { display_name: `${name}-le`, service_path: x('nsxt_policy_ipsec_vpn_service.connector.path'), local_address: x(local) }),
    res('nsxt_policy_ipsec_vpn_session', 'connector', {
      display_name: name, service_path: x('nsxt_policy_ipsec_vpn_service.connector.path'), local_endpoint_path: x('nsxt_policy_ipsec_vpn_local_endpoint.connector.path'),
      vpn_type: 'RouteBased', authentication_mode: 'PSK', psk: x(`var.${c.v}_psk`),
      peer_address: x(`var.${c.v}_peer_address`), peer_id: x(`var.${c.v}_peer_address`), ip_addresses: ['169.254.40.1'], prefix_length: 30, enabled: true,
    }),
  );
  findings.push(info('tf.app.connector.nsx-vpn', `${app.name} ↔ ${c.peer}: a route-based NSX IPsec VPN on the Tier-0 gateway (tunnel interface 169.254.40.1/30); add the BGP neighbour on the Tier-0 for the peer's side (169.254.40.2).`, { source: 'https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-1/release-notes/vmware-cloud-foundation-9-1-0-0-release-notes/what-s-new/whats-new-nsx.html' }));
  return blocks;
}

// ---------------------------------------------------------------------------

const EMITS                                                         = {
  aws: ['aws_vpn_gateway', 'aws_vpn_gateway_route_propagation', 'aws_customer_gateway', 'aws_vpn_connection', 'aws_dx_gateway', 'aws_dx_gateway_association'],
  azure: ['azurerm_public_ip', 'azurerm_virtual_network_gateway', 'azurerm_local_network_gateway', 'azurerm_virtual_network_gateway_connection', 'azurerm_express_route_circuit', 'azurerm_express_route_port'],
  google: ['google_compute_ha_vpn_gateway', 'google_compute_external_vpn_gateway', 'google_compute_router', 'google_compute_vpn_tunnel', 'google_compute_router_interface', 'google_compute_router_peer', 'google_compute_interconnect_attachment', 'google_compute_interconnect', 'google_network_connectivity_transport'],
  oci: ['oci_core_cpe', 'oci_core_ipsec', 'oci_core_virtual_circuit'],
  vsphere: ['nsxt_policy_ipsec_vpn_service', 'nsxt_policy_ipsec_vpn_local_endpoint', 'nsxt_policy_ipsec_vpn_session'],
};

const LABEL                                              = { aws: 'AWS', azure: 'Azure', google: 'Google Cloud', oci: 'OCI', vsphere: 'VCF (NSX)' };

function connector(platform                   )            {
  return {
    id: `${platform}_app_connector`,
    label: `App connector on ${LABEL[platform]}`,
    group: PATTERN_GROUP,
    description: {
      aws: 'This app\'s AWS end of a link to an app on another cloud: a Site-to-Site VPN, or the Direct Connect gateway AWS Interconnect – multicloud attaches to.',
      azure: 'This app\'s Azure end: a VPN Gateway connection, or an ExpressRoute circuit (Oracle Interconnect for Microsoft Azure, or ExpressRoute Direct for Google Cross-Cloud Interconnect) with its gateway.',
      google: 'This app\'s Google Cloud end: HA VPN, Partner Interconnect attachments to OCI, a Partner Cross-Cloud Interconnect transport to AWS, or a Cross-Cloud Interconnect to Azure.',
      oci: 'This app\'s OCI end: a Site-to-Site VPN, or a FastConnect virtual circuit for Oracle Interconnect for Azure / Google Cloud / AWS.',
      vsphere: 'This app\'s VCF end: an NSX IPsec VPN (route-based) on the Tier-0 gateway.',
    }[platform],
    inputs: inputs(platform),
    emits: EMITS[platform],
    build: (values                 ) => {
      const findings            = [];
      const blocks = platform === 'aws' ? aws(values, findings) : platform === 'azure' ? azure(values, findings) : platform === 'google' ? google(values, findings) : platform === 'oci' ? oci(values, findings) : vsphere(values, findings);
      return { files: { 'main.tf': patternMainTf(blocks, `Connector to ${valueOf(values, 'peer', 'peer')} (${valueOf(values, 'method', 'vpn')}): ${appOf(values).name}`) }, findings };
    },
  };
}

export const CONNECTOR_BLUEPRINTS                       = (['aws', 'azure', 'google', 'oci', 'vsphere']         ).map(connector);
void hcl;
