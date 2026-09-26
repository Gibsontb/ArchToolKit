/**
 * Licensing facts, as data: every number the licence rules and the bill of
 * materials rest on, each with its source and how far it was verified.
 *
 * Licensing policy changes by announcement. Keeping every figure here means a
 * policy change is a one-line edit that fails a test, never a silent change of
 * logic; and the decision record can say which facts an answer rests on.
 *
 * Verification is honest: 'V-DOC' only where the vendor's own document says
 * it; 'C' where the figure is reported by licensing specialists or read from
 * the vendor but not re-checked in this build; 'I' where it is inferred. None
 * of this is legal advice, and the decision record says so.
 */

import type { Platform } from '../platforms.ts';
import { DB_SERVICES, VM_SERVICE } from './db-catalog.ts';
import { osKind } from './os.ts';
import type { Database, DbServiceId, LicenceNeed, Requirements, Verification, Workload } from './types.ts';

export interface LicensingFact<T> {
  readonly id: string;
  readonly value: T;
  /** The fact, in one sentence, as the decision record prints it. */
  readonly statement: string;
  readonly verification: Verification;
  /** URL(s), `;`-separated. */
  readonly source: string;
  readonly caveat?: string;
}

const fact = <T>(id: string, value: T, statement: string, verification: Verification, source: string, caveat?: string): LicensingFact<T> =>
  Object.freeze({ id, value, statement, verification, source, ...(caveat ? { caveat } : {}) });

const ORACLE_CLOUD = 'https://www.oracle.com/a/ocom/docs/cloud-licensing-070579.pdf';
const ORACLE_CLOUD_C = `${ORACLE_CLOUD} ; https://houseofbrick.com/blog/oracle-updates-cloud-licensing-policy/ ; https://redresscompliance.com/oracle-database-licensing-cloud-environments`;
const ORACLE_CLOUD_CAVEAT = 'Oracle’s PDF refused automated reading; the figures are corroborated by licensing specialists. Confirm against your Oracle agreement.';
const OCI_BYOL = 'https://redresscompliance.com/oracle-oci-cloud-infrastructure-licensing ; https://oraclelicensingexperts.com/oracle-bring-your-own-licensing/';
const MULTICLOUD_REGIONS = 'https://docs.oracle.com/en-us/iaas/Content/multicloud/regions.htm';
const SAMEXPERT_FVB = 'https://samexpert.com/flexible-virtualization/';

