/**
 * The shape of a role the migration blueprints write.
 *
 * A role here is data: typed task lists, handlers, defaults and the templates
 * it renders. It is the same for every host and every build — what differs per
 * blueprint, host or group arrives through variables — so the files a role
 * writes are identical wherever it is used, and a site that applies the same
 * role from two items writes it once.
 *
 * Variables follow one rule, so that inventory can override a blueprint:
 *
 *   - the role reads a public name (`oracle_sid`);
 *   - its defaults/main.yml sets that name from `mig_<name>` when the play
 *     supplies it, else from the role's own fallback;
 *   - the blueprint's play sets `mig_<name>` from its inputs.
 *
 * Play vars outrank group_vars and host_vars, role defaults rank below both,
 * so a `host_vars/<db>.yml` that says `oracle_sid: PROD1` wins over the
 * blueprint's answer, and the blueprint's answer wins over the fallback.
 */

import { renderYaml, type YamlValue } from '../../yaml.ts';

/** One task: a name, one module key, and task keywords. */
export type Task = { readonly name: string } & { readonly [key: string]: YamlValue | undefined };

export interface Role {
  /** The role directory name, `roles/<name>/`. */
  readonly name: string;
  /** One line, written as the header of tasks/main.yml. */
  readonly description: string;
  readonly tasks: readonly Task[];
  readonly handlers?: readonly Task[];
  /** Public variable → fallback. Written as `name: "{{ mig_name | default(fallback) }}"`. */
  readonly defaults?: Readonly<Record<string, YamlValue>>;
  /** Plain defaults, written as they are (derived values, maps). */
  readonly derived?: Readonly<Record<string, YamlValue>>;
  /** templates/<file> → Jinja source. */
  readonly templates?: Readonly<Record<string, string>>;
  /** files/<file> → contents. */
  readonly files?: Readonly<Record<string, string>>;
}

/** A Jinja literal for a fallback value. JSON is valid Jinja for all of these. */
function literal(value: YamlValue): string {
  if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  return JSON.stringify(value);
}

/** `x: "{{ mig_x | default(<fallback>) }}"` for each default. */
export function roleDefaults(defaults: Readonly<Record<string, YamlValue>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, fallback] of Object.entries(defaults)) out[name] = `{{ mig_${name} | default(${literal(fallback)}) }}`;
  return out;
}

/**
 * The hyperscaler (or vmware) a host runs on: its `platform_<p>` inventory
 * group, else the blueprint's answer. Every role that differs by platform
 * reads `cloud_platform`.
 */
export const CLOUD_PLATFORM =
  "{{ (group_names | select('match', '^platform_') | first | default('platform_' ~ (mig_cloud_platform | default('vmware')))) | regex_replace('^platform_', '') }}";

/** The files of a role, under roles/<name>/. */
export function roleFiles(role: Role): Record<string, string> {
  const base = `roles/${role.name}`;
  const files: Record<string, string> = {
    [`${base}/tasks/main.yml`]: renderYaml(role.tasks as unknown as YamlValue, { header: `${role.name}: ${role.description}` }),
  };
  if (role.handlers && role.handlers.length > 0) {
    files[`${base}/handlers/main.yml`] = renderYaml(role.handlers as unknown as YamlValue, { header: `${role.name}: handlers` });
  }
  const defaults = { ...(role.defaults ? roleDefaults(role.defaults) : {}), ...(role.derived ?? {}) };
  if (Object.keys(defaults).length > 0) {
    files[`${base}/defaults/main.yml`] = renderYaml(defaults as YamlValue, {
      header: `${role.name}: defaults.\n\nEach one is the blueprint's answer (mig_<name>) or the fallback here.\nSet the plain name in group_vars or host_vars to override both.`,
    });
  }
  for (const [file, text] of Object.entries(role.templates ?? {})) files[`${base}/templates/${file}`] = text;
  for (const [file, text] of Object.entries(role.files ?? {})) files[`${base}/files/${file}`] = text;
  return files;
}

/** Every task in a list, through blocks, rescues and always. */
export function flatTasks(tasks: readonly Task[] | readonly YamlValue[]): Record<string, YamlValue | undefined>[] {
  const out: Record<string, YamlValue | undefined>[] = [];
  const walk = (list: readonly unknown[]): void => {
    for (const t of list) {
      if (t === null || typeof t !== 'object' || Array.isArray(t)) continue;
      const task = t as Record<string, YamlValue | undefined>;
      out.push(task);
      for (const key of ['block', 'rescue', 'always']) {
        const inner = task[key];
        if (Array.isArray(inner)) walk(inner);
      }
    }
  };
  walk(tasks as readonly unknown[]);
  return out;
}

/**
 * For a task that needs a package an earlier task installs: in --check (the
 * first run every generated README suggests) the package is not really there,
 * so the task could only fail. It is reported and passed over in check mode,
 * and fails as usual in a real run.
 */
export const CHECK_MODE_TOLERANT = { ignore_errors: '{{ ansible_check_mode }}' } as const;
