/** Application Insights actual exported metadata checker; SDK doubles only, no agents/SSM commands. */
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_APPINSIGHTS_SERVICE as blueprint} from '../src/cloud/aws-appinsights-service.ts';
import {WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'appinsights-inspect-'));const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',account:'123456789012',group:'reviewed-compute',instances:'i-12345678,i-abcdef12',tag_key:'MonitoringScope',tag_value:'reviewed-compute',approved:'true'});if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const name of ['INSPECT.py','APPINSIGHTS-CONFIG.json'])writeFileSync(join(work,name),result.files[name]);
writeFileSync(join(work,'test.py'),String.raw`import contextlib,copy,io,json,runpy,sys,types
from pathlib import Path
root=Path(__file__).resolve().parent;c=json.loads((root/'APPINSIGHTS-CONFIG.json').read_text())
base={'account':c['account'],'group':{'Name':c['group'],'GroupArn':c['groupArn']},'query':{'Type':'TAG_FILTERS_1_0','Query':json.dumps({'ResourceTypeFilters':['AWS::EC2::Instance'],'TagFilters':[{'Key':c['tagKey'],'Values':[c['tagValue']]}]})},'resources':[{'Identifier':{'ResourceArn':arn,'ResourceType':'AWS::EC2::Instance'}} for arn in c['resources']],
'instances':[{'InstanceId':id,'State':{'Name':'running'},'IamInstanceProfile':{'Arn':'arn:aws:iam::'+c['account']+':instance-profile/approved'},'Tags':[{'Key':c['tagKey'],'Value':c['tagValue']}]} for id in c['instances']],
'ssm':[{'InstanceId':id,'PingStatus':'Online','ResourceType':'EC2Instance','PlatformType':'Linux' if i==0 else 'Windows','AgentVersion':'3.3.1957.0'} for i,id in enumerate(c['instances'])],'asg':[],'absent':False,'error':'ResourceNotFoundException',
'app':{'AccountId':c['account'],'ResourceGroupName':c['group'],'DiscoveryType':'RESOURCE_GROUP_BASED','AutoConfigEnabled':False,'CWEMonitorEnabled':True,'OpsCenterEnabled':False,'AttachMissingPermission':False},
'components':[{'ComponentName':'component-'+str(i),'Monitor':True,'Tier':'DEFAULT'} for i in range(2)],'members':[[arn] for arn in c['resources']]}
class ClientError(Exception):
 def __init__(self,code): self.response={'Error':{'Code':code}}
class Config:
 def __init__(self,**kw): assert kw['use_fips_endpoint'] is True
class Session:
 def __init__(self,**kw): assert kw=={'region_name':c['region']}
 def client(self,name,**kw): assert name in ['sts','resource-groups','ec2','ssm','autoscaling','application-insights'];return self
 def get_caller_identity(self): return {'Account':data['account']}
 def get_group(self,**kw): assert kw=={'Group':c['group']};return {'Group':data['group']}
 def get_group_query(self,**kw): assert kw=={'Group':c['group']};return {'GroupQuery':{'GroupName':c['group'],'ResourceQuery':data['query']}}
 def list_group_resources(self,**kw):
  assert kw['Group']==c['group'] and kw['MaxResults']==50 and 'Filters' not in kw
  if scenario=='group-token': return {'Resources':[],'NextToken':'repeat'}
  if scenario=='group-errors': return {'Resources':data['resources'],'QueryErrors':[{'ErrorCode':'RESOURCE_TYPE_NOT_SUPPORTED'}]}
  if scenario=='group-pages': return {'Resources':data['resources'][1:] if kw.get('NextToken') else data['resources'][:1],**({} if kw.get('NextToken') else {'NextToken':'two'})}
  if scenario=='legacy-only': return {'ResourceIdentifiers':[r['Identifier'] for r in data['resources']]}
  return {'Resources':data['resources'],'ResourceIdentifiers':[r['Identifier'] for r in data['resources']]}
 def describe_instances(self,**kw):
  assert kw['Filters']==[{'Name':'tag:'+c['tagKey'],'Values':[c['tagValue']]}] and kw['MaxResults']==100
  if scenario=='instance-pages': return {'Reservations':[{'Instances':data['instances'][1:] if kw.get('NextToken') else data['instances'][:1]}],**({} if kw.get('NextToken') else {'NextToken':'two'})}
  return {'Reservations':[{'Instances':data['instances']}]}
 def describe_instance_information(self,**kw):
  assert kw['Filters']==[{'Key':'InstanceIds','Values':c['instances']}] and kw['MaxResults']==50
  if scenario=='ssm-pages': return {'InstanceInformationList':data['ssm'][1:] if kw.get('NextToken') else data['ssm'][:1],**({} if kw.get('NextToken') else {'NextToken':'two'})}
  return {'InstanceInformationList':data['ssm']}
 def describe_tags(self,**kw): assert kw['Filters']==[{'Name':'key','Values':[c['tagKey']]},{'Name':'value','Values':[c['tagValue']]}] and kw['MaxRecords']==100;return {'Tags':data['asg']}
 def describe_application(self,**kw):
  assert kw=={'ResourceGroupName':c['group'],'AccountId':c['account']}
  if data['absent']: raise ClientError(data['error'])
  return {'ApplicationInfo':data['app']}
 def list_components(self,**kw):
  assert kw['ResourceGroupName']==c['group'] and kw['AccountId']==c['account'] and kw['MaxResults']==40
  if scenario=='component-pages': return {'ApplicationComponentList':data['components'][1:] if kw.get('NextToken') else data['components'][:1],**({} if kw.get('NextToken') else {'NextToken':'two'})}
  return {'ApplicationComponentList':data['components']}
 def describe_component(self,**kw):
  assert kw['ResourceGroupName']==c['group'] and kw['AccountId']==c['account'];i=int(kw['ComponentName'].split('-')[-1]);return {'ApplicationComponent':data['components'][i],'ResourceList':data['members'][i]}
sys.modules['boto3']=types.SimpleNamespace(Session=Session);sys.modules['botocore']=types.ModuleType('botocore');sys.modules['botocore.config']=types.SimpleNamespace(Config=Config);sys.modules['botocore.exceptions']=types.SimpleNamespace(ClientError=ClientError)
cases=['preflight','check','legacy-only','group-pages','instance-pages','ssm-pages','component-pages','existing','denied','missing-post','account','group-owner','query-all','query-extra-tag','group-extra','group-duplicate','group-pending','group-token','group-errors','instance-extra','instance-duplicate','instance-stopped','instance-profile','instance-asg','ssm-missing','ssm-duplicate','ssm-offline','ssm-platform','matching-asg','app-owner','account-wide','future-auto','missing-permissions','ops-center','sns','remarks','component-off','component-tier','component-extra','component-duplicate','resource-overlap','resource-outside','resource-missing']
for scenario in cases:
 data=copy.deepcopy(base);flags=[] if scenario in ['preflight','existing','denied'] else ['--check']
 if scenario in ['preflight','denied','missing-post']: data['absent']=True
 if scenario=='denied': data['error']='ValidationException'
 if scenario=='account': data['account']='000000000000'
 if scenario=='group-owner': data['group']['GroupArn']=c['groupArn'].replace(c['account'],'000000000000')
 if scenario=='query-all': data['query']['Query']=json.dumps({'ResourceTypeFilters':['AWS::AllSupported'],'TagFilters':[{'Key':c['tagKey'],'Values':[c['tagValue']]}]})
 if scenario=='query-extra-tag': q=json.loads(data['query']['Query']);q['TagFilters'].append({'Key':'other','Values':['expansion']});data['query']['Query']=json.dumps(q)
 if scenario=='group-extra': data['resources'].append({'Identifier':{'ResourceArn':'other','ResourceType':'AWS::EC2::Instance'}})
 if scenario=='group-duplicate': data['resources'].append(copy.deepcopy(data['resources'][0]))
 if scenario=='group-pending': data['resources'][0]['Status']={'Name':'PENDING'}
 if scenario=='instance-extra': data['instances'].append(dict(data['instances'][0],InstanceId='i-00000000'))
 if scenario=='instance-duplicate': data['instances'].append(copy.deepcopy(data['instances'][0]))
 if scenario=='instance-stopped': data['instances'][0]['State']['Name']='stopped'
 if scenario=='instance-profile': data['instances'][0]['IamInstanceProfile']={}
 if scenario=='instance-asg': data['instances'][0]['Tags'].append({'Key':'aws:autoscaling:groupName','Value':'unreviewed'})
 if scenario=='ssm-missing': data['ssm'].pop()
 if scenario=='ssm-duplicate': data['ssm'].append(copy.deepcopy(data['ssm'][0]))
 if scenario=='ssm-offline': data['ssm'][0]['PingStatus']='ConnectionLost'
 if scenario=='ssm-platform': data['ssm'][0]['PlatformType']='MacOS'
 if scenario=='matching-asg': data['asg']=[{'ResourceId':'unreviewed-asg','Key':c['tagKey'],'Value':c['tagValue']}]
 if scenario=='app-owner': data['app']['AccountId']='000000000000'
 if scenario=='account-wide': data['app']['DiscoveryType']='ACCOUNT_BASED'
 if scenario=='future-auto': data['app']['AutoConfigEnabled']=True
 if scenario=='missing-permissions': data['app']['AttachMissingPermission']=True
 if scenario=='ops-center': data['app']['OpsCenterEnabled']=True
 if scenario=='sns': data['app']['SNSNotificationArn']='unreviewed-topic'
 if scenario=='remarks': data['app']['Remarks']='SYNTHETIC-UNEXPECTED-DETAIL-NOT-TO-PRINT'
 if scenario=='component-off': data['components'][0]['Monitor']=False
 if scenario=='component-tier': data['components'][0]['Tier']='SQL_SERVER'
 if scenario=='component-extra': data['components'].append({'ComponentName':'unreviewed'})
 if scenario=='component-duplicate': data['components'].append(copy.deepcopy(data['components'][0]))
 if scenario=='resource-overlap': data['members'][1]=data['members'][0]
 if scenario=='resource-outside': data['members'][0]=['other']
 if scenario=='resource-missing': data['members'][0]=[]
 sys.argv=['INSPECT.py']+flags;failure=None
 with contextlib.redirect_stdout(io.StringIO()) as out,contextlib.redirect_stderr(io.StringIO()) as errors:
  try: runpy.run_path(str(root/'INSPECT.py'),run_name='__main__')
  except BaseException as error: failure=error
 success=scenario in ['preflight','check','legacy-only','group-pages','instance-pages','ssm-pages','component-pages'];assert bool(failure)!=success,(scenario,failure)
 assert 'SYNTHETIC-UNEXPECTED-DETAIL-NOT-TO-PRINT' not in out.getvalue()+errors.getvalue()
 if success and scenario!='preflight':
  report=json.loads(out.getvalue());assert report['applicationComponentMetadataVerified'] is True and report['expectedEc2Instances']==2 and report['actualTelemetryProven'] is False and report['guestAgentConfigurationProven'] is False
print(str(len(cases))+' Application Insights group/SSM/ASG/component metadata cases passed; SDK doubles only, no agent/IAM/log actions')
`);
const check=spawnSync(process.env.PYTHON_PATH||'python',[join(work,'test.py')],{encoding:'utf8',windowsHide:true});process.stdout.write((check.stdout||'')+(check.stderr||''));if(check.error)throw check.error;if(check.status!==0)throw new Error('Inspect '+work);console.log(work);
