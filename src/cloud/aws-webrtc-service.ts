import {error,type Finding} from '../core/findings.ts';
import type {Blueprint} from '../kit/blueprint.ts';
import {blk,dat,hcl,jsonencode,output,res,x} from '../terraform/blueprints/migration/common.ts';
import {awsServiceModule,awsServiceRegion} from './aws-service-module.ts';
export const AWS_WEBRTC_SERVICE={
  id:'aws_service_webrtc_signaling',label:'Set up a single-master WebRTC signaling channel',
  description:'Create a retained CloudFormation-managed signaling channel through Terraform provider5, with separate existing master/viewer role permissions. No TURN credential request, signaling connection, recording or media transmission runs.',
  emits:['aws_cloudformation_stack','aws_iam_role_policy'],
  inputs:[awsServiceRegion,{id:'name',label:'Signaling deployment name',control:'text',hint:'2–40 lowercase letters, digits and hyphens; creates a new stack/channel.'},{id:'account',label:'AWS account ID',control:'text'},
    {id:'ttl',label:'Undelivered signaling message TTL (seconds)',control:'number',default:60,min:5,max:120},
    {id:'stack_role',label:'Existing CloudFormation execution role ARN',control:'text',hint:'Separate deployment role with owner-approved cloudformation.amazonaws.com trust and channel-management permissions; no IAM role/trust changes.'},
    {id:'master',label:'Existing master IAM role ARN',control:'text'},
    {id:'viewer',label:'Existing viewer IAM role ARN',control:'text'},
    {id:'approved',label:'Peer/relay media and identity boundary approved',control:'toggle',default:false,hint:'WebRTC peers and possible TURN relay paths need separate network/media approval. Signaling message TTL is not media retention or session duration.'},
  ],
  build(values){
    const findings:Finding[]=[],reject=(path:string,message:string)=>findings.push(error('aws.webrtc.'+path,message,{path}));
    const region=String(values.aws_region??''),name=String(values.name??'').trim(),account=String(values.account??'').trim(),ttl=Number(values.ttl),stackRole=String(values.stack_role??'').trim(),master=String(values.master??'').trim(),viewer=String(values.viewer??'').trim();
    if(!['us-east-1','us-east-2','us-west-2','ap-south-1','ap-northeast-1','ap-northeast-2','ap-southeast-1','ap-southeast-2','ca-central-1','eu-central-1','eu-west-1','eu-west-2','eu-west-3','sa-east-1'].includes(region))reject('aws_region','Select a commercial region in this bounded recipe; verify WebRTC regional support. GovCloud/FIPS and China are excluded.');
    if(!/^[a-z][a-z0-9-]{1,39}$/.test(name))reject('name','Use2–40 lowercase letters/digits/hyphens, starting with a letter.');
    if(!/^\d{12}$/.test(account))reject('account','Enter the12-digit account.');
    if(!Number.isInteger(ttl)||ttl<5||ttl>120)reject('ttl','Use5–120 whole signaling TTL seconds.');
    for(const[field,role]of [['stack_role',stackRole],['master',master],['viewer',viewer]]){const match=/^arn:aws:iam::(\d{12}):role\/[A-Za-z0-9_+=,.@/-]{1,512}$/.exec(role!);if(!match||match[1]!==account)reject(field!,'Select an existing role in this account.');}
    if(new Set([stackRole,master,viewer]).size!==3)reject('viewer','Use distinct deployment, master and viewer roles.');
    if(values.approved!==true&&values.approved!=='true')reject('approved','Obtain media/relay/identity boundary approval first.');
    const template={AWSTemplateFormatVersion:'2010-09-09',Resources:{Channel:{Type:'AWS::KinesisVideo::SignalingChannel',DeletionPolicy:'Retain',UpdateReplacePolicy:'Retain',Properties:{Name:name,Type:'SINGLE_MASTER',MessageTtlSeconds:ttl,Tags:[{Key:'Name',Value:name}]}}},Outputs:{ChannelArn:{Value:{'Fn::GetAtt':['Channel','Arn']}}}};
    const policy=(actor:string)=>({Version:'2012-10-17',Statement:[{Effect:'Allow',Action:['kinesisvideo:DescribeSignalingChannel','kinesisvideo:GetSignalingChannelEndpoint','kinesisvideo:GetIceServerConfig','kinesisvideo:ConnectAs'+actor],Resource:x('aws_cloudformation_stack.signaling.outputs["ChannelArn"]')}]});
    const built=awsServiceModule(region,[dat('aws_caller_identity','current',{}),
      res('aws_cloudformation_stack','signaling',{name:name+'-signaling',iam_role_arn:stackRole,template_body:JSON.stringify(template),timeout_in_minutes:15,policy_body:JSON.stringify({Statement:[{Effect:'Allow',Action:'Update:*',Principal:'*',Resource:'*'},{Effect:'Deny',Action:['Update:Replace','Update:Delete'],Principal:'*',Resource:'LogicalResourceId/Channel'}]}),tags:x(hcl({Name:name}))},[
        blk('lifecycle',{prevent_destroy:true},[blk('precondition',{condition:x('data.aws_caller_identity.current.account_id == '+JSON.stringify(account)),error_message:'Wrong signaling deployment account.'})]),
      ]),
      res('aws_iam_role_policy','master',{name_prefix:name+'-master-',role:master.split('/').pop()??'',policy:x(jsonencode(policy('Master')))}),
      res('aws_iam_role_policy','viewer',{name_prefix:name+'-viewer-',role:viewer.split('/').pop()??'',policy:x(jsonencode(policy('Viewer')))}),
      output('webrtc_signaling','{ stack = aws_cloudformation_stack.signaling.id, arn = aws_cloudformation_stack.signaling.outputs["ChannelArn"] }'),
    ],GUIDE,findings);
    built.files['SIGNALING.template.json']=JSON.stringify(template,null,2)+'\n';
    built.files['SIGNALING-CONFIG.json']=JSON.stringify({region,name,account,ttl,stackRole,master,viewer},null,2)+'\n';
    built.files['PREFLIGHT.py']=CHECK;built.files['CHECK.py']=CHECK;
    return built;
  },
} satisfies Blueprint;
const CHECK=[
  'import json, pathlib, subprocess',
  'import boto3',
  'from botocore.config import Config',
  'config=json.loads((pathlib.Path(__file__).resolve().parent/"SIGNALING-CONFIG.json").read_text()); applied=pathlib.Path(__file__).name=="CHECK.py"',
  'session=boto3.Session(region_name=config["region"]); options=Config(retries={"total_max_attempts":1,"mode":"standard"})',
  'if session.client("sts",config=options).get_caller_identity()["Account"]!=config["account"]: raise RuntimeError("Wrong account")',
  'iam=session.client("iam",config=options)',
  'for role in [config["stackRole"],config["master"],config["viewer"]]:',
  '    if iam.get_role(RoleName=role.rsplit("/",1)[1])["Role"].get("Arn")!=role: raise RuntimeError("Existing role ownership/path differs")',
  'if applied:',
  '    job=json.loads(subprocess.check_output(["terraform","output","-json","webrtc_signaling"],text=True,timeout=30))',
  '    if not job.get("arn","").startswith("arn:aws:kinesisvideo:"+config["region"]+":"+config["account"]+":channel/"+config["name"]+"/"): raise RuntimeError("Wrong channel name/boundary")',
  '    stacks=session.client("cloudformation",config=options).describe_stacks(StackName=job["stack"])["Stacks"]',
  '    if len(stacks)!=1 or stacks[0].get("StackId")!=job["stack"] or stacks[0].get("StackName")!=config["name"]+"-signaling" or stacks[0].get("RoleARN")!=config["stackRole"] or stacks[0].get("StackStatus") not in ["CREATE_COMPLETE","UPDATE_COMPLETE"] or {row["OutputKey"]:row["OutputValue"] for row in stacks[0].get("Outputs",[])}.get("ChannelArn")!=job["arn"]: raise RuntimeError("Stack status/role/channel output differs")',
  '    video=session.client("kinesisvideo",config=options); channel=video.describe_signaling_channel(ChannelARN=job["arn"])["ChannelInfo"]',
  '    expected={"ChannelARN":job["arn"],"ChannelName":config["name"],"ChannelType":"SINGLE_MASTER","ChannelStatus":"ACTIVE","SingleMasterConfiguration":{"MessageTtlSeconds":config["ttl"]}}',
  '    if any(channel.get(key)!=value for key,value in expected.items()): raise RuntimeError("Signaling channel configuration/status differs")',
  '    storage=video.describe_media_storage_configuration(ChannelARN=job["arn"])["MediaStorageConfiguration"]',
  '    if storage.get("Status")!="DISABLED" or storage.get("StreamARN"): raise RuntimeError("This peer-signaling recipe requires disabled cloud storage; enabling ingestion changes peer topology and needs a separate approved workflow")',
  'print(json.dumps({"metadata_checked":True,"channel_checked":applied,"ice_credentials_requested":False,"signaling_connected_or_media_transmitted":False,"peer_identity_or_effective_authorization_proven":False}))',
].join('\n')+'\n';
const GUIDE=`# Single-master WebRTC signaling setup

Pinned AWS provider5 has no native signaling-channel resource. Terraform owns a new CloudFormation stack containing the actual AWS::KinesisVideo::SignalingChannel resource; SIGNALING.template.json is the identical review copy, not a second stack to deploy. No metadata-only substitute is counted as channel creation. Existing CloudFormation execution role must have owner-approved service trust/permissions and deployer PassRole/stack permissions; no role/trust is created. Terraform attaches separate exact-channel master/viewer action policies to existing roles, without broad stream/recording or IAM rights. Role trust, application credentials and effective permissions remain owner-reviewed.

## Boundary and client integration
One SINGLE_MASTER channel, bounded5–120second signaling message TTL. This TTL covers undelivered signaling messages, not media storage, session lifetime, credentials or revocation. No media storage/recording, full-mesh, WebRTC ingestion, multiviewer application or private-network/federal authorization is implied. Obtain approval for actual peers, ICE/STUN/TURN relay paths, identity, media capture/consent, classification and allowed boundaries. Cloud region and service encryption alone are not agency/DoD ATO/APL/FIPS or classified-handling evidence. GovCloud/FIPS/China require separate variants.

Use an approved maintained Kinesis Video WebRTC SDK and application/device authentication flow with temporary credentials. Master/viewer policies include only exact-channel DescribeSignalingChannel/GetSignalingChannelEndpoint/GetIceServerConfig and the corresponding ConnectAsMaster/ConnectAsViewer action. Existing role policies can grant other rights; review them independently. Discover role-specific HTTPS/WSS endpoints at runtime, then request ICE configuration through the HTTPS signaling client and use approved WebRTC peer/media handling. ICE/TURN responses contain temporary credentials: do not print/persist them or paste them into this toolkit. No endpoint discovery, ICE credential request, WSS connection or media operation is run by generation, Terraform or metadata checks.

## Deploy and verify
PREFLIGHT.py checks the operator account and exact existing role ownership/path only. It does not prove CloudFormation trust/effective rights, SDK compatibility, quotas or network readiness. Review generated stack template, retained-resource/rollback effects, stack policy, exact role grants and Terraform saved plan. Apply under authorized change process. CHECK.py compares exact stack/channel identity, stack role/status/output, ACTIVE SINGLE_MASTER type/message TTL and disabled cloud-media storage. Enabling storage changes peers from direct connections to a storage-session topology; this checker refuses that drift rather than claiming the original peer setup is still verified. Operator needs DescribeMediaStorageConfiguration metadata permission. These are read-only checks using approved Python3/current boto3; they do not demonstrate successful signaling or media quality.

Run separate owner-approved synthetic peer tests for master/viewer authorization and denial, endpoint discovery, credentials/session renewal/revocation, DTLS/SRTP peer security, relay fallback and allowed egress, NAT/firewall behavior, latency, codec/media integrity and source privacy. A channel by itself is not a finished application or media migration.

## Recovery and lifecycle
CloudFormation deletion/update-replacement retention preserves the channel; stack policy denies channel deletion/replacement through ordinary updates and Terraform prevent_destroy guards stack deletion. These are not service-side locks or emergency access revocation. Retained channels require explicit owner inventory/cleanup and may remain after failed/retired stacks. Do not independently deploy the review template or take over a shared stack/channel. Name changes require a separately reviewed transition rather than accidental replacement. Preserve client/source configuration and test recovery independently.

https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-kinesisvideo-signalingchannel.html
https://docs.aws.amazon.com/kinesisvideostreams/latest/APIReference/API_CreateSignalingChannel.html
https://docs.aws.amazon.com/kinesisvideostreams/latest/APIReference/API_SingleMasterConfiguration.html
https://docs.aws.amazon.com/kinesisvideostreams-webrtc-dg/latest/devguide/kvswebrtc-security.html
`;
