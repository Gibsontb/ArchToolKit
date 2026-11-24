import { error, type Finding } from '../core/findings.ts';
import type { Blueprint } from '../kit/blueprint.ts';
import { blk, dat, hcl, output, res, x } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.ts';
const first = ['SINGLE_AZ_1', 'MULTI_AZ_1'], second = ['SINGLE_AZ_2', 'MULTI_AZ_2'];
export const AWS_FSX_ONTAP_SERVICE = {
  id: 'aws_service_fsx_ontap', label: 'Set up FSx for ONTAP NFS storage',
  description: 'One-HA-pair first/second-generation filesystem, private NFSv4.1 client/admin access, UNIX SVM/volume, backups and configured ONTAP export-policy/ownership commands.',
  emits: ['aws_fsx_ontap_file_system', 'aws_fsx_ontap_storage_virtual_machine', 'aws_fsx_ontap_volume', 'aws_security_group'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Filesystem name', control: 'text' },
    { id: 'deployment', label: 'Deployment type', control: 'select', default: 'MULTI_AZ_2', options: [...first, ...second].map(value => ({ value, label: value.replaceAll('_', ' ') })), hint: 'One HA pair in this recipe. Regional generation availability must be verified. Third-generation and multi-HA-pair designs require another workflow.' },
    { id: 'storage', label: 'Filesystem SSD capacity (GiB)', control: 'number', default: 1024 },
    { id: 'throughput_first', label: 'First-generation throughput (MB/s)', control: 'select', default: '128', options: [128, 256, 512, 1024, 2048].map(value => ({ value: String(value), label: String(value) })), showWhen: { input: 'deployment', equals: first } },
    { id: 'throughput_single2', label: 'Single-AZ second-generation throughput (MB/s)', control: 'select', default: '1536', options: [1536, 3072].map(value => ({ value: String(value), label: String(value) })), showWhen: { input: 'deployment', equals: ['SINGLE_AZ_2'] } },
    { id: 'throughput_multi2', label: 'Multi-AZ second-generation throughput (MB/s)', control: 'select', default: '384', options: [384, 768, 1536, 3072].map(value => ({ value: String(value), label: String(value) })), showWhen: { input: 'deployment', equals: ['MULTI_AZ_2'] } },
    { id: 'subnets', label: 'Private subnet IDs, preferred first', control: 'text', hint: 'One subnet for Single-AZ; two same-VPC distinct-AZ subnets for Multi-AZ.' },
    { id: 'routes', label: 'Multi-AZ client route table IDs', control: 'text', showWhen: { input: 'deployment', equals: ['MULTI_AZ_1', 'MULTI_AZ_2'] }, hint: 'Explicit same-VPC route tables; FSx will add its floating-endpoint routes. Review existing destinations before apply.' },
    { id: 'endpoint_cidr', label: 'Multi-AZ floating-endpoint IPv4 CIDR', control: 'text', default: '198.19.0.0/24', showWhen: { input: 'deployment', equals: ['MULTI_AZ_1', 'MULTI_AZ_2'] }, hint: 'Aligned /16–/24 range that does not overlap any subnet; review reachability through VPN/Direct Connect/TGW. This is not a public IP allocation.' },
    { id: 'clients', label: 'NFS client security group IDs', control: 'text', hint: '1–5 existing same-VPC groups allowed TCP 2049. This recipe uses NFSv4.1 only.' },
    { id: 'admins', label: 'Storage administrator security group IDs', control: 'text', hint: '1–5 existing same-VPC groups allowed private SSH/HTTPS management. fsxadmin password is supplied securely at deployment.' },
    { id: 'client_cidrs', label: 'NFS export client IPv4 CIDRs', control: 'text', hint: 'Exact approved routed client ranges (/8–/32), comma-separated. No wildcard/default route; these are also enforced in the exported ONTAP export rules.' },
    { id: 'volume', label: 'UNIX volume name', control: 'text', default: 'application' },
    { id: 'volume_gib', label: 'Volume capacity (GiB)', control: 'number', default: 64 },
    { id: 'uid', label: 'Volume root owner UID', control: 'number', default: 1000 },
    { id: 'gid', label: 'Volume root owner GID', control: 'number', default: 1000 },
    { id: 'kms', label: 'Optional filesystem KMS key ARN', control: 'text', hint: 'Existing enabled regional symmetric key; blank uses FSx-managed storage encryption. NFS AUTH_SYS is not wire encryption or strong user authentication.' },
    { id: 'retention', label: 'Automatic backup retention (days)', control: 'number', default: 7 },
  ],
  build(values): ReturnType<typeof awsServiceModule> {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.fsx.ontap.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), partition = awsServicePartition(region), name = String(values.name ?? '').trim(), deployment = String(values.deployment ?? ''), multi = deployment.startsWith('MULTI'), generation2 = second.includes(deployment), volume = String(values.volume ?? '').trim(), kms = String(values.kms ?? '').trim();
    const storage = Number(values.storage), volumeGib = Number(values.volume_gib), uid = Number(values.uid), gid = Number(values.gid), retention = Number(values.retention);
    const throughput = Number(values[generation2 ? (multi ? 'throughput_multi2' : 'throughput_single2') : 'throughput_first']);
    const list = (id: string) => [...new Set(String(values[id] ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    const subnets = list('subnets'), clients = list('clients'), admins = list('admins'), cidrs = list('client_cidrs'), routes = multi ? list('routes') : [], endpointCidr = multi ? String(values.endpoint_cidr ?? '').trim() : '';
    const validCidr = (value: string, minimum: number, maximum: number) => {
      const parts = value.split('/'), octets = parts[0]?.split('.').map(Number) ?? [], prefix = Number(parts[1]);
      if (!/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(value) || octets.length !== 4 || octets.some(part => !Number.isInteger(part) || part < 0 || part > 255) || !Number.isInteger(prefix) || prefix < minimum || prefix > maximum) return false;
      const address = octets.reduce((total, part) => total * 256 + part, 0);
      return address % 2 ** (32 - prefix) === 0;
    };
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(name) || name.endsWith('-') || name.includes('--')) reject('name', 'Use a lowercase name up to 40 characters, without trailing/consecutive hyphens.');
    if (![...first, ...second].includes(deployment)) reject('deployment', 'Choose a supported one-HA-pair generation/deployment type.');
    if (!Number.isInteger(storage) || storage < 1024 || storage > (generation2 ? 524288 : 196608)) reject('storage', 'Use 1,024 GiB up to 192 TiB first-generation or 512 TiB second-generation for this one-pair recipe.');
    if (!(generation2 ? (multi ? [384, 768, 1536, 3072] : [1536, 3072]) : [128, 256, 512, 1024, 2048]).includes(throughput)) reject(generation2 ? (multi ? 'throughput_multi2' : 'throughput_single2') : 'throughput_first', 'Select a throughput supported by this generation/deployment subset.');
    if (subnets.length !== (multi ? 2 : 1) || subnets.some(value => !/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('subnets', 'Supply one private subnet for Single-AZ or two distinct-AZ subnets for Multi-AZ, preferred subnet first.');
    for (const [id, ids] of [['clients', clients], ['admins', admins]] as const) if (!ids.length || ids.length > 5 || ids.some(value => !/^sg-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject(id, 'Use 1–5 existing same-VPC security group IDs.');
    if (multi && (!routes.length || routes.length > 20 || routes.some(value => !/^rtb-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value)))) reject('routes', 'Use 1–20 explicit same-VPC client route table IDs.');
    if (multi && !validCidr(endpointCidr, 16, 24)) reject('endpoint_cidr', 'Use an aligned nonoverlapping IPv4 /16–/24 endpoint range.');
    if (!cidrs.length || cidrs.length > 20 || cidrs.some(value => !validCidr(value, 8, 32))) reject('client_cidrs', 'Use 1–20 aligned approved client IPv4 CIDRs (/8–/32), without default routes.');
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(volume)) reject('volume', 'Use a lowercase UNIX volume name up to 40 characters.');
    if (!Number.isInteger(volumeGib) || volumeGib < 1 || volumeGib > Math.floor(storage * 0.8)) reject('volume_gib', 'Use a positive whole GiB volume within 80% of this filesystem SSD capacity; account separately for root volume, snapshots and growth.');
    for (const [id, value] of [['uid', uid], ['gid', gid]] as const) if (!Number.isInteger(value) || value < 1 || value > 2147483647) reject(id, 'Use a non-root positive UNIX ID up to 2,147,483,647.');
    if (!Number.isInteger(retention) || retention < 1 || retention > 90) reject('retention', 'Use 1–90 days of automatic backup retention.');
    if (kms && !new RegExp('^arn:' + partition + ':kms:' + region + ':\\d{12}:key/(?:[a-f0-9-]{36}|mrk-[a-f0-9]{32})$').test(kms)) reject('kms', 'Use an existing regional symmetric KMS key ARN.');
    const allGroups = [...new Set([...clients, ...admins])], svm = name + '-svm';
    const ipNumber = (cidr: string, host: number) => 'sum([for index, octet in split(".", cidrhost(' + cidr + ', ' + host + ')) : tonumber(octet) * pow(256, 3 - index)])';
    const noEndpointOverlap = multi ? ' && alltrue([for subnet in data.aws_subnet.vpc : try(!(' + ipNumber(JSON.stringify(endpointCidr), 0) + ' <= ' + ipNumber('subnet.cidr_block', -1) + ' && ' + ipNumber('subnet.cidr_block', 0) + ' <= ' + ipNumber(JSON.stringify(endpointCidr), -1) + '), false)])' : '';
    const guide = [
      '# FSx for NetApp ONTAP — one-pair NFSv4.1 UNIX target',
      '## Prepare\nVerify regional availability of the exact generation/deployment, quotas, one-HA-pair throughput and SSD/IOPS sizing. This recipe covers first/second generation and a single FlexVol, not third generation, multiple HA pairs, FlexGroup, SMB/AD, iSCSI, SnapLock, SnapMirror or automatic data migration. Automatic SSD IOPS are selected; higher special throughput/IOPS designs need separate sizing. Physical SSD is different from logical volume capacity, snapshots, root volume and capacity-pool storage. This volume uses tiering NONE to keep data in the selected SSD tier; no unrequested capacity-pool policy is enabled.',
      '## Data security and network\nNFSv4.1 AUTH_SYS trusts client-supplied UNIX IDs; it is not Kerberos authentication or NFS wire encryption. This bounded recipe is only appropriate where the data owner approves that model inside an appropriately protected network. If the boundary requires authenticated/encrypted NFS, design Kerberos/AD or an approved encrypted transport before moving data; encrypted disks and a private SG do not satisfy that requirement by themselves. The new SG permits only selected NFS groups on TCP2049 and selected administrator groups on private SSH/HTTPS. Existing groups must have appropriate egress; routes/NACLs/DNS remain prerequisites. Multi-AZ floating addresses must not overlap any subnet. The listed route tables are changed by FSx to reach floating endpoints; review route conflicts and remote VPN/Direct Connect/TGW propagation before apply.',
      '## Deploy\nRun terraform init, terraform validate and terraform plan -out=service.tfplan. Supply fsx_admin_password through the approved sensitive deployment-variable mechanism; never put it in a command history or generated file. The variable requires 12–50 printable ASCII characters and at least three character classes. Sensitive values still exist in Terraform state/plans: protect backend/state/plan access and rotate through the owner-approved process. Review filesystem, SVM, empty UNIX volume, KMS, automatic backups, floating routes and groups, then apply the reviewed plan. Wait for filesystem/SVM/volume AVAILABLE. No ONTAP SSH command, mount, copy or cutover occurs during apply. The program does not output the password.',
      '## Configure ONTAP explicitly\nVerify the management endpoint/SSH host key through the approved channel, then connect interactively as fsxadmin. Review ONTAP-CONFIG.txt and execute the relevant commands in that ONTAP CLI session. The commands enable NFSv4.1, disable v3/v4.0 for this new SVM, create exact client-CIDR export rules with root squashing, bind them to the new volume, and set UNIX owner/group plus 0750 root permissions. Inspect existing policy/volume state before re-running create commands. These are required post-deployment configuration writes, not actions already performed by Terraform. The default SVM root export/namespace traversal also needs owner review; clients must reach the application junction through the root export. Do not broaden root/superuser access merely to bypass a permissions failure.',
      '## Mount and verify\nAfter export/identity checks, review and run MOUNT-READONLY.sh from an approved client with the NFS client tools and Terraform available. It mounts only this deployment endpoint/junction with NFSv4.1, sec=sys and read-only client options. Test traversal/read as the configured UID/GID; root is squashed and is not the application identity. Reject unlisted source addresses, incorrect IDs and nonapproved groups. Owner-approved read/write pilot tests require a separately reviewed writable mount; no production mount replacement is included. Test Multi-AZ failover/reconnect, actual observed throughput, backup creation and isolated restore. Review ONTAP security/audit configuration, logs, retention and monitoring separately; this recipe does not claim that NFS protocol auditing is configured.',
      '## Migration and recovery\nFor an existing NetApp estate, assess a separately configured SnapMirror relationship, compatible ONTAP versions, intercluster routing/ports, peer identities and resync/cutback. Other NFS sources can use a separately scoped DataSync/copy workflow. Inventory UID/GID mappings, export policies, ACLs, sparse files, links, snapshots and application dependencies; reconcile counts, sizes and application behavior before final write freeze and cutover. Preserve source and a tested write-reconciliation/cutback path until acceptance. The target is empty after creation. Automatic/final backups do not constitute a tested recovery process. Volume skip_final_backup=false and Terraform prevent_destroy guard removal, but retention and state protections still require owner administration.',
      'https://docs.aws.amazon.com/fsx/latest/ONTAPGuide/managing-file-systems.html\nhttps://docs.aws.amazon.com/fsx/latest/APIReference/API_CreateFileSystemOntapConfiguration.html\nhttps://docs.netapp.com/us-en/ontap-cli-9171/volume-modify.html',
    ].join('\n\n') + '\n';
    const result = awsServiceModule(region, [
      blk('variable', { type: x('string'), sensitive: true, nullable: false, description: 'Deploy-time fsxadmin password; protect Terraform state and plan files.' }, [blk('validation', { condition: x('can(regex("^[!-~]{12,50}$", var.fsx_admin_password)) && sum([for pattern in ["[A-Z]", "[a-z]", "[0-9]", "[^A-Za-z0-9]"] : length(regexall(pattern, var.fsx_admin_password)) > 0 ? 1 : 0]) >= 3'), error_message: 'Use 12–50 printable nonspace ASCII characters and at least three of uppercase, lowercase, digit and symbol.' })], ['fsx_admin_password']),
      dat('aws_subnet', 'selected', { for_each: x('toset(' + JSON.stringify(subnets) + ')'), id: x('each.value') }),
      ...(multi ? [dat('aws_subnets', 'vpc', {}, [blk('filter', { name: 'vpc-id', values: x('[data.aws_subnet.selected[' + JSON.stringify(subnets[0] ?? '') + '].vpc_id]') })]), dat('aws_subnet', 'vpc', { for_each: x('toset(data.aws_subnets.vpc.ids)'), id: x('each.value') })] : []),
      dat('aws_security_group', 'selected', { for_each: x('toset(' + JSON.stringify(allGroups) + ')'), id: x('each.value') }),
      dat('aws_route_table', 'selected', { for_each: x('toset(' + JSON.stringify(routes) + ')'), route_table_id: x('each.value') }),
      ...(kms ? [dat('aws_kms_key', 'storage', { key_id: kms })] : []),
      res('aws_security_group', 'filesystem', { name: name + '-ontap', description: 'Approved ONTAP NFSv4.1 and storage administrators', vpc_id: x('data.aws_subnet.selected[' + JSON.stringify(subnets[0] ?? '') + '].vpc_id') }, [
        blk('ingress', { protocol: 'tcp', from_port: 2049, to_port: 2049, security_groups: clients }),
        ...[22, 443].map(port => blk('ingress', { protocol: 'tcp', from_port: port, to_port: port, security_groups: admins })),
      ]),
      res('aws_fsx_ontap_file_system', 'configured', { deployment_type: deployment, storage_capacity: storage, storage_type: 'SSD', throughput_capacity_per_ha_pair: throughput, ...(generation2 ? { ha_pairs: 1 } : {}), subnet_ids: subnets, preferred_subnet_id: subnets[0] ?? '', security_group_ids: x('[aws_security_group.filesystem.id]'), ...(multi ? { route_table_ids: routes, endpoint_ip_address_range: endpointCidr } : {}), ...(kms ? { kms_key_id: x('data.aws_kms_key.storage.arn') } : {}), fsx_admin_password: x('var.fsx_admin_password'), automatic_backup_retention_days: retention, tags: x(hcl({ Name: name })) }, [
        blk('disk_iops_configuration', { mode: 'AUTOMATIC' }),
        blk('lifecycle', { prevent_destroy: true }, [blk('precondition', { condition: x('length(distinct([for subnet in data.aws_subnet.selected : subnet.vpc_id])) == 1 && length(distinct([for subnet in data.aws_subnet.selected : subnet.availability_zone])) == ' + (multi ? 2 : 1) + ' && alltrue([for group in data.aws_security_group.selected : contains([for subnet in data.aws_subnet.selected : subnet.vpc_id], group.vpc_id)]) && alltrue([for route in data.aws_route_table.selected : contains([for subnet in data.aws_subnet.selected : subnet.vpc_id], route.vpc_id)])' + noEndpointOverlap + (kms ? ' && data.aws_kms_key.storage.enabled && data.aws_kms_key.storage.key_spec == "SYMMETRIC_DEFAULT"' : '')), error_message: 'Use distinct-AZ same-VPC subnets/groups/route tables, nonoverlapping floating IPs and an enabled symmetric key.' })]),
      ]),
      res('aws_fsx_ontap_storage_virtual_machine', 'configured', { name: svm, file_system_id: x('aws_fsx_ontap_file_system.configured.id'), root_volume_security_style: 'UNIX', tags: x(hcl({ Name: svm })) }),
      res('aws_fsx_ontap_volume', 'configured', { name: volume, storage_virtual_machine_id: x('aws_fsx_ontap_storage_virtual_machine.configured.id'), junction_path: '/' + volume, size_in_megabytes: volumeGib * 1024, security_style: 'UNIX', ontap_volume_type: 'RW', volume_style: 'FLEXVOL', storage_efficiency_enabled: true, snapshot_policy: 'default', skip_final_backup: false, copy_tags_to_backups: true, tags: x(hcl({ Name: volume })) }, [blk('tiering_policy', { name: 'NONE' }), blk('lifecycle', { prevent_destroy: true })]),
      output('filesystem_id', 'aws_fsx_ontap_file_system.configured.id'),
      output('management_endpoint', 'aws_fsx_ontap_file_system.configured.endpoints[0].management[0].dns_name'),
      output('nfs_endpoint', 'aws_fsx_ontap_storage_virtual_machine.configured.endpoints[0].nfs[0].dns_name'),
      output('volume_id', 'aws_fsx_ontap_volume.configured.id'),
    ], guide, findings);
    const commands = [
      '# Run in a verified ONTAP CLI session after reviewing the new filesystem/SVM/volume.',
      'vserver nfs show -vserver ' + svm,
      'vserver export-policy show -vserver ' + svm,
      'volume show -vserver ' + svm + ' -volume ' + volume + ' -fields policy,unix-permissions,user,group',
      '# The following commands modify only this new SVM/application volume. Review before executing.',
      'vserver nfs modify -vserver ' + svm + ' -v4.1 enabled -v3 disabled -v4.0 disabled',
      'vserver export-policy create -vserver ' + svm + ' -policyname archtoolkit_clients',
      ...cidrs.map((cidr, index) => 'vserver export-policy rule create -vserver ' + svm + ' -policyname archtoolkit_clients -ruleindex ' + (index + 1) + ' -protocol nfs4 -clientmatch ' + cidr + ' -rorule sys -rwrule sys -superuser none'),
      'volume modify -vserver ' + svm + ' -volume ' + volume + ' -policy archtoolkit_clients -user ' + uid + ' -group ' + gid + ' -unix-permissions 0750',
      'vserver export-policy rule show -vserver ' + svm + ' -policyname archtoolkit_clients',
      'volume show -vserver ' + svm + ' -volume ' + volume + ' -fields policy,unix-permissions,user,group',
    ].join('\n') + '\n';
    const mount = [
      '#!/usr/bin/env sh',
      'set -eu',
      '# Requires reviewed ONTAP exports, authorized client/UID/GID and an approved existing mount directory.',
      'if [ "$#" -ne 1 ] || [ ! -d "$1" ]; then echo "Supply one approved existing mount directory." >&2; exit 1; fi',
      'case "$1" in /*) ;; *) echo "Use an absolute approved mount directory." >&2; exit 1;; esac',
      'endpoint="$(terraform output -raw nfs_endpoint)"',
      'case "$endpoint" in ""|[!A-Za-z0-9]*|*[!A-Za-z0-9.-]*) echo "Invalid NFS endpoint." >&2; exit 1;; esac',
      'mount -t nfs -o ro,nfsvers=4.1,sec=sys "$endpoint:/' + volume + '" "$1"',
    ].join('\n') + '\n';
    return { ...result, files: { ...result.files, 'ONTAP-CONFIG.txt': commands, 'MOUNT-READONLY.sh': mount } };
  },
} satisfies Blueprint;
