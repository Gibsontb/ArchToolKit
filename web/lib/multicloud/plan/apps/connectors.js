/**
 * Connectivity & cross-cloud connectors: every network connection one
 * application needs, named on both ends.
 *
 *   - back to the data centre: ExpressRoute / Direct Connect / Cloud
 *     Interconnect / FastConnect with a site-to-site VPN (or a VPN alone); on
 *     VCF the NSX Tier-0 gateway (BGP) or NSX IPsec VPN, and HCX for the move;
 *   - to each application it depends on (or that depends on it) placed on a
 *     DIFFERENT cloud: the two clouds' own interconnect where one exists
 *     (Oracle Interconnect for Microsoft Azure, Oracle Interconnect for Google
 *     Cloud, AWS Interconnect – multicloud with Google Cloud, Google
 *     Cross-Cloud Interconnect to Azure, Oracle Interconnect for AWS), else a
 *     site-to-site IPsec VPN between them.
 *
 * Each connector names the service on both ends, the bandwidth and latency
 * notes, the Terraform resources on each end (every one in the pinned
 * provider catalog, `terraform/catalog-data.ts`; a test checks), the vendor
 * source and its verification tag. It says whether this app's stack builds
 * its end: the data-centre link is the landing zone's Connectivity item
 * (`<p>_mig_connectivity`, from the sites on Constraints); a cross-cloud
 * connector is the app's own `<p>_app_connector` component (patterns/
 * connectors.ts), and the peer app's stack builds the other end. What cannot
 * be built (a preview with no Terraform resource, a missing site) is said,
 * never hidden.
 *
 * Facts as of 2026-09-26, read on the vendors' pages (V-DOC) unless tagged.
 */

                                                                         
import { PLATFORM_LABELS } from '../options.js';
import { appDatabases, appPlanOf, appWorkloads, findApp } from './components.js';

/** One end of a connection: a cloud, or the data centre. */
                                                
                                                                               

                                
                             
                                                       
                           
                                                                                         
                                        
                                                             
                                
 

                                  
                      
                        
                               
                                                          
                                    
                             
                           
                                                  
                                 
                          
                                      
                                      
 

// ---------------------------------------------------------------------------
// The data-centre links
// ---------------------------------------------------------------------------

const DC = (service = 'Your edge routers (BGP) and firewall')                => ({ end: 'on-prem', service, terraform: [] , noTerraform: 'The data centre\'s own routers: configured by the network team from the tunnel and BGP details the cloud side outputs.' });

