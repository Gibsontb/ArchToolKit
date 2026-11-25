                                                   
import {error,            } from '../core/findings.js';
import {blk,dat,output,res,x} from '../terraform/blueprints/migration/common.js';
import {awsServiceModule,awsServiceRegion} from './aws-service-module.js';
const nodes=['ra3.xlplus','ra3.4xlarge','ra3.16xlarge'],days=['mon','tue','wed','thu','fri','sat','sun'];
const hours=Array.from({length:24},(_,value)=>({value:String(value),label:String(value).padStart(2,'0')+':00 UTC'}));
export const AWS_REDSHIFT_PROVISIONED_SERVICE={
  id:'aws_service_redshift_provisioned',label:'Create a private provisioned RA3 warehouse',
  description:'Create a new encrypted single-AZ multi-node cluster, scoped client group, managed admin secret, TLS parameters, snapshots and encrypted retained connection/user audit logs. No password or SQL access during checks.',
  emits:['aws_security_group','aws_redshift_subnet_group','aws_redshift_parameter_group','aws_redshift_cluster','aws_redshift_snapshot_schedule','aws_redshift_snapshot_schedule_association','aws_cloudwatch_log_group','aws_redshift_logging'],
  inputs:[awsServiceRegion,{id:'name',label:'Cluster name',control:'text'},
    {id:'database',label:'Initial database name',control:'text',default:'analytics'},
    {id:'admin',label:'Initial admin user name',control:'text',default:'warehouse_admin',hint:'Redshift generates/manages the password in Secrets Manager. No credential value is entered or retrieved.'},
    {id:'node',label:'Provisioned node type',control:'select',default:'ra3.xlplus',options:nodes.map(value=>({value,label:value})),hint:'This workflow covers these three RA3 types. RG, other node sizes and Multi-AZ require separate qualification.'},
    {id:'count',label:'Compute nodes',control:'number',default:2,min:2,max:16,hint:'Bounded2–16 here, not the AWS maximum for every node type. Multi-node does not mean Multi-AZ.'},
    {id:'subnets',label:'Two existing private subnet IDs',control:'text',hint:'Comma-separated owned IPv4 subnets in distinct AZs of one DNS-enabled VPC. Preflight requires nodes+4 free IPs per subnet; ongoing checks require3free. Conservative headroom is not capacity reservation.'},
    {id:'clients',label:'Existing authorized client security group IDs',control:'text',hint:'1–5 owned groups in the same VPC. New warehouse group permits TCP5439 only from these groups.'},
    {id:'kms',label:'Existing warehouse customer KMS key ARN',control:'text'},
    {id:'secret_kms',label:'Existing admin-secret customer KMS key ARN',control:'text'},
    {id:'log_kms',label:'Existing audit-log customer KMS key ARN',control:'text',hint:'Selected keys must be enabled symmetric keys in this account/region; existing policies need Redshift/Secrets Manager/CloudWatch permissions.'},
    {id:'snapshots',label:'Automated snapshot retention (days)',control:'select',default:'7',options:[1,3,7,14,30,35].map(value=>({value:String(value),label:String(value)}))},
    {id:'frequency',label:'Scheduled snapshot cadence',control:'select',default:'8',options:[4,8,12,24].map(value=>({value:String(value),label:'Every '+value+' hours'}))},
    {id:'backup_hour',label:'Snapshot schedule anchor hour',control:'select',default:'4',options:hours,hint:'The recurring UTC schedule includes this hour. Start time is not a guaranteed completion time or RPO.'},
    {id:'maintenance_day',label:'Weekly maintenance day',control:'select',default:'sun',options:days.map(value=>({value,label:value}))},
    {id:'maintenance_hour',label:'Weekly60-minute maintenance starts',control:'select',default:'5',options:hours},
    {id:'retention',label:'Audit-log retention (days)',control:'select',default:'90',options:[30,60,90,180,365].map(value=>({value:String(value),label:String(value)}))},
  ],
  build(values)                                    {
    const findings          =[],reject=(path       ,message       )=>findings.push(error('aws.redshift-provisioned.'+path,message,{path}));
    const region=String(values.aws_region??''),name=String(values.name??'').trim(),database=String(values.database??'').trim(),admin=String(values.admin??'').trim(),node=String(values.node??''),count=Number(values.count),kms=String(values.kms??'').trim(),secretKms=String(values.secret_kms??'').trim(),logKms=String(values.log_kms??'').trim(),account=/^arn:aws:kms:[^:]+:(\d{12}):key\//.exec(kms)?.[1]??'';
    if(!['us-east-1','us-east-2','us-west-1','us-west-2'].includes(region))reject('aws_region','This workflow is bounded to four US commercial regions; verify actual regional node offering before deployment.');
    if(!/^[a-z][a-z0-9-]{1,46}[a-z0-9]$/.test(name)||name.includes('--'))reject('name','Use3–48 lowercase letters, digits and internal nonconsecutive hyphens, starting with a letter.');
    if(!/^[a-z][a-z0-9_]{0,62}$/.test(database)||['template0','template1','padb_harvest','select','user','group'].includes(database))reject('database','Use a nonreserved lowercase database identifier up to63characters.');
    if(!/^[a-z][a-z0-9_]{0,62}$/.test(admin)||['root','public','rdsdb','select','user','group'].includes(admin))reject('admin','Use a nonreserved lowercase admin identifier up to63characters.');
    if(!nodes.includes(node))reject('node','Choose a supported RA3 node type.');
    if(!Number.isSafeInteger(count)||count<2||count>16)reject('count','Use2–16compute nodes for this bounded initial-create workflow.');
    const list=(key       )=>[...new Set(String(values[key]??'').split(',').map(value=>value.trim()).filter(Boolean))],subnets=list('subnets'),clients=list('clients');
    if(subnets.length!==2||subnets.some(value=>!/^subnet-[0-9a-f]{17}$/.test(value)))reject('subnets','Use two distinct existing subnet IDs.');
    if(!clients.length||clients.length>5||clients.some(value=>!/^sg-[0-9a-f]{17}$/.test(value)))reject('clients','Use1–5 existing client group IDs.');
    for(const [path,key]of [['kms',kms],['secret_kms',secretKms],['log_kms',logKms]])if(!key .startsWith('arn:aws:kms:'+region+':'+account+':key/')||!/^arn:aws:kms:[^:]+:\d{12}:key\/[0-9a-f-]+$/.test(key ))reject(path ,'Use an existing customer key ARN in the warehouse account/region.');
    const snapshots=Number(values.snapshots),retention=Number(values.retention),frequency=Number(values.frequency),backupHour=Number(values.backup_hour),maintenanceHour=Number(values.maintenance_hour),day=String(values.maintenance_day??'');
    if(![1,3,7,14,30,35].includes(snapshots))reject('snapshots','Select an automated snapshot retention.');
    if(![30,60,90,180,365].includes(retention))reject('retention','Select audit-log retention.');
    if(![4,8,12,24].includes(frequency))reject('frequency','Select4,8,12or24hours.');
    for(const [path,value]of [['backup_hour',backupHour],['maintenance_hour',maintenanceHour]]         )if(values[path]===''||!Number.isInteger(value)||value<0||value>23)reject(path,'Choose an hour0–23UTC.');
    if(!days.includes(day))reject('maintenance_day','Choose a weekday.');
    const snapshotHours=[4,8,12,24].includes(frequency)?Array.from({length:24/frequency},(_,index)=>(backupHour+index*frequency)%24).sort((a,b)=>a-b):[];
    if(snapshotHours.includes(maintenanceHour))reject('maintenance_hour','Choose a maintenance start hour different from the scheduled snapshot starts.');
    const hh=(value       )=>String(value).padStart(2,'0'),snapshotDefinition='cron(0 '+snapshotHours.join(',')+' *)',maintenanceWindow=day+':'+hh(maintenanceHour)+':00-'+(maintenanceHour===23?days[(days.indexOf(day)+1)%7]:day)+':'+hh((maintenanceHour+1)%24)+':00';
    const first='data.aws_subnet.selected['+JSON.stringify(subnets[0]??'')+']',logNames=['connectionlog','userlog'].map(type=>'/aws/redshift/cluster/'+name+'/'+type),keys={storage:kms,secret:secretKms,logs:logKms};
    const result=awsServiceModule(region,[
      dat('aws_caller_identity','current',{}),dat('aws_subnet','selected',{for_each:x('toset('+JSON.stringify(subnets)+')'),id:x('each.value')}),dat('aws_security_group','clients',{for_each:x('toset('+JSON.stringify(clients)+')'),id:x('each.value')}),dat('aws_vpc','selected',{id:x(first+'.vpc_id')}),
      ...Object.entries(keys).map(([key,arn])=>dat('aws_kms_key',key,{key_id:arn})),
      res('aws_security_group','warehouse',{name:name+'-clients',description:'Reviewed warehouse client groups only',vpc_id:x(first+'.vpc_id')},[blk('ingress',{protocol:'tcp',from_port:5439,to_port:5439,security_groups:clients})]),
      res('aws_redshift_subnet_group','warehouse',{name:name+'-subnets',subnet_ids:subnets}),
      res('aws_redshift_parameter_group','warehouse',{name:name+'-tls',family:'redshift-1.0'},[blk('parameter',{name:'require_ssl',value:'true'}),blk('parameter',{name:'enable_user_activity_logging',value:'false'})]),
      ...logNames.map((log,index)=>res('aws_cloudwatch_log_group','audit_'+index,{name:log,kms_key_id:logKms,retention_in_days:retention},[blk('lifecycle',{prevent_destroy:true})])),
      res('aws_redshift_cluster','warehouse',{cluster_identifier:name,database_name:database,master_username:admin,manage_master_password:true,master_password_secret_kms_key_id:secretKms,node_type:node,number_of_nodes:count,cluster_type:'multi-node',multi_az:false,availability_zone_relocation_enabled:false,cluster_version:'1.0',allow_version_upgrade:true,maintenance_track_name:'current',encrypted:true,kms_key_id:kms,publicly_accessible:false,enhanced_vpc_routing:true,port:5439,cluster_subnet_group_name:x('aws_redshift_subnet_group.warehouse.name'),cluster_parameter_group_name:x('aws_redshift_parameter_group.warehouse.name'),vpc_security_group_ids:x('[aws_security_group.warehouse.id]'),iam_roles:[],automated_snapshot_retention_period:snapshots,manual_snapshot_retention_period:-1,preferred_maintenance_window:maintenanceWindow,skip_final_snapshot:false,final_snapshot_identifier:name+'-final-snapshot'},[
        blk('lifecycle',{prevent_destroy:true},[blk('precondition',{condition:x('data.aws_caller_identity.current.account_id == '+JSON.stringify(account)+' && data.aws_vpc.selected.enable_dns_support && length(distinct([for subnet in data.aws_subnet.selected : subnet.vpc_id])) == 1 && length(distinct([for subnet in data.aws_subnet.selected : subnet.availability_zone_id])) == 2 && alltrue([for subnet in data.aws_subnet.selected : subnet.owner_id == data.aws_caller_identity.current.account_id && !subnet.map_public_ip_on_launch && !subnet.ipv6_native && subnet.available_ip_address_count >= 3]) && alltrue([for group in data.aws_security_group.clients : split(":", group.arn)[4] == data.aws_caller_identity.current.account_id && group.vpc_id == '+first+'.vpc_id])'+Object.keys(keys).map(key=>' && data.aws_kms_key.'+key+'.arn == '+JSON.stringify(keys[key                     ])+' && data.aws_kms_key.'+key+'.enabled && data.aws_kms_key.'+key+'.key_spec == "SYMMETRIC_DEFAULT" && data.aws_kms_key.'+key+'.key_usage == "ENCRYPT_DECRYPT" && data.aws_kms_key.'+key+'.key_manager == "CUSTOMER"').join('')),error_message:'Require this account, distinct owned private AZs/free IPs, DNS-enabled VPC/client groups and selected enabled symmetric customer keys.'})]),
      ]),
      res('aws_redshift_snapshot_schedule','warehouse',{identifier:name+'-daily',definitions:[snapshotDefinition],force_destroy:false},[blk('lifecycle',{prevent_destroy:true})]),
      res('aws_redshift_snapshot_schedule_association','warehouse',{cluster_identifier:x('aws_redshift_cluster.warehouse.id'),schedule_identifier:x('aws_redshift_snapshot_schedule.warehouse.id')}),
      res('aws_redshift_logging','warehouse',{cluster_identifier:x('aws_redshift_cluster.warehouse.id'),log_destination_type:'cloudwatch',log_exports:['connectionlog','userlog'],depends_on:x('[aws_cloudwatch_log_group.audit_0, aws_cloudwatch_log_group.audit_1]')}),
      output('warehouse_endpoint','aws_redshift_cluster.warehouse.endpoint'),output('admin_secret_arn','aws_redshift_cluster.warehouse.master_password_secret_arn'),output('warehouse_security_group','aws_security_group.warehouse.id'),
    ],GUIDE,findings);
    const config={region,account,name,database,admin,node,count,subnets,clients,kms,secretKms,logKms,snapshots,retention,snapshotDefinition,frequency,maintenanceWindow,logNames};
    return {...result,files:{...result.files,'WAREHOUSE-CONFIG.json':JSON.stringify(config,null,2)+'\n','INSPECT.py':INSPECT,'CHECK.sql':'-- Run only through an approved TLS-verifying SQL client with separately authorized credentials.\nSELECT current_database(), current_user;\nSHOW require_ssl;\n-- Verify a nonadmin application identity and approved query separately.\n'}};
  },
}                    ;

