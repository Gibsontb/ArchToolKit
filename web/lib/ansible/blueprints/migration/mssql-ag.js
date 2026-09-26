/**
 * mig_mssql_ag: the mssql_ag role, an Always On availability group on Windows.
 * On Azure the listener is Terraform's load balancer, so none is created here.
 */

import { info } from '../../../core/findings.js';
import { MSSQL_AG } from '../../migration/roles/index.js';
import { list, migrationBlueprint, number, PLATFORM_INPUT, text } from './common.js';

export const MIG_MSSQL_AG = migrationBlueprint({
  id: 'mig_mssql_ag',
  label: 'Migration – SQL Server Always On availability group',
  description:
    'Failover Clustering, the Windows cluster (distributed network name on Azure, static addresses elsewhere), a cloud or file share witness, Always On enabled, the AG with automatic seeding on the primary, secondaries (synchronous in region, asynchronous for DR) and the listener, except on Azure where the load balancer is the listener.',
  inputs: [
    PLATFORM_INPUT,
    { id: 'ag_name', label: 'Availability group', control: 'text', default: 'ag1' },
    { id: 'database', label: 'First database', control: 'text', default: '', hint: 'Blank creates the AG empty; add databases later' },
    { id: 'cluster_name', label: 'Cluster name', control: 'text', default: 'sqlclu1' },
    { id: 'cluster_ips', label: 'Cluster addresses', control: 'text', default: '', hint: 'One per subnet, comma separated (not used on Azure)' },
    { id: 'primary', label: 'Primary (inventory name)', control: 'text', default: '', hint: 'Blank: the first host' },
    { id: 'async_replicas', label: 'Asynchronous replicas', control: 'text', default: '', hint: 'Inventory names in the DR region, comma separated' },
    { id: 'listener_name', label: 'Listener name', control: 'text', default: 'aglistener' },
    { id: 'listener_ips', label: 'Listener addresses', control: 'text', default: '', hint: 'One per subnet (multi-subnet), comma separated' },
    { id: 'listener_masks', label: 'Listener subnet masks', control: 'text', default: '', hint: 'In the same order, e.g. 255.255.255.0' },
    { id: 'cloud_witness_account', label: 'Cloud witness storage account (Azure)', control: 'text', default: '', hint: 'Key: vault_cluster_witness_storage_key' },
    { id: 'file_share_witness', label: 'File share witness', control: 'text', default: '', hint: '\\\\server\\share (outside Azure)' },
    { id: 'instance_name', label: 'Instance', control: 'text', default: 'MSSQLSERVER' },
    { id: 'port', label: 'Listener port', control: 'number', default: 1433, min: 1, max: 65535 },
  ],
  roles: () => [MSSQL_AG],
  vars: (v) => ({
    mig_cloud_platform: text(v.platform, 'aws'),
    mig_mssql_ag_name: text(v.ag_name, 'ag1'),
    mig_mssql_ag_database: text(v.database),
    mig_mssql_cluster_name: text(v.cluster_name, 'sqlclu1'),
    mig_mssql_cluster_ips: list(v.cluster_ips),
    ...(text(v.primary) ? { mig_mssql_ag_primary: text(v.primary) } : {}),
    mig_mssql_ag_async_replicas: list(v.async_replicas),
    mig_mssql_ag_listener_name: text(v.listener_name, 'aglistener'),
    mig_mssql_ag_listener_ips: list(v.listener_ips),
    mig_mssql_ag_listener_masks: list(v.listener_masks),
    mig_mssql_cloud_witness_account: text(v.cloud_witness_account),
    mig_mssql_file_share_witness: text(v.file_share_witness),
    mig_mssql_instance_name: text(v.instance_name, 'MSSQLSERVER'),
    mig_mssql_port: number(v.port, 1433),
  }),
  findings: (v) => [
    ...(text(v.platform, 'aws') === 'azure'
      ? [info('ansible.migration.ag-listener-azure', 'On Azure the AG listener is the internal load balancer (or DNN) Terraform creates with azurerm_mssql_virtual_machine_availability_group_listener; this play creates none.', {})]
      : []),
    info(
      'ansible.migration.ag-scope',
      'Failover cluster instances (shared storage) are not built here: only the cluster is, and the shared disks come from Terraform. An AG on Linux needs Pacemaker and is out of scope; a contained AG (CLUSTER_TYPE = NONE) is the alternative.',
      {},
    ),
  ],
});
