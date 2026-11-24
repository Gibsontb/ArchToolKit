import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultValues} from '../kit/blueprint.ts';
import {AWS_MGN_SERVICE as blueprint} from './aws-mgn-service.ts';
import {addServicesFor} from './add-service-catalog.ts';
const values={...defaultValues(blueprint),aws_region:'us-east-1',name:'pilot',source:'arn:aws:mgn:us-east-1:123456789012:source-server/s-0123456789abcdef0',template:'lt-0123456789abcdef0',subnet:'subnet-0123456789abcdef0',staging:'subnet-0123456789abcdef1',groups:'sg-0123456789abcdef0',staging_groups:'sg-0123456789abcdef1',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc'};
test('MGN pilot preserves native builders and does not provision or change AWS migration defaults',()=>{
  assert.equal(addServicesFor('aws').find(row=>row.id==='aws-application-migration-service')?.terraform[0],blueprint);
  const result=blueprint.build(values);
  assert.deepEqual(result.findings,[]);
  assert.match(result.files['main.tf']!,/resource "terraform_data" "reviewed"/);
  assert.doesNotMatch(result.files['main.tf']!,/resource "aws_|local-exec|remote-exec/);
  assert.match(result.files['versions.tf']!,/required_version = ">= 1.4.0"/);
  const config=JSON.parse(result.files['PILOT-CONFIG.json']!);
  assert.equal(config.sourceID,'s-0123456789abcdef0');
  assert.equal(config.fips,true);
  assert.doesNotMatch(result.files['OPERATE.py']!,/update_launch|start_cutover|finalize_cutover|terminate_target|initialize_service/);
  assert.match(result.files['SERVICE-SETUP.md']!,/creates no AWS infrastructure/);
});
test('MGN endpoint and identity validation constrains partition, network and reviewed launch version',()=>{
  for(const [key,value]of Object.entries({source:values.source.replace('us-east-1','us-west-2'),template:'bad',version:0,subnet:'bad',staging_groups:'sg-bad',kms:values.kms.replace('123456789012','000000000000'),instance:'t2.micro',profile:'arn:aws:iam::000000000000:instance-profile/other',endpoint:'OTHER',lag:0}))assert.ok(blueprint.build({...values,[key]:value}).findings.some(f=>f.path===key),key);
  const gov={...values,aws_region:'us-gov-west-1',source:values.source.replace('arn:aws:','arn:aws-us-gov:').replace('us-east-1','us-gov-west-1'),kms:values.kms.replace('arn:aws:','arn:aws-us-gov:').replace('us-east-1','us-gov-west-1')};
  assert.deepEqual(blueprint.build(gov).findings,[]);
  assert.ok(blueprint.build({...gov,endpoint:'STANDARD'}).findings.some(f=>f.path==='endpoint'));
  assert.equal(JSON.parse(blueprint.build({...values,endpoint:'STANDARD'}).files['PILOT-CONFIG.json']!).fips,false);
});
