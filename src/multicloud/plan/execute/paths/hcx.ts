/**
 * VCF Operations HCX paths (addendum A.6.3 / A.6.4, WP-11b): hcx-bulk,
 * hcx-rav, hcx-vmotion, hcx-cold and hcx-osam, one engine for VCF, Azure
 * VMware Solution, Google Cloud VMware Engine, Oracle Cloud VMware Solution
 * and Amazon EVS.
 *
 * Files (relative to migration/execute/):
 *   paths/hcx/hcx.ps1               the verbs, through VMware.VimAutomation.Hcx (VCF PowerCLI)
 *   paths/hcx/mobility-groups.json  the HCX Mobility Group settings, per move group (the provider-format export)
 *   paths/hcx/network-mappings.json the network mappings and the port groups to extend
 *   paths/hcx/underlay.json         Broadcom's network underlay minimums per migration type
 *   paths/hcx/README.md             the runbook steps HCX has no automation for
 *   paths/hcx/enable-avs.sh         the HCX add-on and enterprise site on Azure VMware Solution
 *   paths/hcx/enable-gcve.sh        an HCX activation key on Google Cloud VMware Engine
 *   ansible/hcx-sentinel.yml        the Sentinel agent in OS Assisted Migration guests
 *
 * `hcx.ps1` uses only the cmdlets of Broadcom's published module list
 * (`HCX_CMDLETS`); it never stops or removes a migration, and unextends a
 * network with `Remove-HCXNetworkExtension` (there is no -UnextendNetwork).
 * Rescheduling a switchover uses `Set-HCXMigration -ScheduleStartTime
 * -ScheduleEndTime` (a cmdlet), not the REST API.
 *
 * Module list: https://developer.broadcom.com/powercli/latest/vmware.vimautomation.hcx/
 */

import { info, warning, type Finding } from '../../../../core/findings.ts';
import { slugName } from '../../options.ts';
import type { MovePath, Platform } from '../../types.ts';
import { planId8, shortHash, type ExecPath } from '../contract.ts';
import { code } from '../lib-sh.ts';
import { psScript } from '../lib-ps.ts';
import type { ManifestItem } from '../manifest.ts';
import { HCX_UNDERLAY, HCX_UNDERLAY_SOURCE, NO_AUTO_FALLBACK } from '../paths.ts';
import type { PathContext, PathGenerator } from '../registry.ts';
import { POWERCLI_NEED, PS_VSPHERE_HELPERS } from './xvc.ts';

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

export const HCX_MODULE_SOURCE = 'https://developer.broadcom.com/powercli/latest/vmware.vimautomation.hcx/';

/**
 * Every cmdlet in VMware.VimAutomation.Hcx, as Broadcom's PowerCLI reference
 * lists it (read 2026-09-26 from HCX_MODULE_SOURCE). `hcx.ps1` may use no
 * other `*-HCX*` cmdlet; the test checks it.
 */
export const HCX_CMDLETS: readonly string[] = Object.freeze([
  'Get-HCXAppliance', 'New-HCXAppliance', 'Remove-HCXAppliance', 'Set-HCXAppliance',
  'Get-HCXComputeProfile', 'New-HCXComputeProfile', 'New-HCXComputeProfileDVS', 'New-HCXComputeProfileNetwork', 'Remove-HCXComputeProfile', 'Set-HCXComputeProfile',
  'Get-HCXContainer', 'Get-HCXDatastore', 'Get-HCXGateway',
  'New-HCXGuestOSCustomization', 'New-HCXGuestOSNetworkCustomization',
  'Get-HCXInterconnectStatus', 'Get-HCXInventoryCompute', 'Get-HCXInventoryDVS', 'Get-HCXInventoryDatastore', 'Get-HCXInventoryNetwork',
  'Get-HCXJob', 'Wait-HCXJob',
  'Get-HCXMigration', 'New-HCXMigration', 'Set-HCXMigration', 'Start-HCXMigration', 'Test-HCXMigration',
  'Get-HCXMobilityGroup', 'New-HCXMobilityGroup', 'New-HCXMobilityGroupConfiguration', 'Set-HCXMobilityGroup', 'Set-HCXMobilityGroupConfiguration',
  'Start-HCXMobilityGroupMigration', 'Stop-HCXMobilityGroupMigration', 'Test-HCXMobilityGroup',
  'Get-HCXNetwork', 'Get-HCXNetworkBacking', 'Get-HCXNetworkExtension', 'Get-HCXNetworkProfile', 'New-HCXNetworkExtension', 'New-HCXNetworkMapping',
  'New-HCXNetworkProfile', 'Remove-HCXNetworkExtension', 'Remove-HCXNetworkProfile', 'Set-HCXNetworkProfile',
  'Get-HCXReplication', 'Get-HCXReplicationSnapshot', 'New-HCXReplication', 'Remove-HCXReplication', 'Resume-HCXReplication', 'Set-HCXReplication',
  'Start-HCXReplication', 'Suspend-HCXReplication', 'Test-HCXReplication',
  'New-HCXSentinelBundle', 'Uninstall-HCXSentinel', 'Update-HCXSentinel',
  'Connect-HCXServer', 'Disconnect-HCXServer', 'Get-HCXService',
  'Get-HCXServiceMesh', 'New-HCXServiceMesh', 'New-HCXServiceMeshDVS', 'Remove-HCXServiceMesh', 'Set-HCXServiceMesh',
  'Get-HCXSite', 'Get-HCXSitePairing', 'New-HCXSitePairing', 'Remove-HCXSitePairing', 'New-HCXStaticRoute',
  'Get-HCXStorageProfile', 'Get-HCXVM',
]);

/** Never in the generated script: a migration is not stopped or removed by the kit, and there is no -UnextendNetwork parameter. */
export const HCX_FORBIDDEN: readonly string[] = Object.freeze(['Stop-HCXMigration', 'Remove-HCXMigration', '-UnextendNetwork']);

export type HcxPath = Extract<MovePath, 'hcx-bulk' | 'hcx-rav' | 'hcx-vmotion' | 'hcx-cold' | 'hcx-osam'>;
export const HCX_PATHS: readonly HcxPath[] = Object.freeze(['hcx-bulk', 'hcx-rav', 'hcx-vmotion', 'hcx-cold', 'hcx-osam']);
/** New-HCXMigration -MigrationType, per path (the values of the cmdlet's MigrationType enum). */
export type HcxMigrationType = 'Bulk' | 'RAV' | 'vMotion' | 'Cold' | 'OsAssistedMigration';
export const HCX_MIGRATION_TYPE: Readonly<Record<HcxPath, HcxMigrationType>> = Object.freeze({
  'hcx-bulk': 'Bulk', 'hcx-rav': 'RAV', 'hcx-vmotion': 'vMotion', 'hcx-cold': 'Cold', 'hcx-osam': 'OsAssistedMigration',
});
/** The types that replicate ahead of a scheduled switchover, in a mobility group; vMotion and Cold move at cutover. */
export const HCX_GROUPED: readonly HcxMigrationType[] = Object.freeze(['Bulk', 'RAV', 'OsAssistedMigration']);
export const isHcxPath = (p: string): p is HcxPath => (HCX_PATHS as readonly string[]).includes(p);

/** Broadcom: MTU at least 1150 on the underlay, for every migration type. */
export const HCX_MTU_MIN = 1150;

export interface UnderlayMinimum { readonly mbps: number; readonly mbpsWanOpt?: number; readonly lossPct: number; readonly latencyMs: number; readonly mtu: number }
/** Broadcom's underlay minimums per path: vMotion / RAV 250 Mbps (150 with WAN Optimization, VCF 9.1) and 0.1 % loss; Bulk / Cold / OSAM 50 Mbps and 1 % loss; 150 ms; MTU 1150. */
export const HCX_UNDERLAY_MIN: Readonly<Record<HcxPath, UnderlayMinimum>> = Object.freeze(Object.fromEntries(
  HCX_PATHS.map((p) => [p, Object.freeze({ ...HCX_UNDERLAY[p]!, mtu: HCX_MTU_MIN })]),
) as Record<HcxPath, UnderlayMinimum>);

export interface UnderlayMeasure { readonly mbps?: number; readonly lossPct?: number; readonly latencyMs?: number; readonly mtu?: number; readonly wanOpt?: boolean }

/**
 * What a measured underlay (HCX Transport Analytics) misses of Broadcom's
 * minimums for a path, one line each; empty when it meets them or nothing is
 * measured. `hcx.ps1 prepare` applies the same rule to ATK_HCX_UNDERLAY_*.
 */
export function underlayProblems(path: HcxPath, m: UnderlayMeasure): string[] {
  const min = HCX_UNDERLAY_MIN[path];
  const out: string[] = [];
  const need = m.wanOpt && min.mbpsWanOpt ? min.mbpsWanOpt : min.mbps;
  if (m.mbps !== undefined && m.mbps < need) out.push(`${m.mbps} Mbps is below ${need} Mbps${min.mbpsWanOpt ? (m.wanOpt ? ' (with WAN Optimization)' : ' (without WAN Optimization)') : ''}`);
  if (m.lossPct !== undefined && m.lossPct > min.lossPct) out.push(`${m.lossPct}% packet loss is above ${min.lossPct}%`);
  if (m.latencyMs !== undefined && m.latencyMs > min.latencyMs) out.push(`${m.latencyMs} ms latency is above ${min.latencyMs} ms`);
  if (m.mtu !== undefined && m.mtu < min.mtu) out.push(`MTU ${m.mtu} is below ${min.mtu}`);
  return out;
}

