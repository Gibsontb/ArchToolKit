/**
 * The wizard's questions.
 *
 * Ported from the previous toolkit's multi-cloud-decision-matrix.html: the same
 * four steps, the same questions, the same answer sets, the same hints, and —
 * this matters more than it sounds — the same order.
 *
 * The order matters because the questions are laid out two to a row. A section
 * heading occupies a cell of its own, so dropping one shifts every question
 * after it into the wrong column. Headings are therefore items in this list
 * rather than decoration applied afterwards.
 *
 * The ids matter too. The recommendation engine in ./engine.js reads every
 * answer out of the DOM by element id, so these are the contract between the
 * two files: rename one here and the engine silently stops seeing that answer.
 *
 * Step 3 has four alternative groups of questions, one per initiative type.
 * Only the matching group is asked, which is what `showFor` selects.
 *
 * The flow is the original's four steps, corrected and extended to seven so it
 * covers what the migration system knows: the source and its inventory get a
 * step of their own (with the 7R and the database strategy), connectivity and
 * dependencies get one (the data-centre link and the cross-cloud connectors),
 * and the last step reviews and generates.
 */

import { APP_PATTERN_OPTIONS } from '../plan/options.js';

                           
            
                                                                                            
                 
                                                                                  
                
          
            
               

                               
                         
                         
 

                              
                         
                                                             
                      
                         
                                  
                         
                                
                              
                                             
 

/** A sub-heading inside a step. It takes a grid cell, which is why it is here. */
                                
                           
                        
 

                                                     

                              
                      
                                               
                           
                                        
 

                             
                          
                         
                            
                                                              
                        
                                                                            
                                       
                                        
                                           
 

