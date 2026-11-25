import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultValues} from '../kit/blueprint.ts';
import {AWS_ACCESS_ANALYZER_SERVICE as blueprint} from './aws-access-analyzer-service.ts';
import {addServicesFor} from './add-service-catalog.ts';
const values={...defaultValues(blueprint),aws_region:'us-east-1',name:'reviewed-access',account:'123456789012'};
test('Access Analyzer preserves native builders and shares one control-plane form across verified names',()=>{
  const rows=addServicesFor('aws');
  for(const id of ['access-analyzer','aws-identity-and-access-management-access-analyzer'])assert.equal(rows.find(row=>row.id===id)?.terraform[0],blueprint);
  for(const analysis of ['EXTERNAL','UNUSED'])for(const zone of ['ACCOUNT','ORGANIZATION']){
    const result=blueprint.build({...values,type:zone+(analysis==='UNUSED'?'_UNUSED_ACCESS':''),organization:'o-1234567890'}); assert.deepEqual(result.findings,[]);
    assert.match(result.files['main.tf']!,/resource "aws_accessanalyzer_analyzer"/);
    assert.match(result.files['providers.tf']!,/use_fips_endpoint\s+= true/);
    assert.equal(result.files['main.tf']!.includes('unused_access_age'),analysis==='UNUSED');
    assert.equal(result.files['main.tf']!.includes('data "aws_organizations_organization"'),zone==='ORGANIZATION');
    assert.doesNotMatch(result.files['main.tf']!,/resource "aws_accessanalyzer_archive_rule"|resource "aws_organizations_|resource "aws_iam_role"|local-exec/);
    assert.doesNotMatch(result.files['INSPECT.py']!,/update_findings\(|create_archive_rule\(|start_resource_scan\(|register_delegated_administrator\(/);
  }
});
test('Access Analyzer validates the explicit type/boundary/age/owner/region contract',()=>{
  for(const [key,value]of Object.entries({name:'bad name',account:'bad',aws_region:'us-gov-west-1',type:'INTERNAL'}))assert.ok(blueprint.build({...values,[key]:value}).findings.some(f=>f.path===key),key);
  assert.ok(blueprint.build({...values,type:'ORGANIZATION',organization:'bad'}).findings.some(f=>f.path==='organization'));
  assert.ok(blueprint.build({...values,type:'ACCOUNT_UNUSED_ACCESS',age:0}).findings.some(f=>f.path==='age'));
});
