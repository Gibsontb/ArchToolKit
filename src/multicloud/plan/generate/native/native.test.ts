import { before, describe, it } from 'node:test';
import { expect } from '../../../../testing/expect.ts';
import { buildE2e, ENGINE, SAVED_AT, type E2e } from '../../../../testing/multicloud-e2e.ts';
import { readYaml } from '../../../../core/yaml-read.ts';
import type { Json } from '../../../../editor/doc.ts';
import { armType, armTypeSchema, shapeOf } from '../../../../editor/arm-schema.ts';
import { cfnTypeSchema, isKnownCfnType } from '../../../../editor/cloudformation-schema.ts';
import { awsCloudFormation } from '../../../../editor/profiles/aws.ts';
import { azureArm } from '../../../../editor/profiles/azure.ts';
import { newApplication, withoutServiceSynthetics } from '../../apps/components.ts';
import { chooseAppPlatform, decideApps, recommendApps, recommendationDecision, saveAppPlans } from '../../apps/recommend.ts';
import { designPlan } from '../../design/index.ts';
import { withPatternMappers } from '../../patterns/index.ts';
import type { AppPattern, Plan, PlanDecision, Platform, TargetDesign } from '../../types.ts';
import { AZURE_API, bicepFiles, bicepResourceTypes } from './bicep.ts';
import { CFN_TAGGED_TYPES, cloudFormationFiles, cloudFormationTemplate } from './cloudformation.ts';
import type { NativeOptions } from './common.ts';

// ---------------------------------------------------------------------------
// The scenario: the WP-10 e2e plan, plus new services on AWS and Azure, and
// some VMs rebuilt from images so the compute path is exercised on both.
// ---------------------------------------------------------------------------

interface Scenario {
  readonly e2e: E2e;
  readonly plan: Plan;
  readonly decision: PlanDecision;
  readonly design: TargetDesign;
  /** The design with VMs rebuilt from images on AWS and Azure. */
  readonly rebuilt: TargetDesign;
  readonly ids: Readonly<Record<string, string>>;
}

let s: Scenario;

async function scenario(): Promise<Scenario> {
  const e2e = await buildE2e();
  let plan = e2e.plan;
  const ids: Record<string, string> = {};
  const add = (name: string, pattern: AppPattern, platform: Platform): void => {
    const a = newApplication(plan, { name, pattern, owner: 'web-team', load: { environments: ['prod'], nonprodPct: 25, peakRps: 200, dataGib: 40, tps: 50, slo: '99.9' } });
    plan = chooseAppPlatform(a.plan, a.app.id, platform).plan;
    ids[name] = a.app.id;
  };
  add('Web Shop', 'web-app', 'azure');
  add('Events', 'event-driven', 'azure');
  add('Brochure', 'static-site', 'aws');
  add('Pipeline', 'batch-pipeline', 'aws');
  plan = saveAppPlans(plan, Object.values(ids), recommendApps(plan, recommendationDecision(plan, ENGINE)), SAVED_AT);
  const decision = decideApps(plan, ENGINE);
  const design = withoutServiceSynthetics(plan, designPlan(plan, decision, withPatternMappers()));
  plan = { ...plan, decision };
  const rebuilt: TargetDesign = {
    ...design,
    platforms: design.platforms.map((pd) => ({
      ...pd,
      compute: pd.compute.map((c, i) => {
        if (pd.platform === 'aws' && i < 3) {
          const image = i === 0
            ? { kind: 'aws-ssm' as const, parameter: '/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id' }
            : i === 1 ? { kind: 'aws-ami-filter' as const, owner: '309956199498', namePattern: 'RHEL-9.*_HVM-*-x86_64-*' }
              : { kind: 'aws-ssm' as const, parameter: '/aws/service/ami-windows-latest/Windows_Server-2022-English-Full-Base' };
          return { ...c, method: 'rebuild' as const, image, disks: [...c.disks, { gib: 200, type: 'io2' }] };
        }
        if (pd.platform === 'azure' && i < 2) return { ...c, method: 'rebuild' as const, image: { kind: 'azure-marketplace' as const, publisher: 'Canonical', offer: 'ubuntu-24_04-lts', sku: 'server' } };
        return c;
      }),
    })),
  };
  return { e2e, plan, decision, design, rebuilt, ids };
}