/** The VMware service an HCX item lands on. */
export type HcxDestination = 'vcf' | 'avs' | 'gcve' | 'ocvs' | 'evs';
export const HCX_DESTINATION_LABELS: Readonly<Record<HcxDestination, string>> = Object.freeze({
  vcf: 'VMware Cloud Foundation (on-premises)',
  avs: 'Azure VMware Solution',
  gcve: 'Google Cloud VMware Engine',
  ocvs: 'Oracle Cloud VMware Solution',
  evs: 'Amazon Elastic VMware Service',
});
const DEST_OF: Readonly<Record<Platform, HcxDestination>> = { vmware: 'vcf', azure: 'avs', google: 'gcve', oci: 'ocvs', aws: 'evs' };
export function hcxDestination(i: ManifestItem): HcxDestination {
  return i.target.platform ? DEST_OF[i.target.platform] : 'vcf';
}

// ---------------------------------------------------------------------------
// The provider-format export: HCX Mobility Group settings
// ---------------------------------------------------------------------------

export interface HcxMobilityGroupVm {
  readonly item: string;
  readonly name: string;
  readonly path: HcxPath;
  readonly migrationType: HcxMigrationType;
  /** true: replicated in the group ahead of the window; false: moved at cutover (vMotion, Cold). */
  readonly viaGroup: boolean;
  readonly sourceId: string | null;
  readonly powerState: string | null;
}
export interface HcxMobilityGroup {
  readonly name: string;
  readonly wave: number | null;
  readonly moveGroup: string | null;
  readonly destination: HcxDestination;
  readonly migrationTypes: readonly HcxMigrationType[];
  /** The switchover window: the wave's start (null: none planned yet) and its length. */
  readonly switchover: { readonly start: string | null; readonly windowHours: number };
  readonly vms: readonly HcxMobilityGroupVm[];
}
export interface HcxMobilityGroups {
  readonly kind: 'archtoolkit.hcx-mobility-groups';
  readonly v: 1;
  readonly note: string;
  readonly source: string;
  readonly sourceSite: string | null;
  readonly destinationSite: string | null;
  readonly windowHours: number;
  /** Mandatory Mobility Group settings: destination compute container, storage, migration type, disk format, network per VM. */
  readonly placement: { readonly container: string | null; readonly datastore: string | null; readonly folder: string | null; readonly diskProvisionType: 'Thin' };
  /** Per-migration options (Broadcom "additional migration settings"). */
  readonly options: {
    readonly retainMac: true; readonly migrateCustomAttributes: true; readonly replicateSecurityTags: true;
    readonly removeISOs: true; readonly removeSnapshots: true; readonly upgradeVMTools: true; readonly upgradeHardware: false;
    readonly enableSeedCheckpoint: true; readonly forcePowerOffVm: false;
  };
  readonly networkMappings: readonly { readonly source: string; readonly destination: string }[];
  readonly groups: readonly HcxMobilityGroup[];
}

const MOBILITY_GROUP_SOURCE = 'https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-0/workload-mobility/vmware-hcx-user-guide-vcf-9-0/migrating-virtual-machines-with-vmware-hcx/migrating-mobility-groups-from-migration-waves/migrating-mobility-group-workloads-in-migration-waves.html';
const NAME_MAX = 63;

/** `atk-<plan8>-w<wave>-<group>`: the mobility group's deterministic name (at most 63 characters). */
export function mobilityGroupName(planId: string, wave: number | null, group: string): string {
  const slug = slugName(group).replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'group';
  const head = `atk-${planId8(planId)}-w${wave ?? 0}-`;
  if (head.length + slug.length <= NAME_MAX) return head + slug;
  const hash = shortHash(group).slice(0, 6);
  return `${head}${slug.slice(0, NAME_MAX - head.length - hash.length - 1).replace(/-+$/, '')}-${hash}`;
}

export function hcxMobilityGroups(items: readonly ManifestItem[], ctx: PathContext): HcxMobilityGroups {
  const hcx = ctx.settings.hcx;
  const windowHours = hcx?.windowHours ?? 4;
  const byKey = new Map<string, ManifestItem[]>();
  for (const i of items) {
    if (!isHcxPath(i.path)) continue;
    const key = `${i.wave ?? 0}\u0000${i.moveGroup ?? i.app}`;
    byKey.set(key, [...(byKey.get(key) ?? []), i]);
  }
  const groups: HcxMobilityGroup[] = [...byKey.values()].map((list) => {
    const first = list[0]!;
    const group = first.moveGroup ?? first.app;
    const wave = ctx.manifest.waves.find((w) => w.n === first.wave);
    const vms = list.map((i): HcxMobilityGroupVm => {
      const type = HCX_MIGRATION_TYPE[i.path as HcxPath];
      return {
        item: i.id, name: i.name, path: i.path as HcxPath, migrationType: type, viaGroup: HCX_GROUPED.includes(type),
        sourceId: i.source.id ?? null, powerState: i.source.powerState ?? null,
      };
    });
    return {
      name: mobilityGroupName(ctx.plan.id, first.wave, group),
      wave: first.wave,
      moveGroup: first.moveGroup ?? null,
      destination: hcxDestination(first),
      migrationTypes: [...new Set(vms.filter((v) => v.viaGroup).map((v) => v.migrationType))].sort(),
      switchover: { start: wave?.start ?? null, windowHours },
      vms,
    };
  }).sort((a, b) => (a.wave ?? 0) - (b.wave ?? 0) || a.name.localeCompare(b.name));
  return {
    kind: 'archtoolkit.hcx-mobility-groups',
    v: 1,
    note: 'VCF Operations HCX Mobility Group settings for this plan, one group per wave and move group. hcx.ps1 creates the groups from this file; the same values can be entered in HCX by hand. The HCX wave-import CSV columns are not published, so this is JSON.',
    source: MOBILITY_GROUP_SOURCE,
    sourceSite: hcx?.sourceSite || null,
    destinationSite: hcx?.destSite || null,
    windowHours,
    placement: { container: hcx?.container ?? null, datastore: hcx?.datastore ?? null, folder: hcx?.folder ?? null, diskProvisionType: 'Thin' },
    options: {
      retainMac: true, migrateCustomAttributes: true, replicateSecurityTags: true, removeISOs: true, removeSnapshots: true,
      upgradeVMTools: true, upgradeHardware: false, enableSeedCheckpoint: true, forcePowerOffVm: false,
    },
    networkMappings: (hcx?.mappings ?? []).map((m) => ({ source: m.from, destination: m.to })),
    groups,
  };
}

/** `network-mappings.json`: the mapping grid and the port groups to extend (each needs its gateway to be extended). */
export function hcxNetworkMappings(ctx: PathContext): unknown {
  const hcx = ctx.settings.hcx;
  return {
    kind: 'archtoolkit.hcx-network-mappings',
    v: 1,
    sourceSite: hcx?.sourceSite || null,
    destinationSite: hcx?.destSite || null,
    mappings: (hcx?.mappings ?? []).map((m) => ({ from: m.from, to: m.to })),
    extend: [...(hcx?.extend ?? [])].sort().map((network) => ({
      network,
      gateway: null,
      destinationGateway: null,
      note: 'gateway: the port group\'s IPv4 gateway with its prefix (for example 10.1.2.1/24); New-HCXNetworkExtension needs it. destinationGateway: the destination Tier-1 name (null: the first the destination offers).',
    })),
  };
}

export function hcxUnderlay(): unknown {
  return {
    kind: 'archtoolkit.hcx-underlay',
    v: 1,
    source: HCX_UNDERLAY_SOURCE,
    note: 'Broadcom: HCX operations with lesser performance than the minimum values are not supported. Measure with HCX Transport Analytics and export ATK_HCX_UNDERLAY_MBPS, ATK_HCX_UNDERLAY_LOSS_PCT, ATK_HCX_UNDERLAY_LATENCY_MS and ATK_HCX_UNDERLAY_MTU; ATK_HCX_WAN_OPT=1 when WAN Optimization runs (VCF 9.1; removed in 9.0).',
    paths: Object.fromEntries(HCX_PATHS.map((p) => [p, { migrationType: HCX_MIGRATION_TYPE[p], ...HCX_UNDERLAY_MIN[p] }])),
  };
}

// ---------------------------------------------------------------------------
// hcx.ps1
// ---------------------------------------------------------------------------

export const HCX_FILE = 'paths/hcx/hcx.ps1';
const RAV_WARNING = NO_AUTO_FALLBACK['hcx-rav']!.text;

