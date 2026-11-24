import {test} from 'node:test';import assert from 'node:assert/strict';import {AWS_IAM_SERVICE} from './aws-iam-service.ts';import {defaultValues} from '../kit/blueprint.ts';import {addServicesFor} from './add-service-catalog.ts';
const trust=JSON.stringify({Version:'2012-10-17',Statement:[{Effect:'Allow',Principal:{Service:'lambda.amazonaws.com'},Action:'sts:AssumeRole'}]});
const permission=JSON.stringify({Version:'2012-10-17',Statement:[{Effect:'Allow',Action:'logs:CreateLogStream',Resource:'arn:aws:logs:us-east-1:123456789012:log-group:app:*'}]});
const build=(extra={})=>AWS_IAM_SERVICE.build({...defaultValues(AWS_IAM_SERVICE),aws_region:'us-east-1',name:'app-role',trust_json:trust,...extra},'iam');
test('IAM role form separates trust from permissions and preserves explicit attachments',()=>{
 assert.equal(addServicesFor('aws').find(r=>r.id==='aws-identity-and-access-management').terraform[0],AWS_IAM_SERVICE);const result=build({permissions_json:permission,policy_arns:'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'});assert.equal(result.findings.filter(f=>f.severity==='error').length,0);assert.ok(result.files['main.tf'].includes('aws_iam_role_policy_attachment'));assert.ok(result.files['main.tf'].includes('aws_iam_role_policy'));assert.ok(!result.files['main.tf'].includes('aws_iam_access_key'));
});
test('IAM user, group and managed policy use their own setup paths',()=>{
 for(const kind of ['user','group','policy']){const result=build({kind,permissions_json:permission});assert.equal(result.findings.filter(f=>f.severity==='error').length,0);assert.ok(result.files['main.tf'].includes('resource "aws_iam_'+kind+'"'));assert.ok(!result.files['main.tf'].includes('assume_role_policy'));}
 assert.ok(build({kind:'policy',permissions_json:''}).findings.some(f=>f.severity==='error'));
});
test('IAM form validates policies, role trust, paths and partition-specific attachments',()=>{
 for(const extra of [{trust_json:''},{permissions_json:'{"Statement":[{"Effect":"Wrong","Action":"s3:GetObject","Resource":"*"}]}'},{aws_region:'us-gov-west-1',policy_arns:'arn:aws:iam::aws:policy/ReadOnlyAccess'},{path:'missing-slashes'}])assert.ok(build(extra).findings.some(f=>f.severity==='error'));
});
