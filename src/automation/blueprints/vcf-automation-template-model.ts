/**
 * A VM Apps cloud template, built from rows.
 *
 * The page gives two grids: resources (name | type | settings | depends on) and
 * inputs (name | type | title | default | constraints). This turns them into
 * the cloud template YAML VCF Automation imports, and checks the things that
 * otherwise only fail at request time: a reference to a resource or an input
 * that does not exist, a dependency loop, a default outside its own enum, a
 * machine with no image, a size input nobody bounded.
 *
 * Settings are `key=value; key=value`. Most keys are the property names the
 * template takes, written as they are; a few are shorthands that expand into
 * the nested shapes (networks, attached disks, load balancer routes, NAT and
 * security rules), because a nested list does not fit in a grid cell.
 *
 * VCF 9.1 facts: the VM Apps organization takes the Cloud.vSphere.*, Cloud.NSX.*,
 * Cloud.SecurityGroup, Cloud.Ansible*, Allocations.* and Custom.* types. Public
 * cloud resource types are deprecated in 9.1 and are refused here.
 */

import { error, warning, type Finding } from '../../core/findings.ts';
import { parseCidrAny } from '../../core/ip.ts';

// --- the rows ---------------------------------------------------------------

export interface ResourceRow {
  readonly name: string;
  readonly type: string;
  readonly settings: ReadonlyMap<string, string>;
  readonly dependsOn: readonly string[];
  readonly line: number;
}

export interface InputRow {
  readonly name: string;
  readonly type: string;
  readonly title: string;
  readonly defaultValue: string;
  readonly constraints: ReadonlyMap<string, string>;
  readonly line: number;
}

/** `key=value; key=value`: the first = splits, so a value may hold one (a $dynamicEnum query). */
export function settingsOf(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of text.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) {
      if (part.trim()) out.set(part.trim(), 'true');
      continue;
    }
    const key = part.slice(0, at).trim();
    if (key) out.set(key, part.slice(at + 1).trim());
  }
  return out;
}

/**
 * The cells of a grid row. The grids split on " | " only (a pipe with a space
 * either side), so a cell may hold a bare | — a regular expression, say.
 */
export function cellsOf(line: string): string[] {
  return ` ${line.trim()} `.split(/(?<=\s)\|(?=\s)/).map((cell) => cell.trim());
}

function rowsOf(text: string): { cells: string[]; line: number }[] {
  return text
    .split('\n')
    .map((raw, index) => ({ raw: raw.trim(), line: index + 1 }))
    .filter((row) => row.raw && !row.raw.startsWith('#'))
    .map((row) => ({ cells: cellsOf(row.raw), line: row.line }));
}

export function resourceRowsOf(text: string): ResourceRow[] {
  return rowsOf(text).map(({ cells, line }) => ({
    name: cells[0] ?? '',
    type: cells[1] ?? '',
    settings: settingsOf(cells[2] ?? ''),
    dependsOn: (cells[3] ?? '').split(',').map((d) => d.trim()).filter(Boolean),
    line,
  }));
}

export function inputRowsOf(text: string): InputRow[] {
  return rowsOf(text).map(({ cells, line }) => ({
    name: cells[0] ?? '',
    type: (cells[1] ?? 'string').toLowerCase() || 'string',
    title: cells[2] ?? '',
    defaultValue: cells[3] ?? '',
    constraints: settingsOf(cells[4] ?? ''),
    line,
  }));
}

// --- the resource types ------------------------------------------------------

type Kind =
  /** A scalar, written as it is typed (quoted). */
  | 'string'
  | 'int'
  | 'bool'
  /** One of `values`. */
  | 'enum'
  /** Comma separated, written as a YAML list. */
  | 'list'
  /** key:value, comma separated, as tags. */
  | 'tags'
  /** Tag constraints, comma separated (key:value, !key:value, :hard/:soft). */
  | 'constraints'
  /** One resource by name. */
  | 'ref'
  /** Resource names, comma separated. */
  | 'refs'
  /** A shorthand this module expands itself. */
  | 'special';

interface Setting {
  readonly kind: Kind;
  readonly values?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly help: string;
}

export interface ResourceType {
  readonly type: string;
  readonly label: string;
  /** Any key is taken as given (Allocations.*, Custom.*); known keys are still checked. */
  readonly open?: boolean;
  readonly settings: Readonly<Record<string, Setting>>;
}

const S = (help: string): Setting => ({ kind: 'string', help });
const I = (help: string, min?: number, max?: number): Setting => ({ kind: 'int', help, min, max });
const B = (help: string): Setting => ({ kind: 'bool', help });
const E = (help: string, values: readonly string[]): Setting => ({ kind: 'enum', help, values });
const X = (help: string): Setting => ({ kind: 'special', help });
const TAGS: Setting = { kind: 'tags', help: 'key:value, comma separated' };
const CONSTRAINTS: Setting = { kind: 'constraints', help: 'Tag constraints, comma separated: key:value, !key:value (not), :hard or :soft' };

const MACHINE: ResourceType = {
  type: 'Cloud.vSphere.Machine',
  label: 'vSphere machine',
  settings: {
    image: S('Image mapping name'),
    imageRef: S('A vCenter template or content library item, instead of a mapping'),
    flavor: S('Flavor mapping name'),
    cpuCount: I('vCPUs, instead of a flavor', 1, 768),
    totalMemoryMB: I('Memory in MB, instead of a flavor', 256, 24 * 1024 * 1024),
    count: I('How many machines', 0, 1000),
    name: S('Machine name (a custom naming template usually decides this)'),
    description: S('Description'),
    customizationSpec: S('A vCenter guest customization specification'),
    cloudConfig: X('yes: the cloud-init in the Cloud-init box; anything else is written as given'),
    folderName: S('vCenter folder'),
    snapshotLimit: I('Snapshots allowed', 0, 32),
    networks: X('network[:static|dynamic][:v6], comma separated — the network resources, in NIC order'),
    securityGroups: X('Security group resources applied to every NIC, comma separated'),
    attachedDisks: { kind: 'refs', help: 'Disk resources to attach, comma separated' },
    constraints: CONSTRAINTS,
    storageConstraints: X('Tag constraints for the boot disk storage, comma separated'),
    bootDiskGb: I('Boot disk size in GB (storage.bootDiskCapacityInGB)', 1, 62 * 1024),
    affinity: X('A tag the machine must be placed with (a hard constraint)'),
    antiAffinity: X('A tag the machine must not be placed with (a hard negative constraint)'),
    tags: TAGS,
    remoteAccess: E('How the requester logs in', ['none', 'generatedPublicPrivateKey', 'publicPrivateKey', 'usernamePassword', 'keyPairName']),
    username: S('remoteAccess user'),
    sshKey: S('remoteAccess public key, usually ${input.sshKey}'),
    password: S('remoteAccess password, only as ${input.x} with encrypted: true, or ${secret.x}'),
    keyPair: S('remoteAccess key pair name'),
  },
};

