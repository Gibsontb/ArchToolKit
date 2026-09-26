/**
 * mig_mysql_server: the mysql_server role.
 */

import { info } from '../../../core/findings.js';
import { MYSQL_SERVER } from '../../migration/roles/index.js';
import { list, migrationBlueprint, number, text } from './common.js';

export const MIG_MYSQL_SERVER = migrationBlueprint({
  id: 'mig_mysql_server',
  label: 'Migration – MySQL or MariaDB server',
  description:
    "MySQL 8.4 or 8.0 from Oracle's repository, or MariaDB from the distribution, with the buffer pool at 70% of RAM, bind-address :: (IPv4 and IPv6), GTID binary logging, root secured from the vault, and group replication configured when HA says so.",
  inputs: [
    {
      id: 'flavour',
      label: 'Server',
      control: 'select',
      options: [
        { value: 'mysql', label: 'MySQL' },
        { value: 'mariadb', label: 'MariaDB (distribution packages)' },
      ],
      default: 'mysql',
    },
    {
      id: 'version',
      label: 'MySQL version',
      control: 'select',
      options: [
        { value: '8.4', label: '8.4 LTS' },
        { value: '8.0', label: '8.0' },
      ],
      default: '8.4',
      showWhen: { input: 'flavour', equals: ['mysql'] },
    },
    { id: 'port', label: 'Port', control: 'number', default: 3306, min: 1, max: 65535 },
    { id: 'bind_address', label: 'Bind address', control: 'text', default: '::', hint: ':: listens on IPv6 and IPv4' },
    { id: 'buffer_pool_percent', label: 'InnoDB buffer pool', control: 'number', default: 70, min: 10, max: 90, hint: '% of RAM' },
    {
      id: 'ha',
      label: 'High availability',
      control: 'select',
      options: [
        { value: 'none', label: 'None' },
        { value: 'group-replication', label: 'Group replication (MySQL)' },
      ],
      default: 'none',
    },
    { id: 'group_name', label: 'Group name (UUID)', control: 'text', default: '', showWhen: { input: 'ha', equals: ['group-replication'] } },
    { id: 'group_seeds', label: 'Group seeds', control: 'text', default: '', hint: 'host:33061, comma separated', showWhen: { input: 'ha', equals: ['group-replication'] } },
  ],
  become: true,
  roles: () => [MYSQL_SERVER],
  vars: (v) => ({
    mig_mysql_flavour: text(v.flavour, 'mysql'),
    mig_mysql_version: text(v.version, '8.4'),
    mig_mysql_port: number(v.port, 3306),
    mig_mysql_bind_address: text(v.bind_address, '::'),
    mig_mysql_buffer_pool_percent: number(v.buffer_pool_percent, 70),
    mig_mysql_ha: text(v.ha, 'none'),
    mig_mysql_group_replication_name: text(v.group_name),
    mig_mysql_group_replication_seeds: list(v.group_seeds),
  }),
  findings: (v) =>
    text(v.ha, 'none') === 'group-replication'
      ? [info('ansible.migration.mysql-group-replication', 'Group replication is configured but not started: bootstrap the group once on the first member by hand (the runbook has the step), then start it on the others.', {})]
      : [],
});