before(async () => {
  s = await scenario();
});

// ---------------------------------------------------------------------------
// Checks shared by every case
// ---------------------------------------------------------------------------

type Obj = Record<string, Json>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function cfnDoc(files: Readonly<Record<string, string>>): { path: string; doc: Obj } {
  const path = Object.keys(files).find((p) => /^aws-cloudformation\/[^/]+\.yaml$/.test(p) && !p.endsWith('-dr-vault.yaml'));
  expect(path).toBeDefined();
  const doc = readYaml(files[path as string] as string).documents[0];
  if (!isObj(doc)) throw new Error('not a template');
  return { path: path as string, doc };
}

/** Everything a generated file must never carry. */
function noFootprints(files: Readonly<Record<string, string>>): void {
  for (const [p, text] of Object.entries(files)) {
    // A generator's name or version, a timestamp as a clock writes it, a user's or a machine's path.
    expect([p, /generated (by|with|on)|_generator|templateHash|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z|[A-Z]:\\Users|\/Users\/|\/home\/[a-z]+\/(?!\.ssh)/i.test(text)]).toEqual([p, false]);
  }
}

function cfnChecks(files: Readonly<Record<string, string>>): Obj {
  const { doc } = cfnDoc(files);
  // The Data Editor's CloudFormation profile: sections, every resource type and property against the registry schemas.
  const found = awsCloudFormation.validate?.(doc as Json) ?? [];
  expect(found.filter((f) => f.severity !== 'info').map((f) => `${f.path}: ${f.message}`)).toEqual([]);
  const resources = doc.Resources as Record<string, Obj>;
  for (const [id, r] of Object.entries(resources)) {
    const type = r.Type as string;
    expect([id, isKnownCfnType(type)]).toEqual([id, true]);
    const schema = cfnTypeSchema(type);
    const props = (r.Properties ?? {}) as Obj;
    // Tags on everything that takes them: the plan, the app, the environment and the owner.
    const tagKey = ['Tags', 'BackupVaultTags', 'BackupPlanTags', 'TagSpecifications'].find((k) => schema?.p[k] !== undefined);
    if (tagKey && CFN_TAGGED_TYPES.includes(type)) {
      const raw = props[tagKey];
      const tags = Array.isArray(raw)
        ? Object.fromEntries((tagKey === 'TagSpecifications' ? ((raw[0] as Obj).Tags as Obj[]) : (raw as Obj[])).map((t) => [t.Key as string, t.Value]))
        : (raw as Obj);
      for (const k of ['atk_plan', 'atk_app', 'atk_env', 'atk_owner']) expect([id, k, tags?.[k] !== undefined]).toEqual([id, k, true]);
    } else if (tagKey && tagKey !== 'TagSpecifications') {
      // A type that takes tags but is not in the generator's table would go untagged.
      expect([id, type, 'takes tags']).toEqual([id, type, 'is untagged']);
    }
  }
  // No credential in a parameter default, and none written as a literal.
  for (const [name, p] of Object.entries((doc.Parameters ?? {}) as Record<string, Obj>)) {
    if (/password|secret|psk|key$/i.test(name) && !/KeyArn|Key$/.test(name)) expect([name, p.Default]).toEqual([name, undefined]);
  }
  const text = JSON.stringify(doc);
  expect(/"(Password|MasterUserPassword|PreSharedKey)":"[^{]/.test(text)).toBe(false);
  return doc;
}

interface ArmTemplate { readonly parameters?: Record<string, Obj>; readonly resources: Obj[] }

/** Findings of the Data Editor's ARM profile the templates are known to trip over, not faults in them. */
function armFinding(message: string, code: string): boolean {
  // Discriminated unions (backup policies by backupManagementType, alert criteria by odata.type) are not unfolded by the profile.
  if (code === 'arm.property.unknown' && /backupPolicies/.test(message)) return false;
  if (code === 'arm.property.enum' && /odata\.type/.test(message)) return false;
  // Diagnostic settings' category groups need 2021-05-01-preview: there is no stable version with them.
  if (code === 'arm.resource.preview' && /diagnosticSettings/.test(message)) return false;
  return code !== 'arm.resource.apiVersion-old';
}

function armChecks(files: Readonly<Record<string, string>>): { main: ArmTemplate; nested: Map<string, ArmTemplate> } {
  const main = JSON.parse(files['azure-bicep/azuredeploy.json'] as string) as ArmTemplate & Obj;
  const nested = new Map<string, ArmTemplate>();
  for (const r of main.resources) {
    expect(r.type).toBe('Microsoft.Resources/deployments');
    const t = (r.properties as Obj).template as unknown as ArmTemplate;
    nested.set(r.name as string, t);
  }
  // The outer template, its nested deployments' templates left out (their expressions are in their own scope) …
  const outer = { ...main, resources: main.resources.map((r) => ({ ...r, properties: { ...(r.properties as Obj), template: { $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#', contentVersion: '1.0.0.0', resources: [] } } })) };
  const found = [...(azureArm.validate?.(outer as unknown as Json) ?? [])];
  // … and each nested template on its own.
  for (const [name, t] of nested) found.push(...(azureArm.validate?.(t as unknown as Json) ?? []).map((f) => ({ ...f, message: `${name}: ${f.message}` })));
  expect(found.filter((f) => f.severity !== 'info' && armFinding(f.message, f.code)).map((f) => `${f.path}: ${f.message}`)).toEqual([]);
  // Every resource is a type and API version the ARM schemas know, and carries the tags where it takes them.
  for (const [name, t] of nested) {
    for (const r of t.resources) {
      const info = armType(r.type as string);
      expect([name, r.type, !!info && info.versions.includes(r.apiVersion as string)]).toEqual([name, r.type, true]);
      const schema = armTypeSchema(r.type as string);
      // (Diagnostic settings: the schema is 2016-09-01's; the 2021-05-01-preview proxy resource takes no tags.)
      const takesTags = !!schema && r.type !== 'Microsoft.Insights/diagnosticSettings' && !!shapeOf(schema.body, schema.defs).fields?.tags;
      if (takesTags) {
        const tags = r.tags as Obj | undefined;
        for (const k of ['atk_plan', 'atk_app', 'atk_env', 'atk_owner']) expect([name, r.type, k, tags?.[k] !== undefined]).toEqual([name, r.type, k, true]);
      }
    }
  }
  // No secure parameter carries a value.
  for (const [p, spec] of Object.entries(main.parameters ?? {})) {
    if (/^secure/.test(spec.type as string)) expect([p, spec.defaultValue]).toEqual([p, undefined]);
    if (/password|sharedkey|authorizationkey/i.test(p)) expect([p, spec.type]).toEqual([p, 'securestring']);
  }
  return { main, nested };
}

function bicepChecks(files: Readonly<Record<string, string>>): void {
  const main = files['azure-bicep/main.bicep'] as string;
  expect(main).toContain("targetScope = 'resourceGroup'");
  for (const m of main.matchAll(/module \w+ '(modules\/[^']+\.bicep)'/g)) expect([m[1], files[`azure-bicep/${m[1]}`] !== undefined]).toEqual([m[1], true]);
  const param = files['azure-bicep/main.bicepparam'] as string;
  expect(param.startsWith("using 'main.bicep'")).toBe(true);
  // Every @secure() parameter is read from the environment in main.bicepparam, never written.
  for (const m of main.matchAll(/@secure\(\)\nparam (\w+) string/g)) {
    expect(param).toContain(`param ${m[1]} = readEnvironmentVariable(`);
  }
  // Every resource's type and API version is one this deployment pins.
  for (const [p, text] of Object.entries(files)) {
    if (!p.endsWith('.bicep')) continue;
    for (const m of text.matchAll(/resource \w+ '([^@']+)@([^']+)'/g)) expect([p, m[1], AZURE_API[m[1] as string]]).toEqual([p, m[1], m[2]]);
  }
}

// ---------------------------------------------------------------------------
// AWS CloudFormation
// ---------------------------------------------------------------------------

describe('cloudFormationFiles', () => {
  it('writes the AWS estate as one template, its parameters and a README with the deploy command', () => {
    const r = cloudFormationFiles(s.plan, s.decision, s.design);
    expect(Object.keys(r.files).sort()).toEqual(['aws-cloudformation/README.md', 'aws-cloudformation/dc1-exit-aws.parameters.json', 'aws-cloudformation/dc1-exit-aws.yaml']);
    const readme = r.files['aws-cloudformation/README.md'] as string;
    expect(readme).toContain('aws cloudformation deploy --region us-east-1');
    expect(readme).toContain('--template-file dc1-exit-aws.yaml');
    expect(readme).toContain('--capabilities CAPABILITY_IAM');
    expect(readme).toContain('--parameter-overrides file://dc1-exit-aws.parameters.json');
    expect(readme).toContain('## In Terraform only');
    const params = JSON.parse(r.files['aws-cloudformation/dc1-exit-aws.parameters.json'] as string) as { Parameters: Record<string, string> };
    expect(params.Parameters.Owner).toBe('unassigned');
    noFootprints(r.files);
    cfnChecks(r.files);
  });

  it('builds the network from the design: dual-stack VPC and subnets, a security group per tier, flow logs and endpoints', () => {
    const doc = cfnChecks(cloudFormationFiles(s.plan, s.decision, s.design).files);
    const res = doc.Resources as Record<string, Obj>;
    const aws = s.design.platforms.find((p) => p.platform === 'aws');
    const prod = aws?.networks.find((n) => n.name === 'prod');
    expect(((res.VpcProd as Obj).Properties as Obj).CidrBlock).toBe(prod?.cidr);
    expect((res.VpcProdIpv6 as Obj).Type).toBe('AWS::EC2::VPCCidrBlock');
    // Exactly the user's subnets, in their own zones, IPv6 where the row says so: nothing carved or added.
    const subnets = Object.values(res).filter((r) => r.Type === 'AWS::EC2::Subnet');
    const designed = (aws?.networks ?? []).flatMap((n) => n.subnets);
    expect(subnets).toHaveLength(designed.length);
    for (const sn of subnets) {
      const p = sn.Properties as Obj;
      const row = designed.find((x) => x.cidr === p.CidrBlock)!;
      expect(row).toBeDefined();
      expect(p.AvailabilityZone).toBe(row.zone);
      expect(p.Ipv6CidrBlock !== undefined).toBe(!!row.ipv6);
    }
    for (const tier of ['Web', 'App', 'Db', 'Mgmt']) expect((res[`SgProd${tier}`] as Obj).Type).toBe('AWS::EC2::SecurityGroup');
    expect((res.VpcProdFlowLog as Obj).Type).toBe('AWS::EC2::FlowLog');
    // Everything created enabled: the key, the trail.
    expect(((res.LandingZoneKey as Obj).Properties as Obj).Enabled).toBe(true);
    expect(((res.LandingZoneKey as Obj).Properties as Obj).EnableKeyRotation).toBe(true);
    expect(((res.Trail as Obj).Properties as Obj).IsLogging).toBe(true);
  });

  it('writes RDS with the password in Secrets Manager, and the VPN keys generated into Secrets Manager', () => {
    const doc = cfnChecks(cloudFormationFiles(s.plan, s.decision, s.design).files);
    const res = doc.Resources as Record<string, Obj>;
    const dbs = Object.values(res).filter((r) => r.Type === 'AWS::RDS::DBInstance');
    expect(dbs.length).toBeGreaterThan(0);
    for (const db of dbs) {
      const p = db.Properties as Obj;
      expect(p.ManageMasterUserPassword).toBe(true);
      expect(p.MasterUserPassword).toBeUndefined();
      expect(p.StorageEncrypted).toBe(true);
      expect(p.DeletionProtection).toBe(true);
      expect(p.NetworkType).toBe('DUAL');
      expect(db.DeletionPolicy).toBe('Snapshot');
    }
    const vpns = Object.values(res).filter((r) => r.Type === 'AWS::EC2::VPNConnection');
    expect(vpns.length).toBeGreaterThan(0);
    for (const v of vpns) {
      expect((v.Properties as Obj).PreSharedKeyStorage).toBe('SecretsManager');
      expect(JSON.stringify(v)).not.toContain('PreSharedKey"');
    }
  });

  it('builds rebuilt VMs: encrypted volumes, IMDSv2, the image from a parameter, the bootstrap without secrets', () => {
    const r = cloudFormationFiles(s.plan, s.decision, s.rebuilt);
    const doc = cfnChecks(r.files);
    const res = doc.Resources as Record<string, Obj>;
    const params = doc.Parameters as Record<string, Obj>;
    const vms = Object.values(res).filter((x) => x.Type === 'AWS::EC2::Instance');
    expect(vms.length).toBeGreaterThanOrEqual(3);
    expect(((res.InstanceLaunchTemplate as Obj).Properties as Obj).LaunchTemplateData).toEqual({ MetadataOptions: { HttpEndpoint: 'enabled', HttpTokens: 'required', HttpPutResponseHopLimit: 2, HttpProtocolIpv6: 'enabled' } });
    for (const vm of vms) {
      const p = vm.Properties as Obj;
      const ebs = ((p.BlockDeviceMappings as Obj[])[0] as Obj).Ebs as Obj;
      expect(ebs.Encrypted).toBe(true);
      expect(ebs.KmsKeyId).toBeDefined();
      expect(isObj(p.ImageId) && typeof p.ImageId.Ref === 'string').toBe(true);
    }
    expect(params.Image1?.Type).toBe('AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>');
    expect(params.Image2?.Type).toBe('AWS::EC2::Image::Id');
    expect(params.SshPublicKey?.Default).toBeUndefined();
    const volumes = Object.values(res).filter((x) => x.Type === 'AWS::EC2::Volume');
    expect(volumes.length).toBeGreaterThanOrEqual(3);
    for (const v of volumes) expect((v.Properties as Obj).Encrypted).toBe(true);
    expect(r.files['aws-cloudformation/README.md']).toContain('Image2=<value>');
  });

  it('builds the new API service: a Lambda in the VPC, an HTTP API in front, its database and alarms', () => {
    const r = cloudFormationFiles(s.plan, s.decision, s.design, { scope: 'apps', apps: ['a:orders-api'] });
    const doc = cfnChecks(r.files);
    const res = doc.Resources as Record<string, Obj>;
    const fn = Object.values(res).find((x) => x.Type === 'AWS::Lambda::Function');
    expect(((fn?.Properties as Obj).VpcConfig as Obj).Ipv6AllowedForDualStack).toBe(true);
    expect(Object.values(res).some((x) => x.Type === 'AWS::ApiGatewayV2::Api')).toBe(true);
    expect(Object.values(res).some((x) => x.Type === 'AWS::RDS::DBInstance')).toBe(true);
    expect(Object.values(res).filter((x) => x.Type === 'AWS::CloudWatch::Alarm').length).toBeGreaterThan(0);
    // The WAF the ingress asks for has no HTTP API equivalent: a finding, not a partial resource.
    expect(r.findings.some((f) => f.code === 'plan.native.terraform-only' && /web application firewall/.test(f.message))).toBe(true);
    expect(Object.keys(r.files)).toContain('aws-cloudformation/dc1-exit-aws-orders-api.yaml');
  });

  it('builds a static site (S3 behind CloudFront) and an object store, and lists what stays in Terraform', () => {
    const site = cfnChecks(cloudFormationFiles(s.plan, s.decision, s.design, { scope: 'apps', apps: [s.ids.Brochure as string] }).files);
    expect(Object.values(site.Resources as Record<string, Obj>).some((x) => x.Type === 'AWS::CloudFront::Distribution')).toBe(true);
    const r = cloudFormationFiles(s.plan, s.decision, s.design, { scope: 'apps', apps: [s.ids.Pipeline as string] });
    const doc = cfnChecks(r.files);
    expect(Object.keys(doc.Resources as Obj).some((k) => /^BucketPipelineStorage$/.test(k))).toBe(true);
    const only = r.findings.filter((f) => f.code === 'plan.native.terraform-only').map((f) => f.message);
    expect(only.some((m) => /Pipeline compute \(batch\)/.test(m))).toBe(true);
    expect(r.files['aws-cloudformation/README.md']).toContain('**Pipeline compute (batch)**');
  });

  it('writes the landing zone alone for the landing-zone scope, and nothing for an app that is not on AWS', () => {
    const lz = cloudFormationFiles(s.plan, s.decision, s.design, { scope: 'landing-zone' });
    const doc = cfnChecks(lz.files);
    expect(Object.values(doc.Resources as Record<string, Obj>).some((x) => x.Type === 'AWS::RDS::DBInstance')).toBe(false);
    expect(Object.keys(lz.files)).toContain('aws-cloudformation/dc1-exit-aws-landing-zone.yaml');
    const none = cloudFormationFiles(s.plan, s.decision, s.design, { scope: 'apps', apps: [s.ids['Web Shop'] as string] });
    expect(none.files).toEqual({});
    expect(none.findings.map((f) => f.code)).toEqual(['plan.native.cfn-nothing']);
  });

  it('is the same every time', () => {
    const a = cloudFormationFiles(s.plan, s.decision, s.rebuilt);
    const b = cloudFormationFiles(s.plan, s.decision, s.rebuilt);
    expect(a.files).toEqual(b.files);
    expect(cloudFormationTemplate(s.plan, s.decision, s.rebuilt)?.stack).toBe('dc1-exit-aws');
  });
});

// ---------------------------------------------------------------------------
// Azure Bicep and ARM
// ---------------------------------------------------------------------------

describe('bicepFiles', () => {
  const run = (design: TargetDesign, options: NativeOptions = {}) => bicepFiles(s.plan, s.decision, design, options);

  it('writes main.bicep, a module per part, main.bicepparam, the ARM template and a README with the commands', () => {
    const r = run(s.design);
    const paths = Object.keys(r.files);
    for (const p of ['azure-bicep/main.bicep', 'azure-bicep/main.bicepparam', 'azure-bicep/azuredeploy.json', 'azure-bicep/README.md', 'azure-bicep/modules/landing-zone.bicep', 'azure-bicep/modules/databases.bicep', 'azure-bicep/modules/connectivity.bicep']) {
      expect(paths).toContain(p);
    }
    const readme = r.files['azure-bicep/README.md'] as string;
    expect(readme).toContain('az deployment group create --resource-group dc1-exit-az-rg --template-file main.bicep --parameters main.bicepparam');
    expect(readme).toContain('Deploy a custom template');
    expect(readme).toContain('## In Terraform only');
    noFootprints(r.files);
    bicepChecks(r.files);
    const { nested } = armChecks(r.files);
    // One nested deployment per module, and the flow logs in NetworkWatcherRG.
    expect(nested.size).toBe(paths.filter((p) => p.startsWith('azure-bicep/modules/')).length);
    const main = JSON.parse(r.files['azure-bicep/azuredeploy.json'] as string) as { resources: Obj[] };
    expect(main.resources.find((x) => (x.name as string).endsWith('-flow-logs'))?.resourceGroup).toBe('NetworkWatcherRG');
  });

  it('builds the dual-stack network, NSGs per tier and the landing zone\'s keys and logs', () => {
    const r = run(s.design);
    const { nested } = armChecks(r.files);
    const lz = nested.get('dc1-exit-az-landing-zone') as ArmTemplate;
    const vnet = lz.resources.find((x) => x.type === 'Microsoft.Network/virtualNetworks') as Obj;
    const prod = s.design.platforms.find((p) => p.platform === 'azure')?.networks.find((n) => n.name === 'prod');
    expect(((vnet.properties as Obj).addressSpace as Obj).addressPrefixes).toEqual([prod?.cidr, prod?.ipv6Cidr]);
    const subnets = (vnet.properties as Obj).subnets as Obj[];
    for (const tier of ['web', 'app', 'db', 'mgmt']) {
      const sn = subnets.find((x) => x.name === `dc1-exit-az-prod-${tier}`) as Obj;
      expect(((sn.properties as Obj).addressPrefixes as string[]).length).toBe(2);
    }
    expect(subnets.some((x) => x.name === 'GatewaySubnet')).toBe(true);
    // Exactly the user's subnets; a security group per tier of each network (and the ones SQL MI and Entra DS subnets carry).
    const azure = s.design.platforms.find((p) => p.platform === 'azure')!;
    expect(subnets.length).toBe(prod?.subnets.length ?? 0);
    const tierNsgs = azure.networks.reduce((n, x) => n + x.tiers.length, 0);
    const special = azure.networks.reduce((n, x) => n + x.subnets.filter((y) => y.tier === 'sqlmi' || y.tier === 'aadds').length, 0);
    expect(lz.resources.filter((x) => x.type === 'Microsoft.Network/networkSecurityGroups').length).toBe(tierNsgs + special);
    const kv = lz.resources.find((x) => x.type === 'Microsoft.KeyVault/vaults') as Obj;
    expect((kv.properties as Obj).enablePurgeProtection).toBe(true);
    expect(lz.resources.some((x) => x.type === 'Microsoft.Compute/diskEncryptionSets')).toBe(true);
  });

  it('writes the databases with Entra ID only, private endpoints, and no password anywhere', () => {
    const r = run(s.design);
    const { nested } = armChecks(r.files);
    const dbs = nested.get('dc1-exit-az-databases') as ArmTemplate;
    const servers = dbs.resources.filter((x) => x.type === 'Microsoft.Sql/servers');
    expect(servers.length).toBe(2);
    for (const sv of servers) {
      const admin = (sv.properties as Obj).administrators as Obj;
      expect(admin.azureADOnlyAuthentication).toBe(true);
      expect((sv.properties as Obj).publicNetworkAccess).toBe('Disabled');
    }
    expect(dbs.resources.filter((x) => x.type === 'Microsoft.Network/privateEndpoints').length).toBe(2);
    expect(r.files['azure-bicep/main.bicepparam']).toContain("param dbAdminGroupObjectId = readEnvironmentVariable('DB_ADMIN_GROUP_OBJECT_ID')");
  });

  it('builds rebuilt VMs with Trusted Launch, customer-managed disk encryption, backup and monitoring', () => {
    const r = run(s.rebuilt);
    bicepChecks(r.files);
    const { nested } = armChecks(r.files);
    const compute = nested.get('dc1-exit-az-compute') as ArmTemplate;
    const vms = compute.resources.filter((x) => x.type === 'Microsoft.Compute/virtualMachines');
    expect(vms.length).toBeGreaterThanOrEqual(2);
    for (const vm of vms) {
      const p = vm.properties as Obj;
      expect(((p.securityProfile as Obj).securityType)).toBe('TrustedLaunch');
      expect((((p.storageProfile as Obj).osDisk as Obj).managedDisk as Obj).diskEncryptionSet).toBeDefined();
      const os = p.osProfile as Obj;
      if (os.adminPassword !== undefined) expect(os.adminPassword).toBe("[parameters('windowsAdminPassword')]");
    }
    expect(compute.parameters?.windowsAdminPassword?.type).toBe('securestring');
    const backup = nested.get('dc1-exit-az-backup') as ArmTemplate;
    expect(backup.resources.filter((x) => (x.type as string).endsWith('/protectedItems')).length).toBe(vms.length);
    const monitoring = nested.get('dc1-exit-az-monitoring') as ArmTemplate;
    expect(monitoring.resources.filter((x) => x.type === 'Microsoft.Insights/dataCollectionRuleAssociations').length).toBe(vms.length);
  });

  it('builds the new web app: App Service in the VNet behind a private endpoint, PostgreSQL flexible, alerts', () => {
    const r = run(s.design, { scope: 'apps', apps: [s.ids['Web Shop'] as string] });
    bicepChecks(r.files);
    const { nested } = armChecks(r.files);
    const app = nested.get('dc1-exit-az-web-shop-app-web-shop') as ArmTemplate;
    const site = app.resources.find((x) => x.type === 'Microsoft.Web/sites') as Obj;
    expect((site.properties as Obj).httpsOnly).toBe(true);
    expect((site.properties as Obj).publicNetworkAccess).toBe('Disabled');
    expect(app.resources.some((x) => x.type === 'Microsoft.Network/privateEndpoints')).toBe(true);
    const dbs = nested.get('dc1-exit-az-web-shop-databases') as ArmTemplate;
    const pg = dbs.resources.find((x) => x.type === 'Microsoft.DBforPostgreSQL/flexibleServers') as Obj;
    expect(((pg.properties as Obj).authConfig as Obj).passwordAuth).toBe('Disabled');
    expect(r.findings.some((f) => /Web Shop cache \(managed-cache\)/.test(f.message))).toBe(true);
  });

  it('builds the new event-driven service: Functions reaching their storage by identity, and an object store', () => {
    const r = run(s.design, { scope: 'apps', apps: [s.ids.Events as string] });
    bicepChecks(r.files);
    const { nested } = armChecks(r.files);
    const app = nested.get('dc1-exit-az-events-app-events') as ArmTemplate;
    const fn = app.resources.find((x) => x.type === 'Microsoft.Web/sites') as Obj;
    expect(fn.kind).toBe('functionapp,linux');
    const stores = app.resources.filter((x) => x.type === 'Microsoft.Storage/storageAccounts');
    expect(stores.length).toBe(2);
    for (const st of stores) expect((st.properties as Obj).allowSharedKeyAccess).toBe(false);
    expect(app.resources.some((x) => x.type === 'Microsoft.Authorization/roleAssignments')).toBe(true);
  });

  it('uses the API versions it pins, each known to the ARM schemas, and is the same every time', () => {
    for (const t of bicepResourceTypes(s.plan, s.decision, s.rebuilt)) {
      expect([t.type, armType(t.type)?.versions.includes(t.api)]).toEqual([t.type, true]);
    }
    expect(run(s.rebuilt).files).toEqual(run(s.rebuilt).files);
    const none = run(s.design, { scope: 'apps', apps: [s.ids.Brochure as string] });
    expect(none.files).toEqual({});
    expect(none.findings.map((f) => f.code)).toEqual(['plan.native.bicep-nothing']);
  });
});
