/**
 * What the provider-native generators (CloudFormation, Bicep) share: which
 * parts of a platform's design are in scope, the tags every resource carries,
 * the rules every tier's firewall follows, and the bookkeeping of what stays
 * in Terraform only.
 *
 * The scope follows `planToStacks` (./../terraform.ts) exactly, so the native
 * templates and the Terraform stack build the same workloads, databases and
 * app items from the same design:
 *
 *   estate        everything: the landing zone, identity, connectivity, the
 *                 compute and database targets, the saved app plans' items,
 *                 backup and monitoring;
 *   landing-zone  the foundation only;
 *   apps          the selected apps' workloads, databases and app items, in
 *                 a landing zone of their own.
 *
 * A synthetic workload of a new app whose component is not a VM is built by
 * its pattern item, never as a VM; the source host of a database that moves
 * to a managed service is not rebuilt anywhere.
 */

import { info,              } from '../../../../core/findings.js';
import { familyOf } from '../../../../core/ip.js';
import { planTagValue } from '../../../../terraform/blueprints/migration/common.js';
import { designWorkloads, isIaasService, licenceKeyOf, siteCidrs } from '../../design/index.js';
import { networkZones } from '../../design/network.js';
import { builtIn, envClassOf, hubOf } from '../../design/net-rows.js';
import { PLATFORM_LABELS, slugName } from '../../options.js';
             
                                                                                                                                               
                        
import { componentOfServers,                                         } from '../terraform.js';

// ---------------------------------------------------------------------------
// Options and results
// ---------------------------------------------------------------------------

                                                             

                                
                                            
                                    
                                                                                   
                               
                                                                      
                             
 

                              
                     
                                         
                               
 

/** A part of the design the native template leaves to Terraform, and why. */
                                
                        
                          
 

// ---------------------------------------------------------------------------
// The context of one platform
// ---------------------------------------------------------------------------

                          
                    
                                                                              
                                                   
                                
                                      
 

                            
                      
                                  
                                
                              
                              
                              
                                    
                                  
                                                       
                                                 
                                               
                                                               
                                             
                                                                                    
                                                
                                   
                                          
                                                                          
                                                       
                                                     
                                                    
                                    
                               
                                          
 

const appPlansOf = (plan      )                         => (plan                                                         ).appPlans ?? [];

function inScopeWorkload(w                      , options               , apps                            )          {
  if (!w) return true;
  if (options.environment && w.env !== options.environment) return false;
  if (apps && !apps.has(w.app) && !apps.has(slugName(w.app))) return false;
  return true;
}

/** Workload names standing for a new app's component that is not a VM (its pattern item builds it). */
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

/** The method a compute target arrives by. */
export function methodOf(decision              , t               )                          {
  if (t.method) return t.method;
  if (t.image.kind === 'replicated') return 'replicate';
  return decision.items[t.workload]?.method === 'replicate' ? 'replicate' : 'rebuild';
}

/**
 * The part of one platform's design in scope, or null when an `apps` scope
 * has nothing on this platform (no template for it at all).
 */
