/**
 * Terraform blueprints that build from the imported estate.
 *
 * The same form as every other blueprint — pick, fill in, generate — except
 * the answer comes from the estate: which cluster to move, and everything the
 * estate knows about its VMs, networks, folders, pools and rules. With no
 * estate loaded they still generate, empty, and say why.
 */

                                                                                         
import { str } from '../../kit/blueprint.js';
import { currentEstate } from '../../kit/estate-store.js';
                                                          
import { rehostFiles, vsphereLandingFiles, REHOST_EMITS, LANDING_EMITS } from '../estate.js';
import { AWS_REGIONS, AZURE_REGIONS, GCP_ZONES, OCI_REGIONS } from './regions.js';

export const ESTATE_GROUP = 'From your estate';

const YES_NO = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
];

const SCOPE_INPUTS                            = [
  {
    id: 'source_cluster',
    label: 'Source cluster',
    control: 'combo',
    blankLabel: 'Choose a cluster from the estate',
    hint: 'Import an RVTools export at the top of the page and its clusters are listed here.',
  },
  {
    id: 'source_folder',
    label: 'Only VMs in folder',
    control: 'combo',
    blankLabel: 'Every folder',
  },
];

const opts = (values                   ) => values.map((v) => ({ value: v, label: v }));

const REGIONS                                                                                       = {
  aws: { label: 'Region', options: AWS_REGIONS, fallback: 'us-east-1' },
  azure: { label: 'Location', options: AZURE_REGIONS, fallback: 'eastus' },
  google: { label: 'Zone', options: GCP_ZONES, fallback: 'us-central1-a' },
  oci: { label: 'Region', options: OCI_REGIONS, fallback: 'us-ashburn-1' },
};

const SERVICE                              = {
  aws: 'AWS Application Migration Service',
  azure: 'Azure Migrate',
  google: 'Migrate to Virtual Machines',
  oci: 'OCI Cloud Migrations',
};

export function rehostBlueprint(cloud             )            {
  const region = REGIONS[cloud];
  return {
    id: `${cloud}_estate_rehost`,
    label: 'Rehost a cluster’s VMs',
    group: ESTATE_GROUP,
    description: `One target per VM in the chosen source cluster, sized from its vCPU and memory, with a disk per VMDK — the landing side of a ${SERVICE[cloud]} wave. Writes rehost-plan.csv beside it.`,
    inputs: [
      ...SCOPE_INPUTS,
      {
        id: 'region',
        label: region.label,
        control: 'select',
        default: region.options.includes(region.fallback) ? region.fallback : region.options[0],
        options: opts(region.options),
      },
      { id: 'include_powered_off', label: 'Include powered-off VMs', control: 'select', default: 'no', options: YES_NO },
      {
        id: 'skip_blocked',
        label: 'Leave out VMs with a move blocker',
        control: 'select',
        default: 'yes',
        options: YES_NO,
        hint: 'Physical RDMs, shared disks and passthrough devices cannot move this way.',
      },
    ],
    emits: REHOST_EMITS[cloud],
    build: (values                 ) => {
      const result = rehostFiles(currentEstate()?.inventory, {
        cloud,
        region: str(values, 'region', region.fallback),
        cluster: str(values, 'source_cluster'),
        folder: str(values, 'source_folder') || undefined,
        includePoweredOff: str(values, 'include_powered_off') === 'yes',
        skipBlocked: str(values, 'skip_blocked', 'yes') === 'yes',
      });
      return { files: result.files, findings: result.findings };
    },
  };
}

export const VSPHERE_LANDING            = {
  id: 'vsphere_estate_landing',
  label: 'VCF landing zone for a cluster',
  group: ESTATE_GROUP,
  description:
    'The port groups (with their VLANs), VM folders, resource pools and custom attributes a source cluster’s VMs use, built in the new workload domain before HCX or vMotion moves them — and their DRS rules, recreated once they have.',
  inputs: [
    ...SCOPE_INPUTS,
    { id: 'vsphere_server', label: 'Target vCenter', control: 'text', default: 'wld01-vc01.example.com', hint: 'The new workload domain’s vCenter.' },
    { id: 'datacenter', label: 'Target datacenter', control: 'text', default: 'wld01-dc' },
    { id: 'target_cluster', label: 'Target cluster', control: 'text', default: 'wld01-cl01' },
    { id: 'distributed_switch', label: 'Target distributed switch', control: 'text', default: 'wld01-vds01' },
  ],
  emits: LANDING_EMITS,
  build: (values                 ) => {
    const result = vsphereLandingFiles(currentEstate()?.inventory, {
      cluster: str(values, 'source_cluster'),
      folder: str(values, 'source_folder') || undefined,
      vsphereServer: str(values, 'vsphere_server'),
      datacenter: str(values, 'datacenter'),
      targetCluster: str(values, 'target_cluster'),
      distributedSwitch: str(values, 'distributed_switch'),
    });
    return { files: result.files, findings: result.findings };
  },
};
