import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultValues} from '../kit/blueprint.ts';
import {AWS_PIPES_SERVICE as blueprint} from './aws-pipes-service.ts';
import {addServicesFor} from './add-service-catalog.ts';
const values={...defaultValues(blueprint),aws_region:'us-east-1',name:'application',source:'arn:aws:sqs:us-east-1:123456789012:source',dlq:'arn:aws:sqs:us-east-1:123456789012:failed',target:'arn:aws:lambda:us-east-1:123456789012:function:ApprovedBatch:3',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc'};
test('Pipes creates stopped synchronous processing with scoped new role and preserves source configuration',()=>{
  assert.equal(addServicesFor('aws').find(row=>row.id==='amazon-eventbridge-pipes')?.terraform[0],blueprint);
  const result=blueprint.build(values);assert.deepEqual(result.findings,[]);
  const main=result.files['main.tf']!;
  assert.match(main,/desired_state\s+= "STOPPED"/);assert.match(main,/REQUEST_RESPONSE/);
  assert.match(main,/aws:SourceArn/);assert.match(main,/pipe\/application/);
  assert.match(main,/StringEqualsIfExists/);assert.match(main,/ForAnyValue:StringEquals/);
  assert.match(main,/aws:pipe:arn/);assert.match(main,/aws:pipes:arn/);
  assert.doesNotMatch(main,/resource "aws_sqs_|aws_lambda_permission|data "aws_lambda_function|filter_criteria|enrichment|AdministratorAccess/);
  assert.doesNotMatch(result.files['INSPECT.py']!,/\.invoke\(|receive_message\(|delete_message\(|start_pipe\(/);
});
test('Pipes constrains queue/key/target identity and standard/FIFO batching variants',()=>{
  for(const [key,value]of Object.entries({source:values.source.replace('us-east-1','us-west-2'),dlq:values.dlq+'.fifo',target:values.target.replace(':3',':alias'),kms:values.kms.replace('123456789012','000000000000'),aws_region:'us-gov-west-1',batch:11,window:301,encryption:'NONE',name:'bad/name'}))assert.ok(blueprint.build({...values,[key]:value}).findings.some(f=>f.path===key),key);
  assert.ok(blueprint.build({...values,dlq:values.source}).findings.some(f=>f.path==='dlq'));
  assert.ok(blueprint.build({...values,encryption:'KMS',queue_key:''}).findings.some(f=>f.path==='queue_key'));
  const encrypted=blueprint.build({...values,encryption:'KMS',queue_key:values.kms,enabled:true});assert.deepEqual(encrypted.findings,[]);assert.match(encrypted.files['main.tf']!,/desired_state\s+= "RUNNING"/);
  const fifo={...values,source:values.source+'.fifo',dlq:values.dlq+'.fifo'};
  assert.deepEqual(blueprint.build(fifo).findings,[]);assert.ok(blueprint.build({...fifo,window:1}).findings.some(f=>f.path==='window'));
});
