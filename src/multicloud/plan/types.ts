/**
 * The Multi-Cloud Planner's data model: one serialisable `Plan`, the decision
 * made from it, the target design and the waves.
 *
 * Every other planner module codes against these types, so they change only by
 * a deliberate, reviewed edit. Every closed set here has an option table in
 * `options.ts`, which is the single source for the dropdowns and the CSV, and
 * a test proves the two agree in both directions.
 *
 * Nothing here is behaviour: this file is types, plus the constants that
 * name the file and record kinds (plan, tracker, rate card, status event).
 */

import type { Platform } from '../platforms.ts';
import type { Finding } from '../../core/findings.ts';
import type { Verification } from '../../vcf/provenance.ts';

export type { Platform } from '../platforms.ts';
export type { Finding } from '../../core/findings.ts';
export type { Verification } from '../../vcf/provenance.ts';

/** The four hyperscalers, as a type: everything except VCF on owned hardware. */
export type Hyperscaler = Exclude<Platform, 'vmware'>;

// ---------- identities -------------------------------------------------------

/** Stable: `'w:<slug(name)>'` | `'d:<slug(name)>'` | `'a:<slug(app)>'`. See `itemId` in options.ts. */
export type ItemId = string;
export type ItemKind = 'workload' | 'database' | 'app';
/** Every yes/no dropdown. Stored as a boolean in the model. */
export type YesNo = 'yes' | 'no';

// ---------- operating systems ------------------------------------------------

export type OsId =
  | 'win-2008r2' | 'win-2012' | 'win-2012r2' | 'win-2016' | 'win-2019' | 'win-2022' | 'win-2025'
  | 'rhel-6' | 'rhel-7' | 'rhel-8' | 'rhel-9' | 'rhel-10'
  | 'centos-6' | 'centos-7' | 'centos-8' | 'centos-stream-9' | 'centos-stream-10'
  | 'rocky-8' | 'rocky-9' | 'rocky-10' | 'alma-8' | 'alma-9' | 'alma-10'
  | 'ol-6' | 'ol-7' | 'ol-8' | 'ol-9' | 'ol-10'
  | 'sles-11' | 'sles-12' | 'sles-15' | 'sles-16'
  | 'ubuntu-16.04' | 'ubuntu-18.04' | 'ubuntu-20.04' | 'ubuntu-22.04' | 'ubuntu-24.04'
  | 'debian-9' | 'debian-10' | 'debian-11' | 'debian-12' | 'debian-13'
  | 'linux-other' | 'windows-client' | 'other' | 'unknown';
/** Package-manager family. */
export type OsFamily = 'windows' | 'rhel' | 'suse' | 'debian' | 'other';
export type OsKind = 'windows' | 'linux' | 'other';
export interface OsInfo {
  readonly id: OsId;
  readonly label: string;
  readonly family: OsFamily;
  readonly kind: OsKind;
  /** '2022', '9', '24.04'; '' when not versioned. */
  readonly majorVersion: string;
  /** ISO date. */
  readonly endOfStandardSupport?: string;
  /** ISO date (ESU / ELS / ESM / LTSS / Extended Support). */
  readonly endOfExtendedSupport?: string;
  /** Suggested in-place or rebuild target. */
  readonly upgradeTo?: OsId;
  /** URL. */
  readonly source: string;
  readonly verification: Verification;
}

// ---------- intake -----------------------------------------------------------

export type Env = 'prod' | 'preprod' | 'test' | 'dev' | 'dr';
export type Role = 'web' | 'app' | 'db' | 'file' | 'ad-dc' | 'dns-dhcp' | 'rds-vdi' | 'middleware'
  | 'messaging' | 'batch' | 'monitoring' | 'backup' | 'jump' | 'appliance' | 'other';
export type Criticality = 'tier0' | 'tier1' | 'tier2' | 'tier3';
export type Rpo = '0' | '15m' | '1h' | '4h' | '24h';
export type Rto = '15m' | '1h' | '4h' | '24h' | '72h';
export type OsLicence = 'li' | 'byol-sa' | 'byol-perpetual' | 'rhel-byos' | 'sles-byos' | 'free';
export type Residency = 'any' | 'eu' | 'uk' | 'us' | 'ca' | 'de' | 'fr' | 'ch' | 'nl' | 'se' | 'au' | 'nz'
  | 'jp' | 'kr' | 'in' | 'sg' | 'ae' | 'sa' | 'br' | 'za';
/**
 * What happens to an item (the plan's 6 Rs). `new` (addendum A.1.7) is a
 * greenfield item: nothing moves; the engine maps it to method `rebuild` and
 * skips the migration-only rules. The finer 11-value strategy list the
 * providers publish is `MigrationStrategy`, kept beside this, not instead.
 */
export type Disposition = 'rehost' | 'relocate' | 'replatform' | 'refactor' | 'repurchase' | 'retire' | 'retain' | 'new';
export type Method =
  | 'replicate'      // AWS MGN / Azure Migrate / Google Migrate to VMs / OCI Cloud Migrations
  | 'rebuild'        // new VM from image + Ansible + data copy
  | 'relocate-hcx'   // HCX / vMotion to EVS, AVS, GCVE, OCVS or VCF
  | 'managed-db'     // DB moves to a managed service (DMS / ZDM / Data Guard / AG seeding)
  | 'none';          // retire / retain / repurchase

export type PowerState = 'poweredOn' | 'poweredOff' | 'suspended' | 'unknown';
export type ReadinessSeverity = 'blocker' | 'caution' | 'note';
export type ItemSource = 'estate' | 'csv' | 'manual' | 'portfolio';

export interface Workload {
  readonly id: ItemId;
  readonly name: string;
  readonly app: string;
  readonly env: Env;
  readonly role: Role;
  readonly os: OsId;
  readonly vcpu: number;
  readonly ramGib: number;
  /** Boot first. */
  readonly disksGib: readonly number[];
  readonly criticality: Criticality;
  readonly rpo: Rpo;
  readonly rto: Rto;
  readonly licence: OsLicence;
  /** undefined = the app's, else the plan default. */
  readonly residency?: Residency;
  /** undefined = decided by the rules. */
  readonly disposition?: Disposition;
  /** Workload names, app names, or `'site:<name>'`. */
  readonly dependsOn: readonly string[];
  readonly pin?: Platform;
  // provenance, not shown as columns
  readonly source: ItemSource;
  /** `scopedKey(vcenter, name)` from the estate. */
  readonly sourceKey?: string;
  /** From the estate, used by rules. */
  readonly facts?: WorkloadFacts;
  readonly edited?: readonly (keyof Workload)[];
  // ---- addendum A.11.1 and the methodology delta (all optional) ----
  /** Where the machine runs today. Undefined on estate rows means 'vsphere'. */
  readonly origin?: SourcePlatform;
  readonly sourceRef?: SourceRef;
  readonly workloadType?: WorkloadType;
  /** false / undefined with `facts.detection` set = "detected, confirm". */
  readonly typeConfirmed?: boolean;
  /** Which figures `vcpu` / `ramGib` hold (A.3.6). */
  readonly basis?: SizingBasis;
  readonly ipStrategy?: IpStrategy;
  /** New hostname; undefined = keep. */
  readonly rename?: string;
  readonly upgrade?: OsUpgrade;
  /** Generated from a new app's components; hidden in grids. */
  readonly synthetic?: boolean;
  /** The provider-style strategy (11 Rs); undefined = `strategyOf(disposition)`. The execution method is the item's path. */
  readonly strategy?: MigrationStrategy;
  /** The move group it belongs to (`MoveGroup.id`), once grouped. */
  readonly moveGroup?: string;
}
/** The A.11.1 `WorkloadDelta`, as a name for code that wants only the new fields. */
export type WorkloadDelta = Pick<Workload, 'origin' | 'sourceRef' | 'workloadType' | 'typeConfirmed' | 'basis' | 'ipStrategy' | 'rename' | 'upgrade' | 'synthetic'>;
export interface WorkloadFacts {
  readonly powerState?: PowerState;
  readonly rdmGib?: number;
  /** Multi-writer. */
  readonly sharedDisks?: boolean;
  readonly passthrough?: boolean;
  readonly activeMemoryGib?: number;
  readonly firmware?: 'bios' | 'efi';
  readonly ipAddresses?: readonly string[];
  readonly readiness?: readonly { readonly id: string; readonly severity: ReadinessSeverity }[];
  /** What classifyOs read. */
  readonly guestOsRaw?: string;
  /** Provisioned capacity, to compare with the movable disk total. */
  readonly provisionedGib?: number;
  // ---- addendum A.11.1 (all optional) ----
  /** The machine as configured, when `Workload.vcpu` / `ramGib` hold demand instead. */
  readonly nameplate?: { readonly cores: number; readonly ramGib: number; readonly disksGib: readonly number[] };
  /** Used GiB per disk, aligned with `Workload.disksGib` (boot first). */
  readonly disksUsedGib?: readonly number[];
  readonly utilisation?: Utilisation;
  /** Utilisation measured on the target after the move (post-move right-sizing). */
  readonly observedOnTarget?: Utilisation;
  readonly software?: readonly string[];
  readonly services?: readonly string[];
  readonly listening?: readonly ListeningPort[];
  readonly detection?: WorkloadDetection;
}
/** The A.11.1 `WorkloadFactsDelta`. */
export type WorkloadFactsDelta = Pick<WorkloadFacts, 'nameplate' | 'disksUsedGib' | 'utilisation' | 'observedOnTarget' | 'software' | 'services' | 'listening' | 'detection'>;
export type ListenProto = 'tcp' | 'udp';
export interface ListeningPort { readonly port: number; readonly proto: ListenProto; readonly process?: string }
export interface WorkloadDetection { readonly type: WorkloadType; readonly confidence: number; readonly evidence: readonly string[] }

