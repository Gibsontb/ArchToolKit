/**
 * `<p>_app_file_service` (tier pattern `file-service`) and
 * `<p>_app_file_transfer` (addendum A.4.2 "File and print", A.4.6): managed
 * file shares for a file server or NAS, and the cloud's own transfer tasks
 * that copy the data into them. The share-level cutover (a DFS-N target or a
 * DNS CNAME switch) is the execution kit's; robocopy / rsync are its fallback.
 *
 * File service
 *   AWS     FSx for Windows File Server (joined to the domain; Multi-AZ for
 *           tier 0 / 1; audit logs), or FSx for NetApp ONTAP (an SVM and a
 *           volume per share); dual-stack on a dual-stack network
 *   Azure   Azure Files (premium, ZRS, a private endpoint, optional Azure File
 *           Sync group), or Azure NetApp Files (an AD connection, a capacity
 *           pool, a volume per share in a delegated subnet)
 *   Google  Filestore (NFS), or Google Cloud NetApp Volumes (SMB, NFS or both,
 *           with an Active Directory policy for SMB)
 *   OCI     File Storage: a file system per share, a mount target, exports
 *
 * File transfer
 *   AWS     DataSync: SMB / NFS source locations on the activated agent, FSx
 *           destinations, a task per row (ACLs kept, verification on)
 *   Azure   Storage Mover (NFS sources to blob containers, through an
 *           Arc-enabled agent); SMB into Azure Files is Azure File Sync
 *   Google  Storage Transfer Service: an agent pool and a POSIX-to-POSIX job
 *           per row (the agents mount the SMB / NFS source and the target)
 *
 * The directory account's password is a sensitive variable (or, on AWS, a
 * Secrets Manager secret); nothing is written in a file.
 */

import { error, info, warning, type Finding } from '../../../core/findings.ts';
import type { Blueprint, BlueprintInput, BlueprintValues } from '../../../kit/blueprint.ts';
import { num as numberOf, str as valueOf } from '../../../kit/blueprint.ts';
import type { HclBlock } from '../../hcl.ts';
import {
  LANDING_ZONE_SOURCE,
  attrs,
  blk,
  dat,
  gridInput,
  ident,
  lzRef,
  output,
  parseGrid,
  q,
  res,
  rname,
  secretVariable,
  uniqueNames,
  variable,
  x,
  type GridColumn,
  type MigCloud,
} from '../migration/common.ts';
import {
  NETWORK_INPUT,
  PATTERN_GROUP,
  TIER_OPTIONS,
  appInputs,
  appOf,
  azureDelegatedSubnet,
  ipv6Of,
  isV4Cidr,
  listOf,
  namePrefix,
  patternMainTf,
  preamble,
  securityGroupOf,
  subnetOf,
  tagsExpr,
  type AppInfo,
} from './common.ts';

// ---------------------------------------------------------------------------
// File service
// ---------------------------------------------------------------------------

const SERVICES: Readonly<Record<MigCloud, readonly { value: string; label: string }[]>> = {
  aws: [{ value: 'fsx-windows', label: 'FSx for Windows File Server' }, { value: 'fsx-ontap', label: 'FSx for NetApp ONTAP' }],
  azure: [{ value: 'azure-files', label: 'Azure Files (premium)' }, { value: 'netapp', label: 'Azure NetApp Files' }],
  google: [{ value: 'filestore', label: 'Filestore (NFS)' }, { value: 'netapp', label: 'Google Cloud NetApp Volumes' }],
  oci: [{ value: 'file-storage', label: 'OCI File Storage (NFS)' }],
};

function serviceInputs(platform: MigCloud): BlueprintInput[] {
  return [
    ...appInputs(),
    NETWORK_INPUT,
    { id: 'tier', label: 'Tier', control: 'select', default: 'app', options: TIER_OPTIONS },
    { id: 'service', label: 'Service', control: 'select', default: SERVICES[platform][0]!.value, options: SERVICES[platform] },
    { id: 'protocol', label: 'Protocol', control: 'select', default: platform === 'oci' ? 'nfs' : 'smb', options: [{ value: 'smb', label: 'SMB' }, { value: 'nfs', label: 'NFS' }, { value: 'both', label: 'SMB and NFS' }] },
    { id: 'capacity_gib', label: 'Capacity (GiB)', control: 'number', default: 2048, min: 32 },
    { id: 'shares', label: 'Shares', control: 'text', default: 'data home', hint: 'Space-separated share (volume) names.' },
    { id: 'domain', label: 'AD domain', control: 'text', default: 'corp.example.com', hint: 'SMB: the domain the file service joins.' },
    { id: 'dns_ips', label: 'Domain controllers', control: 'text', default: '10.0.0.10 10.0.0.11', hint: 'SMB: the DNS servers / DCs of the domain, space-separated.' },
    { id: 'ad_user', label: 'Join account', control: 'text', default: 'svc-filejoin', hint: 'SMB: the account that joins the file service to the domain; its password is a sensitive variable.' },
    { id: 'ou', label: 'OU', control: 'text', default: '', hint: 'SMB: the OU the computer object goes in (distinguished name); blank for the default.' },
    ...(platform === 'aws' ? [{ id: 'ad_secret_arn', label: 'Join account secret (ARN)', control: 'text' as const, default: '', hint: 'FSx for Windows: a Secrets Manager secret holding the join account; blank uses a sensitive variable instead.' }] : []),
    ...(platform === 'azure'
      ? [
          { id: 'file_sync', label: 'Azure File Sync', control: 'select' as const, default: 'yes', options: [{ value: 'yes', label: 'Yes: a sync group per share (the migration path for Windows file servers)' }, { value: 'no', label: 'No' }] },
          { id: 'netapp_subnet_cidr', label: 'NetApp subnet', control: 'text' as const, default: '10.40.254.0/26', hint: 'Azure NetApp Files only: a free range of the network, delegated to NetApp.' },
        ]
      : []),
    LANDING_ZONE_SOURCE,
  ];
}

