/**
 * The providers' migration methodologies as data: each provider's word for
 * the same concept, each provider's name for a strategy, the standing of the
 * migration tools (renamed, closed to new customers, retired), and each
 * tool's own lifecycle vocabulary mapped to the tracker's states.
 *
 * Source: the methodology research compiled 2026-09-26 from the providers'
 * own documentation (sections 6(a), 6(d), 6(e) and "Status changes since
 * 2025"). Every row carries its URL and how far it was verified; a row the
 * research could not confirm on an official page is 'I' with a note, never
 * presented as published.
 *
 * Pure data and lookups: no DOM, no storage.
 */

                                                
import { MIGRATION_STRATEGY_OPTIONS, PROVIDER_TERM_OPTIONS, labelOf } from './options.js';
             
                                                                                                                                
                    

/** The date the rows below were last checked. */
export const METHODOLOGY_AS_OF = '2026-09-26';

// ---------------------------------------------------------------------------
// Terminology (research 6(d))
// ---------------------------------------------------------------------------

/** Each provider's methodology page the terms come from. */
export const TERM_SOURCES                                     = {
  aws: 'https://docs.aws.amazon.com/prescriptive-guidance/latest/large-migration-guide/migration-strategies.html',
  azure: 'https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/migrate/plan-migration',
  google: 'https://docs.cloud.google.com/migration-center/docs/migration-planning-overview',
  oci: 'https://docs.oracle.com/en/cloud/foundation/cloud_strategy/modernizationpatterns/index.html',
  vmware: 'https://techdocs.broadcom.com/us/en/vmware-cis/hcx/vmware-hcx/9-0/vmware-hcx-user-guide-vcf-9-0/migrating-virtual-machines-with-vmware-hcx/vmware-hcx-migration-types.html',
};

/**
 * Term × platform: the provider's own word, for relabelling the UI when a
 * cloud is selected. A missing cell means the provider has no such concept;
 * `providerTerm` then falls back to the neutral word.
 */
export const PROVIDER_TERMS                                                                              = {
  framework: {
    aws: 'AWS CAF / Migration Acceleration Program / Prescriptive Guidance',
    azure: 'Cloud Adoption Framework',
    google: 'Google Cloud Adoption Framework / Migrate to Google Cloud',
    oci: 'Oracle Cloud Adoption Framework',
  },
  phases: {
    aws: 'Assess → Mobilize → Migrate & Modernize',
    azure: 'Strategy → Plan → Ready → Adopt → Govern / Secure / Manage',
    google: 'Assess → Plan → Deploy → Optimize',
    oci: 'Manage assets → Plan & migrate → Verify',
    vmware: 'Analyze → Waves → Mobility Groups → Commit → Migrate',
  },
  'move-group': { aws: 'Move group', azure: 'Dependency group', google: 'Move group', oci: 'Migration project', vmware: 'Mobility Group' },
  wave: { aws: 'Wave', azure: 'Migration wave', google: 'Wave', vmware: 'Migration wave' },
  iteration: { aws: 'Sprint', azure: 'Iteration', google: 'Sprint' },
  factory: { aws: 'Migration factory', google: 'Migration factory' },
  readiness: {
    aws: 'Confidence score and risk flags',
    azure: 'Ready / Conditionally ready / Not ready / Readiness unknown',
    google: 'Technical fit',
    oci: 'Compatibility (ERROR / WARNING / INFO)',
    vmware: 'Pre-migration checks',
  },
  'sizing-basis': {
    azure: 'Performance-based or as-is on-premises',
    google: 'Preference set (None / Moderate / Aggressive / Custom)',
    oci: 'AS_IS / AVERAGE / PEAK / PERCENTILE',
  },
  'data-quality': { aws: 'Data fidelity', azure: 'Performance coverage', oci: 'Metric type (historical / runtime)' },
  'cost-document': { aws: 'Business case', azure: 'Business case', google: 'TCO report', oci: 'Migration plan cost estimate' },
  'test-run': { aws: 'Test instance', azure: 'Test migration', google: 'Test-clone', vmware: 'Pre-migration checks' },
  cutover: { aws: 'Cutover (launch, then finalize)', azure: 'Migrate, then complete migration', google: 'Cut-over, then finalize', oci: 'Mark migration complete', vmware: 'Switchover' },
  rollback: { aws: 'Rollback (revert to ready for cutover)', azure: 'Fallback', google: 'Fallback', oci: 'Fallback', vmware: 'Reverse migration' },
  hypercare: { aws: 'Hypercare', azure: 'Stabilization' },
  'landing-zone': { aws: 'Landing zone', azure: 'Azure landing zone', google: 'Foundation', oci: 'Landing zone', vmware: 'Management and workload domains' },
  collector: {
    aws: 'Discovery tool / Agentless Collector',
    azure: 'Azure Migrate appliance',
    google: 'Discovery client',
    oci: 'Remote agent appliance',
    vmware: 'VCF Operations for networks collector',
  },
};

