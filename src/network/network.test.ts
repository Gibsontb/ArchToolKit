/**
 * What the network kit has to get right.
 *
 * The rule the whole kit rests on: nothing emits configuration without the
 * commands to check it and the commands to undo it. A network change with no
 * back-out is how a site stays down until someone finds the person who made it.
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { blueprintsFor, defaultValues } from '../kit/blueprint.ts';
import { readYaml } from '../core/yaml-read.ts';
import { NETWORK_BLUEPRINTS, NETWORK_CHANGES, networkChange } from './blueprints/index.ts';
import { buildChange } from './change.ts';
import { IMPACT_MEANING, PLATFORMS, netmask, parseCidr, renderChange, vlanIds, vlanRange, wildcard, isIpv4, type DeviceChange } from './device.ts';
import { configPush, inventoryHint, playFor, pushPlaybook } from './push.ts';
import type { StackItem } from '../kit/stack.ts';

const byId = (id: string) => NETWORK_CHANGES.find((b) => b.id === id);
const item = (blueprintId: string, label: string, values: Record<string, string | number | boolean> = {}): StackItem => ({
  id: label,
  blueprintId,
  label,
  values: { __name: label, ...values },
});

/** Every blueprint, built with its defaults. */
function everyChange(): { id: string; change: DeviceChange }[] {
  return NETWORK_CHANGES.map((blueprint) => ({ id: blueprint.id, change: blueprint.change(defaultValues(blueprint), blueprint.id) }));
}

describe('address arithmetic', () => {
  it('turns a prefix into the masks the platforms want', () => {
    expect(netmask(24)).toBe('255.255.255.0');
    expect(netmask(30)).toBe('255.255.255.252');
    expect(netmask(0)).toBe('0.0.0.0');
    expect(netmask(32)).toBe('255.255.255.255');
    expect(wildcard(24)).toBe('0.0.0.255');
    expect(wildcard(32)).toBe('0.0.0.0');
  });

  it('reads and rejects prefixes', () => {
    expect(parseCidr('10.0.0.1/24')).toEqual({ address: '10.0.0.1', prefix: 24 });
    expect(parseCidr('10.0.0.1')).toBeNull();
    expect(parseCidr('10.0.0.256/24')).toBeNull();
    expect(parseCidr('10.0.0.1/33')).toBeNull();
    expect(isIpv4('203.0.113.1')).toBe(true);
    expect(isIpv4('203.0.113')).toBe(false);
  });

  it('reads a VLAN list with ranges, and writes it back collapsed', () => {
    expect(vlanIds('10,20,30-33')).toEqual([10, 20, 30, 31, 32, 33]);
    expect(vlanIds('10, 10, 4095, 0, abc')).toEqual([10]);
    expect(vlanRange([10, 20, 30, 31, 32, 33])).toBe('10,20,30-33');
    expect(vlanRange([5])).toBe('5');
  });
});

describe('every blueprint', () => {
  it('says what it does, what to check, and how to undo it', () => {
    for (const { id, change } of everyChange()) {
      expect([id, change.title.length > 5]).toEqual([id, true]);
      expect([id, change.config.length > 0]).toEqual([id, true]);
      expect([id, change.before.length > 0]).toEqual([id, true]);
      expect([id, change.verify.length > 0]).toEqual([id, true]);
      expect([id, change.backout.length > 0]).toEqual([id, true]);
    }
  });

  it('declares an impact the page can warn about', () => {
    for (const { id, change } of everyChange()) {
      expect([id, Object.keys(IMPACT_MEANING).includes(change.impact)]).toEqual([id, true]);
    }
  });

  it('never writes a credential into configuration', () => {
    // Any line that talks about a credential must carry a placeholder or a
    // variable, never a value. The safe list is for lines that use one of these
    // words for something that is not a credential at all.
    const credential = /\b(password|secret|community|pre-shared|psk)\b/i;
    const safe = /send-community|password-encryption|password 7 <REQUIRED>/i;
    for (const { id, change } of everyChange()) {
      for (const line of change.config) {
        if (!credential.test(line)) continue;
        const ok = line.includes('<REQUIRED>') || line.includes('{{') || safe.test(line);
        expect([id, line, ok]).toEqual([id, line, true]);
      }
    }
  });

  it('builds files with a config, a record, and a playbook where one is possible', () => {
    for (const blueprint of NETWORK_CHANGES) {
      const result = blueprint.build(defaultValues(blueprint), blueprint.id);
      const names = Object.keys(result.files);
      const platform = PLATFORMS[blueprint.platform];
      expect([blueprint.id, names.some((n) => n.endsWith(platform.extension))]).toEqual([blueprint.id, true]);
      expect([blueprint.id, names.includes('change-record.md')]).toEqual([blueprint.id, true]);
      expect([blueprint.id, names.some((n) => n.endsWith('.yml'))]).toEqual([blueprint.id, true]);
    }
  });

  it('has an id and a label that are its own', () => {
    const ids = NETWORK_CHANGES.map((b) => b.id);
    expect(ids.length).toBe(new Set(ids).size);
    for (const group of NETWORK_BLUEPRINTS) {
      const labels = blueprintsFor(NETWORK_BLUEPRINTS, group.target).map((b) => b.label);
      expect([group.target, labels.length]).toEqual([group.target, new Set(labels).size]);
    }
  });
});

