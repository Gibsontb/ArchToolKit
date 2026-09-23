/**
 * The pipeline blueprints have to produce files the target takes as they are:
 * a VCF Automation Pipelines import file, a workflow at the path the CI looks
 * for, an Azure runbook and a deployable template, an SSM document and a
 * CreateAssociation request, an awxkit import file.
 *
 * Every pipeline blueprint is built with every select option and every toggle
 * flipped, and each importable file is held to its format. The YAML check is
 * deliberately small (no dependencies): documents split on `---`, top-level
 * keys, no tabs, no top-level key twice.
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { defaultValues, type BlueprintValues } from '../kit/blueprint.ts';
import { AUTOMATIONS } from './blueprints/index.ts';

const PIPELINES = AUTOMATIONS.filter((blueprint) => blueprint.platform === 'pipeline');

function everyBuild(ids?: readonly string[]): { id: string; label: string; values: BlueprintValues; files: Record<string, string> }[] {
  const out: { id: string; label: string; values: BlueprintValues; files: Record<string, string> }[] = [];
  for (const blueprint of PIPELINES.filter((b) => !ids || ids.includes(b.id))) {
    const base = defaultValues(blueprint);
    const variants: { label: string; values: BlueprintValues }[] = [{ label: 'defaults', values: { ...base } }];
    for (const input of blueprint.inputs) {
      if (input.control === 'select') for (const option of input.options ?? []) variants.push({ label: `${input.id}=${option.value}`, values: { ...base, [input.id]: option.value } });
      if (input.control === 'toggle') variants.push({ label: `${input.id}=${String(!base[input.id])}`, values: { ...base, [input.id]: !base[input.id] } });
    }
    for (const variant of variants) out.push({ id: blueprint.id, label: variant.label, values: variant.values, files: { ...blueprint.build(variant.values, blueprint.id).files } });
  }
  return out;
}

/** YAML documents in a file, each as its top-level keys and their inline values. */
function yamlDocs(text: string): { keys: string[]; values: Record<string, string> }[] {
  const docs: string[][] = [[]];
  for (const line of text.split('\n')) {
    if (line === '---') docs.push([]);
    else docs[docs.length - 1]?.push(line);
  }
  return docs
    .filter((lines) => lines.some((line) => line.trim() && !line.trim().startsWith('#')))
    .map((lines) => {
      const keys: string[] = [];
      const values: Record<string, string> = {};
      for (const line of lines) {
        const match = /^([A-Za-z_$][\w$.-]*):(?:\s+(.*))?$/.exec(line);
        if (match?.[1]) {
          keys.push(match[1]);
          values[match[1]] = (match[2] ?? '').trim();
        }
      }
      return { keys, values };
    });
}

function yamlProblems(file: string, text: string): string[] {
  const problems: string[] = [];
  text.split('\n').forEach((line, index) => {
    if (/^\t| \t/.test(line)) problems.push(`${file}:${index + 1} has a tab in its indentation`);
  });
  for (const doc of yamlDocs(text)) {
    const twice = doc.keys.filter((key, index) => doc.keys.indexOf(key) !== index);
    if (twice.length > 0) problems.push(`${file}: top-level key twice: ${twice.join(', ')}`);
  }
  return problems;
}

describe('pipelines: VCF Automation Pipelines import file', () => {
  const builds = everyBuild(['pipe_codestream']);

  it('writes one import file per pipeline, variables then endpoints then the pipeline', () => {
    for (const build of builds) {
      const files = Object.keys(build.files).filter((file) => file.startsWith('import/pipelines/'));
      expect(files).toHaveLength(1);
      const text = build.files[files[0] ?? ''] ?? '';
      expect(yamlProblems(files[0] ?? '', text)).toEqual([]);
      const docs = yamlDocs(text);
      const kinds = docs.map((doc) => doc.values.kind);
      expect(kinds[kinds.length - 1]).toBe('PIPELINE');
      const firstEndpoint = kinds.indexOf('ENDPOINT');
      expect(kinds.lastIndexOf('VARIABLE')).toBeLessThan(firstEndpoint);
      for (const doc of docs) {
        for (const key of ['project', 'kind', 'name']) expect(doc.keys).toContain(key);
      }
      const pipeline = docs[docs.length - 1];
      for (const key of ['enabled', 'concurrency', 'input', 'workspace', 'stageOrder', 'stages']) expect(pipeline?.keys).toContain(key);
      // _inputMeta sits inside input in an export, not beside it.
      expect(pipeline?.keys.includes('_inputMeta')).toBe(false);
      expect(/^input:\n(?: {2}.*\n)*? {2}_inputMeta:/m.test(text)).toBe(true);
    }
  });

  it('keeps every secret a SECRET variable with an empty value, referenced as ${var.…}', () => {
    for (const build of builds) {
      const text = Object.entries(build.files).find(([file]) => file.startsWith('import/pipelines/'))?.[1] ?? '';
      const docs = yamlDocs(text);
      const variables = docs.filter((doc) => doc.values.kind === 'VARIABLE');
      for (const variable of variables) {
        expect(['SECRET', 'REGULAR']).toContain(variable.values.type);
        expect(variable.values.value).toBe("''");
      }
      const declared = new Set(variables.map((variable) => variable.values.name));
      for (const match of text.matchAll(/\$\{var\.([A-Za-z0-9_]+)\}/g)) expect(declared.has(match[1])).toBe(true);
      for (const line of text.split('\n')) {
        const match = /^\s*(password|token|privateKey):\s*(.+)$/.exec(line);
        if (match) expect(/^\$\{var\.[A-Za-z0-9_]+\}$/.test(match[2] ?? '')).toBe(true);
      }
    }
  });

  it('gives the API route each object on its own, as JSON or a single YAML document', () => {
    for (const build of builds) {
      for (const [file, body] of Object.entries(build.files)) {
        if (file.startsWith('import/api/') && file.endsWith('.json')) {
          const variable = JSON.parse(body) as Record<string, unknown>;
          expect(variable.kind).toBe('VARIABLE');
          expect(variable.value).toBe('');
        }
        if (file.startsWith('import/api/') && file.endsWith('.yaml')) {
          expect(yamlDocs(body)).toHaveLength(1);
          expect(yamlProblems(file, body)).toEqual([]);
        }
      }
      const script = build.files['import.sh'] ?? '';
      expect(script).toContain('--data-binary');
      expect(script).toContain('/pipeline/api/import?action=create');
      expect(build.files['IMPORT.md']).toBeDefined();
    }
  });
});

