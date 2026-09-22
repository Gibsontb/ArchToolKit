/**
 * Settings files: the same values back from JSON, YAML and TXT, and a file
 * from the wrong page, or with a password in it, handled.
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { envelope, formatFor, fromTxt, openEnvelope, readSettings, SETTINGS_KINDS, stripSecrets, toTxt, writeSettings } from './settings-file.ts';
import type { Json } from '../editor/doc.ts';

const VALUES = {
  kind: 'archtoolkit.terraform-generator',
  version: 1,
  target: 'aws',
  blueprint: 'aws-vpc',
  values: {
    __name: 'prod vpc',
    cidr: '10.0.0.0/16',
    azs: 3,
    nat: true,
    count: '3',
    flag: 'true',
    empty: '',
    padded: ' x ',
    note: 'line one\nline two',
    'ansible.builtin.copy': 'dotted key',
    list: ['a', 'b'],
    none: [],
    nested: { deep: { value: null } },
    eq: 'a = b',
  },
} as Json;

describe('settings files', () => {
  for (const format of ['json', 'yaml', 'txt'] as const) {
    it(`read back exactly from ${format}`, () => {
      const text = writeSettings(VALUES, format, ['A header', 'Second line']);
      expect(readSettings(text, `x.${format}`)).toEqual(VALUES);
      // And without the file name, by content alone.
      expect(readSettings(text)).toEqual(VALUES);
    });
  }

  it('write TXT a person can read and edit', () => {
    const text = toTxt({ a: { b: 'plain', n: 4, s: '4' } });
    expect(text).toBe('a.b = plain\na.n = 4\na.s = "4"\n');
    expect(fromTxt('# comment\n\na.b=edited\n a.n = 5 \n')).toEqual({ a: { b: 'edited', n: 5 } });
  });

  it('tell the formats apart', () => {
    expect(formatFor('', '{"a":1}')).toBe('json');
    expect(formatFor('', 'a: 1\n')).toBe('yaml');
    expect(formatFor('', 'a = 1\n')).toBe('txt');
    expect(formatFor('s.yml', 'a = 1')).toBe('yaml');
  });

  it('say when a file came from another page', () => {
    const file = envelope('archtoolkit.ansible-generator', { values: {} }) as unknown as Json;
    const r = openEnvelope(file, 'archtoolkit.terraform-generator', SETTINGS_KINDS);
    expect('error' in r && r.error).toBe('That file was saved from the Ansible page, not this one.');
    expect('ok' in openEnvelope(file, 'archtoolkit.ansible-generator')).toBe(true);
    expect('error' in openEnvelope({ sddcId: 'x' }, 'archtoolkit.vcf-spec-builder')).toBe(true);
  });

  it('never write a credential', () => {
    const out = stripSecrets({ hosts: [{ hostname: 'esx01', password: 'hunter2' }], admin_password: 'x', api_key: 'k', region: 'r' });
    expect(out).toEqual({ hosts: [{ hostname: 'esx01' }], region: 'r' });
  });
});
