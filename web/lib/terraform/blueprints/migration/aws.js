/**
 * AWS blueprints for a migration plan: landing zone, identity, connectivity,
 * compute, databases, Oracle Database@AWS, backup and monitoring.
 *
 * See ./common.ts for the landing-zone contract and the grid formats. Every
 * argument written here was checked against the aws provider's own schema
 * (6.66.0) with `terraform validate`, by tools/validate-terraform-blueprints.mjs.
 */

import { error, info, warning,              } from '../../../core/findings.js';
import { familyOf } from '../../../core/ip.js';
                                                                            
import { num as numberOf, str as valueOf } from '../../../kit/blueprint.js';
import { AWS_DB_INSTANCE_CLASSES, AWS_INSTANCE_TYPES } from '../../../kit/choices.js';
import { AWS_REGIONS } from '../../../kit/regions.js';
                                             
import { emitFoundation } from '../../index.js';
import {
  backupInputs,
  monitoringInputs,
  odbInputs,
  odbOciDatabases,
  DB_PORTS,
  DEFAULT_BACKUP_TIERS,
  DEFAULT_SITES,
  LANDING_ZONE_SOURCE,
  MIGRATION_GROUP,
  SITE_COLUMNS,
  YES_NO,
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
  gridInput,
  hcl,
  hlist,
  ident,
  ignoreChanges,
  jsonencode,
  landingZoneInputs,
  landingZoneLocal,
  landingZoneNote,
  lzRef,
  lzSource,
  mainTf,
  opts,
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
  siteSources,
  sshKeyVariable,
  terraformBlock,
  variable,
  vmColumns,
  vmLocalEntry,
  winrmBootstrap,
  withHost,
  words,
  x,
              
                   
                  
              
} from './common.js';

const REGION = 'us-east-1';
const TF = () => terraformBlock(['aws']);

/** The instance families the planner sizes to, first; the whole list is too long for a grid cell. */
const SIZES = AWS_INSTANCE_TYPES.filter((o) => /^(m7i|c7i|r7i|m7i-flex|r7iz|x2idn|t3)\./.test(o.value)).map((o) => o.value);
const DB_CLASSES = AWS_DB_INSTANCE_CLASSES.filter((o) => /^db\.(r7i|m7i|r6i|m6i|x2iedn|t3)\./.test(o.value)).map((o) => o.value);

const failed = (id        , findings                    ) => ({
  files: { 'main.tf': `# ${id}: nothing was generated; see the findings.\n` },
  findings,
});

// ---------------------------------------------------------------------------
// Landing zone
// ---------------------------------------------------------------------------

                
                         
                        
                         
                         
                       
                         
                             
                        
                       
 

/** Ports a domain controller in the mgmt tier needs open to the network and to on-premises DCs. */
const AD_PORTS                                                 = [
  ['tcp', 53, 53], ['udp', 53, 53], ['tcp', 88, 88], ['udp', 88, 88], ['udp', 123, 123], ['tcp', 135, 135],
  ['tcp', 389, 389], ['udp', 389, 389], ['tcp', 445, 445], ['tcp', 464, 464], ['udp', 464, 464],
  ['tcp', 636, 636], ['tcp', 3268, 3269], ['tcp', 49152, 65535],
];

function tierRules(lzPrefix        , n             , tier        , sites                   )         {
  const rules         = [];
  const has = (t        ) => n.tiers.includes(t         );
  const sg = (t        ) => `aws_security_group.${n.id}_${t}.id`;
  const siteRule = (port        , proto = 'tcp') =>
    sites.forEach((c, i) => rules.push({ label: `site_${proto}_${port}_${i}`, desc: `${proto.toUpperCase()} ${port} from ${c}`, proto, from: port, to: port, cidr: c, v6: familyOf(c) === 6 }));
  // Ansible (SSH, WinRM over HTTPS) from on-premises reaches every tier.
  siteRule(22);
  siteRule(5986);
  if (tier === 'mgmt') siteRule(3389);
  if (tier === 'web') {
    siteRule(443);
    rules.push({ label: 'vpc_443', desc: 'HTTPS from inside the VPC (load balancers)', proto: 'tcp', from: 443, to: 443, cidr: n.cidr });
    if (n.ipv6) rules.push({ label: 'vpc_443_v6', desc: 'HTTPS from inside the VPC, IPv6', proto: 'tcp', from: 443, to: 443, cidrExpr: `aws_vpc.${n.id}.ipv6_cidr_block`, v6: true });
  }
  if (tier === 'app' && has('web')) rules.push({ label: 'from_web', desc: 'All TCP from the web tier', proto: 'tcp', from: 0, to: 65535, sg: sg('web') });
  if (tier === 'db') {
    for (const port of DB_PORTS) {
      if (has('app')) rules.push({ label: `from_app_${port}`, desc: `TCP ${port} from the app tier`, proto: 'tcp', from: port, to: port, sg: sg('app') });
      if (has('mgmt')) rules.push({ label: `from_mgmt_${port}`, desc: `TCP ${port} from the mgmt tier`, proto: 'tcp', from: port, to: port, sg: sg('mgmt') });
    }
    // Cluster traffic between database hosts: AG endpoints, RAC interconnect, replication.
    rules.push({ label: 'self', desc: 'Everything between database hosts', proto: '-1', sg: sg('db') });
  }
  if (tier !== 'mgmt' && has('mgmt')) {
    for (const port of [22, 3389, 5986]) rules.push({ label: `from_mgmt_admin_${port}`, desc: `TCP ${port} from the mgmt tier`, proto: 'tcp', from: port, to: port, sg: sg('mgmt') });
  }
  if (tier === 'mgmt') {
    // Domain controllers live here (extend-dcs): the directory ports from the network and from on-premises DCs.
    const sources                                               = [
      { c: n.cidr, v6: false },
      ...(n.ipv6 ? [{ expr: `aws_vpc.${n.id}.ipv6_cidr_block`, v6: true }] : []),
      ...sites.map((c) => ({ c, v6: familyOf(c) === 6 })),
    ];
    sources.forEach((s, si) => {
      for (const [proto, from, to] of AD_PORTS) {
        rules.push({ label: `ad_${proto}_${from}_${si}`, desc: `AD ${proto.toUpperCase()} ${from === to ? from : `${from}-${to}`}`, proto, from, to, ...(s.c ? { cidr: s.c } : { cidrExpr: s.expr }), v6: s.v6 });
      }
    });
  }
  // ICMP from the network and on-premises: path MTU discovery needs it, IPv6 most of all.
  rules.push({ label: 'icmp', desc: 'ICMP from inside the VPC', proto: 'icmp', from: -1, to: -1, cidr: n.cidr });
  if (n.ipv6) rules.push({ label: 'icmpv6', desc: 'ICMPv6 from inside the VPC', proto: 'icmpv6', from: -1, to: -1, cidrExpr: `aws_vpc.${n.id}.ipv6_cidr_block`, v6: true });
  sites.forEach((c, i) => rules.push({ label: `site_icmp_${i}`, desc: `ICMP from ${c}`, proto: familyOf(c) === 6 ? 'icmpv6' : 'icmp', from: -1, to: -1, cidr: c, v6: familyOf(c) === 6 }));
  void lzPrefix;
  return rules;
}

function securityGroups(prefix        , n             , sites                   )             {
  const blocks             = [];
  for (const tier of n.tiers) {
    const label = `${n.id}_${tier}`;
    blocks.push(
      res('aws_security_group', label, {
        name: rname(prefix, n.name, tier),
        description: `The ${tier} tier of ${n.name}`,
        vpc_id: x(`aws_vpc.${n.id}.id`),
        tags: x(hcl({ Name: rname(prefix, n.name, tier), atk_tier: tier })),
      }),
    );
    for (const r of tierRules(prefix, n, tier, sites)) {
      blocks.push(
        res('aws_vpc_security_group_ingress_rule', `${label}_${r.label}`, {
          security_group_id: x(`aws_security_group.${label}.id`),
          ...(r.sg ? { referenced_security_group_id: x(r.sg) } : r.v6 ? { cidr_ipv6: r.cidrExpr ? x(r.cidrExpr) : r.cidr } : { cidr_ipv4: r.cidrExpr ? x(r.cidrExpr) : r.cidr }),
          ip_protocol: r.proto,
          ...(r.proto === '-1' ? {} : { from_port: r.from, to_port: r.to }),
          description: r.desc,
        }),
      );
    }
    blocks.push(res('aws_vpc_security_group_egress_rule', `${label}_all`, { security_group_id: x(`aws_security_group.${label}.id`), cidr_ipv4: '0.0.0.0/0', ip_protocol: '-1', description: 'All outbound' }));
    if (n.ipv6) {
      blocks.push(res('aws_vpc_security_group_egress_rule', `${label}_all_v6`, { security_group_id: x(`aws_security_group.${label}.id`), cidr_ipv6: '::/0', ip_protocol: '-1', description: 'All outbound, IPv6' }));
    }
  }
  return blocks;
}

const ENDPOINTS = ['ssm', 'ssmmessages', 'ec2messages', 'logs', 'monitoring']         ;

