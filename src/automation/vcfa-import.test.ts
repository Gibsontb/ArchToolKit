/**
 * Everything the VCF Automation blueprints generate has to be importable, or it
 * is only a description of the work. These checks build every VCF Automation
 * blueprint with every select option and every toggle flipped, and hold the
 * import/ output to the shape VCF Automation takes:
 *
 *   - every blueprint says in IMPORT.md where its files go;
 *   - every blueprint.yaml has name and version at the top (the git
 *     integration skips a file without them), a formatVersion, and nothing a
 *     YAML parser would refuse for indentation;
 *   - every template folder comes with the script that imports it, every ABX
 *     action with its API body, every workflow with its XML and id.
 *
 * The YAML check is deliberately small — the toolkit has no dependencies — so
 * it checks what goes wrong in generated YAML: tabs, a key at the wrong
 * indentation, a top-level key twice, a missing header.
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { defaultValues, type BlueprintValues } from '../kit/blueprint.ts';
import { AUTOMATION_BLUEPRINTS, AUTOMATIONS } from './blueprints/index.ts';
import { blueprintYaml, stableId, workflowXml } from './vcfa-import.ts';

const VCFA_IDS = new Set(AUTOMATION_BLUEPRINTS.find((group) => group.target === 'vcf-automation')?.blueprints.map((b) => b.id) ?? []);
const VCFA = AUTOMATIONS.filter((blueprint) => VCFA_IDS.has(blueprint.id));

/** Every variant the page can produce from a single choice: each select option, each toggle flipped. */
function everyBuild(): { id: string; label: string; files: Record<string, string> }[] {
  const out: { id: string; label: string; files: Record<string, string> }[] = [];
  for (const blueprint of VCFA) {
    const base = defaultValues(blueprint);
    const variants: { label: string; values: BlueprintValues }[] = [{ label: 'defaults', values: { ...base } }];
    for (const input of blueprint.inputs) {
      if (input.control === 'select') for (const option of input.options ?? []) variants.push({ label: `${input.id}=${option.value}`, values: { ...base, [input.id]: option.value } });
      if (input.control === 'toggle') variants.push({ label: `${input.id}=${String(!base[input.id])}`, values: { ...base, [input.id]: !base[input.id] } });
    }
    for (const variant of variants) out.push({ id: blueprint.id, label: variant.label, files: { ...blueprint.build(variant.values, blueprint.id).files } });
  }
  return out;
}

const BUILDS = everyBuild();

/** The problems with a blueprint.yaml, if any. */
function yamlProblems(text: string): string[] {
  const problems: string[] = [];
  const lines = text.split('\n');
  const topKeys: string[] = [];
  let inBlockScalar = -1;
  lines.forEach((line, index) => {
    const at = `line ${index + 1}`;
    if (/^\t| \t/.test(line) || /^\s*\t/.test(line)) problems.push(`${at}: tab in indentation`);
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    const indent = line.length - line.trimStart().length;
    if (inBlockScalar >= 0) {
      if (indent > inBlockScalar) return;
      inBlockScalar = -1;
    }
    if (indent % 2 !== 0) problems.push(`${at}: odd indentation (${indent})`);
    const top = /^([A-Za-z_$][\w$-]*):(\s|$)/.exec(line);
    if (indent === 0) {
      if (!top) problems.push(`${at}: top-level line is not a key: ${trimmed.slice(0, 40)}`);
      else topKeys.push(top[1]!);
    }
    if (/:\s*[|>][-+]?\s*$/.test(line)) inBlockScalar = indent;
  });
  const firstKeys = topKeys.slice(0, 3);
  if (firstKeys[0] !== 'name') problems.push(`the first key is ${firstKeys[0] ?? 'missing'}, not name`);
  if (firstKeys[1] !== 'version') problems.push(`the second key is ${firstKeys[1] ?? 'missing'}, not version`);
  for (const key of ['name', 'version', 'formatVersion', 'resources']) if (!topKeys.includes(key)) problems.push(`no top-level ${key}:`);
  const dupes = topKeys.filter((key, index) => topKeys.indexOf(key) !== index);
  if (dupes.length > 0) problems.push(`top-level key repeated: ${dupes.join(', ')}`);
  const name = /^name:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? '';
  if (!name || name === '""') problems.push('empty name');
  const version = /^version:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? '';
  if (!/^\d+\.\d+\.\d+$/.test(version)) problems.push(`version "${version}" is not major.minor.patch`);
  return problems;
}

