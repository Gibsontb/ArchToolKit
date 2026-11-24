import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXIT_TARGETS } from '../../multicloud/plan/dcexit/vmware-exit.ts';
import { emptyPlan } from '../../multicloud/plan/store.ts';
import { LANDING_ZONE_TARGETS, landingZoneTarget, placementEnvironments, orderPlatformOptions } from './landing-zone-flow.ts';
import { landingZoneMode } from './design.ts';
import { vendorLandingZoneFields } from './vendor-landing-zone.ts';

test('landing-zone destinations cover every Move to target without duplicate government entries',()=>{
  assert.equal(new Set(LANDING_ZONE_TARGETS.map(target=>target.value)).size,LANDING_ZONE_TARGETS.length);
  for(const target of EXIT_TARGETS){
    const actual=target.id==='govcloud'?landingZoneTarget('aws','govcloud'):target.id==='azure-government'?landingZoneTarget('azure','azure-government'):landingZoneTarget(target.id);
    assert.equal(actual,target.id==='vcf'?'vmware':target.id==='azure-local'?'azure':target.id,target.name);
  }
  assert.equal(LANDING_ZONE_TARGETS.some(target=>target.value==='govcloud'),false);
  assert.equal(landingZoneTarget('unrecognized'),'');
});

test('standalone landing-zone mode needs no application and uses shared foundations',()=>{
  const plan={...emptyPlan(),mode:'landing-zone' as const};
  assert.equal(plan.apps.length,0);
  for(const target of ['aws','azure','google','oci','vmware'] as const)assert.equal(landingZoneMode(plan,target),'shared');
});

test('providers have one fixed order and government is a placement option',()=>{
  assert.deepEqual(LANDING_ZONE_TARGETS.slice(0,5).map(option=>option.value),['aws','azure','google','oci','vmware']);
  assert.ok(!LANDING_ZONE_TARGETS.some(option=>['govcloud','azure-government'].includes(option.value)));
  assert.ok(placementEnvironments('aws').some(option=>option.value==='govcloud'));
  assert.ok(placementEnvironments('azure').some(option=>option.value==='azure-government'));
});

test('every vendor target retains its location and foundation inputs',()=>{
  const plan=emptyPlan();
  for(const target of EXIT_TARGETS.filter(target=>target.delivery==='integration-needed'||target.id==='vmware-cloud')){
    const ids=vendorLandingZoneFields(target.id,plan).map(field=>field.id);
    for(const id of ['primary','deployment','manager','compute','storage','network','backup'])assert.ok(ids.includes(id),target.name+': '+id);
  }
});

test('standalone vSphere remains distinct from VMware Cloud Foundation',()=>{
 assert.ok(LANDING_ZONE_TARGETS.some(target=>target.value==='vsphere'&&target.label==='Broadcom VMware vSphere'));
 assert.ok(LANDING_ZONE_TARGETS.some(target=>target.value==='vmware'));
 assert.equal(landingZoneTarget('vsphere'),'vsphere');
});

test('container runtimes are services rather than platform choices',()=>{
 assert.deepEqual(orderPlatformOptions([{value:'aws'},{value:'containers'},{value:'kubernetes'},{value:'k8s'},{value:'vmware'}]).map(option=>option.value),['aws','vmware']);
});

test('server hosts and physical servers remain in the shared platform list',()=>{
 for(const [value,label] of [['linux','Linux Server Host'],['windows','Windows Server Host'],['physical','Physical x86 Server']])assert.ok(LANDING_ZONE_TARGETS.some(option=>option.value===value&&option.label===label));
});

test('shared platform order places host systems after virtualization and networking last',()=>{
 const values=LANDING_ZONE_TARGETS.map(option=>option.value);
 assert.ok(values.indexOf('vsphere')<values.indexOf('linux'));
 assert.ok(values.indexOf('linux')<values.indexOf('windows'));
 assert.ok(values.indexOf('windows')<values.indexOf('physical'));
 assert.ok(values.indexOf('physical')<values.indexOf('mainframe'));
 assert.equal(values.at(-1),'network');
});
