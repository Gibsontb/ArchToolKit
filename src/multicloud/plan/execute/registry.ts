/**
 * The path-generator registry: one generator per `MovePath` / `DbMovePath`
 * (addendum A.12.1, WP-11a).
 *
 * The interface is `PathGenerator`. Each path belongs to exactly one package
 * (`PATH_OWNERS`, exhaustive over both unions by type), and a generator may
 * only register the paths its package owns:
 *
 *   WP-11a (here)  with-db, with-vm, retire, specialist — the core script, no tool
 *   WP-11b         HCX (bulk, RAV, vMotion, cold, OSAM), xvc-vmotion, vcf-import, vcf-converter, rebuild
 *   WP-11c         aws-mgn, azure-migrate*, gcp-m2vm, gcp-image-import, oci-ocm
 *   WP-11d         the Oracle, SQL Server, PostgreSQL, MySQL and cloud DMS paths
 *   WP-17          the pattern paths (A.4.2) and the databases beyond the core (A.4.9)
 *   WP-20          deploy (A.9.3; new services are not part of a wave kit)
 *
 * Wiring: each package's module exports `GENERATORS: readonly PathGenerator[]`
 * (`PATH_MODULES` lists the files). When a module lands, its import is added
 * to `BUILT_IN` below — the only edit this file plans for. Until then the
 * modules (or tests) call `registerPathGenerator`, or pass a registry to
 * `executionKit`. A path with no generator gets the "pending" script, whose
 * verbs fail honestly (exit 10) with the owner's name, so nothing pretends
 * to have moved.
 */

import type { Finding } from '../../../core/findings.ts';
import { DB_MOVE_PATH_VALUES, MOVE_PATH_VALUES } from '../options.ts';
import type { ExecutionSettings, ItemId, Plan, PlanDecision, TargetDesign, Tracker, WavePlan } from '../types.ts';
import type { ExecPath } from './contract.ts';
import { shScript } from './lib-sh.ts';
import type { Manifest, ManifestItem } from './manifest.ts';
import type { PathResolution } from './paths.ts';

export type PackageId = 'WP-11a' | 'WP-11b' | 'WP-11c' | 'WP-11d' | 'WP-17' | 'WP-20';

/** Who generates each path. A missing path is a type error (the exhaustiveness check). */
export const PATH_OWNERS: Readonly<Record<ExecPath, PackageId>> = Object.freeze({
  // servers
  'hcx-bulk': 'WP-11b', 'hcx-rav': 'WP-11b', 'hcx-vmotion': 'WP-11b', 'hcx-cold': 'WP-11b', 'hcx-osam': 'WP-11b',
  'xvc-vmotion': 'WP-11b', 'vcf-import': 'WP-11b', 'vcf-converter': 'WP-11b', rebuild: 'WP-11b',
  'aws-mgn': 'WP-11c', 'azure-migrate': 'WP-11c', 'azure-migrate-hyperv': 'WP-11c', 'azure-migrate-agent': 'WP-11c',
  'gcp-m2vm': 'WP-11c', 'gcp-image-import': 'WP-11c', 'oci-ocm': 'WP-11c',
  'with-db': 'WP-11a', retire: 'WP-11a', specialist: 'WP-11a', deploy: 'WP-20',
  'sap-hsr': 'WP-17', 'sap-backup-restore': 'WP-17', 'saas-exchange': 'WP-17', 'saas-sharepoint': 'WP-17', 'k8s-velero': 'WP-17',
  'appliance-rebuild': 'WP-17',
  // databases
  'with-vm': 'WP-11a',
  'oracle-zdm-physical': 'WP-11d', 'oracle-zdm-logical': 'WP-11d', 'oracle-dataguard': 'WP-11d', 'oracle-rman': 'WP-11d',
  'oracle-datapump': 'WP-11d', 'oci-dms': 'WP-11d', 'aws-dms': 'WP-11d', 'azure-dms': 'WP-11d', 'azure-pg-migration': 'WP-11d',
  'gcp-dms': 'WP-11d', 'sql-ag-seeding': 'WP-11d', 'sql-log-shipping': 'WP-11d', 'sql-backup-url': 'WP-11d', 'sql-mi-link': 'WP-11d',
  'sql-mi-lrs': 'WP-11d', 'sql-rds-native': 'WP-11d', 'pg-logical': 'WP-11d', 'pg-dump': 'WP-11d', 'mysql-replication': 'WP-11d',
  'mysql-dump': 'WP-11d',
  'db2-backup-restore': 'WP-17', 'db2-hadr': 'WP-17', 'ase-dump-load': 'WP-17', 'informix-backup-restore': 'WP-17',
  'mongo-mongosync': 'WP-17', 'redis-replicaof': 'WP-17', 'redis-rdb-import': 'WP-17', 'cassandra-zdm-proxy': 'WP-17',
  'cassandra-ring-join': 'WP-17', 'es-snapshot-restore': 'WP-17', 'es-reindex-remote': 'WP-17',
} satisfies Record<ExecPath, PackageId>);

