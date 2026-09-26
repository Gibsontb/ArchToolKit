/**
 * App grouping rules (addendum A.2.1): which application a server belongs to.
 *
 * `plan.intake.grouping` is an ordered list of rules; the first rule that
 * yields a name wins. A server no rule names goes to "Unassigned", which is
 * flagged. Re-grouping never touches a row whose `app` cell was edited.
 *
 * | Rule            | Key or pattern |
 * |-----------------|----------------|
 * | `attribute`     | a custom-attribute key, or a tag / label key from a collector file (`a|b` = either) |
 * | `folder-leaf`   | none: the VM folder's last segment |
 * | `vapp`          | none |
 * | `resource-pool` | none |
 * | `name-regex`    | a regex with a named group `app` and an optional `tier` |
 * | `cloud-tag`     | a tag key on AWS / Azure / Google Cloud (GCP) / OCI sources (`a|b` = either) |
 * | `csv-column`    | the `app` column of an imported CSV |
 */

import { warning,              } from '../../../core/findings.js';
                                                                               

/** The app servers go to when no rule names one. */
export const UNASSIGNED_APP = 'Unassigned';

/** The design's example: `crm-web01` → app `crm`, tier `web`. */
export const DEFAULT_NAME_REGEX = '^(?<app>[a-z]{3,})-(?<tier>web|app|db)\\d+';

/** The default order: attribute(app|application|service), cloud-tag(app|application), folder-leaf, name-regex. */
export const DEFAULT_GROUPING                          = Object.freeze([
  { rule: 'attribute', key: 'app|application|service' },
  { rule: 'cloud-tag', key: 'app|application' },
  { rule: 'folder-leaf' },
  { rule: 'name-regex', key: DEFAULT_NAME_REGEX },
]);

/** What the rules can read about one server. Every field is optional. */
                                  
                        
                                                                     
                                                         
                                                                    
                                                   
                                           
                           
                         
                                 
                                           
                           
 

                              
                       
                                            
                         
                                      
 

/** A key list `a|b|c`, matched case-insensitively against the record's keys, in the list's order. */
function byKey(record                                              , key                    )                     {
  if (!record || !key) return undefined;
  const wanted = key.split('|').map((k) => k.trim().toLowerCase()).filter((k) => k !== '');
  const entries = Object.entries(record);
  for (const w of wanted) {
    const hit = entries.find(([k, v]) => k.toLowerCase() === w && v.trim() !== '');
    if (hit) return hit[1].trim();
  }
  return undefined;
}

const regexCache = new Map                       ();
function compile(pattern        )                {
  if (!regexCache.has(pattern)) {
    let re                = null;
    try { re = new RegExp(pattern, 'i'); } catch { re = null; }
    regexCache.set(pattern, re);
  }
  return regexCache.get(pattern) ;
}

/** True when a `name-regex` key compiles and has a named group `app`. */
export function validNameRegex(pattern        )          {
  const re = compile(pattern);
  return !!re && /\(\?<app>/.test(pattern);
}

/** One rule applied to one server: the app name it yields, if any. */
export function applyRule(subject                 , rule              )                          {
  switch (rule.rule) {
    case 'attribute': {
      const app = byKey(subject.attributes, rule.key) ?? byKey(subject.tags, rule.key);
      return app ? { app, rule: rule.rule } : undefined;
    }
    case 'cloud-tag': {
      const app = byKey(subject.tags, rule.key);
      return app ? { app, rule: rule.rule } : undefined;
    }
    case 'folder-leaf': {
      const leaf = (subject.folder ?? '').split('/').map((s) => s.trim()).filter((s) => s !== '').pop();
      return leaf ? { app: leaf, rule: rule.rule } : undefined;
    }
    case 'vapp':
      return subject.vapp?.trim() ? { app: subject.vapp.trim(), rule: rule.rule } : undefined;
    case 'resource-pool': {
      const pool = subject.resourcePool?.trim();
      return pool && pool !== 'Resources' ? { app: pool, rule: rule.rule } : undefined;
    }
    case 'name-regex': {
      const re = compile(rule.key ?? DEFAULT_NAME_REGEX);
      const m = re?.exec(subject.name);
      const app = m?.groups?.app;
      if (!app) return undefined;
      const tier = m.groups?.tier;
      return { app, ...(tier ? { tier: tier.toLowerCase() } : {}), rule: rule.rule };
    }
    case 'csv-column':
      return subject.csvApp?.trim() ? { app: subject.csvApp.trim(), rule: rule.rule } : undefined;
    default:
      return undefined;
  }
}

/** The first rule that yields a name, or undefined. */
export function groupApp(subject                 , rules                          = DEFAULT_GROUPING)                          {
  for (const rule of rules) {
    const hit = applyRule(subject, rule);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Re-runs the rules over workload rows. Rows whose `app` was edited keep it;
 * the rest take the first rule's name, or "Unassigned" (with one finding).
 * `subjects` is matched to rows by name (case-insensitive); a row with no
 * subject is grouped by its name alone.
 */
export function regroup(
  workloads                     , subjects                            , rules                          = DEFAULT_GROUPING,
)                                                                                          {
  const byName = new Map(subjects.map((s) => [s.name.toLowerCase(), s]));
  const unassigned           = [];
  const tiers                         = {};
  const out = workloads.map((w) => {
    if ((w.edited ?? []).includes('app')) return w;
    const hit = groupApp(byName.get(w.name.toLowerCase()) ?? { name: w.name }, rules);
    if (hit?.tier) tiers[w.id] = hit.tier;
    const app = hit?.app ?? UNASSIGNED_APP;
    if (!hit) unassigned.push(w.name);
    return app === w.app ? w : { ...w, app };
  });
  const findings            = [];
  if (unassigned.length > 0) {
    const shown = unassigned.slice(0, 5).join(', ') + (unassigned.length > 5 ? ` and ${unassigned.length - 5} more` : '');
    findings.push(warning('plan.sources.unassigned', `${unassigned.length} server${unassigned.length === 1 ? '' : 's'} matched no grouping rule and went to "${UNASSIGNED_APP}": ${shown}.`, {
      remediation: 'Add a grouping rule on the Sources screen (an attribute, a tag or a name pattern), or type the app on the Servers grid.',
    }));
  }
  return { workloads: out, findings, tiers };
}

/** The component tier of a server: the `name-regex` tier when present, else by Role (A.2.1). */
export function tierOf(role      , regexTier         )                {
  if (regexTier) {
    const t = regexTier.toLowerCase();
    if (t === 'web') return 'web';
    if (t === 'app' || t === 'api' || t === 'svc') return 'app';
    if (t === 'db' || t === 'data' || t === 'sql') return 'data';
  }
  switch (role) {
    case 'web': return 'web';
    case 'app': case 'middleware': case 'batch': return 'app';
    case 'messaging': return 'integration';
    case 'db': return 'data';
    case 'file': return 'file';
    case 'rds-vdi': return 'vdi';
    case 'ad-dc': case 'dns-dhcp': case 'monitoring': case 'backup': case 'jump': return 'infra';
    case 'appliance': return 'edge';
    default: return 'other';
  }
}