export const WIZARD_STEPS                        = [
  {
    number: 1,
    title: 'Initiative & basics',
    subtitle: 'New vs existing vs maintenance vs migration, plus workload basics',
    hint: 'Pick initiative type and capture basics.',
    items: [
      {
        kind: 'field',
        id: 'initiativeType',
        label: 'Initiative type',
        control: 'select',
        hint: 'First decision point: are we creating something new, changing an existing service, maintaining, or migrating?',
        required: true,
        options: [
          { value: 'new-service', label: 'New service / greenfield' },
          { value: 'existing-service', label: 'Change to existing service' },
          { value: 'maintenance', label: 'Maintenance / operations' },
          { value: 'migration', label: 'Migration' },
        ],
      },
      {
        kind: 'field',
        id: 'workloadName',
        label: 'Workload / initiative name',
        control: 'text',
        hint: 'Short label so you recognize this initiative in reviews.',
        placeholder: 'e.g. Retail payments API, Claims analytics hub',
        required: true,
      },
      {
        kind: 'field',
        id: 'appPattern',
        label: 'Application pattern',
        control: 'select',
        hint: 'What the application is (SAP, IIS / .NET, a web app, microservices …). It chooses the components and the tier patterns offered.',
        options: APP_PATTERN_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
      },
      {
        kind: 'field',
        id: 'architectureType',
        label: 'Architecture type',
        control: 'select',
        hint: 'Current or target architecture for this initiative.',
        options: [
          { value: 'web-api', label: 'Web app / HTTP API' },
          { value: 'microservices', label: 'Microservices (containers)' },
          { value: 'batch', label: 'Batch / scheduled processing' },
          { value: 'event-driven', label: 'Event-driven / reactive' },
          { value: 'legacy-vm', label: 'Legacy app / VM-centric' },
          { value: 'data-analytics', label: 'Data / analytics platform' },
        ],
      },
      {
        kind: 'field',
        id: 'trafficPattern',
        label: 'Traffic pattern',
        control: 'select',
        hint: 'Used to push toward serverless vs reserved capacity.',
        options: [
          { value: 'low', label: 'Low, predictable' },
          { value: 'medium', label: 'Medium, predictable' },
          { value: 'high', label: 'High, 24/7' },
          { value: 'spiky', label: 'Spiky / bursty' },
        ],
      },
      {
        kind: 'field',
        id: 'latencySensitivity',
        label: 'Latency sensitivity',
        control: 'select',
        options: [
          { value: 'strict', label: 'Strict (sub-second, customer facing)' },
          { value: 'moderate', label: 'Moderate (seconds are fine)' },
          { value: 'relaxed', label: 'Relaxed (batch / offline)' },
        ],
      },
      {
        kind: 'field',
        id: 'teamSkills',
        label: 'Team strengths',
        control: 'select',
        hint: 'Pick the dominant skill pattern; you can note edge cases in the description.',
        options: [
          { value: 'vms', label: 'VMs / servers' },
          { value: 'containers', label: 'Containers / Kubernetes' },
          { value: 'paas', label: 'PaaS / managed app platforms' },
          { value: 'serverless', label: 'Serverless / functions' },
        ],
      },
      {
        kind: 'field',
        id: 'description',
        label: 'Short description',
        control: 'textarea',
        placeholder: 'What does this initiative do? Who uses it? What problem does it solve?',
      },
    ],
  },
  {
    number: 2,
    title: 'Source & inventory',
    showFor: ['migration'],
    subtitle: 'What the application runs on today: its servers, databases and source platform',
    hint: 'Confirm the source and where the databases go.',
    items: [
      {
        kind: 'field',
        id: 'sourceEnv',
        label: 'Source environment (today)',
        control: 'select',
        hint: 'Used to drive VMware options, migration tooling, and network connectivity.',
        options: [
          { value: 'onprem-vmware', label: 'On-prem VMware estate' },
          { value: 'onprem-baremetal', label: 'On-prem bare metal / mixed hypervisors' },
          { value: 'existing-dc', label: 'Hosted / co-lo data center' },
          { value: 'existing-cloud', label: 'Existing cloud (re-platform / multi-cloud)' },
          { value: 'saas', label: 'Primarily SaaS integrations' },
          { value: 'hybrid', label: 'Hybrid mix of on-prem + cloud' },
        ],
      },
      {
        kind: 'field',
        id: 'dbStrategy',
        label: 'Database target',
        control: 'select',
        hint: 'Managed services where they fit, or the databases kept on VMs. The engine’s choice lets the licensing and compatibility rules decide per database.',
        options: [
          { value: 'engine', label: 'The engine’s choice (per database)' },
          { value: 'managed', label: 'Managed database services' },
          { value: 'vm', label: 'Keep the databases on VMs' },
        ],
      },
    ],
  },
  {
    number: 9,
    title: 'What it is & its expected load',
    showFor: ['new-service'],
    subtitle: 'A new service: what it is (its pattern) and the load it is sized from',
    hint: 'Give the load profile: users, requests, data, environments.',
    groups: [
      {
        id: 'path-new-service',
        showFor: 'new-service',
        items: [
          {
            kind: 'field',
            id: 'newServiceType',
            label: 'New service type',
            control: 'select',
            options: [
              { value: 'customer-facing', label: 'Customer-facing app / digital product' },
              { value: 'internal-lob', label: 'Internal line-of-business app' },
              { value: 'data-analytics-platform', label: 'Data / analytics / reporting platform' },
              { value: 'integration-hub', label: 'Integration / API / messaging hub' },
              { value: 'shared-platform', label: 'Shared platform / capability (logging, identity, etc.)' },
            ],
          },
          {
            kind: 'field',
            id: 'newServiceStage',
            label: 'Stage',
            control: 'select',
            options: [
              { value: 'pilot', label: 'Pilot / proof-of-concept' },
              { value: 'new-prod', label: 'New production workload' },
              { value: 'scale-existing', label: 'Scaling a successful service' },
            ],
          },
        ],
      },
    ],
    items: [],
  },
  {
    number: 8,
    title: 'The service & the change',
    showFor: ['existing-service', 'maintenance'],
    subtitle: 'Which running service or server, and which change (resize, add a disk, open a port, DNS, patch …)',
    hint: 'Pick the service or server and the change.',
    groups: [
      {
        id: 'path-existing-change',
        showFor: 'existing-service',
        items: [
          {
            kind: 'field',
            id: 'existingChangeType',
            label: 'Change focus',
            control: 'select',
            options: [
              { value: 'scale-ha', label: 'Scale / HA / resilience' },
              { value: 'features', label: 'New features / capabilities' },
              { value: 'compliance', label: 'Compliance / security hardening' },
              { value: 'cost', label: 'Cost optimization / rightsizing' },
              { value: 'modernization', label: 'Modernization / tech-refresh' },
              { value: 'customer-facing', label: 'Customer-facing app / digital product' },
              { value: 'internal-lob', label: 'Internal line-of-business app' },
              { value: 'data-analytics-platform', label: 'Data / analytics / reporting platform' },
              { value: 'integration-hub', label: 'Integration / API / messaging hub' },
              { value: 'shared-platform', label: 'Shared platform / capability (logging, identity, etc.)' },
            ],
          },
          {
            kind: 'field',
            id: 'existingPainPoints',
            label: 'Current pain points',
            control: 'textarea',
            placeholder: 'Incidents, audit findings, performance issues, cost overrun, technical debt, etc.',
          },
        ],
      },
      {
        id: 'path-maintenance',
        showFor: 'maintenance',
        items: [
          {
            kind: 'field',
            id: 'maintenanceFocus',
            label: 'Maintenance focus',
            control: 'select',
            options: [
              { value: 'patching', label: 'Patching & platform updates' },
              { value: 'performance', label: 'Performance tuning / capacity' },
              { value: 'incident-reduction', label: 'Incident reduction / reliability' },
              { value: 'cost', label: 'Cost optimization / housekeeping' },
              { value: 'slo-reporting', label: 'SLOs, reporting & governance' },
            ],
          },
          {
            kind: 'field',
            id: 'maintenanceCadence',
            label: 'Operational cadence',
            control: 'select',
            options: [
              { value: 'weekly', label: 'Weekly' },
              { value: 'monthly', label: 'Monthly' },
              { value: 'quarterly', label: 'Quarterly' },
            ],
          },
        ],
      },
    ],
    items: [],
  },
  {
    number: 10,
    title: 'Strategy (the R)',
    showFor: ['migration'],
    subtitle: 'How the application moves: the migration strategy, per the provider’s own list',
    hint: 'Choose the strategy; the execution method follows from it per server.',
    groups: [
      {
        id: 'path-migration',
        showFor: 'migration',
        items: [
          {
            kind: 'field',
            id: 'migrationScope',
            label: 'Migration scope',
            control: 'select',
            options: [
              { value: 'single-app', label: 'Single application / service' },
              { value: 'portfolio', label: 'Portfolio of many apps' },
              { value: 'dc-estate', label: 'Data center / infrastructure estate' },
              { value: 'db-only', label: 'Database-only / data-only migration' },
            ],
          },
          {
            kind: 'field',
            id: 'cutoverStrategy',
            label: 'Cutover strategy',
            control: 'select',
            options: [
              { value: 'big-bang', label: 'Big-bang cutover' },
              { value: 'phased', label: 'Phased by app / group' },
              { value: 'bluegreen', label: 'Blue/green or parallel run' },
              { value: 'canary', label: 'Canary / cohort-based rollout' },
            ],
          },
        ],
      },
    ],
    items: [
      {
        kind: 'field',
        id: 'migrationApproach',
        label: 'Migration approach (7R)',
        control: 'select',
        options: [
          { value: 'rehost', label: 'Rehost (lift & shift)' },
          { value: 'replatform', label: 'Replatform (minor cloud optimizations)' },
          { value: 'refactor', label: 'Refactor / modernize' },
          { value: 'repurchase', label: 'Repurchase (SaaS)' },
          { value: 'retain', label: 'Retain (stay where it is)' },
          { value: 'retire', label: 'Retire (decommission)' },
          { value: 'relocate', label: 'Relocate (VMware-as-a-Service)' },
        ],
      },
    ],
  },
  {
    number: 3,
    showFor: ['migration', 'new-service'],
    title: 'Design: data & integration',
    subtitle: 'The data, its sensitivity and sector, geography and the integration pattern',
    hint: 'Refine the path type and describe data, sector and integrations.',
    items: [
      {
        kind: 'field',
        id: 'dataType',
        label: 'Primary data pattern',
        control: 'select',
        hint: 'Most important data storage pattern.',
        required: true,
        options: [
          { value: 'relational', label: 'Relational (OLTP)' },
          { value: 'nosql', label: 'NoSQL / document / key-value' },
          { value: 'files', label: 'Files / objects / blobs' },
          { value: 'streaming', label: 'Streaming / telemetry' },
          { value: 'analytics-lake', label: 'Analytics / data lake / warehouse' },
        ],
      },
      {
        kind: 'field',
        id: 'dataSensitivity',
        label: 'Data sensitivity / sector',
        control: 'select',
        hint: 'Drives region choice (Public Sector L2/L4/L5/L6 vs Private Sector), encryption, private endpoints, and which services are allowed for financial & federal workloads.',
        required: true,
        options: [
          { value: 'public', label: 'Public / low impact' },
          { value: 'internal', label: 'Internal, non-sensitive' },
          { value: 'confidential', label: 'Confidential business data' },
          { value: 'regulated', label: 'Regulated (PII / NPI / PCI etc.)' },
          { value: 'ps-l2', label: 'Public Sector L2' },
          { value: 'ps-l4', label: 'Public Sector L4' },
          { value: 'ps-l5', label: 'Public Sector L5' },
          { value: 'ps-l6', label: 'Public Sector L6' },
        ],
      },
      {
        kind: 'field',
        id: 'writePattern',
        label: 'Write / update pattern',
        control: 'select',
        options: [
          { value: 'light', label: 'Light writes, mostly reads' },
          { value: 'balanced', label: 'Balanced reads and writes' },
          { value: 'heavy-writes', label: 'Heavy write / ingest' },
        ],
      },
      {
        kind: 'field',
        id: 'geoPattern',
        label: 'Geography / users',
        control: 'select',
        hint: 'For multi-region and CDN decisions.',
        options: [
          { value: 'single-region', label: 'Single region / country' },
          { value: 'multi-region', label: 'Multi-region in one continent' },
          { value: 'global', label: 'Global user base' },
        ],
      },
      {
        kind: 'field',
        id: 'integrations',
        label: 'Integration pattern',
        control: 'select',
        options: [
          { value: 'simple-http', label: 'Simple HTTP calls to a few services' },
          { value: 'enterprise-messaging', label: 'Enterprise messaging / async flows' },
          { value: 'event-streaming', label: 'Event streaming / telemetry' },
          { value: 'orchestration', label: 'Complex workflows / orchestrations' },
        ],
      },
      {
        kind: 'field',
        id: 'complianceNotes',
        label: 'Compliance / regulatory notes',
        control: 'textarea',
        placeholder: 'e.g. GLBA NPI, PCI, SOX, FFIEC, NIST 800-53, FedRAMP IL4+/IL5/IL6, etc.',
      },
    ],
  },
  {
    number: 4,
    showFor: ['migration', 'new-service'],
    title: 'Design: non-functional, security & tooling',
    subtitle: 'Criticality, SLOs, security baseline and automation tools',
    hint: 'How critical it is and how you will move & run it.',
    items: [
      {
        kind: 'field',
        id: 'criticality',
        label: 'Business criticality',
        control: 'select',
        required: true,
        options: [
          { value: 'tier0', label: 'Tier 0 – mission critical (customer / revenue)' },
          { value: 'tier1', label: 'Tier 1 – important internal' },
          { value: 'tier2', label: 'Tier 2/3 – supporting / batch' },
        ],
      },
      {
        kind: 'field',
        id: 'uptimeTarget',
        label: 'Uptime target',
        control: 'select',
        options: [
          { value: '99.0', label: '~99.0% (occasional outages tolerated)' },
          { value: '99.5', label: '~99.5%' },
          { value: '99.9', label: '~99.9%' },
          { value: '99.95', label: '99.95%+' },
        ],
      },
      {
        kind: 'field',
        id: 'rto',
        label: 'RTO (Recovery Time Objective)',
        control: 'select',
        options: [
          { value: 'mins', label: 'Minutes' },
          { value: 'hour', label: 'Around 1 hour' },
          { value: 'few-hours', label: 'Few hours' },
          { value: 'day-plus', label: '1 day or more' },
        ],
      },
      {
        kind: 'field',
        id: 'rpo',
        label: 'RPO (Recovery Point Objective)',
        control: 'select',
        options: [
          { value: 'zero', label: 'Near zero data loss' },
          { value: '15min', label: 'Around 15 minutes' },
          { value: 'hour', label: 'Around 1 hour' },
          { value: 'day', label: 'Up to 1 day' },
        ],
      },
      {
        kind: 'field',
        id: 'timeToMarket',
        label: 'Time-to-market pressure',
        control: 'select',
        hint: 'Managed PaaS / serverless often wins when time is tight.',
        options: [
          { value: 'urgent', label: 'Urgent – weeks' },
          { value: 'normal', label: 'Normal – few months' },
          { value: 'long', label: 'Longer-term – 6+ months' },
        ],
      },
      {
        kind: 'field',
        id: 'opsMaturity',
        label: 'Ops / SRE maturity',
        control: 'select',
        options: [
          { value: 'basic', label: 'Basic – no real 24/7 ops' },
          { value: 'intermediate', label: 'Intermediate – some on-call / runbooks' },
          { value: 'advanced', label: 'Advanced – SRE / strong automation' },
        ],
      },
      {
        kind: 'field',
        id: 'iaCTools',
        label: 'IaC / automation tooling',
        control: 'select',
        hint: 'Pick the primary IaC / automation tool; if you use several, pick the most important one.',
        options: [
          { value: 'terraform', label: 'Terraform' },
          { value: 'ansible', label: 'Ansible' },
          { value: 'cloud-native', label: 'Cloud-native (ARM/Bicep, CloudFormation/CDK, Deployment Manager, OCI Resource Manager)' },
          { value: 'jenkins-ado-gha', label: 'CI/CD (Jenkins / Azure DevOps / GitHub Actions / CodePipeline / Cloud Build)' },
        ],
      },
      {
        kind: 'field',
        id: 'securityBaseline',
        label: 'Security baseline / hardening',
        control: 'select',
        hint: 'Influences how opinionated the security and controls guidance is (CIS, STIG, etc.).',
        options: [
          { value: 'standard', label: 'Standard enterprise baseline (CIS / internal baseline)' },
          { value: 'regulated', label: 'Strict regulated (PCI / PHI / SOX etc.)' },
          { value: 'stig', label: 'DoD / STIG-aligned baseline' },
          { value: 'minimal', label: 'Minimal baseline / best-effort hardening' },
        ],
      },
      {
        kind: 'field',
        id: 'identityModel',
        label: 'Identity & access model',
        control: 'select',
        hint: 'Used to steer identity, SSO, and least-privilege access guidance.',
        options: [
          { value: 'cloud-iam-only', label: 'Cloud-native IAM only' },
          { value: 'hybrid-ad-entra', label: 'Hybrid AD / Entra / on-prem IdP' },
          { value: 'external-idp-plus-iam', label: 'External IdP (Okta / Ping etc.) + cloud IAM' },
        ],
      },
      {
        kind: 'field',
        id: 'secretsModel',
        label: 'Secrets & keys',
        control: 'select',
        hint: 'Covers where app secrets and keys live and how strongly they are protected.',
        options: [
          { value: 'basic', label: 'Basic secrets in config / parameter store' },
          { value: 'secrets-manager', label: 'Cloud-native secrets manager' },
          { value: 'hsm-backed', label: 'HSM-backed keys / dedicated KMS' },
        ],
      },
      {
        kind: 'field',
        id: 'dataProtection',
        label: 'Data protection level',
        control: 'select',
        hint: 'Helps tune recommendations for TLS, tokenization, anonymization, and privacy controls.',
        options: [
          { value: 'at-rest', label: 'At-rest encryption only' },
          { value: 'in-transit-and-at-rest', label: 'In-transit + at-rest (TLS everywhere)' },
          { value: 'field-level', label: 'Field-level / tokenization / anonymization' },
        ],
      },
      {
        kind: 'field',
        id: 'perimeterPattern',
        label: 'Perimeter & firewall pattern',
        control: 'select',
        hint: 'Helps shape guidance across cloud-native firewalls, WAF, and F5 services.',
        options: [
          { value: 'cloud-fw-only', label: 'Cloud-native firewall / WAF only' },
          { value: 'cloud-plus-f5', label: 'Cloud-native + F5 (ADC / WAF)' },
          { value: 'f5-centric', label: 'F5-centric perimeter (BIG-IP / NGINX / XC)' },
          { value: 'legacy-fw', label: 'Legacy on-prem firewall in the path' },
        ],
      },
      {
        kind: 'field',
        id: 'f5Usage',
        label: 'F5 usage focus',
        control: 'checkboxes',
        hint: 'Choose how you expect to use F5 capabilities for this workload (edge WAAP, API security, DDoS, etc.).',
        options: [
          { value: 'waap-web', label: 'WAAP / WAF for web apps' },
          { value: 'api-security', label: 'API security / API gateway' },
          { value: 'ddos', label: 'DDoS protection' },
          { value: 'gslb', label: 'GSLB / global traffic management' },
          { value: 'service-mesh', label: 'Service mesh / east-west L7' },
          { value: 'remote-access', label: 'Remote access / ZTNA / VPN replacement' },
        ],
      },
      {
        kind: 'field',
        id: 'secOpsMaturity',
        label: 'Security operations & monitoring',
        control: 'select',
        hint: 'Used to tailor recommendations for SIEM/SOC, F5 telemetry, and DevSecOps practices.',
        options: [
          { value: 'basic', label: 'Basic logging only' },
          { value: 'central-siem', label: 'Central SIEM/SOC, alerts triaged' },
          { value: 'mature-devsecops', label: 'Mature SecOps & DevSecOps (SOAR, shift-left, continuous testing)' },
        ],
      },
    ],
  },
  {
    number: 5,
    showFor: ['migration', 'new-service'],
    title: 'Design: sizing & environments',
    subtitle: 'Traffic band, data volume, environments in scope and regions for this workload',
    hint: 'Capture sizing bands and environments before generating the playbook.',
    items: [
      { kind: 'heading', text: 'Sizing & environments' },
      {
        kind: 'field',
        id: 'peakUsers',
        label: 'Peak concurrent users',
        control: 'number',
        hint: 'Ballpark only – just enough to drive T-shirt sizing.',
        placeholder: 'e.g. 5000',
      },
      {
        kind: 'field',
        id: 'peakRps',
        label: 'Peak requests per second',
        control: 'number',
        hint: 'API / web calls at peak period. Leave blank if unknown.',
        placeholder: 'e.g. 200',
      },
      {
        kind: 'field',
        id: 'dataVolumeBand',
        label: 'Total data volume (band)',
        control: 'select',
        options: [
          { value: 'xs', label: 'XS – < 100 GB' },
          { value: 's', label: 'S – 100 GB – 1 TB' },
          { value: 'm', label: 'M – 1 TB – 5 TB' },
          { value: 'l', label: 'L – 5 TB – 20 TB' },
          { value: 'xl', label: 'XL – 20 TB+' },
        ],
      },
      {
        kind: 'field',
        id: 'dailyIngestBand',
        label: 'Daily ingest / change volume',
        control: 'select',
        options: [
          { value: 'light', label: 'Light – < 10 GB/day' },
          { value: 'medium', label: 'Medium – 10–100 GB/day' },
          { value: 'heavy', label: 'Heavy – 100 GB–1 TB/day' },
          { value: 'very-heavy', label: 'Very heavy – 1 TB+/day' },
        ],
      },
      {
        kind: 'field',
        id: 'retentionPeriod',
        label: 'Data retention target',
        control: 'select',
        options: [
          { value: 'short', label: 'Short – < 3 months' },
          { value: 'standard', label: 'Standard – 3–24 months' },
          { value: 'long', label: 'Long – 2–7 years' },
          { value: 'very-long', label: 'Very long / archival – 7+ years' },
        ],
      },
      {
        kind: 'field',
        id: 'envScope',
        label: 'Environments in scope',
        control: 'checkboxes',
        hint: 'Tick the environments you actually plan to stand up.',
        options: [
          { value: 'dev', label: 'Dev' },
          { value: 'test', label: 'Test' },
          { value: 'stage', label: 'Pre-prod / Stage' },
          { value: 'prod', label: 'Prod' },
          { value: 'dr', label: 'DR' },
        ],
      },
      {
        kind: 'field',
        id: 'nonProdScale',
        label: 'Non-prod scale vs prod',
        control: 'select',
        hint: 'Used to size dev / test / stage relative to production.',
        options: [
          { value: 'full', label: 'Roughly same as prod' },
          { value: 'half', label: '~50% of prod' },
          { value: 'quarter', label: '~25% of prod' },
          { value: 'minimal', label: 'Small / shared sandboxes' },
        ],
      },
      {
        kind: 'field',
        id: 'regionCount',
        label: 'Regions / sovereign sites',
        control: 'select',
        options: [
          { value: '1', label: 'Single region' },
          { value: '1-ha', label: 'Single region, multi-AZ / zone' },
          { value: '2', label: 'Two regions (active/passive)' },
          { value: '2-active', label: 'Two regions (active/active)' },
          { value: '3plus', label: 'Three+ regions / global' },
        ],
      },
    ],
  },
  {
    number: 6,
    showFor: ['migration', 'new-service'],
    title: 'Foundation: landing zone & connectivity',
    subtitle: 'The landing zone (built by the first app on the cloud, reused by the next), the link back to the data centre, and the connectors to the applications it depends on',
    hint: 'Choose the data-centre link and how cross-cloud dependencies connect.',
    items: [
      {
        kind: 'field',
        id: 'onPremLink',
        label: 'Link to the data centre',
        control: 'select',
        hint: 'ExpressRoute / Direct Connect / Cloud Interconnect / FastConnect, with a site-to-site VPN as backup, or a VPN alone. On VCF: the NSX Tier-0 gateway (BGP) or NSX IPsec VPN, and HCX for the move.',
        options: [
          { value: 'circuit-vpn', label: 'Private circuit with a VPN backup' },
          { value: 'circuit', label: 'Private circuit only' },
          { value: 'vpn', label: 'Site-to-site VPN only' },
          { value: 'none', label: 'None (no data-centre dependency)' },
        ],
      },
      {
        kind: 'field',
        id: 'crossCloud',
        label: 'Connectors to other clouds',
        control: 'select',
        hint: 'For a dependency on an application placed on another cloud: the clouds’ own interconnect where one exists, else a site-to-site VPN.',
        options: [
          { value: 'interconnect', label: 'Cloud-to-cloud interconnect where one exists' },
          { value: 'vpn', label: 'Site-to-site VPN between the clouds' },
          { value: 'via-dc', label: 'Through the data centre (no direct link)' },
        ],
      },
      {
        kind: 'field',
        id: 'linkBandwidth',
        label: 'Link bandwidth',
        control: 'select',
        hint: 'Per connector. Interconnects are ordered in these sizes; a VPN tunnel carries about 1.25 Gbps (AWS) to 3 Gbps (Google Cloud HA VPN).',
        options: [
          { value: '1g', label: '1 Gbps' },
          { value: '2g', label: '2 Gbps' },
          { value: '5g', label: '5 Gbps' },
          { value: '10g', label: '10 Gbps' },
          { value: '50g', label: '50 Gbps' },
          { value: '100g', label: '100 Gbps' },
        ],
      },
    ],
  },
  {
    number: 7,
    showFor: ['migration', 'new-service'],
    title: 'Build: Terraform, Ansible & pipeline',
    subtitle: 'The playbook, what gets built, and the Terraform and Ansible for this application',
    hint: 'Review the recommendation, then generate the stack.',
    items: [],
  },
  {
    number: 11,
    title: 'Replicate & test',
    showFor: ['migration'],
    subtitle: 'Start replication per server and database, then the test run on the target',
    hint: 'Replicate, test, fix, mark ready.',
    items: [],
  },
  {
    number: 12,
    title: 'Cutover & rollback',
    showFor: ['migration'],
    subtitle: 'Go / no-go, the final sync, the switch of DNS and load balancers, and the way back',
    hint: 'Cut over in the window; keep the rollback ready.',
    items: [],
  },
  {
    number: 13,
    title: 'Hypercare & decommission',
    showFor: ['migration'],
    subtitle: 'Support after the move, hand over to operations, then retire the source',
    hint: 'Stabilise, hand over, decommission.',
    items: [],
  },
  {
    number: 14,
    title: 'Deploy & smoke test',
    showFor: ['new-service'],
    subtitle: 'Apply the stack through the pipeline and check the service answers',
    hint: 'Deploy, then run the smoke checks.',
    items: [],
  },
  {
    number: 15,
    title: 'Hand over',
    showFor: ['new-service'],
    subtitle: 'Operations, monitoring and ownership of the new service',
    hint: 'Hand the service over to operations.',
    items: [],
  },
  {
    number: 16,
    title: 'Apply the change, with rollback',
    showFor: ['existing-service', 'maintenance'],
    subtitle: 'The change goes into the stack that manages the service: a change bundle from the Utilities catalogue',
    hint: 'Generate the change bundle in Utilities, apply it, keep rollback.sh.',
    items: [],
  },
  {
    number: 17,
    title: 'Record it',
    showFor: ['existing-service', 'maintenance'],
    subtitle: 'The change request and the utility log',
    hint: 'Record the change request number and the result.',
    items: [],
  },
];

