/**
 * Switching an application's platform: translating its components through
 * the service equivalence map (terraform/equivalence.ts), and keeping one
 * component set per platform so that nothing is lost on the way.
 *
 * The rules (addendum §A.2.7):
 *
 *  - A `resource` component whose row has the target filled becomes the
 *    target's primary types. Every argument it set is carried through its
 *    attribute map's transform, or listed as uncarried with the reason. All
 *    carried: `mapped`; anything not: `partial`.
 *  - Supporting resources (AWS's split S3 bucket settings) fold into the
 *    target's attributes by concept, on the translation of their primary.
 *  - A row that says `none` for the target, or a type in no row: `no-equivalent`.
 *    The component is never dropped: it stays as it is, as a placeholder with
 *    status `unresolved`, and an error finding names it and the reason.
 *  - `config` components with an OS-level module carry unchanged; cloud
 *    modules go through MODULE_EQUIVALENCE, with their options mapped by name.
 *  - `pattern` components are platform-neutral; they stay, unless the tier
 *    pattern has no service on the target, when the next best is proposed
 *    (never applied).
 *  - References between components (`aws_s3_bucket.logs.id`) are rewritten to
 *    the translated component's address when the target has the attribute.
 *
 * Variants: `AppPlan.variants` holds one component set per platform. Switching
 * to a platform that has one selects it unchanged; switching to one that does
 * not translates the current variant into a new one. So AWS → Azure → AWS
 * gives back the AWS components exactly.
 */

import { error, warning,              } from '../../../core/findings.js';
import { rightsizeFor, OCI_FLEX,                  } from '../../../kit/rightsize.js';
import { resourceSchema } from '../../../terraform/schema-blueprints.js';
import {
  EQUIVALENCE_PLATFORMS,
  attributeFor,
  blueprintIdFor,
  cellOf,
  isNeutralModule,
  moduleBlueprintId,
  moduleFromBlueprintId,
  moduleRowOf,
  nearestRows,
  platformOfModule,
  platformOfType,
  roleIn,
  rowOf,
  unmappedReason,
                       
                      
                    
                   
} from '../../../terraform/equivalence.js';
import { DB_VERSIONS } from '../db-catalog.js';
             
               
          
                  
              
                   
           
                    
              
                     

// ------------------------------------------------------------------ types ---

                                                                        

                                    
                            
                         
                          
 

                                  
                            
                         
                                                                                            
 

                              
                               
                          
                        
                                       
     
                                                                             
                                                                             
                                                
     
                                               
                                                     
                                          
                                               
                                                 
                           
                                                                               
                               
                                                                                      
                                  
                                                                                       
                                       
                                        
 

                                   
                                                                                        
                                              
                                                                                                                      
                                                                                    
                                                                          
                                                                 
                                                                                 
                                      
                                                                                          
                                                                                 
                                                                
                                                                                                   
 

// ------------------------------------------------------- tier patterns ---

const ANYWHERE = 'yes';

/**
 * Where each tier pattern has a service: 'yes', or the reason it has none.
 * Indicative, from the providers' product pages; the pattern catalogue
 * (§A.4.1, WP-17) can override it through `ctx.tierPatternOn`.
 */
export const TIER_PATTERN_SERVICE                                                                    = {
  vm: { aws: ANYWHERE, azure: ANYWHERE, google: ANYWHERE, oci: ANYWHERE, vmware: ANYWHERE },
  'vmware-service': { aws: ANYWHERE, azure: ANYWHERE, google: ANYWHERE, oci: ANYWHERE, vmware: ANYWHERE },
  'paas-web': {
    aws: ANYWHERE, azure: ANYWHERE, google: ANYWHERE,
    oci: 'OCI has no managed web-app platform.',
    vmware: 'VCF has no managed web-app platform.',
  },
  containers: { aws: ANYWHERE, azure: ANYWHERE, google: ANYWHERE, oci: ANYWHERE, vmware: ANYWHERE },
  serverless: { aws: ANYWHERE, azure: ANYWHERE, google: ANYWHERE, oci: ANYWHERE, vmware: 'VCF has no serverless functions service.' },
  'static-site': {
    aws: ANYWHERE, azure: ANYWHERE, google: ANYWHERE,
    oci: 'OCI Object Storage does not serve a static website on its own (verify).',
    vmware: 'VCF has no static-site service.',
  },
  'api-gateway': { aws: ANYWHERE, azure: ANYWHERE, google: ANYWHERE, oci: ANYWHERE, vmware: 'VCF has no API gateway service.' },
  batch: { aws: ANYWHERE, azure: ANYWHERE, google: ANYWHERE, oci: 'No managed batch service is confirmed on OCI (verify).', vmware: 'VCF has no managed batch service.' },
  workflow: { aws: ANYWHERE, azure: ANYWHERE, google: ANYWHERE, oci: 'No managed workflow service is confirmed on OCI (verify).', vmware: 'VCF has no managed workflow service.' },
  'object-storage': { aws: ANYWHERE, azure: ANYWHERE, google: ANYWHERE, oci: ANYWHERE, vmware: 'VCF has no object store.' },
  'managed-db': { aws: ANYWHERE, azure: ANYWHERE, google: ANYWHERE, oci: ANYWHERE, vmware: 'VCF has no managed database service in the catalogued providers.' },
  'file-service': { aws: ANYWHERE, azure: ANYWHERE, google: ANYWHERE, oci: ANYWHERE, vmware: 'vSAN File Services are platform-level, not per application.' },
  'vdi-service': {
    aws: ANYWHERE, azure: ANYWHERE,
    google: 'Google Cloud has no first-party desktop service (verify).',
    oci: ANYWHERE,
    vmware: 'VCF has no first-party desktop service: desktops run as VMs.',
  },
  saas: { aws: ANYWHERE, azure: ANYWHERE, google: ANYWHERE, oci: ANYWHERE, vmware: ANYWHERE },
  'sap-certified': { aws: ANYWHERE, azure: ANYWHERE, google: ANYWHERE, oci: ANYWHERE, vmware: ANYWHERE },
  'managed-messaging': { aws: ANYWHERE, azure: ANYWHERE, google: ANYWHERE, oci: ANYWHERE, vmware: 'VCF has no managed messaging service.' },
  'managed-kafka': { aws: ANYWHERE, azure: ANYWHERE, google: ANYWHERE, oci: ANYWHERE, vmware: 'VCF has no managed Kafka service.' },
  'managed-cache': { aws: ANYWHERE, azure: ANYWHERE, google: ANYWHERE, oci: ANYWHERE, vmware: 'VCF has no managed cache service.' },
  'managed-search': {
    aws: ANYWHERE,
    azure: 'Azure has no managed OpenSearch / Elasticsearch service of its own (verify).',
    google: 'Google Cloud has no managed OpenSearch / Elasticsearch service of its own (verify).',
    oci: ANYWHERE,
    vmware: 'VCF has no managed search service.',
  },
  appliance: { aws: ANYWHERE, azure: ANYWHERE, google: ANYWHERE, oci: ANYWHERE, vmware: ANYWHERE },
  specialist: { aws: ANYWHERE, azure: ANYWHERE, google: ANYWHERE, oci: ANYWHERE, vmware: ANYWHERE },
  retire: { aws: ANYWHERE, azure: ANYWHERE, google: ANYWHERE, oci: ANYWHERE, vmware: ANYWHERE },
  retain: { aws: ANYWHERE, azure: ANYWHERE, google: ANYWHERE, oci: ANYWHERE, vmware: ANYWHERE },
};

