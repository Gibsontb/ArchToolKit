import type { Blueprint } from '../kit/blueprint.ts';
import { AWS_MGN_SERVICE, mgnOperator } from './aws-mgn-service.ts';

export const AWS_MGN_CUTOVER_SERVICE={
  ...AWS_MGN_SERVICE,
  id:'aws_service_mgn_cutover',label:'Launch one tested MGN source into its production target',
  description:'Inspect reviewed private production settings, explicitly request one cutover launch and check its exact target. Keep replication until separate acceptance/finalization.',
  inputs:AWS_MGN_SERVICE.inputs.map(input=>input.id==='name'?{...input,label:'Cutover name'}:input.id==='subnet'?{...input,label:'Existing private production target subnet ID'}:input.id==='groups'?{...input,label:'Existing production target security group IDs',hint:'Comma-separated approved target groups; exact reviewed launch template must match.'}:input.id==='staging'?{...input,hint:'Private staging and production target subnets must be in the same approved VPC for this workflow.'}:input.id==='lag'?{...input,default:1,hint:'Maximum observed lag after independently verified source-writer freeze and final sync. Metadata cannot prove application consistency.'}:input),
  build(values):ReturnType<typeof AWS_MGN_SERVICE.build>{
    const base=AWS_MGN_SERVICE.build(values);
    const config=JSON.parse(base.files['PILOT-CONFIG.json']!);
    const files={...base.files};delete files['PILOT-CONFIG.json'];
    return {...base,files:{...files,'CUTOVER-CONFIG.json':JSON.stringify({...config,production:true},null,2)+'\n','OPERATE.py':mgnOperator(true),'CHECK-TARGET.py':TARGET_CHECK,'DECIDE.py':DECIDE,'SERVICE-SETUP.md':GUIDE}};
  },
} satisfies Blueprint;

