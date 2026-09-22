/**
 * Ansible playbooks and YAML inventories.
 *
 * A playbook is a list of plays; a play has hosts and task lists; a task is
 * one module call plus keywords. The checks are the ones the toolkit's own
 * Ansible kit applies to what it writes: every task calls exactly one module,
 * by its fully-qualified name, and that module exists in the collection
 * (checked against the module catalog fetched from Galaxy). Keywords with a
 * fixed set of answers are dropdowns.
 */

import { classifyModule, catalogueFor } from '../../ansible/catalog.ts';
import { collectionOfModule } from '../../ansible/collections.ts';
import { error, info, warning, type Finding } from '../../core/findings.ts';
import { pathString, type Json, type Path } from '../doc.ts';
import { didYouMean, isObj, keysOf, last, str, type Profile } from '../profile.ts';

const SOURCE = 'Ansible playbook keywords (docs.ansible.com/ansible/latest/reference_appendices/playbooks_keywords.html)';

export const PLAY_KEYWORDS = new Set([
  'any_errors_fatal', 'become', 'become_exe', 'become_flags', 'become_method', 'become_user', 'check_mode',
  'collections', 'connection', 'debugger', 'diff', 'environment', 'fact_path', 'force_handlers', 'gather_facts',
  'gather_subset', 'gather_timeout', 'handlers', 'hosts', 'ignore_errors', 'ignore_unreachable',
  'max_fail_percentage', 'module_defaults', 'name', 'no_log', 'order', 'port', 'post_tasks', 'pre_tasks',
  'remote_user', 'roles', 'run_once', 'serial', 'strategy', 'tags', 'tasks', 'throttle', 'timeout', 'vars',
  'vars_files', 'vars_prompt',
]);

export const TASK_KEYWORDS = new Set([
  'action', 'any_errors_fatal', 'args', 'async', 'become', 'become_exe', 'become_flags', 'become_method',
  'become_user', 'changed_when', 'check_mode', 'collections', 'connection', 'debugger', 'delay', 'delegate_facts',
  'delegate_to', 'diff', 'environment', 'failed_when', 'ignore_errors', 'ignore_unreachable', 'local_action', 'loop',
  'loop_control', 'module_defaults', 'name', 'no_log', 'notify', 'poll', 'port', 'register', 'remote_user',
  'retries', 'run_once', 'tags', 'throttle', 'timeout', 'until', 'vars', 'when', 'listen',
  'block', 'rescue', 'always',
]);

/**
 * ansible.builtin modules. ansible.builtin ships inside ansible-core and is
 * not on Galaxy, so it is not in the fetched catalog; this is the ansible-core
 * 2.17+ module list.
 */
export const BUILTIN_MODULES = new Set([
  'add_host', 'apt', 'apt_key', 'apt_repository', 'assemble', 'assert', 'async_status', 'blockinfile', 'command',
  'copy', 'cron', 'deb822_repository', 'debconf', 'debug', 'dnf', 'dnf5', 'dpkg_selections', 'expect', 'fail',
  'fetch', 'file', 'find', 'gather_facts', 'get_url', 'getent', 'git', 'group', 'group_by', 'hostname',
  'import_playbook', 'import_role', 'import_tasks', 'include_role', 'include_tasks', 'include_vars', 'iptables',
  'known_hosts', 'lineinfile', 'meta', 'mount_facts', 'package', 'package_facts', 'pause', 'ping', 'pip', 'raw',
  'reboot', 'replace', 'rpm_key', 'script', 'service', 'service_facts', 'set_fact', 'set_stats', 'setup', 'shell',
  'slurp', 'stat', 'subversion', 'systemd', 'systemd_service', 'sysvinit', 'tempfile', 'template', 'unarchive',
  'uri', 'user', 'validate_argument_spec', 'wait_for', 'wait_for_connection', 'yum_repository',
]);

const BECOME_METHODS = ['sudo', 'su', 'runas', 'doas', 'pbrun', 'pfexec', 'dzdo', 'ksu', 'machinectl', 'sesu', 'enable'];
const CONNECTIONS = ['ssh', 'local', 'paramiko_ssh', 'winrm', 'psrp', 'network_cli', 'httpapi', 'netconf'];

