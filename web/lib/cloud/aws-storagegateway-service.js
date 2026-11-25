                                                   
import {error,            } from '../core/findings.js';
import {parseCidrAny,overlapsAny} from '../core/ip.js';
import {blk,dat,hcl,jsonencode,output,res,x} from '../terraform/blueprints/migration/common.js';
import {awsServiceModule,awsServiceRegion} from './aws-service-module.js';
import {storageGatewayInspection} from './aws-storagegateway-files.js';
export const AWS_STORAGEGATEWAY_SERVICE={
  id:'aws_service_storagegateway_nfs',label:'Add a restricted S3-backed NFS share to an existing S3 File Gateway',
  description:'New prefix-scoped gateway role and protected NFS share, existing bucket/customer key/audit group. Explicit read-only or writable mode; appliance activation, cache and protected client networking are prerequisites.',
  emits:['aws_iam_role','aws_iam_role_policy','aws_storagegateway_nfs_file_share'],
  inputs:[awsServiceRegion,{id:'name',label:'New share name',control:'text'},
    {id:'account',label:'Expected owner account ID',control:'text'},
    {id:'gateway',label:'Existing S3 File Gateway ARN',control:'text'},
    {id:'bucket',label:'Existing destination bucket',control:'text',hint:'Same account/region, no periods; dedicated nonoverlapping prefix and approved versioning/retention required.'},
    {id:'prefix',label:'Dedicated bucket prefix',control:'text',default:'file-share/',hint:'Must end with /. No other share or writer may use this prefix.'},
    {id:'kms',label:'Existing bucket customer KMS key ARN',control:'text'},
    {id:'audit',label:'Existing encrypted audit log group name',control:'text',hint:'Owner must preapprove log resource policy, key policy and retention; this module does not overwrite them.'},
    {id:'clients',label:'Approved private IPv4 client CIDRs',control:'text',hint:'1–20 canonical RFC1918 prefixes, /16 or narrower; /32 for a single host. IP/UID identity is not strong authentication.'},
    {id:'mode',label:'NFS access',control:'select',default:'READ_ONLY',options:[{value:'READ_ONLY',label:'Read-only validation share'},{value:'READ_WRITE',label:'Read/write under approved change control'}]},
    {id:'storage',label:'New object storage class',control:'select',default:'S3_STANDARD',options:[{value:'S3_STANDARD',label:'S3 Standard'},{value:'S3_INTELLIGENT_TIERING',label:'S3 Intelligent-Tiering'}]},
    {id:'squash',label:'NFS identity mapping',control:'select',default:'RootSquash',options:[{value:'RootSquash',label:'Root squash'},{value:'AllSquash',label:'All users to anonymous'}]},
    {id:'permissions',label:'Default file/directory permissions',control:'select',default:'GROUP',options:[{value:'GROUP',label:'0640 files / 0750 directories'},{value:'OWNER',label:'0600 files / 0700 directories'}]},
    {id:'uid',label:'Default owner UID',control:'number',default:65534,min:1,max:4294967294},
    {id:'gid',label:'Default group GID',control:'number',default:65534,min:1,max:4294967294},
    {id:'ttl',label:'Directory cache refresh interval',control:'select',default:'3600',options:[{value:'1800',label:'30 minutes'},{value:'3600',label:'1 hour'},{value:'86400',label:'1 day'}]},
  ],
  build(values)                                    {
    const findings          =[],reject=(path       ,message       )=>findings.push(error('aws.storagegateway.'+path,message,{path}));
    const region=String(values.aws_region??''),name=String(values.name??'').trim(),account=String(values.account??'').trim(),gateway=String(values.gateway??'').trim(),bucket=String(values.bucket??'').trim(),prefix=String(values.prefix??'').trim(),kms=String(values.kms??'').trim(),audit=String(values.audit??'').trim(),mode=String(values.mode??''),storage=String(values.storage??''),squash=String(values.squash??''),permissions=String(values.permissions??''),uid=Number(values.uid),gid=Number(values.gid),ttl=Number(values.ttl);
    const clients=String(values.clients??'').split(',').map(value=>value.trim()).filter(Boolean);
    if(!['us-east-1','us-east-2','us-west-1','us-west-2'].includes(region))reject('aws_region','Initial workflow covers four US commercial regions; other partitions require separate qualification.');
    if(!/^[a-z][a-z0-9-]{1,38}[a-z0-9]$/.test(name))reject('name','Use3–40 lowercase letters/digits/internal hyphens.');
    if(!/^\d{12}$/.test(account))reject('account','Use the12-digit gateway/bucket/key/log owner account.');
    const gatewayParts=/^arn:aws:storagegateway:([a-z0-9-]+):(\d{12}):gateway\/sgw-[0-9A-Fa-f]{8,17}$/.exec(gateway);
    if(!gatewayParts||gatewayParts[1]!==region||gatewayParts[2]!==account)reject('gateway','Use the selected region/account existing S3 File Gateway ARN.');
    if(!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)||bucket.startsWith('xn--')||/-s3alias$|--ol-s3$|--x-s3$|--table-s3$/.test(bucket))reject('bucket','Use an existing general-purpose bucket name without periods or reserved aliases.');
    if(!/^[A-Za-z0-9][A-Za-z0-9_/-]{0,198}\/$/.test(prefix)||prefix.includes('//'))reject('prefix','Use a dedicated1–200character alphanumeric/underscore/hyphen prefix ending in /, no empty path components.');
    const keyParts=/^arn:aws:kms:([a-z0-9-]+):(\d{12}):key\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.exec(kms);
    if(!keyParts||keyParts[1]!==region||keyParts[2]!==account)reject('kms','Use a same-account/region customer symmetric key ARN, not an alias.');
    if(!/^[A-Za-z0-9/_.-]{1,256}$/.test(audit))reject('audit','Use the existing encrypted CloudWatch log group name.');
    if(!clients.length||clients.length>20||new Set(clients).size!==clients.length||clients.some(value=>{const c=parseCidrAny(value);return !c||c.family!==4||c.prefix<16||value!==c.network+'/'+c.prefix||!['10.0.0.0/8','172.16.0.0/12','192.168.0.0/16'].some(privateRange=>overlapsAny(value,privateRange));}))reject('clients','Use1–20 unique canonical RFC1918 IPv4 client networks, /16–/32 only.');
    for(const [path,value,allowed]of [['mode',mode,['READ_ONLY','READ_WRITE']],['storage',storage,['S3_STANDARD','S3_INTELLIGENT_TIERING']],['squash',squash,['RootSquash','AllSquash']],['permissions',permissions,['GROUP','OWNER']]]         )if(!(allowed                     ).includes(value))reject(path,'Choose one of the supported dropdown values.');
    for(const [path,value]of [['uid',uid],['gid',gid]]         )if(!Number.isInteger(value)||value<1||value>4294967294)reject(path,'Use a non-root numeric identity1–4294967294.');
    if(![1800,3600,86400].includes(ttl))reject('ttl','Choose the supported refresh interval.');
    const bucketArn='arn:aws:s3:::'+bucket,location=bucketArn+'/'+prefix,readonly=mode==='READ_ONLY';
    const trust={Version:'2012-10-17',Statement:[{Effect:'Allow',Principal:{Service:'storagegateway.amazonaws.com'},Action:'sts:AssumeRole',Condition:{StringEquals:{'aws:SourceAccount':account},ArnEquals:{'aws:SourceArn':gateway}}}]};
    const policy={Version:'2012-10-17',Statement:[
      {Effect:'Allow',Action:['s3:GetAccelerateConfiguration','s3:GetBucketLocation','s3:GetBucketVersioning'],Resource:bucketArn},
      {Effect:'Allow',Action:['s3:ListBucket','s3:ListBucketVersions','s3:ListBucketMultipartUploads'],Resource:bucketArn,Condition:{StringLike:{'s3:prefix':[prefix,prefix+'*']}}},
      {Effect:'Allow',Action:['s3:GetObject','s3:GetObjectAcl','s3:GetObjectVersion','s3:ListMultipartUploadParts',...(!readonly?['s3:AbortMultipartUpload','s3:DeleteObject','s3:DeleteObjectVersion','s3:PutObject','s3:PutObjectAcl']:[])],Resource:location+'*'},
      {Effect:'Allow',Action:['kms:DescribeKey'],Resource:kms},
      {Effect:'Allow',Action:['kms:Decrypt',...(!readonly?['kms:Encrypt','kms:ReEncrypt*','kms:GenerateDataKey']:[])],Resource:kms,Condition:{StringEquals:{'kms:ViaService':'s3.'+region+'.amazonaws.com'}}},
    ]};
    const fileMode=permissions==='OWNER'?'0600':'0640',directoryMode=permissions==='OWNER'?'0700':'0750';
    const config={region,name,account,gateway,bucket,prefix,kms,audit,clients,mode,storage,squash,uid,gid,ttl,fileMode,directoryMode,role:name+'-file-access'};
    const result=awsServiceModule(region,[dat('aws_caller_identity','current',{}),dat('aws_s3_bucket','selected',{bucket}),dat('aws_kms_key','selected',{key_id:kms}),dat('aws_cloudwatch_log_group','audit',{name:audit}),
      res('aws_iam_role','configured',{name:config.role,assume_role_policy:x(jsonencode(trust))},[blk('lifecycle',{prevent_destroy:true})]),
      res('aws_iam_role_policy','configured',{name:'prefix-access',role:x('aws_iam_role.configured.id'),policy:x(jsonencode(policy))}),
      res('aws_storagegateway_nfs_file_share','configured',{gateway_arn:gateway,location_arn:location,role_arn:x('aws_iam_role.configured.arn'),file_share_name:name,client_list:clients,kms_encrypted:true,kms_key_arn:kms,audit_destination_arn:x('data.aws_cloudwatch_log_group.audit.arn'),default_storage_class:storage,read_only:readonly,squash,object_acl:'bucket-owner-full-control',requester_pays:false,guess_mime_type_enabled:false,notification_policy:'{}',tags:x(hcl({Name:name})),depends_on:x('[aws_iam_role_policy.configured]')},[
        blk('nfs_file_share_defaults',{file_mode:fileMode,directory_mode:directoryMode,owner_id:String(uid),group_id:String(gid)}),blk('cache_attributes',{cache_stale_timeout_in_seconds:ttl}),
        blk('lifecycle',{prevent_destroy:true},[blk('precondition',{condition:x(`data.aws_caller_identity.current.account_id == ${JSON.stringify(account)} && data.aws_s3_bucket.selected.region == ${JSON.stringify(region)} && data.aws_kms_key.selected.arn == ${JSON.stringify(kms)} && data.aws_kms_key.selected.aws_account_id == ${JSON.stringify(account)} && data.aws_kms_key.selected.key_state == "Enabled" && data.aws_kms_key.selected.key_manager == "CUSTOMER" && data.aws_kms_key.selected.key_usage == "ENCRYPT_DECRYPT" && data.aws_kms_key.selected.key_spec == "SYMMETRIC_DEFAULT" && data.aws_cloudwatch_log_group.audit.kms_key_id != "" && data.aws_cloudwatch_log_group.audit.retention_in_days >= 30`),error_message:'Require owner account, same-region bucket, enabled customer symmetric key and encrypted audit group retained at least30days. INSPECT.py must independently verify actual bucket/gateway/log/key ownership and policies.'})]),
      ]),output('file_share_arn','aws_storagegateway_nfs_file_share.configured.arn'),output('file_share_path','aws_storagegateway_nfs_file_share.configured.path'),output('file_access_role_arn','aws_iam_role.configured.arn')],GUIDE,findings);
    return {...result,files:{...result.files,'INSPECT.py':storageGatewayInspection,'FILESHARE-CONFIG.json':JSON.stringify(config,null,2)+'\n'}};
  },
}                    ;