const TARGET_CHECK=[
  'import argparse, json, pathlib, re',
  'import boto3',
  'from botocore.config import Config',
  'parser=argparse.ArgumentParser(description="Read metadata for the exact completed one-source MGN cutover target")',
  'parser.add_argument("--job",required=True); args=parser.parse_args()',
  'if not re.fullmatch(r"mgnjob-[0-9A-Za-z]{17}",args.job): raise RuntimeError("Require the returned cutover job ID")',
  'config=json.loads((pathlib.Path(__file__).resolve().parent/"CUTOVER-CONFIG.json").read_text())',
  'session=boto3.Session(region_name=config["region"]); options=Config(retries={"total_max_attempts":1,"mode":"standard"},use_fips_endpoint=config["fips"])',
  'if session.client("sts",config=options).get_caller_identity()["Account"]!=config["account"]: raise RuntimeError("Unexpected operator account")',
  'mgn=session.client("mgn",config=options); ec2=session.client("ec2",config=options)',
  'response=mgn.describe_jobs(filters={"jobIDs":[args.job]},maxResults=2)',
  'jobs=response.get("items",[])',
  'if response.get("nextToken") or len(jobs)!=1 or jobs[0].get("jobID")!=args.job: raise RuntimeError("Require exact unpaginated job")',
  'job=jobs[0]; servers=job.get("participatingServers",[])',
  'if job.get("initiatedBy")!="START_CUTOVER" or job.get("type")!="LAUNCH" or job.get("status")!="COMPLETED" or len(servers)!=1 or servers[0].get("sourceServerID")!=config["sourceID"] or servers[0].get("launchStatus")!="LAUNCHED": raise RuntimeError("Require completed successful cutover launch for only the selected source")',
  'instance_id=servers[0].get("launchedEc2InstanceID","")',
  'if not re.fullmatch(r"i-[0-9a-f]{17}",instance_id): raise RuntimeError("Invalid target instance receipt")',
  'source_response=mgn.describe_source_servers(filters={"sourceServerIDs":[config["sourceID"]]},maxResults=2)',
  'sources=source_response.get("items",[])',
  'if source_response.get("nextToken") or len(sources)!=1 or sources[0].get("arn")!=config["source"] or sources[0].get("sourceServerID")!=config["sourceID"] or sources[0].get("isArchived") or sources[0].get("lifeCycle",{}).get("state")!="CUTTING_OVER" or sources[0].get("launchedInstance",{}).get("ec2InstanceID")!=instance_id: raise RuntimeError("Source/current cutover target changed or finalized; inspect lifecycle before proceeding")',
  'response=ec2.describe_instances(InstanceIds=[instance_id]); reservations=response.get("Reservations",[])',
  'instances=[item for reservation in reservations for item in reservation.get("Instances",[])]',
  'if response.get("NextToken") or len(reservations)!=1 or reservations[0].get("OwnerId")!=config["account"] or len(instances)!=1 or instances[0].get("InstanceId")!=instance_id: raise RuntimeError("Target identity/account differs")',
  'instance=instances[0]; interfaces=instance.get("NetworkInterfaces",[])',
  'if instance.get("State",{}).get("Name")!="running" or instance.get("InstanceType")!=config["instance"] or instance.get("SubnetId")!=config["subnet"] or instance.get("PublicIpAddress") or len(interfaces)!=1 or {item.get("GroupId") for item in instance.get("SecurityGroups",[])}!=set(config["groups"]): raise RuntimeError("Target state/type/private placement/groups differ")',
  'nic=interfaces[0]',
  'if nic.get("SubnetId")!=config["subnet"] or nic.get("Association") or nic.get("Ipv6Addresses") or nic.get("Ipv6Prefixes") or nic.get("Attachment",{}).get("DeviceIndex")!=0 or {item.get("GroupId") for item in nic.get("Groups",[])}!=set(config["groups"]): raise RuntimeError("Target interface differs")',
  'metadata=instance.get("MetadataOptions",{})',
  'if metadata.get("State")!="applied" or metadata.get("HttpTokens")!="required" or metadata.get("HttpEndpoint")!="enabled" or metadata.get("HttpPutResponseHopLimit",99)>2: raise RuntimeError("Target IMDSv2 differs")',
  'if (instance.get("IamInstanceProfile",{}).get("Arn") or "")!=config["profile"]: raise RuntimeError("Target instance profile differs")',
  'if ec2.describe_instance_attribute(InstanceId=instance_id,Attribute="disableApiTermination").get("DisableApiTermination",{}).get("Value") is not True: raise RuntimeError("Target termination protection is absent")',
  'devices=instance.get("BlockDeviceMappings",[]); volume_ids=[item.get("Ebs",{}).get("VolumeId","") for item in devices]',
  'if not volume_ids or len(set(volume_ids))!=len(volume_ids) or any(not re.fullmatch(r"vol-[0-9a-f]{17}",value) for value in volume_ids) or not any(item.get("DeviceName")==instance.get("RootDeviceName") for item in devices): raise RuntimeError("Require unique EBS devices including the root")',
  'volume_response=ec2.describe_volumes(VolumeIds=volume_ids); volumes=volume_response.get("Volumes",[])',
  'if volume_response.get("NextToken") or len(volumes)!=len(volume_ids) or {item.get("VolumeId") for item in volumes}!=set(volume_ids): raise RuntimeError("Target volume inventory differs")',
  'for volume in volumes:',
  '    attached=volume.get("Attachments",[])',
  '    if volume.get("State")!="in-use" or volume.get("Encrypted") is not True or volume.get("KmsKeyId")!=config["kms"] or len(attached)!=1 or attached[0].get("InstanceId")!=instance_id or attached[0].get("State")!="attached": raise RuntimeError("Target EBS encryption/key/attachment differs")',
  'print(json.dumps({"sourceServerID":config["sourceID"],"jobID":args.job,"instanceID":instance_id,"volume_count":len(volumes),"target_metadata_checked":True,"application_acceptance_verified":False,"traffic_changed":False,"cutover_finalized":False}))',
].join('\n')+'\n';

