/**
 * PAN-OS, both families.
 *
 * IPv6 goes in wherever PAN-OS 11.x takes it and comes out in the syntax the
 * firewall expects; IPv4 output is what it was; and where the firewall does
 * not take IPv6 (dynamic-IP-and-port NAT) or support is not confirmed (HA1,
 * path and tunnel monitoring), the change says so with a finding instead of
 * producing something that would not commit.
 */

import { describe, it } from 'node:test';
import { expect } from '../../testing/expect.ts';
import { defaultValues, type BlueprintValues } from '../../kit/blueprint.ts';
import { PANOS_CHANGES } from './panos.ts';
import type { DeviceChange } from '../device.ts';

const byId = (id: string) => {
  const blueprint = PANOS_CHANGES.find((b) => b.id === id);
  if (!blueprint) throw new Error(`no blueprint ${id}`);
  return blueprint;
};
const run = (id: string, values: BlueprintValues = {}): DeviceChange => {
  const blueprint = byId(id);
  return blueprint.change({ ...defaultValues(blueprint), ...values }, id);
};
const codes = (change: DeviceChange) => (change.findings ?? []).map((f) => f.code);
const errors = (change: DeviceChange) => (change.findings ?? []).filter((f) => f.severity === 'error').map((f) => f.code);
const has = (change: DeviceChange, line: string) => change.config.includes(line);

describe('PAN-OS defaults are still IPv4 and still clean', () => {
  it('builds every blueprint with its defaults, with no errors and no IPv6', () => {
    for (const blueprint of PANOS_CHANGES) {
      const change = blueprint.change(defaultValues(blueprint), blueprint.id);
      expect([blueprint.id, errors(change)]).toEqual([blueprint.id, []]);
      expect([blueprint.id, change.config.some((line) => /\bipv6\b|::/.test(line))]).toEqual([blueprint.id, false]);
      const built = blueprint.build(defaultValues(blueprint), blueprint.id);
      expect([blueprint.id, Object.keys(built.files).includes('change-record.md')]).toEqual([blueprint.id, true]);
    }
  });

  it('keeps the IPv4 lines exactly as they were', () => {
    expect(has(run('panos_interface_zone'), 'set network interface ethernet ethernet1/2 layer3 ip 10.20.30.1/24')).toBe(true);
    const route = run('panos_static_route');
    expect(has(route, 'set network virtual-router default routing-table ip static-route default-route destination 0.0.0.0/0')).toBe(true);
    expect(has(route, 'set network virtual-router default routing-table ip static-route default-route nexthop ip-address 203.0.113.1')).toBe(true);
    expect(route.push?.module).toBe('paloaltonetworks.panos.panos_static_route');
    expect(has(run('panos_ipsec_tunnel'), 'set network interface tunnel units tunnel.1 ip 10.254.1.1/30')).toBe(true);
    expect(run('panos_ipsec_tunnel').config.some((line) => line.includes('ike gateway VPN-BRANCH-01-GW ipv6'))).toBe(false);
    expect(has(run('panos_management'), 'set deviceconfig system permitted-ip 10.0.0.0/24')).toBe(true);
    expect(has(run('panos_log_forwarding'), 'set shared log-settings syslog SYSLOG-10-0-0-20 server SYSLOG-10-0-0-20 server 10.0.0.20')).toBe(true);
    expect(has(run('panos_ha_pair'), 'set deviceconfig high-availability interface ha1 netmask 255.255.255.252')).toBe(true);
    const nat = run('panos_nat_rule');
    expect(nat.config.some((line) => line.includes('nat-type'))).toBe(false);
    expect(has(run('panos_security_rule'), 'set rulebase security rules Allow-App-Web source [ GRP-USERS ]')).toBe(true);
  });
});

