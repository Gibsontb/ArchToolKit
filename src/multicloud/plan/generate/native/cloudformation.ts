/**
 * AWS CloudFormation from a decided, designed plan: the same design model the
 * Terraform stacks are built from (./../terraform.ts), written as a template
 * AWS ingests natively, deployable from the console or with
 * `aws cloudformation deploy`.
 *
 *   aws-cloudformation/<stack>.yaml             the template
 *   aws-cloudformation/<stack>.parameters.json  its parameter values (CLI v2
 *                                               `--parameter-overrides file://`)
 *   aws-cloudformation/<stack>-dr-vault.yaml    the DR-region backup vault, when
 *                                               a tier copies to a DR region
 *   aws-cloudformation/README.md                what is in it and how to deploy
 *
 * What it builds, from the design: the dual-stack VPCs, subnets, route tables
 * and a security group per tier; the landing zone's KMS key, log bucket,
 * CloudTrail, flow logs, Session Manager endpoints and instance role; DNS
 * forwarding (or AWS Managed Microsoft AD); site-to-site VPN and Direct
 * Connect; an EC2 instance per rebuilt VM (sized, encrypted, IMDSv2, the
 * bootstrap without secrets); RDS and Aurora; AWS Backup by tier; the
 * CloudWatch agent through Systems Manager; each app's alarms; and the app
 * items that have a clean CloudFormation equivalent (Lambda, an HTTP API in
 * front of it, a static site, a bucket, a load balancer).
 *
 * Nothing is written for a part without a clean equivalent: it is a finding
 * ("in Terraform only: …") and a line in the README. Credentials are never in
 * the files: RDS keeps its master password in Secrets Manager, VPN pre-shared
 * keys are generated into Secrets Manager by the VPN service, and the Managed
 * AD password is generated into a secret and read by a dynamic reference.
 */

import { info, warning, type Finding } from '../../../../core/findings.ts';
import { renderYaml, type YamlValue } from '../../../../ansible/yaml.ts';
import { isIaasService } from '../../design/index.ts';
import { noNetworkFinding } from '../../design/network.ts';
import { builtIn, hubOf } from '../../design/net-rows.ts';
import { DB_SERVICES_EXTRA } from '../../db-catalog-extra.ts';
import { slugName } from '../../options.ts';
import type { Database, DbTarget, NetworkDesign, Plan, PlanDecision, TargetDesign } from '../../types.ts';
import { classCell, type AppComponentLike } from '../terraform.ts';
import {
  AD_PORTS, DB_PORTS, THRESHOLDS, cloudInitLines, dbEnv, dbNetwork, isV6, kebab, mgmtCidrs, nativeContext, osKindOf, pascal, planTag, retentionOf,
  siteSources, terraformOnly, terraformOnlySection, vmName, vmTags, winrmLines, workloadOf, zoneIndexOf,
  type AppHere, type NativeCtx, type NativeFiles, type NativeOptions,
} from './common.ts';

export type { NativeFiles, NativeOptions } from './common.ts';

// ---------------------------------------------------------------------------
// Intrinsics
// ---------------------------------------------------------------------------

type V = YamlValue;
type Obj = { [key: string]: V | undefined };

const Ref = (id: string): Obj => ({ Ref: id });
const GetAtt = (id: string, attr: string): Obj => ({ 'Fn::GetAtt': [id, attr] });
const Sub = (text: string): Obj => ({ 'Fn::Sub': text });
const Select = (i: number, list: V): Obj => ({ 'Fn::Select': [i, list] });
const Base64 = (v: V): Obj => ({ 'Fn::Base64': v });
const AZ = (i: number): Obj => Select(i, { 'Fn::GetAZs': '' });

// ---------------------------------------------------------------------------
// The template being built
// ---------------------------------------------------------------------------

/** How a resource type carries tags (checked against the CloudFormation registry schemas by the tests). */
const TAG_KEY: Readonly<Record<string, 'list' | 'map' | 'BackupVaultTags' | 'BackupPlanTags' | 'launch-template'>> = {
  'AWS::EC2::VPC': 'list', 'AWS::EC2::EgressOnlyInternetGateway': 'list', 'AWS::EC2::Subnet': 'list', 'AWS::EC2::RouteTable': 'list',
  'AWS::EC2::SecurityGroup': 'list', 'AWS::EC2::VPCEndpoint': 'list', 'AWS::EC2::FlowLog': 'list', 'AWS::KMS::Key': 'list',
  'AWS::S3::Bucket': 'list', 'AWS::CloudTrail::Trail': 'list', 'AWS::IAM::Role': 'list', 'AWS::EC2::LaunchTemplate': 'launch-template',
  'AWS::EC2::Instance': 'list', 'AWS::EC2::Volume': 'list', 'AWS::EC2::Host': 'list', 'AWS::RDS::DBSubnetGroup': 'list',
  'AWS::RDS::DBParameterGroup': 'list', 'AWS::RDS::OptionGroup': 'list', 'AWS::RDS::DBInstance': 'list', 'AWS::RDS::DBCluster': 'list',
  'AWS::SecretsManager::Secret': 'list', 'AWS::Route53Resolver::ResolverEndpoint': 'list', 'AWS::Route53Resolver::ResolverRule': 'list',
  'AWS::EC2::CustomerGateway': 'list', 'AWS::EC2::VPNGateway': 'list', 'AWS::EC2::VPNConnection': 'list', 'AWS::EC2::TransitGateway': 'list',
  'AWS::EC2::TransitGatewayVpcAttachment': 'list', 'AWS::DirectConnect::DirectConnectGateway': 'list', 'AWS::DirectConnect::PrivateVirtualInterface': 'list',
  'AWS::DirectConnect::TransitVirtualInterface': 'list', 'AWS::Backup::BackupVault': 'BackupVaultTags', 'AWS::Backup::BackupPlan': 'BackupPlanTags',
  'AWS::Logs::LogGroup': 'list', 'AWS::SSM::Parameter': 'map', 'AWS::SSM::Association': 'list', 'AWS::SNS::Topic': 'list',
  'AWS::CloudWatch::Alarm': 'list', 'AWS::CloudWatch::Dashboard': 'list', 'AWS::Lambda::Function': 'list', 'AWS::ApiGatewayV2::Api': 'map',
  'AWS::CloudFront::Distribution': 'list', 'AWS::ElasticLoadBalancingV2::LoadBalancer': 'list', 'AWS::ElasticLoadBalancingV2::TargetGroup': 'list',
  'AWS::ElasticLoadBalancingV2::Listener': 'list', 'AWS::WAFv2::WebACL': 'list',
};

/** Resource types that take tags: exposed for the tests. */
export const CFN_TAGGED_TYPES: readonly string[] = Object.keys(TAG_KEY);

type Tags = Readonly<Record<string, V>>;

interface CfnResource {
  Type: string;
  Condition?: string;
  DependsOn?: string[];
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
  Properties: Obj;
}

class Template {
  readonly parameters: Record<string, Obj> = {};
  readonly groups: { label: string; params: string[] }[] = [];
  readonly conditions: Record<string, V> = {};
  readonly resources: Record<string, CfnResource> = {};
  readonly outputs: Record<string, Obj> = {};

  param(id: string, spec: Obj, group: string): string {
    if (!this.parameters[id]) {
      this.parameters[id] = spec;
      let g = this.groups.find((x) => x.label === group);
      if (!g) {
        g = { label: group, params: [] };
        this.groups.push(g);
      }
      g.params.push(id);
    }
    return id;
  }

  add(id: string, type: string, props: Obj, tags?: Tags, extra: Partial<Omit<CfnResource, 'Type' | 'Properties'>> = {}): string {
    if (this.resources[id]) throw new Error(`CloudFormation logical id ${id} is used twice`);
    const p: Obj = { ...props };
    const style = TAG_KEY[type];
    if (tags && style) {
      const list = Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));
      if (style === 'list') p.Tags = list;
      else if (style === 'map') p.Tags = { ...tags };
      else if (style === 'launch-template') p.TagSpecifications = [{ ResourceType: 'launch-template', Tags: list }];
      else p[style] = { ...tags };
    }
    this.resources[id] = { Type: type, ...extra, Properties: p };
    return id;
  }

  has(id: string): boolean {
    return !!this.resources[id];
  }

  output(id: string, value: V, description: string, exportAs?: string): void {
    this.outputs[id] = { Description: description, Value: value, ...(exportAs ? { Export: { Name: Sub(`\${AWS::StackName}-${exportAs}`) } } : {}) };
  }
}

// ---------------------------------------------------------------------------
// The builder of one AWS design
// ---------------------------------------------------------------------------

interface NetIds {
  readonly net: NetworkDesign;
  readonly vpc: string;
  readonly v6?: string;
  readonly routeTable: string;
  /** purpose → subnet logical ids, in the user's row order. */
  readonly subnets: Map<string, string[]>;
  /** subnet logical id → its Availability Zone. */
  readonly zoneOf: Map<string, string>;
  /** tier → security group logical id. */
  readonly sgs: Map<string, string>;
}

interface Build {
  readonly ctx: NativeCtx;
  readonly t: Template;
  readonly prefix: string;
  readonly cmk: boolean;
  readonly nets: Map<string, NetIds>;
  /** Base tags: plan, app, env, owner. */
  readonly tags: (app?: string, env?: string, owner?: string, extra?: Tags) => Tags;
  readonly instances: Map<string, string>;
  readonly dbInstances: Map<string, string>;
  readonly functions: Map<string, string>;
}

const OWNER = 'Owner';

function makeBuild(ctx: NativeCtx, t: Template): Build {
  const envsOf = [...new Set(ctx.pd.networks.flatMap((n) => n.envs))].join(' ') || 'shared';
  return {
    ctx,
    t,
    prefix: ctx.pd.prefix,
    cmk: ctx.plan.requirements.keys !== 'provider-managed',
    nets: new Map(),
    tags: (app, env, owner, extra = {}) => ({
      atk_plan: planTag(ctx.plan),
      atk_app: app ?? 'landing-zone',
      atk_env: env ?? envsOf,
      atk_owner: owner ? owner : Ref(OWNER),
      ...extra,
    }),
    instances: new Map(),
    dbInstances: new Map(),
    functions: new Map(),
  };
}

const keyArn = (b: Build): V | undefined => (b.cmk ? GetAtt('LandingZoneKey', 'Arn') : undefined);
const nameTag = (name: string): Tags => ({ Name: name });

// ---------------------------------------------------------------------------
// Landing zone: networks, security groups, endpoints
// ---------------------------------------------------------------------------

interface Rule {
  readonly desc: string;
  readonly proto: string;
  readonly from?: number;
  readonly to?: number;
  /** A CIDR, or the VPC's own IPv6 block. */
  readonly cidr?: string | 'vpc-v6';
  /** A security group of the same network, by tier (`self` for its own). */
  readonly sg?: string;
}

function tierRules(plan: Plan, n: NetworkDesign, tier: string): Rule[] {
  const rules: Rule[] = [];
  const has = (x: string): boolean => (n.tiers as readonly string[]).includes(x);
  const sites = siteSources(plan, n);
  const site = (port: number): void => sites.forEach((c) => rules.push({ desc: `TCP ${port} from ${c}`, proto: 'tcp', from: port, to: port, cidr: c }));
  site(22);
  site(5986);
  if (tier === 'mgmt') site(3389);
  if (tier === 'web') {
    site(443);
    rules.push({ desc: 'HTTPS from inside the VPC (load balancers)', proto: 'tcp', from: 443, to: 443, cidr: n.cidr });
    if (n.ipv6) rules.push({ desc: 'HTTPS from inside the VPC, IPv6', proto: 'tcp', from: 443, to: 443, cidr: 'vpc-v6' });
  }
  if (tier === 'app' && has('web')) rules.push({ desc: 'All TCP from the web tier', proto: 'tcp', from: 0, to: 65535, sg: 'web' });
  if (tier === 'db') {
    for (const port of DB_PORTS) {
      if (has('app')) rules.push({ desc: `TCP ${port} from the app tier`, proto: 'tcp', from: port, to: port, sg: 'app' });
      if (has('mgmt')) rules.push({ desc: `TCP ${port} from the mgmt tier`, proto: 'tcp', from: port, to: port, sg: 'mgmt' });
    }
    rules.push({ desc: 'Everything between database hosts', proto: '-1', sg: 'db' });
  }
  if (tier !== 'mgmt' && has('mgmt')) {
    for (const port of [22, 3389, 5986]) rules.push({ desc: `TCP ${port} from the mgmt tier`, proto: 'tcp', from: port, to: port, sg: 'mgmt' });
  }
  if (tier === 'mgmt') {
    const sources: (string | 'vpc-v6')[] = [n.cidr, ...(n.ipv6 ? ['vpc-v6' as const] : []), ...sites];
    for (const s of sources) {
      for (const [proto, from, to] of AD_PORTS) rules.push({ desc: `AD ${proto.toUpperCase()} ${from === to ? from : `${from}-${to}`}`, proto, from, to, cidr: s });
    }
  }
  rules.push({ desc: 'ICMP from inside the VPC', proto: 'icmp', from: -1, to: -1, cidr: n.cidr });
  if (n.ipv6) rules.push({ desc: 'ICMPv6 from inside the VPC', proto: 'icmpv6', from: -1, to: -1, cidr: 'vpc-v6' });
  for (const c of sites) rules.push({ desc: `ICMP from ${c}`, proto: isV6(c) ? 'icmpv6' : 'icmp', from: -1, to: -1, cidr: c });
  return rules;
}