/** The provider's word for a concept, or the neutral word where it has none (or no platform is chosen). */
export function providerTerm(term              , platform           )         {
  return (platform && PROVIDER_TERMS[term][platform]) || labelOf(PROVIDER_TERM_OPTIONS, term);
}

/** Strategy × platform, where the provider's word differs from the neutral one ("Replace" on Azure and OCI). */
export const STRATEGY_PROVIDER_LABELS                                                                                            = {
  repurchase: { aws: 'Repurchase', google: 'Repurchase', azure: 'Replace', oci: 'Replace' },
  refactor: { aws: 'Refactor / re-architect' },
  rearchitect: { aws: 'Refactor / re-architect', google: 'Re-architect' },
  rehost: { google: 'Rehost (lift and shift)' },
  replatform: { google: 'Replatform (lift and optimize)' },
};
/** The strategies each provider publishes (research 6(d)); VCF publishes none, so HCX types are methods under rehost / relocate. */
export const PROVIDER_STRATEGIES                                                           = {
  aws: ['retire', 'retain', 'rehost', 'relocate', 'replatform', 'refactor', 'repurchase'],
  azure: ['retire', 'retain', 'rehost', 'replatform', 'refactor', 'rearchitect', 'rebuild', 'repurchase'],
  google: ['retire', 'rehost', 'replatform', 'refactor', 'rearchitect', 'rebuild', 'repurchase'],
  oci: ['retain', 'rehost', 'replatform', 'refactor', 'revise', 'rebuild', 'repurchase', 'retire'],
  vmware: ['retain', 'rehost', 'relocate'],
};
/** A strategy in the provider's own words (the neutral label with no platform). */
export function strategyLabel(strategy                   , platform           )         {
  return (platform && STRATEGY_PROVIDER_LABELS[strategy]?.[platform]) || labelOf(MIGRATION_STRATEGY_OPTIONS, strategy);
}

// ---------------------------------------------------------------------------
// Service status (research "Status changes since 2025")
// ---------------------------------------------------------------------------

const row = (e                    )                     => Object.freeze(e);

