/**
 * app_velero: Velero for moving Kubernetes workloads between clusters
 * (addendum A.4.2 Containers, path k8s-velero; A.4.7), from an admin host
 * that holds the cluster's kubeconfig.
 *
 *   - the velero CLI from its GitHub release, unpacked under /opt and linked
 *     into /usr/local/bin;
 *   - the object-store credentials file written from vault variables
 *     (mode 0600, the task logs nothing);
 *   - `velero install --provider <aws|azure|gcp> --bucket … --plugins …`
 *     against the kubeconfig, once (skipped when the cluster already has a
 *     Velero backup location). File-system backup through the node agent, and
 *     no volume snapshots: a snapshot does not cross clouds, a file-system
 *     backup does;
 *   - on the source cluster, the backup schedule for the app's namespaces;
 *     on the target cluster, a restore from a named backup, with the
 *     storage-class / ingress-class resource modifiers ConfigMap when there is
 *     one (the k8s-velero path generates it).
 *
 * OCI Object Storage and an S3-compatible store on VCF (VKS clusters) are
 * reached through the AWS plugin with the store's S3 endpoint.
 * https://velero.io/docs/main/basic-install/ ;
 * https://velero.io/docs/main/file-system-backup/
 *
 * kubernetes.core is in the catalog, but its modules need the Python
 * kubernetes client on the admin host; the velero CLI needs nothing, so the
 * checks here use it.
 */

import type { TemplateValues } from '../../../kit/blueprint.ts';
import type { Role, Task } from '../../migration/roles/types.ts';
import { list, text } from '../migration/common.ts';
import { patternBlueprint, select } from './common.ts';

const CREDENTIALS = `{% if velero_provider == 'azure' %}
AZURE_SUBSCRIPTION_ID={{ velero_azure_subscription_id }}
AZURE_TENANT_ID={{ velero_azure_tenant_id }}
AZURE_CLIENT_ID={{ vault_velero_azure_client_id }}
AZURE_CLIENT_SECRET={{ vault_velero_azure_client_secret }}
AZURE_RESOURCE_GROUP={{ velero_azure_resource_group }}
AZURE_CLOUD_NAME=AzurePublicCloud
{% elif velero_provider == 'gcp' %}
{{ vault_velero_gcp_credentials_json if vault_velero_gcp_credentials_json is string else vault_velero_gcp_credentials_json | to_json }}
{% else %}
[default]
aws_access_key_id={{ vault_velero_access_key_id }}
aws_secret_access_key={{ vault_velero_secret_access_key }}
{% endif %}
`;

