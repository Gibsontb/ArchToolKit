import { error, type Finding } from '../core/findings.ts';
import { isIpv4Address } from '../core/ip.ts';
import type { Blueprint } from '../kit/blueprint.ts';
import { blk, dat, hcl, output, res, x } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.ts';
const rates = [8, 16, 32, 64, 128, 256, 512, 1024, 2048];
export const AWS_FSX_WINDOWS_SERVICE = {
  id: 'aws_service_fsx_windows', label: 'Set up FSx for Windows File Server',
  description: 'Private single-/multi-AZ SMB storage, AWS Managed or self-managed AD join, SSD/HDD capacity, backups, optional existing audit destination and encryption setup script.',
  emits: ['aws_fsx_windows_file_system'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'File system name', control: 'text' },
    { id: 'deployment', label: 'Availability', control: 'select', default: 'MULTI_AZ_1', options: [{ value: 'MULTI_AZ_1', label: 'Multi-AZ — preferred and standby file server' }, { value: 'SINGLE_AZ_2', label: 'Single-AZ 2 — one file server AZ' }] },
    { id: 'subnet', label: 'Preferred file server subnet ID', control: 'text' },
    { id: 'standby', label: 'Standby subnet ID', control: 'text', showWhen: { input: 'deployment', equals: ['MULTI_AZ_1'] }, hint: 'Different AZ, same VPC. Multi-AZ FSx requires a region with at least three AZs, even though two subnets are selected.' },
    { id: 'groups', label: 'Existing FSx security group IDs', control: 'text', hint: 'Comma-separated same-VPC groups with approved client SMB, remote administration and required AD/DNS/Kerberos/RPC connectivity. Rules are not broadened here.' },
    { id: 'ad', label: 'Active Directory integration', control: 'select', default: 'MANAGED', options: [{ value: 'MANAGED', label: 'Existing AWS Managed Microsoft AD in this VPC' }, { value: 'SELF', label: 'Existing self-managed Microsoft AD over private routing' }] },
    { id: 'directory', label: 'AWS Managed Microsoft AD directory ID', control: 'text', showWhen: { input: 'ad', equals: ['MANAGED'] }, hint: 'This path requires a same-VPC MicrosoftAD directory; shared/cross-VPC directory configurations need separate review.' },
    { id: 'domain', label: 'Self-managed AD DNS domain', control: 'text', showWhen: { input: 'ad', equals: ['SELF'] } },
    { id: 'dns', label: 'Self-managed AD DNS server IPv4 addresses', control: 'text', showWhen: { input: 'ad', equals: ['SELF'] }, hint: 'One or two existing reachable domain DNS server addresses, comma-separated.' },
    { id: 'username', label: 'Delegated AD join account username', control: 'text', showWhen: { input: 'ad', equals: ['SELF'] }, hint: 'Supply its fsx_ad_password sensitive Terraform variable securely at deployment. No password is collected/exported.' },
    { id: 'ou', label: 'Computer-account organizational unit DN', control: 'text', showWhen: { input: 'ad', equals: ['SELF'] }, hint: 'Existing delegated OU distinguished name, e.g. OU=FSx,DC=corp,DC=example,DC=org.' },
    { id: 'admin_group', label: 'Delegated FSx administrators AD group', control: 'text', showWhen: { input: 'ad', equals: ['SELF'] }, hint: 'Existing group, without the domain prefix. Verify membership and delegated permissions.' },
    { id: 'storage', label: 'Storage medium', control: 'select', default: 'SSD', options: [{ value: 'SSD', label: 'SSD — lower latency' }, { value: 'HDD', label: 'HDD — capacity-oriented file shares' }] },
    { id: 'capacity', label: 'Storage capacity (GiB)', control: 'number', default: 1024, hint: 'SSD: 32–65,536 GiB. HDD: 2,000–65,536 GiB.' },
    { id: 'throughput', label: 'Throughput capacity (MB/s)', control: 'select', default: '64', options: rates.map(value => ({ value: String(value), label: String(value) })), hint: 'This recipe covers 8–2048 MB/s. Below 32 is for test/development; audit logging requires at least 32.' },
    { id: 'kms', label: 'Storage KMS key ARN', control: 'text', hint: 'Optional regional symmetric customer-managed key; blank uses the default FSx encryption key.' },
    { id: 'retention', label: 'Automatic backup retention (days)', control: 'number', default: 7 },
    { id: 'backup_time', label: 'Daily backup start (UTC HH:MM)', control: 'text', default: '01:00' },
    { id: 'audit', label: 'File/share access auditing', control: 'select', default: 'NONE', options: [{ value: 'NONE', label: 'Configure separately after deployment' }, { value: 'LOGS', label: 'Use existing approved CloudWatch log group' }] },
    { id: 'audit_arn', label: 'Existing audit log group ARN', control: 'text', showWhen: { input: 'audit', equals: ['LOGS'] }, hint: 'Regional log group named /aws/fsx/... with the required FSx log-delivery policy and approved retention.' },
  ],
  build(values): ReturnType<typeof awsServiceModule> {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.fsx-windows.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), partition = awsServicePartition(region), name = String(values.name ?? '').trim(), deployment = String(values.deployment ?? ''), subnet = String(values.subnet ?? '').trim(), standby = deployment === 'MULTI_AZ_1' ? String(values.standby ?? '').trim() : '', ad = String(values.ad ?? ''), directory = ad === 'MANAGED' ? String(values.directory ?? '').trim() : '', storage = String(values.storage ?? ''), kms = String(values.kms ?? '').trim(), audit = String(values.audit ?? ''), auditArn = audit === 'LOGS' ? String(values.audit_arn ?? '').trim() : '', backup = String(values.backup_time ?? '').trim();
    const capacity = Number(values.capacity), throughput = Number(values.throughput), retention = Number(values.retention);
    const list = (id: string) => [...new Set(String(values[id] ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    const groups = list('groups'), subnets = [subnet, ...(deployment === 'MULTI_AZ_1' ? [standby] : [])], dns = ad === 'SELF' ? list('dns') : [], selfValue = (id: string) => ad === 'SELF' ? String(values[id] ?? '').trim() : '';
    const domain = selfValue('domain'), username = selfValue('username'), ou = selfValue('ou'), adminGroup = selfValue('admin_group');
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(name)) reject('name', 'Use 1–100 letters, digits, underscores or hyphens, starting with a letter.');
    if (!['SINGLE_AZ_2', 'MULTI_AZ_1'].includes(deployment)) reject('deployment', 'Select single- or multi-AZ.');
    for (const [path, value] of [['subnet', subnet], ...(deployment === 'MULTI_AZ_1' ? [['standby', standby]] : [])]) if (!/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value ?? '')) reject(path!, 'Enter a valid existing subnet ID.');
    if (deployment === 'MULTI_AZ_1' && subnet === standby) reject('standby', 'Use a different standby subnet in another AZ.');
    if (!groups.length || groups.length > 5 || groups.some(group => !/^sg-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(group))) reject('groups', 'Use 1–5 existing security groups in the file system VPC.');
    if (!['MANAGED', 'SELF'].includes(ad)) reject('ad', 'Select an existing managed or self-managed directory.');
    if (ad === 'MANAGED' && !/^d-[a-f0-9]{10}$/.test(directory)) reject('directory', 'Enter an existing same-VPC AWS Managed Microsoft AD directory ID.');
    if (ad === 'SELF') {
      if (domain.length > 253 || !domain.includes('.') || domain.split('.').some(label => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) reject('domain', 'Enter the AD fully qualified DNS domain.');
      if (!dns.length || dns.length > 2 || dns.some(ip => !isIpv4Address(ip))) reject('dns', 'Use one or two reachable IPv4 AD DNS server addresses.');
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(username)) reject('username', 'Enter the delegated account username without a domain prefix.');
      if (!/^OU=.+,DC=.+/i.test(ou) || ou.length > 2000 || /[\x00-\x1f]/.test(ou)) reject('ou', 'Enter the existing delegated OU distinguished name without control characters.');
      if (!adminGroup || adminGroup.length > 256 || /[\x00-\x1f\\/]/.test(adminGroup)) reject('admin_group', 'Enter an existing delegated administrator group name without domain prefix/control characters.');
    }
    if (!['SSD', 'HDD'].includes(storage)) reject('storage', 'Select SSD or HDD.');
    if (!Number.isInteger(capacity) || capacity < (storage === 'HDD' ? 2000 : 32) || capacity > 65536) reject('capacity', 'Use whole GiB within the selected medium limits.');
    if (!rates.includes(throughput) || (audit === 'LOGS' && throughput < 32)) reject('throughput', 'Choose a supported throughput; audit logging needs at least 32 MB/s.');
    if (!Number.isInteger(retention) || retention < 1 || retention > 90) reject('retention', 'Use 1–90 days of automatic backup retention.');
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(backup)) reject('backup_time', 'Use UTC HH:MM.');
    if (kms && !new RegExp('^arn:' + partition + ':kms:' + region + ':\\d{12}:key/[A-Za-z0-9-]+$').test(kms)) reject('kms', 'Use a regional symmetric KMS key ARN.');
    if (!['NONE', 'LOGS'].includes(audit)) reject('audit', 'Choose separate auditing setup or an existing log destination.');
    if (audit === 'LOGS' && !new RegExp('^arn:' + partition + ':logs:' + region + ':\\d{12}:log-group:/aws/fsx/[A-Za-z0-9_./#-]+$').test(auditArn)) reject('audit_arn', 'Use a regional /aws/fsx/... log group ARN without a trailing :*.');
    const result = awsServiceModule(region, [
      ...(ad === 'SELF' ? [blk('variable', { type: x('string'), sensitive: true, nullable: false, description: 'Delegated AD join account password, supplied securely at deployment; the provider retains it in Terraform state.' }, [blk('validation', { condition: x('length(var.fsx_ad_password) > 0'), error_message: 'Supply the delegated AD join account password securely.' })], ['fsx_ad_password'])] : [dat('aws_directory_service_directory', 'selected', { directory_id: directory })]),
      dat('aws_subnet', 'selected', { for_each: x('toset(' + JSON.stringify(subnets) + ')'), id: x('each.value') }), dat('aws_security_group', 'selected', { for_each: x('toset(' + JSON.stringify(groups) + ')'), id: x('each.value') }),
      ...(deployment === 'MULTI_AZ_1' ? [dat('aws_availability_zones', 'available', { state: 'available' }, [blk('filter', { name: 'zone-type', values: ['availability-zone'] })])] : []),
      res('aws_fsx_windows_file_system', 'configured', { active_directory_id: ad === 'MANAGED' ? directory : undefined, deployment_type: deployment, subnet_ids: subnets, ...(deployment === 'MULTI_AZ_1' ? { preferred_subnet_id: subnet } : {}), security_group_ids: groups, storage_type: storage, storage_capacity: capacity, throughput_capacity: throughput, ...(kms ? { kms_key_id: kms } : {}), automatic_backup_retention_days: retention, daily_automatic_backup_start_time: backup, copy_tags_to_backups: true, skip_final_backup: false, tags: x(hcl({ Name: name })) }, [
        ...(ad === 'SELF' ? [blk('self_managed_active_directory', { domain_name: domain, dns_ips: dns, username, password: x('var.fsx_ad_password'), organizational_unit_distinguished_name: ou, file_system_administrators_group: adminGroup })] : []),
        ...(storage === 'SSD' ? [blk('disk_iops_configuration', { mode: 'AUTOMATIC' })] : []),
        ...(audit === 'LOGS' ? [blk('audit_log_configuration', { audit_log_destination: auditArn, file_access_audit_log_level: 'SUCCESS_AND_FAILURE', file_share_access_audit_log_level: 'SUCCESS_AND_FAILURE' })] : []),
        blk('lifecycle', { prevent_destroy: true }, [blk('precondition', { condition: x('length(distinct([for subnet in data.aws_subnet.selected : subnet.vpc_id])) == 1 && alltrue([for group in data.aws_security_group.selected : contains([for subnet in data.aws_subnet.selected : subnet.vpc_id], group.vpc_id)])' + (deployment === 'MULTI_AZ_1' ? ' && length(distinct([for subnet in data.aws_subnet.selected : subnet.availability_zone])) == 2 && length(data.aws_availability_zones.available.names) >= 3' : '') + (ad === 'MANAGED' ? ' && data.aws_directory_service_directory.selected.type == "MicrosoftAD" && try(data.aws_directory_service_directory.selected.vpc_settings[0].vpc_id, "") == data.aws_subnet.selected[' + JSON.stringify(subnet) + '].vpc_id' : '')), error_message: 'Use same-VPC groups/subnets, distinct preferred/standby AZs in a supported region, and a same-VPC MicrosoftAD directory for the managed-directory path.' })]),
      ]),
      output('file_system_id', 'aws_fsx_windows_file_system.configured.id'), output('dns_name', 'aws_fsx_windows_file_system.configured.dns_name'), output('remote_administration_endpoint', 'aws_fsx_windows_file_system.configured.remote_administration_endpoint'),
      output('default_share_unc', JSON.stringify('\\\\${aws_fsx_windows_file_system.configured.dns_name}\\share')),
    ], `# FSx for Windows File Server

## Prepare
Review storage/throughput sizing, regional availability, quotas, private routes and Windows/AD licensing. SSD and HDD have different minimum capacities; automatic SSD IOPS is used here. This path covers SINGLE_AZ_2 and MULTI_AZ_1 through 2048 MB/s, not every FSx performance tier. Multi-AZ uses two subnets in distinct AZs and requires a region with at least three AZs. Check free addresses. Existing security groups/NACLs must support approved client SMB445, remote administration and the documented AD/DNS/Kerberos/LDAP/RPC/time ports in both required directions; this package does not guess or broaden those rules.

${ad === 'MANAGED' ? 'The managed path requires an existing MicrosoftAD directory in the same VPC. Verify delegated FSx administrator membership and client domain trust/join. Shared or cross-VPC AWS directory arrangements require additional validation outside this recipe.' : 'Run the AWS FSx Active Directory validation tooling against the chosen subnets and existing domain before creation. Verify delegated OU computer-object permissions, DNS, domain controllers, time synchronization, service-account lifecycle and administrator group. Supply fsx_ad_password through approved secret injection at deployment. It is sensitive but retained in provider state/plans: protect encrypted state and access; no credential is exported here.'}

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review AD, storage, network, availability, backup schedule and any existing audit sink; apply the saved reviewed plan and wait for AVAILABLE. Join clients to the appropriate domain/trust and verify DNS/Kerberos. Run SMB-CONFIG.ps1 from an authorized domain-joined Windows administration host to inspect encryption settings; use its explicit -EnforceEncryption switch to require encrypted SMB and reject unsupported clients. This is a separate postdeployment action, not a Terraform-enforced setting. Coordinate legacy client compatibility before enabling it. Existing sessions may need an approved reconnect; the script does not forcibly close them.

Use the UNC output for the default share. Create required shares, NTFS/share ACLs and quotas using delegated FSx administration, with application owners approving group access. Test from the intended user identities before copying data. If auditing is selected, the existing /aws/fsx/ log group must already have the required FSx log-delivery resource policy and approved retention. File access auditing also requires appropriate object SACLs; enabling the FSx log settings alone does not audit every file operation.

## Verify
Inspect aws fsx describe-file-systems --file-system-ids <output-id> --region ${region}. Confirm AVAILABLE, correct AD, encrypted storage, preferred/standby placement and automatic backups. Test SMB3 read/write/rename and access-denied behavior from permitted/domain users, inspect Get-SmbConnection encryption state, and confirm remote SMB server settings. Verify a representative audited file/share operation reaches the selected sink. Test backup restore into an isolated file system and Multi-AZ failover/reconnect with an approved procedure. Data migration must preserve intended ACLs, ownership, timestamps and application consistency; this recipe does not copy source files.

## Recovery
Preserve original shares and acceptance/cutback plans until verified. Backup restore creates a new file system and endpoint; coordinate DNS, mappings and client reconnection. Multi-AZ does not recover deleted/corrupted files. Keep AD join credentials and delegated OU permissions valid for service operations. Destruction requires an explicit reviewed change to prevent_destroy; final backup is retained, but verify its completion and retention. Preserve data/log backups and directory dependencies before removal. Generation/local validation does not join a domain, connect to SMB, enforce SMB settings or move data.

https://docs.aws.amazon.com/fsx/latest/WindowsGuide/one-time-admin-tasks.html
https://docs.aws.amazon.com/fsx/latest/WindowsGuide/encryption-in-transit.html
`, findings);
    return { ...result, files: { ...result.files, 'SMB-CONFIG.ps1': `param([switch]$EnforceEncryption)
$ErrorActionPreference = 'Stop'
$endpoint = terraform output -raw remote_administration_endpoint
if ($LASTEXITCODE -ne 0 -or -not $endpoint) { throw 'Read the applied file system administration endpoint from this package state first.' }
if ($EnforceEncryption) {
  Invoke-Command -ComputerName $endpoint -ConfigurationName FSxRemoteAdmin -ScriptBlock { Set-FSxSmbServerConfiguration -EncryptData $True -RejectUnencryptedAccess $True -Confirm:$False }
}
Invoke-Command -ComputerName $endpoint -ConfigurationName FSxRemoteAdmin -ScriptBlock { Get-FSxSmbServerConfiguration }
` } };
  },
} satisfies Blueprint;