export const ON_PREM_LINKS                                                                                                   = {
  azure: {
    circuit: {
      id: 'onprem-azure-expressroute', name: 'Azure ExpressRoute with a site-to-site VPN backup', kind: 'circuit-vpn',
      sides: [DC(), { end: 'azure', service: 'Azure ExpressRoute circuit and ExpressRoute gateway (VPN Gateway for the backup)', terraform: ['azurerm_express_route_circuit', 'azurerm_express_route_circuit_peering', 'azurerm_virtual_network_gateway', 'azurerm_virtual_network_gateway_connection', 'azurerm_local_network_gateway'] }],
      status: 'GA', bandwidth: 'Provider circuits 50 Mbps to 10 Gbps; ExpressRoute Direct 10 or 100 Gbps ports.',
      latency: 'Set by the distance to the peering location; no figure is published.',
      notes: 'ExpressRoute and a site-to-site VPN run side by side on the same virtual network; routing between them needs Azure Route Server.',
      sources: ['https://learn.microsoft.com/en-us/azure/expressroute/expressroute-faqs'], verification: 'V-DOC',
    },
    vpn: {
      id: 'onprem-azure-vpn', name: 'Azure VPN Gateway (site-to-site IPsec)', kind: 'vpn',
      sides: [DC(), { end: 'azure', service: 'Azure VPN Gateway (active-active, BGP)', terraform: ['azurerm_public_ip', 'azurerm_virtual_network_gateway', 'azurerm_local_network_gateway', 'azurerm_virtual_network_gateway_connection'] }],
      status: 'GA', bandwidth: 'By gateway SKU (VpnGw2AZ about 1.25 Gbps aggregate) [I].', latency: 'Over the internet: variable [I].',
      sources: ['https://learn.microsoft.com/en-us/azure/vpn-gateway/vpn-gateway-about-vpngateways'], verification: 'I',
    },
  },
  aws: {
    circuit: {
      id: 'onprem-aws-dx', name: 'AWS Direct Connect with a Site-to-Site VPN backup', kind: 'circuit-vpn',
      sides: [DC(), { end: 'aws', service: 'AWS Direct Connect (Direct Connect gateway, private or transit virtual interface) and AWS Site-to-Site VPN', terraform: ['aws_dx_gateway', 'aws_dx_gateway_association', 'aws_dx_private_virtual_interface', 'aws_dx_transit_virtual_interface', 'aws_customer_gateway', 'aws_vpn_connection', 'aws_ec2_transit_gateway'] }],
      status: 'GA', bandwidth: 'Dedicated ports 1, 10, 100 or 400 Gbps (MACsec on dedicated connections); hosted connections from a partner below 1 Gbps to 25 Gbps [I].',
      latency: 'Set by the distance to the Direct Connect location; no figure is published.',
      sources: ['https://docs.aws.amazon.com/directconnect/latest/UserGuide/dedicated_connection.html'], verification: 'V-DOC',
    },
    vpn: {
      id: 'onprem-aws-vpn', name: 'AWS Site-to-Site VPN', kind: 'vpn',
      sides: [DC(), { end: 'aws', service: 'AWS Site-to-Site VPN (two tunnels, BGP) on a transit gateway or virtual private gateway', terraform: ['aws_customer_gateway', 'aws_vpn_connection', 'aws_vpn_gateway', 'aws_ec2_transit_gateway'] }],
      status: 'GA', bandwidth: 'About 1.25 Gbps per tunnel [I].', latency: 'Over the internet: variable [I].',
      sources: ['https://docs.aws.amazon.com/vpn/latest/s2svpn/VPC_VPN.html'], verification: 'I',
    },
  },
  google: {
    circuit: {
      id: 'onprem-google-interconnect', name: 'Cloud Interconnect (Dedicated or Partner) with HA VPN', kind: 'circuit-vpn',
      sides: [DC(), { end: 'google', service: 'Cloud Interconnect VLAN attachments on a Cloud Router, and HA VPN', terraform: ['google_compute_router', 'google_compute_interconnect_attachment', 'google_compute_ha_vpn_gateway', 'google_compute_external_vpn_gateway', 'google_compute_vpn_tunnel', 'google_compute_router_peer'] }],
      status: 'GA', bandwidth: 'Dedicated Interconnect 10, 100 or 400 Gbps ports; Partner Interconnect attachments 50 Mbps to 50 Gbps. SLA 99.9% or 99.99%.',
      latency: 'Set by the colocation facility; MTU up to 8896.',
      sources: ['https://docs.cloud.google.com/network-connectivity/docs/interconnect/concepts/overview'], verification: 'V-DOC',
    },
    vpn: {
      id: 'onprem-google-havpn', name: 'Cloud VPN (HA VPN)', kind: 'vpn',
      sides: [DC(), { end: 'google', service: 'HA VPN gateway with a Cloud Router (BGP), 99.99% SLA', terraform: ['google_compute_ha_vpn_gateway', 'google_compute_external_vpn_gateway', 'google_compute_vpn_tunnel', 'google_compute_router', 'google_compute_router_interface', 'google_compute_router_peer'] }],
      status: 'GA', bandwidth: 'About 3 Gbps per tunnel [I].', latency: 'Over the internet: variable [I].',
      sources: ['https://docs.cloud.google.com/network-connectivity/docs/vpn/concepts/overview'], verification: 'I',
    },
  },
  oci: {
    circuit: {
      id: 'onprem-oci-fastconnect', name: 'OCI FastConnect with a Site-to-Site VPN backup', kind: 'circuit-vpn',
      sides: [DC(), { end: 'oci', service: 'OCI FastConnect private virtual circuit on the DRG, and Site-to-Site VPN (IPSec)', terraform: ['oci_core_drg', 'oci_core_virtual_circuit', 'oci_core_cpe', 'oci_core_ipsec'] }],
      status: 'GA', bandwidth: 'Partner circuits from a list chosen in the console and changeable later; colocation ports 1, 10, 100 or 400 Gbps [I].',
      latency: 'Set by the FastConnect location; IPSec over FastConnect is supported for encryption.',
      sources: ['https://docs.oracle.com/en-us/iaas/Content/Network/Concepts/fastconnect.htm'], verification: 'V-DOC',
    },
    vpn: {
      id: 'onprem-oci-vpn', name: 'OCI Site-to-Site VPN (IPSec)', kind: 'vpn',
      sides: [DC(), { end: 'oci', service: 'OCI Site-to-Site VPN on the DRG', terraform: ['oci_core_cpe', 'oci_core_ipsec', 'oci_core_ipsec_connection_tunnel_management'] }],
      status: 'GA', bandwidth: 'About 250 Mbps per tunnel [I].', latency: 'Over the internet: variable [I].',
      sources: ['https://docs.oracle.com/en-us/iaas/Content/Network/Tasks/managingIPsec.htm'], verification: 'I',
    },
  },
  vmware: {
    circuit: {
      id: 'onprem-vcf-t0', name: 'NSX Tier-0 gateway uplinks (BGP) to the data-centre core, and HCX for the move', kind: 'circuit',
      sides: [DC('The data-centre core routers (BGP peers of the Tier-0)'), { end: 'vmware', service: 'NSX Tier-0 gateway with BGP (dynamic BGP peering is new in VCF 9.1), and the HCX Interconnect / Network Extension from the source site', terraform: ['nsxt_policy_tier0_gateway', 'nsxt_policy_bgp_neighbor'], noTerraform: 'HCX: the vmware/hcx provider (0.5.x) is not in the pinned provider catalog, so the site pairing and service mesh are a runbook step (the Migration & Utilities execution kit drives HCX).' }],
      status: 'GA', bandwidth: 'The Edge nodes\' uplinks (10 / 25 / 100 GbE).', latency: 'Inside the data centre.',
      sources: ['https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-1/release-notes/vmware-cloud-foundation-9-1-0-0-release-notes/what-s-new/whats-new-nsx.html'], verification: 'V-DOC',
    },
    vpn: {
      id: 'onprem-vcf-ipsec', name: 'NSX IPsec VPN (route-based) from the Tier-0 gateway', kind: 'vpn',
      sides: [DC(), { end: 'vmware', service: 'NSX IPsec VPN service, local endpoint and route-based session on the Tier-0 gateway', terraform: ['nsxt_policy_ipsec_vpn_service', 'nsxt_policy_ipsec_vpn_local_endpoint', 'nsxt_policy_ipsec_vpn_session'] }],
      status: 'GA', bandwidth: 'Bounded by the Edge node size [I].', latency: 'Over the WAN or internet: variable [I].',
      sources: ['https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-1/release-notes/vmware-cloud-foundation-9-1-0-0-release-notes/what-s-new/whats-new-nsx.html'], verification: 'V-DOC',
    },
  },
};

