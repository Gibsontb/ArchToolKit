/**
 * WP-11d: the SQL Server paths (addendum A.6.6, A.6.9), in PowerShell 7.4 with dbatools, Az.Sql and
 * Az.DataMigration, from the migration controller.
 *
 *   sql-ag-seeding    the target joins the source availability group (or a read-scale AG with
 *                     CLUSTER_TYPE = NONE the kit creates) with automatic seeding; failover at cutover;
 *                     the old primary stays a secondary (the way back)
 *   sql-log-shipping  log shipping; at cutover a tail-log backup WITH NORECOVERY, the last restore,
 *                     recovery, and reverse log shipping target to source (the source is already restoring)
 *   sql-backup-url    BACKUP TO URL (Azure Blob, or s3:// from SQL Server 2022) and RESTORE, offline
 *   sql-mi-link       the Managed Instance link (a distributed AG); planned failover from SQL Server 2022
 *   sql-mi-lrs        Log Replay Service from backups in Blob Storage
 *   sql-rds-native    native backup to S3 and msdb.dbo.rds_restore_database / rds_restore_log NORECOVERY
 *   azure-dms         Azure Database Migration Service to Azure SQL Database (offline)
 *
 * Credentials are in-memory PSCredentials from Get-AtkSecret (the SQL logins), or SecureStrings handed
 * to the cmdlets (SAS tokens, the master key password); T-SQL that carries one goes over the TDS
 * connection, never on a command line or into a file.
 */

import { info, warning,              } from '../../../../core/findings.js';
                                                 
                                                     
import { code } from '../lib-sh.js';
import { psScript } from '../lib-ps.js';
                                                   
                                                                 
import {
  BASE_SETTINGS, DB_DIR, DB_PS_BASE, dbReadme, dbRows, endpointFinding, need, noReverseFinding, onPath, psSettings, withTestSkips,
                                               
} from './common.js';

export const SQLSERVER_PATHS                        = Object.freeze(['sql-ag-seeding', 'sql-log-shipping', 'sql-backup-url', 'sql-mi-link', 'sql-mi-lrs', 'sql-rds-native', 'azure-dms']);

const entryOf = (p        )         => `${DB_DIR}/${p}.ps1`;

/** SQL Server versions with a planned Managed Instance link failover (both ways). */
const PLANNED_FAILOVER_VERSIONS = new Set(['sql-2022', 'sql-2025']);

// ---------------------------------------------------------------------------
// Shared PowerShell
// ---------------------------------------------------------------------------

const PS_SHARED = code`
$script:DbChanged = $false
# Complete-DbVerb: succeeded when the verb changed something (or would have, with -DryRun), else skipped.
function Complete-DbVerb {
  param([string] $State = '', [string] $Detail = '', [hashtable] $Data = @{})
  if ($script:DbChanged) { Set-AtkOutcome succeeded $Detail -State $State -Data $Data } else { Set-AtkOutcome skipped "already in place: $Detail" -State $State -Data $Data }
}
function Get-DbPhase { param([string] $Id) return Get-AtkId -Path (Get-DbConf -Id $Id -Key 'path') -Key "$Id.phase" }
function Set-DbPhase { param([string] $Id, [string] $Phase) Set-AtkId -Path (Get-DbConf -Id $Id -Key 'path') -Key "$Id.phase" -Value $Phase }
function Get-DbName { param([string] $Id) return Get-DbNeed -Id $Id -Key 'dbname' }
function Get-DbState {
  param([string] $Id, [ValidateSet('src', 'tgt')] [string] $Side)
  $r = @(Read-DbSql -Id $Id -Side $Side -Sql "SELECT state_desc AS s FROM sys.databases WHERE name = $(ConvertTo-DbLit (Get-DbName $Id))")
  if ($r.Count) { return [string] $r[0].s } else { return '' }
}
function Get-DbServerName {
  param([string] $Id, [ValidateSet('src', 'tgt')] [string] $Side)
  return [string] @(Read-DbSql -Id $Id -Side $Side -Sql 'SELECT @@SERVERNAME AS n')[0].n
}
# Assert-DbHadr: the AlwaysOn feature must be on (enabling it restarts SQL Server, so it is a runbook step).
function Assert-DbHadr {
  param([string] $Id, [ValidateSet('src', 'tgt')] [string] $Side)
  $on = [int] @(Read-DbSql -Id $Id -Side $Side -Sql "SELECT CAST(SERVERPROPERTY('IsHadrEnabled') AS int) AS h")[0].h
  if ($on -ne 1) { Stop-Atk 5 "$($script:DbConf[$Id].name): enable Always On availability groups on the $(if ($Side -eq 'src') { 'source' } else { 'target' }) (Enable-DbaAgHadr from a Windows host, or mssql-conf set hadr.hadrenabled 1 on Linux) and restart SQL Server" }
}
function Get-DbStamp { return [DateTime]::UtcNow.ToString('yyyyMMddHHmmss', [Globalization.CultureInfo]::InvariantCulture) }
`;

// ---------------------------------------------------------------------------
// sql-ag-seeding
// ---------------------------------------------------------------------------

const AG_FUNCS = code`
# Get-DbAg: the availability group of the database on the source ('' when there is none).
function Get-DbAg {
  param([string] $Id)
  $ag = Get-DbConf -Id $Id -Key 'ag'
  if ($ag) { return $ag }
  $r = @(Read-DbSql -Id $Id -Side src -Sql "SELECT g.name AS n FROM sys.availability_groups g JOIN sys.availability_databases_cluster d ON d.group_id = g.group_id WHERE d.database_name = $(ConvertTo-DbLit (Get-DbName $Id))")
  if ($r.Count) { return [string] $r[0].n }
  return ''
}
function Get-DbAgName { param([string] $Id) $ag = Get-DbAg $Id; if ($ag) { return $ag } else { return Get-DbConf -Id $Id -Key 'kit_ag' } }
function Get-DbAgRole {
  param([string] $Id, [ValidateSet('src', 'tgt')] [string] $Side, [string] $Ag)
  $r = @(Read-DbSql -Id $Id -Side $Side -Sql "SELECT rs.role_desc AS r FROM sys.dm_hadr_availability_replica_states rs JOIN sys.availability_groups g ON g.group_id = rs.group_id WHERE rs.is_local = 1 AND g.name = $(ConvertTo-DbLit $Ag)")
  if ($r.Count) { return [string] $r[0].r } else { return '' }
}
function Get-DbAgSync {
  param([string] $Id, [ValidateSet('src', 'tgt')] [string] $Side, [string] $Ag)
  $r = @(Read-DbSql -Id $Id -Side $Side -Sql "SELECT s.synchronization_state_desc AS s FROM sys.dm_hadr_database_replica_states s JOIN sys.availability_groups g ON g.group_id = s.group_id WHERE s.is_local = 1 AND g.name = $(ConvertTo-DbLit $Ag) AND DB_NAME(s.database_id) = $(ConvertTo-DbLit (Get-DbName $Id))")
  if ($r.Count) { return [string] $r[0].s } else { return '' }
}
function Get-DbAgClusterType {
  param([string] $Id, [string] $Ag)
  $r = @(Read-DbSql -Id $Id -Side src -Sql "SELECT cluster_type_desc AS c FROM sys.availability_groups WHERE name = $(ConvertTo-DbLit $Ag)")
  if ($r.Count) { return [string] $r[0].c } else { return 'none' }
}
# Switch-DbAg FROM TO: a failover with no data loss: FAILOVER on a cluster AG; for CLUSTER_TYPE = NONE the read-scale
# sequence (both synchronous, SYNCHRONIZED, the primary set SECONDARY, the other forced, data movement resumed).
function Switch-DbAg {
  param([string] $Id, [ValidateSet('src', 'tgt')] [string] $From, [ValidateSet('src', 'tgt')] [string] $To, [string] $Ag)
  $toConn = Connect-DbSide -Id $Id -Side $To
  if ((Get-DbAgClusterType -Id $Id -Ag $Ag) -ne 'none') {
    $script:DbChanged = $true; Invoke-AtkStep "fail $Ag over to the $(if ($To -eq 'tgt') { 'target' } else { 'source' })" { Invoke-DbaAgFailover -SqlInstance $toConn -AvailabilityGroup $Ag -Confirm:$false -EnableException | Out-Null }
    return
  }
  Set-DbAgSync -Id $Id -Ag $Ag -Mode SYNCHRONOUS_COMMIT
  $ok = Wait-AtkUntil -Minutes 30 -IntervalSeconds 10 { (Get-DbAgSync -Id $Id -Side $To -Ag $Ag) -eq 'SYNCHRONIZED' }
  if (-not $ok) { Stop-Atk 1 "$Ag is not SYNCHRONIZED on the $(if ($To -eq 'tgt') { 'target' } else { 'source' }); nothing was switched" }
  Invoke-DbSql -Id $Id -Side $From -What "make $Ag secondary here" -Sql "ALTER AVAILABILITY GROUP $(ConvertTo-DbIdent $Ag) SET (ROLE = SECONDARY);"
  Invoke-DbSql -Id $Id -Side $To -What "make $Ag primary here" -Sql "ALTER AVAILABILITY GROUP $(ConvertTo-DbIdent $Ag) FORCE_FAILOVER_ALLOW_DATA_LOSS;"
  Invoke-DbSql -Id $Id -Side $From -What 'resume data movement' -Sql "ALTER DATABASE $(ConvertTo-DbIdent (Get-DbName $Id)) SET HADR RESUME;"
}
# Set-DbAgSync: both replicas' availability mode (run on the current primary).
function Set-DbAgSync {
  param([string] $Id, [string] $Ag, [string] $Mode)
  $primary = if ((Get-DbAgRole -Id $Id -Side src -Ag $Ag) -eq 'PRIMARY') { 'src' } else { 'tgt' }
  $sql = "DECLARE @s nvarchar(max) = N''; SELECT @s += N'ALTER AVAILABILITY GROUP ' + QUOTENAME(g.name) + N' MODIFY REPLICA ON N''' + REPLACE(r.replica_server_name, '''', '''''') + N''' WITH (AVAILABILITY_MODE = $Mode); ' FROM sys.availability_replicas r JOIN sys.availability_groups g ON g.group_id = r.group_id WHERE g.name = $(ConvertTo-DbLit $Ag) AND r.availability_mode_desc <> N'$Mode'; EXEC sp_executesql @s;"
  Invoke-DbSql -Id $Id -Side $primary -What "set $Ag replicas to $Mode" -Sql $sql
}
function Show-DbAgStatus {
  param([string] $Id)
  $ag = Get-DbAgName $Id
  $role = Get-DbAgRole -Id $Id -Side tgt -Ag $ag
  if ($role -eq 'PRIMARY') { Set-AtkOutcome succeeded "the target is the primary of $ag" -State 'cut-over'; return }
  $sync = Get-DbAgSync -Id $Id -Side tgt -Ag $ag
  if (-not $sync) { Set-AtkOutcome succeeded "the target is not in $ag yet" -State 'planned' -Data @{ inSync = $false }; return }
  $seed = @(Read-DbSql -Id $Id -Side src -Sql "SELECT TOP (1) current_state AS s, failure_state_desc AS f FROM sys.dm_hadr_automatic_seeding ORDER BY start_time DESC")
  if ($sync -eq 'SYNCHRONIZED') { Set-AtkOutcome succeeded "$ag is SYNCHRONIZED on the target" -State 'in-sync' -Data @{ inSync = $true; lagSeconds = 0 }; return }
  $detail = "$ag is $sync on the target"
  if ($seed.Count) { $detail += " (seeding: $($seed[0].s))" }
  Set-AtkOutcome succeeded $detail -State 'replicating' -Data @{ inSync = $false }
}
`;