describe('pipelines: CI files at the path each CI reads', () => {
  const CI_PATH: Record<string, RegExp> = {
    github: /^\.github\/workflows\/[a-z0-9-]+\.yml$/,
    gitlab: /^\.gitlab-ci\.yml$/,
    azdo: /^azure-pipelines\.yml$/,
    jenkins: /^Jenkinsfile$/,
  };

  it('puts the pipeline file exactly where the CI looks, with an IMPORT.md', () => {
    for (const build of everyBuild()) {
      const ci = build.values.ci;
      if (typeof ci !== 'string' || !(ci in CI_PATH)) continue;
      const pattern = CI_PATH[ci] as RegExp;
      const ciFiles = Object.keys(build.files).filter((file) => Object.values(CI_PATH).some((re) => re.test(file)));
      expect(ciFiles.length).toBe(1);
      expect(pattern.test(ciFiles[0] ?? '')).toBe(true);
      expect(build.files['IMPORT.md']).toContain(ciFiles[0] ?? '?');
      const body = build.files[ciFiles[0] ?? ''] ?? '';
      if (ci !== 'jenkins') expect(yamlProblems(ciFiles[0] ?? '', body)).toEqual([]);
      if (ci === 'github') for (const key of ['name', 'on', 'jobs']) expect(yamlDocs(body)[0]?.keys).toContain(key);
      if (ci === 'jenkins') expect(/^\s*pipeline\s*\{/m.test(body)).toBe(true);
    }
  });
});

describe('pipelines: Azure Automation runbook', () => {
  it('writes a runbook named as Azure names it, and a template that deploys', () => {
    for (const build of everyBuild(['pipe_azure_runbook'])) {
      const ps1 = Object.keys(build.files).filter((file) => /^import\/azure\/[A-Za-z][A-Za-z0-9_-]{0,62}\.ps1$/.test(file));
      expect(ps1).toHaveLength(1);
      const arm = JSON.parse(Object.entries(build.files).find(([file]) => file.endsWith('-schedule.json'))?.[1] ?? '{}') as {
        $schema?: string;
        resources?: { type: string; properties: Record<string, unknown>; name: string; condition?: string }[];
      };
      expect(arm.$schema).toContain('deploymentTemplate.json');
      const types = (arm.resources ?? []).map((resource) => resource.type);
      expect(types).toEqual(['Microsoft.Automation/automationAccounts/schedules', 'Microsoft.Automation/automationAccounts/jobSchedules']);
      const schedule = arm.resources?.[0];
      for (const key of ['frequency', 'startTime']) expect(Object.keys(schedule?.properties ?? {})).toContain(key);
      // isEnabled is not a create property; the link is what is held back.
      expect('isEnabled' in (schedule?.properties ?? {})).toBe(false);
      expect(arm.resources?.[1]?.condition).toBe("[parameters('linkRunbook')]");
      const bicep = Object.entries(build.files).find(([file]) => file.endsWith('.bicep'))?.[1] ?? '';
      expect(bicep).toContain('param linkRunbook bool = false');
      expect(bicep).toContain("= if (linkRunbook)");
      expect(bicep.includes('<REQUIRED')).toBe(false);
      expect(build.files['IMPORT.md']).toContain('az automation runbook replace-content');
    }
  });
});

describe('pipelines: AWS Systems Manager', () => {
  // The members of the CreateAssociation request (AWS SSM API reference).
  const CREATE_ASSOCIATION = new Set([
    'Name', 'DocumentVersion', 'InstanceId', 'Parameters', 'Targets', 'ScheduleExpression', 'OutputLocation', 'AssociationName',
    'AutomationTargetParameterName', 'MaxErrors', 'MaxConcurrency', 'ComplianceSeverity', 'SyncCompliance', 'ApplyOnlyAtCronInterval',
    'CalendarNames', 'TargetLocations', 'ScheduleOffset', 'Duration', 'TargetMaps', 'Tags', 'AlarmConfiguration',
  ]);

  it('writes a schema 2.2 document and a CreateAssociation request that name the same document', () => {
    for (const build of everyBuild(['pipe_ssm_document'])) {
      const [docFile, doc] = Object.entries(build.files).find(([file]) => /^import\/ssm\/[A-Za-z0-9_.-]{3,128}\.yaml$/.test(file)) ?? ['', ''];
      expect(doc.length).toBeGreaterThan(0);
      expect(yamlProblems(docFile, doc)).toEqual([]);
      const top = yamlDocs(doc)[0];
      for (const key of ['schemaVersion', 'description', 'parameters', 'mainSteps']) expect(top?.keys).toContain(key);
      expect(top?.values.schemaVersion).toBe("'2.2'");
      const association = JSON.parse(Object.entries(build.files).find(([file]) => file.endsWith('-association.json'))?.[1] ?? '{}') as Record<string, unknown>;
      expect(Object.keys(association).filter((key) => !CREATE_ASSOCIATION.has(key))).toEqual([]);
      expect(`import/ssm/${String(association.Name)}.yaml`).toBe(docFile);
      expect(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNSPECIFIED']).toContain(association.ComplianceSeverity);
      for (const [key, value] of Object.entries(association.Parameters as Record<string, unknown>)) {
        expect(Array.isArray(value)).toBe(true);
        expect(top ? doc.includes(`  ${key}:`) : false).toBe(true);
      }
    }
  });
});

describe('pipelines: AWX / Automation Platform', () => {
  it('writes the awxkit import format, every reference a natural key', () => {
    for (const build of everyBuild(['pipe_awx_template'])) {
      const text = Object.entries(build.files).find(([file]) => /^import\/awx\/.+\.json$/.test(file))?.[1] ?? '';
      const data = JSON.parse(text) as {
        job_templates: Record<string, unknown>[];
        workflow_job_templates: Record<string, unknown>[];
      };
      expect(Object.keys(data)).toEqual(['job_templates', 'workflow_job_templates']);
      const jt = data.job_templates[0] ?? {};
      for (const key of ['name', 'job_type', 'inventory', 'project', 'playbook', 'natural_key', 'related']) expect(Object.keys(jt)).toContain(key);
      expect((jt.natural_key as { type?: string }).type).toBe('job_template');
      expect((jt.inventory as { type?: string }).type).toBe('inventory');
      expect((jt.project as { type?: string }).type).toBe('project');
      const related = jt.related as { credentials: { type: string; credential_type: { type: string } }[]; survey_spec: { spec: unknown[] } };
      expect(related.credentials[0]?.type).toBe('credential');
      expect(related.credentials[0]?.credential_type.type).toBe('credential_type');
      if (jt.survey_enabled) expect(related.survey_spec.spec.length).toBeGreaterThan(0);

      const wf = data.workflow_job_templates[0] ?? {};
      expect((wf.natural_key as { type?: string }).type).toBe('workflow_job_template');
      const nodes = (wf.related as { workflow_nodes: Record<string, unknown>[] }).workflow_nodes;
      const identifiers = new Set(nodes.map((node) => node.identifier));
      for (const node of nodes) {
        expect((node.natural_key as { type?: string }).type).toBe('workflow_job_template_node');
        const rel = node.related as { success_nodes: { identifier: string; type: string }[]; create_approval_template?: unknown };
        for (const next of rel.success_nodes) {
          expect(next.type).toBe('workflow_job_template_node');
          expect(identifiers.has(next.identifier)).toBe(true);
        }
        if (!rel.create_approval_template) expect((node.unified_job_template as { type?: string }).type).toBe('job_template');
        // A node can only override the job type if the template prompts for it.
        if (node.job_type === 'check') expect(jt.ask_job_type_on_launch).toBe(true);
      }
      expect(build.files['IMPORT.md']).toContain('awx import <');
    }
  });
});

describe('pipelines: every importable file parses', () => {
  it('parses every JSON file and finds no tab-indented YAML, for every option', () => {
    const problems: string[] = [];
    for (const build of everyBuild()) {
      for (const [file, body] of Object.entries(build.files)) {
        if (file.endsWith('.json')) {
          try {
            JSON.parse(body);
          } catch (failure) {
            problems.push(`${build.id} ${build.label} ${file}: ${String(failure)}`);
          }
        }
        if (/\.ya?ml$/.test(file)) problems.push(...yamlProblems(`${build.id} ${build.label} ${file}`, body));
      }
    }
    expect(problems).toEqual([]);
  });
});