describe('PAN-OS accepts and emits IPv6', () => {
  it('address objects take IPv6 prefixes with ip-netmask', () => {
    const change = run('panos_address_objects', { addresses: 'WEB-V4 10.20.30.11/32\nWEB-V6 2001:db8:30::11/128' });
    expect(errors(change)).toEqual([]);
    expect(has(change, 'set address WEB-V6 ip-netmask 2001:db8:30::11/128 tag app-tier')).toBe(true);
    expect(has(change, 'set address-group GRP-APP-SERVERS static [ WEB-V4 WEB-V6 ]')).toBe(true);
    expect(errors(run('panos_address_objects', { addresses: 'BAD 2001:db8::zz/64' }))).toContain('network.panos.bad-address');
  });

  it('a layer 3 interface is dual stack: ip for IPv4, ipv6 enabled and address for IPv6', () => {
    const change = run('panos_interface_zone', { address: '10.20.30.1/24, 2001:db8:30::1/64' });
    expect(errors(change)).toEqual([]);
    expect(has(change, 'set network interface ethernet ethernet1/2 layer3 ip 10.20.30.1/24')).toBe(true);
    expect(has(change, 'set network interface ethernet ethernet1/2 layer3 ipv6 enabled yes')).toBe(true);
    expect(has(change, 'set network interface ethernet ethernet1/2 layer3 ipv6 address 2001:db8:30::1/64 enable-on-interface yes')).toBe(true);
    const task = change.push?.after?.find((t) => t.module === 'paloaltonetworks.panos.panos_type_cmd');
    expect(String(task?.args.xpath)).toContain("/layer3/ipv6");
    expect(String(task?.args.element)).toContain('<entry name="2001:db8:30::1/64">');

    const v6only = run('panos_interface_zone', { address: '2001:db8:30::1/64' });
    expect(errors(v6only)).toEqual([]);
    expect(v6only.config.some((line) => line.includes('layer3 ip '))).toBe(false);
    expect(errors(run('panos_interface_zone', { address: '2001:db8:30::1' }))).toContain('network.panos.bad-interface-address');
  });

  it('security rules take IPv6 literals and test with an IPv6 pair', () => {
    const change = run('panos_security_rule', { source: '2001:db8:10::/48', destination: '2001:db8:30::11/128' });
    expect(errors(change)).toEqual([]);
    expect(has(change, 'set rulebase security rules Allow-App-Web source [ 2001:db8:10::/48 ]')).toBe(true);
    expect(change.verify.some((line) => line.includes('source 2001:db8:10:: destination 2001:db8:30::11'))).toBe(true);
    // Mixing families in one security rule is allowed on PAN-OS.
    expect(errors(run('panos_security_rule', { source: '10.0.0.0/8, 2001:db8:10::/48' }))).toEqual([]);
    expect(errors(run('panos_security_rule', { source: '2001:db8::g/48' }))).toContain('network.panos.bad-address');
  });

  it('static routes go in the ipv6 table with an ipv6-address next hop, ::/0 for the default', () => {
    const change = run('panos_static_route', { destination: '::/0', next_hop: '2001:db8:ffff::1', monitor: false });
    expect(errors(change)).toEqual([]);
    const base = 'set network virtual-router default routing-table ipv6 static-route default-route';
    expect(has(change, `${base} destination ::/0`)).toBe(true);
    expect(has(change, `${base} nexthop ipv6-address 2001:db8:ffff::1`)).toBe(true);
    expect(change.impact).toBe('outage');
    expect(change.backout).toContain('delete network virtual-router default routing-table ipv6 static-route default-route');
    expect(change.push?.module).toBe('paloaltonetworks.panos.panos_type_cmd');
    expect(String(change.push?.args.xpath)).toContain('/routing-table/ipv6/static-route/');
    expect(String(change.push?.args.element)).toContain('<ipv6-address>2001:db8:ffff::1</ipv6-address>');
  });

  it('a static route cannot mix families, and IPv6 path monitoring is left out with a VERIFY', () => {
    expect(errors(run('panos_static_route', { destination: '::/0', next_hop: '203.0.113.1' }))).toContain('network.panos.route-family-mismatch');
    expect(errors(run('panos_static_route', { destination: '0.0.0.0/0', next_hop: '2001:db8::1' }))).toContain('network.panos.route-family-mismatch');
    const monitored = run('panos_static_route', { destination: '2001:db8:50::/48', next_hop: '2001:db8::1', monitor: true });
    expect(monitored.config.some((line) => line.includes('path-monitor'))).toBe(false);
    expect(codes(monitored)).toContain('network.panos.path-monitor-ipv6');
    expect(monitored.notes.some((note) => note.startsWith('VERIFY:'))).toBe(true);
  });

  it('a tunnel interface takes IPv6, and an IPv6 IKE peer turns on ipv6 on the gateway', () => {
    const change = run('panos_ipsec_tunnel', { peer_address: '2001:db8:100::10', tunnel_address: '10.254.1.1/30, 2001:db8:fe::1/64', monitor_destination: '10.254.1.2' });
    expect(errors(change)).toEqual([]);
    expect(has(change, 'set network ike gateway VPN-BRANCH-01-GW ipv6 yes')).toBe(true);
    expect(has(change, 'set network ike gateway VPN-BRANCH-01-GW peer-address ip 2001:db8:100::10')).toBe(true);
    expect(has(change, 'set network interface tunnel units tunnel.1 ip 10.254.1.1/30')).toBe(true);
    expect(has(change, 'set network interface tunnel units tunnel.1 ipv6 enabled yes')).toBe(true);
    expect(has(change, 'set network interface tunnel units tunnel.1 ipv6 address 2001:db8:fe::1/64 enable-on-interface yes')).toBe(true);
    expect(change.push?.args.enable_ipv6).toBe(true);
    const monitorV6 = run('panos_ipsec_tunnel', { tunnel_address: '2001:db8:fe::1/64', monitor_destination: '2001:db8:fe::2' });
    expect(monitorV6.config.some((line) => line.includes('tunnel-monitor'))).toBe(false);
    expect(codes(monitorV6)).toContain('network.panos.tunnel-monitor-ipv6');
  });

  it('the management plane takes IPv6: permitted-ip, ipv6-address, ipv6-default-gateway, DNS and NTP', () => {
    const change = run('panos_management', {
      permitted: '10.0.0.0/24, 2001:db8:0:10::/64',
      mgmt_ipv6: '2001:db8:0:10::5/64',
      mgmt_ipv6_gateway: '2001:db8:0:10::1',
      dns_primary: '2001:db8::53',
      ntp_primary: '2001:db8::123',
    });
    expect(errors(change)).toEqual([]);
    expect(has(change, 'set deviceconfig system permitted-ip 2001:db8:0:10::/64')).toBe(true);
    expect(has(change, 'set deviceconfig system ipv6-address 2001:db8:0:10::5/64')).toBe(true);
    expect(has(change, 'set deviceconfig system ipv6-default-gateway 2001:db8:0:10::1')).toBe(true);
    expect(has(change, 'set deviceconfig system dns-setting servers primary 2001:db8::53')).toBe(true);
    expect(has(change, 'set deviceconfig system ntp-servers primary-ntp-server ntp-server-address 2001:db8::123')).toBe(true);
    expect(codes(run('panos_management', { permitted: '2001:db8:0:10::/64' }))).toContain('network.panos.mgmt-no-ipv6');
    expect(codes(run('panos_management', { permitted: '::/0' }))).toContain('network.panos.permitted-any');
    expect(errors(run('panos_management', { mgmt_ipv6: '10.0.0.5/24' }))).toContain('network.panos.bad-mgmt-ipv6');
  });

  it('syslog to an IPv6 server names the profile without colons', () => {
    const change = run('panos_log_forwarding', { syslog_server: '2001:db8::514' });
    expect(errors(change)).toEqual([]);
    expect(has(change, 'set shared log-settings syslog SYSLOG-2001-db8--514 server SYSLOG-2001-db8--514 server 2001:db8::514')).toBe(true);
    expect(change.config.some((line) => /SYSLOG-[^ ]*:/.test(line))).toBe(false);
  });

  it('GlobalProtect gives out an IPv6 pool and routes ::/0 for a full tunnel', () => {
    const change = run('panos_globalprotect', { pool: '10.200.0.0/22, 2001:db8:200::/64', split_tunnel: 'none', external_address: '203.0.113.20, 2001:db8:20::20', dns: '10.0.1.10, 2001:db8::53' });
    expect(errors(change)).toEqual([]);
    const cfg = 'set global-protect global-protect-gateway GP-GATEWAY remote-user-tunnel-configs TUNNEL-CONFIG';
    expect(has(change, `${cfg} ip-pool [ 10.200.0.0/22 2001:db8:200::/64 ]`)).toBe(true);
    expect(has(change, `${cfg} split-tunneling access-route [ 0.0.0.0/0 ::/0 ]`)).toBe(true);
    expect(has(change, `${cfg} dns-server [ 10.0.1.10 2001:db8::53 ]`)).toBe(true);
    expect(has(change, 'set global-protect global-protect-gateway GP-GATEWAY local-address ip-address-family ipv4_ipv6')).toBe(true);
    expect(has(change, 'set global-protect global-protect-gateway GP-GATEWAY local-address ip ipv6 2001:db8:20::20')).toBe(true);
    const split = run('panos_globalprotect', { include_routes: '10.0.0.0/8, 2001:db8::/32' });
    expect(codes(split)).toContain('network.panos.gp-ipv6-no-pool');
    expect(has(split, `${cfg} split-tunneling access-route [ 10.0.0.0/8 2001:db8::/32 ]`)).toBe(true);
  });

  it('OSPFv3 is its own protocol with a dotted router id and area', () => {
    const change = run('panos_virtual_router', { protocol: 'ospfv3', authentication: false });
    expect(errors(change)).toEqual([]);
    expect(has(change, 'set network virtual-router VR-DEFAULT protocol ospfv3 enable yes')).toBe(true);
    expect(has(change, 'set network virtual-router VR-DEFAULT protocol ospfv3 router-id 10.255.1.1')).toBe(true);
    expect(has(change, 'set network virtual-router VR-DEFAULT protocol ospfv3 area 0.0.0.0 interface ethernet1/2 enable yes')).toBe(true);
    expect(has(change, 'set network virtual-router VR-DEFAULT protocol ospfv3 export-rules REDIST-OUT-V6 new-path-type ext-2')).toBe(true);
    expect(has(change, 'set network virtual-router VR-DEFAULT redist-profile-ipv6 REDIST-OUT-V6 filter type connect')).toBe(true);
    expect(change.config.some((line) => line.includes('protocol ospf '))).toBe(false);
    expect(errors(run('panos_virtual_router', { protocol: 'ospfv3', router_id: '2001:db8::1' }))).toContain('network.panos.bad-router-id');
    const authed = run('panos_virtual_router', { protocol: 'ospfv3', authentication: true });
    expect(authed.config.some((line) => line.includes('md5'))).toBe(false);
    expect(codes(authed)).toContain('network.panos.ospfv3-auth');
  });

  it('an IPv6 BGP peer uses MP-BGP with the IPv6 unicast family', () => {
    const change = run('panos_virtual_router', { protocol: 'bgp', peer_address: '2001:db8:12::2', local_interface: 'ethernet1/1', local_address: '2001:db8:12::1/64' });
    expect(errors(change)).toEqual([]);
    const peer = 'set network virtual-router VR-DEFAULT protocol bgp peer-group PG-1 peer PEER-1';
    expect(has(change, `${peer} peer-address ip 2001:db8:12::2`)).toBe(true);
    expect(has(change, `${peer} local-address ip 2001:db8:12::1/64`)).toBe(true);
    expect(has(change, `${peer} enable-mp-bgp yes`)).toBe(true);
    expect(has(change, `${peer} address-family-identifier ipv6`)).toBe(true);
    expect(has(change, `${peer} subsequent-address-family-identifier unicast yes`)).toBe(true);
    expect(has(change, 'set network virtual-router VR-DEFAULT protocol bgp redist-rules REDIST-OUT-V6 address-family-identifier ipv6')).toBe(true);
    expect(has(change, 'set network virtual-router VR-DEFAULT protocol bgp router-id 10.255.1.1')).toBe(true);
    const v4 = run('panos_virtual_router', { protocol: 'bgp' });
    expect(v4.config.some((line) => line.includes('mp-bgp') || line.includes('ipv6'))).toBe(false);
    expect(errors(run('panos_virtual_router', { protocol: 'bgp', peer_address: '2001:db8:12::2', local_interface: 'ethernet1/1', local_address: '10.0.12.1/30' }))).toContain('network.panos.bgp-family-mismatch');
  });

  it('application override and authentication servers take IPv6', () => {
    const override = run('panos_app_override', { source: '2001:db8:10::/64', destination: '2001:db8:20::50' });
    expect(errors(override)).toEqual([]);
    expect(override.verify.some((line) => line.includes('source 2001:db8:10:: destination 2001:db8:20::50'))).toBe(true);
    expect(errors(run('panos_auth_profile', { method: 'radius', servers: '2001:db8::1812, 10.0.5.11' }))).toEqual([]);
    expect(has(run('panos_auth_profile', { method: 'radius', servers: '2001:db8::1812, 10.0.5.11' }), 'set shared server-profile radius LDAP-AD server SRV1 ip-address 2001:db8::1812 port 1812 secret <REQUIRED>')).toBe(true);
  });
});

