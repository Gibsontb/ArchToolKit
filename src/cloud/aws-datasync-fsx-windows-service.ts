import type { Blueprint } from '../kit/blueprint.ts';
import { error, type Finding } from '../core/findings.ts';
import { blk, dat, res, x } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule } from './aws-service-module.ts';
import { AWS_DATASYNC_SMB_SERVICE } from './aws-datasync-smb-service.ts';
import { awsDataSyncSmbSource } from './aws-datasync-smb-source.ts';
import { awsDataSyncTask } from './aws-datasync-task.ts';
import { awsDataSyncOperator } from './aws-datasync-operator.ts';

export const AWS_DATASYNC_FSX_WINDOWS_SERVICE = {
  id:'aws_service_datasync_smb_fsx_windows', label:'Migrate SMB ownership and ACLs to FSx Windows',
  description:'Basic-mode approved NTLM SMB migration to an existing FSx Windows share, with ownership/DACL and optional SACL copying.',
  emits:['aws_datasync_location_smb','aws_datasync_location_fsx_windows_file_system','aws_datasync_task'],
  inputs:[
    ...AWS_DATASYNC_SMB_SERVICE.inputs.filter(input=>!['bucket','prefix','role'].includes(input.id)).map(input=>input.id==='ntlm_allowed'?{...input,label:'NTLM is permitted for source, FSx target and transfer boundary'}:input),
    { id:'filesystem',label:'Existing FSx Windows file system ID',control:'text' },
    { id:'target_path',label:'Destination share and directory',control:'text',default:'/share/migration',hint:'Existing approved share/directory, not DFS. Use forward slashes.' },
    { id:'group',label:'Existing DataSync destination security group ID',control:'text',hint:'Same VPC as FSx. Owner must permit DataSync-to-FSx SMB and required AD traffic; shared rules are not modified.' },
    { id:'target_user',label:'FSx destination username',control:'text',hint:'Approved delegated FSx administrator with required restore rights; source and target passwords are separate deployment variables.' },
    { id:'target_domain',label:'FSx destination domain',control:'text' },
    { id:'relationship',label:'Source and destination AD relationship',control:'select',default:'SAME',options:[{value:'SAME',label:'Same domain'},{value:'TRUSTED',label:'Owner-verified AD trust between domains'}],hint:'Records reviewed identity topology. This tool does not configure or prove AD trust.' },
    { id:'security',label:'Windows security metadata',control:'select',default:'OWNER_DACL',options:[{value:'OWNER_DACL',label:'Owner and DACLs'},{value:'OWNER_DACL_SACL',label:'Owner, DACLs and SACLs — additional audit rights'}] },
  ],
  build(values): ReturnType<typeof awsServiceModule> {
    const findings:Finding[]=[],reject=(path:string,message:string)=>findings.push(error('aws.datasync-fsx-windows.'+path,message,{path}));
    const {region,partition,name,agent,server,path,user,domain,account}=awsDataSyncSmbSource(values,reject);
    const filesystem=String(values.filesystem ?? '').trim(),targetPath=String(values.target_path ?? '').trim(),group=String(values.group ?? '').trim(),targetUser=String(values.target_user ?? '').trim(),targetDomain=String(values.target_domain ?? '').trim(),relationship=String(values.relationship ?? ''),security=String(values.security ?? '');
    if (!/^fs-[0-9a-f]{8,17}$/.test(filesystem)) reject('filesystem','Enter the existing FSx Windows file system ID.');
    if (!/^sg-(?:[0-9a-f]{8}|[0-9a-f]{17})$/.test(group)) reject('group','Enter the existing destination security group ID.');
    if (!/^\/[A-Za-z0-9_$.-]+(?:\/[A-Za-z0-9_$.-]+)*$/.test(targetPath) || targetPath.length>4096 || targetPath.split('/').some(part=>part==='.'||part==='..')) reject('target_path','Use an approved existing /share/directory without traversal or trailing slash.');
    if (!/^[A-Za-z0-9_.@-]{1,104}$/.test(targetUser)) reject('target_user','Enter the destination username without domain separator.');
    if (!targetDomain || targetDomain.length>253 || !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(targetDomain) || targetDomain.includes('..')) reject('target_domain','Enter the FSx destination domain.');
    if (!domain) reject('domain','ACL-preserving migration requires a source domain identity in the same or trusted domain.');
    if (!['SAME','TRUSTED'].includes(relationship) || relationship==='SAME' && domain.toLowerCase()!==targetDomain.toLowerCase()) reject('relationship','Use the same domain spelling or record an owner-verified trust relationship.');
    if (!['OWNER_DACL','OWNER_DACL_SACL'].includes(security)) reject('security','Select the Windows security metadata to copy.');
    const bandwidth=Number(values.bandwidth),bytes=bandwidth===0?-1:Math.round(bandwidth*1e6),overwrite=String(values.overwrite ?? ''),logging=String(values.logging ?? ''),retention=Number(values.retention);
    if (!Number.isFinite(bandwidth)||bandwidth<0||!Number.isSafeInteger(bytes)||bytes===0) reject('bandwidth','Use zero for unlimited or a positive finite MB/second rate.');
    if (!['NEVER','ALWAYS'].includes(overwrite)) reject('overwrite','Choose destination overwrite behavior.');
    if (!['BASIC','TRANSFER'].includes(logging)) reject('logging','Choose logging detail.');
    if (![7,14,30,60,90,180,365].includes(retention)) reject('retention','Choose log retention.');
    const fsArn='arn:'+partition+':fsx:'+region+':'+account+':file-system/'+filesystem;
    const result=awsServiceModule(region,[
      ...['smb_source_password','fsx_destination_password'].map(variable=>blk('variable',{type:x('string'),sensitive:true,description:'Deployment-only SMB credential; protect Terraform state and saved plans.'},[blk('validation',{condition:x('length(var.'+variable+') >= 1 && length(var.'+variable+') <= 104'),error_message:'Password must be 1–104 characters.'})],[variable])),
      dat('aws_fsx_windows_file_system','destination',{id:filesystem}),dat('aws_security_group','destination',{id:group}),dat('aws_vpc','destination',{id:x('data.aws_fsx_windows_file_system.destination.vpc_id')}),
      res('aws_datasync_location_smb','source',{server_hostname:server,subdirectory:path,user,domain,password:x('var.smb_source_password'),agent_arns:[agent]},[blk('mount_options',{version:'SMB3'})]),
      res('aws_datasync_location_fsx_windows_file_system','destination',{fsx_filesystem_arn:fsArn,subdirectory:targetPath,user:targetUser,domain:targetDomain,password:x('var.fsx_destination_password'),security_group_arns:x('[data.aws_security_group.destination.arn]')},[
        blk('lifecycle',{},[blk('precondition',{condition:x('data.aws_caller_identity.current.account_id == '+JSON.stringify(account)+' && data.aws_fsx_windows_file_system.destination.arn == '+JSON.stringify(fsArn)+' && data.aws_fsx_windows_file_system.destination.owner_id == data.aws_caller_identity.current.account_id && data.aws_fsx_windows_file_system.destination.automatic_backup_retention_days >= 1 && data.aws_security_group.destination.vpc_id == data.aws_fsx_windows_file_system.destination.vpc_id && data.aws_vpc.destination.instance_tenancy == "default"'),error_message:'Require this account regional FSx Windows with automatic backups, same-VPC transfer group and default tenancy.'})]),
      ]),
      ...awsDataSyncTask(region,name,'aws_datasync_location_smb.source.arn','aws_datasync_location_fsx_windows_file_system.destination.arn',retention,{bytes_per_second:bytes,log_level:logging,overwrite_mode:overwrite,object_tags:'NONE',security_descriptor_copy_flags:security},'aws_datasync_location_fsx_windows_file_system.destination.uri'),
    ],GUIDE,findings);
    return {...result,files:{...result.files,...awsDataSyncOperator({region,partition,name,source:{kind:'smb',server,path,agent,user,domain},destination:{kind:'fsxwindows',filesystem,path:targetPath,group,user:targetUser,domain:targetDomain},options:{BytesPerSecond:bytes,LogLevel:logging,OverwriteMode:overwrite,ObjectTags:'NONE',SecurityDescriptorCopyFlags:security}})}};
  },
} satisfies Blueprint;

