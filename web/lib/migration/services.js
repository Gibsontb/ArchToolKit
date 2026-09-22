/**
 * Which services on the chosen cloud cover what the application needs.
 *
 * The route decides which capabilities are worth listing — a lift-and-shift
 * wants VMs, disks and file shares; a refactor wants containers, an API
 * gateway and an event bus — and each capability is then answered three ways,
 * in order of confidence:
 *
 *   1. the core table below, which is the obvious answer stated outright;
 *   2. the provider catalog, looked up by canonical category, when one is
 *      loaded (the CCSM index of the previous toolkit);
 *   3. a keyword match against the catalog's service names.
 *
 * The catalog is injected rather than read from a global, so the rules are
 * testable without it, and so the page still gives a useful answer when no
 * catalog is present — the core table names real services on its own.
 *
 * Ported from the previous toolkit's EAMME service mapper, with the
 * `PRIMARY:`/`RELATED:` string prefixes replaced by a shape that says which
 * pick is the primary one and how it was chosen.
 */

                                          
                                                     
import { isRegulated, normalizeCompliance } from './evaluate.js';

/** Where the answer came from, so the page can say so. */
                                                                                          

                                 
                              
                         
                           
                                      
                       
 

/**
 * A provider service catalog. The toolkit's own catalogs implement this; so
 * does an empty one, which is what the tests and the offline page use.
 */
                                 
                                              
                                            
                                                                           
                                                                   
                                                                         
                                                             
 

export const EMPTY_CATALOG                 = { services: () => [] };

const LABELS                                   = {
  iam: 'Identity and access',
  monitoring: 'Monitoring and logging',
  secrets: 'Secrets and keys',
  networking: 'Networking',
  security: 'Edge security',
  computeVm: 'Virtual machines',
  blockStorage: 'Block storage',
  fileStorage: 'File storage',
  objectStorage: 'Object storage',
  backupArchive: 'Backup and archive',
  storageTransfer: 'Data transfer',
  managedDb: 'Managed database',
  cache: 'Cache',
  messaging: 'Messaging',
  eventing: 'Eventing',
  apiGateway: 'API gateway',
  containers: 'Containers',
  containerRegistry: 'Container registry',
  serverless: 'Functions',
  integration: 'Integration and workflow',
  ciCd: 'CI/CD',
};

/**
 * The obvious answer per cloud and capability, most preferred first.
 *
 * These are service names, not search terms: when a catalog is loaded they
 * select from it, and when none is, they are the answer.
 */