const tasks: Task[] = [
  {
    name: 'Check the bucket is named',
    'ansible.builtin.assert': { that: ['velero_bucket | length > 0'], fail_msg: 'Set the bucket (container on Azure) for the Velero backups (velero_bucket).', quiet: true },
  },
  {
    name: 'Check the S3 endpoint is set for OCI and S3-compatible stores',
    'ansible.builtin.assert': { that: ['velero_s3_url | length > 0'], fail_msg: 'Set velero_s3_url, the S3-compatible endpoint of the object store.', quiet: true },
    when: "velero_provider in ['oci', 's3']",
  },
  {
    name: 'Unpack the velero CLI',
    'ansible.builtin.unarchive': {
      src: 'https://github.com/vmware-tanzu/velero/releases/download/v{{ velero_version }}/velero-v{{ velero_version }}-linux-{{ velero_arch }}.tar.gz',
      dest: '/opt',
      remote_src: true,
      creates: '/opt/velero-v{{ velero_version }}-linux-{{ velero_arch }}/velero',
      owner: 'root',
      group: 'root',
    },
    become: true,
  },
  {
    name: 'Put it on the PATH',
    'ansible.builtin.file': { src: '/opt/velero-v{{ velero_version }}-linux-{{ velero_arch }}/velero', dest: '/usr/local/bin/velero', state: 'link', force: true },
    become: true,
  },
  { name: 'Make the credentials folder', 'ansible.builtin.file': { path: '{{ velero_config_dir }}', state: 'directory', mode: '0700' } },
  {
    name: 'Write the object-store credentials',
    'ansible.builtin.template': { src: 'credentials-velero.j2', dest: '{{ velero_config_dir }}/credentials-{{ velero_provider }}', mode: '0600' },
    no_log: true,
  },
  {
    name: 'Look for Velero in the cluster',
    'ansible.builtin.command': { argv: `{{ ['velero', 'backup-location', 'get'] + velero_cluster_args }}` },
    register: 'velero_locations',
    changed_when: false,
    failed_when: false,
    check_mode: false,
  },
  {
    name: 'Install Velero in the cluster',
    'ansible.builtin.command': { argv: '{{ velero_install_argv }}' },
    when: 'velero_locations.rc != 0',
    changed_when: true,
  },
  {
    name: 'Schedule the backups of the app namespaces (source cluster)',
    when: ["velero_cluster_role == 'source'", 'velero_namespaces | length > 0'],
    block: [
      {
        name: 'Look for the schedule',
        'ansible.builtin.command': { argv: `{{ ['velero', 'schedule', 'get', velero_backup_name] + velero_cluster_args }}` },
        register: 'velero_schedule',
        changed_when: false,
        failed_when: false,
        check_mode: false,
      },
      {
        name: 'Create it',
        'ansible.builtin.command': {
          argv: `{{ ['velero', 'schedule', 'create', velero_backup_name, '--schedule', velero_schedule_cron, '--include-namespaces', velero_namespaces | join(','), '--default-volumes-to-fs-backup', '--ttl', velero_ttl] + velero_cluster_args }}`,
        },
        when: 'velero_schedule.rc != 0',
        changed_when: true,
      },
    ],
  },
  {
    name: 'Restore from the backup (target cluster)',
    when: ["velero_cluster_role == 'target'", 'velero_restore_from | length > 0'],
    block: [
      {
        name: 'Look for the restore',
        'ansible.builtin.command': { argv: `{{ ['velero', 'restore', 'get', 'restore-' ~ velero_restore_from] + velero_cluster_args }}` },
        register: 'velero_restore',
        changed_when: false,
        failed_when: false,
        check_mode: false,
      },
      {
        name: 'Restore',
        'ansible.builtin.command': {
          argv: `{{ ['velero', 'restore', 'create', 'restore-' ~ velero_restore_from, '--from-backup', velero_restore_from, '--wait'] + (['--resource-modifier-configmap', velero_resource_modifiers] if velero_resource_modifiers | length > 0 else []) + velero_cluster_args }}`,
        },
        when: 'velero_restore.rc != 0',
        changed_when: true,
      },
    ],
  },
];

