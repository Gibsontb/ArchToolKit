/**
 * The Sources pane's model side, with no DOM: which import formats it offers
 * (with how far each layout is verified), how several files of one format
 * are told apart, what an import did to the plan, and the dependency review
 * grid shared by the flow import, the Azure Migrate dependency export and
 * the coupling files.
 */

import { info,              } from '../../core/findings.js';
                                                            
import { acceptEdges,                   } from '../../multicloud/plan/discovery/flows.js';
import { mergeIntake } from '../../multicloud/plan/intake/merge.js';
                                                                            
                                                                                
import { regroup, DEFAULT_GROUPING } from '../../multicloud/plan/intake/grouping.js';
                                                                                                         
import { detectWorkloads } from '../../multicloud/plan/patterns/detect.js';
import { DEFAULT_INTAKE, EDGE_KIND_OPTIONS, YES_NO_OPTIONS } from '../../multicloud/plan/options.js';
                                                                                                                                        
                                                           
import { gridText, parseGridText } from './grid-model.js';

// ---------------------------------------------------------------------------
// The import formats the pane offers (after the estate and CSV)
// ---------------------------------------------------------------------------

                            
                                                                                                                            

                               
                              
                         
                        
                                       
                          
                             
                                        
                           
                                                                                                                                              
                                       
                         
 

export const SOURCE_FORMATS                          = Object.freeze([
  {
    id: 'discovery', title: 'Collector files (archtoolkit.discovery)', accept: '.json,application/json', multiple: true,
    what: 'The JSON every collector writes: Hyper-V, SCVMM, Nutanix AHV, KVM, Proxmox, oVirt / OLVM, Xen, physical guests, AWS, Azure, Google Cloud (GCP) and OCI. Several files from several platforms at once.',
    note: 'Their established connections can be proposed as dependencies (the flow review below).',
  },
  {
    id: 'azure-migrate', title: 'Azure Migrate CSV', accept: '.csv,text/csv', multiple: true,
    what: 'The discovery import template (Server name, Cores, Memory (In MB), OS name …) or an assessment export.',
    source: 'https://learn.microsoft.com/en-us/azure/migrate/tutorial-discover-import', verification: 'V-DOC',
    note: 'The assessment export’s columns are not published: they are read by header when present [U].',
  },
  {
    id: 'migration-center', title: 'Google Cloud (GCP) Migration Center tables', accept: '.csv,text/csv', multiple: true,
    what: 'vmInfo.csv, with diskInfo.csv, perfInfo.csv and tagInfo.csv when you have them. Pick the files together.',
    source: 'https://docs.cloud.google.com/migration-center/docs/import-data-tables', verification: 'V-DOC',
  },
  {
    id: 'aws-import', title: 'AWS Migration Hub import template', accept: '.csv,text/csv', multiple: true,
    what: 'The Application Discovery Service import CSV (ExternalId, HostName, CPU.NumberOfCores, RAM.TotalSizeInMB …). The service is closed to new customers; the sheet still reads.',
    source: 'https://docs.aws.amazon.com/application-discovery/latest/userguide/discovery-import.html', verification: 'V-DOC',
  },
  {
    id: 'ahv', title: 'Nutanix Prism Central VM export', accept: '.csv,text/csv', multiple: true,
    what: 'The VM list’s Export CSV. Its columns follow the list view and are not published, so they are read by header aliases [U]; the AHV collector is the complete route.',
    verification: 'I',
  },
  {
    id: 'mgn', title: 'AWS Transform MGN inventory import CSV', accept: '.csv,text/csv', multiple: true,
    what: 'mgn:app:name, mgn:wave:name, mgn:server:user-provided-id … Sizes come from the target instance type, not measurements.',
    source: 'https://docs.aws.amazon.com/mgn/latest/ug/import-parameters.html', verification: 'V-DOC',
  },
  {
    id: 'cmf', title: 'Cloud Migration Factory on AWS intake form', accept: '.csv,text/csv', multiple: true,
    what: 'wave_name, app_name, server_name, server_os_family … Sizes come from the target instance type.',
    source: 'https://docs.aws.amazon.com/pdfs/solutions/latest/cloud-migration-factory-on-aws/cloud-migration-factory-on-aws.pdf', verification: 'V-DOC',
  },
  {
    id: 'perf', title: 'Performance time series (CSV)', accept: '.csv,text/csv', multiple: true,
    what: 'One row per server per sample from any monitoring tool (server, timestamp, CPU %, memory, IOPS, MB/s). Adds utilisation to servers already in the plan and re-applies the sizing basis.',
    verification: 'I', note: 'Columns are found by header aliases; check the result against the tool’s own view.',
  },
  {
    id: 'azure-dependency', title: 'Azure Migrate dependency export', accept: '.csv,text/csv', multiple: true,
    what: 'The agentless dependency CSV (Timeslot, Source server name, Destination server name, Destination port …). Proposes dependencies for review.',
    source: 'https://learn.microsoft.com/en-us/azure/migrate/how-to-create-group-machine-dependencies-agentless', verification: 'V-DOC',
  },
]);

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

                                                                           

