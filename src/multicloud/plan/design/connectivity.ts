/**
 * Connectivity: how each on-premises site reaches each cloud.
 *
 * The method is the requirement's (vpn / circuit / circuit-with-vpn-backup),
 * narrowed per site and platform: a site's circuit reaches only its own cloud
 * (Direct Connect → AWS, ExpressRoute → Azure, Interconnect → Google Cloud
 * (GCP), FastConnect → OCI), so a site with no circuit to this cloud gets a
 * VPN. VPNs are HA: two tunnels (BGP). Circuits cannot be ordered offline:
 * their connection id or service key is a variable the generators declare.
 * VCF on owned hardware is on-premises: nothing to connect.
 */

import { error, info, warning, type Finding } from '../../../core/findings.ts';
import { familyOf } from '../../../core/ip.ts';
import { CLOUD_ASN } from '../options.ts';
import type { Circuit, Connection, Platform, Site } from '../types.ts';
import type { DesignMapper } from './index.ts';

/** The circuit types that reach each cloud. */
export const CIRCUITS_FOR: Readonly<Record<Platform, readonly Circuit[]>> = {
  aws: ['direct-connect'],
  azure: ['expressroute'],
  google: ['interconnect-dedicated', 'interconnect-partner'],
  oci: ['fastconnect'],
  vmware: [],
};

/** VPN tunnels per site connection: two (HA, BGP) wherever a VPN is part of it. */
export function tunnelsFor(method: Connection): number {
  return method === 'circuit' ? 0 : 2;
}

/** Azure reserves these ASNs; a site cannot use them (verify the list). */
export const AZURE_RESERVED_ASNS: readonly number[] = Object.freeze([8074, 8075, 12076, 65515, 65516, 65517, 65518, 65519, 65520]);

/** The method for one site on one platform, and why it was narrowed. */
export function methodFor(requested: Connection, site: Site, platform: Platform): { method: Connection; narrowed?: string } {
  const circuit = CIRCUITS_FOR[platform].includes(site.circuit);
  if (requested === 'vpn') return { method: 'vpn' };
  if (circuit) return { method: requested };
  const why = site.circuit === 'none'
    ? `site ${site.name} has no private circuit`
    : `site ${site.name}'s ${site.circuit} circuit does not reach ${platform}`;
  return { method: 'vpn', narrowed: why };
}

export const connectivityMapper: DesignMapper = {
  id: 'connectivity',
  map(ctx, design) {
    const findings: Finding[] = [];
    const { platform, plan } = ctx;
    if (platform === 'vmware') return { design: { ...design, connectivity: [] }, findings };
    const cloudAsn = CLOUD_ASN[platform];
    const connectivity = plan.requirements.sites.map((site) => {
      const { method, narrowed } = methodFor(plan.requirements.connection, site, platform);
      if (narrowed) {
        findings.push(warning('design.connectivity.vpn-instead', `${platform}: ${narrowed}, so it connects by VPN.`, {
          remediation: `Order a ${CIRCUITS_FOR[platform].join(' or ')} circuit for ${site.name}, or accept the VPN.`,
        }));
      }
      if (tunnelsFor(method) > 0) {
        if (!site.vpnPeer?.trim()) {
          findings.push(warning('design.connectivity.no-peer', `${site.name}: a VPN to ${platform} needs the site's public VPN peer address.`, { path: `requirements.sites.${site.name}.vpnPeer` }));
        } else if (familyOf(site.vpnPeer) === null) {
          findings.push(error('design.connectivity.bad-peer', `${site.name}: "${site.vpnPeer}" is not an IPv4 or IPv6 address.`, { path: `requirements.sites.${site.name}.vpnPeer` }));
        }
      }
      if (method !== 'vpn') {
        findings.push(info('design.connectivity.circuit-id', `${site.name}: the ${site.circuit} circuit's connection id or service key comes from the provider or partner; it is a variable in the generated files.`));
      }
      if (site.bgpAsn === undefined) {
        findings.push(warning('design.connectivity.no-asn', `${site.name}: no BGP ASN is set for the site; the connection to ${platform} uses BGP.`, { path: `requirements.sites.${site.name}.bgpAsn` }));
      } else if (site.bgpAsn === cloudAsn || (platform === 'azure' && AZURE_RESERVED_ASNS.includes(site.bgpAsn))) {
        findings.push(error('design.connectivity.asn-clash', `${site.name}: BGP ASN ${site.bgpAsn} is ${site.bgpAsn === cloudAsn ? `${platform}'s own` : 'reserved by Azure'}; give the site another.`, {
          path: `requirements.sites.${site.name}.bgpAsn`,
        }));
      }
      return { site: site.name, method, cloudAsn };
    });
    return { design: { ...design, connectivity }, findings };
  },
};