export const LICENSING_FACTS = Object.freeze({
  'oracle.ace.clouds': fact<readonly Platform[]>(
    'oracle.ace.clouds', ['aws', 'azure', 'google'],
    'Oracle’s Authorized Cloud Environments are AWS, Azure and Google Cloud (GCP); OCI is Oracle’s own and licensed by OCPU.',
    'C', ORACLE_CLOUD_C, ORACLE_CLOUD_CAVEAT,
  ),
  'oracle.ace.vcpu-per-processor': fact<{ readonly hyperThreading: number; readonly noHyperThreading: number }>(
    'oracle.ace.vcpu-per-processor', { hyperThreading: 2, noHyperThreading: 1 },
    'In an Authorized Cloud Environment, two vCPUs count as one Processor licence when hyper-threading is on; one vCPU when it is off.',
    'C', ORACLE_CLOUD_C, ORACLE_CLOUD_CAVEAT,
  ),
  'oracle.ace.core-factor-applies': fact<boolean>(
    'oracle.ace.core-factor-applies', false,
    'The Oracle Processor Core Factor Table does not apply in Authorized Cloud Environments.',
    'C', ORACLE_CLOUD_C, ORACLE_CLOUD_CAVEAT,
  ),
  'oracle.ace.se2.max-vcpu': fact<number>(
    'oracle.ace.se2.max-vcpu', 8,
    'Standard Edition 2 may be licensed in an Authorized Cloud Environment only on instances of up to 8 vCPUs.',
    'C', ORACLE_CLOUD_C, ORACLE_CLOUD_CAVEAT,
  ),
  'oracle.ace.se2.vcpu-per-socket': fact<number>(
    'oracle.ace.se2.vcpu-per-socket', 4,
    'For Standard Edition 2 in an Authorized Cloud Environment, every 4 vCPUs (or part) count as one socket.',
    'C', ORACLE_CLOUD_C, ORACLE_CLOUD_CAVEAT,
  ),
  'oracle.oci.vcpu-per-ocpu': fact<number>(
    'oracle.oci.vcpu-per-ocpu', 2,
    'An OCI OCPU is one physical x86 core with two hardware threads, shown to the guest as two vCPUs.',
    'C', 'https://docs.oracle.com/en-us/iaas/Content/Compute/References/computeshapes.htm',
  ),
  'oracle.oci.ocpu-per-processor-ee': fact<number>(
    'oracle.oci.ocpu-per-processor-ee', 2,
    'On OCI, two OCPUs (two physical x86 cores, core factor 0.5) count as one Enterprise Edition Processor licence under BYOL.',
    'I', OCI_BYOL, 'Inferred from the core factor; verify with Oracle LMS or your contract.',
  ),
  'oracle.oci.ocpu-per-socket-se2': fact<number>(
    'oracle.oci.ocpu-per-socket-se2', 4,
    'On OCI, every 4 OCPUs (or part) count as one Standard Edition 2 socket under BYOL.',
    'I', OCI_BYOL, 'Inferred; verify with Oracle LMS or your contract.',
  ),
  'oracle.vmware.all-hosts': fact<boolean>(
    'oracle.vmware.all-hosts', true,
    'Oracle on vSphere is licensed on every host in the clusters it could run on: soft partitioning is not recognised.',
    'C', 'https://www.oracle.com/assets/partitioning-070609.pdf', 'Oracle’s Partitioning Policy is not contractual; negotiated terms may differ.',
  ),
  'oracle.rac.iaas': fact<readonly DbServiceId[]>(
    'oracle.rac.iaas', ['aws-odb-exadata', 'azure-odb-exadata', 'google-odb-exadata', 'oci-basedb', 'oci-exacs', 'vmware-vm'],
    'Oracle RAC is not supported on AWS, Azure or Google Cloud (GCP) IaaS VMs; it runs on Exadata (Oracle Database@AWS/Azure/Google Cloud, ExaCS), on two-node OCI Base Database VM systems, and on vSphere.',
    'C', MULTICLOUD_REGIONS,
  ),
  'oracle.odb.regions': fact<string>(
    'oracle.odb.regions', MULTICLOUD_REGIONS,
    'Oracle Database@AWS, @Azure and @Google Cloud are available in a subset of each provider’s regions: report the region, do not score it.',
    'V-DOC', MULTICLOUD_REGIONS,
  ),
  'ms.listed-providers': fact<readonly Platform[]>(
    'ms.listed-providers', ['aws', 'google'],
    'Microsoft’s Listed Providers include AWS and Google (and Alibaba); Azure is Microsoft’s own. OCI is not a Listed Provider.',
    'C', `https://www.microsoft.com/licensing/terms ; ${SAMEXPERT_FVB}`,
  ),
  'ms.fvb.allowed': fact<{ readonly platforms: readonly Platform[]; readonly windowsMinCoresPerVm: number; readonly sqlMinCoresPerVm: number }>(
    'ms.fvb.allowed', { platforms: ['oci'], windowsMinCoresPerVm: 8, sqlMinCoresPerVm: 4 },
    'The Flexible Virtualization Benefit lets licences with Software Assurance or subscriptions run at non-Listed Providers such as OCI: Windows Server at least 8 core licences per VM, SQL Server at least 4.',
    'C', SAMEXPERT_FVB,
  ),
  'ms.licence-mobility.sql': fact<readonly DbServiceId[]>(
    'ms.licence-mobility.sql', ['aws-ec2', 'google-gce'],
    'SQL Server with Software Assurance may be brought to AWS or Google Cloud (GCP) shared-tenancy VMs through Licence Mobility; not to RDS or Cloud SQL, which are licence-included.',
    'C', 'https://www.microsoft.com/licensing/licensing-programs/software-assurance-license-mobility',
  ),
  'ms.windows.byol-listed': fact<{ readonly acquiredBefore: string; readonly dedicatedOnly: boolean }>(
    'ms.windows.byol-listed', { acquiredBefore: '2019-10-01', dedicatedOnly: true },
    'Windows Server BYOL at AWS or Google Cloud (GCP) is allowed only on dedicated hosts or sole-tenant nodes, and only for licences acquired before 2019-10-01 without Licence Mobility.',
    'C', 'https://samexpert.com/windows-server-byol-azure-vs-spla-vs-csp/',
  ),
  'ms.ahb': fact<readonly DbServiceId[]>(
    'ms.ahb', ['azure-vm', 'azure-sqlvm', 'azure-sqlmi', 'azure-sqldb'],
    'Azure Hybrid Benefit applies Windows Server and SQL Server licences with Software Assurance or subscriptions to Azure VMs, SQL Managed Instance and vCore SQL Database, with a free passive DR replica.',
    'V-DOC', 'https://azure.microsoft.com/pricing/hybrid-benefit/',
  ),
  'ms.esu.azure-free': fact<{ readonly os: readonly string[]; readonly sql: readonly string[] }>(
    'ms.esu.azure-free', { os: ['win-2012', 'win-2012r2'], sql: ['sql-2014'] },
    'Extended Security Updates are free on Azure for Windows Server 2012 / 2012 R2 and SQL Server 2014 only; not for 2016, which leaves support after the 2026-04-01 cut-off.',
    'C', 'https://www.microsoft.com/en-us/windows-server/extended-security-updates ; https://endoflife.ai/article-sql-server-2016-eol',
  ),
  'ms.core-minimums': fact<{ readonly windowsPerVm: number; readonly windowsPerHost: number; readonly sqlPerVm: number }>(
    'ms.core-minimums', { windowsPerVm: 8, windowsPerHost: 16, sqlPerVm: 4 },
    'Windows Server needs at least 8 core licences per VM and 16 per host; SQL Server at least 4 per VM.',
    'C', 'https://www.microsoft.com/licensing/terms (Product Terms)',
  ),
  'rhel.cloud-access': fact<readonly Platform[]>(
    'rhel.cloud-access', ['aws', 'azure', 'google', 'oci'],
    'RHEL subscriptions move to all four hyperscalers through Red Hat Cloud Access (BYOS); Azure Hybrid Benefit covers RHEL and SLES.',
    'C', 'https://access.redhat.com/public-cloud',
  ),
  'vcf.portable': fact<Readonly<Record<Exclude<Platform, 'vmware'>, 'confirmed' | 'self-managed' | 'unconfirmed'>>>(
    'vcf.portable', { azure: 'confirmed', aws: 'self-managed', google: 'unconfirmed', oci: 'unconfirmed' },
    'A portable VCF subscription can be carried to Azure VMware Solution (confirmed) and to Amazon EVS (self-managed VCF); Google Cloud VMware Engine and OCVS are unconfirmed.',
    'C', 'src/multicloud/vmware-on-cloud.ts (VMWARE_CLOUD_SERVICES licensing)',
  ),
});

