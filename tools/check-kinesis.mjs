/** Exported Kinesis inspector SDK doubles, never reads/writes records. */
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_KINESIS_SERVICE as blueprint} from '../src/cloud/aws-kinesis-service.ts';
import {WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'kinesis-inspect-'));const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',account:'123456789012',name:'reviewed-events',mode:'PROVISIONED',shards:2,consumer:'reviewed-consumer',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc'});if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const name of ['INSPECT.py','KINESIS-CONFIG.json'])writeFileSync(join(work,name),result.files[name]);
writeFileSync(join(work,'test.py'),String.raw`import contextlib,copy,io,json,runpy,sys,types
from pathlib import Path
root=Path(__file__).resolve().parent;c=json.loads((root/'KINESIS-CONFIG.json').read_text());original=copy.deepcopy(c);arn='arn:aws:kinesis:us-east-1:'+c['account']+':stream/'+c['name'];ca=arn+'/consumer/'+c['consumer']+':12345'
base={'account':c['account'],'absent':False,'error':'ResourceNotFoundException','key':{'Arn':c['kms'],'KeyId':c['kms'].split('/')[-1],'KeyManager':'CUSTOMER','KeyState':'Enabled','KeySpec':'SYMMETRIC_DEFAULT','KeyUsage':'ENCRYPT_DECRYPT'},'stream':{'StreamARN':arn,'StreamName':c['name'],'StreamStatus':'ACTIVE','StreamModeDetails':{'StreamMode':'PROVISIONED'},'RetentionPeriodHours':c['retention'],'EncryptionType':'KMS','OpenShardCount':2,'KeyId':c['kms']},'consumers':[{'ConsumerName':c['consumer'],'ConsumerARN':ca,'ConsumerStatus':'ACTIVE'}],'consumer':{'StreamARN':arn,'ConsumerName':c['consumer'],'ConsumerARN':ca,'ConsumerStatus':'ACTIVE'}}
class ClientError(Exception):
 def __init__(self,code): self.response={'Error':{'Code':code}}
class Config:
 def __init__(self,**kw): assert kw['use_fips_endpoint']==(c['region'] in ['us-east-1','us-east-2','us-west-1','us-west-2','us-gov-east-1','us-gov-west-1'])
class Session:
 def __init__(self,**kw): assert kw=={'region_name':c['region']}
 def client(self,name,**kw): assert name in ['sts','kms','kinesis'];return self
 def get_caller_identity(self): return {'Account':data['account']}
 def describe_key(self,**kw): assert kw['KeyId'] in [c['kms'],'alias/aws/kinesis'];key_calls.append(kw['KeyId']);return {'KeyMetadata':data['key']}
 def describe_stream_summary(self,**kw):
  assert kw=={'StreamARN':arn}
  if data['absent']: raise ClientError(data['error'])
  return {'StreamDescriptionSummary':data['stream']}
 def list_stream_consumers(self,**kw):
  assert kw['StreamARN']==arn and kw['MaxResults']==100
  if scenario=='consumer-pages': return {'Consumers':data['consumers'] if kw.get('NextToken') else [],**({} if kw.get('NextToken') else {'NextToken':'two'})}
  if scenario=='consumer-token': return {'Consumers':[],'NextToken':'repeat'}
  return {'Consumers':data['consumers']}
 def describe_stream_consumer(self,**kw): assert kw=={'ConsumerARN':ca};return {'ConsumerDescription':data['consumer']}
sys.modules['boto3']=types.SimpleNamespace(Session=Session);sys.modules['botocore']=types.ModuleType('botocore');sys.modules['botocore.config']=types.SimpleNamespace(Config=Config);sys.modules['botocore.exceptions']=types.SimpleNamespace(ClientError=ClientError)
cases=['preflight','check','existing','denied','missing-post','owner','key-disabled','key-manager','key-arn','stream-arn','stream-state','stream-mode','stream-retention','stream-encryption','stream-key','shards','consumer-pages','consumer-token','consumer-extra','consumer-duplicate','consumer-state','consumer-arn','consumer-detail','on-demand','aws-key','aws-key-id','aws-key-alias','wrong-aws-key','no-consumer']
for scenario in cases:
 c=copy.deepcopy(original);data=copy.deepcopy(base);key_calls=[];flags=[] if scenario in ['preflight','existing','denied'] else ['--check']
 if scenario in ['preflight','denied','missing-post']: data['absent']=True
 if scenario=='denied': data['error']='AccessDeniedException'
 if scenario=='owner': data['account']='000000000000'
 if scenario=='key-disabled': data['key']['KeyState']='Disabled'
 if scenario=='key-manager': data['key']['KeyManager']='AWS'
 if scenario=='key-arn': data['key']['Arn']='other'
 if scenario=='stream-arn': data['stream']['StreamARN']=arn.replace(c['account'],'000000000000')
 if scenario=='stream-state': data['stream']['StreamStatus']='UPDATING'
 if scenario=='stream-mode': data['stream']['StreamModeDetails']['StreamMode']='ON_DEMAND'
 if scenario=='stream-retention': data['stream']['RetentionPeriodHours']=1
 if scenario=='stream-encryption': data['stream']['EncryptionType']='NONE'
 if scenario=='stream-key': data['stream']['KeyId']='wrong'
 if scenario=='shards': data['stream']['OpenShardCount']=3
 if scenario=='consumer-extra': data['consumers'].append({'ConsumerName':'unreviewed'})
 if scenario=='consumer-duplicate': data['consumers']*=2
 if scenario=='consumer-state': data['consumers'][0]['ConsumerStatus']='CREATING'
 if scenario=='consumer-arn': data['consumers'][0]['ConsumerARN']='wrong'
 if scenario=='consumer-detail': data['consumer']['StreamARN']='wrong'
 if scenario=='on-demand': c['mode']='ON_DEMAND';c['shards']=None;data['stream']['StreamModeDetails']['StreamMode']='ON_DEMAND';data['stream']['OpenShardCount']=4
 if scenario in ['aws-key','aws-key-id','aws-key-alias','wrong-aws-key']:
  c['kms']='';data['key']['KeyManager']='AWS' if scenario!='wrong-aws-key' else 'CUSTOMER'
  if scenario=='aws-key-id': data['stream']['KeyId']=data['key']['KeyId']
  if scenario=='aws-key-alias': data['stream']['KeyId']='alias/aws/kinesis'
 if scenario=='no-consumer': c['consumer']='';data['consumers']=[]
 (root/'KINESIS-CONFIG.json').write_text(json.dumps(c));sys.argv=['INSPECT.py']+flags;failure=None
 with contextlib.redirect_stdout(io.StringIO()) as out,contextlib.redirect_stderr(io.StringIO()):
  try: runpy.run_path(str(root/'INSPECT.py'),run_name='__main__')
  except BaseException as error: failure=error
 success=scenario in ['preflight','check','consumer-pages','on-demand','aws-key','aws-key-id','aws-key-alias','no-consumer'];assert bool(failure)!=success,(scenario,failure)
 if success:
  assert len(key_calls)==1
  if scenario!='preflight':
   report=json.loads(out.getvalue());assert report['streamMetadataVerified'] is True and report['recordIntegrityProven'] is False and report['consumerApplicationRunningProven'] is False
(root/'KINESIS-CONFIG.json').write_text(json.dumps(original))
print(str(len(cases))+' Kinesis stream/key/consumer/pagination cases passed; SDK doubles only')
`);
const check=spawnSync(process.env.PYTHON_PATH||'python',[join(work,'test.py')],{encoding:'utf8',windowsHide:true});process.stdout.write((check.stdout||'')+(check.stderr||''));if(check.error)throw check.error;if(check.status!==0)throw new Error('Inspect '+work);console.log(work);