const AG_VERBS = withTestSkips({
  prepare: code`
Assert-DbHadr -Id $Id -Side src
Assert-DbHadr -Id $Id -Side tgt
$src = Connect-DbSide -Id $Id -Side src
$tgt = Connect-DbSide -Id $Id -Side tgt
$db = Get-DbName $Id
$ag = Get-DbAg $Id
$tgtName = Get-DbServerName -Id $Id -Side tgt
if (-not $ag) {
  $ag = Get-DbConf -Id $Id -Key 'kit_ag'
  $has = @(Read-DbSql -Id $Id -Side src -Sql "SELECT 1 AS x FROM sys.availability_groups WHERE name = $(ConvertTo-DbLit $ag)")
  if (-not $has.Count) {
    $script:DbChanged = $true; Invoke-AtkStep "create the read-scale availability group $ag (CLUSTER_TYPE = NONE) with the target" {
      New-DbaAvailabilityGroup -Primary $src -Secondary $tgt -Name $ag -Database $db -ClusterType None -SeedingMode Automatic -FailoverMode Manual -AvailabilityMode AsynchronousCommit -Confirm:$false -EnableException | Out-Null
    }
  }
} else {
  $rep = @(Read-DbSql -Id $Id -Side src -Sql "SELECT 1 AS x FROM sys.availability_replicas r JOIN sys.availability_groups g ON g.group_id = r.group_id WHERE g.name = $(ConvertTo-DbLit $ag) AND r.replica_server_name = $(ConvertTo-DbLit $tgtName)")
  if (-not $rep.Count) {
    $script:DbChanged = $true; Invoke-AtkStep "add the target to $ag (automatic seeding, asynchronous, manual failover)" {
      Get-DbaAvailabilityGroup -SqlInstance $src -AvailabilityGroup $ag -EnableException | Add-DbaAgReplica -SqlInstance $tgt -SeedingMode Automatic -AvailabilityMode AsynchronousCommit -FailoverMode Manual -EnableException | Out-Null
    }
  }
  $joined = @(Read-DbSql -Id $Id -Side tgt -Sql "SELECT 1 AS x FROM sys.availability_groups WHERE name = $(ConvertTo-DbLit $ag)")
  if (-not $joined.Count) {
    $script:DbChanged = $true; Invoke-AtkStep "join the target to $ag" { Join-DbaAvailabilityGroup -SqlInstance $tgt -AvailabilityGroup $ag -EnableException | Out-Null }
  }
  $script:DbChanged = $true; Invoke-AtkStep "let $ag create the seeded database on the target" { Grant-DbaAgPermission -SqlInstance $tgt -Type AvailabilityGroup -AvailabilityGroup $ag -Permission CreateAnyDatabase -EnableException | Out-Null }
}
Complete-DbVerb -State 'prepared' -Detail "the target is a replica of $ag with automatic seeding"`,
  replicate: code`
$ag = Get-DbAgName $Id
if (-not (Get-DbAgSync -Id $Id -Side tgt -Ag $ag)) { Stop-Atk 5 "$($script:DbConf[$Id].name): the target is not in $($ag): run prepare" }
$null = Wait-AtkUntil -Minutes 240 -IntervalSeconds 60 { (Get-DbAgSync -Id $Id -Side tgt -Ag $ag) -in @('SYNCHRONIZING', 'SYNCHRONIZED') }
if ((Get-DbAgSync -Id $Id -Side tgt -Ag $ag) -eq 'SYNCHRONIZING') { Set-DbAgSync -Id $Id -Ag $ag -Mode SYNCHRONOUS_COMMIT }
$null = Wait-AtkUntil -Minutes 60 -IntervalSeconds 20 { (Get-DbAgSync -Id $Id -Side tgt -Ag $ag) -eq 'SYNCHRONIZED' }
Show-DbAgStatus -Id $Id`,
  status: 'Show-DbAgStatus -Id $Id',
  cutover: code`
$ag = Get-DbAgName $Id
if ((Get-DbAgRole -Id $Id -Side tgt -Ag $ag) -eq 'PRIMARY') { Set-AtkOutcome skipped "the target is already the primary of $ag" -State 'cut-over'; return }
Switch-DbAg -Id $Id -From src -To tgt -Ag $ag
Set-DbPhase -Id $Id -Phase 'cut-over'
Set-AtkOutcome succeeded "failed over to the target; the source stays a secondary of $ag (the way back)" -State 'cut-over' -Data @{ reverse = $true }`,
  commit: 'Set-AtkOutcome skipped "nothing to commit: the old primary stays a secondary until finalize"',
  rollback: code`
$ag = Get-DbAgName $Id
if ((Get-DbAgRole -Id $Id -Side tgt -Ag $ag) -ne 'PRIMARY') { Set-AtkOutcome skipped "nothing to roll back: the source is the primary of $ag"; return }
Switch-DbAg -Id $Id -From tgt -To src -Ag $ag
Set-DbPhase -Id $Id -Phase 'rolled-back'
Set-AtkOutcome succeeded "failed back to the source with no data loss: switch the applications back"`,
  finalize: code`
$ag = Get-DbAgName $Id
$srcName = Get-DbServerName -Id $Id -Side src
$tgt = Connect-DbSide -Id $Id -Side tgt
if ((Get-DbAgRole -Id $Id -Side tgt -Ag $ag) -eq 'PRIMARY') {
  $rep = @(Read-DbSql -Id $Id -Side tgt -Sql "SELECT 1 AS x FROM sys.availability_replicas r JOIN sys.availability_groups g ON g.group_id = r.group_id WHERE g.name = $(ConvertTo-DbLit $ag) AND r.replica_server_name = $(ConvertTo-DbLit $srcName)")
  if ($rep.Count) { $script:DbChanged = $true; Invoke-AtkStep "remove the old source from $ag" { Remove-DbaAgReplica -SqlInstance $tgt -AvailabilityGroup $ag -Replica $srcName -Confirm:$false -EnableException | Out-Null } }
}
Complete-DbVerb -Detail "the old source is out of $ag (its database is dropped at decommission)"`,
}, true);

// ---------------------------------------------------------------------------
// sql-log-shipping
// ---------------------------------------------------------------------------

const LS_FUNCS = code`
function Get-DbShare { param([string] $Id) return (Get-DbNeed -Id $Id -Key 'shared_path').TrimEnd('\', '/') }
function Get-DbShareRev { param([string] $Id) $r = Get-DbConf -Id $Id -Key 'shared_path_reverse'; if ($r) { return $r.TrimEnd('\', '/') } else { return (Get-DbShare $Id) + '\atk-reverse' } }
function Test-DbLsPrimary {
  param([string] $Id, [ValidateSet('src', 'tgt')] [string] $Side)
  return @(Read-DbSql -Id $Id -Side $Side -Database 'msdb' -Sql "SELECT 1 AS x FROM dbo.log_shipping_primary_databases WHERE primary_database = $(ConvertTo-DbLit (Get-DbName $Id))").Count -gt 0
}
function Show-DbLsStatus {
  param([string] $Id)
  $reverse = Test-DbLsPrimary -Id $Id -Side tgt
  $side = if ($reverse) { 'src' } else { 'tgt' }
  $conn = Connect-DbSide -Id $Id -Side $side
  $st = @(Test-DbaDbLogShipStatus -SqlInstance $conn -Database (Get-DbName $Id) -Secondary -EnableException)
  if (-not $st.Count) { Set-AtkOutcome succeeded 'no log shipping yet' -State 'planned' -Data @{ inSync = $false }; return }
  $s = [string] $st[0].Status
  $dir = if ($reverse) { 'reverse' } else { 'forward' }
  if ($s -match 'All OK') { Set-AtkOutcome succeeded "$dir log shipping: $s" -State 'in-sync' -Data @{ inSync = $true; direction = $dir }; return }
  Set-AtkOutcome succeeded "$dir log shipping: $s" -State 'replicating' -Data @{ inSync = $false; direction = $dir }
}
# Move-DbLsTail FROM TO SHARE: the tail-log backup WITH NORECOVERY on FROM, the remaining logs and the tail restored on TO, TO recovered.
function Move-DbLsTail {
  param([string] $Id, [ValidateSet('src', 'tgt')] [string] $From, [ValidateSet('src', 'tgt')] [string] $To, [string] $Share)
  $db = Get-DbName $Id
  $tail = "$Share\$($db)_atk_tail_$(Get-DbStamp).trn"
  if ((Get-DbState -Id $Id -Side $From) -eq 'ONLINE') {
    Invoke-DbSql -Id $Id -Side $From -What 'tail-log backup WITH NORECOVERY (the way back stays open)' -Sql "BACKUP LOG $(ConvertTo-DbIdent $db) TO DISK = $(ConvertTo-DbLit $tail) WITH NORECOVERY, INIT, CHECKSUM;"
    Set-AtkId -Path (Get-DbConf -Id $Id -Key 'path') -Key "$Id.tail.$From" -Value $tail
  } else {
    $tail = Get-AtkId -Path (Get-DbConf -Id $Id -Key 'path') -Key "$Id.tail.$From"
  }
  if ((Get-DbState -Id $Id -Side $To) -eq 'RESTORING') {
    $toConn = Connect-DbSide -Id $Id -Side $To
    $script:DbChanged = $true; Invoke-AtkStep 'apply the remaining shipped logs (log shipping jobs disabled)' { Invoke-DbaDbLogShipRecovery -SqlInstance $toConn -Database $db -NoRecovery -Force -Confirm:$false -EnableException | Out-Null }
    if (-not $tail) { Stop-Atk 1 "$($script:DbConf[$Id].name): the tail-log backup is not recorded; restore it by hand" }
    $script:DbChanged = $true; Invoke-AtkStep 'restore the tail and recover' { Restore-DbaDatabase -SqlInstance $toConn -Path $tail -DatabaseName $db -Continue -EnableException | Out-Null }
  }
}
`;

