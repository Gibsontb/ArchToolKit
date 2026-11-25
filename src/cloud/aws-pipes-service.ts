import type { Blueprint } from '../kit/blueprint.ts';
import { bool } from '../kit/blueprint.ts';
import { error,type Finding } from '../core/findings.ts';
import { blk,dat,jsonencode,output,res,x } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule,awsServiceRegion } from './aws-service-module.ts';

export const AWS_PIPES_SERVICE={
  id:'aws_service_pipes_sqs_lambda',label:'Process an SQS queue through Pipes and a published Lambda version',
  description:'Stage a stopped synchronous pipe with a new scoped role, existing encrypted source/redrive queues and customer-key pipe encryption. No filtering, enrichment or message operations during checks.',
  emits:['aws_iam_role','aws_iam_role_policy','aws_pipes_pipe'],
  inputs:[
    awsServiceRegion,{id:'name',label:'Pipe name',control:'text'},
    {id:'source',label:'Existing source SQS queue ARN',control:'text'},
    {id:'dlq',label:'Existing source redrive queue ARN',control:'text',hint:'The source queue must already redrive here. Same account/region and standard/FIFO type. This tool does not change its redrive policy.'},
    {id:'target',label:'Existing published Lambda version ARN',control:'text',hint:'Numeric version, same account/region; handler accepts a JSON array of source records. This differs from the Lambda SQS event-source envelope.'},
    {id:'encryption',label:'Existing queue encryption',control:'select',default:'SSE-SQS',options:[{value:'SSE-SQS',label:'SSE-SQS on source and redrive queues'},{value:'KMS',label:'Same customer KMS key on source and redrive queues'}]},
    {id:'queue_key',label:'Existing queue customer KMS key ARN',control:'text',showWhen:{input:'encryption',equals:['KMS']}},
    {id:'kms',label:'Existing pipe customer KMS key ARN',control:'text',hint:'Separate from queue and Lambda storage encryption. Existing key policy must authorize the new pipe role.'},
    {id:'batch',label:'Maximum messages per batch',control:'number',default:1,min:1,max:10},
    {id:'window',label:'Batch window (seconds)',control:'number',default:0,min:0,max:300,hint:'FIFO requires0. Visibility must cover at least six times target timeout plus this window.'},
    {id:'enabled',label:'Start processing after owner acceptance',control:'toggle',default:false,hint:'Starting consumes messages, invokes the application and deletes successfully processed messages. Stopped by default.'},
  ],
  build(values):ReturnType<typeof awsServiceModule>{
    const findings:Finding[]=[],reject=(path:string,message:string)=>findings.push(error('aws.pipes.'+path,message,{path}));
    const region=String(values.aws_region??''),name=String(values.name??'').trim(),source=String(values.source??'').trim(),dlq=String(values.dlq??'').trim(),target=String(values.target??'').trim(),kms=String(values.kms??'').trim(),encryption=String(values.encryption??''),queueKey=encryption==='KMS'?String(values.queue_key??'').trim():'';
    const queue=/^arn:aws:sqs:([^:]+):(\d{12}):([A-Za-z0-9_-]{1,80}(?:\.fifo)?)$/.exec(source),account=queue?.[2]??'',queueName=queue?.[3]??'',fifo=queueName.endsWith('.fifo');
    const dead=/^arn:aws:sqs:([^:]+):(\d{12}):([A-Za-z0-9_-]{1,80}(?:\.fifo)?)$/.exec(dlq);
    const fn=/^arn:aws:lambda:([^:]+):(\d{12}):function:([A-Za-z0-9_-]{1,64}):([1-9]\d*)$/.exec(target);
    if(!['us-east-1','us-east-2','us-west-1','us-west-2'].includes(region))reject('aws_region','This workflow is bounded to the four published US commercial Pipes FIPS regions. Pipes is not available in GovCloud in the current regional feature table.');
    if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/.test(name))reject('name','Use1–48 letters, digits, dots, underscores or hyphens.');
    if(!queue||queue[1]!==region||queueName.length>80)reject('source','Use an existing SQS ARN in the selected commercial region.');
    if(!dead||dead[1]!==region||dead[2]!==account||dead[3]!.length>80||dead[3]!.endsWith('.fifo')!==fifo||source===dlq)reject('dlq','Use a distinct same-account/region redrive queue with matching standard/FIFO type.');
    if(!fn||fn[1]!==region||fn[2]!==account)reject('target','Use a same-account/region numeric published Lambda version ARN.');
    const validKey=(value:string)=>value.startsWith('arn:aws:kms:'+region+':'+account+':key/')&&/^arn:aws:kms:[^:]+:\d{12}:key\/[0-9a-f-]+$/.test(value);
    if(!validKey(kms))reject('kms','Use an existing regional customer key ARN in the source account.');
    if(!['SSE-SQS','KMS'].includes(encryption))reject('encryption','Choose a queue encryption mode.');
    if(encryption==='KMS'&&!validKey(queueKey))reject('queue_key','Use the existing key ARN shared by source/redrive queues in this bounded workflow.');
    const batch=Number(values.batch),window=Number(values.window),enabled=bool(values,'enabled');
    if(values.batch===''||!Number.isInteger(batch)||batch<1||batch>10)reject('batch','Use1–10 messages for this bounded workflow.');
    if(values.window===''||!Number.isInteger(window)||window<0||window>300||fifo&&window!==0)reject('window',fifo?'FIFO requires a zero batch window.':'Use0–300 seconds.');
    const pipeArn='arn:aws:pipes:'+region+':'+account+':pipe/'+name,roleArn='arn:aws:iam::'+account+':role/'+name+'-pipe';
    // The primary AWS page documents both context spellings. At least one must
    // exist, and every documented context key present must match this exact ARN.
    const context={StringEqualsIfExists:{'kms:EncryptionContext:aws:pipe:arn':pipeArn,'kms:EncryptionContext:aws:pipes:arn':pipeArn},'ForAnyValue:StringEquals':{'kms:EncryptionContextKeys':['aws:pipe:arn','aws:pipes:arn']}};
    const policy={Version:'2012-10-17',Statement:[
      {Effect:'Allow',Action:['sqs:ReceiveMessage','sqs:DeleteMessage','sqs:GetQueueAttributes'],Resource:source},
      {Effect:'Allow',Action:'lambda:InvokeFunction',Resource:target},
      {Effect:'Allow',Action:'kms:DescribeKey',Resource:kms},
      {Effect:'Allow',Action:['kms:GenerateDataKey','kms:Decrypt'],Resource:kms,Condition:context},
      ...(queueKey?[{Effect:'Allow',Action:'kms:Decrypt',Resource:queueKey}]:[]),
    ]};
    const result=awsServiceModule(region,[dat('aws_caller_identity','current',{}),dat('aws_kms_key','pipe',{key_id:kms}),
      ...(queueKey?[dat('aws_kms_key','queue',{key_id:queueKey})]:[]),
      res('aws_iam_role','execution',{name:name+'-pipe',assume_role_policy:x(jsonencode({Version:'2012-10-17',Statement:[{Effect:'Allow',Principal:{Service:'pipes.amazonaws.com'},Action:'sts:AssumeRole',Condition:{StringEquals:{'aws:SourceAccount':account,'aws:SourceArn':pipeArn}}}]}))}),
      res('aws_iam_role_policy','execution',{name:name+'-delivery',role:x('aws_iam_role.execution.id'),policy:x(jsonencode(policy))}),
      res('aws_pipes_pipe','configured',{name,role_arn:x('aws_iam_role.execution.arn'),source,target,kms_key_identifier:kms,desired_state:enabled?'RUNNING':'STOPPED',depends_on:x('[aws_iam_role_policy.execution]')},[
        blk('source_parameters',{},[blk('sqs_queue_parameters',{batch_size:batch,maximum_batching_window_in_seconds:window})]),
        blk('target_parameters',{},[blk('lambda_function_parameters',{invocation_type:'REQUEST_RESPONSE'})]),
        blk('log_configuration',{level:'OFF'}),
        blk('lifecycle',{prevent_destroy:true},[blk('precondition',{condition:x('data.aws_caller_identity.current.account_id == '+JSON.stringify(account)+['pipe',...(queueKey?['queue']:[])].map(key=>' && data.aws_kms_key.'+key+'.arn == '+JSON.stringify(key==='pipe'?kms:queueKey)+' && data.aws_kms_key.'+key+'.enabled && data.aws_kms_key.'+key+'.key_spec == "SYMMETRIC_DEFAULT" && data.aws_kms_key.'+key+'.key_usage == "ENCRYPT_DECRYPT" && data.aws_kms_key.'+key+'.key_manager == "CUSTOMER"').join('')),error_message:'Require this account and selected enabled symmetric customer keys.'})]),
      ]),output('pipe_arn','aws_pipes_pipe.configured.arn'),output('execution_role_arn','aws_iam_role.execution.arn'),
    ],GUIDE,findings);
    const config={region,account,name,source,queueName,dlq,dlqName:dead?.[3]??'',fifo,target,functionName:fn?.[3]??'',version:fn?.[4]??'',kms,encryption,queueKey,batch,window,enabled,pipeArn,roleArn};
    return {...result,files:{...result.files,'PIPE-CONFIG.json':JSON.stringify(config,null,2)+'\n','INSPECT.py':INSPECT}};
  },
} satisfies Blueprint;

