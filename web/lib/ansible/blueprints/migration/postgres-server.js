/**
 * mig_postgres_server: the postgres_server role.
 */

import { POSTGRES_SERVER } from '../../migration/roles/index.js';
import { BACKUP_TIER_INPUT, list, migrationBlueprint, number, text } from './common.js';

export const MIG_POSTGRES_SERVER = migrationBlueprint({
  id: 'mig_postgres_server',
  label: 'Migration – PostgreSQL server',
  description:
    'PostgreSQL from PGDG (or the SLES packages), tuned to the host (shared_buffers 25%, effective_cache_size 75%), listening on IPv4 and IPv6, app subnets admitted with scram-sha-256, an admin role from the vault, a streaming replica when HA says so, and scheduled dumps for the backup tier.',
  inputs: [
    {
      id: 'version',
      label: 'Version',
      control: 'select',
      options: ['13', '14', '15', '16', '17'].map((v) => ({ value: v, label: `PostgreSQL ${v}` })),
      default: '16',
    },
    { id: 'port', label: 'Port', control: 'number', default: 5432, min: 1, max: 65535 },
    { id: 'client_cidrs', label: 'Client subnets', control: 'text', default: '', hint: 'App subnets, IPv4 and IPv6, comma separated' },
    { id: 'admin_user', label: 'Admin role', control: 'text', default: 'dbadmin', hint: 'Password: vault_postgres_password' },
    { id: 'max_connections', label: 'Max connections', control: 'number', default: 200, min: 10 },
    {
      id: 'ha',
      label: 'High availability',
      control: 'select',
      options: [
        { value: 'none', label: 'None' },
        { value: 'pg-streaming', label: 'Streaming replica' },
      ],
      default: 'none',
    },
    { id: 'primary', label: 'Primary (inventory name)', control: 'text', default: '', showWhen: { input: 'ha', equals: ['pg-streaming'] } },
    { id: 'replication_cidrs', label: 'Replica subnets', control: 'text', default: '', hint: 'The DB subnets, IPv4 and IPv6', showWhen: { input: 'ha', equals: ['pg-streaming'] } },
    BACKUP_TIER_INPUT,
  ],
  become: true,
  roles: () => [POSTGRES_SERVER],
  vars: (v) => ({
    mig_postgres_version: text(v.version, '16'),
    mig_postgres_port: number(v.port, 5432),
    mig_postgres_client_cidrs: list(v.client_cidrs),
    mig_postgres_admin_user: text(v.admin_user, 'dbadmin'),
    mig_postgres_max_connections: number(v.max_connections, 200),
    mig_postgres_ha: text(v.ha, 'none'),
    mig_postgres_primary: text(v.primary),
    mig_postgres_replication_cidrs: list(v.replication_cidrs),
    mig_postgres_backup_tier: text(v.backup_tier, 'silver'),
  }),
});
