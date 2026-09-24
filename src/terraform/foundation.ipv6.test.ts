import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { emitFoundation, type FoundationPlan } from './index.ts';

function plan(overrides: Partial<FoundationPlan> = {}): FoundationPlan {
  return {
    name: 'core',
    cidr: '10.20.0.0/16',
    region: 'eu-west-1',
    compartmentId: 'ocid1.compartment.oc1..aaaa',
    subnets: [
      { name: 'public-a', cidr: '10.20.1.0/24', public: true },
      { name: 'private-a', cidr: '10.20.10.0/24' },
    ],
    allowedIngressCidrs: ['10.0.0.0/8'],
    allowedTcpPorts: [443],
    ...overrides,
  };
}

const dual = (o: Partial<FoundationPlan> = {}): FoundationPlan =>
  plan({ ipv6: true, ipv6Cidr: 'fd00:db8:deca::/48', allowedIngressCidrs: ['10.0.0.0/8', '2001:db8:1::/48'], ...o });
const tf = (target: 'aws' | 'azure' | 'google' | 'oci', p: FoundationPlan): string => emitFoundation(target, p).files['main.tf'] ?? '';
const codes = (target: 'aws' | 'azure' | 'google' | 'oci', p: FoundationPlan): string[] => emitFoundation(target, p).findings.map((f) => f.code);
const errors = (target: 'aws' | 'azure' | 'google' | 'oci', p: FoundationPlan): string[] =>
  emitFoundation(target, p).findings.filter((f) => f.severity === 'error').map((f) => f.code);

describe('foundations stay IPv4 until dual stack is asked for', () => {
  it('emits no IPv6 anywhere by default', () => {
    for (const target of ['aws', 'azure', 'google', 'oci'] as const) {
      const text = tf(target, plan());
      expect([target, /ipv6|::\/0|IPV4_IPV6/i.test(text)]).toEqual([target, false]);
      expect([target, errors(target, plan())]).toEqual([target, []]);
    }
  });

  it('refuses an IPv6 range in the IPv4 cidr fields, and produces no files', () => {
    for (const target of ['aws', 'azure', 'google', 'oci'] as const) {
      const out = emitFoundation(target, plan({ cidr: '2001:db8::/56' }));
      expect([target, out.findings.some((f) => f.code === `terraform.${target}.ipv4-range-required`)]).toEqual([target, true]);
      expect([target, Object.keys(out.files)]).toEqual([target, []]);
    }
  });

  it('rejects an ingress source that is not an address', () => {
    expect(errors('aws', plan({ allowedIngressCidrs: ['not-an-ip'] }))).toContain('terraform.aws.invalid-ingress-cidr');
  });

  it('warns that an IPv6 source cannot match on an IPv4-only network', () => {
    expect(codes('aws', plan({ allowedIngressCidrs: ['2001:db8::/32'] }))).toContain('terraform.aws.ipv6-ingress-without-ipv6');
  });

  it('warns about ::/0 as the whole internet, as for 0.0.0.0/0', () => {
    for (const target of ['aws', 'azure', 'google', 'oci'] as const) {
      expect([target, codes(target, dual({ allowedIngressCidrs: ['::/0'] })).includes(`terraform.${target}.ingress-from-anywhere`)]).toEqual([target, true]);
    }
  });
});

describe('AWS dual stack', () => {
  const text = tf('aws', dual());

  it('asks Amazon for the /56 and gives each subnet a /64 of it', () => {
    expect(/assign_generated_ipv6_cidr_block\s+= true/.test(text)).toBe(true);
    expect(text).toContain('cidrsubnet(aws_vpc.this.ipv6_cidr_block, 8, 0)');
    expect(text).toContain('cidrsubnet(aws_vpc.this.ipv6_cidr_block, 8, 1)');
    expect(/assign_ipv6_address_on_creation\s+= true/.test(text)).toBe(true);
  });

  it('routes ::/0 to the internet gateway for public and an egress-only gateway for private', () => {
    expect(/ipv6_cidr_block\s+= "::\/0"\s+gateway_id\s+= aws_internet_gateway\.this\.id/.test(text)).toBe(true);
    expect(text).toContain('resource "aws_egress_only_internet_gateway" "this"');
    expect(/egress_only_gateway_id\s+= aws_egress_only_internet_gateway\.this\.id/.test(text)).toBe(true);
    expect(text).toContain('resource "aws_route_table_association" "private_a"');
  });

  it('writes each rule with one family: cidr_ipv4 or cidr_ipv6', () => {
    expect(/cidr_ipv4\s+= "10\.0\.0\.0\/8"/.test(text)).toBe(true);
    expect(/cidr_ipv6\s+= "2001:db8:1::\/48"/.test(text)).toBe(true);
    expect(/cidr_ipv6\s+= "::\/0"/.test(text)).toBe(true);
    const rules = text.split('resource "aws_vpc_security_group_').slice(1);
    for (const r of rules) expect(/cidr_ipv4/.test(r) && /cidr_ipv6/.test(r)).toBe(false);
  });
});

