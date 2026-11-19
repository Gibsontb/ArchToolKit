import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fieldsFromDeploymentPlan, FORM_DEFAULTS, planFromForm, installerExportReady } from './vcf-spec-plan.ts';
import { buildSddcSpec } from '../vcf/spec-builder.ts';
import type { DeploymentPlan } from '../vcf/spec-builder.ts';
import { sizingToPlan } from '../vcf/bridge.ts';
import { sizeFromForm, SIZING_FORM_DEFAULTS } from './vcf-sizing-form.ts';

test('sizing profile and target version reach the installer plan', () => {
  const outcome=sizeFromForm({...SIZING_FORM_DEFAULTS,version:'9.1.0',profile:'ha-medium'});
  const inbound=sizingToPlan(outcome.result);
  const values={...FORM_DEFAULTS,...fieldsFromDeploymentPlan(inbound)};
  const plan=planFromForm(values,[],inbound);
  assert.equal(plan.version,'9.1.0.0');
  assert.equal(plan.sizePreset,'ha-medium');
  assert.equal(plan.hostCount,inbound.hostCount);
  assert.equal(plan.vcfmsPool?.count,inbound.vcfmsPool?.count);
});

test('all supplied network roles and advanced settings survive form assembly', () => {
  const inbound:Partial<DeploymentPlan>={
    version:'9.1.1.0',storage:'nfs',hostCount:4,
    management:{cidr:'10.1.0.0/24',vlanId:101,gateway:'10.1.0.254',mtu:1500},
    vmManagement:{cidr:'10.2.0.0/24',vlanId:102,gateway:'10.2.0.254',mtu:1500},
    vmotion:{cidr:'10.3.0.0/24',vlanId:103,mtu:9000,portGroupName:'existing-vmotion',ipRanges:[{startIpAddress:'10.3.0.20',endIpAddress:'10.3.0.23'}]},
    nfs:{cidr:'10.4.0.0/24',vlanId:104,gateway:'10.4.0.254',mtu:9000},
    hostTep:{cidr:'10.5.0.0/24',vlanId:105,gateway:'10.5.0.254'},
    dnsServers:['10.1.0.10','10.1.0.11'],ntpServers:['10.1.0.12'],pnicsPerHost:4,
    tepPool:{count:16},vcfmsPool:{count:20},
  };
  const fields=fieldsFromDeploymentPlan(inbound);
  const plan=planFromForm({...FORM_DEFAULTS,...fields},[],inbound);
  for(const key of ['management','vmManagement','vmotion','nfs','hostTep'] as const){
    for(const [property,value] of Object.entries(inbound[key]!))assert.deepEqual(plan[key]?.[property],value,key+'.'+property);
  }
  assert.equal(plan.pnicsPerHost,4);
  assert.equal(plan.tepPool?.count,16);
  const spec=buildSddcSpec(plan).spec;
  assert.equal(spec.version,'9.1.1.0');
  assert.ok(spec.networkSpecs?.some(network=>network.networkType==='NFS'&&network.subnet==='10.4.0.0/24'));
  assert.equal(JSON.stringify(spec).includes('10.5.0.254'),true);
});

test('partial prefill does not replace unrelated values or introduce credentials', () => {
  assert.deepEqual(fieldsFromDeploymentPlan({hostCount:8}),{hostCount:'8'});
  assert.equal(Object.keys(fieldsFromDeploymentPlan({passwords:{opsRoot:'test-only'}})).length,0);
});

test('installer file requires completed credentials while draft remains available', () => {
  const built=buildSddcSpec(planFromForm(FORM_DEFAULTS));
  assert.equal(installerExportReady(built.findings),false);
  assert.equal(installerExportReady([]),true);
  assert.equal(installerExportReady([{code:'other',severity:'warning',message:'Review'}]),true);
  assert.equal(installerExportReady([{code:'other',severity:'error',message:'Invalid'}]),false);
});