const DECIDE=[
  'import argparse, contextlib, io, json, pathlib, runpy, sys',
  'import boto3',
  'from botocore.config import Config',
  'parser=argparse.ArgumentParser(description="Inspect exact target by default; explicitly finalize replication OR revert lifecycle, never change traffic or recover application data")',
  'parser.add_argument("--job",required=True)',
  'mode=parser.add_mutually_exclusive_group(); mode.add_argument("--finalize",action="store_true"); mode.add_argument("--revert-lifecycle",action="store_true")',
  'for flag in ["--confirm-application-acceptance","--confirm-recovery-backup","--confirm-rollback-window-closed","--confirm-discard-replication","--confirm-writers-frozen","--confirm-data-reconciled","--confirm-traffic-controlled"]: parser.add_argument(flag,action="store_true")',
  'args=parser.parse_args(); root=pathlib.Path(__file__).resolve().parent',
  'if args.finalize and not (args.confirm_application_acceptance and args.confirm_recovery_backup and args.confirm_rollback_window_closed and args.confirm_discard_replication): raise RuntimeError("Finalize needs explicit application acceptance, tested recovery backup, closed rollback window and irreversible replication discard confirmations")',
  'if args.revert_lifecycle and not (args.confirm_writers_frozen and args.confirm_data_reconciled and args.confirm_traffic_controlled): raise RuntimeError("Lifecycle revert needs independently verified writer freeze, data reconciliation and controlled traffic confirmations")',
  'original_argv=sys.argv[:]',
  'try:',
  '    sys.argv=[str(root/"CHECK-TARGET.py"),"--job",args.job]',
  '    with contextlib.redirect_stdout(io.StringIO()) as output: runpy.run_path(str(root/"CHECK-TARGET.py"),run_name="__main__")',
  'finally: sys.argv=original_argv',
  'report=json.loads(output.getvalue())',
  'if report.get("target_metadata_checked") is not True or report.get("jobID")!=args.job: raise RuntimeError("Target check receipt differs")',
  'if not (args.finalize or args.revert_lifecycle): print(json.dumps(report)); raise SystemExit(0)',
  'config=json.loads((root/"CUTOVER-CONFIG.json").read_text())',
  'if report.get("sourceServerID")!=config["sourceID"]: raise RuntimeError("Source check receipt differs")',
  'session=boto3.Session(region_name=config["region"]); options=Config(retries={"total_max_attempts":1,"mode":"standard"},use_fips_endpoint=config["fips"])',
  'if session.client("sts",config=options).get_caller_identity()["Account"]!=config["account"]: raise RuntimeError("Unexpected decision operator account")',
  'mgn=session.client("mgn",config=options)',
  'if args.finalize: response=mgn.finalize_cutover(sourceServerID=config["sourceID"])',
  'else: response=mgn.change_server_life_cycle_state(sourceServerID=config["sourceID"],lifeCycle={"state":"READY_FOR_CUTOVER"})',
  'expected="CUTOVER" if args.finalize else "READY_FOR_CUTOVER"',
  'if response.get("arn")!=config["source"] or response.get("sourceServerID")!=config["sourceID"] or response.get("lifeCycle",{}).get("state")!=expected: raise RuntimeError("Ambiguous decision receipt: inspect source state/history before any repeat; do not retry automatically")',
  'print(json.dumps({"sourceServerID":config["sourceID"],"requested_lifecycle":expected,"request_accepted":True,"replication_cleanup_verified":False,"source_decommissioned":False,"traffic_changed":False,"reverse_data_copy_performed":False}))',
].join('\n')+'\n';