export type LicensingFactId = keyof typeof LICENSING_FACTS;
export type LicensingFacts = typeof LICENSING_FACTS;
export const LICENSING_FACT_IDS = Object.freeze(Object.keys(LICENSING_FACTS) as LicensingFactId[]);

// ---------------------------------------------------------------------------
// licenceNeed: the count per item, platform and service
// ---------------------------------------------------------------------------

export interface LicenceContext {
  /** The requirements' licensing card; decides dedicated hosts for pre-2019 Windows / SQL. */
  readonly licensing?: Requirements['licensing'];
  /** OCPUs chosen on OCI (else vCPU / 2). */
  readonly ocpus?: number;
  /** Hyper-threading on the ACE instance (default on). */
  readonly hyperThreading?: boolean;
  /** Physical cores of the dedicated host, when the design places one. */
  readonly dedicatedHostCores?: number;
  /** Physical cores and sockets of the vSphere clusters an Oracle VM could run on. */
  readonly vmwareClusterCores?: number;
  readonly vmwareClusterSockets?: number;
  /** Override the facts (tests, what-if). */
  readonly facts?: LicensingFacts;
}

const isDatabase = (item: Workload | Database): item is Database => 'engine' in item;
const NONE = (note: string): LicenceNeed => ({ kind: 'none', count: 0, model: 'n/a', note });
const ODB: readonly DbServiceId[] = ['aws-odb-exadata', 'aws-odb-adb', 'azure-odb-exadata', 'azure-odb-adb', 'google-odb-exadata', 'google-odb-adb', 'google-odb-basedb'];

