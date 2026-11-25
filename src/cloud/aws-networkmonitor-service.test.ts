import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultValues} from '../kit/blueprint.ts';
import {AWS_NETWORKMONITOR_SERVICE as blueprint} from './aws-networkmonitor-service.ts';
import {addServicesFor} from './add-service-catalog.ts';
const values={...defaultValues(blueprint),aws_region:'us-east-1',name:'reviewed-hybrid',account:'123456789012',subnet:'subnet-12345678',destination:'10.200.0.10',approved:'true'};
test('Synthetic Monitor emits exact approved TCP probe with source ownership and no invented staging state',()=>{
  const s=addServicesFor('aws').find(s=>s.id==='amazon-cloudwatch-network-monitor')!;assert.equal(s.terraform[0],blueprint);assert.ok(s.terraform.length>1);
  const r=blueprint.build(values);assert.deepEqual(r.findings,[]);assert.match(r.files['main.tf']!,/destination_port\s+= 443/);assert.match(r.files['providers.tf']!,/use_fips_endpoint\s+= true/);
  assert.match(r.files['main.tf']!,/source_arn\s+= "arn:aws:ec2:us-east-1:123456789012:subnet\/subnet-12345678"/);
  assert.doesNotMatch(r.files['main.tf']!,/state\s+=|aws_route|aws_security_group|local-exec/);
  assert.doesNotMatch(r.files['INSPECT.py']!,/create_probe\(|update_probe\(|socket|subprocess/);
});
test('ICMP ignores hidden port; unsafe targets/schedules/traffic approval fail',()=>{
  const r=blueprint.build({...values,protocol:'ICMP',port:'stale'});assert.deepEqual(r.findings,[]);assert.doesNotMatch(r.files['main.tf']!,/destination_port|stale/);
  for(const [key,value]of Object.entries({aws_region:'us-gov-west-1',name:'bad name',account:'bad',subnet:'other',destination:'169.254.169.254',protocol:'UDP',port:65536,packet:8501,aggregation:1,approved:'false'}))assert.ok(blueprint.build({...values,[key]:value}).findings.some(f=>f.path===key),key);
  for(const destination of ['8.8.8.8','10.0.0.2','127.0.0.1','10.0200.0.10','172.32.0.1','224.0.0.1'])assert.ok(blueprint.build({...values,destination}).findings.some(f=>f.path==='destination'),destination);
});
