/**
 * GitLab CI (addendum A.10.11): `.gitlab-ci.yml`.
 *
 *   merge request     every stack: fmt -check, validate, plan
 *   push to main      one deploy stage per environment in promotion order,
 *                     each job with `environment: <env>` (protect the
 *                     environments, with approvals, in the project settings),
 *                     then the Ansible site on that environment
 *
 * Signing in: `id_tokens` gives each job a GitLab OIDC token with the cloud's
 * audience; ci/scripts/cloud-auth.sh hands it to the provider (AWS web
 * identity, Azure federated credential, Google Cloud workload identity
 * federation). No cloud key is stored. OCI signs in from an API key secret or
 * instance principal: it has no OIDC federation for Terraform.
 */

import type { Platform } from '../types.ts';
import { ciModel, ciReadme, ciScripts, imagePlatforms, OIDC_AUDIENCE, variablesFor, type CiModel, type CiOptions, type CiOutput, type CiStack } from './ci-common.ts';

const TOKEN: Readonly<Partial<Record<Platform, string>>> = { aws: 'AWS_ID_TOKEN', azure: 'AZURE_ID_TOKEN', google: 'GCP_ID_TOKEN' };
const TIER: Readonly<Record<string, string>> = { dev: 'development', test: 'testing', preprod: 'staging', prod: 'production', dr: 'production' };

const IMAGE = 'ubuntu:24.04';
const APT = 'apt-get update -qq && apt-get install -y -qq --no-install-recommends bash ca-certificates curl git jq unzip python3 python3-venv python3-pip >/dev/null';

function idTokens(platform: Platform, ind: string): string[] {
  const name = TOKEN[platform];
  if (!name) return [];
  const aud = platform === 'google' ? 'https://iam.googleapis.com/${GCP_WORKLOAD_IDENTITY_PROVIDER}' : OIDC_AUDIENCE[platform]!;
  return [`${ind}id_tokens:`, `${ind}  ${name}:`, `${ind}    aud: ${aud}`];
}

/** The script lines that put the job's OIDC token in a file and sign in. */
function signIn(platform: Platform, ind: string): string[] {
  const name = TOKEN[platform];
  return [
    ...(name ? [`${ind}- export OIDC_TOKEN_FILE="$(mktemp)" && printf '%s' "$${name}" > "$OIDC_TOKEN_FILE"`] : []),
    `${ind}- . ci/scripts/cloud-auth.sh ${platform}`,
  ];
}

const runnerTags = (platform: Platform, ind: string): string[] => (platform === 'vmware' ? [`${ind}tags: [vcf]`] : []);

function stackJob(s: CiStack, kind: 'plan' | 'apply'): string[] {
  const actions = kind === 'plan' ? ['check', 'plan'] : ['apply'];
  return [
    `${kind}:${s.id}:`,
    '  extends: .terraform',
    `  stage: ${kind === 'plan' ? 'plan' : `deploy-${s.env}`}`,
    ...runnerTags(s.platform, '  '),
    ...idTokens(s.platform, '  '),
    ...(kind === 'apply'
      ? [
        '  environment:',
        `    name: ${s.env}`,
        `    deployment_tier: ${TIER[s.env] ?? 'other'}`,
        `  resource_group: ${s.id}`,
        '  rules:',
        '    - if: $CI_COMMIT_BRANCH == "main" && $CI_PIPELINE_SOURCE != "merge_request_event"',
      ]
      : ['  rules:', '    - if: $CI_PIPELINE_SOURCE == "merge_request_event"']),
    '  script:',
    ...signIn(s.platform, '    '),
    ...actions.map((a) => `    - bash ci/scripts/terraform.sh ${s.backend} ${s.platform} ${s.env} ${s.dir} ${s.name} ${a}`),
    '',
  ];
}