export type DbEngine = 'oracle' | 'sqlserver' | 'postgres' | 'mysql' | 'mariadb' | 'db2' | 'mongodb' | 'sybase-ase'
  // addendum A.4.9
  | 'informix' | 'sap-hana' | 'redis' | 'cassandra' | 'elasticsearch'
  | 'other';
export type DbEdition = 'oracle-ee' | 'oracle-se2' | 'oracle-xe' | 'sql-enterprise' | 'sql-standard' | 'sql-web'
  | 'sql-express' | 'sql-developer' | 'community' | 'commercial';
/** The Version column's values. `other` for anything not listed. */
export type DbVersionId =
  | 'oracle-11.2' | 'oracle-12.1' | 'oracle-12.2' | 'oracle-18c' | 'oracle-19c' | 'oracle-21c' | 'oracle-26ai'
  | 'sql-2012' | 'sql-2014' | 'sql-2016' | 'sql-2017' | 'sql-2019' | 'sql-2022' | 'sql-2025'
  | 'pg-11' | 'pg-12' | 'pg-13' | 'pg-14' | 'pg-15' | 'pg-16' | 'pg-17' | 'pg-18'
  | 'mysql-5.7' | 'mysql-8.0' | 'mysql-8.4'
  | 'mariadb-10.6' | 'mariadb-10.11' | 'mariadb-11.4'
  | 'other';
export type DbHa = 'none' | 'rac' | 'rac-one-node' | 'data-guard-local' | 'sql-ag' | 'sql-fci' | 'sql-mirroring'
  | 'log-shipping' | 'pg-streaming' | 'mysql-group-replication' | 'other-cluster';
export type DbDr = 'none' | 'data-guard-remote' | 'active-data-guard' | 'sql-ag-async' | 'log-shipping'
  | 'backup-restore' | 'storage-replication' | 'goldengate';
export type DbFeature = 'ssis' | 'ssrs' | 'ssas' | 'clr-unsafe' | 'linked-servers' | 'cross-db-queries' | 'agent-jobs'
  | 'filestream' | 'dtc' | 'service-broker' | 'partitioning' | 'advanced-security' | 'diagnostics-pack'
  | 'tuning-pack' | 'in-memory' | 'apex' | 'ords' | 'spatial';
export type DbLicence = 'li' | 'byol-sa' | 'byol-perpetual' | 'oracle-processor' | 'oracle-nup' | 'oracle-ula'
  | 'community' | 'commercial-other';

export interface Database {
  readonly id: ItemId;
  readonly name: string;
  readonly engine: DbEngine;
  readonly edition: DbEdition;
  /** An option value, e.g. 'oracle-19c', 'sql-2022', 'pg-16'. */
  readonly version: DbVersionId;
  /** Workload names. */
  readonly hosts: readonly string[];
  readonly vcpu: number;
  readonly ramGib: number;
  readonly sizeGib: number;
  readonly ha: DbHa;
  readonly dr: DbDr;
  readonly features: readonly DbFeature[];
  readonly licence: DbLicence;
  readonly app: string;
  readonly pinService?: DbServiceId;
  readonly inferred?: boolean;
  readonly source: 'estate' | 'csv' | 'manual';
  readonly edited?: readonly (keyof Database)[];
  /** The provider-style strategy (11 Rs); undefined = derived from the decision. */
  readonly strategy?: MigrationStrategy;
  /** The move group it belongs to (`MoveGroup.id`), once grouped. */
  readonly moveGroup?: string;
}

export type Special = 'none' | 'gpu' | 'large-memory' | 'physical-dongle' | 'mainframe-link' | 'ot-network';
/** From decide.ts `Latency`. */
export type Latency = 'critical' | 'sensitive' | 'tolerant';
/** The Migration page's spelling of the clouds (Google is 'gcp' there). */
export type MigrationCloud = 'aws' | 'azure' | 'gcp' | 'oci';
export type PortfolioRisk = 'Low' | 'Medium' | 'High';
export interface App {
  readonly id: ItemId;
  readonly name: string;
  readonly owner?: string;
  readonly criticality: Criticality;
  readonly residency: Residency;
  readonly latencyToOnPrem: Latency;
  readonly deadlineMonths?: number;
  readonly special: Special;
  /** The app's recovery targets; its workloads inherit them unless edited. */
  readonly rpo?: Rpo;
  readonly rto?: Rto;
  /** Default for the app's workloads. */
  readonly route?: Disposition;
  /** Pinned wave 0-9. */
  readonly wave?: number;
  readonly notes?: string;
  readonly portfolio?: {
    readonly readiness: number;
    readonly risk: PortfolioRisk;
    readonly cloud?: MigrationCloud;
    readonly compliance: readonly string[];
  };
  readonly source?: 'estate' | 'csv' | 'manual' | 'portfolio';
  readonly edited?: readonly (keyof App)[];
  // ---- addendum A.11.1 (all optional) ----
  readonly kind?: AppKind;
  readonly pattern?: AppPattern;
  /** `PortfolioEntry.id` of the old Migration portfolio. */
  readonly portfolioId?: string;
  readonly frameworks?: readonly Framework[];
  readonly users?: number;
  readonly concurrentUsers?: number;
  readonly businessOwner?: string;
  readonly supportGroup?: string;
  readonly changeWindow?: ChangeWindow;
}
/** The A.11.1 `AppDelta` (`rpo` / `rto` were already on `App`). */
export type AppDelta = Pick<App, 'kind' | 'pattern' | 'portfolioId' | 'rpo' | 'rto' | 'frameworks' | 'users' | 'concurrentUsers' | 'businessOwner' | 'supportGroup' | 'changeWindow'>;
export type EdgeKind = 'sync' | 'async';
export interface DependencyEdge { readonly from: string; readonly to: string; readonly kind: EdgeKind }

// ---------- requirements -----------------------------------------------------

export type Sovereignty = 'none' | 'sovereign-region' | 'government-region' | 'dedicated' | 'air-gapped';
export type Framework = 'pci-dss-4' | 'hipaa' | 'soc2' | 'iso27001' | 'gdpr' | 'uk-gdpr' | 'fedramp-moderate'
  | 'fedramp-high' | 'dod-il2' | 'dod-il4' | 'dod-il5' | 'cjis' | 'irap-protected' | 'bsi-c5' | 'ens-high' | 'nis2' | 'dora';
export type Circuit = 'none' | 'direct-connect' | 'expressroute' | 'interconnect-dedicated' | 'interconnect-partner' | 'fastconnect';
export type Bandwidth = '50m' | '100m' | '200m' | '500m' | '1g' | '2g' | '5g' | '10g' | '100g';
export interface Site {
  readonly name: string;
  /** IPv4 or IPv6. */
  readonly vpnPeer?: string;
  readonly bgpAsn?: number;
  /** Either family. */
  readonly cidrs: readonly string[];
  readonly bandwidth: Bandwidth;
  readonly circuit: Circuit;
  readonly circuitLocation?: string;
}
export type Connection = 'vpn' | 'circuit' | 'circuit-with-vpn-backup';
export type BackupTierId = 'gold' | 'silver' | 'bronze';
export type BackupFrequency = '1h' | '4h' | '12h' | '24h';
export interface BackupTier {
  readonly tier: BackupTierId;
  readonly frequency: BackupFrequency;
  readonly retentionDays: number;
  readonly copyToDr: boolean;
  readonly immutable: boolean;
}
export type DrPattern = 'backup-restore' | 'pilot-light' | 'warm-standby' | 'active-active';
export type Agreement = 'edp' | 'macc' | 'google-commit' | 'oci-uc' | 'vcf-subscription' | 'enterprise-agreement';
export type SecurityBaseline = 'cis-l1' | 'cis-l2' | 'stig' | 'internal';
export type KeyManagement = 'provider-managed' | 'customer-managed' | 'hsm';
export type AdStrategy = 'extend-dcs' | 'managed-ad' | 'none';
export type LinuxJoin = 'realmd-sssd' | 'no';
export type CloudSignIn = 'entra-id' | 'aws-iam-identity-center' | 'google-cloud-identity' | 'oci-identity-domains' | 'existing-idp-saml';
export type DnsStrategy = 'forward-to-dcs' | 'cloud-private-dns-with-conditional-forwarders';
export type CostModel = 'payg' | 'reserved-1y' | 'reserved-3y' | 'savings-plan-3y';
export type MicrosoftSa = 'yes-all' | 'yes-some' | 'no';
export type OracleLicences = 'processor' | 'nup' | 'ula' | 'none';
export type Skill = 'none' | 'some' | 'strong';
export type ExitStrategy = 'portable-first' | 'balanced' | 'managed-first';
export type SizeBy = 'allocated' | 'active-memory';
export type Monitoring = 'cloud-native' | 'vcf-operations' | 'both';
export type Siem = 'none' | 'splunk' | 'sentinel' | 'google-secops' | 'qradar';
export type MaxPlatforms = 1 | 2 | 3 | 4 | 5;

