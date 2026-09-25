import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { defaultValues, type BlueprintValues } from '../kit/blueprint.ts';
import { TERRAFORM_BLUEPRINTS } from './blueprints/index.ts';
import { VMWARE_SCHEMA_DATA } from './vmware-schema-data.ts';
import { q } from './blueprints/scenario-common.ts';
import { humanize, isExpression, providerBlueprints, resourceBlueprint, VMWARE_PROVIDERS } from './schema-blueprints.ts';

const build = (type: string, values: BlueprintValues = {}): string => {
  const blueprint = resourceBlueprint(type);
  return blueprint.build({ ...defaultValues(blueprint), ...values }, 'test').files['main.tf'] ?? '';
};

describe('terraform/schema-blueprints: one blueprint per resource', () => {
  it('offers every resource of all six providers', () => {
    for (const provider of VMWARE_PROVIDERS) {
      const resources = Object.keys((VMWARE_SCHEMA_DATA as Record<string, { resources: object }>)[provider]!.resources);
      expect([provider, providerBlueprints(provider).length]).toEqual([provider, resources.length]);
    }
  });

  it('puts them on the vSphere and VCF platforms, under a heading per product', () => {
    const vsphere = TERRAFORM_BLUEPRINTS.find((g) => g.target === 'vsphere')!;
    const vcf = TERRAFORM_BLUEPRINTS.find((g) => g.target === 'vcf')!;
    expect(vsphere.blueprints.some((b) => b.id === 'vmw_vsphere_virtual_machine')).toBe(true);
    for (const id of ['vmw_vcf_domain', 'vmw_nsxt_policy_segment', 'vmw_avi_virtualservice', 'vmw_vra_project', 'vmw_vcd_org_vdc']) {
      expect([id, vcf.blueprints.some((b) => b.id === id)]).toEqual([id, true]);
    }
    expect(vcf.blueprints.find((b) => b.id === 'vmw_nsxt_policy_segment')?.group).toBe('NSX · Segments');
  });

  it('asks for every argument: required up top, optional in a section, nested blocks behind a tick box', () => {
    const blueprint = resourceBlueprint('vsphere_compute_cluster_vm_host_rule');
    const byId = new Map(blueprint.inputs.map((i) => [i.id, i]));
    expect(byId.get('r.compute_cluster_id')?.section).toBeUndefined();
    expect(byId.get('r.mandatory')?.section).toBe('Optional arguments');

    const vm = resourceBlueprint('vsphere_virtual_machine');
    const clone = vm.inputs.find((i) => i.id === 'b.clone');
    expect(clone?.control).toBe('toggle');
    expect(vm.inputs.find((i) => i.id === 'r.clone.template_uuid')?.showWhen).toEqual({ input: 'b.clone', equals: ['true'] });
  });

  it('turns a documented closed set into a dropdown', () => {
    const vds = resourceBlueprint('vsphere_distributed_virtual_switch');
    const lldp = vds.inputs.find((i) => i.id === 'r.link_discovery_protocol');
    expect(lldp?.control).toBe('combo');
    expect(lldp?.options?.map((o) => o.value)).toEqual(['cdp', 'lldp']);
  });
});

