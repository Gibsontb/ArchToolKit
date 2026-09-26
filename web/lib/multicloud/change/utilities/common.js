/**
 * What every utility shares (addendum A.9, WP-20; the Utilities area of
 * Multi-Cloud Migration & Utilities): the `ChangeUtility` contract, the
 * input builders, the plan lookups, the Terraform root module every utility
 * writes (the `landing_zone_source = variables` contract), the Ansible
 * project, the PowerShell tool skeleton, reversible plan updates and the
 * plan-managed route (a plan update and the app stack's diff instead of
 * drift).
 *
 * A utility's `build` returns files relative to the bundle root and the
 * ordered apply and rollback steps; `bundle.ts` turns those into `apply.sh`,
 * `rollback.sh`, the README, `change.json` and the status events. Nothing
 * here reads a clock or writes a credential.
 *
 * Pure: no DOM, no file system.
 */

import { error, info, warning,              } from '../../../core/findings.js';
import { ANSIBLE_SCHEMA_INDEX } from '../../../ansible/module-schema-index.js';
                                                                                               
                                                             
import { CATALOG_DATA } from '../../../terraform/catalog-data.js';
import { renderFile } from '../../../terraform/hcl.js';
import { providerFor } from '../../../terraform/providers.js';
import { code } from '../../plan/execute/lib-sh.js';
import { consumerProvider, landingZoneKeys, landingZoneVariable, q,               } from '../../../terraform/blueprints/migration/common.js';
import { generateAppStack } from '../../plan/apps/generate.js';
import { appPlanOf, findApp } from '../../plan/apps/components.js';
import { osKind } from '../../plan/os.js';
import { ENV_OPTIONS, PLATFORM_LABELS, PLATFORM_VALUES, slugName } from '../../plan/options.js';
                                                                                                                  
import { diffFileSets } from './diff.js';

                                                    

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

                                                    
                                                                                                                                                                         
export const UTILITY_CATEGORY_LABELS                                            = Object.freeze({
  compute: 'Servers', storage: 'Storage', data: 'Databases', network: 'Network, DNS and load balancing', protection: 'Snapshots, backup and certificates',
  operations: 'Operations', access: 'Users, groups and access', governance: 'Tags, budgets and monitoring', containers: 'Containers',
  catalogue: 'Anything else', deploy: 'Deploy a new service',
});

/** Where a dropdown's options come from on the page (the plan, the tracker, the settings). */
                                                                                                                 

/** A utility's input: a blueprint input (rendered with `renderBlueprintForm`), optionally fed from the plan. */
                                                      
                             
 

                                 
                                                                                       
                       
                                                         
                             
                                                                                                        
                         
                                                                                      
                        
                                                           
                                    
                                  
                                           
 

/** How a utility makes its change. */
                                                                                        

/** One step of `apply.sh` / `rollback.sh`. Paths are relative to the bundle root. */
                        
                                                                                                                             
                                                                                                      
                                                                                    
                                                                                                              
                                                                                          
                                                                                                          
                                                                                                                                          
                                                                                                                           
                                                                                 
                                                                          
                                                                                                   
                                                                                                               
                                                                    
                                                                               

/** A reversible plan update (the plan-managed route and every utility that adds to the plan). */
                    
                                                                                                   
                                                                
                                                                   
                                                                                                                          
                                                                
                                                                                                                                                                                                                                                
                                                                                                                                                

                                
                              
                                                                  
                          
                                               
                           
                              
                                                                                         
                                                   
                                        
                                        
                                           
                                                                           
                                            
                                                                      
                                    
                                                                                
                                       
                                                                                
                            
                                                                                               
                                         
                                                         
                         
                                 
                                     
 

                                
                      
                         
                                     
                               
                                                                           
                                          
                                           
                             
                                                                                                                    
                               
                                                
                            
                                                                                          
                                               
                                                                     
                                                                                                                      
                                                                                                                  
 

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** A value as text, trimmed; the fallback when empty. */
export function val(values                 , id        , fallback = '')         {
  const v = values[id];
  if (v === undefined || v === null) return fallback;
  const s = String(v).trim();
  return s === '' ? fallback : s;
}
export function numVal(values                 , id        , fallback        )         {
  const n = Number(values[id]);
  return Number.isFinite(n) && String(values[id] ?? '').trim() !== '' ? n : fallback;
}
/** Words split on spaces and commas. */
export const list = (text        )           => text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
export const isPlatform = (s        )                => (PLATFORM_VALUES                     ).includes(s);
export function platformOf(values                 , u                                  )           {
  const p = val(values, 'platform', u.platforms[0]);
  return isPlatform(p) && u.platforms.includes(p) ? p : u.platforms[0] ;
}
/** A bash single-quoted word. */
export const shq = (s        )         => `'${s.replace(/'/g, `'\\''`)}'`;
/** A PowerShell single-quoted string. */
export const psq = (s        )         => `'${s.replace(/'/g, "''")}'`;
/** A YAML single-quoted scalar. */
export const yq = (s        )         => `'${s.replace(/'/g, "''")}'`;
/** A name safe for a resource or a file: lower case, digits and hyphens. */
export function safeName(s        , max = 48)         {
  return (slugName(s).replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'x').slice(0, max).replace(/-+$/, '');
}
/** A Terraform identifier. */
export const tfId = (s        )         => {
  const t = s.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'x';
  return /^[a-z_]/.test(t) ? t : `n_${t}`;
};

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export const HYPERSCALERS                      = Object.freeze(['aws', 'azure', 'google', 'oci']);
export const ALL_PLATFORMS                      = Object.freeze(['vmware', 'aws', 'azure', 'google', 'oci']);
export const opt = (value        , label = value, group         )               => (group ? { value, label, group } : { value, label });
export const opts = (values                   )                 => values.map((v) => opt(v));

