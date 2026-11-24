import {error,            } from '../core/findings.js';
                                                   
import {blk,dat,hcl,output,res,x} from '../terraform/blueprints/migration/common.js';
import {awsServiceModule,awsServiceRegion} from './aws-service-module.js';
const regions=['us-east-1','us-west-2','ap-south-1','ap-northeast-2','ap-northeast-1','eu-central-1','eu-west-1'];
export const AWS_IVS_SERVICE={
  id:'aws_service_ivs_channel',label:'Set up an authorized low-latency video channel',
  description:'Create one playback-authorized BASIC/STANDARD channel with optional approved existing S3 recording configuration. Uses an existing playback key/token issuer; no broadcast, key retrieval or token generation runs.',
  emits:['aws_ivs_channel'],
  inputs:[awsServiceRegion,
    {id:'name',label:'Channel name',control:'text'},
    {id:'account',label:'AWS account ID',control:'text'},
    {id:'type',label:'Channel type',control:'select',default:'STANDARD',options:[{value:'STANDARD',label:'Standard — multiple playback qualities'},{value:'BASIC',label:'Basic — original input quality'}]},
    {id:'latency',label:'Latency mode',control:'select',default:'LOW',options:[{value:'LOW',label:'Low latency'},{value:'NORMAL',label:'Normal latency'}]},
    {id:'playback_key',label:'Existing regional playback key ARN',control:'text',hint:'Owner-managed imported public key and separately protected ES384 token issuer; never paste private keys or JWTs.'},
    {id:'recording',label:'Recording',control:'select',default:'NONE',options:[{value:'NONE',label:'Do not record'},{value:'EXISTING',label:'Use an approved existing S3 recording configuration'}]},
    {id:'recording_arn',label:'Existing recording configuration ARN',control:'text',showWhen:{input:'recording',equals:['EXISTING']}},
    {id:'recording_bucket',label:'Existing private recording bucket',control:'text',showWhen:{input:'recording',equals:['EXISTING']},hint:'Same account/region; this bounded variant requires existing SSE-S3 defaults. Bucket access, retention and delivery role remain owner-managed.'},
    {id:'recording_approved',label:'Recording and retention approved by data owner',control:'toggle',default:false,showWhen:{input:'recording',equals:['EXISTING']}},
    {id:'distribution',label:'Global delivery boundary approved',control:'toggle',default:false,hint:'Playback authorization restricts viewers; it does not make the service a private-VPC or region-confined video system. Content processing is not end-to-end encrypted.'},
  ],
  build(values){
    const findings          =[],reject=(path       ,message       )=>findings.push(error('aws.ivs.'+path,message,{path}));
    const region=String(values.aws_region??''),name=String(values.name??'').trim(),account=String(values.account??'').trim(),type=String(values.type??''),latency=String(values.latency??''),key=String(values.playback_key??'').trim();
    if(!regions.includes(region))reject('aws_region','Select a verified commercial IVS low-latency control-plane region. This recipe does not support GovCloud/China.');
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(name))reject('name','Use1–128 letters, digits, underscores or hyphens; exclude sensitive identifying data.');
    if(!/^\d{12}$/.test(account))reject('account','Enter the12-digit intended account.');
    if(!['BASIC','STANDARD'].includes(type))reject('type','Select Basic or Standard.');
    if(!['LOW','NORMAL'].includes(latency))reject('latency','Select Low or Normal.');
    const match=/^arn:aws:ivs:([a-z0-9-]+):(\d{12}):playback-key\/[A-Za-z0-9-]+$/.exec(key);
    if(!match||match[1]!==region||match[2]!==account)reject('playback_key','Use the existing playback key ARN from this account and region.');
    const recording=String(values.recording??'NONE'),recordingArn=recording==='EXISTING'?String(values.recording_arn??'').trim():'',bucket=recording==='EXISTING'?String(values.recording_bucket??'').trim():'';
    if(!['NONE','EXISTING'].includes(recording))reject('recording','Select no recording or an existing approved configuration.');
    if(recording==='EXISTING'){
      const recordingMatch=/^arn:aws:ivs:([a-z0-9-]+):(\d{12}):recording-configuration\/[A-Za-z0-9-]+$/.exec(recordingArn);
      if(!recordingMatch||recordingMatch[1]!==region||recordingMatch[2]!==account)reject('recording_arn','Use an existing recording configuration in this account/region.');
      if(!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)||bucket.includes('..')||/^\d+\.\d+\.\d+\.\d+$/.test(bucket))reject('recording_bucket','Enter the existing approved recording bucket name.');
      if(values.recording_approved!==true&&values.recording_approved!=='true')reject('recording_approved','Recording creates retained media and metadata; obtain owner approval first.');
    }
    if(values.distribution!==true&&values.distribution!=='true')reject('distribution','Obtain owner approval for the actual global media-delivery/processing boundary before generating this channel.');
    const built=awsServiceModule(region,[dat('aws_caller_identity','current',{}),
      res('aws_ivs_channel','private',{name,type,latency_mode:latency,authorized:true,recording_configuration_arn:recordingArn,tags:x(hcl({Name:name}))},[
        blk('lifecycle',{prevent_destroy:true},[blk('precondition',{condition:x('data.aws_caller_identity.current.account_id == '+JSON.stringify(account)),error_message:'Wrong IVS account.'})]),
      ]),
      output('ivs_channel','{ arn = aws_ivs_channel.private.arn, ingest_endpoint = aws_ivs_channel.private.ingest_endpoint, playback_url = aws_ivs_channel.private.playback_url }'),
    ],GUIDE,findings);
    built.files['CHANNEL-CONFIG.json']=JSON.stringify({region,name,account,type,latency,key,recordingArn,bucket},null,2)+'\n';
    built.files['PREFLIGHT.py']=CHECK;
    built.files['CHECK.py']=CHECK;
    return built;
  },
}                    ;
const CHECK=[
  'import json, pathlib, subprocess',
  'import boto3',
  'from botocore.config import Config',
  'config=json.loads((pathlib.Path(__file__).resolve().parent/"CHANNEL-CONFIG.json").read_text()); applied=pathlib.Path(__file__).name=="CHECK.py"',
  'session=boto3.Session(region_name=config["region"]); options=Config(retries={"total_max_attempts":1,"mode":"standard"})',
  'if session.client("sts",config=options).get_caller_identity()["Account"]!=config["account"]: raise RuntimeError("Unexpected operator account")',
  'ivs=session.client("ivs",config=options); key=ivs.get_playback_key_pair(arn=config["key"])["keyPair"]',
  'if key.get("arn")!=config["key"] or not key.get("fingerprint"): raise RuntimeError("Require exact existing regional playback key")',
  'if config["recordingArn"]:',
  '    recording=ivs.get_recording_configuration(arn=config["recordingArn"])["recordingConfiguration"]',
  '    if recording.get("arn")!=config["recordingArn"] or recording.get("state")!="ACTIVE" or recording.get("destinationConfiguration",{}).get("s3",{}).get("bucketName")!=config["bucket"]: raise RuntimeError("Require exact ACTIVE recording configuration and approved bucket")',
  '    s3=session.client("s3",config=options); owner={"Bucket":config["bucket"],"ExpectedBucketOwner":config["account"]}',
  '    location=s3.get_bucket_location(**owner).get("LocationConstraint") or "us-east-1"',
  '    if ("eu-west-1" if location=="EU" else location)!=config["region"]: raise RuntimeError("Recording bucket region differs")',
  '    blocks=s3.get_public_access_block(**owner)["PublicAccessBlockConfiguration"]',
  '    if not all(blocks.get(key) is True for key in ["BlockPublicAcls","IgnorePublicAcls","BlockPublicPolicy","RestrictPublicBuckets"]): raise RuntimeError("Require all four recording-bucket public blocks")',
  '    rules=s3.get_bucket_encryption(**owner)["ServerSideEncryptionConfiguration"].get("Rules",[])',
  '    if len(rules)!=1 or rules[0].get("ApplyServerSideEncryptionByDefault",{}).get("SSEAlgorithm")!="AES256": raise RuntimeError("This recording variant requires approved existing SSE-S3 default encryption")',
  'if applied:',
  '    job=json.loads(subprocess.check_output(["terraform","output","-json","ivs_channel"],text=True,timeout=30))',
  '    if not isinstance(job.get("arn"),str) or not job["arn"].startswith("arn:aws:ivs:"+config["region"]+":"+config["account"]+":channel/"): raise RuntimeError("Applied channel is outside selected account/region")',
  '    channel=ivs.get_channel(arn=job["arn"])["channel"]',
  '    expected={"arn":job["arn"],"name":config["name"],"type":config["type"],"latencyMode":config["latency"],"authorized":True,"recordingConfigurationArn":config["recordingArn"]}',
  '    if any(channel.get(key)!=value for key,value in expected.items()) or channel.get("insecureIngest",False) or channel.get("multitrackInputConfiguration",{}).get("enabled"): raise RuntimeError("Channel differs or unsupported insecure/multitrack ingest is enabled")',
  '    if channel.get("ingestEndpoint")!=job["ingest_endpoint"] or channel.get("playbackUrl")!=job["playback_url"] or not channel.get("playbackUrl","").startswith("https://"): raise RuntimeError("Channel endpoints differ")',
  'print(json.dumps({"metadata_checked":True,"channel_checked":applied,"stream_key_retrieved":False,"video_sent_or_viewed":False,"token_issuer_or_playback_authorization_proven":False}))',
].join('\n')+'\n';
const GUIDE=`# Playback-authorized IVS low-latency channel

Create one BASIC or STANDARD channel, LOW or NORMAL latency, authorization enabled. Recording defaults off; optionally attach an approved existing same-account/region ACTIVE S3 recording configuration. No recording configuration/bucket/policy is created or modified. No stream, player, encoder, token issuer or chat/realtime-stage deployment is included. Existing generic catalog forms remain available separately. This channel recipe is a bounded setup workflow, not a full streaming application.

## Optional recording
Recording requires explicit data-owner retention approval and the existing configuration's exact destination bucket. Preflight reads configuration state/destination and expected-owner bucket region, all four public blocks and SSE-S3 default encryption. This bounded recording variant excludes customer-KMS bucket defaults; it does not change encryption or effective bucket policies. Existing IVS delivery/service-linked role, bucket policy, actual object encryption, records/privacy/retention, Object Lock/lifecycle, backup and playback authorization remain owner prerequisites. Live media, thumbnails and metadata are retained under generated IVS prefixes, not the live-channel token boundary: protect recorded objects independently. Acceptance requires actual recording-complete events, integrity and authorized read tests; metadata checks alone do not prove delivery. Disabling recording only affects subsequent service behavior and does not erase retained objects. No recording starts until a separately authorized broadcast runs.

## Boundary and prerequisites
IVS playback authorization is viewer-token authorization, not private-VPC networking. Low-latency video is globally delivered and is not end-to-end encrypted; internal processing can use unencrypted media. Obtain data-owner approval for actual content, participants, caches, diagnostics, global distribution and service processing before generation or broadcast. Selecting a control-plane region does not impose regional media residency. This commercial-region workflow makes no federal ATO/APL/FIPS/classified-boundary claim. When the approved boundary requires private regional processing or end-to-end encryption, choose another qualified architecture. Do not place sensitive identities in channel metadata.

Existing regional playback public key must already be imported and independently managed. Its corresponding ES384 private key belongs only in the approved token-issuer secret boundary, never browser input, ZIP, Terraform variable/state, logs or client application. IVS playback keys are account/region resources, not bound to one channel. An authorized backend must independently authenticate/authorize viewers and issue short-lived channel-scoped JWTs; key presence alone does not implement this. Review JWT claims, channel ARN, expiry, signing algorithm, audience/origin policy and revocation/session controls against current IVS documentation. Use integer Unix seconds for exp; IVS checks token expiry at playback initialization, so token expiry does not bound an already established viewing session. Use owner-tested viewer-id/session-version revocation controls where required. Browser origin restrictions alone do not establish viewer identity. No token or private key is generated here.

## Deployment
Run PREFLIGHT.py using approved Python3/current boto3/botocore and existing scoped STS/GetPlaybackKeyPair permissions; it checks metadata only and never retrieves ingest keys. Review Terraform account, channel type/latency, authorized=true, selected recording mode/ARN and costs/quotas. Run init/validate, plan and owner-approved apply. Channel creation also creates an ingest stream key in AWS. Provider5 channel schema does not export/manage its value; this package never retrieves it. Protect that existing service-side secret under separate owner key-management procedures, use approved protected console/SDK handoff to the encoder, and never paste it into this toolkit or command logs. Do not log API create responses containing keys. Keep Terraform/provider debug logging disabled. Rotation/deletion of the ingest key affects live publishing and requires a separate reviewed operation.

Run CHECK.py after apply; it compares output ARN/endpoints and actual authorization/type/latency/recording/insecure/multitrack fields plus existing playback-key metadata. Provider5 does not model newer insecure-ingest, multitrack, playback-restriction or advanced-preset options; this workflow excludes them and the checker rejects insecure/multitrack drift. Do not interpret local validation as media-path or viewer authorization acceptance.

## Explicit media/application acceptance
Configure an approved encoder for H.264/AAC, RTMPS over TLS1.2+ on TCP443, current IVS bitrate/resolution limits for the chosen type, and approved keyframe interval. Use the selected channel's ingest endpoint and separately protected ingest key. Never substitute plaintext RTMP/SRT. No broadcast command executes here. The authorized application serves playback through the supported IVS player with owner-issued channel-scoped viewer tokens; test authorized/unauthorized/expired/wrong-channel/revoked viewers and applicable origin/session controls. Validate actual latency, codec quality, accessibility, capacity, media handling and audit evidence with synthetic authorized content first. BASIC does not provide the same transcoding ladder as STANDARD; pricing differs by input/output quality and viewer distribution.

## Recovery and retirement
Preserve prior reviewed channel/player/issuer configuration. prevent_destroy only guards Terraform deletion, not live streams, key compromise or viewer revocation. Test emergency stop, ingest-key rotation, playback key/issuer rollout and viewer-session revocation separately. Coordinate shared playback-key ownership; deleting a regional key can affect other channels. This recipe never removes an existing key, publisher or viewer session. Retire only newly managed channel resources after reviewed dependent workloads and evidence retention.

https://docs.aws.amazon.com/ivs/latest/LowLatencyUserGuide/private-channels.html
https://docs.aws.amazon.com/ivs/latest/LowLatencyUserGuide/security-data-protection.html
https://docs.aws.amazon.com/ivs/latest/LowLatencyUserGuide/streaming-config.html
https://docs.aws.amazon.com/ivs/latest/LowLatencyAPIReference/API_CreateChannel.html
https://docs.aws.amazon.com/general/latest/gr/ivs.html
`;
