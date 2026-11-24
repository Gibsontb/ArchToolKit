import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultValues} from '../kit/blueprint.ts';
import {AWS_SAGEMAKER_SERVICE as blueprint} from './aws-sagemaker-service.ts';
import {addServicesFor} from './add-service-catalog.ts';
const values={...defaultValues(blueprint),aws_region:'us-east-1',name:'model-serving',image:'123456789012.dkr.ecr.us-east-1.amazonaws.com/inference/model@sha256:'+'a'.repeat(64),kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc',subnets:'subnet-0123456789abcdef0,subnet-0123456789abcdef1',clients:'sg-0123456789abcdef0',role:'arn:aws:iam::123456789012:role/ModelApplication'};
test('SageMaker hosting separates isolated model network from private runtime ingress and leaves shared DNS alone',()=>{
  assert.equal(addServicesFor('aws').find(row=>row.id==='amazon-sagemaker-ai')?.terraform[0],blueprint);
  const result=blueprint.build(values); assert.deepEqual(result.findings,[]);
  const main=result.files['main.tf']!;
  assert.match(main,/enable_network_isolation\s+= true/);
  assert.match(main,/private_dns_enabled\s+= false/);
  assert.match(main,/aws:SourceVpce/);
  assert.match(main,/StringNotEquals/);
  assert.match(main,/arn:aws:sagemaker:us-east-1:123456789012:\*/);
  assert.doesNotMatch(main,/AmazonSageMakerFullAccess|vpc_config \{|data_capture_config|async_inference_config|accelerator_type|aws_s3_object/);
  assert.match(main,/enable_ssm_access\s+= false/);
  assert.match(main,/kms_key_arn/);
  const config=JSON.parse(result.files['CLIENT-CONFIG.json']!);
  assert.equal(config.model,'model-serving-v1'); assert.equal(config.bucket,'');
  assert.doesNotMatch(main,/s3:GetObject/);
});
test('Archive mode uses an immutable-key contract and metadata preflight rather than pretending URL pins a version',()=>{
  const result=blueprint.build({...values,artifact:'ARCHIVE',bucket:'approved-models',key:'releases/v1/model.tar.gz',version:'approved-version',etag:'a'.repeat(32)});
  assert.deepEqual(result.findings,[]);
  assert.match(result.files['main.tf']!,/s3:\/\/approved-models\/releases\/v1\/model.tar.gz/);
  assert.doesNotMatch(result.files['main.tf']!,/versionId=/);
  assert.match(result.files['PREFLIGHT.py']!,/head_object/);
  assert.doesNotMatch(result.files['PREFLIGHT.py']!,/get_object\(|batch_get_image\(/);
  assert.match(result.files['SERVICE-SETUP.md']!,/cannot pin the supplied S3 version/);
});
test('FIPS omits unsupported endpoint policy and validates identity, image, network and hosting bounds',()=>{
  const result=blueprint.build({...values,endpoint:'FIPS'}); assert.deepEqual(result.findings,[]);
  const endpoint=result.files['main.tf']!.split('resource "aws_vpc_endpoint" "runtime"')[1]!.split('resource "aws_cloudwatch_log_group"')[0]!;
  assert.doesNotMatch(endpoint,/policy\s*=/); assert.match(result.files['main.tf']!,/sagemaker.runtime-fips/);
  for(const [key,value]of Object.entries({image:values.image.replace(/@sha256:.*/,':latest'),role:'bad',kms:values.kms.replace('123456789012','000000000000'),subnets:'bad',clients:'bad',count:0,volume:513,startup:59,download:3601,instance:'ml.p4d.24xlarge',release:'../bad'}))assert.ok(blueprint.build({...values,[key]:value}).findings.some(f=>f.path===key),key);
  assert.ok(blueprint.build({...values,artifact:'ARCHIVE',bucket:'approved-models',key:'../model.tar.gz',version:'null',etag:'bad'}).findings.length>=3);
});
