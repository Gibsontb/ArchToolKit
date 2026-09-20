/**
 * The platform, chosen once.
 *
 * Picking the cloud on every page is the kind of thing that is merely annoying
 * the first time and then quietly becomes the reason a tool goes unused. It is
 * also a correctness problem: two pages that each hold their own idea of the
 * target will disagree, and the Terraform and the Ansible will be for different
 * clouds without saying so.
 *
 * So the target lives in one place. The multi-cloud matrix sets it when it
 * reaches a recommendation, the generator pages read it and offer it as the
 * current selection, and changing it anywhere changes it everywhere.
 *
 * `sessionStorage` is the right store: it survives navigating between pages in a
 * tab and goes away with the tab, which is the correct lifetime for "the cloud I
 * am working on right now". Every access is wrapped, because storage throws in a
 * private window and with site data blocked, and a toolkit that fails to load
 * because it could not read a convenience would be a poor trade.
 */

                                                                                                    

const KEY = 'archtoolkit.target';
const VERSION = 1;

                        
                           
                            
                                                                           
                           
 

const VALID                      = [
  'vcf',
  'vsphere',
  'aws',
  'azure',
  'google',
  'oci',
  'linux',
  'windows',
];

function store()                 {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function setTarget(target          , origin         )       {
  try {
    const payload               = { version: VERSION, target, ...(origin ? { origin } : {}) };
    store()?.setItem(KEY, JSON.stringify(payload));
  } catch {
    // Not being able to remember the selection is survivable; failing is not.
  }
}

export function getTarget()                                               {
  try {
    const raw = store()?.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw)                ;
    if (parsed?.version !== VERSION) return null;
    if (!VALID.includes(parsed.target)) return null;
    return { target: parsed.target, ...(parsed.origin ? { origin: parsed.origin } : {}) };
  } catch {
    return null;
  }
}

export function clearTarget()       {
  try {
    store()?.removeItem(KEY);
  } catch {
    // As above.
  }
}
