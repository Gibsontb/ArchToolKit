/**
 * mig_oracle_db: the oracle_db role, for Oracle Database on a VM (IaaS).
 * Oracle Linux 8/9 and RHEL 8/9 only; the role refuses anything else.
 */

import { info } from '../../../core/findings.js';
import { ORACLE_DB } from '../../migration/roles/index.js';
import { BACKUP_TIER_INPUT, FALSE_TRUE, migrationBlueprint, number, text, yes } from './common.js';

export const MIG_ORACLE_DB = migrationBlueprint({
  id: 'mig_oracle_db',
  label: 'Migration – Oracle Database on a VM',
  description:
    'Oracle Database 19c, 23ai or 26ai on Oracle Linux or RHEL 8/9: prerequisites, the software from your own repository, the listener, one container database with archive logging and a recovery area, start with the host, RMAN backups for the tier, and Data Guard broker when a standby is planned.',
  inputs: [
    {
      id: 'version',
      label: 'Version',
      control: 'select',
      options: [
        { value: '19c', label: '19c' },
        { value: '23ai', label: '23ai' },
        { value: '26ai', label: '26ai' },
      ],
      default: '19c',
    },
    {
      id: 'edition',
      label: 'Edition',
      control: 'select',
      options: [
        { value: 'ee', label: 'Enterprise Edition' },
        { value: 'se2', label: 'Standard Edition 2' },
      ],
      default: 'ee',
    },
    { id: 'media_url', label: 'Database home zip (your repository)', control: 'text', default: '', hint: 'https://repo.internal/oracle/LINUX.X64_193000_db_home.zip; never downloaded from Oracle' },
    { id: 'sid', label: 'SID', control: 'text', default: 'ORCL' },
    { id: 'pdb_name', label: 'Pluggable database', control: 'text', default: 'PDB1' },
    { id: 'character_set', label: 'Character set', control: 'text', default: 'AL32UTF8' },
    { id: 'memory_percent', label: 'SGA + PGA', control: 'number', default: 40, min: 10, max: 80, hint: '% of RAM' },
    { id: 'data_dir', label: 'Data files', control: 'text', default: '/u02/oradata' },
    { id: 'fra_dir', label: 'Recovery area', control: 'text', default: '/u03/fra' },
    { id: 'fra_size_gb', label: 'Recovery area size', control: 'number', default: 50, min: 1, hint: 'GiB' },
    BACKUP_TIER_INPUT,
    {
      id: 'dr',
      label: 'Disaster recovery',
      control: 'select',
      options: [
        { value: 'none', label: 'None' },
        { value: 'data-guard-remote', label: 'Data Guard to a standby in the plan' },
      ],
      default: 'none',
    },
    { id: 'standby_host', label: 'Standby host (inventory name)', control: 'text', default: '', showWhen: { input: 'dr', equals: ['data-guard-remote'] } },
    { id: 'standby_db_unique_name', label: 'Standby DB_UNIQUE_NAME', control: 'text', default: '', showWhen: { input: 'dr', equals: ['data-guard-remote'] } },
    { id: 'standby_ready', label: 'Standby already instantiated', control: 'select', options: FALSE_TRUE, default: 'false', hint: 'Create the broker configuration', showWhen: { input: 'dr', equals: ['data-guard-remote'] } },
  ],
  become: true,
  roles: () => [ORACLE_DB],
  vars: (v) => ({
    mig_oracle_version: text(v.version, '19c'),
    mig_oracle_edition: text(v.edition, 'ee'),
    mig_oracle_media_url: text(v.media_url),
    mig_oracle_sid: text(v.sid, 'ORCL'),
    mig_oracle_pdb_name: text(v.pdb_name, 'PDB1'),
    mig_oracle_character_set: text(v.character_set, 'AL32UTF8'),
    mig_oracle_memory_percent: number(v.memory_percent, 40),
    mig_oracle_data_dir: text(v.data_dir, '/u02/oradata'),
    mig_oracle_fra_dir: text(v.fra_dir, '/u03/fra'),
    mig_oracle_fra_size_mb: number(v.fra_size_gb, 50) * 1024,
    mig_oracle_backup_tier: text(v.backup_tier, 'silver'),
    mig_oracle_dr: text(v.dr, 'none'),
    mig_oracle_standby_host: text(v.standby_host),
    mig_oracle_standby_db_unique_name: text(v.standby_db_unique_name),
    mig_oracle_standby_ready: yes(v.standby_ready),
  }),
  findings: (v) => [
    info(
      'ansible.migration.oracle-media',
      'Put the database home zip in your own repository and set its URL: Oracle software is downloaded only after accepting the licence on Oracle’s site, so the toolkit never fetches it.',
      {},
    ),
    ...(text(v.version, '19c') === '19c'
      ? [
          info(
            'ansible.migration.oracle-19c-el9',
            '19c is supported on Oracle Linux 9 / RHEL 9 from release update 19.19; install from a gold image at 19.19 or later (the 19.3 base image needs the RU applied). CV_ASSUME_DISTID is set for the installer checks.',
            { source: 'https://docs.oracle.com/en/database/oracle/oracle-database/19/ladbi/' },
          ),
        ]
      : []),
    ...(text(v.dr, 'none') === 'data-guard-remote'
      ? [
          info(
            'ansible.migration.oracle-data-guard',
            'The primary is prepared (force logging, broker started). The standby is instantiated with RMAN DUPLICATE FROM ACTIVE DATABASE as a runbook step; then set "Standby already instantiated" and run again to create the broker configuration.',
            {},
          ),
        ]
      : []),
  ],
});
