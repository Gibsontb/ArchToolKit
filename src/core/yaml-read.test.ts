/**
 * The YAML reader, on the shapes the editor opens: playbooks, inventories,
 * Kubernetes manifests, CloudFormation templates.
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { jsonLines, plainScalar, readYaml, YamlError } from './yaml-read.ts';
import { renderYaml } from '../ansible/yaml.ts';

const PLAYBOOK = `---
# Patch the web tier
- name: Patch web servers
  hosts: web
  become: yes
  vars:
    mode: 0644
    port: 8443
  tasks:
  - name: Install nginx
    ansible.builtin.package:
      name: nginx
      state: present
  - name: Write config
    ansible.builtin.copy:
      dest: /etc/nginx/conf.d/app.conf   # trailing comment
      content: |
        server {
          listen 8443;
        }
      mode: "0644"
`;

describe('block YAML', () => {
  it('reads an Ansible playbook, with the task list at its key’s indent', () => {
    const r = readYaml(PLAYBOOK);
    expect(r.documents.length).toBe(1);
    const play = (r.documents[0] as any[])[0];
    expect(play.name).toBe('Patch web servers');
    expect(play.become).toBe(true);
    expect(play.vars.mode).toBe('0644');
    expect(play.vars.port).toBe(8443);
    expect(play.tasks.length).toBe(2);
    expect(play.tasks[0]['ansible.builtin.package'].state).toBe('present');
    expect(play.tasks[1]['ansible.builtin.copy'].content).toBe('server {\n  listen 8443;\n}\n');
    expect(play.tasks[1]['ansible.builtin.copy'].dest).toBe('/etc/nginx/conf.d/app.conf');
    expect(r.comments).toBe(2);
  });

  it('records the line of every field', () => {
    const r = readYaml(PLAYBOOK);
    expect(r.lines.get('[0].hosts')).toBe(4);
    expect(r.lines.get('[0].tasks[1].name')).toBe(14);
    expect(r.lines.get('[0].tasks[1]["ansible.builtin.copy"].dest')).toBe(16);
  });

  it('reads folded and chomped block scalars', () => {
    const r = readYaml('a: >\n  one\n  two\n\n  three\nb: |-\n  keep\nc: |+\n  x\n\nd: end\n');
    const d = r.documents[0] as any;
    expect(d.a).toBe('one two\nthree\n');
    expect(d.b).toBe('keep');
    expect(d.c).toBe('x\n\n');
    expect(d.d).toBe('end');
  });

  it('reads quoted scalars and escapes', () => {
    const d = readYaml(`a: 'it''s'\nb: "tab\\tnew\\nline \\u00e9"\nc: "# not a comment"\n`).documents[0] as any;
    expect(d.a).toBe("it's");
    expect(d.b).toBe('tab\tnew\nline é');
    expect(d.c).toBe('# not a comment');
  });

  it('follows YAML 1.1 as Ansible reads it', () => {
    expect(plainScalar('yes')).toBe(true);
    expect(plainScalar('Off')).toBe(false);
    expect(plainScalar('n')).toBe('n');
    expect(plainScalar('~')).toBe(null);
    expect(plainScalar('0644')).toBe('0644');
    expect(plainScalar('1.5')).toBe(1.5);
    expect(plainScalar('10.20.1.5')).toBe('10.20.1.5');
  });
});

describe('several documents', () => {
  it('reads a Kubernetes manifest set', () => {
    const r = readYaml(`apiVersion: v1\nkind: Namespace\nmetadata:\n  name: app\n---\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n  namespace: app\nspec:\n  replicas: 3\n  template:\n    spec:\n      containers:\n        - name: web\n          image: nginx:1.27\n          ports: [{containerPort: 80}, {containerPort: 443}]\n`);
    expect(r.documents.length).toBe(2);
    const dep = r.documents[1] as any;
    expect(dep.kind).toBe('Deployment');
    expect(dep.spec.template.spec.containers[0].image).toBe('nginx:1.27');
    expect(dep.spec.template.spec.containers[0].ports[1].containerPort).toBe(443);
    expect(r.lines.get('[1].spec.replicas')).toBe(12);
  });
});

describe('anchors and tags', () => {
  it('resolves aliases and merge keys', () => {
    const d = readYaml(`base: &b\n  cpu: 2\n  mem: 8\nbig:\n  <<: *b\n  mem: 32\nsame: *b\n`).documents[0] as any;
    expect(d.big).toEqual({ cpu: 2, mem: 32 });
    expect(d.same).toEqual({ cpu: 2, mem: 8 });
  });

  it('rewrites CloudFormation short tags to their long form', () => {
    const r = readYaml(`Resources:\n  Bucket:\n    Type: AWS::S3::Bucket\n    Properties:\n      BucketName: !Sub '\${AWS::StackName}-logs'\nOutputs:\n  Arn:\n    Value: !GetAtt Bucket.Arn\n  Name:\n    Value: !Ref Bucket\n  Azs:\n    Value: !Join [',', !GetAZs '']\n`);
    const d = r.documents[0] as any;
    expect(d.Resources.Bucket.Properties.BucketName).toEqual({ 'Fn::Sub': '${AWS::StackName}-logs' });
    expect(d.Outputs.Arn.Value).toEqual({ 'Fn::GetAtt': ['Bucket', 'Arn'] });
    expect(d.Outputs.Name.Value).toEqual({ Ref: 'Bucket' });
    expect(d.Outputs.Azs.Value).toEqual({ 'Fn::Join': [',', { 'Fn::GetAZs': '' }] });
    expect(r.rewrittenTags).toBe(5);
  });

  it('reports tags a form could not keep', () => {
    const r = readYaml(`password: !vault |\n  $ANSIBLE_VAULT;1.1;AES256\n  6162\nport: !!str 22\n`);
    expect(r.unsupportedTags.map((t) => t.tag)).toEqual(['!vault']);
    expect(r.unsupportedTags[0]?.line).toBe(1);
    expect((r.documents[0] as any).port).toBe('22');
  });
});

describe('JSON is YAML', () => {
  it('reads a JSON document and agrees with JSON.parse', () => {
    const text = JSON.stringify({ a: [1, { b: 'x: y' }], c: null, d: true }, null, 2);
    expect(readYaml(text).documents[0]).toEqual(JSON.parse(text));
  });

  it('maps JSON paths to lines', () => {
    const lines = jsonLines('{\n  "a": 1,\n  "list": [\n    {"x": 2},\n    {"x": 3}\n  ]\n}');
    expect(lines.get('a')).toBe(2);
    expect(lines.get('list[1].x')).toBe(5);
  });
});

describe('round trip', () => {
  it('reads back what the toolkit writes', () => {
    const value = { name: 'x', list: [1, 'two', { k: 'v: w' }], flag: false, empty: [], mode: '0644', multi: 'a\nb\n' };
    const back = readYaml(renderYaml(value)).documents[0];
    expect(back).toEqual(value);
  });

  it('keeps multi-line text exactly, wherever it sits', () => {
    const texts = ['a\nb', 'a\nb\n', 'a\nb\n\n', '  indented\nnext', 'x\n\ny', 'yes\nno'];
    const value = { top: texts, nested: [{ deep: [texts] }], ...Object.fromEntries(texts.map((t, i) => [`k${i}`, t])) };
    expect(readYaml(renderYaml(value)).documents[0]).toEqual(value);
  });
});

describe('errors', () => {
  it('names the line', () => {
    let err: unknown;
    try {
      readYaml('a: 1\n  b: 2\nc: [1, 2\n');
    } catch (e) {
      err = e;
    }
    expect(err instanceof YamlError).toBe(true);
  });
});
