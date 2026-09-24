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
 *   requirements.yml   every collection the items use, merged and pinned
 *   inventory/hosts.yml  a starting inventory, with the hosts the plays name
 *   README.md          what it does and how to run it
 *
 * Two plays cannot pass values to each other the way two Terraform resources
 * can — a registered variable belongs to the play that registered it. What
 * does carry across every play is `group_vars/all.yml`, so that is what the
 * page's picker offers, and what an answer repeated by two items is hoisted
 * into. A field set to `{{ vcenter_hostname }}` in three playbooks is then
 * changed in one place.
 */

import { ANSIBLE_CFG, API_COLLECTIONS, inventoryYaml, requiredCollections, WINDOWS_COLLECTIONS } from './project.js';
import { info, warning,              } from '../core/findings.js';
import { defaultValues } from '../kit/blueprint.js';
import { numbered, slug,                                                                            } from '../kit/stack.js';
                                                           

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

function variableName(inputId        )         {
  return RESERVED.has(inputId) ? `site_${inputId}` : inputId;
}

/**
 * YAML says a value starting with `{` opens a flow mapping, so `name: {{ x }}`
 * is a parse error. The templates were written for literal answers; quote the
 * ones that now hold a variable.
 */
export function quoteJinjaScalars(yaml        )         {
  return yaml.replace(/^(\s*(?:- )?[A-Za-z0-9_.-]+:\s+)(\{\{[^\n]*\}\})\s*$/gm, (_all, head        , value        ) => `${head}"${value}"`);
}

/** The collections a generated requirements.yml lists, with their version. */
function readRequirements(text        )                      {
  const out = new Map                ();
  let name                    ;
  for (const line of text.split('\n')) {
    const n = /^\s*-\s*name:\s*(\S+)/.exec(line);
    if (n) {
      name = n[1]          ;
      out.set(name, '');
      continue;
    }
    const v = /^\s*version:\s*'?([^'\n]+)'?/.exec(line);
    if (v && name) out.set(name, (v[1]          ).trim().replace(/'$/, ''));
  }
  return out;
}

