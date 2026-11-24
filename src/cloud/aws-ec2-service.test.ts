import {test} from 'node:test';import assert from 'node:assert/strict';import {addServicesFor} from './add-service-catalog.ts';import {defaultValues} from '../kit/blueprint.ts';
const form=()=>addServicesFor('aws').find(row=>row.id==='amazon-elastic-compute-cloud').terraform[0];
const valid=()=>({...defaultValues(form()),aws_region:'us-gov-west-1',subnet_id:'subnet-1234abcd',instance_name:'server-01'});
test('EC2 service form is distinct, requires network and resolves its AMI in the selected region',()=>{
 const build=form();assert.equal(build.id,'aws_service_ec2');assert.ok(build.build(defaultValues(build),'server').findings.some(f=>f.severity==='error'));
 const result=build.build(valid(),'server');assert.equal(result.findings.filter(f=>f.severity==='error').length,0);
 assert.ok(result.files['providers.tf'].includes('us-gov-west-1'));assert.ok(result.files['main.tf'].includes('data.aws_ssm_parameter.image.value'));assert.ok(!result.files['main.tf'].includes('resolve:ssm:'));assert.ok(!result.files['main.tf'].includes('var.vpc_id'));assert.ok(result.files['main.tf'].includes('http_tokens = "required"'));assert.ok(!result.files['main.tf'].includes('  ingress {'));
});
test('EC2 Windows setup configures RDP and root disk; existing SG path omits new rules',()=>{
 const values={...valid(),image_source:'windows2022',admin_access:'rdp',admin_cidrs:'10.20.0.0/16'};const result=form().build(values,'server');assert.ok(result.files['main.tf'].includes('from_port = 3389'));assert.ok(result.files['main.tf'].includes('Windows_Server-2022-English-Full-Base'));assert.ok(form().build({...values,root_gib:8},'server').findings.some(f=>f.severity==='error'));
 const existing=form().build({...values,security_mode:'existing',security_group_ids:'sg-1234abcd'},'server');assert.equal(existing.findings.filter(f=>f.severity==='error').length,0);assert.ok(!existing.files['main.tf'].includes('resource "aws_security_group"'));assert.ok(existing.files['main.tf'].includes('["sg-1234abcd"]'));
});
