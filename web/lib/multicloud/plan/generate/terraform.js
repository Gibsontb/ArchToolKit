/**
 * Terraform composition: a decided, designed plan becomes one Terraform root
 * module per platform, stacked from the "From a migration plan" blueprints.
 *
 *   planToStacks   the stack items per platform (and per DR region), with
 *                  every value written in the blueprint's own input ids, grid
 *                  text included, exactly as the Terraform page saves them;
 *   terraformFiles those stacks built with `buildStack`, plus the per-platform
 *                  README, `cutover.auto.tfvars.example` and the settings
 *                  envelope the Terraform page loads.
 *
 * The same values go into the envelope, so opening a platform on the Terraform
 * page shows exactly the stack that was generated, editable; rebuilding the
 * envelope's stack through `buildStack` gives the same `.tf` files byte for
 * byte.
 *
 * Stack order per platform (base design 2.7.2, addendum A.12.3):
 *
 *   1 landing zone, 2 identity, 3 connectivity, governance,
 *   4 compute, 5 databases, 6 Oracle Database@,
 *   app context, pattern items, resource components,
 *   7 backup, 8 monitoring, app monitoring, relocate, 9 replication
 *
 * Scopes (addendum A.12.3): `estate` (everything), `landing-zone` (the
 * foundation only) and `apps` (the selected apps' workloads, databases and
 * app items). An `apps` stack with `landingZone: 'shared'` emits no landing
 * zone, identity or connectivity: every consumer reads `var.landing_zone`,
 * a resource component's `local.landing_zone` references become
 * `var.landing_zone`, and when no item declares the variable itself the
 * stack starts with the contract item `<p>_mig_landing_zone_variable` (built
 * by `withPlanBlueprints`, which `terraformFiles` uses as its lookup).
 * Components that are unresolved on the platform, or left out there, are not
 * generated; a new app's synthetic items whose component is not a VM are
 * built by their pattern item, never as compute rows.
 *
 * Every item is left out when it would be empty. The items whose blueprints
 * are not written yet (replication, governance, app context and monitoring,
 * patterns) are added only when the blueprint lookup returns them, so this
 * works today and picks them up when they land.
 *
 * Nothing here writes a credential, a timestamp other than the plan's own
 * `savedAt`, or anything that identifies who or what generated it.
 */

import { error, info, warning,              } from '../../../core/findings.js';
import { familyOf, overlapsAny } from '../../../core/ip.js';
                                                   
                                                           
import { envelope, writeSettings } from '../../../kit/settings-file.js';
                                                                        
import {
  consumerProvider, landingZoneVariable, planTagValue, renderImageRef, terraformBlock,                                              
} from '../../../terraform/blueprints/migration/common.js';
import { findTerraformBlueprint } from '../../../terraform/blueprints/index.js';
import { renderFile } from '../../../terraform/hcl.js';
                                                                   
                                                                  
import { buildStack } from '../../../terraform/stack.js';
import { DB_SERVICES_EXTRA } from '../db-catalog-extra.js';
import { designWorkloads, isIaasService, licenceKeyOf, siteCidrs } from '../design/index.js';
import { networkZones, noNetworkFinding } from '../design/network.js';
import { builtIn, envClassOf, hubOf } from '../design/net-rows.js';
import { RELOCATE_HOSTS } from '../design/relocate.js';
import { overrideKey, PLATFORM_LABELS, PLATFORM_VALUES, slugName } from '../options.js';
             
                                                                                                                     
                                                                                  
                     

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

                                                            
                                                    

                                      
     
                                                                      
                                                                        
                                                             
     
                              
     
                                                                           
                                                                            
                                                             
     
                                         
                                                                      
                             
                                            
                                    
                                                                                               
                                    
                                                                                                                                                 
                                                                                                      
 

/** One platform's stack: what goes to `buildStack`, and how. */
                                
                              
                                                                 
                          
                              
                             
                               
                                   
                                                  
                                                                           
                                     
                                                  
                        
 

                             
                                                                 
                                                                              
                                                        
                                        
 

/** The envelope a platform's stack is saved as: the Terraform page's, plus how it was built. */
                                                                 
                                                     
                                   
                                              
                                                  
  

/**
 * The application-plan parts this reads (addendum A.11.1), structurally: the
 * data model's `appPlans` is added by another package, so nothing here depends
 * on it being declared yet.
 */
                                   
                      
                        
                                                   
                                                           
                                       
                                                                 
                                         
                                
                                                       
                                
                                                     
                                                                                       
                                                                
 
                              
                       
                                                     
                               
                                                            
                                                                                       
                                                          
                                                                            
 

// ---------------------------------------------------------------------------
// The tags the compute rows carry for Ansible
// ---------------------------------------------------------------------------

/** The atk_plan tag of a plan's VMs: the plan id, as a tag value every cloud accepts. */
export const planTag = (plan                  )         => planTagValue(plan.id);

/**
 * The app component each server serves, for its atk_component tag: workload
 * name -> component id. A server is tagged with the first pattern component
 * of its app's saved plan (on the app's chosen platform) that lists it, or
 * lists a database it hosts. A server in two components carries the first;
 * the Ansible inventory adds it to the second by name.
 */