const KEYWORD_CHOICES: Readonly<Record<string, readonly string[]>> = {
  become_method: BECOME_METHODS,
  ansible_become_method: BECOME_METHODS,
  strategy: ['linear', 'free', 'host_pinned', 'debug'],
  order: ['inventory', 'reverse_inventory', 'sorted', 'reverse_sorted', 'shuffle'],
  connection: CONNECTIONS,
  ansible_connection: CONNECTIONS,
  ansible_shell_type: ['sh', 'csh', 'fish', 'cmd', 'powershell'],
  ansible_winrm_transport: ['basic', 'certificate', 'ntlm', 'kerberos', 'credssp'],
  ansible_winrm_server_cert_validation: ['validate', 'ignore'],
};

/** `state` for the builtin modules that have one, which is most of what gets edited. */
const STATE_CHOICES: Readonly<Record<string, readonly string[]>> = {
  file: ['file', 'directory', 'link', 'hard', 'touch', 'absent'],
  package: ['present', 'absent', 'latest'],
  apt: ['present', 'absent', 'latest', 'build-dep', 'fixed'],
  dnf: ['present', 'absent', 'latest', 'installed', 'removed'],
  dnf5: ['present', 'absent', 'latest', 'installed', 'removed'],
  pip: ['present', 'absent', 'latest', 'forcereinstall'],
  service: ['started', 'stopped', 'restarted', 'reloaded'],
  systemd: ['started', 'stopped', 'restarted', 'reloaded'],
  systemd_service: ['started', 'stopped', 'restarted', 'reloaded'],
  user: ['present', 'absent'],
  group: ['present', 'absent'],
  lineinfile: ['present', 'absent'],
  blockinfile: ['present', 'absent'],
  cron: ['present', 'absent'],
  apt_repository: ['present', 'absent'],
  yum_repository: ['present', 'absent'],
  known_hosts: ['present', 'absent'],
  wait_for: ['present', 'absent', 'started', 'stopped', 'drained'],
};

const TASK_LISTS = ['tasks', 'pre_tasks', 'post_tasks', 'handlers'] as const;

function isPlaybook(doc: Json): boolean {
  return (
    Array.isArray(doc) &&
    doc.length > 0 &&
    doc.every((p) => isObj(p) && ('hosts' in p || 'import_playbook' in p || 'ansible.builtin.import_playbook' in p))
  );
}

/** A list of tasks, as a role's tasks/main.yml holds: every entry calls a module. */
function isTaskList(doc: Json): boolean {
  return (
    Array.isArray(doc) &&
    doc.length > 0 &&
    doc.every((t) => isObj(t) && !('hosts' in t) && (Object.keys(t).some((k) => k.includes('.') || BUILTIN_MODULES.has(k)) || 'block' in t))
  );
}

/** The module keys of a task: everything that is not a keyword or a with_ loop. */
export function moduleKeys(task: Record<string, Json>): string[] {
  return Object.keys(task).filter((k) => !TASK_KEYWORDS.has(k) && !k.startsWith('with_'));
}

function checkModule(name: string, path: string, out: Finding[]): void {
  const collection = collectionOfModule(name);
  if (!collection) {
    if (BUILTIN_MODULES.has(name)) {
      out.push(
        info('ansible.module.short-name', `${name} is the short name; ansible.builtin.${name} says which module is meant.`, {
          path,
          remediation: `Write ansible.builtin.${name}. A collection installed later with its own ${name} would otherwise take over.`,
          source: 'ansible-lint fqcn rule',
        }),
      );
    } else {
      out.push(
        warning('ansible.module.not-qualified', `${name} is not a fully-qualified module name, so which collection it comes from depends on what is installed.`, {
          path,
          remediation: 'Write it as namespace.collection.module.',
        }),
      );
    }
    return;
  }
  if (collection === 'ansible.builtin' || collection === 'ansible.legacy') {
    const bare = name.slice(collection.length + 1);
    if (!BUILTIN_MODULES.has(bare)) {
      const guess = didYouMean(bare, BUILTIN_MODULES);
      out.push(
        warning('ansible.module.builtin-unknown', `${name} is not an ansible-core module the toolkit knows of.${guess ? ` Did you mean ansible.builtin.${guess}?` : ''}`, { path }),
      );
    }
    return;
  }
  const kind = classifyModule(name);
  if (kind === 'unknown') {
    const entry = catalogueFor(collection);
    const guess = entry ? didYouMean(name.slice(collection.length + 1), entry.modules) : undefined;
    out.push(
      error('ansible.module.unknown', `${collection} ${entry ? entry.version : ''} has no module called ${name.slice(collection.length + 1)}.${guess ? ` Did you mean ${collection}.${guess}?` : ''}`.replace('  ', ' '), {
        path,
        source: 'Ansible module catalog (npm run ansible:update)',
      }),
    );
  } else if (kind === 'uncatalogued') {
    out.push(info('ansible.module.uncatalogued', `${collection} is not in the toolkit’s module catalog, so ${name} could not be checked.`, { path }));
  }
}

