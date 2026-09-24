/**
 * Cisco Catalyst 9800, dual stack.
 *
 * IOS-XE syntax for IPv6: `ipv6 address` on the SVI, `address ipv6` in a
 * RADIUS server, `logging host ipv6`. What the controller's support is not
 * certain for — an IPv6 AP syslog host, a CoA client by IPv6 — is held back
 * with a VERIFY note rather than emitted.
 */

import { describe, it } from 'node:test';
import { expect } from '../../testing/expect.ts';
import { defaultValues, type BlueprintValues } from '../../kit/blueprint.ts';
import { WLC_CHANGES } from './wlc.ts';

function run(id: string, values: BlueprintValues = {}) {
  const blueprint = WLC_CHANGES.find((b) => b.id === id)!;
  const change = blueprint.change({ ...defaultValues(blueprint), ...values }, 'test');
  const codes = (change.findings ?? []).map((f) => `${f.severity}:${f.code}`);
  return { config: change.config.join('\n'), backout: change.backout.join('\n'), codes, notes: change.notes.join('\n') };
}
const errors = (codes: string[]) => codes.filter((c) => c.startsWith('error:'));

describe('9800 controller baseline', () => {
  it('adds an IPv6 management address, IPv6 NTP and an IPv6 syslog host', () => {
    const { config, backout, codes } = run('wlc_management_baseline', { management_ipv6: '2001:db8:10::5/64', ntp_servers: '10.0.0.10, 2001:db8::123', syslog_server: '2001:db8::514' });
    expect(config).toContain(' ip address 10.0.10.5 255.255.255.0');
    expect(config).toContain(' ipv6 address 2001:db8:10::5/64');
    expect(config).toContain(' ipv6 enable');
    expect(config).toContain('ntp server 2001:db8::123');
    expect(config).toContain('logging host ipv6 2001:db8::514');
    expect(backout).toContain('no logging host ipv6 2001:db8::514');
    expect(errors(codes)).toHaveLength(0);
  });
  it('keeps the IPv4 baseline as it was', () => {
    const { config } = run('wlc_management_baseline');
    expect(config).toContain('logging host 10.0.0.20\n');
    expect(config.includes('ipv6')).toBe(false);
  });
  it('rejects an IPv4 value in the IPv6 field', () => {
    expect(run('wlc_management_baseline', { management_ipv6: '10.0.10.6/24' }).codes).toContain('error:network.wlc.bad-management-ipv6');
  });
});

describe('9800 RADIUS', () => {
  it('addresses each server in its own family and sources IPv6 from the SVI', () => {
    const { config, notes } = run('wlc_radius', { servers: '10.0.0.30, 2001:db8::31' });
    expect(config).toContain(' address ipv4 10.0.0.30 auth-port 1812 acct-port 1813');
    expect(config).toContain(' address ipv6 2001:db8::31 auth-port 1812 acct-port 1813');
    expect(config).toContain(' ip radius source-interface Vlan10');
    expect(config).toContain(' ipv6 radius source-interface Vlan10');
    // The CoA client by IPv6 address is held back until the release is checked.
    expect(config.includes('client 2001:db8::31')).toBe(false);
    expect(notes).toContain('VERIFY: CoA from 2001:db8::31');
  });
  it('keeps IPv4-only RADIUS unchanged', () => {
    const { config } = run('wlc_radius');
    expect(config.includes('ipv6')).toBe(false);
    expect(config).toContain(' client 10.0.0.31 server-key 0 <REQUIRED>');
  });
});

describe('9800 AP join profile, guest portal and mobility', () => {
  it('holds back an IPv6 AP syslog host with a VERIFY note', () => {
    const { config, notes } = run('wlc_ap_join_profile', { syslog_host: '2001:db8::514' });
    expect(config.includes('syslog host')).toBe(false);
    expect(notes).toContain('VERIFY');
    expect(run('wlc_ap_join_profile').config).toContain(' syslog host 10.0.0.20');
  });
  it('writes one redirect portal line per family', () => {
    const { config } = run('wlc_guest_wlan', { portal_type: 'external', portal_address: '10.0.0.80, 2001:db8::80' });
    expect(config).toContain(' redirect portal ipv4 10.0.0.80');
    expect(config).toContain(' redirect portal ipv6 2001:db8::80');
  });
  it('writes IPv6 mobility peers with their MAC and refuses mixed families', () => {
    const v6 = run('wlc_mobility', { local_address: '2001:db8:10::5', peers: '2001:db8:20::5 CAMPUS aabb.ccdd.eeff', anchor: '2001:db8:99::5' });
    expect(v6.config).toContain('wireless mobility group member mac-address aabb.ccdd.eeff ip 2001:db8:20::5 group CAMPUS');
    expect(v6.config).toContain('mobility anchor 2001:db8:99::5 priority 1');
    expect(v6.notes).toContain('VERIFY');
    expect(errors(v6.codes)).toHaveLength(0);
    expect(run('wlc_mobility', { local_address: '10.0.10.5', peers: '2001:db8:20::5 CAMPUS aabb.ccdd.eeff' }).codes).toContain('error:network.wlc.mobility-family');
    expect(run('wlc_mobility').config).toContain('wireless mobility group member mac-address aabb.ccdd.eeff ip 10.0.20.5 group CAMPUS');
  });
});