// ---------------------------------------------------------------------------
// Cross-cloud
// ---------------------------------------------------------------------------

/** The VPN end on each platform, for the site-to-site fallback. */
export const VPN_SIDE                                            = {
  aws: { end: 'aws', service: 'AWS Site-to-Site VPN (customer gateway for the peer, VPN connection with two tunnels)', terraform: ['aws_vpn_gateway', 'aws_customer_gateway', 'aws_vpn_connection', 'aws_vpn_gateway_route_propagation'] },
  azure: { end: 'azure', service: 'Azure VPN Gateway (local network gateway for the peer, IPsec connection)', terraform: ['azurerm_public_ip', 'azurerm_virtual_network_gateway', 'azurerm_local_network_gateway', 'azurerm_virtual_network_gateway_connection'] },
  google: { end: 'google', service: 'Cloud VPN (HA VPN gateway, external VPN gateway for the peer, Cloud Router with BGP)', terraform: ['google_compute_ha_vpn_gateway', 'google_compute_external_vpn_gateway', 'google_compute_router', 'google_compute_vpn_tunnel', 'google_compute_router_interface', 'google_compute_router_peer'] },
  oci: { end: 'oci', service: 'OCI Site-to-Site VPN (CPE for the peer, IPSec connection on the DRG)', terraform: ['oci_core_cpe', 'oci_core_ipsec'] },
  vmware: { end: 'vmware', service: 'NSX IPsec VPN (route-based) on the Tier-0 gateway', terraform: ['nsxt_policy_ipsec_vpn_service', 'nsxt_policy_ipsec_vpn_local_endpoint', 'nsxt_policy_ipsec_vpn_session'] },
};

const pairKey = (a          , b          )         => [a, b].sort().join('|');

