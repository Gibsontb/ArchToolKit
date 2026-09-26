/**
 * The decision wizard's answers → the app's components on the chosen cloud,
 * so that what the wizard recommends is what `generateAppStack` builds.
 *
 * The table (`WIZARD_MAP`) reads the answers the recommendation cards read:
 *
 *   Compute pattern   architecture × team strengths × traffic (per cloud, as
 *                     the engine's cards choose) → the web / app tiers' tier
 *                     pattern; a rehost stays on VMs, a relocate goes to the
 *                     cloud's VMware service, retain / retire build nothing
 *   Data & storage    the database target (managed / VMs / the engine's
 *                     choice) and the data pattern → the data tier's pattern
 *   Integration       enterprise messaging / event streaming / orchestration /
 *                     HTTP APIs → an integration component (new services and
 *                     re-platformed or refactored apps)
 *   Security          an F5 perimeter or F5 usage → an F5 BIG-IP appliance
 *   Connectivity      every cross-cloud connector this app builds → a
 *                     `<p>_app_connector` component (connectors.ts)
 *
 * A tier pattern the platform does not have (`tierAvailable`) is left as it
 * is and reported. The wizard never overwrites a choice the user made on the
 * components: it records what it set (`settings.atk_wizard_tp`) and only
 * changes a component whose tier pattern is still that, is unset, or when the
 * app is designed for the first time. The components it adds carry
 * `settings.atk_wizard = 'yes'` and are the only ones it removes.
 */

                                                         
import { info } from '../../../core/findings.js';
import { PLATFORM_LABELS, TIER_PATTERN_OPTIONS, labelOf } from '../options.js';
import { isNone, tierAvailable, tierTarget } from '../patterns/index.js';
                                                                                                                       
import { appConnectors } from './connectors.js';
import { appPlanOf, componentId, ensureVariant, findApp, withAppPlan } from './components.js';

                                                                           

/** One answer as text (the first of a list). */
export const one = (a         , k        )         => {
  const v = a[k];
  return Array.isArray(v) ? String(v[0] ?? '') : typeof v === 'string' ? v : '';
};
/** One answer as a list. */
export const many = (a         , k        )           => {
  const v = a[k];
  return Array.isArray(v) ? v.map(String).filter(Boolean) : typeof v === 'string' && v ? [v] : [];
};

                                                                                                                

/** One row of the mapping table: which answers, on which platforms, give which tier pattern for which tiers. */
                               
                            
                        
                                           
                                               
                                                      
 

const skill = (a         , s        )          => many(a, 'teamSkills').includes(s);
const arch = (a         )         => one(a, 'architectureType') || 'web-api';
const route = (a         )         => one(a, 'migrationApproach');
const migrating = (a         )          => (one(a, 'initiativeType') || 'migration') === 'migration';
const lowMed = (a         )          => one(a, 'trafficPattern') === 'low' || one(a, 'trafficPattern') === 'medium';
/** A migration that keeps the servers as they are: its compute follows the R, not the architecture. */
const keepsServers = (a         )          => migrating(a) && ['rehost', 'relocate', 'retain', 'retire', ''].includes(route(a));

const WEB                           = ['web', 'app'];

/**
 * The mapping table, first match wins per card. The compute rows follow the
 * engine's cards (engine.js generateCloudRecommendation), cloud by cloud.
 */