/** Host patterns the plays run against, for the starting inventory. */
function hostsIn(playbook        )           {
  return [...playbook.matchAll(/^\s*-?\s*hosts:\s*(.+)$/gm)]
    .map((m) => (m[1]          ).trim().replace(/^["']|["']$/g, ''))
    .filter((h) => h !== '' && !h.includes('{{'));
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
export function buildSite(items                      , blueprintFor                 , options                         = {})             {
  const findings            = [];
  const files                         = {};
  const references                   = [];

  if (items.length === 0) {
    return { files: {}, findings: [info('ansible.site.empty', 'Nothing in the build list yet.', {})], references: [] };
  }

  // What each item answers, and which of those answers can become a variable.
  const shared = new Map                                            ();
  const asked = new Map                  ();

  for (const item of items) {
    const blueprint = blueprintFor(item.blueprintId);
    if (!blueprint) continue;
    for (const input of blueprint.inputs) {
      if (!FREE_TEXT.has(input.control)) continue;
      const value = String(item.values[input.id] ?? '').trim();
      if (value === '') continue;
      const named = JINJA.exec(value);
      if (named) {
        const list = asked.get(named[1]          ) ?? [];
        list.push(item.label);
        asked.set(named[1]          , list);
        continue;
      }
      if (value.length < 3) continue;
      if (SECRET_NAME.test(input.id)) continue;
      const seen = shared.get(input.id);
      if (!seen) shared.set(input.id, { value, items: [item.label] });
      else if (seen.value === value) seen.items.push(item.label);
    }
  }

  // Which input becomes which shared variable.
  const hoisted = new Map                                         ();
  for (const [id, seen] of shared) {
    if (seen.items.length < 2) continue;
    const name = variableName(id);
    hoisted.set(id, { name, value: seen.value });
    findings.push(
      info('ansible.site.hoisted', `${seen.items.join(' and ')} all answer ${id} with ${seen.value}; it is now ${name} in group_vars/all.yml, and they reference it.`, {
        path: 'group_vars/all.yml',
      }),
    );
  }

  const variables = new Map                ([...hoisted.values()].map((h) => [h.name, h.value]));
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
        path: 'group_vars/all.yml',
        remediation: 'Give it a value there, or pass it with -e on the command line.',
      }),
    );
  }

  const names = new Set        ();
  const imports           = [];
  const collections = new Map                                           ();
  const hosts = new Set        ();
  /** Host patterns of the plays that call an API, and of the ones that manage hosts. */
  const apiHosts = new Set        ();
  const hostPlayHosts = new Set        ();

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
    const values                                          = { ...defaultValues(blueprint), ...item.values };
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
      for (const [collection, version] of readRequirements(requirements)) {
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
    }

    const playbook = Object.entries(built.files).find(([file]) => /\.ya?ml$/i.test(file) && file !== 'requirements.yml')?.[1];
    if (!playbook) {
      findings.push(warning('ansible.site.no-playbook', `${item.label} produced no playbook.`, {}));
      return;
    }

    const text = quoteJinjaScalars(playbook);
    const isApi = requiredCollections(requirements).some((c) => API_COLLECTIONS.test(c));
    for (const host of hostsIn(text)) {
      hosts.add(host);
      (isApi ? apiHosts : hostPlayHosts).add(host);
    }
    const fileName = numbered(index, name, '.yml');
    files[fileName] = text;
    imports.push(`- name: ${item.label}\n  import_playbook: ${fileName}`);
  });

  const siteName = options.stackName?.trim() || 'site';

  files['site.yml'] = `---
# ${siteName} — every playbook in this site, in order.
#
# Install the collections first:  ansible-galaxy collection install -r requirements.yml
# Then dry-run it:                ansible-playbook -i inventory/hosts.yml site.yml --check --diff

${imports.join('\n\n')}
`;

  if (variables.size > 0) {
    const rows = [...variables.entries()].map(([name, value]) =>
      value === '' ? `${name}: ""   # set this before running` : `${name}: ${/[:#{}[\]]|^\s|\s$/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value}`,
    );
    files['group_vars/all.yml'] = `---\n# Answers every playbook in this site shares. Change one here and every\n# playbook that references it follows.\n\n${rows.join('\n')}\n`;
    for (const name of variables.keys()) {
      references.push({ expression: name, item: 'group_vars/all.yml', address: 'group_vars/all.yml', attribute: name });
    }
  }

  if (collections.size > 0) {
    const rows = [...collections.entries()].sort(([a], [b]) => a.localeCompare(b));
    files['requirements.yml'] = `---\n# Every collection this site uses, merged from its playbooks.\n# Install with: ansible-galaxy collection install -r requirements.yml\n\ncollections:\n${rows
      .map(([name, { version }]) => `  - name: ${name}${version ? `\n    version: '${version}'` : ''}`)
      .join('\n')}\n`;
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
    api: apiNeedsEntry && hostPlayHosts.size === 0,
    windows: used.some((c) => WINDOWS_COLLECTIONS.test(c)),
    hosts: [...hosts],
  });
  files['ansible.cfg'] = ANSIBLE_CFG;

  files['README.md'] = readme(siteName, items, files, variables);

  return { files, findings, references };
}

function readme(siteName        , items                      , files                                  , variables                             )         {
  const playbooks = Object.keys(files).filter((f) => /^\d\d-/.test(f));
  return `${[
    `# ${siteName}`,
    '',
    `An Ansible site playbook, from ${items.length} playbook${items.length === 1 ? '' : 's'}.`,
    '',
    '## What it runs, in order',
    '',
    ...playbooks.map((f, i) => `${i + 1}. \`${f}\` — ${items[i]?.label ?? ''}`),
    '',
    '## Before the first run',
    '',
    '```',
    'ansible-galaxy collection install -r requirements.yml',
    '```',
    '',
    ...(variables.size > 0
      ? [
          `Then check \`group_vars/all.yml\`: ${variables.size} value${variables.size === 1 ? '' : 's'} are shared by the playbooks, and any left empty must be filled in.`,
          '',
        ]
      : []),
    'Put the hosts to manage into `inventory/hosts.yml`; it lists the groups the playbooks name, and localhost for anything that calls an API. `ansible.cfg` points at it, so `-i` is optional.',
    '',
    '## Running it',
    '',
    '```',
    'ansible-playbook -i inventory/hosts.yml site.yml --check --diff   # dry run',
    'ansible-playbook -i inventory/hosts.yml site.yml                  # for real',
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
