/**
 * The step-by-step plan for moving one application.
 *
 * Nine steps that every migration has, with the bullets under each one written
 * in the chosen cloud's own nouns, plus an addendum for the route. Regulated
 * data changes what the landing-zone, network and stabilisation steps say,
 * because it changes what has to be true before anything moves.
 *
 * Ported from the previous toolkit's playbook provider.
 */

                                          
                                        

                                                               

const PROVIDER_BULLETS                                                                          = {
  aws: {
    landing: ['Control Tower / Organizations', 'IAM Identity Center', 'CloudTrail + Config', 'GuardDuty (baseline)'],
    images: ['AMI pipeline (EC2 Image Builder)', 'SSM Patch Manager', 'Inspector baseline'],
    data: ['DMS (database)', 'DataSync (file)', 'Snowball (bulk)'],
    net: ['VPC, subnets, route tables', 'Security groups + NACLs', 'PrivateLink where needed'],
    ops: ['CloudWatch alarms and dashboards', 'AWS Backup', 'DR: pilot light or warm standby'],
  },
  azure: {
    landing: ['Azure landing zone', 'Management groups', 'Azure Policy baseline', 'Entra ID + Log Analytics / Sentinel'],
    images: ['Azure Image Builder', 'Update Manager', 'Defender for Cloud baseline'],
    data: ['Database Migration Service', 'AzCopy / Data Factory', 'Azure File Sync (file)'],
    net: ['VNet and subnets', 'NSGs + user-defined routes', 'Private endpoints where needed'],
    ops: ['Azure Monitor alerts', 'Azure Backup', 'Site Recovery where applicable'],
  },
  gcp: {
    landing: ['Organisation, folders and projects', 'IAM baseline', 'Cloud Logging', 'Security Command Center; VPC-SC if needed'],
    images: ['Image families', 'OS Config', 'Patch management policy'],
    data: ['Database Migration Service', 'Storage Transfer Service', 'Transfer Appliance (bulk)'],
    net: ['VPC and subnets', 'Firewall rules', 'Cloud NAT; Private Service Connect where needed'],
    ops: ['Cloud Monitoring alerts', 'Backup strategy', 'Multi-zone or regional DR patterns'],
  },
  oci: {
    landing: ['Compartments', 'IAM baseline', 'Logging', 'Cloud Guard'],
    images: ['Custom images', 'OS Management Service', 'Vulnerability scanning'],
    data: ['OCI Database Migration', 'Object Storage bulk transfer', 'Data Transfer Appliance'],
    net: ['VCN and subnets', 'NSGs and security lists', 'Service gateway where needed'],
    ops: ['Monitoring and alarms', 'Backups', 'Multi-AD or multi-region DR patterns'],
  },
};

const ADDENDUM                                                                        = {
  Refactor: {
    title: 'Modernisation addendum (Refactor).',
    bullets: [
      'Strangler pattern: carve out domains, define API contracts, iterate safely',
      'Adopt containers or a managed platform; build CI/CD with automated tests and gates',
      'Eventing and integration: queues, topics, event bus; retries and idempotency',
    ],
  },
  Replatform: {
    title: 'Platform addendum (Replatform).',
    bullets: ['Move to managed database, queue and cache where possible', 'Standardise observability: logs, metrics, traces; define SLOs'],
  },
  Rehost: {
    title: 'Lift-and-shift addendum (Rehost).',
    bullets: ['Prioritise speed: replicate the VMs, keep the OS and application stack at first', 'Plan the hardening afterwards: patching, right-sizing, managed services later'],
  },
};

