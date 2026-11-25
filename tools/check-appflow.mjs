/** Exported AppFlow inspector with metadata-only SDK doubles, no SaaS records or AWS calls. */
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_APPFLOW_SERVICE as blueprint} from '../src/cloud/aws-appflow-service.ts';
import {WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'appflow-inspect-'));
const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',name:'reviewed-export',account:'123456789012',profile:'approved-private-salesforce',instance:'https://approved.my.salesforce.com',bucket:'approved-flow-output',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc'});
if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const name of ['INSPECT.py','FLOW-CONFIG.json','BUCKET-POLICY-MERGE.json'])writeFileSync(join(work,name),result.files[name]);
writeFileSync(join(work,'test.py'),String.raw`import contextlib, copy, io, json, runpy, sys, types
from pathlib import Path
root=Path(__file__).resolve().parent; c=json.loads((root/'FLOW-CONFIG.json').read_text()); policy=json.loads((root/'BUCKET-POLICY-MERGE.json').read_text())
tasks=[{'taskType':'Filter','sourceFields':c['fields'],'connectorOperator':{'Salesforce':'PROJECTION'}}]+[{'taskType':'Map','sourceFields':[f],'destinationField':f,'connectorOperator':{'Salesforce':'NO_OP'},'taskProperties':{'SOURCE_DATA_TYPE':'id' if f=='Id' else 'string','DESTINATION_DATA_TYPE':'id' if f=='Id' else 'string'}} for f in c['fields']]
base={'account':c['account'],'profile':{'connectorProfileArn':'arn:aws:appflow:'+c['region']+':'+c['account']+':connectorprofile/'+c['profile'],'connectorProfileName':c['profile'],'connectorType':'Salesforce','connectionMode':'Private','privateConnectionProvisioningState':{'status':'CREATED'},'connectorProfileProperties':{'Salesforce':{'instanceUrl':c['instance'],'usePrivateLinkForMetadataAndAuthorization':True}},'credentialsArn':'SYNTHETIC-NOT-TO-PRINT'},
 'schema':[{'identifier':f,'sourceProperties':{'isRetrievable':True},'supportedFieldTypeDetails':{'v1':{'fieldType':'id' if f=='Id' else 'string'}}} for f in c['fields']],
 'key':{'Arn':c['kms'],'AWSAccountId':c['account'],'KeyManager':'CUSTOMER','KeyState':'Enabled','KeyUsage':'ENCRYPT_DECRYPT','KeySpec':'SYMMETRIC_DEFAULT'},
 'region':c['region'],'versioning':'Enabled','blocks':{k:True for k in ['BlockPublicAcls','IgnorePublicAcls','BlockPublicPolicy','RestrictPublicBuckets']},'policy':policy,
 'flow':{'flowName':c['name'],'flowArn':c['flowArn'],'flowStatus':'Draft','kmsArn':c['kms'],'triggerConfig':{'triggerType':'OnDemand'},'sourceFlowConfig':{'connectorType':'Salesforce','connectorProfileName':c['profile'],'sourceConnectorProperties':{'Salesforce':{'object':c['object'],'enableDynamicFieldUpdate':False,'includeDeletedRecords':False,'dataTransferApi':'REST_SYNC'}}},'destinationFlowConfigList':[{'connectorType':'S3','destinationConnectorProperties':{'S3':{'bucketName':c['bucket'],'bucketPrefix':c['prefix'],'s3OutputFormatConfig':{'fileType':c['format'],'aggregationConfig':{'aggregationType':'None'},'prefixConfig':{'prefixType':'PATH','prefixFormat':'DAY','prefixHierarchy':['EXECUTION_ID']}}}}}],'tasks':tasks},
 'execution':{'executionId':'exec-1234','executionStatus':'Successful','executionResult':{'recordsProcessed':50,'bytesProcessed':1000,'bytesWritten':1100}}}
class Config:
 def __init__(self,**kwargs): assert kwargs['use_fips_endpoint'] is True
class Session:
 def __init__(self,**kwargs): assert kwargs=={'region_name':c['region']}
 def client(self,name,**kwargs): assert name in ['sts','appflow','s3','kms']; assert kwargs['region_name']==c['region']; return self
 def get_caller_identity(self): return {'Account':data['account']}
 def describe_connector_profiles(self,**kwargs):
  assert kwargs.get('connectorProfileNames')==[c['profile']] and kwargs.get('connectorType')=='Salesforce' and kwargs.get('maxResults')==100
  if scenario in ['profile-page','profile-repeat'] and not kwargs.get('nextToken'): return {'connectorProfileDetails':[],'nextToken':'one'}
  return {'connectorProfileDetails':[data['profile']],**({'nextToken':'one'} if scenario=='profile-repeat' else {})}
 def describe_connector_entity(self,**kwargs): assert kwargs=={'connectorProfileName':c['profile'],'connectorType':'Salesforce','connectorEntityName':c['object']}; return {'connectorEntityFields':data['schema']}
 def bucket_args(self,kwargs): assert kwargs=={'Bucket':c['bucket'],'ExpectedBucketOwner':c['account']}
 def head_bucket(self,**kwargs): self.bucket_args(kwargs); return {}
 def get_bucket_location(self,**kwargs): self.bucket_args(kwargs); return {'LocationConstraint':data['region']}
 def get_public_access_block(self,**kwargs): self.bucket_args(kwargs); return {'PublicAccessBlockConfiguration':data['blocks']}
 def get_bucket_versioning(self,**kwargs): self.bucket_args(kwargs); return {'Status':data['versioning']}
 def get_bucket_encryption(self,**kwargs): self.bucket_args(kwargs); return {'ServerSideEncryptionConfiguration':{'Rules':[{'ApplyServerSideEncryptionByDefault':{'SSEAlgorithm':'AES256' if scenario=='s3-encryption' else 'aws:kms','KMSMasterKeyID':c['kms']}}]}}
 def describe_key(self,**kwargs): assert kwargs=={'KeyId':c['kms']}; return {'KeyMetadata':data['key']}
 def get_bucket_policy(self,**kwargs): self.bucket_args(kwargs); return {'Policy':json.dumps(data['policy'])}
 def list_objects_v2(self,**kwargs): assert kwargs=={'Bucket':c['bucket'],'ExpectedBucketOwner':c['account'],'Prefix':c['prefix'],'MaxKeys':1}; return {'Contents':[{'Key':'SYNTHETIC-NOT-TO-PRINT'}] if scenario=='occupied' else []}
 def list_flows(self,**kwargs):
  assert kwargs.get('maxResults')==100
  return {'flows':[{'flowName':c['name']}] if scenario=='existing' else []}
 def describe_flow(self,**kwargs): assert kwargs=={'flowName':c['name']}; return data['flow']
 def describe_flow_execution_records(self,**kwargs):
  assert kwargs.get('flowName')==c['name'] and kwargs.get('maxResults')==100
  if scenario in ['execution-page','execution-repeat'] and not kwargs.get('nextToken'): return {'flowExecutions':[],'nextToken':'one'}
  return {'flowExecutions':[data['execution']]+([data['execution']] if scenario=='execution-duplicate' else []) if scenario.startswith('execution') or scenario=='prior-run' else [],**({'nextToken':'one'} if scenario=='execution-repeat' else {})}
sdk=types.ModuleType('boto3'); sdk.Session=Session; sys.modules['boto3']=sdk; sys.modules['botocore']=types.ModuleType('botocore'); module=types.ModuleType('botocore.config'); module.Config=Config; sys.modules['botocore.config']=module
cases=[('preflight',[],None),('check',[],None),('profile-page',[],None),('profile-repeat',[],None),('existing',[],None),('occupied',[],None),('s3-encryption',[],None),('prior-run',[],None),('execution',[],None),('execution-page',[],None),('execution-repeat',[],None),('execution-duplicate',[],None),
 ('account',['account'],'other'),('profile-owner',['profile','connectorProfileArn'],'other'),('profile-public',['profile','connectionMode'],'Public'),('profile-pending',['profile','privateConnectionProvisioningState','status'],'PENDING'),('profile-instance',['profile','connectorProfileProperties','Salesforce','instanceUrl'],'https://other.my.salesforce.com'),('metadata-public',['profile','connectorProfileProperties','Salesforce','usePrivateLinkForMetadataAndAuthorization'],False),('schema-retrievable',['schema',0,'sourceProperties','isRetrievable'],False),('schema-type',['schema',0,'supportedFieldTypeDetails','v1','fieldType'],'string'),('bucket-region',['region'],'us-west-2'),('versioning',['versioning'],'Suspended'),('bucket-public',['blocks','RestrictPublicBuckets'],False),('key-owner',['key','AWSAccountId'],'other'),('key-state',['key','KeyState'],'Disabled'),('policy-absent',['policy','Statement'],[]),
 ('flow-owner',['flow','flowArn'],'other'),('flow-schedule',['flow','triggerConfig','triggerType'],'Scheduled'),('flow-object',['flow','sourceFlowConfig','sourceConnectorProperties','Salesforce','object'],'Contact'),('flow-newfields',['flow','sourceFlowConfig','sourceConnectorProperties','Salesforce','enableDynamicFieldUpdate'],True),('flow-destination',['flow','destinationFlowConfigList',0,'destinationConnectorProperties','S3','bucketName'],'other'),('flow-format',['flow','destinationFlowConfigList',0,'destinationConnectorProperties','S3','s3OutputFormatConfig','fileType'],'PARQUET'),('flow-tasks',['flow','tasks'],[{'taskType':'Map_all','sourceFields':[]}]),
 ('execution-failed',['execution','executionStatus'],'Error'),('execution-wrong',['execution','executionId'],'other'),('execution-errors',['execution','executionResult','errorInfo'],{'putFailuresCount':1,'executionMessage':'SYNTHETIC-NOT-TO-PRINT'}),('execution-count',['execution','executionResult','recordsProcessed'],-1)]
for scenario,path,value in cases:
 data=copy.deepcopy(base)
 if path:
  parent=data
  for key in path[:-1]: parent=parent[key]
  parent[path[-1]]=value
 flags=[] if scenario in ['preflight','existing','profile-page','profile-repeat'] else ['--check']
 if scenario.startswith('execution'): flags+=['--execution','exec-1234']
 sys.argv=['INSPECT.py']+flags; failure=None
 with contextlib.redirect_stdout(io.StringIO()) as output:
  try: runpy.run_path(str(root/'INSPECT.py'),run_name='__main__')
  except Exception as error: failure=error
 success=scenario in ['preflight','check','profile-page','execution','execution-page']
 assert bool(failure)!=success,(scenario,failure)
 assert 'SYNTHETIC-NOT-TO-PRINT' not in output.getvalue()
 if scenario in ['execution','execution-page']:
  report=json.loads(output.getvalue()); assert report['recordsProcessed']==50 and report['ownerReconciliationRequired'] is True and report['dataIntegrityProven'] is False
print(str(len(cases))+' generated AppFlow SDK checks passed; no AWS/SaaS records/transfers')
`);
const check=spawnSync(process.env.PYTHON_PATH||'python',[join(work,'test.py')],{encoding:'utf8',windowsHide:true});process.stdout.write((check.stdout||'')+(check.stderr||''));if(check.error)throw check.error;if(check.status!==0)throw new Error('Inspect '+work);console.log(work);