export const WIZARD_MAP                          = [
  // ---- Compute: the R first, for a migration that keeps its servers.
  { card: 'compute', when: 'Migration, retire', tiers: WEB, tierPattern: 'retire', test: (a) => migrating(a) && route(a) === 'retire' },
  { card: 'compute', when: 'Migration, retain', tiers: WEB, tierPattern: 'retain', test: (a) => migrating(a) && route(a) === 'retain' },
  { card: 'compute', when: 'Migration, relocate (VMware on the cloud)', tiers: WEB, tierPattern: 'vmware-service', test: (a) => migrating(a) && route(a) === 'relocate' },
  { card: 'compute', when: 'Migration, rehost (or no R yet)', tiers: WEB, tierPattern: 'vm', test: (a) => keepsServers(a) },
  // ---- Compute: the architecture, for a new service or a re-platformed / refactored app.
  { card: 'compute', when: 'Legacy / VM-centric', tiers: WEB, tierPattern: 'vm', test: (a) => arch(a) === 'legacy-vm' },
  { card: 'compute', when: 'Microservices', tiers: WEB, tierPattern: 'containers', test: (a) => arch(a) === 'microservices' },
  { card: 'compute', when: 'Batch', tiers: ['app'], tierPattern: 'batch', test: (a, p) => arch(a) === 'batch' && p !== 'vmware' },
  { card: 'compute', when: 'Event-driven', tiers: ['app'], tierPattern: 'serverless', test: (a, p) => arch(a) === 'event-driven' && p !== 'vmware' },
  { card: 'compute', when: 'Event-driven on VCF (VKS)', tiers: ['app'], tierPattern: 'containers', test: (a, p) => arch(a) === 'event-driven' && p === 'vmware' },
  { card: 'compute', when: 'Web / API, Azure: low or medium traffic and PaaS skills → App Service', tiers: WEB, tierPattern: 'paas-web', test: (a, p) => p === 'azure' && arch(a) === 'web-api' && lowMed(a) && skill(a, 'paas') },
  { card: 'compute', when: 'Web / API, Azure: spiky traffic and serverless skills → Functions', tiers: WEB, tierPattern: 'serverless', test: (a, p) => p === 'azure' && arch(a) === 'web-api' && one(a, 'trafficPattern') === 'spiky' && skill(a, 'serverless') },
  { card: 'compute', when: 'Web / API, AWS: low or medium traffic and serverless skills → Lambda', tiers: WEB, tierPattern: 'serverless', test: (a, p) => p === 'aws' && arch(a) === 'web-api' && lowMed(a) && skill(a, 'serverless') },
  { card: 'compute', when: 'Web / API, AWS: PaaS skills → Elastic Beanstalk', tiers: WEB, tierPattern: 'paas-web', test: (a, p) => p === 'aws' && arch(a) === 'web-api' && skill(a, 'paas') },
  { card: 'compute', when: 'Web / API, Google Cloud: serverless or PaaS skills → Cloud Run', tiers: WEB, tierPattern: 'paas-web', test: (a, p) => p === 'google' && arch(a) === 'web-api' && (skill(a, 'serverless') || skill(a, 'paas')) },
  { card: 'compute', when: 'Web / API, OCI: serverless skills → OCI Functions', tiers: WEB, tierPattern: 'serverless', test: (a, p) => p === 'oci' && arch(a) === 'web-api' && skill(a, 'serverless') },
  { card: 'compute', when: 'Web / API: container skills → managed Kubernetes', tiers: WEB, tierPattern: 'containers', test: (a) => arch(a) === 'web-api' && skill(a, 'containers') },
  { card: 'compute', when: 'Web / API, otherwise → VMs', tiers: WEB, tierPattern: 'vm', test: (a) => arch(a) === 'web-api' },
  { card: 'compute', when: 'Data / analytics → the batch service', tiers: ['app'], tierPattern: 'batch', test: (a, p) => arch(a) === 'data-analytics' && p !== 'vmware' },
  // ---- Data.
  { card: 'data', when: 'Databases kept on VMs', tiers: ['data'], tierPattern: 'vm', test: (a) => one(a, 'dbStrategy') === 'vm' },
  { card: 'data', when: 'Managed database services', tiers: ['data'], tierPattern: 'managed-db', test: (a, p) => one(a, 'dbStrategy') === 'managed' && p !== 'vmware' },
  { card: 'data', when: 'The engine\'s choice per database', tiers: ['data'], tierPattern: 'engine', test: (a) => one(a, 'dbStrategy') === 'engine' || (migrating(a) && one(a, 'dbStrategy') === '') },
  { card: 'data', when: 'New service, relational or NoSQL → managed database', tiers: ['data'], tierPattern: 'managed-db', test: (a, p) => !migrating(a) && (one(a, 'dataType') === 'relational' || one(a, 'dataType') === 'nosql') && p !== 'vmware' },
  { card: 'data', when: 'New service, files / objects', tiers: ['data', 'file'], tierPattern: 'object-storage', test: (a, p) => !migrating(a) && one(a, 'dataType') === 'files' && p !== 'vmware' },
  { card: 'data', when: 'New service, streaming', tiers: ['data'], tierPattern: 'managed-kafka', test: (a, p) => !migrating(a) && one(a, 'dataType') === 'streaming' && p !== 'vmware' },
  { card: 'data', when: 'New service, analytics lake', tiers: ['data'], tierPattern: 'object-storage', test: (a, p) => !migrating(a) && one(a, 'dataType') === 'analytics-lake' && p !== 'vmware' },
  // ---- Integration (a component of its own, for new services and re-platformed / refactored apps).
  { card: 'integration', when: 'Enterprise messaging', tiers: ['integration'], tierPattern: 'managed-messaging', test: (a) => one(a, 'integrations') === 'enterprise-messaging' && !keepsServers(a) },
  { card: 'integration', when: 'Event streaming', tiers: ['integration'], tierPattern: 'managed-kafka', test: (a) => one(a, 'integrations') === 'event-streaming' && !keepsServers(a) },
  { card: 'integration', when: 'Orchestration', tiers: ['integration'], tierPattern: 'workflow', test: (a) => one(a, 'integrations') === 'orchestration' && !keepsServers(a) },
  { card: 'integration', when: 'HTTP APIs', tiers: ['integration'], tierPattern: 'api-gateway', test: (a) => one(a, 'integrations') === 'simple-http' && !migrating(a) },
];

