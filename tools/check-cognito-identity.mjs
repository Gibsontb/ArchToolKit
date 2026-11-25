/** Actual exported identity-pool metadata/federation scripts, SDK/subprocess/token doubles only. */
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_COGNITO_IDENTITY_SERVICE as blueprint} from '../src/cloud/aws-cognito-identity-service.ts';
import {WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'cognito-identity-inspect-'));const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',name:'reviewed-identity',account:'123456789012',user_pool:'us-east-1_Approved123',client:'approvedclient12345',bucket:'approved-shared-documents',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc',approved:'true'});if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const name of ['INSPECT.py','FEDERATE-CHECK.py','ACCESS-POLICY-REVIEW.json','IDENTITY-CONFIG.json'])writeFileSync(join(work,name),result.files[name]);
writeFileSync(join(work,'test.py'),String.raw`import base64,contextlib,copy,getpass,io,json,runpy,subprocess,sys,time,types
from datetime import datetime,timedelta,timezone
from pathlib import Path
from urllib.parse import quote
root=Path(__file__).resolve().parent;c=json.loads((root/'IDENTITY-CONFIG.json').read_text());pool=c['region']+':12345678-abcd-4bcd-8bcd-123456789abc';identity=c['region']+':abcdef12-abcd-4bcd-8bcd-123456789abc'
trust={'Version':'2012-10-17','Statement':[{'Effect':'Allow','Principal':{'Federated':'cognito-identity.amazonaws.com'},'Action':'sts:AssumeRoleWithWebIdentity','Condition':{'StringEquals':{'cognito-identity.amazonaws.com:aud':pool},'ForAnyValue:StringLike':{'cognito-identity.amazonaws.com:amr':'authenticated'}}}]}
policy=json.loads((root/'ACCESS-POLICY-REVIEW.json').read_text())
base={'account':c['account'],'user':{'Id':c['userPool'],'Arn':'arn:aws:cognito-idp:'+c['region']+':'+c['account']+':userpool/'+c['userPool']},'appClients':[{'ClientId':c['client'],'UserPoolId':c['userPool']}],'location':None,'version':'Enabled','blocks':{k:True for k in ['BlockPublicAcls','IgnorePublicAcls','BlockPublicPolicy','RestrictPublicBuckets']},'ownership':[{'ObjectOwnership':'BucketOwnerEnforced'}],'encryption':{'SSEAlgorithm':'aws:kms','KMSMasterKeyID':c['kms']},'key':{'Arn':c['kms'],'AWSAccountId':c['account'],'KeyManager':'CUSTOMER','KeyState':'Enabled','KeySpec':'SYMMETRIC_DEFAULT','KeyUsage':'ENCRYPT_DECRYPT'},
'pools':[{'IdentityPoolId':pool,'IdentityPoolName':c['name']}],'pool':{'IdentityPoolId':pool,'IdentityPoolName':c['name'],'AllowUnauthenticatedIdentities':False,'AllowClassicFlow':False,'CognitoIdentityProviders':[{'ClientId':c['client'],'ProviderName':c['providerName'],'ServerSideTokenCheck':True}]},'roles':{'IdentityPoolId':pool,'Roles':{'authenticated':c['roleArn']},'RoleMappings':{}},'roleExists':True,'roleError':'NoSuchEntity','role':{'RoleName':c['roleName'],'Arn':c['roleArn'],'MaxSessionDuration':3600,'AssumeRolePolicyDocument':trust},'inline':['prefix-read'],'attached':[],'policy':policy}
class ClientError(Exception):
 def __init__(self,code):self.response={'Error':{'Code':code}}
class Config:
 def __init__(self,**kw):assert kw['use_fips_endpoint'] is True
class Session:
 def __init__(self,**kw):assert kw=={'region_name':c['region']}
 def client(self,name,**kw):assert name in ['sts','cognito-idp','cognito-identity','s3','kms','iam'];return self
 def get_caller_identity(self):return {'Account':data['account']}
 def describe_user_pool(self,**kw):assert kw=={'UserPoolId':c['userPool']};return {'UserPool':data['user']}
 def list_user_pool_clients(self,**kw):
  assert kw['UserPoolId']==c['userPool'] and kw['MaxResults']==60
  if scenario=='clients-pages':return {'UserPoolClients':data['appClients'] if kw.get('NextToken') else [],**({} if kw.get('NextToken') else {'NextToken':'two'})}
  if scenario=='clients-token':return {'UserPoolClients':[],'NextToken':'repeat'}
  return {'UserPoolClients':data['appClients']}
 def bucket_request(self,kw):assert kw=={'Bucket':c['bucket'],'ExpectedBucketOwner':c['account']}
 def get_bucket_location(self,**kw):self.bucket_request(kw);return {'LocationConstraint':data['location']}
 def get_bucket_versioning(self,**kw):self.bucket_request(kw);return {'Status':data['version']}
 def get_public_access_block(self,**kw):self.bucket_request(kw);return {'PublicAccessBlockConfiguration':data['blocks']}
 def get_bucket_ownership_controls(self,**kw):self.bucket_request(kw);return {'OwnershipControls':{'Rules':data['ownership']}}
 def get_bucket_encryption(self,**kw):self.bucket_request(kw);return {'ServerSideEncryptionConfiguration':{'Rules':[{'ApplyServerSideEncryptionByDefault':data['encryption']}]}}
 def describe_key(self,**kw):assert kw=={'KeyId':c['kms']};return {'KeyMetadata':data['key']}
 def list_identity_pools(self,**kw):
  assert kw['MaxResults']==60
  if scenario=='pools-pages':return {'IdentityPools':data['pools'] if kw.get('NextToken') else [],**({} if kw.get('NextToken') else {'NextToken':'two'})}
  if scenario=='pools-token':return {'IdentityPools':[],'NextToken':'repeat'}
  return {'IdentityPools':data['pools']}
 def describe_identity_pool(self,**kw):assert kw=={'IdentityPoolId':pool};return data['pool']
 def get_identity_pool_roles(self,**kw):assert kw=={'IdentityPoolId':pool};return data['roles']
 def get_role(self,**kw):
  assert kw=={'RoleName':c['roleName']}
  if not data['roleExists']:raise ClientError(data['roleError'])
  return {'Role':data['role']}
 def list_role_policies(self,**kw):
  assert kw['RoleName']==c['roleName'] and kw['MaxItems']==1000
  if scenario=='iam-pages':return {'PolicyNames':[] if kw.get('Marker') else data['inline'],'IsTruncated':not bool(kw.get('Marker')),**({} if kw.get('Marker') else {'Marker':'two'})}
  if scenario=='iam-token':return {'PolicyNames':[],'IsTruncated':True,'Marker':'repeat'}
  return {'PolicyNames':data['inline'],'IsTruncated':False}
 def list_attached_role_policies(self,**kw):assert kw=={'RoleName':c['roleName'],'MaxItems':1000};return {'AttachedPolicies':data['attached'],'IsTruncated':False}
 def get_role_policy(self,**kw):assert kw=={'RoleName':c['roleName'],'PolicyName':'prefix-read'};return {'PolicyDocument':data['policy']}
sys.modules['boto3']=types.SimpleNamespace(Session=Session);sys.modules['botocore']=types.ModuleType('botocore');sys.modules['botocore.config']=types.SimpleNamespace(Config=Config);sys.modules['botocore.exceptions']=types.SimpleNamespace(ClientError=ClientError)
cases=['preflight','check','clients-pages','pools-pages','iam-pages','encoded-documents','owner','user-owner','missing-client','duplicate-client','clients-token','bucket-region','bucket-version','public-bucket','bucket-ownership','bucket-key','disabled-key','foreign-key','existing-pool','existing-role','role-denied','missing-post-pool','duplicate-pool','pools-token','guest','classic','token-check','extra-provider','alternate-role','role-mapping','role-owner','session','trust-audience','trust-guest','extra-trust','inline-extra','managed-policy','policy-write','iam-token','bad-pool-id']
for scenario in cases:
 data=copy.deepcopy(base);pre=scenario in ['preflight','existing-pool','existing-role','role-denied'];flags=[] if pre else ['--identity-pool',pool]
 if pre:data['pools']=[];data['roleExists']=False
 if scenario=='owner':data['account']='000000000000'
 if scenario=='user-owner':data['user']['Arn']='foreign'
 if scenario=='missing-client':data['appClients']=[]
 if scenario=='duplicate-client':data['appClients']*=2
 if scenario=='bucket-region':data['location']='us-west-2'
 if scenario=='bucket-version':data['version']='Suspended'
 if scenario=='public-bucket':data['blocks']['BlockPublicPolicy']=False
 if scenario=='bucket-ownership':data['ownership']=[]
 if scenario=='bucket-key':data['encryption']['KMSMasterKeyID']='alias/aws/s3'
 if scenario=='disabled-key':data['key']['KeyState']='Disabled'
 if scenario=='foreign-key':data['key']['AWSAccountId']='000000000000'
 if scenario=='existing-pool':data['pools']=copy.deepcopy(base['pools'])
 if scenario=='existing-role':data['roleExists']=True
 if scenario=='role-denied':data['roleError']='AccessDenied'
 if scenario=='missing-post-pool':data['pools']=[]
 if scenario=='duplicate-pool':data['pools']*=2
 if scenario=='guest':data['pool']['AllowUnauthenticatedIdentities']=True
 if scenario=='classic':data['pool']['AllowClassicFlow']=True
 if scenario=='token-check':data['pool']['CognitoIdentityProviders'][0]['ServerSideTokenCheck']=False
 if scenario=='extra-provider':data['pool']['SamlProviderARNs']=['unreviewed']
 if scenario=='alternate-role':data['roles']['Roles']['unauthenticated']='unreviewed'
 if scenario=='role-mapping':data['roles']['RoleMappings']={'unreviewed':{}}
 if scenario=='role-owner':data['role']['Arn']='foreign'
 if scenario=='session':data['role']['MaxSessionDuration']=43200
 if scenario=='trust-audience':data['role']['AssumeRolePolicyDocument']['Statement'][0]['Condition']['StringEquals']['cognito-identity.amazonaws.com:aud']='*'
 if scenario=='trust-guest':data['role']['AssumeRolePolicyDocument']['Statement'][0]['Condition']['ForAnyValue:StringLike']['cognito-identity.amazonaws.com:amr']='unauthenticated'
 if scenario=='extra-trust':data['role']['AssumeRolePolicyDocument']['Statement'].append({'Effect':'Allow','Principal':'*','Action':'sts:AssumeRole'})
 if scenario=='inline-extra':data['inline'].append('unreviewed')
 if scenario=='managed-policy':data['attached']=[{'PolicyArn':'arn:aws:iam::aws:policy/AdministratorAccess'}]
 if scenario=='policy-write':data['policy']['Statement'][0]['Action'].append('s3:PutObject')
 if scenario=='encoded-documents':data['role']['AssumeRolePolicyDocument']=quote(json.dumps(data['role']['AssumeRolePolicyDocument']));data['policy']=quote(json.dumps(data['policy']))
 if scenario=='bad-pool-id':flags=['--identity-pool','bad']
 sys.argv=['INSPECT.py']+flags;failure=None
 with contextlib.redirect_stdout(io.StringIO()) as out,contextlib.redirect_stderr(io.StringIO()):
  try:runpy.run_path(str(root/'INSPECT.py'),run_name='__main__')
  except BaseException as error:failure=error
 success=scenario in ['preflight','check','clients-pages','pools-pages','iam-pages','encoded-documents'];assert bool(failure)!=success,(scenario,failure)
 if success and scenario!='preflight':
  report=json.loads(out.getvalue());assert report['identityPoolRoleMetadataVerified'] is True and report['allClientAuthenticatedUsersSharePrefix'] is True and report['effectiveAuthorizationProven'] is False
print(str(len(cases))+' identity-pool/source/role/trust/policy metadata cases passed; SDK doubles only')

federation_calls=[];temporary_sessions=0
class FederationSession:
 def __init__(self,**kw):
  global temporary_sessions
  if 'aws_access_key_id' in kw:
   assert kw=={'region_name':c['region'],'aws_access_key_id':'SYNTHETIC-KEY','aws_secret_access_key':'SYNTHETIC-SECRET','aws_session_token':'SYNTHETIC-SESSION'};temporary_sessions+=1;self.temporary=True
  else:assert kw=={'region_name':c['region']};self.temporary=False
 def client(self,name,**kw):assert name==('sts' if self.temporary else 'cognito-identity');return self
 def get_id(self,**kw):
  federation_calls.append('get-id');assert kw=={'AccountId':c['account'],'IdentityPoolId':pool,'Logins':{c['providerName']:token}}
  return {'IdentityId':'wrong' if scenario=='wrong-identity' else identity}
 def get_credentials_for_identity(self,**kw):
  federation_calls.append('credentials');assert kw=={'IdentityId':identity,'Logins':{c['providerName']:token}}
  if scenario=='credential-error':raise ValueError('SYNTHETIC-SECRET')
  return {'IdentityId':'wrong' if scenario=='credential-identity' else identity,'Credentials':{'AccessKeyId':'SYNTHETIC-KEY','SecretKey':'SYNTHETIC-SECRET','SessionToken':'SYNTHETIC-SESSION','Expiration':datetime.now(timezone.utc)+timedelta(hours=-1 if scenario=='expired-credentials' else 1)}}
 def get_caller_identity(self):
  federation_calls.append('sts')
  if scenario=='sts-error':raise ValueError('SYNTHETIC-SECRET')
  return {'Account':c['account'],'Arn':'arn:aws:sts::'+c['account']+':assumed-role/'+('wrong-role' if scenario=='wrong-role' else c['roleName'])+'/synthetic-session'}
def fake_run(command,**kw):assert command==[sys.executable,str(root/'INSPECT.py'),'--identity-pool',pool] and kw=={'capture_output':True,'text':True};return types.SimpleNamespace(returncode=1 if scenario=='metadata-failed' else 0,stdout='SYNTHETIC-CHILD-DETAIL',stderr='SYNTHETIC-SECRET')
subprocess.run=fake_run;sys.modules['boto3']=types.SimpleNamespace(Session=FederationSession)
federation_cases=['success','no-confirm','metadata-failed','bad-token','access-token','wrong-client','wrong-issuer','expired-token','future-token','wrong-identity','credential-identity','credential-error','expired-credentials','wrong-role','sts-error']
for scenario in federation_cases:
 federation_calls=[];temporary_sessions=0;claims={'token_use':'id','aud':c['client'],'iss':'https://'+c['providerName'],'exp':time.time()+3600}
 if scenario=='access-token':claims['token_use']='access'
 if scenario=='wrong-client':claims['aud']='wrong'
 if scenario=='wrong-issuer':claims['iss']='https://wrong.example'
 if scenario=='expired-token':claims['exp']=time.time()-10
 if scenario=='future-token':claims['nbf']=time.time()+3600
 token='a.'+base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=')+'.SYNTHETICSIGNATURE'
 if scenario=='bad-token':token='invalid-token'
 getpass.getpass=lambda prompt:token;sys.argv=['FEDERATE-CHECK.py','--identity-pool',pool]+([] if scenario=='no-confirm' else ['--confirm-approved-federation']);failure=None
 with contextlib.redirect_stdout(io.StringIO()) as out,contextlib.redirect_stderr(io.StringIO()) as errors:
  try:runpy.run_path(str(root/'FEDERATE-CHECK.py'),run_name='__main__')
  except BaseException as error:failure=error
 assert bool(failure)!=(scenario=='success'),(scenario,failure)
 assert 'SYNTHETIC-SECRET' not in out.getvalue()+errors.getvalue() and token not in out.getvalue()+errors.getvalue()
 if scenario in ['no-confirm','metadata-failed','bad-token','access-token','wrong-client','wrong-issuer','expired-token','future-token']:assert federation_calls==[]
 if scenario=='success':assert federation_calls==['get-id','credentials','sts'] and temporary_sessions==1 and json.loads(out.getvalue())['sharedPrefixReadProven'] is False
print(str(len(federation_cases))+' explicit federation/token/temporary-session/error-sanitization cases passed; no live tokens or AWS credentials')
`);
const check=spawnSync(process.env.PYTHON_PATH||'python',[join(work,'test.py')],{encoding:'utf8',windowsHide:true});process.stdout.write((check.stdout||'')+(check.stderr||''));if(check.error)throw check.error;if(check.status!==0)throw new Error('Inspect '+work);console.log(work);