const INSPECT=[
  'import argparse, json, pathlib',
  'import boto3',
  'from botocore.config import Config',
  'parser=argparse.ArgumentParser(description="Read selected Pipes/SQS/Lambda/key metadata only; never poll, invoke, delete or start")',
  'parser.add_argument("--check",action="store_true"); args=parser.parse_args()',
  'config=json.loads((pathlib.Path(__file__).resolve().parent/"PIPE-CONFIG.json").read_text())',
  'session=boto3.Session(region_name=config["region"]); options=Config(retries={"total_max_attempts":1,"mode":"standard"},use_fips_endpoint=True)',
  'if session.client("sts",config=options).get_caller_identity()["Account"]!=config["account"]: raise RuntimeError("Unexpected operator account")',
  'kms=session.client("kms",config=options)',
  'for arn in set([config["kms"]]+([config["queueKey"]] if config["queueKey"] else [])):',
  '    key=kms.describe_key(KeyId=arn)["KeyMetadata"]',
  '    if key.get("Arn")!=arn or key.get("KeyState")!="Enabled" or key.get("KeySpec")!="SYMMETRIC_DEFAULT" or key.get("KeyUsage")!="ENCRYPT_DECRYPT" or key.get("KeyManager")!="CUSTOMER": raise RuntimeError("Selected customer key differs")',
  'target=session.client("lambda",config=options).get_function_configuration(FunctionName=config["functionName"],Qualifier=config["version"])',
  'if target.get("FunctionArn")!=config["target"] or target.get("Version")!=config["version"] or target.get("State")!="Active" or target.get("LastUpdateStatus")!="Successful" or not 1<=target.get("Timeout",0)<=60: raise RuntimeError("Require exact active published target with timeout1–60seconds for this bounded workflow")',
  'sqs=session.client("sqs",config=options)',
  'def attributes(name,arn):',
  '    url=sqs.get_queue_url(QueueName=name,QueueOwnerAWSAccountId=config["account"])["QueueUrl"]',
  '    attrs=sqs.get_queue_attributes(QueueUrl=url,AttributeNames=["QueueArn","FifoQueue","VisibilityTimeout","MessageRetentionPeriod","RedrivePolicy","SqsManagedSseEnabled","KmsMasterKeyId"]).get("Attributes",{})',
  '    if attrs.get("QueueArn")!=arn or attrs.get("FifoQueue","false")!=("true" if config["fifo"] else "false"): raise RuntimeError("Queue identity/type differs")',
  '    if config["encryption"]=="SSE-SQS":',
  '        if attrs.get("SqsManagedSseEnabled")!="true" or attrs.get("KmsMasterKeyId"): raise RuntimeError("Require SSE-SQS on both selected queues")',
  '    else:',
  '        identifier=attrs.get("KmsMasterKeyId")',
  '        if not identifier or kms.describe_key(KeyId=identifier)["KeyMetadata"].get("Arn")!=config["queueKey"]: raise RuntimeError("Queue actual customer key differs")',
  '    return attrs',
  'source=attributes(config["queueName"],config["source"]); dead=attributes(config["dlqName"],config["dlq"])',
  'if int(source.get("VisibilityTimeout","0"))<6*target["Timeout"]+config["window"]: raise RuntimeError("Increase source visibility to at least six target timeouts plus batch window before proceeding")',
  'redrive=json.loads(source.get("RedrivePolicy","{}"))',
  'if redrive.get("deadLetterTargetArn")!=config["dlq"] or not 1<=int(redrive.get("maxReceiveCount",0))<=1000: raise RuntimeError("Require selected source redrive policy and receive bound")',
  'if not 60<=int(source.get("MessageRetentionPeriod",0))<=1209600 or not int(source["MessageRetentionPeriod"])<=int(dead.get("MessageRetentionPeriod",0))<=1209600: raise RuntimeError("Require reviewed source retention and redrive retention at least as long, up to14days")',
  'if args.check:',
  '    pipe=session.client("pipes",config=options).describe_pipe(Name=config["name"])',
  '    if pipe.get("Arn")!=config["pipeArn"] or pipe.get("Source")!=config["source"] or pipe.get("Target")!=config["target"] or pipe.get("RoleArn")!=config["roleArn"] or pipe.get("KmsKeyIdentifier")!=config["kms"] or pipe.get("DesiredState")!=("RUNNING" if config["enabled"] else "STOPPED") or pipe.get("CurrentState")!=("RUNNING" if config["enabled"] else "STOPPED"): raise RuntimeError("Pipe identity/state/key differs; wait for stable state or inspect owner changes")',
  '    source_params=pipe.get("SourceParameters",{}); target_params=pipe.get("TargetParameters",{}); batching=source_params.get("SqsQueueParameters",{})',
  '    filters=source_params.get("FilterCriteria",{})',
  '    if set(source_params)-{"SqsQueueParameters","FilterCriteria"} or set(target_params)-{"LambdaFunctionParameters","InputTemplate"} or set(filters)-{"Filters"} or filters.get("Filters") or target_params.get("InputTemplate") or pipe.get("Enrichment") or pipe.get("EnrichmentParameters") or batching.get("BatchSize")!=config["batch"] or batching.get("MaximumBatchingWindowInSeconds",0)!=config["window"] or target_params.get("LambdaFunctionParameters")!={"InvocationType":"REQUEST_RESPONSE"}: raise RuntimeError("No filter, transformer, enrichment, alternate source parameters or asynchronous target allowed")',
  '    logs=pipe.get("LogConfiguration",{})',
  '    if logs.get("Level","OFF")!="OFF" or logs.get("IncludeExecutionData") or any(logs.get(key) for key in ["CloudwatchLogsLogDestination","S3LogDestination","FirehoseLogDestination"]): raise RuntimeError("Logging differs; payload/error data handling requires separate review")',
  'print(json.dumps({"metadata_checked":True,"pipe_checked":args.check,"pipeArn":config["pipeArn"],"messages_read_or_deleted":False,"target_invoked":False,"effective_iam_and_application_acceptance_verified":False}))',
].join('\n')+'\n';

