/**
 * Intake sources: where the planner's rows come from.
 *
 * Every source is an adapter with an id and a `parse` that returns the same
 * four lists: workloads, databases, apps and findings. The VMware inventory,
 * the CSV grids and the Migration portfolio are the first three; physical
 * servers and other hypervisors (Hyper-V, Nutanix, KVM) plug in later the
 * same way, usually by mapping their records to `ServerRecord` and calling
 * `intakeFromServers`, which applies the shared rules: OS id, role, inferred
 * databases, app rows, and the Sources-screen findings.
 *
 * The findings here are the import's own (what the import noticed). The
 * standing checks on the rows live in `validate.ts`.
 */

import { info, warning,              } from '../../../core/findings.js';
import { OS_CATALOG, dbFromVm, defaultLicenceFor, osKind, roleFromName, supportStatus } from '../os.js';
import { RPO_BY_CRITICALITY, RTO_BY_CRITICALITY, itemId } from '../options.js';
             
                                                                                                    
                     

// ---------------------------------------------------------------------------
// The adapter contract
// ---------------------------------------------------------------------------

/** What every source produces. */
                               
                                 
                                 
                       
                               
 

/**
 * The built-in sources, plus any string a later adapter uses
 * ('hyperv', 'nutanix', 'kvm', 'physical', ...).
 */
                                                                            

                                                       
                                  
                              
                                
                         
                                                
                                  
                                                      
 

export function emptyIntake()               {
  return { workloads: [], databases: [], apps: [], findings: [] };
}

/** Several results as one (rows concatenated in order; merge them with `merge.ts`). */
export function concatIntake(results                         )               {
  return {
    workloads: results.flatMap((r) => r.workloads),
    databases: results.flatMap((r) => r.databases),
    apps: results.flatMap((r) => r.apps),
    findings: results.flatMap((r) => r.findings),
  };
}

// ---------------------------------------------------------------------------
// The shared server mapping, for any source of machines
// ---------------------------------------------------------------------------

/**
 * One machine as any hypervisor or CMDB can describe it. The adapter fills
 * what it knows; `intakeFromServers` derives the rest.
 */
                               
                        
                        
                     
                          
                    
                        
                             
                    
                                       
                                                                   
                                  
                                   
                               
                                                         
                                         
                              
                                 
                                                                             
                            
 

/**
 * `WorkloadFacts` plus the allocated disk, which the Workloads screen's
 * "disks sum differs from provisioned by more than 10%" check needs.
 * TODO(WP-0): add `provisionedGib?: number` to `WorkloadFacts` and drop this.
 */
                                                                               

/** The date support checks use: the collection date, else today (ISO yyyy-mm-dd). */
export function isoDay(value         )         {
  const d = value && !Number.isNaN(Date.parse(value)) ? new Date(value) : new Date();
  return d.toISOString().slice(0, 10);
}

/** The licence a database row starts with when the source does not say. */
export function defaultDbLicence(db                                      )            {
  if (db.edition === 'community') return 'community';
  if (db.engine === 'sqlserver') return 'li';
  if (db.engine === 'oracle') return 'oracle-processor';
  return 'commercial-other';
}

/** A complete workload from a server record, with the documented defaults. */
export function workloadFromServer(rec              , source            , criticality              = 'tier2')           {
  const facts              = { ...(rec.facts ?? {}), provisionedGib: rec.provisionedGib };
  return {
    id: itemId('workload', rec.name),
    name: rec.name,
    app: rec.app ?? '',
    env: rec.env ?? 'prod',
    role: roleFromName(rec.name, rec.annotation, rec.attributes),
    os: rec.os,
    vcpu: rec.vcpu,
    ramGib: Math.ceil(rec.memoryGib),
    disksGib: [...rec.disksGib],
    criticality,
    rpo: RPO_BY_CRITICALITY[criticality],
    rto: RTO_BY_CRITICALITY[criticality],
    licence: defaultLicenceFor(rec.os),
    dependsOn: [...(rec.dependsOn ?? [])],
    source,
    ...(rec.sourceKey ? { sourceKey: rec.sourceKey } : {}),
    facts,
  };
}