describe('PAN-OS refuses IPv6 where it does not take it', () => {
  it('source and destination NAT (nat-type ipv4) reject IPv6 with an error', () => {
    const source = run('panos_nat_rule', { source: '2001:db8:10::/48' });
    expect(errors(source)).toContain('network.panos.nat-ipv6');
    expect((source.findings ?? []).find((f) => f.code === 'network.panos.nat-ipv6')?.message).toContain('does not support IPv6');
    expect(errors(run('panos_nat_rule', { nat_type: 'destination', translated: '2001:db8:30::11' }))).toContain('network.panos.nat-ipv6');
  });

  it('NPTv6 translates an IPv6 prefix to one of the same length, and takes no IPv4', () => {
    const change = run('panos_nat_rule', { nat_type: 'nptv6', source: '2001:db8:10::/48', translated: '2001:db8:ff10::/48' });
    expect(errors(change)).toEqual([]);
    expect(has(change, 'set rulebase nat rules NAT-Outbound nat-type nptv6')).toBe(true);
    expect(has(change, 'set rulebase nat rules NAT-Outbound source-translation static-ip translated-address 2001:db8:ff10::/48')).toBe(true);
    expect(change.push?.args.nat_type).toBe('nptv6');
    expect(change.notes.some((note) => note.startsWith('VERIFY:'))).toBe(true);
    expect(errors(run('panos_nat_rule', { nat_type: 'nptv6', source: '2001:db8:10::/48', translated: '2001:db8:ff10::/56' }))).toContain('network.panos.nptv6-length');
    expect(errors(run('panos_nat_rule', { nat_type: 'nptv6', source: '10.0.0.0/8', translated: '2001:db8:ff10::/48' }))).toContain('network.panos.nptv6-ipv4');
    expect(errors(run('panos_nat_rule', { nat_type: 'nptv6', source: '2001:db8:10::/48', translated: '203.0.113.0/24' }))).toContain('network.panos.nptv6-translated');
  });

  it('HA1 over IPv6 is not generated and is an error until verified', () => {
    const change = run('panos_ha_pair', { local_ha1: '2001:db8:100::1/64', peer_ha1: '2001:db8:100::2' });
    expect(errors(change)).toContain('network.panos.ha1-ipv6');
    expect(change.config.some((line) => line.includes('2001:db8'))).toBe(false);
    expect(change.notes.some((note) => note.startsWith('VERIFY:'))).toBe(true);
  });

  it('User-ID server monitoring leaves an IPv6 server out and says so', () => {
    const change = run('panos_userid', { servers: 'DC01 10.0.5.10\nDC02 2001:db8:5::11', ldap_servers: '10.0.5.10, 2001:db8:5::11' });
    expect(codes(change)).toContain('network.panos.userid-server-ipv6');
    expect(change.config.some((line) => line.includes('server-monitor DC02'))).toBe(false);
    expect(change.config.some((line) => line.includes('address 2001:db8:5::11 port 636'))).toBe(true);
  });
});
