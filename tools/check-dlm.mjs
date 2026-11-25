/** Runs the actual exported DLM inspector against local SDK doubles only. */
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_DLM_SERVICE as blueprint} from '../src/cloud/aws-dlm-service.ts';
import {WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'dlm-inspect-'));
const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',name:'reviewed-backups',account:'123456789012',volumes:'vol-12345678,vol-abcdef12',keys:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc',role:'arn:aws:iam::123456789012:role/service-role/dlm-execution',tag_value:'reviewed-estate'});
if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const name of ['INSPECT.py','CHECK-SNAPSHOTS.py','DLM-CONFIG.json'])writeFileSync(join(work,name),result.files[name]);
writeFileSync(join(work,'test.py'),String.raw`import contextlib,copy,io,json,runpy,sys,types
from pathlib import Path
root=Path(__file__).resolve().parent;c=json.loads((root/'DLM-CONFIG.json').read_text());identifier='policy-12345678'
base={'account':c['account'],'volumes':[{'VolumeId':id,'State':'in-use','Encrypted':True,'KmsKeyId':c['keys'][0],'AvailabilityZone':'us-east-1a','Size':100,'Tags':[{'Key':c['tagKey'],'Value':c['tagValue']}]} for id in c['volumes']],
'key':{'Arn':c['keys'][0],'AWSAccountId':c['account'],'KeyManager':'CUSTOMER','KeyState':'Enabled','KeySpec':'SYMMETRIC_DEFAULT','KeyUsage':'ENCRYPT_DECRYPT'},
'role':{'Arn':c['role'],'AssumeRolePolicyDocument':{'Statement':[{'Effect':'Allow','Action':'sts:AssumeRole','Principal':{'Service':'dlm.amazonaws.com'}}]}},'summaries':[],
'policy':{'PolicyId':identifier,'PolicyArn':'arn:aws:dlm:'+c['region']+':'+c['account']+':policy/'+identifier,'Description':c['name'],'ExecutionRoleArn':c['role'],'State':'DISABLED','PolicyDetails':{'PolicyType':'EBS_SNAPSHOT_MANAGEMENT','ResourceTypes':['VOLUME'],'ResourceLocations':['CLOUD'],'TargetTags':[{'Key':c['tagKey'],'Value':c['tagValue']}],'Schedules':[{'Name':'reviewed-volume-snapshots','CopyTags':False,'TagsToAdd':[{'Key':'BackupPlan','Value':c['name']}],'CreateRule':{'Interval':c['interval'],'IntervalUnit':'HOURS','Times':[c['time']],'Location':'CLOUD'},'RetainRule':{'Count':c['retain']}}]}}}
class Config:
 def __init__(self,**kw): assert kw['use_fips_endpoint'] is True
class Session:
 def __init__(self,**kw): assert kw=={'region_name':c['region']}
 def client(self,name,**kw): assert name in ['sts','ec2','kms','iam','dlm'];return self
 def get_caller_identity(self): return {'Account':data['account']}
 def describe_volumes(self,**kw):
  calls.append(('volumes',kw));assert kw['Filters']==[{'Name':'tag:'+c['tagKey'],'Values':[c['tagValue']]}] and kw['MaxResults']==500
  if scenario=='pagination': return {'Volumes':data['volumes'][1:] if kw.get('NextToken') else data['volumes'][:1],**({} if kw.get('NextToken') else {'NextToken':'page-two'})}
  if scenario=='repeat-token': return {'Volumes':[],'NextToken':'repeat'}
  if scenario=='duplicate-volume': return {'Volumes':data['volumes']+data['volumes'][:1]}
  return {'Volumes':data['volumes']}
 def describe_key(self,**kw): calls.append(('key',kw));assert kw=={'KeyId':c['keys'][0]};return {'KeyMetadata':data['key']}
 def get_role(self,**kw): assert kw=={'RoleName':'dlm-execution'};return {'Role':data['role']}
 def get_lifecycle_policies(self,**kw): assert kw=={};return {'Policies':data['summaries']}
 def get_lifecycle_policy(self,**kw): assert kw=={'PolicyId':identifier};return {'Policy':data['policy']}
sys.modules['boto3']=types.SimpleNamespace(Session=Session);sys.modules['botocore']=types.ModuleType('botocore');sys.modules['botocore.config']=types.SimpleNamespace(Config=Config)
cases=['preflight','pagination','check','enabled','wrong-account','missing-volume','extra-volume','duplicate-volume','repeat-token','unencrypted','bad-state','wrong-key','disabled-key','foreign-key','wrong-role','no-trust','outpost','local-zone','wrong-tag','existing-policy','policy-owner','policy-state','policy-role','default-policy','target-type','target-tag','extra-schedule','copy-tags','wrong-time','scripts','retention','copy-region','share','archive','no-policy-enabled']
for scenario in cases:
 data=copy.deepcopy(base);calls=[];flags=[]
 if scenario in ['check','enabled','policy-owner','policy-state','policy-role','default-policy','target-type','target-tag','extra-schedule','copy-tags','wrong-time','scripts','retention','copy-region','share','archive']: flags=['--policy',identifier]
 p=data['policy'];d=p['PolicyDetails'];s=d['Schedules'][0];v=data['volumes'][0]
 if scenario=='enabled': p['State']='ENABLED';flags+=['--expect-enabled']
 if scenario=='wrong-account': data['account']='000000000000'
 if scenario=='missing-volume': data['volumes'].pop()
 if scenario=='extra-volume': data['volumes'].append(dict(v,VolumeId='vol-00000000'))
 if scenario=='unencrypted': v['Encrypted']=False
 if scenario=='bad-state': v['State']='error'
 if scenario=='wrong-key': v['KmsKeyId']='alias/aws/ebs'
 if scenario=='disabled-key': data['key']['KeyState']='Disabled'
 if scenario=='foreign-key': data['key']['AWSAccountId']='000000000000'
 if scenario=='wrong-role': data['role']['Arn']='arn:aws:iam::000000000000:role/dlm'
 if scenario=='no-trust': data['role']['AssumeRolePolicyDocument']['Statement']=[]
 if scenario=='outpost': v['OutpostArn']='arn:aws:outposts:us-east-1:123456789012:outpost/op-test'
 if scenario=='local-zone': v['AvailabilityZone']='us-east-1-bos-1a'
 if scenario=='wrong-tag': v['Tags']=[]
 if scenario=='existing-policy': data['summaries']=[{'PolicyId':identifier,'Description':c['name']}]
 if scenario=='policy-owner': p['PolicyArn']=p['PolicyArn'].replace(c['account'],'000000000000')
 if scenario=='policy-state': p['State']='ERROR'
 if scenario=='policy-role': p['ExecutionRoleArn']='other'
 if scenario=='default-policy': p['DefaultPolicy']=True
 if scenario=='target-type': d['ResourceTypes']=['INSTANCE']
 if scenario=='target-tag': d['TargetTags'].append({'Key':'other','Value':'expands'})
 if scenario=='extra-schedule': d['Schedules'].append(copy.deepcopy(s))
 if scenario=='copy-tags': s['CopyTags']=True
 if scenario=='wrong-time': s['CreateRule']['Times']=['09:00']
 if scenario=='scripts': s['CreateRule']['Scripts']=[{}]
 if scenario=='retention': s['RetainRule']['Count']=1
 if scenario=='copy-region': s['CrossRegionCopyRules']=[{}]
 if scenario=='share': s['ShareRules']=[{}]
 if scenario=='archive': s['ArchiveRule']={ 'RetainRule':{} }
 if scenario=='no-policy-enabled': flags=['--expect-enabled']
 sys.argv=['INSPECT.py']+flags;failure=None
 with contextlib.redirect_stdout(io.StringIO()) as out,contextlib.redirect_stderr(io.StringIO()):
  try: runpy.run_path(str(root/'INSPECT.py'),run_name='__main__')
  except BaseException as error: failure=error
 success=scenario in ['preflight','pagination','check','enabled'];assert bool(failure)!=success,(scenario,failure,out.getvalue())
 if success:
  report=json.loads(out.getvalue());assert report['sourceCapacityGiB']==200 and report['sourceVolumes']==2 and report['snapshotRecoveryProven'] is False and report['targetExpansionPossible'] is True
  assert len([call for call in calls if call[0]=='key'])==1,'Read each actual source key once'
print(str(len(cases))+' DLM metadata/pagination/target/retention cases passed; SDK doubles only')

from datetime import datetime,timedelta,timezone
snapshots=[{'SnapshotId':'snap-'+str(i),'OwnerId':c['account'],'VolumeId':v,'Encrypted':True,'KmsKeyId':c['keys'][0],'State':'completed','StartTime':datetime.now(timezone.utc)-timedelta(hours=1),'Tags':[{'Key':'aws:dlm:lifecycle-policy-id','Value':identifier},{'Key':'aws:dlm:lifecycle-schedule-name','Value':'reviewed-volume-snapshots'}]} for i,v in enumerate(c['volumes'])]
def describe_snapshots(self,**kw):
 assert kw['OwnerIds']==[c['account']] and kw['Filters']==[{'Name':'tag:aws:dlm:lifecycle-policy-id','Values':[identifier]}] and kw['MaxResults']==1000
 if scenario=='snapshot-pages': return {'Snapshots':data['snapshots'][1:] if kw.get('NextToken') else data['snapshots'][:1],**({} if kw.get('NextToken') else {'NextToken':'two'})}
 if scenario=='snapshot-token': return {'Snapshots':[],'NextToken':'repeat'}
 return {'Snapshots':data['snapshots']}
Session.describe_snapshots=describe_snapshots
snapshot_cases=['snapshots','snapshot-pages','snapshot-missing','snapshot-duplicate','snapshot-token','snapshot-owner','snapshot-source','snapshot-policy','snapshot-schedule','snapshot-key','snapshot-encryption','snapshot-error','snapshot-pending-only','snapshot-stale','snapshot-future','snapshot-archive','snapshot-outpost','snapshot-over-retention','snapshot-bad-age']
for scenario in snapshot_cases:
 data={'account':c['account'],'snapshots':copy.deepcopy(snapshots)};s=data['snapshots'][0];flags=['--policy',identifier,'--max-age-hours','48']
 if scenario=='snapshot-missing': data['snapshots'].pop()
 if scenario=='snapshot-duplicate': data['snapshots'].append(copy.deepcopy(s))
 if scenario=='snapshot-owner': s['OwnerId']='000000000000'
 if scenario=='snapshot-source': s['VolumeId']='vol-00000000'
 if scenario=='snapshot-policy': s['Tags'][0]['Value']='policy-wrong'
 if scenario=='snapshot-schedule': s['Tags'][1]['Value']='wrong'
 if scenario=='snapshot-key': s['KmsKeyId']='alias/aws/ebs'
 if scenario=='snapshot-encryption': s['Encrypted']=False
 if scenario=='snapshot-error': s['State']='error'
 if scenario=='snapshot-pending-only': s['State']='pending'
 if scenario=='snapshot-stale': s['StartTime']-=timedelta(days=5)
 if scenario=='snapshot-future': s['StartTime']+=timedelta(days=5)
 if scenario=='snapshot-archive': s['StorageTier']='archive'
 if scenario=='snapshot-outpost': s['OutpostArn']='outpost'
 if scenario=='snapshot-bad-age': flags[-1]='nan'
 if scenario=='snapshot-over-retention': data['snapshots']+=[dict(s,SnapshotId='snap-extra-'+str(i)) for i in range(8)]
 sys.argv=['CHECK-SNAPSHOTS.py']+flags;failure=None
 with contextlib.redirect_stdout(io.StringIO()) as out,contextlib.redirect_stderr(io.StringIO()):
  try: runpy.run_path(str(root/'CHECK-SNAPSHOTS.py'),run_name='__main__')
  except BaseException as error: failure=error
 success=scenario in ['snapshots','snapshot-pages','snapshot-over-retention'];assert bool(failure)!=success,(scenario,failure)
 if success:
  report=json.loads(out.getvalue());assert report['snapshotRecoveryProven'] is False and len(report['sources'])==2
  assert report['sources'][0]['aboveConfiguredCount']==(scenario=='snapshot-over-retention')
print(str(len(snapshot_cases))+' snapshot lineage/freshness/pagination cases passed; no snapshot contents/restores/deletions')
`);
const check=spawnSync(process.env.PYTHON_PATH||'python',[join(work,'test.py')],{encoding:'utf8',windowsHide:true});process.stdout.write((check.stdout||'')+(check.stderr||''));if(check.error)throw check.error;if(check.status!==0)throw new Error('Inspect '+work);console.log(work);
