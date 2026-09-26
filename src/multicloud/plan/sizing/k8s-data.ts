/**
 * Kubernetes facts per platform (addendum A.2.8.5), as data: CNI pod-density
 * rules, node allocatable (kube-reserved and eviction) formulas, and the
 * control-plane tiers.
 *
 * 'V-DOC' = read from the provider's page on 2026-09-26; 'I' = recalled or
 * inferred, not re-read — verify before relying on it.
 */

import type { Verification } from '../../../vcf/provenance.ts';
import type { InstanceSpec } from '../../../kit/instance-specs.ts';
import type { Platform } from '../types.ts';

// ---------------------------------------------------------------------------
// CNI
// ---------------------------------------------------------------------------

export type CniMode =
  | 'eks-vpc-cni-prefix' | 'eks-vpc-cni'
  | 'aks-cni-overlay' | 'aks-cni-pod-subnet'
  | 'gke-vpc-native'
  | 'oke-vcn-native' | 'oke-flannel'
  | 'vks-antrea';

/** Where pod IPs come from, which decides the IP plan. */
export type PodAddressing = 'node-subnet' | 'pod-subnet' | 'overlay' | 'secondary-range';

export interface CniRule {
  readonly id: CniMode;
  readonly platform: Platform;
  readonly label: string;
  readonly addressing: PodAddressing;
  /** The provider's default max-pods setting. */
  readonly defaultMaxPods: number;
  /** The highest max-pods the provider allows. */
  readonly maxPodsLimit: number;
  /** The CNI's own per-node ceiling for a node type (ENI / VNIC limits), when it has one. */
  readonly nodeCeiling?: (spec: InstanceSpec | undefined) => number;
  /** Dual-stack pods and services. 'ipv6-only' = an IPv6 cluster, not dual-stack. */
  readonly dualStack: boolean | 'ipv6-only';
  readonly defaultPodCidr?: string;
  readonly defaultServiceCidr: string;
  readonly verification: Verification;
  readonly source: string;
  readonly note?: string;
}

/** EC2 ENIs and IPv4 addresses per ENI by size, for current Nitro m/c/r families (recalled; verify per type). */
export const EC2_ENI_LIMITS: Readonly<Record<string, readonly [enis: number, ipsPerEni: number]>> = {
  medium: [2, 4], large: [3, 10], xlarge: [4, 15], '2xlarge': [4, 15], '4xlarge': [8, 30], '8xlarge': [8, 30], '12xlarge': [8, 30],
  '16xlarge': [15, 50], '24xlarge': [15, 50], '32xlarge': [15, 50], '48xlarge': [15, 50], '96xlarge': [15, 50],
};

/** VNICs on an OCI Flex VM: one per OCPU, at least 2, at most 24 (recalled; verify). */
export const ociVnics = (ocpus: number): number => Math.min(24, Math.max(2, ocpus));

