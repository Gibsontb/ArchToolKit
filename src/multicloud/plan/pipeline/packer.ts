/**
 * Golden images (addendum A.10.11): one Packer template per (OS, platform) in
 * use for `rebuild` rows, `images/<os>-<platform>.pkr.hcl`, each with
 *
 *   - its `packer { required_plugins { … } }` block;
 *   - one source: `amazon-ebs`, `azure-arm`, `googlecompute`, `oracle-oci` or
 *     `vsphere-clone`, starting from the same base image the stack's compute
 *     row names (the IMAGE_TABLE reference);
 *   - the `ansible` provisioner running the same `linux_baseline` /
 *     `windows_baseline` roles the site applies: the playbooks under
 *     `images/ansible/` are built by the Ansible kit's `buildSite` from the
 *     same `mig_linux_baseline` / `mig_windows_baseline` blueprints, so the
 *     role files are byte for byte the ones in `ansible/roles/`;
 *   - the platform's generalisation step (cloud-init clean, waagent
 *     deprovision, Sysprep / EC2Launch / GCESysprep);
 *   - a `manifest` post-processor writing `images/manifest.json`, which
 *     ci/scripts/packer.sh turns into `images/<platform>.auto.tfvars.json`:
 *     the value of the stack's `image_<os>` variable (the IMAGE_TABLE `custom`
 *     route, `var:image_<os>` in the compute grid; see `withGoldenImages`).
 *
 * Credentials come from each builder's own chain (the AWS chain, the Azure CLI
 * session, Application Default Credentials, the OCI config file or instance
 * principal); the vCenter account and a template's WinRM password are
 * sensitive variables read from the environment. Nothing is written.
 *
 * IPv6: none of the four hyperscaler builders has an IPv6 setting (checked
 * against the plugins' configuration schemas: amazon 1.8, azure 2.6,
 * googlecompute 1.2, oracle 1.1). The build VM takes the address families of
 * the subnet it is given, so give it the landing zone's dual-stack build
 * subnet (`subnet_id`, `subnet_ocid`, `subnetwork`, `virtual_network_*`); the
 * baseline roles keep IPv6 enabled in the image (firewall rules for both
 * families, IPv6 sysctl hardening). The vSphere builder's IPv6 settings are
 * guest customisation of fixed addresses, which a template does not want.
 *
 * Images are versioned by `image_version` (the pipeline passes the commit),
 * never by the clock, so a template is reproducible.
 */

import { info, warning, type Finding } from '../../../core/findings.ts';
import { findAnsibleBlueprint } from '../../../ansible/blueprints/index.ts';
import { buildSite } from '../../../ansible/site.ts';
import type { BlueprintLookup, StackItem } from '../../../kit/stack.ts';
import { parseImageRef, renderImageRef } from '../../../terraform/blueprints/migration/common.ts';
import { quote } from '../../../terraform/hcl.ts';
import { imageFor, isUnavailable } from '../images.ts';
import { OS_LABELS, OS_VALUES, overrideKey, PLATFORM_LABELS, PLATFORM_VALUES } from '../options.ts';
import { osKind } from '../os.ts';
import type { ImageRef, OsId, Plan, Platform, SecurityBaseline, TargetDesign } from '../types.ts';
import type { PlatformStack } from '../generate/terraform.ts';
import { planSlug } from './environments.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ImageKind = 'linux' | 'windows';

/** One golden image: an OS on a platform. */
export interface GoldenImage {
  readonly os: OsId;
  readonly platform: Platform;
  readonly kind: ImageKind;
  /** The base image the build starts from (the compute row's own reference). */
  readonly base: ImageRef;
  /** `images/<os>-<platform>.pkr.hcl`. */
  readonly file: string;
  /** The Terraform variable the image id fills: `image_<os>`. */
  readonly variable: string;
  /** The compute rows (names) that use it. */
  readonly rows: readonly string[];
}

export interface PackerOptions {
  /** Where the Ansible blueprints are found; `findAnsibleBlueprint` by default. */
  readonly lookup?: BlueprintLookup;
}

/** The Packer plugins, pinned to the minor versions the templates were validated with. */
export const PACKER_PLUGINS = {
  amazon: { source: 'github.com/hashicorp/amazon', version: '~> 1.8' },
  azure: { source: 'github.com/hashicorp/azure', version: '~> 2.6' },
  googlecompute: { source: 'github.com/hashicorp/googlecompute', version: '~> 1.2' },
  oracle: { source: 'github.com/hashicorp/oracle', version: '~> 1.1' },
  vsphere: { source: 'github.com/hashicorp/vsphere', version: '~> 2.5' },
  ansible: { source: 'github.com/hashicorp/ansible', version: '~> 1.1' },
} as const;

/** The builder (source type) per platform. */
export const PACKER_BUILDER: Readonly<Record<Platform, string>> = {
  aws: 'amazon-ebs',
  azure: 'azure-arm',
  google: 'googlecompute',
  oci: 'oracle-oci',
  vmware: 'vsphere-clone',
};
const PLUGIN_OF: Readonly<Record<Platform, keyof typeof PACKER_PLUGINS>> = { aws: 'amazon', azure: 'azure', google: 'googlecompute', oci: 'oracle', vmware: 'vsphere' };

