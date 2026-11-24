import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultValues} from '../kit/blueprint.ts';
import {AWS_KINESIS_VIDEO_SERVICE as blueprint} from './aws-kinesis-video-service.ts';
import {addServicesFor} from './add-service-catalog.ts';
const values={...defaultValues(blueprint),aws_region:'us-east-1',name:'approved-video',account:'123456789012',device:'camera-lab',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc',producer:'arn:aws:iam::123456789012:role/devices/VideoProducer',consumer:'arn:aws:iam::123456789012:role/apps/VideoConsumer',approved:true};
test('Kinesis Video creates keyed stream and separates scoped producer/consumer policies',()=>{
  assert.equal(addServicesFor('aws').find(row=>row.id==='amazon-kinesis-video-streams')?.terraform[0],blueprint);
  const result=blueprint.build(values);assert.deepEqual(result.findings,[]);
  assert.match(result.files['main.tf']!,/kinesisvideo:PutMedia/);
  assert.match(result.files['main.tf']!,/kms:GenerateDataKey/);
  assert.match(result.files['main.tf']!,/kms:Decrypt/);
  assert.match(result.files['main.tf']!,/kms:ViaService/);
  assert.doesNotMatch(result.files['main.tf']!,/kinesisvideo:\*|kms:\*|GetHLSStreamingSessionURL|aws_iam_role"|aws_kms_key" "new/);
  assert.match(result.files['main.tf']!,/name_prefix/);
  assert.doesNotMatch(result.files['CHECK.py']!,/get_media\(|put_media\(|get_hls_streaming_session_url\(/);
});
test('Live buffering and retained playback have distinct permissions and retention requirements',()=>{
  assert.deepEqual(blueprint.build({...values,retention:0}).findings,[]);
  const archived=blueprint.build({...values,consumer_mode:'ARCHIVE'});assert.deepEqual(archived.findings,[]);
  assert.match(archived.files['main.tf']!,/GetHLSStreamingSessionURL/);
  assert.ok(blueprint.build({...values,consumer_mode:'ARCHIVE',retention:0}).findings.some(f=>f.path==='retention'));
  for(const[field,value]of Object.entries({approved:false,retention:87601,consumer:values.producer,producer:values.producer.replace('123456789012','000000000000'),kms:values.kms.replace('us-east-1','us-west-2'),device:'bad name',account:'[',consumer_mode:'ALL',aws_region:'us-gov-west-1'}))assert.ok(blueprint.build({...values,[field]:value}).findings.some(f=>f.path===field),field);
  assert.deepEqual(blueprint.build({...values,name:'a'.repeat(256)}).findings,[]);
});