const LS_VERBS = withTestSkips({
  prepare: code`
$src = Connect-DbSide -Id $Id -Side src
$tgt = Connect-DbSide -Id $Id -Side tgt
if (-not (Test-DbLsPrimary -Id $Id -Side src)) {
  $script:DbChanged = $true; Invoke-AtkStep 'set up log shipping from the source to the target (full backup, compressed)' {
    Invoke-DbaDbLogShipping -SourceSqlInstance $src -DestinationSqlInstance $tgt -Database (Get-DbName $Id) -SharedPath (Get-DbShare $Id) -GenerateFullBackup -CompressBackup -Force -EnableException | Out-Null
  }
}
Complete-DbVerb -State 'prepared' -Detail 'log shipping from the source to the target is configured'`,
  replicate: code`
$null = Wait-AtkUntil -Minutes 240 -IntervalSeconds 60 { @(Test-DbaDbLogShipStatus -SqlInstance (Connect-DbSide -Id $Id -Side tgt) -Database (Get-DbName $Id) -Secondary).Where({ $_.Status -match 'All OK' }).Count -gt 0 }
Show-DbLsStatus -Id $Id`,
  status: 'Show-DbLsStatus -Id $Id',
  cutover: code`
if ((Get-DbPhase $Id) -eq 'cut-over') { Set-AtkOutcome skipped 'already cut over' -State 'cut-over'; return }
$db = Get-DbName $Id
$src = Connect-DbSide -Id $Id -Side src
$tgt = Connect-DbSide -Id $Id -Side tgt
Move-DbLsTail -Id $Id -From src -To tgt -Share (Get-DbShare $Id)
$job = "LSBackup_$db"
if (@(Get-DbaAgentJob -SqlInstance $src -Job $job).Where({ $_.IsEnabled }).Count) { $script:DbChanged = $true; Invoke-AtkStep "disable $job on the source" { Set-DbaAgentJob -SqlInstance $src -Job $job -Disabled -EnableException | Out-Null } }
$rev = $false
if (Test-DbOn -Id $Id -Key 'reverse') {
  if (-not (Test-DbLsPrimary -Id $Id -Side tgt)) {
    $script:DbChanged = $true; Invoke-AtkStep 'set up reverse log shipping from the target to the source (the source is restoring: no new full backup)' {
      Invoke-DbaDbLogShipping -SourceSqlInstance $tgt -DestinationSqlInstance $src -Database $db -SharedPath (Get-DbShareRev $Id) -NoInitialization -CompressBackup -Force -EnableException | Out-Null
    }
  }
  $rev = $true
}
Set-DbPhase -Id $Id -Phase 'cut-over'
Set-AtkOutcome succeeded "the target is recovered after the tail-log backup; reverse log shipping: $rev" -State 'cut-over' -Data @{ reverse = $rev }`,
  commit: 'Set-AtkOutcome skipped "nothing to commit: the reverse log shipping stays until finalize"',
  rollback: code`
$phase = Get-DbPhase $Id
if ($phase -eq 'rolled-back') { Set-AtkOutcome skipped 'already rolled back'; return }
if (Test-DbLsPrimary -Id $Id -Side tgt) {
  Move-DbLsTail -Id $Id -From tgt -To src -Share (Get-DbShareRev $Id)
  Set-DbPhase -Id $Id -Phase 'rolled-back'
  Set-AtkOutcome succeeded "the source has the target's writes (the reverse chain and the target's tail applied) and is recovered: switch the applications back"
  return
}
if ((Get-DbState -Id $Id -Side src) -eq 'RESTORING') {
  Invoke-DbSql -Id $Id -Side src -What 'recover the source' -Sql "RESTORE DATABASE $(ConvertTo-DbIdent (Get-DbName $Id)) WITH RECOVERY;"
  Set-DbPhase -Id $Id -Phase 'rolled-back'
  Set-AtkOutcome succeeded "the source is recovered as of the tail-log backup; the target's writes since cutover are not carried back (no reverse log shipping)"
  return
}
Set-AtkOutcome skipped 'nothing to roll back: the source was not changed'`,
  finalize: code`
$src = Connect-DbSide -Id $Id -Side src
$tgt = Connect-DbSide -Id $Id -Side tgt
$db = Get-DbName $Id
if (Test-DbLsPrimary -Id $Id -Side src) { $script:DbChanged = $true; Invoke-AtkStep 'remove the forward log shipping' { Remove-DbaDbLogShipping -PrimarySqlInstance $src -SecondarySqlInstance $tgt -Database $db -Confirm:$false -EnableException | Out-Null } }
if (Test-DbLsPrimary -Id $Id -Side tgt) { $script:DbChanged = $true; Invoke-AtkStep 'remove the reverse log shipping' { Remove-DbaDbLogShipping -PrimarySqlInstance $tgt -SecondarySqlInstance $src -Database $db -Confirm:$false -EnableException | Out-Null } }
Complete-DbVerb -Detail 'log shipping removed in both directions'`,
}, true);

// ---------------------------------------------------------------------------
// sql-backup-url
// ---------------------------------------------------------------------------

const URL_FUNCS = code`
function Get-DbUrl { param([string] $Id) return (Get-DbNeed -Id $Id -Key 'backup_url').TrimEnd('/') }
# Get-DbUrlCredentialName: the credential SQL Server matches to the URL (the container URL, or s3://host/bucket).
function Get-DbUrlCredentialName { param([string] $Id) return Get-DbUrl $Id }
function Add-DbUrlCredential {
  param([string] $Id, [ValidateSet('src', 'tgt')] [string] $Side)
  $name = Get-DbUrlCredentialName $Id
  $has = @(Read-DbSql -Id $Id -Side $Side -Sql "SELECT 1 AS x FROM sys.credentials WHERE name = $(ConvertTo-DbLit $name)")
  if ($has.Count) { return }
  $identity = if ($name.StartsWith('s3://')) { 'S3 Access Key' } else { 'SHARED ACCESS SIGNATURE' }
  $plain = (Get-AtkSecret -Name "BACKUP_URL_SECRET_$($script:DbConf[$Id].envtok)").TrimStart('?')
  $conn = Connect-DbSide -Id $Id -Side $Side
  $script:DbChanged = $true; Invoke-AtkStep "create the credential for $name on the $(if ($Side -eq 'src') { 'source' } else { 'target' })" {
    New-DbaCredential -SqlInstance $conn -Name $name -Identity $identity -SecurePassword (ConvertTo-SecureString -String $plain -AsPlainText -Force) -EnableException | Out-Null
  }
}
`;

const URL_VERBS = withTestSkips({
  prepare: code`
Add-DbUrlCredential -Id $Id -Side src
Add-DbUrlCredential -Id $Id -Side tgt
Complete-DbVerb -State 'prepared' -Detail "both servers hold the credential for $(Get-DbUrl $Id)"`,
  replicate: 'Set-AtkOutcome skipped "an offline path: the backup and restore run at cutover, after the freeze"',
  status: 'Set-AtkOutcome skipped "an offline path: nothing replicates"',
  cutover: code`
$db = Get-DbName $Id
if ((Get-DbState -Id $Id -Side tgt) -eq 'ONLINE') { Set-AtkOutcome skipped "$db is already online on the target" -State 'cut-over'; return }
$file = "$(Get-DbUrl $Id)/$($db)_atk_full.bak"
Invoke-DbSql -Id $Id -Side src -What "back up $db to the URL (copy-only, compressed, checksum)" -Sql "BACKUP DATABASE $(ConvertTo-DbIdent $db) TO URL = $(ConvertTo-DbLit $file) WITH COPY_ONLY, COMPRESSION, CHECKSUM, FORMAT;"
$paths = @(Read-DbSql -Id $Id -Side tgt -Sql "SELECT CAST(SERVERPROPERTY('InstanceDefaultDataPath') AS nvarchar(512)) AS d, CAST(SERVERPROPERTY('InstanceDefaultLogPath') AS nvarchar(512)) AS l")[0]
$moves = @()
if (-not $DryRun) {
  foreach ($f in @(Read-DbSql -Id $Id -Side tgt -Sql "RESTORE FILELISTONLY FROM URL = $(ConvertTo-DbLit $file)")) {
    $dir = if ($f.Type -eq 'L') { [string] $paths.l } else { [string] $paths.d }
    $leaf = ([string] $f.PhysicalName) -split '[\\/]' | Select-Object -Last 1
    $moves += "MOVE $(ConvertTo-DbLit $f.LogicalName) TO $(ConvertTo-DbLit ($dir + $leaf))"
  }
}
$with = (@($moves) + @('CHECKSUM', 'RECOVERY')) -join ', '
Invoke-DbSql -Id $Id -Side tgt -What "restore $db from the URL and recover" -Sql "RESTORE DATABASE $(ConvertTo-DbIdent $db) FROM URL = $(ConvertTo-DbLit $file) WITH $with;"
Set-DbPhase -Id $Id -Phase 'cut-over'
Set-AtkOutcome succeeded "backed up to and restored from $(Get-DbUrl $Id)" -State 'cut-over'`,
  commit: 'Set-AtkOutcome skipped "nothing to commit on an offline path"',
  rollback: 'Set-AtkOutcome skipped "nothing to roll back: the source was only frozen and is unchanged; the target is kept for analysis"',
  finalize: code`
foreach ($side in 'src', 'tgt') {
  $name = Get-DbUrlCredentialName $Id
  if (@(Read-DbSql -Id $Id -Side $side -Sql "SELECT 1 AS x FROM sys.credentials WHERE name = $(ConvertTo-DbLit $name)").Count) {
    Invoke-DbSql -Id $Id -Side $side -What "drop the credential for $name" -Sql "DROP CREDENTIAL $(ConvertTo-DbIdent $name);"
  }
}
Complete-DbVerb -Detail 'the URL credentials are dropped (the backup file is kept; remove it with the storage lifecycle)'`,
}, true);

// ---------------------------------------------------------------------------
// sql-mi-link
// ---------------------------------------------------------------------------