/** What to propose in place of a tier pattern with no service: the nearest one that runs anywhere it can. */
const NEXT_BEST_ORDER                                                                 = {
  'paas-web': ['containers', 'vm'],
  serverless: ['containers', 'vm'],
  'static-site': ['object-storage', 'paas-web', 'vm'],
  'api-gateway': ['containers', 'vm'],
  batch: ['containers', 'vm'],
  workflow: ['serverless', 'containers', 'vm'],
  'object-storage': ['vm'],
  'managed-db': ['vm'],
  'file-service': ['vm'],
  'vdi-service': ['vm'],
  'managed-messaging': ['containers', 'vm'],
  'managed-kafka': ['containers', 'vm'],
  'managed-cache': ['containers', 'vm'],
  'managed-search': ['containers', 'vm'],
};

export function tierPatternAvailable(pattern             , platform          )          {
  return TIER_PATTERN_SERVICE[pattern]?.[platform] === ANYWHERE;
}

// ------------------------------------------------------------ helpers ---

const localName = (name        )         => {
  const id = name.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (id === '') return 'this';
  return /^[a-z_]/.test(id) ? id : `r_${id}`;
};

/** A resource's Terraform address as the stack writes it: `<type>.<local name of its label>`. */
export function addressOf(c                   )         {
  return `${c.type}.${localName(c.name)}`;
}

const isSet = (v                    )              => v !== undefined && String(v).trim() !== '';

function osOf(c              , ctx                  )                                  {
  if (typeof ctx.os === 'string') return ctx.os;
  const given = ctx.os?.[c.id];
  if (given) return given;
  if (c.kind === 'resource' && /windows/.test(c.type)) return 'windows';
  if (c.kind === 'resource' && /linux/.test(c.type)) return 'linux';
  return undefined;
}

/** The types a translation to this cell creates: the primaries, with an OS alternative substituted. */
function targetTypesOf(cell              , os                                 )           {
  const types = [...cell.primary];
  const alt = os ? cell.alternatives?.find((a) => a.os === os) : undefined;
  if (alt && types.length > 0) types[0] = alt.type;
  return types;
}

/** Whether a top-level (or dotted) attribute exists in a type's schema; `id` always does. */
function hasAttribute(type        , attr        )          {
  if (attr === 'id') return true;
                                                                                            
  let block = resourceSchema(type)                     ;
  if (!block) return false;
  const parts = attr.split('.');
  for (const [i, part] of parts.entries()) {
    if (i === parts.length - 1) return (block?.a ?? []).some((a) => a[0] === part) || (block?.b ?? []).some((b) => b[0] === part);
    const child = (block?.b ?? []).find((b) => b[0] === part);
    if (!child) return false;
    block = child[4]         ;
  }
  return false;
}

// ------------------------------------------------------------ transforms ---

/** A machine demand, the neutral form of `rightsize` and `db-class`. */
                  
                        
                          
 

                               
                                                                                                                
                                                                                                                                         

const AWS_SIZE_VCPU                                   = {
  nano: 2, micro: 2, small: 2, medium: 2, large: 2, xlarge: 4,
};
const AWS_T_RAM                                   = { nano: 0.5, micro: 1, small: 2, medium: 4, large: 8, xlarge: 16, '2xlarge': 32 };

/** GiB per vCPU by the family's first letter. */
function awsRatio(family        )         {
  const f = family.charAt(0);
  return f === 'c' ? 2 : f === 'r' || f === 'z' || f === 'i' ? 8 : f === 'x' ? 16 : 4;
}

function parseAwsSize(value        )                     {
  const m = /^(?:db\.|cache\.)?([a-z][a-z0-9-]*)\.(nano|micro|small|medium|large|xlarge|(\d+)xlarge)$/.exec(value.trim());
  if (!m) return undefined;
  const family = m[1]          ;
  const size = m[2]          ;
  const vcpu = m[3] ? Number(m[3]) * 4 : (AWS_SIZE_VCPU[size] ?? 2);
  if (family.startsWith('t')) return { vcpu, ramGib: AWS_T_RAM[size] ?? vcpu * 4 };
  return { vcpu, ramGib: vcpu * awsRatio(family) };
}