const DISK: ResourceType = {
  type: 'Cloud.vSphere.Disk',
  label: 'vSphere disk',
  settings: {
    capacityGb: I('Size in GB', 1, 62 * 1024),
    type: E('Kind of disk', ['HDD', 'CDROM']),
    SCSIController: E('Controller', ['SCSI_Controller_0', 'SCSI_Controller_1', 'SCSI_Controller_2', 'SCSI_Controller_3']),
    unitNumber: I('Unit number on the controller', 0, 15),
    persistent: B('Survives the machine it is attached to'),
    provisioningType: E('Provisioning', ['thin', 'thick', 'eagerZeroedThick']),
    limitIops: I('IOPS limit', 0, 1000000),
    count: I('How many disks', 0, 60),
    name: S('Disk name'),
    constraints: CONSTRAINTS,
    tags: TAGS,
  },
};

const VSPHERE_NETWORK: ResourceType = {
  type: 'Cloud.vSphere.Network',
  label: 'vSphere network',
  settings: {
    networkType: E('existing: a port group the network profile offers; the others need NSX in the profile', ['existing', 'public', 'private', 'outbound']),
    name: S('Network name'),
    constraints: CONSTRAINTS,
    tags: TAGS,
  },
};

const NSX_NETWORK: ResourceType = {
  type: 'Cloud.NSX.Network',
  label: 'NSX network',
  settings: {
    networkType: E('existing, routed (on-demand, routed through the Tier-1), outbound (on-demand behind NAT), private (on-demand, no uplink)', ['existing', 'public', 'routed', 'outbound', 'private']),
    name: S('Network name'),
    networkCidr: S('CIDR for an on-demand network, IPv4 or IPv6 (VERIFY: IPv6 on-demand on your release)'),
    constraints: CONSTRAINTS,
    tags: TAGS,
  },
};

const NSX_GATEWAY: ResourceType = {
  type: 'Cloud.NSX.Gateway',
  label: 'NSX gateway',
  settings: {
    networks: { kind: 'refs', help: 'Network resources the gateway connects, comma separated' },
    name: S('Gateway name'),
    tags: TAGS,
  },
};

const NSX_NAT: ResourceType = {
  type: 'Cloud.NSX.NAT',
  label: 'NSX NAT',
  settings: {
    gateway: { kind: 'ref', help: 'The Cloud.NSX.Gateway resource' },
    natRules: X('PROTOCOL:gatewayPort>machine:port, comma separated, e.g. TCP:8080>web:80'),
  },
};

const NSX_LB: ResourceType = {
  type: 'Cloud.NSX.LoadBalancer',
  label: 'NSX load balancer',
  settings: {
    network: { kind: 'ref', help: 'The network resource the virtual server is on' },
    instances: { kind: 'refs', help: 'Machine resources in the pool, comma separated' },
    routes: X('PROTOCOL:port>PROTOCOL:instancePort, comma separated, e.g. HTTPS:443>HTTPS:8443'),
    healthCheck: X('PROTOCOL:port[:/path], applied to every route, e.g. HTTP:8080:/health'),
    healthInterval: I('Seconds between health checks', 1, 3600),
    healthTimeout: I('Seconds before a check fails', 1, 3600),
    unhealthyThreshold: I('Failures before a member is down', 1, 100),
    healthyThreshold: I('Successes before a member is up', 1, 100),
    internetFacing: B('A public VIP'),
    type: E('Load balancer size', ['SMALL', 'MEDIUM', 'LARGE', 'XLARGE']),
    loggingLevel: E('Logging level', ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL', 'ALERT', 'EMERGENCY']),
    name: S('Load balancer name'),
    tags: TAGS,
  },
};

const SECURITY_GROUP: ResourceType = {
  type: 'Cloud.SecurityGroup',
  label: 'Security group',
  settings: {
    securityGroupType: E('existing: an NSX group chosen by constraint; new: created with the deployment from the rules', ['existing', 'new']),
    constraints: CONSTRAINTS,
    rules: X('name direction access protocol ports source, comma separated, e.g. https inbound Allow TCP 443 ANY'),
    name: S('Security group name'),
    tags: TAGS,
  },
};

const ANSIBLE: ResourceType = {
  type: 'Cloud.Ansible',
  label: 'Ansible (open source)',
  settings: {
    host: { kind: 'ref', help: 'The machine resource it configures' },
    account: S('The Ansible integration name'),
    osType: E('Guest OS family', ['linux', 'windows']),
    username: S('Login on the machine'),
    privateKeyFile: S('Key file on the Ansible control node'),
    password: S('Only as ${input.x} (encrypted) or ${secret.x}'),
    useSudo: B('Run with sudo'),
    inventoryFile: S('Inventory file on the control node'),
    groups: { kind: 'list', help: 'Inventory groups, comma separated' },
    playbooks: X('Playbooks run at provisioning, comma separated'),
    deprovisionPlaybooks: X('Playbooks run at removal, comma separated'),
    maxConnectionRetries: I('Connection retries', 0, 100),
  },
};

const AAP: ResourceType = {
  type: 'Cloud.Ansible.Tower',
  label: 'Ansible Automation Platform',
  settings: {
    host: { kind: 'ref', help: 'The machine resource it configures' },
    account: S('The Ansible Automation Platform integration name'),
    inventoryName: S('AAP inventory'),
    jobTemplates: X('Job templates run at provisioning, comma separated'),
    deprovisionJobTemplates: X('Job templates run at removal, comma separated'),
    groups: { kind: 'list', help: 'Inventory groups, comma separated' },
  },
};

const ALLOCATIONS: readonly ResourceType[] = [
  { type: 'Allocations.CloudZone', label: 'Allocation: cloud zone', open: true, settings: { accountType: S('vsphere'), constraints: CONSTRAINTS } },
  { type: 'Allocations.Flavor', label: 'Allocation: flavor', open: true, settings: { flavor: S('Flavor mapping'), cpuCount: I('vCPUs', 1, 768), memoryMb: I('Memory in MB', 256), cloudZone: S('${resource.<zone>.selectedCloudZone}') } },
  { type: 'Allocations.Image', label: 'Allocation: image', open: true, settings: { image: S('Image mapping'), cloudZone: S('${resource.<zone>.selectedCloudZone}') } },
  { type: 'Allocations.Network', label: 'Allocation: network', open: true, settings: { networkType: E('Network type', ['existing', 'public', 'private', 'outbound', 'routed']), constraints: CONSTRAINTS, cloudZone: S('${resource.<zone>.selectedCloudZone}') } },
];

/** Every type the resource grid takes, apart from Custom.* (any custom resource type). */
export const RESOURCE_TYPES: readonly ResourceType[] = [MACHINE, DISK, VSPHERE_NETWORK, NSX_NETWORK, NSX_GATEWAY, NSX_NAT, NSX_LB, SECURITY_GROUP, ANSIBLE, AAP, ...ALLOCATIONS];

const CUSTOM: ResourceType = { type: 'Custom.*', label: 'Custom resource', open: true, settings: {} };

/** An allocation helper this page has no settings list for: written as given, with a warning. */
const OTHER_ALLOCATION: ResourceType = { type: 'Allocations.*', label: 'Allocation helper', open: true, settings: { constraints: CONSTRAINTS } };

export function resourceTypeOf(type: string): ResourceType | undefined {
  if (/^Custom\.[A-Za-z][A-Za-z0-9_.]*$/.test(type)) return CUSTOM;
  return RESOURCE_TYPES.find((t) => t.type === type) ?? (/^Allocations\.[A-Za-z]+$/.test(type) ? OTHER_ALLOCATION : undefined);
}

// --- the input types -----------------------------------------------------------

export const INPUT_TYPES = ['string', 'integer', 'number', 'boolean', 'object', 'array'] as const;

/** Constraint keys an input takes. min/max mean length for a string and items for an array. */
const INPUT_KEYS = ['enum', 'min', 'max', 'pattern', 'encrypted', 'readOnly', 'description', 'format', '$dynamicEnum', '$dynamicDefault', '$ref', '$data', 'populateRequiredOnNonDefaultProperties'];

// --- YAML ---------------------------------------------------------------------------

function q(text: string): string {
  return JSON.stringify(text);
}

function scalarOf(value: string, kind: Kind): string {
  if (kind === 'int' && /^-?\d+$/.test(value)) return value;
  if (kind === 'bool' && /^(true|false)$/.test(value)) return value;
  return q(value);
}

function inputScalar(value: string, type: string): string {
  if ((type === 'integer' || type === 'number') && /^-?\d+(\.\d+)?$/.test(value)) return value;
  if (type === 'boolean' && /^(true|false)$/.test(value)) return value;
  return q(value);
}

const EXPR = /\$\{[^}]*\}/;
const isExpr = (value: string): boolean => EXPR.test(value);
const listOfCsv = (value: string): string[] => value.split(',').map((v) => v.trim()).filter(Boolean);