function awsLandingZone()            {
  return {
    id: 'aws_mig_landing_zone',
    label: 'Landing zone (migration)',
    group: MIGRATION_GROUP,
    description: `Dual-stack VPCs from the networks grid (built on the network foundation), a security group per tier, a KMS key, a log bucket with CloudTrail and flow logs, Session Manager endpoints and the instance role. ${landingZoneNote}`,
    inputs: landingZoneInputs('aws', AWS_REGIONS, REGION),
    emits: [
      'aws_vpc', 'aws_subnet', 'aws_egress_only_internet_gateway', 'aws_route_table', 'aws_route', 'aws_route_table_association',
      'aws_security_group', 'aws_vpc_security_group_ingress_rule', 'aws_vpc_security_group_egress_rule', 'aws_vpc_endpoint',
      'aws_kms_key', 'aws_kms_alias', 'aws_s3_bucket', 'aws_s3_bucket_versioning', 'aws_s3_bucket_server_side_encryption_configuration',
      'aws_s3_bucket_public_access_block', 'aws_s3_bucket_ownership_controls', 'aws_s3_bucket_lifecycle_configuration', 'aws_s3_bucket_policy',
      'aws_flow_log', 'aws_cloudtrail', 'aws_iam_role', 'aws_iam_role_policy_attachment', 'aws_iam_instance_profile',
    ],
    build: (values                 ) => {
      const findings            = [];
      const lz = parseLandingZone(values, REGION, findings);
      if (findings.some((f) => f.severity === 'error')) return failed('aws_mig_landing_zone', findings);
      const cmk = lz.keys !== 'provider-managed';
      const account = 'data.aws_caller_identity.current.account_id';
      const partition = 'data.aws_partition.current.partition';
      const blocks                        = [
        TF(),
        {
          type: 'provider',
          labels: ['aws'],
          attributes: attrs({ region: lz.region, allowed_account_ids: lz.scope ? [lz.scope] : undefined }),
        },
        dat('aws_availability_zones', 'available', { state: 'available' }),
        dat('aws_caller_identity', 'current', {}),
        dat('aws_partition', 'current', {}),
        ...(lz.keys === 'hsm' ? [variable('kms_custom_key_store_id', 'string', 'The CloudHSM-backed custom key store the landing-zone key is created in.')] : []),
      ];

      const subnetsByNet = new Map                      ();
      for (const n of lz.networks) {
        const subnets = carveNetwork(n, lz.prefixLen, true, [], findings);
        if (subnets.length === 0) continue;
        subnetsByNet.set(n.id, subnets);
        const out = emitFoundation('aws', {
          name: rname(lz.prefix, n.name),
          cidr: n.cidr,
          ipv6: n.ipv6,
          subnets: subnets.map((s) => ({ name: s.short, cidr: s.cidr, zone: `${lz.region}${s.zone}` })),
          tags: { atk_network: n.name, atk_env: n.envs.join(' ') },
        });
        findings.push(...out.findings.filter((f) => f.severity !== 'info'));
        blocks.push(
          reworkFoundation(out.files['main.tf'] ?? '', n.id, {
            // The emitter's single security group and private route table give way to a group per tier and a table routes can be added to.
            drop: (_kind, [type = '']) => type === 'aws_security_group' || type.startsWith('aws_vpc_security_group_') || type === 'aws_route_table' || type === 'aws_route_table_association',
            edit: (type, _label, text) =>
              type === 'aws_subnet'
                ? text.replace(/availability_zone(\s*)= "[^"]*?([abc])"/, (_m, sp        , z        ) => `availability_zone${sp}= data.aws_availability_zones.available.names[${ZONE_LETTERS.indexOf(z       )}]`)
                : text,
          }),
        );

        const rt = `aws_route_table.${n.id}_private.id`;
        blocks.push(
          res('aws_route_table', `${n.id}_private`, { vpc_id: x(`aws_vpc.${n.id}.id`), tags: x(hcl({ Name: rname(lz.prefix, n.name, 'private') })) }, [], 'Routes are separate aws_route resources, so connectivity can add its own to this table.'),
        );
        if (n.ipv6) {
          blocks.push(res('aws_route', `${n.id}_ipv6_default`, { route_table_id: x(rt), destination_ipv6_cidr_block: '::/0', egress_only_gateway_id: x(`aws_egress_only_internet_gateway.${n.id}.id`) }));
        }
        for (const s of subnets) blocks.push(res('aws_route_table_association', s.label, { subnet_id: x(`aws_subnet.${s.label}.id`), route_table_id: x(rt) }));

        blocks.push(...securityGroups(lz.prefix, n, siteSources(lz, n)));

        // Session Manager and the CloudWatch agent without a NAT gateway: interface endpoints, and S3 for packages.
        blocks.push(res('aws_vpc_endpoint', `${n.id}_s3`, { vpc_id: x(`aws_vpc.${n.id}.id`), service_name: `com.amazonaws.${lz.region}.s3`, vpc_endpoint_type: 'Gateway', route_table_ids: x(`[${rt}]`), tags: x(hcl({ Name: rname(lz.prefix, n.name, 's3') })) }));
        blocks.push(res('aws_security_group', `${n.id}_endpoints`, { name: rname(lz.prefix, n.name, 'endpoints'), description: `Interface endpoints in ${n.name}`, vpc_id: x(`aws_vpc.${n.id}.id`) }));
        blocks.push(res('aws_vpc_security_group_ingress_rule', `${n.id}_endpoints_443`, { security_group_id: x(`aws_security_group.${n.id}_endpoints.id`), cidr_ipv4: n.cidr, ip_protocol: 'tcp', from_port: 443, to_port: 443, description: 'HTTPS from the VPC' }));
        if (n.ipv6) {
          blocks.push(res('aws_vpc_security_group_ingress_rule', `${n.id}_endpoints_443_v6`, { security_group_id: x(`aws_security_group.${n.id}_endpoints.id`), cidr_ipv6: x(`aws_vpc.${n.id}.ipv6_cidr_block`), ip_protocol: 'tcp', from_port: 443, to_port: 443, description: 'HTTPS from the VPC, IPv6' }));
        }
        const zoneSubnets = zoneSubnetLabels(n, subnets);
        for (const svc of ENDPOINTS) {
          blocks.push(
            res(
              'aws_vpc_endpoint',
              `${n.id}_${svc}`,
              {
                vpc_id: x(`aws_vpc.${n.id}.id`),
                service_name: `com.amazonaws.${lz.region}.${svc}`,
                vpc_endpoint_type: 'Interface',
                private_dns_enabled: true,
                // IPv4: not every one of these services offers a dual-stack endpoint in every region.
                ip_address_type: 'ipv4',
                subnet_ids: x(hlist(zoneSubnets.map((l) => `aws_subnet.${l}.id`))),
                security_group_ids: x(`[aws_security_group.${n.id}_endpoints.id]`),
              },
              [blk('dns_options', { dns_record_ip_type: 'ipv4' })],
            ),
          );
        }
        blocks.push(
          res('aws_flow_log', n.id, {
            vpc_id: x(`aws_vpc.${n.id}.id`),
            traffic_type: 'ALL',
            log_destination_type: 's3',
            log_destination: x('aws_s3_bucket.logs.arn'),
            max_aggregation_interval: 600,
            tags: x(hcl({ Name: rname(lz.prefix, n.name, 'flow-log') })),
            depends_on: x('[aws_s3_bucket_policy.logs]'),
          }),
        );
      }
      if (findings.some((f) => f.severity === 'error')) return failed('aws_mig_landing_zone', findings);

      // The key everything is encrypted with.
      if (cmk) {
        blocks.push(
          res('aws_kms_key', 'landing_zone', {
            description: `${lz.prefix} landing zone`,
            deletion_window_in_days: 30,
            // A custom key store does not rotate automatically; rotate it by hand.
            enable_key_rotation: lz.keys !== 'hsm',
            custom_key_store_id: lz.keys === 'hsm' ? x('var.kms_custom_key_store_id') : undefined,
            policy: x(
              jsonencode({
                Version: '2012-10-17',
                Statement: [
                  { Sid: 'Account', Effect: 'Allow', Principal: { AWS: e(`"arn:\${${partition}}:iam::\${${account}}:root"`) }, Action: 'kms:*', Resource: '*' },
                  { Sid: 'CloudTrail', Effect: 'Allow', Principal: { Service: 'cloudtrail.amazonaws.com' }, Action: ['kms:GenerateDataKey*', 'kms:DescribeKey'], Resource: '*' },
                  { Sid: 'LogDelivery', Effect: 'Allow', Principal: { Service: 'delivery.logs.amazonaws.com' }, Action: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey'], Resource: '*' },
                  { Sid: 'CloudWatchLogs', Effect: 'Allow', Principal: { Service: `logs.${lz.region}.amazonaws.com` }, Action: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'], Resource: '*' },
                ],
              }),
            ),
          }),
          res('aws_kms_alias', 'landing_zone', { name: `alias/${lz.prefix}-landing-zone`, target_key_id: x('aws_kms_key.landing_zone.key_id') }),
        );
        if (lz.keys === 'hsm') findings.push(info('tf.mig.aws-hsm-rotation', 'An HSM-backed (custom key store) key does not rotate automatically; plan a manual rotation.', { path: 'keys' }));
      }

      // Logs: one bucket for CloudTrail and the flow logs.
      const bucketArn = 'aws_s3_bucket.logs.arn';
      blocks.push(
        res('aws_s3_bucket', 'logs', { bucket: x(`"${lz.prefix}-logs-\${${account}}-${lz.region}"`), tags: x(hcl({ Name: rname(lz.prefix, 'logs') })) }),
        res('aws_s3_bucket_versioning', 'logs', { bucket: x('aws_s3_bucket.logs.id') }, [blk('versioning_configuration', { status: 'Enabled' })]),
        res('aws_s3_bucket_server_side_encryption_configuration', 'logs', { bucket: x('aws_s3_bucket.logs.id') }, [
          blk('rule', { bucket_key_enabled: cmk ? true : undefined }, [
            blk('apply_server_side_encryption_by_default', cmk ? { sse_algorithm: 'aws:kms', kms_master_key_id: x('aws_kms_key.landing_zone.arn') } : { sse_algorithm: 'AES256' }),
          ]),
        ]),
        res('aws_s3_bucket_public_access_block', 'logs', { bucket: x('aws_s3_bucket.logs.id'), block_public_acls: true, block_public_policy: true, ignore_public_acls: true, restrict_public_buckets: true }),
        res('aws_s3_bucket_ownership_controls', 'logs', { bucket: x('aws_s3_bucket.logs.id') }, [blk('rule', { object_ownership: 'BucketOwnerEnforced' })]),
        res('aws_s3_bucket_lifecycle_configuration', 'logs', { bucket: x('aws_s3_bucket.logs.id') }, [
          blk('rule', { id: 'retention', status: 'Enabled' }, [blk('filter', {}), blk('expiration', { days: lz.retention }), blk('noncurrent_version_expiration', { noncurrent_days: 30 })]),
        ]),
        res('aws_s3_bucket_policy', 'logs', {
          bucket: x('aws_s3_bucket.logs.id'),
          policy: x(
            jsonencode({
              Version: '2012-10-17',
              Statement: [
                { Sid: 'DenyInsecureTransport', Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: [e(bucketArn), e(`"\${${bucketArn}}/*"`)], Condition: { Bool: { 'aws:SecureTransport': 'false' } } },
                { Sid: 'CloudTrailAcl', Effect: 'Allow', Principal: { Service: 'cloudtrail.amazonaws.com' }, Action: 's3:GetBucketAcl', Resource: e(bucketArn) },
                { Sid: 'CloudTrailWrite', Effect: 'Allow', Principal: { Service: 'cloudtrail.amazonaws.com' }, Action: 's3:PutObject', Resource: e(`"\${${bucketArn}}/AWSLogs/\${${account}}/*"`), Condition: { StringEquals: { 's3:x-amz-acl': 'bucket-owner-full-control' } } },
                { Sid: 'FlowLogsAcl', Effect: 'Allow', Principal: { Service: 'delivery.logs.amazonaws.com' }, Action: 's3:GetBucketAcl', Resource: e(bucketArn) },
                { Sid: 'FlowLogsWrite', Effect: 'Allow', Principal: { Service: 'delivery.logs.amazonaws.com' }, Action: 's3:PutObject', Resource: e(`"\${${bucketArn}}/AWSLogs/\${${account}}/*"`), Condition: { StringEquals: { 's3:x-amz-acl': 'bucket-owner-full-control' } } },
              ],
            }),
          ),
          depends_on: x('[aws_s3_bucket_public_access_block.logs]'),
        }),
        res('aws_cloudtrail', 'landing_zone', {
          name: `${lz.prefix}-trail`,
          s3_bucket_name: x('aws_s3_bucket.logs.id'),
          is_multi_region_trail: true,
          include_global_service_events: true,
          enable_log_file_validation: true,
          enable_logging: true,
          kms_key_id: cmk ? x('aws_kms_key.landing_zone.arn') : undefined,
          depends_on: x('[aws_s3_bucket_policy.logs]'),
        }),
      );

      // The role every VM gets: Session Manager and the CloudWatch agent.
      blocks.push(
        res('aws_iam_role', 'instance', {
          name: `${lz.prefix}-instance`,
          assume_role_policy: x(jsonencode({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }] })),
        }),
        res('aws_iam_role_policy_attachment', 'instance_ssm', { role: x('aws_iam_role.instance.name'), policy_arn: x(`"arn:\${${partition}}:iam::aws:policy/AmazonSSMManagedInstanceCore"`) }),
        res('aws_iam_role_policy_attachment', 'instance_cloudwatch', { role: x('aws_iam_role.instance.name'), policy_arn: x(`"arn:\${${partition}}:iam::aws:policy/CloudWatchAgentServerPolicy"`) }),
        res('aws_iam_instance_profile', 'instance', { name: `${lz.prefix}-instance`, role: x('aws_iam_role.instance.name') }),
      );

      // The contract.
      const subnetIds                         = {};
      const sgIds                         = {};
      const mgmt           = lz.siteV4.map(q);
      if (lz.anyV6) mgmt.push(...lz.siteV6.map(q));
      for (const n of lz.networks) {
        for (const s of subnetsByNet.get(n.id) ?? []) {
          subnetIds[`${n.name}/${s.tier}/${s.zone}`] = `aws_subnet.${s.label}.id`;
          if (s.tier === 'mgmt') {
            mgmt.push(q(s.cidr));
            if (n.ipv6) mgmt.push(`aws_subnet.${s.label}.ipv6_cidr_block`);
          }
        }
        for (const t of n.tiers) sgIds[`${n.name}/${t}`] = `aws_security_group.${n.id}_${t}.id`;
      }
      const byNet = (f                            ) => hcl(Object.fromEntries(lz.networks.map((n) => [n.name, e(f(n))])), 2);
      blocks.push(
        landingZoneLocal('aws', {
          prefix: q(lz.prefix),
          region: q(lz.region),
          network_ids: byNet((n) => `aws_vpc.${n.id}.id`),
          subnet_ids: hcl(Object.fromEntries(Object.entries(subnetIds).map(([k, v]) => [k, e(v)])), 2),
          security_group_ids: hcl(Object.fromEntries(Object.entries(sgIds).map(([k, v]) => [k, e(v)])), 2),
          kms_key_id: cmk ? 'aws_kms_key.landing_zone.arn' : 'null',
          log_destination: bucketArn,
          resource_group: 'null',
          zones: `slice(data.aws_availability_zones.available.names, 0, ${lz.maxZones})`,
          mgmt_cidrs: `[${mgmt.join(', ')}]`,
          ipv6: byNet((n) => String(n.ipv6)),
          instance_profile: 'aws_iam_instance_profile.instance.name',
          route_table_ids: byNet((n) => `aws_route_table.${n.id}_private.id`),
          zone_subnet_ids: byNet((n) => hlist(zoneSubnetLabels(n, subnetsByNet.get(n.id) ?? []).map((l) => `aws_subnet.${l}.id`))),
          network_cidrs: byNet((n) => hlist([q(n.cidr), ...(n.ipv6 ? [`aws_vpc.${n.id}.ipv6_cidr_block`] : [])])),
        }),
        output('landing_zone', 'local.landing_zone', 'The landing-zone contract: the value of the landing_zone variable of a blueprint used on its own.'),
        ...['network_ids', 'subnet_ids', 'security_group_ids', 'kms_key_id', 'log_destination', 'zones'].map((k) => output(k, `local.landing_zone.${k}`)),
      );
      if (lz.bastion === 'cloud-native') {
        findings.push(info('tf.mig.aws-session-manager', 'Administrative access is Session Manager through the interface endpoints: no bastion host and no inbound port from the internet.', { path: 'bastion' }));
      }
      findings.push(info('tf.mig.aws-no-nat', 'The subnets are private with no NAT gateway: IPv4 out goes through the VPC endpoints and on-premises; IPv6 out through the egress-only gateway. Add a NAT gateway if a VM needs the IPv4 internet.', { path: 'networks' }));
      return { files: { 'main.tf': mainTf(blocks, `AWS landing zone: ${lz.prefix} in ${lz.region}`) }, findings };
    },
  };
}

