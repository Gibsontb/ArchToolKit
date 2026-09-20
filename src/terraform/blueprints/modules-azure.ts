/**
 * Azure blueprints that call registry modules.
 *
 * Mostly the Azure Verified Modules — `Azure/avm-res-*` — which are Microsoft's
 * own, carry the telemetry and diagnostic wiring an enterprise subscription
 * expects, and are the thing an Azure landing zone is assembled from. They are
 * stricter than the AWS community modules: most of their inputs are required,
 * because an AVM module will not guess a location or a parent for you.
 *
 * Note what the required inputs are called. The newer AVM releases take
 * `parent_id` — a full resource id — where the older ones took
 * `resource_group_name`, and the two are not interchangeable. That difference
 * is read out of each module's own variables rather than remembered, which is
 * the only reason the calls below are right.
 */

import type { BlueprintGroup } from '../../kit/blueprint.ts';
import { moduleBlueprint, type ModuleBlueprintSpec } from '../module-blueprint.ts';

const SPECS: readonly ModuleBlueprintSpec[] = [
  {
    id: 'azure_module_resource_group',
    label: 'Resource group (Azure/avm-res-resources-resourcegroup)',
    description: 'The container everything else in a subscription hangs off, with locks and role assignments.',
    source: 'Azure/avm-res-resources-resourcegroup/azurerm',
    name: 'resource_group',
    fields: [
      { input: 'name', default: 'rg-court-prod' },
      { input: 'location', default: 'eastus' },
      { input: 'enable_telemetry', default: 'false', hint: 'Microsoft’s module usage telemetry' },
    ],
    outputs: ['name', 'resource_id'],
  },
  {
    id: 'azure_module_vnet',
    label: 'Virtual network (Azure/avm-res-network-virtualnetwork)',
    description:
      'A VNet with its subnets, peerings and DDoS settings. Subnets are a map, so adding one is a map entry rather than another resource.',
    source: 'Azure/avm-res-network-virtualnetwork/azurerm',
    name: 'vnet',
    fields: [
      { input: 'name', default: 'vnet-court-prod' },
      { input: 'location', default: 'eastus' },
      {
        input: 'parent_id',
        label: 'Resource group id',
        default: '',
        hint: 'Full resource id — or module.resource_group.resource_id',
      },
      { input: 'address_space', default: '10.30.0.0/16' },
      {
        input: 'subnets',
        default: '',
        hint: 'key=value, comma-separated. Leave blank and write the map in the file',
      },
      { input: 'enable_telemetry', default: 'false' },
    ],
    outputs: ['name', 'resource_id', 'subnets'],
  },
  {
    id: 'azure_module_nsg',
    label: 'Network security group (Azure/avm-res-network-networksecuritygroup)',
    description: 'An NSG whose rules come from a map, with diagnostic settings wired up.',
    source: 'Azure/avm-res-network-networksecuritygroup/azurerm',
    name: 'nsg',
    fields: [
      { input: 'name', default: 'nsg-court-app' },
      { input: 'location', default: 'eastus' },
      { input: 'resource_group_name', default: 'rg-court-prod' },
      { input: 'security_rules', default: '', hint: 'key=value, comma-separated' },
      { input: 'enable_telemetry', default: 'false' },
    ],
    outputs: ['name', 'resource_id'],
  },
  {
    id: 'azure_module_vm',
    label: 'Virtual machine (Azure/avm-res-compute-virtualmachine)',
    description:
      'A VM with its NICs, disks, identity and extensions. The module takes SSH keys rather than a password, which is the right default.',
    source: 'Azure/avm-res-compute-virtualmachine/azurerm',
    name: 'vm',
    fields: [
      { input: 'name', default: 'vm-court-app-01' },
      { input: 'location', default: 'eastus' },
      { input: 'resource_group_name', default: 'rg-court-prod' },
      { input: 'zone', default: '1', hint: 'Availability zone. Required by this module' },
      { input: 'sku_size', label: 'VM size', default: 'Standard_D2s_v5' },
      { input: 'os_type', default: 'Linux' },
      { input: 'admin_username', default: 'azureuser' },
      { input: 'disable_password_authentication', default: 'true' },
      { input: 'encryption_at_host_enabled', default: 'true' },
      { input: 'network_interfaces', default: '', hint: 'key=value, comma-separated' },
      { input: 'enable_telemetry', default: 'false' },
    ],
    outputs: ['name', 'resource_id'],
  },
  {
    id: 'azure_module_storage',
    label: 'Storage account (Azure/avm-res-storage-storageaccount)',
    description:
      'A storage account with its containers, shares, network rules and private endpoints — the whole thing as one call.',
    source: 'Azure/avm-res-storage-storageaccount/azurerm',
    name: 'storage',
    fields: [
      { input: 'name', default: 'stcourtprod001', hint: 'Lowercase letters and digits, 3–24 characters' },
      { input: 'location', default: 'eastus' },
      { input: 'parent_id', label: 'Resource group id', default: '' },
      { input: 'account_tier', default: 'Standard' },
      { input: 'account_replication_type', default: 'GZRS' },
      { input: 'account_kind', default: 'StorageV2' },
      { input: 'min_tls_version', default: 'TLS1_2' },
      { input: 'public_network_access_enabled', default: 'false' },
      { input: 'shared_access_key_enabled', default: 'false', hint: 'Off means Entra ID auth only' },
      { input: 'containers', default: '', hint: 'key=value, comma-separated' },
      { input: 'enable_telemetry', default: 'false' },
    ],
    outputs: ['name', 'resource_id'],
  },
  {
    id: 'azure_module_key_vault',
    label: 'Key vault (Azure/avm-res-keyvault-vault)',
    description: 'A key vault with RBAC, purge protection and its keys and secrets declared as maps.',
    source: 'Azure/avm-res-keyvault-vault/azurerm',
    name: 'key_vault',
    fields: [
      { input: 'name', default: 'kv-court-prod' },
      { input: 'location', default: 'eastus' },
      { input: 'resource_group_name', default: 'rg-court-prod' },
      { input: 'tenant_id', default: '', hint: 'Or data.azurerm_client_config.current.tenant_id' },
      { input: 'sku_name', default: 'standard' },
      { input: 'purge_protection_enabled', default: 'true' },
      { input: 'soft_delete_retention_days', default: '90' },
      { input: 'public_network_access_enabled', default: 'false' },
      { input: 'enable_telemetry', default: 'false' },
    ],
    outputs: ['name', 'resource_id', 'uri'],
  },
  {
    id: 'azure_module_aks_avm',
    label: 'AKS cluster (Azure/avm-res-containerservice-managedcluster)',
    description: 'A managed Kubernetes cluster, the verified-module version.',
    source: 'Azure/avm-res-containerservice-managedcluster/azurerm',
    name: 'aks',
    fields: [
      { input: 'name', default: 'aks-court-prod' },
      { input: 'location', default: 'eastus' },
      { input: 'parent_id', label: 'Resource group id', default: '' },
      { input: 'kubernetes_version', default: '1.31' },
      { input: 'dns_prefix', default: 'court-prod' },
      { input: 'enable_rbac', label: 'Kubernetes RBAC', default: 'true' },
      { input: 'disable_local_accounts', default: 'true', hint: 'Entra ID only, no local kubeconfig' },
      {
        input: 'public_network_access',
        default: 'Disabled',
        hint: 'Disabled makes it a private cluster',
      },
      { input: 'enable_telemetry', default: 'false' },
    ],
    outputs: ['name', 'resource_id'],
  },
  {
    id: 'azure_module_web_app',
    label: 'Web app (Azure/avm-res-web-site)',
    description: 'An App Service site on an existing plan, with its settings, slots and identity.',
    source: 'Azure/avm-res-web-site/azurerm',
    name: 'web_app',
    fields: [
      { input: 'name', default: 'app-court-prod' },
      { input: 'location', default: 'eastus' },
      { input: 'parent_id', label: 'Resource group id', default: '' },
      { input: 'service_plan_resource_id', default: '', hint: 'An existing App Service plan' },
      { input: 'kind', default: 'webapp' },
      { input: 'os_type', default: 'Linux' },
      { input: 'https_only', default: 'true' },
      { input: 'public_network_access_enabled', default: 'false' },
      { input: 'enable_telemetry', default: 'false' },
    ],
    outputs: ['name', 'resource_id'],
  },
  {
    id: 'azure_module_aks',
    label: 'AKS cluster (Azure/aks)',
    description:
      'The long-standing community AKS module: more knobs than the verified one, and the one most existing estates already call.',
    source: 'Azure/aks/azurerm',
    name: 'aks',
    fields: [
      { input: 'cluster_name', default: 'aks-court-prod' },
      { input: 'location', default: 'eastus' },
      { input: 'resource_group_name', default: 'rg-court-prod' },
      { input: 'kubernetes_version', default: '1.31' },
      { input: 'sku_tier', default: 'Standard' },
      { input: 'agents_size', label: 'Node size', default: 'Standard_D2s_v5' },
      { input: 'agents_count', label: 'Node count', default: '3' },
      { input: 'private_cluster_enabled', default: 'true' },
      { input: 'rbac_aad_azure_rbac_enabled', label: 'Entra ID RBAC', default: 'true' },
      { input: 'vnet_subnet', label: 'VNet subnet', default: '', hint: 'key=value, comma-separated — the module takes an object' },
    ],
    outputs: ['aks_id', 'aks_name', 'host'],
  },
  {
    id: 'azure_module_naming',
    label: 'Resource naming (Azure/naming)',
    description:
      'Generates compliant names for every Azure resource type from a prefix and a suffix, so nothing is named by hand or rejected for a bad character.',
    source: 'Azure/naming/azurerm',
    name: 'naming',
    fields: [
      { input: 'prefix', default: 'court', hint: 'Comma-separated parts' },
      { input: 'suffix', default: 'prod', hint: 'Comma-separated parts' },
      { input: 'unique-length', label: 'Unique suffix length', default: '4' },
      { input: 'unique-include-numbers', label: 'Digits in the unique suffix', default: 'true' },
    ],
    outputs: ['resource_group', 'storage_account', 'key_vault', 'virtual_machine'],
  },
];

export const AZURE_TERRAFORM_MODULES: BlueprintGroup = {
  target: 'azure',
  label: 'Microsoft Azure',
  blueprints: SPECS.map((spec) => moduleBlueprint('azure', spec)),
};