const FUNCTIONS = code`
${PS_VSPHERE_HELPERS.trim()}

$Groups = Read-AtkJson 'mobility-groups.json'
$Net = Read-AtkJson 'network-mappings.json'
$Underlay = Read-AtkJson 'underlay.json'
$MigrationType = @{ ${HCX_PATHS.map((p) => `'${p}' = '${HCX_MIGRATION_TYPE[p]}'`).join('; ')} }
$RavWarning = '${RAV_WARNING.replace(/'/g, "''")}'
$script:Hcx = $null
$script:SiteReady = $false
$script:ExtReady = $false
$script:Bundles = $null

function Connect-AtkHcx {
  if ($script:Hcx) { return $script:Hcx }
  if (-not $env:HCX_SERVER -or -not $env:HCX_USER) {
    throw 'set HCX_SERVER (the source HCX Connector or Manager) and HCX_USER; the password comes from HCX_PASSWORD, HCX_PASSWORD_FILE or ATK_VAULT_CMD'
  }
  $secure = ConvertTo-SecureString -String (Get-AtkSecret -Name 'HCX_PASSWORD') -AsPlainText -Force
  $cred = [System.Management.Automation.PSCredential]::new($env:HCX_USER, $secure)
  $script:Hcx = Connect-HCXServer -Server $env:HCX_SERVER -Credential $cred -ErrorAction Stop
  return $script:Hcx
}

# The name of an HCX object, whichever property this PowerCLI release carries it in.
function Get-HcxName {
  param($Object)
  foreach ($p in 'Name', 'NetworkName') { $v = Get-AtkProp $Object $p; if ($v -is [string] -and $v) { return $v } }
  foreach ($p in 'Network', 'SourceNetwork') { $n = Get-AtkProp (Get-AtkProp $Object $p) 'Name'; if ($n) { return [string] $n } }
  return ''
}
function Get-HcxVmName {
  param($Migration)
  foreach ($p in 'VM', 'Entity') { $n = Get-AtkProp (Get-AtkProp $Migration $p) 'Name'; if ($n) { return [string] $n } }
  return [string] (Get-AtkProp $Migration 'VMName', 'EntityName')
}
function Get-HcxState { param($Migration) return [string] (Get-AtkProp $Migration 'State', 'Status') }
function Get-HcxPercent {
  param($Migration)
  $p = Get-AtkProp $Migration 'PercentComplete', 'Progress', 'Percentage'
  if ($null -eq $p) { return -1 }
  return [double] $p
}
function Test-HcxFailed { param($Migration) return ((Get-HcxState $Migration) -match '(?i)fail|abort|cancel') }
function Test-HcxDone { param($Migration) return ((Get-HcxState $Migration) -match '(?i)complete' -and -not (Test-HcxFailed $Migration)) }
# The tracker state an HCX migration stands for (the state names are matched loosely: verify on your release).
function Get-HcxItemState {
  param($Migration)
  if (Test-HcxDone $Migration) { return 'cut-over' }
  if ((Get-HcxPercent $Migration) -ge 100 -or (Get-HcxState $Migration) -match '(?i)switchover|schedul|wait|ready') { return 'in-sync' }
  return 'replicating'
}

# The latest HCX migration of a VM (by name), or $null.
function Find-HcxMigration {
  param([string] $Name)
  $null = Connect-AtkHcx
  $all = @(Get-HCXMigration -ErrorAction SilentlyContinue | Where-Object { (Get-HcxVmName $_) -eq $Name })
  if ($all.Count -eq 0) { return $null }
  return ($all | Sort-Object { [string] (Get-AtkProp $_ 'StartTime', 'CreationDate', 'CreateTime') } | Select-Object -Last 1)
}

function Wait-HcxMigration {
  param([string] $Name, [int] $Minutes)
  $null = Wait-AtkUntil -Minutes $Minutes -IntervalSeconds 60 { $m = Find-HcxMigration $Name; (Test-HcxDone $m) -or (Test-HcxFailed $m) }
  return (Find-HcxMigration $Name)
}

function Get-HcxSourceSite {
  $null = Connect-AtkHcx
  $s = $null
  if ($Groups.sourceSite) { $s = Get-HCXSite -Source -Name $Groups.sourceSite -ErrorAction SilentlyContinue | Select-Object -First 1 }
  if (-not $s) { $s = Get-HCXSite -Source | Select-Object -First 1 }
  return $s
}
function Get-HcxDestSite {
  $null = Connect-AtkHcx
  $s = $null
  if ($Groups.destinationSite) { $s = Get-HCXSite -Destination -Name $Groups.destinationSite -ErrorAction SilentlyContinue | Select-Object -First 1 }
  if (-not $s) { $s = Get-HCXSite -Destination | Select-Object -First 1 }
  if (-not $s) { throw 'no HCX destination site: pair the sites first (prepare)' }
  return $s
}

# Where a VM lands: the settings' placement at the destination, or (-Reverse) the source placement recorded at prepare.
function Get-HcxPlacement {
  param($Site, [string] $Id, [switch] $Reverse)
  if ($Reverse) {
    $rec = Get-AtkId -Path 'hcx' -Key $Id
    if (-not $rec) { throw 'no record of the source placement (status/ids/hcx.json, written at prepare when VC_SRC is set): migrate it back by hand' }
    $container, $datastore, $folder = ([string] $rec) -split ';', 3
  } else {
    $container = [string] $Groups.placement.container
    $datastore = [string] $Groups.placement.datastore
    $folder = [string] $Groups.placement.folder
  }
  if (-not $container) { throw 'no target compute container: set it under Execute > Settings > HCX' }
  $p = @{ Container = $null; Datastore = $null; StorageProfile = $null; Folder = $null }
  $p.Container = Get-HCXContainer -Site $Site -Name $container -ErrorAction SilentlyContinue | Where-Object { [string] (Get-AtkProp $_ 'Type') -ne 'Folder' } | Select-Object -First 1
  if (-not $p.Container) { throw "the compute container $container is not found at $($Site.Name)" }
  if ($datastore) {
    $p.Datastore = Get-HCXDatastore -Site $Site -Name $datastore -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $p.Datastore) {
      $p.StorageProfile = Get-HCXStorageProfile -Site $Site -Name $datastore -ErrorAction SilentlyContinue | Select-Object -First 1
      if (-not $p.StorageProfile) { throw "neither a datastore nor a storage policy named $datastore is found at $($Site.Name)" }
      $p.Datastore = Get-HCXDatastore -Site $Site -StorageProfile $p.StorageProfile | Select-Object -First 1
    }
  }
  if ($folder) { $p.Folder = Get-HCXContainer -Site $Site -Type Folder -Name $folder -ErrorAction SilentlyContinue | Select-Object -First 1 }
  return $p
}

# The network pairs, from the mapping grid, found at both sites.
function Get-HcxNetworkPairs {
  param($From, $To, [switch] $Reverse)
  $out = @()
  foreach ($m in @($Net.mappings)) {
    $a = if ($Reverse) { [string] $m.to } else { [string] $m.from }
    $b = if ($Reverse) { [string] $m.from } else { [string] $m.to }
    $s = Get-HCXNetwork -Site $From -Name $a -ErrorAction SilentlyContinue | Select-Object -First 1
    $d = Get-HCXNetwork -Site $To -Name $b -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $s -or -not $d) { Write-AtkLog "network mapping $($a) to $($b) is not found at both sites: left out"; continue }
    $out += [pscustomobject] @{ Source = $s; Destination = $d }
  }
  return $out
}

# An HCX migration request for one item (with -DryRun: printed, and $null returned).
function New-HcxRequest {
  param([string] $Id, [string] $Type, [switch] $Group, [switch] $Reverse, $Start = $null, $End = $null)
  $it = Get-AtkItem -Id $Id
  $from = Get-HcxSourceSite
  $to = Get-HcxDestSite
  if ($Reverse) { $from, $to = $to, $from }
  $vm = Get-HCXVM -Site $from -Name $it.name -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $it.name } | Select-Object -First 1
  if (-not $vm) { throw "HCX does not see $($it.name) at $($from.Name)" }
  $place = Get-HcxPlacement $to $Id -Reverse:$Reverse
  $pairs = @(Get-HcxNetworkPairs $from $to -Reverse:$Reverse)
  if ($pairs.Count -eq 0 -and -not $Group) { throw 'no network mapping is found at both sites: set them under Execute > Settings > HCX' }
  return (Invoke-AtkStep "prepare the HCX $Type request for $($it.name)" {
    $maps = @($pairs | ForEach-Object { New-HCXNetworkMapping -SourceNetwork $_.Source -DestinationNetwork $_.Destination })
    $a = @{
      SourceSite = $from; DestinationSite = $to; VM = $vm; MigrationType = $Type; TargetComputeContainer = $place.Container
      DiskProvisionType = 'Thin'; RetainMac = $true; MigrateCustomAttributes = $true; ReplicateSecurityTags = $true
      RemoveISOs = $true; RemoveSnapshots = $true; UpgradeVMTools = $true
    }
    if ($maps.Count) { $a.NetworkMapping = $maps }
    if ($place.Datastore) { $a.TargetDatastore = $place.Datastore }
    if ($place.StorageProfile) { $a.TargetStorageProfile = $place.StorageProfile }
    if ($place.Folder) { $a.Folder = $place.Folder }
    if ($Type -in 'Bulk', 'RAV') { $a.EnableSeedCheckpoint = $true }
    if ($Start) { $a.ScheduleStartTime = $Start; $a.ScheduleEndTime = $End }
    if ($Group) { $a.MobilityGroupMigration = $true }
    New-HCXMigration @a
  })
}

function Get-HcxGroupOf {
  param([string] $Id)
  foreach ($g in @($Groups.groups)) { if (@($g.vms | ForEach-Object { $_.item }) -contains $Id) { return $g } }
  return $null
}

# The switchover window: the wave's start when it is still ahead, else a placeholder a week out (cutover pulls it forward).
function Get-HcxWindow {
  param($Group)
  $hours = [int] $Groups.windowHours
  $now = [datetime]::UtcNow
  $raw = $Group.switchover.start
  $start = $null
  if ($raw -is [datetime]) { $start = $raw.ToUniversalTime() }
  elseif ($raw) {
    $styles = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
    try { $start = [datetime]::Parse([string] $raw, [Globalization.CultureInfo]::InvariantCulture, $styles) } catch { $start = $null }
  }
  if (-not $start -or $start -lt $now.AddHours(1)) {
    $start = $now.AddDays(7)
    Write-AtkLog "mobility group $($Group.name): the wave has no start ahead, so the switchover is held a week out; cutover pulls it forward"
  }
  return @($start, $start.AddHours($hours))
}

function New-HcxGroupConfiguration {
  param($Group)
  $from = Get-HcxSourceSite
  $to = Get-HcxDestSite
  $place = Get-HcxPlacement $to ''
  $pairs = @(Get-HcxNetworkPairs $from $to)
  $start, $end = Get-HcxWindow $Group
  return (Invoke-AtkStep "prepare the configuration of mobility group $($Group.name)" {
    $maps = @($pairs | ForEach-Object { New-HCXNetworkMapping -SourceNetwork $_.Source -DestinationNetwork $_.Destination })
    $a = @{
      SourceSite = $from; DestinationSite = $to; TargetComputeContainer = $place.Container; DiskProvisionType = 'Thin'
      MigrationType = @($Group.migrationTypes); RetainMac = $true; MigrateCustomAttributes = $true; ReplicateSecurityTags = $true
      RemoveISOs = $true; RemoveSnapshots = $true; UpgradeVMTools = $true; ScheduleStartTime = $start; ScheduleEndTime = $end
    }
    if ($maps.Count) { $a.NetworkMapping = $maps }
    if ($place.Datastore) { $a.TargetDatastore = $place.Datastore }
    if ($place.StorageProfile) { $a.TargetStorageProfile = $place.StorageProfile }
    if ($place.Folder) { $a.TargetComputeFolder = $place.Folder }
    New-HCXMobilityGroupConfiguration @a
  })
}

# Throws when HCX reports validation errors for a group (the property names vary by release: verify).
function Assert-HcxValid {
  param($Result, [string] $What)
  $errs = @(Get-AtkProp $Result 'ValidationErrors', 'Errors')
  $errs = @($errs | Where-Object { $_ })
  if ($errs.Count) { throw "HCX validation of $($What): $(($errs | Out-String).Trim())" }
}

# Site pairing, service mesh and interconnect: once per run.
function Initialize-HcxSite {
  if ($script:SiteReady) { return }
  $null = Connect-AtkHcx
  $pairs = @(Get-HCXSitePairing)
  $destUrl = $env:HCX_DEST_URL
  $paired = $pairs.Count -gt 0
  if ($destUrl -and $paired) {
    $destHost = ([uri] $destUrl).Host
    $paired = @($pairs | Where-Object { ($_ | Out-String) -match [regex]::Escape($destHost) }).Count -gt 0
  }
  if (-not $paired) {
    if (-not $destUrl -or -not $env:HCX_DEST_USER) { throw 'the HCX sites are not paired: set HCX_DEST_URL (the destination HCX Cloud Manager) and HCX_DEST_USER, with HCX_DEST_PASSWORD, and run prepare again' }
    $destPassword = ConvertTo-SecureString -String (Get-AtkSecret -Name 'HCX_DEST_PASSWORD') -AsPlainText -Force
    Invoke-AtkStep "pair this HCX site with $destUrl" { $null = New-HCXSitePairing -Url $destUrl -Username $env:HCX_DEST_USER -Password $destPassword | Wait-HCXJob }
  }
  if (@(Get-HCXComputeProfile -ErrorAction SilentlyContinue).Count -eq 0) { throw 'no HCX compute profile: create the compute and network profiles and the service mesh (paths/hcx/README.md, runbook step 2)' }
  if (@(Get-HCXNetworkProfile -ErrorAction SilentlyContinue).Count -eq 0) { throw 'no HCX network profile: create the network profiles (paths/hcx/README.md, runbook step 2)' }
  if (@(Get-HCXServiceMesh -ErrorAction SilentlyContinue).Count -eq 0) { throw 'no HCX service mesh: create it (paths/hcx/README.md, runbook step 2), then run prepare again' }
  $ic = (Get-HCXInterconnectStatus | Out-String).Trim()
  Write-AtkLog "HCX interconnect: $ic"
  if ($ic -match '(?i)\b(down|error|failed|unhealthy)\b') { throw 'an HCX interconnect or network extension appliance is not up (Get-HCXInterconnectStatus): repair the service mesh first' }
  $script:SiteReady = $true
}

function ConvertTo-HcxNetmask {
  param([int] $Prefix)
  $bits = ([uint64] 4294967295 -shl (32 - $Prefix)) -band 4294967295
  return ((24, 16, 8, 0 | ForEach-Object { ($bits -shr $_) -band 255 }) -join '.')
}

# The port groups to extend (Execute > Settings > HCX): once per run.
function Initialize-HcxExtensions {
  if ($script:ExtReady) { return }
  $extend = @($Net.extend)
  if ($extend.Count -eq 0) { $script:ExtReady = $true; return }
  $src = Get-HcxSourceSite
  $dst = Get-HcxDestSite
  $existing = @(Get-HCXNetworkExtension -ErrorAction SilentlyContinue | ForEach-Object { Get-HcxName $_ })
  foreach ($e in $extend) {
    if ($existing -contains $e.network) { continue }
    if (-not $e.gateway) { throw "to extend $($e.network), set its gateway in paths/hcx/network-mappings.json (extend[].gateway, for example 10.1.2.1/24)" }
    if (([string] $e.gateway).Contains(':')) { throw "$($e.network): New-HCXNetworkExtension takes an IPv4 gateway and netmask; extend the IPv6 side in the HCX UI (IPv6 extension support is unverified)" }
    $gw, $prefix = ([string] $e.gateway) -split '/', 2
    $mask = ConvertTo-HcxNetmask ([int] $prefix)
    $network = Get-HCXNetwork -ForExtension -Site $src -Name $e.network -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $network) { throw "$($e.network) cannot be extended (not offered by Get-HCXNetwork -ForExtension: VMkernel, untagged, PVLAN, ephemeral and standard-switch port groups cannot)" }
    $appliance = Get-HCXAppliance -Type L2Concentrator | Select-Object -First 1
    if (-not $appliance) { throw 'no HCX network extension appliance: enable Network Extension in the service mesh' }
    $gateway = if ($e.destinationGateway) { Get-HCXGateway -DestinationSite $dst -Name $e.destinationGateway | Select-Object -First 1 } else { Get-HCXGateway -DestinationSite $dst | Select-Object -First 1 }
    if (-not $gateway) { throw "no destination gateway for $($e.network) at $($dst.Name)" }
    Invoke-AtkStep "extend $($e.network) ($($gw)/$($prefix)) to $($dst.Name)" { $null = New-HCXNetworkExtension -Appliance $appliance -DestinationGateway $gateway -DestinationSite $dst -GatewayIp $gw -Netmask $mask -Network $network -SourceSite $src | Wait-HCXJob }
  }
  $script:ExtReady = $true
}

# The measured underlay against Broadcom's minimums for the path (empty: met, or not measured).
function Get-HcxUnderlayProblems {
  param([string] $Path)
  $min = $Underlay.paths.$Path
  $out = @()
  $wanOpt = $env:ATK_HCX_WAN_OPT -eq '1'
  $need = if ($wanOpt -and (Get-AtkProp $min 'mbpsWanOpt')) { [double] $min.mbpsWanOpt } else { [double] $min.mbps }
  if ($env:ATK_HCX_UNDERLAY_MBPS -and (ConvertTo-AtkDouble $env:ATK_HCX_UNDERLAY_MBPS) -lt $need) { $out += "$($env:ATK_HCX_UNDERLAY_MBPS) Mbps is below $need Mbps" }
  if ($env:ATK_HCX_UNDERLAY_LOSS_PCT -and (ConvertTo-AtkDouble $env:ATK_HCX_UNDERLAY_LOSS_PCT) -gt [double] $min.lossPct) { $out += "$($env:ATK_HCX_UNDERLAY_LOSS_PCT)% packet loss is above $($min.lossPct)%" }
  if ($env:ATK_HCX_UNDERLAY_LATENCY_MS -and (ConvertTo-AtkDouble $env:ATK_HCX_UNDERLAY_LATENCY_MS) -gt [double] $min.latencyMs) { $out += "$($env:ATK_HCX_UNDERLAY_LATENCY_MS) ms latency is above $($min.latencyMs) ms" }
  if ($env:ATK_HCX_UNDERLAY_MTU -and [int] $env:ATK_HCX_UNDERLAY_MTU -lt [int] $min.mtu) { $out += "MTU $($env:ATK_HCX_UNDERLAY_MTU) is below $($min.mtu)" }
  return $out
}
function Test-HcxUnderlayMeasured { return [bool] ($env:ATK_HCX_UNDERLAY_MBPS -or $env:ATK_HCX_UNDERLAY_LOSS_PCT -or $env:ATK_HCX_UNDERLAY_LATENCY_MS) }

# The source placement (cluster;datastore;folder), for a reverse migration; recorded once, when VC_SRC is set.
function Save-HcxSourcePlacement {
  param([string] $Id, $It)
  if (-not $env:VC_SRC -or (Get-AtkId -Path 'hcx' -Key $Id)) { return }
  $src = Connect-AtkVc SRC
  $vm = Find-AtkVm $src $It.name
  if (-not $vm) { return }
  $cl = Get-Cluster -VM $vm -Server $src
  $ds = Get-Datastore -RelatedObject $vm | Select-Object -First 1
  Set-AtkId -Path 'hcx' -Key $Id -Value (@([string] $cl.Name, [string] $ds.Name, [string] $vm.Folder.Name) -join ';')
}

# OS Assisted Migration: the Sentinel agent in the guest, through ansible/hcx-sentinel.yml.
function Install-HcxSentinel {
  param($It)
  Assert-AtkTool -Command 'ansible-playbook'
  if (-not $script:Bundles) {
    $sgw = Get-HCXAppliance -Type SentinelGateway | Select-Object -First 1
    if (-not $sgw) { throw 'no Sentinel Gateway appliance: activate OS Assisted Migration in the service mesh' }
    $linux = New-AtkTempFile
    $windows = New-AtkTempFile
    Invoke-AtkStep 'download the HCX Sentinel bundles from the Sentinel Gateway' {
      $null = New-HCXSentinelBundle -OSType Linux -SGWAppliance $sgw -Path $linux
      $null = New-HCXSentinelBundle -OSType Windows -SGWAppliance $sgw -Path $windows
    }
    $script:Bundles = @{ Linux = $linux; Windows = $windows }
  }
  $inventory = if ($env:ATK_INVENTORY) { $env:ATK_INVENTORY } else { Join-Path $KitRoot 'ansible/inventory' }
  $playbook = Join-Path $KitHome 'ansible/hcx-sentinel.yml'
  $vars = @{ hcx_sentinel_linux_bundle = $script:Bundles.Linux; hcx_sentinel_windows_bundle = $script:Bundles.Windows } | ConvertTo-Json -Compress
  Invoke-AtkStep "install the HCX Sentinel agent in $($It.name)" {
    & ansible-playbook -i $inventory $playbook --limit $It.name -e $vars
    if ($LASTEXITCODE -ne 0) { throw "ansible-playbook hcx-sentinel.yml failed for $($It.name) (exit $LASTEXITCODE)" }
  }
}

# The destination VM's managed object id, when VC_DST is set.
function Get-HcxTargetData {
  param($It)
  $data = @{}
  if (-not $env:VC_DST) { return $data }
  $vm = Find-AtkVm (Connect-AtkVc DST) $It.name
  if ($vm) { $data.targetMoref = Get-AtkMoRef $vm }
  return $data
}

# Bulk: HCX keeps the source VM powered off and renamed (with a timestamp suffix) for recovery; found by its id, else by name.
function Find-HcxRetainedSource {
  param($Src, $It)
  $vm = Find-AtkVmById $Src ([string] (Get-AtkProp $It.source 'id'))
  if ($vm) { return $vm }
  return (Get-VM -Server $Src -Name "$($It.name)*" -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne $It.name -and $_.PowerState -eq 'PoweredOff' } | Select-Object -First 1)
}

function Stop-HcxTarget {
  param($It)
  if (-not $env:VC_DST) { Write-AtkLog 'VC_DST is not set: stop the target VM in the destination vCenter by hand'; return }
  $dst = Connect-AtkVc DST
  $target = Find-AtkVm $dst $It.name
  if (-not $target -or $target.PowerState -ne 'PoweredOn') { return }
  Invoke-AtkStep "shut down the target $($It.name) (guest shutdown)" { $null = Stop-VMGuest -VM $target -Confirm:$false }
  $null = Wait-AtkUntil -Minutes 10 -IntervalSeconds 15 { (Get-VM -Server $dst -Id $target.Id).PowerState -eq 'PoweredOff' }
  if ((Get-VM -Server $dst -Id $target.Id).PowerState -ne 'PoweredOff') { Invoke-AtkStep "power off the target $($It.name)" { $null = Stop-VM -VM $target -Confirm:$false } }
}

# After the last VM of an extended port group has moved: remove the extension (the gateway moves to the destination).
function Invoke-HcxUnextend {
  $done = @()
  if (@($Net.extend).Count -eq 0) { return $done }
  $src = Connect-AtkVc SRC
  $all = @(Get-HCXNetworkExtension -ErrorAction SilentlyContinue)
  foreach ($e in @($Net.extend)) {
    $ne = $all | Where-Object { (Get-HcxName $_) -eq $e.network } | Select-Object -First 1
    if (-not $ne) { continue }
    $users = @(Get-VM -Server $src | Where-Object { $_.PowerState -eq 'PoweredOn' } | Get-NetworkAdapter | Where-Object { $_.NetworkName -eq $e.network })
    if ($users.Count) { Write-AtkLog "$($e.network) stays extended: $($users.Count) running source NICs still use it"; continue }
    Invoke-AtkStep "unextend $($e.network): the gateway moves to the destination" { $null = Remove-HCXNetworkExtension -HCXNetworkExtension $ne -ConnectToLocalRouter $true | Wait-HCXJob }
    $done += [string] $e.network
  }
  return $done
}
`;

