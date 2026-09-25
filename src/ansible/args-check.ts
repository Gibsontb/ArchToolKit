/**
 * Check every task's options against the module's documentation: unknown
 * options, wrong types, values outside the documented choices, and missing
 * required options — through suboptions, with the module's aliases.
 *
 * ansible-lint's argument check runs a module's own argument_spec, which is
 * better where it works; but it does not run for modules driven through an
 * action plugin — every network CLI module (cisco.ios, arista.eos, …) among
 * them — and there it would pass a made-up option. This uses the options the
 * per-module blueprints are built from (web/data/ansible), so it covers every
 * module, runs in Node without Ansible installed, and is part of the tests.
 *
 * A value that is a Jinja expression is not checked: what it becomes is only
 * known at run time.
 */

import { readYaml, type YamlData } from '../core/yaml-read.ts';
import { moduleSchema, omittedOptions } from './module-blueprints.ts';

export interface ArgProblem {
  readonly module: string;
  /** Where in the task, dotted through suboptions. */
  readonly path: string;
  readonly message: string;
}

type TypeCode = 's' | 'n' | 'b' | 'ls' | 'ln' | 'm' | 'x' | 'h';
type OptionRow = [string, TypeCode, string, string, (string[] | null)?, (string | null)?];
interface Block {
  readonly a: readonly OptionRow[];
  readonly b?: readonly [string, 1 | 'l', number, number, Block][];
  readonly al?: Readonly<Record<string, string>>;
}

const FQCN = /^[a-z0-9_]+\.[a-z0-9_]+\.[a-z0-9_]+$/;
const JINJA = /\{\{|\{%/;

/** Modules whose keys are the caller's own names, not options. */
const FREE_FORM = new Set(['ansible.builtin.set_fact', 'ansible.builtin.set_stats']);
const BOOLEAN = /^(true|false|yes|no|on|off|y|n|1|0)$/i;

function isMap(v: unknown): v is Record<string, YamlData> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function templated(v: unknown): boolean {
  return typeof v === 'string' && JINJA.test(v);
}

function typeProblem(type: TypeCode, value: unknown): string | null {
  if (value === null || templated(value)) return null;
  switch (type) {
    case 'b':
      return typeof value === 'boolean' || (typeof value === 'string' && BOOLEAN.test(value)) || value === 0 || value === 1 ? null : 'is not a boolean';
    case 'n':
      return typeof value === 'number' || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) ? null : 'is not a number';
    case 'ls':
    case 'ln':
      // Ansible also takes a comma-separated string for a list.
      return Array.isArray(value) || typeof value === 'string' || typeof value === 'number' ? null : 'is not a list';
    case 'm':
      return isMap(value) || typeof value === 'string' ? null : 'is not a dictionary';
    case 's':
      // Not checked: an option documented with no type reads as a string, and
      // many take a list or a dictionary all the same (package: name;
      // k8s: resource_definition, "a string, list, or dict").
      return null;
    default:
      return null;
  }
}

function checkBlock(module: string, block: Block, args: Record<string, YamlData>, path: string, out: ArgProblem[]): void {
  const options = new Map(block.a.map((row) => [row[0], row]));
  const groups = new Map((block.b ?? []).map((g) => [g[0], g]));
  const given = new Set<string>();
  for (const [rawKey, value] of Object.entries(args)) {
    const key = block.al?.[rawKey] ?? rawKey;
    given.add(key);
    const at = path ? `${path}.${rawKey}` : rawKey;
    const option = options.get(key);
    const group = groups.get(key);
    if (!option && !group) {
      out.push({ module, path: at, message: `${module} has no option "${rawKey}"` });
      continue;
    }
    if (group) {
      const [, mode, , , child] = group;
      if (value === null || templated(value)) continue;
      // A list is taken where a dictionary is documented too (F5 profiles).
      const entries = Array.isArray(value) ? value : [value];
      entries.forEach((entry, i) => {
        // Some suboption lists take plain names as well as dictionaries (F5 profiles).
        if (templated(entry) || typeof entry === 'string') return;
        if (!isMap(entry)) {
          out.push({ module, path: mode === 'l' ? `${at}[${i}]` : at, message: `${at} should be a dictionary of suboptions` });
          return;
        }
        checkBlock(module, child, entry, mode === 'l' ? `${at}[${i}]` : at, out);
      });
      continue;
    }
    const [, type, , , choices] = option as OptionRow;
    const wrong = typeProblem(type, value);
    if (wrong) out.push({ module, path: at, message: `${at} ${wrong}` });
    if (choices && choices.length > 0 && !templated(value) && value !== null) {
      const values = Array.isArray(value) ? value : [value];
      for (const v of values) {
        if (templated(v)) continue;
        const text = typeof v === 'boolean' ? String(v) : String(v);
        // Choices of true/false match YAML's yes/no; numbers match as text.
        const ok = choices.some((c) => c === text || (BOOLEAN.test(c) && BOOLEAN.test(text) && /^(true|yes|on|y|1)$/i.test(c) === /^(true|yes|on|y|1)$/i.test(text)));
        if (!ok) out.push({ module, path: at, message: `${at} is "${text}", not one of ${choices.join(', ')}` });
      }
    }
  }
  for (const [name, , flags] of block.a) {
    if (flags.startsWith('r') && !given.has(name)) out.push({ module, path: path ? `${path}.${name}` : name, message: `${module} needs ${path ? `${path}.` : ''}${name}` });
  }
  for (const [name, , required] of block.b ?? []) {
    if (required && !given.has(name)) out.push({ module, path: path ? `${path}.${name}` : name, message: `${module} needs ${path ? `${path}.` : ''}${name}` });
  }
}

/** Keywords under which a play or block keeps its tasks. */
const TASK_LISTS = ['tasks', 'pre_tasks', 'post_tasks', 'handlers', 'block', 'rescue', 'always'];

function checkTasks(tasks: YamlData | undefined, out: ArgProblem[]): void {
  if (!Array.isArray(tasks)) return;
  for (const task of tasks) {
    if (!isMap(task)) continue;
    for (const list of TASK_LISTS) if (list in task) checkTasks(task[list], out);
    for (const [key, value] of Object.entries(task)) {
      if (!FQCN.test(key) || FREE_FORM.has(key)) continue;
      const documented = moduleSchema(key) as Block | undefined;
      if (!documented) continue;
      const omit = new Set(omittedOptions(key));
      const schema: Block = omit.size > 0 ? { ...documented, a: documented.a.filter((row) => !omit.has(row[0])) } : documented;
      // Free-form (command: ls) and templated arguments are not option maps.
      if (value === null) checkBlock(key, schema, {}, '', out);
      else if (isMap(value)) checkBlock(key, schema, value, '', out);
    }
  }
}

/** Every problem in a playbook's tasks; [] when there are none. */
export function checkPlaybook(text: string): ArgProblem[] {
  const out: ArgProblem[] = [];
  let documents: readonly YamlData[];
  try {
    documents = readYaml(text).documents;
  } catch {
    return out;
  }
  for (const doc of documents) {
    if (!Array.isArray(doc)) continue;
    for (const play of doc) if (isMap(play)) for (const list of TASK_LISTS) checkTasks(play[list], out);
  }
  return out;
}