/** The clouds' own interconnects, by unordered pair. */
export const INTERCONNECTS                                            = {
  [pairKey('azure', 'oci')]: {
    id: 'oracle-interconnect-azure', name: 'Oracle Interconnect for Microsoft Azure', kind: 'interconnect',
    sides: [
      { end: 'azure', service: 'An ExpressRoute circuit with the provider "Oracle Cloud FastConnect", an ExpressRoute gateway and its connection', terraform: ['azurerm_express_route_circuit', 'azurerm_public_ip', 'azurerm_virtual_network_gateway', 'azurerm_virtual_network_gateway_connection'] },
      { end: 'oci', service: 'A FastConnect private virtual circuit (provider Microsoft Azure: ExpressRoute) on the DRG, given the ExpressRoute service key', terraform: ['oci_core_virtual_circuit'] },
    ],
    status: 'GA', bandwidth: 'The ExpressRoute circuit\'s size (1 to 10 Gbps).',
    latency: 'Paired regions in the same metro; under 2 ms is often quoted [I].',
    availability: 'Paired regions only: Tokyo, Singapore, Seoul, Frankfurt, Amsterdam, London, Johannesburg, Vinhedo/Campinas, Toronto, Ashburn/Washington DC, Phoenix, San Jose/Silicon Valley.',
    notes: 'No transit to on-premises through either cloud, and the two sides\' CIDRs must not overlap.',
    sources: ['https://docs.oracle.com/en-us/iaas/Content/multicloud/interconnect-azure.htm'], verification: 'V-DOC',
  },
  [pairKey('google', 'oci')]: {
    id: 'oracle-interconnect-google', name: 'Oracle Interconnect for Google Cloud (Partner Cross-Cloud Interconnect for OCI)', kind: 'interconnect',
    sides: [
      { end: 'google', service: 'Partner Interconnect VLAN attachments (a pairing key each) on a Cloud Router', terraform: ['google_compute_router', 'google_compute_interconnect_attachment'] },
      { end: 'oci', service: 'A FastConnect partner private virtual circuit on the DRG, given the pairing key', terraform: ['oci_core_virtual_circuit'] },
    ],
    status: 'GA', bandwidth: '1, 2, 5, 10, 20 or 50 Gbps; no data-transfer charge between the two clouds.',
    latency: 'Paired regions in the same metro [I].',
    availability: '14 region pairs, e.g. Ashburn–us-east4, Frankfurt–europe-west3, London–europe-west2, Tokyo–asia-northeast1, Sydney–australia-southeast1.',
    notes: 'Two BGP session pairs (/28 to /31), optional BFD, MTU 1500 recommended.',
    sources: ['https://docs.oracle.com/en-us/iaas/Content/multicloud/interconnect-gcp.htm', 'https://docs.cloud.google.com/network-connectivity/docs/interconnect/concepts/partner-cci-for-oci-overview'], verification: 'V-DOC',
  },
  [pairKey('aws', 'google')]: {
    id: 'aws-interconnect-google', name: 'AWS Interconnect – multicloud with Google Cloud (Partner Cross-Cloud Interconnect for AWS)', kind: 'interconnect',
    sides: [
      { end: 'aws', service: 'AWS Interconnect – multicloud, attached to a Direct Connect gateway (and the VPC\'s virtual private gateway)', terraform: ['aws_dx_gateway', 'aws_vpn_gateway', 'aws_dx_gateway_association'], noTerraform: 'The interconnect itself has no hashicorp/aws resource yet (terraform-provider-aws issue #47458): accept it in the console or API with the activation key from Google Cloud.' },
      { end: 'google', service: 'A Partner Cross-Cloud Interconnect transport (1 to 100 Gbps, provisioned in minutes)', terraform: ['google_network_connectivity_transport'] },
    ],
    status: 'GA', bandwidth: '1 to 100 Gbps, changeable in place; MACsec; one free local 500 Mbps interconnect per region on AWS.',
    latency: 'No figure is published; watch it with CloudWatch Network Synthetic Monitor.',
    availability: 'AWS GA 2026-04-14 (us-east-1, us-west-1, us-west-2, eu-west-2, eu-central-1); Google marks its side Preview.',
    sources: ['https://aws.amazon.com/about-aws/whats-new/2026/04/aws-announces-ga-AWS-interconnect-multicloud/', 'https://docs.cloud.google.com/network-connectivity/docs/interconnect/concepts/partner-cci-for-aws-overview'], verification: 'V-DOC',
  },
  [pairKey('azure', 'google')]: {
    id: 'google-cci-azure', name: 'Google Cross-Cloud Interconnect for Microsoft Azure', kind: 'interconnect',
    sides: [
      { end: 'azure', service: 'ExpressRoute Direct ports, an ExpressRoute circuit on them, an ExpressRoute gateway and its connection', terraform: ['azurerm_express_route_port', 'azurerm_express_route_circuit', 'azurerm_public_ip', 'azurerm_virtual_network_gateway', 'azurerm_virtual_network_gateway_connection'] },
      { end: 'google', service: 'A Cross-Cloud Interconnect (Google orders the ports into Azure) with VLAN attachments on a Cloud Router', terraform: ['google_compute_interconnect', 'google_compute_router', 'google_compute_interconnect_attachment'] },
    ],
    status: 'GA', bandwidth: '10 or 100 Gbps ports; 1 to 4 weeks to provision.', latency: 'Co-located edges in the same metro [I].',
    sources: ['https://docs.cloud.google.com/network-connectivity/docs/interconnect/concepts/cci-overview'], verification: 'V-DOC',
  },
  [pairKey('aws', 'oci')]: {
    id: 'oracle-interconnect-aws', name: 'Oracle Interconnect for AWS (AWS Interconnect – multicloud with OCI)', kind: 'interconnect',
    sides: [
      { end: 'aws', service: 'AWS Interconnect – multicloud, attached to a Direct Connect gateway (and the VPC\'s virtual private gateway)', terraform: ['aws_dx_gateway', 'aws_vpn_gateway', 'aws_dx_gateway_association'], noTerraform: 'The interconnect itself has no hashicorp/aws resource yet (terraform-provider-aws issue #47458): accept it with the activation key from OCI.' },
      { end: 'oci', service: 'A FastConnect virtual circuit on the DRG, joined by the activation key', terraform: ['oci_core_virtual_circuit'] },
    ],
    status: 'GA', bandwidth: '500 Mbps (billed as 1 Gbps), 1, 2, 5, 10, 20, 50 or 100 Gbps; MACsec and ECMP.',
    latency: 'Same metro (Ashburn) [I].',
    availability: 'GA 2026-07-29 per Oracle, only us-ashburn-1 ↔ us-east-1 (the AWS product page still lists OCI as planned).',
    sources: ['https://docs.oracle.com/en-us/iaas/Content/multicloud/interconnect-aws.htm', 'https://docs.oracle.com/en-us/iaas/releasenotes/console/interconnect-aws.htm'], verification: 'V-DOC',
  },
  [pairKey('aws', 'azure')]: {
    id: 'aws-interconnect-azure', name: 'AWS Interconnect – multicloud with Azure (Azure Multicloud Interconnect)', kind: 'interconnect',
    sides: [
      { end: 'aws', service: 'AWS Interconnect – multicloud on a Direct Connect gateway', terraform: [], noTerraform: 'Public preview (since 2026-08-31) with no hashicorp/aws resource.' },
      { end: 'azure', service: 'An ExpressRoute circuit of the "Azure Multicloud Interconnect" port type and a Multicloud Interconnect resource', terraform: [], noTerraform: 'Public preview with no azurerm resource (azapi only).' },
    ],
    status: 'preview', bandwidth: '1 Gbps only during the preview; no service or egress charge.',
    latency: 'Not published.',
    availability: 'AWS us-east-1, us-west-1, ap-southeast-2, eu-central-1 ↔ Azure East US, West US, Australia East, Germany West Central.',
    notes: 'A preview: for production use the site-to-site VPN (or a partner fabric such as Equinix or Megaport [I]).',
    sources: ['https://learn.microsoft.com/en-us/azure/multicloud-interconnect/overview', 'https://aws.amazon.com/about-aws/whats-new/2026/08/aws-announces-AWS-interconnect-multicloud-microsoft-azure-preview/'], verification: 'V-DOC',
  },
};