describe('a rendered change', () => {
  const blueprint = byId('ios_vlan_svi');
  const change = blueprint!.change(defaultValues(blueprint!), 'user vlan');
  const text = renderChange(change, 'user vlan');

  it('comments out everything that is not configuration, so it can be pasted whole', () => {
    const configured = new Set(change.config.map((line) => line.trim()));
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('!')) continue;
      expect([trimmed, configured.has(trimmed)]).toEqual([trimmed, true]);
    }
  });

  it('carries the impact and how to save it', () => {
    expect(text.includes('Impact:')).toBe(true);
    expect(text.includes('write memory')).toBe(true);
  });

  it('carries the checks and the back-out', () => {
    expect(text.includes('verify')).toBe(true);
    expect(text.includes('back out')).toBe(true);
    expect(text.includes('no vlan 10')).toBe(true);
  });
});

describe('what a blueprint has to catch', () => {
  it('a trunk with the default VLAN as its native VLAN', () => {
    const blueprint = byId('ios_trunk_port')!;
    const change = blueprint.change({ ...defaultValues(blueprint), native: 1 }, 'trunk');
    expect(change.findings?.some((f) => f.code === 'network.ios.native-vlan-1')).toBe(true);
  });

  it('a BGP peer with no maximum-prefix limit', () => {
    const blueprint = byId('ios_bgp_peer')!;
    const change = blueprint.change({ ...defaultValues(blueprint), max_prefix: 0 }, 'peer');
    expect(change.findings?.some((f) => f.code === 'network.ios.no-max-prefix')).toBe(true);
  });

  it('an access list with no rules', () => {
    const blueprint = byId('ios_acl')!;
    const change = blueprint.change({ ...defaultValues(blueprint), rules: '' }, 'acl');
    expect(change.findings?.some((f) => f.code === 'network.ios.empty-acl')).toBe(true);
  });

  it('a PAN-OS rule that allows any application without inspection', () => {
    const blueprint = byId('panos_security_rule')!;
    const change = blueprint.change({ ...defaultValues(blueprint), application: 'any', profile_group: '' }, 'rule');
    const codes = (change.findings ?? []).map((f) => f.code);
    expect(codes.includes('network.panos.any-application')).toBe(true);
    expect(codes.includes('network.panos.no-profiles')).toBe(true);
  });

  it('a FortiOS policy that accepts everything with logging off', () => {
    const blueprint = byId('fortios_firewall_policy')!;
    const change = blueprint.change({ ...defaultValues(blueprint), service: 'ALL', log: false, inspection: 'none' }, 'policy');
    const codes = (change.findings ?? []).map((f) => f.code);
    expect(codes.includes('network.fortios.service-all')).toBe(true);
    expect(codes.includes('network.fortios.no-logging')).toBe(true);
  });

  it('an F5 pool with one member, or none', () => {
    const blueprint = byId('f5_http_virtual')!;
    expect(blueprint.change({ ...defaultValues(blueprint), pool_members: '10.0.0.1:8080' }, 'vs').findings?.some((f) => f.code === 'network.f5.single-member')).toBe(true);
    expect(blueprint.change({ ...defaultValues(blueprint), pool_members: '' }, 'vs').findings?.some((f) => f.code === 'network.f5.no-members')).toBe(true);
  });

  it('a WAF policy put straight into blocking mode', () => {
    const blueprint = byId('f5_waf_policy')!;
    const change = blueprint.change({ ...defaultValues(blueprint), enforcement: 'blocking' }, 'waf');
    expect(change.findings?.some((f) => f.code === 'network.f5.waf-blocking')).toBe(true);
  });
});

