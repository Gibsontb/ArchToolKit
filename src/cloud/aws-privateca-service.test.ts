import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultValues} from '../kit/blueprint.ts';
import {AWS_PRIVATECA_SERVICE as blueprint,PCA_PROFILES} from './aws-privateca-service.ts';
import {addServicesFor} from './add-service-catalog.ts';
const values={...defaultValues(blueprint),aws_region:'us-east-1',name:'reviewed-subordinate',account:'123456789012',common_name:'Approved Issuing CA G2',organization:'Approved Organization',approved:'true'};
test('Private CA stages a subordinate CSR/OCSP/HSM profile without new root/activation/issuance permissions',()=>{
  const services=addServicesFor('aws');assert.equal(services.find(s=>s.id==='aws-private-certificate-authority')?.terraform[0],blueprint);assert.equal(services.find(s=>s.id==='aws-certificate-manager-private-certificate-authority')?.terraform[0],blueprint);
  const r=blueprint.build(values);assert.deepEqual(r.findings,[]);const main=r.files['main.tf']!;
  assert.match(main,/type\s+= "SUBORDINATE"/);assert.match(main,/usage_mode\s+= "GENERAL_PURPOSE"/);assert.match(main,/key_storage_security_standard\s+= "FIPS_140_2_LEVEL_3_OR_HIGHER"/);assert.match(main,/permanent_deletion_time_in_days\s+= 30/);assert.match(main,/ocsp_configuration/);
  assert.doesNotMatch(main,/aws_acmpca_certificate_authority_certificate|aws_acmpca_certificate"|aws_acmpca_permission|aws_acmpca_policy|type\s+= "ROOT"|local-exec/);
  assert.match(r.files['outputs.tf']!,/sensitive\s+= true/);assert.match(r.files['GET-CSR.ps1']!,/FileMode\]::CreateNew/);
  assert.doesNotMatch(r.files['INSPECT.py']!,/issue_certificate\(|import_certificate_authority_certificate\(|get_certificate_authority_csr\(|get_certificate_authority_certificate\(/);
});
test('All four classic profiles keep matching signature families, and unsafe CA scope/subject/cost approval fails',()=>{
  for(const aws_region of ['us-east-1','us-east-2','us-west-1','us-west-2'])for(const [profile,pair]of Object.entries(PCA_PROFILES)){
    const r=blueprint.build({...values,aws_region,profile,unit:'Platform PKI'});assert.deepEqual(r.findings,[]);assert.match(r.files['main.tf']!,new RegExp('key_algorithm\\s+= "'+pair.key+'"'));assert.match(r.files['main.tf']!,new RegExp('signing_algorithm\\s+= "'+pair.sign+'"'));
  }
  for(const [key,value]of Object.entries({aws_region:'us-gov-west-1',name:'bad name',account:'bad',common_name:'',organization:'x\nInjected',unit:'bad/subject',country:'USA',profile:'ml-dsa',approved:'false'}))assert.ok(blueprint.build({...values,[key]:value}).findings.some(f=>f.path===key),key);
});
