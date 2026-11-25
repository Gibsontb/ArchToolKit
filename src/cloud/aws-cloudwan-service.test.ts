import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultValues} from '../kit/blueprint.ts';
import {AWS_CLOUDWAN_SERVICE as blueprint} from './aws-cloudwan-service.ts';
import {addServicesFor} from './add-service-catalog.ts';
const values={...defaultValues(blueprint),aws_region:'us-east-1',name:'isolated-core',account:'123456789012'};
test('CloudWAN creates a new isolated core and uses the native account condition with staged acceptance',()=>{
  assert.equal(addServicesFor('aws').find(row=>row.id==='aws-cloud-wan')?.terraform[0],blueprint);
  for(const attachment of ['none','vpc']){
    const result=blueprint.build({...values,attachment,vpc:'vpc-12345678',subnets:'subnet-12345678,subnet-abcdef12'});
    assert.deepEqual(result.findings,[]);
    const policy=JSON.parse(result.files['CORE-POLICY.json']!);
    assert.ok(policy.segments.every((s:any)=>s['isolate-attachments']&&s['require-attachment-acceptance']));
    assert.ok(policy['attachment-policies'].every((rule:any)=>rule.conditions.some((c:any)=>c.type==='account'&&c.value===values.account)));
    assert.equal(policy['segment-actions'],undefined);
    assert.match(result.files['providers.tf']!,/alias\s+= "control"/);
    assert.match(result.files['main.tf']!,/create_base_policy\s+= true/);
    assert.doesNotMatch(result.files['main.tf']!,/resource "aws_route"|resource "aws_networkmanager_attachment_accepter"|local-exec/);
    assert.equal(result.files['main.tf']!.includes('resource "aws_networkmanager_vpc_attachment"'),attachment==='vpc');
  }
});
test('CloudWAN rejects unsupported partitions, duplicate segments, insufficient ASN pools and mismatched VPC edge',()=>{
  for(const [key,value]of Object.entries({account:'bad',name:'bad name',aws_region:'us-gov-west-1',edges:'us-east-1,us-east-1',segments:'prod,prod',asn_start:64000,asn_end:64519,attachment:'auto-accept'}))assert.ok(blueprint.build({...values,[key]:value}).findings.some(f=>f.path===key||key==='asn_end'&&f.path==='asn_start'),key);
  for(const override of [{edges:'us-west-2'},{segment:'unknown'},{vpc:'bad'},{subnets:'subnet-12345678,subnet-12345678'}])assert.ok(blueprint.build({...values,attachment:'vpc',vpc:'vpc-12345678',subnets:'subnet-12345678,subnet-abcdef12',...override}).findings.length);
  assert.ok(blueprint.build({...values,edges:'us-east-1,us-west-2',asn_start:64520,asn_end:64520}).findings.length);
});