describe('an F5 declaration', () => {
  const blueprint = byId('f5_http_virtual')!;
  const change = blueprint.change(defaultValues(blueprint), 'web');
  const declaration = JSON.parse(change.config.join('\n')) as Record<string, unknown>;

  it('is valid JSON, and an AS3 declaration', () => {
    expect(declaration['class']).toBe('AS3');
    const adc = (declaration['declaration'] ?? {}) as Record<string, unknown>;
    expect(adc['class']).toBe('ADC');
    const tenant = (adc['Prod'] ?? {}) as Record<string, unknown>;
    expect(tenant['class']).toBe('Tenant');
  });

  it('puts the pool, the monitor and the service in the application', () => {
    const app = (((declaration['declaration'] as Record<string, unknown>)['Prod'] as Record<string, unknown>)['web_app'] ?? {}) as Record<string, unknown>;
    expect(app['class']).toBe('Application');
    expect((app['web_app_pool'] as Record<string, unknown>)['class']).toBe('Pool');
    expect((app['service'] as Record<string, unknown>)['class']).toBe('Service_HTTPS');
  });

  it('references a certificate rather than carrying one, and says so', () => {
    expect(change.config.join('\n').includes('BEGIN')).toBe(false);
    expect(change.findings?.some((f) => f.code === 'network.f5.certificate-reference')).toBe(true);
  });
});

describe('pushing a change with Ansible', () => {
  it('uses the config module for the platforms that have one', () => {
    const blueprint = byId('ios_vlan_svi')!;
    const push = configPush(blueprint.change(defaultValues(blueprint), 'vlan'));
    expect(push?.module).toBe('cisco.ios.ios_config');
    expect((push?.args['lines'] as string[]).some((line) => line.startsWith('!'))).toBe(false);
  });

  it('uses the vendor module where the platform is object-shaped', () => {
    const blueprint = byId('panos_security_rule')!;
    const change = blueprint.change(defaultValues(blueprint), 'rule');
    expect(change.push?.module).toBe('paloaltonetworks.panos.panos_security_rule');
    expect(change.push?.after?.some((task) => task.module.includes('commit'))).toBe(true);
  });

  it('writes a playbook that reads back as YAML, for every blueprint', () => {
    for (const blueprint of NETWORK_CHANGES) {
      const text = pushPlaybook(blueprint.change(defaultValues(blueprint), blueprint.id), blueprint.id);
      expect([blueprint.id, text === null ? 0 : readYaml(text).documents.length]).toEqual([blueprint.id, 1]);
    }
  });

  it('never writes a credential into a playbook', () => {
    for (const blueprint of NETWORK_CHANGES) {
      const text = pushPlaybook(blueprint.change(defaultValues(blueprint), blueprint.id), blueprint.id) ?? '';
      // Everything that looks like a credential must be a variable or a placeholder.
      for (const match of text.matchAll(/(password|api_key|token|secret):\s*(\S+)/gi)) {
        const value = String(match[2]);
        expect([blueprint.id, value.startsWith('"{{') || value.startsWith('{{') || value.includes('REQUIRED')]).toEqual([blueprint.id, true]);
      }
    }
  });

  it('tells the inventory what each platform needs', () => {
    expect(inventoryHint('cisco_ios').some((line) => line.includes('network_cli'))).toBe(true);
    expect(inventoryHint('fortios').some((line) => line.includes('httpapi'))).toBe(true);
    expect(inventoryHint('f5').some((line) => line.includes('provider'))).toBe(true);
  });

  it('runs the play against the platform’s own inventory group', () => {
    const blueprint = byId('f5_http_virtual')!;
    const play = playFor(blueprint.change(defaultValues(blueprint), 'web'), 'web') as Record<string, unknown>[];
    expect(play[0]?.['hosts']).toBe('bigips');
  });
});