const firstLine = (text        )         => (text.replace(/^﻿/, '').split(/\r?\n/)[0] ?? '').toLowerCase();

/**
 * Google Migration Center's four tables from the files picked together:
 * by file name first (vmInfo / diskInfo / perfInfo / tagInfo), else by the
 * header (MachineName, DiskLabel/SizeInGib, TimeStamp, Key/Value).
 */
export function migrationCenterFiles(files                      )                                                     {
  const pick                         = {};
  for (const f of files) {
    const n = f.name.toLowerCase();
    const h = firstLine(f.text);
    const kind = /vminfo/.test(n) ? 'vmInfo' : /diskinfo/.test(n) ? 'diskInfo' : /perfinfo/.test(n) ? 'perfInfo' : /taginfo/.test(n) ? 'tagInfo'
      : /machinename/.test(h) ? 'vmInfo' : /timestamp/.test(h) ? 'perfInfo' : /(^|,)\s*"?key"?\s*,/.test(h) ? 'tagInfo' : /disk/.test(h) ? 'diskInfo' : undefined;
    if (kind && !(kind in pick)) pick[kind] = f.text;
  }
  if (!pick.vmInfo) return { problem: 'No vmInfo.csv among the files (it names each machine; the other three add to it).' };
  return {
    files: {
      vmInfo: pick.vmInfo,
      ...(pick.diskInfo ? { diskInfo: pick.diskInfo } : {}),
      ...(pick.perfInfo ? { perfInfo: pick.perfInfo } : {}),
      ...(pick.tagInfo ? { tagInfo: pick.tagInfo } : {}),
    },
  };
}

                                                                                   

