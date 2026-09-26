/**
 * What the imported estate can answer in the decision wizard.
 *
 * The wizard asks forty-odd questions. An estate answers some of them outright
 * — it is a migration, from on-premises VMware, of VM-centric workloads, of
 * this much data, across these environments — and informs others with facts
 * the wizard never asks for: how many VMs cannot be moved by replication at
 * all, how much of the storage is raw LUNs, how many run an operating system
 * the clouds no longer support. Those facts go into the free-text description,
 * where the recommendation carries them into its output.
 *
 * What it cannot answer it leaves alone: criticality, uptime targets, data
 * sensitivity, deadlines. `profileFromInventory` says the same thing for the
 * decision matrix; this reuses its counts.
 */

import { info,              } from '../core/findings.js';
import { computeTotals, isWorkload,                } from '../vmware/inventory.js';
import { assessMoves } from '../vmware/vm-readiness.js';
import { profileFromInventory } from './from-inventory.js';
import { appDatabases, appPlanOf, appWorkloads, findApp } from './plan/apps/components.js';
import { osKind } from './plan/os.js';
                                                                                                                  

                              
                       
                             
                           
                         
                        
                          
                           
                          
                                
                                 
                                 
                                
                                           
 

                                
                                                              
                                                                         
                              
                                        
 

const ENVIRONMENTS                              = [
  ['prod', /(^|[^a-z])(prd|prod|production)([^a-z]|$)/i],
  ['dev', /(^|[^a-z])(dev|development|tdv)([^a-z]|$)/i],
  ['test', /(^|[^a-z])(tst|test|qa|uat|tdv)([^a-z]|$)/i],
  ['stage', /(^|[^a-z])(stg|stage|staging|preprod|pre-prod)([^a-z]|$)/i],
  ['dr', /(^|[^a-z])(dr|drt|recovery)([^a-z]|$)/i],
];

/** The wizard's data-volume band of a size in GiB. */
export function band(gib        )         {
  if (gib < 100) return 'xs';
  if (gib < 1024) return 's';
  if (gib < 5 * 1024) return 'm';
  if (gib < 20 * 1024) return 'l';
  return 'xl';
}

/** The part of the estate in scope: one cluster, or all of it. */
export function scopeInventory(inventory           , cluster         )            {
  if (!cluster) return inventory;
  return {
    ...inventory,
    vms: inventory.vms.filter((v) => v.cluster === cluster),
    hosts: inventory.hosts.filter((h) => h.cluster === cluster),
    clusters: inventory.clusters.filter((c) => c.name === cluster),
  };
}