export function platformInput(platforms                     )               {
  return {
    id: 'platform', label: 'Platform', control: 'select', default: platforms[0],
    options: platforms.map((p) => opt(p, p === 'vmware' ? 'VMware Cloud Foundation (VCF 9.1)' : PLATFORM_LABELS[p])),
  };
}
/** Show only on these platforms. */
export const on = (...platforms            )                                                                                        => ({ showWhen: { input: 'platform', equals: platforms } });

export const serverInput = (label = 'Server', def = 'app01')               =>
  ({ id: 'server', label, control: 'combo', default: def, from: 'server', hint: 'The plan\'s servers and the tracker\'s cut-over targets; any other name works too.' });
export const appInput = (def = 'shop', label = 'Application')               => ({ id: 'app', label, control: 'combo', default: def, from: 'app' });
export const osInput = (def                      = 'linux')               => ({
  id: 'os', label: 'Guest OS', control: 'select', default: def, options: [opt('linux', 'Linux'), opt('windows', 'Windows Server')],
  hint: 'Taken from the plan when the server is in it.',
});
export const envInput = (def      = 'prod')               => ({ id: 'env', label: 'Environment', control: 'select', default: def, options: ENV_OPTIONS.map((o) => opt(o.value, o.label)) });
export const ROUTE_INPUT               = {
  id: 'route', label: 'How', control: 'select', default: 'auto',
  options: [
    opt('auto', 'Automatic: through the plan when an app stack manages the target'),
    opt('plan', 'Through the plan (plan update and the app stack\'s diff)'),
    opt('direct', 'Directly (a target outside Terraform)'),
  ],
  hint: 'A target the app stacks manage is changed in its Terraform, so the next apply does not undo it.',
};
/** The landing-zone network and tier a hyperscaler change sits in (the `<network>/<tier>` keys of the contract). */
export const NETWORK_INPUTS                          = [
  { id: 'network', label: 'Landing-zone network', control: 'combo', default: 'prod', options: opts(['prod', 'nonprod', 'shared', 'dr']), hint: 'A key of the landing zone\'s network_ids.', ...on('aws', 'azure', 'google', 'oci') },
  { id: 'tier', label: 'Tier', control: 'select', default: 'app', options: opts(['web', 'app', 'db', 'mgmt']), ...on('aws', 'azure', 'google', 'oci') },
];
/** Where a vSphere change runs: the VCF workload domain's vCenter instance. */
export const VSPHERE_INPUTS                          = [
  { id: 'vcenter', label: 'vCenter', control: 'text', default: 'wld01-vc01.corp.example.com', hint: 'The workload domain\'s vCenter instance.', ...on('vmware') },
  { id: 'datacenter', label: 'Datacenter', control: 'text', default: 'wld01-dc', ...on('vmware') },
];
export const ZONE_INPUT               = { id: 'zone', label: 'Zone', control: 'text', default: '', hint: 'Blank: the landing zone\'s first zone.', ...on('google') };
export const RG_INPUT               = { id: 'resource_group', label: 'Resource group', control: 'text', default: '', hint: 'Blank: the landing zone\'s resource group for the network.', ...on('azure') };

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export function findWorkload(plan                  , name        )                       {
  if (!plan) return undefined;
  const n = name.trim().toLowerCase();
  return plan.workloads.find((w) => w.name.toLowerCase() === n || w.id === name || (w.rename ?? '').toLowerCase() === n);
}
export function findDatabase(plan                  , name        )                       {
  const n = name.trim().toLowerCase();
  return plan?.databases.find((d) => d.name.toLowerCase() === n || d.id === name);
}

/** The platform a workload lands on: its app plan's, its pin, the decision's choice. */
export function workloadPlatform(plan      , w          )                       {
  const app = findApp(plan, w.app);
  const ap = app ? appPlanOf(plan, app.id) : undefined;
  return ap?.platform ?? w.pin ?? plan.decision?.items[w.id]?.chosen?.platform;
}

/** The guest OS kind of a server: the plan's, else the input. */
export function guestOs(plan                  , server        , values                 )                      {
  const w = findWorkload(plan, server);
  if (w) return osKind(w.os) === 'windows' ? 'windows' : 'linux';
  return val(values, 'os', 'linux') === 'windows' ? 'windows' : 'linux';
}

/**
 * The app stack that manages a server on a platform, when there is one: its
 * app has an application plan on that platform that is `planned` or
 * `approved` (a draft is not generated).
 */
export function managingApp(plan                  , server        , platform          )                                                    {
  const w = findWorkload(plan, server);
  if (!plan || !w || !w.app) return undefined;
  return managingAppOf(plan, w.app, platform) ? { appId: findApp(plan, w.app) .id, workload: w } : undefined;
}
export function managingAppOf(plan                  , appRef        , platform          )                     {
  if (!plan) return undefined;
  const app = findApp(plan, appRef);
  const ap = app ? appPlanOf(plan, app.id) : undefined;
  if (!app || !ap || ap.platform !== platform || (ap.status !== 'planned' && ap.status !== 'approved')) return undefined;
  return app.id;
}

