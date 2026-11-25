/** Enhanced existing analyzer workflow; SDK doubles only, no policies/findings sent to AWS. */
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_ACCESS_ANALYZER_SERVICE as blueprint} from '../src/cloud/aws-access-analyzer-service.ts';
import {WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'access-analyzer-'));
const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',name:'reviewed-access',account:'123456789012'});
if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const name of ['INSPECT.py','ANALYZER-CONFIG.json'])writeFileSync(join(work,name),result.files[name]);
writeFileSync(join(work,'test.py'),String.raw`import contextlib, copy, io, json, runpy, sys, types
from pathlib import Path
root=Path(__file__).resolve().parent; initial=json.loads((root/'ANALYZER-CONFIG.json').read_text())
arn='arn:aws:access-analyzer:us-east-1:'+initial['account']+':analyzer/'+initial['name']
class Config:
 def __init__(self,**kwargs): assert kwargs['use_fips_endpoint'] is True
class Session:
 def __init__(self,**kwargs): assert kwargs=={'region_name':c['region']}
 def client(self,name,**kwargs): assert name in ['sts','organizations','accessanalyzer']; assert kwargs['region_name']==c['region']; return self
 def get_caller_identity(self): return {'Account':'000000000000' if scenario=='account' else c['account']}
 def describe_organization(self): return {'Organization':{'Id':'o-wrong123456' if scenario=='org-id' else c['organization'],'FeatureSet':'CONSOLIDATED_BILLING' if scenario=='org-features' else 'ALL','MasterAccountId':'111111111111' if scenario in ['delegated','no-delegation','delegated-page','delegated-repeat'] else c['account']}}
 def list_aws_service_access_for_organization(self,**kwargs): assert kwargs.get('MaxResults')==20; return {'EnabledServicePrincipals':[] if scenario=='service-disabled' else [{'ServicePrincipal':'access-analyzer.amazonaws.com'}]}
 def list_delegated_administrators(self,**kwargs):
  assert kwargs.get('ServicePrincipal')=='access-analyzer.amazonaws.com' and kwargs.get('MaxResults')==20
  if scenario in ['delegated-page','delegated-repeat'] and not kwargs.get('NextToken'): return {'DelegatedAdministrators':[],'NextToken':'one'}
  return {'DelegatedAdministrators':[] if scenario=='no-delegation' else [{'Id':c['account'],'State':'ACTIVE'}],**({'NextToken':'one'} if scenario=='delegated-repeat' else {})}
 def list_analyzers(self,**kwargs):
  assert kwargs.get('type')==c['type']
  if scenario in ['analyzer-page','analyzer-repeat'] and not kwargs.get('nextToken'): return {'analyzers':[],'nextToken':'one'}
  return {'analyzers':[] if scenario=='preflight' else [{'name':c['name'],'arn':arn}],**({'nextToken':'one'} if scenario=='analyzer-repeat' else {})}
 def get_analyzer(self,**kwargs): assert kwargs=={'analyzerName':c['name']}; return {'analyzer':data}
 def list_archive_rules(self,**kwargs): assert kwargs=={'analyzerName':c['name']}; return {'archiveRules':[{'ruleName':'hidden'}] if scenario=='archive' else []}
 def list_findings(self,**kwargs): assert c['analysis']=='EXTERNAL'; return self.findings(kwargs)
 def list_findings_v2(self,**kwargs): assert c['analysis']=='UNUSED'; return self.findings(kwargs)
 def findings(self,kwargs):
  assert kwargs.get('analyzerArn')==arn
  if scenario in ['findings-page','findings-repeat'] and not kwargs.get('nextToken'): return {'findings':[],'nextToken':'one'}
  f={'id':'one','status':'UNKNOWN' if scenario=='finding-status' else 'ACTIVE','resource':'SYNTHETIC-NOT-TO-PRINT','principal':{'AWS':'SYNTHETIC-NOT-TO-PRINT'}}
  if scenario=='finding-error': f['error']='SYNTHETIC-NOT-TO-PRINT'
  return {'findings':[f]+([f] if scenario=='duplicate-finding' else []),**({'nextToken':'one'} if scenario=='findings-repeat' else {})}
sdk=types.ModuleType('boto3'); sdk.Session=Session; sys.modules['boto3']=sdk; sys.modules['botocore']=types.ModuleType('botocore'); module=types.ModuleType('botocore.config'); module.Config=Config; sys.modules['botocore.config']=module
cases=[('preflight',[],None),('check',[],None),('findings',[],None),('existing',[],None),('account',[],None),('analyzer-page',[],None),('analyzer-repeat',[],None),('findings-page',[],None),('findings-repeat',[],None),('finding-status',[],None),('finding-error',[],None),('duplicate-finding',[],None),
 ('wrong-arn',['arn'],'other'),('wrong-type',['type'],'INTERNAL'),('disabled',['status'],'DISABLED'),('status-reason',['statusReason'],{'code':'AWS_SERVICE_ACCESS_DISABLED'})]
total=0
for analysis in ['EXTERNAL','UNUSED']:
 for zone in ['ACCOUNT','ORGANIZATION']:
  c={**initial,'analysis':analysis,'zone':zone,'organization':'o-1234567890' if zone=='ORGANIZATION' else None,'age':90 if analysis=='UNUSED' else None,'type':zone+('_UNUSED_ACCESS' if analysis=='UNUSED' else '')}
  (root/'ANALYZER-CONFIG.json').write_text(json.dumps(c))
  extra=[('org-id',[],None),('org-features',[],None),('service-disabled',[],None),('delegated',[],None),('no-delegation',[],None),('delegated-page',[],None),('delegated-repeat',[],None)] if zone=='ORGANIZATION' else []
  extra += [('archive',[],None)] if analysis=='EXTERNAL' else [('age',['configuration','unusedAccess','unusedAccessAge'],180),('excluded',['configuration','unusedAccess','analysisRule'],{'exclusions':[{'accountIds':['000000000000']}]})]
  for scenario,path,value in cases+extra:
   data={'name':c['name'],'arn':arn,'type':c['type'],'status':'ACTIVE','configuration':{'unusedAccess':{'unusedAccessAge':c['age']}} if analysis=='UNUSED' else {}}
   if path:
    parent=data
    for key in path[:-1]: parent=parent[key]
    parent[path[-1]]=value
   flags=[] if scenario in ['preflight','existing'] else ['--check']
   if scenario.startswith('finding') or scenario=='duplicate-finding': flags+=['--findings']
   sys.argv=['INSPECT.py']+flags; failure=None
   with contextlib.redirect_stdout(io.StringIO()) as output:
    try: runpy.run_path(str(root/'INSPECT.py'),run_name='__main__')
    except Exception as error: failure=error
   success=scenario in ['preflight','check','findings','analyzer-page','findings-page','finding-error','delegated','delegated-page']
   assert bool(failure)!=success,(analysis,zone,scenario,failure)
   assert 'SYNTHETIC-NOT-TO-PRINT' not in output.getvalue()
   if scenario in ['findings','findings-page','finding-error']:
    report=json.loads(output.getvalue()); assert report['findings']['ACTIVE']==1 and report['ownerReviewRequired'] is True and report['scanCompletenessProven'] is False
   total+=1
print(str(total)+' generated analyzer SDK checks passed; no AWS/policy/remediation operations')
`);
const check=spawnSync(process.env.PYTHON_PATH||'python',[join(work,'test.py')],{encoding:'utf8',windowsHide:true});process.stdout.write((check.stdout||'')+(check.stderr||''));if(check.error)throw check.error;if(check.status!==0)throw new Error('Inspect '+work);console.log(work);