describe('vcfa import: every VCF Automation blueprint says where its files go', () => {
  it('covers the whole VCF Automation group', () => {
    expect(VCFA.length).toBeGreaterThan(30);
  });

  it('writes IMPORT.md for every blueprint and every choice', () => {
    const missing = BUILDS.filter((build) => !build.files['IMPORT.md']?.startsWith('# Importing this into VCF Automation')).map((b) => `${b.id} (${b.label})`);
    expect(missing).toEqual([]);
  });

  it('only names scripts in IMPORT.md that are in the output', () => {
    const problems: string[] = [];
    for (const build of BUILDS) {
      const named = [...(build.files['IMPORT.md'] ?? '').matchAll(/`\.\/((?:import\/)?[\w.-]+\.sh)/g)].map((m) => m[1]!);
      for (const script of new Set(named)) if (!build.files[script]) problems.push(`${build.id} (${build.label}): IMPORT.md names ${script}, which is not generated`);
    }
    expect(problems).toEqual([]);
  });
});

describe('vcfa import: cloud templates', () => {
  it('writes every template as import/templates/<name>/blueprint.yaml that a YAML parser and the git integration accept', () => {
    const problems: string[] = [];
    let count = 0;
    for (const build of BUILDS) {
      for (const [path, body] of Object.entries(build.files)) {
        if (!path.endsWith('/blueprint.yaml')) continue;
        count++;
        if (!/^import\/templates\/[a-z0-9-]+\/blueprint\.yaml$/.test(path)) problems.push(`${build.id}: ${path} is not in the git layout`);
        for (const problem of yamlProblems(body)) problems.push(`${build.id} (${build.label}) ${path}: ${problem}`);
      }
    }
    expect(problems).toEqual([]);
    expect(count).toBeGreaterThan(20);
  });

  it('ships the import script beside every template folder', () => {
    const missing = BUILDS.filter((build) => Object.keys(build.files).some((f) => f.endsWith('/blueprint.yaml')) && !build.files['import/import-templates.sh']).map((b) => b.id);
    expect(missing).toEqual([]);
  });

  it('gives every blueprint that writes a template YAML an importable copy of it', () => {
    // Any generated file that is a whole template (formatVersion plus resources)
    // must also exist as a blueprint.yaml.
    const problems: string[] = [];
    for (const build of BUILDS) {
      const templates = Object.entries(build.files).filter(([path, body]) => /\.ya?ml$/.test(path) && !path.startsWith('import/') && !/k8s|cluster\.yaml|application\.yaml/.test(path) && /^formatVersion:/m.test(body) && /^resources:/m.test(body));
      if (templates.length > 0 && !Object.keys(build.files).some((f) => f.endsWith('/blueprint.yaml'))) problems.push(`${build.id}: ${templates.map(([p]) => p).join(', ')} has no import/templates copy`);
    }
    expect(problems).toEqual([]);
  });

  it('puts name and version above the template, keeping its leading comments', () => {
    const out = blueprintYaml({ name: 'A: template', description: 'x', yaml: '# about it\nformatVersion: 2\nresources: {}\n' });
    expect(out.split('\n').slice(0, 5)).toEqual(['# about it', 'name: "A: template"', 'version: 1.0.0', 'description: "x"', 'formatVersion: 2']);
    expect(blueprintYaml({ name: 'b', description: 'y', yaml: 'resources: {}' }).includes('formatVersion: 1')).toBe(true);
  });

  it('logs in, validates, then creates or updates, then versions — and only with --execute', () => {
    const build = BUILDS.find((b) => b.id === 'vcfa_cloud_template');
    const script = build?.files['import/import-templates.sh'] ?? '';
    for (const step of ['/blueprint/api/blueprint-validation', 'POST "$VCFA_URL/blueprint/api/blueprints"', 'PUT "$VCFA_URL/blueprint/api/blueprints/$ID"', '/blueprint/api/blueprints/$ID/versions', 'release: ($r == 1)']) {
      expect(script.includes(step)).toBe(true);
    }
    expect(script.indexOf('if (( DRY_RUN ))') < script.indexOf('call POST "$VCFA_URL/blueprint/api/blueprints" ')).toBe(true);
  });
});

describe('vcfa import: extensibility and Orchestrator', () => {
  it('gives every ABX action its API body, its script and the scripts that import it', () => {
    const problems: string[] = [];
    for (const build of BUILDS) {
      const bodies = Object.keys(build.files).filter((f) => /^import\/abx\/[^/]+\/action\.json$/.test(f));
      for (const body of bodies) {
        const dir = body.replace(/action\.json$/, '');
        const parsed = JSON.parse(build.files[body]!) as Record<string, unknown>;
        for (const key of ['name', 'runtime', 'entrypoint', 'actionType', 'timeoutSeconds']) if (parsed[key] === undefined) problems.push(`${build.id}: ${body} has no ${key}`);
        if (!Object.keys(build.files).some((f) => f.startsWith(dir) && /\.(py|js)$/.test(f))) problems.push(`${build.id}: no script in ${dir}`);
      }
      if (bodies.length > 0) for (const s of ['import/create-abx-action.sh', 'import/package-abx.sh', 'import/package-abx.ps1']) if (!build.files[s]) problems.push(`${build.id}: no ${s}`);
    }
    expect(problems).toEqual([]);
    expect(BUILDS.some((b) => b.files['import/abx/register-in-the-cmdb/subscription.json'])).toBe(true);
  });

  it('writes each workflow as XML vRO reads, with a stable id and an end item', () => {
    const problems: string[] = [];
    for (const build of BUILDS) {
      for (const [path, body] of Object.entries(build.files)) {
        if (!path.endsWith('/workflow-content.xml')) continue;
        if (!body.startsWith("<?xml version='1.0' encoding='UTF-8'?>")) problems.push(`${build.id}: ${path} declaration`);
        if (!/root-name="item1"/.test(body) || !/<workflow-item name="item0" type="end" end-mode="0">/.test(body)) problems.push(`${build.id}: ${path} start or end item`);
        if (/allowed-operations/.test(body)) problems.push(`${build.id}: ${path} is marked read-only`);
        const opens = (body.match(/<workflow-item\b/g) ?? []).length;
        const closes = (body.match(/<\/workflow-item>/g) ?? []).length;
        if (opens !== closes) problems.push(`${build.id}: ${path} unbalanced workflow-item`);
        const meta = build.files[path.replace('workflow-content.xml', 'workflow.json')];
        if (!meta || !body.includes(`id="${(JSON.parse(meta) as { id: string }).id}"`)) problems.push(`${build.id}: ${path} id does not match workflow.json`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('keeps CDATA intact when a script contains its terminator', () => {
    const xml = workflowXml({ name: 'x', category: 'c', description: 'd', inputs: [], outputs: [], script: 'var a = "]]>";' });
    expect(xml.includes('"]]]]><![CDATA[>"')).toBe(true);
  });

  it('points the day-2 action and the custom resource at the workflow ids they import with', () => {
    const resourceAction = BUILDS.find((b) => b.id === 'vcfa_resource_action' && b.label === 'defaults');
    const meta = JSON.parse(resourceAction?.files['import/orchestrator/workflows/extend-disk/workflow.json'] ?? '{}') as { id?: string };
    expect(Boolean(meta.id) && (resourceAction?.files['vcfa-resource-action.json'] ?? '').includes(meta.id ?? 'none')).toBe(true);
    expect(stableId('same')).toBe(stableId('same'));
    expect(stableId('one') === stableId('two')).toBe(false);
  });
});

describe('vcfa import: scripts', () => {
  it('starts every generated shell script with a shebang, and is a dry run unless told otherwise', () => {
    const problems: string[] = [];
    for (const build of BUILDS) {
      for (const [path, body] of Object.entries(build.files)) {
        if (!path.startsWith('import/') || !path.endsWith('.sh')) continue;
        if (!body.startsWith('#!/usr/bin/env bash')) problems.push(`${build.id}: ${path} shebang`);
        if (path !== 'import/package-abx.sh' && !body.includes('DRY_RUN=1')) problems.push(`${build.id}: ${path} is not a dry run by default`);
      }
    }
    expect(problems).toEqual([]);
  });
});
