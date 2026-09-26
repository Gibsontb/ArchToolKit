/**
 * The generic half of the Orchestrator workflow blueprint: a workflow whose
 * inputs, outputs and configuration attributes are rows on the page, written
 * in JavaScript or — for the scriptable task itself — Python, PowerShell or
 * Node.js with an Orchestrator environment for its dependencies, and wired to
 * a VCF Automation event subscription or a schedule, created enabled.
 */

import { bool, str, type BlueprintInput, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, warning, type Finding } from '../../core/findings.ts';
import type { VroConfigAttribute } from '../../kit/vro-package.ts';
import { applyScript } from '../apply.ts';
import { apiStep, type ImportStep } from '../vcfa-import.ts';
import { EVENT_TOPICS, RECURRENCE, SRC, json, rowsOf, scheduledTaskBody, underScripts, workflowSubscription } from './vcf-automation-extend-core.ts';

type Param = { name: string; type: string; description: string };

/** The page inputs the generic workflow adds, after the blueprint's own. */
export const GENERIC_WORKFLOW_INPUTS: readonly BlueprintInput[] = [
  { id: 'inputs_rows', label: 'Inputs', control: 'textarea', default: 'target | string | Whatever the workflow acts on', hint: 'Input | Type | Description', help: 'Orchestrator types: string, number, boolean, Array/string, Properties, SecureString, Date, or a plugin type such as VC:VirtualMachine. dryRun is added for you.', showWhen: { input: 'task', equals: ['custom'] } },
  { id: 'outputs_rows', label: 'Outputs', control: 'textarea', default: 'result | string | What it did', hint: 'Output | Type | Description', showWhen: { input: 'task', equals: ['custom'] } },
  { id: 'attributes_rows', label: 'Configuration attributes', control: 'textarea', default: 'targetAllowList | string | app-, web- | Name prefixes it may act on', hint: 'Attribute | Type | Value | Description', help: 'The settings the workflow reads. Type string, number, boolean or SecureString; a SecureString is created empty and typed in after import.', showWhen: { input: 'task', equals: ['custom'] } },
  {
    id: 'language',
    label: 'Scriptable task language',
    control: 'select',
    options: [
      { value: 'javascript', label: 'JavaScript' },
      { value: 'python', label: 'Python' },
      { value: 'powershell', label: 'PowerShell' },
      { value: 'node', label: 'Node.js' },
    ],
    default: 'javascript',
  },
  { id: 'environment_deps', label: 'Environment dependencies', control: 'text', default: '', placeholder: 'requests==2.32.3', hint: 'Comma-separated packages for the Orchestrator environment', showWhen: { input: 'language', notEquals: ['javascript'] } },
  { id: 'subscribe', label: 'Run it on a VCF Automation event', control: 'toggle', default: false },
  { id: 'subscription_topic', label: 'Event topic', control: 'combo', options: EVENT_TOPICS.map((t) => ({ value: t, label: t })), default: 'compute.provision.post', showWhen: { input: 'subscribe', equals: ['true'] } },
  { id: 'subscription_blocking', label: 'Blocking', control: 'toggle', default: false, hint: 'The deployment waits for it', showWhen: { input: 'subscribe', equals: ['true'] } },
  { id: 'subscription_criteria', label: 'Only when', control: 'text', default: '', placeholder: "event.data.projectName == 'Application Team A'", hint: 'Empty runs it for every event of the topic', showWhen: { input: 'subscribe', equals: ['true'] } },
  {
    id: 'schedule',
    label: 'Run it on a schedule',
    control: 'select',
    options: [{ value: 'none', label: 'No' }, ...Object.entries(RECURRENCE).map(([value, r]) => ({ value, label: r.label }))],
    default: 'none',
  },
  { id: 'schedule_start', label: 'First run', control: 'text', default: '2026-10-01T02:00:00Z', hint: 'ISO 8601, UTC', showWhen: { input: 'schedule', notEquals: ['none'] } },
  { id: 'schedule_timezone', label: 'Time zone', control: 'text', default: 'UTC', placeholder: 'Europe/London', showWhen: { input: 'schedule', notEquals: ['none'] } },
  { id: 'schedule_inputs', label: 'Scheduled run inputs', control: 'textarea', default: '', placeholder: 'target | app-01', hint: 'Input | Value', showWhen: { input: 'schedule', notEquals: ['none'] } },
];

const CONFIG_TYPES = ['string', 'number', 'boolean', 'SecureString', 'Array/string'];