const MI_FUNCS = code`
function Get-DbMiArgs { param([string] $Id) return @{ ResourceGroupName = (Get-DbNeed -Id $Id -Key 'resource_group'); InstanceName = (Get-DbNeed -Id $Id -Key 'instance') } }
function Get-DbLink {
  param([string] $Id)
  $a = Get-DbMiArgs $Id
  try { return Get-AzSqlInstanceLink @a -Name (Get-DbNeed -Id $Id -Key 'link') -ErrorAction Stop } catch { return $null }
}
function Get-DbEndpointUrl {
  param([string] $Id)
  $h = Get-DbNeed -Id $Id -Key 'src_host'
  if ($h.Contains(':') -and -not $h.StartsWith('[')) { $h = "[$h]" }
  return "TCP://$($h):$(Get-DbConf -Id $Id -Key 'endpoint_port')"
}
# Test-DbLinkCaughtUp: the Managed Instance has hardened everything the source hardened (the DAG's replicas).
function Test-DbLinkCaughtUp {
  param([string] $Id)
  $dag = Get-DbNeed -Id $Id -Key 'dag'
  $r = @(Read-DbSql -Id $Id -Side src -Sql "SELECT CASE WHEN r.last_hardened_lsn = l.last_hardened_lsn THEN 1 ELSE 0 END AS ok FROM sys.dm_hadr_database_replica_states l JOIN sys.dm_hadr_database_replica_states r ON r.database_id = l.database_id AND r.group_id = l.group_id AND r.is_local = 0 JOIN sys.availability_groups g ON g.group_id = l.group_id WHERE l.is_local = 1 AND g.name = $(ConvertTo-DbLit $dag)")
  return ($r.Count -gt 0 -and [int] $r[0].ok -eq 1)
}
function Test-DbPlanned { param([string] $Id) return (Get-DbConf -Id $Id -Key 'planned_failover') -eq '1' }
function Show-DbLinkStatus {
  param([string] $Id)
  $l = Get-DbLink $Id
  if (-not $l) { Set-AtkOutcome succeeded 'no link yet' -State 'planned' -Data @{ inSync = $false }; return }
  if ([string] $l.InstanceLinkRole -eq 'Primary') { Set-AtkOutcome succeeded 'the Managed Instance is the primary' -State 'cut-over'; return }
  if (Test-DbLinkCaughtUp $Id) { Set-AtkOutcome succeeded 'the Managed Instance has hardened every log block the source has' -State 'in-sync' -Data @{ inSync = $true }; return }
  Set-AtkOutcome succeeded "the link is $($l.LinkState)" -State 'replicating' -Data @{ inSync = $false }
}
`;

const MI_VERBS = withTestSkips({
  prepare: code`
Connect-DbAzure
$a = Get-DbMiArgs $Id
$mi = Get-AzSqlInstance -ResourceGroupName $a.ResourceGroupName -Name $a.InstanceName -ErrorAction SilentlyContinue
if (-not $mi) { Stop-Atk 5 "$($script:DbConf[$Id].name): the Managed Instance $($a.InstanceName) is not there yet: apply terraform first" }
Assert-DbHadr -Id $Id -Side src
$db = Get-DbName $Id
$ag = Get-DbNeed -Id $Id -Key 'ag'
$dag = Get-DbNeed -Id $Id -Key 'dag'
$rm = @(Read-DbSql -Id $Id -Side src -Sql "SELECT recovery_model_desc AS m FROM sys.databases WHERE name = $(ConvertTo-DbLit $db)")
if (-not $rm.Count -or $rm[0].m -ne 'FULL') { Stop-Atk 5 "$($script:DbConf[$Id].name): $db must use the FULL recovery model and have a full backup" }
if (-not @(Read-DbSql -Id $Id -Side src -Sql "SELECT 1 AS x FROM sys.symmetric_keys WHERE name = '##MS_DatabaseMasterKey##'").Count) {
  $mk = Get-AtkSecret -Name "MASTER_KEY_PASSWORD_$($script:DbConf[$Id].envtok)"
  Invoke-DbSql -Id $Id -Side src -What 'create the database master key' -Sql "CREATE MASTER KEY ENCRYPTION BY PASSWORD = $(ConvertTo-DbLit $mk);"
}
if (-not @(Read-DbSql -Id $Id -Side src -Sql "SELECT 1 AS x FROM sys.certificates WHERE name = N'atk_link_cert'").Count) {
  Invoke-DbSql -Id $Id -Side src -What 'create the endpoint certificate (two years)' -Sql "DECLARE @d nvarchar(10) = CONVERT(nvarchar(10), DATEADD(year, 2, GETUTCDATE()), 120); EXEC (N'CREATE CERTIFICATE atk_link_cert WITH SUBJECT = N''Managed Instance link'', EXPIRY_DATE = ''' + @d + N'''');"
}
if (-not @(Read-DbSql -Id $Id -Side src -Sql 'SELECT 1 AS x FROM sys.database_mirroring_endpoints').Count) {
  Invoke-DbSql -Id $Id -Side src -What "create the DATABASE_MIRRORING endpoint on $(Get-DbConf -Id $Id -Key 'endpoint_port')" -Sql "CREATE ENDPOINT atk_hadr STATE = STARTED AS TCP (LISTENER_PORT = $(Get-DbConf -Id $Id -Key 'endpoint_port'), LISTENER_IP = ALL) FOR DATABASE_MIRRORING (ROLE = ALL, AUTHENTICATION = WINDOWS CERTIFICATE atk_link_cert, ENCRYPTION = REQUIRED ALGORITHM AES);"
}
$srcName = Get-DbServerName -Id $Id -Side src
$trust = @(Get-AzSqlInstanceServerTrustCertificate @a -ErrorAction SilentlyContinue | Where-Object { $_.CertificateName -eq "atk-$($srcName.ToLowerInvariant())" })
if (-not $trust.Count) {
  $pk = '0x' + [Convert]::ToHexString([byte[]] @(Read-DbSql -Id $Id -Side src -Sql "SELECT CERTENCODED(CERT_ID(N'atk_link_cert')) AS k")[0].k)
  $script:DbChanged = $true; Invoke-AtkStep 'trust the source certificate on the Managed Instance' { New-AzSqlInstanceServerTrustCertificate @a -Name "atk-$($srcName.ToLowerInvariant())" -PublicKey $pk | Out-Null }
}
$miCert = "atk_mi_$($a.InstanceName)".Replace('-', '_')
if (-not @(Read-DbSql -Id $Id -Side src -Sql "SELECT 1 AS x FROM sys.certificates WHERE name = $(ConvertTo-DbLit $miCert)").Count) {
  $ep = Get-AzSqlInstanceEndpointCertificate @a -EndpointType 'DATABASE_MIRRORING'
  Invoke-DbSql -Id $Id -Side src -What 'trust the Managed Instance endpoint certificate on the source' -Sql "CREATE CERTIFICATE $(ConvertTo-DbIdent $miCert) FROM BINARY = $($ep.PublicKey); CREATE LOGIN $(ConvertTo-DbIdent ($miCert + '_login')) FROM CERTIFICATE $(ConvertTo-DbIdent $miCert); GRANT CONNECT ON ENDPOINT::atk_hadr TO $(ConvertTo-DbIdent ($miCert + '_login'));"
}
if (-not @(Read-DbSql -Id $Id -Side src -Sql "SELECT 1 AS x FROM sys.availability_groups WHERE name = $(ConvertTo-DbLit $ag)").Count) {
  Invoke-DbSql -Id $Id -Side src -What "create the source availability group $ag (CLUSTER_TYPE = NONE)" -Sql "CREATE AVAILABILITY GROUP $(ConvertTo-DbIdent $ag) WITH (CLUSTER_TYPE = NONE) FOR DATABASE $(ConvertTo-DbIdent $db) REPLICA ON $(ConvertTo-DbLit $srcName) WITH (ENDPOINT_URL = $(ConvertTo-DbLit (Get-DbEndpointUrl $Id)), FAILOVER_MODE = MANUAL, AVAILABILITY_MODE = SYNCHRONOUS_COMMIT, SEEDING_MODE = AUTOMATIC, SECONDARY_ROLE (ALLOW_CONNECTIONS = ALL));"
}
if (-not @(Read-DbSql -Id $Id -Side src -Sql "SELECT 1 AS x FROM sys.availability_groups WHERE name = $(ConvertTo-DbLit $dag)").Count) {
  $miFqdn = Get-DbNeed -Id $Id -Key 'tgt_host'
  Invoke-DbSql -Id $Id -Side src -What "create the distributed availability group $dag to the Managed Instance" -Sql "CREATE AVAILABILITY GROUP $(ConvertTo-DbIdent $dag) WITH (DISTRIBUTED) AVAILABILITY GROUP ON $(ConvertTo-DbLit $ag) WITH (LISTENER_URL = $(ConvertTo-DbLit (Get-DbEndpointUrl $Id)), AVAILABILITY_MODE = ASYNCHRONOUS_COMMIT, FAILOVER_MODE = MANUAL, SEEDING_MODE = AUTOMATIC), $(ConvertTo-DbLit (Get-DbNeed -Id $Id -Key 'mi_ag')) WITH (LISTENER_URL = $(ConvertTo-DbLit ('tcp://' + $miFqdn + ':5022;Server=[' + $a.InstanceName + ']')), AVAILABILITY_MODE = ASYNCHRONOUS_COMMIT, FAILOVER_MODE = MANUAL, SEEDING_MODE = AUTOMATIC);"
}
Complete-DbVerb -State 'prepared' -Detail 'certificates traded, the endpoint, the source AG and the distributed AG are in place (import the Microsoft PKI roots per the runbook)'`,
  replicate: code`
Connect-DbAzure
$a = Get-DbMiArgs $Id
if (-not (Get-DbLink $Id)) {
  $script:DbChanged = $true; Invoke-AtkStep 'create the Managed Instance link (automatic seeding, manual failover)' {
    New-AzSqlInstanceLink @a -Name (Get-DbNeed -Id $Id -Key 'link') -PartnerAvailabilityGroupName (Get-DbNeed -Id $Id -Key 'ag') -InstanceAvailabilityGroupName (Get-DbNeed -Id $Id -Key 'mi_ag') -Database (Get-DbName $Id) -PartnerEndpoint (Get-DbEndpointUrl $Id) -SeedingMode Automatic -FailoverMode Manual | Out-Null
  }
}
$null = Wait-AtkUntil -Minutes 240 -IntervalSeconds 60 { Test-DbLinkCaughtUp $Id }
Show-DbLinkStatus -Id $Id`,
  status: 'Connect-DbAzure\nShow-DbLinkStatus -Id $Id',
  cutover: code`
Connect-DbAzure
$a = Get-DbMiArgs $Id
$l = Get-DbLink $Id
if (-not $l) { Set-AtkOutcome failed 'no link: run replicate first'; return }
if ([string] $l.InstanceLinkRole -eq 'Primary') { Set-AtkOutcome skipped 'the Managed Instance is already the primary' -State 'cut-over'; return }
$ok = Wait-AtkUntil -Minutes 30 -IntervalSeconds 10 { Test-DbLinkCaughtUp $Id }
if (-not $ok) { Set-AtkOutcome failed 'the Managed Instance has not hardened the last log block after the freeze; nothing was switched'; return }
if (Test-DbPlanned $Id) {
  $script:DbChanged = $true; Invoke-AtkStep 'planned failover to the Managed Instance (the link stays, reversed)' { Start-AzSqlInstanceLinkFailover @a -Name (Get-DbNeed -Id $Id -Key 'link') -FailoverType Planned | Out-Null }
  Set-DbPhase -Id $Id -Phase 'cut-over'
  Set-AtkOutcome succeeded 'planned failover: the Managed Instance is the primary and SQL Server replicates from it (the way back)' -State 'cut-over' -Data @{ reverse = $true }
} else {
  $script:DbChanged = $true; Invoke-AtkStep 'failover to the Managed Instance (forced, after the last hardened LSN matched)' { Start-AzSqlInstanceLinkFailover @a -Name (Get-DbNeed -Id $Id -Key 'link') -FailoverType ForcedAllowDataLoss | Out-Null }
  Set-DbPhase -Id $Id -Phase 'cut-over'
  Set-AtkOutcome succeeded 'failed over (SQL Server before 2022: no reverse replication)' -State 'cut-over' -Data @{ reverse = $false }
}`,
  commit: 'Set-AtkOutcome skipped "nothing to commit: the link stays until finalize"',
  rollback: code`
Connect-DbAzure
$l = Get-DbLink $Id
if (-not $l -or [string] $l.InstanceLinkRole -ne 'Primary') { Set-AtkOutcome skipped 'nothing to roll back: SQL Server is still the primary'; return }
if (-not (Test-DbPlanned $Id)) {
  Set-DbPhase -Id $Id -Phase 'rolled-back'
  Set-AtkOutcome succeeded "SQL Server before 2022 has no way back over the link: the source is as it was at the failover, and the Managed Instance's writes since are not carried back"
  return
}
$dag = Get-DbNeed -Id $Id -Key 'dag'
$ag = Get-DbNeed -Id $Id -Key 'ag'
$miAg = Get-DbNeed -Id $Id -Key 'mi_ag'
Invoke-DbSql -Id $Id -Side tgt -What 'switch the link to synchronous commit' -Sql "ALTER AVAILABILITY GROUP $(ConvertTo-DbIdent $dag) MODIFY AVAILABILITY GROUP ON $(ConvertTo-DbLit $ag) WITH (AVAILABILITY_MODE = SYNCHRONOUS_COMMIT), $(ConvertTo-DbLit $miAg) WITH (AVAILABILITY_MODE = SYNCHRONOUS_COMMIT);"
$ok = Wait-AtkUntil -Minutes 30 -IntervalSeconds 10 { Test-DbLinkCaughtUp $Id }
if (-not $ok) { Set-AtkOutcome failed 'SQL Server has not caught up with the Managed Instance; nothing was switched back'; return }
Invoke-DbSql -Id $Id -Side tgt -What 'make the Managed Instance secondary' -Sql "ALTER AVAILABILITY GROUP $(ConvertTo-DbIdent $dag) SET (ROLE = SECONDARY);"
Invoke-DbSql -Id $Id -Side src -What 'make SQL Server primary' -Sql "ALTER AVAILABILITY GROUP $(ConvertTo-DbIdent $dag) FORCE_FAILOVER_ALLOW_DATA_LOSS;"
Set-DbPhase -Id $Id -Phase 'rolled-back'
Set-AtkOutcome succeeded 'failed back to SQL Server with no data loss (the link is kept): switch the applications back'`,
  finalize: code`
Connect-DbAzure
$a = Get-DbMiArgs $Id
if (Get-DbLink $Id) { $script:DbChanged = $true; Invoke-AtkStep 'remove the Managed Instance link' { Remove-AzSqlInstanceLink @a -Name (Get-DbNeed -Id $Id -Key 'link') -Force | Out-Null } }
foreach ($g in (Get-DbNeed -Id $Id -Key 'dag'), (Get-DbNeed -Id $Id -Key 'ag')) {
  if (@(Read-DbSql -Id $Id -Side src -Sql "SELECT 1 AS x FROM sys.availability_groups WHERE name = $(ConvertTo-DbLit $g)").Count) {
    Invoke-DbSql -Id $Id -Side src -What "drop the availability group $g on the source" -Sql "DROP AVAILABILITY GROUP $(ConvertTo-DbIdent $g);"
  }
}
Complete-DbVerb -Detail 'the link and the source availability groups are removed (the certificates and the endpoint stay until decommission)'`,
}, true);

