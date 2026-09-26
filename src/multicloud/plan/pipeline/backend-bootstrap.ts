/**
 * State per environment (addendum A.10.11): `backend-bootstrap/<p>/` is a
 * small Terraform root module that creates the state store the platform's
 * stacks keep their state in, once, before anything else is applied:
 *
 *   AWS           S3 with versioning, a KMS key, a public-access block, TLS
 *                 only, and S3 native locking (`use_lockfile = true`,
 *                 Terraform 1.10 or later; no DynamoDB table);
 *   Azure         a storage account (Entra ID only: shared keys off) and a
 *                 `tfstate` container; locking is the blob lease;
 *   Google Cloud  a GCS bucket with versioning, uniform access and public
 *                 access prevention; GCS locks natively;
 *   OCI           an Object Storage bucket, versioned and private, for the
 *                 native `oci` backend (Terraform 1.12 or later).
 *
 * Every stack keeps its state at `<plan>/<platform>/<env>/<stack>.tfstate`
 * in that store; the pipeline passes the store and the key with
 * `-backend-config` (ci/scripts/terraform.sh), from CI variables, so nothing
 * account-specific is written into the stacks.
 *
 * The bootstrap itself starts on local state (the store does not exist yet);
 * its README shows how to move that state into the store it created.
 *
 * Nothing here holds a credential: each provider signs in from its own
 * environment chain, and the storage account refuses shared keys.
 */

import { info, warning, type Finding } from '../../../core/findings.ts';
import { bool, num, raw, renderFile, str, strings, type HclAttribute, type HclBlock, type HclValue } from '../../../terraform/hcl.ts';
import type { BackendKind } from '../../../terraform/scaffold.ts';
import { PLATFORM_LABELS, PLATFORM_VALUES } from '../options.ts';
import type { Plan, Platform, TargetDesign } from '../types.ts';
import { planSlug, stateKey, type DeployStack } from './environments.ts';

// ---------------------------------------------------------------------------
// The CI variables each backend reads
// ---------------------------------------------------------------------------

export interface CiVariable {
  readonly name: string;
  /** A secret (masked, encrypted); otherwise a plain variable. */
  readonly secret: boolean;
  readonly description: string;
}

/**
 * What `ci/scripts/terraform.sh` reads to point a stack at its store. The
 * values are the bootstrap's outputs (`terraform output ci_variables`).
 * None is a secret.
 */
export const STATE_VARIABLES: Readonly<Record<Exclude<BackendKind, 'none' | 'local'>, readonly CiVariable[]>> = {
  s3: [
    { name: 'TF_STATE_BUCKET_AWS', secret: false, description: 'The S3 state bucket (bootstrap output bucket).' },
    { name: 'TF_STATE_KMS_KEY_AWS', secret: false, description: 'The state KMS key ARN (bootstrap output kms_key_arn).' },
    { name: 'AWS_REGION', secret: false, description: 'The region of the state bucket and the stacks.' },
  ],
  azurerm: [
    { name: 'TF_STATE_RESOURCE_GROUP_AZURE', secret: false, description: 'The state resource group (bootstrap output resource_group_name).' },
    { name: 'TF_STATE_ACCOUNT_AZURE', secret: false, description: 'The state storage account (bootstrap output storage_account_name).' },
  ],
  gcs: [{ name: 'TF_STATE_BUCKET_GCP', secret: false, description: 'The GCS state bucket (bootstrap output bucket).' }],
  oci: [
    { name: 'TF_STATE_BUCKET_OCI', secret: false, description: 'The Object Storage state bucket (bootstrap output bucket).' },
    { name: 'TF_STATE_NAMESPACE_OCI', secret: false, description: 'The Object Storage namespace (bootstrap output namespace).' },
    { name: 'OCI_REGION', secret: false, description: 'The region of the state bucket and the stacks.' },
  ],
};

/**
 * The `-backend-config` pairs for a stack, with CI variable references made
 * by `ref` (`${TF_STATE_BUCKET_AWS}` in a shell script). The key is literal.
 */
