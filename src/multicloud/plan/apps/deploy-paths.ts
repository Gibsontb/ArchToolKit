/**
 * Every output in the form the chosen cloud takes it, through that provider's
 * own deployment path:
 *
 *   AWS      the Terraform root module, applied with the Terraform CLI (or HCP
 *            Terraform); the AWS Transform MGN import and the Cloud Migration
 *            Factory intake come with the execution kit (Migration & Utilities)
 *   Azure    the Terraform root module, applied with the Terraform CLI; the
 *            Azure Migrate hand-off comes with the execution kit
 *   Google   the root module laid out for Infrastructure Manager
 *            (`deploy/google-infra-manager/`: no backend block, since
 *            Infrastructure Manager keeps the state) and the
 *            `gcloud infra-manager deployments apply` command
 *   OCI      a Resource Manager stack .zip (`deploy/oci-resource-manager-stack.zip`:
 *            the root module at the zip root, no backend block, and a
 *            schema.yaml for the variables) and the
 *            `oci resource-manager stack create` command
 *   VCF      the vSphere Terraform, and a VCF Automation cloud template for
 *            the app's VMs (`deploy/vcf-automation/`) to import into VCF
 *            Automation
 *
 * Infrastructure Manager runs Terraform 1.3.10, 1.4.7 and 1.5.7; Resource
 * Manager 1.5.x. A stack that needs a newer Terraform (an import block with
 * for_each, 1.7; a write-only argument, 1.11) is not offered in a form the
 * service cannot run: the README says to apply it with the Terraform CLI.
 *
 * Sources (read 2026-09-26):
 * https://docs.cloud.google.com/sdk/gcloud/reference/infra-manager/deployments/apply
 * https://docs.cloud.google.com/infrastructure-manager/docs/terraform-version-deprecation
 * https://docs.oracle.com/en-us/iaas/Content/ResourceManager/Concepts/terraformconfigresourcemanager.htm
 * https://docs.oracle.com/en-us/iaas/tools/oci-cli/latest/oci_cli_docs/cmdref/resource-manager/stack/create.html
 * https://docs.oracle.com/en-us/iaas/Content/ResourceManager/Reference/terraformversions.htm
 */

import { defaultValues } from '../../../kit/blueprint.ts';
import { VCF_AUTOMATION_AUTOMATIONS } from '../../../automation/blueprints/vcf-automation.ts';
import { PLATFORM_LABELS, slugName } from '../options.ts';
import type { Plan, Platform, TargetDesign } from '../types.ts';

export interface DeployPath {
  readonly platform: Platform;
  /** How the cloud takes the output, in its own words. */
  readonly how: string;
  /** Whether the provider's own path can take this stack; else why not. */
  readonly available: boolean;
  readonly reason?: string;
  /** The README lines. */
  readonly readme: readonly string[];
}

/** How each cloud takes the generated stack, for the page's labels. */
export const DEPLOY_HOW: Readonly<Record<Platform, string>> = {
  aws: 'Apply the Terraform root module with the Terraform CLI (or HCP Terraform) in the target account; the AWS Transform MGN import CSV and the Cloud Migration Factory intake come with the execution kit on Migration & Utilities.',
  azure: 'Apply the Terraform root module with the Terraform CLI (or HCP Terraform) against the subscription; the Azure Migrate hand-off comes with the execution kit on Migration & Utilities.',
  google: 'Deploy with Infrastructure Manager: gcloud infra-manager deployments apply --local-source=deploy/google-infra-manager.',
  oci: 'Import into Resource Manager: Stacks → Create stack → My configuration → .zip file (deploy/oci-resource-manager-stack.zip), or oci resource-manager stack create.',
  vmware: 'Apply the vSphere Terraform with the Terraform CLI; import the VCF Automation cloud template (deploy/vcf-automation/) into VCF Automation: Design → Templates → Import.',
};

/** The newest Terraform a stack needs, from what its files use. */
export function terraformNeeded(files: Readonly<Record<string, string>>): { version: string; why?: string } {
  const tf = Object.entries(files).filter(([f]) => f.endsWith('.tf')).map(([, t]) => t).join('\n');
  if (/\b[a-z0-9_]+_wo\s*=/.test(tf)) return { version: '1.11', why: 'a write-only argument (Terraform 1.11)' };
  if (/\bimport\s*\{[^}]*\bfor_each\b/s.test(tf)) return { version: '1.7', why: 'an import block with for_each (Terraform 1.7)' };
  return { version: '1.5' };
}

/** A root module with the backend block removed (the service keeps the state) and required_version relaxed to what the service runs. */
function forManagedService(files: Readonly<Record<string, string>>, minimum: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [f, t] of Object.entries(files)) {
    if (/(^|\/)(\.terraform|terraform\.tfstate)/.test(f)) continue;
    let text = t;
    if (f.endsWith('versions.tf')) {
      text = text.replace(/\n[ \t]*backend\s+"[^"]*"\s*\{[^{}]*\}\n?/g, '\n').replace(/required_version\s*=\s*"[^"]*"/, `required_version = ">= ${minimum}"`);
    }
    out[f] = text;
  }
  return out;
}

