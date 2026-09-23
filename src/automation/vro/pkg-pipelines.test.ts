/**
 * The pipeline automations as Orchestrator packages: built, parsed, and run.
 *
 * Every automation in pipeline.ts and pipeline-vcf.ts carries an Orchestrator
 * package as its central component. Each is checked the same way — the package
 * parses, every script is ES5, secrets are SecureString with no value, IMPORT.md
 * names the package — and each workflow runs in the emulator against fake
 * endpoints in another process:
 *
 *   pipe_azure_runbook   Azure Resource Manager: runbook, draft, publish, schedule, job schedule
 *   pipe_ssm_document    AWS SSM JSON API, Signature Version 4 checked against Node's crypto
 *   pipe_awx_template    AWX API v2: job template, credential, survey, workflow, nodes, links
 *   pipe_codestream      Automation Pipelines (8.x): variables, endpoints, pipeline; stops on 9.x
 *   pipe_ci_terraform,
 *   pipe_template_ci,
 *   pipe_ops_promotion,
 *   pipe_abx_ci,
 *   pipe_scheduled_ops   the pipeline file proposed to GitHub, GitLab or Azure DevOps as a review
 *
 * Every changing workflow is shown to write nothing in a dry run, to make
 * exactly the expected calls in order when armed, to stop at the cap and at the
 * first failure, and never to log a secret.
 */

