                                                                                  
import {error,            } from '../core/findings.js';
import {asRootModule} from '../terraform/layout.js';
import {placementRegionOptions} from '../kit/placement-regions.js';
const quote=(value        )=>JSON.stringify(String(value??'')).replace(/\$\{/g,'$${').replace(/%\{/g,'%%{');
const region               ={id:'aws_region',label:'AWS region',control:'select',options:placementRegionOptions('aws'),blankLabel:'Select a region'};
const booleanOptions=[{value:'true',label:'Enabled'},{value:'false',label:'Disabled'}];
const header=(values                )=>'terraform {\n  required_providers {\n    aws = { source = "hashicorp/aws", version = "~> 5.0" }\n  }\n}\nprovider "aws" {\n  region = '+quote(values.aws_region)+'\n}\n';
function checkRegion(values                ,findings          )     {if(!placementRegionOptions('aws').some(region=>region.value===values.aws_region))findings.push(error('aws.messaging.region','Select an AWS region.',{path:'aws_region'}));}
function name(value        ,fifo        )       {const text=String(value??'');return fifo&&!text.endsWith('.fifo')?text+'.fifo':text;}
function checkName(value       ,fifo        ,max       ,findings          )     {const base=fifo?value.replace(/\.fifo$/,''):value;if(!base||value.length>max||!/^[a-zA-Z0-9_-]+$/.test(base))findings.push(error('aws.messaging.name','Use letters, digits, underscores or hyphens; the selected FIFO type appends .fifo.',{path:'name'}));}
export const AWS_SQS_SERVICE          ={
 id:'aws_service_sqs',label:'Set up an SQS queue',description:'Configure a standard or FIFO queue, message handling, encryption and an optional new dead-letter queue.',emits:['aws_sqs_queue','aws_sqs_queue_redrive_allow_policy'],
 inputs:[region,
  {id:'name',label:'Queue name',control:'text'},
  {id:'queue_type',label:'Queue type',control:'select',default:'standard',options:[{value:'standard',label:'Standard — at-least-once, best-effort ordering'},{value:'fifo',label:'FIFO — ordered message groups'}]},
  {id:'content_deduplication',label:'Content-based deduplication',control:'select',default:'true',options:booleanOptions,showWhen:{input:'queue_type',equals:['fifo']}},
  {id:'visibility_seconds',label:'Visibility timeout (seconds)',control:'number',default:30,min:0,max:43200},
  {id:'retention_seconds',label:'Message retention (seconds)',control:'number',default:345600,min:60,max:1209600,hint:'Default 4 days; maximum 14 days.'},
  {id:'delay_seconds',label:'Delivery delay (seconds)',control:'number',default:0,min:0,max:900},
  {id:'poll_seconds',label:'Receive long-poll wait (seconds)',control:'number',default:20,min:0,max:20},
  {id:'max_message_bytes',label:'Maximum message size (bytes)',control:'number',default:262144,min:1024,max:262144,hint:'This form targets the supported AWS provider 5.x limit.'},
  {id:'encryption',label:'Encryption',control:'select',default:'sqs',options:[{value:'sqs',label:'SSE-SQS — SQS-managed keys'},{value:'kms',label:'SSE-KMS — existing KMS key'}]},
  {id:'kms_key',label:'Existing KMS key ARN, ID or alias',control:'text',showWhen:{input:'encryption',equals:['kms']},hint:'For the AWS-managed SQS key, enter alias/aws/sqs.'},
  {id:'dlq',label:'Dead-letter queue',control:'select',default:'none',options:[{value:'none',label:'No dead-letter queue'},{value:'new',label:'Create a matching dead-letter queue'}]},
  {id:'max_receive_count',label:'Delivery attempts before dead-lettering',control:'number',default:5,min:1,max:1000,showWhen:{input:'dlq',equals:['new']}},
 ]                                    ,
 build(values){const findings          =[];checkRegion(values,findings);const fifo=values.queue_type==='fifo';const queueName=name(values.name,fifo);checkName(queueName,fifo,80,findings);
  if(!['fifo','standard'].includes(String(values.queue_type)))findings.push(error('aws.sqs.type','Select a queue type.',{path:'queue_type'}));
  const integer=(key       ,min       ,max       )=>{const n=Number(values[key]);if(!Number.isInteger(n)||n<min||n>max)findings.push(error('aws.sqs.'+key,'Enter a whole number from '+min+' through '+max+'.',{path:key}));return n;};
  const visibility=integer('visibility_seconds',0,43200),retention=integer('retention_seconds',60,1209600),delay=integer('delay_seconds',0,900),poll=integer('poll_seconds',0,20),size=integer('max_message_bytes',1024,262144);
  const dlq=values.dlq==='new';const attempts=dlq?integer('max_receive_count',1,1000):0;
  const dlqName=name(String(values.name??'').replace(/\.fifo$/,'')+'-dlq',fifo);if(dlq)checkName(dlqName,fifo,80,findings);
  if(!['sqs','kms'].includes(String(values.encryption)))findings.push(error('aws.sqs.encryption','Select an encryption method.',{path:'encryption'}));
  if(values.encryption==='kms'&&!String(values.kms_key??'').trim())findings.push(error('aws.sqs.kms','Enter the existing KMS key reference.',{path:'kms_key'}));
  const encryption=values.encryption==='kms'?'kms_master_key_id = '+quote(values.kms_key):'sqs_managed_sse_enabled = true';
  const parts=[header(values)];
  if(dlq)parts.push('resource "aws_sqs_queue" "dead_letter" {\n  name = '+quote(dlqName)+'\n  fifo_queue = '+fifo+'\n  message_retention_seconds = 1209600\n  '+encryption+'\n}');
  parts.push('resource "aws_sqs_queue" "messages" {\n  name = '+quote(queueName)+'\n  fifo_queue = '+fifo+'\n'+(fifo?'  content_based_deduplication = '+(values.content_deduplication==='true')+'\n':'')+'  visibility_timeout_seconds = '+visibility+'\n  message_retention_seconds = '+retention+'\n  delay_seconds = '+delay+'\n  receive_wait_time_seconds = '+poll+'\n  max_message_size = '+size+'\n  '+encryption+'\n'+(dlq?'  redrive_policy = jsonencode({ deadLetterTargetArn = aws_sqs_queue.dead_letter.arn, maxReceiveCount = '+attempts+' })\n':'')+'}');
  if(dlq)parts.push('resource "aws_sqs_queue_redrive_allow_policy" "dead_letter" {\n  queue_url = aws_sqs_queue.dead_letter.id\n  redrive_allow_policy = jsonencode({ redrivePermission = "byQueue", sourceQueueArns = [aws_sqs_queue.messages.arn] })\n}');
  parts.push('output "queue_url" { value = aws_sqs_queue.messages.url }\noutput "queue_arn" { value = aws_sqs_queue.messages.arn }');
  return asRootModule({files:{'main.tf':parts.join('\n\n')+'\n','SERVICE-SETUP.md':'# SQS queue setup\n\nVerify service availability, IAM permissions and optional KMS key access. Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review, then terraform apply service.tfplan. Grant producer/consumer IAM permissions separately. Cross-account or SNS publishers also require an appropriate queue policy.\n\nUse the queue URL output to send a test message, receive it, process it, and delete it with its receipt handle. Confirm visibility timeout exceeds processing time. FIFO senders must supply a message group ID and a deduplication ID unless content-based deduplication is enabled. Test repeated failures reaching the dead-letter queue. Inspect queue attributes and encryption through the SQS API.\n\nRetention expiration and queue deletion permanently remove messages. A dead-letter queue is not a backup; configure monitoring and an approved redrive procedure. This form creates a new matching DLQ when selected; existing DLQs, resource policies and application triggers use additional builders.\n\nReference: https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/welcome.html\n'},findings});
 },
};
export const AWS_SNS_SERVICE          ={
 id:'aws_service_sns',label:'Set up an SNS topic',description:'Configure a standard or FIFO notification topic, encryption and an optional subscription to an existing endpoint.',emits:['aws_sns_topic','aws_sns_topic_subscription'],
 inputs:[region,
  {id:'name',label:'Topic name',control:'text'},
  {id:'topic_type',label:'Topic type',control:'select',default:'standard',options:[{value:'standard',label:'Standard topic'},{value:'fifo',label:'FIFO topic'}]},
  {id:'content_deduplication',label:'Content-based deduplication',control:'select',default:'true',options:booleanOptions,showWhen:{input:'topic_type',equals:['fifo']}},
  {id:'display_name',label:'Display name',control:'text',hint:'Optional, up to 100 characters.'},
  {id:'kms_key',label:'Encryption KMS key ARN, ID or alias',control:'text',hint:'Optional existing key; blank leaves topic server-side encryption unset.'},
  {id:'subscription_protocol',label:'Subscription',control:'select',default:'none',options:[{value:'none',label:'No subscription yet'},{value:'email',label:'Email — recipient confirmation required'},{value:'https',label:'HTTPS endpoint — confirmation required'},{value:'sqs',label:'Existing SQS queue ARN'},{value:'lambda',label:'Existing Lambda function ARN'}]},
  {id:'endpoint',label:'Subscription endpoint',control:'text',showWhen:{input:'subscription_protocol',notEquals:['none']},hint:'The email address, HTTPS URL or ARN for the selected protocol.'},
  {id:'raw_delivery',label:'Raw message delivery',control:'select',default:'false',options:booleanOptions,showWhen:{input:'subscription_protocol',equals:['sqs','https']}},
 ]                                    ,
 build(values){const findings          =[];checkRegion(values,findings);const fifo=values.topic_type==='fifo';const topicName=name(values.name,fifo);checkName(topicName,fifo,256,findings);const protocol=String(values.subscription_protocol??'none'),endpoint=String(values.endpoint??'');
  if(!['fifo','standard'].includes(String(values.topic_type)))findings.push(error('aws.sns.type','Select a topic type.',{path:'topic_type'}));
  if(!['none','email','https','sqs','lambda'].includes(protocol))findings.push(error('aws.sns.subscription','Select a subscription protocol.',{path:'subscription_protocol'}));
  if(fifo&&!['none','sqs'].includes(protocol))findings.push(error('aws.sns.fifo-endpoint','FIFO topics require an SQS subscription in this form.',{path:'subscription_protocol'}));
  if(protocol==='email'&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(endpoint))findings.push(error('aws.sns.email','Enter the recipient email address.',{path:'endpoint'}));
  if(protocol==='https'){try{const url=new URL(endpoint);if(url.protocol!=='https:'||url.username||url.password)throw Error();}catch{findings.push(error('aws.sns.https','Enter an HTTPS endpoint without embedded credentials.',{path:'endpoint'}));}}
  if(['sqs','lambda'].includes(protocol)&&!new RegExp('^arn:(?:aws|aws-us-gov|aws-cn):'+protocol+':[a-z0-9-]+:[0-9]{12}:.+$').test(endpoint))findings.push(error('aws.sns.arn','Enter an existing '+protocol+' endpoint ARN.',{path:'endpoint'}));
  if(String(values.display_name??'').length>100)findings.push(error('aws.sns.display','Display name must be at most 100 characters.',{path:'display_name'}));
  const parts=[header(values),'resource "aws_sns_topic" "notifications" {\n  name = '+quote(topicName)+'\n  fifo_topic = '+fifo+'\n'+(fifo?'  content_based_deduplication = '+(values.content_deduplication==='true')+'\n':'')+(values.display_name?'  display_name = '+quote(values.display_name)+'\n':'')+(values.kms_key?'  kms_master_key_id = '+quote(values.kms_key)+'\n':'')+'}'];
  if(protocol!=='none')parts.push('resource "aws_sns_topic_subscription" "recipient" {\n  topic_arn = aws_sns_topic.notifications.arn\n  protocol = '+quote(protocol)+'\n  endpoint = '+quote(endpoint)+'\n'+(['sqs','https'].includes(protocol)?'  raw_message_delivery = '+(values.raw_delivery==='true')+'\n':'')+'}');
  parts.push('output "topic_arn" { value = aws_sns_topic.notifications.arn }');
  return asRootModule({files:{'main.tf':parts.join('\n\n')+'\n','SERVICE-SETUP.md':'# SNS topic setup\n\nConfirm regional topic/protocol availability, quotas, publisher IAM permissions and optional KMS key policy. Run terraform init, terraform validate, terraform plan -out=service.tfplan; review and apply the saved plan. This package creates a topic and optionally one subscription to an existing endpoint. Additional subscriptions and resource policies use the existing builders.\n\nEmail and HTTPS recipients must confirm the subscription; successful topic creation does not establish delivery. For SQS, authorize the topic in the queue policy and KMS key policy where applicable. For Lambda, add invoke permission for SNS restricted to this topic ARN. These permissions are deliberately not inferred for an existing endpoint. Verify subscription status, publish a test message and confirm delivery and message format at the endpoint. FIFO publishers need message group IDs and deduplication IDs unless content-based deduplication is enabled.\n\nConfigure delivery monitoring, retry and dead-letter handling separately. SNS standard topics are not a message backup; deleting a topic removes subscriptions and cannot recall already delivered notifications. Confirm region and queue-type support for FIFO delivery, especially government regions.\n\nReference: https://docs.aws.amazon.com/sns/latest/dg/fifo-message-delivery.html\n'},findings});
 },
};
