/**
 * What the three pipeline flavours share (addendum A.10.11): the stacks they
 * deploy, in promotion order; the CI variables and secrets they read; and the
 * scripts under `ci/scripts/` every flavour calls, so the Terraform, Ansible
 * and Packer steps are the same text whichever CI runs them.
 *
 *   ci/scripts/terraform.sh   init with the stack's state key, then check,
 *                             plan or apply (apply applies the plan it made);
 *   ci/scripts/cloud-auth.sh  sourced: signs in to a cloud from the CI's OIDC
 *                             token file (GitLab CI, Azure DevOps), or, for
 *                             OCI, from the API key secret / instance principal;
 *   ci/scripts/ansible.sh     the site, limited to one environment on one
 *                             platform, with the vault password and SSH key on
 *                             tmpfs for the run only;
 *   ci/scripts/packer.sh      validate or build the golden images, and write
 *                             the image ids as `images/<p>.auto.tfvars.json`.
 *
 * Credentials: AWS, Azure and Google Cloud (GCP) are OIDC federation only; no
 * cloud key is stored anywhere. OCI has no OIDC federation for the Terraform
 * provider and the CLI (verify), so it takes its documented alternatives: an
 * API signing key held as a CI secret and written to a 0600 file for the run,
 * or instance principal on a runner inside OCI.
 */

import { info, warning, type Finding } from '../../../core/findings.ts';
import { DYNAMIC_FILES } from '../generate/inventory.ts';
import { sensitiveVariables } from '../generate/terraform.ts';
import { PLATFORM_LABELS, PLATFORM_VALUES } from '../options.ts';
import type { Env, Platform } from '../types.ts';
import { STATE_VARIABLES, type CiVariable } from './backend-bootstrap.ts';
import { isNonprod, planSlug, PROMOTION_ORDER, type DeployStack } from './environments.ts';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type CiFlavour = 'github-actions' | 'azure-devops' | 'gitlab-ci';
export type OciAuth = 'api-key' | 'instance-principal';

/** What a pipeline is generated from. */
export interface CiOptions {
  readonly planId: string;
  /** Every stack the pipeline plans and applies. */
  readonly stacks: readonly DeployStack[];
  /** The Packer templates (`images/*.pkr.hcl`), from packerFiles. */
  readonly images?: readonly { readonly file: string; readonly platform: Platform }[];
  /**
   * The project's files: the stacks' sensitive variables (supplied as
   * TF_VAR_<name> from CI secrets) and backends are read from them, and the
   * Ansible step is added when `ansible/site.yml` is there.
   */
  readonly files?: Readonly<Record<string, string>>;
  /** OCI sign-in. Default `api-key`. */
  readonly ociAuth?: OciAuth;
  /** Terraform CLI version. Default 1.13.0 (S3 native locking needs 1.10, the oci backend 1.12). */
  readonly terraformVersion?: string;
  /** Packer CLI version. Default 1.16.1. */
  readonly packerVersion?: string;
  /**
   * Where the Ansible step runs: a runner that can reach the VMs (a
   * self-hosted runner / agent in the landing zone). Default `self-hosted`.
   */
  readonly ansibleRunner?: string;
}

export interface CiOutput {
  readonly files: Record<string, string>;
  readonly findings: Finding[];
}

export const DEFAULT_TERRAFORM = '1.13.0';
export const DEFAULT_PACKER = '1.16.1';

// ---------------------------------------------------------------------------
// The stack model the flavours render
// ---------------------------------------------------------------------------

/** Deploy order: dev, test, preprod, prod, then dr. */
export const DEPLOY_ORDER: readonly Env[] = [...PROMOTION_ORDER, 'dr'];

export interface CiStack extends DeployStack {
  /** A job-safe id: `aws-dev-apps`. */
  readonly id: string;
  /** The sensitive variables the stack declares. */
  readonly secrets: readonly string[];
}

