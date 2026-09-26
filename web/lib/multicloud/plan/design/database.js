/**
 * Databases: each database placed on a service becomes a `DbTarget`: class
 * or shape, storage, HA, licence model in the provider's spelling, backup
 * tier and engine version.
 *
 * `classOrShape` is written in the provider's own form where it has one, and
 * as `<shape>:<n>` where the provider takes a shape plus a count:
 *
 * | Service | classOrShape |
 * |---|---|
 * | aws-rds / aws-aurora / aws-rds-custom | `db.r7i.2xlarge` (checked against AWS_DB_INSTANCE_CLASS_GROUPS) |
 * | azure-sqldb | `GP_Gen5_8` / `BC_Gen5_8` (sku_name) |
 * | azure-sqlmi | `GP_Gen5_8` / `BC_Gen5_8`: sku_name `GP_Gen5`, vcores 8 |
 * | azure-pg-flex / azure-mysql-flex | `GP_Standard_D4ds_v5` / `MO_Standard_E4ds_v5` |
 * | google-cloudsql | `db-custom-<vCPU>-<MiB>` |
 * | google-alloydb | `cpu-<n>` (machine_config.cpu_count) |
 * | oci-adb / *-odb-adb | `ECPU-<n>` |
 * | oci-basedb / google-odb-basedb | `VM.Standard.E5.Flex:<ocpus>` |
 * | oci-exacs / *-odb-exadata | `Exadata.X11M` (verify the shape in the region) |
 * | oci-mysql-heatwave | `MySQL.<ecpus>` (verify) |
 * | oci-pg | `PostgreSQL.VM.Standard.E5.Flex:<ocpus>` |
 * | IaaS (aws-ec2, azure-vm, azure-sqlvm, google-gce, oci-compute, vmware-vm) | the first host's size |
 */

import { info, warning,              } from '../../../core/findings.js';
import { GCP_DB_TIERS } from '../../../kit/choices.js';
import { LADDERS, rightsizeFor,                  } from '../../../kit/rightsize.js';
import { AWS_DB_INSTANCE_CLASS_GROUPS, AZURE_VM_SIZE_GROUPS } from '../../../kit/sizes-data.js';
import { cloudSqlVersion, DB_SERVICES, DB_VERSIONS } from '../db-catalog.js';
import { licenceNeed } from '../licensing-facts.js';
import { BACKUP_TIER_BY_CRITICALITY, overrideKey } from '../options.js';
                                                                                                             
import { isIaasService, isPerCoreByol } from './compute.js';
                                                              

const values = (groups                                  )                      => new Set(Object.values(groups).flatMap((v) => v.split(',')));
export const RDS_CLASSES = values(AWS_DB_INSTANCE_CLASS_GROUPS);
const AZURE_SIZES = values(AZURE_VM_SIZE_GROUPS);
/** The Cloud SQL tier forms `GCP_DB_TIERS` lists: its values, and any `db-custom-<vCPU>-<MiB>`. */
export const CLOUD_SQL_TIER = /^db-custom-(\d+)-(\d+)$/;
const GCP_TIER_VALUES = new Set(GCP_DB_TIERS.map((o) => o.value));

const up = (ladder                   , n        )                     => ladder.find((x) => x >= n);

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

/**
 * RDS: `db.` plus the rightsized family. RDS has no compute-optimised
 * classes, so general (m) then memory (r). Custom and Aurora take the r
 * family (and RDS Custom the 6th generation, verify).
 */
export function rdsClass(service             , vcpu        , ramGib        )                     {
  const needCpu = Math.max(2, Math.ceil(vcpu));
  const needRam = Math.max(1, Math.ceil(ramGib));
  const general = service === 'aws-rds' && needRam / needCpu <= 4;
  const families = service === 'aws-rds-custom' ? (general ? ['m6i', 'r6i'] : ['r6i']) : service === 'aws-aurora' ? ['r7i'] : general ? ['m7i', 'r7i'] : ['r7i'];
  for (const family of families) {
    const perCpu = family.startsWith('m') ? 4 : 8;
    const fit = LADDERS.aws
      .filter((t) => t.name.startsWith(family.replace(/6i$/, '7i') + '.'))
      .map((t) => ({ name: `db.${family}.${t.name.split('.')[1]}`, vcpu: t.vcpu, ramGib: t.vcpu * perCpu }))
      .filter((t) => RDS_CLASSES.has(t.name) && t.vcpu >= needCpu && t.ramGib >= needRam)
      .sort((a, b) => a.vcpu - b.vcpu)[0];
    if (fit) return fit.name;
  }
  return undefined;
}

