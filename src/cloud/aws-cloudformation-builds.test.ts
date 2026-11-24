import {test} from 'node:test';import assert from 'node:assert/strict';import {awsCloudFormationBuild} from './aws-cloudformation-builds.ts';import {cfnTypes} from '../editor/cloudformation-schema.ts';import {addServicesFor} from './add-service-catalog.ts';
test('every known AWS native service type opens its real writable schema',async()=>{
 const types=new Set(addServicesFor('aws').flatMap(row=>row.native));let loaded=0;
 for(const type of types){const build=awsCloudFormationBuild(type);if(!build)continue;await build.load();assert.ok(Array.isArray(build.inputs),type);assert.ok(build.inputs.every(input=>input.id),type);loaded++;}
 assert.ok(loaded>100);
});
test('CloudFormation required, nested and typed properties block invalid generation',async()=>{
 const build=awsCloudFormationBuild('AWS::SQS::Queue');await build.load();
 const valid=build.build({QueueName:'test-queue',FifoQueue:'false'},'test');assert.equal(valid.findings.filter(f=>f.severity==='error').length,0);assert.equal(JSON.parse(valid.files['template.json']).Resources.Service.Properties.FifoQueue,false);
 const invalid=build.build({VisibilityTimeout:'not-a-number'},'test');assert.ok(invalid.findings.some(f=>f.severity==='error'));
 const nested=awsCloudFormationBuild('AWS::EC2::Instance');await nested.load();assert.ok(nested.build({NetworkInterfaces:'[{"DeviceIndex":0,"UnknownField":true}]'},'test').findings.some(f=>f.severity==='error'));
 assert.equal(awsCloudFormationBuild('AWS::NotReal::Nope'),undefined);
});
