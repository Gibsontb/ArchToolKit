/**
 * A site playbook: several generated playbooks run as one.
 *
 * The Terraform side of the kit assembles blueprints into a root module; this
 * is the same idea for Ansible, and Ansible's own name for it is `site.yml` —
 * the playbook at the top of a repository that imports the rest in order:
 *
 *   site.yml           imports each item, in list order
 *   NN-<name>.yml      one playbook per item
 *   group_vars/all.yml the answers more than one item gave the same way
 *   requirements.yml   every collection (and role) the items use, merged and pinned
 *   inventory/hosts.yml  a starting inventory, with the hosts the plays name
 *   README.md          what it does and how to run it
 *
 * What an item writes beside its playbook is kept too: its roles/, templates/
 * and files/ (the same file from two items is written once; two different
 * ones keep the first, with a warning), its group_vars/<group>.yml merged key
 * by key, and its host_vars/.
 *
 * With `playbookDir` the playbooks go in that folder and site.yml imports
 * them from there. Ansible reads group_vars/ and host_vars/ beside the
 * inventory or beside the playbook that is running, not beside site.yml, so
 * in that layout they are written under inventory/, and templates/ and files/
 * beside the playbooks; roles/ stays at the top, found through roles_path.
 *
 * Two plays cannot pass values to each other the way two Terraform resources
 * can — a registered variable belongs to the play that registered it. What
 * does carry across every play is `group_vars/all.yml`, so that is what the
 * page's picker offers, and what an answer repeated by two items is hoisted
 * into. A field set to `{{ vcenter_hostname }}` in three playbooks is then
 * changed in one place.
 */

import { ansibleCfg, API_COLLECTIONS, inventoryYaml, requiredCollections, WINDOWS_COLLECTIONS } from './project.ts';
import { info, warning, type Finding } from '../core/findings.ts';
import { defaultValues } from '../kit/blueprint.ts';
import { numbered, slug, type BlueprintLookup, type StackBuild, type StackItem, type StackReference } from '../kit/stack.ts';
import type { BlueprintValues } from '../kit/blueprint.ts';
import { readYaml, type YamlData } from '../core/yaml-read.ts';
import { renderYaml, type YamlValue } from './yaml.ts';

/** Controls whose value can be swapped for a `{{ variable }}` without breaking it. */
const FREE_TEXT = new Set(['text', 'textarea', 'combo']);

const JINJA = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/;

/** A variable named after a secret does not belong in a file beside the playbooks. */
const SECRET_NAME = /pass(word|wd)?|secret|token|api_?key|private_?key|credential/i;

/**
 * Names that mean something else to Ansible, or read as one of a play's own
 * keywords. A shared answer called `hosts` would be read as the play's hosts.
 */
const RESERVED = new Set(['hosts', 'name', 'vars', 'tasks', 'roles', 'state', 'become', 'connection', 'environment', 'port', 'tags', 'when', 'group', 'groups', 'inventory_hostname']);

function variableName(inputId: string): string {
  return RESERVED.has(inputId) ? `site_${inputId}` : inputId;
}

export interface SiteOptions {
  readonly stackName?: string;
  /**
   * Write the playbooks under this folder (e.g. `playbooks`): site.yml imports
   * `<dir>/NN-*.yml`, group_vars/ and host_vars/ go under inventory/, and
   * templates/ and files/ beside the playbooks.
   */
  readonly playbookDir?: string;
  /** NN in NN-<name>.yml for each item; the default is its position, from 01. */
  readonly playbookNumber?: (item: StackItem, index: number) => number;
  /**
   * 'skeleton': inventory/hosts.yml lists the groups the plays name and no
   * hosts, for a caller that writes the inventories (dynamic plugin configs,
   * hosts from terraform output) itself. Default 'starting'.
   */
  readonly inventory?: 'starting' | 'skeleton';
}

/**
 * YAML says a value starting with `{` opens a flow mapping, so `name: {{ x }}`
 * is a parse error. The templates were written for literal answers; quote the
 * ones that now hold a variable.
 */