/**
 * The licences an item needs on a platform (and service, for a database):
 * kind, count, model and a one-line note. Sets `eliminated` when the licence
 * position rules the option out (SE2 over the ACE vCPU cap).
 *
 * - Oracle EE BYOL: ACE `ceil(vcpu / 2)` processors; OCI and Oracle Database@
 *   `ceil(ocpus / 2)`; vSphere every host in the cluster (the note says so).
 *   A count of 0 means licence-included.
 * - Oracle SE2 BYOL: ACE `ceil(vcpu / 4)` sockets, and over 8 vCPU is out; OCI
 *   `ceil(ocpus / 4)`.
 * - Windows Server: `max(8, vcpu)` cores for BYOL, AHB or FVB; a dedicated
 *   host's cores for pre-2019 BYOL at AWS / Google; licence-included 0.
 * - SQL Server: `max(4, vcpu)` cores.
 */
export function licenceNeed(item: Workload | Database, platform: Platform, service?: DbServiceId, ctx: LicenceContext = {}): LicenceNeed {
  const facts = ctx.facts ?? LICENSING_FACTS;
  return isDatabase(item) ? databaseNeed(item, platform, service ?? VM_SERVICE[platform], ctx, facts) : workloadNeed(item, platform, ctx, facts);
}

function databaseNeed(db: Database, platform: Platform, service: DbServiceId, ctx: LicenceContext, facts: LicensingFacts): LicenceNeed {
  if (db.engine === 'oracle') return oracleNeed(db, platform, service, ctx, facts);
  if (db.engine === 'sqlserver') return sqlNeed(db, platform, service, ctx, facts);
  if (db.licence === 'community' || db.edition === 'community') return NONE('Open source: no licence.');
  return NONE('Licensed outside this planner (the engine’s own terms).');
}

