import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultValues} from '../kit/blueprint.ts';
import {AWS_INTERNETMONITOR_SERVICE as blueprint} from './aws-internetmonitor-service.ts';
import {addServicesFor} from './add-service-catalog.ts';
const values={...defaultValues(blueprint),aws_region:'us-east-1',name:'reviewed-internet',account:'123456789012',vpcs:'vpc-12345678,vpc-abcdef12',approved:'true'};
test('Internet Monitor reuses existing VPC connectivity with bounded active telemetry and exact owner checks',()=>{
  const s=addServicesFor('aws').find(s=>s.id==='amazon-cloudwatch-internet-monitor')!;assert.equal(s.terraform[0],blueprint);assert.ok(s.terraform.length>1);
  const r=blueprint.build(values);assert.deepEqual(r.findings,[]);assert.match(r.files['main.tf']!,/status\s+= "ACTIVE"/);assert.match(r.files['main.tf']!,/max_city_networks_to_monitor\s+= 500/);assert.match(r.files['providers.tf']!,/allowed_account_ids/);
  assert.doesNotMatch(r.files['main.tf']!,/status\s+= "INACTIVE"|resource "aws_internet_gateway"|resource "aws_vpc"|local-exec|s3_config/);
  assert.match(r.files['SERVICE-SETUP.md']!,/CreateMonitor waits ACTIVE before/);
  assert.doesNotMatch(r.files['INSPECT.py']!,/create_monitor\(|update_monitor\(|get_log_events\(|list_health_events\(/);
});
test('Internet Monitor rejects duplicate/foreign source inputs, invalid caps and missing telemetry approval',()=>{
  for(const [key,value]of Object.entries({aws_region:'us-gov-west-1',name:'bad name',account:'bad',vpcs:'vpc-12345678,vpc-12345678',percentage:0,cities:500001,availability:101,performance:0,approved:'false'}))assert.ok(blueprint.build({...values,[key]:value}).findings.some(f=>f.path===key),key);
  assert.deepEqual(blueprint.build({...values,cities:500000,percentage:1,availability:1,performance:100}).findings,[]);
});
