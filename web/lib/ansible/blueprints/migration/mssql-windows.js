/**
 * mig_mssql_windows: the mssql_windows role, SQL Server on a Windows VM.
 */

import { info } from '../../../core/findings.js';
import { MSSQL_WINDOWS } from '../../migration/roles/index.js';
import { BACKUP_TIER_INPUT, FALSE_TRUE, list, migrationBlueprint, number, text, yes } from './common.js';

/** Setup feature names are upper case; a templated list is left to the play. */
const upper = (features                   )                    => (typeof features === 'string' ? features : features.map((f) => f.toUpperCase()));

export const MSSQL_VERSIONS = [
  { value: '2016', label: 'SQL Server 2016' },
  { value: '2017', label: 'SQL Server 2017' },
  { value: '2019', label: 'SQL Server 2019' },
  { value: '2022', label: 'SQL Server 2022' },
  { value: '2025', label: 'SQL Server 2025' },
];

export const MSSQL_EDITIONS = [
  { value: 'Enterprise', label: 'Enterprise' },
  { value: 'Standard', label: 'Standard' },
  { value: 'Developer', label: 'Developer' },
];

export const MIG_MSSQL_WINDOWS = migrationBlueprint({
  id: 'mig_mssql_windows',
  label: 'Migration – SQL Server on Windows',
  description:
    'SQL Server from your own media with ConfigurationFile.ini (gMSA service accounts, TempDB files per core, data, logs and TempDB on their own volumes), or configuration only where the image has it; then max memory, MAXDOP, cost threshold, TCP 1433, the Ola Hallengren maintenance jobs scheduled for the backup tier, and the firewall.',
  inputs: [
    { id: 'version', label: 'Version', control: 'select', options: MSSQL_VERSIONS, default: '2022' },
    { id: 'edition', label: 'Edition', control: 'select', options: MSSQL_EDITIONS, default: 'Enterprise' },
    { id: 'preinstalled', label: 'SQL Server is in the image', control: 'select', options: FALSE_TRUE, default: 'false', hint: 'Azure SQL VM or licence-included SQL images: configure only' },
    { id: 'media_path', label: 'Media folder (setup.exe)', control: 'text', default: '', hint: 'A local path or a share the host can read; your own media', showWhen: { input: 'preinstalled', equals: ['false'] } },
    { id: 'instance_name', label: 'Instance', control: 'text', default: 'MSSQLSERVER', hint: 'MSSQLSERVER for the default instance' },
    { id: 'collation', label: 'Collation', control: 'text', default: 'SQL_Latin1_General_CP1_CI_AS' },
    { id: 'features', label: 'Features', control: 'text', default: 'SQLENGINE,FULLTEXT', hint: 'Setup feature names, comma separated' },
    { id: 'domain', label: 'Domain (DNS name)', control: 'text', default: 'corp.example.com' },
    {
      id: 'service_account_mode',
      label: 'Service accounts',
      control: 'select',
      options: [
        { value: 'gmsa', label: 'Group managed service account (no password)' },
        { value: 'virtual', label: 'Virtual accounts (NT Service\\…)' },
        { value: 'domain', label: 'A domain account (password from the vault)' },
      ],
      default: 'gmsa',
    },
    { id: 'gmsa_name', label: 'gMSA name', control: 'text', default: 'gmsa-sql', showWhen: { input: 'service_account_mode', equals: ['gmsa'] } },
    { id: 'service_account_name', label: 'Service account', control: 'text', default: '', hint: 'DOMAIN\\name', showWhen: { input: 'service_account_mode', equals: ['domain'] } },
    { id: 'sysadmins', label: 'sysadmin logins', control: 'text', default: 'BUILTIN\\Administrators', hint: 'Windows accounts or groups, comma separated' },
    { id: 'data_dir', label: 'Data folder', control: 'text', default: 'D:\\SQLData' },
    { id: 'log_dir', label: 'Log folder', control: 'text', default: 'E:\\SQLLogs' },
    { id: 'tempdb_dir', label: 'TempDB folder', control: 'text', default: 'F:\\TempDB' },
    { id: 'backup_dir', label: 'Backup folder', control: 'text', default: 'G:\\SQLBackup' },
    { id: 'port', label: 'TCP port', control: 'number', default: 1433, min: 1, max: 65535 },
    BACKUP_TIER_INPUT,
  ],
  roles: () => [MSSQL_WINDOWS],
  vars: (v) => ({
    mig_mssql_version: text(v.version, '2022'),
    mig_mssql_edition: text(v.edition, 'Enterprise'),
    mig_mssql_preinstalled: yes(v.preinstalled),
    mig_mssql_media_path: text(v.media_path),
    mig_mssql_instance_name: text(v.instance_name, 'MSSQLSERVER'),
    mig_mssql_collation: text(v.collation, 'SQL_Latin1_General_CP1_CI_AS'),
    mig_mssql_features: upper(list(v.features)),
    mig_mssql_domain: text(v.domain),
    mig_mssql_service_account_mode: text(v.service_account_mode, 'gmsa'),
    mig_mssql_gmsa_name: text(v.gmsa_name, 'gmsa-sql'),
    mig_mssql_service_account_name: text(v.service_account_name),
    mig_mssql_sysadmins: String(v.sysadmins ?? 'BUILTIN\\Administrators').split(',').map((s) => s.trim()).filter(Boolean),
    mig_mssql_data_dir: text(v.data_dir, 'D:\\SQLData'),
    mig_mssql_log_dir: text(v.log_dir, 'E:\\SQLLogs'),
    mig_mssql_tempdb_dir: text(v.tempdb_dir, 'F:\\TempDB'),
    mig_mssql_backup_dir: text(v.backup_dir, 'G:\\SQLBackup'),
    mig_mssql_port: number(v.port, 1433),
    mig_mssql_backup_tier: text(v.backup_tier, 'silver'),
  }),
  findings: (v) => [
    ...(yes(v.preinstalled)
      ? []
      : [
          info(
            'ansible.migration.mssql-media',
            'setup.exe runs from mssql_media_path as the connecting account. Over WinRM a share needs that account to reach it without a second hop: copy the media to a local disk, or use CredSSP or Kerberos delegation.',
            {},
          ),
        ]),
    ...(text(v.service_account_mode, 'gmsa') === 'gmsa'
      ? [
          info(
            'ansible.migration.mssql-gmsa',
            'The gMSA is created with the join account and needs a KDS root key in the domain (mig_ad_dc_promote adds one). A new key is usable after about 10 hours of replication.',
            {},
          ),
        ]
      : []),
  ],
});
