/**
 * GitHub Actions (addendum A.10.11): `.github/workflows/infra.yml` and, when
 * there are golden images, `.github/workflows/images.yml`.
 *
 *   pull_request → main   every stack: fmt -check, validate, plan
 *   push to main           apply, one job per environment in promotion order
 *                          (dev → test → preprod → prod → dr), each with
 *                          `environment: <env>`, so the environment's
 *                          protection rules (required reviewers, wait timer,
 *                          branch policy) are the promotion gate; then the
 *                          Ansible site on that environment
 *
 * Signing in is OIDC federation only (`id-token: write`):
 * aws-actions/configure-aws-credentials with `role-to-assume`, azure/login
 * with client, tenant and subscription ids, google-github-actions/auth with
 * `workload_identity_provider`. No cloud key is a secret. OCI has no OIDC
 * federation for Terraform, so it signs in from an API key secret written to a
 * 0600 file for the run, or instance principal (ci/scripts/cloud-auth.sh).
 */

import type { Platform } from '../types.ts';
import { ciModel, ciReadme, ciScripts, imagePlatforms, variablesFor, type CiModel, type CiOptions, type CiOutput, type CiStack } from './ci-common.ts';

/** Action versions (major tags; pin to commit SHAs in your fork if your policy asks for it). */
export const GITHUB_ACTIONS = {
  checkout: 'actions/checkout@v4',
  terraform: 'hashicorp/setup-terraform@v3',
  packer: 'hashicorp/setup-packer@v3',
  aws: 'aws-actions/configure-aws-credentials@v4',
  azure: 'azure/login@v2',
  google: 'google-github-actions/auth@v2',
  upload: 'actions/upload-artifact@v4',
} as const;

const e = (expr: string): string => `\${{ ${expr} }}`;
const q = (s: string): string => (/^[A-Za-z0-9_./@-]+$/.test(s) && !/^(true|false|yes|no|on|off|null|\d.*)$/i.test(s) ? s : `'${s.replace(/'/g, "''")}'`);

function runnerFor(platform: Platform): string {
  return platform === 'vmware' ? 'self-hosted' : 'ubuntu-latest';
}

/** The sign-in steps for the platforms a job's matrix can hold. */
function signIn(platforms: readonly Platform[], ind: string, cond: (p: Platform) => string): string[] {
  const out: string[] = [];
  if (platforms.includes('aws')) {
    out.push(
      `${ind}- name: Sign in to AWS (OIDC)`,
      `${ind}  if: ${cond('aws')}`,
      `${ind}  uses: ${GITHUB_ACTIONS.aws}`,
      `${ind}  with:`,
      `${ind}    role-to-assume: ${e('vars.AWS_ROLE_ARN')}`,
      `${ind}    aws-region: ${e('vars.AWS_REGION')}`,
    );
  }
  if (platforms.includes('azure')) {
    out.push(
      `${ind}- name: Sign in to Azure (OIDC)`,
      `${ind}  if: ${cond('azure')}`,
      `${ind}  uses: ${GITHUB_ACTIONS.azure}`,
      `${ind}  with:`,
      `${ind}    client-id: ${e('vars.AZURE_CLIENT_ID')}`,
      `${ind}    tenant-id: ${e('vars.AZURE_TENANT_ID')}`,
      `${ind}    subscription-id: ${e('vars.AZURE_SUBSCRIPTION_ID')}`,
    );
  }
  if (platforms.includes('google')) {
    out.push(
      `${ind}- name: Sign in to Google Cloud (OIDC)`,
      `${ind}  if: ${cond('google')}`,
      `${ind}  uses: ${GITHUB_ACTIONS.google}`,
      `${ind}  with:`,
      `${ind}    workload_identity_provider: ${e('vars.GCP_WORKLOAD_IDENTITY_PROVIDER')}`,
      `${ind}    service_account: ${e('vars.GCP_SERVICE_ACCOUNT')}`,
    );
  }
  return out;
}

/** The job-level env: every variable and secret the jobs read. */
function jobEnv(model: CiModel, ind: string): string[] {
  const { vars, secrets } = variablesFor(model);
  const lines = [
    ...vars.map((v) => `${ind}  ${v.name}: ${e(`vars.${v.name}`)}`),
    ...secrets.filter((s) => !s.name.startsWith('ANSIBLE_')).map((s) => `${ind}  ${s.name}: ${e(`secrets.${s.name.toUpperCase()}`)}`),
  ];
  if (model.platforms.includes('oci')) lines.push(`${ind}  OCI_AUTH: ${model.ociAuth}`);
  return lines.length > 0 ? [`${ind}env:`, ...lines] : [];
}

