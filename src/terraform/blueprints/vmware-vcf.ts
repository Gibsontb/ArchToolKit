/**
 * VMware Cloud Foundation Terraform blueprints: the whole stack a VCF fleet is
 * built from, one platform in the picker.
 *
 *   VCF             vmware/vcf    SDDC Manager: bring-up, workload domains,
 *                                 clusters, hosts, edge clusters, certificates
 *   NSX             vmware/nsxt   gateways, segments, firewall, NAT, VPCs, LB
 *   Avi             vmware/avi    load balancer: virtual services, pools, WAF
 *   VCF Automation  vmware/vra    cloud accounts, projects, templates, catalog
 *   Cloud Director  vmware/vcd    organizations, VDCs, networks, vApps
 *
 * vSphere itself sits under its own platform (vmware.ts), where the estate
 * blueprints already are.
 *
 * Each product offers its hand-written scenarios first — several resources that
 * are built together — and then one blueprint per resource, generated from the
 * provider's schema with every argument it takes (schema-blueprints.ts).
 */

import type { BlueprintGroup } from '../../kit/blueprint.ts';
import { providerBlueprints } from '../schema-blueprints.ts';
import { VCF_SCENARIOS } from './vmware-vcf-scenarios.ts';
import { NSX_SCENARIOS } from './vmware-nsx.ts';
import { AVI_SCENARIOS } from './vmware-avi.ts';
import { VRA_SCENARIOS } from './vmware-vra.ts';
import { VCD_SCENARIOS } from './vmware-vcd.ts';

export const VCF_TERRAFORM: BlueprintGroup = {
  target: 'vcf',
  label: 'VMware Cloud Foundation (VCF, NSX, Avi, VCF Automation, Cloud Director)',
  blueprints: [
    ...VCF_SCENARIOS,
    ...providerBlueprints('vcf'),
    ...NSX_SCENARIOS,
    ...providerBlueprints('nsxt'),
    ...AVI_SCENARIOS,
    ...providerBlueprints('avi'),
    ...VRA_SCENARIOS,
    ...providerBlueprints('vra'),
    ...VCD_SCENARIOS,
    ...providerBlueprints('vcd'),
  ],
};