const GUIDE=`# Staged SQS-to-Lambda EventBridge Pipe

Creates only a new pipe execution role/policy and pipe; defaults STOPPED. Existing encrypted standard/FIFO source and matching redrive queues and a numeric published Lambda version must already exist in the same account/region. Source and redrive use SSE-SQS or the same explicitly selected customer key in this bounded path. Published target timeout is bounded to1–60seconds, batches1–10, FIFO batch window0. Four US commercial FIPS-API regions only; current AWS feature table says Pipes is unavailable in GovCloud. No classification/ATO/CMVP/STIG/APL/CDM/DoDIN/State approval follows from these controls. Preserve the separate existing Lambda event-source mapping workflow and EventBridge rules/Scheduler flows.

Before deployment authorize data movement and target side effects, civilian/DoD/State classification, transfer/processing/metadata/queue/DLQ/key/log/backup boundaries, residency/privacy/retention and applicable SSP/ATO/security evidence. Review queue/key policies, SCPs, role boundaries, PassRole/pipe provisioning permissions, service quotas, target runtime dependencies/concurrency and monitoring. No shared role, source/redrive configuration, queue policy, key policy or function is changed. The new role trusts only pipes.amazonaws.com for this account and exact pipe ARN, polls/deletes only this source and invokes only this qualified target. Target Lambda resource-based permission is not created because Pipes uses its execution role. Owner must authorize source-key decrypt and pipe-key DescribeKey/GenerateDataKey/Decrypt in existing key policies. No automatic key policy overwrite.

The AWS pipe-key documentation currently names both aws:pipe:arn and aws:pipes:arn encryption contexts. The scoped execution policy supports either documented spelling, requires at least one and binds every present documented key to the exact pipe ARN. Independently verify actual CloudTrail context/effective key policy in the approved environment; local validation cannot qualify cryptographic operations. No broad Resource:* key access is generated. Pipe key protects stored patterns/transformers, not source/Lambda/DLQ storage. This path has NO filters/transformers/enrichment and logs OFF. Adding filters to SQS can DELETE unmatched records; changing these settings needs a separate reviewed data-loss/retention workflow. Error/execution logging may contain sensitive data and must be designed/authorized separately. Use approved CloudWatch metrics/alarms and Lambda logging/monitoring; logging OFF is not full operational readiness.

Pipes passes a JSON ARRAY of source records to a Lambda batch target, not the ordinary Lambda SQS event-source Records wrapper. Confirm the handler implements this exact contract, idempotence/duplicates and partial-failure semantics with controlled nonproduction tests. Target invocation is synchronous REQUEST_RESPONSE, so delivery success is distinct from application integrity. No example handler claims to process your application. Coordinate exclusive polling/competing consumers through owner inventory: metadata checks do not prove no other consumers. Source queue must already redrive to the selected DLQ; do not confuse the source redrive queue with the pipe asynchronous DLQ. Preflight requires visibility >=6*targetTimeout+batchWindow and DLQ retention at least source retention; neither proves exactly-once processing or successful recovery. Existing pending/expired/poison messages need a reviewed recovery plan.

Run python INSPECT.py before deployment. It reads account, selected key, exact published Lambda configuration and queue encryption/visibility/redrive/retention metadata only. GetFunctionConfiguration can return environment values in SDK memory; helper never prints or persists them. It does not receive/delete/send messages, invoke Lambda, start pipes or change metadata. Then terraform init/validate/plan; review new scoped role/key context and STOPPED pipe. Apply the reviewed plan. Run python INSPECT.py --check after stable STOPPED state; it compares actual pipe ARN/role/source/target/key/state/batch/synchronous/no filtering/no enrichment/no logging. IAM propagation may require owner inspection; do not blindly retry deployment. Actual effective IAM, throughput, retention, handler contract and live cryptography remain owner tests.

After acceptance, explicitly enable processing in the form, review/apply a new plan. Starting can immediately RECEIVE and DELETE successful messages and invoke arbitrary application side effects/costs. Test failure/timeout/retry/redrive, duplicate safety and ordered processing in an approved isolated environment before production. Monitor source age, target failures, pipe metrics and source DLQ. Do not mix this pipe with an unreviewed event-source mapping consuming the same queue.

Recovery: reviewed STOPPED plan pauses new polling; wait for actual stable stop and account for in-flight work. It cannot undo acknowledged/deleted/expired messages, Lambda side effects or competing consumers. Preserve queues/DLQ/backups, reconcile application data and replay only through authorized idempotent recovery. Pipe prevent_destroy blocks accidental deletion, not retention expiry. No messages, traffic, source settings, automatic redrive or cleanup are changed by inspection. Other sources, asynchronous targets, filters, enrichment, logging and region variants need separate workflows.

https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-pipes-sqs.html
https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-pipes-event-target.html
https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-pipes-permissions.html
https://docs.aws.amazon.com/eventbridge/latest/userguide/cross-service-confused-deputy-prevention.html
https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-encryption-pipes-cmkey.html
https://docs.aws.amazon.com/general/latest/gr/ev_pipes.html
`;