/** The route the user asked for, resolved against what manages the target. */
export function routeOf(values                 , managed         , findings           )                    {
  const r = val(values, 'route', 'auto');
  if (r === 'direct') {
    if (managed) findings.push(warning('change.route.drift', 'The target is managed by an app stack, and this change goes around it: the stack\'s next apply undoes it.', { remediation: 'Choose "Automatic" or "Through the plan".' }));
    return 'direct';
  }
  if (managed) return 'plan';
  if (r === 'plan') findings.push(warning('change.route.not-managed', 'No planned or approved application plan on this platform manages the target, so the change is made directly.', { remediation: 'Plan the app on Application Migration first, or keep the direct route.' }));
  return 'direct';
}

// ---------------------------------------------------------------------------
// Reversible plan updates
// ---------------------------------------------------------------------------

function setOverride(plan      , key        , value                    )       {
  const next = { ...plan.designOverrides };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return { ...plan, designOverrides: next };
}

function withComponents(plan      , app        , platform          , change                                   )       {
  const ap = appPlanOf(plan, app);
  if (!ap) return plan;
  const comps = (ap.variants[platform] ?? []).map(change);
  const next = { ...ap, variants: { ...ap.variants, [platform]: comps } };
  return { ...plan, appPlans: (plan.appPlans ?? []).map((a) => (a.app === ap.app ? next : a)) };
}