/** Cloud SQL custom tier: 1 or an even vCPU count up to 96; 0.9–6.5 GiB per vCPU, in 256 MiB steps, 3,840 MiB minimum. */
export function cloudSqlTier(vcpu        , ramGib        )                     {
  const mib = Math.max(3840, Math.ceil(ramGib * 1024));
  let cpu = Math.max(1, Math.ceil(vcpu), Math.ceil(mib / (6.5 * 1024)));
  if (cpu > 1 && cpu % 2 === 1) cpu += 1;
  if (cpu > 96) return undefined;
  const floor = Math.ceil((cpu * 0.9 * 1024) / 256) * 256;
  const ram = Math.max(floor, Math.ceil(mib / 256) * 256);
  return `db-custom-${cpu}-${ram}`;
}

const SQLMI_VCORES = [4, 8, 16, 24, 32, 40, 64, 80];
const SQLDB_VCORES = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 32, 40, 80];
const FLEX_D = [2, 4, 8, 16, 32, 48, 64];
const FLEX_E = [2, 4, 8, 16, 20, 32, 48, 64];
const ALLOYDB_CPU = [2, 4, 8, 16, 32, 64, 96, 128];
const HEATWAVE_ECPU = [2, 4, 8, 16, 32, 64, 128];
/** The Exadata shape the planner writes for new infrastructure (verify availability in the region). */
export const EXADATA_SHAPE = 'Exadata.X11M';

const MI_BC_HA = new Set(['sql-ag', 'sql-fci', 'sql-mirroring']);

/** Class or shape for a managed service (see the table in the header); undefined when nothing fits. */
export function classFor(service             , db                                          )                     {
  const { vcpu, ramGib } = db;
  const ocpus = Math.max(1, Math.ceil(vcpu / 2));
  switch (service) {
    case 'aws-rds':
    case 'aws-rds-custom':
    case 'aws-aurora':
      return rdsClass(service, vcpu, ramGib);
    case 'azure-sqlmi': {
      const n = up(SQLMI_VCORES, vcpu);
      return n ? `${MI_BC_HA.has(db.ha) ? 'BC' : 'GP'}_Gen5_${n}` : undefined;
    }
    case 'azure-sqldb': {
      const n = up(SQLDB_VCORES, vcpu);
      return n ? `${MI_BC_HA.has(db.ha) ? 'BC' : 'GP'}_Gen5_${n}` : undefined;
    }
    case 'azure-pg-flex':
    case 'azure-mysql-flex': {
      const memory = ramGib / Math.max(1, vcpu) > 4;
      const n = up(memory ? FLEX_E : FLEX_D, Math.max(vcpu, Math.ceil(ramGib / (memory ? 8 : 4))));
      if (!n) return undefined;
      const vm = memory ? `Standard_E${n}ds_v5` : `Standard_D${n}ds_v5`;
      return AZURE_SIZES.has(vm) ? `${memory ? 'MO' : 'GP'}_${vm}` : undefined;
    }
    case 'google-cloudsql':
      return cloudSqlTier(vcpu, ramGib);
    case 'google-alloydb': {
      const n = up(ALLOYDB_CPU, Math.max(vcpu, Math.ceil(ramGib / 8)));
      return n ? `cpu-${n}` : undefined;
    }
    case 'oci-adb':
    case 'aws-odb-adb':
    case 'azure-odb-adb':
    case 'google-odb-adb':
      return `ECPU-${Math.max(2, Math.ceil(vcpu))}`;
    case 'oci-basedb':
    case 'google-odb-basedb':
      return `VM.Standard.E5.Flex:${ocpus}`;
    case 'oci-exacs':
    case 'aws-odb-exadata':
    case 'azure-odb-exadata':
    case 'google-odb-exadata':
      return EXADATA_SHAPE;
    case 'oci-mysql-heatwave': {
      const n = up(HEATWAVE_ECPU, vcpu);
      return n ? `MySQL.${n}` : undefined;
    }
    case 'oci-pg':
      return `PostgreSQL.VM.Standard.E5.Flex:${ocpus}`;
    default:
      return undefined;
  }
}

