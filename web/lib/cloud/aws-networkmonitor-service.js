                                                   
import {error,            } from '../core/findings.js';
import {blk,dat,hcl,output,res,x} from '../terraform/blueprints/migration/common.js';
import {awsServiceModule,awsServiceRegion} from './aws-service-module.js';
import {networkMonitorInspection} from './aws-networkmonitor-files.js';
export const AWS_NETWORKMONITOR_SERVICE={
  id:'aws_service_networkmonitor_probe',label:'Set up an approved private hybrid Network Synthetic Monitor probe',
  description:'One owned private IPv4 subnet to one approved private destination, TCP or ICMP. Applying starts active traffic and probe charges; no routes/firewall rules or failover are changed.',
  emits:['aws_networkmonitor_monitor','aws_networkmonitor_probe'],
  inputs:[awsServiceRegion,{id:'name',label:'Monitor name',control:'text'},
    {id:'account',label:'Expected source subnet / monitor owner account ID',control:'text'},
    {id:'subnet',label:'Existing owned private source subnet ID',control:'text'},
    {id:'destination',label:'Approved private destination IPv4 address',control:'text'},
    {id:'protocol',label:'Probe protocol',control:'select',default:'TCP',options:[{value:'TCP',label:'TCP SYN / SYN-ACK'},{value:'ICMP',label:'ICMP echo / reply'}]},
    {id:'port',label:'Approved TCP destination port',control:'number',default:443,showWhen:{input:'protocol',equals:['TCP']}},
    {id:'packet',label:'Packet size (bytes)',control:'number',default:56,hint:'56–1500 in this initial workflow; larger MTU designs need separate qualification.'},
    {id:'aggregation',label:'Metric aggregation period',control:'select',default:'60',options:[{value:'30',label:'30 seconds'},{value:'60',label:'60 seconds'}]},
    {id:'approved',label:'Active probe traffic and charges approved by both network owners',control:'select',default:'false',options:[{value:'false',label:'Approval not recorded'},{value:'true',label:'Approved exact source, destination and protocol'}]},
  ],
  build(values)                                    {
    const findings          =[],reject=(path       ,message       )=>findings.push(error('aws.networkmonitor.'+path,message,{path}));
    const text=(key       )=>String(values[key]??'').trim(),region=text('aws_region'),name=text('name'),account=text('account'),subnet=text('subnet'),destination=text('destination'),protocol=text('protocol'),port=protocol==='TCP'?Number(values.port):null,packet=Number(values.packet),aggregation=Number(values.aggregation);
    if(!['us-east-1','us-east-2','us-west-1','us-west-2'].includes(region))reject('aws_region','Initial workflow covers four US commercial Network Synthetic Monitor FIPS regions.');
    if(!/^[a-z][a-z0-9_-]{2,63}$/.test(name))reject('name','Use3–64 lowercase letters/digits/underscores/hyphens.');
    if(!/^\d{12}$/.test(account))reject('account','Use the12-digit source subnet/monitor owner account.');
    if(!/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(subnet))reject('subnet','Use an existing same-owner private regional source subnet.');
    const octets=destination.split('.').map(Number);
    if(!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(destination)||octets.some(n=>n>255)||octets.map(String).join('.')!==destination||!(octets[0]===10||octets[0]===172&&(octets[1]??-1)>=16&&(octets[1]??-1)<=31||octets[0]===192&&octets[1]===168)||destination==='10.0.0.2')reject('destination','Use a canonical approved RFC1918 IPv4 host, excluding AWS-internal10.0.0.2, public/link-local/metadata addresses.');
    if(!['TCP','ICMP'].includes(protocol))reject('protocol','Select TCP or ICMP.');
    if(protocol==='TCP'&&(!Number.isInteger(port)||port <1||port >65535))reject('port','Use a destination port1–65535.');
    if(!Number.isInteger(packet)||packet<56||packet>1500)reject('packet','Use56–1500 bytes in this workflow.');
    if(![30,60].includes(aggregation))reject('aggregation','Select30 or60seconds.');
    if(text('approved')!=='true')reject('approved','Record both network owners approval for active synthetic traffic and probe fees before generation.');
    const sourceArn='arn:aws:ec2:'+region+':'+account+':subnet/'+subnet;
    const result=awsServiceModule(region,[blk('provider',{alias:'network',region,use_fips_endpoint:true,allowed_account_ids:[account]},[],['aws']),dat('aws_caller_identity','current',{}),dat('aws_subnet','source',{id:subnet}),dat('aws_vpc','source',{id:x('data.aws_subnet.source.vpc_id')}),
      res('aws_networkmonitor_monitor','configured',{provider:x('aws.network'),monitor_name:name,aggregation_period:aggregation,tags:x(hcl({Name:name}))},[blk('lifecycle',{prevent_destroy:true},[blk('precondition',{condition:x('data.aws_caller_identity.current.account_id == '+JSON.stringify(account)+' && data.aws_subnet.source.owner_id == '+JSON.stringify(account)+' && data.aws_vpc.source.owner_id == '+JSON.stringify(account)+' && !data.aws_subnet.source.map_public_ip_on_launch && !data.aws_subnet.source.ipv6_native && data.aws_subnet.source.available_ip_address_count >= 6'),error_message:'Require exact owned regional private IPv4 source subnet/VPC and six free IP planning floor. Network route/NACL/service-role/target authorization and actual quota remain separate checks.'})])]),
      res('aws_networkmonitor_probe','configured',{provider:x('aws.network'),monitor_name:x('aws_networkmonitor_monitor.configured.monitor_name'),source_arn:sourceArn,destination,protocol,...(port!==null?{destination_port:port}:{}),packet_size:packet,tags:x(hcl({Name:name+'-probe'}))},[blk('lifecycle',{prevent_destroy:true})]),
      output('monitor_arn','aws_networkmonitor_monitor.configured.arn'),output('probe_id','aws_networkmonitor_probe.configured.probe_id'),output('probe_arn','aws_networkmonitor_probe.configured.arn')],GUIDE,findings);
    return {...result,files:{...result.files,'INSPECT.py':networkMonitorInspection,'NETWORK-CONFIG.json':JSON.stringify({region,name,account,subnet,sourceArn,destination,protocol,port,packet,aggregation},null,2)+'\n'}};
  },
}                    ;
const GUIDE=`# Network Synthetic Monitor private hybrid probe

Initial one-source/one-destination IPv4 workflow in four US commercial FIPS control API regions. The existing catalog calls this CloudWatch Network Monitor; current AWS name is Network Synthetic Monitor. Creates one protected monitor and one TCP/ICMP active probe. Applying creates service-managed probe ENIs and starts traffic and per-probe charges. Native AWS5.100 has no probe-state input; this is not disabled staging. No target/service credentials, network scan, firewall/route mutation or automatic failover is emitted. IPv6, public targets, multi-source matrices and larger MTU/multiple probes require separate qualification.

Approve exact source subnet/owner, target IP/owner/protocol/port, expected load and maintenance/cost window before apply. TCP probes send SYN and expect SYN-ACK; ICMP sends echo and expects reply. This does not authenticate an application, establish TLS or execute an application transaction. Probe source TCP ports rotate over1024–65535. Configure owner-approved stateful/stateless return-path/firewall/NACL rules for the exact destination and actual service ENI sources; do not simply open every destination port. No guessed SG attach parameter is exposed because this native probe resource has none. Existing VPC/subnet/service-linked role/routing/DirectConnect orVPN/return-path/NACL/IP capacity and regional quotas need independent review. Six free IPs is a workflow planning floor, not a service capacity guarantee. Probe ENIs retain IPs across replacement probe instances; deleting/recreating the probe can change IPs and firewall assumptions.

Approve civilian/DoD/State classification, ATO/SSP/APL/CDM/DoDIN/CMVP, network interception/telemetry/privacy/residency/records/support and data handling for destination addresses and metrics. FIPS management APIs do not encrypt/authenticate ICMP or TCP SYN probe data. RFC1918 alone does not prove a private/authorized path. Avoid reserved/internal addresses including169.254.0.0/16 and10.0.0.2, subnet/VPC network/broadcast/DNS reserved addresses. Use an approved real responder; do not infer complete network performance from internal service addresses or a firewall intentionally dropping probes.

Run python INSPECT.py preflight. It reads owner/private regional source subnet/VPC, actual selected-or-main route table, rejects direct public IGW defaults and destination overlap with source VPC CIDRs/reservedaddresses, and requires monitor name absent. It does not send a packet or prove effective routes/return paths/target owner consent. Source ENI creation/service-linked role/effective IAM and IP/quota headroom need owner review. Run terraform init/validate/plan; review explicit new resources/traffic/fees/protected state, then owner-apply through change control. No active probe is run by toolkit export or local validation.

After apply run python INSPECT.py --probe <exact-probe_id>. It reads GetMonitor and GetProbe, requires one unique expected ACTIVE probe, exact owner/region/source/destination/protocol/port/packet/aggregation/VPC and monitor identity. It reports metadata only; route reachability, successful measurements, application readiness and metric completeness remain unproven. ACTIVE is not a connectivity test. Independently verify CloudWatch RTT/packet loss time series, permitted/blocked paths and agreed latency/loss thresholds across relevant hours and failover, with authorized owners. RTT is reported in microseconds; do not label it milliseconds without conversion. Aggregation30/60seconds is metric publication aggregation, not the packet send interval.

Use this baseline during on-prem-to-cloud pilots/waves and compare before/during/after network changes. Record actual source/destination IDs, time ranges, responder/firewall changes, packet loss/RTT distributions and application tests in the project report. Network Health Indicator applies to supported DirectConnect/inter-Region paths and is probabilistic; AWS says NHI is not accurate for DirectConnect paths using Cloud WAN intermediary routing. Do not treat NHI as proof the whole path is healthy or perform automatic failover from it. Configure owner-approved CloudWatch dashboards/alarms/notification recipients separately with appropriate missing-data rules and no false zero-valued measurements.

Rollback preserves measurements/config/state and separately authorizes disabling/deleting the active probe through the actual service/operator process. prevent_destroy does not stop probe traffic or charges and does not undo network changes made elsewhere. There is no fake Terraform state toggle; removing it from state also leaves the live probe running. Reconcile service ENIs/IP changes, monitoring ownership and firewall cleanup before decommission. Budget actual probe-hours, CloudWatch alarms/metrics, transfer/network and support costs from current prices; TCO/project integration remains additional work.

https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/what-is-network-monitor.html
https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/nw-monitor-how-it-works.html
https://docs.aws.amazon.com/networkmonitor/latest/APIReference/API_CreateProbe.html
https://docs.aws.amazon.com/general/latest/gr/cwnm_region.html
`;