export function componentOfServers(plan      )                      {
  const out = new Map                ();
  for (const ap of (plan.appPlans ?? [])                          ) {
    if (ap.status === 'draft') continue;
    const platform = ap.platform ?? ap.recommendation?.platform;
    if (!platform) continue;
    for (const c of ap.variants?.[platform] ?? []) {
      if (c.kind !== 'pattern') continue;
      const names = [...(c.servers ?? [])];
      for (const dbName of c.databases ?? []) names.push(...(plan.databases.find((d) => d.name === dbName)?.hosts ?? []));
      for (const n of names) if (!out.has(n)) out.set(n, c.id);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** The blueprint id prefix and folder per platform. */
const BP                                     = { aws: 'aws', azure: 'azure', google: 'google', oci: 'oci', vmware: 'vsphere' };
const TARGET                                          = { aws: 'aws', azure: 'azure', google: 'google', oci: 'oci', vmware: 'vsphere' };
const CLOUD_NAME                                     = { aws: 'AWS', azure: 'Azure', google: 'Google Cloud', oci: 'OCI', vmware: 'VCF' };
const ZONE_LETTERS = ['a', 'b', 'c']         ;
const HA_GRID = new Set(['none', 'multi-az', 'business-critical', 'zone-redundant', 'regional', 'standby']);

/** `required_version` for a stack; a write-only argument (`*_wo`) needs Terraform 1.11. */
export const REQUIRED_VERSION = '>= 1.7.0';
export const REQUIRED_VERSION_WRITE_ONLY = '>= 1.11.0';

/** A grid row: cells joined with " | ", with anything that would break the row made safe. */
function row(cells                                          )         {
  return cells.map((c) => String(c ?? '').replace(/\r?\n/g, ' ').replace(/\s\|\s/g, ' / ').trim()).join(' | ');
}
const grid = (rows                                                       )         => rows.map(row).join('\n');

/** What a blueprint's resource-name helper (`rname`) makes of a name. */
const rname = (s        )         => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');

/** The compute row's Name: the workload's, made a valid Compute Engine name on Google Cloud (lowercase, a letter first). */
export function computeRowName(platform          , name        )         {
  if (platform !== 'google') return name;
  const s = rname(name).slice(0, 63).replace(/-+$/, '');
  return /^[a-z]/.test(s) ? s : `vm-${s}`.slice(0, 63);
}

/** The state backend for a platform from the Generate setting. */
export function backendFor(platform          , setting                          )                               {
  const s = setting ?? 'platform';
  if (s !== 'platform') return s;
  return ({ aws: 's3', azure: 'azurerm', google: 'gcs', oci: 'oci', vmware: 'local' }         )[platform];
}

/**
 * An address range the user assigned for a service outside the landing zone's
 * networks (`<platform>:range:<what>`: Google's Managed Microsoft AD /24, the
 * ODB network, the relocate target's management range). Nothing is picked
 * for them: an unset or overlapping range is an error finding.
 */
function userRange(ctx     , what                                   , label        )                     {
  const key = overrideKey(ctx.platform, 'range', what);
  const cidr = ctx.plan.designOverrides[key]?.trim() ?? '';
  if (!cidr) {
    ctx.findings.push(error('plan.tf.range-not-set', `${PLATFORM_LABELS[ctx.platform]}: ${label} needs an address range your network team assigns; give it on Landing zones (nothing is picked for you).`, { path: key }));
    return undefined;
  }
  const clash = ctx.used.find((u) => familyOf(u.split('/')[0] ?? '') === 4 && familyOf(cidr.split('/')[0] ?? '') === 4 && overlapsAny(cidr, u));
  if (clash) {
    ctx.findings.push(error('plan.tf.range-overlap', `${PLATFORM_LABELS[ctx.platform]}: ${label}'s range ${cidr} overlaps ${clash}.`, { path: key }));
  }
  ctx.used.push(cidr);
  return cidr;
}

/** Keep only the values a blueprint declares, when it declares its inputs (a lazy blueprint keeps them all). */
function declared(bp           , values                                  )                         {
  if (bp.inputs.length === 0) return { ...values };
  const ids = new Set(bp.inputs.map((i) => i.id));
  return Object.fromEntries(Object.entries(values).filter(([k]) => ids.has(k)));
}

const appPlansOf = (plan      )                         => (plan                                                         ).appPlans ?? [];

// ---------------------------------------------------------------------------
// The shared landing zone's contract, for a stack with no other consumer
// ---------------------------------------------------------------------------

const MIG_CLOUDS                                                = { aws: 'aws', azure: 'azure', google: 'google', oci: 'oci' };

/** The id of a platform's landing-zone contract item: `<p>_mig_landing_zone_variable`. */
export const landingZoneVariableId = (platform          )         => `${BP[platform]}_mig_landing_zone_variable`;

/**
 * `variable "landing_zone"` (the contract's shape) and the provider block
 * configured from it, as a blueprint of its own. A `shared` app stack whose
 * items do not declare the variable themselves (only resource components,
 * say) starts with it, so `var.landing_zone` is always declared with its
 * real type. It builds nothing.
 */
function landingZoneVariableBlueprint(platform          )                        {
  const cloud = MIG_CLOUDS[platform];
  if (!cloud) return undefined;
  return {
    id: landingZoneVariableId(platform),
    label: 'Landing zone (shared)',
    description: 'The landing zone of the landing-zone project, as var.landing_zone: this stack builds in it and creates none of its own.',
    inputs: [],
    emits: [],
    build: () => ({ files: { 'main.tf': renderFile([terraformBlock([TARGET[platform]]), landingZoneVariable(cloud), consumerProvider(cloud)]) } }),
  };
}

const LZ_VARIABLE_BLUEPRINTS                                 = new Map(
  PLATFORM_VALUES.flatMap((p) => {
    const b = landingZoneVariableBlueprint(p);
    return b ? [[b.id, b]         ] : [];
  }),
);

/** A lookup that also knows the planner's own landing-zone contract items. */
export function withPlanBlueprints(lookup                  = findTerraformBlueprint)                  {
  return (id) => LZ_VARIABLE_BLUEPRINTS.get(id) ?? lookup(id);
}

/** `local.landing_zone` → `var.landing_zone`, for a resource component's values in a shared stack. */
const toSharedReference = (values                                  )                         =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.replace(/\blocal\.landing_zone\b/g, 'var.landing_zone')]));

/**
 * Workload names that are synthetic items of new apps whose component on this
 * platform is not a VM (paas-web, serverless, containers …): the component's
 * pattern item builds them, never the compute grid.
 */
