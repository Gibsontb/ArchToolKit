import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultValues} from '../kit/blueprint.ts';
import {AWS_ELASTICACHE_SHARDED_SERVICE as blueprint} from './aws-elasticache-sharded-service.ts';
const values={...defaultValues(blueprint),aws_region:'us-east-1',name:'application-shards',account:'123456789012',subnets:'subnet-0123456789abcdef0,subnet-0123456789abcdef1',clients:'sg-0123456789abcdef0',parameter_group:'approved-cluster-params',group:'application-group',user:'application-user',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc'};
test('Sharded cache uses separate shard/replica controls, cluster endpoint and required security',()=>{
  const result=blueprint.build(values);assert.deepEqual(result.findings,[]);
  const hcl=result.files['main.tf']!;
  assert.match(hcl,/cluster_mode\s+= "enabled"/);assert.match(hcl,/num_node_groups\s+= 2/);assert.match(hcl,/replicas_per_node_group\s+= 1/);
  assert.doesNotMatch(hcl,/num_cache_clusters|resource "aws_elasticache_user|resource "aws_elasticache_parameter_group|auth_token|0\.0\.0\.0\/0/);
  assert.match(hcl,/transit_encryption_mode\s+= "required"/);assert.match(hcl,/automatic_failover_enabled\s+= true/);
  assert.match(result.files['outputs.tf']!,/configuration_endpoint_address/);
  assert.match(result.files['SERVICE-SETUP.md']!,/ApplyImmediately=true/);
  assert.doesNotMatch(result.files['CHECK.py']!,/\.get\("CurrentRole"|get_password|modify_replication_group\(/);
});
test('Sharded engine families, optional versions and snapshot windows remain compatible',()=>{
  for(const profile of ['valkey7','valkey8','redis7'])assert.deepEqual(blueprint.build({...values,profile}).findings,[]);
  assert.deepEqual(blueprint.build({...values,profile:'valkey8',version:'8.2',snapshot_window:'23:30-00:30'}).findings,[]);
  for(const[field,value]of Object.entries({profile:'constructor',version:'8.0',shards:91,replicas:0,node_type:'cache.r6gd.large',snapshot_window:'02:00-02:30',parameter_group:'bad name',subnets:'bad',clients:'bad',account:'[',kms:values.kms.replace('us-east-1','us-west-2'),aws_region:'us-gov-west-1'}))assert.ok(blueprint.build({...values,[field]:value}).findings.some(f=>f.path===field),field);
});