/** The site-to-site IPsec VPN between two platforms: the fallback for every pair. */
export function vpnBetween(a          , b          )                  {
  return {
    id: `vpn-${pairKey(a, b).replace('|', '-')}`,
    name: `Site-to-site IPsec VPN between ${PLATFORM_LABELS[a]} and ${PLATFORM_LABELS[b]}`,
    kind: 'vpn',
    sides: [VPN_SIDE[a], VPN_SIDE[b]],
    status: 'GA',
    bandwidth: 'About 1.25 Gbps (AWS) to 3 Gbps (Google Cloud HA VPN) per tunnel [I]; add tunnels (ECMP) for more.',
    latency: 'Over the internet between the regions: variable, tens of milliseconds between metros [I].',
    notes: 'BGP over two tunnels; each end is given the other\'s public address, ASN and pre-shared keys.',
    sources: ['https://docs.aws.amazon.com/vpn/latest/s2svpn/VPC_VPN.html', 'https://docs.cloud.google.com/network-connectivity/docs/vpn/concepts/overview'],
    verification: 'I',
  };
}

/** The interconnect between two platforms, if the clouds have one. VCF is on premises: none. */
export function interconnectBetween(a          , b          )                              {
  if (a === b || a === 'vmware' || b === 'vmware') return undefined;
  return INTERCONNECTS[pairKey(a, b)];
}