export function quoteJinjaScalars(yaml: string): string {
  return yaml.replace(/^(\s*(?:- )?[A-Za-z0-9_.-]+:\s+)(\{\{[^\n]*\}\})\s*$/gm, (_all, head: string, value: string) => `${head}"${value}"`);
}

interface Requirements {
  readonly collections: Map<string, string>;
  readonly roles: Map<string, Readonly<Record<string, string>>>;
}

function isMap(v: unknown): v is Record<string, YamlData> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** The collections (with their version) and roles a generated requirements.yml lists. */
function readRequirements(text: string): Requirements {
  const out: Requirements = { collections: new Map(), roles: new Map() };
  let doc: YamlData | undefined;
  try {
    doc = readYaml(text).documents[0];
  } catch {
    doc = undefined;
  }
  // A requirements file that is only a list is a list of collections.
  const map: Record<string, YamlData> = isMap(doc) ? doc : Array.isArray(doc) ? { collections: doc } : {};
  for (const entry of Array.isArray(map.collections) ? map.collections : []) {
    if (typeof entry === 'string') out.collections.set(entry, '');
    else if (isMap(entry) && typeof entry.name === 'string') out.collections.set(entry.name, entry.version === undefined || entry.version === null ? '' : String(entry.version));
  }
  for (const entry of Array.isArray(map.roles) ? map.roles : []) {
    if (!isMap(entry)) continue;
    const name = String(entry.name ?? entry.src ?? '');
    if (!name) continue;
    out.roles.set(name, Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== null && typeof v !== 'object').map(([k, v]) => [k, String(v)])));
  }
  return out;
}

