/**
 * Every Stage 1 question, section by section, as data: the page draws the
 * screens from these lists, and the assessment reads the answers by key.
 *
 * Sources: the original Multi-Cloud Decision & Onboarding Wizard (W), the
 * original Application Migration evaluator (E), and additions (new). Closed
 * sets are dropdowns, with "Other" where the original had a free-text box
 * with suggestions; things that come in numbers (servers, databases,
 * languages, integrations) are rows the user adds.
 */

import {
  BUSY_HOURS,
  CRITICALITY,
  DR_TODAY,
  ENVIRONMENTS,
  GPU,
  HOSTING_PLATFORMS,
  NON_PROD_SCALE,
  RPO,
  RTO,
  SEASONALITY,
  SOURCE_ENVIRONMENTS,
  UPTIME,
  VENDORS,
              
              
} from './model.js';

                                         
                                              
                                            

                         
                       
                         
                                       
                                                                     
                             
                                
 

                        
                       
                         
                                                                           
                         
                                       
                                       
                              
                                
                                      
                          
                                                              
                                            
 

const opts = (...labels          )           => labels.map((label) => ({ value: label, label }));
const pairs = (...items                    )           => items.map(([value, label]) => ({ value, label }));
const isOther = (key        ) => (a         ) => a[key] === 'Other';
const YES_NO = pairs(['yes', 'Yes'], ['no', 'No']);

// --- Option lists ------------------------------------------------------------

export const WORKLOAD_TYPES = opts('General LOB app', 'Public web', 'Internal web', 'Batch', 'Analytics', 'AI / ML', 'ETL / data movement', 'Messaging / integration');

export const ARCHITECTURES = opts(
  'Monolith (single deployable)',
  '3-tier',
  'N-tier',
  'Web app / HTTP API',
  'SOA',
  'Microservices (containers)',
  'Event-driven / reactive',
  'Client / server',
  'Batch / scheduled processing',
  'Legacy app / VM-centric',
  'Data / analytics platform',
  'Other',
);

export const LANGUAGES = opts(
  '.NET Framework', '.NET (Core / modern)', 'C#', 'F#', 'ASP.NET MVC', 'ASP.NET WebForms',
  'Java 8', 'Java 11', 'Java 17+', 'Spring', 'JBoss / WildFly', 'WebLogic',
  'Node.js', 'Express', 'NestJS', 'Python', 'Django', 'Flask', 'FastAPI', 'Go', 'Gin',
  'PHP', 'Laravel', 'Symfony', 'Ruby', 'Rails', 'C / C++', 'Rust',
  'COBOL', 'Mainframe', 'PowerBuilder', 'VB6', 'Delphi', 'ColdFusion',
  'SharePoint', 'Dynamics', 'SAP ABAP', 'Other',
);

export const MIDDLEWARE = opts(
  'IIS', 'Apache HTTP Server', 'NGINX', 'Tomcat', 'JBoss / WildFly', 'WebLogic', 'WebSphere',
  'IBM MQ', 'RabbitMQ', 'ActiveMQ', 'Kafka', 'TIBCO', 'BizTalk', 'MuleSoft',
  'Redis', 'Memcached', 'Elasticsearch', 'Other',
);

export const STATE = pairs(
  ['stateless', 'Stateless'],
  ['memory', 'Stateful: state in memory'],
  ['disk', 'Stateful: state on local disk'],
  ['mixed', 'Mixed'],
);

export const SESSIONS = pairs(
  ['none', 'No user sessions'],
  ['sticky', 'In memory, sticky sessions'],
  ['cache', 'Shared cache (Redis / Memcached)'],
  ['database', 'Held in the database'],
  ['token', 'Token / client-side (JWT)'],
);

