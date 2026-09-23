import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { renderFile, renderBlock, quote, str, num, bool, strings, raw } from './hcl.ts';
import { PROVIDERS, providerFor } from './providers.ts';
import { scaffold } from './scaffold.ts';
import { emitTerraform, VCF_PROVIDER_MAX_VCF } from './vcf.ts';
import { buildSddcSpec, type DeploymentPlan } from '../vcf/spec-builder.ts';
import { referenceFor, resourceTypesIn } from './reference.ts';
import { mappedTargets } from './maps.ts';
import { TERRAFORM_BLUEPRINTS } from './blueprints/index.ts';
import { defaultValues } from '../kit/blueprint.ts';

function basePlan(overrides: Partial<DeploymentPlan> = {}): DeploymentPlan {
  return {
    sddcId: 'vcf-m01',
    domainSuffix: 'vcf.lab',
    namePrefix: 'vcf-m01',
    esxHostnameBase: 'esx',
    hostCount: 4,
    dnsServers: ['192.168.30.29', '192.168.30.30'],
    ntpServers: ['192.168.30.1'],
    management: { cidr: '172.30.0.0/24', vlanId: 30 },
    vmotion: { cidr: '172.30.40.0/24', vlanId: 40 },
    vsan: { cidr: '172.30.50.0/24', vlanId: 50 },
    hostTep: { cidr: '172.30.60.0/24', vlanId: 60 },
    storage: 'vsan-esa',
    ...overrides,
  };
}

const codes = (findings: readonly { code: string }[]): string[] => findings.map((f) => f.code);

describe('HCL writing', () => {
  it('escapes interpolation so a value is not read as an expression', () => {
    // A password containing ${ is otherwise a plan-time failure at best.
    expect(quote('a${b}c')).toBe('"a$${b}c"');
    expect(quote('100%{x}')).toBe('"100%%{x}"');
  });

  it('escapes quotes and backslashes', () => {
    expect(quote('say "hi"')).toBe('"say \\"hi\\""');
    expect(quote('C:\\path')).toBe('"C:\\\\path"');
  });

  it('renders a block with aligned attributes', () => {
    const out = renderBlock({
      type: 'resource',
      labels: ['a_thing', 'name'],
      attributes: [
        { name: 'id', value: str('x') },
        { name: 'count', value: num(2) },
        { name: 'enabled', value: bool(true) },
      ],
    });
    expect(out).toContain('resource "a_thing" "name" {');
    expect(out).toContain('id      = "x"');
    expect(out).toContain('enabled = true');
  });

  it('renders nested blocks and raw expressions', () => {
    const out = renderBlock({
      type: 'provider',
      labels: ['azurerm'],
      attributes: [{ name: 'subscription_id', value: raw('var.subscription_id') }],
      blocks: [{ type: 'features' }],
    });
    expect(out).toContain('subscription_id = var.subscription_id');
    expect(out).toContain('features {');
  });

  it('keeps short scalar lists on one line', () => {
    const out = renderBlock({
      type: 'x',
      attributes: [{ name: 'l', value: strings(['a', 'b']) }],
    });
    expect(out).toContain('l = ["a", "b"]');
  });

  it('writes a file with a comment header and trailing newline', () => {
    const out = renderFile([{ type: 'x' }], 'hello\nworld');
    expect(out.startsWith('# hello\n# world')).toBe(true);
    expect(out.endsWith('\n')).toBe(true);
  });
});

describe('provider registry', () => {
  it('covers the five clouds plus vSphere', () => {
    expect(PROVIDERS.map((p) => p.target).sort()).toEqual([
      'aws',
      'azure',
      'google',
      'oci',
      'vcf',
      'vsphere',
    ]);
  });

  it('uses real registry source addresses', () => {
    expect(providerFor('aws').source).toBe('hashicorp/aws');
    expect(providerFor('azure').source).toBe('hashicorp/azurerm');
    expect(providerFor('google').source).toBe('hashicorp/google');
    expect(providerFor('oci').source).toBe('oracle/oci');
    expect(providerFor('vsphere').source).toBe('vmware/vsphere');
    expect(providerFor('vcf').source).toBe('vmware/vcf');
  });

  it('pins each constraint to the major line it was observed on', () => {
    for (const p of PROVIDERS) {
      const major = p.observedVersion.split('.')[0];
      expect(p.version.includes(major as string)).toBe(true);
    }
  });

  it('describes credentials rather than generating them', () => {
    for (const p of PROVIDERS) {
      expect(p.credentials.length > 20).toBe(true);
      expect(p.configuration.some((c) => /password|secret|key/i.test(c.name))).toBe(false);
    }
  });
});

