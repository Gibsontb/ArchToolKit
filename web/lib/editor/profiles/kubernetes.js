/**
 * Kubernetes manifests — for GKE, AKS, EKS, OKE and vSphere Kubernetes alike.
 *
 * The checks are the ones that stop an apply: a missing name, a name the API
 * server will refuse, and an apiVersion that has been removed (the Kubernetes
 * deprecated-API migration guide lists the release each was removed in).
 * Secrets written into a manifest are called out.
 */

import { warning, error, info,              } from '../../core/findings.js';
                                            
import { isObj, keysOf, last, str,              } from '../profile.js';

const SOURCE = 'Kubernetes deprecated API migration guide (kubernetes.io/docs/reference/using-api/deprecation-guide)';

/** apiVersion → the release that removed it, and what replaces it. */
const REMOVED                                                                                 = {
  'extensions/v1beta1': { removedIn: '1.22', use: 'apps/v1 or networking.k8s.io/v1' },
  'apps/v1beta1': { removedIn: '1.16', use: 'apps/v1' },
  'apps/v1beta2': { removedIn: '1.16', use: 'apps/v1' },
  'networking.k8s.io/v1beta1': { removedIn: '1.22', use: 'networking.k8s.io/v1' },
  'rbac.authorization.k8s.io/v1beta1': { removedIn: '1.22', use: 'rbac.authorization.k8s.io/v1' },
  'apiextensions.k8s.io/v1beta1': { removedIn: '1.22', use: 'apiextensions.k8s.io/v1' },
  'admissionregistration.k8s.io/v1beta1': { removedIn: '1.22', use: 'admissionregistration.k8s.io/v1' },
  'certificates.k8s.io/v1beta1': { removedIn: '1.22', use: 'certificates.k8s.io/v1' },
  'coordination.k8s.io/v1beta1': { removedIn: '1.22', use: 'coordination.k8s.io/v1' },
  'scheduling.k8s.io/v1beta1': { removedIn: '1.22', use: 'scheduling.k8s.io/v1' },
  'batch/v1beta1': { removedIn: '1.25', use: 'batch/v1' },
  'policy/v1beta1': { removedIn: '1.25', use: 'policy/v1 (PodSecurityPolicy has no replacement; use Pod Security Admission)' },
  'autoscaling/v2beta1': { removedIn: '1.25', use: 'autoscaling/v2' },
  'autoscaling/v2beta2': { removedIn: '1.26', use: 'autoscaling/v2' },
  'discovery.k8s.io/v1beta1': { removedIn: '1.25', use: 'discovery.k8s.io/v1' },
  'events.k8s.io/v1beta1': { removedIn: '1.25', use: 'events.k8s.io/v1' },
  'node.k8s.io/v1beta1': { removedIn: '1.25', use: 'node.k8s.io/v1' },
  'flowcontrol.apiserver.k8s.io/v1beta2': { removedIn: '1.29', use: 'flowcontrol.apiserver.k8s.io/v1' },
  'flowcontrol.apiserver.k8s.io/v1beta3': { removedIn: '1.32', use: 'flowcontrol.apiserver.k8s.io/v1' },
};

/** Kinds that live in no namespace, so a namespace on them is ignored. */
const CLUSTER_SCOPED = new Set([
  'Namespace', 'Node', 'PersistentVolume', 'ClusterRole', 'ClusterRoleBinding', 'StorageClass',
  'CustomResourceDefinition', 'PriorityClass', 'IngressClass', 'RuntimeClass', 'CSIDriver', 'VolumeAttachment',
  'MutatingWebhookConfiguration', 'ValidatingWebhookConfiguration', 'APIService',
]);