function network(b: Build, n: NetworkDesign): NetIds {
  const { t, prefix } = b;
  const N = pascal(n.name);
  const netTags = b.tags(undefined, n.envs.join(' '));
  const vpc = t.add(`Vpc${N}`, 'AWS::EC2::VPC', { CidrBlock: n.cidr, EnableDnsSupport: true, EnableDnsHostnames: true }, { ...netTags, ...nameTag(`${prefix}-${n.name}`), atk_network: n.name });
  let v6: string | undefined;
  if (n.ipv6) {
    v6 = t.add(`Vpc${N}Ipv6`, 'AWS::EC2::VPCCidrBlock', { VpcId: Ref(vpc), AmazonProvidedIpv6CidrBlock: true });
    t.add(`Vpc${N}EgressOnlyGateway`, 'AWS::EC2::EgressOnlyInternetGateway', { VpcId: Ref(vpc) }, { ...netTags, ...nameTag(`${prefix}-${n.name}-eigw`) });
  }
  const vpcV6 = Select(0, GetAtt(vpc, 'Ipv6CidrBlocks'));
  const routeTable = t.add(`RouteTable${N}Private`, 'AWS::EC2::RouteTable', { VpcId: Ref(vpc) }, { ...netTags, ...nameTag(`${prefix}-${n.name}-private`) });
  if (v6) {
    t.add(`Route${N}Ipv6Default`, 'AWS::EC2::Route', { RouteTableId: Ref(routeTable), DestinationIpv6CidrBlock: '::/0', EgressOnlyInternetGatewayId: Ref(`Vpc${N}EgressOnlyGateway`) });
  }
  // Exactly the user's subnets, each in its own Availability Zone; nothing is carved or added.
  const subnets = new Map<string, string[]>();
  const zoneOf = new Map<string, string>();
  const publicOnes = n.subnets.filter((s) => s.tier === 'public');
  let publicRoutes: string | undefined;
  if (publicOnes.length > 0) {
    const igw = t.add(`Vpc${N}InternetGateway`, 'AWS::EC2::InternetGateway', {}, { ...netTags, ...nameTag(`${prefix}-${n.name}-igw`) });
    t.add(`Vpc${N}InternetGatewayAttachment`, 'AWS::EC2::VPCGatewayAttachment', { VpcId: Ref(vpc), InternetGatewayId: Ref(igw) });
    publicRoutes = t.add(`RouteTable${N}Public`, 'AWS::EC2::RouteTable', { VpcId: Ref(vpc) }, { ...netTags, ...nameTag(`${prefix}-${n.name}-public`) });
    t.add(`Route${N}PublicDefault`, 'AWS::EC2::Route', { RouteTableId: Ref(publicRoutes), DestinationCidrBlock: '0.0.0.0/0', GatewayId: Ref(igw) }, undefined, { DependsOn: [`Vpc${N}InternetGatewayAttachment`] });
  }
  n.subnets.forEach((s, i) => {
    const id = `Subnet${N}${pascal(s.name)}`;
    t.add(id, 'AWS::EC2::Subnet', {
      VpcId: Ref(vpc),
      CidrBlock: s.cidr,
      AvailabilityZone: s.zone,
      ...(v6 && s.ipv6 ? { Ipv6CidrBlock: Select(i, { 'Fn::Cidr': [vpcV6, Math.max(n.subnets.length, 1), '64'] }), AssignIpv6AddressOnCreation: true } : {}),
      ...(s.tier === 'public' ? { MapPublicIpOnLaunch: true } : {}),
    }, { ...netTags, ...nameTag(`${prefix}-${n.name}-${s.name}`), atk_network: n.name, atk_tier: s.tier }, v6 && s.ipv6 ? { DependsOn: [v6] } : {});
    t.add(`${id}Routes`, 'AWS::EC2::SubnetRouteTableAssociation', { SubnetId: Ref(id), RouteTableId: Ref(s.tier === 'public' && publicRoutes ? publicRoutes : routeTable) });
    subnets.set(s.tier, [...(subnets.get(s.tier) ?? []), id]);
    zoneOf.set(id, s.zone);
  });

  // A security group per tier; rules between groups are resources of their own (a group may name itself).
  const sgs = new Map<string, string>();
  for (const tier of n.tiers) sgs.set(tier, `Sg${N}${pascal(tier)}`);
  for (const tier of n.tiers) {
    const id = sgs.get(tier) as string;
    const rules = tierRules(b.ctx.plan, n, tier);
    const inline = rules.filter((r) => !r.sg).map((r) => ({
      IpProtocol: r.proto,
      ...(r.proto === '-1' ? {} : { FromPort: r.from, ToPort: r.to }),
      ...(r.cidr === 'vpc-v6' ? { CidrIpv6: vpcV6 } : r.cidr && isV6(r.cidr) ? { CidrIpv6: r.cidr } : { CidrIp: r.cidr }),
      Description: r.desc,
    }));
    const v4 = inline.filter((r) => 'CidrIp' in r).length;
    const v6count = inline.length - v4;
    if (v4 > 60 || v6count > 60) {
      b.ctx.findings.push(warning('plan.native.aws-sg-rules', `${prefix}-${n.name}-${tier}: ${Math.max(v4, v6count)} inbound rules of one family, more than the default quota of 60 per security group; raise "Inbound or outbound rules per security group" in Service Quotas before deploying.`, {
        source: 'https://docs.aws.amazon.com/vpc/latest/userguide/amazon-vpc-limits.html#vpc-limits-security-groups',
      }));
    }
    t.add(id, 'AWS::EC2::SecurityGroup', {
      GroupName: `${prefix}-${n.name}-${tier}`,
      GroupDescription: `The ${tier} tier of ${n.name}`,
      VpcId: Ref(vpc),
      SecurityGroupIngress: inline,
      SecurityGroupEgress: [
        { IpProtocol: '-1', CidrIp: '0.0.0.0/0', Description: 'All outbound' },
        ...(v6 ? [{ IpProtocol: '-1', CidrIpv6: '::/0', Description: 'All outbound, IPv6' }] : []),
      ],
    }, { ...netTags, ...nameTag(`${prefix}-${n.name}-${tier}`), atk_tier: tier }, v6 ? { DependsOn: [v6] } : {});
    rules.filter((r) => r.sg).forEach((r) => {
      const src = sgs.get(r.sg as string);
      if (!src) return;
      const rid = `${id}From${pascal(r.sg as string)}${r.proto === '-1' ? 'All' : `${pascal(r.proto)}${r.from}`}`;
      t.add(rid, 'AWS::EC2::SecurityGroupIngress', {
        GroupId: GetAtt(id, 'GroupId'),
        SourceSecurityGroupId: GetAtt(src, 'GroupId'),
        IpProtocol: r.proto,
        ...(r.proto === '-1' ? {} : { FromPort: r.from, ToPort: r.to }),
        Description: r.desc,
      });
    });
  }

  // Session Manager and the CloudWatch agent without a NAT gateway: interface endpoints, and S3 for packages.
  t.add(`Vpc${N}S3Endpoint`, 'AWS::EC2::VPCEndpoint', {
    VpcId: Ref(vpc), ServiceName: Sub('com.amazonaws.${AWS::Region}.s3'), VpcEndpointType: 'Gateway', RouteTableIds: [Ref(routeTable)],
  }, { ...netTags, ...nameTag(`${prefix}-${n.name}-s3`) });
  const endpointSg = t.add(`Sg${N}Endpoints`, 'AWS::EC2::SecurityGroup', {
    GroupName: `${prefix}-${n.name}-endpoints`,
    GroupDescription: `Interface endpoints in ${n.name}`,
    VpcId: Ref(vpc),
    SecurityGroupIngress: [
      { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: n.cidr, Description: 'HTTPS from the VPC' },
      ...(v6 ? [{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIpv6: vpcV6, Description: 'HTTPS from the VPC, IPv6' }] : []),
    ],
  }, { ...netTags, ...nameTag(`${prefix}-${n.name}-endpoints`) }, v6 ? { DependsOn: [v6] } : {});
  const endpointSubnets = onePerZone(subnets, zoneOf, 'endpoints');
  for (const svc of ['ssm', 'ssmmessages', 'ec2messages', 'logs', 'monitoring']) {
    t.add(`Vpc${N}${pascal(svc)}Endpoint`, 'AWS::EC2::VPCEndpoint', {
      VpcId: Ref(vpc),
      ServiceName: Sub(`com.amazonaws.\${AWS::Region}.${svc}`),
      VpcEndpointType: 'Interface',
      PrivateDnsEnabled: true,
      // IPv4: not every one of these services offers a dual-stack endpoint in every region.
      IpAddressType: 'ipv4',
      DnsOptions: { DnsRecordIpType: 'ipv4' },
      SubnetIds: endpointSubnets.map(Ref),
      SecurityGroupIds: [Ref(endpointSg)],
    }, { ...netTags, ...nameTag(`${prefix}-${n.name}-${svc}`) });
  }
  t.add(`Vpc${N}FlowLog`, 'AWS::EC2::FlowLog', {
    ResourceId: Ref(vpc), ResourceType: 'VPC', TrafficType: 'ALL', LogDestinationType: 's3', LogDestination: GetAtt('LogBucket', 'Arn'), MaxAggregationInterval: 600,
  }, { ...netTags, ...nameTag(`${prefix}-${n.name}-flow-log`) }, { DependsOn: ['LogBucketPolicy'] });
  const ids: NetIds = { net: n, vpc, ...(v6 ? { v6 } : {}), routeTable, subnets, zoneOf, sgs };
  b.nets.set(n.name, ids);
  return ids;
}

/** One subnet per Availability Zone: the `prefer` purpose's where there are some, else the workload tiers', first of each zone. */
function onePerZone(subnets: ReadonlyMap<string, readonly string[]>, zoneOf: ReadonlyMap<string, string>, prefer: string): string[] {
  const tiers = ['web', 'app', 'db', 'mgmt'];
  const pool = subnets.get(prefer)?.length ? [...subnets.get(prefer)!] : tiers.flatMap((t) => subnets.get(t) ?? []);
  const list = pool.length > 0 ? pool : [...subnets.values()].flat();
  const seen = new Set<string>();
  return list.filter((id) => {
    const z = zoneOf.get(id) ?? '';
    if (seen.has(z)) return false;
    seen.add(z);
    return true;
  });
}

