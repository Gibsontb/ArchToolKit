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

import { readYaml,               } from '../core/yaml-read.js';
import { moduleSchema, omittedOptions } from './module-blueprints.js';

                             
                          
                                                      
                        
                           
 

/**
 * One problem in one task's options, with what an editor needs besides the
 * message: its kind, the path as parts, and for an unknown option the names
 * the module does take (for "did you mean").
 */
                                                    
                                                                      
                                                                      
                                            
                                                                               
                                     
 

                                                                
                                                                                          
                 
                                   
                                                                   
                                                 
 

const FQCN = /^[a-z0-9_]+\.[a-z0-9_]+\.[a-z0-9_]+$/;
const JINJA = /\{\{|\{%/;

/** Modules whose keys are the caller's own names, not options. */
const FREE_FORM = new Set(['ansible.builtin.set_fact', 'ansible.builtin.set_stats']);
const BOOLEAN = /^(true|false|yes|no|on|off|y|n|1|0)$/i;

function isMap(v         )                                {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function templated(v         )          {
  return typeof v === 'string' && JINJA.test(v);
}

function typeProblem(type          , value         )                {
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

function checkBlock(module        , block       , args                          , path        , out                  , parts                               = [])       {
  const options = new Map(block.a.map((row) => [row[0], row]));
  const groups = new Map((block.b ?? []).map((g) => [g[0], g]));
  const given = new Set        ();
  for (const [rawKey, value] of Object.entries(args)) {
    const key = block.al?.[rawKey] ?? rawKey;
    given.add(key);
    const at = path ? `${path}.${rawKey}` : rawKey;
    const atParts = [...parts, rawKey];
    const option = options.get(key);
    const group = groups.get(key);
    if (!option && !group) {
      const known = [...options.keys(), ...groups.keys(), ...Object.keys(block.al ?? {})];
      out.push({ module, path: at, message: `${module} has no option "${rawKey}"`, kind: 'unknown', at: atParts, known });
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
          const inList = mode === 'l' && Array.isArray(value);
          out.push({ module, path: mode === 'l' ? `${at}[${i}]` : at, message: `${at} should be a dictionary of suboptions`, kind: 'shape', at: inList ? [...atParts, i] : atParts });
          return;
        }
        checkBlock(module, child, entry, mode === 'l' ? `${at}[${i}]` : at, out, Array.isArray(value) ? [...atParts, i] : atParts);
      });
      continue;
    }
    const [, type, , , choices] = option             ;
    const wrong = typeProblem(type, value);
    if (wrong) out.push({ module, path: at, message: `${at} ${wrong}`, kind: 'type', at: atParts });
    if (choices && choices.length > 0 && !templated(value) && value !== null) {
      const values = Array.isArray(value) ? value : [value];
      values.forEach((v, i) => {
        if (templated(v)) return;
        const text = typeof v === 'boolean' ? String(v) : String(v);
        // Choices of true/false match YAML's yes/no; numbers match as text.
        const ok = choices.some((c) => c === text || (BOOLEAN.test(c) && BOOLEAN.test(text) && /^(true|yes|on|y|1)$/i.test(c) === /^(true|yes|on|y|1)$/i.test(text)));
        if (!ok) out.push({ module, path: at, message: `${at} is "${text}", not one of ${choices.join(', ')}`, kind: 'choice', at: Array.isArray(value) ? [...atParts, i] : atParts });
      });
    }
  }
  const need = (name        ) =>
    out.push({ module, path: path ? `${path}.${name}` : name, message: `${module} needs ${path ? `${path}.` : ''}${name}`, kind: 'required', at: [...parts, name] });
  for (const [name, , flags] of block.a) if (flags.startsWith('r') && !given.has(name)) need(name);
  for (const [name, , required] of block.b ?? []) if (required && !given.has(name)) need(name);
}

/** Keywords under which a play or block keeps its tasks. */
const TASK_LISTS = ['tasks', 'pre_tasks', 'post_tasks', 'handlers', 'block', 'rescue', 'always'];

/** The module's documented options, less any it documents but rejects; undefined when it is not documented. */
function schemaOf(module        )                    {
  if (!FQCN.test(module) || FREE_FORM.has(module)) return undefined;
  const documented = moduleSchema(module)                     ;
  if (!documented) return undefined;
  const omit = new Set(omittedOptions(module));
  return omit.size > 0 ? { ...documented, a: documented.a.filter((row) => !omit.has(row[0])) } : documented;
}

/**
 * The problems in one task's call of `module` (a fully-qualified name) with
 * `args`, the value under the module's key: a dictionary of options, or null
 * for none. Free-form arguments (`command: ls`), templated ones and modules
 * the toolkit has no documentation for give [].
 */
export function checkTaskArgs(module        , args                      )                   {
  const schema = schemaOf(module);
  if (!schema) return [];
  const out                   = [];
  // Free-form (command: ls) and templated arguments are not option maps.
  if (args === null || args === undefined) checkBlock(module, schema, {}, '', out);
  else if (isMap(args)) checkBlock(module, schema, args, '', out);
  return out;
}

/**
 * The documented choices of the option at `path` (keys and list indices from
 * the module's arguments, through suboptions and aliases); undefined when it
 * has none. A boolean's true/false is not given: it has its own control.
 */
export function optionChoices(module        , path                              )                                {
  let block = schemaOf(module);
  const keys = path.filter((p)              => typeof p === 'string');
  for (let i = 0; block && i < keys.length; i += 1) {
    const key = block.al?.[keys[i]          ] ?? (keys[i]          );
    if (i === keys.length - 1) {
      const row = block.a.find((r) => r[0] === key);
      if (!row || row[1] === 'b' || !row[4] || row[4].length === 0) return undefined;
      // A trailing index is an entry of a list option; the option itself needs no index.
      if (typeof path[path.length - 1] === 'number' && row[1] !== 'ls' && row[1] !== 'ln') return undefined;
      return row[4];
    }
    block = block.b?.find((g) => g[0] === key)?.[4];
  }
  return undefined;
}

function checkTasks(tasks                      , out              )       {
  if (!Array.isArray(tasks)) return;
  for (const task of tasks) {
    if (!isMap(task)) continue;
    for (const list of TASK_LISTS) if (list in task) checkTasks(task[list], out);
    for (const [key, value] of Object.entries(task)) {
      for (const p of checkTaskArgs(key, value)) out.push({ module: p.module, path: p.path, message: p.message });
    }
  }
}

/** Every problem in a playbook's tasks; [] when there are none. */
export function checkPlaybook(text        )               {
  const out               = [];
  let documents                     ;
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
