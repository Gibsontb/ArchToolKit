import { error,              } from '../core/findings.js';
                                                     
import { blk, dat, res, x } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.js';
import { awsDataSyncTask } from './aws-datasync-task.js';
import { awsDataSyncOperator } from './aws-datasync-operator.js';
import { AWS_DATASYNC_SERVICE } from './aws-datasync-service.js';
export const AWS_DATASYNC_NFS_SERVICE = {
  id: 'aws_service_datasync_nfs_s3', label: 'Set up an on-premises NFS-to-S3 transfer',
  description: 'Configure an activated Basic-mode agent, NFS source, existing S3 destination, transfer options and an agent/versioning preflight.',
  emits: ['aws_datasync_location_nfs', 'aws_datasync_location_s3', 'aws_datasync_task'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Transfer task name', control: 'text' },
    { id: 'agent', label: 'Existing activated Basic-mode agent ARN', control: 'text', hint: 'Agent must be ONLINE in the deployment account and selected region. Appliance deployment/activation is a prerequisite.' },
    { id: 'server', label: 'NFS server DNS name / IPv4 address', control: 'text', hint: 'Must be reachable and mountable from the agent, not just from this browser.' },
    { id: 'path', label: 'Source NFS export path', control: 'text', hint: 'Absolute exported source directory, for example /exports/application. This is read as the transfer source.' },
    { id: 'version', label: 'NFS protocol', control: 'select', default: 'NFS4_1', options: ['AUTOMATIC', 'NFS3', 'NFS4_0', 'NFS4_1'].map(value => ({ value, label: value })) },
    { id: 'bucket', label: 'Existing destination S3 bucket', control: 'text' },
    { id: 'prefix', label: 'Destination prefix', control: 'text', default: '/landing/', hint: 'Use / or /prefix/. A dedicated versioned destination is recommended for recovery.' },
    { id: 'role', label: 'Existing destination bucket access role ARN', control: 'text', hint: 'Must trust DataSync and allow the generated destination access-policy example; KMS/bucket policies are separate prerequisites.' },
    ...AWS_DATASYNC_SERVICE.inputs.filter(input => ['overwrite', 'bandwidth', 'logging', 'retention'].includes(input.id)),
  ],
  build(values)                                      {
    const findings            = [];
    const reject = (path        , message        ) => findings.push(error('aws.datasync-nfs.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), partition = awsServicePartition(region), name = String(values.name ?? '').trim(), agent = String(values.agent ?? '').trim(), server = String(values.server ?? '').trim(), path = String(values.path ?? '').trim(), version = String(values.version ?? '');
    const parsedAgent = /^arn:([^:]+):datasync:([^:]+):(\d{12}):agent\/agent-[a-z0-9]{17}$/.exec(agent);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{1,119}$/.test(name)) reject('name', 'Use 2–120 letters, numbers, dots, underscores or hyphens.');
    if (!parsedAgent || parsedAgent[1] !== partition || parsedAgent[2] !== region) reject('agent', 'Use an activated Basic-mode agent ARN in the selected region and partition.');
    if (server.length > 253 || !server.split('.').every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)) || /^\d+(?:\.\d+){3}$/.test(server) && server.split('.').some(value => Number(value) > 255)) reject('server', 'Enter the NFS server hostname or a valid IPv4 address.');
    if (!path.startsWith('/') || path.split('/').some(part => part === '.' || part === '..') || /[\x00-\x1f\\]/.test(path) || new TextEncoder().encode(path).length > 4096) reject('path', 'Use an absolute exported NFS path, without dot traversal/control characters and within 4096 UTF-8 bytes.');
    if (!['AUTOMATIC', 'NFS3', 'NFS4_0', 'NFS4_1'].includes(version)) reject('version', 'Choose an NFS protocol supported by the server.');
    const bucket = String(values.bucket ?? '').trim(), prefix = String(values.prefix ?? '').trim(), role = String(values.role ?? '').trim(), parsedRole = /^arn:([^:]+):iam::(\d{12}):role\/[A-Za-z0-9+=,.@_/-]+$/.exec(role);
    if (!/^(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes('..')) reject('bucket', 'Enter the existing regional destination bucket name.');
    if (!prefix.startsWith('/') || !prefix.endsWith('/') || /[\x00-\x1f*?\\]/.test(prefix) || prefix.includes('//') || prefix.split('/').some(part => part === '.' || part === '..') || new TextEncoder().encode(prefix).length > 1024) reject('prefix', 'Use / or /prefix/ without wildcards, traversal, repeated slashes or control characters.');
    if (!parsedRole || parsedRole[1] !== partition) reject('role', 'Use the existing DataSync bucket access role ARN in the selected partition.');
    const bandwidth = Number(values.bandwidth), bytes = bandwidth === 0 ? -1 : Math.round(bandwidth * 1e6), overwrite = String(values.overwrite ?? ''), logging = String(values.logging ?? ''), retention = Number(values.retention);
    if (!Number.isFinite(bandwidth) || bandwidth < 0 || !Number.isSafeInteger(bytes) || bytes === 0) reject('bandwidth', 'Use zero for unlimited or a positive finite decimal MB/second limit.');
    if (!['NEVER', 'ALWAYS'].includes(overwrite)) reject('overwrite', 'Choose destination overwrite behavior.');
    if (!['BASIC', 'TRANSFER'].includes(logging)) reject('logging', 'Choose log detail.');
    if (![7, 14, 30, 60, 90, 180, 365].includes(retention)) reject('retention', 'Choose log retention.');
    const result = awsServiceModule(region, [
      dat('aws_s3_bucket', 'destination', { bucket }),
      res('aws_datasync_location_nfs', 'source', { server_hostname: server, subdirectory: path }, [blk('on_prem_config', { agent_arns: [agent] }), blk('mount_options', { version }), blk('lifecycle', {}, [blk('precondition', { condition: x('data.aws_caller_identity.current.account_id == ' + JSON.stringify(parsedAgent?.[3] ?? '')), error_message: 'The agent must belong to the deployment account.' })])]),
      res('aws_datasync_location_s3', 'destination', { s3_bucket_arn: x('data.aws_s3_bucket.destination.arn'), subdirectory: prefix, s3_storage_class: 'STANDARD' }, [blk('s3_config', { bucket_access_role_arn: role }), blk('lifecycle', {}, [blk('precondition', { condition: x('data.aws_s3_bucket.destination.region == ' + JSON.stringify(region) + ' && data.aws_caller_identity.current.account_id == ' + JSON.stringify(parsedRole?.[2] ?? '')), error_message: 'The destination bucket must be regional and its access role must belong to the deployment account.' })])]),
      ...awsDataSyncTask(region, name, 'aws_datasync_location_nfs.source.arn', 'aws_datasync_location_s3.destination.arn', retention, { bytes_per_second: bytes, overwrite_mode: overwrite, log_level: logging, object_tags: 'NONE' }),
    ], `# On-premises NFS-to-S3 DataSync transfer

## Prepare the agent and source
Use the official Basic-mode appliance for the selected AWS partition on a currently supported hypervisor. AWS documents four virtual processors, 80 GB system disk and 32 GB RAM for up to 20 million files/objects/directories; use 64 GB RAM above that guideline and assess metadata/directory overhead. Verify current requirements before sizing. Deploy/activate the appliance through the supported AWS procedure and record its regional agent ARN. This package requires the activated agent; it does not export or install a VM appliance. Run PREFLIGHT.ps1 to check ONLINE status and destination versioning.

Verify agent-to-NFS routing, DNS, NFS-version-specific ports, export permissions and source read/metadata access. Verify agent-to-AWS service/data endpoints, proxy/private endpoint policy and bandwidth using AWS's current network requirements. Select the correct export path and approved data transfer boundary. Snapshot/quiesce mutable application data as needed for consistency. File copying does not convert VMs, databases or applications into a cloud-ready format.

## Prepare the destination
Use a dedicated private versioned regional bucket. Have the role owner review/attach DESTINATION-ACCESS.json as appropriate and verify its DataSync trust, bucket policy and any customer-managed KMS permissions. No IAM/key/bucket policy is attached automatically here. Review Object Lock/retention, DataSync/S3/log costs and service quotas. Source POSIX metadata and S3 object semantics differ; verify which attributes the application needs and test a restore to the intended filesystem.

## Implement and transfer
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review NFS source, agent, destination prefix and overwrite behavior; apply the saved reviewed plan. Task creation does not start a transfer. Follow OPERATOR.md: python OPERATE.py inspects metadata; --start --confirm-transfer starts the approved pilot (overwrite mode additionally requires --confirm-overwrite). Record the execution ARN and use python OPERATE.py --execution <execution-arn>. Review preparation/transfer/verification counts and errors, then validate destination objects and application readability.

## Cutover and verify
Run an initial copy, reconcile content and required metadata, then plan a write freeze/final delta for changing datasets. Preserve-existing mode skips already-present destination objects even if source files changed; use reviewed overwrite mode for a final delta with destination versioning/recovery in place. Source deletions remain preserved at the destination. Verification covers files transferred, not a complete reconciliation of every preexisting destination object. Confirm counts, sizes, checksums, permissions expectations and representative application reads before changing consumers. Do not decommission the source until its owner signs off and the restore/retention requirements are met.

## Recovery
Cancel a transfer with aws datasync cancel-task-execution --task-execution-arn <execution-arn> --region ${region}; completed writes remain. Recover overwritten objects from versions/backups, reconcile partial data and keep the original export available. Preserve transfer logs. Terraform removal deletes task/location configuration, not source files or S3 bucket data. SMB/Windows ACLs, EFS/FSx targets, database consistency, enhanced agents and reverse cutback require separate workflows.

https://docs.aws.amazon.com/datasync/latest/userguide/agent-requirements.html
https://docs.aws.amazon.com/datasync/latest/userguide/deploy-agents.html
`, findings);
    const arn = 'arn:' + partition + ':s3:::' + bucket, objectPrefix = prefix.slice(1);
    return { ...result, files: { ...result.files,
      ...awsDataSyncOperator({ region, partition, name, source: { kind: 'nfs', server, path, agent, version }, destination: { bucket, prefix, role }, options: { BytesPerSecond: bytes, LogLevel: logging, OverwriteMode: overwrite, ObjectTags: 'NONE' } }),
      'DESTINATION-ACCESS.json': JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['s3:GetBucketLocation'], Resource: arn }, { Effect: 'Allow', Action: ['s3:ListBucket', 's3:ListBucketMultipartUploads'], Resource: arn, ...(objectPrefix ? { Condition: { StringLike: { 's3:prefix': [objectPrefix.slice(0, -1), objectPrefix + '*'] } } } : {}) }, { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts'], Resource: arn + '/' + objectPrefix + '*' }] }, null, 2) + '\n',
      'PREFLIGHT.ps1': `$ErrorActionPreference = 'Stop'
$agentJson = aws datasync describe-agent --agent-arn '${agent}' --region '${region}' --output json
if ($LASTEXITCODE -ne 0) { throw 'Could not read the selected DataSync agent.' }
if (($agentJson | ConvertFrom-Json).Status -ne 'ONLINE') { throw 'Activate and bring the Basic-mode agent online before proceeding.' }
$versioningJson = aws s3api get-bucket-versioning --bucket '${bucket}' --region '${region}' --output json
if ($LASTEXITCODE -ne 0) { throw 'Could not read destination versioning.' }
if (($versioningJson | ConvertFrom-Json).Status -ne 'Enabled') { throw 'Enable destination versioning for the transfer recovery plan.' }
Write-Host 'Agent status and destination versioning checked. Confirm Basic-mode appliance, source mounting, permissions, networking, consistency and transfer approval separately.'
`,
    } };
  },
}                    ;