function parseAzureSize(value        )                     {
  // Standard_D4s_v5, Standard_E8-4ds_v5 (constrained), GP_Standard_D4ds_v5, MO_Standard_E8ds_v5
  const vm = /^(?:(?:GP|MO|B)_)?Standard_([A-Z]+)(\d+)(?:-(\d+))?[a-z]*(?:_v\d+)?$/.exec(value.trim());
  if (vm) {
    const letter = (vm[1]          ).charAt(0);
    const parent = Number(vm[2]);
    const vcpu = vm[3] ? Number(vm[3]) : parent;
    const ratio = letter === 'F' ? 2 : letter === 'E' ? 8 : letter === 'M' ? 28 : letter === 'L' ? 8 : 4;
    return { vcpu, ramGib: parent * ratio };
  }
  // Azure SQL Database vCore: GP_Gen5_4, BC_Gen5_8, HS_Gen5_2 — 5.1 GiB per vCore on Gen5.
  const sql = /^(?:GP|BC|HS)_(?:S_)?Gen5_(\d+)$/.exec(value.trim());
  if (sql) return { vcpu: Number(sql[1]), ramGib: Number(sql[1]) * 5.1 };
  return undefined;
}

function parseGoogleSize(value        )                     {
  const v = value.trim();
  const custom = /(?:^|-)custom-(\d+)-(\d+)$/.exec(v);
  if (custom) return { vcpu: Number(custom[1]), ramGib: Number(custom[2]) / 1024 };
  const std = /^(?:db-)?[a-z0-9]+-(standard|highmem|highcpu|megamem|ultramem)-(\d+)$/.exec(v);
  if (std) {
    const n = Number(std[2]);
    const ratio = std[1] === 'highmem' ? 8 : std[1] === 'highcpu' ? 1 : std[1] === 'standard' ? 4 : 15;
    return { vcpu: n, ramGib: n * ratio };
  }
  const shared                                   = { 'e2-micro': { vcpu: 2, ramGib: 1 }, 'e2-small': { vcpu: 2, ramGib: 2 }, 'e2-medium': { vcpu: 2, ramGib: 4 } };
  return shared[v];
}

