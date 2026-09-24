import { describe, it } from 'node:test';
import { expect } from '../../testing/expect.ts';
import { TERRAFORM_BLUEPRINTS } from './index.ts';
import { defaultValues, type BlueprintValues } from '../../kit/blueprint.ts';

function build(target: string, id: string, overrides: BlueprintValues = {}) {
  const blueprint = TERRAFORM_BLUEPRINTS.find((g) => g.target === target)!.blueprints.find((b) => b.id === id)!;
  const out = blueprint.build({ ...defaultValues(blueprint), ...overrides }, 'demo');
  const text = Object.values(out.files).join('\n');
  const findings = out.findings ?? [];
  return {
    text,
    codes: findings.map((f) => f.code),
    errors: findings.filter((f) => f.severity === 'error').map((f) => f.code),
  };
}

describe('AWS resource blueprints, dual stack', () => {
  it('leaves the VPC baseline IPv4-only by default', () => {
    const { text, errors } = build('aws', 'aws_vpc_baseline');
    expect(/ipv6|::\/0/.test(text)).toBe(false);
    expect(errors).toEqual([]);
  });

  it('builds the VPC baseline dual-stack when asked', () => {
    const { text, errors } = build('aws', 'aws_vpc_baseline', { enable_ipv6: 'true' });
    expect(errors).toEqual([]);
    expect(/assign_generated_ipv6_cidr_block = true/.test(text)).toBe(true);
    expect(text).toContain('cidrsubnet(aws_vpc.this.ipv6_cidr_block, 8, 0)');
    expect(text).toContain('cidrsubnet(aws_vpc.this.ipv6_cidr_block, 8, 1)');
    expect(/ipv6_cidr_block = "::\/0"/.test(text)).toBe(true);
  });

  it('refuses an IPv6 range where the VPC needs its IPv4 one', () => {
    expect(build('aws', 'aws_vpc_baseline', { vpc_cidr: '2001:db8::/56' }).errors).toContain('terraform.aws_vpc_baseline.ipv4-range-required');
  });

  it('keeps the EC2 security group IPv4 output as it was', () => {
    const { text } = build('aws', 'aws_ec2_instance');
    expect(text).toContain('cidr_blocks = ["10.0.0.0/16"]');
    expect(text).not.toContain('ipv6');
  });

  it('puts an IPv6 SSH source in ipv6_cidr_blocks, in its own ingress block', () => {
    const { text, errors } = build('aws', 'aws_ec2_instance', { allow_ssh_cidr: '10.0.0.0/16, 2001:db8::/48', ipv6_address_count: '1' });
    expect(errors).toEqual([]);
    expect(text).toContain('ipv6_cidr_blocks = ["2001:db8::/48"]');
    expect(text).toContain('ipv6_cidr_blocks = ["::/0"]');
    expect(/ipv6_address_count\s+= 1/.test(text)).toBe(true);
    const blocks = text.split('ingress {').slice(1).map((b) => b.slice(0, b.indexOf('}')));
    expect(blocks.length).toBe(2);
    for (const b of blocks) expect(/^\s+cidr_blocks =/m.test(b) && b.includes('ipv6_cidr_blocks')).toBe(false);
  });

  it('rejects a source that is not an address, and warns about ::/0', () => {
    expect(build('aws', 'aws_ec2_instance', { allow_ssh_cidr: 'bogus' }).errors).toContain('terraform.aws_ec2_instance.invalid-source');
    expect(build('aws', 'aws_ec2_instance', { allow_ssh_cidr: '::/0' }).codes).toContain('terraform.aws_ec2_instance.open-to-world');
  });

  it('offers RDS dual-stack networking', () => {
    expect(build('aws', 'aws_rds_postgres').text).not.toContain('network_type');
    expect(build('aws', 'aws_rds_postgres', { network_type: 'DUAL' }).text).toContain('network_type            = "DUAL"');
  });
});

