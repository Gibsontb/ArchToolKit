                                                     
import { bool } from '../kit/blueprint.js';
import { error,             } from '../core/findings.js';
import { blk,dat,e,jsonencode,output,res,x } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule,awsServicePartition,awsServiceRegion } from './aws-service-module.js';
const regions=['us-east-1','us-east-2','us-west-1','us-west-2','us-gov-east-1','us-gov-west-1'];
const modes=['RATE','DAILY','WEEKLY','MONTHLY','ONCE'];
export const AWS_SCHEDULER_SERVICE={
  id:'aws_service_scheduler_lambda',label:'Schedule a published Lambda version',
  description:'Create a separate schedule group, scoped execution role, encrypted delivery DLQ and customer-key payload encryption. Disabled by default; no target invocation during checks.',
  emits:['aws_scheduler_schedule_group','aws_scheduler_schedule','aws_iam_role','aws_iam_role_policy','aws_sqs_queue'],
  inputs:[
    awsServiceRegion,{id:'name',label:'Schedule name',control:'text'},
    {id:'target',label:'Existing published Lambda version ARN',control:'text',hint:'Same account/region, numeric version only. No mutable alias or $LATEST.'},
    {id:'kms',label:'Existing payload customer KMS key ARN',control:'text',hint:'Enabled symmetric key in this account/region. Other schedule metadata and the new SSE-SQS delivery queue use service encryption, not this key.'},
    {id:'mode',label:'Schedule type',control:'select',default:'RATE',options:modes.map(value=>({value,label:({RATE:'Fixed interval',DAILY:'Daily',WEEKLY:'Weekly',MONTHLY:'Monthly',ONCE:'One time'}                         )[value] }))},
    {id:'interval',label:'Repeat every',control:'number',default:1,min:1,showWhen:{input:'mode',equals:['RATE']}},
    {id:'unit',label:'Interval unit',control:'select',default:'hours',options:['minutes','hours','days'].map(value=>({value,label:value})),showWhen:{input:'mode',equals:['RATE']}},
    {id:'hour',label:'Hour (0–23)',control:'number',default:2,min:0,max:23,showWhen:{input:'mode',equals:['DAILY','WEEKLY','MONTHLY']}},
    {id:'minute',label:'Minute (0–59)',control:'number',default:0,min:0,max:59,showWhen:{input:'mode',equals:['DAILY','WEEKLY','MONTHLY']}},
    {id:'weekday',label:'Day of week',control:'select',default:'MON',options:['MON','TUE','WED','THU','FRI','SAT','SUN'].map(value=>({value,label:value})),showWhen:{input:'mode',equals:['WEEKLY']}},
    {id:'day',label:'Day of month',control:'number',default:1,min:1,max:31,showWhen:{input:'mode',equals:['MONTHLY']},hint:'A missing calendar date is skipped; day31 does not mean the last day.'},
    {id:'timestamp',label:'One-time local date and time',control:'text',hint:'YYYY-MM-DDTHH:MM:SS in the selected time zone. Verify it is in the future before enabling.',showWhen:{input:'mode',equals:['ONCE']}},
    {id:'timezone',label:'Time zone',control:'combo',default:'UTC',options:['UTC','America/New_York','America/Chicago','America/Denver','America/Los_Angeles','Europe/London','Europe/Paris','Asia/Tokyo','Australia/Sydney'].map(value=>({value,label:value})),hint:'IANA time zone. Calendar schedules follow daylight saving rules; rate days are24hours.'},
    {id:'payload',label:'Target input (JSON)',control:'textarea',default:'{}',hint:'No credentials. This workflow limits input to8KiB; config/export/state contain the input. Authorize its classification and failed-delivery retention.'},
    {id:'attempts',label:'Maximum delivery retries',control:'number',default:3,min:0,max:185},
    {id:'age',label:'Maximum event age (seconds)',control:'number',default:3600,min:60,max:86400},
    {id:'enabled',label:'Enable after target and schedule review',control:'toggle',default:false,hint:'Enabling can invoke the function and incur downstream costs. Terraform apply does not wait for application acceptance.'},
  ],
  build(values)                                    {
    const findings          =[],reject=(path       ,message       )=>findings.push(error('aws.scheduler.'+path,message,{path}));
    const region=String(values.aws_region??''),partition=awsServicePartition(region),name=String(values.name??'').trim(),target=String(values.target??'').trim(),kms=String(values.kms??'').trim(),mode=String(values.mode??''),timezone=String(values.timezone??''),unit=String(values.unit??''),weekday=String(values.weekday??''),timestamp=String(values.timestamp??'');
    const match=/^arn:([^:]+):lambda:([^:]+):(\d{12}):function:([A-Za-z0-9_-]{1,64}):([1-9]\d*)$/.exec(target),account=match?.[3]??'',functionName=match?.[4]??'',version=match?.[5]??'';
    if(!match||match[1]!==partition||match[2]!==region)reject('target','Use a numeric published Lambda version ARN in this partition/region.');
    if(!regions.includes(region))reject('aws_region','This bounded FIPS-API recipe supports the four US commercial and two GovCloud regions only.');
    if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/.test(name))reject('name','Use1–48 letters, digits, dots, hyphens or underscores.');
    if(!kms.startsWith('arn:'+partition+':kms:'+region+':'+account+':key/')||!/^arn:[^:]+:kms:[^:]+:\d{12}:key\/[0-9a-f-]+$/.test(kms))reject('kms','Use the same-account regional customer key ARN.');
    if(!modes.includes(mode))reject('mode','Select a schedule type.');
    try{if(timezone.length>50||!timezone||/^[+-]/.test(timezone))throw new Error();new Intl.DateTimeFormat('en',{timeZone:timezone}).format();}catch{reject('timezone','Use a valid IANA time zone.');}
    const numeric=(key       ,min       ,max       )=>{const value=Number(values[key]);if(values[key]===''||!Number.isSafeInteger(value)||value<min||value>max)reject(key,'Use an integer from'+min+' to'+max+'.');return value;};
    let expression='';
    if(mode==='RATE'){const interval=numeric('interval',1,1000000);if(!['minutes','hours','days'].includes(unit))reject('unit','Select minutes, hours or days.');expression='rate('+interval+' '+(interval===1?unit.slice(0,-1):unit)+')';}
    if(['DAILY','WEEKLY','MONTHLY'].includes(mode)){
      const hour=numeric('hour',0,23),minute=numeric('minute',0,59);
      if(mode==='DAILY')expression=`cron(${minute} ${hour} * * ? *)`;
      if(mode==='WEEKLY'){if(!['MON','TUE','WED','THU','FRI','SAT','SUN'].includes(weekday))reject('weekday','Choose a weekday.');expression=`cron(${minute} ${hour} ? * ${weekday} *)`;}
      if(mode==='MONTHLY')expression=`cron(${minute} ${hour} ${numeric('day',1,31)} * ? *)`;
    }
    if(mode==='ONCE'){const parsed=new Date(timestamp+'Z');if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(timestamp)||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,19)!==timestamp)reject('timestamp','Use a real local YYYY-MM-DDTHH:MM:SS calendar date/time.');expression='at('+timestamp+')';}
    const attempts=numeric('attempts',0,185),age=numeric('age',60,86400),enabled=bool(values,'enabled');
    let payload        ={};try{payload=JSON.parse(String(values.payload??''));if(!payload||Array.isArray(payload)||typeof payload!=='object')throw new Error();}catch{reject('payload','Use a JSON object.');}
    const input=JSON.stringify(payload);if(new TextEncoder().encode(input).length>8192)reject('payload','This workflow bounds input to8KiB.');
    const group=name+'-group',role=name+'-scheduler',queue=name+'-delivery-dlq',prefix='arn:'+partition+':scheduler:'+region+':'+account+':',scheduleArn=prefix+'schedule/'+group+'/'+name,groupArn=prefix+'schedule-group/'+group,roleArn='arn:'+partition+':iam::'+account+':role/'+role,queueArn='arn:'+partition+':sqs:'+region+':'+account+':'+queue;
    const result=awsServiceModule(region,[
      dat('aws_caller_identity','current',{}),dat('aws_kms_key','payload',{key_id:kms}),
      res('aws_scheduler_schedule_group','configured',{name:group},[blk('lifecycle',{prevent_destroy:true})]),
      res('aws_sqs_queue','delivery',{name:queue,sqs_managed_sse_enabled:true,message_retention_seconds:1209600},[blk('lifecycle',{prevent_destroy:true})]),
      res('aws_iam_role','execution',{name:role,assume_role_policy:x(jsonencode({Version:'2012-10-17',Statement:[{Effect:'Allow',Principal:{Service:'scheduler.amazonaws.com'},Action:'sts:AssumeRole',Condition:{StringEquals:{'aws:SourceAccount':account,'aws:SourceArn':groupArn}}}]}))}),
      res('aws_iam_role_policy','execution',{name:name+'-delivery',role:x('aws_iam_role.execution.id'),policy:x(jsonencode({Version:'2012-10-17',Statement:[{Effect:'Allow',Action:'lambda:InvokeFunction',Resource:target},{Effect:'Allow',Action:'sqs:SendMessage',Resource:e('aws_sqs_queue.delivery.arn')},{Effect:'Allow',Action:'kms:Decrypt',Resource:kms,Condition:{StringEquals:{'kms:EncryptionContext:aws:scheduler:schedule:arn':scheduleArn}}}]}))}),
      res('aws_scheduler_schedule','configured',{name,group_name:x('aws_scheduler_schedule_group.configured.name'),schedule_expression:expression,schedule_expression_timezone:timezone,state:enabled?'ENABLED':'DISABLED',kms_key_arn:kms,depends_on:x('[aws_iam_role_policy.execution]')},[
        blk('flexible_time_window',{mode:'OFF'}),blk('target',{arn:target,role_arn:x('aws_iam_role.execution.arn'),input},[blk('retry_policy',{maximum_retry_attempts:attempts,maximum_event_age_in_seconds:age}),blk('dead_letter_config',{arn:x('aws_sqs_queue.delivery.arn')})]),
        blk('lifecycle',{prevent_destroy:true},[blk('precondition',{condition:x('data.aws_caller_identity.current.account_id == '+JSON.stringify(account)+' && data.aws_kms_key.payload.arn == '+JSON.stringify(kms)+' && data.aws_kms_key.payload.enabled && data.aws_kms_key.payload.key_spec == "SYMMETRIC_DEFAULT" && data.aws_kms_key.payload.key_usage == "ENCRYPT_DECRYPT" && data.aws_kms_key.payload.key_manager == "CUSTOMER"'),error_message:'Require this account and selected enabled symmetric customer key.'})]),
      ]),output('schedule_arn','aws_scheduler_schedule.configured.arn'),output('execution_role_arn','aws_iam_role.execution.arn'),output('delivery_queue_url','aws_sqs_queue.delivery.id'),
    ],GUIDE,findings);
    const config={region,account,partition,name,target,functionName,version,kms,group,groupArn,scheduleArn,roleArn,queue,queueArn,expression,timezone,input,attempts,age,enabled};
    return {...result,files:{...result.files,'SCHEDULE-CONFIG.json':JSON.stringify(config,null,2)+'\n','INSPECT.py':INSPECT}};
  },
}                    ;

