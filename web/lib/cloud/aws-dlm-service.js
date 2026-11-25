                                                   
import {error,            } from '../core/findings.js';
import {blk,dat,hcl,output,res,x} from '../terraform/blueprints/migration/common.js';
import {awsServiceModule,awsServiceRegion} from './aws-service-module.js';
import {dlmInspection,dlmSnapshotInspection} from './aws-dlm-files.js';
export const AWS_DLM_SERVICE={
  id:'aws_service_dlm_volume_snapshots',label:'Stage a disabled encrypted EBS volume snapshot lifecycle policy',
  description:'Existing owned encrypted volumes, exact tag selector and approved execution role. Review target expansion, snapshot retention/deletion and restoration before enabling.',
  emits:['aws_dlm_lifecycle_policy'],
  inputs:[awsServiceRegion,{id:'name',label:'Policy label',control:'text'},
    {id:'account',label:'Expected owner account ID',control:'text'},
    {id:'volumes',label:'Expected existing EBS volume IDs',control:'text',hint:'Comma-separated baseline. Future volumes with the target tag also become targets.'},
    {id:'keys',label:'Existing source-volume customer KMS key ARNs',control:'text'},
    {id:'role',label:'Existing approved DLM execution role ARN',control:'text'},
    {id:'tag_key',label:'Exact target tag key',control:'text',default:'BackupPlan'},
    {id:'tag_value',label:'Exact target tag value',control:'text'},
    {id:'interval',label:'Snapshot interval',control:'select',default:'24',options:[1,2,3,4,6,8,12,24].map(n=>({value:String(n),label:n+' hours'}))},
    {id:'time',label:'Start time (UTC)',control:'text',default:'03:00'},
    {id:'retain',label:'Snapshots retained per volume',control:'number',default:'7'},
  ],
  build(values)                                    {
    const findings          =[],reject=(path       ,message       )=>findings.push(error('aws.dlm.'+path,message,{path}));
    const text=(key       )=>String(values[key]??'').trim(),list=(key       )=>text(key).split(',').map(s=>s.trim()).filter(Boolean);
    const region=text('aws_region'),name=text('name'),account=text('account'),volumes=list('volumes'),keys=list('keys'),role=text('role'),tagKey=text('tag_key'),tagValue=text('tag_value'),interval=Number(text('interval')),time=text('time'),retain=Number(text('retain'));
    if(!['us-east-1','us-east-2','us-west-1','us-west-2'].includes(region))reject('aws_region','Initial workflow covers four US commercial DLM FIPS regions.');
    if(!/^[a-z][a-z0-9-]{1,38}[a-z0-9]$/.test(name))reject('name','Use3–40 lowercase letters, digits and internal hyphens.');
    if(!/^\d{12}$/.test(account))reject('account','Use the12-digit volume/key/role owner account.');
    if(!volumes.length||volumes.length>50||new Set(volumes).size!==volumes.length||volumes.some(id=>!/^vol-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(id)))reject('volumes','Use1–50 unique existing EBS volume IDs.');
    if(!keys.length||keys.length>20||new Set(keys).size!==keys.length||keys.some(arn=>!new RegExp('^arn:aws:kms:'+region+':'+account+':key/(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|mrk-[a-f0-9]{32})$').test(arn)))reject('keys','Use1–20 unique same-owner/region customer key ARNs.');
    if(!new RegExp('^arn:aws:iam::'+account+':role/[A-Za-z0-9_+=,.@/-]+$').test(role)||role.endsWith('/'))reject('role','Use an existing same-owner approved DLM execution role ARN.');
    if(!/^[A-Za-z0-9][A-Za-z0-9_.:/+@-]{0,126}$/.test(tagKey)||/^aws:/i.test(tagKey))reject('tag_key','Use a nonreserved exact target tag key,1–127 safe characters, excluding equals and backslash.');
    if(!/^[A-Za-z0-9][A-Za-z0-9_.:/+=@-]{0,127}$/.test(tagValue))reject('tag_value','Use a nonempty exact target tag value,1–128 safe characters.');
    if(![1,2,3,4,6,8,12,24].includes(interval))reject('interval','Select a supported hourly interval.');
    if(!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))reject('time','Use HH:MM UTC. Operations start within the following one-hour window.');
    if(!Number.isInteger(retain)||retain<1||retain>1000)reject('retain','Retain1–1000 snapshots per volume; excess snapshots are permanently deleted.');
    const resources=[blk('provider',{alias:'snapshots',region,use_fips_endpoint:true,allowed_account_ids:[account]},[],['aws']),dat('aws_caller_identity','current',{}),dat('aws_iam_role','execution',{name:role.split('/').at(-1)||'invalid'}),
      ...volumes.map((id,i)=>dat('aws_ebs_volume','source_'+i,{},[blk('filter',{name:'volume-id',values:[id]})])),
      ...keys.map((arn,i)=>dat('aws_kms_key','source_'+i,{key_id:arn})),
      res('aws_dlm_lifecycle_policy','configured',{provider:x('aws.snapshots'),description:name,execution_role_arn:role,state:'DISABLED',tags:x(hcl({Name:name}))},[
        blk('policy_details',{policy_type:'EBS_SNAPSHOT_MANAGEMENT',resource_types:['VOLUME'],resource_locations:['CLOUD'],target_tags:x(hcl({[tagKey]:tagValue}))},[
          blk('schedule',{name:'reviewed-volume-snapshots',copy_tags:false,tags_to_add:x(hcl({BackupPlan:name}))},[
            blk('create_rule',{interval,interval_unit:'HOURS',times:[time],location:'CLOUD'}),blk('retain_rule',{count:retain}),
          ]),
        ]),blk('lifecycle',{prevent_destroy:true},[blk('precondition',{
          condition:x(`data.aws_caller_identity.current.account_id == ${JSON.stringify(account)} && data.aws_iam_role.execution.arn == ${JSON.stringify(role)} && ${volumes.map((_,i)=>`(startswith(data.aws_ebs_volume.source_${i}.arn, ${JSON.stringify('arn:aws:ec2:'+region+':'+account+':volume/')} ) && data.aws_ebs_volume.source_${i}.encrypted && contains(${hcl(keys)}, data.aws_ebs_volume.source_${i}.kms_key_id) && try(data.aws_ebs_volume.source_${i}.outpost_arn, "") == "" && lookup(data.aws_ebs_volume.source_${i}.tags, ${JSON.stringify(tagKey)}, "") == ${JSON.stringify(tagValue)})`).join(' && ')} && ${keys.map((arn,i)=>`(data.aws_kms_key.source_${i}.arn == ${JSON.stringify(arn)} && data.aws_kms_key.source_${i}.key_manager == "CUSTOMER" && data.aws_kms_key.source_${i}.key_state == "Enabled" && data.aws_kms_key.source_${i}.key_spec == "SYMMETRIC_DEFAULT" && data.aws_kms_key.source_${i}.key_usage == "ENCRYPT_DECRYPT")`).join(' && ')}`),
          error_message:'Require owned tagged encrypted regional volumes, exact approved execution role and enabled customer symmetric keys. Run INSPECT.py for exact tag-target inventory and role trust; effective permissions require independent review.',
        })]),
      ]),output('policy_id','aws_dlm_lifecycle_policy.configured.id'),output('policy_arn','aws_dlm_lifecycle_policy.configured.arn')];
    const result=awsServiceModule(region,resources,GUIDE,findings);
    return {...result,files:{...result.files,'INSPECT.py':dlmInspection,'CHECK-SNAPSHOTS.py':dlmSnapshotInspection,'DLM-CONFIG.json':JSON.stringify({region,name,account,volumes,keys,role,tagKey,tagValue,interval,time,retain},null,2)+'\n'}};
  },
}                    ;

