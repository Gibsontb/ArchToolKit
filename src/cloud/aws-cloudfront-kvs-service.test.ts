import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createContext,runInContext} from 'node:vm';
import {defaultValues} from '../kit/blueprint.ts';
import {AWS_CLOUDFRONT_KVS_SERVICE as blueprint} from './aws-cloudfront-kvs-service.ts';
import {addServicesFor} from './add-service-catalog.ts';
const values={...defaultValues(blueprint),name:'reviewed-edge',account:'123456789012',approved:'true'};
test('Global KVS flag stages one nonsecret native key and unpublished function without exclusive deletion/distribution edits',()=>{
  const services=addServicesFor('aws');assert.equal(services.find(s=>s.id==='amazon-cloudfront-keyvaluestore')?.terraform[0],blueprint);assert.equal(services.find(s=>s.id==='amazon-cloudfront')?.terraform[1],blueprint);
  const r=blueprint.build(values);assert.deepEqual(r.findings,[]);assert.match(r.files['main.tf']!,/publish\s+= false/);assert.match(r.files['main.tf']!,/runtime\s+= "cloudfront-js-2.0"/);assert.match(r.files['main.tf']!,/value\s+= "false"/);assert.match(r.files['providers.tf']!,/use_fips_endpoint\s+= false/);
  assert.doesNotMatch(r.files['main.tf']!,/keys_exclusive|resource "aws_cloudfront_distribution"|import_source|local-exec/);
  assert.doesNotMatch(r.files['INSPECT.py']!,/put_key\(|update_keys\(|publish_function\(|test_function\(|list_keys\(/);
  assert.match(r.files['INSPECT.py']!,/signature_version='v4a'/);
});
test('KVS global residency/crypto approval, owner, names and boolean values are validated',()=>{
  for(const [key,value]of Object.entries({aws_region:'us-gov-west-1',account:'bad',name:'bad name',enabled:'secret',approved:'false'}))assert.ok(blueprint.build({...values,[key]:value}).findings.some(f=>f.path===key),key);
  assert.deepEqual(blueprint.build({...values,enabled:'true'}).findings,[]);
});
test('Exact exported feature function fails off, overwrites viewer header and preserves request data under local KVS doubles',async()=>{
  const code=blueprint.build(values).files['FEATURE-FLAG.js']!;assert.match(code,/^import cf from 'cloudfront';/);
  for(const [scenario,value,expected]of [['true','true','true'],['false','false','false'],['wrong-case','TRUE','false'],['boolean',true,'false'],['object',{},'false'],['missing',null,'false'],['read-error',null,'false'],['no-association',null,'false']]as const){
    let reads=0;
    const cf={kvs:()=>{if(scenario==='no-association')throw Error('synthetic');return {get:async(key:string)=>{assert.equal(key,'migration_enabled');reads++;if(scenario==='read-error')throw Error('synthetic');return value;}};}};
    const event={request:{method:'GET',uri:'/unchanged',querystring:{page:{value:'2'}},headers:{host:{value:'approved.example'},'x-migration-enabled':{value:'viewer-controlled',multiValue:[{value:'viewer-controlled'}]}}}};
    const handler=runInContext(code.replace(/^import cf from 'cloudfront';\r?\n/,'')+'\nhandler',createContext({cf})) as (input:typeof event)=>Promise<typeof event.request>;
    const before=JSON.stringify({method:event.request.method,uri:event.request.uri,querystring:event.request.querystring,host:event.request.headers.host});
    const result=await handler(event);assert.equal(result,event.request);assert.equal(result.headers['x-migration-enabled'].value,expected,scenario);assert.equal('multiValue' in result.headers['x-migration-enabled'],false);
    assert.equal(JSON.stringify({method:result.method,uri:result.uri,querystring:result.querystring,host:result.headers.host}),before);assert.equal(reads,scenario==='no-association'?0:1);
  }
});
