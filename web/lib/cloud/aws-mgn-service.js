                                                     
import { error,              } from '../core/findings.js';
import { blk, dat, hcl, res, x } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.js';
const regions='us-east-2 us-east-1 us-west-1 us-west-2 af-south-1 ap-east-1 ap-south-2 ap-southeast-3 ap-southeast-5 ap-southeast-4 ap-south-1 ap-southeast-6 ap-northeast-3 ap-northeast-2 ap-southeast-1 ap-southeast-2 ap-east-2 ap-southeast-7 ap-northeast-1 ca-central-1 ca-west-1 eu-central-1 eu-west-1 eu-west-2 eu-south-1 eu-west-3 eu-south-2 eu-north-1 eu-central-2 il-central-1 mx-central-1 me-south-1 me-central-1 sa-east-1 us-gov-east-1 us-gov-west-1'.split(' ');
const fipsRegions=['us-east-1','us-east-2','us-west-1','us-west-2','us-gov-east-1','us-gov-west-1'];

export const AWS_MGN_SERVICE={
  id:'aws_service_mgn_pilot',label:'Inspect and test one already-replicating MGN server',
  description:'Validate an existing agent-based source and its reviewed private per-source launch settings, then explicitly request one stopped test launch. No account defaults, agent enrollment or cutover changes.',
  emits:['terraform_data'],
  inputs:[
    awsServiceRegion,{id:'name',label:'Pilot name',control:'text'},
    {id:'source',label:'Existing MGN source-server ARN',control:'text',hint:'One already enrolled agent-based source in the deployment account/region. This recipe does not install the replication agent.'},
    {id:'template',label:'Existing per-source EC2 launch template ID',control:'text',hint:'Read this from the selected source launch settings; not the account-level MGN template.'},
    {id:'version',label:'Reviewed default launch-template version',control:'number',default:1},
    {id:'subnet',label:'Existing private test subnet ID',control:'text'},
    {id:'groups',label:'Existing test security group IDs',control:'text',hint:'Comma-separated approved isolated test groups in that subnet VPC. The actual launch template must use exactly these groups.'},
    {id:'staging',label:'Existing private staging subnet ID',control:'text',hint:'This bounded path uses private staging and test subnets in the same VPC.'},
    {id:'staging_groups',label:'Existing replication security group IDs',control:'text'},
    {id:'kms',label:'Existing staging/target customer KMS key ARN',control:'text',hint:'Require this enabled symmetric regional key on source replication settings and the account EBS default. This workflow does not change shared encryption settings.'},
    {id:'instance',label:'Reviewed target instance type',control:'select',default:'m6i.large',options:['m6i','c6i','r6i'].flatMap(family=>['large','xlarge','2xlarge','4xlarge'].map(size=>({value:family+'.'+size,label:family+'.'+size})))},
    {id:'profile',label:'Expected target instance-profile ARN',control:'text',hint:'Optional. Blank requires no instance profile in the reviewed template. Role permissions/trust are separate owner prerequisites.'},
    {id:'endpoint',label:'MGN API endpoint',control:'select',default:'AUTO',options:[{value:'AUTO',label:'FIPS where published; standard elsewhere'},{value:'FIPS',label:'FIPS — supported US regions only'},{value:'STANDARD',label:'Standard — commercial regions only'}]},
    {id:'lag',label:'Maximum accepted replication lag (seconds)',control:'number',default:60,hint:'Metadata readiness bound, not application consistency or a guaranteed RPO.'},
  ],
  build(values)                                    {
    const findings          =[],reject=(path       ,message       )=>findings.push(error('aws.mgn.'+path,message,{path}));
    const region=String(values.aws_region??''),partition=awsServicePartition(region),name=String(values.name??'').trim(),source=String(values.source??'').trim(),template=String(values.template??'').trim(),version=Number(values.version),subnet=String(values.subnet??'').trim(),staging=String(values.staging??'').trim(),kms=String(values.kms??'').trim(),instance=String(values.instance??''),profile=String(values.profile??'').trim(),endpoint=String(values.endpoint??''),lag=Number(values.lag);
    const sourceMatch=/^arn:([^:]+):mgn:([^:]+):(\d{12}):source-server\/(s-[0-9A-Za-z]{17})$/.exec(source),account=sourceMatch?.[3]??'',sourceID=sourceMatch?.[4]??'';
    if(!sourceMatch||sourceMatch[1]!==partition||sourceMatch[2]!==region)reject('source','Enter one existing source-server ARN in the selected partition/region.');
    if(!regions.includes(region))reject('aws_region','Select a published MGN region supported by this recipe.');
    if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{1,119}$/.test(name))reject('name','Use 2–120 letters, digits, dots, underscores or hyphens.');
    if(!/^lt-[0-9a-f]{17}$/.test(template))reject('template','Enter the selected source EC2 launch-template ID.');
    if(!Number.isSafeInteger(version)||version<1)reject('version','Enter the positive reviewed default version number.');
    for(const [key,value] of [['subnet',subnet],['staging',staging]]         )if(!/^subnet-(?:[0-9a-f]{8}|[0-9a-f]{17})$/.test(value))reject(key,'Enter an existing private subnet ID.');
    const list=(key       )=>[...new Set(String(values[key]??'').split(',').map(value=>value.trim()).filter(Boolean))],groups=list('groups'),stagingGroups=list('staging_groups');
    for(const [key,items]of [['groups',groups],['staging_groups',stagingGroups]]        )if(!items.length||items.length>5||items.some(item=>!/^sg-(?:[0-9a-f]{8}|[0-9a-f]{17})$/.test(item)))reject(key,'Enter 1–5 existing approved security group IDs.');
    if(!kms.startsWith('arn:'+partition+':kms:'+region+':'+account+':key/')||!/^arn:[^:]+:kms:[^:]+:\d{12}:key\/[0-9a-f-]+$/.test(kms))reject('kms','Use the existing regional customer-key ARN in the source account.');
    if(!/^(?:m6i|c6i|r6i)\.(?:large|xlarge|2xlarge|4xlarge)$/.test(instance))reject('instance','Select a supported x86 test instance type.');
    if(profile&&(!profile.startsWith('arn:'+partition+':iam::'+account+':instance-profile/')||!/^arn:[^:]+:iam::\d{12}:instance-profile\/[A-Za-z0-9+=,.@_/-]+$/.test(profile)))reject('profile','Use the approved instance-profile ARN in this account or leave blank.');
    const fips=endpoint==='FIPS'||endpoint==='AUTO'&&fipsRegions.includes(region);
    if(!['AUTO','FIPS','STANDARD'].includes(endpoint)||fips&&!fipsRegions.includes(region)||partition==='aws-us-gov'&&!fips)reject('endpoint','Use a published endpoint; this GovCloud recipe requires FIPS.');
    if(!Number.isInteger(lag)||lag<1||lag>3600)reject('lag','Use an accepted metadata lag bound from 1 to 3600 seconds.');
    const config={region,partition,name,source,sourceID,account,template,version,subnet,groups,staging,stagingGroups,kms,instance,profile,fips,lag};
    const result=awsServiceModule(region,[
      dat('aws_caller_identity','current',{}),dat('aws_subnet','target',{id:subnet}),dat('aws_subnet','staging',{id:staging}),
      dat('aws_security_group','selected',{for_each:x('toset('+JSON.stringify([...new Set([...groups,...stagingGroups])])+')'),id:x('each.value')}),dat('aws_kms_key','selected',{key_id:kms}),
      res('terraform_data','reviewed',{input:x(hcl({name,source,template,version}))},[blk('lifecycle',{},[blk('precondition',{condition:x('data.aws_caller_identity.current.account_id == '+JSON.stringify(account)+' && data.aws_subnet.target.owner_id == data.aws_caller_identity.current.account_id && data.aws_subnet.staging.owner_id == data.aws_caller_identity.current.account_id && data.aws_subnet.target.vpc_id == data.aws_subnet.staging.vpc_id && !data.aws_subnet.target.map_public_ip_on_launch && !data.aws_subnet.staging.map_public_ip_on_launch && data.aws_subnet.target.available_ip_address_count >= 4 && alltrue([for group in data.aws_security_group.selected : split(":", group.arn)[4] == data.aws_caller_identity.current.account_id && group.vpc_id == data.aws_subnet.target.vpc_id]) && data.aws_kms_key.selected.arn == '+JSON.stringify(kms)+' && data.aws_kms_key.selected.enabled && data.aws_kms_key.selected.key_usage == "ENCRYPT_DECRYPT" && data.aws_kms_key.selected.key_spec == "SYMMETRIC_DEFAULT" && data.aws_kms_key.selected.key_manager == "CUSTOMER"'),error_message:'Require this account private same-VPC staging/test network, approved groups, free target IPs and enabled symmetric customer key.'})])]),
    ],GUIDE,findings);
    return{...result,files:{...result.files,'versions.tf':result.files['versions.tf'] .replace('terraform {','terraform {\n  required_version = ">= 1.4.0"'),'PILOT-CONFIG.json':JSON.stringify(config,null,2)+'\n','OPERATE.py':SCRIPT}};
  },
}                   ;

