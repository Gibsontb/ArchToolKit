/**
 * Kubernetes manifests against the release's schema: a field the kind does
 * not have, a value outside a closed set, a correct file with nothing to say,
 * a custom resource left alone, and the values that look wrong and are not
 * (quantities, int-or-string ports, free maps). Every name is invented.
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { readYaml } from '../core/yaml-read.ts';
import type { Finding } from '../core/findings.ts';
import { parsePath, type Json } from './doc.ts';
import { perDocument } from './profile.ts';
import { kubernetes } from './profiles/kubernetes.ts';
import { KUBERNETES_SCHEMA_INDEX } from './kubernetes-schema-index.ts';
import { kindSchema, loadKind } from './kubernetes-schema.ts';

const docs = (text: string): Json => readYaml(text).documents as Json;
const check = (text: string): Finding[] => perDocument(kubernetes, true).validate?.(docs(text)) ?? [];
const errors = (fs: Finding[]) => fs.filter((f) => f.severity === 'error');
const codes = (fs: Finding[]) => fs.map((f) => f.code);

const GOOD = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: shop
  labels: { app.kubernetes.io/name: web, tier: front }
  annotations: { example.com/owner: team-a }
spec:
  replicas: 3
  selector: { matchLabels: { app: web } }
  strategy:
    type: RollingUpdate
    rollingUpdate: { maxSurge: 25%, maxUnavailable: 1 }
  template:
    metadata: { labels: { app: web } }
    spec:
      containers:
        - name: web
          image: nginx:1.27
          ports:
            - { name: http, containerPort: 8080, protocol: TCP }
          env:
            - name: MODE
              valueFrom: { configMapKeyRef: { name: web-config, key: mode } }
          resources:
            requests: { cpu: 250m, memory: 128Mi }
            limits: { cpu: 2, memory: 1Gi, ephemeral-storage: 0.5Gi }
          readinessProbe:
            httpGet: { path: /healthz, port: http }
          livenessProbe:
            tcpSocket: { port: 8080 }
      volumes:
        - name: config
          configMap: { name: web-config }
---
apiVersion: v1
kind: Service
metadata: { name: web, namespace: shop }
spec:
  type: ClusterIP
  selector: { app: web }
  ports:
    - { name: http, port: 80, targetPort: http }
    - { name: alt, port: 8080, targetPort: 8080, protocol: TCP }
---
apiVersion: v1
kind: ConfigMap
metadata: { name: web-config, namespace: shop }
data:
  mode: production
  app.properties: |
    level=info
`;

describe('kubernetes: the schema', () => {
  it('comes from a stable release and indexes the everyday kinds', () => {
    expect(/^\d+\.\d+\.\d+$/.test(KUBERNETES_SCHEMA_INDEX.version)).toBe(true);
    expect(KUBERNETES_SCHEMA_INDEX.kinds['apps/v1']?.Deployment?.[0]).toBe('apps');
    expect(KUBERNETES_SCHEMA_INDEX.kinds.v1?.Service?.[0]).toBe('core');
    expect(kindSchema('apps/v1', 'Deployment') !== undefined).toBe(true);
    expect(kindSchema('example.com/v1', 'Widget')).toBe(undefined);
  });

  it('loads through prepare without error, built-in or not', async () => {
    await loadKind('apps/v1', 'Deployment');
    await perDocument(kubernetes, true).prepare?.(docs(GOOD));
    await kubernetes.prepare?.({ apiVersion: 'example.com/v1', kind: 'Widget', metadata: { name: 'w' } });
  });
});

describe('kubernetes: field checks', () => {
  it('a mistyped field, with the one that was meant', () => {
    const f = check(`apiVersion: apps/v1
kind: Deployment
metadata: { name: web }
spec:
  replica: 3
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      containers: [{ name: web, image: nginx:1.27, resources: { requests: { cpu: 100m } } }]
`);
    const unknown = f.find((x) => x.code === 'k8s.field.unknown');
    expect(unknown?.path).toBe('[0].spec.replica');
    expect(unknown?.severity).toBe('error');
    expect(unknown?.message.includes('“replicas”')).toBe(true);
    expect(errors(f).length).toBe(1);
  });

  it('a Service type outside its closed set', () => {
    const f = check(`apiVersion: v1
kind: Service
metadata: { name: web }
spec:
  type: LoadBalancr
  ports: [{ port: 80 }]
`);
    const bad = f.find((x) => x.code === 'k8s.field.enum');
    expect(bad?.path).toBe('[0].spec.type');
    expect(bad?.message.includes('LoadBalancer')).toBe(true);
    expect(bad?.remediation?.includes('NodePort')).toBe(true);
    expect(errors(f).length).toBe(1);
  });

  it('a correct Deployment, Service and ConfigMap: no errors, no warnings', () => {
    const f = check(GOOD);
    expect(f.filter((x) => x.severity !== 'info')).toEqual([]);
  });

  it('a custom resource: an info, and no field checks', () => {
    const f = check(`apiVersion: monitoring.example.com/v1
kind: ServiceMonitor
metadata: { name: web }
spec:
  anything: goes
  endpoints: [{ port: http, interval: 30s, replica: 2 }]
`);
    expect(codes(f)).toEqual(['k8s.schema.custom']);
    expect(f[0]?.severity).toBe('info');
  });

  it('quantities and int-or-string ports are accepted; a bad one is not', () => {
    const ok = check(`apiVersion: v1
kind: Pod
metadata: { name: p }
spec:
  containers:
    - name: c
      image: busybox:1.36
      resources: { requests: { cpu: 0.5, memory: 64Mi }, limits: { cpu: "1", memory: 1e9 } }
      livenessProbe: { httpGet: { port: 8080 } }
      readinessProbe: { httpGet: { port: web } }
`);
    expect(errors(ok)).toEqual([]);
    const bad = check(`apiVersion: v1
kind: Pod
metadata: { name: p }
spec:
  containers:
    - name: c
      image: busybox:1.36
      resources: { requests: { memory: 64MB } }
      livenessProbe: { httpGet: { port: 80.5 } }
`);
    expect(codes(errors(bad)).sort()).toEqual(['k8s.field.type', 'k8s.field.type']);
    expect(bad.some((x) => x.path === '[0].spec.containers[0].resources.requests.memory')).toBe(true);
  });

  it('a required field left out, and a value of the wrong type', () => {
    const f = check(`apiVersion: apps/v1
kind: Deployment
metadata: { name: web }
spec:
  replicas: "3"
  template:
    spec:
      containers: [{ image: nginx:1.27, resources: { requests: { cpu: 1 } } }]
`);
    const at = (code: string) => f.filter((x) => x.code === code).map((x) => x.path);
    expect(at('k8s.field.required').sort()).toEqual(['[0].spec.selector', '[0].spec.template.spec.containers[0].name']);
    expect(at('k8s.field.type')).toEqual(['[0].spec.replicas']);
  });

  it('labels, annotations and ConfigMap data take any key, but only text values', () => {
    const f = check(`apiVersion: v1
kind: ConfigMap
metadata:
  name: c
  labels: { any-key/at.all: x }
data:
  port: 8080
  ok: "8080"
`);
    expect(errors(f).map((x) => [x.code, x.path])).toEqual([['k8s.field.type', '[0].data.port']]);
  });

  it('an unknown kind of a built-in apiVersion is a warning, pointing at where it is served', () => {
    const f = check(`apiVersion: v1
kind: Deployment
metadata: { name: web }
`);
    const w = f.find((x) => x.code === 'k8s.kind.unknown');
    expect(w?.severity).toBe('warning');
    expect(w?.remediation?.includes('apps/v1')).toBe(true);
    expect(check(`apiVersion: apps/v1\nkind: Deploymnet\nmetadata: { name: web }\n`).find((x) => x.code === 'k8s.kind.unknown')?.message.includes('Deployment')).toBe(true);
  });

  it('keeps the removed-API and naming checks, without schema noise on a removed API', () => {
    const f = check(`apiVersion: extensions/v1beta1
kind: Ingress
metadata: { name: Web_Front }
spec: { backend: { serviceName: web, servicePort: 80 } }
`);
    expect(codes(f).sort()).toEqual(['k8s.apiVersion.removed', 'k8s.name.invalid']);
  });
});

describe('kubernetes: answer sets', () => {
  const doc = docs(GOOD);
  const c = (path: string) => perDocument(kubernetes, true).choices?.(parsePath(path), doc);
  it('come from the schema, merged with the hand-kept ones', () => {
    expect(c('[1].spec.type')).toEqual(['ClusterIP', 'NodePort', 'LoadBalancer', 'ExternalName']);
    expect(c('[0].spec.strategy.type')).toEqual(['RollingUpdate', 'Recreate']);
    expect(c('[0].spec.template.spec.containers[0].ports[0].protocol')?.includes('SCTP')).toBe(true);
    // Only the schema knows these.
    expect(c('[0].spec.template.spec.containers[0].terminationMessagePolicy')).toEqual(['FallbackToLogsOnError', 'File']);
    expect(c('[1].spec.ipFamilyPolicy')?.includes('RequireDualStack')).toBe(true);
    // A name known by hand where the schema gives no set.
    expect(c('[0].spec.selector.matchExpressions[0].operator')?.includes('NotIn')).toBe(true);
  });
});