interface FileSpec {
  readonly app: AppInfo;
  readonly net: string;
  readonly tier: string;
  readonly service: string;
  readonly smb: boolean;
  readonly nfs: boolean;
  readonly capacity: number;
  readonly shares: readonly string[];
  readonly domain: string;
  readonly dns: readonly string[];
  readonly user: string;
  readonly ou: string;
  readonly ha: boolean;
}

function fileSpec(values: BlueprintValues, platform: MigCloud): FileSpec {
  const app = appOf(values);
  const protocol = valueOf(values, 'protocol', 'smb');
  const service = valueOf(values, 'service', SERVICES[platform][0]!.value);
  return {
    app,
    net: rname(valueOf(values, 'network', 'prod')),
    tier: valueOf(values, 'tier', 'app'),
    service: SERVICES[platform].some((s) => s.value === service) ? service : SERVICES[platform][0]!.value,
    smb: protocol !== 'nfs',
    nfs: protocol !== 'smb',
    capacity: Math.max(32, numberOf(values, 'capacity_gib', 2048)),
    shares: (listOf(values, 'shares', 'data').map((s) => rname(s)).filter(Boolean).length > 0 ? listOf(values, 'shares', 'data').map((s) => rname(s)).filter(Boolean) : ['data']),
    domain: valueOf(values, 'domain', 'corp.example.com'),
    dns: listOf(values, 'dns_ips', '10.0.0.10'),
    user: valueOf(values, 'ad_user', 'svc-filejoin'),
    ou: valueOf(values, 'ou'),
    ha: app.criticality === 'tier0' || app.criticality === 'tier1',
  };
}

const joinPassword = (s: FileSpec): { name: string; block: HclBlock } => {
  const name = `${s.app.id}_file_join_password`;
  return { name, block: secretVariable(name, `The password of ${s.user}, the account that joins ${s.app.name}'s file service to ${s.domain}.`) };
};

function awsFileService(values: BlueprintValues, findings: Finding[]): HclBlock[] {
  const s = fileSpec(values, 'aws');
  const lz = lzRef(values);
  const pfx = namePrefix(values, s.app);
  const v6 = ipv6Of(lz, s.net);
  const tags = x(tagsExpr(s.app, 'aws'));
  const subnets = `slice(${lz}.zone_subnet_ids[${q(s.net)}], 0, ${s.ha ? 2 : 1})`;
  const sg = `[${securityGroupOf(lz, s.net, s.tier)}]`;
  const blocks: HclBlock[] = [...preamble('aws', values)];
  if (s.service === 'fsx-windows') {
    if (!s.smb || s.nfs) findings.push(info('tf.app.file-fsxw-smb', 'FSx for Windows File Server serves SMB only: NFS clients need FSx for NetApp ONTAP.', { path: 'protocol' }));
    const secret = valueOf(values, 'ad_secret_arn');
    const pw = joinPassword(s);
    if (!secret) blocks.push(pw.block);
    blocks.push(
      res('aws_cloudwatch_log_group', 'file_audit', { name: x(`"/aws/fsx/${pfx}"`), retention_in_days: 365, tags }, [], 'FSx writes audit events only to a log group named /aws/fsx/…'),
      res('aws_fsx_windows_file_system', 'app', {
        storage_capacity: s.capacity,
        storage_type: 'SSD',
        deployment_type: s.ha ? 'MULTI_AZ_1' : 'SINGLE_AZ_2',
        subnet_ids: x(subnets),
        preferred_subnet_id: x(`${lz}.zone_subnet_ids[${q(s.net)}][0]`),
        throughput_capacity: s.capacity >= 8192 ? 256 : s.capacity >= 2048 ? 128 : 64,
        security_group_ids: x(sg),
        network_type: x(`${v6} ? "DUAL" : "IPV4"`),
        kms_key_id: x(`${lz}.kms_key_id`),
        automatic_backup_retention_days: 7,
        copy_tags_to_backups: true,
        skip_final_backup: false,
        tags,
      }, [
        blk('self_managed_active_directory', {
          domain_name: s.domain,
          dns_ips: s.dns,
          organizational_unit_distinguished_name: s.ou || undefined,
          file_system_administrators_group: 'Domain Admins',
          ...(secret ? { domain_join_service_account_secret: secret } : { username: s.user, password: x(`var.${pw.name}`) }),
        }),
        blk('audit_log_configuration', { file_access_audit_log_level: 'SUCCESS_AND_FAILURE', file_share_access_audit_log_level: 'SUCCESS_AND_FAILURE', audit_log_destination: x('aws_cloudwatch_log_group.file_audit.arn') }),
      ]),
      output('dns_name', 'aws_fsx_windows_file_system.app.dns_name', 'The file system\'s name: the DFS-N folder targets (or the DNS CNAME) point here at cutover.'),
    );
    findings.push(info('tf.app.file-shares-fsxw', `The shares (${s.shares.join(', ')}) are created on the file system with New-FSxSmbShare through its PowerShell endpoint, or by the copy itself; FSx has no share resource.`, { source: 'https://docs.aws.amazon.com/fsx/latest/WindowsGuide/managing-file-shares.html' }));
    return blocks;
  }
  // FSx for NetApp ONTAP: the file system, one SVM (joined to the domain for SMB), a volume per share.
  const pw = joinPassword(s);
  if (s.smb) blocks.push(pw.block);
  blocks.push(
    res('aws_fsx_ontap_file_system', 'app', {
      storage_capacity: Math.max(1024, s.capacity),
      deployment_type: s.ha ? 'MULTI_AZ_2' : 'SINGLE_AZ_2',
      subnet_ids: x(subnets),
      preferred_subnet_id: x(`${lz}.zone_subnet_ids[${q(s.net)}][0]`),
      route_table_ids: s.ha ? x(`[${lz}.route_table_ids[${q(s.net)}]]`) : undefined,
      throughput_capacity_per_ha_pair: 384,
      ha_pairs: 1,
      security_group_ids: x(sg),
      network_type: x(`${v6} ? "DUAL" : "IPV4"`),
      kms_key_id: x(`${lz}.kms_key_id`),
      automatic_backup_retention_days: 7,
      tags,
    }),
    res('aws_fsx_ontap_storage_virtual_machine', 'app', {
      file_system_id: x('aws_fsx_ontap_file_system.app.id'),
      name: s.app.slug.replace(/-/g, '_').slice(0, 47),
      root_volume_security_style: s.smb ? 'NTFS' : 'UNIX',
      tags,
    }, s.smb
      ? [blk('active_directory_configuration', { netbios_name: s.app.slug.replace(/-/g, '').slice(0, 15).toUpperCase() }, [
          blk('self_managed_active_directory_configuration', { domain_name: s.domain, dns_ips: s.dns, username: s.user, password: x(`var.${pw.name}`), organizational_unit_distinguished_name: s.ou || undefined, file_system_administrators_group: 'Domain Admins' }),
        ])]
      : []),
  );
  for (const share of s.shares) {
    blocks.push(
      res('aws_fsx_ontap_volume', ident('share', share), {
        name: share.replace(/-/g, '_'),
        storage_virtual_machine_id: x('aws_fsx_ontap_storage_virtual_machine.app.id'),
        junction_path: `/${share}`,
        size_in_megabytes: Math.max(1024, Math.floor((s.capacity * 1024) / s.shares.length)),
        security_style: s.smb ? 'NTFS' : 'UNIX',
        storage_efficiency_enabled: true,
        ontap_volume_type: 'RW',
        skip_final_backup: false,
        tags,
      }, [blk('tiering_policy', { name: 'AUTO' })]),
    );
  }
  blocks.push(output('svm_endpoints', 'aws_fsx_ontap_storage_virtual_machine.app.endpoints'));
  findings.push(info('tf.app.file-snapmirror', 'From an ONTAP source, SnapMirror to this SVM keeps snapshots and efficiency: set up the peering and relationship as the runbook says (DataSync is the other way).', { source: 'https://docs.aws.amazon.com/fsx/latest/ONTAPGuide/migrating-fsx-ontap-snapmirror.html' }));
  return blocks;
}

