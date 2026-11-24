import {test} from 'node:test';import assert from 'node:assert/strict';import {AWS_DYNAMODB_SERVICE,AWS_ECR_SERVICE} from './aws-data-services.ts';import {defaultValues} from '../kit/blueprint.ts';import {addServicesFor} from './add-service-catalog.ts';
const db=(extra={})=>AWS_DYNAMODB_SERVICE.build({...defaultValues(AWS_DYNAMODB_SERVICE),aws_region:'us-east-1',table_name:'app-data',partition_key:'pk',...extra},'table');
const ecr=(extra={})=>AWS_ECR_SERVICE.build({...defaultValues(AWS_ECR_SERVICE),aws_region:'us-east-1',repository_name:'team/application',...extra},'repo');
test('DynamoDB and ECR select their own dedicated setup forms',()=>{
 assert.equal(addServicesFor('aws').find(r=>r.id==='amazon-dynamodb').terraform[0],AWS_DYNAMODB_SERVICE);assert.equal(addServicesFor('aws').find(r=>r.id==='amazon-elastic-container-registry').terraform[0],AWS_ECR_SERVICE);assert.equal(db().findings.filter(f=>f.severity==='error').length,0);assert.equal(ecr().findings.filter(f=>f.severity==='error').length,0);
});
test('DynamoDB index key definitions are deduplicated and type conflicts block export',()=>{
 const result=db({sort_key:'sk',indexes:'by-customer | customer | S | sk | S | ALL |  | ',ttl_attribute:'expires',stream:'NEW_AND_OLD_IMAGES'});assert.equal(result.findings.filter(f=>f.severity==='error').length,0);const code=result.files['main.tf'];assert.ok(code.includes('global_secondary_index'));assert.equal((code.match(/name = "sk"/g)??[]).length,1);assert.ok(code.includes('stream_enabled = true'));assert.ok(code.includes('attribute_name = "expires"'));assert.ok(!code.includes('read_capacity ='));
 assert.ok(db({indexes:'by-customer | pk | N |  |  | ALL |  | '}).findings.some(f=>f.code==='aws.dynamodb.key-conflict'));
 assert.ok(db({billing_mode:'PROVISIONED',read_capacity:0}).findings.some(f=>f.severity==='error'));
});
test('DynamoDB provisioned capacity and customer encryption reach configuration',()=>{
 const result=db({billing_mode:'PROVISIONED',read_capacity:10,write_capacity:5,indexes:'by-customer | customer | S |  |  | KEYS_ONLY | 2 | 3',encryption:'customer',kms_key:'arn:aws:kms:us-east-1:123456789012:key/abc'});assert.equal(result.findings.filter(f=>f.severity==='error').length,0);assert.ok(result.files['main.tf'].includes('read_capacity = 10'));assert.ok(result.files['main.tf'].includes('kms_key_arn'));
});
test('ECR lifecycle and encryption options produce an image repository only',()=>{
 const result=ecr({keep_tagged:10,tag_prefix:'build-',untagged_days:30,encryption:'KMS',kms_key:'arn:aws:kms:us-east-1:123456789012:key/abc'});assert.equal(result.findings.filter(f=>f.severity==='error').length,0);const code=result.files['main.tf'];for(const expected of ['image_tag_mutability = "IMMUTABLE"','force_delete = false','aws_ecr_lifecycle_policy','encryption_type = "KMS"'])assert.ok(code.includes(expected),expected);assert.ok(!code.includes('aws_ecs_service'));assert.ok(ecr({keep_tagged:3,tag_prefix:''}).findings.some(f=>f.code==='aws.ecr.prefix'));
});
