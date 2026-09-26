import { describe, it } from 'node:test';
import { expect } from '../../testing/expect.ts';
import { CATALOG_DATA } from '../../terraform/catalog-data.ts';
import { GCP_IMAGE_FAMILIES } from '../../kit/choices.ts';
import { PLATFORMS, platformInfo } from '../platforms.ts';
import { OS_VALUES, DB_SERVICE_VALUES, DB_VERSION_VALUES, DB_ENGINE_VALUES, defaultRequirements as emptyPlanRequirementsForTest } from './options.ts';
import { OS_CATALOG, classifyOs, classifyVm, osKind, osFamily, roleFromName, dbFromVm, supportStatus, defaultLicenceFor } from './os.ts';
import { DB_SERVICES, DB_VERSIONS, servicesFor, serviceLicences, unsupportedOn, cloudSqlVersion, isVersionEol } from './db-catalog.ts';
import { LICENSING_FACTS, LICENSING_FACT_IDS, licenceNeed } from './licensing-facts.ts';
import { IMAGE_TABLE, IMAGED_OS, imageFor, isUnavailable, sqlImageFor, GCP_SQL_IMAGE_FAMILIES } from './images.ts';
import { CONTROLS, CYBER_CONTROLS, DR_PATTERNS, cyberChecklist, drPatternFor } from './controls.ts';
import type { Database, OsId, Workload, ImageRef } from './types.ts';

// ---------------------------------------------------------------------------
// OS classifier
// ---------------------------------------------------------------------------

/**
 * Real strings: every vSphere guest id in terraform/blueprints/vmware.ts
 * GUEST_IDS that names a server OS, the other guest ids vCenter writes, the
 * configured-OS labels RVTools shows, and what VMware Tools and CMDBs report.
 */