/** The variables of a root module: name, type and description (for schema.yaml). */
export function variablesOf(files: Readonly<Record<string, string>>): { name: string; type: string; description: string; sensitive: boolean; hasDefault: boolean }[] {
  const text = Object.entries(files).filter(([f]) => f.endsWith('.tf')).map(([, t]) => t).join('\n');
  const out: { name: string; type: string; description: string; sensitive: boolean; hasDefault: boolean }[] = [];
  const re = /variable\s+"([^"]+)"\s*\{/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < text.length && depth > 0) {
      if (text[i] === '{') depth += 1;
      else if (text[i] === '}') depth -= 1;
      i += 1;
    }
    const body = text.slice(re.lastIndex, i - 1);
    out.push({
      name: m[1]!,
      type: /\btype\s*=\s*([^\n]+)/.exec(body)?.[1]?.trim() ?? 'string',
      description: /\bdescription\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(body)?.[1] ?? '',
      sensitive: /\bsensitive\s*=\s*true/.test(body),
      hasDefault: /\bdefault\s*=/.test(body),
    });
  }
  return out.filter((v, idx, all) => all.findIndex((x) => x.name === v.name) === idx);
}

const yamlText = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** A Resource Manager schema.yaml for the stack's variables (optional, but it gives the Console a form). */
export function resourceManagerSchema(title: string, files: Readonly<Record<string, string>>): string {
  const vars = variablesOf(files);
  const typeOf = (t: string, sensitive: boolean): string => (sensitive ? 'password' : /^number/.test(t) ? 'number' : /^bool/.test(t) ? 'boolean' : /^(list|set|map|object)/.test(t) ? 'text' : 'string');
  const lines = [
    'schemaVersion: 1.1.0',
    'version: "1.0.0"',
    `title: ${yamlText(title)}`,
    'locale: "en"',
    'variableGroups:',
    '  - title: "Variables"',
    '    variables:',
    ...vars.map((v) => `      - ${v.name}`),
    'variables:',
    ...vars.flatMap((v) => [
      `  ${v.name}:`,
      `    type: ${typeOf(v.type, v.sensitive)}`,
      `    title: ${yamlText(v.name)}`,
      ...(v.description ? [`    description: ${yamlText(v.description)}`] : []),
      `    required: ${v.hasDefault ? 'false' : 'true'}`,
    ]),
  ];
  return `${lines.join('\n')}\n`;
}

/** The VCF Automation cloud template rows for the app's VMs on VCF, from the design. */
function vcfaResources(plan: Plan, design: TargetDesign): string {
  const pd = design.platforms.find((d) => d.platform === 'vmware');
  if (!pd || pd.compute.length === 0) return '';
  const byId = new Map(plan.workloads.map((w) => [w.id, w]));
  const nets = [...new Set(pd.compute.map((c) => `${pd.prefix}-${c.network}-${c.tier}`))];
  const rows: string[] = [];
  for (const n of nets) rows.push(`${slugName(n).replace(/-/g, '_')} | Cloud.vSphere.Network | networkType=existing | `);
  for (const c of pd.compute) {
    const w = byId.get(c.workload);
    const name = slugName(w?.name ?? c.workload).replace(/-/g, '_') || 'vm';
    const image = c.image.kind === 'vsphere-template' ? c.image.template : 'the-os-template';
    const net = slugName(`${pd.prefix}-${c.network}-${c.tier}`).replace(/-/g, '_');
    rows.push(`${name} | Cloud.vSphere.Machine | image=${image}; cpuCount=${c.vcpu}; totalMemoryMB=${Math.round(c.ramGib * 1024)}; networks=${net} | `);
  }
  return rows.join('\n');
}

/**
 * The deployment-path files and README section for a generated stack: `files`
 * are the stack's (under `folder/terraform/<p>/`). Returns the extra files and
 * one entry per platform.
 */
