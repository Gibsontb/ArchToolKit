import type {Blueprint} from '../kit/blueprint.ts';
import {error,type Finding} from '../core/findings.ts';
import {blk,dat,hcl,res,x} from '../terraform/blueprints/migration/common.ts';
import {awsServiceModule,awsServicePartition,awsServiceRegion} from './aws-service-module.ts';
const regions=['us-east-1','us-east-2','us-west-1','us-west-2','us-gov-east-1','us-gov-west-1'];
export const AWS_DRS_SERVICE={
  id:'aws_service_drs_recovery',label:'Drill or recover one protected DRS source from a selected recovery point',
  description:'Inspect existing private DRS source/template and exact encrypted PIT snapshots; explicitly request one stopped drill or separately confirmed production recovery. No agent enrollment, shared configuration or traffic changes.',
  emits:['terraform_data'],
  inputs:[awsServiceRegion,{id:'name',label:'Recovery review name',control:'text'},
    {id:'mode',label:'Recovery operation',control:'select',default:'DRILL',options:[{value:'DRILL',label:'Isolated stopped drill'},{value:'RECOVERY',label:'Production recovery — starts the target OS'}]},
    {id:'source',label:'Existing DRS source-server ARN',control:'text'},
    {id:'snapshot',label:'Selected existing PIT recovery snapshot ID',control:'text',hint:'pit-… from this exact source. No implicit latest/on-demand point or fallback to another snapshot.'},
    {id:'age',label:'Maximum accepted snapshot age (hours)',control:'select',default:'24',options:[1,6,12,24,72,168,720].map(value=>({value:String(value),label:String(value)})),hint:'Explicit recovery-point freshness bound; not a guaranteed application RPO or consistency proof.'},
    {id:'template',label:'Existing per-source EC2 launch-template ID',control:'text'},
    {id:'version',label:'Reviewed default launch-template version',control:'number',default:1,min:1},
    {id:'subnet',label:'Existing private target subnet ID',control:'text',hint:'Isolated drill or approved production subnet, matching selected mode and reviewed template.'},
    {id:'groups',label:'Existing target security group IDs',control:'text',hint:'Comma-separated approved groups in the target VPC. No existing group is changed.'},
    {id:'staging',label:'Existing private staging subnet ID',control:'text',hint:'This bounded workflow requires staging and target in the same account/VPC.'},
    {id:'staging_groups',label:'Existing replication security group IDs',control:'text'},
    {id:'kms',label:'Existing staging/snapshot/target customer KMS key ARN',control:'text',hint:'Exact regional key and matching reviewed account EBS defaults. This tool does not change shared defaults.'},
    {id:'instance',label:'Reviewed target instance type',control:'select',default:'m6i.large',options:['m6i','c6i','r6i'].flatMap(family=>['large','xlarge','2xlarge','4xlarge'].map(size=>({value:family+'.'+size,label:family+'.'+size})))},
    {id:'profile',label:'Expected target instance-profile ARN',control:'text',hint:'Optional; blank requires no instance profile. Trust/permissions and licensing remain owner prerequisites.'},
  ],
  build(values):ReturnType<typeof awsServiceModule>{
    const findings:Finding[]=[],reject=(path:string,message:string)=>findings.push(error('aws.drs.'+path,message,{path}));
    const region=String(values.aws_region??''),partition=awsServicePartition(region),name=String(values.name??'').trim(),mode=String(values.mode??''),source=String(values.source??'').trim(),snapshot=String(values.snapshot??'').trim(),age=Number(values.age),template=String(values.template??'').trim(),version=Number(values.version),subnet=String(values.subnet??'').trim(),staging=String(values.staging??'').trim(),kms=String(values.kms??'').trim(),instance=String(values.instance??''),profile=String(values.profile??'').trim();
    const match=/^arn:([^:]+):drs:([^:]+):(\d{12}):source-server\/(s-[0-9A-Za-z]{17})$/.exec(source),account=match?.[3]??'',sourceID=match?.[4]??'';
    if(!match||match[1]!==partition||match[2]!==region)reject('source','Use the exact existing DRS source-server ARN in this partition/region.');
    if(!regions.includes(region))reject('aws_region','This workflow supports the four US commercial and two GovCloud DRS FIPS regions.');
    if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{1,119}$/.test(name))reject('name','Use2–120letters, digits, dots, underscores or hyphens.');
    if(!['DRILL','RECOVERY'].includes(mode))reject('mode','Choose a drill or production recovery.');
    if(!/^pit-[0-9A-Za-z]{17}$/.test(snapshot))reject('snapshot','Use the selected pit-17character recovery snapshot ID.');
    if(![1,6,12,24,72,168,720].includes(age))reject('age','Select the accepted recovery-point age bound.');
    if(!/^lt-[0-9a-f]{17}$/.test(template))reject('template','Use the existing per-source launch-template ID.');
    if(!Number.isSafeInteger(version)||version<1)reject('version','Use a positive reviewed default version.');
    for(const [path,value]of [['subnet',subnet],['staging',staging]])if(!/^subnet-[0-9a-f]{17}$/.test(value!))reject(path!,'Use an existing private subnet ID.');
    const list=(key:string)=>[...new Set(String(values[key]??'').split(',').map(value=>value.trim()).filter(Boolean))],groups=list('groups'),stagingGroups=list('staging_groups');
    for(const [path,items]of [['groups',groups],['staging_groups',stagingGroups]] as const)if(!items.length||items.length>5||items.some(value=>!/^sg-[0-9a-f]{17}$/.test(value)))reject(path,'Use1–5 existing security group IDs.');
    if(!kms.startsWith('arn:'+partition+':kms:'+region+':'+account+':key/')||!/^arn:[^:]+:kms:[^:]+:\d{12}:key\/[0-9a-f-]+$/.test(kms))reject('kms','Use the existing selected account/regional customer key ARN.');
    if(!/^(m6i|c6i|r6i)\.(large|xlarge|2xlarge|4xlarge)$/.test(instance))reject('instance','Choose a reviewed supported target instance.');
    if(profile&&(!profile.startsWith('arn:'+partition+':iam::'+account+':instance-profile/')||!/^arn:[^:]+:iam::\d{12}:instance-profile\/[A-Za-z0-9+=,.@_/-]+$/.test(profile)))reject('profile','Use an existing instance-profile ARN in this account or blank.');
    const config={region,partition,name,mode,source,sourceID,snapshot,age,template,version,subnet,staging,groups,stagingGroups,kms,instance,profile,account};
    const result=awsServiceModule(region,[dat('aws_caller_identity','current',{}),dat('aws_subnet','target',{id:subnet}),dat('aws_subnet','staging',{id:staging}),dat('aws_security_group','selected',{for_each:x('toset('+JSON.stringify([...new Set([...groups,...stagingGroups])])+')'),id:x('each.value')}),dat('aws_kms_key','selected',{key_id:kms}),
      res('terraform_data','reviewed',{input:x(hcl({name,source,snapshot,mode,template,version}))},[blk('lifecycle',{},[blk('precondition',{condition:x('data.aws_caller_identity.current.account_id == '+JSON.stringify(account)+' && data.aws_subnet.target.owner_id == data.aws_caller_identity.current.account_id && data.aws_subnet.staging.owner_id == data.aws_caller_identity.current.account_id && data.aws_subnet.target.vpc_id == data.aws_subnet.staging.vpc_id && !data.aws_subnet.target.map_public_ip_on_launch && !data.aws_subnet.staging.map_public_ip_on_launch && !data.aws_subnet.target.ipv6_native && !data.aws_subnet.staging.ipv6_native && data.aws_subnet.target.available_ip_address_count >= 4 && data.aws_subnet.staging.available_ip_address_count >= 4 && alltrue([for group in data.aws_security_group.selected : split(":", group.arn)[4] == data.aws_caller_identity.current.account_id && group.vpc_id == data.aws_subnet.target.vpc_id]) && data.aws_kms_key.selected.arn == '+JSON.stringify(kms)+' && data.aws_kms_key.selected.enabled && data.aws_kms_key.selected.key_spec == "SYMMETRIC_DEFAULT" && data.aws_kms_key.selected.key_usage == "ENCRYPT_DECRYPT" && data.aws_kms_key.selected.key_manager == "CUSTOMER"'),error_message:'Require this account, private owned same-VPC IPv4 staging/target with free IPs, approved groups and selected enabled customer key.'})])]),
    ],GUIDE,findings);
    return {...result,files:{...result.files,'versions.tf':result.files['versions.tf']!.replace('terraform {','terraform {\n  required_version = ">= 1.4.0"'),'RECOVERY-CONFIG.json':JSON.stringify(config,null,2)+'\n','OPERATE.py':SCRIPT}};
  },
} satisfies Blueprint;