export interface Commitment {
  readonly platform: Platform;
  readonly agreement: Agreement;
  readonly annual?: number;
  /** yyyy-mm. */
  readonly ends?: string;
}

export interface Requirements {
  readonly allowed: readonly Platform[];
  readonly maxPlatforms: MaxPlatforms;
  /** For vmware, `primary` is the vCenter FQDN. */
  readonly regions: Partial<Record<Platform, { readonly primary: string; readonly dr?: string }>>;
  readonly timelineMonths: number;
  readonly frameworks: readonly Framework[];
  readonly sovereignty: Sovereignty;
  readonly defaultResidency: Residency;
  readonly securityBaseline: SecurityBaseline;
  readonly keys: KeyManagement;
  readonly sites: readonly Site[];
  readonly connection: Connection;
  readonly identity: {
    readonly adStrategy: AdStrategy;
    readonly domain?: string;
    readonly computerOu?: string;
    readonly linuxJoin: LinuxJoin;
    readonly cloudSignIn: CloudSignIn;
    readonly dns: DnsStrategy;
  };
  readonly backupTiers: readonly BackupTier[];
  readonly drPattern: Readonly<Record<Criticality, DrPattern>>;
  readonly costModel: CostModel;
  readonly commitments: readonly Commitment[];
  readonly licensing: {
    readonly microsoftSa: MicrosoftSa;
    readonly windowsPre2019Licences: boolean;
    readonly oracle: OracleLicences;
    readonly oracleSupportRewards: boolean;
    readonly portableVcf: boolean;
    /** RHEL Cloud Access / SLES BYOS. */
    readonly linuxBring: boolean;
  };
  readonly skills: Partial<Record<Platform, Skill>>;
  readonly exit: ExitStrategy;
  readonly sizeBy: SizeBy;
  readonly monitoring: Monitoring;
  readonly siem: Siem;
}

/** A change to the requirements, for the estate what-if. Top-level keys replace whole. */
export type RequirementsPatch = { readonly [K in keyof Requirements]?: Requirements[K] };

// ---------- decision ---------------------------------------------------------

/** The services `db-catalog.ts` carries rows for itself. */
export type CoreDbServiceId =
  | 'aws-rds' | 'aws-rds-custom' | 'aws-aurora' | 'aws-ec2' | 'aws-odb-exadata' | 'aws-odb-adb'
  | 'azure-sqldb' | 'azure-sqlmi' | 'azure-sqlvm' | 'azure-pg-flex' | 'azure-mysql-flex' | 'azure-vm'
  | 'azure-odb-exadata' | 'azure-odb-adb'
  | 'google-cloudsql' | 'google-alloydb' | 'google-gce' | 'google-odb-exadata' | 'google-odb-adb' | 'google-odb-basedb'
  | 'oci-adb' | 'oci-basedb' | 'oci-exacs' | 'oci-mysql-heatwave' | 'oci-pg' | 'oci-compute'
  | 'vmware-vm';
/** Databases beyond the core (addendum A.4.9); their rows come from `db-catalog-extra.ts` (WP-16). */
export type ExtraDbServiceId =
  | 'aws-rds-db2' | 'aws-docdb' | 'aws-elasticache' | 'aws-memorydb' | 'aws-keyspaces' | 'aws-opensearch'
  | 'azure-documentdb' | 'azure-managed-redis' | 'azure-cassandra-mi'
  | 'google-memorystore' | 'oci-cache' | 'oci-opensearch' | 'oci-adb-mongo';
export type DbServiceId = CoreDbServiceId | ExtraDbServiceId;
export interface RuleHit {
  /** e.g. 'lic.oracle.ace-vcpu'. */
  readonly rule: string;
  /** decide.ts ids this rule also reports as, for continuity (e.g. 'microsoft-licensing'). */
  readonly aliases?: readonly string[];
  readonly delta: number;
  readonly reason: string;
  /** 'V-DOC' | 'C' | 'I' (the existing type). */
  readonly verification: Verification;
  /** URL. */
  readonly source?: string;
}
export type LicenceKind = 'oracle-processor' | 'oracle-se2-socket' | 'windows-core' | 'sql-core' | 'rhel' | 'sles' | 'none';
export type LicenceModel = 'li' | 'byol' | 'ahb' | 'dedicated-host' | 'fvb' | 'licence-mobility' | 'n/a';
export interface LicenceNeed {
  readonly kind: LicenceKind;
  readonly count: number;
  readonly model: LicenceModel;
  readonly note: string;
  /** Set when the licence position rules this option out: the rule id, e.g. 'lic.oracle.se2-cap'. */
  readonly eliminated?: string;
  /** The `LICENSING_FACTS` ids the count rests on, for the decision record. */
  readonly facts?: readonly string[];
}
/** One platform (+ service, for a DB) considered for one item. */
export interface Option {
  readonly platform: Platform;
  readonly service?: DbServiceId;
  readonly score: number;
  /** Rule id that eliminated it. */
  readonly eliminated?: string;
  readonly hits: readonly RuleHit[];
  readonly licence?: LicenceNeed;
}
export interface ItemDecision {
  readonly id: ItemId;
  readonly kind: 'workload' | 'database';
  readonly disposition: Disposition;
  readonly method: Method;
  /** Every platform (every service for a DB), best first. */
  readonly options: readonly Option[];
  /** undefined when retired, retained nowhere, or everything eliminated. */
  readonly chosen?: Option;
  readonly pinned: boolean;
  readonly snapped?: { readonly from: Platform; readonly rule: 'estate.subset' | 'estate.affinity' };
  /** chosen.score - best alternative on another platform. */
  readonly margin: number;
  readonly findings: readonly Finding[];
}
export interface PlanDecision {
  /** Bumped when rules change. */
  readonly engineVersion: string;
  /** The chosen subset. */
  readonly platforms: readonly Platform[];
  readonly subsetScores: readonly { readonly platforms: readonly Platform[]; readonly score: number }[];
  readonly items: Readonly<Record<ItemId, ItemDecision>>;
  readonly findings: readonly Finding[];
}
/** Licence counts per platform, as the BOM and the what-if diff sum them. */
export type LicenceTotals = Readonly<Partial<Record<Platform, Readonly<Partial<Record<LicenceKind, number>>>>>>;

// ---------- target design ----------------------------------------------------

export type NetworkTier = 'web' | 'app' | 'db' | 'mgmt';
export type Bastion = 'cloud-native' | 'jump-vm' | 'none';
/** Screen 7 landing-zone card controls, kept in `Plan.designOverrides` as strings. */
export type SubnetPrefix = '/20' | '/21' | '/22' | '/23' | '/24';
export type ZoneCount = 1 | 2 | 3;
export type LogRetentionDays = 90 | 180 | 365 | 400 | 730 | 2555;
export interface NetworkDesign {
  readonly name: string;
  readonly envs: readonly Env[];
  readonly cidr: string;
  readonly ipv6: boolean;
  readonly ipv6Cidr?: string;
  readonly tiers: readonly NetworkTier[];
  readonly subnets: readonly { readonly tier: string; readonly zone: string; readonly cidr: string; readonly ipv6Cidr?: string }[];
}
export interface ComputeTarget {
  readonly workload: ItemId;
  readonly size: string;
  readonly vcpu: number;
  readonly ramGib: number;
  readonly ocpus?: number;
  /** Licence-optimised: AWS cpu_options / GCP visible_core_count / Azure constrained size. */
  readonly coreCount?: number;
  readonly image: ImageRef;
  readonly disks: readonly { readonly gib: number; readonly type: string }[];
  readonly network: string;
  readonly tier: NetworkTier;
  readonly zone: string;
  /** Text shown and written as a tag. */
  readonly licenceHandling: string;
  readonly backupTier: BackupTierId;
  readonly dedicatedHost?: boolean;
  /** How the workload arrives: replicated as it is, or built fresh from the image. */
  readonly method?: 'replicate' | 'rebuild';
}
export type ImageRef =
  | { readonly kind: 'aws-ssm'; readonly parameter: string }
  | { readonly kind: 'aws-ami-filter'; readonly owner: string; readonly namePattern: string }
  | { readonly kind: 'azure-marketplace'; readonly publisher: string; readonly offer: string; readonly sku: string; readonly plan?: boolean }
  | { readonly kind: 'gcp-family'; readonly project: string; readonly family: string }
  | { readonly kind: 'oci-platform'; readonly operatingSystem: string; readonly version: string }
  | { readonly kind: 'vsphere-template'; readonly template: string }
  /** The replication tool brings the disk. */
  | { readonly kind: 'replicated'; readonly note: string }
  /** BYO image, as a var. */
  | { readonly kind: 'custom'; readonly variable: string; readonly note: string };
