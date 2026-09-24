/** Secret masking over real config shapes, and Cisco type 7. */

import { describe, it } from 'node:test';
import { expect } from '../../testing/expect.ts';
import { decodeType7, encodeType7, findType7, MASK, maskSecrets } from './config.ts';

describe('type 7', () => {
  it('decodes the well-known vectors', () => {
    expect(decodeType7('0822455D0A16')).toBe('cisco');
    expect(decodeType7('02050D480809')).toBe('cisco');
  });

  it('round-trips every seed', () => {
    for (let seed = 0; seed <= 15; seed += 1) expect(decodeType7(encodeType7('P@ssw0rd!long-enough', seed))).toBe('P@ssw0rd!long-enough');
  });

  it('rejects what is not type 7', () => {
    expect(() => decodeType7('xyz')).toThrow(/Not a type 7/);
    expect(() => decodeType7('99AABB')).toThrow(/00–52/);
  });

  it('finds type 7 values in a config', () => {
    const hits = findType7('username admin password 7 0822455D0A16\nline vty 0 4\n password 7 02050D480809\n enable secret 9 $9$x');
    expect(hits.map((h) => [h.line, h.decoded])).toEqual([
      [1, 'cisco'],
      [3, 'cisco'],
    ]);
  });
});

describe('maskSecrets', () => {
  const CISCO = [
    'hostname r1',
    'service password-encryption',
    'enable secret 9 $9$abcdefg$hijk',
    'username admin privilege 15 password 7 0822455D0A16',
    'username ops secret 5 $1$salt$hash',
    'snmp-server community Publ1c RO',
    'snmp-server host 10.0.0.5 version 2c Trap5ecret',
    'snmp-server user u1 g1 v3 auth sha AuthPass1 priv aes 128 PrivPass1',
    'snmp-server group g1 v3 priv read v1',
    'tacacs-server host 10.0.0.9 key 7 0822455D0A16',
    'tacacs server T1',
    ' key 7 0822455D0A16',
    'key chain K',
    ' key 1',
    '  key-string 7 0822455D0A16',
    'interface Gi0/1',
    ' ip ospf message-digest-key 1 md5 7 0822455D0A16',
    'ntp authentication-key 1 md5 NtpSecret 7',
    'crypto isakmp key IsakmpKey address 0.0.0.0',
    'line vty 0 4',
    ' password 7 02050D480809',
  ].join('\n');

  it('masks every Cisco secret and keeps the line shapes', () => {
    const r = maskSecrets(CISCO);
    const lines = r.text.split('\n');
    expect(lines[1]).toBe('service password-encryption');
    expect(lines[2]).toBe(`enable secret 9 ${MASK}`);
    expect(lines[3]).toBe(`username admin privilege 15 password 7 ${MASK}`);
    expect(lines[4]).toBe(`username ops secret 5 ${MASK}`);
    expect(lines[5]).toBe(`snmp-server community ${MASK} RO`);
    expect(lines[6]).toBe(`snmp-server host 10.0.0.5 version 2c ${MASK}`);
    expect(lines[7]).toBe(`snmp-server user u1 g1 v3 auth sha ${MASK} priv aes 128 ${MASK}`);
    expect(lines[8]).toBe('snmp-server group g1 v3 priv read v1');
    expect(lines[9]).toBe(`tacacs-server host 10.0.0.9 key 7 ${MASK}`);
    expect(lines[11]).toBe(` key 7 ${MASK}`);
    expect(lines[13]).toBe(' key 1');
    expect(lines[14]).toBe(`  key-string 7 ${MASK}`);
    expect(lines[16]).toBe(` ip ospf message-digest-key 1 md5 7 ${MASK}`);
    expect(lines[17]).toBe(`ntp authentication-key 1 md5 ${MASK} 7`);
    expect(lines[18]).toBe(`crypto isakmp key ${MASK} address 0.0.0.0`);
    expect(lines[20]).toBe(` password 7 ${MASK}`);
    expect(r.text).not.toContain('0822455D0A16');
    expect(r.text).not.toContain('Publ1c');
    expect(r.count).toBe(14);
  });

  it('masks Splunk .conf secrets, tokens and key/value forms', () => {
    const r = maskSecrets(
      [
        '[general]',
        'pass4SymmKey = $7$abcdef==',
        'sslPassword=changeme',
        'serverName = idx1',
        'curl -H "Authorization: Bearer eyJhbGciOi.eyJzdWIi.sig" https://api',
        'db_password: "hunter2"',
        '"api_key": "sk-123"',
        'url = https://svc:P4ss@host.example.com/x',
        'password: {{ vault_password }}',
      ].join('\n'),
    );
    expect(r.text.split('\n')).toEqual([
      '[general]',
      `pass4SymmKey = ${MASK}`,
      `sslPassword=${MASK}`,
      'serverName = idx1',
      `curl -H "Authorization: Bearer ${MASK}" https://api`,
      `db_password: "${MASK}"`,
      `"api_key": "${MASK}"`,
      `url = https://svc:${MASK}@host.example.com/x`,
      'password: {{ vault_password }}',
    ]);
    expect(r.lines).toEqual([2, 3, 5, 6, 7, 8]);
  });

  it('masks PEM private keys but not certificates', () => {
    const r = maskSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIabc\ndef\n-----END RSA PRIVATE KEY-----\n-----BEGIN CERTIFICATE-----\nMIIcert\n-----END CERTIFICATE-----');
    expect(r.text).toBe(`-----BEGIN RSA PRIVATE KEY-----\n${MASK}\n-----END RSA PRIVATE KEY-----\n-----BEGIN CERTIFICATE-----\nMIIcert\n-----END CERTIFICATE-----`);
  });

  it('is idempotent', () => {
    const once = maskSecrets(CISCO).text;
    const twice = maskSecrets(once);
    expect(twice.text).toBe(once);
    expect(twice.count).toBe(0);
  });
});
