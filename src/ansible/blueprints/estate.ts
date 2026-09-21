/**
 * Ansible blueprints that build from the imported estate.
 *
 * Choose a source cluster and the VMs, their addresses, folders, snapshots,
 * DRS rules and custom attributes come from the estate rather than from
 * whoever is typing.
 */

import type { Blueprint, BlueprintInput, BlueprintValues } from '../../kit/blueprint.ts';
import { str } from '../../kit/blueprint.ts';
import { currentEstate } from '../../kit/estate-store.ts';
import { estateInventoryFiles, postmigrationFiles, premigrationFiles } from '../estate.ts';

export const ESTATE_GROUP = 'From your estate';

const SCOPE: readonly BlueprintInput[] = [
  {
    id: 'source_cluster',
    label: 'Source cluster',
    control: 'combo',
    blankLabel: 'Choose a cluster from the estate',
    hint: 'Import an RVTools export at the top of the page and its clusters are listed here.',
  },
  { id: 'source_folder', label: 'Only VMs in folder', control: 'combo', blankLabel: 'Every folder' },
];

const scope = (values: BlueprintValues) => ({
  cluster: str(values, 'source_cluster'),
  folder: str(values, 'source_folder') || undefined,
});

export function inventoryBlueprint(os: 'all' | 'windows' | 'linux'): Blueprint {
  const which = os === 'all' ? '' : os === 'windows' ? 'Windows ' : 'Linux ';
  return {
    id: `estate_inventory_${os}`,
    label: `Inventory of a cluster’s ${which}VMs`,
    group: ESTATE_GROUP,
    description: `hosts.yml for the ${which}VMs in a source cluster: grouped by OS, cluster and folder, with the address each guest reported — what guest-side plays before and after a move run against.`,
    inputs: [
      ...SCOPE,
      {
        id: 'include_powered_off',
        label: 'Include powered-off VMs',
        control: 'select',
        default: 'no',
        options: [
          { value: 'no', label: 'No' },
          { value: 'yes', label: 'Yes' },
        ],
      },
    ],
    emits: [],
    build: (values) => {
      const result = estateInventoryFiles(currentEstate()?.inventory, {
        ...scope(values),
        includePoweredOff: str(values, 'include_powered_off') === 'yes',
        os,
      });
      return { files: result.files, findings: result.findings };
    },
  };
}

export const PREMIGRATION: Blueprint = {
  id: 'estate_premigration',
  label: 'Before the move: snapshots and worklist',
  group: ESTATE_GROUP,
  description:
    'A play against the source vCenter: reports every VM the readiness checks flagged, and removes snapshots from the VMs that have them — only when run with remove_snapshots=true.',
  inputs: SCOPE,
  emits: ['community.vmware.vmware_guest_snapshot'],
  build: (values) => {
    const result = premigrationFiles(currentEstate()?.inventory, scope(values));
    return { files: result.files, findings: result.findings };
  },
};

export const POSTMIGRATION: Blueprint = {
  id: 'estate_postmigration',
  label: 'After the move: DRS rules and attributes',
  group: ESTATE_GROUP,
  description:
    'A play against the target vCenter: recreates the DRS affinity and anti-affinity rules between the moved VMs and puts their custom attributes back.',
  inputs: [
    ...SCOPE,
    { id: 'target_datacenter', label: 'Target datacenter', control: 'text', default: 'wld01-dc' },
    { id: 'target_cluster', label: 'Target cluster', control: 'text', default: 'wld01-cl01' },
    {
      id: 'carry_attributes',
      label: 'Carry custom attributes',
      control: 'select',
      default: 'yes',
      options: [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No' },
      ],
    },
  ],
  emits: ['community.vmware.vmware_vm_vm_drs_rule', 'community.vmware.vmware_guest_custom_attributes'],
  build: (values) => {
    const result = postmigrationFiles(currentEstate()?.inventory, {
      ...scope(values),
      targetDatacenter: str(values, 'target_datacenter'),
      targetCluster: str(values, 'target_cluster'),
      carryAttributes: str(values, 'carry_attributes', 'yes') === 'yes',
    });
    return { files: result.files, findings: result.findings };
  },
};
