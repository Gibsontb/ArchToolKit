/** Exported read-only Cloud WAN inspector, SDK doubles only. */
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_CLOUDWAN_SERVICE as blueprint} from '../src/cloud/aws-cloudwan-service.ts';
import {WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'cloudwan-inspect-'));
const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',name:'isolated-core',account:'123456789012',attachment:'vpc',vpc:'vpc-12345678',subnets:'subnet-12345678,subnet-abcdef12'});
for(const name of ['INSPECT.py','NETWORK-CONFIG.json','CORE-POLICY.json'])writeFileSync(join(work,name),result.files[name]);
writeFileSync(join(work,'test.py'),String.raw`import copy, contextlib, io, json, runpy, sys, types
from pathlib import Path
root=Path(__file__).resolve().parent
c=json.loads((root/'NETWORK-CONFIG.json').read_text()); desired=json.loads((root/'CORE-POLICY.json').read_text())
core_id='core-network-12345678'; global_id='global-network-12345678'; attachment_id='attachment-12345678'
arn='arn:aws:networkmanager::'+c['account']+':core-network/'+core_id
base={'account':c['account'],'vpc':{'VpcId':c['vpc'],'OwnerId':c['account'],'State':'available'},'dns':True,
 'subnets':[{'SubnetId':id,'SubnetArn':'arn:aws:ec2:'+c['region']+':'+c['account']+':subnet/'+id,'OwnerId':c['account'],'VpcId':c['vpc'],'State':'available','MapPublicIpOnLaunch':False,'AvailableIpAddressCount':20,'AvailabilityZoneId':'use1-az'+str(i+1)} for i,id in enumerate(c['subnets'])],
 'core':{'CoreNetworkId':core_id,'CoreNetworkArn':arn,'GlobalNetworkId':global_id,'State':'AVAILABLE','Description':c['name'],'Edges':[{'EdgeLocation':'us-east-1','Asn':64520}],'Segments':[{'Name':s,'SharedSegments':[]} for s in c['segments']]},
 'policy':{'CoreNetworkId':core_id,'Alias':'LIVE','PolicyDocument':json.dumps(desired)},
 'attachment':{'AttachmentId':attachment_id,'CoreNetworkId':core_id,'CoreNetworkArn':arn,'AttachmentType':'VPC','OwnerAccountId':c['account'],'ResourceArn':'arn:aws:ec2:'+c['region']+':'+c['account']+':vpc/'+c['vpc'],'EdgeLocation':c['region'],'State':'PENDING_ATTACHMENT_ACCEPTANCE','SegmentName':c['segment'],'AttachmentPolicyRuleNumber':100,'Tags':[{'Key':'stage','Value':c['segment']}]},
 'options':{'ApplianceModeSupport':False,'Ipv6Support':False},'attachment_subnets':[]}
base['attachment_subnets']=[s['SubnetArn'] for s in base['subnets']]
class Config:
 def __init__(self,**kwargs): assert kwargs['use_fips_endpoint'] is True
class Session:
 def __init__(self,**kwargs): assert kwargs=={'region_name':c['region']}
 def client(self,name,**kwargs):
  assert name in ['sts','ec2','networkmanager']; assert kwargs['region_name']==('us-west-2' if name=='networkmanager' else c['region']); return self
 def get_caller_identity(self): return {'Account':data['account']}
 def describe_vpcs(self,**kwargs): assert kwargs=={'VpcIds':[c['vpc']]}; return {'Vpcs':[data['vpc']]}
 def describe_vpc_attribute(self,**kwargs):
  assert kwargs['VpcId']==c['vpc']; key={'enableDnsSupport':'EnableDnsSupport','enableDnsHostnames':'EnableDnsHostnames'}[kwargs['Attribute']]; return {key:{'Value':data['dns']}}
 def describe_subnets(self,**kwargs): assert kwargs=={'SubnetIds':c['subnets']}; return {'Subnets':data['subnets']}
 def get_core_network(self,**kwargs): assert kwargs=={'CoreNetworkId':core_id}; return {'CoreNetwork':data['core']}
 def get_core_network_policy(self,**kwargs): assert kwargs=={'CoreNetworkId':core_id,'Alias':'LIVE'}; return {'CoreNetworkPolicy':data['policy']}
 def list_attachments(self,**kwargs):
  assert kwargs['CoreNetworkId']==core_id and kwargs['MaxResults']==100
  if scenario in ['page','repeat'] and not kwargs.get('NextToken'): return {'Attachments':[],'NextToken':'one'}
  return {'Attachments':[] if scenario=='missing' else [data['attachment']]+([{'AttachmentId':'unexpected'}] if scenario=='extra' else []),**({'NextToken':'one'} if scenario=='repeat' else {})}
 def get_vpc_attachment(self,**kwargs): assert kwargs=={'AttachmentId':attachment_id}; return {'VpcAttachment':{'Attachment':data['attachment'],'Options':data['options'],'SubnetArns':data['attachment_subnets']}}
sdk=types.ModuleType('boto3'); sdk.Session=Session; sys.modules['boto3']=sdk
sys.modules['botocore']=types.ModuleType('botocore'); module=types.ModuleType('botocore.config'); module.Config=Config; sys.modules['botocore.config']=module
cases=[('preflight',[],None),('pending',[],None),('available',[],None),('proposed',[],None),('page',[],None),('repeat',[],None),('missing',[],None),('extra',[],None),
 ('account',['account'],'000000000000'),('vpc-owner',['vpc','OwnerId'],'other'),('vpc-state',['vpc','State'],'pending'),('dns',['dns'],False),('subnet-owner',['subnets',0,'OwnerId'],'other'),('subnet-vpc',['subnets',0,'VpcId'],'other'),('subnet-public',['subnets',0,'MapPublicIpOnLaunch'],True),('subnet-az',['subnets',1,'AvailabilityZoneId'],'use1-az1'),('subnet-free',['subnets',0,'AvailableIpAddressCount'],0),('subnet-ipv6',['subnets',0,'Ipv6Native'],True),('subnet-outpost',['subnets',0,'OutpostArn'],'unexpected'),
 ('core-owner',['core','CoreNetworkArn'],'arn:aws:networkmanager::000000000000:core-network/'+core_id),('core-global',['core','GlobalNetworkId'],'other'),('core-state',['core','State'],'UPDATING'),('core-edge',['core','Edges',0,'EdgeLocation'],'us-west-2'),('core-asn',['core','Edges',0,'Asn'],65000),('core-share',['core','Segments',0,'SharedSegments'],['shared']),('policy-drift',['policy','PolicyDocument'],'{}'),('policy-alias',['policy','Alias'],'LATEST'),
 ('attachment-owner',['attachment','OwnerAccountId'],'other'),('attachment-core',['attachment','CoreNetworkId'],'other'),('attachment-vpc',['attachment','ResourceArn'],'other'),('attachment-region',['attachment','EdgeLocation'],'us-west-2'),('attachment-type',['attachment','AttachmentType'],'TRANSIT_GATEWAY_ROUTE_TABLE'),('attachment-state',['attachment','State'],'UPDATING'),('attachment-segment',['attachment','SegmentName'],'shared'),('attachment-rule',['attachment','AttachmentPolicyRuleNumber'],110),('attachment-proposed',['attachment','ProposedSegmentChange'],{'SegmentName':'other','AttachmentPolicyRuleNumber':100}),('attachment-error',['attachment','LastModificationErrors'],[{'Code':'bad'}]),('attachment-options',['options','Ipv6Support'],True),('attachment-groups',['options','SecurityGroupReferencingSupport'],True),('attachment-subnets',['attachment_subnets'],[])]
for scenario,path,value in cases:
 data=copy.deepcopy(base)
 if path:
  parent=data
  for key in path[:-1]: parent=parent[key]
  parent[path[-1]]=value
 if scenario=='available': data['attachment']['State']='AVAILABLE'
 if scenario=='proposed':
  data['attachment'].pop('SegmentName'); data['attachment']['ProposedSegmentChange']={'SegmentName':c['segment'],'AttachmentPolicyRuleNumber':100}
 flags=[] if scenario=='preflight' else ['--core',core_id,'--global-id',global_id,'--attachment',attachment_id]
 if scenario=='available': flags+=['--require-available']
 sys.argv=['INSPECT.py']+flags; failure=None
 with contextlib.redirect_stdout(io.StringIO()) as output:
  try: runpy.run_path(str(root/'INSPECT.py'),run_name='__main__')
  except Exception as error: failure=error
 success=scenario in ['preflight','pending','available','proposed','page']
 assert bool(failure)!=success,(scenario,failure)
print(str(len(cases))+' generated Cloud WAN SDK checks passed; no AWS calls')
`);
const check=spawnSync(process.env.PYTHON_PATH||'python',[join(work,'test.py')],{encoding:'utf8',windowsHide:true});
process.stdout.write((check.stdout||'')+(check.stderr||''));
if(check.error)throw check.error;
if(check.status!==0)throw new Error('Inspect '+work);
console.log(work);
