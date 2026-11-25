/** Actual global flag inspector against local SDK doubles, no live data or functions. */
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_CLOUDFRONT_KVS_SERVICE as blueprint} from '../src/cloud/aws-cloudfront-kvs-service.ts';
import {WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'cloudfront-kvs-inspect-'));const result=blueprint.build({...defaultValues(blueprint),name:'reviewed-edge',account:'123456789012',approved:'true'});if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const name of ['INSPECT.py','KVS-CONFIG.json'])writeFileSync(join(work,name),result.files[name]);
writeFileSync(join(work,'test.py'),String.raw`import contextlib,copy,io,json,runpy,sys,types
from pathlib import Path
root=Path(__file__).resolve().parent;c=json.loads((root/'KVS-CONFIG.json').read_text());identifier='12345678-abcd-4bcd-8bcd-123456789abc';arn='arn:aws:cloudfront::'+c['account']+':key-value-store/'+identifier
base={'account':c['account'],'existing':False,'devExists':True,'liveExists':False,'storeError':'EntityNotFound','functionError':'NoSuchFunctionExists','store':{'Name':c['name'],'Id':identifier,'ARN':arn,'Status':'READY'},'function':{'Name':c['functionName'],'FunctionMetadata':{'FunctionARN':'arn:aws:cloudfront::'+c['account']+':function/'+c['functionName'],'Stage':'DEVELOPMENT'},'FunctionConfig':{'Runtime':'cloudfront-js-2.0','KeyValueStoreAssociations':{'Quantity':1,'Items':[{'KeyValueStoreARN':arn}]}}},'metadata':{'KvsARN':arn,'ItemCount':1,'Status':'READY','ETag':'DATA-ETAG-NOT-CONTROL'},'flag':{'Key':c['key'],'Value':c['value'],'ItemCount':1}}
class ClientError(Exception):
 def __init__(self,code): self.response={'Error':{'Code':code}}
class Config:
 def __init__(self,**kw): self.kw=kw
class Session:
 def __init__(self,**kw): assert kw=={'region_name':'us-east-1'}
 def client(self,name,**kw):
  clients.append(name);assert name in ['sts','cloudfront','cloudfront-keyvaluestore'];cfg=kw['config'].kw
  if name=='cloudfront-keyvaluestore': assert cfg['use_fips_endpoint'] is False and cfg['signature_version']=='v4a';return Runtime()
  assert cfg['use_fips_endpoint'] is True;return self
 def get_caller_identity(self): return {'Account':data['account']}
 def describe_key_value_store(self,**kw):
  assert kw=={'Name':c['name']}
  if not data['existing']: raise ClientError(data['storeError'])
  return {'KeyValueStore':data['store'],'ETag':'CONTROL-ETAG-NOT-DATA'}
 def describe_function(self,**kw):
  assert kw['Name']==c['functionName'] and kw['Stage'] in ['DEVELOPMENT','LIVE']
  if not (data['devExists'] if kw['Stage']=='DEVELOPMENT' else data['liveExists']): raise ClientError(data['functionError'])
  return {'FunctionSummary':data['function']}
class Runtime:
 def describe_key_value_store(self,**kw): assert kw=={'KvsARN':arn};return data['metadata']
 def get_key(self,**kw): assert kw=={'KvsARN':arn,'Key':'migration_enabled'};return data['flag']
sys.modules['boto3']=types.SimpleNamespace(Session=Session);sys.modules['botocore']=types.ModuleType('botocore');sys.modules['botocore.config']=types.SimpleNamespace(Config=Config);sys.modules['botocore.exceptions']=types.SimpleNamespace(ClientError=ClientError)
cases=['preflight','check','existing-store','existing-development','existing-live','store-denied','function-denied','wrong-owner','store-arn','store-id','store-name','store-state','function-owner','function-stage','function-name','runtime','association','extra-association','live-post','data-arn','data-items','data-state','flag-value','flag-key','flag-items','missing-id','invalid-id','id-without-check']
pre=['preflight','existing-store','existing-development','existing-live','store-denied','function-denied']
for scenario in cases:
 data=copy.deepcopy(base);clients=[];flags=[] if scenario in pre else ['--check','--store-id',identifier]
 if scenario in pre: data['devExists']=False
 if scenario not in pre or scenario=='existing-store': data['existing']=True
 if scenario=='existing-development': data['devExists']=True
 if scenario=='existing-live': data['liveExists']=True
 if scenario=='store-denied': data['storeError']='AccessDenied'
 if scenario=='function-denied': data['functionError']='AccessDenied'
 if scenario=='wrong-owner': data['account']='000000000000'
 if scenario=='store-arn': data['store']['ARN']=arn.replace(c['account'],'000000000000')
 if scenario=='store-id': data['store']['Id']='other'
 if scenario=='store-name': data['store']['Name']='other'
 if scenario=='store-state': data['store']['Status']='PENDING'
 if scenario=='function-owner': data['function']['FunctionMetadata']['FunctionARN']='other'
 if scenario=='function-stage': data['function']['FunctionMetadata']['Stage']='LIVE'
 if scenario=='function-name': data['function']['Name']='other'
 if scenario=='runtime': data['function']['FunctionConfig']['Runtime']='cloudfront-js-1.0'
 if scenario=='association': data['function']['FunctionConfig']['KeyValueStoreAssociations']['Items'][0]['KeyValueStoreARN']='other'
 if scenario=='extra-association': data['function']['FunctionConfig']['KeyValueStoreAssociations']['Quantity']=2
 if scenario=='live-post': data['liveExists']=True
 if scenario=='data-arn': data['metadata']['KvsARN']='other'
 if scenario=='data-items': data['metadata']['ItemCount']=2
 if scenario=='data-state': data['metadata']['Status']='UPDATING'
 if scenario=='flag-value': data['flag']['Value']='SYNTHETIC-UNEXPECTED-SECRET-NOT-TO-PRINT'
 if scenario=='flag-key': data['flag']['Key']='other'
 if scenario=='flag-items': data['flag']['ItemCount']=2
 if scenario=='missing-id': flags=['--check']
 if scenario=='invalid-id': flags=['--check','--store-id','bad']
 if scenario=='id-without-check': flags=['--store-id',identifier]
 sys.argv=['INSPECT.py']+flags;failure=None
 with contextlib.redirect_stdout(io.StringIO()) as out,contextlib.redirect_stderr(io.StringIO()) as errors:
  try: runpy.run_path(str(root/'INSPECT.py'),run_name='__main__')
  except BaseException as error: failure=error
 success=scenario in ['preflight','check'];assert bool(failure)!=success,(scenario,failure)
 assert 'SYNTHETIC-UNEXPECTED-SECRET-NOT-TO-PRINT' not in out.getvalue()+errors.getvalue() and 'ETAG-NOT' not in out.getvalue()+errors.getvalue()
 if scenario=='preflight': assert 'cloudfront-keyvaluestore' not in clients
 if scenario=='check':
  report=json.loads(out.getvalue());assert report['storeAndDevelopmentFlagVerified'] is True and report['edgePropagationProven'] is False and report['distributionAssociationInventoryProven'] is False
print(str(len(cases))+' CloudFront/KVS separate-client/identity/stage/nonsecret-flag cases passed; SDK doubles only')
`);
const check=spawnSync(process.env.PYTHON_PATH||'python',[join(work,'test.py')],{encoding:'utf8',windowsHide:true});process.stdout.write((check.stdout||'')+(check.stderr||''));if(check.error)throw check.error;if(check.status!==0)throw new Error('Inspect '+work);console.log(work);