const INSPECT=[
  'import argparse, json, pathlib',
  'import boto3',
  'from botocore.config import Config',
  'parser=argparse.ArgumentParser(description="Read metadata only; never invoke Lambda or receive/delete delivery messages")',
  'parser.add_argument("--check",action="store_true"); args=parser.parse_args()',
  'config=json.loads((pathlib.Path(__file__).resolve().parent/"SCHEDULE-CONFIG.json").read_text())',
  'session=boto3.Session(region_name=config["region"]); options=Config(retries={"total_max_attempts":1,"mode":"standard"},use_fips_endpoint=True)',
  'if session.client("sts",config=options).get_caller_identity()["Account"]!=config["account"]: raise RuntimeError("Unexpected account")',
  'key=session.client("kms",config=options).describe_key(KeyId=config["kms"])["KeyMetadata"]',
  'if key.get("Arn")!=config["kms"] or key.get("KeyState")!="Enabled" or key.get("KeySpec")!="SYMMETRIC_DEFAULT" or key.get("KeyUsage")!="ENCRYPT_DECRYPT" or key.get("KeyManager")!="CUSTOMER": raise RuntimeError("Payload customer key differs")',
  'target=session.client("lambda",config=options).get_function_configuration(FunctionName=config["functionName"],Qualifier=config["version"])',
  'if target.get("FunctionArn")!=config["target"] or target.get("Version")!=config["version"] or target.get("State")!="Active" or target.get("LastUpdateStatus")!="Successful": raise RuntimeError("Published target identity/readiness differs")',
  'if args.check:',
  '    scheduler=session.client("scheduler",config=options)',
  '    group=scheduler.get_schedule_group(Name=config["group"])',
  '    if group.get("Arn")!=config["groupArn"] or group.get("State")!="ACTIVE": raise RuntimeError("Schedule group differs")',
  '    schedule=scheduler.get_schedule(Name=config["name"],GroupName=config["group"]); target=schedule.get("Target",{})',
  '    if schedule.get("Arn")!=config["scheduleArn"] or schedule.get("State")!=("ENABLED" if config["enabled"] else "DISABLED") or schedule.get("KmsKeyArn")!=config["kms"] or schedule.get("ScheduleExpression")!=config["expression"] or schedule.get("ScheduleExpressionTimezone")!=config["timezone"] or schedule.get("FlexibleTimeWindow",{}).get("Mode")!="OFF" or schedule.get("StartDate") or schedule.get("EndDate") or schedule.get("ActionAfterCompletion","NONE")!="NONE": raise RuntimeError("Schedule configuration differs")',
  '    if target.get("Arn")!=config["target"] or target.get("RoleArn")!=config["roleArn"] or json.loads(target.get("Input","null"))!=json.loads(config["input"]) or target.get("DeadLetterConfig",{}).get("Arn")!=config["queueArn"] or target.get("RetryPolicy")!={"MaximumRetryAttempts":config["attempts"],"MaximumEventAgeInSeconds":config["age"]}: raise RuntimeError("Target/input/retry/DLQ configuration differs")',
  '    sqs=session.client("sqs",config=options); url=sqs.get_queue_url(QueueName=config["queue"],QueueOwnerAWSAccountId=config["account"])["QueueUrl"]',
  '    attrs=sqs.get_queue_attributes(QueueUrl=url,AttributeNames=["QueueArn","SqsManagedSseEnabled","FifoQueue","MessageRetentionPeriod"]).get("Attributes",{})',
  '    if attrs.get("QueueArn")!=config["queueArn"] or attrs.get("SqsManagedSseEnabled")!="true" or attrs.get("FifoQueue","false")!="false" or attrs.get("MessageRetentionPeriod")!="1209600": raise RuntimeError("Delivery queue encryption/type/retention differs")',
  'print(json.dumps({"metadata_checked":True,"schedule_checked":args.check,"scheduleArn":config["scheduleArn"],"target_invoked":False,"messages_read":False,"effective_iam_or_application_acceptance_verified":False}))',
].join('\n')+'\n';

