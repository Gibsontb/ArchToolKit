/**
 * An Orchestrator emulator, for tests only.
 *
 * It loads the text files of one or more packages — the layout readPackageSpec
 * reads, i.e. exactly what a blueprint emits under import/<name>.package/ —
 * and runs a workflow's scriptable tasks and the actions they call the way
 * Orchestrator does: every script in one shared JavaScript context, inputs as
 * variables, outputs read back by name, System.getModule(module).action(...)
 * calling the action's script as a function of its declared params.
 *
 * Scripting objects provided (the subset the ArchToolKit packages use):
 *
 *   System          log, warn, error, debug, getModule, sleep (no wait)
 *   Server          getConfigurationElementCategoryWithPath → allConfigurationElements
 *                   (name, attributes[{name, type, value}], getAttributeWithKey),
 *                   getResourceElementCategoryWithPath → allResourceElements
 *                   (name, mimeType, getContentAsMimeAttachment().content)
 *   RESTHostManager createHost, createTransientHostFrom → createRequest(method, path,
 *                   content) → setHeader, contentType, execute() → statusCode,
 *                   contentAsString, getAllHeaders()
 *   Properties      get, put, keys, remove
 *
 * execute() is a real, synchronous HTTP call (curl), so a test points the
 * package at a fake server in another process (fake-rest-server.ts). https://
 * becomes http:// unless options.rewriteUrl says otherwise.
 *
 * Every script is checked for syntax beyond ES5 when it is loaded, and loading
 * fails if it has any: let, const, arrow functions, template literals, class,
 * spread, for…of, async/await. Strings, comments and regular expressions are
 * stripped first, so text inside them does not count.
 *
 * Limits — what this does not reproduce: Rhino itself (Node runs the code, so
 * only the syntax check stands between a script and an engine difference, and
 * Java-backed objects such as java.lang.String are plain JavaScript here);
 * workflow graphs beyond a chain of scriptable tasks (no decisions, loops,
 * nested workflows, waits or error handlers); attribute binding beyond inputs
 * and outputs of the same name; certificate trust (every call is plain HTTP);
 * the scripting API beyond the list above; and input types other than what
 * JSON can carry.
 */

import { createContext, runInContext, Script } from 'node:vm';
import { execFileSync } from 'node:child_process';
import { readPackageSpec, type VroConfigAttribute, type VroPackageSpec } from '../kit/vro-package.ts';

export interface VroLogLine {
  readonly level: 'log' | 'warn' | 'error' | 'debug';
  readonly message: string;
}

export interface VroHttpCall {
  readonly method: string;
  /** As the script asked for it, before any rewrite. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
  readonly status: number;
}

export interface EmulatorOptions {
  /** Attribute values by "<categoryPath>/<element name>", then attribute name. SecureString included. */
  readonly config?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** The URL actually called; default https:// → http://. */
  readonly rewriteUrl?: (url: string) => string;
}

export interface WorkflowRun {
  readonly outputs: Record<string, unknown>;
  /** The error the workflow failed with, as Orchestrator would show it; null when it completed. */
  readonly error: string | null;
  readonly logs: readonly VroLogLine[];
  readonly calls: readonly VroHttpCall[];
}

// ---------------------------------------------------------------------------
// ES5 check

/** Code with strings, comments, regular expressions and template literals blanked out. */
function codeOnly(source: string): string {
  let out = '';
  let last = '';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i = source.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
      out += ' ';
      continue;
    }
    if (ch === '"' || ch === "'") {
      i++;
      while (i < source.length && source[i] !== ch) i += source[i] === '\\' ? 2 : 1;
      out += '""';
      last = '"';
      continue;
    }
    if (ch === '`') {
      out += '`';
      i++;
      while (i < source.length && source[i] !== '`') i += source[i] === '\\' ? 2 : 1;
      out += '`';
      last = '`';
      continue;
    }
    const regexAllowed = last === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(last) || /\b(return|typeof|case|in|of)$/.test(out.trimEnd());
    if (ch === '/' && regexAllowed) {
      i++;
      let inClass = false;
      while (i < source.length && (source[i] !== '/' || inClass)) {
        if (source[i] === '\\') i++;
        else if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        i++;
      }
      while (/[a-z]/i.test(source[i + 1] ?? '')) i++;
      out += '/r/';
      last = '/';
      continue;
    }
    out += ch;
    if (!/\s/.test(ch)) last = ch;
  }
  return out;
}