export const CNI_RULES: Readonly<Record<CniMode, CniRule>> = {
  'eks-vpc-cni-prefix': {
    id: 'eks-vpc-cni-prefix', platform: 'aws', label: 'Amazon VPC CNI, prefix delegation', addressing: 'node-subnet',
    defaultMaxPods: 110, maxPodsLimit: 250,
    nodeCeiling: (s) => ((s?.vcpu ?? 0) < 30 ? 110 : 250),
    dualStack: 'ipv6-only', defaultServiceCidr: '172.20.0.0/16', verification: 'I',
    source: 'https://docs.aws.amazon.com/eks/latest/best-practices/prefix-mode-linux.html',
    note: 'Pods take /28 prefixes from the node subnets. EKS recommends max-pods 110 below 30 vCPU and 250 above (verify); the default is 110 (V-DOC). EKS runs IPv4 or IPv6 clusters, not dual-stack.',
  },
  'eks-vpc-cni': {
    id: 'eks-vpc-cni', platform: 'aws', label: 'Amazon VPC CNI, secondary IPs', addressing: 'node-subnet',
    defaultMaxPods: 110, maxPodsLimit: 250,
    nodeCeiling: (s) => {
      const size = s?.name.split('.').pop() ?? '';
      const e = EC2_ENI_LIMITS[size];
      return e ? e[0] * (e[1] - 1) + 2 : 110;
    },
    dualStack: 'ipv6-only', defaultServiceCidr: '172.20.0.0/16', verification: 'I',
    source: 'https://docs.aws.amazon.com/eks/latest/userguide/cni-increase-ip-addresses.html',
    note: 'Max pods = ENIs × (IPs per ENI − 1) + 2 (ENI limits per type recalled; verify).',
  },
  'aks-cni-overlay': {
    id: 'aks-cni-overlay', platform: 'azure', label: 'Azure CNI Overlay', addressing: 'overlay',
    defaultMaxPods: 250, maxPodsLimit: 250, dualStack: true,
    defaultPodCidr: '10.244.0.0/16', defaultServiceCidr: '10.0.0.0/16', verification: 'V-DOC',
    source: 'https://learn.microsoft.com/en-us/azure/aks/concepts-network-ip-address-planning',
    note: 'Pods from a private overlay CIDR, a /24 per node; nodes only take VNet IPs. Dual-stack overlay is supported (verify per region).',
  },
  'aks-cni-pod-subnet': {
    id: 'aks-cni-pod-subnet', platform: 'azure', label: 'Azure CNI Pod Subnet', addressing: 'pod-subnet',
    defaultMaxPods: 110, maxPodsLimit: 250, dualStack: false,
    defaultServiceCidr: '10.0.0.0/16', verification: 'V-DOC',
    source: 'https://learn.microsoft.com/en-us/azure/aks/concepts-network-ip-address-planning',
  },
  'gke-vpc-native': {
    id: 'gke-vpc-native', platform: 'google', label: 'GKE VPC-native (alias IPs)', addressing: 'secondary-range',
    defaultMaxPods: 110, maxPodsLimit: 256, dualStack: true,
    defaultServiceCidr: '10.96.0.0/20', verification: 'V-DOC',
    source: 'https://docs.cloud.google.com/kubernetes-engine/docs/how-to/flexible-pod-cidr',
    note: 'Each node gets the smallest range holding twice its max pods (110 → /24). Standard allows up to 512 per node with a /22; capped at 256 here.',
  },
  'oke-vcn-native': {
    id: 'oke-vcn-native', platform: 'oci', label: 'OCI VCN-Native Pod Networking', addressing: 'pod-subnet',
    defaultMaxPods: 110, maxPodsLimit: 256,
    nodeCeiling: (s) => Math.min((ociVnics(s?.flex ? Math.ceil((s.vcpu || 2) / (s.flex.vcpuPerOcpu || 2)) : Math.ceil((s?.vcpu ?? 4) / 2)) - 1) * 31, 256),
    dualStack: true, defaultServiceCidr: '10.96.0.0/16', verification: 'V-DOC',
    source: 'https://docs.oracle.com/en-us/iaas/Content/ContEng/Concepts/contengpodnetworking_topic-OCI_CNI_plugin.htm',
    note: 'Max pods = min((VNICs − 1) × 31, 256) (V-DOC); VNICs per shape recalled (verify). Dual-stack support recalled (verify).',
  },
  'oke-flannel': {
    id: 'oke-flannel', platform: 'oci', label: 'Flannel overlay', addressing: 'overlay',
    defaultMaxPods: 110, maxPodsLimit: 110, dualStack: false,
    defaultPodCidr: '10.244.0.0/16', defaultServiceCidr: '10.96.0.0/16', verification: 'I',
    source: 'https://docs.oracle.com/en-us/iaas/Content/ContEng/Concepts/contengpodnetworking_topic-flannel_CNI_plugin.htm',
  },
  'vks-antrea': {
    id: 'vks-antrea', platform: 'vmware', label: 'Antrea (VKS)', addressing: 'overlay',
    defaultMaxPods: 110, maxPodsLimit: 110, dualStack: false,
    defaultPodCidr: '192.168.0.0/16', defaultServiceCidr: '10.96.0.0/12', verification: 'I',
    source: 'https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-service-administration-and-development/9-0.html',
  },
};

