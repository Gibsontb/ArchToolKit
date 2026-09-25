/**
 * Every network change, grouped by the platform it is for.
 *
 * The platform here is a device operating system rather than a cloud, so this
 * page keeps its own selection instead of writing into the toolkit-wide cloud:
 * "I am working on Cisco IOS" says nothing about which cloud the Terraform
 * page should open on.
 */

import type { BlueprintGroup } from '../../kit/blueprint.ts';
import type { ChangeBlueprint } from '../from-change.ts';
import { IOS_NETWORK, IOS_CHANGES } from './ios.ts';
import { NXOS_NETWORK, NXOS_CHANGES } from './nxos.ts';
import { WLC_NETWORK, WLC_CHANGES } from './wlc.ts';
import { ASA_NETWORK, ASA_CHANGES } from './asa.ts';
import { EOS_NETWORK, EOS_CHANGES } from './eos.ts';
import { PANOS_NETWORK, PANOS_CHANGES } from './panos.ts';
import { FORTIOS_NETWORK, FORTIOS_CHANGES } from './fortios.ts';
import { F5_NETWORK, F5_CHANGES } from './f5.ts';
import { JUNOS_NETWORK, JUNOS_CHANGES } from './junos.ts';
import { AOSCX_NETWORK, AOSCX_CHANGES } from './aoscx.ts';
import { IOSXR_NETWORK, IOSXR_CHANGES } from './iosxr.ts';
import { FMC_NETWORK, FMC_CHANGES } from './fmc.ts';

/**
 * A platform's blueprints with each heading's together, in the order the
 * headings first appear: a vendor's blueprints come from several files, and
 * the picker opens a new heading every time the heading changes.
 */
function byHeading(group: BlueprintGroup): BlueprintGroup {
  const order: (string | undefined)[] = [];
  for (const blueprint of group.blueprints) if (!order.includes(blueprint.group)) order.push(blueprint.group);
  const blueprints = order.flatMap((heading) => group.blueprints.filter((blueprint) => blueprint.group === heading));
  return { ...group, blueprints };
}

export const NETWORK_BLUEPRINTS: readonly BlueprintGroup[] = [
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
export const NETWORK_CHANGES: readonly ChangeBlueprint[] = [
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

export function networkChange(id: string): ChangeBlueprint | undefined {
  return NETWORK_CHANGES.find((b) => b.id === id);
}
