import {test} from 'node:test';import assert from 'node:assert/strict';import {AWS_RDS_SERVICE} from './aws-rds-service.ts';import {defaultValues} from '../kit/blueprint.ts';import {addServicesFor} from './add-service-catalog.ts';
const valid=()=>({...defaultValues(AWS_RDS_SERVICE),aws_region:'us-east-1',identifier:'app-database',subnet_ids:'subnet-1234abcd,subnet-abcd1234',security_group_ids:'sg-1234abcd'});
const build=(extra={})=>AWS_RDS_SERVICE.build({...valid(),...extra},'database');
test('RDS service form builds a database with managed credentials and subnet constraints',()=>{
 assert.equal(addServicesFor('aws').find(row=>row.id==='amazon-relational-database-service').terraform[0],AWS_RDS_SERVICE);
 const result=build();assert.equal(result.findings.filter(f=>f.severity==='error').length,0);const code=Object.values(result.files).join('\n');
 for(const expected of ['manage_master_user_password = true','aws_db_subnet_group','subnet.availability_zone','publicly_accessible = false','storage_encrypted = true','skip_final_snapshot = false','deletion_protection = true','backup_retention_period = 7'])assert.ok(code.includes(expected),expected);
 assert.ok(!/^\s*password\s*=/m.test(code));assert.ok(result.files['SERVICE-SETUP.md'].includes('snapshot restore'));
});
test('RDS setup rejects invalid dependencies, storage and identifiers',()=>{
 for(const [extra,path] of [[{subnet_ids:'subnet-1234abcd'},'subnet_ids'],[{security_group_ids:''},'security_group_ids'],[{identifier:'bad--id'},'identifier'],[{backup_days:0},'backup_days'],[{storage_gib:100,max_storage_gib:105},'max_storage_gib'],[{storage_type:'io1',iops:''},'iops'],[{username:'rdsadmin'},'username']])assert.ok(build(extra).findings.some(f=>f.severity==='error'&&f.path===path),path);
});
test('RDS existing subnet group and MySQL HA selections flow into exported configuration',()=>{
 const result=build({engine:'mysql',subnet_mode:'existing',subnet_group:'existing-db-subnets',subnet_ids:'',multi_az:'true',instance_class:'db.m6i.large',engine_version:'8.0',storage_type:'io2',iops:3000,storage_gib:100,max_storage_gib:200});
 assert.equal(result.findings.filter(f=>f.severity==='error').length,0);const code=result.files['main.tf'];assert.ok(code.includes('db_subnet_group_name = "existing-db-subnets"'));assert.ok(code.includes('multi_az = true'));assert.ok(code.includes('iops = 3000'));assert.ok(!code.includes('resource "aws_db_subnet_group"'));
});
