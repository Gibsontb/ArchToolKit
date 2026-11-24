import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultValues} from '../kit/blueprint.ts';
import {AWS_INSTANCE_CONNECT_SERVICE as blueprint} from './aws-instance-connect-service.ts';
import {addServicesFor} from './add-service-catalog.ts';
const values={...defaultValues(blueprint),aws_region:'us-east-1',name:'admin-access',account:'123456789012',subnet:'subnet-0123456789abcdef0',target_group:'sg-0123456789abcdef0',destination:'10.20.30.40',role:'arn:aws:iam::123456789012:role/operators/Admin'};
test('Instance Connect creates dedicated endpoint with exact tunnel scope and preserves shared resources',()=>{
  assert.equal(addServicesFor('aws').find(row=>row.id==='aws-ec2-instance-connect')?.terraform[0],blueprint);
  const result=blueprint.build(values);assert.deepEqual(result.findings,[]);
  const hcl=result.files['main.tf']!;
  assert.match(hcl,/resource "aws_ec2_instance_connect_endpoint"/);
  assert.match(hcl,/ec2-instance-connect:OpenTunnel/);
  assert.match(hcl,/10.20.30.40\/32/);
  assert.match(hcl,/preserve_client_ip\s+= false/);
  assert.doesNotMatch(hcl,/SendSSHPublicKey|resource "aws_instance"|resource "aws_iam_role"|local-exec|remote-exec|0\.0\.0\.0\/0/);
  assert.match(hcl,/role\s+= "Admin"/);
  assert.match(result.files['CONNECT-EXAMPLE.txt']!,/--remote-port 22/);
});
test('RDP and GovCloud use chosen port/duration and reject mismatched or public destinations',()=>{
  const result=blueprint.build({...values,aws_region:'us-gov-west-1',role:values.role.replace('arn:aws:','arn:aws-us-gov:'),protocol:'RDP',duration:600});
  assert.deepEqual(result.findings,[]);
  assert.match(result.files['CONNECT-EXAMPLE.txt']!,/--remote-port 3389.*--max-tunnel-duration 600/);
  for(const [field,value] of Object.entries({account:'123',destination:'8.8.8.8',duration:3601,role:values.role.replace('123456789012','000000000000'),protocol:'HTTP',name:'Bad name',subnet:'bad',target_group:'bad'}))assert.ok(blueprint.build({...values,[field]:value}).findings.some(f=>f.path===field),field);
  for(const destination of ['010.2.3.4','172.32.0.1','192.168.1.256','10.2.3.4/32','127.0.0.1'])assert.ok(blueprint.build({...values,destination}).findings.some(f=>f.path==='destination'),destination);
  assert.ok(blueprint.build({...values,account:'['}).findings.some(f=>f.path==='account'));
});