/** Is a class one the provider sells (the catalogs the design can check). Services without a catalog pass. */
export function classInCatalog(service             , cls        )          {
  if (service === 'aws-rds' || service === 'aws-rds-custom' || service === 'aws-aurora') return RDS_CLASSES.has(cls);
  if (service === 'google-cloudsql') {
    if (GCP_TIER_VALUES.has(cls)) return true;
    const m = CLOUD_SQL_TIER.exec(cls);
    if (!m) return false;
    const cpu = Number(m[1]);
    const mib = Number(m[2]);
    return (cpu === 1 || (cpu % 2 === 0 && cpu <= 96)) && mib % 256 === 0 && mib >= 3840 && mib >= cpu * 0.9 * 1024 && mib <= cpu * 6.5 * 1024;
  }
  if (service === 'azure-pg-flex' || service === 'azure-mysql-flex') return AZURE_SIZES.has(cls.replace(/^(GP|MO)_/, ''));
  return cls.trim() !== '';
}

// ---------------------------------------------------------------------------
// HA, licence model, version, storage
// ---------------------------------------------------------------------------

const top = (c             )          => c === 'tier0' || c === 'tier1';

/** The HA column: none / multi-az / business-critical / zone-redundant / regional / standby / rac, or the IaaS pattern. */
export function haFor(service             , db          , criticality             )         {
  const any = db.ha !== 'none';
  switch (service) {
    case 'aws-rds':
    case 'aws-rds-custom':
    case 'aws-aurora':
      return any || top(criticality) ? 'multi-az' : 'none';
    case 'azure-sqlmi':
    case 'azure-sqldb':
      return MI_BC_HA.has(db.ha) ? 'business-critical' : top(criticality) ? 'zone-redundant' : 'none';
    case 'azure-pg-flex':
    case 'azure-mysql-flex':
      return any || top(criticality) ? 'zone-redundant' : 'none';
    case 'google-cloudsql':
    case 'google-alloydb':
      return any || top(criticality) ? 'regional' : 'none';
    case 'oci-basedb':
    case 'google-odb-basedb':
      return db.ha === 'rac' || db.ha === 'rac-one-node' ? 'rac' : any || top(criticality) ? 'standby' : 'none';
    case 'oci-exacs':
    case 'aws-odb-exadata':
    case 'azure-odb-exadata':
    case 'google-odb-exadata':
      return 'rac';
    case 'oci-adb':
    case 'aws-odb-adb':
    case 'azure-odb-adb':
    case 'google-odb-adb':
      return any || top(criticality) ? 'standby' : 'none';
    case 'oci-mysql-heatwave':
    case 'oci-pg':
      return any || top(criticality) ? 'regional' : 'none';
    default:
      // IaaS: the source's own pattern, rebuilt on the hosts.
      return db.ha;
  }
}

const OSS_RDS                                              = { postgres: 'postgresql-license', mysql: 'general-public-license', mariadb: 'general-public-license' };

/** The licence model in the provider's spelling. */
export function licenceModelFor(service             , db          , need             )         {
  const byol = need.model !== 'li' && need.model !== 'n/a';
  const platform = DB_SERVICES[service].platform;
  if (service === 'aws-rds' || service === 'aws-rds-custom' || service === 'aws-aurora') {
    return OSS_RDS[db.engine] ?? (byol ? 'bring-your-own-license' : 'license-included');
  }
  if (service === 'azure-sqldb' || service === 'azure-sqlmi') return need.model === 'ahb' ? 'BasePrice' : 'LicenseIncluded';
  if (service === 'azure-sqlvm') return need.model === 'ahb' ? 'AHUB' : 'PAYG';
  if (platform === 'oci' || service.includes('-odb-')) {
    if (db.engine !== 'oracle') return 'n/a';
    return byol ? 'BRING_YOUR_OWN_LICENSE' : 'LICENSE_INCLUDED';
  }
  if (isIaasService(service)) return need.kind === 'none' ? 'n/a' : `${need.model === 'li' ? 'LI' : need.model.toUpperCase()}: ${need.count} ${need.kind}`;
  return need.kind === 'none' ? 'n/a' : need.model === 'li' ? 'included' : need.model;
}

