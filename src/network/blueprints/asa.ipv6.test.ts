/**
 * Cisco ASA, dual stack.
 *
 * The ASA takes IPv6 everywhere an address goes, but never with a mask: a
 * network is prefix/length. One access list holds both families; one entry
 * cannot mix them. Route tracking is IPv4 only, so an IPv6 route asked to be
 * tracked is an error rather than a line the ASA rejects.
 */

import { describe, it } from 'node:test';
import { expect } from '../../testing/expect.ts';
import { defaultValues, type BlueprintValues } from '../../kit/blueprint.ts';
import { ASA_CHANGES } from './asa.ts';

function run(id: string, values: BlueprintValues = {}) {
  const blueprint = ASA_CHANGES.find((b) => b.id === id)!;
  const change = blueprint.change({ ...defaultValues(blueprint), ...values }, 'test');
  const codes = (change.findings ?? []).map((f) => `${f.severity}:${f.code}`);
  return { change, config: change.config.join('\n'), codes, notes: change.notes.join('\n') };
}
const errors = (codes: string[]) => codes.filter((c) => c.startsWith('error:'));

describe('ASA interface', () => {
  it('keeps the IPv4 form', () => {
    const { config, codes } = run('asa_interface');
    expect(config).toContain(' ip address 10.20.30.1 255.255.255.0');
    expect(config.includes('ipv6')).toBe(false);
    expect(errors(codes)).toHaveLength(0);
  });
  it('adds IPv6 as address/prefix with ipv6 enable and standby addresses', () => {
    const { config, codes } = run('asa_interface', { ipv6_address: '2001:db8:30::1/64', standby_address: '10.20.30.2', ipv6_standby: '2001:db8:30::2' });
    expect(config).toContain(' ip address 10.20.30.1 255.255.255.0 standby 10.20.30.2');
    expect(config).toContain(' ipv6 address 2001:db8:30::1/64 standby 2001:db8:30::2');
    expect(config).toContain(' ipv6 enable');
    expect(errors(codes)).toHaveLength(0);
  });
  it('takes an IPv6-only address in the first field', () => {
    const { config } = run('asa_interface', { address: '2001:db8:30::1/64' });
    expect(config).toContain(' ipv6 address 2001:db8:30::1/64');
    expect(config.includes(' ip address ')).toBe(false);
  });
  it('rejects a standby of the other family', () => {
    expect(run('asa_interface', { standby_address: '2001:db8:30::2' }).codes).toContain('error:network.asa.bad-standby');
  });
});

describe('ASA objects and access rules', () => {
  it('writes an IPv6 subnet object as prefix/length, never with a mask', () => {
    const { config, codes } = run('asa_objects', { networks: 'V6-HOST host 2001:db8::11\nV6-NET subnet 2001:db8:31::/64\nV4-NET subnet 10.20.31.0/24' });
    expect(config).toContain(' host 2001:db8::11');
    expect(config).toContain(' subnet 2001:db8:31::/64');
    expect(config).toContain(' subnet 10.20.31.0 255.255.255.0');
    expect(errors(codes)).toHaveLength(0);
  });
  it('writes IPv6 operands as net/len and host, and ICMP as icmp6', () => {
    const { config, codes } = run('asa_access_rule', { source: 'any6', destination: '2001:db8:30::/64', protocol: 'icmp' });
    expect(config).toContain('extended permit icmp6 any6 2001:db8:30::/64');
    expect(config.includes('255.')).toBe(false);
    expect(errors(codes)).toHaveLength(0);
    expect(run('asa_access_rule', { source: 'any6', destination: '2001:db8:30::11' }).config).toContain('any6 host 2001:db8:30::11 eq 443');
  });
  it('keeps IPv4 rules as they were', () => {
    expect(run('asa_access_rule').config).toContain('access-list outside_access_in extended permit tcp any4 object APP-WEB-01 eq 443 log informational');
    expect(run('asa_access_rule', { destination: '10.20.30.0/24' }).config).toContain('any4 10.20.30.0 255.255.255.0 eq 443');
  });
  it('refuses a rule that mixes families', () => {
    expect(run('asa_access_rule', { source: 'any4', destination: '2001:db8:30::11' }).codes).toContain('error:network.asa.acl-mixed-family');
    expect(run('asa_access_rule', { source: '10.0.0.0/8', destination: 'host 2001:db8::1' }).codes).toContain('error:network.asa.acl-mixed-family');
    expect(errors(run('asa_access_rule', { source: 'any', destination: '2001:db8:30::11' }).codes)).toHaveLength(0);
  });
});

