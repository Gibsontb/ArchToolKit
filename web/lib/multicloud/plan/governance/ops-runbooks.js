/**
 * People, process and the target runbooks (addendum A.10.19), and the
 * hypercare, decommission, day-2 and governance checklists (research 6(b)
 * P7, P8, P9 and G; 6(e) 17–19).
 *
 *  - Operational runbook per app (`runbooks/ops/<app>.md`): start / stop order
 *    (a topological sort of the app's internal edges), logs and dashboards,
 *    backup and restore per platform, DR failover per the tier's pattern,
 *    scaling, patching, contacts (the RACI run roles).
 *  - Training plan: per platform in use, the skill gap from
 *    `requirements.skills`, with the vendor's learning portal per RACI role
 *    that runs something there.
 *  - SLA restatement: the app's required availability against a composite
 *    target SLA (the product of its serial components' provider SLAs, from a
 *    sourced table — every entry marked verify — with user overrides).
 *  - The checklists, with each provider's coverage from the research's master
 *    checklist, and the provider's own word for the phase.
 */

import { warning,              } from '../../../core/findings.js';
import { PLATFORM_INFO } from '../../platforms.js';
import { DR_PATTERNS } from '../controls.js';
import { providerTerm } from '../methodology.js';
                                                                                                                            
import { appScope } from './complexity.js';
import { raciRoleLabel, runRoles } from './raci.js';
import { fileSlug } from './signoffs.js';

// ---------------------------------------------------------------------------
// Start / stop order
// ---------------------------------------------------------------------------

const ROLE_RANK                                             = {
  'ad-dc': 0, 'dns-dhcp': 0, db: 1, file: 1, messaging: 2, middleware: 2, batch: 3, app: 3, web: 4, 'rds-vdi': 4,
  monitoring: 5, backup: 5, jump: 5, appliance: 1, other: 3,
};

/**
 * The start order: what a server depends on starts first. Only edges inside
 * the app count. A cycle is broken by role (directory and databases first) and
 * reported.
 */
export function startOrder(plan                                   , app        )                                           {
  const ws = plan.workloads.filter((w) => w.app === app);
  const names = new Set(ws.map((w) => w.name));
  const deps = new Map                     (ws.map((w) => [w.name, new Set        ()]));
  for (const w of ws) for (const d of w.dependsOn) if (names.has(d) && d !== w.name) deps.get(w.name) .add(d);
  for (const e of plan.edges) if (names.has(e.from) && names.has(e.to) && e.from !== e.to) deps.get(e.from) .add(e.to);
  const rank = (n        ) => ROLE_RANK[ws.find((w) => w.name === n) .role] ?? 3;
  const byRank = (a        , b        ) => rank(a) - rank(b) || a.localeCompare(b);
  const order           = [];
  const findings            = [];
  const left = new Set(names);
  while (left.size > 0) {
    const ready = [...left].filter((n) => [...deps.get(n) ].every((d) => !left.has(d))).sort(byRank);
    if (ready.length === 0) {
      const next = [...left].sort(byRank)[0] ;
      findings.push(warning('ops.start-order-cycle', `${app}: the dependencies between ${[...left].sort().join(', ')} form a cycle; ${next} is started first by role.`));
      order.push(next);
      left.delete(next);
      continue;
    }
    for (const n of ready) {
      order.push(n);
      left.delete(n);
    }
  }
  return { order, findings };
}

// ---------------------------------------------------------------------------
// Per-platform operations text
// ---------------------------------------------------------------------------