/** The clouds the wizard can design for. */
export const WIZARD_CLOUDS                          = [
  { value: 'azure', label: 'Microsoft Azure' },
  { value: 'aws', label: 'Amazon Web Services (AWS)' },
  { value: 'gcp', label: 'Google Cloud Platform (GCP)' },
  { value: 'oci', label: 'Oracle Cloud Infrastructure (OCI)' },
  { value: 'vcf', label: 'VMware Cloud Foundation (VCF 9.1)' },
];

/** The provider name the recommendation card is headed with ("Microsoft recommendation"), and its badge. */
export const WIZARD_PROVIDER                                   = {
  azure: 'Microsoft',
  aws: 'Amazon',
  gcp: 'Google',
  oci: 'Oracle',
  vcf: 'VMware Cloud Foundation',
};

/** Cloud id as the rest of the toolkit spells it (the plan's `Platform`, the shared target). */
export const WIZARD_CLOUD_TO_TARGET                                   = {
  azure: 'azure',
  aws: 'aws',
  gcp: 'google',
  oci: 'oci',
  vcf: 'vmware',
};

/** The wizard's cloud id for a toolkit platform id. */
export function wizardCloudOf(platform        )         {
  return Object.entries(WIZARD_CLOUD_TO_TARGET).find(([, p]) => p === platform)?.[0] ?? 'azure';
}

export function isField(item            )                      {
  return item.kind === 'field';
}

/** Every question in the wizard, in order. */
export function allFields()                         {
  const out                = [];
  for (const step of WIZARD_STEPS) {
    out.push(...step.items.filter(isField));
    for (const group of step.groups ?? []) out.push(...group.items.filter(isField));
  }
  return out;
}

/** The steps asked for an initiative type, in order (every step when none is chosen yet, except the alternatives to the migration's source step). */
export function stepsFor(initiative        )                        {
  const kind = initiative || 'migration';
  return WIZARD_STEPS.filter((s) => !s.showFor || s.showFor.includes(kind));
}
