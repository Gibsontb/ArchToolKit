/**
 * Ansible composition: a decided, designed plan becomes one Ansible project
 * (base design 2.7.4, addendum A.12.3), built with the kit's `buildSite` from
 * the "From a migration plan" blueprints:
 *
 *   planToSite    the site items, in order, each with the host pattern it runs
 *                 on and the answers the plan gives it;
 *   ansibleFiles  those items built into `ansible/` (playbooks/, roles/,
 *                 site.yml), plus the inventories, group_vars, host_vars,
 *                 vault.yml.example, the README and the settings envelope the
 *                 Ansible page loads.
 *
 * Site order (NN is the playbook number):
 *
 *   00 reachable   10 Linux baseline   11 Windows baseline
 *   12 VMware Tools removal   13 cloud agents   14 source tools (when the kit has it)
 *   15 domain controllers   20 / 21 domain join
 *   30 Oracle  31 SQL Server (Windows)  32 SQL Server (Linux)  33 availability groups
 *   34 PostgreSQL  35 MySQL / MariaDB
 *   40 IIS  41 NGINX   45 app configuration components, in their order
 *   50 monitoring   60 validate
 *
 * An item is left out when its pattern matches no host. Plays that run
 * everywhere use `all:!sources`, so the source machines listed for the freeze
 * steps are never configured.
 *
 * The layout is the kit's `playbookDir` layout: playbooks/ with the
 * templates and files beside them, roles/ at the top (roles_path), and
 * group_vars/ and host_vars/ under inventory/, which Ansible reads for
 * playbooks in any folder.
 */

import { info, warning,              } from '../../../core/findings.js';
import { readYaml,               } from '../../../core/yaml-read.js';
                                                   
import { findAnsibleBlueprint } from '../../../ansible/blueprints/index.js';
import { collectionVersion } from '../../../ansible/module-blueprints.js';
import { buildSite } from '../../../ansible/site.js';
import { renderYaml,                } from '../../../ansible/yaml.js';
                                                           
import { writeSettings } from '../../../kit/settings-file.js';
                                                                        
import { PLATFORM_LABELS, slugName } from '../options.js';
                                                                                                                         
import {
  componentGroup, DYNAMIC_FILES, DYNAMIC_PLUGINS, dynamicInventory, groupsInPattern, groupVars, hostsMatching, hostVarsFor,
  inventoryModel, onPremDcAddresses, renderHostVars, safeGroup, skeletonInventory, sourcesInventory, vaultExample, vaultNamesIn,
  vmwareInventory,                                                                      
} from './inventory.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

                                                                 
                                                                       
                                    
 

                           
                              
                             
                                                             
                                 
                               
 

/** The folder the playbooks go in. */
export const PLAYBOOK_DIR = 'playbooks';
/** Where the project sits in the generated zip. */
export const ANSIBLE_ROOT = 'ansible';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Short cloud names, for item labels (and so playbook file names). */
const CLOUD_NAME                                     = { aws: 'AWS', azure: 'Azure', google: 'Google Cloud', oci: 'OCI', vmware: 'VCF' };

const HARDENING                                             = { 'cis-l1': 'cis-l1', 'cis-l2': 'cis-l2', stig: 'stig', internal: 'none' };

/** Keep only the answers a blueprint declares (a lazily loaded one keeps all), as strings. */
function declared(bp           , values                                  )                         {
  if (bp.inputs.length === 0) return { ...values };
  const ids = new Set(bp.inputs.map((i) => i.id));
  return Object.fromEntries(Object.entries(values).filter(([k]) => ids.has(k)));
}

/** The playbook number an item id carries (`mig:NN:<key>`). */
function numberOf(item           )                     {
  const m = /^mig:(\d{2}):/.exec(item.id);
  return m ? Number(m[1]) : undefined;
}