export const DEFAULT_CNI: Readonly<Record<Platform, CniMode>> = {
  aws: 'eks-vpc-cni-prefix', azure: 'aks-cni-overlay', google: 'gke-vpc-native', oci: 'oke-vcn-native', vmware: 'vks-antrea',
};

/** GKE: the per-node pod range for a max-pods value (V-DOC table: 110 → /24). */
export function gkeNodePodPrefix(maxPods: number): number {
  return 32 - Math.ceil(Math.log2(Math.max(8, maxPods) * 2));
}

// ---------------------------------------------------------------------------
// Allocatable
// ---------------------------------------------------------------------------

export interface Reserved { readonly cpuMillis: number; readonly memMib: number }

/** The CPU curve GKE, EKS, OKE and VKS use: 6 % of the first core, 1 % of the next, 0.5 % of the next two, 0.25 % above four. */
function cpuCurve(vcpu: number): number {
  const cores = vcpu;
  let m = 0;
  m += Math.min(cores, 1) * 60;
  m += Math.min(Math.max(cores - 1, 0), 1) * 10;
  m += Math.min(Math.max(cores - 2, 0), 2) * 5;
  m += Math.max(cores - 4, 0) * 2.5;
  return m;
}
function gkeMemory(gibs: number): number {
  if (gibs < 1) return 255;
  const tiers: [number, number][] = [[4, 0.25], [4, 0.2], [8, 0.1], [112, 0.06], [Infinity, 0.02]];
  let left = gibs;
  let res = 0;
  for (const [size, pct] of tiers) {
    const take = Math.min(left, size);
    res += take * pct;
    left -= take;
    if (left <= 0) break;
  }
  return res * 1024;
}
const AKS_CPU: readonly [number, number][] = [[1, 60], [2, 100], [4, 140], [8, 180], [16, 260], [32, 420], [64, 740]];

export interface AllocatableRule {
  readonly platform: Platform;
  readonly reserved: (vcpu: number, ramGib: number, maxPods: number) => Reserved;
  /** Hard eviction threshold, MiB. */
  readonly evictionMib: number;
  readonly verification: Verification;
  readonly source: string;
}

export const ALLOCATABLE: Readonly<Record<Platform, AllocatableRule>> = {
  aws: {
    platform: 'aws', evictionMib: 100, verification: 'I',
    reserved: (vcpu, _ram, maxPods) => ({ cpuMillis: cpuCurve(vcpu), memMib: 255 + 11 * maxPods }),
    source: 'https://docs.aws.amazon.com/eks/latest/userguide/eks-optimized-amis.html',
  },
  azure: {
    platform: 'azure', evictionMib: 100, verification: 'I',
    reserved: (vcpu, ram, maxPods) => ({
      cpuMillis: (AKS_CPU.find(([c]) => c >= vcpu) ?? AKS_CPU[AKS_CPU.length - 1]!)[1],
      memMib: Math.min(20 * maxPods + 50, ram * 1024 * 0.25),
    }),
    source: 'https://learn.microsoft.com/en-us/azure/aks/node-resource-reservations',
  },
  google: {
    platform: 'google', evictionMib: 100, verification: 'I',
    reserved: (vcpu, ram) => ({ cpuMillis: cpuCurve(vcpu), memMib: gkeMemory(ram) }),
    source: 'https://docs.cloud.google.com/kubernetes-engine/docs/concepts/plan-node-sizes',
  },
  oci: {
    platform: 'oci', evictionMib: 100, verification: 'I',
    reserved: (vcpu, ram) => ({ cpuMillis: cpuCurve(vcpu), memMib: gkeMemory(ram) }),
    source: 'https://docs.oracle.com/en-us/iaas/Content/ContEng/Tasks/contengmanagingnodepools.htm',
  },
  vmware: {
    platform: 'vmware', evictionMib: 100, verification: 'I',
    reserved: (vcpu, ram) => ({ cpuMillis: cpuCurve(vcpu), memMib: gkeMemory(ram) }),
    source: 'https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-service-administration-and-development/9-0.html',
  },
};