const setSettings = (settings                                  , to                                              )                         => {
  const out                         = { ...settings };
  for (const [k, v] of Object.entries(to)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
};

function applyOp(plan      , op        , forward         )       {
  switch (op.op) {
    case 'override':
      return setOverride(plan, op.key, forward ? op.to : op.from);
    case 'workload-add':
    case 'workload-remove': {
      const adding = (op.op === 'workload-add') === forward;
      const rest = plan.workloads.filter((w) => w.id !== op.workload.id);
      return { ...plan, workloads: adding ? [...rest, op.workload] : rest };
    }
    case 'workload-set':
      return { ...plan, workloads: plan.workloads.map((w) => (w.id === op.id ? { ...w, ...(forward ? op.to : op.from) } : w)) };
    case 'database-add': {
      const rest = plan.databases.filter((d) => d.id !== op.database.id);
      return { ...plan, databases: forward ? [...rest, op.database] : rest };
    }
    case 'component-settings':
      return withComponents(plan, op.app, op.platform, (c) => (c.id === op.component && c.kind === 'pattern' ? { ...c, settings: setSettings(c.settings, forward ? op.to : op.from) } : c));
    case 'component-server':
      return withComponents(plan, op.app, op.platform, (c) => {
        if (c.id !== op.component || c.kind !== 'pattern') return c;
        const rest = c.servers.filter((s) => s !== op.server);
        return { ...c, servers: forward ? [...rest, op.server] : rest };
      });
    default:
      return plan;
  }
}

/** The plan with the update made. */
export function applyPlanOps(plan      , ops                   )       {
  return ops.reduce((p, op) => applyOp(p, op, true), plan);
}
/** The plan with the update undone (the utility's rollback, on the page). */
export function revertPlanOps(plan      , ops                   )       {
  return [...ops].reverse().reduce((p, op) => applyOp(p, op, false), plan);
}
/** One line per operation, for the README and the CR. */
export function describePlanOp(op        )         {
  switch (op.op) {
    case 'override': return `Design override \`${op.key}\`: ${op.from ?? '(none)'} → ${op.to ?? '(none)'}`;
    case 'workload-add': return `New server \`${op.workload.name}\` (${op.workload.vcpu} vCPU, ${op.workload.ramGib} GiB, disks ${op.workload.disksGib.join(' / ')} GiB) in ${op.workload.app || 'no app'}`;
    case 'workload-remove': return `Server \`${op.workload.name}\` removed from the plan`;
    case 'workload-set': return `Server \`${op.id}\`: ${Object.keys(op.to).map((k) => `${k} ${JSON.stringify((op.from                           )[k])} → ${JSON.stringify((op.to                           )[k])}`).join(', ')}`;
    case 'database-add': return `New database \`${op.database.name}\` (${op.database.engine}, ${op.database.sizeGib} GiB) in ${op.database.app || 'no app'}`;
    case 'component-settings': return `Component \`${op.component}\` on ${PLATFORM_LABELS[op.platform]}: ${Object.keys(op.to).map((k) => `${k} ${op.from[k] ?? '(default)'} → ${op.to[k] ?? '(default)'}`).join(', ')}`;
    case 'component-server': return `Server \`${op.server}\` added to component \`${op.component}\``;
    default: return '';
  }
}

// ---------------------------------------------------------------------------
// The plan-managed route: the app stack, before and after
// ---------------------------------------------------------------------------

                              
                                         
                               
                                  
                               
                                                                     
                            
 

/**
 * Regenerate one app's stack for a platform before and after a plan update,
 * and keep what differs: `stack/before/…`, `stack/after/…`, `stack/stack.diff`
 * and `stack/files.json`. apply.sh puts the after files in `$ATK_STACK_DIR`
 * (the app stack's `terraform/<platform>` folder, where its state is) and
 * applies there; rollback.sh puts the before files back and applies.
 */
export function stackChange(plan      , ops                   , appId        , platform          , ctx                )              {
  const after = applyPlanOps(plan, ops);
  const options = { record: false, ...(ctx.lookup ? { lookup: ctx.lookup } : {}), ...(ctx.ansibleLookup ? { ansibleLookup: ctx.ansibleLookup } : {}) };
  const tfOf = (p      )                         => {
    const g = generateAppStack(p, [appId], options);
    const prefix = `${g.folder}/terraform/${platform}/`;
    const out                         = {};
    for (const [k, v] of Object.entries(g.files)) if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
    return out;
  };
  const before = tfOf(plan);
  const next = tfOf(after);
  const d = diffFileSets(before, next);
  const findings            = [];
  const files                         = {};
  if (d.text === '') {
    findings.push(warning('change.stack.unchanged', 'The plan update does not change the app stack\'s Terraform, so nothing is applied through it.', { remediation: 'Check the target is in the app\'s stack on this platform, or use the direct route.' }));
    return { files, apply: [], rollback: [], findings, changed: false };
  }
  for (const f of [...d.changed, ...d.removed]) files[`stack/before/${f}`] = before[f] ;
  for (const f of [...d.changed, ...d.added]) files[`stack/after/${f}`] = next[f] ;
  files['stack/stack.diff'] = d.text;
  files['stack/files.json'] = `${JSON.stringify({ app: appId, platform, changed: d.changed, added: d.added, removed: d.removed }, null, 2)}\n`;
  findings.push(info('change.stack.plan-managed', `The change goes through the plan: ${d.changed.length + d.added.length + d.removed.length} file(s) of the app stack on ${PLATFORM_LABELS[platform]} change (stack/stack.diff).`));
  return {
    files,
    apply: [{ kind: 'stack', title: `Update the app stack on ${PLATFORM_LABELS[platform]} and apply it`, platform, direction: 'apply' }],
    rollback: [{ kind: 'stack', title: `Put the app stack on ${PLATFORM_LABELS[platform]} back and apply it`, platform, direction: 'revert' }],
    findings,
    changed: true,
  };
}

// ---------------------------------------------------------------------------
// Terraform root modules
// ---------------------------------------------------------------------------

                                                                                   
                        
                        
                        
                               
                                                                          
                                                                                                    
                               
 
                         
                              
                                        
                          
                                          
                        
                                        
                            
                             
                        
                                                       
                                                                     
 

const CLOUD                                                = { aws: 'aws', azure: 'azure', google: 'google', oci: 'oci' };
const LOCAL                                   = { aws: 'aws', azure: 'azurerm', google: 'google', oci: 'oci', vsphere: 'vsphere', nsxt: 'nsxt', avi: 'avi' };

function pinOf(name                )                                      {
  const e = CATALOG_DATA[name] ;
  const [major = '0', minor = '0'] = e.version.split('.');
  return { source: e.source, version: `~> ${major}.${minor}` };
}

/** An example of the landing-zone contract's variable, for `landing_zone.auto.tfvars.json.example`. */
export function landingZoneExample(cloud          )         {
  const example                          = {};
  for (const k of landingZoneKeys(cloud)) {
    if (/_ids$|_names$|resource_group$|_cidrs$/.test(k) && k !== 'mgmt_cidrs') example[k] = {};
    else if (k === 'zones' || k === 'mgmt_cidrs') example[k] = [];
    else if (k === 'ipv6') example[k] = {};
    else example[k] = '';
  }
  return `${JSON.stringify({ landing_zone: example }, null, 2)}\n`;
}

/** The landing zone's one-line bridge (A.2.5): its output into this module's variables. */
export const lzBridge = (platform          , dir = 'terraform')         =>
  `terraform -chdir=<landing-zone project>/terraform/${platform} output -json landing_zone | jq '{landing_zone: .}' > ${dir}/landing_zone.auto.tfvars.json`;

/**
 * A root module: versions.tf, providers.tf, variables.tf, main.tf,
 * outputs.tf, `change.auto.tfvars.json` (the change's own values) and, on a
 * hyperscaler, `landing_zone.auto.tfvars.json.example` (the contract's shape,
 * filled by the bridge). Credentials are sensitive variables with no value.
 */
export function tfRoot(spec        )                         {
  const dir = spec.dir ?? 'terraform';
  const cloud = CLOUD[spec.platform];
  const providers = cloud ? [cloud === 'azure' ? 'azure' : cloud] : (spec.vmwareProviders ?? ['vsphere']);
  const req = providers.map((p) => {
    const pin = p === 'nsxt' || p === 'avi' ? pinOf(p) : providerFor(p === 'azure' ? 'azure' : (p                                        ));
    return `    ${LOCAL[p]} = {\n      source  = ${q(pin.source)}\n      version = ${q(pin.version)}\n    }`;
  });
  const files                         = {};
  files[`${dir}/versions.tf`] = `terraform {\n  required_version = ">= 1.7.0"\n  required_providers {\n${req.join('\n')}\n  }\n}\n`;
  const vars          = [...(spec.variables ?? [])];
  let providerText        ;
  let lzText = '';
  if (cloud) {
    providerText = renderFile([consumerProvider(cloud)]);
    lzText = renderFile([landingZoneVariable(cloud)]);
    files[`${dir}/landing_zone.auto.tfvars.json.example`] = landingZoneExample(cloud);
  } else {
    const blocks           = [];
    if (providers.includes('vsphere')) {
      blocks.push('provider "vsphere" {\n  vsphere_server       = var.vsphere_server\n  user                 = var.vsphere_user\n  password             = var.vsphere_password\n  allow_unverified_ssl = false\n}');
      vars.push({ name: 'vsphere_user', type: 'string', description: 'The vCenter account Terraform signs in with (TF_VAR_vsphere_user).' });
      vars.push({ name: 'vsphere_password', type: 'string', description: 'The vCenter account\'s password. Sensitive: set TF_VAR_vsphere_password in the environment; it is never written to a file.', sensitive: true });
    }
    if (providers.includes('nsxt')) {
      blocks.push('provider "nsxt" {\n  host                 = var.nsx_manager\n  username             = var.nsx_username\n  password             = var.nsx_password\n  allow_unverified_ssl = false\n}');
      vars.push({ name: 'nsx_username', type: 'string', description: 'The NSX Manager account (TF_VAR_nsx_username).' });
      vars.push({ name: 'nsx_password', type: 'string', description: 'The NSX Manager account\'s password. Sensitive: set TF_VAR_nsx_password; it is never written to a file.', sensitive: true });
    }
    if (providers.includes('avi')) {
      blocks.push('provider "avi" {\n  avi_controller = var.avi_controller\n  avi_username   = var.avi_username\n  avi_password   = var.avi_password\n  avi_tenant     = "admin"\n  avi_version    = var.avi_version\n}');
      vars.push({ name: 'avi_username', type: 'string', description: 'The VMware Avi Load Balancer controller account (TF_VAR_avi_username).' });
      vars.push({ name: 'avi_password', type: 'string', description: 'The controller account\'s password. Sensitive: set TF_VAR_avi_password; it is never written to a file.', sensitive: true });
    }
    providerText = `${blocks.join('\n\n')}\n`;
  }
  files[`${dir}/providers.tf`] = providerText;
  const varText = vars.map((v) => [
    `variable ${q(v.name)} {`,
    `  type        = ${v.type}`,
    `  description = ${q(v.description)}`,
    ...(v.sensitive ? ['  sensitive   = true'] : []),
    '}',
  ].join('\n'));
  files[`${dir}/variables.tf`] = `${[lzText.trim(), ...varText].filter(Boolean).join('\n\n')}\n`;
  files[`${dir}/main.tf`] = `# ${spec.header}\n\n${spec.main.trim()}\n`;
  if (spec.outputs?.trim()) files[`${dir}/outputs.tf`] = `${spec.outputs.trim()}\n`;
  const values                          = {};
  for (const v of vars) if (!v.sensitive && v.value !== undefined) values[v.name] = v.value;
  if (Object.keys(values).length) files[`${dir}/change.auto.tfvars.json`] = `${JSON.stringify(values, null, 2)}\n`;
  // A variable with no value (a credential's user name) comes from TF_VAR_<name>.
  return files;
}

/** The TfVars every hyperscaler module that finds a target declares. */
export function locationVars(platform          , values                 )          {
  const out          = [];
  if (platform === 'vmware') {
    out.push({ name: 'vsphere_server', type: 'string', description: 'The workload domain\'s vCenter instance.', value: val(values, 'vcenter', 'wld01-vc01.corp.example.com') });
    out.push({ name: 'datacenter', type: 'string', description: 'The vSphere datacenter.', value: val(values, 'datacenter', 'wld01-dc') });
    return out;
  }
  out.push({ name: 'network', type: 'string', description: 'The landing-zone network key.', value: val(values, 'network', 'prod') });
  out.push({ name: 'tier', type: 'string', description: 'The tier (web, app, db, mgmt).', value: val(values, 'tier', 'app') });
  if (platform === 'azure') out.push({ name: 'resource_group', type: 'string', description: 'The resource group; blank: the landing zone\'s for the network.', value: val(values, 'resource_group') });
  if (platform === 'google') out.push({ name: 'zone', type: 'string', description: 'The zone; blank: the landing zone\'s first.', value: val(values, 'zone') });
  return out;
}

/** Locals every hyperscaler module reads (`local.rg`, `local.zone`, `local.sg_key`). */
export function locationLocals(platform          )         {
  switch (platform) {
    case 'azure': return 'locals {\n  rg     = var.resource_group != "" ? var.resource_group : var.landing_zone.resource_group[var.network]\n  sg_key = "${var.network}/${var.tier}"\n}';
    case 'google': return 'locals {\n  zone   = var.zone != "" ? var.zone : var.landing_zone.zones[0]\n  sg_key = "${var.network}/${var.tier}"\n}';
    case 'vmware': return 'data "vsphere_datacenter" "dc" {\n  name = var.datacenter\n}';
    default: return 'locals {\n  sg_key = "${var.network}/${var.tier}"\n}';
  }
}

/**
 * The target server, found by name (the `Name` tag on AWS, the display name
 * on OCI, the VM name elsewhere), never by a pasted id. Returns the data
 * sources and the expressions of its id, zone and (OCI) availability domain.
 */
export function instanceLookup(platform          , label = 'target', nameExpr = 'var.server')                                                                      {
  switch (platform) {
    case 'aws':
      return {
        hcl: `data "aws_instance" "${label}" {\n  filter {\n    name   = "tag:Name"\n    values = [${nameExpr}]\n  }\n  filter {\n    name   = "instance-state-name"\n    values = ["pending", "running", "stopping", "stopped"]\n  }\n}`,
        id: `data.aws_instance.${label}.id`, zone: `data.aws_instance.${label}.availability_zone`, ref: `data.aws_instance.${label}`,
      };
    case 'azure':
      return {
        hcl: `data "azurerm_virtual_machine" "${label}" {\n  name                = ${nameExpr}\n  resource_group_name = local.rg\n}`,
        id: `data.azurerm_virtual_machine.${label}.id`, zone: 'null', ref: `data.azurerm_virtual_machine.${label}`,
      };
    case 'google':
      return {
        hcl: `data "google_compute_instance" "${label}" {\n  name = ${nameExpr}\n  zone = local.zone\n}`,
        id: `data.google_compute_instance.${label}.self_link`, zone: `data.google_compute_instance.${label}.zone`, ref: `data.google_compute_instance.${label}`,
      };
    case 'oci':
      return {
        hcl: `data "oci_core_instances" "${label}" {\n  compartment_id = var.landing_zone.compartment_id\n  display_name   = ${nameExpr}\n  filter {\n    name   = "state"\n    values = ["RUNNING", "STOPPED"]\n  }\n}`,
        id: `data.oci_core_instances.${label}.instances[0].id`, zone: 'null', ad: `data.oci_core_instances.${label}.instances[0].availability_domain`, ref: `data.oci_core_instances.${label}.instances[0]`,
      };
    default:
      return {
        hcl: `data "vsphere_virtual_machine" "${label}" {\n  name          = ${nameExpr}\n  datacenter_id = data.vsphere_datacenter.dc.id\n}`,
        id: `data.vsphere_virtual_machine.${label}.id`, zone: 'null', ref: `data.vsphere_virtual_machine.${label}`,
      };
  }
}

// ---------------------------------------------------------------------------
// Ansible
// ---------------------------------------------------------------------------

/** A collection's requirement, pinned to the installed major the module index was read from. */
function requirement(name        )         {
  const version = (ANSIBLE_SCHEMA_INDEX                                                  ).collections[name];
  if (!version) return `- name: ${name}`;
  const major = Number(version.split('.')[0]);
  return `- name: ${name}\n  version: '>=${version},<${major + 1}.0.0'`;
}

                                                                                 

/**
 * The Ansible project a bundle carries in `ansible/`: ansible.cfg, the
 * inventory (group `atk_change`, with `atk_change_windows` for WinRM hosts),
 * requirements.yml and the playbooks. Hosts are by name; set `ansible_host`
 * in the inventory where a name does not resolve.
 */
export function ansibleProject(hosts                        , playbooks                                  , collections                   , dir = 'ansible')                         {
  const files                         = {};
  files[`${dir}/ansible.cfg`] = [
    '# Ansible reads this when it is run from this directory.',
    '',
    '[defaults]',
    'inventory = inventory/hosts.yml',
    'host_key_checking = True',
    '',
    '[inventory]',
    'unparsed_is_failed = True',
    '',
  ].join('\n');
  const linux = hosts.filter((h) => !h.windows);
  const windows = hosts.filter((h) => h.windows);
  const group = (hs                        )         => (hs.length ? `\n${hs.map((h) => `            ${yamlKey(h.name)}: {}`).join('\n')}` : ' {}');
  files[`${dir}/inventory/hosts.yml`] = [
    '---',
    '# The change\'s targets. Set ansible_host where a name does not resolve.',
    'all:',
    '  children:',
    '    atk_change:',
    '      children:',
    '        atk_change_linux:',
    `          hosts:${group(linux)}`,
    '        atk_change_windows:',
    `          hosts:${group(windows)}`,
    '          vars:',
    '            ansible_connection: winrm',
    '            ansible_port: 5986',
    '            ansible_winrm_transport: kerberos',
    '            ansible_winrm_server_cert_validation: validate',
    '',
  ].join('\n');
  const cols = [...new Set(collections.filter((c) => c !== 'ansible.builtin'))].sort();
  files[`${dir}/requirements.yml`] = `---\ncollections:${cols.length ? `\n${cols.map(requirement).join('\n')}` : ' []'}\n`;
  for (const [name, text] of Object.entries(playbooks)) files[`${dir}/${name}`] = text;
  return files;
}
const yamlKey = (s        )         => (/^[A-Za-z0-9_.-]+$/.test(s) ? s : yq(s));

/** A namespace.collection the toolkit's module index knows (or ansible.builtin). */
const isCollection = (c        )          =>
  c === 'ansible.builtin' || c in (ANSIBLE_SCHEMA_INDEX                                            ).collections;

/** The collections a playbook's modules come from. */
export function collectionsOf(text        )           {
  return [...new Set(modulesOf(text).map((m) => m.split('.').slice(0, 2).join('.')))].sort();
}
/** The fully-qualified modules a playbook calls (keys `<namespace>.<collection>.<module>:` of a known collection). */
export function modulesOf(text        )           {
  const out = new Set        ();
  for (const m of text.matchAll(/^\s+(?:-\s+)?([a-z0-9_]+\.[a-z0-9_]+)\.([a-z0-9_]+):/gm)) {
    if (isCollection(m[1] )) out.add(`${m[1]}.${m[2]}`);
  }
  return [...out].sort();
}

/** A playbook: header comment, one play. `tasks` is YAML indented by four spaces. */
export function playbook(title        , hosts        , tasks        , o                                                                        = {})         {
  return [
    `# ${title}`,
    '#',
    '# Applied by apply.sh (or: ansible-playbook <this file>); apply.sh --dry-run runs it with --check --diff.',
    '# Credentials come from the environment or ansible-vault (vault_* variables), never from this file.',
    '---',
    `- name: ${yq(title)}`,
    `  hosts: ${hosts}`,
    `  gather_facts: ${o.facts === false ? 'false' : 'true'}`,
    ...(o.become ? ['  become: true'] : []),
    ...(o.serial ? [`  serial: ${o.serial}`] : []),
    ...(o.vars ? ['  vars:', o.vars.replace(/\s+$/, '')] : []),
    '  tasks:',
    tasks.replace(/\s+$/, ''),
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// PowerShell tools (VCF PowerCLI)
// ---------------------------------------------------------------------------

/**
 * A contract-keeping PowerShell tool for `scripts/`: `-DryRun`, the library,
 * `Initialize-Atk -Tool`, and a vCenter connection from VC_SERVER / VC_USER
 * with the password from VC_PASSWORD, VC_PASSWORD_FILE or ATK_VAULT_CMD.
 * `$Mode` is `apply` or `rollback`; every change is inside `Invoke-AtkStep`.
 */
export function vcfTool(file        , summary        , body        )         {
  return `#Requires -Version 7.4
<#
.SYNOPSIS
  ${summary}
.DESCRIPTION
  Run by apply.sh (apply) and rollback.sh (rollback). Changes are made by default; -DryRun logs each change instead.
  vCenter: VC_SERVER and VC_USER; the password from VC_PASSWORD, VC_PASSWORD_FILE (mode 600) or ATK_VAULT_CMD.
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)] [ValidateSet('apply', 'rollback')] [string] $Mode = 'apply',
  [switch] $DryRun
)
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot '../lib/Atk.psm1') -Force
Initialize-Atk -Path 'change' -Tool -DryRun:$DryRun
Assert-AtkTool -Module @('VCF.PowerCLI')

$server = $env:VC_SERVER
$user = $env:VC_USER
if (-not $server -or -not $user) { Stop-Atk 3 'set VC_SERVER and VC_USER; the password comes from VC_PASSWORD, VC_PASSWORD_FILE or ATK_VAULT_CMD' }
$secure = ConvertTo-SecureString -String (Get-AtkSecret -Name 'VC_PASSWORD') -AsPlainText -Force
$cred = [System.Management.Automation.PSCredential]::new($user, $secure)
$vc = Connect-VIServer -Server $server -Credential $cred -NotDefault -ErrorAction Stop

function Get-ChangeVm {
  param([string] $Name)
  $vm = Get-VM -Server $vc -Name $Name -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $Name } | Select-Object -First 1
  if (-not $vm) { Stop-Atk 1 "no VM named $Name on $server" }
  return $vm
}

${body.trim()}

Disconnect-VIServer -Server $vc -Force -Confirm:$false
`;
}

// ---------------------------------------------------------------------------
// Ansible from the toolkit's blueprints
// ---------------------------------------------------------------------------

                              
                             
                                   
 

/**
 * Several Ansible blueprints as one project in `ansible/`: each blueprint's
 * playbook and roles side by side, its group_vars as
 * `group_vars/all/<blueprint>.yml`, one inventory and one requirements.yml,
 * and `site.yml` importing the playbooks in order. Every play targets
 * `atk_change`.
 */
export function ansibleFromBlueprints(parts                        , hosts                        , lookup                 , findings           , extra                                   = {})                         {
  const playbooks                         = {};
  const files                         = {};
  const collections = new Set        ();
  const imports           = [];
  for (const part of parts) {
    const bp = lookup(part.blueprint);
    if (!bp) {
      findings.push(error('change.ansible.blueprint', `The Ansible blueprint ${part.blueprint} is not in the toolkit.`));
      continue;
    }
    const r = bp.build({ ...part.values, hosts: 'atk_change' }, part.blueprint);
    findings.push(...(r.findings ?? []));
    for (const [f, text] of Object.entries(r.files)) {
      if (f === 'ansible.cfg' || f === 'README.md' || f.startsWith('inventory/')) continue;
      if (f === 'requirements.yml') {
        for (const m of text.matchAll(/^- name: ([a-z0-9_]+\.[a-z0-9_]+)/gm)) collections.add(m[1] );
        continue;
      }
      if (f === 'group_vars/all/main.yml') {
        files[`ansible/group_vars/all/${part.blueprint}.yml`] = text;
        continue;
      }
      if (!f.includes('/') && f.endsWith('.yml')) {
        playbooks[f] = text;
        imports.push(f);
        continue;
      }
      files[`ansible/${f}`] = text;
    }
  }
  for (const [f, text] of Object.entries(extra)) {
    playbooks[f] = text;
    imports.push(f);
    for (const c of collectionsOf(text)) collections.add(c);
  }
  playbooks['site.yml'] = ['# The change\'s configuration, in order.', '---', ...imports.map((f) => `- name: ${f.replace(/\.yml$/, '').replace(/_/g, ' ')}\n  ansible.builtin.import_playbook: ${f}`), ''].join('\n');
  return { ...files, ...ansibleProject(hosts, playbooks, [...collections]) };
}

// ---------------------------------------------------------------------------
// Finding a server from bash (the direct route)
// ---------------------------------------------------------------------------

export const OCI_COMPARTMENT_INPUT               = {
  id: 'compartment_id', label: 'Compartment OCID', control: 'text', default: '',
  hint: 'Blank: $OCI_COMPARTMENT_ID when the script runs.', ...on('oci'),
};

/**
 * Bash that sets the server's handle from its name: `SID` (AWS instance id,
 * OCI instance OCID), `RG` (Azure resource group), `ZONE` (Google Cloud
 * zone). A name that matches none, or more than one, stops the run (exit 5).
 */
export function locateSh(platform          , server        , values                 )         {
  const head = `SERVER=${shq(server)}`;
  switch (platform) {
    case 'aws':
      return code`${head}
SID="$(aws ec2 describe-instances --filters "Name=tag:Name,Values=$SERVER" "Name=instance-state-name,Values=pending,running,stopping,stopped" --query 'Reservations[].Instances[].InstanceId' --output text)"
if [[ -z "$SID" || "$SID" == *[[:space:]]* ]]; then change_stop 5 "expected one EC2 instance tagged Name=$SERVER, found: $\{SID:-none}"; fi`;
    case 'azure':
      return code`${head}
RG=${shq(val(values, 'resource_group'))}
if [[ -z "$RG" ]]; then RG="$(az vm list --query "[?name=='$SERVER'].resourceGroup | [0]" -o tsv)"; fi
if [[ -z "$RG" ]]; then change_stop 5 "no Azure VM named $SERVER"; fi`;
    case 'google':
      return code`${head}
ZONE=${shq(val(values, 'zone'))}
if [[ -z "$ZONE" ]]; then ZONE="$(gcloud compute instances list --filter="name=($SERVER)" --format='value(zone.basename())' --limit=1)"; fi
if [[ -z "$ZONE" ]]; then change_stop 5 "no Compute Engine instance named $SERVER"; fi`;
    case 'oci':
      return code`${head}
COMPARTMENT=${shq(val(values, 'compartment_id'))}
COMPARTMENT="$\{COMPARTMENT:-$\{OCI_COMPARTMENT_ID:-}}"
if [[ -z "$COMPARTMENT" ]]; then change_stop 3 "set OCI_COMPARTMENT_ID (or the utility's compartment) to find $SERVER"; fi
SID="$(oci compute instance list --compartment-id "$COMPARTMENT" --display-name "$SERVER" --query 'data[?"lifecycle-state"!=\`TERMINATED\`] | [0].id' --raw-output)"
if [[ -z "$SID" || "$SID" == null ]]; then change_stop 5 "no OCI instance named $SERVER"; fi`;
    default:
      return head;
  }
}

/** The CLI a platform's direct route needs. */
export const CLI_OF                                     = { aws: 'aws', azure: 'az', google: 'gcloud', oci: 'oci', vmware: 'pwsh' };

/** Common instance sizes per platform (a combo: any other type can be typed). */
export const SIZE_OPTIONS                                                = {
  aws: ['t3.medium', 'm7i.large', 'm7i.xlarge', 'm7i.2xlarge', 'm7i.4xlarge', 'r7i.large', 'r7i.xlarge', 'r7i.2xlarge', 'c7i.xlarge', 'c7i.2xlarge'],
  azure: ['Standard_B2s', 'Standard_D2s_v5', 'Standard_D4s_v5', 'Standard_D8s_v5', 'Standard_D16s_v5', 'Standard_E4s_v5', 'Standard_E8s_v5', 'Standard_F4s_v2'],
  google: ['e2-standard-2', 'n2-standard-2', 'n2-standard-4', 'n2-standard-8', 'n2-highmem-4', 'n2-highmem-8', 'c3-standard-4'],
  oci: ['VM.Standard.E5.Flex:1:16', 'VM.Standard.E5.Flex:2:32', 'VM.Standard.E5.Flex:4:64', 'VM.Standard.E5.Flex:8:128', 'VM.Standard3.Flex:2:32'],
  vmware: ['2 vCPU / 8 GiB', '4 vCPU / 16 GiB', '8 vCPU / 32 GiB', '16 vCPU / 64 GiB'],
};

/** An OCI flexible size as `shape:ocpus:memory`, a VCF size as `N vCPU / M GiB`. */
export function parseFlex(size        )                                            {
  const oci = /^([A-Za-z0-9.]+):(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(size.trim());
  if (oci) return { shape: oci[1] , a: Number(oci[2]), b: Number(oci[3]) };
  const vcf = /^(\d+)\s*vCPU\D+(\d+)/i.exec(size.trim());
  if (vcf) return { shape: size, a: Number(vcf[1]), b: Number(vcf[2]) };
  return { shape: size.trim() };
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** An error finding for a required input left empty. */
export function required(values                 , ids                   , findings           )       {
  for (const id of ids) if (!val(values, id)) findings.push(error('change.input.required', `"${id}" is needed.`, { path: id }));
}

export { error, info, warning,               PLATFORM_LABELS };