export type ImageKind = ImageRef['kind'];
export interface DbTarget {
  readonly database: ItemId;
  readonly service: DbServiceId;
  readonly classOrShape: string;
  readonly storageGib: number;
  readonly ha: string;
  readonly licenceModel: string;
  readonly backupTier: BackupTierId;
  /** Provider's spelling, e.g. '19.0.0.0.ru-2025-01.rur-2025-01.r1', 'SQLSERVER_2022_ENTERPRISE'. */
  readonly engineVersion: string;
  /** For IaaS: the compute targets carrying it. */
  readonly hosts?: readonly ItemId[];
}
export interface PlatformDesign {
  readonly platform: Platform;
  readonly prefix: string;
  readonly region: string;
  readonly drRegion?: string;
  readonly scope?: string;
  readonly networks: readonly NetworkDesign[];
  readonly bastion: Bastion;
  readonly logRetentionDays: number;
  readonly compute: readonly ComputeTarget[];
  readonly databases: readonly DbTarget[];
  readonly connectivity: readonly { readonly site: string; readonly method: Connection; readonly cloudAsn: number }[];
  readonly identity: { readonly strategy: AdStrategy; readonly dcNames: readonly string[] };
  readonly backup: { readonly tiers: readonly BackupTier[] };
  readonly relocate?: { readonly service: string; readonly nodes: number };
  /** Workloads the design adds that the plan does not have (domain controllers, jump hosts). */
  readonly added?: readonly Workload[];
  /** 'compute:<id>:size' → value, etc. */
  readonly overrides: Readonly<Record<string, string>>;
}
export interface TargetDesign { readonly platforms: readonly PlatformDesign[]; readonly findings: readonly Finding[] }

// ---------- waves ------------------------------------------------------------

export type WaveMode = 'default' | 'fast' | 'modernize';
export type WaveParallel = 1 | 2 | 3;
export type WaveWeeks = 1 | 2 | 3 | 4;
export interface FreezeWindow { readonly from: string; readonly to: string; readonly reason: string }
export interface WaveSettings {
  readonly mode: WaveMode;
  readonly maxPerWave: number;
  readonly parallel: WaveParallel;
  readonly weeks: WaveWeeks;
  /** yyyy-mm-dd; blank means runbooks say "Week N". */
  readonly start?: string;
  readonly freezes: readonly FreezeWindow[];
  /** Addendum A.5.4 / A.5.5.2: the team's capacity per window; undefined = unconstrained. */
  readonly capacity?: WaveCapacity;
}
export interface WaveCapacity {
  readonly cutoversPerWindow: number;
  readonly replicationSetupsPerDay: number;
  readonly dbaCutoversPerWindow: number;
  readonly parallelAppTeams: number;
}
/**
 * A move group: what is cut over together (AWS and Google "move group", Azure
 * "dependency group", HCX "Mobility Group", OCI "migration project"). A
 * separate entity from the wave, which is a batch of move groups in time.
 * A single service is one move group in one wave.
 */
export interface MoveGroup {
  readonly id: string;
  readonly items: readonly ItemId[];
  /** Why these items go together, in one line. */
  readonly why: string;
  readonly wave: number;
  readonly method: Method;
  // ---- methodology delta (all optional) ----
  readonly name?: string;
  /** App names in the group (the items are its workloads and databases). */
  readonly apps?: readonly string[];
  /** The rules that formed it (e.g. 'dependency.sync', 'app', 'db.hosts-follow', 'pin'). */
  readonly formedBy?: readonly string[];
  readonly phase?: MigrationPhase;
}
export type WaveKind = 'foundation' | 'app' | 'exit';
/** A wave: move groups, in order, run in one window, with its dates and gates. */
export interface Wave {
  readonly n: number;
  /** Move group ids, in run order. */
  readonly groups: readonly string[];
  readonly start?: string;
  readonly end?: string;
  // ---- addendum A.11.1 and the methodology delta (all optional) ----
  readonly kind?: WaveKind;
  /** What capped the wave's size ('cutoversPerWindow', 'maxPerWave' ...). */
  readonly limitedBy?: string;
  readonly name?: string;
  readonly phase?: MigrationPhase;
  /** The gates the wave passes (A.7.3). */
  readonly gates?: readonly GateId[];
}
export interface WavePlan {
  readonly settings: WaveSettings;
  readonly waves: readonly Wave[];
  readonly groups: readonly MoveGroup[];
  readonly findings: readonly Finding[];
}

// ---------- screen settings that are not requirements ---------------------------

/** Screen 1 (Sources): how the estate becomes rows. Kept so a reload repeats the same import. */
export type MergeMode = 'replace' | 'merge';
/** Pseudo-attributes offered beside the estate's custom attribute keys. */
export type AppAttributeSource = 'folder-leaf' | 'vapp';
export type EnvAttributeSource = 'name-pattern';
export interface IntakeSettings {
  /** '' = the whole estate; else a cluster name or a folder prefix. */
  readonly scope: string;
  readonly includePoweredOff: boolean;
  /** '' | a customAttributes key | 'folder-leaf' | 'vapp'. */
  readonly appAttribute: string;
  /** '' | a customAttributes key | 'name-pattern'. */
  readonly envAttribute: string;
  /** '' | a customAttributes key. */
  readonly ownerAttribute: string;
  readonly mergeMode: MergeMode;
  /** Addendum A.2.1: the app-grouping rules, in order; undefined = the default order. */
  readonly grouping?: readonly GroupingRule[];
}
export type GroupingRuleKind = 'attribute' | 'folder-leaf' | 'vapp' | 'resource-pool' | 'name-regex' | 'cloud-tag' | 'csv-column';
export interface GroupingRule { readonly rule: GroupingRuleKind; readonly key?: string }

/** Screen 9 (Generate). */
export type GeneratePart = 'terraform' | 'ansible' | 'waves' | 'bom' | 'record';
export type StateBackend = 'platform' | 'local' | 's3' | 'azurerm' | 'gcs' | 'oci';
export type ArchiveFormat = 'zip' | 'tar.gz';
export interface GenerateSettings {
  readonly parts: readonly GeneratePart[];
  /** 'platform' = each platform's own backend (s3 / azurerm / gcs / oci; local for vSphere). */
  readonly backend: StateBackend;
  readonly archive: ArchiveFormat;
}

// ---------- modes, origins and sources (addendum A.1.7, A.3) -----------------

export type PlanMode = 'dc-exit' | 'migrate' | 'single' | 'new';
export type AppOrigin = 'migrate' | 'new';
export type SourcePlatform = 'vsphere' | 'hyperv' | 'ahv' | 'kvm' | 'proxmox' | 'ovirt' | 'xen' | 'physical'
  | 'aws' | 'azure' | 'google' | 'oci' | 'power' | 'sparc' | 'itanium' | 'pa-risc' | 'mainframe' | 'other';
export interface SourceRef {
  readonly platform: SourcePlatform;
  /** vCenter / SCVMM / Prism Central / engine / account-subscription-project-compartment. */
  readonly manager?: string;
  /** MoRef / VM GUID / extId / vmid / instance id / resource id / OCID. */
  readonly id?: string;
  readonly host?: string;
  readonly cluster?: string;
  readonly region?: string;
  /** Physical: the Redfish address (never credentials). */
  readonly bmc?: string;
}
export type SizingBasis = 'allocated' | 'utilisation' | 'observed' | 'load';
export interface Utilisation {
  /** The window in days; 0 = one point-in-time sample. */
  readonly days: number;
  readonly samples: number;
  /** 0..1: samples / expected. */
  readonly coverage: number;
  readonly cpuP50Pct?: number;
  readonly cpuP95Pct?: number;
  readonly cpuP99Pct?: number;
  readonly cpuMaxPct?: number;
  readonly memP95Gib?: number;
  readonly memMaxGib?: number;
  readonly iopsP95?: number;
  readonly iopsMax?: number;
  readonly mbpsP95?: number;
  readonly netMbpsP95?: number;
  readonly perDisk?: readonly { readonly disk: number; readonly iopsP95?: number; readonly mbpsP95?: number }[];
}
export type IpStrategy = 're-ip' | 'keep-ip-l2-extension' | 'keep-ip-cloud';
export type OsUpgrade = 'none' | 'before-move' | 'during-move' | 'rebuild' | 'extended-support' | 'accept-risk';

// ---------- workload types and patterns (addendum A.4) -----------------------

