import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_DATASYNC_SMB_SERVICE as blueprint } from './aws-datasync-smb-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values={...defaultValues(blueprint),aws_region:'us-east-1',name:'windows-files',agent:'arn:aws:datasync:us-east-1:123456789012:agent/agent-0123456789abcdef0',server:'files.example.com',path:'/Finance$/Reports',user:'MigrationReader',domain:'EXAMPLE',bucket:'application-landing',role:'arn:aws:iam::123456789012:role/DataSyncS3',ntlm_allowed:true};
test('SMB transfer has a distinct gated source and does not collect or export passwords',()=>{
  assert.equal(addServicesFor('aws').find(row=>row.id==='aws-datasync')?.terraform[3],blueprint);
  assert.ok(!blueprint.inputs.some(input=>/password/i.test(input.id)));
  const result=blueprint.build({...values,smb_source_password:'SYNTHETIC-MUST-NOT-BE-EXPORTED'});
  assert.deepEqual(result.findings,[]);
  const all=Object.values(result.files).join('\n');
  assert.doesNotMatch(all,/SYNTHETIC-MUST-NOT-BE-EXPORTED/);
  assert.match(result.files['variables.tf']!,/sensitive\s+= true/);
  assert.match(result.files['variables.tf']!,/variable "smb_source_password"/);
  assert.doesNotMatch(result.files['variables.tf']!,/default\s*=/);
  assert.match(result.files['main.tf']!,/password\s+= var.smb_source_password/);
  assert.match(result.files['main.tf']!,/version\s+= "SMB3"/);
  assert.match(result.files['main.tf']!,/security_descriptor_copy_flags\s+= "NONE"/);
  assert.equal(JSON.parse(result.files['TRANSFER-CONFIG.json']!).source.kind,'smb');
  assert.match(result.files['SERVICE-SETUP.md']!,/S3 does not implement Windows ownership/);
});
test('SMB transfer enforces NTLM policy fact and separate username/domain/network boundaries',()=>{
  for(const [key,value] of Object.entries({ntlm_allowed:false,user:'EXAMPLE\\Reader',domain:'bad/domain',path:'//files/share',server:'999.1.1.1',agent:values.agent.replace('us-east-1','us-west-2'),role:values.role.replace('123456789012','000000000000'),prefix:'/../landing/',bandwidth:-1})) assert.ok(blueprint.build({...values,[key]:value}).findings.some(f=>f.path===key),key);
  assert.deepEqual(blueprint.build({...values,ntlm_allowed:'true',domain:'',overwrite:'ALWAYS',bandwidth:12.5}).findings,[]);
  assert.ok(blueprint.build({...values,ntlm_allowed:'false'}).findings.some(f=>f.path==='ntlm_allowed'));
});