export const TRAFFIC = pairs(['low', 'Low, predictable'], ['medium', 'Medium, predictable'], ['high', 'High, 24/7'], ['spiky', 'Spiky / bursty']);
export const LATENCY = pairs(['strict', 'Strict (sub-second, customer facing)'], ['moderate', 'Moderate (seconds are fine)'], ['relaxed', 'Relaxed (batch / offline)']);
export const WRITES = pairs(['light', 'Light writes, mostly reads'], ['balanced', 'Balanced reads and writes'], ['heavy-writes', 'Heavy write / ingest']);
export const GEOGRAPHY = pairs(['single-region', 'Single region / country'], ['multi-region', 'Multi-region in one continent'], ['global', 'Global user base']);
export const SKILLS = pairs(['vms', 'VMs / servers'], ['containers', 'Containers / Kubernetes'], ['paas', 'PaaS / managed platforms'], ['serverless', 'Serverless / functions']);
export const OPS_MATURITY = pairs(['basic', 'Basic: no real 24/7 ops'], ['intermediate', 'Intermediate: some on-call / runbooks'], ['advanced', 'Advanced: SRE / strong automation']);

export const SERVER_ROLES = opts('Web', 'App', 'Database', 'Batch', 'File', 'Cache', 'Middleware', 'Other');
export const OPERATING_SYSTEMS = opts(
  'Windows Server 2008 R2', 'Windows Server 2012', 'Windows Server 2016', 'Windows Server 2019', 'Windows Server 2022', 'Windows Server 2025',
  'RHEL 6', 'RHEL 7', 'RHEL 8', 'RHEL 9', 'Ubuntu 16.04', 'Ubuntu 18.04', 'Ubuntu 20.04', 'Ubuntu 22.04', 'Ubuntu 24.04',
  'SUSE SLES 12', 'SUSE SLES 15', 'Oracle Linux', 'Debian', 'CentOS', 'Rocky / Alma Linux',
  'AIX', 'HP-UX', 'Solaris', 'Mainframe z/OS', 'VMware appliance', 'Containerized', 'Other',
);
export const CLUSTERING = opts('None', 'Windows failover cluster (WSFC)', 'Pacemaker', 'Oracle RAC', 'VMware FT', 'Load-balanced pool', 'Other');

export const DATA_PATTERNS = pairs(
  ['relational', 'Relational (OLTP)'],
  ['nosql', 'NoSQL / document / key-value'],
  ['files', 'Files / objects / blobs'],
  ['streaming', 'Streaming / telemetry'],
  ['analytics-lake', 'Analytics / data lake / warehouse'],
);
export const DB_ENGINES = opts(
  'SQL Server', 'SQL Server Always On', 'Oracle', 'Oracle RAC', 'PostgreSQL', 'MySQL', 'MariaDB', 'DB2',
  'MongoDB', 'Cassandra', 'Couchbase', 'Redis', 'SQLite', 'Teradata', 'Netezza', 'Vertica', 'Snowflake', 'Other',
);
export const DB_GROWTH = opts('Flat', 'Under 10% a year', '10–30% a year', 'Over 30% a year');
export const DB_HA = opts('None', 'Always On availability group', 'Failover cluster', 'Oracle RAC', 'Data Guard', 'Replication', 'Other');
export const SENSITIVITY = pairs(
  ['public', 'Public / low impact'],
  ['internal', 'Internal, non-sensitive'],
  ['confidential', 'Confidential business data'],
  ['regulated', 'Regulated (PII / NPI / PCI etc.)'],
  ['ps-l2', 'Public sector L2'],
  ['ps-l4', 'Public sector L4'],
  ['ps-l5', 'Public sector L5'],
  ['ps-l6', 'Public sector L6'],
);
export const VOLUME = pairs(['xs', 'XS: under 100 GB'], ['s', 'S: 100 GB – 1 TB'], ['m', 'M: 1 – 5 TB'], ['l', 'L: 5 – 20 TB'], ['xl', 'XL: 20 TB+']);
export const INGEST = pairs(['light', 'Light: under 10 GB a day'], ['medium', 'Medium: 10 – 100 GB a day'], ['heavy', 'Heavy: 100 GB – 1 TB a day'], ['very-heavy', 'Very heavy: 1 TB+ a day']);
export const RETENTION = pairs(['short', 'Short: under 3 months'], ['standard', 'Standard: 3 – 24 months'], ['long', 'Long: 2 – 7 years'], ['very-long', 'Archival: 7+ years']);
export const FILE_SHARES = opts('None', 'SMB / CIFS', 'NFS', 'SMB and NFS');