export function answersFromEstate(inventory           , cluster         )                {
  const scoped = scopeInventory(inventory, cluster);
  const totals = computeTotals(scoped);
  const moves = assessMoves(scoped, 'cloud');
  const profile = profileFromInventory(
    { ...scoped, vms: scoped.vms.filter(isWorkload) },
    { disposition: 'rehost', ...(cluster ? { clusters: [cluster] } : {}) },
  );
  const count = (id        ) => moves.byCheck.find((c) => c.check.id === id)?.count ?? 0;

  const names = [
    ...new Set([
      ...scoped.vms.filter(isWorkload).map((v) => `${v.cluster ?? ''} ${v.datacenter ?? ''} ${v.folder ?? ''}`),
      ...scoped.hosts.map((h) => `${h.cluster ?? ''} ${h.datacenter ?? ''}`),
    ]),
  ].join(' | ');
  const environments = ENVIRONMENTS.filter(([, re]) => re.test(names)).map(([env]) => env);

  const facts              = {
    vms: totals.vmCount,
    poweredOn: totals.poweredOnVmCount,
    windows: profile.evidence.windows,
    linux: profile.evidence.linux,
    vcpu: totals.allocatedVcpu,
    ramGib: totals.allocatedMemoryGib,
    usedGib: totals.usedStorageGib,
    rdmGib: totals.rdmGib,
    cloudBlocked: moves.blocked,
    cloudCautions: moves.withCautions,
    unsupportedOs: count('unsupported-os'),
    srmProtected: count('srm-protected'),
    environments,
  };

  const tib = (g        ) => `${(g / 1024).toFixed(1)} TiB`;
  const lines = [
    `Imported estate${cluster ? `, cluster ${cluster}` : ''}: ${facts.vms} VMs (${facts.poweredOn} running; ${facts.windows} Windows, ${facts.linux} Linux).`,
    `Running allocation ${Math.round(facts.vcpu)} vCPU and ${Math.round(facts.ramGib)} GiB memory; ${tib(facts.usedGib)} consumed VMDK storage${facts.rdmGib > 0 ? ` plus ${tib(facts.rdmGib)} on raw device mappings` : ''}.`,
    `Moving to a cloud by replication: ${facts.cloudBlocked} VM(s) blocked (RDMs, shared disks, passthrough), ${facts.cloudCautions} need changes first; ${facts.unsupportedOs} run an OS past vendor support.`,
    ...(facts.srmProtected > 0 ? [`${facts.srmProtected} VM(s) are protected by SRM today, so DR has to be replanned on the target.`] : []),
  ];

  const answers                                             = {
    initiativeType: 'migration',
    workloadName: cluster ?? inventory.source.label ?? 'Imported estate',
    architectureType: 'legacy-vm',
    teamSkills: 'vms',
    sourceEnv: 'onprem-vmware',
    // A large share of VMs that replication cannot carry points at running the
    // estate as VMware on the cloud instead.
    migrationApproach: facts.vms > 0 && (facts.cloudBlocked / facts.vms > 0.05 || facts.rdmGib > facts.usedGib * 0.1) ? 'relocate' : 'rehost',
    dataVolumeBand: band(facts.usedGib + facts.rdmGib),
    description: lines.join(' '),
    ...(environments.length > 0 ? { envScope: environments } : {}),
    ...(facts.srmProtected > 0 || environments.includes('dr') ? { regionCount: '2' } : {}),
  };

  const findings            = [
    ...profile.findings,
    info(
      'multicloud.estate.answered',
      `Answered ${Object.keys(answers).length} questions from the estate. Criticality, uptime, data sensitivity and deadlines are for you.`,
      { source: 'ArchToolKit' },
    ),
  ];
  return { answers, facts, findings };
}

// ---------------------------------------------------------------------------
// One application of the plan
// ---------------------------------------------------------------------------

/** The wizard's answers for one application, and the plan facts they came from. */
                             
                                                                                                
                                                                         
                                                   
                                                 
 

const ARCHITECTURE_OF_PATTERN                                            = {
  'web-app': 'web-api', api: 'web-api', 'static-site': 'web-api', 'iis-dotnet': 'web-api', tomcat: 'web-api', jboss: 'web-api', websphere: 'web-api', weblogic: 'web-api',
  microservices: 'microservices', kubernetes: 'microservices', openshift: 'microservices', 'docker-host': 'microservices',
  'batch-pipeline': 'batch', 'event-driven': 'event-driven', messaging: 'event-driven', kafka: 'event-driven', rabbitmq: 'event-driven', 'ibm-mq': 'event-driven',
  'sap-bw': 'data-analytics',
};
const SKILL_OF_PATTERN                                            = {
  microservices: 'containers', kubernetes: 'containers', openshift: 'containers', 'docker-host': 'containers', 'event-driven': 'serverless', 'static-site': 'serverless',
  'web-app': 'paas', api: 'paas',
};
const WIZARD_ENV                                = { prod: 'prod', preprod: 'stage', test: 'test', dev: 'dev', dr: 'dr' };
const RTO_ANSWER                                = { '15m': 'mins', '1h': 'hour', '4h': 'few-hours', '24h': 'day-plus', '72h': 'day-plus' };
const RPO_ANSWER                                = { '0': 'zero', '15m': '15min', '1h': 'hour', '4h': 'day', '24h': 'day' };
const RTO_RANK                 = ['15m', '1h', '4h', '24h', '72h'];
const RPO_RANK                 = ['0', '15m', '1h', '4h', '24h'];
const CRITICALITY_ANSWER                                        = { tier0: 'tier0', tier1: 'tier1', tier2: 'tier2', tier3: 'tier2' };
const NOSQL                        = new Set          (['mongodb', 'cassandra', 'redis', 'elasticsearch']);
const REGULATED                         = new Set           (['pci-dss-4', 'hipaa', 'gdpr', 'uk-gdpr', 'soc2', 'dora', 'nis2', 'cjis', 'irap-protected', 'bsi-c5', 'ens-high']);
const ON_PREM_SOURCES                              = new Set                (['vsphere', 'hyperv', 'ahv', 'kvm', 'proxmox', 'ovirt', 'xen', 'physical', 'power', 'sparc', 'itanium', 'pa-risc', 'mainframe', 'other']);
const CLOUD_SOURCES                              = new Set                (['aws', 'azure', 'google', 'oci']);

