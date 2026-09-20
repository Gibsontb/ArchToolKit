import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { emitFoundation, type FoundationPlan } from './index.ts';

function plan(overrides: Partial<FoundationPlan> = {}): FoundationPlan {
  return {
    name: 'core',
    cidr: '10.20.0.0/16',
    region: 'eu-west-1',
    subnets: [
      { name: 'public-a', cidr: '10.20.1.0/24', public: true, zone: 'eu-west-1a' },
      { name: 'private-a', cidr: '10.20.10.0/24' },
    ],
    allowedIngressCidrs: ['10.0.0.0/8'],
    allowedTcpPorts: [443],
    tags: { owner: 'platform' },
    ...overrides,
  };
}

const codes = (findings: readonly { code: string }[]): string[] => findings.map((f) => f.code);

describe('AWS foundation', () => {
  it('creates a VPC, subnets, gateway and routing', () => {
    const { files } = emitFoundation('aws', plan());
    const tf = files['main.tf'] ?? '';
    expect(tf).toContain('resource "aws_vpc" "this"');
    expect(tf).toContain('resource "aws_subnet" "public_a"');
    expect(tf).toContain('resource "aws_internet_gateway" "this"');
    expect(tf).toContain('resource "aws_route_table_association" "public_a"');
  });

  it('uses rule resources rather than inline ingress blocks', () => {
    // The provider asks for this: inline rules have no stable identity and
    // conflict with the rule resources if both ever appear.
    const tf = emitFoundation('aws', plan()).files['main.tf'] ?? '';
    expect(tf).toContain('resource "aws_vpc_security_group_ingress_rule"');
    expect(/^\s+ingress\s*\{/m.test(tf)).toBe(false);
    expect(/^\s+egress\s*\{/m.test(tf)).toBe(false);
  });

  it('sets no port alongside the all-protocols egress rule', () => {
    // ip_protocol "-1" means every protocol, and then ports must be absent.
    const tf = emitFoundation('aws', plan()).files['main.tf'] ?? '';
    const egress = tf.slice(tf.indexOf('aws_vpc_security_group_egress_rule'));
    const block = egress.slice(0, egress.indexOf('\n}'));
    // Attributes are aligned, so match the pair rather than fixed spacing.
    expect(/ip_protocol\s+= "-1"/.test(block)).toBe(true);
    expect(block).not.toContain('from_port');
  });

  it('omits the gateway when nothing is public', () => {
    const tf =
      emitFoundation('aws', plan({ subnets: [{ name: 'a', cidr: '10.20.1.0/24' }] })).files[
        'main.tf'
      ] ?? '';
    expect(tf).not.toContain('aws_internet_gateway');
  });

  it('warns about ingress from the whole internet', () => {
    const out = emitFoundation('aws', plan({ allowedIngressCidrs: ['0.0.0.0/0'] }));
    expect(codes(out.findings)).toContain('terraform.aws.ingress-from-anywhere');
  });
});

describe('Azure foundation', () => {
  it('uses the plural address_prefixes list', () => {
    // The singular address_prefix was removed in provider 3.0.
    const tf = emitFoundation('azure', plan()).files['main.tf'] ?? '';
    expect(tf).toContain('address_prefixes');
    // Anchored to the start of an argument: the NSG rules legitimately use
    // source_address_prefix and destination_address_prefix, which are singular.
    expect(/^\s+address_prefix\s+=/m.test(tf)).toBe(false);
  });

  it('creates a resource group and attaches the security group separately', () => {
    const tf = emitFoundation('azure', plan()).files['main.tf'] ?? '';
    expect(tf).toContain('resource "azurerm_resource_group" "this"');
    expect(tf).toContain('resource "azurerm_subnet_network_security_group_association"');
  });

  it('gives every security rule a distinct priority', () => {
    const tf =
      emitFoundation(
        'azure',
        plan({ allowedIngressCidrs: ['10.0.0.0/8', '192.168.0.0/16'], allowedTcpPorts: [22, 443] }),
      ).files['main.tf'] ?? '';
    const priorities = [...tf.matchAll(/priority\s+= (\d+)/g)].map((m) => Number(m[1]));
    expect(priorities.length).toBe(4);
    expect(new Set(priorities).size).toBe(4);
    expect(priorities.every((p) => p >= 100 && p <= 4096)).toBe(true);
  });

  it('puts no location or tags on a subnet, which has neither', () => {
    const tf = emitFoundation('azure', plan()).files['main.tf'] ?? '';
    const subnet = tf.slice(tf.indexOf('resource "azurerm_subnet" "public_a"'));
    const block = subnet.slice(0, subnet.indexOf('\n}'));
    expect(block).not.toContain('location');
    expect(block).not.toContain('tags');
  });
});

describe('Google foundation', () => {
  it('builds a custom-mode VPC rather than accepting the default', () => {
    // Left at the default, Google creates a subnet in every region.
    const tf = emitFoundation('google', plan()).files['main.tf'] ?? '';
    expect(tf).toContain('auto_create_subnetworks = false');
  });

  it('gives a firewall rule exactly one allow block with a protocol', () => {
    const tf = emitFoundation('google', plan()).files['main.tf'] ?? '';
    expect(tf).toContain('allow {');
    expect(tf).toContain('protocol = "tcp"');
    expect(tf).not.toContain('deny {');
  });

  it('adds Cloud NAT when a private subnet exists', () => {
    const out = emitFoundation('google', plan());
    expect(out.files['main.tf']).toContain('google_compute_router_nat');
    expect(codes(out.findings)).toContain('terraform.google.nat-emitted');
  });

  it('gives the NAT log config both required arguments', () => {
    const tf = emitFoundation('google', plan()).files['main.tf'] ?? '';
    const log = tf.slice(tf.indexOf('log_config'));
    expect(log).toContain('enable = true');
    expect(log).toContain('filter = "ERRORS_ONLY"');
  });

  it('omits NAT when every subnet is public', () => {
    const tf =
      emitFoundation('google', plan({ subnets: [{ name: 'a', cidr: '10.20.1.0/24', public: true }] }))
        .files['main.tf'] ?? '';
    expect(tf).not.toContain('google_compute_router_nat');
  });
});

describe('OCI foundation', () => {
  it('refuses to generate anything without a compartment', () => {
    // compartment_id is required on every OCI resource.
    const out = emitFoundation('oci', plan());
    expect(Object.keys(out.files)).toEqual([]);
    expect(codes(out.findings)).toContain('terraform.oci.no-compartment');
  });

  it('uses the plural cidr_blocks on the VCN', () => {
    const tf =
      emitFoundation('oci', plan({ compartmentId: 'ocid1.compartment.oc1..aaaa' })).files[
        'main.tf'
      ] ?? '';
    expect(tf).toContain('cidr_blocks');
  });

  it('writes protocols as IP numbers, not names', () => {
    // "tcp" is rejected; TCP is protocol 6.
    const tf =
      emitFoundation('oci', plan({ compartmentId: 'ocid1.compartment.oc1..aaaa' })).files[
        'main.tf'
      ] ?? '';
    expect(/protocol\s+= "6"/.test(tf)).toBe(true);
    expect(/protocol\s+= "tcp"/.test(tf)).toBe(false);
  });

  it('expresses a single port as a min and max pair', () => {
    const tf =
      emitFoundation('oci', plan({ compartmentId: 'ocid1.compartment.oc1..aaaa' })).files[
        'main.tf'
      ] ?? '';
    expect(tf).toContain('destination_port_range {');
    expect(tf).toContain('min = 443');
    expect(tf).toContain('max = 443');
  });

  it('gives every route rule a destination_type', () => {
    const tf =
      emitFoundation('oci', plan({ compartmentId: 'ocid1.compartment.oc1..aaaa' })).files[
        'main.tf'
      ] ?? '';
    const rules = tf.match(/destination\s+= "/g) ?? [];
    const types = tf.match(/destination_type\s+= "/g) ?? [];
    expect(types.length).toBe(rules.length);
  });
});

describe('vSphere foundation', () => {
  it('looks up the datacenter rather than creating one', () => {
    const tf = emitFoundation('vsphere', plan({ datacenter: 'DC1' })).files['main.tf'] ?? '';
    expect(tf).toContain('data "vsphere_datacenter" "this"');
    expect(tf).not.toContain('resource "vsphere_datacenter"');
  });

  it('parents a resource pool on the cluster root pool, not the cluster', () => {
    const tf =
      emitFoundation('vsphere', plan({ datacenter: 'DC1', cluster: 'Cluster1' })).files['main.tf'] ??
      '';
    expect(tf).toContain('parent_resource_pool_id');
    expect(tf).toContain('data.vsphere_compute_cluster.this.resource_pool_id');
  });

  it('references the switch by the argument that wants its UUID', () => {
    const tf = emitFoundation('vsphere', plan({ datacenter: 'DC1' })).files['main.tf'] ?? '';
    expect(tf).toContain('distributed_virtual_switch_uuid');
  });

  it('names uplinks explicitly rather than trusting the defaults', () => {
    const tf =
      emitFoundation('vsphere', plan({ datacenter: 'DC1', vmnics: ['vmnic0', 'vmnic1', 'vmnic2'] }))
        .files['main.tf'] ?? '';
    expect(tf).toContain('["uplink1", "uplink2", "uplink3"]');
  });

  it('warns when no cluster was named for the resource pool', () => {
    const out = emitFoundation('vsphere', plan({ datacenter: 'DC1' }));
    expect(codes(out.findings)).toContain('terraform.vsphere.no-cluster');
  });
});

describe('the kit as a whole', () => {
  it('emits something for every cloud', () => {
    for (const target of ['aws', 'azure', 'google', 'vsphere'] as const) {
      const out = emitFoundation(target, plan({ datacenter: 'DC1', cluster: 'C1' }));
      expect(Object.keys(out.files).length > 0).toBe(true);
      expect((out.files['main.tf'] ?? '').length > 200).toBe(true);
    }
  });

  it('sends VCF to the specification path instead', () => {
    const out = emitFoundation('vcf', plan());
    expect(codes(out.findings)).toContain('terraform.foundation.vcf-not-a-foundation');
  });

  it('produces balanced files for every cloud', () => {
    // A cheap structural guard: every brace and bracket closes, and no string
    // carries a live interpolation.
    for (const target of ['aws', 'azure', 'google', 'oci', 'vsphere'] as const) {
      const out = emitFoundation(
        target,
        plan({ compartmentId: 'ocid1.compartment.oc1..aaaa', datacenter: 'DC1', cluster: 'C1' }),
      );
      for (const [name, body] of Object.entries(out.files)) {
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (const ch of body) {
          if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
          }
          if (ch === '"') inString = true;
          else if (ch === '{' || ch === '[') depth += 1;
          else if (ch === '}' || ch === ']') depth -= 1;
        }
        if (depth !== 0) throw new Error(`${target}/${name} is unbalanced (depth ${depth})`);
        expect(depth).toBe(0);
      }
    }
  });
});
