/**
 * Server settings for PostgreSQL and MySQL/MariaDB.
 *
 * Both are written as an include beside the distribution's own file rather
 * than a replacement of it: the Debian packages keep data_directory, hba_file
 * and the socket paths in postgresql.conf, and the MySQL packages keep the
 * datadir and pid paths in theirs, and a full replacement would have to carry
 * every distribution's values. The include wins because it is read last.
 */

/** postgresql.conf settings, written to conf.d/ under the cluster's configuration directory. */
export const POSTGRESQL_CONF = `# Managed by Ansible (postgres_server). Read after postgresql.conf, so these win.
listen_addresses = '{{ postgres_listen_addresses | join(",") }}'
port = {{ postgres_port }}
max_connections = {{ postgres_max_connections }}
shared_buffers = {{ (ansible_facts.memtotal_mb * postgres_shared_buffers_percent / 100) | int }}MB
effective_cache_size = {{ (ansible_facts.memtotal_mb * postgres_effective_cache_percent / 100) | int }}MB
maintenance_work_mem = {{ [ (ansible_facts.memtotal_mb / 16) | int, 2048 ] | min }}MB
password_encryption = scram-sha-256
wal_level = replica
max_wal_senders = 10
max_replication_slots = 10
wal_keep_size = 1GB
hot_standby = on
log_line_prefix = '%m [%p] %q%u@%d '
log_min_duration_statement = 1000
log_checkpoints = on
log_connections = on
log_disconnections = on
`;

/** my.cnf settings, written to the server's include directory. */
export const MY_CNF = `# Managed by Ansible (mysql_server). Read after the package's own my.cnf, so these win.
[mysqld]
bind-address = {{ mysql_bind_address }}
port = {{ mysql_port }}
max_connections = {{ mysql_max_connections }}
innodb_buffer_pool_size = {{ (ansible_facts.memtotal_mb * mysql_buffer_pool_percent / 100) | int }}M
innodb_flush_log_at_trx_commit = 1
sync_binlog = 1
server_id = {{ mysql_server_id }}
log_bin = mysql-bin
binlog_format = ROW
{% if mysql_flavour == 'mysql' %}
gtid_mode = ON
enforce_gtid_consistency = ON
{% endif %}
{% if mysql_ha == 'group-replication' and mysql_flavour == 'mysql' %}
plugin_load_add = group_replication.so
group_replication_group_name = {{ mysql_group_replication_name }}
group_replication_start_on_boot = OFF
group_replication_local_address = {{ inventory_hostname }}:33061
group_replication_group_seeds = {{ mysql_group_replication_seeds | join(',') }}
group_replication_bootstrap_group = OFF
{% endif %}
`;