const SCRIPT=mgnOperator();
/** Shared read-only preflight; mutations remain explicit and mode-specific. */
export function mgnOperator(cutover=false)        { return [
  'import argparse, json, pathlib, re',
  'import boto3',
  'from botocore.config import Config',
  'parser=argparse.ArgumentParser(description="Inspect selected MGN source by default; explicit '+(cutover?'production cutover':'stopped test')+' launch only")',
  'mode=parser.add_mutually_exclusive_group(); mode.add_argument("--'+(cutover?'cutover':'test')+'",action="store_true"); mode.add_argument("--job")',
  ...(cutover?['parser.add_argument("--confirm-write-freeze",action="store_true"); parser.add_argument("--confirm-backup",action="store_true"); parser.add_argument("--confirm-acceptance",action="store_true")']:[]),
  'parser.add_argument("--confirm-launch",action="store_true"); args=parser.parse_args()',
  'config=json.loads((pathlib.Path(__file__).resolve().parent/"'+(cutover?'CUTOVER':'PILOT')+'-CONFIG.json").read_text())',
  'session=boto3.Session(region_name=config["region"])',
  'client_config=Config(retries={"total_max_attempts":1,"mode":"standard"},use_fips_endpoint=config["fips"])',
  'if session.client("sts",config=client_config).get_caller_identity()["Account"]!=config["account"]: raise RuntimeError("Unexpected operator account")',
  'mgn=session.client("mgn",config=client_config); ec2=session.client("ec2",config=client_config)',
  'def checked_job(job):',
  '    servers=job.get("participatingServers",[])',
  '    if job.get("initiatedBy")!="'+(cutover?'START_CUTOVER':'START_TEST')+'" or job.get("type")!="LAUNCH" or len(servers)!=1 or servers[0].get("sourceServerID")!=config["sourceID"]: raise RuntimeError("Job does not belong only to this selected source '+(cutover?'cutover':'test')+'")',
  '    return {"jobID":job.get("jobID"),"status":job.get("status"),"sourceServerID":config["sourceID"],"launchStatus":servers[0].get("launchStatus"),"launchedEc2InstanceID":servers[0].get("launchedEc2InstanceID"),"application_acceptance_verified":False}',
  'if args.job:',
  '    if not re.fullmatch(r"mgnjob-[0-9A-Za-z]{17}",args.job): raise RuntimeError("Enter the returned MGN job ID")',
  '    response=mgn.describe_jobs(filters={"jobIDs":[args.job]},maxResults=2)',
  '    if response.get("nextToken") or len(response.get("items",[]))!=1 or response["items"][0].get("jobID")!=args.job: raise RuntimeError("Job identity differs")',
  '    print(json.dumps(checked_job(response["items"][0]))); raise SystemExit(0)',
  'response=mgn.describe_source_servers(filters={"sourceServerIDs":[config["sourceID"]]},maxResults=2)',
  'if response.get("nextToken") or len(response.get("items",[]))!=1: raise RuntimeError("Require one exact source")',
  'source=response["items"][0]',
  'if source.get("arn")!=config["source"] or source.get("sourceServerID")!=config["sourceID"] or source.get("isArchived") or source.get("replicationType")!="AGENT_BASED": raise RuntimeError("Require the exact active agent-based source")',
  'replication=mgn.get_replication_configuration(sourceServerID=config["sourceID"])',
  'if replication.get("sourceServerID")!=config["sourceID"] or replication.get("stagingAreaSubnetId")!=config["staging"] or set(replication.get("replicationServersSecurityGroupsIDs",[]))!=set(config["stagingGroups"]) or replication.get("createPublicIP") is not False or replication.get("dataPlaneRouting")!="PRIVATE_IP" or replication.get("ebsEncryption")!="CUSTOM" or replication.get("ebsEncryptionKeyArn")!=config["kms"] or bool(replication.get("useFipsEndpoint",False))!=config["fips"]: raise RuntimeError("Replication placement/encryption/endpoints differ")',
  'if replication.get("storageConfiguration",{}).get("storageType") not in [None,"EBS"] or replication.get("internetProtocol") not in [None,"IPV4"]: raise RuntimeError("This pilot supports IPv4/EBS staging only")',
  'launch=mgn.get_launch_configuration(sourceServerID=config["sourceID"])',
  'if launch.get("sourceServerID")!=config["sourceID"] or launch.get("ec2LaunchTemplateID")!=config["template"] or launch.get("launchDisposition")!="'+(cutover?'STARTED':'STOPPED')+'" or launch.get("copyPrivateIp") is not False or launch.get("targetInstanceTypeRightSizingMethod")!="NONE" or launch.get("postLaunchActions",{}).get("ssmDocuments"): raise RuntimeError("Require exact '+(cutover?'started':'stopped')+', non-rightsized per-source launch without copied private IP or post-launch documents")',
  'actions=mgn.list_source_server_actions(sourceServerID=config["sourceID"],maxResults=1000)',
  'if actions.get("nextToken") or any(item.get("active") is not False for item in actions.get("items",[])): raise RuntimeError("Disable/review source post-migration actions before this bounded pilot")',
  'templates=ec2.describe_launch_templates(LaunchTemplateIds=[config["template"]])["LaunchTemplates"]',
  'if len(templates)!=1 or templates[0].get("LaunchTemplateId")!=config["template"] or templates[0].get("DefaultVersionNumber")!=config["version"]: raise RuntimeError("Reviewed default launch version changed")',
  'versions=ec2.describe_launch_template_versions(LaunchTemplateId=config["template"],Versions=[str(config["version"])])["LaunchTemplateVersions"]',
  'if len(versions)!=1 or versions[0].get("VersionNumber")!=config["version"]: raise RuntimeError("Launch version differs")',
  'data=versions[0]["LaunchTemplateData"]; interfaces=data.get("NetworkInterfaces",[])',
  ...(cutover?['if data.get("DisableApiTermination") is not True: raise RuntimeError("Production template must enable API termination protection")']:[]),
  'if data.get("InstanceType")!=config["instance"] or data.get("SecurityGroupIds") or len(interfaces)!=1: raise RuntimeError("Require exact instance type and one explicit private NIC")',
  'nic=interfaces[0]',
  'if nic.get("DeviceIndex")!=0 or nic.get("SubnetId")!=config["subnet"] or set(nic.get("Groups",[]))!=set(config["groups"]) or nic.get("AssociatePublicIpAddress") is not False or nic.get("NetworkInterfaceId") or nic.get("PrivateIpAddress") or nic.get("PrivateIpAddresses") or nic.get("Ipv6Addresses") or nic.get("Ipv6AddressCount",0) or nic.get("Ipv6Prefixes") or nic.get("Ipv6PrefixCount",0): raise RuntimeError("Launch network differs; do not reuse live NICs/private IPs or assign public/IPv6 addresses")',
  'metadata=data.get("MetadataOptions",{})',
  'if metadata.get("HttpTokens")!="required" or metadata.get("HttpEndpoint")!="enabled" or metadata.get("HttpPutResponseHopLimit",99)>2: raise RuntimeError("Require reviewed IMDSv2 endpoint/hop limit")',
  'actual_profile=data.get("IamInstanceProfile",{})',
  'if (actual_profile.get("Arn") or "")!=config["profile"] or actual_profile.get("Name"): raise RuntimeError("Expected exact instance profile ARN or none")',
  'subnets=ec2.describe_subnets(SubnetIds=list(set([config["subnet"],config["staging"]])))["Subnets"]',
  'if {item.get("SubnetId") for item in subnets}!=set([config["subnet"],config["staging"]]) or len({item.get("VpcId") for item in subnets})!=1 or any(item.get("OwnerId")!=config["account"] or item.get("MapPublicIpOnLaunch") or item.get("Ipv6Native") or item.get("AssignIpv6AddressOnCreation") or item.get("AvailableIpAddressCount",0)<4 for item in subnets): raise RuntimeError("Require exact owned private same-VPC IPv4 subnets with free IPs and no automatic IPv6")',
  'groups=ec2.describe_security_groups(GroupIds=sorted(set(config["groups"]+config["stagingGroups"])))["SecurityGroups"]',
  'if {item.get("GroupId") for item in groups}!=set(config["groups"]+config["stagingGroups"]) or any(item.get("OwnerId")!=config["account"] or item.get("VpcId")!=subnets[0]["VpcId"] for item in groups): raise RuntimeError("Approved groups differ in account/VPC")',
  'key=session.client("kms",config=client_config).describe_key(KeyId=config["kms"])["KeyMetadata"]',
  'if key.get("Arn")!=config["kms"] or key.get("KeyState")!="Enabled" or key.get("KeySpec")!="SYMMETRIC_DEFAULT" or key.get("KeyUsage")!="ENCRYPT_DECRYPT" or key.get("KeyManager")!="CUSTOMER": raise RuntimeError("Require exact enabled symmetric customer key")',
  'if ec2.get_ebs_encryption_by_default().get("EbsEncryptionByDefault") is not True or ec2.get_ebs_default_kms_key_id().get("KmsKeyId")!=config["kms"]: raise RuntimeError("Require reviewed EBS account defaults; this script does not change shared encryption")',
  'for device in data.get("BlockDeviceMappings",[]):',
  '    ebs=device.get("Ebs")',
  '    if ebs and (ebs.get("Encrypted") is False or ebs.get("KmsKeyId") not in [None,config["kms"]]): raise RuntimeError("Launch device overrides encryption/key")',
  'if not args.'+(cutover?'cutover':'test')+': print(json.dumps({"metadata_checked":True,"sourceServerID":config["sourceID"],"lifecycle":source.get("lifeCycle",{}).get("state"),"replication":source.get("dataReplicationInfo",{}).get("dataReplicationState"),"launch_requested":False})); raise SystemExit(0)',
  cutover?'if not (args.confirm_launch and args.confirm_write_freeze and args.confirm_backup and args.confirm_acceptance): raise RuntimeError("Cutover requires explicit launch, source-writer freeze/final sync, tested recovery backup and pilot acceptance confirmations")':'if not args.confirm_launch: raise RuntimeError("Test requires --confirm-launch after approved isolated pilot, cost, licensing and source-consistency review")',
  'replicated=source.get("dataReplicationInfo",{}); lag=re.fullmatch(r"PT(?:(\\d+(?:\\.\\d+)?)H)?(?:(\\d+(?:\\.\\d+)?)M)?(?:(\\d+(?:\\.\\d+)?)S)?",replicated.get("lagDuration",""))',
  'if source.get("lifeCycle",{}).get("state")!="'+(cutover?'READY_FOR_CUTOVER':'READY_FOR_TEST')+'" or source.get("launchedInstance",{}).get("ec2InstanceID") or replicated.get("dataReplicationState")!="CONTINUOUS" or replicated.get("dataReplicationError",{}).get("error") or not lag or not any(lag.groups()) or sum(float(value or 0)*scale for value,scale in zip(lag.groups(),[3600,60,1]))>config["lag"]: raise RuntimeError("Require '+(cutover?'READY_FOR_CUTOVER':'READY_FOR_TEST')+', continuous error-free replication within lag bound and no existing launched instance")',
  'job=mgn.'+(cutover?'start_cutover':'start_test')+'(sourceServerIDs=[config["sourceID"]])["job"]',
  'if not re.fullmatch(r"mgnjob-[0-9A-Za-z]{17}",job.get("jobID","")): raise RuntimeError("Unexpected receipt; inspect history before retry")',
  'receipt=checked_job(job) if job.get("participatingServers") else {"jobID":job["jobID"],"sourceServerID":config["sourceID"],"membership_pending":True,"application_acceptance_verified":False}; receipt["request_accepted"]=True; receipt["completion_verified"]=False; print(json.dumps(receipt))',
].join('\n')+'\n'; }

