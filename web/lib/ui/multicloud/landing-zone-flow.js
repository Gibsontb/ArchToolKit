import { EXIT_TARGETS } from '../../multicloud/plan/dcexit/vmware-exit.js';
import { PLATFORM_OPTIONS } from '../../multicloud/plan/options.js';

export const PLATFORM_ORDER=['aws','azure','google','oci','vmware','vsphere','vmware-cloud','ahv','hyperv','hpe','openstack','olvm','proxmox','harvester','openshift','kvm','xen','linux','windows','physical','power','sparc','itanium','pa-risc','mainframe','network']         ;

/** Same destinations as Move to; sovereign environments are chosen under their provider. */
export const LANDING_ZONE_TARGETS = [
  ...PLATFORM_OPTIONS.map(option=>({value:option.value,label:EXIT_TARGETS.find(target=>target.id===(option.value==='vmware'?'vcf':option.value))?.name??option.label})),
  ...EXIT_TARGETS.filter(target=>!['aws','azure','google','oci','vcf','govcloud','azure-government','azure-local'].includes(target.id)).map(target=>({value:target.id,label:target.name})),
].sort((a,b)=>{const rank=(value       )=>{const index=PLATFORM_ORDER.indexOf(value                                 );return index<0?100:index;};return rank(a.value)-rank(b.value);});

/** Keep shared providers in the same order even in a source list with extra platforms. */
export function orderPlatformOptions                                   (options             )    {
  const rank=(value       )=>{
    const alias=value==='gcp'?'google':value==='vcf'?'vmware':value==='ovirt'?'olvm':value;
    const position=LANDING_ZONE_TARGETS.findIndex(option=>option.value===alias);
    return position<0?100:position;
  };
  return [...options].filter(option=>!['azure-local','containers','kubernetes','k8s'].includes(option.value)).sort((a,b)=>rank(a.value)-rank(b.value));
}

export function placementEnvironments(platform       )                                       {
  if(platform==='aws')return [{value:'commercial',label:'Commercial'},{value:'govcloud',label:'GovCloud (US)'}];
  if(platform==='azure')return [{value:'commercial',label:'Commercial'},{value:'azure-government',label:'Government'}];
  return [{value:'standard',label:'Standard'}];
}

export function landingZoneTarget(provider        , environment = '')         {
  if(provider==='govcloud'||provider==='azure-government')return provider;
  if(provider === 'aws' && environment === 'govcloud')return 'govcloud';
  if(provider === 'azure' && environment === 'azure-government')return 'azure-government';
  if(provider === 'azure-local')return 'azure';
  if(provider === 'vcf')return 'vmware';
  return LANDING_ZONE_TARGETS.some(target=>target.value===provider) ? provider : '';
}