export const OPS_BY_PLATFORM                             
                                                                                                                                                     
    = Object.freeze({
  aws: {
    logs: 'Amazon CloudWatch Logs (the landing zone\'s log group; CloudTrail for API activity)',
    dashboard: 'Amazon CloudWatch dashboard `<prefix>-<app>` (from `<p>_app_monitoring`)',
    backup: ['aws backup start-backup-job --backup-vault-name <vault> --resource-arn <resource-arn> --iam-role-arn <role-arn>'],
    restore: ['aws backup list-recovery-points-by-resource --resource-arn <resource-arn>', 'aws backup start-restore-job --recovery-point-arn <recovery-point-arn> --iam-role-arn <role-arn> --metadata file://restore-metadata.json'],
    patch: 'AWS Systems Manager Patch Manager (patch baseline and maintenance window per environment)',
  },
  azure: {
    logs: 'Azure Monitor Logs (the landing zone\'s Log Analytics workspace; Activity log for control-plane changes)',
    dashboard: 'Azure portal dashboard `<prefix>-<app>` and Azure Monitor workbooks',
    backup: ['az backup protection backup-now --resource-group <rg> --vault-name <vault> --container-name <vm> --item-name <vm> --backup-management-type AzureIaasVM'],
    restore: ['az backup recoverypoint list --resource-group <rg> --vault-name <vault> --container-name <vm> --item-name <vm> --backup-management-type AzureIaasVM', 'az backup restore restore-disks --resource-group <rg> --vault-name <vault> --container-name <vm> --item-name <vm> --rp-name <recovery-point> --storage-account <account>'],
    patch: 'Azure Update Manager (maintenance configurations per environment)',
  },
  google: {
    logs: 'Cloud Logging (the landing zone\'s log bucket / sink; Cloud Audit Logs for API activity)',
    dashboard: 'Cloud Monitoring dashboard `<prefix>-<app>`',
    backup: ['gcloud compute snapshots create <snapshot> --source-disk <disk> --source-disk-zone <zone>', '(or the Backup and DR Service backup plan the landing zone assigns)'],
    restore: ['gcloud compute disks create <new-disk> --source-snapshot <snapshot> --zone <zone>', 'then attach the disk, or recreate the instance from it'],
    patch: 'VM Manager OS patch management (patch deployments per environment)',
  },
  oci: {
    logs: 'OCI Logging (the landing zone\'s log group; the Audit service for API activity)',
    dashboard: 'OCI Monitoring alarms and a Logging saved search `<prefix>-<app>`',
    backup: ['oci bv boot-volume-backup create --boot-volume-id <boot-volume-ocid>', 'oci bv backup create --volume-id <volume-ocid>'],
    restore: ['oci bv boot-volume create --boot-volume-backup-id <backup-ocid> --availability-domain <ad> (verify the flags on your CLI version)', 'oci bv volume create --volume-backup-id <backup-ocid> --availability-domain <ad>'],
    patch: 'OCI OS Management Hub (profiles and scheduled jobs per environment)',
  },
  vmware: {
    logs: 'VCF Operations for logs',
    dashboard: 'VCF Operations dashboard for the app\'s VMs',
    backup: ['Your backup product\'s job for the VMs (the plan\'s backup tier sets frequency and retention)'],
    restore: ['Restore from the backup product to the original or an alternate location; then the app\'s start order below'],
    patch: 'Guest patching through the generated Ansible patch playbooks; hosts through VCF lifecycle management',
  },
});

/** The first platform an app's items were decided onto; vmware when undecided. */
export function appPlatform(plan      , app        , appPlan          )           {
  if (appPlan?.platform) return appPlan.platform;
  const scope = appScope(plan, app);
  for (const i of [...scope.workloads, ...scope.databases]) {
    const p = plan.decision?.items[i.id]?.chosen?.platform;
    if (p) return p;
  }
  return 'vmware';
}