export const SERVICE_STATUS                                = Object.freeze([
  row({
    id: 'aws-migration-hub', platform: 'aws', name: 'AWS Migration Hub', status: 'closed-to-new-customers', since: '2025-11-07',
    replacement: 'AWS Transform',
    note: 'Closed to new customers; existing customers can keep using it, and its exports are still accepted.',
    source: 'https://docs.aws.amazon.com/migrationhub/latest/ug/migrationhub-availability-change.html', verification: 'V-DOC', asOf: METHODOLOGY_AS_OF,
  }),
  row({
    id: 'aws-application-discovery-service', platform: 'aws', name: 'AWS Application Discovery Service', status: 'closed-to-new-customers',
    replacement: 'AWS Transform',
    note: 'No longer open to new customers; AWS points to AWS Transform. The page gives no date. ADS import files are kept as a legacy format.',
    source: 'https://docs.aws.amazon.com/application-discovery/latest/userguide/discovery-import.html', verification: 'V-DOC', asOf: METHODOLOGY_AS_OF,
  }),
  row({
    id: 'aws-mgn', platform: 'aws', name: 'AWS Application Migration Service', status: 'renamed', since: '2026-06-08',
    replacement: 'AWS Transform MGN',
    note: 'Renamed AWS Transform MGN; the APIs (aws mgn …) are unchanged. Shown as "AWS Transform MGN (formerly AWS Application Migration Service)".',
    source: 'https://docs.aws.amazon.com/mgn/latest/ug/General-Questions-FAQ.html', verification: 'V-DOC', asOf: METHODOLOGY_AS_OF,
  }),
  row({
    id: 'aws-snowball-edge', platform: 'aws', name: 'AWS Snowball Edge', status: 'closed-to-new-customers',
    replacement: 'AWS DataSync, AWS Data Transfer Terminal or a partner offline service',
    note: 'No longer available to new customers. The AWS page gives no date; 2025-11-07 appears only in a search summary and is unverified.',
    source: 'https://docs.aws.amazon.com/snowball/latest/developer-guide/snowball-edge-availability-change.html', verification: 'V-DOC', asOf: METHODOLOGY_AS_OF,
  }),
  row({
    id: 'aws-dms-fleet-advisor', platform: 'aws', name: 'AWS DMS Fleet Advisor', status: 'end-of-support', since: '2026-05-20',
    replacement: 'Migration Evaluator or AWS Transform',
    note: 'Ended; database discovery goes through Migration Evaluator or AWS Transform.',
    source: 'https://docs.aws.amazon.com/dms/latest/userguide/dms_fleet.advisor-end-of-support.html', verification: 'V-DOC', asOf: METHODOLOGY_AS_OF,
  }),
  row({
    id: 'aws-transform', platform: 'aws', name: 'AWS Transform', status: 'ga', since: '2025-05',
    note: 'The AWS planning and execution front end that replaces Migration Hub for new customers. Launch month from the research, not a dated announcement.',
    source: 'https://docs.aws.amazon.com/transform/latest/userguide/what-is-service.html', verification: 'V-DOC', asOf: METHODOLOGY_AS_OF,
  }),
  row({
    id: 'amazon-evs', platform: 'aws', name: 'Amazon Elastic VMware Service (EVS)', status: 'ga', since: '2025-08',
    note: 'A VMware-on-hyperscaler relocate target beside Azure VMware Solution, Google Cloud VMware Engine and Oracle Cloud VMware Solution; migration is by HCX.',
    source: 'https://docs.aws.amazon.com/evs/latest/userguide/migrate-evs-hcx.html', verification: 'V-DOC', asOf: METHODOLOGY_AS_OF,
  }),
  row({
    id: 'azure-data-box-heavy', platform: 'azure', name: 'Azure Data Box Heavy', status: 'retired',
    replacement: 'The next-generation Data Box (120 TB / 525 TB)',
    note: 'Retired; the 80 TB Data Box is being retired as the next-generation devices roll out.',
    source: 'https://learn.microsoft.com/en-us/azure/databox/data-box-overview', verification: 'V-DOC', asOf: METHODOLOGY_AS_OF,
  }),
  row({
    id: 'oci-data-transfer', platform: 'oci', name: 'OCI Data Transfer (disk and appliance)', status: 'retired', since: '2025-02-06',
    replacement: 'Roving Edge as a Data Transfer Gateway, Seagate Lyve, or oci os object sync',
    note: 'End of life; no OCI transfer appliance is offered.',
    source: 'https://docs.oracle.com/en-us/iaas/releasenotes/datatransfer/eol.htm', verification: 'V-DOC', asOf: METHODOLOGY_AS_OF,
  }),
  row({
    id: 'hcx-wan-optimization', platform: 'vmware', name: 'HCX WAN Optimization', status: 'reintroduced',
    note: 'Removed in HCX 4.11.3 and in VCF 9.0; back in VCF 9.1 inside the enhanced service mesh. Offer it only when the target is VCF 9.1.',
    source: 'https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-1/release-notes/vmware-cloud-foundation-9-1-0-0-release-notes/what-s-new/whats-new-vcf-ops.html',
    verification: 'V-DOC', asOf: METHODOLOGY_AS_OF,
  }),
]);

const BY_ID                                          = new Map(SERVICE_STATUS.map((e) => [e.id, e]));

/** A tool's standing, or undefined when nothing has changed for it. */
export function serviceStatus(id        )                                 {
  return BY_ID.get(id);
}

/** True when choosing the tool deserves a warning: new customers cannot start on it, or it is gone. */
export function shouldWarn(id        )          {
  const s = BY_ID.get(id)?.status;
  return s === 'closed-to-new-customers' || s === 'end-of-support' || s === 'retired' || s === 'removed';
}

// ---------------------------------------------------------------------------
// Provider lifecycle vocabulary for tracking (research 1.5, 2.8, 3.6, 4.2, 5.1, 6(e) 15)
// ---------------------------------------------------------------------------

