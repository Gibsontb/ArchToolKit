/**
 * Editing a spec that already deployed, against the anonymised 9.1.1.0 lab
 * export: paths, answer sets, find-and-replace, the change list, passwords.
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { LAB_911_THREE_HOST_FC } from './__fixtures__/real-specs.ts';
import { validateSddcSpec } from './spec-validate.ts';
import { hasErrors } from '../core/findings.ts';
import type { SddcSpec } from './spec-types.ts';
import {
  choicesFor,
  diff,
  findReplace,
  getAt,
  labelFor,
  moveAt,
  newEntry,
  parsePath,
  pathPattern,
  pathString,
  redactSecrets,
  removeAt,
  secretPaths,
  setAt,
  type Json,
} from './spec-edit.ts';

const LAB = LAB_911_THREE_HOST_FC as unknown as Json;

describe('paths', () => {
  it('reads and writes the way findings name fields', () => {
    expect(pathString(['networkSpecs', 2, 'subnet'])).toBe('networkSpecs[2].subnet');
    expect(parsePath('networkSpecs[2].subnet')).toEqual(['networkSpecs', 2, 'subnet']);
    expect(pathPattern(['hostSpecs', 1, 'credentials', 'username'])).toBe('hostSpecs[].credentials.username');
    expect(getAt(LAB, parsePath('hostSpecs[0].hostname'))).toBe('esx01.example.com');
  });

  it('never changes the document it was given', () => {
    const before = JSON.stringify(LAB);
    setAt(LAB, ['sddcId'], 'x');
    removeAt(LAB, ['hostSpecs', 0]);
    moveAt(LAB, ['hostSpecs', 0], 1);
    expect(JSON.stringify(LAB)).toBe(before);
  });

  it('moves and removes list entries', () => {
    const moved = moveAt(LAB, ['hostSpecs', 0], 1);
    expect(getAt(moved, ['hostSpecs', 1, 'hostname'])).toBe('esx01.example.com');
    const removed = removeAt(LAB, ['hostSpecs', 1]);
    expect((getAt(removed, ['hostSpecs']) as Json[]).length).toBe(2);
  });
});

describe('adding an entry', () => {
  it('copies the last one with its identity cleared', () => {
    const hosts = getAt(LAB, ['hostSpecs']) as Json[];
    const added = newEntry(hosts) as Record<string, Json>;
    expect(added.hostname).toBe('');
    expect(added.sslThumbprint).toBe('');
    expect((added.credentials as Record<string, Json>).username).toBe('root');
    expect((added.credentials as Record<string, Json>).password).toBe('');
  });
});

describe('answer sets', () => {
  it('turns every enumerated field in the lab spec into a dropdown with its value in it', () => {
    const walk = (node: Json, path: (string | number)[]): void => {
      if (typeof node === 'string') {
        const choices = choicesFor(path);
        if (choices && node !== '') expect(choices.includes(node)).toBe(true);
        return;
      }
      if (Array.isArray(node)) node.forEach((v, i) => walk(v, [...path, i]));
      else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, [...path, k]);
    };
    walk(LAB, []);
    expect(choicesFor(['vcenterSpec', 'storageSize'])).toEqual(['lstorage', 'xlstorage']);
    expect(choicesFor(['networkSpecs', 0, 'teamingPolicy'])?.includes('loadbalance_loadbased')).toBe(true);
  });
});

describe('find and replace', () => {
  it('re-addresses a subnet across every field that carries it', () => {
    const { doc, changes } = findReplace(LAB, '10.20.1.', '10.30.7.');
    expect(changes.length > 10).toBe(true);
    expect(JSON.stringify(doc).includes('10.20.1.')).toBe(false);
    expect(getAt(doc, parsePath('networkSpecs[0].gateway'))).toBe('10.30.7.1');
    // The re-addressed spec is still one the installer would take.
    expect(hasErrors(validateSddcSpec(doc as unknown as SddcSpec))).toBe(false);
  });

  it('changes values, never the field names', () => {
    const { doc } = findReplace(LAB, 'hostname', 'x');
    expect(getAt(doc, parsePath('hostSpecs[0].hostname'))).toBe('esx01.example.com');
  });
});

describe('the change list', () => {
  it('names each field that differs, and what was added or removed', () => {
    let doc = setAt(LAB, parsePath('hostSpecs[2].hostname'), 'esx05.example.com');
    doc = removeAt(doc, parsePath('hostSpecs[0]'));
    doc = setAt(doc, ['networkSpecs', 0, 'vlanId'], '1403');
    const changes = diff(LAB, doc);
    expect(changes.some((c) => c.path === 'networkSpecs[0].vlanId' && c.after === '1403')).toBe(true);
    expect(changes.some((c) => c.kind === 'removed' && c.path === 'hostSpecs[2]')).toBe(true);
    expect(diff(LAB, LAB).length).toBe(0);
  });

  it('catches the validator’s objection to a bad edit', () => {
    const doc = setAt(LAB, parsePath('networkSpecs[3].subnet'), '10.20.1.0/26');
    const findings = validateSddcSpec(doc as unknown as SddcSpec);
    expect(findings.some((f) => f.severity === 'error' && (f.path ?? '').startsWith('networkSpecs'))).toBe(true);
  });
});

describe('passwords', () => {
  it('finds the clear-text ones an installer export carries, and strips them', () => {
    expect(secretPaths(LAB).length).toBe(3);
    const redacted = redactSecrets(LAB);
    expect(secretPaths(redacted).length).toBe(0);
    expect(getAt(redacted, parsePath('hostSpecs[0].credentials.password'))).toBe('<REQUIRED>');
  });
});

describe('labels', () => {
  it('reads as English', () => {
    expect(labelFor('vcfOperationsCollectorSpec')).toBe('VCF Operations collector');
    expect(labelFor('nsxtManagerSize')).toBe('NSX manager size');
    expect(labelFor('internalClusterCidrIpv4')).toBe('Internal cluster CIDR IPv4');
    expect(labelFor('vlanId')).toBe('VLAN');
  });
});