export type WorkloadType =
  | 'generic-windows' | 'generic-linux'
  | 'sap-hana' | 'sap-netweaver' | 'sap-java' | 'oracle-ebs' | 'peoplesoft' | 'jd-edwards' | 'siebel' | 'weblogic'
  | 'exchange' | 'sharepoint' | 'dynamics-crm' | 'iis-dotnet' | 'citrix-vda' | 'citrix-infra' | 'rds-host' | 'horizon'
  | 'file-server' | 'nas-gateway' | 'print' | 'websphere' | 'jboss' | 'tomcat' | 'ibm-mq' | 'rabbitmq' | 'kafka'
  | 'ad-ds' | 'dns' | 'dhcp' | 'adcs' | 'ntp' | 'jump-host' | 'k8s-node' | 'openshift-node' | 'docker-host'
  | 'db-host' | 'batch' | 'aix' | 'ibm-i' | 'solaris-sparc' | 'solaris-x86' | 'hp-ux' | 'mainframe'
  | 'appliance-f5' | 'appliance-paloalto' | 'appliance-fortinet' | 'appliance-checkpoint' | 'appliance-cisco' | 'appliance-other'
  | 'unknown';
export type AppKind = 'cots' | 'packaged' | 'home-grown' | 'infrastructure' | 'unknown';
export type AppPattern =
  | 'generic'
  | 'sap-s4hana' | 'sap-ecc-hana' | 'sap-ecc-anydb' | 'sap-bw' | 'sap-netweaver-java' | 'sap-po' | 'sap-hana-native'
  | 'oracle-ebs' | 'peoplesoft' | 'jd-edwards' | 'siebel' | 'weblogic'
  | 'exchange' | 'sharepoint' | 'dynamics-crm' | 'iis-dotnet'
  | 'citrix-vad' | 'rds' | 'horizon' | 'file-server' | 'nas' | 'print'
  | 'websphere' | 'jboss' | 'tomcat' | 'ibm-mq' | 'rabbitmq' | 'kafka'
  | 'ad-ds' | 'dns' | 'dhcp' | 'adcs' | 'ntp' | 'jump-host'
  | 'kubernetes' | 'openshift' | 'docker-host'
  | 'aix' | 'ibm-i' | 'solaris-sparc' | 'solaris-x86' | 'hp-ux' | 'mainframe'
  | 'appliance-f5' | 'appliance-paloalto' | 'appliance-fortinet' | 'appliance-checkpoint' | 'appliance-cisco'
  // greenfield
  | 'web-app' | 'api' | 'microservices' | 'batch-pipeline' | 'database' | 'file-share' | 'vdi' | 'messaging'
  | 'static-site' | 'event-driven' | 'blank';
export type TierPattern = 'vm' | 'vmware-service' | 'paas-web' | 'containers' | 'serverless' | 'static-site' | 'api-gateway'
  | 'batch' | 'workflow' | 'object-storage' | 'managed-db' | 'file-service' | 'vdi-service' | 'saas' | 'sap-certified'
  | 'managed-messaging' | 'managed-kafka' | 'managed-cache' | 'managed-search' | 'appliance' | 'specialist' | 'retire' | 'retain';
export type ComponentTier = 'web' | 'app' | 'integration' | 'data' | 'file' | 'vdi' | 'infra' | 'edge' | 'platform' | 'other';
export type ChangeWindow = 'weekday-night' | 'weekend' | 'any' | 'blackout-only';

// ---------- the application plan (addendum A.2) ------------------------------

export type AppPlanStatus = 'draft' | 'planned' | 'approved';
export type ComponentStatus = 'ok' | 'partial' | 'unresolved' | 'invalid';
export interface ComponentTranslation {
  readonly platform: Platform;
  readonly componentId: string;
  readonly carried: number;
  readonly dropped: readonly { readonly argument: string; readonly value: string; readonly reason: string }[];
}
export interface ComponentBase {
  /** Stable: 'c:<app-slug>:<slug>'. */
  readonly id: string;
  readonly name: string;
  readonly tier: ComponentTier;
  /** Computed; stored for display after translation. */
  readonly status?: ComponentStatus;
  readonly translatedFrom?: ComponentTranslation;
}
export interface PatternComponent extends ComponentBase {
  readonly kind: 'pattern';
  readonly workloadType?: WorkloadType;
  /** undefined = the pattern's default / the engine's choice. */
  readonly tierPattern?: TierPattern;
  /** Workload names. */
  readonly servers: readonly string[];
  /** Database names. */
  readonly databases: readonly string[];
  /** Pattern settings, 'key' → value. */
  readonly settings: Readonly<Record<string, string>>;
}
export interface ResourceComponent extends ComponentBase {
  readonly kind: 'resource';
  /** e.g. 'aws_s3_bucket'. */
  readonly type: string;
  /** The Terraform page's per-resource blueprint id. */
  readonly blueprintId: string;
  /** The blueprint's own input ids → strings, exactly as the Terraform page saves them. */
  readonly values: Readonly<Record<string, string>>;
}
export interface ConfigComponent extends ComponentBase {
  readonly kind: 'config';
  /** 'mig_*' / pattern role / 'mod_<fqcn>'. */
  readonly blueprintId: string;
  readonly values: Readonly<Record<string, string>>;
  /** Component ids and/or workload names; [] = all servers of the app. */
  readonly appliesTo: readonly string[];
  readonly order: number;
}
export type AppComponent = PatternComponent | ResourceComponent | ConfigComponent;
export type ComponentKind = AppComponent['kind'];
export type IngressExposure = 'internal' | 'public';
export type IngressLb = 'none' | 'l4' | 'l7';
export type IngressTls = 'terminate' | 'passthrough';
export interface AppIngress {
  readonly fqdns: readonly string[];
  readonly exposure: IngressExposure;
  readonly lb: IngressLb;
  readonly tls: IngressTls;
  readonly waf: boolean;
}
export type CostClass = 'static' | 'light' | 'typical' | 'heavy';
export type Slo = '99.0' | '99.5' | '99.9' | '99.95' | '99.99';
export type HorizonYears = 1 | 3 | 5;
export type NonprodPct = 10 | 25 | 50 | 100;
export interface LoadProfile {
  readonly users?: number;
  readonly concurrentUsers?: number;
  readonly peakRps?: number;
  readonly payloadKb?: number;
  readonly costClass?: CostClass;
  readonly dataGib?: number;
  readonly growthPctYear?: number;
  readonly horizonYears?: HorizonYears;
  readonly tps?: number;
  readonly slo?: Slo;
  readonly p95Ms?: number;
  readonly environments: readonly Env[];
  readonly nonprodPct: NonprodPct;
}
export type SmokeKind = 'http' | 'tcp' | 'sql';
export interface SmokeCheck { readonly kind: SmokeKind; readonly target: string; readonly expect?: string; readonly maxMs?: number }
export type LandingZoneMode = 'shared' | 'included';
export interface AppPlan {
  /** App.id. */
  readonly app: ItemId;
  readonly origin: AppOrigin;
  readonly status: AppPlanStatus;
  /** Chosen; undefined = follow the recommendation. */
  readonly platform?: Platform;
  /** One component set per platform used or previewed. */
  readonly variants: Readonly<Partial<Record<Platform, readonly AppComponent[]>>>;
  /** Pattern assessment answers. */
  readonly answers: Readonly<Record<string, string>>;
  readonly ingress?: AppIngress;
  /** Origin 'new'. */
  readonly load?: LoadProfile;
  readonly smoke?: readonly SmokeCheck[];
  /** 6R for migrate apps. */
  readonly route?: Disposition;
  readonly landingZone: LandingZoneMode;
  readonly savedAt?: string;
  readonly recommendation?: { readonly platform: Platform; readonly score: number; readonly engineVersion: string };
  /** Component ids accepted as dropped on a platform. */
  readonly leftOut?: Readonly<Partial<Record<Platform, readonly string[]>>>;
  // ---- methodology delta (all optional) ----
  /** The provider-style strategy (11 Rs); undefined = `strategyOf(route)`. */
  readonly strategy?: MigrationStrategy;
  readonly phase?: MigrationPhase;
}
export interface AppRecommendation {
  readonly app: ItemId;
  readonly perPlatform: readonly {
    readonly platform: Platform;
    readonly eligible: boolean;
    readonly score: number;
    readonly eliminatedBy: readonly string[];
    readonly topHits: readonly RuleHit[];
  }[];
  readonly recommended?: Platform;
  readonly margin: number;
  readonly tooClose: boolean;
}

// ---------- sizing (addendum A.2.8) ------------------------------------------

