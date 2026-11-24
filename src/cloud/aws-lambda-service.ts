import type {Blueprint,BlueprintInput} from '../kit/blueprint.ts';
import {error,type Finding} from '../core/findings.ts';
import {asRootModule} from '../terraform/layout.ts';
import {placementRegionOptions} from '../kit/placement-regions.ts';
import {validS3BucketName} from './aws-s3-service.ts';
const quote=(value:unknown)=>JSON.stringify(String(value??'')).replace(/\$\{/g,'$${').replace(/%\{/g,'%%{');
export const AWS_LAMBDA_SERVICE:Blueprint={
 id:'aws_service_lambda',label:'Set up a Lambda function',description:'Create a Lambda function from an existing S3 ZIP or ECR image, using an existing execution role, with explicit runtime, resource, logging and optional VPC settings.',emits:['aws_lambda_function','aws_cloudwatch_log_group'],
 inputs:[
  {id:'aws_region',label:'AWS region',control:'select',options:placementRegionOptions('aws'),blankLabel:'Select a region'},
  {id:'function_name',label:'Function name',control:'text'},
  {id:'package_type',label:'Deployment package',control:'select',default:'Zip',options:[{value:'Zip',label:'Existing ZIP object in S3'},{value:'Image',label:'Existing container image in ECR'}]},
  {id:'s3_bucket',label:'Code S3 bucket',control:'text',showWhen:{input:'package_type',equals:['Zip']},hint:'Existing code bucket in the same region as the function.'},
  {id:'s3_key',label:'Code ZIP object key',control:'text',showWhen:{input:'package_type',equals:['Zip']}},
  {id:'s3_version',label:'Code object version ID',control:'text',showWhen:{input:'package_type',equals:['Zip']},hint:'Optional, recommended to pin a versioned deployment artifact.'},
  {id:'runtime',label:'Runtime',control:'combo',default:'python3.13',options:[{value:'python3.13',label:'Python 3.13'},{value:'python3.12',label:'Python 3.12'},{value:'nodejs22.x',label:'Node.js 22'},{value:'java21',label:'Java 21'},{value:'dotnet8',label:'.NET 8'},{value:'provided.al2023',label:'Custom runtime — Amazon Linux 2023'}],showWhen:{input:'package_type',equals:['Zip']},hint:'Confirm runtime availability and lifecycle status before deployment.'},
  {id:'handler',label:'Handler / entry point',control:'text',default:'app.handler',showWhen:{input:'package_type',equals:['Zip']}},
  {id:'image_uri',label:'ECR image URI',control:'text',showWhen:{input:'package_type',equals:['Image']},hint:'Existing regional ECR repository image with a tag or digest, built for the selected architecture.'},
  {id:'architecture',label:'Processor architecture',control:'select',default:'x86_64',options:[{value:'x86_64',label:'x86-64'},{value:'arm64',label:'ARM64'}]},
  {id:'role_arn',label:'Existing execution role ARN',control:'text',hint:'Requires Lambda trust, CloudWatch Logs permissions, application permissions and VPC ENI permissions when VPC attachment is enabled.'},
  {id:'memory_mb',label:'Memory (MiB)',control:'number',default:512,min:128,max:10240},
  {id:'timeout_seconds',label:'Timeout (seconds)',control:'number',default:30,min:1,max:900},
  {id:'ephemeral_mb',label:'Temporary /tmp storage (MiB)',control:'number',default:512,min:512,max:10240},
  {id:'reserved_concurrency',label:'Reserved concurrency',control:'number',min:0,section:'Concurrency and logging',hint:'Blank uses the unreserved account pool. Zero disables invocation. Confirm account concurrency quotas.'},
  {id:'log_days',label:'Log retention (days)',control:'select',default:'30',options:[7,14,30,60,90,180,365].map(value=>({value:String(value),label:String(value)})),section:'Concurrency and logging'},
  {id:'vpc',label:'Function network',control:'select',default:'false',options:[{value:'false',label:'Default Lambda networking'},{value:'true',label:'Attach to existing VPC subnets'}]},
  {id:'subnet_ids',label:'Existing VPC subnet IDs',control:'text',showWhen:{input:'vpc',equals:['true']},hint:'Use subnets in the same VPC as the security groups; multiple AZs are recommended.'},
  {id:'security_group_ids',label:'Existing VPC security group IDs',control:'text',showWhen:{input:'vpc',equals:['true']}},
  {id:'environment_json',label:'Environment variables (JSON object)',control:'textarea',section:'Application settings',hint:'Optional string-to-string object. Values appear in Terraform state; retrieve application secrets through Secrets Manager or another approved runtime mechanism.'},
 ] satisfies readonly BlueprintInput[],
 build(values){const findings:Finding[]=[];
  if(!placementRegionOptions('aws').some(region=>region.value===values.aws_region))findings.push(error('aws.lambda.region','Select an AWS region.',{path:'aws_region'}));
  if(!/^[a-zA-Z0-9_-]{1,64}$/.test(String(values.function_name??'')))findings.push(error('aws.lambda.name','Enter a function name of 1–64 letters, digits, hyphens or underscores.',{path:'function_name'}));
  if(!/^arn:(aws|aws-us-gov|aws-cn|aws-eusc):iam::\d{12}:role\/.+$/.test(String(values.role_arn??'')))findings.push(error('aws.lambda.role','Enter the existing execution role ARN.',{path:'role_arn'}));
  const partition=String(values.aws_region).startsWith('us-gov-')?'aws-us-gov':String(values.aws_region).startsWith('cn-')?'aws-cn':String(values.aws_region).startsWith('eusc-')?'aws-eusc':'aws';
  if(values.role_arn&&!String(values.role_arn).startsWith('arn:'+partition+':'))findings.push(error('aws.lambda.partition','The role partition must match the selected region.',{path:'role_arn'}));
  const zip=values.package_type==='Zip';if(!['Zip','Image'].includes(String(values.package_type)))findings.push(error('aws.lambda.package','Select the package type.',{path:'package_type'}));
  if(zip){if(!validS3BucketName(String(values.s3_bucket??'')))findings.push(error('aws.lambda.bucket','Enter the existing code bucket name.',{path:'s3_bucket'}));if(!String(values.s3_key??'').trim())findings.push(error('aws.lambda.key','Enter the ZIP object key.',{path:'s3_key'}));if(!/^[a-z0-9][a-z0-9.]+$/.test(String(values.runtime??'')))findings.push(error('aws.lambda.runtime','Enter a Lambda runtime identifier.',{path:'runtime'}));if(!String(values.handler??'').trim())findings.push(error('aws.lambda.handler','Enter the package handler.',{path:'handler'}));}
  else if(!/^\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?\/.+(?::[^/]+|@sha256:[a-f0-9]{64})$/.test(String(values.image_uri??'')))findings.push(error('aws.lambda.image','Enter an ECR image URI with a tag or digest.',{path:'image_uri'}));
  if(!zip&&values.image_uri&&String(values.image_uri).split('.ecr.')[1]?.split('.amazonaws')[0]!==values.aws_region)findings.push(error('aws.lambda.image-region','The ECR image must be in the function region.',{path:'image_uri'}));
  if(!['x86_64','arm64'].includes(String(values.architecture)))findings.push(error('aws.lambda.architecture','Select an architecture.',{path:'architecture'}));
  const integer=(key:string,min:number,max:number)=>{const n=Number(values[key]);if(!Number.isInteger(n)||n<min||n>max)findings.push(error('aws.lambda.'+key,'Enter a whole number from '+min+' through '+max+'.',{path:key}));return n;};
  const memory=integer('memory_mb',128,10240),timeout=integer('timeout_seconds',1,900),ephemeral=integer('ephemeral_mb',512,10240),retention=integer('log_days',1,3653);
  let concurrency:number|undefined;if(values.reserved_concurrency!==undefined&&values.reserved_concurrency!=='')concurrency=integer('reserved_concurrency',0,1000000);
  const list=(key:string)=>[...new Set(String(values[key]??'').split(',').map(item=>item.trim()).filter(Boolean))];const subnets=list('subnet_ids'),groups=list('security_group_ids');
  if(values.vpc==='true'){if(!subnets.length||subnets.some(id=>!/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(id)))findings.push(error('aws.lambda.subnets','Enter existing subnet IDs.',{path:'subnet_ids'}));if(!groups.length||groups.some(id=>!/^sg-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(id)))findings.push(error('aws.lambda.groups','Enter existing security group IDs.',{path:'security_group_ids'}));}
  let environment:Record<string,string>={};
  if(String(values.environment_json??'').trim()){try{const parsed=JSON.parse(String(values.environment_json));if(!parsed||Array.isArray(parsed)||typeof parsed!=='object'||Object.entries(parsed).some(([key,value])=>!/^[A-Za-z][A-Za-z0-9_]+$/.test(key)||typeof value!=='string'))throw Error();environment=parsed;}catch{findings.push(error('aws.lambda.environment','Use a JSON object of valid environment-variable names and string values.',{path:'environment_json'}));}}
  const lines=['terraform {\n  required_providers {\n    aws = { source = "hashicorp/aws", version = "~> 5.0" }\n  }\n}', 'provider "aws" {\n  region = '+quote(values.aws_region)+'\n}',
   'resource "aws_cloudwatch_log_group" "function" {\n  name = '+quote('/aws/lambda/'+String(values.function_name))+'\n  retention_in_days = '+retention+'\n}',
   'resource "aws_lambda_function" "function" {\n'+[
    'function_name = '+quote(values.function_name),'role = '+quote(values.role_arn),'package_type = '+quote(values.package_type),
    ...(zip?['s3_bucket = '+quote(values.s3_bucket),'s3_key = '+quote(values.s3_key),...(values.s3_version?['s3_object_version = '+quote(values.s3_version)]:[]),'runtime = '+quote(values.runtime),'handler = '+quote(values.handler)]:['image_uri = '+quote(values.image_uri)]),
    'architectures = ['+quote(values.architecture)+']','memory_size = '+memory,'timeout = '+timeout,...(concurrency!==undefined?['reserved_concurrent_executions = '+concurrency]:[]),
    'ephemeral_storage { size = '+ephemeral+' }',...(values.vpc==='true'?['vpc_config {\n    subnet_ids = '+JSON.stringify(subnets)+'\n    security_group_ids = '+JSON.stringify(groups)+'\n  }']:[]),
    ...(Object.keys(environment).length?['environment {\n    variables = {\n'+Object.entries(environment).map(([key,value])=>'      '+quote(key)+' = '+quote(value)).join('\n')+'\n    }\n  }']:[]),'depends_on = [aws_cloudwatch_log_group.function]',
   ].map(line=>'  '+line).join('\n')+'\n}',
   'output "function_arn" { value = aws_lambda_function.function.arn }\noutput "function_name" { value = aws_lambda_function.function.function_name }',
  ];
  const guide='# Lambda function setup\n\nProvide a deployable ZIP already uploaded to S3 in this region, or a Lambda-compatible ECR image in this region. This export does not include your application artifact. Pin a ZIP object version or image digest for reproducibility. Verify the package architecture, handler and runtime lifecycle.\n\nThe existing execution role must trust Lambda and allow logging, application resource access, and VPC ENI management when selected. This package does not alter the existing role. A new log group is managed here; import an existing group before applying if the name already exists.\n\nRun terraform init, terraform validate and terraform plan -out=service.tfplan. Review the artifact, role, network, resource limits and environment values; apply the saved plan. Use aws lambda get-function-configuration to verify Active state and LastUpdateStatus Successful. Invoke with an application-appropriate test event and inspect the response and CloudWatch logs. Configure triggers, caller permissions, alarms and application secrets separately.\n\nA Lambda VPC attachment does not create inbound access or a public IP. If the function needs outbound internet or AWS APIs, provide appropriate NAT, VPC endpoints or IPv6 egress. Test application connectivity. For recovery, redeploy a previous pinned artifact and reviewed configuration. Published versions and aliases require their additional builders; unversioned code is not a rollback archive.\n\nReference: https://docs.aws.amazon.com/lambda/latest/dg/configuration-vpc.html\n';
  return asRootModule({files:{'main.tf':lines.join('\n\n')+'\n','SERVICE-SETUP.md':guide},findings});
 },
};