function checkTasks(list: Json, path: (string | number)[], out: Finding[]): void {
  if (list === null || list === undefined) return;
  if (!Array.isArray(list)) {
    out.push(error('ansible.tasks.not-list', 'A task list must be a list.', { path: pathString(path) }));
    return;
  }
  list.forEach((task, i) => {
    const at = [...path, i];
    if (!isObj(task)) {
      out.push(error('ansible.task.not-mapping', 'Each task must be a mapping.', { path: pathString(at) }));
      return;
    }
    if ('block' in task) {
      for (const key of ['block', 'rescue', 'always'] as const) if (key in task) checkTasks(task[key] as Json, [...at, key], out);
      return;
    }
    const modules = moduleKeys(task);
    if ('action' in task || 'local_action' in task) return;
    if (modules.length === 0) {
      out.push(error('ansible.task.no-module', `Task ${str(task.name) ?? i + 1} calls no module.`, { path: pathString(at) }));
    } else if (modules.length > 1) {
      out.push(
        error('ansible.task.many-modules', `Task ${str(task.name) ?? i + 1} names ${modules.length} modules (${modules.join(', ')}); a task calls one. Any that is a misspelt keyword belongs in the keyword list.`, {
          path: pathString(at),
          source: SOURCE,
        }),
      );
    }
    for (const m of modules) checkModule(m, pathString([...at, m]), out);
    if (!str(task.name) && !modules.some((m) => /(^|\.)(import|include)_(tasks|role)$/.test(m))) {
      out.push(info('ansible.task.unnamed', 'An unnamed task shows in the run output only as its module.', { path: pathString(at) }));
    }
  });
}

export const ansiblePlaybook: Profile = {
  id: 'ansible-playbook',
  family: 'ansible',
  label: 'Ansible playbook or task list',
  format: 'yaml',
  source: SOURCE,
  detect: (doc) => (isPlaybook(doc) ? 0.9 : isTaskList(doc) ? 0.7 : 0),
  choices(path: Path) {
    const key = last(path);
    if (typeof key !== 'string') return undefined;
    if (KEYWORD_CHOICES[key]) return KEYWORD_CHOICES[key];
    if (key === 'state') {
      const module = keysOf(path).slice(-2, -1)[0];
      const bare = module?.replace(/^ansible\.(builtin|legacy)\./, '');
      return bare ? STATE_CHOICES[bare] : undefined;
    }
    return undefined;
  },
  validate(doc) {
    const out: Finding[] = [];
    if (isTaskList(doc)) {
      checkTasks(doc, [], out);
      return out;
    }
    if (!Array.isArray(doc)) return [error('ansible.playbook.not-list', 'A playbook is a list of plays.', { path: '' })];
    doc.forEach((play, i) => {
      if (!isObj(play)) {
        out.push(error('ansible.play.not-mapping', 'Each play must be a mapping.', { path: `[${i}]` }));
        return;
      }
      if ('import_playbook' in play || 'ansible.builtin.import_playbook' in play) return;
      if (!('hosts' in play)) out.push(error('ansible.play.no-hosts', `Play ${str(play.name) ?? i + 1} has no hosts.`, { path: `[${i}]` }));
      for (const key of Object.keys(play)) {
        if (!PLAY_KEYWORDS.has(key)) {
          const guess = didYouMean(key, PLAY_KEYWORDS);
          out.push(
            error('ansible.play.unknown-keyword', `${key} is not a play keyword.${guess ? ` Did you mean ${guess}?` : ''}`, { path: pathString([i, key]), source: SOURCE }),
          );
        }
      }
      for (const list of TASK_LISTS) if (list in play) checkTasks(play[list] as Json, [i, list], out);
      if (Array.isArray(play.roles)) {
        play.roles.forEach((role, r) => {
          const name = typeof role === 'string' ? role : isObj(role) ? str(role.role) ?? str(role.name) : undefined;
          if (!name) out.push(error('ansible.role.no-name', 'A role entry needs a role name.', { path: pathString([i, 'roles', r]) }));
        });
      }
    });
    return out;
  },
  itemTitle(value) {
    if (!isObj(value)) return typeof value === 'string' ? value : undefined;
    const name = str(value.name);
    if (name) return name;
    if ('hosts' in value) return `hosts: ${String(value.hosts)}`;
    const modules = moduleKeys(value);
    return modules[0] ?? str(value.role);
  },
};

