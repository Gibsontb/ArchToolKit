import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultValues} from '../kit/blueprint.ts';
import {AWS_MGN_SERVICE} from './aws-mgn-service.ts';
import {AWS_MGN_CUTOVER_SERVICE as blueprint} from './aws-mgn-cutover-service.ts';
import {addServicesFor} from './add-service-catalog.ts';
const values={...defaultValues(blueprint),aws_region:'us-east-1',name:'production',source:'arn:aws:mgn:us-east-1:123456789012:source-server/s-0123456789abcdef0',template:'lt-0123456789abcdef0',subnet:'subnet-0123456789abcdef0',staging:'subnet-0123456789abcdef1',groups:'sg-0123456789abcdef0',staging_groups:'sg-0123456789abcdef1',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc'};
test('Production MGN export is separate from pilot and contains explicit cutover and target check assets',()=>{
  const row=addServicesFor('aws').find(row=>row.id==='aws-application-migration-service')!;
  assert.equal(row.terraform[0],AWS_MGN_SERVICE);assert.equal(row.terraform[1],blueprint);
  const result=blueprint.build(values);assert.deepEqual(result.findings,[]);
  assert.equal(result.files['PILOT-CONFIG.json'],undefined);
  assert.equal(JSON.parse(result.files['CUTOVER-CONFIG.json']!).production,true);
  const script=result.files['OPERATE.py']!;
  assert.match(script,/start_cutover\(/);assert.doesNotMatch(script,/start_test\(|finalize_cutover\(|terminate_instances\(/);
  assert.match(script,/READY_FOR_CUTOVER/);assert.match(script,/confirm_write_freeze and args.confirm_backup and args.confirm_acceptance/);
  assert.match(script,/DisableApiTermination/);
  assert.match(result.files['CHECK-TARGET.py']!,/describe_volumes/);
  assert.match(result.files['SERVICE-SETUP.md']!,/does not copy target data back/);
});
test('Production MGN inherits pilot identity/region/network validation without changing pilot operation',()=>{
  for(const [key,value]of Object.entries({source:'bad',template:'bad',subnet:'bad',kms:'bad',version:0}))assert.ok(blueprint.build({...values,[key]:value}).findings.some(f=>f.path===key),key);
  const pilot=AWS_MGN_SERVICE.build({...defaultValues(AWS_MGN_SERVICE),...values});
  assert.doesNotMatch(pilot.files['OPERATE.py']!,/start_cutover|confirm_write_freeze/);
  assert.equal(pilot.files['CHECK-TARGET.py'],undefined);
});