describe('multi-cloud scaffold', () => {
  it('generates the spine for several clouds at once', () => {
    const { files } = scaffold({ targets: ['aws', 'azure', 'google', 'oci'], backend: 's3' });
    expect(Object.keys(files).sort()).toEqual([
      '.gitignore',
      'example.tfvars',
      'providers.tf',
      'terraform.tf',
      'variables.tf',
    ]);
    expect(files['terraform.tf']).toContain('hashicorp/aws');
    expect(files['terraform.tf']).toContain('oracle/oci');
    expect(files['terraform.tf']).toContain('backend "s3"');
  });

  it('emits the features block azurerm cannot initialise without', () => {
    const { files } = scaffold({ targets: ['azure'] });
    expect(files['providers.tf']).toContain('features {');
  });

  it('never writes a credential into a file', () => {
    const { files } = scaffold({ targets: ['aws', 'azure', 'google', 'oci', 'vcf', 'vsphere'] });
    const all = Object.values(files).join('\n');
    expect(/password\s*=/.test(all)).toBe(false);
    expect(/secret_key\s*=/.test(all)).toBe(false);
  });

  it('never declares the same variable twice', () => {
    // AWS, Google and OCI all take a region. Declaring `variable "region"`
    // three times is invalid and fails at init, so names are namespaced.
    const { files } = scaffold({ targets: ['aws', 'azure', 'google', 'oci', 'vcf', 'vsphere'] });
    const names = [...(files['variables.tf'] ?? '').matchAll(/variable "([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(names.length).toBe(new Set(names).size);
    expect(names).toContain('aws_region');
    expect(names).toContain('oci_region');
    // The prefix is not doubled where the argument already carries it.
    expect(names).toContain('vsphere_server');
  });

  it('references the namespaced variable from the provider block', () => {
    const { files } = scaffold({ targets: ['aws', 'oci'] });
    expect(files['providers.tf']).toContain('var.aws_region');
    expect(files['providers.tf']).toContain('var.oci_region');
  });

  it('ignores tfvars and state by default', () => {
    const { files } = scaffold({ targets: ['aws'] });
    expect(files['.gitignore']).toContain('*.tfvars');
    expect(files['.gitignore']).toContain('*.tfstate');
  });

  it('warns that local state is not shareable', () => {
    expect(codes(scaffold({ targets: ['aws'], backend: 'local' }).findings)).toContain(
      'terraform.scaffold.local-state',
    );
  });

  it('says plainly that resource bodies are not generated', () => {
    expect(codes(scaffold({ targets: ['aws'] }).findings)).toContain(
      'terraform.scaffold.resources-not-generated',
    );
  });

  it('generates nothing when no cloud is chosen', () => {
    const out = scaffold({ targets: [] });
    expect(Object.keys(out.files)).toEqual([]);
    expect(codes(out.findings)).toContain('terraform.scaffold.no-targets');
  });
});

describe('VCF resource emission', () => {
  it('produces a vcf_instance with the specification\u2019s shape', () => {
    const { spec } = buildSddcSpec(basePlan());
    const { mainTf } = emitTerraform(spec);
    expect(mainTf).toContain('resource "vcf_instance"');
    // Attributes are aligned, so match the pair rather than a fixed spacing.
    expect(/instance_id\s+= "vcf-m01"/.test(mainTf)).toBe(true);
    expect(mainTf).toContain('dns {');
    expect(mainTf).toContain('network {');
    expect(mainTf).toContain('host {');
    expect(mainTf).toContain('vcenter {');
    expect(mainTf).toContain('nsx {');
  });

  it('emits one host block per host', () => {
    const { spec } = buildSddcSpec(basePlan({ hostCount: 5 }));
    const { mainTf } = emitTerraform(spec);
    expect(mainTf.split('host {').length - 1).toBe(5);
  });

  it('puts every credential in a variable, never in the configuration', () => {
    const { spec } = buildSddcSpec(basePlan());
    const { mainTf, variablesTf, requiredVariables } = emitTerraform(spec);
    expect(mainTf).toContain('var.vcenter_root_password');
    expect(mainTf).not.toContain('<REQUIRED>');
    expect(variablesTf).toContain('variable "vcenter_root_password"');
    expect(variablesTf).toContain('sensitive   = true');
    expect(requiredVariables.length > 5).toBe(true);
  });

  it('reports every 9.1 component the provider cannot express', () => {
    // The provider's matrix stops at 9.0, and the components 9.1 added have no
    // blocks. Dropping them silently would be the worst thing this could do.
    const { spec } = buildSddcSpec(basePlan());
    const { findings } = emitTerraform(spec);
    const unsupported = findings.filter((f) => f.code === 'vcf.terraform.unsupported-component');
    expect(unsupported.length > 4).toBe(true);
    const paths = unsupported.map((f) => f.path);
    expect(paths).toContain('vspClusterSpec');
    expect(paths).toContain('licenseServerSpec');
    expect(paths).toContain('vidbSpec');
  });

  it('warns that the target version is beyond the provider', () => {
    const { spec } = buildSddcSpec(basePlan());
    expect(codes(emitTerraform(spec).findings)).toContain('vcf.terraform.version-beyond-provider');
    expect(VCF_PROVIDER_MAX_VCF).toBe('9.0.0');
  });

  it('is quiet about the version when targeting what the provider supports', () => {
    const { spec } = buildSddcSpec(basePlan({ version: '9.0.0' }));
    expect(codes(emitTerraform(spec).findings)).not.toContain(
      'vcf.terraform.version-beyond-provider',
    );
  });

  it('reports storage it cannot model', () => {
    const { spec } = buildSddcSpec(
      basePlan({ storage: 'nfs', nfsServers: ['172.30.70.10'], nfsPath: '/export/vcf' }),
    );
    expect(codes(emitTerraform(spec).findings)).toContain('vcf.terraform.storage-not-expressible');
  });

  it('reports a workflow type vcf_instance cannot represent', () => {
    const { spec } = buildSddcSpec(basePlan({ scenario: 'new-vvf' }));
    expect(codes(emitTerraform(spec).findings)).toContain(
      'vcf.terraform.workflow-type-not-expressible',
    );
  });
});

describe('the Reference panel: the map joined to what was generated', () => {
  it('reads the resource types out of the generated HCL, not out of emits', () => {
    // Most blueprints declare no emits. All of them produce HCL, so the HCL is
    // the thing to read.
    const files = {
      'main.tf': 'resource "aws_vpc" "this" {\n  cidr_block = "10.0.0.0/16"\n}\n\ndata "aws_ami" "latest" {}\n',
      'README.md': 'resource "aws_not_real" "ignored" {}',
    };
    expect(resourceTypesIn(files)).toEqual(['aws_ami', 'aws_vpc']);
  });

  it('finds the map rows that name what was built', () => {
    const files = { 'main.tf': 'resource "aws_vpc" "this" {}\nresource "aws_subnet" "a" {}\n' };
    const reference = referenceFor('aws', files);
    expect(reference).toBeDefined();
    expect(reference!.rows.length > 0).toBe(true);
    // Every row it returns matched on something that was actually generated.
    for (const row of reference!.rows) {
      expect(row.matched.every((name) => reference!.resources.includes(name))).toBe(true);
    }
  });

  it('says which generated resources the map has nothing about', () => {
    const files = { 'main.tf': 'resource "aws_vpc" "this" {}\nresource "aws_quicksight_folder" "q" {}\n' };
    const reference = referenceFor('aws', files);
    expect(reference).toBeDefined();
    expect(reference!.unmapped).toContain('aws_quicksight_folder');
    expect(reference!.unmapped.includes('aws_vpc')).toBe(false);
    // A gap in the map is information, not an error.
    expect(reference!.findings.every((f) => f.severity === 'info')).toBe(true);
  });

  it('returns nothing for a platform that has no map, rather than an empty panel', () => {
    // vSphere and VCF have no map. An empty panel would read as "the map knows
    // nothing about this", when the truth is there is no map to consult.
    expect(referenceFor('vsphere', { 'main.tf': 'resource "vsphere_virtual_machine" "vm" {}' })).toBe(null);
    expect(referenceFor('aws', { 'main.tf': '# nothing here' })).toBe(null);
  });

  it('covers what the real blueprints build, for every platform that has a map', () => {
    // The point of the panel is that it is populated. A platform whose
    // blueprints produce nothing the map mentions has a map worth extending.
    for (const target of mappedTargets()) {
      const group = TERRAFORM_BLUEPRINTS.find((g) => g.target === target);
      if (!group) continue;
      let matched = 0;
      let total = 0;
      for (const blueprint of group.blueprints) {
        const files = blueprint.build(defaultValues(blueprint), 'check').files;
        const reference = referenceFor(target, files);
        if (!reference) continue;
        total += reference.resources.length;
        matched += reference.resources.length - reference.unmapped.length;
      }
      // Not every resource needs a row, but a map that covers none of what the
      // generator builds is not doing its job.
      expect([target, total > 0 && matched > 0]).toEqual([target, true]);
    }
  });
});
