/**
 * A VKS cluster (vSphere Kubernetes Service, formerly TKG): the Cluster API
 * Cluster with a topology class, and everything a real cluster is asked for on
 * day one — node pools with their own VM class, zone, labels, taints and OS,
 * the autoscaler range per pool, containerd / kubelet / etcd volumes, a proxy
 * and a trusted CA, the ClusterClass variables the page does not name, and the
 * VKS standard packages installed in the cluster once it is up.
 */

import { bool, num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, info, warning, type Finding } from '../../core/findings.ts';
import { automationBlueprint } from '../from-automation.ts';
import { listOf, slugOf, type Automation } from '../automation.ts';
import { applyScript } from '../apply.ts';
import { importBundle, importMd, kubeStep, manualStep, verifyFor } from '../vcfa-import.ts';
import { packageNameOf, toPackage } from '../vro/to-package.ts';
import { familyOf, overlapsAny } from '../../core/ip.ts';
import { PKG_REQUIRES, PLATFORM, SRC, elementName, guardSettings, json, kubectlScript, packageSteps, pa, rowsOf, templatePayload, underScripts } from './vcf-automation-extend-core.ts';

// ---------------------------------------------------------------------------
// The VKS standard packages

interface VksPackage {
  readonly label: string;
  /** The Carvel package name in the VKS standard package repository. VERIFY against `vcf package available list`. */
  readonly refName: string;
  readonly namespace: string;
  readonly values: (v: PackageValues) => string;
}

interface PackageValues {
  readonly clusterName: string;
  readonly dnsZone: string;
  readonly veleroBucket: string;
  readonly veleroRegion: string;
  readonly veleroS3Url: string;
  readonly pools: readonly Pool[];
}

export const VKS_PACKAGES: Readonly<Record<string, VksPackage>> = {
  'cert-manager': {
    label: 'cert-manager',
    refName: 'cert-manager.kubernetes.vmware.com',
    namespace: 'cert-manager',
    values: () => ['namespace: cert-manager', ''].join('\n'),
  },
  contour: {
    label: 'Contour (ingress; needs cert-manager)',
    refName: 'contour.kubernetes.vmware.com',
    namespace: 'tanzu-system-ingress',
    values: () => ['namespace: tanzu-system-ingress', 'contour:', '  replicas: 2', 'envoy:', '  service:', '    type: LoadBalancer', ''].join('\n'),
  },
  'external-dns': {
    label: 'ExternalDNS',
    refName: 'external-dns.kubernetes.vmware.com',
    namespace: 'tanzu-system-service-discovery',
    values: (v) =>
      [
        'namespace: tanzu-system-service-discovery',
        'deployment:',
        '  args:',
        '    - --source=service',
        '    - --source=ingress',
        `    - --domain-filter=${v.dnsZone || '<REQUIRED — the zone it may write>'}`,
        '    - --policy=upsert-only',
        '    - --registry=txt',
        `    - --txt-owner-id=${v.clusterName}`,
        '    - --provider=rfc2136  # VERIFY: the provider for your DNS, and its own arguments',
        '',
      ].join('\n'),
  },
  'fluent-bit': {
    label: 'Fluent Bit (to VCF Operations for Logs)',
    refName: 'fluent-bit.kubernetes.vmware.com',
    namespace: 'tanzu-system-logging',
    values: (v) =>
      [
        'namespace: tanzu-system-logging',
        'fluent_bit:',
        '  config:',
        '    outputs: |',
        '      [OUTPUT]',
        '          Name   syslog',
        '          Match  *',
        '          Host   <REQUIRED — the VCF Operations for Logs ingestion address>',
        '          Port   514',
        '          Mode   tcp',
        '          Syslog_Format rfc5424',
        `          Syslog_Hostname_key ${v.clusterName}`,
        '',
      ].join('\n'),
  },
  prometheus: {
    label: 'Prometheus',
    refName: 'prometheus.kubernetes.vmware.com',
    namespace: 'tanzu-system-monitoring',
    values: () => ['namespace: tanzu-system-monitoring', 'prometheus:', '  pvc:', '    storage: 50Gi', '  config:', '    prometheus_yml: ""', ''].join('\n'),
  },
  velero: {
    label: 'Velero (VKS-supported backup)',
    refName: 'velero.kubernetes.vmware.com',
    namespace: 'velero',
    values: (v) =>
      [
        'namespace: velero',
        'credential:',
        '  useDefaultSecret: false',
        '  name: velero-s3-credentials   # created by scripts/install-packages.sh from VELERO_CREDENTIALS_FILE',
        'backupStorageLocation:',
        '  name: default',
        '  spec:',
        '    provider: aws',
        '    objectStorage:',
        `      bucket: ${v.veleroBucket || '<REQUIRED — the bucket>'}`,
        '    config:',
        `      region: ${v.veleroRegion || 'minio'}`,
        `      s3Url: ${v.veleroS3Url || '<REQUIRED — https://s3.example.com>'}`,
        '      s3ForcePathStyle: "true"',
        'snapshotsEnabled: false',
        'deployNodeAgent: true',
        '',
      ].join('\n'),
  },
  'cluster-autoscaler': {
    label: 'Cluster Autoscaler (for pools with a min-max range)',
    refName: 'cluster-autoscaler.kubernetes.vmware.com',
    namespace: 'kube-system',
    values: (v) => ['arguments:', '  ignoreDaemonsetsUtilization: true', '  maxNodeProvisionTime: 15m', '  scaleDownDelayAfterAdd: 10m', '  scaleDownUnneededTime: 10m', `# Pools it scales: ${v.pools.filter((p) => p.min !== undefined).map((p) => p.name).join(', ') || '(none — no pool has a range)'}`, ''].join('\n'),
  },
};

// ---------------------------------------------------------------------------
// Node pools

export interface Pool {
  readonly name: string;
  readonly vmClass: string;
  readonly replicas?: number;
  readonly min?: number;
  readonly max?: number;
  readonly zone: string;
  readonly labels: readonly (readonly [string, string])[];
  readonly taints: readonly { key: string; value: string; effect: string }[];
  readonly os: string;
}

export const POOL_HINT = 'Pool name | VM class | Replicas or min-max | Zone | Labels | Taints | OS';

