import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultValues} from '../kit/blueprint.ts';
import {AWS_REDSHIFT_PROVISIONED_SERVICE as blueprint} from './aws-redshift-provisioned-service.ts';
import {addServicesFor} from './add-service-catalog.ts';
const kms='arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc';
const values={...defaultValues(blueprint),aws_region:'us-east-1',name:'warehouse',subnets:'subnet-0123456789abcdef0,subnet-0123456789abcdef1',clients:'sg-0123456789abcdef0',kms,secret_kms:kms,log_kms:kms};
test('Provisioned Redshift preserves Serverless, manages credentials without reading values and configures actual snapshot association',()=>{
  assert.equal(addServicesFor('aws').find(row=>row.id==='amazon-redshift')?.terraform[0],blueprint);
  assert.notEqual(addServicesFor('aws').find(row=>row.id==='redshift-serverless')?.terraform[0],blueprint);
  const result=blueprint.build(values);assert.deepEqual(result.findings,[]);
  const main=result.files['main.tf']!;
  assert.match(main,/manage_master_password\s+= true/);assert.match(main,/publicly_accessible\s+= false/);assert.match(main,/multi_az\s+= false/);
  assert.match(main,/aws_redshift_snapshot_schedule_association/);assert.match(main,/cron\(0 4,12,20 \*\)/);
  assert.match(main,/skip_final_snapshot\s+= false/);assert.match(main,/prevent_destroy\s+= true/);
  assert.match(main,/split\(":", group.arn\)\[4\]/);assert.doesNotMatch(main,/group.owner_id|\bmaster_password\s*=|aws_secretsmanager_secret_version/);
  assert.doesNotMatch(result.files['INSPECT.py']!,/get_secret_value\(|execute_statement\(|filter_log_events\(/);
});
test('Provisioned Redshift validates ownership, node/identifier bounds and snapshot/maintenance scheduling',()=>{
  for(const [key,value]of Object.entries({name:'bad--name',database:'template0',admin:'root',node:'unknown',count:1,kms:kms.replace('us-east-1','us-west-2'),secret_kms:kms.replace('123456789012','000000000000'),log_kms:'bad',frequency:0,backup_hour:'',maintenance_day:'bad',maintenance_hour:'4',retention:0,snapshots:0,subnets:'subnet-0123456789abcdef0',clients:'bad',aws_region:'us-gov-west-1'}))assert.ok(blueprint.build({...values,[key]:value}).findings.some(f=>f.path===key),key);
  for(const node of ['ra3.xlplus','ra3.4xlarge','ra3.16xlarge'])assert.deepEqual(blueprint.build({...values,node}).findings,[]);
  const rollover=blueprint.build({...values,frequency:'24',backup_hour:'4',maintenance_day:'sun',maintenance_hour:'23'});assert.deepEqual(rollover.findings,[]);
  assert.equal(JSON.parse(rollover.files['WAREHOUSE-CONFIG.json']!).maintenanceWindow,'sun:23:00-mon:00:00');
  assert.equal(JSON.parse(rollover.files['WAREHOUSE-CONFIG.json']!).snapshotDefinition,'cron(0 4 *)');
  assert.equal(JSON.parse(blueprint.build({...values,frequency:'8',backup_hour:'23'}).files['WAREHOUSE-CONFIG.json']!).snapshotDefinition,'cron(0 7,15,23 *)');
  assert.deepEqual(blueprint.build({...values,database:'dev',admin:'admin'}).findings,[]);
});