// ---------------------------------------------------------------------------
// sql-mi-lrs
// ---------------------------------------------------------------------------

const LRS_FUNCS = code`
function Get-DbMiArgs { param([string] $Id) return @{ ResourceGroupName = (Get-DbNeed -Id $Id -Key 'resource_group'); InstanceName = (Get-DbNeed -Id $Id -Key 'instance') } }
function Get-DbContainer { param([string] $Id) return (Get-DbNeed -Id $Id -Key 'container_uri').TrimEnd('/') }
function Get-DbFolder { param([string] $Id) return "$(Get-DbContainer $Id)/$(Get-DbName $Id)" }
function Get-DbLrs {
  param([string] $Id)
  $a = Get-DbMiArgs $Id
  try { return Get-AzSqlInstanceDatabaseLogReplay @a -Name (Get-DbName $Id) -ErrorAction Stop } catch { return $null }
}
function Get-DbLastBackup {
  param([string] $Id)
  $r = @(Read-DbSql -Id $Id -Side src -Database 'msdb' -Sql "SELECT TOP (1) f.physical_device_name AS p FROM dbo.backupset b JOIN dbo.backupmediafamily f ON f.media_set_id = b.media_set_id WHERE b.database_name = $(ConvertTo-DbLit (Get-DbName $Id)) AND f.physical_device_name LIKE $(ConvertTo-DbLit ((Get-DbFolder $Id) + '/%')) ORDER BY b.backup_finish_date DESC")
  if ($r.Count) { return ([string] $r[0].p).Split('/')[-1] } else { return '' }
}
function Test-DbLrsCaughtUp {
  param([string] $Id)
  $l = Get-DbLrs $Id
  return ($l -and [string] $l.LastRestoredFileName -eq (Get-DbLastBackup $Id))
}
function Add-DbLrsCredential {
  param([string] $Id)
  $name = Get-DbContainer $Id
  if (@(Read-DbSql -Id $Id -Side src -Sql "SELECT 1 AS x FROM sys.credentials WHERE name = $(ConvertTo-DbLit $name)").Count) { return }
  $sas = (Get-AtkSecret -Name 'MI_LRS_SAS').TrimStart('?')
  $conn = Connect-DbSide -Id $Id -Side src
  $script:DbChanged = $true; Invoke-AtkStep 'create the SAS credential for the backup container on the source' {
    New-DbaCredential -SqlInstance $conn -Name $name -Identity 'SHARED ACCESS SIGNATURE' -SecurePassword (ConvertTo-SecureString -String $sas -AsPlainText -Force) -EnableException | Out-Null
  }
}
function Show-DbLrsStatus {
  param([string] $Id)
  $l = Get-DbLrs $Id
  if (-not $l) { Set-AtkOutcome succeeded 'no log replay yet' -State 'planned' -Data @{ inSync = $false }; return }
  if (Test-DbLrsCaughtUp $Id) { Set-AtkOutcome succeeded "the Managed Instance restored $($l.LastRestoredFileName), the last backup" -State 'in-sync' -Data @{ inSync = $true }; return }
  Set-AtkOutcome succeeded "log replay is $($l.Status), last restored $($l.LastRestoredFileName)" -State 'replicating' -Data @{ inSync = $false }
}
`;

const LRS_VERBS = withTestSkips({
  prepare: code`
Connect-DbAzure
$a = Get-DbMiArgs $Id
if (-not (Get-AzSqlInstance -ResourceGroupName $a.ResourceGroupName -Name $a.InstanceName -ErrorAction SilentlyContinue)) { Stop-Atk 5 "$($script:DbConf[$Id].name): the Managed Instance is not there yet: apply terraform first" }
Add-DbLrsCredential -Id $Id
$db = Get-DbName $Id
if (-not (Get-DbLastBackup $Id)) {
  Invoke-DbSql -Id $Id -Side src -What 'full backup to the container (copy-only, checksum)' -Sql "BACKUP DATABASE $(ConvertTo-DbIdent $db) TO URL = $(ConvertTo-DbLit ((Get-DbFolder $Id) + '/' + $db + '_full.bak')) WITH COPY_ONLY, CHECKSUM, COMPRESSION, FORMAT;"
}
Complete-DbVerb -State 'prepared' -Detail "the credential and a full backup are in $(Get-DbFolder $Id)"`,
  replicate: code`
Connect-DbAzure
$a = Get-DbMiArgs $Id
$db = Get-DbName $Id
if (-not (Get-DbLrs $Id)) {
  $script:DbChanged = $true; Invoke-AtkStep 'start Log Replay Service (the Managed Instance reads the container with its managed identity)' {
    Start-AzSqlInstanceDatabaseLogReplay @a -Name $db -StorageContainerUri (Get-DbFolder $Id) -StorageContainerIdentity ManagedIdentity | Out-Null
  }
}
if ((Get-DbState -Id $Id -Side src) -eq 'ONLINE') {
  Invoke-DbSql -Id $Id -Side src -What 'log backup to the container' -Sql "BACKUP LOG $(ConvertTo-DbIdent $db) TO URL = $(ConvertTo-DbLit ((Get-DbFolder $Id) + '/' + $db + '_log_' + (Get-DbStamp) + '.trn')) WITH CHECKSUM, COMPRESSION;"
}
$null = Wait-AtkUntil -Minutes 120 -IntervalSeconds 60 { Test-DbLrsCaughtUp $Id }
Show-DbLrsStatus -Id $Id`,
  status: 'Connect-DbAzure\nShow-DbLrsStatus -Id $Id',
  cutover: code`
Connect-DbAzure
$a = Get-DbMiArgs $Id
$db = Get-DbName $Id
if ((Get-DbPhase $Id) -eq 'cut-over') { Set-AtkOutcome skipped 'already cut over' -State 'cut-over'; return }
if (-not (Get-DbLrs $Id)) { Set-AtkOutcome failed 'no log replay: run replicate first'; return }
$tail = "$($db)_tail.trn"
if ((Get-DbState -Id $Id -Side src) -eq 'ONLINE') {
  Invoke-DbSql -Id $Id -Side src -What 'tail-log backup WITH NORECOVERY' -Sql "BACKUP LOG $(ConvertTo-DbIdent $db) TO URL = $(ConvertTo-DbLit ((Get-DbFolder $Id) + '/' + $tail)) WITH NORECOVERY, CHECKSUM, COMPRESSION;"
}
$ok = Wait-AtkUntil -Minutes 60 -IntervalSeconds 30 { [string] (Get-DbLrs $Id).LastRestoredFileName -eq $tail }
if (-not $ok) { Set-AtkOutcome failed "the Managed Instance did not restore $tail in time"; return }
$script:DbChanged = $true; Invoke-AtkStep 'complete the log replay (the database comes online on the Managed Instance)' { Complete-AzSqlInstanceDatabaseLogReplay @a -Name $db -LastBackupName $tail | Out-Null }
Set-DbPhase -Id $Id -Phase 'cut-over'
Set-AtkOutcome succeeded "restored through $tail and completed" -State 'cut-over' -Data @{ reverse = $false }`,
  commit: 'Set-AtkOutcome skipped "nothing to commit: Log Replay Service has no reverse"',
  rollback: code`
Connect-DbAzure
$a = Get-DbMiArgs $Id
$db = Get-DbName $Id
$done = $false
if ((Get-DbPhase $Id) -ne 'cut-over' -and (Get-DbLrs $Id)) {
  $script:DbChanged = $true; Invoke-AtkStep 'stop the log replay (the restoring copy on the Managed Instance is dropped)' { Stop-AzSqlInstanceDatabaseLogReplay @a -Name $db -Force | Out-Null }
  $done = $true
}
if ((Get-DbState -Id $Id -Side src) -eq 'RESTORING') {
  Invoke-DbSql -Id $Id -Side src -What 'recover the source' -Sql "RESTORE DATABASE $(ConvertTo-DbIdent $db) WITH RECOVERY;"
  $done = $true
}
if (-not $done) { Set-AtkOutcome skipped 'nothing to roll back: the source was not changed'; return }
Set-DbPhase -Id $Id -Phase 'rolled-back'
Set-AtkOutcome succeeded "the source is online as of the tail-log backup; writes on the Managed Instance since cutover are not carried back"`,
  finalize: code`
$name = Get-DbContainer $Id
if (@(Read-DbSql -Id $Id -Side src -Sql "SELECT 1 AS x FROM sys.credentials WHERE name = $(ConvertTo-DbLit $name)").Count) {
  Invoke-DbSql -Id $Id -Side src -What 'drop the container credential' -Sql "DROP CREDENTIAL $(ConvertTo-DbIdent $name);"
}
Complete-DbVerb -Detail 'the container credential is dropped (remove the backups with the storage lifecycle)'`,
}, true);