export const VELERO_ROLE: Role = {
  name: 'velero',
  description: 'the velero CLI, the object-store credentials, Velero installed in the cluster, and the backup schedule or the restore.',
  tasks,
  templates: { 'credentials-velero.j2': CREDENTIALS },
  defaults: {
    velero_provider: 'aws',
    velero_version: '1.17.0',
    velero_plugin_version: 'v1.13.0',
    velero_bucket: '',
    velero_prefix: '',
    velero_region: '',
    velero_s3_url: '',
    velero_azure_subscription_id: '',
    velero_azure_tenant_id: '',
    velero_azure_resource_group: '',
    velero_azure_storage_account: '',
    velero_kubeconfig: '',
    velero_kube_context: '',
    velero_namespace: 'velero',
    velero_cluster_role: 'source',
    velero_namespaces: [],
    velero_backup_name: 'app',
    velero_schedule_cron: '0 */6 * * *',
    velero_ttl: '720h0m0s',
    velero_restore_from: '',
    velero_resource_modifiers: '',
  },
  derived: {
    velero_arch: "{{ 'arm64' if ansible_facts.architecture in ['aarch64', 'arm64'] else 'amd64' }}",
    velero_config_dir: '{{ ansible_facts.env.HOME }}/.velero',
    velero_kubeconfig_path: "{{ velero_kubeconfig if velero_kubeconfig | length > 0 else ansible_facts.env.HOME ~ '/.kube/config' }}",
    velero_plugin_image: {
      aws: 'velero/velero-plugin-for-aws',
      oci: 'velero/velero-plugin-for-aws',
      s3: 'velero/velero-plugin-for-aws',
      azure: 'velero/velero-plugin-for-microsoft-azure',
      gcp: 'velero/velero-plugin-for-gcp',
    },
    velero_plugin_provider: { aws: 'aws', oci: 'aws', s3: 'aws', azure: 'azure', gcp: 'gcp' },
    velero_location_config:
      "{{ ('region=' ~ velero_region) if velero_provider == 'aws' else ('region=' ~ velero_region ~ ',s3ForcePathStyle=true,s3Url=' ~ velero_s3_url) if velero_provider in ['oci', 's3'] else ('resourceGroup=' ~ velero_azure_resource_group ~ ',storageAccount=' ~ velero_azure_storage_account ~ ',subscriptionId=' ~ velero_azure_subscription_id) if velero_provider == 'azure' else '' }}",
    velero_install_argv:
      "{{ ['velero', 'install', '--provider', velero_plugin_provider[velero_provider], '--plugins', velero_plugin_image[velero_provider] ~ ':' ~ velero_plugin_version, '--bucket', velero_bucket, '--secret-file', velero_config_dir ~ '/credentials-' ~ velero_provider, '--use-node-agent', '--default-volumes-to-fs-backup', '--use-volume-snapshots=false', '--wait'] + (['--prefix', velero_prefix] if velero_prefix | length > 0 else []) + (['--backup-location-config', velero_location_config] if velero_location_config | length > 0 else []) + velero_cluster_args }}",
    // Every velero command names the cluster it talks to.
    velero_cluster_args:
      "{{ ['--kubeconfig', velero_kubeconfig_path, '--namespace', velero_namespace] + (['--kubecontext', velero_kube_context] if velero_kube_context | length > 0 else []) }}",
  },
};

const PROVIDERS: readonly (readonly [string, string])[] = [
  ['aws', 'AWS (Amazon S3)'],
  ['azure', 'Azure (Blob Storage)'],
  ['gcp', 'Google Cloud (GCP) (Cloud Storage)'],
  ['oci', 'OCI Object Storage (S3 compatibility)'],
  ['s3', 'S3-compatible store (e.g. on VCF, for VKS clusters)'],
];

const VAULTS_BY_PROVIDER: Readonly<Record<string, readonly string[]>> = {
  aws: ['vault_velero_access_key_id', 'vault_velero_secret_access_key'],
  oci: ['vault_velero_access_key_id', 'vault_velero_secret_access_key'],
  s3: ['vault_velero_access_key_id', 'vault_velero_secret_access_key'],
  azure: ['vault_velero_azure_client_id', 'vault_velero_azure_client_secret'],
  gcp: ['vault_velero_gcp_credentials_json'],
};

const AZURE = { showWhen: { input: 'provider', equals: ['azure'] } } as const;

