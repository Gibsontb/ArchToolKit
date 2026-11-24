import type {Blueprint,BlueprintInput} from '../kit/blueprint.ts';
import {error, type Finding} from '../core/findings.ts';
import {placementRegionOptions} from '../kit/placement-regions.ts';
import {sources} from '../terraform/blueprints/dual-stack.ts';

const quote=(value:unknown)=>JSON.stringify(String(value??'')).replace(/\$\{/g,'$${').replace(/%\{/g,'%%{');
/** Service-specific setup, using the existing EC2 builder's provider/root layout. */
export function ec2ServiceForm(original:Blueprint):Blueprint{
 const type=original.inputs.find(input=>input.id==='instance_type')!;
 const inputs:BlueprintInput[]=[
  {id:'aws_region',label:'AWS region',control:'select',options:placementRegionOptions('aws'),blankLabel:'Select a region'},
  {id:'instance_name',label:'Server name',control:'text',default:'app-01'},
  {id:'image_source',label:'Operating system / image',control:'select',default:'al2023',options:[{value:'al2023',label:'Amazon Linux 2023'},{value:'windows2022',label:'Windows Server 2022'},{value:'custom',label:'Existing custom or marketplace AMI'}]},
  {id:'architecture',label:'Processor architecture',control:'select',default:'x86_64',options:[{value:'x86_64',label:'x86-64'},{value:'arm64',label:'ARM64 / Graviton'}],showWhen:{input:'image_source',equals:['al2023']}},
  {...type,label:'Server instance type',section:undefined},
  {id:'ami_id',label:'AMI ID',control:'text',showWhen:{input:'image_source',equals:['custom']},hint:'AMI must exist in the selected region and match the instance architecture.'},
  {id:'subnet_id',label:'Existing subnet ID',control:'text',hint:'The subnet supplies the VPC; it must exist in the selected account and region.'},
  {id:'security_mode',label:'Security groups',control:'select',default:'new',options:[{value:'new',label:'Create a dedicated security group'},{value:'existing',label:'Use existing security groups'}]},
  {id:'security_group_ids',label:'Existing security group IDs',control:'text',hint:'Comma-separated IDs from the subnet VPC.',showWhen:{input:'security_mode',equals:['existing']}},
  {id:'admin_access',label:'Administrative access',control:'select',default:'none',options:[{value:'none',label:'No inbound administration'},{value:'ssh',label:'SSH from approved CIDRs'},{value:'rdp',label:'RDP from approved CIDRs'}],showWhen:{input:'security_mode',equals:['new']}},
  {id:'admin_cidrs',label:'Approved administration CIDRs',control:'text',showWhen:{input:'admin_access',equals:['ssh','rdp']},hint:'Comma-separated IPv4 or IPv6 ranges.'},
  {id:'key_name',label:'Existing EC2 key pair',control:'text',section:'Identity and startup',hint:'Required by your guest access method when using SSH keys or decrypting a Windows password.'},
  {id:'instance_profile',label:'Existing IAM instance profile',control:'text',section:'Identity and startup',hint:'For Session Manager, supply a profile with the required permissions and ensure SSM network access.'},
  {id:'public_ip',label:'Assign public IPv4 address',control:'select',default:'false',options:[{value:'false',label:'No'},{value:'true',label:'Yes'}]},
  {id:'root_gib',label:'Root disk size (GiB)',control:'number',default:30,min:8,hint:'At least the selected AMI root snapshot size.'},
  {id:'root_type',label:'Root disk type',control:'select',default:'gp3',options:[{value:'gp3',label:'gp3'},{value:'gp2',label:'gp2'}]},
  {id:'kms_key',label:'Root disk KMS key ARN or ID',control:'text',section:'Storage and protection',hint:'Blank uses the account EBS encryption key. Root disk encryption is enabled.'},
  {id:'delete_root',label:'Delete root disk when server is terminated',control:'select',default:'false',options:[{value:'false',label:'Retain root disk'},{value:'true',label:'Delete root disk'}],section:'Storage and protection'},
  {id:'protect',label:'Protect against accidental termination',control:'select',default:'true',options:[{value:'true',label:'Enabled'},{value:'false',label:'Disabled'}],section:'Storage and protection'},
 ];
 return {id:'aws_service_ec2',label:'Set up an EC2 server',description:'Configure one EC2 server, its operating system, subnet, security, identity and root disk. Uses the existing EC2 Terraform provider and root-module layout.',emits:['aws_instance','aws_security_group'],inputs,
 build(values,name){
  const findings:Finding[]=[];
  const required=(key:string,pattern:RegExp,message:string)=>{if(!pattern.test(String(values[key]??'')))findings.push(error('aws.ec2.'+key,message,{path:key}));};
  required('subnet_id',/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/,'Enter an existing subnet ID.');
  required('instance_name',/^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,127}$/,'Enter a server name.');
  required('instance_type',/^[a-z0-9][a-z0-9-]*\.[a-z0-9-]+$/,'Select an EC2 instance type.');
  if(!placementRegionOptions('aws').some(region=>region.value===values.aws_region))findings.push(error('aws.ec2.region','Select an AWS region.',{path:'aws_region'}));
  const os=String(values.image_source??'');
  if(!['al2023','windows2022','custom'].includes(os))findings.push(error('aws.ec2.os','Select an operating system / image.',{path:'image_source'}));
  if(os==='custom')required('ami_id',/^ami-(?:[a-f0-9]{8}|[a-f0-9]{17})$/,'Enter an AMI ID from the selected region.');
  const disk=Number(values.root_gib);
  if(!Number.isInteger(disk)||disk<8||disk>16384)findings.push(error('aws.ec2.root','Root disk must be an integer from 8 through 16384 GiB.',{path:'root_gib'}));
  if(os==='windows2022'&&disk<30)findings.push(error('aws.ec2.windows-disk','Windows Server requires at least 30 GiB; verify the AMI snapshot size.',{path:'root_gib'}));
  const existing=values.security_mode==='existing';
  const ids=String(values.security_group_ids??'').split(',').map(id=>id.trim()).filter(Boolean);
  if(existing&&(!ids.length||ids.some(id=>!/^sg-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(id))))findings.push(error('aws.ec2.security-groups','Enter existing security group IDs.',{path:'security_group_ids'}));
  const admin=existing?'none':String(values.admin_access??'none');
  const cidrs=sources(admin==='none'?'':values.admin_cidrs,'admin_cidrs','aws.ec2');
  if(admin!=='none'){
   findings.push(...cidrs.findings);
   if(!cidrs.v4.length&&!cidrs.v6.length)findings.push(error('aws.ec2.admin-cidrs','Enter the approved administration CIDRs.',{path:'admin_cidrs'}));
  }
  const base=original.build({...values,allow_ssh_cidr:'10.0.0.0/8',ipv6_address_count:'0',vpc_security_group_name:'ec2-service'},name);
  const files={...base.files};
  const parameter=os==='windows2022'?'/aws/service/ami-windows-latest/Windows_Server-2022-English-Full-Base':'/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-'+(values.architecture==='arm64'?'arm64':'x86_64');
  const image=os==='custom'?quote(values.ami_id):'data.aws_ssm_parameter.image.value';
  const port=admin==='rdp'?3389:22;
  files['main.tf']=[
   'data "aws_subnet" "selected" {\n  id = '+quote(values.subnet_id)+'\n}',
   ...(os==='custom'?[]:['data "aws_ssm_parameter" "image" {\n  name = '+quote(parameter)+'\n}']),
   ...(existing?[]:['resource "aws_security_group" "server" {\n  name_prefix = '+quote(String(values.instance_name)+'-')+'\n  vpc_id = data.aws_subnet.selected.vpc_id\n'+
    (admin==='none'?'':'  ingress {\n    protocol = "tcp"\n    from_port = '+port+'\n    to_port = '+port+'\n    cidr_blocks = '+JSON.stringify(cidrs.v4)+'\n    ipv6_cidr_blocks = '+JSON.stringify(cidrs.v6)+'\n  }\n')+
    '  egress {\n    protocol = "-1"\n    from_port = 0\n    to_port = 0\n    cidr_blocks = ["0.0.0.0/0"]\n  }\n}']),
   'resource "aws_instance" "server" {\n  ami = '+image+'\n  instance_type = '+quote(values.instance_type)+'\n  subnet_id = data.aws_subnet.selected.id\n  vpc_security_group_ids = '+(existing?JSON.stringify(ids):'[aws_security_group.server.id]')+'\n  associate_public_ip_address = '+(values.public_ip==='true')+'\n  disable_api_termination = '+(values.protect!=='false')+'\n'+
   (values.key_name?'  key_name = '+quote(values.key_name)+'\n':'')+(values.instance_profile?'  iam_instance_profile = '+quote(values.instance_profile)+'\n':'')+
   '  metadata_options {\n    http_tokens = "required"\n  }\n  root_block_device {\n    volume_size = '+disk+'\n    volume_type = '+quote(values.root_type)+'\n    encrypted = true\n    delete_on_termination = '+(values.delete_root==='true')+'\n'+(values.kms_key?'    kms_key_id = '+quote(values.kms_key)+'\n':'')+'  }\n  tags = { Name = '+quote(values.instance_name)+' }\n}',
  ].join('\n\n')+'\n';
  files['providers.tf']='provider "aws" {\n  region = '+quote(values.aws_region)+'\n}\n';
  files['variables.tf']='';files['terraform.tfvars.example']='# All server settings are supplied through the service form.\n';
  files['outputs.tf']='output "instance_id" { value = aws_instance.server.id }\noutput "private_ip" { value = aws_instance.server.private_ip }\noutput "public_ip" { value = aws_instance.server.public_ip }\n';
  files['README.md']='# EC2 server deployment\n\nRun terraform init, terraform validate, terraform plan -out=service.tfplan, review the plan, then terraform apply service.tfplan.\n\nPrerequisites: an existing subnet and sufficient capacity in the chosen region; existing security groups must belong to its VPC. Confirm image/instance architecture, root snapshot size, marketplace subscriptions and IAM/KMS permissions before applying. Public SSM image parameters resolve during plan; review and apply the saved plan to use that image. Session Manager requires an appropriate instance profile, agent and network access.\n\nVerify the instance reaches running, system and instance checks pass, its address is reachable through the chosen network, and guest services function. Configure backups separately; root disk retention is not backup.\n';
  return {files,findings};
 }};
}
