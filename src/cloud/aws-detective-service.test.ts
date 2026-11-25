import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultValues} from '../kit/blueprint.ts';
import {AWS_DETECTIVE_SERVICE as blueprint} from './aws-detective-service.ts';
import {addServicesFor} from './add-service-catalog.ts';
const values={...defaultValues(blueprint),aws_region:'us-east-1',name:'reviewed-investigation',account:'123456789012',approved:'true'};
test('Detective graph has explicit telemetry approval/account protection without fake package switches or enrollment',()=>{
  const service=addServicesFor('aws').find(s=>s.id==='amazon-detective')!;assert.equal(service.terraform[0],blueprint);assert.ok(service.terraform.length>1);
  const r=blueprint.build(values);assert.deepEqual(r.findings,[]);assert.match(r.files['main.tf']!,/prevent_destroy\s+= true/);assert.match(r.files['providers.tf']!,/use_fips_endpoint\s+= true/);
  assert.doesNotMatch(r.files['main.tf']!,/aws_detective_member|aws_detective_organization|kms_key|retention|datasource|local-exec/);
  assert.match(r.files['SERVICE-SETUP.md']!,/enable both optional source packages by default|enable core/);
  assert.doesNotMatch(r.files['INSPECT.py']!,/create_graph\(|create_members\(|start_investigation\(|get_findings\(|delete_graph\(/);
});
test('Detective blocks missing telemetry approval and wrong region/account/name',()=>{
  for(const [key,value]of Object.entries({approved:'false',aws_region:'us-gov-west-1',account:'bad',name:'sensitive@invalid'}))assert.ok(blueprint.build({...values,[key]:value}).findings.some(f=>f.path===key),key);
  for(const aws_region of ['us-east-1','us-east-2','us-west-1','us-west-2'])assert.deepEqual(blueprint.build({...values,aws_region}).findings,[]);
});
