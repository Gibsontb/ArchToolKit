/**
 * The Terraform providers this kit can author for.
 *
 * Every entry is the provider's real registry source address and the major
 * version current when this table was written, taken from the registry API
 * rather than from memory — a wrong source address produces a configuration that
 * cannot even initialise, and a wrong version constraint silently pins people to
 * a release that does not exist.
 *
 * Authentication is described rather than generated. Each provider has its own
 * environment variables and credential chain, and writing credentials into a
 * configuration is the single most common way Terraform repositories leak.
 *
 * Verification: V-DOC (Terraform Registry API, retrieved 2026-09-20).
 */

export type CloudTarget = 'vcf' | 'vsphere' | 'aws' | 'azure' | 'google' | 'oci';

export interface ProviderInfo {
  readonly target: CloudTarget;
  /** How the provider is named in a `required_providers` block. */
  readonly localName: string;
  /** Registry source address. */
  readonly source: string;
  /** Version constraint pinned to the current major line. */
  readonly version: string;
  /** Version observed in the registry when this table was written. */
  readonly observedVersion: string;
  readonly label: string;
  /**
   * Attributes the provider block takes that are not credentials — the ones it
   * is reasonable to generate.
   */
  readonly configuration: readonly { readonly name: string; readonly description: string }[];
  /**
   * How credentials reach the provider. Described, never generated: these belong
   * in the environment or a credential helper, not in a file.
   */
  readonly credentials: string;
}

export const PROVIDERS: readonly ProviderInfo[] = [
  {
    target: 'vcf',
    localName: 'vcf',
    source: 'vmware/vcf',
    version: '~> 0.18',
    observedVersion: '0.18.2',
    label: 'VMware Cloud Foundation',
    configuration: [
      { name: 'installer_host', description: 'VCF Installer appliance, for a bring-up.' },
      { name: 'sddc_manager_host', description: 'SDDC Manager, for day-2 work.' },
    ],
    credentials:
      'Username and password for the installer or SDDC Manager. The provider marks password attributes sensitive as of v0.18.2.',
  },
  {
    target: 'vsphere',
    localName: 'vsphere',
    source: 'vmware/vsphere',
    version: '~> 2.17',
    observedVersion: '2.17.1',
    label: 'VMware vSphere',
    configuration: [{ name: 'vsphere_server', description: 'vCenter Server FQDN.' }],
    credentials: 'VSPHERE_USER and VSPHERE_PASSWORD, or the provider arguments of the same names.',
  },
  {
    target: 'aws',
    localName: 'aws',
    source: 'hashicorp/aws',
    version: '~> 6.65',
    observedVersion: '6.65.0',
    label: 'Amazon Web Services',
    configuration: [{ name: 'region', description: 'AWS region, e.g. us-east-1.' }],
    credentials:
      'The standard AWS credential chain: environment variables, a shared config profile, SSO, or an instance role. Prefer a named profile or SSO over static keys.',
  },
  {
    target: 'azure',
    localName: 'azurerm',
    source: 'hashicorp/azurerm',
    version: '~> 5.6',
    observedVersion: '5.6.0',
    label: 'Microsoft Azure',
    configuration: [{ name: 'subscription_id', description: 'Target subscription.' }],
    credentials:
      'Azure CLI login, a managed identity, or a service principal through ARM_* environment variables. The provider requires a features block, which is generated.',
  },
  {
    target: 'google',
    localName: 'google',
    source: 'hashicorp/google',
    version: '~> 8.3',
    observedVersion: '8.3.0',
    label: 'Google Cloud',
    configuration: [
      { name: 'project', description: 'Target project id.' },
      { name: 'region', description: 'Default region, e.g. us-central1.' },
    ],
    credentials:
      'Application Default Credentials, or GOOGLE_APPLICATION_CREDENTIALS pointing at a service account key. Prefer workload identity federation over a key file.',
  },
  {
    target: 'oci',
    localName: 'oci',
    source: 'oracle/oci',
    version: '~> 9.2',
    observedVersion: '9.2.0',
    label: 'Oracle Cloud Infrastructure',
    configuration: [
      { name: 'region', description: 'OCI region, e.g. us-ashburn-1.' },
      { name: 'tenancy_ocid', description: 'Tenancy OCID.' },
    ],
    credentials:
      'An OCI config file profile, instance principal, or security token. API key fingerprints and private keys belong outside the configuration.',
  },
];

export function providerFor(target: CloudTarget): ProviderInfo {
  const found = PROVIDERS.find((p) => p.target === target);
  if (!found) throw new Error(`Unknown Terraform target: ${target}`);
  return found;
}
