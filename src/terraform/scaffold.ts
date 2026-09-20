/**
 * Starter Terraform for any target this kit knows.
 *
 * Every Terraform repository begins with the same three things — a version and
 * provider declaration, a state backend, and the variables that keep credentials
 * out of the files — and getting them wrong is tedious to discover later. This
 * generates that spine for one or more clouds at once, which is the part of a
 * configuration that genuinely is the same everywhere.
 *
 * It deliberately stops there. Resource bodies for AWS, Azure, Google and OCI
 * are not generated from a general template: those providers carry thousands of
 * resources whose arguments change between major versions, and emitting
 * plausible-looking blocks that no one has checked would produce configurations
 * that fail at plan time, or worse, apply and build the wrong thing. Where this
 * kit does emit resources, it is because the shape was read from that provider's
 * schema — as with VCF in `./vcf.ts`, and as with the network foundations, whose
 * every argument name is checked against the provider's published documentation
 * by tools/verify-foundation-schemas.mjs.
 */

import { info, warning, type Finding } from '../core/findings.ts';
import { renderFile, str, bool, raw, type HclBlock, type HclAttribute } from './hcl.ts';
import { PROVIDERS, providerFor, type CloudTarget, type ProviderInfo } from './providers.ts';

export type BackendKind = 'local' | 's3' | 'azurerm' | 'gcs' | 'oci' | 'none';

export interface ScaffoldOptions {
  readonly targets: readonly CloudTarget[];
  /** Where state lives. Local state is fine for a lab and wrong for a team. */
  readonly backend?: BackendKind;
  /** Minimum Terraform version. */
  readonly requiredVersion?: string;
  readonly projectName?: string;
}

export interface ScaffoldOutput {
  /** Filename to contents, ready to write into a directory. */
  readonly files: Readonly<Record<string, string>>;
  readonly findings: readonly Finding[];
}

const DEFAULT_REQUIRED_VERSION = '>= 1.9.0';

/**
 * Variable name for a provider setting.
 *
 * Providers disagree about names while meaning different things: AWS, Google and
 * OCI all take a `region`, so a configuration spanning them would declare
 * `variable "region"` three times and fail to initialise. Prefixing by target
 * keeps them apart, and the prefix is skipped where the argument already carries
 * it, to avoid `vsphere_vsphere_server`.
 */
function variableName(provider: ProviderInfo, argument: string): string {
  return argument.startsWith(`${provider.target}_`) ? argument : `${provider.target}_${argument}`;
}

function providerBlock(provider: ProviderInfo): HclBlock {
  const attributes: HclAttribute[] = provider.configuration.map((c) => ({
    name: c.name,
    value: raw(`var.${variableName(provider, c.name)}`),
  }));

  // The azurerm provider will not initialise without this block, even empty.
  const blocks: HclBlock[] = provider.target === 'azure' ? [{ type: 'features' }] : [];

  return {
    type: 'provider',
    labels: [provider.localName],
    comment: `${provider.label}\nCredentials: ${provider.credentials}`,
    attributes,
    blocks,
  };
}

function backendBlock(kind: BackendKind): HclBlock | null {
  switch (kind) {
    case 'none':
      return null;
    case 'local':
      return {
        type: 'backend',
        labels: ['local'],
        comment: 'Local state. Fine for one person; replace before anyone else runs this.',
        attributes: [{ name: 'path', value: str('terraform.tfstate') }],
      };
    case 's3':
      return {
        type: 'backend',
        labels: ['s3'],
        comment: 'Fill in the bucket and key, and enable state locking.',
        attributes: [
          { name: 'bucket', value: str('CHANGE-ME') },
          { name: 'key', value: str('terraform.tfstate') },
          { name: 'region', value: str('us-east-1') },
          { name: 'encrypt', value: bool(true) },
          { name: 'use_lockfile', value: bool(true) },
        ],
      };
    case 'azurerm':
      return {
        type: 'backend',
        labels: ['azurerm'],
        attributes: [
          { name: 'resource_group_name', value: str('CHANGE-ME') },
          { name: 'storage_account_name', value: str('CHANGE-ME') },
          { name: 'container_name', value: str('tfstate') },
          { name: 'key', value: str('terraform.tfstate') },
        ],
      };
    case 'gcs':
      return {
        type: 'backend',
        labels: ['gcs'],
        attributes: [
          { name: 'bucket', value: str('CHANGE-ME') },
          { name: 'prefix', value: str('terraform/state') },
        ],
      };
    case 'oci':
      return {
        type: 'backend',
        labels: ['http'],
        comment:
          'OCI has no native backend; Object Storage is used through the http backend,\nor keep state in a bucket via the S3-compatible API.',
        attributes: [{ name: 'address', value: str('CHANGE-ME') }],
      };
    default:
      return null;
  }
}

