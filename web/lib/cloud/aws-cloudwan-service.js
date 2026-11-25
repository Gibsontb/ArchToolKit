                                                   
import {error,            } from '../core/findings.js';
import {blk,dat,hcl,jsonencode,output,res,x} from '../terraform/blueprints/migration/common.js';
import {awsServiceModule,awsServiceRegion} from './aws-service-module.js';
import {cloudWanInspection} from './aws-cloudwan-files.js';

const regions=['us-east-1','us-east-2','us-west-1','us-west-2'];
const attached={input:'attachment',equals:['vpc']};
export const AWS_CLOUDWAN_SERVICE={
  id:'aws_service_cloudwan_isolated_core',label:'Create a Cloud WAN core with isolated segments and a staged VPC attachment',
  description:'New global/core network, reviewed regional edges and isolated segments. Optional existing private IPv4 VPC attachment requires separate acceptance; existing VPC routes remain owner-managed.',
  emits:['aws_networkmanager_global_network','aws_networkmanager_core_network','aws_networkmanager_core_network_policy_attachment','aws_networkmanager_vpc_attachment'],
  inputs:[awsServiceRegion,{id:'name',label:'New network name',control:'text'},
    {id:'account',label:'Expected owner account ID',control:'text'},
    {id:'edges',label:'Core network edge regions',control:'checklist',default:'us-east-1',options:regions.map(value=>({value,label:value})),hint:'Each selected edge has a recurring cost. Management metadata is aggregated in us-west-2.'},
    {id:'asn_start',label:'Unused private ASN range start',control:'number',default:64520,min:64512,max:65534},
    {id:'asn_end',label:'Unused private ASN range end',control:'number',default:64529,min:64512,max:65534},
    {id:'segments',label:'Isolated segment names',control:'text',default:'prod,shared',hint:'1–8 comma-separated names. No cross-segment sharing or same-segment attachment communication is enabled.'},
    {id:'attachment',label:'Initial attachment',control:'select',default:'none',options:[{value:'none',label:'Core and policy only'},{value:'vpc',label:'Stage one existing private IPv4 VPC'}]},
    {id:'segment',label:'VPC segment',control:'combo',default:'prod',options:[{value:'prod',label:'prod'},{value:'shared',label:'shared'}],showWhen:attached},
    {id:'vpc',label:'Existing owned VPC ID',control:'text',showWhen:attached},
    {id:'subnets',label:'Existing attachment subnet IDs',control:'text',showWhen:attached,hint:'2–4 private subnets, one per Availability Zone in the selected VPC region; attachment allocation uses subnet addresses.'},
  ],
  build(values)                                    {
    const findings          =[],reject=(path       ,message       )=>findings.push(error('aws.cloudwan.'+path,message,{path}));
    const region=String(values.aws_region??''),name=String(values.name??'').trim(),account=String(values.account??'').trim();
    const list=(key       )=>String(values[key]??'').split(',').map(value=>value.trim()).filter(Boolean);
    const edges=list('edges'),segments=list('segments'),start=Number(values.asn_start),end=Number(values.asn_end),attachment=String(values.attachment??''),vpc=String(values.vpc??'').trim(),subnets=list('subnets'),segment=String(values.segment??'').trim(),hasVpc=attachment==='vpc';
    if(!regions.includes(region))reject('aws_region','Initial scope is the four US commercial regions; other partitions require separate qualification.');
    if(!/^[a-z][a-z0-9-]{1,38}[a-z0-9]$/.test(name))reject('name','Use3–40 lowercase letters, digits and internal hyphens.');
    if(!/^\d{12}$/.test(account))reject('account','Use the12-digit network and VPC owner account.');
    if(!edges.length||edges.some(edge=>!regions.includes(edge))||new Set(edges).size!==edges.length)reject('edges','Select unique supported US commercial edges.');
    if(!Number.isInteger(start)||!Number.isInteger(end)||start<64512||end>65534||end<start||end-start+1<edges.length)reject('asn_start','Choose an unused16-bit private ASN pool with at least one ASN per edge. Edge ASNs cannot later be changed.');
    if(!segments.length||segments.length>8||new Set(segments).size!==segments.length||segments.some(value=>! /^[a-z][a-z0-9_]{0,62}$/.test(value)||value==='bootstrap'))reject('segments','Use1–8 unique lowercase alphanumeric/underscore segment names beginning with a letter; bootstrap is reserved.');
    if(!['none','vpc'].includes(attachment))reject('attachment','Select core only or a staged VPC attachment.');
    if(hasVpc){
      if(!edges.includes(region))reject('edges','The VPC region must be explicitly selected as an edge.');
      if(!segments.includes(segment))reject('segment','Choose one of the configured segment names.');
      if(!/^vpc-(?:[0-9a-f]{8}|[0-9a-f]{17})$/.test(vpc))reject('vpc','Use the existing owned VPC ID.');
      if(subnets.length<2||subnets.length>4||new Set(subnets).size!==subnets.length||subnets.some(value=>!/^subnet-(?:[0-9a-f]{8}|[0-9a-f]{17})$/.test(value)))reject('subnets','Use2–4 unique existing subnet IDs, one per distinct AZ.');
    }
    const coreConfig={'asn-ranges':[`${start}-${end}`],'edge-locations':edges.map(location=>({location}))};
    const policy={version:'2021.12','core-network-configuration':coreConfig,segments:segments.map(name=>({name,'isolate-attachments':true,'require-attachment-acceptance':true})),
      'attachment-policies':segments.flatMap((name,si)=>edges.map((edge,ei)=>({'rule-number':100+(si*edges.length+ei)*10,'condition-logic':'and',conditions:[{type:'tag-value',operator:'equals',key:'stage',value:name},{type:'attachment-type',operator:'equals',value:'vpc'},{type:'account',operator:'equals',value:account},{type:'region',operator:'equals',value:edge}],action:{'association-method':'constant',segment:name}})))};
    const bootstrap={version:'2021.12','core-network-configuration':coreConfig,segments:[{name:'bootstrap','isolate-attachments':true,'require-attachment-acceptance':true}],
      'attachment-policies':[{'rule-number':100,conditions:[{type:'tag-value',operator:'equals',key:'archtoolkit-bootstrap',value:'hold'}],action:{'association-method':'constant',segment:'bootstrap'}}]};
    const protect=()=>blk('lifecycle',{prevent_destroy:true});
    const resources=[blk('provider',{alias:'control',region:'us-west-2',use_fips_endpoint:true},[],['aws']),dat('aws_caller_identity','current',{}),dat('aws_caller_identity','control',{provider:x('aws.control')}),
      res('aws_networkmanager_global_network','configured',{provider:x('aws.control'),description:name,tags:x(hcl({Name:name}))},[blk('lifecycle',{prevent_destroy:true},[blk('precondition',{condition:x(`data.aws_caller_identity.current.account_id == ${JSON.stringify(account)} && data.aws_caller_identity.control.account_id == ${JSON.stringify(account)}`),error_message:'Both regional and control providers must use the selected owner account.'})])]),
      res('aws_networkmanager_core_network','configured',{provider:x('aws.control'),global_network_id:x('aws_networkmanager_global_network.configured.id'),description:name,create_base_policy:true,base_policy_document:x(jsonencode(bootstrap)),tags:x(hcl({Name:name}))},[protect()]),
      res('aws_networkmanager_core_network_policy_attachment','configured',{provider:x('aws.control'),core_network_id:x('aws_networkmanager_core_network.configured.id'),policy_document:x(jsonencode(policy))},[protect()]),
      output('global_network_id','aws_networkmanager_global_network.configured.id'),output('core_network_id','aws_networkmanager_core_network.configured.id')];
    if(hasVpc){
      resources.push(dat('aws_vpc','selected',{id:vpc}),...subnets.map((id,index)=>dat('aws_subnet','selected_'+index,{id})),res('aws_networkmanager_vpc_attachment','configured',{provider:x('aws.control'),core_network_id:x('aws_networkmanager_core_network.configured.id'),vpc_arn:x('data.aws_vpc.selected.arn'),subnet_arns:x('['+subnets.map((_,i)=>`data.aws_subnet.selected_${i}.arn`).join(', ')+']'),tags:x(hcl({Name:name+'-vpc',stage:segment})),depends_on:x('[aws_networkmanager_core_network_policy_attachment.configured]')},[
        blk('options',{appliance_mode_support:false,ipv6_support:false}),
        blk('lifecycle',{prevent_destroy:true},[blk('precondition',{condition:x(`data.aws_vpc.selected.owner_id == ${JSON.stringify(account)} && data.aws_vpc.selected.enable_dns_support && data.aws_vpc.selected.enable_dns_hostnames && length(toset([${subnets.map((_,i)=>`data.aws_subnet.selected_${i}.availability_zone_id`).join(', ')}])) == ${subnets.length} && ${subnets.map((_,i)=>`(data.aws_subnet.selected_${i}.owner_id == ${JSON.stringify(account)} && data.aws_subnet.selected_${i}.vpc_id == data.aws_vpc.selected.id && !data.aws_subnet.selected_${i}.map_public_ip_on_launch && !data.aws_subnet.selected_${i}.ipv6_native && (data.aws_subnet.selected_${i}.outpost_arn == null || data.aws_subnet.selected_${i}.outpost_arn == "") && data.aws_subnet.selected_${i}.available_ip_address_count >= 3)`).join(' && ')}`),error_message:'Require owned DNS-enabled VPC and private distinct-AZ subnets with address headroom. This does not verify route/NACL/firewall policy.'})]),
      ]),output('attachment_id','aws_networkmanager_vpc_attachment.configured.id'),output('attachment_state','aws_networkmanager_vpc_attachment.configured.state'));
    }
    const result=awsServiceModule(region,resources,GUIDE,findings);
    return {...result,files:{...result.files,'INSPECT.py':cloudWanInspection,'CORE-POLICY.json':JSON.stringify(policy,null,2)+'\n','NETWORK-CONFIG.json':JSON.stringify({name,account,region,edges,segments,start,end,attachment,vpc:hasVpc?vpc:null,subnets:hasVpc?subnets:[],segment:hasVpc?segment:null},null,2)+'\n'}};
  },
}                    ;