function matrix(stacks: readonly CiStack[], ind: string): string[] {
  const out = [`${ind}strategy:`, `${ind}  fail-fast: false`, `${ind}  matrix:`, `${ind}    include:`];
  for (const s of stacks) {
    out.push(
      `${ind}      - id: ${q(s.id)}`,
      `${ind}        platform: ${s.platform}`,
      `${ind}        env: ${s.env}`,
      `${ind}        dir: ${q(s.dir)}`,
      `${ind}        stack: ${q(s.name)}`,
      `${ind}        backend: ${s.backend}`,
      `${ind}        runner: ${runnerFor(s.platform)}`,
    );
  }
  return out;
}

function terraformSteps(model: CiModel, platforms: readonly Platform[], actions: readonly string[]): string[] {
  const ind = '      ';
  return [
    `${ind}- uses: ${GITHUB_ACTIONS.checkout}`,
    `${ind}- uses: ${GITHUB_ACTIONS.terraform}`,
    `${ind}  with:`,
    `${ind}    terraform_version: ${model.terraformVersion}`,
    `${ind}    terraform_wrapper: false`,
    ...signIn(platforms, ind, (p) => `matrix.platform == '${p}'`),
    `${ind}- name: Terraform ${actions.join(' and ')}`,
    `${ind}  env:`,
    `${ind}    BACKEND: ${e('matrix.backend')}`,
    `${ind}    PLATFORM: ${e('matrix.platform')}`,
    `${ind}    ENVIRONMENT: ${e('matrix.env')}`,
    `${ind}    DIR: ${e('matrix.dir')}`,
    `${ind}    STACK: ${e('matrix.stack')}`,
    `${ind}  run: |`,
    `${ind}    . ci/scripts/cloud-auth.sh "$PLATFORM"`,
    ...actions.map((a) => `${ind}    bash ci/scripts/terraform.sh "$BACKEND" "$PLATFORM" "$ENVIRONMENT" "$DIR" "$STACK" ${a}`),
  ];
}

function infraWorkflow(model: CiModel): string {
  const L: string[] = [
    '# Infrastructure: plan on pull requests; on main, apply environment by environment,',
    '# each behind its GitHub environment\'s protection rules. Signing in is OIDC only.',
    'name: infrastructure',
    '',
    'on:',
    '  pull_request:',
    '    branches: [main]',
    '  push:',
    '    branches: [main]',
    '',
    'permissions:',
    '  contents: read',
    '',
    'concurrency:',
    `  group: infrastructure-${e('github.ref')}`,
    '  cancel-in-progress: false',
    '',
    'env:',
    `  PLAN_ID: ${q(model.plan)}`,
    '  TF_IN_AUTOMATION: "1"',
    '  TF_INPUT: "0"',
    '',
    'jobs:',
    '  plan:',
    `    name: plan ${e('matrix.id')}`,
    "    if: github.event_name == 'pull_request'",
    `    runs-on: ${e('matrix.runner')}`,
    '    permissions:',
    '      contents: read',
    '      id-token: write',
    ...matrix(model.stacks, '    '),
    ...jobEnv(model, '    '),
    '    steps:',
    ...terraformSteps(model, model.platforms, ['check', 'plan']),
  ];

  let previous: string | undefined;
  for (const wave of model.waves) {
    const env = wave.env;
    const platforms = [...new Set(wave.stacks.map((s) => s.platform))];
    const apply = `apply-${env}`;
    L.push(
      '',
      `  ${apply}:`,
      `    name: apply ${env} ${e('matrix.id')}`,
      "    if: github.event_name == 'push' && github.ref == 'refs/heads/main'",
      ...(previous ? [`    needs: ${previous}`] : []),
      `    runs-on: ${e('matrix.runner')}`,
      `    environment: ${env}`,
      '    permissions:',
      '      contents: read',
      '      id-token: write',
      ...matrix(wave.stacks, '    '),
      ...jobEnv(model, '    '),
      '    steps:',
      ...terraformSteps(model, platforms, ['apply']),
    );
    previous = apply;
    if (model.ansible) {
      const configure = `configure-${env}`;
      L.push(
        '',
        `  ${configure}:`,
        `    name: configure ${env} ${e('matrix.platform')}`,
        `    needs: ${apply}`,
        `    runs-on: ${model.ansibleRunner}`,
        `    environment: ${env}`,
        '    permissions:',
        '      contents: read',
        '      id-token: write',
        '    strategy:',
        '      fail-fast: false',
        '      matrix:',
        `        platform: [${platforms.join(', ')}]`,
        ...jobEnv(model, '    '),
        '    steps:',
        `      - uses: ${GITHUB_ACTIONS.checkout}`,
        ...signIn(platforms, '      ', (p) => `matrix.platform == '${p}'`),
        '      - name: Ansible site',
        '        env:',
        `          PLATFORM: ${e('matrix.platform')}`,
        `          ENVIRONMENT: ${env}`,
        `          ANSIBLE_VAULT_PASSWORD: ${e('secrets.ANSIBLE_VAULT_PASSWORD')}`,
        `          ANSIBLE_SSH_PRIVATE_KEY: ${e('secrets.ANSIBLE_SSH_PRIVATE_KEY')}`,
        '        run: |',
        '          . ci/scripts/cloud-auth.sh "$PLATFORM"',
        '          bash ci/scripts/ansible.sh "$PLATFORM" "$ENVIRONMENT"',
      );
      previous = configure;
    }
  }
  return `${L.join('\n')}\n`;
}