function pipeline(model: CiModel): string {
  const { vars } = variablesFor(model);
  const images = imagePlatforms(model);
  const stages = ['plan', ...(images.length > 0 ? ['images'] : []), ...model.waves.flatMap((w) => [`deploy-${w.env}`, ...(model.ansible ? [`configure-${w.env}`] : [])])];
  const L: string[] = [
    '# Infrastructure: plan on merge requests; on main, deploy environment by environment,',
    '# each behind its protected environment. Signing in is OIDC (id_tokens) for AWS, Azure',
    '# and Google Cloud (GCP); nothing here is a credential.',
    '#',
    `# CI/CD variables to set (not secret): ${vars.map((v) => v.name).join(', ')}.`,
    '# Secrets (masked, protected): see ci/README.md.',
    '',
    'stages:',
    ...stages.map((s) => `  - ${s}`),
    '',
    'variables:',
    `  PLAN_ID: ${model.plan}`,
    `  TERRAFORM_VERSION: ${model.terraformVersion}`,
    ...(images.length > 0 ? [`  PACKER_VERSION: ${model.packerVersion}`] : []),
    '  TF_IN_AUTOMATION: "1"',
    '  TF_INPUT: "0"',
    ...(model.platforms.includes('oci') ? [`  OCI_AUTH: ${model.ociAuth}`] : []),
    '',
    'workflow:',
    '  rules:',
    '    - if: $CI_PIPELINE_SOURCE == "merge_request_event"',
    '    - if: $CI_COMMIT_BRANCH == "main"',
    '',
    '.terraform:',
    `  image: ${IMAGE}`,
    '  before_script:',
    `    - ${APT}`,
    '    - bash ci/scripts/install-tools.sh terraform "$TERRAFORM_VERSION"',
    '    - export PATH="$HOME/.local/bin:$PATH"',
    '',
  ];
  for (const s of model.stacks) L.push(...stackJob(s, 'plan'));

  if (images.length > 0) {
    L.push(
      '.packer:',
      `  image: ${IMAGE}`,
      '  stage: images',
      '  before_script:',
      `    - ${APT}`,
      '    - bash ci/scripts/install-tools.sh packer "$PACKER_VERSION"',
      '    - export PATH="$HOME/.local/bin:$PATH"',
      '    - python3 -m venv /tmp/ansible && . /tmp/ansible/bin/activate && pip install --quiet ansible-core pywinrm',
      '',
    );
    for (const p of images) {
      L.push(
        `images:validate:${p}:`,
        '  extends: .packer',
        ...runnerTags(p, '  '),
        '  rules:',
        '    - if: $CI_PIPELINE_SOURCE == "merge_request_event"',
        '      changes: [images/**/*, ansible/roles/**/*]',
        '  script:',
        `    - bash ci/scripts/packer.sh validate ${p}`,
        '',
        `images:build:${p}:`,
        '  extends: .packer',
        ...runnerTags(p, '  '),
        ...idTokens(p, '  '),
        '  environment:',
        '    name: images',
        '    deployment_tier: other',
        '  rules:',
        '    - if: $CI_COMMIT_BRANCH == "main" && $CI_PIPELINE_SOURCE != "merge_request_event"',
        '      changes: [images/**/*, ansible/roles/**/*]',
        '  script:',
        ...signIn(p, '    '),
        `    - IMAGE_VERSION="$CI_COMMIT_SHA" bash ci/scripts/packer.sh build ${p}`,
        '  artifacts:',
        '    paths:',
        '      - images/manifest.json',
        `      - images/${p}.auto.tfvars.json`,
        '',
      );
    }
  }

  for (const wave of model.waves) {
    for (const s of wave.stacks) L.push(...stackJob(s, 'apply'));
    if (!model.ansible) continue;
    for (const p of [...new Set(wave.stacks.map((s) => s.platform))]) {
      L.push(
        `configure:${wave.env}:${p}:`,
        `  stage: configure-${wave.env}`,
        `  image: ${IMAGE}`,
        `  tags: [${model.ansibleRunner}]`,
        ...idTokens(p, '  '),
        '  environment:',
        `    name: ${wave.env}`,
        `    deployment_tier: ${TIER[wave.env] ?? 'other'}`,
        '  rules:',
        '    - if: $CI_COMMIT_BRANCH == "main" && $CI_PIPELINE_SOURCE != "merge_request_event"',
        '  before_script:',
        `    - ${APT}`,
        '  script:',
        ...signIn(p, '    '),
        `    - bash ci/scripts/ansible.sh ${p} ${wave.env}`,
        '',
      );
    }
  }
  return `${L.join('\n').replace(/\n+$/, '')}\n`;
}

/** `.gitlab-ci.yml`, the shared scripts, and ci/README.md. */
export function gitlabCiFiles(options: CiOptions): CiOutput {
  const model = ciModel(options);
  const files: Record<string, string> = { ...ciScripts(model) };
  files['.gitlab-ci.yml'] = pipeline(model);
  files['ci/README.md'] = ciReadme('gitlab-ci', model, '.gitlab-ci.yml', 'a protected environment of the same name in Settings → CI/CD → Protected environments, with approval rules for test, preprod and prod; scope the sign-in variables to each environment');
  return { files, findings: model.findings };
}
