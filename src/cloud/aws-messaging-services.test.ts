import {test} from 'node:test';import assert from 'node:assert/strict';import {AWS_SQS_SERVICE,AWS_SNS_SERVICE} from './aws-messaging-services.ts';import {defaultValues} from '../kit/blueprint.ts';import {addServicesFor} from './add-service-catalog.ts';
const sqs=(extra={})=>AWS_SQS_SERVICE.build({...defaultValues(AWS_SQS_SERVICE),aws_region:'us-east-1',name:'app-work',...extra},'queue');
const sns=(extra={})=>AWS_SNS_SERVICE.build({...defaultValues(AWS_SNS_SERVICE),aws_region:'us-east-1',name:'app-notifications',...extra},'topic');
test('queue and topic select distinct service forms and configure different resources',()=>{
 assert.equal(addServicesFor('aws').find(row=>row.id==='amazon-simple-queue-service').terraform[0],AWS_SQS_SERVICE);assert.equal(addServicesFor('aws').find(row=>row.id==='amazon-simple-notification-service').terraform[0],AWS_SNS_SERVICE);
 assert.equal(sqs().findings.filter(f=>f.severity==='error').length,0);assert.equal(sns().findings.filter(f=>f.severity==='error').length,0);
 assert.ok(sqs().files['main.tf'].includes('aws_sqs_queue'));assert.ok(!sqs().files['main.tf'].includes('aws_sns_topic'));assert.ok(sns().files['main.tf'].includes('aws_sns_topic'));
});
test('SQS FIFO, encryption and matching DLQ settings reach the generated files',()=>{
 const result=sqs({queue_type:'fifo',dlq:'new',encryption:'kms',kms_key:'alias/queue-key'});assert.equal(result.findings.filter(f=>f.severity==='error').length,0);const code=result.files['main.tf'];for(const expected of ['app-work.fifo','app-work-dlq.fifo','content_based_deduplication = true','maxReceiveCount = 5','byQueue','kms_master_key_id = "alias/queue-key"'])assert.ok(code.includes(expected),expected);
 assert.ok(sqs({poll_seconds:30}).findings.some(f=>f.severity==='error'));assert.ok(sqs({encryption:'kms',kms_key:''}).findings.some(f=>f.severity==='error'));assert.ok(sqs({queue_type:'fifo',name:'a'.repeat(76)}).findings.some(f=>f.severity==='error'));
});
test('SNS validates endpoint type and FIFO restrictions before export',()=>{
 assert.ok(sns({topic_type:'fifo',subscription_protocol:'email',endpoint:'owner@example.org'}).findings.some(f=>f.code==='aws.sns.fifo-endpoint'));
 assert.ok(sns({subscription_protocol:'https',endpoint:'http://example.org'}).findings.some(f=>f.code==='aws.sns.https'));
 assert.ok(sns({subscription_protocol:'sqs',endpoint:'https://sqs.us-east-1.amazonaws.com/123456789012/app'}).findings.some(f=>f.code==='aws.sns.arn'));
 const result=sns({topic_type:'fifo',subscription_protocol:'sqs',endpoint:'arn:aws:sqs:us-east-1:123456789012:app-work.fifo'});assert.equal(result.findings.filter(f=>f.severity==='error').length,0);assert.ok(result.files['main.tf'].includes('aws_sns_topic_subscription'));assert.ok(result.files['main.tf'].includes('app-notifications.fifo'));
});