/** One subnet per zone of the network's first tier (mgmt when it has one): what endpoints and attachments sit in. */
function zoneSubnetLabels(n             , subnets                       )           {
  const tier = n.tiers.includes('mgmt') ? 'mgmt' : n.tiers[0];
  return subnets.filter((s) => s.tier === tier).map((s) => s.label);
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

function awsIdentity()            {
  return {
    id: 'aws_mig_identity',
    label: 'Identity (migration)',
    group: MIGRATION_GROUP,
    description: 'AWS Managed Microsoft AD, or only DNS: a Route 53 Resolver outbound endpoint forwarding the domain to the domain controllers (extended on-premises DCs, or the ones the compute grid builds).',
    inputs: [
      { id: 'strategy', label: 'Strategy', control: 'select', default: 'resolver-only', options: [{ value: 'managed-ad', label: 'AWS Managed Microsoft AD' }, { value: 'resolver-only', label: 'Forward DNS to our own DCs (extend-dcs)' }] },
      { id: 'domain', label: 'Domain', control: 'text', default: 'corp.example.com' },
      { id: 'edition', label: 'Edition', control: 'select', default: 'Enterprise', options: opts(['Standard', 'Enterprise']), showWhen: { input: 'strategy', equals: ['managed-ad'] } },
      { id: 'dns_forwarders', label: 'Domain controller addresses', control: 'text', default: '10.0.0.10 10.0.0.11', hint: 'Space-separated, either family.', showWhen: { input: 'strategy', equals: ['resolver-only'] } },
      { id: 'network', label: 'Network', control: 'text', default: 'prod', hint: 'The landing-zone network the directory and resolver sit in.' },
      LANDING_ZONE_SOURCE,
    ],
    emits: ['aws_directory_service_directory', 'aws_security_group', 'aws_vpc_security_group_egress_rule', 'aws_route53_resolver_endpoint', 'aws_route53_resolver_rule', 'aws_route53_resolver_rule_association'],
    build: (values                 ) => {
      const findings            = [];
      const lz = lzRef(values);
      const managed = valueOf(values, 'strategy', 'resolver-only') === 'managed-ad';
      const domain = valueOf(values, 'domain', 'corp.example.com');
      const net = rname(valueOf(values, 'network', 'prod'));
      const forwarders = words(valueOf(values, 'dns_forwarders'));
      const subnets = `${lz}.zone_subnet_ids[${q(net)}]`;
      const blocks             = [TF(), ...consumerPreamble('aws', values)];
      if (managed) {
        blocks.push(
          secretVariable('ad_admin_password', 'The Admin password of the AWS Managed Microsoft AD directory.'),
          res('aws_directory_service_directory', 'managed_ad', {
            name: domain,
            password: x('var.ad_admin_password'),
            edition: valueOf(values, 'edition', 'Enterprise'),
            type: 'MicrosoftAD',
            tags: x(hcl({ Name: rname(domain) })),
          }, [blk('vpc_settings', { vpc_id: x(`${lz}.network_ids[${q(net)}]`), subnet_ids: x(`slice(${subnets}, 0, 2)`) })]),
        );
      } else if (forwarders.length === 0) {
        findings.push(error('tf.mig.identity-no-forwarders', 'Forwarding the domain needs the domain controllers\' addresses.', { path: 'dns_forwarders' }));
      }
      blocks.push(
        res('aws_security_group', 'resolver', { name: x(`"\${${lz}.prefix}-resolver"`), description: 'Route 53 Resolver outbound endpoint', vpc_id: x(`${lz}.network_ids[${q(net)}]`) }),
        res('aws_vpc_security_group_egress_rule', 'resolver_dns_tcp', { security_group_id: x('aws_security_group.resolver.id'), cidr_ipv4: '0.0.0.0/0', ip_protocol: 'tcp', from_port: 53, to_port: 53, description: 'DNS over TCP' }),
        res('aws_vpc_security_group_egress_rule', 'resolver_dns_udp', { security_group_id: x('aws_security_group.resolver.id'), cidr_ipv4: '0.0.0.0/0', ip_protocol: 'udp', from_port: 53, to_port: 53, description: 'DNS over UDP' }),
        res('aws_vpc_security_group_egress_rule', 'resolver_dns_tcp_v6', { security_group_id: x('aws_security_group.resolver.id'), cidr_ipv6: '::/0', ip_protocol: 'tcp', from_port: 53, to_port: 53, description: 'DNS over TCP, IPv6' }),
        res('aws_vpc_security_group_egress_rule', 'resolver_dns_udp_v6', { security_group_id: x('aws_security_group.resolver.id'), cidr_ipv6: '::/0', ip_protocol: 'udp', from_port: 53, to_port: 53, description: 'DNS over UDP, IPv6' }),
        res('aws_route53_resolver_endpoint', 'outbound', {
          name: x(`"\${${lz}.prefix}-outbound"`),
          direction: 'OUTBOUND',
          resolver_endpoint_type: x(`${lz}.ipv6[${q(net)}] ? "DUALSTACK" : "IPV4"`),
          security_group_ids: x('[aws_security_group.resolver.id]'),
          protocols: ['Do53'],
        }, [
          { type: 'dynamic', labels: ['ip_address'], attributes: attrs({ for_each: x(`slice(${subnets}, 0, 2)`) }), blocks: [blk('content', { subnet_id: x('ip_address.value') })] },
        ]),
        res('aws_route53_resolver_rule', 'domain', {
          domain_name: domain,
          name: x(`"\${${lz}.prefix}-${rname(domain)}"`),
          rule_type: 'FORWARD',
          resolver_endpoint_id: x('aws_route53_resolver_endpoint.outbound.id'),
        }, managed
          ? [{ type: 'dynamic', labels: ['target_ip'], attributes: attrs({ for_each: x('aws_directory_service_directory.managed_ad.dns_ip_addresses') }), blocks: [blk('content', { ip: x('target_ip.value'), port: 53 })] }]
          : forwarders.map((f) => blk('target_ip', familyOf(f) === 6 ? { ipv6: f, port: 53 } : { ip: f, port: 53 }))),
        res('aws_route53_resolver_rule_association', 'domain', {
          for_each: x(`${lz}.network_ids`),
          resolver_rule_id: x('aws_route53_resolver_rule.domain.id'),
          vpc_id: x('each.value'),
        }),
        output('resolver_rule_id', 'aws_route53_resolver_rule.domain.id'),
        ...(managed ? [output('directory_id', 'aws_directory_service_directory.managed_ad.id'), output('directory_dns', 'aws_directory_service_directory.managed_ad.dns_ip_addresses')] : []),
      );
      return { files: { 'main.tf': mainTf(blocks, `AWS identity: ${managed ? 'Managed Microsoft AD' : 'DNS forwarding'} for ${domain}`) }, findings };
    },
  };
}

// ---------------------------------------------------------------------------
// Connectivity
// ---------------------------------------------------------------------------

function awsConnectivity()            {
  return {
    id: 'aws_mig_connectivity',
    label: 'Connectivity (migration)',
    group: MIGRATION_GROUP,
    description: 'Site-to-site VPN (BGP, two tunnels, IPv6 inside a second connection where the site has IPv6) and Direct Connect, through a transit gateway or a VPN gateway, with routes to on-premises in every private route table.',
    inputs: [
      gridInput('sites', 'Sites', SITE_COLUMNS, DEFAULT_SITES, 'One row per on-premises site. Method: vpn, circuit (Direct Connect), or circuit with a VPN backup. The circuit id is the Direct Connect connection id (dxcon-…).'),
      { id: 'cloud_asn', label: 'Amazon side ASN', control: 'number', default: 64512, min: 64512, max: 65534 },
      { id: 'gateway', label: 'Gateway', control: 'select', default: 'transit-gateway', options: [{ value: 'transit-gateway', label: 'Transit gateway (two or more VPCs)' }, { value: 'vpn-gateway', label: 'Virtual private gateway per VPC' }] },
      LANDING_ZONE_SOURCE,
    ],
    emits: ['aws_ec2_transit_gateway', 'aws_ec2_transit_gateway_vpc_attachment', 'aws_vpn_gateway', 'aws_vpn_gateway_route_propagation', 'aws_customer_gateway', 'aws_vpn_connection', 'aws_route', 'aws_dx_gateway', 'aws_dx_gateway_association', 'aws_dx_transit_virtual_interface', 'aws_dx_private_virtual_interface', 'aws_dx_bgp_peer'],
    build: (values                 ) => {
      const findings            = [];
      const lz = lzRef(values);
      const sites = parseSites(valueOf(values, 'sites'), findings);
      const asn = numberOf(values, 'cloud_asn', 64512);
      const tgw = valueOf(values, 'gateway', 'transit-gateway') !== 'vpn-gateway';
      const blocks             = [TF(), ...consumerPreamble('aws', values)];
      if (tgw) {
        blocks.push(
          res('aws_ec2_transit_gateway', 'hub', {
            description: x(`"\${${lz}.prefix} hub"`),
            amazon_side_asn: asn,
            auto_accept_shared_attachments: 'disable',
            default_route_table_association: 'enable',
            default_route_table_propagation: 'enable',
            dns_support: 'enable',
            vpn_ecmp_support: 'enable',
            tags: x(`{ Name = "\${${lz}.prefix}-hub" }`),
          }),
          res('aws_ec2_transit_gateway_vpc_attachment', 'network', {
            for_each: x(`${lz}.network_ids`),
            transit_gateway_id: x('aws_ec2_transit_gateway.hub.id'),
            vpc_id: x('each.value'),
            subnet_ids: x(`${lz}.zone_subnet_ids[each.key]`),
            ipv6_support: x(`${lz}.ipv6[each.key] ? "enable" : "disable"`),
            dns_support: 'enable',
            tags: x(`{ Name = "\${${lz}.prefix}-\${each.key}" }`),
          }),
        );
      } else {
        blocks.push(
          res('aws_vpn_gateway', 'network', { for_each: x(`${lz}.network_ids`), vpc_id: x('each.value'), amazon_side_asn: asn, tags: x(`{ Name = "\${${lz}.prefix}-\${each.key}" }`) }),
          res('aws_vpn_gateway_route_propagation', 'network', { for_each: x(`${lz}.route_table_ids`), vpn_gateway_id: x('aws_vpn_gateway.network[each.key].id'), route_table_id: x('each.value') }),
        );
      }
      const gatewayOf = tgw ? { transit_gateway_id: x('aws_ec2_transit_gateway.hub.id') } : {};
      const vpnSites = sites.filter((s) => s.vpn);
      for (const s of vpnSites) {
        const v6peer = familyOf(s.peer) === 6;
        blocks.push(res('aws_customer_gateway', s.id, { bgp_asn: String(s.asn), ip_address: s.peer, type: 'ipsec.1', tags: x(hcl({ Name: s.name })) }));
        const connections                                               = [{ label: s.id, inside: 'ipv4' }];
        if (tgw && s.cidrs.some((c) => familyOf(c) === 6)) connections.push({ label: `${s.id}_v6`, inside: 'ipv6' });
        if (!tgw && s.cidrs.some((c) => familyOf(c) === 6)) {
          findings.push(info('tf.mig.aws-vgw-ipv6', `Site ${s.name}: a virtual private gateway carries IPv4 only, so its IPv6 ranges need the transit gateway.`, { path: 'gateway' }));
        }
        for (const c of connections) {
          const psk = (n        ) => `vpn_psk_${c.label}_${n}`;
          blocks.push(secretVariable(psk(1), `Pre-shared key for tunnel 1 to ${s.name}${c.inside === 'ipv6' ? ' (IPv6 inside)' : ''}.`), secretVariable(psk(2), `Pre-shared key for tunnel 2 to ${s.name}${c.inside === 'ipv6' ? ' (IPv6 inside)' : ''}.`));
          if (tgw) {
            blocks.push(
              res('aws_vpn_connection', c.label, {
                customer_gateway_id: x(`aws_customer_gateway.${s.id}.id`),
                ...gatewayOf,
                type: 'ipsec.1',
                static_routes_only: false,
                tunnel_inside_ip_version: c.inside,
                outside_ip_address_type: v6peer ? 'PublicIpv6' : undefined,
                tunnel1_preshared_key: x(`var.${psk(1)}`),
                tunnel2_preshared_key: x(`var.${psk(2)}`),
                tunnel1_startup_action: 'start',
                tunnel2_startup_action: 'start',
                tags: x(hcl({ Name: `${s.name}${c.inside === 'ipv6' ? '-v6' : ''}` })),
              }),
            );
          } else {
            blocks.push(
              res('aws_vpn_connection', c.label, {
                for_each: x(`${lz}.network_ids`),
                customer_gateway_id: x(`aws_customer_gateway.${s.id}.id`),
                vpn_gateway_id: x('aws_vpn_gateway.network[each.key].id'),
                type: 'ipsec.1',
                static_routes_only: false,
                tunnel1_preshared_key: x(`var.${psk(1)}`),
                tunnel2_preshared_key: x(`var.${psk(2)}`),
                tunnel1_startup_action: 'start',
                tunnel2_startup_action: 'start',
                tags: x(`{ Name = "${s.name}-\${each.key}" }`),
              }),
            );
          }
        }
      }
      // Routes to on-premises through the transit gateway, in every private route table (a VPN gateway propagates its own).
      if (tgw) {
        const routes                                                = {};
        sites.forEach((s) => s.cidrs.forEach((c, i) => (routes[`${s.name}-${i}`] = { cidr: c, v6: familyOf(c) === 6 })));
        if (Object.keys(routes).length > 0) {
          blocks.push({
            type: 'locals',
            attributes: attrs({
              mig_onprem_routes: x(`merge([
    for t, table in ${lz}.route_table_ids : {
      for r in ${hcl(Object.entries(routes).map(([k, r]) => ({ key: k, cidr: r.cidr, v6: r.v6 })), 3)} :
      "\${t}/\${r.key}" => { table = table, cidr = r.cidr, v6 = r.v6 }
    }
  ]...)`),
            }),
          });
          blocks.push(
            res('aws_route', 'onprem', {
              for_each: x('local.mig_onprem_routes'),
              route_table_id: x('each.value.table'),
              destination_cidr_block: x('each.value.v6 ? null : each.value.cidr'),
              destination_ipv6_cidr_block: x('each.value.v6 ? each.value.cidr : null'),
              transit_gateway_id: x('aws_ec2_transit_gateway.hub.id'),
              depends_on: x('[aws_ec2_transit_gateway_vpc_attachment.network]'),
            }),
          );
        }
      }
      // Direct Connect.
      const circuits = sites.filter((s) => s.usesCircuit);
      if (circuits.length > 0) {
        blocks.push(
          res('aws_dx_gateway', 'hub', { name: x(`"\${${lz}.prefix}-dx"`), amazon_side_asn: String(asn + 1) }),
          tgw
            ? res('aws_dx_gateway_association', 'hub', { dx_gateway_id: x('aws_dx_gateway.hub.id'), associated_gateway_id: x('aws_ec2_transit_gateway.hub.id'), allowed_prefixes: x(`flatten(values(${lz}.network_cidrs))`) })
            : res('aws_dx_gateway_association', 'network', { for_each: x(`${lz}.network_ids`), dx_gateway_id: x('aws_dx_gateway.hub.id'), associated_gateway_id: x('aws_vpn_gateway.network[each.key].id') }),
        );
        for (const s of circuits) {
          const conn = s.circuit ? s.circuit : x(`var.dx_connection_id_${s.id}`);
          if (!s.circuit) blocks.push(variable(`dx_connection_id_${s.id}`, 'string', `Direct Connect connection id (dxcon-…) for ${s.name}, from the provider or partner.`));
          blocks.push(variable(`dx_vlan_${s.id}`, 'number', `The VLAN the Direct Connect partner or port assigns to ${s.name}.`));
          const vif = tgw ? 'aws_dx_transit_virtual_interface' : 'aws_dx_private_virtual_interface';
          blocks.push(
            res(vif, s.id, {
              name: x(`"\${${lz}.prefix}-${s.name}"`),
              connection_id: conn,
              dx_gateway_id: x('aws_dx_gateway.hub.id'),
              vlan: x(`var.dx_vlan_${s.id}`),
              address_family: 'ipv4',
              bgp_asn: s.asn,
              tags: x(hcl({ Name: s.name })),
            }),
            // The same interface also carries IPv6: a second BGP session.
            res('aws_dx_bgp_peer', `${s.id}_v6`, { virtual_interface_id: x(`${vif}.${s.id}.id`), address_family: 'ipv6', bgp_asn: s.asn }),
          );
        }
      }
      if (sites.length === 0) findings.push(warning('tf.mig.no-sites', 'The sites grid is empty, so only the gateway was built.', { path: 'sites' }));
      blocks.push(
        ...(tgw ? [output('transit_gateway_id', 'aws_ec2_transit_gateway.hub.id')] : [output('vpn_gateway_ids', '{ for k, v in aws_vpn_gateway.network : k => v.id }')]),
        ...(vpnSites.length > 0 ? [output('vpn_tunnels', `{\n    ${vpnSites.map((s) => `${s.id} = ${tgw ? `[aws_vpn_connection.${s.id}.tunnel1_address, aws_vpn_connection.${s.id}.tunnel2_address]` : `{ for k, v in aws_vpn_connection.${s.id} : k => [v.tunnel1_address, v.tunnel2_address] }`}`).join('\n    ')}\n  }`, 'The AWS tunnel endpoints to configure on each on-premises peer.')] : []),
      );
      return { files: { 'main.tf': mainTf(blocks, `AWS connectivity: ${sites.length} site(s) through a ${tgw ? 'transit gateway' : 'virtual private gateway'}`) }, findings };
    },
  };
}

// ---------------------------------------------------------------------------
// Compute
// ---------------------------------------------------------------------------

const DEFAULT_VMS                                 = [
  ['web01', 'win-2022', 'ssm:/aws/service/ami-windows-latest/Windows_Server-2022-English-Full-Base', 'm7i.large', '', 'gp3:100', 'prod', 'web', 'a', 'li', 'silver', 'rebuild', 'shop', 'web', 'prod', '1'],
  ['app01', 'rhel-9', 'ami:309956199498:RHEL-9.*_HVM-*-x86_64-*-Hourly2-GP3', 'm7i.xlarge', '', 'gp3:50 gp3:200', 'prod', 'app', 'b', 'li', 'gold', 'rebuild', 'shop', 'app', 'prod', '1'],
  ['db01', 'ol-8', 'replicated', 'r7i.2xlarge', '4', 'gp3:100 io2:500', 'prod', 'db', 'a', 'byol-image', 'gold', 'replicate', 'shop', 'oracle', 'prod', '2'],
];

/** The instance family, for a dedicated host: r7i of r7i.2xlarge. */
const familyOfSize = (size        ) => size.split('.')[0] ?? size;

function awsImageData(vms                   )                                                       {
  const blocks             = [];
  const exprFor = new Map                ();
  let n = 0;
  for (const vm of vms) {
    const img = vm.image;
    if (!img || vm.method === 'replicate') continue;
    const key = img.kind === 'custom' ? `var:${img.variable}` : vm.imageKey;
    if (exprFor.has(key)) continue;
    n += 1;
    const label = `image_${n}`;
    if (img.kind === 'aws-ssm') {
      blocks.push(dat('aws_ssm_parameter', label, { name: img.parameter }, [], vm.imageKey));
      // insecure_value: a public AMI parameter is not a secret, and a sensitive value cannot key a for_each.
      exprFor.set(key, `data.aws_ssm_parameter.${label}.insecure_value`);
    } else if (img.kind === 'aws-ami-filter') {
      blocks.push(dat('aws_ami', label, { most_recent: true, owners: [img.owner] }, [blk('filter', { name: 'name', values: [img.namePattern] }), blk('filter', { name: 'state', values: ['available'] })], vm.imageKey));
      exprFor.set(key, `data.aws_ami.${label}.id`);
    } else if (img.kind === 'custom') {
      blocks.push(variable(img.variable, 'string', `The AMI id for ${vm.name} (${vm.os}).`));
      exprFor.set(key, `var.${img.variable}`);
    } else {
      blocks.push(variable(`image_${ident(vm.name)}`, 'string', `The AMI id for ${vm.name}: "${vm.imageKey}" is not an AWS image key.`));
      exprFor.set(key, `var.image_${ident(vm.name)}`);
    }
  }
  return { blocks, exprFor };
}

const imageKeyOf = (vm        ) => (vm.image?.kind === 'custom' ? `var:${vm.image.variable}` : vm.imageKey);

function awsCompute()            {
  return {
    id: 'aws_mig_compute',
    label: 'Compute (migration)',
    group: MIGRATION_GROUP,
    description: 'An EC2 instance per rebuild row (IMDSv2, encrypted gp3/io2, Session Manager role, bootstrap without secrets), data volumes, dedicated hosts for BYOL, and the replicated rows adopted after cutover with import blocks. Writes local.mig_vms.',
    inputs: [
      gridInput('vms', 'VMs', vmColumns(SIZES, ['gp3', 'io2']), DEFAULT_VMS, 'One row per VM. Disks: type:GiB, the first is the boot disk. Method replicate: the replication tool builds it; list it in cutover_instance_ids after cutover to adopt it.'),
      { id: 'ssh_public_key_var', label: 'SSH key variable', control: 'text', default: 'ssh_public_key', hint: 'The variable holding the ansible user\'s public key.' },
      { id: 'imdsv2', label: 'Instance metadata', control: 'select', default: 'required', options: [{ value: 'required', label: 'IMDSv2 only (tokens required)' }] },
      LANDING_ZONE_SOURCE,
    ],
    emits: ['aws_instance', 'aws_ebs_volume', 'aws_volume_attachment', 'aws_ec2_host', 'aws_licensemanager_license_configuration', 'aws_licensemanager_association'],
    build: (values                 ) => {
      const findings            = [];
      const lz = lzRef(values);
      const vms = parseVms(valueOf(values, 'vms'), 'gp3', findings);
      const sshVar = ident(valueOf(values, 'ssh_public_key_var', 'ssh_public_key'));
      const { blocks: imageBlocks, exprFor } = awsImageData(vms);
      const hostKey = (vm        ) => (vm.licence === 'dedicated-host' && vm.method === 'rebuild' ? `${familyOfSize(vm.size)}-${vm.zone}` : '');
      const hosts = new Map                                               ();
      for (const vm of vms) if (hostKey(vm)) hosts.set(hostKey(vm), { family: familyOfSize(vm.size), zoneIndex: vm.zoneIndex });

      const entries                         = {};
      for (const vm of vms) {
        entries[vm.key] = vmLocalEntry(vm, {
          ami: vm.method === 'rebuild' ? (exprFor.get(imageKeyOf(vm)) ?? 'null') : 'null',
          subnet: `${lz}.subnet_ids[${q(`${vm.network}/${vm.tier}/${vm.zone}`)}]`,
          security_group: `${lz}.security_group_ids[${q(`${vm.network}/${vm.tier}`)}]`,
          cores: vm.cores ? String(vm.cores) : 'null',
          boot_type: q(vm.boot.type),
          boot_gib: String(vm.boot.gib),
          host_key: q(hostKey(vm)),
        });
      }
      const disks                          = {};
      for (const vm of vms.filter((v) => v.method === 'rebuild')) {
        vm.data.forEach((d, i) => {
          disks[`${vm.key}/${i + 1}`] = { vm: vm.key, type: d.type, gib: d.gib, device: `/dev/sd${String.fromCharCode(102 + i)}`, iops: d.type === 'io2' || d.type === 'io1' ? Math.min(64000, Math.max(100, d.gib * 50)) : null };
        });
      }
      const blocks                        = [
        TF(),
        ...consumerPreamble('aws', values),
        sshKeyVariable(sshVar),
        cutoverVariable('the EC2 instance id (i-…) it was launched as'),
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
            { name: 'mig_bootstrap_windows', value: x(winrmBootstrap(`${lz}.mgmt_cidrs`, 'powershell-tags')) },
            { name: 'mig_vm_ids', value: x('merge({ for k, v in aws_instance.vm : k => v.id }, { for k, v in aws_instance.replicated : k => v.id })') },
          ],
        },
      ];
      if (hosts.size > 0) {
        blocks.push(
          res('aws_ec2_host', 'mig', {
            for_each: x(hcl(Object.fromEntries([...hosts].map(([k, h]) => [k, { family: h.family, zone_index: h.zoneIndex }])), 1)),
            instance_family: x('each.value.family'),
            availability_zone: x(`element(${lz}.zones, each.value.zone_index)`),
            auto_placement: 'off',
            host_recovery: 'on',
            tags: x(`{ Name = "\${${lz}.prefix}-\${each.key}" }`),
          }, [], 'Dedicated hosts for BYOL Windows Server licences bought before October 2019.'),
          res('aws_licensemanager_license_configuration', 'windows_byol', {
            name: x(`"\${${lz}.prefix}-windows-byol"`),
            description: 'Windows Server BYOL on dedicated hosts, counted by physical core',
            license_counting_type: 'Core',
          }),
          res('aws_licensemanager_association', 'host', { for_each: x('aws_ec2_host.mig'), license_configuration_arn: x('aws_licensemanager_license_configuration.windows_byol.arn'), resource_arn: x('each.value.arn') }),
        );
      }
      const metadata = blk('metadata_options', { http_endpoint: 'enabled', http_tokens: 'required', http_put_response_hop_limit: 2 });
      const cpu = { type: 'dynamic', labels: ['cpu_options'], attributes: attrs({ for_each: x('each.value.cores == null ? [] : [each.value.cores]') }), blocks: [blk('content', { core_count: x('cpu_options.value'), threads_per_core: 2 })] }            ;
      blocks.push(
        res('aws_instance', 'vm', {
          for_each: x('local.mig_rebuild'),
          ami: x('each.value.ami'),
          instance_type: x('each.value.size'),
          subnet_id: x('each.value.subnet'),
          vpc_security_group_ids: x('[each.value.security_group]'),
          iam_instance_profile: x(`${lz}.instance_profile`),
          user_data: x(`each.value.kind == "windows" ? ${withHost('local.mig_bootstrap_windows', 'substr(each.key, 0, 15)')} : ${withHost('local.mig_bootstrap_linux')}`),
          ...(hosts.size > 0 ? { tenancy: x('each.value.host_key == "" ? null : "host"'), host_id: x('try(aws_ec2_host.mig[each.value.host_key].id, null)') } : {}),
          tags: x('merge(each.value.tags, { Name = each.key })'),
        }, [
          cpu,
          metadata,
          blk('root_block_device', { volume_type: x('each.value.boot_type'), volume_size: x('each.value.boot_gib'), encrypted: true, kms_key_id: x(`${lz}.kms_key_id`), delete_on_termination: true, tags: x('merge(each.value.tags, { Name = "${each.key}-boot" })') }),
          // A newer image or a changed bootstrap must not replace a running server.
          ignoreChanges(['ami', 'user_data']),
        ]),
        res('aws_ebs_volume', 'data', {
          for_each: x('local.mig_data_disks'),
          availability_zone: x('aws_instance.vm[each.value.vm].availability_zone'),
          size: x('each.value.gib'),
          type: x('each.value.type'),
          iops: x('each.value.iops'),
          encrypted: true,
          kms_key_id: x(`${lz}.kms_key_id`),
          tags: x('merge(local.mig_vms[each.value.vm].tags, { Name = each.key })'),
        }),
        res('aws_volume_attachment', 'data', {
          for_each: x('local.mig_data_disks'),
          device_name: x('each.value.device'),
          volume_id: x('aws_ebs_volume.data[each.key].id'),
          instance_id: x('aws_instance.vm[each.value.vm].id'),
        }),
        // Adopting what the replication tool launched: the empty map adopts nothing and applies cleanly.
        dat('aws_instance', 'replicated', { for_each: x('var.cutover_instance_ids'), instance_id: x('each.value') }),
        { type: 'import', comment: 'Replicated VMs, adopted after cutover (Terraform 1.7 or later).', attributes: attrs({ for_each: x('var.cutover_instance_ids'), to: x('aws_instance.replicated[each.key]'), id: x('each.value') }) },
        res('aws_instance', 'replicated', {
          for_each: x('var.cutover_instance_ids'),
          ami: x('data.aws_instance.replicated[each.key].ami'),
          instance_type: x('local.mig_replicated[each.key].size'),
          subnet_id: x('data.aws_instance.replicated[each.key].subnet_id'),
          vpc_security_group_ids: x('[local.mig_replicated[each.key].security_group]'),
          iam_instance_profile: x(`${lz}.instance_profile`),
          tags: x('merge(local.mig_replicated[each.key].tags, { Name = each.key })'),
        }, [metadata, ignoreChanges(['ami', 'user_data', 'user_data_base64', 'subnet_id', 'availability_zone', 'key_name', 'private_ip', 'root_block_device', 'ebs_block_device'])]),
        output('vms', '{ for k, v in aws_instance.vm : k => { id = v.id, private_ip = v.private_ip, ipv6 = v.ipv6_addresses, os = local.mig_vms[k].os } }', 'Each built VM: id and addresses, for the Ansible inventory.'),
        output('replicated', '{ for k, v in aws_instance.replicated : k => { id = v.id, private_ip = v.private_ip, ipv6 = v.ipv6_addresses, os = local.mig_vms[k].os } }', 'Each adopted VM.'),
      );
      for (const vm of vms) {
        if (vm.licence === 'ahb' || vm.licence === 'rhel-byos' || vm.licence === 'sles-byos') {
          findings.push(info('tf.mig.aws-licence', `${vm.name}: "${vm.licence}" has no AWS equivalent here; it is licence-included unless its image is a BYOL one.`, { path: 'vms' }));
        }
        if (vm.method === 'replicate' && vm.data.length > 0) {
          findings.push(info('tf.mig.replicated-disks', `${vm.name}: its data disks come with the replication and are not created here.`, { path: 'vms' }));
        }
      }
      return { files: { 'main.tf': mainTf(blocks, `AWS compute: ${vms.length} VM(s)`) }, findings };
    },
  };
}

