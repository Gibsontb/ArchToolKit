/**
 * The same change, as a playbook that applies it.
 *
 * A config file is what a change record needs and what someone pastes at 2am.
 * A playbook is what applies the same change to forty switches without anyone
 * pasting anything. Both come from one `DeviceChange`, so the file and the
 * playbook cannot say different things.
 *
 * Every play is generated in check mode first — `--check --diff` shows what
 * would change without changing it, which is the closest a network device has
 * to a Terraform plan — and nothing saves the configuration unless the change
 * actually applied.
 *
 * Credentials are never written here. The play reads them from the inventory
 * or a vault, and the README says which variables each platform expects.
 */

import { renderYaml, type YamlValue } from '../ansible/yaml.ts';
import { asciiOnly, PLATFORMS, type DeviceChange, type Platform, type Push } from './device.ts';

/** The inventory group a platform's devices are expected to be in. */
export function defaultHosts(platform: Platform): string {
  switch (platform) {
    case 'cisco_ios':
      return 'ios';
    case 'cisco_nxos':
      return 'nxos';
    case 'cisco_iosxr':
      return 'iosxr';
    case 'cisco_fmc':
      return 'fmc';
    case 'juniper_junos':
      return 'junos';
    case 'aruba_aoscx':
      return 'aoscx';
    case 'cisco_wlc':
      return 'wlc';
    case 'cisco_asa':
      return 'asa';
    case 'arista_eos':
      return 'eos';
    case 'panos':
      return 'panos';
    case 'fortios':
      return 'fortigates';
    case 'f5':
      return 'bigips';
    default:
      return 'network';
  }
}

/**
 * The push task for a change that has no vendor-specific module of its own.
 *
 * `*_config` with `lines` is the generic way to apply IOS, NX-OS and EOS
 * configuration, and it is idempotent in the way those platforms are: the
 * module compares against the running configuration and sends only what
 * differs.
 */
export function configPush(change: DeviceChange): { module: string; args: Record<string, unknown> } | null {
  const module =
    change.platform === 'cisco_ios' || change.platform === 'cisco_wlc'
      ? 'cisco.ios.ios_config'
      : change.platform === 'cisco_nxos'
        ? 'cisco.nxos.nxos_config'
        : change.platform === 'cisco_iosxr'
          ? 'cisco.iosxr.iosxr_config'
          : change.platform === 'aruba_aoscx'
            ? 'arubanetworks.aoscx.aoscx_config'
            : change.platform === 'juniper_junos'
              ? 'junipernetworks.junos.junos_config'
        : change.platform === 'cisco_asa'
          ? 'cisco.asa.asa_config'
          : change.platform === 'arista_eos'
            ? 'arista.eos.eos_config'
            : null;
  if (!module) return null;
  const comment = PLATFORMS[change.platform].comment;
  return {
    module,
    args: {
      // One command per entry: a block written as one multi-line string would
      // reach the device as a single "command" with newlines in it.
      lines: change.config
        .flatMap((entry) => entry.split('\n'))
        .filter((line) => line.trim() !== '' && !line.trim().startsWith('!') && !line.trim().startsWith(comment))
        .map(asciiOnly),
      ...saveArgs(change.platform, change.title),
    },
  };
}

/**
 * The push, pointed at the file that was generated beside the playbook.
 *
 * For the CLI platforms that is `src:` — the module reads the file, skips its
 * `!` comment lines, and works out parents from the indentation, so a block
 * under `interface` or `router bgp` is compared under its parent rather than
 * as a top-level line. It is also the only way the file and the playbook
 * cannot disagree: the playbook applies the file.
 * (docs.ansible.com: ios_config / nxos_config / eos_config / asa_config, `src`
 * — "a relative path from the playbook or role root directory".)
 *
 * For a push that reads a file with `lookup('file', …)` — an AS3 declaration —
 * the lookup is pointed at the generated file's real name.
 */