function oracleNeed(db: Database, platform: Platform, service: DbServiceId, ctx: LicenceContext, facts: LicensingFacts): LicenceNeed {
  if (db.edition === 'oracle-xe') return NONE('Express Edition: free, with its resource limits.');
  const se2 = db.edition === 'oracle-se2';
  const kind = se2 ? 'oracle-se2-socket' : 'oracle-processor';
  const info = DB_SERVICES[service];
  const wantsLi = db.licence === 'li';
  const liOffered = info.managed && (info.licenceByEngine?.oracle ?? info.licence).includes('li') && !(service === 'aws-rds' && !se2);
  if (wantsLi && liOffered) return { kind, count: 0, model: 'li', note: `Licence included in ${info.label}.` };

  const nupNote = db.licence === 'oracle-nup' ? ` Named User Plus: count users too, with minimums (${se2 ? '10 per socket' : '25 per processor'}).` : '';
  const ulaNote = db.licence === 'oracle-ula' ? ' Covered by the ULA: count it for certification.' : '';
  const liNote = wantsLi ? ` ${info.label} has no licence-included Oracle${se2 ? '' : ' Enterprise Edition'}: this is BYOL.` : '';

  const ocpus = ctx.ocpus ?? Math.ceil(db.vcpu / facts['oracle.oci.vcpu-per-ocpu'].value);

  if (platform === 'vmware') {
    const cores = ctx.vmwareClusterCores;
    const sockets = ctx.vmwareClusterSockets;
    const count = se2 ? (sockets ?? 0) : cores !== undefined ? Math.ceil(cores * 0.5) : 0;
    const known = se2 ? sockets !== undefined : cores !== undefined;
    return {
      kind, count, model: 'byol',
      note: `${facts['oracle.vmware.all-hosts'].statement}${known ? '' : ' The cluster’s hosts are not known here: count every host’s ' + (se2 ? 'sockets' : 'cores × 0.5') + ', or build a dedicated Oracle cluster.'}${nupNote}${ulaNote}`,
      facts: ['oracle.vmware.all-hosts'],
    };
  }

  if (platform === 'oci' || ODB.includes(service)) {
    const per = se2 ? facts['oracle.oci.ocpu-per-socket-se2'].value : facts['oracle.oci.ocpu-per-processor-ee'].value;
    const count = Math.ceil(ocpus / per);
    const where = platform === 'oci' ? 'OCI' : `${info.label} (Oracle hardware, counted as on OCI)`;
    return {
      kind, count, model: 'byol',
      note: `${count} ${se2 ? 'socket' : 'processor'} licence${count === 1 ? '' : 's'} for ${ocpus} OCPU on ${where}.${liNote}${nupNote}${ulaNote}`,
      facts: ['oracle.oci.vcpu-per-ocpu', se2 ? 'oracle.oci.ocpu-per-socket-se2' : 'oracle.oci.ocpu-per-processor-ee'],
    };
  }

  // Authorized Cloud Environments.
  if (se2) {
    const cap = facts['oracle.ace.se2.max-vcpu'].value;
    const count = Math.ceil(db.vcpu / facts['oracle.ace.se2.vcpu-per-socket'].value);
    if (db.vcpu > cap) {
      return {
        kind, count, model: 'byol',
        note: `Standard Edition 2 BYOL is capped at ${cap} vCPU in an Authorized Cloud Environment; this has ${db.vcpu}.`,
        eliminated: 'lic.oracle.se2-cap',
        facts: ['oracle.ace.se2.max-vcpu'],
      };
    }
    return {
      kind, count, model: 'byol',
      note: `${count} socket${count === 1 ? '' : 's'} for ${db.vcpu} vCPU (4 vCPU per socket).${liNote}${nupNote}${ulaNote}`,
      facts: ['oracle.ace.se2.vcpu-per-socket', 'oracle.ace.se2.max-vcpu'],
    };
  }
  const perProcessor = ctx.hyperThreading === false
    ? facts['oracle.ace.vcpu-per-processor'].value.noHyperThreading
    : facts['oracle.ace.vcpu-per-processor'].value.hyperThreading;
  const count = Math.ceil(db.vcpu / perProcessor);
  return {
    kind, count, model: 'byol',
    note: `${count} processor licence${count === 1 ? '' : 's'} for ${db.vcpu} vCPU (${perProcessor} vCPU per processor, no core factor).${liNote}${nupNote}${ulaNote}`,
    facts: ['oracle.ace.vcpu-per-processor', 'oracle.ace.core-factor-applies'],
  };
}

function sqlNeed(db: Database, platform: Platform, service: DbServiceId, ctx: LicenceContext, facts: LicensingFacts): LicenceNeed {
  if (db.edition === 'sql-express' || db.edition === 'sql-developer') return NONE('Express and Developer editions are free (Developer is not for production).');
  const cores = Math.max(facts['ms.core-minimums'].value.sqlPerVm, db.vcpu);
  const info = DB_SERVICES[service];
  const offered = info.licenceByEngine?.sqlserver ?? info.licence;
  const li = (note: string): LicenceNeed => ({ kind: 'sql-core', count: 0, model: 'li', note });
  if (db.licence === 'li' || db.licence === 'commercial-other') return platform === 'vmware'
    ? { kind: 'sql-core', count: cores, model: 'byol', note: `${cores} SQL Server core licences (4 minimum per VM) on your own hosts.`, facts: ['ms.core-minimums'] }
    : li(`Licence included in ${info.label}.`);
  if (!offered.includes('byol')) return li(`${info.label} is licence-included only: the owned licence is not used.`);

  const sa = db.licence === 'byol-sa';
  if (platform === 'vmware') return { kind: 'sql-core', count: cores, model: 'byol', note: `${cores} SQL Server core licences on your own hosts.`, facts: ['ms.core-minimums'] };
  if (platform === 'azure') {
    return sa
      ? { kind: 'sql-core', count: cores, model: 'ahb', note: `Azure Hybrid Benefit: ${cores} SQL Server core licences with SA.`, facts: ['ms.ahb', 'ms.core-minimums'] }
      : li('Azure Hybrid Benefit needs Software Assurance or a subscription: licence included instead, and the owned licence is stranded.');
  }
  if (platform === 'oci') {
    return sa
      ? { kind: 'sql-core', count: cores, model: 'fvb', note: `Flexible Virtualization Benefit: ${cores} SQL Server core licences (4 minimum per VM).`, facts: ['ms.fvb.allowed', 'ms.core-minimums'] }
      : li('BYOL on OCI needs Software Assurance (Flexible Virtualization Benefit): licence included instead, and the owned licence is stranded.');
  }
  // AWS / Google Cloud (GCP): Listed Providers.
  if (sa) return { kind: 'sql-core', count: cores, model: 'licence-mobility', note: `Licence Mobility through SA: ${cores} SQL Server core licences.`, facts: ['ms.licence-mobility.sql', 'ms.core-minimums'] };
  if (ctx.licensing?.windowsPre2019Licences) {
    const host = ctx.dedicatedHostCores ?? cores;
    return { kind: 'sql-core', count: host, model: 'dedicated-host', note: `Pre-2019-10-01 licences without SA on a dedicated host / sole-tenant node: ${host} cores.`, facts: ['ms.windows.byol-listed'] };
  }
  return li('Without SA, SQL Server BYOL at a Listed Provider needs pre-2019 licences on a dedicated host: licence included instead, and the owned licence is stranded.');
}

