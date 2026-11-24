import {error,type Finding} from '../core/findings.ts';
import type {Blueprint} from '../kit/blueprint.ts';
import {blk,dat,hcl,jsonencode,output,res,x} from '../terraform/blueprints/migration/common.ts';
import {awsServiceModule,awsServiceRegion} from './aws-service-module.ts';
const regions=['us-east-2','us-east-1','us-west-2','af-south-1','ap-east-1','ap-southeast-5','ap-south-1','ap-northeast-2','ap-southeast-1','ap-southeast-2','ap-northeast-1','ca-central-1','eu-central-1','eu-west-1','eu-west-2','eu-west-3','eu-south-2','il-central-1','me-south-1','sa-east-1'];
export const AWS_KINESIS_VIDEO_SERVICE={
  id:'aws_service_kinesis_video',label:'Set up an encrypted video stream with scoped producer/consumer roles',
  description:'Create an MKV video stream with an existing customer key, bounded retention and separate existing producer/consumer role policies. Metadata checks do not upload or play media.',
  emits:['aws_kinesis_video_stream','aws_iam_role_policy'],
  inputs:[awsServiceRegion,{id:'name',label:'Video stream name',control:'text'},{id:'account',label:'AWS account ID',control:'text'},
    {id:'device',label:'Device label',control:'text',hint:'Non-sensitive device inventory label; no camera credentials or personal identifiers.'},
    {id:'retention',label:'Media retention (hours)',control:'number',default:24,min:0,max:87600,hint:'0 disables durable retention but still allows transient buffering. Reducing retention can irreversibly expire media.'},
    {id:'consumer_mode',label:'Consumer access',control:'select',default:'LIVE',options:[{value:'LIVE',label:'Live GetMedia only'},{value:'ARCHIVE',label:'Live and retained-fragment/playback access'}]},
    {id:'kms',label:'Existing customer KMS key ARN',control:'text'},
    {id:'producer',label:'Existing producer IAM role ARN',control:'text'},
    {id:'consumer',label:'Existing consumer IAM role ARN',control:'text'},
    {id:'approved',label:'Media handling and retention approved',control:'toggle',default:false,hint:'Review capture consent, identity/credentials, network boundary, retention, access and actual media handling with owners.'},
  ],
  build(values){
    const findings:Finding[]=[],reject=(path:string,message:string)=>findings.push(error('aws.kinesis-video.'+path,message,{path}));
    const region=String(values.aws_region??''),name=String(values.name??'').trim(),account=String(values.account??'').trim(),device=String(values.device??'').trim(),retention=Number(values.retention),mode=String(values.consumer_mode??''),kms=String(values.kms??'').trim(),producer=String(values.producer??'').trim(),consumer=String(values.consumer??'').trim();
    if(!regions.includes(region))reject('aws_region','Select a verified commercial video-stream region. GovCloud/FIPS, China and WebRTC need separate qualified variants.');
    if(!/^[A-Za-z0-9_.-]{1,256}$/.test(name))reject('name','Use1–256 letters, digits, underscores, periods or hyphens.');
    if(!/^\d{12}$/.test(account))reject('account','Enter the12-digit account.');
    if(!/^[A-Za-z0-9_.-]{1,128}$/.test(device))reject('device','Use a non-sensitive1–128-character device label.');
    if(!Number.isInteger(retention)||retention<0||retention>87600)reject('retention','Use0–87600 whole retention hours.');
    if(!['LIVE','ARCHIVE'].includes(mode))reject('consumer_mode','Select live or retained-fragment access.');
    if(mode==='ARCHIVE'&&retention<1)reject('retention','Retained playback requires at least1hour of retention.');
    const keyMatch=/^arn:aws:kms:([a-z0-9-]+):(\d{12}):key\/[0-9a-f-]+$/.exec(kms);
    if(!keyMatch||keyMatch[1]!==region||keyMatch[2]!==account)reject('kms','Use the existing customer key ARN in this account/region.');
    for(const[field,role]of [['producer',producer],['consumer',consumer]]){const match=/^arn:aws:iam::(\d{12}):role\/[A-Za-z0-9_+=,.@/-]{1,512}$/.exec(role!);if(!match||match[1]!==account)reject(field!,'Use an existing role in this account.');}
    if(producer===consumer)reject('consumer','Select separate producer and consumer roles.');
    if(values.approved!==true&&values.approved!=='true')reject('approved','Obtain media handling/retention approval first.');
    const read=['kinesisvideo:DescribeStream','kinesisvideo:GetDataEndpoint','kinesisvideo:GetMedia',...(mode==='ARCHIVE'?['kinesisvideo:ListFragments','kinesisvideo:GetMediaForFragmentList','kinesisvideo:GetClip','kinesisvideo:GetHLSStreamingSessionURL','kinesisvideo:GetDASHStreamingSessionURL']:[])];
    const policy=(actions:string[],crypto:string)=>({Version:'2012-10-17',Statement:[{Effect:'Allow',Action:actions,Resource:x('aws_kinesis_video_stream.media.arn')},{Effect:'Allow',Action:[crypto],Resource:kms,Condition:{StringEquals:{'kms:ViaService':'kinesisvideo.'+region+'.amazonaws.com'}}}]});
    const built=awsServiceModule(region,[dat('aws_caller_identity','current',{}),dat('aws_kms_key','media',{key_id:kms}),
      res('aws_kinesis_video_stream','media',{name,device_name:device,media_type:'video/x-matroska',data_retention_in_hours:retention,kms_key_id:kms,tags:x(hcl({Name:name}))},[
        blk('lifecycle',{prevent_destroy:true},[blk('precondition',{condition:x('data.aws_caller_identity.current.account_id == '+JSON.stringify(account)+' && data.aws_kms_key.media.arn == '+JSON.stringify(kms)+' && data.aws_kms_key.media.enabled && data.aws_kms_key.media.key_manager == "CUSTOMER" && data.aws_kms_key.media.key_spec == "SYMMETRIC_DEFAULT" && data.aws_kms_key.media.key_usage == "ENCRYPT_DECRYPT"'),error_message:'Require this account enabled symmetric customer media key.'})]),
      ]),
      res('aws_iam_role_policy','producer',{name_prefix:name.slice(0,40)+'-producer-',role:producer.split('/').pop()??'',policy:x(jsonencode(policy(['kinesisvideo:DescribeStream','kinesisvideo:GetDataEndpoint','kinesisvideo:PutMedia'],'kms:GenerateDataKey')))}),
      res('aws_iam_role_policy','consumer',{name_prefix:name.slice(0,40)+'-consumer-',role:consumer.split('/').pop()??'',policy:x(jsonencode(policy(read,'kms:Decrypt')))}),
      output('video_stream','aws_kinesis_video_stream.media.arn'),
    ],GUIDE,findings);
    built.files['VIDEO-CONFIG.json']=JSON.stringify({region,name,account,device,retention,mode,kms,producer,consumer},null,2)+'\n';
    built.files['PREFLIGHT.py']=CHECK;built.files['CHECK.py']=CHECK;
    return built;
  },
} satisfies Blueprint;
const CHECK=[
  'import json, pathlib, subprocess',
  'import boto3',
  'from botocore.config import Config',
  'config=json.loads((pathlib.Path(__file__).resolve().parent/"VIDEO-CONFIG.json").read_text()); applied=pathlib.Path(__file__).name=="CHECK.py"',
  'session=boto3.Session(region_name=config["region"]); options=Config(retries={"total_max_attempts":1,"mode":"standard"})',
  'if session.client("sts",config=options).get_caller_identity()["Account"]!=config["account"]: raise RuntimeError("Wrong account")',
  'key=session.client("kms",config=options).describe_key(KeyId=config["kms"])["KeyMetadata"]',
  'if key.get("Arn")!=config["kms"] or key.get("KeyState")!="Enabled" or key.get("KeyManager")!="CUSTOMER" or key.get("KeySpec")!="SYMMETRIC_DEFAULT" or key.get("KeyUsage")!="ENCRYPT_DECRYPT": raise RuntimeError("Require exact enabled symmetric customer media key")',
  'iam=session.client("iam",config=options)',
  'for role in [config["producer"],config["consumer"]]:',
  '    if iam.get_role(RoleName=role.rsplit("/",1)[1])["Role"].get("Arn")!=role: raise RuntimeError("Existing role ownership/path differs")',
  'if applied:',
  '    arn=json.loads(subprocess.check_output(["terraform","output","-json","video_stream"],text=True,timeout=30))',
  '    if not isinstance(arn,str) or not arn.startswith("arn:aws:kinesisvideo:"+config["region"]+":"+config["account"]+":stream/"+config["name"]+"/"): raise RuntimeError("Stream boundary/name differs")',
  '    stream=session.client("kinesisvideo",config=options).describe_stream(StreamARN=arn)["StreamInfo"]',
  '    expected={"StreamARN":arn,"StreamName":config["name"],"DeviceName":config["device"],"DataRetentionInHours":config["retention"],"MediaType":"video/x-matroska","KmsKeyId":config["kms"],"Status":"ACTIVE"}',
  '    if any(stream.get(key)!=value for key,value in expected.items()): raise RuntimeError("Stream/key/retention/media configuration differs")',
  'print(json.dumps({"metadata_checked":True,"stream_checked":applied,"media_uploaded_read_or_played":False,"key_policy_effective_access_or_media_integrity_proven":False}))',
].join('\n')+'\n';
const GUIDE=`# Encrypted Kinesis video stream

Creates one MKV video stream using an existing customer key, with separate existing producer/consumer roles. Adds exact-stream IAM actions and exact-key KMS GenerateDataKey for producer/Decrypt for consumer, conditioned on regional Kinesis Video ViaService. No role trust/key policy, endpoint/network or device configuration changes. Existing role/resource/session/SCP policies and key-owner authorization remain prerequisites; these allows are not a complete account-wide access boundary.

## Media and retention decisions
Owner must approve capture/consent, data classification, destination/boundary, identities, transport, records/retention, backup and disposal. KMS encryption and a region selection do not establish agency/DoD ATO/APL, cryptographic certification or private-network confinement. This bounded commercial workflow excludes GovCloud/FIPS, cross-account keys, WebRTC signaling/ingestion and image generation, each requiring separate qualification. Review private endpoint/DNS/routes through a separately approved network workflow if required; no public-access restriction is inferred from this stream setup.

Retention0 disables durable storage but transient service buffering and KMS requests still occur. Archived access requires positive retention. Reducing retention can irreversibly expire existing media; increasing it cannot recover already expired data. The selected KMS key cannot be reassigned through UpdateStream; a key change requires separate replacement/migration and continuity planning. prevent_destroy is not a backup or service-side lock. Keep source recordings and test recovery independently.

## Setup and verification
Run PREFLIGHT.py using approved Python3/current boto3; checks account, actual enabled customer key and exact existing role ownership. Review generated stream/role policies and saved Terraform plan, then use the authorized change process for apply. Run CHECK.py to compare actual stream ARN/name/device/type/key/retention/status. No media request or endpoint discovery runs in these checks. Stream creation can succeed with a bad/inaccessible key; successful metadata is not proof that first PutMedia/GetMedia will work. Existing key policy and actual producer/consumer identity tests are mandatory before accepting source media.

## Producer and consumer integration
Use an approved maintained Kinesis Video Producer SDK/device integration for MKV fragments, timestamps, codec initialization, TLS verification, temporary device credentials, acknowledgements/backpressure and reconnect handling. Boto3 control-plane setup is not a replacement for a supported PutMedia producer. Do not embed long-lived device keys in generated files. Producer gets DescribeStream/GetDataEndpoint/PutMedia only for this stream and regional service-mediated GenerateDataKey on the selected key; consumer gets corresponding read discovery/GetMedia plus optional retained-fragment/playback APIs, with regional service-mediated Decrypt. Neither role gets stream creation/deletion/retention changes or IAM/key administration.

Discover each operation's data endpoint at runtime through GetDataEndpoint and use the matching approved data-plane client; don't hardcode or confuse control-plane and media endpoints. LIVE mode supports GetMedia; ARCHIVE additionally permits ListFragments/GetMediaForFragmentList/GetClip/HLS/DASH session URL creation. Codec/player compatibility must be qualified independently. HLS/DASH URLs contain credential-like playback tokens and must not enter logs, browser history or unauthorized recipients. No signed media URL or video is generated, fetched or played here.

Use separately approved synthetic capture to test actual KMS access, one producer at a time, packet/fragment timestamps, acknowledgement/error handling, retention boundary, reader denial, codecs, playback quality, cost and source-to-target integrity. Account/region quotas and ingest/storage/consumption/KMS charges require owner review. Application capture/storage and real media migration remain separate work.

https://docs.aws.amazon.com/kinesisvideostreams/latest/dg/how-kms.html
https://docs.aws.amazon.com/kinesisvideostreams/latest/dg/how-iam.html
https://docs.aws.amazon.com/kinesisvideostreams/latest/APIReference/API_UpdateDataRetention.html
https://docs.aws.amazon.com/kinesisvideostreams/latest/APIReference/API_Operations.html
https://docs.aws.amazon.com/general/latest/gr/akv.html
`;
