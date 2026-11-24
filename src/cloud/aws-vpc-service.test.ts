import {test} from 'node:test';import assert from 'node:assert/strict';import {addServicesFor} from './add-service-catalog.ts';import {defaultValues} from '../kit/blueprint.ts';
const form=()=>addServicesFor('aws').find(row=>row.id==='amazon-virtual-private-cloud').terraform[0];const build=(extra={})=>form().build({...defaultValues(form()),aws_region:'us-east-1',...extra},'network');
test('VPC form reuses original network builder with actual AZs and private subnets',()=>{
 assert.equal(form().id,'aws_service_vpc');const result=build();assert.equal(result.findings.filter(f=>f.severity==='error').length,0);const code=result.files['main.tf'];for(const expected of ['aws_availability_zones','availability_zone = data.aws_availability_zones.available.names[1]','aws_subnet" "private_a','aws_route_table" "private_b'])assert.ok(code.includes(expected),expected);assert.ok(!code.includes('resource "aws_nat_gateway"'));
});
test('VPC form rejects overlapping, out-of-range and unaligned subnets',()=>{
 for(const extra of [{private_a_cidr:'10.20.1.0/24'},{private_a_cidr:'192.168.1.0/24'},{vpc_cidr:'10.20.0.1/16'},{subnet1_cidr:'10.20.1.0/30'}])assert.ok(build(extra).findings.some(f=>f.severity==='error'));
});
test('VPC per-AZ NAT and dual stack configure matched private routes without public-IP assignment',()=>{
 const result=build({nat_mode:'per-az',enable_ipv6:'true'});assert.equal(result.findings.filter(f=>f.severity==='error').length,0);const code=result.files['main.tf'];for(const expected of ['aws_nat_gateway','count = 2','nat_gateway_id = aws_nat_gateway.private[1].id','aws_egress_only_internet_gateway','cidrsubnet(aws_vpc.this.ipv6_cidr_block, 8, 3)','map_public_ip_on_launch = false'])assert.ok(code.includes(expected),expected);
 const publicOnly=build({private_subnets:'false',nat_mode:'per-az'});assert.ok(!publicOnly.files['main.tf'].includes('aws_nat_gateway'));assert.ok(!publicOnly.files['outputs.tf'].includes('private_subnet_ids'));
});
