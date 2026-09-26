/**
 * The Utilities catalogue (addendum A.9, WP-20; Lead decision 1: the
 * "Utilities" area of Multi-Cloud Migration & Utilities, `#utilities` and
 * `#utilities:<utility-id>`): small day-2 changes without a migration, and
 * deploying a single new service.
 *
 * Each utility declares its id, label, category, the platforms it supports,
 * its typed inputs (a dropdown wherever the set is closed; `from` marks the
 * ones the page fills from the plan, the tracker and the settings), its
 * risk, whether it is reversible, and `build(values, context)`.
 * `generateChange` turns one into a change bundle (bundle.ts); the log is
 * log.ts.
 *
 * Every row of the addendum's catalogue (A.9.2) is here, plus the day-2
 * changes an operator expects that the table does not list: remove a
 * server, rotate a certificate, restart a service, install or remove
 * software, add a user or group, grant cloud access.
 *
 * Pure: no DOM (the log's store functions are async and use IndexedDB).
 */

                                                                            
import { appPlanOf, appWorkloads } from '../plan/apps/components.js';
import { PLATFORM_LABELS } from '../plan/options.js';
                                                 
import { buildChangeBundle,                   } from './bundle.js';
import { deployService } from './deploy.js';
import { ACCESS_UTILITIES } from './utilities/access.js';
import { CATALOGUE_UTILITIES } from './utilities/catalogue.js';
import {
  UTILITY_CATEGORY_LABELS, opt, workloadPlatform,
                                                                                                    
} from './utilities/common.js';
import { COMPUTE_UTILITIES } from './utilities/compute.js';
import { CONTAINER_UTILITIES } from './utilities/containers.js';
import { DATABASE_UTILITIES } from './utilities/database.js';
import { GOVERNANCE_UTILITIES } from './utilities/governance.js';
import { NETWORK_UTILITIES } from './utilities/network.js';
import { OPERATIONS_UTILITIES } from './utilities/operations.js';
import { PROTECTION_UTILITIES } from './utilities/protection.js';
import { STORAGE_UTILITIES } from './utilities/storage.js';

             
                                                                                                                                        
                               
export { UTILITY_CATEGORY_LABELS, applyPlanOps, describePlanOp, revertPlanOps } from './utilities/common.js';
export { buildChangeBundle, bundleViolations, changeId, CHANGE_KIND, valuesOf,                   } from './bundle.js';
export {
  CHANGE_LOG_COLUMNS, applyChangeEvents, changeLogGrid, changeLogRows, changeState, importUtilityEvents, loadUtilityLog, parseStatusEvents,
  recordOf, recordUtilityRun, removeChangeRecord, setChangeCr, setUtilityCr, upsertChangeRecord,                                     
} from './log.js';
export { deployService, smokePlaybook } from './deploy.js';

/** The page area (Lead decision 1). */
export const UTILITIES_HASH = '#utilities';
export const utilityHash = (id        )         => `${UTILITIES_HASH}:${id}`;

/** The A.9.2 table's order. */
const TABLE_ORDER = [
  'add-server', 'resize-server', 'add-disk', 'extend-disk', 'add-database', 'open-port', 'dns-record', 'lb-member', 'snapshot-backup', 'patch-run',
  'tags', 'scale-node-pool', 'file-share', 'monitoring-alert', 'power', 'budget', 'add-any', 'deploy-service',
];
function orderUtilities(list                          )                  {
  const rank = (u               )         => {
    const i = TABLE_ORDER.indexOf(u.id);
    return i >= 0 ? (u.id === 'deploy-service' ? 1000 : i) : 100;
  };
  return [...list].sort((a, b) => rank(a) - rank(b));
}

/** Every utility: the A.9.2 rows in the table's order, then the added ones, then Deploy a new service. */
export const UTILITIES                           = Object.freeze(orderUtilities([
  ...COMPUTE_UTILITIES, ...STORAGE_UTILITIES, ...DATABASE_UTILITIES, ...NETWORK_UTILITIES, ...PROTECTION_UTILITIES,
  ...OPERATIONS_UTILITIES, ...GOVERNANCE_UTILITIES, ...CONTAINER_UTILITIES, ...ACCESS_UTILITIES, ...CATALOGUE_UTILITIES, deployService,
]));

export function findUtility(id        )                            {
  return UTILITIES.find((u) => u.id === id);
}

/** The utilities a platform supports. */
export function utilitiesFor(platform          )                  {
  return UTILITIES.filter((u) => u.platforms.includes(platform));
}

