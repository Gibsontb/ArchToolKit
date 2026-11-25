import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultValues} from '../kit/blueprint.ts';
import {AWS_DLM_SERVICE as blueprint} from './aws-dlm-service.ts';
import {addServicesFor} from './add-service-catalog.ts';
export const values={...defaultValues(blueprint),aws_region:'us-east-1',name:'reviewed-backups',account:'123456789012',volumes:'vol-12345678,vol-abcdef12',keys:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc',role:'arn:aws:iam::123456789012:role/service-role/dlm-execution',tag_value:'reviewed-estate'};
test('DLM stages disabled encrypted-source volume lifecycle with bounded retention and preserves existing builders',()=>{
  const service=addServicesFor('aws').find(s=>s.id==='amazon-data-lifecycle-manager')!;
  assert.equal(service.terraform[0],blueprint);assert.ok(service.terraform.length>1);
  const result=blueprint.build(values);assert.deepEqual(result.findings,[]);
  const main=result.files['main.tf']!;
  assert.match(main,/state\s+= "DISABLED"/);assert.match(main,/prevent_destroy\s+= true/);
  assert.match(main,/resource_types\s+= \["VOLUME"\]/);assert.match(main,/target_tags/);assert.match(main,/copy_tags\s+= false/);
  assert.doesNotMatch(main,/aws_iam_role_policy|cross_region_copy_rule|share_rule|local-exec|resource "aws_ebs_snapshot"/);
  assert.doesNotMatch(result.files['INSPECT.py']!,/create_snapshot\(|update_lifecycle_policy\(|delete_snapshot\(/);
  assert.match(result.files['INSPECT.py']!,/set\(volumes\)==set\(c\['volumes'\]\)/);
});
test('DLM rejects unsafe scope, retention, keys and schedule and accepts every supported interval',()=>{
  for(const [key,value]of Object.entries({aws_region:'us-gov-west-1',name:'bad name',account:'bad',volumes:'vol-12345678,vol-12345678',keys:'alias/aws/ebs',role:'arn:aws:iam::000000000000:role/dlm',tag_key:'aws:reserved',tag_value:'',interval:'5',time:'24:00',retain:'0'}))assert.ok(blueprint.build({...values,[key]:value}).findings.some(f=>f.path===key),key);
  for(const interval of [1,2,3,4,6,8,12,24])assert.deepEqual(blueprint.build({...values,interval:String(interval)}).findings,[]);
});