function syntheticServices(plan      , platform          )                      {
  const out = new Map                ();
  const synthetic = new Set(plan.workloads.filter((w) => w.synthetic).map((w) => w.name));
  if (synthetic.size === 0) return out;
  for (const ap of appPlansOf(plan)) {
    for (const c of ap.variants?.[platform] ?? []) {
      if (c.kind !== 'pattern' || !c.tierPattern || c.tierPattern === 'vm') continue;
      for (const n of c.servers ?? []) if (synthetic.has(n)) out.set(n, c.tierPattern);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The per-platform context
// ---------------------------------------------------------------------------

               
                      
                                  
                                
                              
                              
                      
                                   
                             
                           
                               
                            
                                                       
                                                 
                                               
                                           
                                             
                                   
                                          
                                                                          
                                                       
                                                                     
                                                    
                                                                                               
                          
 

function inScopeWorkload(w                      , options                     , apps                            )          {
  if (!w) return true;
  if (options.environment && w.env !== options.environment) return false;
  if (apps && !apps.has(w.app) && !apps.has(slugName(w.app))) return false;
  return true;
}

function contextFor(plan      , decision              , design              , pd                , options                     , used          , findings           )      {
  const platform = pd.platform;
  const workloads = [...designWorkloads(plan, design), ...(pd.added ?? [])];
  const workloadById = new Map(workloads.map((w) => [w.id, w]));
  const dbById = new Map(plan.databases.map((d) => [d.id, d]));
  const appByName = new Map(plan.apps.map((a) => [a.name, a]));
  const apps = options.apps && options.apps.length > 0
    ? new Set(options.apps.flatMap((a) => {
      const app = plan.apps.find((x) => x.id === a || x.name === a);
      return app ? [app.name, slugName(app.name)] : [a, slugName(a)];
    }))
    : null;

  const compute                  = [];
  const services = syntheticServices(plan, platform);
  for (const c of pd.compute) {
    const method = decision.items[c.workload]?.method;
    const w = workloadById.get(c.workload);
    const service = w ? services.get(w.name) : undefined;
    if (service) {
      if (inScopeWorkload(w, options, apps)) {
        findings.push(info('plan.tf.synthetic-service', `${w .app}: ${w .name} stands for the ${service} component, which its pattern item builds; it is not a VM in the compute grid.`));
      }
      continue;
    }
    if (method === 'managed-db') {
      // The source host of a database that moves to a managed service is not rebuilt anywhere.
      findings.push(info('plan.tf.managed-db-host', `${workloadById.get(c.workload)?.name ?? c.workload}: its database moves to a managed service, so it is not a compute row.`));
      continue;
    }
    if (!inScopeWorkload(workloadById.get(c.workload), options, apps)) continue;
    compute.push(c);
  }
  const inCompute = new Set(compute.map((c) => c.workload));
  const databases = pd.databases.filter((d) => {
    const db = dbById.get(d.database);
    if (apps && db && !apps.has(db.app) && !apps.has(slugName(db.app))) return false;
    if (options.environment) {
      const host = db?.hosts.map((h) => workloads.find((w) => w.name === h)).find(Boolean);
      const env = host?.env ?? 'prod';
      if (env !== options.environment) return false;
    }
    // An IaaS database lives on its hosts: in scope when one of them is.
    if (isIaasService(d.service) && d.hosts && d.hosts.length > 0 && !d.hosts.some((h) => inCompute.has(h))) return false;
    return true;
  });
  const dbEngineOfHost = new Map                ();
  for (const d of databases) {
    if (!isIaasService(d.service)) continue;
    const engine = dbById.get(d.database)?.engine;
    if (engine) for (const h of d.hosts ?? []) dbEngineOfHost.set(h, engine);
  }
  const scope = options.scope ?? 'estate';
  return {
    plan, decision, design, pd, platform,
    bp: BP[platform],
    lookup: options.lookup ?? findTerraformBlueprint,
    scope,
    shared: scope === 'apps' && options.landingZone === 'shared',
    findings,
    manual: [],
    workloadById, dbById, appByName,
    compute, databases, dbEngineOfHost,
    componentOf: componentOfServers(plan),
    used,
  };
}

/** `stack`, or `variables` when the landing zone is shared from another project. */
const lzSource = (ctx     )         => (ctx.shared ? 'variables' : 'stack');

/**
 * The network a database sits in: its first host's (as the design placed it),
 * else a built network of the host's environment with a data-tier subnet,
 * else the hub.
 */
function dbNetwork(ctx     , db                      )         {
  const built = builtIn(ctx.pd.networks, ctx.pd.region);
  const hostTarget = db?.hosts.map((h) => ctx.pd.compute.find((c) => ctx.workloadById.get(c.workload)?.name === h)).find(Boolean);
  if (hostTarget) return hostTarget.network;
  const host = db?.hosts.map((h) => [...ctx.workloadById.values()].find((w) => w.name === h)).find(Boolean);
  const want = host ? envClassOf(host.env) : 'prod';
  const withDb = built.filter((n) => n.subnets.some((s) => s.tier === 'db'));
  return (withDb.find((n) => n.env === want) ?? withDb[0] ?? hubOf(ctx.pd.networks, ctx.pd.region) ?? built[0])?.name ?? '';
}

/** The network the landing zone's shared services (directory, gateways) use: the hub, else the first built one. */
const hubName = (ctx     )         => hubOf(ctx.pd.networks, ctx.pd.region)?.name ?? '';

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** The networks grid: exactly the user's networks (existing ones carry their id, and are attached to, not built). */
function networksGrid(ctx     , networks                          )         {
  return grid(networks.map((n) => [
    n.name,
    n.envs.join(' '),
    n.cidr,
    n.ipv6 ? (ctx.platform === 'azure' && n.ipv6Cidr ? n.ipv6Cidr : 'yes') : 'no',
    n.role ?? 'spoke',
    n.existingId ?? '',
  ]));
}

/** The subnets grid: exactly the user's subnets, nothing added. */
function subnetsGrid(networks                          )         {
  return grid(networks.filter((n) => !n.existingId).flatMap((n) => n.subnets.map((s) => [
    n.name, s.name, s.tier, s.zone || 'regional', s.cidr, s.ipv6 ? 'yes' : 'no',
  ])));
}

/** The compute grid's image key. */
function imageKey(t               )         {
  if (t.image.kind === 'replicated') return 'replicated';
  if (t.image.kind === 'custom') return `var:${t.image.variable}`;
  const { note: _n, ...rest } = t.image                                              ;
  return renderImageRef(rest                );
}

function methodOf(ctx     , t               )                          {
  if (t.method) return t.method;
  if (t.image.kind === 'replicated') return 'replicate';
  return ctx.decision.items[t.workload]?.method === 'replicate' ? 'replicate' : 'rebuild';
}

/** The compute grid's zone letter: the AZ's own letter on AWS (its subnets are zonal), else the zone's place in the region. */
function zoneLetter(ctx     , t               )         {
  if (ctx.platform === 'aws' && t.zone) return t.zone.slice(-1).toLowerCase();
  const n = ctx.pd.networks.find((x) => x.name === t.network);
  const i = n ? networkZones(n).indexOf(t.zone) : -1;
  return ZONE_LETTERS[i >= 0 && i < 3 ? i : 0] ?? 'a';
}

function diskCell(ctx     , d                               )         {
  const type = ctx.platform === 'oci' ? (d.type === 'higher-performance' ? 'higher' : d.type) : d.type;
  return `${type}:${d.gib}`;
}

function sizeCell(ctx     , t               )         {
  if (ctx.platform === 'oci' && /\.Flex$/i.test(t.size)) {
    return `${t.size}:${t.ocpus ?? Math.max(1, Math.ceil(t.vcpu / 2))}:${t.ramGib}`;
  }
  return t.size;
}

function waveOf(ctx     , w                      )         {
  const wave = w ? ctx.appByName.get(w.app)?.wave : undefined;
  return wave === undefined ? '' : String(wave);
}

function computeRows(ctx     , rows                          )         {
  return grid(rows.map((t) => {
    const w = ctx.workloadById.get(t.workload);
    const name = computeRowName(ctx.platform, w?.name ?? t.workload);
    return [
      name,
      w?.os ?? 'unknown',
      imageKey(t),
      sizeCell(ctx, t),
      (ctx.platform === 'aws' || ctx.platform === 'google') && t.coreCount !== undefined ? String(t.coreCount) : '',
      t.disks.map((d) => diskCell(ctx, d)).join(' '),
      t.network,
      t.tier,
      zoneLetter(ctx, t),
      licenceKeyOf(t, ctx.platform),
      t.backupTier,
      methodOf(ctx, t),
      w?.app ?? '',
      ctx.dbEngineOfHost.get(t.workload) ?? w?.role ?? '',
      w?.env ?? '',
      waveOf(ctx, w),
      (w && ctx.componentOf.get(w.name)) ?? '',
    ];
  }));
}

/** The vSphere grid: rebuilt rows cloned from templates (replicated and relocated VMs arrive through HCX). */
function vsphereRows(ctx     , rows                          )         {
  return grid(rows.map((t) => {
    const w = ctx.workloadById.get(t.workload);
    return [
      w?.name ?? t.workload,
      w?.os ?? 'unknown',
      t.image.kind === 'vsphere-template' ? t.image.template : t.image.kind === 'custom' ? t.image.variable : '',
      String(t.vcpu),
      String(t.ramGib),
      t.disks.map((d) => String(d.gib)).join(' '),
      portGroup(ctx, t.network, t.tier),
      '',
      '',
      '',
      waveOf(ctx, w),
    ];
  }));
}

/** The NSX segment (port group) a VCF VM attaches to: the user's subnet of its tier in its network. */
const portGroup = (ctx     , network        , tier        )         =>
  ctx.pd.networks.find((n) => n.name === network)?.subnets.find((s) => s.tier === tier)?.name ?? `${network}-${tier}`;

/** The engine cell per platform: the provider's own spelling where the blueprint wants it. */
function engineCell(ctx     , t          , db                      )         {
  const engine = db?.engine ?? 'postgres';
  switch (ctx.platform) {
    case 'aws': {
      if (t.service === 'aws-aurora') return engine === 'mysql' ? 'aurora-mysql' : 'aurora-postgresql';
      if (engine === 'oracle') return db?.edition === 'oracle-se2' ? 'oracle-se2' : 'oracle-ee';
      if (engine === 'sqlserver') {
        return ({ 'sql-enterprise': 'sqlserver-ee', 'sql-web': 'sqlserver-web', 'sql-express': 'sqlserver-ex' }                          )[db?.edition ?? ''] ?? 'sqlserver-se';
      }
      return engine;
    }
    case 'google': {
      if (/^(POSTGRES|MYSQL|SQLSERVER)_/.test(t.engineVersion)) return t.engineVersion;
      const major = /(\d+)/.exec(db?.version ?? '')?.[1] ?? '16';
      if (engine === 'mysql') return `MYSQL_${(/(\d+\.\d+)/.exec(db?.version ?? '')?.[1] ?? '8.0').replace('.', '_')}`;
      return `POSTGRES_${major}`;
    }
    default:
      return engine;
  }
}

function editionCell(ctx     , t          , db                      )         {
  if (ctx.platform === 'google') return 'enterprise';
  if (ctx.platform === 'oci') {
    if (db?.engine !== 'oracle') return '';
    if (t.ha === 'rac') return 'extreme-performance';
    return db.edition === 'oracle-se2' ? 'standard' : 'enterprise';
  }
  return db?.edition ?? '';
}

function versionCell(ctx     , t          , db                      )         {
  const id = db?.version ?? '';
  if (ctx.platform === 'azure' && (t.service === 'azure-sqldb' || t.service === 'azure-sqlmi' || t.service === 'azure-sqlvm')) return /(\d{4})/.exec(id)?.[1] ?? '';
  if (ctx.platform === 'google') return /(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? '';
  if (t.engineVersion) return t.engineVersion;
  return /(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? '';
}

/**
 * The Class cell: the design's `classOrShape` in the form the blueprint
 * reads. `ECPU-<n>` is written as `<n>`, `cpu-<n>` (AlloyDB) as is (the
 * blueprint takes the number), `Exadata.X11M` as `Exadata.X11M:<cores>` on
 * OCI; the rest (`BC_Gen5_8`, `VM.Standard.E5.Flex:<ocpus>`,
 * `PostgreSQL.VM.Standard.E5.Flex:<ocpus>`, `MySQL.<n>`, RDS classes, Cloud
 * SQL tiers, flexible-server SKUs) are already the blueprint's own.
 */
export function classCell(platform          , t                                            , db                         )         {
  const c = t.classOrShape.trim();
  const ecpu = /^ECPU-(\d+)$/i.exec(c);
  if (ecpu) return ecpu[1] ;
  if (platform === 'oci' && /^Exadata\./.test(c) && !c.includes(':')) return `${c}:${Math.max(4, Math.ceil((db?.vcpu ?? 8) / 2))}`;
  return c;
}

/** The HA cell: the grid's own values; a source pattern on IaaS reads as a standby. */
function haCell(ctx     , t          )         {
  if (HA_GRID.has(t.ha)) return t.ha;
  if (t.ha === 'rac') return ctx.platform === 'oci' ? 'regional' : 'standby';
  return t.ha === '' ? 'none' : 'standby';
}

function licenceCell(ctx     , t          )         {
  const m = t.licenceModel.toLowerCase();
  if (ctx.platform === 'azure') return /baseprice|ahub|ahb/.test(m) ? 'ahb' : 'li';
  return /bring|byol/.test(m) ? 'byol' : 'li';
}

function retentionOf(ctx     , tier        )         {
  return String(ctx.pd.backup.tiers.find((b) => b.tier === tier)?.retentionDays ?? 7);
}

/** Services that go to the Oracle Database@ blueprint instead of the databases grid. */
function toOracleAt(t          )          {
  if (t.service === 'aws-odb-exadata' || t.service === 'aws-odb-adb' || t.service === 'azure-odb-exadata' || t.service === 'azure-odb-adb') return true;
  if (t.service === 'google-odb-exadata' || t.service === 'google-odb-adb') return true;
  // RAC is never a databases-grid row off OCI: a RAC Base Database on Google Cloud becomes an Exadata VM cluster.
  return t.service === 'google-odb-basedb' && t.ha === 'rac';
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

function item(ctx     , key        , blueprintId        , label        , values                        )            {
  return { id: `${ctx.platform}:${key}`, blueprintId, label, values };
}

/** Add an item whose blueprint may not exist yet: only when the lookup has it, values limited to its inputs. */
function optional(ctx     , key        , blueprintId        , label        , values                        )                   {
  const bp = ctx.lookup(blueprintId);
  if (!bp) return null;
  return item(ctx, key, blueprintId, label, declared(bp, values));
}

/** The landing zone of one region: exactly the user's networks and subnets there; none, no item. */
function landingZoneItem(ctx     , pd                )                   {
  const here = pd.networks.filter((n) => !n.region || n.region === pd.region);
  if (ctx.platform === 'vmware' || here.filter((n) => !n.existingId).length === 0) return null;
  const values                         = {
    prefix: pd.prefix,
    region: pd.region,
    networks: networksGrid(ctx, here),
    subnets: subnetsGrid(here),
    site_cidrs: siteCidrs(ctx.plan).join(' '),
    bastion: pd.bastion,
    log_retention_days: String(pd.logRetentionDays),
    keys: ctx.plan.requirements.keys,
    scope: pd.scope ?? '',
  };
  return item(ctx, 'landing-zone', `${ctx.bp}_mig_landing_zone`, 'Landing zone', values);
}

/** The on-premises domain controllers' addresses (the plan's ad-dc rows), which DNS forwarding sends the domain to. */
function onPremDcAddresses(plan      )           {
  const out = plan.workloads.filter((w) => w.role === 'ad-dc').flatMap((w) => w.facts?.ipAddresses ?? []).filter((a) => familyOf(a) !== null);
  return [...new Set(out)];
}

function identityItem(ctx     )                   {
  const { platform, pd, plan } = ctx;
  if (platform === 'vmware' || platform === 'oci') return null;
  const strategy = pd.identity.strategy;
  if (strategy === 'none') return null;
  const domain = plan.requirements.identity.domain?.trim() || 'corp.example.com';
  const values                         = { domain, network: hubName(ctx), landing_zone_source: lzSource(ctx) };
  if (strategy === 'managed-ad') {
    values.strategy = 'managed-ad';
    if (platform === 'aws' || platform === 'azure') values.edition = 'Enterprise';
    if (platform === 'google') {
      const range = userRange(ctx, 'managed-ad', 'Managed Service for Microsoft AD (a /24)');
      if (range) values.reserved_ip_range = range;
    }
  } else {
    const dcs = onPremDcAddresses(plan);
    if (dcs.length === 0) {
      ctx.findings.push(warning('plan.tf.identity-no-dc-addresses', `${PLATFORM_LABELS[platform]}: DNS forwarding to the domain controllers needs their addresses, and no ad-dc workload has one, so the identity item is left out.`, {
        remediation: 'Give the domain controllers\' addresses in the inventory (or add the Identity item on the Terraform page with them).',
      }));
      return null;
    }
    values.strategy = 'resolver-only';
    values.dns_forwarders = dcs.join(' ');
  }
  return item(ctx, 'identity', `${ctx.bp}_mig_identity`, 'Identity', values);
}

function connectivityItem(ctx     )                   {
  const { platform, pd, plan } = ctx;
  if (platform === 'vmware' || pd.connectivity.length === 0) return null;
  const existingHub = pd.networks.find((n) => n.existingId && n.role === 'hub');
  if (existingHub) {
    ctx.findings.push(info('plan.tf.connectivity-existing-hub', `${PLATFORM_LABELS[platform]}: the existing landing zone's hub (${existingHub.name}, ${existingHub.existingId}) carries the link to the data centre, so no connectivity is built here.`));
    return null;
  }
  const rows = pd.connectivity.map((c) => {
    const site = plan.requirements.sites.find((s) => s.name === c.site);
    return [c.site, site?.vpnPeer ?? '', site?.bgpAsn ?? '', (site?.cidrs ?? []).join(' '), c.method, ''];
  });
  const values                         = {
    sites: grid(rows),
    cloud_asn: String(pd.connectivity[0]?.cloudAsn ?? ''),
    landing_zone_source: lzSource(ctx),
  };
  if (platform === 'aws') values.gateway = builtIn(pd.networks, pd.region).length >= 2 ? 'transit-gateway' : 'vpn-gateway';
  if (platform === 'azure' || platform === 'google') values.network = hubName(ctx);
  return item(ctx, 'connectivity', `${ctx.bp}_mig_connectivity`, 'Connectivity', values);
}

function governanceItem(ctx     )                   {
  const req = ctx.plan.requirements;
  return optional(ctx, 'governance', `${ctx.bp}_mig_governance`, 'Governance', {
    prefix: ctx.pd.prefix,
    region: ctx.pd.region,
    frameworks: req.frameworks.join(' '),
    security_baseline: req.securityBaseline,
    keys: req.keys,
    sovereignty: req.sovereignty,
    residency: req.defaultResidency,
    landing_zone_source: lzSource(ctx),
  });
}

function computeItem(ctx     )                   {
  const { platform } = ctx;
  if (platform === 'vmware') {
    const rebuild = ctx.compute.filter((t) => methodOf(ctx, t) === 'rebuild');
    const replicated = ctx.compute.filter((t) => methodOf(ctx, t) === 'replicate');
    if (replicated.length > 0) {
      ctx.manual.push(`Replicated into VCF (HCX or vSphere Replication, not Terraform): ${replicated.map((t) => ctx.workloadById.get(t.workload)?.name ?? t.workload).join(', ')}.`);
    }
    if (rebuild.length === 0) return null;
    const o = (field        )                     => ctx.plan.designOverrides[overrideKey('vmware', 'lz', field)]?.trim() || undefined;
    const values                         = {
      vms: vsphereRows(ctx, rebuild),
      domain: ctx.plan.requirements.identity.domain?.trim() || 'corp.example.com',
      dns_servers: onPremDcAddresses(ctx.plan).join(' '),
    };
    const server = ctx.pd.region.trim();
    if (server) values.vsphere_server = server;
    for (const [field, id] of [['datacenter', 'datacenter'], ['cluster', 'cluster'], ['folder', 'folder']]         ) {
      const v = o(field);
      if (v) values[id] = v;
    }
    const datastore = o('datastore');
    const policy = o('storage-policy');
    if (datastore) values.datastore_or_policy = policy ? `${datastore} policy:${policy}` : datastore;
    if (!o('datacenter') || !o('cluster') || !datastore) {
      ctx.findings.push(warning('plan.tf.vsphere-placement', 'VCF: the datacenter, cluster or datastore is not set on the landing-zone card, so the VMs item uses its defaults; set them before applying.', {
        path: overrideKey('vmware', 'lz', 'datacenter'),
      }));
    }
    const groups = [...new Set(rebuild.map((t) => portGroup(ctx, t.network, t.tier)))];
    ctx.manual.push(`The port groups (or NSX segments) the VMs attach to must exist before apply: ${groups.join(', ')}. Build them with the Tier-1 gateway + overlay segments blueprint on the Terraform page, or name existing ones in the VMs grid.`);
    return item(ctx, 'compute', 'vsphere_mig_vms', 'VMs', values);
  }
  if (ctx.compute.length === 0) return null;
  for (const t of ctx.compute) {
    const name = ctx.workloadById.get(t.workload)?.name ?? t.workload;
    if (platform === 'google' && computeRowName(platform, name) !== name) {
      ctx.findings.push(info('plan.tf.google-vm-name', `${name} is written as ${computeRowName(platform, name)}: a Compute Engine name is lowercase letters, digits and hyphens.`));
    }
  }
  return item(ctx, 'compute', `${ctx.bp}_mig_compute`, 'Compute', { vms: computeRows(ctx, ctx.compute), plan_id: planTag(ctx.plan), landing_zone_source: lzSource(ctx) });
}

/** The databases-grid rows (managed services, and SQL Server on Azure VMs). */
function databaseRows(ctx     )                        {
  const rows                        = [];
  for (const t of ctx.databases) {
    const db = ctx.dbById.get(t.database);
    const name = db?.name ?? t.database;
    if (toOracleAt(t)) continue;
    if (t.service in DB_SERVICES_EXTRA) {
      // Caches, document and search stores are not in the databases grid: their pattern item, or a resource component, builds them.
      ctx.findings.push(info('plan.tf.extra-db-service', `${name} (${t.service}) is not in the migration databases grid; its pattern item builds it, or add it as a resource component (Add any service).`));
      continue;
    }
    if (t.service === 'google-odb-basedb') {
      ctx.manual.push(`${name}: Base Database on Oracle Database@Google Cloud (google_oracle_database_db_system) is not in Terraform here; create it in the console or with gcloud oracle-database, on the ODB network, before the data move.`);
      continue;
    }
    if (t.service === 'azure-sqlvm') {
      // One row per host VM: the row's name is the compute row it registers.
      for (const h of t.hosts ?? []) {
        const host = ctx.workloadById.get(h)?.name ?? h;
        if (rname(host) !== host) {
          ctx.findings.push(warning('plan.tf.sqlvm-name', `${host}: the SQL Server VM row is keyed by the VM's name, which the databases grid lower-cases; rename the workload to lowercase letters, digits and hyphens.`));
        }
        rows.push([host, t.service, 'sqlserver', db?.edition ?? '', versionCell(ctx, t, db), '', t.storageGib, haCell(ctx, t), licenceCell(ctx, t), retentionOf(ctx, t.backupTier), dbNetwork(ctx, db), db?.app ?? '']);
      }
      if (t.ha !== 'none' && (t.hosts?.length ?? 0) > 1) {
        ctx.manual.push(`${name}: the SQL Server availability group and its listener across ${(t.hosts ?? []).map((h) => ctx.workloadById.get(h)?.name ?? h).join(', ')} are built by Ansible (the mssql_ag role, playbooks/32-sqlserver-ag.yml) with the vaulted domain credentials, not by Terraform.`);
      }
      continue;
    }
    if (isIaasService(t.service)) {
      if (t.ha === 'rac' && ctx.platform !== 'oci' && ctx.platform !== 'vmware') {
        ctx.findings.push(warning('plan.tf.rac-on-vms', `${name}: Oracle RAC does not run on ${CLOUD_NAME[ctx.platform]} VMs; move it to Oracle Database@${CLOUD_NAME[ctx.platform]} (Exadata) or run it as a single instance with Data Guard.`));
      }
      continue;
    }
    if (t.service === 'azure-sqlmi' && ctx.pd.drRegion) {
      ctx.manual.push(`${name}: the SQL Managed Instance failover group to ${ctx.pd.drRegion} is not in Terraform here; create the secondary instance there and the failover group (az sql instance-failover-group create) once both exist.`);
    }
    rows.push([
      name, t.service, engineCell(ctx, t, db), editionCell(ctx, t, db), versionCell(ctx, t, db), classCell(ctx.platform, t, db),
      t.storageGib, haCell(ctx, t), licenceCell(ctx, t), retentionOf(ctx, t.backupTier), dbNetwork(ctx, db), db?.app ?? '',
    ]);
  }
  return rows;
}

function databasesItem(ctx     , rows                                )                   {
  if (ctx.platform === 'vmware' || rows.length === 0) return null;
  return item(ctx, 'databases', `${ctx.bp}_mig_databases`, 'Databases', { databases: grid(rows), landing_zone_source: lzSource(ctx) });
}

function oracleAtItem(ctx     )                   {
  const { platform } = ctx;
  if (platform !== 'aws' && platform !== 'azure' && platform !== 'google') return null;
  const targets = ctx.databases.filter(toOracleAt);
  if (targets.length === 0) return null;
  const dbs = targets.map((t) => ({ t, db: ctx.dbById.get(t.database) }));
  const exadata = dbs.filter(({ t }) => !t.service.endsWith('-adb'));
  const shape = dbs.map(({ t }) => t.classOrShape).find((c) => /^Exadata\./.test(c)) ?? 'Exadata.X11M';
  const cores = exadata.reduce((s, { db }) => s + Math.max(2, Math.ceil((db?.vcpu ?? 8) / 2)), 0);
  const values                         = {
    exadata_shape: shape,
    compute_count: '2',
    storage_count: '3',
    vm_cluster_cores: String(Math.max(4, Math.ceil(cores / 2) * 2)),
    databases: exadata.map(({ t, db }) => rname(db?.name ?? t.database)).join(' '),
    create_databases: exadata.length > 0 ? 'yes' : 'no',
    licence: dbs.some(({ t }) => /BRING/.test(t.licenceModel)) ? 'BRING_YOUR_OWN_LICENSE' : 'LICENSE_INCLUDED',
    network: dbNetwork(ctx, dbs[0]?.db),
    landing_zone_source: lzSource(ctx),
  };
  const ociRegion = ctx.plan.requirements.regions.oci?.primary?.trim();
  if (ociRegion) values.oci_region_name = ociRegion;
  else {
    ctx.findings.push(info('plan.tf.odb-oci-region', `Oracle Database@${CLOUD_NAME[platform]}: the OCI region paired with ${ctx.pd.region} is not set, so the item's default is used; set it before applying.`));
  }
  if (platform !== 'azure') {
    const cidr = userRange(ctx, 'odb', `the Oracle Database@${CLOUD_NAME[platform]} ODB network`);
    if (cidr) values.odb_network_cidr = cidr;
  }
  if (platform === 'aws') {
    ctx.findings.push(info('plan.tf.odb-zone-id', `Oracle Database@AWS: check that the availability zone id in the item is one where it is offered in ${ctx.pd.region}.`));
  }
  const label = platform === 'aws' ? 'Oracle Database@AWS' : platform === 'azure' ? 'Oracle Database@Azure' : 'Oracle Database@Google Cloud';
  return item(ctx, 'oracle-database-at', `${ctx.bp}_mig_oracle_database`, label, values);
}

function backupGrid(ctx     )         {
  return grid(ctx.pd.backup.tiers.map((t) => [t.tier, t.frequency, String(t.retentionDays), t.copyToDr ? 'yes' : 'no', t.immutable ? 'yes' : 'no']));
}

function backupItem(ctx     , hasCompute         , hasDatabases         )                   {
  const { platform } = ctx;
  if (platform === 'vmware' || ctx.pd.backup.tiers.length === 0) return null;
  const id = `${ctx.bp}_mig_backup`;
  const bp = ctx.lookup(id);
  const scoped = !!bp?.inputs.some((i) => i.id === 'scope');
  if (ctx.scope === 'landing-zone') {
    // Azure, Google Cloud and OCI back up the compute blueprint's VMs, so without them only a scoped backup item stands.
    if (!scoped && platform !== 'aws') return null;
  } else if (platform === 'aws' ? !hasCompute && !hasDatabases : !hasCompute) {
    return null;
  }
  const values                         = { tiers: backupGrid(ctx), dr_region: ctx.pd.drRegion ?? '', landing_zone_source: lzSource(ctx) };
  if (scoped) values.scope = ctx.scope === 'landing-zone' ? 'landing-zone' : ctx.shared ? 'workloads' : 'landing-zone';
  return item(ctx, 'backup', id, 'Backup', values);
}

function monitoringItem(ctx     , hasCompute         )                   {
  if (ctx.platform === 'vmware' || !hasCompute || ctx.plan.requirements.monitoring === 'vcf-operations') return null;
  return item(ctx, 'monitoring', `${ctx.bp}_mig_monitoring`, 'Monitoring', {
    siem: ctx.plan.requirements.siem,
    retention_days: String(ctx.pd.logRetentionDays),
    landing_zone_source: lzSource(ctx),
  });
}

const RELOCATE_BLUEPRINT                                                                                     = {
  azure: { id: 'azure_mig_avs', label: 'Azure VMware Solution', prefix: 22 },
  google: { id: 'google_mig_gcve', label: 'Google Cloud VMware Engine', prefix: 22 },
  oci: { id: 'oci_mig_ocvs', label: 'Oracle Cloud VMware Solution', prefix: 21 },
};

function relocateItem(ctx     )                   {
  const { platform, pd } = ctx;
  if (!pd.relocate || pd.relocate.nodes <= 0) return null;
  if (platform === 'aws') {
    ctx.manual.push(`Amazon Elastic VMware Service (${pd.relocate.nodes} hosts, estimated): there is no Terraform resource for it in the AWS provider used here, so the environment is built from the runbook, then HCX moves the relocating VMs.`);
    return null;
  }
  const r = RELOCATE_BLUEPRINT[platform];
  if (!r) return null;
  const bp = ctx.lookup(r.id);
  const host = RELOCATE_HOSTS[platform].host.toLowerCase();
  const sku = bp?.inputs.find((i) => i.id === 'sku_name')?.options?.find((o) => o.value.toLowerCase() === host)?.value;
  const nodes = Math.min(16, Math.max(3, pd.relocate.nodes));
  if (nodes !== pd.relocate.nodes) {
    ctx.findings.push(info('plan.tf.relocate-nodes', `${pd.relocate.service}: the estimate of ${pd.relocate.nodes} hosts is written as ${nodes}, the range the first cluster takes; size it properly on the VCF Sizing page.`));
  }
  const values                         = {
    ...(sku ? { sku_name: sku } : {}),
    node_count: String(nodes),
    network: hubName(ctx),
    landing_zone_source: lzSource(ctx),
  };
  const cidr = userRange(ctx, 'relocate', `${pd.relocate.service}'s management range (a /${r.prefix})`);
  if (cidr) values.management_cidr = cidr;
  if (platform === 'oci') {
    values.workload_hosts = '0';
    if (ctx.plan.requirements.licensing.portableVcf) {
      ctx.findings.push(info('plan.tf.ocvs-byol', 'OCVS with portable VCF: give the subscription allocation OCID in the relocate item (vcf_byol_allocation_id).'));
    }
  }
  return item(ctx, 'relocate', r.id, r.label, values);
}

function replicationItem(ctx     , rows        )                   {
  const replicated = ctx.compute.filter((t) => methodOf(ctx, t) === 'replicate');
  // A new service's database has no data to carry over, so no DMS.
  const managed = ctx.databases.filter((t) => !isIaasService(t.service) && ctx.decision.items[t.database]?.method === 'managed-db'
    && ctx.decision.items[t.database]?.disposition !== 'new');
  if (replicated.length === 0 && managed.length === 0) return null;
  return optional(ctx, 'replication', `${ctx.bp}_mig_replication`, 'Replication', {
    vms: computeRows(ctx, replicated),
    databases: rows,
    region: ctx.pd.region,
    dr_region: ctx.pd.drRegion ?? '',
    plan_id: planTag(ctx.plan),
    landing_zone_source: lzSource(ctx),
  });
}

/** The apps whose app items go in this platform's stack, with their components. */
function appsHere(ctx     , options                     )                                                          {
  if (ctx.scope === 'landing-zone') return [];
  const wanted = options.apps && options.apps.length > 0 ? new Set(options.apps) : null;
  const plans = new Map(appPlansOf(ctx.plan).map((p) => [p.app, p]));
  const out                                                          = [];
  for (const app of ctx.plan.apps) {
    if (wanted && !wanted.has(app.id) && !wanted.has(app.name)) continue;
    const ap = plans.get(app.id);
    const platform = ap?.platform ?? ap?.recommendation?.platform;
    const leftOut = new Set(ap?.leftOut?.[ctx.platform] ?? []);
    const components = (ap && platform === ctx.platform ? (ap.variants?.[ctx.platform] ?? []) : []).filter((c) => {
      if (leftOut.has(c.id)) return false;
      if (c.status === 'unresolved') {
        ctx.findings.push(error('plan.tf.component-unresolved', `${app.name}: the ${c.name} component has no equivalent on ${PLATFORM_LABELS[ctx.platform]}, so it is not generated; replace it or leave it out.`, { path: c.id }));
        return false;
      }
      return true;
    });
    if (ctx.scope === 'estate') {
      // The estate stack carries an app's own items only once its plan is saved.
      if (!ap || ap.status === 'draft' || platform !== ctx.platform || components.length === 0) continue;
      out.push({ app, components });
      continue;
    }
    // apps scope: every selected app with something on this platform.
    const here = ctx.compute.some((t) => ctx.workloadById.get(t.workload)?.app === app.name)
      || ctx.databases.some((t) => ctx.dbById.get(t.database)?.app === app.name)
      || components.length > 0;
    if (here) out.push({ app, components });
  }
  return out;
}

function defaultPatternBlueprint(bp        )                                              {
  return (c) => c.settings?.blueprint?.trim() || (c.tierPattern ? `${bp}_app_${c.tierPattern.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}` : undefined);
}

/** Tier patterns with no pattern item of their own. */
const GRID_CARRIED                      = new Set(['vm', 'managed-db', 'vmware-service', 'retire', 'retain', 'saas', 'specialist']);

function appItems(ctx     , options                     )                                                 {
  const head              = [];
  const monitoring              = [];
  const patternId = options.patternBlueprint ? (c                  ) => options.patternBlueprint (c, ctx.platform) : defaultPatternBlueprint(ctx.bp);
  for (const { app, components } of appsHere(ctx, options)) {
    const slug = slugName(app.name) || app.id;
    const common = { app: app.name, criticality: app.criticality, owner: app.owner ?? '', landing_zone_source: lzSource(ctx) };
    const context = optional(ctx, `app:${slug}:context`, `${ctx.bp}_app_context`, `${app.name} context`, common);
    if (context) head.push(context);
    for (const c of components.filter((x) => x.kind === 'pattern')) {
      // The compute and databases grids carry VMs and managed databases; retire / retain / SaaS / specialist build nothing here.
      if (!c.settings?.blueprint?.trim() && (!c.tierPattern || GRID_CARRIED.has(c.tierPattern))) continue;
      const id = patternId(c);
      const bp = id ? ctx.lookup(id) : undefined;
      if (!id || !bp) {
        ctx.findings.push(info('plan.tf.pattern-not-generated', `${app.name}: the ${c.name} component (${c.tierPattern ?? 'pattern'}) has no Terraform blueprint on ${PLATFORM_LABELS[ctx.platform]} yet, so it is not in the stack.`));
        continue;
      }
      head.push({ id: c.id, blueprintId: id, label: `${app.name} ${c.name}`, values: declared(bp, { ...(c.settings ?? {}), ...common, component: c.id }) });
    }
    for (const c of components.filter((x) => x.kind === 'resource')) {
      if (!c.blueprintId || !ctx.lookup(c.blueprintId)) {
        ctx.findings.push(error('plan.tf.resource-component-unknown', `${app.name}: the ${c.name} component's blueprint ${c.blueprintId ?? '(none)'} is not one the Terraform page has, so it is not in the stack.`));
        continue;
      }
      // In a shared stack the landing zone is var.landing_zone: a reference to the contract follows it.
      head.push({ id: c.id, blueprintId: c.blueprintId, label: `${app.name} ${c.name}`, values: ctx.shared ? toSharedReference(c.values ?? {}) : { ...(c.values ?? {}) } });
    }
    // The app's VMs are the compute item's rows in this stack; an app with none (PaaS, containers) watches no VMs.
    const hasVms = ctx.platform !== 'vmware' && ctx.compute.some((t) => ctx.workloadById.get(t.workload)?.app === app.name);
    const mon = optional(ctx, `app:${slug}:monitoring`, `${ctx.bp}_app_monitoring`, `${app.name} monitoring`, { ...common, vms_from: hasVms ? 'stack' : 'none' });
    if (mon) monitoring.push(mon);
  }
  return { head, monitoring };
}


/** Does a stack carry a write-only argument (Terraform 1.11)? Cloud SQL for SQL Server and AlloyDB passwords, Azure MySQL flexible server. */
export function needsWriteOnly(items                      )          {
  return items.some((i) => {
    const text = String(i.values.databases ?? '');
    if (i.blueprintId === 'google_mig_databases') return /\|\s*google-alloydb\s*\|/.test(text) || /\|\s*SQLSERVER_/i.test(text);
    if (i.blueprintId === 'azure_mig_databases') return /\|\s*azure-mysql-flex\s*\|/.test(text);
    return false;
  });
}

// ---------------------------------------------------------------------------
// The DR region
// ---------------------------------------------------------------------------

function drStack(ctx     , backend                              )                       {
  const { pd, platform, plan } = ctx;
  if (platform === 'vmware' || !pd.drRegion || ctx.scope === 'apps') return null;
  // Exactly the user's networks in the DR region: none, no DR stack (and a finding says so).
  const drNetworks = pd.networks.filter((n) => n.region === pd.drRegion);
  if (drNetworks.filter((n) => !n.existingId).length === 0) {
    ctx.findings.push(warning('plan.tf.dr-no-network', `${PLATFORM_LABELS[platform]}: the DR region ${pd.drRegion} has no network, so no DR landing zone is generated; add its networks and subnets on Landing zones.`, { path: `net:${platform}:` }));
    return null;
  }
  const drDesign                 = { ...pd, prefix: `${pd.prefix}-dr`, region: pd.drRegion, networks: drNetworks };
  const lz = landingZoneItem({ ...ctx, pd: drDesign }, drDesign);
  if (!lz) return null;
  return {
    platform,
    folder: `${platform}-dr`,
    items: [{ ...lz, id: `${platform}-dr:landing-zone` }],
    stackName: `${plan.name}: ${PLATFORM_LABELS[platform]} DR (${pd.drRegion})`,
    target: TARGET[platform],
    requiredVersion: REQUIRED_VERSION,
    backend,
    manual: [],
    dr: true,
  };
}

// ---------------------------------------------------------------------------
// planToStacks
// ---------------------------------------------------------------------------

/**
 * The stack items per platform in the design, and per DR region, with the
 * values the Terraform page would save for them. Nothing is built here.
 */
export function planToStacks(plan      , decision              , design              , options                      = {})             {
  const findings            = [];
  const perPlatform                                           = {};
  const dr                                           = {};
  const scope = options.scope ?? 'estate';
  if (options.landingZone === 'shared' && scope !== 'apps') {
    findings.push(info('plan.tf.shared-lz-scope', 'A shared landing zone applies to app stacks only; this stack carries its own.'));
  }
  const used           = [
    ...design.platforms.flatMap((p) => p.networks.map((n) => n.cidr)),
    ...plan.requirements.sites.flatMap((s) => s.cidrs),
  ];
  const ordered = PLATFORM_VALUES.flatMap((p) => design.platforms.filter((d) => d.platform === p));
  for (const pd of ordered) {
    const platform = pd.platform;
    if (builtIn(pd.networks, pd.region).length === 0 && !(scope === 'apps' && options.landingZone === 'shared')) {
      // No network defined for this cloud: nothing is generated for it.
      findings.push(noNetworkFinding(platform));
      continue;
    }
    const ctx = contextFor(plan, decision, design, pd, options, used, findings);
    const withLz = scope !== 'apps' || !ctx.shared;
    const withWorkloads = scope !== 'landing-zone';

    const identity = withLz ? identityItem(ctx) : null;
    const connectivity = withLz ? connectivityItem(ctx) : null;
    const governance = withLz && platform !== 'vmware' ? governanceItem(ctx) : null;
    const compute = withWorkloads ? computeItem(ctx) : null;
    const dbRows = withWorkloads ? databaseRows(ctx) : [];
    const databases = withWorkloads ? databasesItem(ctx, dbRows) : null;
    const oracleAt = withWorkloads ? oracleAtItem(ctx) : null;
    const app = withWorkloads ? appItems(ctx, options) : { head: [], monitoring: [] };
    const hasCompute = !!compute && platform !== 'vmware';
    const backup = backupItem(ctx, hasCompute, !!databases || !!oracleAt);
    const monitoring = withWorkloads ? monitoringItem(ctx, hasCompute) : null;
    const relocate = scope !== 'apps' ? relocateItem(ctx) : null;
    const replication = withWorkloads && platform !== 'vmware' ? replicationItem(ctx, grid(dbRows)) : null;
    if (scope === 'apps' && !compute && !databases && !oracleAt && app.head.length === 0 && app.monitoring.length === 0) {
      // Nothing of the selected apps lands here: no stack, not even a landing zone.
      continue;
    }
    const lz = withLz ? landingZoneItem(ctx, pd) : null;

    const items = [lz, identity, connectivity, governance, compute, databases, oracleAt, ...app.head, backup, monitoring, ...app.monitoring, relocate, replication]
      .filter((i)                 => i !== null);
    if (ctx.shared && items.length > 0 && LZ_VARIABLE_BLUEPRINTS.has(landingZoneVariableId(platform))
      && !items.some((i) => i.values.landing_zone_source === 'variables')) {
      // Nothing here declares var.landing_zone (only resource components, say): the contract item does.
      items.unshift(item(ctx, 'landing-zone-variable', landingZoneVariableId(platform), 'Landing zone (shared)', {}));
    }
    if (items.length === 0) {
      findings.push(info('plan.tf.empty-platform', `${PLATFORM_LABELS[platform]}: nothing in this plan is built by Terraform there, so there is no stack for it.`));
      continue;
    }
    const backend = backendFor(platform, plan.generate?.backend);
    if (ctx.shared) {
      ctx.manual.push(`This stack reads the landing zone of the landing-zone project: terraform -chdir=<landing-zone project>/terraform/${platform} output -json landing_zone | jq '{landing_zone: .}' > landing_zone.auto.tfvars.json`);
    }
    perPlatform[platform] = {
      platform,
      folder: platform,
      items,
      stackName: `${plan.name}: ${PLATFORM_LABELS[platform]}`,
      target: TARGET[platform],
      requiredVersion: needsWriteOnly(items) ? REQUIRED_VERSION_WRITE_ONLY : REQUIRED_VERSION,
      backend,
      manual: ctx.manual,
    };
    const d = drStack(ctx, backend);
    if (d) dr[platform] = d;
  }
  return { perPlatform, dr, findings };
}

// ---------------------------------------------------------------------------
// terraformFiles
// ---------------------------------------------------------------------------

/** The sensitive variables a stack declares: supplied as TF_VAR_<name>, never written. */
export function sensitiveVariables(variablesTf        )           {
  const out           = [];
  for (const m of variablesTf.matchAll(/variable "([^"]+)" \{([\s\S]*?)\n\}/g)) {
    if (/^\s*sensitive\s*=\s*true\s*$/m.test(m[2] ?? '')) out.push(m[1] );
  }
  return out;
}

const SIGN_IN                                     = {
  aws: 'AWS: a profile or SSO session (`aws sso login`), or the AWS_* environment variables.',
  azure: 'Azure: `az login` (or the ARM_* environment variables for a service principal or managed identity).',
  google: 'Google Cloud (GCP): `gcloud auth application-default login`, or a workload identity.',
  oci: 'OCI: an API key profile in ~/.oci/config, or instance / resource principal authentication.',
  vmware: 'VCF: TF_VAR_vsphere_user and TF_VAR_vsphere_password for the vCenter account.',
};

function readme(stack               , files                                  )         {
  const secrets = sensitiveVariables(files['variables.tf'] ?? '');
  const itemFiles = Object.keys(files).filter((f) => /^\d\d-.*\.tf$/.test(f)).sort();
  const compute = stack.items.some((i) => /_mig_compute$/.test(i.blueprintId));
  const lines = [
    `# ${stack.stackName}`,
    '',
    stack.dr
      ? `The landing zone in the DR region, as a root module of its own: what warm-standby and pilot-light recovery restore into, and where backup copies land. It applies as generated.`
      : `The Terraform root module for ${PLATFORM_LABELS[stack.platform]}, stacked from the migration plan. It applies as generated.`,
    '',
    '## What is in it',
    '',
    ...itemFiles.map((f, i) => `${i + 1}. \`${f}\` — ${stack.items[i]?.label ?? ''} (${stack.items[i]?.blueprintId ?? ''})`),
    '',
    '- `versions.tf`, `providers.tf`, `variables.tf`, `outputs.tf`: shared by every item.',
    ...(files['terraform.tfvars.example'] ? ['- `terraform.tfvars.example`: copy to `terraform.tfvars` and fill in the required values (no secrets go there).'] : []),
    '- `cutover.auto.tfvars.example`: the replicated VMs to adopt after cutover.',
    '- `archtoolkit-terraform-settings.json`: open it on the Terraform page to see and edit this same stack.',
    '',
    '## Before you apply',
    '',
    `- Sign in: ${SIGN_IN[stack.platform]}`,
    ...(stack.backend && stack.backend !== 'local' ? ['- State: `versions.tf` has a remote backend; fill in its CHANGE-ME values (or pass them with `terraform init -backend-config=...`).'] : []),
    ...(files['terraform.tfvars.example'] ? ['- Values: `cp terraform.tfvars.example terraform.tfvars` and fill it in.'] : []),
    '',
    '## Apply',
    '',
    '```sh',
    'terraform init',
    ...secrets.map((s) => `export TF_VAR_${s}="<from your vault>"`),
    'terraform apply',
    '```',
    '',
    ...(secrets.length > 0
      ? ['Credentials are never written into these files: each one above is a sensitive variable, read from your vault into the environment for the run.', '']
      : ['Credentials are never written into these files.', '']),
    ...(compute
      ? [
        '## After cutover',
        '',
        'Once the replication tool has launched the replicated VMs, list them in `cutover.auto.tfvars` (copy the example) — or let the cutover',
        'orchestrator write `cutover.auto.tfvars.json`, which Terraform loads the same way — and apply again:',
        '',
        '```sh',
        'terraform apply',
        '```',
        '',
        'The `import` blocks adopt them with their tags, size and backup tier. With the map empty, nothing is adopted and the apply is clean.',
        '',
      ]
      : []),
    ...(stack.manual.length > 0 ? ['## Not done by Terraform', '', ...stack.manual.map((m) => `- ${m}`), ''] : []),
  ];
  return `${lines.join('\n')}`;
}

function cutoverExample(stack               )         {
  const computeItem = stack.items.find((i) => /_mig_compute$/.test(i.blueprintId));
  if (!computeItem) {
    return `# ${stack.dr ? 'The DR landing zone' : 'This stack'} builds no VMs, so there is nothing to adopt after cutover.\n`;
  }
  const replicated = String(computeItem.values.vms ?? '')
    .split('\n')
    .map((l) => l.split(' | '))
    .filter((c) => (c[11] ?? '').trim() === 'replicate')
    .map((c) => (c[0] ?? '').trim());
  return [
    '# Replicated VMs to adopt after cutover: the name in the compute grid = the id the replication tool launched it as.',
    '# Copy to cutover.auto.tfvars (or let the cutover orchestrator write cutover.auto.tfvars.json), then terraform apply.',
    'cutover_instance_ids = {',
    ...(replicated.length > 0 ? replicated.map((n) => `  # "${n}" = ""`) : ['  # none: every VM in this stack is rebuilt']),
    '}',
    '',
  ].join('\n');
}

/** The Terraform page's envelope for a stack. `savedAt` is the plan's, so the file is reproducible. */
export function stackEnvelope(plan      , stack               )                        {
  const first = stack.items[0];
  const body = {
    target: stack.target                                       ,
    blueprint: first?.blueprintId ?? '',
    values: { ...((first?.values ?? {})                          ) },
    stackName: stack.stackName,
    stack: stack.items.map((i) => ({ id: i.id, blueprintId: i.blueprintId, label: i.label, values: { ...(i.values                          ) } })),
    requiredVersion: stack.requiredVersion,
    ...(stack.backend ? { backend: stack.backend } : {}),
  };
  return { ...envelope('archtoolkit.terraform-generator', body                                   ), savedAt: plan.savedAt }                                    ;
}

/** Build one stack into its files, under `terraform/<folder>/`. */
function stackFiles(plan      , stack               , lookup                 , findings           )                                                          {
  let s = stack;
  let built = buildStack(s.items, lookup, { target: s.target, stackName: s.stackName, requiredVersion: s.requiredVersion, ...(s.backend ? { backend: s.backend } : {}) });
  const writeOnly = Object.entries(built.files).some(([f, t]) => f.endsWith('.tf') && /^\s*\w+_wo\s*=/m.test(t));
  if (writeOnly && s.requiredVersion !== REQUIRED_VERSION_WRITE_ONLY) {
    s = { ...s, requiredVersion: REQUIRED_VERSION_WRITE_ONLY };
    built = buildStack(s.items, lookup, { target: s.target, stackName: s.stackName, requiredVersion: s.requiredVersion, ...(s.backend ? { backend: s.backend } : {}) });
  }
  const dir = `terraform/${s.folder}`;
  for (const f of built.findings) {
    if (f.code === 'tf.stack.empty') continue;
    findings.push({ ...f, path: f.path ? `${dir}/${f.path}` : dir });
  }
  const files                         = {};
  for (const [name, text] of Object.entries(built.files)) {
    if (name === 'README.md') continue;
    files[`${dir}/${name}`] = text;
  }
  files[`${dir}/README.md`] = readme(s, built.files);
  files[`${dir}/cutover.auto.tfvars.example`] = cutoverExample(s);
  files[`${dir}/archtoolkit-terraform-settings.json`] = writeSettings(stackEnvelope(plan, s)                   , 'json');
  return { files, stack: s };
}

/**
 * Every platform's Terraform: `terraform/<p>/` (and `terraform/<p>-dr/` where
 * a DR region is set), the findings, and the envelopes the Terraform page
 * opens (the handoffs).
 */
export function terraformFiles(
  plan      ,
  decision              ,
  design              ,
  options                      = {},
)                                                                                                               {
  const stacks = planToStacks(plan, decision, design, options);
  const lookup = withPlanBlueprints(options.lookup ?? findTerraformBlueprint);
  const findings            = [...stacks.findings];
  const files                         = {};
  const envelopes                                                       = {};
  for (const platform of PLATFORM_VALUES) {
    const stack = stacks.perPlatform[platform];
    if (stack) {
      const out = stackFiles(plan, stack, lookup, findings);
      Object.assign(files, out.files);
      envelopes[platform] = stackEnvelope(plan, out.stack);
    }
    const d = stacks.dr[platform];
    if (d) Object.assign(files, stackFiles(plan, d, lookup, findings).files);
  }
  return { files, findings, envelopes };
}