const BEYOND_ES5: readonly [RegExp, string][] = [
  [/\blet\s+[A-Za-z_$[{]/, 'let'],
  [/\bconst\s+[A-Za-z_$[{]/, 'const'],
  [/=>/, 'arrow function'],
  [/`/, 'template literal'],
  [/\bclass\s+[A-Za-z_$]/, 'class'],
  [/\.\.\./, 'spread or rest'],
  [/\bfor\s*\(\s*(var\s+)?[A-Za-z_$][\w$]*\s+of\b/, 'for…of'],
  [/\basync\s+function\b|\bawait\s/, 'async/await'],
];

/** What in a script is not ES5, if anything. Also reports a script Node cannot parse at all. */
export function es5Problems(script: string, where = 'script'): string[] {
  const code = codeOnly(script);
  const problems = BEYOND_ES5.filter(([pattern]) => pattern.test(code)).map(([, what]) => `${where}: ${what} is not ES5`);
  try {
    new Script(`(function () {\n${script}\n})`, { filename: where });
  } catch (error) {
    problems.push(`${where}: does not parse: ${(error as Error).message}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Loading

/** Group files by the *.package/ folder they are under: { "com.x.package": { "package.json": … } }. */
export function packagesIn(files: Readonly<Record<string, string>>): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [path, body] of Object.entries(files)) {
    const m = /^(?:.*\/)?([^/]+\.package)\/(.+)$/.exec(path);
    if (!m) continue;
    (out[m[1]!] ??= {})[m[2]!] = body;
  }
  return out;
}

function cdataText(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}[^>]*>((?:<!\\[CDATA\\[[\\s\\S]*?\\]\\]>)+)</${tag}>`).exec(xml);
  return m ? [...m[1]!.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((c) => c[1]).join('') : '';
}

interface ParsedWorkflow {
  readonly name: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly tasks: readonly { readonly name: string; readonly script: string }[];
}

function parseWorkflow(xml: string, name: string): ParsedWorkflow {
  const params = (section: string) => {
    const m = new RegExp(`<${section}>([\\s\\S]*?)</${section}>`).exec(xml);
    return m ? [...m[1]!.matchAll(/<param name="([^"]+)"/g)].map((p) => p[1]!) : [];
  };
  const items = new Map<string, { type: string; out: string | null; body: string }>();
  for (const m of xml.matchAll(/<workflow-item\b([^>]*)>([\s\S]*?)<\/workflow-item>/g)) {
    const attr = (key: string) => new RegExp(`\\s${key}="([^"]*)"`).exec(m[1]!)?.[1] ?? null;
    items.set(attr('name')!, { type: attr('type') ?? '', out: attr('out-name'), body: m[2]! });
  }
  const tasks: { name: string; script: string }[] = [];
  let at = /\sroot-name="([^"]+)"/.exec(xml)?.[1] ?? null;
  const seen = new Set<string>();
  while (at && !seen.has(at)) {
    seen.add(at);
    const item = items.get(at);
    if (!item) throw new Error(`${name}: workflow item ${at} is missing`);
    if (item.type === 'end') break;
    if (item.type !== 'task') throw new Error(`${name}: the emulator runs scriptable tasks only, not "${item.type}"`);
    tasks.push({ name: cdataText(item.body, 'display-name') || at, script: cdataText(item.body, 'script') });
    at = item.out;
  }
  return { name, inputs: params('input'), outputs: params('output'), tasks };
}

// ---------------------------------------------------------------------------
// The emulator