/** Can the given end of an option be built by Terraform in full? */
export const buildable = (side               )          => side.terraform.length > 0 && !side.noTerraform;

// ---------------------------------------------------------------------------
// One application's connectors
// ---------------------------------------------------------------------------

                               
                                                            
                      
                                                 
                                     
                          
                                                                    
                               
                                     
                         
                                                                                          
                                             
                                                 
                                                     
                                   
                                                                                     
                                                    
                             
                                                                             
                                                                                                  
                                                                                               
                                                                                                      
 

/** The platform an app is on, as far as the plan knows it: its choice, its design, or its saved recommendation. */
export function placedOn(ap                     )                       {
  return ap?.platform ?? ap?.design?.cloud ?? ap?.recommendation?.platform;
}

const BP                                     = { aws: 'aws', azure: 'azure', google: 'google', oci: 'oci', vmware: 'vsphere' };
const MBPS                                   = { '1g': 1000, '2g': 2000, '5g': 5000, '10g': 10000, '50g': 50000, '100g': 100000 };

/** The peer apps of an app, from the plan's edges and the servers' `dependsOn`, with direction and kind. */
export function appPeers(plan      , appId        )                                                                                   {
  const app = findApp(plan, appId);
  if (!app) return [];
  const owner = new Map                ();
  for (const a of plan.apps) {
    owner.set(a.name, a.name);
    for (const w of appWorkloads(plan, a)) owner.set(w.name, a.name);
    for (const d of appDatabases(plan, a)) owner.set(d.name, a.name);
  }
  const out = new Map                                                                     ();
  const note = (peer                    , dir              , kind                  )       => {
    if (!peer || peer === app.name) return;
    const e = out.get(peer) ?? { out: false, in: false, kinds: new Set() };
    e[dir] = true;
    e.kinds.add(kind);
    out.set(peer, e);
  };
  for (const e of plan.edges) {
    const from = owner.get(e.from);
    const to = owner.get(e.to);
    if (from === app.name) note(to, 'out', e.kind);
    else if (to === app.name) note(from, 'in', e.kind);
  }
  for (const w of plan.workloads) {
    const mine = owner.get(w.name) === app.name;
    for (const d of w.dependsOn) {
      if (d.startsWith('site:')) continue;
      const other = owner.get(d);
      if (mine) note(other, 'out', 'sync');
      else if (other === app.name) note(owner.get(w.name), 'in', 'sync');
    }
  }
  return [...out.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([name, e]) => ({ app: name, direction: e.out && e.in ? 'both' : e.out ? 'out' : 'in', kinds: [...e.kinds].sort() }));
}

/**
 * Every connection the app needs on `here`, chosen by the wizard's answers
 * (`onPremLink`, `crossCloud`, `linkBandwidth`). Pure.
 */