describe('terraform/schema-blueprints: the HCL it writes', () => {
  it('writes the provider block, with the credential as a sensitive variable and never as text', () => {
    const hcl = build('vsphere_folder', { 'r.path': 'Prod', 'r.type': 'vm' });
    expect(hcl).toContain('source  = "vmware/vsphere"');
    expect(hcl).toContain('password             = var.vsphere_password');
    expect(/variable "vsphere_password" \{[^}]*sensitive\s+= true/.test(hcl)).toBe(true);
  });

  it('makes an empty required argument a variable, typed as the argument is', () => {
    const hcl = build('vsphere_compute_cluster_vm_host_rule');
    expect(hcl).toContain('compute_cluster_id = var.compute_cluster_id');
    expect(hcl).toContain('variable "compute_cluster_id" {\n  type        = string');
  });

  it('leaves an optional argument out when it is empty', () => {
    expect(build('vsphere_compute_cluster_vm_host_rule')).not.toContain('mandatory');
    expect(build('vsphere_compute_cluster_vm_host_rule', { 'r.mandatory': 'true' })).toContain('mandatory');
  });

  it('writes a reference unquoted, and wraps one in a list field', () => {
    const hcl = build('nsxt_policy_security_policy', {
      'r.display_name': 'web',
      'r.category': 'Application',
      'b.rule': true,
      'r.rule.display_name': 'https',
      'r.rule.services': 'data.nsxt_policy_service.https.path',
      'r.rule.source_groups': 'nsxt_policy_group.web.path, nsxt_policy_group.lb.path',
    });
    expect(hcl).toContain('services      = [data.nsxt_policy_service.https.path]');
    expect(hcl).toContain('source_groups = [nsxt_policy_group.web.path, nsxt_policy_group.lb.path]');
    expect(hcl).toContain('display_name = "web"');
  });

  it('keeps a variable that is the whole list as it is', () => {
    const hcl = build('nsxt_policy_group', { 'r.display_name': 'g', 'b.criteria': true, 'b.criteria.ipaddress_expression': true, 'r.criteria.ipaddress_expression.ip_addresses': 'var.addresses' });
    expect(hcl).toContain('ip_addresses = var.addresses');
  });

  it('writes a map from key=value lines', () => {
    const hcl = build('vsphere_folder', { 'r.path': 'Prod', 'r.type': 'vm', 'r.custom_attributes': 'owner=team-a\n"cost centre"=42' });
    expect(hcl).toContain('owner = "team-a"');
    expect(hcl).toContain('"cost centre" = "42"');
  });

  it('never names a variable after one of the names Terraform reserves', () => {
    for (const provider of VMWARE_PROVIDERS) {
      for (const blueprint of providerBlueprints(provider)) {
        const hcl = blueprint.build(defaultValues(blueprint), 'test').files['main.tf'] ?? '';
        const reserved = /^variable "(source|version|providers|count|for_each|lifecycle|depends_on|locals)"/m.exec(hcl);
        expect([blueprint.id, reserved?.[1] ?? null]).toEqual([blueprint.id, null]);
      }
    }
  });

  it('applies what the providers check in code: one of a pair, and minimum block counts', () => {
    // vcd_vapp_network takes prefix_length or netmask, and the schema cannot say so.
    expect(build('vcd_vapp_network')).toContain('prefix_length = var.prefix_length');
    // A VCF cluster needs at least two hosts.
    expect(build('vcf_cluster').match(/^  host \{/gm)?.length).toBe(2);
  });
});

describe('terraform/schema-blueprints: the four clouds, a schema file at a time', () => {
  it('lists every resource of AWS, Azure, Google Cloud and OCI from the index', () => {
    for (const [target, provider] of [['aws', 'aws'], ['azure', 'azurerm'], ['google', 'google'], ['oci', 'oci']] as const) {
      const group = TERRAFORM_BLUEPRINTS.find((g) => g.target === target)!;
      const perResource = group.blueprints.filter((b) => b.id.startsWith(`res_${provider}_`));
      expect([target, perResource.length > 900]).toEqual([target, true]);
      expect([target, perResource.every((b) => typeof b.load === 'function')]).toEqual([target, true]);
    }
  });

  it('keeps a lazy blueprint lazy through the passes that copy it', () => {
    // withChoices, the secret lifting and the layout all copy blueprints; a
    // spread would have frozen the form at its unloaded, empty state.
    const ec2 = TERRAFORM_BLUEPRINTS.find((g) => g.target === 'aws')!.blueprints.find((b) => b.id === 'res_aws_instance')!;
    expect(ec2.inputs.some((i) => i.id === 'r.ami')).toBe(true);
    expect(ec2.description).toContain('aws_instance');
    const files = ec2.build({ ...defaultValues(ec2), 'r.ami': 'ami-0123', 'r.instance_type': 't3.small' }, 'web').files;
    expect(files['main.tf']).toContain('resource "aws_instance" "web"');
    expect(files['providers.tf']).toContain('region = "us-east-1"');
  });

  it('writes the azurerm provider with its required features block', () => {
    const rg = resourceBlueprint('azurerm_resource_group', 'res');
    expect(rg.build(defaultValues(rg), 'rg').files['main.tf']).toContain('provider "azurerm" {\n  features {}');
  });

  it('applies a discovered rule, ticking the blocks around a nested stand-in', () => {
    // Exactly one of resource_data's nested blocks is required; the first
    // stands in, and resource_data around it has to be written too.
    const hcl = build('aws_lakeformation_opt_in');
    expect(hcl).toContain('resource_data {');
    expect(hcl).toContain('catalog {');
  });
});

describe('terraform/schema-blueprints: helpers', () => {
  it('tells a reference from a value', () => {
    for (const ref of ['var.x', 'data.vsphere_datacenter.dc.id', 'vsphere_folder.apps.path', 'local.name', 'file("a.pem")', 'null']) {
      expect([ref, isExpression(ref)]).toEqual([ref, true]);
    }
    for (const text of ['Prod', 'vm', '10.0.0.1/24', 'var', 'a.b', 'administrator@vsphere.local']) {
      expect([text, isExpression(text)]).toEqual([text, false]);
    }
  });

  it('escapes a template sequence in a scenario value, so it stays text', () => {
    expect(q('${project.name}-${###}')).toBe('"$${project.name}-$${###}"');
    expect(q('%{if}')).toBe('"%%{if}"');
    expect(q('data.vsphere_datacenter.dc.id')).toBe('data.vsphere_datacenter.dc.id');
  });

  it('writes labels a person would', () => {
    expect(humanize('compute_cluster_vm_host_rule')).toBe('Compute cluster VM host rule');
    expect(humanize('tier1_gateway')).toBe('Tier-1 gateway');
  });
});
