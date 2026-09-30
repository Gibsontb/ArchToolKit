/**
 * Application Migration, Stage 1: what is known about one application.
 *
 * One record per application, built card by card. Every answer is the user's:
 * nothing here fills in a value they did not give (a new application starts
 * empty), and the checks only report what is missing or clashes. The cards
 * are built one at a time; CARDS lists them all so the page can show where
 * the application stands.
 *
 * The option lists come from the two original intake tools — the Multi-Cloud
 * Decision & Onboarding Wizard and the Application Migration evaluator — with
 * a few additions, kept as closed sets with "Other" where the original had a
 * free-text box with suggestions.
 */

                         
                         
                         
 

const opts = (...labels          )           => labels.map((label) => ({ value: label, label }));

/** The evaluator's vendor list. */
export const VENDORS                    = opts(
  'Custom Built',
  'Open Source',
  'Microsoft',
  'Oracle',
  'IBM',
  'SAP',
  'VMware by Broadcom',
  'Red Hat',
  'Cisco',
  'Salesforce',
  'ServiceNow',
  'Workday',
  'Atlassian',
  'Infor',
  'Epic',
  'Cerner (Oracle Health)',
  'Tyler Technologies',
  'OpenText',
  'Micro Focus',
  'Other',
);

/** The wizard's "Source environment (today)". */
export const SOURCE_ENVIRONMENTS                    = [
  { value: 'onprem-vmware', label: 'On-prem VMware estate' },
  { value: 'onprem-baremetal', label: 'On-prem bare metal / mixed hypervisors' },
  { value: 'colo', label: 'Hosted / co-lo data center' },
  { value: 'existing-cloud', label: 'Existing cloud (re-platform / multi-cloud)' },
  { value: 'saas', label: 'Primarily SaaS integrations' },
  { value: 'hybrid', label: 'Hybrid mix of on-prem + cloud' },
];

/** The evaluator's "Current hosting platform", with the other hypervisors a source estate has. */
export const HOSTING_PLATFORMS                    = opts(
  'VMware vSphere',
  'Microsoft Hyper-V',
  'Nutanix AHV',
  'KVM',
  'Xen / Citrix Hypervisor',
  'Proxmox VE',
  'Bare metal',
  'Mainframe',
  'On-prem Kubernetes',
  'On-prem PaaS',
  'Already in a cloud',
  'Other',
);

/** Stage 1's cards, in order. Only the ones in BUILT can be opened yet. */
export const CARDS = [
  { id: 'identity', title: 'Identity' },
  { id: 'continuity', title: 'Criticality and continuity' },
  { id: 'what', title: 'What it is' },
  { id: 'servers', title: 'Servers' },
  { id: 'data', title: 'Data' },
  { id: 'connections', title: 'Connections and identity' },
  { id: 'security', title: 'Security and compliance' },
  { id: 'network', title: 'Network and perimeter' },
  { id: 'load', title: 'Users and load' },
  { id: 'gates', title: 'Hard gates' },
  { id: 'ratings', title: 'Readiness ratings' },
  { id: 'operations', title: 'Running it today' },
]         ;
                                                  
export const BUILT                      = new Set        (CARDS.map((c) => c.id));

/**
 * Stage 1 in five screens: three sections a screen, then the assessment.
 * A screen can be opened once every section on it is built.
 */
export const SCREENS = [
  { id: 'application', title: 'The application', cards: ['identity', 'continuity', 'load'] },
  { id: 'build', title: 'How it is built', cards: ['what', 'servers', 'data'] },
  { id: 'links', title: 'Connections, security and network', cards: ['connections', 'security', 'network'] },
  { id: 'today', title: 'Constraints and running it today', cards: ['gates', 'ratings', 'operations'] },
  { id: 'assessment', title: 'Assessment and route', cards: [] },
]                                                                                      ;
                                                      

export function screenBuilt(screen                          )          {
  return screen.cards.every((c) => BUILT.has(c));
}

/** Card 1. Every field starts empty. */
                           
               
                      
                       
                        
                         
                 
                      
                            
                          
                       
                
 

                            
                      
                           
                  
                     
                         
             
                                                                                    
                                                    
                                                        
                
 