/** The engine version in the provider's spelling; '' where the service takes none (Azure SQL). */
export function engineVersionFor(service             , db          )                                           {
  const findings            = [];
  const v = DB_VERSIONS[db.version];
  const missing = (where        )                                           => {
    findings.push(warning('design.db.no-version', `${db.name}: ${where} has no spelling here for ${db.version}; set the version by hand.`, { path: overrideKey('db', db.id, 'version') }));
    return { version: '', findings };
  };
  switch (service) {
    case 'aws-rds':
    case 'aws-rds-custom':
    case 'aws-aurora':
      return v.providers.rds ? { version: v.providers.rds, findings } : missing('RDS');
    case 'google-cloudsql': {
      const s = cloudSqlVersion(db.version, db.edition);
      return s ? { version: s, findings } : missing('Cloud SQL');
    }
    case 'azure-pg-flex':
    case 'azure-mysql-flex':
      return v.providers.azure ? { version: v.providers.azure, findings } : missing('Azure flexible server');
    case 'azure-sqldb':
    case 'azure-sqlmi':
      return { version: '', findings };
    case 'oci-adb':
    case 'aws-odb-adb':
    case 'azure-odb-adb':
    case 'google-odb-adb':
      if (db.version === 'oracle-26ai') {
        findings.push(info('design.db.26ai', `${db.name}: Autonomous Database is given db_version 26ai (verify the spelling the provider accepts).`, { source: v.source }));
        return { version: '26ai', findings };
      }
      return db.version === 'oracle-19c' ? { version: '19c', findings } : missing('Autonomous Database');
    case 'oci-basedb':
    case 'oci-exacs':
    case 'aws-odb-exadata':
    case 'azure-odb-exadata':
    case 'google-odb-exadata':
    case 'google-odb-basedb':
      if (db.version === 'oracle-26ai') {
        findings.push(info('design.db.26ai', `${db.name}: 26ai is delivered as a 23.x release update, so db_version is 23.0.0.0 (verify).`, { source: v.source }));
      }
      return v.providers.oci ? { version: v.providers.oci, findings } : missing('OCI');
    case 'oci-mysql-heatwave':
    case 'oci-pg':
      return v.providers.rds ? { version: v.providers.rds, findings } : missing('OCI');
    default:
      // IaaS: installed by Ansible from the plan's own version id.
      return { version: db.version, findings };
  }
}

/** Storage with 20% growth headroom, raised to the service's floor and step. */
export function storageFor(service             , sizeGib        )         {
  const want = Math.ceil(Math.max(1, sizeGib) * 1.2);
  switch (service) {
    case 'aws-rds':
    case 'aws-rds-custom':
      return Math.max(20, want);
    case 'azure-sqlmi':
      return Math.max(32, Math.ceil(want / 32) * 32);
    case 'google-cloudsql':
      return Math.max(10, want);
    case 'azure-pg-flex':
    case 'azure-mysql-flex':
      return Math.max(32, want);
    case 'oci-adb':
    case 'aws-odb-adb':
    case 'azure-odb-adb':
    case 'google-odb-adb':
      return Math.max(20, want);
    case 'oci-basedb':
    case 'google-odb-basedb':
      return Math.max(256, want);
    default:
      return want;
  }
}

// ---------------------------------------------------------------------------
// Criticality of a database
// ---------------------------------------------------------------------------

const RANK                                        = { tier0: 0, tier1: 1, tier2: 2, tier3: 3 };

