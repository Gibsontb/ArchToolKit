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
import { EOS_NETWORK, EOS_CHANGES } from './eos.ts';
import { PANOS_NETWORK, PANOS_CHANGES } from './panos.ts';
import { FORTIOS_NETWORK, FORTIOS_CHANGES } from './fortios.ts';
import { F5_NETWORK, F5_CHANGES } from './f5.ts';

export const NETWORK_BLUEPRINTS: readonly BlueprintGroup[] = [IOS_NETWORK, NXOS_NETWORK, EOS_NETWORK, PANOS_NETWORK, FORTIOS_NETWORK, F5_NETWORK];

/** Every blueprint, with its structured change builder, by id. */
export const NETWORK_CHANGES: readonly ChangeBlueprint[] = [...IOS_CHANGES, ...NXOS_CHANGES, ...EOS_CHANGES, ...PANOS_CHANGES, ...FORTIOS_CHANGES, ...F5_CHANGES];

export function networkChange(id: string): ChangeBlueprint | undefined {
  return NETWORK_CHANGES.find((b) => b.id === id);
}