const FIELD_CHOICES                                              = {
  imagePullPolicy: ['Always', 'IfNotPresent', 'Never'],
  restartPolicy: ['Always', 'OnFailure', 'Never'],
  dnsPolicy: ['ClusterFirst', 'ClusterFirstWithHostNet', 'Default', 'None'],
  protocol: ['TCP', 'UDP', 'SCTP'],
  externalTrafficPolicy: ['Cluster', 'Local'],
  internalTrafficPolicy: ['Cluster', 'Local'],
  sessionAffinity: ['None', 'ClientIP'],
  volumeMode: ['Filesystem', 'Block'],
  persistentVolumeReclaimPolicy: ['Retain', 'Delete', 'Recycle'],
  reclaimPolicy: ['Retain', 'Delete'],
  volumeBindingMode: ['Immediate', 'WaitForFirstConsumer'],
  concurrencyPolicy: ['Allow', 'Forbid', 'Replace'],
  podManagementPolicy: ['OrderedReady', 'Parallel'],
  ipFamilyPolicy: ['SingleStack', 'PreferDualStack', 'RequireDualStack'],
  pathType: ['Exact', 'Prefix', 'ImplementationSpecific'],
  operator: ['In', 'NotIn', 'Exists', 'DoesNotExist', 'Gt', 'Lt', 'Equal'],
  effect: ['NoSchedule', 'PreferNoSchedule', 'NoExecute'],
  whenUnsatisfiable: ['DoNotSchedule', 'ScheduleAnyway'],
};

/** Choices that depend on where the field is, not only its name. */
function contextual(keys          , doc      )                                {
  const kind = isObj(doc) ? str(doc.kind) : undefined;
  const at = keys.join('.');
  if (at === 'spec.type' && kind === 'Service') return ['ClusterIP', 'NodePort', 'LoadBalancer', 'ExternalName'];
  if (at === 'spec.strategy.type' && kind === 'Deployment') return ['RollingUpdate', 'Recreate'];
  if (at === 'spec.updateStrategy.type') return kind === 'DaemonSet' || kind === 'StatefulSet' ? ['RollingUpdate', 'OnDelete'] : undefined;
  if (at === 'type' && kind === 'Secret') {
    return [
      'Opaque', 'kubernetes.io/tls', 'kubernetes.io/dockerconfigjson', 'kubernetes.io/dockercfg', 'kubernetes.io/basic-auth',
      'kubernetes.io/ssh-auth', 'kubernetes.io/service-account-token', 'bootstrap.kubernetes.io/token',
    ];
  }
  if (keys[keys.length - 1] === 'accessModes') return ['ReadWriteOnce', 'ReadOnlyMany', 'ReadWriteMany', 'ReadWriteOncePod'];
  if (at.endsWith('policyTypes')) return ['Ingress', 'Egress'];
  return undefined;
}

const DNS_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
/** Kinds whose names must be a DNS label (63 characters, no dots), not a subdomain. */
const LABEL_NAMED = new Set(['Namespace', 'Service']);