export function nativeContext(plan      , decision              , design              , pd                , options               )                   {
  const platform = pd.platform;
  const scope = options.scope ?? 'estate';
  const findings            = [];
  const workloads = [...designWorkloads(plan, design), ...(pd.added ?? [])];
  const workloadById = new Map(workloads.map((w) => [w.id, w]));
  const dbById = new Map(plan.databases.map((d) => [d.id, d]));
  const appByName = new Map(plan.apps.map((a) => [a.name, a]));
  const wanted = options.apps && options.apps.length > 0
    ? new Set(options.apps.flatMap((a) => {
      const app = plan.apps.find((x) => x.id === a || x.name === a);
      return app ? [app.name, slugName(app.name)] : [a, slugName(a)];
    }))
    : null;
  const withWorkloads = scope !== 'landing-zone';

  const rebuilt                  = [];
  const replicated                  = [];
  const services = syntheticServices(plan, platform);
  if (withWorkloads) {
    for (const c of pd.compute) {
      const w = workloadById.get(c.workload);
      if (w && services.has(w.name)) continue;
      if (decision.items[c.workload]?.method === 'managed-db') continue;
      if (!inScopeWorkload(w, options, wanted)) continue;
      (methodOf(decision, c) === 'replicate' ? replicated : rebuilt).push(c);
    }
  }
  const inCompute = new Set([...rebuilt, ...replicated].map((c) => c.workload));
  const databases = withWorkloads
    ? pd.databases.filter((d) => {
      const db = dbById.get(d.database);
      if (wanted && db && !wanted.has(db.app) && !wanted.has(slugName(db.app))) return false;
      if (options.environment) {
        const host = db?.hosts.map((h) => workloads.find((w) => w.name === h)).find(Boolean);
        if ((host?.env ?? 'prod') !== options.environment) return false;
      }
      if (isIaasService(d.service) && d.hosts && d.hosts.length > 0 && !d.hosts.some((h) => inCompute.has(h))) return false;
      return true;
    })
    : [];
  const dbEngineOfHost = new Map                ();
  for (const d of databases) {
    if (!isIaasService(d.service)) continue;
    const engine = dbById.get(d.database)?.engine;
    if (engine) for (const h of d.hosts ?? []) dbEngineOfHost.set(h, engine);
  }

  // The apps whose app items go here (as `appsHere` in the Terraform composition).
  const apps            = [];
  if (withWorkloads) {
    const plans = new Map(appPlansOf(plan).map((p) => [p.app, p]));
    for (const app of plan.apps) {
      if (options.apps && options.apps.length > 0 && !options.apps.includes(app.id) && !options.apps.includes(app.name)) continue;
      const ap = plans.get(app.id)                                                                                                      ;
      const chosen = ap?.platform ?? ap?.recommendation?.platform;
      const leftOut = new Set(ap?.leftOut?.[platform] ?? []);
      const components = (ap && chosen === platform ? (ap.variants?.[platform] ?? []) : []).filter((c) => {
        if (leftOut.has(c.id)) return false;
        if (c.status === 'unresolved') {
          findings.push(info('plan.native.component-unresolved', `${app.name}: the ${c.name} component has no equivalent on ${PLATFORM_LABELS[platform]}, so it is not generated.`, { path: c.id }));
          return false;
        }
        return true;
      });
      const here = (x         )       => {
        apps.push(x);
      };
      const entry          = { app, components, ...(ap?.ingress ? { ingress: ap.ingress } : {}), ...(ap?.origin ? { origin: ap.origin } : {}) };
      if (scope === 'estate') {
        if (!ap || ap.status === 'draft' || chosen !== platform || components.length === 0) continue;
        here(entry);
        continue;
      }
      const has = [...rebuilt, ...replicated].some((t) => workloadById.get(t.workload)?.app === app.name)
        || databases.some((t) => dbById.get(t.database)?.app === app.name)
        || components.length > 0;
      if (has) here(entry);
    }
  }
  if (scope === 'apps' && rebuilt.length === 0 && replicated.length === 0 && databases.length === 0 && apps.length === 0) return null;
  return {
    plan, decision, design, pd, platform, scope,
    withLandingZone: true,
    withWorkloads,
    workloadById, dbById, appByName,
    rebuilt, replicated, databases, dbEngineOfHost,
    componentOf: componentOfServers(plan),
    apps,
    findings,
    terraformOnly: [],
  };
}