export function emptyIdentity()           {
  return {
    name: '',
    description: '',
    businessUnit: '',
    businessOwner: '',
    technicalOwner: '',
    vendor: '',
    vendorOther: '',
    sourceEnvironment: '',
    hostingPlatform: '',
    hostingOther: '',
    notes: '',
  };
}

export function newApp(id        , now        )            {
  return { id, created: now, updated: now, identity: emptyIdentity(), continuity: emptyContinuity(), load: emptyLoad(), sections: {}, route: '' };
}

/** A record saved before a card existed gets that card, empty. */
export function normalizeApp(app           )            {
  app.identity = { ...emptyIdentity(), ...app.identity };
  app.continuity = { ...emptyContinuity(), ...(app.continuity ?? {}) };
  app.load = { ...emptyLoad(), ...(app.load ?? {}) };
  app.sections = app.sections ?? {};
  app.route = app.route ?? '';
  return app;
}

/** What the user sees as the application's name: its own, or a placeholder until it has one. */
export function displayName(app           )         {
  return app.identity.name.trim() || 'Untitled application';
}

/** The vendor as written, with "Other" replaced by what the user typed. */
export function vendorLabel(identity          )         {
  return identity.vendor === 'Other' ? identity.vendorOther.trim() || 'Other' : identity.vendor;
}

export function hostingLabel(identity          )         {
  return identity.hostingPlatform === 'Other' ? identity.hostingOther.trim() || 'Other' : identity.hostingPlatform;
}

export function sourceLabel(identity          )         {
  return SOURCE_ENVIRONMENTS.find((o) => o.value === identity.sourceEnvironment)?.label ?? '';
}

                          
                                 
                           
 

/** What card 1 still needs, and names that clash with another application in the list. */
export function identityProblems(app           , others                      )            {
  const i = app.identity;
  const problems            = [];
  const name = i.name.trim();
  if (!name) problems.push({ field: 'name', message: 'Give the application a name.' });
  else if (others.some((o) => o.id !== app.id && o.identity.name.trim().toLowerCase() === name.toLowerCase()))
    problems.push({ field: 'name', message: `Another application is already called "${name}".` });
  if (i.vendor === 'Other' && !i.vendorOther.trim()) problems.push({ field: 'vendorOther', message: 'Name the vendor.' });
  if (i.hostingPlatform === 'Other' && !i.hostingOther.trim()) problems.push({ field: 'hostingOther', message: 'Name the hosting platform.' });
  return problems;
}

/** How much of card 1 has an answer: the name, then the eight questions after it. */
export function identityProgress(identity          )                                   {
  const asked                     = ['name', 'description', 'businessUnit', 'businessOwner', 'technicalOwner', 'vendor', 'sourceEnvironment', 'hostingPlatform'];
  return { answered: asked.filter((k) => identity[k].trim() !== '').length, of: asked.length };
}

/**
 * What the answers so far already say about the move. Facts, not a decision:
 * the user chooses the route at the end of Stage 1.
 */
export function identitySignals(identity          )           {
  const out           = [];
  if (identity.hostingPlatform === 'Mainframe')
    out.push('Runs on a mainframe: moving it usually means Retain or a Refactor, not a lift and shift. Card 10 records the dependency.');
  if (identity.hostingPlatform === 'Already in a cloud' || identity.sourceEnvironment === 'existing-cloud')
    out.push('Already in a cloud: the choices are staying, re-platforming within that cloud, or moving across clouds.');
  if (identity.sourceEnvironment === 'saas')
    out.push('Mostly SaaS integrations: there may be little to move but the integrations and the data.');
  if (identity.vendor && !['Custom Built', 'Open Source', 'Other', ''].includes(identity.vendor))
    out.push(`A ${vendorLabel(identity)} product: check whether the vendor supports it in the cloud, and whether they offer it as SaaS.`);
  if (identity.vendor === 'Custom Built')
    out.push('Built in-house: every route is open, including Refactor, if the team can change the code.');
  return out;
}

// --- Card 2: criticality and continuity --------------------------------------