export type SizingConcern = 'server' | 'storage' | 'k8s' | 'database' | 'sap' | 'vdi' | 'file' | 'vcf' | 'load';
export type Percentile = 'p50' | 'p90' | 'p95' | 'p99' | 'max';
export type SizingPolicyBasis = 'auto' | 'allocated' | 'utilisation-only';
export type HeadroomPct = 0 | 10 | 20 | 30 | 50;
export type DiskBasis = 'provisioned' | 'used-plus-headroom';
export type GrowthPctYear = 0 | 10 | 20 | 30;
export type InstanceFamily = 'general' | 'compute' | 'memory' | 'burstable' | 'storage' | 'gpu';
/** 'as-is' = allocation; 'performance' = utilisation (Azure Migrate, Google Migration Center). */
export type SizingMode = 'as-is' | 'performance';
/** Per resource: a percentile, the allocation, or OCI's AVERAGE (taken as P50). */
export type ResourceStrategy = Percentile | 'as-is' | 'average';
export type HeadroomStyle = 'comfort-factor' | 'target-utilisation';
export interface SizingPolicy {
  readonly basis: SizingPolicyBasis;
  readonly percentile: Percentile;
  readonly headroomPct: HeadroomPct;
  readonly diskBasis: DiskBasis;
  readonly growthPctYear: GrowthPctYear;
  readonly horizonYears: HorizonYears;
  readonly families: readonly InstanceFamily[];
  readonly burstableInProd: boolean;
  readonly allowArm: boolean;
  readonly latestGeneration: boolean;
  readonly licenceOptimised: boolean;
  /** Default: from `basis`. */
  readonly mode?: SizingMode;
  /** Default: `percentile`. */
  readonly cpuStrategy?: ResourceStrategy;
  readonly memoryStrategy?: ResourceStrategy;
  /** Default 'comfort-factor' (headroomPct). */
  readonly headroomStyle?: HeadroomStyle;
  /** Target utilisation for 'target-utilisation', percent. Google moderate 70 / 85, aggressive 90 / 100. */
  readonly cpuTargetPct?: number;
  readonly memoryTargetPct?: number;
  /** Source CPU score ÷ target CPU score (OCI's adjustment multiplier). Default 1. */
  readonly benchmarkMultiplier?: number;
  /** The load engine's planning assumptions, editable. */
  readonly assumptions: Readonly<Record<string, number>>;
}
export interface SizingReason { readonly text: string; readonly fact?: string; readonly source?: string; readonly assumption?: boolean }
export interface SizingRow {
  /** 'server:<name>' | 'volume:<name>:<n>' | 'pool:<component>:<pool>' | 'db:<name>' | … */
  readonly key: string;
  readonly demand: Readonly<Record<string, number>>;
  /** Size / class / tier / node type / host count. */
  readonly choice: string;
  readonly detail: Readonly<Record<string, string | number>>;
  readonly fits: boolean;
  readonly reasons: readonly SizingReason[];
  readonly alternatives: readonly string[];
}
export interface SizingRecommendation { readonly concern: SizingConcern; readonly platform: Platform; readonly rows: readonly SizingRow[]; readonly findings: readonly Finding[] }
/** `overrides`: row key → chosen value. */
export interface SizingState { readonly policy: SizingPolicy; readonly overrides: Readonly<Record<string, string>> }

// ---------- execution (addendum A.6) -----------------------------------------

/** A server's move path: the generated script family that moves it. */
export type MovePath = 'hcx-bulk' | 'hcx-rav' | 'hcx-vmotion' | 'hcx-cold' | 'hcx-osam' | 'xvc-vmotion' | 'vcf-import' | 'vcf-converter'
  | 'aws-mgn' | 'azure-migrate' | 'azure-migrate-hyperv' | 'azure-migrate-agent' | 'gcp-m2vm' | 'gcp-image-import' | 'oci-ocm'
  | 'rebuild' | 'with-db' | 'retire' | 'specialist' | 'deploy'
  | 'sap-hsr' | 'sap-backup-restore' | 'saas-exchange' | 'saas-sharepoint' | 'k8s-velero' | 'appliance-rebuild';
/** A database's move path. */
export type DbMovePath = 'with-vm' | 'oracle-zdm-physical' | 'oracle-zdm-logical' | 'oracle-dataguard' | 'oracle-rman' | 'oracle-datapump'
  | 'oci-dms' | 'aws-dms' | 'azure-dms' | 'azure-pg-migration' | 'gcp-dms'
  | 'sql-ag-seeding' | 'sql-log-shipping' | 'sql-backup-url' | 'sql-mi-link' | 'sql-mi-lrs' | 'sql-rds-native'
  | 'pg-logical' | 'pg-dump' | 'mysql-replication' | 'mysql-dump'
  | 'db2-backup-restore' | 'db2-hadr' | 'ase-dump-load' | 'informix-backup-restore' | 'mongo-mongosync'
  | 'redis-replicaof' | 'redis-rdb-import' | 'cassandra-zdm-proxy' | 'cassandra-ring-join' | 'es-snapshot-restore' | 'es-reindex-remote';
export type DnsProvider = 'route53' | 'azure-dns' | 'azure-private-dns' | 'cloud-dns' | 'oci-dns' | 'windows-dns' | 'infoblox';
export type LbKind = 'none' | 'aws-elbv2' | 'azure-lb' | 'gcp-neg' | 'oci-lb' | 'f5-bigip' | 'avi';
export type DataCopyMethod = 'robocopy' | 'rsync' | 'datasync' | 'storage-mover' | 'storage-transfer' | 'azcopy' | 'rclone';
export type LandingZoneState = 'designed' | 'generated';
export type MgnReplication = 'agent' | 'agentless';
export type MgnIpProtocol = 'IPV4' | 'IPV6';
export type AzureMigrateDiskType = 'Premium_LRS' | 'PremiumV2_LRS' | 'StandardSSD_LRS';
export type AzureSecurityType = 'TrustedLaunch' | 'None';
export type DmsCapacityUnits = 4 | 8 | 16 | 32 | 64;
export type HcxWindowHours = 1 | 2 | 4 | 8;
export interface DnsZoneSetting { readonly zone: string; readonly provider: DnsProvider; readonly zoneId?: string; readonly view?: string; readonly private: boolean }
export interface LbSetting { readonly app: string; readonly kind: LbKind; readonly pool: string; readonly port: number }
export interface DataSetSetting { readonly workload: string; readonly source: string; readonly target: string; readonly method: DataCopyMethod; readonly exclude?: string }
export interface ExecutionSettings {
  readonly pathOverrides: Readonly<Record<ItemId, MovePath | DbMovePath>>;
  readonly keepDays: Readonly<Record<Criticality, number>>;
  readonly hypercareDays: Readonly<Record<Criticality, number>>;
  readonly lagSeconds: { readonly server: number; readonly db: number };
  readonly dnsZones: readonly DnsZoneSetting[];
  readonly lbs: readonly LbSetting[];
  readonly hcx?: {
    readonly sourceSite: string;
    readonly destSite: string;
    readonly extend: readonly string[];
    readonly mappings: readonly { readonly from: string; readonly to: string }[];
    readonly container?: string;
    readonly datastore?: string;
    readonly folder?: string;
    readonly windowHours: HcxWindowHours;
  };
  readonly mgn?: { readonly replication: MgnReplication; readonly serverType: string; readonly bandwidthMbps: number; readonly ip: MgnIpProtocol };
  readonly azureMigrate?: { readonly project: string; readonly appliance: string; readonly diskType: AzureMigrateDiskType; readonly securityType: AzureSecurityType };
  readonly m2vm?: { readonly source: string; readonly targetProject: string };
  readonly ocm?: { readonly environment: string; readonly bucket: string; readonly schedule: string };
  readonly dms?: { readonly maxCapacityUnits: DmsCapacityUnits };
  readonly dataSets: readonly DataSetSetting[];
  readonly vcfImportClusters: readonly string[];
  readonly landingZones: Readonly<Partial<Record<Platform, LandingZoneState>>>;
}

// ---------- governance (addendum A.10) ---------------------------------------

export type RaciRole = 'migration-lead' | 'app-owner' | 'infra-vmware' | 'cloud-platform' | 'network' | 'security' | 'dba'
  | 'service-desk' | 'change-manager' | 'vendor';
export type RaciCell = 'R' | 'A' | 'C' | 'I';
export type RaciPhase = 'migrate' | 'run';
export interface RaciRow { readonly activity: string; readonly phase: RaciPhase; readonly cells: Readonly<Partial<Record<RaciRole, RaciCell>>> }
export type CrSystem = 'none' | 'servicenow' | 'csv';
export type Cicd = 'none' | 'github-actions' | 'azure-devops' | 'gitlab-ci';
export interface Governance {
  readonly raci: readonly RaciRow[];
  readonly cr: { readonly system: CrSystem; readonly perWave: boolean };
  /** Text placed in the templates, entered by the user. */
  readonly comms: { readonly helpdesk?: string; readonly sender?: string };
  readonly cicd: Cicd;
  readonly environments: readonly Env[];
}

// ---------- data-centre exit (addendum A.5.5) --------------------------------

export type InfraCategory = 'network-device' | 'circuit' | 'subnet' | 'net-service' | 'storage-array' | 'backup' | 'archive'
  | 'security-service' | 'ops-tool' | 'job' | 'telephony' | 'print' | 'ot-iot' | 'other';