const VERBS = {
  prepare: code`
$it = Get-AtkItem -Id $Id
$type = $MigrationType[[string] $it.path]
$problems = @(Get-HcxUnderlayProblems ([string] $it.path))
if ($problems.Count) { Set-AtkOutcome failed "the network underlay is below Broadcom's minimum for HCX $($type) ($($problems -join '; ')): HCX does not support it" ; return }
Initialize-HcxSite
Initialize-HcxExtensions
if ($type -eq 'OsAssistedMigration') { Install-HcxSentinel $it }
Save-HcxSourcePlacement $Id $it
$vm = Get-HCXVM -Site (Get-HcxSourceSite) -Name $it.name -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $it.name } | Select-Object -First 1
if (-not $vm -and $type -ne 'OsAssistedMigration') { Set-AtkOutcome failed "HCX does not see $($it.name) at the source site"; return }
$note = if (Test-HcxUnderlayMeasured) { 'underlay meets the minimum' } else { 'underlay not measured (set ATK_HCX_UNDERLAY_* from HCX Transport Analytics)' }
if ($type -eq 'RAV') { Write-AtkLog "warning: $RavWarning" }
Set-AtkOutcome succeeded "ready for HCX $($type): sites paired, service mesh up; $note" -State prepared`,
  replicate: code`
$it = Get-AtkItem -Id $Id
$type = $MigrationType[[string] $it.path]
if ($type -in 'vMotion', 'Cold') { Set-AtkOutcome skipped "HCX $type moves the VM at cutover: nothing replicates before it"; return }
Initialize-HcxSite
$m = Find-HcxMigration $it.name
if ($m -and -not (Test-HcxFailed $m)) { Set-AtkOutcome skipped "already in HCX ($(Get-HcxState $m))" -State (Get-HcxItemState $m) -Data @{ hcxState = (Get-HcxState $m) }; return }
$g = Get-HcxGroupOf $Id
if (-not $g) { Set-AtkOutcome failed 'the item is in no mobility group (mobility-groups.json): regenerate the kit'; return }
$start, $end = Get-HcxWindow $g
$req = New-HcxRequest -Id $Id -Type $type -Group -Start $start -End $end
$existing = Get-HCXMobilityGroup -Name $g.name -ErrorAction SilentlyContinue | Select-Object -First 1
if ($existing) {
  Invoke-AtkStep "add $($it.name) to mobility group $($g.name) and start it" {
    $null = Set-HCXMobilityGroup -AddMigration -Migration $req -MobilityGroup $existing
    $grp = Get-HCXMobilityGroup -Name $g.name | Select-Object -First 1
    Assert-HcxValid (Test-HCXMobilityGroup -MobilityGroup $grp) $g.name
    $null = Start-HCXMobilityGroupMigration -MobilityGroup $grp
  }
} else {
  $conf = New-HcxGroupConfiguration $g
  Invoke-AtkStep "create mobility group $($g.name) with $($it.name) and start it" {
    $grp = New-HCXMobilityGroup -Name $g.name -GroupConfiguration $conf -Migration $req
    Assert-HcxValid (Test-HCXMobilityGroup -MobilityGroup $grp) $g.name
    $null = Start-HCXMobilityGroupMigration -MobilityGroup $grp
  }
}
if ($type -eq 'RAV') { Write-AtkLog "warning: $RavWarning" }
Set-AtkOutcome succeeded "base sync started in mobility group $($g.name); switchover held for the window from $($start.ToString('u'))" -State replicating`,
  test: `Set-AtkOutcome skipped 'HCX has no test switchover; the source is retained for rollback (Bulk) or moved back (vMotion, RAV, Cold): gate G2 needs the rollback rehearsal on a non-production VM'`,
  'test-cleanup': `Set-AtkOutcome skipped 'HCX has no test copy to remove'`,
  cutover: code`
$it = Get-AtkItem -Id $Id
$type = $MigrationType[[string] $it.path]
$hours = [int] $Groups.windowHours
Initialize-HcxSite
$m = Find-HcxMigration $it.name
if ($m -and (Test-HcxDone $m)) { Set-AtkOutcome skipped 'already switched over' -State 'cut-over' -Data (Get-HcxTargetData $it); return }
if ($type -eq 'RAV') { Write-AtkLog "warning: $RavWarning" }
if ($type -in 'vMotion', 'Cold') {
  if (-not $m -or (Test-HcxFailed $m)) {
    $req = New-HcxRequest -Id $Id -Type $type
    if ($req) { Assert-HcxValid (Test-HCXMigration -Migration $req) $it.name }
    Invoke-AtkStep "start HCX $type of $($it.name)" { $null = Start-HCXMigration -Migration $req }
  }
} else {
  if (-not $m) { Set-AtkOutcome failed 'not in HCX: run replicate first'; return }
  if (Test-HcxFailed $m) { Set-AtkOutcome failed "the HCX migration failed ($(Get-HcxState $m)): retry it in HCX (it resumes from the seed checkpoint), then run cutover again"; return }
  $now = [datetime]::UtcNow
  Invoke-AtkStep "pull the switchover of $($it.name) forward to now" { $null = Set-HCXMigration -Migration $m -ScheduleStartTime $now -ScheduleEndTime $now.AddHours($hours) }
}
if ($DryRun) { Set-AtkOutcome succeeded 'dry run: the switchover was printed, not started'; return }
$m = Wait-HcxMigration $it.name ($hours * 60)
if (Test-HcxDone $m) { Set-AtkOutcome succeeded "switched over (HCX $type)" -State 'cut-over' -Data (Get-HcxTargetData $it); return }
if (Test-HcxFailed $m) { Set-AtkOutcome failed "the HCX switchover failed ($(Get-HcxState $m)): see the migration in HCX; roll back or retry"; return }
Set-AtkOutcome failed "not switched over within $hours h (HCX: $(Get-HcxState $m)): check it in HCX, then run cutover again (it resumes)"`,
  commit: `Set-AtkOutcome skipped 'HCX keeps the source until finalize'`,
  rollback: code`
$it = Get-AtkItem -Id $Id
$type = $MigrationType[[string] $it.path]
if ($type -eq 'Bulk') {
  $src = Connect-AtkVc SRC
  $source = Find-HcxRetainedSource $src $it
  if (-not $source) { Set-AtkOutcome failed "the retained source VM is not on the source vCenter (by id, or as $($it.name) with a suffix): roll back by hand"; return }
  if ($source.Name -eq $it.name -and $source.PowerState -eq 'PoweredOn') { Set-AtkOutcome skipped 'already running on the source'; return }
  Stop-HcxTarget $it
  if ($source.Name -ne $it.name) { Invoke-AtkStep "rename $($source.Name) back to $($it.name)" { $null = Set-VM -VM $source -Name $it.name -Confirm:$false } }
  Invoke-AtkStep "connect the NICs of $($it.name) at power-on" { $null = Get-NetworkAdapter -VM $source | Set-NetworkAdapter -StartConnected:$true -Confirm:$false }
  Invoke-AtkStep "start $($it.name) on the source" { $null = Start-VM -VM $source -Confirm:$false }
  Invoke-AtkStep "connect the NICs of $($it.name)" { $null = Get-NetworkAdapter -VM (Get-VM -Server $src -Id $source.Id) | Set-NetworkAdapter -Connected:$true -Confirm:$false }
  Set-AtkOutcome succeeded 'the source runs again; the target is stopped and kept for analysis'
  return
}
if ($type -eq 'OsAssistedMigration') {
  Stop-HcxTarget $it
  Set-AtkOutcome succeeded 'the target is stopped; the source is still on its hypervisor: start it with its source adapter'
  return
}
Initialize-HcxSite
$back = Get-HCXVM -Site (Get-HcxSourceSite) -Name $it.name -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $it.name } | Select-Object -First 1
if ($back) { Set-AtkOutcome skipped 'already at the source site'; return }
$reverseType = if ($type -eq 'Cold') { 'Cold' } else { 'vMotion' }
$req = New-HcxRequest -Id $Id -Type $reverseType -Reverse
Invoke-AtkStep "start the reverse HCX $reverseType of $($it.name) to the source site" { $null = Start-HCXMigration -Migration $req }
if ($DryRun) { Set-AtkOutcome succeeded 'dry run: the reverse migration was printed, not started'; return }
$m = Wait-HcxMigration $it.name ([int] $Groups.windowHours * 60)
if (Test-HcxDone $m) { Set-AtkOutcome succeeded "moved back to the source site (reverse HCX $reverseType)"; return }
Set-AtkOutcome failed "the reverse migration has not finished (HCX: $(Get-HcxState $m)): check it in HCX"`,
  finalize: code`
$it = Get-AtkItem -Id $Id
$type = $MigrationType[[string] $it.path]
$m = Find-HcxMigration $it.name
if (-not (Test-HcxDone $m)) { Set-AtkOutcome failed 'not switched over: nothing is finalized before the cutover'; return }
$note = "HCX $type keeps no source copy"
if ($type -eq 'Bulk') {
  $src = Connect-AtkVc SRC
  $source = Find-HcxRetainedSource $src $it
  if ($source -and $source.PowerState -eq 'PoweredOn') { Set-AtkOutcome failed "the source $($source.Name) is running (rolled back?): it is not deleted"; return }
  if ($source -and $source.Name -ne $it.name) {
    Invoke-AtkStep "delete the retained source VM $($source.Name)" { $null = Remove-VM -VM $source -DeletePermanently -Confirm:$false }
    $note = "deleted the retained source $($source.Name)"
  } else { $note = 'no retained source VM is left' }
} elseif ($type -eq 'OsAssistedMigration') {
  $note = 'the source stays on its hypervisor: decommission removes it with its source adapter'
}
$un = @(Invoke-HcxUnextend)
if ($un.Count) { $note = "$note; unextended $($un -join ', ')" }
Set-AtkOutcome succeeded $note`,
  status: code`
$it = Get-AtkItem -Id $Id
$type = $MigrationType[[string] $it.path]
$m = Find-HcxMigration $it.name
if (-not $m) {
  if ($type -in 'vMotion', 'Cold') { Set-AtkOutcome skipped "HCX $type moves at cutover: nothing replicates" } else { Set-AtkOutcome skipped 'not in HCX yet: run replicate' }
  return
}
$data = @{ hcxState = (Get-HcxState $m) }
$pct = Get-HcxPercent $m
if ($pct -ge 0) { $data.percent = $pct }
if (Test-HcxFailed $m) { Set-AtkOutcome failed "HCX: $(Get-HcxState $m)" -Data $data; return }
$state = Get-HcxItemState $m
if ($state -eq 'in-sync') { $data.inSync = $true }
Set-AtkOutcome succeeded "HCX: $(Get-HcxState $m)" -State $state -Data $data`,
};

