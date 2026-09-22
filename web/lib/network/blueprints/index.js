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

export const NETWORK_BLUEPRINTS                            = [
  IOS_NETWORK,
  NXOS_NETWORK,
  WLC_NETWORK,
  ASA_NETWORK,
  EOS_NETWORK,
  PANOS_NETWORK,
  FORTIOS_NETWORK,
  F5_NETWORK,
];

/** Every blueprint, with its structured change builder, by id. */
export const NETWORK_CHANGES                             = [
  ...IOS_CHANGES,
  ...NXOS_CHANGES,
  ...WLC_CHANGES,
  ...ASA_CHANGES,
  ...EOS_CHANGES,
  ...PANOS_CHANGES,
  ...FORTIOS_CHANGES,
  ...F5_CHANGES,
];

export function networkChange(id        )                              {
  return NETWORK_CHANGES.find((b) => b.id === id);
}