export type InfraDisposition = 'migrate' | 'replace' | 'retire' | 'stays' | 'n/a';
export interface InfraItem {
  readonly id: string;
  readonly category: InfraCategory;
  readonly name: string;
  readonly vendor?: string;
  readonly model?: string;
  readonly site?: string;
  readonly owner?: string;
  readonly disposition?: InfraDisposition;
  readonly target?: string;
  readonly afterWave?: number;
  readonly date?: string;
  /** Category-specific columns (platform, config file, bandwidth, retention, legal hold, schedule …). */
  readonly facts: Readonly<Record<string, string>>;
}
export type ExternalKind = 'partner-allowlist' | 'b2b-edi' | 'sftp' | 'inbound-api' | 'vendor-support' | 'user-access' | 'outbound-saas';
export type ExternalDirection = 'in' | 'out' | 'both';
export interface ExternalLink {
  readonly id: string;
  readonly kind: ExternalKind;
  readonly party: string;
  readonly direction: ExternalDirection;
  readonly protocol: string;
  readonly endpoint: string;
  readonly currentIps: readonly string[];
  readonly app?: string;
  readonly owner?: string;
  readonly noticeDays: number;
}
export type ContractKind = 'support' | 'maintenance' | 'colocation' | 'power' | 'circuit' | 'licence' | 'lease';
export type ContractStatus = 'active' | 'notice-given' | 'terminated';
export interface Contract { readonly id: string; readonly kind: ContractKind; readonly vendor: string; readonly ends: string; readonly noticeDays: number; readonly status?: ContractStatus }
/** NIST SP 800-88 media sanitisation methods. */
export type Sanitisation = 'clear' | 'purge' | 'destroy';
export interface Asset {
  readonly id: string;
  readonly kind: string;
  readonly serial?: string;
  readonly location?: string;
  readonly containsData: boolean;
  readonly sanitisation?: Sanitisation;
  readonly certificateId?: string;
  readonly disposedOn?: string;
  readonly registerUpdated?: boolean;
}
export interface DcExit {
  readonly exitDate?: string;
  readonly dualRunningDays: number;
  readonly hardwareRemovalDays: number;
  readonly infra: readonly InfraItem[];
  readonly external: readonly ExternalLink[];
  readonly contracts: readonly Contract[];
  readonly assets: readonly Asset[];
}

// ---------- other records in the `plan` store (addendum A.11.2) --------------

/** A utility run (the Utilities area, A.9); stored under the `changes` key. */
export interface ChangeRecord {
  readonly id: string;
  readonly utility: string;
  readonly target: string;
  readonly summary: string;
  readonly values: Readonly<Record<string, string>>;
  readonly generatedAt: string;
  readonly appliedAt?: string;
  readonly rolledBackAt?: string;
  readonly cr?: string;
}
export type RateCategory = 'compute' | 'storage' | 'db' | 'network' | 'licence' | 'service' | 'facility';
export interface RateRow {
  readonly platform: Platform | 'on-prem';
  readonly region: string;
  readonly category: RateCategory;
  readonly key: string;
  readonly unit: string;
  readonly rate: number;
  readonly currency: string;
  readonly source: string;
}
export const RATECARD_KIND = 'archtoolkit.ratecard';
export interface RateCard { readonly kind: typeof RATECARD_KIND; readonly v: 1; readonly rows: readonly RateRow[] }
/** Which page wrote an audit entry ('migration-change' is the Multi-Cloud Migration & Utilities page). */
export type AuditPage = 'application-migration' | 'migration-change';
export interface AuditEntry {
  readonly at: string;
  readonly page: AuditPage;
  readonly area: string;
  readonly action: string;
  readonly targets: readonly string[];
  readonly summary: string;
  readonly role?: RaciRole;
}

// ---------- tracker and the status contract (addendum A.11.3) ----------------

export type ItemState = 'planned' | 'prepared' | 'replicating' | 'in-sync' | 'testing' | 'tested'
  | 'cutting-over' | 'cut-over' | 'validated' | 'accepted' | 'decommissioned';
export type ItemFlag = 'blocked' | 'failed' | 'rolled-back' | 'on-hold';
export type StepId = 'precheck' | 'prepare' | 'replicate' | 'in-sync' | 'test' | 'test-cleanup' | 'freeze' | 'final-sync'
  | 'stop-source' | 'cutover' | 'start-target' | 'adopt' | 'dns-switch' | 'lb-switch' | 'post-config' | 'identity'
  | 'validate' | 'commit' | 'accept' | 'rollback' | 'decommission' | 'finalize' | 'notice' | 'gate' | 'deploy' | 'manual';
export type Outcome = 'started' | 'succeeded' | 'failed' | 'skipped';
/** Status-event channels that are not a move path ('change' is a Utilities run). */
export type StatusChannel = 'orchestrator' | 'dns' | 'lb' | 'change' | 'gate';
export type StatusEventSource = 'script' | 'manual' | 'validation';
export const STATUS_EVENT_KIND = 'archtoolkit.migration-status';
export interface StatusEvent {
  readonly kind: typeof STATUS_EVENT_KIND;
  readonly v: 1;
  readonly planId: string;
  readonly runId: string;
  /** UTC ISO; no user, host or path anywhere in an event. */
  readonly at: string;
  readonly wave: number | null;
  readonly item: ItemId | null;
  readonly name?: string;
  readonly path: MovePath | DbMovePath | StatusChannel;
  readonly step: StepId;
  readonly outcome: Outcome;
  readonly dryRun: boolean;
  readonly state?: ItemState;
  readonly detail?: string;
  readonly data?: Readonly<Record<string, string | number | boolean>>;
  readonly source?: StatusEventSource;
}
export type ItemStatusKind = 'workload' | 'database' | 'app-deploy' | 'infra';
export interface ItemStatus {
  readonly item: ItemId;
  readonly kind: ItemStatusKind;
  readonly wave: number;
  readonly path: MovePath | DbMovePath;
  readonly state: ItemState;
  readonly since: string;
  readonly flags: readonly ItemFlag[];
  readonly lastEvent?: string;
  readonly lastError?: string;
  readonly rollbacks: number;
  readonly sync?: { readonly progressPct?: number; readonly lagSeconds?: number };
  readonly removed?: boolean;
  /** Methodology delta: the phase the item is in; undefined = `ITEM_STATE_PHASE[state]`. */
  readonly phase?: MigrationPhase;
  /** Methodology delta: the move group (`MoveGroup.id`). */
  readonly moveGroup?: string;
}
export type GateId = 'G1' | 'G2' | 'G3' | 'G4' | 'G5';
export type GateDecision = 'go' | 'no-go';
export interface GateCriterion { readonly id: string; readonly auto: boolean; readonly met: boolean; readonly detail: string }
export interface GateRecord {
  readonly wave: number | 'programme';
  readonly gate: GateId;
  readonly decision: GateDecision;
  readonly at: string;
  readonly role: RaciRole;
  readonly comment?: string;
  readonly criteria: readonly GateCriterion[];
}
export type SignOffScope = 'app' | 'wave' | 'plan' | 'dc';
export type SignOffKind = 'plan-approved' | 'design-approved' | 'test-passed' | 'go' | 'accepted' | 'decom-approved' | 'lights-out';
export type SignOffDecision = 'approved' | 'rejected';
export interface SignOff {
  readonly scope: SignOffScope;
  readonly id: string;
  readonly kind: SignOffKind;
  readonly role: RaciRole;
  readonly decision: SignOffDecision;
  readonly at: string;
  readonly comment?: string;
}
/** Probability and impact, 1 (low) to 5 (high). */
export type RaidScore = 1 | 2 | 3 | 4 | 5;
export type RiskResponse = 'avoid' | 'reduce' | 'transfer' | 'accept';
export type RiskStatus = 'open' | 'mitigating' | 'closed' | 'occurred';
export interface RaidRisk {
  readonly id: string;
  readonly risk: string;
  readonly wave?: number;
  readonly app?: string;
  readonly probability: RaidScore;
  readonly impact: RaidScore;
  readonly owner?: string;
  readonly response: RiskResponse;
  readonly mitigation?: string;
  readonly status: RiskStatus;
  readonly reviewBy?: string;
}
export type AssumptionStatus = 'open' | 'confirmed' | 'false';
export interface RaidAssumption { readonly id: string; readonly assumption: string; readonly owner?: string; readonly validateBy?: string; readonly status: AssumptionStatus; readonly evidence?: string }
export type IssueSeverity = 'sev1' | 'sev2' | 'sev3' | 'sev4';
export type IssueStatus = 'open' | 'in-progress' | 'resolved' | 'closed';
export type IssueOrigin = 'manual' | 'coupling' | 'capacity' | 'validation' | 'licence';
export interface RaidIssue {
  readonly id: string;
  readonly issue: string;
  readonly severity: IssueSeverity;
  readonly wave?: number;
  readonly blocks: readonly string[];
  readonly owner?: string;
  readonly opened: string;
  readonly due?: string;
  readonly status: IssueStatus;
  readonly resolution?: string;
  readonly origin?: IssueOrigin;
}
export type DecisionSource = 'manual' | 'gate' | 'rollback' | 're-wave' | 'pin' | 'what-if' | 'platform-switch' | 'left-out';
export interface RaidDecision {
  readonly id: string;
  readonly decision: string;
  readonly rationale?: string;
  readonly by?: RaciRole;
  readonly date: string;
  readonly source: DecisionSource;
  readonly links: readonly string[];
}
export interface DecomRecord { readonly item: ItemId; readonly at: string; readonly hostsFreed?: number; readonly backupVerified: boolean; readonly cmdbUpdated: boolean }
export type ReclaimedLicence = LicenceKind | 'vcf-core' | 'third-party';
export type LicenceReclaimStatus = 'freed' | 'reassigned' | 'terminated';
export interface LicenceReclaim {
  readonly licence: ReclaimedLicence;
  readonly count: number;
  readonly source: string;
  readonly freedOn: string;
  readonly reassignedTo?: string;
  readonly status: LicenceReclaimStatus;
}
export type CrStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'closed';
export interface TrackerNotice { readonly template: string; readonly wave?: number; readonly link?: string; readonly sentAt: string }
export interface TrackerCr { readonly id: string; readonly number?: string; readonly status: CrStatus }
export interface TrackerRaid {
  readonly risks: readonly RaidRisk[];
  readonly assumptions: readonly RaidAssumption[];
  readonly issues: readonly RaidIssue[];
  readonly decisions: readonly RaidDecision[];
}
export const TRACKER_KIND = 'archtoolkit.migration-tracker';
export interface Tracker {
  readonly kind: typeof TRACKER_KIND;
  readonly version: 1;
  readonly planId: string;
  readonly savedAt: string;
  readonly items: Readonly<Record<ItemId, ItemStatus>>;
  readonly events: readonly StatusEvent[];
  readonly gates: readonly GateRecord[];
  readonly signoffs: readonly SignOff[];
  readonly raid: TrackerRaid;
  readonly notices: readonly TrackerNotice[];
  readonly crs: readonly TrackerCr[];
  readonly decommissions: readonly DecomRecord[];
  readonly licences: readonly LicenceReclaim[];
}

