/**
 * Everything the VCF Operations blueprints generate has to import, in the form
 * VCF Operations' own import dialogs and Content Management take. These checks
 * build every VCF Operations blueprint with every select option and every
 * toggle flipped, and hold the output to that shape:
 *
 *   - every blueprint says in IMPORT.md where its files go;
 *   - every .json parses, every .xml is well-formed, every .sh is a bash script;
 *   - each importable file has the wrapper its dialog takes — <alertContent>,
 *     <Content><Views>/<Reports>, {dashboards: [...]}, a super metric object
 *     keyed by id, {customGroups: [...]}, {NotificationRules: [...]};
 *   - the content-management package and the per-type files read back through
 *     the toolkit's own reader of real exports (src/aria/parse.ts), nested
 *     archives and all, and give the same objects back.
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { defaultValues, type BlueprintValues } from '../kit/blueprint.ts';
import { zip } from '../kit/archive.ts';
import { openZip } from '../core/zip.ts';
import { readAriaFile } from '../aria/parse.ts';
import { AUTOMATION_BLUEPRINTS, AUTOMATIONS, automationFor } from './blueprints/index.ts';
import { CONTENT_ZIP, alertContentXml, customGroupsJson, stableId, superMetricsJson } from './vcfops-import.ts';

const OPS_IDS = new Set(AUTOMATION_BLUEPRINTS.find((group) => group.target === 'vcf-operations')?.blueprints.map((b) => b.id) ?? []);
const OPS = AUTOMATIONS.filter((blueprint) => OPS_IDS.has(blueprint.id));

function everyBuild(): { id: string; label: string; files: Record<string, string> }[] {
  const out: { id: string; label: string; files: Record<string, string> }[] = [];
  for (const blueprint of OPS) {
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

/**
 * A small XML well-formedness check: one root, every start tag closed in order,
 * attributes quoted, no bare & or < in text. Enough to catch what goes wrong in
 * generated XML; the toolkit has no dependencies to reach for a real parser.
 */
function xmlProblems(xml: string): string[] {
  const problems: string[] = [];
  let text = xml.replace(/^﻿/, '');
  text = text.replace(/^<\?xml[^?]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const stack: string[] = [];
  let roots = 0;
  const tag = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_:][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/g;
  let last = 0;
  for (const match of text.matchAll(tag)) {
    const between = text.slice(last, match.index);
    if (/<|&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(between)) problems.push(`bad text before <${match[2]}>: ${between.trim().slice(0, 60)}`);
    last = (match.index ?? 0) + match[0].length;
    const [, close, name = '', attrs = '', self] = match;
    if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(attrs)) problems.push(`bare & in attributes of <${name}>`);
    if (close) {
      const open = stack.pop();
      if (open !== name) problems.push(`</${name}> closes <${open ?? 'nothing'}>`);
    } else if (!self) {
      if (stack.length === 0) roots += 1;
      stack.push(name);
    } else if (stack.length === 0) roots += 1;
  }
  if (/[<]/.test(text.slice(last))) problems.push('unparsed markup at the end');
  if (stack.length > 0) problems.push(`unclosed: ${stack.join(' > ')}`);
  if (roots !== 1) problems.push(`${roots} root elements`);
  return problems;
}

async function fromArchive(files: Record<string, string>, path: string): Promise<Uint8Array> {
  const outer = openZip(await zip(files));
  return outer.bytes(path);
}

