/**
 * F5 BIG-IP, dual stack.
 *
 * AS3 takes IPv6 wherever it takes IPv4: virtual addresses, pool members, SNAT
 * addresses, GSLB answers (as AAAA). The traps are the text around them — a
 * member typed [v6]:port or tmsh's v6.port, a URL or Host header that needs
 * brackets — and a virtual and pool of different families, which only works
 * with a source translation.
 */

import { describe, it } from 'node:test';
import { expect } from '../../testing/expect.ts';
import { defaultValues, type BlueprintValues } from '../../kit/blueprint.ts';
import { F5_CHANGES } from './f5.ts';
import { parseMembers, tmshMember } from './f5-common.ts';

function run(id: string, values: BlueprintValues = {}) {
  const blueprint = F5_CHANGES.find((b) => b.id === id)!;
  const change = blueprint.change({ ...defaultValues(blueprint), ...values }, 'test');
  const codes = (change.findings ?? []).map((f) => `${f.severity}:${f.code}`);
  const config = change.config.join('\n');
  const tenant = (config.startsWith('{') ? JSON.parse(config) : null) as { declaration: Record<string, Record<string, Record<string, unknown>>> } | null;
  return { config, verify: change.verify.join('\n'), codes, notes: change.notes.join('\n'), tenant };
}
const errors = (codes: string[]) => codes.filter((c) => c.startsWith('error:'));
const app = (tenant: ReturnType<typeof run>['tenant'], t: string, a: string) => tenant!.declaration[t]![a] as Record<string, Record<string, unknown>>;

describe('pool members', () => {
  it('reads IPv4, bracketed IPv6, tmsh IPv6 and bare addresses', () => {
    const m = parseMembers('10.0.0.1:80, [2001:db8::1]:8080\n2001:db8::2.8080 2001:db8::3', 443);
    expect(m.servers).toEqual(['10.0.0.1', '2001:db8::1', '2001:db8::2', '2001:db8::3']);
    expect(m.groups).toEqual([
      { servicePort: 80, serverAddresses: ['10.0.0.1'] },
      { servicePort: 8080, serverAddresses: ['2001:db8::1', '2001:db8::2'] },
      { servicePort: 443, serverAddresses: ['2001:db8::3'] },
    ]);
    expect(m.invalid).toHaveLength(0);
    expect(parseMembers('web01:80', 80).invalid).toEqual(['web01:80']);
  });
  it('names members the way tmsh does', () => {
    expect(tmshMember('10.0.0.1', 80)).toBe('10.0.0.1:80');
    expect(tmshMember('2001:db8::1', 80)).toBe('2001:db8::1.80');
  });
});

describe('virtual servers', () => {
  it('accepts an IPv6 virtual address and IPv6 members', () => {
    const { tenant, verify, codes } = run('f5_http_virtual', { virtual_address: '2001:db8:20::20', pool_members: '[2001:db8:30::11]:8080\n2001:db8:30::12.8080' });
    const a = app(tenant, 'Prod', 'web_app');
    expect(a.service!.virtualAddresses).toEqual(['2001:db8:20::20']);
    expect(a.web_app_pool!.members).toEqual([{ servicePort: 8080, serverAddresses: ['2001:db8:30::11', '2001:db8:30::12'], shareNodes: true }]);
    expect(String(a.web_app_monitor!.send)).toContain('Host: [2001:db8:20::20]');
    expect(verify).toContain('curl -skI https://[2001:db8:20::20]:443/');
    expect(errors(codes)).toHaveLength(0);
  });
  it('keeps the IPv4 declaration as it was', () => {
    const a = app(run('f5_http_virtual').tenant, 'Prod', 'web_app');
    expect(a.web_app_pool!.members).toEqual([{ servicePort: 8080, serverAddresses: ['10.20.30.11', '10.20.30.12'], shareNodes: true }]);
    expect(a.service!.virtualAddresses).toEqual(['203.0.113.20']);
  });
  it('refuses an IPv6 virtual with IPv4 members and no SNAT, and explains it with SNAT', () => {
    expect(run('f5_tcp_virtual', { virtual_address: '2001:db8:20::30', snat: false }).codes).toContain('error:network.f5.cross-family-no-snat');
    const withSnat = run('f5_tcp_virtual', { virtual_address: '2001:db8:20::30' });
    expect(errors(withSnat.codes)).toHaveLength(0);
    expect(withSnat.notes).toContain('self IP');
  });
  it('accepts IPv6 on every other virtual server', () => {
    for (const id of ['f5_tcp_virtual', 'f5_waf_policy', 'f5_udp_virtual', 'f5_redirect_virtual', 'f5_persistence', 'f5_irule', 'f5_connection_profiles', 'f5_certificate', 'f5_ltm_policy']) {
      const { codes } = run(id, { virtual_address: '2001:db8:20::40', pool_members: '[2001:db8:30::11]:8080', second_pool: '[2001:db8:30::21]:8080', api_members: '[2001:db8:30::31]:8080', static_members: '[2001:db8:30::41]:8080' });
      expect(codes.filter((c) => c.includes('bad-virtual') || c.includes('bad-member'))).toEqual([]);
    }
    expect(run('f5_http_virtual', { virtual_address: 'web.example.com' }).codes).toContain('error:network.f5.bad-virtual-address');
  });
  it('brackets IPv6 in openssl and curl --resolve', () => {
    const { verify } = run('f5_certificate', { virtual_address: '2001:db8::100' });
    expect(verify).toContain('-connect [2001:db8::100]:443');
    expect(verify).toContain('--resolve app1.example.com:443:[2001:db8::100]');
  });
});

describe('SNAT, maintenance and GSLB', () => {
  it('takes IPv6 SNAT addresses and rejects what is not an address', () => {
    const { tenant, codes } = run('f5_snat_pool', { addresses: '10.20.30.240\n2001:db8::240\n10.0.0.0/24' });
    expect(app(tenant, 'Prod', 'shared_snat').shared_snat_snatpool!.snatAddresses).toEqual(['10.20.30.240', '2001:db8::240']);
    expect(codes).toContain('error:network.f5.bad-snat-address');
  });
  it('names an IPv6 member address.port in tmsh', () => {
    const { config } = run('f5_pool_member_maintenance', { member: '2001:db8:30::11' });
    expect(config).toContain('members modify { 2001:db8:30::11.8080 {');
    expect(run('f5_pool_member_maintenance').config).toContain('members modify { 10.20.30.11:8080 {');
  });
  it('answers AAAA for IPv6 sites and refuses a pool of mixed families', () => {
    const v6 = run('f5_gslb', { primary_site: '2001:db8:1::10', secondary_site: '2001:db8:2::10' });
    const a = app(v6.tenant, 'GSLB', 'app1');
    expect(a.app1_pool!.resourceRecordType).toBe('AAAA');
    expect(a.app1_wideip!.resourceRecordType).toBe('AAAA');
    expect(errors(v6.codes)).toHaveLength(0);
    expect(run('f5_gslb', { primary_site: '2001:db8:1::10' }).codes).toContain('error:network.f5.gslb-mixed-family');
    expect(app(run('f5_gslb').tenant, 'GSLB', 'app1').app1_pool!.resourceRecordType).toBe('A');
  });
});
