/**
 * Every network change, grouped by the platform it is for.
 *
 * The platform here is a device operating system rather than a cloud, so this
 * page keeps its own selection instead of writing into the toolkit-wide cloud:
 * "I am working on Cisco IOS" says nothing about which cloud the Terraform
 * page should open on.
 */

                                                             
                                                         
import { IOS_NETWORK, IOS_CHANGES } from './ios.js';
import { NXOS_NETWORK, NXOS_CHANGES } from './nxos.js';
import { WLC_NETWORK, WLC_CHANGES } from './wlc.js';
import { ASA_NETWORK, ASA_CHANGES } from './asa.js';
import { EOS_NETWORK, EOS_CHANGES } from './eos.js';
import { PANOS_NETWORK, PANOS_CHANGES } from './panos.js';
import { FORTIOS_NETWORK, FORTIOS_CHANGES } from './fortios.js';
import { F5_NETWORK, F5_CHANGES } from './f5.js';
import { JUNOS_NETWORK, JUNOS_CHANGES } from './junos.js';
import { AOSCX_NETWORK, AOSCX_CHANGES } from './aoscx.js';
import { IOSXR_NETWORK, IOSXR_CHANGES } from './iosxr.js';
import { FMC_NETWORK, FMC_CHANGES } from './fmc.js';

/**
 * A platform's blueprints with each heading's together, in the order the
 * headings first appear: a vendor's blueprints come from several files, and
 * the picker opens a new heading every time the heading changes.
 */
function byHeading(group                )                 {
  const order                         = [];
  for (const blueprint of group.blueprints) if (!order.includes(blueprint.group)) order.push(blueprint.group);
  const blueprints = order.flatMap((heading) => group.blueprints.filter((blueprint) => blueprint.group === heading));
  return { ...group, blueprints };
}

export const NETWORK_BLUEPRINTS                            = [
  IOS_NETWORK,
  NXOS_NETWORK,
  IOSXR_NETWORK,
  WLC_NETWORK,
  ASA_NETWORK,
  FMC_NETWORK,
  EOS_NETWORK,
  JUNOS_NETWORK,
  AOSCX_NETWORK,
  PANOS_NETWORK,
  FORTIOS_NETWORK,
  F5_NETWORK,
].map(byHeading);

/** Every blueprint, with its structured change builder, by id. */
export const NETWORK_CHANGES                             = [
  ...IOS_CHANGES,
  ...NXOS_CHANGES,
  ...IOSXR_CHANGES,
  ...WLC_CHANGES,
  ...ASA_CHANGES,
  ...FMC_CHANGES,
  ...EOS_CHANGES,
  ...JUNOS_CHANGES,
  ...AOSCX_CHANGES,
  ...PANOS_CHANGES,
  ...FORTIOS_CHANGES,
  ...F5_CHANGES,
];

export function networkChange(id        )                              {
  return NETWORK_CHANGES.find((b) => b.id === id);
}