describe('vcf-operations import: every blueprint', () => {
  it('builds at least one variant of each VCF Operations blueprint', () => {
    expect(OPS.length).toBeGreaterThan(30);
    expect(BUILDS.length).toBeGreaterThan(OPS.length);
  });

  it('says in IMPORT.md where its files go', () => {
    const missing = BUILDS.filter((build) => !build.files['IMPORT.md']?.startsWith('# Importing: ')).map((build) => `${build.id} ${build.label}`);
    expect(missing).toEqual([]);
  });

  it('names in IMPORT.md every import/ file it generates', () => {
    const problems: string[] = [];
    for (const build of BUILDS) {
      const md = build.files['IMPORT.md'] ?? '';
      const top = new Set(Object.keys(build.files).filter((path) => path.startsWith('import/')).map((path) => /^(import\/[^/]+)/.exec(path)?.[1] ?? path));
      for (const path of top) if (!md.includes(path)) problems.push(`${build.id} ${build.label}: ${path}`);
    }
    expect(problems).toEqual([]);
  });

  it('writes JSON that parses and XML that is well-formed', () => {
    const problems: string[] = [];
    for (const build of BUILDS) {
      for (const [path, body] of Object.entries(build.files)) {
        if (path.endsWith('.json')) {
          try {
            JSON.parse(body);
          } catch (error) {
            problems.push(`${build.id} ${build.label}: ${path}: ${String(error)}`);
          }
        }
        if (path.endsWith('.xml')) for (const problem of xmlProblems(body)) problems.push(`${build.id} ${build.label}: ${path}: ${problem}`);
        if (path.endsWith('.sh') && !body.startsWith('#!/usr/bin/env bash')) problems.push(`${build.id}: ${path} has no bash shebang`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('gives each importable file the wrapper its dialog takes', () => {
    const problems: string[] = [];
    const need = (ok: boolean, what: string) => {
      if (!ok) problems.push(what);
    };
    for (const build of BUILDS) {
      const where = `${build.id} ${build.label}`;
      for (const [path, body] of Object.entries(build.files)) {
        const file = path.split('/').pop() ?? path;
        if (path === 'import/alert-definitions.xml' || /vcfops-content\.zip\/(alertdefs|symptomdefs|recommendationdefs)\.xml$/.test(path)) {
          need(/^<\?xml[^>]*\?>\s*<alertContent>/.test(body) && body.trimEnd().endsWith('</alertContent>'), `${where}: ${path} is not <alertContent>`);
        }
        if (path === 'import/alert-definitions.xml') {
          need(body.includes('<AlertDefinitions>') && body.includes('<SymptomDefinitions>'), `${where}: ${path} lacks AlertDefinitions or SymptomDefinitions`);
          // Every symptom an alert refers to is defined in the same file.
          const refs = [...body.matchAll(/<Symptom ref="([^"]+)"/g)].map((m) => m[1]);
          for (const ref of refs) need(body.includes(`<SymptomDefinition adapterKind="VMWARE" cancelCycle`) && body.includes(`id="${ref}"`), `${where}: symptom ${ref} referred to but not defined`);
          const recs = [...body.matchAll(/<Recommendation priority="\d+" ref="([^"]+)"/g)].map((m) => m[1]);
          for (const ref of recs) need(body.includes(`<Recommendation key="${ref}">`), `${where}: recommendation ${ref} referred to but not defined`);
        }
        if (/(^import\/view\.(xml|zip\/content\.xml)$)|views\.zip\/content\.xml$/.test(path)) need(/<Content>\s*<Views>\s*<ViewDef id="[0-9a-f-]{36}">/.test(body) && body.includes('<Presentation type='), `${where}: ${path} is not <Content><Views><ViewDef>`);
        if (/(^import\/report\.(xml|zip\/content\.xml)$)|reports\.zip\/content\.xml$/.test(path)) need(/<Content>\s*<Reports>\s*<ReportDef id="[0-9a-f-]{36}">/.test(body) && body.includes('<Sections>') && body.includes('<OutputFormat>'), `${where}: ${path} is not <Content><Reports><ReportDef>`);
        if (path === 'import/dashboard.json' || path.endsWith('dashboard.zip/dashboard/dashboard.json')) {
          const json = JSON.parse(body) as { dashboards?: { id?: string; name?: string; widgets?: { gridsterCoords?: unknown }[]; widgetInteractions?: unknown[] }[]; entries?: unknown; uuid?: string };
          need(Array.isArray(json.dashboards) && json.dashboards.length === 1 && typeof json.uuid === 'string' && typeof json.entries === 'object', `${where}: ${path} is not {entries, dashboards, uuid}`);
          const dashboard = json.dashboards?.[0];
          need(Boolean(dashboard?.id && dashboard.name && Array.isArray(dashboard.widgetInteractions)), `${where}: ${path} dashboard lacks id, name or widgetInteractions`);
          need((dashboard?.widgets ?? []).every((widget) => typeof widget.gridsterCoords === 'object'), `${where}: ${path} widget without gridsterCoords`);
        }
        if (path === 'import/supermetric.json' || path.endsWith('vcfops-content.zip/supermetrics.json')) {
          const json = JSON.parse(body) as Record<string, { name?: string; formula?: string; resourceKinds?: unknown[] }>;
          const entries = Object.entries(json);
          need(entries.length > 0 && entries.every(([id, metric]) => /^[0-9a-f-]{36}$/.test(id) && typeof metric.name === 'string' && typeof metric.formula === 'string' && Array.isArray(metric.resourceKinds)), `${where}: ${path} is not keyed by id with name, formula, resourceKinds`);
        }
        if (path === 'import/custom-group.json' || path.endsWith('vcfops-content.zip/customgroups.json')) {
          const json = JSON.parse(body) as { customGroups?: { name?: string; adapterKind?: string; membershipDefinition?: { ruleGroups?: unknown[] } }[] };
          need(Array.isArray(json.customGroups) && json.customGroups.every((group) => group.name && group.adapterKind === 'Container' && Array.isArray(group.membershipDefinition?.ruleGroups)), `${where}: ${path} is not {customGroups: [...]}`);
        }
        if (path === 'import/notification-rule.json' || path.endsWith('vcfops-content.zip/notificationrules.json')) {
          const json = JSON.parse(body) as { NotificationRules?: { name?: string; pluginId?: string }[] };
          need(Array.isArray(json.NotificationRules) && json.NotificationRules.every((rule) => rule.name && rule.pluginId), `${where}: ${path} is not {NotificationRules: [...]}`);
        }
        if (path.endsWith('vcfops-content.zip/configuration.json')) need(JSON.parse(body).type === 'CUSTOM', `${where}: ${path} has no type`);
        if (file === 'merge-policy.sh') need(body.includes('/suite-api/api/policies/import?forceImport=true') && body.includes('policy=@'), `${where}: ${path} does not import the merged policy`);
      }
      // A content package always comes with the script that completes and imports it.
      if (Object.keys(build.files).some((path) => path.startsWith(`${CONTENT_ZIP}/`))) {
        const script = Object.entries(build.files).find(([path, body]) => path.endsWith('.sh') && body.includes(CONTENT_ZIP));
        need(Boolean(script), `${where}: a content package with no script that imports it`);
        need(Boolean(script?.[1].includes('L\\.v1') && script[1].includes('/content/operations/import?force=')), `${where}: the content script does not add the instance marker or import`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('never writes a policy file on its own into import/', () => {
    // A policy file holds all of a policy's overrides; importing a fragment drops the rest.
    const bad = BUILDS.flatMap((build) => Object.keys(build.files).filter((path) => path.startsWith('import/') && /polic/i.test(path)).map((path) => `${build.id}: ${path}`));
    expect(bad).toEqual([]);
  });
});

describe('vcf-operations import: reads back as a real export does', () => {
  it('alert content XML round-trips through the Aria Ops reader', async () => {
    const files = automationFor('vcfops_alert_definition')!.build(defaultValues(automationFor('vcfops_alert_definition')!), 'x').files;
    const content = await readAriaFile('alert-definitions.xml', new TextEncoder().encode(files['import/alert-definitions.xml']!));
    expect(content.alerts.length).toBe(1);
    expect(content.alerts[0]?.name).toBe('Host memory pressure sustained');
    expect(content.alerts[0]?.resourceKind).toBe('HostSystem');
    expect(content.symptoms.length).toBe(2);
    expect(content.symptoms.map((s) => s.severity).sort()).toEqual(['critical', 'warning']);
    expect(content.symptoms[0]?.key).toBe('mem|host_usagePct');
    expect(content.symptoms[0]?.operator).toBe('>');
    expect(content.recommendations.length).toBe(1);
  });

  it('the content package, a nested zip in the download, reads back with every object in it', async () => {
    const alert = automationFor('vcfops_alert_definition')!;
    const metric = automationFor('vcfops_super_metric')!;
    const view = automationFor('vcfops_view')!;
    const report = automationFor('vcfops_report')!;
    const group = automationFor('vcfops_scope_group')!;
    const all: Record<string, string> = {};
    for (const blueprint of [alert, metric, view, report, group]) {
      for (const [path, body] of Object.entries(blueprint.build(defaultValues(blueprint), blueprint.id).files)) {
        if (path.startsWith(`${CONTENT_ZIP}/`) && !path.endsWith('configuration.json')) all[path] = body;
      }
    }
    const pkg = await fromArchive(all, CONTENT_ZIP);
    const content = await readAriaFile('vcfops-content.zip', pkg);
    expect(content.alerts.map((a) => a.name)).toEqual(['Host memory pressure sustained']);
    expect(content.symptoms.length).toBe(2);
    expect(content.recommendations.length).toBe(1);
    expect(content.superMetrics.map((m) => m.name)).toEqual(['Cluster — worst VM CPU ready %']);
    expect(content.views.map((v) => v.name)).toEqual(['Cluster capacity overview']);
    expect(content.views[0]?.presentation).toBe('list');
    expect(content.views[0]?.subjects.includes('ClusterComputeResource')).toBe(true);
    expect(content.reports.map((r) => r.name)).toEqual(['Monthly capacity and reclamation']);
    expect(content.groups.map((g) => g.name)).toEqual(['Automation — safe to act on']);
  });

  it('the dashboard zip reads back as a dashboard export, with its view', async () => {
    const blueprint = automationFor('vcfops_dashboard')!;
    const files = blueprint.build(defaultValues(blueprint), blueprint.id).files;
    const archive = await fromArchive(files, 'import/dashboard.zip');
    expect(openZip(archive).names.includes('dashboard/dashboard.json')).toBe(true);
    const content = await readAriaFile('dashboard.zip', archive);
    expect(content.dashboards.length).toBe(1);
    expect(content.dashboards[0]?.name).toBe('Cluster capacity overview');
    expect(content.dashboards[0]?.viewIds).toEqual([stableId('view:Cluster capacity overview')]);
    // The view blueprint writes the view the dashboard asks for.
    const view = automationFor('vcfops_view')!;
    expect((view.build(defaultValues(view), view.id).files['import/view.xml'] ?? '').includes(`<ViewDef id="${stableId('view:Cluster capacity overview')}">`)).toBe(true);
  });

  it('the per-type super metric, custom group and view files read back on their own', async () => {
    const enc = (text: string | undefined) => new TextEncoder().encode(text ?? '');
    const metric = automationFor('vcfops_super_metric')!;
    const sm = await readAriaFile('supermetric.json', enc(metric.build(defaultValues(metric), metric.id).files['import/supermetric.json']));
    expect(sm.superMetrics[0]?.formula.startsWith('max(${adaptertype=VMWARE')).toBe(true);
    const group = automationFor('vcfops_scope_group')!;
    const groups = await readAriaFile('custom-group.json', enc(group.build(defaultValues(group), group.id).files['import/custom-group.json']));
    expect(groups.groups.length).toBe(1);
    const view = automationFor('vcfops_view')!;
    const viewZip = await fromArchive(view.build(defaultValues(view), view.id).files, 'import/view.zip');
    expect(openZip(viewZip).names).toEqual(['content.xml']);
  });
});

describe('vcf-operations import: the format writers', () => {
  it('writes alert content with the symbols the export uses, escaped', () => {
    const xml = alertContentXml({
      alerts: [{ id: 'AlertDefinition-a', name: 'A & B', description: '"q"', adapterKind: 'VMWARE', resourceKind: 'HostSystem', type: 16, subType: 19, impact: 'health', symptomOperator: 'or', symptomRefs: ['SymptomDefinition-s'], recommendationRefs: [] }],
      symptoms: [{ id: 'SymptomDefinition-s', name: 's', adapterKind: 'VMWARE', resourceKind: 'HostSystem', severity: 'warning', waitCycle: 3, cancelCycle: 3, key: 'cpu|x', operator: '>=', value: 80 }],
      recommendations: [],
    });
    expect(xmlProblems(xml)).toEqual([]);
    expect(xml.includes('name="A &amp; B"')).toBe(true);
    expect(xml.includes('operator="&gt;="')).toBe(true);
    expect(xml.includes('value="80.0"')).toBe(true);
    expect(xml.includes('<Recommendations>')).toBe(false);
  });

  it('keys super metrics by id and wraps custom groups', () => {
    const sm = JSON.parse(superMetricsJson([{ id: 'x', name: 'n', formula: 'f', description: '', unitId: '', resourceKinds: [] }]));
    expect(Object.keys(sm)).toEqual(['x']);
    const groups = JSON.parse(customGroupsJson([{ name: 'g', description: '', groupType: 'Environment', autoResolve: true, ruleGroups: [] }]));
    expect(groups.customGroups[0].resourceKind).toBe('Environment');
  });

  it('the XML check catches what it is for', () => {
    expect(xmlProblems('<a><b></a>').length).toBeGreaterThan(0);
    expect(xmlProblems('<a x="1 & 2"/>').length).toBeGreaterThan(0);
    expect(xmlProblems('<a/><b/>').length).toBeGreaterThan(0);
    expect(xmlProblems('<?xml version="1.0"?><a><!-- c --><b x="&lt;"/>t &amp; u</a>')).toEqual([]);
  });
});