export interface CiModel {
  readonly plan: string;
  readonly stacks: readonly CiStack[];
  /** The environments in deploy order, each with its stacks. */
  readonly waves: readonly { readonly env: Env; readonly stacks: readonly CiStack[] }[];
  readonly platforms: readonly Platform[];
  readonly ansible: boolean;
  readonly images: readonly { readonly file: string; readonly platform: Platform }[];
  readonly ociAuth: OciAuth;
  readonly terraformVersion: string;
  readonly packerVersion: string;
  readonly ansibleRunner: string;
  readonly findings: Finding[];
}

const jobId = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function ciModel(options: CiOptions): CiModel {
  const findings: Finding[] = [];
  const files = options.files ?? {};
  const stacks: CiStack[] = options.stacks.map((s) => ({
    ...s,
    id: jobId(`${s.platform}-${s.env}-${s.name}`),
    secrets: sensitiveVariables(files[`${s.dir}/variables.tf`] ?? ''),
  }));
  const ids = new Set<string>();
  for (const s of stacks) {
    if (ids.has(s.id)) findings.push(warning('plan.build.ci-duplicate-stack', `${s.dir}: another stack has the same platform, environment and name (${s.id}); their state keys would collide.`));
    ids.add(s.id);
    if (s.backend === 'oci' && /backend\s+"http"/.test(files[`${s.dir}/versions.tf`] ?? '')) {
      findings.push(warning('plan.build.ci-oci-http-backend', `${s.dir}: versions.tf declares the http backend for OCI; the pipeline and backend-bootstrap use the native oci backend (Terraform 1.12). Change the stack's backend block to \`backend "oci" {}\`.`, {
        source: 'https://developer.hashicorp.com/terraform/language/backend/oci',
      }));
    }
    if (s.platform === 'vmware') {
      findings.push(info('plan.build.ci-vcf-runner', `${s.dir}: the VCF stack runs on a self-hosted runner that reaches vCenter; hosted runners cannot.`));
    }
  }
  const waves = DEPLOY_ORDER.map((env) => ({ env, stacks: stacks.filter((s) => s.env === env) })).filter((w) => w.stacks.length > 0);
  const platforms = PLATFORM_VALUES.filter((p) => stacks.some((s) => s.platform === p) || (options.images ?? []).some((i) => i.platform === p));
  if (platforms.includes('oci')) {
    findings.push(info('plan.build.ci-oci-auth', (options.ociAuth ?? 'api-key') === 'api-key'
      ? 'OCI has no OIDC federation for Terraform or the CLI, so the pipeline signs in with an API signing key held as a CI secret (OCI_API_PRIVATE_KEY), written to a 0600 file for the run and removed after it. A runner inside OCI can use instance principal instead (ociAuth: instance-principal).'
      : 'OCI: the pipeline signs in with instance principal, so its runner must be an OCI instance in a dynamic group with the policies the stacks need.', {
      source: 'https://docs.oracle.com/en-us/iaas/Content/API/Concepts/apisigningkey.htm',
    }));
  }
  return {
    plan: planSlug(options.planId),
    stacks,
    waves,
    platforms,
    ansible: !!files['ansible/site.yml'],
    images: options.images ?? [],
    ociAuth: options.ociAuth ?? 'api-key',
    terraformVersion: options.terraformVersion ?? DEFAULT_TERRAFORM,
    packerVersion: options.packerVersion ?? DEFAULT_PACKER,
    ansibleRunner: options.ansibleRunner ?? 'self-hosted',
    findings,
  };
}

// ---------------------------------------------------------------------------
// The variables and secrets
// ---------------------------------------------------------------------------

/**
 * The sign-in variables per platform. None of the AWS, Azure or Google ones
 * is a secret: they name a role or an identity the OIDC token is exchanged
 * for. Set them per environment (GitHub environment variables, GitLab
 * environment-scoped variables, Azure DevOps variable groups per stage) to
 * give each environment its own identity; repository-level values are what
 * the plan jobs use.
 */