export class VroEmulator {
  readonly logs: VroLogLine[] = [];
  readonly calls: VroHttpCall[] = [];
  private readonly packages: VroPackageSpec[];
  private readonly context: object;
  private readonly modules = new Map<string, Record<string, unknown>>();
  private readonly options: EmulatorOptions;

  constructor(files: Readonly<Record<string, string>>, options: EmulatorOptions = {}) {
    this.options = options;
    this.packages = Object.values(packagesIn(files)).map((pkg) => readPackageSpec(pkg));
    if (this.packages.length === 0) throw new Error('No *.package/ folder in the files given');
    const problems: string[] = [];
    for (const pkg of this.packages) {
      for (const a of pkg.actions) problems.push(...es5Problems(a.script, `${a.module}/${a.name}`));
      for (const w of pkg.workflows) for (const t of parseWorkflow(w.xml, w.name).tasks) problems.push(...es5Problems(t.script, `${w.name}/${t.name}`));
    }
    if (problems.length > 0) throw new Error(`Not Orchestrator JavaScript:\n${problems.join('\n')}`);
    this.context = createContext(this.globals());
  }

  /** A value made inside the scripts' context, so Array.isArray and instanceof hold there. */
  private inside(value: unknown): unknown {
    return value === undefined ? undefined : runInContext(`(${JSON.stringify(value)})`, this.context);
  }

  private configValue(attribute: VroConfigAttribute, override: unknown, has: boolean): unknown {
    if (has) return this.inside(override);
    if (attribute.type === 'SecureString') return '';
    if (attribute.value === undefined || attribute.value === '' || (Array.isArray(attribute.value) && attribute.value.length === 0)) return null;
    if (attribute.type === 'number') return Number(attribute.value);
    if (attribute.type === 'boolean') return attribute.value === true || attribute.value === 'true';
    return this.inside(attribute.value);
  }

  private globals(): Record<string, unknown> {
    const self = this;
    const log = (level: VroLogLine['level']) => (message: unknown) => {
      self.logs.push({ level, message: String(message) });
    };
    const System = {
      log: log('log'),
      warn: log('warn'),
      error: log('error'),
      debug: log('debug'),
      sleep: () => undefined,
      getModule: (module: string) => self.module(String(module)),
    };
    const Server = {
      getConfigurationElementCategoryWithPath(path: string) {
        const configs = self.packages.flatMap((pkg) => pkg.configs).filter((c) => c.categoryPath === String(path));
        if (configs.length === 0) return null;
        return {
          name: String(path).split('/').pop(),
          path: String(path),
          allConfigurationElements: configs.map((c) => {
            const overrides = self.options.config?.[`${c.categoryPath}/${c.name}`] ?? {};
            const attributes = c.attributes.map((a) => ({ name: a.name, type: a.type, value: self.configValue(a, overrides[a.name], a.name in overrides) }));
            return { name: c.name, id: c.id, attributes, getAttributeWithKey: (key: string) => attributes.find((a) => a.name === String(key)) ?? null };
          }),
        };
      },
      getResourceElementCategoryWithPath(path: string) {
        const resources = self.packages.flatMap((pkg) => pkg.resources).filter((r) => r.categoryPath === String(path));
        if (resources.length === 0) return null;
        return {
          name: String(path).split('/').pop(),
          allResourceElements: resources.map((r) => ({ name: r.name, id: r.id, mimeType: r.mimeType, getContentAsMimeAttachment: () => ({ name: r.name, mimeType: r.mimeType, content: r.content }) })),
        };
      },
    };
    const RESTHostManager = {
      createHost: (name: string) => ({ name: String(name), url: '', connectionTimeout: 60, operationTimeout: 60 }),
      createTransientHostFrom: (host: { url: string }) => ({
        url: host.url,
        createRequest(method: string, path: string, content: string | null) {
          const headers: Record<string, string> = {};
          const base = String(this.url).replace(/\/+$/, '');
          const request = {
            contentType: '',
            setHeader: (key: string, value: string) => {
              headers[String(key)] = String(value);
            },
            execute: () => self.execute(String(method), `${base}${String(path)}`, headers, request.contentType, content === null || content === undefined ? null : String(content)),
          };
          return request;
        },
      }),
    };
    class Properties {
      private readonly map: Record<string, unknown> = {};
      get(key: string): unknown {
        return this.map[key] ?? null;
      }
      put(key: string, value: unknown): void {
        this.map[key] = value;
      }
      remove(key: string): void {
        delete this.map[key];
      }
      keys(): string[] {
        return Object.keys(this.map);
      }
    }
    return { System, Server, RESTHostManager, Properties };
  }