/** The wizard's tiers, with its "Tier 2/3" split in two (the evaluator had four levels). */
export const CRITICALITY                    = [
  { value: 'tier0', label: 'Tier 0 – mission critical (customer / revenue)' },
  { value: 'tier1', label: 'Tier 1 – important internal' },
  { value: 'tier2', label: 'Tier 2 – supporting' },
  { value: 'tier3', label: 'Tier 3 – low / batch' },
];

export const UPTIME                    = [
  { value: '99.0', label: '~99.0% (occasional outages tolerated)' },
  { value: '99.5', label: '~99.5%' },
  { value: '99.9', label: '~99.9%' },
  { value: '99.95', label: '99.95%+' },
];

export const RTO                    = [
  { value: 'mins', label: 'Minutes' },
  { value: 'hour', label: 'Around 1 hour' },
  { value: 'few-hours', label: 'Few hours' },
  { value: 'day-plus', label: '1 day or more' },
];

export const RPO                    = [
  { value: 'zero', label: 'Near zero data loss' },
  { value: '15min', label: 'Around 15 minutes' },
  { value: 'hour', label: 'Around 1 hour' },
  { value: 'day', label: 'Up to 1 day' },
];

export const ENVIRONMENTS                    = [
  { value: 'dev', label: 'Dev' },
  { value: 'test', label: 'Test' },
  { value: 'stage', label: 'Pre-prod / Stage' },
  { value: 'prod', label: 'Prod' },
  { value: 'dr', label: 'DR' },
];

export const NON_PROD_SCALE                    = [
  { value: 'full', label: 'Roughly same as prod' },
  { value: 'half', label: '~50% of prod' },
  { value: 'quarter', label: '~25% of prod' },
  { value: 'minimal', label: 'Small / shared sandboxes' },
];

export const DR_TODAY                    = [
  { value: 'none', label: 'None' },
  { value: 'backup', label: 'Backup and restore' },
  { value: 'warm', label: 'Warm standby' },
  { value: 'active-passive', label: 'Active / passive' },
  { value: 'active-active', label: 'Active / active' },
];

                             
                      
                 
              
              
                         
                       
                  
 

export function emptyContinuity()             {
  return { criticality: '', uptime: '', rto: '', rpo: '', environments: [], nonProdScale: '', drToday: '' };
}

const hasNonProd = (c            ) => c.environments.some((e) => e !== 'prod' && e !== 'dr');

export function continuityProgress(c            )                                   {
  const asked = [c.criticality, c.uptime, c.rto, c.rpo, c.environments.length > 0 ? 'x' : '', c.drToday];
  if (hasNonProd(c)) asked.push(c.nonProdScale);
  return { answered: asked.filter((v) => v !== '').length, of: asked.length };
}

export function continuityProblems(c            )           {
  const out           = [];
  if (c.environments.length === 0) out.push('Tick the environments in scope.');
  if (hasNonProd(c) && !c.nonProdScale) out.push('Say how big the non-production environments are next to prod.');
  return out;
}

/** The wizard's warnings and the DR gap between today and the targets. Facts, not a decision. */
export function continuitySignals(c            )           {
  const out           = [];
  const important = c.criticality === 'tier0' || c.criticality === 'tier1';
  const tightRto = c.rto === 'mins' || c.rto === 'hour';
  const tightRpo = c.rpo === 'zero' || c.rpo === '15min';
  if (important && (c.uptime === '' || c.uptime === '99.0' || c.uptime === '99.5' || c.uptime === '99.9'))
    out.push(`${c.criticality === 'tier0' ? 'Tier 0' : 'Tier 1'} with ${c.uptime ? `a ${c.uptime}% uptime target` : 'no uptime target'}: weak for its tier. Most Tier 0/1 services target 99.95% or better.`);
  if (tightRto || tightRpo) {
    const target = [tightRto ? 'an RTO of minutes to an hour' : '', tightRpo ? 'an RPO of 15 minutes or less' : ''].filter(Boolean).join(' and ');
    out.push(`${target[0]?.toUpperCase()}${target.slice(1)}: backup and restore will not meet it. It needs warm standby or better, and replicated data.`);
    if (c.drToday === 'none' || c.drToday === 'backup')
      out.push(`DR today is ${c.drToday === 'none' ? 'none' : 'backup and restore'}, short of those targets: the move has to build the DR, not copy it.`);
  }
  if (c.rpo === 'zero') out.push('Near-zero data loss means synchronous replication: the replica has to be close (same region, another zone).');
  if (c.criticality === 'tier0') out.push('Tier 0: plan the cutover with a rehearsal and a rollback, and keep the source until the target has run clean.');
  if (c.environments.length > 0 && !c.environments.includes('prod')) out.push('Prod is not in scope: this move covers the non-production environments only.');
  if (c.environments.includes('dr') && c.drToday === 'none') out.push('DR is in scope but there is none today: it is new work, not a migration.');
  return out;
}