const GUIDE=`# One-source MGN stopped test pilot

This bounded package inspects and explicitly tests an existing agent-based MGN source. It does not enroll/install an agent, initialize an account, configure shared launch defaults, change source launch/replication settings, cut over/finalize a migration, start/terminate EC2 instances or alter production DNS/routes. Terraform only reads account/network/key metadata and records a local terraform_data review guard; it creates no AWS infrastructure and is not an MGN resource manager. Requires Terraform1.4+, Python3 and current boto3.

## Enroll and prepare through owner procedures
Initialize the regional MGN service with approved service roles, staging network, agent installation identity and source-owner authorization. Verify the exact current supported OS/kernel/boot/disk/app requirements, appliance/agent resources, endpoint routing, bandwidth, TCP1500 replication and HTTPS443 control paths, storage/instance quotas and service costs. Use AWS's official Windows/Linux replication-agent installation procedure and an approved short-lived installation identity; never embed static keys in this export or source control. Record the resulting exact source-server ARN once initial replication completes. This recipe requires AGENT_BASED continuous replication, not agentless snapshot shipping, Outposts/Local Zones or FSx staging.

Review SSP/authorization scope, data classification, allowed destination/transfer boundary, source metadata/log/backup/key handling, encryption-module validation evidence, STIG/SRG applicability, privacy/records/residency and interconnection requirements with applicable civilian/DoD/State owners. A commercial/GovCloud region, FIPS endpoint or local test is not an ATO, classification approval or certification. This recipe does not assert DT/APL/CDM/DoDIN approval. Required boundaries/evidence and effective controls must exist before any source installation/data replication/pilot action. FIPS is selected automatically only in published US MGN FIPS regions; GovCloud cannot select standard here. Review endpoint/key/agent requirements independently.

## Review the selected source settings
Use private same-account staging and isolated test subnets in one approved VPC, exact selected replication/test SGs, private replication routing/no public staging IP, EBS staging with CUSTOM selected symmetric customer key and the matching approved account EBS encryption defaults. This tool never changes those shared settings. Review actual per-disk staging/target key behavior and verify launched EBS volume encryption/key after test: defaults/metadata are not proof of every resulting volume. Review effective key/service-role/instance-profile policies, network routes/NACLs/SG rules, test-client access and isolation from production services. An isolated test network still needs owner-approved dependencies and egress.

Configure the selected source's MGN-created EC2 launch template through the owner-reviewed MGN/EC2 procedure, not the account-level template. Use exactly one fresh primary NIC with explicit test subnet/groups, no existing NIC/fixed private IP/public IP/IPv6, selected x86 instance type, exact approved profile ARN or none, IMDSv2 required/endpoint enabled/hop limit<=2 and encrypted EBS settings. Review all other inherited template fields (including user data) independently; helper never prints their contents. Record the default version number. Set per-source launchDisposition STOPPED, copyPrivateIp false and right sizing NONE. Disable/review post-launch documents and active source custom actions for this initial pilot. Choose boot/licensing/OS settings with owners: Linux BYOL and Windows AWS-license-included/BYOL eligibility/tenancy require actual license review. No legal/license suitability is inferred from inventory.

## Inspect and explicitly test
Run terraform init/validate/plan to evaluate the local review guard; review every finding. Apply records only local state. Existing operator permissions for exact source metadata/test, jobs, EC2 metadata and selected KMS describe are owner prerequisites; no broad MGN managed policy is attached and no roles are created here. Protect this reviewed directory/config/state. Run python OPERATE.py to inspect selected actual source, launch/default version, private placement, encryption and action metadata. It does not read application data, prove agent identity/security, source consistency, actual OS readiness/licensing, effective IAM or complete template safety.

After approved pilot/cost/licensing/consistency review, run python OPERATE.py --test --confirm-launch. It checks READY_FOR_TEST, continuous error-free replication within accepted lag and absence of an existing launched instance, then sends one StartTest request with SDK retries disabled for this exact source. StartTest has no client-token deduplication; investigate history after any ambiguous error before repeating. It changes source lifecycle to TESTING and launches conversion/test resources; STOPPED disposition does not mean no infrastructure/cost or conversion activity. State may change between reads and request. The helper does not start the test instance, run application scripts or claim application acceptance.

Save the returned job ID and run python OPERATE.py --job <job-id>. Only a LAUNCH/START_TEST job containing exactly this source is accepted. Verify the resulting instance is stopped, private, correctly encrypted, licensed and isolated; use separately approved owner procedures for boot/smoke/application/dependency/monitoring/backup/restore tests. Keep an acceptance record. Lag is not application consistency or a guaranteed RPO; replicated crash-consistent state can require DB/application recovery. Pilot termination/reset, final writer freeze/catch-up, cutover, DNS/client change, finalize, agent removal and source decommission require their own reviewed workflow and rollback decisions. No automatic cleanup or source destruction is performed. Existing native MGN builders remain separate for their qualified infrastructure features.

https://docs.aws.amazon.com/mgn/latest/ug/launch-template.html
https://docs.aws.amazon.com/mgn/latest/ug/Supported-Operating-Systems.html
https://docs.aws.amazon.com/general/latest/gr/mgn.html
https://docs.aws.amazon.com/mgn/latest/APIReference/API_StartTest.html
`;
