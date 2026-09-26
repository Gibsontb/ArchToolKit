/**
 * The Oracle Database response files: software-only install (db_install.rsp)
 * and database creation (dbca.rsp), for 19c and 23ai/26ai (26ai ships as a
 * 23 release update, so it takes the 23 schema).
 *
 * No password is in either file. dbca takes -sysPassword, -systemPassword and
 * -pdbAdminPassword on its command line from environment variables the
 * oracle_db role sets from the vault, with no_log.
 */

export const DB_INSTALL_RSP = `# Managed by Ansible (oracle_db): Oracle Database software-only install.
oracle.install.responseFileVersion=/oracle/install/rspfmt_dbinstall_response_schema_v{{ '23.0.0' if oracle_release_major | int >= 23 else '19.0.0' }}
oracle.install.option=INSTALL_DB_SWONLY
UNIX_GROUP_NAME=oinstall
INVENTORY_LOCATION={{ oracle_inventory }}
ORACLE_HOME={{ oracle_home }}
ORACLE_BASE={{ oracle_base }}
oracle.install.db.InstallEdition={{ 'SE2' if oracle_edition | lower == 'se2' else 'EE' }}
oracle.install.db.OSDBA_GROUP=dba
oracle.install.db.OSOPER_GROUP=oper
oracle.install.db.OSBACKUPDBA_GROUP=backupdba
oracle.install.db.OSDGDBA_GROUP=dgdba
oracle.install.db.OSKMDBA_GROUP=kmdba
oracle.install.db.OSRACDBA_GROUP=racdba
oracle.install.db.rootconfig.executeRootScript=false
{% if oracle_release_major | int < 23 %}
DECLINE_SECURITY_UPDATES=true
{% endif %}
`;

export const DBCA_RSP = `# Managed by Ansible (oracle_db): database creation with dbca -silent.
responseFileVersion=/oracle/assistants/rspfmt_dbca_response_schema_v{{ '23.0.0' if oracle_release_major | int >= 23 else '19.0.0' }}
gdbName={{ oracle_db_name }}
sid={{ oracle_sid }}
databaseConfigType=SI
templateName=General_Purpose.dbc
createAsContainerDatabase=true
numberOfPDBs=1
pdbName={{ oracle_pdb_name }}
characterSet={{ oracle_character_set }}
nationalCharacterSet=AL16UTF16
storageType=FS
datafileDestination={{ oracle_data_dir }}
recoveryAreaDestination={{ oracle_fra_dir }}
recoveryAreaSize={{ oracle_fra_size_mb }}
enableArchive=true
memoryMgmtType=AUTO_SGA
totalMemory={{ oracle_memory_mb }}
automaticMemoryManagement=false
emConfiguration=NONE
listeners=LISTENER
sampleSchema=false
`;

/** RMAN backup script, run by cron as the oracle user. Level 0 or 1 is the first argument. */
export const RMAN_BACKUP_SH = `#!/bin/bash
# Managed by Ansible (oracle_db): RMAN backup. Usage: rman_backup.sh 0|1
set -euo pipefail
export ORACLE_SID="{{ oracle_sid }}"
export ORACLE_HOME="{{ oracle_home }}"
export PATH="$ORACLE_HOME/bin:$PATH"
LEVEL="\${1:-1}"
"$ORACLE_HOME/bin/rman" target / <<EOF
CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF {{ oracle_backup_retention_days }} DAYS;
CONFIGURE CONTROLFILE AUTOBACKUP ON;
BACKUP INCREMENTAL LEVEL \${LEVEL} DATABASE PLUS ARCHIVELOG DELETE INPUT;
DELETE NOPROMPT OBSOLETE;
EOF
`;

/** systemd unit that starts and stops the databases marked Y in /etc/oratab. */
export const ORACLE_SERVICE = `# Managed by Ansible (oracle_db)
[Unit]
Description=Oracle Database and listener ({{ oracle_sid }})
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
User=oracle
Group=oinstall
Environment=ORACLE_HOME={{ oracle_home }}
ExecStart={{ oracle_home }}/bin/dbstart {{ oracle_home }}
ExecStop={{ oracle_home }}/bin/dbshut {{ oracle_home }}
TimeoutSec=600

[Install]
WantedBy=multi-user.target
`;