// ---------------------------------------------------------------------------
// Databases
// ---------------------------------------------------------------------------

const AWS_DB_SERVICES = ['aws-rds', 'aws-aurora', 'aws-rds-custom', 'aws-ec2', 'aws-odb-exadata', 'aws-odb-adb'];
const RDS_ENGINES = ['postgres', 'mysql', 'mariadb', 'oracle-ee', 'oracle-se2', 'sqlserver-ee', 'sqlserver-se', 'sqlserver-web', 'sqlserver-ex', 'aurora-postgresql', 'aurora-mysql'];

const DEFAULT_DBS                                 = [
  ['orders', 'aws-rds', 'postgres', 'community', '16', 'db.r7i.large', '200', 'multi-az', 'li', '14', 'prod', 'shop'],
  ['erp', 'aws-rds', 'oracle-ee', 'oracle-ee', '19', 'db.r7i.xlarge', '500', 'multi-az', 'byol', '14', 'prod', 'erp'],
  ['crm', 'aws-rds', 'sqlserver-se', 'sql-standard', '16.00', 'db.r7i.xlarge', '300', 'multi-az', 'li', '7', 'prod', 'crm'],
  ['ledger', 'aws-aurora', 'aurora-postgresql', 'community', '16', 'db.r7i.large', '100', 'multi-az', 'li', '7', 'prod', 'finance'],
];