function imagesWorkflow(model: CiModel): string {
  const platforms = imagePlatforms(model);
  const paths = "      - 'images/**'\n      - 'ansible/roles/**'";
  const steps = (action: 'validate' | 'build'): string[] => [
    `      - uses: ${GITHUB_ACTIONS.checkout}`,
    `      - uses: ${GITHUB_ACTIONS.packer}`,
    '        with:',
    `          version: ${q(model.packerVersion)}`,
    ...(action === 'build' ? signIn(platforms, '      ', (p) => `matrix.platform == '${p}'`) : []),
    ...(action === 'build' ? ['      - name: Ansible for the provisioner', '        run: python3 -m pip install --user ansible-core pywinrm'] : []),
    `      - name: Packer ${action}`,
    '        env:',
    `          PLATFORM: ${e('matrix.platform')}`,
    `          IMAGE_VERSION: ${e('github.sha')}`,
    '        run: |',
    ...(action === 'build' ? ['          . ci/scripts/cloud-auth.sh "$PLATFORM"'] : []),
    `          bash ci/scripts/packer.sh ${action} "$PLATFORM"`,
  ];
  const L = [
    '# Golden images: validated on pull requests, built on main when the templates',
    '# or the baseline roles change. The build writes images/<platform>.auto.tfvars.json;',
    '# commit it to promote the images through the environments.',
    'name: images',
    '',
    'on:',
    '  pull_request:',
    '    branches: [main]',
    '    paths:',
    paths,
    '  push:',
    '    branches: [main]',
    '    paths:',
    paths,
    '  workflow_dispatch: {}',
    '',
    'permissions:',
    '  contents: read',
    '',
    'jobs:',
    '  validate:',
    `    name: validate ${e('matrix.platform')}`,
    "    if: github.event_name == 'pull_request'",
    '    runs-on: ubuntu-latest',
    '    strategy:',
    '      fail-fast: false',
    '      matrix:',
    `        platform: [${platforms.join(', ')}]`,
    '    steps:',
    ...steps('validate'),
    '',
    '  build:',
    `    name: build ${e('matrix.platform')}`,
    "    if: github.event_name != 'pull_request'",
    `    runs-on: ${e("matrix.platform == 'vmware' && 'self-hosted' || 'ubuntu-latest'")}`,
    '    environment: images',
    '    permissions:',
    '      contents: read',
    '      id-token: write',
    '    strategy:',
    '      fail-fast: false',
    '      matrix:',
    `        platform: [${platforms.join(', ')}]`,
    ...jobEnv(model, '    ').filter((l) => !/TF_VAR_/.test(l)),
    '    steps:',
    ...steps('build'),
    `      - uses: ${GITHUB_ACTIONS.upload}`,
    '        with:',
    `          name: images-${e('matrix.platform')}`,
    '          path: |',
    '            images/manifest.json',
    `            images/${e('matrix.platform')}.auto.tfvars.json`,
  ];
  return `${L.join('\n')}\n`;
}

/** `.github/workflows/infra.yml` (and images.yml), the shared scripts, and ci/README.md. */
export function githubActionsFiles(options: CiOptions): CiOutput {
  const model = ciModel(options);
  const files: Record<string, string> = { ...ciScripts(model) };
  files['.github/workflows/infra.yml'] = infraWorkflow(model);
  if (model.images.length > 0) files['.github/workflows/images.yml'] = imagesWorkflow(model);
  files['ci/README.md'] = ciReadme('github-actions', model, '.github/workflows/infra.yml', 'the GitHub environment of the same name: add required reviewers to test, preprod and prod, and limit its deployment branches to main');
  return { files, findings: model.findings };
}