// ---------------------------------------------------------------------------
// sql-rds-native
// ---------------------------------------------------------------------------

const RDS_FUNCS = code`
function Get-DbS3Arn { param([string] $Id, [string] $File) return "arn:$(Get-DbConf -Id $Id -Key 's3_partition'):s3:::$(Get-DbNeed -Id $Id -Key 's3_bucket')/$(Get-DbConf -Id $Id -Key 's3_prefix')/$File" }
function Get-DbS3Uri { param([string] $Id, [string] $File) return "s3://$(Get-DbNeed -Id $Id -Key 's3_bucket')/$(Get-DbConf -Id $Id -Key 's3_prefix')/$File" }
# Get-DbRdsTask: the last restore task of the database (rds_task_status).
function Get-DbRdsTask {
  param([string] $Id)
  $r = @(Read-DbSql -Id $Id -Side tgt -Database 'msdb' -Sql "EXEC dbo.rds_task_status @db_name = $(ConvertTo-DbLit (Get-DbName $Id))")
  if ($r.Count) { return ($r | Sort-Object -Property task_id | Select-Object -Last 1) } else { return $null }
}
function Test-DbRdsIdle { param([string] $Id) $t = Get-DbRdsTask $Id; return (-not $t -or [string] $t.lifecycle -in @('SUCCESS', 'ERROR', 'CANCELLED')) }
function Wait-DbRdsTask {
  param([string] $Id, [string] $What)
  if (-not (Wait-AtkUntil -Minutes 240 -IntervalSeconds 30 { Test-DbRdsIdle $Id })) { Stop-Atk 1 "$($script:DbConf[$Id].name): $What did not finish in time" }
  $t = Get-DbRdsTask $Id
  if ($t -and [string] $t.lifecycle -ne 'SUCCESS' -and -not $DryRun) { Stop-Atk 1 "$($script:DbConf[$Id].name): $What ended $($t.lifecycle): $($t.task_info)" }
}
# Send-DbBackup KIND NORECOVERY: a backup on the source to the share, copied to S3, restored on RDS with NORECOVERY.
function Send-DbBackup {
  param([string] $Id, [ValidateSet('Full', 'Log')] [string] $Kind)
  $db = Get-DbName $Id
  $file = "$(Get-DbConf -Id $Id -Key 'resource')_$($Kind.ToLowerInvariant())_$(Get-DbStamp).$(if ($Kind -eq 'Full') { 'bak' } else { 'trn' })"
  $share = (Get-DbNeed -Id $Id -Key 'backup_share').TrimEnd('\', '/')
  $local = Join-Path (Get-DbNeed -Id $Id -Key 'backup_local') $file
  $src = Connect-DbSide -Id $Id -Side src
  $script:DbChanged = $true; Invoke-AtkStep "$Kind backup of $db to the share" { Backup-DbaDatabase -SqlInstance $src -Database $db -Type $Kind -Path $share -FilePath $file -CompressBackup -Checksum -EnableException | Out-Null }
  $script:DbChanged = $true; Invoke-AtkStep "copy $file to S3" { & aws s3 cp $local (Get-DbS3Uri -Id $Id -File $file) --only-show-errors; if ($LASTEXITCODE) { throw "aws s3 cp failed ($LASTEXITCODE)" } }
  if ($Kind -eq 'Full') {
    Invoke-DbSql -Id $Id -Side tgt -Database 'msdb' -What 'restore the full backup on RDS WITH NORECOVERY' -Sql "EXEC dbo.rds_restore_database @restore_db_name = $(ConvertTo-DbLit $db), @s3_arn_to_restore_from = $(ConvertTo-DbLit (Get-DbS3Arn -Id $Id -File $file)), @with_norecovery = 1, @type = 'FULL';"
  } else {
    Invoke-DbSql -Id $Id -Side tgt -Database 'msdb' -What 'restore the log backup on RDS WITH NORECOVERY' -Sql "EXEC dbo.rds_restore_log @restore_db_name = $(ConvertTo-DbLit $db), @s3_arn_to_restore_from = $(ConvertTo-DbLit (Get-DbS3Arn -Id $Id -File $file)), @with_norecovery = 1;"
  }
  Wait-DbRdsTask -Id $Id -What "the restore of $file"
  Set-AtkId -Path 'sql-rds-native' -Key "$Id.last" -Value $file
}
function Show-DbRdsStatus {
  param([string] $Id)
  $last = Get-AtkId -Path 'sql-rds-native' -Key "$Id.last"
  if (-not $last) { Set-AtkOutcome succeeded 'nothing restored yet' -State 'planned' -Data @{ inSync = $false }; return }
  $t = Get-DbRdsTask $Id
  if ($t -and [string] $t.lifecycle -eq 'SUCCESS') { Set-AtkOutcome succeeded "RDS restored $last (the log chain is current to that backup)" -State 'in-sync' -Data @{ inSync = $true }; return }
  Set-AtkOutcome succeeded "the last RDS task is $(if ($t) { $t.lifecycle } else { 'unknown' })" -State 'replicating' -Data @{ inSync = $false }
}
`;

const RDS_VERBS = withTestSkips({
  prepare: code`
$inst = Get-DbNeed -Id $Id -Key 'rds_instance'
$groups = @(& aws rds describe-db-instances --db-instance-identifier $inst --query 'DBInstances[0].OptionGroupMemberships[].OptionGroupName' --output text) -split '\s+' | Where-Object { $_ }
$has = $false
foreach ($g in $groups) { if ((& aws rds describe-option-groups --option-group-name $g --query "OptionGroupsList[0].Options[?OptionName=='SQLSERVER_BACKUP_RESTORE'].OptionName" --output text) -match 'SQLSERVER_BACKUP_RESTORE') { $has = $true } }
if (-not $has) { Stop-Atk 5 "$($script:DbConf[$Id].name): the RDS instance $inst has no option group with SQLSERVER_BACKUP_RESTORE: apply terraform (aws_mig_databases)" }
if (-not (Test-Path -LiteralPath (Get-DbNeed -Id $Id -Key 'backup_local') -PathType Container)) { Stop-Atk 5 "$($script:DbConf[$Id].name): the backup share is not mounted on the controller at $(Get-DbConf -Id $Id -Key 'backup_local')" }
Set-AtkOutcome skipped "the option group and the backup share are in place" -State 'prepared'`,
  replicate: code`
if ((Get-DbPhase $Id) -eq 'cut-over') { Set-AtkOutcome skipped 'already cut over' -State 'cut-over'; return }
if (-not (Get-AtkId -Path 'sql-rds-native' -Key "$Id.last")) { Send-DbBackup -Id $Id -Kind Full }
Send-DbBackup -Id $Id -Kind Log
Show-DbRdsStatus -Id $Id`,
  status: 'Show-DbRdsStatus -Id $Id',
  cutover: code`
if ((Get-DbPhase $Id) -eq 'cut-over') { Set-AtkOutcome skipped 'already cut over' -State 'cut-over'; return }
if (-not (Get-AtkId -Path 'sql-rds-native' -Key "$Id.last")) { Set-AtkOutcome failed 'no full backup restored: run replicate first'; return }
Send-DbBackup -Id $Id -Kind Log
Invoke-DbSql -Id $Id -Side tgt -Database 'msdb' -What 'finish the restore (the database comes online on RDS)' -Sql "EXEC dbo.rds_finish_restore @db_name = $(ConvertTo-DbLit (Get-DbName $Id));"
Wait-DbRdsTask -Id $Id -What 'rds_finish_restore'
Set-DbPhase -Id $Id -Phase 'cut-over'
Set-AtkOutcome succeeded 'the last log (after the freeze) is restored and the database is online on RDS' -State 'cut-over' -Data @{ reverse = $false }`,
  commit: 'Set-AtkOutcome skipped "nothing to commit: RDS native restore has no reverse"',
  rollback: 'Set-AtkOutcome skipped "nothing to roll back: the source was only frozen and stays online (its log backups ran WITH RECOVERY); the RDS copy is kept for analysis"',
  finalize: code`
$prefix = "s3://$(Get-DbNeed -Id $Id -Key 's3_bucket')/$(Get-DbConf -Id $Id -Key 's3_prefix')/"
$script:DbChanged = $true; Invoke-AtkStep "remove the backups from $prefix" { & aws s3 rm $prefix --recursive --only-show-errors; if ($LASTEXITCODE) { throw "aws s3 rm failed ($LASTEXITCODE)" } }
$files = @(Get-ChildItem -LiteralPath (Get-DbNeed -Id $Id -Key 'backup_local') -Filter "$(Get-DbConf -Id $Id -Key 'resource')_*" -File -ErrorAction SilentlyContinue)
if ($files.Count) { $script:DbChanged = $true; Invoke-AtkStep "remove $($files.Count) backup file(s) from the share" { $files | Remove-Item -Force } }
Complete-DbVerb -Detail 'the backups are removed from S3 and the share'`,
}, true);

