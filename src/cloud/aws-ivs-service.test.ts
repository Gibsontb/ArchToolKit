import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultValues} from '../kit/blueprint.ts';
import {AWS_IVS_SERVICE as blueprint} from './aws-ivs-service.ts';
import {addServicesFor} from './add-service-catalog.ts';
const values={...defaultValues(blueprint),aws_region:'us-east-1',name:'approved-video',account:'123456789012',playback_key:'arn:aws:ivs:us-east-1:123456789012:playback-key/AbCdEf-123456',distribution:true};
test('IVS channel is authorized, unrecorded, and exports metadata checks without secret retrieval',()=>{
  assert.equal(addServicesFor('aws').find(row=>row.id==='amazon-interactive-video-service')?.terraform[0],blueprint);
  const result=blueprint.build(values);assert.deepEqual(result.findings,[]);
  assert.match(result.files['main.tf']!,/authorized\s+= true/);
  assert.match(result.files['main.tf']!,/recording_configuration_arn\s+= ""/);
  assert.match(result.files['main.tf']!,/prevent_destroy\s+= true/);
  assert.doesNotMatch(Object.values(result.files).join('\n'),/get_stream_key\(|create_stream_key\(|BEGIN PRIVATE KEY|aws_ivs_playback_key_pair/);
  assert.match(result.files['CHECK.py']!,/get_playback_key_pair/);
  assert.match(result.files['CHECK.py']!,/insecureIngest/);
});
test('IVS variants retain authorization and reject unapproved delivery or mismatched keys/regions',()=>{
  for(const type of ['BASIC','STANDARD'])for(const latency of ['LOW','NORMAL'])assert.deepEqual(blueprint.build({...values,type,latency}).findings,[]);
  for(const [field,value]of Object.entries({distribution:false,aws_region:'us-gov-west-1',playback_key:values.playback_key.replace('123456789012','000000000000'),type:'ADVANCED_HD',latency:'INVALID',account:'[',name:'sensitive name'}))assert.ok(blueprint.build({...values,[field]:value}).findings.some(f=>f.path===field),field);
});
test('Recording attaches only an explicitly approved existing regional destination',()=>{
  const recording={...values,recording:'EXISTING',recording_arn:'arn:aws:ivs:us-east-1:123456789012:recording-configuration/AbCdEf-123456',recording_bucket:'approved-recordings',recording_approved:true};
  const result=blueprint.build(recording);assert.deepEqual(result.findings,[]);
  assert.match(result.files['main.tf']!,/recording-configuration\/AbCdEf-123456/);
  assert.doesNotMatch(result.files['main.tf']!,/resource "aws_s3_bucket|resource "aws_ivs_recording_configuration/);
  assert.ok(blueprint.build({...recording,recording_approved:false}).findings.some(f=>f.path==='recording_approved'));
  assert.ok(blueprint.build({...recording,recording_arn:recording.recording_arn.replace('us-east-1','us-west-2')}).findings.some(f=>f.path==='recording_arn'));
  assert.equal(JSON.parse(blueprint.build({...recording,recording:'NONE'}).files['CHANNEL-CONFIG.json']!).recordingArn,'');
});