function pushFor(change: DeviceChange, configFile: string | undefined): Push | ReturnType<typeof configPush> {
  if (change.push) {
    if (!configFile) return change.push;
    const args = Object.fromEntries(
      Object.entries(change.push.args).map(([key, value]) => [
        key,
        typeof value === 'string' ? value.replace(/lookup\((['"])file\1,\s*(['"])[^'"]+\2\)/g, `lookup('file', '${configFile}')`) : value,
      ]),
    );
    return { ...change.push, args };
  }
  const generic = configPush(change);
  if (!generic || !configFile) return generic;
  return {
    module: generic.module,
    args: {
      src: configFile,
      // A Junos file is `set` commands, which junos_config has to be told.
      ...(change.platform === 'juniper_junos' ? { src_format: 'set' } : {}),
      ...saveArgs(change.platform, change.title),
    },
  };
}

/**
 * How each config module saves. IOS, NX-OS, EOS, ASA and AOS-CX save the
 * running configuration when it changed; IOS-XR and Junos commit as part of
 * applying, and take a comment for the commit history instead.
 */
function saveArgs(platform: Platform, title: string): Record<string, unknown> {
  if (platform === 'cisco_iosxr' || platform === 'juniper_junos') return { comment: asciiOnly(title).slice(0, 60) };
  return { save_when: 'changed' };
}

/** The play for one change, as the YAML structure the writer renders. */
/** An FMC change's operations, read from its JSON, or null when they do not parse. */
function fmcOperations(change: DeviceChange): Record<string, unknown>[] | null {
  try {
    const parsed: unknown = JSON.parse(change.config.join('\n'));
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const ops = list.filter((op): op is Record<string, unknown> => typeof op === 'object' && op !== null && typeof (op as Record<string, unknown>).operation === 'string');
    return ops.length > 0 ? ops : null;
  } catch {
    return null;
  }
}

export function playFor(change: DeviceChange, name: string, configFile?: string): YamlValue | null {
  const push = pushFor(change, configFile);
  if (!push) return null;

  const platform = PLATFORMS[change.platform];
  const hosts = ('hosts' in push && typeof push.hosts === 'string' ? push.hosts : undefined) ?? defaultHosts(change.platform);

  const loop = 'loop' in push && typeof push.loop === 'string' ? push.loop : undefined;
  const operations = change.platform === 'cisco_fmc' ? fmcOperations(change) : null;
  const tasks: Record<string, YamlValue>[] = operations
    ? // One task per FMC operation, written into the playbook: a string read
      // from a file at run time is untrusted and its {{ }} are never filled in,
      // so `{{ domain[0].uuid }}` and the objects earlier operations register
      // only resolve from here. The JSON file stays the record of the change.
      operations.map((op, i) => ({
        name: `${change.title} (${i + 1}/${operations.length}): ${String(op.operation)}`,
        [push.module]: op as YamlValue,
        register: 'change_result',
      }))
    : [
        {
          name: change.title,
          [push.module]: push.args as YamlValue,
          ...(loop ? { loop } : {}),
          register: 'change_result',
        },
      ];

  for (const extra of 'after' in push && Array.isArray(push.after) ? push.after : []) {
    tasks.push({
      name: extra.name,
      [extra.module]: extra.args as YamlValue,
      when: 'change_result is changed',
    });
  }

  tasks.push({
    name: 'Show what changed',
    'ansible.builtin.debug': { var: 'change_result' },
    when: 'change_result is changed',
  });

  return [
    {
      name: `${name || change.title} (${platform.label})`,
      hosts,
      gather_facts: false,
      tasks,
    },
  ];
}

/**
 * The playbook file for one change.
 *
 * Returns null for a change with nothing to push — which is honest rather than
 * emitting a playbook that does nothing.
 */
export function pushPlaybook(change: DeviceChange, name: string): string | null {
  const play = playFor(change, name);
  if (!play) return null;
  const platform = PLATFORMS[change.platform];
  return renderYaml(play, {
    header: [
      `${change.title}`,
      '',
      `Dry run first:  ansible-playbook -i inventory ${name || 'change'}.yml --check --diff`,
      `Then apply:     ansible-playbook -i inventory ${name || 'change'}.yml --diff --limit <device>`,
      '',
      `Connection variables belong in the inventory, and credentials in a vault:`,
      ...inventoryHint(platform.id).map((line) => `  ${line}`),
      '',
      'Nothing here writes a password, an enable secret or an API key.',
    ].join('\n'),
  });
}

/**
 * What the inventory has to say for this platform's connection to work, as
 * group variables. Credentials are always a vault variable, never a value.
 *
 *  - IOS, NX-OS, EOS, ASA, 9800: network_cli, with enable.
 *  - PAN-OS: the panos modules run on the control node with pan-os-python and
 *    a `provider` dictionary, so the group's connection is local.
 *  - FortiOS: httpapi with an API token.
 *  - F5: httpapi for the declarative f5_bigip modules (AS3), and a `provider`
 *    dictionary for the imperative f5_modules ones.
 */
export function inventoryVars(platform: Platform): Record<string, YamlValue> {
  const info = PLATFORMS[platform];
  switch (platform) {
    case 'cisco_ios':
    case 'cisco_nxos':
    case 'cisco_wlc':
    case 'cisco_asa':
    case 'arista_eos':
      return {
        ansible_connection: 'ansible.netcommon.network_cli',
        ansible_network_os: info.networkOs ?? '',
        ansible_user: '{{ vault_network_user }}',
        ansible_password: '{{ vault_network_password }}',
        ansible_become: true,
        ansible_become_method: 'enable',
        ansible_become_password: '{{ vault_enable_secret }}',
      };
    case 'cisco_iosxr':
    case 'aruba_aoscx':
      // No enable step on either: the login lands in exec with its task role.
      return {
        ansible_connection: 'ansible.netcommon.network_cli',
        ansible_network_os: info.networkOs ?? '',
        ansible_user: '{{ vault_network_user }}',
        ansible_password: '{{ vault_network_password }}',
      };
    case 'juniper_junos':
      // junos_config works over NETCONF (set system services netconf ssh).
      return {
        ansible_connection: 'ansible.netcommon.netconf',
        ansible_network_os: info.networkOs ?? '',
        ansible_user: '{{ vault_network_user }}',
        ansible_password: '{{ vault_network_password }}',
      };
    case 'cisco_fmc':
      return {
        ansible_connection: 'httpapi',
        ansible_network_os: info.networkOs ?? '',
        ansible_httpapi_use_ssl: true,
        ansible_httpapi_validate_certs: true,
        ansible_httpapi_port: 443,
        ansible_user: '{{ vault_fmc_user }}',
        ansible_password: '{{ vault_fmc_password }}',
      };
    case 'panos':
      return {
        ansible_connection: 'local',
        ansible_python_interpreter: '{{ ansible_playbook_python }}',
        provider: {
          ip_address: '{{ ansible_host | default(inventory_hostname) }}',
          username: '{{ vault_panos_user }}',
          password: '{{ vault_panos_password }}',
        },
      };
    case 'fortios':
      return {
        ansible_connection: 'httpapi',
        ansible_httpapi_use_ssl: true,
        ansible_httpapi_validate_certs: true,
        ansible_httpapi_port: 443,
        ansible_network_os: 'fortinet.fortios.fortios',
        ansible_httpapi_key: '{{ vault_fortios_token }}',
      };
    case 'f5':
      return {
        ansible_connection: 'httpapi',
        ansible_network_os: 'f5networks.f5_bigip.bigip',
        ansible_httpapi_use_ssl: true,
        ansible_httpapi_validate_certs: true,
        ansible_user: '{{ vault_bigip_user }}',
        ansible_password: '{{ vault_bigip_password }}',
        provider: {
          server: '{{ ansible_host | default(inventory_hostname) }}',
          user: '{{ vault_bigip_user }}',
          password: '{{ vault_bigip_password }}',
          validate_certs: true,
        },
      };
    default:
      return {};
  }
}

/** The same variables as YAML lines, for a header or a README. */
export function inventoryHint(platform: Platform): string[] {
  return renderYaml(inventoryVars(platform)).split('\n').filter((line) => line.trim() !== '' && line.trim() !== '---');
}

/** The inventory group a platform's plays run against. */
export function inventoryGroup(platform: Platform): string {
  return defaultHosts(platform);
}

/**
 * A starting inventory for these platforms: one group each, the connection
 * variables set, and one example device to replace.
 */
export function networkInventory(platforms: readonly Platform[]): string {
  const groups: Record<string, YamlValue> = {};
  for (const platform of platforms) {
    groups[inventoryGroup(platform)] = {
      hosts: { [`${platform.replace(/_/g, '-')}-01`]: { ansible_host: '192.0.2.1' } },
      vars: inventoryVars(platform),
    };
  }
  return renderYaml({ all: { children: groups } }, {
    header: [
      'Where the devices are, and how to reach them.',
      '',
      'The device and its address (192.0.2.1 is a documentation address) are',
      'examples: put the real ones here. The vault_* variables go in an encrypted',
      'file: ansible-vault create group_vars/all/vault.yml',
      '',
      'Nothing in this repository should contain a credential in clear text.',
    ].join('\n'),
  });
}

/** ansible.cfg for a network change: the inventory, and host key checking left on. */
export const NETWORK_ANSIBLE_CFG = [
  '# Ansible reads this when run from this directory.',
  '',
  '[defaults]',
  'inventory = inventory/hosts.yml',
  'host_key_checking = True',
  '',
  '[persistent_connection]',
  '# Device sessions can be slow to answer a large change.',
  'command_timeout = 60',
  '',
].join('\n')