function workloadNeed(w: Workload, platform: Platform, ctx: LicenceContext, facts: LicensingFacts): LicenceNeed {
  const kind = osKind(w.os);
  if (kind === 'windows') {
    const cores = Math.max(facts['ms.core-minimums'].value.windowsPerVm, w.vcpu);
    const li = (note: string): LicenceNeed => ({ kind: 'windows-core', count: 0, model: 'li', note });
    if (platform === 'vmware') {
      return { kind: 'windows-core', count: cores, model: 'byol', note: `${cores} Windows Server core licences (8 minimum per VM), or license every host with Datacenter.`, facts: ['ms.core-minimums'] };
    }
    if (w.licence === 'li' || (w.licence !== 'byol-sa' && w.licence !== 'byol-perpetual')) return li('Licence included (pay as you go).');
    const sa = w.licence === 'byol-sa';
    if (platform === 'azure') {
      return sa
        ? { kind: 'windows-core', count: cores, model: 'ahb', note: `Azure Hybrid Benefit: ${cores} Windows Server core licences with SA.`, facts: ['ms.ahb', 'ms.core-minimums'] }
        : li('Azure Hybrid Benefit needs Software Assurance or a subscription: licence included instead, and the owned licence is stranded.');
    }
    if (platform === 'oci') {
      return sa
        ? { kind: 'windows-core', count: cores, model: 'fvb', note: `Flexible Virtualization Benefit: ${cores} Windows Server core licences (8 minimum per VM).`, facts: ['ms.fvb.allowed', 'ms.core-minimums'] }
        : li('BYOL on OCI needs Software Assurance (Flexible Virtualization Benefit): licence included instead, and the owned licence is stranded.');
    }
    // AWS / Google Cloud (GCP): Licence Mobility does not cover Windows Server.
    if (ctx.licensing?.windowsPre2019Licences) {
      const host = ctx.dedicatedHostCores ?? cores;
      return { kind: 'windows-core', count: host, model: 'dedicated-host', note: `Pre-2019-10-01 licences on a dedicated host / sole-tenant node: ${host} cores (the host’s).`, facts: ['ms.windows.byol-listed'] };
    }
    return li('Windows Server BYOL at AWS or Google Cloud (GCP) needs pre-2019 licences on a dedicated host: licence included instead, and the owned licence is stranded.');
  }
  if (w.os.startsWith('rhel-')) {
    if (w.licence === 'rhel-byos' || platform === 'vmware') return { kind: 'rhel', count: 1, model: 'byol', note: 'One RHEL subscription (Cloud Access / BYOS).', facts: ['rhel.cloud-access'] };
    return { kind: 'rhel', count: 0, model: 'li', note: 'RHEL licence included (pay as you go).' };
  }
  if (w.os.startsWith('sles-')) {
    if (w.licence === 'sles-byos' || platform === 'vmware') return { kind: 'sles', count: 1, model: 'byol', note: 'One SLES subscription (BYOS).', facts: ['rhel.cloud-access'] };
    return { kind: 'sles', count: 0, model: 'li', note: 'SLES licence included (pay as you go).' };
  }
  return NONE('No OS licence.');
}
