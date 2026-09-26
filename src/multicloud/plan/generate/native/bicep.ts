/**
 * Azure Bicep, and its ARM JSON, from a decided, designed plan: the same
 * design model the Terraform stacks are built from (./../terraform.ts),
 * written as templates Azure ingests natively, deployable with
 * `az deployment group create` or from the portal's "Deploy a custom
 * template".
 *
 *   azure-bicep/main.bicep            the entry point: parameters and modules
 *   azure-bicep/modules/<part>.bicep  landing zone, identity, connectivity,
 *                                     compute, databases, backup, monitoring,
 *                                     each app's items
 *   azure-bicep/main.bicepparam       the parameter values; secrets are read
 *                                     from the environment, never written
 *   azure-bicep/azuredeploy.json      the same deployment as one ARM template
 *                                     (each module a nested deployment), for
 *                                     the portal
 *   azure-bicep/README.md             what is in it and how to deploy
 *
 * Both the Bicep and the ARM JSON are rendered from one model of the
 * resources, so they deploy the same thing; the ARM is written here (not by
 * `bicep build`), so it is the same every time and carries no generator
 * metadata.
 *
 * Nothing is written for a part without a clean equivalent: it is a finding
 * ("in Terraform only: …") and a line in the README. Credentials are never in
 * the files: the databases use Entra ID authentication only (no password
 * exists), and what Azure needs a secret for at create (a Windows VM's
 * administrator, a MySQL administrator, a VPN shared key) is a `@secure()`
 * parameter that main.bicepparam reads from the environment.
 */

import { info, warning, type Finding } from '../../../../core/findings.ts';
import { carve, ulaFor } from '../../../../terraform/blueprints/migration/common.ts';
import { isIaasService } from '../../design/index.ts';
import { DB_SERVICES_EXTRA } from '../../db-catalog-extra.ts';
import { slugName } from '../../options.ts';
import type { ComputeTarget, NetworkDesign, Plan, PlanDecision, TargetDesign } from '../../types.ts';
import { classCell, type AppComponentLike } from '../terraform.ts';
import {
  AD_PORTS, DB_PORTS, THRESHOLDS, camel, cloudInitLines, dbEnv, dbNetwork, isV6, kebab, mgmtCidrs, nativeContext, osKindOf, planTag,
  retentionOf, siteSources, terraformOnly, terraformOnlySection, utf16leBase64, vmName, vmTags, winrmLines, workloadOf, zoneIndexOf,
  type AppHere, type NativeCtx, type NativeFiles, type NativeOptions,
} from './common.ts';

export type { NativeFiles, NativeOptions } from './common.ts';

// ---------------------------------------------------------------------------
// The model: resources, values and expressions
// ---------------------------------------------------------------------------

/** An expression, rendered in Bicep and in ARM. */
interface EArgs {
  readonly name?: string;
  readonly res?: Res;
  readonly path?: string;
  readonly fn?: string;
  readonly args?: readonly Val[];
  readonly parts?: readonly (string | E)[];
  readonly bicep?: string;
  readonly arm?: string;
}

class E {
  readonly k: 'param' | 'id' | 'prop' | 'call' | 'interp' | 'raw' | 'rid';
  readonly a: EArgs;
  constructor(k: E['k'], a: EArgs) {
    this.k = k;
    this.a = a;
  }
}

/** An object whose keys are expressions (userAssignedIdentities). */
class Dict {
  readonly entries: readonly (readonly [string | E, Val])[];
  constructor(entries: readonly (readonly [string | E, Val])[]) {
    this.entries = entries;
  }
}

type Val = string | number | boolean | null | E | Dict | readonly Val[] | { readonly [key: string]: Val | undefined };
type Body = { readonly [key: string]: Val | undefined };

interface Res {
  /** Bicep symbol, unique in the deployment. */
  readonly sym: string;
  /** The full type: `Microsoft.Network/virtualNetworks/subnets`. */
  readonly type: string;
  readonly api: string;
  readonly module: string;
  /** The leaf name. */
  readonly name: Val;
  readonly parent?: Res;
  /** The resource an extension resource applies to. */
  readonly scope?: Res;
  /** Declared `existing`: named, never created. */
  readonly existing?: boolean;
  /** `name` is the full name (`parent/child/…`): for a child whose parents have no type to declare. */
  readonly fullName?: boolean;
  readonly body: Body;
  readonly dependsOn?: readonly Res[];
}

const P = (name: string): E => new E('param', { name });
const id = (res: Res): E => new E('id', { res });
const prop = (res: Res, path: string): E => new E('prop', { res, path });
const call = (fn: string, ...args: Val[]): E => new E('call', { fn, args });
const str = (...parts: (string | E)[]): E => new E('interp', { parts });
const raw = (text: string, arm = text): E => new E('raw', { bicep: text, arm });
/** `resourceId(type, names…)`: an id built from names, not a reference (no dependency). */
const rid = (type: string, ...names: Val[]): E => new E('rid', { name: type, args: names });
const subnetId = (vnet: Res, name: string): E => str(id(vnet), `/subnets/${name}`);

/** A short, stable suffix for names Azure wants globally unique. */
const SUFFIX = raw('take(uniqueString(resourceGroup().id), 6)');

// ---------------------------------------------------------------------------
// Parameters of the deployment
// ---------------------------------------------------------------------------

interface ParamSpec {
  readonly type: 'string' | 'int' | 'bool';
  readonly description: string;
  readonly secure?: boolean;
  readonly default?: Val;
  readonly allowed?: readonly string[];
  /** For main.bicepparam: the environment variable a required value is read from. */
  readonly env?: string;
}

// ---------------------------------------------------------------------------
// API versions (the newest stable in the ARM schemas the Data Editor carries,
// checked by the tests, and known to the Bicep compiler)
// ---------------------------------------------------------------------------

export const AZURE_API: Readonly<Record<string, string>> = {
  'Microsoft.Network/networkSecurityGroups': '2025-09-01',
  'Microsoft.Network/publicIPAddresses': '2025-09-01',
  'Microsoft.Network/natGateways': '2025-09-01',
  'Microsoft.Network/virtualNetworks': '2025-09-01',
  'Microsoft.Network/virtualNetworks/virtualNetworkPeerings': '2025-09-01',
  'Microsoft.Network/routeTables': '2025-09-01',
  'Microsoft.Network/bastionHosts': '2025-09-01',
  'Microsoft.Network/networkInterfaces': '2025-09-01',
  'Microsoft.Network/privateEndpoints': '2025-09-01',
  'Microsoft.Network/privateEndpoints/privateDnsZoneGroups': '2025-09-01',
  'Microsoft.Network/virtualNetworkGateways': '2025-09-01',
  'Microsoft.Network/localNetworkGateways': '2025-09-01',
  'Microsoft.Network/connections': '2025-09-01',
  'Microsoft.Network/networkWatchers': '2025-09-01',
  'Microsoft.Network/networkWatchers/flowLogs': '2025-09-01',
  'Microsoft.Network/privateDnsZones': '2024-06-01',
  'Microsoft.Network/privateDnsZones/virtualNetworkLinks': '2024-06-01',
  'Microsoft.Network/dnsResolvers': '2025-05-01',
  'Microsoft.Network/dnsResolvers/outboundEndpoints': '2025-05-01',
  'Microsoft.Network/dnsForwardingRulesets': '2025-05-01',
  'Microsoft.Network/dnsForwardingRulesets/forwardingRules': '2025-05-01',
  'Microsoft.Network/dnsForwardingRulesets/virtualNetworkLinks': '2025-05-01',
  'Microsoft.KeyVault/vaults': '2026-02-01',
  'Microsoft.KeyVault/vaults/keys': '2026-02-01',
  'Microsoft.Compute/diskEncryptionSets': '2026-03-02',
  'Microsoft.Compute/virtualMachines': '2026-04-01',
  'Microsoft.Compute/virtualMachines/extensions': '2026-04-01',
  'Microsoft.Authorization/roleAssignments': '2022-04-01',
  'Microsoft.OperationalInsights/workspaces': '2026-03-01',
  'Microsoft.Storage/storageAccounts': '2026-04-01',
  'Microsoft.Storage/storageAccounts/blobServices': '2026-04-01',
  'Microsoft.Storage/storageAccounts/blobServices/containers': '2026-04-01',
  'Microsoft.Insights/diagnosticSettings': '2021-05-01-preview',
  'Microsoft.ManagedIdentity/userAssignedIdentities': '2024-11-30',
  'Microsoft.AAD/domainServices': '2025-06-01',
  'Microsoft.Sql/servers': '2025-01-01',
  'Microsoft.Sql/servers/databases': '2025-01-01',
  'Microsoft.Sql/servers/databases/backupShortTermRetentionPolicies': '2025-01-01',
  'Microsoft.Sql/managedInstances': '2025-01-01',
  'Microsoft.DBforPostgreSQL/flexibleServers': '2025-08-01',
  'Microsoft.DBforPostgreSQL/flexibleServers/administrators': '2025-08-01',
  'Microsoft.DBforMySQL/flexibleServers': '2024-12-30',
  'Microsoft.SqlVirtualMachine/sqlVirtualMachines': '2023-10-01',
  'Microsoft.RecoveryServices/vaults': '2026-07-01',
  'Microsoft.RecoveryServices/vaults/backupPolicies': '2026-07-01',
  'Microsoft.RecoveryServices/vaults/backupFabrics/protectionContainers/protectedItems': '2026-07-01',
  'Microsoft.Insights/dataCollectionRules': '2024-03-11',
  'Microsoft.Insights/dataCollectionRuleAssociations': '2024-03-11',
  'Microsoft.Insights/actionGroups': '2023-01-01',
  'Microsoft.Insights/metricAlerts': '2026-01-01',
  'Microsoft.Web/serverfarms': '2024-11-01',
  'Microsoft.Web/sites': '2024-11-01',
  'Microsoft.Web/sites/basicPublishingCredentialsPolicies': '2024-11-01',
  'Microsoft.Web/staticSites': '2024-11-01',
  'Microsoft.AVS/privateClouds': '2025-09-01',
  'Microsoft.Resources/deployments': '2025-04-01',
};

const api = (type: string): string => {
  const v = AZURE_API[type];
  if (!v) throw new Error(`No API version for ${type}`);
  return v;
};