describe('ASA NAT', () => {
  it('writes NAT66 static and PAT with the ipv6 interface keyword', () => {
    const nat66 = run('asa_nat', { real_address: '2001:db8:30::11', mapped_address: '2001:db8:ffff::11' });
    expect(nat66.config).toContain(' host 2001:db8:30::11');
    expect(nat66.config).toContain(' nat (inside,outside) static 2001:db8:ffff::11');
    expect(nat66.notes).toContain('NAT66');
    const pat = run('asa_nat', { kind: 'pat', real_address: '2001:db8:30::/64' });
    expect(pat.config).toContain(' subnet 2001:db8:30::/64');
    expect(pat.config).toContain(' nat (inside,outside) dynamic interface ipv6');
  });
  it('says so when a static rule crosses families', () => {
    expect(run('asa_nat', { real_address: '2001:db8:30::11', mapped_address: '203.0.113.11' }).notes).toContain('NAT46');
  });
  it('keeps IPv4 NAT unchanged', () => {
    const { config } = run('asa_nat');
    expect(config).toContain(' host 10.20.30.11');
    expect(config).toContain(' nat (inside,outside) static 203.0.113.11');
    expect(run('asa_nat', { kind: 'pat', real_address: '10.20.30.0/24' }).config).toContain(' nat (inside,outside) dynamic interface\n');
  });
});

describe('ASA routes', () => {
  it('writes an IPv6 route as ipv6 route IF ::/0 GW', () => {
    const { config, codes } = run('asa_static_route', { destination: '::/0', gateway: '2001:db8::1', track: false });
    expect(config).toBe('ipv6 route outside ::/0 2001:db8::1 1');
    expect(errors(codes)).toHaveLength(0);
  });
  it('rejects tracking on an IPv6 route, and emits no SLA monitor for it', () => {
    const { config, codes } = run('asa_static_route', { destination: '::/0', gateway: '2001:db8::1', track: true });
    expect(codes).toContain('error:network.asa.ipv6-route-track');
    expect(config.includes('sla monitor')).toBe(false);
    expect(config.includes('track')).toBe(false);
  });
  it('rejects a gateway of the other family', () => {
    expect(run('asa_static_route', { destination: '::/0', gateway: '203.0.113.1', track: false }).codes).toContain('error:network.asa.gateway-family');
  });
  it('keeps the tracked IPv4 default route', () => {
    expect(run('asa_static_route').config).toContain('route outside 0.0.0.0 0.0.0.0 203.0.113.1 1 track 1');
  });
});