// ---------------------------------------------------------------------------
// Inventories
// ---------------------------------------------------------------------------

const GROUP_KEYS = new Set(['hosts', 'children', 'vars']);

function isInventory(doc: Json): boolean {
  if (!isObj(doc)) return false;
  const groups = Object.values(doc);
  if (groups.length === 0) return false;
  const groupish = (g: Json) => g === null || (isObj(g) && Object.keys(g).length > 0 && Object.keys(g).every((k) => GROUP_KEYS.has(k)));
  return ('all' in doc && groupish(doc.all as Json)) || groups.every(groupish);
}

function checkGroup(name: string, group: Json, path: (string | number)[], out: Finding[], seenHosts: Map<string, string>): void {
  if (group === null) return;
  if (!isObj(group)) {
    out.push(error('ansible.inventory.group', `Group ${name} must be a mapping of hosts, children and vars.`, { path: pathString(path) }));
    return;
  }
  for (const key of Object.keys(group)) {
    if (!GROUP_KEYS.has(key)) {
      out.push(
        error('ansible.inventory.group-key', `${key} is not allowed in a group; a group holds hosts, children and vars.`, {
          path: pathString([...path, key]),
          remediation: `If ${key} is a host, put it under hosts; if it is a variable, under vars.`,
        }),
      );
    }
  }
  if (group.hosts !== undefined && group.hosts !== null) {
    if (!isObj(group.hosts)) out.push(error('ansible.inventory.hosts', 'hosts must be a mapping of host names (each with its variables, or empty).', { path: pathString([...path, 'hosts']) }));
    else {
      for (const [host, vars] of Object.entries(group.hosts)) {
        if (vars !== null && !isObj(vars)) {
          out.push(error('ansible.inventory.host-vars', `The variables for ${host} must be a mapping.`, { path: pathString([...path, 'hosts', host]) }));
        }
        seenHosts.set(host, name);
      }
    }
  }
  if (group.vars !== undefined && group.vars !== null && !isObj(group.vars)) {
    out.push(error('ansible.inventory.vars', 'vars must be a mapping.', { path: pathString([...path, 'vars']) }));
  }
  if (group.children !== undefined && group.children !== null) {
    if (!isObj(group.children)) out.push(error('ansible.inventory.children', 'children must be a mapping of groups.', { path: pathString([...path, 'children']) }));
    else for (const [child, g] of Object.entries(group.children)) checkGroup(child, g, [...path, 'children', child], out, seenHosts);
  }
}

export const ansibleInventory: Profile = {
  id: 'ansible-inventory',
  family: 'ansible',
  label: 'Ansible inventory (YAML)',
  format: 'yaml',
  source: 'Ansible inventory guide (docs.ansible.com/ansible/latest/inventory_guide)',
  detect: (doc, name) => (isInventory(doc) ? (/inventor|hosts/i.test(name) ? 0.9 : 0.75) : 0),
  choices(path: Path) {
    const key = last(path);
    return typeof key === 'string' ? KEYWORD_CHOICES[key] : undefined;
  },
  validate(doc) {
    const out: Finding[] = [];
    if (!isObj(doc)) return [error('ansible.inventory.not-mapping', 'An inventory is a mapping of groups.', { path: '' })];
    const seen = new Map<string, string>();
    for (const [name, group] of Object.entries(doc)) checkGroup(name, group, [name], out, seen);
    return out;
  },
  itemTitle: (value) => (isObj(value) ? str(value.name) : undefined),
};