/** A name of at most 15 characters (NetBIOS), for cluster and listener names. */
const netbios = (s        )         => s.replace(/[^A-Za-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 15).replace(/-+$/, '');

// ---------------------------------------------------------------------------
// planToSite
// ---------------------------------------------------------------------------

/**
 * The site items for a plan, in order, with the values the Ansible page would
 * save for them. Nothing is built here.
 */
export function planToSite(plan      , decision              , design              , options                    = {})           {
  const lookup = options.lookup ?? findAnsibleBlueprint;
  const model = inventoryModel(plan, decision, design, options);
  const findings            = [...model.findings];
  const items              = [];
  const everyone = [...model.hosts, ...model.sources];
  const req = plan.requirements;
  const hyperscalers = model.platforms.filter((p)                       => p !== 'vmware' && model.hosts.some((h) => h.groups.includes(`platform_${p}`)));
  const platform = hyperscalers[0] ?? 'vmware';
  const domain = req.identity.domain?.trim() ?? '';
  const joins = req.identity.adStrategy !== 'none' && domain !== '';
  const dcDns = onPremDcAddresses(plan, decision).join(',');

  /** Add an item when its blueprint exists and its pattern matches a host. */
  const add = (nn        , key        , blueprintId        , label        , values                        , optional = false)          => {
    const bp = lookup(blueprintId);
    if (!bp) {
      if (!optional) findings.push(warning('plan.ansible.blueprint-missing', `${label}: the Ansible kit has no ${blueprintId} blueprint, so it is not in the site.`));
      return false;
    }
    const hosts = values.hosts ?? 'all';
    if (hostsMatching(hosts, everyone).length === 0) return false;
    items.push({ id: `mig:${String(nn).padStart(2, '0')}:${key}`, blueprintId, label, values: declared(bp, values) });
    return true;
  };

  const everywhere = 'all:!sources';
  add(0, 'reachable', 'mig_reachable', 'Wait for the hosts', { hosts: everywhere, timeout: '600' });
  add(10, 'linux-baseline', 'mig_linux_baseline', 'Linux baseline', {
    hosts: 'os_kind_linux', platform, timezone: 'UTC', hardening: HARDENING[req.securityBaseline] ?? 'none', licence: 'li',
    update_packages: 'true', reboot: 'true', selinux: 'true', allowed_tcp_ports: '22',
  });
  add(11, 'windows-baseline', 'mig_windows_baseline', 'Windows baseline', {
    hosts: 'os_kind_windows', platform, timezone: 'UTC', hardening: HARDENING[req.securityBaseline] ?? 'none', licence: 'li',
    domain_join: joins ? 'true' : 'false', update: 'true', allowed_tcp_ports: '5986',
  });
  if (hyperscalers.length > 0) {
    const onClouds = hyperscalers.map((p) => `platform_${p}`).join(':');
    add(12, 'vmware-tools', 'mig_vmware_tools_removal', 'Remove VMware Tools', { hosts: `${onClouds}:&method_replicate`, platform });
    add(13, 'cloud-agents', 'mig_cloud_agents', 'Cloud guest agents', { hosts: onClouds, platform });
  }
  // The source-platform tools a replication tool leaves behind (addendum A.3.5); added when the kit has the play.
  add(14, 'source-tools', 'mig_source_tools', 'Source platform tools', { hosts: 'method_replicate', platform }, true);

  // Domain controllers: one play per platform, since the AD site is the platform's.
  for (const pd of design.platforms) {
    if (pd.identity.strategy !== 'extend-dcs' || pd.platform === 'vmware' || !domain) continue;
    const subnets = pd.networks.flatMap((n) => [n.cidr, ...(n.ipv6Cidr ? [n.ipv6Cidr] : [])]);
    add(15, `dc-${pd.platform}`, 'mig_ad_dc_promote', `Domain controllers ${CLOUD_NAME[pd.platform]}`, {
      hosts: `role_ad_dc:&platform_${pd.platform}`, mode: 'extend', domain, site_name: `${pd.platform}-${pd.region}`,
      site_subnets: subnets.join(','), dns_servers: dcDns, kds_root_key: 'true',
    });
  }
  if (joins) {
    add(20, 'windows-join', 'mig_windows_domain_join', 'Join Windows to the domain', {
      hosts: 'os_kind_windows:!role_ad_dc', domain, ou: req.identity.computerOu?.trim() ?? '', dns_servers: dcDns,
    });
    if (req.identity.linuxJoin === 'realmd-sssd') {
      add(21, 'linux-join', 'mig_linux_domain_join', 'Join Linux to the domain', { hosts: 'os_kind_linux', domain, ou: req.identity.computerOu?.trim() ?? '' });
    }
  }

  // Databases on VMs: installed on rebuilt hosts; a replicated host brings its database with it.
  const engineDefault = (engine        )         => {
    const hit = model.dbHosts.find((d) => d.db.engine === engine);
    return hit ? hit.db.version : '';
  };
  add(30, 'oracle', 'mig_oracle_db', 'Oracle Database', { hosts: 'db_oracle:!method_replicate', version: engineDefault('oracle') === 'oracle-26ai' ? '26ai' : '19c', edition: 'ee' });
  // gMSA service accounts need the domain; without one, SQL Server runs as its virtual accounts.
  add(31, 'mssql-windows', 'mig_mssql_windows', 'SQL Server on Windows', {
    hosts: 'db_sqlserver:&os_kind_windows:!method_replicate', ...(joins ? { domain, service_account_mode: 'gmsa' } : { service_account_mode: 'virtual' }),
  });
  add(32, 'mssql-linux', 'mig_mssql_linux', 'SQL Server on Linux', { hosts: 'db_sqlserver:&os_kind_linux:!method_replicate' });
  for (const ag of model.ags) {
    const slug = slugName(ag.db.name) || 'ag';
    const hosts = model.ags.length === 1 ? 'db_sqlserver_ag' : ag.group;
    const values                         = {
      hosts, platform: ag.platform === 'vmware' ? 'vmware' : ag.platform, ag_name: netbios(slug), database: ag.db.name,
      cluster_name: netbios(`${slug}-clu`), primary: ag.hosts[0]?.name ?? '', listener_name: netbios(`${slug}-lsn`),
    };
    if (add(33, `ag-${safeGroup(slug)}`, 'mig_mssql_ag', `SQL Server AG ${ag.db.name}`, values) && ag.platform !== 'azure') {
      findings.push(warning('plan.ansible.ag-addresses', `${ag.db.name}: the cluster and the listener need a static address in each subnet on ${PLATFORM_LABELS[ag.platform]}; set cluster_ips and listener_ips on the AG item before running.`));
    }
  }
  const clientCidrs = design.platforms.flatMap((pd) => pd.networks.flatMap((n) => [n.cidr, ...(n.ipv6Cidr ? [n.ipv6Cidr] : [])]));
  add(34, 'postgres', 'mig_postgres_server', 'PostgreSQL', { hosts: 'db_postgres:!method_replicate', client_cidrs: clientCidrs.join(','), replication_cidrs: clientCidrs.join(',') });
  add(35, 'mysql', 'mig_mysql_server', 'MySQL or MariaDB', { hosts: 'db_mysql:!method_replicate' });

  add(40, 'iis', 'install_iis', 'IIS web servers', { hosts: 'role_web:&os_kind_windows' });
  add(41, 'nginx', 'nginx_server', 'NGINX web servers', { hosts: 'role_web:&os_kind_linux:!app_planned' });

  // Configuration components of the planned apps, after the roles, in their order.
  for (const ap of plan.appPlans ?? []) {
    if (ap.status === 'draft') continue;
    const app = plan.apps.find((a) => a.id === ap.app);
    const p                       = ap.platform ?? ap.recommendation?.platform;
    if (!app || !p || !model.apps.includes(app.name)) continue;
    const configs = (ap.variants[p] ?? []).flatMap((c) => (c.kind === 'config' ? [c] : [])).sort((a, b) => a.order - b.order);
    for (const c of configs) {
      const group = componentGroup(app.name, c.id, c.name);
      const bp = lookup(c.blueprintId);
      if (!bp) {
        findings.push(warning('plan.ansible.config-unknown', `${app.name}: the ${c.name} configuration's blueprint ${c.blueprintId} is not one the Ansible page has, so it is not in the site.`));
        continue;
      }
      if (!add(45, `cfg-${safeGroup(c.id)}`, c.blueprintId, `${app.name} ${c.name}`, { ...c.values, hosts: group })) {
        findings.push(info('plan.ansible.config-no-hosts', `${app.name}: the ${c.name} configuration applies to no host on the target, so it is left out.`));
      }
    }
  }

  add(50, 'monitoring', 'mig_monitoring', 'Monitoring agents', { hosts: everywhere, platform, siem: req.siem === 'splunk' ? 'splunk' : 'none' });
  if (req.siem === 'splunk') {
    findings.push(info('plan.ansible.splunk', 'The Splunk Universal Forwarder installs from your repository: set the indexers and the package URLs on the monitoring item.'));
  }
  add(60, 'validate', 'mig_validate', 'Validate', { hosts: everywhere, domain: joins ? domain : '' });

  const stackName = `${plan.name}: post-migration configuration`;
  if (items.length === 0) findings.push(info('plan.ansible.empty', 'No host is placed on a target, so there is nothing for Ansible to configure.'));
  return { items, stackName, model, findings };
}

// ---------------------------------------------------------------------------
// requirements.yml, README
// ---------------------------------------------------------------------------

function pinned(collection        )                                     {
  const version = collectionVersion(collection);
  const major = version ? Number(version.split('.')[0]) : NaN;
  return version && Number.isFinite(major) ? { name: collection, version: `>=${version},<${major + 1}.0.0` } : { name: collection };
}

/** requirements.yml with the inventory plugins' collections added (the dynamic configs need them). */
function withInventoryCollections(text                    , platforms                            )         {
  let doc                      ;
  try {
    doc = text ? readYaml(text).documents[0] : undefined;
  } catch {
    doc = undefined;
  }
  const map = doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
  const collections                                       = [];
  for (const c of Array.isArray(map.collections) ? map.collections : []) {
    if (c && typeof c === 'object' && !Array.isArray(c) && typeof c.name === 'string') {
      collections.push({ name: c.name, ...(c.version !== undefined && c.version !== null ? { version: String(c.version) } : {}) });
    }
  }
  const needed = new Set(platforms.map((p) => DYNAMIC_PLUGINS[p].split('.').slice(0, 2).join('.')));
  for (const n of needed) if (!collections.some((c) => c.name === n)) collections.push(pinned(n));
  collections.sort((a, b) => a.name.localeCompare(b.name));
  const out                            = { collections };
  if (Array.isArray(map.roles) && map.roles.length > 0) out.roles = map.roles                        ;
  return renderYaml(out, {
    header: [
      'Every collection and role this project uses: the playbooks\' and roles\' modules,',
      'the inventory plugins and the connection plugins.',
      'Install with:  ansible-galaxy install -r requirements.yml',
    ].join('\n'),
  });
}

const SDKS                                            = {
  aws: 'AWS: boto3 and botocore, and the Session Manager plugin for the AWS CLI (Linux hosts connect through it).',
  azure: 'Azure: the azure.azcollection requirements (`pip install -r ~/.ansible/collections/ansible_collections/azure/azcollection/requirements.txt`).',
  google: 'Google Cloud (GCP): google-auth and requests, and the gcloud CLI (SSH goes through IAP).',
  oci: 'OCI: the oci Python SDK.',
};

function readme(plan      , site          , files                                  , dynamic                            )         {
  // In the order site.yml runs them.
  const playbooks = [...(files['site.yml'] ?? '').matchAll(/import_playbook: (\S+)/g)].map((m) => m[1] ).filter((f) => files[f] !== undefined);
  const rows = playbooks.map((f) => {
    const text = files[f] ?? '';
    const name = /^- name: (.+)$/m.exec(text)?.[1] ?? '';
    const hosts = /^\s+hosts: (.+)$/m.exec(text)?.[1]?.replace(/^["']|["']$/g, '') ?? '';
    return `| \`${f}\` | ${name} | \`${hosts}\` |`;
  });
  const inv = Object.keys(files).filter((f) => f.startsWith('inventory/') && !f.includes('_vars/')).sort();
  const waves = [...new Set(site.model.hosts.map((h) => h.wave).filter((w)              => w !== undefined))].sort((a, b) => a - b);
  return [
    `# ${plan.name}: post-migration configuration`,
    '',
    'An Ansible project that configures the migrated hosts: baseline, cloud agents,',
    'domain join, database installs on VMs, monitoring and validation.',
    'It applies when run; `--check --diff` is there when you want a dry run first.',
    '',
    '## What runs, in order',
    '',
    '`site.yml` imports these:',
    '',
    '| Playbook | What | Hosts |',
    '| --- | --- | --- |',
    ...rows,
    '',
    'A play whose hosts are not in the plan is not generated.',
    '',
    '## Inventory',
    '',
    '`ansible.cfg` points at `inventory/`, which Ansible reads as one inventory:',
    '',
    ...inv.map((f) => `- \`${f}\`${/aws_ec2|azure_rm|gcp_compute|\.oci\.yml/.test(f) ? ' (dynamic, from the atk_* tags Terraform writes)' : f.endsWith('hosts.yml') ? ' (the groups, no hosts)' : f.endsWith('sources.yml') ? ' (the source machines, for freeze and final sync)' : ''}`),
    '',
    'The groups: `platform_<p>`, `os_kind_linux` / `os_kind_windows`, `role_<role>`, `env_<env>`,',
    '`app_<app>`, `wave_<n>`, `db_<engine>`, `method_replicate` / `method_rebuild`, and for',
    'the steps before cutover `wave_<n>_sources` (the sources) and `wave_<n>_test` (test launches).',
    'See them with `ansible-inventory --graph`.',
    '',
    '## Before the first run',
    '',
    '```sh',
    'ansible-galaxy install -r requirements.yml',
    'cp inventory/group_vars/all/vault.yml.example inventory/group_vars/all/vault.yml',
    '# fill it in, then:',
    'ansible-vault encrypt inventory/group_vars/all/vault.yml',
    '```',
    '',
    ...(dynamic.length > 0 ? ['The dynamic inventories need the cloud SDKs in the Python Ansible runs on:', '', ...dynamic.map((p) => `- ${SDKS[p]}`), ''] : []),
    'No credential is written in these files: the cloud inventories use your CLI',
    'sign-in or environment, and every password is a vault variable.',
    '',
    '## Running it',
    '',
    '```sh',
    'ansible-playbook site.yml --ask-vault-pass',
    ...(waves.length > 0 ? [`ansible-playbook site.yml --ask-vault-pass --limit wave_${waves[0]}   # one wave`] : ['ansible-playbook site.yml --ask-vault-pass --limit wave_1   # one wave']),
    'ansible-playbook site.yml --ask-vault-pass --limit app_<app>   # one app',
    'ansible-playbook playbooks/60-validate.yml --ask-vault-pass    # validation on its own',
    '```',
    '',
    '`host_vars/<host>.yml` carries each database host\'s engine settings; set a',
    'variable\'s plain name there (or in `group_vars/<group>.yml`) to change it for',
    'that host or group.',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// ansibleFiles
// ---------------------------------------------------------------------------

/** The Ansible page's envelope for the site. `savedAt` is the plan's, so the file is reproducible. */
export function siteEnvelope(plan      , site          )                          {
  const str = (v                                   )                         => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x ?? '')]));
  const first = site.items[0];
  return {
    kind: 'archtoolkit.ansible-generator',
    version: 1,
    savedAt: plan.savedAt,
    target: 'linux',
    blueprint: first?.blueprintId ?? '',
    values: str(first?.values ?? {}),
    stackName: site.stackName,
    stack: site.items.map((i) => ({ id: i.id, blueprintId: i.blueprintId, label: i.label, values: str(i.values) })),
  };
}

/** Merge a YAML mapping file into another (the second's keys win), for a group_vars file two sources write. */
function mergeVars(a        , b        , header        )         {
  const read = (t        )                           => {
    try {
      const d = readYaml(t).documents[0];
      return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
    } catch {
      return {};
    }
  };
  return renderYaml({ ...read(a), ...read(b) }                        , { header });
}

/**
 * The whole Ansible project, under `ansible/`: the built site, the
 * inventories, group_vars, host_vars and vault.yml.example, the README, and
 * the Ansible page's settings envelope.
 */
export function ansibleFiles(
  plan      ,
  decision              ,
  design              ,
  options                    = {},
)                                                                                            {
  const lookup = options.lookup ?? findAnsibleBlueprint;
  const site = planToSite(plan, decision, design, options);
  const findings            = [...site.findings];
  const { model } = site;
  const files                         = {};
  const envelope = siteEnvelope(plan, site);

  if (site.items.length > 0) {
    const built = buildSite(site.items, lookup, { stackName: site.stackName, playbookDir: PLAYBOOK_DIR, playbookNumber: (item) => numberOf(item) ?? 45, inventory: 'skeleton' });
    for (const f of built.findings) {
      // The site's own hints assume a hand-filled inventory; this project writes it.
      if (f.code === 'ansible.site.empty') continue;
      findings.push({ ...f, ...(f.path ? { path: `${ANSIBLE_ROOT}/${f.path}` } : {}) });
    }
    for (const [path, text] of Object.entries(built.files)) {
      if (path === 'README.md' || path === 'inventory/hosts.yml') continue;
      // Ansible reads group_vars/all/ or group_vars/all.yml, not both: the directory wins,
      // and the vault lives there, so the shared answers go in all/main.yml.
      if (path === 'inventory/group_vars/all.yml') {
        files['inventory/group_vars/all/main.yml'] = text;
        continue;
      }
      files[path] = text;
    }
  }

  // Inventories.
  const dynamic                    = [];
  for (const pd of design.platforms) {
    if (pd.platform === 'vmware') continue;
    if (!model.hosts.some((h) => h.route === 'dynamic' && h.platform === pd.platform)) continue;
    const inv = dynamicInventory(model, pd, findings);
    files[inv.path] = inv.text;
    dynamic.push(pd.platform);
  }
  const vmware = vmwareInventory(model);
  if (vmware) files['inventory/hosts_vmware.yml'] = vmware;
  const sources = sourcesInventory(model);
  if (sources) files['inventory/sources.yml'] = sources;

  // group_vars (merged with any a playbook brought) and host_vars.
  for (const [path, text] of Object.entries(groupVars({ plan, design, model }, findings))) {
    files[path] = files[path] ? mergeVars(files[path] , text, `Variables for the ${path.replace(/^.*group_vars\//, '').replace(/\.ya?ml$/, '')} group.`) : text;
  }
  const hv = hostVarsFor(model, design, findings);
  for (const h of model.hosts) {
    const w = plan.workloads.find((x) => x.id === h.id);
    if (!w) continue;
    const byos = h.kind === 'linux' ? w.licence === 'rhel-byos' || w.licence === 'sles-byos' : w.licence === 'byol-sa' || w.licence === 'byol-perpetual';
    if (!byos || h.method === 'relocate') continue;
    const entry = hv.get(h.name) ?? { header: [], vars: {} };
    entry.header.push('Brings its own OS subscription.');
    entry.vars[h.kind === 'linux' ? 'linux_baseline_licence' : 'windows_baseline_licence'] = h.kind === 'linux' ? 'byos' : 'byol';
    hv.set(h.name, entry);
  }
  for (const [path, text] of Object.entries(renderHostVars(hv))) files[path] = files[path] ? mergeVars(files[path] , text, path) : text;

  // The skeleton: every group a play names, the model uses or group_vars configure.
  const patternGroups = site.items.flatMap((i) => groupsInPattern(String(i.values.hosts ?? '')));
  const modelGroups = [...model.hosts, ...model.sources].flatMap((h) => h.groups);
  const varGroups = Object.keys(files).flatMap((f) => {
    const m = /^inventory\/group_vars\/([a-z0-9_]+)(?:\.yml|\/)/.exec(f);
    return m && m[1] !== 'all' ? [m[1] ] : [];
  });
  files['inventory/hosts.yml'] = skeletonInventory([...patternGroups, ...modelGroups, ...varGroups, 'sources']);

  // requirements.yml: the inventory plugins' collections too.
  if (dynamic.length > 0 || files['requirements.yml']) files['requirements.yml'] = withInventoryCollections(files['requirements.yml'], dynamic);

  files['README.md'] = readme(plan, site, files, dynamic);
  files['archtoolkit-ansible-settings.json'] = writeSettings(envelope                   , 'json');

  // Last, so it sees every name: the vault example lists every vault_ variable the project reads.
  files['inventory/group_vars/all/vault.yml.example'] = vaultExample(vaultNamesIn(files));

  // Findings once each.
  const seen = new Set        ();
  const unique = findings.filter((f) => {
    const k = `${f.code}|${f.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const out                         = {};
  for (const path of Object.keys(files).sort()) out[`${ANSIBLE_ROOT}/${path}`] = files[path] ;
  return { files: out, findings: unique, envelope };
}

export { DYNAMIC_FILES };