  private execute(method: string, url: string, headers: Record<string, string>, contentType: string, body: string | null) {
    const target = this.options.rewriteUrl ? this.options.rewriteUrl(url) : url.replace(/^https:\/\//, 'http://');
    const args = ['-sS', '--noproxy', '*', '-X', method, target, '-o', '-', '-w', '\n%{http_code}'];
    const all = { ...(body !== null && contentType ? { 'Content-Type': contentType } : {}), ...headers };
    for (const [key, value] of Object.entries(all)) args.push('-H', `${key}: ${value}`);
    if (body !== null) args.push('--data-binary', '@-');
    let raw: string;
    try {
      raw = execFileSync('curl', args, { input: body ?? '', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (error) {
      // Orchestrator throws from execute() when the connection fails.
      throw new Error(`Connection to ${url.split('?')[0]} failed: ${(error as Error).message.split('\n')[0]}`);
    }
    const cut = raw.lastIndexOf('\n');
    const status = Number(raw.slice(cut + 1));
    const text = raw.slice(0, cut);
    this.calls.push({ method, url, headers: { ...all }, body, status });
    return { statusCode: status, contentAsString: text, getAllHeaders: () => ({}) };
  }

  /** System.getModule(name): the module's actions as functions of their params. */
  module(name: string): Record<string, unknown> {
    const cached = this.modules.get(name);
    if (cached) return cached;
    const actions = this.packages.flatMap((pkg) => pkg.actions).filter((a) => a.module === name);
    // As in Orchestrator, an unknown module is not an error until an action of it is called.
    const module: Record<string, unknown> = {};
    for (const a of actions) {
      module[a.name] = runInContext(`(function ${a.name}(${a.params.map((p) => p.name).join(', ')}) {\n${a.script}\n})`, this.context, { filename: `${name}/${a.name}.js` });
    }
    this.modules.set(name, module);
    return module;
  }

  /** Run a workflow by name, as Orchestrator would: inputs in, outputs out, a thrown error fails it. */
  runWorkflow(name: string, inputs: Readonly<Record<string, unknown>> = {}): WorkflowRun {
    const found = this.packages.flatMap((pkg) => pkg.workflows).find((w) => w.name === name);
    if (!found) throw new Error(`No workflow named ${name}`);
    const workflow = parseWorkflow(found.xml, name);
    const logsBefore = this.logs.length;
    const callsBefore = this.calls.length;
    const scope = this.context as Record<string, unknown>;
    for (const input of workflow.inputs) scope[input] = input in inputs ? this.inside(inputs[input]) : null;
    for (const output of workflow.outputs) scope[output] = null;
    scope.workflow = { name, rootWorkflow: { name } };
    let error: string | null = null;
    try {
      for (const task of workflow.tasks) runInContext(task.script, this.context, { filename: `${name}/${task.name}` });
    } catch (e) {
      error = typeof e === 'object' && e !== null && 'message' in e ? String((e as { message: unknown }).message) : String(e);
      this.logs.push({ level: 'error', message: `Workflow failed: ${error}` });
    }
    const outputs: Record<string, unknown> = {};
    for (const output of workflow.outputs) {
      const value = scope[output];
      outputs[output] = value === undefined ? null : JSON.parse(JSON.stringify(value) ?? 'null');
    }
    return { outputs, error, logs: this.logs.slice(logsBefore), calls: this.calls.slice(callsBefore) };
  }
}