const SCRIPT=[
  'import argparse, datetime, json, pathlib, re',
  'import boto3',
  'from botocore.config import Config',
  'parser=argparse.ArgumentParser(description="Inspect one existing DRS source/PIT by default; one explicitly confirmed drill/recovery launch")',
  'mode=parser.add_mutually_exclusive_group(); mode.add_argument("--launch",action="store_true"); mode.add_argument("--job")',
  'parser.add_argument("--check-target",action="store_true")',
  'for flag in ["--confirm-launch","--confirm-recovery-point","--confirm-isolation","--confirm-incident","--confirm-fencing"]: parser.add_argument(flag,action="store_true")',
  'args=parser.parse_args(); config=json.loads((pathlib.Path(__file__).resolve().parent/"RECOVERY-CONFIG.json").read_text())',
  'if args.check_target and not args.job: parser.error("--check-target requires --job")',
  'session=boto3.Session(region_name=config["region"]); options=Config(retries={"total_max_attempts":1,"mode":"standard"},use_fips_endpoint=True)',
  'if session.client("sts",config=options).get_caller_identity()["Account"]!=config["account"]: raise RuntimeError("Unexpected operator account")',
  'drs=session.client("drs",config=options); ec2=session.client("ec2",config=options); kms=session.client("kms",config=options); drill=config["mode"]=="DRILL"',
  'def checked_job(job):',
  '    servers=job.get("participatingServers",[])',
  '    if job.get("initiatedBy")!=("START_DRILL" if drill else "START_RECOVERY") or job.get("type")!="LAUNCH" or job.get("participatingResources") or len(servers)!=1 or servers[0].get("sourceServerID")!=config["sourceID"]: raise RuntimeError("Require exact one-source job for the selected drill/recovery mode")',
  '    return {"jobID":job.get("jobID"),"status":job.get("status"),"sourceServerID":config["sourceID"],"launchStatus":servers[0].get("launchStatus"),"recoveryInstanceID":servers[0].get("recoveryInstanceID"),"application_acceptance_verified":False,"traffic_changed":False}',
  'def checked_target(report):',
  '    recovery_id=report.get("recoveryInstanceID","")',
  '    if report.get("status")!="COMPLETED" or report.get("launchStatus")!="LAUNCHED" or not re.fullmatch(r"i-[0-9a-f]{17}",recovery_id): raise RuntimeError("Require completed successful launch before target check")',
  '    response=drs.describe_recovery_instances(filters={"recoveryInstanceIDs":[recovery_id]},maxResults=2); items=response.get("items",[])',
  '    if response.get("nextToken") or len(items)!=1: raise RuntimeError("Require exact recovery-instance metadata")',
  '    recovery=items[0]; instance_id=recovery.get("ec2InstanceID","")',
  '    if recovery.get("recoveryInstanceID")!=recovery_id or recovery.get("sourceServerID")!=config["sourceID"] or recovery.get("jobID")!=report["jobID"] or recovery.get("isDrill") is not drill or recovery.get("ec2InstanceState")!=("STOPPED" if drill else "RUNNING") or not re.fullmatch(r"i-[0-9a-f]{17}",instance_id): raise RuntimeError("Recovery instance source/job/mode/state differs")',
  '    response=ec2.describe_instances(InstanceIds=[instance_id]); reservations=response.get("Reservations",[])',
  '    instances=[item for reservation in reservations for item in reservation.get("Instances",[])]',
  '    if response.get("NextToken") or len(reservations)!=1 or reservations[0].get("OwnerId")!=config["account"] or len(instances)!=1 or instances[0].get("InstanceId")!=instance_id: raise RuntimeError("EC2 target identity/ownership differs")',
  '    instance=instances[0]; interfaces=instance.get("NetworkInterfaces",[])',
  '    if instance.get("State",{}).get("Name")!=("stopped" if drill else "running") or instance.get("InstanceType")!=config["instance"] or instance.get("SubnetId")!=config["subnet"] or instance.get("PublicIpAddress") or len(interfaces)!=1 or {item.get("GroupId") for item in instance.get("SecurityGroups",[])}!=set(config["groups"]): raise RuntimeError("EC2 target state/type/private subnet/groups differ")',
  '    nic=interfaces[0]',
  '    if nic.get("SubnetId")!=config["subnet"] or nic.get("Association") or nic.get("Ipv6Addresses") or nic.get("Ipv6Prefixes") or nic.get("Attachment",{}).get("DeviceIndex")!=0 or {item.get("GroupId") for item in nic.get("Groups",[])}!=set(config["groups"]): raise RuntimeError("Actual target NIC differs")',
  '    metadata=instance.get("MetadataOptions",{})',
  '    if metadata.get("State")!="applied" or metadata.get("HttpTokens")!="required" or metadata.get("HttpEndpoint")!="enabled" or metadata.get("HttpPutResponseHopLimit",99)>2 or (instance.get("IamInstanceProfile",{}).get("Arn") or "")!=config["profile"]: raise RuntimeError("Actual target IMDSv2/profile differs")',
  '    if not drill and ec2.describe_instance_attribute(InstanceId=instance_id,Attribute="disableApiTermination").get("DisableApiTermination",{}).get("Value") is not True: raise RuntimeError("Production target termination protection is absent")',
  '    devices=instance.get("BlockDeviceMappings",[]); ids=[item.get("Ebs",{}).get("VolumeId","") for item in devices]',
  '    if not 1<=len(ids)<=60 or len(set(ids))!=len(ids) or any(not re.fullmatch(r"vol-[0-9a-f]{17}",value) for value in ids) or not any(item.get("DeviceName")==instance.get("RootDeviceName") for item in devices): raise RuntimeError("Require unique EBS devices including root")',
  '    response=ec2.describe_volumes(VolumeIds=ids); volumes=response.get("Volumes",[])',
  '    if response.get("NextToken") or len(volumes)!=len(ids) or {item.get("VolumeId") for item in volumes}!=set(ids): raise RuntimeError("Actual target volume inventory differs")',
  '    for volume in volumes:',
  '        attached=volume.get("Attachments",[])',
  '        if volume.get("State")!="in-use" or volume.get("Encrypted") is not True or volume.get("KmsKeyId")!=config["kms"] or len(attached)!=1 or attached[0].get("InstanceId")!=instance_id or attached[0].get("State")!="attached": raise RuntimeError("Actual target EBS key/encryption/attachment differs")',
  '    report.update({"target_metadata_checked":True,"ec2InstanceID":instance_id,"volume_count":len(volumes),"reported_recovery_point_timestamp":recovery.get("pointInTimeSnapshotDateTime"),"selected_pit_and_data_integrity_verified":False})',
  '    return report',
  'if args.job:',
  '    if not re.fullmatch(r"drsjob-[0-9A-Za-z]{17}",args.job): raise RuntimeError("Use the returned DRS job ID")',
  '    response=drs.describe_jobs(filters={"jobIDs":[args.job]},maxResults=2); jobs=response.get("items",[])',
  '    if response.get("nextToken") or len(jobs)!=1 or jobs[0].get("jobID")!=args.job: raise RuntimeError("Job identity differs")',
  '    report=checked_job(jobs[0]); print(json.dumps(checked_target(report) if args.check_target else report)); raise SystemExit(0)',
  'response=drs.describe_source_servers(filters={"sourceServerIDs":[config["sourceID"]]},maxResults=2); items=response.get("items",[])',
  'if response.get("nextToken") or len(items)!=1 or items[0].get("arn")!=config["source"] or items[0].get("sourceServerID")!=config["sourceID"]: raise RuntimeError("Require exact selected source")',
  'source=items[0]; staging=source.get("stagingArea",{})',
  'if source.get("replicationDirection","FAILOVER")!="FAILOVER" or source.get("sourceNetworkID") or source.get("reversedDirectionSourceServerArn") or staging.get("status")!="NOT_EXTENDED" or staging.get("stagingAccountID")!=config["account"] or staging.get("stagingSourceServerArn") or staging.get("errorMessage"): raise RuntimeError("Require same-account nonextended failover source, without network-recovery/failback topology")',
  'if source.get("recoveryInstanceId") or source.get("lastLaunchResult")=="PENDING": raise RuntimeError("Existing recovery instance/pending launch requires owner inspection before another launch")',
  'replication=drs.get_replication_configuration(sourceServerID=config["sourceID"])',
  'if replication.get("sourceServerID")!=config["sourceID"] or replication.get("stagingAreaSubnetId")!=config["staging"] or set(replication.get("replicationServersSecurityGroupsIDs",[]))!=set(config["stagingGroups"]) or replication.get("associateDefaultSecurityGroup") is not False or replication.get("createPublicIP") is not False or replication.get("dataPlaneRouting")!="PRIVATE_IP" or replication.get("ebsEncryption")!="CUSTOM" or replication.get("ebsEncryptionKeyArn")!=config["kms"] or replication.get("internetProtocol","IPV4")!="IPV4": raise RuntimeError("Private staging/groups/encryption/IP settings differ")',
  'launch=drs.get_launch_configuration(sourceServerID=config["sourceID"])',
  'if launch.get("sourceServerID")!=config["sourceID"] or launch.get("ec2LaunchTemplateID")!=config["template"] or launch.get("launchDisposition")!=("STOPPED" if drill else "STARTED") or launch.get("copyPrivateIp") is not False or launch.get("copyTags") is not False or launch.get("postLaunchEnabled") is not False or launch.get("targetInstanceTypeRightSizingMethod")!="NONE" or launch.get("launchIntoInstanceProperties",{}).get("launchIntoEC2InstanceID") or launch.get("recoveryMode")!="OPTIMAL": raise RuntimeError("Require reviewed new-instance optimal recovery, explicit disposition, no copied IP/tags, rightsizing or post-launch actions")',
  'templates=ec2.describe_launch_templates(LaunchTemplateIds=[config["template"]])["LaunchTemplates"]',
  'if len(templates)!=1 or templates[0].get("LaunchTemplateId")!=config["template"] or templates[0].get("DefaultVersionNumber")!=config["version"]: raise RuntimeError("Reviewed default template version changed")',
  'versions=ec2.describe_launch_template_versions(LaunchTemplateId=config["template"],Versions=[str(config["version"])])["LaunchTemplateVersions"]',
  'if len(versions)!=1 or versions[0].get("VersionNumber")!=config["version"]: raise RuntimeError("Reviewed launch version differs")',
  'data=versions[0]["LaunchTemplateData"]; interfaces=data.get("NetworkInterfaces",[])',
  'if data.get("InstanceType")!=config["instance"] or data.get("SecurityGroupIds") or len(interfaces)!=1 or not drill and data.get("DisableApiTermination") is not True: raise RuntimeError("Require exact instance/one explicit NIC and production API termination protection")',
  'nic=interfaces[0]',
  'if nic.get("DeviceIndex")!=0 or nic.get("SubnetId")!=config["subnet"] or set(nic.get("Groups",[]))!=set(config["groups"]) or nic.get("AssociatePublicIpAddress") is not False or nic.get("NetworkInterfaceId") or nic.get("PrivateIpAddress") or nic.get("PrivateIpAddresses") or nic.get("Ipv6Addresses") or nic.get("Ipv6AddressCount",0) or nic.get("Ipv6Prefixes") or nic.get("Ipv6PrefixCount",0): raise RuntimeError("Require fresh approved private IPv4 target NIC, no copied/fixed address")',
  'metadata=data.get("MetadataOptions",{}); profile=data.get("IamInstanceProfile",{})',
  'if metadata.get("HttpTokens")!="required" or metadata.get("HttpEndpoint")!="enabled" or metadata.get("HttpPutResponseHopLimit",99)>2 or (profile.get("Arn") or "")!=config["profile"] or profile.get("Name"): raise RuntimeError("IMDSv2/profile differs")',
  'subnets=ec2.describe_subnets(SubnetIds=sorted(set([config["subnet"],config["staging"]])))["Subnets"]',
  'if {item.get("SubnetId") for item in subnets}!=set([config["subnet"],config["staging"]]) or len({item.get("VpcId") for item in subnets})!=1 or any(item.get("OwnerId")!=config["account"] or item.get("MapPublicIpOnLaunch") or item.get("Ipv6Native") or item.get("AssignIpv6AddressOnCreation") or item.get("AvailableIpAddressCount",0)<4 for item in subnets): raise RuntimeError("Require exact owned same-VPC private IPv4 subnets/free IPs")',
  'groups=ec2.describe_security_groups(GroupIds=sorted(set(config["groups"]+config["stagingGroups"])))["SecurityGroups"]',
  'if {item.get("GroupId") for item in groups}!=set(config["groups"]+config["stagingGroups"]) or any(item.get("OwnerId")!=config["account"] or item.get("VpcId")!=subnets[0]["VpcId"] for item in groups): raise RuntimeError("Selected security group ownership/VPC differs")',
  'key=kms.describe_key(KeyId=config["kms"])["KeyMetadata"]',
  'if key.get("Arn")!=config["kms"] or key.get("KeyState")!="Enabled" or key.get("KeySpec")!="SYMMETRIC_DEFAULT" or key.get("KeyUsage")!="ENCRYPT_DECRYPT" or key.get("KeyManager")!="CUSTOMER": raise RuntimeError("Require exact enabled symmetric customer key")',
  'if ec2.get_ebs_encryption_by_default().get("EbsEncryptionByDefault") is not True or ec2.get_ebs_default_kms_key_id().get("KmsKeyId")!=config["kms"]: raise RuntimeError("Require reviewed matching EBS defaults; no shared defaults are changed")',
  'for device in data.get("BlockDeviceMappings",[]):',
  '    ebs=device.get("Ebs")',
  '    if ebs and (ebs.get("Encrypted") is False or ebs.get("KmsKeyId") not in [None,config["kms"]]): raise RuntimeError("Template overrides target encryption/key")',
  'selected=[]; token=None; seen=set()',
  'for page in range(20):',
  '    response=drs.describe_recovery_snapshots(sourceServerID=config["sourceID"],order="DESC",maxResults=100,**({"nextToken":token} if token else {}))',
  '    selected.extend(item for item in response.get("items",[]) if item.get("snapshotID")==config["snapshot"])',
  '    token=response.get("nextToken")',
  '    if not token: break',
  '    if token in seen: raise RuntimeError("Repeated snapshot page; inspect history")',
  '    seen.add(token)',
  'else: raise RuntimeError("Snapshot history bound exceeded; inspect the selected point explicitly")',
  'if len(selected)!=1 or selected[0].get("sourceServerID")!=config["sourceID"]: raise RuntimeError("Selected recovery point identity differs or expired; no fallback")',
  'snapshot=selected[0]; timestamp=snapshot.get("timestamp","")',
  'if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,6})?Z",timestamp): raise RuntimeError("Require actual completed PIT timestamp, not expectedTimestamp alone")',
  'age=(datetime.datetime.now(datetime.timezone.utc)-datetime.datetime.fromisoformat(timestamp.replace("Z","+00:00"))).total_seconds()',
  'if not 0<=age<=config["age"]*3600: raise RuntimeError("Selected actual recovery point is future-dated or older than accepted bound")',
  'ids=snapshot.get("ebsSnapshots",[])',
  'if not 1<=len(ids)<=60 or len(set(ids))!=len(ids) or any(not re.fullmatch(r"snap-[0-9a-f]{17}",value) for value in ids): raise RuntimeError("Require exact unique bounded EBS snapshot members")',
  'response=ec2.describe_snapshots(SnapshotIds=ids,OwnerIds=[config["account"]]); snapshots=response.get("Snapshots",[])',
  'if response.get("NextToken") or len(snapshots)!=len(ids) or {item.get("SnapshotId") for item in snapshots}!=set(ids) or any(item.get("OwnerId")!=config["account"] or item.get("State")!="completed" or item.get("Encrypted") is not True or item.get("KmsKeyId")!=config["kms"] for item in snapshots): raise RuntimeError("Recovery snapshot member ownership/readiness/encryption differs")',
  'report={"metadata_checked":True,"sourceServerID":config["sourceID"],"snapshotID":config["snapshot"],"actual_snapshot_timestamp":timestamp,"snapshot_age_seconds":round(age),"source_replication_state":source.get("dataReplicationInfo",{}).get("dataReplicationState"),"launch_requested":False,"application_consistency_verified":False}',
  'if not args.launch: print(json.dumps(report)); raise SystemExit(0)',
  'if not (args.confirm_launch and args.confirm_recovery_point) or drill and not args.confirm_isolation or not drill and not (args.confirm_incident and args.confirm_fencing): raise RuntimeError("Launch requires explicit launch/recovery-point acceptance and isolated-drill OR incident/source-fencing confirmations")',
  'job=drs.start_recovery(isDrill=drill,sourceServers=[{"sourceServerID":config["sourceID"],"recoverySnapshotID":config["snapshot"]}])["job"]',
  'if not re.fullmatch(r"drsjob-[0-9A-Za-z]{17}",job.get("jobID","")): raise RuntimeError("Ambiguous receipt: inspect source/history before any repeat")',
  'if job.get("initiatedBy")!=("START_DRILL" if drill else "START_RECOVERY") or job.get("type")!="LAUNCH" or job.get("participatingResources"): raise RuntimeError("Unexpected launch receipt kind; inspect history before any repeat")',
  'receipt=checked_job(job) if job.get("participatingServers") else {"jobID":job["jobID"],"sourceServerID":config["sourceID"],"membership_pending":True}',
  'receipt.update({"request_accepted":True,"completion_verified":False,"snapshotID":config["snapshot"],"actual_snapshot_timestamp":timestamp}); print(json.dumps(receipt))',
].join('\n')+'\n';