describe('Azure dual stack', () => {
  it('adds the IPv6 range to the VNet and a /64 to each subnet', () => {
    const text = tf('azure', dual());
    expect(text).toContain('["10.20.0.0/16", "fd00:db8:deca::/48"]');
    expect(text).toContain('["10.20.1.0/24", "fd00:db8:deca::/64"]');
    expect(text).toContain('["10.20.10.0/24", "fd00:db8:deca:1::/64"]');
  });

  it('keeps each security rule to one source of one family', () => {
    const text = tf('azure', dual());
    expect(/source_address_prefix\s+= "2001:db8:1::\/48"/.test(text)).toBe(true);
    expect(/source_address_prefix\s+= "10\.0\.0\.0\/8"/.test(text)).toBe(true);
  });

  it('needs an IPv6 range, since Azure does not allocate one', () => {
    expect(errors('azure', dual({ ipv6Cidr: undefined }))).toContain('terraform.azure.ipv6-cidr-required');
  });

  it('refuses a subnet IPv6 range that is not a /64 or not inside the VNet', () => {
    const bad = dual({ subnets: [{ name: 'a', cidr: '10.20.1.0/24', ipv6Cidr: 'fd00:db8:deca::/56' }] });
    expect(errors('azure', bad)).toContain('terraform.azure.subnet-ipv6-not-64');
    const outside = dual({ subnets: [{ name: 'a', cidr: '10.20.1.0/24', ipv6Cidr: 'fd00:1::/64' }] });
    expect(errors('azure', outside)).toContain('terraform.azure.subnet-ipv6-outside');
  });
});

describe('Google dual stack', () => {
  const text = tf('google', dual());

  it('makes subnets IPV4_IPV6 with the right access type', () => {
    expect(/stack_type\s+= "IPV4_IPV6"/.test(text)).toBe(true);
    expect(/ipv6_access_type\s+= "EXTERNAL"/.test(text)).toBe(true);
    expect(/ipv6_access_type\s+= "INTERNAL"/.test(text)).toBe(true);
    // INTERNAL IPv6 draws on the network's ULA range, which must be turned on.
    expect(/enable_ula_internal_ipv6\s+= true/.test(text)).toBe(true);
  });

  it('puts IPv6 sources in their own firewall rule', () => {
    expect(text).toContain('resource "google_compute_firewall" "allow_ingress"');
    expect(text).toContain('resource "google_compute_firewall" "allow_ingress_ipv6"');
    const v4 = text.slice(text.indexOf('"allow_ingress" {'), text.indexOf('"allow_ingress_ipv6"'));
    expect(v4).not.toContain('2001:db8');
  });
});

describe('OCI dual stack', () => {
  const text = tf('oci', dual());

  it('enables IPv6 on the VCN and gives subnets /64s of it', () => {
    expect(/is_ipv6enabled\s+= true/.test(text)).toBe(true);
    expect(text).toContain('[cidrsubnet(oci_core_vcn.this.ipv6cidr_blocks[0], 8, 0)]');
    expect(text).toContain('[cidrsubnet(oci_core_vcn.this.ipv6cidr_blocks[0], 8, 1)]');
  });

  it('routes and allows ::/0 as its own rule with a destination_type', () => {
    expect(/destination\s+= "::\/0"/.test(text)).toBe(true);
    const rules = text.match(/destination\s+= "/g) ?? [];
    const types = text.match(/destination_type\s+= "/g) ?? [];
    expect(types.length).toBe(rules.length);
    expect(/source\s+= "2001:db8:1::\/48"/.test(text)).toBe(true);
  });
});
