/** Execute generated client scripts with local SDK doubles only, never AWS. */
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_SAGEMAKER_SERVICE as blueprint} from '../src/cloud/aws-sagemaker-service.ts';
import {WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'sagemaker-client-test-'));
for(const artifact of ['IMAGE','ARCHIVE']){
  const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',name:'model-serving',image:'123456789012.dkr.ecr.us-east-1.amazonaws.com/inference/model@sha256:'+'a'.repeat(64),kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc',subnets:'subnet-0123456789abcdef0,subnet-0123456789abcdef1',clients:'sg-0123456789abcdef0',role:'arn:aws:iam::123456789012:role/ModelApplication',artifact,...(artifact==='ARCHIVE'?{bucket:'approved-models',key:'releases/v1/model.tar.gz',version:'approved-version',etag:'a'.repeat(32),endpoint:'FIPS'}:{})});
  if(result.findings.length)throw new Error(JSON.stringify(result.findings));
  mkdirSync(join(work,artifact));for(const name of ['CLIENT-CONFIG.json','PREFLIGHT.py','CHECK.py'])writeFileSync(join(work,artifact,name),result.files[name]);
}
writeFileSync(join(work,'harness.py'),String.raw`import contextlib, copy, io, json, pathlib, runpy, subprocess, sys, types
root=pathlib.Path(__file__).resolve().parent
job={'vpce':'vpce-0123456789abcdef0','url':'https://vpce-0123456789abcdef0-runtime.sagemaker.us-east-1.vpce.amazonaws.com','group':'sg-0123456789abcdef9'}
(root/'probe.json').write_bytes(b'SYNTHETIC-PAYLOAD')
(root/'large.json').write_bytes(b'x'*1048577)
(root/'existing.bin').write_bytes(b'KEEP-EXISTING')
class Config:
    def __init__(self,**kwargs):
        assert kwargs['retries']==dict(total_max_attempts=1,mode='standard')
        if 'use_fips_endpoint' in kwargs: assert kwargs['use_fips_endpoint']==config['fips']
        else: assert kwargs['connect_timeout']==5 and kwargs['read_timeout']==70
class Body(io.BytesIO):
    def read(self,size):
        if scenario=='response-error':raise RuntimeError('SYNTHETIC-RESPONSE')
        return super().read(size)
    def close(self): closed.append(True); super().close()
def mutate(value,cases):
    if scenario in cases:
        key,changed=cases[scenario];value[key]=changed
    return value
class Session:
    def __init__(self,region_name): assert region_name==config['region']
    def client(self,name,**kwargs):
        assert name in ['sts','ecr','s3','sagemaker','ec2','logs','kms','iam','sagemaker-runtime']
        if name=='s3':assert config['artifact']=='ARCHIVE'
        assert isinstance(kwargs['config'],Config)
        if name=='sagemaker-runtime':assert kwargs['endpoint_url']==job['url']
        return self
    def get_caller_identity(self):return {'Account':'000000000000' if scenario=='account' else config['account'],'UserId':'OTHER:session' if scenario=='identity' else 'AROAINVOKER:session'}
    def describe_images(self,**kwargs):
        assert kwargs==dict(registryId=config['account'],repositoryName=config['repository'],imageIds=[{'imageDigest':config['digest']}])
        return {'imageDetails':[dict(registryId=config['account'],repositoryName=config['repository'],imageDigest='other' if scenario=='image' else config['digest'])]}
    def owner(self,kwargs):assert kwargs==dict(Bucket=config['bucket'],ExpectedBucketOwner=config['account'])
    def get_bucket_location(self,**kwargs):self.owner(kwargs);return {'LocationConstraint':'us-west-2' if scenario=='region' else None}
    def get_bucket_versioning(self,**kwargs):self.owner(kwargs);return {'Status':'Suspended' if scenario=='versioning' else 'Enabled'}
    def get_public_access_block(self,**kwargs):
        self.owner(kwargs);return {'PublicAccessBlockConfiguration':dict(BlockPublicAcls=True,IgnorePublicAcls=True,BlockPublicPolicy=True,RestrictPublicBuckets=scenario!='public')}
    def head_object(self,**kwargs):
        assert kwargs==dict(Bucket=config['bucket'],ExpectedBucketOwner=config['account'],Key=config['key'])
        return mutate(dict(VersionId=config['version'],ETag='"'+config['etag']+'"',ContentLength=1000,ServerSideEncryption='aws:kms',SSEKMSKeyId=config['kms']),{'version':('VersionId','other'),'etag':('ETag','other'),'empty':('ContentLength',0),'artifact-encryption':('ServerSideEncryption','AES256'),'artifact-key':('SSEKMSKeyId','other')})
    def describe_endpoint(self,**kwargs):
        assert kwargs=={'EndpointName':config['name']}
        value=dict(EndpointArn=config['endpointArn'],EndpointConfigName=config['model'],EndpointStatus='InService',ProductionVariants=[{'VariantName':'AllTraffic','CurrentInstanceCount':config['count'],'DesiredInstanceCount':config['count']}])
        if scenario=='live-count':value['ProductionVariants'][0]['DesiredInstanceCount']+=1
        return mutate(value,{'endpoint':('EndpointArn','other'),'state':('EndpointStatus','Updating')})
    def describe_endpoint_config(self,**kwargs):
        assert kwargs=={'EndpointConfigName':config['model']}
        variant=dict(VariantName='AllTraffic',ModelName=config['model'],InstanceType=config['instance'],InitialInstanceCount=config['count'],InitialVariantWeight=1,VolumeSizeInGB=config['volume'],ContainerStartupHealthCheckTimeoutInSeconds=config['startup'],ModelDataDownloadTimeoutInSeconds=config['download'],EnableSSMAccess=False)
        mutate(variant,{'instance':('InstanceType','ml.p4d.24xlarge'),'count':('InitialInstanceCount',4),'volume':('VolumeSizeInGB',500),'ssm':('EnableSSMAccess',True),'serverless':('ServerlessConfig',{'MemorySizeInMB':1024}),'dump':('CoreDumpConfig',{'DestinationS3Uri':'s3://other/dump'})})
        return mutate(dict(EndpointConfigArn=config['configArn'],KmsKeyId=config['kms'],ProductionVariants=[variant]),{'storage-key':('KmsKeyId','other'),'capture':('DataCaptureConfig',{'EnableCapture':True}),'async':('AsyncInferenceConfig',{'OutputConfig':{}}),'shadow':('ShadowProductionVariants',[variant])})
    def describe_model(self,**kwargs):
        assert kwargs=={'ModelName':config['model']}
        container={'Image':config['image'],'Mode':'SingleModel'}
        if config['artifact']=='ARCHIVE':container['ModelDataUrl']='s3://'+config['bucket']+'/'+config['key']
        mutate(container,{'model-image':('Image','other'),'container-env':('Environment',{'OTHER':'value'}),'model-data':('ModelDataUrl','s3://other/model.tar.gz')})
        return mutate(dict(ModelArn=config['modelArn'],ExecutionRoleArn=config['executionRole'],EnableNetworkIsolation=True,PrimaryContainer=container),{'model-role':('ExecutionRoleArn','other'),'isolation':('EnableNetworkIsolation',False),'model-vpc':('VpcConfig',{'Subnets':['other']})})
    def describe_vpc_endpoints(self,**kwargs):
        assert kwargs=={'VpcEndpointIds':[job['vpce']]}
        value=dict(VpcEndpointId=job['vpce'],VpcId='vpc-0123456789abcdef0',State='available',ServiceName='com.amazonaws.us-east-1.sagemaker.runtime'+('-fips' if config['fips'] else ''),PrivateDnsEnabled=False,SubnetIds=config['subnets'],Groups=[{'GroupId':job['group']}],DnsEntries=[{'DnsName':job['url'].split('https://')[1]}])
        return {'VpcEndpoints':[mutate(value,{'vpce-state':('State','pending'),'vpce-service':('ServiceName','other'),'vpce-dns':('PrivateDnsEnabled',True),'vpce-subnet':('SubnetIds',['other']),'vpce-group':('Groups',[{'GroupId':'other'}]),'vpce-host':('DnsEntries',[{'DnsName':'other'}])})]}
    def describe_security_groups(self,**kwargs):
        assert set(kwargs['GroupIds'])==set(config['clients']+[job['group']])
        groups=[dict(GroupId=group,OwnerId=config['account'],VpcId='vpc-0123456789abcdef0',IpPermissions=[])for group in kwargs['GroupIds']]
        runtime=next(group for group in groups if group['GroupId']==job['group'])
        rule=dict(IpProtocol='tcp',FromPort=443,ToPort=443,UserIdGroupPairs=[{'GroupId':group}for group in config['clients']])
        mutate(rule,{'ingress-world':('IpRanges',[{'CidrIp':'0.0.0.0/0'}]),'ingress-client':('UserIdGroupPairs',[{'GroupId':'other'}]),'ingress-port':('ToPort',444)})
        runtime['IpPermissions']=[rule]
        if scenario=='group-vpc':runtime['VpcId']='other'
        return {'SecurityGroups':groups}
    def describe_key(self,**kwargs):
        assert kwargs=={'KeyId':config['kms']}
        return {'KeyMetadata':dict(Arn=config['kms'],KeyState='Disabled' if scenario=='key-state' else 'Enabled',KeyManager='CUSTOMER',KeySpec='SYMMETRIC_DEFAULT',KeyUsage='ENCRYPT_DECRYPT')}
    def describe_log_groups(self,**kwargs):
        assert kwargs==dict(logGroupNamePrefix=config['logName'],limit=2)
        return {'logGroups':[dict(logGroupName=config['logName'],kmsKeyId='other' if scenario=='log-key' else config['kms'],retentionInDays=1 if scenario=='retention' else config['retention'])]}
    def get_role(self,**kwargs):
        assert kwargs=={'RoleName':'ModelApplication'}
        return {'Role':{'Arn':config['role'],'RoleId':'AROAINVOKER'}}
    def invoke_endpoint(self,**kwargs):
        invokes.append(kwargs);assert kwargs==dict(EndpointName=config['name'],ContentType='application/json',Body=b'SYNTHETIC-PAYLOAD')
        if scenario=='ambiguous':raise RuntimeError('SYNTHETIC-PAYLOAD')
        return {'Body':Body(b'x'*6291457 if scenario=='large-response' else b'SYNTHETIC-RESPONSE'),'ContentType':'application/json'}
sdk=types.ModuleType('boto3');sdk.Session=Session;sys.modules['boto3']=sdk
botocore=types.ModuleType('botocore');botocore.__path__=[];sys.modules['botocore']=botocore
module=types.ModuleType('botocore.config');module.Config=Config;sys.modules['botocore.config']=module
def outputs(command,text):
    assert command==['terraform','output','-json','inference_job']and text
    value=copy.deepcopy(job)
    if scenario=='job-url':value['url']='https://untrusted.example.com'
    return json.dumps(value)
subprocess.check_output=outputs
count=0
for artifact in ['IMAGE','ARCHIVE']:
    config=json.loads((root/artifact/'CLIENT-CONFIG.json').read_text())
    for scenario in ['valid','account','image']+(['region','versioning','public','version','etag','empty','artifact-encryption','artifact-key']if artifact=='ARCHIVE'else[]):
        failure=None;invokes=[];closed=[];sys.argv=['PREFLIGHT.py']
        with contextlib.redirect_stdout(io.StringIO()):
            try:runpy.run_path(str(root/artifact/'PREFLIGHT.py'),run_name='__main__')
            except Exception as error:failure=error
        assert bool(failure)==(scenario!='valid'),(artifact,scenario,failure)
        assert not invokes;count+=1
    for scenario in ['inspect','invoke','output','account','endpoint','state','live-count','storage-key','capture','async','shadow','instance','count','volume','ssm','serverless','dump','model-image','model-role','isolation','model-vpc','container-env','model-data','vpce-state','vpce-service','vpce-dns','vpce-subnet','vpce-group','vpce-host','ingress-world','ingress-client','ingress-port','group-vpc','key-state','log-key','retention','identity','job-url','missing-confirm','existing-output','missing-payload','large-payload','ambiguous','large-response','response-error']:
        failure=None;invokes=[];closed=[]
        args=[]if scenario=='inspect'else['--invoke',str(root/'probe.json'),'--confirm-inference']
        if scenario=='missing-confirm':args=['--invoke',str(root/'probe.json')]
        if scenario=='output':args+=['--output',str(root/(artifact+'-response.bin'))]
        if scenario=='existing-output':args+=['--output',str(root/'existing.bin')]
        if scenario=='missing-payload':args=['--invoke',str(root/'missing.json'),'--confirm-inference']
        if scenario=='large-payload':args=['--invoke',str(root/'large.json'),'--confirm-inference']
        sys.argv=['CHECK.py']+args
        with contextlib.redirect_stdout(io.StringIO())as output:
            try:runpy.run_path(str(root/artifact/'CHECK.py'),run_name='__main__')
            except SystemExit as error:
                if error.code not in[None,0]:failure=error
            except Exception as error:failure=error
        assert bool(failure)!=(scenario in['inspect','invoke','output']),(artifact,scenario,failure)
        assert len(invokes)==int(scenario in['invoke','output','ambiguous','large-response','response-error']),(artifact,scenario,invokes)
        assert len(closed)==int(scenario in['invoke','output','large-response','response-error']),(artifact,scenario,closed)
        assert'SYNTHETIC-RESPONSE'not in output.getvalue()and'SYNTHETIC-PAYLOAD'not in output.getvalue()
        if scenario in['ambiguous','response-error']:assert failure.__suppress_context__ and 'SYNTHETIC'not in str(failure)
        if scenario=='inspect':assert json.loads(output.getvalue())['inference_sent']is False
        if scenario=='output':assert(root/(artifact+'-response.bin')).read_bytes()==b'SYNTHETIC-RESPONSE'
        assert(root/'existing.bin').read_bytes()==b'KEEP-EXISTING';count+=1
print('Passed',count,'generated SageMaker metadata/client cases; no AWS calls, image/archive downloads, deployment or real inference.')
`);
const check=spawnSync(process.env.PYTHON_PATH||'python',[join(work,'harness.py')],{cwd:work,encoding:'utf8',timeout:60000,windowsHide:true});
process.stdout.write(check.stdout||'');process.stderr.write(check.stderr||'');if(check.error)throw check.error;
console.log(work);process.exitCode=check.status??1;