/** The first row of a card that matches. */
export function mapRow(card            , a         , p          )                           {
  return WIZARD_MAP.find((r) => r.card === card && r.test(a, p));
}

/** The F5 perimeter the answers ask for. */
export const wantsF5 = (a         )          =>
  one(a, 'perimeterPattern') === 'cloud-plus-f5' || one(a, 'perimeterPattern') === 'f5-centric' || many(a, 'f5Usage').length > 0;

                                    
                      
                                                                    
                                     
 

const WIZ = 'atk_wizard';
const WIZ_TP = 'atk_wizard_tp';

function setTp(c                  , tp                         )                   {
  const { tierPattern: _t, ...rest } = c;
  const settings = { ...c.settings };
  if (tp) settings[WIZ_TP] = tp;
  else delete settings[WIZ_TP];
  return { ...(tp ? { ...rest, tierPattern: tp } : rest), settings }                    ;
}

/**
 * Apply the answers to the app's variant on `platform` (created first when
 * missing). Pure: returns the new plan and what changed.
 */
export function applyWizard(plan      , appId        , platform          , answers         )                    {
  const app = findApp(plan, appId);
  if (!app) return { plan, notes: [] };
  const notes            = [];
  const e = ensureVariant(plan, app.id, platform);
  const ap          = e.appPlan;
  const firstPass = !appPlanOf(plan, app.id)?.design;
  const list = [...(ap.variants[platform] ?? [])];
  const here = PLATFORM_LABELS[platform];

  // 1. Tier patterns of the app's own components.
  const byCard                                                        = {
    compute: mapRow('compute', answers, platform),
    data: mapRow('data', answers, platform),
  };
  const out                 = list.map((c) => {
    if (c.kind !== 'pattern' || c.settings[WIZ] === 'yes') return c;
    const row = [byCard.compute, byCard.data].find((r) => r && r.tiers.includes(c.tier));
    if (!row) return c;
    if (row.card === 'data' && c.databases.length === 0 && c.servers.length > 0 && migrating(answers)) return c;
    const mine = c.settings[WIZ_TP];
    const userOwned = !!c.tierPattern && c.tierPattern !== mine && !firstPass;
    if (userOwned) {
      notes.push(info('wizard.kept', `${c.name}: kept your tier pattern ${labelOf(TIER_PATTERN_OPTIONS, c.tierPattern )} (the wizard would choose ${row.tierPattern === 'engine' ? 'the engine\'s' : labelOf(TIER_PATTERN_OPTIONS, row.tierPattern)}).`));
      return c;
    }
    if (row.tierPattern === 'engine') return mine ? setTp(c, undefined) : c;
    if (!tierAvailable(row.tierPattern, platform)) {
      const t = tierTarget(row.tierPattern, platform);
      notes.push(info('wizard.not-on-platform', `${c.name}: ${labelOf(TIER_PATTERN_OPTIONS, row.tierPattern)} is not on ${here}${isNone(t) ? `: ${t.none}` : ''}`));
      return c;
    }
    if (c.tierPattern === row.tierPattern && mine === row.tierPattern) return c;
    notes.push(info('wizard.set', `${c.name}: ${labelOf(TIER_PATTERN_OPTIONS, row.tierPattern)} (${row.when}).`));
    return setTp(c, row.tierPattern);
  });

  // 2. The components the wizard adds: integration, F5, connectors.
  const wanted                     = [];
  const integ = mapRow('integration', answers, platform);
  if (integ && integ.tierPattern !== 'engine' && tierAvailable(integ.tierPattern, platform) && !out.some((c) => c.tier === 'integration' && !(c.kind === 'pattern' && c.settings[WIZ] === 'yes'))) {
    wanted.push({ id: componentId(app.name, 'integration'), name: 'integration', tier: 'integration', kind: 'pattern', tierPattern: integ.tierPattern, servers: [], databases: [], settings: { [WIZ]: 'yes' } });
  } else if (integ && integ.tierPattern !== 'engine' && !tierAvailable(integ.tierPattern, platform)) {
    const t = tierTarget(integ.tierPattern, platform);
    notes.push(info('wizard.not-on-platform', `Integration: ${labelOf(TIER_PATTERN_OPTIONS, integ.tierPattern)} is not on ${here}${isNone(t) ? `: ${t.none}` : ''}`));
  }
  if (wantsF5(answers)) {
    wanted.push({ id: componentId(app.name, 'f5-bigip'), name: 'f5-bigip', tier: 'edge', kind: 'pattern', tierPattern: 'appliance', servers: [], databases: [], settings: { [WIZ]: 'yes', vendor: 'f5' } });
  }
  for (const c of appConnectors(plan, app.id, platform, answers)) {
    if (!c.component) continue;
    wanted.push({ id: componentId(app.name, c.component.name), name: c.component.name, tier: 'infra', kind: 'pattern', servers: [], databases: [], settings: { [WIZ]: 'yes', ...c.component.settings } });
  }
  const wantedIds = new Set(wanted.map((w) => w.id));
  const kept = out.filter((c) => !(c.kind === 'pattern' && c.settings[WIZ] === 'yes' && !wantedIds.has(c.id)));
  for (const c of out) if (c.kind === 'pattern' && c.settings[WIZ] === 'yes' && !wantedIds.has(c.id)) notes.push(info('wizard.removed', `${c.name}: removed (no longer asked for).`));
  const final = [...kept];
  for (const w of wanted) {
    const at = final.findIndex((c) => c.id === w.id);
    if (at < 0) {
      final.push(w);
      notes.push(info('wizard.added', `${w.name}: added (${w.tierPattern ? labelOf(TIER_PATTERN_OPTIONS, w.tierPattern) : w.settings.blueprint}).`));
    } else {
      const cur = final[at]                    ;
      final[at] = { ...cur, ...(w.tierPattern ? { tierPattern: w.tierPattern } : {}), settings: { ...cur.settings, ...w.settings } };
    }
  }
  const next          = { ...ap, variants: { ...ap.variants, [platform]: final } };
  return { plan: withAppPlan(e.plan, next), notes };
}