const GUIDE=`# EventBridge Scheduler to a published Lambda version

This separate Scheduler workflow does not replace EventBridge bus/rule routing. It creates one new schedule group, new execution role,14-day standard SSE-SQS delivery DLQ and one schedule. Default DISABLED. No Lambda resource-based policy, function configuration, existing role/key policy or queue policy is replaced. Numeric published version only, same account/region; no alias/$LATEST, universal targets, cross-account calls or other target types. Bounded to four US commercial/two GovCloud regions with FIPS SDK metadata endpoints; availability of a region/FIPS endpoint does not prove authorization or validated cryptography.

Prepare the existing published target, runtime permissions/dependencies, quotas/concurrency and idempotent event handling. Numeric versions pin code/configuration, not external dependencies. Confirm Lambda async execution retries/destinations independently: Scheduler retry/DLQ covers delivery failures, not all failures after Lambda accepts an asynchronous invocation. Duplicates may occur. Execution trust is constrained to the schedule GROUP ARN (not schedule ARN), as AWS requires; protect group membership and role-passing permissions. Execution IAM allows only the selected qualified target, new queue SendMessage and selected key Decrypt under the exact schedule encryption context. Existing key policy must permit that role, and deployment identity needs scoped Scheduler create/update, IAM PassRole and key DescribeKey/GenerateDataKey/Decrypt permissions. No grants or shared key policy changes are made. Effective policies/SCPs/permission boundaries require owner review.

Review data classification, permitted civilian/DoD/State destination and payload/log/DLQ/backup/retention boundaries, applicable SSP/ATO/APL/CDM/DoDIN/STIG/SRG/CMVP/residency/privacy evidence. No compliance approval is implied. Payload input is present in exported config and Terraform state: never use credentials or unauthorized data. The selected customer key protects target INPUT only; name/state/timing/target/retry metadata uses AWS-owned encryption. New DLQ uses SSE-SQS, not the selected CMK. GetFunctionConfiguration can return environment settings to the SDK in memory; helper never prints/saves those values. GetSchedule returns input; helper compares without printing it. Protect the package/state and AWS metadata permissions; actual retention and control requirements remain owner prerequisites.

Choose fixed interval, daily/weekly/monthly or one-time local timestamp and IANA time zone. Schedule precision is60seconds, not an exact-second SLA. Calendar times skipped by a spring DST jump do not run; repeated fall times run once. A rate day is24hours, not next wall-clock day; monthly day31 skips months without that date. Check ambiguous/nonexistent local times independently. One-time schedules must be future when enabled, remain after completion and consume quota until explicit owner cleanup. Provider5 lacks action_after_completion; no fabricated attribute/auto-delete. Flexible window is OFF. Rate schedules can start promptly after enable; disabled past one-time events do not become catch-up jobs.

Run python INSPECT.py before deployment to check account/key and exact published target metadata. It makes no invoke/message calls and does not prove effective IAM, handler input contract, schedule timing or regional capacity. Run terraform init/validate/plan and review all resources/trust/policies/input/timing/cost. Apply the saved plan with default disabled schedule. Then python INSPECT.py --check compares actual schedule/group/target input/retries/DLQ metadata. Independently verify role policies/trust/key policy, alarms, Lambda async failure handling and DLQ monitoring/retention. Use an approved isolated duplicate-safe event test before production acceptance; no automatic test invocation is included. After owner sign-off explicitly enable in the form and review/apply a fresh plan. Enabling invokes real application behavior and may incur charges. Monitor Scheduler metrics, Lambda async errors/destinations and both failure paths.

Recovery: disable future delivery with a reviewed plan first; disabling does not cancel already accepted Lambda executions or pending application work. Retain failed messages; manually inspect/replay only through approved data handling/idempotency procedures. No message reads, redrive, deletion or automatic cleanup is generated. Schedule/group/DLQ have prevent_destroy; deliberate cleanup needs owner evidence/retention/quota decisions. Terraform state is not application data recovery.

https://docs.aws.amazon.com/scheduler/latest/UserGuide/cross-service-confused-deputy-prevention.html
https://docs.aws.amazon.com/scheduler/latest/UserGuide/encryption-rest.html
https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html
https://docs.aws.amazon.com/scheduler/latest/UserGuide/configuring-schedule-dlq.html
https://docs.aws.amazon.com/general/latest/gr/eventbridgescheduler.html
`;