export function renderHcxScript(): string {
  return psScript({
    file: HCX_FILE,
    paths: HCX_PATHS,
    summary: 'VCF Operations HCX: Bulk, Replication Assisted vMotion, vMotion, Cold and OS Assisted Migration, in mobility groups per move group.',
    modules: ['VMware.VimAutomation.Hcx', 'VMware.VimAutomation.Core'],
    functions: FUNCTIONS,
    verbs: VERBS,
  });
}

// ---------------------------------------------------------------------------
// Enabling HCX on Azure VMware Solution and Google Cloud VMware Engine
// ---------------------------------------------------------------------------

export const ENABLE_AVS_FILE = 'paths/hcx/enable-avs.sh';
export const ENABLE_GCVE_FILE = 'paths/hcx/enable-gcve.sh';
export const AVS_HCX_OFFER = 'VMware MaaS Cloud Provider (Enterprise)';

export function renderEnableAvs(plan8: string, privateCloud: string): string {
  return code`#!/usr/bin/env bash
# Enables VCF Operations HCX on the Azure VMware Solution private cloud: the HCX add-on
# (az vmware addon hcx) and an HCX enterprise site for the on-premises HCX Connector
# (az vmware hcx-enterprise-site). Idempotent: each is created only when it is missing.
# azurerm has no HCX add-on resource, which is why this is a CLI step.
# Changes are made by default; --dry-run prints each change instead. See README.md.
# Docs: https://learn.microsoft.com/en-us/cli/azure/vmware/addon/hcx
#       https://learn.microsoft.com/en-us/cli/azure/vmware/hcx-enterprise-site
set -Eeuo pipefail
source "$(cd "$(dirname "$\{BASH_SOURCE[0]}")" && pwd)/../../lib/atk.sh"
atk_init_tool orchestrator "$@"
atk_need az

rg="$\{AVS_RESOURCE_GROUP:-}"
pc="$\{AVS_PRIVATE_CLOUD:-${privateCloud}}"
site="atk-${plan8}-onprem"
[[ -n "$rg" ]] || atk_die 3 "set AVS_RESOURCE_GROUP (the landing zone's shared resource group, which holds the private cloud $pc)"

atk_event - prepare started "" "enable HCX on $pc"
if az vmware addon hcx show --resource-group "$rg" --private-cloud "$pc" --only-show-errors --output none 2> /dev/null; then
  atk_log "the HCX add-on is already on $pc"
else
  atk_run az vmware addon hcx create --resource-group "$rg" --private-cloud "$pc" --offer "${AVS_HCX_OFFER}" --only-show-errors --output none
fi
if az vmware hcx-enterprise-site show --resource-group "$rg" --private-cloud "$pc" --name "$site" --only-show-errors --output none 2> /dev/null; then
  atk_log "the HCX enterprise site $site is already there"
else
  atk_run az vmware hcx-enterprise-site create --resource-group "$rg" --private-cloud "$pc" --name "$site" --only-show-errors --output none
fi
# The activation key is not printed or stored: read it when entering it in the on-premises HCX Connector.
atk_event - prepare succeeded "" "HCX is enabled on $pc (the activation key: az vmware hcx-enterprise-site show -g $rg -c $pc -n $site --query activationKey -o tsv)"
`;
}