/** Every path, servers then databases. */
export const ALL_EXEC_PATHS: readonly ExecPath[] = Object.freeze([...MOVE_PATH_VALUES, ...DB_MOVE_PATH_VALUES]);

/** The modules each package delivers (each exports `GENERATORS: readonly PathGenerator[]`), relative to this folder. */
export const PATH_MODULES: Readonly<Record<Exclude<PackageId, 'WP-11a' | 'WP-20'>, readonly string[]>> = Object.freeze({
  'WP-11b': ['./paths/hcx.ts', './paths/xvc.ts', './paths/vcf-import.ts', './paths/vcf-converter.ts', './paths/rebuild.ts'],
  'WP-11c': ['./paths/aws-mgn.ts', './paths/azure-migrate.ts', './paths/gcp-m2vm.ts', './paths/oci-ocm.ts'],
  'WP-11d': ['./db/oracle.ts', './db/sqlserver.ts', './db/open-source.ts', './db/cloud-dms.ts'],
  'WP-17': ['./paths/patterns.ts', './db/beyond.ts'],
});

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

/** Something a path needs on the migration controller; `controller-check.sh` checks each one. */
export interface ToolNeed {
  readonly kind: 'command' | 'pwsh-module' | 'ansible-collection' | 'python-module';
  readonly name: string;
  /** Minimum version, shown in the README (not checked). */
  readonly min?: string;
  /** Why the kit needs it, in a few words. */
  readonly why: string;
  /** How to install it, in one line. */
  readonly install?: string;
}

/** What a generator is given besides its items. */
export interface PathContext {
  readonly plan: Plan;
  readonly decision: PlanDecision;
  readonly design: TargetDesign;
  readonly waves: WavePlan;
  readonly tracker?: Tracker;
  readonly settings: ExecutionSettings;
  /** The whole manifest (every path's items), for cross-references such as a database's hosts. */
  readonly manifest: Manifest;
  readonly resolutions: ReadonlyMap<ItemId, PathResolution<ExecPath>>;
}

/**
 * One path family's generator. `files` returns the family's files keyed by
 * their path relative to `migration/execute/` (e.g. `paths/aws-mgn/mgn.sh`,
 * `ansible/mgn-agent.yml`); every `.sh` / `.ps1` must keep the contract, which
 * `shScript` / `psScript` give by construction and `contractViolations`
 * checks. `files` is called once with every item on any of the generator's
 * paths, and is not called when there are none.
 */
export interface PathGenerator {
  /** A short id, e.g. 'hcx', 'aws-mgn', 'oracle'. */
  readonly id: string;
  readonly owner: PackageId;
  /** The paths it implements (one generator may serve several, e.g. every HCX type). */
  readonly paths: readonly ExecPath[];
  /** What the controller needs for these paths. */
  readonly needs: readonly ToolNeed[];
  /** The script that implements the verbs for `path`, relative to `migration/execute/`. */
  entry(path: ExecPath): string;
  files(items: readonly ManifestItem[], ctx: PathContext): Readonly<Record<string, string>>;
  /** Findings about these items (optional). */
  findings?(items: readonly ManifestItem[], ctx: PathContext): readonly Finding[];
}

export interface PathRegistry {
  /** Adds a generator; throws when it claims a path its package does not own, or one another generator has. */
  register(generator: PathGenerator): void;
  get(path: ExecPath): PathGenerator | undefined;
  generators(): readonly PathGenerator[];
  /** Paths with no generator yet. */
  missing(): readonly ExecPath[];
}

export function createRegistry(generators: readonly PathGenerator[] = [], options: { readonly core?: boolean } = {}): PathRegistry {
  const byPath = new Map<ExecPath, PathGenerator>();
  const registry: PathRegistry = {
    register(g) {
      for (const p of g.paths) {
        const owner = PATH_OWNERS[p];
        if (!owner) throw new Error(`path generator ${g.id}: ${p} is not a move path`);
        if (owner !== g.owner) throw new Error(`path generator ${g.id} (${g.owner}) claims ${p}, which ${owner} owns`);
        const had = byPath.get(p);
        if (had && had.id !== g.id) throw new Error(`path generator ${g.id} claims ${p}, which ${had.id} already generates`);
      }
      for (const p of g.paths) byPath.set(p, g);
    },
    get: (p) => byPath.get(p),
    generators: () => [...new Set(byPath.values())],
    missing: () => ALL_EXEC_PATHS.filter((p) => !byPath.has(p)),
  };
  if (options.core ?? true) registry.register(CORE_GENERATOR);
  for (const g of generators) registry.register(g);
  return registry;
}