/** `runbooks/ops/<app>.md`. */
export function opsRunbook(plan      , app        , raci                    , options                                                                 = {})                                            {
  const scope = appScope(plan, app);
  const platform = appPlatform(plan, app, options.appPlan);
  const ops = OPS_BY_PLATFORM[platform];
  const crit              = scope.app?.criticality ?? 'tier2';
  const dr = DR_PATTERNS[plan.requirements.drPattern[crit]];
  const { order, findings } = startOrder(plan, app);
  const prefix = options.design?.platforms.find((p) => p.platform === platform)?.prefix ?? '<prefix>';
  const fill = (t        ) => t.replace(/<prefix>/g, prefix).replace(/<app>/g, fileSlug(app));
  const contacts = runRoles(raci, platform);
  const lines = [
    `# Operations runbook: ${app}`, '',
    `Platform: ${PLATFORM_INFO[platform].label}. Criticality: ${crit}. Recovery targets: RPO ${scope.app?.rpo ?? '—'}, RTO ${scope.app?.rto ?? '—'}.`, '',
    '## Start and stop order', '',
    'Start in this order (each waits for the ones before it); stop in reverse.', '',
    ...order.map((n, i) => `${i + 1}. ${n}`), ...(order.length === 0 ? ['(no servers)'] : []), '',
    ...(scope.databases.length ? ['Databases: ' + scope.databases.map((d) => `${d.name} (${d.engine}) on ${d.hosts.join(', ') || 'a managed service'}`).join('; '), ''] : []),
    '## Logs and dashboards', '', `- Logs: ${fill(ops.logs)}`, `- Dashboard: ${fill(ops.dashboard)}`, '',
    '## Backup and restore', '', `Backup tier: ${scope.workloads[0] ? (options.design?.platforms.flatMap((p) => p.compute).find((c) => c.workload === scope.workloads[0] .id)?.backupTier ?? 'per the plan') : 'per the plan'}.`, '',
    'On-demand backup:', '', '```', ...ops.backup, '```', '', 'Restore:', '', '```', ...ops.restore, '```', '',
    'Test a restore at least once per quarter and record it (Backup and restore tests in the RACI).', '',
    '## Disaster recovery', '', `Pattern: ${dr.label} — ${dr.summary}`, '', `${dr.perPlatform[platform]}`, '', `Suits: ${dr.suits}`, '',
    '## Scaling', '', 'Resize, add capacity or change a tier through the Utilities area of Multi-Cloud Migration & Utilities (`#utilities`); each utility produces a change bundle with its own rollback.', '',
    '## Patching', '', `${ops.patch}. Patch non-production first; production in its change window${scope.app?.changeWindow ? ` (${scope.app.changeWindow})` : ''}.`, '',
    '## Contacts (roles)', '', ...(contacts.length ? contacts.map((r) => `- ${raciRoleLabel(r)}`) : ['- (no run roles in the RACI for this platform)']), '',
  ];
  return { markdown: lines.join('\n'), findings };
}

// ---------------------------------------------------------------------------
// Training plan
// ---------------------------------------------------------------------------

export const LEARNING_PORTALS                                                                                                                   = Object.freeze({
  aws: { name: 'AWS Skill Builder', url: 'https://skillbuilder.aws/', verification: 'I' },
  azure: { name: 'Microsoft Learn training', url: 'https://learn.microsoft.com/training/', verification: 'I' },
  google: { name: 'Google Cloud Skills Boost', url: 'https://www.cloudskillsboost.google/', verification: 'I' },
  oci: { name: 'Oracle MyLearn', url: 'https://mylearn.oracle.com/', verification: 'I' },
  vmware: { name: 'Broadcom VMware education', url: 'https://www.broadcom.com/support/education/vmware', verification: 'I' },
});

                                                                                                                                                                                             

export function trainingPlan(plan      , raci                    )                                            {
  const platforms = [...(plan.decision?.platforms ?? plan.requirements.allowed)];
  const rows = platforms.map((p)              => {
    const skill = plan.requirements.skills[p] ?? 'none';
    return { platform: p, skill, gap: skill !== 'strong', roles: runRoles(raci, p).map(raciRoleLabel), portal: LEARNING_PORTALS[p].name, url: LEARNING_PORTALS[p].url };
  });
  const md = [
    '# Training plan', '',
    'Per platform in use: the team\'s skill (from the requirements), and the roles that run something there. Portal links are vendor training home pages (verify the current URL).', '',
    '| Platform | Skill | Gap | Roles with run activities | Learning portal |', '|---|---|---|---|---|',
    ...rows.map((r) => `| ${PLATFORM_INFO[r.platform].label} | ${r.skill} | ${r.gap ? 'yes' : 'no'} | ${r.roles.join(', ') || '—'} | [${r.portal}](${r.url}) |`), '',
  ].join('\n');
  return { rows, markdown: md };
}

// ---------------------------------------------------------------------------
// SLA restatement
// ---------------------------------------------------------------------------

                                                                                                                                                                                                                     