export const AUTH_VARIABLES: Readonly<Record<Platform, readonly CiVariable[]>> = {
  aws: [{ name: 'AWS_ROLE_ARN', secret: false, description: 'The IAM role the OIDC token assumes (trust: the CI\'s issuer and this repository).' }],
  azure: [
    { name: 'AZURE_CLIENT_ID', secret: false, description: 'The client id of the user-assigned managed identity or app registration with the federated credential.' },
    { name: 'AZURE_TENANT_ID', secret: false, description: 'The Entra ID tenant.' },
    { name: 'AZURE_SUBSCRIPTION_ID', secret: false, description: 'The subscription the stacks apply to.' },
  ],
  google: [
    { name: 'GCP_WORKLOAD_IDENTITY_PROVIDER', secret: false, description: 'projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>.' },
    { name: 'GCP_SERVICE_ACCOUNT', secret: false, description: 'The service account the federated identity impersonates.' },
  ],
  oci: [
    { name: 'OCI_TENANCY_OCID', secret: false, description: 'The tenancy.' },
    { name: 'OCI_USER_OCID', secret: false, description: 'The API user (api-key sign-in).' },
    { name: 'OCI_FINGERPRINT', secret: false, description: 'The API key fingerprint (api-key sign-in).' },
    { name: 'OCI_API_PRIVATE_KEY', secret: true, description: 'The API signing private key, PEM (api-key sign-in). Rotate it; OCI has no OIDC federation here.' },
  ],
  vmware: [
    { name: 'VSPHERE_USER', secret: true, description: 'The vCenter account the VCF stack applies with.' },
    { name: 'VSPHERE_PASSWORD', secret: true, description: 'Its password.' },
  ],
};

export const ANSIBLE_SECRETS: readonly CiVariable[] = [
  { name: 'ANSIBLE_VAULT_PASSWORD', secret: true, description: 'The ansible-vault password for inventory/group_vars/all/vault.yml.' },
  { name: 'ANSIBLE_SSH_PRIVATE_KEY', secret: true, description: 'The private key of the ansible user (its public key is the stacks\' ssh_public_key).' },
];

/** The audience each cloud expects in the CI's OIDC token. */
export const OIDC_AUDIENCE: Readonly<Partial<Record<Platform, string>>> = {
  aws: 'sts.amazonaws.com',
  azure: 'api://AzureADTokenExchange',
  // Google Cloud: the provider's own resource name, https://iam.googleapis.com/<GCP_WORKLOAD_IDENTITY_PROVIDER>.
};

export function variablesFor(model: CiModel): { vars: CiVariable[]; secrets: CiVariable[] } {
  const all: CiVariable[] = [];
  for (const p of model.platforms) {
    for (const v of AUTH_VARIABLES[p]) {
      if (p === 'oci' && model.ociAuth === 'instance-principal' && v.name !== 'OCI_TENANCY_OCID') continue;
      all.push(v);
    }
  }
  const backends = new Set(model.stacks.map((s) => s.backend));
  for (const k of ['s3', 'azurerm', 'gcs', 'oci'] as const) if (backends.has(k)) all.push(...STATE_VARIABLES[k]);
  if (model.images.some((i) => i.platform === 'aws') && !all.some((v) => v.name === 'AWS_REGION')) all.push(STATE_VARIABLES.s3[2]!);
  if (model.images.some((i) => i.platform === 'oci') && !all.some((v) => v.name === 'OCI_REGION')) all.push(STATE_VARIABLES.oci[2]!);
  if (model.ansible) all.push(...ANSIBLE_SECRETS);
  for (const s of model.stacks) for (const name of s.secrets) all.push({ name: `TF_VAR_${name}`, secret: true, description: `${s.dir}: the sensitive variable ${name}.` });
  const seen = new Set<string>();
  const unique = all.filter((v) => (seen.has(v.name) ? false : (seen.add(v.name), true)));
  return { vars: unique.filter((v) => !v.secret), secrets: unique.filter((v) => v.secret) };
}

// ---------------------------------------------------------------------------
// The scripts
// ---------------------------------------------------------------------------