const LABEL_KEY = /^([a-z0-9]([-a-z0-9.]*[a-z0-9])?\/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;
const LABEL_VALUE = /^([A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?)?$/;
const EFFECTS = ['NoSchedule', 'PreferNoSchedule', 'NoExecute'];

export function parsePools(text: string): { pools: Pool[]; findings: Finding[] } {
  const findings: Finding[] = [];
  const pools: Pool[] = [];
  for (const [name = '', vmClass = '', count = '', zone = '', labelsCell = '', taintsCell = '', osCell = ''] of rowsOf(text, 7)) {
    if (!/^[a-z0-9]([-a-z0-9]{0,40}[a-z0-9])?$/.test(name)) {
      findings.push(error('vcfa.vks.bad-pool', `Pool name "${name}" is not a DNS label (lower case, digits and "-").`, { source: SRC }));
      continue;
    }
    if (!vmClass) findings.push(error('vcfa.vks.bad-pool', `Pool ${name} has no VM class.`, { source: SRC }));
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(count);
    let replicas: number | undefined;
    let min: number | undefined;
    let max: number | undefined;
    if (range) {
      min = Number(range[1]);
      max = Number(range[2]);
      if (max < 1 || min > max) findings.push(error('vcfa.vks.autoscaler-range', `Pool ${name}: "${count}" is not a range the autoscaler can use (min ≤ max, max ≥ 1).`, { source: SRC }));
    } else if (/^\d+$/.test(count)) {
      replicas = Number(count);
    } else {
      findings.push(error('vcfa.vks.bad-pool', `Pool ${name}: replicas "${count}" is neither a number nor a min-max range such as 2-6.`, { source: SRC }));
      replicas = 0;
    }
    const labels: (readonly [string, string])[] = [];
    for (const pair of listOf(labelsCell)) {
      const [key = '', value = ''] = pair.split('=').map((part) => part.trim());
      if (!LABEL_KEY.test(key) || !LABEL_VALUE.test(value)) findings.push(error('vcfa.vks.bad-label', `Pool ${name}: "${pair}" is not a Kubernetes label key=value.`, { source: SRC }));
      else labels.push([key, value]);
    }
    const taints: { key: string; value: string; effect: string }[] = [];
    for (const item of listOf(taintsCell)) {
      const m = /^([^=:\s]+)(?:=([^:\s]*))?:(\w+)$/.exec(item);
      if (!m || !EFFECTS.includes(m[3]!) || !LABEL_KEY.test(m[1]!)) findings.push(error('vcfa.vks.bad-taint', `Pool ${name}: "${item}" is not key=value:Effect with Effect one of ${EFFECTS.join(', ')}.`, { source: SRC }));
      else taints.push({ key: m[1]!, value: m[2] ?? '', effect: m[3]! });
    }
    const os = osCell.toLowerCase();
    if (os && os !== 'photon' && os !== 'ubuntu') findings.push(error('vcfa.vks.bad-os', `Pool ${name}: OS "${osCell}" is not photon or ubuntu.`, { source: SRC }));
    pools.push({ name, vmClass, ...(replicas !== undefined ? { replicas } : {}), ...(min !== undefined ? { min, max } : {}), zone, labels, taints, os });
  }
  const names = pools.map((p) => p.name);
  for (const dup of new Set(names.filter((n, i) => names.indexOf(n) !== i))) findings.push(error('vcfa.vks.duplicate-pool', `Pool ${dup} is in the table twice.`, { source: SRC }));
  if (pools.length === 0) findings.push(error('vcfa.vks.no-pools', 'The cluster has no worker pool.', { source: SRC }));
  return { pools, findings };
}

// ---------------------------------------------------------------------------
// A small YAML writer: the manifest is built once as an object, and written as
// the Cluster YAML, the JSON the package posts, and the template's manifest.

const PLAIN = /^[A-Za-z0-9_./][A-Za-z0-9_./:@+ -]*$/;

function scalar(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = String(value);
  if (PLAIN.test(text) && !/^(true|false|null|yes|no|on|off|~|[-+]?[0-9.]+([eE][-+]?\d+)?)$/i.test(text) && !/ #|: |\s$/.test(text)) return text;
  return JSON.stringify(text);
}

const isScalar = (value: unknown): boolean => value === null || typeof value !== 'object';

export function yamlOf(value: unknown, indent = 0): string[] {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.every(isScalar)) return [`${pad}[${value.map((v) => JSON.stringify(v)).join(', ')}]`];
    return value.flatMap((item) => {
      if (isScalar(item)) return [`${pad}- ${scalar(item)}`];
      const inner = yamlOf(item, indent + 2);
      return [`${pad}- ${inner[0]!.trimStart()}`, ...inner.slice(1)];
    });
  }
  const lines: string[] = [];
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const k = /^[A-Za-z0-9_.\/-]+$/.test(key) ? key : JSON.stringify(key);
    if (isScalar(v)) lines.push(`${pad}${k}: ${scalar(v)}`);
    else if (Array.isArray(v) && (v.length === 0 || v.every(isScalar))) lines.push(`${pad}${k}: [${v.map((x) => JSON.stringify(x)).join(', ')}]`);
    else if (!Array.isArray(v) && Object.keys(v as object).length === 0) lines.push(`${pad}${k}: {}`);
    else lines.push(`${pad}${k}:`, ...yamlOf(v, indent + 2));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// The blueprint

const OS_ANNOTATION = 'run.tanzu.vmware.com/resolve-os-image';

export const VKS_CLUSTER = automationBlueprint({
  id: 'vcfa_vks_cluster',
  platform: PLATFORM,
  label: 'A VKS Kubernetes cluster',
  group: 'Modern apps',
  description:
    'A vSphere Kubernetes Service cluster (formerly TKG) as a Cluster API Cluster with a topology class: control plane, node pools each with their VM class, replicas or an autoscaler range, zone, labels, taints and OS image, containerd / kubelet / etcd volumes, proxy and trusted CA, any other ClusterClass variable, and the VKS standard packages (cert-manager, Contour, ExternalDNS, Fluent Bit, Prometheus, VKS-supported Velero, Cluster Autoscaler) installed once it is up. Created by an Orchestrator package after a server-side dry run, and emitted as YAML for kubectl and as a CCI template for the All Apps catalog.',
  inputs: [
    { id: 'cluster_name', label: 'Cluster name', control: 'text', default: 'team-a-prod-01' },
    { id: 'namespace', label: 'Supervisor namespace', control: 'text', default: 'team-a-prod' },
    {
      id: 'environment',
      label: 'Environment',
      control: 'select',
      options: [
        { value: 'production', label: 'Production' },
        { value: 'non-production', label: 'Non-production' },
      ],
      default: 'production',
    },
    {
      id: 'cluster_class',
      label: 'Cluster class',
      control: 'combo',
      options: [
        { value: 'builtin-generic-v3.1.0', label: 'builtin-generic-v3.1.0' },
        { value: 'builtin-generic-v3.2.0', label: 'builtin-generic-v3.2.0' },
        { value: 'builtin-generic-v3.3.0', label: 'builtin-generic-v3.3.0' },
        { value: 'tanzukubernetescluster', label: 'tanzukubernetescluster (older)' },
      ],
      default: 'builtin-generic-v3.1.0',
      hint: 'Check with kubectl get clusterclass -A',
    },
    { id: 'k8s_version', label: 'Kubernetes release', control: 'text', default: 'v1.32.0+vmware.6-fips', hint: 'Check with kubectl get kr — must be a release the Supervisor offers' },
    {
      id: 'os_image',
      label: 'Node OS image',
      control: 'select',
      options: [
        { value: 'photon', label: 'Photon OS' },
        { value: 'ubuntu', label: 'Ubuntu' },
      ],
      default: 'photon',
      hint: 'A pool can override it in its OS column',
    },
    {
      id: 'control_plane',
      label: 'Control plane nodes',
      control: 'select',
      options: [
        { value: '3', label: '3 — survives a node failure' },
        { value: '1', label: '1 — development only' },
      ],
      default: '3',
    },
    {
      id: 'cp_vm_class',
      label: 'Control plane VM class',
      control: 'combo',
      options: [
        { value: 'guaranteed-medium', label: 'guaranteed-medium' },
        { value: 'guaranteed-large', label: 'guaranteed-large' },
        { value: 'best-effort-medium', label: 'best-effort-medium' },
      ],
      default: 'guaranteed-medium',
    },
    { id: 'node_pools', label: 'Worker pools', control: 'textarea', default: 'np-general | guaranteed-large | 3 | - | - | - | -', hint: POOL_HINT, help: 'Replicas is a number, or min-max (2-6) for the autoscaler. Zone is a vSphere Zone of the Supervisor. Labels: key=value, comma separated. Taints: key=value:NoSchedule, comma separated. OS: photon or ubuntu, empty for the cluster default.' },
    { id: 'storage_class', label: 'Storage class', control: 'text', default: 'vsan-default-storage-policy' },
    { id: 'pod_cidr', label: 'Pod CIDR', control: 'text', default: '192.168.0.0/16', hint: 'IPv4: VKS pod networks are not dual-stack' },
    { id: 'service_cidr', label: 'Service CIDR', control: 'text', default: '10.96.0.0/12', hint: 'IPv4: VKS service networks are not dual-stack' },
    { id: 'containerd_gb', label: 'containerd volume per worker (GiB)', control: 'number', default: 0, min: 0, max: 2000, hint: '0 keeps images on the OS disk', section: 'Volumes' },
    { id: 'kubelet_gb', label: 'kubelet volume per worker (GiB)', control: 'number', default: 0, min: 0, max: 2000, hint: '0 means none', section: 'Volumes' },
    { id: 'etcd_gb', label: 'etcd volume per control plane node (GiB)', control: 'number', default: 0, min: 0, max: 500, hint: '0 means none', section: 'Volumes' },
    { id: 'http_proxy', label: 'HTTP proxy', control: 'text', default: '', placeholder: 'http://proxy.example.com:3128', hint: 'Empty: no proxy. An IPv6 proxy is http://[2001:db8::10]:3128', section: 'Proxy and trust' },
    { id: 'https_proxy', label: 'HTTPS proxy', control: 'text', default: '', placeholder: 'http://proxy.example.com:3128', section: 'Proxy and trust' },
    { id: 'no_proxy', label: 'No proxy for', control: 'text', default: '', placeholder: '.example.com, 10.0.0.0/8, fd00::/8', hint: 'Comma-separated. The pod and service CIDRs and .svc are added', section: 'Proxy and trust' },
    { id: 'trust_ca', label: 'Trust a private CA on the nodes', control: 'toggle', default: false, section: 'Proxy and trust' },
    { id: 'trust_ca_name', label: 'CA name', control: 'text', default: 'corporate-root', showWhen: { input: 'trust_ca', equals: ['true'] }, section: 'Proxy and trust' },
    {
      id: 'packages',
      label: 'VKS standard packages',
      control: 'checklist',
      default: '',
      options: Object.entries(VKS_PACKAGES).map(([value, p]) => ({ value, label: p.label })),
      section: 'Packages',
    },
    { id: 'package_repo', label: 'Standard package repository', control: 'text', default: '', placeholder: 'projects.packages.broadcom.com/vsphere/supervisor/packages/<version>/vks-standard-packages:<version>', hint: 'The imgpkg bundle for your VKS release (release notes)', section: 'Packages' },
    { id: 'dns_zone', label: 'ExternalDNS zone', control: 'text', default: '', placeholder: 'apps.example.com', section: 'Packages' },
    { id: 'velero_bucket', label: 'Velero bucket', control: 'text', default: '', section: 'Packages' },
    { id: 'velero_s3_url', label: 'Velero S3 URL', control: 'text', default: '', placeholder: 'https://s3.example.com', section: 'Packages' },
    { id: 'velero_region', label: 'Velero region', control: 'text', default: '', placeholder: 'us-east-1', section: 'Packages' },
    { id: 'extra_variables', label: 'Other ClusterClass variables', control: 'textarea', default: '', placeholder: 'ntp | {"servers": ["ntp1.example.com"]}', hint: 'Variable | JSON value', section: 'Advanced' },
  ],
  automation: (values: BlueprintValues, name: string): Automation => {
    const clusterName = str(values, 'cluster_name', 'cluster').toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const namespace = str(values, 'namespace', '');
    const production = str(values, 'environment', 'production') === 'production';
    const clusterClass = str(values, 'cluster_class', 'builtin-generic-v3.1.0');
    const version = str(values, 'k8s_version', '');
    const osImage = str(values, 'os_image', 'photon');
    const cpCount = Number(str(values, 'control_plane', '3'));
    const cpClass = str(values, 'cp_vm_class', 'guaranteed-medium');
    const storageClass = str(values, 'storage_class', '');
    const podCidr = str(values, 'pod_cidr', '192.168.0.0/16');
    const serviceCidr = str(values, 'service_cidr', '10.96.0.0/12');
    const containerdGb = num(values, 'containerd_gb', 0);
    const kubeletGb = num(values, 'kubelet_gb', 0);
    const etcdGb = num(values, 'etcd_gb', 0);
    const httpProxy = str(values, 'http_proxy', '');
    const httpsProxy = str(values, 'https_proxy', '');
    const noProxy = listOf(str(values, 'no_proxy', ''));
    const trust = bool(values, 'trust_ca', false);
    const caName = str(values, 'trust_ca_name', 'corporate-root').replace(/[^A-Za-z0-9-]/g, '-') || 'corporate-root';
    const packages = listOf(str(values, 'packages', '')).filter((p) => VKS_PACKAGES[p]);
    const packageRepo = str(values, 'package_repo', '');
    const dnsZone = str(values, 'dns_zone', '');
    const veleroBucket = str(values, 'velero_bucket', '');
    const veleroS3Url = str(values, 'velero_s3_url', '');
    const veleroRegion = str(values, 'velero_region', '');
    const base = slugOf(name || clusterName, 'vks-cluster');
    const legacyClass = clusterClass === 'tanzukubernetescluster';
    const proxied = Boolean(httpProxy || httpsProxy);

    const { pools, findings } = parsePools(str(values, 'node_pools', ''));
    const autoscaled = pools.filter((p) => p.min !== undefined);

    if (production && cpCount === 1) {
      findings.push(warning('vcfa.vks.single-control-plane', 'A production cluster with one control plane node loses its API server, and etcd, with that one VM.', { remediation: 'Three control plane nodes. The cost is two VMs; the saving is not rebuilding a cluster from backup.', source: SRC }));
    }
    if (production && (cpClass.startsWith('best-effort') || pools.some((p) => p.vmClass.startsWith('best-effort')))) {
      findings.push(warning('vcfa.vks.best-effort-prod', 'Production nodes on a best-effort VM class have no CPU or memory reservation.', { remediation: 'Under contention the nodes are squeezed first, and Kubernetes sees it as nodes going NotReady. Use guaranteed classes in production.', source: SRC }));
    }
    for (const pool of pools) {
      const floor = pool.min ?? pool.replicas ?? 0;
      if (production && floor < 2) {
        findings.push(warning('vcfa.vks.single-worker', `Pool ${pool.name}: ${floor} worker${floor === 1 ? '' : 's'} means any node drain — including an upgrade — takes the workload down.`, { remediation: 'At least two workers per pool (or a minimum of two for an autoscaled pool), three if pod disruption budgets are in use.', source: SRC }));
      }
    }
    if (autoscaled.length > 0 && !packages.includes('cluster-autoscaler')) {
      findings.push(warning('vcfa.vks.autoscaler-no-package', `Pool${autoscaled.length > 1 ? 's' : ''} ${autoscaled.map((p) => p.name).join(', ')} ${autoscaled.length > 1 ? 'have' : 'has'} a min-max range, but the Cluster Autoscaler package is not installed, so nothing scales them.`, { remediation: 'Tick Cluster Autoscaler under the standard packages; the range sits on the pool as annotations it reads.', source: SRC }));
    }
    const zones = pools.map((p) => p.zone);
    if (zones.some(Boolean) && zones.some((z) => !z)) {
      findings.push(info('vcfa.vks.mixed-zones', 'Some pools name a zone and some do not; the ones without land wherever the Supervisor puts them.', { source: SRC }));
    }
    if (production && zones.some(Boolean) && new Set(zones.filter(Boolean)).size === 1) {
      findings.push(warning('vcfa.vks.one-zone', `Every pool with a zone is in ${zones.find(Boolean)}; losing that zone loses every worker.`, { remediation: 'On a three-zone Supervisor, spread pools (one per zone) so a zone failure takes a third of the capacity.', source: SRC }));
    }
    if (!namespace) findings.push(error('vcfa.vks.no-namespace', 'A VKS cluster lives in a Supervisor namespace, and none is set.', { source: SRC }));
    if (!version) findings.push(error('vcfa.vks.no-version', 'No Kubernetes release is set.', { remediation: 'kubectl get kr lists the releases this Supervisor offers.', source: SRC }));
    if (legacyClass) findings.push(info('vcfa.vks.legacy-class', 'tanzukubernetescluster is the older ClusterClass. Newer VKS releases ship builtin-generic classes and move new features there.', { source: SRC }));
    for (const [what, value] of [['Pod', podCidr], ['Service', serviceCidr]] as const) {
      const blocks = listOf(value);
      if (blocks.some((b) => familyOf(b) === 6)) {
        findings.push(error('vcfa.vks.ipv6', `${what} CIDR ${value}: VKS clusters on vSphere Supervisor do not support IPv6 or dual-stack pod and service networks.`, { remediation: 'Use one IPv4 block. VERIFY: IPv6 and dual-stack in the release notes of your VKS version and its Antrea before planning around them.', source: SRC }));
      } else if (blocks.length !== 1 || familyOf(blocks[0]!) !== 4 || !blocks[0]!.includes('/')) {
        findings.push(error('vcfa.vks.bad-cidr', `${what} CIDR "${value}" is not one IPv4 CIDR.`, { source: SRC }));
      }
    }
    if (familyOf(podCidr) === 4 && familyOf(serviceCidr) === 4 && overlapsAny(podCidr, serviceCidr)) {
      findings.push(error('vcfa.vks.cidr-overlap', `The pod CIDR ${podCidr} overlaps the service CIDR ${serviceCidr}.`, { remediation: 'Pods and services need separate ranges, and neither may overlap the Supervisor workload network or anything the pods must reach.', source: SRC }));
    }
    for (const [label, url] of [['HTTP proxy', httpProxy], ['HTTPS proxy', httpsProxy]] as const) {
      if (url && !/^https?:\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(:\d+)?\/?$/.test(url)) findings.push(error('vcfa.vks.bad-proxy', `${label} "${url}" is not http(s)://host:port (an IPv6 address in brackets).`, { source: SRC }));
      if (/@/.test(url)) findings.push(error('vcfa.vks.proxy-credential', `${label} carries a user or password in its URL, which would sit in the Cluster object for every namespace editor to read.`, { remediation: 'Use a proxy that authorises by source address, or one without credentials for the node network.', source: SRC }));
    }
    if (proxied && noProxy.length === 0) {
      findings.push(warning('vcfa.vks.no-proxy-list', 'A proxy is set with no exceptions besides the cluster’s own networks, so calls to the Supervisor, vCenter and the image registry go through it.', { remediation: 'Add the Supervisor and vCenter networks, the registry and your internal domains to No proxy for.', source: SRC }));
    }
    if (production && containerdGb === 0) {
      findings.push(info('vcfa.vks.no-containerd-volume', 'Container images share the node’s OS disk; a large image pull can fill it and take the node NotReady.', { source: SRC }));
    }
    if (packages.length > 0 && !packageRepo) {
      findings.push(warning('vcfa.vks.no-package-repo', 'Packages are ticked but no standard package repository is set, so the install script stops at the <REQUIRED> image.', { remediation: 'Take the repository (an imgpkg bundle) from the release notes of your VKS version.', source: SRC }));
    }
    if (packages.includes('contour') && !packages.includes('cert-manager')) {
      findings.push(error('vcfa.vks.contour-needs-cert-manager', 'Contour needs cert-manager installed first.', { remediation: 'Tick cert-manager as well.', source: SRC }));
    }
    if (packages.includes('velero') && (!veleroBucket || !veleroS3Url)) {
      findings.push(error('vcfa.vks.velero-target', 'Velero is ticked with no bucket or S3 URL to back up to.', { remediation: 'Set the bucket and S3 URL; the credentials come from VELERO_CREDENTIALS_FILE when the install script runs, never from these files.', source: SRC }));
    }
    if (packages.includes('external-dns') && !dnsZone) {
      findings.push(warning('vcfa.vks.external-dns-zone', 'ExternalDNS has no zone to write to, so its domain filter is <REQUIRED>.', { remediation: 'Give it one zone; a filter is what stops a cluster writing records anywhere its DNS account can.', source: SRC }));
    }
    const extra: { name: string; value: unknown }[] = [];
    for (const [varName = '', raw = ''] of rowsOf(str(values, 'extra_variables', ''), 2)) {
      try {
        extra.push({ name: varName, value: JSON.parse(raw) });
      } catch {
        findings.push(error('vcfa.vks.bad-variable', `ClusterClass variable ${varName}: "${raw}" is not JSON.`, { source: SRC }));
      }
    }

    // ClusterClass variables. The tanzukubernetescluster class names are the
    // documented TKG 2.x ones; builtin-generic-v3.x groups them differently
    // (node.labels/taints, volumes, osConfiguration). Both are VERIFY against
    // kubectl get clusterclass <class> -o yaml, and the server-side dry run
    // refuses a variable the class does not declare before anything is built.
    const effectiveNoProxy = [...noProxy, podCidr, serviceCidr, '.svc', '.svc.cluster.local', 'localhost', '127.0.0.1'];
    const volume = (volName: string, mountPath: string, gb: number) => ({ name: volName, mountPath, capacity: { storage: `${gb}Gi` }, ...(storageClass ? { storageClass } : {}) });
    const workerVolumes = [...(containerdGb > 0 ? [volume('containerd', '/var/lib/containerd', containerdGb)] : []), ...(kubeletGb > 0 ? [volume('kubelet', '/var/lib/kubelet', kubeletGb)] : [])];
    const proxyValue = proxied ? { httpProxy: httpProxy || httpsProxy, httpsProxy: httpsProxy || httpProxy, noProxy: effectiveNoProxy } : undefined;
    const trustSecret = `${clusterName}-user-trusted-ca-secret`;
    const clusterVariables: { name: string; value: unknown }[] = [
      { name: 'vmClass', value: cpClass },
      { name: 'storageClass', value: storageClass || '<REQUIRED>' },
      ...(legacyClass ? [{ name: 'defaultStorageClass', value: storageClass || '<REQUIRED>' }] : []),
      ...(etcdGb > 0 ? [{ name: 'controlPlaneVolumes', value: [volume('etcd', '/var/lib/etcd', etcdGb)] }] : []),
      ...(legacyClass
        ? [...(proxyValue ? [{ name: 'proxy', value: proxyValue }] : []), ...(trust ? [{ name: 'trust', value: { additionalTrustedCAs: [{ name: caName }] } }] : [])]
        : proxyValue || trust
          ? [{ name: 'osConfiguration', value: { ...(proxyValue ? { systemProxy: { http: proxyValue.httpProxy, https: proxyValue.httpsProxy, noProxy: proxyValue.noProxy } } : {}), ...(trust ? { trust: { additionalTrustedCAs: [{ caCert: { secretRef: { name: trustSecret, key: caName } } }] } } : {}) } }]
          : []),
      ...extra,
    ];
    const poolOverrides = (pool: Pool): { name: string; value: unknown }[] => [
      { name: 'vmClass', value: pool.vmClass || '<REQUIRED>' },
      ...(legacyClass
        ? [
            ...(pool.labels.length > 0 ? [{ name: 'nodePoolLabels', value: pool.labels.map(([key, value]) => ({ key, value })) }] : []),
            ...(pool.taints.length > 0 ? [{ name: 'nodePoolTaints', value: pool.taints }] : []),
            ...(workerVolumes.length > 0 ? [{ name: 'nodePoolVolumes', value: workerVolumes }] : []),
          ]
        : [
            ...(pool.labels.length > 0 || pool.taints.length > 0 ? [{ name: 'node', value: { ...(pool.labels.length > 0 ? { labels: Object.fromEntries(pool.labels) } : {}), ...(pool.taints.length > 0 ? { taints: pool.taints } : {}) } }] : []),
            ...(workerVolumes.length > 0 ? [{ name: 'volumes', value: workerVolumes }] : []),
          ]),
    ];
    const machineDeployment = (pool: Pool, replicas: unknown) => {
      const poolOs = pool.os || osImage;
      const annotations: Record<string, string> = {
        ...(poolOs !== osImage ? { [OS_ANNOTATION]: `os-name=${poolOs}` } : {}),
        ...(pool.min !== undefined ? { 'cluster.x-k8s.io/cluster-api-autoscaler-node-group-min-size': String(pool.min), 'cluster.x-k8s.io/cluster-api-autoscaler-node-group-max-size': String(pool.max) } : {}),
      };
      return {
        class: 'node-pool',
        name: pool.name,
        ...(Object.keys(annotations).length > 0 ? { metadata: { annotations } } : {}),
        ...(pool.zone ? { failureDomain: pool.zone } : {}),
        // An autoscaled pool leaves replicas to the autoscaler: a value here is reset on every reconcile.
        ...(pool.min === undefined ? { replicas } : {}),
        variables: { overrides: poolOverrides(pool) },
      };
    };
    const topology = (replicas: (pool: Pool) => unknown) => ({
      class: clusterClass,
      ...(legacyClass ? {} : { classNamespace: 'vmware-system-vks-public' }),
      version: version || '<REQUIRED>',
      controlPlane: { replicas: cpCount },
      workers: { machineDeployments: pools.map((pool) => machineDeployment(pool, replicas(pool))) },
      variables: clusterVariables,
    });
    const labels = { environment: production ? 'production' : 'non-production', 'managed-by': 'vcf-automation' };
    const clusterNetwork = { services: { cidrBlocks: [serviceCidr] }, pods: { cidrBlocks: [podCidr] }, serviceDomain: 'cluster.local' };
    const clusterObject = {
      apiVersion: 'cluster.x-k8s.io/v1beta1',
      kind: 'Cluster',
      metadata: { name: clusterName, namespace: namespace || '<REQUIRED>', labels, annotations: { [OS_ANNOTATION]: `os-name=${osImage}` } },
      spec: { clusterNetwork, topology: topology((pool) => pool.replicas ?? 0) },
    };

    const cluster = [
      `# VKS cluster ${clusterName}`,
      '# Apply in the Supervisor namespace with kubectl.',
      '#',
      `# Class ${clusterClass}: confirm it exists with  kubectl get clusterclass -A`,
      `# Release ${version}: confirm it is offered with kubectl get kr`,
      '# ClusterClass variable names: VERIFY with',
      `#   kubectl get clusterclass ${clusterClass} -n ${legacyClass ? '<namespace>' : 'vmware-system-vks-public'} -o yaml`,
      '# builtin-generic-v3.x and tanzukubernetescluster name these differently.',
      ...yamlOf(clusterObject),
      '',
    ].join('\n');

    const fixedPools = pools.filter((p) => p.min === undefined);
    const minWorkers = production ? 2 : 1;
    const template = [
      `# VKS cluster ${clusterName}, as a CCI cloud template for the All Apps catalogue.`,
      '# The Cluster manifest is the same one as the YAML beside this file; the',
      '# template adds constrained inputs (workers applies to every fixed-size pool).',
      'formatVersion: 2',
      'inputs:',
      '  name:',
      '    type: string',
      '    pattern: "^[a-z0-9]([-a-z0-9]{0,40}[a-z0-9])?$"',
      `    default: ${clusterName}`,
      '  workers:',
      '    type: integer',
      `    minimum: ${minWorkers}`,
      '    maximum: 50',
      `    default: ${Math.max(minWorkers, fixedPools[0]?.replicas ?? 3)}`,
      'resources:',
      '  # The namespace the cluster goes in. A CCI.Supervisor.Resource names its',
      '  # namespace by binding to a CCI.Supervisor.Namespace resource of the same',
      '  # template (VMware, "CCI in templates"); existing: true refers to one that',
      '  # is already there instead of requesting a new one (VERIFY on your release).',
      '  namespace:',
      '    type: CCI.Supervisor.Namespace',
      '    properties:',
      `      name: ${namespace || '<REQUIRED — the Supervisor namespace>'}`,
      '      existing: true',
      '  cluster:',
      '    type: CCI.Supervisor.Resource',
      '    properties:',
      `      context: \${resource.namespace.id}`,
      '      manifest:',
      ...yamlOf(
        {
          apiVersion: 'cluster.x-k8s.io/v1beta1',
          kind: 'Cluster',
          metadata: { name: '${input.name}', labels, annotations: { [OS_ANNOTATION]: `os-name=${osImage}` } },
          spec: { clusterNetwork, topology: topology(() => '${input.workers}') },
        },
        8,
      ),
      '      # VERIFY the wait conditions against a template made in the All Apps designer.',
      '      wait:',
      '        conditions:',
      '          - type: Ready',
      '            status: "True"',
      '',
    ].join('\n');

    // The packages, installed in the workload cluster once it is Ready.
    const pkgValues: PackageValues = { clusterName, dnsZone, veleroBucket, veleroRegion, veleroS3Url, pools };
    const PACKAGE_NS = 'vks-packages';
    const packagesYaml = packages.length === 0
      ? ''
      : [
          `# The VKS standard packages for ${clusterName}, applied in the workload cluster`,
          '# (not the Supervisor namespace) by scripts/install-packages.sh.',
          '# Carvel packaging.carvel.dev/v1alpha1, with kapp-controller running in the',
          '# cluster as VKS installs it. VERIFY the package names and the repository',
          '# against: vcf package available list (or kubectl get packages -A).',
          ...[
            { apiVersion: 'v1', kind: 'Namespace', metadata: { name: PACKAGE_NS } },
            { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'package-installer', namespace: PACKAGE_NS } },
            {
              apiVersion: 'rbac.authorization.k8s.io/v1',
              kind: 'ClusterRoleBinding',
              metadata: { name: 'vks-package-installer' },
              roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'cluster-admin' },
              subjects: [{ kind: 'ServiceAccount', name: 'package-installer', namespace: PACKAGE_NS }],
            },
            { apiVersion: 'packaging.carvel.dev/v1alpha1', kind: 'PackageRepository', metadata: { name: 'vks-standard-packages', namespace: PACKAGE_NS }, spec: { fetch: { imgpkgBundle: { image: packageRepo || '<REQUIRED — the VKS standard package repository>' } } } },
            ...packages.flatMap((id) => {
              const p = VKS_PACKAGES[id]!;
              return [
                { apiVersion: 'v1', kind: 'Secret', metadata: { name: `${id}-values`, namespace: PACKAGE_NS }, stringData: { 'values.yaml': p.values(pkgValues) } },
                {
                  apiVersion: 'packaging.carvel.dev/v1alpha1',
                  kind: 'PackageInstall',
                  metadata: { name: id, namespace: PACKAGE_NS },
                  spec: { serviceAccountName: 'package-installer', packageRef: { refName: p.refName, versionSelection: { constraints: '>=0.0.0', prereleases: {} } }, values: [{ secretRef: { name: `${id}-values` } }] },
                },
              ];
            }),
          ].flatMap((doc) => ['---', ...yamlOf(doc)]),
          '',
        ].join('\n');

    const installScript = packages.length === 0
      ? ''
      : [
          '#!/usr/bin/env bash',
          `# Install the VKS standard packages (${packages.join(', ')}) in cluster ${clusterName}.`,
          '#',
          '# Run in the Supervisor namespace context (kubectl vsphere login or vcf context).',
          '# Waits for the cluster, reads its admin kubeconfig into a private temporary',
          '# file, and applies the packages in the workload cluster. Applies when run;',
          '# --dry-run runs a server-side dry run only.',
          ...(packages.includes('velero') ? ['#', '# VELERO_CREDENTIALS_FILE: a mode-600 file in the AWS credentials format for the', '# bucket. It is read here and never written to these files.'] : []),
          'set -euo pipefail',
          '',
          'command -v kubectl >/dev/null || { echo "kubectl is required" >&2; exit 2; }',
          `NS=${JSON.stringify(namespace || '<REQUIRED>')}`,
          `CLUSTER=${JSON.stringify(clusterName)}`,
          'MODE=()',
          '[[ "${1:-}" == "--dry-run" ]] && MODE=(--dry-run=server)',
          ...(packages.includes('velero') ? [': "${VELERO_CREDENTIALS_FILE:?set VELERO_CREDENTIALS_FILE to the S3 credentials file (mode 600)}"'] : []),
          '',
          'echo "Waiting for cluster $CLUSTER in $NS to be Ready (up to 60 minutes)"',
          'kubectl wait --for=condition=Ready "cluster/$CLUSTER" -n "$NS" --timeout=60m',
          '',
          'KC="$(umask 077; mktemp "${TMPDIR:-/tmp}/kubeconfig.XXXXXX")"',
          'trap \'rm -f "$KC"\' EXIT',
          '# VERIFY: the <cluster>-kubeconfig secret is readable by namespace editors on your',
          '# release; otherwise: kubectl vsphere login --tanzu-kubernetes-cluster-name "$CLUSTER".',
          'kubectl get secret "$CLUSTER-kubeconfig" -n "$NS" -o jsonpath=\'{.data.value}\' | base64 -d > "$KC"',
          '',
          ...(packages.includes('velero')
            ? [
                '# The S3 credentials first, so Velero finds them when it starts.',
                `kubectl --kubeconfig "$KC" create namespace velero --dry-run=client -o yaml | kubectl --kubeconfig "$KC" apply "\${MODE[@]}" -f -`,
                `kubectl --kubeconfig "$KC" -n velero create secret generic velero-s3-credentials --from-file=cloud="$VELERO_CREDENTIALS_FILE" --dry-run=client -o yaml | kubectl --kubeconfig "$KC" apply "\${MODE[@]}" -f -`,
              ]
            : []),
          `kubectl --kubeconfig "$KC" apply "\${MODE[@]}" -f '${base}-packages.k8s.yaml'`,
          '',
          'if [[ ${#MODE[@]} -gt 0 ]]; then',
          '  echo "Server-side dry run only. Nothing was installed. Run it without --dry-run to apply."',
          'else',
          `  kubectl --kubeconfig "$KC" get packageinstall -n ${PACKAGE_NS}`,
          'fi',
          '',
          `# Undo: kubectl --kubeconfig <kubeconfig> delete packageinstall <name> -n ${PACKAGE_NS} removes a package and what it installed.`,
          '',
        ].join('\n');

    // The package: the Cluster created through the Supervisor's Kubernetes API
    // after a server-side dry run (?dryRun=All). With a trusted CA, the secret
    // the class reads it from is created first. What exists is left alone.
    const vksPkgName = packageNameOf('vcfa', 'vks', base);
    const vksWorkflow = elementName(`Create VKS cluster ${clusterName}`);
    const nodes = cpCount + pools.reduce((sum, p) => sum + (p.max ?? p.replicas ?? 0), 0);
    const vksPkg = toPackage({
      packageName: vksPkgName,
      description: `Creates the VKS cluster ${clusterName} in a Supervisor namespace.`,
      categoryPath: `Automation/VKS/${base}`,
      workflow: {
        name: vksWorkflow,
        description: `Creates the VKS cluster ${clusterName} (${cpCount} control plane, ${pools.length} pool(s)) in the Supervisor namespace set in the configuration element${trust ? ', with the trusted CA secret created first' : ''}: validated first by the API server (server-side dry run), then created. A cluster of that name is left as it is. Set the dryRun input to true to preview without changing anything.`,
        inputs: [{ name: 'dryRun', type: 'boolean', description: 'true: validate on the server and change nothing' }],
        outputs: [
          { name: 'clusterName', type: 'string', description: 'The cluster, empty in a dry run that would create it' },
          { name: 'summary', type: 'string', description: 'The audit record, JSON' },
        ],
        script: [
          `var TRUST = ${trust};`,
          `var TRUST_SECRET = ${JSON.stringify(trustSecret)};`,
          `var CA_NAME = ${JSON.stringify(caName)};`,
          'var ctx = core.begin(settings, dryRun);',
          String.raw`if (!settings.supervisorHost || !settings.supervisorUsername || !settings.supervisorPassword) throw new Error("Set supervisorHost, supervisorUsername and supervisorPassword in the configuration element " + SETTINGS_NAME + ".");
if (!settings.namespace) throw new Error("Set namespace in the configuration element: the Supervisor namespace the cluster goes in.");
if (TRUST && !settings.trustedCaPem) throw new Error("Set trustedCaPem in the configuration element: the PEM of the CA the nodes should trust.");
var host = String(settings.supervisorHost);
var ns = String(settings.namespace);
var cluster = JSON.parse(core.resource(RESOURCE_PATH, "cluster.json"));
cluster.metadata.namespace = ns;
if (JSON.stringify(cluster).indexOf("<REQUIRED") >= 0) throw new Error("cluster.json still has a <REQUIRED> value (Kubernetes release, storage class or a pool VM class); set it on the page and import the package again.");
var auth = mod.loginSupervisor(host, settings.supervisorUsername, settings.supervisorPassword);
var SAFE = { redact: settings._secrets };
if (TRUST) {
  var nsSecretsUrl = "https://" + host + "/api/v1/namespaces/" + encodeURIComponent(ns) + "/secrets";
  var had = core.http("GET", nsSecretsUrl + "/" + encodeURIComponent(TRUST_SECRET), auth, null, { redact: settings._secrets, allow: [404] });
  if (had.statusCode === 200) {
    System.log("Exists, left as it is: secret " + TRUST_SECRET + " in " + ns);
  } else {
    var data = {};
    // TKG 2.x documents the CA as base64 of the base64-encoded PEM; VERIFY for your class.
    data[CA_NAME] = core.base64(core.base64(String(settings.trustedCaPem)));
    core.act(ctx, "create secret " + TRUST_SECRET + " (trusted CA " + CA_NAME + ") in " + ns, function () {
      return core.http("POST", nsSecretsUrl, auth, { apiVersion: "v1", kind: "Secret", metadata: { name: TRUST_SECRET, namespace: ns }, type: "Opaque", data: data }, SAFE);
    });
  }
}
var api = "https://" + host + "/apis/cluster.x-k8s.io/v1beta1/namespaces/" + encodeURIComponent(ns) + "/clusters";
var name = String(cluster.metadata.name);
var found = core.http("GET", api + "/" + encodeURIComponent(name), auth, null, { redact: settings._secrets, allow: [404] });
var created = "";
if (found.statusCode === 200) {
  var topology = (found.body && found.body.spec && found.body.spec.topology) || {};
  System.log("Exists, left as it is: cluster " + name + " in " + ns + " (" + (topology.version || "?") + "). Change it with kubectl, or delete it and run again.");
  created = name;
} else {
  // The API server checks the ClusterClass, its variables, the release, the
  // VM classes and the admission webhooks, and persists nothing.
  core.http("POST", api + "?dryRun=All", auth, cluster, SAFE);
  System.log("Server-side dry run passed: the Supervisor accepts cluster " + name + " in " + ns + ".");
  created = core.act(ctx, "create VKS cluster " + name + " in " + ns, function () {
    core.http("POST", api, auth, cluster, SAFE);
    return name;
  }) || "";
}
clusterName = created;
summary = core.audit(ctx, { clusterName: created, namespace: ns, note: "kubectl get cluster " + name + " -n " + ns + " shows its progress." });
core.notify(settings.webhook, summary);`,
        ].join('\n'),
      },
      actions: [
        {
          name: 'loginSupervisor',
          description:
            'A Supervisor: POST https://<supervisor>/wcp/login with Basic authorization answers { session_id }, the token kubectl vsphere login keeps. Returns { Authorization: "Bearer <session_id>" }. VERIFY on your release: the exchange follows the kubectl-vsphere plugin, not a published API reference.',
          resultType: 'Any',
          params: [pa('host', 'string', 'Supervisor control plane address'), pa('username', 'string', 'A vSphere SSO account that may edit the namespace'), pa('password', 'string', 'From a SecureString attribute')],
          script: String.raw`var core = System.getModule("vcf.automation.core");
var r = core.http("POST", "https://" + host + "/wcp/login", { "Authorization": "Basic " + core.base64(String(username) + ":" + String(password)) }, null, { redact: [password] });
if (!r.body || !r.body.session_id) throw new Error("The Supervisor at " + host + " returned no session.");
return { "Authorization": "Bearer " + r.body.session_id };`,
        },
      ],
      config: {
        name: 'Settings',
        description: `Settings of the ${vksWorkflow} workflow. Fill supervisorPassword after import; set dryRun to true to preview instead of changing anything.`,
        attributes: [
          { name: 'supervisorHost', type: 'string', value: '', description: 'The Supervisor control plane address (as in kubectl vsphere login --server)' },
          { name: 'supervisorUsername', type: 'string', value: '', description: 'A vSphere SSO account with edit rights on the namespace' },
          { name: 'supervisorPassword', type: 'SecureString', description: 'Its password' },
          { name: 'namespace', type: 'string', value: namespace, description: 'The Supervisor namespace the cluster goes in' },
          ...(trust ? [{ name: 'trustedCaPem', type: 'string' as const, value: '', description: `The PEM of the CA "${caName}" the nodes trust (a certificate, not a secret)` }] : []),
          ...guardSettings(trust ? 2 : 1, 'created'),
        ],
      },
      resources: [{ name: 'cluster.json', content: json(clusterObject) }],
    });

    const imported = importBundle({
      templates: [{ name: `VKS cluster (${clusterClass})`, description: `A VKS cluster with ${cpCount} control plane nodes and ${pools.length} pool(s).`, yaml: template, org: 'all-apps' }],
    });

    return {
      platform: PLATFORM,
      title: `VKS cluster ${clusterName} — ${cpCount} control plane, ${pools.map((p) => `${p.name} ${p.min !== undefined ? `${p.min}-${p.max}` : p.replicas} × ${p.vmClass}`).join(', ')}`,
      effect: 'reversible',
      trigger: { kind: 'request', detail: `kubectl apply in ${namespace || 'the namespace'}, the package workflow, or a request of the CCI template from the All Apps catalogue`, worstCase: `once per request — up to ${nodes} VMs each time${autoscaled.length > 0 ? ', growing on its own to each pool’s maximum' : ''}` },
      scope: {
        what: `Up to ${nodes} VMs (${cpCount} control plane, ${nodes - cpCount} workers at most) in the Supervisor namespace ${namespace || '(none)'}${packages.length > 0 ? `, and the packages ${packages.join(', ')} inside the cluster` : ''}.`,
        decidedBy: [
          `The namespace ${namespace || '(none)'} — its limits, VM classes and storage classes bound what can be built.`,
          `The ClusterClass ${clusterClass}, which decides what "control plane" and "node-pool" mean and which variables it takes.`,
          `The Kubernetes release ${version || '(none)'} and the OS (${osImage}), which pick the node image.`,
          ...(autoscaled.length > 0 ? [`The autoscaler ranges on ${autoscaled.map((p) => `${p.name} (${p.min}-${p.max})`).join(', ')}.`] : []),
          'Who can create Cluster objects in the namespace — namespace editors.',
        ],
        ifWrong: 'A cluster larger than the namespace can hold sits half-built with machines Pending; one on the wrong release has to be upgraded in place or rebuilt.',
      },
      guardrails: [
        { rule: 'Bounded by the namespace limits and VM classes', because: 'The namespace is the quota. A cluster request cannot exceed what the namespace class allows.' },
        ...(cpCount === 3 ? [{ rule: 'Three control plane nodes', because: 'etcd needs a quorum. One node is one VM failure from a lost cluster.' }] : []),
        ...(pools.every((p) => !p.vmClass.startsWith('best-effort')) ? [{ rule: 'Workers on guaranteed classes', because: 'Guaranteed classes reserve CPU and memory, so node pressure comes from pods rather than from the host.' }] : []),
        ...(autoscaled.length > 0 ? [{ rule: `Autoscaled pools capped at ${autoscaled.map((p) => `${p.name} ${p.max}`).join(', ')}`, because: 'The autoscaler adds nodes when pods are pending; the maximum is what stops a runaway deployment filling the namespace.' }] : []),
        { rule: 'Server-side dry run before creating', because: 'The Supervisor checks the class, its variables, the release and the VM class binding. It is the fastest way to find a typo in any of them.' },
      ],
      dryRun: [
        `Run the package workflow ${vksWorkflow} with the dryRun input set to true: it sends the Cluster to the Supervisor as a server-side dry run only (?dryRun=All — validated, not persisted), logs "DRY RUN: would create …" and creates nothing.`,
        'Run scripts/apply-kubectl.sh --dry-run: kubectl apply --dry-run=server validates the Cluster against the ClusterClass and the namespace.',
        ...(packages.length > 0 ? ['Run scripts/install-packages.sh --dry-run once the cluster is Ready: the packages are validated in the cluster and nothing is installed.'] : []),
        `kubectl get clusterclass -A and kubectl get kr, and check ${clusterClass} and ${version} are both listed.`,
      ],
      undo: [
        'kubectl delete cluster <name> -n <namespace>, or delete the deployment. The VMs and their disks are removed; persistent volumes follow their reclaim policy.',
        `Anything running in the cluster is gone with it. Back up workloads first — with VKS-supported Velero${packages.includes('velero') ? ', installed here' : ' (tick it under packages)'}.`,
      ],
      told: ['kubectl get cluster and kubectl describe cluster in the namespace show progress and failures.', 'The deployment History tab for catalogue requests.', 'The package workflow’s audit record, posted to the webhook when one is set.'],
      requires: [
        PKG_REQUIRES,
        `The Supervisor namespace ${namespace || '(set one)'} with ${[...new Set([cpClass, ...pools.map((p) => p.vmClass)])].join(', ')} VM classes and the storage class ${storageClass || '(set one)'} bound to it.`,
        ...(pools.some((p) => p.zone) ? [`The vSphere Zones ${[...new Set(pools.map((p) => p.zone).filter(Boolean))].join(', ')} on the Supervisor.`] : []),
        'kubectl and the VCF CLI (or kubectl vsphere plugin) logged in to the Supervisor.',
        'For the template: an All Apps organisation in VCF Automation.',
      ],
      files: {
        [`${base}-cluster.yaml`]: cluster,
        [`${base}-cci-template.yaml`]: template,
        [`${base}-cci-template.json`]: json(templatePayload(`VKS cluster (${clusterClass})`, `A VKS cluster with ${cpCount} control plane nodes.`, template)),
        ...(trust
          ? {
              [`${base}-trusted-ca.k8s.yaml`]: [
                `# The secret the ${legacyClass ? 'trust variable' : 'osConfiguration.trust variable'} names. Apply in the Supervisor namespace before the cluster.`,
                '# data.<name> is base64 of the base64-encoded PEM, as TKG 2.x documents it (VERIFY for your class):',
                `#   base64 -w0 ca.pem | base64 -w0`,
                ...yamlOf({ apiVersion: 'v1', kind: 'Secret', metadata: { name: trustSecret, namespace: namespace || '<REQUIRED>' }, type: 'Opaque', data: { [caName]: '<REQUIRED — base64 of base64 of the PEM>' } }),
                '',
              ].join('\n'),
            }
          : {}),
        ...(packages.length > 0 ? { [`${base}-packages.k8s.yaml`]: packagesYaml, 'scripts/install-packages.sh': underScripts(installScript) } : {}),
        ...vksPkg.files,
        'scripts/apply-kubectl.sh': underScripts(kubectlScript(`Create VKS cluster ${clusterName} in ${namespace || 'the namespace'}.`, [...(trust ? [`${base}-trusted-ca.k8s.yaml`] : []), `${base}-cluster.yaml`], `kubectl delete cluster ${clusterName} -n ${namespace || '<namespace>'} — deletes every node.`)),
        'scripts/apply.sh': underScripts(applyScript('vcf-automation', [{ method: 'POST', path: '/blueprint/api/blueprints', payload: `${base}-cci-template.json` }], 'DELETE /blueprint/api/blueprints/{id}. Clusters already requested are not deleted.')),
        ...imported.files,
        'IMPORT.md': importMd({
          subject: `The VKS cluster ${clusterName}: created in the Supervisor namespace by the Orchestrator package (\`${vksPkg.packageDir}\`, workflow **${vksWorkflow}**, server-side dry run first), and as a blueprint for the All Apps catalog and a Cluster manifest for kubectl.${packages.length > 0 ? ` Then the standard packages ${packages.join(', ')} with \`scripts/install-packages.sh\`.` : ''}`,
          orgs: 'VCF Automation 9.1 / 9.1.1 All Apps organizations (and a Supervisor namespace, for the package and the kubectl route)',
          steps: [
            ...packageSteps(vksPkg),
            imported.steps.templates,
            kubeStep('Or create it directly in the namespace', 'scripts/apply-kubectl.sh', [...(trust ? [`${base}-trusted-ca.k8s.yaml`] : []), `${base}-cluster.yaml`], [`It uses \`kubectl apply\`, which suits a Supervisor namespace context (${namespace || 'set one'}); against the VCF Automation endpoint use \`kubectl create -f ${base}-cluster.yaml\`.${trust ? ` Fill the CA in \`${base}-trusted-ca.k8s.yaml\` first.` : ''}`], { expectContext: false }),
            ...(packages.length > 0
              ? [
                  manualStep('The standard packages', [
                    `Once the cluster is Ready: \`./scripts/install-packages.sh\` in the Supervisor namespace context (\`--dry-run\` validates only). It waits for the cluster, reads its kubeconfig into a private temporary file, and applies \`${base}-packages.k8s.yaml\` — the package repository and one PackageInstall per package, each with its values in a Secret.${packages.includes('velero') ? ' Set VELERO_CREDENTIALS_FILE (mode 600) first; the script turns it into the velero-s3-credentials secret.' : ''}`,
                    'Fill every <REQUIRED> in the values first (the Fluent Bit output host, the ExternalDNS provider). The same packages can be installed by hand with `vcf package install <name> -p <refName> --values-file <file>`.',
                  ]),
                ]
              : []),
          ],
          auth: ['import', 'kube'],
          verify: [
            ...verifyFor(imported),
            'The template binds the cluster to a CCI.Supervisor.Namespace resource with `context: ${resource.namespace.id}`, the form VMware’s "CCI in templates" blog shows; `existing: true` on the namespace is from community examples — compare with a template made in the All Apps blueprint designer.',
            'The package logs in to the Supervisor at /wcp/login (Basic authorization, answering { session_id }) as the kubectl-vsphere plugin does; that exchange is not in a published API reference — VERIFY it on your release.',
            `Cluster API cluster.x-k8s.io/v1beta1 and the builtin-generic ClusterClass in vmware-system-vks-public are what VKS 3.x ships. The variable names written here — ${legacyClass ? 'vmClass, storageClass, defaultStorageClass, nodePoolLabels, nodePoolTaints, nodePoolVolumes, controlPlaneVolumes, proxy, trust (the documented tanzukubernetescluster set)' : 'vmClass, storageClass, node (labels, taints), volumes, controlPlaneVolumes, osConfiguration (systemProxy, trust)'} — are VERIFY (kubectl get clusterclass ${clusterClass} -o yaml); the server-side dry run refuses one the class does not declare.`,
            `The OS image annotation ${OS_ANNOTATION}: os-name=<photon|ubuntu> is the documented TKG 2.x form for a v1beta1 Cluster and its machine deployments; VERIFY on VKS 3.x.`,
            'The autoscaler reads cluster.x-k8s.io/cluster-api-autoscaler-node-group-min-size / -max-size on each machine deployment (Cluster API autoscaler provider), and replicas is left out of an autoscaled pool so reconciling does not reset it.',
            ...(packages.length > 0 ? ['The standard package names (<name>.kubernetes.vmware.com), the repository bundle, and the values keys of each package are VERIFY: vcf package available list, and vcf package available get <name>/<version> --values-schema. BYO Velero is deprecated in 9.1; the VKS-supported Velero package is the supported route.'] : []),
          ],
        }),
      },
      notes: [
        'The ClusterClass name and its variables change between VKS releases. kubectl get clusterclass <name> -o yaml shows what yours expects; set any other variable under Other ClusterClass variables.',
        'The Kubernetes release string must match one the Supervisor offers exactly. kubectl get kr lists them, with READY and COMPATIBLE columns — both must be True.',
        'A proxy set on the cluster reaches containerd and the node OS. The pod and service CIDRs, .svc and localhost are added to the exceptions here; the Supervisor, vCenter and your registry have to be added by you.',
        'Packages go into the workload cluster, not the Supervisor namespace: install-packages.sh switches to the cluster’s own kubeconfig for them.',
      ],
      findings,
    };
  },
});
