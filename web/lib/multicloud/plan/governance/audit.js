/**
 * Audit trail of plan changes (addendum A.10.18).
 *
 * Every mutation through a page's state appends an `AuditEntry` to IndexedDB
 * `plan` / key `audit`: `{at, page, area, action, targets[], summary, role?}`.
 * `role` is the optional "Acting as" RACI role from the page header; there is
 * **no user identity** — `auditEntry` drops anything that is not a field of
 * the entry, so a caller cannot slip one in. The trail is capped at 20,000
 * entries (oldest dropped first), with a finding as it nears the cap, and is
 * exported as audit.csv into the evidence pack.
 *
 * Automatic decision entries (RAID decisions) link to their audit rows through
 * `auditRef`.
 */

import { info, warning,              } from '../../../core/findings.js';
import { isOption, RACI_ROLE_OPTIONS } from '../options.js';
import { loadAuditEntries, saveAuditEntries } from '../store.js';
                                                                                 

export const AUDIT_CAP = 20_000;
/** A finding is raised from here on. */
export const AUDIT_WARN_AT = 19_000;
export const AUDIT_COLUMNS = Object.freeze(['at', 'page', 'area', 'action', 'targets', 'summary', 'role']         );

                             
                           
                        
                          
                                       
                           
                           
 

/** A clean entry: only the contract's fields, a UTC time, targets as strings, no identity. */
export function auditEntry(input            , at         = new Date().toISOString())             {
  const role = input.role && isOption(RACI_ROLE_OPTIONS, input.role) ? input.role : undefined;
  return {
    at: new Date(at).toISOString(),
    page: input.page,
    area: String(input.area),
    action: String(input.action),
    targets: (input.targets ?? []).map(String),
    summary: String(input.summary).slice(0, 500),
    ...(role ? { role } : {}),
  };
}

/** Append with the cap: the oldest entries go first. */
export function appendAudit(entries                       , entry            , cap         = AUDIT_CAP)                                                 {
  const all = [...entries, entry];
  const dropped = Math.max(0, all.length - cap);
  const kept = dropped ? all.slice(dropped) : all;
  const findings            = [];
  if (dropped > 0) findings.push(info('audit.trimmed', `The audit trail is at its cap of ${cap} entries; the oldest ${dropped} were dropped. Export audit.csv to keep them.`));
  else if (kept.length >= Math.min(AUDIT_WARN_AT, cap - 1)) {
    findings.push(warning('audit.near-cap', `The audit trail holds ${kept.length} of ${cap} entries; export audit.csv before the oldest are dropped.`));
  }
  return { entries: kept, findings };
}

/**
 * Record one entry in IndexedDB, capped. (store.ts `appendAuditEntry` appends
 * in one transaction but has no cap; this reads, caps and writes, so two pages
 * writing at the same instant can lose one entry — acceptable for an audit
 * of one person's plan, and noted for WP-0.)
 */
export async function recordAudit(input            , at         )                                                                      {
  const entry = auditEntry(input, at);
  const { entries, findings } = appendAudit(await loadAuditEntries(), entry);
  return { saved: await saveAuditEntries(entries), entry, findings };
}

/** A stable reference to an entry, for a decision's `links`: `audit:<at>:<action>`. */
export const auditRef = (e                                   )         => `audit:${e.at}:${e.action}`;

/** The audit entries a decision links to. */
export function auditFor(decision                             , entries                       )               {
  const refs = new Set(decision.links.filter((l) => l.startsWith('audit:')));
  return entries.filter((e) => refs.has(auditRef(e)));
}

                                                                                                                                                                                    
export function filterAudit(entries                       , f             )               {
  return entries.filter((e) =>
    (!f.from || e.at >= f.from) && (!f.to || e.at <= f.to) && (!f.page || e.page === f.page)
    && (!f.area || e.area === f.area) && (!f.role || e.role === f.role) && (!f.target || e.targets.includes(f.target)));
}

const csvField = (t        )         => (/[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);
/** audit.csv: targets joined with a space. */
export function auditCsv(entries                       )         {
  const lines = [AUDIT_COLUMNS.join(',')];
  for (const e of entries) lines.push([e.at, e.page, e.area, e.action, e.targets.join(' '), e.summary, e.role ?? ''].map(csvField).join(','));
  return `${lines.join('\n')}\n`;
}