const CORE                                                                       = {
  aws: {
    iam: ['IAM', 'IAM Identity Center'],
    monitoring: ['CloudWatch', 'CloudTrail', 'X-Ray'],
    secrets: ['Secrets Manager', 'KMS', 'SSM Parameter Store'],
    networking: ['VPC', 'Route 53', 'Direct Connect', 'Transit Gateway'],
    security: ['WAF', 'Shield', 'GuardDuty', 'Security Hub'],
    computeVm: ['EC2'],
    blockStorage: ['EBS'],
    fileStorage: ['EFS', 'FSx for Windows File Server', 'FSx for NetApp ONTAP'],
    objectStorage: ['S3', 'S3 Glacier'],
    backupArchive: ['AWS Backup', 'S3 Glacier Deep Archive'],
    storageTransfer: ['DMS', 'DataSync', 'Transfer Family', 'Snowball'],
    managedDb: ['RDS', 'Aurora', 'DynamoDB'],
    cache: ['ElastiCache'],
    messaging: ['SQS', 'SNS', 'Amazon MQ'],
    eventing: ['EventBridge', 'Kinesis'],
    apiGateway: ['API Gateway'],
    containers: ['EKS', 'ECS', 'Fargate'],
    containerRegistry: ['ECR'],
    serverless: ['Lambda'],
    integration: ['Step Functions', 'AppFlow'],
    ciCd: ['CodePipeline', 'CodeBuild', 'CodeDeploy'],
  },
  azure: {
    iam: ['Microsoft Entra ID'],
    monitoring: ['Azure Monitor', 'Log Analytics', 'Application Insights'],
    secrets: ['Azure Key Vault'],
    networking: ['Virtual Network', 'Azure DNS', 'ExpressRoute', 'Virtual WAN'],
    security: ['Azure Front Door WAF', 'DDoS Protection', 'Defender for Cloud', 'Microsoft Sentinel'],
    computeVm: ['Azure Virtual Machines'],
    blockStorage: ['Azure Managed Disks'],
    fileStorage: ['Azure Files', 'Azure NetApp Files'],
    objectStorage: ['Azure Blob Storage', 'Azure Data Lake Storage'],
    backupArchive: ['Azure Backup', 'Azure Archive Storage'],
    storageTransfer: ['Azure Database Migration Service', 'Azure Data Factory', 'Storage Mover', 'Azure Data Box'],
    managedDb: ['Azure SQL Managed Instance', 'Azure SQL Database', 'Azure Database for PostgreSQL'],
    cache: ['Azure Cache for Redis'],
    messaging: ['Azure Service Bus', 'Azure Queue Storage'],
    eventing: ['Azure Event Grid', 'Azure Event Hubs'],
    apiGateway: ['Azure API Management'],
    containers: ['Azure Kubernetes Service', 'Azure Container Apps'],
    containerRegistry: ['Azure Container Registry'],
    serverless: ['Azure Functions'],
    integration: ['Azure Logic Apps', 'Azure Data Factory'],
    ciCd: ['Azure Pipelines', 'GitHub Actions'],
  },
  gcp: {
    iam: ['Cloud IAM'],
    monitoring: ['Cloud Monitoring', 'Cloud Logging', 'Cloud Trace'],
    secrets: ['Secret Manager', 'Cloud KMS'],
    networking: ['VPC', 'Cloud DNS', 'Cloud Interconnect', 'Cloud NAT'],
    security: ['Cloud Armor', 'Security Command Center'],
    computeVm: ['Compute Engine'],
    blockStorage: ['Persistent Disk'],
    fileStorage: ['Filestore'],
    objectStorage: ['Cloud Storage'],
    backupArchive: ['Backup and DR Service', 'Archive Storage'],
    storageTransfer: ['Database Migration Service', 'Storage Transfer Service', 'Transfer Appliance'],
    managedDb: ['Cloud SQL', 'AlloyDB', 'Spanner'],
    cache: ['Memorystore'],
    messaging: ['Pub/Sub'],
    eventing: ['Eventarc', 'Pub/Sub'],
    apiGateway: ['API Gateway', 'Apigee'],
    containers: ['Google Kubernetes Engine', 'Cloud Run'],
    containerRegistry: ['Artifact Registry'],
    serverless: ['Cloud Functions'],
    integration: ['Workflows', 'Application Integration'],
    ciCd: ['Cloud Build', 'Cloud Deploy'],
  },
  oci: {
    iam: ['OCI Identity and Access Management'],
    monitoring: ['OCI Monitoring', 'OCI Logging'],
    secrets: ['OCI Vault'],
    networking: ['Virtual Cloud Network', 'OCI DNS', 'FastConnect'],
    security: ['OCI Web Application Firewall', 'Cloud Guard'],
    computeVm: ['OCI Compute'],
    blockStorage: ['Block Volume'],
    fileStorage: ['File Storage'],
    objectStorage: ['Object Storage', 'Archive Storage'],
    backupArchive: ['Backup', 'Archive Storage'],
    storageTransfer: ['OCI Database Migration', 'Data Transfer Service'],
    managedDb: ['Autonomous Database', 'Base Database Service', 'MySQL HeatWave'],
    cache: ['OCI Cache with Redis'],
    messaging: ['OCI Queue', 'Streaming'],
    eventing: ['OCI Events', 'Streaming'],
    apiGateway: ['API Gateway'],
    containers: ['Container Engine for Kubernetes'],
    containerRegistry: ['Container Registry'],
    serverless: ['OCI Functions'],
    integration: ['OCI Integration Cloud'],
    ciCd: ['OCI DevOps'],
  },
};