const OS_STRINGS: readonly (readonly [string, OsId])[] = [
  // vSphere guest ids (GUEST_IDS in terraform/blueprints/vmware.ts first)
  ['rhel9_64Guest', 'rhel-9'],
  ['rhel8_64Guest', 'rhel-8'],
  ['ubuntu64Guest', 'linux-other'],
  ['debian12_64Guest', 'debian-12'],
  ['sles15_64Guest', 'sles-15'],
  ['rockylinux_64Guest', 'linux-other'],
  ['almalinux_64Guest', 'linux-other'],
  ['otherLinux64Guest', 'linux-other'],
  ['windows2022srvNext_64Guest', 'win-2025'],
  ['windows2019srvNext_64Guest', 'win-2022'],
  ['windows2019srv_64Guest', 'win-2019'],
  ['windows11_64Guest', 'windows-client'],
  ['windows9_64Guest', 'windows-client'],
  ['other5xLinux64Guest', 'linux-other'],
  ['windows9Server64Guest', 'win-2016'],
  ['windows8Server64Guest', 'win-2012r2'],
  ['windows7Server64Guest', 'win-2008r2'],
  ['winLonghorn64Guest', 'other'],
  ['rhel10_64Guest', 'rhel-10'],
  ['rhel7_64Guest', 'rhel-7'],
  ['rhel6_64Guest', 'rhel-6'],
  ['centos9_64Guest', 'centos-stream-9'],
  ['centos8_64Guest', 'centos-8'],
  ['centos7_64Guest', 'centos-7'],
  ['centos6_64Guest', 'centos-6'],
  ['oracleLinux9_64Guest', 'ol-9'],
  ['oracleLinux8_64Guest', 'ol-8'],
  ['oracleLinux7_64Guest', 'ol-7'],
  ['oracleLinux6_64Guest', 'ol-6'],
  ['sles16_64Guest', 'sles-16'],
  ['sles12_64Guest', 'sles-12'],
  ['sles11_64Guest', 'sles-11'],
  ['debian13_64Guest', 'debian-13'],
  ['debian11_64Guest', 'debian-11'],
  ['debian10_64Guest', 'debian-10'],
  ['debian9_64Guest', 'debian-9'],
  ['other4xLinux64Guest', 'linux-other'],
  ['vmwarePhoton64Guest', 'linux-other'],
  ['freebsd13_64Guest', 'other'],
  ['otherGuest64', 'other'],
  // RVTools "OS according to the configuration file" / vCenter labels
  ['Microsoft Windows Server 2025 (64-bit)', 'win-2025'],
  ['Microsoft Windows Server 2022 (64-bit)', 'win-2022'],
  ['Microsoft Windows Server 2019 (64-bit)', 'win-2019'],
  ['Microsoft Windows Server 2016 or later (64-bit)', 'win-2016'],
  ['Microsoft Windows Server 2016 (64-bit)', 'win-2016'],
  ['Microsoft Windows Server 2012 (64-bit)', 'win-2012'],
  ['Microsoft Windows Server 2008 R2 (64-bit)', 'win-2008r2'],
  ['Microsoft Windows Server 2008 (64-bit)', 'other'],
  ['Microsoft Windows 10 (64-bit)', 'windows-client'],
  ['Red Hat Enterprise Linux 9 (64-bit)', 'rhel-9'],
  ['Red Hat Enterprise Linux 8 (64-bit)', 'rhel-8'],
  ['Red Hat Enterprise Linux 7 (64-bit)', 'rhel-7'],
  ['CentOS 7 (64-bit)', 'centos-7'],
  ['CentOS 4/5/6/7 (64-bit)', 'linux-other'],
  ['Oracle Linux 8 (64-bit)', 'ol-8'],
  ['Oracle Linux 4/5 or later (64-bit)', 'linux-other'],
  ['SUSE Linux Enterprise 15 (64-bit)', 'sles-15'],
  ['SUSE Linux Enterprise 12 (64-bit)', 'sles-12'],
  ['Ubuntu Linux (64-bit)', 'linux-other'],
  ['Debian GNU/Linux 12 (64-bit)', 'debian-12'],
  ['Debian GNU/Linux 11 (64-bit)', 'debian-11'],
  ['Rocky Linux (64-bit)', 'linux-other'],
  ['AlmaLinux (64-bit)', 'linux-other'],
  ['Other 5.x or later Linux (64-bit)', 'linux-other'],
  ['VMware Photon OS (64-bit)', 'linux-other'],
  ['FreeBSD 13 (64-bit)', 'other'],
  ['Other (64-bit)', 'other'],
  // VMware Tools / guest detail pretty names / CMDB text
  ['Microsoft Windows Server 2019 Standard', 'win-2019'],
  ['Microsoft Windows Server 2022 Datacenter', 'win-2022'],
  ['Windows Server 2012 R2 Datacenter', 'win-2012r2'],
  ['Windows Server 2016 Standard', 'win-2016'],
  ['Red Hat Enterprise Linux Server release 7.9 (Maipo)', 'rhel-7'],
  ['Red Hat Enterprise Linux 9.4 (Plow)', 'rhel-9'],
  ['Red Hat Enterprise Linux release 8.10 (Ootpa)', 'rhel-8'],
  ['RHEL 10.0', 'rhel-10'],
  ['CentOS Linux release 7.9.2009 (Core)', 'centos-7'],
  ['CentOS Stream release 9', 'centos-stream-9'],
  ['CentOS Stream 10 (Coughlan)', 'centos-stream-10'],
  ['Rocky Linux 9.3 (Blue Onyx)', 'rocky-9'],
  ['Rocky Linux 8.10 (Green Obsidian)', 'rocky-8'],
  ['AlmaLinux 9.4 (Seafoam Ocelot)', 'alma-9'],
  ['AlmaLinux 10.0 (Purple Lion)', 'alma-10'],
  ['Oracle Linux Server 9.3', 'ol-9'],
  ['Oracle Linux Server 8.9', 'ol-8'],
  ['Oracle Linux Server release 7.9', 'ol-7'],
  ['Oracle Linux Server 10.0', 'ol-10'],
  ['SUSE Linux Enterprise Server 15 SP5', 'sles-15'],
  ['SUSE Linux Enterprise Server 16.0', 'sles-16'],
  ['SLES 12 SP5', 'sles-12'],
  ['Ubuntu 24.04.1 LTS', 'ubuntu-24.04'],
  ['Ubuntu 22.04.4 LTS', 'ubuntu-22.04'],
  ['Ubuntu 20.04.6 LTS', 'ubuntu-20.04'],
  ['Ubuntu 18.04.6 LTS', 'ubuntu-18.04'],
  ['Ubuntu 16.04.7 LTS', 'ubuntu-16.04'],
  ['Ubuntu 23.10', 'linux-other'],
  ['Debian GNU/Linux 12 (bookworm)', 'debian-12'],
  ['Debian GNU/Linux 13 (trixie)', 'debian-13'],
  ['Debian GNU/Linux 10 (buster)', 'debian-10'],
  ['openSUSE Leap 15.5', 'linux-other'],
  // The old substring defects: "Darwin" is not Windows, "Oracle Solaris" is not Linux.
  ['Darwin 64-bit', 'other'],
  ['Oracle Solaris 11 (64-bit)', 'other'],
  ['', 'unknown'],
  ['   ', 'unknown'],
];

