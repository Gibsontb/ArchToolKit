/** Read-only MWAA inspector local SDK doubles; never invokes tasks/tokens or object bodies. */
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_MWAA_SERVICE as blueprint} from '../src/cloud/aws-mwaa-service.ts';
import {WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'mwaa-inspect-'));
const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',name:'reviewed-workflows',account:'123456789012',bucket:'approved-airflow-dags',role:'approved-airflow-execution',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc',subnets:'subnet-12345678,subnet-abcdef12',group:'sg-12345678'});
if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const name of ['INSPECT.py','MWAA-CONFIG.json','review_smoke_dag.py'])writeFileSync(join(work,name),result.files[name]);
writeFileSync(join(work,'test.py'),String.raw`import contextlib, copy, io, json, runpy, sys, types
from pathlib import Path
root=Path(__file__).resolve().parent; c=json.loads((root/'MWAA-CONFIG.json').read_text())
role_arn='arn:aws:iam::'+c['account']+':role/'+c['role']; vpc='vpc-12345678'
base={'account':c['account'],'region':c['region'],'versioning':'Enabled','objects':[], 'blocks':{k:True for k in ['BlockPublicAcls','IgnorePublicAcls','BlockPublicPolicy','RestrictPublicBuckets']},
 'key':{'AWSAccountId':c['account'],'KeyManager':'CUSTOMER','KeyState':'Enabled','KeyUsage':'ENCRYPT_DECRYPT','KeySpec':'SYMMETRIC_DEFAULT','Arn':c['kms']},
 'role':{'RoleName':c['role'],'Arn':role_arn,'AssumeRolePolicyDocument':{'Statement':[{'Effect':'Allow','Principal':{'Service':['airflow.amazonaws.com','airflow-env.amazonaws.com']},'Action':'sts:AssumeRole'}]}},
 'group':{'GroupId':c['group'],'OwnerId':c['account'],'VpcId':vpc,'IpPermissions':[{'IpProtocol':'-1','UserIdGroupPairs':[{'GroupId':c['group']}]}]},
 'vpc':{'VpcId':vpc,'OwnerId':c['account'],'State':'available'},'dns':True,
 'subnets':[{'SubnetId':id,'OwnerId':c['account'],'VpcId':vpc,'State':'available','MapPublicIpOnLaunch':False,'AvailableIpAddressCount':100,'AvailabilityZoneId':'use1-az'+str(i)} for i,id in enumerate(c['subnets'])],
 'routes':[{'GatewayId':'local','DestinationCidrBlock':'10.0.0.0/16'}],
 'environment':{'Name':c['name'],'Arn':'arn:aws:airflow:'+c['region']+':'+c['account']+':environment/'+c['name'],'Status':'AVAILABLE','AirflowVersion':c['version'],'EnvironmentClass':c['size'],'SourceBucketArn':'arn:aws:s3:::'+c['bucket'],'DagS3Path':c['prefix'],'ExecutionRoleArn':role_arn,'KmsKey':c['kms'],'WebserverAccessMode':'PRIVATE_ONLY','EndpointManagement':'SERVICE','MinWorkers':c['min'],'MaxWorkers':c['max'],'Schedulers':2,'MinWebservers':2,'MaxWebservers':2,'WeeklyMaintenanceWindowStart':c['maintenance'],'NetworkConfiguration':{'SubnetIds':c['subnets'],'SecurityGroupIds':[c['group']]},'AirflowConfigurationOptions':{'core.dags_are_paused_at_creation':'True','core.load_examples':'False'},'LoggingConfiguration':{}}}
for category,suffix in [('DagProcessingLogs','DAGProcessing'),('SchedulerLogs','Scheduler'),('TaskLogs','Task'),('WebserverLogs','WebServer'),('WorkerLogs','Worker')]:
 base['environment']['LoggingConfiguration'][category]={'Enabled':True,'LogLevel':'INFO','CloudWatchLogGroupArn':'arn:aws:logs:'+c['region']+':'+c['account']+':log-group:airflow-'+c['name']+'-'+suffix}
class Config:
 def __init__(self,**kwargs): assert kwargs['use_fips_endpoint'] is True
class Session:
 def __init__(self,**kwargs): assert kwargs=={'region_name':c['region']}
 def client(self,name,**kwargs): assert name in ['sts','s3','kms','iam','ec2','logs','mwaa']; assert kwargs['region_name']==c['region']; return self
 def get_caller_identity(self): return {'Account':data['account']}
 def bucket_args(self,kwargs): assert kwargs=={'Bucket':c['bucket'],'ExpectedBucketOwner':c['account']}
 def head_bucket(self,**kwargs): self.bucket_args(kwargs); return {}
 def get_bucket_location(self,**kwargs): self.bucket_args(kwargs); return {'LocationConstraint':data['region']}
 def get_bucket_versioning(self,**kwargs): self.bucket_args(kwargs); return {'Status':data['versioning']}
 def get_public_access_block(self,**kwargs): self.bucket_args(kwargs); return {'PublicAccessBlockConfiguration':data['blocks']}
 def get_bucket_encryption(self,**kwargs): self.bucket_args(kwargs); return {'ServerSideEncryptionConfiguration':{'Rules':[{'ApplyServerSideEncryptionByDefault':{'SSEAlgorithm':'AES256' if scenario=='bucket-encryption' else 'aws:kms','KMSMasterKeyID':c['kms']}}]}}
 def list_objects_v2(self,**kwargs): assert kwargs=={'Bucket':c['bucket'],'ExpectedBucketOwner':c['account'],'Prefix':c['prefix'],'MaxKeys':2}; return {'Contents':data['objects'],'IsTruncated':scenario=='objects-truncated'}
 def describe_key(self,**kwargs): assert kwargs['KeyId']==c['kms']; return {'KeyMetadata':data['key']}
 def get_role(self,**kwargs): assert kwargs=={'RoleName':c['role']}; return {'Role':data['role']}
 def describe_security_groups(self,**kwargs): assert kwargs=={'GroupIds':[c['group']]}; return {'SecurityGroups':[data['group']]}
 def describe_vpcs(self,**kwargs): assert kwargs=={'VpcIds':[vpc]}; return {'Vpcs':[data['vpc']]}
 def describe_vpc_attribute(self,**kwargs): assert kwargs['VpcId']==vpc; return {{'enableDnsSupport':'EnableDnsSupport','enableDnsHostnames':'EnableDnsHostnames'}[kwargs['Attribute']]:{'Value':data['dns']}}
 def describe_subnets(self,**kwargs): assert kwargs=={'SubnetIds':c['subnets']}; return {'Subnets':data['subnets']}
 def describe_route_tables(self,**kwargs):
  if scenario=='main-route' and kwargs['Filters'][0]['Name']=='association.subnet-id': return {'RouteTables':[]}
  return {'RouteTables':[{'VpcId':vpc,'Routes':data['routes']}]}
 def list_environments(self,**kwargs):
  assert kwargs['MaxResults']==25
  if scenario in ['env-page','env-repeat'] and not kwargs.get('NextToken'): return {'Environments':[],'NextToken':'one'}
  return {'Environments':[c['name']] if scenario=='existing' else [],**({'NextToken':'one'} if scenario=='env-repeat' else {})}
 def get_environment(self,**kwargs): assert kwargs=={'Name':c['name']}; return {'Environment':data['environment']}
 def describe_log_groups(self,**kwargs):
  name=kwargs['logGroupNamePrefix']
  if scenario in ['log-page','log-repeat'] and not kwargs.get('nextToken'): return {'logGroups':[],'nextToken':'one'}
  group={'logGroupName':name,'arn':'arn:aws:logs:'+c['region']+':'+c['account']+':log-group:'+name+':*','kmsKeyId':c['kms'],'retentionInDays':c['retention']}
  if scenario=='log-retention': group['retentionInDays']=7
  if scenario=='log-key': group['kmsKeyId']='other'
  return {'logGroups':[group] if checking or scenario=='existing-log' else [],**({'nextToken':'one'} if scenario=='log-repeat' else {})}
sdk=types.ModuleType('boto3'); sdk.Session=Session; sys.modules['boto3']=sdk; sys.modules['botocore']=types.ModuleType('botocore'); module=types.ModuleType('botocore.config'); module.Config=Config; sys.modules['botocore.config']=module
cases=[('preflight',[],None),('check',[],None),('folder-marker',[],None),('objects-truncated',[],None),('env-page',[],None),('env-repeat',[],None),('existing',[],None),('existing-log',[],None),('main-route',[],None),('log-page',[],None),('log-repeat',[],None),('log-retention',[],None),('log-key',[],None),('bucket-encryption',[],None),
 ('account',['account'],'other'),('bucket-region',['region'],'us-west-2'),('versioning',['versioning'],'Suspended'),('bucket-public',['blocks','RestrictPublicBuckets'],False),('code-present',['objects'],[{'Key':c['prefix']+'danger.py','Size':50}]),('key-state',['key','KeyState'],'Disabled'),('key-owner',['key','AWSAccountId'],'other'),('key-type',['key','KeySpec'],'RSA_2048'),('role-owner',['role','Arn'],'arn:aws:iam::000000000000:role/x'),('role-trust',['role','AssumeRolePolicyDocument','Statement',0,'Principal','Service'],['airflow.amazonaws.com']),('role-wildcard',['role','AssumeRolePolicyDocument','Statement',0,'Principal','AWS'],'*'),
 ('group-owner',['group','OwnerId'],'other'),('group-self',['group','IpPermissions'],[]),('vpc-owner',['vpc','OwnerId'],'other'),('dns',['dns'],False),('subnet-owner',['subnets',0,'OwnerId'],'other'),('subnet-public',['subnets',0,'MapPublicIpOnLaunch'],True),('subnet-az',['subnets',1,'AvailabilityZoneId'],'use1-az0'),('subnet-ipv6',['subnets',0,'Ipv6Native'],True),('subnet-free',['subnets',0,'AvailableIpAddressCount'],0),('route-igw',['routes'],[{'GatewayId':'igw-other'}]),
 ('env-state',['environment','Status'],'UPDATING'),('env-version',['environment','AirflowVersion'],'3.3.1'),('env-public',['environment','WebserverAccessMode'],'PUBLIC_ONLY'),('env-role',['environment','ExecutionRoleArn'],'other'),('env-subnets',['environment','NetworkConfiguration','SubnetIds'],['other']),('env-workers',['environment','MaxWorkers'],25),('env-plugins',['environment','PluginsS3Path'],'unreviewed.zip'),('env-update',['environment','LastUpdate'],{'Status':'FAILED','Error':{'ErrorCode':'bad'}}),('env-pause',['environment','AirflowConfigurationOptions','core.dags_are_paused_at_creation'],'False'),('env-log',['environment','LoggingConfiguration','TaskLogs','Enabled'],False)]
for scenario,path,value in cases:
 data=copy.deepcopy(base)
 if path:
  parent=data
  for key in path[:-1]: parent=parent[key]
  parent[path[-1]]=value
 if scenario=='folder-marker': data['objects']=[{'Key':c['prefix'],'Size':0}]
 checking=scenario not in ['preflight','env-page','env-repeat','existing','existing-log','folder-marker']
 sys.argv=['INSPECT.py']+(['--check'] if checking else []); failure=None
 with contextlib.redirect_stdout(io.StringIO()):
  try: runpy.run_path(str(root/'INSPECT.py'),run_name='__main__')
  except Exception as error: failure=error
 success=scenario in ['preflight','check','folder-marker','env-page','main-route','log-page']
 assert bool(failure)!=success,(scenario,failure)
print(str(len(cases))+' exported MWAA SDK checks passed; no live APIs, tokens, object/log bodies or tasks')
`);
const check=spawnSync(process.env.PYTHON_PATH||'python',[join(work,'test.py')],{encoding:'utf8',windowsHide:true});process.stdout.write((check.stdout||'')+(check.stderr||''));if(check.error)throw check.error;if(check.status!==0)throw new Error('Inspect '+work);console.log(work);