describe('Azure Linux VM, dual stack', () => {
  it('keeps the IPv4 network as it was by default', () => {
    const { text, errors } = build('azure', 'azurerm_linux_vm');
    expect(errors).toEqual([]);
    expect(text).toContain('address_space       = ["10.10.0.0/16"]');
    expect(text).toContain('address_prefixes     = ["10.10.1.0/24"]');
    expect(text).toContain('source_address_prefix      = "10.0.0.0/8"');
    expect(text).not.toContain('IPv6');
  });

  it('adds IPv6 to the VNet, a /64 to the subnet and an IPv6 NIC configuration', () => {
    const { text, errors } = build('azure', 'azurerm_linux_vm', { enable_ipv6: 'true', ssh_source_cidr: '10.0.0.0/8,2001:db8::/48' });
    expect(errors).toEqual([]);
    expect(text).toContain('["10.10.0.0/16", "fd00:db8:deca::/48"]');
    expect(text).toContain('["10.10.1.0/24", "fd00:db8:deca::/64"]');
    expect(text).toContain('private_ip_address_version    = "IPv6"');
    expect(/primary\s+= true/.test(text)).toBe(true);
    // One rule per family.
    expect(text).toContain('name                       = "SSH-IPv6"');
    expect(text).toContain('source_address_prefix      = "2001:db8::/48"');
  });

  it('refuses a subnet IPv6 prefix that is not a /64', () => {
    expect(build('azure', 'azurerm_linux_vm', { enable_ipv6: 'true', subnet_ipv6_cidr: 'fd00:db8:deca::/56' }).errors).toContain(
      'terraform.azurerm_linux_vm.ipv6-prefix',
    );
  });

  it('warns that an IPv6 SSH source cannot match without dual stack', () => {
    expect(build('azure', 'azurerm_linux_vm', { ssh_source_cidr: '2001:db8::/48' }).codes).toContain('terraform.azurerm_linux_vm.ipv6-source-without-ipv6');
  });
});

describe('OCI VCN baseline, dual stack', () => {
  it('uses the argument the provider has for enabling the gateway', () => {
    const { text } = build('oci', 'oci_core_vcn_baseline');
    expect(/\benabled\s+= true/.test(text)).toBe(true);
    expect(text).not.toContain('is_enabled');
    expect(/ipv6|::\/0/.test(text)).toBe(false);
  });

  it('enables IPv6 on the VCN, /64s on the subnets and a ::/0 route', () => {
    const { text, errors } = build('oci', 'oci_core_vcn_baseline', { enable_ipv6: 'true' });
    expect(errors).toEqual([]);
    expect(text).toContain('is_ipv6enabled = true');
    expect(text).toContain('[cidrsubnet(oci_core_vcn.this.ipv6cidr_blocks[0], 8, 0)]');
    expect(text).toContain('destination       = "::/0"');
  });
});

describe('module blueprints surface dual stack', () => {
  it('writes the AWS VPC module IPv6 inputs when given', () => {
    const { text, errors } = build('aws', 'aws_module_vpc', {
      enable_ipv6: 'true',
      public_subnet_ipv6_prefixes: '0,1,2',
      private_subnet_ipv6_prefixes: '3,4,5',
    });
    expect(errors).toEqual([]);
    expect(/enable_ipv6\s+= true/.test(text)).toBe(true);
    expect(/public_subnet_ipv6_prefixes\s+= \["0", "1", "2"\]/.test(text)).toBe(true);
  });

  it('refuses IPv6 prefixes that do not match the subnets, or without dual stack', () => {
    expect(build('aws', 'aws_module_vpc', { enable_ipv6: 'true', public_subnet_ipv6_prefixes: '0,1' }).errors).toContain('terraform.aws_module_vpc.ipv6-prefix-count');
    expect(build('aws', 'aws_module_vpc', { public_subnet_ipv6_prefixes: '0,1,2' }).errors).toContain('terraform.aws_module_vpc.ipv6-prefixes-without-ipv6');
  });

  it('offers ip_family on EKS and stack_type on GKE', () => {
    expect(build('aws', 'aws_module_eks', { ip_family: 'ipv6', create_cni_ipv6_iam_policy: 'true' }).text).toContain('"ipv6"');
    expect(build('aws', 'aws_module_eks', { ip_family: 'ipv6' }).codes).toContain('terraform.aws_module_eks.ipv6-cni-policy');
    expect(build('google', 'google_module_gke', { stack_type: 'IPV4_IPV6' }).text).toContain('"IPV4_IPV6"');
  });

  it('checks the Azure VNet address space for either family', () => {
    expect(build('azure', 'azure_module_vnet', { address_space: '10.30.0.0/16,fd00:db8:30::/48' }).errors).toEqual([]);
    expect(build('azure', 'azure_module_vnet', { address_space: 'fd00:db8:30::/48' }).errors).toContain('terraform.azure_module_vnet.ipv6-only');
  });

  it('checks the Google internal IPv6 range and the OCI VCN IPv6 inputs', () => {
    expect(build('google', 'google_module_network', { enable_ipv6_ula: 'true', internal_ipv6_range: 'fd20:1:2::/48' }).errors).toEqual([]);
    expect(build('google', 'google_module_network', { enable_ipv6_ula: 'true', internal_ipv6_range: 'fd00::/48' }).errors).toContain('terraform.google_module_network.internal-ipv6-range');
    expect(/enable_ipv6\s+= true/.test(build('oci', 'oci_module_vcn', { enable_ipv6: 'true' }).text)).toBe(true);
    expect(build('oci', 'oci_module_vcn', { vcn_ipv6private_cidr_blocks: 'fd00:50::/48' }).errors).toContain('terraform.oci_module_vcn.ipv6-cidrs-without-ipv6');
  });
});