export function renderEnableGcve(plan8: string, privateCloud: string): string {
  return code`#!/usr/bin/env bash
# Google Cloud VMware Engine: HCX is preinstalled. This creates an HCX activation key for the
# on-premises HCX Connector, once (found by name). Connectors at HCX 4.10.3 or later activate on
# pairing without a key (Google, from 19 May 2025), so the key is for older connectors.
# Changes are made by default; --dry-run prints each change instead. See README.md.
# Doc: https://docs.cloud.google.com/sdk/gcloud/reference/vmware/private-clouds/hcx/activationkeys/create
set -Eeuo pipefail
source "$(cd "$(dirname "$\{BASH_SOURCE[0]}")" && pwd)/../../lib/atk.sh"
atk_init_tool orchestrator "$@"
atk_need gcloud

pc="$\{GCVE_PRIVATE_CLOUD:-${privateCloud}}"
location="$\{GCVE_LOCATION:-}"
key="atk-${plan8}"
[[ -n "$location" ]] || atk_die 3 "set GCVE_LOCATION (the zone of the private cloud $pc, for example europe-west2-a)"
project=()
if [[ -n "$\{GCVE_PROJECT:-}" ]]; then project=(--project "$GCVE_PROJECT"); fi

atk_event - prepare started "" "HCX activation key on $pc"
if gcloud vmware private-clouds hcx activationkeys list --private-cloud "$pc" --location "$location" "$\{project[@]}" --format 'value(name)' | grep -q "/$key\$"; then
  atk_log "the HCX activation key $key is already there"
else
  atk_run gcloud vmware private-clouds hcx activationkeys create "$key" --private-cloud "$pc" --location "$location" "$\{project[@]}"
fi
atk_event - prepare succeeded "" "HCX activation key $key on $pc (shown by: gcloud vmware private-clouds hcx activationkeys describe $key --private-cloud $pc --location $location)"
`;
}

