/**
 * The Multi-Cloud Planner's data model: one serialisable `Plan`, the decision
 * made from it, the target design and the waves.
 *
 * Every other planner module codes against these types, so they change only by
 * a deliberate, reviewed edit. Every closed set here has an option table in
 * `options.ts`, which is the single source for the dropdowns and the CSV, and
 * a test proves the two agree in both directions.
 *
 * Nothing here is behaviour: this file is types, plus the one constant that
 * names the plan's file kind.
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
export type Disposition = 'rehost' | 'relocate' | 'replatform' | 'refactor' | 'repurchase' | 'retire' | 'retain';
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
}
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
}

export type DbEngine = 'oracle' | 'sqlserver' | 'postgres' | 'mysql' | 'mariadb' | 'db2' | 'mongodb' | 'sybase-ase' | 'other';
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
}
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

export type DbServiceId =
  | 'aws-rds' | 'aws-rds-custom' | 'aws-aurora' | 'aws-ec2' | 'aws-odb-exadata' | 'aws-odb-adb'
  | 'azure-sqldb' | 'azure-sqlmi' | 'azure-sqlvm' | 'azure-pg-flex' | 'azure-mysql-flex' | 'azure-vm'
  | 'azure-odb-exadata' | 'azure-odb-adb'
  | 'google-cloudsql' | 'google-alloydb' | 'google-gce' | 'google-odb-exadata' | 'google-odb-adb' | 'google-odb-basedb'
  | 'oci-adb' | 'oci-basedb' | 'oci-exacs' | 'oci-mysql-heatwave' | 'oci-pg' | 'oci-compute'
  | 'vmware-vm';
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
}
export interface MoveGroup { readonly id: string; readonly items: readonly ItemId[]; readonly why: string; readonly wave: number; readonly method: Method }
export interface WavePlan {
  readonly settings: WaveSettings;
  readonly waves: readonly { readonly n: number; readonly groups: readonly string[]; readonly start?: string; readonly end?: string }[];
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
}

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
}
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
