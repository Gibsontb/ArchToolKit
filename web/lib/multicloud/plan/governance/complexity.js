/**
 * Complexity and risk per app, and the prioritisation models the providers
 * publish (addendum A.10.17; research 1.3, 1.2, 2.3.2, 3.3 and 6(e) 11).
 *
 * Three views of the same question — "how hard is this app, and when should
 * it go?" — kept side by side, each with its source:
 *
 *  1. The toolkit's score (A.10.17): 0–100 from listed factors, banded Low /
 *     Medium / High; risk is the higher of that band and the criticality band.
 *     It feeds wave ordering, the CR risk field and the catalogue column.
 *  2. AWS's application complexity score sheet: 8 business plus 9 technical
 *     criteria, each 1–5, summed. The technical ones are derived from the plan
 *     where it can (and say so); the business ones are the user's answers.
 *  3. AWS's attribute-weighted 0–99 prioritisation model (the example model in
 *     the application portfolio assessment guide).
 *  4. The Azure CAF / Google Migration Center value × effort matrix: four
 *     quadrants that become waves 1–4.
 *
 * (This lives in governance/ because the CR risk needs it; the addendum puts
 * it at apps/complexity.ts under WP-19, which can re-export it from here.)
 */

import { supportStatus } from '../os.js';
             
                                                                                                                          
                     

export const COMPLEXITY_SOURCES = Object.freeze({
  toolkit: 'ArchToolKit addendum A.10.17 (factor weights are the toolkit\'s own, listed with every score)',
  awsSheet: 'https://docs.aws.amazon.com/prescriptive-guidance/latest/large-migration-portfolio-playbook/prioritization.html',
  awsPriority: 'https://docs.aws.amazon.com/prescriptive-guidance/latest/application-portfolio-assessment-guide/prioritization-and-migration-strategy.html',
  azureMatrix: 'https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/migrate/migration-wave-planning',
  googleMatrix: 'https://docs.cloud.google.com/migration-center/docs/plan-migration-waves',
});

// ---------------------------------------------------------------------------
// Shared: what belongs to an app
// ---------------------------------------------------------------------------

                           
                                
                        
                                          
                                          
 

export function appScope(plan                                                , name        )           {
  return {
    app: plan.apps.find((a) => a.name === name),
    name,
    workloads: plan.workloads.filter((w) => w.app === name),
    databases: plan.databases.filter((d) => d.app === name),
  };
}

/** Workload name → app name. */
function appOfWorkload(plan                         )                      {
  return new Map(plan.workloads.map((w) => [w.name, w.app]));
}

