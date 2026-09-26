/**
 * Google Cloud blueprints for a migration plan: landing zone, identity,
 * connectivity, compute, databases, Oracle Database@Google Cloud, backup and
 * monitoring.
 *
 * See ./common.ts for the landing-zone contract and the grid formats; the AWS
 * versions in ./aws.ts are the same eight blueprints on another cloud. Every
 * argument written here was checked against the google provider's own schema
 * (8.4.0) with `terraform validate`, by tools/validate-terraform-blueprints.mjs.
 *
 * Google differs from the others in ways the contract absorbs:
 *   - subnets are regional, so every zone key of a tier points at one subnet;
 *   - firewall rules select VMs by network tag, so the "security group" of a
 *     tier is the tag string the compute blueprint puts on its VMs;
 *   - a firewall rule holds one address family, so IPv6 sources get their own.
 */

import { error, info, warning, type Finding } from '../../../core/findings.ts';
import { familyOf } from '../../../core/ip.ts';
import type { Blueprint, BlueprintValues } from '../../../kit/blueprint.ts';
import { num as numberOf, str as valueOf } from '../../../kit/blueprint.ts';
import { GCP_DB_TIERS, GCP_DB_VERSIONS, GCP_MACHINE_TYPES } from '../../../kit/choices.ts';
import { GCP_REGIONS } from '../../../kit/regions.ts';
import type { HclBlock } from '../../hcl.ts';
import { emitFoundation } from '../../index.ts';
import {
  backupInputs,
  monitoringInputs,
  odbInputs,
  odbOciDatabases,
  DB_PORTS,
  DEFAULT_SITES,
  LANDING_ZONE_SOURCE,
  MIGRATION_GROUP,
  SITE_COLUMNS,
  ZONE_LETTERS,
  attrs,
  blk,
  carve,
  carveNetwork,
  cloudInit,
  consumerPreamble,
  cutoverVariable,
  dat,
  dbColumns,
  e,
  gcpLabel,
  gridInput,
  hcl,
  hlist,
  hstrmap,
  ident,
  ignoreChanges,
  insertBeforeClose,
  landingZoneInputs,
  landingZoneLocal,
  landingZoneNote,
  lzRef,
  mainTf,
  migTags,
  oracleRegionFinding,
  output,
  parseBackupTiers,
  parseDbs,
  parseLandingZone,
  parseSites,
  parseVms,
  q,
  res,
  reworkFoundation,
  rname,
  secretVariable,
  sshKeyVariable,
  terraformBlock,
  variable,
  vmColumns,
  vmLocalEntry,
  vmSource,
  winrmBootstrap,
  withHost,
  words,
  x,
  type DbSpec,
  type ImageRef,
  type NetworkSpec,
  type SubnetSpec,
  type VmSpec,
} from './common.ts';

const REGION = 'us-central1';
const TF = () => terraformBlock(['google']);

/** The machine series the planner sizes to; the whole catalogue is too long for a grid cell. */
const SIZES = GCP_MACHINE_TYPES.filter((o) => /^(n2|n2d|e2|c3)-/.test(o.value)).map((o) => o.value);
const DB_TIERS = GCP_DB_TIERS.filter((o) => o.value.startsWith('db-custom-')).map((o) => o.value);
const DB_ENGINES = GCP_DB_VERSIONS.map((o) => o.value);

const failed = (id: string, findings: readonly Finding[]) => ({
  files: { 'main.tf': `# ${id}: nothing was generated; see the findings.\n` },
  findings,
});

/** A dynamic block: `dynamic "<name>" { for_each = ...  content { ... } }`. */
function dyn(name: string, forEach: string, content: Readonly<Record<string, Parameters<typeof attrs>[0][string]>>, blocks: readonly HclBlock[] = []): HclBlock {
  return { type: 'dynamic', labels: [name], attributes: attrs({ for_each: x(forEach) }), blocks: [blk('content', content, blocks)] };
}

/** The customer-managed key, as a zero-or-one list for a dynamic block. */
const kmsList = (lz: string) => `${lz}.kms_key_id == null ? [] : [${lz}.kms_key_id]`;

// ---------------------------------------------------------------------------
// Landing zone
// ---------------------------------------------------------------------------

/** Ports a domain controller in the mgmt tier needs open to the network and to on-premises DCs. */
const AD_TCP = ['53', '88', '135', '389', '445', '464', '636', '3268-3269', '49152-65535'];
const AD_UDP = ['53', '88', '123', '389', '464'];

/** Identity-Aware Proxy's TCP forwarding sources. */
const IAP_V4 = '35.235.240.0/20';
const IAP_V6 = '2600:2d00:1:7::/64';
/** Google's load balancer and health-check sources. */
const LB_V4 = ['35.191.0.0/16', '130.211.0.0/22'];

interface FwRule {
  readonly label: string;
  readonly desc: string;
  readonly targets: readonly string[];
  readonly ranges?: readonly string[];
  readonly sourceTags?: readonly string[];
  readonly allow: readonly { protocol: string; ports?: readonly string[] }[];
}

/** The network tag of a tier: what the firewall targets and the compute blueprint puts on each VM. */
const tierTag = (prefix: string, n: NetworkSpec, tier: string) => rname(prefix, n.name, tier);

function firewallRules(prefix: string, n: NetworkSpec, siteV4: readonly string[], siteV6: readonly string[], iap: boolean): FwRule[] {
  const has = (t: string) => n.tiers.includes(t as never);
  const tag = (t: string) => tierTag(prefix, n, t);
  const all = n.tiers.map(tag);
  const rules: FwRule[] = [];
  const families: { sfx: string; sites: string[]; net: string[]; icmp: string; iap: string }[] = [
    { sfx: '', sites: siteV4.map(q), net: [q(n.cidr)], icmp: 'icmp', iap: q(IAP_V4) },
  ];
  if (n.ipv6) families.push({ sfx: '-v6', sites: siteV6.map(q), net: [`google_compute_network.${n.id}.internal_ipv6_range`], icmp: '58', iap: q(IAP_V6) });
  for (const f of families) {
    const v6 = f.sfx ? ', IPv6' : '';
    // Ansible (SSH, WinRM over HTTPS) from on-premises reaches every tier.
    if (f.sites.length > 0) rules.push({ label: `admin${f.sfx}`, desc: `SSH and WinRM over HTTPS from on-premises${v6}`, targets: all, ranges: f.sites, allow: [{ protocol: 'tcp', ports: ['22', '5986'] }] });
    if (has('mgmt') && f.sites.length > 0) rules.push({ label: `mgmt-rdp${f.sfx}`, desc: `RDP to the mgmt tier from on-premises${v6}`, targets: [tag('mgmt')], ranges: f.sites, allow: [{ protocol: 'tcp', ports: ['3389'] }] });
    if (has('web')) rules.push({ label: `web-https${f.sfx}`, desc: `HTTPS to the web tier from on-premises and the network${v6}`, targets: [tag('web')], ranges: [...f.sites, ...f.net], allow: [{ protocol: 'tcp', ports: ['443'] }] });
    // Domain controllers live in mgmt (extend-dcs): the directory ports from the network and from on-premises DCs.
    if (has('mgmt')) rules.push({ label: `mgmt-ad${f.sfx}`, desc: `Active Directory to the mgmt tier${v6}`, targets: [tag('mgmt')], ranges: [...f.net, ...f.sites], allow: [{ protocol: 'tcp', ports: AD_TCP }, { protocol: 'udp', ports: AD_UDP }] });
    // Path MTU discovery needs ICMP, IPv6 most of all.
    rules.push({ label: `icmp${f.sfx}`, desc: `ICMP from the network and on-premises${v6}`, targets: all, ranges: [...f.net, ...f.sites], allow: [{ protocol: f.icmp }] });
    if (iap) rules.push({ label: `iap${f.sfx}`, desc: `SSH and RDP through Identity-Aware Proxy${v6}`, targets: all, ranges: [f.iap], allow: [{ protocol: 'tcp', ports: ['22', '3389'] }] });
  }
  if (has('web')) rules.push({ label: 'web-lb', desc: 'HTTPS from Google load balancers and health checks', targets: [tag('web')], ranges: LB_V4.map(q), allow: [{ protocol: 'tcp', ports: ['443'] }] });
  if (has('app') && has('web')) rules.push({ label: 'app-from-web', desc: 'All TCP from the web tier', targets: [tag('app')], sourceTags: [tag('web')], allow: [{ protocol: 'tcp' }] });
  if (has('db')) {
    const from = ['app', 'mgmt'].filter(has).map(tag);
    if (from.length > 0) rules.push({ label: 'db-engines', desc: 'Database engine ports from the app and mgmt tiers', targets: [tag('db')], sourceTags: from, allow: [{ protocol: 'tcp', ports: DB_PORTS.map(String) }] });
    // Cluster traffic between database hosts: AG endpoints, RAC interconnect, replication.
    rules.push({ label: 'db-cluster', desc: 'Everything between database hosts', targets: [tag('db')], sourceTags: [tag('db')], allow: [{ protocol: 'all' }] });
  }
  const others = n.tiers.filter((t) => t !== 'mgmt');
  if (has('mgmt') && others.length > 0) {
    rules.push({ label: 'from-mgmt', desc: 'SSH, RDP and WinRM from the mgmt tier', targets: others.map(tag), sourceTags: [tag('mgmt')], allow: [{ protocol: 'tcp', ports: ['22', '3389', '5986'] }] });
  }
  return rules;
}

function firewalls(prefix: string, n: NetworkSpec, siteV4: readonly string[], siteV6: readonly string[], iap: boolean): HclBlock[] {
  return firewallRules(prefix, n, siteV4, siteV6, iap)
    .filter((r) => (r.ranges?.length ?? 0) > 0 || (r.sourceTags?.length ?? 0) > 0)
    .map((r) =>
      res(
        'google_compute_firewall',
        ident(n.id, r.label),
        {
          name: rname(prefix, n.name, r.label).slice(0, 63).replace(/-+$/, ''),
          network: x(`google_compute_network.${n.id}.name`),
          description: r.desc,
          direction: 'INGRESS',
          priority: 1000,
          source_ranges: r.ranges && r.ranges.length > 0 ? x(hlist(r.ranges)) : undefined,
          source_tags: r.sourceTags && r.sourceTags.length > 0 ? [...r.sourceTags] : undefined,
          target_tags: [...r.targets],
        },
        [...r.allow.map((a) => blk('allow', { protocol: a.protocol, ports: a.ports ? [...a.ports] : undefined })), blk('log_config', { metadata: 'INCLUDE_ALL_METADATA' })],
      ),
    );
}

const SUBNET_FLOW_LOGS = [
  '',
  '  log_config {',
  '    aggregation_interval = "INTERVAL_5_SEC"',
  '    flow_sampling        = 0.5',
  '    metadata             = "INCLUDE_ALL_METADATA"',
  '  }',
].join('\n');

