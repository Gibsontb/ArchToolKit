/**
 * Facility and contracts (addendum A.5.5): when each contract must be
 * terminated, and whether each asset leaving the building was sanitised.
 *
 *  - `Terminate by = min(ends, exit date) − notice days`: a dated task, and an
 *    error (`dc.terminate-by-past`) when that date has already gone. Circuits
 *    carry their own contract end and notice period in their facts, and are
 *    treated the same way.
 *  - Every asset with `Contains data = yes` needs a sanitisation method (NIST
 *    SP 800-88: clear, purge or destroy) and a certificate id before it can be
 *    marked disposed (`dc.sanitise`).
 *  - The asset register update is exported as CSV (A.10.5).
 *
 * NIST SP 800-88 is cited at its current revision (Rev. 2, 2025); the
 * clear / purge / destroy categories are the ones every revision has used.
 */

import { toCsv } from '../../../core/csv.js';
import { error, info, warning,              } from '../../../core/findings.js';
                                                                                                       

export const NIST_800_88 = 'https://csrc.nist.gov/pubs/sp/800/88/r2/final';

export const SANITISATION_METHODS                                                                      = [
  { value: 'clear', label: 'Clear (logical overwrite; the media is reused inside the organisation)' },
  { value: 'purge', label: 'Purge (cryptographic erase or block erase; the media can leave)' },
  { value: 'destroy', label: 'Destroy (shred, disintegrate, incinerate)' },
];

export const CONTRACT_KINDS                          = ['support', 'maintenance', 'colocation', 'power', 'circuit', 'licence', 'lease'];

const DAY = 86_400_000;
const iso = (ms        )         => new Date(ms).toISOString().slice(0, 10);
const parse = (d                    )                => {
  if (!d || !/^\d{4}-\d{2}-\d{2}/.test(d)) return null;
  const ms = Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
};

/** `min(ends, exitDate) − noticeDays`, as an ISO date; null when `ends` is not a date. */
export function terminateBy(ends        , noticeDays        , exitDate         )                {
  const e = parse(ends);
  if (e === null) return null;
  const x = parse(exitDate);
  const base = x === null ? e : Math.min(e, x);
  return iso(base - Math.max(0, noticeDays) * DAY);
}

                               

                               
                      
                                          
                              
                          
                        
                              
                                      
                                                                             
                            
                                  
 

/**
 * Every contract, and every circuit with a contract end, as a dated
 * termination task. `status` comes from the Contracts grid's Status column
 * (the `Contract` record has no status field yet: see the WP-22 report).
 */
export function contractTasks(
  dc        ,
  today        ,
  status                                           = {},
)                                                                                     {
  const findings            = [];
  const now = parse(today) ?? Date.now();
  const tasks                 = [];
  const add = (id        , source                        , kind              , vendor        , ends        , noticeDays        )       => {
    const by = terminateBy(ends, noticeDays, dc.exitDate);
    const s = status[id] ?? dc.contracts.find((c) => c.id === id)?.status ?? 'active';
    const byMs = parse(by ?? undefined);
    const overdue = s === 'active' && byMs !== null && byMs < now;
    tasks.push({ id, source, kind, vendor, ends, noticeDays, terminateBy: by, overdue, status: s });
    if (by === null) findings.push(warning('dc.contract-date', `Contract ${id} (${vendor}) has no end date to count the notice from.`, { path: `contracts.${id}` }));
    else if (overdue) {
      findings.push(
        error('dc.terminate-by-past', `Contract ${id} (${vendor}) had to be terminated by ${by} (${noticeDays} days' notice before ${ends < (dc.exitDate ?? ends) ? 'it ends' : 'the exit date'}); that date has passed.`, {
          path: `contracts.${id}`,
          remediation: 'Give notice now and record the cost of the extra term, or negotiate an early exit.',
        }),
      );
    }
  };
  for (const c of dc.contracts) add(c.id, 'contract', c.kind, c.vendor, c.ends, c.noticeDays);
  for (const item of dc.infra) {
    if (item.category !== 'circuit' || !item.facts.contractEnd) continue;
    add(item.id, 'circuit', 'circuit', item.facts.provider ?? item.vendor ?? '', item.facts.contractEnd, Number(item.facts.noticeDays ?? 0));
  }
  tasks.sort((a, b) => (a.terminateBy ?? '9999').localeCompare(b.terminateBy ?? '9999') || a.id.localeCompare(b.id));
  return { tasks, findings };
}

/** Contracts whose terminate-by date falls in a window, for the programme calendar. */
export function contractsDueBetween(tasks                         , from        , to        )                 {
  return tasks.filter((t) => t.terminateBy !== null && t.terminateBy >= from && t.terminateBy <= to);
}

/* ----------------------------------------------------------------- assets --- */

/** Assets that cannot be marked disposed yet, and why. */
export function checkAssets(assets                  )            {
  const findings            = [];
  for (const a of assets) {
    if (!a.containsData) continue;
    const missing = [!a.sanitisation ? 'a sanitisation method' : '', !a.certificateId ? 'a certificate id' : ''].filter(Boolean);
    if (missing.length === 0) continue;
    if (a.disposedOn) {
      findings.push(
        error('dc.sanitise', `Asset ${a.id} (${a.kind}${a.serial ? `, serial ${a.serial}` : ''}) holds data and is marked disposed without ${missing.join(' or ')}.`, {
          path: `assets.${a.id}`,
          remediation: 'Record the NIST SP 800-88 method (clear, purge or destroy) and the sanitisation certificate id before disposal.',
          source: NIST_800_88,
        }),
      );
    } else {
      findings.push(info('dc.sanitise-pending', `Asset ${a.id} holds data: it needs ${missing.join(' and ')} before it is disposed.`, { path: `assets.${a.id}`, source: NIST_800_88 }));
    }
  }
  return findings;
}

/** Can the asset be marked disposed: data-bearing assets need a method and a certificate. */
export function canDispose(a       )          {
  return !a.containsData || (!!a.sanitisation && !!a.certificateId);
}

/** The asset register update (A.10.5), one row per asset. */
export function assetRegisterCsv(assets                  )         {
  const headers = ['asset', 'kind', 'serial', 'location', 'contains_data', 'sanitisation', 'certificate_id', 'disposed_on', 'register_updated'];
  const rows = assets.map((a) => ({
    asset: a.id,
    kind: a.kind,
    serial: a.serial ?? '',
    location: a.location ?? '',
    contains_data: a.containsData ? 'yes' : 'no',
    sanitisation: a.sanitisation ?? '',
    certificate_id: a.certificateId ?? '',
    disposed_on: a.disposedOn ?? '',
    register_updated: a.registerUpdated ? 'yes' : 'no',
  }));
  return rows.length ? toCsv(rows, headers) : `${headers.join(',')}\n`;
}

                         