export function deployPaths(plan: Plan, design: TargetDesign, folder: string, files: Readonly<Record<string, string>>, title: string): { files: Record<string, string>; paths: DeployPath[] } {
  const extra: Record<string, string> = {};
  const paths: DeployPath[] = [];
  for (const pd of design.platforms) {
    const p = pd.platform;
    const prefix = `${folder}/terraform/${p}/`;
    const root = Object.fromEntries(Object.entries(files).filter(([f]) => f.startsWith(prefix) && !f.slice(prefix.length).includes('/')).map(([f, t]) => [f.slice(prefix.length), t]));
    if (Object.keys(root).length === 0) continue;
    const need = terraformNeeded(root);
    const name = slugName(title) || 'app';
    if (p === 'google') {
      const ok = need.version === '1.5';
      if (ok) for (const [f, t] of Object.entries(forManagedService(root, '1.5.7'))) extra[`${folder}/deploy/google-infra-manager/${f}`] = t;
      paths.push({
        platform: p, how: DEPLOY_HOW.google, available: ok,
        ...(ok ? {} : { reason: `Infrastructure Manager runs Terraform up to 1.5.7, and this stack uses ${need.why}: apply terraform/google/ with the Terraform CLI instead.` }),
        readme: ok
          ? [
            '### Google Cloud: Infrastructure Manager',
            '',
            '`deploy/google-infra-manager/` is the root module without its backend block (Infrastructure Manager keeps the state) and pinned to a Terraform it runs. Copy `terraform.tfvars.example` to `terraform.tfvars`, fill it in, then:',
            '',
            '```sh',
            `gcloud infra-manager deployments apply projects/PROJECT_ID/locations/${pd.region || 'REGION'}/deployments/${name} \\`,
            '  --service-account=projects/PROJECT_ID/serviceAccounts/SA_NAME@PROJECT_ID.iam.gserviceaccount.com \\',
            '  --local-source=deploy/google-infra-manager \\',
            '  --inputs-file=deploy/google-infra-manager/terraform.tfvars \\',
            '  --tf-version-constraint="=1.5.7"',
            '```',
            '',
            'Sensitive variables go in the inputs file only for a one-off apply; prefer Secret Manager references in the configuration.',
            '',
          ]
          : ['### Google Cloud', '', `Infrastructure Manager runs Terraform up to 1.5.7 and this stack uses ${need.why}, so apply \`terraform/google/\` with the Terraform CLI.`, ''],
      });
    } else if (p === 'oci') {
      const ok = need.version === '1.5';
      if (ok) {
        const managed = forManagedService(root, '1.5.0');
        for (const [f, t] of Object.entries(managed)) extra[`${folder}/deploy/oci-resource-manager-stack.zip/${f}`] = t;
        extra[`${folder}/deploy/oci-resource-manager-stack.zip/schema.yaml`] = resourceManagerSchema(title, managed);
      }
      paths.push({
        platform: p, how: DEPLOY_HOW.oci, available: ok,
        ...(ok ? {} : { reason: `Resource Manager runs Terraform 1.5.x, and this stack uses ${need.why}: apply terraform/oci/ with the Terraform CLI instead.` }),
        readme: ok
          ? [
            '### OCI: Resource Manager',
            '',
            '`deploy/oci-resource-manager-stack.zip` is the stack: the root module at the zip root, without a backend block (Resource Manager keeps the state), and a `schema.yaml` for the variables. In the Console: Resource Manager → Stacks → Create stack → My configuration → .zip file. Or:',
            '',
            '```sh',
            'oci resource-manager stack create \\',
            '  --compartment-id <compartment OCID> \\',
            '  --config-source deploy/oci-resource-manager-stack.zip \\',
            `  --display-name "${title}" \\`,
            '  --terraform-version "1.5.x" \\',
            '  --variables file://variables.json',
            'oci resource-manager job create-apply-job --stack-id <stack OCID> --execution-plan-strategy AUTO_APPROVED',
            '```',
            '',
          ]
          : ['### OCI', '', `Resource Manager runs Terraform 1.5.x and this stack uses ${need.why}, so apply \`terraform/oci/\` with the Terraform CLI.`, ''],
      });
    } else if (p === 'vmware') {
      const rows = vcfaResources(plan, design);
      let ok = false;
      if (rows) {
        const bp = VCF_AUTOMATION_AUTOMATIONS.find((b) => b.id === 'vcfa_cloud_template');
        if (bp) {
          const built = bp.build({ ...defaultValues(bp), template_name: title, resources: rows, template_inputs: '' }, name);
          for (const [f, t] of Object.entries(built.files)) if (typeof t === 'string') extra[`${folder}/deploy/vcf-automation/${f}`] = t;
          ok = true;
        }
      }
      paths.push({
        platform: p, how: DEPLOY_HOW.vmware, available: true,
        readme: [
          '### VMware Cloud Foundation',
          '',
          'Apply `terraform/vmware/` with the Terraform CLI (the vSphere provider signs in to the workload domain\'s vCenter).',
          ...(ok ? ['', '`deploy/vcf-automation/` holds a VCF Automation cloud template for the same VMs: import it in VCF Automation (Design → Templates → Import, or the import script beside it; `IMPORT.md` says how), so the VMs can also be requested from the catalogue.'] : []),
          '',
        ],
      });
    } else {
      paths.push({
        platform: p, how: DEPLOY_HOW[p], available: true,
        readme: [
          `### ${PLATFORM_LABELS[p]}`,
          '',
          `Apply \`terraform/${p}/\` with the Terraform CLI (Terraform ${need.version === '1.5' ? '1.5' : need.version} or later), or HCP Terraform.${p === 'aws' ? ' The AWS Transform MGN import and the Cloud Migration Factory intake form come with the execution kit on Migration & Utilities.' : ' The Azure Migrate hand-off comes with the execution kit on Migration & Utilities.'}`,
          '',
        ],
      });
    }
  }
  return { files: extra, paths };
}