/**
 * Provider SLA percentages used for the composite. Every entry is marked
 * verify: SLAs change, and the figure that applies depends on the deployment
 * (single instance, zones, tier). Users override per component.
 */
export const SERVICE_SLAS                        = Object.freeze([
  { id: 'aws-ec2-single', platform: 'aws', service: 'EC2 instance (single)', pct: 99.5, source: 'https://aws.amazon.com/compute/sla/', verification: 'I', verify: true },
  { id: 'aws-ec2-multi-az', platform: 'aws', service: 'EC2 across two or more AZs', pct: 99.99, source: 'https://aws.amazon.com/compute/sla/', verification: 'I', verify: true },
  { id: 'aws-rds-multi-az', platform: 'aws', service: 'RDS Multi-AZ', pct: 99.95, source: 'https://aws.amazon.com/rds/sla/', verification: 'I', verify: true },
  { id: 'aws-rds-single', platform: 'aws', service: 'RDS Single-AZ', pct: 99.5, source: 'https://aws.amazon.com/rds/sla/', verification: 'I', verify: true },
  { id: 'aws-elb', platform: 'aws', service: 'Elastic Load Balancing', pct: 99.99, source: 'https://aws.amazon.com/elasticloadbalancing/sla/', verification: 'I', verify: true },
  { id: 'azure-vm-single', platform: 'azure', service: 'Virtual machine (single, premium SSD)', pct: 99.9, source: 'https://www.microsoft.com/licensing/docs/view/Service-Level-Agreements-SLA-for-Online-Services', verification: 'I', verify: true },
  { id: 'azure-vm-zones', platform: 'azure', service: 'Virtual machines across availability zones', pct: 99.99, source: 'https://www.microsoft.com/licensing/docs/view/Service-Level-Agreements-SLA-for-Online-Services', verification: 'I', verify: true },
  { id: 'azure-sql-db', platform: 'azure', service: 'Azure SQL Database', pct: 99.99, source: 'https://www.microsoft.com/licensing/docs/view/Service-Level-Agreements-SLA-for-Online-Services', verification: 'I', verify: true },
  { id: 'azure-lb', platform: 'azure', service: 'Load Balancer (Standard)', pct: 99.99, source: 'https://www.microsoft.com/licensing/docs/view/Service-Level-Agreements-SLA-for-Online-Services', verification: 'I', verify: true },
  { id: 'google-gce-single', platform: 'google', service: 'Compute Engine instance (single)', pct: 99.9, source: 'https://cloud.google.com/compute/sla', verification: 'I', verify: true },
  { id: 'google-gce-multi-zone', platform: 'google', service: 'Compute Engine across zones', pct: 99.99, source: 'https://cloud.google.com/compute/sla', verification: 'I', verify: true },
  { id: 'google-cloudsql', platform: 'google', service: 'Cloud SQL (HA)', pct: 99.95, source: 'https://cloud.google.com/sql/sla', verification: 'I', verify: true },
  { id: 'google-lb', platform: 'google', service: 'Cloud Load Balancing', pct: 99.99, source: 'https://cloud.google.com/load-balancing/sla', verification: 'I', verify: true },
  { id: 'oci-compute', platform: 'oci', service: 'Compute instance', pct: 99.95, source: 'https://www.oracle.com/cloud/sla/', verification: 'I', verify: true },
  { id: 'oci-db', platform: 'oci', service: 'Autonomous Database / Base Database', pct: 99.95, source: 'https://www.oracle.com/cloud/sla/', verification: 'I', verify: true },
  { id: 'oci-lb', platform: 'oci', service: 'Load Balancer', pct: 99.95, source: 'https://www.oracle.com/cloud/sla/', verification: 'I', verify: true },
]);
const SLA = new Map(SERVICE_SLAS.map((s) => [s.id, s]));

/** When the app states none: the criticality's default target (an assumption, shown as one). */
export const DEFAULT_AVAILABILITY                                        = Object.freeze({ tier0: 99.99, tier1: 99.95, tier2: 99.9, tier3: 99.5 });

                                                                                                                                    
                                 
                       
                              
                            
                                                        
                                               
                                                                                                                     
                              
                           
                        
                        
                             
                                        
 