const GUIDE=`# One-source DRS point-in-time drill or recovery

Terraform1.4+ reads existing network/key metadata and stores a LOCAL terraform_data review record; it creates no AWS infrastructure. Python3/current boto3 OPERATE.py inspects by default. Only --launch with separate confirmations sends ONE StartRecovery. Existing native replication-template builders and MGN migration pilot/cutover workflows remain separate. This workflow does not initialize DRS, install agents, change source/template/defaults, enroll accounts, create recovery networks, launch into an existing instance, start failback/reversed replication, terminate instances, switch traffic or decommission sources. Same-account nonextended FAILOVER source/private target and staging VPC, OPTIMAL/new-instance mode, selected existing PIT and no post-launch actions/copy IP/tags/right sizing. Four US commercial/two GovCloud FIPS-API regions; GovCloud VPC and applicable agent/data-plane requirements still need independent verification. FIPS API selection is not proof of agent/data-plane encryption, CMVP certification or an ATO.

1. Prepare owner-approved DRS enrollment/service roles, agent/OS/boot/disk support, source permissions/licensing, staging network/replication ports/bandwidth, storage/instance/DRS quotas and costs. Verify source replication/PIT policy and tested backup/restore. Record exact source ARN and existing pit-ID. Authorize civilian/DoD/State classification, source/destination and replication/log/metadata/key/snapshot/backup/support boundaries, SSP/ATO/APL/CDM/DoDIN/STIG/SRG/CMVP/residency/privacy/records evidence. No product/region alone provides approval. Keep sensitive data out of names/tags. Protect exports/config/state/receipts.
2. Select isolated stopped DRILL or production RECOVERY. Have owners review exact per-source DRS launch configuration/template/default version, private target subnet/SG access, instance sizing/profile/OS/BYOL, IMDSv2 and all inherited user data/bootstrap/other template fields. Helpers never print user data. DRILL requires STOPPED disposition/isolation; RECOVERY requires STARTED and API termination protection, incident authority, source fencing to prevent split brain and accepted data loss/recovery consistency risk. Starting production OS can run installed applications/user data immediately. No application consistency is inferred from block snapshots, age, lag or a successful API call.
3. Require private IPv4 staging/no default extra SG, exact selected symmetric customer key, reviewed matching account EBS encryption defaults and actual compatible snapshot members. Key policies/service roles/grants/profile permissions and routes/NACLs/SG rules need independent review; no shared setting is changed. Recovery from a selected point may be possible while the source is disconnected/offline: this helper intentionally does not require current CONTINUOUS replication. Its source status is reported, not mistaken for data freshness. Last pending launch or an existing recovery instance blocks a fresh launch until owners safely inspect it.
4. Run terraform init/validate/plan and review/apply the LOCAL record only. Then python OPERATE.py. It checks source/staging/launch/template/key/EBS/network metadata, paginated exact PIT selection and actual timestamp, accepted maximum age, unique completed encrypted same-account EBS snapshot members. expectedTimestamp alone is not completion. No implicit latest/on-demand point, alternate snapshot fallback or data/key-content access occurs. Metadata cannot prove application consistency, OS boot, effective IAM, actual data-plane crypto or recovery success. Inspect the reported actual timestamp with the incident/data owner against actual RPO and corruption/ransomware timelines; a recent point is not necessarily a safe point.
5. For the isolated stopped drill run python OPERATE.py --launch --confirm-launch --confirm-recovery-point --confirm-isolation. For authorized production run python OPERATE.py --launch --confirm-launch --confirm-recovery-point --confirm-incident --confirm-fencing. Flags are attestations, not measured evidence. Sends StartRecovery for only this source AND exact PIT ID, with isDrill true/false and SDK retries disabled. STOPPED still creates conversion/recovery resources and costs. Reads and launch are not atomic; no client-token deduplication. After timeout/error/ambiguous receipt inspect exact source/job history before any repeat; do not blindly retry.
6. Save receipt/PIT timestamp/job ID and run python OPERATE.py --job <job-id>. Only one-source LAUNCH START_DRILL or START_RECOVERY matching this package mode is accepted; no network resources may be participants. Receipt/job completion alone is not application acceptance or actual-target encryption evidence. After COMPLETED/LAUNCHED run python OPERATE.py --job <job-id> --check-target. It checks exact recovery-instance source/job/isDrill/state and EC2 ID, actual private NIC/groups/IMDSv2/profile, production termination protection and EVERY attached EBS volume's selected key/attachment. The reported recovery-point timestamp must still be independently reconciled to the saved selected-PIT receipt and application integrity record; the target checker explicitly does not prove PIT/data integrity. It does not read disk contents. Boot an isolated stopped drill only through approved owner procedures and test OS, application/dependencies, integrity, performance, backup/restore, monitoring and security evidence before accepting readiness. Production target tests, authoritative-writer fencing and client/DNS/route changes need incident/change authority and a separate application runbook.
7. Recovery rollback/failback is not deleting the target or reversing an API. Freeze/fence writers and reconcile/recover new target writes before returning clients to a source; an old source can be stale. Reversed replication/failback can write to the original environment and requires its own scoped owner-tested plan, infrastructure/credential/data authorization and recovery checkpoints. Protect and retain chosen PIT/snapshots/keys/logs/evidence as policy requires. No automatic termination, source disconnect/agent removal, instance cleanup or network/data rollback is generated. Record drill findings, RPO/RTO, owner acceptance and outstanding controls; local code/tests do not prove disaster readiness.

https://docs.aws.amazon.com/drs/latest/APIReference/API_StartRecovery.html
https://docs.aws.amazon.com/drs/latest/APIReference/API_SourceServer.html
https://docs.aws.amazon.com/drs/latest/APIReference/API_RecoverySnapshot.html
https://docs.aws.amazon.com/drs/latest/APIReference/API_GetLaunchConfiguration.html
https://docs.aws.amazon.com/drs/latest/APIReference/API_GetReplicationConfiguration.html
https://docs.aws.amazon.com/govcloud-us/latest/UserGuide/govcloud-drs.html
`;