function azureFileService(values: BlueprintValues, findings: Finding[]): HclBlock[] {
  const s = fileSpec(values, 'azure');
  const lz = lzRef(values);
  const pfx = namePrefix(values, s.app);
  const tags = x(tagsExpr(s.app, 'azure'));
  const rg = `${lz}.resource_group[${q(s.net)}]`;
  const blocks: HclBlock[] = [...preamble('azure', values)];
  if (s.service === 'azure-files') {
    if (s.smb && s.nfs) findings.push(warning('tf.app.file-azure-both', 'An Azure file share is SMB or NFS, not both: the shares are SMB.', { path: 'protocol' }));
    const account = `substr(replace(lower("${pfx}files"), "/[^a-z0-9]/", ""), 0, 24)`;
    blocks.push(
      res('azurerm_storage_account', 'files', {
        name: x(account),
        resource_group_name: x(rg),
        location: x(`${lz}.location`),
        account_kind: 'FileStorage',
        account_tier: 'Premium',
        account_replication_type: 'ZRS',
        min_tls_version: 'TLS1_2',
        https_traffic_only_enabled: !(s.nfs && !s.smb),
        public_network_access: 'Disabled',
        shared_access_key_enabled: true,
        allow_nested_items_to_be_public: false,
        tags,
      }, [blk('share_properties', {}, [blk('smb', { versions: ['SMB3.1.1'], authentication_types: ['Kerberos'], channel_encryption_type: ['AES-256-GCM'] }), blk('retention_policy', { days: 14 })])]),
      res('azurerm_private_endpoint', 'files', {
        name: x(`"${pfx}-files-pe"`),
        resource_group_name: x(rg),
        location: x(`${lz}.location`),
        subnet_id: x(subnetOf(lz, s.net, s.tier)),
        tags,
      }, [blk('private_service_connection', { name: 'file', private_connection_resource_id: x('azurerm_storage_account.files.id'), subresource_names: ['file'], is_manual_connection: false })]),
    );
    const per = Math.max(100, Math.floor(s.capacity / s.shares.length));
    for (const share of s.shares) {
      blocks.push(res('azurerm_storage_share', ident('share', share), { name: share, storage_account_id: x('azurerm_storage_account.files.id'), quota: per, enabled_protocol: s.smb ? 'SMB' : 'NFS', access_tier: 'Premium' }));
    }
    if (valueOf(values, 'file_sync', 'yes') === 'yes' && s.smb) {
      blocks.push(res('azurerm_storage_sync', 'files', { name: x(`"${pfx}-sync"`), resource_group_name: x(rg), location: x(`${lz}.location`), incoming_traffic_policy: 'AllowVirtualNetworksOnly', tags }));
      for (const share of s.shares) {
        blocks.push(
          res('azurerm_storage_sync_group', ident('sync', share), { name: share, storage_sync_id: x('azurerm_storage_sync.files.id') }),
          res('azurerm_storage_sync_cloud_endpoint', ident('sync', share), {
            name: share,
            storage_sync_group_id: x(`azurerm_storage_sync_group.${ident('sync', share)}.id`),
            file_share_name: x(`azurerm_storage_share.${ident('share', share)}.name`),
            storage_account_id: x('azurerm_storage_account.files.id'),
          }),
        );
      }
      findings.push(info('tf.app.file-sync-server', 'Install the Azure File Sync agent on the source file server, register it with the Storage Sync Service and add a server endpoint per share (runbook): the sync then seeds the shares, and cutover is a DFS-N target switch.', { source: 'https://learn.microsoft.com/en-us/azure/storage/file-sync/file-sync-deployment-guide' }));
    }
    findings.push(info('tf.app.file-ad-join', 'Join the storage account to AD DS for Kerberos with AzFilesHybrid (Join-AzStorageAccount) or Entra Kerberos: that is a runbook step, not a Terraform resource here.', { source: 'https://learn.microsoft.com/en-us/azure/storage/files/storage-files-identity-ad-ds-enable' }));
    blocks.push(output('account', 'azurerm_storage_account.files.name'));
    return blocks;
  }
  // Azure NetApp Files.
  const cidr = valueOf(values, 'netapp_subnet_cidr', '10.40.254.0/26');
  if (!isV4Cidr(cidr)) findings.push(error('tf.app.file-netapp-subnet', `"${cidr}" is not an IPv4 range for the NetApp subnet.`, { path: 'netapp_subnet_cidr' }));
  const pw = joinPassword(s);
  if (s.smb) blocks.push(pw.block);
  const poolTiB = Math.max(1, Math.ceil(s.capacity / 1024));
  blocks.push(
    azureDelegatedSubnet('netapp', lz, s.net, `"${pfx}-anf"`, cidr, 'Microsoft.Netapp/volumes', ['Microsoft.Network/networkinterfaces/*', 'Microsoft.Network/virtualNetworks/subnets/join/action']),
    res('azurerm_netapp_account', 'app', { name: x(`"${pfx}-anf"`), resource_group_name: x(rg), location: x(`${lz}.location`), tags }, s.smb
      ? [blk('active_directory', { username: s.user, password: x(`var.${pw.name}`), smb_server_name: s.app.slug.replace(/-/g, '').slice(0, 10).toUpperCase(), dns_servers: s.dns, domain: s.domain, organizational_unit: s.ou || undefined, aes_encryption_enabled: true, ldap_signing_enabled: true })]
      : []),
    res('azurerm_netapp_pool', 'app', { name: 'pool1', account_name: x('azurerm_netapp_account.app.name'), resource_group_name: x(rg), location: x(`${lz}.location`), service_level: 'Premium', size_in_tb: poolTiB, qos_type: 'Auto', tags }),
  );
  for (const share of s.shares) {
    blocks.push(
      res('azurerm_netapp_volume', ident('share', share), {
        name: share,
        resource_group_name: x(rg),
        location: x(`${lz}.location`),
        account_name: x('azurerm_netapp_account.app.name'),
        pool_name: x('azurerm_netapp_pool.app.name'),
        volume_path: `${s.app.slug}-${share}`,
        service_level: 'Premium',
        subnet_id: x('azurerm_subnet.netapp.id'),
        network_features: 'Standard',
        protocols: s.smb && s.nfs ? ['CIFS', 'NFSv4.1'] : s.smb ? ['CIFS'] : ['NFSv4.1'],
        security_style: s.smb ? 'ntfs' : 'unix',
        storage_quota_in_gb: Math.max(100, Math.floor(s.capacity / s.shares.length)),
        snapshot_directory_visible: true,
        tags,
      }, s.nfs ? [blk('export_policy_rule', { rule_index: 1, allowed_clients: x(`${lz}.mgmt_cidrs`), protocol: ['NFSv4.1'], unix_read_write: true, root_access_enabled: false })] : []),
    );
  }
  findings.push(info('tf.app.file-anf-v6', 'Azure NetApp Files volumes take IPv4 addresses in their delegated subnet (verify IPv6 support for the region before relying on it).', { source: 'https://learn.microsoft.com/en-us/azure/azure-netapp-files/azure-netapp-files-network-topologies' }));
  return blocks;
}