/** Read a demand from a platform's size argument and its companions. */
function demandFrom(platform          , target                 , values                                  )                     {
  const main = values[`r.${target.path}`];
  const c = target.companions ?? {};
  const num = (path                    )                     => {
    const v = path ? values[`r.${path}`] : undefined;
    return isSet(v) && Number.isFinite(Number(v)) ? Number(v) : undefined;
  };
  if (platform === 'vmware') {
    const cpu = num(c.cpu ?? target.path);
    const mib = num(c.memoryMib);
    return cpu !== undefined && mib !== undefined ? { vcpu: cpu, ramGib: mib / 1024 } : undefined;
  }
  if (platform === 'oci') {
    const ocpus = num(c.ocpus);
    const mem = num(c.memoryGib);
    if (ocpus !== undefined && mem !== undefined) return { vcpu: ocpus * 2, ramGib: mem };
    const fixed = isSet(main) ? /\.(\d+)$/.exec(main.trim()) : null; // VM.Standard2.4: 4 OCPUs, 15 GB each (verify)
    return fixed ? { vcpu: Number(fixed[1]) * 2, ramGib: Number(fixed[1]) * 15 } : undefined;
  }
  if (!isSet(main)) return undefined;
  if (platform === 'aws') return parseAwsSize(main.split(',')[0] ?? main);
  if (platform === 'azure') return parseAzureSize(main);
  return parseGoogleSize(main.replace(/^.*\/machineTypes\//, ''));
}

function fmt(n        )         {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

function renderRightsize(to          , target                 , d        , ctx                  )         {
  const c = target.companions ?? {};
  if (to === 'vmware') {
    return { ok: true, values: { [`r.${c.cpu ?? target.path}`]: String(Math.max(1, Math.ceil(d.vcpu))), ...(c.memoryMib ? { [`r.${c.memoryMib}`]: String(Math.ceil(d.ramGib) * 1024) } : {}) } };
  }
  const fit = rightsizeFor(to               , d.vcpu, d.ramGib, { licenceOptimised: ctx.licenceOptimised === true });
  if (!fit) return { ok: false, reason: `no ${to} size fits ${fmt(d.vcpu)} vCPU / ${fmt(d.ramGib)} GiB` };
  if (to === 'oci') {
    return {
      ok: true,
      values: {
        [`r.${target.path}`]: fit.type,
        ...(c.ocpus ? { [`r.${c.ocpus}`]: String(fit.ocpus ?? Math.ceil(d.vcpu / 2)) } : {}),
        ...(c.memoryGib ? { [`r.${c.memoryGib}`]: String(Math.ceil(fit.ramGib)) } : {}),
      },
    };
  }
  return { ok: true, values: { [`r.${target.path}`]: fit.type } };
}

const EVEN_UP = (n        )         => (n <= 1 ? 1 : Math.ceil(n / 2) * 2);

/**
 * A database class for a demand. The ladders are the providers' published
 * shapes: RDS db.m7i / db.r7i, Azure flexible server GP_Standard_D*ds_v5 /
 * MO_Standard_E*ds_v5, Azure SQL Database GP_Gen5_* (5.1 GiB per vCore), Cloud
 * SQL custom machines (whole even vCPU, 0.9 – 6.5 GiB per vCPU, 256 MiB steps),
 * OCI PostgreSQL Flex with OCPUs and memory (verify). Indicative.
 */
function renderDbClass(to          , target                 , d        )         {
  const c = target.companions ?? {};
  const vcpu = Math.max(1, Math.ceil(d.vcpu));
  const ram = Math.max(1, d.ramGib);
  if (to === 'aws') {
    const fit = rightsizeFor('aws', vcpu, ram);
    if (!fit) return { ok: false, reason: `no RDS class fits ${vcpu} vCPU / ${fmt(ram)} GiB` };
    // RDS offers no c7i: a compute-shaped demand takes the general-purpose class of the same vCPU.
    return { ok: true, values: { [`r.${target.path}`]: `db.${fit.type.replace(/^c7i\./, 'm7i.')}` } };
  }
  if (to === 'azure') {
    if (target.type === 'azurerm_mssql_database') {
      const n = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 32, 40, 80].find((v) => v >= vcpu && v * 5.1 >= ram);
      return n ? { ok: true, values: { [`r.${target.path}`]: `GP_Gen5_${n}` } } : { ok: false, reason: `no Azure SQL Database size fits ${vcpu} vCores / ${fmt(ram)} GiB` };
    }
    const ladder = [2, 4, 8, 16, 32, 48, 64, 96];
    const ratio = ram / vcpu;
    if (ratio <= 4.5) {
      const n = ladder.find((v) => v >= vcpu && v * 4 >= ram);
      if (n) return { ok: true, values: { [`r.${target.path}`]: `GP_Standard_D${n}ds_v5` } };
    }
    const n = ladder.find((v) => v >= vcpu && v * 8 >= ram);
    return n ? { ok: true, values: { [`r.${target.path}`]: `MO_Standard_E${n}ds_v5` } } : { ok: false, reason: `no Azure flexible server size fits ${vcpu} vCPU / ${fmt(ram)} GiB` };
  }
  if (to === 'google') {
    let cpus = EVEN_UP(vcpu);
    if (ram / cpus > 6.5) cpus = EVEN_UP(Math.ceil(ram / 6.5));
    const gib = Math.max(ram, cpus * 0.9);
    const mib = Math.ceil((gib * 1024) / 256) * 256;
    return { ok: true, values: { [`r.${target.path}`]: `db-custom-${cpus}-${mib}` } };
  }
  if (to === 'oci') {
    return {
      ok: true,
      values: {
        [`r.${target.path}`]: target.type === 'oci_psql_db_system' ? 'PostgreSQL.VM.Standard.E5.Flex' : OCI_FLEX.name,
        ...(c.ocpus ? { [`r.${c.ocpus}`]: String(Math.max(1, Math.ceil(vcpu / 2))) } : {}),
        ...(c.memoryGib ? { [`r.${c.memoryGib}`]: String(Math.ceil(ram)) } : {}),
      },
    };
  }
  return { ok: false, reason: 'no database classes on this platform' };
}

// Regions: the nearest region on each cloud. Indicative; the landing zone decides.
const REGION_GEOS                                                         = [
  { aws: 'us-east-1', azure: 'eastus', google: 'us-east4', oci: 'us-ashburn-1' },
  { aws: 'us-east-2', azure: 'centralus', google: 'us-central1', oci: 'us-chicago-1' },
  { aws: 'us-west-2', azure: 'westus2', google: 'us-west1', oci: 'us-phoenix-1' },
  { aws: 'ca-central-1', azure: 'canadacentral', google: 'northamerica-northeast2', oci: 'ca-toronto-1' },
  { aws: 'sa-east-1', azure: 'brazilsouth', google: 'southamerica-east1', oci: 'sa-saopaulo-1' },
  { aws: 'eu-west-2', azure: 'uksouth', google: 'europe-west2', oci: 'uk-london-1' },
  { aws: 'eu-west-1', azure: 'northeurope', google: 'europe-west1' },
  { aws: 'eu-central-1', azure: 'germanywestcentral', google: 'europe-west3', oci: 'eu-frankfurt-1' },
  { azure: 'westeurope', google: 'europe-west4', oci: 'eu-amsterdam-1' },
  { aws: 'eu-west-3', azure: 'francecentral', google: 'europe-west9', oci: 'eu-paris-1' },
  { aws: 'ap-south-1', azure: 'centralindia', google: 'asia-south1', oci: 'ap-mumbai-1' },
  { aws: 'ap-southeast-1', azure: 'southeastasia', google: 'asia-southeast1', oci: 'ap-singapore-1' },
  { aws: 'ap-northeast-1', azure: 'japaneast', google: 'asia-northeast1', oci: 'ap-tokyo-1' },
  { aws: 'ap-southeast-2', azure: 'australiaeast', google: 'australia-southeast1', oci: 'ap-sydney-1' },
];

const LZ_REF = /^(local|var)\.landing_zone\b/;

function isLzExpression(value        )          {
  const parts = value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // The landing-zone contract, a variable, or a reference to another of the app's resources
  // (already rewritten to its address on the target).
  return parts.length > 0 && parts.every((p) => LZ_REF.test(p) || /^var\.[\w.[\]"]+$/.test(p) || /^[a-z][a-z0-9]*_[a-z0-9_]+\.[A-Za-z_][\w-]*\.[\w.]+$/.test(p));
}

function zoneIndex(from          , value        )                     {
  const v = value.trim();
  if (from === 'azure' && /^[1-3]$/.test(v)) return Number(v);
  if (from === 'oci') {
    const m = /AD-(\d)$/i.exec(v);
    return m ? Number(m[1]) : undefined;
  }
  const m = /[0-9-]([a-f])$/.exec(v);
  return m ? (m[1]          ).charCodeAt(0) - 96 : undefined;
}

const DB_PROVIDER_KEY                                                                            = { aws: 'rds', google: 'cloudsql', azure: 'azure', oci: 'oci' };

function dbVersionFrom(from          , value        , rowId        )                          {
  const v = value.trim();
  const key = DB_PROVIDER_KEY[from];
  for (const info of Object.values(DB_VERSIONS)) {
    const spelling = key ? info.providers[key] : undefined;
    if (!spelling) continue;
    const pattern = new RegExp(`^${spelling.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace('\\{EDITION\\}', '[A-Z]+').replace('{EDITION}', '[A-Z]+')}$`);
    if (spelling === v || pattern.test(v)) return info.id;
  }
  // Not a catalogued spelling: the major version, by the row's engine.
  if (rowId.startsWith('db.postgres')) {
    const m = /(\d+)/.exec(v);
    const id = m ? (`pg-${m[1]}`               ) : undefined;
    return id && id in DB_VERSIONS ? id : undefined;
  }
  if (rowId.startsWith('db.mysql')) {
    const m = /(\d+)[._](\d+)/.exec(v);
    const id = m ? (`mysql-${m[1]}.${m[2]}`               ) : undefined;
    return id && id in DB_VERSIONS ? id : undefined;
  }
  return undefined;
}

/** Source value → neutral form. */
function toNeutral(t             , from          , target                 , value        , values                                  , row                )        {
  const v = value.trim();
  switch (t) {
    case 'same':
    case 'gib':
      return t === 'gib' && !Number.isFinite(Number(v)) && !/^(var|local)\./.test(v) ? { ok: false, reason: 'not a size in GiB' } : { ok: true, neutral: v };
    case 'first':
      return { ok: true, neutral: v.split(',')[0]?.trim() ?? v };
    case 'bool':
      return /^(true|false)$/i.test(v) ? { ok: true, neutral: v.toLowerCase() } : { ok: false, reason: 'not true or false' };
    case 'enabled-string':
      return { ok: true, neutral: /^enabled$/i.test(v) ? 'true' : 'false' };
    case 'mib-to-gib':
      return Number.isFinite(Number(v)) ? { ok: true, neutral: fmt(Number(v) / 1024) } : { ok: false, reason: 'not a size in MiB' };
    case 'tags-to-labels':
      return { ok: true, neutral: v };
    case 'lz-subnet':
    case 'lz-sg':
    case 'lz-kms':
      return isLzExpression(v)
        ? { ok: true, neutral: v }
        : { ok: false, reason: `a literal ${t === 'lz-subnet' ? 'subnet' : t === 'lz-sg' ? 'security group' : 'key'} belongs to the source platform; use the landing-zone reference (local.landing_zone…), which carries` };
    case 'region': {
      const geo = REGION_GEOS.findIndex((g) => g[from] === v);
      return geo >= 0 ? { ok: true, neutral: String(geo) } : { ok: false, reason: `no region mapping for ${v}` };
    }
    case 'zone': {
      if (LZ_REF.test(v)) return { ok: true, neutral: v };
      const i = zoneIndex(from, v);
      return i ? { ok: true, neutral: String(i) } : { ok: false, reason: `cannot tell which zone ${v} is` };
    }
    case 'ha-mode':
      return { ok: true, neutral: /^(true|zoneredundant|samezone|regional)$/i.test(v) ? 'true' : 'false' };
    case 'retention': {
      const secs = /^(\d+)s$/.exec(v);
      const days = /^(\d+)d?$/.exec(v);
      if (secs) return { ok: true, neutral: fmt(Number(secs[1]) / 86400) };
      return days ? { ok: true, neutral: days[1]           } : { ok: false, reason: 'not a retention period' };
    }
    case 'db-version': {
      const id = dbVersionFrom(from, v, row.id);
      return id ? { ok: true, neutral: id } : { ok: false, reason: `version ${v} is not in the DB catalog` };
    }
    case 'rightsize':
    case 'db-class': {
      const d = demandFrom(from, target, values);
      return d ? { ok: true, neutral: d } : { ok: false, reason: `cannot read a vCPU / memory size from ${v}` };
    }
  }
}

/** Neutral form → the target's values. */
function fromNeutral(t             , to          , target                 , neutral         , ctx                  )         {
  const key = `r.${target.path}`;
  const one = (value        )         => ({ ok: true, values: { [key]: value } });
  if (typeof neutral !== 'string') {
    return t === 'db-class' ? renderDbClass(to, target, neutral) : renderRightsize(to, target, neutral, ctx);
  }
  switch (t) {
    case 'same':
    case 'gib':
    case 'first':
    case 'bool':
    case 'retention':
    case 'lz-subnet':
    case 'lz-sg':
    case 'lz-kms':
      return one(neutral);
    case 'enabled-string':
      return one(neutral === 'true' ? 'Enabled' : target.type.startsWith('aws_') ? 'Suspended' : 'Disabled');
    case 'mib-to-gib':
      return one(String(Math.round(Number(neutral) * 1024)));
    case 'tags-to-labels':
      return one(
        neutral
          .split('\n')
          .map((line) => line.trim().toLowerCase().replace(/[^a-z0-9_=\-\s]/g, '-'))
          .filter(Boolean)
          .join('\n'),
      );
    case 'region': {
      const r = REGION_GEOS[Number(neutral)]?.[to];
      return r ? one(r) : { ok: false, reason: `no ${to} region near the source region` };
    }
    case 'zone': {
      if (LZ_REF.test(neutral)) return one(neutral);
      const i = Number(neutral);
      const letter = String.fromCharCode(96 + i);
      const region = ctx.regions?.[to];
      if (to === 'azure') return one(String(i));
      if (to === 'aws' && region) return one(`${region}${letter}`);
      if (to === 'google' && region) return one(`${region}-${letter}`);
      // The landing zone's zone list is platform-neutral by contract.
      return one(`local.landing_zone.zones[${i - 1}]`);
    }
    case 'ha-mode':
      if (target.path.endsWith('availability_type')) return one(neutral === 'true' ? 'REGIONAL' : 'ZONAL');
      if (target.path.endsWith('high_availability.mode')) return neutral === 'true' ? one('ZoneRedundant') : { ok: true, values: {} };
      return one(neutral);
    case 'db-version': {
      const info = DB_VERSIONS[neutral               ];
      const k = DB_PROVIDER_KEY[to];
      let spelling = info && k ? info.providers[k] : undefined;
      if (spelling?.includes('{EDITION}')) spelling = spelling.replace('{EDITION}', 'STANDARD');
      if (!spelling && to === 'oci' && neutral.startsWith('pg-')) spelling = neutral.slice(3);
      return spelling ? one(spelling) : { ok: false, reason: `the DB catalog has no ${to} spelling for ${neutral}` };
    }
    case 'rightsize':
    case 'db-class':
      return { ok: false, reason: 'no size' };
  }
}

/** Every block toggle a nested path needs (`b.a`, `b.a.b` for `a.b.c`). */
function withToggles(values                                  )                         {
  const out                         = { ...values };
  for (const key of Object.keys(values)) {
    if (!key.startsWith('r.')) continue;
    const parts = key.slice(2).split('.');
    for (let i = 1; i < parts.length; i++) out[`b.${parts.slice(0, i).join('.')}`] = 'true';
  }
  return out;
}

// ---------------------------------------------------- resources, grouped ---

                 
                                     
                                      
                                        
 

/**
 * Rewrite a reference to another component of the variant to that component's
 * address on the target. Returns the value unchanged when it is no such reference.
 */
function rewriteReference(value        , to          , ctx                  )                                         {
  const m = /^([a-z][a-z0-9]*_[a-z0-9_]+)\.([A-Za-z_][\w-]*)\.([\w.]+)$/.exec(value.trim());
  if (!m) return { value };
  const [, type, name, attr] = m                                               ;
  const sibling = (ctx.siblings ?? []).find((s)                         => s.kind === 'resource' && s.type === type && localName(s.name) === name);
  if (!sibling) return { value };
  if ((platformOfType(sibling.type) ?? to) === to) return { value };
  const row = rowOf(sibling.type, sibling.values);
  const cell = row?.per[to];
  if (!row || !cell || cell.none !== undefined || cell.primary.length === 0) {
    return { reason: `references ${sibling.name}, which has no equivalent on ${to}` };
  }
  const targetType = targetTypesOf(cell, osOf(sibling, ctx))[0]          ;
  if (!hasAttribute(targetType, attr)) return { reason: `references ${sibling.name}.${attr}, which ${targetType} does not have` };
  return { value: `${targetType}.${localName(sibling.name)}.${attr}` };
}

/**
 * Translate one primary resource with the supporting resources that fold into
 * it (or one supporting resource on its own). Returns the target components
 * and, per source component, what was carried and what was not.
 */
function translateGroup(
  lead                   ,
  folded                              ,
  row                ,
  to          ,
  ctx                  ,
)                                                                              {
  const cell = row.per[to]                ;
  const targetTypes = targetTypesOf(cell, osOf(lead, ctx));
  const values = new Map                                (targetTypes.map((t) => [t, {}]));
  const pieces          = [];

  for (const source of [lead, ...folded]) {
    const from = platformOfType(source.type)            ;
    const piece        = { source, carried: [], dropped: [] };
    pieces.push(piece);
    const consumed = new Set        ();

    const put = (target                 , out                                  , argument        , value        )       => {
      const bucket = values.get(target.type) ?? {};
      values.set(target.type, bucket);
      for (const [k, v] of Object.entries(out)) {
        bucket[k] = v;
        piece.carried.push({ argument, value, to: { type: target.type, argument: k.slice(2), value: v } });
      }
    };

    // Sizes first: one demand from the size argument and its companions.
    for (const map of row.attributes) {
      const src = map.per[from];
      if (!src || src.type !== source.type || (src.transform !== 'rightsize' && src.transform !== 'db-class')) continue;
      const keys = [...new Set([src.path, ...Object.values(src.companions ?? {})])].map((p) => `r.${p}`).filter((k) => isSet(source.values[k]));
      if (keys.length === 0) continue;
      for (const k of keys) consumed.add(k);
      const dst = map.per[to];
      const shown = keys.map((k) => `${k.slice(2)}=${source.values[k]}`).join(', ');
      if (!dst) {
        for (const k of keys) piece.dropped.push({ argument: k.slice(2), value: source.values[k]          , reason: `no ${to} equivalent for ${map.concept}` });
        continue;
      }
      const neutral = toNeutral(src.transform, from, src, source.values[`r.${src.path}`] ?? '', source.values, row);
      const out = neutral.ok ? fromNeutral(dst.transform ?? src.transform, to, dst, neutral.neutral, ctx) : neutral;
      if (!out.ok) {
        for (const k of keys) piece.dropped.push({ argument: k.slice(2), value: source.values[k]          , reason: out.reason });
        continue;
      }
      put(dst, out.values, keys.map((k) => k.slice(2)).join(' + '), shown);
    }

    for (const [key, raw] of Object.entries(source.values)) {
      // Provider settings (p.*) belong to the provider block, which the target's own stack writes;
      // block toggles (b.*) follow from the arguments inside them.
      if (!key.startsWith('r.') || consumed.has(key) || !isSet(raw)) continue;
      const path = key.slice(2);
      // A folded resource's link to its primary (bucket = aws_s3_bucket.logs.id) is what folding carries.
      if (source !== lead && raw.trim().startsWith(`${addressOf(lead)}.`)) {
        piece.carried.push({ argument: path, value: raw, to: { type: targetTypes[0]          , argument: '(folded into this resource)', value: raw } });
        continue;
      }
      const found = attributeFor(row, from, source.type, path);
      if (!found) {
        piece.dropped.push({ argument: path, value: raw, reason: 'no mapped attribute' });
        continue;
      }
      const src = found.map.per[from]                   ;
      const dst = found.map.per[to];
      if (!dst) {
        piece.dropped.push({ argument: path, value: raw, reason: `no ${to} equivalent for ${found.map.concept}` });
        continue;
      }
      const ref = rewriteReference(raw, to, ctx);
      if ('reason' in ref) {
        piece.dropped.push({ argument: path, value: raw, reason: ref.reason });
        continue;
      }
      const transform = src.transform ?? 'same';
      const neutral = toNeutral(transform, from, src, ref.value, source.values, row);
      const out = neutral.ok ? fromNeutral(dst.transform ?? transform, to, dst, neutral.neutral, ctx) : neutral;
      if (!out.ok) {
        piece.dropped.push({ argument: path, value: raw, reason: out.reason });
        continue;
      }
      put(dst, out.values, path, raw);
    }
  }

  // A target type that needs a name gets the component's, rather than becoming a variable.
  const nameMap = row.attributes.find((m) => m.concept === 'name')?.per[to];
  const components                      = [];
  const order = [...targetTypes, ...[...values.keys()].filter((t) => !targetTypes.includes(t))];
  order.forEach((type, i) => {
    const bucket = values.get(type) ?? {};
    if (nameMap && nameMap.type === type && !isSet(bucket[`r.${nameMap.path}`])) bucket[`r.${nameMap.path}`] = lead.name;
    const carried = pieces.reduce((n, p) => n + p.carried.length, 0);
    const dropped = pieces.flatMap((p) => p.dropped);
    components.push({
      kind: 'resource',
      id: i === 0 ? lead.id : `${lead.id}-${type.slice(type.indexOf('_') + 1).replace(/_/g, '-')}`,
      name: i === 0 ? lead.name : `${lead.name} ${type.slice(type.indexOf('_') + 1).replace(/_/g, ' ')}`,
      tier: lead.tier,
      type,
      blueprintId: blueprintIdFor(type),
      values: withToggles(bucket),
      status: dropped.length === 0 ? 'ok' : 'partial',
      translatedFrom: { platform: platformOfType(lead.type)            , componentId: lead.id, carried, dropped },
    });
  });
  return { components, pieces, targetTypes: order };
}

/** The supporting components of a variant that fold into `primary` (same row, and pointing at it or the only one). */
function foldedInto(primary                   , row                , siblings                         )                      {
  const address = addressOf(primary);
  const primaries = siblings.filter((s)                         => s.kind === 'resource' && s !== primary && rowOf(s.type, s.values) === row && roleIn(row, s.type) !== 'supporting');
  return siblings.filter((s)                         => {
    if (s.kind !== 'resource' || s.id === primary.id || roleIn(row, s.type) !== 'supporting' || !cellOf(row, s.type)) return false;
    const pointsAt = Object.values(s.values).some((v) => v.startsWith(`${address}.`));
    const pointsElsewhere = primaries.some((p) => Object.values(s.values).some((v) => v.startsWith(`${addressOf(p)}.`)));
    return pointsAt || (primaries.length === 0 && !pointsElsewhere);
  });
}

/** The primary a supporting component folds into, if the variant has one. */
function primaryFor(supporting                   , row                , siblings                         )                                {
  return siblings.find(
    (s)                         => s.kind === 'resource' && s.id !== supporting.id && roleIn(row, s.type) !== 'supporting' && cellOf(row, s.type) !== undefined && foldedInto(s, row, siblings).some((f) => f.id === supporting.id),
  );
}

// ------------------------------------------------------------ one component ---

function placeholder(c              , from          , to          , reason        , extra                       = {})              {
  return {
    componentId: c.id,
    from,
    to,
    outcome: 'no-equivalent',
    components: [{ ...c, status: 'unresolved', translatedFrom: { platform: from, componentId: c.id, carried: 0, dropped: [] } }                ],
    targetTypes: [],
    carried: [],
    dropped: [],
    reason,
    findings: [
      error('translate.no-equivalent', `${c.name} has no equivalent on ${to}: ${reason}`, {
        path: c.id,
        remediation: `Replace it (Add any service), leave it out on ${to}, or switch back.`,
      }),
    ],
    ...extra,
  };
}

function partialFinding(c              , to          , dropped                              )            {
  if (dropped.length === 0) return [];
  return [
    warning('translate.partial', `${c.name} on ${to}: ${dropped.length} argument(s) not carried — ${dropped.map((d) => `${d.argument} (${d.reason})`).join('; ')}.`, {
      path: c.id,
      remediation: 'Set these on the translated component; the form highlights them.',
    }),
  ];
}

function translateResource(c                   , from          , to          , ctx                  )              {
  const own = platformOfType(c.type) ?? from;
  if (own === to) {
    return { componentId: c.id, from, to, outcome: 'mapped', components: [c], targetTypes: [c.type], carried: [], dropped: [], findings: [] };
  }
  const row = rowOf(c.type, c.values);
  if (!row) return placeholder(c, from, to, unmappedReason(c.type) ?? 'not in the equivalence map');
  const cell = row.per[to];
  if (!cell || cell.none !== undefined || cell.primary.length === 0) {
    return placeholder(c, from, to, cell?.none ?? `the equivalence map has nothing for ${to}`, { nearest: nearestRows(row, to).map((r) => r.id) });
  }

  const siblings = ctx.siblings ?? [];
  if (roleIn(row, c.type) === 'supporting') {
    const primary = primaryFor(c, row, siblings);
    if (primary) {
      const group = translateGroup(primary, foldedInto(primary, row, siblings), row, to, ctx);
      const piece = group.pieces.find((p) => p.source.id === c.id)         ;
      return {
        componentId: c.id, from, to,
        outcome: piece.dropped.length === 0 ? 'mapped' : 'partial',
        components: [],
        targetTypes: group.targetTypes,
        carried: piece.carried,
        dropped: piece.dropped,
        foldedInto: primary.id,
        findings: partialFinding(c, to, piece.dropped),
      };
    }
  }

  const folded = roleIn(row, c.type) === 'supporting' ? [] : foldedInto(c, row, siblings);
  const group = translateGroup(c, folded, row, to, ctx);
  const piece = group.pieces[0]         ;
  return {
    componentId: c.id, from, to,
    outcome: piece.dropped.length === 0 ? 'mapped' : 'partial',
    components: group.components,
    targetTypes: group.targetTypes,
    carried: piece.carried,
    dropped: piece.dropped,
    findings: partialFinding(c, to, piece.dropped),
  };
}

function translatePattern(c                  , from          , to          , ctx                  )              {
  const settings = Object.entries(c.settings).filter(([, v]) => isSet(v));
  const carried = settings.map(([k, v]) => ({ argument: k, value: v, to: { type: 'pattern', argument: k, value: v } }));
  const tp = c.tierPattern;
  const available = tp === undefined || (ctx.tierPatternOn ? ctx.tierPatternOn(tp, to) : tierPatternAvailable(tp, to));
  if (!available && tp) {
    const proposal = ctx.nextBest ? ctx.nextBest(c, to) : (NEXT_BEST_ORDER[tp] ?? ['vm']).find((p) => tierPatternAvailable(p, to));
    const reason = TIER_PATTERN_SERVICE[tp]?.[to] ?? `${tp} has no service on ${to}`;
    return placeholder(c, from, to, reason, proposal ? { proposal } : {});
  }
  return {
    componentId: c.id, from, to, outcome: 'mapped',
    components: [{ ...c, status: 'ok', translatedFrom: { platform: from, componentId: c.id, carried: carried.length, dropped: [] } }],
    targetTypes: [], carried, dropped: [], findings: [],
  };
}

function translateConfig(c                 , from          , to          )              {
  const unchanged = ()              => ({
    componentId: c.id, from, to, outcome: 'mapped', components: [c], targetTypes: [], carried: [], dropped: [], findings: [],
  });
  const fqcn = moduleFromBlueprintId(c.blueprintId);
  // Canned roles (mig_*, pattern roles) and OS-level modules act on the guest: platform-neutral.
  if (!fqcn || isNeutralModule(fqcn)) return unchanged();
  const own = platformOfModule(fqcn);
  if (!own || own === to) return unchanged();
  const mrow = moduleRowOf(fqcn);
  if (!mrow) return placeholder(c, from, to, `${fqcn} is not in the module equivalence map`);
  const target = mrow.per[to];
  if (!target || 'none' in target) return placeholder(c, from, to, target && 'none' in target ? target.none : `nothing for ${to}`);

  const values                         = {};
  const carried                    = [];
  const dropped                      = [];
  for (const [key, value] of Object.entries(c.values)) {
    if (!key.startsWith('r.') && !key.startsWith('b.')) {
      values[key] = value; // play settings: hosts, become, check mode
      continue;
    }
    if (key.startsWith('b.') || !isSet(value)) continue;
    const option = key.slice(2);
    const concept = Object.entries(mrow.options).find(([, per]) => per[own] === option);
    const mapped = concept?.[1][to];
    if (!mapped) {
      dropped.push({ argument: option, value, reason: 'no mapped option' });
      continue;
    }
    values[`r.${mapped}`] = value;
    carried.push({ argument: option, value, to: { type: target.module, argument: mapped, value } });
  }
  const component                  = {
    ...c,
    blueprintId: moduleBlueprintId(target.module),
    values: withToggles(values),
    status: dropped.length === 0 ? 'ok' : 'partial',
    translatedFrom: { platform: from, componentId: c.id, carried: carried.length, dropped },
  };
  return {
    componentId: c.id, from, to,
    outcome: dropped.length === 0 ? 'mapped' : 'partial',
    components: [component], targetTypes: [], carried, dropped,
    findings: partialFinding(c, to, dropped),
  };
}

/**
 * What one component becomes on another platform. Pure: it creates no
 * variant, so Compare calls it for every platform. Pass the variant as
 * `ctx.siblings` so references and supporting folds resolve.
 */
export function translateComponent(c              , from          , to          , ctx                   = {})              {
  if (from === to) {
    return { componentId: c.id, from, to, outcome: 'mapped', components: [c], targetTypes: c.kind === 'resource' ? [c.type] : [], carried: [], dropped: [], findings: [] };
  }
  if (c.kind === 'pattern') return translatePattern(c, from, to, ctx);
  if (c.kind === 'config') return translateConfig(c, from, to);
  return translateResource(c, from, to, ctx);
}

// --------------------------------------------------------------- variants ---

                                     
                                               
                                                
                                        
 

/**
 * A whole variant on another platform. Every source component is accounted
 * for: translated, folded into its primary, or kept as an `unresolved`
 * placeholder. Component order follows the source.
 */
export function translateVariant(components                         , from          , to          , ctx                   = {})                     {
  const inner                   = { ...ctx, siblings: components };
  const translations = components.map((c) => translateComponent(c, from, to, inner));
  const seen = new Set        ();
  const out                 = [];
  for (const t of translations) {
    for (const c of t.components) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
    }
  }
  return { components: out, translations, findings: translations.flatMap((t) => t.findings) };
}

/** Compare's cell: what every component would become on `to`, without creating a variant. */
export const previewTranslation = translateVariant;

                               
                         
                                                                                                       
                            
                           
                                                
                                        
 

/**
 * Switch an application to a platform. An existing variant is selected
 * unchanged; otherwise the current one is translated into a new variant. The
 * other variants are never touched.
 */
export function switchPlatform(plan         , to          , ctx                                                  = {})               {
  const existing = plan.variants[to];
  if (existing) {
    return { plan: { ...plan, platform: to }, created: false, translations: [], findings: variantFindings(plan, to) };
  }
  const from = ctx.from ?? (plan.platform && plan.variants[plan.platform] ? plan.platform : EQUIVALENCE_PLATFORMS.find((p) => plan.variants[p]));
  const source = from ? plan.variants[from] ?? [] : [];
  const result = from ? translateVariant(source, from, to, ctx) : { components: [], translations: [], findings: [] };
  const next          = { ...plan, platform: to, variants: { ...plan.variants, [to]: result.components } };
  return { plan: next, created: true, ...(from ? { from } : {}), translations: result.translations, findings: variantFindings(next, to) };
}

/**
 * The findings for a variant as it stands: an error per unresolved component
 * not accepted as left out (it blocks this app's generation on the platform),
 * a warning per partial one.
 */
export function variantFindings(plan         , platform          )            {
  const leftOut = new Set(plan.leftOut?.[platform] ?? []);
  const findings            = [];
  for (const c of plan.variants[platform] ?? []) {
    if (c.status === 'unresolved' && !leftOut.has(c.id)) {
      const kind = c.kind === 'resource' ? c.type : c.kind === 'pattern' ? (c.tierPattern ?? 'pattern') : c.blueprintId;
      findings.push(
        error('translate.no-equivalent', `${c.name} (${kind}) has no equivalent on ${platform}; generation on ${platform} is blocked until it is replaced, left out, or the app switches back.`, {
          path: c.id,
          remediation: `Replace it (Add any service), or accept "Leave out on ${platform}".`,
        }),
      );
    } else if (c.status === 'partial' && c.translatedFrom) {
      findings.push(...partialFinding(c, platform, c.translatedFrom.dropped));
    }
  }
  return findings;
}

/** Accept dropping a component on one platform ("Leave out on <platform>"). The caller records the decision. */
export function leaveOut(plan         , platform          , componentId        )          {
  const current = plan.leftOut?.[platform] ?? [];
  if (current.includes(componentId)) return plan;
  return { ...plan, leftOut: { ...(plan.leftOut ?? {}), [platform]: [...current, componentId] } };
}
