import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultValues} from '../kit/blueprint.ts';
import {AWS_MWAA_SERVICE as blueprint} from './aws-mwaa-service.ts';
import {addServicesFor} from './add-service-catalog.ts';
const values={...defaultValues(blueprint),aws_region:'us-east-1',name:'reviewed-workflows',account:'123456789012',bucket:'approved-airflow-dags',role:'approved-airflow-execution',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc',subnets:'subnet-12345678,subnet-abcdef12',group:'sg-12345678'};
test('MWAA private environment preserves existing DAG/network/role and exports unexecuted Airflow2 smoke code',()=>{
  assert.equal(addServicesFor('aws').find(row=>row.id==='amazon-mwaa')?.terraform[0],blueprint);
  for(const version of ['2.11.2','2.11.0','2.10.3']){
    const result=blueprint.build({...values,version});assert.deepEqual(result.findings,[]);
    assert.match(result.files['main.tf']!,/PRIVATE_ONLY/);assert.match(result.files['main.tf']!,/endpoint_management\s+= "SERVICE"/);
    assert.equal((result.files['main.tf']!.match(/resource "aws_cloudwatch_log_group"/g)||[]).length,5);
    assert.doesNotMatch(result.files['main.tf']!,/resource "aws_iam_role"|resource "aws_s3_object"|resource "aws_route"|resource "aws_security_group"|local-exec/);
    assert.match(result.files['review_smoke_dag.py']!,/schedule=None/);assert.match(result.files['review_smoke_dag.py']!,/is_paused_upon_creation=True/);
    assert.doesNotMatch(result.files['INSPECT.py']!,/create_cli_token\(|create_web_login_token\(|invoke_rest_api\(|get_object\(|get_log_events\(|put_object\(/);
  }
});
test('MWAA validates version, worker bounds, protected identity/network and maintenance selection',()=>{
  for(const [key,value]of Object.entries({aws_region:'us-gov-west-1',name:'bad name',account:'wrong',version:'latest',size:'unbounded',bucket:'bucket.with.dots',prefix:'../dags/',role:'arn:aws:iam::123456789012:role/x',kms:'alias/aws',subnets:'subnet-12345678,subnet-12345678',group:'bad',min_workers:3,max_workers:0,retention:0,maintenance:'SUN:24:00'}))assert.ok(blueprint.build({...values,[key]:value}).findings.some(f=>f.path===key||key==='max_workers'&&f.path==='min_workers'),key);
});