function googleFileService(values: BlueprintValues, findings: Finding[]): HclBlock[] {
  const s = fileSpec(values, 'google');
  const lz = lzRef(values);
  const pfx = namePrefix(values, s.app);
  const labels = x(tagsExpr(s.app, 'google'));
  const project = `${lz}.project`;
  const blocks: HclBlock[] = [...preamble('google', values)];
  if (s.service === 'filestore') {
    if (s.smb) findings.push(warning('tf.app.file-filestore-smb', 'Filestore serves NFS only: SMB shares need Google Cloud NetApp Volumes.', { path: 'protocol' }));
    s.shares.slice(1).forEach((sh) => findings.push(info('tf.app.file-filestore-share', `Share ${sh}: a Filestore instance has one share; ${sh} is a directory of it.`, { path: 'shares' })));
    blocks.push(
      res('google_filestore_instance', 'app', {
        name: x(`"${pfx}-files"`),
        project: x(project),
        location: x(s.ha ? `${lz}.region` : `${lz}.zones[0]`),
        tier: s.ha ? 'REGIONAL' : 'ZONAL',
        protocol: 'NFS_V4_1',
        deletion_protection_enabled: s.ha,
        labels,
      }, [
        blk('file_shares', { name: (s.shares[0] ?? 'data').replace(/-/g, '_'), capacity_gb: Math.max(1024, s.capacity) }, [
          blk('nfs_export_options', { ip_ranges: x(`[for c in ${lz}.mgmt_cidrs : c if !strcontains(c, ":")]`), access_mode: 'READ_WRITE', squash_mode: 'ROOT_SQUASH' }),
        ]),
        blk('networks', { network: x(`${lz}.network_names[${q(s.net)}]`), modes: ['MODE_IPV4'], connect_mode: 'PRIVATE_SERVICE_ACCESS' }),
      ]),
      output('address', 'google_filestore_instance.app.networks[0].ip_addresses[0]'),
    );
    findings.push(info('tf.app.file-filestore-psa', 'Filestore with PRIVATE_SERVICE_ACCESS needs a private services access range on the network (the landing zone\'s, or add one); IPv4 only.', { source: 'https://cloud.google.com/filestore/docs/creating-instances' }));
    return blocks;
  }
  const pw = joinPassword(s);
  if (s.smb) {
    blocks.push(
      pw.block,
      res('google_netapp_active_directory', 'app', {
        name: x(`"${pfx}-ad"`),
        project: x(project),
        location: x(`${lz}.region`),
        domain: s.domain,
        dns: s.dns.join(','),
        net_bios_prefix: s.app.slug.replace(/-/g, '').slice(0, 10),
        username: s.user,
        password: x(`var.${pw.name}`),
        organizational_unit: s.ou || undefined,
        aes_encryption: true,
        ldap_signing: true,
        labels,
      }),
    );
  }
  blocks.push(
    res('google_netapp_storage_pool', 'app', {
      name: x(`"${pfx}-pool"`),
      project: x(project),
      location: x(`${lz}.region`),
      service_level: 'PREMIUM',
      capacity_gib: String(Math.max(2048, s.capacity)),
      network: x(`${lz}.network_ids[${q(s.net)}]`),
      active_directory: s.smb ? x('google_netapp_active_directory.app.id') : undefined,
      labels,
    }),
  );
  for (const share of s.shares) {
    blocks.push(
      res('google_netapp_volume', ident('share', share), {
        name: x(`"${pfx}-${share}"`),
        project: x(project),
        location: x(`${lz}.region`),
        storage_pool: x('google_netapp_storage_pool.app.name'),
        capacity_gib: String(Math.max(100, Math.floor(Math.max(2048, s.capacity) / s.shares.length))),
        share_name: share,
        protocols: s.smb && s.nfs ? ['SMB', 'NFSV4'] : s.smb ? ['SMB'] : ['NFSV4'],
        security_style: s.smb ? 'NTFS' : 'UNIX',
        deletion_policy: 'DEFAULT',
        labels,
      }),
    );
  }
  findings.push(info('tf.app.file-gcnv-psa', 'NetApp Volumes connects through private services access on the network: the landing zone needs the servicenetworking peering (runbook, or the network team).', { source: 'https://cloud.google.com/netapp/volumes/docs/get-started/configure-access/networking' }));
  return blocks;
}

