/**
 * Azure DevOps (addendum A.10.11): `azure-pipelines.yml`.
 *
 *   pull request   a plan stage: every stack's fmt -check, validate, plan
 *   main           one stage per environment in promotion order, its jobs
 *                  deployment jobs on the Azure DevOps environment of the same
 *                  name, so the environment's approvals and checks are the
 *                  promotion gate; then the Ansible site on that environment
 *
 * Signing in: workload identity federation service connections. Azure uses
 * the AzureCLI@2 task on the Azure Resource Manager connection (its idToken);
 * AWS and Google Cloud (GCP) exchange the pipeline's OIDC token for the
 * federation service connection (System.OidcRequestUri) for a role / a
 * federated identity. No cloud key is stored. OCI signs in from an API key
 * secret or instance principal: it has no OIDC federation for Terraform.
 */

                                            
import { ANSIBLE_SECRETS, AUTH_VARIABLES, ciModel, ciReadme, ciScripts, imagePlatforms, variablesFor,                                                           } from './ci-common.js';

const POOL = (platform          )           => (platform === 'vmware' ? ['pool:', '  name: vcf'] : ['pool:', '  vmImage: ubuntu-latest']);

const indent = (lines                   , by        )           => lines.map((l) => (l === '' ? l : `${by}${l}`));

/**
 * The secrets mapped into a step's environment: Azure DevOps does not map
 * secret variables by itself, and an undefined `$(NAME)` stays literal text, so
 * a step gets only its platform's sign-in secrets and its own stack's.
 */
function secretEnv(platform          , own                   , ansible = false)           {
  const names = [
    ...AUTH_VARIABLES[platform].filter((v) => v.secret).map((v) => v.name),
    ...own.map((n) => `TF_VAR_${n}`),
    ...(ansible ? ANSIBLE_SECRETS.map((v) => v.name) : []),
  ];
  return ['env:', '  SYSTEM_ACCESSTOKEN: $(System.AccessToken)', ...names.map((n) => `  ${n}: $(${n})`)];
}

/** The steps that sign in to `platform` and run `command`. */
function signedIn(platform          , own                   , name        , command                   , ansible = false)           {
  if (platform === 'azure') {
    return [
      '- task: AzureCLI@2',
      `  displayName: ${name}`,
      '  inputs:',
      '    azureSubscription: ${{ parameters.azureServiceConnection }}',
      '    scriptType: bash',
      '    scriptLocation: inlineScript',
      '    addSpnToEnvironment: true',
      '    inlineScript: |',
      '      export OIDC_TOKEN_FILE="$(Agent.TempDirectory)/oidc-token"',
      '      printf \'%s\' "$idToken" > "$OIDC_TOKEN_FILE"',
      '      export AZURE_CLIENT_ID="$servicePrincipalId" AZURE_TENANT_ID="$tenantId"',
      '      . ci/scripts/cloud-auth.sh azure',
      ...command.map((c) => `      ${c}`),
      ...indent(secretEnv(platform, own, ansible), '  '),
    ];
  }
  const federated = platform === 'aws' || platform === 'google';
  return [
    '- bash: |',
    '    set -euo pipefail',
    ...(federated
      ? [
        '    export OIDC_TOKEN_FILE="$(Agent.TempDirectory)/oidc-token"',
        '    curl -fsS -X POST -H "Authorization: Bearer $SYSTEM_ACCESSTOKEN" -H "Content-Type: application/json" -H "Content-Length: 0" \\',
        '      "$SYSTEM_OIDCREQUESTURI?api-version=7.1&serviceConnectionId=$AZDO_FEDERATION_CONNECTION_ID" | jq -r .oidcToken > "$OIDC_TOKEN_FILE"',
      ]
      : []),
    `    . ci/scripts/cloud-auth.sh ${platform}`,
    ...command.map((c) => `    ${c}`),
    `  displayName: ${name}`,
    ...indent(secretEnv(platform, own, ansible), '  '),
  ];
}

const tools = (packer = false)           => [
  '- checkout: self',
  `- bash: bash ci/scripts/install-tools.sh ${packer ? 'packer "$(PACKER_VERSION)"' : 'terraform "$(TERRAFORM_VERSION)"'} && echo "##vso[task.prependpath]$HOME/.local/bin"`,
  `  displayName: Install ${packer ? 'Packer' : 'Terraform'}`,
];

const jobName = (s         )         => s.id.replace(/-/g, '_');

function planJob(model         , s         )           {
  return [
    `- job: plan_${jobName(s)}`,
    `  displayName: plan ${s.dir}`,
    ...indent(POOL(s.platform), '  '),
    '  steps:',
    ...indent([
      ...tools(),
      ...signedIn(s.platform, s.secrets, `Terraform check and plan ${s.dir}`, [
        `bash ci/scripts/terraform.sh ${s.backend} ${s.platform} ${s.env} ${s.dir} ${s.name} check`,
        `bash ci/scripts/terraform.sh ${s.backend} ${s.platform} ${s.env} ${s.dir} ${s.name} plan`,
      ]),
    ], '    '),
  ];
}