// ---------------------------------------------------------------------------
// The Sentinel playbook (OS Assisted Migration)
// ---------------------------------------------------------------------------

export const SENTINEL_PLAYBOOK = 'ansible/hcx-sentinel.yml';
export const SENTINEL_SOURCE = 'https://techdocs.broadcom.com/us/en/vmware-cis/hcx/vmware-hcx/4-11/vmware-hcx-user-guide-4-11/configuring-and-managing-the-hcx-interconnect/sentinel-management/downloading-and-installing-hcx-sentinel-agent-software.html';

export function renderSentinelPlaybook(): string {
  return code`---
# Installs the VCF Operations HCX Sentinel agent in the guests that move with OS Assisted Migration
# (KVM and Hyper-V sources). paths/hcx/hcx.ps1 prepare runs it with --limit <guest> and the bundles it
# downloaded from the Sentinel Gateway (New-HCXSentinelBundle). A guest that has the agent is left alone.
# Linux: bash linux-sentinel-installer.sh, answering yes (Broadcom); disable polkit first where it blocks the service.
# Windows: install-sentinel.exe /VERYSILENT /NORESTART (the silent switches are from a community source: unverified).
# ${SENTINEL_SOURCE}
- name: Install the HCX Sentinel agent (OS Assisted Migration)
  hosts: all
  gather_facts: true
  vars:
    hcx_sentinel_linux_bundle: ""
    hcx_sentinel_windows_bundle: ""
    hcx_sentinel_linux_marker: /var/lib/hcx-sentinel-kit/installed
    hcx_sentinel_windows_check: 'C:\Program Files\VMware\HCX\OSAM\sentinelService.exe'
  tasks:
    - name: Install on Linux
      when: ansible_facts['os_family'] != 'Windows'
      become: true
      block:
        - name: Look for an earlier install
          ansible.builtin.stat:
            path: "{{ hcx_sentinel_linux_marker }}"
          register: hcx_sentinel_linux_done

        - name: Install the agent
          when: not hcx_sentinel_linux_done.stat.exists
          block:
            - name: Check that the Linux bundle was given
              ansible.builtin.assert:
                that: hcx_sentinel_linux_bundle | length > 0
                fail_msg: Pass hcx_sentinel_linux_bundle (hcx.ps1 prepare downloads it)
                quiet: true

            - name: Create a work directory
              ansible.builtin.tempfile:
                state: directory
                suffix: hcx-sentinel
              register: hcx_sentinel_dir

            - name: Copy the installer
              ansible.builtin.copy:
                src: "{{ hcx_sentinel_linux_bundle }}"
                dest: "{{ hcx_sentinel_dir.path }}/linux-sentinel-installer.sh"
                mode: "0700"

            - name: Run the installer (it asks for yes)
              ansible.builtin.command:
                argv:
                  - bash
                  - "{{ hcx_sentinel_dir.path }}/linux-sentinel-installer.sh"
                stdin: "yes"
              changed_when: true

            - name: Create the marker directory
              ansible.builtin.file:
                path: "{{ hcx_sentinel_linux_marker | dirname }}"
                state: directory
                mode: "0755"

            - name: Record the install
              ansible.builtin.copy:
                dest: "{{ hcx_sentinel_linux_marker }}"
                content: "installed\n"
                mode: "0644"
          always:
            - name: Remove the work directory
              when: hcx_sentinel_dir.path is defined
              ansible.builtin.file:
                path: "{{ hcx_sentinel_dir.path }}"
                state: absent

    - name: Install on Windows
      when: ansible_facts['os_family'] == 'Windows'
      block:
        - name: Look for an earlier install
          ansible.windows.win_stat:
            path: "{{ hcx_sentinel_windows_check }}"
          register: hcx_sentinel_windows_done

        - name: Install the agent
          when: not hcx_sentinel_windows_done.stat.exists
          block:
            - name: Check that the Windows bundle was given
              ansible.builtin.assert:
                that: hcx_sentinel_windows_bundle | length > 0
                fail_msg: Pass hcx_sentinel_windows_bundle (hcx.ps1 prepare downloads it)
                quiet: true

            - name: Create a work directory
              ansible.windows.win_tempfile:
                state: directory
                suffix: hcx-sentinel
              register: hcx_sentinel_wdir

            - name: Copy the bundle
              ansible.windows.win_copy:
                src: "{{ hcx_sentinel_windows_bundle }}"
                dest: "{{ hcx_sentinel_wdir.path }}\\windows-sentinel-bundle.zip"

            - name: Unpack the bundle
              community.windows.win_unzip:
                src: "{{ hcx_sentinel_wdir.path }}\\windows-sentinel-bundle.zip"
                dest: "{{ hcx_sentinel_wdir.path }}\\bundle"

            - name: Find the installer
              ansible.windows.win_find:
                paths: "{{ hcx_sentinel_wdir.path }}\\bundle"
                patterns: install-sentinel.exe
                recurse: true
              register: hcx_sentinel_installer

            - name: Run the installer silently
              ansible.windows.win_package:
                path: "{{ hcx_sentinel_installer.files[0].path }}"
                arguments: /VERYSILENT /NORESTART
                creates_path: "{{ hcx_sentinel_windows_check }}"
                state: present
          always:
            - name: Remove the work directory
              when: hcx_sentinel_wdir.path is defined
              ansible.windows.win_file:
                path: "{{ hcx_sentinel_wdir.path }}"
                state: absent
`;
}

// ---------------------------------------------------------------------------
// README (the runbook steps HCX has no automation for)
// ---------------------------------------------------------------------------

