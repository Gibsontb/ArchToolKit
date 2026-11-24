import { bool,                } from '../kit/blueprint.js';
import { error,              } from '../core/findings.js';
import { blk, dat, res, x } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule, awsServicePartition } from './aws-service-module.js';
import { AWS_DATASYNC_NFS_SERVICE } from './aws-datasync-nfs-service.js';
import { awsDataSyncTask } from './aws-datasync-task.js';
import { awsDataSyncOperator } from './aws-datasync-operator.js';

export const AWS_DATASYNC_SMB_SERVICE = {
  id:'aws_service_datasync_smb_s3', label:'Copy an approved NTLM/SMB3 file share to S3',
  description:'Basic-mode Windows file-data transfer to an existing S3 bucket. Password is supplied only at deployment; no NTFS ACL or Kerberos migration.',
  emits:['aws_datasync_location_smb','aws_datasync_location_s3','aws_datasync_task'],
  inputs:[
    ...AWS_DATASYNC_NFS_SERVICE.inputs.filter(input => !['server','path','version'].includes(input.id)),
    { id:'server', label:'Underlying SMB server hostname / IPv4', control:'text', hint:'Use the actual server/share, not a DFS namespace. This workflow pins SMB3 (3.0.2).' },
    { id:'path', label:'Source share and directory', control:'text', hint:'Forward-slash share path, for example /Finance$/Reports. No Windows drive letter or UNC server prefix.' },
    { id:'user', label:'Dedicated SMB reader username', control:'text', hint:'Username only; use the separate domain field. Do not enter a password.' },
    { id:'domain', label:'Windows domain', control:'text', hint:'Domain name or NetBIOS domain. Leave blank only for an approved local server account.' },
    { id:'ntlm_allowed', label:'NTLM is permitted for this source and transfer boundary', control:'toggle', default:false, hint:'Record the applicable source/network policy fact. Where NTLM is prohibited, use a separately qualified Kerberos workflow; this provider5 recipe cannot configure Kerberos.' },
  ],
  build(values)                                      {
    const findings            = [], reject = (path       ,message       ) => findings.push(error('aws.datasync-smb.'+path,message,{path}));
    const region=String(values.aws_region ?? ''), partition=awsServicePartition(region), name=String(values.name ?? '').trim(), agent=String(values.agent ?? '').trim(), server=String(values.server ?? '').trim(), path=String(values.path ?? '').trim(), user=String(values.user ?? '').trim(), domain=String(values.domain ?? '').trim();
    const match=/^arn:([^:]+):datasync:([^:]+):(\d{12}):agent\/agent-[0-9a-f]{17}$/.exec(agent), account=match?.[3] ?? '';
    if (!match || match[1]!==partition || match[2]!==region) reject('agent','Use an activated Basic-mode agent in the selected region/partition.');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{1,119}$/.test(name)) reject('name','Use 2–120 letters, numbers, dots, underscores or hyphens.');
    if (server.length>253 || !server.split('.').every(label=>/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)) || /^\d+(?:\.\d+){3}$/.test(server) && server.split('.').some(value=>Number(value)>255)) reject('server','Use the underlying SMB hostname or valid IPv4 address.');
    if (!/^\/[A-Za-z0-9_$.-]+(?:\/[A-Za-z0-9_$.-]+)*$/.test(path) || path.split('/').some(part=>part==='.' || part==='..') || path.length>4096) reject('path','Use /share or /share/directory without server prefix, traversal or trailing slash. This guided path supports letters, digits, _, $, dot and hyphen.');
    if (!/^[A-Za-z0-9_.@-]{1,104}$/.test(user)) reject('user','Use the source username only, without domain separator/password.');
    if (domain && (domain.length>253 || !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(domain) || domain.includes('..'))) reject('domain','Enter the domain name or leave blank for an approved local account.');
    if (!bool(values,'ntlm_allowed')) reject('ntlm_allowed','Confirm the applicable policy permits NTLM; otherwise use a qualified Kerberos workflow.');
    const bucket=String(values.bucket ?? '').trim(), prefix=String(values.prefix ?? '').trim(), role=String(values.role ?? '').trim(), roleMatch=/^arn:([^:]+):iam::(\d{12}):role\/[A-Za-z0-9+=,.@_/-]+$/.exec(role);
    if (!/^(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes('..')) reject('bucket','Enter the existing destination bucket.');
    if (!prefix.startsWith('/') || !prefix.endsWith('/') || /[\x00-\x1f*?\\]/.test(prefix) || prefix.includes('//') || prefix.split('/').some(part=>part==='.' || part==='..') || new TextEncoder().encode(prefix).length>1024) reject('prefix','Use / or /prefix/ without wildcards, repeated slashes or traversal.');
    if (!roleMatch || roleMatch[1]!==partition || roleMatch[2]!==account) reject('role','Use the destination DataSync access role in the agent/deployment account.');
    const bandwidth=Number(values.bandwidth), bytes=bandwidth===0 ? -1 : Math.round(bandwidth*1e6), overwrite=String(values.overwrite ?? ''), logging=String(values.logging ?? ''), retention=Number(values.retention);
    if (!Number.isFinite(bandwidth) || bandwidth<0 || !Number.isSafeInteger(bytes) || bytes===0) reject('bandwidth','Use zero for unlimited or a positive finite decimal MB/second rate.');
    if (!['NEVER','ALWAYS'].includes(overwrite)) reject('overwrite','Choose destination overwrite behavior.');
    if (!['BASIC','TRANSFER'].includes(logging)) reject('logging','Choose logging detail.');
    if (![7,14,30,60,90,180,365].includes(retention)) reject('retention','Choose log retention.');
    const result=awsServiceModule(region,[
      blk('variable',{type:x('string'),sensitive:true,description:'SMB source password, supplied only through a protected deploy-time secret channel; stored in Terraform state/plans.'},[blk('validation',{condition:x('length(var.smb_source_password) >= 1 && length(var.smb_source_password) <= 104'),error_message:'SMB source password must be 1–104 characters.'})],['smb_source_password']),
      dat('aws_s3_bucket','destination',{bucket}),
      res('aws_datasync_location_smb','source',{server_hostname:server,subdirectory:path,user,...(domain?{domain}:{}),password:x('var.smb_source_password'),agent_arns:[agent]},[blk('mount_options',{version:'SMB3'}),blk('lifecycle',{},[blk('precondition',{condition:x('data.aws_caller_identity.current.account_id == '+JSON.stringify(account)),error_message:'Agent must belong to this deployment account.'})])]),
      res('aws_datasync_location_s3','destination',{s3_bucket_arn:x('data.aws_s3_bucket.destination.arn'),subdirectory:prefix,s3_storage_class:'STANDARD'},[blk('s3_config',{bucket_access_role_arn:role}),blk('lifecycle',{},[blk('precondition',{condition:x('data.aws_s3_bucket.destination.region == '+JSON.stringify(region)),error_message:'Destination bucket must be in the selected region.'})])]),
      ...awsDataSyncTask(region,name,'aws_datasync_location_smb.source.arn','aws_datasync_location_s3.destination.arn',retention,{bytes_per_second:bytes,log_level:logging,overwrite_mode:overwrite,object_tags:'NONE',security_descriptor_copy_flags:'NONE'}),
    ],GUIDE,findings);
    const bucketArn='arn:'+partition+':s3:::'+bucket, objectPrefix=prefix.slice(1);
    return {...result,files:{...result.files,...awsDataSyncOperator({region,partition,name,source:{kind:'smb',server,path,agent,user,domain},destination:{bucket,prefix,role},options:{BytesPerSecond:bytes,LogLevel:logging,OverwriteMode:overwrite,ObjectTags:'NONE',SecurityDescriptorCopyFlags:'NONE'}}),
      'DESTINATION-ACCESS.json':JSON.stringify({Version:'2012-10-17',Statement:[{Effect:'Allow',Action:['s3:GetBucketLocation'],Resource:bucketArn},{Effect:'Allow',Action:['s3:ListBucket','s3:ListBucketMultipartUploads'],Resource:bucketArn,...(objectPrefix?{Condition:{StringLike:{'s3:prefix':[objectPrefix.slice(0,-1),objectPrefix+'*']}}}:{})},{Effect:'Allow',Action:['s3:GetObject','s3:PutObject','s3:AbortMultipartUpload','s3:ListMultipartUploadParts'],Resource:bucketArn+'/'+objectPrefix+'*'}]},null,2)+'\n',
    }};
  },
}                    ;

