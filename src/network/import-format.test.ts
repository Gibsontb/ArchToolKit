/**
 * Every network change, as the zip unpacks: files each platform loads as they
 * stand.
 *
 *  - IOS / NX-OS / EOS / ASA / 9800: `!` is a comment to all of them, so the
 *    file keeps its notes commented out and pastes (or `copy … running-config`)
 *    whole. Plain ASCII, so a terminal or TFTP load takes it byte for byte.
 *  - PAN-OS: no comment syntax at all — a `#` line is "Unknown command" — so the
 *    file is `set` commands only.
 *  - FortiOS: `config … end` blocks only.
 *  - F5: an AS3 declaration that parses as JSON (class AS3 wrapping class ADC,
 *    schemaVersion, a Tenant) — no `//` header — or, for a tmsh/REST command,
 *    a shell script.
 *  - The playbook applies that same file (`src:` / `lookup('file', …)`), and
 *    ansible.cfg + inventory/hosts.yml are beside it.
 *
 * Across every select option and toggle.
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { defaultValues, type Blueprint, type BlueprintValues } from '../kit/blueprint.ts';
import { readYaml, type YamlData } from '../core/yaml-read.ts';
import { NETWORK_BLUEPRINTS, NETWORK_CHANGES } from './blueprints/index.ts';
import { buildChange } from './change.ts';
import { deviceFile, PLATFORMS, type Platform } from './device.ts';

function variants(blueprint: Blueprint): BlueprintValues[] {
  const base = defaultValues(blueprint);
  const out: BlueprintValues[] = [base];
  for (const input of blueprint.inputs) {
    if (input.control === 'toggle') out.push({ ...base, [input.id]: !(base[input.id] === true || base[input.id] === 'true') });
    if (input.control === 'select' && input.options && input.options.length <= 40) {
      for (const option of input.options) if (option.value !== base[input.id]) out.push({ ...base, [input.id]: option.value });
    }
  }
  return out;
}

const CLI = new Set<Platform>(['cisco_ios', 'cisco_nxos', 'cisco_wlc', 'cisco_asa', 'arista_eos']);

/** What the device would reject in its file, as messages. */
function deviceProblems(platform: Platform, name: string, text: string): string[] {
  const out: string[] = [];
  const lines = text.split('\n');
  if (platform === 'f5') {
    if (name.endsWith('.sh')) {
      if (!text.startsWith('#!/bin/sh\n')) out.push('shell script without a shebang');
      return out;
    }
    let declaration: Record<string, unknown> = {};
    try {
      declaration = JSON.parse(text) as Record<string, unknown>;
    } catch (err) {
      return [`not JSON: ${(err as Error).message}`];
    }
    const adc = (declaration['class'] === 'AS3' ? declaration['declaration'] : declaration) as Record<string, unknown> | undefined;
    if (!adc || adc['class'] !== 'ADC') out.push('no class ADC');
    if (typeof adc?.['schemaVersion'] !== 'string') out.push('no schemaVersion');
    const tenants = Object.values(adc ?? {}).filter((v) => typeof v === 'object' && v !== null && (v as Record<string, unknown>)['class'] === 'Tenant');
    if (tenants.length === 0) out.push('no Tenant');
    return out;
  }
  if (/[^\x00-\x7F]/.test(text)) out.push('non-ASCII characters');
  if (platform === 'panos') {
    for (const line of lines) {
      const t = line.trim();
      if (t !== '' && !/^(set|delete|edit|up|top|commit|exit|rename|move)\b/.test(t)) out.push(`not a PAN-OS configure-mode command: ${t}`);
    }
  }
  if (platform === 'fortios') {
    for (const line of lines) if (line.trim().startsWith('#')) out.push(`comment line: ${line.trim()}`);
    const opens = lines.filter((l) => /^\s*config\s/.test(l)).length;
    const ends = lines.filter((l) => /^\s*end\s*$/.test(l)).length;
    if (opens !== ends) out.push(`${opens} config blocks, ${ends} ends`);
  }
  if (CLI.has(platform)) {
    for (const line of lines) if (/^\s*(#|\/\/)/.test(line)) out.push(`comment in a syntax the device does not accept: ${line.trim()}`);
  }
  return out;
}

const isMap = (v: YamlData | undefined): v is { [key: string]: YamlData } => typeof v === 'object' && v !== null && !Array.isArray(v);

describe('every network change, as the device loads it', () => {
  const all = NETWORK_BLUEPRINTS.flatMap((group) => group.blueprints.map((blueprint) => ({ group, blueprint })));

  it('writes a file the platform takes as it stands, for every option', () => {
    for (const { blueprint } of all) {
      const platform = NETWORK_CHANGES.find((c) => c.id === blueprint.id)?.platform as Platform;
      for (const values of variants(blueprint)) {
        const files = blueprint.build(values, '').files;
        const device = Object.keys(files).filter((n) => !n.includes('/') && !/\.(md|yml|cfg\.bak)$/.test(n) && n !== 'ansible.cfg');
        expect([blueprint.id, device.length]).toEqual([blueprint.id, 1]);
        for (const name of device) expect([blueprint.id, name, deviceProblems(platform, name, files[name] ?? '')]).toEqual([blueprint.id, name, []]);
      }
    }
  });

  it('points the playbook at the file beside it, and ships the inventory it runs against', () => {
    for (const { blueprint } of all) {
      const files = blueprint.build(defaultValues(blueprint), '').files;
      const playbook = files['change.yml'];
      if (!playbook) continue;
      const plays = readYaml(playbook).documents[0];
      expect([blueprint.id, Array.isArray(plays)]).toEqual([blueprint.id, true]);
      for (const m of playbook.matchAll(/^\s+src:\s*(\S+)/gm)) expect([blueprint.id, m[1] as string in files]).toEqual([blueprint.id, true]);
      for (const m of playbook.matchAll(/lookup\(''file'', ''([^']+)''\)/g)) expect([blueprint.id, m[1] as string in files]).toEqual([blueprint.id, true]);
      expect([blueprint.id, /\blines:/.test(playbook) && /_config:/.test(playbook)]).toEqual([blueprint.id, false]);
      expect([blueprint.id, files['ansible.cfg']?.includes('inventory = inventory/hosts.yml')]).toEqual([blueprint.id, true]);
      const inventory = readYaml(files['inventory/hosts.yml'] ?? '').documents[0];
      const hosts = /^\s*hosts:\s*(\S+)/m.exec(playbook)?.[1] ?? '';
      const children = isMap(inventory) && isMap(inventory['all']) && isMap(inventory['all']['children']) ? inventory['all']['children'] : {};
      expect([blueprint.id, hosts in children]).toEqual([blueprint.id, true]);
      // A credential is only ever a vault variable.
      expect([blueprint.id, /(password|secret|token|key)\w*:\s*(?!'\{\{)[^\s{'"][^\n]*$/im.test(files['inventory/hosts.yml'] ?? '')]).toEqual([blueprint.id, false]);
    }
  });

  it('deploys AS3 with the collection that has the module, over httpapi', () => {
    for (const { blueprint } of all) {
      const playbook = blueprint.build(defaultValues(blueprint), '').files['change.yml'] ?? '';
      if (!playbook.includes('bigip_as3_deploy')) continue;
      expect([blueprint.id, playbook.includes('f5networks.f5_bigip.bigip_as3_deploy:')]).toEqual([blueprint.id, true]);
      const task = playbook.slice(playbook.indexOf('bigip_as3_deploy:'));
      expect([blueprint.id, /\n\s+provider:/.test(task.slice(0, task.indexOf('register:')))]).toEqual([blueprint.id, false]);
    }
  });
});

describe('a change list', () => {
  it('writes the per-step and whole-device files in the form the device loads', () => {
    const lookup = (id: string) => NETWORK_BLUEPRINTS.flatMap((g) => g.blueprints).find((b) => b.id === id);
    const pick = (platform: Platform) => NETWORK_CHANGES.filter((c) => c.platform === platform).slice(0, 3);
    for (const platform of Object.keys(PLATFORMS) as Platform[]) {
      const items = pick(platform).map((c, i) => ({ id: `i${i}`, blueprintId: c.id, label: `${c.id} step`, values: {} }));
      const built = buildChange(items, lookup, { stackName: 'build' });
      for (const [name, text] of Object.entries(built.files)) {
        if (name.includes('/') || /\.(md|yml)$/.test(name) || name === 'ansible.cfg') continue;
        expect([platform, name, deviceProblems(platform, name, text)]).toEqual([platform, name, []]);
      }
      const apply = built.files['apply.yml'] ?? '';
      for (const m of apply.matchAll(/^\s+src:\s*(\S+)/gm)) expect([platform, m[1] as string in built.files]).toEqual([platform, true]);
      for (const m of apply.matchAll(/lookup\(''file'', ''([^']+)''\)/g)) expect([platform, m[1] as string in built.files]).toEqual([platform, true]);
    }
  });

  it('strips comments only where the platform does not accept them', () => {
    expect(deviceFile('cisco_ios', '! note\ninterface Gi1\n')).toBe('! note\ninterface Gi1\n');
    expect(deviceFile('panos', '# note\nset address a ip-netmask 10.0.0.1/32\n')).toBe('set address a ip-netmask 10.0.0.1/32\n');
    expect(deviceFile('f5', '// note\n{"class": "AS3"}\n')).toBe('{"class": "AS3"}\n');
    expect(deviceFile('cisco_ios', 'description a — b\n')).toBe('description a - b\n');
  });
});