// ---------------------------------------------------------------------------
// Bicep rendering
// ---------------------------------------------------------------------------

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function bicepString(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t').replace(/\$\{/g, '\\${')}'`;
}

interface BicepScope {
  /** Resource → the symbol it is known by here (its own, or an `existing` declaration). */
  readonly local: ReadonlySet<Res>;
  /** Parameters synthesised for a module in another resource group: resource → param name. */
  readonly idParams?: ReadonlyMap<Res, string>;
  /** At main level: no resource symbols at all, ids by resourceId(). */
  readonly main?: boolean;
}

function bExpr(e: E, s: BicepScope): string {
  switch (e.k) {
    case 'param': return e.a.name as string;
    case 'raw': return e.a.bicep as string;
    case 'rid': return `resourceId(${[bicepString(e.a.name as string), ...(e.a.args ?? []).map((x) => bVal(x, s, 0))].join(', ')})`;
    case 'id': {
      const r = e.a.res as Res;
      const p = s.idParams?.get(r);
      if (p) return p;
      if (s.main) return armStyleId(r, (v) => bVal(v, s, 0), bicepString);
      return `${r.sym}.id`;
    }
    case 'prop': return `${(e.a.res as Res).sym}.${e.a.path}`;
    case 'call': return `${e.a.fn}(${(e.a.args ?? []).map((x) => bVal(x, s, 0)).join(', ')})`;
    case 'interp': {
      const parts = e.a.parts ?? [];
      if (parts.length === 1 && typeof parts[0] !== 'string') return bExpr(parts[0] as E, s);
      return `'${parts.map((p) => (typeof p === 'string' ? bicepString(p).slice(1, -1) : `\${${bExpr(p, s)}}`)).join('')}'`;
    }
  }
}

function bVal(v: Val | undefined, s: BicepScope, depth: number): string {
  const pad = '  '.repeat(depth + 1);
  const end = '  '.repeat(depth);
  if (v === undefined || v === null) return 'null';
  if (v instanceof E) return bExpr(v, s);
  if (typeof v === 'string') return bicepString(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Dict) {
    if (v.entries.length === 0) return '{}';
    return `{\n${v.entries.map(([k, x]) => `${pad}${typeof k === 'string' ? (IDENT.test(k) ? k : bicepString(k)) : `'\${${bExpr(k, s)}}'`}: ${bVal(x, s, depth + 1)}`).join('\n')}\n${end}}`;
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    return `[\n${v.map((x) => `${pad}${bVal(x, s, depth + 1)}`).join('\n')}\n${end}]`;
  }
  const entries = Object.entries(v as Record<string, Val | undefined>).filter(([, x]) => x !== undefined);
  if (entries.length === 0) return '{}';
  return `{\n${entries.map(([k, x]) => `${pad}${IDENT.test(k) ? k : bicepString(k)}: ${bVal(x, s, depth + 1)}`).join('\n')}\n${end}}`;
}

// ---------------------------------------------------------------------------
// ARM rendering
// ---------------------------------------------------------------------------

function armString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** The segments of a resource's full name, root first. */
function nameChain(r: Res): Val[] {
  return r.parent ? [...nameChain(r.parent), r.name] : [r.name];
}

/** `resourceId('A/B', 'a', 'b')` (or its extension form) from the names. */
function armStyleId(r: Res, val: (v: Val) => string, strLit: (s: string) => string): string {
  if (r.scope) return `extensionResourceId(${armStyleId(r.scope, val, strLit)}, ${strLit(r.type)}, ${val(r.name)})`;
  return `resourceId(${[strLit(r.type), ...nameChain(r).map(val)].join(', ')})`;
}

interface ArmScope {
  readonly idParams?: ReadonlyMap<Res, string>;
  /** Resources referenced (for dependsOn), collected while rendering. */
  readonly refs?: Set<Res>;
}

function aExpr(e: E, s: ArmScope): string {
  switch (e.k) {
    case 'param': return `parameters(${armString(e.a.name as string)})`;
    case 'raw': return e.a.arm as string;
    case 'rid': return `resourceId(${[armString(e.a.name as string), ...(e.a.args ?? []).map((x) => aInner(x, s))].join(', ')})`;
    case 'id': {
      const r = e.a.res as Res;
      const p = s.idParams?.get(r);
      if (p) return `parameters(${armString(p)})`;
      s.refs?.add(r);
      return armStyleId(r, (v) => aInner(v, s), armString);
    }
    case 'prop': {
      const r = e.a.res as Res;
      s.refs?.add(r);
      const path = e.a.path as string;
      const idText = armStyleId(r, (v) => aInner(v, s), armString);
      if (path.startsWith('properties.')) return `reference(${idText}, ${armString(r.api)}).${path.slice('properties.'.length)}`;
      return `reference(${idText}, ${armString(r.api)}, 'full').${path}`;
    }
    case 'call': return `${e.a.fn}(${(e.a.args ?? []).map((x) => aInner(x, s)).join(', ')})`;
    case 'interp': {
      const parts = e.a.parts ?? [];
      if (parts.length === 1 && typeof parts[0] !== 'string') return aExpr(parts[0] as E, s);
      let fmt = '';
      const args: string[] = [];
      for (const p of parts) {
        if (typeof p === 'string') fmt += p.replace(/\{/g, '{{').replace(/\}/g, '}}');
        else {
          fmt += `{${args.length}}`;
          args.push(aExpr(p, s));
        }
      }
      return args.length === 0 ? armString(fmt) : `format(${[armString(fmt), ...args].join(', ')})`;
    }
  }
}

/** A value inside an expression (a function argument). */
function aInner(v: Val | undefined, s: ArmScope): string {
  if (v === undefined || v === null) return 'null()';
  if (v instanceof E) return aExpr(v, s);
  if (typeof v === 'string') return armString(v);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true()' : 'false()';
  throw new Error('Objects and arrays are not function arguments here');
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** A value as ARM JSON. */
function aVal(v: Val | undefined, s: ArmScope): Json {
  if (v === undefined || v === null) return null;
  if (v instanceof E) return `[${aExpr(v, s)}]`;
  if (typeof v === 'string') return v.startsWith('[') ? `[${v}` : v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof Dict) {
    const out: Record<string, Json> = {};
    for (const [k, x] of v.entries) out[typeof k === 'string' ? k : `[${aExpr(k, s)}]`] = aVal(x, s);
    return out;
  }
  if (Array.isArray(v)) return v.map((x) => aVal(x, s));
  const out: Record<string, Json> = {};
  for (const [k, x] of Object.entries(v as Record<string, Val | undefined>)) if (x !== undefined) out[k] = aVal(x, s);
  return out;
}

// ---------------------------------------------------------------------------
// The deployment: modules and their rendering
// ---------------------------------------------------------------------------

interface ModuleSpec {
  readonly name: string;
  readonly description: string;
  /** Another resource group (the flow logs go to NetworkWatcherRG). */
  readonly resourceGroup?: string;
}

class Deployment {
  readonly params = new Map<string, ParamSpec>();
  readonly modules: ModuleSpec[] = [];
  readonly resources: Res[] = [];
  private readonly syms = new Set<string>();
  readonly deploymentPrefix: string;

  constructor(deploymentPrefix: string) {
    this.deploymentPrefix = deploymentPrefix;
  }

  param(name: string, spec: ParamSpec): E {
    if (!this.params.has(name)) this.params.set(name, spec);
    return P(name);
  }

  module(spec: ModuleSpec): string {
    if (!this.modules.some((m) => m.name === spec.name)) this.modules.push(spec);
    return spec.name;
  }

  add(r: Omit<Res, 'sym' | 'api'> & { readonly sym: string; readonly api?: string }): Res {
    let sym = r.sym;
    for (let i = 2; this.syms.has(sym); i += 1) sym = `${r.sym}${i}`;
    this.syms.add(sym);
    const res: Res = { ...r, sym, api: r.api ?? api(r.type) };
    this.resources.push(res);
    return res;
  }

  of(module: string): Res[] {
    return this.resources.filter((r) => r.module === module);
  }
}

/** Every resource and parameter an expression tree names. */
function walk(v: Val | undefined, onRes: (r: Res, kind: 'id' | 'prop') => void, onParam: (p: string) => void): void {
  if (v === undefined || v === null || typeof v !== 'object') return;
  if (v instanceof E) {
    if (v.k === 'param') onParam(v.a.name as string);
    if (v.k === 'id' || v.k === 'prop') onRes(v.a.res as Res, v.k);
    for (const x of v.a.args ?? []) walk(x, onRes, onParam);
    for (const x of v.a.parts ?? []) if (typeof x !== 'string') walk(x, onRes, onParam);
    return;
  }
  if (v instanceof Dict) {
    for (const [k, x] of v.entries) {
      if (typeof k !== 'string') walk(k, onRes, onParam);
      walk(x, onRes, onParam);
    }
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) walk(x, onRes, onParam);
    return;
  }
  for (const x of Object.values(v as Record<string, Val>)) walk(x, onRes, onParam);
}

/** What a module refers to: parameters, resources of other modules (and their parents), and the modules they are in. */
function analyse(d: Deployment, module: ModuleSpec): { params: string[]; foreign: Res[]; dependsOn: string[] } {
  const own = new Set(d.of(module.name));
  const params = new Set<string>();
  const foreign = new Set<Res>();
  const mods = new Set<string>();
  const addForeign = (r: Res): void => {
    if (own.has(r)) return;
    if (!foreign.has(r)) {
      foreign.add(r);
      walk(r.name, addForeign, (p) => params.add(p));
      if (r.parent) addForeign(r.parent);
    }
    if (!r.existing) mods.add(r.module);
  };
  const visit = (r: Res): void => {
    walk(r.name, addForeign, (p) => params.add(p));
    walk(r.body as Val, addForeign, (p) => params.add(p));
    if (r.parent) {
      if (own.has(r.parent)) { /* declared here */ } else addForeign(r.parent);
    }
    if (r.scope && !own.has(r.scope)) addForeign(r.scope);
    for (const x of r.dependsOn ?? []) if (!own.has(x)) mods.add(x.module);
  };
  for (const r of own) visit(r);
  // Parents of own resources that are own too, but existing, are fine.
  mods.delete(module.name);
  return { params: [...params].sort(), foreign: [...foreign], dependsOn: [...mods] };
}

function paramDecl(name: string, spec: ParamSpec, withDefault: boolean): string {
  const lines: string[] = [`@description(${bicepString(spec.description)})`];
  if (spec.secure) lines.push('@secure()');
  if (spec.allowed) lines.push(`@allowed([\n${spec.allowed.map((a) => `  ${bicepString(a)}`).join('\n')}\n])`);
  const def = withDefault && spec.default !== undefined ? ` = ${bVal(spec.default, { local: new Set() }, 0)}` : '';
  lines.push(`param ${name} ${spec.type}${def}`);
  return lines.join('\n');
}

/** The Bicep of one module. */
function moduleBicep(d: Deployment, m: ModuleSpec): string {
  const own = d.of(m.name);
  const { params, foreign } = analyse(d, m);
  const idParams = new Map<Res, string>();
  const lines: string[] = [];
  if (m.resourceGroup) {
    // In another resource group the landing zone's resources are passed in as ids.
    for (const r of foreign) if (!r.existing) idParams.set(r, `${r.sym}Id`);
  }
  const local = new Set<Res>([...own, ...foreign.filter((r) => !idParams.has(r))]);
  const scope: BicepScope = { local, idParams };
  lines.push(`// ${m.description}`, '');
  for (const p of params) lines.push(paramDecl(p, d.params.get(p) as ParamSpec, false), '');
  for (const [r, p] of idParams) lines.push(`@description(${bicepString(`The id of ${r.sym}.`)})`, `param ${p} string`, '');
  const decl = (r: Res, existing: boolean): void => {
    const head = `resource ${r.sym} '${r.type}@${r.api}' ${existing ? 'existing ' : ''}= {`;
    const body: string[] = [];
    if (r.parent) body.push(`  parent: ${r.parent.sym}`);
    if (r.scope) body.push(`  scope: ${r.scope.sym}`);
    body.push(`  name: ${bVal(r.name, scope, 1)}`);
    if (!existing) {
      for (const [k, v] of Object.entries(r.body)) if (v !== undefined) body.push(`  ${IDENT.test(k) ? k : bicepString(k)}: ${bVal(v, scope, 1)}`);
      const deps = (r.dependsOn ?? []).filter((x) => own.includes(x));
      if (deps.length > 0) body.push(`  dependsOn: [\n${deps.map((x) => `    ${x.sym}`).join('\n')}\n  ]`);
    }
    lines.push(head, ...body, '}', '');
  };
  // Existing declarations first (parents before children), then the module's own resources in order.
  const existing = [...foreign.filter((r) => !idParams.has(r)), ...own.filter((r) => r.existing)];
  const done = new Set<Res>();
  const declareExisting = (r: Res): void => {
    if (done.has(r)) return;
    if (r.parent && existing.includes(r.parent)) declareExisting(r.parent);
    done.add(r);
    decl(r, true);
  };
  for (const r of existing) declareExisting(r);
  for (const r of own) if (!r.existing) decl(r, false);
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

/** A module as an ARM template (its resources, its parameters). */
function moduleArm(d: Deployment, m: ModuleSpec): { template: Record<string, Json>; params: string[]; idParams: Map<Res, string> } {
  const own = d.of(m.name);
  const { params, foreign } = analyse(d, m);
  const idParams = new Map<Res, string>();
  if (m.resourceGroup) for (const r of foreign) if (!r.existing) idParams.set(r, `${r.sym}Id`);
  const parameters: Record<string, Json> = {};
  for (const p of params) {
    const spec = d.params.get(p) as ParamSpec;
    parameters[p] = { type: spec.secure ? `secure${spec.type}` : spec.type, metadata: { description: spec.description } };
  }
  for (const [r, p] of idParams) parameters[p] = { type: 'string', metadata: { description: `The id of ${r.sym}.` } };
  const resources: Json[] = [];
  for (const r of own) {
    if (r.existing) continue;
    const refs = new Set<Res>();
    const s: ArmScope = { idParams, refs };
    const chain = nameChain(r);
    const nameJson: Json = chain.length === 1
      ? aVal(chain[0], s)
      : `[${chain.every((x) => typeof x === 'string') ? armString((chain as string[]).join('/')) : `format(${armString(chain.map((_, i) => `{${i}}`).join('/'))}, ${chain.map((x) => aInner(x, s)).join(', ')})`}]`;
    const out: Record<string, Json> = { type: r.type, apiVersion: r.api, name: nameJson };
    if (r.scope) out.scope = `[${armStyleId(r.scope, (v) => aInner(v, s), armString)}]`;
    for (const [k, v] of Object.entries(r.body)) if (v !== undefined) out[k] = aVal(v, s);
    // Dependencies: what it refers to here, its parent, its scope and what it names explicitly.
    const deps = new Set<Res>([...refs, ...(r.parent ? [r.parent] : []), ...(r.scope ? [r.scope] : []), ...(r.dependsOn ?? [])]);
    const mine = [...deps].filter((x) => own.includes(x) && !x.existing && x !== r);
    if (mine.length > 0) out.dependsOn = mine.map((x) => `[${armStyleId(x, (v) => aInner(v, { idParams }), armString)}]`);
    resources.push(out);
  }
  return {
    template: {
      $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
      contentVersion: '1.0.0.0',
      parameters,
      resources,
    },
    params,
    idParams,
  };
}

const deploymentName = (d: Deployment, m: ModuleSpec): string => `${d.deploymentPrefix}-${m.name}`.slice(0, 64);

function mainBicep(d: Deployment, description: string): string {
  const lines: string[] = [`// ${description}`, '', "targetScope = 'resourceGroup'", ''];
  const used = new Set<string>();
  for (const m of d.modules) for (const p of analyse(d, m).params) used.add(p);
  for (const [name, spec] of d.params) if (used.has(name)) lines.push(paramDecl(name, spec, true), '');
  for (const m of d.modules) {
    const a = analyse(d, m);
    const sym = camel(m.name);
    lines.push(`module ${sym} 'modules/${m.name}.bicep' = {`);
    lines.push(`  name: ${bicepString(deploymentName(d, m))}`);
    if (m.resourceGroup) lines.push(`  scope: resourceGroup(${bicepString(m.resourceGroup)})`);
    const entries: string[] = a.params.map((p) => `    ${p}: ${p}`);
    if (m.resourceGroup) {
      for (const r of a.foreign) if (!r.existing) entries.push(`    ${r.sym}Id: ${bExpr(id(r), { local: new Set(), main: true })}`);
    }
    if (entries.length > 0) lines.push('  params: {', ...entries, '  }');
    if (a.dependsOn.length > 0) lines.push('  dependsOn: [', ...a.dependsOn.map((x) => `    ${camel(x)}`), '  ]');
    lines.push('}', '');
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function mainArm(d: Deployment, description: string): string {
  const used = new Set<string>();
  for (const m of d.modules) for (const p of analyse(d, m).params) used.add(p);
  const parameters: Record<string, Json> = {};
  for (const [name, spec] of d.params) {
    if (!used.has(name)) continue;
    const p: Record<string, Json> = { type: spec.secure ? `secure${spec.type}` : spec.type };
    if (spec.default !== undefined) p.defaultValue = aVal(spec.default, {});
    if (spec.allowed) p.allowedValues = [...spec.allowed];
    p.metadata = { description: spec.description };
    parameters[name] = p;
  }
  const resources: Json[] = [];
  for (const m of d.modules) {
    const a = analyse(d, m);
    const built = moduleArm(d, m);
    const params: Record<string, Json> = {};
    for (const p of built.params) params[p] = { value: `[parameters(${armString(p)})]` };
    for (const [r, p] of built.idParams) params[p] = { value: `[${aExpr(id(r), {})}]` };
    resources.push({
      type: 'Microsoft.Resources/deployments',
      apiVersion: api('Microsoft.Resources/deployments'),
      name: deploymentName(d, m),
      ...(m.resourceGroup ? { resourceGroup: m.resourceGroup } : {}),
      properties: {
        expressionEvaluationOptions: { scope: 'inner' },
        mode: 'Incremental',
        parameters: params,
        template: built.template,
      },
      ...(a.dependsOn.length > 0
        ? { dependsOn: a.dependsOn.map((x) => `[resourceId('Microsoft.Resources/deployments', ${armString(deploymentName(d, d.modules.find((y) => y.name === x) as ModuleSpec))})]`) }
        : {}),
    });
  }
  const doc = {
    $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
    contentVersion: '1.0.0.0',
    metadata: { description },
    parameters,
    resources,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function mainBicepparam(d: Deployment): string {
  const used = new Set<string>();
  for (const m of d.modules) for (const p of analyse(d, m).params) used.add(p);
  const lines = ["using 'main.bicep'", ''];
  for (const [name, spec] of d.params) {
    if (!used.has(name)) continue;
    if (spec.env) {
      lines.push(`// ${spec.description}${spec.secure ? ' A secret: set it in the environment from your vault, never here.' : ''}`);
      lines.push(`param ${name} = readEnvironmentVariable(${bicepString(spec.env)})`);
    } else if (spec.default !== undefined && !(spec.default instanceof E)) {
      lines.push(`// ${spec.description}`);
      lines.push(`param ${name} = ${bVal(spec.default, { local: new Set() }, 0)}`);
    } else continue;
    lines.push('');
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

// ---------------------------------------------------------------------------
// The builder of one Azure design
// ---------------------------------------------------------------------------

interface VNet {
  readonly net: NetworkDesign;
  readonly res: Res;
  /** tier → subnet name. */
  readonly tiers: Map<string, string>;
  /** Delegated or platform subnets by kind: GatewaySubnet, AzureBastionSubnet, sqlmi, postgres, mysql, dns-resolver, aadds, app:<id>. */
  readonly extra: Map<string, string>;
  readonly v6: boolean;
}

interface Build {
  readonly ctx: NativeCtx;
  readonly d: Deployment;
  readonly prefix: string;
  readonly cmk: boolean;
  readonly vnets: Map<string, VNet>;
  readonly location: E;
  readonly tags: (app?: string, env?: string, owner?: string, extra?: Record<string, Val>) => Record<string, Val>;
  lz?: {
    readonly law: Res;
    readonly kv: Res;
    readonly des?: Res;
    readonly uami: Res;
  };
  readonly vms: Map<string, { res: Res; kind: 'linux' | 'windows'; target: ComputeTarget }>;
  readonly dbRes: Map<string, { res: Res; metric: string }>;
  readonly zones: Map<string, Res>;
}

/** Subnets the landing zone carves after the tiers, in the order the Terraform landing zone carves them. */
interface Extra { readonly kind: string; readonly size: number; readonly delegation?: string }

const DELEGATION: Readonly<Record<string, string>> = {
  sqlmi: 'Microsoft.Sql/managedInstances',
  postgres: 'Microsoft.DBforPostgreSQL/flexibleServers',
  mysql: 'Microsoft.DBforMySQL/flexibleServers',
  'dns-resolver': 'Microsoft.Network/dnsResolvers',
  functions: 'Microsoft.App/environments',
  webapp: 'Microsoft.Web/serverFarms',
};

function v6Subnet(range48: string, i: number): string {
  const head = range48.split('::')[0] ?? range48;
  return i === 0 ? `${head}::/64` : `${head}:${i.toString(16)}::/64`;
}

/** Which extra subnets each network needs, from the design. */
function extrasFor(b: Build, n: NetworkDesign, hub: boolean): Extra[] {
  const { ctx } = b;
  const prefixLen = Number(n.subnets[0]?.cidr.split('/')[1] ?? 22);
  const delegated = Math.max(prefixLen, 24);
  const out: Extra[] = [];
  if (hub && ctx.pd.bastion === 'cloud-native' && ctx.scope !== 'apps') out.push({ kind: 'AzureBastionSubnet', size: 26 });
  if (hub && ctx.scope !== 'apps') out.push({ kind: 'GatewaySubnet', size: 27 });
  const add = (kind: string): void => {
    if (!out.some((x) => x.kind === kind)) out.push({ kind, size: delegated, ...(DELEGATION[kind] ? { delegation: DELEGATION[kind] } : {}) });
  };
  for (const t of ctx.databases) {
    if (dbNetwork(ctx, ctx.dbById.get(t.database)) !== n.name) continue;
    if (t.service === 'azure-sqlmi') add('sqlmi');
    if (t.service === 'azure-pg-flex') add('postgres');
    if (t.service === 'azure-mysql-flex') add('mysql');
  }
  if (hub && ctx.scope !== 'apps' && ctx.pd.identity.strategy !== 'none') add(ctx.pd.identity.strategy === 'managed-ad' ? 'aadds' : 'dns-resolver');
  for (const a of ctx.apps) {
    for (const c of a.components) {
      if (c.kind !== 'pattern' || (c.settings?.network?.trim() || 'prod') !== n.name) continue;
      if (c.tierPattern === 'serverless') out.push({ kind: `app:${c.id}`, size: Math.max(prefixLen, 26), delegation: DELEGATION.functions });
      if (c.tierPattern === 'paas-web') out.push({ kind: `app:${c.id}`, size: Math.max(prefixLen, 26), delegation: DELEGATION.webapp });
    }
  }
  return out;
}

interface NsgRule {
  readonly name: string;
  readonly proto: 'Tcp' | 'Udp' | 'Icmp' | '*';
  readonly ports: readonly string[];
  readonly from: readonly string[];
}

function tierNsgRules(plan: Plan, n: NetworkDesign, tier: string, cidrOf: (t: string) => string[], v6range: string | undefined, bastion: string | undefined): NsgRule[] {
  const has = (t: string): boolean => (n.tiers as readonly string[]).includes(t);
  const sites = siteSources(plan, n);
  const vnet = [n.cidr, ...(v6range ? [v6range] : [])];
  const rules: NsgRule[] = [];
  const adTcp = [...new Set(AD_PORTS.filter(([p]) => p === 'tcp').map(([, f, t]) => (f === t ? String(f) : `${f}-${t}`)))];
  const adUdp = [...new Set(AD_PORTS.filter(([p]) => p === 'udp').map(([, f, t]) => (f === t ? String(f) : `${f}-${t}`)))];
  rules.push({ name: 'ansible-from-site', proto: 'Tcp', ports: ['22', '5986'], from: sites });
  if (tier === 'mgmt') rules.push({ name: 'rdp-from-site', proto: 'Tcp', ports: ['3389'], from: sites });
  if (bastion) rules.push({ name: 'from-bastion', proto: 'Tcp', ports: ['22', '3389'], from: [bastion] });
  if (tier === 'web') rules.push({ name: 'https', proto: 'Tcp', ports: ['443'], from: [...sites, ...vnet] });
  if (tier === 'app' && has('web')) rules.push({ name: 'from-web', proto: 'Tcp', ports: ['*'], from: cidrOf('web') });
  if (tier === 'db') {
    if (has('app')) rules.push({ name: 'db-from-app', proto: 'Tcp', ports: DB_PORTS.map(String), from: cidrOf('app') });
    if (has('mgmt')) rules.push({ name: 'db-from-mgmt', proto: 'Tcp', ports: DB_PORTS.map(String), from: cidrOf('mgmt') });
    rules.push({ name: 'db-cluster', proto: '*', ports: ['*'], from: cidrOf('db') });
  }
  if (tier !== 'mgmt' && has('mgmt')) rules.push({ name: 'admin-from-mgmt', proto: 'Tcp', ports: ['22', '3389', '5986'], from: cidrOf('mgmt') });
  if (tier === 'mgmt') {
    rules.push({ name: 'ad-tcp', proto: 'Tcp', ports: adTcp, from: [...vnet, ...sites] });
    rules.push({ name: 'ad-udp', proto: 'Udp', ports: adUdp, from: [...vnet, ...sites] });
  }
  rules.push({ name: 'icmp', proto: 'Icmp', ports: ['*'], from: [...vnet, ...sites] });
  // One rule per family: an Azure rule's source prefixes may not mix IPv4 and IPv6.
  return rules.flatMap((r) => {
    const v4 = r.from.filter((c) => !isV6(c));
    const v6 = r.from.filter(isV6);
    return [...(v4.length > 0 ? [{ ...r, from: v4 }] : []), ...(v6.length > 0 ? [{ ...r, name: `${r.name}-v6`, from: v6 }] : [])];
  });
}

function nsgRulesJson(rules: readonly NsgRule[]): Val[] {
  let priority = 100;
  const out: Val[] = rules.map((r) => {
    const p = priority;
    priority += 10;
    return {
      name: r.name,
      properties: {
        priority: p,
        direction: 'Inbound',
        access: 'Allow',
        protocol: r.proto,
        sourcePortRange: '*',
        ...(r.ports.length === 1 ? { destinationPortRange: r.ports[0] } : { destinationPortRanges: [...r.ports] }),
        ...(r.from.length === 1 ? { sourceAddressPrefix: r.from[0] } : { sourceAddressPrefixes: [...r.from] }),
        destinationAddressPrefix: '*',
      },
    };
  });
  // Azure allows everything inside the virtual network by default (AllowVnetInBound); the tiers mean nothing until that is denied.
  out.push({ name: 'deny-vnet', properties: { priority: 4000, direction: 'Inbound', access: 'Deny', protocol: '*', sourcePortRange: '*', destinationPortRange: '*', sourceAddressPrefix: 'VirtualNetwork', destinationAddressPrefix: '*' } });
  return out;
}

// ---------------------------------------------------------------------------
// Landing zone
// ---------------------------------------------------------------------------

function landingZone(b: Build): void {
  const { d, ctx, prefix, location } = b;
  const M = d.module({ name: 'landing-zone', description: `${ctx.plan.name}: the Azure landing zone (${prefix}): virtual networks, a network security group per tier, NAT, keys, logs and the VM identity.` });
  const tags = b.tags();
  const law = d.add({
    sym: 'workspace', type: 'Microsoft.OperationalInsights/workspaces', module: M, name: `${prefix}-law`,
    body: { location, tags, properties: { sku: { name: 'PerGB2018' }, retentionInDays: Math.min(730, Math.max(30, ctx.pd.logRetentionDays)), features: { enableLogAccessUsingOnlyResourcePermissions: true } } },
  });
  const kv = d.add({
    sym: 'keyVault', type: 'Microsoft.KeyVault/vaults', module: M, name: str(`${prefix.slice(0, 10).replace(/-+$/, '')}-kv-`, SUFFIX),
    body: {
      location, tags,
      properties: {
        tenantId: raw('subscription().tenantId'),
        sku: { family: 'A', name: ctx.plan.requirements.keys === 'hsm' ? 'premium' : 'standard' },
        enableRbacAuthorization: true,
        enablePurgeProtection: true,
        enableSoftDelete: true,
        softDeleteRetentionInDays: 90,
        enabledForDiskEncryption: true,
        publicNetworkAccess: 'Enabled',
        networkAcls: { bypass: 'AzureServices', defaultAction: 'Allow' },
      },
    },
  });
  let des: Res | undefined;
  if (b.cmk) {
    const key = d.add({
      sym: 'diskKey', type: 'Microsoft.KeyVault/vaults/keys', module: M, parent: kv, name: `${prefix}-disks`,
      body: {
        tags,
        properties: {
          kty: ctx.plan.requirements.keys === 'hsm' ? 'RSA-HSM' : 'RSA',
          keySize: 3072,
          keyOps: ['unwrapKey', 'wrapKey', 'encrypt', 'decrypt'],
          attributes: { enabled: true },
          rotationPolicy: { attributes: { expiryTime: 'P2Y' }, lifetimeActions: [{ action: { type: 'rotate' }, trigger: { timeBeforeExpiry: 'P60D' } }, { action: { type: 'notify' }, trigger: { timeBeforeExpiry: 'P30D' } }] },
        },
      },
    });
    des = d.add({
      sym: 'diskEncryptionSet', type: 'Microsoft.Compute/diskEncryptionSets', module: M, name: `${prefix}-des`,
      body: {
        location, tags,
        identity: { type: 'SystemAssigned' },
        properties: { activeKey: { keyUrl: prop(key, 'properties.keyUri'), sourceVault: { id: id(kv) } }, encryptionType: 'EncryptionAtRestWithCustomerKey', rotationToLatestKeyVersionEnabled: true },
      },
    });
    d.add({
      sym: 'diskEncryptionSetKeyAccess', type: 'Microsoft.Authorization/roleAssignments', module: M, scope: kv,
      name: call('guid', id(kv), id(des), 'e147488a-f6f5-4113-8e2d-b22465e65bf6'),
      body: {
        properties: {
          roleDefinitionId: raw("subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'e147488a-f6f5-4113-8e2d-b22465e65bf6')"),
          principalId: prop(des, 'identity.principalId'),
          principalType: 'ServicePrincipal',
          description: 'The disk encryption set reads the disk key (Key Vault Crypto Service Encryption User).',
        },
      },
    });
  }
  const uami = d.add({ sym: 'vmIdentity', type: 'Microsoft.ManagedIdentity/userAssignedIdentities', module: M, name: `${prefix}-vm-identity`, body: { location, tags, properties: {} } });
  b.lz = { law, kv, ...(des ? { des } : {}), uami };

  // Networks.
  const hub = ctx.pd.networks.find((n) => n.name === 'prod') ?? ctx.pd.networks[0];
  const flowStorage = d.add({
    sym: 'flowLogStorage', type: 'Microsoft.Storage/storageAccounts', module: M, name: call('take', str(`${prefix.replace(/[^a-z0-9]/g, '').slice(0, 10)}fl`, SUFFIX), 24),
    body: {
      location, tags, kind: 'StorageV2', sku: { name: 'Standard_ZRS' },
      properties: { minimumTlsVersion: 'TLS1_2', supportsHttpsTrafficOnly: true, allowBlobPublicAccess: false, allowSharedKeyAccess: false, publicNetworkAccess: 'Enabled', networkAcls: { bypass: 'AzureServices', defaultAction: 'Allow' } },
    },
  });
  for (const n of ctx.pd.networks) {
    const isHub = n === hub;
    const N = camel(n.name);
    const netTags = b.tags(undefined, n.envs.join(' '), undefined, { atk_network: n.name });
    const prefixLen = Number(n.subnets[0]?.cidr.split('/')[1] ?? 22);
    const extras = extrasFor(b, n, isHub);
    const cidrs = carve(n.cidr, [...n.tiers.map(() => prefixLen), ...extras.map((x) => x.size)]);
    if (!cidrs) {
      ctx.findings.push(warning('plan.native.azure-carve', `${n.name}: ${n.tiers.length + extras.length} subnets do not fit in ${n.cidr}; the network is left out.`));
      continue;
    }
    const v6range = n.ipv6 ? (n.ipv6Cidr ?? ulaFor(`${prefix}/${n.name}`)) : undefined;
    const tierCidr = new Map<string, { v4: string; v6?: string }>();
    n.tiers.forEach((t, i) => tierCidr.set(t, { v4: cidrs[i] as string, ...(v6range ? { v6: v6Subnet(v6range, i) } : {}) }));
    const cidrOf = (t: string): string[] => { const c = tierCidr.get(t); return c ? [c.v4, ...(c.v6 ? [c.v6] : [])] : []; };
    const bastionCidr = extras.findIndex((x) => x.kind === 'AzureBastionSubnet');
    const bastion = bastionCidr >= 0 ? cidrs[n.tiers.length + bastionCidr] : undefined;
    const nsgs = new Map<string, Res>();
    for (const t of n.tiers) {
      nsgs.set(t, d.add({
        sym: camel('nsg', n.name, t), type: 'Microsoft.Network/networkSecurityGroups', module: M, name: `${prefix}-${n.name}-${t}-nsg`,
        body: { location, tags: { ...netTags, atk_tier: t }, properties: { securityRules: nsgRulesJson(tierNsgRules(ctx.plan, n, t, cidrOf, v6range, bastion)) } },
      }));
    }
    const pip = d.add({
      sym: camel('natIp', n.name), type: 'Microsoft.Network/publicIPAddresses', module: M, name: `${prefix}-${n.name}-nat-pip`,
      body: { location, tags: netTags, sku: { name: 'Standard', tier: 'Regional' }, zones: ['1', '2', '3'], properties: { publicIPAllocationMethod: 'Static', publicIPAddressVersion: 'IPv4' } },
    });
    const nat = d.add({
      sym: camel('nat', n.name), type: 'Microsoft.Network/natGateways', module: M, name: `${prefix}-${n.name}-nat`,
      body: { location, tags: netTags, sku: { name: 'Standard' }, properties: { idleTimeoutInMinutes: 4, publicIpAddresses: [{ id: id(pip) }] } },
    });
    const tiers = new Map<string, string>();
    const extra = new Map<string, string>();
    const subnets: Val[] = [];
    for (const t of n.tiers) {
      const c = tierCidr.get(t) as { v4: string; v6?: string };
      const name = `${prefix}-${n.name}-${t}`;
      tiers.set(t, name);
      subnets.push({
        name,
        properties: {
          ...(c.v6 ? { addressPrefixes: [c.v4, c.v6] } : { addressPrefix: c.v4 }),
          networkSecurityGroup: { id: id(nsgs.get(t) as Res) },
          natGateway: { id: id(nat) },
          defaultOutboundAccess: false,
          privateEndpointNetworkPolicies: 'Enabled',
        },
      });
    }
    const special: Res[] = [];
    extras.forEach((x, i) => {
      const cidr = cidrs[n.tiers.length + i] as string;
      const name = x.kind === 'AzureBastionSubnet' || x.kind === 'GatewaySubnet' ? x.kind : `${prefix}-${n.name}-${x.kind.startsWith('app:') ? kebab(x.kind.slice(4).replace(/^c:/, '')) : x.kind}`;
      extra.set(x.kind, name);
      const props: Record<string, Val> = { addressPrefix: cidr, defaultOutboundAccess: false };
      if (x.delegation) props.delegations = [{ name: x.delegation.split('/').pop() as string, properties: { serviceName: x.delegation } }];
      if (x.kind === 'sqlmi') {
        // A managed instance's subnet carries a security group and a route table; the service adds its own rules to both.
        const nsg = d.add({ sym: camel('nsg', n.name, 'sqlmi'), type: 'Microsoft.Network/networkSecurityGroups', module: M, name: `${prefix}-${n.name}-sqlmi-nsg`, body: { location, tags: netTags, properties: { securityRules: [] } } });
        const rt = d.add({ sym: camel('routes', n.name, 'sqlmi'), type: 'Microsoft.Network/routeTables', module: M, name: `${prefix}-${n.name}-sqlmi-rt`, body: { location, tags: netTags, properties: { disableBgpRoutePropagation: false } } });
        props.networkSecurityGroup = { id: id(nsg) };
        props.routeTable = { id: id(rt) };
        special.push(nsg, rt);
      }
      if (x.kind === 'aadds') {
        const nsg = d.add({
          sym: camel('nsg', n.name, 'aadds'), type: 'Microsoft.Network/networkSecurityGroups', module: M, name: `${prefix}-${n.name}-aadds-nsg`,
          body: {
            location, tags: netTags,
            properties: {
              securityRules: [
                { name: 'AllowSyncWithAzureAD', properties: { priority: 101, direction: 'Inbound', access: 'Allow', protocol: 'Tcp', sourcePortRange: '*', destinationPortRange: '443', sourceAddressPrefix: 'AzureActiveDirectoryDomainServices', destinationAddressPrefix: '*' } },
                { name: 'AllowPSRemoting', properties: { priority: 301, direction: 'Inbound', access: 'Allow', protocol: 'Tcp', sourcePortRange: '*', destinationPortRange: '5986', sourceAddressPrefix: 'AzureActiveDirectoryDomainServices', destinationAddressPrefix: '*' } },
              ],
            },
          },
        });
        props.networkSecurityGroup = { id: id(nsg) };
      }
      subnets.push({ name, properties: props });
    });
    const vnet = d.add({
      sym: camel('vnet', n.name), type: 'Microsoft.Network/virtualNetworks', module: M, name: `${prefix}-${n.name}-vnet`,
      body: {
        location, tags: netTags,
        properties: { addressSpace: { addressPrefixes: [n.cidr, ...(v6range ? [v6range] : [])] }, subnets },
      },
    });
    void special;
    d.add({
      sym: camel('vnetLogs', n.name), type: 'Microsoft.Insights/diagnosticSettings', module: M, scope: vnet, name: 'to-log-analytics',
      body: { properties: { workspaceId: id(law), logs: [{ categoryGroup: 'allLogs', enabled: true }], metrics: [{ category: 'AllMetrics', enabled: true }] } },
    });
    b.vnets.set(n.name, { net: n, res: vnet, tiers, extra, v6: !!v6range });
    if (isHub && ctx.pd.bastion === 'cloud-native' && extra.has('AzureBastionSubnet')) {
      const bip = d.add({
        sym: 'bastionIp', type: 'Microsoft.Network/publicIPAddresses', module: M, name: `${prefix}-bastion-pip`,
        body: { location, tags, sku: { name: 'Standard', tier: 'Regional' }, zones: ['1', '2', '3'], properties: { publicIPAllocationMethod: 'Static', publicIPAddressVersion: 'IPv4' } },
      });
      d.add({
        sym: 'bastion', type: 'Microsoft.Network/bastionHosts', module: M, name: `${prefix}-bastion`,
        body: {
          location, tags, sku: { name: 'Standard' },
          properties: { enableTunneling: true, ipConfigurations: [{ name: 'bastion', properties: { subnet: { id: subnetId(vnet, 'AzureBastionSubnet') }, publicIPAddress: { id: id(bip) } } }] },
        },
      });
    }
  }
  if (b.vnets.size > 0 && ctx.scope !== 'apps') {
    // VNet flow logs: through the region's network watcher, which Azure creates in NetworkWatcherRG with the first virtual network.
    const F = d.module({ name: 'flow-logs', description: 'VNet flow logs, through the region\'s network watcher in NetworkWatcherRG (Azure creates it with the first virtual network).', resourceGroup: 'NetworkWatcherRG' });
    const watcher = d.add({ sym: 'networkWatcher', type: 'Microsoft.Network/networkWatchers', module: F, existing: true, name: str('NetworkWatcher_', location), body: {} });
    for (const v of b.vnets.values()) {
      d.add({
        sym: camel('flowLog', v.net.name), type: 'Microsoft.Network/networkWatchers/flowLogs', module: F, parent: watcher, name: `${prefix}-${v.net.name}-flow`,
        body: {
          location, tags,
          properties: {
            targetResourceId: id(v.res),
            storageId: id(flowStorage),
            enabled: true,
            format: { type: 'JSON', version: 2 },
            retentionPolicy: { enabled: true, days: Math.min(365, ctx.pd.logRetentionDays) },
            flowAnalyticsConfiguration: { networkWatcherFlowAnalyticsConfiguration: { enabled: true, workspaceResourceId: id(law), trafficAnalyticsInterval: 10 } },
          },
        },
      });
    }
  }
  if (ctx.plan.requirements.keys === 'hsm') {
    ctx.findings.push(info('plan.native.azure-hsm', 'The disk key is RSA-HSM in a Premium vault (HSM-protected), as in the Terraform landing zone.'));
  }
}

// ---------------------------------------------------------------------------
// Identity, connectivity, relocation
// ---------------------------------------------------------------------------

function onPremDcAddresses(plan: Plan): string[] {
  const out = plan.workloads.filter((w) => w.role === 'ad-dc').flatMap((w) => w.facts?.ipAddresses ?? []).filter((a) => /^[0-9.]+$/.test(a));
  return [...new Set(out)];
}

function identity(b: Build): void {
  const { d, ctx, prefix, location } = b;
  const strategy = ctx.pd.identity.strategy;
  if (strategy === 'none') return;
  const hub = b.vnets.get('prod') ?? [...b.vnets.values()][0];
  if (!hub) return;
  const domain = ctx.plan.requirements.identity.domain?.trim() || 'corp.example.com';
  const M = d.module({ name: 'identity', description: `${ctx.plan.name}: ${strategy === 'managed-ad' ? 'Microsoft Entra Domain Services' : 'DNS forwarding'} for ${domain}.` });
  const tags = b.tags();
  if (strategy === 'managed-ad') {
    const subnet = hub.extra.get('aadds');
    if (!subnet) return;
    d.add({
      sym: 'domainServices', type: 'Microsoft.AAD/domainServices', module: M, name: domain,
      body: {
        location, tags,
        properties: {
          domainName: domain,
          sku: 'Enterprise',
          filteredSync: 'Disabled',
          replicaSets: [{ location, subnetId: subnetId(hub.res, subnet) }],
          domainSecuritySettings: { ntlmV1: 'Disabled', tlsV1: 'Disabled', syncNtlmPasswords: 'Disabled', kerberosRc4Encryption: 'Disabled' },
        },
      },
    });
    return;
  }
  const dcs = onPremDcAddresses(ctx.plan);
  const subnet = hub.extra.get('dns-resolver');
  if (dcs.length === 0 || !subnet) {
    ctx.findings.push(warning('plan.native.identity-no-dc-addresses', 'Azure: DNS forwarding to the domain controllers needs their addresses, and no ad-dc workload has one, so it is left out.'));
    return;
  }
  const resolver = d.add({ sym: 'dnsResolver', type: 'Microsoft.Network/dnsResolvers', module: M, name: `${prefix}-resolver`, body: { location, tags, properties: { virtualNetwork: { id: id(hub.res) } } } });
  const outbound = d.add({
    sym: 'dnsResolverOutbound', type: 'Microsoft.Network/dnsResolvers/outboundEndpoints', module: M, parent: resolver, name: 'outbound',
    body: { location, tags, properties: { subnet: { id: subnetId(hub.res, subnet) } } },
  });
  const ruleset = d.add({
    sym: 'dnsForwarding', type: 'Microsoft.Network/dnsForwardingRulesets', module: M, name: `${prefix}-forwarding`,
    body: { location, tags, properties: { dnsResolverOutboundEndpoints: [{ id: id(outbound) }] } },
  });
  d.add({
    sym: 'dnsForwardDomain', type: 'Microsoft.Network/dnsForwardingRulesets/forwardingRules', module: M, parent: ruleset, name: kebab(domain),
    body: { properties: { domainName: `${domain}.`, forwardingRuleState: 'Enabled', targetDnsServers: dcs.map((ip) => ({ ipAddress: ip, port: 53 })) } },
  });
  for (const v of b.vnets.values()) {
    d.add({
      sym: camel('dnsForwardingLink', v.net.name), type: 'Microsoft.Network/dnsForwardingRulesets/virtualNetworkLinks', module: M, parent: ruleset, name: `link-${v.net.name}`,
      body: { properties: { virtualNetwork: { id: id(v.res) } } },
    });
  }
}

function connectivity(b: Build): void {
  const { d, ctx, prefix, location } = b;
  const hub = b.vnets.get('prod') ?? [...b.vnets.values()][0];
  if (!hub) return;
  const spokes = [...b.vnets.values()].filter((v) => v !== hub);
  const sites = ctx.pd.connectivity.map((c) => ({ c, site: ctx.plan.requirements.sites.find((s) => s.name === c.site) })).filter((x) => x.site);
  if (sites.length === 0 && spokes.length === 0) return;
  const M = d.module({ name: 'connectivity', description: `${ctx.plan.name}: site-to-site VPN and ExpressRoute to on-premises, and the peerings to the hub.` });
  const tags = b.tags();
  const gatewaySubnet = hub.extra.has('GatewaySubnet') ? subnetId(hub.res, 'GatewaySubnet') : undefined;
  const asn = ctx.pd.connectivity[0]?.cloudAsn ?? 65515;
  const vpnSites = sites.filter(({ c, site }) => c.method !== 'circuit' && site?.vpnPeer);
  let vng: Res | undefined;
  if (vpnSites.length > 0 && gatewaySubnet) {
    const ips = [1, 2].map((i) => d.add({
      sym: `vpnGatewayIp${i}`, type: 'Microsoft.Network/publicIPAddresses', module: M, name: `${prefix}-vpngw-pip-${i}`,
      body: { location, tags, sku: { name: 'Standard', tier: 'Regional' }, zones: ['1', '2', '3'], properties: { publicIPAllocationMethod: 'Static', publicIPAddressVersion: 'IPv4' } },
    }));
    const vngName = `${prefix}-vpngw`;
    vng = d.add({
      sym: 'vpnGateway', type: 'Microsoft.Network/virtualNetworkGateways', module: M, name: vngName,
      body: {
        location, tags,
        properties: {
          gatewayType: 'Vpn',
          vpnType: 'RouteBased',
          vpnGatewayGeneration: 'Generation2',
          sku: { name: 'VpnGw2AZ', tier: 'VpnGw2AZ' },
          activeActive: true,
          enableBgp: true,
          ipConfigurations: ips.map((ip, i) => ({ name: `gw${i + 1}`, properties: { subnet: { id: gatewaySubnet }, publicIPAddress: { id: id(ip) }, privateIPAllocationMethod: 'Dynamic' } })),
          bgpSettings: {
            asn,
            bgpPeeringAddresses: [1, 2].map((i) => ({ ipconfigurationId: str(rid('Microsoft.Network/virtualNetworkGateways', vngName), `/ipConfigurations/gw${i}`), customBgpIpAddresses: [`169.254.2${i}.1`] })),
          },
        },
      },
    });
    vpnSites.forEach(({ site }, i) => {
      if (!site) return;
      const S = camel(site.name);
      const lng = d.add({
        sym: `${S}Gateway`, type: 'Microsoft.Network/localNetworkGateways', module: M, name: `${prefix}-${kebab(site.name)}`,
        body: { location, tags, properties: { gatewayIpAddress: site.vpnPeer, bgpSettings: { asn: site.bgpAsn ?? 65000, bgpPeeringAddress: `169.254.21.${4 * i + 2}` } } },
      });
      const key = d.param(`vpnSharedKey${camel(site.name).replace(/^./, (c) => c.toUpperCase())}`, {
        type: 'string', secure: true, env: `VPN_SHARED_KEY_${site.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`,
        description: `The IPsec shared key of the connection to ${site.name} (the same on the on-premises peer).`,
      });
      d.add({
        sym: `${S}Connection`, type: 'Microsoft.Network/connections', module: M, name: `${prefix}-${kebab(site.name)}`,
        body: {
          location, tags,
          properties: {
            connectionType: 'IPsec',
            virtualNetworkGateway1: { id: id(vng as Res), properties: {} },
            localNetworkGateway2: { id: id(lng), properties: {} },
            sharedKey: key,
            connectionProtocol: 'IKEv2',
            enableBgp: true,
          },
        },
      });
    });
  }
  const circuits = sites.filter(({ c }) => c.method !== 'vpn');
  if (circuits.length > 0 && gatewaySubnet) {
    const erIp = d.add({
      sym: 'erGatewayIp', type: 'Microsoft.Network/publicIPAddresses', module: M, name: `${prefix}-ergw-pip`,
      body: { location, tags, sku: { name: 'Standard', tier: 'Regional' }, zones: ['1', '2', '3'], properties: { publicIPAllocationMethod: 'Static', publicIPAddressVersion: 'IPv4' } },
    });
    const erGw = d.add({
      sym: 'erGateway', type: 'Microsoft.Network/virtualNetworkGateways', module: M, name: `${prefix}-ergw`,
      body: {
        location, tags,
        properties: {
          gatewayType: 'ExpressRoute',
          sku: { name: 'ErGw1AZ', tier: 'ErGw1AZ' },
          ipConfigurations: [{ name: 'default', properties: { subnet: { id: gatewaySubnet }, publicIPAddress: { id: id(erIp) }, privateIPAllocationMethod: 'Dynamic' } }],
        },
      },
      ...(vng ? { dependsOn: [vng] } : {}),
    });
    for (const { site } of circuits) {
      if (!site) continue;
      const S = camel(site.name).replace(/^./, (c) => c.toUpperCase());
      const circuit = d.param(`expressRouteCircuitId${S}`, { type: 'string', env: `EXPRESSROUTE_CIRCUIT_ID_${site.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`, description: `The resource id of the ExpressRoute circuit to ${site.name} (the provider provisions it).` });
      const auth = d.param(`expressRouteAuthorizationKey${S}`, { type: 'string', secure: true, env: `EXPRESSROUTE_AUTH_KEY_${site.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`, description: `The authorization key of the ExpressRoute circuit to ${site.name}.` });
      d.add({
        sym: `${camel(site.name)}ErConnection`, type: 'Microsoft.Network/connections', module: M, name: `${prefix}-${kebab(site.name)}-er`,
        body: { location, tags, properties: { connectionType: 'ExpressRoute', virtualNetworkGateway1: { id: id(erGw), properties: {} }, peer: { id: circuit }, authorizationKey: auth, routingWeight: 10 } },
      });
    }
  }
  for (const s of spokes) {
    d.add({
      sym: camel('peering', hub.net.name, s.net.name), type: 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings', module: M, parent: hub.res, name: `to-${s.net.name}`,
      body: { properties: { remoteVirtualNetwork: { id: id(s.res) }, allowVirtualNetworkAccess: true, allowForwardedTraffic: true, allowGatewayTransit: !!vng } },
      ...(vng ? { dependsOn: [vng] } : {}),
    });
    d.add({
      sym: camel('peering', s.net.name, hub.net.name), type: 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings', module: M, parent: s.res, name: `to-${hub.net.name}`,
      body: { properties: { remoteVirtualNetwork: { id: id(hub.res) }, allowVirtualNetworkAccess: true, allowForwardedTraffic: true, useRemoteGateways: !!vng } },
      ...(vng ? { dependsOn: [vng] } : {}),
    });
  }
}

function relocate(b: Build): void {
  const { d, ctx, prefix, location } = b;
  const r = ctx.pd.relocate;
  if (!r || r.nodes <= 0) return;
  const nodes = Math.min(16, Math.max(3, r.nodes));
  const used = [...ctx.pd.networks.map((n) => n.cidr), ...ctx.plan.requirements.sites.flatMap((s) => s.cidrs)];
  let block: string | undefined;
  for (let o = 200; o < 456 && !block; o += 1) {
    const c = `10.${o % 256}.0.0/22`;
    if (!used.some((u) => !isV6(u) && overlaps(c, u))) block = c;
  }
  if (!block) return;
  const M = d.module({ name: 'relocate', description: `${ctx.plan.name}: ${r.service} for the VMs that relocate with HCX.` });
  d.add({
    sym: 'privateCloud', type: 'Microsoft.AVS/privateClouds', module: M, name: `${prefix}-avs`,
    body: { location, tags: b.tags(), sku: { name: 'av36p' }, properties: { managementCluster: { clusterSize: nodes }, networkBlock: block, internet: 'Disabled' } },
  });
  if (nodes !== r.nodes) ctx.findings.push(info('plan.native.relocate-nodes', `${r.service}: the estimate of ${r.nodes} hosts is written as ${nodes}, the range the first cluster takes.`));
}

function v4Int(a: string): number {
  return a.split('.').reduce((n, o) => n * 256 + Number(o), 0);
}

function overlaps(a: string, b2: string): boolean {
  const [ab = '', ap = '32'] = a.split('/');
  const [bb = '', bp = '32'] = b2.split('/');
  const size = (p: string): number => 2 ** (32 - Number(p));
  const as = v4Int(ab) - (v4Int(ab) % size(ap));
  const bs = v4Int(bb) - (v4Int(bb) % size(bp));
  return as < bs + size(bp) && bs < as + size(ap);
}

// ---------------------------------------------------------------------------
// Compute
// ---------------------------------------------------------------------------

const LICENCE_TYPE: Readonly<Record<string, string>> = { ahb: 'Windows_Server', 'rhel-byos': 'RHEL_BYOS', 'sles-byos': 'SLES_BYOS' };

function compute(b: Build): void {
  const { d, ctx, prefix, location } = b;
  for (const vm of ctx.replicated) {
    ctx.findings.push(info('plan.native.azure-replicated', `${vmName(ctx, vm)}: Azure Migrate creates it at cutover, so the template does not.`));
  }
  if (ctx.replicated.length > 0) {
    terraformOnly(ctx, 'Adopting replicated VMs after cutover', 'Azure Migrate creates them; the Terraform stack adopts them with import blocks (cutover_instance_ids) and then backs them up and monitors them. A deployment cannot adopt a resource it did not declare, so protect and monitor them once they exist (or redeploy with them declared).');
  }
  if (ctx.rebuilt.length === 0 || !b.lz) return;
  const M = d.module({ name: 'compute', description: `${ctx.plan.name}: the VMs built from an image (Trusted Launch, platform patching, dual-stack NICs, customer-managed disk encryption, the bootstrap without secrets).` });
  const mgmt = mgmtCidrs(ctx.plan, ctx.pd);
  const windowsCommand = `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${utf16leBase64(winrmLines(mgmt).join('\n'))}`;
  for (const vm of ctx.rebuilt) {
    const w = workloadOf(ctx, vm);
    const name = vmName(ctx, vm);
    const v = b.vnets.get(vm.network) ?? [...b.vnets.values()][0];
    const subnet = v?.tiers.get(vm.tier);
    if (!v || !subnet) {
      ctx.findings.push(warning('plan.native.azure-vm-tier', `${name}: the ${vm.network} network has no ${vm.tier} tier, so the VM is left out.`));
      continue;
    }
    if (vm.dedicatedHost) {
      terraformOnly(ctx, `${name} on a dedicated host`, 'dedicated host groups and hosts are sized to the licences they carry, which the Terraform compute item does per host SKU; the VM is left out here.');
      continue;
    }
    const kind = osKindOf(w?.os);
    const tags = { ...b.tags(w?.app, w?.env, w ? ctx.appByName.get(w.app)?.owner : undefined), ...vmTags(ctx, vm, 'rebuild') };
    const sym = camel('vm', name);
    const nic = d.add({
      sym: `${sym}Nic`, type: 'Microsoft.Network/networkInterfaces', module: M, name: `${name}-nic`,
      body: {
        location, tags,
        properties: {
          enableAcceleratedNetworking: true,
          ipConfigurations: [
            { name: 'ipv4', properties: { primary: true, subnet: { id: subnetId(v.res, subnet) }, privateIPAllocationMethod: 'Dynamic', privateIPAddressVersion: 'IPv4' } },
            ...(v.v6 ? [{ name: 'ipv6', properties: { subnet: { id: subnetId(v.res, subnet) }, privateIPAllocationMethod: 'Dynamic', privateIPAddressVersion: 'IPv6' } }] : []),
          ],
        },
      },
    });
    const img = vm.image;
    let imageReference: Val;
    if (img.kind === 'azure-marketplace') {
      imageReference = { publisher: img.publisher, offer: img.offer, sku: img.sku, version: 'latest' };
      if (img.plan) ctx.findings.push(info('plan.native.azure-image-plan', `${name}: its marketplace image (${img.publisher}:${img.offer}:${img.sku}) needs its terms accepted once per subscription (az vm image terms accept) before the deployment.`));
    } else {
      const pname = `image${camel(img.kind === 'custom' ? img.variable : name).replace(/^./, (c) => c.toUpperCase())}`;
      imageReference = { id: d.param(pname, { type: 'string', env: pname.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase(), description: `The image id (gallery image version or managed image) for ${name} (${w?.os ?? 'unknown'}).` }) };
    }
    const disk = (type: string): Val => ({
      storageAccountType: type === 'PremiumV2_LRS' ? 'Premium_LRS' : type,
      ...(b.lz?.des ? { diskEncryptionSet: { id: id(b.lz.des) } } : {}),
    });
    const [boot, ...data] = vm.disks;
    const licence = LICENCE_TYPE[/Hybrid|ahb/i.test(vm.licenceHandling) ? 'ahb' : /RHEL/i.test(vm.licenceHandling) && /BYOS/i.test(vm.licenceHandling) ? 'rhel-byos' : /SLES/i.test(vm.licenceHandling) && /BYOS/i.test(vm.licenceHandling) ? 'sles-byos' : ''];
    const computerName = kind === 'windows' ? name.slice(0, 15) : kebab(name).slice(0, 63) || 'host';
    const adminUser = kind === 'windows'
      ? d.param('windowsAdminUsername', { type: 'string', default: 'azureadmin', description: 'The local administrator of the Windows VMs (Ansible replaces it with the domain\'s).' })
      : d.param('linuxAdminUsername', { type: 'string', default: 'ansible', description: 'The administrator of the Linux VMs: the ansible user, key only.' });
    const cloudInit = `${cloudInitLines(computerName, '__KEY__').join('\n')}\n`.split('__KEY__');
    const osProfile: Record<string, Val> = kind === 'windows'
      ? {
        computerName,
        adminUsername: adminUser,
        adminPassword: d.param('windowsAdminPassword', { type: 'string', secure: true, env: 'WINDOWS_ADMIN_PASSWORD', description: 'The local administrator password of the Windows VMs (Azure requires one at create; Ansible replaces it with the domain\'s).' }),
        windowsConfiguration: { provisionVMAgent: true, enableAutomaticUpdates: true, patchSettings: { patchMode: 'AutomaticByPlatform', assessmentMode: 'AutomaticByPlatform' } },
      }
      : {
        computerName,
        adminUsername: adminUser,
        customData: call('base64', str(cloudInit[0] as string, d.param('sshPublicKey', { type: 'string', env: 'SSH_PUBLIC_KEY', description: 'The SSH public key of the ansible user on every Linux VM (a public key, not a secret).' }), cloudInit[1] as string)),
        linuxConfiguration: {
          disablePasswordAuthentication: true,
          provisionVMAgent: true,
          ssh: { publicKeys: [{ path: str('/home/', adminUser, '/.ssh/authorized_keys'), keyData: P('sshPublicKey') }] },
          patchSettings: { patchMode: 'AutomaticByPlatform', assessmentMode: 'AutomaticByPlatform' },
        },
      };
    const res = d.add({
      sym, type: 'Microsoft.Compute/virtualMachines', module: M, name,
      body: {
        location, tags,
        zones: [vm.zone || String(zoneIndexOf(ctx.pd, vm) + 1)],
        identity: { type: 'SystemAssigned, UserAssigned', userAssignedIdentities: new Dict([[id(b.lz.uami), {}]]) },
        properties: {
          hardwareProfile: { vmSize: vm.size },
          storageProfile: {
            imageReference,
            osDisk: { name: `${name}-os`, createOption: 'FromImage', caching: 'ReadWrite', diskSizeGB: boot?.gib ?? 128, managedDisk: disk(boot?.type ?? 'Premium_LRS'), deleteOption: 'Delete' },
            dataDisks: data.map((x, i) => ({
              lun: i, name: `${name}-data${i + 1}`, createOption: 'Empty', diskSizeGB: x.gib,
              caching: x.type === 'PremiumV2_LRS' || x.type.startsWith('Ultra') ? 'None' : 'ReadOnly',
              managedDisk: { storageAccountType: x.type, ...(b.lz?.des ? { diskEncryptionSet: { id: id(b.lz.des) } } : {}) },
              deleteOption: 'Detach',
            })),
          },
          osProfile,
          networkProfile: { networkInterfaces: [{ id: id(nic), properties: { primary: true, deleteOption: 'Delete' } }] },
          securityProfile: { securityType: 'TrustedLaunch', uefiSettings: { secureBootEnabled: true, vTpmEnabled: true } },
          diagnosticsProfile: { bootDiagnostics: { enabled: true } },
          ...(licence ? { licenseType: licence } : {}),
        },
      },
    });
    b.vms.set(name, { res, kind, target: vm });
    if (kind === 'windows') {
      d.add({
        sym: `${sym}Winrm`, type: 'Microsoft.Compute/virtualMachines/extensions', module: M, parent: res, name: 'winrm-bootstrap',
        body: {
          location, tags,
          properties: {
            publisher: 'Microsoft.Compute', type: 'CustomScriptExtension', typeHandlerVersion: '1.10', autoUpgradeMinorVersion: true,
            // An encoded command: the script needs no file, and no quoting survives three shells.
            protectedSettings: { commandToExecute: windowsCommand },
          },
        },
      });
    }
    if (vm.coreCount) ctx.findings.push(info('plan.native.azure-cores', `${name}: Azure limits active cores with a constrained size (e.g. Standard_E16-8ds_v5) rather than a core count; use one in the design.`));
  }
}

// ---------------------------------------------------------------------------
// Databases
// ---------------------------------------------------------------------------

const SQL_TIERS: Readonly<Record<string, string>> = { GP: 'GeneralPurpose', BC: 'BusinessCritical', HS: 'Hyperscale' };
const FLEX_TIERS: Readonly<Record<string, string>> = { GP: 'GeneralPurpose', MO: 'MemoryOptimized', B: 'Burstable' };
const PG_STORAGE_GB = [32, 64, 128, 256, 512, 1024, 2048, 4095, 4096, 8192, 16384, 32767];

function sqlSku(cls: string): Record<string, Val> {
  const m = /^(GP|BC|HS)(_S)?_(Gen\d+|[A-Za-z0-9]+)_(\d+)$/.exec(cls);
  if (!m) return { name: 'GP_Gen5', tier: 'GeneralPurpose', family: 'Gen5', capacity: 8 };
  return { name: `${m[1]}${m[2] ?? ''}_${m[3]}`, tier: SQL_TIERS[m[1] as string] as string, family: m[3] as string, capacity: Number(m[4]) };
}

function flexSku(cls: string, fallback: string): Record<string, Val> {
  const m = /^(GP|MO|B)_(.+)$/.exec(cls || fallback) ?? /^(GP|MO|B)_(.+)$/.exec(fallback);
  return { name: (m?.[2] ?? 'Standard_D2ds_v5') as string, tier: FLEX_TIERS[m?.[1] ?? 'GP'] as string };
}

/** A private DNS zone linked to every network: one per deployment, in the first module that needs it. */
function privateZone(b: Build, M: string, key: string, dns: Val): Res {
  const got = b.zones.get(key);
  if (got) return got;
  const z = b.d.add({ sym: camel('dnsZone', key), type: 'Microsoft.Network/privateDnsZones', module: M, name: dns, body: { location: 'global', tags: b.tags(), properties: {} } });
  for (const v of b.vnets.values()) {
    b.d.add({
      sym: camel('dnsZone', key, 'link', v.net.name), type: 'Microsoft.Network/privateDnsZones/virtualNetworkLinks', module: M, parent: z, name: `link-${v.net.name}`,
      body: { location: 'global', tags: b.tags(), properties: { virtualNetwork: { id: id(v.res) }, registrationEnabled: false } },
    });
  }
  b.zones.set(key, z);
  return z;
}

function databases(b: Build): void {
  const { d, ctx, prefix, location } = b;
  const managed = ctx.databases.filter((t) => !isIaasService(t.service) || t.service === 'azure-sqlvm');
  if (managed.length === 0) return;
  const M = d.module({ name: 'databases', description: `${ctx.plan.name}: the managed databases (Entra ID authentication only, private networking, TLS 1.2+).` });
  const zone = (key: string, dns: Val): Res => privateZone(b, M, key, dns);
  const groupId = (): E => d.param('dbAdminGroupObjectId', { type: 'string', env: 'DB_ADMIN_GROUP_OBJECT_ID', description: 'The object id of the Entra ID group that administers every database.' });
  const groupName = (): E => d.param('dbAdminGroupName', { type: 'string', default: 'db-admins', description: 'The name of the Entra ID group that administers every database.' });
  for (const t of managed) {
    const db = ctx.dbById.get(t.database);
    const name = db?.name ?? t.database;
    const N = kebab(name);
    const netName = dbNetwork(ctx, db);
    const v = b.vnets.get(netName) ?? [...b.vnets.values()][0];
    if (!v) continue;
    const env = dbEnv(ctx, db);
    const tags = b.tags(db?.app, env, db?.app ? ctx.appByName.get(db.app)?.owner : undefined, { atk_db: db?.engine ?? '', atk_backup: t.backupTier, atk_backup_days: String(retentionOf(ctx.pd, t.backupTier)) });
    const ha = t.ha !== 'none' && t.ha !== '';
    const ahb = /baseprice|ahub|ahb|byol|bring/i.test(t.licenceModel);
    const retention = retentionOf(ctx.pd, t.backupTier);
    const sym = camel('db', name);
    if (t.service in DB_SERVICES_EXTRA) {
      terraformOnly(ctx, `${name} (${t.service})`, 'caches, document and search stores are built by their pattern item or a resource component in the Terraform stack, not by the migration databases grid this template follows.');
      continue;
    }
    if (t.service === 'azure-odb-exadata' || t.service === 'azure-odb-adb') {
      terraformOnly(ctx, `${name} on Oracle Database@Azure`, 'the Exadata infrastructure and VM cluster, and the databases created through OCI, span two providers; the Terraform stack builds them together.');
      continue;
    }
    if (t.service === 'azure-sqldb') {
      const server = d.add({
        sym: `${sym}Server`, type: 'Microsoft.Sql/servers', module: M, name: str(`${prefix}-${N}-`, SUFFIX),
        body: {
          location, tags,
          identity: { type: 'SystemAssigned' },
          properties: {
            version: '12.0',
            minimalTlsVersion: '1.2',
            publicNetworkAccess: 'Disabled',
            administrators: { administratorType: 'ActiveDirectory', principalType: 'Group', login: groupName(), sid: groupId(), tenantId: raw('subscription().tenantId'), azureADOnlyAuthentication: true },
          },
        },
      });
      const cls = classCell('azure', t, db) || 'GP_Gen5_4';
      const sku = sqlSku(cls);
      const database = d.add({
        sym, type: 'Microsoft.Sql/servers/databases', module: M, parent: server, name: N,
        body: {
          location, tags, sku,
          properties: {
            maxSizeBytes: Math.max(1, t.storageGib) * 1073741824,
            zoneRedundant: ha,
            requestedBackupStorageRedundancy: ha ? 'Zone' : 'Local',
            ...(sku.tier !== 'Hyperscale' && !String(sku.name).includes('_S_') ? { licenseType: ahb ? 'BasePrice' : 'LicenseIncluded' } : {}),
          },
        },
      });
      d.add({
        sym: `${sym}Retention`, type: 'Microsoft.Sql/servers/databases/backupShortTermRetentionPolicies', module: M, parent: database, name: 'default',
        body: { properties: { retentionDays: Math.min(35, Math.max(1, retention)) } },
      });
      const sub = v.tiers.get('db') ?? [...v.tiers.values()][0] as string;
      const pe = d.add({
        sym: `${sym}Endpoint`, type: 'Microsoft.Network/privateEndpoints', module: M, name: str(`${prefix}-${N}-pe`),
        body: { location, tags, properties: { subnet: { id: subnetId(v.res, sub) }, privateLinkServiceConnections: [{ name: 'sql', properties: { privateLinkServiceId: id(server), groupIds: ['sqlServer'] } }] } },
      });
      const z = zone('sql', str('privatelink', raw('environment().suffixes.sqlServerHostname')));
      d.add({
        sym: `${sym}EndpointDns`, type: 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups', module: M, parent: pe, name: 'sql',
        body: { properties: { privateDnsZoneConfigs: [{ name: 'sql', properties: { privateDnsZoneId: id(z) } }] } },
      });
      b.dbRes.set(name, { res: database, metric: 'cpu_percent' });
    } else if (t.service === 'azure-sqlmi') {
      const subnet = v.extra.get('sqlmi');
      if (!subnet) continue;
      const m = /^(GP|BC)_(Gen\w+?)_(\d+)$/.exec(classCell('azure', t, db) || 'GP_Gen5_8');
      const mi = d.add({
        sym, type: 'Microsoft.Sql/managedInstances', module: M, name: str(`${prefix}-${N}-`, SUFFIX),
        body: {
          location, tags,
          identity: { type: 'SystemAssigned' },
          sku: { name: `${m?.[1] ?? 'GP'}_${m?.[2] ?? 'Gen5'}`, tier: SQL_TIERS[m?.[1] ?? 'GP'] as string, family: m?.[2] ?? 'Gen5' },
          properties: {
            subnetId: subnetId(v.res, subnet),
            licenseType: ahb ? 'BasePrice' : 'LicenseIncluded',
            vCores: m ? Number(m[3]) : 8,
            storageSizeInGB: Math.max(32, Math.ceil(t.storageGib / 32) * 32),
            minimalTlsVersion: '1.2',
            publicDataEndpointEnabled: false,
            zoneRedundant: ha,
            requestedBackupStorageRedundancy: ha ? 'Zone' : 'Geo',
            administrators: { administratorType: 'ActiveDirectory', principalType: 'Group', login: groupName(), sid: groupId(), tenantId: raw('subscription().tenantId'), azureADOnlyAuthentication: true },
          },
        },
      });
      b.dbRes.set(name, { res: mi, metric: 'avg_cpu_percent' });
      if (ctx.pd.drRegion) terraformOnly(ctx, `${name}: SQL Managed Instance failover group`, `the secondary instance in ${ctx.pd.drRegion} and the failover group are created once both exist (az sql instance-failover-group create); neither the Terraform stack nor this template builds them.`);
    } else if (t.service === 'azure-pg-flex' || t.service === 'azure-mysql-flex') {
      const pg = t.service === 'azure-pg-flex';
      const subnet = v.extra.get(pg ? 'postgres' : 'mysql');
      if (!subnet) continue;
      const z = zone(pg ? 'postgres' : 'mysql', pg ? 'privatelink.postgres.database.azure.com' : 'privatelink.mysql.database.azure.com');
      const sku = flexSku(classCell('azure', t, db), pg ? 'GP_Standard_D4ds_v5' : 'GP_Standard_D2ds_v4');
      const zoneLinks = d.resources.filter((r) => r.parent === z);
      if (pg) {
        const version = /(\d+)/.exec(t.engineVersion || db?.version || '')?.[1] ?? '16';
        const server = d.add({
          sym, type: 'Microsoft.DBforPostgreSQL/flexibleServers', module: M, name: str(`${prefix}-${N}-`, SUFFIX),
          body: {
            location, tags, sku,
            properties: {
              version,
              storage: { storageSizeGB: PG_STORAGE_GB.find((s) => s >= t.storageGib) ?? 32767, autoGrow: 'Enabled' },
              network: { delegatedSubnetResourceId: subnetId(v.res, subnet), privateDnsZoneArmResourceId: id(z), publicNetworkAccess: 'Disabled' },
              // Entra ID only: no administrator password exists.
              authConfig: { activeDirectoryAuth: 'Enabled', passwordAuth: 'Disabled', tenantId: raw('subscription().tenantId') },
              backup: { backupRetentionDays: Math.min(35, Math.max(7, retention)), geoRedundantBackup: 'Disabled' },
              highAvailability: ha ? { mode: 'ZoneRedundant', standbyAvailabilityZone: '2' } : { mode: 'Disabled' },
              availabilityZone: '1',
            },
          },
          dependsOn: zoneLinks,
        });
        d.add({
          sym: `${sym}Admins`, type: 'Microsoft.DBforPostgreSQL/flexibleServers/administrators', module: M, parent: server, name: groupId(),
          body: { properties: { principalType: 'Group', principalName: groupName(), tenantId: raw('subscription().tenantId') } },
        });
        b.dbRes.set(name, { res: server, metric: 'cpu_percent' });
      } else {
        const version = /8\.4/.test(db?.version ?? '') ? '8.4' : /5\.7/.test(db?.version ?? '') ? '5.7' : '8.0.21';
        const pw = d.param(`mysqlAdminPassword${camel(name).replace(/^./, (c) => c.toUpperCase())}`, {
          type: 'string', secure: true, env: `MYSQL_ADMIN_PASSWORD_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`,
          description: `The administrator password of the ${name} MySQL flexible server (Azure requires one at create).`,
        });
        const server = d.add({
          sym, type: 'Microsoft.DBforMySQL/flexibleServers', module: M, name: str(`${prefix}-${N}-`, SUFFIX),
          body: {
            location, tags, sku,
            properties: {
              version,
              administratorLogin: 'dbadmin',
              administratorLoginPassword: pw,
              storage: { storageSizeGB: Math.max(20, t.storageGib), autoGrow: 'Enabled' },
              network: { delegatedSubnetResourceId: subnetId(v.res, subnet), privateDnsZoneResourceId: id(z), publicNetworkAccess: 'Disabled' },
              backup: { backupRetentionDays: Math.min(35, Math.max(1, retention)), geoRedundantBackup: 'Disabled' },
              highAvailability: ha ? { mode: 'ZoneRedundant', standbyAvailabilityZone: '2' } : { mode: 'Disabled' },
              availabilityZone: '1',
            },
          },
          dependsOn: zoneLinks,
        });
        b.dbRes.set(name, { res: server, metric: 'cpu_percent' });
      }
    } else if (t.service === 'azure-sqlvm') {
      for (const h of t.hosts ?? []) {
        const host = ctx.workloadById.get(h)?.name ?? h;
        const vm = b.vms.get(host);
        if (!vm) {
          ctx.findings.push(info('plan.native.azure-sqlvm-host', `${name}: ${host} is not built by this template (it is replicated or out of scope), so its SQL Server registration is not here either; register it with the SQL IaaS Agent extension once it runs.`));
          continue;
        }
        d.add({
          sym: camel('sqlVm', host), type: 'Microsoft.SqlVirtualMachine/sqlVirtualMachines', module: M, name: host,
          body: {
            location, tags,
            properties: {
              virtualMachineResourceId: id(vm.res),
              sqlServerLicenseType: ahb ? 'AHUB' : 'PAYG',
              sqlManagement: 'Full',
              serverConfigurationsManagementSettings: { sqlConnectivityUpdateSettings: { connectivityType: 'PRIVATE', port: 1433 } },
              autoPatchingSettings: { enable: true, dayOfWeek: 'Sunday', maintenanceWindowStartingHour: 2, maintenanceWindowDuration: 60 },
            },
          },
        });
      }
      if (ha && (t.hosts?.length ?? 0) > 1) {
        ctx.findings.push(info('plan.native.azure-sqlvm-ag', `${name}: the availability group across the SQL VMs is built by Ansible (the mssql_ag role) with the vaulted domain credentials, not here.`));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Backup and monitoring
// ---------------------------------------------------------------------------

/** A VM's tags (the same the VM carries), for what belongs to it. */
function vmTagsOf(b: Build, t: ComputeTarget): Record<string, Val> {
  const w = workloadOf(b.ctx, t);
  return { ...b.tags(w?.app, w?.env, w ? b.ctx.appByName.get(w.app)?.owner : undefined), ...vmTags(b.ctx, t, 'rebuild') };
}

function backup(b: Build): void {
  const { d, ctx, prefix, location } = b;
  const tiers = ctx.pd.backup.tiers;
  if (tiers.length === 0 || b.vms.size === 0) return;
  const M = d.module({ name: 'backup', description: `${ctx.plan.name}: a Recovery Services vault, a VM backup policy per tier, and every VM protected by its tier.` });
  const immutable = tiers.some((x) => x.immutable);
  const copy = tiers.some((x) => x.copyToDr);
  const vault = d.add({
    sym: 'recoveryVault', type: 'Microsoft.RecoveryServices/vaults', module: M, name: `${prefix}-rsv`,
    body: {
      location, tags: b.tags(), sku: { name: 'RS0', tier: 'Standard' },
      properties: {
        publicNetworkAccess: 'Disabled',
        securitySettings: { immutabilitySettings: { state: immutable ? 'Locked' : 'Unlocked' } },
        redundancySettings: { standardTierStorageRedundancy: copy ? 'GeoRedundant' : 'ZoneRedundant', crossRegionRestore: copy ? 'Enabled' : 'Disabled' },
        monitoringSettings: { azureMonitorAlertSettings: { alertsForAllJobFailures: 'Enabled' }, classicAlertSettings: { alertsForCriticalOperations: 'Enabled' } },
      },
    },
  });
  if (copy && ctx.pd.drRegion) ctx.findings.push(info('plan.native.azure-dr-pair', `Geo-redundant vault storage copies to the region's pair, not to ${ctx.pd.drRegion}; cross-region restore restores there.`));
  const policies = new Map<string, Res>();
  for (const x of tiers) {
    const hours = Number(/(\d+)/.exec(x.frequency)?.[1] ?? 24);
    const hourly = hours < 24;
    const start = hourly ? '2025-01-01T00:00:00Z' : '2025-01-01T23:00:00Z';
    policies.set(x.tier, d.add({
      sym: camel('policy', x.tier), type: 'Microsoft.RecoveryServices/vaults/backupPolicies', module: M, parent: vault, name: x.tier,
      body: {
        tags: b.tags(),
        properties: {
          backupManagementType: 'AzureIaasVM',
          policyType: hourly ? 'V2' : 'V1',
          instantRpRetentionRangeInDays: hourly ? 7 : 2,
          timeZone: 'UTC',
          schedulePolicy: hourly
            ? { schedulePolicyType: 'SimpleSchedulePolicyV2', scheduleRunFrequency: 'Hourly', hourlySchedule: { interval: [4, 6, 8, 12].find((h) => h >= hours) ?? 4, scheduleWindowStartTime: start, scheduleWindowDuration: 24 } }
            : { schedulePolicyType: 'SimpleSchedulePolicy', scheduleRunFrequency: 'Daily', scheduleRunTimes: [start] },
          retentionPolicy: { retentionPolicyType: 'LongTermRetentionPolicy', dailySchedule: { retentionTimes: [start], retentionDuration: { count: Math.max(7, x.retentionDays), durationType: 'Days' } } },
        },
      },
    }));
  }
  for (const [name, vm] of b.vms) {
    const policy = policies.get(vm.target.backupTier) ?? [...policies.values()][0];
    if (!policy) continue;
    const rg = raw('resourceGroup().name');
    // The protected item's full name: the vault, the Azure fabric, the VM's container, the item (backupFabrics has no type of its own to be a parent).
    d.add({
      sym: camel('backup', name), type: 'Microsoft.RecoveryServices/vaults/backupFabrics/protectionContainers/protectedItems', module: M, fullName: true,
      name: str(`${prefix}-rsv/Azure/iaasvmcontainer;iaasvmcontainerv2;`, rg, `;${name}/vm;iaasvmcontainerv2;`, rg, `;${name}`),
      body: { tags: vmTagsOf(b, vm.target), properties: { protectedItemType: 'Microsoft.Compute/virtualMachines', policyId: id(policy), sourceResourceId: id(vm.res) } },
    });
  }
}

function monitoring(b: Build): void {
  const { d, ctx, prefix, location } = b;
  if (b.vms.size === 0 || !b.lz || ctx.plan.requirements.monitoring === 'vcf-operations') return;
  const M = d.module({ name: 'monitoring', description: `${ctx.plan.name}: the Azure Monitor Agent on every VM, with a data collection rule sending performance counters, syslog and Windows events to the landing zone's workspace.` });
  const dcr = d.add({
    sym: 'vmDataCollection', type: 'Microsoft.Insights/dataCollectionRules', module: M, name: `${prefix}-vms`,
    body: {
      location, tags: b.tags(),
      properties: {
        description: 'Performance, syslog and Windows events from the migrated VMs',
        dataSources: {
          performanceCounters: [{ name: 'perf', streams: ['Microsoft-Perf'], samplingFrequencyInSeconds: 60, counterSpecifiers: ['\\Processor Information(_Total)\\% Processor Time', '\\Memory\\% Committed Bytes In Use', '\\LogicalDisk(_Total)\\% Free Space', 'Processor(*)\\% Processor Time', 'Memory(*)\\% Used Memory', 'Logical Disk(*)\\% Used Space'] }],
          syslog: [{ name: 'syslog', streams: ['Microsoft-Syslog'], facilityNames: ['auth', 'authpriv', 'daemon', 'kern', 'syslog'], logLevels: ['Warning', 'Error', 'Critical', 'Alert', 'Emergency'] }],
          windowsEventLogs: [{ name: 'events', streams: ['Microsoft-Event'], xPathQueries: ['System!*[System[(Level=1 or Level=2 or Level=3)]]', 'Application!*[System[(Level=1 or Level=2)]]', 'Security!*[System[(band(Keywords,13510798882111488))]]'] }],
        },
        destinations: { logAnalytics: [{ name: 'workspace', workspaceResourceId: id(b.lz.law) }] },
        dataFlows: [{ streams: ['Microsoft-Perf', 'Microsoft-Syslog', 'Microsoft-Event'], destinations: ['workspace'] }],
      },
    },
  });
  for (const [name, vm] of b.vms) {
    const agent = vm.kind === 'windows' ? 'AzureMonitorWindowsAgent' : 'AzureMonitorLinuxAgent';
    const ext = d.add({
      sym: camel('agent', name), type: 'Microsoft.Compute/virtualMachines/extensions', module: M, parent: vm.res, name: agent,
      body: { location, tags: b.tags(), properties: { publisher: 'Microsoft.Azure.Monitor', type: agent, typeHandlerVersion: '1.0', autoUpgradeMinorVersion: true, enableAutomaticUpgrade: true } },
    });
    d.add({
      sym: camel('dataCollection', name), type: 'Microsoft.Insights/dataCollectionRuleAssociations', module: M, scope: vm.res, name: `${name}-dcr`,
      body: { properties: { dataCollectionRuleId: id(dcr), description: 'The migrated VMs\' data collection rule' } },
      dependsOn: [ext],
    });
  }
  if (ctx.plan.requirements.siem === 'sentinel') ctx.findings.push(info('plan.native.siem', 'Microsoft Sentinel is enabled on the landing zone\'s workspace (onboarding is a separate step); these VMs\' events land there.'));
}

// ---------------------------------------------------------------------------
// App items and app monitoring
// ---------------------------------------------------------------------------

const setting = (c: AppComponentLike, key: string, fallback: string): string => c.settings?.[key]?.trim() || fallback;

function appTags(b: Build, a: AppHere, component?: string): Record<string, Val> {
  const envs = [...new Set([...b.ctx.rebuilt, ...b.ctx.replicated].map((vm) => workloadOf(b.ctx, vm)).filter((w) => w?.app === a.app.name).map((w) => w?.env))].filter(Boolean).join(' ') || 'prod';
  return b.tags(a.app.name, envs, a.app.owner, { atk_criticality: a.app.criticality, ...(component ? { atk_component: component } : {}) });
}

const FUNCTION_RUNTIME: Readonly<Record<string, readonly [string, string]>> = {
  'python-3.12': ['python', '3.12'], 'node-20': ['node', '20'], 'java-21': ['java', '21'], 'dotnet-8-isolated': ['dotnet-isolated', '8.0'],
};

const WEB_RUNTIME: Readonly<Record<string, string>> = {
  'dotnet-8': 'DOTNETCORE|8.0', 'java-17': 'JAVA|17-java17', 'java-17-tomcat': 'TOMCAT|10.1-java17', 'java-17-jboss': 'JBOSSEAP|8-java17', 'node-20': 'NODE|20-lts', 'python-3.12': 'PYTHON|3.12',
};

function appModule(b: Build, a: AppHere): string {
  return b.d.module({ name: `app-${slugName(a.app.name)}`, description: `${b.ctx.plan.name}: ${a.app.name}: its app items and monitoring.` });
}

function storageAccount(b: Build, M: string, sym: string, stem: string, tags: Record<string, Val>, zoned: boolean): Res {
  return b.d.add({
    sym, type: 'Microsoft.Storage/storageAccounts', module: M, name: call('take', str(`${stem.replace(/[^a-z0-9]/g, '').slice(0, 14)}`, SUFFIX), 24),
    body: {
      location: b.location, tags, kind: 'StorageV2', sku: { name: zoned ? 'Standard_ZRS' : 'Standard_LRS' },
      properties: {
        minimumTlsVersion: 'TLS1_2', supportsHttpsTrafficOnly: true, allowBlobPublicAccess: false, allowSharedKeyAccess: false, defaultToOAuthAuthentication: true,
        publicNetworkAccess: 'Enabled', networkAcls: { bypass: 'AzureServices', defaultAction: 'Allow' },
        encryption: { keySource: 'Microsoft.Storage', requireInfrastructureEncryption: true, services: { blob: { enabled: true, keyType: 'Account' }, file: { enabled: true, keyType: 'Account' } } },
      },
    },
  });
}

function blobRole(b: Build, M: string, sym: string, account: Res, holder: Res, role: string, what: string): void {
  const principal = prop(holder, 'identity.principalId');
  b.d.add({
    sym, type: 'Microsoft.Authorization/roleAssignments', module: M, scope: account, name: call('guid', id(account), id(holder), role),
    body: { properties: { roleDefinitionId: raw(`subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '${role}')`), principalId: principal, principalType: 'ServicePrincipal', description: what } },
  });
}

function serverless(b: Build, a: AppHere, c: AppComponentLike): void {
  const { d, prefix, location } = b;
  const v = b.vnets.get(setting(c, 'network', 'prod')) ?? [...b.vnets.values()][0];
  const subnet = v?.extra.get(`app:${c.id}`);
  if (!v || !subnet) return;
  const M = appModule(b, a);
  const tags = appTags(b, a, c.id);
  const S = camel(a.app.name, c.name);
  const zoned = a.app.criticality === 'tier0' || a.app.criticality === 'tier1';
  const account = storageAccount(b, M, `${S}Storage`, `${prefix}${slugName(a.app.name)}fn`, tags, zoned);
  const blob = d.add({ sym: `${S}Blobs`, type: 'Microsoft.Storage/storageAccounts/blobServices', module: M, parent: account, name: 'default', body: { properties: { deleteRetentionPolicy: { enabled: true, days: 7 } } } });
  d.add({ sym: `${S}Packages`, type: 'Microsoft.Storage/storageAccounts/blobServices/containers', module: M, parent: blob, name: 'packages', body: { properties: { publicAccess: 'None' } } });
  const plan = d.add({
    sym: `${S}Plan`, type: 'Microsoft.Web/serverfarms', module: M, name: `${prefix}-${slugName(a.app.name)}-${kebab(c.name)}-plan`,
    body: { location, tags, kind: 'functionapp', sku: { name: 'FC1', tier: 'FlexConsumption' }, properties: { reserved: true, zoneRedundant: zoned } },
  });
  const [runtime, version] = FUNCTION_RUNTIME[setting(c, 'runtime', 'python-3.12')] ?? FUNCTION_RUNTIME['python-3.12'] as readonly [string, string];
  const site = d.add({
    sym: S, type: 'Microsoft.Web/sites', module: M, name: str(`${prefix}-${slugName(a.app.name)}-${kebab(c.name)}-`, SUFFIX),
    body: {
      location, tags, kind: 'functionapp,linux',
      identity: { type: 'SystemAssigned' },
      properties: {
        serverFarmId: id(plan),
        httpsOnly: true,
        publicNetworkAccess: 'Disabled',
        virtualNetworkSubnetId: subnetId(v.res, subnet),
        siteConfig: { minTlsVersion: '1.2', ftpsState: 'Disabled', http20Enabled: true, appSettings: [{ name: 'AzureWebJobsStorage__accountName', value: prop(account, 'name') }] },
        functionAppConfig: {
          deployment: { storage: { type: 'blobContainer', value: str(prop(account, 'properties.primaryEndpoints.blob'), 'packages'), authentication: { type: 'SystemAssignedIdentity' } } },
          scaleAndConcurrency: { maximumInstanceCount: Math.max(40, Number(setting(c, 'max_instances', '40')) || 40), instanceMemoryMB: Number(setting(c, 'memory_mb', '2048')) >= 4096 ? 4096 : 2048 },
          runtime: { name: runtime, version },
        },
      },
    },
  });
  // The function reaches its storage with its identity: no account key.
  blobRole(b, M, `${S}StorageAccess`, account, site, 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b', 'The function app reads its packages and state with its identity (Storage Blob Data Owner).');
  for (const policy of ['ftp', 'scm']) {
    d.add({ sym: `${S}${policy === 'ftp' ? 'Ftp' : 'Scm'}Basic`, type: 'Microsoft.Web/sites/basicPublishingCredentialsPolicies', module: M, parent: site, name: policy, body: { properties: { allow: false } } });
  }
  b.ctx.findings.push(info('plan.native.azure-functions-flex', `${a.app.name} ${c.name}: Azure Functions on the Flex Consumption plan, whose storage and deployment use the app's identity (no account key); the Terraform item uses an Elastic Premium plan.`));
}

function paasWeb(b: Build, a: AppHere, c: AppComponentLike): void {
  const { d, prefix, location } = b;
  const v = b.vnets.get(setting(c, 'network', 'prod')) ?? [...b.vnets.values()][0];
  const subnet = v?.extra.get(`app:${c.id}`);
  if (!v || !subnet || !b.lz) return;
  const M = appModule(b, a);
  const tags = appTags(b, a, c.id);
  const S = camel(a.app.name, c.name);
  const runtime = setting(c, 'runtime', 'dotnet-8');
  if (runtime === 'dotnet-framework-4.8') {
    terraformOnly(b.ctx, `${a.app.name} ${c.name} (.NET Framework on App Service)`, 'a Windows web app is built by the Terraform paas-web item; this template writes the Linux runtimes.');
    return;
  }
  const internal = setting(c, 'exposure', 'internal') !== 'public';
  const zoned = a.app.criticality === 'tier0' || a.app.criticality === 'tier1';
  const sku = setting(c, 'sku', 'P1v3');
  const min = Number(setting(c, 'instances', '2')) || 2;
  const premium = /^P\d+m?v3$/.test(sku);
  const plan = d.add({
    sym: `${S}Plan`, type: 'Microsoft.Web/serverfarms', module: M, name: `${prefix}-${slugName(a.app.name)}-${kebab(c.name)}-plan`,
    body: { location, tags, kind: 'linux', sku: { name: sku, capacity: zoned && premium ? Math.max(3, min) : min }, properties: { reserved: true, zoneRedundant: zoned && premium } },
  });
  const site = d.add({
    sym: S, type: 'Microsoft.Web/sites', module: M, name: str(`${prefix}-${slugName(a.app.name)}-${kebab(c.name)}-`, SUFFIX),
    body: {
      location, tags, kind: 'app,linux',
      identity: { type: 'SystemAssigned, UserAssigned', userAssignedIdentities: new Dict([[id(b.lz.uami), {}]]) },
      properties: {
        serverFarmId: id(plan),
        httpsOnly: true,
        clientAffinityEnabled: false,
        publicNetworkAccess: internal ? 'Disabled' : 'Enabled',
        virtualNetworkSubnetId: subnetId(v.res, subnet),
        siteConfig: {
          linuxFxVersion: WEB_RUNTIME[runtime] ?? 'DOTNETCORE|8.0',
          alwaysOn: true, ftpsState: 'Disabled', http20Enabled: true, minTlsVersion: '1.2', vnetRouteAllEnabled: true,
          healthCheckPath: setting(c, 'health_path', '/health'),
        },
      },
    },
  });
  for (const policy of ['ftp', 'scm']) {
    d.add({ sym: `${S}${policy === 'ftp' ? 'Ftp' : 'Scm'}Basic`, type: 'Microsoft.Web/sites/basicPublishingCredentialsPolicies', module: M, parent: site, name: policy, body: { properties: { allow: false } } });
  }
  d.add({
    sym: `${S}Logs`, type: 'Microsoft.Insights/diagnosticSettings', module: M, scope: site, name: 'landing-zone',
    body: { properties: { workspaceId: id(b.lz.law), logs: ['AppServiceHTTPLogs', 'AppServiceConsoleLogs', 'AppServiceAppLogs'].map((category) => ({ category, enabled: true })), metrics: [{ category: 'AllMetrics', enabled: true }] } },
  });
  if (internal) {
    const web = v.tiers.get('web') ?? [...v.tiers.values()][0] as string;
    const pe = d.add({
      sym: `${S}Endpoint`, type: 'Microsoft.Network/privateEndpoints', module: M, name: `${prefix}-${slugName(a.app.name)}-${kebab(c.name)}-pe`,
      body: { location, tags, properties: { subnet: { id: subnetId(v.res, web) }, privateLinkServiceConnections: [{ name: 'web', properties: { privateLinkServiceId: id(site), groupIds: ['sites'] } }] } },
    });
    const zone = privateZone(b, M, 'web', 'privatelink.azurewebsites.net');
    d.add({
      sym: `${S}EndpointDns`, type: 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups', module: M, parent: pe, name: 'web',
      body: { properties: { privateDnsZoneConfigs: [{ name: 'web', properties: { privateDnsZoneId: id(zone) } }] } },
    });
  }
}

const SWA_REGIONS = ['westus2', 'centralus', 'eastus2', 'westeurope', 'eastasia'];

function staticSite(b: Build, a: AppHere, c: AppComponentLike): void {
  const { d, prefix } = b;
  const M = appModule(b, a);
  const region = setting(c, 'swa_region', SWA_REGIONS.includes(b.ctx.pd.region) ? b.ctx.pd.region : 'westeurope');
  d.add({
    sym: camel(a.app.name, c.name), type: 'Microsoft.Web/staticSites', module: M, name: `${prefix}-${slugName(a.app.name)}-${kebab(c.name)}`,
    body: {
      location: SWA_REGIONS.includes(region) ? region : 'westeurope', tags: appTags(b, a, c.id), sku: { name: 'Standard', tier: 'Standard' },
      properties: { stagingEnvironmentPolicy: 'Enabled', allowConfigFileUpdates: true, enterpriseGradeCdnStatus: 'Disabled' },
    },
  });
}

function objectStorage(b: Build, a: AppHere, c: AppComponentLike): void {
  const { d, prefix } = b;
  const M = appModule(b, a);
  const S = camel(a.app.name, c.name);
  const zoned = a.app.criticality === 'tier0' || a.app.criticality === 'tier1';
  const account = storageAccount(b, M, `${S}Storage`, `${prefix}${slugName(a.app.name)}`, appTags(b, a, c.id), zoned);
  const blob = d.add({
    sym: `${S}Blobs`, type: 'Microsoft.Storage/storageAccounts/blobServices', module: M, parent: account, name: 'default',
    body: { properties: { isVersioningEnabled: true, deleteRetentionPolicy: { enabled: true, days: 30 }, containerDeleteRetentionPolicy: { enabled: true, days: 30 } } },
  });
  d.add({ sym: `${S}Data`, type: 'Microsoft.Storage/storageAccounts/blobServices/containers', module: M, parent: blob, name: 'data', body: { properties: { publicAccess: 'None' } } });
}

const PATTERN_REASONS: Readonly<Record<string, string>> = {
  containers: 'an AKS cluster with its node pools, add-ons and workload identity is built by the Terraform containers blueprint (and its Kubernetes manifests).',
  'managed-cache': 'the cache is built by the Terraform managed-cache pattern item.',
  'managed-messaging': 'Service Bus is built by the Terraform managed-messaging pattern item.',
  'managed-kafka': 'Event Hubs for Kafka is built by the Terraform managed-kafka pattern item.',
  'managed-search': 'the search service is built by the Terraform managed-search pattern item.',
  'file-service': 'Azure Files or Azure NetApp Files need the directory they join, which the Terraform file-service pattern item wires to the identity item.',
  'vdi-service': 'Azure Virtual Desktop host pools and session hosts are built by the Terraform VDI pattern item.',
  'sap-certified': 'SAP systems are built by the Terraform SAP pattern item (Azure Center for SAP solutions).',
  appliance: 'marketplace appliances need their plan terms accepted and their vendor bootstrap, which the Terraform appliance item carries.',
  batch: 'Azure Batch pools are built by the Terraform batch pattern item.',
  workflow: 'Logic Apps workflows need the workflow definition, which the pipeline owns.',
  'api-gateway': 'API Management needs its publisher and its APIs designed; no Terraform blueprint builds it either.',
};

function appItems(b: Build): void {
  const { ctx } = b;
  for (const a of ctx.apps) {
    for (const c of a.components) {
      if (c.kind === 'resource') {
        terraformOnly(ctx, `${a.app.name} ${c.name} (${c.blueprintId ?? 'resource'})`, 'a resource component is a Terraform page blueprint with its own inputs; it has no native template here.');
        continue;
      }
      if (c.kind !== 'pattern') continue;
      if (/_app_ingress$/.test(c.settings?.blueprint?.trim() ?? '')) {
        terraformOnly(ctx, `${a.app.name} ${c.name} (Application Gateway or load balancer)`, 'the Terraform ingress item builds it with its own subnet, certificate from Key Vault and DNS records; it is not in this template.');
        continue;
      }
      switch (c.tierPattern) {
        case undefined: case 'vm': case 'managed-db': case 'vmware-service': case 'retire': case 'retain': case 'saas': case 'specialist':
          break;
        case 'serverless': serverless(b, a, c); break;
        case 'paas-web': paasWeb(b, a, c); break;
        case 'static-site': staticSite(b, a, c); break;
        case 'object-storage': objectStorage(b, a, c); break;
        default:
          terraformOnly(ctx, `${a.app.name} ${c.name} (${c.tierPattern})`, PATTERN_REASONS[c.tierPattern] ?? 'no clean Bicep equivalent here.');
      }
    }
  }
}

function appMonitoring(b: Build): void {
  const { d, ctx, prefix } = b;
  for (const a of ctx.apps) {
    const vms = [...b.vms.entries()].filter(([name]) => [...ctx.workloadById.values()].some((w) => w.name === name && w.app === a.app.name));
    const dbs = [...b.dbRes.entries()].filter(([name]) => ctx.plan.databases.some((x) => x.name === name && x.app === a.app.name));
    if (vms.length + dbs.length === 0) continue;
    const M = appModule(b, a);
    const tags = appTags(b, a);
    const th = THRESHOLDS[a.app.criticality] ?? THRESHOLDS.tier2;
    const S = camel(a.app.name);
    const group = d.add({
      sym: `${S}Alerts`, type: 'Microsoft.Insights/actionGroups', module: M, name: `${prefix}-${slugName(a.app.name)}-alerts`,
      body: { location: 'global', tags, properties: { groupShortName: slugName(a.app.name).replace(/[^a-z0-9]/g, '').slice(0, 12) || 'alerts', enabled: true } },
    });
    const minutes = th.periodMin;
    const alert = (sym: string, name: string, target: Res, type: string, metric: string, operator: string, threshold: number, window = minutes * 3): void => {
      d.add({
        sym, type: 'Microsoft.Insights/metricAlerts', module: M, name,
        body: {
          location: 'global', tags,
          properties: {
            description: `${a.app.name}: ${metric} ${operator} ${threshold}`,
            severity: 2,
            enabled: true,
            scopes: [id(target)],
            evaluationFrequency: `PT${Math.max(1, minutes)}M`,
            windowSize: `PT${[5, 15, 30, 60].find((w) => w >= window) ?? 15}M`,
            targetResourceType: type,
            criteria: { 'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria', allOf: [{ criterionType: 'StaticThresholdCriterion', name: 'threshold', metricName: metric, operator, threshold, timeAggregation: 'Average' }] },
            actions: [{ actionGroupId: id(group) }],
          },
        },
      });
    };
    for (const [name, vm] of vms) {
      const V = camel(name);
      alert(`${V}CpuAlert`, `${prefix}-${slugName(a.app.name)}-${kebab(name)}-cpu`, vm.res, 'Microsoft.Compute/virtualMachines', 'Percentage CPU', 'GreaterThan', th.cpu);
      alert(`${V}MemoryAlert`, `${prefix}-${slugName(a.app.name)}-${kebab(name)}-memory`, vm.res, 'Microsoft.Compute/virtualMachines', 'Available Memory Bytes', 'LessThan', Math.round(vm.target.ramGib * 1073741824 * (100 - th.memory) / 100));
      alert(`${V}AvailabilityAlert`, `${prefix}-${slugName(a.app.name)}-${kebab(name)}-availability`, vm.res, 'Microsoft.Compute/virtualMachines', 'VmAvailabilityMetric', 'LessThan', 1);
    }
    for (const [name, x] of dbs) {
      alert(`${camel(name)}DbCpuAlert`, `${prefix}-${slugName(a.app.name)}-${kebab(name)}-db-cpu`, x.res, x.res.type, x.metric, 'GreaterThan', th.cpu);
    }
  }
}

// ---------------------------------------------------------------------------
// Putting it together
// ---------------------------------------------------------------------------

interface Built {
  readonly d: Deployment;
  readonly ctx: NativeCtx;
  readonly files: Record<string, string>;
}

function build(plan: Plan, decision: PlanDecision, design: TargetDesign, options: NativeOptions): Built | null {
  const pd = design.platforms.find((p) => p.platform === 'azure');
  if (!pd) return null;
  const ctx = nativeContext(plan, decision, design, pd, options);
  if (!ctx) return null;
  const scopeName = ctx.scope === 'estate' ? '' : ctx.scope === 'landing-zone' ? '-lz' : `-${(options.apps ?? []).length === 1 ? slugName(plan.apps.find((x) => x.id === options.apps?.[0] || x.name === options.apps?.[0])?.name ?? 'apps') : 'apps'}`;
  const d = new Deployment(`${pd.prefix}${scopeName}`.slice(0, 40));
  const location = d.param('location', { type: 'string', default: raw('resourceGroup().location'), description: 'The region everything is built in (the resource group\'s by default).' });
  const owner = d.param('owner', { type: 'string', default: 'unassigned', description: 'The atk_owner tag of what has no app owner in the plan (the landing zone, shared items).' });
  const envs = [...new Set(pd.networks.flatMap((n) => n.envs))].join(' ') || 'shared';
  const b: Build = {
    ctx, d, prefix: pd.prefix, cmk: plan.requirements.keys !== 'provider-managed', vnets: new Map(), location,
    tags: (app, env, own, extra = {}) => ({ atk_plan: planTag(plan), atk_app: app ?? 'landing-zone', atk_env: env ?? envs, atk_owner: own ? own : owner, ...extra }),
    vms: new Map(), dbRes: new Map(), zones: new Map(),
  };
  landingZone(b);
  if (ctx.scope !== 'apps') {
    identity(b);
    connectivity(b);
    relocate(b);
    terraformOnly(ctx, 'Governance (Azure Policy assignments, the budget)', 'they are assigned at subscription scope, and this deployment is to a resource group; the Terraform governance item assigns them to the subscription.');
  }
  compute(b);
  databases(b);
  appItems(b);
  backup(b);
  monitoring(b);
  appMonitoring(b);
  const migrating = ctx.replicated.length > 0 || ctx.databases.some((x) => !isIaasService(x.service) && decision.items[x.database]?.method === 'managed-db' && decision.items[x.database]?.disposition !== 'new');
  if (migrating) {
    terraformOnly(ctx, 'Replication (Azure Migrate, Database Migration Service)', 'Azure Migrate replicates each server as it is discovered and enabled, and the database migrations need the source credentials at create; the Terraform replication item and the execution kit carry them.');
  }
  const description = `${plan.name}: Azure, ${ctx.scope === 'estate' ? 'the estate' : ctx.scope === 'landing-zone' ? 'the landing zone' : 'the selected apps'} (${pd.prefix} in ${pd.region})`;
  const dir = 'azure-bicep';
  const files: Record<string, string> = {
    [`${dir}/main.bicep`]: mainBicep(d, description),
    [`${dir}/main.bicepparam`]: mainBicepparam(d),
    [`${dir}/azuredeploy.json`]: mainArm(d, description),
  };
  for (const m of d.modules) files[`${dir}/modules/${m.name}.bicep`] = moduleBicep(d, m);
  files[`${dir}/README.md`] = readme(d, ctx, files);
  return { d, ctx, files };
}

function readme(d: Deployment, ctx: NativeCtx, files: Record<string, string>): string {
  const pd = ctx.pd;
  const used = new Set<string>();
  for (const m of d.modules) for (const p of analyse(d, m).params) used.add(p);
  const env = [...d.params].filter(([n, s]) => used.has(n) && s.env);
  const types = new Map<string, number>();
  for (const r of d.resources) if (!r.existing) types.set(r.type, (types.get(r.type) ?? 0) + 1);
  const rg = `${pd.prefix}-rg`;
  const lines = [
    `# ${ctx.plan.name}: Azure Bicep`,
    '',
    `The ${ctx.scope === 'estate' ? 'estate' : ctx.scope === 'landing-zone' ? 'landing zone' : 'selected apps'} on Azure (${pd.prefix} in ${pd.region}) as one resource-group deployment, built from the same design as the Terraform stack in \`terraform/azure/\`. Deploy one or the other, not both.`,
    '',
    '## Files',
    '',
    '- `main.bicep`: the parameters and the modules, in dependency order.',
    ...d.modules.map((m) => `- \`modules/${m.name}.bicep\`: ${m.resourceGroup ? `${m.description.replace(/\.$/, '')}; deployed to ${m.resourceGroup}.` : m.description.replace(/^[^:]+: /, '')}`),
    '- `main.bicepparam`: the parameter values; every value without a default is read from the environment, so no secret is in a file.',
    '- `azuredeploy.json`: the same deployment as one ARM template (each module a nested deployment), for the portal.',
    '',
    '## Deploy with the Azure CLI',
    '',
    '```sh',
    'az login',
    `az group create --name ${rg} --location ${pd.region}`,
    ...env.map(([, s]) => `export ${s.env}="<${s.secure ? 'from your vault' : 'value'}>"`),
    `az deployment group create --resource-group ${rg} --template-file main.bicep --parameters main.bicepparam`,
    '```',
    '',
    '## Deploy from the portal',
    '',
    `Deploy a custom template → Build your own template in the editor → Load file → \`azuredeploy.json\` → Save, choose the resource group and region, fill in the parameters (${env.length > 0 ? env.map(([n]) => `\`${n}\``).join(', ') : 'all have defaults'}), then Review + create.`,
    '',
    '## Credentials',
    '',
    'None are in these files. The databases use Microsoft Entra ID authentication only, so no database password exists; the values Azure needs a secret for at create are `@secure()` parameters, which main.bicepparam reads from the environment and the portal asks for.',
    '',
    '## What is in it',
    '',
    ...[...types.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([type, n]) => `- ${type}: ${n}`),
    '',
    ...(d.modules.some((m) => m.resourceGroup === 'NetworkWatcherRG')
      ? ['VNet flow logs go through the region\'s network watcher in NetworkWatcherRG, which Azure creates with the first virtual network in a subscription and region; the flow-logs module waits for the landing zone.', '']
      : []),
    ...(ctx.replicated.length > 0
      ? ['## Replicated VMs', '', `Azure Migrate creates ${ctx.replicated.map((vm) => vmName(ctx, vm)).join(', ')} at cutover; they are not in the template. Tag them as the plan says (atk_* tags) so the Ansible inventory finds them, and protect them with the vault\'s tier policies.`, '']
      : []),
    ...terraformOnlySection(ctx.terraformOnly),
  ];
  void files;
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

/**
 * Azure Bicep for the Azure part of a design: `azure-bicep/` with main.bicep,
 * its modules, main.bicepparam, the equivalent ARM template (azuredeploy.json)
 * and a README with the portal and az commands.
 */
export function bicepFiles(plan: Plan, decision: PlanDecision, design: TargetDesign, options: NativeOptions = {}): NativeFiles {
  const built = build(plan, decision, design, options);
  if (!built) {
    return { files: {}, findings: [info('plan.native.bicep-nothing', 'Nothing in this plan (or the selected apps) is placed on Azure, so there is no Bicep.')] };
  }
  return { files: built.files, findings: built.ctx.findings.map((f) => ({ ...f, path: f.path ?? 'azure-bicep' })) };
}

/** Exposed for the tests: the resource types and API versions the deployment uses. */
export function bicepResourceTypes(plan: Plan, decision: PlanDecision, design: TargetDesign, options: NativeOptions = {}): { type: string; api: string; tagged: boolean; existing: boolean }[] {
  const built = build(plan, decision, design, options);
  if (!built) return [];
  return built.d.resources.map((r) => ({ type: r.type, api: r.api, tagged: r.body.tags !== undefined, existing: !!r.existing }));
}