describe('plan/os: classifyOs on real strings', () => {
  it('has at least 60 fixture strings', () => {
    expect(OS_STRINGS.length).toBeGreaterThanOrEqual(60);
  });

  for (const [text, expected] of OS_STRINGS) {
    it(`${JSON.stringify(text)} → ${expected}`, () => {
      expect(classifyOs(text)).toBe(expected);
    });
  }

  it('meets the design’s named cases', () => {
    expect(classifyOs('Oracle Linux Server 8.9')).toBe('ol-8');
    expect(classifyOs('Microsoft Windows Server 2019 (64-bit)')).toBe('win-2019');
    expect(classifyOs('windows2019srvNext_64Guest')).toBe('win-2022');
    expect(classifyOs('')).toBe('unknown');
  });
});

describe('plan/os: classifyVm reads Tools, then the pretty name, then the configured OS', () => {
  it('prefers the string that names the version', () => {
    expect(classifyVm({ guestOs: 'ubuntu64Guest', guestDetail: { prettyName: 'Ubuntu 22.04.4 LTS' } })).toBe('ubuntu-22.04');
    expect(classifyVm({ guestOs: 'ubuntu64Guest' })).toBe('linux-other');
  });
  it('trusts VMware Tools over the configured OS', () => {
    expect(classifyVm({ guestOs: 'Microsoft Windows Server 2016 (64-bit)', guestOsTools: 'Microsoft Windows Server 2022 (64-bit)' })).toBe('win-2022');
  });
  it('is unknown when nothing is reported', () => {
    expect(classifyVm({})).toBe('unknown');
  });
});

describe('plan/os: the catalog', () => {
  it('has an entry for every OsId, with a label, a source and a verification', () => {
    for (const id of OS_VALUES) {
      const info = OS_CATALOG[id];
      expect(info.id).toBe(id);
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.source.length).toBeGreaterThan(0);
      expect(['V-DOC', 'C', 'I']).toContain(info.verification);
    }
  });

  it('gives every versioned OS a source URL, and ISO dates in order', () => {
    for (const id of OS_VALUES) {
      const info = OS_CATALOG[id];
      if (info.majorVersion === '') continue;
      expect(/^https:\/\//.test(info.source)).toBe(true);
      for (const d of [info.endOfStandardSupport, info.endOfExtendedSupport]) if (d) expect(/^\d{4}-\d{2}-\d{2}$/.test(d)).toBe(true);
      if (info.endOfStandardSupport && info.endOfExtendedSupport) expect(info.endOfStandardSupport <= info.endOfExtendedSupport).toBe(true);
      if (info.upgradeTo) expect(OS_CATALOG[info.upgradeTo].kind).toBe(info.kind);
    }
  });

  it('carries the design’s key dates', () => {
    expect(OS_CATALOG['win-2012r2'].endOfStandardSupport).toBe('2023-10-10');
    expect(OS_CATALOG['win-2012r2'].endOfExtendedSupport).toBe('2026-10-13');
    expect(OS_CATALOG['win-2016'].endOfStandardSupport).toBe('2027-01-12');
    expect(OS_CATALOG['rhel-7'].endOfStandardSupport).toBe('2024-06-30');
    expect(OS_CATALOG['rhel-7'].endOfExtendedSupport).toBe('2028-06-30');
    expect(OS_CATALOG['centos-7'].endOfStandardSupport).toBe('2024-06-30');
    expect(OS_CATALOG['ubuntu-20.04'].endOfExtendedSupport?.startsWith('2030')).toBe(true);
    expect(OS_CATALOG['debian-11'].endOfExtendedSupport).toBe('2026-08-31');
  });

  it('knows kind and family', () => {
    expect(osKind('win-2019')).toBe('windows');
    expect(osKind('ol-9')).toBe('linux');
    expect(osFamily('ol-9')).toBe('rhel');
    expect(osFamily('ubuntu-24.04')).toBe('debian');
    expect(osFamily('sles-15')).toBe('suse');
    expect(osKind('unknown')).toBe('other');
  });

  it('says where an OS stands on a date', () => {
    expect(supportStatus('win-2012r2', '2026-09-26')).toBe('extended');
    expect(supportStatus('win-2019', '2026-09-26')).toBe('supported');
    expect(supportStatus('centos-7', '2026-09-26')).toBe('end-of-life');
    expect(supportStatus('unknown', '2026-09-26')).toBe('unknown');
  });

  it('defaults the licence as the design says', () => {
    expect(defaultLicenceFor('win-2022')).toBe('li');
    expect(defaultLicenceFor('rhel-9')).toBe('li');
    expect(defaultLicenceFor('sles-15')).toBe('li');
    expect(defaultLicenceFor('rocky-9')).toBe('free');
    expect(defaultLicenceFor('ubuntu-24.04')).toBe('free');
  });
});