const INSPECT=[
  'import argparse, json, pathlib, re',
  'import boto3',
  'from botocore.config import Config',
  'parser=argparse.ArgumentParser(description="Read warehouse/key/network/secret METADATA only; never retrieve passwords or execute SQL")',
  'parser.add_argument("--check",action="store_true"); args=parser.parse_args()',
  'config=json.loads((pathlib.Path(__file__).resolve().parent/"WAREHOUSE-CONFIG.json").read_text())',
  'session=boto3.Session(region_name=config["region"]); options=Config(retries={"total_max_attempts":1,"mode":"standard"},use_fips_endpoint=True)',
  'if session.client("sts",config=options).get_caller_identity()["Account"]!=config["account"]: raise RuntimeError("Unexpected account")',
  'kms=session.client("kms",config=options)',
  'def same_key(identifier,expected):',
  '    return bool(identifier) and kms.describe_key(KeyId=identifier)["KeyMetadata"].get("Arn")==expected',
  'for arn in set([config["kms"],config["secretKms"],config["logKms"]]):',
  '    key=kms.describe_key(KeyId=arn)["KeyMetadata"]',
  '    if key.get("Arn")!=arn or key.get("KeyState")!="Enabled" or key.get("KeySpec")!="SYMMETRIC_DEFAULT" or key.get("KeyUsage")!="ENCRYPT_DECRYPT" or key.get("KeyManager")!="CUSTOMER": raise RuntimeError("Selected customer key differs")',
  'ec2=session.client("ec2",config=options); subnets=ec2.describe_subnets(SubnetIds=config["subnets"])["Subnets"]',
  'if len(subnets)!=2 or {item.get("SubnetId") for item in subnets}!=set(config["subnets"]) or len({item.get("VpcId") for item in subnets})!=1 or len({item.get("AvailabilityZoneId") for item in subnets})!=2 or any(item.get("OwnerId")!=config["account"] or item.get("MapPublicIpOnLaunch") or item.get("Ipv6Native") or item.get("AssignIpv6AddressOnCreation") or item.get("AvailableIpAddressCount",0)<(3 if args.check else config["count"]+4) for item in subnets): raise RuntimeError("Require exact owned private IPv4 subnets in distinct AZs with free IPs")',
  'vpc=subnets[0]["VpcId"]',
  'if ec2.describe_vpc_attribute(VpcId=vpc,Attribute="enableDnsSupport").get("EnableDnsSupport",{}).get("Value") is not True: raise RuntimeError("VPC DNS support required")',
  'groups=ec2.describe_security_groups(GroupIds=config["clients"])["SecurityGroups"]',
  'if len(groups)!=len(config["clients"]) or {item.get("GroupId") for item in groups}!=set(config["clients"]) or any(item.get("OwnerId")!=config["account"] or item.get("VpcId")!=vpc for item in groups): raise RuntimeError("Client group ownership/VPC differs")',
  'redshift=session.client("redshift",config=options); marker=None; seen=set(); offered=False',
  'for page in range(20):',
  '    response=redshift.describe_orderable_cluster_options(ClusterVersion="1.0",NodeType=config["node"],MaxRecords=100,**({"Marker":marker} if marker else {}))',
  '    offered=offered or any(item.get("NodeType")==config["node"] and item.get("ClusterVersion")=="1.0" and item.get("ClusterType")=="multi-node" and {subnet["AvailabilityZone"] for subnet in subnets}.issubset({az.get("Name") for az in item.get("AvailabilityZones",[]) if any(platform.get("Name")=="VPC" for platform in az.get("SupportedPlatforms",[]))}) for item in response.get("OrderableClusterOptions",[]))',
  '    marker=response.get("Marker")',
  '    if not marker: break',
  '    if marker in seen: raise RuntimeError("Repeated offering page; inspect regional availability")',
  '    seen.add(marker)',
  'else: raise RuntimeError("Offering pagination bound exceeded")',
  'if not offered: raise RuntimeError("Selected node type/version not offered in both reviewed subnet AZs; quotas/actual capacity still need owner confirmation")',
  'if args.check:',
  '    response=redshift.describe_clusters(ClusterIdentifier=config["name"]); clusters=response.get("Clusters",[])',
  '    if response.get("Marker") or len(clusters)!=1: raise RuntimeError("Require exact unpaginated cluster")',
  '    cluster=clusters[0]',
  '    if cluster.get("ClusterIdentifier")!=config["name"] or cluster.get("ClusterStatus")!="available" or cluster.get("ModifyStatus") or cluster.get("PendingModifiedValues") or cluster.get("VpcId")!=vpc or cluster.get("NodeType")!=config["node"] or cluster.get("NumberOfNodes")!=config["count"] or cluster.get("DBName")!=config["database"] or cluster.get("MasterUsername")!=config["admin"] or cluster.get("PubliclyAccessible") is not False or cluster.get("Encrypted") is not True or not same_key(cluster.get("KmsKeyId"),config["kms"]) or cluster.get("EnhancedVpcRouting") is not True or str(cluster.get("MultiAZ","disabled")).lower() not in ["disabled","false"] or cluster.get("IamRoles") or cluster.get("IpAddressType","ipv4")!="ipv4": raise RuntimeError("Cluster identity/readiness/private storage/routing/topology differs")',
  '    if cluster.get("AutomatedSnapshotRetentionPeriod")!=config["snapshots"] or cluster.get("ManualSnapshotRetentionPeriod")!=-1 or cluster.get("PreferredMaintenanceWindow")!=config["maintenanceWindow"]: raise RuntimeError("Snapshot/maintenance policy differs")',
  '    if cluster.get("ClusterSubnetGroupName")!=config["name"]+"-subnets": raise RuntimeError("Cluster subnet group differs")',
  '    response=redshift.describe_cluster_subnet_groups(ClusterSubnetGroupName=config["name"]+"-subnets",MaxRecords=100); subnet_groups=response.get("ClusterSubnetGroups",[])',
  '    if response.get("Marker") or len(subnet_groups)!=1 or subnet_groups[0].get("ClusterSubnetGroupName")!=config["name"]+"-subnets" or subnet_groups[0].get("VpcId")!=vpc or subnet_groups[0].get("SubnetGroupStatus")!="Complete" or len(subnet_groups[0].get("Subnets",[]))!=2 or {item.get("SubnetIdentifier") for item in subnet_groups[0].get("Subnets",[])}!=set(config["subnets"]) or any(item.get("SubnetStatus")!="Active" for item in subnet_groups[0].get("Subnets",[])): raise RuntimeError("Actual subnet group membership/status differs")',
  '    if cluster.get("SnapshotScheduleIdentifier")!=config["name"]+"-daily" or cluster.get("SnapshotScheduleState")!="ACTIVE": raise RuntimeError("Snapshot schedule association differs or pending")',
  '    response=redshift.describe_snapshot_schedules(ScheduleIdentifier=config["name"]+"-daily",MaxRecords=100); schedules=response.get("SnapshotSchedules",[])',
  '    if response.get("Marker") or len(schedules)!=1 or schedules[0].get("ScheduleIdentifier")!=config["name"]+"-daily" or schedules[0].get("ScheduleDefinitions")!=[config["snapshotDefinition"]] or schedules[0].get("AssociatedClusterCount")!=1 or schedules[0].get("AssociatedClusters")!=[{"ClusterIdentifier":config["name"],"ScheduleAssociationState":"ACTIVE"}]: raise RuntimeError("Actual dedicated daily snapshot schedule differs")',
  '    endpoint=cluster.get("Endpoint",{})',
  '    if not endpoint.get("Address") or endpoint.get("Port")!=5439: raise RuntimeError("Expected warehouse endpoint/port missing")',
  '    secret_arn=cluster.get("MasterPasswordSecretArn","")',
  '    if not secret_arn.startswith("arn:aws:secretsmanager:"+config["region"]+":"+config["account"]+":secret:") or not same_key(cluster.get("MasterPasswordSecretKmsKeyId"),config["secretKms"]): raise RuntimeError("Managed admin secret linkage/key differs")',
  '    secret=session.client("secretsmanager",config=options).describe_secret(SecretId=secret_arn)',
  '    if secret.get("ARN")!=secret_arn or secret.get("DeletedDate") or secret.get("RotationEnabled") is not True or not secret.get("KmsKeyId") or kms.describe_key(KeyId=secret["KmsKeyId"])["KeyMetadata"].get("Arn")!=config["secretKms"]: raise RuntimeError("Admin secret metadata/rotation differs")',
  '    membership=cluster.get("VpcSecurityGroups",[])',
  '    if len(membership)!=1 or membership[0].get("Status")!="active": raise RuntimeError("Expected one active warehouse client group")',
  '    actual=ec2.describe_security_groups(GroupIds=[membership[0]["VpcSecurityGroupId"]])["SecurityGroups"]',
  '    if len(actual)!=1 or actual[0].get("OwnerId")!=config["account"] or actual[0].get("VpcId")!=vpc or actual[0].get("GroupName")!=config["name"]+"-clients" or actual[0].get("IpPermissionsEgress"): raise RuntimeError("Warehouse group identity/egress differs")',
  '    rules=actual[0].get("IpPermissions",[])',
  '    if len(rules)!=1 or rules[0].get("IpProtocol")!="tcp" or rules[0].get("FromPort")!=5439 or rules[0].get("ToPort")!=5439 or rules[0].get("IpRanges") or rules[0].get("Ipv6Ranges") or rules[0].get("PrefixListIds") or {pair.get("GroupId") for pair in rules[0].get("UserIdGroupPairs",[])}!=set(config["clients"]) or any(pair.get("UserId",config["account"])!=config["account"] for pair in rules[0].get("UserIdGroupPairs",[])): raise RuntimeError("Warehouse client ingress differs")',
  '    parameters=cluster.get("ClusterParameterGroups",[])',
  '    if len(parameters)!=1 or parameters[0].get("ParameterGroupName")!=config["name"]+"-tls" or parameters[0].get("ParameterApplyStatus")!="in-sync": raise RuntimeError("TLS parameter group differs or pending reboot")',
  '    values={}; marker=None; seen=set()',
  '    for page in range(20):',
  '        response=redshift.describe_cluster_parameters(ParameterGroupName=config["name"]+"-tls",Source="user",MaxRecords=100,**({"Marker":marker} if marker else {}))',
  '        for parameter in response.get("Parameters",[]): values[parameter["ParameterName"]]=parameter.get("ParameterValue")',
  '        marker=response.get("Marker")',
  '        if not marker: break',
  '        if marker in seen: raise RuntimeError("Repeated parameter page")',
  '        seen.add(marker)',
  '    else: raise RuntimeError("Parameter pagination bound exceeded")',
  '    if values.get("require_ssl")!="true" or values.get("enable_user_activity_logging")!="false": raise RuntimeError("TLS/query-content logging parameters differ")',
  '    logging=redshift.describe_logging_status(ClusterIdentifier=config["name"])',
  '    if logging.get("LoggingEnabled") is not True or logging.get("LogDestinationType")!="cloudwatch" or set(logging.get("LogExports",[]))!={"connectionlog","userlog"} or logging.get("LastFailureMessage"): raise RuntimeError("Audit export configuration/failure differs")',
  '    logs=session.client("logs",config=options)',
  '    for name in config["logNames"]:',
  '        response=logs.describe_log_groups(logGroupNamePrefix=name,limit=50); matches=[item for item in response.get("logGroups",[]) if item.get("logGroupName")==name]',
  '        if response.get("nextToken") or len(matches)!=1 or matches[0].get("kmsKeyId")!=config["logKms"] or matches[0].get("retentionInDays")!=config["retention"]: raise RuntimeError("Audit group key/retention differs; log delivery is separate")',
  'print(json.dumps({"metadata_checked":True,"cluster_checked":args.check,"credentials_retrieved":False,"sql_executed":False,"log_contents_read":False,"snapshot_restore_or_application_acceptance_verified":False}))',
].join('\n')+'\n';