/** The catalogue grouped by category, for the page's list. */
export function utilitiesByCategory()                                                                             {
  const cats = Object.keys(UTILITY_CATEGORY_LABELS)                     ;
  return cats.map((c) => ({ category: c, label: UTILITY_CATEGORY_LABELS[c], utilities: UTILITIES.filter((u) => u.category === c) })).filter((g) => g.utilities.length > 0);
}

/** The utility's defaults (the first render), on a platform. */
export function defaultUtilityValues(u               , platform           = u.platforms[0] )                         {
  const out                         = {};
  for (const i of u.inputs) {
    const d = i.default;
    out[i.id] = d === undefined ? (i.control === 'select' && !i.blankLabel && i.options?.[0] ? i.options[0].value : '') : String(d);
  }
  out.platform = platform;
  return out;
}

/**
 * The options of a plan-fed input: the plan's servers (by app, with the
 * platform they land on) and the tracker's cut-over targets, the apps, the
 * new apps, the components and clusters, the databases, the DNS zones and
 * load balancers of the execution settings.
 */
export function planOptions(source            , ctx                )                 {
  const plan = ctx.plan;
  if (!plan) return [];
  switch (source) {
    case 'server': {
      const seen = new Set        ();
      const out                 = [];
      for (const w of plan.workloads) {
        if (seen.has(w.name)) continue;
        seen.add(w.name);
        const p = workloadPlatform(plan, w);
        out.push(opt(w.name, `${w.name}${p ? ` (${PLATFORM_LABELS[p]})` : ''}`, w.app || 'No app'));
      }
      for (const s of Object.values(ctx.tracker?.items ?? {})) {
        if (s.kind !== 'workload' || !['cut-over', 'validated', 'accepted'].includes(s.state)) continue;
        const w = plan.workloads.find((x) => x.id === s.item);
        const name = w?.rename ?? w?.name;
        if (name && !seen.has(name)) {
          seen.add(name);
          out.push(opt(name, `${name} (cut over)`, 'Cut-over targets'));
        }
      }
      return out;
    }
    case 'app':
      return plan.apps.map((a) => opt(a.name, a.name));
    case 'new-app':
      return plan.apps.filter((a) => {
        const ap = appPlanOf(plan, a.id);
        return ap?.origin === 'new' && (ap.status === 'planned' || ap.status === 'approved');
      }).map((a) => opt(a.name, `${a.name} (${appPlanOf(plan, a.id)?.platform ? PLATFORM_LABELS[appPlanOf(plan, a.id) .platform ] : 'not placed'})`));
    case 'component':
    case 'cluster': {
      const out                 = [];
      for (const a of plan.apps) {
        const ap = appPlanOf(plan, a.id);
        if (!ap) continue;
        const comps = ap.platform ? ap.variants[ap.platform] ?? [] : [];
        for (const c of comps) {
          if (source === 'cluster' && !(c.kind === 'pattern' && c.tierPattern === 'containers')) continue;
          out.push(opt(`${a.name}/${c.name}`, `${a.name} / ${c.name}`, a.name));
        }
      }
      return out;
    }
    case 'database':
      return plan.databases.map((d) => opt(d.name, `${d.name} (${d.engine})`, d.app || 'No app'));
    case 'dns-zone':
      return (plan.execution?.dnsZones ?? []).map((z) => opt(z.zone, `${z.zone} (${z.provider}${z.private ? ', private' : ''})`));
    case 'lb':
      return (plan.execution?.lbs ?? []).map((l) => opt(l.pool, `${l.app}: ${l.pool} (${l.kind})`));
    default:
      return [];
  }
}

/**
 * The utility's inputs for the form, with the plan-fed options filled in and
 * the options that depend on other answers (`optionsFor`). A plan-fed text
 * input becomes a combo, so a target outside the plan can still be typed.
 */
export function utilityInputs(u               , values                 , ctx                )                 {
  return u.inputs.map((i) => {
    const dyn = u.optionsFor?.(i.id, values, ctx);
    const fed = i.from ? planOptions(i.from, ctx) : [];
    if (!dyn && !fed.length) return i;
    const options = [...fed, ...(dyn ?? i.options ?? [])];
    return { ...i, control: i.control === 'text' || i.control === 'select' ? (i.control === 'select' && !fed.length ? 'select' : 'combo') : i.control, options };
  });
}

/** Build a utility's change bundle by id. */
export function generateChange(id        , values                 , ctx                 = {})               {
  const u = findUtility(id);
  if (!u) throw new RangeError(`No utility "${id}".`);
  return buildChangeBundle(u, values, ctx);
}

/** How many servers the plan has per app, for the catalogue's counts. */
export function planServerCount(ctx                , app        )         {
  const a = ctx.plan?.apps.find((x) => x.name === app);
  return a && ctx.plan ? appWorkloads(ctx.plan, a).length : 0;
}
