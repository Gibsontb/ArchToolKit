/**
 * The tag standard, as something you build by picking rather than by typing.
 *
 * A standard is a list of categories: a name, single or multiple, the object
 * types it may go on, its allowed values, the types it is required on and a
 * description. The blueprints read it as one line per category —
 *
 *   Name | single or multiple | object types | values | required on | description
 *
 * — so that is what the builder writes. The page keeps the latest standard for
 * the tab, so every other tag blueprint offers its categories and tags as
 * choices instead of asking for them again.
 */

/** The vSphere object types a vCenter tag category can be associated with, as vCenter spells them. */
export const TAG_OBJECT_TYPES: readonly { readonly value: string; readonly label: string }[] = [
  { value: 'VirtualMachine', label: 'Virtual machines' },
  { value: 'HostSystem', label: 'Hosts' },
  { value: 'ClusterComputeResource', label: 'Clusters' },
  { value: 'Datastore', label: 'Datastores' },
  { value: 'StoragePod', label: 'Datastore clusters' },
  { value: 'Network', label: 'Networks' },
  { value: 'DistributedVirtualPortgroup', label: 'Distributed port groups' },
  { value: 'VmwareDistributedVirtualSwitch', label: 'Distributed switches' },
  { value: 'Folder', label: 'Folders' },
  { value: 'Datacenter', label: 'Datacenters' },
  { value: 'ResourcePool', label: 'Resource pools' },
  { value: 'VirtualApp', label: 'vApps' },
  { value: 'com.vmware.content.Library', label: 'Content libraries' },
  { value: 'com.vmware.content.library.Item', label: 'Content library items' },
];

export interface TagCategory {
  readonly name: string;
  readonly cardinality: 'single' | 'multiple';
  /** Empty means every type. */
  readonly types: readonly string[];
  /** Empty with freeText false means none chosen yet. */
  readonly values: readonly string[];
  readonly freeText: boolean;
  readonly requiredOn: readonly string[];
  readonly description: string;
}

/** Common categories, with the values most estates start from. Picking one adds it ready to edit. */
export const TAG_PRESETS: readonly TagCategory[] = [
  { name: 'Environment', cardinality: 'single', types: ['VirtualMachine', 'Folder', 'ClusterComputeResource', 'ResourcePool'], values: ['prod', 'preprod', 'test', 'dev', 'dr'], freeText: false, requiredOn: ['VirtualMachine'], description: 'Lifecycle stage. Drives placement, policy and firewall groups' },
  { name: 'Application', cardinality: 'multiple', types: ['VirtualMachine', 'Folder', 'ResourcePool'], values: ['payments', 'web-portal', 'data-platform', 'shared-services'], freeText: false, requiredOn: ['VirtualMachine'], description: 'Business application the object serves' },
  { name: 'Owner', cardinality: 'single', types: ['VirtualMachine', 'Folder'], values: ['team-payments', 'team-web', 'team-data', 'team-platform'], freeText: false, requiredOn: ['VirtualMachine'], description: 'Owning team, never a person' },
  { name: 'CostCenter', cardinality: 'single', types: ['VirtualMachine', 'Folder', 'ResourcePool'], values: ['CC1001', 'CC1002', 'CC2001', 'CC9000'], freeText: false, requiredOn: ['VirtualMachine'], description: 'Finance cost centre for showback' },
  { name: 'BackupPolicy', cardinality: 'single', types: ['VirtualMachine'], values: ['gold-daily', 'silver-daily', 'bronze-weekly', 'none'], freeText: false, requiredOn: ['VirtualMachine'], description: 'Backup schedule the backup product selects on' },
  { name: 'DataClassification', cardinality: 'single', types: ['VirtualMachine', 'Datastore'], values: ['public', 'internal', 'confidential', 'restricted'], freeText: false, requiredOn: ['VirtualMachine'], description: 'Highest classification of data held' },
  { name: 'Compliance', cardinality: 'multiple', types: ['VirtualMachine', 'ClusterComputeResource', 'Datastore'], values: ['pci-dss', 'sox', 'gdpr', 'hipaa'], freeText: false, requiredOn: [], description: 'Regimes in scope' },
  { name: 'Automation', cardinality: 'single', types: ['VirtualMachine', 'HostSystem', 'ClusterComputeResource'], values: ['allowed', 'never'], freeText: false, requiredOn: [], description: 'never = every automation in this kit leaves it alone' },
  { name: 'Tier', cardinality: 'single', types: ['VirtualMachine', 'ClusterComputeResource', 'Datastore'], values: ['1', '2', '3'], freeText: false, requiredOn: ['ClusterComputeResource'], description: 'Service tier; cluster and datastore tier used for placement' },
  { name: 'OS', cardinality: 'single', types: ['VirtualMachine'], values: ['windows', 'linux', 'other'], freeText: false, requiredOn: [], description: 'Guest operating system family' },
  { name: 'Criticality', cardinality: 'single', types: ['VirtualMachine'], values: ['critical', 'high', 'medium', 'low'], freeText: false, requiredOn: [], description: 'Business impact if it is down' },
  { name: 'Site', cardinality: 'single', types: ['VirtualMachine', 'HostSystem', 'ClusterComputeResource', 'Datastore', 'Datacenter'], values: ['site-a', 'site-b'], freeText: false, requiredOn: [], description: 'Physical site the object runs in' },
  { name: 'PatchWindow', cardinality: 'single', types: ['VirtualMachine', 'HostSystem'], values: ['sat-0200', 'sun-0200', 'manual'], freeText: false, requiredOn: [], description: 'When it may be patched and rebooted' },
  { name: 'SupportHours', cardinality: 'single', types: ['VirtualMachine'], values: ['24x7', 'business-hours'], freeText: false, requiredOn: [], description: 'When someone is on call for it' },
  { name: 'Replication', cardinality: 'single', types: ['VirtualMachine'], values: ['replicated', 'not-replicated'], freeText: false, requiredOn: [], description: 'Whether it is protected to the other site' },
];

