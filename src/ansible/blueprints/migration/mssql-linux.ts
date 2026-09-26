/**
 * mig_mssql_linux: the mssql_linux role, SQL Server on Linux.
 */

import { MSSQL_LINUX } from '../../migration/roles/index.ts';
import { migrationBlueprint, number, text } from './common.ts';

export const MIG_MSSQL_LINUX = migrationBlueprint({
  id: 'mig_mssql_linux',
  label: 'Migration – SQL Server on Linux',
  description: "SQL Server from Microsoft's repository for the distribution (RHEL family, Ubuntu, SLES), set up with the edition and the vaulted sa password, a memory limit, the TCP port and the firewall (IPv4 and IPv6).",
  inputs: [
    {
      id: 'version',
      label: 'Version',
      control: 'select',
      options: [
        { value: '2019', label: 'SQL Server 2019' },
        { value: '2022', label: 'SQL Server 2022' },
        { value: '2025', label: 'SQL Server 2025' },
      ],
      default: '2022',
    },
    {
      id: 'edition',
      label: 'Edition (MSSQL_PID)',
      control: 'select',
      options: [
        { value: 'Enterprise', label: 'Enterprise' },
        { value: 'Standard', label: 'Standard' },
        { value: 'Developer', label: 'Developer' },
        { value: 'Express', label: 'Express' },
        { value: 'Evaluation', label: 'Evaluation' },
      ],
      default: 'Enterprise',
    },
    { id: 'memory_percent', label: 'Memory limit', control: 'number', default: 80, min: 20, max: 95, hint: '% of RAM' },
    { id: 'port', label: 'TCP port', control: 'number', default: 1433, min: 1, max: 65535 },
  ],
  become: true,
  roles: () => [MSSQL_LINUX],
  vars: (v) => ({
    mig_mssql_version: text(v.version, '2022'),
    mig_mssql_edition: text(v.edition, 'Enterprise'),
    mig_mssql_memory_percent: number(v.memory_percent, 80),
    mig_mssql_port: number(v.port, 1433),
  }),
});
