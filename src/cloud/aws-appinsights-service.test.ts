import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultValues} from '../kit/blueprint.ts';
import {AWS_APPINSIGHTS_SERVICE as blueprint} from './aws-appinsights-service.ts';
import {addServicesFor} from './add-service-catalog.ts';
const values={...defaultValues(blueprint),aws_region:'us-east-1',account:'123456789012',group:'reviewed-compute',instances:'i-12345678,i-abcdef12',tag_key:'MonitoringScope',tag_value:'reviewed-compute',approved:'true'};
test('Application Insights starts approved initial monitoring while future autoconfig/account-wide/notifications stay off',()=>{
  const s=addServicesFor('aws').find(s=>s.id==='amazon-cloudwatch-application-insights')!;assert.equal(s.terraform[0],blueprint);assert.ok(s.terraform.length>1);
  const r=blueprint.build(values);assert.deepEqual(r.findings,[]);const main=r.files['main.tf']!;
  assert.match(main,/auto_create\s+= true/);assert.match(main,/auto_config_enabled\s+= false/);assert.match(main,/cwe_monitor_enabled\s+= true/);assert.match(main,/ops_center_enabled\s+= false/);
  assert.doesNotMatch(main,/grouping_type|aws_iam_role_policy|attach_missing_permission|ops_item_sns_topic_arn|local-exec/);
  assert.doesNotMatch(r.files['INSPECT.py']!,/send_command\(|create_application\(|update_component_configuration\(|attach_role_policy\(/);
  assert.match(r.files['INSPECT.py']!,/if 'Resources' in response/);
});
test('Application Insights validates initial instrumentation approval and exact target scope across US partitions',()=>{
  for(const [key,value]of Object.entries({aws_region:'eu-west-1',account:'bad',group:'bad group',instances:'i-12345678,i-12345678',tag_key:'aws:reserved',tag_value:'',approved:'false'}))assert.ok(blueprint.build({...values,[key]:value}).findings.some(f=>f.path===key),key);
  for(const aws_region of ['us-east-1','us-east-2','us-west-1','us-west-2','us-gov-east-1','us-gov-west-1']){
    const r=blueprint.build({...values,aws_region});assert.deepEqual(r.findings,[]);const c=JSON.parse(r.files['APPINSIGHTS-CONFIG.json']!);assert.equal(c.partition,aws_region.startsWith('us-gov-')?'aws-us-gov':'aws');
  }
});