/** App-to-app edges out of an app (explicit edges, then "Depends on" as sync). */
export function appEdges(plan                                            , name        )                                                                         {
  const appOf = appOfWorkload(plan);
  const apps = new Set(plan.apps.map((a) => a.name));
  const resolve = (x        )                     => (x.startsWith('site:') ? undefined : appOf.get(x) ?? (apps.has(x) ? x : undefined));
  const seen = new Set        ();
  const out                                                                         = [];
  const consider = (from        , to        , kind                  ) => {
    const key = `${from}\u0000${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    const fa = resolve(from);
    const ta = resolve(to);
    if (fa === name && ta && ta !== name) out.push({ to: ta, kind, from, toItem: to });
  };
  for (const e of plan.edges) consider(e.from, e.to, e.kind);
  for (const w of plan.workloads) for (const d of w.dependsOn) consider(w.name, d, 'sync');
  return out;
}

const log2p1 = (x        )         => Math.log2(1 + Math.max(0, x));
const round1 = (x        )         => Math.round(x * 10) / 10;

/** Data held by an app, in TiB: server disks, plus databases with no host in the plan. */
export function appDataTib(scope          )         {
  const hosts = new Set(scope.workloads.map((w) => w.name));
  const disks = scope.workloads.reduce((s, w) => s + w.disksGib.reduce((a, b) => a + b, 0), 0);
  const dbs = scope.databases.filter((d) => !d.hosts.some((h) => hosts.has(h))).reduce((s, d) => s + d.sizeGib, 0);
  return (disks + dbs) / 1024;
}

// ---------------------------------------------------------------------------
// 1. The toolkit's score (A.10.17)
// ---------------------------------------------------------------------------

                                           
                                                                                                            
export const PATTERN_CLASS_POINTS                                         = Object.freeze({
  specialist: 15, sap: 10, 'oracle-apps': 8, 'vdi-exchange': 6, containers: 4, generic: 1,
});
export function patternClass(pattern                        )               {
  if (!pattern) return 'generic';
  if (['aix', 'ibm-i', 'solaris-sparc', 'solaris-x86', 'hp-ux', 'mainframe'].includes(pattern)) return 'specialist';
  if (pattern.startsWith('sap-')) return 'sap';
  if (['oracle-ebs', 'peoplesoft', 'jd-edwards', 'siebel'].includes(pattern)) return 'oracle-apps';
  if (['citrix-vad', 'rds', 'horizon', 'vdi', 'exchange'].includes(pattern)) return 'vdi-exchange';
  if (['kubernetes', 'openshift', 'docker-host', 'microservices'].includes(pattern)) return 'containers';
  return 'generic';
}

                                                         
export const DOWNTIME_POINTS                                          = Object.freeze({ none: 0, minutes: 2, hours: 5 });

                                   
                      
                         
                                                    
                                     
                          
 

                                
                       
               
                         
                                
                                           
                                                                    
                                
                                                             
                                                
                          
 

                                    
                                                                                       
                      
                                
                                   
                                                                                          
                                                       
                                             
                                                              
 

export function bandOf(score        )                 {
  return score < 30 ? 'Low' : score <= 60 ? 'Medium' : 'High';
}
export function criticalityBand(c                         )                 {
  return c === 'tier0' ? 'High' : c === 'tier1' ? 'Medium' : 'Low';
}
const BAND_RANK                                           = { Low: 0, Medium: 1, High: 2 };
export const higherBand = (a                , b                )                 => (BAND_RANK[a] >= BAND_RANK[b] ? a : b);

/**
 * The downtime class from the decision: a rebuild or a backup/restore is hours;
 * replication and managed database moves are minutes; HCX vMotion is none.
 */
export function downtimeFromDecision(scope          , decision                          )                {
  if (!decision) return 'none';
  const methods = [...scope.workloads, ...scope.databases].map((i) => decision.items[i.id]?.method).filter((m)                             => !!m);
  if (methods.includes('rebuild')) return 'hours';
  if (methods.includes('replicate') || methods.includes('managed-db')) return 'minutes';
  return 'none';
}

/** The A.10.17 score for one app. */
export function appComplexity(plan      , name        , options                   )                {
  const scope = appScope(plan, name);
  const decision = options.decision ?? plan.decision;
  const edges = appEdges(plan, name);
  const sync = edges.filter((e) => e.kind === 'sync');
  const external = (plan.dcExit?.external ?? []).filter((x) => x.app === name).length;
  const readinessBlockers = scope.workloads.reduce((s, w) => s + (w.facts?.readiness ?? []).filter((r) => r.severity === 'blocker').length, 0);
  const blockers = readinessBlockers + (options.blockers?.[name] ?? 0);
  const eol = scope.workloads.filter((w) => supportStatus(w.os, options.on) === 'end-of-life').length;
  const tib = appDataTib(scope);
  const downtime = options.downtime?.[name] ?? downtimeFromDecision(scope, decision);
  const pclass = patternClass(scope.app?.pattern);
  // Cross-platform: an edge whose two ends were decided onto different platforms.
  const platformOf = (item        )                       => {
    const w = plan.workloads.find((x) => x.name === item);
    return w ? decision?.items[w.id]?.chosen?.platform : undefined;
  };
  const crossPlatform = decision
    ? edges.filter((e) => {
      const a = platformOf(e.from);
      const b = platformOf(e.toItem) ?? (() => {
        const target = plan.workloads.find((w) => w.app === e.to);
        return target ? platformOf(target.name) : undefined;
      })();
      return !!a && !!b && a !== b;
    }).length
    : 0;

  const factors                     = [
    { id: 'servers', label: 'Servers: 8 × log2(1 + n)', quantity: scope.workloads.length, points: round1(8 * log2p1(scope.workloads.length)) },
    { id: 'databases', label: 'Databases: 3 each', quantity: scope.databases.length, points: 3 * scope.databases.length },
    { id: 'sync-edges', label: 'Synchronous app-to-app dependencies: 2 each', quantity: sync.length, points: 2 * sync.length },
    { id: 'external-links', label: 'External links: 2 each', quantity: external, points: 2 * external },
    { id: 'blockers', label: 'Open coupling / readiness blockers: 3 each', quantity: blockers, points: 3 * blockers },
    { id: 'eol', label: `Operating systems past end of support on ${options.on}: 2 each`, quantity: eol, points: 2 * eol },
    { id: 'data', label: 'Data: 4 × log2(1 + TiB)', quantity: round1(tib), points: round1(4 * log2p1(tib)) },
    { id: 'downtime', label: 'Cutover downtime class: minutes 2, hours 5', quantity: downtime, points: DOWNTIME_POINTS[downtime] },
    { id: 'pattern', label: 'Pattern class: specialist 15, SAP 10, Oracle apps 8, VDI / Exchange 6, containers 4, generic 1', quantity: pclass, points: PATTERN_CLASS_POINTS[pclass] },
    { id: 'cross-platform', label: 'Dependencies crossing platforms after the decision: 3 each', quantity: crossPlatform, points: 3 * crossPlatform },
  ];
  const score = Math.min(100, round1(factors.reduce((s, f) => s + f.points, 0)));
  const band = bandOf(score);
  const cband = criticalityBand(scope.app?.criticality);
  return { app: name, score, band, criticalityBand: cband, risk: higherBand(band, cband), factors, source: COMPLEXITY_SOURCES.toolkit };
}

/** Every app, lowest score first (the wave-ordering tie-break within a triage band). */
export function estateComplexity(plan      , options                   )                  {
  return plan.apps.map((a) => appComplexity(plan, a.name, options)).sort((a, b) => a.score - b.score || a.app.localeCompare(b.app));
}

/** ServiceNow change_request risk and impact values (verify the choice lists on the instance). */
export function crRiskOf(risk                )                                                    {
  return risk === 'High' ? { risk: '2', label: 'High' } : risk === 'Medium' ? { risk: '3', label: 'Moderate' } : { risk: '4', label: 'Low' };
}

// ---------------------------------------------------------------------------
// 2. AWS application complexity score sheet (8 business + 9 technical, 1–5)
// ---------------------------------------------------------------------------

                                                         
                                                                                                                
export const AWS_COMPLEXITY_CRITERIA                          = Object.freeze([
  { id: 'business-impact', group: 'business', label: 'Business impact' },
  { id: 'staff-availability', group: 'business', label: 'Staff availability' },
  { id: 'business-complexity', group: 'business', label: 'Business complexity' },
  { id: 'readiness', group: 'business', label: 'Readiness' },
  { id: 'security', group: 'business', label: 'Security' },
  { id: 'compliance', group: 'business', label: 'Compliance' },
  { id: 'application-knowledge', group: 'business', label: 'Application knowledge' },
  { id: 'migration-skills', group: 'business', label: 'Migration skills' },
  { id: 'storage', group: 'technical', label: 'Storage' },
  { id: 'users', group: 'technical', label: 'Number of users' },
  { id: 'server-count', group: 'technical', label: 'Server count' },
  { id: 'connectivity', group: 'technical', label: 'Connectivity' },
  { id: 'os-version', group: 'technical', label: 'Application OS and version' },
  { id: 'dependencies', group: 'technical', label: 'Application dependencies' },
  { id: 'data-migration', group: 'technical', label: 'Data migration' },
  { id: 'migration-strategy', group: 'technical', label: 'Migration strategy' },
  { id: 'cots-custom', group: 'technical', label: 'COTS or custom' },
]);
/** The answers key in `AppPlan.answers`: `aws-complexity.<criterion id>` = '1'..'5'. */
export const awsAnswerKey = (id        )         => `aws-complexity.${id}`;

                                                         
                          
                                                                                                       
                                                      
                        
 
                                     
                       
                                                  
                            
                             
                                                                                                 
                         
                          
                          
 

const step = (value        , limits                   )         => {
  let i = 0;
  while (i < limits.length && value > (limits[i]          )) i += 1;
  return i + 1;
};

const STRATEGY_EFFORT                                                       = {
  retire: 1, retain: 1, relocate: 1, rehost: 1, repurchase: 3, replatform: 3, revise: 4, refactor: 5, rearchitect: 5, rebuild: 5, reimagine: 5,
};

/**
 * The AWS sheet for one app. `answers` are the app plan's answers (1–5 per
 * criterion). Technical criteria with no answer are derived from the plan by
 * the thresholds shown in `why`; those thresholds are the toolkit's, as AWS
 * leaves the scale's meaning to the team.
 */
export function awsComplexityScore(plan      , name        , answers                                  , on        , strategy                    )                     {
  const scope = appScope(plan, name);
  const edges = appEdges(plan, name);
  const tib = appDataTib(scope);
  const external = (plan.dcExit?.external ?? []).filter((x) => x.app === name).length;
  const eolStates = scope.workloads.map((w) => supportStatus(w.os, on));
  const derive = (id        )                                             => {
    switch (id) {
      case 'storage': return { score: step(tib, [1, 5, 20, 50]), why: `${round1(tib)} TiB (1: ≤1, 2: ≤5, 3: ≤20, 4: ≤50, 5: more)` };
      case 'users': {
        const u = scope.app?.users;
        return u === undefined ? undefined : { score: step(u, [100, 1000, 10000, 100000]), why: `${u} users (1: ≤100 … 5: >100,000)` };
      }
      case 'server-count': return { score: step(scope.workloads.length, [3, 10, 25, 50]), why: `${scope.workloads.length} servers (1: ≤3, 2: ≤10, 3: ≤25, 4: ≤50, 5: more)` };
      case 'connectivity': return { score: step(external, [0, 2, 5, 10]), why: `${external} external links (1: none … 5: >10)` };
      case 'os-version': {
        const worst = eolStates.includes('end-of-life') ? 5 : eolStates.includes('extended') ? 3 : 1;
        return { score: worst, why: 'end of life 5, extended support only 3, supported 1' };
      }
      case 'dependencies': return { score: step(edges.length, [0, 3, 10, 20]), why: `${edges.length} app-to-app dependencies (1: none … 5: >20)` };
      case 'data-migration': {
        const dbTib = scope.databases.reduce((s, d) => s + d.sizeGib, 0) / 1024;
        return { score: scope.databases.length === 0 ? 1 : Math.min(5, 1 + step(dbTib, [0.5, 2, 10])), why: `${scope.databases.length} database(s), ${round1(dbTib)} TiB` };
      }
      case 'migration-strategy': {
        const s = strategy ?? (scope.app?.route                                 );
        const v = s ? STRATEGY_EFFORT[s] : undefined;
        return v === undefined ? undefined : { score: v, why: `${s} (rehost / relocate 1, replatform 3, refactor 5)` };
      }
      case 'cots-custom': {
        const k = scope.app?.kind;
        if (!k || k === 'unknown') return undefined;
        return { score: k === 'home-grown' ? 2 : k === 'infrastructure' ? 1 : 3, why: `${k} (vendor support and certification make COTS 3; custom 2; infrastructure 1)` };
      }
      default: return undefined;
    }
  };
  const criteria                      = AWS_COMPLEXITY_CRITERIA.map((c) => {
    const raw = answers[awsAnswerKey(c.id)];
    const n = raw === undefined ? NaN : Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 5) return { ...c, score: n, basis: 'answer' };
    const d = c.group === 'technical' ? derive(c.id) : undefined;
    return d ? { ...c, score: d.score, basis: 'derived', why: d.why } : { ...c, basis: 'unanswered' };
  });
  const sum = (g                   ) => criteria.filter((c) => c.group === g).reduce((s, c) => s + (c.score ?? 0), 0);
  const business = sum('business');
  const technical = sum('technical');
  return { app: name, criteria, business, technical, total: business + technical, scored: criteria.filter((c) => c.score !== undefined).length, source: COMPLEXITY_SOURCES.awsSheet };
}

// ---------------------------------------------------------------------------
// 3. AWS attribute-weighted prioritisation (0–99 per attribute, with factors)
// ---------------------------------------------------------------------------

                                                                                                                                                                                         
                                                                                                                                                                                                                                                                   

/** The example model's values → scores, exactly as the guide lists them. */
export const AWS_PRIORITY_MODEL = Object.freeze({
  environment: { factor: 1, values: { test: 80, dev: 50, prod: 20 } },
  criticality: { factor: 1, values: { low: 60, medium: 40, high: 20 } },
  regulatory: { factor: 1, values: { none: 60, fedramp: 10 } },
  osSupport: { factor: 0.8, values: { 'cloud-ready': 60, unsupported: 10 } },
  instances: { factor: 0.8, values: { '1-3': 60, '4-10': 40, '11+': 20 } },
  dependencies: { factor: 1, values: { '0-3': 70, '4-10': 30, '11+': 10 } },
  strategy: { factor: 0.6, values: { rehost: 70, replatform: 30, refactor: 10 } },
  opsMaturity: { factor: 1, values: { high: 80, medium: 50, low: 10 } },
});

export function awsPriorityScore(plan      , name        , on        , platform           )                {
  const scope = appScope(plan, name);
  const m = AWS_PRIORITY_MODEL;
  const envs = new Set(scope.workloads.map((w) => w.env));
  const env = envs.has('prod') || envs.size === 0 ? 'prod' : envs.has('test') || envs.has('preprod') ? 'test' : 'dev';
  const crit = scope.app?.criticality ?? 'tier2';
  const critV = crit === 'tier0' || crit === 'tier1' ? 'high' : crit === 'tier2' ? 'medium' : 'low';
  const fw = scope.app?.frameworks ?? plan.requirements.frameworks;
  const regulated = fw.length > 0;
  const eol = scope.workloads.some((w) => supportStatus(w.os, on) === 'end-of-life');
  const n = scope.workloads.length;
  const deps = appEdges(plan, name).length;
  const route = scope.app?.route ?? 'rehost';
  const stratV = route === 'refactor' ? 'refactor' : route === 'replatform' || route === 'repurchase' ? 'replatform' : 'rehost';
  const skill                    = platform ? plan.requirements.skills[platform] : undefined;
  const opsV = skill === 'strong' ? 'high' : skill === 'some' ? 'medium' : 'low';
  const attributes                      = [
    { id: 'environment', label: 'Environment', factor: m.environment.factor, value: env, score: m.environment.values[env] },
    { id: 'criticality', label: 'Business criticality', factor: m.criticality.factor, value: critV, score: m.criticality.values[critV], assumption: 'tier0 / tier1 = High, tier2 = Medium, tier3 = Low' },
    { id: 'regulatory', label: 'Regulatory framework', factor: m.regulatory.factor, value: regulated ? fw.join(' ') : 'none', score: regulated ? m.regulatory.values.fedramp : m.regulatory.values.none, ...(regulated ? { assumption: 'any framework scored like FedRAMP (10); the guide lists only None and FedRAMP' } : {}) },
    { id: 'os-support', label: 'OS support', factor: m.osSupport.factor, value: eol ? 'unsupported' : 'cloud-ready', score: eol ? m.osSupport.values.unsupported : m.osSupport.values['cloud-ready'] },
    { id: 'instances', label: 'Compute instances', factor: m.instances.factor, value: String(n), score: n <= 3 ? m.instances.values['1-3'] : n <= 10 ? m.instances.values['4-10'] : m.instances.values['11+'] },
    { id: 'dependencies', label: 'Dependencies', factor: m.dependencies.factor, value: String(deps), score: deps <= 3 ? m.dependencies.values['0-3'] : deps <= 10 ? m.dependencies.values['4-10'] : m.dependencies.values['11+'] },
    { id: 'strategy', label: 'Migration strategy', factor: m.strategy.factor, value: stratV, score: m.strategy.values[stratV] },
    { id: 'ops-maturity', label: 'Operations cloud maturity', factor: m.opsMaturity.factor, value: opsV, score: m.opsMaturity.values[opsV], assumption: 'from the plan\'s skills for the target: strong = High, some = Medium, none = Low' },
  ];
  const weighted = round1(attributes.reduce((s, a) => s + a.score * a.factor, 0));
  const factors = attributes.reduce((s, a) => s + a.factor, 0);
  return { app: name, attributes, weighted, normalised: round1(weighted / factors), source: COMPLEXITY_SOURCES.awsPriority };
}

// ---------------------------------------------------------------------------
// 4. Value × effort (Azure CAF; Google Migration Center's four waves)
// ---------------------------------------------------------------------------

                                   
                                                                    
                                                                                                                                                                                             
export const VALUE_EFFORT_MATRIX                          = Object.freeze([
  { quadrant: 'quick-win', label: 'Quick wins', priority: 'High', wave: 1, value: 'high', effort: 'low' },
  { quadrant: 'strategic', label: 'Strategic investments', priority: 'Medium-High', wave: 2, value: 'high', effort: 'high' },
  { quadrant: 'easy', label: 'Easy candidates', priority: 'Medium-Low', wave: 3, value: 'low', effort: 'low' },
  { quadrant: 'defer', label: 'Avoid or defer', priority: 'Low', wave: 4, value: 'low', effort: 'high' },
]);
export function quadrantOf(value       , effort       )               {
  return VALUE_EFFORT_MATRIX.find((q) => q.value === value && q.effort === effort) ;
}

/** The answers key for business value: `value` = 'high' | 'low'. */
export const VALUE_ANSWER_KEY = 'value';

                                                   
                       
                                            
                               
                                      
 

/**
 * Place each app. Value is the user's answer (`AppPlan.answers.value`); with
 * none it is assumed from criticality (tier0 / tier1 high) and says so —
 * AWS warns that high priority is not the same as business-critical. Effort is
 * the A.10.17 band: Low is low effort, Medium and High are high.
 */
export function valueEffortMatrix(plan      , options                   )                {
  const answersOf = new Map((plan.appPlans ?? []).map((p) => {
    const app = plan.apps.find((a) => a.id === p.app);
    return [app?.name ?? p.app, p.answers]         ;
  }));
  return estateComplexity(plan, options).map((c)              => {
    const answer = answersOf.get(c.app)?.[VALUE_ANSWER_KEY];
    const app = plan.apps.find((a) => a.name === c.app);
    const value        = answer === 'high' || answer === 'low' ? answer : app?.criticality === 'tier0' || app?.criticality === 'tier1' ? 'high' : 'low';
    const effort        = c.band === 'Low' ? 'low' : 'high';
    return {
      ...quadrantOf(value, effort), app: c.app,
      valueBasis: answer === 'high' || answer === 'low' ? 'answer' : 'assumed',
      effortBasis: `complexity ${c.score} (${c.band})`,
      sources: [COMPLEXITY_SOURCES.azureMatrix, COMPLEXITY_SOURCES.googleMatrix],
    };
  }).sort((a, b) => a.wave - b.wave || a.app.localeCompare(b.app));
}
