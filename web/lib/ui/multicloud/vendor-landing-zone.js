import { HOSTED_VMWARE_SERVICES,                 } from '../../multicloud/plan/dcexit/vmware-exit.js';
import { PROXMOX_OVF_IMPORT, PROXMOX_SETUP, PROXMOX_VMWARE_STEPS } from '../../multicloud/plan/dcexit/proxmox.js';
                                                             
                                                           
import { overrideKey } from '../../multicloud/plan/options.js';
import { asOptions } from '../../kit/regions.js';
import { renderBlueprintForm } from '../blueprint-form.js';
import { card } from '../components.js';
import { downloadFile, el } from '../dom.js';
                                                    
import { landingZoneWalkthrough } from './landing-zone-walkthrough.js';

const resources                                                                      = {
  mainframe: ['IBM Z HMC endpoint', 'CPC and logical partition', 'Storage subsystem and volumes', 'OSA / HiperSockets network'],
  'pa-risc': ['GSP / management processor endpoint', 'PA-RISC server and partition', 'Boot paths and storage volumes', 'Network adapters and VLANs'],
  itanium: ['iLO / management processor endpoint', 'Integrity host and partition', 'Storage paths and volumes', 'Network adapters and VLANs'],
  power: ['HMC or PowerVC endpoint', 'Managed system and partition profile', 'VIOS storage or volume group', 'Virtual switch and VLAN'],
  sparc: ['ILOM / XSCF or domain manager endpoint', 'SPARC host and logical domain', 'ZFS pool or virtual disk', 'Virtual switch or Solaris datalink'],
  linux: ['Linux host management endpoint', 'Host or host group', 'Filesystem or volume', 'Network interface or VLAN'],
  windows: ['Windows management endpoint', 'Server or server group', 'Disk or volume', 'Network interface or VLAN'],
  physical: ['BMC / Redfish endpoint', 'Server model and asset group', 'Storage controller and disks', 'Physical ports and VLANs'],
  xen: ['XAPI or Xen Orchestra endpoint', 'Resource pool and host', 'Storage repository', 'Network or VLAN'],
  kvm: ['libvirt connection URI', 'KVM host or host group', 'libvirt storage pool', 'libvirt virtual network or bridge'],
  network: ['Network management endpoint', 'Site and device group', 'Configuration backup repository', 'Management network'],
  vsphere: ['vCenter endpoint', 'vSphere cluster', 'Datastore or storage policy', 'Port group or distributed switch'],
  ahv: ['Prism Central endpoint', 'AHV cluster', 'AOS storage container', 'VLAN or Flow subnet'],
  openshift: ['OpenShift API endpoint', 'Virtualization namespace or node pool', 'StorageClass', 'NetworkAttachmentDefinition'],
  'azure-local': ['Azure Arc resource bridge', 'Azure Local cluster', 'Storage path', 'Logical network'],
  hyperv: ['Failover cluster or host endpoint', 'Hyper-V cluster', 'Cluster Shared Volume', 'Virtual switch'],
  hpe: ['Morpheus manager endpoint', 'HVM cluster', 'HVM datastore', 'HVM network'],
  openstack: ['Keystone endpoint', 'Nova project and availability zone', 'Cinder volume type', 'Neutron network'],
  olvm: ['OLVM engine endpoint', 'OLVM data centre and cluster', 'Storage domain', 'vNIC profile'],
  proxmox: ['Proxmox API endpoint', 'Cluster and target node', 'VM storage ID', 'Bridge or SDN VNet'],
  harvester: ['Harvester API endpoint', 'Harvester cluster and namespace', 'StorageClass', 'VM network'],
  govcloud: ['AWS account ID', 'VPC or staging account', 'Staging datastore', 'Test and production subnets'],
  'azure-government': ['Subscription ID', 'Migration project and resource group', 'Target disk or storage policy', 'Virtual network and test subnet'],
  'vmware-cloud': ['Cloud service management endpoint', 'SDDC or private cloud', 'Workload datastore', 'Target segment'],
};