function terraformScript(plan: string): string {
  return `#!/usr/bin/env bash
# terraform.sh <backend> <platform> <env> <dir> <stack> <check|plan|apply>
#
#   check  terraform fmt -check and validate
#   plan   a saved plan (tfplan) for review
#   apply  a fresh plan, then apply exactly that plan
#
# The state key is <plan>/<platform>/<env>/<stack>.tfstate in the platform's
# store (backend-bootstrap/); the store comes from the CI variables below.
# Sensitive variables arrive as TF_VAR_<name> from the CI's secrets.
set -euo pipefail

backend="$1"; platform="$2"; env="$3"; dir="$4"; stack="$5"; action="$6"
plan_id="\${PLAN_ID:-${plan}}"
key="\${plan_id}/\${platform}/\${env}/\${stack}.tfstate"
root="$(pwd)"
export TF_IN_AUTOMATION=1 TF_INPUT=0

cfg=()
case "$backend" in
  s3)
    cfg+=(-backend-config="bucket=\${TF_STATE_BUCKET_AWS:?set TF_STATE_BUCKET_AWS}" -backend-config="key=$key")
    cfg+=(-backend-config="region=\${AWS_REGION:?set AWS_REGION}" -backend-config="encrypt=true" -backend-config="use_lockfile=true")
    cfg+=(-backend-config="use_dualstack_endpoint=true")
    if [ -n "\${TF_STATE_KMS_KEY_AWS:-}" ]; then cfg+=(-backend-config="kms_key_id=$TF_STATE_KMS_KEY_AWS"); fi
    ;;
  azurerm)
    cfg+=(-backend-config="resource_group_name=\${TF_STATE_RESOURCE_GROUP_AZURE:?set TF_STATE_RESOURCE_GROUP_AZURE}")
    cfg+=(-backend-config="storage_account_name=\${TF_STATE_ACCOUNT_AZURE:?set TF_STATE_ACCOUNT_AZURE}")
    cfg+=(-backend-config="container_name=tfstate" -backend-config="key=$key" -backend-config="use_azuread_auth=true")
    ;;
  gcs)
    cfg+=(-backend-config="bucket=\${TF_STATE_BUCKET_GCP:?set TF_STATE_BUCKET_GCP}" -backend-config="prefix=\${key%.tfstate}")
    ;;
  oci)
    cfg+=(-backend-config="bucket=\${TF_STATE_BUCKET_OCI:?set TF_STATE_BUCKET_OCI}" -backend-config="namespace=\${TF_STATE_NAMESPACE_OCI:?set TF_STATE_NAMESPACE_OCI}")
    cfg+=(-backend-config="key=$key" -backend-config="region=\${OCI_REGION:?set OCI_REGION}")
    ;;
  local)
    echo "::warning::$dir keeps local state, which this run throws away. Choose a remote backend." >&2
    ;;
esac

vars=()
if [ -f "$root/images/$platform.auto.tfvars.json" ]; then vars+=(-var-file="$root/images/$platform.auto.tfvars.json"); fi

terraform -chdir="$dir" init -input=false \${cfg[@]+"\${cfg[@]}"}
case "$action" in
  check)
    terraform -chdir="$dir" fmt -check -recursive
    terraform -chdir="$dir" validate
    ;;
  plan)
    terraform -chdir="$dir" plan -input=false -lock-timeout=10m \${vars[@]+"\${vars[@]}"} -out=tfplan
    ;;
  apply)
    terraform -chdir="$dir" plan -input=false -lock-timeout=10m \${vars[@]+"\${vars[@]}"} -out=tfplan
    terraform -chdir="$dir" apply -input=false -lock-timeout=10m tfplan
    ;;
  *)
    echo "unknown action: $action" >&2
    exit 2
    ;;
esac
`;
}

