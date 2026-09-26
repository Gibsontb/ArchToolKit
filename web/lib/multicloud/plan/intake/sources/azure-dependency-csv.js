/**
 * Azure Migrate agentless dependency export (tier 1 of the provider
 * methodology; the best documented dependency format across the providers):
 * https://learn.microsoft.com/en-us/azure/migrate/how-to-create-group-machine-dependencies-agentless
 *
 * Columns: Timeslot (6-hour slots), Source server name, Source application,
 * Source process, Destination server name, Destination IP, Destination
 * application, Destination process, Destination port. The window is 7, 10,
 * 15 or 30 days.
 *
 * Rows are aggregated per (source, destination, port) with the number of
 * time slots seen, matched to plan rows by name or IP, and proposed as
 * dependency edges for the review grid. Nothing is accepted automatically.
 * The kind proposal follows the A.10.1 port classes: databases, caches,
 * messaging, LDAP and Kerberos are `sync`; SMTP and batch transfer are `async`.
 */

import { info,              } from '../../../../core/findings.js';
                                                         
import { cell, mapHeader, num, readTable, skipped,                 } from './table.js';

export const AZURE_DEPENDENCY_SOURCE = 'https://learn.microsoft.com/en-us/azure/migrate/how-to-create-group-machine-dependencies-agentless';

                                                                                                                          
export const AZURE_DEPENDENCY_HEADERS                    = {
  slot: ['Timeslot', 'Time slot'],
  srcServer: ['Source server name', 'Source server', 'Source machine'],
  srcApp: ['Source application'],
  srcProcess: ['Source process'],
  dstServer: ['Destination server name', 'Destination server', 'Destination machine'],
  dstIp: ['Destination IP', 'Destination IP address'],
  dstApp: ['Destination application'],
  dstProcess: ['Destination process'],
  dstPort: ['Destination port'],
};

                                  
                          
                                  
                               
                                  
                                       
                        
                                                        
                         
 

export function parseAzureDependencyCsv(text        )                                                           {
  const t = readTable(text);
  const map = mapHeader(t.header, AZURE_DEPENDENCY_HEADERS, ['srcServer', 'dstPort'], 'plan.sources.azure-dependency', 'The Azure Migrate dependency CSV');
  const findings            = [...map.findings];
  if (!map.ok) return { dependencies: [], findings };
  if (map.index.dstServer === undefined && map.index.dstIp === undefined) {
    return { dependencies: [], findings: [...findings, info('plan.sources.azure-dependency.missing-column', 'The dependency CSV has neither a destination server nor a destination IP column.')] };
  }
  const agg = new Map                                                                   ();
  const bad           = [];
  t.rows.forEach((row, i) => {
    const source = cell(row, map, 'srcServer');
    const destination = cell(row, map, 'dstServer') || cell(row, map, 'dstIp');
    const port = num(cell(row, map, 'dstPort'));
    if (!source || !destination || port === undefined) { bad.push(t.lines[i] ); return; }
    const key = `${source.toLowerCase()}|${destination.toLowerCase()}|${port}`;
    const e = agg.get(key) ?? {
      d: {
        source, destination, port,
        ...(cell(row, map, 'srcProcess') ? { sourceProcess: cell(row, map, 'srcProcess') } : {}),
        ...(cell(row, map, 'dstIp') ? { destinationIp: cell(row, map, 'dstIp') } : {}),
        ...(cell(row, map, 'dstProcess') ? { destinationProcess: cell(row, map, 'dstProcess') } : {}),
      },
      slots: new Set        (),
    };
    e.slots.add(cell(row, map, 'slot') || String(i));
    agg.set(key, e);
  });
  findings.push(...skipped('plan.sources.azure-dependency.row', 'dependency', bad, 'no source, destination or port'));
  return { dependencies: [...agg.values()].map((e) => ({ ...e.d, slots: e.slots.size })), findings };
}

const SYNC_PORTS = new Set([1433, 1521, 5432, 3306, 50000, 5000, 9088, 27017, 6379, 9042, 9200, 11211, 1414, 5672, 9092, 61616, 389, 636, 3268, 3269, 88, 464]);
const ASYNC_PORTS = new Set([25, 465, 587, 21, 22, 990, 873, 445, 2049]);

/** A10.1 port classes: sync for DB / cache / messaging / LDAP / Kerberos; async for SMTP and batch transfer; else sync. */
export function edgeKindForPort(port        )           {
  if (ASYNC_PORTS.has(port)) return 'async';
  if (SYNC_PORTS.has(port)) return 'sync';
  return 'sync';
}

                               
                        
                      
                        
                          
                                
                            
 

/**
 * Dependencies to proposed edges between plan rows (workload names). A
 * destination matched by neither name nor IP is external and listed in a
 * finding instead (a candidate external link).
 */
export function proposeEdges(deps                            , workloads                     )                                                                              {
  const byName = new Map                ();
  const byIp = new Map                ();
  for (const w of workloads) {
    byName.set(w.name.toLowerCase(), w.name);
    byName.set(w.name.toLowerCase().split('.')[0] , w.name);
    for (const ip of w.facts?.ipAddresses ?? []) byIp.set(ip.toLowerCase(), w.name);
  }
  const find = (n         )                     => (n ? byName.get(n.toLowerCase()) ?? byName.get(n.toLowerCase().split('.')[0] ) ?? byIp.get(n.toLowerCase()) : undefined);
  const edges = new Map                      ();
  const external                    = [];
  for (const d of deps) {
    const from = find(d.source);
    const to = find(d.destination) ?? find(d.destinationIp);
    if (!from) continue;
    if (!to) { external.push(d); continue; }
    if (from === to) continue;
    const key = `${from}|${to}|${d.port}`;
    const prev = edges.get(key);
    edges.set(key, { from, to, port: d.port, kind: edgeKindForPort(d.port), observations: (prev?.observations ?? 0) + d.slots, ...(d.destinationProcess ? { process: d.destinationProcess } : {}) });
  }
  const findings            = [];
  if (external.length > 0) {
    const shown = [...new Set(external.map((e) => `${e.destination}:${e.port}`))].slice(0, 5).join(', ');
    findings.push(info('plan.sources.azure-dependency.external', `${external.length} connection${external.length === 1 ? '' : 's'} go to addresses outside the plan (${shown}); review them as external links.`, { source: AZURE_DEPENDENCY_SOURCE }));
  }
  return { edges: [...edges.values()], external, findings };
}
