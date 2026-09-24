import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { ANSIBLE_BLUEPRINTS } from './blueprints/index.ts';
import { defaultValues, type BlueprintValues } from '../kit/blueprint.ts';
import { hostAddress } from './estate.ts';
import type { InventoryVm } from '../vmware/inventory.ts';

function build(target: string, id: string, overrides: BlueprintValues = {}) {
  const blueprint = ANSIBLE_BLUEPRINTS.find((g) => g.target === target)!.blueprints.find((b) => b.id === id)!;
  const out = blueprint.build({ ...defaultValues(blueprint), ...overrides }, 'play');
  const findings = out.findings ?? [];
  return {
    play: out.files['play.yml'] ?? '',
    requirements: out.files['requirements.yml'] ?? '',
    codes: findings.map((f) => f.code),
    errors: findings.filter((f) => f.severity === 'error').map((f) => f.code),
  };
}

describe('AWS playbooks, dual stack', () => {
  it('leaves the VPC play IPv4-only by default, with no extra collection', () => {
    const { play, requirements, errors } = build('aws', 'vpc_baseline');
    expect(/ipv6|::\/0/.test(play)).toBe(false);
    expect(requirements).not.toContain('ansible.utils');
    expect(errors).toEqual([]);
  });

  it('asks for the /56, carves /64s and routes ::/0 to the gateway', () => {
    const { play, requirements, errors } = build('aws', 'vpc_baseline', { enable_ipv6: 'true' });
    expect(errors).toEqual([]);
    expect(play).toContain('ipv6_cidr: true');
    expect(play).toContain('ansible.utils.ipsubnet(64, 0)');
    expect(play).toContain('ansible.utils.ipsubnet(64, 1)');
    expect(play).toContain('assign_instances_ipv6: true');
    expect(play).toContain("dest: '::/0'");
    expect(requirements).toContain('- name: ansible.utils');
  });

  it('refuses an IPv6 range in the IPv4 VPC field', () => {
    expect(build('aws', 'vpc_baseline', { vpc_cidr: '2001:db8::/56' }).errors).toContain('ansible.aws.vpc_baseline.ipv4-range-required');
  });

  it('keeps the security group rules as they were for IPv4', () => {
    const { play } = build('aws', 'ec2_instance');
    expect(play).toContain('cidr_ip: 0.0.0.0/0');
    expect(play).toContain("cidr_ip: '{{ allowed_http_cidr }}'");
    expect(play).not.toContain('cidr_ipv6');
  });

  it('puts IPv6 sources in their own rule entries under cidr_ipv6', () => {
    const { play, codes, errors } = build('aws', 'ec2_instance', { allowed_http_cidr: '10.0.0.0/8,2001:db8::/32', allowed_ssh_cidr: '::/0' });
    expect(errors).toEqual([]);
    expect(play).toContain("cidr_ipv6: '::/0'");
    expect(play).toContain("cidr_ipv6: '{{ allowed_http_cidr_ipv6 }}'");
    expect(play).toContain('allowed_http_cidr_ipv6: 2001:db8::/32');
    expect(codes).toContain('ansible.aws.ec2_instance.open-to-world');
    // No entry names both families.
    const entries = play.split('- proto:').slice(1);
    for (const e of entries) expect(e.includes('cidr_ip:') && e.includes('cidr_ipv6:')).toBe(false);
  });
});