const GUIDE=`# Cloud WAN isolated core and staged VPC

Create a NEW global network and core only, never import a shared network into this package. Select the cost-bearing edges, unused ASN pool and segment names with the network owner. This initial scope uses policy2021.12, US commercial edges and the us-west-2 FIPS Network Manager control endpoint. Regional VPC metadata uses the selected regional provider. Metadata and usage aggregation in Oregon requires owner residency/classification review. Endpoint selection alone is not CMVP, FedRAMP, DoD, State APL/CDM or an ATO. Other partitions, new2025/2026 routing policy versions and existing shared core upgrades require separate qualification.

Segments isolate attachments and require explicit acceptance. Attachment rules match account (the JSON condition type is account, NOT account-id), VPC type, edge region and attachment stage tag. There are no segment-actions, static routes or cross-segment sharing. The initial bootstrap policy has a different reserved tag/segment and is replaced by the managed policy attachment before VPC attachment creation. Provider5 base_policy_document is creation input; subsequent LIVE changes belong to the managed policy resource. Its apply automatically executes a Cloud WAN policy change set: review the entire policy before every plan/apply. Removing its Terraform resource does not roll back the LIVE policy. Protected state and prevent_destroy do not prevent authorized in-place policy edits.

Optional attachment uses2–4 existing owned private IPv4 subnets in distinct AZs. Verify actual regional offering/quotas, subnet free addresses, VPC CIDRs and overlap, DNS, routes, NACLs, SGs, firewalls, inspection, encrypted application paths and return routing. Terraform checks ownership, private-IP assignment, distinct AZs and basic address headroom; private assignment is not proof of no internet route. Address allocation can reduce headroom on later plans; verify actual capacity before changing subnets. Existing VPC route tables are not changed. Core edges and attachments incur costs even without a working application path.

Run python INSPECT.py first with approved boto3/botocore and metadata-only credentials; it checks the account and selected VPC/subnets/DNS without creating anything. It does not establish quotas, pricing or route authorization. Run terraform init, validate and plan in an approved account/state boundary. Review account, new global/core/policy, all selected edges, bootstrap-to-final change set and optional pending VPC attachment. Apply only the approved plan. Attachment creation is supported while PENDING_ATTACHMENT_ACCEPTANCE. No automatic accepter is emitted. Run python INSPECT.py --core <exact-core-output> --global-id <exact-global-output>, adding --attachment <exact-attachment-output> for the VPC variant. It checks actual AVAILABLE core, account-bound ARN, global ID, regional edges/ASNs, isolated segments, LIVE policy equal to CORE-POLICY.json, and paginated attachment membership. VPC postcheck requires exact owner/VPC/subnet ARNs, segment/rule or matching initial proposed assignment, options and PENDING_ATTACHMENT_ACCEPTANCE. Unexpected attachments, existing-association proposed changes, network-function changes or policy drift fail. Do not accept an ID merely because its tag matches. Record independent approval of data/management/transfer/key/log/support boundaries, applicable civilian/DoD/State evidence and route scope.

After that review, the network owner may separately accept the exact returned attachment using the approved Cloud WAN console/API change procedure. Repeat the exact inspection command with --require-available afterward; this requires AVAILABLE and the exact selected segment/rule with no proposed change. Acceptance is a routing change. This package does not enable attachment communication: isolation remains true. To connect multiple VPCs, design/review explicit segment sharing or inspection routing first; do not disable isolation globally as a shortcut. Transit-gateway route-table attachments can bypass same-segment isolation semantics and are excluded, as are Direct Connect, Connect, VPN, network-function/service-insertion and cross-account attachments.

Stage separately reviewed exact destination VPC routes and firewall/return paths only after attachment acceptance and actual route-table inspection. Test permitted AND denied paths, DNS/MTU, failover and real application integrity in an authorized test boundary before cutover. No successful Terraform plan or AVAILABLE status proves data-plane connectivity, isolation, effective IAM or compliance. Capture alarms/flow-log design, cost and owner signoff. Existing networks/services/data remain untouched by local package generation.

Rollback uses the owner's reviewed VPC route withdrawal/restore and attachment isolation procedure; no destroy-as-rollback, no shared-core deletion. ASN changes cannot update existing edges, and edge removal requires attachment dependency review. prevent_destroy guards accidental deletion, not state removal or all in-place network changes. Retain approved policy versions/route evidence/state and dependency records under the relevant retention policy. No live AWS operations are performed by this toolkit export.

https://docs.aws.amazon.com/network-manager/latest/cloudwan/cloudwan-policies-json.html
https://docs.aws.amazon.com/network-manager/latest/cloudwan/cloudwan-attachments-acceptance.html
https://docs.aws.amazon.com/general/latest/gr/cloudwan.html
https://raw.githubusercontent.com/hashicorp/terraform-provider-aws/v5.100.0/internal/service/networkmanager/core_network.go
`;
