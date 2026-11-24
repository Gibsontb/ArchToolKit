import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultValues} from '../kit/blueprint.ts';
import {AWS_WEBRTC_SERVICE as blueprint} from './aws-webrtc-service.ts';
import {addServicesFor} from './add-service-catalog.ts';
const values={...defaultValues(blueprint),aws_region:'us-east-1',name:'approved-peers',account:'123456789012',stack_role:'arn:aws:iam::123456789012:role/deploy/SignalingStack',master:'arn:aws:iam::123456789012:role/devices/PeerMaster',viewer:'arn:aws:iam::123456789012:role/apps/PeerViewer',approved:true};
test('WebRTC uses actual CloudFormation signaling infrastructure with retained resources and separate actor grants',()=>{
  assert.equal(addServicesFor('aws').find(row=>row.id==='amazon-kinesis-video-streams')?.terraform[1],blueprint);
  const result=blueprint.build(values);assert.deepEqual(result.findings,[]);
  const template=JSON.parse(result.files['SIGNALING.template.json']!);
  assert.equal(template.Resources.Channel.Type,'AWS::KinesisVideo::SignalingChannel');
  assert.equal(template.Resources.Channel.DeletionPolicy,'Retain');
  assert.equal(template.Resources.Channel.Properties.Type,'SINGLE_MASTER');
  assert.deepEqual(template.Outputs.ChannelArn.Value,{'Fn::GetAtt':['Channel','Arn']});
  assert.match(result.files['main.tf']!,/resource "aws_cloudformation_stack"/);
  assert.match(result.files['main.tf']!,/ConnectAsMaster/);assert.match(result.files['main.tf']!,/ConnectAsViewer/);
  assert.doesNotMatch(result.files['main.tf']!,/aws_kinesis_video_signaling_channel|PutMedia|GetMedia|kinesisvideo:\*|CAPABILITY_IAM/);
  assert.doesNotMatch(result.files['CHECK.py']!,/get_ice_server_config\(|get_signaling_channel_endpoint\(/);
});
test('WebRTC constrains roles, account, TTL and boundary approval',()=>{
  for(const[field,value]of Object.entries({approved:false,ttl:121,viewer:values.master,stack_role:values.stack_role.replace('123456789012','000000000000'),name:'not valid',account:'[',aws_region:'us-gov-west-1'}))assert.ok(blueprint.build({...values,[field]:value}).findings.some(f=>f.path===field),field);
  assert.deepEqual(blueprint.build({...values,ttl:5}).findings,[]);
  assert.deepEqual(blueprint.build({...values,ttl:120}).findings,[]);
});
