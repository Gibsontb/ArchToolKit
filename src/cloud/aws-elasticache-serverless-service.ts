import {AWS_ELASTICACHE_RBAC_CHECK_LINES} from './aws-elasticache-rbac.ts';
import {error,type Finding} from '../core/findings.ts';
import type {Blueprint} from '../kit/blueprint.ts';
import {blk,dat,hcl,output,res,x} from '../terraform/blueprints/migration/common.ts';
import {awsServiceModule,awsServicePartition,awsServiceRegion} from './aws-service-module.ts';
const profiles={valkey8:{engine:'valkey',major:'8'},valkey7:{engine:'valkey',major:'7'},redis7:{engine:'redis',major:'7'}};
export const AWS_ELASTICACHE_SERVERLESS_SERVICE={
  id:'aws_service_elasticache_serverless',label:'Set up a private serverless Valkey or Redis cache',
  description:'Create a customer-key encrypted IPv4 VPC serverless cache with dedicated client-group ingress, existing RBAC, snapshots, explicit storage/ECPU caps and read-only metadata checks.',
  emits:['aws_elasticache_serverless_cache','aws_security_group'],
  inputs:[awsServiceRegion,{id:'name',label:'Serverless cache name',control:'text'},{id:'account',label:'AWS account ID',control:'text'},
    {id:'profile',label:'Engine and major version',control:'select',default:'valkey8',options:[{value:'valkey8',label:'Valkey8'},{value:'valkey7',label:'Valkey7.2 family'},{value:'redis7',label:'Redis OSS7 family'}]},
    {id:'subnets',label:'Existing private IPv4 subnet IDs',control:'text',hint:'2–3 owned subnets in distinct AZs of one VPC, with at least4free IPv4 addresses each as recipe headroom.'},
    {id:'clients',label:'Existing application client security group IDs',control:'text',hint:'1–5 owned groups in the same VPC. A new cache group permits only TCP6379–6380 from these groups.'},
    {id:'group',label:'Existing RBAC user group ID',control:'text'},{id:'user',label:'Existing application RBAC user ID',control:'text',hint:'Authenticated active member; disabled default username required. Manage credentials and ACLs separately.'},
    {id:'kms',label:'Existing customer KMS key ARN',control:'text'},
    {id:'prescale',label:'Reserve paid minimum capacity',control:'toggle',default:false,hint:'Opt in only for reviewed pre-scaling; minimums can bill even while idle.'},
    {id:'storage_min',label:'Minimum storage (API GB units)',control:'number',default:1,min:1,max:5000,showWhen:{input:'prescale',equals:['true']}},
    {id:'storage_max',label:'Maximum storage (API GB units)',control:'number',default:10,min:1,max:5000},
    {id:'ecpu_min',label:'Minimum ECPU per second',control:'number',default:1000,min:1000,max:15000000,showWhen:{input:'prescale',equals:['true']}},
    {id:'ecpu_max',label:'Maximum ECPU per second',control:'number',default:25000,min:1000,max:15000000},
    {id:'snapshots',label:'Automatic snapshot retention (days)',control:'number',default:7,min:1,max:35},
    {id:'snapshot_time',label:'Daily snapshot time (UTC HH:MM)',control:'text',default:'02:00'},
  ],
  build(values){
    const findings:Finding[]=[],reject=(path:string,message:string)=>findings.push(error('aws.elasticache-serverless.'+path,message,{path}));
    const region=String(values.aws_region??''),account=String(values.account??'').trim(),name=String(values.name??'').trim(),profile=String(values.profile??''),selection=Object.hasOwn(profiles,profile)?profiles[profile as keyof typeof profiles]:profiles.valkey8,kms=String(values.kms??'').trim(),group=String(values.group??'').trim(),user=String(values.user??'').trim(),snapshotTime=String(values.snapshot_time??'').trim();
    const list=(key:string)=>[...new Set(String(values[key]??'').split(',').map(row=>row.trim()).filter(Boolean))],subnets=list('subnets'),clients=list('clients');
    if(awsServicePartition(region)!=='aws')reject('aws_region','This VPC/IPv4 serverless recipe is commercial AWS only; qualify service/engine availability for the selected region.');
    if(!/^\d{12}$/.test(account))reject('account','Enter the12-digit account.');
    if(!/^[a-z][a-z0-9-]{0,38}[a-z0-9]$/.test(name)||name.includes('--'))reject('name','Use2–40 lowercase letters/digits/single hyphens; start with a letter and end with a letter/digit.');
    if(!Object.hasOwn(profiles,profile))reject('profile','Select a supported engine/version combination.');
    if(subnets.length<2||subnets.length>3||subnets.some(row=>!/^subnet-(?:[0-9a-f]{8}|[0-9a-f]{17})$/.test(row)))reject('subnets','Use2–3 valid distinct subnet IDs.');
    if(clients.length<1||clients.length>5||clients.some(row=>!/^sg-(?:[0-9a-f]{8}|[0-9a-f]{17})$/.test(row)))reject('clients','Use1–5 valid client security group IDs.');
    for(const[field,value]of [['group',group],['user',user]])if(!/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(value!))reject(field!,'Use an existing RBAC identifier.');
    const keyMatch=/^arn:aws:kms:([a-z0-9-]+):(\d{12}):key\/[0-9a-f-]+$/.exec(kms);
    if(!keyMatch||keyMatch[1]!==region||keyMatch[2]!==account)reject('kms','Use the customer key ARN from this account/region.');
    const integer=(key:string,min:number,max:number)=>{const value=Number(values[key]);if(values[key]===''||!Number.isInteger(value)||value<min||value>max)reject(key,'Use a whole number from'+min+' to'+max+'.');return value;};
    const prescale=values.prescale===true||values.prescale==='true';
    const storageMin=prescale?integer('storage_min',1,5000):0,storageMax=integer('storage_max',1,5000),ecpuMin=prescale?integer('ecpu_min',1000,15000000):0,ecpuMax=integer('ecpu_max',1000,15000000),snapshots=integer('snapshots',1,35);
    if(storageMin>storageMax)reject('storage_max','Maximum storage must cover the configured minimum.');
    if(ecpuMin>ecpuMax)reject('ecpu_max','Maximum ECPU must cover the configured minimum.');
    if(!/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(snapshotTime))reject('snapshot_time','Use24-hour UTC HH:MM.');
    const built=awsServiceModule(region,[dat('aws_caller_identity','current',{}),dat('aws_kms_key','cache',{key_id:kms}),
      dat('aws_subnet','selected',{for_each:x('toset('+JSON.stringify(subnets)+')'),id:x('each.value')}),
      dat('aws_security_group','clients',{for_each:x('toset('+JSON.stringify(clients)+')'),id:x('each.value')}),
      res('aws_security_group','cache',{name:name+'-serverless',description:'TLS cache ingress from approved application groups',vpc_id:x('values(data.aws_subnet.selected)[0].vpc_id'),tags:x(hcl({Name:name}))},[blk('ingress',{protocol:'tcp',from_port:6379,to_port:6380,security_groups:clients})]),
      res('aws_elasticache_serverless_cache','cache',{name,description:name+' private application cache',engine:selection.engine,major_engine_version:selection.major,subnet_ids:subnets,security_group_ids:x('[aws_security_group.cache.id]'),user_group_id:group,kms_key_id:kms,snapshot_retention_limit:snapshots,daily_snapshot_time:snapshotTime,tags:x(hcl({Name:name}))},[
        blk('cache_usage_limits',{},[blk('data_storage',{...(prescale?{minimum:storageMin}:{}),maximum:storageMax,unit:'GB'}),blk('ecpu_per_second',{...(prescale?{minimum:ecpuMin}:{}),maximum:ecpuMax})]),
        blk('lifecycle',{prevent_destroy:true},[
          blk('precondition',{condition:x('data.aws_caller_identity.current.account_id == '+JSON.stringify(account)+' && data.aws_kms_key.cache.arn == '+JSON.stringify(kms)+' && data.aws_kms_key.cache.enabled && data.aws_kms_key.cache.key_manager == "CUSTOMER" && data.aws_kms_key.cache.key_spec == "SYMMETRIC_DEFAULT" && data.aws_kms_key.cache.key_usage == "ENCRYPT_DECRYPT"'),error_message:'Require this account enabled symmetric customer cache key.'}),
          blk('precondition',{condition:x('length(toset(concat([for subnet in data.aws_subnet.selected : subnet.vpc_id], [for group in data.aws_security_group.clients : group.vpc_id]))) == 1 && length(toset([for subnet in data.aws_subnet.selected : subnet.availability_zone_id])) == '+subnets.length+' && alltrue([for subnet in data.aws_subnet.selected : subnet.owner_id == '+JSON.stringify(account)+' && subnet.state == "available" && !subnet.ipv6_native && !subnet.map_public_ip_on_launch && subnet.available_ip_address_count >= 4]) && alltrue([for group in data.aws_security_group.clients : split(":", group.arn)[4] == '+JSON.stringify(account)+'])'),error_message:'Require owned private IPv4-capable subnets in distinct AZs with recipe address headroom and same-VPC owned client groups.'}),
        ]),
      ]),
      output('serverless_cache','{ arn = aws_elasticache_serverless_cache.cache.arn, endpoint = aws_elasticache_serverless_cache.cache.endpoint, reader_endpoint = aws_elasticache_serverless_cache.cache.reader_endpoint, security_group = aws_security_group.cache.id }'),
    ],GUIDE,findings);
    built.files['CACHE-CONFIG.json']=JSON.stringify({region,account,name,...selection,subnets,clients,group,user,kms,prescale,storageMin,storageMax,ecpuMin,ecpuMax,snapshots,snapshotTime},null,2)+'\n';
    built.files['PREFLIGHT.py']=CHECK;built.files['CHECK.py']=CHECK;
    return built;
  },
} satisfies Blueprint;
const CHECK=[
  'import json, pathlib, subprocess',
  'import boto3',
  'from botocore.config import Config',
  'config=json.loads((pathlib.Path(__file__).resolve().parent/"CACHE-CONFIG.json").read_text()); applied=pathlib.Path(__file__).name=="CHECK.py"',
  'session=boto3.Session(region_name=config["region"]); options=Config(retries={"total_max_attempts":1,"mode":"standard"})',
  'if session.client("sts",config=options).get_caller_identity()["Account"]!=config["account"]: raise RuntimeError("Wrong operator account")',
  'key=session.client("kms",config=options).describe_key(KeyId=config["kms"])["KeyMetadata"]',
  'if key.get("Arn")!=config["kms"] or key.get("KeyState")!="Enabled" or key.get("KeyManager")!="CUSTOMER" or key.get("KeySpec")!="SYMMETRIC_DEFAULT" or key.get("KeyUsage")!="ENCRYPT_DECRYPT": raise RuntimeError("Require enabled symmetric customer cache key")',
  ...AWS_ELASTICACHE_RBAC_CHECK_LINES,
  'observed={}',
  'if applied:',
  '    job=json.loads(subprocess.check_output(["terraform","output","-json","serverless_cache"],text=True,timeout=30))',
  '    caches=elasticache.describe_serverless_caches(ServerlessCacheName=config["name"])["ServerlessCaches"]',
  '    if len(caches)!=1: raise RuntimeError("Require exact cache metadata")',
  '    cache=caches[0]; expected={"ARN":job["arn"],"ServerlessCacheName":config["name"],"Engine":config["engine"],"MajorEngineVersion":config["major"],"UserGroupId":config["group"],"KmsKeyId":config["kms"],"SnapshotRetentionLimit":config["snapshots"],"DailySnapshotTime":config["snapshotTime"]}',
  '    if not job["arn"].startswith("arn:aws:elasticache:"+config["region"]+":"+config["account"]+":serverlesscache:") or cache.get("Status","").lower()!="available" or any(cache.get(key)!=value for key,value in expected.items()) or sorted(cache.get("SubnetIds",[]))!=sorted(config["subnets"]) or cache.get("SecurityGroupIds")!=[job["security_group"]] or cache.get("ConnectionType","vpc")!="vpc" or cache.get("NetworkType","ipv4")!="ipv4": raise RuntimeError("Cache identity/network/RBAC/key/snapshot metadata differs")',
  '    limits=cache.get("CacheUsageLimits",{}); storage=limits.get("DataStorage",{}); compute=limits.get("ECPUPerSecond",{})',
  '    if cache.get("StorageEncryptionType","sse-kms")!="sse-kms" or cache.get("Migration"): raise RuntimeError("This fresh customer-key cache recipe excludes service-key or migration-routing drift")',
  '    if storage.get("Maximum")!=config["storageMax"] or storage.get("Unit")!="GB" or compute.get("Maximum")!=config["ecpuMax"] or (config["prescale"] and (storage.get("Minimum")!=config["storageMin"] or compute.get("Minimum")!=config["ecpuMin"])): raise RuntimeError("Storage/ECPU configured billing limits differ")',
  '    observed={"service_reported_storage_minimum":storage.get("Minimum"),"service_reported_ecpu_minimum":compute.get("Minimum"),"explicit_prescaling_requested":config["prescale"],"service_billing_floors_require_owner_review":True}',
  '    if cache.get("Endpoint",{}).get("Port")!=6379 or cache.get("ReaderEndpoint",{}).get("Port")!=6380: raise RuntimeError("Primary/replica ports differ")',
  '    actual=session.client("ec2",config=options).describe_security_groups(GroupIds=[job["security_group"]])["SecurityGroups"]',
  '    if len(actual)!=1 or actual[0].get("GroupId")!=job["security_group"] or actual[0].get("OwnerId")!=config["account"]: raise RuntimeError("Cache group ownership differs")',
  '    ingress=actual[0].get("IpPermissions",[])',
  '    if len(ingress)!=1 or ingress[0].get("IpProtocol")!="tcp" or ingress[0].get("FromPort")!=6379 or ingress[0].get("ToPort")!=6380 or ingress[0].get("IpRanges") or ingress[0].get("Ipv6Ranges") or ingress[0].get("PrefixListIds") or sorted(pair.get("GroupId","") for pair in ingress[0].get("UserIdGroupPairs",[]))!=sorted(config["clients"]) or any(pair.get("UserId")!=config["account"] for pair in ingress[0].get("UserIdGroupPairs",[])) or actual[0].get("IpPermissionsEgress"): raise RuntimeError("Cache group must have only approved client-group TLS ingress and no added egress")',
  'print(json.dumps({**observed,"metadata_checked":True,"cache_checked":applied,"cache_passwords_or_tokens_read_or_cache_commands_sent":False,"full_acl_effective_access_or_recovery_proven":False}))',
].join('\n')+'\n';
const GUIDE=`# Private serverless Valkey/Redis cache

Creates a new VPC/IPv4 cache, customer-key encryption, dedicated client-group ingress on TLS6379/6380, existing RBAC and explicit usage/snapshot limits. Preserves the existing provisioned replication-group workflow. No password/token, RBAC mutation, data import, cache command or application connection is generated/executed. Existing user group/key/roles and their policy ownership remain external.

## Network, identity and data readiness
Select2–3 owned private IPv4-capable subnets in distinct AZs of one VPC and approved same-VPC client groups. Four free addresses per subnet is this recipe's headroom check, not a guarantee of AWS capacity. Owner must verify routes/DNS/NACLs/private endpoint capacity and actual regional engine support. Provider5 omits newer ConnectionType/NetworkType fields: AWS defaults to VPC/IPv4 for these profiles/subnets; public Valkey9, IPv6/dual-stack and Memcached need separate workflows. CHECK.py rejects public/nonIPv4 drift. Serverless requires TLS and cluster-aware clients;6379is primary/strong-consistency traffic,6380is replica/eventual-consistency traffic. Clients often need both ports even when replica reads are unused. Do not disable certificate/hostname verification.

Run PREFLIGHT.py with approved Python3/current boto3 and existing scoped STS/KMS/ElastiCache metadata access. It checks selected account/key, exact owned active compatible group/no pending membership,1–50distinct users, disabled default username and active authenticated selected app user. DescribeUsers does not return passwords. Valkey caches accept VALKEY or REDIS groups; Redis accepts REDIS. VALKEY groups require password/IAM authentication for every member. This bounded recipe excludes active passwordless users and ambiguous on/off flags. It does not evaluate the full command/key-pattern ACL or prove effective IAM/application identity. Owners must qualify least-privilege ACLs, IAM token flow or password rotation and actual client compatibility independently. No credentials are entered/exported here.

## Usage, snapshots and recovery
Storage limits pass directly as ElastiCache API GB units; no invented decimal/binary TCO conversion is performed. Paid pre-scaling defaults off and no minimum attributes are sent unless explicitly selected. AWS engine billing floors still apply; CHECK.py reports service-returned minima for owner cost review. When selected, configured minimum storage/ECPU can bill even idle; higher minimums are not free headroom. Maximum storage can cause TTL-key eviction or OOM when nothing is evictable; maximum ECPU can throttle requests. Validate application behavior and set owner-monitored alarms below limits. Caps are service usage controls, not a complete monthly budget/price guarantee. Review current regional billing, snapshot/network costs, growth and demand before deployment.

Automatic snapshots use the selected UTC HH:MM and1–35day retention. They are not continuous data protection or proof of restore correctness. Test restore into a separately approved cache and verify data/application behavior. Source consistency, TTLs, eviction semantics, cache warming and cutover/rollback remain owner migration work. prevent_destroy guards Terraform only; do not remove it before a separately reviewed final snapshot, recovery and retirement plan. No final snapshot or deletion runs here.

## Implement and accept
Preflight first, then review Terraform account/subnets/group/engine/key/RBAC/usage limits and saved plan under authorized change process. Existing customer-key/service-linked-role/creation-grant permissions remain prerequisites; key policies and shared groups are not overwritten. After apply run CHECK.py to compare actual cache network/RBAC/key/snapshot/usage/port metadata. Verify actual dedicated SG rules, effective private access, authenticated TLS client behavior, allowed/denied commands/key patterns, limits, failure/recovery, snapshots and observability with separately approved synthetic tests. Metadata checks never send cache commands and cannot establish those acceptance results.

Review workload classification/allowed boundary, privacy/retention/residency, encryption-module/STIG/SRG evidence, agency/DoD ATO/APL/CDM/interconnection requirements as applicable. This commercial-region recipe makes no federal/classified/FIPS authorization claim; GovCloud/China require separately qualified variants. Keep real cache data, passwords and tokens in approved boundaries, outside generated files/logs.

https://docs.aws.amazon.com/AmazonElastiCache/latest/APIReference/API_CreateServerlessCache.html
https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Clusters.RBAC.html
https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Scaling-serverless.html
https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/set-up.html
`;
