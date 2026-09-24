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
export const TAG_OBJECT_TYPES                                                                = [
  { value: 'VirtualMachine', label: 'VMs' },
  { value: 'HostSystem', label: 'Hosts' },
  { value: 'ClusterComputeResource', label: 'Clusters' },
  { value: 'Datastore', label: 'Datastores' },
  { value: 'StoragePod', label: 'DS clusters' },
  { value: 'Network', label: 'Networks' },
  { value: 'DistributedVirtualPortgroup', label: 'Port groups' },
  { value: 'VmwareDistributedVirtualSwitch', label: 'dvSwitches' },
  { value: 'Folder', label: 'Folders' },
  { value: 'Datacenter', label: 'Datacenters' },
  { value: 'ResourcePool', label: 'Resource pools' },
  { value: 'VirtualApp', label: 'vApps' },
  { value: 'com.vmware.content.Library', label: 'Libraries' },
  { value: 'com.vmware.content.library.Item', label: 'Library items' },
];

                              
                        
                                              
                                
                                    
                                                         
                                     
                             
                                         
                               
 

/** Common categories, with the values most estates start from. Picking one adds it ready to edit. */
export const TAG_PRESETS                         = [
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
export const DEFAULT_TAG_CATEGORIES                         = TAG_PRESETS.slice(0, 10);

const HEADER = [
  '# Category | single or multiple | object types | allowed values | required on | description',
  '# Object types: VirtualMachine, HostSystem, ClusterComputeResource, Datastore, Network,',
  '# DistributedVirtualPortgroup, Folder, ResourcePool, Datacenter ... (* = every type).',
  '# Values: comma separated, or * for free text (use sparingly).',
];

const clean = (text        )         => text.replace(/[|\n\r]/g, ' ').trim();

/** One line per category, in the format the tag blueprints read. */
export function serializeTagStandard(categories                        )         {
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

const listOf = (text        )           =>
  text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

/** Reads the line format back. Lines it cannot read are skipped; the blueprint itself reports them. */
export function parseTagStandard(text        )                {
  const out                = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('@')) continue;
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

// --- entries: which items get which tags ------------------------------------

/**
 * One line of the tag list: some items of one object type, and the tags they
 * get. The categories and tags the standard needs are worked out from these,
 * so nothing is created that is not attached to something.
 *
 * Stored beside the category lines as
 *
 *   @ VirtualMachine | app01, app02 | Environment=prod; Application=payments
 *
 * which parseTagStandard and the blueprints' own reader skip.
 */
                           
                        
                                    
                                                                                
 

export function parseTagEntries(text        )             {
  const out             = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('@')) continue;
    const [type = '', items = '', tags = ''] = line.slice(1).split('|').map((f) => f.trim());
    const pairs = tags
      .split(';')
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => {
        const at = t.indexOf('=');
        return { category: t.slice(0, at).trim(), tag: t.slice(at + 1).trim() };
      })
      .filter((t) => t.category && t.tag);
    const list = listOf(items);
    if (type && list.length > 0 && pairs.length > 0) out.push({ type, items: list, tags: pairs });
  }
  return out;
}

const cleanItem = (text        )         => text.replace(/[|,;=\r\n]/g, ' ').trim();

export function serializeTagEntries(entries                     )           {
  return entries.map((e) => `@ ${e.type} | ${e.items.map(cleanItem).join(', ')} | ${e.tags.map((t) => `${cleanItem(t.category)}=${cleanItem(t.tag)}`).join('; ')}`);
}

/**
 * The categories the entries need: every category used, with the tags used in
 * it and the object types it was put on. A common category keeps its usual
 * description; a category that one item got two tags from allows several.
 */
export function categoriesFromEntries(entries                     )                {
  const byName = new Map                                                                                ();
  for (const e of entries) {
    const perCategory = new Map                ();
    for (const t of e.tags) {
      const key = t.category.toLowerCase();
      const c = byName.get(key) ?? { name: t.category, types: [], values: [], multiple: false };
      if (!c.types.includes(e.type)) c.types.push(e.type);
      if (!c.values.some((v) => v.toLowerCase() === t.tag.toLowerCase())) c.values.push(t.tag);
      perCategory.set(key, (perCategory.get(key) ?? 0) + 1);
      if ((perCategory.get(key) ?? 0) > 1) c.multiple = true;
      byName.set(key, c);
    }
  }
  return [...byName.values()].map((c) => {
    const preset = TAG_PRESETS.find((p) => p.name.toLowerCase() === c.name.toLowerCase());
    return {
      name: c.name,
      cardinality: c.multiple || preset?.cardinality === 'multiple' ? 'multiple' : 'single',
      types: c.types,
      values: c.values,
      freeText: false,
      requiredOn: [],
      description: preset?.description ?? '',
    };
  });
}

/** The whole value: the categories worked out from the entries, then the entries. */
export function serializeTagList(entries                     )         {
  return entries.length === 0 ? '' : [serializeTagStandard(categoriesFromEntries(entries)), ...serializeTagEntries(entries)].join('\n');
}

// --- the standard the page is working with ----------------------------------

// The tag list of items and their tags. (Earlier builds kept a categories-only standard under
// archtoolkit.tag-standard; that one is ignored, so the list starts empty.)
const KEY = 'archtoolkit.tag-list';

/** The standard last built on the page in this browser, if there is one. */
export function currentTagStandard()                     {
  try {
    const text = globalThis.localStorage?.getItem(KEY);
    return text && text.trim() ? text : undefined;
  } catch {
    return undefined;
  }
}

export function rememberTagStandard(text        )       {
  try {
    globalThis.localStorage?.setItem(KEY, text);
  } catch {
    // Not remembering it only means the other tag blueprints start from the default.
  }
}

/** The categories and tags the other blueprints offer as choices. */
export function tagChoices(text         = currentTagStandard() ?? serializeTagStandard(DEFAULT_TAG_CATEGORIES))   
                                         
                                                    
                                                                                
  {
  const categories = parseTagStandard(text);
  return {
    categories: categories.map((c) => c.name),
    tags: categories.flatMap((c) => c.values.map((tag) => ({ category: c.name, tag }))),
  };
}
