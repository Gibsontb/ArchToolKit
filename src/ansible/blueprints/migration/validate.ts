/**
 * mig_validate: the validate role, run after each wave.
 */

import { VALIDATE } from '../../migration/roles/index.ts';
import { migrationBlueprint, ports, text } from './common.ts';

export const MIG_VALIDATE = migrationBlueprint({
  id: 'mig_validate',
  label: 'Migration – Validate hosts',
  description:
    "Check each host's ports on IPv4 and IPv6, its services, its database, name resolution of the domain and its clock (within 5 seconds), and write reports/validation-<host>.json at the top of the project on the control node.",
  inputs: [
    { id: 'domain', label: 'Domain to resolve', control: 'text', default: '', hint: 'Blank skips the DNS check' },
    { id: 'extra_ports', label: 'Extra ports', control: 'text', default: '', hint: 'Checked on every host, comma separated' },
    { id: 'report_dir', label: 'Report folder (control node)', control: 'text', default: '', hint: 'Blank: reports/ at the top of the project' },
    { id: 'mssql_instance', label: 'SQL Server instance', control: 'text', default: 'MSSQLSERVER' },
  ],
  roles: () => [VALIDATE],
  vars: (v) => ({
    mig_validate_domain: text(v.domain),
    mig_validate_extra_ports: ports(v.extra_ports),
    mig_validate_report_dir: text(v.report_dir),
    mig_validate_mssql_instance: text(v.mssql_instance, 'MSSQLSERVER'),
  }),
});