/** Host patterns the plays run against, for the starting inventory. */
function hostsIn(playbook: string): string[] {
  return [...playbook.matchAll(/^\s*-?\s*hosts:\s*(.+)$/gm)]
    .map((m) => (m[1] as string).trim().replace(/^["']|["']$/g, ''))
    .filter((h) => h !== '' && !h.includes('{{'));
}

/** The top-level keys a group_vars file sets, in order; undefined when it does not read as a mapping. */
function readVars(text: string): Map<string, YamlData> | undefined {
  try {
    const doc = readYaml(text).documents[0];
    if (doc === null || doc === undefined) return new Map();
    return isMap(doc) ? new Map(Object.entries(doc)) : undefined;
  } catch {
    return undefined;
  }
}

/** Where an item's extra file goes in the site, or null when the site does not keep it. */
function placeOf(path: string, playbookDir: string): { kind: 'roles' | 'beside' | 'host_vars' | 'group_vars' | 'all'; to: string } | null {
  const varsBase = playbookDir ? 'inventory/' : '';
  const besideBase = playbookDir ? `${playbookDir}/` : '';
  if (path.startsWith('roles/')) return { kind: 'roles', to: path };
  if (path.startsWith('templates/') || path.startsWith('files/')) return { kind: 'beside', to: `${besideBase}${path}` };
  if (path.startsWith('host_vars/')) return { kind: 'host_vars', to: `${varsBase}${path}` };
  if (path === 'group_vars/all.yml') return { kind: 'all', to: `${varsBase}${path}` };
  if (/^group_vars\/[^/]+\.ya?ml$/.test(path)) return { kind: 'group_vars', to: `${varsBase}${path}` };
  return null;
}

/**
 * Assemble the items into one site playbook.
 *
 * An answer given identically by more than one item, in a field that can hold
 * a variable, moves to `group_vars/all.yml` and the items reference it. An
 * answer someone has already written as `{{ something }}` is declared there
 * too, empty if nothing supplies it, so `ansible-playbook` fails with a clear
 * "undefined variable" rather than a silent empty string.
 */
export function buildSite(items: readonly StackItem[], blueprintFor: BlueprintLookup, options: SiteOptions = {}): StackBuild {
  const findings: Finding[] = [];
  const files: Record<string, string> = {};
  const references: StackReference[] = [];
  const playbookDir = (options.playbookDir ?? '').trim().replace(/^\.?\/+|\/+$/g, '');
  const varsBase = playbookDir ? 'inventory/' : '';

  if (items.length === 0) {
    return { files: {}, findings: [info('ansible.site.empty', 'Nothing in the build list yet.', {})], references: [] };
  }

  // What each item answers, and which of those answers can become a variable.
  const shared = new Map<string, { value: string; items: string[] }>();
  const asked = new Map<string, string[]>();

  for (const item of items) {
    const blueprint = blueprintFor(item.blueprintId);
    if (!blueprint) continue;
    for (const input of blueprint.inputs) {
      if (!FREE_TEXT.has(input.control)) continue;
      const value = String(item.values[input.id] ?? '').trim();
      if (value === '') continue;
      const named = JINJA.exec(value);
      if (named) {
        const list = asked.get(named[1] as string) ?? [];
        list.push(item.label);
        asked.set(named[1] as string, list);
        continue;
      }
      if (value.length < 3) continue;
      if (SECRET_NAME.test(input.id)) continue;
      // A play's hosts are resolved before any inventory variable exists, so
      // `hosts: "{{ site_hosts }}"` would be undefined: the pattern stays literal.
      if (input.id === 'hosts') continue;
      const seen = shared.get(input.id);
      if (!seen) shared.set(input.id, { value, items: [item.label] });
      else if (seen.value === value) seen.items.push(item.label);
    }
  }

  // Which input becomes which shared variable.
  const hoisted = new Map<string, { name: string; value: string }>();
  for (const [id, seen] of shared) {
    if (seen.items.length < 2) continue;
    const name = variableName(id);
    hoisted.set(id, { name, value: seen.value });
    findings.push(
      info('ansible.site.hoisted', `${seen.items.join(' and ')} all answer ${id} with ${seen.value}; it is now ${name} in group_vars/all.yml, and they reference it.`, {
        path: `${varsBase}group_vars/all.yml`,
      }),
    );
  }

  const variables = new Map<string, string>([...hoisted.values()].map((h) => [h.name, h.value]));
  for (const [name, users] of asked) {
    if (variables.has(name)) continue;
    if (SECRET_NAME.test(name)) {
      // A secret is supplied at run time, never written into the site.
      findings.push(
        warning('ansible.site.secret-variable', `${users.join(' and ')} use {{ ${name} }}. It is deliberately not in group_vars/all.yml: supply it at run time.`, {
          remediation: `Keep it in an ansible-vault file, or pass it with -e "${name}=…".`,
        }),
      );
      continue;
    }
    variables.set(name, '');
    findings.push(
      warning('ansible.site.undefined-variable', `${users.join(' and ')} use {{ ${name} }}, which nothing sets. group_vars/all.yml now declares it, with no value.`, {
        path: `${varsBase}group_vars/all.yml`,
        remediation: 'Give it a value there, or pass it with -e on the command line.',
      }),
    );
  }

  const names = new Set<string>();
  const imports: string[] = [];
  const playbooks: { file: string; label: string }[] = [];
  const collections = new Map<string, { version: string; from: string }>();
  const roleRequirements = new Map<string, Readonly<Record<string, string>>>();
  const hosts = new Set<string>();
  /** Host patterns of the plays that call an API, and of the ones that manage hosts. */
  const apiHosts = new Set<string>();
  const hostPlayHosts = new Set<string>();
  /** Files kept from the items: path → [text, item that wrote it]. */
  const kept = new Map<string, { text: string; from: string }>();
  /** group_vars/<g>.yml merged: path → key → [value, item]. */
  const groupVars = new Map<string, Map<string, { value: YamlData; from: string }>>();
  /** Names the items' own group_vars/all.yml declare for the person to fill in. */
  const declared = new Map<string, string>();

  items.forEach((item, index) => {
    const blueprint = blueprintFor(item.blueprintId);
    if (!blueprint) {
      findings.push(
        warning('ansible.site.blueprint-gone', `${item.label}: there is no playbook called ${item.blueprintId} on this platform any more.`, {
          remediation: 'Remove it from the list, or switch back to the platform it was added on.',
        }),
      );
      return;
    }

    let name = slug(item.label, `item-${index + 1}`);
    if (names.has(name)) {
      const unique = `${name}-${index + 1}`;
      findings.push(warning('ansible.site.duplicate-name', `Two items are called ${item.label}; the second is written as ${unique}.`, {}));
      name = unique;
    }
    names.add(name);

    // Answers that became variables are referenced rather than repeated.
    const values: Record<string, BlueprintValues[string]> = { ...defaultValues(blueprint), ...item.values };
    for (const [id, { name, value }] of hoisted) {
      if (String(values[id] ?? '').trim() === value) values[id] = `{{ ${name} }}`;
    }

    let built;
    try {
      built = blueprint.build(values, item.label);
    } catch (err) {
      findings.push(warning('ansible.site.build-failed', `${item.label} could not be generated: ${err instanceof Error ? err.message : String(err)}`, {}));
      return;
    }
    for (const f of built.findings ?? []) findings.push({ ...f, message: `${item.label}: ${f.message}` });

    const requirements = built.files['requirements.yml'];
    if (requirements) {
      const read = readRequirements(requirements);
      for (const [collection, version] of read.collections) {
        const seen = collections.get(collection);
        if (!seen) collections.set(collection, { version, from: item.label });
        else if (seen.version !== version && version !== '') {
          findings.push(
            info('ansible.site.collection-version', `${item.label} pins ${collection} ${version} and ${seen.from} pins ${seen.version}; requirements.yml keeps ${seen.version}.`, {
              path: 'requirements.yml',
            }),
          );
        }
      }
      for (const [role, entry] of read.roles) if (!roleRequirements.has(role)) roleRequirements.set(role, entry);
    }

    const playbookFile = Object.keys(built.files).find((file) => /\.ya?ml$/i.test(file) && !file.includes('/') && file !== 'requirements.yml');
    const playbook = playbookFile === undefined ? undefined : built.files[playbookFile];
    if (playbookFile === undefined || playbook === undefined) {
      findings.push(warning('ansible.site.no-playbook', `${item.label} produced no playbook.`, {}));
      return;
    }

    // Everything else the item wrote that the site keeps.
    for (const [path, text] of Object.entries(built.files)) {
      if (path === playbookFile) continue;
      const place = placeOf(path, playbookDir);
      if (!place) continue;
      if (place.kind === 'all') {
        for (const m of text.matchAll(/^([A-Za-z_][A-Za-z0-9_]*):/gm)) {
          const key = m[1] as string;
          if (!key.startsWith('vault_') && !declared.has(key)) declared.set(key, item.label);
        }
        continue;
      }
      if (place.kind === 'group_vars') {
        const read = readVars(text);
        if (!read) {
          findings.push(warning('ansible.site.group-vars-unreadable', `${item.label}: ${path} is not a mapping of variables, so it was left out.`, { path: place.to }));
          continue;
        }
        const merged = groupVars.get(place.to) ?? new Map<string, { value: YamlData; from: string }>();
        for (const [key, value] of read) {
          const seen = merged.get(key);
          if (!seen) merged.set(key, { value, from: item.label });
          else if (JSON.stringify(seen.value) !== JSON.stringify(value)) {
            findings.push(
              warning('ansible.site.group-vars-conflict', `${item.label} and ${seen.from} set ${key} differently in ${path}; the site keeps ${seen.from}'s.`, {
                path: place.to,
                remediation: 'Give the two items the same answer, or move one of them to a group of its own.',
              }),
            );
          }
        }
        groupVars.set(place.to, merged);
        continue;
      }
      const seen = kept.get(place.to);
      if (!seen) kept.set(place.to, { text, from: item.label });
      else if (seen.text !== text) {
        findings.push(
          warning('ansible.site.file-conflict', `${item.label} and ${seen.from} both write ${place.to}, differently; the site keeps ${seen.from}'s.`, {
            path: place.to,
            remediation: 'Two items that bring the same role or file should agree on it; rename one if they really differ.',
          }),
        );
      }
    }

    const text = quoteJinjaScalars(playbook);
    const isApi = requiredCollections(requirements).some((c) => API_COLLECTIONS.test(c));
    for (const host of hostsIn(text)) {
      hosts.add(host);
      (isApi ? apiHosts : hostPlayHosts).add(host);
    }
    const number = options.playbookNumber?.(item, index);
    const base = number !== undefined && Number.isInteger(number) && number >= 0 ? `${String(number).padStart(2, '0')}-${name}.yml` : numbered(index, name, '.yml');
    const fileName = playbookDir ? `${playbookDir}/${base}` : base;
    if (files[fileName] !== undefined) findings.push(warning('ansible.site.duplicate-file', `${item.label} would overwrite ${fileName}; two items were given the same number.`, { path: fileName }));
    files[fileName] = text;
    playbooks.push({ file: fileName, label: item.label });
    imports.push(`- name: ${item.label}\n  import_playbook: ${fileName}`);
  });

  const siteName = options.stackName?.trim() || 'site';
  const inventoryArg = playbookDir ? 'inventory' : 'inventory/hosts.yml';

  files['site.yml'] = `---
# ${siteName} — every playbook in this site, in order.
#
# Install the collections first:  ansible-galaxy ${roleRequirements.size > 0 ? 'install' : 'collection install'} -r requirements.yml
# Then dry-run it:                ansible-playbook -i ${inventoryArg} site.yml --check --diff

${imports.join('\n\n')}
`;

  for (const [path, { text }] of kept) files[path] = text;
  for (const [path, merged] of groupVars) {
    files[path] = renderYaml(Object.fromEntries([...merged].map(([k, { value }]) => [k, value as YamlValue])), {
      header: `Variables for the ${path.replace(/^.*group_vars\//, '').replace(/\.ya?ml$/, '')} group, merged from the playbooks that need them.`,
    });
  }

  for (const [name, from] of declared) {
    if (variables.has(name)) continue;
    variables.set(name, '');
    findings.push(
      warning('ansible.site.undefined-variable', `${from} needs ${name}, which nothing sets. group_vars/all.yml now declares it, with no value.`, {
        path: `${varsBase}group_vars/all.yml`,
        remediation: 'Give it a value there, or pass it with -e on the command line.',
      }),
    );
  }

  if (variables.size > 0) {
    const rows = [...variables.entries()].map(([name, value]) =>
      value === '' ? `${name}: ""   # set this before running` : `${name}: ${/[:#{}[\]]|^\s|\s$/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value}`,
    );
    files[`${varsBase}group_vars/all.yml`] = `---\n# Answers every playbook in this site shares. Change one here and every\n# playbook that references it follows.\n\n${rows.join('\n')}\n`;
    for (const name of variables.keys()) {
      references.push({ expression: name, item: 'group_vars/all.yml', address: `${varsBase}group_vars/all.yml`, attribute: name });
    }
  }

  if (collections.size > 0 || roleRequirements.size > 0) {
    const rows = [...collections.entries()].sort(([a], [b]) => a.localeCompare(b));
    const sections: string[] = [];
    if (rows.length > 0) {
      sections.push(`collections:\n${rows.map(([name, { version }]) => `  - name: ${name}${version ? `\n    version: '${version}'` : ''}`).join('\n')}`);
    }
    if (roleRequirements.size > 0) {
      const roles = [...roleRequirements.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
      sections.push(
        `roles:\n${roles
          .map((r) =>
            Object.entries(r)
              .map(([k, v], i) => `${i === 0 ? '  - ' : '    '}${k}: '${v.replace(/'/g, "''")}'`)
              .join('\n'),
          )
          .join('\n')}`,
      );
    }
    const install = roleRequirements.size > 0 ? 'ansible-galaxy install -r requirements.yml   (collections and roles)' : 'ansible-galaxy collection install -r requirements.yml';
    files['requirements.yml'] = `---\n# Every collection${roleRequirements.size > 0 ? ' and role' : ''} this site uses, merged from its playbooks.\n# Install with: ${install}\n\n${sections.join('\n')}\n`;
  }

  // The inventory the plays need: localhost for API work (a play against
  // `hosts: all` with no hosts does nothing), the named groups for host work.
  const used = [...collections.keys()];
  const apiNeedsEntry = [...apiHosts].some((h) => h !== 'localhost');
  if (apiNeedsEntry && hostPlayHosts.size > 0) {
    findings.push(
      warning('ansible.site.api-play-on-group', `A play that calls an API targets ${[...apiHosts].filter((h) => h !== 'localhost').join(', ')}, and the same site manages hosts. Listing localhost in the inventory for it would put the control node in that pattern for the host plays too.`, {
        path: 'inventory/hosts.yml',
        remediation: 'Set "Run against" to localhost on the API items; Ansible runs them on the control node without an inventory entry.',
      }),
    );
  }
  files['inventory/hosts.yml'] = inventoryYaml({
    api: options.inventory !== 'skeleton' && apiNeedsEntry && hostPlayHosts.size === 0,
    windows: used.some((c) => WINDOWS_COLLECTIONS.test(c)),
    hosts: [...hosts],
    ...(options.inventory === 'skeleton' ? { skeleton: true } : {}),
  });
  const hasRoles = Object.keys(files).some((f) => f.startsWith('roles/'));
  files['ansible.cfg'] = ansibleCfg({
    inventory: playbookDir ? 'inventory' : 'inventory/hosts.yml',
    ...(hasRoles || playbookDir ? { rolesPath: './roles' } : {}),
  });

  files['README.md'] = readme(siteName, playbooks, variables, { inventoryArg, varsBase, roles: roleRequirements.size > 0 });

  return { files, findings, references };
}

function readme(
  siteName: string,
  playbooks: readonly { file: string; label: string }[],
  variables: ReadonlyMap<string, string>,
  layout: { inventoryArg: string; varsBase: string; roles: boolean },
): string {
  return `${[
    `# ${siteName}`,
    '',
    `An Ansible site playbook, from ${playbooks.length} playbook${playbooks.length === 1 ? '' : 's'}.`,
    '',
    '## What it runs, in order',
    '',
    ...playbooks.map((p, i) => `${i + 1}. \`${p.file}\` — ${p.label}`),
    '',
    '## Before the first run',
    '',
    '```',
    layout.roles ? 'ansible-galaxy install -r requirements.yml' : 'ansible-galaxy collection install -r requirements.yml',
    '```',
    '',
    ...(variables.size > 0
      ? [
          `Then check \`${layout.varsBase}group_vars/all.yml\`: ${variables.size} value${variables.size === 1 ? '' : 's'} are shared by the playbooks, and any left empty must be filled in.`,
          '',
        ]
      : []),
    'Put the hosts to manage into `inventory/hosts.yml`; it lists the groups the playbooks name, and localhost for anything that calls an API. `ansible.cfg` points at it, so `-i` is optional.',
    '',
    '## Running it',
    '',
    '```',
    `ansible-playbook -i ${layout.inventoryArg} site.yml --check --diff   # dry run`,
    `ansible-playbook -i ${layout.inventoryArg} site.yml                  # for real`,
    '```',
    '',
    'To run one part on its own, point `ansible-playbook` at that file instead',
    'of `site.yml`. To run only some of it, tag the tasks and use `--tags`.',
    '',
    'No credentials are written into these files. Supply them with',
    '`ansible-vault`, an environment variable, or your inventory.',
    '',
  ].join('\n')}`;
}