const GUIDE=`# SMB3 file data to S3 — approved NTLM only

## Source and identity
Use an activated Basic-mode agent with approved source/service routing, DNS and TCP445 to the actual SMB server. Deploy/size the official appliance using current AWS requirements and file/directory counts. DFS namespaces are not supported; select the underlying share. This provider5 path uses NTLM and pins SMB3, which AWS maps to SMB3.0.2. It does not negotiate SMB3.1.1 or configure Kerberos/keytabs/customer secret encryption. NTLM must be permitted by the applicable agency/source/network policy; a checkbox records that fact, not an authorization or exception. Where prohibited, do not use this workflow. Verify server signing/encryption requirements and negotiated behavior in a pilot; protocol selection alone does not prove all traffic encryption or compliance.

Use a dedicated approved source reader with the required share/NTFS/data/metadata rights. Do not add Domain Admin merely to make copying work; source/AD owners determine least privilege and any required backup/restore rights. Inventory alternate streams, links, locks, metadata and unsupported types. Snapshot/quiesce the source for consistency. This is a file-data copy to object storage; S3 does not implement Windows ownership/DACL/SACL authorization. No NTFS security descriptors are copied. Application/share security requires a separately designed target, such as an appropriately configured SMB filesystem, if those semantics are required.

## Secrets and destination
No password input is collected by the browser or written into exported configuration. Terraform requires sensitive variable smb_source_password at deployment, with no default/example secret. Supply through an approved protected secret channel; do not put it in command arguments, source control, logs or tickets. Sensitive redacts ordinary display, but provider5 persists the password in Terraform state/saved plans: encrypt/restrict/retain those artifacts and review backend access. DataSync's own credential storage/key controls require separate owner review. Rotating the source password requires updating the location through the approved deployment process; the helper never reads or verifies the password.

Prepare a private versioned regional destination bucket, the existing DataSync role trust and scoped DESTINATION-ACCESS.json permissions. This policy is an owner-reviewed example, not automatically attached. Bucket/resource/KMS policies, customer-key permissions, Object Lock, retention, ownership and service charges are external prerequisites. Source-account/SourceArn trust restrictions refer to DataSync locations, not task ARNs; use an approved regional bootstrap then tighten to the exact created location ARN. Cross-account bucket access needs its owner's bucket policy.

## Build, pilot and cutover
Run terraform init/validate, then a secret-protected terraform plan -out=service.tfplan; review direction, prefixes, IAM, overwrite, SMB identity and password/state handling. Apply the reviewed plan. No transfer starts or is scheduled automatically. Follow OPERATOR.md: inspect with python OPERATE.py, then explicitly --start --confirm-transfer after source/data-owner approval (ALWAYS additionally needs --confirm-overwrite). Inspect verifies metadata/ONLINE agent/versioning, not source credentials, effective permissions, data consistency or transport guarantees. It issues one start request without SDK retry; investigate history after ambiguous errors before repeating.

Save the execution ARN, monitor --execution, review service errors/counts/checksums and independently reconcile representative data/metadata and application reads. NEVER skips changed destination objects as well; a final delta needs reviewed ALWAYS, source write freeze, versioning/recovery and owner acceptance. Source deletions remain preserved at the destination. Keep the source until cutover/restore/retention sign-off. Cancellation leaves completed writes; recover overwritten objects from approved versions/backups. Terraform removal deletes configuration, not source or bucket data. VM/database conversion, Windows ACL migration, Kerberos, Enhanced mode and reverse cutback are separate workflows.

https://docs.aws.amazon.com/datasync/latest/userguide/create-smb-location.html
https://docs.aws.amazon.com/datasync/latest/userguide/cross-service-confused-deputy-prevention.html
`;