function cloudAuthScript(): string {
  return `#!/usr/bin/env bash
# Source it:  . ci/scripts/cloud-auth.sh <platform>
#
# GitLab CI and Azure DevOps: OIDC_TOKEN_FILE holds the CI's OIDC token for
# the cloud's audience; it is exchanged by the provider itself, so no cloud key
# exists anywhere. (GitHub Actions signs in with the providers' own actions.)
#
# OCI has no OIDC federation for Terraform or the CLI: OCI_AUTH=api-key writes
# the API signing key from the CI secret to a 0600 file for this run only;
# OCI_AUTH=instance_principal uses the runner's own identity.
_atk_platform="$1"
_atk_tmp="$(mktemp -d)"
chmod 700 "$_atk_tmp"
trap 'rm -rf "$_atk_tmp"' EXIT

case "$_atk_platform" in
  aws)
    if [ -n "\${OIDC_TOKEN_FILE:-}" ]; then
      export AWS_WEB_IDENTITY_TOKEN_FILE="$OIDC_TOKEN_FILE"
      export AWS_ROLE_ARN="\${AWS_ROLE_ARN:?set AWS_ROLE_ARN}"
      export AWS_ROLE_SESSION_NAME="ci-\${CI_JOB_ID:-\${BUILD_BUILDID:-run}}"
    fi
    export AWS_REGION="\${AWS_REGION:?set AWS_REGION}"
    export AWS_USE_DUALSTACK_ENDPOINT=true
    ;;
  azure)
    export ARM_CLIENT_ID="\${AZURE_CLIENT_ID:?set AZURE_CLIENT_ID}"
    export ARM_TENANT_ID="\${AZURE_TENANT_ID:?set AZURE_TENANT_ID}"
    export ARM_SUBSCRIPTION_ID="\${AZURE_SUBSCRIPTION_ID:?set AZURE_SUBSCRIPTION_ID}"
    export ARM_USE_OIDC=true
    if [ -n "\${OIDC_TOKEN_FILE:-}" ]; then
      export ARM_OIDC_TOKEN_FILE_PATH="$OIDC_TOKEN_FILE"
      if command -v az >/dev/null 2>&1; then
        az login --service-principal -u "$ARM_CLIENT_ID" -t "$ARM_TENANT_ID" --federated-token "$(cat "$OIDC_TOKEN_FILE")" --output none
        az account set --subscription "$ARM_SUBSCRIPTION_ID"
      fi
    fi
    ;;
  google)
    if [ -n "\${OIDC_TOKEN_FILE:-}" ]; then
      provider="\${GCP_WORKLOAD_IDENTITY_PROVIDER:?set GCP_WORKLOAD_IDENTITY_PROVIDER}"
      account="\${GCP_SERVICE_ACCOUNT:?set GCP_SERVICE_ACCOUNT}"
      cat > "$_atk_tmp/gcp-federation.json" <<JSON
{
  "type": "external_account",
  "audience": "//iam.googleapis.com/$provider",
  "subject_token_type": "urn:ietf:params:oauth:token-type:jwt",
  "token_url": "https://sts.googleapis.com/v1/token",
  "service_account_impersonation_url": "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/$account:generateAccessToken",
  "credential_source": { "file": "$OIDC_TOKEN_FILE" }
}
JSON
      export GOOGLE_APPLICATION_CREDENTIALS="$_atk_tmp/gcp-federation.json"
      export CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE="$GOOGLE_APPLICATION_CREDENTIALS"
    fi
    ;;
  oci)
    if [ "\${OCI_AUTH:-api-key}" = "instance_principal" ] || [ "\${OCI_AUTH:-}" = "instance-principal" ]; then
      export OCI_CLI_AUTH=instance_principal
    else
      umask 077
      mkdir -p "$HOME/.oci"
      printf '%s\\n' "\${OCI_API_PRIVATE_KEY:?set the OCI_API_PRIVATE_KEY secret}" > "$_atk_tmp/oci_api_key.pem"
      cat > "$HOME/.oci/config" <<CFG
[DEFAULT]
user=\${OCI_USER_OCID:?set OCI_USER_OCID}
fingerprint=\${OCI_FINGERPRINT:?set OCI_FINGERPRINT}
tenancy=\${OCI_TENANCY_OCID:?set OCI_TENANCY_OCID}
region=\${OCI_REGION:?set OCI_REGION}
key_file=$_atk_tmp/oci_api_key.pem
CFG
      trap 'rm -rf "$_atk_tmp" "$HOME/.oci/config"' EXIT
    fi
    ;;
  vmware)
    : "\${VSPHERE_USER:?set the VSPHERE_USER secret}" "\${VSPHERE_PASSWORD:?set the VSPHERE_PASSWORD secret}"
    export TF_VAR_vsphere_user="$VSPHERE_USER" TF_VAR_vsphere_password="$VSPHERE_PASSWORD"
    ;;
esac
`;
}

