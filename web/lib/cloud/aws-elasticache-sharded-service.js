import {error,            } from '../core/findings.js';
                                                   
import {blk,dat,hcl,output,res,x} from '../terraform/blueprints/migration/common.js';
import {awsServiceModule,awsServicePartition,awsServiceRegion} from './aws-service-module.js';
import {AWS_ELASTICACHE_RBAC_CHECK_LINES} from './aws-elasticache-rbac.js';
const profiles={valkey7:{engine:'valkey',version:'7.2',family:'valkey7'},valkey8:{engine:'valkey',version:'8.0',family:'valkey8'},redis7:{engine:'redis',version:'7.1',family:'redis7'}};
export const AWS_ELASTICACHE_SHARDED_SERVICE={
  id:'aws_service_elasticache_sharded',label:'Set up a new sharded Valkey or Redis cache',
  description:'Create a fresh cluster-mode-enabled replication group with Multi-AZ replicas, customer-key/TLS protection, dedicated client ingress, existing RBAC/parameter groups and snapshots. Exports metadata checks without cache commands.',
  emits:['aws_elasticache_subnet_group','aws_elasticache_replication_group','aws_security_group'],
  inputs:[awsServiceRegion,{id:'name',label:'New replication group name',control:'text'},{id:'account',label:'AWS account ID',control:'text'},
    {id:'profile',label:'Engine family',control:'select',default:'valkey7',options:[{value:'valkey7',label:'Valkey7.2 family'},{value:'valkey8',label:'Valkey8 family'},{value:'redis7',label:'Redis OSS7.1 family'}]},
    {id:'version',label:'Engine version override',control:'text',hint:'Optional regionally offered version in the selected family, not older than its baseline. Blank uses7.2/8.0/7.1 respectively.'},
    {id:'node_type',label:'Node type',control:'combo',default:'cache.r6g.large',options:['cache.r6g.large','cache.r6g.xlarge','cache.r7g.large','cache.r7g.xlarge','cache.m6g.large','cache.m7g.large'].map(value=>({value,label:value})),hint:'Verify regional engine/node offerings and capacity. Data-tiering node families need a separate workflow.'},
    {id:'shards',label:'Shards',control:'number',default:2,min:1,max:90,hint:'This recipe covers1–90shards. Total nodes=shards×(replicas per shard+1); verify current quotas and cost.'},
    {id:'replicas',label:'Replicas per shard',control:'number',default:1,min:1,max:5},
    {id:'subnets',label:'Existing private IPv4 subnet IDs',control:'text',hint:'2–3 owned subnets in distinct AZs of one VPC, with recipe address headroom.'},
    {id:'clients',label:'Existing client security group IDs',control:'text'},
    {id:'parameter_group',label:'Existing cluster-on parameter group name',control:'text',hint:'Compatible family with cluster-enabled=yes. The workflow never changes this shared group.'},
    {id:'group',label:'Existing RBAC user group ID',control:'text'},{id:'user',label:'Existing application RBAC user ID',control:'text'},
    {id:'kms',label:'Existing customer KMS key ARN',control:'text'},
    {id:'snapshots',label:'Snapshot retention (days)',control:'number',default:7,min:1,max:35},
    {id:'snapshot_window',label:'Snapshot start window (UTC)',control:'text',default:'02:00-03:00',hint:'HH:MM-HH:MM,1–3hours in this recipe. This controls snapshot start, not completion.'},
  ],
  build(values){
    const findings          =[],reject=(path       ,message       )=>findings.push(error('aws.elasticache-sharded.'+path,message,{path}));
    const region=String(values.aws_region??''),account=String(values.account??'').trim(),name=String(values.name??'').trim(),profile=String(values.profile??''),selection=Object.hasOwn(profiles,profile)?profiles[profile                         ]:profiles.valkey7,version=String(values.version??'').trim()||selection.version,nodeType=String(values.node_type??'').trim(),parameterGroup=String(values.parameter_group??'').trim(),group=String(values.group??'').trim(),user=String(values.user??'').trim(),kms=String(values.kms??'').trim(),window=String(values.snapshot_window??'').trim();
    const list=(key       )=>[...new Set(String(values[key]??'').split(',').map(row=>row.trim()).filter(Boolean))],subnets=list('subnets'),clients=list('clients');
    if(awsServicePartition(region)!=='aws')reject('aws_region','This sharded recipe is commercial AWS only; verify regional engine/node/cluster support.');
    if(!/^\d{12}$/.test(account))reject('account','Enter the12-digit account.');
    if(!/^[a-z][a-z0-9-]{0,38}[a-z0-9]$/.test(name)||name.includes('--'))reject('name','Use2–40 lowercase letters/digits/single hyphens, starting with a letter and ending with letter/digit.');
    if(!Object.hasOwn(profiles,profile))reject('profile','Select an engine family.');
    const parsed=/^(\d+)\.(\d+)(?:\.\d+)?$/.exec(version),baseline=selection.version.split('.').map(Number);
    if(!parsed||Number(parsed[1])!==baseline[0]||Number(parsed[2])<baseline[1] )reject('version','Use an available same-family version at or above the baseline.');
    if(!/^cache\.[a-z][a-z0-9]*\.[a-z0-9]+$/.test(nodeType)||nodeType.split('.')[1]?.endsWith('gd'))reject('node_type','Use an offered cache node type without data tiering.');
    if(subnets.length<2||subnets.length>3||subnets.some(row=>!/^subnet-(?:[0-9a-f]{8}|[0-9a-f]{17})$/.test(row)))reject('subnets','Use2–3 valid subnet IDs.');
    if(clients.length<1||clients.length>5||clients.some(row=>!/^sg-(?:[0-9a-f]{8}|[0-9a-f]{17})$/.test(row)))reject('clients','Use1–5 valid client group IDs.');
    if(!/^[A-Za-z][A-Za-z0-9.-]{0,254}$/.test(parameterGroup))reject('parameter_group','Enter the existing compatible cluster-on group name.');
    for(const[field,value]of [['group',group],['user',user]])if(!/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(value ))reject(field ,'Use an existing RBAC identifier.');
    const keyMatch=/^arn:aws:kms:([a-z0-9-]+):(\d{12}):key\/[0-9a-f-]+$/.exec(kms);if(!keyMatch||keyMatch[1]!==region||keyMatch[2]!==account)reject('kms','Use the existing customer key in this account/region.');
    const integer=(key       ,min       ,max       )=>{const value=Number(values[key]);if(values[key]===''||!Number.isInteger(value)||value<min||value>max)reject(key,'Use a whole number from'+min+' to'+max+'.');return value;};
    const shards=integer('shards',1,90),replicas=integer('replicas',1,5),snapshots=integer('snapshots',1,35);
    const time=/^([01][0-9]|2[0-3]):([0-5][0-9])-([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(window);
    if(!time)reject('snapshot_window','Use UTC HH:MM-HH:MM.');else{const duration=(Number(time[3])*60+Number(time[4])-Number(time[1])*60-Number(time[2])+1440)%1440;if(duration<60||duration>180)reject('snapshot_window','Use a1–3hour start window.');}
    const built=awsServiceModule(region,[dat('aws_caller_identity','current',{}),dat('aws_kms_key','cache',{key_id:kms}),
      dat('aws_subnet','selected',{for_each:x('toset('+JSON.stringify(subnets)+')'),id:x('each.value')}),dat('aws_security_group','clients',{for_each:x('toset('+JSON.stringify(clients)+')'),id:x('each.value')}),
      res('aws_security_group','cache',{name:name+'-sharded',description:'TLS cache access from approved client groups',vpc_id:x('values(data.aws_subnet.selected)[0].vpc_id'),tags:x(hcl({Name:name}))},[blk('ingress',{protocol:'tcp',from_port:6379,to_port:6379,security_groups:clients})]),
      res('aws_elasticache_subnet_group','cache',{name:name+'-sharded',subnet_ids:subnets}),
      res('aws_elasticache_replication_group','cache',{replication_group_id:name,description:name+' sharded application cache',engine:selection.engine,engine_version:version,node_type:nodeType,cluster_mode:'enabled',num_node_groups:shards,replicas_per_node_group:replicas,automatic_failover_enabled:true,multi_az_enabled:true,network_type:'ipv4',ip_discovery:'ipv4',port:6379,subnet_group_name:x('aws_elasticache_subnet_group.cache.name'),security_group_ids:x('[aws_security_group.cache.id]'),parameter_group_name:parameterGroup,user_group_ids:[group],at_rest_encryption_enabled:true,kms_key_id:kms,transit_encryption_enabled:true,transit_encryption_mode:'required',snapshot_retention_limit:snapshots,snapshot_window:window,auto_minor_version_upgrade:true,apply_immediately:false,tags:x(hcl({Name:name}))},[
        blk('lifecycle',{prevent_destroy:true},[
          blk('precondition',{condition:x('data.aws_caller_identity.current.account_id == '+JSON.stringify(account)+' && data.aws_kms_key.cache.arn == '+JSON.stringify(kms)+' && data.aws_kms_key.cache.enabled && data.aws_kms_key.cache.key_manager == "CUSTOMER" && data.aws_kms_key.cache.key_spec == "SYMMETRIC_DEFAULT" && data.aws_kms_key.cache.key_usage == "ENCRYPT_DECRYPT"'),error_message:'Require selected account enabled symmetric customer cache key.'}),
          blk('precondition',{condition:x('length(toset(concat([for subnet in data.aws_subnet.selected : subnet.vpc_id], [for group in data.aws_security_group.clients : group.vpc_id]))) == 1 && length(toset([for subnet in data.aws_subnet.selected : subnet.availability_zone_id])) == '+subnets.length+' && alltrue([for subnet in data.aws_subnet.selected : subnet.owner_id == '+JSON.stringify(account)+' && subnet.state == "available" && !subnet.ipv6_native && !subnet.map_public_ip_on_launch && subnet.available_ip_address_count >= 4]) && alltrue([for group in data.aws_security_group.clients : split(":", group.arn)[4] == '+JSON.stringify(account)+'])'),error_message:'Require owned private IPv4-capable distinct-AZ subnets with recipe address headroom and same-VPC owned client groups.'}),
        ]),
      ]),output('sharded_cache','{ arn = aws_elasticache_replication_group.cache.arn, endpoint = aws_elasticache_replication_group.cache.configuration_endpoint_address, security_group = aws_security_group.cache.id }'),
    ],GUIDE,findings);
    built.files['SHARDED-CONFIG.json']=JSON.stringify({region,account,name,engine:selection.engine,version,family:selection.family,nodeType,shards,replicas,subnets,clients,parameterGroup,group,user,kms,snapshots,window},null,2)+'\n';
    built.files['PREFLIGHT.py']=CHECK;built.files['CHECK.py']=CHECK;return built;
  },
}                    ;
const CHECK=[
  'import json, pathlib, re, subprocess',
  'import boto3',
  'from botocore.config import Config',
  'config=json.loads((pathlib.Path(__file__).resolve().parent/"SHARDED-CONFIG.json").read_text()); applied=pathlib.Path(__file__).name=="CHECK.py"',
  'session=boto3.Session(region_name=config["region"]); options=Config(retries={"total_max_attempts":1,"mode":"standard"})',
  'if session.client("sts",config=options).get_caller_identity()["Account"]!=config["account"]: raise RuntimeError("Wrong account")',
  'key=session.client("kms",config=options).describe_key(KeyId=config["kms"])["KeyMetadata"]',
  'if key.get("Arn")!=config["kms"] or key.get("KeyState")!="Enabled" or key.get("KeyManager")!="CUSTOMER" or key.get("KeySpec")!="SYMMETRIC_DEFAULT" or key.get("KeyUsage")!="ENCRYPT_DECRYPT": raise RuntimeError("Require exact enabled symmetric customer key")',
  ...AWS_ELASTICACHE_RBAC_CHECK_LINES,
  'versions=elasticache.describe_cache_engine_versions(Engine=config["engine"],EngineVersion=config["version"]).get("CacheEngineVersions",[])',
  'if not any(row.get("Engine")==config["engine"] and row.get("CacheParameterGroupFamily")==config["family"] and (row.get("EngineVersion")==config["version"] or row.get("EngineVersion","").startswith(config["version"]+".")) for row in versions): raise RuntimeError("Selected engine/version/family offering not established; reconcile current regional descriptors")',
  'groups=elasticache.describe_cache_parameter_groups(CacheParameterGroupName=config["parameterGroup"])["CacheParameterGroups"]',
  'if len(groups)!=1 or groups[0].get("CacheParameterGroupName")!=config["parameterGroup"] or groups[0].get("CacheParameterGroupFamily")!=config["family"]: raise RuntimeError("Parameter group family/name differs")',
  'marker=None; visited=set(); cluster_on=False',
  'for page in range(10):',
  '    request={"CacheParameterGroupName":config["parameterGroup"],"MaxRecords":100}',
  '    if marker: request["Marker"]=marker',
  '    response=elasticache.describe_cache_parameters(**request)',
  '    for parameter in response.get("Parameters",[]):',
  '        if parameter.get("ParameterName")=="cluster-enabled":',
  '            if parameter.get("ParameterValue")!="yes": raise RuntimeError("Existing parameter group must enable cluster mode")',
  '            cluster_on=True',
  '    marker=response.get("Marker")',
  '    if cluster_on or not marker: break',
  '    if marker in visited: raise RuntimeError("Parameter pagination repeated")',
  '    visited.add(marker)',
  'if not cluster_on: raise RuntimeError("Cluster-enabled parameter not established within bounded metadata inspection")',
  'if applied:',
  '    job=json.loads(subprocess.check_output(["terraform","output","-json","sharded_cache"],text=True,timeout=30))',
  '    groups=elasticache.describe_replication_groups(ReplicationGroupId=config["name"])["ReplicationGroups"]',
  '    if len(groups)!=1: raise RuntimeError("Require exact replication group metadata")',
  '    cache=groups[0]; expected={"ARN":job["arn"],"ReplicationGroupId":config["name"],"Status":"available","ClusterEnabled":True,"AutomaticFailover":"enabled","MultiAZ":"enabled","AtRestEncryptionEnabled":True,"KmsKeyId":config["kms"],"TransitEncryptionEnabled":True,"TransitEncryptionMode":"required","SnapshotRetentionLimit":config["snapshots"],"SnapshotWindow":config["window"]}',
  '    if not job["arn"].startswith("arn:aws:elasticache:"+config["region"]+":"+config["account"]+":replicationgroup:") or any(cache.get(key)!=value for key,value in expected.items()) or cache.get("ClusterMode","enabled")!="enabled" or cache.get("PendingModifiedValues") or cache.get("AuthTokenEnabled",False) or cache.get("NetworkType","ipv4")!="ipv4" or cache.get("DataTiering","disabled")!="disabled" or cache.get("GlobalReplicationGroupInfo",{}).get("GlobalReplicationGroupId") or cache.get("UserGroupIds")!=[config["group"]]: raise RuntimeError("Group identity/topology/crypto/RBAC/snapshot or pending settings differ")',
  '    if cache.get("ConfigurationEndpoint",{}).get("Address")!=job["endpoint"] or cache.get("ConfigurationEndpoint",{}).get("Port")!=6379: raise RuntimeError("Cluster configuration endpoint differs")',
  '    shards=cache.get("NodeGroups",[]); members=[]; slots=set()',
  '    if len(shards)!=config["shards"]: raise RuntimeError("Shard count differs")',
  '    if any(not shard.get("NodeGroupId") for shard in shards) or len({shard["NodeGroupId"] for shard in shards})!=len(shards): raise RuntimeError("Shard identifiers are missing or duplicated")',
  '    for shard in shards:',
  '        nodes=shard.get("NodeGroupMembers",[])',
  '        if shard.get("Status")!="available" or len(nodes)!=config["replicas"]+1 or len({node.get("PreferredAvailabilityZone") for node in nodes if node.get("PreferredAvailabilityZone")})<2: raise RuntimeError("Shard state/replica count/AZ separation differs")',
  '        members.extend(node.get("CacheClusterId") for node in nodes)',
  '        match=re.fullmatch(r"([0-9]+)-([0-9]+)",shard.get("Slots",""))',
  '        if not match or not 0<=int(match[1])<=int(match[2])<=16383: raise RuntimeError("Invalid/missing shard slot metadata")',
  '        covered=set(range(int(match[1]),int(match[2])+1))',
  '        if slots.intersection(covered): raise RuntimeError("Overlapping hash-slot metadata")',
  '        slots.update(covered)',
  '    if len(slots)!=16384 or any(not identifier for identifier in members) or len(set(members))!=len(members) or sorted(members)!=sorted(cache.get("MemberClusters",[])): raise RuntimeError("Hash slots/member inventory are incomplete or duplicated")',
  '    versions=set()',
  '    for identifier in members:',
  '        nodes=elasticache.describe_cache_clusters(CacheClusterId=identifier,ShowCacheNodeInfo=False)["CacheClusters"]',
  '        if len(nodes)!=1: raise RuntimeError("Require exact cache-cluster member")',
  '        node=nodes[0]; actual=re.fullmatch(r"([0-9]+)[.]([0-9]+)(?:[.]([0-9]+))?",node.get("EngineVersion","")); parts=list(map(int,config["version"].split("."))); baseline=tuple((parts+[0,0,0])[:3])',
  '        if node.get("CacheClusterId")!=identifier or node.get("ReplicationGroupId")!=config["name"] or node.get("CacheClusterStatus")!="available" or node.get("Engine")!=config["engine"] or node.get("CacheNodeType")!=config["nodeType"] or not actual or int(actual[1])!=baseline[0] or (int(actual[1]),int(actual[2]),int(actual[3] or 0))<baseline or node.get("CacheParameterGroup",{}).get("CacheParameterGroupName")!=config["parameterGroup"] or node.get("CacheParameterGroup",{}).get("ParameterApplyStatus")!="in-sync" or [row.get("SecurityGroupId") for row in node.get("SecurityGroups",[])]!=[job["security_group"]]: raise RuntimeError("Member engine/type/version/parameter/security-group configuration differs")',
  '        versions.add(node["EngineVersion"])',
  '    actual_groups=session.client("ec2",config=options).describe_security_groups(GroupIds=[job["security_group"]])["SecurityGroups"]',
  '    if len(actual_groups)!=1 or actual_groups[0].get("GroupId")!=job["security_group"] or actual_groups[0].get("OwnerId")!=config["account"]: raise RuntimeError("Cache group ownership differs")',
  '    ingress=actual_groups[0].get("IpPermissions",[])',
  '    if len(ingress)!=1 or ingress[0].get("IpProtocol")!="tcp" or ingress[0].get("FromPort")!=6379 or ingress[0].get("ToPort")!=6379 or ingress[0].get("IpRanges") or ingress[0].get("Ipv6Ranges") or ingress[0].get("PrefixListIds") or sorted(row.get("GroupId","") for row in ingress[0].get("UserIdGroupPairs",[]))!=sorted(config["clients"]) or any(row.get("UserId")!=config["account"] for row in ingress[0].get("UserIdGroupPairs",[])) or actual_groups[0].get("IpPermissionsEgress"): raise RuntimeError("Cache group must have only selected client-group TLS6379 ingress and no added egress")',
  '    print(json.dumps({"metadata_checked":True,"shards":len(shards),"nodes":len(members),"covered_hash_slots":len(slots),"observed_engine_versions":sorted(versions),"cache_commands_or_password_requests_sent":False,"live_failover_or_snapshot_restore_proven":False}))',
  'else: print(json.dumps({"metadata_checked":True,"cache_created_or_commands_sent":False,"full_acl_effective_access_or_capacity_proven":False}))',
].join('\n')+'\n';
const GUIDE=`# New sharded Valkey/Redis cache

Creates a NEW cluster-mode-enabled replication group with1–90shards in this bounded recipe,1–5replicas per shard, Multi-AZ failover, TLS6379, customer key, dedicated client ingress and snapshots. Existing nonsharded and Serverless workflows stay separate. Total nodes=shards×(replicas+1); independently verify current regional quotas, node/engine offerings, capacity and per-node/network/snapshot cost. The form's scope is not an AWS global service-limit claim. It never creates/changes RBAC users, credentials, shared parameter groups, key policies or application data.

## Prerequisites and deployment
Use owned private IPv4-capable subnets in distinct AZs and same-VPC client groups; four free addresses is recipe headroom, not a capacity guarantee. Existing RBAC needs a disabled default username and active authenticated app member; full command/key-pattern ACL and effective IAM are owner-reviewed. Existing compatible parameter group must have cluster-enabled=yes. No default group name is guessed and no shared parameter is overwritten. PREFLIGHT.py checks account/key, RBAC metadata, offered engine descriptors and actual parameter family/cluster flag using approved Python3/current boto3. Owners separately verify offered engine/node versions, cache quotas, key/service-linked-role/grant permissions, network/DNS/monitoring and applicable data classification/agency/DoD boundary, ATO/APL/crypto/STIG/SRG/records requirements. Commercial-only scope makes no GovCloud/FIPS/classified authorization claim.

Review and apply the saved Terraform plan under authorized change process. New creation uses cluster_mode=enabled with num_node_groups/replicas_per_node_group; num_cache_clusters is not mixed in. Use a cluster-aware TLS client and the configuration endpoint with existing RBAC auth. This does NOT convert an existing disabled cluster in place: disabled→compatible→enabled requires a separately staged client migration. No client connection or cache command runs here.

## Important update behavior
The validated AWS provider5.100 sends shard and replica changes with ApplyImmediately=true in its dedicated resize APIs, even when apply_immediately=false is set on the resource. That flag is not a general change-window gate. Later shard/replica changes can start at actual apply time; plan, schedule, verify resolved provider behavior and test rollback/data protection before approving them. Other updates may remain pending for maintenance. Auto minor upgrades can change actual patch/minor versions; metadata output reports member versions, and client/application compatibility still needs owners.

## Verify and recover
CHECK.py compares group topology, crypto/RBAC/snapshots, configuration endpoint, no pending changes, shard/replica/AZ counts, complete nonoverlapping16384hash slots and every actual member's engine/version/type/parameter/group IDs. CurrentRole/ReadEndpoint are NOT required for enabled-cluster members because AWS documents them only for disabled mode. Checks are read-only metadata, not proof of effective ACLs, actual network reachability, encryption-module validation, client commands, failover, data consistency or restore. Qualify those with independently approved synthetic tests, including multi-key/hash-tag/CROSSSLOT behavior, uneven-key load, eviction/replication lag, limits and source-to-target cutover integrity.

Snapshot window controls start time, not completion or transactional recovery. Verify isolated restore and retain authoritative source data. No source snapshot is imported and no old cluster is deleted. prevent_destroy guards Terraform only; final backups, source retirement and any protection change need a separately reviewed lifecycle plan. This recipe excludes data tiering, Global Datastore, public/IPv6 access, automatic data copy and client/identity migration.

https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Replication.Redis-RedisCluster.html
https://docs.aws.amazon.com/AmazonElastiCache/latest/APIReference/API_ReplicationGroup.html
https://docs.aws.amazon.com/AmazonElastiCache/latest/APIReference/API_NodeGroupMember.html
https://github.com/hashicorp/terraform-provider-aws/blob/v5.100.0/internal/service/elasticache/replication_group.go
`;
