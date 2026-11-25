import type {Blueprint} from '../kit/blueprint.ts';
import {error,type Finding} from '../core/findings.ts';
import {blk,dat,hcl,output,res,x} from '../terraform/blueprints/migration/common.ts';
import {awsServiceModule,awsServiceRegion} from './aws-service-module.ts';
import {internetMonitorInspection} from './aws-internetmonitor-files.ts';
export const AWS_INTERNETMONITOR_SERVICE={
  id:'aws_service_internetmonitor_vpc',label:'Enable bounded Internet Monitor coverage for existing owned VPCs',
  description:'Monitor selected VPC internet traffic by city-network with explicit coverage/cost caps and health thresholds. Applying begins monitoring and telemetry delivery; no new internet connectivity is created.',
  emits:['aws_internetmonitor_monitor'],
  inputs:[awsServiceRegion,{id:'name',label:'Monitor name',control:'text'},
    {id:'account',label:'Expected monitor / VPC owner account ID',control:'text'},
    {id:'vpcs',label:'Existing same-owner VPC IDs',control:'text',hint:'1–10 unique VPCs. Put an existing internet-gateway-attached VPC first; no gateways/routes are created.'},
    {id:'percentage',label:'Traffic coverage (%)',control:'number',default:100},
    {id:'cities',label:'Maximum city-networks monitored',control:'number',default:500,hint:'The city-network cap can reduce actual coverage below the requested percentage.'},
    {id:'availability',label:'Availability health-score threshold (%)',control:'number',default:95},
    {id:'performance',label:'Performance health-score threshold (%)',control:'number',default:95},
    {id:'approved',label:'Owner approved internet telemetry, logs, retention and charges',control:'select',default:'false',options:[{value:'false',label:'Approval not recorded'},{value:'true',label:'Approved selected VPC internet monitoring'}]},
  ],
  build(values):ReturnType<typeof awsServiceModule>{
    const findings:Finding[]=[],reject=(path:string,message:string)=>findings.push(error('aws.internetmonitor.'+path,message,{path}));
    const text=(key:string)=>String(values[key]??'').trim(),region=text('aws_region'),name=text('name'),account=text('account'),vpcs=text('vpcs').split(',').map(s=>s.trim()).filter(Boolean),percentage=Number(values.percentage),cities=Number(values.cities),availability=Number(values.availability),performance=Number(values.performance);
    if(!['us-east-1','us-east-2','us-west-1','us-west-2'].includes(region))reject('aws_region','Initial workflow covers four US commercial Internet Monitor FIPS regions.');
    if(!/^[a-z][a-z0-9_.-]{2,63}$/.test(name))reject('name','Use3–64 lowercase letters/digits/dots/underscores/hyphens, no sensitive metadata.');
    if(!/^\d{12}$/.test(account))reject('account','Use the12-digit monitor and VPC owner account.');
    if(!vpcs.length||vpcs.length>10||new Set(vpcs).size!==vpcs.length||vpcs.some(id=>!/^vpc-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(id)))reject('vpcs','Use1–10 unique owned regional VPC IDs, internet-gateway-attached VPC first.');
    for(const [key,value]of [['percentage',percentage],['availability',availability],['performance',performance]]as const)if(!Number.isInteger(value)||value<1||value>100)reject(key,'Use a whole percentage1–100.');
    if(!Number.isInteger(cities)||cities<1||cities>500000)reject('cities','Use1–500000 city-networks and review actual coverage/charges.');
    if(text('approved')!=='true')reject('approved','Record owner approval for initial monitoring/CloudWatch logs/retention/charges before generation.');
    const resources=vpcs.map(id=>'arn:aws:ec2:'+region+':'+account+':vpc/'+id);
    const result=awsServiceModule(region,[blk('provider',{alias:'internet',region,use_fips_endpoint:true,allowed_account_ids:[account]},[],['aws']),dat('aws_caller_identity','current',{}),...vpcs.map((id,i)=>dat('aws_vpc','selected_'+i,{id})),
      dat('aws_internet_gateway','existing',{},[blk('filter',{name:'attachment.vpc-id',values:[vpcs[0]??'invalid']})]),
      res('aws_internetmonitor_monitor','configured',{provider:x('aws.internet'),monitor_name:name,resources,status:'ACTIVE',traffic_percentage_to_monitor:percentage,max_city_networks_to_monitor:cities,tags:x(hcl({Name:name}))},[
        blk('health_events_config',{availability_score_threshold:availability,performance_score_threshold:performance}),
        blk('lifecycle',{prevent_destroy:true},[blk('precondition',{condition:x('data.aws_caller_identity.current.account_id == '+JSON.stringify(account)+' && data.aws_internet_gateway.existing.owner_id == '+JSON.stringify(account)+' && '+vpcs.map((_,i)=>'(data.aws_vpc.selected_'+i+'.owner_id == '+JSON.stringify(account)+' && data.aws_vpc.selected_'+i+'.state == "available")').join(' && ')),error_message:'Require exact monitor/VPC owner and existing first-VPC internet gateway. This workflow does not attach gateways or approve network exposure.'})]),
      ]),output('monitor_arn','aws_internetmonitor_monitor.configured.arn')],GUIDE,findings);
    return {...result,files:{...result.files,'INSPECT.py':internetMonitorInspection,'INTERNET-CONFIG.json':JSON.stringify({region,name,account,vpcs,resources,percentage,cities,availability,performance},null,2)+'\n'}};
  },
} satisfies Blueprint;
const GUIDE=`# Existing VPC Internet Monitor enablement

Initial1–10same-owner/same-Region existing VPCs in four US commercial FIPS control API regions. VPC-only source requires at least one attached internet gateway; this workflow explicitly requires the first listed VPC to have one already. It creates no VPC/gateway/routes/public IPs or new internet exposure. City-network cap1–500000 and desired traffic1–100percent are both explicit; cap can reduce coverage below requested percentage. Availability/performance event health-score thresholds are separate from an application SLA or packet-loss threshold.

Applying starts ACTIVE monitoring and telemetry delivery. Actual pinned5.100 provider CreateMonitor waits ACTIVE before optionally updating status INACTIVE. Even requesting INACTIVE in a raw native resource would NOT guarantee no initial collection. This workflow exposes no misleading inactive-staging choice. If initial collection/automatic CloudWatch log delivery is unapproved, do not apply. There is no fabricated customer-key or log-retention field on this native resource. Approve logs/metrics/health events/locations/ASNs, privacy/residency/records/legal-hold, civilian/DoD/State classification/ATO/SSP/APL/CDM/DoDIN/CMVP, access/support and cost boundaries before creation. Configure actual supported CloudWatch log/key/retention/access controls independently where required; initial automatic log behavior must itself be approved. No additional S3 export or cross-account OAM link is configured.

This is internet-client measurement coverage, not a synthetic TCP/ICMP probe or a private hybrid path test. CloudFront may be combined with VPCs in another qualified workflow, while NLBs and WorkSpaces source sets cannot be mixed with those source types or each other. Those additional sources and cross-account views remain separate; do not add generic ARNs without enforcing actual source type rules. No data-plane credentials or broad investigator IAM policy is created.

Run python INSPECT.py with approved boto3/botocore first. It checks exact owner, existing owned/available VPC inventory once each, an existing attached first-VPC internet gateway and absent monitor name. Only ResourceNotFoundException establishes absence; denied reads fail. It never creates internet connectivity or reads application/log/event contents. Effective IAM/service roles/telemetry collection permissions/quotas/log handling/real traffic and existing monitors covering the same VPCs require owner review. Preflight cannot guarantee no concurrent creation or duplicate monitoring cost.

Run terraform init/validate/plan with protected state, review exact selected resources/caps/thresholds/fees and approve apply through the owner process. prevent_destroy guards ordinary Terraform monitor deletion, not retention, automatic logging or outside API changes. After apply run python INSPECT.py --check. It requires exact ACTIVE monitor account/region/name/source ARN set/caps/thresholds, acceptable nonfault processing state and no enabled additional S3 export. It reports ProcessingStatus including COLLECTING_DATA or INSUFFICIENT_DATA, not false readiness or zero loss. OK metadata is still not a healthy application, complete coverage, effective authorization or SLA proof.

Independently verify actual measured client locations/ASNs, health events, log delivery/retention/encryption, CloudWatch series and allowed/denied access in the authorized monitoring boundary. Source VPC attachment does not prove the application has useful public traffic. Compare before/during/after migration pilot and waves over matching traffic/time ranges; distinguish changes in client mix/routing and monitoring caps from actual service degradation. Correlate with target application transactions, DNS/CDN/network and incident evidence before cutover signoff. Record approved source/target/time-window/coverage/thresholds/actual event IDs and owner decisions in the migration project report. No app data copy or network cutover runs here.

Cost uses actual monitored city-networks, monitored resource fees, log ingestion/storage/queries and related CloudWatch costs under current pricing, not provisioned VM CPU/RAM/storage. A city-network cap is not a fixed currency spend cap. Model baseline/overlap and retained evidence separately in TCO; integration remains additional work. No promise all workload moves reduce cost.

Rollback/change control can independently approve UpdateMonitor INACTIVE to stop monitoring after creation, with actual service confirmation and log/evidence retention review; that does not undo initial collection or remove retained logs. Reconcile desired Terraform status to prevent unintended reactivation. Do not delete state to pretend a monitor is off or delete logs as an incident rollback. Decommission only after monitoring ownership, records/retention/legal-hold and actual source/target evidence are accepted.

https://docs.aws.amazon.com/internet-monitor/latest/api/API_CreateMonitor.html
https://docs.aws.amazon.com/internet-monitor/latest/api/API_GetMonitor.html
https://docs.aws.amazon.com/internet-monitor/latest/api/API_UpdateMonitor.html
https://raw.githubusercontent.com/hashicorp/terraform-provider-aws/v5.100.0/internal/service/internetmonitor/monitor.go
https://docs.aws.amazon.com/general/latest/gr/cwim_region.html
`;