function rdsFamily(engine        , version        )                {
  const v = version.trim();
  if (!v) return null;
  const [major = '', minor = ''] = v.split('.');
  if (engine === 'postgres') return `postgres${major}`;
  if (engine === 'mysql' || engine === 'mariadb') return `${engine}${major}.${minor || '0'}`;
  if (engine.startsWith('sqlserver-')) return `${engine}-${Number(major)}.0`;
  if (engine.startsWith('oracle-')) return `${engine}-${major}`;
  return null;
}

function rdsLicence(db        , findings           )         {
  if (db.engine === 'postgres') return 'postgresql-license';
  if (db.engine === 'mysql' || db.engine === 'mariadb') return 'general-public-license';
  if (db.engine.startsWith('oracle-')) {
    const byol = /byol|oracle-|processor|nup|ula/.test(db.licence);
    if (!byol && db.engine === 'oracle-ee') {
      findings.push(warning('tf.mig.rds-oracle-ee-li', `${db.name}: RDS for Oracle Enterprise Edition is bring-your-own-licence only, so it is written as BYOL.`, { path: 'databases' }));
      return 'bring-your-own-license';
    }
    return byol ? 'bring-your-own-license' : 'license-included';
  }
  return 'license-included';
}

const LOG_EXPORTS                                    = {
  postgres: ['postgresql', 'upgrade'],
  mysql: ['error', 'slowquery'],
  mariadb: ['error', 'slowquery'],
  oracle: ['alert', 'listener'],
  sqlserver: ['error', 'agent'],
};

