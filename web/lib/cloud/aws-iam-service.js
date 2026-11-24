import {awsIamPolicy} from '../editor/profiles/aws.js';
                                                                  
import {error,            } from '../core/findings.js';
import {asRootModule} from '../terraform/layout.js';
import {placementRegionOptions} from '../kit/placement-regions.js';
const quote=(value        )=>JSON.stringify(String(value??'')).replace(/\$\{/g,'$${').replace(/%\{/g,'%%{');
export const AWS_IAM_SERVICE          ={
 id:'aws_service_iam',label:'Set up an IAM identity or policy',description:'Configure an IAM role, user, group or managed policy with explicit trust and permissions. IAM scope is account/partition-wide; regional placement selects the correct AWS partition.',emits:['aws_iam_role','aws_iam_user','aws_iam_group','aws_iam_policy','aws_iam_role_policy','aws_iam_user_policy','aws_iam_group_policy','aws_iam_role_policy_attachment','aws_iam_user_policy_attachment','aws_iam_group_policy_attachment'],
 inputs:[
  {id:'aws_region',label:'AWS partition region',control:'select',options:placementRegionOptions('aws'),blankLabel:'Select a region'},
  {id:'kind',label:'IAM configuration',control:'select',default:'role',options:[{value:'role',label:'IAM role'},{value:'user',label:'IAM user — no access keys or password'},{value:'group',label:'IAM group'},{value:'policy',label:'Managed permissions policy'}]},
  {id:'name',label:'Identity / policy name',control:'text'},
  {id:'path',label:'IAM path',control:'text',default:'/'},
  {id:'trust_json',label:'Role trust policy (JSON)',control:'textarea',showWhen:{input:'kind',equals:['role']},hint:'Required: who can assume the role and under which conditions. This is separate from the permissions policy.'},
  {id:'max_session_seconds',label:'Maximum role session (seconds)',control:'number',default:3600,min:3600,max:43200,showWhen:{input:'kind',equals:['role']}},
  {id:'permissions_json',label:'Permissions policy (JSON)',control:'textarea',hint:'Required for a managed policy; optional inline policy for an identity. Supply the exact actions, resources and conditions.'},
  {id:'policy_arns',label:'Existing managed policy ARNs',control:'text',hint:'Optional comma-separated ARNs to attach to a role, user or group.',showWhen:{input:'kind',notEquals:['policy']}},
  {id:'permissions_boundary',label:'Existing permissions boundary policy ARN',control:'text',hint:'Optional boundary for a role or user; ignored for groups and managed policies.'},
 ]                                    ,
 build(values){const findings          =[];
  const kind=String(values.kind),name=String(values.name??''),path=String(values.path??'/');
  if(!['role','user','group','policy'].includes(kind))findings.push(error('aws.iam.kind','Select an IAM configuration type.',{path:'kind'}));
  const maximum=kind==='group'?128:kind==='policy'?128:64;
  if(!/^[A-Za-z0-9_+=,.@-]+$/.test(name)||name.length>maximum)findings.push(error('aws.iam.name','Enter an IAM name of 1–'+maximum+' supported characters.',{path:'name'}));
  if(path.length>512||!/^\/(?:[\x21-\x7e]*\/)?$/.test(path))findings.push(error('aws.iam.path','Use / or an IAM path beginning and ending with /.',{path:'path'}));
  if(!placementRegionOptions('aws').some(region=>region.value===values.aws_region))findings.push(error('aws.iam.region','Select a region in the intended partition.',{path:'aws_region'}));
  const partition=String(values.aws_region).startsWith('us-gov-')?'aws-us-gov':String(values.aws_region).startsWith('cn-')?'aws-cn':String(values.aws_region).startsWith('eusc-')?'aws-eusc':'aws';
  const readPolicy=(key       ,required        )=>{const raw=String(values[key]??'').trim();if(!raw){if(required)findings.push(error('aws.iam.policy-required','Supply the required JSON policy.',{path:key}));return undefined;}try{const document=JSON.parse(raw);if(!document||Array.isArray(document)||typeof document!=='object'||!document.Statement)throw Error();findings.push(...(awsIamPolicy.validate?.(document)??[]).map(finding=>({...finding,path:key+(finding.path?'.'+finding.path:'')})));return document;}catch{findings.push(error('aws.iam.policy-json','Supply a valid JSON policy object with Statement.',{path:key}));return undefined;}};
  const trust=kind==='role'?readPolicy('trust_json',true):undefined,permissions=readPolicy('permissions_json',kind==='policy');
  if(trust){const statements=Array.isArray(trust.Statement)?trust.Statement:[trust.Statement];if(!statements.some((statement                       )=>statement?.Principal&&statement?.Action))findings.push(error('aws.iam.trust','The trust policy requires a principal and assume-role action.',{path:'trust_json'}));}
  const policies=kind==='policy'?[]:[...new Set(String(values.policy_arns??'').split(',').map(arn=>arn.trim()).filter(Boolean))];
  const policyArn=(arn       )=>new RegExp('^arn:'+partition+':iam::(?:aws|[0-9]{12}):policy/.+$').test(arn);
  if(policies.some(arn=>!policyArn(arn)))findings.push(error('aws.iam.policy-arn','Managed policy ARNs must belong to the selected partition.',{path:'policy_arns'}));
  if(['role','user'].includes(kind)&&values.permissions_boundary&&!policyArn(String(values.permissions_boundary)))findings.push(error('aws.iam.boundary','Enter a policy ARN in the selected partition.',{path:'permissions_boundary'}));
  const duration=Number(values.max_session_seconds);if(kind==='role'&&(!Number.isInteger(duration)||duration<3600||duration>43200))findings.push(error('aws.iam.duration','Role sessions must be 3600–43200 seconds.',{path:'max_session_seconds'}));
  const resource='aws_iam_'+kind;const parts=['terraform {\n  required_providers {\n    aws = { source = "hashicorp/aws", version = "~> 5.0" }\n  }\n}\nprovider "aws" {\n  region = '+quote(values.aws_region)+'\n}'];
  parts.push('resource "'+resource+'" "configured" {\n  name = '+quote(name)+'\n  path = '+quote(path)+'\n'+(kind==='role'?'  assume_role_policy = '+quote(JSON.stringify(trust??{}))+'\n  max_session_duration = '+duration+'\n':'')+(kind==='policy'?'  policy = '+quote(JSON.stringify(permissions??{}))+'\n':'')+(['role','user'].includes(kind)&&values.permissions_boundary?'  permissions_boundary = '+quote(values.permissions_boundary)+'\n':'')+'}');
  if(kind!=='policy'){
   if(permissions)parts.push('resource "aws_iam_'+kind+'_policy" "inline" {\n  name = '+quote(name+'-permissions')+'\n  '+kind+' = '+resource+'.configured.name\n  policy = '+quote(JSON.stringify(permissions))+'\n}');
   if(policies.length)parts.push('resource "aws_iam_'+kind+'_policy_attachment" "managed" {\n  for_each = toset('+JSON.stringify(policies)+')\n  '+kind+' = '+resource+'.configured.name\n  policy_arn = each.value\n}');
  }
  parts.push('output "configured_arn" { value = '+resource+'.configured.arn }');
  const guide='# IAM configuration\n\nVerify account/partition, identity naming and the exact trust and permission model. Role trust controls who can assume a role; permission policies control what its sessions can do. Review principals, actions, resources, conditions and boundaries with the application owner before deployment. This form does not generate passwords, access keys, group memberships, instance profiles, federation providers or Identity Center configuration.\n\nRun terraform init, terraform validate and terraform plan -out=service.tfplan. Review additions and attachments, then apply the saved plan using an authorized identity. Verify the created identity/policy and attached policies using IAM APIs. Test only approved actions using the intended principal and verify that denied actions remain denied. Role propagation can take time.\n\nFor EC2, create an instance profile for the role with the existing profile builder before attaching it to a server. For Lambda/ECS, use the role ARN and correct service trust. An IAM user created here has no login or programmatic credential. A group has no members until membership is configured. Attach or use a managed policy explicitly; creating it alone grants nothing.\n\nPreserve an independent administrative recovery path. Remove application dependencies and assess permissions before changing trust, replacing policies or deleting identities. Terraform rollback is not a recovery mechanism for deleted credentials.\n\nReference: https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies.html\n';
  return asRootModule({files:{'main.tf':parts.join('\n\n')+'\n','SERVICE-SETUP.md':guide},findings});
 },
};
