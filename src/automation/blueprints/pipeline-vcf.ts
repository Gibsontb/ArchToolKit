/**
 * Pipelines for VCF content: the things that move templates, actions and
 * VCF Operations content from a repository into an instance.
 *
 * The first set of pipeline blueprints runs scripts. This set treats the
 * content of VCF itself as code — a cloud template, an extensibility action, an
 * alert definition — and puts the same three steps in front of every change:
 * a check on the pull request, a test against something that is not
 * production, and an apply from main only, with the credential coming from the
 * runner's secret store.
 *
 * VCF endpoints are private. Almost everything here that talks to an instance
 * runs on a self-hosted runner inside the network, and says so.
 */

import { bool, num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, info, warning, type Finding } from '../../core/findings.ts';
import { automationBlueprint, type AutomationBlueprint } from '../from-automation.ts';
import { listOf, slugOf, type Automation } from '../automation.ts';
import { authHeader, authPreamble } from '../apply.ts';

const PLATFORM = 'pipeline' as const;
const SRC = 'ArchToolKit';

type Ci = 'github' | 'gitlab' | 'azdo' | 'jenkins';

const CI_LABEL: Readonly<Record<Ci, string>> = {
  github: 'GitHub Actions',
  gitlab: 'GitLab CI',
  azdo: 'Azure Pipelines',
  jenkins: 'Jenkins',
};

const CI_OPTIONS_ALL = (Object.keys(CI_LABEL) as Ci[]).map((value) => ({ value, label: CI_LABEL[value] }));
const CI_OPTIONS_NO_JENKINS = CI_OPTIONS_ALL.filter((option) => option.value !== 'jenkins');

function ciOf(values: BlueprintValues, fallback: Ci = 'github'): Ci {
  const value = str(values, 'ci', fallback);
  return (value in CI_LABEL ? value : fallback) as Ci;
}

/** Where the pipeline file lives for each CI. */
function ciFile(ci: Ci, name: string): string {
  switch (ci) {
    case 'github':
      return `.github/workflows/${name}.yml`;
    case 'gitlab':
      return '.gitlab-ci.yml';
    case 'azdo':
      // The name Azure Pipelines looks for when a pipeline is created from a
      // repository; any other path has to be picked by hand.
      void name;
      return 'azure-pipelines.yml';
    case 'jenkins':
      return 'Jenkinsfile';
  }
}

/** Where the secret lives, in each CI's own words. */
function secretStore(ci: Ci): string {
  switch (ci) {
    case 'github':
      return 'a repository or environment secret';
    case 'gitlab':
      return 'a masked, protected CI/CD variable';
    case 'azdo':
      return 'a secret pipeline variable or a variable group linked to Key Vault';
    case 'jenkins':
      return 'a Jenkins "secret text" credential';
  }
}

/**
 * The VCF Automation login every script here shares.
 *
 * A refresh token from the secret store is exchanged for a short-lived bearer
 * token at the start of each run, so the thing that is stored is revocable and
 * the thing that is used expires on its own.
 */
const VCFA_LIB = [
  '#!/usr/bin/env bash',
  '# Shared by the CI scripts: log in to VCF Automation and make API calls.',
  '#',
  '# The refresh token comes from the CI secret store as VCFA_REFRESH_TOKEN. It is',
  '# exchanged for a bearer token that expires on its own; neither is written to',
  '# disk or echoed, and the refresh token is never a command argument — jq reads',
  '# it from its environment and curl takes the body on stdin.',
  '',
  'vcfa_login() {',
  '  : "${VCFA_HOST:?set VCFA_HOST, e.g. vcfa.example.com}"',
  '  : "${VCFA_REFRESH_TOKEN:?set VCFA_REFRESH_TOKEN from the CI secret store}"',
  '  command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
  '  VCFA_TOKEN=$(VCFA_REFRESH_TOKEN="$VCFA_REFRESH_TOKEN" jq -n \'{refreshToken: env.VCFA_REFRESH_TOKEN}\' |',
  '    curl -sS -f -X POST "https://${VCFA_HOST}/iaas/api/login" \\',
  '      -H "Content-Type: application/json" --data-binary @- | jq -r .token)',
  '  [[ -n "$VCFA_TOKEN" && "$VCFA_TOKEN" != "null" ]] || { echo "VCF Automation login failed" >&2; exit 1; }',
  '  export VCFA_TOKEN',
  '}',
  '',
  'vcfa() {',
  '  # vcfa METHOD PATH [BODY]',
  '  local method="$1" path="$2" body="${3:-}"',
  '  if [[ -n "$body" ]]; then',
  '    curl -sS -f -X "$method" "https://${VCFA_HOST}${path}" \\',
  '      -H @<(printf \'Authorization: Bearer %s\\n\' "$VCFA_TOKEN") -H "Accept: application/json" \\',
  '      -H "Content-Type: application/json" --data-binary @- <<<"$body"',
  '  else',
  '    curl -sS -f -X "$method" "https://${VCFA_HOST}${path}" \\',
  '      -H @<(printf \'Authorization: Bearer %s\\n\' "$VCFA_TOKEN") -H "Accept: application/json"',
  '  fi',
  '}',
  '',
  '# Resolve a project name to its id, so the pipeline files carry names people read.',
  'vcfa_project_id() {',
  '  local name="$1"',
  '  vcfa GET "/iaas/api/projects?\\$filter=name%20eq%20\'$(jq -rn --arg n "$name" \'$n|@uri\')\'" | jq -r \'.content[0].id // empty\'',
  '}',
  '',
].join('\n');

const VCFA_LOGIN_NOTE =
  'The scripts log in with POST /iaas/api/login and a refresh token — the Aria Automation 8.x flow. VCF Automation 9.x organizations can issue API tokens differently; check how yours does before relying on it, and change vcfa_login in one place if it differs.';