/** Canonical categories, for a catalog that is indexed by them. */
const CATEGORY                                   = {
  iam: 'identity_iam',
  monitoring: 'observability_monitoring',
  secrets: 'security_secrets',
  networking: 'networking_vpc_vnet',
  security: 'security_waf_ddos',
  computeVm: 'compute_vm',
  blockStorage: 'storage_block',
  fileStorage: 'storage_file',
  objectStorage: 'storage_object',
  backupArchive: 'storage_backup_archive',
  storageTransfer: 'storage_transfer',
  managedDb: 'database_relational_managed',
  cache: 'database_cache',
  messaging: 'integration_messaging_queue',
  eventing: 'integration_event_bus',
  apiGateway: 'integration_api_gateway',
  containers: 'containers_kubernetes',
  containerRegistry: 'containers_registry',
  serverless: 'serverless_functions',
  integration: 'integration_workflow_orchestration',
  ciCd: 'devops_ci_cd',
};

/** Words that find a service by name when nothing else has. */
const KEYWORDS                                              = {
  iam: ['iam', 'identity', 'active directory', 'rbac'],
  monitoring: ['monitor', 'logging', 'observability', 'insights'],
  secrets: ['secret', 'key vault', 'kms', 'vault'],
  networking: ['vpc', 'vnet', 'network', 'dns', 'load balancer'],
  security: ['waf', 'firewall', 'ddos', 'threat', 'security'],
  computeVm: ['virtual machine', 'compute', 'instance', 'ec2'],
  blockStorage: ['block', 'disk', 'volume'],
  fileStorage: ['file', 'nfs', 'smb', 'filestore'],
  objectStorage: ['object storage', 'blob', 'bucket', 's3'],
  backupArchive: ['backup', 'archive', 'snapshot', 'recovery'],
  storageTransfer: ['migration service', 'transfer', 'datasync', 'data box', 'snowball'],
  managedDb: ['database', 'sql', 'postgres', 'mysql'],
  cache: ['cache', 'redis', 'memcached'],
  messaging: ['queue', 'messaging', 'service bus'],
  eventing: ['event', 'pub/sub', 'stream', 'kafka'],
  apiGateway: ['api gateway', 'api management', 'apigee'],
  containers: ['kubernetes', 'container app', 'cloud run', 'fargate'],
  containerRegistry: ['container registry', 'artifact registry'],
  serverless: ['functions', 'lambda', 'serverless'],
  integration: ['workflow', 'integration', 'orchestration', 'logic apps', 'step functions'],
  ciCd: ['pipeline', 'build', 'deploy', 'devops'],
};

/** Every route starts from the same four, because every landing zone needs them. */
const BASE = ['iam', 'monitoring', 'secrets', 'networking'];

/** Which capabilities are worth listing for this route. */
export function capabilitiesFor(route       )           {
  switch (route) {
    case 'Rehost':
      return [...BASE, 'computeVm', 'blockStorage', 'fileStorage', 'objectStorage', 'managedDb', 'backupArchive', 'storageTransfer', 'security'];
    case 'Replatform':
      return [...BASE, 'computeVm', 'managedDb', 'containers', 'cache', 'objectStorage', 'backupArchive', 'storageTransfer', 'ciCd', 'security'];
    case 'Refactor':
      return [...BASE, 'containers', 'containerRegistry', 'serverless', 'apiGateway', 'managedDb', 'cache', 'eventing', 'objectStorage', 'ciCd', 'integration'];
    case 'Repurchase':
      return [...BASE, 'apiGateway', 'integration', 'objectStorage', 'storageTransfer', 'security'];
    case 'Retain':
      return [...BASE, 'backupArchive', 'monitoring'];
    case 'Retire':
      return ['objectStorage', 'backupArchive', 'iam'];
    default:
      return [...BASE, 'computeVm', 'objectStorage', 'managedDb'];
  }
}