export const kubernetes          = {
  id: 'kubernetes',
  family: 'kubernetes',
  label: 'Kubernetes manifest',
  format: 'yaml',
  source: SOURCE,
  detect(doc) {
    if (!isObj(doc)) return 0;
    const a = str(doc.apiVersion);
    const k = str(doc.kind);
    if (!a || !k) return 0;
    // CloudFormation and ARM never have both; F5 and DM never have either.
    return isObj(doc.metadata) ? 0.9 : 0.6;
  },
  choices(path      , doc      ) {
    const keys = keysOf(path);
    const byContext = contextual(keys, doc);
    if (byContext) return byContext;
    const key = last(path);
    if (typeof key === 'number') {
      // a list of plain values: accessModes[0]
      return contextual(keys, doc);
    }
    return typeof key === 'string' ? FIELD_CHOICES[key] : undefined;
  },
  validate(doc) {
    const out            = [];
    if (!isObj(doc)) return out;
    const apiVersion = str(doc.apiVersion);
    const kind = str(doc.kind);
    if (!apiVersion) out.push(error('k8s.apiVersion.missing', 'Every object needs an apiVersion.', { path: 'apiVersion' }));
    if (!kind) out.push(error('k8s.kind.missing', 'Every object needs a kind.', { path: 'kind' }));
    const removed = apiVersion ? REMOVED[apiVersion] : undefined;
    if (removed) {
      out.push(
        error('k8s.apiVersion.removed', `${apiVersion} was removed in Kubernetes ${removed.removedIn}; a current cluster will refuse this ${kind ?? 'object'}.`, {
          path: 'apiVersion',
          remediation: `Use ${removed.use}. Field names can differ between versions; check the migration guide.`,
          source: SOURCE,
        }),
      );
    }
    if (kind === 'List') return out;
    const meta = doc.metadata;
    if (!isObj(meta)) {
      out.push(error('k8s.metadata.missing', 'Every object needs metadata with a name.', { path: 'metadata' }));
      return out;
    }
    const name = str(meta.name);
    if (!name && !str(meta.generateName)) {
      out.push(error('k8s.name.missing', `This ${kind ?? 'object'} has no name.`, { path: 'metadata.name' }));
    } else if (name && !name.includes('{{')) {
      const label = kind !== undefined && LABEL_NAMED.has(kind);
      const ok = label ? DNS_LABEL.test(name) && name.length <= 63 : DNS_SUBDOMAIN.test(name) && name.length <= 253;
      if (!ok) {
        out.push(
          error('k8s.name.invalid', `“${name}” is not a valid ${kind ?? 'object'} name.`, {
            path: 'metadata.name',
            remediation: label
              ? 'Lower-case letters, digits and hyphens, starting and ending with a letter or digit, at most 63 characters.'
              : 'Lower-case letters, digits, hyphens and dots, starting and ending with a letter or digit.',
          }),
        );
      }
    }
    if (kind && CLUSTER_SCOPED.has(kind) && meta.namespace !== undefined) {
      out.push(warning('k8s.namespace.ignored', `A ${kind} belongs to no namespace; the namespace here is ignored.`, { path: 'metadata.namespace' }));
    }
    if (kind === 'Secret') {
      for (const key of ['stringData', 'data']         ) {
        const block = doc[key];
        if (isObj(block) && Object.keys(block).length > 0) {
          out.push(
            warning('k8s.secret.inline', `This Secret carries its values in the manifest (${key}${key === 'data' ? ', base64 is not encryption' : ', in clear text'}).`, {
              path: key,
              remediation: 'Keep the manifest out of source control, or use Sealed Secrets, External Secrets or the cloud’s secret store CSI driver.',
            }),
          );
        }
      }
    }
    // Containers without resource requests schedule anywhere and are the first evicted.
    const podSpec = kind === 'Pod' ? doc.spec : isObj(doc.spec) && isObj(doc.spec.template) ? doc.spec.template.spec : undefined;
    const specPath = kind === 'Pod' ? 'spec' : 'spec.template.spec';
    if (isObj(podSpec) && Array.isArray(podSpec.containers)) {
      podSpec.containers.forEach((c, i) => {
        if (!isObj(c)) return;
        if (!str(c.image)) out.push(error('k8s.container.image', 'A container needs an image.', { path: `${specPath}.containers[${i}].image` }));
        else if (/:latest$/.test(c.image          ) || !/[:@]/.test((c.image          ).split('/').pop() ?? '')) {
          out.push(info('k8s.container.latest', `${c.image} is not pinned to a version, so what runs can change on the next pull.`, { path: `${specPath}.containers[${i}].image` }));
        }
        if (!isObj(c.resources) || (!isObj(c.resources.requests) && !isObj(c.resources.limits))) {
          out.push(info('k8s.container.resources', `Container ${str(c.name) ?? i} sets no resource requests.`, { path: `${specPath}.containers[${i}]` }));
        }
      });
    }
    return out;
  },
  itemTitle(value) {
    if (!isObj(value)) return undefined;
    const kind = str(value.kind);
    const name = isObj(value.metadata) ? str(value.metadata.name) : undefined;
    if (kind) return name ? `${kind} ${name}` : kind;
    return str(value.name) ?? str(value.containerPort        ) ?? undefined;
  },
};