// --- Card 9: users and load ---------------------------------------------------

export const BUSY_HOURS                    = [
  { value: 'business', label: 'Business hours only' },
  { value: 'extended', label: 'Extended hours (early to late)' },
  { value: 'even', label: '24/7, fairly even' },
  { value: 'peaks', label: '24/7 with daily peaks' },
  { value: 'batch', label: 'Mostly overnight / batch windows' },
];

export const SEASONALITY                    = [
  { value: 'none', label: 'No seasonal peaks' },
  { value: 'month-end', label: 'Month end' },
  { value: 'quarter-end', label: 'Quarter / year end' },
  { value: 'seasonal', label: 'Seasonal (holidays, enrolment, tax)' },
  { value: 'events', label: 'Event-driven spikes (launches, campaigns, news)' },
];

export const GPU                    = [
  { value: 'none', label: 'No GPU' },
  { value: 'inference', label: 'GPU for inference' },
  { value: 'training', label: 'GPU for training' },
  { value: 'graphics', label: 'GPU for graphics / VDI' },
];

                       
                    
                  
                    
                      
              
 

export function emptyLoad()       {
  return { peakUsers: '', peakRps: '', busyHours: '', seasonality: '', gpu: '' };
}

/** A whole number the user typed, or null when there is none (or it is not a number). */
export function count(text        )                {
  const t = text.replace(/[,\s]/g, '');
  return /^\d+$/.test(t) ? Number(t) : null;
}

export function loadProgress(l      )                                   {
  const asked = [l.peakUsers, l.peakRps, l.busyHours, l.seasonality, l.gpu];
  return { answered: asked.filter((v) => v.trim() !== '').length, of: asked.length };
}

export function loadProblems(l      )           {
  const out           = [];
  if (l.peakUsers.trim() && count(l.peakUsers) === null) out.push('Peak concurrent users should be a whole number.');
  if (l.peakRps.trim() && count(l.peakRps) === null) out.push('Peak requests per second should be a whole number.');
  return out;
}

/** The wizard's traffic bands and what the load pattern means for sizing. Facts, not a decision. */
export function loadSignals(l      )           {
  const out           = [];
  const users = count(l.peakUsers);
  const rps = count(l.peakRps);
  if ((users !== null && users >= 50000) || (rps !== null && rps >= 2000))
    out.push('High traffic band (50,000+ concurrent users or 2,000+ requests a second): size for scale-out behind a load balancer, and load-test before cutover.');
  else if ((users !== null && users <= 5000) || (rps !== null && rps <= 100))
    out.push('Low traffic band (5,000 users or fewer, or 100 requests a second or fewer): a small footprint, a good fit for right-sizing or serverless.');
  if (l.busyHours === 'business') out.push('Busy in business hours only: non-production, and possibly production, can be scheduled off at night.');
  if (l.busyHours === 'batch') out.push('Mostly batch windows: capacity can be started for the window and stopped after it.');
  if (l.seasonality && l.seasonality !== 'none') out.push('Seasonal peaks: size for the peak with autoscaling, not the average, and avoid cutting over during one.');
  if (l.gpu === 'training' || l.gpu === 'inference') out.push('Needs GPUs: check GPU instance availability and quotas in the target region early.');
  if (l.gpu === 'graphics') out.push('Graphics GPUs: points to a VDI / workstation service rather than general compute.');
  return out;
}
