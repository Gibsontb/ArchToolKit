/** Generated sharded-cache scripts with local SDK doubles only; no cache traffic or credentials. */
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_ELASTICACHE_SHARDED_SERVICE as blueprint} from '../src/cloud/aws-elasticache-sharded-service.ts';
import {WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'elasticache-sharded-test-'));
const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',name:'application-shards',account:'123456789012',subnets:'subnet-0123456789abcdef0,subnet-0123456789abcdef1',clients:'sg-0123456789abcdef0',parameter_group:'approved-cluster-params',group:'application-group',user:'application-user',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc'});
if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const name of ['PREFLIGHT.py','CHECK.py','SHARDED-CONFIG.json'])writeFileSync(join(work,name),result.files[name]);
writeFileSync(join(work,'harness.py'),String.raw`import contextlib, io, json, pathlib, runpy, subprocess, sys, types
root=pathlib.Path(__file__).resolve().parent;original=json.loads((root/'SHARDED-CONFIG.json').read_text())
job={'arn':'arn:aws:elasticache:us-east-1:123456789012:replicationgroup:application-shards','endpoint':'configuration.example','security_group':'sg-0123456789abcdef9'}
class Config:
    def __init__(self,**kwargs):assert kwargs['retries']['total_max_attempts']==1
class Session:
    def __init__(self,**kwargs):assert kwargs==dict(region_name=config['region'])
    def client(self,name,**kwargs):assert name in ['sts','kms','elasticache','ec2'];return self
    def get_caller_identity(self):return {'Account':'other' if case=='account' else config['account']}
    def describe_key(self,**kwargs):return {'KeyMetadata':dict(Arn=config['kms'],KeyState='Disabled' if case=='key-state' else 'Enabled',KeyManager='CUSTOMER',KeySpec='SYMMETRIC_DEFAULT',KeyUsage='ENCRYPT_DECRYPT')}
    def describe_user_groups(self,**kwargs):
        assert kwargs==dict(UserGroupId=config['group'])
        return {'UserGroups':[dict(UserGroupId=config['group'],ARN='arn:aws:elasticache:'+config['region']+':'+config['account']+':usergroup:'+config['group'],Status='active',Engine=config['engine'].upper(),UserIds=['default-off',config['user']],PendingChanges={})]}
    def describe_users(self,**kwargs):
        identifier=kwargs['UserId'];default=identifier=='default-off'
        return {'Users':[dict(UserId=identifier,UserName='default' if default else 'application',ARN='arn:aws:elasticache:'+config['region']+':'+config['account']+':user:'+identifier,Status='active',AccessString='on ~* +@all' if case=='default-active' else 'off -@all' if default else 'on ~application:* +get',Authentication={'Type':'password'})]}
    def describe_cache_engine_versions(self,**kwargs):
        assert kwargs==dict(Engine=config['engine'],EngineVersion=config['version'])
        return {'CacheEngineVersions':[] if case=='offering' else [dict(Engine=config['engine'],EngineVersion=config['version'],CacheParameterGroupFamily=config['family'])]}
    def describe_cache_parameter_groups(self,**kwargs):
        assert kwargs==dict(CacheParameterGroupName=config['parameterGroup'])
        return {'CacheParameterGroups':[dict(CacheParameterGroupName=config['parameterGroup'],CacheParameterGroupFamily='other' if case=='parameter-family' else config['family'])]}
    def describe_cache_parameters(self,**kwargs):
        assert kwargs['CacheParameterGroupName']==config['parameterGroup'] and kwargs['MaxRecords']==100
        if case=='parameter-page' and 'Marker' not in kwargs:return {'Parameters':[],'Marker':'next'}
        if case=='parameter-loop':return {'Parameters':[],'Marker':'repeated'}
        return {'Parameters':[dict(ParameterName='cluster-enabled',ParameterValue='no' if case=='cluster-off-parameter' else 'yes')]}
    def shards(self):
        shards=[]
        for index in range(config['shards']):
            nodes=[dict(CacheClusterId='node-'+str(index)+'-'+str(replica),PreferredAvailabilityZone='us-east-1a' if case=='one-az' or replica==0 else 'us-east-1b') for replica in range(config['replicas']+1)]
            if case=='duplicate-node':nodes[-1]['CacheClusterId']=nodes[0]['CacheClusterId']
            if case=='replica-count':nodes.pop()
            first=index*16384//config['shards'];last=(index+1)*16384//config['shards']-1
            if case=='overlap' and index==1:first-=1
            if case=='gap' and index==1:first+=1
            shards.append(dict(NodeGroupId='0001' if case=='duplicate-shard' else str(index+1).zfill(4),Status='available',Slots=str(first)+'-'+str(last),NodeGroupMembers=nodes))
        return shards
    def describe_replication_groups(self,**kwargs):
        assert kwargs==dict(ReplicationGroupId=config['name']);shards=self.shards()
        cache=dict(ARN=job['arn'],ReplicationGroupId=config['name'],Status='available',ClusterEnabled=True,AutomaticFailover='disabled' if case=='failover' else 'enabled',MultiAZ='enabled',AtRestEncryptionEnabled=True,KmsKeyId=config['kms'],TransitEncryptionEnabled=True,TransitEncryptionMode='preferred' if case=='tls' else 'required',SnapshotRetentionLimit=config['snapshots'],SnapshotWindow=config['window'],UserGroupIds=[config['group']],ConfigurationEndpoint={'Address':job['endpoint'],'Port':6379},NodeGroups=shards,MemberClusters=[node['CacheClusterId'] for shard in shards for node in shard['NodeGroupMembers']],PendingModifiedValues={'TransitEncryptionEnabled':False} if case=='pending-false' else {})
        return {'ReplicationGroups':[cache]}
    def describe_cache_clusters(self,**kwargs):
        assert kwargs['ShowCacheNodeInfo'] is False;identifier=kwargs['CacheClusterId']
        version='7.2.0' if case=='patch-downgrade' else config['version']
        return {'CacheClusters':[dict(CacheClusterId=identifier,ReplicationGroupId=config['name'],CacheClusterStatus='available',Engine='other' if case=='member-engine' else config['engine'],EngineVersion=version,CacheNodeType=config['nodeType'],CacheParameterGroup={'CacheParameterGroupName':config['parameterGroup'],'ParameterApplyStatus':'applying' if case=='parameter-pending' else 'in-sync'},SecurityGroups=[{'SecurityGroupId':job['security_group']}])]}
    def describe_security_groups(self,**kwargs):
        assert kwargs==dict(GroupIds=[job['security_group']])
        return {'SecurityGroups':[dict(GroupId=job['security_group'],OwnerId=config['account'],IpPermissions=[dict(IpProtocol='tcp',FromPort=6379,ToPort=6379,IpRanges=[{'CidrIp':'0.0.0.0/0'}] if case=='open-ingress' else [],UserIdGroupPairs=[dict(GroupId=identifier,UserId=config['account']) for identifier in config['clients']])],IpPermissionsEgress=[])]}
boto=types.ModuleType('boto3');boto.Session=Session;core=types.ModuleType('botocore');cfg=types.ModuleType('botocore.config');cfg.Config=Config
sys.modules.update({'boto3':boto,'botocore':core,'botocore.config':cfg})
def output(arguments,**kwargs):assert arguments==['terraform','output','-json','sharded_cache'] and kwargs['timeout']==30;return json.dumps(job)
subprocess.check_output=output
count=0;base=['ok','account','key-state','default-active','offering','parameter-family','cluster-off-parameter','parameter-page','parameter-loop']
for script,scenarios in [('PREFLIGHT.py',base),('CHECK.py',base+['failover','tls','one-az','duplicate-node','replica-count','overlap','gap','duplicate-shard','pending-false','member-engine','parameter-pending','open-ingress','patch-downgrade','one-shard','redis'])]:
    for case in scenarios:
        config=dict(original)
        if case=='patch-downgrade':config['version']='7.2.5'
        if case=='one-shard':config['shards']=1
        if case=='redis':config.update(engine='redis',family='redis7',version='7.1')
        (root/'SHARDED-CONFIG.json').write_text(json.dumps(config));sys.argv=[script];error=None;captured=io.StringIO()
        try:
            with contextlib.redirect_stdout(captured):runpy.run_path(str(root/script),run_name='__main__')
        except Exception as exc:error=exc
        assert (error is None)==(case in ['ok','parameter-page','one-shard','redis']),(script,case,error)
        if error is None:json.loads(captured.getvalue())
        count+=1
print(str(count)+' generated metadata cases passed; no cache commands/password retrieval')
`);
const run=spawnSync(process.env.PYTHON_PATH||'python',[join(work,'harness.py')],{encoding:'utf8'});
process.stdout.write(run.stdout||'');process.stderr.write(run.stderr||'');
if(run.status!==0)throw new Error('Sharded cache checks failed: '+work);
console.log(work);