export function scaffold(options: ScaffoldOptions): ScaffoldOutput {
  const findings: Finding[] = [];
  const targets = [...new Set(options.targets)];

  if (targets.length === 0) {
    return {
      files: {},
      findings: [
        warning('terraform.scaffold.no-targets', 'No cloud was selected, so nothing was generated.', {
          remediation: `Choose one or more of: ${PROVIDERS.map((p) => p.target).join(', ')}.`,
        }),
      ],
    };
  }

  const providers = targets.map(providerFor);
  const backend = options.backend ?? 'local';

  // --- terraform.tf ---------------------------------------------------------
  const requiredProviders: HclAttribute[] = providers.map((p) => ({
    name: p.localName,
    value: raw(`{\n      source  = "${p.source}"\n      version = "${p.version}"\n    }`),
  }));

  const terraformBlocks: HclBlock[] = [
    { type: 'required_providers', attributes: requiredProviders },
  ];
  const back = backendBlock(backend);
  if (back) terraformBlocks.push(back);

  const terraformTf = renderFile(
    [
      {
        type: 'terraform',
        attributes: [
          { name: 'required_version', value: str(options.requiredVersion ?? DEFAULT_REQUIRED_VERSION) },
        ],
        blocks: terraformBlocks,
      },
    ],
    [
      `${options.projectName ?? 'Terraform configuration'} — generated by ArchToolKit.`,
      '',
      'Provider versions were read from the Terraform Registry, pinned to the major',
      'line current at generation time. Review before first use.',
    ].join('\n'),
  );

  // --- providers.tf ---------------------------------------------------------
  const providersTf = renderFile(
    providers.map(providerBlock),
    'Provider configuration. Credentials are not written here — see the comment\nabove each provider for how it expects to be authenticated.',
  );

  // --- variables.tf ---------------------------------------------------------
  const variableBlocks: HclBlock[] = providers.flatMap((p) =>
    p.configuration.map((c) => ({
      type: 'variable',
      labels: [variableName(p, c.name)],
      attributes: [
        { name: 'type', value: raw('string') },
        { name: 'description', value: str(`${p.label}: ${c.description}`) },
      ],
    })),
  );
  const variablesTf = renderFile(
    variableBlocks,
    'One variable per provider setting. Supply values in a tfvars file that is not\ncommitted, or through TF_VAR_ environment variables.',
  );

  // --- .gitignore -----------------------------------------------------------
  const gitignore = [
    '# Terraform',
    '.terraform/',
    '*.tfstate',
    '*.tfstate.*',
    'crash.log',
    '',
    '# Values, which routinely carry credentials',
    '*.tfvars',
    '*.tfvars.json',
    '!example.tfvars',
    '',
    '# Provider credentials that should never be committed',
    '*.pem',
    '*.key',
    '',
  ].join('\n');

  const exampleTfvars = `${providers
    .flatMap((p) => [
      `# ${p.label}`,
      ...p.configuration.map(
        (c) => `# ${variableName(p, c.name)} = "" # ${c.description}`,
      ),
      '',
    ])
    .join('\n')}`;

  if (backend === 'local') {
    findings.push(
      warning(
        'terraform.scaffold.local-state',
        'State is local, so it lives on one machine, is not locked, and is not shared.',
        {
          remediation: 'Move to a remote backend before a second person runs this.',
          source: 'Terraform backend configuration',
        },
      ),
    );
  }

  for (const provider of providers) {
    findings.push(
      info(
        'terraform.scaffold.provider',
        `${provider.label}: ${provider.source} ${provider.version} (registry showed ${provider.observedVersion}).`,
        { source: 'Terraform Registry' },
      ),
    );
  }

  findings.push(
    info(
      'terraform.scaffold.resources-not-generated',
      'This is the configuration spine: versions, providers, backend and variables. Resource bodies are generated only where the provider schema has been read, which today means VCF.',
      { source: 'ArchToolKit' },
    ),
  );

  return {
    files: {
      'terraform.tf': terraformTf,
      'providers.tf': providersTf,
      'variables.tf': variablesTf,
      'example.tfvars': exampleTfvars,
      '.gitignore': gitignore,
    },
    findings,
  };
}
