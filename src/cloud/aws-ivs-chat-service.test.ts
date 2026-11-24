import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultValues} from '../kit/blueprint.ts';
import {AWS_IVS_CHAT_SERVICE as blueprint} from './aws-ivs-chat-service.ts';
import {addServicesFor} from './add-service-catalog.ts';
const values={...defaultValues(blueprint),aws_region:'us-east-1',name:'moderated-chat',account:'123456789012',reviewer:'arn:aws:lambda:us-east-1:123456789012:function:ReviewChat:7',logging:'arn:aws:ivschat:us-east-1:123456789012:logging-configuration/AbCdEf123456',log_group:'/approved/chat',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc',approved:true};
test('Chat room retains approved existing moderation/logging and fails closed',()=>{
  assert.equal(addServicesFor('aws').find(row=>row.id==='amazon-ivs-chat')?.terraform[0],blueprint);
  const result=blueprint.build(values);assert.deepEqual(result.findings,[]);
  assert.match(result.files['main.tf']!,/fallback_result\s+= "DENY"/);
  assert.match(result.files['main.tf']!,/ReviewChat:7/);
  assert.match(result.files['main.tf']!,/prevent_destroy\s+= true/);
  assert.doesNotMatch(result.files['main.tf']!,/aws_lambda_permission|aws_lambda_function|aws_cloudwatch_log_group|aws_ivschat_logging_configuration/);
  assert.doesNotMatch(result.files['CHECK.py']!,/create_chat_token\(|send_message\(|invoke\(|get_log_events\(/);
});
test('Chat validates function version, content approval, account/region and per-room limits',()=>{
  for(const [field,value]of Object.entries({approved:false,reviewer:values.reviewer.replace(':7',':live'),logging:values.logging.replace('us-east-1','us-west-2'),kms:values.kms.replace('123456789012','000000000000'),length:501,rate:101,retention:1,aws_region:'us-gov-west-1',account:'[',log_group:'bad space'}))assert.ok(blueprint.build({...values,[field]:value}).findings.some(f=>f.path===field),field);
});
