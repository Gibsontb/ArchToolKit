/**
 * Containers (addendum A.4.2, A.4.7): Kubernetes, OpenShift and Docker hosts.
 *
 * `pattern.k8s.target`: `containers` on the chosen platform. OpenShift has
 * managed offers on each cloud (ROSA, ARO, OpenShift Dedicated on Google Cloud
 * (GCP), OpenShift on OCI), shown as report-only. A Docker host is a refactor
 * candidate. The move is Velero (one backup per app namespace set, in a bucket
 * in the target cloud) plus an image copy (crane / skopeo).
 *
 * Cutover (A.4.7): scale the source deployments to 0 (recorded for rollback),
 * take a final backup, restore, switch DNS / ingress; rollback scales the
 * source back up.
 */

import { info } from '../../../core/findings.ts';
import { rule, type AnyRule } from '../decide/engine.ts';
import type { Platform, Workload } from '../types.ts';
import { fact, patternOf, type PatternEntry } from './model.ts';

export const CONTAINER_SOURCES = {
  velero: 'https://velero.io/docs/main/',
  veleroVsphere: 'https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-service-administration-and-development/9-0/managing-vsphere-kuberenetes-service-clusters-and-workloads/backup-and-restore-workloads-using-the-velero-plugin-for-vsphere.html',
  skopeo: 'https://github.com/containers/skopeo/blob/main/docs/skopeo-sync.1.md',
  rosa: 'https://docs.aws.amazon.com/rosa/latest/userguide/what-is-rosa.html',
  aro: 'https://learn.microsoft.com/en-us/azure/openshift/intro-openshift',
  osd: 'https://www.redhat.com/en/technologies/cloud-computing/openshift/dedicated',
  ociOpenshift: 'https://docs.oracle.com/en-us/iaas/Content/openshift-on-oci/overview.htm',
} as const;

/** The managed OpenShift offer per platform (report-only). */
export const OPENSHIFT_OFFERS: Readonly<Partial<Record<Platform, { readonly name: string; readonly source: string }>>> = {
  aws: { name: 'Red Hat OpenShift Service on AWS (ROSA)', source: CONTAINER_SOURCES.rosa },
  azure: { name: 'Azure Red Hat OpenShift (ARO)', source: CONTAINER_SOURCES.aro },
  google: { name: 'Red Hat OpenShift Dedicated on Google Cloud', source: CONTAINER_SOURCES.osd },
  oci: { name: 'Red Hat OpenShift on OCI', source: CONTAINER_SOURCES.ociOpenshift },
};

const REGISTRY: PatternEntry['artefacts']['terraform'] = {
  aws: ['aws_ecr_repository', 'aws_s3_bucket'],
  azure: ['azurerm_container_registry', 'azurerm_storage_account', 'azurerm_storage_container'],
  google: ['google_artifact_registry_repository', 'google_storage_bucket'],
  oci: ['oci_artifacts_container_repository', 'oci_objectstorage_bucket'],
};

const QUESTIONS: PatternEntry['questions'] = [
  { key: 'clusters', label: 'Clusters', kind: 'number' },
  { key: 'nodes', label: 'Nodes', kind: 'number' },
  { key: 'namespaces', label: 'Namespaces', kind: 'text' },
  { key: 'pvGib', label: 'Persistent volumes', kind: 'number', unit: 'GiB' },
  { key: 'images', label: 'Images', kind: 'number' },
  { key: 'distribution', label: 'Distribution', kind: 'select', options: ['upstream', 'openshift', 'rancher', 'vks'], default: 'upstream' },
];

const RUNBOOK = [
  'velero install --provider <aws|azure|gcp> --bucket … --plugins … on both clusters (VKS: the Velero plugin for vSphere).',
  'velero backup create atk-<app> --include-namespaces <ns> --default-volumes-to-fs-backup',
  'velero restore create --from-backup atk-<app> --resource-modifier-configmap atk-<app>-modifiers (storageClass and ingress-class remaps).',
  'Images: crane copy <src> <dst> per image list, or skopeo sync; registry credentials from the environment.',
  'Cutover: kubectl scale --replicas=0 on the source (recorded), final backup, restore, switch DNS / ingress. Rollback scales the source back up.',
];