/** A resource name, or an expression, as the id expression a property wants. */
function refExpr(value: string, field = 'id'): string {
  return isExpr(value) ? value : `\${resource.${value}.${field}}`;
}

// --- references -------------------------------------------------------------------

/** The resources and inputs an expression refers to. */
export function referencesIn(text: string): { resources: string[]; inputs: string[] } {
  const resources: string[] = [];
  const inputs: string[] = [];
  for (const match of text.matchAll(/\$\{([^}]*)\}/g)) {
    const body = match[1] ?? '';
    for (const r of body.matchAll(/\bresource\.([A-Za-z][A-Za-z0-9_]*)/g)) resources.push(r[1]!);
    for (const r of body.matchAll(/\bresource\[['"]([^'"]+)['"]\]/g)) resources.push(r[1]!);
    for (const r of body.matchAll(/\binput\.([A-Za-z][A-Za-z0-9_]*)/g)) inputs.push(r[1]!);
  }
  return { resources, inputs };
}

/** Resource names a setting refers to by name rather than by expression. */
function namedRefs(type: ResourceType, key: string, value: string): string[] {
  const setting = type.settings[key];
  if (!setting || isExpr(value)) return [];
  if (setting.kind === 'ref') return [value];
  if (setting.kind === 'refs') return listOfCsv(value);
  if (type === MACHINE && key === 'networks') return listOfCsv(value).map((n) => n.split(':')[0]!.trim());
  if (type === MACHINE && key === 'securityGroups') return listOfCsv(value);
  if (type === NSX_NAT && key === 'natRules') return listOfCsv(value).map((r) => /^[^>]*>([^:]+)/.exec(r)?.[1]?.trim() ?? '').filter((n) => n && !isExpr(n));
  return [];
}

// --- the build ----------------------------------------------------------------------

export interface TemplateModel {
  readonly yaml: string;
  readonly findings: Finding[];
  readonly resources: readonly ResourceRow[];
  readonly inputs: readonly InputRow[];
  /** Inputs with an enum, a max or a pattern: the constrained ones. */
  readonly constrainedInputs: readonly string[];
  /** Placement constraints written on machines and networks. */
  readonly placementTags: readonly string[];
  /** Image and flavor mapping names the template needs in each region. */
  readonly mappings: { readonly images: readonly string[]; readonly flavors: readonly string[] };
}

export interface TemplateSpec {
  readonly title: string;
  readonly resources: string;
  readonly inputs: string;
  readonly cloudConfig: string;
  /** Extra inputs, and tags on every machine, added by the page's toggles. */
  readonly extraInputs?: readonly InputRow[];
  readonly machineTags?: readonly { readonly key: string; readonly value: string }[];
  readonly header?: readonly string[];
}

const SRC = 'VCF Automation 9.1 cloud template reference (VERIFY per resource type)';