// ---------------------------------------------------------------------------
// azure-dms
// ---------------------------------------------------------------------------

const ADMS_FUNCS = code`
function Get-DbDmsArgs { param([string] $Id) return @{ ResourceGroupName = (Get-DbNeed -Id $Id -Key 'resource_group'); SqlMigrationServiceName = (Get-DbNeed -Id $Id -Key 'dms_name') } }
function Get-DbSqlDbMigration {
  param([string] $Id)
  try { return Get-AzDataMigrationToSqlDb -ResourceGroupName (Get-DbNeed -Id $Id -Key 'resource_group') -SqlDbInstanceName (Get-DbNeed -Id $Id -Key 'server') -TargetDbName (Get-DbNeed -Id $Id -Key 'target_db') -ErrorAction Stop } catch { return $null }
}
function Get-DbMigrationStatus { param([string] $Id) $m = Get-DbSqlDbMigration $Id; if ($m) { return [string] $m.MigrationStatus } else { return '' } }
`;

const ADMS_VERBS = withTestSkips({
  prepare: code`
Connect-DbAzure
$d = Get-DbDmsArgs $Id
$svc = Get-AzDataMigrationSqlService -ResourceGroupName $d.ResourceGroupName -Name $d.SqlMigrationServiceName -ErrorAction SilentlyContinue
if (-not $svc) {
  $script:DbChanged = $true; Invoke-AtkStep "create the Database Migration Service $($d.SqlMigrationServiceName)" { New-AzDataMigrationSqlService -ResourceGroupName $d.ResourceGroupName -Name $d.SqlMigrationServiceName -Location (Get-DbNeed -Id $Id -Key 'region') | Out-Null }
}
$nodes = @()
if (-not $DryRun) { $nodes = @((Get-AzDataMigrationSqlServiceIntegrationRuntimeMetric @d).Node | Where-Object { $_.Status -eq 'Online' }) }
if (-not $nodes.Count -and -not $DryRun) {
  if (-not $env:ATK_DMS_IR_HOST) { Stop-Atk 5 "no self-hosted integration runtime is online for $($d.SqlMigrationServiceName): install it on a Windows host and register it (set ATK_DMS_IR_HOST to let the kit register it over PowerShell remoting)" }
  $key = (Get-AzDataMigrationSqlServiceAuthKey @d).AuthKey1
  $script:DbChanged = $true; Invoke-AtkStep "register the integration runtime on $env:ATK_DMS_IR_HOST (the key goes over the remoting session)" {
    Invoke-Command -HostName $env:ATK_DMS_IR_HOST -ScriptBlock { param($k) Register-AzDataMigrationIntegrationRuntime -AuthKey $k } -ArgumentList $key | Out-Null
  }
}
$tables = @(Read-DbSql -Id $Id -Side tgt -Database (Get-DbNeed -Id $Id -Key 'target_db') -Sql 'SELECT COUNT(*) AS n FROM sys.tables WHERE is_ms_shipped = 0')
if (-not $tables.Count -or [int] $tables[0].n -eq 0) { Stop-Atk 5 "$($script:DbConf[$Id].name): create the schema in the Azure SQL database first (runbook: SqlPackage or the migration service's schema step); the offline copy moves the rows" }
Complete-DbVerb -State 'prepared' -Detail 'the migration service, an online integration runtime and the target schema are in place'`,
  replicate: 'Set-AtkOutcome skipped "an offline path: the copy runs at cutover, after the freeze"',
  status: code`
Connect-DbAzure
$s = Get-DbMigrationStatus $Id
if (-not $s) { Set-AtkOutcome skipped 'no migration yet (it runs at cutover)'; return }
Set-AtkOutcome succeeded "the offline migration is $s" -State $(if ($s -eq 'Succeeded') { 'cut-over' } else { 'cutting-over' })`,
  cutover: code`
Connect-DbAzure
$s = Get-DbMigrationStatus $Id
if ($s -eq 'Succeeded') { Set-AtkOutcome skipped 'the offline migration already succeeded' -State 'cut-over'; return }
if ($s -notin @('InProgress', 'Creating')) {
  $rg = Get-DbNeed -Id $Id -Key 'resource_group'
  $server = Get-DbNeed -Id $Id -Key 'server'
  $d = Get-DbDmsArgs $Id
  $scope = (Get-AzSqlServer -ResourceGroupName $rg -ServerName $server).ResourceId
  $service = (Get-AzDataMigrationSqlService -ResourceGroupName $d.ResourceGroupName -Name $d.SqlMigrationServiceName).Id
  $sc = Get-DbCredential -Id $Id -Role SRC
  $tc = Get-DbCredential -Id $Id -Role TGT
  $script:DbChanged = $true; Invoke-AtkStep 'start the offline migration to Azure SQL Database' {
    New-AzDataMigrationToSqlDb -ResourceGroupName $rg -SqlDbInstanceName $server -Kind 'SqlDb' -TargetDbName (Get-DbNeed -Id $Id -Key 'target_db') -Scope $scope -MigrationService $service -SourceDatabaseName (Get-DbName $Id) -SourceSqlConnectionAuthentication 'SqlAuthentication' -SourceSqlConnectionDataSource (Get-DbInstance -Id $Id -Side src) -SourceSqlConnectionUserName $sc.UserName -SourceSqlConnectionPassword $sc.Password -TargetSqlConnectionAuthentication 'SqlAuthentication' -TargetSqlConnectionDataSource (Get-DbNeed -Id $Id -Key 'tgt_host') -TargetSqlConnectionUserName $tc.UserName -TargetSqlConnectionPassword $tc.Password | Out-Null
  }
}
$ok = Wait-AtkUntil -Minutes 720 -IntervalSeconds 60 { (Get-DbMigrationStatus $Id) -in @('Succeeded', 'Failed', 'Canceled') }
$s = Get-DbMigrationStatus $Id
if (-not $DryRun -and $s -ne 'Succeeded') { Set-AtkOutcome failed "the offline migration is $(if ($s) { $s } else { 'not finished' })"; return }
Set-DbPhase -Id $Id -Phase 'cut-over'
Set-AtkOutcome succeeded 'the rows are copied to Azure SQL Database' -State 'cut-over' -Data @{ reverse = $false }`,
  commit: 'Set-AtkOutcome skipped "nothing to commit on an offline path"',
  rollback: code`
Connect-DbAzure
$m = Get-DbSqlDbMigration $Id
if ($m -and [string] $m.MigrationStatus -eq 'InProgress') {
  $script:DbChanged = $true; Invoke-AtkStep 'stop the offline migration' { Stop-AzDataMigrationToSqlDb -ResourceGroupName (Get-DbNeed -Id $Id -Key 'resource_group') -SqlDbInstanceName (Get-DbNeed -Id $Id -Key 'server') -TargetDbName (Get-DbNeed -Id $Id -Key 'target_db') -MigrationOperationId $m.MigrationOperationId | Out-Null }
  Set-AtkOutcome succeeded 'the offline migration is stopped; the source was only frozen and is unchanged'
  return
}
Set-AtkOutcome skipped 'nothing to roll back: the source was only frozen and is unchanged; the target is kept for analysis'`,
  finalize: 'Set-AtkOutcome skipped "the Database Migration Service is shared by the wave\'s databases: remove it (Remove-AzDataMigrationSqlService) once the last one is accepted"',
}, true);

// ---------------------------------------------------------------------------
// Settings and the generator
// ---------------------------------------------------------------------------

                   
                           
                                      
                                        
                             
                                       
                                          
                                      
                                     
                                                                                
 

const COMMON_SQL                       = [{ key: 'trust_server_certificate', help: '1: trust the SQL Server certificate (no CA chain on the controller); 0: validate it' }];
const plan8 = (ctx             )         => ctx.manifest.planId8;