function ociFileService(values: BlueprintValues, findings: Finding[]): HclBlock[] {
  const s = fileSpec(values, 'oci');
  const lz = lzRef(values);
  const pfx = namePrefix(values, s.app);
  const tags = x(tagsExpr(s.app, 'oci'));
  const comp = `${lz}.compartment_id`;
  if (s.smb) findings.push(warning('tf.app.file-oci-smb', 'OCI File Storage serves NFS only: SMB shares stay on a Windows file server VM (or a NetApp Cloud Volumes ONTAP from the marketplace).', { path: 'protocol' }));
  const blocks: HclBlock[] = [
    ...preamble('oci', values),
    res('oci_file_storage_mount_target', 'app', {
      availability_domain: x(`${lz}.zones[0]`),
      compartment_id: x(comp),
      subnet_id: x(subnetOf(lz, s.net, s.tier)),
      display_name: x(`"${pfx}-mt"`),
      nsg_ids: x(`[${securityGroupOf(lz, s.net, s.tier)}]`),
      freeform_tags: tags,
    }),
  ];
  for (const share of s.shares) {
    const id = ident('share', share);
    blocks.push(
      res('oci_file_storage_file_system', id, { availability_domain: x(`${lz}.zones[0]`), compartment_id: x(comp), display_name: x(`"${pfx}-${share}"`), kms_key_id: x(`${lz}.kms_key_id`), freeform_tags: tags }),
      res('oci_file_storage_export', id, {
        export_set_id: x('oci_file_storage_mount_target.app.export_set_id'),
        file_system_id: x(`oci_file_storage_file_system.${id}.id`),
        path: `/${share}`,
      }, [
        {
          type: 'dynamic',
          labels: ['export_options'],
          attributes: attrs({ for_each: x(`[for c in ${lz}.mgmt_cidrs : c if !strcontains(c, ":")]`) }),
          blocks: [blk('content', { source: x('export_options.value'), access: 'READ_WRITE', identity_squash: 'ROOT', require_privileged_source_port: true })],
        },
      ]),
    );
  }
  findings.push(info('tf.app.file-oci-exports', 'The exports allow the landing zone\'s management ranges; add the app tier\'s range (or the clients\') as export options as the app needs.', { path: 'shares' }));
  blocks.push(output('mount_target_ips', 'oci_file_storage_mount_target.app.private_ip_ids'));
  return blocks;
}

// ---------------------------------------------------------------------------
// File transfer
// ---------------------------------------------------------------------------

const TRANSFER_COLUMNS: readonly GridColumn[] = [{ name: 'Name' }, { name: 'Source host' }, { name: 'Source path' }, { name: 'Protocol', options: ['smb', 'nfs'] }, { name: 'Target path' }];
const DEFAULT_TRANSFERS: readonly (readonly string[])[] = [['data', 'fs01.corp.example.com', '/share/data', 'smb', '/data']];

interface TransferRow {
  readonly name: string;
  readonly id: string;
  readonly host: string;
  readonly path: string;
  readonly smb: boolean;
  readonly target: string;
}

function parseTransfers(text: string, findings: Finding[]): TransferRow[] {
  return uniqueNames(parseGrid(text, TRANSFER_COLUMNS.map((c) => c.name)), 'Name', 'transfers', findings).map((r) => ({
    name: rname(r['Name'] ?? ''),
    id: ident(r['Name'] ?? 'row'),
    host: r['Source host'] ?? '',
    path: (r['Source path'] || '/').replace(/\\/g, '/'),
    smb: (r['Protocol'] || 'smb').toLowerCase() !== 'nfs',
    target: r['Target path'] || '/',
  }));
}

function transferInputs(platform: 'aws' | 'azure' | 'google'): BlueprintInput[] {
  return [
    ...appInputs(),
    gridInput('transfers', 'Transfers', TRANSFER_COLUMNS, DEFAULT_TRANSFERS, 'One row per share or export: the source host and path, SMB or NFS, and the path on the target.'),
    ...(platform === 'aws'
      ? [
          { id: 'agent_arn', label: 'DataSync agent (ARN)', control: 'text' as const, default: '', hint: 'The agent deployed on premises and activated (a runbook step); blank: a variable.' },
          { id: 'target_kind', label: 'Target', control: 'select' as const, default: 'fsx-windows', options: [{ value: 'fsx-windows', label: 'FSx for Windows File Server' }, { value: 'fsx-ontap', label: 'FSx for NetApp ONTAP (SVM)' }] },
          { id: 'target_arn', label: 'Target file system or SVM (ARN)', control: 'text' as const, default: '', hint: 'Blank: a variable (the file service item\'s output).' },
          { id: 'domain', label: 'AD domain', control: 'text' as const, default: 'corp.example.com' },
          { id: 'ad_user', label: 'Copy account', control: 'text' as const, default: 'svc-datasync', hint: 'SMB: a member of Backup Operators on the source and target; its password is a sensitive variable.' },
          { id: 'bandwidth_mbps', label: 'Bandwidth limit (Mbit/s)', control: 'number' as const, default: 0, min: 0, hint: '0: no limit.' },
          NETWORK_INPUT,
        ]
      : platform === 'azure'
        ? [
            { id: 'arc_vm_id', label: 'Agent: Arc machine resource id', control: 'text' as const, default: '', hint: 'The Storage Mover agent VM, registered in Azure Arc (a runbook step).' },
            { id: 'arc_vm_uuid', label: 'Agent: Arc machine UUID', control: 'text' as const, default: '' },
            { id: 'target_account_id', label: 'Target storage account id', control: 'text' as const, default: '', hint: 'Blank: a variable.' },
            NETWORK_INPUT,
          ]
        : [
            { id: 'target_kind', label: 'Target', control: 'select' as const, default: 'posix', options: [{ value: 'posix', label: 'A file system the agents mount (Filestore, NetApp Volumes)' }, { value: 'gcs', label: 'A Cloud Storage bucket' }] },
            { id: 'target_bucket', label: 'Target bucket', control: 'text' as const, default: '', hint: 'Cloud Storage target only.' },
          ]),
    LANDING_ZONE_SOURCE,
  ];
}