const ident = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
/** The Terraform variable a golden image fills: `image_<os>`. */
export const imageVariable = (os: OsId): string => `image_${ident(os)}`;

// ---------------------------------------------------------------------------
// Which images: the rebuild rows of the stacks
// ---------------------------------------------------------------------------

const cellsOf = (text: unknown): string[][] => String(text ?? '').split('\n').filter((l) => l.trim() !== '').map((l) => l.split(' | ').map((c) => c.trim()));
const isOs = (s: string): s is OsId => (OS_VALUES as readonly string[]).includes(s);

/**
 * The golden images the stacks need: one per (OS, platform) over the compute
 * rows that are rebuilt (the vSphere grid's rows are all rebuilt). An OS with
 * no published base image, or no known kind, is reported and left out.
 */
export function goldenImagesFor(stacks: readonly PlatformStack[]): { images: GoldenImage[]; findings: Finding[] } {
  const findings: Finding[] = [];
  const found = new Map<string, { os: OsId; platform: Platform; base: ImageRef | null; rows: string[] }>();
  for (const stack of stacks) {
    for (const item of stack.items) {
      const vsphere = item.blueprintId === 'vsphere_mig_vms';
      if (!vsphere && !/_mig_compute$/.test(item.blueprintId)) continue;
      for (const r of cellsOf(item.values.vms)) {
        if (!vsphere && r[11] !== 'rebuild') continue;
        const os = r[1] ?? '';
        if (!isOs(os)) continue;
        const key = `${os}|${stack.platform}`;
        const base = vsphere ? (r[2] ? ({ kind: 'vsphere-template', template: r[2] } as ImageRef) : null) : (parseImageRef(r[2] ?? '') as ImageRef | null);
        const entry = found.get(key) ?? { os, platform: stack.platform, base, rows: [] };
        entry.rows.push(r[0] ?? '');
        found.set(key, entry);
      }
    }
  }
  const images: GoldenImage[] = [];
  for (const platform of PLATFORM_VALUES) {
    for (const os of OS_VALUES) {
      const e = found.get(`${os}|${platform}`);
      if (!e) continue;
      const kind = osKind(os);
      if (kind !== 'linux' && kind !== 'windows') {
        findings.push(info('plan.build.image-os-unknown', `${e.rows.join(', ')}: no golden image for OS ${os} (neither Windows nor Linux).`));
        continue;
      }
      if (platform === 'oci' && kind === 'windows') {
        findings.push(warning('plan.build.image-oci-windows', `${OS_LABELS[os]} on OCI: no golden image template; the oracle-oci builder's Windows sign-in (the opc account's initial password over WinRM) is not verified here. Build it from the platform image with the windows_baseline playbook (images/ansible/), or keep the platform image.`, {
          source: 'https://developer.hashicorp.com/packer/integrations/hashicorp/oracle/latest/components/builder/oci',
        }));
        continue;
      }
      let base = e.base;
      // A row already on its golden image (withGoldenImages) is rebuilt from the published base, not from itself.
      if (!base || base.kind === 'replicated' || (base.kind === 'custom' && base.variable === imageVariable(os))) {
        const entry = imageFor(os, platform);
        if (isUnavailable(entry)) {
          findings.push(warning('plan.build.image-no-base', `${OS_LABELS[os]} on ${PLATFORM_LABELS[platform]}: ${entry.unavailable}`));
          continue;
        }
        base = entry;
      }
      images.push({ os, platform, kind, base, file: `images/${os}-${platform}.pkr.hcl`, variable: imageVariable(os), rows: e.rows });
    }
  }
  return { images, findings };
}

/**
 * The stack with its rebuilt rows booting from the golden images: their Image
 * cell becomes `var:image_<os>`, which images/<platform>.auto.tfvars.json fills
 * once the images are built. Replicated rows and other OSes are left alone.
 */
export function withGoldenImages(stack: PlatformStack, images: readonly GoldenImage[]): PlatformStack {
  const mine = new Map(images.filter((i) => i.platform === stack.platform).map((i) => [i.os as string, i]));
  if (mine.size === 0 || stack.platform === 'vmware') return stack;
  const items = stack.items.map((item): StackItem => {
    if (!/_mig_compute$/.test(item.blueprintId)) return item;
    const vms = cellsOf(item.values.vms).map((r) => {
      const g = r[11] === 'rebuild' ? mine.get(r[1] ?? '') : undefined;
      if (!g) return r;
      const out = [...r];
      out[2] = renderImageRef({ kind: 'custom', variable: g.variable });
      return out;
    });
    return { ...item, values: { ...item.values, vms: vms.map((r) => r.join(' | ')).join('\n') } };
  });
  return { ...stack, items };
}

// ---------------------------------------------------------------------------
// A small HCL writer with `packer fmt` layout
// ---------------------------------------------------------------------------

type Entry =
  | { readonly a: string; readonly v: string }
  | { readonly a: string; readonly lines: readonly string[] }
  | { readonly block: string; readonly labels?: readonly string[]; readonly body: readonly Entry[] };