function awsDatabases()            {
  return {
    id: 'aws_mig_databases',
    label: 'Databases (migration)',
    group: MIGRATION_GROUP,
    description: 'RDS and Aurora per row: encrypted, Multi-AZ where the HA column asks, dual-stack where the network is, TLS enforced, deletion-protected, and the master password managed in Secrets Manager (never written).',
    inputs: [
      gridInput('databases', 'Databases', dbColumns(AWS_DB_SERVICES, RDS_ENGINES, DB_CLASSES, ['li', 'byol']), DEFAULT_DBS, 'One row per database. Engine is the RDS engine name; Version the engine version (blank: the current default).'),
      LANDING_ZONE_SOURCE,
    ],
    emits: ['aws_db_subnet_group', 'aws_db_parameter_group', 'aws_db_option_group', 'aws_db_instance', 'aws_rds_cluster', 'aws_rds_cluster_instance'],
    build: (values                 ) => {
      const findings            = [];
      const lz = lzRef(values);
      const dbs = parseDbs(valueOf(values, 'databases'), findings);
      const blocks             = [TF(), ...consumerPreamble('aws', values)];
      const nets = new Set        ();
      const managed           = [];
      for (const db of dbs) {
        if (db.service === 'aws-rds' || db.service === 'aws-aurora' || db.service === '') managed.push(db);
        else if (db.service === 'aws-ec2') findings.push(info('tf.mig.db-on-ec2', `${db.name} runs on EC2: its hosts are compute rows, and Ansible installs it.`, { path: 'databases' }));
        else if (db.service.startsWith('aws-odb')) findings.push(info('tf.mig.db-odb', `${db.name} is on Oracle Database@AWS: see the Oracle Database@AWS blueprint.`, { path: 'databases' }));
        else findings.push(warning('tf.mig.db-service', `${db.name}: ${db.service} is not generated here (RDS Custom needs a custom engine version built first); it was left out.`, { path: 'databases' }));
      }
      for (const db of managed) nets.add(db.network);
      for (const net of nets) {
        blocks.push(
          res('aws_db_subnet_group', ident(net), {
            name: x(`"\${${lz}.prefix}-${net}-db"`),
            subnet_ids: x(`[for k, id in ${lz}.subnet_ids : id if startswith(k, "${net}/db/")]`),
            tags: x(hcl({ Name: `${net}-db` })),
          }),
        );
      }
      for (const db of managed) {
        const tags = x(hcl({ Name: db.name, atk_app: db.app, atk_db: db.engine, atk_backup_days: String(db.backupDays) }));
        const net = ident(db.network);
        const ha = db.ha !== 'none';
        const common = {
          vpc_security_group_ids: x(`[${lz}.security_group_ids[${q(`${db.network}/db`)}]]`),
          db_subnet_group_name: x(`aws_db_subnet_group.${net}.name`),
          network_type: x(`${lz}.ipv6[${q(db.network)}] ? "DUAL" : "IPV4"`),
          storage_encrypted: true,
          kms_key_id: x(`${lz}.kms_key_id`),
          manage_master_user_password: true,
          master_user_secret_kms_key_id: x(`${lz}.kms_key_id`),
          backup_retention_period: Math.min(35, db.backupDays),
          copy_tags_to_snapshot: true,
          deletion_protection: true,
          skip_final_snapshot: false,
        };
        if (db.service === 'aws-aurora' || db.engine.startsWith('aurora')) {
          const engine = db.engine.startsWith('aurora') ? db.engine : 'aurora-postgresql';
          blocks.push(
            res('aws_rds_cluster', db.id, {
              cluster_identifier: x(`"\${${lz}.prefix}-${db.name}"`),
              engine,
              engine_version: db.version || undefined,
              master_username: 'dbadmin',
              ...common,
              final_snapshot_identifier: x(`"\${${lz}.prefix}-${db.name}-final"`),
              iam_database_authentication_enabled: true,
              enabled_cloudwatch_logs_exports: engine === 'aurora-postgresql' ? ['postgresql'] : ['error', 'slowquery'],
              tags,
            }),
            res('aws_rds_cluster_instance', db.id, {
              count: ha ? 2 : 1,
              identifier: x(`"\${${lz}.prefix}-${db.name}-\${count.index + 1}"`),
              cluster_identifier: x(`aws_rds_cluster.${db.id}.id`),
              instance_class: db.cls || 'db.r7i.large',
              engine: x(`aws_rds_cluster.${db.id}.engine`),
              engine_version: x(`aws_rds_cluster.${db.id}.engine_version`),
              auto_minor_version_upgrade: true,
              tags,
            }),
          );
          continue;
        }
        const engine = db.engine || 'postgres';
        const kind = engine.startsWith('oracle') ? 'oracle' : engine.startsWith('sqlserver') ? 'sqlserver' : engine;
        const family = rdsFamily(engine, db.version);
        const force                         = { postgres: 'rds.force_ssl', sqlserver: 'rds.force_ssl', mysql: 'require_secure_transport', mariadb: 'require_secure_transport' };
        const param = force[kind];
        if (family && param) {
          blocks.push(
            res('aws_db_parameter_group', db.id, { name: x(`"\${${lz}.prefix}-${db.name}"`), family }, [
              blk('parameter', { name: param, value: kind === 'mysql' || kind === 'mariadb' ? 'ON' : '1', apply_method: 'pending-reboot' }),
            ], 'TLS only.'),
          );
        }
        const major = db.version.split('.')[0] ?? '';
        const optionGroup = (kind === 'oracle' || kind === 'sqlserver') && major !== '';
        if (optionGroup) {
          blocks.push(
            res('aws_db_option_group', db.id, {
              name: x(`"\${${lz}.prefix}-${db.name}"`),
              option_group_description: `Options for ${db.name}`,
              engine_name: engine,
              major_engine_version: kind === 'sqlserver' ? `${Number(major)}.00` : major,
            }, [], kind === 'oracle' ? 'Add options here (SSL, TDE, S3_INTEGRATION) as the database needs them.' : 'Add SQLSERVER_BACKUP_RESTORE here to seed from native backups in S3.'),
          );
        }
        blocks.push(
          res('aws_db_instance', db.id, {
            identifier: x(`"\${${lz}.prefix}-${db.name}"`),
            engine,
            engine_version: db.version || undefined,
            instance_class: db.cls || 'db.r7i.large',
            allocated_storage: db.storage,
            max_allocated_storage: db.storage * 2,
            storage_type: 'gp3',
            username: 'dbadmin',
            license_model: rdsLicence(db, findings),
            multi_az: ha,
            ...common,
            final_snapshot_identifier: x(`"\${${lz}.prefix}-${db.name}-final"`),
            parameter_group_name: family && param ? x(`aws_db_parameter_group.${db.id}.name`) : undefined,
            option_group_name: optionGroup ? x(`aws_db_option_group.${db.id}.name`) : undefined,
            character_set_name: kind === 'oracle' ? 'AL32UTF8' : undefined,
            iam_database_authentication_enabled: kind === 'postgres' || kind === 'mysql' || kind === 'mariadb' ? true : undefined,
            enabled_cloudwatch_logs_exports: [...(LOG_EXPORTS[kind] ?? [])],
            publicly_accessible: false,
            auto_minor_version_upgrade: true,
            tags,
          }),
        );
        if (engine === 'sqlserver-ex' && ha) findings.push(warning('tf.mig.rds-express-ha', `${db.name}: SQL Server Express has no Multi-AZ on RDS.`, { path: 'databases' }));
      }
      if (managed.length > 0) {
        blocks.push(
          output('endpoints', `{\n    ${managed.map((d) => `${q(d.name)} = ${d.service === 'aws-aurora' || d.engine.startsWith('aurora') ? `aws_rds_cluster.${d.id}.endpoint` : `aws_db_instance.${d.id}.endpoint`}`).join('\n    ')}\n  }`),
          output('master_secrets', `{\n    ${managed.map((d) => `${q(d.name)} = ${d.service === 'aws-aurora' || d.engine.startsWith('aurora') ? `aws_rds_cluster.${d.id}.master_user_secret[0].secret_arn` : `aws_db_instance.${d.id}.master_user_secret[0].secret_arn`}`).join('\n    ')}\n  }`, 'The Secrets Manager secret holding each master password.'),
        );
      }
      return { files: { 'main.tf': mainTf(blocks, `AWS databases: ${managed.length} managed`) }, findings };
    },
  };
}

