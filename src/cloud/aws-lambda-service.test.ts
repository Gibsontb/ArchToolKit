import {test} from 'node:test';import assert from 'node:assert/strict';import {AWS_LAMBDA_SERVICE} from './aws-lambda-service.ts';import {defaultValues} from '../kit/blueprint.ts';import {addServicesFor} from './add-service-catalog.ts';
const build=(extra={})=>AWS_LAMBDA_SERVICE.build({...defaultValues(AWS_LAMBDA_SERVICE),aws_region:'us-east-1',function_name:'app-function',role_arn:'arn:aws:iam::123456789012:role/app-function',s3_bucket:'app-code-storage',s3_key:'function.zip',...extra},'function');
test('Lambda standalone form configures ZIP runtime without requiring a landing zone',()=>{
 assert.equal(addServicesFor('aws').find(row=>row.id==='aws-lambda').terraform[0],AWS_LAMBDA_SERVICE);const result=build();assert.equal(result.findings.filter(f=>f.severity==='error').length,0);const code=Object.values(result.files).join('\n');for(const expected of ['aws_lambda_function','s3_key = "function.zip"','runtime = "python3.13"','aws_cloudwatch_log_group'])assert.ok(code.includes(expected),expected);assert.ok(!code.includes('var.landing_zone'));assert.ok(!result.files['main.tf'].includes('vpc_config'));
});
test('Lambda image mode omits ZIP settings and validates regional artifacts',()=>{
 const result=build({package_type:'Image',image_uri:'123456789012.dkr.ecr.us-east-1.amazonaws.com/app:v1',s3_bucket:'',s3_key:''});assert.equal(result.findings.filter(f=>f.severity==='error').length,0);assert.ok(!result.files['main.tf'].includes('runtime ='));assert.ok(!result.files['main.tf'].includes('s3_bucket'));
 assert.ok(build({package_type:'Image',image_uri:'123456789012.dkr.ecr.eu-west-1.amazonaws.com/app:v1'}).findings.some(f=>f.code==='aws.lambda.image-region'));
});
test('Lambda validates identity, network, resources and application variables',()=>{
 for(const extra of [{role_arn:''},{timeout_seconds:901},{vpc:'true',subnet_ids:''},{environment_json:'{"1BAD":"value"}'},{environment_json:'{"VALID":123}'},{aws_region:'us-gov-west-1'}])assert.ok(build(extra).findings.some(f=>f.severity==='error'));
 const result=build({vpc:'true',subnet_ids:'subnet-1234abcd,subnet-abcd1234',security_group_ids:'sg-1234abcd',environment_json:'{"APP_MODE":"test"}',reserved_concurrency:0});assert.equal(result.findings.filter(f=>f.severity==='error').length,0);assert.ok(result.files['main.tf'].includes('reserved_concurrent_executions = 0'));assert.ok(result.files['main.tf'].includes('vpc_config'));
});