export function appConnectors(plan      , appId        , here          , answers                                                       = {})                 {
  const app = findApp(plan, appId);
  if (!app) return [];
  const one = (k        )         => {
    const v = answers[k];
    return Array.isArray(v) ? String(v[0] ?? '') : typeof v === 'string' ? v : '';
  };
  const bwAnswer = one('linkBandwidth') || '1g';
  const bandwidth = `${(MBPS[bwAnswer] ?? 1000) / 1000} Gbps`;
  const out                 = [];
  const req = plan.requirements;

  // The data centre.
  const link = one('onPremLink') || (req.sites.length > 0 ? (req.connection === 'vpn' ? 'vpn' : 'circuit-vpn') : 'none');
  if (link !== 'none') {
    const links = ON_PREM_LINKS[here];
    const option = link === 'vpn' ? links.vpn : links.circuit;
    const alternatives = [link === 'vpn' ? links.circuit : links.vpn];
    const sites = req.sites.map((s) => s.name);
    const build = here === 'vmware'
      ? { generated: false, reason: 'VCF on owned hardware is in the data centre: the Tier-0 uplinks and BGP are the NSX team\'s runbook, and HCX is driven by the execution kit (no Terraform provider in the catalog).' }
      : sites.length > 0
        ? { generated: true, by: `${BP[here]}_mig_connectivity (the landing zone's Connectivity item, from ${sites.join(', ')}); in a shared landing zone it comes from the landing-zone project` }
        : { generated: false, reason: 'No site on Constraints: add the data centre (VPN peer, BGP ASN, CIDRs, circuit) and the Connectivity item builds it.' };
    out.push({ id: 'dc', purpose: 'data-centre', here, there: 'on-prem', option, alternatives, bandwidth: req.sites[0]?.bandwidth ?? bandwidth, build });
  }

  // The peers on other clouds.
  const mode = one('crossCloud') || 'interconnect';
  for (const peer of appPeers(plan, app.id)) {
    const peerApp = findApp(plan, peer.app);
    const there = placedOn(peerApp ? appPlanOf(plan, peerApp.id) : undefined);
    if (!there || there === here) continue;
    if ((there === 'vmware' || here === 'vmware') && mode !== 'vpn') {
      // VCF runs in the data centre: the cloud's data-centre link (circuit or VPN) carries it.
      const cloud = here === 'vmware' ? there : here;
      out.push({
        id: `x:${peer.app}`, purpose: 'dependency', here, there, peer: peer.app, direction: peer.direction, kinds: peer.kinds,
        option: ON_PREM_LINKS[cloud].circuit, alternatives: [vpnBetween(here, there)], bandwidth,
        build: { generated: false, reason: `${peer.app} ${there === 'vmware' ? 'runs on VCF in the data centre' : 'is reached from VCF in the data centre'}: the ${PLATFORM_LABELS[cloud]} data-centre link carries this traffic (built with the landing zone's Connectivity item). Answer "Site-to-site VPN between the clouds" to build a direct NSX IPsec VPN instead.` },
      });
      continue;
    }
    const inter = interconnectBetween(here, there);
    const vpn = vpnBetween(here, there);
    if (mode === 'via-dc') {
      out.push({
        id: `x:${peer.app}`, purpose: 'dependency', here, there, peer: peer.app, direction: peer.direction, kinds: peer.kinds,
        option: vpn, alternatives: inter ? [inter] : [], bandwidth,
        build: { generated: false, reason: `Routed through the data centre, as answered: both clouds' data-centre links carry it (hair-pinned, adding the latency of two links).` },
      });
      continue;
    }
    const useInter = mode === 'interconnect' && inter && inter.status === 'GA';
    const option = useInter ? inter : vpn;
    const alternatives = [...(useInter ? [vpn] : inter ? [inter] : [])];
    const side = option.sides.find((s) => s.end === here) ?? option.sides[0];
    const settings                         = {
      blueprint: `${BP[here]}_app_connector`,
      peer: peer.app,
      peer_cloud: there,
      method: useInter ? 'interconnect' : 'vpn',
      bandwidth_mbps: String(MBPS[bwAnswer] ?? 1000),
    };
    const note = !useInter && mode === 'interconnect' && inter
      ? ` ${inter.name} is ${inter.status === 'preview' ? 'in preview with no Terraform resource' : 'available'}, so the VPN is built.`
      : '';
    out.push({
      id: `x:${peer.app}`, purpose: 'dependency', here, there, peer: peer.app, direction: peer.direction, kinds: peer.kinds,
      option, alternatives, bandwidth,
      build: side && side.terraform.length > 0
        ? { generated: true, by: `${BP[here]}_app_connector (this app's ${PLATFORM_LABELS[here]} end; ${peer.app}'s stack builds the ${PLATFORM_LABELS[there            ]} end).${side.noTerraform ? ` Not in Terraform: ${side.noTerraform}` : ''}${note}` }
        : { generated: false, reason: side?.noTerraform ?? 'No Terraform resource for this end.' },
      ...(side && side.terraform.length > 0 ? { component: { name: `connector-${peer.app}`, settings } } : {}),
    });
  }
  return out;
}