export function renderHcxReadme(items: readonly ManifestItem[], exp: HcxMobilityGroups): string {
  const dests = [...new Set(items.map(hcxDestination))].sort();
  const types = [...new Set(items.map((i) => HCX_MIGRATION_TYPE[i.path as HcxPath]))].sort();
  const row = (p: HcxPath): string => {
    const m = HCX_UNDERLAY_MIN[p];
    return `| ${HCX_MIGRATION_TYPE[p]} | ${m.mbpsWanOpt ? `${m.mbps} (${m.mbpsWanOpt} with WAN Optimization, VCF 9.1)` : m.mbps} | ${m.lossPct}% | ${m.latencyMs} ms | ${m.mtu} |`;
  };
  return [
    '# VCF Operations HCX',
    '',
    `This folder moves ${items.length} VM(s) with VCF Operations HCX (${types.join(', ')}) to ${dests.map((d) => HCX_DESTINATION_LABELS[d]).join(', ')}. \`hcx.ps1\` runs the verbs with the VMware.VimAutomation.Hcx module of VCF PowerCLI; \`mobility-groups.json\` holds the Mobility Group settings it creates (${exp.groups.length} group(s)), and is the same data you would enter in HCX by hand.`,
    '',
    '## Runbook steps HCX has no automation for',
    '',
    '1. Deploy the HCX Connector on-premises and activate it (VCF: entitled by the VCF licence; Azure VMware Solution: `enable-avs.sh`; Google Cloud VMware Engine: `enable-gcve.sh`; Oracle Cloud VMware Solution: the HCX mode chosen with the SDDC; Amazon EVS: deploy VCF Operations HCX in the EVS environment first, as for VCF to VCF).',
    '2. Create the compute profile, the network profiles (management, uplink, vMotion, replication) and the service mesh, with Network Extension, and OS Assisted Migration where KVM or Hyper-V guests move. `prepare` checks them and stops until they exist.',
    '3. Check the underlay with HCX Transport Analytics and export the results (below). `prepare` refuses an item whose migration type the measured underlay does not support.',
    '4. Set the gateway of every port group to extend in `network-mappings.json` (`extend[].gateway`, for example `10.1.2.1/24`); `prepare` extends them.',
    '',
    '## Order',
    '',
    '`prepare` (pairing, checks, network extension, Sentinel), `replicate` (mobility groups: base sync now, switchover held for the wave window), `status --once` until in sync, then in the window `cutover` (pulls the switchover forward to now; vMotion and Cold start here), and after acceptance `finalize` (deletes the retained Bulk source and unextends a port group once no running source VM uses it). `rollback`: Bulk restarts the retained source; vMotion, RAV and Cold migrate back.',
    '',
    '## Warnings',
    '',
    `- ${RAV_WARNING} ${NO_AUTO_FALLBACK['hcx-rav']!.remediation}`,
    '- HCX has no test switchover: gate G2 needs the rollback rehearsed on one non-production VM.',
    '- HCX WAN Optimization was removed in VCF 9.0 and is back in VCF 9.1 (in the enhanced service mesh).',
    '- Network extension cannot extend VMkernel, untagged (VLAN 0), PVLAN, ephemeral or standard-switch port groups, and reaches at most three destinations.',
    '',
    '## Network underlay minimums (Broadcom)',
    '',
    '| Migration type | Mbps | Packet loss | Latency | MTU |',
    '|---|---|---|---|---|',
    ...HCX_PATHS.map(row),
    '',
    `"HCX operations with lesser performance than the minimum values are not supported." (${HCX_UNDERLAY_SOURCE})`,
    '',
    'Export `ATK_HCX_UNDERLAY_MBPS`, `ATK_HCX_UNDERLAY_LOSS_PCT`, `ATK_HCX_UNDERLAY_LATENCY_MS` and `ATK_HCX_UNDERLAY_MTU` from Transport Analytics, and `ATK_HCX_WAN_OPT=1` when WAN Optimization runs.',
    '',
    '## Environment',
    '',
    '| Variable | What |',
    '|---|---|',
    '| `HCX_SERVER`, `HCX_USER`, `HCX_PASSWORD` | the source HCX Connector (or Manager) |',
    '| `HCX_DEST_URL`, `HCX_DEST_USER`, `HCX_DEST_PASSWORD` | the destination HCX Cloud Manager, for the site pairing |',
    '| `VC_SRC`, `VC_SRC_USER`, `VC_SRC_PASSWORD` | the source vCenter (rollback, finalize, the recorded placement) |',
    '| `VC_DST`, `VC_DST_USER`, `VC_DST_PASSWORD` | the destination vCenter (the target VM id, rollback) |',
    '| `AVS_RESOURCE_GROUP`, `AVS_PRIVATE_CLOUD` | `enable-avs.sh` |',
    '| `GCVE_LOCATION`, `GCVE_PRIVATE_CLOUD`, `GCVE_PROJECT` | `enable-gcve.sh` |',
    '',
    'Passwords come from the variable, a `NAME_FILE` of mode 600, or `ATK_VAULT_CMD`; nothing is saved by PowerCLI. Certificates: trust the vCenter and HCX certificates on the controller (or set PowerCLI\'s InvalidCertificateAction yourself).',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

function privateCloudName(ctx: PathContext, platform: Platform, suffix: string): string {
  const prefix = ctx.design.platforms.find((p) => p.platform === platform)?.prefix;
  return prefix ? `${prefix}-${suffix}` : `atk-${planId8(ctx.plan.id)}-${suffix}`;
}

export const HCX_GENERATOR: PathGenerator = Object.freeze({
  id: 'hcx',
  owner: 'WP-11b' as const,
  paths: HCX_PATHS as readonly ExecPath[],
  needs: [POWERCLI_NEED],
  entry: () => HCX_FILE,
  files(items: readonly ManifestItem[], ctx: PathContext): Readonly<Record<string, string>> {
    const exp = hcxMobilityGroups(items, ctx);
    const plan8 = planId8(ctx.plan.id);
    const dests = new Set(items.map(hcxDestination));
    const out: Record<string, string> = {
      [HCX_FILE]: renderHcxScript(),
      'paths/hcx/mobility-groups.json': `${JSON.stringify(exp, null, 2)}\n`,
      'paths/hcx/network-mappings.json': `${JSON.stringify(hcxNetworkMappings(ctx), null, 2)}\n`,
      'paths/hcx/underlay.json': `${JSON.stringify(hcxUnderlay(), null, 2)}\n`,
      'paths/hcx/README.md': renderHcxReadme(items, exp),
    };
    if (dests.has('avs')) out[ENABLE_AVS_FILE] = renderEnableAvs(plan8, privateCloudName(ctx, 'azure', 'avs'));
    if (dests.has('gcve')) out[ENABLE_GCVE_FILE] = renderEnableGcve(plan8, privateCloudName(ctx, 'google', 'gcve'));
    if (items.some((i) => i.path === 'hcx-osam')) out[SENTINEL_PLAYBOOK] = renderSentinelPlaybook();
    return out;
  },
  findings(items: readonly ManifestItem[], ctx: PathContext): readonly Finding[] {
    const out: Finding[] = [];
    const hcx = ctx.settings.hcx;
    if (!hcx) {
      out.push(warning('exec.hcx.no-settings', `${items.length} item(s) move with HCX, and the HCX settings (sites, placement, network mappings, window) are not set: prepare and replicate stop until they are.`, { remediation: 'Fill in Execute › Settings › HCX, then regenerate the kit.' }));
    } else {
      if (!hcx.container || !hcx.datastore) out.push(warning('exec.hcx.no-placement', 'The HCX target compute container or datastore is not set: the mobility groups cannot be configured.', { remediation: 'Set them under Execute › Settings › HCX.' }));
      if (hcx.mappings.length === 0) out.push(warning('exec.hcx.no-mappings', 'No HCX network mapping is set: vMotion, Cold and the reverse migrations need one.', { remediation: 'Add the Source network | Destination network rows under Execute › Settings › HCX.' }));
      if (hcx.extend.length) {
        out.push(warning('exec.hcx.extend-gateway', `${hcx.extend.length} port group(s) are to be extended, and New-HCXNetworkExtension needs each one's gateway and prefix, which the settings do not hold: set extend[].gateway in paths/hcx/network-mappings.json before prepare.`, {
          source: 'https://developer.broadcom.com/powercli/latest/vmware.vimautomation.hcx/commands/new-hcxnetworkextension',
        }));
      }
    }
    const paths = [...new Set(items.map((i) => i.path))].filter(isHcxPath).sort();
    out.push(info('exec.hcx.underlay-unmeasured', `The plan records the site bandwidth only; Broadcom also sets packet loss (${paths.map((p) => `${HCX_MIGRATION_TYPE[p]} ${HCX_UNDERLAY_MIN[p].lossPct}%`).join(', ')}), latency (150 ms) and MTU (${HCX_MTU_MIN}) minimums. Measure them with HCX Transport Analytics and export ATK_HCX_UNDERLAY_* before prepare, which refuses an unsupported underlay.`, { source: HCX_UNDERLAY_SOURCE }));
    const dests = new Set(items.map(hcxDestination));
    if (dests.has('evs')) out.push(info('exec.hcx.evs-runbook', 'Amazon EVS: deploy VCF Operations HCX in the EVS environment first (runbook); the moves then run as VCF to VCF.', { source: 'https://docs.aws.amazon.com/evs/latest/userguide/migrate-evs-hcx.html' }));
    if (dests.has('ocvs')) out.push(info('exec.hcx.ocvs-activation', 'Oracle Cloud VMware Solution: HCX is chosen with the SDDC (its HCX mode); read the activation keys from the SDDC and enter them in the on-premises HCX Connector (runbook).', { source: 'https://docs.oracle.com/en-us/iaas/Content/VMware/Concepts/ocvsoverview.htm' }));
    if (items.some((i) => i.path === 'hcx-osam')) out.push(info('exec.hcx.osam-sentinel', 'OS Assisted Migration installs the HCX Sentinel agent in each guest through ansible/hcx-sentinel.yml, with the inventory\'s source hosts; the Windows silent install switches are unverified.', { source: SENTINEL_SOURCE }));
    return out;
  },
});

export const GENERATORS: readonly PathGenerator[] = Object.freeze([HCX_GENERATOR]);