/** A complete database row from `dbFromVm`'s partial one. */
export function completeDatabase(partial                   , app        )                       {
  const { name, engine } = partial;
  if (!name || !engine) return undefined;
  const edition = partial.edition ?? 'commercial';
  return {
    id: partial.id ?? itemId('database', name),
    name,
    engine,
    edition,
    version: partial.version ?? 'other',
    hosts: [...(partial.hosts ?? [name])],
    vcpu: partial.vcpu ?? 0,
    ramGib: partial.ramGib ?? 0,
    sizeGib: partial.sizeGib ?? 0,
    ha: partial.ha ?? 'none',
    dr: partial.dr ?? 'none',
    features: [...(partial.features ?? [])],
    licence: partial.licence ?? defaultDbLicence({ engine, edition }),
    app: partial.app || app,
    ...(partial.pinService ? { pinService: partial.pinService } : {}),
    inferred: partial.inferred ?? true,
    source: partial.source ?? 'estate',
  };
}

const EXAMPLES = 5;
function names(list                   )         {
  const shown = list.slice(0, EXAMPLES).join(', ');
  return list.length > EXAMPLES ? `${shown} and ${list.length - EXAMPLES} more` : shown;
}
const plural = (n        , one        , many = `${one}s`)         => `${n} ${n === 1 ? one : many}`;

                                      
                              
                                                              
                       
                                                                  
                         
 

/**
 * Server records to rows: one workload each (names made unique), an inferred
 * database where the name, annotation or attributes say so (and the host's
 * role set to db), one app row per app name, and the import's findings.
 */
export function intakeFromServers(records                         , opts                     )               {
  const noun = opts.noun ?? 'server';
  const on = isoDay(opts.on);
  const workloads             = [];
  const databases             = [];
  const findings            = [];
  const seen = new Map                ();
  const duplicates           = [];
  const owners = new Map                ();

  for (const rec0 of records) {
    const key = itemId('workload', rec0.name);
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    let rec = rec0;
    if (n > 1) {
      // Same name twice (two vCenters, two clusters): keep both, the second renamed.
      let name = `${rec0.name}-${n}`;
      while (seen.has(itemId('workload', name))) name = `${name}-${n}`;
      seen.set(itemId('workload', name), 1);
      duplicates.push(`${rec0.name} → ${name}`);
      rec = { ...rec0, name };
    }
    let w = workloadFromServer(rec, opts.source);
    const dbPartial = dbFromVm(
      {
        name: rec.name,
        vcpu: rec.vcpu,
        memoryGib: rec.memoryGib,
        provisionedGib: rec.provisionedGib,
        ...(rec.annotation !== undefined ? { annotation: rec.annotation } : {}),
        ...(rec.attributes ? { customAttributes: { ...rec.attributes } } : {}),
        ...(rec.guestOs !== undefined ? { guestOs: rec.guestOs } : {}),
      },
      rec.os,
    );
    const db = dbPartial ? completeDatabase({ ...dbPartial, source: opts.source === 'csv' ? 'csv' : 'estate' }, w.app) : undefined;
    if (db) {
      databases.push(db);
      if (w.role !== 'db') w = { ...w, role: 'db' };
    }
    workloads.push(w);
    if (rec.owner && w.app && !owners.has(w.app)) owners.set(w.app, rec.owner);
  }

  const apps = appsForNames([...workloads.map((w) => w.app), ...databases.map((d) => d.app)], opts.source, owners);

  const unknown = workloads.filter((w) => w.os === 'unknown').map((w) => w.name);
  if (unknown.length > 0) {
    findings.push(warning('plan.sources.os-unknown', `${plural(unknown.length, noun)} with no recognisable operating system: ${names(unknown)}.`, {
      remediation: 'Pick the OS on the Workloads screen; the detail panel shows the raw guest OS strings.',
    }));
  }
  if (databases.length > 0) {
    findings.push(info('plan.sources.db-inferred', `${plural(databases.length, 'database')} suggested from names or notes: ${names(databases.map((d) => `${d.name} (${d.engine})`))}.`, {
      remediation: 'Confirm the engine, edition, version and licence on the Databases screen.',
    }));
  }
  if (duplicates.length > 0) {
    findings.push(warning('plan.sources.duplicate-name', `${plural(duplicates.length, noun)} shared a name with another and were renamed: ${names(duplicates)}.`, {
      remediation: 'Rename them on the Workloads screen to the names they should have in the target.',
    }));
  }
  const rdm = workloads.filter((w) => (w.facts?.rdmGib ?? 0) > 0).map((w) => w.name);
  if (rdm.length > 0) {
    findings.push(warning('plan.sources.rdm', `${plural(rdm.length, noun)} use raw device mappings, which replication does not carry: ${names(rdm)}.`, {
      remediation: 'Plan the LUN data separately (storage migration, or copy into a VMDK first).',
    }));
  }
  const blocked = workloads.filter((w) => (w.facts?.readiness ?? []).some((r) => r.severity === 'blocker')).map((w) => w.name);
  if (blocked.length > 0) {
    findings.push(warning('plan.sources.blocked', `${plural(blocked.length, noun)} have a move blocker: ${names(blocked)}.`, {
      remediation: 'Open each on the Workloads screen to see what blocks it.',
    }));
  }
  const eol = workloads.filter((w) => supportStatus(w.os, on) === 'end-of-life').map((w) => w.name);
  if (eol.length > 0) {
    findings.push(warning('plan.sources.os-eol', `${plural(eol.length, noun)} run an OS past the end of extended support: ${names(eol)}.`));
  }
  return { workloads, databases, apps, findings };
}