// ---------- methodology: phases, strategies, methods, terms, service status ----
// (cloud-migration-methodologies research, sections 6(a), 6(d), 6(e) 1–3)

/** The unified phase model P0–P9. A single service runs the same phases for one move group in one wave. */
export type MigrationPhase = 'strategy' | 'discover-assess' | 'plan' | 'foundation' | 'prepare-pilot' | 'replicate-test'
  | 'cutover' | 'hypercare' | 'decommission' | 'optimize';
/** A phase, or the governance track (G) that runs beside all of them. */
export type Workstream = MigrationPhase | 'governance';
/** The canonical 11 Rs; the provider's own word is `strategyLabel(s, platform)`. `repurchase` is Replace / Repurchase. */
export type MigrationStrategy = 'retire' | 'retain' | 'rehost' | 'relocate' | 'replatform' | 'refactor' | 'revise'
  | 'rearchitect' | 'rebuild' | 'repurchase' | 'reimagine';
/** Execution methods: the provider tool that carries out a strategy (per-provider lists, research 6(e) 3). */
export type ExecutionMethod =
  | 'aws-transform-mgn' | 'aws-vm-import' | 'aws-dms' | 'aws-datasync' | 'aws-app2container'
  | 'azure-migrate-agentless' | 'azure-migrate-agent' | 'azure-dms' | 'azure-data-box' | 'azure-storage-mover'
  | 'gcp-m2vm' | 'gcp-m2c' | 'gcp-image-import' | 'gcp-dms' | 'gcp-sts' | 'gcp-transfer-appliance'
  | 'oci-ocm' | 'oci-zdm-physical' | 'oci-zdm-logical' | 'oci-dms' | 'oracle-data-guard'
  | 'hcx-bulk' | 'hcx-vmotion' | 'hcx-cold' | 'hcx-rav' | 'hcx-osam' | 'hcx-assisted-vmotion' | 'xvc-vmotion'
  | 'vcf-import' | 'vcf-converter'
  | 'rebuild' | 'with-server' | 'native-db' | 'sap-hsr' | 'saas-migration' | 'k8s-velero' | 'deploy' | 'specialist' | 'none';
/** Where an execution method belongs: one provider, or any. */
export type MethodProvider = Platform | 'any';
/** Concepts each provider names differently (research 6(d)). */
export type ProviderTerm = 'framework' | 'phases' | 'move-group' | 'wave' | 'iteration' | 'factory' | 'readiness'
  | 'sizing-basis' | 'data-quality' | 'cost-document' | 'test-run' | 'cutover' | 'rollback' | 'hypercare'
  | 'landing-zone' | 'collector';
/** A tool or service's standing, for warnings when a retired one is chosen. */
export type ServiceStatusKind = 'available' | 'renamed' | 'closed-to-new-customers' | 'end-of-support' | 'retired' | 'removed' | 'reintroduced' | 'ga';
export interface ServiceStatusEntry {
  readonly id: string;
  readonly platform: Platform;
  readonly name: string;
  readonly status: ServiceStatusKind;
  /** ISO date of the change, where the vendor states one. */
  readonly since?: string;
  readonly replacement?: string;
  readonly note: string;
  readonly source: string;
  readonly verification: Verification;
  /** When the entry was last checked (ISO date). */
  readonly asOf: string;
}
/** The provider tools whose lifecycle vocabulary the tracker can show. */
export type LifecycleTool = 'aws-transform-mgn' | 'azure-migrate' | 'gcp-m2vm' | 'gcp-dms' | 'hcx-mobility-group' | 'oci-ocm';
export interface ProviderLifecycleState {
  readonly tool: LifecycleTool;
  /** The provider's own name for the state. */
  readonly label: string;
  /** The tracker state it maps to; undefined = leaves the state as it is. */
  readonly state?: ItemState;
  /** A flag it raises (e.g. a "needs attention" state). */
  readonly flag?: ItemFlag;
  readonly source: string;
  readonly verification: Verification;
}

// ---------- the plan and its output ------------------------------------------

export const PLAN_KIND = 'archtoolkit.multicloud-plan';
export type PlanKind = typeof PLAN_KIND;

export interface Plan {
  readonly kind: PlanKind;
  readonly version: 1;
  /** Random at creation; seeds the Azure ULA. */
  readonly id: string;
  readonly name: string;
  readonly savedAt: string;
  readonly workloads: readonly Workload[];
  readonly databases: readonly Database[];
  readonly apps: readonly App[];
  readonly edges: readonly DependencyEdge[];
  readonly requirements: Requirements;
  /** Cached; recomputed on change. */
  readonly decision?: PlanDecision;
  readonly designOverrides: Readonly<Record<string, string>>;
  readonly waveSettings: WaveSettings;
  readonly intake?: IntakeSettings;
  readonly generate?: GenerateSettings;
  // ---- addendum A.11.1 (all optional; `planFromEnvelope` fills the defaults) ----
  /** Default 'migrate'. */
  readonly mode?: PlanMode;
  /** Default []. */
  readonly appPlans?: readonly AppPlan[];
  readonly sizing?: SizingState;
  readonly execution?: ExecutionSettings;
  readonly governance?: Governance;
  readonly dcExit?: DcExit;
}
/** The A.11.1 `PlanDelta`. */
export type PlanDelta = Pick<Plan, 'mode' | 'appPlans' | 'sizing' | 'execution' | 'governance' | 'dcExit'>;
export interface GeneratedProject {
  /** path → text; handed to kit/archive zip(). */
  readonly files: Readonly<Record<string, string>>;
  readonly findings: readonly Finding[];
  readonly handoffs: {
    readonly terraform: Partial<Record<Platform, TerraformSettingsEnvelope>>;
    readonly ansible?: AnsibleSettingsEnvelope;
  };
}
export interface SettingsStackItem {
  readonly id: string;
  readonly blueprintId: string;
  readonly label: string;
  readonly values: Record<string, string>;
}
/** What generator-page.ts `load` already accepts (settings-file envelope). */
export interface TerraformSettingsEnvelope {
  readonly kind: 'archtoolkit.terraform-generator';
  readonly version: 1;
  readonly savedAt: string;
  readonly target: 'aws' | 'azure' | 'google' | 'oci' | 'vsphere';
  readonly blueprint: string;
  readonly values: Record<string, string>;
  readonly stackName: string;
  readonly stack: readonly SettingsStackItem[];
}
export interface AnsibleSettingsEnvelope {
  readonly kind: 'archtoolkit.ansible-generator';
  readonly version: 1;
  readonly savedAt: string;
  readonly target: 'linux';
  readonly blueprint: string;
  readonly values: Record<string, string>;
  readonly stackName: string;
  readonly stack: readonly SettingsStackItem[];
}
