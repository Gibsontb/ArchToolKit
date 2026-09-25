/**
 * Juniper Junos (EX, QFX, SRX, MX) network changes.
 *
 * Every change is Junos `set` / `delete` commands — what
 * `show configuration | display set` prints and `load set terminal` takes —
 * with `#` comments, which the loader skips. The back-out is `delete` of the
 * same hierarchy; `rollback 1` is always there too. The playbook applies the
 * same file with junipernetworks.junos.junos_config over NETCONF, which
 * commits with a comment.
 *
 * The blueprints live beside this file by area:
 *   junos-system.ts      baseline, users, AAA, root password and archive
 *   junos-interfaces.ts  routed, access, trunk, VLAN/IRB, ae, port settings
 *   junos-switching.ts   STP, storm control, LLDP, 802.1X, port security, VC
 *   junos-routing.ts     static, OSPF, OSPFv3, BGP, IS-IS, MPLS, instances,
 *                        policy, BFD, VRRP, ECMP
 *   junos-security.ts    SRX zones, address book, policies, NAT, IPsec, screens
 *   junos-filters.ts     firewall filters, CoS, EVPN-VXLAN
 */

                                                             
                                                         
import { PLATFORM } from './junos-common.js';
import { JUNOS_SYSTEM } from './junos-system.js';
import { JUNOS_INTERFACES } from './junos-interfaces.js';
import { JUNOS_SWITCHING } from './junos-switching.js';
import { JUNOS_ROUTING } from './junos-routing.js';
import { JUNOS_SECURITY } from './junos-security.js';
import { JUNOS_DATA_CENTER, JUNOS_FILTERS } from './junos-filters.js';

const ALL                             = [
  ...JUNOS_SYSTEM,
  ...JUNOS_INTERFACES,
  ...JUNOS_SWITCHING,
  ...JUNOS_ROUTING,
  ...JUNOS_SECURITY,
  ...JUNOS_FILTERS,
  ...JUNOS_DATA_CENTER,
];

export const JUNOS_NETWORK                 = {
  target: PLATFORM,
  label: 'Juniper Junos (EX, QFX, SRX, MX)',
  blueprints: ALL,
};

export const JUNOS_CHANGES                             = ALL;
