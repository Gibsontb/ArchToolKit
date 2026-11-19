import { el, replace } from './dom.ts';
import { card, field, numberInput, select, table, stat, statGrid } from './components.ts';
import { addressCapacityChecks, type EstateSizingReview } from '../vcf/estate-sizing-review.ts';
import { parseCidr, parseIPv4, containsAddress, formatCidr, usableRange } from '../core/net.ts';
import type { DeploymentPlan } from '../vcf/spec-builder.ts';
import type { SizingOutcome, FormValues } from './vcf-sizing-form.ts';
import { NIC_SPEEDS } from './vcf-sizing-form.ts';

const ROLES = [
  ['management','ESX management'], ['vmManagement','VM and management services'],
  ['vmotion','vMotion'], ['storage','Storage network'], ['hostTep','Host TEP'], ['edgeTep','Edge TEP'],
] as const;
type Role = typeof ROLES[number][0];
export interface EstateNetworkPanel {
  readonly element: HTMLElement;
  update(review: EstateSizingReview, outcome: SizingOutcome, values: FormValues): void;
  handoff(): Partial<DeploymentPlan>;
  report(): unknown;
}
export function estateNetworkPanel(setTarget: (values: Partial<FormValues>) => void, changed: () => void): EstateNetworkPanel {
  let review: EstateSizingReview | undefined;
  let outcome: SizingOutcome | undefined;
  const source = el('div');
  const checks = el('div');
  const addressStatus = el('div');
  const uplinks = select(Array.from({ length:8 },(_,i)=>({value:String(i+1),label:String(i+1)})), '2');
  const speed = select([{value:'',label:'Not specified'},...NIC_SPEEDS.map(value=>({value,label:value+' Gb/s'}))], '');
  uplinks.addEventListener('change',()=>setTarget({pnicsPerHost:uplinks.value}));
  speed.addEventListener('change',()=>setTarget({nicSpeedGbps:speed.value}));
  const controls = ROLES.map(([key,label]) => {
    const subnet = select([{value:'',label:'Select a recorded subnet or plan a new one'},{value:'new',label:'Plan a new subnet'}], '');
    const cidr = el('input',{attrs:{type:'text',placeholder:'IPv4 CIDR'}});
    const vlan = numberInput(0,{min:0,max:4094,step:1});vlan.value='';
    const gateway = el('input',{attrs:{type:'text'}});
    const mtu = numberInput(1500,{min:576,max:9216,step:1});mtu.value='';
    const cidrField=field('New CIDR · '+label,cidr);cidrField.hidden=true;
    const wrap=el('details',{class:'input-section'},el('summary',{text:label}),
      el('div',{class:'field-grid'},field('Subnet · '+label,subnet),cidrField,
        field('VLAN ID · '+label,vlan),field('Gateway · '+label,gateway),field('MTU · '+label,mtu)));
    subnet.addEventListener('change',()=>{
      cidrField.hidden=subnet.value!=='new';
      const recorded=review?.subnets.find(value=>value.key===subnet.value);
      gateway.value=recorded?.gateways.length===1?recorded.gateways[0]!:'';
      vlan.value='';mtu.value='';
      drawAddresses();changed();
    });
    for(const input of [cidr,vlan,gateway,mtu])input.addEventListener('change',()=>{drawAddresses();changed();});
    return {key,label,subnet,cidr,vlan,gateway,mtu,wrap};
  });
  function required(key: Role): number {
    if(!outcome)return 0;
    const ips=outcome.result.ips;
    if(key==='management')return outcome.result.input.hostCount;
    if(key==='hostTep')return ips.tepIps;
    if(key==='edgeTep')return ips.edgeTepIps;
    if(key==='vmotion')return outcome.result.input.hostCount;
    if(key==='storage')return outcome.result.input.storage==='vmfs-fc'?0:outcome.result.input.hostCount;
    return Math.max(0,ips.totalRecommended-ips.hostIps-ips.tepIps-ips.edgeTepIps);
  }
  function readCidr(control: typeof controls[number]): string {
    return control.subnet.value==='new'?control.cidr.value.trim():review?.subnets.find(value=>value.key===control.subnet.value)?.cidr??'';
  }
  function addressRows() { return controls.filter(control=>required(control.key)>0).map(control=>({role:control.label,cidr:readCidr(control),required:required(control.key)})); }
  function drawAddresses(): void {
    const result=addressCapacityChecks(addressRows());
    replace(addressStatus,table([
      {header:'Network',render:row=>row.role},{header:'Planned CIDR',render:row=>row.cidr||'Not selected'},
      {header:'Addresses required',numeric:true,render:row=>String(row.required)},
      {header:'Combined demand in this CIDR',numeric:true,render:row=>String(row.combined)},
      {header:'Usable range size',numeric:true,render:row=>row.capacity===undefined?'Unknown':String(row.capacity)},
      {header:'Assessment',render:row=>row.status},
    ],result));
  }
  const element=el('div',{class:'stack'},card('Target networking',
    el('div',{class:'field-grid'},field('Planned TEP uplinks per host',uplinks),field('Planned NIC speed',speed)),
    el('p',{class:'muted',text:'These are target design inputs. Physical NIC counts and observed speeds below describe the source. Select the actual uplinks intended for the target transport network.'})),
    source,card('Management-domain address plan',
      el('p',{class:'muted',text:'Recorded subnet masks establish range size. Free addresses, reservations, DHCP pools, upstream routing and end-to-end MTU require network verification. Shared CIDRs combine the selected roles’ demand.'}),
      addressStatus,...controls.map(control=>control.wrap),
      el('p',{class:'muted',text:'Complete a valid CIDR, VLAN and gateway to carry a network into Spec Builder. Edge TEP details remain in this review report.'})),checks);
  return {
    element,
    update(next,result,values){
      const newScope=review!==next;review=next;outcome=result;
      uplinks.value=values.pnicsPerHost??'2';speed.value=values.nicSpeedGbps??'';
      if(newScope){
        for(const control of controls){
          const previous=control.subnet.value;
          control.subnet.replaceChildren(el('option',{text:'Select a recorded subnet or plan a new one',attrs:{value:''}}),
            ...next.subnets.map(subnet=>el('option',{text:subnet.cidr+' · '+subnet.vcenter+' · '+subnet.portGroups.join(', '),attrs:{value:subnet.key}})),
            el('option',{text:'Plan a new subnet',attrs:{value:'new'}}));
          if(previous==='new'||next.subnets.some(subnet=>subnet.key===previous))control.subnet.value=previous;
          else {control.subnet.value='';control.gateway.value='';control.vlan.value='';control.mtu.value='';}
        }
        replace(source,card('Networking from selected source clusters',
          statGrid(stat({label:'Hosts in scope',value:next.totals.hostCount}),stat({label:'Recorded subnets',value:next.subnets.length}),
            stat({label:'Hosts missing uplink speed',value:next.networks.reduce((sum,cluster)=>sum+cluster.hostsWithUnknownSpeed,0)})),
          table([
            {header:'Cluster / vCenter',render:row=>row.cluster+' · '+row.vcenter},
            {header:'Hosts',numeric:true,render:row=>String(row.hosts)},
            {header:'Minimum physical NIC count',render:row=>row.minimumReportedNics===undefined?'Unknown':String(row.minimumReportedNics)},
            {header:'Slowest host’s fastest recorded uplink',render:row=>row.minimumFastestNicGbps===undefined?'Unknown':row.minimumFastestNicGbps+' Gb/s'},
            {header:'Link-down adapters',render:row=>String(row.downLinks)},
            {header:'Recorded MTUs',render:row=>row.mtuValues.join(', ')||'Unknown'},
            {header:'Observed VLAN values',render:row=>row.vlanValues.join(', ')||'Unknown'},
            {header:'DNS / NTP coverage',render:row=>row.dnsHosts+'/'+row.hosts+' · '+row.ntpHosts+'/'+row.hosts},
          ],next.networks)));
      }
      for(const control of controls)control.wrap.hidden=required(control.key)===0;
      replace(checks,card('Source networking findings',
        ...next.networks.filter(cluster=>cluster.findings.length).map(cluster=>el('div',{},el('h3',{text:cluster.cluster+' · '+cluster.vcenter}),el('ul',{},...cluster.findings.map(text=>el('li',{text}))))),
        el('p',{class:'muted',text:'Hardware compatibility, NVMe and TPM validation, measured storage IOPS and latency, historical utilization, and upstream network verification remain separate inputs. A snapshot cannot establish those facts.'})));
      drawAddresses();
    },
    handoff(){
      const patch: Partial<Pick<DeploymentPlan,'management'|'vmManagement'|'vmotion'|'nfs'|'vsan'|'hostTep'>> = {};
      for(const control of controls){
        if(control.key==='edgeTep'||required(control.key)===0)continue;
        const cidr=parseCidr(readCidr(control));const gateway=parseIPv4(control.gateway.value);
        const vlan=control.vlan.valueAsNumber;
        if(!cidr||gateway===null||!containsAddress(cidr,gateway)||!control.vlan.validity.valid||!Number.isInteger(vlan))continue;
        const range = usableRange(cidr);
        if (gateway < range.first || gateway > range.last) continue;
        const key=control.key==='storage'?(outcome?.result.input.storage==='nfs'?'nfs':'vsan'):control.key;
        const mtu=control.mtu.valueAsNumber;
        patch[key]={cidr:formatCidr(cidr),vlanId:vlan,gateway:control.gateway.value.trim(),...(control.mtu.validity.valid&&Number.isFinite(mtu)?{mtu}:{})};
      }
      return patch;
    },
    report(){return {targetUplinksPerHost:uplinks.value,targetNicSpeedGbps:speed.value,addressChecks:addressCapacityChecks(addressRows()),networks:controls.map(control=>({role:control.label,cidr:readCidr(control),vlan:control.vlan.value,gateway:control.gateway.value,mtu:control.mtu.value}))};},
  };
}
