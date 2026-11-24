import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_DATASYNC_FSX_WINDOWS_SERVICE as blueprint } from './aws-datasync-fsx-windows-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values={...defaultValues(blueprint),aws_region:'us-east-1',name:'windows-migration',agent:'arn:aws:datasync:us-east-1:123456789012:agent/agent-0123456789abcdef0',server:'files.example.com',path:'/Finance$/Reports',user:'SourceReader',domain:'EXAMPLE',ntlm_allowed:true,filesystem:'fs-0123456789abcdef0',group:'sg-0123456789abcdef0',target_user:'FsxMigration',target_domain:'EXAMPLE'};
test('FSx Windows migration preserves owner/DACL selection and isolates two deploy-time secrets',()=>{
  assert.equal(addServicesFor('aws').find(row=>row.id==='aws-datasync')?.terraform[4],blueprint);
  const result=blueprint.build({...values,smb_source_password:'SOURCE-NOT-EXPORTED',fsx_destination_password:'TARGET-NOT-EXPORTED'});
  assert.deepEqual(result.findings,[]);
  assert.doesNotMatch(Object.values(result.files).join('\n'),/SOURCE-NOT-EXPORTED|TARGET-NOT-EXPORTED/);
  assert.equal((result.files['variables.tf']!.match(/sensitive\s+= true/g)||[]).length,2);
  assert.doesNotMatch(result.files['variables.tf']!,/default\s*=/);
  assert.match(result.files['main.tf']!,/resource "aws_datasync_location_fsx_windows_file_system"/);
  assert.match(result.files['main.tf']!,/security_descriptor_copy_flags\s+= "OWNER_DACL"/);
  const config=JSON.parse(result.files['TRANSFER-CONFIG.json']!);
  assert.equal(config.destination.kind,'fsxwindows');
  assert.equal(config.destination.user,'FsxMigration');
  assert.match(result.files['outputs.tf']!,/destination_uri = aws_datasync_location_fsx_windows_file_system.destination.uri/);
  assert.match(result.files['SERVICE-SETUP.md']!,/SYSTEM must retain Full Control/);
});
test('FSx security metadata requires domain identity and explicit same/trusted relationship',()=>{
  for(const [key,value] of Object.entries({domain:'',target_domain:'',target_user:'EXAMPLE\\User',relationship:'OTHER',filesystem:'invalid',group:'invalid',target_path:'/../share',security:'NONE',ntlm_allowed:false,bandwidth:-1})) assert.ok(blueprint.build({...values,[key]:value}).findings.some(f=>f.path===key),key);
  assert.ok(blueprint.build({...values,target_domain:'OTHER'}).findings.some(f=>f.path==='relationship'));
  const result=blueprint.build({...values,target_domain:'OTHER',relationship:'TRUSTED',security:'OWNER_DACL_SACL',overwrite:'ALWAYS'});
  assert.deepEqual(result.findings,[]);
  assert.match(result.files['main.tf']!,/security_descriptor_copy_flags\s+= "OWNER_DACL_SACL"/);
});