const SPECS                                    = {
  'sql-ag-seeding': {
    summary: 'SQL Server availability group with automatic seeding onto the rebuilt target; failover at cutover, back at rollback.',
    modules: ['dbatools'], functions: AG_FUNCS, verbs: AG_VERBS,
    settings: [...COMMON_SQL, { key: 'ag', help: 'the source availability group (empty: found from the database)' }, { key: 'kit_ag', help: 'the read-scale AG (CLUSTER_TYPE = NONE) the kit creates when the source has none' }],
    secrets: ['SRC_DB_PASSWORD_<TOKEN>', 'TGT_DB_PASSWORD_<TOKEN>'],
    notes: ['Always On must be enabled on both servers (a restart: runbook), and the endpoints must trust each other (domain accounts or certificates).'],
    extra: (i) => ({ ag: '', kit_ag: `atk_${i.resource.replace(/-/g, '_')}`.slice(0, 128) }),
  },
  'sql-log-shipping': {
    summary: 'SQL Server log shipping; at cutover the tail-log backup WITH NORECOVERY, recovery, and reverse log shipping back to the source.',
    modules: ['dbatools'], functions: LS_FUNCS, verbs: LS_VERBS,
    settings: [...COMMON_SQL, { key: 'shared_path', help: 'the UNC share both servers read and write for the log backups', required: true }, { key: 'shared_path_reverse', help: 'the share for the reverse direction (default: <shared_path>\\atk-reverse)' }, { key: 'reverse', help: '1: reverse log shipping at cutover; 0: none' }],
    secrets: ['SRC_DB_PASSWORD_<TOKEN>', 'TGT_DB_PASSWORD_<TOKEN>'],
    extra: () => ({ shared_path: '', shared_path_reverse: '', reverse: '1' }),
  },
  'sql-backup-url': {
    summary: 'SQL Server BACKUP TO URL (Azure Blob, or s3:// from SQL Server 2022) and RESTORE FROM URL at cutover (offline).',
    modules: ['dbatools'], functions: URL_FUNCS, verbs: URL_VERBS,
    settings: [...COMMON_SQL, { key: 'backup_url', help: 'the container URL (https://<account>.blob.core.windows.net/<container>) or s3://<host>/<bucket>', required: true }],
    secrets: ['SRC_DB_PASSWORD_<TOKEN>', 'TGT_DB_PASSWORD_<TOKEN>', 'BACKUP_URL_SECRET_<TOKEN>'],
    notes: ['BACKUP_URL_SECRET_<TOKEN> is the SAS token (Blob) or `<access key id>:<secret key>` (S3); it reaches SQL Server as a SecureString.'],
    extra: () => ({ backup_url: '' }),
  },
  'sql-mi-link': {
    summary: 'The Managed Instance link (a distributed availability group); planned failover both ways from SQL Server 2022.',
    modules: ['dbatools', 'Az.Accounts', 'Az.Sql'], functions: MI_FUNCS, verbs: MI_VERBS,
    settings: [
      ...COMMON_SQL,
      { key: 'resource_group', help: 'the Managed Instance resource group', required: true },
      { key: 'instance', help: 'the Managed Instance name', required: true },
      { key: 'link', help: 'the link name' },
      { key: 'ag', help: 'the source availability group the kit creates (CLUSTER_TYPE = NONE)' },
      { key: 'mi_ag', help: 'the availability group name on the Managed Instance side' },
      { key: 'dag', help: 'the distributed availability group' },
      { key: 'endpoint_port', help: 'the DATABASE_MIRRORING endpoint port on the source' },
      { key: 'planned_failover', help: '1 when the source is SQL Server 2022 or later (planned failover and failback)' },
    ],
    secrets: ['SRC_DB_PASSWORD_<TOKEN>', 'TGT_DB_PASSWORD_<TOKEN>', 'MASTER_KEY_PASSWORD_<TOKEN>'],
    notes: [
      'Import the Microsoft PKI root certificates on the source as Microsoft\'s "prepare the environment for the link" article shows (a runbook step; verify on your SQL Server version).',
      'tgt_host is the Managed Instance host name (<instance>.<dns zone>.database.windows.net); the controller connects to it with the TGT login for the failback.',
    ],
    extra: (i) => ({
      resource_group: '', instance: '', link: i.resource, ag: `atk_${i.name}`.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 128), mi_ag: `atk_${i.name}_mi`.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 128),
      dag: `atk_${i.name}_dag`.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 128), endpoint_port: '5022', planned_failover: PLANNED_FAILOVER_VERSIONS.has(i.version ?? '') ? '1' : '0',
    }),
  },
  'sql-mi-lrs': {
    summary: 'Log Replay Service to SQL Managed Instance: full and log backups to Blob Storage, replayed; completed after the tail-log backup.',
    modules: ['dbatools', 'Az.Accounts', 'Az.Sql'], functions: LRS_FUNCS, verbs: LRS_VERBS,
    settings: [
      ...COMMON_SQL,
      { key: 'resource_group', help: 'the Managed Instance resource group', required: true },
      { key: 'instance', help: 'the Managed Instance name', required: true },
      { key: 'container_uri', help: 'the Blob container for the backups (one folder per database)', required: true },
    ],
    secrets: ['SRC_DB_PASSWORD_<TOKEN>', 'MI_LRS_SAS'],
    notes: ['MI_LRS_SAS is a SAS token for the container (write, for the source\'s BACKUP TO URL); the Managed Instance reads it with its own managed identity.', 'The kit\'s log backups go to the container: pause the regular log backup jobs of this database while it moves, or the chain splits.'],
    extra: () => ({ resource_group: '', instance: '', container_uri: '' }),
  },
  'sql-rds-native': {
    summary: 'Amazon RDS for SQL Server native restore: backups to S3, rds_restore_database / rds_restore_log WITH NORECOVERY, rds_finish_restore at cutover.',
    modules: ['dbatools'], commands: ['aws'], functions: RDS_FUNCS, verbs: RDS_VERBS,
    settings: [
      ...COMMON_SQL,
      { key: 'rds_instance', help: 'the RDS DB instance identifier' },
      { key: 's3_bucket', help: 'the S3 bucket the RDS option group reads', required: true },
      { key: 's3_prefix', help: 'the key prefix for this database' },
      { key: 's3_partition', help: 'the ARN partition (aws, aws-us-gov, aws-cn)' },
      { key: 'backup_share', help: 'the backup folder as the source SQL Server writes it (UNC)', required: true },
      { key: 'backup_local', help: 'the same folder as mounted on the controller', required: true },
    ],
    secrets: ['SRC_DB_PASSWORD_<TOKEN>', 'TGT_DB_PASSWORD_<TOKEN>'],
    notes: ['The kit takes the log backups while the database moves: pause the regular log backup jobs of this database, or the chain splits.'],
    extra: (i) => ({ rds_instance: i.resource, s3_bucket: '', s3_prefix: i.resource, s3_partition: 'aws', backup_share: '', backup_local: '' }),
  },
  'azure-dms': {
    summary: 'Azure Database Migration Service to Azure SQL Database (offline): the service, the integration runtime, the copy at cutover.',
    modules: ['dbatools', 'Az.Accounts', 'Az.Sql', 'Az.DataMigration'], functions: ADMS_FUNCS, verbs: ADMS_VERBS,
    settings: [
      ...COMMON_SQL,
      { key: 'resource_group', help: 'the resource group of the logical server and the migration service', required: true },
      { key: 'server', help: 'the Azure SQL logical server name', required: true },
      { key: 'target_db', help: 'the target database name' },
      { key: 'dms_name', help: 'the Database Migration Service (shared by the plan)' },
    ],
    secrets: ['SRC_DB_PASSWORD_<TOKEN>', 'TGT_DB_PASSWORD_<TOKEN>'],
    notes: ['The target login is a SQL login on the logical server; where the server is Entra-only, enable a migration login for the move (runbook).', 'ATK_DMS_IR_HOST: a Windows host with the integration runtime installed, reached by PowerShell remoting over SSH.'],
    extra: (i, ctx) => ({ resource_group: '', server: '', target_db: i.name, dms_name: `atk-${plan8(ctx)}-dms` }),
  },
};

function scriptFor(path            , rows        , ctx             )         {
  const spec = SPECS[path] ;
  return psScript({
    file: entryOf(path),
    paths: [path],
    summary: spec.summary,
    modules: spec.modules,
    ...(spec.commands ? { commands: spec.commands } : {}),
    functions: [psSettings(rows, ctx), DB_PS_BASE, PS_SHARED, spec.functions].join('\n'),
    verbs: Object.fromEntries(Object.entries(spec.verbs).map(([v, body]) => [v, `$script:DbChanged = $false\n${body}`]))                        ,
  });
}

function sqlFindings(items                         )            {
  const out            = [];
  for (const i of items) {
    switch (i.path) {
      case 'sql-backup-url': out.push(noReverseFinding(i, 'an offline copy')); break;
      case 'sql-mi-lrs': out.push(noReverseFinding(i, 'Log Replay Service restores one way')); break;
      case 'sql-rds-native': out.push(noReverseFinding(i, 'RDS native restore is one way')); break;
      case 'azure-dms': out.push(noReverseFinding(i, 'an offline copy')); break;
      case 'sql-mi-link':
        if (!PLANNED_FAILOVER_VERSIONS.has(i.version ?? '')) out.push(noReverseFinding(i, 'SQL Server before 2022 fails over to the Managed Instance only by a forced failover, with no failback'));
        out.push(info('exec.db.mi-link-pki', `${i.name}: the Managed Instance link needs the Microsoft PKI root certificates imported on SQL Server; prepare does the certificate exchange, the roots are a runbook step.`, { path: i.id, source: 'https://learn.microsoft.com/en-us/azure/azure-sql/managed-instance/managed-instance-link-preparation' }));
        break;
      default: break;
    }
    if (i.path === 'azure-dms') out.push(info('exec.db.schema-first', `${i.name}: the offline copy to Azure SQL Database moves rows; the schema is created first (the script checks it at prepare).`, { path: i.id }));
    if (i.path === 'sql-ag-seeding' || i.path === 'sql-mi-link') out.push(warning('exec.db.hadr-restart', `${i.name}: Always On must be enabled on ${i.path === 'sql-mi-link' ? 'the source' : 'both servers'}, which restarts SQL Server; the script checks it and stops at prepare until it is on.`, { path: i.id }));
  }
  return out;
}

export const SQLSERVER_GENERATOR                = Object.freeze({
  id: 'db-sqlserver',
  owner: 'WP-11d'         ,
  paths: SQLSERVER_PATHS,
  needs: [
    need('pwsh-module', 'dbatools', 'SQL Server paths (availability groups, log shipping, backups)', { min: '2.1' }),
    need('pwsh-module', 'Az.Accounts', 'Azure sign-in (managed identity or a federated service principal)'),
    need('pwsh-module', 'Az.Sql', 'the Managed Instance link and Log Replay Service'),
    need('pwsh-module', 'Az.DataMigration', 'Azure Database Migration Service'),
    need('command', 'aws', 'RDS for SQL Server native restore (S3)'),
  ],
  entry: (p          ) => entryOf(p),
  files(items                         , ctx             )                                   {
    const out                         = {};
    const readme               = [];
    const rows = new Map                                          ();
    const tokens = new Map                ();
    for (const path of SQLSERVER_PATHS) {
      const list = onPath(items, path);
      if (!list.length) continue;
      const spec = SPECS[path] ;
      const r = dbRows(list, (i) => ({ trust_server_certificate: '1', ...spec.extra(i, ctx) }));
      out[entryOf(path)] = scriptFor(path, r, ctx);
      for (const i of list) readme.push({ item: i, script: entryOf(path), settings: [...BASE_SETTINGS, ...spec.settings], secrets: spec.secrets, notes: spec.notes ?? [] });
      for (const [k, v] of r.rows) rows.set(k, v);
      for (const [k, v] of r.tokens) tokens.set(k, v);
    }
    out[`${DB_DIR}/README-sqlserver.md`] = dbReadme(
      'SQL Server paths',
      'PowerShell 7.4 scripts (dbatools, Az.Sql, Az.DataMigration) run from the migration controller; the wave scripts call them with pwsh -NoProfile -File, or run them directly with -Verb and -Wave.',
      readme, { rows, tokens },
    );
    return out;
  },
  findings(items                         , ctx             )                     {
    const rows = new Map                                ();
    const tokens = new Map                ();
    for (const path of SQLSERVER_PATHS) {
      const r = dbRows(onPath(items, path), (i) => SPECS[path] .extra(i, ctx));
      for (const [k, v] of r.rows) rows.set(k, { ...v });
      for (const [k, v] of r.tokens) tokens.set(k, v);
    }
    return [...sqlFindings(items), ...endpointFinding(items, { rows, tokens })];
  },
});

export const GENERATORS                           = Object.freeze([SQLSERVER_GENERATOR]);