/** The app's criticality, else the most critical host's, else tier2. */
export function dbCriticality(plan      , db          )              {
  const app = plan.apps.find((a) => a.name === db.app);
  if (app) return app.criticality;
  const hosts = plan.workloads.filter((w) => db.hosts.includes(w.name)).map((w) => w.criticality);
  return hosts.sort((a, b) => RANK[a] - RANK[b])[0] ?? 'tier2';
}

// ---------------------------------------------------------------------------
// The mapper
// ---------------------------------------------------------------------------

export const databaseMapper               = {
  id: 'database',
  map(ctx               , design) {
    const findings            = [];
    const platform           = ctx.platform;
    const databases             = [];
    for (const db of ctx.databases) {
      const d = ctx.decisionOf(db.id);
      const service = d?.chosen?.service;
      if (!service) continue;
      const criticality = dbCriticality(ctx.plan, db);
      let need = d?.chosen?.licence ?? licenceNeed(db, platform, service, { licensing: ctx.plan.requirements.licensing });

      let classOrShape                    ;
      let hosts                      ;
      if (isIaasService(service)) {
        hosts = [];
        for (const name of db.hosts) {
          const w = ctx.workloadByName(name);
          const t = w && design.compute.find((c) => c.workload === w.id);
          if (t) hosts.push(t.workload);
          else findings.push(warning('design.db.host-elsewhere', `${db.name}: host ${name} is not a compute target on ${platform}, so the database is not on it there.`, {
            remediation: `Place ${name} on ${platform} too, or change the database's host list.`,
          }));
        }
        const first = hosts.map((id) => design.compute.find((c) => c.workload === id) )[0];
        classOrShape = first?.size;
        // Licence-optimised hosts license fewer cores than the source: count on the host as designed.
        if (first && first.vcpu !== db.vcpu && isPerCoreByol(db)) {
          need = licenceNeed({ ...db, vcpu: first.vcpu }, platform, service, {
            licensing: ctx.plan.requirements.licensing,
            ...(first.ocpus !== undefined ? { ocpus: first.ocpus } : {}),
          });
        }
        if (!classOrShape) {
          findings.push(warning('design.db.no-host', `${db.name} runs on ${platform} VMs, but none of its hosts is placed there: add a workload row for its host.`, {
            remediation: 'Add the host as a workload (role db) and name it in the database\'s Hosts column.',
          }));
          const fit = platform === 'vmware' ? null : rightsizeFor(platform               , db.vcpu, db.ramGib, { licenceOptimised: isPerCoreByol(db) });
          classOrShape = fit?.type ?? '';
        }
      } else {
        classOrShape = classFor(service, db);
        if (!classOrShape) {
          findings.push(warning('design.db.no-class', `${db.name}: no ${DB_SERVICES[service].label} class fits ${db.vcpu} vCPU / ${db.ramGib} GiB; set one by hand.`, {
            path: overrideKey('db', db.id, 'class'),
          }));
          classOrShape = '';
        }
      }

      const version = engineVersionFor(service, db);
      findings.push(...version.findings);
      databases.push({
        database: db.id,
        service,
        classOrShape,
        storageGib: storageFor(service, db.sizeGib),
        ha: haFor(service, db, criticality),
        licenceModel: licenceModelFor(service, db, need),
        backupTier: BACKUP_TIER_BY_CRITICALITY[criticality],
        engineVersion: version.version,
        ...(hosts ? { hosts } : {}),
      });

      if (service === 'azure-sqlmi') {
        findings.push(info('design.db.sqlmi-subnet', `${db.name}: SQL Managed Instance needs a subnet delegated to Microsoft.Sql/managedInstances; the landing zone adds it.`));
      }
      if (service.includes('-odb-')) {
        findings.push(info('design.db.odb-region', `${db.name}: Oracle Database@${platform === 'google' ? 'Google Cloud' : platform === 'aws' ? 'AWS' : 'Azure'} is available only in specific regions; check ${design.region}.`, {
          source: 'https://docs.oracle.com/en-us/iaas/Content/multicloud/regions.htm',
        }));
      }
    }
    return { design: { ...design, databases }, findings };
  },
};
