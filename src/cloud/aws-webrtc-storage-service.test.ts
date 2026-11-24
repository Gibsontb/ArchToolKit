import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultValues} from '../kit/blueprint.ts';
import {AWS_WEBRTC_STORAGE_SERVICE as blueprint} from './aws-webrtc-storage-service.ts';
const values={...defaultValues(blueprint),aws_region:'us-east-1',account:'123456789012',name:'retained-peers',channel:'arn:aws:kinesisvideo:us-east-1:123456789012:channel/approved-peer/1234567890123',stream:'arn:aws:kinesisvideo:us-east-1:123456789012:stream/approved-video/1234567890123',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc',master:'arn:aws:iam::123456789012:role/PeerMaster',viewer:'arn:aws:iam::123456789012:role/PeerViewer',approved:true};
test('Storage preparation only grants scoped participant rights and exports a separately confirmed operator',()=>{
  const result=blueprint.build(values);assert.deepEqual(result.findings,[]);
  assert.match(result.files['main.tf']!,/JoinStorageSessionAsViewer/);
  assert.match(result.files['main.tf']!,/kinesisvideo:PutMedia/);
  assert.match(result.files['main.tf']!,/data.aws_iam_role.master.arn/);
  assert.doesNotMatch(result.files['main.tf']!,/UpdateMediaStorageConfiguration|local-exec|remote-exec|terraform_data|resource "aws_kinesis_video_stream"/);
  assert.match(result.files['OPERATE.py']!,/--confirm-topology-change/);
  assert.match(result.files['OPERATE.py']!,/--confirm-retained-media/);
  assert.doesNotMatch(result.files['OPERATE.py']!,/join_storage_session\(|get_ice_server_config\(|put_media\(/);
  assert.equal(JSON.parse(result.files['STORAGE-CONFIG.json']!).retention,24);
});
test('Storage preparation rejects unapproved, unretained, cross-boundary or merged actors',()=>{
  for(const[field,value]of Object.entries({approved:false,retention:0,viewer:values.master,channel:values.channel.replace('123456789012:','000000000000:'),stream:values.channel,kms:values.kms.replace('us-east-1','us-west-2'),aws_region:'us-gov-west-1',name:'bad name',account:'['}))assert.ok(blueprint.build({...values,[field]:value}).findings.some(f=>f.path===field),field);
});