export function backendConfig(stack: DeployStack, planId: string, ref: (name: string) => string): Record<string, string> {
  const key = stateKey(planId, stack);
  switch (stack.backend) {
    case 's3':
      return {
        bucket: ref('TF_STATE_BUCKET_AWS'),
        key,
        region: ref('AWS_REGION'),
        encrypt: 'true',
        kms_key_id: ref('TF_STATE_KMS_KEY_AWS'),
        use_lockfile: 'true',
        use_dualstack_endpoint: 'true',
      };
    case 'azurerm':
      return {
        resource_group_name: ref('TF_STATE_RESOURCE_GROUP_AZURE'),
        storage_account_name: ref('TF_STATE_ACCOUNT_AZURE'),
        container_name: 'tfstate',
        key,
        use_azuread_auth: 'true',
      };
    case 'gcs':
      return { bucket: ref('TF_STATE_BUCKET_GCP'), prefix: key.replace(/\.tfstate$/, '') };
    case 'oci':
      return { bucket: ref('TF_STATE_BUCKET_OCI'), namespace: ref('TF_STATE_NAMESPACE_OCI'), key, region: ref('OCI_REGION') };
    default:
      return {};
  }
}

// ---------------------------------------------------------------------------
// HCL helpers
// ---------------------------------------------------------------------------

type V = HclValue | string | number | boolean | readonly string[];
const val = (v: V): HclValue =>
  typeof v === 'string' ? str(v) : typeof v === 'number' ? num(v) : typeof v === 'boolean' ? bool(v) : Array.isArray(v) ? strings(v as readonly string[]) : (v as HclValue);
const at = (o: Readonly<Record<string, V | undefined>>): HclAttribute[] =>
  Object.entries(o).filter(([, v]) => v !== undefined).map(([name, v]) => ({ name, value: val(v as V) }));
const b = (type: string, labels: readonly string[], o: Readonly<Record<string, V | undefined>> = {}, blocks: readonly HclBlock[] = [], comment?: string): HclBlock => ({
  type, labels, attributes: at(o), blocks, ...(comment ? { comment } : {}),
});
const x = raw;
/** An HCL object on several lines, keys aligned the way `terraform fmt` does. */
function obj(o: Readonly<Record<string, string>>, indent = '  '): HclValue {
  const keys = Object.keys(o);
  if (keys.length === 0) return x('{}');
  const w = Math.max(...keys.map((k) => k.length));
  return x(`{\n${keys.map((k) => `${indent}  ${k.padEnd(w)} = ${o[k]}`).join('\n')}\n${indent}}`);
}
const variable = (name: string, type: string, description: string, def?: V, extra: Readonly<Record<string, V>> = {}): HclBlock =>
  b('variable', [name], { type: x(type), description, ...(def !== undefined ? { default: def } : {}), ...extra });
const output = (name: string, value: string, description: string): HclBlock => b('output', [name], { value: x(value), description });

/**
 * `terraform fmt` alignment: the `=` of consecutive one-line attributes at the
 * same depth line up; an attribute whose value opens on several lines is not
 * aligned and ends the run. (hcl.ts aligns every attribute of a block.)
 */