function ansibleScript(): string {
  const inv = Object.entries(DYNAMIC_FILES).map(([p, f]) => `  ${p}) dynamic="${f}" ;;`).join('\n');
  return `#!/usr/bin/env bash
# ansible.sh <platform> <env>
#
# Runs the site on one environment of one platform, after its stacks have
# applied. The vault password and the SSH key come from CI secrets and live on
# tmpfs for this run only.
set -euo pipefail
platform="$1"; env="$2"

shm="$(mktemp -d -p /dev/shm 2>/dev/null || mktemp -d)"
chmod 700 "$shm"
trap 'rm -rf "$shm"' EXIT
umask 077
printf '%s\\n' "\${ANSIBLE_VAULT_PASSWORD:?set the ANSIBLE_VAULT_PASSWORD secret}" > "$shm/vault-password"
printf '%s\\n' "\${ANSIBLE_SSH_PRIVATE_KEY:?set the ANSIBLE_SSH_PRIVATE_KEY secret}" > "$shm/id_ansible"
export ANSIBLE_VAULT_PASSWORD_FILE="$shm/vault-password"
export ANSIBLE_PRIVATE_KEY_FILE="$shm/id_ansible"

dynamic=""
case "$platform" in
${inv}
  vmware) dynamic="inventory/hosts_vmware.yml" ;;
esac

if ! command -v ansible-playbook >/dev/null 2>&1; then
  python3 -m venv "$shm/venv"
  . "$shm/venv/bin/activate"
  pip install --quiet ansible-core pywinrm
fi
case "$platform" in
  aws) pip install --quiet boto3 botocore ;;
  google) pip install --quiet google-auth requests ;;
  oci) pip install --quiet oci ;;
esac

cd ansible
ansible-galaxy install -r requirements.yml
if [ "$platform" = "azure" ]; then
  pip install --quiet -r "$HOME/.ansible/collections/ansible_collections/azure/azcollection/requirements.txt"
fi
inventories=(-i inventory/hosts.yml)
if [ -n "$dynamic" ] && [ -f "$dynamic" ]; then inventories+=(-i "$dynamic"); fi
ansible-playbook "\${inventories[@]}" site.yml --limit "env_\${env}:&platform_\${platform}"
`;
}

function packerScript(): string {
  return `#!/usr/bin/env bash
# packer.sh <validate|build> <platform> [template ...]
#
#   validate  packer init, fmt -check and validate each template
#   build     build each template, then write the image ids from
#             images/manifest.json to images/<platform>.auto.tfvars.json,
#             which ci/scripts/terraform.sh passes to that platform's stacks
#
# Images are versioned by the commit (image_version), never by the clock.
set -euo pipefail
action="$1"; platform="$2"; shift 2
templates=("$@")
if [ \${#templates[@]} -eq 0 ]; then
  mapfile -t templates < <(ls images/*-"$platform".pkr.hcl 2>/dev/null || true)
fi
[ \${#templates[@]} -gt 0 ] || { echo "no templates for $platform"; exit 0; }
version="\${IMAGE_VERSION:-$(git rev-parse --short=12 HEAD)}"

for t in "\${templates[@]}"; do
  packer init "$t"
  case "$action" in
    validate)
      packer fmt -check "$t"
      only=()
      # The OCI builder signs in while it validates; without a sign-in, check the syntax only.
      if [ "$platform" = oci ] && [ ! -f "$HOME/.oci/config" ] && [ "\${OCI_AUTH:-api-key}" = api-key ]; then only=(-syntax-only); fi
      packer validate \${only[@]+"\${only[@]}"} -var-file="images/$platform.pkrvars.hcl" -var "image_version=$version" "$t"
      ;;
    build)
      packer build -var-file="images/$platform.pkrvars.hcl" -var "image_version=$version" "$t"
      ;;
  esac
done

if [ "$action" = "build" ] && [ -f images/manifest.json ]; then
  jq --arg p "$platform" '
    [ .builds[] | select(.custom_data.platform == $p)
      | { key: .custom_data.variable,
          value: (.artifact_id | split(",")[0] | if test("^[a-z0-9-]+:ami-") then sub("^[a-z0-9-]+:"; "") else . end) } ]
    | from_entries' images/manifest.json > "images/$platform.auto.tfvars.json"
  echo "Image ids for $platform:"; cat "images/$platform.auto.tfvars.json"
fi
`;
}