/** Default app rows for a list of app names (blank and repeats dropped). */
export function appsForNames(appNames                   , source            , owners                              )        {
  const out = new Map             ();
  for (const name of appNames) {
    const n = name.trim();
    if (!n) continue;
    const id = itemId('app', n);
    if (out.has(id)) continue;
    const owner = owners?.get(name) ?? owners?.get(n);
    out.set(id, {
      id,
      name: n,
      ...(owner ? { owner } : {}),
      criticality: 'tier2',
      residency: 'any',
      latencyToOnPrem: 'tolerant',
      special: 'none',
      source,
    });
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// The Sources screen's stat tiles
// ---------------------------------------------------------------------------

                              
                             
                           
                         
                             
                        
                          
                              
                                
                           
                         
 

export function intakeStats(workloads                     , databases                     , on         )              {
  const day = isoDay(on);
  let windows = 0;
  let linux = 0;
  let unknownOs = 0;
  let vcpu = 0;
  let ramGib = 0;
  let storageGib = 0;
  let blocked = 0;
  let eolOs = 0;
  for (const w of workloads) {
    const known = w.os in OS_CATALOG;
    const k = known ? osKind(w.os) : 'other';
    if (k === 'windows') windows += 1;
    else if (k === 'linux') linux += 1;
    if (w.os === 'unknown') unknownOs += 1;
    vcpu += w.vcpu;
    ramGib += w.ramGib;
    storageGib += w.disksGib.reduce((s, d) => s + d, 0);
    if ((w.facts?.readiness ?? []).some((r) => r.severity === 'blocker')) blocked += 1;
    if (known && supportStatus(w.os, day) === 'end-of-life') eolOs += 1;
  }
  return {
    workloads: workloads.length,
    windows,
    linux,
    unknownOs,
    vcpu,
    ramGib,
    storageGib,
    dbCandidates: databases.filter((d) => d.inferred).length,
    blocked,
    eolOs,
  };
}
