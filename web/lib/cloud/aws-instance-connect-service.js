import {error,            } from '../core/findings.js';
                                                   
import {blk,dat,hcl,jsonencode,output,res,x} from '../terraform/blueprints/migration/common.js';
import {awsServiceModule,awsServicePartition,awsServiceRegion} from './aws-service-module.js';
import {AWS_INSTANCE_CONNECT_CHECK} from './aws-instance-connect-files.js';

export const AWS_INSTANCE_CONNECT_SERVICE={
  id:'aws_service_instance_connect',label:'Set up a private IPv4 SSH or RDP endpoint',
  description:'Create an EC2 Instance Connect Endpoint with a dedicated endpoint security group and narrowly scoped tunnel permission on an existing operator role. No tunnel, login or key upload runs automatically.',
  emits:['aws_ec2_instance_connect_endpoint','aws_security_group','aws_iam_role_policy'],
  inputs:[awsServiceRegion,
    {id:'name',label:'Endpoint name',control:'text'},
    {id:'account',label:'AWS account ID',control:'text'},
    {id:'subnet',label:'Existing private IPv4 endpoint subnet',control:'text'},
    {id:'target_group',label:'Existing target-instance security group',control:'text',hint:'Owner must separately approve inbound traffic from the generated endpoint group. Existing shared rules are not modified.'},
    {id:'destination',label:'Allowed target private IPv4 address',control:'text',hint:'One exact private address; the generated tunnel policy restricts it to /32.'},
    {id:'protocol',label:'Administration protocol',control:'select',default:'SSH',options:[{value:'SSH',label:'SSH — TCP22'},{value:'RDP',label:'RDP — TCP3389'}]},
    {id:'duration',label:'Maximum tunnel duration (seconds)',control:'number',default:900,min:60,max:3600},
    {id:'role',label:'Existing operator IAM role ARN',control:'text',hint:'Attaches a named inline tunnel policy; no trust, login keys or other operator permissions are changed.'},
  ],
  build(values){
    const findings          =[],reject=(path       ,message       )=>findings.push(error('aws.instance-connect.'+path,message,{path}));
    const region=String(values.aws_region??''),partition=awsServicePartition(region),name=String(values.name??'').trim(),account=String(values.account??'').trim(),subnet=String(values.subnet??'').trim(),group=String(values.target_group??'').trim(),destination=String(values.destination??'').trim(),protocol=String(values.protocol??''),role=String(values.role??'').trim(),duration=Number(values.duration);
    if(partition!=='aws'&&partition!=='aws-us-gov')reject('aws_region','This bounded workflow supports commercial AWS and GovCloud; verify regional endpoint availability.');
    if(!/^[a-z][a-z0-9-]{1,39}$/.test(name))reject('name','Use2–40 lowercase letters, digits or hyphens, starting with a letter.');
    if(!/^\d{12}$/.test(account))reject('account','Enter the12-digit AWS account ID.');
    if(!/^subnet-[0-9a-f]{8,17}$/.test(subnet))reject('subnet','Enter an existing subnet ID.');
    if(!/^sg-[0-9a-f]{8,17}$/.test(group))reject('target_group','Enter the existing target security group ID.');
    const octets=destination.split('.').map(Number),validIp=/^\d+\.\d+\.\d+\.\d+$/.test(destination)&&octets.every((n,i)=>Number.isInteger(n)&&n>=0&&n<=255&&String(n)===destination.split('.')[i]);
    if(!validIp||!(octets[0]===10||(octets[0]===172&&octets[1] >=16&&octets[1] <=31)||(octets[0]===192&&octets[1]===168)))reject('destination','Enter one canonical RFC1918 private IPv4 address.');
    if(!['SSH','RDP'].includes(protocol))reject('protocol','Select SSH or RDP.');
    if(!Number.isInteger(duration)||duration<60||duration>3600)reject('duration','Use60–3600 whole seconds.');
    const roleMatch=/^arn:(aws|aws-us-gov):iam::(\d{12}):role\/[A-Za-z0-9_+=,.@/-]{1,512}$/.exec(role);
    if(!roleMatch||roleMatch[1]!==partition||roleMatch[2]!==account)reject('role','Select an existing role in this account and partition.');
    const port=protocol==='RDP'?3389:22,roleName=role.split('/').pop()??'',config={region,account,subnet,group,destination,port,duration,role};
    const policy={Version:'2012-10-17',Statement:[{Effect:'Allow',Action:['ec2-instance-connect:OpenTunnel'],Resource:x('aws_ec2_instance_connect_endpoint.private.arn'),Condition:{NumericEquals:{'ec2-instance-connect:remotePort':port},NumericLessThanEquals:{'ec2-instance-connect:maxTunnelDuration':duration},IpAddress:{'ec2-instance-connect:privateIpAddress':destination+'/32'}}}]};
    const built=awsServiceModule(region,[
      dat('aws_caller_identity','current',{}),dat('aws_subnet','endpoint',{id:subnet}),dat('aws_security_group','targets',{id:group}),
      res('aws_security_group','endpoint',{name:name+'-endpoint',description:'Dedicated outbound administration endpoint',vpc_id:x('data.aws_subnet.endpoint.vpc_id'),tags:x(hcl({Name:name}))},[
        blk('egress',{protocol:'tcp',from_port:port,to_port:port,security_groups:[group]}),
        blk('lifecycle',{},[blk('precondition',{condition:x('data.aws_caller_identity.current.account_id == '+JSON.stringify(account)+' && data.aws_subnet.endpoint.owner_id == '+JSON.stringify(account)+' && data.aws_subnet.endpoint.state == "available" && !data.aws_subnet.endpoint.ipv6_native && try(length(data.aws_subnet.endpoint.ipv6_cidr_block), 0) == 0 && !data.aws_subnet.endpoint.map_public_ip_on_launch && data.aws_subnet.endpoint.available_ip_address_count > 0 && split(":", data.aws_security_group.targets.arn)[4] == '+JSON.stringify(account)+' && data.aws_security_group.targets.vpc_id == data.aws_subnet.endpoint.vpc_id'),error_message:'Require this account available private IPv4 subnet with free addresses and same-VPC target group.'})]),
      ]),
      res('aws_ec2_instance_connect_endpoint','private',{subnet_id:subnet,security_group_ids:x('[aws_security_group.endpoint.id]'),preserve_client_ip:false,tags:x(hcl({Name:name}))},[blk('lifecycle',{prevent_destroy:true})]),
      res('aws_iam_role_policy','tunnel',{name:name+'-tunnel',role:roleName,policy:x(jsonencode(policy))}),
      output('instance_connect_endpoint','{ id = aws_ec2_instance_connect_endpoint.private.id, arn = aws_ec2_instance_connect_endpoint.private.arn, security_group = aws_security_group.endpoint.id, dns = aws_ec2_instance_connect_endpoint.private.dns_name, fips_dns = aws_ec2_instance_connect_endpoint.private.fips_dns_name }'),
    ],GUIDE,findings);
    built.files['CONNECTION-CONFIG.json']=JSON.stringify(config,null,2)+'\n';
    built.files['PREFLIGHT.py']=AWS_INSTANCE_CONNECT_CHECK;
    built.files['CHECK.py']=AWS_INSTANCE_CONNECT_CHECK;
    built.files['CONNECT-EXAMPLE.txt']='Explicit owner-run AWS CLI2 command; do not run until target, IAM, DNS, TLS, host identity and network review is complete.\naws ec2-instance-connect open-tunnel --region '+region+' --instance-connect-endpoint-id <reviewed-output-id> --private-ip-address '+destination+' --remote-port '+port+' --local-port '+(port===22?2222:13389)+' --max-tunnel-duration '+duration+'\nKeep the tunnel in the foreground; use an approved SSH/RDP client against the local port with separately managed OS credentials. No OS credential is generated.\n';
    return built;
  },
}                    ;
const GUIDE=`# Private administration endpoint

This IPv4 recipe creates a dedicated EC2 Instance Connect Endpoint and endpoint security group in an existing owned private subnet. It attaches one narrowly scoped OpenTunnel allow to an existing operator role. It does not create instances, upload SSH keys, change role trust, retrieve Windows passwords, open a tunnel or log into an OS. Existing role grants can permit more than this inline allow; review effective IAM/SCP/session policies independently.

## Prerequisites and owner decisions
Review exact account/region/VPC/subnet, allowed target private address and protocol, target inventory and role ownership. Confirm the target address is actually assigned to the intended instance in this VPC and that the selected group is attached to it. Terraform checks subnet/group ownership and VPC, not that address-to-instance relationship. Existing endpoint quotas are one per VPC/subnet and five per account/region; check the current regional quotas and existing endpoints before creating. Do not import, replace or delete a shared endpoint through this new-resource recipe.

Provider5 does not expose the newer endpoint IP-address-type option. Use an IPv4-only subnet (no IPv6 CIDR association), and verify the created endpoint is IPv4 before connection. Dual-stack/IPv6 and client-IP preservation require separate reviewed workflows. Subnet auto-public-address=false is not proof of private route tables; owners must validate routes, NACLs, target reachability, available IPs and intended region/AZ support. Dedicated endpoint group permits outbound only the selected TCP port to the target group; no inbound rule is needed for service-originated endpoint traffic. Owner must separately approve the target group's inbound rule from the generated endpoint group, without replacing shared rules. No default group or public ingress is added.

Review administrative access against the workload's classification and approved boundary, agency/DoD requirements as applicable, ATO/SSP scope, identity/MFA/session controls, audit evidence, STIG/SRG and cryptographic requirements. Endpoint FIPS DNS is output when offered; this does not configure or qualify the CLI, transport or module validation. GovCloud access is not an authorization or classification claim. Preserve audit evidence and verify CloudTrail coverage; a tunnel is not an OS session recording service.

## Read-only metadata checks
Use an approved current Python3/boto3/botocore environment. PREFLIGHT.py reads selected account/subnet/group, actual running target/interface/IP/group relationship and existing regional endpoints; it refuses VPC conflicts and incomplete paginated enumeration instead of adopting resources. CHECK.py reads reviewed Terraform output and validates actual endpoint ownership/configuration/state and the target group's owner-approved ingress. Neither script opens a tunnel, uploads keys, invokes SSH/RDP or changes AWS. Existing scoped metadata permissions are prerequisites; no broad Describe/admin policy is attached. These checks do not prove effective IAM, all security rules, NACL/routes, operating-system readiness, host identity, application authorization or cryptographic compliance. Confirm actual SSH server/Windows RDP service, host certificates/keys and OS access with owners.

## Deployment and explicit connection
Review generated Terraform and target network changes separately. Run init/validate, saved plan review and authorized apply. First creation can require the AWS service-linked role; deployer permissions are separate from the operator's OpenTunnel policy. Check actual endpoint ownership/VPC/subnet/groups, preserve-client-IP=false, IPv4 mode, endpoint state create-complete or update-complete, and DNS/FIPS requirements. Review all actual endpoint egress and target ingress rules. No local generated package is evidence of live connectivity.

The inline policy permits only this endpoint ARN, exact target /32, selected remote port and maximum duration. CONNECT-EXAMPLE.txt requires an explicit endpoint ID from reviewed outputs. AWS CLI2 needs compatible ec2-instance-connect open-tunnel support. Keep credentials under approved role/session management. A tunnel alone does not authenticate to SSH/RDP: use approved existing OS credentials, host-key/certificate verification and approved clients. SendSSHPublicKey is intentionally not granted; no ephemeral public key is uploaded. Close tunnel when done, validate access denial outside the selected port/address/duration, and record actual successful/denied tests with owners. No probe executes automatically.

## Lifecycle
Endpoint prevent_destroy is a Terraform guard, not a service-side lock or immediate session revocation. Existing sessions may persist until their bounded duration; test emergency revocation and OS access controls separately. Owner-reviewed rollback removes only newly managed endpoint/policy/group after confirming users and dependencies. Never remove shared target rules, roles or instances as incidental cleanup. Cross-AZ transfer, target compute and audit/storage costs may apply; validate current regional pricing.

References:
https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/create-ec2-instance-connect-endpoints.html
https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/eice-security-groups.html
https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/permissions-for-ec2-instance-connect-endpoint.html
https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/connect-using-eice.html
https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/eice-quotas.html
`;