function slaIdsFor(platform          , multi         , managedDb         , lb         )                                 {
  const out                                 = [];
  const pick = (a        , b        ) => (multi ? a : b);
  if (platform === 'aws') out.push({ name: 'Compute', id: pick('aws-ec2-multi-az', 'aws-ec2-single') }, ...(managedDb ? [{ name: 'Database', id: pick('aws-rds-multi-az', 'aws-rds-single') }] : []), ...(lb ? [{ name: 'Load balancer', id: 'aws-elb' }] : []));
  if (platform === 'azure') out.push({ name: 'Compute', id: pick('azure-vm-zones', 'azure-vm-single') }, ...(managedDb ? [{ name: 'Database', id: 'azure-sql-db' }] : []), ...(lb ? [{ name: 'Load balancer', id: 'azure-lb' }] : []));
  if (platform === 'google') out.push({ name: 'Compute', id: pick('google-gce-multi-zone', 'google-gce-single') }, ...(managedDb ? [{ name: 'Database', id: 'google-cloudsql' }] : []), ...(lb ? [{ name: 'Load balancer', id: 'google-lb' }] : []));
  if (platform === 'oci') out.push({ name: 'Compute', id: 'oci-compute' }, ...(managedDb ? [{ name: 'Database', id: 'oci-db' }] : []), ...(lb ? [{ name: 'Load balancer', id: 'oci-lb' }] : []));
  return out;
}

/** The SLA restatement for one app. `overrides` are component name → percentage. */
export function slaRestatement(plan      , app        , options                                                                                        = {})                 {
  const scope = appScope(plan, app);
  const platform = appPlatform(plan, app, options.appPlan);
  const crit              = scope.app?.criticality ?? 'tier2';
  const slo                  = options.appPlan?.load?.slo;
  const required = slo ? Number(slo) : DEFAULT_AVAILABILITY[crit];
  const multi = scope.workloads.length > 1;
  const managedDb = scope.databases.some((d) => plan.decision?.items[d.id]?.method === 'managed-db');
  const lb = (options.appPlan?.ingress?.lb ?? 'none') !== 'none' || scope.workloads.filter((w) => w.role === 'web').length > 1;
  const components                 = slaIdsFor(platform, multi, managedDb, lb).map((c) => {
    const o = options.overrides?.[c.name];
    return o !== undefined ? { name: c.name, sla: o, overridden: true } : { name: c.name, sla: SLA.get(c.id) .pct, slaId: c.id, overridden: false };
  });
  for (const [name, pct] of Object.entries(options.overrides ?? {})) if (!components.some((c) => c.name === name)) components.push({ name, sla: pct, overridden: true });
  const findings            = [];
  let composite                    ;
  if (components.length > 0) {
    composite = Math.round(components.reduce((p, c) => p * (c.sla / 100), 1) * 1e6) / 1e4;
    if (composite < required) {
      findings.push(warning('sla.below-requirement', `${app}: the composite target SLA ${composite}% is below the required ${required}%.`, {
        remediation: 'Spread the tiers across zones, use a zone-redundant managed database, or restate the requirement.',
      }));
    }
  }
  return {
    app, platform, required, requiredBasis: slo ? 'slo' : 'criticality-default', components,
    ...(composite !== undefined ? { composite, meets: composite >= required } : {}),
    ...(scope.app?.rpo ? { rpo: scope.app.rpo } : {}), ...(scope.app?.rto ? { rto: scope.app.rto } : {}),
    drPattern: DR_PATTERNS[plan.requirements.drPattern[crit]].label,
    findings,
  };
}

