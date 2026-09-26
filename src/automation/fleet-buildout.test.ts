/**
 * The fleet build-out: workload domains, clusters, network pools, host
 * decommission, VCF Import, Avi controllers (vcf-fleet-91-domains.ts), the
 * enhanced precheck that replaced the SDDC Manager upgrade precheck, and the
 * deepened 9.1 fleet management blueprints.
 *
 * Every blueprint here is built with its defaults and with every select option
 * and every toggle flipped; the output has to keep the contract, parse, name
 * no retired product and hold no credential. Then the traps each one exists to
 * catch have to fire.
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { defaultValues, type BlueprintValues } from '../kit/blueprint.ts';
import { hasErrors } from '../core/findings.ts';
import { automationFor } from './blueprints/index.ts';
import type { AutomationBlueprint } from './from-automation.ts';

const NEW = ['fleet_network_pool', 'fleet_domain_create', 'fleet_cluster', 'fleet_host_decommission', 'fleet_vcf_import', 'fleet_avi_deploy'];
const CHANGED = ['fleet_upgrade_precheck', 'fleet_host_commission', 'fleet91_password_rotate', 'fleet91_certificates', 'fleet91_licensing', 'fleet91_lifecycle', 'fleet91_identity', 'fleet91_config_drift'];

function bp(id: string): AutomationBlueprint {
  const blueprint = automationFor(id);
  if (!blueprint) throw new Error(`missing ${id}`);
  return blueprint;
}

function variants(blueprint: AutomationBlueprint): { label: string; values: BlueprintValues }[] {
  const base = defaultValues(blueprint);
  const out = [{ label: 'defaults', values: { ...base } as BlueprintValues }];
  for (const input of blueprint.inputs) {
    if (input.control === 'select') for (const option of input.options ?? []) out.push({ label: `${input.id}=${option.value}`, values: { ...base, [input.id]: option.value } });
    if (input.control === 'toggle') out.push({ label: `${input.id}=${String(!base[input.id])}`, values: { ...base, [input.id]: !base[input.id] } });
  }
  return out;
}

const build = (id: string, overrides: Record<string, string | number | boolean> = {}) => bp(id).build({ ...defaultValues(bp(id)), ...overrides }, id);
const codes = (id: string, overrides: Record<string, string | number | boolean> = {}) => (build(id, overrides).findings ?? []).map((f) => f.code);
const allCodes = (id: string, overrides: Record<string, string | number | boolean> = {}) => (bp(id).automation({ ...defaultValues(bp(id)), ...overrides }, id).findings ?? []).map((f) => f.code);

describe('fleet build-out: every new and changed blueprint, every option', () => {
  it('exists on the fleet platform', () => {
    for (const id of [...NEW, ...CHANGED]) expect(bp(id).platform).toBe('vcf-fleet');
  });

  it('keeps the contract, parses, and writes no credential or retired name whichever option is picked', () => {
    const credential = /\b(password|passwd|secret|api[_-]?key|token|credential)\w*\s*[:=]+\s*["'][^"'$%{<@]/i;
    const problems: string[] = [];
    for (const id of [...NEW, ...CHANGED]) {
      const blueprint = bp(id);
      for (const { label, values } of variants(blueprint)) {
        const where = `${id} (${label})`;
        let automation;
        try {
          automation = blueprint.automation(values, id);
        } catch (failure) {
          problems.push(`${where}: threw ${String(failure)}`);
          continue;
        }
        if (!automation.trigger.detail || !automation.scope.what || automation.scope.decidedBy.length === 0 || automation.undo.length === 0 || automation.told.length === 0) problems.push(`${where}: contract field empty`);
        if (automation.effect !== 'read' && (automation.guardrails.length === 0 || automation.dryRun.length === 0)) problems.push(`${where}: acts with no guardrail or dry run`);
        const files = blueprint.build(values, id).files;
        if (!files['IMPORT.md']?.startsWith('# Importing this into ')) problems.push(`${where}: no IMPORT.md`);
        for (const [file, text] of Object.entries(files)) {
          if (file.endsWith('.json')) {
            try {
              JSON.parse(text);
            } catch (err) {
              problems.push(`${where} ${file}: ${(err as Error).message}`);
            }
          }
          if (credential.test(text)) problems.push(`${where} ${file}: credential literal`);
          // README.md carries the shared platform line ("formerly …"), which is automation.ts's, not these blueprints'.
          if (file !== 'README.md' && /\bESXi\b|\bAria\b|vRealize|vROps|Service Broker|ArchToolKit|archtoolkit/.test(text)) problems.push(`${where} ${file}: retired name or footprint`);
          if (/\.sh$/.test(file) && !text.startsWith('#!/usr/bin/env bash')) problems.push(`${where} ${file}: not a bash script`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('builds clean from the defaults', () => {
    for (const id of [...NEW, ...CHANGED]) {
      const out = build(id);
      if (hasErrors(out.findings ?? [])) throw new Error(`${id}: ${(out.findings ?? []).filter((f) => f.severity === 'error').map((f) => f.code).join(', ')}`);
    }
  });
});

describe('fleet build-out: workload domain, cluster and network pool', () => {
  it('creates a workload domain by validating first, with secrets only from files', () => {
    const files = build('fleet_domain_create').files;
    const script = files['create-domain.sh']!;
    expect(script.indexOf('/v1/domains/validations') < script.indexOf('POST /v1/domains --data')).toBe(true);
    expect(/VC_ROOT_PASSWORD_FILE/.test(script) && /need_private/.test(script)).toBe(true);
    const spec = JSON.parse(files['domain-spec.json']!) as Record<string, any>;
    expect(spec.vcenterSpec.rootPassword).toBe(undefined);
    expect(spec.nsxTSpec.nsxManagerSpecs.length).toBe(3);
    expect(spec.computeSpec.clusterSpecs[0].datastoreSpec.vsanDatastoreSpec.esaConfig.enabled).toBe(true);
  });

  it('writes LACP (9.1) into the VDS and maps the NICs to the LAG', () => {
    const files = build('fleet_domain_create', { lacp: 'ACTIVE' }).files;
    const spec = JSON.parse(files['domain-spec.json']!) as Record<string, any>;
    expect(spec.computeSpec.clusterSpecs[0].networkSpec.vdsSpecs[0].lagSpecs[0].lacpMode).toBe('ACTIVE');
    expect((JSON.parse(files['hosts.json']!) as any[])[0].vmNics[0].uplink).toBe('lag1-0');
  });

  it('shares an NSX Manager, joins or isolates SSO, and can leave the cluster out', () => {
    const join = JSON.parse(build('fleet_domain_create', { nsx: 'join' }).files['domain-spec.json']!) as Record<string, any>;
    expect(join.nsxTSpec.nsxManagerSpecs).toBe(undefined);
    expect(typeof join.nsxTSpec.vipFqdn).toBe('string');
    expect('ssoDomainSpec' in (JSON.parse(build('fleet_domain_create', { sso: 'isolated' }).files['domain-spec.json']!) as object)).toBe(true);
    expect('computeSpec' in (JSON.parse(build('fleet_domain_create', { first_cluster: 'without' }).files['domain-spec.json']!) as object)).toBe(false);
  });

  it('catches the domain mistakes that surface hours in', () => {
    expect(codes('fleet_domain_create', { domain_name: 'x' })).toContain('fleet.domain.name');
    expect(codes('fleet_domain_create', { gateway: '10.9.9.1' })).toContain('fleet.domain.gateway-subnet');
    expect(codes('fleet_domain_create', { nsx_nodes: 'a | a.example.com | 10.0.10.31' })).toContain('fleet.domain.nsx-nodes');
    expect(codes('fleet_domain_create', { hosts: 'esx05.example.com\nesx06.example.com' })).toContain('fleet.domain.cluster.vsan-min');
    expect(codes('fleet_domain_create', { tep_range: '172.16.99.1-172.16.99.9' })).toContain('fleet.domain.cluster.tep.range');
    expect(codes('fleet_domain_create', { mtu: 1500 })).toContain('fleet.domain.cluster.mtu');
    expect(codes('fleet_domain_create', { vc_ip: '2001:db8:10::20', gateway: '2001:db8:10::1', mask: '64', nsx: 'join' })).toContain('fleet.domain.ipv6');
  });

  it('adds, expands and shrinks a cluster, each validated first', () => {
    const create = build('fleet_cluster').files;
    expect(/\/v1\/clusters\/validations/.test(create['cluster.sh']!) && 'cluster-spec.json' in create).toBe(true);
    expect(/clusterExpansionSpec/.test(build('fleet_cluster', { mode: 'expand' }).files['cluster.sh']!)).toBe(true);
    const shrink = build('fleet_cluster', { mode: 'shrink', hosts: 'esx08.example.com' }).files['cluster.sh']!;
    expect(/clusterCompactionSpec/.test(shrink) && /MIN_HOSTS=3/.test(shrink)).toBe(true);
    expect(codes('fleet_cluster', { mode: 'shrink', force: true })).toContain('fleet.cluster.force');
    expect(codes('fleet_cluster', { storage: 'NFS', nfs_path: 'relative' })).toContain('fleet.cluster.nfs');
  });

  it('builds a network pool, checks every range, and takes IPv6 with a VERIFY', () => {
    const pool = JSON.parse(build('fleet_network_pool').files['network-pool.json']!) as { networks: { type: string; mask: string }[] };
    expect(pool.networks.map((n) => n.type)).toEqual(['VMOTION', 'VSAN']);
    expect(pool.networks[0]!.mask).toBe('255.255.255.0');
    expect(codes('fleet_network_pool', { networks: 'VSAN | 1613 | 9000 | 172.16.13.0/24 | 172.16.13.1 | 172.16.13.10-172.16.13.20' })).toContain('fleet.pool.no-vmotion');
    expect(codes('fleet_network_pool', { networks: 'VMOTION | 5000 | 9000 | 172.16.12.0/24 | 172.16.12.1 | 172.16.12.10-172.16.12.20' })).toContain('fleet.pool.vlan');
    expect(codes('fleet_network_pool', { networks: 'VMOTION | 1612 | 9000 | 172.16.12.0/24 | 172.16.12.1 | 172.16.12.1-172.16.12.20' })).toContain('fleet.pool.gateway-in-range');
    const v6 = 'VMOTION | 1612 | 9000 | 2001:db8:12::/64 | 2001:db8:12::1 | 2001:db8:12::100-2001:db8:12::1ff';
    expect(codes('fleet_network_pool', { networks: v6 })).toContain('fleet.pool.ipv6');
    expect(hasErrors(build('fleet_network_pool', { networks: v6 }).findings ?? [])).toBe(false);
    expect((JSON.parse(build('fleet_network_pool', { networks: v6 }).files['network-pool.json']!) as { networks: { mask: string }[] }).networks[0]!.mask).toBe('64');
  });
});

describe('fleet build-out: hosts, import and Avi', () => {
  it('decommissions only hosts in no cluster, under a cap, saving each record first', () => {
    const script = build('fleet_host_decommission').files['decommission.sh']!;
    expect(/DELETE \/v1\/hosts/.test(script) && /hosts-before-/.test(script) && /cluster\.id != null/.test(script)).toBe(true);
    expect(codes('fleet_host_decommission', { hosts: 'a.example.com\nb.example.com\nc.example.com', max_hosts: 2 })).toContain('fleet.decommission.too-many');
  });

  it('imports through check, then precheck, then import, and writes no password', () => {
    const script = build('fleet_vcf_import').files['vcf-import.sh']!;
    expect(script.indexOf('run check') < script.indexOf('run precheck') && script.indexOf('run precheck') < script.indexOf('run import')).toBe(true);
    expect('nsx-deployment-spec.json' in build('fleet_vcf_import', { nsx: 'none' }).files).toBe(false);
    expect(codes('fleet_vcf_import', { operation: 'convert' })).toContain('fleet.import.convert');
  });

  it('deploys Avi controllers validated first, and points to Terraform for the Supervisor', () => {
    const out = bp('fleet_avi_deploy').automation(defaultValues(bp('fleet_avi_deploy')), 'x');
    expect(/nsx-alb-clusters\/validations/.test(out.files['avi-deploy.sh']!)).toBe(true);
    expect((out.notes ?? []).join(' ').includes('vsphere_supervisor')).toBe(true);
    expect(codes('fleet_avi_deploy', { nodes: 'a.example.com | 10.0.10.41' })).toContain('fleet.avi.nodes');
  });

  it('says ESX, not ESXi, and names each host password variable ESX_PW_', () => {
    const out = build('fleet_host_commission');
    expect(bp('fleet_host_commission').label.includes('ESXi')).toBe(false);
    expect(/ESX_PW_ESX05_EXAMPLE_COM/.test(out.files['hosts.json']!)).toBe(true);
  });
});

describe('fleet build-out: lifecycle and the enhanced precheck', () => {
  it('no longer calls the deprecated SDDC Manager upgrade precheck', () => {
    for (const { values } of variants(bp('fleet_upgrade_precheck'))) {
      // The scripts, not the README: its notes say which API was retired.
      const text = bp('fleet_upgrade_precheck').build(values, 'x').files['fleet-lifecycle.sh']!;
      expect(/\/v1\/system\/prechecks|check-sets/.test(text)).toBe(false);
      expect(/precheckType":"ENHANCED/.test(text)).toBe(true);
    }
    expect(bp('fleet_upgrade_precheck').automation(defaultValues(bp('fleet_upgrade_precheck')), 'x').effect).toBe('read');
  });

  it('prechecks the components, an instance or chosen hosts, and exports the result', () => {
    const script = build('fleet91_lifecycle', { part: 'precheck' }).files['fleet-lifecycle.sh']!;
    expect(/precheck-\$\{id\}-\$\{stamp\}/.test(script) && /\.csv/.test(script)).toBe(true);
    expect(/COMPONENTS='\["VCF_OPERATIONS"/.test(script)).toBe(true);
    expect(/LCM_HOSTS='\["esx05/.test(build('fleet91_lifecycle', { part: 'precheck', scope: 'STANDALONE_HOSTS' }).files['fleet-lifecycle.sh']!)).toBe(true);
    expect(codes('fleet91_lifecycle', { part: 'precheck', components: '' })).toContain('fleet91.lcm.no-components');
  });

  it('configures an online or offline depot, with its token from a file', () => {
    const online = build('fleet91_lifecycle', { part: 'depot', depot_proxy: 'http://proxy.example.com:3128' }).files;
    const depot = JSON.parse(online['depot-config.json']!) as Record<string, any>;
    expect(depot.depotType).toBe('ONLINE');
    expect(depot.proxy.port).toBe(3128);
    expect(/DEPOT_TOKEN_FILE/.test(online['fleet-lifecycle.sh']!)).toBe(true);
    expect((JSON.parse(build('fleet91_lifecycle', { part: 'depot', depot_mode: 'OFFLINE' }).files['depot-config.json']!) as any).offline.url).toBe('https://depot.example.com/PROD');
    expect(codes('fleet91_lifecycle', { part: 'depot', depot_proxy: 'http://user:pw@proxy:3128' })).toContain('fleet91.lcm.proxy-creds');
  });
});

describe('fleet build-out: passwords, certificates, licensing, identity, configuration', () => {
  it('rotates with Vault, remediates, and schedules auto-rotation', () => {
    const vault = build('fleet91_password_rotate', { source: 'vault' }).files['rotate-passwords.sh']!;
    expect(/vault kv get -field=password/.test(vault) && /vault kv patch .* password=-/.test(vault)).toBe(true);
    expect('remediate-passwords.sh' in build('fleet91_password_rotate', { mode: 'remediate' }).files).toBe(true);
    expect(/frequencyInDays/.test(build('fleet91_password_rotate', { mode: 'schedule' }).files['auto-rotate.sh']!)).toBe(true);
    expect(allCodes('fleet91_password_rotate', { mode: 'schedule', rotate_days: 7 })).toContain('fleet91.rotate.schedule-short');
  });

  it('replaces in bulk under a cap, signs with an OpenSSL CA, and turns on auto-renewal', () => {
    expect(codes('fleet91_certificates', { action: 'vmca', fqdn: 'a.example.com, b.example.com' })).toContain('fleet91.cert.too-many');
    expect('replace-all.sh' in build('fleet91_certificates', { action: 'vmca', fqdn: 'a.example.com, b.example.com', max_appliances: 2 }).files).toBe(true);
    const openssl = build('fleet91_certificates', { action: 'openssl' }).files['replace-certificate.sh']!;
    expect(/openssl x509 -req/.test(openssl) && /CA_KEY_FILE/.test(openssl)).toBe(true);
    expect('auto-renew.json' in build('fleet91_certificates', { action: 'autorenew' }).files).toBe(true);
    expect(/CA_CERT/.test(build('fleet91_certificates').files['certificate-report.sh']!)).toBe(true);
  });

  it('applies a license override and connected mode, refusing when the API does not answer', () => {
    const override = build('fleet91_licensing', { mode: 'override' }).files['license-override.sh']!;
    expect(/license-assignment/.test(override) && /exit 3/.test(override)).toBe(true);
    expect('license-mode.json' in build('fleet91_licensing', { mode: 'connected' }).files).toBe(true);
  });

  it('sets IAM token lifetimes and on-demand AD lookup', () => {
    expect((JSON.parse(build('fleet91_identity', { task: 'iam_settings' }).files['iam-settings.json']!) as any).accessTokenTtlMinutes).toBe(30);
    expect(codes('fleet91_identity', { task: 'iam_settings', access_minutes: 120, refresh_hours: 1 })).toContain('fleet91.identity.refresh-short');
    expect((JSON.parse(build('fleet91_identity', { task: 'ad_lookup' }).files['directory-lookup.json']!) as any).onDemandLookupEnabled).toBe(true);
  });

  it('enables configuration profiles checked first, and schedules the assessment enabled', () => {
    const profile = build('fleet91_config_drift', { mode: 'profile' }).files['enable-profile.sh']!;
    expect(profile.indexOf('checkEligibility') < profile.indexOf('action=enable')).toBe(true);
    const assess = build('fleet91_config_drift', { mode: 'assess' }).files;
    expect((JSON.parse(assess['assessment-schedule.json']!) as any).enabled).toBe(true);
    expect('detect-drift.sh' in assess).toBe(true);
    expect(assess['crontab.txt']!.split('\n').some((line) => line.trim() && !line.startsWith('#'))).toBe(true);
  });
});