describe('plan/os: role and database heuristics', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['corp-dc01', 'ad-dc'], ['LONDC02', 'other'], ['lon-dc02', 'ad-dc'], ['sqlprd01', 'db'], ['ora-fin-01', 'db'],
    ['pgsql-01', 'db'], ['web01', 'web'], ['iis-front', 'web'], ['app-api-02', 'app'], ['fs01', 'file'],
    ['dns01', 'dns-dhcp'], ['ctx-xa01', 'rds-vdi'], ['kafka1', 'messaging'], ['jmp01', 'jump'], ['veeam-proxy', 'backup'],
    ['mon01', 'monitoring'], ['storage01', 'other'], ['common01', 'other'],
  ];
  for (const [name, role] of cases) it(`${name} → ${role}`, () => expect(roleFromName(name)).toBe(role));

  it('falls back to the annotation and custom attributes', () => {
    expect(roleFromName('srv-0042', 'Payroll web front end')).toBe('web');
    expect(roleFromName('srv-0043', '', { Role: 'Oracle database' })).toBe('db');
  });

  it('infers SQL Server from a SQL-named Windows VM, marked inferred', () => {
    const db = dbFromVm({ name: 'SQLPRD01', vcpu: 4, memoryGib: 15.5, provisionedGib: 200.2, guestOs: 'Microsoft Windows Server 2019 (64-bit)' });
    expect(db?.engine).toBe('sqlserver');
    expect(db?.inferred).toBe(true);
    expect(db?.version).toBe('other');
    expect(db?.edition).toBe('commercial');
    expect(db?.hosts).toEqual(['SQLPRD01']);
    expect(db?.ramGib).toBe(16);
    expect(db?.id).toBe('d:sqlprd01');
  });

  it('infers Oracle, PostgreSQL and MySQL by name, and nothing from a plain name', () => {
    expect(dbFromVm({ name: 'ora-fin-01', vcpu: 8, memoryGib: 64, provisionedGib: 500, guestOs: 'Oracle Linux 8 (64-bit)' })?.engine).toBe('oracle');
    expect(dbFromVm({ name: 'pg-app-01', vcpu: 2, memoryGib: 8, provisionedGib: 100 })?.engine).toBe('postgres');
    expect(dbFromVm({ name: 'mysql01', vcpu: 2, memoryGib: 8, provisionedGib: 100 })?.licence).toBe('community');
    expect(dbFromVm({ name: 'web01', vcpu: 2, memoryGib: 8, provisionedGib: 100 })).toBeUndefined();
    // "sql" alone is SQL Server only on Windows.
    expect(dbFromVm({ name: 'sqlbox', vcpu: 2, memoryGib: 8, provisionedGib: 100, guestOs: 'Red Hat Enterprise Linux 8 (64-bit)' })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Database catalog
// ---------------------------------------------------------------------------

/** The helper multicloud.test.ts uses: provider resource names with their prefix. */
function catalogTypes(): Record<string, Set<string>> {
  const have: Record<string, Set<string>> = {};
  for (const [target, entry] of Object.entries(CATALOG_DATA)) {
    const prefix = target === 'azure' ? 'azurerm_' : `${target}_`;
    have[target] = new Set(entry.resources.split(',').map((n) => prefix + n));
  }
  return have;
}

describe('plan/db-catalog: the services check themselves', () => {
  it('names only Terraform types the provider catalog holds, for the service’s own provider', () => {
    const have = catalogTypes();
    const missing: string[] = [];
    for (const id of DB_SERVICE_VALUES) {
      const s = DB_SERVICES[id];
      const target = platformInfo(s.platform).terraform;
      expect(s.terraformTypes.length).toBeGreaterThan(0);
      for (const t of s.terraformTypes) if (!have[target]?.has(t)) missing.push(`${id}: ${t}`);
    }
    expect(missing).toEqual([]);
  });

  it('has every service, with its platform, a source and at least one engine and HA form', () => {
    for (const id of DB_SERVICE_VALUES) {
      const s = DB_SERVICES[id];
      expect(s.id).toBe(id);
      expect(PLATFORMS).toContain(s.platform);
      expect(s.engines.length).toBeGreaterThan(0);
      expect(s.ha).toContain('none');
      expect(s.source.length).toBeGreaterThan(0);
      expect(s.licence.length).toBeGreaterThan(0);
    }
  });

  it('gives every engine a VM home on every platform', () => {
    for (const engine of DB_ENGINE_VALUES) for (const p of PLATFORMS) expect(servicesFor(engine, p).some((s) => !s.managed)).toBe(true);
  });

  it('keeps RAC off hyperscaler VMs and RDS', () => {
    for (const id of ['aws-rds', 'aws-ec2', 'azure-vm', 'google-gce', 'google-cloudsql', 'oci-compute'] as const) expect(DB_SERVICES[id].ha).not.toContain('rac');
    for (const id of LICENSING_FACTS['oracle.rac.iaas'].value) expect(DB_SERVICES[id].ha).toContain('rac');
  });

  it('offers Oracle on every platform and many services, and SQL Server nowhere managed on OCI', () => {
    const oracle = servicesFor('oracle');
    expect(oracle.length).toBeGreaterThanOrEqual(8);
    for (const p of PLATFORMS) expect(oracle.some((s) => s.platform === p)).toBe(true);
    expect(servicesFor('oracle', undefined, 'oracle-se2').map((s) => s.id)).not.toContain('aws-odb-exadata');
    expect(servicesFor('sqlserver', 'oci').map((s) => s.id)).toEqual(['oci-compute']);
  });

  it('knows the licence and feature gaps the rules read', () => {
    expect(serviceLicences('aws-rds', 'sqlserver')).toEqual(['li']);
    expect(serviceLicences('google-cloudsql', 'sqlserver')).toEqual(['li']);
    expect(serviceLicences('azure-sqlmi', 'sqlserver')).toContain('byol');
    expect(unsupportedOn('azure-sqldb', ['agent-jobs', 'partitioning', 'linked-servers'])).toEqual(['agent-jobs', 'linked-servers']);
    expect(unsupportedOn('azure-sqlmi', ['agent-jobs'])).toEqual([]);
  });
});

describe('plan/db-catalog: versions', () => {
  it('has every version option, with a source', () => {
    for (const id of DB_VERSION_VALUES) {
      expect(DB_VERSIONS[id].id).toBe(id);
      expect(DB_VERSIONS[id].source.length).toBeGreaterThan(0);
    }
  });
  it('spells versions as the providers do', () => {
    expect(cloudSqlVersion('sql-2022', 'sql-enterprise')).toBe('SQLSERVER_2022_ENTERPRISE');
    expect(cloudSqlVersion('pg-16', 'community')).toBe('POSTGRES_16');
    expect(DB_VERSIONS['oracle-26ai'].providers.oci).toBe('23.0.0.0');
    expect(DB_VERSIONS['oracle-19c'].providers.rds?.startsWith('19.0.0.0')).toBe(true);
  });
  it('flags the versions past support that the design names', () => {
    const today = '2026-09-26';
    expect(isVersionEol('sql-2014', today)).toBe(true);
    expect(isVersionEol('sql-2016', today)).toBe(true);
    expect(isVersionEol('oracle-18c', today)).toBe(true);
    expect(isVersionEol('oracle-11.2', today)).toBe(true);
    expect(isVersionEol('sql-2019', today)).toBe(false);
    expect(isVersionEol('oracle-19c', today)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Licensing facts and licenceNeed
// ---------------------------------------------------------------------------

describe('plan/licensing-facts', () => {
  it('gives every fact a source URL, a statement and a verification', () => {
    expect(LICENSING_FACT_IDS.length).toBeGreaterThanOrEqual(18);
    for (const id of LICENSING_FACT_IDS) {
      const f = LICENSING_FACTS[id];
      expect(f.id).toBe(id);
      expect(f.statement.length).toBeGreaterThan(20);
      expect(['V-DOC', 'C', 'I']).toContain(f.verification);
      expect(f.source.length).toBeGreaterThan(0);
      if (id !== 'vcf.portable') expect(/https:\/\//.test(f.source)).toBe(true);
    }
  });

  it('marks the inferred OCI conversions as inferred', () => {
    expect(LICENSING_FACTS['oracle.oci.ocpu-per-processor-ee'].verification).toBe('I');
    expect(LICENSING_FACTS['oracle.oci.ocpu-per-socket-se2'].verification).toBe('I');
  });

  const db = (over: Partial<Database>): Database => ({
    id: 'd:x', name: 'x', engine: 'oracle', edition: 'oracle-ee', version: 'oracle-19c', hosts: [], vcpu: 8, ramGib: 64,
    sizeGib: 100, ha: 'none', dr: 'none', features: [], licence: 'oracle-processor', app: 'a', source: 'manual', ...over,
  });
  const vm = (over: Partial<Workload>): Workload => ({
    id: 'w:x', name: 'x', app: 'a', env: 'prod', role: 'app', os: 'win-2022', vcpu: 2, ramGib: 8, disksGib: [80],
    criticality: 'tier2', rpo: '4h', rto: '4h', licence: 'li', dependsOn: [], source: 'manual', ...over,
  });

  it('Oracle EE 8 vCPU BYOL on AWS needs 4 processors', () => {
    const need = licenceNeed(db({}), 'aws', 'aws-ec2');
    expect(need.kind).toBe('oracle-processor');
    expect(need.count).toBe(4);
    expect(need.model).toBe('byol');
    expect(need.eliminated).toBeUndefined();
  });

  it('Oracle EE 8 vCPU (4 OCPU) on OCI needs 2', () => {
    expect(licenceNeed(db({}), 'oci', 'oci-basedb').count).toBe(2);
    expect(licenceNeed(db({}), 'oci', 'oci-compute', { ocpus: 4 }).count).toBe(2);
  });

  it('SE2 10 vCPU on an Azure VM is eliminated by the ACE cap', () => {
    const need = licenceNeed(db({ edition: 'oracle-se2', vcpu: 10 }), 'azure', 'azure-vm');
    expect(need.eliminated).toBe('lic.oracle.se2-cap');
    expect(licenceNeed(db({ edition: 'oracle-se2', vcpu: 8 }), 'azure', 'azure-vm').count).toBe(2);
  });

  it('Windows 2 vCPU BYOL through the FVB on OCI needs 8 cores', () => {
    const need = licenceNeed(vm({ licence: 'byol-sa' }), 'oci');
    expect(need.kind).toBe('windows-core');
    expect(need.count).toBe(8);
    expect(need.model).toBe('fvb');
  });

  it('SQL Server 2 vCPU needs 4 cores', () => {
    const sql = db({ engine: 'sqlserver', edition: 'sql-standard', version: 'sql-2022', vcpu: 2, licence: 'byol-sa' });
    expect(licenceNeed(sql, 'azure', 'azure-sqlvm')).toEqual({ ...licenceNeed(sql, 'azure', 'azure-sqlvm'), kind: 'sql-core', count: 4, model: 'ahb' });
    expect(licenceNeed(sql, 'oci', 'oci-compute').count).toBe(4);
    expect(licenceNeed(sql, 'aws', 'aws-ec2').model).toBe('licence-mobility');
  });

  it('counts licence-included as 0, and RDS takes no owned SQL licence', () => {
    expect(licenceNeed(db({ edition: 'oracle-se2', licence: 'li' }), 'aws', 'aws-rds')).toEqual({ ...licenceNeed(db({ edition: 'oracle-se2', licence: 'li' }), 'aws', 'aws-rds'), count: 0, model: 'li' });
    expect(licenceNeed(db({ licence: 'li' }), 'oci', 'oci-adb').count).toBe(0);
    const sql = db({ engine: 'sqlserver', edition: 'sql-enterprise', version: 'sql-2022', licence: 'byol-sa' });
    const rds = licenceNeed(sql, 'aws', 'aws-rds');
    expect(rds.model).toBe('li');
    expect(rds.count).toBe(0);
    expect(licenceNeed(vm({}), 'azure').count).toBe(0);
  });

  it('puts pre-2019 Windows BYOL on a dedicated host at AWS, and strands it otherwise', () => {
    const w = vm({ licence: 'byol-perpetual', vcpu: 4 });
    const licensing = { ...emptyPlanRequirementsForTest().licensing, windowsPre2019Licences: true };
    expect(licenceNeed(w, 'aws', undefined, { licensing, dedicatedHostCores: 48 })).toEqual({ ...licenceNeed(w, 'aws', undefined, { licensing, dedicatedHostCores: 48 }), model: 'dedicated-host', count: 48 });
    expect(licenceNeed(w, 'aws').model).toBe('li');
    expect(licenceNeed(vm({ licence: 'byol-sa', vcpu: 16 }), 'azure').count).toBe(16);
  });

  it('names the whole-cluster rule for Oracle on vSphere', () => {
    const need = licenceNeed(db({}), 'vmware', 'vmware-vm', { vmwareClusterCores: 64 });
    expect(need.count).toBe(32);
    expect(need.note).toContain('every host');
  });

  it('counts RHEL and SLES subscriptions only when brought', () => {
    expect(licenceNeed(vm({ os: 'rhel-9', licence: 'rhel-byos' }), 'aws')).toEqual({ ...licenceNeed(vm({ os: 'rhel-9', licence: 'rhel-byos' }), 'aws'), kind: 'rhel', count: 1 });
    expect(licenceNeed(vm({ os: 'rhel-9', licence: 'li' }), 'aws').count).toBe(0);
    expect(licenceNeed(vm({ os: 'ubuntu-24.04', licence: 'free' }), 'aws').kind).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

const HYPERSCALERS = ['aws', 'azure', 'google', 'oci'] as const;
const refs = (): ImageRef[] => {
  const out: ImageRef[] = [];
  for (const os of OS_VALUES) for (const p of HYPERSCALERS) {
    const e = IMAGE_TABLE[os][p];
    if (e && !isUnavailable(e)) out.push(e);
  }
  return out;
};

describe('plan/images', () => {
  it('gives every OS that is not "other" an image or a reason, on every hyperscaler', () => {
    const gaps: string[] = [];
    for (const os of OS_VALUES) {
      if (OS_CATALOG[os].kind === 'other') continue;
      for (const p of HYPERSCALERS) {
        const e = IMAGE_TABLE[os][p];
        if (!e) gaps.push(`${os}/${p}`);
        else if (isUnavailable(e)) expect(e.unavailable.length).toBeGreaterThan(20);
      }
    }
    expect(gaps).toEqual([]);
    expect(IMAGED_OS).toContain('linux-other');
    expect(IMAGED_OS).not.toContain('unknown');
  });

  it('uses only Google families GCP_IMAGE_FAMILIES lists', () => {
    const families = new Set(GCP_IMAGE_FAMILIES.map((o) => o.value));
    for (const r of refs()) if (r.kind === 'gcp-family') expect(families.has(r.family)).toBe(true);
  });

  it('starts every AWS SSM parameter with /aws/service/, and every owner is an account id', () => {
    for (const r of refs()) {
      if (r.kind === 'aws-ssm') expect(r.parameter.startsWith('/aws/service/')).toBe(true);
      if (r.kind === 'aws-ami-filter') expect(/^\d{12}$/.test(r.owner)).toBe(true);
    }
  });

  it('uses OCI platform images only for Oracle Linux, Ubuntu and Windows', () => {
    for (const r of refs()) if (r.kind === 'oci-platform') expect(['Oracle Linux', 'Canonical Ubuntu', 'Windows']).toContain(r.operatingSystem);
  });

  it('resolves the design’s examples', () => {
    expect(imageFor('win-2022', 'aws')).toEqual({ kind: 'aws-ssm', parameter: '/aws/service/ami-windows-latest/Windows_Server-2022-English-Full-Base' });
    expect(imageFor('win-2012r2', 'azure')).toEqual({ kind: 'azure-marketplace', publisher: 'MicrosoftWindowsServer', offer: 'WindowsServer', sku: '2012-r2-datacenter-gensecond' });
    expect(imageFor('rocky-9', 'azure')).toEqual({ kind: 'azure-marketplace', publisher: 'resf', offer: 'rockylinux-x86_64', sku: '9-base', plan: true });
    expect(isUnavailable(imageFor('centos-7', 'google'))).toBe(true);
    expect(imageFor('rhel-9', 'oci')).toEqual({ kind: 'custom', variable: 'image_ocid_rhel_9', note: (imageFor('rhel-9', 'oci') as { note: string }).note });
    expect(imageFor('rhel-9', 'vmware', { vsphereTemplates: { 'rhel-9': 'tpl-rhel9' } })).toEqual({ kind: 'vsphere-template', template: 'tpl-rhel9' });
  });

  it('gives Windows BYOL an imported image outside Azure', () => {
    expect(imageFor('win-2022', 'oci', { licence: 'byol-sa' }).kind).toBe('custom');
    expect(imageFor('win-2022', 'aws', { licence: 'byol-perpetual' }).kind).toBe('custom');
    expect(imageFor('win-2022', 'azure', { licence: 'byol-sa' }).kind).toBe('azure-marketplace');
  });

  it('chooses SQL Server licence-included images for IaaS SQL rows', () => {
    expect(imageFor('win-2022', 'aws', { sqlEdition: 'standard', sqlVersion: 'sql-2022' })).toEqual({
      kind: 'aws-ssm', parameter: '/aws/service/ami-windows-latest/Windows_Server-2022-English-Full-SQL_2022_Standard',
    });
    expect(imageFor('win-2022', 'azure', { sqlEdition: 'enterprise', sqlVersion: 'sql-2022' })).toEqual({
      kind: 'azure-marketplace', publisher: 'MicrosoftSQLServer', offer: 'sql2022-ws2022', sku: 'enterprise-gen2',
    });
    expect(imageFor('win-2022', 'google', { sqlEdition: 'web', sqlVersion: 'sql-2022' })).toEqual({ kind: 'gcp-family', project: 'windows-sql-cloud', family: 'sql-web-2022-win-2022' });
    for (const v of ['sql-2019', 'sql-2022'] as const) for (const e of ['enterprise', 'standard', 'web'] as const) {
      const g = sqlImageFor(v, e, 'google');
      if (g && !isUnavailable(g) && g.kind === 'gcp-family') expect(GCP_SQL_IMAGE_FAMILIES).toContain(g.family);
    }
  });
});

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

describe('plan/controls: the wizard’s cyber checklist and DR patterns, as data', () => {
  it('names a service on every platform for every control, and never "Aria"', () => {
    expect(CONTROLS.cyber).toBe(CYBER_CONTROLS);
    for (const c of CYBER_CONTROLS) for (const p of PLATFORMS) {
      expect(c.services[p].length).toBeGreaterThan(0);
      expect(/Aria/.test(c.services[p])).toBe(false);
    }
    for (const d of Object.values(DR_PATTERNS)) for (const p of PLATFORMS) expect(/Aria/.test(d.perPlatform[p])).toBe(false);
  });

  it('has the four DR patterns with text for every platform', () => {
    expect(Object.keys(DR_PATTERNS).sort()).toEqual(['active-active', 'backup-restore', 'pilot-light', 'warm-standby']);
    const r = emptyPlanRequirementsForTest();
    expect(drPatternFor('tier0', r, 'azure').pattern).toBe('warm-standby');
    expect(drPatternFor('tier3', r, 'oci').text).toContain('Block volume');
  });

  it('flags the actions the wizard flagged, from the requirements', () => {
    const r = emptyPlanRequirementsForTest();
    const noDr = cyberChecklist(r, ['aws']);
    expect(noDr.find((i) => i.id === 'ctl.disaster-recovery')?.status).toBe('action');
    expect(noDr.find((i) => i.id === 'ctl.siem')?.status).toBe('action');
    const withDr = cyberChecklist({ ...r, siem: 'splunk', regions: { aws: { primary: 'us-east-1', dr: 'us-west-2' } } }, ['aws']);
    expect(withDr.find((i) => i.id === 'ctl.disaster-recovery')?.status).toBe('ok');
    expect(withDr.find((i) => i.id === 'ctl.siem')?.status).toBe('ok');
    const regulated = cyberChecklist({ ...r, frameworks: ['pci-dss-4'], keys: 'provider-managed' }, ['google']);
    expect(regulated.find((i) => i.id === 'ctl.keys')?.status).toBe('action');
    expect(regulated.every((i) => !/Google Cloud Platform/.test(i.text))).toBe(true);
  });
});