function googleLandingZone(): Blueprint {
  return {
    id: 'google_mig_landing_zone',
    label: 'Landing zone (migration)',
    group: MIGRATION_GROUP,
    description: `Dual-stack custom-mode VPCs from the networks grid (built on the network foundation) with flow logs and Cloud NAT, firewall rules per tier by network tag, Identity-Aware Proxy access, a Cloud KMS key, a locked-down log bucket with a project log sink, and the VM service account. ${landingZoneNote}`,
    inputs: landingZoneInputs('google', GCP_REGIONS, REGION),
    emits: [
      'google_compute_network', 'google_compute_subnetwork', 'google_compute_router', 'google_compute_router_nat', 'google_compute_firewall',
      'google_kms_key_ring', 'google_kms_crypto_key', 'google_kms_crypto_key_iam_member', 'google_storage_bucket', 'google_storage_bucket_iam_member',
      'google_logging_project_sink', 'google_service_account', 'google_project_iam_member',
    ],
    build: (values: BlueprintValues) => {
      const findings: Finding[] = [];
      const lz = parseLandingZone(values, REGION, findings);
      if (findings.some((f) => f.severity === 'error')) return failed('google_mig_landing_zone', findings);
      const cmk = lz.keys !== 'provider-managed';
      const project = lz.scope ? q(lz.scope) : 'var.project_id';
      const blocks: (HclBlock | string)[] = [
        TF(),
        { type: 'provider', labels: ['google'], attributes: attrs({ project: lz.scope ? lz.scope : x('var.project_id'), region: lz.region }) },
        ...(lz.scope ? [] : [variable('project_id', 'string', 'The Google Cloud project the landing zone is built in.')]),
        dat('google_compute_zones', 'available', { project: x(project), region: lz.region, status: 'UP' }),
      ];

      const subnetsByNet = new Map<string, SubnetSpec[]>();
      for (const n of lz.networks) {
        const subnets = carveNetwork(n, lz.prefixLen, false, [], findings);
        if (subnets.length === 0) continue;
        subnetsByNet.set(n.id, subnets);
        const out = emitFoundation('google', {
          name: rname(lz.prefix, n.name),
          cidr: n.cidr,
          ipv6: n.ipv6,
          region: lz.region,
          subnets: subnets.map((s) => ({ name: s.short, cidr: s.cidr })),
          tags: { atk_network: n.name },
        });
        findings.push(...out.findings.filter((f) => f.severity !== 'info'));
        blocks.push(
          reworkFoundation(out.files['main.tf'] ?? '', n.id, {
            // The emitter's own firewall rules give way to the per-tier ones below.
            drop: (_kind, [type = '']) => type === 'google_compute_firewall',
            edit: (type, _label, text) => (type === 'google_compute_subnetwork' ? insertBeforeClose(text, SUBNET_FLOW_LOGS) : text),
          }),
        );
        blocks.push(...firewalls(lz.prefix, n, lz.siteV4, n.ipv6 ? lz.siteV6 : [], lz.bastion === 'cloud-native'));
      }
      if (findings.some((f) => f.severity === 'error')) return failed('google_mig_landing_zone', findings);

      blocks.push(dat('google_project', 'landing_zone', { project_id: x(project) }));
      const agent = (domain: string) => x(`"serviceAccount:service-\${data.google_project.landing_zone.number}@${domain}"`);

      // The key everything is encrypted with, and the service agents that may use it.
      if (cmk) {
        blocks.push(
          res('google_kms_key_ring', 'landing_zone', { name: `${lz.prefix}-landing-zone`, location: lz.region, project: x(project) }, [], 'A key ring cannot be deleted: its name stays taken in the project.'),
          res('google_kms_crypto_key', 'landing_zone', {
            name: `${lz.prefix}-landing-zone`,
            key_ring: x('google_kms_key_ring.landing_zone.id'),
            purpose: 'ENCRYPT_DECRYPT',
            rotation_period: '7776000s',
          }, lz.keys === 'hsm' ? [blk('version_template', { algorithm: 'GOOGLE_SYMMETRIC_ENCRYPTION', protection_level: 'HSM' })] : []),
          dat('google_storage_project_service_account', 'landing_zone', { project: x(project) }),
          res('google_kms_crypto_key_iam_member', 'storage_agent', {
            crypto_key_id: x('google_kms_crypto_key.landing_zone.id'),
            role: 'roles/cloudkms.cryptoKeyEncrypterDecrypter',
            member: x('"serviceAccount:${data.google_storage_project_service_account.landing_zone.email_address}"'),
          }),
          res('google_kms_crypto_key_iam_member', 'compute_agent', {
            crypto_key_id: x('google_kms_crypto_key.landing_zone.id'),
            role: 'roles/cloudkms.cryptoKeyEncrypterDecrypter',
            member: agent('compute-system.iam.gserviceaccount.com'),
          }, [], 'Persistent disks encrypted with the key.'),
        );
      }

      // Logs: one bucket, and a project sink of the audit, flow and firewall logs into it.
      blocks.push(
        res('google_storage_bucket', 'logs', {
          name: x(`"${lz.prefix}-logs-\${${project}}"`),
          project: x(project),
          location: lz.region.toUpperCase(),
          storage_class: 'STANDARD',
          uniform_bucket_level_access: true,
          public_access_prevention: 'enforced',
          force_destroy: false,
          labels: x(hcl({ atk_purpose: 'logs' })),
          depends_on: cmk ? x('[google_kms_crypto_key_iam_member.storage_agent]') : undefined,
        }, [
          blk('versioning', { enabled: true }),
          blk('lifecycle_rule', {}, [blk('action', { type: 'Delete' }), blk('condition', { age: lz.retention })]),
          blk('lifecycle_rule', {}, [blk('action', { type: 'Delete' }), blk('condition', { days_since_noncurrent_time: 30, with_state: 'ARCHIVED' })]),
          ...(cmk ? [blk('encryption', { default_kms_key_name: x('google_kms_crypto_key.landing_zone.id') })] : []),
        ]),
        res('google_logging_project_sink', 'landing_zone', {
          name: `${lz.prefix}-landing-zone`,
          project: x(project),
          destination: x('"storage.googleapis.com/${google_storage_bucket.logs.name}"'),
          filter: 'logName:"cloudaudit.googleapis.com" OR logName:"compute.googleapis.com%2Fvpc_flows" OR logName:"compute.googleapis.com%2Ffirewall"',
          unique_writer_identity: true,
        }),
        res('google_storage_bucket_iam_member', 'sink_writer', {
          bucket: x('google_storage_bucket.logs.name'),
          role: 'roles/storage.objectCreator',
          member: x('google_logging_project_sink.landing_zone.writer_identity'),
        }),
      );

      // The identity every VM runs as: logs and metrics out, nothing else.
      blocks.push(
        res('google_service_account', 'vm', {
          account_id: rname(lz.prefix, 'vm').slice(0, 26).replace(/-+$/, '') + '-sa',
          display_name: `${lz.prefix} migrated VMs`,
          project: x(project),
        }),
        res('google_project_iam_member', 'vm_logging', { project: x(project), role: 'roles/logging.logWriter', member: x('"serviceAccount:${google_service_account.vm.email}"') }),
        res('google_project_iam_member', 'vm_monitoring', { project: x(project), role: 'roles/monitoring.metricWriter', member: x('"serviceAccount:${google_service_account.vm.email}"') }),
      );

      // The contract.
      const subnetIds: Record<string, string> = {};
      const tags: Record<string, string> = {};
      const mgmt: string[] = lz.siteV4.map(q);
      if (lz.anyV6) mgmt.push(...lz.siteV6.map(q));
      for (const n of lz.networks) {
        for (const s of subnetsByNet.get(n.id) ?? []) {
          for (let z = 0; z < n.zones; z++) subnetIds[`${n.name}/${s.tier}/${ZONE_LETTERS[z]}`] = `google_compute_subnetwork.${s.label}.id`;
          if (s.tier === 'mgmt') {
            mgmt.push(q(s.cidr));
            if (n.ipv6) mgmt.push(`google_compute_subnetwork.${s.label}.ipv6_cidr_range`);
          }
        }
        for (const t of n.tiers) tags[`${n.name}/${t}`] = tierTag(lz.prefix, n, t);
      }
      const byNet = (f: (n: NetworkSpec) => string) => hcl(Object.fromEntries(lz.networks.map((n) => [n.name, e(f(n))])), 2);
      blocks.push(
        landingZoneLocal('google', {
          prefix: q(lz.prefix),
          region: q(lz.region),
          network_ids: byNet((n) => `google_compute_network.${n.id}.id`),
          subnet_ids: hcl(Object.fromEntries(Object.entries(subnetIds).map(([k, v]) => [k, e(v)])), 2),
          security_group_ids: hcl(tags, 2),
          kms_key_id: cmk ? 'google_kms_crypto_key.landing_zone.id' : 'null',
          log_destination: 'google_storage_bucket.logs.name',
          resource_group: 'null',
          zones: `slice(data.google_compute_zones.available.names, 0, ${lz.maxZones})`,
          mgmt_cidrs: `[${mgmt.join(', ')}]`,
          ipv6: byNet((n) => String(n.ipv6)),
          project,
          network_names: byNet((n) => `google_compute_network.${n.id}.name`),
          service_account: 'google_service_account.vm.email',
        }),
        output('landing_zone', 'local.landing_zone', 'The landing-zone contract: the value of the landing_zone variable of a blueprint used on its own.'),
        ...['network_ids', 'subnet_ids', 'security_group_ids', 'kms_key_id', 'log_destination', 'zones', 'service_account'].map((k) => output(k, `local.landing_zone.${k}`)),
      );
      if (lz.bastion === 'cloud-native') {
        findings.push(info('tf.mig.google-iap', 'Administrative access is Identity-Aware Proxy TCP forwarding: no bastion host and no external address. Grant roles/iap.tunnelResourceAccessor to the administrators.', { path: 'bastion' }));
      }
      findings.push(
        info('tf.mig.google-apis', 'The project needs these APIs enabled before apply: compute, cloudkms, logging, storage, iam, iap, dns, servicenetworking, sqladmin, alloydb, backupdr, osconfig (and oracledatabase for Oracle Database@Google Cloud).', { path: 'scope' }),
        info('tf.mig.google-nat', 'The subnets are private: VMs get no external address. IPv4 out goes through Cloud NAT; internal (ULA) IPv6 reaches the VPC, its peers and on-premises only.', { path: 'networks' }),
      );
      return { files: { 'main.tf': mainTf(blocks, `Google Cloud landing zone: ${lz.prefix} in ${lz.region}`) }, findings };
    },
  };
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

function googleIdentity(): Blueprint {
  return {
    id: 'google_mig_identity',
    label: 'Identity (migration)',
    group: MIGRATION_GROUP,
    description: 'Managed Service for Microsoft Active Directory on the landing-zone networks, or only DNS: a private Cloud DNS forwarding zone sending the domain to the domain controllers (extended on-premises DCs, or the ones the compute grid builds).',
    inputs: [
      { id: 'strategy', label: 'Strategy', control: 'select', default: 'resolver-only', options: [{ value: 'managed-ad', label: 'Managed Microsoft AD' }, { value: 'resolver-only', label: 'Forward DNS to our own DCs (extend-dcs)' }] },
      { id: 'domain', label: 'Domain', control: 'text', default: 'corp.example.com' },
      { id: 'dns_forwarders', label: 'Domain controller addresses', control: 'text', default: '10.0.0.10 10.0.0.11', hint: 'Space-separated, either family.', showWhen: { input: 'strategy', equals: ['resolver-only'] } },
      { id: 'reserved_ip_range', label: 'Directory range', control: 'text', default: '10.99.0.0/24', hint: 'A /24 used by nothing else, on-premises or in the cloud.', showWhen: { input: 'strategy', equals: ['managed-ad'] } },
      { id: 'network', label: 'Network', control: 'text', default: 'prod', hint: 'The landing-zone network the directory or forwarding zone serves; blank for every network.' },
      LANDING_ZONE_SOURCE,
    ],
    emits: ['google_active_directory_domain', 'google_dns_managed_zone'],
    build: (values: BlueprintValues) => {
      const findings: Finding[] = [];
      const lz = lzRef(values);
      const managed = valueOf(values, 'strategy', 'resolver-only') === 'managed-ad';
      const domain = valueOf(values, 'domain', 'corp.example.com').replace(/\.$/, '');
      const net = rname(valueOf(values, 'network', 'prod'));
      const networks = net ? `[${lz}.network_ids[${q(net)}]]` : `values(${lz}.network_ids)`;
      const blocks: HclBlock[] = [TF(), ...consumerPreamble('google', values)];
      if (managed) {
        const range = valueOf(values, 'reserved_ip_range', '10.99.0.0/24');
        if (familyOf(range) !== 4 || !range.endsWith('/24')) {
          findings.push(error('tf.mig.google-ad-range', `"${range}" is not an IPv4 /24; Managed Microsoft AD needs one.`, { path: 'reserved_ip_range' }));
          return failed('google_mig_identity', findings);
        }
        blocks.push(
          res('google_active_directory_domain', 'managed_ad', {
            domain_name: domain,
            locations: x(`[${lz}.region]`),
            reserved_ip_range: range,
            authorized_networks: x(networks),
            deletion_protection: true,
            labels: x(hcl({ atk_purpose: 'identity' })),
          }),
          output('domain', 'google_active_directory_domain.managed_ad.fqdn'),
          output('admin', 'google_active_directory_domain.managed_ad.admin', 'The delegated administrator; set its password with gcloud active-directory domains reset-admin-password.'),
        );
        findings.push(info('tf.mig.google-ad-admin', 'No password is written: set the delegated administrator\'s with `gcloud active-directory domains reset-admin-password` and keep it in the vault.', { path: 'strategy' }));
      } else {
        const forwarders = words(valueOf(values, 'dns_forwarders')).filter((f) => {
          const ok = familyOf(f) !== null && !f.includes('/');
          if (!ok) findings.push(warning('tf.mig.identity-forwarder', `"${f}" is not an IP address and was left out.`, { path: 'dns_forwarders' }));
          return ok;
        });
        if (forwarders.length === 0) {
          findings.push(error('tf.mig.identity-no-forwarders', 'Forwarding the domain needs the domain controllers\' addresses.', { path: 'dns_forwarders' }));
          return failed('google_mig_identity', findings);
        }
        blocks.push(
          res('google_dns_managed_zone', 'domain', {
            name: x(`"\${${lz}.prefix}-${rname(domain)}"`),
            dns_name: `${domain}.`,
            description: `Forwards ${domain} to its domain controllers`,
            visibility: 'private',
            labels: x(hcl({ atk_purpose: 'identity' })),
          }, [
            blk('forwarding_config', {}, forwarders.map((f) => blk('target_name_servers', familyOf(f) === 6 ? { ipv6_address: f, forwarding_path: 'private' } : { ipv4_address: f, forwarding_path: 'private' }))),
            blk('private_visibility_config', {}, [dyn('networks', networks, { network_url: x('networks.value') })]),
            blk('cloud_logging_config', { enable_logging: true }),
          ]),
          output('forwarding_zone', 'google_dns_managed_zone.domain.name'),
        );
        findings.push(info('tf.mig.google-dns-return', 'Cloud DNS forwards from 35.199.192.0/19: on-premises must route that range back over the VPN or interconnect (the connectivity blueprint advertises it).', { path: 'dns_forwarders' }));
      }
      return { files: { 'main.tf': mainTf(blocks, `Google Cloud identity: ${managed ? 'Managed Microsoft AD' : 'DNS forwarding'} for ${domain}`) }, findings };
    },
  };
}

// ---------------------------------------------------------------------------
// Connectivity
// ---------------------------------------------------------------------------

/** Link-local /30 for a site's tunnel: one per tunnel, the same every build. */
const linkLocal = (site: number, tunnel: number) => {
  const third = 10 + site * 2 + tunnel;
  return { cloud: `169.254.${third}.1/30`, peer: `169.254.${third}.2` };
};

function googleConnectivity(): Blueprint {
  return {
    id: 'google_mig_connectivity',
    label: 'Connectivity (migration)',
    group: MIGRATION_GROUP,
    description: 'HA VPN (two tunnels per site, BGP on a Cloud Router, IPv6 routes where the network is dual-stack) and Partner or Dedicated Interconnect attachments to the hub network.',
    inputs: [
      gridInput('sites', 'Sites', SITE_COLUMNS, DEFAULT_SITES, 'One row per on-premises site. Method: vpn, circuit (Interconnect), or circuit with a VPN backup. The circuit id is the Dedicated Interconnect name or URL; blank means a Partner Interconnect attachment.'),
      { id: 'cloud_asn', label: 'Cloud Router ASN', control: 'number', default: 64514, min: 64512, max: 65534 },
      { id: 'network', label: 'Hub network', control: 'text', default: 'prod', hint: 'The landing-zone network whose Cloud Router terminates the tunnels and attachments.' },
      LANDING_ZONE_SOURCE,
    ],
    emits: ['google_compute_router', 'google_compute_ha_vpn_gateway', 'google_compute_external_vpn_gateway', 'google_compute_vpn_tunnel', 'google_compute_router_interface', 'google_compute_router_peer', 'google_compute_interconnect_attachment'],
    build: (values: BlueprintValues) => {
      const parsed: Finding[] = [];
      const lz = lzRef(values);
      const sites = parseSites(valueOf(values, 'sites'), parsed);
      // A partner attachment needs no id; a dedicated one's is written in place.
      const findings = parsed.filter((f) => f.code !== 'tf.mig.circuit-variable');
      if (findings.some((f) => f.severity === 'error')) return failed('google_mig_connectivity', findings);
      const asn = numberOf(values, 'cloud_asn', 64514);
      const net = rname(valueOf(values, 'network', 'prod')) || 'prod';
      const network = `${lz}.network_ids[${q(net)}]`;
      const dual = `${lz}.ipv6[${q(net)}]`;
      const region = x(`${lz}.region`);
      const blocks: HclBlock[] = [TF(), ...consumerPreamble('google', values)];
      blocks.push(
        res('google_compute_router', 'hub', {
          name: x(`"\${${lz}.prefix}-${net}-hub"`),
          network: x(network),
          region,
        }, [
          blk('bgp', { asn, advertise_mode: 'CUSTOM', advertised_groups: ['ALL_SUBNETS'], keepalive_interval: 20 }, [
            blk('advertised_ip_ranges', { range: '35.199.192.0/19', description: 'Cloud DNS forwarding sources' }),
          ]),
        ], 'Separate from the landing zone\'s NAT router: this one speaks BGP to on-premises.'),
      );
      const vpnSites = sites.filter((s) => s.vpn);
      const v4Peers = vpnSites.filter((s) => familyOf(s.peer) !== 6);
      const v6Peers = vpnSites.filter((s) => familyOf(s.peer) === 6);
      if (v4Peers.length > 0) {
        blocks.push(res('google_compute_ha_vpn_gateway', 'hub', { name: x(`"\${${lz}.prefix}-${net}-vpn"`), network: x(network), region, stack_type: x(`${dual} ? "IPV4_IPV6" : "IPV4_ONLY"`) }));
      }
      if (v6Peers.length > 0) {
        blocks.push(res('google_compute_ha_vpn_gateway', 'hub_v6', { name: x(`"\${${lz}.prefix}-${net}-vpn-v6"`), network: x(network), region, gateway_ip_version: 'IPV6', stack_type: 'IPV4_IPV6' }, [], 'IPv6 outer addresses, for sites whose peer is IPv6.'));
      }
      vpnSites.forEach((s) => {
        const index = sites.indexOf(s);
        const v6peer = familyOf(s.peer) === 6;
        const gw = v6peer ? 'google_compute_ha_vpn_gateway.hub_v6' : 'google_compute_ha_vpn_gateway.hub';
        const siteV6 = s.cidrs.some((c) => familyOf(c) === 6);
        blocks.push(
          res('google_compute_external_vpn_gateway', s.id, {
            name: x(`"\${${lz}.prefix}-${s.name}"`),
            redundancy_type: 'SINGLE_IP_INTERNALLY_REDUNDANT',
            description: `The on-premises VPN peer at ${s.name}`,
          }, [blk('interface', v6peer ? { id: 0, ipv6_address: s.peer } : { id: 0, ip_address: s.peer })]),
        );
        for (const t of [0, 1]) {
          const label = `${s.id}_${t + 1}`;
          const psk = `vpn_psk_${s.id}_${t + 1}`;
          const ll = linkLocal(index, t);
          blocks.push(
            secretVariable(psk, `Pre-shared key for tunnel ${t + 1} to ${s.name}.`),
            res('google_compute_vpn_tunnel', label, {
              name: x(`"\${${lz}.prefix}-${s.name}-${t + 1}"`),
              region,
              vpn_gateway: x(`${gw}.id`),
              vpn_gateway_interface: t,
              peer_external_gateway: x(`google_compute_external_vpn_gateway.${s.id}.id`),
              peer_external_gateway_interface: 0,
              shared_secret: x(`var.${psk}`),
              router: x('google_compute_router.hub.id'),
              ike_version: 2,
            }),
            res('google_compute_router_interface', label, {
              name: x(`"\${${lz}.prefix}-${s.name}-${t + 1}"`),
              router: x('google_compute_router.hub.name'),
              region,
              ip_range: ll.cloud,
              vpn_tunnel: x(`google_compute_vpn_tunnel.${label}.name`),
            }),
            res('google_compute_router_peer', label, {
              name: x(`"\${${lz}.prefix}-${s.name}-${t + 1}"`),
              router: x('google_compute_router.hub.name'),
              region,
              interface: x(`google_compute_router_interface.${label}.name`),
              peer_ip_address: ll.peer,
              peer_asn: s.asn,
              advertised_route_priority: 100 + t * 10,
              // IPv6 routes over the IPv4 session (MP-BGP); Google assigns the IPv6 next hops.
              enable_ipv6: siteV6 ? x(v6peer ? 'true' : dual) : undefined,
            }),
          );
        }
      });
      // Interconnect: Partner (the partner configures BGP; asn 16550) or Dedicated (our BGP session).
      const circuits = sites.filter((s) => s.usesCircuit);
      const partner = circuits.filter((s) => s.circuit === '');
      const dedicated = circuits.filter((s) => s.circuit !== '');
      if (partner.length > 0) {
        blocks.push(res('google_compute_router', 'partner', { name: x(`"\${${lz}.prefix}-${net}-partner"`), network: x(network), region }, [blk('bgp', { asn: 16550 })], 'Partner Interconnect requires the Cloud Router ASN 16550.'));
        for (const s of partner) {
          for (const d of [1, 2]) {
            blocks.push(
              res('google_compute_interconnect_attachment', `${s.id}_${d}`, {
                name: x(`"\${${lz}.prefix}-${s.name}-${d}"`),
                region,
                router: x('google_compute_router.partner.id'),
                type: 'PARTNER',
                edge_availability_domain: `AVAILABILITY_DOMAIN_${d}`,
                admin_enabled: true,
                mtu: '1500',
                stack_type: x(`${dual} ? "IPV4_IPV6" : "IPV4_ONLY"`),
                description: `Partner Interconnect to ${s.name}, edge domain ${d}`,
              }),
            );
          }
          findings.push(info('tf.mig.google-partner', `Site ${s.name}: give the partner the two pairing keys (output partner_pairing_keys); the partner then configures BGP.`, { path: 'sites' }));
        }
      }
      for (const s of dedicated) {
        const index = sites.indexOf(s);
        const url = /^(https:\/\/|projects\/)/.test(s.circuit) ? s.circuit : x(`"https://www.googleapis.com/compute/v1/projects/\${${lz}.project}/global/interconnects/${s.circuit}"`);
        const label = `${s.id}_ic`;
        void index;
        blocks.push(
          res('google_compute_interconnect_attachment', label, {
            name: x(`"\${${lz}.prefix}-${s.name}-ic"`),
            region,
            router: x('google_compute_router.hub.id'),
            type: 'DEDICATED',
            interconnect: url,
            admin_enabled: true,
            mtu: '1500',
            stack_type: x(`${dual} ? "IPV4_IPV6" : "IPV4_ONLY"`),
            description: `Dedicated Interconnect to ${s.name}`,
          }),
          res('google_compute_router_interface', label, {
            name: x(`"\${${lz}.prefix}-${s.name}-ic"`),
            router: x('google_compute_router.hub.name'),
            region,
            ip_range: x(`google_compute_interconnect_attachment.${label}.cloud_router_ip_address`),
            interconnect_attachment: x(`google_compute_interconnect_attachment.${label}.self_link`),
          }),
          res('google_compute_router_peer', label, {
            name: x(`"\${${lz}.prefix}-${s.name}-ic"`),
            router: x('google_compute_router.hub.name'),
            region,
            interface: x(`google_compute_router_interface.${label}.name`),
            peer_ip_address: x(`split("/", google_compute_interconnect_attachment.${label}.customer_router_ip_address)[0]`),
            peer_asn: s.asn,
            advertised_route_priority: 50,
          }),
        );
        findings.push(info('tf.mig.google-interconnect-ipv6', `Site ${s.name}: the attachment is dual-stack where the network is; its IPv6 BGP session is added once Google has assigned the attachment's IPv6 addresses.`, { path: 'sites' }));
      }
      if (sites.length === 0) findings.push(warning('tf.mig.no-sites', 'The sites grid is empty, so only the Cloud Router was built.', { path: 'sites' }));
      findings.push(info('tf.mig.google-hub', `Only the ${net} network is connected to on-premises; peer the others to it (or use Network Connectivity Center) if they need to reach on-premises too.`, { path: 'network' }));
      blocks.push(output('router', 'google_compute_router.hub.id'));
      if (v4Peers.length > 0) blocks.push(output('vpn_interfaces', 'google_compute_ha_vpn_gateway.hub.vpn_interfaces[*].ip_address', 'The two Google tunnel endpoints to configure on each on-premises peer.'));
      if (v6Peers.length > 0) blocks.push(output('vpn_interfaces_v6', 'google_compute_ha_vpn_gateway.hub_v6.vpn_interfaces[*].ipv6_address', 'The two Google IPv6 tunnel endpoints.'));
      if (partner.length > 0) {
        blocks.push(output('partner_pairing_keys', `{\n    ${partner.map((s) => `${s.id} = [google_compute_interconnect_attachment.${s.id}_1.pairing_key, google_compute_interconnect_attachment.${s.id}_2.pairing_key]`).join('\n    ')}\n  }`, 'The pairing keys to give the Partner Interconnect provider.'));
      }
      return { files: { 'main.tf': mainTf(blocks, `Google Cloud connectivity: ${sites.length} site(s) to ${net}`) }, findings };
    },
  };
}

// ---------------------------------------------------------------------------
// Compute
// ---------------------------------------------------------------------------

const DEFAULT_VMS: readonly (readonly string[])[] = [
  ['web01', 'win-2022', 'family:windows-cloud/windows-2022', 'n2-standard-2', '', 'pd-balanced:100', 'prod', 'web', 'a', 'li', 'silver', 'rebuild', 'shop', 'web', 'prod', '1'],
  ['app01', 'rhel-9', 'family:rhel-cloud/rhel-9', 'n2-standard-4', '', 'pd-balanced:50 pd-balanced:200', 'prod', 'app', 'b', 'li', 'gold', 'rebuild', 'shop', 'app', 'prod', '1'],
  ['sql01', 'win-2022', 'family:windows-cloud/windows-2022', 'n2-highmem-8', '4', 'pd-balanced:100 pd-ssd:500', 'prod', 'db', 'b', 'byol-image', 'gold', 'rebuild', 'crm', 'sqlserver', 'prod', '2'],
  ['db01', 'ol-8', 'replicated', 'n2-highmem-8', '4', 'pd-balanced:100 pd-ssd:500', 'prod', 'db', 'a', 'byol-image', 'gold', 'replicate', 'shop', 'oracle', 'prod', '2'],
];

/** The sole-tenant node type each machine series runs on. */
const NODE_TYPES: Readonly<Record<string, string>> = {
  n2: 'n2-node-80-640',
  n2d: 'n2d-node-224-896',
  c3: 'c3-node-176-352',
  n1: 'n1-node-96-624',
};
const seriesOf = (size: string) => size.split('-')[0] ?? size;
const byol = (vm: VmSpec) => vm.licence === 'byol-image' || vm.licence === 'dedicated-host';

/** A VM's image once BYOL is accounted for: Windows images from windows-cloud carry a licence, so BYOL needs your own. */
function effectiveImage(vm: VmSpec, findings: Finding[]): ImageRef | null {
  const img = vm.image;
  if (vm.method !== 'rebuild' || !img) return img;
  if (byol(vm) && vm.kind === 'windows' && img.kind === 'gcp-family' && img.project === 'windows-cloud') {
    findings.push(info('tf.mig.google-byol-image', `${vm.name}: a windows-cloud image is licence-included, so a BYOL VM on a sole-tenant node is built from your own imported image, var.byol_image_${ident(vm.name)}.`, { path: 'vms' }));
    return { kind: 'custom', variable: `byol_image_${ident(vm.name)}` };
  }
  return img;
}

const imageKeyOf = (img: ImageRef | null, vm: VmSpec) => (img?.kind === 'custom' ? `var:${img.variable}` : vm.imageKey);

function googleImageData(vms: readonly VmSpec[], images: ReadonlyMap<string, ImageRef | null>): { blocks: HclBlock[]; exprFor: Map<string, string> } {
  const blocks: HclBlock[] = [];
  const exprFor = new Map<string, string>();
  let n = 0;
  for (const vm of vms) {
    const img = images.get(vm.key) ?? null;
    if (!img || vm.method === 'replicate') continue;
    const key = imageKeyOf(img, vm);
    if (exprFor.has(key)) continue;
    n += 1;
    const label = `image_${n}`;
    if (img.kind === 'gcp-family') {
      blocks.push(dat('google_compute_image', label, { family: img.family, project: img.project }, [], vm.imageKey));
      exprFor.set(key, `data.google_compute_image.${label}.self_link`);
    } else if (img.kind === 'custom') {
      blocks.push(variable(img.variable, 'string', `The image for ${vm.name} (${vm.os}): a self link or projects/<project>/global/images/<name>.`));
      exprFor.set(key, `var.${img.variable}`);
    } else {
      blocks.push(variable(`image_${ident(vm.name)}`, 'string', `The image for ${vm.name}: "${vm.imageKey}" is not a Google image key.`));
      exprFor.set(key, `var.image_${ident(vm.name)}`);
    }
  }
  return { blocks, exprFor };
}

/** Installs python3 where the image has no cloud-init to read user-data (RHEL, Rocky, SLES, Debian on Google). */
const STARTUP_LINUX = [
  '<<-EOT',
  '    #!/bin/bash',
  '    command -v python3 >/dev/null 2>&1 && exit 0',
  '    (command -v dnf && dnf -y install python3) || (command -v yum && yum -y install python3) || (command -v apt-get && apt-get update && apt-get -y install python3) || (command -v zypper && zypper -n install python3)',
  '  EOT',
].join('\n');

function googleCompute(): Blueprint {
  return {
    id: 'google_mig_compute',
    label: 'Compute (migration)',
    group: MIGRATION_GROUP,
    description: 'A Compute Engine VM per rebuild row (Shielded VM, no external address, dual-stack where the network is, CMEK disks, the landing-zone service account, bootstrap without secrets), data disks, sole-tenant nodes for BYOL, and the replicated rows adopted after cutover with import blocks. Writes local.mig_vms.',
    inputs: [
      gridInput('vms', 'VMs', vmColumns(SIZES, ['pd-balanced', 'pd-ssd']), DEFAULT_VMS, 'One row per VM. Image: family:<project>/<family> or var:<name>. Disks: type:GiB, the first is the boot disk. Licence byol-image or dedicated-host puts the VM on a sole-tenant node. Method replicate: the replication tool builds it; list it in cutover_instance_ids after cutover to adopt it.'),
      { id: 'ssh_public_key_var', label: 'SSH key variable', control: 'text', default: 'ssh_public_key', hint: 'The variable holding the ansible user\'s public key.' },
      LANDING_ZONE_SOURCE,
    ],
    emits: ['google_compute_instance', 'google_compute_disk', 'google_compute_attached_disk', 'google_compute_node_template', 'google_compute_node_group'],
    build: (values: BlueprintValues) => {
      const findings: Finding[] = [];
      const lz = lzRef(values);
      const vms = parseVms(valueOf(values, 'vms'), 'pd-balanced', findings);
      const sshVar = ident(valueOf(values, 'ssh_public_key_var', 'ssh_public_key'));
      const images = new Map(vms.map((vm) => [vm.key, effectiveImage(vm, findings)] as const));
      const { blocks: imageBlocks, exprFor } = googleImageData(vms, images);

      // Sole tenancy for BYOL: a node template per machine series, a node group per series and zone.
      const templates = new Map<string, string>();
      const groups = new Map<string, { series: string; zoneIndex: number; zone: string }>();
      const groupOf = (vm: VmSpec): string => {
        if (!byol(vm) || vm.method !== 'rebuild') return '';
        const series = seriesOf(vm.size);
        const nodeType = NODE_TYPES[series];
        if (!nodeType) {
          findings.push(warning('tf.mig.google-sole-tenant', `${vm.name}: ${vm.size} has no sole-tenant node type, so it runs on shared hosts; use an n2, n2d or c3 size for BYOL.`, { path: 'vms' }));
          return '';
        }
        templates.set(series, nodeType);
        const key = `${series}-${vm.zone}`;
        groups.set(key, { series, zoneIndex: vm.zoneIndex, zone: vm.zone });
        return key;
      };

      const entries: Record<string, string> = {};
      for (const vm of vms) {
        if (!/^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/.test(vm.name)) {
          findings.push(warning('tf.mig.google-vm-name', `${vm.name}: a Compute Engine name is lowercase letters, digits and hyphens, starting with a letter.`, { path: 'vms' }));
        }
        const labels = Object.fromEntries(Object.entries(migTags(vm)).map(([k, v]) => [k, gcpLabel(v)]));
        entries[vm.key] = vmLocalEntry(vm, {
          image: vm.method === 'rebuild' ? (exprFor.get(imageKeyOf(images.get(vm.key) ?? null, vm)) ?? 'null') : 'null',
          subnet: `${lz}.subnet_ids[${q(`${vm.network}/${vm.tier}/${vm.zone}`)}]`,
          tag: `${lz}.security_group_ids[${q(`${vm.network}/${vm.tier}`)}]`,
          cores: vm.cores ? String(vm.cores) : 'null',
          boot_type: q(vm.boot.type),
          boot_gib: String(vm.boot.gib),
          node_group: q(groupOf(vm)),
          labels: hstrmap(labels, 3),
        });
      }
      const disks: Record<string, unknown> = {};
      for (const vm of vms.filter((v) => v.method === 'rebuild')) {
        vm.data.forEach((d, i) => {
          disks[`${vm.key}/${i + 1}`] = { vm: vm.key, name: rname(vm.key, 'data', String(i + 1)), type: d.type, gib: d.gib };
        });
      }
      const blocks: (HclBlock | string)[] = [
        TF(),
        ...consumerPreamble('google', values),
        sshKeyVariable(sshVar),
        cutoverVariable('the instance path, projects/<project>/zones/<zone>/instances/<name>'),
        ...imageBlocks,
        {
          type: 'locals',
          comment: 'Every VM in the grid, by name: the compute contract (local.mig_vms) the backup and monitoring blueprints read.',
          attributes: [
            { name: 'mig_vms', value: x(hcl(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, e(v)])), 1)) },
            { name: 'mig_rebuild', value: x('{ for k, v in local.mig_vms : k => v if v.method == "rebuild" }') },
            { name: 'mig_replicated', value: x('{ for k, v in local.mig_vms : k => v if v.method == "replicate" }') },
            { name: 'mig_data_disks', value: x(hcl(disks, 1)) },
            { name: 'mig_bootstrap_linux', value: x(cloudInit(`var.${sshVar}`)) },
            { name: 'mig_startup_linux', value: x(STARTUP_LINUX) },
            { name: 'mig_bootstrap_windows', value: x(winrmBootstrap(`${lz}.mgmt_cidrs`)) },
            { name: 'mig_vm_ids', value: x('merge({ for k, v in google_compute_instance.vm : k => v.id }, { for k, v in google_compute_instance.replicated : k => v.id })') },
          ],
        },
      ];
      if (groups.size > 0) {
        blocks.push(
          res('google_compute_node_template', 'mig', {
            for_each: x(hcl(Object.fromEntries(templates), 1)),
            name: x(`"\${${lz}.prefix}-\${each.key}-byol"`),
            region: x(`${lz}.region`),
            node_type: x('each.value'),
            cpu_overcommit_type: 'NONE',
            description: 'Sole-tenant nodes for bring-your-own-licence VMs',
          }, [blk('server_binding', { type: 'RESTART_NODE_ON_MINIMAL_SERVERS' })], 'Sole tenancy for BYOL: the VMs stay on as few physical servers as possible, which is what per-core licences count.'),
          res('google_compute_node_group', 'mig', {
            for_each: x(hcl(Object.fromEntries([...groups].map(([k, g]) => [k, { series: g.series, zone_index: g.zoneIndex }])), 1)),
            name: x(`"\${${lz}.prefix}-\${each.key}-byol"`),
            zone: x(`element(${lz}.zones, each.value.zone_index)`),
            node_template: x('google_compute_node_template.mig[each.value.series].id'),
            initial_size: 1,
            maintenance_policy: 'RESTART_IN_PLACE',
            description: 'Sole-tenant node group for bring-your-own-licence VMs',
          }),
        );
      }
      const metadata = [
        'each.value.kind == "windows" ? tomap({',
        '    "enable-osconfig"               = "TRUE"',
        '    "sysprep-specialize-script-ps1" = local.mig_bootstrap_windows',
        '    }) : tomap({',
        '    "enable-osconfig" = "TRUE"',
        `    "ssh-keys"        = "ansible:\${var.${sshVar}}"`,
        `    "user-data"       = ${withHost('local.mig_bootstrap_linux')}`,
        '    "startup-script"  = local.mig_startup_linux',
        '  })',
      ].join('\n');
      const lzKms = `${lz}.kms_key_id`;
      const serviceAccount = blk('service_account', { email: x(`${lz}.service_account`), scopes: ['cloud-platform'] });
      const shielded = blk('shielded_instance_config', { enable_secure_boot: true, enable_vtpm: true, enable_integrity_monitoring: true });
      blocks.push(
        res('google_compute_instance', 'vm', {
          for_each: x('local.mig_rebuild'),
          name: x('each.key'),
          machine_type: x('each.value.size'),
          zone: x(`element(${lz}.zones, each.value.zone_index)`),
          tags: x('[each.value.tag]'),
          labels: x('merge(each.value.labels, { atk_tier = each.value.tier })'),
          metadata: x(metadata),
          allow_stopping_for_update: true,
        }, [
          blk('boot_disk', { auto_delete: true, kms_key_self_link: x(lzKms) }, [
            blk('initialize_params', { image: x('each.value.image'), size: x('each.value.boot_gib'), type: x('each.value.boot_type'), labels: x('each.value.labels') }),
          ]),
          blk('network_interface', {
            subnetwork: x('each.value.subnet'),
            stack_type: x(`${lz}.ipv6[each.value.network] ? "IPV4_IPV6" : "IPV4_ONLY"`),
          }),
          serviceAccount,
          shielded,
          dyn('advanced_machine_features', 'each.value.cores == null ? [] : [each.value.cores]', { threads_per_core: 2, visible_core_count: x('advanced_machine_features.value') }),
          groups.size > 0
            ? blk('scheduling', { automatic_restart: true, on_host_maintenance: x('each.value.node_group == "" ? "MIGRATE" : "TERMINATE"') }, [
                dyn('node_affinities', 'each.value.node_group == "" ? [] : [each.value.node_group]', {
                  key: 'compute.googleapis.com/node-group-name',
                  operator: 'IN',
                  values: x('[google_compute_node_group.mig[node_affinities.value].name]'),
                }),
              ])
            : blk('scheduling', { automatic_restart: true, on_host_maintenance: 'MIGRATE' }),
          // A newer image or a changed bootstrap must not replace a running server; data disks are attached separately.
          ignoreChanges(['boot_disk[0].initialize_params[0].image', 'metadata["user-data"]', 'metadata["startup-script"]', 'metadata["sysprep-specialize-script-ps1"]', 'attached_disk']),
        ]),
        res('google_compute_disk', 'data', {
          for_each: x('local.mig_data_disks'),
          name: x('each.value.name'),
          zone: x('google_compute_instance.vm[each.value.vm].zone'),
          size: x('each.value.gib'),
          type: x('each.value.type'),
          labels: x('local.mig_vms[each.value.vm].labels'),
        }, [dyn('disk_encryption_key', kmsList(lz), { kms_key_self_link: x('disk_encryption_key.value') })]),
        res('google_compute_attached_disk', 'data', {
          for_each: x('local.mig_data_disks'),
          disk: x('google_compute_disk.data[each.key].id'),
          instance: x('google_compute_instance.vm[each.value.vm].id'),
          device_name: x('each.value.name'),
        }),
        // Adopting what the replication tool launched: the empty map adopts nothing and applies cleanly.
        dat('google_compute_instance', 'replicated', { for_each: x('var.cutover_instance_ids'), self_link: x('each.value') }),
        { type: 'import', comment: 'Replicated VMs, adopted after cutover (Terraform 1.7 or later).', attributes: attrs({ for_each: x('var.cutover_instance_ids'), to: x('google_compute_instance.replicated[each.key]'), id: x('each.value') }) },
        res('google_compute_instance', 'replicated', {
          for_each: x('var.cutover_instance_ids'),
          name: x('data.google_compute_instance.replicated[each.key].name'),
          zone: x('data.google_compute_instance.replicated[each.key].zone'),
          machine_type: x('local.mig_replicated[each.key].size'),
          tags: x('[local.mig_replicated[each.key].tag]'),
          labels: x('merge(local.mig_replicated[each.key].labels, { atk_tier = local.mig_replicated[each.key].tier })'),
          allow_stopping_for_update: true,
        }, [
          blk('boot_disk', { source: x('data.google_compute_instance.replicated[each.key].boot_disk[0].source') }),
          blk('network_interface', { subnetwork: x('data.google_compute_instance.replicated[each.key].network_interface[0].subnetwork') }),
          serviceAccount,
          // What the replication tool owns stays as it built it.
          ignoreChanges(['boot_disk', 'network_interface', 'metadata', 'name', 'zone', 'attached_disk', 'shielded_instance_config', 'scheduling', 'advanced_machine_features', 'metadata_startup_script']),
        ]),
        output('vms', '{ for k, v in google_compute_instance.vm : k => { id = v.id, zone = v.zone, private_ip = v.network_interface[0].network_ip, ipv6 = v.network_interface[0].ipv6_address, os = local.mig_vms[k].os } }', 'Each built VM: id and addresses, for the Ansible inventory.'),
        output('replicated', '{ for k, v in google_compute_instance.replicated : k => { id = v.id, zone = v.zone, private_ip = v.network_interface[0].network_ip, os = local.mig_vms[k].os } }', 'Each adopted VM.'),
      );
      for (const vm of vms) {
        if (vm.licence === 'ahb' || vm.licence === 'rhel-byos' || vm.licence === 'sles-byos') {
          findings.push(info('tf.mig.google-licence', `${vm.name}: "${vm.licence}" has no Compute Engine switch; use a BYOS image (for example from rhel-byos-cloud or suse-byos-cloud) in the Image column.`, { path: 'vms' }));
        }
        if (vm.method === 'replicate' && vm.data.length > 0) {
          findings.push(info('tf.mig.replicated-disks', `${vm.name}: its data disks come with the replication and are not created here.`, { path: 'vms' }));
        }
      }
      findings.push(info('tf.mig.google-oslogin', 'Linux VMs get the ansible key through ssh-keys metadata, which OS Login ignores: if the organisation enforces OS Login, grant the Ansible service account roles/compute.osAdminLogin instead.', { path: 'vms' }));
      return { files: { 'main.tf': mainTf(blocks, `Google Cloud compute: ${vms.length} VM(s)`) }, findings };
    },
  };
}