export function buildTemplate(spec: TemplateSpec): TemplateModel {
  const findings: Finding[] = [];
  const bad = (code: string, message: string, remediation?: string) => findings.push(error(code, message, { source: SRC, ...(remediation ? { remediation } : {}) }));
  const warn = (code: string, message: string, remediation?: string) => findings.push(warning(code, message, { source: SRC, ...(remediation ? { remediation } : {}) }));

  const resources = resourceRowsOf(spec.resources);
  const inputs = [...inputRowsOf(spec.inputs), ...(spec.extraInputs ?? [])];
  const names = new Set<string>();
  const inputNames = new Set<string>();

  // --- inputs
  const constrained: string[] = [];
  for (const input of inputs) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(input.name)) bad('vcfa.template.bad-input-name', `Input "${input.name}" (inputs row ${input.line}) is not a valid name: letters, digits and _, starting with a letter.`);
    if (inputNames.has(input.name)) bad('vcfa.template.duplicate-input', `Input "${input.name}" is defined twice.`);
    inputNames.add(input.name);
    if (!(INPUT_TYPES as readonly string[]).includes(input.type)) bad('vcfa.template.bad-input-type', `Input "${input.name}" has type "${input.type}"; the types are ${INPUT_TYPES.join(', ')}.`);
    for (const key of input.constraints.keys()) {
      if (!INPUT_KEYS.includes(key)) warn('vcfa.template.unknown-input-key', `Input "${input.name}" has "${key}", which is not an input keyword this page knows (${INPUT_KEYS.join(', ')}); it is written as given.`);
    }
    const c = input.constraints;
    const enumValues = c.has('enum') ? listOfCsv(c.get('enum')!) : [];
    const min = c.has('min') ? Number(c.get('min')) : undefined;
    const max = c.has('max') ? Number(c.get('max')) : undefined;
    if ((min !== undefined && !Number.isFinite(min)) || (max !== undefined && !Number.isFinite(max))) bad('vcfa.template.bad-bound', `Input "${input.name}": min and max must be numbers.`);
    if (min !== undefined && max !== undefined && min > max) bad('vcfa.template.bad-bound', `Input "${input.name}": min ${min} is above max ${max}.`);
    let regex: RegExp | undefined;
    if (c.has('pattern')) {
      try {
        regex = new RegExp(c.get('pattern')!);
      } catch {
        bad('vcfa.template.bad-pattern', `Input "${input.name}": the pattern ${c.get('pattern')} is not a valid regular expression.`);
      }
    }
    if (enumValues.length > 0 || max !== undefined || regex || c.has('$dynamicEnum') || input.type === 'boolean') constrained.push(input.name);
    const d = input.defaultValue;
    if (d !== '' && !isExpr(d)) {
      if (enumValues.length > 0 && !enumValues.includes(d)) bad('vcfa.template.bad-default', `Input "${input.name}": the default ${d} is not one of its enum (${enumValues.join(', ')}).`, 'A default outside the enum is refused when the request form opens.');
      if (input.type === 'integer' && !/^-?\d+$/.test(d)) bad('vcfa.template.bad-default', `Input "${input.name}" is an integer and its default ${d} is not.`);
      if (input.type === 'number' && !Number.isFinite(Number(d))) bad('vcfa.template.bad-default', `Input "${input.name}" is a number and its default ${d} is not.`);
      if (input.type === 'boolean' && !/^(true|false)$/.test(d)) bad('vcfa.template.bad-default', `Input "${input.name}" is a boolean and its default ${d} is neither true nor false.`);
      const measure = input.type === 'integer' || input.type === 'number' ? Number(d) : input.type === 'string' ? d.length : undefined;
      if (measure !== undefined && Number.isFinite(measure) && ((min !== undefined && measure < min) || (max !== undefined && measure > max))) {
        bad('vcfa.template.bad-default', `Input "${input.name}": the default ${d} is outside ${min ?? '…'}–${max ?? '…'}${input.type === 'string' ? ' characters' : ''}.`);
      }
      if (regex && input.type === 'string' && !regex.test(d)) bad('vcfa.template.bad-default', `Input "${input.name}": the default ${d} does not match its own pattern.`);
    }
    if (/password|secret|token/i.test(input.name) && c.get('encrypted') !== 'true') {
      warn('vcfa.template.unencrypted-secret', `Input "${input.name}" looks like a secret but is not encrypted: true.`, 'An unencrypted input is shown in the deployment’s request details to everyone who can see the deployment. Add encrypted=true, or use a ${secret.name} instead of an input.');
    }
  }

  // --- resources
  const types = new Map<string, ResourceType>();
  for (const row of resources) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(row.name)) bad('vcfa.template.bad-resource-name', `Resource "${row.name}" (resources row ${row.line}) is not a valid name: letters, digits and _, starting with a letter.`, 'Other resources refer to it as ${resource.<name>...}: a hyphen or a space makes it unreachable.');
    if (names.has(row.name)) bad('vcfa.template.duplicate-resource', `Resource "${row.name}" is defined twice.`);
    names.add(row.name);
    if (/^Cloud\.(AWS|Azure|GCP|Google)\b/i.test(row.type)) {
      bad('vcfa.template.public-cloud', `${row.name}: ${row.type} is a public cloud resource type, and public cloud accounts are deprecated in VCF Automation 9.1.`, 'Use the vSphere and NSX types.');
      continue;
    }
    const type = resourceTypeOf(row.type);
    if (!type) {
      bad('vcfa.template.unknown-type', `${row.name}: "${row.type}" is not a resource type this page writes. Use one of ${RESOURCE_TYPES.map((t) => t.type).join(', ')}, or Custom.<name> for a custom resource.`);
      continue;
    }
    if (row.type.startsWith('Allocations.') && !RESOURCE_TYPES.some((t) => t.type === row.type)) warn('vcfa.template.unknown-type', `${row.name}: ${row.type} is not an allocation helper this page knows; it is written as given.`);
    types.set(row.name, type);
    for (const [key, value] of row.settings) {
      const setting = type.settings[key];
      if (!setting) {
        if (!type.open) warn('vcfa.template.unknown-property', `${row.name}: "${key}" is not a ${row.type} property this page knows (${Object.keys(type.settings).join(', ')}); it is written as given.`);
        continue;
      }
      if (isExpr(value)) continue;
      if (setting.kind === 'int') {
        const n = Number(value);
        if (!/^-?\d+$/.test(value)) bad('vcfa.template.bad-value', `${row.name}: ${key} must be a whole number or an expression, not ${value}.`);
        else if ((setting.min !== undefined && n < setting.min) || (setting.max !== undefined && n > setting.max)) bad('vcfa.template.bad-value', `${row.name}: ${key} ${value} is outside ${setting.min ?? '…'}–${setting.max ?? '…'}.`);
      }
      if (setting.kind === 'bool' && !/^(true|false)$/.test(value)) bad('vcfa.template.bad-value', `${row.name}: ${key} is true or false, not ${value}.`);
      if (setting.kind === 'enum' && !setting.values!.includes(value)) bad('vcfa.template.bad-value', `${row.name}: ${key} is one of ${setting.values!.join(', ')}, not ${value}.`);
    }
  }

  // --- references and dependencies
  const deps = new Map<string, Set<string>>();
  const usedInputs = new Set<string>();
  const checkRefs = (owner: string, text: string, where: string) => {
    const refs = referencesIn(text);
    for (const r of refs.resources) {
      if (!names.has(r)) bad('vcfa.template.missing-resource', `${where} refers to resource "${r}", which the template does not have.`);
      else if (owner && r !== owner) deps.get(owner)?.add(r);
      if (owner && r === owner && !/self\./.test(text)) warn('vcfa.template.self-reference', `${where} refers to itself as resource.${r}; use \${self.<property>}.`);
    }
    for (const i of refs.inputs) {
      usedInputs.add(i);
      if (!inputNames.has(i)) bad('vcfa.template.missing-input', `${where} uses \${input.${i}}, which is not in the inputs.`, 'An undefined input is a template that fails validation on import — or, in older releases, a request form with the value quietly empty.');
    }
  };
  for (const row of resources) deps.set(row.name, new Set(row.dependsOn));
  for (const row of resources) {
    const type = types.get(row.name);
    for (const dep of row.dependsOn) if (!names.has(dep)) bad('vcfa.template.missing-resource', `${row.name} depends on "${dep}", which the template does not have.`);
    for (const [key, value] of row.settings) {
      checkRefs(row.name, value, `${row.name}.${key}`);
      if (!type) continue;
      for (const ref of namedRefs(type, key, value)) {
        if (!names.has(ref)) bad('vcfa.template.missing-resource', `${row.name}.${key} names resource "${ref}", which the template does not have.`);
        else if (ref !== row.name) deps.get(row.name)!.add(ref);
      }
    }
    if (type === MACHINE && row.settings.get('cloudConfig') === 'yes') checkRefs(row.name, spec.cloudConfig, `${row.name} cloud-init`);
  }
  for (const input of inputs) for (const [, value] of input.constraints) checkRefs('', value, `Input ${input.name}`);

  // A loop: the template is refused on import.
  const state = new Map<string, 'open' | 'done'>();
  const cycles: string[] = [];
  const visit = (node: string, path: string[]) => {
    if (state.get(node) === 'done') return;
    if (state.get(node) === 'open') {
      cycles.push([...path.slice(path.indexOf(node)), node].join(' → '));
      return;
    }
    state.set(node, 'open');
    for (const next of deps.get(node) ?? []) if (names.has(next)) visit(next, [...path, node]);
    state.set(node, 'done');
  };
  for (const name of names) visit(name, []);
  for (const cycle of [...new Set(cycles)]) bad('vcfa.template.cycle', `The resources depend on each other in a loop: ${cycle}.`, 'VCF Automation cannot order a loop; the template is refused. Break it by removing a dependsOn or a reference.');

  for (const input of inputs) {
    if (!usedInputs.has(input.name) && !(spec.extraInputs ?? []).some((e) => e.name === input.name)) warn('vcfa.template.unused-input', `Input "${input.name}" is asked for and never used.`, 'The requester fills it in and nothing reads it. Use it, or remove it.');
  }

  // --- what each kind needs
  const inputOf = (value: string | undefined) => (value ? referencesIn(value).inputs[0] : undefined);
  const images: string[] = [];
  const flavors: string[] = [];
  const placement: string[] = [];
  for (const row of resources) {
    const type = types.get(row.name);
    const s = row.settings;
    if (type === MACHINE) {
      if (!s.get('image') && !s.get('imageRef')) bad('vcfa.template.no-image', `${row.name} has no image or imageRef.`);
      if (!s.get('flavor') && !(s.get('cpuCount') && s.get('totalMemoryMB'))) bad('vcfa.template.no-size', `${row.name} has neither a flavor nor cpuCount and totalMemoryMB.`);
      if (s.get('image') && !isExpr(s.get('image')!)) images.push(s.get('image')!);
      if (s.get('flavor') && !isExpr(s.get('flavor')!)) flavors.push(s.get('flavor')!);
      for (const key of ['flavor', 'cpuCount', 'totalMemoryMB', 'count']) {
        const name = inputOf(s.get(key));
        if (name && inputNames.has(name) && !constrained.includes(name)) {
          warn('vcfa.template.unbounded-input', `${row.name}.${key} comes from input "${name}", which has no enum, max or pattern.`, 'An unconstrained size input is how a self-service catalogue produces development machines larger than production. Give it an enum or a max.');
        }
      }
      const count = s.get('count');
      if (s.get('attachedDisks') && count && count !== '1') warn('vcfa.template.disk-count', `${row.name} has count ${count} and attaches disks by name: every copy of the machine would try to attach the same disk.`, 'Give the disk the same count and attach it with ${map_to_object(resource.<disk>[count.index].id, "source")}, or keep count at 1.');
      if (!s.get('networks')) warn('vcfa.template.machine-no-network', `${row.name} is connected to no network resource.`, 'It is then placed on whatever network the network profile offers first.');
      if (s.get('remoteAccess') === 'usernamePassword' && s.get('password') && !isExpr(s.get('password')!)) bad('vcfa.template.literal-password', `${row.name}: the remoteAccess password is written into the template.`, 'Use ${input.<name>} with encrypted=true, or ${secret.<name>}.');
      if (s.get('remoteAccess') === 'publicPrivateKey' && !s.get('sshKey')) bad('vcfa.template.no-ssh-key', `${row.name}: remoteAccess publicPrivateKey needs sshKey.`);
      if (s.get('constraints')) placement.push(...listOfCsv(s.get('constraints')!));
    }
    if (type === VSPHERE_NETWORK || type === NSX_NETWORK) {
      const nt = s.get('networkType') ?? 'existing';
      if (nt === 'existing' && !s.get('constraints')) warn('vcfa.template.network-unconstrained', `${row.name} is an existing network with no constraint, so it is whichever network the profile lists first.`, 'Add a constraint on a capability tag of the network (e.g. net:app).');
      if (s.get('constraints')) placement.push(...listOfCsv(s.get('constraints')!));
      if (s.get('networkCidr') && !isExpr(s.get('networkCidr')!) && !parseCidrAny(s.get('networkCidr')!)) bad('vcfa.template.bad-value', `${row.name}: networkCidr ${s.get('networkCidr')} is not an IPv4 or IPv6 CIDR.`);
    }
    if (type === NSX_GATEWAY && !s.get('networks')) bad('vcfa.template.gateway-no-network', `${row.name} is a gateway connecting no networks.`);
    if (type === NSX_NAT) {
      if (!s.get('gateway')) bad('vcfa.template.nat-no-gateway', `${row.name} has no gateway.`);
      else if (!isExpr(s.get('gateway')!) && types.get(s.get('gateway')!) && types.get(s.get('gateway')!) !== NSX_GATEWAY) bad('vcfa.template.bad-reference', `${row.name}.gateway names ${s.get('gateway')}, which is not a Cloud.NSX.Gateway.`);
      if (!s.get('natRules')) bad('vcfa.template.nat-no-rules', `${row.name} has no natRules.`);
    }
    if (type === NSX_LB) {
      if (!s.get('instances')) bad('vcfa.template.lb-no-members', `${row.name} has no instances in its pool.`);
      if (!s.get('routes')) bad('vcfa.template.lb-no-routes', `${row.name} has no routes.`);
      if (!s.get('network')) bad('vcfa.template.lb-no-network', `${row.name} has no network for its virtual server.`);
      if (s.get('routes') && !s.get('healthCheck')) warn('vcfa.template.lb-no-health', `${row.name} has no health check, so a member that stops answering still gets traffic.`);
    }
    if (type === SECURITY_GROUP) {
      const kind = s.get('securityGroupType') ?? 'existing';
      if (kind === 'existing' && !s.get('constraints')) bad('vcfa.template.sg-no-constraint', `${row.name} is an existing security group with no constraint to find it by.`);
      if (kind === 'new' && !s.get('rules')) bad('vcfa.template.sg-no-rules', `${row.name} is a new security group with no rules.`);
    }
    if ((type === ANSIBLE || type === AAP) && !s.get('host')) bad('vcfa.template.ansible-no-host', `${row.name} has no host machine.`);
    if ((type === ANSIBLE || type === AAP) && !s.get('account')) bad('vcfa.template.ansible-no-account', `${row.name} names no Ansible integration (account).`, 'The integration is created by the integrations blueprint; account is its name.');
    if (type === ANSIBLE && s.get('host') && !isExpr(s.get('host')!) && types.get(s.get('host')!) && types.get(s.get('host')!) !== MACHINE) bad('vcfa.template.bad-reference', `${row.name}.host names ${s.get('host')}, which is not a machine.`);
  }

  // --- render
  const out: string[] = [...(spec.header ?? []), 'formatVersion: 1'];
  if (inputs.length > 0) {
    out.push('inputs:');
    for (const input of inputs) {
      const c = input.constraints;
      out.push(`  ${input.name}:`, `    type: ${input.type}`);
      if (input.title) out.push(`    title: ${q(input.title)}`);
      if (c.get('description')) out.push(`    description: ${q(c.get('description')!)}`);
      if (c.has('enum')) out.push('    enum:', ...listOfCsv(c.get('enum')!).map((v) => `      - ${inputScalar(v, input.type)}`));
      const lo = input.type === 'string' ? 'minLength' : input.type === 'array' ? 'minItems' : 'minimum';
      const hi = input.type === 'string' ? 'maxLength' : input.type === 'array' ? 'maxItems' : 'maximum';
      if (c.has('min')) out.push(`    ${lo}: ${Number(c.get('min'))}`);
      if (c.has('max')) out.push(`    ${hi}: ${Number(c.get('max'))}`);
      if (c.has('pattern')) out.push(`    pattern: ${q(c.get('pattern')!)}`);
      if (c.has('format')) out.push(`    format: ${q(c.get('format')!)}`);
      if (c.get('encrypted') === 'true') out.push('    encrypted: true');
      if (c.get('readOnly') === 'true') out.push('    readOnly: true');
      for (const key of ['$dynamicEnum', '$dynamicDefault', '$ref', '$data']) if (c.has(key)) out.push(`    ${q(key)}: ${q(c.get(key)!)}`);
      for (const [key, value] of c) if (!INPUT_KEYS.includes(key)) out.push(`    ${q(key)}: ${q(value)}`);
      if (input.defaultValue !== '') out.push(`    default: ${inputScalar(input.defaultValue, input.type)}`);
    }
  }
  out.push('resources:');
  for (const row of resources) {
    const type = types.get(row.name);
    out.push(`  ${row.name}:`, `    type: ${row.type}`);
    const explicit = row.dependsOn.filter((d) => names.has(d));
    if (explicit.length > 0) out.push('    dependsOn:', ...explicit.map((d) => `      - ${d}`));
    const props = type ? renderProps(row, type, spec) : [...row.settings].map(([k, v]) => `${q(k)}: ${q(v)}`);
    if (props.length > 0) out.push('    properties:', ...props.map((line) => `      ${line}`));
  }
  out.push('');

  return {
    yaml: out.join('\n'),
    findings,
    resources,
    inputs,
    constrainedInputs: constrained,
    placementTags: [...new Set(placement)],
    mappings: { images: [...new Set(images)], flavors: [...new Set(flavors)] },
  };

  // The properties of one resource, relative to `properties:`.
  function renderProps(row: ResourceRow, type: ResourceType, templateSpec: TemplateSpec): string[] {
    const s = row.settings;
    const lines: string[] = [];
    const done = new Set<string>();
    const take = (key: string) => {
      done.add(key);
      return s.get(key);
    };
    const constraintLines = (items: readonly string[], negate = false) => items.map((tag) => `  - tag: ${q(negate && !tag.startsWith('!') ? `!${tag}` : tag)}`);

    if (type === MACHINE) {
      for (const key of ['image', 'imageRef', 'flavor', 'cpuCount', 'totalMemoryMB', 'count', 'name', 'description', 'customizationSpec', 'folderName', 'snapshotLimit']) {
        const v = take(key);
        if (v !== undefined) lines.push(`${key}: ${scalarOf(v, type.settings[key]!.kind)}`);
      }
      const cc = take('cloudConfig');
      if (cc === 'yes' || cc === 'true') {
        const body = templateSpec.cloudConfig.replace(/\s+$/, '');
        if (body) lines.push('cloudConfig: |', ...body.split('\n').map((l) => `  ${l}`));
      } else if (cc && cc !== 'no' && cc !== 'false') lines.push(`cloudConfig: ${q(cc)}`);
      const ra = take('remoteAccess');
      const user = take('username');
      const key = take('sshKey');
      const pw = take('password');
      const pair = take('keyPair');
      if (ra && ra !== 'none') {
        lines.push('remoteAccess:', `  authentication: ${ra}`);
        if (user) lines.push(`  username: ${q(user)}`);
        if (key) lines.push(`  sshKey: ${q(key)}`);
        if (pw) lines.push(`  password: ${q(pw)}`);
        if (pair) lines.push(`  keyPair: ${q(pair)}`);
      }
      const sgs = listOfCsv(take('securityGroups') ?? '');
      const nets = listOfCsv(take('networks') ?? '');
      if (nets.length > 0) {
        lines.push('networks:');
        nets.forEach((entry, index) => {
          const [net = '', ...flags] = entry.split(':').map((p) => p.trim());
          const assignment = flags.find((f) => f === 'static' || f === 'dynamic' || f === 'dhcp');
          lines.push(`  - network: ${q(refExpr(net))}`, `    deviceIndex: ${index}`);
          if (assignment) lines.push(`    assignment: ${assignment === 'dhcp' ? 'dynamic' : assignment}`);
          if (flags.includes('v6')) lines.push('    assignIPv6Address: true');
          if (sgs.length > 0) lines.push('    securityGroups:', ...sgs.map((g) => `      - ${q(refExpr(g))}`));
        });
      }
      const disks = listOfCsv(take('attachedDisks') ?? '');
      if (disks.length > 0) lines.push('attachedDisks:', ...disks.map((d) => `  - source: ${q(refExpr(d))}`));
      const constraints = [...listOfCsv(take('constraints') ?? ''), ...listOfCsv(take('affinity') ?? '').map((t) => (/:(hard|soft)$/.test(t) ? t : `${t}:hard`)), ...listOfCsv(take('antiAffinity') ?? '').map((t) => `!${(/:(hard|soft)$/.test(t) ? t : `${t}:hard`).replace(/^!/, '')}`)];
      if (constraints.length > 0) lines.push('constraints:', ...constraintLines(constraints));
      const boot = take('bootDiskGb');
      const storage = listOfCsv(take('storageConstraints') ?? '');
      if (boot || storage.length > 0) {
        lines.push('storage:');
        if (boot) lines.push(`  bootDiskCapacityInGB: ${scalarOf(boot, 'int')}`);
        if (storage.length > 0) lines.push('  constraints:', ...constraintLines(storage).map((l) => `  ${l}`));
      }
      const tags = [...tagsOf(take('tags') ?? ''), ...(templateSpec.machineTags ?? [])];
      if (tags.length > 0) lines.push('tags:', ...tags.flatMap((t) => [`  - key: ${q(t.key)}`, `    value: ${q(t.value)}`]));
    }

    if (type === NSX_NAT) {
      const gw = take('gateway');
      if (gw) lines.push(`gateway: ${q(refExpr(gw))}`);
      const rules = listOfCsv(take('natRules') ?? '');
      if (rules.length > 0) {
        lines.push('natRules:');
        rules.forEach((rule, index) => {
          const m = /^(TCP|UDP|ANY):(\d+)>([^:]+):(\d+)$/i.exec(rule);
          if (!m) {
            bad('vcfa.template.bad-value', `${row.name}: NAT rule "${rule}" is not PROTOCOL:gatewayPort>machine:port.`);
            return;
          }
          lines.push(`  - index: ${index}`, `    protocol: ${m[1]!.toUpperCase()}`, '    kind: NAT44', `    sourcePorts: ${q(m[2]!)}`, `    translatedInstance: ${q(refExpr(m[3]!.trim()))}`, `    translatedPorts: ${q(m[4]!)}`);
        });
      }
    }

    if (type === NSX_LB) {
      for (const k of ['name', 'type', 'loggingLevel', 'internetFacing']) {
        const v = take(k);
        if (v !== undefined) lines.push(`${k}: ${scalarOf(v, type.settings[k]!.kind)}`);
      }
      const net = take('network');
      if (net) lines.push(`network: ${q(refExpr(net))}`);
      const members = listOfCsv(take('instances') ?? '');
      if (members.length > 0) lines.push('instances:', ...members.map((m) => `  - ${q(refExpr(m))}`));
      const hc = take('healthCheck');
      const interval = take('healthInterval');
      const timeout = take('healthTimeout');
      const unhealthy = take('unhealthyThreshold');
      const healthy = take('healthyThreshold');
      const hcm = hc ? /^(HTTP|HTTPS|TCP|UDP|ICMP):(\d+)(?::(\/.*))?$/i.exec(hc) : null;
      if (hc && !hcm) bad('vcfa.template.bad-value', `${row.name}: healthCheck "${hc}" is not PROTOCOL:port or PROTOCOL:port:/path.`);
      const routes = listOfCsv(take('routes') ?? '');
      if (routes.length > 0) {
        lines.push('routes:');
        for (const route of routes) {
          const m = /^(HTTP|HTTPS|TCP|UDP):(\d+)>(HTTP|HTTPS|TCP|UDP):(\d+)$/i.exec(route);
          if (!m) {
            bad('vcfa.template.bad-value', `${row.name}: route "${route}" is not PROTOCOL:port>PROTOCOL:instancePort.`);
            continue;
          }
          lines.push(`  - protocol: ${m[1]!.toUpperCase()}`, `    port: ${q(m[2]!)}`, `    instanceProtocol: ${m[3]!.toUpperCase()}`, `    instancePort: ${q(m[4]!)}`);
          if (hcm) {
            lines.push('    healthCheckConfiguration:', `      protocol: ${hcm[1]!.toUpperCase()}`, `      port: ${q(hcm[2]!)}`);
            if (hcm[3]) lines.push(`      urlPath: ${q(hcm[3])}`);
            lines.push(`      intervalSeconds: ${interval ?? 5}`, `      timeoutSeconds: ${timeout ?? 15}`, `      unhealthyThreshold: ${unhealthy ?? 3}`, `      healthyThreshold: ${healthy ?? 2}`);
          }
        }
      }
      const tags = tagsOf(take('tags') ?? '');
      if (tags.length > 0) lines.push('tags:', ...tags.flatMap((t) => [`  - key: ${q(t.key)}`, `    value: ${q(t.value)}`]));
    }

    if (type === SECURITY_GROUP) {
      const kind = take('securityGroupType') ?? 'existing';
      lines.push(`securityGroupType: ${kind}`);
      const rules = listOfCsv(take('rules') ?? '');
      if (rules.length > 0) {
        lines.push('rules:');
        for (const rule of rules) {
          const [rname = '', direction = '', access = '', protocol = '', ports = '', peer = 'ANY'] = rule.split(/\s+/);
          const problems: string[] = [];
          if (!['inbound', 'outbound'].includes(direction)) problems.push('direction is inbound or outbound');
          if (!['Allow', 'Deny', 'Drop'].includes(access)) problems.push('access is Allow, Deny or Drop');
          if (!['TCP', 'UDP', 'ICMP', 'ICMPv6', 'ANY'].includes(protocol)) problems.push('protocol is TCP, UDP, ICMP, ICMPv6 or ANY');
          if (!/^(ANY|\d+(-\d+)?)$/.test(ports)) problems.push('ports is ANY, a port or a range');
          if (peer !== 'ANY' && !isExpr(peer) && !parseCidrAny(peer)) problems.push('the peer is ANY or an IPv4/IPv6 CIDR');
          if (problems.length > 0) {
            bad('vcfa.template.bad-value', `${row.name}: rule "${rule}" — ${problems.join('; ')} (name direction access protocol ports peer).`);
            continue;
          }
          lines.push(`  - name: ${q(rname)}`, `    direction: ${direction}`, `    access: ${access}`, `    protocol: ${protocol}`, `    ports: ${q(ports)}`, `    ${direction === 'inbound' ? 'source' : 'destination'}: ${q(peer)}`);
        }
      }
      const c = listOfCsv(take('constraints') ?? '');
      if (c.length > 0) lines.push('constraints:', ...constraintLines(c));
    }

    if (type === ANSIBLE) {
      const host = take('host');
      if (host) lines.push(`host: ${q(isExpr(host) ? host : `\${resource.${host}.*}`)}`);
      const provision = listOfCsv(take('playbooks') ?? '');
      const deprovision = listOfCsv(take('deprovisionPlaybooks') ?? '');
      if (provision.length + deprovision.length > 0) {
        lines.push('playbooks:');
        if (provision.length > 0) lines.push('  provision:', ...provision.map((p) => `    - ${q(p)}`));
        if (deprovision.length > 0) lines.push('  de-provision:', ...deprovision.map((p) => `    - ${q(p)}`));
      }
    }

    if (type === AAP) {
      const host = take('host');
      if (host) lines.push(`host: ${q(isExpr(host) ? host : `\${resource.${host}.*}`)}`);
      const provision = listOfCsv(take('jobTemplates') ?? '');
      const deprovision = listOfCsv(take('deprovisionJobTemplates') ?? '');
      if (provision.length + deprovision.length > 0) {
        lines.push('templates:');
        if (provision.length > 0) lines.push('  provision:', ...provision.map((p) => `    - name: ${q(p)}`));
        if (deprovision.length > 0) lines.push('  de-provision:', ...deprovision.map((p) => `    - name: ${q(p)}`));
      }
    }

    // Everything not taken above, by its kind.
    for (const [key, value] of s) {
      if (done.has(key)) continue;
      const setting = type.settings[key];
      const kind: Kind = setting?.kind ?? 'string';
      const name = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : q(key);
      if (kind === 'list') lines.push(`${name}:`, ...listOfCsv(value).map((v) => `  - ${q(v)}`));
      else if (kind === 'tags') {
        const tags = [...tagsOf(value), ...(type === MACHINE ? templateSpec.machineTags ?? [] : [])];
        lines.push(`${name}:`, ...tags.flatMap((t) => [`  - key: ${q(t.key)}`, `    value: ${q(t.value)}`]));
      } else if (kind === 'constraints') lines.push(`${name}:`, ...constraintLines(listOfCsv(value)));
      else if (kind === 'ref') lines.push(`${name}: ${q(refExpr(value))}`);
      else if (kind === 'refs') lines.push(`${name}:`, ...listOfCsv(value).map((v) => `  - ${q(refExpr(v))}`));
      else lines.push(`${name}: ${scalarOf(value, kind)}`);
    }
    return lines;
  }
}

