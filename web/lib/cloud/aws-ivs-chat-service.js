import {error,            } from '../core/findings.js';
                                                   
import {blk,dat,hcl,output,res,x} from '../terraform/blueprints/migration/common.js';
import {awsServiceModule,awsServiceRegion} from './aws-service-module.js';
const regions=['us-east-1','us-west-2','ap-south-1','ap-northeast-2','ap-northeast-1','eu-central-1','eu-west-1'];
export const AWS_IVS_CHAT_SERVICE={
  id:'aws_service_ivs_chat',label:'Set up a moderated and logged chat room',
  description:'Create an IVS Chat room using an existing approved Lambda review function and existing CloudWatch logging configuration. Errors deny message delivery; no token, message, function invocation or log-body read runs.',
  emits:['aws_ivschat_room'],
  inputs:[awsServiceRegion,
    {id:'name',label:'Room name',control:'text'},
    {id:'account',label:'AWS account ID',control:'text'},
    {id:'reviewer',label:'Existing versioned review Lambda ARN',control:'text',hint:'Same account/region, published numeric version. Must meet IVS Chat200ms review deadline; no function/code/policy replacement.'},
    {id:'logging',label:'Existing CloudWatch logging configuration ARN',control:'text'},
    {id:'log_group',label:'Existing message log group name',control:'text'},
    {id:'kms',label:'Existing message-log KMS key ARN',control:'text'},
    {id:'retention',label:'Existing message-log retention (days)',control:'select',default:'90',options:[7,14,30,60,90,180,365,730].map(value=>({value:String(value),label:value+' days'}))},
    {id:'length',label:'Maximum message length (characters)',control:'number',default:500,min:1,max:500},
    {id:'rate',label:'Maximum room messages per second',control:'number',default:10,min:1,max:100},
    {id:'approved',label:'Message processing and content logging approved',control:'toggle',default:false,hint:'Reviewer receives content, sender attributes and IP. Logging retains message content; review privacy/records/boundary requirements before creating.'},
  ],
  build(values){
    const findings          =[],reject=(path       ,message       )=>findings.push(error('aws.ivs-chat.'+path,message,{path}));
    const region=String(values.aws_region??''),name=String(values.name??'').trim(),account=String(values.account??'').trim(),reviewer=String(values.reviewer??'').trim(),logging=String(values.logging??'').trim(),logGroup=String(values.log_group??'').trim(),kms=String(values.kms??'').trim(),retention=Number(values.retention),length=Number(values.length),rate=Number(values.rate);
    if(!regions.includes(region))reject('aws_region','Select a verified commercial IVS Chat region; no GovCloud/China support in this recipe.');
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(name))reject('name','Use1–128 letters, digits, underscores or hyphens, excluding sensitive data.');
    if(!/^\d{12}$/.test(account))reject('account','Enter the12-digit AWS account ID.');
    const functionMatch=/^arn:aws:lambda:([a-z0-9-]+):(\d{12}):function:([A-Za-z0-9_-]{1,64}):([1-9][0-9]*)$/.exec(reviewer);
    if(!functionMatch||functionMatch[1]!==region||functionMatch[2]!==account)reject('reviewer','Use an existing published numeric Lambda version ARN in this account/region.');
    const logMatch=/^arn:aws:ivschat:([a-z0-9-]+):(\d{12}):logging-configuration\/[A-Za-z0-9-]+$/.exec(logging);
    if(!logMatch||logMatch[1]!==region||logMatch[2]!==account)reject('logging','Use an existing logging configuration ARN in this account/region.');
    if(!/^[A-Za-z0-9_./#-]{1,512}$/.test(logGroup))reject('log_group','Enter the existing CloudWatch message log group name.');
    const keyMatch=/^arn:aws:kms:([a-z0-9-]+):(\d{12}):key\/[0-9a-f-]+$/.exec(kms);
    if(!keyMatch||keyMatch[1]!==region||keyMatch[2]!==account)reject('kms','Use the existing message-log customer key ARN in this account/region.');
    if(![7,14,30,60,90,180,365,730].includes(retention))reject('retention','Choose the owner-approved existing log retention.');
    if(!Number.isInteger(length)||length<1||length>500)reject('length','Use1–500 code points per message.');
    if(!Number.isInteger(rate)||rate<1||rate>100)reject('rate','Use1–100 messages per second for the room.');
    if(values.approved!==true&&values.approved!=='true')reject('approved','Obtain approval for message review, IP/attributes processing and content logging.');
    const built=awsServiceModule(region,[dat('aws_caller_identity','current',{}),
      res('aws_ivschat_room','moderated',{name,maximum_message_length:length,maximum_message_rate_per_second:rate,logging_configuration_identifiers:[logging],tags:x(hcl({Name:name}))},[
        blk('message_review_handler',{uri:reviewer,fallback_result:'DENY'}),
        blk('lifecycle',{prevent_destroy:true},[blk('precondition',{condition:x('data.aws_caller_identity.current.account_id == '+JSON.stringify(account)),error_message:'Wrong IVS Chat account.'})]),
      ]),output('ivs_chat_room','aws_ivschat_room.moderated.arn'),
    ],GUIDE,findings);
    built.files['CHAT-CONFIG.json']=JSON.stringify({region,name,account,reviewer,logging,logGroup,kms,retention,length,rate},null,2)+'\n';
    built.files['REVIEW-PERMISSION.example.json']=JSON.stringify({Version:'2012-10-17',Statement:[{Effect:'Allow',Principal:{Service:'ivschat.amazonaws.com'},Action:'lambda:InvokeFunction',Resource:reviewer,Condition:{StringEquals:{'AWS:SourceAccount':account},ArnLike:{'AWS:SourceArn':'REPLACE_WITH_ACTUAL_ROOM_ARN_FROM_REVIEWED_OUTPUT'}}}]},null,2)+'\n';
    built.files['PREFLIGHT.py']=CHECK;built.files['CHECK.py']=CHECK;
    return built;
  },
}                    ;
const CHECK=[
  'import json, pathlib, subprocess',
  'import boto3',
  'from botocore.config import Config',
  'config=json.loads((pathlib.Path(__file__).resolve().parent/"CHAT-CONFIG.json").read_text()); applied=pathlib.Path(__file__).name=="CHECK.py"',
  'session=boto3.Session(region_name=config["region"]); options=Config(retries={"total_max_attempts":1,"mode":"standard"})',
  'if session.client("sts",config=options).get_caller_identity()["Account"]!=config["account"]: raise RuntimeError("Wrong operator account")',
  'function=session.client("lambda",config=options).get_function_configuration(FunctionName=config["reviewer"])',
  'base,version=config["reviewer"].rsplit(":",1)',
  'if function.get("FunctionArn") not in [base,config["reviewer"]] or function.get("Version")!=version or function.get("State")!="Active": raise RuntimeError("Review function version/state differs")',
  'chat=session.client("ivschat",config=options); logging=chat.get_logging_configuration(identifier=config["logging"])',
  'if logging.get("arn")!=config["logging"] or logging.get("state")!="ACTIVE" or logging.get("destinationConfiguration")!={"cloudWatchLogs":{"logGroupName":config["logGroup"]}}: raise RuntimeError("Require exact ACTIVE CloudWatch message logging configuration")',
  'response=session.client("logs",config=options).describe_log_groups(logGroupNamePrefix=config["logGroup"]); groups=[row for row in response.get("logGroups",[]) if row.get("logGroupName")==config["logGroup"]]',
  'if len(groups)!=1 or groups[0].get("kmsKeyId")!=config["kms"] or groups[0].get("retentionInDays")!=config["retention"]: raise RuntimeError("Message log group key/retention differs")',
  'key=session.client("kms",config=options).describe_key(KeyId=config["kms"])["KeyMetadata"]',
  'if key.get("Arn")!=config["kms"] or key.get("KeyState")!="Enabled" or key.get("KeyManager")!="CUSTOMER" or key.get("KeySpec")!="SYMMETRIC_DEFAULT" or key.get("KeyUsage")!="ENCRYPT_DECRYPT": raise RuntimeError("Require enabled symmetric customer message-log key")',
  'if applied:',
  '    arn=json.loads(subprocess.check_output(["terraform","output","-json","ivs_chat_room"],text=True,timeout=30))',
  '    if not isinstance(arn,str) or not arn.startswith("arn:aws:ivschat:"+config["region"]+":"+config["account"]+":room/"): raise RuntimeError("Room account/region differs")',
  '    room=chat.get_room(identifier=arn)',
  '    expected={"arn":arn,"name":config["name"],"maximumMessageLength":config["length"],"maximumMessageRatePerSecond":config["rate"],"loggingConfigurationIdentifiers":[config["logging"]],"messageReviewHandler":{"uri":config["reviewer"],"fallbackResult":"DENY"}}',
  '    if any(room.get(key)!=value for key,value in expected.items()): raise RuntimeError("Room moderation/rate/logging configuration differs")',
  'print(json.dumps({"metadata_checked":True,"room_checked":applied,"review_function_invoked":False,"token_created_or_message_sent":False,"log_content_read":False,"moderation_delivery_authorization_proven":False}))',
].join('\n')+'\n';
const GUIDE=`# Moderated and logged IVS Chat room

Creates one room using an existing published Lambda review version and an existing ACTIVE CloudWatch logging configuration. Fallback DENY drops messages when review fails or times out. Room limits apply across all clients; character limits count Unicode code points. This recipe does not create a Lambda, issuer, logging configuration, log group, key, permission or message. It preserves shared policies and resources.

## Existing dependencies and authorization
The review function must be in the room account/region, meet the IVS200ms review deadline, implement the documented ALLOW/DENY/modified-content response contract and safely process untrusted content. Cold starts, invalid responses and errors must be acceptance-tested with fallback DENY. Review applies to SendMessage; privileged events and moderation API operations need independent authorization and content review. IVS Chat needs existing Lambda resource-based InvokeFunction permission with ivschat.amazonaws.com principal, correct SourceAccount and owner-reviewed SourceArn room scope. New room ARN is only known after creation: coordinate approved bootstrap permission and then narrow to the actual room ARN before accepting chat traffic. REVIEW-PERMISSION.example.json is a policy example for the dependency owner to merge after replacing the room-ARN marker; it is not applied and must never replace a shared Lambda policy wholesale. This toolkit never installs a wildcard Lambda permission. Metadata checks do not prove effective resource policy or invoke permission, and no messages should be accepted until owners validate it.

Existing logging configuration must point only to the selected same-account regional CloudWatch group with the selected customer key and exact approved retention. Key/log delivery policies and current log configuration ownership remain prerequisites. Creating logging configurations can manage delivery policies; this recipe references an existing one and does not change them. Logging records message/event content, not merely operational counts. Review retained content, sender metadata/IP passed to Lambda, privacy/records, residency, access, backup/deletion and approved agency/DoD boundary as applicable. Region availability is not federal approval, classified handling or FIPS/ATO evidence. No content/body logs are read by checks.

## Build and verify
Run PREFLIGHT.py in an approved Python3/current boto3 environment with scoped read metadata permissions. It reads STS account, Lambda configuration, logging configuration, log group retention/key and enabled customer key. GetFunctionConfiguration can return environment configuration; the script never prints or persists that response, and it does not fetch source code or invoke the function. Use only approved metadata operator access. Review the room Terraform and saved plan, then apply only under the project's deployment/change process. Run CHECK.py to compare the actual room moderation, rates and logging to configuration. Live log delivery, Lambda resource policy, identity/room authorization and content review quality require separate acceptance tests.

## Application integration and tests
An owner-controlled backend must authenticate/authorize users before creating room-scoped IVS Chat tokens with least required capabilities and appropriate session duration. Never give clients AWS administrator credentials, broad ivschat:* or direct unreviewed token-creation authority. Tokens, private chat data and personal identifiers must not be pasted into this toolkit. This setup does not implement an application authentication backend. Use approved client SDK/WebSocket connections and synthetic authorized content to test permitted/denied senders, moderators, expiry/revocation, rate/length limits, handler errors/timeouts/modifications and log delivery/access/retention. Content moderation does not itself authorize users or certify handling. No token, message or synthetic function invocation is executed during generation, Terraform or metadata checks.

## Recovery
Retain the prior reviewed room/application configuration. Fallback DENY favors dropping messages during reviewer outages; it is not a complete content policy or application-availability guarantee. Test recovery, reviewer version changes, emergency disconnect/token revocation and session behavior separately. prevent_destroy only guards Terraform deletion. Retiring a room does not erase retained content or remove shared Lambda/log resources; coordinate records and shared dependency owners.

https://docs.aws.amazon.com/ivs/latest/ChatUserGuide/chat-message-review-handler.html
https://docs.aws.amazon.com/ivs/latest/ChatUserGuide/chat-logging.html
https://docs.aws.amazon.com/ivs/latest/ChatUserGuide/security-iam.html
https://docs.aws.amazon.com/ivs/latest/ChatAPIReference/API_CreateRoom.html
https://docs.aws.amazon.com/general/latest/gr/ivs.html
`;
