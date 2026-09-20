/**
 * The imported estate, so the rest of the toolkit can offer it.
 *
 * A generator asking you to type a datastore name is asking you to remember
 * something the toolkit already knows. Once an inventory has been imported, the
 * vSphere blueprints should be offering your actual datacenters, clusters,
 * datastores, port groups, templates and virtual machines rather than a text box
 * with `datastore1` in it.
 *
 * Only the names are kept, not the inventory itself. The names are all the
 * dropdowns need, they are small enough to carry between pages without thinking
 * about it, and keeping less of someone's estate around is the right default.
 *
 * `sessionStorage` is the right lifetime here, as it is for the platform
 * selection: it survives moving between pages in a tab and goes away with the
 * tab. Every access is wrapped, because storage throws in a private window and
 * with site data blocked, and a generator that failed to load because it could
 * not read a convenience would be a poor trade.
 */

                                                        

const KEY = 'archtoolkit.estate';
const VERSION = 1;

                              
                           
                                                                         
                          
                                          
                                       
                                         
                                       
                                    
                                  
     
                                                                             
                                                                               
                                            
     
                                        
 

function store()                 {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** Unique, sorted, blank-free — the shape a dropdown wants. */
function names(values                                 , limit = 400)           {
  const set = new Set        ();
  for (const value of values) {
    const name = (value ?? '').trim();
    if (name) set.add(name);
  }
  return [...set].sort((a, b) => a.localeCompare(b)).slice(0, limit);
}

export function saveEstate(inventory           )       {
  try {
    const label = inventory.source.label ?? inventory.source.kind;
    const payload              = {
      version: VERSION,
      origin: label,
      datacenters: names([
        ...inventory.clusters.map((c) => c.datacenter),
        ...inventory.hosts.map((h) => h.datacenter),
        ...inventory.vms.map((v) => v.datacenter),
      ]),
      clusters: names(inventory.clusters.map((c) => c.name)),
      datastores: names(inventory.datastores.map((d) => d.name)),
      networks: names(inventory.networks.map((n) => n.name)),
      hosts: names(inventory.hosts.map((h) => h.name)),
      vms: names(inventory.vms.map((v) => v.name)),
      templates: names(
        inventory.vms.filter((v) => /template|golden|gold-|-tmpl/i.test(v.name)).map((v) => v.name),
      ),
    };
    store()?.setItem(KEY, JSON.stringify(payload));
  } catch {
    // Not remembering the estate is survivable; failing to import is not.
  }
}

export function loadEstate()                     {
  try {
    const raw = store()?.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw)               ;
    return parsed?.version === VERSION ? parsed : null;
  } catch {
    return null;
  }
}

export function clearEstate()       {
  try {
    store()?.removeItem(KEY);
  } catch {
    // As above.
  }
}

/**
 * Which part of the estate answers a given input.
 *
 * Matched on the input id, so it covers the blueprints' various spellings —
 * `datastore`, `datastore_name`, `datacenter`, `datacenter_name` and the rest —
 * without a per-blueprint list to keep in step.
 */
export function estateOptionsFor(
  target        ,
  inputId        ,
)                                                                         {
  if (target !== 'vsphere') return null;
  const estate = loadEstate();
  if (!estate) return null;

  const id = inputId.toLowerCase();
  const pick = (values                   ) =>
    values.length > 0 ? { values, origin: estate.origin } : null;

  // Templates first: a template input wants the template-looking names, and
  // falls back to every VM, because the guess is only a guess.
  if (/template/.test(id)) {
    return pick(estate.templates.length > 0 ? estate.templates : estate.vms);
  }
  if (/datacenter/.test(id)) return pick(estate.datacenters);
  if (/datastore/.test(id)) return pick(estate.datastores);
  if (/cluster/.test(id)) return pick(estate.clusters);
  if (/network|portgroup|port_group/.test(id)) return pick(estate.networks);
  if (/esxi|^host$|host_name|host_system/.test(id)) return pick(estate.hosts);
  if (/^vm_name$|^vm$|guest_name/.test(id)) return pick(estate.vms);
  return null;
}
