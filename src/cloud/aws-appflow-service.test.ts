import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultValues} from '../kit/blueprint.ts';
import {AWS_APPFLOW_SERVICE as blueprint} from './aws-appflow-service.ts';
import {addServicesFor} from './add-service-catalog.ts';
const values={...defaultValues(blueprint),aws_region:'us-east-1',name:'reviewed-export',account:'123456789012',profile:'approved-private-salesforce',instance:'https://approved.my.salesforce.com',bucket:'approved-flow-output',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc'};
test('AppFlow stages explicitly projected on-demand exports and retains existing profiles/policies',()=>{
  assert.equal(addServicesFor('aws').find(row=>row.id==='amazon-appflow')?.terraform[0],blueprint);
  for(const object of ['Account','Contact','Opportunity'])for(const format of ['JSON','CSV']){
    const result=blueprint.build({...values,object,format});assert.deepEqual(result.findings,[]);
    assert.match(result.files['main.tf']!,/OnDemand/);assert.match(result.files['main.tf']!,/PROJECTION/);assert.match(result.files['main.tf']!,/enable_dynamic_field_update\s+= false/);
    assert.doesNotMatch(result.files['main.tf']!,/Map_all|resource "aws_appflow_connector_profile"|resource "aws_s3_bucket_policy"|resource "aws_kms_key"|local-exec/);
    const policy=JSON.parse(result.files['BUCKET-POLICY-MERGE.json']!);assert.ok(policy.Statement.every((s:any)=>s.Condition.StringEquals['aws:SourceAccount']===values.account&&s.Condition.ArnEquals['aws:SourceArn'].endsWith('/reviewed-export')));
    assert.doesNotMatch(result.files['INSPECT.py']!,/start_flow\(|get_secret_value\(|get_object\(|put_bucket_policy\(/);
  }
});
test('AppFlow validates owner/org URL/key/projection/destination before exporting',()=>{
  for(const [key,value]of Object.entries({aws_region:'us-gov-west-1',name:'bad name',account:'bad',profile:'secret token',instance:'https://user:pass@approved.my.salesforce.com',object:'All',fields:'*',bucket:'bucket.with.dots',prefix:'../all/',kms:'alias/default',format:'PARQUET'}))assert.ok(blueprint.build({...values,[key]:value}).findings.some(f=>f.path===key),key);
  assert.ok(blueprint.build({...values,fields:'Id,Id'}).findings.some(f=>f.path==='fields'));
  assert.ok(blueprint.build({...values,instance:'https://approved.my.salesforce.com/path'}).findings.some(f=>f.path==='instance'));
});