const GUIDE=`# SMB to FSx Windows — ownership and ACL migration

## Source, AD and destination
Prepare an activated Basic-mode DataSync appliance, actual SMB source server/share, approved source snapshot/quiescence and existing regional same-account AVAILABLE FSx Windows destination/share. DFS namespaces are unsupported. This recipe pins source SMB3.0.2 and uses NTLM credentials. The FSx Windows DataSync target itself requires NTLM; it does not support Kerberos-only access. Verify NTLM is permitted on both sides and the transfer boundary. Protocol choice does not prove negotiated transport encryption/signing; source/network owners must verify their mandated settings in a pilot. Provider5 does not configure Kerberos or newer secret-encryption controls.

Users on both sides must be in the same AD domain or domains with a verified AD trust. A topology selection is a recorded owner fact, not configured/proven trust. Preserve/resolve existing SIDs: copying an ACL does not map accounts, create users/groups or repair orphaned SIDs. For AWS Managed Microsoft AD, destination user needs AWS Delegated FSx Administrators membership. For self-managed AD, use the configured delegated administrators group with restore-file/directory rights (SE_RESTORE_NAME); adding SACLs requires manage-auditing/security-log rights (SE_SECURITY_NAME). Coordinate source rights as well. Do not broadly grant Domain Admin to work around errors. Changing FSx's deployed delegated administrator group can require redeployment or restore.

SYSTEM must retain Full Control on all FSx folders. Review the source ACLs and pilot inheritance/owner/DACL/optional SACL behavior before transfer; copying restrictive permissions can make the destination inaccessible and break usable backups. This package does not inspect, rewrite or override source ACLs. Inventory alternate streams, links, sparse/encrypted/compressed files, locks and unsupported metadata; validate AWS's current transfer support and application semantics. DataSync is not application/VM/database conversion.

## Network, backup and secrets
Use an existing transfer SG in the FSx VPC with default tenancy and reviewed SMB, AD/DNS, routing/NACL and FSx preferred-subnet connectivity. Have network owners permit communication with actual FSx groups; shared SGs/routes/AD are not modified. Check free IPs, capacity, throughput, quotas and backup windows/performance. Enable automatic FSx backups and verify completed recovery points, retention and an isolated restore: an enabled retention setting alone is not recovery proof. Prepare the approved destination directory and baseline ACLs through owner procedures.

Supply smb_source_password and fsx_destination_password separately through approved deployment-only secret channels. No password fields/defaults/examples are exported or collected by the browser; injected builder values are ignored. Sensitive flags only redact ordinary display: provider5 stores these credentials in state/saved plans. Encrypt/restrict those artifacts and backend access, avoid arguments/logs/source control, and review DataSync credential storage/key controls separately. Rotation must update the corresponding location through the approved deployment process. OPERATE.py never retrieves passwords or verifies AD credentials/effective privileges.

## Deploy, pilot and cutover
Run terraform init/validate and a secret-protected plan -out=service.tfplan; review exact source, target, credentials, identities, domain relationship, security metadata, backups, overwrite and network. Apply the reviewed plan. No task starts or is scheduled automatically. Follow OPERATOR.md: inspect metadata, then explicitly --start --confirm-transfer for an approved pilot (ALWAYS also requires --confirm-overwrite). FSx destination URI is bound to its immutable location's value from the reviewed Terraform deployment; keep that working directory/state protected. Operator metadata does not prove AD trust, SYSTEM FullControl, source ACL safety, completed backups, actual SMB connectivity or application acceptance.

Save the execution ARN and monitor --execution. Independently reconcile counts, checksums, actual owners/SIDs, inheritance, DACLs/selected SACLs and representative user/application access. OWNER_DACL intentionally omits SACLs; choose OWNER_DACL_SACL only with approved audit privileges and validation. NEVER also skips changed destination content/security; final delta requires reviewed ALWAYS, source writer freeze and recovery protection. Destination-only files remain preserved. Cut over consumers only after owner acceptance; retain rollback source and plan reconciliation of any new destination writes. Cancellation does not undo transferred content or ACL changes; use approved backup/restore and verify access/SYSTEM permissions before retry. Terraform removal deletes configuration, not source/FSx data. Cross-account/region, reverse cutback, Kerberos-only targets and identity/SID transformation require separate workflows.

https://docs.aws.amazon.com/datasync/latest/userguide/create-fsx-location.html
https://docs.aws.amazon.com/datasync/latest/userguide/create-smb-location.html
https://docs.aws.amazon.com/datasync/latest/apireference/API_Options.html
`;