export const INTEGRATION_PATTERNS = pairs(
  ['simple-http', 'Simple HTTP calls to a few services'],
  ['enterprise-messaging', 'Enterprise messaging / async flows'],
  ['event-streaming', 'Event streaming / telemetry'],
  ['orchestration', 'Complex workflows / orchestrations'],
);
export const INTEGRATION_TYPES = opts('REST API', 'SOAP', 'Message queue (MQ)', 'Kafka', 'File drop (SFTP / FTPS)', 'Database link / replication', 'Email', 'EDI', 'Custom TCP / UDP', 'Other');
export const DIRECTIONS = opts('Inbound', 'Outbound', 'Both');
export const SIGN_IN = opts(
  'Active Directory (AD)', 'LDAP', 'Kerberos', 'Entra ID (Azure AD)', 'Okta', 'Ping Identity', 'ADFS',
  'SAML', 'OIDC', 'OAuth2', 'RADIUS', 'CAC / PIV', 'Local accounts', 'Custom auth', 'Other',
);
export const IDENTITY_MODELS = pairs(
  ['cloud-iam-only', 'Cloud-native IAM only'],
  ['hybrid-ad-entra', 'Hybrid AD / Entra / on-prem IdP'],
  ['external-idp-plus-iam', 'External IdP (Okta / Ping etc.) + cloud IAM'],
);

export const COMPLIANCE = pairs(
  ['commercial', 'Commercial'], ['fedramp_low', 'FedRAMP Low'], ['fedramp_moderate', 'FedRAMP Moderate'], ['fedramp_high', 'FedRAMP High'],
  ['cjis', 'CJIS'], ['hipaa', 'HIPAA'], ['pci', 'PCI DSS'], ['sox', 'SOX'], ['fisma', 'FISMA'], ['cmmc', 'CMMC'], ['itar', 'ITAR'],
  ['gdpr', 'GDPR'], ['ferpa', 'FERPA'], ['soc2', 'SOC 2'], ['iso27001', 'ISO 27001'],
);
export const BASELINES = pairs(
  ['standard', 'Standard enterprise baseline (CIS / internal)'],
  ['regulated', 'Strict regulated (PCI / PHI / SOX etc.)'],
  ['stig', 'DoD / STIG-aligned'],
  ['minimal', 'Minimal / best-effort hardening'],
);
export const SECRETS = pairs(['basic', 'Basic secrets in config / parameter store'], ['secrets-manager', 'Cloud-native secrets manager'], ['hsm-backed', 'HSM-backed keys / dedicated KMS']);
export const PROTECTION = pairs(['at-rest', 'At-rest encryption only'], ['in-transit-and-at-rest', 'In transit + at rest (TLS everywhere)'], ['field-level', 'Field-level / tokenization / anonymization']);
export const SECOPS = pairs(['basic', 'Basic logging only'], ['central-siem', 'Central SIEM / SOC, alerts triaged'], ['mature-devsecops', 'Mature SecOps and DevSecOps']);