/** The strictest of a list, by rank (first in `rank` is strictest). */
function strictest                  (values                            , rank              )                {
  let best               ;
  for (const v of values) if (v && (best === undefined || rank.indexOf(v) < rank.indexOf(best))) best = v;
  return best;
}

/**
 * What the plan answers for one application: the estate mapping above (a
 * migration of VM-centric workloads, this much data, these environments),
 * read from the app's own servers, databases, dependencies, non-functionals,
 * load profile and the plan's requirements. What it cannot know it leaves out.
 */
export function answersFromApp(plan      , appRef        )             {
  const app                  = findApp(plan, appRef);
  if (!app) return { answers: {}, why: {} };
  const ap = appPlanOf(plan, app.id);
  const origin = ap?.origin ?? (app.route === 'new' ? 'new' : 'migrate');
  const ws = appWorkloads(plan, app).filter((w) => !w.synthetic);
  const dbs = appDatabases(plan, app);
  const req = plan.requirements;
  const a                                             = {};
  const why                         = {};
  const set = (id        , value                                        , from        )       => {
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) return;
    a[id] = value;
    why[id] = from;
  };
  const pattern = app.pattern ?? 'generic';

  // Initiative and basics.
  set('initiativeType', origin === 'new' ? 'new-service' : 'migration', origin === 'new' ? 'a new application' : 'a migrating application');
  set('workloadName', app.name, "the application's name");
  set('appPattern', pattern, "the application's pattern");
  // A migrating web app is VM-centric until its route says otherwise; the modern patterns keep their architecture.
  const modern = ARCHITECTURE_OF_PATTERN[pattern];
  set('architectureType', origin === 'migrate' ? (modern && modern !== 'web-api' ? modern : 'legacy-vm') : modern ?? 'web-api', "the application's pattern");
  set('teamSkills', SKILL_OF_PATTERN[pattern] ?? (origin === 'migrate' ? 'vms' : undefined), "the application's pattern");
  set('latencySensitivity', app.latencyToOnPrem === 'critical' ? 'strict' : app.latencyToOnPrem === 'sensitive' ? 'moderate' : 'relaxed', 'latency to on-premises');
  const rps = ap?.load?.peakRps;
  if (rps !== undefined) set('trafficPattern', rps >= 2000 ? 'high' : rps >= 200 ? 'medium' : 'low', "the load profile's peak requests");

  // Facts the wizard does not ask, carried in the description.
  const windows = ws.filter((w) => osKind(w.os) === 'windows').length;
  const linux = ws.filter((w) => osKind(w.os) === 'linux').length;
  const sources = [...new Set(ws.map((w) => w.origin ?? 'vsphere'))];
  const blockers = ws.reduce((n, w) => n + (w.facts?.readiness ?? []).filter((r) => r.severity === 'blocker').length, 0);
  const diskGib = ws.reduce((n, w) => n + w.disksGib.reduce((x, y) => x + y, 0), 0);
  const dbGib = dbs.reduce((n, d) => n + d.sizeGib, 0);
  if (origin === 'migrate' && (ws.length > 0 || dbs.length > 0)) {
    set('description', [
      `${app.name}: ${ws.length} server(s) (${windows} Windows, ${linux} Linux) on ${sources.join(', ') || 'vsphere'}; ${ws.reduce((n, w) => n + w.vcpu, 0)} vCPU, ${ws.reduce((n, w) => n + w.ramGib, 0)} GiB memory, ${diskGib} GiB of disks.`,
      dbs.length > 0 ? `${dbs.length} database(s): ${dbs.map((d) => `${d.name} (${d.engine} ${d.version}, ${d.sizeGib} GiB)`).join(', ')}.` : '',
      blockers > 0 ? `${blockers} readiness blocker(s) for replication.` : '',
      app.notes ?? '',
    ].filter(Boolean).join(' '), 'the servers and databases');
  } else if (app.notes) {
    set('description', app.notes, "the application's notes");
  }

  // Data and integration.
  const relational = dbs.some((d) => !NOSQL.has(d.engine));
  const nosql = dbs.some((d) => NOSQL.has(d.engine));
  const files = ws.some((w) => w.role === 'file') || pattern === 'file-server' || pattern === 'nas' || pattern === 'file-share';
  set('dataType', relational || pattern === 'database' ? 'relational' : nosql ? 'nosql' : pattern === 'kafka' || pattern === 'event-driven' ? 'streaming' : files ? 'files' : undefined,
    dbs.length > 0 ? "the application's databases" : "the application's pattern");
  const frameworks = [...new Set([...(app.frameworks ?? []), ...req.frameworks])];
  const sensitivity = frameworks.includes('dod-il5') || frameworks.includes('fedramp-high') ? 'ps-l5'
    : frameworks.includes('dod-il4') ? 'ps-l4'
      : frameworks.includes('dod-il2') || frameworks.includes('fedramp-moderate') ? 'ps-l2'
        : frameworks.some((f) => REGULATED.has(f)) ? 'regulated' : undefined;
  set('dataSensitivity', sensitivity, 'the compliance frameworks');
  if (frameworks.length > 0) set('complianceNotes', frameworks.join(', ').toUpperCase(), 'the compliance frameworks');
  const names = new Set([app.name, ...ws.map((w) => w.name), ...dbs.map((d) => d.name)]);
  const edges = plan.edges.filter((e) => names.has(e.from) || names.has(e.to));
  const integrations = pattern === 'kafka' || pattern === 'event-driven' ? 'event-streaming'
    : pattern === 'ibm-mq' || pattern === 'rabbitmq' || pattern === 'messaging' ? 'enterprise-messaging'
      : edges.some((e) => e.kind === 'async') ? 'enterprise-messaging' : edges.length > 0 ? 'simple-http' : undefined;
  set('integrations', integrations, 'the dependencies');

  // Source.
  if (origin === 'migrate') {
    const onPrem = sources.filter((s) => ON_PREM_SOURCES.has(s));
    const inCloud = sources.filter((s) => CLOUD_SOURCES.has(s));
    const sourceEnv = onPrem.length > 0 && inCloud.length > 0 ? 'hybrid'
      : inCloud.length > 0 ? 'existing-cloud'
        : onPrem.length > 0 && onPrem.every((s) => s === 'vsphere') ? 'onprem-vmware'
          : onPrem.length > 0 ? 'onprem-baremetal' : undefined;
    set('sourceEnv', sourceEnv, 'where the servers run today');
    const counts = new Map                ();
    for (const w of ws) if (w.disposition && w.disposition !== 'new') counts.set(w.disposition, (counts.get(w.disposition) ?? 0) + 1);
    const majority = [...counts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
    const route = ap?.route ?? (app.route && app.route !== 'new' ? app.route : undefined) ?? majority;
    set('migrationApproach', route, ap?.route || app.route ? "the application's 6R route" : "the servers' dispositions");
    set('migrationScope', ws.length === 0 && dbs.length > 0 ? 'db-only' : 'single-app', 'one application');
    if (dbs.length > 0) set('dbStrategy', route === 'rehost' || route === 'relocate' ? 'vm' : route === 'replatform' || route === 'refactor' ? 'managed' : 'engine', route ? 'the route' : 'the default');
  } else {
    set('newServiceStage', 'new-prod', 'a new application');
  }

  // Non-functionals.
  set('criticality', CRITICALITY_ANSWER[app.criticality], "the application's criticality");
  const rto = app.rto ?? strictest(ws.map((w) => w.rto), RTO_RANK);
  const rpo = app.rpo ?? strictest(ws.map((w) => w.rpo), RPO_RANK);
  if (rto) set('rto', RTO_ANSWER[rto], app.rto ? "the application's RTO" : "the servers' RTO");
  if (rpo) set('rpo', RPO_ANSWER[rpo], app.rpo ? "the application's RPO" : "the servers' RPO");
  const slo = ap?.load?.slo;
  if (slo) set('uptimeTarget', slo === '99.99' ? '99.95' : slo, "the load profile's SLO");
  set('securityBaseline', req.securityBaseline === 'stig' ? 'stig' : sensitivity && sensitivity !== 'ps-l2' ? 'regulated' : 'standard', "the plan's security baseline");
  set('identityModel', req.identity.cloudSignIn === 'existing-idp-saml' ? 'external-idp-plus-iam' : req.identity.adStrategy !== 'none' ? 'hybrid-ad-entra' : 'cloud-iam-only', "the plan's identity strategy");
  set('secretsModel', req.keys === 'hsm' ? 'hsm-backed' : 'secrets-manager', "the plan's key management");
  if (sensitivity) set('dataProtection', 'in-transit-and-at-rest', 'the compliance frameworks');
  const f5 = pattern === 'appliance-f5' || ws.some((w) => w.workloadType === 'appliance-f5' || w.facts?.detection?.type === 'appliance-f5');
  if (f5) {
    set('perimeterPattern', 'cloud-plus-f5', 'an F5 appliance in the application');
    set('f5Usage', ['waap-web'], 'an F5 appliance in the application');
  } else if (ap?.ingress?.waf) {
    set('perimeterPattern', 'cloud-fw-only', 'the ingress (WAF)');
  }
  if (req.siem !== 'none') set('secOpsMaturity', 'central-siem', "the plan's SIEM");
  set('iaCTools', 'terraform', 'the toolkit generates Terraform and Ansible');

  // Sizing and environments.
  const users = app.concurrentUsers ?? ap?.load?.concurrentUsers;
  if (users) set('peakUsers', String(users), 'peak concurrent users');
  if (rps) set('peakRps', String(rps), 'the load profile');
  const dataGib = dbGib + (origin === 'migrate' ? diskGib : 0) + (ap?.load?.dataGib ?? 0);
  if (dataGib > 0) set('dataVolumeBand', band(dataGib), origin === 'migrate' ? 'the disks and databases' : "the load profile's data");
  const envs                 = origin === 'new' ? (ap?.load?.environments ?? ['prod']) : [...new Set(ws.map((w) => w.env))];
  set('envScope', [...new Set(envs.map((e) => WIZARD_ENV[e]))], origin === 'new' ? "the load profile's environments" : "the servers' environments");
  const pct = ap?.load?.nonprodPct;
  if (pct) set('nonProdScale', pct >= 100 ? 'full' : pct >= 50 ? 'half' : pct >= 25 ? 'quarter' : 'minimal', 'the load profile');
  const hasDr = envs.includes('dr') || Object.values(req.regions).some((r) => !!r?.dr);
  set('regionCount', hasDr ? '2' : app.criticality === 'tier0' || app.criticality === 'tier1' ? '1-ha' : '1', hasDr ? 'a DR region or DR servers' : 'the criticality');

  // Connectivity.
  const sites = req.sites.length > 0 || ws.some((w) => w.dependsOn.some((d) => d.startsWith('site:')));
  set('onPremLink', !sites && origin === 'new' ? 'none' : req.connection === 'circuit-with-vpn-backup' ? 'circuit-vpn' : req.connection === 'circuit' ? 'circuit' : 'vpn',
    sites ? "the plan's connection to its sites" : 'no site in the plan');
  set('crossCloud', 'interconnect', "the default: the clouds' own interconnect where one exists");
  const bw = req.sites[0]?.bandwidth;
  set('linkBandwidth', bw === '100g' ? '100g' : bw === '10g' ? '10g' : bw === '5g' ? '5g' : bw === '2g' ? '2g' : '1g', bw ? "the first site's bandwidth" : 'the smallest interconnect size');
  return { answers: a, why };
}