function deployJob(model         , s         )           {
  return [
    `- deployment: apply_${jobName(s)}`,
    `  displayName: apply ${s.dir}`,
    `  environment: ${s.env}`,
    ...indent(POOL(s.platform), '  '),
    '  strategy:',
    '    runOnce:',
    '      deploy:',
    '        steps:',
    ...indent([
      ...tools(),
      ...signedIn(s.platform, s.secrets, `Terraform apply ${s.dir}`, [`bash ci/scripts/terraform.sh ${s.backend} ${s.platform} ${s.env} ${s.dir} ${s.name} apply`]),
    ], '          '),
  ];
}

function configureJob(model         , env        , platform          , after                   )           {
  return [
    `- deployment: configure_${env}_${platform}`,
    `  displayName: configure ${env} ${platform}`,
    `  dependsOn: [${after.join(', ')}]`,
    `  environment: ${env}`,
    '  pool:',
    `    name: ${model.ansibleRunner}`,
    '  strategy:',
    '    runOnce:',
    '      deploy:',
    '        steps:',
    ...indent(['- checkout: self', ...signedIn(platform, [], `Ansible site ${env} ${platform}`, [`bash ci/scripts/ansible.sh ${platform} ${env}`], true)], '          '),
  ];
}

function pipeline(model         )         {
  const { vars } = variablesFor(model);
  const images = imagePlatforms(model);
  const onMain = "and(succeeded(), eq(variables['Build.SourceBranch'], 'refs/heads/main'), ne(variables['Build.Reason'], 'PullRequest'))";
  const L           = [
    '# Infrastructure: plan on pull requests; on main, deploy environment by environment,',
    '# each stage\'s deployment jobs on the Azure DevOps environment of the same name (its',
    '# approvals and checks are the gate). Signing in is workload identity federation.',
    '#',
    `# Variable group "infrastructure" (not secret): ${vars.map((v) => v.name).join(', ')}, AZDO_FEDERATION_CONNECTION_ID.`,
    '# Secret variables: see ci/README.md.',
    'trigger:',
    '  branches:',
    '    include: [main]',
    '',
    'pr:',
    '  branches:',
    '    include: [main]',
    '',
    'parameters:',
    '  - name: azureServiceConnection',
    '    displayName: Azure Resource Manager service connection (workload identity federation)',
    '    type: string',
    '    default: infrastructure-azure',
    '',
    'variables:',
    '  - group: infrastructure',
    '  - name: PLAN_ID',
    `    value: ${model.plan}`,
    '  - name: TERRAFORM_VERSION',
    `    value: ${model.terraformVersion}`,
    ...(images.length > 0 ? ['  - name: PACKER_VERSION', `    value: ${model.packerVersion}`] : []),
    '  - name: TF_IN_AUTOMATION',
    "    value: '1'",
    ...(model.platforms.includes('oci') ? ['  - name: OCI_AUTH', `    value: ${model.ociAuth}`] : []),
    '',
    'stages:',
    '  - stage: plan',
    "    condition: eq(variables['Build.Reason'], 'PullRequest')",
    '    jobs:',
    ...indent(model.stacks.flatMap((s) => planJob(model, s)), '      '),
  ];
  if (images.length > 0) {
    L.push(
      '',
      '  - stage: images',
      '    dependsOn: []',
      '    jobs:',
      ...indent(images.flatMap((p) => [
        `- job: images_${p}`,
        `  displayName: golden images ${p}`,
        ...indent(POOL(p), '  '),
        '  steps:',
        ...indent([
          ...tools(true),
          '- bash: python3 -m pip install --user ansible-core pywinrm',
          '  displayName: Ansible for the provisioner',
          ...signedIn(p, [], `Packer ${p}`, [
            'if [ "$(Build.Reason)" = "PullRequest" ]; then',
            `  bash ci/scripts/packer.sh validate ${p}`,
            'else',
            `  IMAGE_VERSION="$(Build.SourceVersion)" bash ci/scripts/packer.sh build ${p}`,
            'fi',
          ]),
          '- publish: images',
          `  artifact: images-${p}`,
          "  condition: and(succeeded(), ne(variables['Build.Reason'], 'PullRequest'))",
        ], '    '),
      ]), '      '),
    );
  }
  let previous = '[]';
  for (const wave of model.waves) {
    const stage = `deploy_${wave.env}`;
    const platforms = [...new Set(wave.stacks.map((s) => s.platform))];
    L.push(
      '',
      `  - stage: ${stage}`,
      `    displayName: ${wave.env}`,
      `    dependsOn: ${previous}`,
      `    condition: ${onMain}`,
      '    jobs:',
      ...indent(wave.stacks.flatMap((s) => deployJob(model, s)), '      '),
      ...(model.ansible
        ? indent(platforms.flatMap((p) => configureJob(model, wave.env, p, wave.stacks.filter((s) => s.platform === p).map((s) => `apply_${jobName(s)}`))), '      ')
        : []),
    );
    previous = stage;
  }
  return `${L.join('\n')}\n`;
}

/** `azure-pipelines.yml`, the shared scripts, and ci/README.md. */
export function azureDevOpsFiles(options           )           {
  const model = ciModel(options);
  const files                         = { ...ciScripts(model) };
  files['azure-pipelines.yml'] = pipeline(model);
  files['ci/README.md'] = ciReadme('azure-devops', model, 'azure-pipelines.yml', 'the Azure DevOps environment of the same name: add approvals and a branch control (refs/heads/main) to test, preprod and prod');
  return { files, findings: model.findings };
}