// ---------------------------------------------------------------------------
// Oracle Database@AWS
// ---------------------------------------------------------------------------

function awsOracleDatabase()            {
  return {
    id: 'aws_mig_oracle_database',
    label: 'Oracle Database@AWS (migration)',
    group: MIGRATION_GROUP,
    description: 'An ODB network peered to the landing-zone VPC, Exadata infrastructure, an Exadata VM cluster and an Autonomous VM cluster; the database homes and databases in it are created through OCI.',
    inputs: [
      ...odbInputs('aws'),
      { id: 'availability_zone_id', label: 'Availability zone id', control: 'text', default: 'use1-az4', hint: 'The zone id (not name) Oracle Database@AWS is offered in.' },
      { id: 'ssh_public_key_var', label: 'SSH key variable', control: 'text', default: 'ssh_public_key' },
    ],
    emits: ['aws_odb_network', 'aws_odb_network_peering_connection', 'aws_route', 'aws_odb_cloud_exadata_infrastructure', 'aws_odb_cloud_vm_cluster', 'aws_odb_cloud_autonomous_vm_cluster', 'oci_database_db_home', 'oci_database_database'],
    build: (values                 ) => {
      const findings            = [oracleRegionFinding('AWS', 'the region')];
      const lz = lzRef(values);
      const net = rname(valueOf(values, 'network', 'prod'));
      const cidr = valueOf(values, 'odb_network_cidr', '10.60.0.0/24');
      const [p = '24'] = cidr.split('/').slice(1);
      const halves = familyOf(cidr) === 4 ? carve(cidr, [Number(p) + 1, Number(p) + 1]) : null;
      if (!halves) {
        findings.push(error('tf.mig.odb-cidr', `"${cidr}" cannot be split into a client and a backup subnet.`, { path: 'odb_network_cidr' }));
        return failed('aws_mig_oracle_database', findings);
      }
      const pw = ident(valueOf(values, 'admin_password_var', 'odb_admin_password'));
      const ssh = ident(valueOf(values, 'ssh_public_key_var', 'ssh_public_key'));
      const create = valueOf(values, 'create_databases', 'yes') === 'yes';
      const azId = valueOf(values, 'availability_zone_id', 'use1-az4');
      const blocks             = [
        terraformBlock(create ? ['aws', 'oci'] : ['aws']),
        ...consumerPreamble('aws', values),
        sshKeyVariable(ssh),
        ...(create ? [secretVariable(pw, 'The SYS/SYSTEM password of the databases created in the VM cluster.')] : []),
        res('aws_odb_network', 'odb', {
          display_name: x(`"\${${lz}.prefix}-odb"`),
          availability_zone_id: azId,
          client_subnet_cidr: halves[0],
          backup_subnet_cidr: halves[1],
          s3_access: 'ENABLED',
          zero_etl_access: 'DISABLED',
        }),
        res('aws_odb_network_peering_connection', 'odb', {
          display_name: x(`"\${${lz}.prefix}-odb-${net}"`),
          odb_network_id: x('aws_odb_network.odb.id'),
          peer_network_id: x(`${lz}.network_ids[${q(net)}]`),
        }),
        res('aws_route', 'odb', {
          for_each: x(`{ for k, v in ${lz}.route_table_ids : k => v if k == ${q(net)} }`),
          route_table_id: x('each.value'),
          destination_cidr_block: halves[0],
          odb_network_arn: x('aws_odb_network.odb.arn'),
          depends_on: x('[aws_odb_network_peering_connection.odb]'),
        }),
        res('aws_odb_cloud_exadata_infrastructure', 'odb', {
          display_name: x(`"\${${lz}.prefix}-exadata"`),
          shape: valueOf(values, 'exadata_shape', 'Exadata.X11M'),
          availability_zone_id: azId,
          compute_count: numberOf(values, 'compute_count', 2),
          storage_count: numberOf(values, 'storage_count', 3),
        }, [blk('maintenance_window', { preference: 'NO_PREFERENCE', patching_mode: 'ROLLING', custom_action_timeout_in_mins: 15, is_custom_action_timeout_enabled: false })]),
        dat('aws_odb_db_servers', 'odb', { cloud_exadata_infrastructure_id: x('aws_odb_cloud_exadata_infrastructure.odb.id') }),
        res('aws_odb_cloud_vm_cluster', 'odb', {
          display_name: x(`"\${${lz}.prefix}-vmc"`),
          cloud_exadata_infrastructure_id: x('aws_odb_cloud_exadata_infrastructure.odb.id'),
          odb_network_id: x('aws_odb_network.odb.id'),
          cpu_core_count: numberOf(values, 'vm_cluster_cores', 16),
          data_storage_size_in_tbs: 20,
          db_servers: x('[for s in data.aws_odb_db_servers.odb.db_servers : s.id]'),
          gi_version: '23.0.0.0',
          hostname_prefix: 'odb',
          ssh_public_keys: x(`[var.${ssh}]`),
          license_model: valueOf(values, 'licence', 'BRING_YOUR_OWN_LICENSE'),
          is_local_backup_enabled: true,
        }, [blk('data_collection_options', { is_diagnostics_events_enabled: true, is_health_monitoring_enabled: true, is_incident_logs_enabled: true })]),
        res('aws_odb_cloud_autonomous_vm_cluster', 'odb', {
          display_name: x(`"\${${lz}.prefix}-avmc"`),
          cloud_exadata_infrastructure_id: x('aws_odb_cloud_exadata_infrastructure.odb.id'),
          odb_network_id: x('aws_odb_network.odb.id'),
          db_servers: x('[for s in data.aws_odb_db_servers.odb.db_servers : s.id]'),
          autonomous_data_storage_size_in_tbs: 5,
          cpu_core_count_per_node: 8,
          memory_per_oracle_compute_unit_in_gbs: 2,
          total_container_databases: 2,
          scan_listener_port_tls: 2484,
          scan_listener_port_non_tls: 1521,
          license_model: valueOf(values, 'licence', 'BRING_YOUR_OWN_LICENSE'),
        }, [blk('maintenance_window', { preference: 'NO_PREFERENCE' })]),
        ...odbOciDatabases(values, 'aws_odb_cloud_vm_cluster.odb.ocid', 'aws_odb_cloud_vm_cluster.odb'),
        output('vm_cluster_ocid', 'aws_odb_cloud_vm_cluster.odb.ocid'),
        output('odb_network_id', 'aws_odb_network.odb.id'),
      ];
      return { files: { 'main.tf': mainTf(blocks, 'Oracle Database@AWS') }, findings };
    },
  };
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

/** A cron that runs every `hours` hours, in AWS's six-field form. */
const awsCron = (hours        ) => (hours >= 24 ? 'cron(0 5 * * ? *)' : `cron(0 0/${hours} * * ? *)`);

function awsBackup()            {
  return {
    id: 'aws_mig_backup',
    label: 'Backup (migration)',
    group: MIGRATION_GROUP,
    description: 'An AWS Backup vault (locked for immutable tiers), a plan with a rule per tier, copies to a DR-region vault, and selections by the atk_backup tag every VM carries.',
    inputs: backupInputs(),
    emits: ['aws_backup_vault', 'aws_backup_vault_lock_configuration', 'aws_backup_plan', 'aws_backup_selection', 'aws_iam_role', 'aws_iam_role_policy_attachment'],
    build: (values                 ) => {
      const findings            = [];
      const lz = lzRef(values);
      const tiers = parseBackupTiers(valueOf(values, 'tiers'), findings);
      const dr = valueOf(values, 'dr_region');
      const blocks             = [TF(), ...consumerPreamble('aws', values)];
      if (dr) {
        blocks.push({ type: 'provider', labels: ['aws'], comment: 'The DR region, for the copy vault.', attributes: attrs({ alias: 'dr', region: dr }) });
      }
      blocks.push(
        res('aws_backup_vault', 'primary', { name: x(`"\${${lz}.prefix}-backup"`), kms_key_arn: x(`${lz}.kms_key_id`) }),
      );
      if (tiers.some((t) => t.immutable)) {
        const longest = Math.max(...tiers.filter((t) => t.immutable).map((t) => t.retention));
        blocks.push(
          res('aws_backup_vault_lock_configuration', 'primary', { backup_vault_name: x('aws_backup_vault.primary.name'), min_retention_days: 1, max_retention_days: Math.max(longest, 1), changeable_for_days: 3 }, [], 'Vault Lock: after the three-day grace period the lock cannot be removed, by anyone.'),
        );
      }
      if (dr) blocks.push(res('aws_backup_vault', 'dr', { provider: x('aws.dr'), name: x(`"\${${lz}.prefix}-backup-dr"`) }));
      blocks.push(
        res('aws_backup_plan', 'tiers', { name: x(`"\${${lz}.prefix}-tiers"`) }, tiers.map((t) =>
          blk('rule', { rule_name: t.tier, target_vault_name: x('aws_backup_vault.primary.name'), schedule: awsCron(t.hours), start_window: 60, completion_window: 360 }, [
            blk('lifecycle', { delete_after: t.retention }),
            ...(t.copy && dr ? [blk('copy_action', { destination_vault_arn: x('aws_backup_vault.dr.arn') }, [blk('lifecycle', { delete_after: t.retention })])] : []),
          ]),
        )),
        res('aws_iam_role', 'backup', {
          name: x(`"\${${lz}.prefix}-backup"`),
          assume_role_policy: x(jsonencode({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'backup.amazonaws.com' }, Action: 'sts:AssumeRole' }] })),
        }),
        res('aws_iam_role_policy_attachment', 'backup', { role: x('aws_iam_role.backup.name'), policy_arn: 'arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup' }),
        res('aws_iam_role_policy_attachment', 'backup_restore', { role: x('aws_iam_role.backup.name'), policy_arn: 'arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores' }),
      );
      for (const t of tiers) {
        blocks.push(
          res('aws_backup_selection', t.tier.replace(/-/g, '_'), { name: `${t.tier}`, plan_id: x('aws_backup_plan.tiers.id'), iam_role_arn: x('aws_iam_role.backup.arn'), resources: ['*'] }, [
            blk('selection_tag', { type: 'STRINGEQUALS', key: 'atk_backup', value: t.tier }),
          ]),
        );
        if (t.copy && !dr) findings.push(info('tf.mig.backup-no-dr', `Tier ${t.tier} asks for a DR copy but no DR region is set.`, { path: 'dr_region' }));
      }
      blocks.push(output('vault_arn', 'aws_backup_vault.primary.arn'), output('plan_id', 'aws_backup_plan.tiers.id'));
      return { files: { 'main.tf': mainTf(blocks, `AWS backup: ${tiers.length} tier(s)`) }, findings };
    },
  };
}