/** The standard most estates start with: the first ten presets. */
export const DEFAULT_TAG_CATEGORIES: readonly TagCategory[] = TAG_PRESETS.slice(0, 10);

const HEADER = [
  '# Category | single or multiple | object types | allowed values | required on | description',
  '# Object types: VirtualMachine, HostSystem, ClusterComputeResource, Datastore, Network,',
  '# DistributedVirtualPortgroup, Folder, ResourcePool, Datacenter ... (* = every type).',
  '# Values: comma separated, or * for free text (use sparingly).',
];

const clean = (text: string): string => text.replace(/[|\n\r]/g, ' ').trim();

/** One line per category, in the format the tag blueprints read. */
export function serializeTagStandard(categories: readonly TagCategory[]): string {
  return [
    ...HEADER,
    ...categories.map((c) =>
      [
        clean(c.name),
        c.cardinality,
        c.types.length === 0 ? '*' : c.types.join(','),
        c.freeText ? '*' : c.values.map(clean).join(','),
        c.requiredOn.join(','),
        clean(c.description),
      ].join(' | '),
    ),
  ].join('\n');
}

const listOf = (text: string): string[] =>
  text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

/** Reads the line format back. Lines it cannot read are skipped; the blueprint itself reports them. */
export function parseTagStandard(text: string): TagCategory[] {
  const out: TagCategory[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [name = '', card = '', types = '', values = '', required = '', description = ''] = line.split('|').map((f) => f.trim());
    if (!name) continue;
    out.push({
      name,
      cardinality: card.toLowerCase() === 'multiple' ? 'multiple' : 'single',
      types: types === '*' || types === '' ? [] : listOf(types),
      values: values === '*' ? [] : listOf(values),
      freeText: values === '*',
      requiredOn: listOf(required),
      description,
    });
  }
  return out;
}

// --- the standard the page is working with ----------------------------------

const KEY = 'archtoolkit.tag-standard';

/** The standard last built on the page in this browser, if there is one. */
export function currentTagStandard(): string | undefined {
  try {
    const text = globalThis.localStorage?.getItem(KEY);
    return text && text.trim() ? text : undefined;
  } catch {
    return undefined;
  }
}

export function rememberTagStandard(text: string): void {
  try {
    globalThis.localStorage?.setItem(KEY, text);
  } catch {
    // Not remembering it only means the other tag blueprints start from the default.
  }
}

/** The categories and tags the other blueprints offer as choices. */
export function tagChoices(text: string = currentTagStandard() ?? serializeTagStandard(DEFAULT_TAG_CATEGORIES)): {
  readonly categories: readonly string[];
  /** Category:tag, for fields that name one tag. */
  readonly tags: readonly { readonly category: string; readonly tag: string }[];
} {
  const categories = parseTagStandard(text);
  return {
    categories: categories.map((c) => c.name),
    tags: categories.flatMap((c) => c.values.map((tag) => ({ category: c.name, tag }))),
  };
}
