                                                                  
import {error,            } from '../core/findings.js';
import {parseCidr,formatCidr,containsAddress,broadcastAddress,cidrsOverlap} from '../core/net.js';
import {placementRegionOptions} from '../kit/placement-regions.js';
const quote=(value        )=>JSON.stringify(String(value??'')).replace(/\$\{/g,'$${').replace(/%\{/g,'%%{');
/** Extend the existing VPC builder with real AZ placement and private routing choices. */
export function vpcServiceForm(original          )          {
 const inputs                 =[
  {id:'aws_region',label:'AWS region',control:'select',options:placementRegionOptions('aws'),blankLabel:'Select a region'},
  {id:'name_prefix',label:'Network name',control:'text',default:'app-network'},
  {id:'vpc_cidr',label:'VPC IPv4 CIDR',control:'text',default:'10.20.0.0/16'},
  {id:'subnet1_cidr',label:'Public subnet A IPv4 CIDR',control:'text',default:'10.20.1.0/24'},
  {id:'subnet2_cidr',label:'Public subnet B IPv4 CIDR',control:'text',default:'10.20.2.0/24'},
  {id:'private_subnets',label:'Private application subnets',control:'select',default:'true',options:[{value:'true',label:'Create in both Availability Zones'},{value:'false',label:'Do not create private subnets'}]},
  {id:'private_a_cidr',label:'Private subnet A IPv4 CIDR',control:'text',default:'10.20.11.0/24',showWhen:{input:'private_subnets',equals:['true']}},
  {id:'private_b_cidr',label:'Private subnet B IPv4 CIDR',control:'text',default:'10.20.12.0/24',showWhen:{input:'private_subnets',equals:['true']}},
  {id:'nat_mode',label:'Private subnet outbound IPv4',control:'select',default:'none',options:[{value:'none',label:'No internet default route'},{value:'single',label:'One NAT gateway — shared across both AZs'},{value:'per-az',label:'One NAT gateway per AZ'}],showWhen:{input:'private_subnets',equals:['true']},hint:'NAT gateways incur hourly and data-processing charges. Shared NAT has one AZ dependency.'},
  {id:'enable_ipv6',label:'Dual stack (IPv6)',control:'select',default:'false',options:[{value:'false',label:'IPv4 only'},{value:'true',label:'AWS-assigned IPv6 /56 with /64 subnets'}]},
 ];
 return {id:'aws_service_vpc',label:'Set up a VPC network',description:'Create a VPC in two available AZs with public subnets and optional private subnets, NAT gateways and dual-stack routing. Extends the existing VPC builder.',inputs,emits:['aws_vpc','aws_subnet','aws_internet_gateway','aws_route_table','aws_route_table_association','aws_eip','aws_nat_gateway','aws_egress_only_internet_gateway'],
 build(values,name){
  const findings          =[];
  const vpc=parseCidr(String(values.vpc_cidr??''));
  const fields=['subnet1_cidr','subnet2_cidr',...(values.private_subnets==='true'?['private_a_cidr','private_b_cidr']:[])];
  const ranges=fields.map(key=>({key,range:parseCidr(String(values[key]??''))}));
  if(!vpc||vpc.prefix<16||vpc.prefix>28||formatCidr(vpc)!==String(values.vpc_cidr))findings.push(error('aws.vpc.cidr','Use a network-aligned IPv4 VPC CIDR from /16 through /28.',{path:'vpc_cidr'}));
  for(const {key,range} of ranges){
   if(!range||range.prefix<16||range.prefix>28||formatCidr(range)!==String(values[key]))findings.push(error('aws.vpc.subnet','Use a network-aligned IPv4 subnet CIDR from /16 through /28.',{path:key}));
   else if(vpc&&(!containsAddress(vpc,range.network)||!containsAddress(vpc,broadcastAddress(range))))findings.push(error('aws.vpc.outside','The subnet must fit inside the VPC CIDR.',{path:key}));
  }
  for(let i=0;i<ranges.length;i++)for(let j=i+1;j<ranges.length;j++)if(ranges[i] .range&&ranges[j] .range&&cidrsOverlap(ranges[i] .range ,ranges[j] .range ))findings.push(error('aws.vpc.overlap','Subnet ranges must not overlap.',{path:ranges[j] .key}));
  if(!placementRegionOptions('aws').some(region=>region.value===values.aws_region))findings.push(error('aws.vpc.region','Select an AWS region.',{path:'aws_region'}));
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/.test(String(values.name_prefix??'')))findings.push(error('aws.vpc.name','Enter a network name using letters, digits, periods, underscores or hyphens.',{path:'name_prefix'}));
  if(!['none','single','per-az'].includes(String(values.nat_mode??'none')))findings.push(error('aws.vpc.nat','Select an outbound IPv4 routing option.',{path:'nat_mode'}));
  const result=original.build(values,name);const files={...result.files};findings.push(...(result.findings??[]));
  let main='data "aws_availability_zones" "available" {\n  state = "available"\n  filter {\n    name = "zone-type"\n    values = ["availability-zone"]\n  }\n}\n\n'+files['main.tf'];
  main=main.replace(/(resource "aws_subnet" "public_a" \{)/,'$1\n  availability_zone = data.aws_availability_zones.available.names[0]');
  main=main.replace(/(resource "aws_subnet" "public_b" \{)/,'$1\n  availability_zone = data.aws_availability_zones.available.names[1]');
  const privateSubnets=values.private_subnets==='true',ipv6=values.enable_ipv6==='true';const nat=privateSubnets?String(values.nat_mode??'none'):'none';
  if(privateSubnets){
   if(ipv6)main+='\nresource "aws_egress_only_internet_gateway" "private" {\n  vpc_id = aws_vpc.this.id\n}\n';
   if(nat!=='none')main+='\nresource "aws_eip" "nat" {\n  count = '+(nat==='single'?1:2)+'\n  domain = "vpc"\n}\nresource "aws_nat_gateway" "private" {\n  count = '+(nat==='single'?1:2)+'\n  allocation_id = aws_eip.nat[count.index].id\n  subnet_id = [aws_subnet.public_a.id, aws_subnet.public_b.id][count.index]\n  depends_on = [aws_internet_gateway.this]\n}\n';
   for(const [index,suffix,field] of [[0,'a','private_a_cidr'],[1,'b','private_b_cidr']]         ){
    main+='\nresource "aws_subnet" "private_'+suffix+'" {\n  vpc_id = aws_vpc.this.id\n  availability_zone = data.aws_availability_zones.available.names['+index+']\n  cidr_block = '+quote(values[field])+'\n  map_public_ip_on_launch = false\n'+(ipv6?'  ipv6_cidr_block = cidrsubnet(aws_vpc.this.ipv6_cidr_block, 8, '+(index+2)+')\n  assign_ipv6_address_on_creation = true\n':'')+'  tags = { Name = '+quote(String(values.name_prefix)+'-private-'+suffix)+' }\n}\n';
    main+='\nresource "aws_route_table" "private_'+suffix+'" {\n  vpc_id = aws_vpc.this.id\n'+(nat!=='none'?'  route {\n    cidr_block = "0.0.0.0/0"\n    nat_gateway_id = aws_nat_gateway.private['+(nat==='single'?0:index)+'].id\n  }\n':'')+(ipv6?'  route {\n    ipv6_cidr_block = "::/0"\n    egress_only_gateway_id = aws_egress_only_internet_gateway.private.id\n  }\n':'')+'}\nresource "aws_route_table_association" "private_'+suffix+'" {\n  subnet_id = aws_subnet.private_'+suffix+'.id\n  route_table_id = aws_route_table.private_'+suffix+'.id\n}\n';
   }
  }
  files['main.tf']=main;
  files['providers.tf']='provider "aws" {\n  region = '+quote(values.aws_region)+'\n}\n';
  files['outputs.tf']='output "vpc_id" { value = aws_vpc.this.id }\noutput "public_subnet_ids" { value = [aws_subnet.public_a.id, aws_subnet.public_b.id] }\n'+(privateSubnets?'output "private_subnet_ids" { value = [aws_subnet.private_a.id, aws_subnet.private_b.id] }\n':'');
  files['SERVICE-SETUP.md']='# VPC network setup\n\nThis package creates a new VPC using the first two available standard Availability Zones, public subnets, and optional private subnets. At least two AZs must be available to the account. Check VPC/subnet, Elastic IP and NAT quotas and confirm CIDRs do not overlap connected corporate, VPN, peering or transit networks. PrivateLink endpoints, DNS integration, security groups, NACL policy and external connections are separate services.\n\nRun terraform init and terraform validate, then terraform plan -out=service.tfplan. Review AZ placement, CIDRs, public addressing, IPv6 and NAT cost/availability choices. Apply only the reviewed plan. Record VPC and subnet IDs for dependent service forms.\n\nVerify subnet AZs and route-table associations, public internet-gateway routes, and selected private NAT/IPv6 egress routes. Test outbound connectivity from an appropriately secured temporary workload; absence of an internet default route does not make a subnet isolated from other VPC or connected network routes. Test DNS and application paths.\n\nRemoving this network disrupts every dependent workload; remove dependencies and approve the network change first. Terraform state and exported configuration are not application backups.\n';
  return {files,findings};
 }};
}