/** Allocatable CPU (millicores) and memory (MiB) of a node. */
export function allocatable(platform: Platform, vcpu: number, ramGib: number, maxPods: number): { cpuMillis: number; memMib: number; reserved: Reserved } {
  const r = ALLOCATABLE[platform];
  const res = r.reserved(vcpu, ramGib, maxPods);
  return { cpuMillis: Math.max(0, vcpu * 1000 - res.cpuMillis), memMib: Math.max(0, ramGib * 1024 - res.memMib - r.evictionMib), reserved: res };
}

// ---------------------------------------------------------------------------
// Control-plane tiers
// ---------------------------------------------------------------------------

export interface ControlPlaneTier {
  readonly id: string;
  readonly label: string;
  /** Carries a financially backed SLA. */
  readonly sla: boolean;
  readonly note: string;
}

export interface ControlPlaneTiers {
  readonly platform: Platform;
  readonly tiers: readonly ControlPlaneTier[];
  /** The default for production (the SLA-bearing tier). */
  readonly prodDefault: string;
  readonly nonprodDefault: string;
  readonly verification: Verification;
  readonly source: string;
}

export const CONTROL_PLANE_TIERS: Readonly<Record<Platform, ControlPlaneTiers>> = {
  aws: {
    platform: 'aws', prodDefault: 'standard', nonprodDefault: 'standard', verification: 'I',
    source: 'https://docs.aws.amazon.com/eks/latest/userguide/kubernetes-versions.html',
    tiers: [
      { id: 'standard', label: 'Standard support', sla: true, note: 'A Kubernetes version in its standard-support window (about 14 months).' },
      { id: 'extended', label: 'Extended support', sla: true, note: 'A further 12 months on a version, at a higher hourly control-plane price.' },
    ],
  },
  azure: {
    platform: 'azure', prodDefault: 'standard', nonprodDefault: 'free', verification: 'I',
    source: 'https://learn.microsoft.com/en-us/azure/aks/free-standard-pricing-tiers',
    tiers: [
      { id: 'free', label: 'Free', sla: false, note: 'No uptime SLA; for dev / test.' },
      { id: 'standard', label: 'Standard', sla: true, note: 'Financially backed uptime SLA; for production.' },
      { id: 'premium', label: 'Premium', sla: true, note: 'Standard plus Long-Term Support versions.' },
    ],
  },
  google: {
    platform: 'google', prodDefault: 'standard', nonprodDefault: 'standard', verification: 'I',
    source: 'https://docs.cloud.google.com/kubernetes-engine/docs/concepts/choose-cluster-mode',
    tiers: [
      { id: 'standard', label: 'Standard (regional)', sla: true, note: 'You size the node pools (this engine does).' },
      { id: 'autopilot', label: 'Autopilot', sla: true, note: 'Google sizes the nodes; only the pod requests are sized here.' },
    ],
  },
  oci: {
    platform: 'oci', prodDefault: 'enhanced', nonprodDefault: 'basic', verification: 'I',
    source: 'https://docs.oracle.com/en-us/iaas/Content/ContEng/Tasks/contengcomparingenhancedwithbasicclusters_topic.htm',
    tiers: [
      { id: 'basic', label: 'Basic cluster', sla: false, note: 'No financially backed SLA.' },
      { id: 'enhanced', label: 'Enhanced cluster', sla: true, note: 'SLA, virtual nodes, add-on management.' },
    ],
  },
  vmware: {
    platform: 'vmware', prodDefault: 'best-effort-medium:3', nonprodDefault: 'best-effort-small:1', verification: 'I',
    source: 'https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-service-administration-and-development/9-0.html',
    tiers: [
      { id: 'best-effort-small:1', label: 'Control plane best-effort-small × 1', sla: false, note: 'One control-plane VM.' },
      { id: 'best-effort-medium:3', label: 'Control plane best-effort-medium × 3', sla: true, note: 'Three control-plane VMs (HA).' },
      { id: 'guaranteed-medium:3', label: 'Control plane guaranteed-medium × 3', sla: true, note: 'Reserved CPU and memory.' },
    ],
  },
};
