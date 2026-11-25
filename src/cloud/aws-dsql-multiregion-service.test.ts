import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultValues} from '../kit/blueprint.ts';
import {AWS_DSQL_MULTIREGION_SERVICE as blueprint} from './aws-dsql-multiregion-service.ts';
import {addServicesFor} from './add-service-catalog.ts';
const key=(region:string)=>'arn:aws:kms:'+region+':123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc';
const values={...defaultValues(blueprint),aws_region:'us-east-1',name:'reviewed-pair',account:'123456789012',kms:key('us-east-1'),peer_kms:key('us-west-2'),subnets:'subnet-12345678,subnet-abcdef12',clients:'sg-12345678',peer_subnets:'subnet-12345679,subnet-abcdef13',peer_clients:'sg-12345679',role:'arn:aws:iam::123456789012:role/application'};
test('DSQL pair preserves regional setup and emits reciprocal concurrent links with child provider declarations',()=>{
  assert.equal(addServicesFor('aws').find(row=>row.id==='amazon-aurora-dsql')?.terraform[1],blueprint);
  for(const aws_region of ['us-east-1','us-east-2','us-west-2'])for(const peer_region of ['us-east-1','us-east-2','us-west-2'].filter(region=>region!==aws_region)){
    const witness_region=['us-east-1','us-east-2','us-west-2'].find(region=>![aws_region,peer_region].includes(region))!;
    const result=blueprint.build({...values,aws_region,peer_region,witness_region,kms:key(aws_region),peer_kms:key(peer_region)});assert.deepEqual(result.findings,[]);
    assert.equal((result.files['main.tf']!.match(/resource "aws_dsql_cluster_peering"/g)||[]).length,2);
    assert.doesNotMatch(result.files['main.tf']!,/depends_on/);
    assert.match(result.files['primary/versions.tf']!,/configuration_aliases = \[aws.database\]/);
    for(const [site,region,peer]of [['primary',aws_region,peer_region],['secondary',peer_region,aws_region]]){
      assert.equal(result.files[site+'/providers.tf'],undefined);
      const config=JSON.parse(result.files[site+'/DSQL-CONFIG.json']!);assert.equal(config.region,region);assert.equal(config.peerRegion,peer);assert.equal(config.witnessRegion,witness_region);
      assert.match(result.files[site+'/main.tf']!,/multi_region_properties/);assert.match(result.files[site+'/INSPECT.py']!,/--peer-cluster/);
    }
    assert.match(result.files['MIGRATION-OPERATIONS.md']!,/Bootstrap SQL roles\/schema ONCE/);
    assert.doesNotMatch(result.files['main.tf']!,/aws_dsql_cluster_policy|local-exec/);
  }
});
test('DSQL pair rejects duplicate regions and peer key/network errors at the actual form fields',()=>{
  for(const override of [{peer_region:'us-east-1'},{witness_region:'us-east-1'},{peer_region:'us-west-1'},{peer_kms:key('us-east-1')},{peer_subnets:'bad'},{peer_clients:'bad'}])assert.ok(blueprint.build({...values,...override}).findings.length);
  assert.ok(blueprint.build({...values,peer_kms:key('us-east-1')}).findings.some(f=>f.path==='peer_kms'));
  assert.deepEqual(blueprint.build({...values,kms:'arn:aws:kms:us-east-1:123456789012:key/mrk-'+'a'.repeat(32),peer_kms:'arn:aws:kms:us-west-2:123456789012:key/mrk-'+'a'.repeat(32)}).findings,[]);
});
