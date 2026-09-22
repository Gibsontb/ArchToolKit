/**
 * Each profile: it recognises its own kind of file and no other, passes a
 * correct one, and names what is wrong with a broken one. Fixtures are
 * synthetic and small; every name in them is invented.
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { readYaml } from '../core/yaml-read.ts';
import type { Finding } from '../core/findings.ts';
import { LAB_911_THREE_HOST_FC } from '../vcf/__fixtures__/real-specs.ts';
import { parsePath, pathString, renameAt, secretPaths, labelFor, type Json } from './doc.ts';
import { detectProfile, perDocument, PROFILES, profileById } from './profiles/index.ts';
import { parseStatement } from './profiles/oci.ts';
import { isConditionOperator } from './profiles/aws.ts';
import { choicesAt } from './profile.ts';

const errors = (fs: Finding[]) => fs.filter((f) => f.severity === 'error');
const codes = (fs: Finding[]) => fs.map((f) => f.code);
const yaml = (text: string): Json => readYaml(text).documents[0] as Json;
function run(id: string, doc: Json, multi = false): Finding[] {
  const p = profileById(id);
  if (!p) throw new Error(id);
  return perDocument(p, multi).validate?.(doc) ?? [];
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PLAYBOOK = yaml(`
- name: Web tier
  hosts: web
  become: true
  tasks:
    - name: Install nginx
      ansible.builtin.package:
        name: nginx
        state: present
    - name: Start it
      ansible.builtin.service:
        name: nginx
        state: started
    - block:
        - name: Guest
          community.vmware.vmware_guest:
            name: web01
      rescue:
        - ansible.builtin.debug:
            msg: failed
`);

const INVENTORY = yaml(`
all:
  children:
    web:
      hosts:
        web01.example.com:
          ansible_host: 10.0.0.11
        web02.example.com:
      vars:
        ansible_connection: ssh
`);

const TF = {
  terraform: { required_providers: { aws: { source: 'hashicorp/aws' } } },
  variable: { db_password: { type: 'string', sensitive: true } },
  resource: { aws_instance: { web: { ami: 'ami-123', instance_type: 't3.micro' } } },
  data: { aws_ami: { base: { most_recent: true } } },
  output: { ip: { value: '${aws_instance.web.private_ip}' } },
} as Json;

const CFN = yaml(`
AWSTemplateFormatVersion: '2010-09-09'
Parameters:
  Env:
    Type: String
    AllowedValues: [dev, prod]
    Default: dev
Conditions:
  IsProd: !Equals [!Ref Env, prod]
Resources:
  Logs:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: !Sub '\${AWS::StackName}-\${Env}-logs'
  Role:
    Type: AWS::IAM::Role
    Condition: IsProd
    Properties:
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal: { Service: ec2.amazonaws.com }
            Action: sts:AssumeRole
Outputs:
  Bucket:
    Value: !GetAtt Logs.Arn
`);

const IAM = {
  Version: '2012-10-17',
  Statement: [{ Sid: 'ReadLogs', Effect: 'Allow', Action: ['s3:GetObject', 's3:ListBucket'], Resource: 'arn:aws:s3:::logs/*' }],
} as Json;

const GCP_IAM = {
  version: 3,
  bindings: [
    { role: 'roles/storage.objectViewer', members: ['group:readers@example.com', 'serviceAccount:app@proj.iam.gserviceaccount.com'] },
    { role: 'roles/compute.viewer', members: ['user:ops@example.com'], condition: { title: 'office hours', expression: 'true' } },
  ],
} as Json;

const ARM = {
  $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
  contentVersion: '1.0.0.0',
  parameters: {
    location: { type: 'string', defaultValue: '[resourceGroup().location]' },
    adminPassword: { type: 'securestring' },
    sku: { type: 'string', allowedValues: ['Standard_LRS', 'Standard_GRS'], defaultValue: 'Standard_LRS' },
  },
  variables: { name: "[concat('st', uniqueString(resourceGroup().id))]" },
  resources: [
    {
      type: 'Microsoft.Storage/storageAccounts',
      apiVersion: '2023-05-01',
      name: "[variables('name')]",
      location: "[parameters('location')]",
      sku: { name: "[parameters('sku')]" },
      kind: 'StorageV2',
    },
  ],
} as Json;

const POLICY = {
  properties: {
    displayName: 'Allowed locations',
    mode: 'Indexed',
    parameters: { allowed: { type: 'Array' }, effect: { type: 'String', allowedValues: ['Deny', 'Audit', 'Disabled'], defaultValue: 'Deny' } },
    policyRule: {
      if: { allOf: [{ field: 'location', notIn: "[parameters('allowed')]" }, { field: 'location', notEquals: 'global' }] },
      then: { effect: "[parameters('effect')]" },
    },
  },
} as Json;

const OCI = {
  name: 'network-admins',
  description: 'Network team',
  compartment_id: 'ocid1.tenancy.oc1..aaaa',
  statements: [
    'Allow group NetworkAdmins to manage virtual-network-family in compartment Networks',
    'Allow group NetworkAdmins to read instances in tenancy',
    "Allow dynamic-group Functions to {OBJECT_READ, OBJECT_INSPECT} in compartment Apps where target.bucket.name = 'logs'",
  ],
} as Json;

const AS3 = {
  class: 'AS3',
  action: 'deploy',
  declaration: {
    class: 'ADC',
    schemaVersion: '3.50.0',
    Example: {
      class: 'Tenant',
      Web: {
        class: 'Application',
        template: 'http',
        serviceMain: { class: 'Service_HTTP', virtualAddresses: ['10.1.1.10'], pool: 'web_pool' },
        web_pool: {
          class: 'Pool',
          loadBalancingMode: 'least-connections-member',
          monitors: ['http'],
          members: [{ servicePort: 80, serverAddresses: ['10.1.2.11', '10.1.2.12'] }],
        },
      },
    },
  },
} as Json;

const DO = {
  class: 'Device',
  schemaVersion: '1.40.0',
  Common: {
    class: 'Tenant',
    hostname: 'bigip1.example.com',
    myDns: { class: 'DNS', nameServers: ['10.0.0.2'] },
    external: { class: 'VLAN', interfaces: [{ name: '1.1', tagged: false }] },
  },
} as Json;

const K8S = readYaml(`apiVersion: v1
kind: Namespace
metadata:
  name: shop
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: shop
spec:
  replicas: 2
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      containers:
        - name: web
          image: nginx:1.27
          imagePullPolicy: IfNotPresent
          resources: { requests: { cpu: 100m } }
`).documents as Json;

// ---------------------------------------------------------------------------

describe('detection', () => {
  const cases: [string, Json, string, boolean?][] = [
    ['vcf-spec', LAB_911_THREE_HOST_FC as unknown as Json, 'lab.json'],
    ['ansible-playbook', PLAYBOOK, 'site.yml'],
    ['ansible-inventory', INVENTORY, 'inventory.yml'],
    ['terraform-json', TF, 'main.tf.json'],
    ['terraform-vars', { region: 'eu-west-1' }, 'prod.tfvars.json'],
    ['aws-cloudformation', CFN, 'stack.yaml'],
    ['aws-iam-policy', IAM, 'policy.json'],
    ['google-iam-policy', GCP_IAM, 'policy.json'],
    ['azure-arm', ARM, 'azuredeploy.json'],
    ['azure-policy', POLICY, 'policy.json'],
    ['oci-iam-policy', OCI, 'policy.json'],
    ['f5-as3', AS3, 'as3.json'],
    ['f5-do', DO, 'do.json'],
    ['kubernetes', K8S, 'app.yaml', true],
    ['generic', { anything: [1, 2] }, 'x.json'],
  ];
  for (const [id, doc, name, multi] of cases) {
    it(`recognises ${id}`, () => {
      expect(detectProfile(doc, name, multi ?? false).profile.id).toBe(id);
    });
  }

  it('has a unique id per profile', () => {
    expect(new Set(PROFILES.map((p) => p.id)).size).toBe(PROFILES.length);
  });
});

describe('correct files pass', () => {
  const cases: [string, Json, boolean?][] = [
    ['vcf-spec', LAB_911_THREE_HOST_FC as unknown as Json],
    ['ansible-playbook', PLAYBOOK],
    ['ansible-inventory', INVENTORY],
    ['terraform-json', TF],
    ['aws-cloudformation', CFN],
    ['aws-iam-policy', IAM],
    ['google-iam-policy', GCP_IAM],
    ['azure-arm', ARM],
    ['azure-policy', POLICY],
    ['oci-iam-policy', OCI],
    ['f5-as3', AS3],
    ['f5-do', DO],
    ['kubernetes', K8S, true],
  ];
  for (const [id, doc, multi] of cases) {
    it(`${id} has no errors`, () => {
      const found = errors(run(id, doc, multi));
      expect(found.map((f) => `${f.code} ${f.path}: ${f.message}`)).toEqual([]);
    });
  }
});

describe('broken files are caught', () => {
  it('ansible: a misspelt module, two modules in a task, a bad play keyword', () => {
    const bad = yaml(`
- hosts: web
  gather_fact: false
  tasks:
    - name: typo
      community.vmware.vmware_gest: { name: x }
    - name: two
      ansible.builtin.copy: { src: a, dest: b }
      ansible.builtin.file: { path: b }
`);
    const f = run('ansible-playbook', bad);
    expect(codes(f).includes('ansible.play.unknown-keyword')).toBe(true);
    expect(f.find((x) => x.code === 'ansible.play.unknown-keyword')?.message.includes('gather_facts')).toBe(true);
    expect(codes(f).includes('ansible.task.many-modules')).toBe(true);
    const unknown = f.find((x) => x.code === 'ansible.module.unknown');
    expect(unknown?.path).toBe('[0].tasks[0]["community.vmware.vmware_gest"]');
    expect(unknown?.message.includes('vmware_guest')).toBe(true);
  });

  it('ansible: a host written straight into a group', () => {
    const f = run('ansible-inventory', yaml('all:\n  children:\n    db:\n      db01.example.com:\n        ansible_host: 10.0.0.5\n'));
    expect(codes(f)).toEqual(['ansible.inventory.group-key']);
  });

  it('terraform: an invented resource type, a data source used as a resource, a secret default', () => {
    const f = run('terraform-json', {
      variable: { api_key: { default: 'abc123' } },
      resource: { aws_instanse: { x: {} }, aws_caller_identity: { y: {} } },
    });
    expect(codes(f).includes('tf.type.unknown')).toBe(true);
    expect(f.find((x) => x.code === 'tf.type.unknown')?.message.includes('aws_instance')).toBe(true);
    expect(codes(f).includes('tf.type.data-as-resource')).toBe(true);
    expect(codes(f).includes('tf.variable.secret-default')).toBe(true);
    expect(codes(f).includes('tf.variable.not-sensitive')).toBe(true);
  });

  it('cloudformation: a dangling Ref, GetAtt and Sub, a misplaced property, a bad type', () => {
    const f = run('aws-cloudformation', yaml(`
Resources:
  Bucket:
    Type: AWS::S3:Bucket
    BucketName: x
    Properties:
      Tags:
        - Key: owner
          Value: !Ref Owner
  Out:
    Type: AWS::SNS::Topic
    DependsOn: Buckett
    Properties:
      DisplayName: !Sub '\${Bucket}-\${Missing}'
      TopicName: !GetAtt Nope.Arn
`));
    for (const code of ['cfn.resource.type-format', 'cfn.resource.attribute', 'cfn.ref', 'cfn.dependson', 'cfn.sub', 'cfn.getatt']) {
      expect([code, codes(f).includes(code)]).toEqual([code, true]);
    }
  });

  it('iam: a bad effect, action, resource and condition operator; admin warned', () => {
    const f = run('aws-iam-policy', {
      Version: '2012-10-17',
      Statement: [
        { Effect: 'allow', Action: 'GetObject', Resource: 'logs', Condition: { StringEqual: {} } },
        { Effect: 'Allow', Action: '*', Resource: '*' },
      ],
    });
    for (const code of ['iam.effect', 'iam.action.format', 'iam.resource.format', 'iam.condition.operator', 'iam.full-admin']) {
      expect([code, codes(f).includes(code)]).toEqual([code, true]);
    }
    expect(isConditionOperator('ForAnyValue:StringLikeIfExists')).toBe(true);
    expect(isConditionOperator('NullIfExists')).toBe(false);
  });

  it('google: a conditional policy below version 3, a bad member, public access', () => {
    const f = run('google-iam-policy', {
      version: 1,
      bindings: [
        { role: 'roles/viewer', members: ['someone@example.com', 'allUsers'], condition: { expression: 'true' } },
        { role: 'storage.admin', members: ['user:a@example.com'] },
      ],
    });
    for (const code of ['gcp.iam.version', 'gcp.iam.member.format', 'gcp.iam.public', 'gcp.iam.role.format']) {
      expect([code, codes(f).includes(code)]).toEqual([code, true]);
    }
  });

  it('google: Deployment Manager is flagged as retired', () => {
    const f = run('google-deployment-manager', { resources: [{ name: 'vm', type: 'compute.v1.instance', properties: { zone: '$(ref.net.selfLink)' } }] });
    expect(codes(f)).toEqual(['gcp.dm.deprecated', 'gcp.dm.ref']);
  });

  it('azure: an undeclared parameter, a password parameter that is not secure, a bad apiVersion', () => {
    const f = run('azure-arm', {
      ...(ARM as Record<string, Json>),
      parameters: { adminPassword: { type: 'string' } },
      resources: [{ type: 'Microsoft.Compute/virtualMachines', apiVersion: 'latest', name: "[parameters('vmName')]" }],
    });
    for (const code of ['arm.parameters.unknown', 'arm.parameter.not-secure', 'arm.resource.apiVersion-format']) {
      expect([code, codes(f).includes(code)]).toEqual([code, true]);
    }
  });

  it('azure policy: an unknown operator, an unknown effect, DeployIfNotExists without roles', () => {
    const f = run('azure-policy', {
      policyRule: { if: { field: 'type', equal: 'x' }, then: { effect: 'DeployIfNotExists', details: { type: 'x' } } },
    });
    expect(codes(f).includes('policy.condition.unknown-operator')).toBe(true);
    expect(codes(f).includes('policy.roles')).toBe(true);
    const g = run('azure-policy', { policyRule: { if: { field: 'type', equals: 'x' }, then: { effect: 'Block' } } });
    expect(codes(g)).toEqual(['policy.effect.unknown']);
  });

  it('oci: grammar, and tenancy-wide admin', () => {
    expect('ok' in parseStatement('Allow group A to manage all-resources in tenancy')).toBe(true);
    expect('error' in parseStatement('Allow group A to administer instances in tenancy')).toBe(true);
    expect('error' in parseStatement('Allow group A to read instances')).toBe(true);
    expect('error' in parseStatement('Permit group A to read instances in tenancy')).toBe(true);
    const f = run('oci-iam-policy', { statements: ['Allow group Ops to manage all-resources in tenancy', 'allow Ops to read buckets in tenancy'] });
    expect(codes(f)).toEqual(['oci.statement.admin', 'oci.statement.syntax']);
  });

  it('f5 as3: an unknown class, a value outside its set, a pointer to nothing, a misspelt property', () => {
    const doc = JSON.parse(JSON.stringify(AS3));
    const app = doc.declaration.Example.Web;
    app.web_pool.loadBalancingMode = 'least-connection';
    app.serviceMain.pool = 'web-pool';
    app.web_pool.minimumMember = 1;
    app.cert = { class: 'Certficate' };
    const f = run('f5-as3', doc);
    for (const code of ['f5.as3.value', 'f5.as3.pointer', 'f5.as3.property', 'f5.as3.class']) {
      expect([code, codes(f).includes(code)]).toEqual([code, true]);
    }
    expect(f.find((x) => x.code === 'f5.as3.pointer')?.message.includes('web_pool')).toBe(true);
    expect(f.find((x) => x.code === 'f5.as3.class')?.message.includes('Certificate')).toBe(true);
  });

  it('f5 do: a required property missing', () => {
    const f = run('f5-do', { class: 'Device', schemaVersion: '1.40.0', Common: { class: 'Tenant', ext: { class: 'VLAN' } } });
    expect(codes(f)).toEqual(['f5.do.required']);
  });

  it('kubernetes: a removed apiVersion, a bad name, an inline secret, paths per document', () => {
    const docs = readYaml(`apiVersion: extensions/v1beta1
kind: Ingress
metadata: { name: Web_Front }
---
apiVersion: v1
kind: Secret
metadata: { name: creds }
stringData: { password: hunter2 }
`).documents as Json;
    const f = run('kubernetes', docs, true);
    expect(f.find((x) => x.code === 'k8s.apiVersion.removed')?.path).toBe('[0].apiVersion');
    expect(f.find((x) => x.code === 'k8s.name.invalid')?.path).toBe('[0].metadata.name');
    expect(f.find((x) => x.code === 'k8s.secret.inline')?.path).toBe('[1].stringData');
  });
});

describe('answer sets', () => {
  it('offer every value a correct file already holds', () => {
    const cases: [string, Json, boolean?][] = [
      ['vcf-spec', LAB_911_THREE_HOST_FC as unknown as Json],
      ['ansible-playbook', PLAYBOOK],
      ['ansible-inventory', INVENTORY],
      ['terraform-json', TF],
      ['aws-cloudformation', CFN],
      ['aws-iam-policy', IAM],
      ['azure-arm', ARM],
      ['azure-policy', POLICY],
      ['f5-as3', AS3],
      ['f5-do', DO],
      ['kubernetes', K8S, true],
    ];
    for (const [id, doc, multi] of cases) {
      const p = profileById(id)!;
      const walk = (node: Json, path: (string | number)[]): void => {
        if (typeof node === 'string') {
          const choices = choicesAt(p, doc, path, multi ?? false);
          if (choices && node !== '') expect([id, pathString(path), choices.includes(node)]).toEqual([id, pathString(path), true]);
          return;
        }
        if (Array.isArray(node)) node.forEach((v, i) => walk(v, [...path, i]));
        else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, [...path, k]);
      };
      walk(doc, []);
    }
  });

  it('come from the profile, at the right place', () => {
    const c = (id: string, path: string, doc: Json, multi = false) => perDocument(profileById(id)!, multi).choices?.(parsePath(path), doc);
    expect(c('ansible-playbook', '[0].tasks[1]["ansible.builtin.service"].state', PLAYBOOK)?.includes('restarted')).toBe(true);
    expect(c('ansible-inventory', 'all.children.web.vars.ansible_connection', INVENTORY)?.includes('winrm')).toBe(true);
    expect(c('aws-cloudformation', 'Parameters.Env.Default', CFN)).toEqual(['dev', 'prod']);
    expect(c('aws-cloudformation', 'Resources.Logs.DeletionPolicy', CFN)?.includes('RetainExceptOnCreate')).toBe(true);
    expect(c('azure-arm', 'parameters.sku.defaultValue', ARM)).toEqual(['Standard_LRS', 'Standard_GRS']);
    expect(c('azure-policy', 'properties.policyRule.then.effect', POLICY)?.includes('deployIfNotExists')).toBe(true);
    expect(c('f5-as3', 'declaration.Example.Web.web_pool.loadBalancingMode', AS3)?.includes('round-robin')).toBe(true);
    expect(c('f5-as3', 'declaration.Example.Web.web_pool.class', AS3)?.includes('Pool')).toBe(true);
    expect(c('kubernetes', '[1].spec.template.spec.containers[0].imagePullPolicy', K8S, true)).toEqual(['Always', 'IfNotPresent', 'Never']);
    expect(c('kubernetes', '[1].spec.strategy.type', K8S, true)).toEqual(['RollingUpdate', 'Recreate']);
  });
});

describe('the document helpers', () => {
  it('quote keys that are not plain names, and read them back', () => {
    const path = [0, 'tasks', 1, 'ansible.builtin.copy', 'dest'];
    expect(pathString(path)).toBe('[0].tasks[1]["ansible.builtin.copy"].dest');
    expect(parsePath(pathString(path))).toEqual(path);
    expect(parsePath('Resources.Bucket["Fn::GetAtt"][0]')).toEqual(['Resources', 'Bucket', 'Fn::GetAtt', 0]);
  });

  it('rename a key in place', () => {
    const doc = renameAt({ a: 1, b: 2, c: 3 }, ['b'], 'x');
    expect(Object.keys(doc as object)).toEqual(['a', 'x', 'c']);
  });

  it('count a secret only when it is written out, not referenced', () => {
    const doc = {
      a: { password: 'hunter2' },
      b: { password: '{{ vault_pw }}' },
      c: { client_secret: '${var.secret}' },
      d: { ansible_become_pass: '$ANSIBLE_VAULT;1.1;AES256' },
      e: { adminPassword: "[parameters('pw')]" },
      f: { api_key: 'abc' },
    } as Json;
    expect(secretPaths(doc)).toEqual(['a.password', 'f.api_key']);
  });

  it('label keys from every family readably', () => {
    expect(labelFor('ansible_become_user')).toBe('Ansible become user');
    expect(labelFor('AWSTemplateFormatVersion')).toBe('AWS template format version');
    expect(labelFor('ansible.builtin.copy')).toBe('ansible.builtin.copy');
    expect(labelFor('apiVersion')).toBe('API version');
    expect(labelFor('loadBalancingMode')).toBe('Load balancing mode');
  });
});