// ---------------------------------------------------------------------------
// Databases
// ---------------------------------------------------------------------------

const GOOGLE_DB_SERVICES = ['google-cloudsql', 'google-alloydb', 'google-gce', 'google-odb-exadata', 'google-odb-adb', 'google-odb-basedb'];

const DEFAULT_DBS: readonly (readonly string[])[] = [
  ['orders', 'google-cloudsql', 'POSTGRES_16', 'enterprise', '16', 'db-custom-4-15360', '200', 'regional', 'li', '14', 'prod', 'shop'],
  ['catalog', 'google-cloudsql', 'MYSQL_8_0', 'enterprise', '8.0', 'db-custom-2-7680', '100', 'none', 'li', '7', 'prod', 'shop'],
  ['crm', 'google-cloudsql', 'SQLSERVER_2022_STANDARD', 'enterprise', '2022', 'db-custom-4-15360', '300', 'regional', 'li', '7', 'prod', 'crm'],
  ['ledger', 'google-alloydb', 'POSTGRES_16', '', '16', 'db-custom-4-32768', '100', 'regional', 'li', '14', 'prod', 'finance'],
];

/** The Cloud SQL / AlloyDB database_version, from an Engine written either way (POSTGRES_16, or postgres + 16). */
function databaseVersion(db: DbSpec): string {
  const engine = db.engine.toUpperCase();
  if (/^(POSTGRES|MYSQL|SQLSERVER)_/.test(engine)) return engine;
  const v = db.version.trim();
  if (/^postgres|^pg/i.test(db.engine)) return `POSTGRES_${v.split('.')[0] || '16'}`;
  if (/^mysql/i.test(db.engine)) return `MYSQL_${(v || '8.0').replace(/\./g, '_')}`;
  if (/^(sqlserver|mssql)/i.test(db.engine)) {
    const year = /20\d\d/.exec(v)?.[0] ?? '2022';
    const edition = /enterprise|-ee/.test(`${db.edition} ${db.engine}`) ? 'ENTERPRISE' : /web/.test(db.edition) ? 'WEB' : /express/.test(db.edition) ? 'EXPRESS' : 'STANDARD';
    return `SQLSERVER_${year}_${edition}`;
  }
  return 'POSTGRES_16';
}

