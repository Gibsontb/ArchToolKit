                                                                  
import {error,            } from '../core/findings.js';
import {asRootModule} from '../terraform/layout.js';
import {placementRegionOptions} from '../kit/placement-regions.js';

const quote=(value        )=>JSON.stringify(String(value??'')).replace(/\$\{/g,'$${').replace(/%\{/g,'%%{');
const options=(values                  )=>values.map(value=>({value,label:value}));
export const AWS_RDS_SERVICE          ={
 id:'aws_service_rds',label:'Set up an RDS database',description:'Create a PostgreSQL, MySQL or MariaDB DB instance with its subnet group, encrypted storage, managed credentials, availability and backup settings. Aurora, RDS Custom, replicas and other engines use separate resource builders.',
 emits:['aws_db_instance','aws_db_subnet_group'],
 inputs:[
  {id:'aws_region',label:'AWS region',control:'select',options:placementRegionOptions('aws'),blankLabel:'Select a region'},
  {id:'identifier',label:'Database instance identifier',control:'text',hint:'Lowercase letter first; letters, digits and single hyphens, up to 63 characters.'},
  {id:'engine',label:'Database engine',control:'select',default:'postgres',options:[{value:'postgres',label:'PostgreSQL'},{value:'mysql',label:'MySQL'},{value:'mariadb',label:'MariaDB'}]},
  {id:'engine_version',label:'Engine version',control:'text',hint:'Optional exact version available in the chosen region. Blank uses the AWS default; review the resolved version at plan/deployment.'},
  {id:'instance_class',label:'Database instance class',control:'combo',default:'db.t3.medium',options:options(['db.t3.medium','db.t3.large','db.t4g.medium','db.t4g.large','db.m6i.large','db.m6g.large','db.r6i.large','db.r6g.large']),hint:'Confirm the class supports the selected engine, version and region.'},
  {id:'database_name',label:'Initial database name',control:'text',hint:'Optional; letters and digits, starting with a letter. Use database-specific administration to create additional databases.'},
  {id:'username',label:'Master username',control:'text',default:'dbadmin',hint:'RDS generates the password in Secrets Manager. No password is written to this export.'},
  {id:'subnet_mode',label:'Database subnet group',control:'select',default:'new',options:[{value:'new',label:'Create from existing subnet IDs'},{value:'existing',label:'Use an existing DB subnet group'}]},
  {id:'subnet_ids',label:'Existing subnet IDs',control:'text',showWhen:{input:'subnet_mode',equals:['new']},hint:'At least two subnets in one VPC, covering different Availability Zones.'},
  {id:'subnet_group',label:'Existing DB subnet group name',control:'text',showWhen:{input:'subnet_mode',equals:['existing']}},
  {id:'security_group_ids',label:'Existing VPC security group IDs',control:'text',hint:'Groups must belong to the subnet VPC and permit the intended application connections.'},
  {id:'multi_az',label:'Availability',control:'select',default:'false',options:[{value:'false',label:'Single-AZ DB instance'},{value:'true',label:'Multi-AZ DB instance with standby'}]},
  {id:'public_access',label:'Publicly accessible',control:'select',default:'false',options:[{value:'false',label:'No — private endpoint'},{value:'true',label:'Yes — requires suitable subnet routing and security groups'}]},
  {id:'storage_gib',label:'Allocated storage (GiB)',control:'number',default:100,min:20,max:65536},
  {id:'storage_type',label:'Storage type',control:'select',default:'gp3',options:options(['gp3','gp2','io1','io2'])},
  {id:'iops',label:'Provisioned IOPS',control:'number',min:1000,showWhen:{input:'storage_type',equals:['io1','io2']},hint:'Required for provisioned-IOPS storage. Verify engine/storage-size IOPS limits.'},
  {id:'max_storage_gib',label:'Maximum autoscaled storage (GiB)',control:'number',section:'Storage and encryption',hint:'Blank disables storage autoscaling. If set, use at least 10% more than allocated storage.'},
  {id:'kms_key',label:'Storage KMS key ARN or ID',control:'text',section:'Storage and encryption',hint:'Storage encryption is enabled. Blank uses the AWS-managed RDS key.'},
  {id:'secret_kms_key',label:'Credentials secret KMS key ARN or ID',control:'text',section:'Storage and encryption',hint:'Optional key for the RDS-managed Secrets Manager secret.'},
  {id:'backup_days',label:'Automated backup retention (days)',control:'number',default:7,min:1,max:35,section:'Backups and maintenance'},
  {id:'backup_window',label:'Daily backup window (UTC)',control:'text',section:'Backups and maintenance',hint:'Optional HH:MM-HH:MM, at least 30 minutes. Leave blank for AWS to assign.'},
  {id:'maintenance_window',label:'Weekly maintenance window (UTC)',control:'text',section:'Backups and maintenance',hint:'Optional ddd:HH:MM-ddd:HH:MM; must not overlap the backup window.'},
  {id:'parameter_group',label:'Existing DB parameter group',control:'text',section:'Backups and maintenance',hint:'Optional; must match the chosen engine family and version.'},
  {id:'deletion_protection',label:'Deletion protection',control:'select',default:'true',options:[{value:'true',label:'Enabled'},{value:'false',label:'Disabled'}],section:'Backups and maintenance'},
  {id:'final_snapshot',label:'Final snapshot identifier',control:'text',section:'Backups and maintenance',hint:'Optional; defaults to database identifier plus -final. Must be available when the instance is removed. A final snapshot is required.'},
 ]                                    ,
 build(values){
  const findings          =[];
  const id=String(values.identifier??'');
  const validId=(value       )=>value.length<=63&&/^[a-z][a-z0-9-]*[a-z0-9]$|^[a-z]$/.test(value)&&!value.includes('--');
  if(!validId(id))findings.push(error('aws.rds.identifier','Enter a valid database identifier.',{path:'identifier'}));
  if(!placementRegionOptions('aws').some(region=>region.value===values.aws_region))findings.push(error('aws.rds.region','Select an AWS region.',{path:'aws_region'}));
  if(!['postgres','mysql','mariadb'].includes(String(values.engine)))findings.push(error('aws.rds.engine','Select a supported database engine.',{path:'engine'}));
  if(!/^db\.[a-z0-9-]+\.[a-z0-9]+$/.test(String(values.instance_class??'')))findings.push(error('aws.rds.class','Select a database instance class.',{path:'instance_class'}));
  const username=String(values.username??'');
  if(!/^[A-Za-z][A-Za-z0-9_]{0,15}$/.test(username)||['root','postgres','rdsadmin','mysql','mariadb'].includes(username.toLowerCase()))findings.push(error('aws.rds.username','Use a nonreserved master username beginning with a letter, at most 16 characters.',{path:'username'}));
  if(values.database_name&&!/^[A-Za-z][A-Za-z0-9]{0,62}$/.test(String(values.database_name)))findings.push(error('aws.rds.db-name','Use a database name beginning with a letter followed by letters or digits, at most 63 characters.',{path:'database_name'}));
  const list=(key       )=>String(values[key]??'').split(',').map(value=>value.trim()).filter(Boolean);
  const subnets=[...new Set(list('subnet_ids'))],groups=[...new Set(list('security_group_ids'))];
  const existing=values.subnet_mode==='existing';
  if(existing&&!/^[a-zA-Z][a-zA-Z0-9._ -]{0,254}$/.test(String(values.subnet_group??'')))findings.push(error('aws.rds.subnet-group','Enter the existing DB subnet group name.',{path:'subnet_group'}));
  if(!existing&&(subnets.length<2||subnets.some(id=>!/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(id))))findings.push(error('aws.rds.subnets','Enter at least two distinct existing subnet IDs.',{path:'subnet_ids'}));
  if(!groups.length||groups.some(id=>!/^sg-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(id)))findings.push(error('aws.rds.groups','Enter existing VPC security group IDs.',{path:'security_group_ids'}));
  const integer=(key       ,min       ,max       )=>{const n=Number(values[key]);if(!Number.isInteger(n)||n<min||n>max)findings.push(error('aws.rds.'+key,'Enter a whole number from '+min+' through '+max+'.',{path:key}));return n;};
  const size=integer('storage_gib',20,65536),backups=integer('backup_days',1,35);
  let iops                 ,maxStorage                 ;
  if(!['gp2','gp3','io1','io2'].includes(String(values.storage_type)))findings.push(error('aws.rds.storage-type','Select a storage type.',{path:'storage_type'}));
  if(['io1','io2'].includes(String(values.storage_type)))iops=integer('iops',1000,256000);
  if(values.max_storage_gib!==undefined&&values.max_storage_gib!==''){maxStorage=integer('max_storage_gib',20,65536);if(maxStorage<Math.ceil(size*1.1))findings.push(error('aws.rds.autoscaling','Autoscaling maximum must be at least 10% above allocated storage.',{path:'max_storage_gib'}));}
  const finalSnapshot=String(values.final_snapshot||id+'-final');if(!validId(finalSnapshot))findings.push(error('aws.rds.final-snapshot','Use a valid final snapshot identifier.',{path:'final_snapshot'}));
  if(values.backup_window&&!/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(String(values.backup_window)))findings.push(error('aws.rds.backup-window','Use a UTC HH:MM-HH:MM backup window.',{path:'backup_window'}));
  if(values.maintenance_window&&!/^(mon|tue|wed|thu|fri|sat|sun):([01]\d|2[0-3]):[0-5]\d-(mon|tue|wed|thu|fri|sat|sun):([01]\d|2[0-3]):[0-5]\d$/.test(String(values.maintenance_window)))findings.push(error('aws.rds.maintenance','Use a ddd:HH:MM-ddd:HH:MM UTC maintenance window.',{path:'maintenance_window'}));
  const main=[
   'terraform {\n  required_version = ">= 1.2.0"\n  required_providers {\n    aws = { source = "hashicorp/aws", version = "~> 5.0" }\n  }\n}',
   'provider "aws" {\n  region = '+quote(values.aws_region)+'\n}',
  ];
  if(!existing){main.push('data "aws_subnet" "selected" {\n  for_each = toset('+JSON.stringify(subnets)+')\n  id = each.value\n}');main.push('resource "aws_db_subnet_group" "database" {\n  name = '+quote(id+'-subnets')+'\n  subnet_ids = '+JSON.stringify(subnets)+'\n  lifecycle {\n    precondition {\n      condition = length(distinct([for subnet in data.aws_subnet.selected : subnet.vpc_id])) == 1 && length(distinct([for subnet in data.aws_subnet.selected : subnet.availability_zone])) >= 2\n      error_message = "Database subnets must share a VPC and cover at least two Availability Zones."\n    }\n  }\n}');}
  main.push('resource "aws_db_instance" "database" {\n'+[
   'identifier = '+quote(id),'engine = '+quote(values.engine),...(values.engine_version?['engine_version = '+quote(values.engine_version)]:[]),'instance_class = '+quote(values.instance_class),...(values.database_name?['db_name = '+quote(values.database_name)]:[]),
   'username = '+quote(username),'manage_master_user_password = true',...(values.secret_kms_key?['master_user_secret_kms_key_id = '+quote(values.secret_kms_key)]:[]),
   'db_subnet_group_name = '+(existing?quote(values.subnet_group):'aws_db_subnet_group.database.name'),'vpc_security_group_ids = '+JSON.stringify(groups),'multi_az = '+(values.multi_az==='true'),'publicly_accessible = '+(values.public_access==='true'),
   'allocated_storage = '+size,'storage_type = '+quote(values.storage_type),'storage_encrypted = true',...(values.kms_key?['kms_key_id = '+quote(values.kms_key)]:[]),...(iops!==undefined?['iops = '+iops]:[]),...(maxStorage!==undefined?['max_allocated_storage = '+maxStorage]:[]),
   'backup_retention_period = '+backups,...(values.backup_window?['backup_window = '+quote(values.backup_window)]:[]),...(values.maintenance_window?['maintenance_window = '+quote(values.maintenance_window)]:[]),...(values.parameter_group?['parameter_group_name = '+quote(values.parameter_group)]:[]),
   'deletion_protection = '+(values.deletion_protection!=='false'),'skip_final_snapshot = false','final_snapshot_identifier = '+quote(finalSnapshot),'copy_tags_to_snapshot = true','apply_immediately = false','tags = { Name = '+quote(id)+' }',
  ].map(line=>'  '+line).join('\n')+'\n}');
  main.push('output "database_endpoint" { value = aws_db_instance.database.endpoint }\noutput "database_arn" { value = aws_db_instance.database.arn }\noutput "master_secret_arn" { value = aws_db_instance.database.master_user_secret[0].secret_arn }');
  const guide='# RDS database instance setup\n\nThis form creates a PostgreSQL, MySQL or MariaDB instance. It does not configure Aurora, RDS Custom, other engines, read replicas or application schema migrations.\n\n1. Verify regional engine/version/class support, quotas, storage and IOPS combinations. Provide an existing DB subnet group or at least two subnets in one VPC and different Availability Zones. Existing security groups must belong to that VPC and allow the chosen database port from the application. Verify IAM, Secrets Manager and optional KMS permissions.\n2. Run terraform init, terraform validate and terraform plan -out=service.tfplan. Confirm the resolved engine version, network isolation, backup and retention choices; review before applying the saved plan.\n3. Run terraform apply service.tfplan. Inspect outputs and use aws rds describe-db-instances to verify the available status, encryption, AZ setup, backup retention and pending modifications.\n4. Retrieve credentials through the RDS-managed secret only with an authorized identity. Test encrypted database connectivity from the application network. Create application users with least privilege and apply the application database schema separately.\n5. Take and test a snapshot restore into a separate instance and verify application recovery. Point-in-time restore creates a new instance; plan endpoint changes. Deletion protection must be deliberately disabled before approved removal, and the final snapshot identifier must be unused. A Multi-AZ standby is not a backup.\n\nReferences: https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_CreateDBInstance.html and https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-secrets-manager.html\n';
  return asRootModule({files:{'main.tf':main.join('\n\n')+'\n','SERVICE-SETUP.md':guide},findings});
 },
};
