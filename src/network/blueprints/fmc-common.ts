/**
 * Shared pieces for the Cisco Secure Firewall (FTD managed by FMC) blueprints.
 *
 * An FMC change is not CLI. It is a list of FMC REST API operations, by their
 * operationId, as the cisco.fmcansible.fmc_configuration module takes them:
 *
 *   { "operation": "upsertHostObject", "data": {…}, "path_params": {…},
 *     "query_params": {…}, "filters": {…}, "register_as": "…" }
 *
 * Every list starts by looking up the domain (`getAllDomain`, registered as
 * `domain`), and later operations refer to what earlier ones registered with
 * `{{ … }}`, the way the collection's own samples do. The file is that list as
 * JSON, and the playbook runs the module once per operation, in order.
 *
 * Nothing here reaches a firewall until FMC deploys it.
 */

import type { DeviceChange, Push } from '../device.ts';

export const PLATFORM = 'cisco_fmc' as const;
export const SECRET = '<REQUIRED>';
export const SRC = { source: 'ArchToolKit' } as const;
export const MODULE = 'cisco.fmcansible.fmc_configuration';

/** One FMC API call, as fmc_configuration takes it. */
export interface Operation {
  readonly operation: string;
  readonly data?: unknown;
  readonly path_params?: Readonly<Record<string, string>>;
  readonly query_params?: Readonly<Record<string, string | number | boolean>>;
  readonly filters?: Readonly<Record<string, string>>;
  readonly register_as?: string;
}

/** The domain UUID, as registered by the first operation. */
export const DOMAIN = '{{ domain[0].uuid }}';
export const IN_DOMAIN = { domainUUID: DOMAIN } as const;

export const GET_DOMAIN: Operation = { operation: 'getAllDomain', register_as: 'domain' };

/** A fact name for an object, from its name: `zone_inside`, `net_web_servers`. */
export function fact(prefix: string, name: string): string {
  const cleaned = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${prefix}_${cleaned || 'x'}`;
}

/** Look an existing object up by name and register the (list) result. */
export function find(operation: string, name: string, register: string, path_params: Readonly<Record<string, string>> = IN_DOMAIN): Operation {
  return { operation, path_params, filters: { name }, register_as: register };
}

/** A reference to the first item a lookup registered. */
export function ref(register: string, type: string, name?: string): Record<string, string> {
  return { id: `{{ ${register}[0].id }}`, type, ...(name ? { name } : {}) };
}

/** A reference to an object a create or upsert registered (a single object). */
export function refOne(register: string, type: string): Record<string, string> {
  return { id: `{{ ${register}.id }}`, type };
}

/** The operations as the lines of one pretty-printed JSON array. */
export function operations(ops: readonly Operation[]): string[] {
  return JSON.stringify([GET_DOMAIN, ...ops], null, 2).split('\n');
}

/**
 * The push: fmc_configuration once per operation.
 *
 * The playbook writer turns an FMC change into one task per operation, with
 * the operation's own arguments written in (push.ts playFor): references such
 * as `{{ domain[0].uuid }}` only resolve in the playbook, not in strings read
 * from a file. These file-reading arguments are the fallback for a change
 * whose operations do not parse.
 */
export function fmcPush(ops: readonly Operation[]): Push {
  const at = (key: string, optional: boolean) => `{{ (lookup('file', 'fmc-change.json') | from_json)[item].${key}${optional ? ' | default(omit)' : ''} }}`;
  return {
    module: MODULE,
    args: {
      operation: at('operation', false),
      data: at('data', true),
      path_params: at('path_params', true),
      query_params: at('query_params', true),
      filters: at('filters', true),
      register_as: at('register_as', true),
    },
    // The domain lookup that operations() puts first is one more.
    loop: `{{ range(0, ${ops.length + 1}) | list }}`,
    hosts: 'fmc',
  };
}

/** The line every FMC change carries: nothing is live until it is deployed. */
export const DEPLOY_NOTE =
  'These operations change FMC’s configuration only. Nothing reaches the firewall until the pending changes are deployed (Deploy > Deployment in FMC, or the deployment blueprint).';

/** Where the change can be seen before deployment. */
export const PREVIEW_NOTE = 'Before deploying, Deploy > Deployment > (device) > Preview shows the exact FTD CLI this change generates: read it.';

/** "10.0.0.0/24", "10.0.0.5", "10.0.0.5-10.0.0.9" or a hostname, as FMC object types. */
export function objectKind(value: string): 'Host' | 'Network' | 'Range' | 'FQDN' | null {
  const v = String(value ?? '').trim();
  if (/^[0-9.]+\/\d{1,2}$/.test(v) || /^[0-9a-f:]+\/\d{1,3}$/i.test(v)) return 'Network';
  if (/^[0-9.]+-[0-9.]+$/.test(v) || /^[0-9a-f:]+-[0-9a-f:]+$/i.test(v)) return 'Range';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v) || (/^[0-9a-f:]+$/i.test(v) && v.includes(':'))) return 'Host';
  if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(v)) return 'FQDN';
  return null;
}

/** The upsert operation for each object kind. */
export const UPSERT: Readonly<Record<'Host' | 'Network' | 'Range' | 'FQDN', string>> = {
  Host: 'upsertHostObject',
  Network: 'upsertNetworkObject',
  Range: 'upsertRangeObject',
  FQDN: 'upsertFQDNObject',
};

/** The delete operation for each object kind, for the back-out. */
export const DELETE: Readonly<Record<'Host' | 'Network' | 'Range' | 'FQDN', string>> = {
  Host: 'deleteHostObject',
  Network: 'deleteNetworkObject',
  Range: 'deleteRangeObject',
  FQDN: 'deleteFQDNObject',
};

/** A name FMC accepts for an object: letters, digits, `-`, `_`, `.`; no spaces. */
export function objectName(value: string, fallback: string): string {
  const text = String(value ?? '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9._+-]/g, '');
  return (text || fallback).slice(0, 64);
}

/** The change around a list of operations: the file, the push and the deploy note. */
export function apiChange(ops: readonly Operation[], rest: Omit<DeviceChange, 'platform' | 'config' | 'push'>): DeviceChange {
  return { platform: PLATFORM, ...rest, notes: [...(rest.notes ?? []), DEPLOY_NOTE], config: operations(ops), push: fmcPush(ops) };
}

/** A network object found by name, whatever its type (host, network, range, group). */
export function findAddress(name: string): Operation {
  return find('getNetworkAddress', name, fact('addr', name));
}

/** A reference to an address found by findAddress, carrying the type FMC returned. */
export function addressRef(name: string): Record<string, string> {
  const f = fact('addr', name);
  return { id: `{{ ${f}[0].id }}`, type: `{{ ${f}[0].type }}` };
}

export function findZone(name: string): Operation {
  return find('getAllSecurityZoneObject', name, fact('zone', name));
}

export function zoneRef(name: string): Record<string, string> {
  return ref(fact('zone', name), 'SecurityZone', name);
}
