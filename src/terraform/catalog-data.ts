/**
 * Terraform resource catalog — GENERATED, do not edit by hand.
 *
 * Written by tools/fetch-provider-catalog.mjs from the Terraform Registry.
 * Refresh with: npm run catalog:update
 *
 * Names are stored without their provider prefix and comma-joined, which keeps
 * this file a fraction of the size of the equivalent array literal.
 *
 * This is a seed. Only the two small providers are present; AWS, Azure, Google
 * and OCI carry roughly 5,000 resources between them and are fetched rather than
 * committed by hand. Until the tool is run, the catalog reports them as absent
 * rather than pretending to know them.
 */

export interface CatalogEntryData {
  readonly source: string;
  readonly version: string;
  /** Comma-joined resource names, without the provider prefix. */
  readonly resources: string;
  /** Comma-joined data source names, without the provider prefix. */
  readonly dataSources: string;
}

/** When this file was generated, ISO date. */
export const CATALOG_FETCHED_AT = '2026-09-20';

export const CATALOG_DATA: Readonly<Record<string, CatalogEntryData>> = {
  vsphere: {
    source: 'vmware/vsphere',
    version: '2.17.1',
    resources:
      'alarm,compute_cluster,compute_cluster_host_group,compute_cluster_vm_affinity_rule,compute_cluster_vm_anti_affinity_rule,compute_cluster_vm_dependency_rule,compute_cluster_vm_group,compute_cluster_vm_host_rule,configuration_profile,content_library,content_library_item,custom_attribute,datacenter,datastore_cluster,datastore_cluster_vm_anti_affinity_rule,distributed_port_group,distributed_virtual_switch,dpm_host_override,drs_vm_override,entity_permissions,file,folder,guest_os_customization,ha_vm_override,host,host_port_group,host_virtual_switch,license,namespace,nas_datastore,network_protocol_profile,offline_software_depot,resource_pool,role,sso_group,sso_user,storage_drs_vm_override,supervisor,supervisor_v2,tag,tag_category,vapp_container,vapp_entity,virtual_disk,virtual_machine,virtual_machine_class,virtual_machine_snapshot,vm_storage_policy,vmfs_datastore,vnic,zone',
    dataSources:
      'alarm,compute_cluster,compute_cluster_host_group,configuration_profile,content_library,content_library_item,custom_attribute,datacenter,datastore,datastore_cluster,datastore_stats,distributed_virtual_switch,dynamic,folder,guest_os_customization,host,host_base_images,host_pci_device,host_thumbprint,host_vgpu_profile,license,namespace,network,ovf_vm_template,resource_pool,role,sso_group,sso_user,storage_policy,tag,tag_category,vapp_container,virtual_machine,vmfs_disks,zone',
  },
  vcf: {
    source: 'vmware/vcf',
    version: '0.18.2',
    resources:
      'ceip,certificate,certificate_authority,cluster,cluster_personality,credentials_auto_rotate_policy,credentials_rotate,credentials_update,csr,domain,edge_cluster,external_certificate,host,instance,network_pool,user',
    dataSources: 'certificate,cluster,cluster_personality,credentials,domain,host,network_pool',
  },
};