export const PIPELINE_VCF: readonly AutomationBlueprint[] = [
  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'pipe_codestream',
    platform: PLATFORM,
    label: 'A VCF Automation Pipelines pipeline (formerly Code Stream)',
    group: 'VCF Automation Pipelines',
    description:
      'A pipeline in the native export format of VCF Automation Pipelines — Aria Automation Pipelines, Code Stream before that — with its endpoints, its secret variables and its notifications. Every credential is a ${var.…} secret variable entered in the interface; none is in these files. Check that your VCF Automation release still has Pipelines before building on it.',
    inputs: [
      {
        id: 'pattern',
        label: 'Pattern',
        control: 'select',
        options: [
          { value: 'template', label: 'Deploy a cloud template, test, approve, promote' },
          { value: 'k8s', label: 'Build a container image and roll it out to Kubernetes' },
          { value: 'vro', label: 'Run an Orchestrator workflow with approval' },
        ],
        default: 'template',
      },
      { id: 'project', label: 'Pipelines project', control: 'text', default: 'Platform — pipelines test', hint: 'Blueprint tasks deploy into this project. Make it a test project' },
      { id: 'pipeline_name', label: 'Pipeline name', control: 'text', default: 'cloud-template-promote' },
      { id: 'git_repo', label: 'Git repository', control: 'text', default: 'https://git.example.com/platform/cloud-templates.git' },
      { id: 'git_server', label: 'Git server type', control: 'select', options: [{ value: 'GitLab', label: 'GitLab' }, { value: 'GitHub', label: 'GitHub' }, { value: 'BitBucket', label: 'Bitbucket' }], default: 'GitLab' },
      { id: 'blueprint_name', label: 'Cloud template', control: 'text', default: 'Linux VM — standard', showWhen: { input: 'pattern', equals: ['template'] } },
      { id: 'blueprint_id', label: 'Cloud template id', control: 'text', default: '', placeholder: 'GET /blueprint/api/blueprints?name=…', showWhen: { input: 'pattern', equals: ['template'] } },
      { id: 'smoke_command', label: 'Smoke check (run on the test machine over SSH)', control: 'text', default: 'systemctl is-system-running --wait; test -d /opt/app', showWhen: { input: 'pattern', equals: ['template'] } },
      { id: 'image', label: 'Image', control: 'text', default: 'registry.example.com/platform/web', showWhen: { input: 'pattern', equals: ['k8s'] } },
      { id: 'k8s_namespace', label: 'Namespace', control: 'text', default: 'web', showWhen: { input: 'pattern', equals: ['k8s'] } },
      { id: 'health_url', label: 'Health URL (production)', control: 'text', default: 'https://web.example.com/healthz', showWhen: { input: 'pattern', equals: ['k8s'] } },
      { id: 'workflow_id', label: 'Orchestrator workflow id', control: 'text', default: '', placeholder: 'The workflow’s id from the Orchestrator client', showWhen: { input: 'pattern', equals: ['vro'] } },
      { id: 'max_objects', label: 'Refuse if the dry run touches more than', control: 'number', default: 20, min: 1, max: 10000, showWhen: { input: 'pattern', equals: ['vro'] } },
      { id: 'approvers', label: 'Approvers', control: 'text', default: 'platform-leads@example.com', hint: 'Comma-separated users or groups. The approver must be able to say no' },
      { id: 'notify', label: 'Notify on failure and waiting approval', control: 'text', default: 'platform-team@example.com' },
      { id: 'concurrency', label: 'Runs at a time', control: 'number', default: 1, min: 1, max: 10, hint: 'The export default is 10. One is right for anything that releases or deploys' },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const pattern = str(values, 'pattern', 'template');
      const project = str(values, 'project', 'Platform');
      const pipelineName = slugOf(str(values, 'pipeline_name', 'pipeline'), 'pipeline');
      const gitRepo = str(values, 'git_repo', '');
      const gitServer = str(values, 'git_server', 'GitLab');
      const blueprintName = str(values, 'blueprint_name', 'Linux VM — standard');
      const blueprintId = str(values, 'blueprint_id', '<REQUIRED — the cloud template id>');
      const smoke = str(values, 'smoke_command', 'true');
      const image = str(values, 'image', 'registry.example.com/app');
      const namespace = str(values, 'k8s_namespace', 'default');
      const healthUrl = str(values, 'health_url', '');
      const workflowId = str(values, 'workflow_id', '<REQUIRED — the workflow id>');
      const maxObjects = num(values, 'max_objects', 20);
      const approvers = listOf(str(values, 'approvers', ''));
      const notify = listOf(str(values, 'notify', ''));
      const concurrency = num(values, 'concurrency', 1);
      const base = slugOf(name || pipelineName, 'pipeline');

      const findings: Finding[] = [
        warning('pipe.codestream.availability', 'Pipelines was part of Aria Automation 8.x. Whether VCF Automation 9.x includes it depends on your release and organization type.', {
          remediation: 'Check the release notes and your own instance for Pipelines before building on this. The portable alternative is "Cloud templates as code, tested in CI" (pipe_template_ci), which calls the same APIs from any CI.',
          source: SRC,
        }),
      ];
      if (approvers.length === 0) {
        findings.push(
          error('pipe.codestream.no-approver', 'The approval task has nobody to approve it.', {
            remediation: 'Name at least one user or group. A UserOperation with no approver cannot be completed and the run waits until it expires.',
            source: SRC,
          }),
        );
      }
      if (/prod/i.test(project)) {
        findings.push(
          warning('pipe.codestream.prod-project', `The pipeline project "${project}" looks like production.`, {
            remediation: 'Blueprint tasks deploy into the pipeline’s own project. Put the pipeline in a test project so the test deployment lands there, and promote by releasing a version.',
            source: SRC,
          }),
        );
      }
      if (notify.length === 0) {
        findings.push(warning('pipe.codestream.no-notify', 'Nobody is told when a run fails or waits for approval.', { remediation: 'A waiting approval nobody hears about expires, and the change goes with it.', source: SRC }));
      }
      if (concurrency > 1 && pattern !== 'vro') {
        findings.push(
          warning('pipe.codestream.concurrency', `${concurrency} runs at a time can release or roll out out of order.`, {
            remediation: 'Two merges a minute apart run side by side, and the older one can finish last. Keep it at 1.',
            source: SRC,
          }),
        );
      }

      // --- the pipeline -----------------------------------------------------
      const header = [
        '---',
        '# Generated by ArchToolKit — VCF Automation Pipelines export format.',
        '# The shape follows an Aria Automation 8.x export. Import one pipeline by',
        '# hand first and diff its export against this before importing the rest.',
        `project: ${q(project)}`,
        'kind: PIPELINE',
        `name: ${pipelineName}`,
        'icon: organization,left, is-info',
        `description: ${q(`Generated by ArchToolKit. ${pattern === 'template' ? `Test ${blueprintName}, approve, release a version.` : pattern === 'k8s' ? `Build ${image} and roll it out to ${namespace}.` : 'Dry-run an Orchestrator workflow, approve, run it.'}`)}`,
        'enabled: true',
        `concurrency: ${concurrency}`,
      ];
      // Pipelines with no CI task still carry an empty workspace in an export.
      const emptyWorkspace = ['workspace:', "  endpoint: ''", "  image: ''", "  registry: ''", "  path: ''", '  autoCloneForTrigger: false', '  limits:', '    cpu: 1.0', '    memory: 512'];

      const notifications = [
        'notifications:',
        '  email:',
        ...['FAILURE', 'WAITING', 'SUCCESS'].flatMap((event) => [
          `    - event: ${event}`,
          '      endpoint: email-server',
          `      to: [${notify.map((n) => q(n)).join(', ')}]`,
          `      subject: '${pipelineName} \${executionIndex}: ${event.toLowerCase()}'`,
          `      body: '${event === 'WAITING' ? 'Waiting for approval. Open the execution to approve or reject.' : event === 'FAILURE' ? 'Failed. Open the execution for the task that failed.' : 'Finished.'}'`,
        ]),
      ];

      const approval = (summary: string, description: string) => [
        '      Approve:',
        '        type: UserOperation',
        '        input:',
        `          approvers: [${approvers.map((a) => `'${a}'`).join(', ')}]`,
        '          approverGroups: []',
        `          summary: '${summary}'`,
        `          description: '${description}'`,
        '          sendemail: true',
        '          expiration: 3',
        '          expirationUnit: DAYS',
        '          cancelPreviousPendingUserOp: true',
      ];

      let pipeline: string[];
      let vars: string[];
      let endpoints: string[];

      if (pattern === 'template') {
        pipeline = [
          ...header,
          'input:',
          '  GIT_COMMIT_ID: \'\'',
          '  GIT_BRANCH_NAME: \'\'',
          `  BLUEPRINT_ID: ${q(blueprintId)}`,
          '  _inputMeta:',
          '    GIT_COMMIT_ID: { mandatory: true, description: Set by the git webhook. It is the version name, so a version always points at its commit }',
          '    GIT_BRANCH_NAME: { mandatory: false, description: Set by the git webhook }',
          '    BLUEPRINT_ID: { mandatory: true, description: The cloud template to test and release }',
          ...emptyWorkspace,
          'stageOrder:',
          '  - Test',
          '  - Approve',
          '  - Promote',
          'stages:',
          '  Test:',
          '    taskOrder:',
          '      - DeployTest',
          '      - Smoke',
          '      - DeleteTest',
          '      - SmokePassed',
          '    tasks:',
          '      DeployTest:',
          '        type: Blueprint',
          '        # Deploys into this pipeline’s own project — the test project.',
          '        input:',
          '          action: CreateDeployment',
          `          blueprint: ${q(blueprintName)}`,
          '          version: \'\'          # empty: the current draft, which is what is being tested',
          '          deploymentName: \'${name}-test-${executionIndex}\'',
          '          parameters: {}',
          '      Smoke:',
          '        type: SSH',
          '        # ignoreFailure so DeleteTest always runs. SmokePassed fails the',
          '        # run afterwards if this did not pass.',
          '        ignoreFailure: true',
          '        input:',
          '          # <REQUIRED — verify this output path against one run: open the',
          '          # DeployTest output in an execution and copy the address field.>',
          '          host: \'${Test.DeployTest.output.deploymentDetails.resources[0].properties.address}\'',
          '          username: ${var.smoke_ssh_user}',
          '          password: ${var.smoke_ssh_password}',
          '          script: |',
          '            set -e',
          ...smoke.split(';').map((part) => `            ${part.trim()}`).filter((line) => line.trim()),
          '      DeleteTest:',
          '        type: Blueprint',
          '        input:',
          '          action: DeleteDeployment',
          '          deploymentName: \'${name}-test-${executionIndex}\'',
          '      SmokePassed:',
          '        type: Condition',
          '        input:',
          '          condition: \'"${Test.Smoke.status}" == "COMPLETED"\'',
          '  Approve:',
          '    taskOrder:',
          '      - OnMain',
          '      - Approve',
          '    tasks:',
          '      OnMain:',
          '        type: Condition',
          '        # Release only from main. A branch build tests, and stops here.',
          '        input:',
          '          condition: \'"${input.GIT_BRANCH_NAME}" == "main"\'',
          ...approval(`Release ${blueprintName} \${input.GIT_COMMIT_ID}`, 'The test deployment passed its smoke check and was deleted. Approving releases this version to the catalog.'),
          '  Promote:',
          '    taskOrder:',
          '      - Login',
          '      - Release',
          '      - Released',
          '    tasks:',
          '      Login:',
          '        type: REST',
          '        input:',
          '          action: post',
          '          url: \'https://${var.vcfa_host}/iaas/api/login\'',
          '          headers: { Accept: application/json, Content-Type: application/json }',
          '          payload: \'{"refreshToken": "${var.vcfa_refresh_token}"}\'',
          '      Release:',
          '        type: REST',
          '        input:',
          '          action: post',
          '          url: \'https://${var.vcfa_host}/blueprint/api/blueprints/${input.BLUEPRINT_ID}/versions\'',
          '          headers:',
          '            Accept: application/json',
          '            Content-Type: application/json',
          '            # <verify> the JSON path into the Login response on your instance.',
          '            Authorization: \'Bearer ${Promote.Login.output.responseBody.token}\'',
          '          payload: \'{"version": "${input.GIT_COMMIT_ID}", "release": true, "description": "Released by pipeline ${name} ${executionIndex}", "changeLog": "${input.GIT_COMMIT_ID}"}\'',
          '      Released:',
          '        type: POLL',
          '        input:',
          '          url: \'https://${var.vcfa_host}/blueprint/api/blueprints/${input.BLUEPRINT_ID}/versions/${input.GIT_COMMIT_ID}\'',
          '          headers:',
          '            Accept: application/json',
          '            Authorization: \'Bearer ${Promote.Login.output.responseBody.token}\'',
          '          exitCriteria:',
          '            success: \'${responseBody.status} == "RELEASED"\'',
          '            failure: \'${responseCode} >= 400\'',
          '          pollCount: 10',
          '          pollIntervalSeconds: 30',
          '          ignoreFailure: false',
          ...notifications,
          '',
        ];
        vars = ['smoke_ssh_user', 'smoke_ssh_password', 'vcfa_host', 'vcfa_refresh_token', 'git_token', 'smtp_password'];
        endpoints = [];
      } else if (pattern === 'k8s') {
        pipeline = [
          ...header,
          'input:',
          '  GIT_COMMIT_ID: \'\'',
          '  GIT_BRANCH_NAME: \'\'',
          '  _inputMeta:',
          '    GIT_COMMIT_ID: { mandatory: false, description: Set by the git webhook — used as the image tag }',
          '    GIT_BRANCH_NAME: { mandatory: false, description: Set by the git webhook }',
          'workspace:',
          '  type: DOCKER',
          '  endpoint: docker-host',
          '  # kaniko builds without a Docker daemon in the CI container. <verify> that',
          '  # the debug image (it has a shell) is reachable from your docker host.',
          '  image: gcr.io/kaniko-project/executor:debug',
          '  registry: image-registry',
          '  path: \'\'',
          '  autoCloneForTrigger: true',
          '  limits: { cpu: 1.0, memory: 1024 }',
          'stageOrder:',
          '  - Build',
          '  - Development',
          '  - Approve',
          '  - Production',
          'stages:',
          '  Build:',
          '    taskOrder:',
          '      - BuildImage',
          '    tasks:',
          '      BuildImage:',
          '        type: CI',
          '        input:',
          '          steps:',
          `            - /kaniko/executor --context "$PWD" --destination "${image}:\${input.GIT_COMMIT_ID}"`,
          '          export: []',
          '          artifacts: []',
          '          process: []',
          '  Development:',
          '    taskOrder:',
          '      - ApplyDev',
          '      - RolledOutDev',
          '    tasks:',
          '      ApplyDev:',
          '        type: K8S',
          '        endpoints:',
          '          kubernetesServer: k8s-development',
          '        input:',
          '          action: APPLY',
          '          timeout: 5',
          '          filePath: \'\'',
          '          yaml: |',
          ...k8sManifest(image, namespace, '${input.GIT_COMMIT_ID}').map((line) => `            ${line}`),
          '      RolledOutDev:',
          '        type: K8S',
          '        endpoints:',
          '          kubernetesServer: k8s-development',
          '        input:',
          '          action: GET',
          '          timeout: 5',
          '          # <verify> the output path; the task returns the object as the API does.',
          '          yaml: |',
          '            apiVersion: apps/v1',
          '            kind: Deployment',
          '            metadata:',
          `              name: ${slugOf(image.split('/').pop() ?? 'app', 'app')}`,
          `              namespace: ${namespace}`,
          '  Approve:',
          '    taskOrder:',
          '      - OnMain',
          '      - Approve',
          '    tasks:',
          '      OnMain:',
          '        type: Condition',
          '        input:',
          '          condition: \'"${input.GIT_BRANCH_NAME}" == "main"\'',
          ...approval(`Roll out ${image}:\${input.GIT_COMMIT_ID} to production`, 'It is running in development. Approving rolls it out to production.'),
          '  Production:',
          '    taskOrder:',
          '      - ApplyProd',
          '      - Healthy',
          '    tasks:',
          '      ApplyProd:',
          '        type: K8S',
          '        endpoints:',
          '          kubernetesServer: k8s-production',
          '        input:',
          '          action: APPLY',
          '          timeout: 10',
          '          filePath: \'\'',
          '          yaml: |',
          ...k8sManifest(image, namespace, '${input.GIT_COMMIT_ID}').map((line) => `            ${line}`),
          '      Healthy:',
          '        type: POLL',
          '        input:',
          `          url: '${healthUrl || '<REQUIRED — the production health URL>'}'`,
          '          headers: { Accept: application/json }',
          '          exitCriteria:',
          '            success: \'${responseCode} == 200\'',
          '            failure: \'${responseCode} >= 500\'',
          '          pollCount: 20',
          '          pollIntervalSeconds: 15',
          '          ignoreFailure: false',
          ...notifications,
          '',
        ];
        vars = ['git_token', 'registry_password', 'k8s_development_token', 'k8s_production_token', 'docker_client_key', 'smtp_password'];
        endpoints = [
          endpoint(project, 'docker-host', 'docker', 'The docker host the CI task containers run on.', [
            'hostURL: <REQUIRED — tcp://docker-host.example.com:2376>',
            'certAuthority: <REQUIRED — the CA that signed the docker host certificate>',
            'cert: <REQUIRED — the client certificate>',
            'privateKey: ${var.docker_client_key}',
          ]),
          endpoint(project, 'image-registry', 'registry', 'Where built images are pushed.', [
            `url: https://${image.split('/')[0] ?? 'registry.example.com'}`,
            'serverType: DOCKER_REGISTRY',
            'username: <REQUIRED — a push-only service account>',
            'password: ${var.registry_password}',
          ]),
          endpoint(project, 'k8s-development', 'k8s', 'The development cluster.', [
            'kubernetesURL: <REQUIRED — https://dev-cluster.example.com:6443>',
            'authType: token',
            'token: ${var.k8s_development_token}',
            'fingerprint: <REQUIRED — the API server certificate fingerprint>',
          ]),
          endpoint(project, 'k8s-production', 'k8s', 'The production cluster. Its service account can write to one namespace only.', [
            'kubernetesURL: <REQUIRED — https://prod-cluster.example.com:6443>',
            'authType: token',
            'token: ${var.k8s_production_token}',
            'fingerprint: <REQUIRED — the API server certificate fingerprint>',
          ]),
        ];
      } else {
        pipeline = [
          ...header,
          'input:',
          '  GIT_COMMIT_ID: \'\'',
          '  GIT_BRANCH_NAME: \'\'',
          `  MAX_OBJECTS: '${maxObjects}'`,
          '  _inputMeta:',
          '    GIT_COMMIT_ID: { mandatory: false, description: Set by the git webhook }',
          '    GIT_BRANCH_NAME: { mandatory: false, description: Set by the git webhook }',
          '    MAX_OBJECTS: { mandatory: true, description: The run is refused if the dry run would touch more than this }',
          ...emptyWorkspace,
          'stageOrder:',
          '  - Validate',
          '  - Approve',
          '  - Run',
          'stages:',
          '  Validate:',
          '    taskOrder:',
          '      - DryRun',
          '      - WithinLimit',
          '    tasks:',
          '      DryRun:',
          '        type: VRO',
          '        endpoints:',
          '          vroServer: orchestrator',
          '        input:',
          `          workflowId: ${q(workflowId)}`,
          '          parameters:',
          '            dryRun: true',
          '      WithinLimit:',
          '        type: Condition',
          '        # <REQUIRED — the workflow must return an output parameter with the',
          '        # count it would touch. Rename affectedCount to match yours.>',
          '        input:',
          '          condition: \'${Validate.DryRun.output.properties.affectedCount} <= ${input.MAX_OBJECTS}\'',
          '  Approve:',
          '    taskOrder:',
          '      - Approve',
          '    tasks:',
          ...approval('Run the workflow for real', 'The dry run output is on the DryRun task of this execution. Read it before approving.'),
          '  Run:',
          '    taskOrder:',
          '      - Execute',
          '      - Record',
          '    tasks:',
          '      Execute:',
          '        type: VRO',
          '        endpoints:',
          '          vroServer: orchestrator',
          '        input:',
          `          workflowId: ${q(workflowId)}`,
          '          parameters:',
          '            dryRun: false',
          '      Record:',
          '        type: REST',
          '        # Posts what ran to your change or chat system. Replace the URL.',
          '        input:',
          '          action: post',
          '          url: \'${var.record_webhook_url}\'',
          '          headers: { Content-Type: application/json }',
          '          payload: \'{"pipeline": "${name}", "execution": "${executionIndex}", "workflow": "' + workflowId + '", "commit": "${input.GIT_COMMIT_ID}"}\'',
          ...notifications,
          '',
        ];
        vars = ['vro_password', 'record_webhook_url', 'git_token', 'smtp_password'];
        endpoints = [
          endpoint(project, 'orchestrator', 'vro', 'The Orchestrator the workflow runs in. The embedded one may already be listed — use it rather than adding a second.', [
            'url: <REQUIRED — https://vcfa.example.com/vco>',
            'username: <REQUIRED — a service account with rights to run this workflow only>',
            'password: ${var.vro_password}',
          ]),
        ];
      }

      endpoints = [
        endpoint(project, 'git-source', 'git', 'The repository the webhook watches.', [
          `serverType: ${gitServer}`,
          `repoURL: ${gitRepo || '<REQUIRED — the repository URL>'}`,
          'branch: main',
          'authType: http',
          'username: <REQUIRED — a read-only service account>',
          'password: ${var.git_token}',
        ]),
        ...endpoints,
        endpoint(project, 'email-server', 'email', 'Where the notifications go out from.', [
          'senderAddress: <REQUIRED — pipelines@example.com>',
          'serverName: <REQUIRED — smtp.example.com>',
          'serverPort: 587',
          'encryptionMethod: TLS',
          'username: <REQUIRED — the SMTP account>',
          'password: ${var.smtp_password}',
        ]),
      ];

      // Every secret is a SECRET variable with an empty value: the pipeline and
      // endpoints refer to it as ${var.name}, and the value is typed into
      // Variables in the interface after the import.
      const varType = (variable: string) => (variable.endsWith('_host') ? 'REGULAR' : 'SECRET');
      const varDescription = (variable: string) => `Referenced as \${var.${variable}}. Set the value in Variables in the interface, never in this file.`;
      const variables = vars.flatMap((variable) => [
        '---',
        `project: ${q(project)}`,
        'kind: VARIABLE',
        `name: ${variable}`,
        `type: ${varType(variable)}`,
        `description: ${q(varDescription(variable))}`,
        "value: ''",
      ]);
      const variableJson = (variable: string) =>
        `${JSON.stringify({ project, kind: 'VARIABLE', name: variable, type: varType(variable), description: varDescription(variable), value: '' }, null, 2)}\n`;

      const webhook = [
        `# Git webhook for ${pipelineName}`,
        '',
        'Generated by ArchToolKit. Git webhooks are not part of the pipeline export, so this',
        'is the setting to make by hand in Triggers → Git → Webhooks for Git.',
        '',
        '| Setting | Value |',
        '|---|---|',
        '| Endpoint | git-source |',
        '| Branch | main — and a second webhook on your review branches if you want them tested |',
        '| Event | Push |',
        `| Pipeline | ${pipelineName} |`,
        '| Secret token | Generated by the interface. It is stored there, not here. |',
        '| File path — inclusions | the folder this pipeline cares about, so an unrelated commit does not start it |',
        '| Delay | 1 minute, so a burst of pushes becomes one run |',
        '',
        'The webhook fills GIT_COMMIT_ID and GIT_BRANCH_NAME from the push. The Condition task',
        'before the approval stops any branch that is not main, so a branch push tests and',
        'goes no further.',
        '',
        '## Before the first run',
        '',
        '1. Import the pipeline — IMPORT.md.',
        '2. Set every SECRET variable in Variables in the interface — they are imported empty.',
        '3. Open the pipeline, run it once by hand from a branch, and diff its export against the file here.',
        '4. Then enable the webhook.',
        '',
      ].join('\n');

      const title =
        pattern === 'template'
          ? `${blueprintName} — test deployment, approval, release, in VCF Automation Pipelines`
          : pattern === 'k8s'
            ? `${image} — build, development, approval, production, in VCF Automation Pipelines`
            : 'An Orchestrator workflow — dry run, approval, run, in VCF Automation Pipelines';

      return {
        platform: PLATFORM,
        title,
        effect: 'reversible',
        trigger: {
          kind: 'webhook',
          detail: `A push to ${gitRepo || 'the repository'} through the git webhook on git-source; everything after the first stage also waits for an approval from ${approvers.join(', ') || '(nobody)'}`,
          worstCase: `once per push, ${concurrency} at a time — and a burst of pushes queues that many runs`,
        },
        scope: {
          what:
            pattern === 'template'
              ? `One test deployment of ${blueprintName} in "${project}", and a new released version of the template.`
              : pattern === 'k8s'
                ? `The deployment of ${image} in namespace ${namespace} on the development cluster, then production.`
                : `Whatever Orchestrator workflow ${workflowId} acts on, up to ${maxObjects} objects per run.`,
          decidedBy: [
            'The git webhook: which repository, which branch, which paths start a run.',
            pattern === 'template' ? `The pipeline project "${project}" — Blueprint tasks deploy into it.` : pattern === 'k8s' ? 'The service account on each Kubernetes endpoint, and the namespaces it can write to.' : 'The workflow’s own inputs, and the dry-run count the Condition checks.',
            'The Condition on the branch, and the approver who says yes.',
          ],
          ifWrong:
            pattern === 'template'
              ? 'A test deployment lands in a production project and consumes its quota, or a version is released to the catalog that nobody tested.'
              : pattern === 'k8s'
                ? 'An image is rolled out to a namespace it was not meant for. Kubernetes keeps the previous ReplicaSet, so it can be rolled back — if somebody notices.'
                : 'The workflow acts on more than was meant. The limit stops the run before the approval, not during it.',
        },
        guardrails: [
          { rule: 'An approval before anything reaches production', because: 'The approver sees the execution so far. That is the last point a person is involved.' },
          { rule: 'Only main goes past the approval', because: 'A Condition task stops every other branch, so a feature branch can test without being able to promote.' },
          { rule: 'Credentials are secret variables', because: 'The export is read, diffed and committed. A credential in it is a credential in git.' },
          { rule: `${concurrency} run${concurrency === 1 ? '' : 's'} at a time`, because: 'Two runs side by side can promote out of order, and the older change wins.' },
          ...(pattern === 'template'
            ? [{ rule: 'The test deployment is always deleted', because: 'Smoke ignores its own failure so DeleteTest runs; SmokePassed fails the run afterwards. A failed test does not leave a machine behind.' }]
            : []),
          ...(pattern === 'vro' ? [{ rule: `Refused if the dry run touches more than ${maxObjects}`, because: 'A workflow that finds a thousand objects when it expected twenty has the wrong input, not a busy day.' }] : []),
        ],
        dryRun: [
          'Run the pipeline from a branch. It runs every stage up to the approval, and the Condition stops it there.',
          pattern === 'vro' ? 'The DryRun task runs the workflow with dryRun true. The workflow has to honour that input — check that it does before trusting it.' : 'Reject the approval on the first run from main and read what it would have done.',
          'import.sh without --execute prints what it would import.',
        ],
        undo:
          pattern === 'template'
            ? ['Unrelease the version: POST /blueprint/api/blueprints/{id}/versions/{version}/actions/unrelease, and release the previous one again.', 'Deployments already made from the version are not changed by unreleasing it.']
            : pattern === 'k8s'
              ? [`kubectl rollout undo deployment/${slugOf(image.split('/').pop() ?? 'app', 'app')} -n ${namespace}, or revert the commit and let the pipeline roll forward.`]
              : ['Depends on the workflow. If it has no undo of its own, say so in the approval description, so the approver knows.'],
        told: [
          `Email to ${notify.join(', ') || '(nobody)'} on failure, on waiting approval and on success.`,
          'Every execution, with each task’s input and output, stays in Executions in the interface.',
          ...(pattern === 'vro' ? ['The Record task posts what ran to record_webhook_url.'] : []),
        ],
        requires: [
          'Pipelines available in your VCF Automation release — see the warning.',
          `A Pipelines project "${project}"; the endpoints are in the import file.`,
          'Every variable in the variables file set in the interface before import.',
          ...(pattern === 'template' ? ['A test project with a lease policy of a day, so a test deployment that escapes deletion expires on its own.'] : []),
        ],
        files: {
          // The one file the Import dialog takes: variables, endpoints, pipeline.
          [`import/pipelines/${pipelineName}.yaml`]: `${[...variables, ...endpoints, ...pipeline].join('\n').replace(/\n+$/, '')}\n`,
          // The same objects one per file, for the API route in import.sh.
          ...Object.fromEntries(vars.map((variable) => [`import/api/variables/${variable}.json`, variableJson(variable)])),
          ...Object.fromEntries(endpoints.map((doc) => [`import/api/endpoints/${/\nname: (.+)/.exec(doc)?.[1] ?? 'endpoint'}.yaml`, `${doc}\n`])),
          [`import/api/${pipelineName}-pipeline.yaml`]: `${pipeline.join('\n').replace(/\n+$/, '')}\n`,
          'import.sh': codestreamImportScript(pipelineName, vars, endpoints.map((doc) => /\nname: (.+)/.exec(doc)?.[1] ?? 'endpoint')),
          'IMPORT.md': [
            '# Importing this into VCF Automation Pipelines',
            '',
            `Pipeline **${pipelineName}** in project **${project}**, with ${endpoints.length} endpoint${endpoints.length === 1 ? '' : 's'} and ${vars.length} variable${vars.length === 1 ? '' : 's'}. Aria Automation 8.x Pipelines (Code Stream); on VCF Automation 9.x only where Pipelines is present in your release. The project must exist first.`,
            '',
            `## Route 1 — the interface: \`import/pipelines/${pipelineName}.yaml\``,
            '',
            `Pipelines → **Import** → select \`${pipelineName}.yaml\` → **Import**. The file is several YAML documents separated by \`---\`: the VARIABLE documents first, then the ENDPOINT documents, then the PIPELINE, so everything the pipeline refers to exists before it does.`,
            '',
            'VERIFY: that your release’s Import dialog accepts VARIABLE and ENDPOINT documents in the same file as the pipeline. If it refuses, use route 2, which sends each object on its own.',
            '',
            '## Route 2 — the API: `import.sh`',
            '',
            '```bash',
            'export VCFA_HOST=vcfa.example.com',
            'export VCFA_REFRESH_TOKEN_FILE=~/.vcfa-refresh-token   # mode 600; or set VCFA_TOKEN',
            './import.sh             # dry run: prints what it would send',
            './import.sh --execute',
            '```',
            '',
            'In order:',
            '',
            ...vars.map((variable) => `1. \`POST /pipeline/api/variables\` ← \`import/api/variables/${variable}.json\``),
            ...endpoints.map((doc) => `1. \`POST /pipeline/api/import?action=create\` (Content-Type application/x-yaml) ← \`import/api/endpoints/${/\nname: (.+)/.exec(doc)?.[1] ?? 'endpoint'}.yaml\``),
            `1. \`POST /pipeline/api/import?action=create\` ← \`import/api/${pipelineName}-pipeline.yaml\``,
            '',
            'To update objects that already exist, use `action=apply` instead of `action=create`.',
            '',
            '## After either route',
            '',
            `1. **Variables**: set a value for each SECRET variable (${vars.filter((v) => !v.endsWith('_host')).join(', ')}) and each REGULAR one (${vars.filter((v) => v.endsWith('_host')).join(', ') || 'none'}). They are imported with empty values; nothing secret is in these files.`,
            '2. **Endpoints**: replace every `<REQUIRED — …>` value, then **Validate** each endpoint.',
            '3. **Triggers → Git**: add the webhook in `git-webhook.md` — webhooks are not part of an export.',
            '4. Run once from a branch before the webhook is enabled.',
            '',
            '## Confirmed, and what to verify',
            '',
            '- Document shape (`project`, `kind: PIPELINE`, `name`, `enabled`, `concurrency`, `input` with `_inputMeta` inside it, `workspace`, `stageOrder`, `stages`, `notifications.email`; `kind: ENDPOINT` with `type`, `isRestricted`, `properties`; `kind: VARIABLE` with `type` REGULAR/SECRET and `value`): Aria Automation 8.x exports published on GitHub (e.g. mcclanc/CodeStream-K8s-Blog Pipeline/pipeline.yaml) and the "pipeline as code" tutorial in the Automation Pipelines documentation.',
            '- `POST /pipeline/api/import?action=create|apply` with `Content-Type: application/x-yaml`, `POST /pipeline/api/variables`, and multi-document VARIABLE files: the VMware code-stream-cli source (cmd/api-func-shared.go, api-func-variables.go).',
            '- VERIFY: task input fields and output paths (`${Stage.Task.output…}`) against an export from your own instance; whether an endpoint imports with `${var.…}` in its password field on your release (if not, type the credential into the endpoint instead).',
            '',
          ].join('\n'),
          'git-webhook.md': webhook,
        },
        notes: [
          'Pipelines was a capability of Aria Automation 8.x (Code Stream before that). Its availability in VCF Automation 9.x must be checked for your release. If it is not there, "Cloud templates as code, tested in CI" does the same job from GitHub, GitLab, Azure Pipelines or Jenkins against the same APIs.',
          'The YAML keys follow an 8.x export. Task input fields in particular — the Blueprint task’s, the output paths like ${Stage.Task.output…} — should be checked against an export from your own instance before the rest is imported.',
          'import.sh uses /pipeline/api/import and /pipeline/api/variables, the paths the VMware code-stream-cli uses. The same service answers under /codestream/api on 8.x appliances.',
          'Variables of type SECRET are masked in the interface and in execution logs. Hosts are REGULAR. A webhook URL is SECRET because chat webhooks carry their credential in the URL.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'pipe_template_ci',
    platform: PLATFORM,
    label: 'Cloud templates as code, tested in CI',
    group: 'VCF Automation content',
    description:
      'VCF Automation cloud templates kept in git and moved by any CI: a lint on every pull request that checks inputs are constrained and resources are tagged, then on merge a real test deployment into a test project, a smoke check, the test deployment deleted whatever happened, and only then a new, immutable version released from main.',
    inputs: [
      { id: 'ci', label: 'Runs on', control: 'select', options: CI_OPTIONS_ALL, default: 'github' },
      { id: 'templates_dir', label: 'Templates live in', control: 'text', default: 'templates/', hint: 'One folder per template: blueprint.yaml, blueprint-id.txt, test-inputs.json' },
      { id: 'test_project', label: 'Test deployments go to project', control: 'text', default: 'Template CI — test' },
      { id: 'prod_project', label: 'The templates belong to project', control: 'text', default: 'Production' },
      { id: 'test_deploy', label: 'Deploy for real before releasing', control: 'toggle', default: true },
      { id: 'smoke_command', label: 'Smoke check (from the runner, $ADDRESS is the machine)', control: 'text', default: 'nc -z -w 10 "$ADDRESS" 22', showWhen: { input: 'test_deploy', equals: ['true'] } },
      { id: 'deploy_timeout', label: 'Give the test deployment (minutes)', control: 'number', default: 30, min: 5, max: 180 },
      { id: 'require_tags', label: 'Tags every resource must carry', control: 'text', default: 'owner, costCenter' },
      { id: 'runner_label', label: 'Self-hosted runner label', control: 'text', default: 'vcf' },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const ci = ciOf(values);
      const dir = str(values, 'templates_dir', 'templates/').replace(/\/?$/, '/');
      const testProject = str(values, 'test_project', 'Template CI — test');
      const prodProject = str(values, 'prod_project', 'Production');
      const testDeploy = bool(values, 'test_deploy', true);
      const smoke = str(values, 'smoke_command', 'true');
      const timeout = num(values, 'deploy_timeout', 30);
      const tags = listOf(str(values, 'require_tags', ''));
      const runner = str(values, 'runner_label', 'vcf');
      const base = slugOf(name || 'cloud-templates', 'cloud-templates');

      const findings: Finding[] = [];
      if (testProject.trim().toLowerCase() === prodProject.trim().toLowerCase()) {
        findings.push(
          error('pipe.template.test-is-prod', `The test project and the production project are both "${testProject}".`, {
            remediation: 'The test deployment would land beside real ones, count against production quota, and be deleted by a pipeline with rights to delete there. Use a project of its own.',
            source: SRC,
          }),
        );
      }
      if (!testDeploy) {
        findings.push(
          warning('pipe.template.untested-release', 'A version is released on merge without ever being deployed.', {
            remediation: 'The lint catches the YAML. Only a deployment catches the image that no longer exists, the network profile that was renamed, the property the cloud rejects.',
            source: SRC,
          }),
        );
      }
      if (tags.length === 0) {
        findings.push(info('pipe.template.no-tags', 'The lint does not require any tag on resources.', { remediation: 'Tags are how cost, ownership and automation scope are found later. owner and costCenter are the usual minimum.', source: SRC }));
      }

      const lint = [
        '#!/usr/bin/env bash',
        '# Lint every cloud template under the templates folder. Reads only.',
        '#',
        '# 1. yamllint for the YAML itself.',
        '# 2. The house rules: every string input offers a closed set (enum or',
        '#    oneOf), every number has a minimum and a maximum, and every resource',
        '#    carries the required tags.',
        'set -euo pipefail',
        `TEMPLATES="\${TEMPLATES:-${dir}}"`,
        `REQUIRED_TAGS="\${REQUIRED_TAGS:-${tags.join(',')}}"`,
        '',
        'yamllint -d "{extends: relaxed, rules: {line-length: disable}}" "$TEMPLATES"',
        '',
        'python3 - "$TEMPLATES" "$REQUIRED_TAGS" <<\'PY\'',
        'import pathlib, sys, yaml',
        '',
        'root, required = pathlib.Path(sys.argv[1]), [t for t in sys.argv[2].split(",") if t]',
        'problems = []',
        'for path in sorted(root.rglob("blueprint.yaml")):',
        '    doc = yaml.safe_load(path.read_text()) or {}',
        '    for key, spec in (doc.get("inputs") or {}).items():',
        '        kind = (spec or {}).get("type", "string")',
        '        if kind == "string" and not ({"enum", "oneOf", "$data", "$dynamicEnum"} & set(spec or {})) and not spec.get("readOnly"):',
        '            problems.append(f"{path}: input {key} is a free-text string — give it enum or oneOf")',
        '        if kind in ("integer", "number") and not {"minimum", "maximum"} <= set(spec or {}):',
        '            problems.append(f"{path}: input {key} has no minimum and maximum")',
        '    for rname, res in (doc.get("resources") or {}).items():',
        '        props = (res or {}).get("properties") or {}',
        '        if not str(res.get("type", "")).startswith(("Cloud.Machine", "Cloud.vSphere.Machine", "Cloud.Volume", "Cloud.vSphere.Disk")):',
        '            continue',
        '        keys = {t.get("key") for t in props.get("tags") or [] if isinstance(t, dict)}',
        '        missing = [t for t in required if t not in keys]',
        '        if missing:',
        '            problems.append(f"{path}: resource {rname} is missing tags {missing}")',
        '',
        'for problem in problems:',
        '    print(problem)',
        'print(f"{len(problems)} problem(s)")',
        'sys.exit(1 if problems else 0)',
        'PY',
        '',
      ].join('\n');

      const release = [
        '#!/usr/bin/env bash',
        '# For each template changed by the last merge: deploy it into the test project,',
        '# smoke-check it, delete the test deployment whatever happened, and only then',
        '# write the content to the template and release a new version.',
        '#',
        '# Without --execute it logs in, finds what changed and prints what it would do.',
        '# It refuses to run anywhere but main, and never overwrites a version.',
        'set -euo pipefail',
        'source "$(dirname "$0")/vcfa-lib.sh"',
        '',
        'DRY_RUN=1',
        '[[ "${1:-}" == "--execute" ]] && DRY_RUN=0',
        `TEMPLATES="\${TEMPLATES:-${dir}}"`,
        `TEST_PROJECT="\${TEST_PROJECT:-${testProject}}"`,
        `PROD_PROJECT="\${PROD_PROJECT:-${prodProject}}"`,
        `TIMEOUT_MIN="\${TIMEOUT_MIN:-${timeout}}"`,
        'BASE_REF="${BASE_REF:-HEAD~1}"',
        'BRANCH="${BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"',
        '',
        'if [[ "$BRANCH" != "main" ]] && (( ! DRY_RUN )); then',
        '  echo "Refusing to release from $BRANCH. Releases come from main only." >&2',
        '  exit 1',
        'fi',
        '',
        'mkdir -p out',
        ': > out/test-deployments.txt',
        'changed=$(git diff --name-only "$BASE_REF" HEAD -- "$TEMPLATES" | awk -F/ \'{print $(NF-1)}\' | sort -u)',
        '[[ -z "$changed" ]] && { echo "No template changed."; exit 0; }',
        '',
        'vcfa_login',
        'TEST_PROJECT_ID=$(vcfa_project_id "$TEST_PROJECT")',
        'PROD_PROJECT_ID=$(vcfa_project_id "$PROD_PROJECT")',
        '[[ -n "$TEST_PROJECT_ID" && -n "$PROD_PROJECT_ID" ]] || { echo "project not found" >&2; exit 1; }',
        '[[ "$TEST_PROJECT_ID" != "$PROD_PROJECT_ID" ]] || { echo "the test project is the production project" >&2; exit 1; }',
        '',
        'VERSION="$(date -u +%Y.%m.%d)-$(git rev-parse --short HEAD)"',
        '',
        'for tpl in $changed; do',
        '  folder=$(find "$TEMPLATES" -type d -name "$tpl" | head -1)',
        '  [[ -f "$folder/blueprint.yaml" && -f "$folder/blueprint-id.txt" ]] || { echo "skip $tpl: needs blueprint.yaml and blueprint-id.txt"; continue; }',
        '  id=$(tr -d "[:space:]" < "$folder/blueprint-id.txt")',
        '  inputs=$(cat "$folder/test-inputs.json" 2>/dev/null || echo "{}")',
        '',
        '  # Versions are immutable. If this one exists, stop rather than overwrite.',
        '  if vcfa GET "/blueprint/api/blueprints/$id/versions/$VERSION" >/dev/null 2>&1; then',
        '    echo "$tpl: version $VERSION already exists — not overwriting" >&2',
        '    exit 1',
        '  fi',
        '',
        '  if (( DRY_RUN )); then',
        ...(testDeploy
          ? ['    echo "DRY RUN: $tpl ($id) — would deploy to $TEST_PROJECT, smoke-check, delete, then release $VERSION"']
          : ['    echo "DRY RUN: $tpl ($id) — would release $VERSION with no test deployment"']),
        '    continue',
        '  fi',
        '',
        ...(testDeploy
          ? [
              '  # 1. Test deployment, from the content in git rather than the draft in the',
              '  #    instance, into the test project.',
              '  req=$(jq -n --rawfile c "$folder/blueprint.yaml" --arg b "$id" --arg p "$TEST_PROJECT_ID" \\',
              '        --arg n "ci-$tpl-$(git rev-parse --short HEAD)" --argjson i "$inputs" \\',
              '        \'{blueprintId: $b, content: $c, projectId: $p, deploymentName: $n, inputs: $i, reason: "CI test deployment"}\')',
              '  resp=$(vcfa POST /blueprint/api/blueprint-requests "$req")',
              '  request_id=$(echo "$resp" | jq -r .id)',
              '  deployment_id=$(echo "$resp" | jq -r .deploymentId)',
              '  echo "$deployment_id" >> out/test-deployments.txt   # delete-test.sh reads this, always',
              '  echo "$tpl: test deployment $deployment_id (request $request_id)"',
              '',
              '  # 2. Poll until it finishes.',
              '  deadline=$(( $(date +%s) + TIMEOUT_MIN * 60 ))',
              '  while :; do',
              '    status=$(vcfa GET "/blueprint/api/blueprint-requests/$request_id" | jq -r .status)',
              '    case "$status" in',
              '      FINISHED) break ;;',
              '      FAILED|CANCELLED) echo "$tpl: test deployment $status" >&2; exit 1 ;;',
              '    esac',
              '    (( $(date +%s) < deadline )) || { echo "$tpl: test deployment timed out" >&2; exit 1; }',
              '    sleep 20',
              '  done',
              '',
              '  # 3. Smoke check against the first machine\'s address.',
              '  ADDRESS=$(vcfa GET "/deployment/api/deployments/$deployment_id/resources" \\',
              '    | jq -r \'[.content[] | select(.type | test("Machine")) | .properties.address][0] // empty\')',
              '  [[ -n "$ADDRESS" ]] || { echo "$tpl: no machine address to check" >&2; exit 1; }',
              '  export ADDRESS',
              `  ( ${smoke} ) || { echo "$tpl: smoke check failed on $ADDRESS" >&2; exit 1; }`,
              '  echo "$tpl: smoke check passed on $ADDRESS"',
              '',
            ]
          : []),
        '  # 4. Write the tested content to the template, then release a new version.',
        '  current=$(vcfa GET "/blueprint/api/blueprints/$id")',
        '  body=$(echo "$current" | jq --rawfile c "$folder/blueprint.yaml" \'{name, description, projectId, content: $c}\')',
        '  vcfa PUT "/blueprint/api/blueprints/$id" "$body" >/dev/null',
        '  vcfa POST "/blueprint/api/blueprints/$id/versions" \\',
        '    "$(jq -n --arg v "$VERSION" --arg log "$(git log -1 --pretty=%s)" \'{version: $v, release: true, description: "Released by CI", changeLog: $log}\')" >/dev/null',
        '  echo "$tpl: released $VERSION"',
        'done',
        '',
        '# Undo: POST /blueprint/api/blueprints/{id}/versions/{version}/actions/unrelease,',
        '# and release the previous version again.',
        '',
      ].join('\n');

      const deleteTest = [
        '#!/usr/bin/env bash',
        '# Delete every test deployment release-templates.sh recorded. Run always —',
        '# after success, failure, timeout or cancel — so a failed test never leaves a',
        '# machine behind in the test project.',
        'set -uo pipefail',
        'source "$(dirname "$0")/vcfa-lib.sh"',
        '[[ -s out/test-deployments.txt ]] || { echo "No test deployment to delete."; exit 0; }',
        'vcfa_login',
        'rc=0',
        'while read -r id; do',
        '  [[ -z "$id" || "$id" == "null" ]] && continue',
        '  echo "Deleting test deployment $id"',
        '  vcfa DELETE "/deployment/api/deployments/$id" >/dev/null || { echo "could not delete $id — delete it by hand" >&2; rc=1; }',
        'done < out/test-deployments.txt',
        'exit $rc',
        '',
      ].join('\n');

      const env = {
        github: [
          'name: Cloud templates',
          '',
          '# Generated by ArchToolKit.',
          '#',
          '# Lint on every pull request. On a merge to main: test deployment, smoke',
          '# check, delete the test deployment (always), release a new version.',
          'on:',
          '  pull_request:',
          `    paths: ['${dir}**']`,
          '  push:',
          '    branches: [main]',
          `    paths: ['${dir}**']`,
          '',
          'permissions:',
          '  contents: read',
          '',
          'concurrency:',
          '  group: cloud-templates-release',
          '  cancel-in-progress: false',
          '',
          'jobs:',
          '  lint:',
          '    runs-on: ubuntu-latest',
          '    steps:',
          '      - uses: actions/checkout@v4',
          '      - run: pip install --quiet yamllint',
          '      - run: ci/lint-templates.sh',
          '',
          '  release:',
          "    if: github.ref == 'refs/heads/main' && github.event_name == 'push'",
          '    needs: lint',
          '    # VCF Automation is not on the internet. This runs inside the network.',
          `    runs-on: [self-hosted, ${runner}]`,
          '    environment: vcf-automation',
          `    timeout-minutes: ${timeout + 20}`,
          '    env:',
          '      VCFA_HOST: ${{ vars.VCFA_HOST }}',
          '      VCFA_REFRESH_TOKEN: ${{ secrets.VCFA_REFRESH_TOKEN }}',
          '    steps:',
          '      - uses: actions/checkout@v4',
          '        with: { fetch-depth: 2 }',
          '      - name: Test deployment, smoke check, release',
          '        run: ci/release-templates.sh --execute',
          '      - name: Delete the test deployment',
          '        if: always()',
          '        run: ci/delete-test.sh',
          '',
        ],
        gitlab: [
          '# Generated by ArchToolKit.',
          '#',
          '# VCFA_HOST and VCFA_REFRESH_TOKEN are CI/CD variables — the token masked and',
          '# protected, so only main can read it.',
          'stages: [lint, release]',
          '',
          'lint:',
          '  stage: lint',
          '  image: python:3.12-slim',
          '  rules:',
          '    - if: $CI_PIPELINE_SOURCE == "merge_request_event"',
          `      changes: ['${dir}**/*']`,
          '    - if: $CI_COMMIT_BRANCH == "main"',
          `      changes: ['${dir}**/*']`,
          '  script:',
          '    - pip install --quiet yamllint',
          '    - ci/lint-templates.sh',
          '',
          'release:',
          '  stage: release',
          `  tags: [${runner}]   # a runner inside the network`,
          '  resource_group: cloud-templates-release',
          `  timeout: ${timeout + 20}m`,
          '  variables:',
          '    GIT_DEPTH: "2"',
          '  rules:',
          '    - if: $CI_COMMIT_BRANCH == "main"',
          `      changes: ['${dir}**/*']`,
          '  script:',
          '    - ci/release-templates.sh --execute',
          '  after_script:',
          '    # after_script runs whether the script passed, failed or was cancelled.',
          '    - ci/delete-test.sh',
          '',
        ],
        azdo: [
          '# Generated by ArchToolKit.',
          '#',
          '# VCFA_REFRESH_TOKEN is a secret variable. Secret variables are not given to',
          '# scripts unless mapped in env:, which is done below and nowhere else.',
          'trigger:',
          '  branches: { include: [main] }',
          `  paths: { include: ['${dir}'] }`,
          'pr:',
          '  branches: { include: ["*"] }',
          `  paths: { include: ['${dir}'] }`,
          '',
          'stages:',
          '  - stage: lint',
          '    pool: { vmImage: ubuntu-latest }',
          '    jobs:',
          '      - job: lint',
          '        steps:',
          '          - script: pip install --quiet yamllint && ci/lint-templates.sh',
          '',
          '  - stage: release',
          "    condition: and(succeeded(), eq(variables['Build.SourceBranch'], 'refs/heads/main'), ne(variables['Build.Reason'], 'PullRequest'))",
          '    jobs:',
          '      - deployment: release',
          `        pool: { name: ${runner} }   # a self-hosted agent pool inside the network`,
          '        environment: vcf-automation',
          `        timeoutInMinutes: ${timeout + 20}`,
          '        strategy:',
          '          runOnce:',
          '            deploy:',
          '              steps:',
          '                - checkout: self',
          '                  fetchDepth: 2',
          '                - script: ci/release-templates.sh --execute',
          '                  env:',
          '                    VCFA_HOST: $(VCFA_HOST)',
          '                    VCFA_REFRESH_TOKEN: $(VCFA_REFRESH_TOKEN)',
          '                - script: ci/delete-test.sh',
          '                  condition: always()',
          '                  env:',
          '                    VCFA_HOST: $(VCFA_HOST)',
          '                    VCFA_REFRESH_TOKEN: $(VCFA_REFRESH_TOKEN)',
          '',
        ],
        jenkins: [
          '// Generated by ArchToolKit.',
          '//',
          '// vcfa-refresh-token is a "secret text" credential. It is bound for the',
          '// release stage only and masked in the log.',
          'pipeline {',
          `  agent { label '${runner}' }   // inside the network`,
          '  options { disableConcurrentBuilds(); timeout(time: ' + (timeout + 20) + ', unit: \'MINUTES\') }',
          '  stages {',
          '    stage(\'Lint\') {',
          '      steps {',
          '        sh \'pip install --quiet --user yamllint && PATH="$HOME/.local/bin:$PATH" ci/lint-templates.sh\'',
          '      }',
          '    }',
          '    stage(\'Release\') {',
          '      when { branch \'main\' }',
          '      environment {',
          '        VCFA_HOST = "${env.VCFA_HOST}"',
          '        VCFA_REFRESH_TOKEN = credentials(\'vcfa-refresh-token\')',
          '      }',
          '      steps {',
          '        sh \'ci/release-templates.sh --execute\'',
          '      }',
          '      post {',
          '        always { sh \'ci/delete-test.sh\' }',
          '      }',
          '    }',
          '  }',
          '}',
          '',
        ],
      }[ci];

      const sampleIds = [
        '# Each template folder holds three files:',
        '#',
        '#   blueprint.yaml     the template content',
        '#   blueprint-id.txt   the id of the template in VCF Automation (create it once',
        '#                      by hand in the production project, then paste the id)',
        '#   test-inputs.json   inputs for the test deployment, e.g. {"size": "small"}',
        '#',
        '# The test inputs should pick the smallest size the template offers. A test',
        '# deployment is paid for like any other.',
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `Cloud templates in git, released by ${CI_LABEL[ci]} after a test deployment`,
        effect: 'reversible',
        trigger: { kind: 'commit', detail: `A pull request touching ${dir} is linted; a merge to main${testDeploy ? ' test-deploys into "' + testProject + '" and then' : ''} releases a version`, worstCase: 'once per merge, one at a time' },
        scope: {
          what: `The templates under ${dir} whose folder changed in the merge, their versions in "${prodProject}", and short-lived test deployments in "${testProject}".`,
          decidedBy: [
            'git diff between the merge and its parent — only changed folders are touched.',
            'blueprint-id.txt in each folder, which names the template the content is written to.',
            `The test project "${testProject}", resolved by name on each run.`,
            'The rights of the account behind the refresh token.',
          ],
          ifWrong: 'A wrong blueprint-id.txt writes one template’s content into another and releases it. The version history keeps the previous one, so it can be unreleased — but anyone who requested it in between got the wrong machine.',
        },
        guardrails: [
          { rule: 'Released from main only', because: 'The script refuses anything else, and the CI only runs the release job there. A branch build lints and stops.' },
          ...(testDeploy
            ? [
                { rule: 'Deployed for real before release', because: 'A template that lints can still fail to deploy — a renamed image, a network profile that moved.' },
                { rule: 'The test deployment is always deleted', because: `delete-test.sh runs in ${ci === 'github' ? 'an if: always() step' : ci === 'gitlab' ? 'after_script' : ci === 'azdo' ? 'a condition: always() step' : 'post { always }'}, so a failure or a timeout does not leave a machine behind.` },
              ]
            : []),
          { rule: 'Versions are immutable', because: 'The script stops if the version already exists. A version someone deployed from must mean the same content forever.' },
          { rule: 'Test and production projects must differ', because: 'The script checks the resolved ids and refuses if they are the same.' },
          { rule: 'One release at a time', because: 'Two merges released side by side can finish in the wrong order.' },
        ],
        dryRun: [
          'ci/release-templates.sh without --execute logs in, lists the changed templates and says what it would do.',
          'ci/lint-templates.sh runs on every pull request and changes nothing.',
        ],
        undo: [
          'POST /blueprint/api/blueprints/{id}/versions/{version}/actions/unrelease, then release the previous version again.',
          'Or revert the commit — the next run releases the reverted content as a new version.',
          'Deployments already made from a bad version are not changed by either.',
        ],
        told: [
          `The ${CI_LABEL[ci]} run log, which lists every template, test deployment and version.`,
          'The version’s changeLog, which carries the commit subject.',
          `A failed ${CI_LABEL[ci]} run notifies the way your CI already does — make sure somebody receives it.`,
        ],
        requires: [
          `A refresh token for a service account in ${secretStore(ci)}, as VCFA_REFRESH_TOKEN, and VCFA_HOST as a plain variable.`,
          `A self-hosted runner labelled "${runner}" inside the network — VCF Automation is not reachable from hosted runners.`,
          'jq, curl, python3 with PyYAML (yamllint brings it) on the runner.',
          `A test project "${testProject}" with a short lease policy, so anything that escapes deletion expires anyway.`,
        ],
        files: {
          [ciFile(ci, base)]: env.join('\n'),
          'IMPORT.md': ciImportMd(ci, ciFile(ci, base), env.join('\n'), runner),
          'ci/vcfa-lib.sh': VCFA_LIB,
          'ci/lint-templates.sh': lint,
          'ci/release-templates.sh': release,
          'ci/delete-test.sh': deleteTest,
          [`${dir}README-layout.txt`]: sampleIds,
        },
        notes: [
          'The test deployment is made from the content in git (the content field of a blueprint request), so the draft in the instance is only written once the test has passed.',
          'The version name is the date and the short commit, so every version points at the commit that produced it.',
          VCFA_LOGIN_NOTE,
          'The blueprint-requests and versions fields are the 8.x ones. Check them against the API documentation your instance serves before the first --execute.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'pipe_ops_promotion',
    platform: PLATFORM,
    label: 'Promote VCF Operations content from test to production',
    group: 'VCF Operations content',
    description:
      'Alert definitions, symptoms and super metrics built in a test instance, promoted to production through a pull request. Built on the one-file-per-object layout of the nightly content backup: the difference between the test and production folders becomes a plan, the pull request shows it with a dry run against production, and a merge applies it — matched by name, never deleting anything.',
    inputs: [
      { id: 'ci', label: 'Runs on', control: 'select', options: CI_OPTIONS_NO_JENKINS, default: 'github' },
      { id: 'test_env', label: 'Test folder', control: 'text', default: 'test', hint: 'The environment name the nightly backup of the test instance writes' },
      { id: 'prod_env', label: 'Production folder', control: 'text', default: 'production' },
      { id: 'symptoms', label: 'Symptom definitions', control: 'toggle', default: true },
      { id: 'alerts', label: 'Alert definitions', control: 'toggle', default: true },
      { id: 'super_metrics', label: 'Super metrics', control: 'toggle', default: true },
      { id: 'runner_label', label: 'Self-hosted runner label', control: 'text', default: 'vcf' },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const ci = ciOf(values);
      const testEnv = slugOf(str(values, 'test_env', 'test'), 'test');
      const prodEnv = slugOf(str(values, 'prod_env', 'production'), 'production');
      const kinds = [
        ...(bool(values, 'symptoms', true) ? ['symptomDefinitions'] : []),
        ...(bool(values, 'super_metrics', true) ? ['superMetrics'] : []),
        ...(bool(values, 'alerts', true) ? ['alertDefinitions'] : []),
      ];
      const runner = str(values, 'runner_label', 'vcf');
      const base = slugOf(name || 'vcfops-promotion', 'vcfops-promotion');

      const findings: Finding[] = [];
      if (testEnv === prodEnv) {
        findings.push(error('pipe.promote.same-folder', `Test and production are both "${testEnv}".`, { remediation: 'Promotion is the difference between two folders. With one folder there is nothing to promote.', source: SRC }));
      }
      if (kinds.length === 0) {
        findings.push(error('pipe.promote.nothing', 'No content kind is selected.', { source: SRC }));
      }
      if (kinds.includes('alertDefinitions') && !kinds.includes('symptomDefinitions')) {
        findings.push(
          warning('pipe.promote.alerts-without-symptoms', 'Alerts are promoted without their symptoms.', {
            remediation: 'An alert refers to its symptoms. If a symptom does not already exist in production under the same name, the alert cannot be created. Promote both.',
            source: SRC,
          }),
        );
      }
      if (ci === 'gitlab' || ci === 'azdo') {
        findings.push(info('pipe.promote.pr-comment', `On ${CI_LABEL[ci]} the dry run is attached as a job artifact${ci === 'gitlab' ? ' and posted as a merge request note if GITLAB_API_TOKEN is set' : ' and on the run summary'}.`, { source: SRC }));
      }

      const promote = [
        '#!/usr/bin/env python3',
        '"""Promote VCF Operations content from the test folder to production.',
        '',
        'Generated by ArchToolKit. Three commands:',
        '',
        '  plan    compare the test and production folders (the nightly backups) and',
        '          write promotion/plan.json and promotion/PLAN.md. Run it on a branch,',
        '          edit plan.json to drop anything not ready, and open a pull request.',
        '  check   dry run against live production: resolve every name and print what',
        '          apply would create or update. Changes nothing.',
        '  apply   the same, and with --execute it sends the changes.',
        '',
        'Objects are matched by name, never by id — ids differ between instances. Ids',
        'are stripped from every payload, and alert references to symptoms are mapped',
        'from test ids to names to production ids. Nothing is ever deleted.',
        '',
        'Reads VCFOPS_HOST and VCFOPS_USER / VCFOPS_PASSWORD (or VCFOPS_TOKEN) from the',
        'environment. VCFOPS_CA_BUNDLE, if set, is the CA to trust.',
        '"""',
        '',
        'import argparse',
        'import hashlib',
        'import json',
        'import os',
        'import pathlib',
        'import ssl',
        'import sys',
        'import urllib.request',
        '',
        `TEST = pathlib.Path("${testEnv}")`,
        `PROD = pathlib.Path("${prodEnv}")`,
        'PLAN = pathlib.Path("promotion/plan.json")',
        '',
        '# folder -> (suite-api path, list key). Order matters: symptoms before the',
        '# alerts that refer to them.',
        'KINDS = {',
        ...kinds.map((kind) => `    "${kind}": ("${kind === 'symptomDefinitions' ? 'symptomdefinitions' : kind === 'superMetrics' ? 'supermetrics' : 'alertdefinitions'}", "${kind}"),`),
        '}',
        '',
        '',
        'def load(root, folder):',
        '    """name -> object, from one-file-per-object JSON."""',
        '    out = {}',
        '    for path in sorted((root / folder).glob("*.json")):',
        '        obj = json.loads(path.read_text())',
        '        out[obj["name"]] = obj',
        '    return out',
        '',
        '',
        'def symptom_names(root):',
        '    return {o.get("id"): n for n, o in load(root, "symptomDefinitions").items()} if (root / "symptomDefinitions").exists() else {}',
        '',
        '',
        'def remap(value, table, missing):',
        '    """Replace every symptomDefinitionIds list through table, recursively."""',
        '    if isinstance(value, dict):',
        '        out = {}',
        '        for k, v in value.items():',
        '            if k == "symptomDefinitionIds":',
        '                mapped = []',
        '                for ref in v:',
        '                    if ref in table:',
        '                        mapped.append(table[ref])',
        '                    else:',
        '                        missing.append(ref)',
        '                        mapped.append(ref)',
        '                out[k] = mapped',
        '            else:',
        '                out[k] = remap(v, table, missing)',
        '        return out',
        '    if isinstance(value, list):',
        '        return [remap(v, table, missing) for v in value]',
        '    return value',
        '',
        '',
        'def normalise(kind, obj, names):',
        '    """What is compared and sent: no id, symptom references as names."""',
        '    obj = {k: v for k, v in obj.items() if k not in ("id", "links")}',
        '    if kind == "alertDefinitions":',
        '        obj = remap(obj, names, [])',
        '        for state in obj.get("states", []):',
        '            # Recommendations have no name to match on. They are not promoted;',
        '            # attach them in production by hand.',
        '            state.pop("recommendationPriorityMap", None)',
        '    return obj',
        '',
        '',
        'def digest(obj):',
        '    return hashlib.sha256(json.dumps(obj, sort_keys=True).encode()).hexdigest()[:16]',
        '',
        '',
        'def plan():',
        '    entries, only_prod = [], []',
        '    tnames, pnames = symptom_names(TEST), symptom_names(PROD)',
        '    for kind in KINDS:',
        '        test, prod = load(TEST, kind), load(PROD, kind)',
        '        for name, obj in test.items():',
        '            t = normalise(kind, obj, tnames)',
        '            if name not in prod:',
        '                entries.append({"kind": kind, "name": name, "action": "create", "sha": digest(t)})',
        '            elif t != normalise(kind, prod[name], pnames):',
        '                entries.append({"kind": kind, "name": name, "action": "update", "sha": digest(t)})',
        '        only_prod += [f"{kind}: {n}" for n in prod if n not in test]',
        '    PLAN.parent.mkdir(exist_ok=True)',
        '    PLAN.write_text(json.dumps({"entries": entries}, indent=2) + "\\n")',
        '    lines = ["# Promotion plan", "", f"{len(entries)} object(s) from {TEST} to {PROD}.", ""]',
        '    lines += [f"- **{e[\'action\']}** {e[\'kind\']}: {e[\'name\']}" for e in entries]',
        '    if only_prod:',
        '        lines += ["", "Only in production — left alone, never deleted:", ""] + [f"- {x}" for x in only_prod]',
        '    pathlib.Path("promotion/PLAN.md").write_text("\\n".join(lines) + "\\n")',
        '    print("\\n".join(lines))',
        '',
        '',
        'class Ops:',
        '    def __init__(self):',
        '        self.host = os.environ["VCFOPS_HOST"]',
        '        self.ctx = ssl.create_default_context(cafile=os.environ.get("VCFOPS_CA_BUNDLE"))',
        '        self.auth = os.environ.get("VCFOPS_TOKEN") or self.acquire()',
        '',
        '    def call(self, method, path, body=None):',
        '        req = urllib.request.Request(',
        '            f"https://{self.host}/suite-api/api/{path}",',
        '            data=json.dumps(body).encode() if body is not None else None,',
        '            method=method,',
        '            headers={"Accept": "application/json", "Content-Type": "application/json",',
        '                     **({"Authorization": f"OpsToken {self.auth}"} if getattr(self, "auth", None) else {})},',
        '        )',
        '        with urllib.request.urlopen(req, context=self.ctx, timeout=60) as resp:',
        '            raw = resp.read()',
        '            return json.loads(raw) if raw else {}',
        '',
        '    def acquire(self):',
        '        body = {"username": os.environ["VCFOPS_USER"], "password": os.environ["VCFOPS_PASSWORD"]}',
        '        return self.call("POST", "auth/token/acquire", body)["token"]',
        '',
        '    def by_name(self, kind):',
        '        path, key = KINDS[kind]',
        '        return {o["name"]: o for o in self.call("GET", f"{path}?pageSize=10000").get(key, [])}',
        '',
        '',
        'def apply(execute):',
        '    entries = json.loads(PLAN.read_text())["entries"]',
        '    tnames = symptom_names(TEST)',
        '    ops = Ops()',
        '    problems = 0',
        '    for kind in KINDS:',
        '        test = load(TEST, kind)',
        '        live = ops.by_name(kind)',
        '        prod_symptoms = ops.by_name("symptomDefinitions") if kind == "alertDefinitions" and "symptomDefinitions" in KINDS else {}',
        '        for entry in [e for e in entries if e["kind"] == kind]:',
        '            name = entry["name"]',
        '            if name not in test:',
        '                print(f"SKIP {kind}: {name} — no longer in {TEST}")',
        '                continue',
        '            body = normalise(kind, test[name], tnames)',
        '            if digest(body) != entry["sha"]:',
        '                print(f"REFUSE {kind}: {name} — changed in {TEST} since the plan was reviewed")',
        '                problems += 1',
        '                continue',
        '            if kind == "alertDefinitions":',
        '                missing = []',
        '                body = remap(body, {n: o["id"] for n, o in prod_symptoms.items()}, missing)',
        '                if missing:',
        '                    print(f"REFUSE {kind}: {name} — symptoms not in production: {missing}")',
        '                    problems += 1',
        '                    continue',
        '            path, _ = KINDS[kind]',
        '            if name in live:',
        '                body["id"] = live[name]["id"]',
        '                verb, method = "update", "PUT"',
        '            else:',
        '                verb, method = "create", "POST"',
        '            if not execute:',
        '                print(f"DRY RUN: would {verb} {kind}: {name}")',
        '                continue',
        '            ops.call(method, path, body)',
        '            print(f"{verb}d {kind}: {name}")',
        '        if execute and kind == "symptomDefinitions":',
        '            pass  # the alerts pass re-reads production symptoms, so new ones resolve',
        '    if not execute:',
        '        print("Nothing was changed.")',
        '    return 1 if problems else 0',
        '',
        '',
        'def main():',
        '    parser = argparse.ArgumentParser()',
        '    parser.add_argument("command", choices=["plan", "check", "apply"])',
        '    parser.add_argument("--execute", action="store_true")',
        '    args = parser.parse_args()',
        '    if args.command == "plan":',
        '        plan()',
        '        return 0',
        '    return apply(args.command == "apply" and args.execute)',
        '',
        '',
        'if __name__ == "__main__":',
        '    sys.exit(main())',
        '',
      ].join('\n');

      const env = {
        github: [
          'name: Promote VCF Operations content',
          '',
          '# Generated by ArchToolKit.',
          '#',
          '# A pull request that changes promotion/plan.json gets a dry run against',
          '# production posted on it. A merge to main applies the plan.',
          '#',
          '# The dry run executes the pull request’s own promote.py on a runner inside the',
          '# network, so it is gated three ways: only for branches of this repository',
          '# (never a fork), only after someone allowed by the vcfops-dry-run environment',
          '# approves the run, and only with a read-only production account, held as an',
          '# environment secret so no other job can read it.',
          'on:',
          '  pull_request:',
          "    paths: ['promotion/**']",
          '  push:',
          '    branches: [main]',
          "    paths: ['promotion/**']",
          '',
          'permissions:',
          '  contents: read',
          '',
          'concurrency:',
          '  group: vcfops-promotion',
          '  cancel-in-progress: false',
          '',
          'jobs:',
          '  dry-run:',
          '    # Same-repository pull requests only: a fork’s code never reaches this runner.',
          "    if: github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository",
          `    runs-on: [self-hosted, ${runner}]`,
          '    # Protected: set required reviewers on this environment, and keep the',
          '    # read-only account’s secret here rather than in the repository.',
          '    environment: vcfops-dry-run',
          '    permissions:',
          '      contents: read',
          '      pull-requests: write',
          '    env:',
          '      VCFOPS_HOST: ${{ vars.VCFOPS_PROD_HOST }}',
          '      VCFOPS_USER: ${{ vars.VCFOPS_READONLY_USER }}',
          '      VCFOPS_PASSWORD: ${{ secrets.VCFOPS_READONLY_PASSWORD }}',
          '    steps:',
          '      - uses: actions/checkout@v4',
          '        with: { persist-credentials: false }',
          '      - run: python3 promotion/promote.py check | tee dry-run.txt',
          '      - uses: actions/upload-artifact@v4',
          '        with: { name: dry-run, path: dry-run.txt }',
          '      - name: Post the dry run on the pull request',
          '        env:',
          '          GH_TOKEN: ${{ github.token }}',
          '        run: |',
          '          { echo "Dry run against production:"; echo; echo \'```\'; cat dry-run.txt; echo \'```\'; } > comment.md',
          '          gh pr comment ${{ github.event.pull_request.number }} --body-file comment.md',
          '',
          '  apply:',
          "    if: github.ref == 'refs/heads/main' && github.event_name == 'push'",
          `    runs-on: [self-hosted, ${runner}]`,
          '    environment: vcfops-production',
          '    env:',
          '      VCFOPS_HOST: ${{ vars.VCFOPS_PROD_HOST }}',
          '      VCFOPS_USER: ${{ vars.VCFOPS_PROMOTION_USER }}',
          '      VCFOPS_PASSWORD: ${{ secrets.VCFOPS_PROMOTION_PASSWORD }}',
          '    steps:',
          '      - uses: actions/checkout@v4',
          '      - run: python3 promotion/promote.py check',
          '      - run: python3 promotion/promote.py apply --execute | tee applied.txt',
          '      - uses: actions/upload-artifact@v4',
          '        if: always()',
          '        with: { name: applied, path: applied.txt }',
          '',
        ],
        gitlab: [
          '# Generated by ArchToolKit.',
          '#',
          '# VCFOPS_PROMOTION_PASSWORD is a masked, protected CI/CD variable. Protected',
          '# means only main can read it — set a separate read-only account for the',
          '# merge request dry run as VCFOPS_READONLY_PASSWORD, masked and scoped to the',
          '# vcfops-dry-run environment.',
          '#',
          '# The dry run executes the merge request’s own promote.py on a runner inside',
          '# the network, so it runs only for branches of this project (never a fork) and',
          '# only through vcfops-dry-run, which should be a protected environment whose',
          '# deployers are the people who may review promotions.',
          '#',
          '# GITLAB_API_TOKEN, if set, is a project access token with the Reporter role',
          '# and an expiry date, also scoped to vcfops-dry-run. It is sent as a header by',
          '# python, never on a command line.',
          'stages: [dry-run, apply]',
          '',
          'dry-run:',
          '  stage: dry-run',
          `  tags: [${runner}]`,
          '  image: python:3.12-slim',
          '  rules:',
          '    - if: $CI_PIPELINE_SOURCE == "merge_request_event" && $CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_PROJECT_ID',
          "      changes: ['promotion/**/*']",
          '  environment: vcfops-dry-run   # protected: only its allowed deployers can run this job',
          '  variables:',
          '    VCFOPS_HOST: $VCFOPS_PROD_HOST',
          '    VCFOPS_USER: $VCFOPS_READONLY_USER',
          '    VCFOPS_PASSWORD: $VCFOPS_READONLY_PASSWORD',
          '  script:',
          '    - python3 promotion/promote.py check | tee dry-run.txt',
          '    - |',
          '      if [ -n "${GITLAB_API_TOKEN:-}" ]; then',
          '        python3 - <<\'PY\'',
          '      import json, os, urllib.request',
          '      body = {"body": "Dry run against production:\\n\\n```\\n" + open("dry-run.txt").read() + "\\n```"}',
          '      url = f"{os.environ[\'CI_API_V4_URL\']}/projects/{os.environ[\'CI_PROJECT_ID\']}/merge_requests/{os.environ[\'CI_MERGE_REQUEST_IID\']}/notes"',
          '      req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",',
          '                                   headers={"PRIVATE-TOKEN": os.environ["GITLAB_API_TOKEN"], "Content-Type": "application/json"})',
          '      urllib.request.urlopen(req, timeout=30).read()',
          '      PY',
          '      fi',
          '  artifacts:',
          '    expose_as: dry run',
          '    paths: [dry-run.txt]',
          '',
          'apply:',
          '  stage: apply',
          `  tags: [${runner}]`,
          '  image: python:3.12-slim',
          '  resource_group: vcfops-production',
          '  environment: vcfops-production',
          '  rules:',
          '    - if: $CI_COMMIT_BRANCH == "main"',
          "      changes: ['promotion/**/*']",
          '  variables:',
          '    VCFOPS_HOST: $VCFOPS_PROD_HOST',
          '    VCFOPS_USER: $VCFOPS_PROMOTION_USER',
          '    VCFOPS_PASSWORD: $VCFOPS_PROMOTION_PASSWORD',
          '  script:',
          '    - python3 promotion/promote.py check',
          '    - python3 promotion/promote.py apply --execute | tee applied.txt',
          '  artifacts:',
          '    when: always',
          '    paths: [applied.txt]',
          '',
        ],
        azdo: [
          '# Generated by ArchToolKit.',
          '#',
          '# Secret variables reach scripts only through env:, mapped below.',
          'trigger:',
          '  branches: { include: [main] }',
          "  paths: { include: ['promotion/'] }",
          'pr:',
          '  branches: { include: ["*"] }',
          "  paths: { include: ['promotion/'] }",
          '',
          `pool: { name: ${runner} }   # a self-hosted agent pool inside the network`,
          '',
          'stages:',
          '  # The dry run executes the pull request’s own promote.py inside the network:',
          '  # never for a fork, only after the approvals and checks set on the',
          '  # vcfops-dry-run environment, and only with the read-only account.',
          '  - stage: dry_run',
          "    condition: and(eq(variables['Build.Reason'], 'PullRequest'), ne(variables['System.PullRequest.IsFork'], 'True'))",
          '    jobs:',
          '      - deployment: dry_run',
          '        environment: vcfops-dry-run',
          '        strategy:',
          '          runOnce:',
          '            deploy:',
          '              steps:',
          '                - checkout: self',
          '                - script: |',
          '                    python3 promotion/promote.py check | tee $(Build.ArtifactStagingDirectory)/dry-run.txt',
          '                    echo "##vso[task.uploadsummary]$(Build.ArtifactStagingDirectory)/dry-run.txt"',
          '                  env:',
          '                    VCFOPS_HOST: $(VCFOPS_PROD_HOST)',
          '                    VCFOPS_USER: $(VCFOPS_READONLY_USER)',
          '                    VCFOPS_PASSWORD: $(VCFOPS_READONLY_PASSWORD)',
          '                - publish: $(Build.ArtifactStagingDirectory)/dry-run.txt',
          '                  artifact: dry-run',
          '',
          '  - stage: apply',
          "    condition: and(succeeded(), eq(variables['Build.SourceBranch'], 'refs/heads/main'), ne(variables['Build.Reason'], 'PullRequest'))",
          '    jobs:',
          '      - deployment: apply',
          '        environment: vcfops-production',
          '        strategy:',
          '          runOnce:',
          '            deploy:',
          '              steps:',
          '                - checkout: self',
          '                - script: |',
          '                    python3 promotion/promote.py check',
          '                    python3 promotion/promote.py apply --execute',
          '                  env:',
          '                    VCFOPS_HOST: $(VCFOPS_PROD_HOST)',
          '                    VCFOPS_USER: $(VCFOPS_PROMOTION_USER)',
          '                    VCFOPS_PASSWORD: $(VCFOPS_PROMOTION_PASSWORD)',
          '',
        ],
        jenkins: [],
      }[ci];

      const howTo = [
        '# Promoting content',
        '',
        'Generated by ArchToolKit. The test and production folders are written nightly by',
        `"Back up the content to git, nightly" — once with the environment name "${testEnv}"`,
        `pointed at the test instance, once with "${prodEnv}" pointed at production.`,
        '',
        '1. Build and tune the content in the test instance. Wait for the nightly backup,',
        '   or run it by hand, so the test folder has it.',
        '2. On a branch: `python3 promotion/promote.py plan`. It writes promotion/plan.json',
        '   and promotion/PLAN.md from the difference between the two folders.',
        '3. Delete from plan.json anything that is not ready. Commit, push, open a pull',
        '   request. The pipeline posts a dry run against live production on it.',
        '4. Review the folder diff, PLAN.md and the dry run. Merge.',
        '5. The merge applies the plan. The next nightly backup of production writes the',
        '   promoted objects into the production folder, and the next plan shows them as',
        '   the same.',
        '',
        '## What is not promoted',
        '',
        '- Deletions. Something only in production stays there. Delete it by hand.',
        '- Recommendations. They have no name to match on, so alerts arrive without them.',
        '- Policy enablement. A promoted alert exists in production; which policies turn it on',
        '  is a separate change — see "Turn alert definitions on or off in a policy".',
        '- Super metrics that refer to another super metric by id. Those ids differ between',
        '  instances; fix the formula in production after the first promotion.',
        '',
      ].join('\n');

      const ciPath = ciFile(ci, base);

      return {
        platform: PLATFORM,
        title: `Promote VCF Operations content from ${testEnv} to ${prodEnv}, through a pull request on ${CI_LABEL[ci]}`,
        effect: 'reversible',
        trigger: { kind: 'commit', detail: 'A pull request changing promotion/plan.json gets a dry run; a merge to main applies it to production', worstCase: 'once per merge, one at a time' },
        scope: {
          what: `The ${kinds.join(', ')} listed in promotion/plan.json, in the production VCF Operations instance.`,
          decidedBy: [
            `The difference between ${testEnv}/ and ${prodEnv}/ when the plan was made.`,
            'Whatever the reviewer left in plan.json.',
            'Name matching in production: an existing object with the same name is updated; otherwise one is created.',
            'The rights of the promotion account.',
          ],
          ifWrong: 'A production alert or super metric is overwritten with the test version — thresholds tuned for a lab applied to the estate. The previous version is in the production folder in git, which is the undo.',
        },
        guardrails: [
          { rule: 'Matched by name, never by id', because: 'Ids are assigned by each instance. Copying a test id into production updates nothing or, worse, the wrong object.' },
          { rule: 'Never deletes in production', because: 'Something missing from test is as likely to be unfinished as unwanted. A deletion is a decision for a person.' },
          { rule: 'Dry run attached to the pull request', because: 'The reviewer sees what production will do — create or update, per object — not only the file diff.' },
          { rule: 'Refuses content that changed after review', because: 'plan.json carries a hash of each object. If the test folder changed since, that object is refused rather than applied unseen.' },
          { rule: 'Applied from main only, one run at a time', because: 'The merge is the approval. A branch can only dry-run.' },
          {
            rule: 'The pull request dry run is gated: same-repository branches only, a protected environment, a read-only account',
            because: 'It runs code from an unmerged branch on a runner inside the network with production credentials in reach. A fork, or a branch that edits promote.py, would otherwise be arbitrary code with production access before anyone has reviewed it. Read-only means the worst an unreviewed branch can do is read.',
          },
        ],
        dryRun: [
          '`python3 promotion/promote.py check` resolves every name against production and prints create or update per object. It changes nothing.',
          'The pipeline runs it on every pull request, and again before the apply on main.',
        ],
        undo: [
          `Take the object’s previous file from ${prodEnv}/ in git (the nightly backup before the merge) and PUT it back to production — with its production id, which the file has.`,
          'An object that was created by the promotion can be deleted by hand; the script never deletes.',
        ],
        told: [
          'The pull request, with the plan and the dry run on it.',
          `The ${CI_LABEL[ci]} run log and its applied.txt artifact after the merge.`,
          'The production folder in git, the next night — every promoted object appears as a commit.',
        ],
        requires: [
          `"Back up the content to git, nightly" running against both instances into the same repository, as ${testEnv}/ and ${prodEnv}/.`,
          `A promotion account in production with rights to create and edit content, its password in ${secretStore(ci)}, available to main only (the vcfops-production environment).`,
          `A separate read-only production account for the pull request dry run, as VCFOPS_READONLY_USER and VCFOPS_READONLY_PASSWORD, scoped to the vcfops-dry-run environment.`,
          ci === 'github'
            ? 'The vcfops-dry-run environment with required reviewers, and "Require approval for all outside collaborators" on fork pull request workflows as a second fence.'
            : ci === 'gitlab'
              ? 'vcfops-dry-run as a protected environment (Settings → CI/CD → Protected environments), deployable only by the people who review promotions.'
              : 'The vcfops-dry-run environment with an approval check, and "Make secrets available to builds of forks" left off.',
          `A self-hosted runner labelled "${runner}" that can reach production VCF Operations. python3, no extra packages.`,
        ],
        files: {
          [ciPath]: env.join('\n'),
          'IMPORT.md': ciImportMd(ci, ciPath, env.join('\n'), runner),
          'promotion/promote.py': promote,
          'promotion/HOW-TO-PROMOTE.md': howTo,
        },
        notes: [
          'The alert definition payload shape is the one the nightly backup reads from the suite API, so what is backed up is what is sent. If a PUT is rejected, compare the body against GET /suite-api/api/alertdefinitions/{id} from production — fields added by newer releases may need removing.',
          'Symptoms are applied before alerts, so an alert whose symptom is created in the same run resolves it.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'pipe_abx_ci',
    platform: PLATFORM,
    label: 'Extensibility actions and Orchestrator packages, tested in CI',
    group: 'VCF Automation content',
    description:
      'ABX action code kept in git with unit tests that run without VCF Automation — a stub context stands in for the platform — and a merge to main that updates the action in place from the tested source. Orchestrator packages are imported over REST from the same pipeline. Subscriptions are never touched: they stay disabled until somebody turns them on.',
    inputs: [
      { id: 'ci', label: 'Runs on', control: 'select', options: CI_OPTIONS_ALL, default: 'github' },
      { id: 'runtime', label: 'Actions written in', control: 'select', options: [{ value: 'python', label: 'Python (pytest)' }, { value: 'nodejs', label: 'Node.js (node --test)' }], default: 'python' },
      { id: 'actions_dir', label: 'Actions live in', control: 'text', default: 'abx/', hint: 'One folder per action: handler, action.json, tests' },
      { id: 'include_vro', label: 'Also import Orchestrator packages', control: 'toggle', default: true },
      { id: 'vro_dir', label: 'Packages live in', control: 'text', default: 'vro/', showWhen: { input: 'include_vro', equals: ['true'] } },
      { id: 'runner_label', label: 'Self-hosted runner label', control: 'text', default: 'vcf' },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const ci = ciOf(values);
      const runtime = str(values, 'runtime', 'python') === 'nodejs' ? 'nodejs' : 'python';
      const dir = str(values, 'actions_dir', 'abx/').replace(/\/?$/, '/');
      const vro = bool(values, 'include_vro', true);
      const vroDir = str(values, 'vro_dir', 'vro/').replace(/\/?$/, '/');
      const runner = str(values, 'runner_label', 'vcf');
      const base = slugOf(name || 'abx-ci', 'abx-ci');
      const py = runtime === 'python';
      const handlerFile = py ? 'handler.py' : 'handler.js';
      const testCmd = py ? `python3 -m pytest -q ${dir}` : `node --test ${dir}`;

      const findings: Finding[] = [];
      if (vro && vroDir === dir) {
        findings.push(error('pipe.abx.same-dir', 'Actions and Orchestrator packages are in the same folder.', { remediation: 'The deploy step decides what to do by folder. Keep them apart.', source: SRC }));
      }

      const stub = py
        ? [
            '"""A stand-in for the ABX context object, for unit tests.',
            '',
            'Generated by ArchToolKit. Provides the two calls actions use most —',
            'getSecret and request — and records what was asked of it, so a test can',
            'assert on what the action would have done without VCF Automation.',
            '"""',
            '',
            '',
            'class StubContext:',
            '    def __init__(self, secrets=None, responses=None):',
            '        self._secrets = dict(secrets or {})',
            '        self._responses = dict(responses or {})',
            '        self.requests = []',
            '',
            '    def getSecret(self, value):',
            '        # Real actions receive the secret input as a reference and resolve it',
            '        # here. Tests pass stand-in values by the same reference.',
            '        return self._secrets.get(value, value)',
            '',
            '    def request(self, link, operation, body):',
            '        self.requests.append({"link": link, "operation": operation, "body": body})',
            '        return self._responses.get((operation, link), {"status": 200, "content": "{}"})',
            '',
          ].join('\n')
        : [
            '/**',
            ' * A stand-in for the ABX context object, for unit tests.',
            ' *',
            ' * Generated by ArchToolKit. Provides getSecret and request and records what',
            ' * was asked of it, so a test can assert on what the action would have done.',
            ' */',
            'class StubContext {',
            '  constructor({ secrets = {}, responses = {} } = {}) {',
            '    this._secrets = secrets;',
            '    this._responses = responses;',
            '    this.requests = [];',
            '  }',
            '  getSecret(value) {',
            '    return this._secrets[value] ?? value;',
            '  }',
            '  async request(link, operation, body) {',
            '    this.requests.push({ link, operation, body });',
            '    return this._responses[`${operation} ${link}`] ?? { status: 200, content: "{}" };',
            '  }',
            '}',
            'module.exports = { StubContext };',
            '',
          ].join('\n');

      const exampleTest = py
        ? [
            '"""Tests for the example action. Copy this beside each action\'s handler.py."""',
            '',
            'import importlib.util',
            'import pathlib',
            'import sys',
            '',
            'HERE = pathlib.Path(__file__).parent',
            'sys.path.insert(0, str(HERE.parent / "tests"))',
            'from stub_context import StubContext  # noqa: E402',
            '',
            'spec = importlib.util.spec_from_file_location("handler", HERE / "handler.py")',
            'handler = importlib.util.module_from_spec(spec)',
            'spec.loader.exec_module(handler)',
            '',
            '',
            'def test_dry_run_does_not_call_out():',
            '    context = StubContext()',
            '    result = handler.handler(context, {"__dryRun": True, "resourceNames": ["vm-01"], "deploymentId": "d-1"})',
            '    assert result["dryRun"] is True',
            '    assert context.requests == []',
            '',
            '',
            'def test_missing_inputs_do_not_raise():',
            '    # A lifecycle event can arrive with fields missing. The action must not',
            '    # take the deployment down with it.',
            '    result = handler.handler(StubContext(), {"__dryRun": True})',
            '    assert "payload" in result',
            '',
          ].join('\n')
        : [
            '// Tests for the example action. Copy this beside each action\'s handler.js.',
            'const test = require("node:test");',
            'const assert = require("node:assert");',
            'const path = require("node:path");',
            'const { StubContext } = require(path.join(__dirname, "..", "tests", "stub-context.js"));',
            'const { handler } = require(path.join(__dirname, "handler.js"));',
            '',
            'test("dry run does not call out", async () => {',
            '  const context = new StubContext();',
            '  const result = await handler(context, { __dryRun: true, resourceNames: ["vm-01"], deploymentId: "d-1" });',
            '  assert.strictEqual(result.dryRun, true);',
            '  assert.deepStrictEqual(context.requests, []);',
            '});',
            '',
            'test("missing inputs do not throw", async () => {',
            '  const result = await handler(new StubContext(), { __dryRun: true });',
            '  assert.ok("payload" in result);',
            '});',
            '',
          ].join('\n');

      const actionJson = {
        id: '<REQUIRED — the action id: GET /abx/api/resources/actions?projectId=… and match by name>',
        projectId: '<REQUIRED — the project the action belongs to>',
        name: 'example-action',
        entrypoint: 'handler',
        runtime: py ? 'python' : 'nodejs',
      };

      const deploy = [
        '#!/usr/bin/env bash',
        '# Update each ABX action whose folder changed in the last merge, from the',
        '# tested source in git. The action is updated in place: its id, inputs,',
        '# secrets and subscriptions are left exactly as they are.',
        '#',
        '# Without --execute it prints the source diff it would send.',
        '# Subscriptions are never touched here. See subscriptions-check.sh.',
        'set -euo pipefail',
        'source "$(dirname "$0")/vcfa-lib.sh"',
        '',
        'DRY_RUN=1',
        '[[ "${1:-}" == "--execute" ]] && DRY_RUN=0',
        `ACTIONS="\${ACTIONS:-${dir}}"`,
        'BASE_REF="${BASE_REF:-HEAD~1}"',
        '',
        'changed=$(git diff --name-only "$BASE_REF" HEAD -- "$ACTIONS" | sed -E "s#^${ACTIONS%/}/([^/]+)/.*#\\1#" | sort -u | grep -v "^tests$" || true)',
        '[[ -z "$changed" ]] && { echo "No action changed."; exit 0; }',
        '',
        'vcfa_login',
        'mkdir -p out/previous',
        '',
        'for action in $changed; do',
        '  folder="${ACTIONS%/}/$action"',
        `  [[ -f "$folder/action.json" && -f "$folder/${handlerFile}" ]] || { echo "skip $action: needs action.json and ${handlerFile}"; continue; }`,
        '  id=$(jq -r .id "$folder/action.json")',
        '  project=$(jq -r .projectId "$folder/action.json")',
        '  [[ "$id" == "<"* || "$project" == "<"* ]] && { echo "skip $action: fill in action.json"; continue; }',
        '',
        '  # <verify> whether your release needs projectId on the GET.',
        '  current=$(vcfa GET "/abx/api/resources/actions/$id?projectId=$project")',
        '  echo "$current" | jq -r .source > "out/previous/$action.' + (py ? 'py' : 'js') + '"   # the undo',
        '  deps=""',
        `  [[ -f "$folder/${py ? 'requirements.txt' : 'package.json'}" ]] && deps=$(${py ? 'cat "$folder/requirements.txt"' : 'jq -r \'.dependencies // {} | to_entries | map("\\(.key)@\\(.value)") | join("\\n")\' "$folder/package.json"'})`,
        `  body=$(echo "$current" | jq --rawfile src "$folder/${handlerFile}" --arg deps "$deps" '.source = $src | .dependencies = $deps')`,
        '',
        '  if (( DRY_RUN )); then',
        '    echo "DRY RUN: would update $action ($id). Source diff:"',
        `    diff -u "out/previous/$action.${py ? 'py' : 'js'}" "$folder/${handlerFile}" || true`,
        '    continue',
        '  fi',
        '  vcfa PUT "/abx/api/resources/actions/$id" "$body" >/dev/null',
        '  echo "updated $action ($id); previous source saved in out/previous/"',
        'done',
        '',
        '# Undo: PUT the saved previous source back, or revert the commit and re-run.',
        '',
      ].join('\n');

      const vroImport = [
        '#!/usr/bin/env bash',
        '# Import each Orchestrator package that changed in the last merge.',
        '#',
        '# Packages are exported from a development Orchestrator and committed as',
        '# .package files. Configuration element values are NOT imported, so a',
        '# production value (an endpoint, a secure string) is never overwritten by',
        '# the development one.',
        '#',
        '# Without --execute it prints what it would import.',
        'set -euo pipefail',
        'source "$(dirname "$0")/vcfa-lib.sh"',
        '',
        'DRY_RUN=1',
        '[[ "${1:-}" == "--execute" ]] && DRY_RUN=0',
        `PACKAGES="\${PACKAGES:-${vroDir}}"`,
        'BASE_REF="${BASE_REF:-HEAD~1}"',
        '',
        'changed=$(git diff --name-only --diff-filter=AM "$BASE_REF" HEAD -- "$PACKAGES" | grep "\\.package$" || true)',
        '[[ -z "$changed" ]] && { echo "No package changed."; exit 0; }',
        'vcfa_login',
        '',
        'for pkg in $changed; do',
        '  if (( DRY_RUN )); then',
        '    echo "DRY RUN: would import $pkg"',
        '    continue',
        '  fi',
        '  # <verify> these query parameters against the Orchestrator API your instance',
        '  # serves. The embedded Orchestrator accepts the VCF Automation bearer token.',
        '  curl -sS -f -X POST \\',
        '    "https://${VCFA_HOST}/vco/api/packages?overwrite=true&importConfigurationAttributeValues=false&tagImportMode=DoNotImport" \\',
        '    -H @<(printf \'Authorization: Bearer %s\\n\' "$VCFA_TOKEN") -H "Accept: application/json" \\',
        '    -F "file=@${pkg}"',
        '  echo "imported $pkg"',
        'done',
        '',
        '# Undo: import the previous version of the package from git history. Orchestrator',
        '# keeps element versions, but not a one-step rollback of a package import.',
        '',
      ].join('\n');

      const subsCheck = [
        '#!/usr/bin/env bash',
        '# List the extensibility subscriptions that run each action in this repository,',
        '# and whether each is enabled. Reads only. Enabling one is a manual step, in',
        '# the interface, after the action has run once by hand.',
        'set -euo pipefail',
        'source "$(dirname "$0")/vcfa-lib.sh"',
        `ACTIONS="\${ACTIONS:-${dir}}"`,
        'vcfa_login',
        '',
        '# <verify> the paging and field names against your release.',
        'subs=$(vcfa GET "/event-broker/api/subscriptions?page=0&size=500")',
        'for f in "${ACTIONS%/}"/*/action.json; do',
        '  id=$(jq -r .id "$f")',
        '  echo "$subs" | jq -r --arg id "$id" --arg f "$f" \\',
        '    \'.content[] | select(.runnableId == $id) | "\\($f): \\(.name) on \\(.eventTopicId) — \\(if .disabled then "disabled" else "ENABLED" end)"\'',
        'done',
        '',
      ].join('\n');

      const deploySteps = ['ci/abx-deploy.sh --execute', ...(vro ? ['ci/vro-import.sh --execute'] : []), 'ci/subscriptions-check.sh'];
      const paths = [dir, ...(vro ? [vroDir] : [])];
      const testSetup = py ? 'pip install --quiet pytest' : '';

      const env = {
        github: [
          'name: Extensibility',
          '',
          '# Generated by ArchToolKit.',
          '#',
          '# Unit tests on every pull request, on a hosted runner — they need nothing',
          '# from VCF Automation. On a merge to main, the changed actions are updated',
          '# and packages imported, from a runner inside the network.',
          'on:',
          '  pull_request:',
          `    paths: [${paths.map((p) => `'${p}**'`).join(', ')}]`,
          '  push:',
          '    branches: [main]',
          `    paths: [${paths.map((p) => `'${p}**'`).join(', ')}]`,
          '',
          'permissions:',
          '  contents: read',
          '',
          'concurrency:',
          '  group: extensibility-deploy',
          '  cancel-in-progress: false',
          '',
          'jobs:',
          '  test:',
          '    runs-on: ubuntu-latest',
          '    steps:',
          '      - uses: actions/checkout@v4',
          ...(py ? ['      - uses: actions/setup-python@v5', "        with: { python-version: '3.12' }", `      - run: ${testSetup}`] : ['      - uses: actions/setup-node@v4', "        with: { node-version: '20' }"]),
          `      - run: ${testCmd}`,
          '',
          '  deploy:',
          "    if: github.ref == 'refs/heads/main' && github.event_name == 'push'",
          '    needs: test',
          `    runs-on: [self-hosted, ${runner}]`,
          '    environment: vcf-automation',
          '    env:',
          '      VCFA_HOST: ${{ vars.VCFA_HOST }}',
          '      VCFA_REFRESH_TOKEN: ${{ secrets.VCFA_REFRESH_TOKEN }}',
          '    steps:',
          '      - uses: actions/checkout@v4',
          '        with: { fetch-depth: 2 }',
          ...deploySteps.map((step) => `      - run: ${step}`),
          '      - uses: actions/upload-artifact@v4',
          '        if: always()',
          '        with: { name: previous-source, path: out/previous/ }',
          '',
        ],
        gitlab: [
          '# Generated by ArchToolKit.',
          '#',
          '# VCFA_HOST and VCFA_REFRESH_TOKEN are CI/CD variables — the token masked and',
          '# protected, so only main can read it.',
          'stages: [test, deploy]',
          '',
          'unit-tests:',
          '  stage: test',
          `  image: ${py ? 'python:3.12-slim' : 'node:20-slim'}`,
          '  rules:',
          `    - changes: [${paths.map((p) => `'${p}**/*'`).join(', ')}]`,
          '  script:',
          ...(py ? [`    - ${testSetup}`] : []),
          `    - ${testCmd}`,
          '',
          'deploy:',
          '  stage: deploy',
          `  tags: [${runner}]   # a runner inside the network`,
          '  resource_group: extensibility-deploy',
          '  environment: vcf-automation',
          '  variables:',
          '    GIT_DEPTH: "2"',
          '  rules:',
          '    - if: $CI_COMMIT_BRANCH == "main"',
          `      changes: [${paths.map((p) => `'${p}**/*'`).join(', ')}]`,
          '  script:',
          ...deploySteps.map((step) => `    - ${step}`),
          '  artifacts:',
          '    when: always',
          '    paths: [out/previous/]',
          '',
        ],
        azdo: [
          '# Generated by ArchToolKit.',
          'trigger:',
          '  branches: { include: [main] }',
          `  paths: { include: [${paths.map((p) => `'${p}'`).join(', ')}] }`,
          'pr:',
          '  branches: { include: ["*"] }',
          `  paths: { include: [${paths.map((p) => `'${p}'`).join(', ')}] }`,
          '',
          'stages:',
          '  - stage: test',
          '    pool: { vmImage: ubuntu-latest }',
          '    jobs:',
          '      - job: unit_tests',
          '        steps:',
          ...(py ? ['          - task: UsePythonVersion@0', "            inputs: { versionSpec: '3.12' }", `          - script: ${testSetup}`] : ['          - task: NodeTool@0', "            inputs: { versionSpec: '20.x' }"]),
          `          - script: ${testCmd}`,
          '',
          '  - stage: deploy',
          "    condition: and(succeeded(), eq(variables['Build.SourceBranch'], 'refs/heads/main'), ne(variables['Build.Reason'], 'PullRequest'))",
          '    jobs:',
          '      - deployment: deploy',
          `        pool: { name: ${runner} }`,
          '        environment: vcf-automation',
          '        strategy:',
          '          runOnce:',
          '            deploy:',
          '              steps:',
          '                - checkout: self',
          '                  fetchDepth: 2',
          ...deploySteps.flatMap((step) => [
            `                - script: ${step}`,
            '                  env:',
            '                    VCFA_HOST: $(VCFA_HOST)',
            '                    VCFA_REFRESH_TOKEN: $(VCFA_REFRESH_TOKEN)',
          ]),
          '',
        ],
        jenkins: [
          '// Generated by ArchToolKit.',
          'pipeline {',
          `  agent { label '${runner}' }`,
          '  options { disableConcurrentBuilds() }',
          '  stages {',
          "    stage('Unit tests') {",
          '      steps {',
          ...(py ? [`        sh '${testSetup} --user && python3 -m pytest -q ${dir}'`] : [`        sh '${testCmd}'`]),
          '      }',
          '    }',
          "    stage('Deploy') {",
          "      when { branch 'main' }",
          '      environment {',
          '        VCFA_HOST = "${env.VCFA_HOST}"',
          "        VCFA_REFRESH_TOKEN = credentials('vcfa-refresh-token')",
          '      }',
          '      steps {',
          ...deploySteps.map((step) => `        sh '${step}'`),
          '      }',
          '      post {',
          "        always { archiveArtifacts artifacts: 'out/previous/**', allowEmptyArchive: true }",
          '      }',
          '    }',
          '  }',
          '}',
          '',
        ],
      }[ci];

      return {
        platform: PLATFORM,
        title: `Extensibility actions${vro ? ' and Orchestrator packages' : ''} — unit-tested, then updated from main by ${CI_LABEL[ci]}`,
        effect: 'reversible',
        trigger: { kind: 'commit', detail: `A pull request touching ${paths.join(' or ')} runs the unit tests; a merge to main updates the changed actions${vro ? ' and imports the changed packages' : ''}`, worstCase: 'once per merge, one at a time' },
        scope: {
          what: `The ABX actions whose folders under ${dir} changed in the merge${vro ? `, and the .package files under ${vroDir} that changed` : ''}.`,
          decidedBy: [
            'git diff between the merge and its parent.',
            'action.json in each folder, which names the action by id.',
            'The rights of the account behind the refresh token.',
            'Not the subscriptions: which deployments run an action is decided by its subscription, which this never changes.',
          ],
          ifWrong: 'An action already wired to an enabled subscription starts running the new code on the next deployment event — every deployment, if the subscription has no criteria. The unit tests are the only thing between the merge and that.',
        },
        guardrails: [
          { rule: 'Subscriptions stay disabled until a manual step', because: 'The pipeline updates code only. Turning a subscription on is what makes code run on every deployment, and that is a decision for a person, after running the action once by hand.' },
          { rule: 'Unit tests must pass before anything is deployed', because: 'The stub context lets the handler run with no platform, so a syntax error or a missing input is caught on the pull request rather than in a deployment.' },
          { rule: 'Updated in place, from main only', because: 'The action keeps its id, inputs and secrets. Only its source and dependencies change, and only from reviewed code.' },
          ...(vro ? [{ rule: 'Configuration values are not imported', because: 'A package carries its configuration elements. Importing their values would overwrite production endpoints and secure strings with development ones.' }] : []),
        ],
        dryRun: [
          'ci/abx-deploy.sh without --execute prints the source diff per action.',
          ...(vro ? ['ci/vro-import.sh without --execute lists the packages it would import.'] : []),
          'Run the updated action once by hand in the interface with __dryRun set before enabling any subscription on it.',
        ],
        undo: [
          'The previous source of each action is saved to out/previous/ and kept as a run artifact. PUT it back, or revert the commit and let the pipeline run.',
          ...(vro ? ['A package import has no one-step undo. Import the previous .package from git history.'] : []),
        ],
        told: [
          `The ${CI_LABEL[ci]} run log: each action updated, each package imported, and every subscription that runs them with its enabled state.`,
          'The action’s own run history in VCF Automation, once a subscription calls it.',
        ],
        requires: [
          `A refresh token in ${secretStore(ci)} as VCFA_REFRESH_TOKEN, and VCFA_HOST as a plain variable.`,
          `A self-hosted runner labelled "${runner}" inside the network for the deploy step. The unit tests run anywhere.`,
          'Each action created once by hand (or from "An extensibility action on a deployment event"), with its id in action.json.',
        ],
        files: {
          [ciFile(ci, base)]: env.join('\n'),
          'IMPORT.md': ciImportMd(ci, ciFile(ci, base), env.join('\n'), runner),
          'ci/vcfa-lib.sh': VCFA_LIB,
          'ci/abx-deploy.sh': deploy,
          'ci/subscriptions-check.sh': subsCheck,
          ...(vro ? { 'ci/vro-import.sh': vroImport } : {}),
          [py ? `${dir}tests/stub_context.py` : `${dir}tests/stub-context.js`]: stub,
          [py ? `${dir}example-action/test_handler.py` : `${dir}example-action/handler.test.js`]: exampleTest,
          [`${dir}example-action/action.json`]: `${JSON.stringify(actionJson, null, 2)}\n`,
        },
        notes: [
          `Put the action’s ${handlerFile} beside action.json in its folder — the one this kit writes in "An extensibility action on a deployment event" already honours __dryRun, which is what the example tests rely on.`,
          'PUT /abx/api/resources/actions/{id} replaces the whole action, so the script GETs it first and changes only source and dependencies. If your release rejects fields from the GET in the PUT, strip them in the jq line.',
          VCFA_LOGIN_NOTE,
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'pipe_scheduled_ops',
    platform: PLATFORM,
    label: 'Run the read-only checks on a schedule in CI',
    group: 'Scheduled',
    description:
      'The health and report scripts this kit writes — the VCF Operations self-check, the compliance drift report, a certificate expiry check — run on a schedule by the CI you already have, from a self-hosted runner inside the network. Every output is kept as an artifact, and a check that exits non-zero fails the run, which is what makes the CI tell somebody.',
    inputs: [
      { id: 'ci', label: 'Runs on', control: 'select', options: CI_OPTIONS_ALL, default: 'github' },
      { id: 'cron', label: 'Schedule (cron, UTC)', control: 'text', default: '0 6 * * 1-5', hint: 'Five fields. 0 6 * * 1-5 is 06:00 UTC on weekdays' },
      { id: 'self_check', label: 'VCF Operations self-check', control: 'toggle', default: true },
      { id: 'compliance', label: 'Compliance drift report', control: 'toggle', default: true },
      { id: 'cert_expiry', label: 'Certificate expiry', control: 'toggle', default: true },
      { id: 'cert_hosts', label: 'Check certificates on', control: 'textarea', default: 'vcenter.example.com:443, sddc-manager.example.com:443, nsx.example.com:443, vcfops.example.com:443, vcfa.example.com:443', showWhen: { input: 'cert_expiry', equals: ['true'] } },
      { id: 'cert_days', label: 'Fail when a certificate expires within (days)', control: 'number', default: 30, min: 1, max: 365, showWhen: { input: 'cert_expiry', equals: ['true'] } },
      { id: 'retention_days', label: 'Keep outputs for (days)', control: 'number', default: 30, min: 1, max: 400 },
      { id: 'runner_label', label: 'Self-hosted runner label', control: 'text', default: 'vcf' },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const ci = ciOf(values);
      const cron = str(values, 'cron', '0 6 * * 1-5');
      const selfCheck = bool(values, 'self_check', true);
      const compliance = bool(values, 'compliance', true);
      const certs = bool(values, 'cert_expiry', true);
      const hosts = listOf(str(values, 'cert_hosts', ''));
      const certDays = num(values, 'cert_days', 30);
      const retention = num(values, 'retention_days', 30);
      const runner = str(values, 'runner_label', 'vcf');
      const base = slugOf(name || 'vcf-scheduled-checks', 'vcf-scheduled-checks');

      const checks = [
        ...(selfCheck ? [{ id: 'vcfops-health', script: 'ops/vcfops-health.sh', from: '"Check that VCF Operations is still collecting"' }] : []),
        ...(compliance ? [{ id: 'compliance', script: 'ops/compliance-report.sh', from: '"Run a compliance benchmark and report the drift" (its report.sh)' }] : []),
        ...(certs ? [{ id: 'cert-expiry', script: 'ops/cert-expiry.sh', from: 'this blueprint' }] : []),
      ];

      const findings: Finding[] = [];
      const fields = cron.trim().split(/\s+/);
      if (fields.length !== 5) {
        findings.push(error('pipe.sched.cron', `"${cron}" is not a five-field cron expression.`, { remediation: 'minute hour day-of-month month day-of-week, in UTC.', source: SRC }));
      } else {
        const minute = fields[0] ?? '';
        const step = /^\*\/(\d+)$/.exec(minute);
        if (minute === '*' || (step && Number(step[1]) < 15)) {
          findings.push(
            warning('pipe.sched.too-often', 'This runs more often than every fifteen minutes.', {
              remediation: 'Hosted schedulers delay and drop runs at that frequency, and a runner busy with checks is not free for anything else. The self-check alone is worth every fifteen minutes; the reports are daily at most.',
              source: SRC,
            }),
          );
        }
      }
      if (checks.length === 0) {
        findings.push(error('pipe.sched.nothing', 'No check is selected, so the schedule runs nothing.', { source: SRC }));
      }
      if (certs && hosts.length === 0) {
        findings.push(error('pipe.sched.no-hosts', 'The certificate check has no hosts to check.', { source: SRC }));
      }
      if (ci === 'github') {
        findings.push(
          info('pipe.sched.github-inactive', 'GitHub disables scheduled workflows in a repository with no activity for 60 days.', {
            remediation: 'A monitoring job that switches itself off is the failure this is meant to catch. Check the workflow is still enabled, or keep the repository active.',
            source: SRC,
          }),
        );
      }

      const certScript = [
        '#!/usr/bin/env bash',
        '# Certificate expiry across the VCF endpoints. Reads only.',
        '#',
        `# Exits 1 when any certificate expires within ${certDays} days or cannot be read,`,
        '# so the scheduler fails the run and says so.',
        'set -uo pipefail',
        `DAYS="\${CERT_DAYS:-${certDays}}"`,
        `HOSTS=(${hosts.map((h) => `"${h}"`).join(' ')})`,
        'now=$(date +%s)',
        'rc=0',
        'for target in "${HOSTS[@]}"; do',
        '  host="${target%%:*}"; port="${target##*:}"; [[ "$port" == "$host" ]] && port=443',
        '  end=$(echo | timeout 15 openssl s_client -connect "$host:$port" -servername "$host" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)',
        '  if [[ -z "$end" ]]; then',
        '    echo "UNREADABLE  $target"',
        '    rc=1',
        '    continue',
        '  fi',
        '  left=$(( ( $(date -d "$end" +%s) - now ) / 86400 ))',
        '  if (( left < DAYS )); then',
        '    echo "EXPIRING    $target  $left days ($end)"',
        '    rc=1',
        '  else',
        '    echo "ok          $target  $left days"',
        '  fi',
        'done',
        'exit $rc',
        '',
      ].join('\n');

      const acquire = [
        '#!/usr/bin/env bash',
        '# Acquire a VCF Operations token for this run from a read-only account whose',
        '# password comes from the CI secret store. Prints nothing but the token, for',
        '# the caller to export; the token expires on its own.',
        'set -euo pipefail',
        ': "${VCFOPS_HOST:?set VCFOPS_HOST}"',
        ': "${VCFOPS_USER:?set VCFOPS_USER}"',
        ': "${VCFOPS_PASSWORD:?set VCFOPS_PASSWORD from the CI secret store}"',
        'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
        '# The password reaches jq through its environment and curl on stdin — never as an',
        '# argument, where the process list on a shared runner would show it.',
        'VCFOPS_PASSWORD="$VCFOPS_PASSWORD" jq -n --arg u "$VCFOPS_USER" \'{username: $u, password: env.VCFOPS_PASSWORD}\' |',
        '  curl -sS -f -X POST "https://${VCFOPS_HOST}/suite-api/api/auth/token/acquire" \\',
        '    -H "Content-Type: application/json" -H "Accept: application/json" \\',
        '    --data-binary @- | jq -r .token',
        '',
      ].join('\n');

      const runAll = [
        '#!/usr/bin/env bash',
        '# Run every scheduled check, keep each output, and fail if any check failed.',
        '#',
        '# Every check reads only. A check that exits non-zero is a finding, not an',
        '# error in this script — all of them run regardless, so one failure does not',
        '# hide another.',
        'set -uo pipefail',
        'cd "$(dirname "$0")/.."',
        'mkdir -p out',
        'STAMP=$(date -u +%Y%m%dT%H%MZ)',
        'FAILED=()',
        '',
        ...(selfCheck || compliance
          ? [
              '# One token for the run, from the read-only account.',
              'if [[ -z "${VCFOPS_TOKEN:-}" ]]; then',
              '  VCFOPS_TOKEN=$(ops/acquire-token.sh) || { echo "could not acquire a VCF Operations token" >&2; exit 1; }',
              '  export VCFOPS_TOKEN',
              'fi',
              '',
            ]
          : []),
        'run() {',
        '  local id="$1" script="$2" from="$3"',
        '  if [[ ! -x "$script" ]]; then',
        '    echo "MISSING $script — generate it from $from and commit it here" | tee "out/$id-$STAMP.log"',
        '    FAILED+=("$id (missing)")',
        '    return',
        '  fi',
        '  echo "== $id"',
        '  if "$script" > "out/$id-$STAMP.log" 2>&1; then',
        '    echo "   ok"',
        '  else',
        '    echo "   FAILED — see out/$id-$STAMP.log"',
        '    FAILED+=("$id")',
        '  fi',
        '  tail -20 "out/$id-$STAMP.log" | sed "s/^/   /"',
        '}',
        '',
        ...checks.map((check) => `run ${check.id} ${check.script} '${check.from}'`),
        '',
        'if (( ${#FAILED[@]} > 0 )); then',
        '  printf "Failed: %s\\n" "${FAILED[@]}" | tee out/summary.txt',
        '  exit 1',
        'fi',
        'echo "All checks passed." | tee out/summary.txt',
        '',
      ].join('\n');

      const needsOps = selfCheck || compliance;
      const opsEnvGh = needsOps
        ? ['      VCFOPS_HOST: ${{ vars.VCFOPS_HOST }}', '      VCFOPS_USER: ${{ vars.VCFOPS_READONLY_USER }}', '      VCFOPS_PASSWORD: ${{ secrets.VCFOPS_READONLY_PASSWORD }}', ...(compliance ? ['      GROUP_ID: ${{ vars.COMPLIANCE_GROUP_ID }}'] : [])]
        : [];

      const env = {
        github: [
          'name: VCF scheduled checks',
          '',
          '# Generated by ArchToolKit.',
          '#',
          '# Read-only checks on a schedule. A failed check fails the run, and GitHub',
          '# notifies on a failed scheduled run — make sure the notification reaches',
          '# someone other than whoever last edited the cron line.',
          'on:',
          '  schedule:',
          `    - cron: '${cron}'`,
          '  workflow_dispatch: {}',
          '',
          'permissions:',
          '  contents: read',
          '',
          'concurrency:',
          '  group: vcf-scheduled-checks',
          '  cancel-in-progress: false',
          '',
          'jobs:',
          '  checks:',
          '    # VCF endpoints are private. This has to run inside the network.',
          `    runs-on: [self-hosted, ${runner}]`,
          '    timeout-minutes: 30',
          ...(opsEnvGh.length > 0 ? ['    env:', ...opsEnvGh] : []),
          '    steps:',
          '      - uses: actions/checkout@v4',
          '      - run: ops/run-all.sh',
          '      - uses: actions/upload-artifact@v4',
          '        if: always()',
          '        with:',
          '          name: vcf-checks-${{ github.run_id }}',
          '          path: out/',
          `          retention-days: ${retention}`,
          '',
        ],
        gitlab: [
          '# Generated by ArchToolKit.',
          '#',
          `# Create the schedule in Build → Pipeline schedules: cron "${cron}", timezone UTC,`,
          '# target branch main. The job only runs from a schedule or by hand.',
          '#',
          '# VCFOPS_READONLY_PASSWORD is a masked, protected CI/CD variable.',
          'vcf-checks:',
          `  tags: [${runner}]   # a runner inside the network`,
          '  timeout: 30m',
          '  rules:',
          '    - if: $CI_PIPELINE_SOURCE == "schedule"',
          '    - if: $CI_PIPELINE_SOURCE == "web"',
          ...(needsOps
            ? ['  variables:', '    VCFOPS_USER: $VCFOPS_READONLY_USER', '    VCFOPS_PASSWORD: $VCFOPS_READONLY_PASSWORD', ...(compliance ? ['    GROUP_ID: $COMPLIANCE_GROUP_ID'] : [])]
            : []),
          '  script:',
          '    - ops/run-all.sh',
          '  artifacts:',
          '    when: always',
          `    expire_in: ${retention} days`,
          '    paths: [out/]',
          '',
        ],
        azdo: [
          '# Generated by ArchToolKit.',
          '#',
          '# Scheduled only. always: true runs it even when nothing has been committed,',
          '# which is the whole point of a health check.',
          'trigger: none',
          'pr: none',
          'schedules:',
          `  - cron: '${cron}'`,
          '    displayName: VCF scheduled checks',
          '    branches: { include: [main] }',
          '    always: true',
          '',
          `pool: { name: ${runner} }   # a self-hosted agent pool inside the network`,
          '',
          'jobs:',
          '  - job: checks',
          '    timeoutInMinutes: 30',
          '    steps:',
          '      - checkout: self',
          '      - script: ops/run-all.sh',
          ...(needsOps
            ? ['        env:', '          VCFOPS_HOST: $(VCFOPS_HOST)', '          VCFOPS_USER: $(VCFOPS_READONLY_USER)', '          VCFOPS_PASSWORD: $(VCFOPS_READONLY_PASSWORD)', ...(compliance ? ['          GROUP_ID: $(COMPLIANCE_GROUP_ID)'] : [])]
            : []),
          '      - publish: out/',
          '        artifact: vcf-checks-$(Build.BuildId)',
          '        condition: always()',
          `  # Retention is set on the pipeline (Settings → Retention): ${retention} days.`,
          '',
        ],
        jenkins: [
          '// Generated by ArchToolKit.',
          '//',
          '// Jenkins cron uses the controller’s time zone unless TZ is set; the line',
          '// below pins it to UTC so it matches the schedule in the README.',
          'pipeline {',
          `  agent { label '${runner}' }   // inside the network`,
          `  triggers { cron('TZ=UTC\\n${cron}') }`,
          `  options { disableConcurrentBuilds(); timeout(time: 30, unit: 'MINUTES'); buildDiscarder(logRotator(daysToKeepStr: '${retention}')) }`,
          ...(needsOps
            ? [
                '  environment {',
                '    VCFOPS_HOST = "${env.VCFOPS_HOST}"',
                '    VCFOPS_USER = "${env.VCFOPS_READONLY_USER}"',
                "    VCFOPS_PASSWORD = credentials('vcfops-readonly-password')",
                ...(compliance ? ['    GROUP_ID = "${env.COMPLIANCE_GROUP_ID}"'] : []),
                '  }',
              ]
            : []),
          '  stages {',
          "    stage('Checks') {",
          "      steps { sh 'ops/run-all.sh' }",
          '    }',
          '  }',
          '  post {',
          "    always { archiveArtifacts artifacts: 'out/**', allowEmptyArchive: true }",
          "    failure { echo 'A check failed — see out/summary.txt' }",
          '  }',
          '}',
          '',
        ],
      }[ci];

      return {
        platform: PLATFORM,
        title: `Scheduled read-only VCF checks on ${CI_LABEL[ci]} — ${checks.map((c) => c.id).join(', ') || 'nothing selected'}`,
        effect: 'read',
        trigger: { kind: 'schedule', detail: `Cron "${cron}" (UTC) on ${CI_LABEL[ci]}, and by hand`, worstCase: 'as often as the cron line says, and never while the runner is down — which is itself worth watching' },
        scope: {
          what: [
            selfCheck ? 'VCF Operations’ own nodes, collectors and adapters' : '',
            compliance ? 'the compliance alerts for one group' : '',
            certs ? `the certificates on ${hosts.length} endpoint${hosts.length === 1 ? '' : 's'}` : '',
          ]
            .filter(Boolean)
            .join('; ') + '. Read only.',
          decidedBy: [
            'Which checks are in ops/run-all.sh.',
            ...(certs ? ['The host list in ops/cert-expiry.sh.'] : []),
            ...(compliance ? ['GROUP_ID, for the compliance report.'] : []),
            'What the read-only account can see.',
          ],
          ifWrong: 'A check that covers less than you think passes when it should not. The failure mode of a scheduled check is silence, so read one run’s output in full before trusting its green.',
        },
        guardrails: [
          { rule: 'Read-only accounts only', because: 'A scheduled job’s credential sits on a runner for months. It should not be able to change anything.' },
          { rule: 'A self-hosted runner inside the network', because: 'VCF endpoints are private. A hosted runner cannot reach them, and opening them to one is a larger problem than the one this solves.' },
          { rule: 'Every check runs, even after one fails', because: 'A certificate expiring and an adapter down on the same morning should both be reported.' },
          { rule: 'Fails the run on a non-zero exit', because: 'The CI already knows how to tell somebody about a failed run. That is the notification.' },
        ],
        dryRun: ['Run it once by hand (workflow_dispatch, "Run pipeline", "Build now") and read the artifact. Nothing here changes anything.'],
        undo: ['Nothing to undo — every check reads only. To stop it, disable the schedule.'],
        told: [
          `A failed run in ${CI_LABEL[ci]}, which notifies the way your CI is set up to — check who receives it.`,
          `The out/ folder, kept as an artifact for ${retention} days, with one log per check and summary.txt.`,
        ],
        requires: [
          `A self-hosted runner labelled "${runner}" inside the network, with bash, curl, jq and openssl.`,
          ...(needsOps ? [`A read-only VCF Operations account, its password in ${secretStore(ci)}.`] : []),
          ...checks.filter((check) => check.id !== 'cert-expiry').map((check) => `${check.script}, generated from ${check.from} and committed beside run-all.sh.`),
        ],
        files: {
          [ciFile(ci, base)]: env.join('\n'),
          'IMPORT.md': ciImportMd(ci, ciFile(ci, base), env.join('\n'), runner),
          'ops/run-all.sh': runAll,
          ...(needsOps ? { 'ops/acquire-token.sh': acquire } : {}),
          ...(certs ? { 'ops/cert-expiry.sh': certScript } : {}),
        },
        notes: [
          'Watch the watcher: if the runner is offline, the schedule silently does nothing. The VCF Operations self-check cannot see that; your CI’s own runner-offline alert can.',
          'Commit the scripts with the executable bit (git update-index --chmod=+x ops/*.sh), or run-all.sh reports them missing.',
          'Cron in every one of these CIs is UTC unless told otherwise. 06:00 UTC is not 06:00 where the people reading the result are.',
        ],
        findings,
      };
    },
  }),
];

/** One ENDPOINT document in the Pipelines export format. */
/**
 * IMPORT.md for a CI pipeline file. Nothing is uploaded: the file is committed
 * at the path the CI looks for, and the CI is pointed at it once. The secrets
 * and variables listed are the ones the file itself refers to.
 */
function ciImportMd(ci: Ci, path: string, body: string, runner: string): string {
  const names = new Set<string>();
  const add = (re: RegExp) => {
    for (const match of body.matchAll(re)) if (match[1]) names.add(match[1]);
  };
  if (ci === 'github') {
    add(/\$\{\{\s*secrets\.([A-Za-z0-9_]+)/g);
    add(/\$\{\{\s*vars\.([A-Za-z0-9_]+)/g);
  } else if (ci === 'azdo') {
    add(/\$\(([A-Z][A-Z0-9_]+)\)/g);
  } else if (ci === 'jenkins') {
    add(/credentials\('([^']+)'\)/g);
  } else {
    const assigned = new Set([...body.matchAll(/^\s*([A-Z][A-Z0-9_]+)\s*[:=]/gm)].map((m) => m[1]));
    for (const match of body.matchAll(/\$\{?([A-Z][A-Z0-9_]{2,})/g)) {
      const name = match[1] ?? '';
      if (!/^(CI|GITLAB|RUNNER)_/.test(name) && !assigned.has(name)) names.add(name);
    }
    // Scripts read some variables straight from the environment; the file's
    // own comments name them.
    for (const line of body.split('\n').filter((l) => /^\s*#.*variable/i.test(l))) {
      for (const match of line.matchAll(/\b([A-Z][A-Z0-9]*_[A-Z0-9_]+)\b/g)) if (match[1] && !/^(CI|GITLAB|RUNNER)_/.test(match[1])) names.add(match[1]);
    }
  }
  const listed = [...names].sort();
  const where: Record<Ci, string[]> = {
    github: [
      `1. Commit \`${path}\` to the default branch (main). GitHub runs every workflow in \`.github/workflows/\`; there is nothing to import.`,
      `2. Settings → Secrets and variables → Actions: add each name below as a secret (credentials) or a variable (hosts, ids). Environment-scoped ones go on the environment the job names.`,
      `3. Settings → Actions → Runners: a self-hosted runner inside the network with the label \`${runner}\`.`,
    ],
    gitlab: [
      `1. Commit \`${path}\` at the root of the repository. GitLab reads \`.gitlab-ci.yml\` from the root by default (Settings → CI/CD → General pipelines → CI/CD configuration file, if yours is elsewhere). If the repository already has one, keep this one under another name and add it with \`include: - local: <that path>\`.`,
      '2. Settings → CI/CD → Variables: add each name below; mark credentials Masked and Protected.',
      `3. A runner inside the network registered with the tag \`${runner}\`.`,
    ],
    azdo: [
      `1. Commit \`${path}\` at the root of the repository.`,
      `2. Pipelines → New pipeline → the repository → **Existing Azure Pipelines YAML file** → path \`/${path}\` → Save. Or \`az pipelines create --name <name> --repository <repo> --branch main --yml-path ${path} --skip-first-run true\`.`,
      '3. The pipeline → Edit → Variables (or a variable group linked to Key Vault): add each name below; tick "Keep this value secret" for credentials.',
      `4. Project settings → Agent pools: a self-hosted pool named \`${runner}\` with an agent inside the network.`,
    ],
    jenkins: [
      `1. Commit \`${path}\` at the root of the repository.`,
      '2. New Item → **Pipeline** (or Multibranch Pipeline) → Pipeline script from SCM → the repository → Script Path `Jenkinsfile`.',
      '3. Manage Jenkins → Credentials: add each id below as a "Secret text" credential with exactly that id.',
      `4. An agent inside the network with the label \`${runner}\`.`,
    ],
  };
  return [
    `# Putting this pipeline into ${CI_LABEL[ci]}`,
    '',
    `The pipeline file is committed to the repository at exactly \`${path}\`, beside the other files here at their paths; nothing is uploaded.`,
    '',
    ...where[ci],
    '',
    `## ${ci === 'jenkins' ? 'Credential ids' : 'Secrets and variables'} the pipeline refers to`,
    '',
    ...(listed.length > 0 ? listed.map((name) => `- \`${name}\``) : ['- none']),
    '',
    'Sources: GitHub Docs "Workflow syntax for GitHub Actions"; GitLab Docs "CI/CD YAML syntax reference" (.gitlab-ci.yml at the root); Microsoft Learn "Create your first pipeline" and az pipelines create; Jenkins "Pipeline as Code" (Jenkinsfile, Script Path).',
    '',
  ].join('\n');
}

/**
 * import.sh for a Pipelines import: each variable, each endpoint and the
 * pipeline sent on its own, in that order. The body goes with --data-binary,
 * because --data strips the newlines a YAML document depends on.
 */
function codestreamImportScript(pipelineName: string, vars: readonly string[], endpointNames: readonly string[]): string {
  return [
    '#!/usr/bin/env bash',
    `# Import ${pipelineName} into VCF Automation Pipelines through the API:`,
    '# the variables (imported empty), the endpoints, then the pipeline.',
    '#',
    '# The token comes from the environment. Without --execute this only prints',
    '# what it would send. action=create fails if an object already exists — use',
    '# action=apply to update, and check what was created before re-running.',
    'set -euo pipefail',
    'cd "$(dirname "$0")"',
    '',
    ...authPreamble('vcf-automation'),
    '',
    'DRY_RUN=1',
    '[[ "${1:-}" == "--execute" ]] && DRY_RUN=0',
    '',
    'send() {',
    '  local path="$1" file="$2" type="$3"',
    '  if (( DRY_RUN )); then',
    '    echo "DRY RUN: would POST ${file} to https://${VCFA_HOST}${path}"',
    '    return 0',
    '  fi',
    '  echo "POST ${path} <- ${file}"',
    `  curl -sS -f -X POST "https://\${VCFA_HOST}\${path}" -H "${authHeader('vcf-automation')}" \\`,
    '    -H "Accept: application/json" -H "Content-Type: ${type}" --data-binary @"${file}"',
    '  echo',
    '}',
    '',
    ...vars.map((variable) => `send '/pipeline/api/variables' 'import/api/variables/${variable}.json' 'application/json'`),
    ...endpointNames.map((name) => `send '/pipeline/api/import?action=create' 'import/api/endpoints/${name}.yaml' 'application/x-yaml'`),
    `send '/pipeline/api/import?action=create' 'import/api/${pipelineName}-pipeline.yaml' 'application/x-yaml'`,
    '',
    'if (( DRY_RUN )); then',
    '  echo "Nothing was changed. Read the files, then re-run with --execute."',
    'else',
    '  echo "Now set the secret variable values and the endpoint placeholders in the interface (IMPORT.md)."',
    'fi',
    '',
    `# Undo: DELETE /pipeline/api/pipelines/{id}, then the endpoints and variables it used.`,
    '',
  ].join('\n');
}

/** A YAML scalar that survives any text: a JSON string is a valid double-quoted YAML scalar. */
function q(text: string): string {
  return JSON.stringify(text);
}

function endpoint(project: string, name: string, type: string, description: string, properties: readonly string[]): string {
  return ['---', `project: ${q(project)}`, 'kind: ENDPOINT', `name: ${name}`, `description: ${q(description)}`, `type: ${type}`, 'isRestricted: false', 'properties:', ...properties.map((p) => `  ${p}`)].join('\n');
}

/** A minimal Deployment, so the pattern shows the shape rather than hides it. */
function k8sManifest(image: string, namespace: string, tag: string): string[] {
  const app = slugOf(image.split('/').pop() ?? 'app', 'app');
  return [
    'apiVersion: apps/v1',
    'kind: Deployment',
    'metadata:',
    `  name: ${app}`,
    `  namespace: ${namespace}`,
    'spec:',
    '  replicas: 2',
    '  strategy: { type: RollingUpdate, rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } }',
    `  selector: { matchLabels: { app: ${app} } }`,
    '  template:',
    `    metadata: { labels: { app: ${app} } }`,
    '    spec:',
    '      containers:',
    `        - name: ${app}`,
    `          image: ${image}:${tag}`,
    '          readinessProbe: { httpGet: { path: /healthz, port: 8080 }, periodSeconds: 5 }',
  ];
}