function awsFileTransfer(values: BlueprintValues, findings: Finding[]): HclBlock[] {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const tags = x(tagsExpr(app, 'aws'));
  const rows = parseTransfers(valueOf(values, 'transfers'), findings);
  const net = rname(valueOf(values, 'network', 'prod'));
  const blocks: HclBlock[] = [...preamble('aws', values)];
  const agent = valueOf(values, 'agent_arn');
  if (!agent) blocks.push(variable(`${app.id}_datasync_agent_arn`, 'string', 'The ARN of the DataSync agent activated on premises.'));
  const agentRef = agent ? q(agent) : `var.${app.id}_datasync_agent_arn`;
  const target = valueOf(values, 'target_arn');
  if (!target) blocks.push(variable(`${app.id}_datasync_target_arn`, 'string', 'The ARN of the target FSx file system (or ONTAP SVM).'));
  const targetRef = target ? q(target) : `var.${app.id}_datasync_target_arn`;
  const pwName = `${app.id}_datasync_password`;
  const anySmb = rows.some((r) => r.smb);
  const ontap = valueOf(values, 'target_kind', 'fsx-windows') === 'fsx-ontap';
  if (anySmb) blocks.push(secretVariable(pwName, `The password of ${valueOf(values, 'ad_user', 'svc-datasync')}, the account DataSync reads the SMB sources and writes the target with.`));
  const user = valueOf(values, 'ad_user', 'svc-datasync');
  const domain = valueOf(values, 'domain', 'corp.example.com');
  const sgArn = `"arn:aws:ec2:\${${lz}.region}:\${data.aws_caller_identity.transfer.account_id}:security-group/\${${lz}.security_group_ids[${q(`${net}/app`)}]}"`;
  blocks.push(
    dat('aws_caller_identity', 'transfer', {}),
    res('aws_cloudwatch_log_group', 'transfer', { name: x(`"/aws/datasync/${pfx}"`), retention_in_days: 90, tags }),
  );
  const bps = numberOf(values, 'bandwidth_mbps', 0);
  for (const r of rows) {
    const [share = '', ...rest] = r.path.replace(/^\/+/, '').split('/');
    if (r.smb) {
      blocks.push(res('aws_datasync_location_smb', `src_${r.id}`, { server_hostname: r.host, subdirectory: `/${[share, ...rest].join('/')}`, user, domain, password: x(`var.${pwName}`), agent_arns: x(`[${agentRef}]`), tags }, [blk('mount_options', { version: 'SMB3' })]));
    } else {
      blocks.push(res('aws_datasync_location_nfs', `src_${r.id}`, { server_hostname: r.host, subdirectory: r.path, tags }, [blk('on_prem_config', { agent_arns: x(`[${agentRef}]`) }), blk('mount_options', { version: 'AUTOMATIC' })]));
    }
    if (ontap) {
      blocks.push(res('aws_datasync_location_fsx_ontap_file_system', `dst_${r.id}`, { storage_virtual_machine_arn: x(targetRef), security_group_arns: x(`[${sgArn}]`), subdirectory: r.target, tags }, [
        blk('protocol', {}, [r.smb ? blk('smb', { user, domain, password: x(`var.${pwName}`) }, [blk('mount_options', { version: 'SMB3' })]) : blk('nfs', {}, [blk('mount_options', { version: 'NFS3' })])]),
      ]));
    } else {
      if (!r.smb) findings.push(warning('tf.app.transfer-nfs-to-fsxw', `${r.name}: an NFS source into FSx for Windows loses its POSIX permissions (the target is NTFS).`, { path: 'transfers' }));
      blocks.push(res('aws_datasync_location_fsx_windows_file_system', `dst_${r.id}`, { fsx_filesystem_arn: x(targetRef), user, domain, password: x(`var.${pwName}`), security_group_arns: x(`[${sgArn}]`), subdirectory: r.target, tags }));
    }
    blocks.push(
      res('aws_datasync_task', r.id, {
        name: x(`"${pfx}-${r.name}"`),
        source_location_arn: x(`${r.smb ? 'aws_datasync_location_smb' : 'aws_datasync_location_nfs'}.src_${r.id}.arn`),
        destination_location_arn: x(`${ontap ? 'aws_datasync_location_fsx_ontap_file_system' : 'aws_datasync_location_fsx_windows_file_system'}.dst_${r.id}.arn`),
        cloudwatch_log_group_arn: x('aws_cloudwatch_log_group.transfer.arn'),
        tags,
      }, [
        blk('options', {
          verify_mode: 'ONLY_FILES_TRANSFERRED',
          transfer_mode: 'CHANGED',
          preserve_deleted_files: 'REMOVE',
          overwrite_mode: 'ALWAYS',
          posix_permissions: r.smb ? 'NONE' : 'PRESERVE',
          uid: r.smb ? 'NONE' : 'INT_VALUE',
          gid: r.smb ? 'NONE' : 'INT_VALUE',
          security_descriptor_copy_flags: r.smb ? 'OWNER_DACL_SACL' : undefined,
          log_level: 'TRANSFER',
          bytes_per_second: bps > 0 ? Math.floor((bps * 1_000_000) / 8) : -1,
          task_queueing: 'ENABLED',
        }),
      ]),
    );
  }
  if (rows.some((r) => r.smb)) findings.push(info('tf.app.transfer-sacl', 'OWNER_DACL_SACL copies the audit ACLs too: the copy account needs the "Manage auditing and security log" right on the source and target.', { source: 'https://docs.aws.amazon.com/datasync/latest/userguide/API_Options.html' }));
  blocks.push(output('task_arns', `{ ${rows.map((r) => `${q(r.name)} = aws_datasync_task.${r.id}.arn`).join(', ')} }`, 'The tasks the execution kit starts (replicate) and runs once more at cutover.'));
  return blocks;
}