function googleDatabases(): Blueprint {
  return {
    id: 'google_mig_databases',
    label: 'Databases (migration)',
    group: MIGRATION_GROUP,
    description: 'Cloud SQL and AlloyDB per row on private service access: private IP only, TLS only, regional HA where the HA column asks, CMEK, backups with point-in-time recovery, deletion-protected, and IAM database users (no password) where the engine has them; the passwords it must set come from sensitive variables.',
    inputs: [
      gridInput('databases', 'Databases', dbColumns(GOOGLE_DB_SERVICES, DB_ENGINES, DB_TIERS, ['li', 'byol']), DEFAULT_DBS, 'One row per database. Engine is the Cloud SQL database version (POSTGRES_16, MYSQL_8_0, SQLSERVER_2022_STANDARD…); Edition enterprise or enterprise-plus; Class the db-custom tier (AlloyDB takes its vCPU count).'),
      LANDING_ZONE_SOURCE,
    ],
    emits: ['google_compute_global_address', 'google_service_networking_connection', 'google_sql_database_instance', 'google_sql_user', 'google_service_account', 'google_project_iam_member', 'google_kms_crypto_key_iam_member', 'google_alloydb_cluster', 'google_alloydb_instance'],
    build: (values: BlueprintValues) => {
      const findings: Finding[] = [];
      const lz = lzRef(values);
      const dbs = parseDbs(valueOf(values, 'databases'), findings);
      const blocks: HclBlock[] = [TF(), ...consumerPreamble('google', values)];
      const sql: DbSpec[] = [];
      const alloy: DbSpec[] = [];
      for (const db of dbs) {
        if (db.service === 'google-cloudsql' || db.service === '') sql.push(db);
        else if (db.service === 'google-alloydb') alloy.push(db);
        else if (db.service === 'google-gce') findings.push(info('tf.mig.db-on-gce', `${db.name} runs on Compute Engine: its hosts are compute rows, and Ansible installs it.`, { path: 'databases' }));
        else if (db.service.startsWith('google-odb')) findings.push(info('tf.mig.db-odb', `${db.name} is on Oracle Database@Google Cloud: see the Oracle Database@Google Cloud blueprint.`, { path: 'databases' }));
        else findings.push(warning('tf.mig.db-service', `${db.name}: ${db.service} is not a Google database service here; it was left out.`, { path: 'databases' }));
      }
      const managed = [...sql, ...alloy];
      if (managed.length === 0) {
        blocks.push(output('databases', '{}', 'No managed databases in the grid.'));
        return { files: { 'main.tf': mainTf(blocks, 'Google Cloud databases: none managed') }, findings };
      }
      // Private service access, once per network a database sits in.
      const nets = [...new Set(managed.map((d) => d.network))];
      for (const net of nets) {
        const id = ident(net);
        blocks.push(
          res('google_compute_global_address', `mig_psa_${id}`, {
            name: x(`"\${${lz}.prefix}-${net}-psa"`),
            purpose: 'VPC_PEERING',
            address_type: 'INTERNAL',
            ip_version: 'IPV4',
            prefix_length: 20,
            network: x(`${lz}.network_ids[${q(net)}]`),
            description: `Private service access for managed databases in ${net}`,
          }),
          res('google_service_networking_connection', `mig_psa_${id}`, {
            network: x(`${lz}.network_ids[${q(net)}]`),
            service: 'servicenetworking.googleapis.com',
            reserved_peering_ranges: x(`[google_compute_global_address.mig_psa_${id}.name]`),
          }),
        );
      }
      // CMEK: the service agents need the key; they exist once each API has been used.
      blocks.push(dat('google_project', 'mig_db', { project_id: x(`${lz}.project`) }));
      const agents: Record<string, string> = {};
      if (sql.length > 0) agents.cloudsql = 'gcp-sa-cloud-sql.iam.gserviceaccount.com';
      if (alloy.length > 0) agents.alloydb = 'gcp-sa-alloydb.iam.gserviceaccount.com';
      for (const [name, domain] of Object.entries(agents)) {
        blocks.push(
          res('google_kms_crypto_key_iam_member', `mig_${name}_agent`, {
            count: x(`${lz}.kms_key_id == null ? 0 : 1`),
            crypto_key_id: x(`${lz}.kms_key_id`),
            role: 'roles/cloudkms.cryptoKeyEncrypterDecrypter',
            member: x(`"serviceAccount:service-\${data.google_project.mig_db.number}@${domain}"`),
          }),
        );
      }
      findings.push(info('tf.mig.google-db-agents', 'With a customer-managed key, the Cloud SQL and AlloyDB service agents must exist before apply: `gcloud beta services identity create --service=sqladmin.googleapis.com` (and alloydb.googleapis.com).', { path: 'databases' }));

      const endpoints: string[] = [];
      for (const db of sql) {
        const version = databaseVersion(db);
        const kind = version.startsWith('POSTGRES') ? 'postgres' : version.startsWith('MYSQL') ? 'mysql' : 'sqlserver';
        const ha = db.ha !== 'none';
        const plus = /plus/.test(db.edition);
        const tier = db.cls || 'db-custom-4-15360';
        if (plus && tier.startsWith('db-custom-')) findings.push(warning('tf.mig.cloudsql-plus-tier', `${db.name}: Enterprise Plus takes db-perf-optimized-N-* tiers, not ${tier}.`, { path: 'databases' }));
        if (db.licence === 'byol') findings.push(info('tf.mig.cloudsql-byol', `${db.name}: Cloud SQL has no bring-your-own-licence; it is licence-included.`, { path: 'databases' }));
        const net = ident(db.network);
        const inst = `google_sql_database_instance.${db.id}`;
        const flags = kind === 'postgres' ? [blk('database_flags', { name: 'cloudsql.iam_authentication', value: 'on' })] : kind === 'mysql' ? [blk('database_flags', { name: 'cloudsql_iam_authentication', value: 'on' })] : [];
        const pw = `cloudsql_${db.id}_sqlserver_password`;
        if (kind === 'sqlserver') blocks.push(secretVariable(pw, `The password of the sqlserver administrator of Cloud SQL instance ${db.name}.`));
        blocks.push(
          res('google_sql_database_instance', db.id, {
            name: x(`"\${${lz}.prefix}-${db.name}"`),
            region: x(`${lz}.region`),
            database_version: version,
            deletion_protection: true,
            encryption_key_name: x(`${lz}.kms_key_id`),
            root_password_wo: kind === 'sqlserver' ? x(`var.${pw}`) : undefined,
            root_password_wo_version: kind === 'sqlserver' ? '1' : undefined,
            depends_on: x(`[google_service_networking_connection.mig_psa_${net}${agents.cloudsql ? ', google_kms_crypto_key_iam_member.mig_cloudsql_agent' : ''}]`),
          }, [
            blk('settings', {
              tier,
              edition: plus ? 'ENTERPRISE_PLUS' : 'ENTERPRISE',
              availability_type: ha ? 'REGIONAL' : 'ZONAL',
              disk_size: db.storage,
              disk_type: 'PD_SSD',
              disk_autoresize: true,
              deletion_protection_enabled: true,
              user_labels: x(hcl({ atk_app: gcpLabel(db.app), atk_db: kind, atk_backup_days: String(db.backupDays) }, 2)),
            }, [
              blk('ip_configuration', {
                ipv4_enabled: false,
                private_network: x(`${lz}.network_ids[${q(db.network)}]`),
                allocated_ip_range: x(`google_compute_global_address.mig_psa_${net}.name`),
                ssl_mode: 'ENCRYPTED_ONLY',
                enable_private_path_for_google_cloud_services: true,
              }),
              blk('backup_configuration', {
                enabled: true,
                start_time: '03:00',
                point_in_time_recovery_enabled: kind !== 'mysql' ? true : undefined,
                binary_log_enabled: kind === 'mysql' ? true : undefined,
                transaction_log_retention_days: Math.min(7, db.backupDays),
              }, [blk('backup_retention_settings', { retained_backups: Math.max(db.backupDays, 7), retention_unit: 'COUNT' })]),
              blk('maintenance_window', { day: 7, hour: 3, update_track: 'stable' }),
              blk('insights_config', { query_insights_enabled: true }),
              ...flags,
            ]),
          ]),
        );
        endpoints.push(`${q(db.name)} = ${inst}.private_ip_address`);
        if (kind !== 'sqlserver') {
          // The application signs in as a service account: an IAM database user, no password anywhere.
          const account = rname('sql', db.name).slice(0, 26).replace(/-+$/, '') + '-iam';
          blocks.push(
            res('google_service_account', `mig_db_${db.id}`, { account_id: account.length >= 6 ? account : `${account}-db`, display_name: `Database user for ${db.name}`, project: x(`${lz}.project`) }),
            res('google_project_iam_member', `mig_db_${db.id}_client`, { project: x(`${lz}.project`), role: 'roles/cloudsql.client', member: x(`"serviceAccount:\${google_service_account.mig_db_${db.id}.email}"`) }),
            res('google_project_iam_member', `mig_db_${db.id}_user`, { project: x(`${lz}.project`), role: 'roles/cloudsql.instanceUser', member: x(`"serviceAccount:\${google_service_account.mig_db_${db.id}.email}"`) }),
            res('google_sql_user', `mig_db_${db.id}`, {
              instance: x(`${inst}.name`),
              name: x(kind === 'postgres' ? `trimsuffix(google_service_account.mig_db_${db.id}.email, ".gserviceaccount.com")` : `google_service_account.mig_db_${db.id}.email`),
              type: 'CLOUD_IAM_SERVICE_ACCOUNT',
            }),
          );
        }
      }
      for (const db of alloy) {
        const net = ident(db.network);
        const version = databaseVersion(db);
        const pw = `alloydb_${db.id}_password`;
        const cpu = Number(/(\d+)/.exec(db.cls)?.[1] ?? '4') || 4;
        blocks.push(
          secretVariable(pw, `The password of the postgres user of AlloyDB cluster ${db.name}.`),
          res('google_alloydb_cluster', db.id, {
            cluster_id: x(`"\${${lz}.prefix}-${db.name}"`),
            location: x(`${lz}.region`),
            database_version: version.startsWith('POSTGRES') ? version : 'POSTGRES_16',
            deletion_protection: true,
            labels: x(hcl({ atk_app: gcpLabel(db.app), atk_db: 'postgres' })),
            depends_on: x(`[google_service_networking_connection.mig_psa_${net}, google_kms_crypto_key_iam_member.mig_alloydb_agent]`),
          }, [
            blk('network_config', { network: x(`${lz}.network_ids[${q(db.network)}]`), allocated_ip_range: x(`google_compute_global_address.mig_psa_${net}.name`) }),
            blk('initial_user', { user: 'postgres', password_wo: x(`var.${pw}`), password_wo_version: '1' }),
            dyn('encryption_config', kmsList(lz), { kms_key_name: x('encryption_config.value') }),
            blk('automated_backup_policy', { enabled: true, location: x(`${lz}.region`), backup_window: '3600s' }, [
              blk('weekly_schedule', { days_of_week: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'] }, [blk('start_times', { hours: 3 })]),
              blk('time_based_retention', { retention_period: `${db.backupDays * 86400}s` }),
              dyn('encryption_config', kmsList(lz), { kms_key_name: x('encryption_config.value') }),
            ]),
            blk('continuous_backup_config', { enabled: true, recovery_window_days: Math.min(35, Math.max(1, db.backupDays)) }, [
              dyn('encryption_config', kmsList(lz), { kms_key_name: x('encryption_config.value') }),
            ]),
          ]),
          res('google_alloydb_instance', db.id, {
            cluster: x(`google_alloydb_cluster.${db.id}.name`),
            instance_id: x(`"\${${lz}.prefix}-${db.name}-primary"`),
            instance_type: 'PRIMARY',
            availability_type: db.ha !== 'none' ? 'REGIONAL' : 'ZONAL',
            database_flags: x(hcl({ 'alloydb.iam_authentication': 'on' })),
          }, [blk('machine_config', { cpu_count: cpu }), blk('client_connection_config', {}, [blk('ssl_config', { ssl_mode: 'ENCRYPTED_ONLY' })])]),
        );
        endpoints.push(`${q(db.name)} = google_alloydb_instance.${db.id}.ip_address`);
      }
      if (sql.some((d) => databaseVersion(d).startsWith('SQLSERVER')) || alloy.length > 0) {
        findings.push(info('tf.mig.google-db-write-only', 'The SQL Server and AlloyDB passwords are write-only arguments (never kept in state), which need Terraform 1.11 or later.', { path: 'databases' }));
      }
      blocks.push(output('endpoints', `{\n    ${endpoints.join('\n    ')}\n  }`, 'Each database\'s private address.'));
      return { files: { 'main.tf': mainTf(blocks, `Google Cloud databases: ${sql.length} Cloud SQL, ${alloy.length} AlloyDB`) }, findings };
    },
  };
}

// ---------------------------------------------------------------------------
// Oracle Database@Google Cloud
// ---------------------------------------------------------------------------

function googleOracleDatabase(): Blueprint {
  return {
    id: 'google_mig_oracle_database',
    label: 'Oracle Database@Google Cloud (migration)',
    group: MIGRATION_GROUP,
    description: 'An ODB network on the landing-zone VPC with client and backup subnets, Exadata infrastructure, an Exadata VM cluster and an Autonomous Database; the database homes and databases in the VM cluster are created through OCI.',
    inputs: [
      ...odbInputs('google'),
      { id: 'oracle_zone_id', label: 'Oracle zone', control: 'text', default: '', hint: 'The gcp_oracle_zone the Exadata sits in (for example us-east4-b-r1); blank lets Google choose.' },
      { id: 'ssh_public_key_var', label: 'SSH key variable', control: 'text', default: 'ssh_public_key' },
    ],
    emits: [
      'google_oracle_database_odb_network', 'google_oracle_database_odb_subnet', 'google_oracle_database_cloud_exadata_infrastructure',
      'google_oracle_database_cloud_vm_cluster', 'google_oracle_database_autonomous_database', 'oci_database_db_home', 'oci_database_database',
    ],
    build: (values: BlueprintValues) => {
      const findings: Finding[] = [oracleRegionFinding('Google Cloud', 'the landing-zone region')];
      const lz = lzRef(values);
      const net = rname(valueOf(values, 'network', 'prod')) || 'prod';
      const cidr = valueOf(values, 'odb_network_cidr', '10.60.0.0/24');
      const [p = '24'] = cidr.split('/').slice(1);
      const halves = familyOf(cidr) === 4 ? carve(cidr, [Number(p) + 1, Number(p) + 1]) : null;
      if (!halves) {
        findings.push(error('tf.mig.odb-cidr', `"${cidr}" cannot be split into a client and a backup subnet.`, { path: 'odb_network_cidr' }));
        return failed('google_mig_oracle_database', findings);
      }
      const pw = ident(valueOf(values, 'admin_password_var', 'odb_admin_password'));
      const ssh = ident(valueOf(values, 'ssh_public_key_var', 'ssh_public_key'));
      const create = valueOf(values, 'create_databases', 'yes') === 'yes';
      const licence = valueOf(values, 'licence', 'BRING_YOUR_OWN_LICENSE');
      const zone = valueOf(values, 'oracle_zone_id').trim();
      const location = x(`${lz}.region`);
      const oracleZone = zone || undefined;
      const blocks: HclBlock[] = [
        terraformBlock(create ? ['google', 'oci'] : ['google']),
        ...consumerPreamble('google', values),
        sshKeyVariable(ssh),
        secretVariable(pw, 'The ADMIN password of the Autonomous Database and the SYS/SYSTEM password of the databases created in the VM cluster.'),
        res('google_oracle_database_odb_network', 'odb', {
          odb_network_id: x(`"\${${lz}.prefix}-odb"`),
          location,
          network: x(`${lz}.network_ids[${q(net)}]`),
          // The same Oracle zone as the Exadata: chosen, or wherever Google placed it.
          gcp_oracle_zone: oracleZone ?? x('google_oracle_database_cloud_exadata_infrastructure.odb.gcp_oracle_zone'),
          deletion_protection: true,
          labels: x(hcl({ atk_purpose: 'oracle' })),
        }),
        res('google_oracle_database_odb_subnet', 'client', {
          odb_subnet_id: x(`"\${${lz}.prefix}-odb-client"`),
          location,
          odbnetwork: x('google_oracle_database_odb_network.odb.odb_network_id'),
          cidr_range: halves[0],
          purpose: 'CLIENT_SUBNET',
          deletion_protection: true,
        }),
        res('google_oracle_database_odb_subnet', 'backup', {
          odb_subnet_id: x(`"\${${lz}.prefix}-odb-backup"`),
          location,
          odbnetwork: x('google_oracle_database_odb_network.odb.odb_network_id'),
          cidr_range: halves[1],
          purpose: 'BACKUP_SUBNET',
          deletion_protection: true,
        }),
        res('google_oracle_database_cloud_exadata_infrastructure', 'odb', {
          cloud_exadata_infrastructure_id: x(`"\${${lz}.prefix}-exadata"`),
          display_name: x(`"\${${lz}.prefix}-exadata"`),
          location,
          gcp_oracle_zone: oracleZone,
          deletion_protection: true,
        }, [blk('properties', { shape: valueOf(values, 'exadata_shape', 'Exadata.X11M'), compute_count: numberOf(values, 'compute_count', 2), storage_count: numberOf(values, 'storage_count', 3) })]),
        res('google_oracle_database_cloud_vm_cluster', 'odb', {
          cloud_vm_cluster_id: x(`"\${${lz}.prefix}-vmc"`),
          display_name: x(`"\${${lz}.prefix}-vmc"`),
          location,
          exadata_infrastructure: x('google_oracle_database_cloud_exadata_infrastructure.odb.id'),
          odb_network: x('google_oracle_database_odb_network.odb.id'),
          odb_subnet: x('google_oracle_database_odb_subnet.client.id'),
          backup_odb_subnet: x('google_oracle_database_odb_subnet.backup.id'),
          deletion_protection: true,
        }, [
          blk('properties', {
            license_type: licence,
            cpu_core_count: numberOf(values, 'vm_cluster_cores', 16),
            gi_version: '23.0.0.0',
            hostname_prefix: 'odb',
            ssh_public_keys: x(`[var.${ssh}]`),
            local_backup_enabled: true,
          }, [blk('diagnostics_data_collection_options', { diagnostics_events_enabled: true, health_monitoring_enabled: true, incident_logs_enabled: true })]),
        ]),
        res('google_oracle_database_autonomous_database', 'odb', {
          autonomous_database_id: x(`"\${${lz}.prefix}-adb"`),
          display_name: x(`"\${${lz}.prefix}-adb"`),
          location,
          database: 'MIGADB',
          admin_password: x(`var.${pw}`),
          odb_network: x('google_oracle_database_odb_network.odb.id'),
          odb_subnet: x('google_oracle_database_odb_subnet.client.id'),
          deletion_protection: true,
        }, [
          blk('properties', {
            db_workload: 'OLTP',
            license_type: licence,
            db_edition: licence === 'BRING_YOUR_OWN_LICENSE' ? 'ENTERPRISE_EDITION' : undefined,
            compute_count: 2,
            data_storage_size_tb: 1,
            is_auto_scaling_enabled: true,
            mtls_connection_required: false,
          }),
        ]),
        ...odbOciDatabases(values, 'google_oracle_database_cloud_vm_cluster.odb.properties[0].ocid', 'google_oracle_database_cloud_vm_cluster.odb'),
        output('vm_cluster_ocid', 'google_oracle_database_cloud_vm_cluster.odb.properties[0].ocid'),
        output('odb_network_id', 'google_oracle_database_odb_network.odb.id'),
        output('autonomous_database_id', 'google_oracle_database_autonomous_database.odb.id'),
      ];
      findings.push(info('tf.mig.google-odb-basedb', 'Base Database Service (google_oracle_database_db_system) is not generated here: this blueprint builds the Exadata VM cluster and an Autonomous Database, and a Base Database system needs its own shape, storage and database, so google-odb-basedb rows are added by hand.', { path: 'databases' }));
      return { files: { 'main.tf': mainTf(blocks, 'Oracle Database@Google Cloud') }, findings };
    },
  };
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

function googleBackup(): Blueprint {
  return {
    id: 'google_mig_backup',
    label: 'Backup (migration)',
    group: MIGRATION_GROUP,
    description: 'Backup and DR Service: a backup vault (an enforced-retention vault per immutable tier), a backup plan per tier, and a plan association for every VM whose atk_backup tier matches.',
    inputs: backupInputs(),
    emits: ['google_backup_dr_backup_vault', 'google_backup_dr_backup_plan', 'google_backup_dr_backup_plan_association', 'google_project_iam_member'],
    build: (values: BlueprintValues) => {
      const findings: Finding[] = [];
      const lz = lzRef(values);
      const tiers = parseBackupTiers(valueOf(values, 'tiers'), findings);
      const dr = valueOf(values, 'dr_region');
      const vms = vmSource(values);
      const blocks: HclBlock[] = [TF(), ...consumerPreamble('google', values), ...vms.blocks];
      if (tiers.length === 0) {
        findings.push(error('tf.mig.no-tiers', 'The tiers grid is empty, so there is nothing to back up to.', { path: 'tiers' }));
        return failed('google_mig_backup', findings);
      }
      // A vault's minimum enforced retention applies to every backup in it, so each immutable tier gets its own.
      const vaultOf = (t: (typeof tiers)[number]) => (t.immutable ? ident('vault', t.tier) : 'standard');
      const vaults = new Map<string, { retention: number; immutable: boolean }>();
      for (const t of tiers) vaults.set(vaultOf(t), t.immutable ? { retention: t.retention, immutable: true } : { retention: 1, immutable: false });
      for (const [label, v] of vaults) {
        blocks.push(
          res('google_backup_dr_backup_vault', label, {
            backup_vault_id: x(`"\${${lz}.prefix}-${label.replace(/_/g, '-')}"`),
            location: x(`${lz}.region`),
            description: v.immutable ? `Backups kept at least ${v.retention} days, which nobody can shorten` : 'Backups of the tiers without enforced retention',
            backup_minimum_enforced_retention_duration: `${v.retention * 86400}s`,
            // Locked three days after creation: until then the retention can still be corrected.
            effective_time: v.immutable ? x('timeadd(plantimestamp(), "72h")') : undefined,
            labels: x(hcl({ atk_purpose: 'backup' })),
          }, v.immutable ? [ignoreChanges(['effective_time'])] : []),
          res('google_project_iam_member', `backup_${label}`, {
            project: x(`${lz}.project`),
            role: 'roles/backupdr.computeEngineOperator',
            member: x(`"serviceAccount:\${google_backup_dr_backup_vault.${label}.service_account}"`),
          }),
        );
      }
      const planOf: Record<string, string> = {};
      for (const t of tiers) {
        const label = ident(t.tier);
        const hours = t.hours < 24 ? Math.max(6, t.hours) : 24;
        if (t.hours < 6) findings.push(info('tf.mig.google-backup-hourly', `Tier ${t.tier}: Backup and DR runs Compute Engine backups at most every 6 hours, so it is every 6.`, { path: 'tiers' }));
        blocks.push(
          res('google_backup_dr_backup_plan', label, {
            backup_plan_id: x(`"\${${lz}.prefix}-${t.tier}"`),
            location: x(`${lz}.region`),
            resource_type: 'compute.googleapis.com/Instance',
            backup_vault: x(`google_backup_dr_backup_vault.${vaultOf(t)}.id`),
            description: `Tier ${t.tier}: every ${hours} hours, kept ${t.retention} days`,
            depends_on: x(`[google_project_iam_member.backup_${vaultOf(t)}]`),
          }, [
            blk('backup_rules', { rule_id: t.tier, backup_retention_days: t.retention }, [
              blk('standard_schedule', hours < 24 ? { recurrence_type: 'HOURLY', hourly_frequency: hours, time_zone: 'UTC' } : { recurrence_type: 'DAILY', time_zone: 'UTC' }, [
                blk('backup_window', hours < 24 ? { start_hour_of_day: 0, end_hour_of_day: 24 } : { start_hour_of_day: 1, end_hour_of_day: 7 }),
              ]),
            ]),
          ]),
        );
        planOf[t.tier] = `google_backup_dr_backup_plan.${label}.name`;
        if (t.copy) {
          findings.push(
            info('tf.mig.google-backup-dr-copy', `Tier ${t.tier} asks for a copy in ${dr || 'a DR region'}: the Backup and DR plan schema has no cross-region copy, so that copy is set up outside this blueprint (a vault in the DR region and a second plan, or snapshot schedules with a multi-region location).`, { path: dr ? 'tiers' : 'dr_region' }),
          );
        }
      }
      blocks.push(
        res('google_backup_dr_backup_plan_association', 'vm', {
          for_each: x(`{ for k, v in ${vms.expr} : k => v if contains(${hcl(tiers.map((t) => t.tier))}, v.backup) }`),
          backup_plan_association_id: x(`"\${${lz}.prefix}-\${each.key}"`),
          location: x(`${lz}.region`),
          resource_type: 'compute.googleapis.com/Instance',
          resource: x('each.value.id'),
          backup_plan: x(`${hcl(Object.fromEntries(Object.entries(planOf).map(([k, v]) => [k, e(v)])), 2)}[each.value.backup]`),
        }),
        output('vaults', `{ ${[...vaults.keys()].map((l) => `${l} = google_backup_dr_backup_vault.${l}.id`).join(', ')} }`),
        output('plans', `{ ${tiers.map((t) => `${ident(t.tier)} = google_backup_dr_backup_plan.${ident(t.tier)}.id`).join(', ')} }`),
      );
      findings.push(info('tf.mig.google-backup-cmek', 'The backup vaults use Google-managed encryption: Backup and DR does not take the landing zone\'s key here.', { path: 'tiers' }));
      return { files: { 'main.tf': mainTf(blocks, `Google Cloud backup: ${tiers.length} tier(s)`) }, findings };
    },
  };
}

// ---------------------------------------------------------------------------
// Monitoring
// ---------------------------------------------------------------------------

const OPS_AGENT_LINUX_CHECK = 'if systemctl is-active --quiet google-cloud-ops-agent; then exit 100; else exit 101; fi';
const OPS_AGENT_LINUX_INSTALL = 'curl -sSfO https://dl.google.com/cloudagents/add-google-cloud-ops-agent-repo.sh && bash add-google-cloud-ops-agent-repo.sh --also-install && exit 100';
const OPS_AGENT_WINDOWS_CHECK = 'if (Get-Service -Name google-cloud-ops-agent -ErrorAction SilentlyContinue) { exit 100 } else { exit 101 }';
const OPS_AGENT_WINDOWS_INSTALL =
  "$f = Join-Path $env:TEMP 'add-google-cloud-ops-agent-repo.ps1'; (New-Object Net.WebClient).DownloadFile('https://dl.google.com/cloudagents/add-google-cloud-ops-agent-repo.ps1', $f); & $f -AlsoInstall; exit 100";

function opsAgentPolicy(id: string, osNames: readonly string[], interpreter: 'SHELL' | 'POWERSHELL', check: string, install: string): HclBlock {
  return blk('os_policies', { id, mode: 'ENFORCEMENT', allow_no_resource_group_match: true, description: 'Install the Ops Agent' }, [
    blk('resource_groups', {}, [
      ...osNames.map((os) => blk('inventory_filters', { os_short_name: os })),
      blk('resources', { id: `${id}-install` }, [blk('exec', {}, [blk('validate', { interpreter, script: check }), blk('enforce', { interpreter, script: install })])]),
    ]),
  ]);
}

function googleMonitoring(): Blueprint {
  return {
    id: 'google_mig_monitoring',
    label: 'Monitoring (migration)',
    group: MIGRATION_GROUP,
    description: 'The Ops Agent on every migrated VM through VM Manager OS policies (Linux and Windows, selected by the atk_os_family label), and the retention of the project\'s default log bucket.',
    inputs: [...monitoringInputs(), LANDING_ZONE_SOURCE],
    emits: ['google_os_config_os_policy_assignment', 'google_logging_project_bucket_config'],
    build: (values: BlueprintValues) => {
      const findings: Finding[] = [];
      const lz = lzRef(values);
      const retention = Number(valueOf(values, 'retention_days', '90')) || 90;
      const siem = valueOf(values, 'siem', 'none');
      const blocks: HclBlock[] = [
        TF(),
        ...consumerPreamble('google', values),
        res('google_os_config_os_policy_assignment', 'ops_agent', {
          for_each: x(`toset(${lz}.zones)`),
          name: x(`"\${${lz}.prefix}-ops-agent-\${each.key}"`),
          location: x('each.key'),
          description: 'Installs the Ops Agent on the migrated VMs',
        }, [
          blk('instance_filter', { all: false }, ['rhel', 'suse', 'debian', 'windows'].map((f) => blk('inclusion_labels', { labels: x(hcl({ atk_os_family: f }, 3)) }))),
          opsAgentPolicy('ops-agent-linux', ['rhel', 'centos', 'rocky', 'sles', 'ubuntu', 'debian'], 'SHELL', OPS_AGENT_LINUX_CHECK, OPS_AGENT_LINUX_INSTALL),
          opsAgentPolicy('ops-agent-windows', ['windows'], 'POWERSHELL', OPS_AGENT_WINDOWS_CHECK, OPS_AGENT_WINDOWS_INSTALL),
          blk('rollout', { min_wait_duration: '60s' }, [blk('disruption_budget', { percent: 25 })]),
        ], 'OS policy assignments are zonal: one per landing-zone zone.'),
        res('google_logging_project_bucket_config', 'default', {
          project: x(`${lz}.project`),
          location: 'global',
          bucket_id: '_Default',
          retention_days: retention,
        }, [], 'The project\'s own _Default log bucket: only its retention is managed; destroying this leaves the bucket.'),
        output('os_policy_assignments', '[for a in google_os_config_os_policy_assignment.ops_agent : a.id]'),
      ];
      findings.push(info('tf.mig.google-osconfig', 'OS policies need the OS Config API and the VM Manager agent: the compute blueprint sets enable-osconfig on every VM.', { path: 'siem' }));
      if (siem !== 'none') findings.push(info('tf.mig.siem', `Forwarding to ${siem} is configured in the SIEM, which reads the landing zone's log bucket or a Pub/Sub sink; nothing is written here for it.`, { path: 'siem' }));
      return { files: { 'main.tf': mainTf(blocks, 'Google Cloud monitoring: the Ops Agent through VM Manager') }, findings };
    },
  };
}

export const MIGRATION_TERRAFORM_GOOGLE: readonly Blueprint[] = [
  googleLandingZone(),
  googleIdentity(),
  googleConnectivity(),
  googleCompute(),
  googleDatabases(),
  googleOracleDatabase(),
  googleBackup(),
  googleMonitoring(),
];
