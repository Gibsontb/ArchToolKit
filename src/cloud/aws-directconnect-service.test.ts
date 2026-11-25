import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultValues} from '../kit/blueprint.ts';
import {AWS_DIRECTCONNECT_SERVICE as blueprint} from './aws-directconnect-service.ts';
import {addServicesFor} from './add-service-catalog.ts';
const values={...defaultValues(blueprint),aws_region:'us-east-1',name:'private-vif',account:'123456789012',connection:'dxcon-1234abcd',connection_name:'approved-circuit',gateway:'12345678-abcd-4bcd-8bcd-123456789abc',gateway_name:'approved-gateway',onprem:'10.20.0.0/16',cloud:'10.100.0.0/16'};
test('DirectConnect preserves existing connection/gateway and exports staged vendor code without a GUI secret',()=>{
  assert.equal(addServicesFor('aws').find(row=>row.id==='aws-direct-connect')?.terraform[0],blueprint);
  for(const [vendor,port]of [['FRR','eth0'],['CISCO','TenGigabitEthernet0/0/0'],['JUNOS','xe-0/0/0']]){
    const result=blueprint.build({...values,vendor,port});assert.deepEqual(result.findings,[]);
    assert.match(result.files['main.tf']!,/resource "aws_dx_private_virtual_interface"/);
    assert.match(result.files['main.tf']!,/sensitive\(var.bgp_auth_key\)/);assert.match(result.files['variables.tf']!,/sensitive\s+= true/);
    assert.doesNotMatch(result.files['main.tf']!,/resource "aws_dx_connection"|resource "aws_dx_gateway"|aws_secretsmanager_secret_version|local-exec/);
    assert.match(result.files['CPE-REVIEW.cfg']!,vendor==='JUNOS'?/deactivate protocols bgp group/:/neighbor 169\.254\.100\.1 shutdown/);
    assert.match(result.files['CPE-REVIEW.cfg']!,/REPLACE_FROM_APPROVED_SECRET_STORE/);
    assert.doesNotMatch(result.files['CONNECTION-CONFIG.json']!,/authKey|auth_key|password/);
    assert.doesNotMatch(result.files['INSPECT.py']!,/create_private_virtual_interface\(|update_connection\(|get_secret_value\(/);
  }
});
test('DirectConnect validates immutable VLAN/peer/ASN choices, owner identity and exact nonoverlapping route prefixes',()=>{
  for(const [key,value]of Object.entries({account:'bad',connection:'bad',gateway:'bad',connection_name:'',gateway_name:'',vlan:4095,customer_asn:4200000000,amazon_asn:1,customer:'169.254.100.0/30',amazon:'169.254.100.2/30',onprem:'0.0.0.0/0',cloud:'10.20.0.0/16',vendor:'OTHER',port:'eth0;shutdown',aws_region:'us-gov-west-1'}))assert.ok(blueprint.build({...values,[key]:value}).findings.some(f=>f.path===key),key);
  assert.ok(blueprint.build({...values,onprem:'10.20.0.1/16'}).findings.some(f=>f.path==='onprem'));
  assert.ok(blueprint.build({...values,amazon:'169.254.101.1/30'}).findings.some(f=>f.path==='amazon'));
  assert.ok(blueprint.build({...values,vendor:'CISCO'}).findings.some(f=>f.path==='port'));
  assert.ok(blueprint.build({...values,amazon_asn:65000}).findings.some(f=>f.path==='customer_asn'));
  assert.ok(blueprint.build({...values,onprem:'10.20.0.0/16/extra'}).findings.some(f=>f.path==='onprem'));
  assert.ok(blueprint.build({...values,customer:'169.254.100.2/30/extra'}).findings.some(f=>f.path==='customer'));
});
