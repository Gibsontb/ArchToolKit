                                                                  
import {error,             } from '../core/findings.js';
import {asRootModule} from '../terraform/layout.js';
import {placementRegionOptions} from '../kit/placement-regions.js';

const quote=(value        )=>JSON.stringify(String(value??'')).replace(/\$\{/g,'$${').replace(/%\{/g,'%%{');
const options=(values                  )=>values.map(value=>({value,label:value}));
export function validS3BucketName(value       )        {
 return value.length>=3&&value.length<=63&&/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value)&&!value.includes('..')&&!/^\d+\.\d+\.\d+\.\d+$/.test(value)&&!['xn--','sthree-','amzn-s3-demo-'].some(prefix=>value.startsWith(prefix))&&!['-s3alias','--ol-s3','.mrap','--x-s3','--table-s3','-an'].some(suffix=>value.endsWith(suffix));
}
/** General-purpose S3 bucket setup; existing resource builders remain available separately. */
export const AWS_S3_SERVICE          ={
 id:'aws_service_s3',label:'Set up an S3 bucket',description:'Configure a private general-purpose S3 bucket with encryption, versioning, retention, lifecycle and optional access logging. This form creates storage, not a server.',
 emits:['aws_s3_bucket','aws_s3_bucket_public_access_block','aws_s3_bucket_ownership_controls','aws_s3_bucket_versioning','aws_s3_bucket_server_side_encryption_configuration','aws_s3_bucket_policy','aws_s3_bucket_object_lock_configuration','aws_s3_bucket_lifecycle_configuration','aws_s3_bucket_logging'],
 inputs:[
  {id:'aws_region',label:'AWS region',control:'select',options:placementRegionOptions('aws'),blankLabel:'Select a region'},
  {id:'bucket_name',label:'Bucket name',control:'text',hint:'3–63 lowercase letters, digits, dots or hyphens. Must be unique within the AWS partition.'},
  {id:'versioning',label:'Object versioning',control:'select',default:'Enabled',options:options(['Enabled','Suspended'])},
  {id:'encryption',label:'Default encryption',control:'select',default:'AES256',options:[{value:'AES256',label:'SSE-S3 — S3-managed keys'},{value:'aws:kms',label:'SSE-KMS — AWS KMS key'},{value:'aws:kms:dsse',label:'DSSE-KMS — dual-layer KMS encryption'}]},
  {id:'kms_key',label:'KMS key ARN or ID',control:'text',showWhen:{input:'encryption',equals:['aws:kms','aws:kms:dsse']},hint:'Blank uses the AWS-managed S3 KMS key; a customer key must be usable in this region.'},
  {id:'bucket_key',label:'Use an S3 Bucket Key',control:'select',default:'true',options:[{value:'true',label:'Enabled'},{value:'false',label:'Disabled'}],showWhen:{input:'encryption',equals:['aws:kms']}},
  {id:'lock_mode',label:'Default Object Lock retention',control:'select',default:'none',options:[{value:'none',label:'No default retention'},{value:'GOVERNANCE',label:'Governance retention'},{value:'COMPLIANCE',label:'Compliance retention'}],hint:'Requires versioning. Compliance retention cannot be shortened or bypassed for a protected object version.'},
  {id:'lock_days',label:'Default retention (days)',control:'number',default:30,min:1,max:36500,showWhen:{input:'lock_mode',equals:['GOVERNANCE','COMPLIANCE']}},
  {id:'transition_class',label:'Lifecycle storage transition',control:'select',default:'none',options:[{value:'none',label:'No storage transition'},{value:'STANDARD_IA',label:'Standard-Infrequent Access'},{value:'ONEZONE_IA',label:'One Zone-Infrequent Access'},{value:'INTELLIGENT_TIERING',label:'Intelligent-Tiering'},{value:'GLACIER_IR',label:'Glacier Instant Retrieval'},{value:'GLACIER',label:'Glacier Flexible Retrieval'},{value:'DEEP_ARCHIVE',label:'Glacier Deep Archive'}],section:'Lifecycle'},
  {id:'transition_days',label:'Transition current objects after (days)',control:'number',default:30,min:1,showWhen:{input:'transition_class',notEquals:['none']},section:'Lifecycle',hint:'Storage class minimum duration charges and small-object transition rules still apply.'},
  {id:'expire_days',label:'Expire current objects after (days)',control:'number',min:1,section:'Lifecycle',hint:'Blank retains current objects. In a versioned bucket expiration creates delete markers; it does not remove old versions.'},
  {id:'noncurrent_days',label:'Expire noncurrent versions after (days)',control:'number',min:1,section:'Lifecycle',hint:'Blank retains noncurrent versions. This permanently removes eligible old versions after their retention permits it.'},
  {id:'abort_days',label:'Abort incomplete multipart uploads after (days)',control:'number',default:7,min:1,section:'Lifecycle'},
  {id:'logging',label:'Server access logging',control:'select',default:'false',options:[{value:'false',label:'Disabled'},{value:'true',label:'Use an existing logging bucket'}],section:'Access logging'},
  {id:'log_bucket',label:'Existing logging bucket name',control:'text',showWhen:{input:'logging',equals:['true']},section:'Access logging',hint:'Must be a different eligible bucket in the same account and region with the required log delivery permissions.'},
  {id:'log_prefix',label:'Log object prefix',control:'text',default:'access-logs/',showWhen:{input:'logging',equals:['true']},section:'Access logging'},
  {id:'environment',label:'Environment tag',control:'select',default:'dev',options:options(['dev','test','stage','prod']),section:'Tags and protection'},
  {id:'prevent_destroy',label:'Protect bucket from Terraform destruction',control:'select',default:'true',options:[{value:'true',label:'Enabled'},{value:'false',label:'Disabled'}],section:'Tags and protection'},
 ]                                    ,
 build(values){
  const findings          =[];
  const bucket=String(values.bucket_name??'');
  if(!validS3BucketName(bucket))findings.push(error('aws.s3.name','Enter a valid general-purpose bucket name without reserved prefixes or suffixes.',{path:'bucket_name'}));
  if(!placementRegionOptions('aws').some(region=>region.value===values.aws_region))findings.push(error('aws.s3.region','Select an AWS region.',{path:'aws_region'}));
  const allowed=(key       ,list                  )=>{if(!list.includes(String(values[key]??'')))findings.push(error('aws.s3.'+key,'Choose a valid '+key.replaceAll('_',' ')+'.',{path:key}));};
  allowed('versioning',['Enabled','Suspended']);allowed('encryption',['AES256','aws:kms','aws:kms:dsse']);allowed('lock_mode',['none','GOVERNANCE','COMPLIANCE']);allowed('transition_class',['none','STANDARD_IA','ONEZONE_IA','INTELLIGENT_TIERING','GLACIER_IR','GLACIER','DEEP_ARCHIVE']);
  const days=(key       ,required=false,min=1,max=2147483647)                 =>{const raw=values[key];if(raw===undefined||raw===''){if(required)findings.push(error('aws.s3.'+key,'Enter a whole number of days.',{path:key}));return undefined;}const n=Number(raw);if(!Number.isInteger(n)||n<min||n>max){findings.push(error('aws.s3.'+key,'Enter a whole number from '+min+' through '+max+'.',{path:key}));return undefined;}return n;};
  const lock=values.lock_mode!=='none';const lockDays=lock?days('lock_days',true,1,36500):undefined;
  if(lock&&values.versioning!=='Enabled')findings.push(error('aws.s3.lock-versioning','Enable versioning to use Object Lock.',{path:'versioning'}));
  const transition=values.transition_class!=='none';
  const transitionDays=transition?days('transition_days',true,['STANDARD_IA','ONEZONE_IA'].includes(String(values.transition_class))?30:1):undefined;
  const expiration=days('expire_days'),noncurrent=days('noncurrent_days'),abort=days('abort_days');
  if(transitionDays!==undefined&&expiration!==undefined&&expiration<=transitionDays)findings.push(error('aws.s3.expiration-order','Object expiration must occur after the configured storage transition.',{path:'expire_days'}));
  if(values.logging==='true'&&(!validS3BucketName(String(values.log_bucket??''))||values.log_bucket===bucket))findings.push(error('aws.s3.logging','Choose a different valid existing logging bucket.',{path:'log_bucket'}));
  const main=[
   'terraform {\n  required_providers {\n    aws = { source = "hashicorp/aws", version = "~> 5.0" }\n  }\n}',
   'provider "aws" {\n  region = '+quote(values.aws_region)+'\n}',
   'resource "aws_s3_bucket" "storage" {\n  bucket = '+quote(bucket)+'\n  force_destroy = false\n'+(lock?'  object_lock_enabled = true\n':'')+'  tags = { Name = '+quote(bucket)+', Environment = '+quote(values.environment)+' }\n  lifecycle { prevent_destroy = '+(values.prevent_destroy!=='false')+' }\n}',
   'resource "aws_s3_bucket_public_access_block" "storage" {\n  bucket = aws_s3_bucket.storage.id\n  block_public_acls = true\n  block_public_policy = true\n  ignore_public_acls = true\n  restrict_public_buckets = true\n}',
   'resource "aws_s3_bucket_ownership_controls" "storage" {\n  bucket = aws_s3_bucket.storage.id\n  rule { object_ownership = "BucketOwnerEnforced" }\n}',
   'resource "aws_s3_bucket_versioning" "storage" {\n  bucket = aws_s3_bucket.storage.id\n  versioning_configuration { status = '+quote(values.versioning)+' }\n}',
   'resource "aws_s3_bucket_server_side_encryption_configuration" "storage" {\n  bucket = aws_s3_bucket.storage.id\n  rule {\n    apply_server_side_encryption_by_default {\n      sse_algorithm = '+quote(values.encryption)+'\n'+(values.encryption!=='AES256'&&values.kms_key?'      kms_master_key_id = '+quote(values.kms_key)+'\n':'')+'    }\n'+(values.encryption==='aws:kms'?'    bucket_key_enabled = '+(values.bucket_key==='true')+'\n':'')+'  }\n}',
   'resource "aws_s3_bucket_policy" "transport" {\n  bucket = aws_s3_bucket.storage.id\n  policy = jsonencode({\n    Version = "2012-10-17"\n    Statement = [{\n      Sid = "DenyInsecureTransport"\n      Effect = "Deny"\n      Principal = "*"\n      Action = "s3:*"\n      Resource = [aws_s3_bucket.storage.arn, "\u0024{aws_s3_bucket.storage.arn}/*"]\n      Condition = { Bool = { "aws:SecureTransport" = "false", "aws:PrincipalIsAWSService" = "false" } }\n    }]\n  })\n}',
  ];
  if(lock)main.push('resource "aws_s3_bucket_object_lock_configuration" "storage" {\n  bucket = aws_s3_bucket.storage.id\n  rule {\n    default_retention {\n      mode = '+quote(values.lock_mode)+'\n      days = '+(lockDays??1)+'\n    }\n  }\n  depends_on = [aws_s3_bucket_versioning.storage]\n}');
  if(transition||expiration!==undefined||noncurrent!==undefined||abort!==undefined)main.push('resource "aws_s3_bucket_lifecycle_configuration" "storage" {\n  bucket = aws_s3_bucket.storage.id\n  rule {\n    id = "configured-lifecycle"\n    status = "Enabled"\n    filter {}\n'+(transition?'    transition {\n      days = '+(transitionDays??1)+'\n      storage_class = '+quote(values.transition_class)+'\n    }\n':'')+(expiration!==undefined?'    expiration { days = '+expiration+' }\n':'')+(noncurrent!==undefined?'    noncurrent_version_expiration { noncurrent_days = '+noncurrent+' }\n':'')+(abort!==undefined?'    abort_incomplete_multipart_upload { days_after_initiation = '+abort+' }\n':'')+'  }\n  depends_on = [aws_s3_bucket_versioning.storage]\n}');
  if(values.logging==='true')main.push('resource "aws_s3_bucket_logging" "storage" {\n  bucket = aws_s3_bucket.storage.id\n  target_bucket = '+quote(values.log_bucket)+'\n  target_prefix = '+quote(values.log_prefix)+'\n}');
  main.push('output "bucket_name" { value = aws_s3_bucket.storage.id }\noutput "bucket_arn" { value = aws_s3_bucket.storage.arn }\noutput "bucket_region" { value = aws_s3_bucket.storage.region }');
  const guide='# S3 general-purpose bucket setup\n\nThis package creates a private bucket and its selected controls. It does not create EC2 servers, logging destination buckets, KMS keys, replication destinations or application IAM permissions.\n\n1. Confirm the bucket name is available in the selected partition, regional service availability, IAM permissions, data location and handling requirements. If selected, qualify the existing KMS key and logging destination in the same region.\n2. Run terraform init, terraform validate, then terraform plan -out=service.tfplan. Review encryption, Object Lock retention and lifecycle deletion choices.\n3. Apply the reviewed plan with terraform apply service.tfplan. Record bucket outputs and the applied state securely.\n4. Verify bucket location, get-public-access-block, get-bucket-encryption, get-bucket-versioning and the optional get-object-lock-configuration, get-bucket-lifecycle-configuration and get-bucket-logging through the S3 API/CLI. Test upload/download with the intended application identity and verify unauthorized/public access is denied.\n5. Configure application IAM policies, monitoring and backup/replication separately as required. Restore versioned objects by recovering their previous versions. Suspended versioning does not preserve new overwritten objects. Compliance retention is irreversible for already protected versions until expiry; retention and deletion protection are not backups.\n\nReference: https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html\nReference: https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html\n';
  return asRootModule({files:{'main.tf':main.join('\n\n')+'\n','SERVICE-SETUP.md':guide},findings});
 },
};
