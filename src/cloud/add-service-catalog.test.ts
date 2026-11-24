import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addServicesFor } from './add-service-catalog.ts';
import { SERVICE_CLOUDS, services } from './service-catalog.ts';
import { TERRAFORM_BLUEPRINTS } from '../terraform/blueprints/index.ts';
import { ANSIBLE_BLUEPRINTS } from '../ansible/blueprints/index.ts';
import { defaultValues } from '../kit/blueprint.ts';

test('every Terraform and Ansible entry uses its original complete definition',()=>{
  for(const group of TERRAFORM_BLUEPRINTS){
    const rows=addServicesFor(group.target);
    for(const blueprint of group.blueprints)assert.ok(rows.some(row=>row.terraform.includes(blueprint)),group.target+': '+blueprint.id);
  }
  for(const group of ANSIBLE_BLUEPRINTS){
    const rows=addServicesFor(group.target);
    for(const blueprint of group.blueprints)assert.ok(rows.some(row=>row.ansible.includes(blueprint)),group.target+': '+blueprint.id);
  }
  for(const platform of SERVICE_CLOUDS){
    const rows=addServicesFor(platform);
    for(const service of services(platform))assert.ok(rows.some(row=>row.id===service.id),service.name);
    assert.equal(new Set(rows.flatMap(row=>row.terraform).filter(blueprint=>!blueprint.id.startsWith('aws_service_'))).size,TERRAFORM_BLUEPRINTS.find(group=>group.target===platform)!.blueprints.length);
    assert.equal(new Set(rows.filter(row=>!row.id.startsWith('linux-host:')&&!row.id.startsWith('windows-host:')).flatMap(row=>row.ansible)).size,ANSIBLE_BLUEPRINTS.find(group=>group.target===platform)!.blueprints.length);
    assert.ok(rows.every(row=>!/^Terraform|^Ansible/.test(row.name)));
    assert.equal(new Set(rows.map(row=>row.id)).size,rows.length);
    assert.ok(rows.every(row=>typeof row.name==='string'&&row.name.length>0));
  }
});

test('vendor products contain their Terraform and Ansible implementations',()=>{
  for(const [platform,id] of [['aws','amazon-elastic-compute-cloud'],['aws','amazon-simple-storage-service'],['azure','virtual-machines'],['azure','azure-sql-database'],['google','cloud-sql'],['oci','compute-virtual-machine']]){
    const row=addServicesFor(platform!).find(row=>row.id===id)!;
    assert.ok(row.terraform.length>0,platform+': '+id+' Terraform');
    assert.ok(row.ansible.length>0,platform+': '+id+' Ansible');
  }
});
test('private-platform modules are scoped to the selected platform',()=>{
  for(const platform of ['proxmox','openstack','olvm','openshift','harvester','vmware','azure-local','hyperv']){
    assert.ok(addServicesFor(platform).length>0,platform);
  }
  assert.ok(addServicesFor('proxmox').filter(row=>row.id.startsWith('ansible:')).every(row=>row.ansible.every(blueprint=>/proxmox/.test(blueprint.id))));
  assert.ok(addServicesFor('proxmox').every(row=>!row.id.startsWith('guest:')));
  assert.equal(addServicesFor('unknown').length,0);
});

test('Azure Local catalog contains only its own Stack HCI resources',()=>{
  assert.ok(addServicesFor('azure-local').every(service=>service.terraform.every(blueprint=>blueprint.emits.some(type=>type.startsWith('azurerm_stack_hci_')))));
});

test('Hyper-V generates a stopped VM and quotes host input safely',()=>{
  const service=addServicesFor('hyperv').find(service=>service.id==='ansible:hyperv_add_vm')!;
  const blueprint=service.ansible[0]!;
  const result=blueprint.build({vm_name:"test'vm",switch:'Internal',memory:'4',cpus:'2',generation:'2'},'test');
  const text=result.files['service.yml']!;
  assert.ok(text.includes("test''vm"));
  assert.ok(text.includes('New-VM'));
  assert.ok(!text.includes('Start-VM'));
});
test('an existing service resource produces its real build files',async()=>{
  const row=addServicesFor('aws').find(row=>row.terraform.some(blueprint=>blueprint.id==='res_aws_s3_bucket'))!;
  assert.ok(row);
  const blueprint=row.terraform.find(blueprint=>blueprint.id==='res_aws_s3_bucket')!;
  const defaults=defaultValues(blueprint);
  await blueprint.load?.();
  const result=blueprint.build({...defaults,'r.bucket':'test-service-bucket'},'service');
  assert.ok(Object.values(result.files).join('\n').includes('aws_s3_bucket'));
});

 test('CSV categories preserve multiple memberships and unmatched service choices',async()=>{
 const {IMPORTED_SERVICE_TAXONOMY}=await import('./imported-service-taxonomy.ts');
 for(const [platform,entries] of Object.entries(IMPORTED_SERVICE_TAXONOMY)){
 const rows=addServicesFor(platform);
 for(const entry of entries){if(/^(?:Terraform|Ansible)\b/i.test(entry.name))continue;assert.ok(rows.some(row=>(row.categories??[row.category]).includes(entry.category)),platform+': '+entry.category);}
 }
 assert.ok(addServicesFor('azure').some(row=>(row.categories?.length??0)>1));
 });

test('platform services exclude automatically copied guest catalogs',()=>{
 const guestDefinitions=new Set(ANSIBLE_BLUEPRINTS.filter(group=>['linux','windows','databases','containers'].includes(group.target)).flatMap(group=>group.blueprints));
 for(const platform of ['aws','azure','google','oci','vmware','vsphere','vmware-cloud','ahv','hyperv','hpe','openstack','olvm','proxmox','harvester','openshift','network']){
  const rows=addServicesFor(platform);
  assert.ok(rows.every(row=>!row.id.startsWith('guest:')&&!row.id.startsWith('linux-host:')&&!row.id.startsWith('windows-host:')),platform);
  assert.ok(rows.every(row=>row.ansible.every(blueprint=>!guestDefinitions.has(blueprint)||(['harvester','openshift'].includes(platform)&&/^mod_(?:kubevirt_core_|kubernetes_core_|community_okd_)/.test(blueprint.id)))),platform+' native definitions only');
 }
 for(const host of ['linux','windows']){
  assert.ok(addServicesFor(host).some(row=>row.id.startsWith('taxonomy:')),host+' own catalog');
  for(const blueprint of ANSIBLE_BLUEPRINTS.find(group=>group.target===host).blueprints)assert.ok(addServicesFor(host).some(row=>row.ansible.includes(blueprint)),host+' original automation');
 }
});
