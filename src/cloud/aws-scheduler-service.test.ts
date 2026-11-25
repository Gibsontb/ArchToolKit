import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultValues} from '../kit/blueprint.ts';
import {AWS_SCHEDULER_SERVICE as blueprint} from './aws-scheduler-service.ts';
import {addServicesFor} from './add-service-catalog.ts';
const values={...defaultValues(blueprint),aws_region:'us-east-1',name:'nightly',target:'arn:aws:lambda:us-east-1:123456789012:function:ApprovedJob:3',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc'};
test('Scheduler builds explicit calendar/interval expressions without enabling application behavior by default',()=>{
  assert.equal(addServicesFor('aws').find(row=>row.id==='amazon-eventbridge-scheduler')?.terraform[0],blueprint);
  for(const [mode,extra,expression]of [['RATE',{},'rate(1 hour)'],['DAILY',{},'cron(0 2 * * ? *)'],['WEEKLY',{},'cron(0 2 ? * MON *)'],['MONTHLY',{},'cron(0 2 1 * ? *)'],['ONCE',{timestamp:'2027-01-01T03:00:00'},'at(2027-01-01T03:00:00)']] as const){
    const result=blueprint.build({...values,mode,...extra});assert.deepEqual(result.findings,[]);
    const config=JSON.parse(result.files['SCHEDULE-CONFIG.json']!);assert.equal(config.expression,expression);assert.equal(config.enabled,false);
    assert.match(result.files['main.tf']!,/state\s+= "DISABLED"/);
  }
  const result=blueprint.build(values),main=result.files['main.tf']!;
  assert.match(main,/schedule-group\/nightly-group/);assert.match(main,/kms:EncryptionContext:aws:scheduler:schedule:arn/);
  assert.match(main,/lambda:InvokeFunction/);assert.match(main,/function:ApprovedJob:3/);
  assert.doesNotMatch(main,/aws_lambda_permission|aws_lambda_function|AdministratorAccess|action_after_completion/);
  assert.doesNotMatch(result.files['INSPECT.py']!,/\.invoke\(|receive_message\(|delete_message\(/);
});
test('Scheduler rejects ambiguous target identities, dates, time zones and hidden irrelevant inputs do not obstruct other modes',()=>{
  for(const [key,value]of Object.entries({target:values.target.replace(':3',':$LATEST'),kms:values.kms.replace('123456789012','000000000000'),timezone:'Bad/Zone',mode:'bad',interval:0,unit:'weeks',attempts:186,age:59,payload:'[]',name:'bad/name',aws_region:'eu-west-1'}))assert.ok(blueprint.build({...values,[key]:value}).findings.some(f=>f.path===key),key);
  assert.ok(blueprint.build({...values,mode:'ONCE',timestamp:'2027-02-30T12:00:00'}).findings.some(f=>f.path==='timestamp'));
  assert.deepEqual(blueprint.build({...values,mode:'RATE',hour:'',minute:'',day:'',timestamp:'',weekday:''}).findings,[]);
  assert.equal(JSON.parse(blueprint.build({...values,interval:2,unit:'minutes'}).files['SCHEDULE-CONFIG.json']!).expression,'rate(2 minutes)');
  const gov={...values,aws_region:'us-gov-west-1',target:values.target.replace('arn:aws:','arn:aws-us-gov:').replace('us-east-1','us-gov-west-1'),kms:values.kms.replace('arn:aws:','arn:aws-us-gov:').replace('us-east-1','us-gov-west-1')};assert.deepEqual(blueprint.build(gov).findings,[]);
});
