/**
 * SQL Server setup's ConfigurationFile.ini, rendered by ansible.windows.win_template.
 *
 * Nothing secret is written here: with gMSA or virtual service accounts there
 * is no service password, and the sa password (and a domain service account's
 * password) go on setup.exe's command line from the vault, with no_log.
 * Data, logs, TempDB and backups sit on the separate volumes the design gave
 * the host (mssql_data_dir, mssql_log_dir, mssql_tempdb_dir, mssql_backup_dir).
 */

export const CONFIGURATION_FILE_INI = `; Managed by Ansible (mssql_windows): SQL Server unattended install.
[OPTIONS]
ACTION="Install"
QUIET="True"
UPDATEENABLED="False"
FEATURES={{ mssql_features | join(',') }}
INSTANCENAME="{{ mssql_instance_name }}"
INSTANCEID="{{ mssql_instance_name }}"
SQLCOLLATION="{{ mssql_collation }}"
SQLSVCACCOUNT="{{ mssql_service_account }}"
SQLSVCSTARTUPTYPE="Automatic"
AGTSVCACCOUNT="{{ mssql_agent_account }}"
AGTSVCSTARTUPTYPE="Automatic"
SQLSVCINSTANTFILEINIT="True"
SQLSYSADMINACCOUNTS={% for account in mssql_sysadmins %}"{{ account }}" {% endfor %}

SECURITYMODE="SQL"
TCPENABLED="1"
NPENABLED="0"
SQLUSERDBDIR="{{ mssql_data_dir }}"
SQLUSERDBLOGDIR="{{ mssql_log_dir }}"
SQLTEMPDBDIR="{{ mssql_tempdb_dir }}"
SQLTEMPDBLOGDIR="{{ mssql_tempdb_dir }}"
SQLBACKUPDIR="{{ mssql_backup_dir }}"
SQLTEMPDBFILECOUNT="{{ mssql_tempdb_file_count }}"
{% if 'FULLTEXT' in mssql_features %}
FTSVCACCOUNT="NT Service\\MSSQLFDLauncher{{ '' if mssql_instance_name == 'MSSQLSERVER' else '$' ~ mssql_instance_name }}"
{% endif %}
`;