const FACTS = [
  fact('Velero backs up and restores Kubernetes resources and volumes.', CONTAINER_SOURCES.velero, 'C'),
  fact('vSphere Kubernetes Service uses Velero with the Velero plugin for vSphere.', CONTAINER_SOURCES.veleroVsphere),
  fact('skopeo sync copies images between registries.', CONTAINER_SOURCES.skopeo, 'C'),
];

export const CONTAINER_PATTERNS: readonly PatternEntry[] = [
  {
    id: 'kubernetes',
    family: 'containers',
    kind: 'packaged',
    detectFrom: ['k8s-node'],
    questions: QUESTIONS,
    rules: ['pattern.k8s.target'],
    components: [{ name: 'Cluster', tier: 'platform', workloadTypes: ['k8s-node'], tierPattern: 'containers' }],
    methods: ['k8s-velero'],
    artefacts: { terraform: REGISTRY, ansibleModules: ['kubernetes.core.k8s', 'kubernetes.core.helm', 'kubernetes.core.k8s_scale'], runbook: RUNBOOK },
    sizing: 'k8s',
    status: 'automated',
    facts: FACTS,
  },
  {
    id: 'openshift',
    family: 'containers',
    kind: 'packaged',
    detectFrom: ['openshift-node'],
    questions: QUESTIONS,
    rules: ['pattern.k8s.target'],
    components: [{ name: 'Cluster', tier: 'platform', workloadTypes: ['openshift-node'], tierPattern: 'containers' }],
    methods: ['k8s-velero'],
    artefacts: { terraform: REGISTRY, ansibleModules: ['kubernetes.core.k8s', 'kubernetes.core.helm', 'kubernetes.core.k8s_scale'], runbook: [...RUNBOOK, 'A managed OpenShift (ROSA / ARO / OpenShift Dedicated / OpenShift on OCI) is a report-only alternative.'] },
    sizing: 'k8s',
    status: 'automated',
    facts: [...FACTS, ...Object.values(OPENSHIFT_OFFERS).map((o) => fact(`${o!.name} is a managed OpenShift option.`, o!.source))],
  },
  {
    id: 'docker-host',
    family: 'containers',
    kind: 'packaged',
    detectFrom: ['docker-host'],
    questions: [{ key: 'containers', label: 'Containers', kind: 'number' }, { key: 'images', label: 'Images', kind: 'number' }],
    rules: ['pattern.k8s.target'],
    components: [{ name: 'Docker hosts', tier: 'app', workloadTypes: ['docker-host'], tierPattern: 'vm', alternatives: ['containers', 'paas-web'] }],
    methods: ['rebuild', 'aws-mgn', 'azure-migrate', 'gcp-m2vm', 'oci-ocm'],
    artefacts: { terraform: REGISTRY, ansibleModules: ['community.docker.docker_container', 'community.docker.docker_image'], runbook: ['Copy the images (crane / skopeo) and recreate the containers, or refactor onto Kubernetes.'] },
    sizing: 'server',
    status: 'automated',
    facts: [fact('skopeo sync copies images between registries.', CONTAINER_SOURCES.skopeo, 'C')],
  },
];

export const CONTAINER_RULES: readonly AnyRule[] = [
  rule<Workload>({
    id: 'pattern.k8s.target',
    kind: 'workload',
    verification: 'V-DOC',
    source: CONTAINER_SOURCES.veleroVsphere,
    applies: (w, ctx) => ['kubernetes', 'openshift', 'docker-host'].includes(patternOf(w, ctx) ?? ''),
    findings: (w, ctx) =>
      patternOf(w, ctx) === 'docker-host'
        ? [info('pattern.k8s.docker-refactor', `${w.name}: a Docker host is a refactor candidate for managed Kubernetes or a container platform.`)]
        : [],
    review: (w, chosen, ctx) => {
      if (patternOf(w, ctx) !== 'openshift' || !chosen) return [];
      const offer = OPENSHIFT_OFFERS[chosen.platform];
      return offer ? [info('pattern.k8s.openshift-managed', `${w.name}: ${offer.name} is a managed alternative on ${chosen.platform} (report-only).`, { source: offer.source })] : [];
    },
  }),
];