/** What a JSON file is, from its `kind`. */
export function jsonKind(text        )           {
  try {
    const doc = JSON.parse(text)                      ;
    const k = typeof doc?.kind === 'string' ? doc.kind : '';
    if (k === 'archtoolkit.discovery') return 'discovery';
    if (k === 'archtoolkit.coupling') return 'coupling';
    if (k === 'archtoolkit.migration-portfolio') return 'portfolio';
    if (k === 'archtoolkit.multicloud-plan') return 'plan';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// What an import did
// ---------------------------------------------------------------------------

                               
                           
                                                                                                     
                                                                                                     
                                                                    
 

const key = (name        )         => name.trim().toLowerCase();

/**
 * An intake result merged into the plan (as the Sources settings' merge mode
 * says), with type detection run on the servers that have none yet, and a
 * summary of what was added and refreshed.
 */
export function applyIntake(plan      , result              , mode           )                                                             {
  const before = {
    w: new Set(plan.workloads.map((w) => key(w.name))),
    d: new Set(plan.databases.map((d) => key(d.name))),
    a: new Set(plan.apps.map((a) => key(a.name))),
  };
  const merged = mergeIntake(plan, result, mode);
  const findings            = [...result.findings];
  // Detection for rows that have none (the estate adapter does not detect).
  const undetected = merged.workloads.filter((w) => !w.facts?.detection);
  let workloads = merged.workloads;
  if (undetected.length > 0) {
    const d = detectWorkloads(undetected);
    const byId = new Map(d.workloads.map((w) => [w.id, w]));
    workloads = merged.workloads.map((w) => byId.get(w.id) ?? w);
    findings.push(...d.findings);
  }
  const incomingW = new Set(result.workloads.map((w) => key(w.name)));
  const incomingD = new Set(result.databases.map((d) => key(d.name)));
  const summary               = {
    mode,
    workloads: {
      added: workloads.filter((w) => !before.w.has(key(w.name))).length,
      refreshed: mode === 'merge' ? [...incomingW].filter((n) => before.w.has(n)).length : 0,
      total: workloads.length,
    },
    databases: {
      added: merged.databases.filter((d) => !before.d.has(key(d.name))).length,
      refreshed: mode === 'merge' ? [...incomingD].filter((n) => before.d.has(n)).length : 0,
      total: merged.databases.length,
    },
    apps: { added: merged.apps.filter((a) => !before.a.has(key(a.name))).length, total: merged.apps.length },
  };
  return { plan: { ...plan, workloads, databases: merged.databases, apps: merged.apps }, summary, findings };
}

/** The summary in words. */
export function summaryText(s              )         {
  const part = (n        , one        ) => `${n} ${one}${n === 1 ? '' : 's'}`;
  const verb = s.mode === 'replace' ? 'Replaced the rows' : 'Merged by name';
  return `${verb}: ${part(s.workloads.added, 'server')} added${s.mode === 'merge' ? `, ${s.workloads.refreshed} refreshed (edited cells kept)` : ''}; `
    + `${part(s.databases.added, 'database')} added; ${part(s.apps.added, 'application')} added. `
    + `The plan now has ${part(s.workloads.total, 'server')}, ${part(s.databases.total, 'database')} and ${part(s.apps.total, 'application')}.`;
}

/** The plan's Sources settings, with the defaults filled. */
export function intakeSettings(plan      )                 {
  return { ...DEFAULT_INTAKE, ...(plan.intake ?? {}) };
}

export function groupingRules(plan      )                          {
  return plan.intake?.grouping ?? DEFAULT_GROUPING;
}

// ---------------------------------------------------------------------------
// Regrouping
// ---------------------------------------------------------------------------

/** What the grouping rules can read of each estate VM. */
export function subjectsFromInventory(inv                              )                    {
  if (!inv) return [];
  return inv.vms.map((vm) => ({
    name: vm.name,
    ...(vm.customAttributes ? { attributes: vm.customAttributes } : {}),
    ...(vm.folder ? { folder: vm.folder } : {}),
    ...(vm.vApp ? { vapp: vm.vApp } : {}),
    ...(vm.resourcePool ? { resourcePool: vm.resourcePool } : {}),
  }));
}

/** The rules run again over the plan's servers (edited App cells kept), with the apps the new names need. */
export function regroupPlan(plan      , subjects                            , only                    )                                                       {
  const rules = groupingRules(plan);
  const pickIdx = only ? new Set(only) : undefined;
  const target = plan.workloads.filter((_, i) => !pickIdx || pickIdx.has(i));
  const r = regroup(target, subjects, rules);
  const byId = new Map(r.workloads.map((w) => [w.id, w]));
  let changed = 0;
  const workloads = plan.workloads.map((w) => {
    const next = byId.get(w.id);
    if (next && next.app !== w.app) changed += 1;
    return next ?? w;
  });
  const merged = mergeIntake({ ...plan, workloads }, { workloads: [], databases: [], apps: [], findings: [] }, 'merge');
  return { plan: { ...plan, workloads: merged.workloads, apps: merged.apps }, findings: r.findings, changed };
}

// ---------------------------------------------------------------------------
// The dependency review grid (flows, Azure dependencies, coupling)
// ---------------------------------------------------------------------------

/** The review grid's columns (A.10.1): the last two are the user's. */
export const REVIEW_GRID_COLUMNS = Object.freeze(['From', 'To', 'Port', 'Proto', 'Observations', 'Process', 'Proposed kind', 'Accept']         );
export const REVIEW_CHOICES = Object.freeze([undefined, undefined, undefined, undefined, undefined, undefined, EDGE_KIND_OPTIONS, YES_NO_OPTIONS]);

export function reviewText(edges                         )         {
  return gridText(edges.map((e) => [e.from, e.to, String(e.port), e.protocol, String(e.observations), e.process ?? '', e.proposedKind, e.accept ? 'yes' : 'no']));
}

/**
 * The edges as the user left the review grid: the kind and Accept cells read
 * back by position (the first six columns are the proposal's and not edited).
 */
export function reviewedEdges(edges                         , text        )                 {
  const rows = parseGridText(text, REVIEW_GRID_COLUMNS.length);
  return edges.map((e, i) => {
    const row = rows[i];
    if (!row) return e;
    const kind           = row[6] === 'async' ? 'async' : row[6] === 'sync' ? 'sync' : e.proposedKind;
    return { ...e, proposedKind: kind, accept: row[7] === 'yes' };
  });
}

/** The ticked edges written into the plan (edges and "Depends on"). */
export function acceptReviewed(plan      , edges                         )                                   {
  const ticked = edges.filter((e) => e.accept);
  return { plan: acceptEdges(plan, ticked), accepted: ticked.filter((e) => e.fromKind === 'workload' && e.toKind !== 'external').length };
}

const kindOfEnd = (name        , workloads                     )                         =>
  name.startsWith('site:') ? 'site' : workloads.some((w) => w.name === name) ? 'workload' : 'external';

/** Proposed edges from the Azure dependency export or the coupling rules, in the review grid's shape. */
export function asReviewEdges(
  list                                                                                                                                                                                                   ,
  workloads                     ,
  reason        ,
)                 {
  return list.map((e) => ({
    from: e.from,
    to: e.to,
    fromKind: kindOfEnd(e.from, workloads),
    toKind: kindOfEnd(e.to, workloads),
    port: e.port ?? 0,
    protocol: e.protocol ?? 'tcp',
    observations: e.observations ?? 1,
    ...(e.process ? { process: e.process } : {}),
    portClass: 'other',
    proposedKind: e.kind,
    reason,
    accept: false,
  }));
}

/** Coupling edges (DependencyEdge) as review rows. */
export function couplingReviewEdges(edges                           , workloads                     )                 {
  return asReviewEdges(edges.map((e) => ({ from: e.from, to: e.to, kind: e.kind, protocol: 'ref' })), workloads, 'A reference in the server’s configuration points at it.');
}

/** A note for the pane when a review has nothing to accept. */
export function nothingToReview(what        )          {
  return info('sources.review.empty', `${what}: no dependencies between servers in the plan were found.`);
}
