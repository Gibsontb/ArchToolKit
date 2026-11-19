import { HOSTED_VMWARE_SERVICES,                 } from '../../multicloud/plan/dcexit/vmware-exit.js';
import { PROXMOX_OVF_IMPORT, PROXMOX_SETUP, PROXMOX_VMWARE_STEPS } from '../../multicloud/plan/dcexit/proxmox.js';
                                                             
                                                           
import { overrideKey } from '../../multicloud/plan/options.js';
import { asOptions } from '../../kit/regions.js';
import { renderBlueprintForm } from '../blueprint-form.js';
import { card } from '../components.js';
import { downloadFile, el } from '../dom.js';
                                                    

const resources                                                                      = {
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
    { id: 'backup', label: 'Backup and recovery service', control: 'text' },
  ];
}

export function vendorLandingZoneCard(ctx             , target            , vmwareMigration = false)              {
  const fields = vendorLandingZoneFields(target.id, ctx.session.plan());
  const key = (field        ) => overrideKey(target.id, 'vendor-lz', field);
  const values = () => Object.fromEntries(fields.map(({ id }) => [id, ctx.session.plan().designOverrides[key(id)] ?? '']));
  const inputs = renderBlueprintForm({ inputs: fields }, {
    values,
    set: (field, value) => ctx.session.update((plan) => ({
      ...plan, designOverrides: { ...plan.designOverrides, [key(field)]: value },
    })),
  });
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
    el('div', { class: 'btn-row' },
      el('button', {
        class: 'btn btn-primary', text: 'Download vendor handoff', attrs: { type: 'button' },
        on: { click: () => downloadFile(target.id + '-landing-zone.json', JSON.stringify({
          kind: 'archtoolkit.vendor-landing-zone', version: 1, platform: target.id, settings: values(),
        }, null, 2), 'application/json') },
      }),
      target.reference ? el('a', { class: 'btn', text: 'Vendor documentation', attrs: { href: target.reference } }) : null),
    el('p', { class: 'small muted', text: 'Provision through the vendor workflow using the downloaded handoff.' }));
}
