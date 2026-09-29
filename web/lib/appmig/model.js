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
                                                  
export const BUILT                      = new Set        (['identity']);

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
  return { id, created: now, updated: now, identity: emptyIdentity() };
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