// ---------------------------------------------------------------------------
// Monitoring
// ---------------------------------------------------------------------------

function awsMonitoring()            {
  return {
    id: 'aws_mig_monitoring',
    label: 'Monitoring (migration)',
    group: MIGRATION_GROUP,
    description: 'The CloudWatch agent on every VM through Systems Manager (installed, then configured from a parameter), and the log groups it writes to.',
    inputs: [...monitoringInputs(), LANDING_ZONE_SOURCE],
    emits: ['aws_ssm_parameter', 'aws_ssm_association', 'aws_cloudwatch_log_group'],
    build: (values                 ) => {
      const findings            = [];
      const lz = lzRef(values);
      const prefix = '${' + lz + '.prefix}';
      const retention = Number(valueOf(values, 'retention_days', '90')) || 90;
      const siem = valueOf(values, 'siem', 'none');
      const config = {
        agent: { metrics_collection_interval: 60 },
        metrics: {
          append_dimensions: { InstanceId: '${aws:InstanceId}' },
          metrics_collected: { mem: { measurement: ['mem_used_percent'] }, disk: { measurement: ['used_percent'], resources: ['*'] } },
        },
        logs: {
          logs_collected: {
            files: { collect_list: [{ file_path: '/var/log/messages', log_group_name: `/${prefix}/linux/messages` }, { file_path: '/var/log/secure', log_group_name: `/${prefix}/linux/secure` }] },
            windows_events: { collect_list: [{ event_name: 'System', event_levels: ['ERROR', 'WARNING'], log_group_name: `/${prefix}/windows/system` }, { event_name: 'Security', event_levels: ['INFORMATION', 'ERROR', 'WARNING', 'CRITICAL'], log_group_name: `/${prefix}/windows/security` }] },
          },
        },
      };
      const blocks             = [
        TF(),
        ...consumerPreamble('aws', values),
        ...['linux/messages', 'linux/secure', 'windows/system', 'windows/security'].map((g) =>
          res('aws_cloudwatch_log_group', ident(g), { name: x(`"/${prefix}/${g}"`), retention_in_days: retention }),
        ),
        res('aws_ssm_parameter', 'cloudwatch_agent', { name: x(`"/${prefix}/cloudwatch-agent/config"`), type: 'String', tier: 'Standard', value: x(jsonencode(config)) }),
        res('aws_ssm_association', 'install_agent', {
          name: 'AWS-ConfigureAWSPackage',
          association_name: x(`"${prefix}-install-cloudwatch-agent"`),
          parameters: x(hcl({ action: 'Install', name: 'AmazonCloudWatchAgent' })),
          schedule_expression: 'rate(7 days)',
        }, [blk('targets', { key: 'tag-key', values: ['atk_os'] })]),
        res('aws_ssm_association', 'configure_agent', {
          name: 'AmazonCloudWatch-ManageAgent',
          association_name: x(`"${prefix}-configure-cloudwatch-agent"`),
          parameters: x(hcl({ action: 'configure', mode: 'ec2', optionalConfigurationSource: 'ssm', optionalConfigurationLocation: e('aws_ssm_parameter.cloudwatch_agent.name'), optionalRestart: 'yes' })),
          schedule_expression: 'rate(7 days)',
          depends_on: x('[aws_ssm_association.install_agent]'),
        }, [blk('targets', { key: 'tag-key', values: ['atk_os'] })]),
        output('log_groups', '[for g in [aws_cloudwatch_log_group.linux_messages, aws_cloudwatch_log_group.linux_secure, aws_cloudwatch_log_group.windows_system, aws_cloudwatch_log_group.windows_security] : g.name]'),
      ];
      if (siem !== 'none') findings.push(info('tf.mig.siem', `Forwarding to ${siem} is configured in the SIEM, which subscribes to these log groups and CloudTrail; nothing is written here for it.`, { path: 'siem' }));
      return { files: { 'main.tf': mainTf(blocks, 'AWS monitoring: the CloudWatch agent through Systems Manager') }, findings };
    },
  };
}

export const MIGRATION_TERRAFORM_AWS                       = [
  awsLandingZone(),
  awsIdentity(),
  awsConnectivity(),
  awsCompute(),
  awsDatabases(),
  awsOracleDatabase(),
  awsBackup(),
  awsMonitoring(),
];

/** Exposed for the tests: the SSH variable and the landing-zone switch every compute blueprint shares. */
export const AWS_DEFAULTS = { region: REGION, lzSource };