function keysAndLogs(b: Build): void {
  const { t, prefix, ctx } = b;
  const tags = b.tags();
  if (b.cmk) {
    t.add('LandingZoneKey', 'AWS::KMS::Key', {
      Description: `${prefix} landing zone`,
      Enabled: true,
      EnableKeyRotation: true,
      PendingWindowInDays: 30,
      KeyPolicy: {
        Version: '2012-10-17',
        Statement: [
          { Sid: 'Account', Effect: 'Allow', Principal: { AWS: Sub('arn:${AWS::Partition}:iam::${AWS::AccountId}:root') }, Action: 'kms:*', Resource: '*' },
          { Sid: 'CloudTrail', Effect: 'Allow', Principal: { Service: 'cloudtrail.amazonaws.com' }, Action: ['kms:GenerateDataKey*', 'kms:DescribeKey'], Resource: '*' },
          { Sid: 'LogDelivery', Effect: 'Allow', Principal: { Service: 'delivery.logs.amazonaws.com' }, Action: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey'], Resource: '*' },
          { Sid: 'CloudWatchLogs', Effect: 'Allow', Principal: { Service: Sub('logs.${AWS::Region}.amazonaws.com') }, Action: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'], Resource: '*' },
          // EC2 Auto Recovery, AWS Backup and RDS use the key through the account's grants.
        ],
      },
    }, { ...tags, ...nameTag(`${prefix}-landing-zone`) }, { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
    t.add('LandingZoneKeyAlias', 'AWS::KMS::Alias', { AliasName: `alias/${prefix}-landing-zone`, TargetKeyId: Ref('LandingZoneKey') });
    if (ctx.plan.requirements.keys === 'hsm') {
      terraformOnly(ctx, 'HSM-backed landing-zone key', 'AWS::KMS::Key cannot create a key in a CloudHSM custom key store, so this template creates a customer-managed KMS key; the Terraform landing zone creates it in the key store.');
    }
  }
  const retention = ctx.pd.logRetentionDays;
  t.add('LogBucket', 'AWS::S3::Bucket', {
    BucketName: Sub(`${prefix}-logs-\${AWS::AccountId}-\${AWS::Region}`),
    VersioningConfiguration: { Status: 'Enabled' },
    BucketEncryption: {
      ServerSideEncryptionConfiguration: [
        b.cmk
          ? { BucketKeyEnabled: true, ServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: GetAtt('LandingZoneKey', 'Arn') } }
          : { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
      ],
    },
    PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
    LifecycleConfiguration: { Rules: [{ Id: 'retention', Status: 'Enabled', ExpirationInDays: retention, NoncurrentVersionExpiration: { NoncurrentDays: 30 } }] },
  }, { ...tags, ...nameTag(`${prefix}-logs`) }, { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
  const arn = GetAtt('LogBucket', 'Arn');
  const objects = Sub('${LogBucket.Arn}/AWSLogs/${AWS::AccountId}/*');
  t.add('LogBucketPolicy', 'AWS::S3::BucketPolicy', {
    Bucket: Ref('LogBucket'),
    PolicyDocument: {
      Version: '2012-10-17',
      Statement: [
        { Sid: 'DenyInsecureTransport', Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: [arn, Sub('${LogBucket.Arn}/*')], Condition: { Bool: { 'aws:SecureTransport': 'false' } } },
        { Sid: 'CloudTrailAcl', Effect: 'Allow', Principal: { Service: 'cloudtrail.amazonaws.com' }, Action: 's3:GetBucketAcl', Resource: arn },
        { Sid: 'CloudTrailWrite', Effect: 'Allow', Principal: { Service: 'cloudtrail.amazonaws.com' }, Action: 's3:PutObject', Resource: objects, Condition: { StringEquals: { 's3:x-amz-acl': 'bucket-owner-full-control' } } },
        { Sid: 'FlowLogsAcl', Effect: 'Allow', Principal: { Service: 'delivery.logs.amazonaws.com' }, Action: 's3:GetBucketAcl', Resource: arn },
        { Sid: 'FlowLogsWrite', Effect: 'Allow', Principal: { Service: 'delivery.logs.amazonaws.com' }, Action: 's3:PutObject', Resource: objects, Condition: { StringEquals: { 's3:x-amz-acl': 'bucket-owner-full-control' } } },
      ],
    },
  });
  t.add('Trail', 'AWS::CloudTrail::Trail', {
    TrailName: `${prefix}-trail`,
    S3BucketName: Ref('LogBucket'),
    IsLogging: true,
    IsMultiRegionTrail: true,
    IncludeGlobalServiceEvents: true,
    EnableLogFileValidation: true,
    ...(b.cmk ? { KMSKeyId: GetAtt('LandingZoneKey', 'Arn') } : {}),
  }, { ...tags, ...nameTag(`${prefix}-trail`) }, { DependsOn: ['LogBucketPolicy'] });
  // The role every VM gets: Session Manager and the CloudWatch agent.
  t.add('InstanceRole', 'AWS::IAM::Role', {
    Description: `${prefix}: the role of every VM (Session Manager, CloudWatch agent)`,
    AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }] },
    ManagedPolicyArns: [
      Sub('arn:${AWS::Partition}:iam::aws:policy/AmazonSSMManagedInstanceCore'),
      Sub('arn:${AWS::Partition}:iam::aws:policy/CloudWatchAgentServerPolicy'),
    ],
  }, { ...tags, ...nameTag(`${prefix}-instance`) });
  t.add('InstanceProfile', 'AWS::IAM::InstanceProfile', { Roles: [Ref('InstanceRole')] });
}

// ---------------------------------------------------------------------------
// Identity and connectivity
// ---------------------------------------------------------------------------

/** The on-premises domain controllers' addresses (the plan's ad-dc rows). */
function onPremDcAddresses(plan: Plan): string[] {
  const out = plan.workloads.filter((w) => w.role === 'ad-dc').flatMap((w) => w.facts?.ipAddresses ?? []).filter((a) => /^[0-9a-f:.]+$/i.test(a));
  return [...new Set(out)];
}

function identity(b: Build): void {
  const { ctx, t, prefix } = b;
  const strategy = ctx.pd.identity.strategy;
  if (strategy === 'none') return;
  const prod = b.nets.get(hubOf(ctx.pd.networks, ctx.pd.region)?.name ?? '') ?? [...b.nets.values()][0];
  if (!prod) return;
  const domain = ctx.plan.requirements.identity.domain?.trim() || 'corp.example.com';
  const mgmt = onePerZone(prod.subnets, prod.zoneOf, 'mgmt').slice(0, 2);
  const tags = b.tags();
  if (mgmt.length < 2) {
    terraformOnly(ctx, 'DNS forwarding to the domain', 'the Route 53 Resolver endpoint and Managed Microsoft AD need two subnets in different zones, and the network has one.');
    return;
  }
  let targets: V;
  if (strategy === 'managed-ad') {
    t.add('DirectoryAdminSecret', 'AWS::SecretsManager::Secret', {
      Description: `${prefix}: the Admin password of the AWS Managed Microsoft AD directory ${domain}`,
      GenerateSecretString: { PasswordLength: 32, ExcludeCharacters: '"\'\\/@`', RequireEachIncludedType: true },
      ...(b.cmk ? { KmsKeyId: GetAtt('LandingZoneKey', 'Arn') } : {}),
    }, { ...tags, ...nameTag(`${prefix}-directory-admin`) });
    t.add('Directory', 'AWS::DirectoryService::MicrosoftAD', {
      Name: domain,
      Edition: 'Enterprise',
      Password: Sub('{{resolve:secretsmanager:${DirectoryAdminSecret}}}'),
      VpcSettings: { VpcId: Ref(prod.vpc), SubnetIds: mgmt.map(Ref) },
    });
    targets = [0, 1].map((i) => ({ Ip: Select(i, GetAtt('Directory', 'DnsIpAddresses')), Port: '53' }));
    b.t.output('DirectoryId', Ref('Directory'), 'The AWS Managed Microsoft AD directory');
  } else {
    const dcs = onPremDcAddresses(ctx.plan).filter((a) => !a.includes(':'));
    if (dcs.length === 0) {
      ctx.findings.push(warning('plan.native.identity-no-dc-addresses', 'AWS: DNS forwarding to the domain controllers needs their addresses, and no ad-dc workload has one, so it is left out.'));
      return;
    }
    targets = dcs.map((ip) => ({ Ip: ip, Port: '53' }));
  }
  t.add('ResolverSecurityGroup', 'AWS::EC2::SecurityGroup', {
    GroupName: `${prefix}-resolver`,
    GroupDescription: 'Route 53 Resolver outbound endpoint',
    VpcId: Ref(prod.vpc),
    SecurityGroupEgress: [
      { IpProtocol: 'tcp', FromPort: 53, ToPort: 53, CidrIp: '0.0.0.0/0', Description: 'DNS over TCP' },
      { IpProtocol: 'udp', FromPort: 53, ToPort: 53, CidrIp: '0.0.0.0/0', Description: 'DNS over UDP' },
      ...(prod.v6 ? [
        { IpProtocol: 'tcp', FromPort: 53, ToPort: 53, CidrIpv6: '::/0', Description: 'DNS over TCP, IPv6' },
        { IpProtocol: 'udp', FromPort: 53, ToPort: 53, CidrIpv6: '::/0', Description: 'DNS over UDP, IPv6' },
      ] : []),
    ],
  }, { ...tags, ...nameTag(`${prefix}-resolver`) });
  t.add('ResolverOutbound', 'AWS::Route53Resolver::ResolverEndpoint', {
    Name: `${prefix}-outbound`,
    Direction: 'OUTBOUND',
    ResolverEndpointType: prod.v6 ? 'DUALSTACK' : 'IPV4',
    Protocols: ['Do53'],
    SecurityGroupIds: [Ref('ResolverSecurityGroup')],
    IpAddresses: mgmt.map((s) => ({ SubnetId: Ref(s) })),
  }, { ...tags, ...nameTag(`${prefix}-outbound`) });
  t.add('ResolverRuleDomain', 'AWS::Route53Resolver::ResolverRule', {
    Name: `${prefix}-${kebab(domain)}`,
    DomainName: domain,
    RuleType: 'FORWARD',
    ResolverEndpointId: GetAtt('ResolverOutbound', 'ResolverEndpointId'),
    TargetIps: targets,
  }, { ...tags, ...nameTag(`${prefix}-${kebab(domain)}`) });
  for (const n of b.nets.values()) {
    t.add(`ResolverRuleDomain${pascal(n.net.name)}`, 'AWS::Route53Resolver::ResolverRuleAssociation', { ResolverRuleId: GetAtt('ResolverRuleDomain', 'ResolverRuleId'), VPCId: Ref(n.vpc) });
  }
}

function connectivity(b: Build): void {
  const { ctx, t, prefix } = b;
  if (ctx.pd.connectivity.length === 0) return;
  const nets = [...b.nets.values()];
  const tgw = nets.length >= 2;
  const asn = ctx.pd.connectivity[0]?.cloudAsn ?? 64512;
  const tags = b.tags();
  const zoneSubnets = (n: NetIds): string[] => onePerZone(n.subnets, n.zoneOf, 'tgw-attachment');
  if (tgw) {
    t.add('TransitGateway', 'AWS::EC2::TransitGateway', {
      Description: `${prefix} hub`,
      AmazonSideAsn: asn,
      AutoAcceptSharedAttachments: 'disable',
      DefaultRouteTableAssociation: 'enable',
      DefaultRouteTablePropagation: 'enable',
      DnsSupport: 'enable',
      VpnEcmpSupport: 'enable',
    }, { ...tags, ...nameTag(`${prefix}-hub`) });
    for (const n of nets) {
      t.add(`TransitGateway${pascal(n.net.name)}Attachment`, 'AWS::EC2::TransitGatewayVpcAttachment', {
        TransitGatewayId: Ref('TransitGateway'),
        VpcId: Ref(n.vpc),
        SubnetIds: zoneSubnets(n).map(Ref),
        Options: { Ipv6Support: n.v6 ? 'enable' : 'disable', DnsSupport: 'enable' },
      }, { ...tags, ...nameTag(`${prefix}-${n.net.name}`) });
    }
  } else {
    for (const n of nets) {
      const N = pascal(n.net.name);
      t.add(`VpnGateway${N}`, 'AWS::EC2::VPNGateway', { Type: 'ipsec.1', AmazonSideAsn: asn }, { ...tags, ...nameTag(`${prefix}-${n.net.name}`) });
      t.add(`VpnGateway${N}Attachment`, 'AWS::EC2::VPCGatewayAttachment', { VpcId: Ref(n.vpc), VpnGatewayId: Ref(`VpnGateway${N}`) });
      t.add(`VpnGateway${N}Propagation`, 'AWS::EC2::VPNGatewayRoutePropagation', { RouteTableIds: [Ref(n.routeTable)], VpnGatewayId: Ref(`VpnGateway${N}`) }, undefined, { DependsOn: [`VpnGateway${N}Attachment`] });
    }
  }
  const sites = ctx.pd.connectivity.map((c) => ({ c, site: ctx.plan.requirements.sites.find((s) => s.name === c.site) })).filter((x) => x.site);
  for (const { c, site } of sites) {
    if (!site) continue;
    const S = pascal(site.name);
    const vpn = c.method !== 'circuit';
    if (vpn && site.vpnPeer) {
      const v6peer = isV6(site.vpnPeer);
      t.add(`CustomerGateway${S}`, 'AWS::EC2::CustomerGateway', { Type: 'ipsec.1', IpAddress: site.vpnPeer, BgpAsn: site.bgpAsn ?? 65000 }, { ...tags, ...nameTag(site.name) });
      // The pre-shared keys: generated by the VPN service and kept in Secrets Manager, never in a file.
      const tunnels = [{ StartupAction: 'start' }, { StartupAction: 'start' }];
      const insides: ('ipv4' | 'ipv6')[] = ['ipv4', ...(tgw && site.cidrs.some(isV6) ? ['ipv6' as const] : [])];
      if (!tgw && site.cidrs.some(isV6)) {
        ctx.findings.push(info('plan.native.aws-vgw-ipv6', `Site ${site.name}: a virtual private gateway carries IPv4 only, so its IPv6 ranges need the transit gateway (two or more networks).`));
      }
      for (const inside of insides) {
        const suffix = inside === 'ipv6' ? 'Ipv6' : '';
        const common = {
          Type: 'ipsec.1',
          CustomerGatewayId: Ref(`CustomerGateway${S}`),
          StaticRoutesOnly: false,
          PreSharedKeyStorage: 'SecretsManager',
          VpnTunnelOptionsSpecifications: tunnels,
          ...(tgw ? { TunnelInsideIpVersion: inside, ...(v6peer ? { OutsideIpAddressType: 'PublicIpv6' } : {}) } : {}),
        };
        if (tgw) {
          t.add(`Vpn${S}${suffix}`, 'AWS::EC2::VPNConnection', { ...common, TransitGatewayId: Ref('TransitGateway') }, { ...tags, ...nameTag(`${site.name}${inside === 'ipv6' ? '-v6' : ''}`) });
        } else {
          for (const n of nets) {
            t.add(`Vpn${S}${pascal(n.net.name)}`, 'AWS::EC2::VPNConnection', { ...common, VpnGatewayId: Ref(`VpnGateway${pascal(n.net.name)}`) }, { ...tags, ...nameTag(`${site.name}-${n.net.name}`) });
          }
        }
      }
    }
  }
  // Routes to on-premises through the transit gateway, in every private route table (a VPN gateway propagates its own).
  if (tgw) {
    for (const n of nets) {
      const routes = sites.flatMap(({ site }) => site?.cidrs ?? []).filter((cidr) => !isV6(cidr) || n.v6);
      routes.forEach((cidr, i) => {
        t.add(`Route${pascal(n.net.name)}OnPrem${i + 1}`, 'AWS::EC2::Route', {
          RouteTableId: Ref(n.routeTable),
          ...(isV6(cidr) ? { DestinationIpv6CidrBlock: cidr } : { DestinationCidrBlock: cidr }),
          TransitGatewayId: Ref('TransitGateway'),
        }, undefined, { DependsOn: [`TransitGateway${pascal(n.net.name)}Attachment`] });
      });
    }
  }
  // Direct Connect: the gateway and a virtual interface per circuit; the connection id and VLAN come from the provider.
  const circuits = sites.filter(({ c }) => c.method !== 'vpn');
  if (circuits.length > 0) {
    t.add('DxGateway', 'AWS::DirectConnect::DirectConnectGateway', { DirectConnectGatewayName: `${prefix}-dx`, AmazonSideAsn: String(asn + 1) }, { ...tags, ...nameTag(`${prefix}-dx`) });
    if (tgw) {
      t.add('DxGatewayHub', 'AWS::DirectConnect::DirectConnectGatewayAssociation', {
        DirectConnectGatewayId: GetAtt('DxGateway', 'DirectConnectGatewayId'),
        AssociatedGatewayId: Ref('TransitGateway'),
        AllowedPrefixesToDirectConnectGateway: nets.map((n) => n.net.cidr),
      });
    } else {
      for (const n of nets) {
        t.add(`DxGateway${pascal(n.net.name)}`, 'AWS::DirectConnect::DirectConnectGatewayAssociation', {
          DirectConnectGatewayId: GetAtt('DxGateway', 'DirectConnectGatewayId'),
          AssociatedGatewayId: Ref(`VpnGateway${pascal(n.net.name)}`),
        }, undefined, { DependsOn: [`VpnGateway${pascal(n.net.name)}Attachment`] });
      }
    }
    for (const { site } of circuits) {
      if (!site) continue;
      const S = pascal(site.name);
      const conn = t.param(`DxConnectionId${S}`, { Type: 'String', AllowedPattern: '^dx(con|lag)-[a-z0-9]+$', Description: `The Direct Connect connection id (dxcon-…) for ${site.name}, from the provider or partner.` }, 'Direct Connect');
      const vlan = t.param(`DxVlan${S}`, { Type: 'Number', MinValue: 1, MaxValue: 4094, Description: `The VLAN the Direct Connect partner or port assigns to ${site.name}.` }, 'Direct Connect');
      const asnText = String(site.bgpAsn ?? 65000);
      t.add(`DxInterface${S}`, tgw ? 'AWS::DirectConnect::TransitVirtualInterface' : 'AWS::DirectConnect::PrivateVirtualInterface', {
        VirtualInterfaceName: `${prefix}-${site.name}`,
        ConnectionId: Ref(conn),
        Vlan: Ref(vlan),
        DirectConnectGatewayId: GetAtt('DxGateway', 'DirectConnectGatewayId'),
        // The same interface carries both families: a BGP session for each.
        BgpPeers: [{ AddressFamily: 'ipv4', Asn: asnText }, { AddressFamily: 'ipv6', Asn: asnText }],
      }, { ...tags, ...nameTag(site.name) });
    }
  }
}

// ---------------------------------------------------------------------------
// Compute
// ---------------------------------------------------------------------------

interface ImageParam {
  readonly id: string;
  readonly device: string;
}

/** The root device of an image family: /dev/xvda for Debian and Amazon Linux, /dev/sda1 for the rest. */
function rootDeviceOf(os: string, key: string): string {
  if (/^debian/.test(os) || /amzn|al2023|amazon/i.test(key)) return '/dev/xvda';
  return '/dev/sda1';
}

function imageParams(b: Build): Map<string, ImageParam> {
  const out = new Map<string, ImageParam>();
  const keys = new Map<string, string>();
  for (const vm of b.ctx.rebuilt) {
    const img = vm.image;
    const w = workloadOf(b.ctx, vm);
    const key = img.kind === 'aws-ssm' ? `ssm:${img.parameter}` : img.kind === 'aws-ami-filter' ? `ami:${img.owner}:${img.namePattern}` : img.kind === 'custom' ? `var:${img.variable}` : `vm:${vmName(b.ctx, vm)}`;
    if (!keys.has(key)) {
      const n = keys.size + 1;
      const id = `Image${n}`;
      keys.set(key, id);
      const os = w?.os ?? 'unknown';
      if (img.kind === 'aws-ssm') {
        b.t.param(id, { Type: 'AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>', Default: img.parameter, Description: `The image for ${os}: the public Systems Manager parameter of the latest one.` }, 'Images');
      } else if (img.kind === 'aws-ami-filter') {
        b.t.param(id, { Type: 'AWS::EC2::Image::Id', Description: `The image for ${os}: the newest available AMI of owner ${img.owner} named ${img.namePattern}.` }, 'Images');
      } else {
        b.t.param(id, { Type: 'AWS::EC2::Image::Id', Description: `The image (AMI id) for ${vmName(b.ctx, vm)} (${os}).` }, 'Images');
      }
      const device = b.t.param(`${id}RootDevice`, { Type: 'String', Default: rootDeviceOf(os, key), AllowedValues: ['/dev/sda1', '/dev/xvda'], Description: `The root device name of ${id} (its AMI's RootDeviceName).` }, 'Images');
      out.set(key, { id, device });
    }
    out.set(vm.workload, out.get(key) as ImageParam);
  }
  return out;
}

function compute(b: Build): void {
  const { ctx, t, prefix } = b;
  for (const vm of ctx.replicated) {
    ctx.findings.push(info('plan.native.aws-replicated', `${vmName(ctx, vm)}: AWS Application Migration Service launches it at cutover, so the template does not create it.`));
  }
  if (ctx.replicated.length > 0) {
    terraformOnly(ctx, 'Adopting replicated VMs after cutover', 'AWS Application Migration Service launches them; the Terraform stack adopts them with import blocks (cutover_instance_ids). CloudFormation can import them into a stack with a change set of type IMPORT, which is a separate operation the template cannot do on its own.');
  }
  if (ctx.rebuilt.length === 0) return;
  const images = imageParams(b);
  const anyLinux = ctx.rebuilt.some((vm) => osKindOf(workloadOf(ctx, vm)?.os) === 'linux');
  if (anyLinux) {
    t.param('SshPublicKey', { Type: 'String', MinLength: 1, Description: 'The SSH public key of the ansible user on every Linux VM (a public key, not a secret).' }, 'Access');
  }
  t.add('InstanceLaunchTemplate', 'AWS::EC2::LaunchTemplate', {
    LaunchTemplateName: `${prefix}-instances`,
    LaunchTemplateData: { MetadataOptions: { HttpEndpoint: 'enabled', HttpTokens: 'required', HttpPutResponseHopLimit: 2, HttpProtocolIpv6: 'enabled' } },
  }, b.tags());
  const mgmt = mgmtCidrs(ctx.plan, ctx.pd);
  const hosts = new Map<string, string>();
  for (const vm of ctx.rebuilt) {
    const w = workloadOf(ctx, vm);
    const name = vmName(ctx, vm);
    const net = b.nets.get(vm.network) ?? [...b.nets.values()][0];
    if (!net) continue;
    const tierSubnets = net.subnets.get(vm.tier) ?? [];
    const subnet = tierSubnets.find((id) => net.zoneOf.get(id) === vm.zone) ?? tierSubnets[0];
    const sg = net.sgs.get(vm.tier);
    if (!subnet || !sg) {
      ctx.findings.push(warning('plan.native.aws-vm-tier', `${name}: the ${vm.network} network has no ${vm.tier} tier, so the VM is left out.`));
      continue;
    }
    const img = images.get(vm.workload) as ImageParam;
    const kind = osKindOf(w?.os);
    const tags = { ...b.tags(w?.app, w?.env, w ? ctx.appByName.get(w.app)?.owner : undefined), ...vmTags(ctx, vm, 'rebuild'), Name: name };
    const id = `Vm${pascal(name)}`;
    const [boot, ...data] = vm.disks;
    let hostId: string | undefined;
    if (vm.dedicatedHost) {
      const family = vm.size.split('.')[0] ?? vm.size;
      const zone = net.zoneOf.get(subnet) ?? vm.zone;
      const key = `${family}-${zone.slice(-1)}`;
      hostId = hosts.get(key);
      if (!hostId) {
        hostId = t.add(`Host${pascal(family)}${zone.slice(-1).toUpperCase()}`, 'AWS::EC2::Host', { AvailabilityZone: zone, InstanceFamily: family, AutoPlacement: 'off', HostRecovery: 'on' }, { ...b.tags(), ...nameTag(`${prefix}-${key}`) });
        hosts.set(key, hostId);
        terraformOnly(ctx, 'License Manager association of dedicated hosts', 'CloudFormation has no resource associating a host with a License Manager configuration; associate the hosts in License Manager (the Terraform stack does it with aws_licensemanager_association).');
      }
    }
    const userData = kind === 'windows'
      ? Base64(['<powershell>', ...winrmLines(mgmt), '</powershell>', ''].join('\n'))
      : Base64(Sub(`${cloudInitLines(kebab(name) || 'host', '${SshPublicKey}').join('\n')}\n`));
    t.add(id, 'AWS::EC2::Instance', {
      LaunchTemplate: { LaunchTemplateId: Ref('InstanceLaunchTemplate'), Version: GetAtt('InstanceLaunchTemplate', 'LatestVersionNumber') },
      ImageId: Ref(img.id),
      InstanceType: vm.size,
      SubnetId: Ref(subnet),
      SecurityGroupIds: [GetAtt(sg, 'GroupId')],
      IamInstanceProfile: Ref('InstanceProfile'),
      ...(vm.coreCount ? { CpuOptions: { CoreCount: vm.coreCount, ThreadsPerCore: 2 } } : {}),
      ...(hostId ? { Tenancy: 'host', HostId: Ref(hostId) } : {}),
      BlockDeviceMappings: [{
        DeviceName: Ref(img.device),
        Ebs: { VolumeType: boot?.type ?? 'gp3', VolumeSize: boot?.gib ?? 64, Encrypted: true, ...(b.cmk ? { KmsKeyId: GetAtt('LandingZoneKey', 'Arn') } : {}), DeleteOnTermination: true },
      }],
      PropagateTagsToVolumeOnCreation: true,
      UserData: userData,
    }, tags);
    b.instances.set(name, id);
    data.forEach((d, i) => {
      const vid = `${id}Data${i + 1}`;
      t.add(vid, 'AWS::EC2::Volume', {
        AvailabilityZone: GetAtt(id, 'AvailabilityZone'),
        Size: d.gib,
        VolumeType: d.type,
        ...(d.type === 'io2' || d.type === 'io1' ? { Iops: Math.min(64000, Math.max(100, d.gib * 50)) } : {}),
        Encrypted: true,
        ...(b.cmk ? { KmsKeyId: GetAtt('LandingZoneKey', 'Arn') } : {}),
      }, { ...tags, Name: `${name}-data${i + 1}` }, { DeletionPolicy: 'Snapshot', UpdateReplacePolicy: 'Snapshot' });
      t.add(`${vid}Attachment`, 'AWS::EC2::VolumeAttachment', { Device: `/dev/sd${String.fromCharCode(102 + i)}`, InstanceId: Ref(id), VolumeId: Ref(vid) });
    });
    if (vm.licenceHandling && /ahb|byos/i.test(vm.licenceHandling)) {
      ctx.findings.push(info('plan.native.aws-licence', `${name}: "${vm.licenceHandling}" has no AWS equivalent; the instance is licence-included unless its image is a BYOL one.`));
    }
    t.output(`${id}PrivateIp`, GetAtt(id, 'PrivateIp'), `${name}: private IPv4 address`);
  }
}

// ---------------------------------------------------------------------------
// Databases
// ---------------------------------------------------------------------------

function awsEngine(t: DbTarget, db: Database | undefined): string {
  const engine = db?.engine ?? 'postgres';
  if (t.service === 'aws-aurora') return engine === 'mysql' ? 'aurora-mysql' : 'aurora-postgresql';
  if (engine === 'oracle') return db?.edition === 'oracle-se2' ? 'oracle-se2' : 'oracle-ee';
  if (engine === 'sqlserver') {
    return ({ 'sql-enterprise': 'sqlserver-ee', 'sql-web': 'sqlserver-web', 'sql-express': 'sqlserver-ex' } as Record<string, string>)[db?.edition ?? ''] ?? 'sqlserver-se';
  }
  return engine;
}

/** The RDS engine version: the design's, else the major version for the open-source engines (RDS picks the minor). */
function awsVersion(t: DbTarget, db: Database | undefined, engine: string): string {
  if (t.engineVersion) return t.engineVersion;
  if (/^(postgres|aurora-postgresql)$/.test(engine)) return /(\d+)/.exec(db?.version ?? '')?.[1] ?? '';
  if (/^(mysql|mariadb|aurora-mysql)$/.test(engine)) return engine === 'aurora-mysql' ? '' : /(\d+\.\d+)/.exec(db?.version ?? '')?.[1] ?? '';
  // Oracle and SQL Server take a full version: blank lets RDS choose the current default.
  return '';
}

function rdsFamily(engine: string, version: string): string | null {
  if (!version) return null;
  const [major = '', minor = ''] = version.split('.');
  if (engine === 'postgres') return `postgres${major}`;
  if (engine === 'mysql' || engine === 'mariadb') return `${engine}${major}.${minor || '0'}`;
  return null;
}

function rdsLicence(t: DbTarget, engine: string): string {
  if (/^(license-included|bring-your-own-license|general-public-license|postgresql-license)$/.test(t.licenceModel)) return t.licenceModel;
  if (engine === 'postgres') return 'postgresql-license';
  if (engine === 'mysql' || engine === 'mariadb') return 'general-public-license';
  if (engine.startsWith('oracle')) return engine === 'oracle-ee' || /bring|byol/i.test(t.licenceModel) ? 'bring-your-own-license' : 'license-included';
  return 'license-included';
}

const LOG_EXPORTS: Record<string, readonly string[]> = {
  postgres: ['postgresql', 'upgrade'], mysql: ['error', 'slowquery'], mariadb: ['error', 'slowquery'], oracle: ['alert', 'listener'], sqlserver: ['error', 'agent'],
};

function databases(b: Build): void {
  const { ctx, t, prefix } = b;
  const subnetGroups = new Map<string, string>();
  for (const target of ctx.databases) {
    const db = ctx.dbById.get(target.database);
    const name = db?.name ?? target.database;
    if (isIaasService(target.service)) continue;
    if (target.service in DB_SERVICES_EXTRA) {
      terraformOnly(ctx, `${name} (${target.service})`, 'caches, document and search stores are built by their pattern item or a resource component in the Terraform stack, not by the migration databases grid this template follows.');
      continue;
    }
    if (target.service === 'aws-odb-exadata' || target.service === 'aws-odb-adb') {
      terraformOnly(ctx, `${name} on Oracle Database@AWS`, 'the ODB network, Exadata infrastructure and VM cluster, and the databases created through OCI, span two providers; the Terraform stack builds them together.');
      continue;
    }
    if (target.service === 'aws-rds-custom') {
      terraformOnly(ctx, `${name} on RDS Custom`, 'RDS Custom needs a custom engine version built from your installation media first.');
      continue;
    }
    if (target.service !== 'aws-rds' && target.service !== 'aws-aurora') continue;
    const netName = dbNetwork(ctx, db);
    const net = b.nets.get(netName) ?? [...b.nets.values()][0];
    const dbSg = net?.sgs.get('db');
    const dbSubnets = net?.subnets.get('db') ?? [];
    if (!net || !dbSg || dbSubnets.length < 2) {
      ctx.findings.push(warning('plan.native.aws-db-network', `${name}: the ${netName} network needs a db tier in two zones for RDS, so the database is left out.`));
      continue;
    }
    let group = subnetGroups.get(netName);
    if (!group) {
      group = t.add(`DbSubnetGroup${pascal(netName)}`, 'AWS::RDS::DBSubnetGroup', {
        DBSubnetGroupName: `${prefix}-${netName}-db`,
        DBSubnetGroupDescription: `The db tier of ${netName}`,
        SubnetIds: dbSubnets.map(Ref),
      }, { ...b.tags(), ...nameTag(`${prefix}-${netName}-db`) });
      subnetGroups.set(netName, group);
    }
    const engine = awsEngine(target, db);
    const version = awsVersion(target, db, engine);
    const kind = engine.startsWith('oracle') ? 'oracle' : engine.startsWith('sqlserver') ? 'sqlserver' : engine;
    const env = dbEnv(ctx, db);
    const app = db?.app;
    const tags = { ...b.tags(app, env, app ? ctx.appByName.get(app)?.owner : undefined), atk_db: db?.engine ?? engine, atk_backup: target.backupTier, atk_backup_days: String(retentionOf(ctx.pd, target.backupTier)), Name: name };
    const id = `Db${pascal(name)}`;
    const ha = target.ha === 'multi-az' || target.ha === 'standby' || target.ha === 'zone-redundant' || target.ha === 'regional';
    const common: Obj = {
      DBSubnetGroupName: Ref(group),
      StorageEncrypted: true,
      ...(b.cmk ? { KmsKeyId: GetAtt('LandingZoneKey', 'Arn') } : {}),
      ManageMasterUserPassword: true,
      ...(b.cmk ? { MasterUserSecret: { KmsKeyId: GetAtt('LandingZoneKey', 'Arn') } } : {}),
      MasterUsername: 'dbadmin',
      BackupRetentionPeriod: Math.min(35, Math.max(1, retentionOf(ctx.pd, target.backupTier))),
      CopyTagsToSnapshot: true,
      DeletionProtection: true,
      NetworkType: net.v6 ? 'DUAL' : 'IPV4',
    };
    if (target.service === 'aws-aurora') {
      t.add(`${id}Cluster`, 'AWS::RDS::DBCluster', {
        DBClusterIdentifier: kebab(`${prefix}-${name}`),
        Engine: engine,
        ...(version ? { EngineVersion: version } : {}),
        VpcSecurityGroupIds: [GetAtt(dbSg, 'GroupId')],
        EnableIAMDatabaseAuthentication: true,
        EnableCloudwatchLogsExports: engine === 'aurora-postgresql' ? ['postgresql'] : ['error', 'slowquery'],
        ...common,
      }, tags, { DeletionPolicy: 'Snapshot', UpdateReplacePolicy: 'Snapshot' });
      for (let i = 1; i <= (ha ? 2 : 1); i += 1) {
        t.add(`${id}Instance${i}`, 'AWS::RDS::DBInstance', {
          DBInstanceIdentifier: kebab(`${prefix}-${name}-${i}`),
          DBClusterIdentifier: Ref(`${id}Cluster`),
          DBInstanceClass: classCell('aws', target, db) || 'db.r7i.large',
          Engine: engine,
          AutoMinorVersionUpgrade: true,
          PubliclyAccessible: false,
        }, tags);
      }
      b.dbInstances.set(name, `${id}Instance1`);
      t.output(`${id}Endpoint`, GetAtt(`${id}Cluster`, 'Endpoint.Address'), `${name}: the cluster endpoint`);
      t.output(`${id}Secret`, GetAtt(`${id}Cluster`, 'MasterUserSecret.SecretArn'), `${name}: the Secrets Manager secret holding the master password`);
      continue;
    }
    const family = rdsFamily(engine, version);
    const force: Record<string, [string, string]> = { postgres: ['rds.force_ssl', '1'], mysql: ['require_secure_transport', 'ON'], mariadb: ['require_secure_transport', 'ON'] };
    const param = force[kind];
    if (family && param) {
      t.add(`${id}Parameters`, 'AWS::RDS::DBParameterGroup', { Family: family, Description: `${name}: TLS only`, Parameters: { [param[0]]: param[1] } }, tags);
    }
    t.add(id, 'AWS::RDS::DBInstance', {
      DBInstanceIdentifier: kebab(`${prefix}-${name}`),
      Engine: engine,
      ...(version ? { EngineVersion: version } : {}),
      DBInstanceClass: classCell('aws', target, db) || 'db.r7i.large',
      AllocatedStorage: String(Math.max(20, target.storageGib)),
      MaxAllocatedStorage: Math.max(20, target.storageGib) * 2,
      StorageType: 'gp3',
      LicenseModel: rdsLicence(target, engine),
      MultiAZ: ha,
      VPCSecurityGroups: [GetAtt(dbSg, 'GroupId')],
      ...common,
      ...(family && param ? { DBParameterGroupName: Ref(`${id}Parameters`) } : {}),
      ...(kind === 'oracle' ? { CharacterSetName: 'AL32UTF8' } : {}),
      ...(kind === 'postgres' || kind === 'mysql' || kind === 'mariadb' ? { EnableIAMDatabaseAuthentication: true } : {}),
      EnableCloudwatchLogsExports: [...(LOG_EXPORTS[kind] ?? [])],
      PubliclyAccessible: false,
      AutoMinorVersionUpgrade: true,
    }, tags, { DeletionPolicy: 'Snapshot', UpdateReplacePolicy: 'Snapshot' });
    if (kind === 'sqlserver' || kind === 'oracle') {
      ctx.findings.push(info('plan.native.aws-rds-version', `${name}: RDS for ${kind === 'oracle' ? 'Oracle' : 'SQL Server'} takes a full engine version; none is set in the design, so RDS uses its current default. Set EngineVersion to pin one.`));
    }
    b.dbInstances.set(name, id);
    t.output(`${id}Endpoint`, GetAtt(id, 'Endpoint.Address'), `${name}: the endpoint`);
    t.output(`${id}Secret`, GetAtt(id, 'MasterUserSecret.SecretArn'), `${name}: the Secrets Manager secret holding the master password`);
  }
}

// ---------------------------------------------------------------------------
// Backup and monitoring
// ---------------------------------------------------------------------------

const awsCron = (frequency: string): string => {
  const hours = Number(/(\d+)/.exec(frequency)?.[1] ?? 24);
  return hours >= 24 ? 'cron(0 5 * * ? *)' : `cron(0 0/${hours} * * ? *)`;
};

function backup(b: Build): { drVault?: string } {
  const { ctx, t, prefix } = b;
  const tiers = ctx.pd.backup.tiers;
  if (tiers.length === 0) return {};
  const dr = ctx.pd.drRegion;
  const tags = b.tags();
  t.add('BackupVault', 'AWS::Backup::BackupVault', {
    BackupVaultName: `${prefix}-backup`,
    ...(b.cmk ? { EncryptionKeyArn: GetAtt('LandingZoneKey', 'Arn') } : {}),
    ...(tiers.some((x) => x.immutable)
      ? { LockConfiguration: { MinRetentionDays: 1, MaxRetentionDays: Math.max(1, ...tiers.filter((x) => x.immutable).map((x) => x.retentionDays)), ChangeableForDays: 3 } }
      : {}),
  }, tags, { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
  const copies = !!dr && tiers.some((x) => x.copyToDr);
  const drVaultArn = Sub(`arn:\${AWS::Partition}:backup:${dr ?? ''}:\${AWS::AccountId}:backup-vault:${prefix}-backup-dr`);
  t.add('BackupPlan', 'AWS::Backup::BackupPlan', {
    BackupPlan: {
      BackupPlanName: `${prefix}-tiers`,
      BackupPlanRule: tiers.map((x) => ({
        RuleName: x.tier,
        TargetBackupVault: Ref('BackupVault'),
        ScheduleExpression: awsCron(x.frequency),
        StartWindowMinutes: 60,
        CompletionWindowMinutes: 360,
        Lifecycle: { DeleteAfterDays: x.retentionDays },
        ...(x.copyToDr && dr ? { CopyActions: [{ DestinationBackupVaultArn: drVaultArn, Lifecycle: { DeleteAfterDays: x.retentionDays } }] } : {}),
      })),
    },
  }, tags);
  t.add('BackupRole', 'AWS::IAM::Role', {
    Description: `${prefix}: AWS Backup`,
    AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'backup.amazonaws.com' }, Action: 'sts:AssumeRole' }] },
    ManagedPolicyArns: [
      Sub('arn:${AWS::Partition}:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup'),
      Sub('arn:${AWS::Partition}:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores'),
    ],
  }, { ...tags, ...nameTag(`${prefix}-backup`) });
  for (const x of tiers) {
    t.add(`BackupSelection${pascal(x.tier)}`, 'AWS::Backup::BackupSelection', {
      BackupPlanId: Ref('BackupPlan'),
      BackupSelection: {
        SelectionName: x.tier,
        IamRoleArn: GetAtt('BackupRole', 'Arn'),
        Resources: ['*'],
        ListOfTags: [{ ConditionType: 'STRINGEQUALS', ConditionKey: 'atk_backup', ConditionValue: x.tier }],
      },
    });
    if (x.copyToDr && !dr) ctx.findings.push(info('plan.native.backup-no-dr', `Tier ${x.tier} asks for a DR copy but no DR region is set.`));
  }
  if (!copies) return {};
  // The DR vault lives in the DR region: a stack of its own there, deployed first.
  const drt = new Template();
  drt.param(OWNER, { Type: 'String', Default: 'unassigned', Description: 'The atk_owner tag of what this builds.' }, 'Tags');
  drt.add('DrBackupVault', 'AWS::Backup::BackupVault', { BackupVaultName: `${prefix}-backup-dr` }, tags, { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
  drt.output('DrBackupVaultArn', GetAtt('DrBackupVault', 'BackupVaultArn'), 'The vault the backup copies land in');
  return { drVault: renderTemplate(drt, `${ctx.plan.name}: AWS backup copies in ${dr}`) };
}

function monitoring(b: Build): void {
  const { ctx, t, prefix } = b;
  if (ctx.rebuilt.length === 0 && ctx.replicated.length === 0) return;
  if (ctx.plan.requirements.monitoring === 'vcf-operations') return;
  const tags = b.tags();
  const retention = [30, 60, 90, 120, 150, 180, 365, 400, 545, 731].find((d) => d >= Math.min(731, ctx.pd.logRetentionDays)) ?? 365;
  const groups = ['linux/messages', 'linux/secure', 'windows/system', 'windows/security'];
  for (const g of groups) {
    t.add(`LogGroup${pascal(g)}`, 'AWS::Logs::LogGroup', { LogGroupName: `/${prefix}/${g}`, RetentionInDays: retention }, tags, { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
  }
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
  t.add('CloudWatchAgentConfig', 'AWS::SSM::Parameter', { Name: `/${prefix}/cloudwatch-agent/config`, Type: 'String', Tier: 'Standard', Value: JSON.stringify(config) }, tags);
  t.add('CloudWatchAgentInstall', 'AWS::SSM::Association', {
    Name: 'AWS-ConfigureAWSPackage',
    AssociationName: `${prefix}-install-cloudwatch-agent`,
    Parameters: { action: ['Install'], name: ['AmazonCloudWatchAgent'] },
    ScheduleExpression: 'rate(7 days)',
    Targets: [{ Key: 'tag-key', Values: ['atk_os'] }],
  }, tags);
  t.add('CloudWatchAgentConfigure', 'AWS::SSM::Association', {
    Name: 'AmazonCloudWatch-ManageAgent',
    AssociationName: `${prefix}-configure-cloudwatch-agent`,
    Parameters: { action: ['configure'], mode: ['ec2'], optionalConfigurationSource: ['ssm'], optionalConfigurationLocation: [Ref('CloudWatchAgentConfig')], optionalRestart: ['yes'] },
    ScheduleExpression: 'rate(7 days)',
    Targets: [{ Key: 'tag-key', Values: ['atk_os'] }],
  }, tags, { DependsOn: ['CloudWatchAgentInstall'] });
  if (ctx.plan.requirements.siem !== 'none') {
    ctx.findings.push(info('plan.native.siem', `Forwarding to ${ctx.plan.requirements.siem} is configured in the SIEM, which subscribes to these log groups and CloudTrail; nothing is written here for it.`));
  }
}

// ---------------------------------------------------------------------------
// App items
// ---------------------------------------------------------------------------

const setting = (c: AppComponentLike, key: string, fallback: string): string => c.settings?.[key]?.trim() || fallback;

function splitUri(uri: string, scheme: string): { bucket: string; key: string } | null {
  const m = new RegExp(`^${scheme}://([^/]+)/(.+)$`).exec(uri.trim());
  return m ? { bucket: m[1] as string, key: m[2] as string } : null;
}

function appTags(b: Build, a: AppHere, component?: string): Tags {
  const envs = [...new Set([...b.ctx.rebuilt, ...b.ctx.replicated].map((vm) => workloadOf(b.ctx, vm)).filter((w) => w?.app === a.app.name).map((w) => w?.env))].filter(Boolean).join(' ') || 'prod';
  return { ...b.tags(a.app.name, envs, a.app.owner), atk_criticality: a.app.criticality, ...(component ? { atk_component: component } : {}) };
}

function serverless(b: Build, a: AppHere, c: AppComponentLike): void {
  const { t, prefix } = b;
  const net = b.nets.get(setting(c, 'network', 'prod')) ?? [...b.nets.values()][0];
  const appSg = net?.sgs.get('app');
  const appSubnets = net?.subnets.get('app') ?? [];
  const name = `${prefix}-${slugName(a.app.name)}-${kebab(c.name)}`.slice(0, 64).replace(/-+$/, '');
  const id = `Fn${pascal(a.app.name, c.name)}`;
  const tags = appTags(b, a, c.id);
  const image = setting(c, 'package', 's3') === 'image';
  const artifact = setting(c, 'artifact', 's3://artifacts-bucket/function.zip');
  const s3 = splitUri(artifact, 's3');
  const group = `${a.app.name} ${c.name}`;
  let code: Obj;
  if (image) {
    t.param(`${id}ImageUri`, { Type: 'String', Default: artifact, Description: `The ECR image URI of ${a.app.name} ${c.name} (the pipeline publishes it).` }, group);
    code = { ImageUri: Ref(`${id}ImageUri`) };
  } else {
    t.param(`${id}CodeBucket`, { Type: 'String', ...(s3 ? { Default: s3.bucket } : {}), Description: `The S3 bucket holding the zip of ${a.app.name} ${c.name} (the pipeline publishes it).` }, group);
    t.param(`${id}CodeKey`, { Type: 'String', ...(s3 ? { Default: s3.key } : {}), Description: `The key of the zip in that bucket.` }, group);
    code = { S3Bucket: Ref(`${id}CodeBucket`), S3Key: Ref(`${id}CodeKey`) };
  }
  t.add(`${id}Role`, 'AWS::IAM::Role', {
    Description: `${name}: the function's execution role`,
    AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }] },
    ManagedPolicyArns: [
      Sub('arn:${AWS::Partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole'),
      Sub('arn:${AWS::Partition}:iam::aws:policy/AWSXRayDaemonWriteAccess'),
    ],
  }, tags);
  t.add(`${id}Logs`, 'AWS::Logs::LogGroup', {
    LogGroupName: `/aws/lambda/${name}`,
    RetentionInDays: 90,
    ...(b.cmk ? { KmsKeyId: GetAtt('LandingZoneKey', 'Arn') } : {}),
  }, tags, { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
  t.add(id, 'AWS::Lambda::Function', {
    FunctionName: name,
    Role: GetAtt(`${id}Role`, 'Arn'),
    PackageType: image ? 'Image' : 'Zip',
    Code: code,
    ...(image ? {} : { Runtime: setting(c, 'runtime', 'python3.12'), Handler: setting(c, 'handler', 'app.handler') }),
    Architectures: ['arm64'],
    MemorySize: Number(setting(c, 'memory_mb', '512')) || 512,
    Timeout: Math.min(900, Number(setting(c, 'timeout_s', '60')) || 60),
    ReservedConcurrentExecutions: Number(setting(c, 'max_instances', '20')) || 20,
    ...(net && appSg && appSubnets.length > 0
      ? { VpcConfig: { SubnetIds: appSubnets.map(Ref), SecurityGroupIds: [GetAtt(appSg, 'GroupId')], Ipv6AllowedForDualStack: !!net.v6 } }
      : {}),
    TracingConfig: { Mode: 'Active' },
    LoggingConfig: { LogFormat: 'JSON', LogGroup: Ref(`${id}Logs`) },
  }, tags);
  b.functions.set(`${a.app.name}/${c.id}`, id);
  t.output(`${id}Arn`, GetAtt(id, 'Arn'), `${a.app.name} ${c.name}: the function`);
}

function apiGateway(b: Build, a: AppHere, c: AppComponentLike): void {
  const fn = [...b.functions.entries()].find(([k]) => k.startsWith(`${a.app.name}/`))?.[1];
  if (!fn) {
    terraformOnly(b.ctx, `${a.app.name} ${c.name} (API gateway)`, 'the app has no function on AWS for an HTTP API to front, and a gateway to other back ends needs its routes designed; no Terraform blueprint builds it either.');
    return;
  }
  const { t, prefix } = b;
  const id = `Api${pascal(a.app.name, c.name)}`;
  const tags = appTags(b, a, c.id);
  // An HTTP API created with a target: its integration, the $default route and the auto-deployed $default stage.
  t.add(id, 'AWS::ApiGatewayV2::Api', {
    Name: `${prefix}-${slugName(a.app.name)}-${kebab(c.name)}`,
    ProtocolType: 'HTTP',
    IpAddressType: 'dualstack',
    Target: GetAtt(fn, 'Arn'),
  }, tags);
  t.add(`${id}Invoke`, 'AWS::Lambda::Permission', {
    Action: 'lambda:InvokeFunction',
    FunctionName: Ref(fn),
    Principal: 'apigateway.amazonaws.com',
    SourceArn: Sub(`arn:\${AWS::Partition}:execute-api:\${AWS::Region}:\${AWS::AccountId}:\${${id}}/*`),
  });
  t.output(`${id}Endpoint`, GetAtt(id, 'ApiEndpoint'), `${a.app.name} ${c.name}: the API endpoint`);
  if (a.ingress?.waf) {
    terraformOnly(b.ctx, `${a.app.name}: web application firewall on the HTTP API`, 'AWS WAF attaches to REST APIs, load balancers and CloudFront, not to an HTTP API; put CloudFront with a web ACL in front of it.');
  }
}

function staticSite(b: Build, a: AppHere, c: AppComponentLike): void {
  const { t } = b;
  const id = `Site${pascal(a.app.name, c.name)}`;
  const tags = appTags(b, a, c.id);
  const fqdns = setting(c, 'fqdns', '').split(/\s+/).filter(Boolean);
  const cert = setting(c, 'certificate', '');
  const aliases = fqdns.length > 0 && cert ? fqdns : [];
  if (fqdns.length > 0 && !cert) b.ctx.findings.push(info('plan.native.aws-site-certificate', `${a.app.name}: the site serves on its CloudFront name until an ACM certificate (us-east-1) for ${fqdns.join(', ')} is given in the component's settings.`));
  t.add(id, 'AWS::S3::Bucket', {
    VersioningConfiguration: { Status: 'Enabled' },
    BucketEncryption: { ServerSideEncryptionConfiguration: [{ BucketKeyEnabled: true, ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
    PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
  }, tags, { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
  t.add(`${id}Oac`, 'AWS::CloudFront::OriginAccessControl', {
    OriginAccessControlConfig: { Name: `${b.prefix}-${slugName(a.app.name)}-site`.slice(0, 64), OriginAccessControlOriginType: 's3', SigningBehavior: 'always', SigningProtocol: 'sigv4' },
  });
  t.add(`${id}Distribution`, 'AWS::CloudFront::Distribution', {
    DistributionConfig: {
      Enabled: true,
      IPV6Enabled: true,
      HttpVersion: 'http2and3',
      Comment: `${a.app.name} static site`,
      DefaultRootObject: 'index.html',
      PriceClass: setting(c, 'price_class', 'PriceClass_100'),
      ...(aliases.length > 0 ? { Aliases: aliases } : {}),
      Origins: [{ Id: 's3', DomainName: GetAtt(id, 'RegionalDomainName'), OriginAccessControlId: GetAtt(`${id}Oac`, 'Id'), S3OriginConfig: { OriginAccessIdentity: '' } }],
      DefaultCacheBehavior: {
        TargetOriginId: 's3',
        ViewerProtocolPolicy: 'redirect-to-https',
        AllowedMethods: ['GET', 'HEAD', 'OPTIONS'],
        CachedMethods: ['GET', 'HEAD'],
        Compress: true,
        // The managed CachingOptimized and SecurityHeadersPolicy policies.
        CachePolicyId: '658327ea-f89d-4fab-a63d-7e88639e58f6',
        ResponseHeadersPolicyId: '67f7725c-6f97-4210-82d7-5512b31e9d03',
      },
      CustomErrorResponses: [{ ErrorCode: 404, ResponseCode: 404, ResponsePagePath: '/404.html', ErrorCachingMinTTL: 60 }],
      ViewerCertificate: aliases.length > 0 ? { AcmCertificateArn: cert, SslSupportMethod: 'sni-only', MinimumProtocolVersion: 'TLSv1.2_2021' } : { CloudFrontDefaultCertificate: true },
    },
  }, tags);
  t.add(`${id}Policy`, 'AWS::S3::BucketPolicy', {
    Bucket: Ref(id),
    PolicyDocument: {
      Version: '2012-10-17',
      Statement: [{
        Sid: 'CloudFrontRead',
        Effect: 'Allow',
        Principal: { Service: 'cloudfront.amazonaws.com' },
        Action: 's3:GetObject',
        Resource: Sub(`\${${id}.Arn}/*`),
        Condition: { StringEquals: { 'AWS:SourceArn': Sub(`arn:\${AWS::Partition}:cloudfront::\${AWS::AccountId}:distribution/\${${id}Distribution}`) } },
      }],
    },
  });
  t.output(`${id}Bucket`, Ref(id), `${a.app.name}: where the pipeline syncs the site`);
  t.output(`${id}Domain`, GetAtt(`${id}Distribution`, 'DomainName'), `${a.app.name}: the CloudFront name`);
}

function objectStorage(b: Build, a: AppHere, c: AppComponentLike): void {
  const { t } = b;
  const id = `Bucket${pascal(a.app.name, c.name)}`;
  t.add(id, 'AWS::S3::Bucket', {
    VersioningConfiguration: { Status: 'Enabled' },
    BucketEncryption: {
      ServerSideEncryptionConfiguration: [
        b.cmk
          ? { BucketKeyEnabled: true, ServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: GetAtt('LandingZoneKey', 'Arn') } }
          : { BucketKeyEnabled: true, ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
      ],
    },
    PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
  }, appTags(b, a, c.id), { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
  t.add(`${id}Policy`, 'AWS::S3::BucketPolicy', {
    Bucket: Ref(id),
    PolicyDocument: {
      Version: '2012-10-17',
      Statement: [{ Sid: 'DenyInsecureTransport', Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: [GetAtt(id, 'Arn'), Sub(`\${${id}.Arn}/*`)], Condition: { Bool: { 'aws:SecureTransport': 'false' } } }],
    },
  });
  t.output(`${id}Name`, Ref(id), `${a.app.name} ${c.name}: the bucket`);
}

interface Member { readonly server: string; readonly address: string; readonly port: number }

function members(text: string, port: number): Member[] {
  return text.split('\n').map((l) => l.split('|').map((x) => x.trim())).filter((r) => r[0] && r[1]).map((r) => ({
    server: r[0] as string,
    address: (r[1] as string).replace(/^\[|\]$/g, ''),
    port: Number(r[2]) > 0 && Number(r[2]) < 65536 ? Number(r[2]) : port,
  }));
}

function ingress(b: Build, a: AppHere, c: AppComponentLike): void {
  const { t, prefix } = b;
  const net = b.nets.get(setting(c, 'network', 'prod')) ?? [...b.nets.values()][0];
  const tier = setting(c, 'tier', 'web');
  const subnets = net?.subnets.get(tier) ?? [];
  if (!net || subnets.length < 2) {
    terraformOnly(b.ctx, `${a.app.name} ${c.name} (load balancer)`, `a load balancer needs the ${tier} tier in two zones.`);
    return;
  }
  const l7 = setting(c, 'lb', 'l7') !== 'l4';
  const internal = setting(c, 'exposure', 'internal') !== 'public';
  const terminate = setting(c, 'tls', 'terminate') === 'terminate';
  const waf = /^(y|yes|true)$/i.test(setting(c, 'waf', 'no')) && l7;
  const listenerPort = Number(setting(c, 'listener_port', '443')) || 443;
  const backendPort = Number(setting(c, 'backend_port', '443')) || 443;
  const bp = setting(c, 'backend_protocol', 'https');
  const id = `Lb${pascal(a.app.name, c.name)}`;
  const tags = appTags(b, a, c.id);
  const ms = members(setting(c, 'members', ''), backendPort);
  const allV6 = ms.length > 0 && ms.every((m) => isV6(m.address));
  if (!internal) {
    terraformOnly(b.ctx, `${a.app.name} ${c.name} (internet-facing load balancer)`, 'the landing zone has no internet gateway (Session Manager and endpoints only), so an internet-facing load balancer would have no route; the Terraform stack writes it as designed.');
    return;
  }
  const group = `${a.app.name} ${c.name}`;
  if (terminate) t.param(`${id}CertificateArn`, { Type: 'String', AllowedPattern: '^arn:aws[a-z-]*:acm:.+', Description: `The ACM certificate ARN for ${a.app.name}'s ingress (a reference to the certificate, not the key).` }, group);
  t.add(`${id}Sg`, 'AWS::EC2::SecurityGroup', {
    GroupDescription: `Ingress of ${a.app.name}`,
    VpcId: Ref(net.vpc),
    SecurityGroupIngress: [
      { IpProtocol: 'tcp', FromPort: listenerPort, ToPort: listenerPort, CidrIp: net.net.cidr, Description: 'The listener' },
      ...(net.v6 ? [{ IpProtocol: 'tcp', FromPort: listenerPort, ToPort: listenerPort, CidrIpv6: Select(0, GetAtt(net.vpc, 'Ipv6CidrBlocks')), Description: 'The listener, IPv6' }] : []),
    ],
    SecurityGroupEgress: [{ IpProtocol: 'tcp', FromPort: 0, ToPort: 65535, CidrIp: net.net.cidr, Description: 'To the members and their health checks' }],
  }, tags, net.v6 ? { DependsOn: [net.v6] } : {});
  t.add(id, 'AWS::ElasticLoadBalancingV2::LoadBalancer', {
    Name: `${prefix}-${slugName(a.app.name)}`.slice(0, 32).replace(/-+$/, ''),
    Type: l7 ? 'application' : 'network',
    Scheme: 'internal',
    IpAddressType: net.v6 ? 'dualstack' : 'ipv4',
    Subnets: subnets.map(Ref),
    SecurityGroups: [Ref(`${id}Sg`)],
    LoadBalancerAttributes: [
      { Key: 'deletion_protection.enabled', Value: a.app.criticality === 'tier0' || a.app.criticality === 'tier1' ? 'true' : 'false' },
      ...(l7 ? [{ Key: 'routing.http.drop_invalid_header_fields.enabled', Value: 'true' }] : [{ Key: 'load_balancing.cross_zone.enabled', Value: 'true' }]),
    ],
  }, tags);
  const tgProtocol = l7 ? (bp === 'http' ? 'HTTP' : 'HTTPS') : 'TCP';
  t.add(`${id}Targets`, 'AWS::ElasticLoadBalancingV2::TargetGroup', {
    Port: backendPort,
    Protocol: tgProtocol,
    TargetType: 'ip',
    IpAddressType: allV6 ? 'ipv6' : 'ipv4',
    VpcId: Ref(net.vpc),
    HealthCheckEnabled: true,
    HealthCheckProtocol: l7 ? tgProtocol : bp === 'tcp' ? 'TCP' : bp.toUpperCase(),
    ...(l7 || bp !== 'tcp' ? { HealthCheckPath: setting(c, 'health_path', '/') } : {}),
    ...(l7 ? { Matcher: { HttpCode: '200-399' } } : {}),
    HealthyThresholdCount: 3,
    UnhealthyThresholdCount: 3,
    HealthCheckIntervalSeconds: 15,
    Targets: ms.filter((m) => isV6(m.address) === allV6).map((m) => ({ Id: m.address, Port: m.port })),
  }, tags);
  t.add(`${id}Listener`, 'AWS::ElasticLoadBalancingV2::Listener', {
    LoadBalancerArn: Ref(id),
    Port: listenerPort,
    Protocol: l7 ? (terminate ? 'HTTPS' : 'HTTP') : terminate ? 'TLS' : 'TCP',
    ...(terminate ? { SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06', Certificates: [{ CertificateArn: Ref(`${id}CertificateArn`) }] } : {}),
    DefaultActions: [{ Type: 'forward', TargetGroupArn: Ref(`${id}Targets`) }],
  }, tags);
  if (waf) {
    t.add(`${id}Waf`, 'AWS::WAFv2::WebACL', {
      Name: `${prefix}-${slugName(a.app.name)}`,
      Scope: 'REGIONAL',
      DefaultAction: { Allow: {} },
      VisibilityConfig: { SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: `${pascal(prefix, a.app.name)}Waf` },
      Rules: [{
        Name: 'aws-common',
        Priority: 0,
        OverrideAction: { None: {} },
        Statement: { ManagedRuleGroupStatement: { VendorName: 'AWS', Name: 'AWSManagedRulesCommonRuleSet' } },
        VisibilityConfig: { SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: 'aws-common' },
      }],
    }, tags);
    t.add(`${id}WafAssociation`, 'AWS::WAFv2::WebACLAssociation', { ResourceArn: Ref(id), WebACLArn: GetAtt(`${id}Waf`, 'Arn') });
  }
  t.output(`${id}Dns`, GetAtt(id, 'DNSName'), `${a.app.name}: the load balancer's name`);
}

const PATTERN_REASONS: Readonly<Record<string, string>> = {
  'paas-web': 'Elastic Beanstalk needs the exact current platform (solution stack) name, which the Terraform blueprint looks up when it plans; CloudFormation has no lookup for it.',
  containers: 'an EKS cluster with its node groups, add-ons and access entries is built by the Terraform containers blueprint (and its Kubernetes manifests); it has no single native template here.',
  'managed-cache': 'the cache is built by the Terraform managed-cache pattern item.',
  'managed-messaging': 'the broker is built by the Terraform managed-messaging pattern item.',
  'managed-kafka': 'the MSK cluster is built by the Terraform managed-kafka pattern item.',
  'managed-search': 'the search domain is built by the Terraform managed-search pattern item.',
  'file-service': 'the file service (FSx) needs the directory it joins, which the Terraform file-service pattern item wires to the identity item.',
  'vdi-service': 'WorkSpaces directories and bundles are built by the Terraform VDI pattern item.',
  'sap-certified': 'SAP systems are built by the Terraform SAP pattern item with their launch wizard inputs.',
  appliance: 'marketplace appliances need their subscription accepted and their vendor bootstrap, which the Terraform appliance item carries.',
  batch: 'AWS Batch compute environments and queues are built by the Terraform batch pattern item.',
  workflow: 'Step Functions state machines need the workflow definition, which the pipeline owns.',
};

function appItems(b: Build): void {
  const { ctx } = b;
  const order = (c: AppComponentLike): number => (c.tierPattern === 'api-gateway' ? 1 : 0);
  for (const a of ctx.apps) {
    for (const c of [...a.components].sort((x, y) => order(x) - order(y))) {
      if (c.kind === 'resource') {
        terraformOnly(ctx, `${a.app.name} ${c.name} (${c.blueprintId ?? 'resource'})`, 'a resource component is a Terraform page blueprint with its own inputs; it has no native template here.');
        continue;
      }
      if (c.kind !== 'pattern') continue;
      const bp = c.settings?.blueprint?.trim() ?? '';
      if (/_app_ingress$/.test(bp)) {
        ingress(b, a, c);
        continue;
      }
      switch (c.tierPattern) {
        case undefined: case 'vm': case 'managed-db': case 'vmware-service': case 'retire': case 'retain': case 'saas': case 'specialist':
          break;
        case 'serverless': serverless(b, a, c); break;
        case 'api-gateway': apiGateway(b, a, c); break;
        case 'static-site': staticSite(b, a, c); break;
        case 'object-storage': objectStorage(b, a, c); break;
        default:
          terraformOnly(ctx, `${a.app.name} ${c.name} (${c.tierPattern})`, PATTERN_REASONS[c.tierPattern] ?? 'no clean CloudFormation equivalent here.');
      }
    }
  }
}

function appMonitoring(b: Build): void {
  const { ctx, t, prefix } = b;
  for (const a of ctx.apps) {
    const vms = [...b.instances.entries()].filter(([name]) => [...ctx.workloadById.values()].some((w) => w.name === name && w.app === a.app.name));
    const dbs = [...b.dbInstances.entries()].filter(([name]) => ctx.plan.databases.some((d) => d.name === name && d.app === a.app.name));
    const fns = [...b.functions.entries()].filter(([k]) => k.startsWith(`${a.app.name}/`));
    if (vms.length + dbs.length + fns.length === 0) continue;
    const A = pascal(a.app.name);
    const tags = appTags(b, a);
    const th = THRESHOLDS[a.app.criticality] ?? THRESHOLDS.tier2;
    const topic = t.add(`Alerts${A}`, 'AWS::SNS::Topic', { TopicName: `${prefix}-${slugName(a.app.name)}-alerts`, KmsMasterKeyId: 'alias/aws/sns' }, tags);
    const period = th.periodMin * 60;
    const alarm = (id: string, o: Obj): void => {
      t.add(id, 'AWS::CloudWatch::Alarm', {
        ActionsEnabled: true,
        AlarmActions: [Ref(topic)],
        OKActions: [Ref(topic)],
        EvaluationPeriods: 3,
        ComparisonOperator: 'GreaterThanThreshold',
        TreatMissingData: 'missing',
        Period: period,
        Statistic: 'Average',
        ...o,
      }, tags);
    };
    for (const [name, id] of vms) {
      alarm(`${id}CpuAlarm`, { AlarmName: `${prefix}-${slugName(a.app.name)}-${kebab(name)}-cpu`, Namespace: 'AWS/EC2', MetricName: 'CPUUtilization', Dimensions: [{ Name: 'InstanceId', Value: Ref(id) }], Threshold: th.cpu });
      alarm(`${id}MemoryAlarm`, { AlarmName: `${prefix}-${slugName(a.app.name)}-${kebab(name)}-memory`, Namespace: 'CWAgent', MetricName: 'mem_used_percent', Dimensions: [{ Name: 'InstanceId', Value: Ref(id) }], Threshold: th.memory });
      alarm(`${id}StatusAlarm`, { AlarmName: `${prefix}-${slugName(a.app.name)}-${kebab(name)}-status`, Namespace: 'AWS/EC2', MetricName: 'StatusCheckFailed', Dimensions: [{ Name: 'InstanceId', Value: Ref(id) }], Statistic: 'Maximum', Period: 60, EvaluationPeriods: 2, Threshold: 0, TreatMissingData: 'breaching' });
    }
    for (const [name, id] of dbs) {
      alarm(`${id}CpuAlarm`, { AlarmName: `${prefix}-${slugName(a.app.name)}-${kebab(name)}-db-cpu`, Namespace: 'AWS/RDS', MetricName: 'CPUUtilization', Dimensions: [{ Name: 'DBInstanceIdentifier', Value: Ref(id) }], Threshold: th.cpu });
    }
    for (const [, id] of fns) {
      alarm(`${id}ErrorsAlarm`, { AlarmName: Sub(`\${${id}}-errors`), Namespace: 'AWS/Lambda', MetricName: 'Errors', Dimensions: [{ Name: 'FunctionName', Value: Ref(id) }], Statistic: 'Sum', Threshold: th.http5xx, EvaluationPeriods: 1 });
    }
    if (vms.length > 0) {
      const body = {
        widgets: [
          { type: 'metric', x: 0, y: 0, width: 12, height: 6, properties: { title: 'CPU', region: '${AWS::Region}', stat: 'Average', period: 300, metrics: vms.map(([name, id]) => ['AWS/EC2', 'CPUUtilization', 'InstanceId', `\${${id}}`, { label: name }]) } },
          { type: 'metric', x: 12, y: 0, width: 12, height: 6, properties: { title: 'Memory', region: '${AWS::Region}', stat: 'Average', period: 300, metrics: vms.map(([name, id]) => ['CWAgent', 'mem_used_percent', 'InstanceId', `\${${id}}`, { label: name }]) } },
        ],
      };
      t.add(`Dashboard${A}`, 'AWS::CloudWatch::Dashboard', { DashboardName: `${prefix}-${slugName(a.app.name)}`, DashboardBody: Sub(JSON.stringify(body)) }, tags);
    }
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function templateDoc(t: Template, description: string): Obj {
  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: description,
    ...(t.groups.length > 0
      ? { Metadata: { 'AWS::CloudFormation::Interface': { ParameterGroups: t.groups.map((g) => ({ Label: { default: g.label }, Parameters: g.params })) } } }
      : {}),
    ...(Object.keys(t.parameters).length > 0 ? { Parameters: t.parameters } : {}),
    ...(Object.keys(t.conditions).length > 0 ? { Conditions: t.conditions } : {}),
    Resources: t.resources as unknown as Obj,
    ...(Object.keys(t.outputs).length > 0 ? { Outputs: t.outputs } : {}),
  };
}

function renderTemplate(t: Template, description: string): string {
  return `${renderYaml(templateDoc(t, description) as YamlValue)}\n`.replace(/\n+$/, '\n');
}

/** The CloudFormation template of the AWS design as a plain object (for the tests' schema checks). */
export function cloudFormationTemplate(plan: Plan, decision: PlanDecision, design: TargetDesign, options: NativeOptions = {}): { stack: string; template: Obj; findings: Finding[] } | null {
  const built = build(plan, decision, design, options);
  if (!built) return null;
  return { stack: built.stack, template: built.doc, findings: built.findings };
}

interface Built {
  readonly stack: string;
  readonly doc: Obj;
  readonly yaml: string;
  readonly params: Record<string, string>;
  readonly required: string[];
  readonly drVault?: string;
  readonly ctx: NativeCtx;
  readonly findings: Finding[];
  readonly capabilities: string;
}

function stackNameOf(plan: Plan, ctx: NativeCtx, options: NativeOptions): string {
  const base = ctx.pd.prefix;
  const scope = options.scope ?? 'estate';
  const env = options.environment ? `-${options.environment}` : '';
  if (scope === 'landing-zone') return `${base}-landing-zone`;
  if (scope === 'apps') {
    const names = (options.apps ?? []).map((a) => plan.apps.find((x) => x.id === a || x.name === a)?.name ?? a).map(slugName);
    return `${base}-${names.length > 0 && names.length <= 2 ? names.join('-') : 'apps'}${env}`.slice(0, 128);
  }
  return `${base}${env}`;
}

function build(plan: Plan, decision: PlanDecision, design: TargetDesign, options: NativeOptions): Built | null {
  const pd = design.platforms.find((p) => p.platform === 'aws');
  if (!pd || builtIn(pd.networks, pd.region).length === 0) return null;
  const ctx = nativeContext(plan, decision, design, pd, options);
  if (!ctx) return null;
  const t = new Template();
  t.param(OWNER, { Type: 'String', Default: 'unassigned', Description: 'The atk_owner tag of what has no app owner in the plan (the landing zone, shared items).' }, 'Tags');
  const b = makeBuild(ctx, t);
  for (const n of builtIn(pd.networks, pd.region)) network(b, n);
  // An existing landing zone: each new VPC attaches to its Transit Gateway (the hub's id); no hub is built.
  for (const hub of pd.networks.filter((n) => n.existingId && n.role === 'hub')) {
    for (const n of b.nets.values()) {
      t.add(`TransitGatewayAttachment${pascal(n.net.name)}To${pascal(hub.name)}`, 'AWS::EC2::TransitGatewayVpcAttachment', {
        TransitGatewayId: hub.existingId,
        VpcId: Ref(n.vpc),
        SubnetIds: onePerZone(n.subnets, n.zoneOf, 'tgw-attachment').map(Ref),
        Options: { Ipv6Support: n.v6 ? 'enable' : 'disable', DnsSupport: 'enable' },
      }, { ...b.tags(), ...nameTag(`${b.prefix}-${n.net.name}-to-${hub.name}`) });
    }
  }
  keysAndLogs(b);
  if (ctx.scope !== 'apps') {
    identity(b);
    connectivity(b);
    terraformOnly(ctx, 'Governance (AWS Config recorder and rules, the budget)', 'the Config recorder and delivery channel are one per account and region, and a budget is account-wide; creating them in a workload stack fails where the account baseline already has them. The Terraform governance item builds them for the account.');
  }
  compute(b);
  databases(b);
  appItems(b);
  const dr = backup(b);
  monitoring(b);
  appMonitoring(b);
  if (pd.relocate && pd.relocate.nodes > 0 && ctx.scope !== 'apps') {
    terraformOnly(ctx, `${pd.relocate.service} (relocation)`, 'Amazon Elastic VMware Service is built from its runbook (Terraform has no resource for it either), then HCX moves the relocating VMs.');
  }
  const migrating = ctx.replicated.length > 0 || ctx.databases.some((d) => !isIaasService(d.service) && decision.items[d.database]?.method === 'managed-db' && decision.items[d.database]?.disposition !== 'new');
  if (migrating) {
    terraformOnly(ctx, 'Replication (Application Migration Service, DMS)', 'the replication settings are applied per source server as it is added to Application Migration Service, and DMS endpoints need the source database\'s credentials at create; the Terraform replication item and the execution kit carry them.');
  }
  // Landing-zone outputs, exported for other stacks.
  for (const n of b.nets.values()) {
    const N = pascal(n.net.name);
    t.output(`Vpc${N}Id`, Ref(n.vpc), `The ${n.net.name} VPC`, `vpc-${n.net.name}`);
    for (const [tier, ids] of n.subnets) t.output(`Subnets${N}${pascal(tier)}`, Sub(ids.map((x) => `\${${x}}`).join(',')), `The ${tier} subnets of ${n.net.name}`, `subnets-${n.net.name}-${tier}`);
    for (const [tier, id] of n.sgs) t.output(`${id}Id`, GetAtt(id, 'GroupId'), `The ${tier} security group of ${n.net.name}`, `sg-${n.net.name}-${tier}`);
  }
  if (b.cmk) t.output('LandingZoneKeyArn', GetAtt('LandingZoneKey', 'Arn'), 'The landing-zone KMS key', 'kms-key');
  t.output('InstanceProfileName', Ref('InstanceProfile'), 'The instance profile every VM uses', 'instance-profile');
  t.output('LogBucketName', Ref('LogBucket'), 'The log bucket (CloudTrail, flow logs)', 'log-bucket');

  const stack = stackNameOf(plan, ctx, options);
  const scopeLabel = ctx.scope === 'estate' ? 'the estate' : ctx.scope === 'landing-zone' ? 'the landing zone' : 'the selected apps';
  const description = `${plan.name}: AWS, ${scopeLabel} (${pd.prefix} in ${pd.region})`;
  const doc = templateDoc(t, description);
  const yaml = renderTemplate(t, description);
  const params: Record<string, string> = {};
  const required: string[] = [];
  for (const [id, p] of Object.entries(t.parameters)) {
    if (p.Default !== undefined) params[id] = String(p.Default);
    else required.push(id);
  }
  const named = Object.values(t.resources).some((r) => r.Type === 'AWS::IAM::Role' && r.Properties.RoleName !== undefined);
  return {
    stack, doc, yaml, params, required, ...(dr.drVault ? { drVault: dr.drVault } : {}), ctx, findings: ctx.findings,
    capabilities: named ? 'CAPABILITY_NAMED_IAM' : 'CAPABILITY_IAM',
  };
}

/** The largest template `aws cloudformation deploy` sends inline; larger ones go through S3. */
const INLINE_LIMIT = 51_200;

function readme(built: Built): string {
  const { stack, ctx } = built;
  const pd = ctx.pd;
  const big = built.yaml.length > INLINE_LIMIT;
  const types = new Map<string, number>();
  for (const r of Object.values(built.doc.Resources as unknown as Record<string, CfnResource>)) types.set(r.Type, (types.get(r.Type) ?? 0) + 1);
  const overrides = built.required.length > 0 ? ` \\\n    ${built.required.map((p) => `${p}=<value>`).join(' ')}` : '';
  const lines = [
    `# ${ctx.plan.name}: AWS CloudFormation`,
    '',
    `The ${ctx.scope === 'estate' ? 'estate' : ctx.scope === 'landing-zone' ? 'landing zone' : 'selected apps'} on AWS (${pd.prefix} in ${pd.region}) as one CloudFormation stack, built from the same design as the Terraform stack in \`terraform/aws/\`. Deploy one or the other, not both.`,
    '',
    '## Files',
    '',
    `- \`${stack}.yaml\`: the template (${Object.keys(built.doc.Resources as object).length} resources).`,
    `- \`${stack}.parameters.json\`: the parameter values with defaults, for \`--parameter-overrides file://\` (AWS CLI v2).`,
    ...(built.drVault ? [`- \`${stack}-dr-vault.yaml\`: the backup vault in ${pd.drRegion} that the tiers copy to; deploy it first, in that region.`] : []),
    '',
    '## Deploy',
    '',
    'Sign in first (`aws sso login`, a profile, or the AWS_* environment variables).',
    '',
    ...(built.drVault
      ? ['```sh', `aws cloudformation deploy --region ${pd.drRegion} --stack-name ${stack}-dr-vault --template-file ${stack}-dr-vault.yaml`, '```', '']
      : []),
    '```sh',
    `aws cloudformation deploy --region ${pd.region} \\`,
    `  --stack-name ${stack} \\`,
    `  --template-file ${stack}.yaml \\`,
    ...(big ? ['  --s3-bucket <a bucket for the template> \\'] : []),
    `  --capabilities ${built.capabilities} \\`,
    `  --parameter-overrides file://${stack}.parameters.json${overrides}`,
    '```',
    '',
    ...(big ? [`The template is larger than ${INLINE_LIMIT.toLocaleString('en-US')} bytes, the most CloudFormation takes inline, so the CLI uploads it through an S3 bucket (\`--s3-bucket\`); the console does the same when you upload the file.`, ''] : []),
    `In the console: CloudFormation → Create stack → With new resources → Upload a template file → \`${stack}.yaml\`, then acknowledge that it creates IAM resources.`,
    '',
    ...(built.required.length > 0
      ? ['Parameters without a default, to give at deploy:', '', ...built.required.map((p) => `- \`${p}\`: ${String((built.doc.Parameters as Record<string, Obj>)[p]?.Description ?? '')}`), '']
      : []),
    '## Credentials',
    '',
    [
      'None are in these files.',
      ...(types.has('AWS::RDS::DBInstance') ? ['RDS keeps each master password in Secrets Manager (the `…Secret` outputs).'] : []),
      ...(types.has('AWS::EC2::VPNConnection') ? ['The VPN service generates each tunnel\'s pre-shared key into Secrets Manager; read it there for the on-premises peer.'] : []),
      ...(types.has('AWS::DirectoryService::MicrosoftAD') ? ['The Managed Microsoft AD password is generated into a secret and read by a dynamic reference.'] : []),
    ].join(' '),
    '',
    '## What is in it',
    '',
    ...[...types.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([type, n]) => `- ${type}: ${n}`),
    '',
    ...(ctx.replicated.length > 0
      ? ['## Replicated VMs', '', `Application Migration Service launches ${ctx.replicated.map((vm) => vmName(ctx, vm)).join(', ')} at cutover; they are not in the template. Tag them as the plan says (atk_* tags) so backup and the Ansible inventory find them.`, '']
      : []),
    ...terraformOnlySection(ctx.terraformOnly),
  ];
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

/**
 * AWS CloudFormation for the AWS part of a design: `aws-cloudformation/`
 * with the template, its parameters, the DR vault template (when copies go to
 * a DR region) and a README with the exact deploy command.
 */
export function cloudFormationFiles(plan: Plan, decision: PlanDecision, design: TargetDesign, options: NativeOptions = {}): NativeFiles {
  const aws = design.platforms.find((p) => p.platform === 'aws');
  if (aws && builtIn(aws.networks, aws.region).length === 0) return { files: {}, findings: [noNetworkFinding('aws')] };
  const built = build(plan, decision, design, options);
  if (!built) {
    return { files: {}, findings: [info('plan.native.cfn-nothing', 'Nothing in this plan (or the selected apps) is placed on AWS, so there is no CloudFormation template.')] };
  }
  const dir = 'aws-cloudformation';
  const files: Record<string, string> = {
    [`${dir}/${built.stack}.yaml`]: built.yaml,
    [`${dir}/${built.stack}.parameters.json`]: `${JSON.stringify({ Parameters: built.params }, null, 2)}\n`,
    [`${dir}/README.md`]: readme(built),
  };
  if (built.drVault) files[`${dir}/${built.stack}-dr-vault.yaml`] = built.drVault;
  return { files, findings: built.findings.map((f) => ({ ...f, path: f.path ?? dir })) };
}

/** Exposed for the tests: the stack name the files are written under. */
export const cfnStackName = (plan: Plan, decision: PlanDecision, design: TargetDesign, options: NativeOptions = {}): string | undefined => build(plan, decision, design, options)?.stack;
