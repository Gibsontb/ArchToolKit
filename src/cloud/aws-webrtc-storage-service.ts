import {error,type Finding} from '../core/findings.ts';
import type {Blueprint} from '../kit/blueprint.ts';
import {blk,dat,jsonencode,res,x} from '../terraform/blueprints/migration/common.ts';
import {awsServiceModule,awsServiceRegion} from './aws-service-module.ts';
import {awsWebrtcStorageFiles} from './aws-webrtc-storage-files.ts';
export const AWS_WEBRTC_STORAGE_SERVICE={
  id:'aws_service_webrtc_storage',label:'Prepare existing WebRTC peers for approved retained-media ingestion',
  description:'Add exact existing-channel/stream participant permissions and export an explicit association operator. Terraform applies IAM only; enabling cloud storage is a separate confirmed SDK action that changes peer topology.',
  emits:['aws_iam_role_policy'],
  inputs:[awsServiceRegion,{id:'name',label:'Ingestion configuration name',control:'text'},{id:'account',label:'AWS account ID',control:'text'},
    {id:'channel',label:'Existing single-master channel ARN',control:'text'},{id:'stream',label:'Existing retained video stream ARN',control:'text'},
    {id:'kms',label:'Existing stream customer key ARN',control:'text'},{id:'retention',label:'Approved existing stream retention (hours)',control:'number',default:24,min:1,max:87600},
    {id:'master',label:'Existing master participant role ARN',control:'text'},{id:'viewer',label:'Existing viewer participant role ARN',control:'text'},
    {id:'approved',label:'Storage topology, audio/video recording and retention approved',control:'toggle',default:false,hint:'Changes direct peer connections to cloud-storage sessions. Both audio/video SDK readiness, participant consent and retained-media handling need owner approval.'},
  ],
  build(values){
    const findings:Finding[]=[],reject=(path:string,message:string)=>findings.push(error('aws.webrtc-storage.'+path,message,{path}));
    const region=String(values.aws_region??''),account=String(values.account??'').trim(),name=String(values.name??'').trim(),channel=String(values.channel??'').trim(),stream=String(values.stream??'').trim(),kms=String(values.kms??'').trim(),master=String(values.master??'').trim(),viewer=String(values.viewer??'').trim(),retention=Number(values.retention);
    if(!['us-east-1','us-west-2'].includes(region))reject('aws_region','This bounded ingestion recipe supports US East(N.Virginia)/US West(Oregon). GovCloud ingestion/storage is not available; other commercial regions need separate qualification.');
    if(!/^\d{12}$/.test(account))reject('account','Enter the12-digit account.');
    if(!/^[a-z][a-z0-9-]{1,39}$/.test(name))reject('name','Use2–40 lowercase letters/digits/hyphens, starting with a letter.');
    for(const[field,arn]of [['channel',channel],['stream',stream]]){const match=/^arn:aws:kinesisvideo:([a-z0-9-]+):(\d{12}):(channel|stream)\/[A-Za-z0-9_.-]{1,256}\/[0-9]+$/.exec(arn!);if(!match||match[1]!==region||match[2]!==account||match[3]!==field)reject(field!,'Use the exact existing resource ARN in this account/region.');}
    const keyMatch=/^arn:aws:kms:([a-z0-9-]+):(\d{12}):key\/[0-9a-f-]+$/.exec(kms);
    if(!keyMatch||keyMatch[1]!==region||keyMatch[2]!==account)reject('kms','Select the actual existing customer stream key in this account/region.');
    if(!Number.isInteger(retention)||retention<1||retention>87600)reject('retention','Use1–87600 existing approved retention hours.');
    for(const[field,role]of [['master',master],['viewer',viewer]]){const match=/^arn:aws:iam::(\d{12}):role\/[A-Za-z0-9_+=,.@/-]{1,512}$/.exec(role!);if(!match||match[1]!==account)reject(field!,'Select an existing participant role in this account.');}
    if(master===viewer)reject('viewer','Use separate master/viewer participant roles.');
    if(values.approved!==true&&values.approved!=='true')reject('approved','Obtain topology/recording/retention approval first.');
    const policy=(actor:string)=>({Version:'2012-10-17',Statement:[
      {Effect:'Allow',Action:['kinesisvideo:DescribeSignalingChannel','kinesisvideo:DescribeMediaStorageConfiguration','kinesisvideo:GetSignalingChannelEndpoint','kinesisvideo:GetIceServerConfig','kinesisvideo:ConnectAs'+actor,actor==='Master'?'kinesisvideo:JoinStorageSession':'kinesisvideo:JoinStorageSessionAsViewer'],Resource:channel},
      {Effect:'Allow',Action:['kinesisvideo:DescribeStream','kinesisvideo:GetDataEndpoint','kinesisvideo:PutMedia'],Resource:stream},
      {Effect:'Allow',Action:['kms:GenerateDataKey'],Resource:kms,Condition:{StringEquals:{'kms:ViaService':'kinesisvideo.'+region+'.amazonaws.com'}}},
    ]});
    const built=awsServiceModule(region,[dat('aws_caller_identity','current',{}),dat('aws_iam_role','master',{name:master.split('/').pop()??''}),dat('aws_iam_role','viewer',{name:viewer.split('/').pop()??''}),
      ...[['master',master,'Master'],['viewer',viewer,'Viewer']].map(([id,role,actor])=>res('aws_iam_role_policy',id!,{name_prefix:name+'-'+id+'-storage-',role:role!.split('/').pop()??'',policy:x(jsonencode(policy(actor!)))},[blk('lifecycle',{},[blk('precondition',{condition:x('data.aws_caller_identity.current.account_id == '+JSON.stringify(account)+' && data.aws_iam_role.'+id+'.arn == '+JSON.stringify(role)),error_message:'Wrong participant-role account/path.'})])])),
    ],GUIDE,findings);
    Object.assign(built.files,awsWebrtcStorageFiles({region,account,channel,stream,kms,retention}));
    return built;
  },
} satisfies Blueprint;
const GUIDE=`# Existing-resource WebRTC storage preparation

Terraform adds participant-role IAM policies only. It does NOT enable media storage, join a session, create channels/streams/keys, change trust or send/read media. Existing MKV stream and SINGLE_MASTER signaling channel must already be owner-managed. Metadata inspect/enable is OPERATE.py, a separate explicit SDK operation outside Terraform lifecycle. Do not mistake IAM apply for an enabled association or working media pipeline.

## Preconditions and actual change
Approve the target data classification/boundary, capture consent including viewer audio, retention, media privacy, keys, logs/records and recovery. Existing stream must have positive approved retention and the exact enabled customer key. AWS GovCloud currently excludes WebRTC ingestion/storage; this bounded recipe supports only the two selected commercial US regions. No agency/DoD ATO/APL/FIPS or private-network authorization is implied.

Enabling storage changes direct master/viewer peer connections into connections to a cloud storage session. Current WebRTC SDK peers must support JoinStorageSession/JoinStorageSessionAsViewer and both required audio/video tracks, correct codecs, ICE and network behavior. Metadata alone does not prove these or actual effective IAM/key access. Both master/viewer receive exact-stream DescribeStream/GetDataEndpoint/PutMedia and regional KinesisVideo-mediated GenerateDataKey on the selected key, following AWS ingestion permissions. Master/viewer channel/session actions remain separate. Key policy/role trust/effective permissions and reader/decryption access remain owner-managed. Neither participant is granted association-update, retention/delete, IAM or key administration.

## Inspect and prepare
Run OPERATE.py with approved Python3/current boto3 and owner-approved STS/KMS/KinesisVideo metadata access. Default inspect is read-only. It verifies exact account/ARNs, ACTIVE resources/key, approved retention and both association directions. It refuses conflicting, partial or paginated associations instead of taking over/unlinking them. Existing identical enabled mapping is reported without updating. Coordinate a change window so other actors do not alter the mapping between review/check/action; no atomic compare-and-swap or idempotency token is claimed.

Review and apply the Terraform participant-policy plan under the authorized process. Independently verify exact existing role paths/trust, current key policies and the actual SDK/device identities before enabling. Keep prior peer settings/source media and a separately reviewed return-to-peer plan. Metadata inspection and IAM apply do not prove codec/SDK/media readiness.

## Explicit enable and acceptance
After topology and retained-media owner review, an operator with separately approved UpdateMediaStorageConfiguration permission may run OPERATE.py --enable --confirm-topology-change --confirm-retained-media. It makes at most one update call with SDK retries disabled. Ambiguous errors require inspecting both directions before any manual retry; it never automatically unlinks/reassigns resources. Success is only an enable request receipt, not convergence or recording acceptance. Run read-only inspection again to confirm the same enabled pair, then separately configure approved peers and explicitly join storage sessions with the maintained SDK. No client endpoint discovery, ICE credentials or media join/upload occurs here.

Acceptance requires owner-approved synthetic audio/video, actual authorization/denial tests, retained media integrity/playback, key use, combined viewer-audio privacy, quotas, cost, network/relay behavior and records/retention evidence. Keep generated metadata/results free of content/tokens. Store actual media only in approved boundaries. This is an infrastructure/association workflow, not a finished device application or automatic media migration.

## Recovery
There is no automatic disable/unlink, session termination or retained-data deletion. Returning to direct peers requires a separately reviewed UpdateMediaStorageConfiguration DISABLED change and SDK/session transition; unlink before deleting either resource. Unlinking does not erase retained media. Removing these new IAM policies also does not guarantee immediate credential/session revocation. Coordinate owners, evidence retention and tested recovery before changing live peers.

https://docs.aws.amazon.com/kinesisvideostreams-webrtc-dg/latest/devguide/ingestion-grant-permission.html
https://docs.aws.amazon.com/kinesisvideostreams-webrtc-dg/latest/devguide/configure-ingestion.html
https://docs.aws.amazon.com/kinesisvideostreams/latest/APIReference/API_UpdateMediaStorageConfiguration.html
https://docs.aws.amazon.com/kinesisvideostreams/latest/APIReference/API_DescribeMappedResourceConfiguration.html
https://docs.aws.amazon.com/service-authorization/latest/reference/list_kinesis-video-streams.html
https://docs.aws.amazon.com/govcloud-us/latest/UserGuide/govcloud-kinesisvideo.html
`;