/** Plans for the routes that do not move the application anywhere. */
const STANDING                                            = {
  Repurchase: [
    '1) Validate the SaaS fit: features, roadmap, integrations, compliance.',
    '2) Contracting and security review: SOC 2 or SSP, data residency, SLAs.',
    '3) Data migration plan: export, mapping, import, validation.',
    '4) Identity integration: SSO, MFA, role mapping.',
    '5) Phased rollout: pilot, training, change management.',
    '6) Decommission the legacy application: archive, legal hold, terminate licences.',
  ],
  Retain: [
    '1) Write down the blockers: hardware, latency, policy, vendor constraints.',
    '2) Stabilise and reduce risk: patching, monitoring, backup and DR.',
    '3) Build a modernisation backlog: remove coupling, improve modularity.',
    '4) Reassess on a fixed cadence, quarterly or twice a year.',
  ],
  Retire: [
    '1) Confirm the decommission approval and the stakeholder sign-off.',
    '2) Review retention and legal hold against the records schedule.',
    '3) Archive or export the data: immutable storage, checksums verified.',
    '4) Turn the service down in stages: disable writes, then reads.',
    '5) Remove the infrastructure and close the contracts and licences.',
    '6) Update the CMDB, the diagrams and the runbooks.',
  ],
};

/**
 * The plan, as lines. A line starting with spaces and a bullet belongs to the
 * step above it, which is how the page renders and how it copies into a
 * document.
 */
export function playbookFor(route       , cloud       , regulated         )           {
  const standing = STANDING[route];
  if (standing) return [...standing];

  const bullets = PROVIDER_BULLETS[cloud];
  const steps           = [];
  const add = (title        , lines                            ) => {
    steps.push(title);
    for (const line of lines) if (line) steps.push(`   • ${line}`);
  };

  add('1) Inventory and dependency map: applications, ports, DNS, directory, certificates, integrations.', [
    'Confirm the workload context: users, peak windows, batch schedules',
    'Map the dependencies: ports, DNS, certificates, service accounts, integrations',
    'Capture what it needs to run: OS baseline, middleware, runtime versions, agents',
  ]);

  add('2) Landing zone alignment: networking, identity, logging, guardrails.', [
    regulated
      ? 'Turn the regulated guardrails on first: central logging, tight egress, strong identity, evidence retention'
      : 'Establish the accounts or subscriptions, the identity baseline, logging and guardrails',
    ...bullets.landing,
  ]);

  add('3) Image and VM strategy: gold images, hardened baselines, patch posture.', [...bullets.images, 'Hardened baseline aligned to STIG or CIS where applicable']);

  add('4) Data migration approach: block, file or object; replication; cutover.', [
    'Choose the replication: online, offline or a mix',
    'Define the cutover: freeze window, final sync, verification, rollback criteria',
    ...bullets.data,
  ]);

  add('5) Build the target environment: subnets, security groups, routing.', [
    ...bullets.net,
    regulated ? 'Prefer private connectivity (Direct Connect, ExpressRoute, Interconnect, FastConnect) and keep public endpoints to a minimum' : null,
  ]);

  add('6) Rehearse the migration: pilot, performance baseline, rollback.', [
    'Pilot first, on something non-production or low risk',
    'Record the baselines: latency, throughput, job duration, error rates',
    'Prove the rollback: snapshots, backups, DNS revert, traffic shift reversal',
  ]);

  add('7) Cut over: freeze, final sync, switch DNS, validate.', [
    'Run the runbook: freeze, final sync, promote the primary, switch the endpoints',
    'Smoke tests and business validation; confirm the monitoring and alerts',
  ]);

  add('8) Stabilise: monitoring, backups, DR, incident runbooks.', [
    ...bullets.ops,
    regulated ? 'Centralise the logs and retain them to policy; write the incident runbooks and how evidence is collected' : null,
  ]);

  add('9) Decommission on-premises: licences, contracts, CMDB.', [
    'Check retention and legal holds before anything is shut down',
    'Update the CMDB, contracts and monitoring; reclaim the addresses and DNS records',
  ]);

  const extra = ADDENDUM[route];
  if (extra) add(extra.title, extra.bullets);

  return steps;
}