describe('Azure playbooks, dual stack', () => {
  it('adds the IPv6 range to the VNet and a /64 to each subnet', () => {
    const { play, errors } = build('azure', 'vnet_baseline', { enable_ipv6: 'true' });
    expect(errors).toEqual([]);
    expect(play).toContain('vnet_ipv6_prefix: fd00:db8:deca::/48');
    expect(play).toContain('public_subnet_ipv6_prefix: fd00:db8:deca::/64');
    expect(play).toContain('private_subnet_ipv6_prefix: fd00:db8:deca:1::/64');
    expect(play).toContain('address_prefixes_cidr:');
  });

  it('keeps the IPv4 subnets on address_prefix by default', () => {
    const { play } = build('azure', 'vnet_baseline');
    expect(play).toContain("address_prefix: '{{ public_subnet_prefix }}'");
    expect(play).not.toContain('ipv6');
  });

  it('refuses a subnet IPv6 prefix that is not a /64 inside the VNet', () => {
    expect(build('azure', 'vnet_baseline', { enable_ipv6: 'true', public_subnet_ipv6_prefix: 'fd00:db8:deca::/60' }).errors).toContain('ansible.azure.vnet_baseline.ipv6-prefix');
    expect(build('azure', 'vnet_baseline', { enable_ipv6: 'true', public_subnet_ipv6_prefix: 'fd00:1::/64' }).errors).toContain('ansible.azure.vnet_baseline.subnet-ipv6-outside');
  });

  it('makes the VM network ranges inputs, with the old values as defaults', () => {
    const { play, errors } = build('azure', 'vm_linux');
    expect(errors).toEqual([]);
    expect(play).toContain('- 10.10.0.0/16');
    expect(play).toContain('address_prefix: 10.10.1.0/24');
    expect(build('azure', 'vm_linux', { vnet_prefix: 'fd00::/48' }).errors).toContain('ansible.azure.vm_linux.ipv4-range-required');
  });
});

describe('GCP playbook firewall rules', () => {
  it('keeps IPv4 as it was and splits IPv6 into its own rule', () => {
    expect(build('google', 'vpc_network').play).not.toContain('ipv6');
    const { play } = build('google', 'vpc_network', { ssh_source_ranges: '10.0.0.0/8, 2001:db8::/32' });
    expect(play).toContain('-allow-ssh-ipv6');
    const v6rule = play.slice(play.indexOf('Allow SSH ingress over IPv6'));
    expect(v6rule.slice(0, v6rule.indexOf('- name:', 5))).not.toContain('10.0.0.0/8');
  });
});

describe('OCI playbooks, dual stack', () => {
  it('enables IPv6 on the VCN, carves /64s and routes ::/0', () => {
    const { play, errors } = build('oci', 'vcn_baseline', { enable_ipv6: 'true' });
    expect(errors).toEqual([]);
    expect(play).toContain('is_ipv6_enabled: true');
    expect(play).toContain('ipv6_cidr_blocks:');
    expect(play).toContain("destination: '::/0'");
    expect(play).toContain('destination_type: CIDR_BLOCK');
  });

  it('does not generate IPv6 load balancer backends, and says so', () => {
    const { play, codes } = build('oci', 'load_balancer', { backend_ip: '10.50.1.10,2001:db8::10' });
    expect(play).not.toContain('2001:db8::10');
    expect(codes).toContain('ansible.oci.load_balancer.ipv6-backends-not-generated');
    expect(build('oci', 'load_balancer', { backend_ip: 'nope' }).errors).toContain('ansible.oci.load_balancer.invalid-backend');
  });
});

describe('estate inventory addresses', () => {
  const vm = (v: Partial<InventoryVm>): InventoryVm => ({ name: 'x', powerState: 'poweredOn', vcpu: 1, memoryGib: 1, provisionedGib: 1, ...v }) as InventoryVm;

  it('prefers the primary address, then IPv4, then a routable IPv6', () => {
    expect(hostAddress(vm({ ipAddress: '2001:db8::5' }))).toBe('2001:db8::5');
    expect(hostAddress(vm({ ipAddresses: ['2001:db8::5', '10.1.0.5'] }))).toBe('10.1.0.5');
    expect(hostAddress(vm({ ipAddresses: ['fe80::1', '2001:db8::5'] }))).toBe('2001:db8::5');
    expect(hostAddress(vm({ ipAddresses: ['fe80::1'] }))).toBe(undefined);
  });
});
