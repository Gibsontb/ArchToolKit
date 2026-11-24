import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultValues} from '../kit/blueprint.ts';
import {AWS_ELASTICACHE_SERVERLESS_SERVICE as blueprint} from './aws-elasticache-serverless-service.ts';
import {AWS_ELASTICACHE_SERVICE} from './aws-elasticache-service.ts';
import {addServicesFor} from './add-service-catalog.ts';
const values={...defaultValues(blueprint),aws_region:'us-east-1',name:'application-cache',account:'123456789012',subnets:'subnet-0123456789abcdef0,subnet-0123456789abcdef1',clients:'sg-0123456789abcdef0',group:'application-group',user:'application-user',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc'};
test('Serverless cache uses customer key, dedicated TLS groups, bounded usage and protected snapshots',()=>{
  const forms=addServicesFor('aws').find(row=>row.id==='amazon-elasticache')!.terraform;
  assert.equal(forms[0],AWS_ELASTICACHE_SERVICE);assert.equal(forms[1],blueprint);
  const result=blueprint.build(values);assert.deepEqual(result.findings,[]);
  assert.match(result.files['main.tf']!,/resource "aws_elasticache_serverless_cache"/);
  assert.match(result.files['main.tf']!,/from_port\s+= 6379/);assert.match(result.files['main.tf']!,/to_port\s+= 6380/);
  assert.match(result.files['main.tf']!,/prevent_destroy\s+= true/);
  assert.match(result.files['main.tf']!,/cache_usage_limits/);
  assert.doesNotMatch(result.files['main.tf']!,/minimum\s+=/);
  assert.doesNotMatch(result.files['main.tf']!,/resource "aws_elasticache_user|auth_token|password|0\.0\.0\.0\/0|connection_type\s+=|network_type\s+=/);
  assert.doesNotMatch(result.files['CHECK.py']!,/redis\.Redis|redis\.RedisCluster|modify_user\(|create_user\(/);
});
test('Serverless profiles avoid incompatible engine/version pairs and preserve explicit caps',()=>{
  for(const[profile,engine,major]of [['valkey8','valkey','8'],['valkey7','valkey','7'],['redis7','redis','7']]){
    const result=blueprint.build({...values,profile});assert.deepEqual(result.findings,[]);
    const config=JSON.parse(result.files['CACHE-CONFIG.json']!);assert.equal(config.engine,engine);assert.equal(config.major,major);
  }
  for(const[field,value]of Object.entries({profile:'toString',storage_max:0,ecpu_max:999,snapshots:36,snapshot_time:'25:00',subnets:'subnet-bad',clients:'0.0.0.0/0',account:'[',kms:values.kms.replace('us-east-1','us-west-2'),aws_region:'us-gov-west-1'}))assert.ok(blueprint.build({...values,[field]:value}).findings.some(f=>f.path===field),field);
  assert.ok(blueprint.build({...values,prescale:true,storage_min:20,storage_max:10}).findings.some(f=>f.path==='storage_max'));
  assert.ok(blueprint.build({...values,prescale:true,ecpu_min:30000,ecpu_max:25000}).findings.some(f=>f.path==='ecpu_max'));
  assert.match(blueprint.build({...values,prescale:true}).files['main.tf']!,/minimum\s+= 1000/);
});