const GUIDE=`# Private provisioned RA3 warehouse

Creates a NEW single-AZ multi-node RA3 cluster with private IPv4 client access, managed admin secret, TLS parameter group, automated snapshots and retained CMK-encrypted connection/user audit log groups. Existing Redshift Serverless stays separate. Bounded to four US commercial regions, three RA3 types and2–16nodes (not all regional node types/maxima). Multi-node does NOT provide Multi-AZ recovery. RG/other sizes, Multi-AZ/relocation, snapshot restore, resize, pause/resume and data migration require separately qualified variants; do not use this initial-create workflow as a production resize runbook. Current provider5.100 accepts arbitrary node strings but service offerings/capacity are not established by Terraform validation.

Prepare two owned private IPv4 subnets in distinct supported AZs, one DNS-enabled VPC, approved client groups, free IPs/capacity/quotas and billing. Initial inspection requires nodes+4free IPs per subnet as conservative headroom; ongoing plan/post-deployment checks require3remaining free IPs, so allocation itself does not invalidate the initial-capacity check. These bounds are not a service reservation or complete capacity calculation; verify actual transient/maintenance/IP requirements. New dedicated SG permits only TCP5439 from those groups, no outbound rules. Query clients need approved private routing/NACL/return access. Enhanced VPC routing is enabled, but this package creates NO S3 data role, COPY/UNLOAD egress, gateway endpoint or data path. Initial direct database client access is separate from data ingestion and must be tested. Attach approved data roles/egress only through a separately reviewed extension; no broad warehouse role is created.

Review civilian/DoD/State classification, authorized source/destination and data/log/credential/key/snapshot/transfer/backup boundaries, SSP/ATO/APL/CDM/DoDIN/STIG/SRG/CMVP, residency/privacy/records and retention requirements. A private cluster/FIPS API/selected CMK is not certification or an ATO. Audit connection/user logs can contain sensitive identities/client metadata; query activity logging is explicitly OFF here. Full audit requirements may require additional separately authorized query logging. Review selected retention against actual records requirements, not a universal compliance default.

Select existing storage, Secrets Manager and CloudWatch customer keys; they may differ and their policies/grants must independently permit the corresponding services/deployment owner. Terraform does not overwrite them. Deployment/service-role permissions must support managed-secret create/rotate/update/delete/tag/random generation and applicable KMS DescribeKey/GenerateDataKey/Decrypt/CreateGrant/RetireGrant, Redshift service-linked role and CloudWatch encryption/delivery. Use AWS service-scoped key-policy conditions. No password is entered, read or exported. Only the managed secret ARN is output. INSPECT.py uses DescribeSecret metadata only; protect credential retrieval separately and never put secrets in shell history, SQL files, state or logs. Snapshot restore/admin rotation need actual owner tests. Pause can interrupt automatic secret rotation; this workflow does not pause or rotate.

A dedicated Redshift snapshot schedule runs every selected4/8/12/24hours, anchored to the selected UTC hour, using Redshift's modified cron syntax. It replaces the default system schedule after association. Default8hours still replaces the data-change trigger;12/24hours can be LESS frequent than the default roughly8-hour/data-change-triggered policy. Choose schedule/retention only after RPO/cost review, not as an assumed backup improvement. Snapshot duration/completion is not bounded by a30-minute window. Weekly maintenance is60minutes at a different selected UTC start hour; an ongoing snapshot can still overlap maintenance. Automated snapshots retain the selected1–35days; manual snapshot default is indefinite and can continue billing. Before ingestion verify successful snapshot creation AND a tested restore/RPO/RTO with owners; configured schedule/retention is not backup/recovery evidence. Cluster/schedule/log groups prevent_destroy and cluster skip_final_snapshot=false. The suggested final snapshot identifier is not guaranteed unique forever: before any deliberate deletion choose an unused final name and verify final snapshot completion/retention/secret/client implications. Never remove protection as rollback. Redshift secret deletion can accompany cluster deletion. Maintenance window is not a promise that configuration/resize changes defer until that window; provider/API operations can act immediately.

Run python INSPECT.py before deployment: account/keys/subnets/client groups/DNS and paginated actual orderable node/version/AZ metadata. It does not reserve capacity or prove effective IAM/network/crypto. Run terraform init/validate/plan; review every key, resource, client rule, cost, node count, maintenance and retention setting. Apply the reviewed plan and wait for available/in-sync. Then python INSPECT.py --check compares actual cluster/private encryption/secret metadata/rotation/client ingress/TLS/log export/key/retention. No password, SQL, log-body or data operation is performed. Metadata is not evidence of log delivery, valid TLS certificates, application grants, successful queries or backup restore.

Connect using an approved Redshift driver with TLS hostname/certificate verification and separately authorized managed-secret or IAM database credentials; no credential retrieval code is generated. Execute CHECK.sql only under that approved client and test a nonadmin least-privilege application identity, denied unauthorized access, connection/user log delivery and representative approved data/query behavior. Independently establish schemas/grants, ingestion/COPY roles/endpoints, dependency mapping, sizing/pricing, integrity reconciliation, source-writer cutover/rollback and recovery before actual migration. This provisioner does not copy an estate/database or change traffic.

Recovery requires database/backup owners: retain snapshots/logs/key/secret access, cancel/reconcile failing queries, restore into a separately named private target and validate data/credentials/access before a reviewed client switch. Terraform state does not restore data, deleted credentials or application side effects. Record ownership, monitoring/alerts, audit delivery, recovery test and decommission/retention/sanitization decisions. No live resources, credentials, SQL, snapshots, traffic or decommission operations are run by package inspection.

https://docs.aws.amazon.com/redshift/latest/mgmt/working-with-clusters.html
https://docs.aws.amazon.com/redshift/latest/mgmt/redshift-secrets-manager-integration.html
https://docs.aws.amazon.com/redshift/latest/mgmt/db-auditing.html
https://docs.aws.amazon.com/redshift/latest/mgmt/working-with-snapshots.html
`;