const lower = (s         )         => String(s ?? '').toLowerCase();

function unique(list                   )           {
  const seen = new Set        ();
  const out           = [];
  for (const item of list) {
    const key = lower(item);
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

/** The catalog's own spelling of a name, when it has one. */
function asCatalogued(names                   , catalogue                   )           {
  if (catalogue.length === 0) return [...names];
  const index = new Map(catalogue.map((s) => [lower(s), s]));
  const out           = [];
  for (const name of names) {
    const exact = index.get(lower(name));
    if (exact) {
      out.push(exact);
      continue;
    }
    const partial = catalogue.find((s) => lower(s).includes(lower(name)));
    if (partial) out.push(partial);
  }
  return out;
}

/** Keyword scoring, kept from the original: exact, then contained, then whole word. */
function closest(catalogue                   , keywords                   , limit        )           {
  const scored                                    = [];
  for (const name of catalogue) {
    const text = lower(name);
    let score = 0;
    for (const keyword of keywords) {
      const k = lower(keyword);
      if (!k) continue;
      if (text === k) score += 25;
      if (text.includes(k)) score += 12;
      if (new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text)) score += 6;
    }
    if (score > 0) scored.push({ name, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.name);
}

/** The database in the intake beats the general answer for `managedDb`. */
function databasePreference(cloud       , database        )                  {
  const db = lower(database);
  if (!db) return null;
  const has = (...words          ) => words.some((w) => db.includes(w));
  if (cloud === 'azure') {
    if (has('sql server', 'mssql')) return ['Azure SQL Managed Instance', 'Azure SQL Database'];
    if (has('postgres')) return ['Azure Database for PostgreSQL'];
    if (has('mysql', 'maria')) return ['Azure Database for MySQL'];
    if (has('oracle')) return ['Oracle Database@Azure'];
  }
  if (cloud === 'aws') {
    if (has('sql server', 'mssql')) return ['RDS for SQL Server'];
    if (has('postgres')) return ['Aurora PostgreSQL', 'RDS for PostgreSQL'];
    if (has('mysql', 'maria')) return ['Aurora MySQL', 'RDS for MySQL'];
    if (has('oracle')) return ['RDS for Oracle'];
    if (has('mongo', 'document')) return ['DocumentDB'];
  }
  if (cloud === 'gcp') {
    if (has('postgres')) return ['AlloyDB', 'Cloud SQL for PostgreSQL'];
    if (has('mysql', 'maria')) return ['Cloud SQL for MySQL'];
    if (has('sql server', 'mssql')) return ['Cloud SQL for SQL Server'];
  }
  if (cloud === 'oci' && has('oracle')) return ['Autonomous Database', 'Base Database Service'];
  return null;
}

/**
 * On regulated data, a service the catalog tags with one of the frameworks the
 * application is in scope for comes first. Without tags, the order is unchanged.
 */
function complianceFirst(cloud       , names                   , app             , catalog                )           {
  if (!catalog.tagsFor || !isRegulated(app.compliance)) return [...names];
  const wanted = new Set(normalizeCompliance(app.compliance));
  const score = (name        )         => {
    const tags = (catalog.tagsFor?.(cloud, name) ?? []).map((t) => lower(t).replace(/\s+/g, '_'));
    let points = 0;
    for (const want of wanted) {
      if (tags.includes(want)) points += 3;
      if (want.startsWith('fedramp') && tags.includes('fedramp')) points += 2;
      if (want === 'itars' && tags.includes('itar')) points += 2;
    }
    return points;
  };
  return [...names].map((name, i) => ({ name, i, points: score(name) })).sort((a, b) => b.points - a.points || a.i - b.i).map((x) => x.name);
}

/** One capability, answered. */
function recommendOne(cloud       , capability        , app             , catalog                )                        {
  const catalogue = catalog.services(cloud);
  const limit = capability.toLowerCase().includes('storage') ? 4 : 3;

  const core = capability === 'managedDb' ? (databasePreference(cloud, app.database) ?? CORE[cloud][capability]) : CORE[cloud][capability];
  let names = asCatalogued(core ?? [], catalogue);
  let how         = 'core';

  if (names.length === 0 && catalog.byCategory && CATEGORY[capability]) {
    const fromCategory = catalog.byCategory(cloud, CATEGORY[capability]          );
    const inCatalogue = asCatalogued(fromCategory, catalogue);
    if (inCatalogue.length > 0) {
      names = inCatalogue;
      how = 'catalog category';
    } else if (fromCategory.length > 0) {
      names = [...fromCategory];
      how = 'catalog candidates';
    }
  }
  if (names.length === 0 && catalogue.length > 0) {
    names = closest(catalogue, KEYWORDS[capability] ?? [capability], limit);
    how = 'closest match';
  }
  // Nothing in the catalog and nothing in the core table: say nothing rather than guess.
  if (names.length === 0) names = [...(core ?? [])];
  if (names.length === 0) return null;

  const ordered = unique(complianceFirst(cloud, names, app, catalog)).slice(0, limit);
  return {
    capability,
    label: LABELS[capability] ?? capability,
    primary: ordered[0]          ,
    related: ordered.slice(1),
    how,
  };
}

/** What to use on the target cloud, capability by capability. */
export function recommendServices(cloud       , route       , app             , catalog                 = EMPTY_CATALOG)                   {
  const out                   = [];
  for (const capability of unique(capabilitiesFor(route))) {
    const one = recommendOne(cloud, capability, app, catalog);
    if (one) out.push(one);
  }
  return out;
}

/* ------------------------------------------------------------------------ *
 * The adapter for the catalogs the previous toolkit loads as globals.
 * ------------------------------------------------------------------------ */

                         
                
                   
                 
                   
              
                 
                       
                       
                    
 
                          
                                                                                            
 
                         
                                             
                                                                                              
 

function legacyName(service         )         {
  if (typeof service === 'string') return service;
  if (service && typeof service === 'object') {
    const s = service                 ;
    return String(s.name ?? s.service ?? s.title ?? s.product ?? s.id ?? '');
  }
  return '';
}

function legacyServiceObjects(provider                            )                  {
  const categories = provider?.serviceCategories;
  const list = Array.isArray(categories) ? categories : categories && typeof categories === 'object' ? Object.values(categories) : [];
  const out                  = [];
  for (const category of list) {
    const services = Array.isArray(category?.services) ? category.services : [];
    for (const service of services) {
      if (typeof service === 'string') out.push({ name: service });
      else if (service && typeof service === 'object') out.push(service                 );
    }
  }
  return out;
}

/**
 * Reads the provider catalogs and the CCSM index the pages already load as
 * `window.CDK`. When they are not present, every method answers empty, which
 * leaves the core table to do the work.
 */
export function globalCatalog(source          = (globalThis                           ).CDK)                 {
  const cdk = (source ?? {})                 ;
  const objectsFor = (cloud       )                  => legacyServiceObjects(cdk.providers?.[cloud]);

  return {
    services: (cloud) => unique(objectsFor(cloud).map(legacyName).filter(Boolean)),
    byCategory: (cloud, categoryId) => {
      const entries = cdk.ccsmIndex?.index?.[categoryId]?.providers?.[cloud] ?? [];
      return entries.map((entry) => String(entry?.name ?? '')).filter(Boolean);
    },
    tagsFor: (cloud, service) => {
      const found = objectsFor(cloud).find((s) => lower(legacyName(s)) === lower(service));
      if (!found) return [];
      const tags = [found.tags, found.compliance, found.frameworks].flatMap((v) => (Array.isArray(v) ? v : [])).map((v) => String(v));
      if (found.fedramp === true) tags.push('fedramp');
      return tags;
    },
  };
}
