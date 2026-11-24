import {test} from 'node:test';import assert from 'node:assert/strict';
import {addServicesFor} from './add-service-catalog.ts';import {awsServiceDelivery} from './aws-service-delivery.ts';
test('AWS product choices wire specific original resources without unrelated products',async()=>{
 for(const [name,id] of [['Amazon Aurora','res_aws_rds_cluster'],['Amazon RDS Proxy','res_aws_db_proxy'],['Amazon FSx for Lustre','res_aws_fsx_lustre_file_system'],['Amazon OpenSearch Serverless','res_aws_opensearchserverless_collection'],['Amazon VPC IP Address Manager (IPAM)','res_aws_vpc_ipam']]){
 const row=addServicesFor('aws').find(row=>row.name===name);assert.ok(row,name);const build=row.terraform.find(build=>build.id===id);assert.ok(build,id);assert.ok(build.load||build.inputs.length>0,id+' configurable resource schema');
 }
 const fsx=addServicesFor('aws').find(row=>row.name==='Amazon FSx for Lustre');assert.ok(!fsx.terraform.some(build=>/ontap|openzfs/.test(build.id)));
});
test('AWS implementation documents preserve region/account and require reviewing saved plan',()=>{
 const text=awsServiceDelivery({service:'Amazon S3',region:'us-gov-west-1',account:'123456789012',engine:'terraform',files:{'main.tf':''}});
 for(const expected of ['us-gov-west-1','123456789012','aws sts get-caller-identity','terraform validate','terraform show service.tfplan','terraform apply service.tfplan','does not prompt again','not a data backup'])assert.ok(text.includes(expected),expected);
 assert.ok(!text.includes('-auto-approve'));assert.ok(!text.includes('terraform destroy'));
});