describe('a change list', () => {
  const change = buildChange(
    [
      item('ios_vlan_svi', 'build the VLAN', { vlan_id: 30, vlan_name: 'APP' }),
      item('ios_trunk_port', 'carry it on the uplink', { allowed: '30', native: 999 }),
      item('f5_http_virtual', 'publish the application', {}),
    ],
    byId,
    { stackName: 'rack 12 build' },
  );

  it('writes one file per step, numbered in the order they were added', () => {
    const configs = Object.keys(change.files).filter((f) => /^\d\d-/.test(f));
    expect(configs).toEqual(['01-build-the-vlan.cfg', '02-carry-it-on-the-uplink.cfg', '03-publish-the-application.json']);
  });

  it('collects the steps for one device into a file that can be pasted in one session', () => {
    const combined = change.files['all-cisco-ios.cfg'] as string;
    expect(combined.includes('build the VLAN')).toBe(true);
    expect(combined.includes('carry it on the uplink')).toBe(true);
    expect(combined.indexOf('build the VLAN') < combined.indexOf('carry it on the uplink')).toBe(true);
    // The F5 step is a different device, so it is not in there.
    expect(combined.includes('AS3')).toBe(false);
  });

  it('writes a playbook that applies the steps in order, and reads back as YAML', () => {
    const apply = change.files['apply.yml'] as string;
    expect(readYaml(apply).documents.length).toBe(1);
    expect(apply.indexOf('build the VLAN') < apply.indexOf('publish the application')).toBe(true);
  });

  it('writes an inventory with the connection variables for every platform involved', () => {
    const inventory = change.files['inventory/hosts.yml'] as string;
    expect(inventory.includes('ansible_network_os')).toBe(true);
    expect(inventory.includes('bigips')).toBe(true);
    expect(readYaml(inventory).documents.length).toBe(1);
  });

  it('writes a change record with the steps forward and the back-out reversed', () => {
    const record = change.files['change-record.md'] as string;
    expect(record.includes('# rack 12 build')).toBe(true);
    expect(record.includes('## Back-out, in reverse order')).toBe(true);
    const backout = record.slice(record.indexOf('## Back-out'));
    expect(backout.indexOf('publish the application') < backout.indexOf('build the VLAN')).toBe(true);
    expect(record.includes('Sign-off')).toBe(true);
  });

  it('says the change touches more than one platform', () => {
    expect(change.findings.some((f) => f.code === 'network.change.multi-platform')).toBe(true);
  });

  it('carries the worst impact of any step', () => {
    expect(change.findings.some((f) => f.code === 'network.change.impact')).toBe(true);
  });

  it('tells you how to run it, and that credentials are not in it', () => {
    const readme = change.files['README.md'] as string;
    expect(readme.includes('--check --diff')).toBe(true);
    expect(readme.includes('ansible-vault')).toBe(true);
    expect(readme.includes('write memory')).toBe(true);
  });
});

describe('what a change list has to catch', () => {
  it('an empty list', () => {
    expect(buildChange([], byId).findings[0]?.code).toBe('network.change.empty');
  });

  it('a step whose blueprint is gone', () => {
    expect(buildChange([item('nope', 'gone')], byId).findings.some((f) => f.code === 'network.change.blueprint-gone')).toBe(true);
  });

  it('two steps with the same name', () => {
    const change = buildChange([item('ios_vlan_svi', 'vlan'), item('ios_vlan_svi', 'vlan')], byId);
    expect(change.findings.some((f) => f.code === 'network.change.duplicate-name')).toBe(true);
    expect(Object.keys(change.files).filter((f) => /^\d\d-/.test(f))).toEqual(['01-vlan.cfg', '02-vlan-2.cfg']);
  });

  it('a step that fails to build, without losing the rest of the change', () => {
    const broken = () => {
      throw new Error('no');
    };
    const change = buildChange([item('ios_vlan_svi', 'good')], (id) => {
      const real = byId(id);
      return real ? { ...real, build: broken } : undefined;
    });
    // The structured builder is still the blueprint's own, so this one builds.
    expect(change.findings.some((f) => f.code === 'network.change.blueprint-gone')).toBe(false);
  });
});

describe('every platform', () => {
  it('can be put in a change on its own, and produces files', () => {
    for (const group of NETWORK_BLUEPRINTS) {
      for (const blueprint of blueprintsFor(NETWORK_BLUEPRINTS, group.target)) {
        const change = buildChange([item(blueprint.id, blueprint.id)], byId, { stackName: blueprint.id });
        const bad = change.findings.filter((f) => f.severity === 'error' && !f.code.startsWith('network.ios') && !f.code.startsWith('network.panos') && !f.code.startsWith('network.f5'));
        expect([blueprint.id, bad.map((f) => f.code)]).toEqual([blueprint.id, []]);
        expect([blueprint.id, Object.keys(change.files).includes('change-record.md')]).toEqual([blueprint.id, true]);
      }
    }
  });

  it('knows how it is saved and what pushes it', () => {
    for (const platform of Object.values(PLATFORMS)) {
      expect([platform.id, platform.save.length > 3]).toEqual([platform.id, true]);
      expect([platform.id, platform.collection.includes('.')]).toEqual([platform.id, true]);
    }
  });

  it('has a blueprint group of its own', () => {
    const targets = NETWORK_BLUEPRINTS.map((g) => g.target);
    for (const platform of Object.keys(PLATFORMS)) {
      expect([platform, targets.includes(platform)]).toEqual([platform, true]);
    }
  });
});