const GUIDE=`# EBS volume snapshot lifecycle staging

Creates one DISABLED custom same-Region VOLUME EBS_SNAPSHOT_MANAGEMENT policy against one exact tag pair, using an existing approved DLM execution role. Existing encrypted EBS volumes/customer symmetric keys only. No role/key/tag mutation, snapshot creation/deletion, cross-Region copy, sharing, AMI, archive, fast restore, Outpost or Local Zone workflows are performed by export. Initial four US commercial FIPS control API regions; no data-plane or federal authorization certification is implied.

Expected volume IDs are a BASELINE, not an ID restriction enforced by DLM. Every current/future matching tagged volume is selected by the service. Restrict tag-change/volume-creation authority and execution role resource/key scope, monitor target expansion, and rerun inventory checks before enable and routinely afterward. Terraform checks listed volumes only; INSPECT.py separately enumerates all matching volumes and rejects missing/extra/duplicate targets. Inventory can change between inspection and apply. A tag name is not a security boundary.

Run python INSPECT.py first in the approved metadata boundary. It verifies owner, exact target inventory, encrypted source keys and existing DLM role trust, and returns summaries of other lifecycle policies for independent overlap review. Existing instance-target policies, AWS Backup, third-party tools, scripts and retention locks require separate overlap review; absence of a matching policy description does not prove exclusivity. The inspector never reads block data or starts snapshots. Review role effective IAM, PassRole, customer key policies/grants, service roles, quotas, source health and workload consistency separately.

Approve actual civilian/DoD/State classification, ATO/SSP/APL/CDM/DoDIN, CMVP, residency, records/legal hold, backup/retention/key/support boundaries before snapshots. Copy-tags is false to avoid blindly copying source metadata; policy/snapshot tags themselves may still be sensitive. Snapshot encryption inherits each source volume key; no fabricated independent encryption key is set on a local snapshot schedule. Preserve keys and grants for the full retention and recovery period.

Run init/validate/plan and owner-apply only after review of the protected state and policy. It starts DISABLED. Then run python INSPECT.py --policy <exact-policy_id>. Before enabling, test an independently approved recovery snapshot/restore in an isolated boundary and validate application recovery/RPO/RTO. Volume-target snapshots are crash-consistent, not coordinated multi-volume or application-consistent backups; quiesce/database backup and instance pre/post scripts require separately qualified workflows.

Enabling is a real backup AND automatic permanent-deletion authorization. Count retention1–1000 applies per volume; when the next snapshot exceeds retention the oldest eligible snapshot is deleted. It is not an immutable/legal-hold backup or guaranteed time retention. UTC start has a one-hour initiation window, not an exact completion deadline. After owner approval edit the generated Terraform state from DISABLED to ENABLED, review a fresh plan and apply through the approved operator process; the toolkit never invokes enable automatically. Run python INSPECT.py --policy <id> --expect-enabled afterward. Drift/ERROR/disabled status, snapshot failures, quotas/key expiry and actual recovery must be monitored. A successful metadata check does not prove snapshot existence, restorability or data integrity.

After the first cycle run python CHECK-SNAPSHOTS.py --policy <exact-policy_id> --max-age-hours <owner-approved-freshness-bound>. It paginates owned snapshots for the exact policy tag, rejects duplicates/unknown sources/error states/unexpected key/archive/location, checks schedule lineage and requires a recent completed snapshot for every baseline source. It reports pending snapshots/counts/over-retention flags without claiming exact retention timing; start age is not completion time. Pair it with the policy inspector: system tags are metadata, not cryptographic proof of creation origin. Independently verify actual per-volume key association, restoration/application integrity, retention/legal hold and policy operation. No snapshot contents are read or restored. Do not price snapshots as full provisioned volume size times retention: EBS snapshots are incremental and billed from actual retained changed blocks; use measured snapshots/change rates, storage tier, retention/copies and restore costs. Feed actual source sizes and separately recorded change rates/retention into TCO; this flow does not claim that integration is complete.

Rollback: disable through a separately reviewed plan to stop future lifecycle operations, reconcile in-flight activity and retain recovery evidence/keys. Disabling or deleting a policy is not an undo for already deleted snapshots and does not delete retained snapshots automatically under this custom workflow. prevent_destroy guards Terraform policy removal, not service retention deletion. Decommission only under records/security/change approval after independent recovery evidence, cost/ownership handoff and retention review.

https://docs.aws.amazon.com/dlm/latest/APIReference/API_CreateRule.html
https://docs.aws.amazon.com/dlm/latest/APIReference/API_RetainRule.html
https://docs.aws.amazon.com/ebs/latest/userguide/snapshot-lifecycle.html
https://docs.aws.amazon.com/general/latest/gr/dlm.html
`;
