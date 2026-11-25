/** Generated inspector metadata doubles, no AWS credentials, file/object data or live APIs. */
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_STORAGEGATEWAY_SERVICE as blueprint} from '../src/cloud/aws-storagegateway-service.ts';
import {WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'storagegateway-inspect-'));
const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',name:'approved-files',account:'123456789012',gateway:'arn:aws:storagegateway:us-east-1:123456789012:gateway/sgw-1234ABCD',bucket:'approved-file-storage',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc',audit:'/approved/file-audit',clients:'10.20.0.0/24'});
if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const name of ['INSPECT.py','FILESHARE-CONFIG.json'])writeFileSync(join(work,name),result.files[name]);
writeFileSync(join(work,'test.py'),String.raw`import contextlib, copy, io, json, runpy, sys, types
from pathlib import Path
root=Path(__file__).resolve().parent; c=json.loads((root/'FILESHARE-CONFIG.json').read_text())
share_arn='arn:aws:storagegateway:'+c['region']+':'+c['account']+':share/share-1234ABCD'
audit_arn='arn:aws:logs:'+c['region']+':'+c['account']+':log-group:'+c['audit']
target='arn:aws:s3:::'+c['bucket']+'/'+c['prefix']
base={'account':c['account'],'gateway':{'GatewayARN':c['gateway'],'GatewayType':'FILE_S3','GatewayState':'STATE_RUNNING','EndpointType':'FIPS','GatewayNetworkInterfaces':[{'Ipv4Address':'10.20.0.10'}]},'cache':{'GatewayARN':c['gateway'],'DiskIds':['cache-disk'],'CacheAllocatedInBytes':200000000000},
 'location':c['region'],'versioning':'Enabled','blocks':{k:True for k in ['BlockPublicAcls','IgnorePublicAcls','BlockPublicPolicy','RestrictPublicBuckets']},'ownership':'BucketOwnerEnforced','encryption':{'SSEAlgorithm':'aws:kms','KMSMasterKeyID':c['kms']},
 'key':{'AWSAccountId':c['account'],'KeyManager':'CUSTOMER','KeyState':'Enabled','KeyUsage':'ENCRYPT_DECRYPT','KeySpec':'SYMMETRIC_DEFAULT','Arn':c['kms']},
 'log':{'logGroupName':c['audit'],'arn':audit_arn+':*','retentionInDays':90,'kmsKeyId':c['kms']},
 'share':{'FileShareARN':share_arn,'GatewayARN':c['gateway'],'LocationARN':target,'Role':'arn:aws:iam::'+c['account']+':role/'+c['role'],'FileShareName':c['name'],'FileShareStatus':'AVAILABLE','KMSEncrypted':True,'KMSKey':c['kms'],'AuditDestinationARN':audit_arn,'ReadOnly':True,'Squash':c['squash'],'DefaultStorageClass':c['storage'],'ObjectACL':'bucket-owner-full-control','RequesterPays':False,'GuessMIMETypeEnabled':False,'ClientList':c['clients'],'CacheAttributes':{'CacheStaleTimeoutInSeconds':c['ttl']},'NFSFileShareDefaults':{'OwnerId':c['uid'],'GroupId':c['gid'],'FileMode':c['fileMode'],'DirectoryMode':c['directoryMode']}}}
class Config:
 def __init__(self,**kwargs): assert kwargs['use_fips_endpoint'] is True
class Session:
 def __init__(self,**kwargs): assert kwargs=={'region_name':c['region']}
 def client(self,name,**kwargs): assert name in ['sts','storagegateway','s3','kms','logs']; assert kwargs['region_name']==c['region']; return self
 def get_caller_identity(self): return {'Account':data['account']}
 def describe_gateway_information(self,**kwargs): assert kwargs=={'GatewayARN':c['gateway']}; return data['gateway']
 def describe_cache(self,**kwargs): assert kwargs=={'GatewayARN':c['gateway']}; return data['cache']
 def check_bucket(self,kwargs): assert kwargs=={'Bucket':c['bucket'],'ExpectedBucketOwner':c['account']}
 def head_bucket(self,**kwargs): self.check_bucket(kwargs); return {}
 def get_bucket_location(self,**kwargs): self.check_bucket(kwargs); return {'LocationConstraint':data['location']}
 def get_bucket_versioning(self,**kwargs): self.check_bucket(kwargs); return {'Status':data['versioning']}
 def get_public_access_block(self,**kwargs): self.check_bucket(kwargs); return {'PublicAccessBlockConfiguration':data['blocks']}
 def get_bucket_ownership_controls(self,**kwargs): self.check_bucket(kwargs); return {'OwnershipControls':{'Rules':[{'ObjectOwnership':data['ownership']}]}}
 def get_bucket_encryption(self,**kwargs): self.check_bucket(kwargs); return {'ServerSideEncryptionConfiguration':{'Rules':[{'ApplyServerSideEncryptionByDefault':data['encryption']}]}}
 def describe_key(self,**kwargs): assert kwargs['KeyId']==c['kms']; return {'KeyMetadata':data['key']}
 def describe_log_groups(self,**kwargs):
  assert kwargs['logGroupNamePrefix']==c['audit']
  if scenario in ['log-page','log-repeat'] and not kwargs.get('nextToken'): return {'logGroups':[],'nextToken':'one'}
  return {'logGroups':[data['log']],**({'nextToken':'one'} if scenario=='log-repeat' else {})}
 def list_file_shares(self,**kwargs):
  assert kwargs.get('Limit')==100 and 'GatewayARN' not in kwargs
  if scenario in ['share-page','share-repeat'] and not kwargs.get('Marker'): return {'FileShareInfoList':[],'NextMarker':'one'}
  items=[] if scenario in ['preflight','log-page','log-repeat','null-region'] else [{'FileShareARN':share_arn,'FileShareType':'NFS'}]
  if scenario in ['overlap','smb-overlap','distinct-prefix']: items=[{'FileShareARN':'other','FileShareType':'SMB' if scenario=='smb-overlap' else 'NFS'}]
  return {'FileShareInfoList':items,**({'NextMarker':'one'} if scenario=='share-repeat' else {})}
 def describe_nfs_file_shares(self,**kwargs):
  if kwargs=={'FileShareARNList':['other']}: return {'NFSFileShareInfoList':[{'FileShareARN':'other','LocationARN':'arn:aws:s3:::'+c['bucket']+('/different/' if scenario=='distinct-prefix' else '/')} ]}
  assert kwargs=={'FileShareARNList':[share_arn]}; return {'NFSFileShareInfoList':[data['share']]}
 def describe_smb_file_shares(self,**kwargs): assert kwargs=={'FileShareARNList':['other']}; return {'SMBFileShareInfoList':[{'FileShareARN':'other','LocationARN':target+'nested/'}]}
sdk=types.ModuleType('boto3'); sdk.Session=Session; sys.modules['boto3']=sdk; sys.modules['botocore']=types.ModuleType('botocore'); module=types.ModuleType('botocore.config'); module.Config=Config; sys.modules['botocore.config']=module
cases=[('preflight',[],None),('check',[],None),('null-region',[],None),('log-page',[],None),('log-repeat',[],None),('share-page',[],None),('share-repeat',[],None),('overlap',[],None),('smb-overlap',[],None),('distinct-prefix',[],None),
 ('account',['account'],'other'),('gateway-type',['gateway','GatewayType'],'FILE_FSX_SMB'),('gateway-down',['gateway','GatewayState'],'STATE_SHUTDOWN'),('gateway-endpoint',['gateway','EndpointType'],'STANDARD'),('gateway-public',['gateway','GatewayNetworkInterfaces',0,'Ipv4Address'],'203.0.113.1'),('cache-none',['cache','DiskIds'],[]),('cache-empty',['cache','CacheAllocatedInBytes'],0),('bucket-region',['location'],'us-west-2'),('versioning',['versioning'],'Suspended'),('public',['blocks','BlockPublicPolicy'],False),('ownership',['ownership'],'ObjectWriter'),('encryption',['encryption','SSEAlgorithm'],'aws:kms:dsse'),('key-owner',['key','AWSAccountId'],'other'),('key-state',['key','KeyState'],'PendingDeletion'),('key-type',['key','KeySpec'],'RSA_2048'),('audit-retention',['log','retentionInDays'],0),('audit-owner',['log','arn'],'other'),
 ('share-state',['share','FileShareStatus'],'CREATING'),('share-gateway',['share','GatewayARN'],'other'),('share-location',['share','LocationARN'],'other'),('share-role',['share','Role'],'other'),('share-mode',['share','ReadOnly'],False),('share-root',['share','Squash'],'NoSquash'),('share-public',['share','ClientList'],['0.0.0.0/0']),('share-permissions',['share','NFSFileShareDefaults','FileMode'],'0666'),('share-uid',['share','NFSFileShareDefaults','OwnerId'],0),('share-cache',['share','CacheAttributes','CacheStaleTimeoutInSeconds'],1),('share-dsse',['share','EncryptionType'],'DsseKms'),('share-endpoint',['share','VPCEndpointDNSName'],'unexpected'),('share-notify',['share','NotificationPolicy'],'{"Upload":{"SettlingTimeInSeconds":60}}')]
for scenario,path,value in cases:
 data=copy.deepcopy(base)
 if path:
  parent=data
  for key in path[:-1]: parent=parent[key]
  parent[path[-1]]=value
 if scenario=='null-region': data['location']=None
 flags=[] if scenario in ['preflight','null-region','log-page','log-repeat','overlap','smb-overlap','distinct-prefix'] else ['--share',share_arn]
 sys.argv=['INSPECT.py']+flags; failure=None
 with contextlib.redirect_stdout(io.StringIO()):
  try: runpy.run_path(str(root/'INSPECT.py'),run_name='__main__')
  except Exception as error: failure=error
 success=scenario in ['preflight','check','null-region','log-page','share-page','distinct-prefix']
 assert bool(failure)!=success,(scenario,failure)
print(str(len(cases))+' exported Storage Gateway SDK checks passed; no live APIs or file/object data')
`);
const check=spawnSync(process.env.PYTHON_PATH||'python',[join(work,'test.py')],{encoding:'utf8',windowsHide:true});
process.stdout.write((check.stdout||'')+(check.stderr||''));if(check.error)throw check.error;if(check.status!==0)throw new Error('Inspect '+work);console.log(work);
