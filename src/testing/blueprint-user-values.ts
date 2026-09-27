/**
 * Test data: the values a user gives the migration blueprints that no
 * blueprint defaults (see migration.test.ts, import-format.test.ts,
 * stack.test.ts). The landing zones build no network of their own, and the
 * ODB, relocate and directory ranges and the domain controllers' addresses
 * are never picked, so without these those blueprints refuse to build.
 */

import type { BlueprintValues } from '../kit/blueprint.ts';

export const LZ_NETWORKS = 'prod | prod | 10.40.0.0/16 | yes | hub | \nnonprod | dev test | 10.41.0.0/16 | yes | spoke | ';
const tierRows = (zones: readonly string[], net: string, second: number): string[] =>
  ['web', 'app', 'db', 'mgmt'].flatMap((t, ti) => zones.map((z, zi) => `${net} | ${t}${z === 'regional' ? '' : `-${z.slice(-1)}`} | ${t} | ${z} | 10.${second}.${ti * zones.length + zi}.0/24 | yes`));
export const USER_VALUES: Readonly<Record<string, BlueprintValues>> = {
  aws_mig_landing_zone: {
    networks: LZ_NETWORKS,
    subnets: [...tierRows(['us-east-1a', 'us-east-1b'], 'prod', 40), ...tierRows(['us-east-1a'], 'nonprod', 41),
      'prod | tgw-a | tgw-attachment | us-east-1a | 10.40.200.0/28 | no', 'prod | tgw-b | tgw-attachment | us-east-1b | 10.40.200.16/28 | no'].join('\n'),
  },
  azure_mig_landing_zone: {
    networks: LZ_NETWORKS,
    subnets: [...tierRows(['regional'], 'prod', 40), ...tierRows(['regional'], 'nonprod', 41),
      'prod | GatewaySubnet | GatewaySubnet | regional | 10.40.200.0/27 | no', 'prod | AzureBastionSubnet | AzureBastionSubnet | regional | 10.40.200.64/26 | no',
      'prod | sqlmi | sqlmi | regional | 10.40.201.0/24 | no', 'prod | postgres | postgres | regional | 10.40.202.0/24 | no', 'prod | mysql | mysql | regional | 10.40.203.0/24 | no',
      'prod | oracle | oracle | regional | 10.40.204.0/24 | no', 'prod | dns-resolver | dns-resolver | regional | 10.40.205.0/28 | no'].join('\n'),
  },
  google_mig_landing_zone: {
    networks: LZ_NETWORKS,
    subnets: [...tierRows(['regional'], 'prod', 40), ...tierRows(['regional'], 'nonprod', 41), 'prod | proxy | proxy-only | regional | 10.40.254.0/23 | no'].join('\n'),
  },
  oci_mig_landing_zone: { networks: LZ_NETWORKS, subnets: [...tierRows(['regional'], 'prod', 40), ...tierRows(['regional'], 'nonprod', 41)].join('\n') },
  aws_mig_identity: { dns_forwarders: '10.0.0.10 10.0.0.11' },
  azure_mig_identity: { dns_forwarders: '10.0.0.10 10.0.0.11' },
  google_mig_identity: { dns_forwarders: '10.0.0.10 10.0.0.11', reserved_ip_range: '10.99.0.0/24' },
  aws_mig_oracle_database: { odb_network_cidr: '10.60.0.0/24' },
  google_mig_oracle_database: { odb_network_cidr: '10.60.0.0/24' },
  azure_mig_avs: { management_cidr: '10.200.0.0/22' },
  google_mig_gcve: { management_cidr: '10.200.0.0/22' },
  oci_mig_ocvs: { management_cidr: '10.200.0.0/21' },
};