// ---------------------------------------------------------------------------
// The core generator (WP-11a): paths with no tool of their own
// ---------------------------------------------------------------------------

const CORE_FILE = 'paths/core/core.sh';
const CORE_PATHS: readonly ExecPath[] = ['with-db', 'with-vm', 'retire', 'specialist'];

const CORE_FUNCTIONS = `
# What each core path does at every verb: nothing the kit can automate, so every verb records "skipped".
core_note() {
  case "\${ATK_ITEM_PATH[$1]}" in
    with-db) printf '%s' "not moved: its database moves to a managed service, and the server follows the database" ;;
    with-vm) printf '%s' "moves inside its server: the server's path does the work" ;;
    retire) printf '%s' "retired: the wave scripts stop the source at cutover and remove it at decommission" ;;
    specialist) printf '%s' "operator step: follow the runbook, then record the transition in the tracker" ;;
    *) printf '%s' "nothing to do on this path" ;;
  esac
}
`;

/** with-db, with-vm, retire and specialist: every verb writes started and skipped with the reason. */
export const CORE_GENERATOR: PathGenerator = Object.freeze({
  id: 'core',
  owner: 'WP-11a' as const,
  paths: CORE_PATHS,
  needs: [],
  entry: () => CORE_FILE,
  files(): Readonly<Record<string, string>> {
    const skip = 'atk_skip "$id" "$(core_note "$id")"';
    return {
      [CORE_FILE]: shScript({
        file: CORE_FILE,
        paths: CORE_PATHS,
        summary: 'Items whose move is done elsewhere (with their database or server), retired items and specialist items.',
        functions: CORE_FUNCTIONS,
        verbs: { prepare: skip, replicate: skip, test: skip, 'test-cleanup': skip, cutover: skip, commit: skip, rollback: skip, finalize: skip, status: skip },
      }),
    };
  },
});

const PENDING_FILE = 'paths/pending/pending.sh';

/**
 * The stand-in for paths whose generator is not installed: every verb fails
 * (so the wave reports exit 10) naming the package that owns the path. The
 * items stay visible, and nothing claims to have moved.
 */
export function pendingGenerator(paths: readonly ExecPath[]): PathGenerator {
  const owners = [...new Set(paths.map((p) => PATH_OWNERS[p]))].sort();
  const cases = [...paths].sort().map((p) => `    ${p}) printf '%s' "${PATH_OWNERS[p]}" ;;`).join('\n');
  const functions = `
# The package that generates each path in this script (its generator was not installed when the kit was built).
pending_owner() {
  case "\${ATK_ITEM_PATH[$1]}" in
${cases}
    *) printf '%s' "unknown" ;;
  esac
}
`;
  const fail = 'atk_fail "$id" "no generator for path ${ATK_ITEM_PATH[$id]} in this kit (it comes from $(pending_owner "$id")): do this step by hand and record it in the tracker"';
  return {
    id: 'pending',
    owner: 'WP-11a',
    paths,
    needs: [],
    entry: () => PENDING_FILE,
    files: () => ({
      [PENDING_FILE]: shScript({
        file: PENDING_FILE,
        paths,
        summary: `Paths whose generator is not in this kit yet (${owners.join(', ')}): every verb fails and says so.`,
        functions,
        verbs: { prepare: fail, replicate: fail, test: fail, 'test-cleanup': fail, cutover: fail, commit: fail, rollback: fail, finalize: fail, status: fail },
      }),
    }),
  };
}

// ---------------------------------------------------------------------------
// The default registry
// ---------------------------------------------------------------------------

/** The generators built into the kit. WP-11b/c/d and WP-17 modules are added here as they land. */
const BUILT_IN: readonly PathGenerator[] = [];

/** The registry `executionKit` uses by default. */
export const PATH_REGISTRY: PathRegistry = createRegistry(BUILT_IN);

/** Register a generator in the default registry (for modules not yet wired into `BUILT_IN`, and for tests). */
export function registerPathGenerator(generator: PathGenerator): void {
  PATH_REGISTRY.register(generator);
}