export function slaMarkdown(rows                           )         {
  const lines = ['# SLA restatement', '', 'The composite target SLA is the product of the serial components\' provider SLAs. Provider figures are marked verify; overrides are yours.', '',
    '| App | Platform | Required | Basis | Components | Composite | Meets | RPO / RTO | DR pattern |', '|---|---|---|---|---|---|---|---|---|'];
  for (const r of rows) {
    lines.push(`| ${r.app} | ${PLATFORM_INFO[r.platform].label} | ${r.required}% | ${r.requiredBasis === 'slo' ? 'app SLO' : 'criticality default (assumption)'} | ${r.components.map((c) => `${c.name} ${c.sla}%${c.overridden ? ' (override)' : ' (verify)'}`).join('; ') || 'no provider SLA'} | ${r.composite !== undefined ? `${r.composite}%` : '—'} | ${r.meets === undefined ? '—' : r.meets ? 'yes' : '**no**'} | ${r.rpo ?? '—'} / ${r.rto ?? '—'} | ${r.drPattern} |`);
  }
  lines.push('', 'Sources:', ...[...new Set(SERVICE_SLAS.map((s) => s.source))].map((s) => `- ${s}`), '');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Checklists: hypercare, decommission, day-2, governance
// ---------------------------------------------------------------------------

                                       
                                                                                  
                                 
                      
                               
                        
                                                                 
                                       
                                                          
                          
 

const cov = (aws          , azure          , google          , oci          , vmware          )                             => ({ aws, azure, google, oci, vmware });
const RESEARCH = 'cloud-migration-methodologies research, 6(b) master checklist';

export const CHECKLISTS                            = Object.freeze([
  { id: 'H01', kind: 'hypercare', type: 'T', text: 'Hypercare / stabilisation period with enhanced support (AWS typically 1–4 days)', coverage: cov('●', '●', '–', '–', '–'), source: 'https://docs.aws.amazon.com/prescriptive-guidance/latest/large-migration-governance-playbook/task-follow-communication-gates.html' },
  { id: 'H02', kind: 'hypercare', type: 'G', text: 'Formal handoff to operations', coverage: cov('●', '●', '○', '–', '–'), source: RESEARCH },
  { id: 'H03', kind: 'hypercare', type: 'T', text: 'CMDB / ITSM updated (governance/cmdb)', coverage: cov('●', '●', '●', '–', '–'), source: RESEARCH },
  { id: 'H04', kind: 'hypercare', type: 'T', text: 'Replication resources finalised and cleaned up (finalize verb)', coverage: cov('●', '●', '●', '●', '●'), source: RESEARCH },
  { id: 'H05', kind: 'hypercare', type: 'A', text: 'Lessons learned recorded and fed into later waves', coverage: cov('●', '●', '●', '–', '–'), source: RESEARCH },
  { id: 'H06', kind: 'hypercare', type: 'G', text: 'Migration marked complete in the tool (archive / "Mark migration complete" / Completed state)', coverage: cov('●', '●', '●', '●', '●'), source: RESEARCH },
  { id: 'H07', kind: 'hypercare', type: 'G', text: 'Wave done: no dependence on network extension, performance at or above baseline, rollback formally closed, backup / DR onboarded', coverage: cov('○', '○', '–', '–', '●'), source: 'https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/azure-vmware-solution/migration' },
  { id: 'X01', kind: 'decommission', type: 'G', text: 'Formal approval to decommission, with success criteria (e.g. "benchmarks met for 30 days") — sign-off decom-approved, G4', coverage: cov('○', '●', '○', '–', '●'), source: 'https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/migrate/decommission-source-workload' },
  { id: 'X02', kind: 'decommission', type: 'T', text: 'Data archived and retained (final backup, immutable storage, legal hold)', coverage: cov('●', '●', '●', '–', '●'), source: RESEARCH },
  { id: 'X03', kind: 'decommission', type: 'T', text: 'Licences reclaimed or reassigned (the licence ledger)', coverage: cov('○', '●', '–', '–', '●'), source: RESEARCH },
  { id: 'X04', kind: 'decommission', type: 'T', text: 'Source removed from backups, monitoring, inventory and documentation', coverage: cov('○', '●', '○', '–', '○'), source: RESEARCH },
  { id: 'X05', kind: 'decommission', type: 'T', text: 'Controlled stop ("scream test") before retiring: host firewall block, pause the VM, stop the service, or an external firewall block', coverage: cov('●', '–', '–', '–', '–'), source: 'https://docs.aws.amazon.com/pdfs/prescriptive-guidance/latest/migration-retiring-applications/migration-retiring-applications.pdf' },
  { id: 'X06', kind: 'decommission', type: 'T', text: 'Network extension torn down; hardware and data-centre exit (asset register, NIST SP 800-88 sanitisation)', coverage: cov('○', '○', '–', '–', '●'), source: RESEARCH },
  { id: 'X07', kind: 'decommission', type: 'T', text: 'Retire strategy carried out for applications not migrated', coverage: cov('●', '●', '○', '○', '–'), source: RESEARCH },
  { id: 'O01', kind: 'day-2', type: 'T', text: 'Post-migration right-sizing from observed utilisation', coverage: cov('●', '●', '●', '○', '–'), source: RESEARCH },
  { id: 'O02', kind: 'day-2', type: 'T', text: 'Commitment discounts planned and applied (reservations, savings plans, committed use)', coverage: cov('○', '●', '●', '–', '–'), source: RESEARCH },
  { id: 'O03', kind: 'day-2', type: 'A', text: 'Cost against the baseline tracked (FinOps; your rate card)', coverage: cov('●', '●', '●', '○', '–'), source: RESEARCH },
  { id: 'O04', kind: 'day-2', type: 'T', text: 'Security posture management in place', coverage: cov('○', '●', '●', '○', '–'), source: RESEARCH },
  { id: 'O05', kind: 'day-2', type: 'T', text: 'Well-Architected review: reliability, security, cost, operational excellence, performance', coverage: cov('○', '●', '●', '○', '–'), source: 'https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/migrate/optimize-workloads-after-migration' },
  { id: 'O06', kind: 'day-2', type: 'T', text: '"Modernise later" backlog carried from the plan', coverage: cov('●', '●', '●', '○', '–'), source: RESEARCH },
  { id: 'O07', kind: 'day-2', type: 'A', text: 'Operations runbooks and management model (runbooks/ops)', coverage: cov('●', '●', '○', '○', '○'), source: RESEARCH },
  { id: 'O08', kind: 'day-2', type: 'T', text: 'Ongoing governance cycle: assess risk, set policy, enforce, monitor', coverage: cov('○', '●', '○', '●', '–'), source: RESEARCH },
  { id: 'G01', kind: 'governance', type: 'A', text: 'Meeting cadence: steering twice a month, weekly status review, daily stand-up, infrastructure and operations checkpoint twice a week', coverage: cov('●', '○', '●', '–', '–'), source: 'https://docs.aws.amazon.com/prescriptive-guidance/latest/large-migration-governance-playbook/introduction.html' },
  { id: 'G02', kind: 'governance', type: 'A', text: 'Decision log: description, status, impact, alternatives, decided by, date', coverage: cov('●', '–', '–', '–', '–'), source: 'https://docs.aws.amazon.com/prescriptive-guidance/latest/large-migration-governance-playbook/introduction.html' },
  { id: 'G03', kind: 'governance', type: 'A', text: 'Benefit-tracking KPIs: migrated vs plan, decommissioned vs plan, servers per strategy', coverage: cov('●', '●', '○', '–', '–'), source: RESEARCH },
  { id: 'G04', kind: 'governance', type: 'A', text: 'Lifecycle state tracked per server, app and wave (the tracker)', coverage: cov('●', '●', '●', '●', '●'), source: RESEARCH },
  { id: 'G05', kind: 'governance', type: 'G', text: 'Role-based approvals for production changes (sign-offs; the provider tool\'s approver role)', coverage: cov('●', '●', '–', '●', '–'), source: RESEARCH },
  { id: 'G06', kind: 'governance', type: 'G', text: 'Security and compliance approval of the migration tools', coverage: cov('●', '○', '○', '○', '–'), source: RESEARCH },
  { id: 'G07', kind: 'governance', type: 'A', text: 'RAID log: risks, assumptions, issues, dependencies — probability × impact, owner', coverage: cov('●', '○', '○', '–', '–'), source: 'https://docs.aws.amazon.com/prescriptive-guidance/latest/large-migration-governance-playbook/introduction.html' },
  { id: 'G08', kind: 'governance', type: 'A', text: 'RACI with exactly one A (and ideally one R) per activity', coverage: cov('●', '○', '○', '–', '–'), source: RESEARCH },
  { id: 'G09', kind: 'governance', type: 'A', text: 'Escalation plan: issue, trigger, tier 1 / 2 / 3 audiences and escalate-after times', coverage: cov('●', '–', '–', '–', '–'), source: 'https://docs.aws.amazon.com/prescriptive-guidance/latest/large-migration-governance-playbook/introduction.html' },
]);

const CHECKLIST_TITLE                                          = {
  hypercare: 'Hypercare and handover (P7)', decommission: 'Decommission and retire (P8)', 'day-2': 'Optimise and operate, day 2 (P9)', governance: 'Governance (runs throughout)',
};

/**
 * A checklist as Markdown. With a platform, the phase is named in the
 * provider's own word, and items the provider does not cover are marked as
 * the toolkit supplying the step.
 */
export function checklistMarkdown(kind               , platform           )         {
  const items = CHECKLISTS.filter((c) => c.kind === kind);
  const term = kind === 'hypercare' && platform ? ` — ${providerTerm('hypercare', platform)}` : '';
  const lines = [`# ${CHECKLIST_TITLE[kind]}${term}`, ''];
  if (platform) lines.push(`Provider: ${PLATFORM_INFO[platform].label}. ● in the provider's process, ○ partly, – supplied by this toolkit.`, '');
  for (const c of items) lines.push(`- [ ] **${c.id}** ${c.text}${platform ? ` (${c.coverage[platform]})` : ''}`);
  lines.push('', 'Sources:', ...[...new Set(items.map((c) => c.source))].map((s) => `- ${s}`), '');
  return lines.join('\n');
}

/** The escalation plan template (AWS governance playbook columns). */
export const ESCALATION_COLUMNS = Object.freeze(['#', 'Issue', 'Trigger', 'Tier 1 audience', 'Escalate after', 'Tier 2 audience', 'Escalate after', 'Tier 3 audience']         );
export const MEETING_CADENCE = Object.freeze([
  { meeting: 'Steering committee', frequency: 'Twice a month' },
  { meeting: 'Project status review', frequency: 'Weekly' },
  { meeting: 'Stand-up', frequency: 'Daily' },
  { meeting: 'Infrastructure and operations checkpoint', frequency: 'Twice a week' },
  { meeting: 'Migration business hours', frequency: 'Three times a week' },
]);

/** The files: runbooks/ops/<app>.md, training, SLA, and the checklists. */
export function opsFiles(plan      , raci                    , options                                     = {})                                                         {
  const files                         = {};
  const findings            = [];
  const plans = new Map((plan.appPlans ?? []).map((p) => [p.app, p]));
  const slas                   = [];
  for (const app of [...plan.apps].sort((a, b) => a.name.localeCompare(b.name))) {
    const appPlan = plans.get(app.id);
    const rb = opsRunbook(plan, app.name, raci, { ...(appPlan ? { appPlan } : {}), ...(options.design ? { design: options.design } : {}) });
    files[`runbooks/ops/${fileSlug(app.name)}.md`] = rb.markdown;
    findings.push(...rb.findings);
    const sla = slaRestatement(plan, app.name, appPlan ? { appPlan } : {});
    slas.push(sla);
    findings.push(...sla.findings);
  }
  files['runbooks/ops/training-plan.md'] = trainingPlan(plan, raci).markdown;
  files['runbooks/ops/sla-restatement.md'] = slaMarkdown(slas);
  const primary = plan.decision?.platforms[0];
  for (const kind of ['hypercare', 'decommission', 'day-2', 'governance']         ) files[`governance/checklists/${kind}.md`] = checklistMarkdown(kind, primary);
  files['governance/checklists/meetings-and-escalation.md'] = [
    '# Meetings and escalation', '', '| Meeting | Frequency |', '|---|---|', ...MEETING_CADENCE.map((m) => `| ${m.meeting} | ${m.frequency} |`), '',
    '## Escalation plan', '', `| ${ESCALATION_COLUMNS.join(' | ')} |`, `|${ESCALATION_COLUMNS.map(() => '---').join('|')}|`, '| 1 |  |  |  |  |  |  |  |', '',
    'Source: https://docs.aws.amazon.com/prescriptive-guidance/latest/large-migration-governance-playbook/introduction.html', '',
  ].join('\n');
  return { files, findings };
}