function azureFileTransfer(values: BlueprintValues, findings: Finding[]): HclBlock[] {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const net = rname(valueOf(values, 'network', 'prod'));
  const rows = parseTransfers(valueOf(values, 'transfers'), findings);
  const nfs = rows.filter((r) => !r.smb);
  for (const r of rows.filter((x0) => x0.smb)) {
    findings.push(info('tf.app.transfer-azure-smb', `${r.name}: SMB into Azure Files moves with Azure File Sync (the file service's sync groups) or robocopy in the execution kit; Storage Mover's SMB endpoints are not in the provider.`, { path: 'transfers' }));
  }
  const blocks: HclBlock[] = [...preamble('azure', values)];
  const target = valueOf(values, 'target_account_id');
  if (!target) blocks.push(variable(`${app.id}_mover_target_account_id`, 'string', 'The resource id of the storage account the NFS data lands in (blob containers).'));
  const targetRef = target ? q(target) : `var.${app.id}_mover_target_account_id`;
  const arcId = valueOf(values, 'arc_vm_id');
  const arcUuid = valueOf(values, 'arc_vm_uuid');
  if (!arcId || !arcUuid) blocks.push(variable(`${app.id}_mover_agent`, 'object({\n    arc_id   = string\n    arc_uuid = string\n  })', 'The Storage Mover agent VM as Azure Arc registered it: its resource id and UUID.'));
  const agentId = arcId ? q(arcId) : `var.${app.id}_mover_agent.arc_id`;
  const agentUuid = arcUuid ? q(arcUuid) : `var.${app.id}_mover_agent.arc_uuid`;
  blocks.push(
    res('azurerm_storage_mover', 'app', { name: x(`"${pfx}-mover"`), resource_group_name: x(`${lz}.resource_group[${q(net)}]`), location: x(`${lz}.location`), tags: x(tagsExpr(app, 'azure')) }),
    res('azurerm_storage_mover_agent', 'app', { name: 'agent1', storage_mover_id: x('azurerm_storage_mover.app.id'), arc_virtual_machine_id: x(agentId), arc_virtual_machine_uuid: x(agentUuid) }),
    res('azurerm_storage_mover_project', 'app', { name: app.slug, storage_mover_id: x('azurerm_storage_mover.app.id') }),
  );
  for (const r of nfs) {
    blocks.push(
      res('azurerm_storage_mover_source_endpoint', r.id, { name: `${r.name}-src`, storage_mover_id: x('azurerm_storage_mover.app.id'), host: r.host, export: r.path, nfs_version: 'NFSauto' }),
      res('azurerm_storage_mover_target_endpoint', r.id, { name: `${r.name}-dst`, storage_mover_id: x('azurerm_storage_mover.app.id'), storage_account_id: x(targetRef), storage_container_name: r.name }),
      res('azurerm_storage_mover_job_definition', r.id, {
        name: r.name,
        storage_mover_project_id: x('azurerm_storage_mover_project.app.id'),
        agent_name: x('azurerm_storage_mover_agent.app.name'),
        copy_mode: 'Mirror',
        source_name: x(`azurerm_storage_mover_source_endpoint.${r.id}.name`),
        target_name: x(`azurerm_storage_mover_target_endpoint.${r.id}.name`),
        target_sub_path: r.target.replace(/^\/+/, '') || undefined,
      }),
    );
  }
  if (nfs.length === 0) findings.push(info('tf.app.transfer-azure-none', 'No NFS rows: the mover, its agent and project are created for later rows.', { path: 'transfers' }));
  blocks.push(output('project', 'azurerm_storage_mover_project.app.name'));
  return blocks;
}

function googleFileTransfer(values: BlueprintValues, findings: Finding[]): HclBlock[] {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const project = `${lz}.project`;
  const rows = parseTransfers(valueOf(values, 'transfers'), findings);
  const gcs = valueOf(values, 'target_kind', 'posix') === 'gcs';
  const bucket = valueOf(values, 'target_bucket');
  const blocks: HclBlock[] = [
    ...preamble('google', values),
    ...(gcs && !bucket ? [variable(`${app.id}_transfer_bucket`, 'string', 'The Cloud Storage bucket the data lands in.')] : []),
    res('google_storage_transfer_agent_pool', 'app', { name: x(`"${pfx}-agents"`), project: x(project), display_name: `${app.name} transfer agents` }, [], 'The agents run on Linux hosts that mount the source (SMB with mount.cifs, or NFS) and the target file system.'),
  ];
  for (const r of rows) {
    blocks.push(
      res('google_storage_transfer_job', r.id, {
        description: `${app.name}: ${r.name} (${r.host}:${r.path})`,
        project: x(project),
        status: 'ENABLED',
      }, [
        blk('transfer_spec', {
          source_agent_pool_name: x('google_storage_transfer_agent_pool.app.id'),
          sink_agent_pool_name: gcs ? undefined : x('google_storage_transfer_agent_pool.app.id'),
        }, [
          blk('posix_data_source', { root_directory: `/mnt/source/${r.name}` }),
          gcs ? blk('gcs_data_sink', { bucket_name: bucket || x(`var.${app.id}_transfer_bucket`), path: `${r.target.replace(/^\/+|\/+$/g, '')}/` }) : blk('posix_data_sink', { root_directory: `/mnt/target${r.target.startsWith('/') ? r.target : `/${r.target}`}` }),
          blk('transfer_options', { delete_objects_unique_in_sink: true, overwrite_when: 'DIFFERENT' }),
        ]),
        blk('logging_config', { enable_on_prem_gcs_transfer_logs: true, log_actions: ['COPY', 'DELETE'], log_action_states: ['SUCCEEDED', 'FAILED'] }),
      ]),
    );
  }
  findings.push(info('tf.app.transfer-gcp-mounts', `The agent hosts mount each source at /mnt/source/<row name> (${rows.some((r) => r.smb) ? 'SMB through mount.cifs with the copy account from the environment, ' : ''}NFS read-only) and the target at /mnt/target; the jobs have no schedule and are run by the execution kit.`, { source: 'https://docs.cloud.google.com/storage-transfer/docs/on-prem-set-up' }));
  blocks.push(output('jobs', `{ ${rows.map((r) => `${q(r.name)} = google_storage_transfer_job.${r.id}.name`).join(', ')} }`));
  return blocks;
}

