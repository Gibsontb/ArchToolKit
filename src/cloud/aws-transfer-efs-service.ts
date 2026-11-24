import { error, type Finding } from '../core/findings.ts';
import type { Blueprint } from '../kit/blueprint.ts';
import { blk, dat, e, hcl, jsonencode, output, res, x } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.ts';
import { transferPublicKey } from './aws-transfer-key.ts';
export const AWS_TRANSFER_EFS_SERVICE = {
  id: 'aws_service_transfer_efs', label: 'Set up private SFTP access to EFS',
  description: 'Existing encrypted EFS, private SFTP endpoint, non-root POSIX users, logical home directories, public keys and scoped role policy. Includes explicit home-preparation commands.',
  emits: ['aws_transfer_server', 'aws_transfer_user', 'aws_transfer_ssh_key', 'aws_security_group', 'aws_iam_role_policy'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Server name', control: 'text' },
    { id: 'subnets', label: 'Private SFTP endpoint subnet IDs', control: 'text', hint: 'Two or three distinct-AZ subnets in one VPC; review routes and NACLs.' },
    { id: 'clients', label: 'Approved private SFTP client security groups', control: 'text', hint: 'Same-VPC groups allowed to connect on TCP22 through a new server group.' },
    { id: 'filesystem', label: 'Existing encrypted EFS file system ID', control: 'text', hint: 'Same account and region. Review resource policy, Transfer compatibility, mount targets and owner-approved POSIX directories.' },
    { id: 'prefix', label: 'Existing home directory parent', control: 'text', default: 'transfer', hint: 'Literal relative directory; each user maps to <parent>/<username>. Terraform does not change file contents or ownership.' },
    { id: 'role', label: 'Existing dedicated EFS Transfer access role ARN', control: 'text', hint: 'Same-account role trusted by Transfer. Adds scoped client permissions plus explicit root/write denials; review effects on any other role users.' },
    { id: 'access', label: 'File operations', control: 'select', default: 'READ', options: [{ value: 'READ', label: 'Read only' }, { value: 'WRITE', label: 'Read/write/delete subject to POSIX permissions' }] },
    { id: 'logging_role', label: 'Existing Transfer CloudWatch logging role ARN', control: 'text', hint: 'Same account, approved trust/log-delivery policy and retained/encrypted log destination required.' },
    { id: 'policy', label: 'SSH security policy', control: 'select', default: 'TransferSecurityPolicy-2025-03', options: [{ value: 'TransferSecurityPolicy-2025-03', label: '2025-03 standard' }, { value: 'TransferSecurityPolicy-FIPS-2025-03', label: '2025-03 FIPS (verify client and boundary approval)' }] },
    { id: 'users', label: 'Users, POSIX IDs and public keys', control: 'textarea', hint: 'Username | UID | GID | OpenSSH public key', help: '1–20 unique users and UIDs, UID/GID 1000–2147483647. Repeating the same user/UID/GID adds another distinct key (maximum 50/user). No private keys.' },
  ],
  build(values): ReturnType<typeof awsServiceModule> {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.transfer.efs.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), partition = awsServicePartition(region), name = String(values.name ?? '').trim(), filesystem = String(values.filesystem ?? '').trim(), prefix = String(values.prefix ?? '').trim(), role = String(values.role ?? '').trim(), loggingRole = String(values.logging_role ?? '').trim(), access = String(values.access ?? ''), policy = String(values.policy ?? '');
    const list = (key: string) => [...new Set(String(values[key] ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    const subnets = list('subnets'), clients = list('clients'), rolePattern = new RegExp('^arn:' + partition + ':iam::(\\d{12}):role/([A-Za-z0-9+=,.@_/-]*[A-Za-z0-9+=,.@_-])$'), match = rolePattern.exec(role), account = match?.[1] ?? '', logMatch = rolePattern.exec(loggingRole);
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) reject('name', 'Use a letter followed by up to 63 letters, digits, underscores or hyphens.');
    if (!/^fs-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(filesystem)) reject('filesystem', 'Use the existing regional EFS file system ID.');
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(prefix) || prefix.endsWith('/') || prefix.includes('//') || prefix.split('/').some(value => ['.', '..'].includes(value))) reject('prefix', 'Use a relative literal parent path without wildcard or traversal.');
    if (subnets.length < 2 || subnets.length > 3 || subnets.some(id => !/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(id))) reject('subnets', 'Choose 2–3 distinct-AZ private endpoint subnets.');
    if (!clients.length || clients.length > 5 || clients.some(id => !/^sg-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(id))) reject('clients', 'Use 1–5 approved same-VPC client groups.');
    if (!match) reject('role', 'Use an existing same-account dedicated Transfer EFS role.');
    if (!logMatch || logMatch[1] !== account || role === loggingRole) reject('logging_role', 'Use a distinct existing same-account logging role.');
    if (!['READ', 'WRITE'].includes(access)) reject('access', 'Choose read only or POSIX read/write/delete.');
    if (!['TransferSecurityPolicy-2025-03', 'TransferSecurityPolicy-FIPS-2025-03'].includes(policy)) reject('policy', 'Choose a listed SSH security policy.');
    const users: Record<string, { uid: number; gid: number; keys: string[] }> = Object.create(null);
    const rows = String(values.users ?? '').split(/\r?\n/).map(row => row.trim()).filter(Boolean);
    if (!rows.length || rows.length > 1000) reject('users', 'Use 1–20 users with at most 50 public keys each.');
    for (const [index, row] of rows.entries()) {
      const cells = row.split('|').map(value => value.trim()), [username = '', rawUid = '', rawGid = '', rawKey = ''] = cells, uid = Number(rawUid), gid = Number(rawGid), key = transferPublicKey(rawKey, policy.includes('FIPS'));
      const existing = users[username];
      if (cells.length !== 4 || !/^[A-Za-z0-9_][A-Za-z0-9@_.-]{2,99}$/.test(username) || username.toLowerCase() === 'root' || !/^\d+$/.test(rawUid) || !/^\d+$/.test(rawGid) || !Number.isInteger(uid) || !Number.isInteger(gid) || uid < 1000 || gid < 1000 || uid > 2147483647 || gid > 2147483647 || !key || (existing && (existing.uid !== uid || existing.gid !== gid || existing.keys.includes(key) || existing.keys.length >= 50)) || (!existing && (Object.keys(users).length >= 20 || Object.values(users).some(user => user.uid === uid)))) {
        reject('users', 'Row ' + (index + 1) + ' needs valid non-root unique identity/UID and distinct supported public key; repeated users must retain identical UID/GID.'); continue;
      }
      if (existing) existing.keys.push(key);
      else users[username] = { uid, gid, keys: [key] };
    }
    const fsArn = 'arn:' + partition + ':elasticfilesystem:' + region + ':' + account + ':file-system/' + filesystem;
    const policyDocument = { Version: '2012-10-17', Statement: [
      { Effect: 'Allow', Action: ['elasticfilesystem:ClientMount', ...(access === 'WRITE' ? ['elasticfilesystem:ClientWrite'] : [])], Resource: fsArn },
      { Effect: 'Deny', Action: ['elasticfilesystem:ClientRootAccess', ...(access === 'READ' ? ['elasticfilesystem:ClientWrite'] : [])], Resource: fsArn },
    ] };
    const profiles = Object.fromEntries(Object.entries(users).map(([username, user]) => [username, { uid: user.uid, gid: user.gid, path: '/' + filesystem + '/' + prefix + '/' + username, keys: user.keys.length }]));
    const guide = [
      '# Private SFTP to existing EFS',
      '## Prepare storage and authorization\nUse an existing same-account, same-region encrypted EFS file system with approved resource policy, compatible Transfer access, available mount target(s), capacity/throughput and tested backup/restore. Run PREFLIGHT.ps1 to check exact account/file-system metadata and selected SSH policy. Review effective resource/IAM/key policies separately; this package does not replace a shared file-system policy or KMS policy. Some accounts with publicly accessible EFS policies created before January 6, 2021 require AWS Support enablement for Transfer access. Cross-account EFS, EFS access-point identity enforcement, custom identity/password authentication and public/FTP/FTPS endpoints need separate workflows.',
      'The role receives exact-file-system ClientMount, optional ClientWrite, and an explicit ClientRootAccess deny; read-only also explicitly denies ClientWrite on that file system. These denials affect every session using this dedicated role. EFS resource/IAM permissions and POSIX ownership/mode together determine access. EFS does not support S3 session policies or per-path IAM object ARNs; no S3 policy is attached here. Read/write includes deletion/rename where POSIX allows it; there is no misleading write-without-delete option. Distinct non-root UIDs plus owner-only home permissions are required for user isolation.',
      '## Prepare homes explicitly\nReview USER-PROFILES.json and HOME-PREPARATION.txt with the storage owner. The commands are owner-run examples on an already verified approved EFS administrative mount, not Terraform provisioners. Do not run them against an unverified local directory, wrong file system or symlinked parent/home. Create the approved parent separately with root ownership/traverse-only permissions, verify existing content ownership/permissions, then create only missing homes as UID:GID with mode0700. Do not recursively chown/chmod existing data. No root Transfer user, private SSH key, mount, home creation or data operation is executed by this package.',
      '## Deploy\nPrepare private client connectivity and endpoint subnet routes/NACLs, DNS, free addresses and approved TCP22 clients. The new endpoint group permits only selected same-VPC client groups; no public EIP is assigned. EFS administrative mount networking is a separate storage-owner prerequisite; this recipe does not edit existing mount-target security groups. Existing access/logging role trust remains external. Review user_role_trust_json after apply and have the IAM owner scope the Transfer trust to this server/account. Existing logging role must deliver to owner-approved retained/encrypted CloudWatch logs; file paths/usernames are governed metadata. A selected FIPS SSH policy does not establish an ATO, APL approval or validated-module evidence.',
      'Run terraform init, terraform validate and terraform plan -out=service.tfplan; review the new private EFS-domain Transfer server, network group, exact role policy, logical mappings, POSIX identities and keys, then apply the approved plan. File-system encryption/identity, same-VPC clients and distinct private endpoint AZs are checked at plan. Existing EFS content, policy and ownership are not modified. Confirm server ONLINE, log arrival, exact private endpoint and out-of-band host-key fingerprint before login.',
      '## Test and rotate\nConnect with an approved SFTP client using the local private key and pinned server host key. Test listing/download and the selected write/delete behavior using approved disposable data, and prove denial for another user home, parent traversal, changed UID/GID, unlisted keys and unauthorized clients. Logical root mapping and POSIX restrictions both need testing, including symlink behavior. Never assume a metadata-only preflight proves data access. Repeated identical username/UID/GID rows add distinct public keys, up to50/user. Keys use exact material as stable Terraform for_each keys, so reordering key rows does not revoke a key. Add/test/update clients first; remove the old key only in a separately reviewed apply. Removal affects future authentication and does not promise immediate termination of established sessions. Public keys are stored in state; private keys are never requested.',
      '## Migration and recovery\nThis is an access endpoint, not an automatic estate migration. Inventory paths, bytes, inode/file counts, links, ownership/ACL semantics and application locks; design a separately reviewed bulk/delta copy or DataSync workflow. Verify checksums/counts/owners and application acceptance, freeze/final-delta/cutover, and retain the rollback source until sign-off. EFS backups/retention/recovery remain external and require tested restore. Removing keys/users does not delete EFS homes; server/user prevent_destroy is a Terraform guard, not an AWS deletion lock. No file read/write, login, migration or live deployment occurs during generation/local tests.',
      'https://docs.aws.amazon.com/transfer/latest/userguide/configure-storage.html\nhttps://docs.aws.amazon.com/transfer/latest/userguide/service-managed-users.html\nhttps://docs.aws.amazon.com/efs/latest/ug/using-aws-transfer-integration.html',
    ].join('\n\n') + '\n';
    const first = 'data.aws_subnet.selected[' + JSON.stringify(subnets[0] ?? '') + ']';
    const result = awsServiceModule(region, [
      dat('aws_caller_identity', 'current', {}), dat('aws_efs_file_system', 'selected', { file_system_id: filesystem }),
      dat('aws_iam_role', 'access', { name: match?.[2]?.split('/').at(-1) ?? '' }), dat('aws_iam_role', 'logging', { name: logMatch?.[2]?.split('/').at(-1) ?? '' }),
      dat('aws_subnet', 'selected', { for_each: x('toset(' + JSON.stringify(subnets) + ')'), id: x('each.value') }),
      dat('aws_security_group', 'clients', { for_each: x('toset(' + JSON.stringify(clients) + ')'), id: x('each.value') }),
      res('aws_security_group', 'server', { name: name + '-sftp', description: 'Approved private SFTP clients', vpc_id: x(first + '.vpc_id') }, [blk('ingress', { protocol: 'tcp', from_port: 22, to_port: 22, security_groups: clients })]),
      res('aws_iam_role_policy', 'efs', { name: name + '-efs', role: x('data.aws_iam_role.access.name'), policy: x(jsonencode(policyDocument)) }),
      res('aws_transfer_server', 'configured', { endpoint_type: 'VPC', domain: 'EFS', identity_provider_type: 'SERVICE_MANAGED', protocols: ['SFTP'], security_policy_name: policy, logging_role: loggingRole, force_destroy: false, tags: x(hcl({ Name: name })) }, [
        blk('endpoint_details', { vpc_id: x(first + '.vpc_id'), subnet_ids: subnets, security_group_ids: x('[aws_security_group.server.id]') }),
        blk('lifecycle', { prevent_destroy: true }, [blk('precondition', { condition: x('data.aws_caller_identity.current.account_id == ' + JSON.stringify(account) + ' && data.aws_efs_file_system.selected.arn == ' + JSON.stringify(fsArn) + ' && data.aws_efs_file_system.selected.encrypted && data.aws_iam_role.access.arn == ' + JSON.stringify(role) + ' && data.aws_iam_role.logging.arn == ' + JSON.stringify(loggingRole) + ' && length(distinct([for subnet in data.aws_subnet.selected : subnet.vpc_id])) == 1 && length(distinct([for subnet in data.aws_subnet.selected : subnet.availability_zone])) == ' + subnets.length + ' && alltrue([for subnet in data.aws_subnet.selected : !subnet.map_public_ip_on_launch && subnet.available_ip_address_count >= 4]) && alltrue([for group in data.aws_security_group.clients : group.vpc_id == ' + first + '.vpc_id])'), error_message: 'Use this account roles/encrypted regional EFS, distinct private endpoint AZs with free IPs and same-VPC client groups.' })]),
      ]),
      res('aws_transfer_user', 'users', {
        for_each: x(hcl(profiles)), server_id: x('aws_transfer_server.configured.id'), user_name: x('each.key'), role, home_directory_type: 'LOGICAL', depends_on: x('[aws_iam_role_policy.efs]'),
      }, [blk('posix_profile', { uid: x('each.value.uid'), gid: x('each.value.gid') }), blk('home_directory_mappings', { entry: '/', target: x('each.value.path') }), blk('lifecycle', { prevent_destroy: true })]),
      res('aws_transfer_ssh_key', 'users', {
        for_each: x(hcl(Object.fromEntries(Object.entries(users).flatMap(([username, user]) => user.keys.map(key => [username + '/' + key, { username, key }]))))),
        server_id: x('aws_transfer_server.configured.id'), user_name: x('each.value.username'), body: x('each.value.key'),
        depends_on: x('[aws_transfer_user.users]'),
      }),
      dat('aws_vpc_endpoint', 'server', { id: x('aws_transfer_server.configured.endpoint_details[0].vpc_endpoint_id') }),
      output('server_id', 'aws_transfer_server.configured.id'), output('private_endpoint_dns', 'data.aws_vpc_endpoint.server.dns_entry'), output('host_key_fingerprint', 'aws_transfer_server.configured.host_key_fingerprint'),
      output('user_role_trust_json', jsonencode({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'transfer.amazonaws.com' }, Action: 'sts:AssumeRole', Condition: { StringEquals: { 'aws:SourceAccount': e('data.aws_caller_identity.current.account_id') }, ArnLike: { 'aws:SourceArn': e('format(' + JSON.stringify('arn:' + partition + ':transfer:' + region + ':%s:user/%s/*') + ', data.aws_caller_identity.current.account_id, aws_transfer_server.configured.id)') } } }] })),
    ], guide, findings);
    const preflight = [
      "$ErrorActionPreference = 'Stop'",
      'function Read-AwsJson([string[]]$Arguments) { $raw = aws @Arguments; if ($LASTEXITCODE -ne 0) { throw "Transfer/EFS metadata request failed." }; return ($raw | ConvertFrom-Json) }',
      "$identity = Read-AwsJson @('sts','get-caller-identity','--output','json'); if ($identity.Account -ne '" + account + "') { throw 'Unexpected EFS/Transfer account.' }",
      "$response = Read-AwsJson @('efs','describe-file-systems','--file-system-id','" + filesystem + "','--region','" + region + "','--output','json'); $systems = @($response.FileSystems)",
      "if ($systems.Count -ne 1 -or $systems[0].FileSystemArn -ne '" + fsArn + "' -or $systems[0].LifeCycleState -ne 'available' -or $systems[0].Encrypted -ne $true) { throw 'Require the exact available encrypted regional EFS file system.' }",
      "$targets = Read-AwsJson @('efs','describe-mount-targets','--file-system-id','" + filesystem + "','--region','" + region + "','--output','json')",
      "if (@($targets.MountTargets | Where-Object { $_.LifeCycleState -eq 'available' -and $_.FileSystemId -eq '" + filesystem + "' -and $_.OwnerId -eq '" + account + "' }).Count -lt 1) { throw 'Require an available same-account file-system mount target.' }",
      "$null = Read-AwsJson @('transfer','describe-security-policy','--security-policy-name','" + policy + "','--region','" + region + "','--output','json')",
      'Write-Host "Read-only metadata passed. Verify EFS resource policy, role trust, POSIX homes, logs and private client routing separately. No files or server changed."',
    ].join('\n') + '\n';
    const preparation = [
      '# Owner review only. Do not execute before verifying the administrative EFS mount and every parent/home is not a symlink.',
      '# Example approved administrative mount root: /mnt/verified-efs. Replace only after verifying it is ' + filesystem + '.',
      '# Parent must already exist with approved root ownership and traverse permissions. Commands create missing homes only; never overwrite/chown existing content.',
      ...Object.entries(users).map(([username, user]) => 'test ! -e "/mnt/verified-efs/' + prefix + '/' + username + '" && test ! -L "/mnt/verified-efs/' + prefix + '/' + username + '" && sudo install -d -m 0700 -o ' + user.uid + ' -g ' + user.gid + ' "/mnt/verified-efs/' + prefix + '/' + username + '"'),
    ].join('\n') + '\n';
    return { ...result, files: { ...result.files, 'PREFLIGHT.ps1': preflight, 'HOME-PREPARATION.txt': preparation, 'USER-PROFILES.json': JSON.stringify(profiles, null, 2) + '\n' } };
  },
} satisfies Blueprint;
