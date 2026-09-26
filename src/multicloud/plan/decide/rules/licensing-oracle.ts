/**
 * Oracle licensing: OCI's core factor, Oracle Database@ inside the other
 * clouds, the vSphere cluster rule, Support Rewards and licence-included SE2
 * on RDS. The SE2 vCPU cap is an elimination (eliminations.ts).
 *
 * The counts themselves (processors, sockets) come from `licenceNeed` and
 * are shown on every option; these rules only move the score.
 */

import { warning } from '../../../../core/findings.ts';
import type { Database } from '../../types.ts';
import type { PlanItem } from '../disposition.ts';
import { rule, type AnyRule } from '../engine.ts';
import { ODB_SERVICES } from './eliminations.ts';

const isOracle = (db: Database): boolean => db.engine === 'oracle' && db.edition !== 'oracle-xe';

export const ORACLE_RULES: readonly AnyRule[] = [
  rule<Database>({
    id: 'lic.oracle.oci-core-factor',
    kind: 'database',
    verification: 'I',
    source: 'https://redresscompliance.com/oracle-oci-cloud-infrastructure-licensing ; https://oraclelicensingexperts.com/oracle-bring-your-own-licensing/',
    applies: (db) => isOracle(db) && (db.licence === 'oracle-processor' || db.licence === 'oracle-ula'),
    evaluate: (_db, o) =>
      o.platform === 'oci'
        ? { delta: 3, reason: 'On OCI, BYOL needs half the processor licences of AWS, Azure or Google Cloud (GCP) IaaS for the same vCPU (two OCPUs per processor).' }
        : undefined,
  }),

  rule<Database>({
    id: 'lic.oracle.odb-in-cloud',
    kind: 'database',
    aliases: ['oracle-database'],
    verification: 'V-DOC',
    source: 'Oracle: Oracle Database@AWS generally available, July 2025 ; https://docs.oracle.com/en-us/iaas/Content/multicloud/regions.htm',
    applies: (db) => db.engine === 'oracle',
    evaluate: (_db, o) =>
      o.service && ODB_SERVICES.includes(o.service)
        ? { delta: 1, reason: 'Oracle Database no longer forces OCI: Oracle Database@AWS, @Azure and @Google Cloud run Oracle hardware inside those clouds (region-limited).' }
        : undefined,
    findings: () => [
      warning('multicloud.oracle.region-constrained', 'Oracle Database@AWS, @Azure and @Google Cloud are available only in specific regions, which may not include the one the rest of the estate needs.', {
        remediation: "Check Oracle's multicloud regional availability list against the region this workload has to sit in.",
        source: 'https://docs.oracle.com/en-us/iaas/Content/multicloud/regions.htm',
      }),
    ],
  }),

  rule<Database>({
    id: 'lic.oracle.vmware-cluster',
    kind: 'database',
    verification: 'C',
    source: 'https://www.oracle.com/assets/partitioning-070609.pdf',
    applies: (db) => isOracle(db),
    evaluate: (_db, o, ctx) => (o.service === 'vmware-vm' ? { reason: ctx.facts['oracle.vmware.all-hosts'].statement } : undefined),
    review: (db, chosen) =>
      chosen?.service === 'vmware-vm'
        ? [warning('plan.oracle.vmware-cluster', `${db.name}: Oracle on vSphere is licensed on every host in the clusters it could run on.`, {
            path: `databases.${db.id}`,
            remediation: 'Run Oracle in a dedicated, small vSphere cluster, and license its hosts.',
            source: 'https://www.oracle.com/assets/partitioning-070609.pdf',
          })]
        : [],
  }),

  rule<PlanItem>({
    id: 'lic.oracle.support-rewards',
    kind: 'any',
    verification: 'C',
    source: 'https://www.oracle.com/cloud/rewards/',
    applies: (_item, ctx) => ctx.requirements.licensing.oracleSupportRewards,
    evaluate: (_item, o) =>
      o.platform === 'oci' ? { delta: 1, reason: 'Oracle Support Rewards: OCI spend earns credit against Oracle technology support.' } : undefined,
  }),

  rule<Database>({
    id: 'lic.oracle.rds-se2-li',
    kind: 'database',
    verification: 'C',
    source: 'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Oracle.Concepts.Licensing.html',
    applies: (db) => db.engine === 'oracle' && db.edition === 'oracle-se2' && db.licence === 'li',
    evaluate: (_db, o) =>
      o.service === 'aws-rds' ? { delta: 2, reason: 'Amazon RDS sells Oracle SE2 licence-included: no licence to bring.' } : undefined,
  }),
];