const GUIDE=`# One-source production MGN cutover

This is a separate production workflow after the stopped pilot, not agent enrollment or a complete automated migration. Terraform reads existing metadata and records a local review guard only. OPERATE.py inspects by default; only explicit --cutover sends StartCutover. It does not update shared defaults/source configuration, start/terminate existing instances, change DNS/routes, finalize replication or decommission the source. Requires Terraform1.4+, Python3/current boto3 and existing owner-approved exact-source MGN/EC2/KMS metadata and StartCutover permissions. No broad role is attached.

1. Complete the pilot's OS/boot/application/dependency/license/restore tests and record acceptance. Review source inventory/disks, exact target sizing/capacity/quotas/cost, staging and target routes/NACLs/SG access, rollback point and owner/change-window decisions. Authorize the destination, replication/data/log/backup/key boundary and applicable civilian/DoD/State classification, residency, privacy, records, SSP/ATO/APL/CDM/DoDIN/STIG/CMVP evidence. Region selection/FIPS/this package does not grant any certification or authorization. Existing network/key/IAM and effective runtime controls require independent validation.
2. Record accepted test and backups. Through reviewed MGN owner procedures mark the exact source READY_FOR_CUTOVER and remove its old pilot target after preserving required evidence. Existing launched instance metadata blocks this helper's new launch. Do not change or delete another source's target.
3. Review the per-source production template/default version and launch configuration: STARTED disposition, one new private IPv4 primary NIC in the chosen target subnet/groups, no copied/fixed source IP, reviewed x86 instance/profile, IMDSv2, API termination protection true, no right sizing or active post-launch actions/documents. Same-account/VPC private staging, exact customer key and matching EBS defaults remain required. No defaults/trust/key policy is changed. Review all other template fields, user data, tenancy and boot/license settings separately. Terraform review guard shares pilot network/key checks; production launch disposition/protection are checked by OPERATE.py.
4. Run terraform init/validate/plan, review/apply only the local terraform_data record, then python OPERATE.py. Protect the reviewed directory/config/state. Plan and metadata reads do not prove source consistency or safety of inherited template fields. Before cutover freeze ALL source/application writers using owner procedures, complete application-consistent backup and recovery validation, verify final sync, and prevent simultaneous writers. Lag is only observed replication metadata and never a guaranteed RPO or consistency proof. Confirm these controls independently; command flags record operator attestations, not measured evidence.
5. Run python OPERATE.py --cutover --confirm-launch --confirm-write-freeze --confirm-backup --confirm-acceptance. Requires READY_FOR_CUTOVER, continuous error-free replication within the selected lag and no existing target; sends ONE StartCutover without SDK retry. It launches production/conversion resources and starts the target OS; user data or installed services may run. Network isolation and dependency/egress controls must already be approved. Reads and launch are not atomic. No client-token deduplication: on error/timeout inspect exact source/job history before retry; never blindly repeat.
6. Save the receipt. Run python OPERATE.py --job <job-id> to inspect its exact one-source START_CUTOVER job. A receipt is not success. After COMPLETED and LAUNCHED run python CHECK-TARGET.py --job <job-id>. This reads the exact current CUTTING_OVER source target, running instance/private interface/groups/profile/IMDSv2/termination protection and every attached EBS volume's selected customer-key encryption. It reads no disk contents, credentials, user data or application responses. Effective firewall/key policy, boot/OS health, end-to-end data integrity, performance, backup/restore and application acceptance still need owner tests.
7. Keep source writers frozen and replication until target tests pass. Perform independently approved client/DNS/load-balancer/route changes and establish exactly one writer. Record integrity checks, recovery points, monitoring, backup and sign-offs. Before target writes, rollback may return clients to the unchanged source under the approved runbook. After target writes, freeze target writers and reconcile/recover those writes through an application-specific reverse-data plan BEFORE returning traffic; an MGN lifecycle revert does not copy target data back. Avoid split brain and unreviewed instance deletion. Do not assume reverting after finalization can recover replication.
8. DECIDE.py --job <job-id> runs the exact target check without a mutation by default. For a bounded lifecycle revert, independently freeze writers, reconcile target writes to the approved authoritative source and control traffic first, then run python DECIDE.py --job <job-id> --revert-lifecycle --confirm-writers-frozen --confirm-data-reconciled --confirm-traffic-controlled. It sends one ChangeServerLifeCycleState to READY_FOR_CUTOVER; it does not stop writers, change traffic, delete instances or recover/copy any data. Existing target metadata still blocks a new launch until owners safely handle it. A failed/unreachable/non-running or changed target cannot pass this bounded decision helper; use the separately approved incident recovery procedure instead. Finalized CUTOVER sources are explicitly rejected.
9. Finalize ONLY after owner acceptance and rollback-window decision. Run python DECIDE.py --job <job-id> --finalize --confirm-application-acceptance --confirm-recovery-backup --confirm-rollback-window-closed --confirm-discard-replication. After rechecking exact target metadata it sends ONE FinalizeCutover without SDK retry. This disconnects replication, discards replicas, removes replication resources and sends agent uninstall; launched targets remain. Flags are operator attestations, not evidence of actual application/backup tests or data safety. Protect source-server decision permissions separately. Reads/decisions are not atomic. Ambiguous results require state/history inspection before repeat; never automatically retry. Inspect source CUTOVER state, replication resource cleanup (may take90minutes), agent removal and target persistence through owner procedures; an accepted receipt does not prove cleanup. Retain evidence, then independently approve source decommission, records retention, sanitization and asset disposition. No automatic finalization, traffic change or decommission occurs.

https://docs.aws.amazon.com/mgn/latest/APIReference/API_StartCutover.html
https://docs.aws.amazon.com/mgn/latest/ug/starting-cutover.html
https://docs.aws.amazon.com/mgn/latest/ug/revert-finalize-cutover.html
https://docs.aws.amazon.com/mgn/latest/APIReference/API_FinalizeCutover.html
https://docs.aws.amazon.com/mgn/latest/APIReference/API_ChangeServerLifeCycleState.html
`;
