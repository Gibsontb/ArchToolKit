/**
 * IPv6 in the VCF Automation, Operations and fleet blueprints.
 *
 * Where the product takes IPv6 the blueprint accepts it and writes the field
 * the API has for it (ipv6Cidr, ipVersion IPv6, an ipBlocks cidr, an AAAA
 * record); where it does not — NSX VPC subnets, VKS pod and service networks,
 * on-demand network address space — an IPv6 value is an error and nothing is
 * written for it. IPv4 input gives the same payloads as before.
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { defaultValues, type BlueprintValues } from '../kit/blueprint.ts';
import { automationFor } from './blueprints/index.ts';

function build(id: string, overrides: BlueprintValues = {}) {
  const b = automationFor(id);
  if (!b) throw new Error(`missing ${id}`);
  return b.build({ ...defaultValues(b), ...overrides }, id);
}

const codes = (out: ReturnType<typeof build>, severity?: string) => (out.findings ?? []).filter((f) => !severity || f.severity === severity).map((f) => f.code);
const file = (out: ReturnType<typeof build>, suffix: string) => Object.entries(out.files).find(([path]) => path.endsWith(suffix))?.[1] ?? '';
const all = (out: ReturnType<typeof build>) => Object.values(out.files).join('\n');
const WORKFLOW_ID = 'vcfa_orchestrator_workflow';

describe('vcfa_network_profile: dual-stack fabric networks and IPv6 ranges', () => {
  it('builds from its IPv4 defaults as before: cidr, defaultGateway, ipVersion IPv4, no IPv6 field', () => {
    const out = build('vcfa_network_profile');
    expect(codes(out, 'error')).toEqual([]);
    const fabric = JSON.parse(file(out, 'fabric-networks.json'));
    expect(fabric.map((f: { cidr: string }) => f.cidr)).toEqual(['10.20.10.0/24', '10.20.11.0/24']);
    expect(fabric[0].defaultGateway).toBe('<REQUIRED>');
    expect('ipv6Cidr' in fabric[0]).toBe(false);
    expect(all(out)).toContain('"ipVersion": "IPv4"');
    expect(all(out)).not.toContain('ipv6Cidr');
    expect(all(out)).not.toContain('CIDRS6');
  });

  it('writes a dual-stack segment as one fabric network with cidr and ipv6Cidr, and matches it on both', () => {
    const out = build('vcfa_network_profile', { existing_cidrs: '10.20.10.0/24+2001:DB8:10::/64, 2001:db8:11::/64' });
    expect(codes(out, 'error')).toEqual([]);
    const fabric = JSON.parse(file(out, 'fabric-networks.json'));
    expect(fabric[0]).toEqual({ _path: 'PATCH /iaas/api/fabric-networks-vsphere/<id for 10.20.10.0/24+2001:DB8:10::/64>', cidr: '10.20.10.0/24', defaultGateway: '<REQUIRED>', ipv6Cidr: '2001:db8:10::/64', defaultIpv6Gateway: '<REQUIRED>', dnsServerAddresses: ['<REQUIRED>'], domain: '<REQUIRED>', tags: fabric[0].tags });
    expect(fabric[1].ipv6Cidr).toBe('2001:db8:11::/64');
    expect('cidr' in fabric[1]).toBe(false);
    expect(all(out)).toContain('var CIDRS6 = ["2001:db8:10::/64","2001:db8:11::/64"];');
    expect(all(out)).toContain('String(networks[i].ipv6Cidr || "").toLowerCase() === CIDRS6[c]');
  });

  it('makes an IPv6 static range ipVersion IPv6 on the first IPv6 network', () => {
    const out = build('vcfa_network_profile', { existing_cidrs: '10.20.10.0/24, 2001:db8:10::/64', range_start: '2001:db8:10::100', range_end: '2001:db8:10::1ff' });
    expect(codes(out, 'error')).toEqual([]);
    expect(codes(out)).not.toContain('vcfa.network.range-outside');
    expect(all(out)).toContain('"ipVersion": "IPv6"');
    expect(all(out)).toContain('"startIPAddress": "2001:db8:10::100"');
    expect(all(out)).toContain('if (c === 1 && RANGE)');
  });

  it('refuses a range that mixes families, and an IPv6 range with no IPv6 network', () => {
    expect(codes(build('vcfa_network_profile', { range_start: '10.20.10.50', range_end: '2001:db8::1' }), 'error')).toContain('vcfa.network.range-family');
    expect(codes(build('vcfa_network_profile', { range_start: '2001:db8::10', range_end: '2001:db8::20' }), 'error')).toContain('vcfa.network.range-no-network');
    expect(codes(build('vcfa_network_profile', { existing_cidrs: '2001:db8:10::/64', range_start: '2001:db8:11::1', range_end: '2001:db8:11::9' }))).toContain('vcfa.network.range-outside');
  });

  it('checks IPv6 overlap and refuses two CIDRs of one family in a segment', () => {
    expect(codes(build('vcfa_network_profile', { existing_cidrs: '2001:db8::/48, 2001:db8:0:5::/64' }), 'error')).toContain('vcfa.network.overlap');
    expect(codes(build('vcfa_network_profile', { existing_cidrs: '2001:db8::/64+2001:db8:1::/64' }), 'error')).toContain('vcfa.network.bad-cidr');
    // An IPv4 and an IPv6 network never overlap.
    expect(codes(build('vcfa_network_profile', { existing_cidrs: '10.20.10.0/24, 2001:db8::/64' }))).not.toContain('vcfa.network.overlap');
  });

  it('refuses IPv6 on-demand address space and writes no IPv6 into isolationNetworkDomainCIDR', () => {
    const out = build('vcfa_network_profile', { mode: 'on-demand', isolation: 'ON_DEMAND_NETWORK', ondemand_cidr: 'fd00:200::/48' });
    expect(codes(out, 'error')).toContain('vcfa.network.ondemand-ipv6');
    expect(all(out)).not.toContain('fd00:200::/48"');
  });
});

describe('vcfa91: NSX VPC stays IPv4, vDefend policies take IPv6 sources', () => {
  it('refuses an IPv6 external IP block and writes the IPv4 one as before', () => {
    expect(codes(build('vcfa91_vpc', { include_ip_block: true, ip_block_cidr: '2001:db8:100::/48' }), 'error')).toContain('vcfa91.vpc.ipv6');
    const v4 = build('vcfa91_vpc', { include_ip_block: true });
    expect(codes(v4, 'error')).toEqual([]);
    expect(all(v4)).toContain('cidr = "203.0.113.0/24"');
    expect(codes(build('vcfa91_vpc', { include_ip_block: true, ip_block_cidr: '999.1.1.0/24' }), 'error')).toContain('vcfa91.vpc.cidr');
  });

  it('writes an IPv6 source as its own ipBlocks cidr, one family per rule, and warns on ::/0', () => {
    const out = build('vcfa91_security_policy', { rules: 'from 10.0.0.0/8 tcp/443\nfrom 2001:DB8:AB::/48 tcp/443\nfrom ::/0 tcp/22' });
    expect(codes(out, 'error')).toEqual([]);
    const text = all(out);
    expect(text).toContain('2001:db8:ab::/48');
    expect(text).toContain('10.0.0.0/8');
    expect(codes(out)).toContain('vcfa91.sp.any');
    const policy = JSON.parse(file(out, 'policy.json') || '[]');
    const rules = (Array.isArray(policy) ? policy[0] : policy)?.object?.spec?.rules ?? [];
    for (const rule of rules.filter((r: { sources?: unknown[] }) => r.sources)) {
      const blocks = rule.sources.flatMap((s: { ipBlocks?: { cidr: string }[] }) => s.ipBlocks ?? []).map((b: { cidr: string }) => b.cidr.includes(':'));
      expect(new Set(blocks).size <= 1).toBe(true);
    }
  });

  it('does not read an unparseable source as a label selector', () => {
    expect(codes(build('vcfa91_security_policy', { rules: 'from 10.0.0.0/33 tcp/443' }))).toContain('vcfa91.sp.rule');
  });
});

describe('vcfnet91_vpc_planning: VPC subnets are IPv4', () => {
  it('refuses an IPv6 port group and keeps the IPv4 plan', () => {
    const out = build('vcfnet91_vpc_planning', { subnets: 'pg-web = 10.20.1.0/24 Public\npg-v6 = 2001:db8:1::/64 Private' });
    expect(codes(out, 'error')).toEqual(['vcfnet91.vpc.ipv6']);
    expect(all(out)).toContain('10.20.1.0/24');
    expect(all(out)).not.toContain('2001:db8:1::/64');
    expect(codes(build('vcfnet91_vpc_planning', { subnets: 'a = 10.0.0.0/16 Private\nb = 10.0.5.0/24 Private' }), 'error')).toContain('vcfnet91.vpc.overlap');
  });
});

describe('vcfa extensibility: AAAA records and VKS networks', () => {
  it('registers an IPv6 address as an Infoblox record:aaaa with ipv6addr, an IPv4 one as record:a', () => {
    const b = automationFor(WORKFLOW_ID);
    if (!b) throw new Error('missing workflow blueprint');
    const out = b.build({ ...defaultValues(b), task: 'dns-record' }, 'x');
    const text = all(out);
    expect(text).toContain('record:aaaa');
    expect(text).toContain('ipv6addr');
    expect(text).toContain('ipv4addr');
    expect(text).toContain('function v6Full(s)');
  });

  it('refuses IPv6 and dual-stack pod or service CIDRs on VKS, and keeps the IPv4 ones', () => {
    const v4 = build('vcfa_vks_cluster');
    expect(codes(v4)).not.toContain('vcfa.vks.bad-cidr');
    expect(all(v4)).toContain('cidrBlocks: ["192.168.0.0/16"]');
    const dual = build('vcfa_vks_cluster', { pod_cidr: '192.168.0.0/16, fd00:10:244::/56' });
    expect(codes(dual, 'error')).toContain('vcfa.vks.ipv6');
    expect(codes(build('vcfa_vks_cluster', { service_cidr: 'fd00:10:96::/112' }), 'error')).toContain('vcfa.vks.ipv6');
    expect(codes(build('vcfa_vks_cluster', { service_cidr: '192.168.10.0/24' }), 'error')).toContain('vcfa.vks.cidr-overlap');
  });
});

describe('fleet91 DNS and NTP precheck: AAAA and ip6.arpa', () => {
  it('keeps the A-only precheck by default', () => {
    const out = build('fleet91_settings');
    expect(codes(out, 'error')).toEqual([]);
    expect(all(out)).toContain('"$n" A |');
    expect(all(out)).not.toContain('TYPES=');
  });

  it('checks AAAA and its reverse for dual-stack, and accepts IPv6 servers with a warning', () => {
    const out = build('fleet91_settings', { record_types: 'both', dns_servers: '10.0.0.10, 2001:db8::53', ntp_servers: 'ntp1.example.com, 2001:db8::123' });
    expect(codes(out, 'error')).toEqual([]);
    expect(codes(out, 'warning')).toContain('fleet91.settings.ipv6-server');
    const text = all(out);
    expect(text).toContain('TYPES=(A AAAA)');
    expect(text).toContain("'2001:db8::53'");
    expect(text).toContain('dig +short +time=2 +tries=1 @"$s" -x "$ip"');
  });

  it('refuses a DNS server that is not an address', () => {
    expect(codes(build('fleet91_settings', { dns_servers: 'dns1.example.com, 10.0.0.11' }), 'error')).toContain('fleet91.settings.dns-not-ip');
  });
});
