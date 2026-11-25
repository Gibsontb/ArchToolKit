/** Actual Internet Monitor metadata inspector with SDK doubles only. */
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_INTERNETMONITOR_SERVICE as blueprint} from '../src/cloud/aws-internetmonitor-service.ts';
import {WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'internetmonitor-inspect-'));const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',name:'reviewed-internet',account:'123456789012',vpcs:'vpc-12345678,vpc-abcdef12',approved:'true'});if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const name of ['INSPECT.py','INTERNET-CONFIG.json'])writeFileSync(join(work,name),result.files[name]);
writeFileSync(join(work,'test.py'),String.raw`import contextlib,copy,io,json,runpy,sys,types
from pathlib import Path
root=Path(__file__).resolve().parent;c=json.loads((root/'INTERNET-CONFIG.json').read_text())
base={'account':c['account'],'absent':False,'error':'ResourceNotFoundException','vpcs':[{'VpcId':id,'OwnerId':c['account'],'State':'available'} for id in c['vpcs']],'gateways':[{'InternetGatewayId':'igw-12345678','OwnerId':c['account'],'Attachments':[{'VpcId':c['vpcs'][0],'State':'available'}]}],
'monitor':{'MonitorName':c['name'],'MonitorArn':'arn:aws:internetmonitor:'+c['region']+':'+c['account']+':monitor/'+c['name'],'Status':'ACTIVE','Resources':c['resources'],'TrafficPercentageToMonitor':c['percentage'],'MaxCityNetworksToMonitor':c['cities'],'HealthEventsConfig':{'AvailabilityScoreThreshold':c['availability'],'PerformanceScoreThreshold':c['performance']},'ProcessingStatus':'OK'}}
class ClientError(Exception):
 def __init__(self,code): self.response={'Error':{'Code':code}}
class Config:
 def __init__(self,**kw): assert kw['use_fips_endpoint'] is True
class Session:
 def __init__(self,**kw): assert kw=={'region_name':c['region']}
 def client(self,name,**kw): assert name in ['sts','ec2','internetmonitor'];return self
 def get_caller_identity(self): return {'Account':data['account']}
 def describe_vpcs(self,**kw): assert kw=={'VpcIds':c['vpcs']};return {'Vpcs':data['vpcs']}
 def describe_internet_gateways(self,**kw): assert kw=={'Filters':[{'Name':'attachment.vpc-id','Values':[c['vpcs'][0]]}]};return {'InternetGateways':data['gateways']}
 def get_monitor(self,**kw):
  assert kw=={'MonitorName':c['name']}
  if data['absent']: raise ClientError(data['error'])
  return data['monitor']
sys.modules['boto3']=types.SimpleNamespace(Session=Session);sys.modules['botocore']=types.ModuleType('botocore');sys.modules['botocore.config']=types.SimpleNamespace(Config=Config);sys.modules['botocore.exceptions']=types.SimpleNamespace(ClientError=ClientError)
cases=['preflight','check','existing','denied','missing-post','account','missing-vpc','duplicate-vpc','foreign-vpc','bad-vpc','missing-gateway','foreign-gateway','wrong-attachment','monitor-arn','monitor-status','monitor-name','extra-source','duplicate-source','missing-source','traffic-cap','city-cap','availability','performance','collecting','insufficient','processing-fault','s3-export','s3-disabled']
for scenario in cases:
 data=copy.deepcopy(base);flags=[] if scenario in ['preflight','existing','denied'] else ['--check'];m=data['monitor']
 if scenario in ['preflight','denied','missing-post']: data['absent']=True
 if scenario=='denied': data['error']='AccessDeniedException'
 if scenario=='account': data['account']='000000000000'
 if scenario=='missing-vpc': data['vpcs'].pop()
 if scenario=='duplicate-vpc': data['vpcs'][1]=copy.deepcopy(data['vpcs'][0])
 if scenario=='foreign-vpc': data['vpcs'][0]['OwnerId']='000000000000'
 if scenario=='bad-vpc': data['vpcs'][0]['State']='pending'
 if scenario=='missing-gateway': data['gateways']=[]
 if scenario=='foreign-gateway': data['gateways'][0]['OwnerId']='000000000000'
 if scenario=='wrong-attachment': data['gateways'][0]['Attachments'][0]['VpcId']=c['vpcs'][1]
 if scenario=='monitor-arn': m['MonitorArn']=m['MonitorArn'].replace(c['account'],'000000000000')
 if scenario=='monitor-status': m['Status']='INACTIVE'
 if scenario=='monitor-name': m['MonitorName']='wrong'
 if scenario=='extra-source': m['Resources'].append('arn:aws:ec2:us-east-1:123456789012:vpc/vpc-other')
 if scenario=='duplicate-source': m['Resources'].append(m['Resources'][0])
 if scenario=='missing-source': m['Resources'].pop()
 if scenario=='traffic-cap': m['TrafficPercentageToMonitor']=1
 if scenario=='city-cap': m['MaxCityNetworksToMonitor']=1000
 if scenario=='availability': m['HealthEventsConfig']['AvailabilityScoreThreshold']=50
 if scenario=='performance': m['HealthEventsConfig']['PerformanceScoreThreshold']=50
 if scenario=='collecting': m['ProcessingStatus']='COLLECTING_DATA'
 if scenario=='insufficient': m['ProcessingStatus']='INSUFFICIENT_DATA'
 if scenario=='processing-fault': m['ProcessingStatus']='FAULT_ACCESS_CLOUDWATCH'
 if scenario in ['s3-export','s3-disabled']: m['InternetMeasurementsLogDelivery']={'S3Config':{'BucketName':'unreviewed','LogDeliveryStatus':'ENABLED' if scenario=='s3-export' else 'DISABLED'}}
 sys.argv=['INSPECT.py']+flags;failure=None
 with contextlib.redirect_stdout(io.StringIO()) as out,contextlib.redirect_stderr(io.StringIO()):
  try: runpy.run_path(str(root/'INSPECT.py'),run_name='__main__')
  except BaseException as error: failure=error
 success=scenario in ['preflight','check','collecting','insufficient','s3-disabled'];assert bool(failure)!=success,(scenario,failure)
 if success and scenario!='preflight':
  report=json.loads(out.getvalue());assert report['monitorMetadataVerified'] is True and report['coverageCompletenessProven'] is False and report['logEncryptionAndRetentionProven'] is False
print(str(len(cases))+' Internet Monitor source/owner/gateway/coverage/processing cases passed; SDK doubles only')
`);
const check=spawnSync(process.env.PYTHON_PATH||'python',[join(work,'test.py')],{encoding:'utf8',windowsHide:true});process.stdout.write((check.stdout||'')+(check.stderr||''));if(check.error)throw check.error;if(check.status!==0)throw new Error('Inspect '+work);console.log(work);
