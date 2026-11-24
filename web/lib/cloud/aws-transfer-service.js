import { error,              } from '../core/findings.js';
                                                     
import { blk, dat, e, hcl, jsonencode, output, res, x } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.js';
import { transferPublicKey } from './aws-transfer-key.js';
export const AWS_TRANSFER_SERVICE = {
  id: 'aws_service_transfer_sftp', label: 'Set up private SFTP access to S3',
  description: 'Private VPC server, public-key users, logical home folders and exact per-user S3 session policies using an existing access role.',
  emits: ['aws_transfer_server', 'aws_transfer_user', 'aws_transfer_ssh_key'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Server label', control: 'text' },
    { id: 'subnets', label: 'Existing private subnet IDs', control: 'text', hint: '2–3 comma-separated subnets in distinct AZs of one VPC. No public EIPs are assigned.' },
    { id: 'groups', label: 'Existing server security group IDs', control: 'text', hint: 'Same-VPC groups permitting only approved private SFTP clients on TCP 22.' },
    { id: 'bucket', label: 'Existing private S3 bucket', control: 'text', hint: 'Same account and region, with explicit per-bucket public access blocks.' },
    { id: 'prefix', label: 'Base home-folder prefix', control: 'text', default: 'incoming', hint: 'Each user maps to <prefix>/<username>/. Prepare home folders separately; no objects are created or overwritten here.' },
    { id: 'role', label: 'Existing Transfer S3 access role ARN', control: 'text', hint: 'Same-account role trusted by transfer.amazonaws.com. Export includes suggested permissions and a server-scoped trust-policy output.' },
    { id: 'access', label: 'File permissions', control: 'select', default: 'READ', options: [{ value: 'READ', label: 'Read only' }, { value: 'WRITE', label: 'Read/write — no deletes' }, { value: 'DELETE', label: 'Read/write/delete — current objects only' }] },
    { id: 'policy', label: 'SSH security policy', control: 'select', default: 'TransferSecurityPolicy-2025-03', options: [{ value: 'TransferSecurityPolicy-2025-03', label: '2025-03 standard' }, { value: 'TransferSecurityPolicy-FIPS-2025-03', label: '2025-03 FIPS — verify approval/client compatibility' }] },
    { id: 'kms', label: 'Existing S3 encryption KMS key ARN', control: 'text', hint: 'Specify the key if objects use customer-managed KMS encryption; base role/key policy must allow it too.' },
    { id: 'logging_role', label: 'Existing Transfer logging role ARN', control: 'text', hint: 'Optional same-account role with Transfer trust and approved CloudWatch logging permissions/retention.' },
    { id: 'users', label: 'SFTP users and public keys', control: 'textarea', default: 'user-1 | ', hint: 'Username | OpenSSH public key', help: '1–20 unique users, one public key each. Never paste private keys. FIPS excludes Ed25519; RSA requires 2048/3072/4096 bits.' },
    { id: 'additional_keys', label: 'Additional public keys / rotation overlap', control: 'textarea', default: '', hint: 'Existing username | Stable key label | OpenSSH public key', help: 'Optional additional keys for the users above; at most 50 total keys per user. Keep labels stable across exports. Add/test a replacement before removing the old key. Never paste private keys.' },
  ],
  build(values)                                      {
    const findings            = [];
    const reject = (path        , message        ) => findings.push(error('aws.transfer.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), partition = awsServicePartition(region), name = String(values.name ?? '').trim(), bucket = String(values.bucket ?? '').trim(), prefix = String(values.prefix ?? '').trim(), role = String(values.role ?? '').trim(), access = String(values.access ?? ''), policy = String(values.policy ?? ''), kms = String(values.kms ?? '').trim(), loggingRole = String(values.logging_role ?? '').trim();
    const list = (id        ) => [...new Set(String(values[id] ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    const subnets = list('subnets'), groups = list('groups');
    const roleMatch = new RegExp('^arn:' + partition + ':iam::(\\d{12}):role/([A-Za-z0-9+=,.@_/-]*[A-Za-z0-9+=,.@_-])$').exec(role);
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(name)) reject('name', 'Use a letter followed by up to 99 letters, digits, underscores or hyphens.');
    if (subnets.length < 2 || subnets.length > 3 || subnets.some(id => !/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(id))) reject('subnets', 'Use 2–3 private subnets in distinct AZs of one VPC.');
    if (!groups.length || groups.length > 5 || groups.some(id => !/^sg-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(id))) reject('groups', 'Use 1–5 same-VPC security group IDs.');
    if (!/^(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes('..')) reject('bucket', 'Use an existing same-account regional general-purpose S3 bucket.');
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(prefix) || prefix.endsWith('/') || prefix.includes('//') || prefix.split('/').some(part => part === '.' || part === '..')) reject('prefix', 'Use a literal relative prefix within 200 characters, without wildcard/traversal/trailing slash.');
    if (!roleMatch) reject('role', 'Use an existing same-account Transfer S3 access role ARN.');
    if (!['READ', 'WRITE', 'DELETE'].includes(access)) reject('access', 'Select file permissions.');
    if (!['TransferSecurityPolicy-2025-03', 'TransferSecurityPolicy-FIPS-2025-03'].includes(policy)) reject('policy', 'Choose the standard or FIPS 2025-03 policy.');
    if (kms && !new RegExp('^arn:' + partition + ':kms:' + region + ':\\d{12}:key/[A-Za-z0-9-]+$').test(kms)) reject('kms', 'Use the existing regional symmetric S3 encryption key ARN.');
    if (loggingRole && !new RegExp('^arn:' + partition + ':iam::' + (roleMatch?.[1] ?? '\\d{12}') + ':role/[A-Za-z0-9+=,.@_/-]+$').test(loggingRole)) reject('logging_role', 'Use a logging role in the access-role account.');
    const rows = String(values.users ?? '').split(/\r?\n/).map(row => row.trim()).filter(Boolean), users                                  = [];
    if (!rows.length || rows.length > 20) reject('users', 'Use 1–20 distinct users and public keys.');
    for (const [index, row] of rows.entries()) {
      const cells = row.split('|').map(value => value.trim()), [username = '', rawKey = ''] = cells, key = transferPublicKey(rawKey, policy.includes('FIPS'));
      if (cells.length !== 2 || !/^[A-Za-z0-9_][A-Za-z0-9@_.-]{2,99}$/.test(username) || username.toLowerCase() === 'root' || users.some(user => user.name === username) || !key) { reject('users', 'Row ' + (index + 1) + ' requires a unique non-root username (3–100 characters) and structurally valid supported OpenSSH public key.'); continue; }
      users.push({ name: username, key });
    }
    const additional                                                    = {};
    const extraRows = String(values.additional_keys ?? '').split(/\r?\n/).map(row => row.trim()).filter(Boolean);
    if (extraRows.length > 980) reject('additional_keys', 'Use at most 49 additional keys for each of 20 users.');
    for (const [index, row] of extraRows.entries()) {
      const cells = row.split('|').map(value => value.trim()), [username = '', label = '', rawKey = ''] = cells;
      const key = transferPublicKey(rawKey, policy.includes('FIPS')), user = users.find(item => item.name === username), id = username + '/' + label;
      const existing = Object.values(additional).filter(item => item.username === username);
      if (cells.length !== 3 || !user || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(label) || !key || additional[id] || user.key === key || existing.some(item => item.key === key) || existing.length >= 49) {
        reject('additional_keys', 'Row ' + (index + 1) + ' needs an existing username, unique stable label and distinct valid public key (maximum 50 total keys per user).'); continue;
      }
      additional[id] = { username, key };
    }
    const bucketArn = 'arn:' + partition + ':s3:::' + bucket;
    const actions = ['s3:GetObject', 's3:GetObjectVersion', ...(access !== 'READ' ? ['s3:PutObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts'] : []), ...(access === 'DELETE' ? ['s3:DeleteObject'] : [])];
    const permissions = (homes          ) => ({ Version: '2012-10-17', Statement: [
      { Effect: 'Allow', Action: ['s3:GetBucketLocation'], Resource: bucketArn },
      { Effect: 'Allow', Action: ['s3:ListBucket'], Resource: bucketArn, Condition: { StringLike: { 's3:prefix': homes.flatMap(home => [home, home + '/*']) } } },
      { Effect: 'Allow', Action: actions, Resource: homes.map(home => bucketArn + '/' + home + '/*') },
      ...(kms ? [{ Effect: 'Allow', Action: ['kms:Decrypt', 'kms:DescribeKey', ...(access !== 'READ' ? ['kms:Encrypt', 'kms:GenerateDataKey'] : [])], Resource: kms }] : []),
    ] });
    for (const user of users) if (JSON.stringify(permissions([prefix + '/' + user.name])).length > 2048) reject('users', 'Session policy exceeds 2048 characters; shorten the prefix or split the setup.');
    const suggestedPolicy = permissions(users.map(user => prefix + '/' + user.name));
    if (JSON.stringify(suggestedPolicy).length > 6144) reject('users', 'Suggested managed role policy exceeds 6144 characters; shorten prefixes or use smaller groups.');
    const guide = [
      '# Private SFTP to scoped S3 folders',
      '## Prepare\nUse a same-account private regional S3 bucket with explicit public-access blocks and approved encryption/versioning/retention. Prepare home folders at ' + prefix + '/<username>/. This package creates no folder markers and changes no bucket policy or existing objects. Run PREFLIGHT.ps1 first. Each user has a primary public key plus optional additional labeled public keys (maximum 50 total). Private keys stay on clients. Validation checks SSH structure/type/size, while AWS validates actual key material. Other identity providers, EFS, public endpoints and other transfer protocols are separate workflows.',
      'Prepare private routes, NACLs and groups permitting approved SFTP clients on TCP22. No public EIP is assigned. The existing S3 role needs Transfer trust and base permissions. SUGGESTED-ROLE-PERMISSIONS.json gives the exact group scope; user_role_trust_json resolves a concrete server/account trust after apply. Have the IAM owner apply/verify role, bucket and KMS policies. Session policies narrow each user to a literal prefix and intersect base permissions; no unsupported logical-directory substitution variables are used.',
      '## Implement\nRun terraform init, terraform validate and terraform plan -out=service.tfplan. Review account/bucket region, network, policy, users/keys, logical homes and session permissions; apply the reviewed plan. Verify regional SSH policy availability and client compatibility. A FIPS security-policy selection does not establish agency approval, validated-module evidence or data authorization. Configure required logging/retention before production; filenames/usernames may themselves be governed data.',
      'Wait for ONLINE, complete/verify role trust/permissions, and obtain private endpoint DNS and host-key fingerprint outputs. Pin the host key through an approved out-of-band procedure; do not blindly accept a changed key. Connect with an approved SFTP client and its local private key. No password authentication or private key is configured.',
      '## Verify\nTest listing/download and only the chosen upload/delete rights with disposable approved files. Test denial of other user prefixes, parent traversal, unrelated objects and unlisted keys. READ allows no write/delete; WRITE permits overwrite but not delete; DELETE permits current-object deletion, not permanent version deletion. KMS/bucket policies and retention can further restrict access. S3 object semantics differ from POSIX, including rename/atomic operations; verify application behavior and logs.',
      '## Recovery and key rotation\nPreserve source data, prior keys, host-key fingerprints and ownership until cutover acceptance. Add a replacement under a new stable additional-key label, apply the reviewed addition, verify a real login using the new local private key, update approved clients, then remove the old additional-key row and review/apply its revocation separately. Do not remove the working key in the same change that adds an untested replacement. Labeled additional keys use stable username/label Terraform addresses; changing a label replaces its address. Direct replacement of a key at the same label uses create_before_destroy, but does not test the new login and requires quota headroom. At 50 keys, revoke a separately verified obsolete key first. Primary user/key resource addresses retain the original row indices; do not reorder the primary users in an already applied package. Retain the primary key or review an explicit state/configuration migration before retiring it. Stop clients before routing/identity changes and verify partial-upload recovery and object restores. Removing keys revokes future authentication but does not erase S3 homes or promise termination of an already established session. Server/user destruction requires a reviewed prevent_destroy change. Generation/local validation makes no SFTP connection, role change or data transfer.',
      'https://docs.aws.amazon.com/transfer/latest/userguide/requirements-roles.html\nhttps://docs.aws.amazon.com/transfer/latest/userguide/security-policies.html',
    ].join('\n\n') + '\n';
    const result = awsServiceModule(region, [
      dat('aws_caller_identity', 'current', {}), dat('aws_s3_bucket', 'selected', { bucket }), dat('aws_iam_role', 'access', { name: roleMatch?.[2]?.split('/').at(-1) ?? '' }),
      dat('aws_subnet', 'selected', { for_each: x('toset(' + JSON.stringify(subnets) + ')'), id: x('each.value') }), dat('aws_security_group', 'selected', { for_each: x('toset(' + JSON.stringify(groups) + ')'), id: x('each.value') }),
      res('aws_transfer_server', 'configured', { endpoint_type: 'VPC', domain: 'S3', identity_provider_type: 'SERVICE_MANAGED', protocols: ['SFTP'], security_policy_name: policy, ...(loggingRole ? { logging_role: loggingRole } : {}), force_destroy: false, tags: x(hcl({ Name: name })) }, [
        blk('endpoint_details', { vpc_id: x('data.aws_subnet.selected[' + JSON.stringify(subnets[0] ?? '') + '].vpc_id'), subnet_ids: subnets, security_group_ids: groups }),
        blk('lifecycle', { prevent_destroy: true }, [blk('precondition', { condition: x('data.aws_caller_identity.current.account_id == ' + JSON.stringify(roleMatch?.[1] ?? '') + ' && data.aws_iam_role.access.arn == ' + JSON.stringify(role) + ' && data.aws_s3_bucket.selected.region == ' + JSON.stringify(region) + ' && length(distinct([for subnet in data.aws_subnet.selected : subnet.vpc_id])) == 1 && length(distinct([for subnet in data.aws_subnet.selected : subnet.availability_zone])) == ' + subnets.length + ' && alltrue([for group in data.aws_security_group.selected : contains([for subnet in data.aws_subnet.selected : subnet.vpc_id], group.vpc_id)])'), error_message: 'Use this account role, a regional bucket and same-VPC groups/subnets across distinct AZs.' })]),
      ]),
      dat('aws_vpc_endpoint', 'server', { id: x('aws_transfer_server.configured.endpoint_details[0].vpc_endpoint_id') }),
      ...users.flatMap((user, index) => [
        res('aws_transfer_user', 'user_' + index, { server_id: x('aws_transfer_server.configured.id'), user_name: user.name, role, home_directory_type: 'LOGICAL', policy: x(jsonencode(permissions([prefix + '/' + user.name]))), tags: x(hcl({ Name: user.name })) }, [blk('home_directory_mappings', { entry: '/', target: '/' + bucket + '/' + prefix + '/' + user.name }), blk('lifecycle', { prevent_destroy: true })]),
        res('aws_transfer_ssh_key', 'user_' + index, { server_id: x('aws_transfer_server.configured.id'), user_name: x('aws_transfer_user.user_' + index + '.user_name'), body: user.key }),
      ]),
      ...(Object.keys(additional).length ? [res('aws_transfer_ssh_key', 'additional', {
        for_each: x(hcl(additional)), server_id: x('aws_transfer_server.configured.id'), user_name: x('each.value.username'), body: x('each.value.key'),
        depends_on: x('[' + users.map((_, index) => 'aws_transfer_user.user_' + index).join(', ') + ']'),
      }, [blk('lifecycle', { create_before_destroy: true })])] : []),
      output('server_id', 'aws_transfer_server.configured.id'), output('private_endpoint_dns', 'data.aws_vpc_endpoint.server.dns_entry'), output('host_key_fingerprint', 'aws_transfer_server.configured.host_key_fingerprint'),
      output('user_role_trust_json', jsonencode({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'transfer.amazonaws.com' }, Action: 'sts:AssumeRole', Condition: { StringEquals: { 'aws:SourceAccount': e('data.aws_caller_identity.current.account_id') }, ArnLike: { 'aws:SourceArn': e('format(' + JSON.stringify('arn:' + partition + ':transfer:' + region + ':%s:user/%s/*') + ', data.aws_caller_identity.current.account_id, aws_transfer_server.configured.id)') } } }] })),
    ], guide, findings);
    return { ...result, files: { ...result.files, 'SUGGESTED-ROLE-PERMISSIONS.json': JSON.stringify(suggestedPolicy, null, 2) + '\n',
      'PREFLIGHT.ps1': "$ErrorActionPreference = 'Stop'\n$owner = '" + (roleMatch?.[1] ?? '') + "'\naws s3api get-bucket-location --bucket '" + bucket + "' --expected-bucket-owner $owner --region '" + region + "'\nif ($LASTEXITCODE -ne 0) { throw 'Bucket owner/location could not be verified.' }\n$blocksJson = aws s3api get-public-access-block --bucket '" + bucket + "' --expected-bucket-owner $owner --region '" + region + "' --output json\nif ($LASTEXITCODE -ne 0) { throw 'Require explicit per-bucket public access blocks.' }\n$blocks = ($blocksJson | ConvertFrom-Json).PublicAccessBlockConfiguration\nif (-not ($blocks.BlockPublicAcls -and $blocks.IgnorePublicAcls -and $blocks.BlockPublicPolicy -and $blocks.RestrictPublicBuckets)) { throw 'Enable all four per-bucket public access blocks.' }\naws transfer describe-security-policy --security-policy-name '" + policy + "' --region '" + region + "'\nif ($LASTEXITCODE -ne 0) { throw 'The selected policy could not be read in this region.' }\nWrite-Host 'Ownership/access blocks and policy metadata checked; verify role, KMS, home folders and routing separately.'\n",
    } };
  },
}                    ;