import { after, describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { expect } from '../../testing/expect.ts';
import { defaultValues, type BlueprintValues } from '../../kit/blueprint.ts';
import { readPackageSpec, type VroPackageSpec } from '../../kit/vro-package.ts';
import { automationFor } from '../blueprints/index.ts';
import { es5Problems, packagesIn, VroEmulator, type WorkflowRun } from '../../testing/vro-emulator.ts';
import { startFakeServer, type FakeRequest, type FakeRoute, type FakeServer } from '../../testing/fake-rest-server.ts';

// Hash and HMAC from Node's crypto, for recomputing the Signature Version 4.
// (The repository's own declarations of node:crypto cover only what the
// package signing test needs, so these are typed here.)
interface Digest {
  update(data: string | Uint8Array): Digest;
  digest(): Uint8Array;
  digest(encoding: 'hex'): string;
}
const crypto = (await import('node:crypto')) as unknown as { createHash(algorithm: string): Digest; createHmac(algorithm: string, key: string | Uint8Array): Digest };

const CURL = (() => {
  try {
    execFileSync('sh', ['-c', 'command -v curl'], { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
})();

function build(id: string, overrides: BlueprintValues = {}): Record<string, string> {
  const blueprint = automationFor(id);
  if (!blueprint) throw new Error(`no blueprint ${id}`);
  return { ...blueprint.build({ ...defaultValues(blueprint), ...overrides }, id).files };
}

interface Pkg {
  readonly dir: string;
  readonly spec: VroPackageSpec;
  readonly workflow: string;
  readonly configKey: string;
}

function pkgOf(files: Record<string, string>): Pkg {
  const packages = packagesIn(files);
  const dir = Object.keys(packages).find((d) => d !== 'com.archtoolkit.core.package')!;
  const spec = readPackageSpec(packages[dir]!);
  return { dir, spec, workflow: spec.workflows[0]!.name, configKey: `${spec.configs[0]!.categoryPath}/${spec.configs[0]!.name}` };
}

/** The checks every package gets: it parses, it is ES5, its secrets are empty, IMPORT.md names it. */
function staticChecks(files: Record<string, string>, secrets: readonly string[]): Pkg {
  const pkg = pkgOf(files);
  const problems: string[] = [];
  for (const [dir, text] of Object.entries(packagesIn(files))) {
    const spec = readPackageSpec(text);
    for (const a of spec.actions) problems.push(...es5Problems(a.script, `${dir}/${a.name}`));
    for (const w of spec.workflows) {
      const script = [...w.xml.matchAll(/<script encoded="false">((?:<!\[CDATA\[[\s\S]*?\]\]>)+)<\/script>/g)].map((m) => [...m[1]!.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((c) => c[1]).join(''));
      expect(script.length).toBe(1);
      problems.push(...es5Problems(script[0]!, `${dir}/${w.name}`));
    }
  }
  expect(problems).toEqual([]);
  expect(pkg.spec.workflows.length).toBe(1);
  const attributes = pkg.spec.configs[0]!.attributes;
  const secure = attributes.filter((a) => a.type === 'SecureString');
  expect(secure.map((a) => a.name).sort()).toEqual([...secrets].sort());
  for (const a of secure) expect(a.value).toBe(undefined);
  expect(attributes.find((a) => a.name === 'dryRun')?.value).toBe(true);
  expect(typeof attributes.find((a) => a.name === 'cap')?.value).toBe('number');
  expect(files['IMPORT.md']!.includes(`import/${pkg.dir}`)).toBe(true);
  expect(files['IMPORT.md']!.includes('import/com.archtoolkit.core.package')).toBe(true);
  expect(pkg.spec.name.startsWith('com.archtoolkit.pipeline.')).toBe(true);
  return pkg;
}

function logText(run: WorkflowRun): string {
  return run.logs.map((line) => line.message).join('\n') + JSON.stringify(run.outputs) + (run.error ?? '');
}

const servers: FakeServer[] = [];
after(() => servers.forEach((s) => s.stop()));

/** Start a fake server, run the workflow once against it, and return what it saw. */
async function run(
  files: Record<string, string>,
  routes: (host: string) => FakeRoute[],
  settings: (host: string) => Record<string, unknown>,
  inputs: Record<string, unknown> = {},
): Promise<{ result: WorkflowRun; requests: FakeRequest[]; host: string }> {
  const server = await startFakeServer(routes('PLACEHOLDER'));
  servers.push(server);
  const host = `127.0.0.1:${server.port}`;
  // Routes that need the host (none do at the moment) could be rebuilt here;
  // every URL the workflows call is built from the settings instead.
  const pkg = pkgOf(files);
  const emulator = new VroEmulator(files, { config: { [pkg.configKey]: settings(host) } });
  const result = emulator.runWorkflow(pkg.workflow, inputs);
  expect(/do-not-log/.test(logText(result))).toBe(false);
  return { result, requests: server.requests(), host };
}

const line = (r: FakeRequest) => `${r.method} ${r.path.split('?')[0]}`;
const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const b64 = (text: string) => btoa(Array.from(new TextEncoder().encode(text), (byte) => String.fromCharCode(byte)).join(''));
const unb64 = (text: string) => new TextDecoder().decode(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)));
const plannedCount = (result: WorkflowRun) => result.logs.filter((l) => l.message.startsWith('DRY RUN: would')).length;

// ---------------------------------------------------------------------------
// Azure Automation

describe('pipelines package: Azure Automation runbook', { skip: !CURL }, () => {
  const files = build('pipe_azure_runbook');
  const rb = 'nightly-tag-compliance';
  const pkg = staticChecks(files, ['azureClientSecret']);
  const script = pkg.spec.resources.find((r) => r.name === `${rb}.ps1`)!.content;
  const jobId = /\/jobSchedules\/([0-9a-f-]{36})/.exec(files['IMPORT.md']!)![1]!;
  const ACCT = '/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Automation/automationAccounts/acct-1';
  const at = (method: string, path: string, answer: Partial<FakeRoute>): FakeRoute => ({ method, path: `^${esc(ACCT + path)}\\?api-version=2023-11-01$`, ...answer });

  const routes = (o: { runbook?: boolean; same?: boolean; schedule?: boolean; publishStatus?: number } = {}) => (): FakeRoute[] => [
    { method: 'POST', path: '^/tenant-1/oauth2/v2\\.0/token$', body: { access_token: 'arm-access-do-not-log', token_type: 'Bearer' } },
    at('GET', '', { body: { name: 'acct-1', location: 'westeurope' } }),
    at('GET', `/runbooks/${rb}/content`, o.runbook ? { body: o.same ? script : '# edited in the portal\n' } : { status: 404, body: {} }),
    at('GET', `/runbooks/${rb}`, o.runbook ? { body: { name: rb } } : { status: 404, body: { code: 'NotFound' } }),
    at('PUT', `/runbooks/${rb}`, { status: 201, body: { name: rb } }),
    at('PUT', `/runbooks/${rb}/draft/content`, { status: 202, body: '' }),
    at('POST', `/runbooks/${rb}/publish`, { status: o.publishStatus ?? 202, body: o.publishStatus ? { message: 'conflict for azure-secret-do-not-log' } : '' }),
    at('GET', `/schedules/${rb}-schedule`, o.schedule ? { body: { name: `${rb}-schedule` } } : { status: 404, body: {} }),
    at('PUT', `/schedules/${rb}-schedule`, { status: 201, body: {} }),
    at('GET', `/jobSchedules/${jobId}`, { status: 404, body: {} }),
    at('PUT', `/jobSchedules/${jobId}`, { status: 201, body: {} }),
  ];
  const settings = (extra: Record<string, unknown> = {}) => (host: string) => ({
    azureTenantId: 'tenant-1',
    azureClientId: 'client-1',
    azureClientSecret: 'azure-secret-do-not-log',
    subscriptionId: 'sub-1',
    resourceGroup: 'rg-1',
    automationAccount: 'acct-1',
    azureLoginHost: host,
    armHost: host,
    ...extra,
  });
  const writes = (requests: FakeRequest[]) => requests.filter((r) => r.method !== 'GET' && !r.path.includes('/oauth2/')).map(line);

  it('keeps the runbook, the Bicep and the ARM template beside the package', () => {
    expect(typeof files[`import/azure/${rb}.ps1`]).toBe('string');
    expect(typeof files[`import/azure/${rb}-schedule.bicep`]).toBe('string');
    expect(script).toBe(files[`import/azure/${rb}.ps1`]!);
  });

  it('dry run by default: reads, plans the runbook and the schedule, writes nothing', async () => {
    const { result, requests } = await run(files, routes(), settings());
    expect(result.error).toBe(null);
    expect(writes(requests)).toEqual([]);
    expect(plannedCount(result)).toBe(4);
  });

  it('armed: creates, fills and publishes the runbook, creates the schedule, and does not link it', async () => {
    const { result, requests } = await run(files, routes(), settings({ dryRun: false }), { dryRun: false });
    expect(result.error).toBe(null);
    expect(requests.map(line)).toEqual([
      'POST /tenant-1/oauth2/v2.0/token',
      `GET ${ACCT}`,
      `GET ${ACCT}/runbooks/${rb}`,
      `PUT ${ACCT}/runbooks/${rb}`,
      `PUT ${ACCT}/runbooks/${rb}/draft/content`,
      `POST ${ACCT}/runbooks/${rb}/publish`,
      `GET ${ACCT}/schedules/${rb}-schedule`,
      `PUT ${ACCT}/schedules/${rb}-schedule`,
    ]);
    const token = requests[0]!;
    expect(token.body).toContain('grant_type=client_credentials');
    expect(token.body).toContain(`scope=${encodeURIComponent(`https://${requests[1]!.host}/.default`)}`);
    const create = JSON.parse(requests[3]!.body) as { location: string; properties: { runbookType: string } };
    expect(create.location).toBe('westeurope');
    expect(create.properties.runbookType).toBe('PowerShell');
    expect(requests[4]!.body).toBe(script);
    expect(requests[4]!.headers['content-type']).toBe('text/powershell');
    const schedule = JSON.parse(requests[7]!.body) as { properties: { frequency: string; startTime: string; interval: number; timeZone: string } };
    expect(schedule.properties.frequency).toBe('Day');
    expect(schedule.properties.interval).toBe(1);
    expect(schedule.properties.timeZone).toBe('UTC');
    expect(schedule.properties.startTime.endsWith('T02:00:00.000Z')).toBe(true);
    expect(requests.slice(1).every((r) => r.headers.authorization === 'Bearer arm-access-do-not-log')).toBe(true);
    expect(result.outputs.runbookState).toBe('created');
    expect(result.logs.some((l) => l.message.includes('Not linked'))).toBe(true);
  });

  it('leaves the published runbook and the schedule alone, and links them only when asked', async () => {
    const { result, requests } = await run(files, routes({ runbook: true, same: true, schedule: true }), settings({ dryRun: false, linkRunbook: true }));
    expect(result.error).toBe(null);
    expect(writes(requests)).toEqual([`PUT ${ACCT}/jobSchedules/${jobId}`]);
    const link = JSON.parse(requests.find((r) => r.method === 'PUT')!.body) as { properties: { runbook: { name: string }; schedule: { name: string } } };
    expect(link.properties.runbook.name).toBe(rb);
    expect(link.properties.schedule.name).toBe(`${rb}-schedule`);
    expect(result.outputs.runbookState).toBe('unchanged');
  });

  it('republishes a runbook whose published content differs', async () => {
    const { requests, result } = await run(files, routes({ runbook: true, schedule: true }), settings({ dryRun: false }));
    expect(writes(requests)).toEqual([`PUT ${ACCT}/runbooks/${rb}/draft/content`, `POST ${ACCT}/runbooks/${rb}/publish`]);
    expect(result.outputs.runbookState).toBe('updated');
  });

  it('stops at the cap', async () => {
    const { result, requests } = await run(files, routes(), settings({ dryRun: false, cap: 1 }));
    expect(writes(requests)).toEqual([`PUT ${ACCT}/runbooks/${rb}`]);
    expect(result.error ?? '').toContain('Cap reached: 1 change(s) made, the cap is 1; stopping before: replace the draft');
  });

  it('stops at the first failure and says what failed', async () => {
    const { result, requests } = await run(files, routes({ publishStatus: 409 }), settings({ dryRun: false }));
    expect(writes(requests)).toEqual([`PUT ${ACCT}/runbooks/${rb}`, `PUT ${ACCT}/runbooks/${rb}/draft/content`, `POST ${ACCT}/runbooks/${rb}/publish`]);
    expect(result.error ?? '').toContain(`Stopped after 2 change(s): publish ${rb} failed`);
    expect(result.error ?? '').toContain('returned HTTP 409');
  });
});

// ---------------------------------------------------------------------------
// AWS Systems Manager

describe('pipelines package: AWS Systems Manager document', { skip: !CURL }, () => {
  const files = build('pipe_ssm_document');
  const pkg = staticChecks(files, ['awsSecretAccessKey', 'awsSessionToken']);
  const doc = pkg.spec.resources.find((r) => r.name === 'document.yaml')!.content;
  const association = JSON.parse(pkg.spec.resources.find((r) => r.name === 'association.json')!.content) as Record<string, unknown>;
  const SECRET = 'aws-secret-do-not-log';
  const ssm = (responses: { status?: number; body: unknown }[]) => (): FakeRoute[] => [{ method: 'POST', path: '^/$', responses }];
  const settings = (extra: Record<string, unknown> = {}) => (host: string) => ({ awsRegion: 'eu-west-1', awsAccessKeyId: 'AKIDEXAMPLE', awsSecretAccessKey: SECRET, ssmEndpoint: host, ...extra });
  const targets = (requests: FakeRequest[]) => requests.map((r) => String(r.headers['x-amz-target']).replace('AmazonSSM.', ''));
  const MISSING = { status: 400, body: { __type: 'com.amazonaws.ssm#InvalidDocument', message: 'not found' } };
  const NONE = { body: { Associations: [] } };

  it('keeps the document and the CreateAssociation request beside the package', () => {
    expect(doc).toBe(files['import/ssm/PatchAndReport.yaml']!);
    expect(association).toEqual(JSON.parse(files['import/ssm/pipe-ssm-document-association.json']!));
  });

  it('dry run by default: describes and lists, writes nothing', async () => {
    const { result, requests } = await run(files, ssm([MISSING, NONE]), settings());
    expect(result.error).toBe(null);
    expect(targets(requests)).toEqual(['DescribeDocument', 'ListAssociations']);
    expect(plannedCount(result)).toBe(2);
    expect(result.outputs.associationId).toBe('');
  });

  it('armed: creates the document, then the association, with a valid Signature Version 4', async () => {
    const { result, requests } = await run(files, ssm([MISSING, { body: { DocumentDescription: { Name: 'PatchAndReport' } } }, NONE, { body: { AssociationDescription: { AssociationId: 'assoc-1' } } }]), settings({ dryRun: false }), { dryRun: false });
    expect(result.error).toBe(null);
    expect(targets(requests)).toEqual(['DescribeDocument', 'CreateDocument', 'ListAssociations', 'CreateAssociation']);
    const create = JSON.parse(requests[1]!.body) as Record<string, string>;
    expect(create).toEqual({ Name: 'PatchAndReport', Content: doc, DocumentType: 'Command', DocumentFormat: 'YAML' });
    expect(JSON.parse(requests[3]!.body)).toEqual(association);
    expect(JSON.parse(requests[2]!.body)).toEqual({ AssociationFilterList: [{ key: 'AssociationName', value: 'pipe-ssm-document-association' }] });
    expect(result.outputs.documentState).toBe('created');
    expect(result.outputs.associationId).toBe('assoc-1');

    // Every request's signature, recomputed with Node's crypto.
    for (const r of requests) {
      const auth = /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/(\d{8})\/eu-west-1\/ssm\/aws4_request, SignedHeaders=([a-z;-]+), Signature=([0-9a-f]{64})$/.exec(r.headers.authorization ?? '');
      expect(Boolean(auth)).toBe(true);
      const [, day, signed, signature] = auth!;
      expect(signed).toBe('content-type;host;x-amz-date;x-amz-target');
      const date = r.headers['x-amz-date']!;
      expect(date.startsWith(day!)).toBe(true);
      const canonical = ['POST', '/', '', ...signed!.split(';').map((h) => `${h}:${r.headers[h]}`), '', signed, crypto.createHash('sha256').update(r.body).digest('hex')].join('\n');
      const scope = `${day}/eu-west-1/ssm/aws4_request`;
      const toSign = ['AWS4-HMAC-SHA256', date, scope, crypto.createHash('sha256').update(canonical).digest('hex')].join('\n');
      let key: Uint8Array = crypto.createHmac('sha256', `AWS4${SECRET}`).update(day!).digest();
      for (const part of ['eu-west-1', 'ssm', 'aws4_request']) key = crypto.createHmac('sha256', key).update(part).digest();
      expect(crypto.createHmac('sha256', key).update(toSign).digest('hex')).toBe(signature!);
      expect(r.headers['content-type']).toBe('application/x-amz-json-1.1');
    }
  });

  it('signs a session token too when there is one', async () => {
    const { requests } = await run(files, ssm([MISSING, NONE]), settings({ awsSessionToken: 'session-do-not-log' }));
    expect(requests[0]!.headers['x-amz-security-token']).toBe('session-do-not-log');
    expect(requests[0]!.headers.authorization).toContain('SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target');
  });

  it('makes a new default version when the content differs, and leaves the association alone', async () => {
    const { result, requests } = await run(
      files,
      ssm([{ body: { Document: { Name: 'PatchAndReport' } } }, { body: { Content: 'old' } }, { body: { DocumentDescription: { DocumentVersion: '2' } } }, { body: {} }, { body: { Associations: [{ AssociationId: 'assoc-0' }] } }]),
      settings({ dryRun: false }),
    );
    expect(result.error).toBe(null);
    expect(targets(requests)).toEqual(['DescribeDocument', 'GetDocument', 'UpdateDocument', 'UpdateDocumentDefaultVersion', 'ListAssociations']);
    expect(JSON.parse(requests[3]!.body)).toEqual({ Name: 'PatchAndReport', DocumentVersion: '2' });
    expect(result.outputs.documentState).toBe('updated');
    expect(result.outputs.associationId).toBe('assoc-0');
  });

  it('changes nothing when both are as generated', async () => {
    const { result, requests } = await run(files, ssm([{ body: { Document: {} } }, { body: { Content: doc } }, { body: { Associations: [{ AssociationId: 'assoc-0' }] } }]), settings({ dryRun: false }));
    expect(targets(requests)).toEqual(['DescribeDocument', 'GetDocument', 'ListAssociations']);
    expect(JSON.parse(result.outputs.summary as string).changes).toEqual([]);
  });

  it('stops at the cap', async () => {
    const { result, requests } = await run(files, ssm([MISSING, { body: {} }, NONE]), settings({ dryRun: false, cap: 1 }));
    expect(targets(requests)).toEqual(['DescribeDocument', 'CreateDocument', 'ListAssociations']);
    expect(result.error ?? '').toContain('Cap reached: 1 change(s) made, the cap is 1; stopping before: create association');
  });

  it('stops at the first failure and never logs the secret it was sent', async () => {
    const { result, requests } = await run(files, ssm([MISSING, { status: 500, body: { message: `boom ${SECRET}` } }]), settings({ dryRun: false }));
    expect(targets(requests)).toEqual(['DescribeDocument', 'CreateDocument']);
    expect(result.error ?? '').toContain('Stopped after 0 change(s): create document PatchAndReport failed');
  });
});

// ---------------------------------------------------------------------------
// AWX

describe('pipelines package: AWX job template and workflow', { skip: !CURL }, () => {
  const files = build('pipe_awx_template');
  staticChecks(files, ['awxToken']);
  const A = '/api/v2/';
  const routes = (o: { jt?: boolean; wf?: boolean; inventory?: boolean; credentialStatus?: number } = {}) => (): FakeRoute[] => [
    { method: 'GET', path: `^${A}organizations/\\?name=Default$`, body: { count: 1, results: [{ id: 1 }] } },
    { method: 'GET', path: `^${A}inventories/\\?name=Production%20Linux&organization=1$`, body: { results: o.inventory === false ? [] : [{ id: 2 }] } },
    { method: 'GET', path: `^${A}projects/\\?name=Infrastructure%20playbooks&organization=1$`, body: { results: [{ id: 3 }] } },
    { method: 'GET', path: `^${A}credentials/\\?name=.*&credential_type__kind=ssh$`, body: { results: [{ id: 4 }] } },
    { method: 'GET', path: `^${A}job_templates/\\?name=`, body: { results: o.jt ? [{ id: 9 }] : [] } },
    { method: 'GET', path: `^${A}workflow_job_templates/\\?name=`, body: { results: o.wf ? [{ id: 19 }] : [] } },
    { method: 'POST', path: `^${A}job_templates/$`, status: 201, body: { id: 10 } },
    { method: 'POST', path: `^${A}job_templates/10/credentials/$`, status: o.credentialStatus ?? 204, body: o.credentialStatus ? { error: 'no' } : '' },
    { method: 'POST', path: `^${A}job_templates/10/survey_spec/$`, body: {} },
    { method: 'POST', path: `^${A}workflow_job_templates/$`, status: 201, body: { id: 20 } },
    { method: 'POST', path: `^${A}workflow_job_templates/(20|19)/workflow_nodes/$`, status: 201, responses: [{ status: 201, body: { id: 31 } }, { status: 201, body: { id: 32 } }, { status: 201, body: { id: 33 } }] },
    { method: 'POST', path: `^${A}workflow_job_template_nodes/\\d+/create_approval_template/$`, status: 201, body: {} },
    { method: 'POST', path: `^${A}workflow_job_template_nodes/\\d+/success_nodes/$`, status: 204, body: '' },
  ];
  const settings = (extra: Record<string, unknown> = {}) => (host: string) => ({ awxHost: host, awxToken: 'awx-token-do-not-log', ...extra });
  const writes = (requests: FakeRequest[]) => requests.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path}`);

  it('keeps the awxkit import file beside the package', () => {
    expect(Object.keys(JSON.parse(files['import/awx/pipe-awx-template.json']!) as object)).toEqual(['job_templates', 'workflow_job_templates']);
  });

  it('dry run by default: resolves every name, writes nothing', async () => {
    const { result, requests } = await run(files, routes(), settings());
    expect(result.error).toBe(null);
    expect(writes(requests)).toEqual([]);
    // job template, credential, survey, workflow, two nodes, one link
    expect(plannedCount(result)).toBe(7);
  });

  it('armed: the job template with its credential and survey, then the workflow, its nodes and the link', async () => {
    const { result, requests } = await run(files, routes(), settings({ dryRun: false }), { dryRun: false });
    expect(result.error).toBe(null);
    expect(writes(requests)).toEqual([
      `POST ${A}job_templates/`,
      `POST ${A}job_templates/10/credentials/`,
      `POST ${A}job_templates/10/survey_spec/`,
      `POST ${A}workflow_job_templates/`,
      `POST ${A}workflow_job_templates/20/workflow_nodes/`,
      `POST ${A}workflow_job_templates/20/workflow_nodes/`,
      `POST ${A}workflow_job_template_nodes/31/success_nodes/`,
    ]);
    const posts = requests.filter((r) => r.method === 'POST').map((r) => JSON.parse(r.body || '{}') as Record<string, unknown>);
    expect(posts[0]!.inventory).toBe(2);
    expect(posts[0]!.project).toBe(3);
    expect(posts[0]!.playbook).toBe('playbooks/patch.yml');
    expect(posts[0]!.ask_job_type_on_launch).toBe(true);
    expect('natural_key' in posts[0]!).toBe(false);
    expect(posts[1]).toEqual({ id: 4 });
    expect((posts[2]!.spec as unknown[]).length).toBe(1);
    expect(posts[3]!.organization).toBe(1);
    expect(posts[4]).toEqual({ identifier: 'check', unified_job_template: 10, job_type: 'check' });
    expect(posts[5]).toEqual({ identifier: 'run', unified_job_template: 10 });
    expect(posts[6]).toEqual({ id: 32 });
    expect(requests.every((r) => r.headers.authorization === 'Bearer awx-token-do-not-log')).toBe(true);
    expect(result.outputs.jobTemplateId).toBe('10');
    expect(result.outputs.workflowTemplateId).toBe('20');
  });

  it('with an approval: a node in the middle made an approval, linked check → approve → run', async () => {
    const approvalFiles = build('pipe_awx_template', { ask_for_approval: true });
    const { result, requests } = await run(approvalFiles, routes({ jt: true }), settings({ dryRun: false, cap: 20 }));
    expect(result.error).toBe(null);
    expect(writes(requests)).toEqual([
      `POST ${A}workflow_job_templates/`,
      `POST ${A}workflow_job_templates/20/workflow_nodes/`,
      `POST ${A}workflow_job_templates/20/workflow_nodes/`,
      `POST ${A}workflow_job_template_nodes/32/create_approval_template/`,
      `POST ${A}workflow_job_templates/20/workflow_nodes/`,
      `POST ${A}workflow_job_template_nodes/31/success_nodes/`,
      `POST ${A}workflow_job_template_nodes/32/success_nodes/`,
    ]);
    const nodes = requests.filter((r) => r.path.endsWith('/workflow_nodes/')).map((r) => JSON.parse(r.body) as Record<string, unknown>);
    expect(nodes[0]!.unified_job_template).toBe(9);
    expect(nodes[1]).toEqual({ identifier: 'approve' });
    expect((JSON.parse(requests.find((r) => r.path.includes('create_approval_template'))!.body) as { timeout: number }).timeout).toBe(86400);
  });

  it('leaves an existing job template and workflow alone', async () => {
    const { result, requests } = await run(files, routes({ jt: true, wf: true }), settings({ dryRun: false }));
    expect(result.error).toBe(null);
    expect(writes(requests)).toEqual([]);
    expect(result.outputs.jobTemplateId).toBe('9');
  });

  it('refuses when something it refers to does not exist', async () => {
    const { result, requests } = await run(files, routes({ inventory: false }), settings({ dryRun: false }));
    expect(writes(requests)).toEqual([]);
    expect(result.error ?? '').toContain('Inventory "Production Linux" does not exist in AWX');
  });

  it('stops at the cap', async () => {
    const { result, requests } = await run(files, routes(), settings({ dryRun: false, cap: 2 }));
    expect(writes(requests).length).toBe(2);
    expect(result.error ?? '').toContain('Cap reached: 2 change(s) made, the cap is 2; stopping before: set the survey');
  });

  it('stops at the first failure', async () => {
    const { result, requests } = await run(files, routes({ credentialStatus: 400 }), settings({ dryRun: false }));
    expect(writes(requests)).toEqual([`POST ${A}job_templates/`, `POST ${A}job_templates/10/credentials/`]);
    expect(result.error ?? '').toContain('Stopped after 1 change(s): attach credential');
  });
});

// ---------------------------------------------------------------------------
// Automation Pipelines (8.x)

describe('pipelines package: Automation Pipelines import (8.x only)', { skip: !CURL }, () => {
  const files = build('pipe_codestream');
  const pkg = staticChecks(files, ['vcfaRefreshToken']);
  const VARS = ['smoke_ssh_user', 'smoke_ssh_password', 'vcfa_host', 'vcfa_refresh_token', 'git_token', 'smtp_password'];
  const routes = (o: { noPipelines?: boolean; pipelineExists?: boolean; importStatus?: string } = {}) => (): FakeRoute[] => [
    { method: 'POST', path: '^/iaas/api/login$', body: { token: 'vcfa-bearer-do-not-log' } },
    { method: 'GET', path: '^/pipeline/api/pipelines\\?\\$top=1$', ...(o.noPipelines ? { status: 404, body: {} } : { body: { count: 0, documents: {} } }) },
    { method: 'GET', path: '^/pipeline/api/variables\\?.*vcfa_host', body: { count: 1, documents: { '/pipeline/api/variables/v-1': { id: 'v-1', name: 'vcfa_host' } } } },
    { method: 'GET', path: '^/pipeline/api/variables\\?', body: { count: 0, documents: {} } },
    { method: 'GET', path: '^/pipeline/api/endpoints\\?', body: { count: 0, documents: {} } },
    { method: 'GET', path: '^/pipeline/api/pipelines\\?\\$filter', body: o.pipelineExists ? { count: 1, documents: { '/pipeline/api/pipelines/p-1': { id: 'p-1' } } } : { count: 0, documents: {} } },
    { method: 'POST', path: '^/pipeline/api/variables$', body: { id: 'new' } },
    { method: 'POST', path: '^/pipeline/api/import\\?action=create$', body: `status: ${o.importStatus ?? 'CREATED'}\nstatusMessage: ok\n` },
    { method: 'POST', path: '^/pipeline/api/import\\?action=apply$', body: 'status: UPDATED\n' },
  ];
  const settings = (extra: Record<string, unknown> = {}) => (host: string) => ({ vcfaHost: host, vcfaRefreshToken: 'refresh-do-not-log', ...extra });
  const writes = (requests: FakeRequest[]) => requests.filter((r) => r.method !== 'GET' && r.path !== '/iaas/api/login').map((r) => `${r.method} ${r.path}`);

  it('is labelled 8.x in every place a reader looks, and keeps the native import files', () => {
    expect(files['IMPORT.md']!).toContain('VCF 9.1: this does not import');
    expect(files['IMPORT.md']!).toContain('378424');
    expect(pkg.spec.description).toContain('not in VCF Automation 9');
    expect(typeof files['import/pipelines/cloud-template-promote.yaml']).toBe('string');
    expect(typeof files['import.sh']).toBe('string');
    expect(pkg.spec.resources.find((r) => r.name === 'pipeline.yaml')!.content).toBe(files['import/api/cloud-template-promote-pipeline.yaml']!);
  });

  it('on VCF Automation 9 it stops at the first read and says why', async () => {
    const { result, requests } = await run(files, routes({ noPipelines: true }), settings({ dryRun: false }));
    expect(writes(requests)).toEqual([]);
    expect(result.error ?? '').toContain('no Automation Pipelines');
    expect(result.error ?? '').toContain('KB 378424');
  });

  it('dry run by default: finds what exists, writes nothing', async () => {
    const { result, requests } = await run(files, routes(), settings());
    expect(result.error).toBe(null);
    expect(writes(requests)).toEqual([]);
    // five variables (vcfa_host exists), two endpoints, the pipeline
    expect(plannedCount(result)).toBe(8);
  });

  it('armed: variables, then endpoints, then the pipeline; what exists is left alone', async () => {
    const { result, requests } = await run(files, routes(), settings({ dryRun: false }), { dryRun: false });
    expect(result.error).toBe(null);
    expect(writes(requests)).toEqual([
      ...VARS.filter((v) => v !== 'vcfa_host').map(() => 'POST /pipeline/api/variables'),
      'POST /pipeline/api/import?action=create',
      'POST /pipeline/api/import?action=create',
      'POST /pipeline/api/import?action=create',
    ]);
    const posted = requests.filter((r) => r.path === '/pipeline/api/variables').map((r) => JSON.parse(r.body) as { name: string; value: string; kind: string; type: string });
    expect(posted.map((v) => v.name)).toEqual(VARS.filter((v) => v !== 'vcfa_host'));
    for (const v of posted) {
      expect(v.value).toBe('');
      expect(v.kind).toBe('VARIABLE');
    }
    const imports = requests.filter((r) => r.path.startsWith('/pipeline/api/import'));
    expect(imports.every((r) => r.headers['content-type'] === 'application/x-yaml')).toBe(true);
    expect(imports.map((r) => /\nkind: (\w+)/.exec(r.body)?.[1])).toEqual(['ENDPOINT', 'ENDPOINT', 'PIPELINE']);
    expect(imports[0]!.body).toContain('name: git-source');
    expect(requests.filter((r) => r.path !== '/iaas/api/login').every((r) => r.headers.authorization === 'Bearer vcfa-bearer-do-not-log')).toBe(true);
    expect(result.outputs.pipelineStatus).toBe('CREATED');
  });

  it('updates an existing pipeline with action=apply', async () => {
    const { result, requests } = await run(files, routes({ pipelineExists: true }), settings({ dryRun: false }));
    expect(writes(requests).pop()).toBe('POST /pipeline/api/import?action=apply');
    expect(result.outputs.pipelineStatus).toBe('UPDATED');
  });

  it('stops at the cap', async () => {
    const { result, requests } = await run(files, routes(), settings({ dryRun: false, cap: 2 }));
    expect(writes(requests).length).toBe(2);
    expect(result.error ?? '').toContain('Cap reached: 2 change(s) made, the cap is 2; stopping before: create variable vcfa_refresh_token');
  });

  it('stops when the import does not answer CREATED', async () => {
    const { result, requests } = await run(files, routes({ importStatus: 'FAILED' }), settings({ dryRun: false }));
    expect(writes(requests).filter((w) => w.includes('import')).length).toBe(1);
    expect(result.error ?? '').toContain('Stopped after 5 change(s): create endpoint git-source failed: The import answered FAILED rather than CREATED');
  });
});

// ---------------------------------------------------------------------------
// The CI automations: the pipeline file proposed to the repository

const TOKEN = 'git-token-do-not-log';

function githubRoutes(repo: string, branch: string, existing: Record<string, string> = {}, o: { putStatus?: number; branchExists?: boolean } = {}): () => FakeRoute[] {
  const R = `/repos/${repo}`;
  return () => [
    { method: 'GET', path: `^${esc(`${R}/git/ref/heads/main`)}$`, body: { ref: 'refs/heads/main', object: { sha: 'base-sha' } } },
    { method: 'GET', path: `^${esc(`${R}/git/ref/heads/${branch}`)}$`, ...(o.branchExists ? { body: { object: { sha: 'branch-sha' } } } : { status: 404, body: { message: 'Not Found' } }) },
    ...Object.entries(existing).map(([path, content]): FakeRoute => ({ method: 'GET', path: `^${esc(`${R}/contents/${path}`)}\\?ref=`, body: { sha: `sha-${path}`, encoding: 'base64', content: b64(content).replace(/(.{60})/g, '$1\n') } })),
    { method: 'GET', path: `^${esc(`${R}/contents/`)}`, status: 404, body: { message: 'Not Found' } },
    { method: 'POST', path: `^${esc(`${R}/git/refs`)}$`, status: 201, body: {} },
    { method: 'PUT', path: `^${esc(`${R}/contents/`)}`, status: o.putStatus ?? 201, body: {} },
    { method: 'GET', path: `^${esc(`${R}/pulls`)}\\?`, body: [] },
    { method: 'POST', path: `^${esc(`${R}/pulls`)}$`, status: 201, body: { html_url: 'https://github.example/pr/1' } },
  ];
}

function gitlabRoutes(project: string, branch: string, existing: Record<string, string> = {}, o: { commitStatus?: number } = {}): () => FakeRoute[] {
  const P = `/api/v4/projects/${encodeURIComponent(project)}`;
  return () => [
    { method: 'GET', path: `^${esc(`${P}/repository/branches/main`)}$`, body: { commit: { id: 'base-sha' } } },
    { method: 'GET', path: `^${esc(`${P}/repository/branches/${encodeURIComponent(branch)}`)}$`, status: 404, body: {} },
    ...Object.entries(existing).map(([path, content]): FakeRoute => ({ method: 'GET', path: `^${esc(`${P}/repository/files/${encodeURIComponent(path)}`)}\\?ref=`, body: { blob_id: 'b', content: b64(content) } })),
    { method: 'GET', path: `^${esc(`${P}/repository/files/`)}`, status: 404, body: {} },
    { method: 'POST', path: `^${esc(`${P}/repository/commits`)}$`, status: o.commitStatus ?? 201, body: {} },
    { method: 'GET', path: `^${esc(`${P}/merge_requests`)}\\?`, body: [] },
    { method: 'POST', path: `^${esc(`${P}/merge_requests`)}$`, status: 201, body: { web_url: 'https://gitlab.example/mr/3' } },
  ];
}

function azdoRoutes(project: string, repo: string, existing: Record<string, string> = {}, o: { pipelines?: unknown[] } = {}): () => FakeRoute[] {
  const B = `/acme/${project}/_apis`;
  const Z = `${B}/git/repositories/repo-1`;
  return () => [
    { method: 'GET', path: `^${esc(`${B}/git/repositories/${repo}`)}\\?api-version=7\\.1$`, body: { id: 'repo-1', name: repo } },
    { method: 'GET', path: `^${esc(`${Z}/refs`)}\\?filter=heads%2Fmain&`, body: { value: [{ name: 'refs/heads/main', objectId: 'base-sha' }, { name: 'refs/heads/main-old', objectId: 'x' }] } },
    { method: 'GET', path: `^${esc(`${Z}/refs`)}\\?`, body: { value: [] } },
    ...Object.entries(existing).map(([path, content]): FakeRoute => ({ method: 'GET', path: `^${esc(`${Z}/items`)}\\?path=${esc(encodeURIComponent(`/${path}`))}&versionDescriptor\\.version=main&`, body: { objectId: 'o', content } })),
    { method: 'GET', path: `^${esc(`${Z}/items`)}\\?`, status: 404, body: {} },
    { method: 'POST', path: `^${esc(`${Z}/pushes`)}\\?`, status: 201, body: {} },
    { method: 'GET', path: `^${esc(`${Z}/pullrequests`)}\\?`, body: { value: [] } },
    { method: 'POST', path: `^${esc(`${Z}/pullrequests`)}\\?`, status: 201, body: { pullRequestId: 7, url: 'https://dev.azure.example/pr/7' } },
    { method: 'GET', path: `^${esc(`${B}/pipelines`)}\\?`, body: { value: o.pipelines ?? [] } },
    { method: 'POST', path: `^${esc(`${B}/pipelines`)}\\?`, body: { id: 42 } },
  ];
}

/** The repository files a CI package carries: its repo-files.json resource. */
function repoFilesOf(files: Record<string, string>): Record<string, string> {
  return JSON.parse(pkgOf(files).spec.resources.find((r) => r.name === 'repo-files.json')!.content) as Record<string, string>;
}

const gitSettings = (provider: string, repository: string, apiPath = '', extra: Record<string, unknown> = {}) => (host: string) => ({
  gitProvider: provider,
  gitApi: `https://${host}${apiPath}`,
  repository,
  gitToken: TOKEN,
  ...extra,
});
const gitWrites = (requests: FakeRequest[]) => requests.filter((r) => r.method !== 'GET').map(line);

describe('pipelines package: the Terraform pipeline, proposed on GitHub', { skip: !CURL }, () => {
  const files = build('pipe_ci_terraform');
  staticChecks(files, ['gitToken']);
  const repo = repoFilesOf(files);
  const branch = 'archtoolkit/pipe-ci-terraform';

  it('carries exactly the pipeline file, as the native file beside it', () => {
    expect(Object.keys(repo)).toEqual(['.github/workflows/terraform.yml']);
    expect(repo['.github/workflows/terraform.yml']).toBe(files['.github/workflows/terraform.yml']!);
  });

  it('dry run by default: compares, writes nothing', async () => {
    const { result, requests } = await run(files, githubRoutes('acme/infra', branch), gitSettings('github', 'acme/infra'));
    expect(result.error).toBe(null);
    expect(gitWrites(requests)).toEqual([]);
    expect(plannedCount(result)).toBe(3);
    expect(result.outputs.pullRequest).toBe('');
  });

  it('armed: branch from main, the file on it, a pull request', async () => {
    const { result, requests } = await run(files, githubRoutes('acme/infra', branch), gitSettings('github', 'acme/infra', '', { dryRun: false }), { dryRun: false });
    expect(result.error).toBe(null);
    expect(requests.map(line)).toEqual([
      'GET /repos/acme/infra/git/ref/heads/main',
      'GET /repos/acme/infra/contents/.github/workflows/terraform.yml',
      `GET /repos/acme/infra/git/ref/heads/${branch}`,
      'POST /repos/acme/infra/git/refs',
      'PUT /repos/acme/infra/contents/.github/workflows/terraform.yml',
      'GET /repos/acme/infra/pulls',
      'POST /repos/acme/infra/pulls',
    ]);
    expect(requests[1]!.path).toContain('?ref=main');
    expect(JSON.parse(requests[3]!.body)).toEqual({ ref: `refs/heads/${branch}`, sha: 'base-sha' });
    const put = JSON.parse(requests[4]!.body) as { content: string; branch: string; sha?: string };
    expect(unb64(put.content)).toBe(repo['.github/workflows/terraform.yml']!);
    expect(put.branch).toBe(branch);
    expect(put.sha).toBe(undefined);
    expect(requests[5]!.path).toContain(`head=${encodeURIComponent(`acme:${branch}`)}`);
    expect((JSON.parse(requests[6]!.body) as { head: string; base: string }).base).toBe('main');
    for (const r of requests) {
      expect(r.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(r.headers['user-agent']).toBe('ArchToolKit-Orchestrator');
    }
    expect(result.outputs.pullRequest).toBe('https://github.example/pr/1');
    expect(result.outputs.changedFiles).toBe(1);
  });

  it('proposes nothing when main already has the file as generated', async () => {
    const { result, requests } = await run(files, githubRoutes('acme/infra', branch, repo), gitSettings('github', 'acme/infra', '', { dryRun: false }));
    expect(result.error).toBe(null);
    expect(requests.map(line)).toEqual(['GET /repos/acme/infra/git/ref/heads/main', 'GET /repos/acme/infra/contents/.github/workflows/terraform.yml']);
    expect(result.outputs.changedFiles).toBe(0);
  });

  it('updates a file that differs, with its blob sha', async () => {
    const { requests } = await run(files, githubRoutes('acme/infra', branch, { '.github/workflows/terraform.yml': 'name: old\n' }), gitSettings('github', 'acme/infra', '', { dryRun: false }));
    expect((JSON.parse(requests.find((r) => r.method === 'PUT')!.body) as { sha: string }).sha).toBe('sha-.github/workflows/terraform.yml');
  });

  it('stops at the cap', async () => {
    const { result, requests } = await run(files, githubRoutes('acme/infra', branch), gitSettings('github', 'acme/infra', '', { dryRun: false, cap: 1 }));
    expect(gitWrites(requests)).toEqual(['POST /repos/acme/infra/git/refs']);
    expect(result.error ?? '').toContain('Cap reached: 1 change(s) made, the cap is 1; stopping before: add .github/workflows/terraform.yml');
  });

  it('stops at the first failure, before opening a pull request', async () => {
    const { result, requests } = await run(files, githubRoutes('acme/infra', branch, {}, { putStatus: 422 }), gitSettings('github', 'acme/infra', '', { dryRun: false }));
    expect(gitWrites(requests)).toEqual(['POST /repos/acme/infra/git/refs', 'PUT /repos/acme/infra/contents/.github/workflows/terraform.yml']);
    expect(result.error ?? '').toContain('Stopped after 1 change(s): add .github/workflows/terraform.yml on');
  });
});

describe('pipelines package: the Terraform pipeline, proposed on Azure DevOps', { skip: !CURL }, () => {
  const files = build('pipe_ci_terraform', { ci: 'azdo' });
  staticChecks(files, ['gitToken']);
  const repo = repoFilesOf(files);
  const Z = '/acme/infra/_apis/git/repositories/repo-1';

  it('first run: one push to a new branch from main, a pull request, and no pipeline yet', async () => {
    const { result, requests } = await run(files, azdoRoutes('infra', 'terraform'), gitSettings('azdo', 'infra/terraform', '/acme', { dryRun: false }));
    expect(result.error).toBe(null);
    expect(gitWrites(requests)).toEqual([`POST ${Z}/pushes`, `POST ${Z}/pullrequests`]);
    const push = JSON.parse(requests.find((r) => r.path.includes('/pushes'))!.body) as { refUpdates: { name: string; oldObjectId: string }[]; commits: { changes: { changeType: string; item: { path: string }; newContent: { content: string } }[] }[] };
    expect(push.refUpdates).toEqual([{ name: 'refs/heads/archtoolkit/pipe-ci-terraform', oldObjectId: 'base-sha' }]);
    expect(push.commits[0]!.changes).toEqual([{ changeType: 'add', item: { path: '/azure-pipelines.yml' }, newContent: { content: repo['azure-pipelines.yml']!, contentType: 'rawtext' } }]);
    expect(requests.every((r) => r.headers.authorization === `Basic ${b64(`:${TOKEN}`)}`)).toBe(true);
    expect(requests.some((r) => r.path.includes('/_apis/pipelines'))).toBe(false);
    expect(result.logs.some((l) => l.message.includes('created on the run after'))).toBe(true);
  });

  it('after the merge: nothing to propose, and the pipeline definition is created once', async () => {
    const { result, requests } = await run(files, azdoRoutes('infra', 'terraform', repo), gitSettings('azdo', 'infra/terraform', '/acme', { dryRun: false }));
    expect(result.error).toBe(null);
    expect(gitWrites(requests)).toEqual(['POST /acme/infra/_apis/pipelines']);
    const body = JSON.parse(requests.find((r) => r.method === 'POST')!.body) as { name: string; configuration: { type: string; path: string; repository: { id: string; type: string } } };
    expect(body.name).toBe('pipe-ci-terraform');
    expect(body.configuration).toEqual({ type: 'yaml', path: '/azure-pipelines.yml', repository: { id: 'repo-1', type: 'azureReposGit' } });
    const again = await run(files, azdoRoutes('infra', 'terraform', repo, { pipelines: [{ id: 42, name: 'pipe-ci-terraform' }] }), gitSettings('azdo', 'infra/terraform', '/acme', { dryRun: false }));
    expect(gitWrites(again.requests)).toEqual([]);
  });

  it('dry run by default writes nothing', async () => {
    const { result, requests } = await run(files, azdoRoutes('infra', 'terraform'), gitSettings('azdo', 'infra/terraform', '/acme'));
    expect(result.error).toBe(null);
    expect(gitWrites(requests)).toEqual([]);
  });
});

describe('pipelines package: cloud templates in CI, proposed on GitLab', { skip: !CURL }, () => {
  const files = build('pipe_template_ci', { ci: 'gitlab' });
  staticChecks(files, ['gitToken']);
  const repo = repoFilesOf(files);
  const P = `/api/v4/projects/${encodeURIComponent('platform/templates')}`;
  const branch = 'archtoolkit/pipe-template-ci';
  const existing = { '.gitlab-ci.yml': 'stages: [old]\n', 'ci/vcfa-lib.sh': repo['ci/vcfa-lib.sh']! };

  it('carries the pipeline file and every script it runs, as generated', () => {
    expect(Object.keys(repo).sort()).toEqual(['.gitlab-ci.yml', 'ci/delete-test.sh', 'ci/lint-templates.sh', 'ci/release-templates.sh', 'ci/vcfa-lib.sh', 'templates/README-layout.txt']);
    for (const [path, body] of Object.entries(repo)) expect(files[path]).toBe(body);
    // Committed through an API that cannot set the executable bit, so every script is run with bash.
    expect(files['.gitlab-ci.yml']!).toContain('- bash ci/release-templates.sh --execute');
  });

  it('dry run by default writes nothing', async () => {
    const { result, requests } = await run(files, gitlabRoutes('platform/templates', branch, existing), gitSettings('gitlab', 'platform/templates'));
    expect(result.error).toBe(null);
    expect(gitWrites(requests)).toEqual([]);
    expect(plannedCount(result)).toBe(2);
  });

  it('armed: one commit that starts the branch from main with only what differs, then a merge request', async () => {
    const { result, requests } = await run(files, gitlabRoutes('platform/templates', branch, existing), gitSettings('gitlab', 'platform/templates', '', { dryRun: false }), { dryRun: false });
    expect(result.error).toBe(null);
    expect(gitWrites(requests)).toEqual([`POST ${P}/repository/commits`, `POST ${P}/merge_requests`]);
    const commit = JSON.parse(requests.find((r) => r.path.endsWith('/commits'))!.body) as { branch: string; start_branch: string; actions: { action: string; file_path: string; content: string }[] };
    expect(commit.branch).toBe(branch);
    expect(commit.start_branch).toBe('main');
    expect(commit.actions.map((a) => `${a.action} ${a.file_path}`)).toEqual([
      'update .gitlab-ci.yml',
      'create ci/delete-test.sh',
      'create ci/lint-templates.sh',
      'create ci/release-templates.sh',
      'create templates/README-layout.txt',
    ]);
    for (const a of commit.actions) expect(a.content).toBe(repo[a.file_path]!);
    expect((JSON.parse(requests[requests.length - 1]!.body) as { target_branch: string }).target_branch).toBe('main');
    expect(requests.every((r) => r.headers['private-token'] === TOKEN)).toBe(true);
    expect(result.outputs.pullRequest).toBe('https://gitlab.example/mr/3');
    expect(result.outputs.changedFiles).toBe(5);
  });

  it('stops at the cap and at the first failure', async () => {
    const capped = await run(files, gitlabRoutes('platform/templates', branch, existing), gitSettings('gitlab', 'platform/templates', '', { dryRun: false, cap: 1 }));
    expect(gitWrites(capped.requests)).toEqual([`POST ${P}/repository/commits`]);
    expect(capped.result.error ?? '').toContain('Cap reached: 1 change(s) made');
    const failed = await run(files, gitlabRoutes('platform/templates', branch, existing, { commitStatus: 400 }), gitSettings('gitlab', 'platform/templates', '', { dryRun: false }));
    expect(gitWrites(failed.requests)).toEqual([`POST ${P}/repository/commits`]);
    expect(failed.result.error ?? '').toContain('Stopped after 0 change(s): commit .gitlab-ci.yml');
  });

  it('logs in to VCF Automation 9 with the organization token when VCFA_ORG is set', () => {
    const lib = files['ci/vcfa-lib.sh']!;
    expect(lib).toContain('/oauth/tenant/');
    expect(lib).toContain('/oauth/provider/token');
    expect(lib).toContain('/iaas/api/login');
    expect(files['.gitlab-ci.yml']!).toContain('VCFA_ORG');
  });
});

describe('pipelines package: VCF Operations promotion, proposed on Azure DevOps', { skip: !CURL }, () => {
  const files = build('pipe_ops_promotion', { ci: 'azdo' });
  staticChecks(files, ['gitToken']);
  const repo = repoFilesOf(files);
  const Z = '/acme/ops/_apis/git/repositories/repo-1';

  it('armed: the three files in one push and a pull request; dry run writes nothing; cap and failure stop it', async () => {
    expect(Object.keys(repo).sort()).toEqual(['azure-pipelines.yml', 'promotion/HOW-TO-PROMOTE.md', 'promotion/promote.py']);
    const dry = await run(files, azdoRoutes('ops', 'content'), gitSettings('azdo', 'ops/content', '/acme'));
    expect(gitWrites(dry.requests)).toEqual([]);
    const armed = await run(files, azdoRoutes('ops', 'content'), gitSettings('azdo', 'ops/content', '/acme', { dryRun: false }));
    expect(armed.result.error).toBe(null);
    expect(gitWrites(armed.requests)).toEqual([`POST ${Z}/pushes`, `POST ${Z}/pullrequests`]);
    const push = JSON.parse(armed.requests.find((r) => r.path.includes('/pushes'))!.body) as { commits: { changes: { item: { path: string } }[] }[] };
    expect(push.commits[0]!.changes.map((c) => c.item.path)).toEqual(['/azure-pipelines.yml', '/promotion/HOW-TO-PROMOTE.md', '/promotion/promote.py']);
    const capped = await run(files, azdoRoutes('ops', 'content'), gitSettings('azdo', 'ops/content', '/acme', { dryRun: false, cap: 1 }));
    expect(gitWrites(capped.requests)).toEqual([`POST ${Z}/pushes`]);
    expect(capped.result.error ?? '').toContain('Cap reached');
  });
});

describe('pipelines package: extensibility CI and scheduled checks, proposed on GitHub', { skip: !CURL }, () => {
  for (const [id, overrides, expected] of [
    ['pipe_abx_ci', {}, ['.github/workflows/pipe-abx-ci.yml', 'abx/example-action/action.json', 'abx/example-action/test_handler.py', 'abx/tests/stub_context.py', 'ci/abx-deploy.sh', 'ci/subscriptions-check.sh', 'ci/vcfa-lib.sh', 'ci/vro-import.sh']],
    ['pipe_scheduled_ops', { ci: 'jenkins' }, ['Jenkinsfile', 'ops/acquire-token.sh', 'ops/cert-expiry.sh', 'ops/run-all.sh']],
  ] as const) {
    it(`${id}: dry run writes nothing; armed writes every file and opens one pull request; cap and failure stop it`, async () => {
      const files = build(id, overrides);
      staticChecks(files, ['gitToken']);
      const repo = repoFilesOf(files);
      expect(Object.keys(repo).sort()).toEqual([...expected]);
      const branch = `archtoolkit/${id.replace(/_/g, '-')}`;
      const dry = await run(files, githubRoutes('acme/vcf', branch), gitSettings('github', 'acme/vcf'));
      expect(dry.result.error).toBe(null);
      expect(gitWrites(dry.requests)).toEqual([]);
      const armed = await run(files, githubRoutes('acme/vcf', branch), gitSettings('github', 'acme/vcf', '', { dryRun: false }));
      expect(armed.result.error).toBe(null);
      expect(gitWrites(armed.requests)).toEqual(['POST /repos/acme/vcf/git/refs', ...expected.map((p) => `PUT /repos/acme/vcf/contents/${p}`), 'POST /repos/acme/vcf/pulls']);
      for (const r of armed.requests.filter((x) => x.method === 'PUT')) {
        const path = decodeURIComponent(r.path.replace('/repos/acme/vcf/contents/', ''));
        expect(unb64((JSON.parse(r.body) as { content: string }).content)).toBe(repo[path]!);
      }
      const capped = await run(files, githubRoutes('acme/vcf', branch), gitSettings('github', 'acme/vcf', '', { dryRun: false, cap: 2 }));
      expect(gitWrites(capped.requests).length).toBe(2);
      expect(capped.result.error ?? '').toContain('Cap reached: 2 change(s) made');
      const failed = await run(files, githubRoutes('acme/vcf', branch, {}, { putStatus: 409 }), gitSettings('github', 'acme/vcf', '', { dryRun: false }));
      expect(gitWrites(failed.requests).length).toBe(2);
      expect(failed.result.error ?? '').toContain('Stopped after 1 change(s)');
      // An existing working branch is reused rather than created again.
      const reused = await run(files, githubRoutes('acme/vcf', branch, {}, { branchExists: true }), gitSettings('github', 'acme/vcf', '', { dryRun: false }));
      expect(gitWrites(reused.requests)[0]!.startsWith('PUT ')).toBe(true);
    });
  }

  it('runs every script with bash, so a file committed without the executable bit still runs', () => {
    const scheduled = build('pipe_scheduled_ops');
    expect(scheduled['.github/workflows/pipe-scheduled-ops.yml']!).toContain('run: bash ops/run-all.sh');
    expect(scheduled['ops/run-all.sh']!).toContain('if bash "$script"');
    expect(build('pipe_abx_ci')['.github/workflows/pipe-abx-ci.yml']!).toContain('run: bash ci/abx-deploy.sh --execute');
  });
});
