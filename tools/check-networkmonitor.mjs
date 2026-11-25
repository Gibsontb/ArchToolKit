/** Actual exported synthetic probe inspector with SDK doubles, no packets or live AWS. */
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_NETWORKMONITOR_SERVICE as blueprint} from '../src/cloud/aws-networkmonitor-service.ts';
import {WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'networkmonitor-inspect-'));const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',name:'reviewed-hybrid',account:'123456789012',subnet:'subnet-12345678',destination:'10.200.0.10',approved:'true'});if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const name of ['INSPECT.py','NETWORK-CONFIG.json'])writeFileSync(join(work,name),result.files[name]);
writeFileSync(join(work,'test.py'),String.raw`import contextlib,copy,io,json,runpy,sys,types
from pathlib import Path
root=Path(__file__).resolve().parent;c=json.loads((root/'NETWORK-CONFIG.json').read_text());original=copy.deepcopy(c);vpc='vpc-12345678';identifier='probe-'+'a'*24;prefix='arn:aws:networkmonitor:'+c['region']+':'+c['account']+':'
probe={'probeId':identifier,'probeArn':prefix+'probe/'+identifier,'state':'ACTIVE','sourceArn':c['sourceArn'],'vpcId':vpc,'destination':c['destination'],'protocol':'TCP','addressFamily':'IPV4','packetSize':c['packet'],'destinationPort':443}
base={'account':c['account'],'subnet':{'SubnetId':c['subnet'],'OwnerId':c['account'],'State':'available','MapPublicIpOnLaunch':False,'AvailableIpAddressCount':20,'AvailabilityZone':'us-east-1a','VpcId':vpc},'vpc':{'VpcId':vpc,'OwnerId':c['account'],'State':'available','CidrBlock':'10.20.0.0/16'},'route':{'RouteTableId':'rtb-12345678','VpcId':vpc,'OwnerId':c['account'],'Routes':[{'DestinationCidrBlock':'10.200.0.0/16','TransitGatewayId':'tgw-12345678','State':'active'}]},'absent':False,'error':'ResourceNotFoundException','monitor':{'monitorName':c['name'],'monitorArn':prefix+'monitor/'+c['name'],'state':'ACTIVE','aggregationPeriod':60,'probes':[copy.deepcopy(probe)]},'probe':probe}
class ClientError(Exception):
 def __init__(self,code): self.response={'Error':{'Code':code}}
class Config:
 def __init__(self,**kw): assert kw['use_fips_endpoint'] is True
class Session:
 def __init__(self,**kw): assert kw=={'region_name':c['region']}
 def client(self,name,**kw): assert name in ['sts','ec2','networkmonitor'];return self
 def get_caller_identity(self): return {'Account':data['account']}
 def describe_subnets(self,**kw): assert kw=={'SubnetIds':[c['subnet']]};return {'Subnets':[data['subnet']]}
 def describe_vpcs(self,**kw): assert kw=={'VpcIds':[vpc]};return {'Vpcs':[data['vpc']]}
 def describe_route_tables(self,**kw):
  calls.append(kw);assert kw in [{'Filters':[{'Name':'association.subnet-id','Values':[c['subnet']]}]},{'Filters':[{'Name':'vpc-id','Values':[vpc]},{'Name':'association.main','Values':['true']}]}]
  return {'RouteTables':[] if scenario=='main-route' and len(calls)==1 else [data['route']]}
 def get_monitor(self,**kw):
  assert kw=={'monitorName':c['name']}
  if data['absent']: raise ClientError(data['error'])
  return data['monitor']
 def get_probe(self,**kw): assert kw=={'monitorName':c['name'],'probeId':identifier};return data['probe']
sys.modules['boto3']=types.SimpleNamespace(Session=Session);sys.modules['botocore']=types.ModuleType('botocore');sys.modules['botocore.config']=types.SimpleNamespace(Config=Config);sys.modules['botocore.exceptions']=types.SimpleNamespace(ClientError=ClientError)
cases=['preflight','check','main-route','existing','denied','missing-post','account','subnet-owner','public-subnet','low-ips','local-zone','vpc-owner','destination-local','no-route','blackhole-route','public-route','nat-route','route-owner','monitor-arn','monitor-state','aggregation','extra-probe','probe-id','probe-arn','probe-state','probe-source','probe-destination','probe-protocol','probe-port','probe-size','probe-vpc','probe-family','icmp','bad-id']
for scenario in cases:
 c=copy.deepcopy(original);data=copy.deepcopy(base);calls=[];flags=[] if scenario in ['preflight','existing','denied'] else ['--probe',identifier];p=data['probe']
 if scenario in ['preflight','denied','missing-post']: data['absent']=True
 if scenario=='denied': data['error']='AccessDeniedException'
 if scenario=='account': data['account']='000000000000'
 if scenario=='subnet-owner': data['subnet']['OwnerId']='000000000000'
 if scenario=='public-subnet': data['subnet']['MapPublicIpOnLaunch']=True
 if scenario=='low-ips': data['subnet']['AvailableIpAddressCount']=5
 if scenario=='local-zone': data['subnet']['AvailabilityZone']='us-east-1-bos-1a'
 if scenario=='vpc-owner': data['vpc']['OwnerId']='000000000000'
 if scenario=='destination-local': data['vpc']['CidrBlockAssociationSet']=[{'CidrBlock':'10.200.0.0/16','CidrBlockState':{'State':'associated'}}]
 if scenario=='no-route': data['route']['Routes']=[]
 if scenario=='blackhole-route': data['route']['Routes'].append({'DestinationCidrBlock':'10.200.0.0/24','State':'blackhole','TransitGatewayId':'tgw-other'})
 if scenario=='public-route': data['route']['Routes'].append({'DestinationCidrBlock':'0.0.0.0/0','State':'active','GatewayId':'igw-public'})
 if scenario=='nat-route': data['route']['Routes']=[{'DestinationCidrBlock':'0.0.0.0/0','State':'active','NatGatewayId':'nat-public'}]
 if scenario=='route-owner': data['route']['OwnerId']='000000000000'
 if scenario=='monitor-arn': data['monitor']['monitorArn']=data['monitor']['monitorArn'].replace(c['account'],'000000000000')
 if scenario=='monitor-state': data['monitor']['state']='ERROR'
 if scenario=='aggregation': data['monitor']['aggregationPeriod']=30
 if scenario=='extra-probe': data['monitor']['probes'].append(copy.deepcopy(p))
 if scenario=='probe-id': p['probeId']='other'
 if scenario=='probe-arn': p['probeArn']=data['monitor']['monitorArn']+'/probe/'+identifier
 if scenario=='probe-state': p['state']='INACTIVE'
 if scenario=='probe-source': p['sourceArn']='other'
 if scenario=='probe-destination': p['destination']='10.201.0.10'
 if scenario=='probe-protocol': p['protocol']='ICMP'
 if scenario=='probe-port': p['destinationPort']=22
 if scenario=='probe-size': p['packetSize']=100
 if scenario=='probe-vpc': p['vpcId']='vpc-other'
 if scenario=='probe-family': p['addressFamily']='IPV6'
 if scenario=='icmp':
  c['protocol']='ICMP';c['port']=None
  for row in [p,data['monitor']['probes'][0]]: row['protocol']='ICMP';row.pop('destinationPort')
 if scenario=='bad-id': flags=['--probe','bad']
 (root/'NETWORK-CONFIG.json').write_text(json.dumps(c));sys.argv=['INSPECT.py']+flags;failure=None
 with contextlib.redirect_stdout(io.StringIO()) as out,contextlib.redirect_stderr(io.StringIO()):
  try: runpy.run_path(str(root/'INSPECT.py'),run_name='__main__')
  except BaseException as error: failure=error
 success=scenario in ['preflight','check','main-route','icmp'];assert bool(failure)!=success,(scenario,failure)
 if success and scenario!='preflight':
  report=json.loads(out.getvalue());assert report['probeMetadataVerified'] is True and report['connectivityProven'] is False and report['applicationReadinessProven'] is False
(root/'NETWORK-CONFIG.json').write_text(json.dumps(original))
print(str(len(cases))+' network probe/source-route/identity/protocol cases passed; SDK doubles only, no active packets')
`);
const check=spawnSync(process.env.PYTHON_PATH||'python',[join(work,'test.py')],{encoding:'utf8',windowsHide:true});process.stdout.write((check.stdout||'')+(check.stderr||''));if(check.error)throw check.error;if(check.status!==0)throw new Error('Inspect '+work);console.log(work);