/** The custom task's inputs, outputs and attributes from the rows, checked. */
export function customRows(values: BlueprintValues): { inputs: Param[]; outputs: Param[]; attributes: { key: string; type: VroConfigAttribute['type']; value: string; description: string }[]; findings: Finding[] } {
  const findings: Finding[] = [];
  const params = (id: string, what: string): Param[] =>
    rowsOf(str(values, id, ''), 3).flatMap(([name = '', type = '', description = '']) => {
      if (name === 'dryRun') return [];
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        findings.push(error('vcfa.vro.bad-param', `${what} "${name}" is not a workflow parameter name (letters, digits, underscore).`, { source: SRC }));
        return [];
      }
      return [{ name, type: type || 'string', description: description || name }];
    });
  const inputs = params('inputs_rows', 'Input');
  const outputs = params('outputs_rows', 'Output');
  const attributes = rowsOf(str(values, 'attributes_rows', ''), 4).flatMap(([key = '', type = '', value = '', description = '']) => {
    const kind = (CONFIG_TYPES.includes(type) ? type : 'string') as VroConfigAttribute['type'];
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      findings.push(error('vcfa.vro.bad-attribute', `Attribute "${key}" is not a configuration attribute name.`, { source: SRC }));
      return [];
    }
    if (type && !CONFIG_TYPES.includes(type)) findings.push(warning('vcfa.vro.attribute-type', `Attribute ${key}: "${type}" is written as string; configuration attributes here are ${CONFIG_TYPES.join(', ')}.`, { source: SRC }));
    if (/password|secret|token|apikey|api_key/i.test(key) && kind !== 'SecureString') findings.push(error('vcfa.vro.secret-not-secure', `Attribute ${key} looks like a secret and is not a SecureString, so it would be exported in clear with the package.`, { remediation: 'Make it SecureString and leave the value empty; type it in after import.', source: SRC }));
    if (kind === 'SecureString' && value) findings.push(error('vcfa.vro.secret-value', `Attribute ${key} is a SecureString with a value on the page; secrets are typed into Orchestrator, never written into files.`, { source: SRC }));
    return [{ key, type: kind, value: kind === 'SecureString' ? '' : value, description: description || key }];
  });
  const names = [...inputs, ...outputs].map((p) => p.name);
  for (const dup of new Set(names.filter((n, i) => names.indexOf(n) !== i))) findings.push(error('vcfa.vro.duplicate-param', `${dup} is both an input and an output, or listed twice.`, { source: SRC }));
  if (outputs.length === 0) findings.push(warning('vcfa.vro.no-output', 'The workflow has no output, so a caller cannot tell what it did.', { source: SRC }));
  return { inputs, outputs, attributes, findings };
}

const RUNTIMES: Readonly<Record<string, { runtime: string; ext: string; label: string }>> = {
  python: { runtime: 'python:3.11', ext: 'py', label: 'Python' },
  powershell: { runtime: 'powercli:13-powershell-7.4', ext: 'ps1', label: 'PowerShell (PowerCLI)' },
  node: { runtime: 'node:20', ext: 'js', label: 'Node.js' },
};

/** The scriptable task in another language: the same dry run, settings and failure path. */
function polyglotScript(language: string, o: { name: string; about: string; inputs: readonly Param[]; outputs: readonly Param[]; attributes: readonly { key: string }[] }): string {
  const outs = o.outputs.map((p) => p.name);
  if (language === 'python') {
    return [
      `"""${o.name}: ${o.about}`,
      '',
      'Orchestrator scriptable task, Python runtime. inputs holds the workflow inputs',
      '(and the configuration attributes bound to the task); the dict returned sets the',
      'outputs. Anything but dryRun False is a dry run.',
      '"""',
      '',
      '',
      'def handler(context, inputs):',
      '    dry_run = inputs.get("dryRun", True) is not False',
      ...o.inputs.map((p) => `    ${p.name} = inputs.get("${p.name}")`),
      ...o.inputs.map((p) => `    if ${p.name} in (None, ""):\n        raise ValueError("Input ${p.name} is required")`),
      ...o.attributes.map((a) => `    ${a.key} = inputs.get("${a.key}")  # bind the configuration attribute to this input`),
      `    outputs = {${outs.map((n) => `"${n}": None`).join(', ')}}`,
      '    if dry_run:',
      `        print("DRY RUN: would act on", ${o.inputs[0] ? o.inputs[0].name : '"(no input)"'})`,
      '        return outputs',
      '    # TODO: the work. Raise on failure: a swallowed error reports success.',
      `    raise NotImplementedError("${o.name}: write the work here, then remove this line")`,
      '',
    ].join('\n');
  }
  if (language === 'powershell') {
    return [
      `# ${o.name}: ${o.about}`,
      '# Orchestrator scriptable task, PowerShell runtime. $Inputs holds the workflow',
      '# inputs; the hashtable returned sets the outputs. Anything but dryRun $false is a dry run.',
      'function Handler($Context, $Inputs) {',
      '    $ErrorActionPreference = "Stop"',
      '    $dryRun = -not ($Inputs.dryRun -eq $false)',
      ...o.inputs.map((p) => `    if ([string]::IsNullOrEmpty($Inputs.${p.name})) { throw "Input ${p.name} is required" }`),
      `    $outputs = @{ ${outs.map((n) => `${n} = $null`).join('; ')} }`,
      '    if ($dryRun) {',
      `        Write-Host "DRY RUN: would act on $($Inputs.${o.inputs[0]?.name ?? 'target'})"`,
      '        return $outputs',
      '    }',
      '    # TODO: the work. Throw on failure: a swallowed error reports success.',
      `    throw "${o.name}: write the work here, then remove this line"`,
      '}',
      '',
    ].join('\n');
  }
  return [
    `// ${o.name}: ${o.about}`,
    '// Orchestrator scriptable task, Node.js runtime. inputs holds the workflow inputs;',
    '// the object passed to callback sets the outputs. Anything but dryRun false is a dry run.',
    'exports.handler = (context, inputs, callback) => {',
    '  const dryRun = inputs.dryRun !== false;',
    ...o.inputs.map((p) => `  if (inputs.${p.name} === undefined || inputs.${p.name} === '') return callback(new Error('Input ${p.name} is required'));`),
    `  const outputs = { ${outs.map((n) => `${n}: null`).join(', ')} };`,
    '  if (dryRun) {',
    `    console.log('DRY RUN: would act on', inputs.${o.inputs[0]?.name ?? 'target'});`,
    '    return callback(null, outputs);',
    '  }',
    '  // TODO: the work. Pass an error to callback on failure.',
    `  return callback(new Error('${o.name}: write the work here, then remove this line'));`,
    '};',
    '',
  ].join('\n');
}