export const EXPOSURE = pairs(['internet', 'Internet-facing'], ['partner', 'Partner-facing / extranet'], ['internal', 'Internal only']);
export const PERIMETER = pairs(
  ['cloud-fw-only', 'Cloud-native firewall / WAF only'],
  ['cloud-plus-f5', 'Cloud-native + F5 (ADC / WAF)'],
  ['f5-centric', 'F5-centric perimeter (BIG-IP / NGINX / XC)'],
  ['legacy-fw', 'Legacy on-prem firewall in the path'],
);
export const F5_USAGE = pairs(
  ['waap-web', 'WAAP / WAF for web apps'], ['api-security', 'API security / gateway'], ['ddos', 'DDoS protection'],
  ['gslb', 'GSLB / global traffic'], ['service-mesh', 'Service mesh / east-west L7'], ['remote-access', 'Remote access / ZTNA'],
);
export const REGIONS = pairs(
  ['1', 'Single region'], ['1-ha', 'Single region, multi-AZ / zone'], ['2', 'Two regions (active / passive)'],
  ['2-active', 'Two regions (active / active)'], ['3plus', 'Three+ regions / global'],
);
export const LOAD_BALANCERS = opts('None', 'F5 BIG-IP', 'NetScaler', 'NGINX / HAProxy', 'Windows NLB', 'Other');

export const GATES = pairs(
  ['obsolete', 'Obsolete / no longer used'],
  ['saas', 'A vendor SaaS replacement exists'],
  ['mustStay', 'Must stay on-prem (policy)'],
  ['hardware', 'Hardware bound / appliance dependency'],
  ['mainframe', 'Mainframe dependency'],
  ['licence', 'Licence tied to hardware or cores (Oracle, SQL Server…)'],
  ['vendorNoCloud', 'Vendor will not support it in the cloud'],
  ['hardcoded', 'Hard-coded IPs or hostnames'],
);