// ---------------------------------------------------------------------------

const SERVICE_EMITS: Readonly<Record<MigCloud, readonly string[]>> = {
  aws: ['aws_cloudwatch_log_group', 'aws_fsx_windows_file_system', 'aws_fsx_ontap_file_system', 'aws_fsx_ontap_storage_virtual_machine', 'aws_fsx_ontap_volume'],
  azure: [
    'azurerm_storage_account', 'azurerm_private_endpoint', 'azurerm_storage_share', 'azurerm_storage_sync', 'azurerm_storage_sync_group', 'azurerm_storage_sync_cloud_endpoint',
    'azurerm_subnet', 'azurerm_netapp_account', 'azurerm_netapp_pool', 'azurerm_netapp_volume',
  ],
  google: ['google_filestore_instance', 'google_netapp_active_directory', 'google_netapp_storage_pool', 'google_netapp_volume'],
  oci: ['oci_file_storage_mount_target', 'oci_file_storage_file_system', 'oci_file_storage_export'],
};
const TRANSFER_EMITS = {
  aws: ['aws_cloudwatch_log_group', 'aws_datasync_location_smb', 'aws_datasync_location_nfs', 'aws_datasync_location_fsx_windows_file_system', 'aws_datasync_location_fsx_ontap_file_system', 'aws_datasync_task'],
  azure: ['azurerm_storage_mover', 'azurerm_storage_mover_agent', 'azurerm_storage_mover_project', 'azurerm_storage_mover_source_endpoint', 'azurerm_storage_mover_target_endpoint', 'azurerm_storage_mover_job_definition'],
  google: ['google_storage_transfer_agent_pool', 'google_storage_transfer_job'],
} as const;
const CLOUD: Readonly<Record<MigCloud, string>> = { aws: 'AWS', azure: 'Azure', google: 'Google Cloud (GCP)', oci: 'OCI' };

function fileService(platform: MigCloud): Blueprint {
  return {
    id: `${platform}_app_file_service`,
    label: 'App file service',
    group: PATTERN_GROUP,
    description: {
      aws: 'FSx for Windows File Server joined to the domain (Multi-AZ for tier 0 and 1, audit logs, dual-stack), or FSx for NetApp ONTAP with an SVM and a volume per share.',
      azure: 'Azure Files (premium, ZRS, SMB 3.1.1 with Kerberos and AES-256-GCM, a private endpoint, a File Sync group per share), or Azure NetApp Files with an AD connection, a capacity pool and a volume per share.',
      google: 'Filestore (NFS; regional for tier 0 and 1), or Google Cloud NetApp Volumes with an Active Directory policy, a storage pool and a volume per share (SMB, NFS or both).',
      oci: 'OCI File Storage: a mount target in the tier\'s subnet and NSG, and a file system and an export per share.',
    }[platform],
    inputs: serviceInputs(platform),
    emits: SERVICE_EMITS[platform],
    build: (values: BlueprintValues) => {
      const findings: Finding[] = [];
      const blocks =
        platform === 'aws' ? awsFileService(values, findings)
        : platform === 'azure' ? azureFileService(values, findings)
        : platform === 'google' ? googleFileService(values, findings)
        : ociFileService(values, findings);
      return { files: { 'main.tf': patternMainTf(blocks, `${CLOUD[platform]} file service: ${appOf(values).name}`) }, findings };
    },
  };
}

function fileTransfer(platform: 'aws' | 'azure' | 'google'): Blueprint {
  const tool = { aws: 'AWS DataSync', azure: 'Azure Storage Mover', google: 'Storage Transfer Service' }[platform];
  return {
    id: `${platform}_app_file_transfer`,
    label: `App file transfer (${tool})`,
    group: PATTERN_GROUP,
    description: {
      aws: 'DataSync locations on the activated agent (SMB or NFS) and on FSx, and a task per row that copies changed files with ACLs (owner, DACL and SACL) and verifies what it moved.',
      azure: 'A Storage Mover with its Arc-registered agent and a project, and per NFS row a source endpoint, a blob target and a mirroring job definition.',
      google: 'A Storage Transfer Service agent pool and a POSIX-to-POSIX (or to Cloud Storage) transfer job per row, with transfer logs.',
    }[platform],
    inputs: transferInputs(platform),
    emits: [...TRANSFER_EMITS[platform]],
    build: (values: BlueprintValues) => {
      const findings: Finding[] = [];
      const blocks = platform === 'aws' ? awsFileTransfer(values, findings) : platform === 'azure' ? azureFileTransfer(values, findings) : googleFileTransfer(values, findings);
      return { files: { 'main.tf': patternMainTf(blocks, `${tool}: ${appOf(values).name}`) }, findings };
    },
  };
}

export const FILE_BLUEPRINTS: readonly Blueprint[] = [
  ...(['aws', 'azure', 'google', 'oci'] as const).map(fileService),
  ...(['aws', 'azure', 'google'] as const).map(fileTransfer),
];