export const APP_VELERO = patternBlueprint({
  id: 'app_velero',
  label: 'Containers – Velero backup and restore',
  description:
    'Velero from an admin host with the kubeconfig: the CLI installed, the object-store credentials written from the vault (0600, not logged), `velero install --provider … --bucket … --plugins …` once per cluster with file-system backup (no snapshots, so backups cross clouds), then the backup schedule of the app namespaces on the source cluster, or the restore (with the resource-modifier ConfigMap) on the target.',
  hosts: { default: 'localhost', hint: 'The admin host that holds the kubeconfig' },
  inputs: [
    select('cluster_role', 'This cluster is the', [['source', 'Source (schedule backups)'], ['target', 'Target (restore)']], 'source'),
    select('provider', 'Object store', PROVIDERS, 'aws'),
    { id: 'bucket', label: 'Bucket / container', control: 'text', default: '', placeholder: 'app-velero-backups' },
    { id: 'region', label: 'Region', control: 'text', default: '', placeholder: 'eu-west-1', hint: 'AWS, OCI and S3-compatible stores', showWhen: { input: 'provider', equals: ['aws', 'oci', 's3'] } },
    { id: 's3_url', label: 'S3 endpoint', control: 'text', default: '', placeholder: 'https://<namespace>.compat.objectstorage.<region>.oraclecloud.com', hint: 'An IPv6 literal goes in brackets', showWhen: { input: 'provider', equals: ['oci', 's3'] } },
    { id: 'azure_subscription_id', label: 'Azure subscription ID', control: 'text', default: '', ...AZURE },
    { id: 'azure_tenant_id', label: 'Azure tenant ID', control: 'text', default: '', ...AZURE },
    { id: 'azure_resource_group', label: 'Storage account resource group', control: 'text', default: '', ...AZURE },
    { id: 'azure_storage_account', label: 'Storage account', control: 'text', default: '', ...AZURE },
    { id: 'namespaces', label: 'App namespaces', control: 'text', default: '', placeholder: 'shop, shop-data', hint: 'Backed up on the source cluster' },
    { id: 'backup_name', label: 'Schedule name', control: 'text', default: 'app', showWhen: { input: 'cluster_role', equals: ['source'] } },
    { id: 'schedule', label: 'Backup schedule (cron)', control: 'text', default: '0 */6 * * *', showWhen: { input: 'cluster_role', equals: ['source'] } },
    { id: 'restore_from', label: 'Restore from backup', control: 'text', default: '', placeholder: 'app-20260101000000', hint: 'A backup name; empty = install only', showWhen: { input: 'cluster_role', equals: ['target'] } },
    { id: 'resource_modifiers', label: 'Resource modifiers ConfigMap', control: 'text', default: '', placeholder: 'app-modifiers', hint: 'storageClass / ingress-class remaps', showWhen: { input: 'cluster_role', equals: ['target'] } },
    { id: 'kubeconfig', label: 'kubeconfig', control: 'text', default: '', placeholder: '~/.kube/config', hint: 'Path on the admin host; empty = ~/.kube/config' },
    { id: 'kube_context', label: 'kube context', control: 'text', default: '', hint: 'Empty = the current context' },
    { id: 'version', label: 'Velero version', control: 'combo', default: '1.17.0', options: [{ value: '1.17.0', label: '1.17.0' }, { value: '1.16.2', label: '1.16.2' }] },
    { id: 'plugin_version', label: 'Provider plugin version', control: 'combo', default: 'v1.13.0', options: [{ value: 'v1.13.0', label: 'v1.13.0 (Velero 1.17)' }, { value: 'v1.12.2', label: 'v1.12.2 (Velero 1.16)' }] },
  ],
  roles: () => [VELERO_ROLE],
  vars: (v: TemplateValues) => ({
    mig_velero_cluster_role: text(v.cluster_role, 'source'),
    mig_velero_provider: text(v.provider, 'aws'),
    mig_velero_bucket: text(v.bucket),
    mig_velero_region: text(v.region),
    mig_velero_s3_url: text(v.s3_url),
    mig_velero_azure_subscription_id: text(v.azure_subscription_id),
    mig_velero_azure_tenant_id: text(v.azure_tenant_id),
    mig_velero_azure_resource_group: text(v.azure_resource_group),
    mig_velero_azure_storage_account: text(v.azure_storage_account),
    mig_velero_namespaces: list(v.namespaces),
    mig_velero_backup_name: text(v.backup_name, 'app'),
    mig_velero_schedule_cron: text(v.schedule, '0 */6 * * *'),
    mig_velero_restore_from: text(v.restore_from),
    mig_velero_resource_modifiers: text(v.resource_modifiers),
    mig_velero_kubeconfig: text(v.kubeconfig),
    mig_velero_kube_context: text(v.kube_context),
    mig_velero_version: text(v.version, '1.17.0'),
    mig_velero_plugin_version: text(v.plugin_version, 'v1.13.0'),
  }),
  vaults: {
    vault_velero_access_key_id: 'Access key ID for the backup bucket (AWS, OCI customer secret key, or the S3-compatible store)',
    vault_velero_secret_access_key: 'its secret access key',
    vault_velero_azure_client_id: 'Client ID of the Azure service principal Velero uses',
    vault_velero_azure_client_secret: 'its client secret',
    vault_velero_gcp_credentials_json: 'The Google Cloud (GCP) service account key (JSON) Velero uses',
  },
  vaultsFor: (v: TemplateValues) => VAULTS_BY_PROVIDER[text(v.provider, 'aws')] ?? [],
});