export function fmtAlign(text: string): string {
  const lines = text.split('\n');
  const ATTR = /^(\s*)([A-Za-z_][A-Za-z0-9_-]*)\s*=\s(.*)$/;
  const opens = (v: string): boolean => /[{[(]\s*$/.test(v);
  let i = 0;
  while (i < lines.length) {
    const m = ATTR.exec(lines[i]!);
    if (!m) { i += 1; continue; }
    if (opens(m[3]!)) { lines[i] = `${m[1]}${m[2]} = ${m[3]}`; i += 1; continue; }
    const run: number[] = [i];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const n = ATTR.exec(lines[j]!);
      if (!n || n[1] !== m[1] || opens(n[3]!)) break;
      run.push(j);
    }
    const w = Math.max(...run.map((k) => ATTR.exec(lines[k]!)![2]!.length));
    for (const k of run) {
      const n = ATTR.exec(lines[k]!)!;
      lines[k] = `${n[1]}${n[2]!.padEnd(w)} = ${n[3]}`;
    }
    i = j;
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Per platform
// ---------------------------------------------------------------------------

interface Bootstrap {
  readonly versions: HclBlock[];
  readonly main: HclBlock[];
  readonly variables: HclBlock[];
  readonly outputs: HclBlock[];
  readonly tfvarsExample: string;
  readonly notes: readonly string[];
}

interface BootstrapInput {
  readonly plan: string;
  readonly prefix: string;
  readonly region: string;
}

const terraformBlock = (version: string, providers: Readonly<Record<string, { source: string; version: string }>>): HclBlock =>
  b('terraform', [], { required_version: version }, [
    {
      type: 'required_providers',
      attributes: Object.entries(providers).map(([name, p]) => ({ name, value: obj({ source: `"${p.source}"`, version: `"${p.version}"` }, '    ') })),
    },
  ]);

function aws(i: BootstrapInput): Bootstrap {
  const tags = obj({ atk_plan: 'var.plan', atk_role: '"terraform-state"' }, '    ');
  return {
    versions: [terraformBlock('>= 1.10.0', { aws: { source: 'hashicorp/aws', version: '>= 5.70.0' } })],
    main: [
      b('provider', ['aws'], { region: x('var.region') }, [b('default_tags', [], { tags })], 'Signs in from the AWS credential chain: a profile, SSO, or the CI\'s OIDC role.'),
      b('data', ['aws_caller_identity', 'current']),
      b('data', ['aws_partition', 'current']),
      b('locals', [], { bucket: x('substr("${var.name_prefix}-tfstate-${data.aws_caller_identity.current.account_id}-${var.region}", 0, 63)') }),
      b('resource', ['aws_kms_key', 'state'], { description: x('"Terraform state for ${var.plan}"'), enable_key_rotation: true, deletion_window_in_days: 30 }),
      b('resource', ['aws_kms_alias', 'state'], { name: x('"alias/${var.name_prefix}-tfstate"'), target_key_id: x('aws_kms_key.state.key_id') }),
      b('resource', ['aws_s3_bucket', 'state'], { bucket: x('local.bucket') }, [b('lifecycle', [], { prevent_destroy: true })], 'The state bucket. prevent_destroy: state outlives any one stack.'),
      b('resource', ['aws_s3_bucket_ownership_controls', 'state'], { bucket: x('aws_s3_bucket.state.id') }, [b('rule', [], { object_ownership: 'BucketOwnerEnforced' })]),
      b('resource', ['aws_s3_bucket_public_access_block', 'state'], {
        bucket: x('aws_s3_bucket.state.id'), block_public_acls: true, block_public_policy: true, ignore_public_acls: true, restrict_public_buckets: true,
      }),
      b('resource', ['aws_s3_bucket_versioning', 'state'], { bucket: x('aws_s3_bucket.state.id') }, [b('versioning_configuration', [], { status: 'Enabled' })]),
      b('resource', ['aws_s3_bucket_server_side_encryption_configuration', 'state'], { bucket: x('aws_s3_bucket.state.id') }, [
        b('rule', [], { bucket_key_enabled: true }, [b('apply_server_side_encryption_by_default', [], { sse_algorithm: 'aws:kms', kms_master_key_id: x('aws_kms_key.state.arn') })]),
      ]),
      b('resource', ['aws_s3_bucket_lifecycle_configuration', 'state'], { bucket: x('aws_s3_bucket.state.id') }, [
        b('rule', [], { id: 'state-versions', status: 'Enabled' }, [
          b('filter', []),
          b('noncurrent_version_expiration', [], { noncurrent_days: x('var.noncurrent_days') }),
          b('abort_incomplete_multipart_upload', [], { days_after_initiation: 7 }),
        ]),
      ]),
      b('data', ['aws_iam_policy_document', 'tls_only'], {}, [
        b('statement', [], { sid: 'DenyInsecureTransport', effect: 'Deny', actions: ['s3:*'], resources: x('[aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]') }, [
          b('principals', [], { type: '*', identifiers: ['*'] }),
          b('condition', [], { test: 'Bool', variable: 'aws:SecureTransport', values: ['false'] }),
        ]),
      ]),
      b('resource', ['aws_s3_bucket_policy', 'state'], { bucket: x('aws_s3_bucket.state.id'), policy: x('data.aws_iam_policy_document.tls_only.json') }),
    ],
    variables: [
      variable('plan', 'string', 'The plan this state belongs to (the atk_plan tag).', i.plan),
      variable('name_prefix', 'string', 'Prefix of the bucket and key alias names.', i.prefix),
      variable('region', 'string', 'The region of the state bucket.', i.region),
      variable('noncurrent_days', 'number', 'Days an old state version is kept.', 90),
    ],
    outputs: [
      output('bucket', 'aws_s3_bucket.state.id', 'The state bucket: TF_STATE_BUCKET_AWS.'),
      output('kms_key_arn', 'aws_kms_key.state.arn', 'The state KMS key: TF_STATE_KMS_KEY_AWS.'),
      output('ci_variables', '{\n    TF_STATE_BUCKET_AWS  = aws_s3_bucket.state.id\n    TF_STATE_KMS_KEY_AWS = aws_kms_key.state.arn\n    AWS_REGION           = var.region\n  }', 'The CI variables the pipeline reads.'),
    ],
    tfvarsExample: '',
    notes: [
      'Locking is S3 native (`use_lockfile = true`, Terraform 1.10 or later): no DynamoDB table.',
      'The pipeline reaches S3 over its dual-stack endpoint (`use_dualstack_endpoint = true`).',
    ],
  };
}

function azure(i: BootstrapInput): Bootstrap {
  return {
    versions: [terraformBlock('>= 1.10.0', { azurerm: { source: 'hashicorp/azurerm', version: '>= 4.0.0' } })],
    main: [
      b('provider', ['azurerm'], { storage_use_azuread: true }, [b('features', [])], 'Signs in from az login, or the CI\'s federated identity (ARM_USE_OIDC). The subscription comes from ARM_SUBSCRIPTION_ID.\nstorage_use_azuread: the account refuses shared keys, so the container is created with Entra ID.'),
      b('data', ['azurerm_client_config', 'current']),
      b('locals', [], {
        account: x('substr(replace(lower("${var.name_prefix}st${substr(sha1(data.azurerm_client_config.current.subscription_id), 0, 8)}"), "/[^a-z0-9]/", ""), 0, 24)'),
        tags: obj({ atk_plan: 'var.plan', atk_role: '"terraform-state"' }),
      }),
      b('resource', ['azurerm_resource_group', 'state'], { name: x('"${var.name_prefix}-tfstate"'), location: x('var.location'), tags: x('local.tags') }),
      b('resource', ['azurerm_storage_account', 'state'], {
        name: x('local.account'),
        resource_group_name: x('azurerm_resource_group.state.name'),
        location: x('azurerm_resource_group.state.location'),
        account_kind: 'StorageV2',
        account_tier: 'Standard',
        account_replication_type: x('var.replication'),
        min_tls_version: 'TLS1_2',
        https_traffic_only_enabled: true,
        shared_access_key_enabled: false,
        allow_nested_items_to_be_public: false,
        infrastructure_encryption_enabled: true,
        tags: x('local.tags'),
      }, [
        b('blob_properties', [], { versioning_enabled: true }, [b('delete_retention_policy', [], { days: 30 }), b('container_delete_retention_policy', [], { days: 30 })]),
        b('lifecycle', [], { prevent_destroy: true }),
      ], 'The state account: Entra ID only (no shared keys), TLS 1.2, versioned blobs.'),
      b('resource', ['azurerm_storage_container', 'state'], { name: 'tfstate', storage_account_id: x('azurerm_storage_account.state.id'), container_access_type: 'private' }),
      b('resource', ['azurerm_role_assignment', 'state_writers'], {
        for_each: x('toset(concat([data.azurerm_client_config.current.object_id], var.state_writers))'),
        scope: x('azurerm_storage_account.state.id'),
        role_definition_name: 'Storage Blob Data Contributor',
        principal_id: x('each.value'),
      }, [], 'Who may read and lock state: whoever runs this, and the pipeline identities.'),
      b('resource', ['azurerm_management_lock', 'state'], { name: 'terraform-state', scope: x('azurerm_storage_account.state.id'), lock_level: 'CanNotDelete', notes: 'Terraform state.' }),
    ],
    variables: [
      variable('plan', 'string', 'The plan this state belongs to (the atk_plan tag).', i.plan),
      variable('name_prefix', 'string', 'Prefix of the resource group and storage account names.', i.prefix),
      variable('location', 'string', 'The region of the state account.', i.region),
      variable('replication', 'string', 'ZRS where the region has zones (GZRS / RAGZRS for a paired copy); LRS otherwise.', 'ZRS'),
      variable('state_writers', 'list(string)', 'Object ids of the pipeline identities (their managed identity or app registration principal).', [] as readonly string[]),
    ],
    outputs: [
      output('resource_group_name', 'azurerm_resource_group.state.name', 'TF_STATE_RESOURCE_GROUP_AZURE.'),
      output('storage_account_name', 'azurerm_storage_account.state.name', 'TF_STATE_ACCOUNT_AZURE.'),
      output('ci_variables', '{\n    TF_STATE_RESOURCE_GROUP_AZURE = azurerm_resource_group.state.name\n    TF_STATE_ACCOUNT_AZURE        = azurerm_storage_account.state.name\n  }', 'The CI variables the pipeline reads.'),
    ],
    tfvarsExample: '# Object ids of the pipeline identities that read and write state:\n# state_writers = ["00000000-0000-0000-0000-000000000000"]\n',
    notes: ['Locking is the blob lease. The backend signs in with Entra ID (`use_azuread_auth = true`): the account has shared keys turned off.'],
  };
}

function google(i: BootstrapInput): Bootstrap {
  return {
    versions: [terraformBlock('>= 1.10.0', { google: { source: 'hashicorp/google', version: '>= 6.0.0' } })],
    main: [
      b('provider', ['google'], { project: x('var.project_id') }, [], 'Signs in from Application Default Credentials: gcloud, or the CI\'s workload identity federation.'),
      b('resource', ['google_storage_bucket', 'state'], {
        name: x('"${var.project_id}-${var.name_prefix}-tfstate"'),
        location: x('var.location'),
        storage_class: 'STANDARD',
        uniform_bucket_level_access: true,
        public_access_prevention: 'enforced',
        force_destroy: false,
        labels: obj({ atk_plan: 'var.plan', atk_role: '"terraform-state"' }),
      }, [
        b('versioning', [], { enabled: true }),
        b('lifecycle_rule', [], {}, [b('condition', [], { num_newer_versions: 20, with_state: 'ARCHIVED' }), b('action', [], { type: 'Delete' })]),
        b('lifecycle', [], { prevent_destroy: true }),
      ], 'The state bucket: versioned, uniform access, never public.'),
    ],
    variables: [
      variable('plan', 'string', 'The plan this state belongs to (the atk_plan label).', i.plan),
      variable('project_id', 'string', 'The project that holds the state bucket.'),
      variable('name_prefix', 'string', 'Part of the bucket name.', i.prefix),
      variable('location', 'string', 'The bucket location: the region, or a dual-region / multi-region.', i.region),
    ],
    outputs: [
      output('bucket', 'google_storage_bucket.state.name', 'TF_STATE_BUCKET_GCP.'),
      output('ci_variables', '{\n    TF_STATE_BUCKET_GCP = google_storage_bucket.state.name\n  }', 'The CI variables the pipeline reads.'),
    ],
    tfvarsExample: 'project_id = "my-state-project"\n',
    notes: ['Locking is native to the gcs backend.'],
  };
}

function oci(i: BootstrapInput): Bootstrap {
  return {
    versions: [terraformBlock('>= 1.12.0', { oci: { source: 'oracle/oci', version: '>= 6.0.0' } })],
    main: [
      b('provider', ['oci'], { region: x('var.region') }, [], 'Signs in from the OCI config file profile (~/.oci/config), or instance principal on a runner in OCI.'),
      b('data', ['oci_objectstorage_namespace', 'this'], { compartment_id: x('var.compartment_ocid') }),
      b('resource', ['oci_objectstorage_bucket', 'state'], {
        compartment_id: x('var.compartment_ocid'),
        namespace: x('data.oci_objectstorage_namespace.this.namespace'),
        name: x('"${var.name_prefix}-tfstate"'),
        access_type: 'NoPublicAccess',
        storage_tier: 'Standard',
        versioning: 'Enabled',
        kms_key_id: x('var.kms_key_ocid'),
        freeform_tags: obj({ atk_plan: 'var.plan', atk_role: '"terraform-state"' }),
      }, [b('lifecycle', [], { prevent_destroy: true })], 'The state bucket: private and versioned.'),
    ],
    variables: [
      variable('plan', 'string', 'The plan this state belongs to (the atk_plan tag).', i.plan),
      variable('compartment_ocid', 'string', 'The compartment that holds the state bucket.'),
      variable('name_prefix', 'string', 'Prefix of the bucket name.', i.prefix),
      variable('region', 'string', 'The region of the state bucket.', i.region),
      variable('kms_key_ocid', 'string', 'A Vault key for the bucket; null uses Oracle-managed keys.', x('null')),
    ],
    outputs: [
      output('bucket', 'oci_objectstorage_bucket.state.name', 'TF_STATE_BUCKET_OCI.'),
      output('namespace', 'data.oci_objectstorage_namespace.this.namespace', 'TF_STATE_NAMESPACE_OCI.'),
      output('ci_variables', '{\n    TF_STATE_BUCKET_OCI    = oci_objectstorage_bucket.state.name\n    TF_STATE_NAMESPACE_OCI = data.oci_objectstorage_namespace.this.namespace\n    OCI_REGION             = var.region\n  }', 'The CI variables the pipeline reads.'),
    ],
    tfvarsExample: 'compartment_ocid = "ocid1.compartment.oc1..example"\n',
    notes: ['The stacks use the native `oci` backend (Terraform 1.12 or later), which locks the state (verify: https://developer.hashicorp.com/terraform/language/backend/oci).'],
  };
}

const BUILDERS: Readonly<Partial<Record<Platform, (i: BootstrapInput) => Bootstrap>>> = { aws, azure, google, oci };
/** The backend kind each bootstrap creates. */
export const BOOTSTRAP_BACKEND: Readonly<Partial<Record<Platform, Exclude<BackendKind, 'none' | 'local'>>>> = { aws: 's3', azure: 'azurerm', google: 'gcs', oci: 'oci' };

function readme(platform: Platform, bs: Bootstrap, backend: Exclude<BackendKind, 'none' | 'local'>): string {
  const vars = STATE_VARIABLES[backend];
  const cfg = backendConfig({ platform, env: 'prod', dir: 'backend-bootstrap', name: 'backend-bootstrap', backend }, '<plan>', (n) => `<${n}>`);
  return [
    `# State store: ${PLATFORM_LABELS[platform]}`,
    '',
    'Creates the store every stack on this platform keeps its state in. Apply it once, before the stacks; it applies as generated.',
    '',
    '```sh',
    'terraform init',
    ...(bs.tfvarsExample ? ['cp terraform.tfvars.example terraform.tfvars   # fill it in'] : []),
    'terraform apply',
    'terraform output ci_variables',
    '```',
    '',
    'Set each value of `ci_variables` as a CI variable (not a secret):',
    '',
    ...vars.map((v) => `- \`${v.name}\`: ${v.description}`),
    '',
    'Each stack keeps its state at `<plan>/<platform>/<env>/<stack>.tfstate`; the pipeline passes the store and the key at `terraform init` (ci/scripts/terraform.sh).',
    '',
    ...bs.notes.map((n) => `- ${n}`),
    '',
    '## Move this module\'s own state into the store',
    '',
    'It starts on local state, because the store does not exist yet. Once applied, add an empty',
    `\`backend "${backend}" {}\` block to versions.tf and run:`,
    '',
    '```sh',
    `terraform init -migrate-state ${Object.entries(cfg).map(([k, v]) => `-backend-config="${k}=${v}"`).join(' ')}`,
    '```',
    '',
  ].join('\n');
}

/** The bootstrap root module of each platform the stacks keep remote state for, under `backend-bootstrap/<p>/`. */
export function backendBootstrapFiles(
  plan: Plan,
  design: TargetDesign,
  stacks: readonly DeployStack[],
): { files: Record<string, string>; findings: Finding[] } {
  const files: Record<string, string> = {};
  const findings: Finding[] = [];
  const header = 'State store bootstrap: apply once, before the stacks.';
  for (const platform of PLATFORM_VALUES) {
    const mine = stacks.filter((s) => s.platform === platform);
    if (mine.length === 0) continue;
    const kinds = new Set(mine.map((s) => s.backend));
    for (const k of kinds) {
      if (k === 'local') {
        findings.push(warning('plan.build.state-local', `${PLATFORM_LABELS[platform]}: the stacks keep local state, which a pipeline run throws away; choose a remote backend (Generate → State backend) before running them in CI.`, {
          remediation: 'Set the state backend to s3, azurerm, gcs or oci: any store the pipeline can reach.',
        }));
        continue;
      }
      const home = (Object.entries(BOOTSTRAP_BACKEND) as [Platform, string][]).find(([, v]) => v === k)?.[0];
      if (home && home !== platform) {
        findings.push(info('plan.build.state-elsewhere', `${PLATFORM_LABELS[platform]}: its stacks keep state in the ${PLATFORM_LABELS[home]} store (backend ${k}).`));
      }
    }
  }
  // One bootstrap per store used.
  const used = new Set(stacks.map((s) => s.backend));
  for (const platform of PLATFORM_VALUES) {
    const backend = BOOTSTRAP_BACKEND[platform];
    const build = BUILDERS[platform];
    if (!backend || !build || !used.has(backend)) continue;
    const pd = design.platforms.find((p) => p.platform === platform);
    const region = pd?.region?.trim() || plan.requirements.regions[platform]?.primary?.trim() || '';
    if (!region) {
      findings.push(warning('plan.build.state-region', `${PLATFORM_LABELS[platform]}: no region is set, so the state store's region is left for terraform.tfvars.`));
    }
    const prefix = (pd?.prefix?.trim() || planSlug(plan.id)).toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 20).replace(/-+$/, '');
    const bs = build({ plan: planSlug(plan.id), prefix, region });
    const dir = `backend-bootstrap/${platform}`;
    files[`${dir}/versions.tf`] = fmtAlign(renderFile(bs.versions));
    files[`${dir}/main.tf`] = fmtAlign(renderFile(bs.main, header));
    files[`${dir}/variables.tf`] = fmtAlign(renderFile(region ? bs.variables : bs.variables.map(dropEmptyDefault)));
    files[`${dir}/outputs.tf`] = fmtAlign(renderFile(bs.outputs));
    if (bs.tfvarsExample || !region) files[`${dir}/terraform.tfvars.example`] = `${bs.tfvarsExample}${region ? '' : `${platform === 'azure' ? 'location' : platform === 'google' ? 'location' : 'region'} = ""\n`}`;
    files[`${dir}/README.md`] = readme(platform, bs, backend);
  }
  return { files, findings };
}

/** A region / location variable with an empty default becomes required. */
function dropEmptyDefault(block: HclBlock): HclBlock {
  const d = block.attributes?.find((a) => a.name === 'default');
  if (d && d.value.kind === 'string' && d.value.value === '') return { ...block, attributes: block.attributes!.filter((a) => a.name !== 'default') };
  return block;
}
