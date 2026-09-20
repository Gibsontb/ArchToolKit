/**
 * The build plan has to agree with what Terraform would do.
 *
 * These cases are the ec2-instance module's own conditions, read from its
 * source, against the answers someone would give on the form. If one of them
 * starts saying "created" where Terraform would not create it, the panel on
 * the page is lying, which is worse than it not being there.
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { planModule } from './module-plan.ts';
import { registryModules } from './modules.ts';
import { TERRAFORM_BLUEPRINTS } from './blueprints/index.ts';
import { defaultValues } from '../kit/blueprint.ts';

const EC2 = 'terraform-aws-modules/ec2-instance/aws';

function status(values: Record<string, string>, address: string): string | undefined {
  return planModule(EC2, values).find((r) => r.address === address)?.status;
}

describe('what a module call will build', () => {
  it('with nothing set, builds what the module’s defaults build', () => {
    expect(status({}, 'aws_instance.this')).toBe('yes');
    expect(status({}, 'aws_security_group.this')).toBe('yes');
    expect(status({}, 'aws_eip.this')).toBe('no');
    expect(status({}, 'aws_iam_role.this')).toBe('no');
    expect(status({}, 'aws_spot_instance_request.this')).toBe('no');
  });

  it('follows a switch', () => {
    expect(status({ create_iam_instance_profile: 'true' }, 'aws_iam_role.this')).toBe('yes');
    expect(status({ create_iam_instance_profile: 'true' }, 'aws_iam_instance_profile.this')).toBe('yes');
  });

  it('follows a switch that replaces one resource with another', () => {
    expect(status({ create_spot_instance: 'true' }, 'aws_instance.this')).toBe('no');
    expect(status({ create_spot_instance: 'true' }, 'aws_spot_instance_request.this')).toBe('yes');
  });

  it('respects a condition with two parts — no elastic IP on a spot instance', () => {
    expect(status({ create_eip: 'true' }, 'aws_eip.this')).toBe('yes');
    expect(status({ create_eip: 'true', create_spot_instance: 'true' }, 'aws_eip.this')).toBe('no');
  });

  it('looks through a local to the inputs it is made of', () => {
    // create_security_group is local.create_security_group in the module,
    // which is var.create && var.create_security_group && network_interface == null.
    expect(status({ create_security_group: 'false' }, 'aws_security_group.this')).toBe('no');
  });

  it('builds one per entry of a map, and none from an empty one', () => {
    expect(status({}, 'aws_ebs_volume.this')).toBe('no');
    expect(status({ ebs_volumes: '{ data = { size = 100 } }' }, 'aws_ebs_volume.this')).toBe('yes');
  });

  it('builds a filtered loop only when the filter holds', () => {
    // Egress rules default to allow-all, so they exist — until the security
    // group they belong to is switched off.
    expect(status({}, 'aws_vpc_security_group_egress_rule.this')).toBe('yes');
    expect(status({ create_security_group: 'false' }, 'aws_vpc_security_group_egress_rule.this')).toBe('no');
  });

  it('says which answer decided it', () => {
    const eip = planModule(EC2, { create_eip: 'true' }).find((r) => r.address === 'aws_eip.this');
    expect(eip?.because).toContain('create_eip = true');
  });

  it('lists every resource the module declares, as the registry page does', () => {
    const addresses = planModule(EC2, {}).filter((r) => r.kind === 'resource').map((r) => r.address);
    for (const expected of [
      'aws_ebs_volume.this',
      'aws_ec2_tag.spot_instance',
      'aws_eip.this',
      'aws_iam_instance_profile.this',
      'aws_iam_role.this',
      'aws_iam_role_policy_attachment.this',
      'aws_instance.ignore_ami',
      'aws_instance.this',
      'aws_security_group.this',
      'aws_spot_instance_request.this',
      'aws_volume_attachment.this',
      'aws_vpc_security_group_egress_rule.this',
      'aws_vpc_security_group_ingress_rule.this',
    ]) {
      expect(addresses.includes(expected)).toBe(true);
    }
  });

  it('never throws on any module, whatever its conditions look like', () => {
    for (const module of registryModules()) {
      const plan = planModule(module.source, {});
      for (const row of plan) expect(['yes', 'no', 'depends'].includes(row.status)).toBe(true);
    }
  });
});

describe('the module blueprints offer the whole table', () => {
  it('every input the module takes is on the form', () => {
    for (const group of TERRAFORM_BLUEPRINTS) {
      for (const blueprint of group.blueprints) {
        if (blueprint.group !== 'Terraform Registry modules') continue;
        const module = registryModules().find((m) => m.source === blueprint.emits[0]);
        const offered = new Set(blueprint.inputs.map((i) => i.id));
        for (const input of module?.inputs ?? []) expect(offered.has(input.name)).toBe(true);
      }
    }
  });

  it('writes only what was set — an untouched input keeps the module default', () => {
    for (const group of TERRAFORM_BLUEPRINTS) {
      const blueprint = group.blueprints.find((b) => b.id === 'aws_module_ec2');
      if (!blueprint) continue;
      const text = blueprint.build(defaultValues(blueprint), 'demo').files['main.tf'] ?? '';
      expect(text).not.toContain('ebs_volumes');
      expect(text).not.toContain('putin_khuylo');
      expect(text).toContain('instance_type');
    }
  });

  it('reports what the call will build', () => {
    for (const group of TERRAFORM_BLUEPRINTS) {
      const blueprint = group.blueprints.find((b) => b.id === 'aws_module_ec2');
      if (!blueprint) continue;
      const builds = blueprint.build(defaultValues(blueprint), 'demo').builds ?? [];
      expect(builds.some((b) => b.address === 'aws_instance.this' && b.status === 'yes')).toBe(true);
    }
  });
});