function tagsOf(text: string): { key: string; value: string }[] {
  return listOfCsv(text).map((pair) => {
    // The first colon outside an expression splits key from value.
    const at = pair.search(/:(?![^{]*\})/);
    return at < 0 ? { key: pair, value: '' } : { key: pair.slice(0, at).trim(), value: pair.slice(at + 1).trim() };
  });
}

/** The resource types, as the hint under the grid lists them. */
export function resourceTypeHelp(): string {
  return [...RESOURCE_TYPES.map((t) => t.type), 'Custom.<name>'].join(', ');
}

/** A settings reference per type, for the README. */
export function settingsReference(): string[] {
  const lines: string[] = ['# Resource settings, by type', '', 'Settings are written `key=value; key=value` in the Settings column. A value may be an expression: `${input.size}`, `${resource.net.id}`, `${propgroup.x.y}`, `${secret.x}`.', ''];
  for (const t of [...RESOURCE_TYPES, CUSTOM]) {
    lines.push(`## ${t.type} — ${t.label}`, '');
    if (t === CUSTOM) lines.push('Any key=value, written as a property as given: a custom resource type from the custom resource blueprint.', '');
    for (const [key, s] of Object.entries(t.settings)) lines.push(`- \`${key}\`${s.values ? ` (${s.values.join(' | ')})` : ''}: ${s.help}`);
    if (t.open && t !== CUSTOM) lines.push('- Any other key is written as given.');
    lines.push('');
  }
  lines.push('## Inputs', '', 'Constraints column: `enum=a,b,c; min=1; max=8; pattern=^[a-z]+$; encrypted=true; readOnly=true; format=date-time; $dynamicEnum=/data/vro-actions/<module>/<action>?a={{b}}; $dynamicDefault=…; $ref=/ref/property-groups/<name>; $data=…`. For a string min/max are lengths; for an array, item counts. A pattern may hold a bare | (the grid splits only on a pipe with spaces round it), but not a ; (which separates constraints).', '', 'VERIFY: $data and $dynamicDefault bindings against a template built in the designer of your release.', '');
  return lines;
}