describe('ASA VPN', () => {
  it('pairs local and remote networks within a family in the crypto ACL', () => {
    const { config, codes } = run('asa_site_to_site_vpn', { peer: '2001:db8:100::10', local_networks: '10.20.0.0/16\n2001:db8:20::/48', remote_networks: '10.30.0.0/16\n2001:db8:30::/48' });
    expect(config).toContain('extended permit ip 10.20.0.0 255.255.0.0 10.30.0.0 255.255.0.0');
    expect(config).toContain('extended permit ip 2001:db8:20::/48 2001:db8:30::/48');
    expect(config.includes('10.20.0.0 255.255.0.0 2001:db8')).toBe(false);
    expect(config).toContain(' subnet 2001:db8:20::/48');
    expect(config).toContain('tunnel-group 2001:db8:100::10 type ipsec-l2l');
    expect(errors(codes)).toHaveLength(0);
  });
  it('refuses IPv6 local networks with no IPv6 remote', () => {
    expect(run('asa_site_to_site_vpn', { local_networks: '2001:db8:20::/48', remote_networks: '10.30.0.0/16' }).codes).toContain('error:network.asa.vpn-family');
  });
  it('adds an IPv6 pool and an extended split list for dual-stack clients', () => {
    const { config, codes } = run('asa_remote_access_vpn', { ipv6_pool: '2001:db8:99::1/64', split_networks: '10.20.0.0/16\n2001:db8:20::/48' });
    expect(config).toContain('ipv6 local pool VPN-POOL-V6 2001:db8:99::1/64 250');
    expect(config).toContain(' ipv6-address-pool VPN-POOL-V6');
    expect(config).toContain('access-list SPLIT-CORP-VPN extended permit ip 2001:db8:20::/48 any6');
    expect(config).toContain('access-list SPLIT-CORP-VPN extended permit ip 10.20.0.0 255.255.0.0 any4');
    expect(config).toContain(' ipv6-split-tunnel-policy tunnelspecified');
    expect(errors(codes)).toHaveLength(0);
  });
  it('keeps the IPv4-only split list standard', () => {
    const { config } = run('asa_remote_access_vpn');
    expect(config).toContain('access-list SPLIT-CORP-VPN standard permit 10.20.0.0 255.255.0.0');
    expect(config.includes('ipv6')).toBe(false);
  });
  it('rejects an IPv6 address in the IPv4 pool', () => {
    expect(run('asa_remote_access_vpn', { pool_start: '2001:db8:99::10' }).codes).toContain('error:network.asa.bad-pool');
  });
});

describe('ASA failover and management', () => {
  it('writes an IPv6 failover link as address/prefix standby address', () => {
    const { config, codes } = run('asa_failover', { primary_address: 'fd00:254::1/64', secondary_address: 'fd00:254::2' });
    expect(config).toContain('failover interface ip folink fd00:254::1/64 standby fd00:254::2');
    expect(errors(codes)).toHaveLength(0);
    expect(run('asa_failover', { primary_address: 'fd00:254::1/64', secondary_address: '10.0.254.2' }).codes).toContain('error:network.asa.bad-failover-standby');
    expect(run('asa_failover').config).toContain('failover interface ip folink 10.0.254.1 255.255.255.252 standby 10.0.254.2');
  });
  it('allows SSH and ASDM from IPv6 networks and logs to an IPv6 host', () => {
    const { config, notes } = run('asa_management', { management_network: '10.0.0.0/24, 2001:db8:0:10::/64', syslog_server: '2001:db8::514', ntp_servers: '2001:db8::123' });
    expect(config).toContain('ssh 10.0.0.0 255.255.255.0 inside');
    expect(config).toContain('ssh 2001:db8:0:10::/64 inside');
    expect(config).toContain('http 2001:db8:0:10::/64 inside');
    expect(config).toContain('logging host inside 2001:db8::514');
    expect(config).toContain('ntp server 2001:db8::123');
    expect(notes).toContain('VERIFY');
  });
  it('warns when management is open to every address', () => {
    expect(run('asa_management', { management_network: '::/0' }).codes).toContain('warning:network.asa.management-open');
  });
  it('captures IPv6 with icmp6 and refuses a mixed-family capture', () => {
    expect(run('asa_capture', { source: '2001:db8::9', destination: '2001:db8:30::11', protocol: 'icmp' }).config).toContain('permit icmp6 host 2001:db8::9 host 2001:db8:30::11');
    expect(run('asa_capture', { source: '2001:db8::9' }).codes).toContain('error:network.asa.capture-mixed-family');
  });
});