export function vendorLandingZoneFields(target        , plan                            )                   {
  const [manager, compute, storage, network] = resources[target] ?? ['Management endpoint', 'Compute pool', 'Datastore', 'Target network'];
  const regions = target === 'govcloud' ? ['us-gov-east-1', 'us-gov-west-1']
    : target === 'azure-government' ? ['usgovarizona', 'usgovtexas', 'usgovvirginia'] : [];
  const locations = regions.length ? regions : plan.requirements.sites.map((site) => site.name);
  const location = (id        , label        , blankLabel        )                 =>
    ({ id, label, control: regions.length ? 'select' : 'combo', options: asOptions(locations), blankLabel });
  return [
    ...(target === 'vmware-cloud' ? [{
      id: 'service', label: 'Hosted VMware service', control: 'select'         , options: HOSTED_VMWARE_SERVICES,
      blankLabel: 'Choose a service',
    }] : []),
    location('primary', regions.length ? 'Primary region' : 'Primary site', regions.length ? 'Select a region' : 'Choose or enter a site'),
    location('recovery', regions.length ? 'DR region' : 'Recovery site', 'None'),
    { id: 'deployment', label: 'Deployment', control: 'select', options: [
      { value: 'existing', label: 'Use an existing landing zone' },
      { value: 'new', label: 'Build a new landing zone' },
    ], blankLabel: 'Select deployment' },
    { id: 'manager', label: manager, control: 'text' },
    { id: 'compute', label: compute, control: 'text' },
    { id: 'storage', label: storage, control: 'text' },
    { id: 'network', label: network, control: 'text' },
    { id: 'nodes', label: 'Target node count', control: 'text' },
    { id: 'host-profile', label: 'Host hardware profile', control: 'text' },
    { id: 'storage-policy', label: 'Storage resilience policy', control: 'text' },
    { id: 'management-cidr', label: 'Management CIDR', control: 'text' },
    { id: 'workload-cidr', label: 'Workload CIDR', control: 'text' },
    { id: 'gateway', label: 'Gateway', control: 'text' },
    { id: 'dns', label: 'DNS servers', control: 'text' },
    { id: 'ntp', label: 'NTP servers', control: 'text' },
    { id: 'uplinks', label: 'Uplinks and VLAN mappings', control: 'text' },
    { id: 'identity', label: 'Identity provider', control: 'text' },
    { id: 'admin-roles', label: 'Administrator role mappings', control: 'text' },
    { id: 'access', label: 'Administrative access', control: 'select', options: [
      {value:'private',label:'Private management network'}, {value:'bastion',label:'Bastion or privileged access gateway'},
    ],blankLabel:'Choose access method' },
    { id: 'boundary', label: 'Deployment boundary / authorization reference', control: 'text' },
    { id: 'encryption', label: 'Encryption and key management', control: 'text' },
    { id: 'logging', label: 'Central logging destination', control: 'text' },
    { id: 'monitoring', label: 'Monitoring and alert routing', control: 'text' },
    { id: 'patching', label: 'Patch and image source', control: 'text' },
    { id: 'backup', label: 'Backup and recovery service', control: 'text' },
    { id: 'recovery-objectives', label: 'Recovery time and data-loss objectives', control: 'text' },
  ];
}

export function vendorLandingZoneCard(ctx             , target            , vmwareMigration = false)              {
  const fields = vendorLandingZoneFields(target.id, ctx.session.plan());
  const key = (field        ) => overrideKey(target.id, 'vendor-lz', field);
  const values = () => Object.fromEntries(fields.map(({ id }) => [id, ctx.session.plan().designOverrides[key(id)] ?? (id==='deployment'&&ctx.session.plan().mode==='landing-zone'?'new':'')]));
  const inputs = renderBlueprintForm({ inputs: fields }, {
    values,
    set: (field, value) => ctx.session.update((plan) => ({
      ...plan, designOverrides: { ...plan.designOverrides, [key(field)]: value },
    })),
  });
  const output=el('div', { class: 'btn-row' },
    el('button', {class:'btn btn-primary',text:'Download vendor handoff',attrs:{type:'button'},on:{click:()=>downloadFile(target.id+'-landing-zone.json',JSON.stringify({
      kind:'archtoolkit.vendor-landing-zone',version:1,platform:target.id,settings:values(),reference:target.reference,
    },null,2),'application/json')}}),
    target.reference?el('a',{class:'btn',text:'Vendor documentation',attrs:{href:target.reference}}):null);
  if(ctx.session.plan().mode==='landing-zone'){
    const controls=(ids                  )=>el('div',{class:'field-grid'},...inputs.filter((_,index)=>ids.includes(fields[index] .id)));
    return card(target.name+' landing zone',landingZoneWalkthrough([
      {label:'Sites & management',content:controls(['service','primary','recovery','deployment','manager'])},
      {label:'Compute & storage',content:el('div',{},controls(['compute','storage','nodes','host-profile','storage-policy']),target.id==='proxmox'?el('ol',{},...PROXMOX_SETUP.map(text=>el('li',{text}))):null)},
      {label:'Networking',content:controls(['network','management-cidr','workload-cidr','gateway','dns','ntp','uplinks'])},
      {label:'Identity & security',content:controls(['identity','admin-roles','access','boundary','encryption'])},
      {label:'Operations & recovery',content:controls(['logging','monitoring','patching','backup','recovery-objectives'])},
      {label:'Review & handoff',content:el('div',{},output,el('p',{class:'small muted',text:'Exports design settings for the vendor deployment workflow. Automated platform provisioning is not implemented for this destination.'}))},
    ]));
  }
  return card(target.name + ' landing zone',
    target.id === 'proxmox' ? el('section', {},
      el('h3', { text: 'Hardware and software setup' }),
      el('ol', {}, ...PROXMOX_SETUP.map((text) => el('li', { text })))) : null,
    el('div', { class: 'field-grid' }, ...inputs),
    vmwareMigration && target.id === 'proxmox' ? el('section', {},
      el('h3', { text: 'Migrate VMware workloads' }),
      el('ol', {}, ...PROXMOX_VMWARE_STEPS.map((text) => el('li', { text }))),
      el('p', { text: 'The offline import script previews the OVF by default. Apply creates a stopped VM on the target node so you can verify its configuration before booting.' }),
      el('button', { class: 'btn', text: 'Download OVF import script', attrs: { type: 'button', 'data-control': 'proxmox-ovf-script' },
        on: { click: () => downloadFile('proxmox-ovf-import.sh', PROXMOX_OVF_IMPORT, 'text/x-shellscript') } })) : null,
    output,
    el('p', { class: 'small muted', text: 'Provision through the vendor workflow using the downloaded handoff.' }));
}
