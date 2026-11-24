/** Generated serverless-cache metadata checks with local SDK doubles, no cache traffic or secrets. */
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_ELASTICACHE_SERVERLESS_SERVICE as blueprint} from '../src/cloud/aws-elasticache-serverless-service.ts';
import {WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'elasticache-serverless-test-'));
const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',name:'application-cache',account:'123456789012',subnets:'subnet-0123456789abcdef0,subnet-0123456789abcdef1',clients:'sg-0123456789abcdef0',group:'application-group',user:'application-user',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc'});
if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const name of ['PREFLIGHT.py','CHECK.py','CACHE-CONFIG.json'])writeFileSync(join(work,name),result.files[name]);
writeFileSync(join(work,'harness.py'),String.raw`import contextlib, io, json, pathlib, runpy, subprocess, sys, types
root=pathlib.Path(__file__).resolve().parent;original=json.loads((root/'CACHE-CONFIG.json').read_text())
job={'arn':'arn:aws:elasticache:us-east-1:123456789012:serverlesscache:application-cache','security_group':'sg-0123456789abcdef9'}
class Config:
    def __init__(self,**kwargs):assert kwargs['retries']['total_max_attempts']==1
class Session:
    def __init__(self,**kwargs):assert kwargs==dict(region_name=config['region'])
    def client(self,name,**kwargs):assert name in ['sts','kms','elasticache','ec2'];return self
    def get_caller_identity(self):return {'Account':'other' if case=='account' else config['account']}
    def describe_key(self,**kwargs):
        assert kwargs==dict(KeyId=config['kms'])
        return {'KeyMetadata':{'Arn':config['kms'],'KeyState':'Disabled' if case=='key-state' else 'Enabled','KeyManager':'CUSTOMER','KeySpec':'SYMMETRIC_DEFAULT','KeyUsage':'ENCRYPT_DECRYPT'}}
    def describe_user_groups(self,**kwargs):
        assert kwargs==dict(UserGroupId=config['group'])
        engine='REDIS' if case in ['valkey-redis-group','redis-ok'] else 'VALKEY'
        group=dict(UserGroupId=config['group'],ARN='arn:aws:elasticache:'+config['region']+':'+config['account']+':usergroup:'+config['group'],Status='modifying' if case=='group-state' else 'active',Engine=engine,UserIds=['default-off',config['user']] if case!='missing-app' else ['default-off'],PendingChanges={'UserIdsToAdd':['other']} if case=='pending-members' else {})
        return {'UserGroups':[group],**({'Marker':'more'} if case=='group-page' else {})}
    def describe_users(self,**kwargs):
        identifier=kwargs['UserId'];assert identifier in ['default-off',config['user']]
        default=identifier=='default-off';username='default' if default else 'application'
        if case=='missing-default' and default:username='other'
        access='off -@all' if default else 'on ~application:* +ping +get'
        if case=='default-active' and default:access='on ~* +@all'
        if case=='ambiguous-flags' and default:access='off on ~* +@all'
        if case=='app-disabled' and not default:access='off -@all'
        authentication='no-password' if case=='passwordless' else 'iam' if case=='iam-user' else 'password'
        if case in ['valkey-redis-group','redis-ok'] and default:authentication='no-password'
        return {'Users':[dict(UserId=identifier,UserName=username,ARN='arn:aws:elasticache:'+config['region']+':'+config['account']+':user:'+identifier,Status='modifying' if case=='user-state' else 'active',AccessString=access,Authentication={'Type':authentication})]}
    def describe_serverless_caches(self,**kwargs):
        assert kwargs==dict(ServerlessCacheName=config['name'])
        cache=dict(ARN=job['arn'],ServerlessCacheName=config['name'],Engine=config['engine'],MajorEngineVersion=config['major'],Status='creating' if case=='cache-state' else 'available',UserGroupId=config['group'],KmsKeyId=config['kms'],SnapshotRetentionLimit=0 if case=='snapshots' else config['snapshots'],DailySnapshotTime=config['snapshotTime'],SubnetIds=config['subnets'],SecurityGroupIds=[job['security_group']],ConnectionType='public' if case=='public' else 'vpc',NetworkType='ipv6' if case=='ipv6' else 'ipv4',Endpoint={'Address':'cache.example','Port':6379},ReaderEndpoint={'Address':'cache.example','Port':6379 if case=='reader-port' else 6380},CacheUsageLimits={'DataStorage':{'Minimum':config['storageMin'],'Maximum':999 if case=='storage-cap' else config['storageMax'],'Unit':'GB'},'ECPUPerSecond':{'Minimum':config['ecpuMin'],'Maximum':999999 if case=='ecpu-cap' else config['ecpuMax']}})
        if case=='prescale-drift':cache['CacheUsageLimits']['DataStorage']['Minimum']=2
        if case=='reported-floor':cache['CacheUsageLimits']['DataStorage']['Minimum']=1
        if case=='upper-status':cache['Status']='AVAILABLE'
        if case=='service-key':cache['StorageEncryptionType']='sse-elasticache'
        if case=='migration':cache['Migration']={'Status':'syncing'}
        return {'ServerlessCaches':[cache]}
    def describe_security_groups(self,**kwargs):
        assert kwargs==dict(GroupIds=[job['security_group']])
        rule=dict(IpProtocol='tcp',FromPort=6379,ToPort=6380,UserIdGroupPairs=[dict(GroupId=identifier,UserId=config['account']) for identifier in config['clients']],IpRanges=[{'CidrIp':'0.0.0.0/0'}] if case=='open-ingress' else [])
        return {'SecurityGroups':[dict(GroupId=job['security_group'],OwnerId=config['account'],IpPermissions=[rule],IpPermissionsEgress=[{}] if case=='egress' else [])]}
boto=types.ModuleType('boto3');boto.Session=Session;core=types.ModuleType('botocore');cfg=types.ModuleType('botocore.config');cfg.Config=Config
sys.modules.update({'boto3':boto,'botocore':core,'botocore.config':cfg})
def output(arguments,**kwargs):
    assert arguments==['terraform','output','-json','serverless_cache'] and kwargs['timeout']==30
    return json.dumps(job)
subprocess.check_output=output
count=0;base=['ok','account','key-state','group-state','pending-members','group-page','missing-app','missing-default','default-active','ambiguous-flags','app-disabled','passwordless','user-state','iam-user','valkey-redis-group','redis-wrong-group','redis-ok']
successes=['ok','iam-user','valkey-redis-group','redis-ok','prescale-ok','reported-floor','upper-status']
for script,scenarios in [('PREFLIGHT.py',base),('CHECK.py',base+['cache-state','snapshots','public','ipv6','reader-port','storage-cap','ecpu-cap','open-ingress','egress','prescale-ok','prescale-drift','reported-floor','upper-status','service-key','migration'])]:
    for case in scenarios:
        config=dict(original)
        if case in ['redis-wrong-group','redis-ok']:config.update(engine='redis',major='7')
        if case in ['prescale-ok','prescale-drift']:config.update(prescale=True,storageMin=1,ecpuMin=1000)
        (root/'CACHE-CONFIG.json').write_text(json.dumps(config));sys.argv=[script];error=None;captured=io.StringIO()
        try:
            with contextlib.redirect_stdout(captured):runpy.run_path(str(root/script),run_name='__main__')
        except Exception as exc:error=exc
        assert (error is None)==(case in successes),(script,case,error)
        if error is None:
            report=json.loads(captured.getvalue());assert report['cache_passwords_or_tokens_read_or_cache_commands_sent'] is False
            if case=='reported-floor':assert report['service_reported_storage_minimum']==1 and report['service_billing_floors_require_owner_review'] is True
            if case=='prescale-ok':assert report['explicit_prescaling_requested'] is True
        count+=1
print(str(count)+' generated metadata cases passed; no credentials/cache commands')
`);
const run=spawnSync(process.env.PYTHON_PATH||'python',[join(work,'harness.py')],{encoding:'utf8'});
process.stdout.write(run.stdout||'');process.stderr.write(run.stderr||'');
if(run.status!==0)throw new Error('Serverless cache checks failed: '+work);
console.log(work);
