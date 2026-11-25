/** Actual pair orchestration script under local subprocess doubles; never runs regional SDK code. */
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_DSQL_MULTIREGION_SERVICE as blueprint} from '../src/cloud/aws-dsql-multiregion-service.ts';
import {WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'dsql-pair-check-')),key=region=>'arn:aws:kms:'+region+':123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc';
const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',name:'reviewed-pair',account:'123456789012',kms:key('us-east-1'),peer_kms:key('us-west-2'),subnets:'subnet-12345678,subnet-abcdef12',clients:'sg-12345678',peer_subnets:'subnet-12345679,subnet-abcdef13',peer_clients:'sg-12345679',role:'arn:aws:iam::123456789012:role/application'});if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const[name,body]of Object.entries(result.files)){mkdirSync(dirname(join(work,name)),{recursive:true});writeFileSync(join(work,name),body);}
writeFileSync(join(work,'test.py'),String.raw`import contextlib, io, json, runpy, subprocess, sys, traceback, types
from pathlib import Path
root=Path(__file__).resolve().parent
primary='a'*26; secondary='b'*26
ids=['--primary-cluster',primary,'--secondary-cluster',secondary,'--primary-endpoint','vpce-12345678','--secondary-endpoint','vpce-abcdef12']
def fake_run(command,**kwargs):
 assert kwargs=={'capture_output':True,'text':True} and command[0]==sys.executable
 path=Path(command[1]); site=path.parent.name; assert site in ['primary','secondary'] and path.name=='INSPECT.py'
 calls.append(site)
 c=json.loads((path.parent/'DSQL-CONFIG.json').read_text())
 assert c['witnessRegion']=='us-east-2' and c['region']==('us-east-1' if site=='primary' else 'us-west-2') and c['peerRegion']==('us-west-2' if site=='primary' else 'us-east-1')
 if scenario=='preflight': assert command[2:]==[]
 else:
  expected=['--cluster',primary if site=='primary' else secondary,'--peer-cluster',secondary if site=='primary' else primary,'--endpoint','vpce-12345678' if site=='primary' else 'vpce-abcdef12']+(['--emit-policy-review'] if scenario=='emit' else [])
  assert command[2:]==expected
 fail=(scenario=='first-fail' and site=='primary') or (scenario=='second-fail' and site=='secondary')
 return types.SimpleNamespace(returncode=1 if fail else 0,stdout='Regional metadata preflight checked' if scenario=='preflight' else json.dumps({'region':c['region'],'authorizationProven':False}),stderr='SYNTHETIC-SECRET-NOT-TO-PRINT')
subprocess.run=fake_run
cases=[('no-ids',[]),('preflight',['--preflight']),('check',ids),('emit',ids+['--emit-policy-review']),('first-fail',ids),('second-fail',ids),('invalid-id',['--primary-cluster','bad']+ids[2:]),('mixed-preflight',ids+['--preflight'])]
for scenario,flags in cases:
 calls=[];failure=None;sys.argv=['CHECK-PAIR.py']+flags
 with contextlib.redirect_stdout(io.StringIO()) as output,contextlib.redirect_stderr(io.StringIO()) as errors:
  try: runpy.run_path(str(root/'CHECK-PAIR.py'),run_name='__main__')
  except BaseException as error: failure=error
 success=scenario in ['preflight','check','emit'];assert bool(failure)!=success,(scenario,failure)
 assert calls==(['primary','secondary'] if scenario in ['preflight','check','emit','second-fail'] else ['primary'] if scenario=='first-fail' else []),(scenario,calls)
 if success:
  report=json.loads(output.getvalue());assert report['bothComponentChecksPassed'] is True and report['atomicSnapshotProven'] is False and report['logicalDatabaseIntegrityProven'] is False and report['ownerTrafficFailoverSqlApprovalRequired'] is True
 assert 'SYNTHETIC-SECRET-NOT-TO-PRINT' not in output.getvalue()+errors.getvalue()
 if failure: assert 'SYNTHETIC-SECRET-NOT-TO-PRINT' not in ''.join(traceback.format_exception(type(failure),failure,failure.__traceback__))
print(str(len(cases))+' pair orchestration/region/reciprocal-ID/error-sanitization cases passed; subprocesses were local doubles only')
`);
const check=spawnSync(process.env.PYTHON_PATH||'python',[join(work,'test.py')],{encoding:'utf8',windowsHide:true});process.stdout.write((check.stdout||'')+(check.stderr||''));if(check.error)throw check.error;if(check.status!==0)throw new Error('Inspect '+work);console.log(work);