const S = (s: string): string => quote(s);
const A = (a: string, v: string | number | boolean): Entry => ({ a, v: typeof v === 'string' ? v : String(v) });
const Q = (a: string, v: string): Entry => A(a, S(v));
/** A string template: `${...}` stays interpolation. */
const T = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const B = (block: string, labels: readonly string[], body: readonly Entry[]): Entry => ({ block, labels, body });
/** An object value on several lines, keys aligned. */
function O(a: string, o: Readonly<Record<string, string>>): Entry {
  const keys = Object.keys(o).map((k) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : S(k)));
  const w = Math.max(0, ...keys.map((k) => k.length));
  return { a, lines: ['{', ...Object.values(o).map((v, i) => `  ${keys[i]!.padEnd(w)} = ${v}`), '}'] };
}
/** A list of expressions, one per line. */
const L = (a: string, items: readonly string[]): Entry => (items.length <= 2 && items.join(', ').length < 60 ? A(a, `[${items.join(', ')}]`) : { a, lines: ['[', ...items.map((i) => `  ${i},`), ']'] });

function render(body: readonly Entry[], ind: string): string[] {
  const out: string[] = [];
  let group: { a: string; v: string }[] = [];
  const flush = (): void => {
    if (group.length === 0) return;
    const w = Math.max(...group.map((g) => g.a.length));
    for (const g of group) out.push(`${ind}${g.a.padEnd(w)} = ${g.v}`);
    group = [];
  };
  const gap = (): void => {
    if (out.length > 0 && out[out.length - 1] !== '') out.push('');
  };
  for (const e of body) {
    if ('v' in e) {
      if (group.length === 0 && out.length > 0 && out[out.length - 1] !== '' && !out[out.length - 1]!.includes(' = ')) gap();
      group.push(e);
      continue;
    }
    flush();
    gap();
    if ('lines' in e) {
      out.push(`${ind}${e.a} = ${e.lines[0]}`);
      for (const l of e.lines.slice(1)) out.push(`${ind}${l}`);
    } else {
      out.push(`${ind}${e.block}${(e.labels ?? []).map((l) => ` ${S(l)}`).join('')} {`);
      out.push(...render(e.body, `${ind}  `));
      out.push(`${ind}}`);
    }
    out.push('');
  }
  flush();
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

function hclFile(header: readonly string[], body: readonly Entry[]): string {
  const top: string[] = [];
  for (const e of body) {
    if (top.length > 0) top.push('');
    top.push(...render([e], ''));
  }
  return `${header.map((h) => `# ${h}`.trimEnd()).join('\n')}\n\n${top.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// The templates
// ---------------------------------------------------------------------------

const v = (name: string, type: string, description: string, def?: string, sensitive = false): Entry =>
  B('variable', [name], [A('type', type), Q('description', description), ...(def !== undefined ? [A('default', def)] : []), ...(sensitive ? [A('sensitive', true)] : [])]);

/** The user the build connects as, per platform and base image. */
function sshUser(platform: Platform, os: OsId): string {
  if (platform === 'aws') {
    if (os.startsWith('ubuntu')) return 'ubuntu';
    if (os.startsWith('debian')) return 'admin';
    if (os.startsWith('rocky')) return 'rocky';
    if (os.startsWith('centos')) return 'ec2-user';
    return 'ec2-user';
  }
  if (platform === 'oci') return os.startsWith('ubuntu') ? 'ubuntu' : 'opc';
  if (platform === 'google') return 'packer';
  return 'packer';
}

const WINDOWS_USER: Readonly<Record<Platform, string>> = { aws: 'Administrator', azure: 'packer', google: 'packer_user', oci: 'opc', vmware: '' };

interface Ctx {
  readonly plan: string;
  readonly prefix: string;
  readonly region: string;
  readonly design: TargetDesign;
  readonly overrides: Readonly<Record<string, string>>;
}

/** The template's variables: the platform's placement, the naming, the version. */
function variablesFor(img: GoldenImage, ctx: Ctx): Entry[] {
  const common = [
    v('image_version', 'string', 'The image version: the pipeline passes the commit (never a timestamp).', S('0')),
    v('name_prefix', 'string', 'Prefix of the image name.', S(ctx.prefix)),
    v('plan', 'string', 'The plan the image belongs to (the atk_plan tag).', S(ctx.plan)),
  ];
  const windows = img.kind === 'windows';
  switch (img.platform) {
    case 'aws':
      return [
        ...common,
        v('region', 'string', 'The region the AMI is built in.', S(ctx.region)),
        v('instance_type', 'string', 'The build instance type.', S(windows ? 'm7i.xlarge' : 'm7i.large')),
        v('subnet_id', 'string', 'The build subnet: the landing zone\'s dual-stack build subnet; blank uses the default VPC.', S('')),
        v('ssh_interface', 'string', 'How Packer reaches the build instance: public_ip, or private_ip from a runner inside the VPC.', S('public_ip')),
        ...(img.base.kind === 'custom' ? [v(`base_${img.base.variable}`, 'string', 'The imported base AMI id.')] : []),
      ];
    case 'azure':
      return [
        ...common,
        v('location', 'string', 'The region the managed image is built in.', S(ctx.region)),
        v('image_resource_group', 'string', 'The resource group the managed image is written to (it must exist).', S(`${ctx.prefix}-images`)),
        v('vm_size', 'string', 'The build VM size.', S(windows ? 'Standard_D4s_v5' : 'Standard_D2s_v5')),
        v('virtual_network_name', 'string', 'The build network: the landing zone\'s dual-stack build VNet; blank creates a temporary one.', S('')),
        v('virtual_network_subnet_name', 'string', 'Its subnet.', S('')),
        v('virtual_network_resource_group_name', 'string', 'Its resource group.', S('')),
      ];
    case 'google':
      return [
        ...common,
        v('project_id', 'string', 'The project the image is built in.', S('')),
        v('zone', 'string', 'The build zone.', S(ctx.region ? `${ctx.region}-a` : '')),
        v('machine_type', 'string', 'The build machine type.', S(windows ? 'n2-standard-4' : 'n2-standard-2')),
        v('subnetwork', 'string', 'The build subnetwork: the landing zone\'s dual-stack build subnet; blank uses the default network.', S('')),
      ];
    case 'oci':
      return [
        ...common,
        v('region', 'string', 'The region the image is built in.', S(ctx.region)),
        v('compartment_ocid', 'string', 'The compartment the image is built in.', S('')),
        v('availability_domain', 'string', 'The build availability domain (e.g. Uocm:US-ASHBURN-AD-1).', S('')),
        v('subnet_ocid', 'string', 'The build subnet: the landing zone\'s dual-stack build subnet.', S('')),
        v('shape', 'string', 'The build shape.', S('VM.Standard.E5.Flex')),
        v('use_instance_principals', 'bool', 'Sign in with instance principal (a runner in OCI) instead of the OCI config file.', 'false'),
        ...(img.base.kind === 'custom' ? [v(`base_${img.base.variable}`, 'string', 'The imported base image OCID.')] : []),
      ];
    case 'vmware': {
      const o = (f: string): string => ctx.overrides[overrideKey('vmware', 'lz', f)]?.trim() ?? '';
      return [
        ...common,
        v('vcenter_server', 'string', 'The vCenter FQDN.', S(ctx.region)),
        v('vsphere_username', 'string', 'The vCenter account (from the environment).', 'env("VSPHERE_USER")', true),
        v('vsphere_password', 'string', 'Its password (from the environment).', 'env("VSPHERE_PASSWORD")', true),
        v('datacenter', 'string', 'The datacenter.', S(o('datacenter'))),
        v('cluster', 'string', 'The cluster.', S(o('cluster'))),
        v('datastore', 'string', 'The datastore.', S(o('datastore'))),
        v('folder', 'string', 'The VM folder the template goes in.', S(o('folder') || 'templates')),
        ...(windows
          ? [
            v('winrm_username', 'string', 'The template\'s local administrator.', S('Administrator')),
            v('winrm_password', 'string', 'Its password (from the environment).', 'env("TEMPLATE_WINRM_PASSWORD")', true),
          ]
          : [
            v('ssh_username', 'string', 'The template\'s ansible user.', S('ansible')),
            v('ssh_private_key_file', 'string', 'The path of its private key on the build runner (not the key itself).', S('~/.ssh/id_ansible')),
          ]),
      ];
    }
    default:
      return common;
  }
}

const imageName = (img: GoldenImage): string => `\${var.name_prefix}-${img.os.replace(/[^a-z0-9-]+/g, '-')}-\${var.image_version}`;

function tags(img: GoldenImage): Readonly<Record<string, string>> {
  return { atk_plan: 'var.plan', atk_os: S(img.os), atk_image: S('golden'), atk_image_version: 'var.image_version' };
}

function winrm(user: string, extra: readonly Entry[] = []): Entry[] {
  return [Q('communicator', 'winrm'), Q('winrm_username', user), A('winrm_use_ssl', true), A('winrm_insecure', true), A('winrm_use_ntlm', true), Q('winrm_timeout', '30m'), ...extra];
}

/** The source block. */
function source(img: GoldenImage, name: string): { data: Entry[]; source: Entry } {
  const windows = img.kind === 'windows';
  const base = img.base;
  switch (img.platform) {
    case 'aws': {
      const data: Entry[] = [];
      const from: Entry[] = [];
      if (base.kind === 'aws-ssm') {
        data.push(B('data', ['amazon-parameterstore', 'base'], [Q('name', base.parameter), A('region', 'var.region')]));
        from.push(A('source_ami', 'data.amazon-parameterstore.base.value'));
      } else if (base.kind === 'aws-ami-filter') {
        from.push(B('source_ami_filter', [], [
          O('filters', { name: S(base.namePattern), architecture: S('x86_64'), 'virtualization-type': S('hvm'), 'root-device-type': S('ebs') }),
          L('owners', [S(base.owner)]),
          A('most_recent', true),
        ]));
      } else if (base.kind === 'custom') {
        from.push(A('source_ami', `var.base_${base.variable}`));
      }
      return {
        data,
        source: B('source', ['amazon-ebs', name], [
          A('region', 'var.region'),
          A('instance_type', 'var.instance_type'),
          A('subnet_id', 'var.subnet_id'),
          A('associate_public_ip_address', 'var.ssh_interface == "public_ip"'),
          A('temporary_security_group_source_public_ip', 'var.ssh_interface == "public_ip"'),
          A('ami_name', T(imageName(img))),
          Q('ami_description', `${OS_LABELS[img.os]} golden image (baseline roles applied)`),
          A('encrypt_boot', true),
          A('ena_support', true),
          Q('imds_support', 'v2.0'),
          ...from.filter((e) => 'v' in e),
          ...(windows
            ? [...winrm(WINDOWS_USER.aws), A('user_data', '"<powershell>\\n${file("${abspath(path.root)}/files/winrm-bootstrap.ps1")}\\n</powershell>"')]
            : [Q('communicator', 'ssh'), Q('ssh_username', sshUser('aws', img.os)), A('ssh_interface', 'var.ssh_interface')]),
          ...from.filter((e) => !('v' in e)),
          B('metadata_options', [], [Q('http_endpoint', 'enabled'), Q('http_tokens', 'required'), A('http_put_response_hop_limit', 1)]),
          O('tags', tags(img)),
          O('run_tags', { atk_plan: 'var.plan', atk_role: S('image-build') }),
        ]),
      };
    }
    case 'azure': {
      const mk = base.kind === 'azure-marketplace' ? base : null;
      return {
        data: [],
        source: B('source', ['azure-arm', name], [
          A('use_azure_cli_auth', true),
          A('location', 'var.location'),
          A('vm_size', 'var.vm_size'),
          Q('os_type', windows ? 'Windows' : 'Linux'),
          ...(mk ? [Q('image_publisher', mk.publisher), Q('image_offer', mk.offer), Q('image_sku', mk.sku), Q('image_version', 'latest')] : []),
          A('managed_image_name', T(imageName(img))),
          A('managed_image_resource_group_name', 'var.image_resource_group'),
          A('virtual_network_name', 'var.virtual_network_name'),
          A('virtual_network_subnet_name', 'var.virtual_network_subnet_name'),
          A('virtual_network_resource_group_name', 'var.virtual_network_resource_group_name'),
          ...(windows ? winrm(WINDOWS_USER.azure) : [Q('communicator', 'ssh')]),
          ...(mk?.plan ? [B('plan_info', [], [Q('plan_name', mk.sku), Q('plan_product', mk.offer), Q('plan_publisher', mk.publisher)])] : []),
          O('azure_tags', tags(img)),
        ]),
      };
    }
    case 'google': {
      const fam = base.kind === 'gcp-family' ? base : null;
      return {
        data: [],
        source: B('source', ['googlecompute', name], [
          A('project_id', 'var.project_id'),
          A('zone', 'var.zone'),
          A('machine_type', 'var.machine_type'),
          A('subnetwork', 'var.subnetwork'),
          ...(fam ? [Q('source_image_family', fam.family), L('source_image_project_id', [S(fam.project)])] : []),
          A('image_name', T(imageName(img))),
          A('image_family', T(`\${var.name_prefix}-${img.os.replace(/[^a-z0-9-]+/g, '-')}`)),
          Q('image_description', `${OS_LABELS[img.os]} golden image (baseline roles applied)`),
          A('disk_size', windows ? 64 : 32),
          Q('disk_type', 'pd-balanced'),
          A('enable_secure_boot', true),
          A('enable_vtpm', true),
          A('enable_integrity_monitoring', true),
          ...(windows ? winrm(WINDOWS_USER.google) : [Q('communicator', 'ssh'), Q('ssh_username', sshUser('google', img.os))]),
          ...(windows ? [O('metadata', { 'windows-startup-script-ps1': 'file("${abspath(path.root)}/files/winrm-bootstrap.ps1")' })] : []),
          O('image_labels', { atk_plan: 'var.plan', atk_os: S(img.os.replace(/[^a-z0-9-]+/g, '-')), atk_image: S('golden') }),
        ]),
      };
    }
    case 'oci': {
      const platform = base.kind === 'oci-platform' ? base : null;
      return {
        data: [],
        source: B('source', ['oracle-oci', name], [
          A('region', 'var.region'),
          A('use_instance_principals', 'var.use_instance_principals'),
          A('compartment_ocid', 'var.compartment_ocid'),
          A('availability_domain', 'var.availability_domain'),
          A('subnet_ocid', 'var.subnet_ocid'),
          A('shape', 'var.shape'),
          ...(base.kind === 'custom' ? [A('base_image_ocid', `var.base_${base.variable}`)] : []),
          A('image_name', T(imageName(img))),
          Q('ssh_username', sshUser('oci', img.os)),
          A('instance_options_are_legacy_imds_endpoints_disabled', true),
          B('shape_config', [], [A('ocpus', 2), A('memory_in_gbs', 16)]),
          ...(platform ? [B('base_image_filter', [], [Q('operating_system', platform.operatingSystem), Q('operating_system_version', platform.version)])] : []),
          O('tags', tags(img)),
        ]),
      };
    }
    case 'vmware': {
      const template = base.kind === 'vsphere-template' ? base.template : `${img.os}-template`;
      return {
        data: [],
        source: B('source', ['vsphere-clone', name], [
          A('vcenter_server', 'var.vcenter_server'),
          A('username', 'var.vsphere_username'),
          A('password', 'var.vsphere_password'),
          A('insecure_connection', false),
          A('datacenter', 'var.datacenter'),
          A('cluster', 'var.cluster'),
          A('datastore', 'var.datastore'),
          A('folder', 'var.folder'),
          Q('template', template),
          A('vm_name', T(imageName(img))),
          A('convert_to_template', true),
          ...(windows
            ? winrm('${var.winrm_username}').map((e) => ('a' in e && e.a === 'winrm_username' ? A('winrm_username', 'var.winrm_username') : e)).concat([A('winrm_password', 'var.winrm_password')])
            : [Q('communicator', 'ssh'), A('ssh_username', 'var.ssh_username'), A('ssh_private_key_file', 'var.ssh_private_key_file')]),
        ]),
      };
    }
    default:
      return { data: [], source: B('source', ['null', name], [Q('communicator', 'none')]) };
  }
}

/** The ansible provisioner: the baseline playbook from images/ansible/, the same roles as the site. */
function ansible(img: GoldenImage): Entry {
  const windows = img.kind === 'windows';
  const user = img.platform === 'vmware' ? (windows ? 'var.winrm_username' : 'var.ssh_username') : S(windows ? WINDOWS_USER[img.platform] : sshUser(img.platform, img.os));
  const extra = [
    S('--extra-vars'), S(`mig_cloud_platform=${img.platform}`),
    ...(windows ? [S('--extra-vars'), S('ansible_connection=winrm ansible_winrm_transport=ntlm ansible_winrm_server_cert_validation=ignore ansible_shell_type=powershell')] : []),
  ];
  return B('provisioner', ['ansible'], [
    A('playbook_file', T(`\${path.root}/ansible/playbooks/${windows ? PLAYBOOK.windows : PLAYBOOK.linux}`)),
    A('galaxy_file', T('${path.root}/ansible/requirements.yml')),
    A('roles_path', T('${path.root}/ansible/galaxy_roles')),
    A('user', user),
    A('use_proxy', false),
    L('ansible_env_vars', [
      T('ANSIBLE_ROLES_PATH=${path.root}/ansible/roles:${path.root}/ansible/galaxy_roles'),
      S('ANSIBLE_HOST_KEY_CHECKING=False'),
      S('ANSIBLE_FORCE_COLOR=1'),
    ]),
    L('extra_arguments', extra),
  ]);
}

/** The generalisation step each platform documents, last before the image is taken. */
function generalise(img: GoldenImage): Entry | null {
  if (img.kind === 'linux') {
    if (img.platform === 'azure') {
      return B('provisioner', ['shell'], [
        Q('execute_command', "chmod +x {{ .Path }}; {{ .Vars }} sudo -E sh '{{ .Path }}'"),
        Q('inline_shebang', '/bin/sh -x'),
        L('inline', [S('/usr/sbin/waagent -force -deprovision+user && export HISTSIZE=0 && sync')]),
      ]);
    }
    return B('provisioner', ['shell'], [
      L('inline', [
        S('if command -v cloud-init >/dev/null 2>&1; then sudo cloud-init clean --logs; fi'),
        S('sudo rm -f /etc/ssh/ssh_host_*'),
        S('sudo truncate -s 0 /etc/machine-id'),
      ]),
    ]);
  }
  switch (img.platform) {
    case 'aws':
      // EC2Launch v2 (Windows Server 2022 and later AMIs); verify for 2016 / 2019 AMIs that still ship EC2Launch v1.
      return B('provisioner', ['powershell'], [
        L('inline', [
          S("& 'C:/Program Files/Amazon/EC2Launch/ec2launch.exe' reset --block"),
          S("& 'C:/Program Files/Amazon/EC2Launch/ec2launch.exe' sysprep --shutdown --block"),
        ]),
      ]);
    case 'azure':
      return B('provisioner', ['powershell'], [
        L('inline', [
          S("while ((Get-Service RdAgent).Status -ne 'Running') { Start-Sleep -s 5 }"),
          S("while ((Get-Service WindowsAzureGuestAgent).Status -ne 'Running') { Start-Sleep -s 5 }"),
          S('& $env:SystemRoot\\System32\\Sysprep\\Sysprep.exe /oobe /generalize /quiet /quit /mode:vm'),
          S("while ($true) { $s = (Get-ItemProperty HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Setup\\State).ImageState; if ($s -ne 'IMAGE_STATE_GENERALIZE_RESEAL_TO_OOBE') { Start-Sleep -s 10 } else { break } }"),
        ]),
      ]);
    case 'google':
      return B('provisioner', ['powershell'], [L('inline', [S('GCESysprep -no_shutdown')])]);
    default:
      // vSphere: the template stays specialised; guest customisation runs Sysprep when Terraform clones it.
      return null;
  }
}

const PLAYBOOK = { linux: '10-linux-baseline.yml', windows: '11-windows-baseline.yml' } as const;

/** One image's template. */
export function packerTemplate(img: GoldenImage, ctx: Ctx): string {
  const name = ident(img.os);
  const plugin = PLUGIN_OF[img.platform];
  const { data, source: src } = source(img, name);
  const gen = generalise(img);
  const body: Entry[] = [
    B('packer', [], [
      Q('required_version', '>= 1.11.0'),
      B('required_plugins', [], [
        O(plugin, { source: S(PACKER_PLUGINS[plugin].source), version: S(PACKER_PLUGINS[plugin].version) }),
        O('ansible', { source: S(PACKER_PLUGINS.ansible.source), version: S(PACKER_PLUGINS.ansible.version) }),
      ]),
    ]),
    ...variablesFor(img, ctx),
    ...data,
    src,
    B('build', [], [
      Q('name', `${img.os}-${img.platform}`),
      L('sources', [S(`source.${PACKER_BUILDER[img.platform]}.${name}`)]),
      ansible(img),
      ...(gen ? [gen] : []),
      B('post-processor', ['manifest'], [
        A('output', T('${path.root}/manifest.json')),
        A('strip_path', true),
        O('custom_data', { os: S(img.os), platform: S(img.platform), variable: S(img.variable) }),
      ]),
    ]),
  ];
  return hclFile([
    `${OS_LABELS[img.os]} golden image on ${PLATFORM_LABELS[img.platform]}: the ${img.kind}_baseline role, as the site applies it.`,
    `Rows: ${img.rows.join(', ')}.`,
    'packer init . && packer build -var-file=<platform>.pkrvars.hcl <this file>   (it builds; credentials come from the builder\'s own chain)',
  ], body);
}

// ---------------------------------------------------------------------------
// The baseline playbooks, from the site's own blueprints
// ---------------------------------------------------------------------------

const HARDENING: Readonly<Record<SecurityBaseline, string>> = { 'cis-l1': 'cis-l1', 'cis-l2': 'cis-l2', stig: 'stig', internal: 'none' };

/**
 * `images/ansible/`: the linux / windows baseline playbooks, their roles and
 * requirements.yml, built by the Ansible kit from the same blueprints and
 * answers the site uses (with the image's differences: no domain join, no
 * host-specific names).
 */
export function imageAnsibleFiles(plan: Plan, kinds: ReadonlySet<ImageKind>, lookup: BlueprintLookup = findAnsibleBlueprint): { files: Record<string, string>; findings: Finding[] } {
  const hardening = HARDENING[plan.requirements.securityBaseline] ?? 'none';
  const items: StackItem[] = [];
  if (kinds.has('linux')) {
    items.push({ id: 'img:10:linux-baseline', blueprintId: 'mig_linux_baseline', label: 'Linux baseline', values: {
      hosts: 'all', platform: 'aws', timezone: 'UTC', hardening, licence: 'li', update_packages: 'true', reboot: 'true', selinux: 'true', allowed_tcp_ports: '22',
    } });
  }
  if (kinds.has('windows')) {
    items.push({ id: 'img:11:windows-baseline', blueprintId: 'mig_windows_baseline', label: 'Windows baseline', values: {
      hosts: 'all', platform: 'aws', timezone: 'UTC', hardening, licence: 'li', domain_join: 'false', update: 'true', allowed_tcp_ports: '5986',
    } });
  }
  if (items.length === 0) return { files: {}, findings: [] };
  const built = buildSite(items, lookup, {
    stackName: 'Golden image baseline',
    playbookDir: 'playbooks',
    playbookNumber: (item) => Number(/^img:(\d\d):/.exec(item.id)?.[1] ?? 1),
    inventory: 'skeleton',
  });
  const files: Record<string, string> = {};
  for (const [path, text] of Object.entries(built.files)) {
    if (path === 'README.md' || path === 'inventory/hosts.yml' || path === 'site.yml') continue;
    files[`images/ansible/${path}`] = text;
  }
  const findings = built.findings.filter((f) => f.code !== 'ansible.site.empty').map((f) => ({ ...f, path: `images/ansible/${f.path ?? ''}` }));
  return { files, findings };
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

const WINRM_BOOTSTRAP = `# WinRM over HTTPS for the Packer build (and Ansible): a self-signed listener on
# 5986, NTLM only (Basic and unencrypted traffic off). No credential is set here.
$ErrorActionPreference = 'Stop'
$name = $env:COMPUTERNAME
$cert = New-SelfSignedCertificate -DnsName $name -CertStoreLocation Cert:\\LocalMachine\\My -KeyLength 2048
Get-ChildItem WSMan:\\localhost\\Listener | Where-Object { $_.Keys -contains 'Transport=HTTPS' } | Remove-Item -Recurse -Force
New-Item -Path WSMan:\\localhost\\Listener -Transport HTTPS -Address * -CertificateThumbPrint $cert.Thumbprint -Force | Out-Null
Set-Item -Path WSMan:\\localhost\\Service\\Auth\\Basic -Value $false
Set-Item -Path WSMan:\\localhost\\Service\\AllowUnencrypted -Value $false
Set-Service -Name WinRM -StartupType Automatic
Restart-Service -Name WinRM
New-NetFirewallRule -DisplayName 'WinRM over HTTPS (image build)' -Direction Inbound -Protocol TCP -LocalPort 5986 -Action Allow -Profile Any | Out-Null
`;

function pkrvars(platform: Platform, ctx: Ctx, images: readonly GoldenImage[]): string {
  const lines: string[] = [`# ${PLATFORM_LABELS[platform]} build settings for every template in images/ on this platform.`, '# Placement only: credentials come from the builder\'s own chain.'];
  const set = (k: string, value: string): void => {
    lines.push(`${k} = ${S(value)}`);
  };
  const o = (f: string): string => ctx.overrides[overrideKey('vmware', 'lz', f)]?.trim() ?? '';
  const pairs: [string, string][] = [];
  switch (platform) {
    case 'aws': pairs.push(['region', ctx.region], ['subnet_id', '']); break;
    case 'azure': pairs.push(['location', ctx.region], ['image_resource_group', `${ctx.prefix}-images`]); break;
    case 'google': pairs.push(['project_id', ''], ['zone', ctx.region ? `${ctx.region}-a` : '']); break;
    case 'oci': pairs.push(['region', ctx.region], ['compartment_ocid', ''], ['availability_domain', ''], ['subnet_ocid', '']); break;
    case 'vmware': pairs.push(['vcenter_server', ctx.region], ['datacenter', o('datacenter')], ['cluster', o('cluster')], ['datastore', o('datastore')]); break;
    default: break;
  }
  const w = Math.max(...pairs.map(([k]) => k.length));
  for (const [k, val] of pairs) set(k.padEnd(w), val);
  const custom = images.filter((i) => i.platform === platform && i.base.kind === 'custom');
  for (const i of custom) lines.push(`# base_${(i.base as { variable: string }).variable} = ""   # the imported base image`);
  return `${lines.join('\n')}\n`;
}

function readme(images: readonly GoldenImage[]): string {
  return [
    '# Golden images',
    '',
    'One Packer template per OS and platform the plan rebuilds. Each starts from the base image the stack would boot, applies the same `linux_baseline` / `windows_baseline` role the Ansible site applies (the playbooks and roles in `ansible/` here are built from the same blueprints), generalises the machine, and records the image id in `manifest.json`.',
    '',
    '| Template | Base image | Rows |',
    '|---|---|---|',
    ...images.map((i) => `| \`${i.file.replace(/^images\//, '')}\` | \`${renderImageRef(i.base as never) || i.base.kind}\` | ${i.rows.join(', ')} |`),
    '',
    '## Build',
    '',
    '```sh',
    'bash ci/scripts/packer.sh validate <platform>',
    'bash ci/scripts/packer.sh build <platform>     # writes images/<platform>.auto.tfvars.json',
    '```',
    '',
    'The build needs Ansible on the machine running Packer (`pip install ansible-core pywinrm`). Fill in `<platform>.pkrvars.hcl` first: give the build the landing zone\'s dual-stack build subnet, so the image is built and tested with IPv4 and IPv6.',
    '',
    'The stacks read the image ids from `images/<platform>.auto.tfvars.json` (their `image_<os>` variables) once the rebuilt rows are switched to the golden images. Commit the file to promote new images through the environments.',
    '',
  ].join('\n');
}

/**
 * Everything under `images/`: the templates, the per-platform `.pkrvars.hcl`,
 * the baseline playbooks and roles, the WinRM bootstrap, and the README.
 */
export function packerFiles(
  plan: Plan,
  design: TargetDesign,
  stacks: readonly PlatformStack[],
  options: PackerOptions = {},
): { files: Record<string, string>; findings: Finding[]; images: GoldenImage[] } {
  const { images, findings } = goldenImagesFor(stacks);
  const files: Record<string, string> = {};
  if (images.length === 0) return { files, findings, images };
  for (const img of images) {
    const pd = design.platforms.find((p) => p.platform === img.platform);
    const ctx: Ctx = {
      plan: planSlug(plan.id),
      prefix: (pd?.prefix?.trim() || planSlug(plan.id)).toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
      region: pd?.region?.trim() || plan.requirements.regions[img.platform]?.primary?.trim() || '',
      design,
      overrides: plan.designOverrides,
    };
    files[img.file] = packerTemplate(img, ctx);
    if (!files[`images/${img.platform}.pkrvars.hcl`]) files[`images/${img.platform}.pkrvars.hcl`] = pkrvars(img.platform, ctx, images);
  }
  const ansibleOut = imageAnsibleFiles(plan, new Set(images.map((i) => i.kind)), options.lookup);
  Object.assign(files, ansibleOut.files);
  findings.push(...ansibleOut.findings);
  if (images.some((i) => i.kind === 'windows' && i.platform !== 'azure' && i.platform !== 'vmware')) files['images/files/winrm-bootstrap.ps1'] = WINRM_BOOTSTRAP;
  files['images/README.md'] = readme(images);
  findings.push(info('plan.build.image-ipv6', 'The Packer builders have no IPv6 setting: the build VM takes the address families of its subnet, so give each platform\'s build the landing zone\'s dual-stack subnet in images/<platform>.pkrvars.hcl.'));
  return { files, findings, images };
}
