/** Actual exported Detective inspector against local SDK doubles only. */
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_DETECTIVE_SERVICE as blueprint} from '../src/cloud/aws-detective-service.ts';
import {WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'detective-inspect-'));const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',name:'reviewed-investigation',account:'123456789012',approved:'true'});if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const name of ['INSPECT.py','DETECTIVE-CONFIG.json'])writeFileSync(join(work,name),result.files[name]);
writeFileSync(join(work,'test.py'),String.raw`import contextlib,copy,io,json,runpy,sys,types
from pathlib import Path
root=Path(__file__).resolve().parent;c=json.loads((root/'DETECTIVE-CONFIG.json').read_text());arn='arn:aws:detective:'+c['region']+':'+c['account']+':graph:'+'a'*32
base={'account':c['account'],'graphs':[{'Arn':arn}],'tags':{'Name':c['name']},'members':[],'packages':{p:{'DatasourcePackageIngestState':'STARTED'} for p in c['approvedPackages']}}
class Config:
 def __init__(self,**kw): assert kw['use_fips_endpoint'] is True
class Session:
 def __init__(self,**kw): assert kw=={'region_name':c['region']}
 def client(self,name,**kw): assert name in ['sts','detective'];return self
 def get_caller_identity(self): return {'Account':data['account']}
 def list_graphs(self,**kw):
  assert kw['MaxResults']==100
  if scenario=='graph-pages': return {'GraphList':data['graphs'] if kw.get('NextToken') else [],**({} if kw.get('NextToken') else {'NextToken':'two'})}
  if scenario=='graph-token': return {'GraphList':[],'NextToken':'repeat'}
  return {'GraphList':data['graphs']}
 def list_tags_for_resource(self,**kw): assert kw=={'ResourceArn':arn};return {'Tags':data['tags']}
 def list_members(self,**kw):
  assert kw['GraphArn']==arn and kw['MaxResults']==100
  if scenario=='member-token': return {'MemberDetails':[],'NextToken':'repeat'}
  if scenario=='member-pages': return {'MemberDetails':[] if kw.get('NextToken') else data['members'],**({} if kw.get('NextToken') else {'NextToken':'two'})}
  return {'MemberDetails':data['members']}
 def list_datasource_packages(self,**kw):
  assert kw['GraphArn']==arn and kw['MaxResults']==100
  if scenario=='package-token': return {'DatasourcePackages':{},'NextToken':'repeat'}
  if scenario=='package-pages': return {'DatasourcePackages':{k:v for k,v in data['packages'].items() if (k=='DETECTIVE_CORE') != bool(kw.get('NextToken'))},**({} if kw.get('NextToken') else {'NextToken':'two'})}
  if scenario=='package-duplicate': return {'DatasourcePackages':data['packages'],**({} if kw.get('NextToken') else {'NextToken':'two'})}
  return {'DatasourcePackages':data['packages']}
sys.modules['boto3']=types.SimpleNamespace(Session=Session);sys.modules['botocore']=types.ModuleType('botocore');sys.modules['botocore.config']=types.SimpleNamespace(Config=Config)
cases=['preflight','existing-preflight','check','graph-pages','member-pages','package-pages','owner-member','wrong-account','bad-arn','foreign-arn','missing-graph','duplicate-graph','wrong-graph','graph-token','wrong-tag','foreign-member','member-duplicate','member-disabled','member-token','missing-package','stopped-package','unknown-package','package-token','package-duplicate']
for scenario in cases:
 data=copy.deepcopy(base);flags=[] if scenario in ['preflight','existing-preflight'] else ['--graph',arn]
 if scenario=='preflight': data['graphs']=[]
 if scenario=='wrong-account': data['account']='000000000000'
 if scenario=='bad-arn': flags=['--graph','bad']
 if scenario=='foreign-arn': flags=['--graph',arn.replace(c['account'],'000000000000')]
 if scenario=='missing-graph': data['graphs']=[]
 if scenario=='duplicate-graph': data['graphs']*=2
 if scenario=='wrong-graph': data['graphs'][0]['Arn']=arn.replace('a'*32,'b'*32)
 if scenario=='wrong-tag': data['tags']={}
 member={'AccountId':c['account'],'AdministratorId':c['account'],'GraphArn':arn,'Status':'ENABLED','EmailAddress':'SYNTHETIC-EMAIL-NOT-TO-PRINT'}
 if scenario in ['owner-member','member-pages','foreign-member','member-duplicate','member-disabled']: data['members']=[member]
 if scenario=='foreign-member': member['AccountId']='000000000000'
 if scenario=='member-duplicate': data['members']*=2
 if scenario=='member-disabled': member['Status']='INVITED'
 if scenario=='missing-package': data['packages'].pop('EKS_AUDIT')
 if scenario=='stopped-package': data['packages']['EKS_AUDIT']['DatasourcePackageIngestState']='STOPPED'
 if scenario=='unknown-package': data['packages']['UNREVIEWED']={'DatasourcePackageIngestState':'STARTED'}
 sys.argv=['INSPECT.py']+flags;failure=None
 with contextlib.redirect_stdout(io.StringIO()) as out,contextlib.redirect_stderr(io.StringIO()) as errors:
  try: runpy.run_path(str(root/'INSPECT.py'),run_name='__main__')
  except BaseException as error: failure=error
 success=scenario in ['preflight','check','graph-pages','member-pages','package-pages','owner-member'];assert bool(failure)!=success,(scenario,failure,out.getvalue())
 assert 'SYNTHETIC-EMAIL-NOT-TO-PRINT' not in out.getvalue()+errors.getvalue()
 if success and scenario!='preflight':
  report=json.loads(out.getvalue());assert report['graphMetadataVerified'] is True and report['ingestionCompletenessProven'] is False and report['orgAutoEnableDisabledProven'] is False
print(str(len(cases))+' Detective metadata/pagination/ownership/default-package cases passed; SDK doubles only')
`);
const check=spawnSync(process.env.PYTHON_PATH||'python',[join(work,'test.py')],{encoding:'utf8',windowsHide:true});process.stdout.write((check.stdout||'')+(check.stderr||''));if(check.error)throw check.error;if(check.status!==0)throw new Error('Inspect '+work);console.log(work);