/** Files, IMPORT.md steps, findings and notes for the language, subscription and schedule choices. */
export function workflowExtras(values: BlueprintValues, o: { base: string; name: string; about: string; workflowId: string; inputs: readonly Param[]; outputs: readonly Param[]; attributes: readonly { key: string }[] }): {
  files: Record<string, string>;
  steps: ImportStep[];
  findings: Finding[];
  notes: string[];
  verify: string[];
  told: string[];
  trigger?: { detail: string; worstCase: string };
} {
  const files: Record<string, string> = {};
  const steps: ImportStep[] = [];
  const findings: Finding[] = [];
  const notes: string[] = [];
  const verify: string[] = [];
  const told: string[] = [];
  let trigger: { detail: string; worstCase: string } | undefined;

  const language = str(values, 'language', 'javascript');
  const rt = RUNTIMES[language];
  if (rt) {
    const envName = `${o.base}-env`;
    const deps = str(values, 'environment_deps', '').split(',').map((d) => d.trim()).filter(Boolean);
    files[`${o.base}.${language === 'node' ? 'node.js' : rt.ext}`] = polyglotScript(language, o);
    files[`${o.base}-environment.json`] = json({ name: envName, description: `Runtime for ${o.name}`, runtime: rt.runtime, dependencies: deps, memoryLimitMB: 256, timeoutSeconds: 180 });
    files['scripts/apply-environment.sh'] = underScripts(applyScript('vcf-automation', [{ method: 'POST', path: '/vco/api/environments', payload: `${o.base}-environment.json` }], `DELETE /vco/api/environments/<id> once no scriptable task uses ${envName}.`));
    steps.push(
      apiStep(`The ${rt.label} environment and task`, 'scripts/apply-environment.sh', [`\`${o.base}-environment.json\` → POST /vco/api/environments (runtime ${rt.runtime}${deps.length > 0 ? `, ${deps.join(', ')}` : ''})`], [
        `Then open the workflow ${o.name} in the Orchestrator client, set its scriptable task’s Runtime to ${rt.label} and its environment to ${envName}, and paste \`${o.base}.${language === 'node' ? 'node.js' : rt.ext}\` in place of the JavaScript. The package format carries JavaScript tasks only, so this one step is by hand; the JavaScript version keeps the same inputs, outputs and dry run, so nothing that calls the workflow changes.`,
      ]),
    );
    verify.push(`Orchestrator environments: POST /vco/api/environments with name, runtime (${rt.runtime}) and dependencies is VERIFY against the Orchestrator API reference of your release — create one in the client (Assets → Environments) and GET it to compare the runtime string.`);
  }

  if (bool(values, 'subscribe', false)) {
    const topic = str(values, 'subscription_topic', 'compute.provision.post');
    const blocking = bool(values, 'subscription_blocking', false);
    const criteria = str(values, 'subscription_criteria', '');
    const sub = workflowSubscription({ name: o.name, topic, workflowId: o.workflowId, blocking, timeoutMinutes: 10, criteria, priority: 10 });
    files[`${o.base}-subscription.json`] = json(sub);
    files['scripts/subscribe.sh'] = underScripts(applyScript('vcf-automation', [{ method: 'POST', path: '/event-broker/api/subscriptions', payload: `${o.base}-subscription.json` }], `DELETE /event-broker/api/subscriptions/${String(sub.id)} — or disable it in Extensibility → Subscriptions.`));
    steps.push(apiStep(`The subscription on ${topic}, enabled`, 'scripts/subscribe.sh', [`\`${o.base}-subscription.json\` → POST /event-broker/api/subscriptions`], [`It names the package workflow by its id (${o.workflowId}), so import the package first. It is created enabled${criteria ? `, only for events where ${criteria}` : ', for every event of the topic in the organization'}.`]));
    if (!criteria) findings.push(warning('vcfa.vro.subscription-unscoped', `The subscription runs the workflow for every ${topic} event in the organization.`, { remediation: 'Give it criteria (event.data.projectName == …) so it runs for the projects it was written for.', source: SRC }));
    if (blocking) findings.push(warning('vcfa.vro.subscription-blocking', 'A blocking subscription holds every matching deployment until the workflow ends, and a failure fails the request.', { remediation: 'Keep it non-blocking unless the deployment needs its outputs; if it must block, keep the deadline short.', source: SRC }));
    verify.push('Event subscription: runnableType extensibility.vro, the client-supplied id and the timeout in minutes follow the 8.x event broker; VERIFY with GET of a subscription made in the interface.');
    told.push(`The subscription’s runs, in Extensibility → Activity → Workflow Runs, per ${topic} event.`);
    trigger = { detail: `Every ${topic} event in VCF Automation${criteria ? ` where ${criteria}` : ''}, through the subscription`, worstCase: `once per event — every machine of a 50-machine request${blocking ? ', each held until it ends' : ''}` };
  }

  const schedule = str(values, 'schedule', 'none');
  if (RECURRENCE[schedule]) {
    const start = str(values, 'schedule_start', '');
    const tz = str(values, 'schedule_timezone', 'UTC') || 'UTC';
    if (Number.isNaN(new Date(start).getTime())) findings.push(error('vcfa.vro.bad-schedule', `First run "${start}" is not an ISO 8601 date and time.`, { source: SRC }));
    const inputNames = o.inputs.map((p) => p.name);
    const params = rowsOf(str(values, 'schedule_inputs', ''), 2).map(([n = '', v = '']) => {
      if (!inputNames.includes(n)) findings.push(error('vcfa.vro.schedule-unknown-input', `Scheduled input ${n} is not an input of the workflow.`, { source: SRC }));
      return [n, o.inputs.find((p) => p.name === n)?.type ?? 'string', v] as const;
    });
    const missing = inputNames.filter((n) => !params.some(([p]) => p === n));
    if (missing.length > 0) findings.push(warning('vcfa.vro.schedule-missing-input', `The scheduled run gives no value for ${missing.join(', ')}, and fails its required-input check.`, { source: SRC }));
    const task = scheduledTaskBody({ name: `${o.name} — ${RECURRENCE[schedule]!.label.toLowerCase()}`, description: `Scheduled run of ${o.name}.`, workflowId: o.workflowId, recurrence: schedule, start, timezone: tz, params: [...params, ['dryRun', 'boolean', 'false']] });
    files[`${o.base}-schedule.json`] = json(task);
    files['scripts/schedule.sh'] = underScripts(applyScript('vcf-automation', [{ method: 'POST', path: '/vco/api/tasks', payload: `${o.base}-schedule.json` }], 'DELETE /vco/api/tasks/<id>, or delete it under Activity → Scheduled in the Orchestrator client.'));
    steps.push(apiStep(`The schedule: ${RECURRENCE[schedule]!.label.toLowerCase()} from ${start}`, 'scripts/schedule.sh', [`\`${o.base}-schedule.json\` → POST /vco/api/tasks`], ['It runs the package workflow with dryRun false: it acts. Set dryRun in its configuration element to true to make the scheduled runs report instead.']));
    verify.push('Scheduled task body (start-mode, recurrence-cycle, recurrence-pattern "(<zone>)HH:MM:SS,", recurrence-start-date, input-parameters) follows the Orchestrator REST reference for /api/tasks; VERIFY against a task scheduled in the client (GET /vco/api/tasks/<id>).');
    told.push('Activity → Scheduled in the Orchestrator client lists each scheduled run and its result.');
    trigger ??= { detail: `A schedule, ${RECURRENCE[schedule]!.label.toLowerCase()}, from ${start} (${tz})`, worstCase: `once per ${RECURRENCE[schedule]!.label.toLowerCase().replace('every ', '')}, unattended` };
    notes.push('A scheduled run acts unattended: its dryRun input is false. The configuration element’s dryRun and cap still apply to it.');
  }
  return { files, steps, findings, notes, verify, told, ...(trigger ? { trigger } : {}) };
}