/** The evaluator's six ratings, their weights, and whether a high rating is bad news. */
export const RATINGS = [
  { key: 'cloudCompat', label: 'Cloud compatibility', weight: 20, inverted: false, tip: 'OS support, networking patterns, dependencies, licensing portability.' },
  { key: 'techDebt', label: 'Technical debt', weight: 20, inverted: true, tip: 'Age, patch posture, brittle releases, manual operations.' },
  { key: 'vendorLock', label: 'Vendor lock risk', weight: 10, inverted: true, tip: 'Proprietary middleware, closed formats, contracts.' },
  { key: 'complianceComplexity', label: 'Compliance complexity', weight: 15, inverted: true, tip: 'CJIS / FedRAMP / ITAR constraints and audit overhead.' },
  { key: 'modularity', label: 'Architecture modularity', weight: 15, inverted: false, tip: 'Clear components, APIs, separation of concerns.' },
  { key: 'refactorEffort', label: 'Refactor effort', weight: 20, inverted: true, tip: 'Effort and time to modernise safely.' },
]         ;
export const RATING_SCALE = pairs(['1', '1 – worst / hardest'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5 – best / easiest']);

export const MONITORING = opts('None', 'VCF Operations', 'Splunk', 'Datadog', 'Dynatrace', 'New Relic', 'Prometheus / Grafana', 'SCOM', 'Nagios / Zabbix', 'Other');
export const BACKUP = opts('None', 'Veeam', 'Commvault', 'Veritas NetBackup', 'Rubrik', 'Cohesity', 'Dell PowerProtect / Avamar', 'Storage snapshots only', 'Other');
export const PATCHING = opts('Monthly', 'Quarterly', 'Ad hoc', 'Not patched');

// --- The sections --------------------------------------------------------------

export const FIELDS                                   = {
  identity: [
    { key: 'name', label: 'Application name', kind: 'text', required: true, hint: 'Short label so you recognise it in reviews.', placeholder: 'e.g. Case Management System' },
    { key: 'vendor', label: 'Vendor', kind: 'select', options: VENDORS, hint: 'Who makes it. Custom Built if it is your own code.' },
    { key: 'vendorOther', label: 'Vendor name', kind: 'text', required: true, showIf: isOther('vendor') },
    { key: 'businessUnit', label: 'Business unit', kind: 'text', hint: 'The part of the organisation it serves.' },
    { key: 'businessOwner', label: 'Business owner / team', kind: 'text', hint: 'Who signs off on the move.' },
    { key: 'technicalOwner', label: 'Technical owner', kind: 'text', hint: 'Who knows how it is built and run.' },
    { key: 'sourceEnvironment', label: 'Source environment', kind: 'select', options: SOURCE_ENVIRONMENTS, hint: 'Where it runs today.' },
    { key: 'hostingPlatform', label: 'Hosting platform', kind: 'select', options: HOSTING_PLATFORMS, hint: 'What it runs on today.' },
    { key: 'hostingOther', label: 'Hosting platform name', kind: 'text', required: true, showIf: isOther('hostingPlatform') },
    { key: 'description', label: 'Short description', kind: 'area', placeholder: 'What does it do? Who uses it? What would stop if it went down?' },
    { key: 'notes', label: 'Notes', kind: 'area', placeholder: 'Key constraints, special requirements, known pain points' },
  ],
  continuity: [
    { key: 'criticality', label: 'Business criticality', kind: 'select', options: CRITICALITY, hint: 'How much the business depends on it.' },
    { key: 'uptime', label: 'Uptime target', kind: 'select', options: UPTIME, hint: 'The availability it has to keep.' },
    { key: 'drToday', label: 'DR today', kind: 'select', options: DR_TODAY, hint: 'What protects it now, before the move.' },
    { key: 'rto', label: 'RTO', kind: 'select', options: RTO, hint: 'How long it can be down after a failure.' },
    { key: 'rpo', label: 'RPO', kind: 'select', options: RPO, hint: 'How much recent data it can lose.' },
    { key: 'environments', label: 'Environments in scope', kind: 'checks', options: ENVIRONMENTS, hint: 'Which environments this move covers.' },
    {
      key: 'nonProdScale',
      label: 'Non-prod scale vs prod',
      kind: 'select',
      options: NON_PROD_SCALE,
      hint: 'How big Dev, Test and Stage are next to Prod.',
      showIf: (a) => Array.isArray(a['environments']) && (a['environments']            ).some((e) => e !== 'prod' && e !== 'dr'),
    },
  ],
  load: [
    { key: 'peakUsers', label: 'Peak concurrent users', kind: 'number', hint: 'At the busiest time.', placeholder: 'e.g. 5000' },
    { key: 'peakRps', label: 'Peak requests / second', kind: 'number', hint: 'Pushes toward autoscaling or reserved capacity.', placeholder: 'e.g. 200' },
    { key: 'busyHours', label: 'When it is busy', kind: 'select', options: BUSY_HOURS, hint: 'Decides what can be scheduled off.' },
    { key: 'seasonality', label: 'Seasonal peaks', kind: 'select', options: SEASONALITY, hint: 'Size for the peak, and avoid cutting over during one.' },
    { key: 'gpu', label: 'GPU', kind: 'select', options: GPU, hint: 'Needs GPU capacity in the target region?' },
  ],
  what: [
    { key: 'workloadType', label: 'Workload type', kind: 'select', options: WORKLOAD_TYPES, hint: 'What kind of application it is.' },
    { key: 'architecture', label: 'Architecture', kind: 'select', options: ARCHITECTURES, hint: 'How it is put together today.' },
    { key: 'architectureOther', label: 'Architecture (name it)', kind: 'text', required: true, showIf: isOther('architecture') },
    { key: 'state', label: 'State', kind: 'select', options: STATE, hint: 'Where it keeps what it is working on.' },
    { key: 'sessions', label: 'User sessions', kind: 'select', options: SESSIONS, hint: 'Sticky sessions tie users to one server.' },
    { key: 'traffic', label: 'Traffic pattern', kind: 'select', options: TRAFFIC, hint: 'Pushes toward serverless or reserved capacity.' },
    { key: 'latency', label: 'Latency sensitivity', kind: 'select', options: LATENCY, hint: 'How fast answers must come back.' },
    { key: 'writes', label: 'Write / update pattern', kind: 'select', options: WRITES, hint: 'Mostly reads, or a lot of writing.' },
    { key: 'geography', label: 'Where the users are', kind: 'select', options: GEOGRAPHY, hint: 'Decides regions and edge caching.' },
    { key: 'opsMaturity', label: 'Ops / SRE maturity', kind: 'select', options: OPS_MATURITY, hint: 'How the team runs it today.' },
    { key: 'skills', label: 'Team strengths', kind: 'checks', options: SKILLS, hint: 'Tick all the team is good at.' },
    {
      key: 'languages',
      label: 'Languages and frameworks',
      kind: 'rows',
      wide: true,
      hint: 'One row each, with its version.',
      columns: [
        { key: 'language', label: 'Language / framework', options: LANGUAGES },
        { key: 'version', label: 'Version', placeholder: 'e.g. 4.8' },
      ],
    },
    {
      key: 'middleware',
      label: 'Middleware',
      kind: 'rows',
      wide: true,
      hint: 'Web servers, application servers, queues and caches it needs.',
      columns: [
        { key: 'product', label: 'Product', options: MIDDLEWARE },
        { key: 'version', label: 'Version', placeholder: 'e.g. 10.0' },
      ],
    },
  ],
  servers: [
    {
      key: 'servers',
      label: 'Servers',
      kind: 'rows',
      wide: true,
      hint: 'One row per server, in every environment in scope. Utilisation figures size the target; leave blank what you do not know.',
      columns: [
        { key: 'name', label: 'Name', placeholder: 'e.g. cms-web01' },
        { key: 'environment', label: 'Env', options: ENVIRONMENTS },
        { key: 'role', label: 'Role', options: SERVER_ROLES },
        { key: 'os', label: 'Operating system', options: OPERATING_SYSTEMS },
        { key: 'vcpu', label: 'vCPU', numeric: true },
        { key: 'ramGb', label: 'RAM GB', numeric: true },
        { key: 'diskGb', label: 'Disk GB', numeric: true },
        { key: 'cpuPeak', label: 'CPU peak %', numeric: true },
        { key: 'memPeak', label: 'Mem peak %', numeric: true },
        { key: 'iops', label: 'Peak IOPS', numeric: true },
        { key: 'cluster', label: 'Clustering', options: CLUSTERING },
      ],
    },
  ],
  data: [
    { key: 'dataPattern', label: 'Primary data pattern', kind: 'select', options: DATA_PATTERNS, hint: 'The main way it stores data.' },
    { key: 'sensitivity', label: 'Data sensitivity / sector', kind: 'select', options: SENSITIVITY, hint: 'Regulated and public-sector data need tighter controls.' },
    { key: 'fileShares', label: 'File shares', kind: 'select', options: FILE_SHARES, hint: 'Shared file storage it depends on.' },
    { key: 'volume', label: 'Total data volume', kind: 'select', options: VOLUME, hint: 'Everything it holds.' },
    { key: 'ingest', label: 'Daily change / ingest', kind: 'select', options: INGEST, hint: 'Decides the sync method and cutover time.' },
    { key: 'retention', label: 'Retention', kind: 'select', options: RETENTION, hint: 'Decides hot, cool and archive storage.' },
    {
      key: 'databases',
      label: 'Databases',
      kind: 'rows',
      wide: true,
      hint: 'One row per database. Special features: linked servers, CLR, jobs, RAC, partitioning, anything a managed service might not support.',
      columns: [
        { key: 'name', label: 'Name', placeholder: 'e.g. CMSPROD' },
        { key: 'engine', label: 'Engine', options: DB_ENGINES },
        { key: 'version', label: 'Version', placeholder: 'e.g. 2016' },
        { key: 'sizeGb', label: 'Size GB', numeric: true },
        { key: 'growth', label: 'Growth', options: DB_GROWTH },
        { key: 'ha', label: 'HA', options: DB_HA },
        { key: 'features', label: 'Special features', placeholder: 'e.g. linked servers, CLR' },
      ],
    },
  ],
  connections: [
    { key: 'pattern', label: 'Integration pattern', kind: 'select', options: INTEGRATION_PATTERNS, hint: 'The main way it talks to other systems.' },
    { key: 'signIn', label: 'How users sign in', kind: 'select', options: SIGN_IN, hint: 'The identity source it trusts today.' },
    { key: 'identityModel', label: 'Identity model in the cloud', kind: 'select', options: IDENTITY_MODELS, hint: 'How sign-in should work after the move.' },
    {
      key: 'integrations',
      label: 'Integrations',
      kind: 'rows',
      wide: true,
      hint: 'Every system it talks to. Latency-sensitive or on-prem-only links decide what has to move together.',
      columns: [
        { key: 'system', label: 'System', placeholder: 'e.g. Payroll' },
        { key: 'type', label: 'Type', options: INTEGRATION_TYPES },
        { key: 'direction', label: 'Direction', options: DIRECTIONS },
        { key: 'port', label: 'Protocol / port', placeholder: 'e.g. HTTPS 443' },
        { key: 'latencySensitive', label: 'Latency-sensitive', options: YES_NO },
        { key: 'onPremOnly', label: 'Stays on-prem', options: YES_NO },
      ],
    },
  ],
  security: [
    { key: 'compliance', label: 'Compliance scope', kind: 'checks', options: COMPLIANCE, wide: true, hint: 'Tick all that apply.' },
    { key: 'sovereignty', label: 'Data sovereignty required', kind: 'select', options: YES_NO, hint: 'Must the data stay in a country or a sovereign cloud?' },
    { key: 'baseline', label: 'Security baseline', kind: 'select', options: BASELINES, hint: 'The hardening standard it must meet.' },
    { key: 'secrets', label: 'Secrets and keys', kind: 'select', options: SECRETS, hint: 'Where passwords and keys are kept.' },
    { key: 'protection', label: 'Data protection', kind: 'select', options: PROTECTION, hint: 'How the data is encrypted.' },
    { key: 'secops', label: 'Security operations', kind: 'select', options: SECOPS, hint: 'How security events are watched.' },
    { key: 'complianceNotes', label: 'Compliance notes', kind: 'area', placeholder: 'e.g. GLBA NPI, PCI, SOX, FFIEC, NIST 800-53, FedRAMP IL4+…' },
  ],
  network: [
    { key: 'exposure', label: 'Exposure', kind: 'select', options: EXPOSURE, hint: 'Who can reach it.' },
    { key: 'perimeter', label: 'Perimeter and firewall', kind: 'select', options: PERIMETER, hint: 'What sits in front of it.' },
    { key: 'loadBalancer', label: 'Load balancer today', kind: 'select', options: LOAD_BALANCERS, hint: 'Rules and certificates move with it.' },
    { key: 'regions', label: 'Regions / sites needed', kind: 'select', options: REGIONS, hint: 'Drives the DR and network design.' },
    { key: 'f5', label: 'F5 usage', kind: 'checks', options: F5_USAGE, wide: true, hint: 'Tick what F5 does for it, if anything.' },
  ],
  gates: [
    { key: 'gates', label: 'What stands in the way', kind: 'checks', options: GATES, wide: true, hint: 'Each one ticked limits the routes open to it. These settle the route before any score.' },
  ],
  ratings: RATINGS.map((r) => ({ key: r.key, label: r.label, kind: 'select'         , options: RATING_SCALE, hint: r.tip })),
  operations: [
    { key: 'monitoring', label: 'Monitoring', kind: 'select', options: MONITORING, hint: 'What watches it today.' },
    { key: 'backup', label: 'Backup tool', kind: 'select', options: BACKUP, hint: 'What backs it up today.' },
    { key: 'patching', label: 'Patching', kind: 'select', options: PATCHING, hint: 'How often it is patched.' },
    { key: 'supportTeam', label: 'Support team', kind: 'text', hint: 'Who is called when it breaks.' },
    { key: 'knownIssues', label: 'Known issues and tech debt', kind: 'area', placeholder: 'What breaks, what is out of support, what everyone works around' },
  ],
};