const GUIDE=`# S3 File Gateway NFS share

New restricted NFS share and exact-gateway/account-trusted IAM role only. An existing activated healthy FILE_S3 gateway, provisioned local cache, approved protected NFS client network, same-account/region existing bucket/customer symmetric KMS key and encrypted audit group are prerequisites. Initial scope four US commercial regions; no new appliance/activation/cache installation, SMB/AD, volume/tape/FSx gateways, cross-account/bucket/access-point/DSSE/private-S3endpoint provisioning. No claim every Storage Gateway variant is implemented. Activation secrets never enter the GUI/export.

Select a unique name and dedicated prefix ending /. Review all existing NFS and SMB shares across the account/region and external writers: no overlapping prefix, root-bucket share or direct concurrent S3 mutation. One namespace needs one authoritative writer. Prefix is immutable; replacing a share is not moving its data. S3FileGateway lacks full POSIX semantics including hard/symbolic links; validate application locking, ownership, permissions, sparse/small-file behavior and recovery before choosing it as a migration destination.

Read-only is the default and omits S3 mutation/key-encrypt grants in the new role. AWS documentation shows full S3 access for general read/write gateways; this bounded read-only policy must be qualified with actual approved reads before production, not assumed feature-complete. Writable mode adds prefix-scoped object write/delete/version-delete/ACL/multipart and exact-key encryption permissions, so owner approval and retention/version-recovery testing are required. Read-only does not mean the toolkit runs object reads: generation and metadata checks do not read file/object bodies. Root/all squash are IP/UID mapping controls, not authenticated users. No NoSquash/world-writable defaults. Permission defaults affect discovery/default mappings and do not rewrite existing file metadata.

NFS client-to-gateway traffic is not encrypted or strongly authenticated merely because S3 uses SSE-KMS or gateway control uses a FIPS endpoint. Establish an approved isolated/encrypted transport boundary and real deny tests for source IP spoofing, UID/GID identity, root mapping and traversal. Verify firewall/NFS ports, local cache disk encryption, physical/hypervisor security and supported software/CMVP/STIG/agency requirements separately. Commercial geography/FIPS metadata is not an ATO; civilian/DoD/State data/classification/residency/APL/CDM/SSP/privacy/records/transfer/support boundaries must permit the complete path including cache, logs and keys. When private S3 endpoints or DSSE are mandatory, this initial package is not a substitute for that design.

Before Terraform, run python INSPECT.py with approved boto3/botocore and metadata-only credentials. It checks account/gateway region-bound ARN/FILE_S3/STATE_RUNNING/FIPS metadata, configured cache and private IPv4 NICs; actual disk health/capacity remain owner-validated. It checks bucket owner using ExpectedBucketOwner, region/versioning/public-access blocks/ownership controls/default SSE-KMS exact key and encrypted retained audit group. All account-region NFS/SMB share metadata is paginated to reject overlapping prefixes; unknown/access-point/alias locations fail for independent review rather than guessing their backing bucket. External/cross-account writers and lifecycle/ObjectLock/replication conflicts need independent review. Object ACL is bucket-owner-full-control. Check current existing object encryption and ownership separately without assuming default encryption retroactively changes old objects. Verify key trust/grants and log-group owner/key/retention/resource delivery policy for this gateway; bucket/key/log policies are NOT overwritten.30days is only this package's minimum audit retention guard, not a universal agency requirement. Terraform checks only the stated metadata predicates; actual effective SCP/boundary/session/resource/endpoint policies and log delivery need independent review.

Use approved metadata credentials and protected Terraform backend. Run init/validate/plan, review the new role/trust/exact-prefix policy and new share, then apply only under owner change authority. Creating a share exposes it to listed reachable clients even in read-only mode; do not assume it is stopped. Run python INSPECT.py --share <exact-file_share_arn-output>. It requires AVAILABLE and exact gateway/location/role/key/audit/client list/read-only or writable mode/squash/UID/GID/modes/cache TTL and no extra encryption/endpoint/notification settings. It rechecks other share overlap and gateway/bucket/key/log metadata; it does not prove the role's effective permissions, actual audit delivery, cache drain or network/application behavior. Mount/read/write/recovery tests are separate authorized client operations; no mount/client commands or data copy run automatically.

Test an isolated approved namespace with actual read/list, denied client/root/UID cases, encrypted transport, metadata integrity and audit delivery. Before writable production, test duplicate writers, interrupted uploads, cache persistence/drain, version recovery/delete semantics and restore. TTL refresh is lazy directory access after expiry, not a guaranteed synchronization schedule. New storage class applies to new objects, does not rewrite existing objects. S3 versioning/replication/rsync/repeated small writes/KMS/requests/IntelligentTiering can materially change TCO. Record real bytes/requests/transfer/cache/appliance/support costs and application signoff before migration.

Recovery: quiesce clients using owner procedures, verify actual upload drain and recoverable S3 versions/snapshots independently, withdraw mounts/access under change control and restore the previous approved source. Never delete a gateway/cache or forcibly remove a dirty share to roll back; prevent_destroy protects accidental share/role deletion. Switching read-only does not reverse prior writes or purge data/cache. Preserve files/versions/audit/key/state/retention and separately authorize decommission after owner signoff. This export performs no live AWS/data operations.

https://docs.aws.amazon.com/filegateway/latest/files3/CreatingAnNFSFileShare.html
https://docs.aws.amazon.com/filegateway/latest/files3/grant-access-s3.html
https://docs.aws.amazon.com/filegateway/latest/files3/cross-service-confused-deputy-prevention.html
https://docs.aws.amazon.com/storagegateway/latest/APIReference/API_CreateNFSFileShare.html
`;
