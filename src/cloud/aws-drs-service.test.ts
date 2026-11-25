import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultValues} from '../kit/blueprint.ts';
import {AWS_DRS_SERVICE as blueprint} from './aws-drs-service.ts';
import {addServicesFor} from './add-service-catalog.ts';
const values={...defaultValues(blueprint),aws_region:'us-east-1',name:'recovery',source:'arn:aws:drs:us-east-1:123456789012:source-server/s-0123456789abcdef0',snapshot:'pit-0123456789abcdef0',template:'lt-0123456789abcdef0',subnet:'subnet-0123456789abcdef0',staging:'subnet-0123456789abcdef1',groups:'sg-0123456789abcdef0',staging_groups:'sg-0123456789abcdef1',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc'};
test('DRS stages exact PIT recovery separately from MGN and changes no AWS infrastructure/shared defaults through Terraform',()=>{
  assert.equal(addServicesFor('aws').find(row=>row.id==='aws-elastic-disaster-recovery')?.terraform[0],blueprint);
  const result=blueprint.build(values);assert.deepEqual(result.findings,[]);
  assert.equal(JSON.parse(result.files['RECOVERY-CONFIG.json']!).mode,'DRILL');
  assert.match(result.files['main.tf']!,/resource "terraform_data" "reviewed"/);assert.doesNotMatch(result.files['main.tf']!,/resource "aws_|local-exec/);
  assert.match(result.files['OPERATE.py']!,/start_recovery\(isDrill=drill/);assert.match(result.files['OPERATE.py']!,/recoverySnapshotID/);
  assert.doesNotMatch(result.files['OPERATE.py']!,/start_test\(|start_cutover\(|start_failback\(|terminate_recovery_instances\(|update_launch_configuration\(|useFipsEndpoint|READY_FOR_TEST/);
  assert.match(result.files['OPERATE.py']!,/recoveryInstanceId/);assert.match(result.files['OPERATE.py']!,/recoveryInstanceID/);
});
test('DRS validates exact source/partition/point/template/network/key identities and both explicit operation modes',()=>{
  for(const [key,value]of Object.entries({source:values.source.replace(':drs:',':mgn:'),snapshot:'latest',age:0,mode:'FAILBACK',template:'bad',version:0,kms:values.kms.replace('123456789012','000000000000'),subnet:'bad',groups:'bad',instance:'bad',profile:'arn:aws:iam::000000000000:instance-profile/other'}))assert.ok(blueprint.build({...values,[key]:value}).findings.some(f=>f.path===key),key);
  assert.deepEqual(blueprint.build({...values,mode:'RECOVERY'}).findings,[]);
  const gov={...values,aws_region:'us-gov-west-1',source:values.source.replace('arn:aws:','arn:aws-us-gov:').replace('us-east-1','us-gov-west-1'),kms:values.kms.replace('arn:aws:','arn:aws-us-gov:').replace('us-east-1','us-gov-west-1')};assert.deepEqual(blueprint.build(gov).findings,[]);
});