function installScript(): string {
  return `#!/usr/bin/env bash
# install-tools.sh <terraform|packer> <version>
# Installs a HashiCorp CLI from releases.hashicorp.com after checking its SHA256.
set -euo pipefail
tool="$1"; version="$2"
arch="$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')"
zip="\${tool}_\${version}_linux_\${arch}.zip"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/$zip" "https://releases.hashicorp.com/$tool/$version/$zip"
curl -fsSL -o "$tmp/sums" "https://releases.hashicorp.com/$tool/$version/\${tool}_\${version}_SHA256SUMS"
(cd "$tmp" && grep " $zip\\$" sums | sha256sum -c -)
dest="\${TOOLS_DIR:-$HOME/.local/bin}"
mkdir -p "$dest"
unzip -o -q "$tmp/$zip" -d "$dest"
"$dest/$tool" version
`;
}

// ---------------------------------------------------------------------------
// The README
// ---------------------------------------------------------------------------

const SETUP: Readonly<Record<CiFlavour, Readonly<Partial<Record<Platform, string>>>>> = {
  'github-actions': {
    aws: 'An IAM OIDC provider for `token.actions.githubusercontent.com` (audience `sts.amazonaws.com`) and a role per environment trusting `repo:<owner>/<repo>:environment:<env>`; a read-only role trusting `repo:<owner>/<repo>:pull_request` for the plan jobs. https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services',
    azure: 'A user-assigned managed identity (or app registration) per environment with a federated credential for issuer `https://token.actions.githubusercontent.com`, subject `repo:<owner>/<repo>:environment:<env>` (and `:pull_request` for plan). https://learn.microsoft.com/en-us/azure/developer/github/connect-from-azure-openid-connect',
    google: 'A workload identity pool with an OIDC provider for `https://token.actions.githubusercontent.com`, an attribute condition on `assertion.repository`, and a service account the principal set may impersonate. https://github.com/google-github-actions/auth#preferred-direct-workload-identity-federation',
  },
  'gitlab-ci': {
    aws: 'An IAM OIDC provider for your GitLab URL (audience `sts.amazonaws.com`) and a role trusting `project_path:<group>/<project>:ref_type:branch:ref:main` (and the merge-request refs for plan). https://docs.gitlab.com/ci/cloud_services/aws/',
    azure: 'A managed identity or app registration with a federated credential for issuer `https://gitlab.com` (your GitLab URL), subject `project_path:<group>/<project>:ref_type:branch:ref:main`. https://docs.gitlab.com/ci/cloud_services/azure/',
    google: 'A workload identity pool with an OIDC provider for your GitLab URL and an attribute condition on `assertion.project_path`. https://docs.gitlab.com/ci/cloud_services/google_cloud/',
  },
  'azure-devops': {
    aws: 'An IAM OIDC provider for `https://vstoken.dev.azure.com/<organization id>` (audience `api://AzureADTokenExchange`) and a role trusting `sc://<organization>/<project>/<service connection>` (verify the claim format). https://learn.microsoft.com/en-us/azure/devops/pipelines/release/configure-workload-identity',
    azure: 'An Azure Resource Manager service connection using workload identity federation, named in the `azureServiceConnection` parameter. https://learn.microsoft.com/en-us/azure/devops/pipelines/library/connect-to-azure',
    google: 'A workload identity pool with an OIDC provider for `https://vstoken.dev.azure.com/<organization id>` (verify), the token requested through the `federationServiceConnection` parameter. https://cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines',
  },
};