/** Record a part of the design this template does not build, with the reason; once per `what`. */
export function terraformOnly(ctx           , what        , reason        )       {
  if (ctx.terraformOnly.some((t) => t.what === what)) return;
  ctx.terraformOnly.push({ what, reason });
  ctx.findings.push(info('plan.native.terraform-only', `${PLATFORM_LABELS[ctx.platform]}: in Terraform only: ${what}: ${reason}`));
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** `web-01.x` → `web-01-x`: lower case letters, digits and single hyphens. */
export const kebab = (s        )         => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');

/** `prod`, `web`, `a` → `ProdWebA`: a CloudFormation logical id, a Bicep symbol's tail. */
export function pascal(...parts                              )         {
  return parts
    .flatMap((p) => String(p).split(/[^A-Za-z0-9]+/))
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

/** `ProdWebA` → `prodWebA`: a Bicep symbol. */
export function camel(...parts                              )         {
  const p = pascal(...parts);
  const s = p.charAt(0).toLowerCase() + p.slice(1);
  return /^[a-z]/.test(s) ? s : `r${s}`;
}

/** The plan tag value (atk_plan): the plan id as every cloud accepts it. */
export const planTag = (plan                  )         => planTagValue(plan.id);

// ---------------------------------------------------------------------------
// Workloads and databases
// ---------------------------------------------------------------------------

export function workloadOf(ctx           , t               )                       {
  return ctx.workloadById.get(t.workload);
}

export const vmName = (ctx           , t               )         => workloadOf(ctx, t)?.name ?? t.workload;

/** The OS kind of a compute target. */
export const osKindOf = (os                    )                      => (/^win/i.test(os ?? '') ? 'windows' : 'linux');

export function osFamilyOf(os        )                                                   {
  if (/^win/.test(os)) return 'windows';
  if (/^(rhel|centos|rocky|alma|ol)/.test(os)) return 'rhel';
  if (/^sles/.test(os)) return 'suse';
  if (/^(ubuntu|debian)/.test(os)) return 'debian';
  return 'other';
}

/** The database engine tag (atk_db) of a host, from its IaaS database or its role. */
export function dbTagOfHost(ctx           , t               )         {
  const engine = ctx.dbEngineOfHost.get(t.workload);
  if (engine) return engine;
  return workloadOf(ctx, t)?.role === 'db' ? 'db' : '';
}

/** The tags Ansible's dynamic inventories key on (the same keys as the Terraform compute blueprints write). */
export function vmTags(ctx           , t               , method                         )                         {
  const w = workloadOf(ctx, t);
  const app = w ? ctx.appByName.get(w.app) : undefined;
  return {
    atk_plan: planTag(ctx.plan),
    atk_method: method,
    atk_component: (w && ctx.componentOf.get(w.name)) ?? '',
    atk_app: w?.app ?? '',
    atk_role: ctx.dbEngineOfHost.get(t.workload) ?? w?.role ?? '',
    atk_env: w?.env ?? '',
    atk_owner: app?.owner ?? '',
    atk_os: w?.os ?? 'unknown',
    atk_os_family: osFamilyOf(w?.os ?? 'unknown'),
    atk_wave: app?.wave === undefined ? '' : String(app.wave),
    atk_backup: t.backupTier,
    atk_db: dbTagOfHost(ctx, t),
    atk_licence: licenceKeyOf(t, ctx.platform),
  };
}

/** The network a database sits in: its first host's (as placed), else a built network of its environment with a data-tier subnet, else the hub. */
export function dbNetwork(ctx           , db                      )         {
  const built = builtIn(ctx.pd.networks, ctx.pd.region);
  const hostTarget = db?.hosts.map((h) => ctx.pd.compute.find((c) => ctx.workloadById.get(c.workload)?.name === h)).find(Boolean);
  if (hostTarget) return hostTarget.network;
  const host = db?.hosts.map((h) => [...ctx.workloadById.values()].find((w) => w.name === h)).find(Boolean);
  const want = host ? envClassOf(host.env) : 'prod';
  const withDb = built.filter((n) => n.subnets.some((s) => s.tier === 'db'));
  return (withDb.find((n) => n.env === want) ?? withDb[0] ?? hubOf(ctx.pd.networks, ctx.pd.region) ?? built[0])?.name ?? '';
}

/** The environment a database serves: its first host's, else prod. */
export function dbEnv(ctx           , db                      )         {
  const host = db?.hosts.map((h) => [...ctx.workloadById.values()].find((w) => w.name === h)).find(Boolean);
  return host?.env ?? 'prod';
}

/** A backup tier's retention in days. */
export function retentionOf(pd                , tier        )         {
  return pd.backup.tiers.find((b) => b.tier === tier)?.retentionDays ?? 7;
}

/** Zone index (0-based) of a compute target within its network. */
export function zoneIndexOf(pd                , t                                         )         {
  const n = pd.networks.find((x) => x.name === t.network);
  const i = n ? networkZones(n).indexOf(t.zone) : -1;
  return i >= 0 && i < 3 ? i : 0;
}

/** The tiers of a network that exist (in the network's own order). */
export const tiersOf = (n               )           => [...n.tiers];

// ---------------------------------------------------------------------------
// Firewall rules per tier (the rules the Terraform landing zones write)
// ---------------------------------------------------------------------------

/** Database engine ports, opened from the app and mgmt tiers to the db tier. */
export const DB_PORTS                    = [1433, 1521, 5432, 3306];

/** Ports a domain controller in the mgmt tier needs open to the network and to on-premises. */
export const AD_PORTS                                                        = [
  ['tcp', 53, 53], ['udp', 53, 53], ['tcp', 88, 88], ['udp', 88, 88], ['udp', 123, 123], ['tcp', 135, 135],
  ['tcp', 389, 389], ['udp', 389, 389], ['tcp', 445, 445], ['tcp', 464, 464], ['udp', 464, 464],
  ['tcp', 636, 636], ['tcp', 3268, 3269], ['tcp', 49152, 65535],
];

/** The on-premises ranges a network admits: IPv4 always, IPv6 only on a dual-stack network. */
export function siteSources(plan      , n               )           {
  return siteCidrs(plan).filter((c) => familyOf(c.split('/')[0] ?? '') === 4 || (n.ipv6 && familyOf(c.split('/')[0] ?? '') === 6));
}

export const isV6 = (cidr        )          => familyOf(cidr.split('/')[0] ?? '') === 6;

/** The management ranges WinRM is opened to on a Windows VM: on-premises and the mgmt subnets (IPv4). */
export function mgmtCidrs(plan      , pd                )           {
  const out = [...siteCidrs(plan)];
  for (const n of pd.networks) for (const s of n.subnets) if (s.tier === 'mgmt') out.push(s.cidr);
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// Bootstrap text (no secrets)
// ---------------------------------------------------------------------------

/** cloud-init for a Linux VM: the hostname, an `ansible` user with the SSH key, and python3. `key` is where the key goes. */
export function cloudInitLines(hostname        , key        )           {
  return [
    '#cloud-config',
    `hostname: ${hostname}`,
    'users:',
    '  - default',
    '  - name: ansible',
    '    shell: /bin/bash',
    '    sudo: "ALL=(ALL) NOPASSWD:ALL"',
    '    lock_passwd: true',
    '    ssh_authorized_keys:',
    `      - ${key}`,
    'package_update: false',
    'packages:',
    '  - python3',
  ];
}

/** PowerShell for a Windows VM: a WinRM HTTPS listener on a self-signed certificate, 5986 from the management ranges only. */
export function winrmLines(mgmt                   )           {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$cert = New-SelfSignedCertificate -DnsName $env:COMPUTERNAME -CertStoreLocation 'Cert:\\LocalMachine\\My' -NotAfter (Get-Date).AddYears(3)",
    "Get-ChildItem WSMan:\\localhost\\Listener | Where-Object { $_.Keys -contains 'Transport=HTTPS' } | Remove-Item -Recurse -Force",
    'New-Item -Path WSMan:\\localhost\\Listener -Transport HTTPS -Address * -CertificateThumbPrint $cert.Thumbprint -Force | Out-Null',
    'Set-Item -Path WSMan:\\localhost\\Service\\Auth\\Basic -Value $false',
    "Get-NetFirewallRule -Name 'atk-winrm-https' -ErrorAction SilentlyContinue | Remove-NetFirewallRule",
    `New-NetFirewallRule -Name 'atk-winrm-https' -DisplayName 'WinRM HTTPS from management' -Direction Inbound -Protocol TCP -LocalPort 5986 -RemoteAddress @('${mgmt.join("','")}') -Action Allow | Out-Null`,
    'Restart-Service WinRM',
  ];
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 of bytes, without Buffer (this runs in the browser too). */
export function base64Bytes(bytes                   )         {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64[(n >> 18) & 63]  + B64[(n >> 12) & 63]  + (b === undefined ? '=' : B64[(n >> 6) & 63] ) + (c === undefined ? '=' : B64[n & 63] );
  }
  return out;
}

/** Base64 of a text as UTF-16LE: what `powershell -EncodedCommand` reads. */
export function utf16leBase64(text        )         {
  const bytes           = [];
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    bytes.push(code & 0xff, code >> 8);
  }
  return base64Bytes(bytes);
}

// ---------------------------------------------------------------------------
// README pieces
// ---------------------------------------------------------------------------

export function terraformOnlySection(items                          )           {
  if (items.length === 0) return [];
  return [
    '## In Terraform only',
    '',
    'These parts of the design have no clean native equivalent here, so this template builds none of them; each line says why, and where it is built:',
    '',
    ...items.map((t) => `- **${t.what}**: ${t.reason}`),
    '',
  ];
}

/** The monitoring thresholds by criticality (the same data the Terraform app monitoring uses). */
export { THRESHOLDS } from '../../../../terraform/blueprints/patterns/common.js';