const MGN = 'https://docs.aws.amazon.com/mgn/latest/ug/lifecycle.html';
const AZ = 'https://learn.microsoft.com/en-us/azure/migrate/tutorial-migrate-vmware?view=migrate';
const M2VM = 'https://docs.cloud.google.com/migrate/virtual-machines/docs/5.0/discover/lifecycle';
const GDMS = 'https://docs.cloud.google.com/database-migration/docs/overview';
const HCX = 'https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-0/workload-mobility/vmware-hcx-user-guide-vcf-9-0/migrating-virtual-machines-with-vmware-hcx/migrating-mobility-groups-from-migration-waves/migrating-mobility-group-workloads-in-migration-waves.html';
const OCM = 'https://docs.oracle.com/en-us/iaas/Content/pl-sql-sdk/doc/cloud_migrations_t.html';

const st = (tool               , label        , state                       , source        , verification               = 'V-DOC', flag           )                         =>
  Object.freeze({ tool, label, ...(state ? { state } : {}), ...(flag ? { flag } : {}), source, verification });

/**
 * Each tool's states in its own words, in order, with the tracker state they
 * mean. The state names are the providers'; the mapping onto ours is this
 * toolkit's reading, so a mapping the provider does not itself make is 'I'.
 */
export const PROVIDER_LIFECYCLE                                    = Object.freeze([
  st('aws-transform-mgn', 'Not ready (initial sync)', 'replicating', MGN),
  st('aws-transform-mgn', 'Ready for testing', 'in-sync', MGN),
  st('aws-transform-mgn', 'Test in progress', 'testing', MGN),
  st('aws-transform-mgn', 'Ready for cutover', 'tested', MGN),
  st('aws-transform-mgn', 'Cutover in progress', 'cutting-over', MGN),
  st('aws-transform-mgn', 'Cutover complete', 'cut-over', MGN),
  st('aws-transform-mgn', 'Disconnected', 'decommissioned', MGN, 'I'),
  st('aws-transform-mgn', 'Stalled', undefined, MGN, 'V-DOC', 'failed'),
  st('azure-migrate', 'Preparation', 'replicating', AZ),
  st('azure-migrate', 'Testing', 'testing', AZ),
  st('azure-migrate', 'Completion', 'cut-over', AZ),
  st('gcp-m2vm', 'Replicating', 'replicating', M2VM),
  st('gcp-m2vm', 'Test-clone', 'testing', M2VM),
  st('gcp-m2vm', 'Cut-over', 'cut-over', M2VM),
  st('gcp-m2vm', 'Finalized', 'decommissioned', M2VM, 'I'),
  st('gcp-dms', 'Full dump', 'replicating', GDMS, 'I'),
  st('gcp-dms', 'CDC', 'in-sync', GDMS, 'I'),
  st('gcp-dms', 'Promote', 'cut-over', GDMS, 'I'),
  st('hcx-mobility-group', 'Not Configured', 'planned', HCX),
  st('hcx-mobility-group', 'Partially Configured', 'planned', HCX),
  st('hcx-mobility-group', 'Configured', 'prepared', HCX),
  st('hcx-mobility-group', 'In-progress', 'replicating', HCX),
  st('hcx-mobility-group', 'Completed', 'cut-over', HCX),
  st('oci-ocm', 'ACTIVE', 'prepared', OCM, 'I'),
  st('oci-ocm', 'NEEDS_ATTENTION', undefined, OCM, 'V-DOC', 'blocked'),
  st('oci-ocm', 'FAILED', undefined, OCM, 'V-DOC', 'failed'),
  st('oci-ocm', 'Migration complete', 'accepted', OCM, 'I'),
]);

/** The tool's name for where an item is: the last of its states that maps to the tracker state, else undefined. */
export function providerStateLabel(tool               , state           )                     {
  const hits = PROVIDER_LIFECYCLE.filter((s) => s.tool === tool && s.state === state);
  return hits[hits.length - 1]?.label;
}

/** A provider state as read from a console or an export, as the tracker state and flag it means (case-insensitive). */
export function fromProviderState(tool               , label        )                                     {
  const t = label.trim().toLowerCase();
  return PROVIDER_LIFECYCLE.find((s) => s.tool === tool && s.label.toLowerCase() === t);
}