export function ciReadme(flavour: CiFlavour, model: CiModel, file: string, protection: string): string {
  const { vars, secrets } = variablesFor(model);
  const setup = SETUP[flavour];
  return [
    `# Pipeline (${flavour})`,
    '',
    `\`${file}\`: every stack is planned on a pull / merge request, and applied on \`main\` environment by environment, ${model.waves.map((w) => w.env).join(' → ')}, each behind its environment's protection (${protection}). Nothing waits on a manual flag: a merge to main applies.`,
    '',
    '## Stacks',
    '',
    '| Environment | Platform | Folder | State key |',
    '|---|---|---|---|',
    ...model.stacks.map((s) => `| ${s.env}${isNonprod(s.env) ? '' : ' (prod)'} | ${PLATFORM_LABELS[s.platform]} | \`${s.dir}\` | \`${model.plan}/${s.platform}/${s.env}/${s.name}.tfstate\` |`),
    '',
    '## Signing in: no stored cloud keys',
    '',
    ...model.platforms.filter((p) => setup[p]).map((p) => `- ${PLATFORM_LABELS[p]}: OIDC federation. ${setup[p]}`),
    ...(model.platforms.includes('oci')
      ? [`- OCI: no OIDC federation exists for Terraform or the CLI (verify), so ${model.ociAuth === 'api-key' ? 'an API signing key is held as the secret `OCI_API_PRIVATE_KEY` and written to a 0600 file for each run (rotate it; https://docs.oracle.com/en-us/iaas/Content/API/Concepts/apisigningkey.htm)' : 'the runner is an OCI instance using instance principal (https://docs.oracle.com/en-us/iaas/Content/Identity/Tasks/callingservicesfrominstances.htm)'}.`]
      : []),
    ...(model.platforms.includes('vmware') ? ['- VCF: the vCenter account is the secrets `VSPHERE_USER` / `VSPHERE_PASSWORD`, on a self-hosted runner that reaches vCenter.'] : []),
    '',
    '## Variables (not secret)',
    '',
    ...vars.map((v) => `- \`${v.name}\`: ${v.description}`),
    '',
    '## Secrets',
    '',
    ...(secrets.length > 0 ? secrets.map((v) => `- \`${v.name}\`: ${v.description}`) : ['None.']),
    '',
    'The state store variables are the `ci_variables` output of `backend-bootstrap/<platform>/`; apply that first.',
    ...(model.ansible ? ['', `The Ansible step runs on \`${model.ansibleRunner}\`: a runner that reaches the VMs' management addresses.`] : []),
    ...(model.images.length > 0
      ? ['', '## Golden images', '', 'The Packer templates in `images/` are validated on every pull / merge request and built on `main` when `images/` or `ansible/roles/` change. The build writes `images/<platform>.auto.tfvars.json`; commit it to promote the new images through the environments like any other change.']
      : []),
    '',
  ].join('\n');
}

/** The scripts every flavour calls. */
export function ciScripts(model: CiModel): Record<string, string> {
  const files: Record<string, string> = {
    'ci/scripts/terraform.sh': terraformScript(model.plan),
    'ci/scripts/cloud-auth.sh': cloudAuthScript(),
    'ci/scripts/install-tools.sh': installScript(),
  };
  if (model.ansible) files['ci/scripts/ansible.sh'] = ansibleScript();
  if (model.images.length > 0) files['ci/scripts/packer.sh'] = packerScript();
  return files;
}

/** Platforms of the images, in order. */
export const imagePlatforms = (model: CiModel): Platform[] => PLATFORM_VALUES.filter((p) => model.images.some((i) => i.platform === p));
