/**
 * Kubernetes manifests — for GKE, AKS, EKS, OKE and vSphere Kubernetes alike.
 *
 * The checks are the ones that stop an apply: a missing name, a name the API
 * server will refuse, and an apiVersion that has been removed (the Kubernetes
 * deprecated-API migration guide lists the release each was removed in).
 * Secrets written into a manifest are called out.
 *
 * Every built-in kind is also checked field by field against the release's
 * OpenAPI schema (../kubernetes-schema.ts): a field the kind does not have, a
 * required one left out, a value of the wrong type, and one outside a closed
 * set. Quantities (`500m`, `1Gi`, `2`), int-or-string fields (`targetPort:
 * http` or `8080`) and free maps (labels, annotations, ConfigMap data) are
 * what the API server takes them as. A custom resource's schema is its CRD's,
 * which the file does not carry, so its fields are not checked.
 */

import { warning, error, info,              } from '../../core/findings.js';
import { pathString,                      } from '../doc.js';
import { didYouMean, isExpression, isObj, keysOf, last, str,              } from '../profile.js';
import {
  KUBERNETES_SCHEMA_SOURCE,
  KUBERNETES_VERSION,
  apiVersionsOf,
  enumOf,
  groupOf,
  isBuiltinApiVersion,
  isBuiltinGroup,
  isListNode,
  isMapNode,
  isObjectNode,
  kindSchema,
  kindsOf,
  loadKind,
  nodeAt,
  resolve,
  typeOf,
  versionsOf,
             
} from '../kubernetes-schema.js';

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

// ---------------------------------------------------------------------------
// Field-level checks against the release's schema
// ---------------------------------------------------------------------------

/** resource.Quantity: a signed decimal with an optional SI, binary-SI or exponent suffix. */
const QUANTITY = /^[+-]?(\d+(\.\d*)?|\.\d+)([KMGTPE]i|[numkMGTPE]|[eE][+-]?\d+)?$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const WANTS                                   = {
  s: 'text',
  B: 'base64 text',
  i: 'a whole number',
  n: 'a number',
  b: 'true or false',
  q: 'a quantity (such as 250m, 2 or 1Gi)',
  io: 'a number or a name',
  o: 'a set of fields',
  m: 'a set of key: value pairs',
  a: 'a list',
};

function described(value      )         {
  if (Array.isArray(value)) return 'a list';
  if (isObj(value)) return 'a set of fields';
  if (typeof value === 'string') return `the text “${value.length > 40 ? `${value.slice(0, 40)}…` : value}”`;
  return `${typeof value === 'number' ? 'the number' : 'the value'} ${String(value)}`;
}

/** Whether a value has the type a scalar code asks for. */
function fits(code        , value      )          {
  switch (code) {
    case 's':
    case 'B':
      return typeof value === 'string';
    case 'i':
      return typeof value === 'number' && Number.isInteger(value);
    case 'n':
      return typeof value === 'number';
    case 'b':
      return typeof value === 'boolean';
    case 'q':
      return typeof value === 'number' || (typeof value === 'string' && QUANTITY.test(value.trim()));
    case 'io':
      return typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value));
    default:
      return true;
  }
}

/** Where a field is, for a message: “spec.template” or “the Deployment”. */
function where(path      , kind        )         {
  return path.length ? pathString(path) : `the ${kind}`;
}

function checkNode(node                   , value      , path      , kind        , out           )       {
  const n = resolve(node);
  // null is what the API server takes as "not set"; an expression is decided later.
  if (n === undefined || value === null || value === undefined) return;
  if (typeof value === 'string' && isExpression(value)) return;
  const at = pathString(path) || undefined;
  const code = typeOf(n);
  const wrong = (want        )       => {
    out.push(
      error('k8s.field.type', `${pathString(path) || kind} should be ${want}, not ${described(value)}.`, {
        path: at,
        source: KUBERNETES_SCHEMA_SOURCE,
      }),
    );
  };
  if (code === '*') return;
  if (isObjectNode(n)) {
    if (!isObj(value)) return wrong(WANTS.o          );
    const fields = Object.keys(n.p);
    for (const [key, child] of Object.entries(value)) {
      if (key === '<<') continue; // a YAML merge key
      if (Object.hasOwn(n.p, key)) {
        checkNode(n.p[key], child, [...path, key], kind, out);
        continue;
      }
      const guess = didYouMean(key, fields);
      out.push(
        error('k8s.field.unknown', `${where(path, kind)} has no field “${key}”${guess ? `; did you mean “${guess}”?` : '.'}`, {
          path: pathString([...path, key]),
          remediation: guess ? `Rename it to ${guess}.` : `The fields here are: ${fields.join(', ')}.`,
          source: KUBERNETES_SCHEMA_SOURCE,
        }),
      );
    }
    for (const req of n.r ?? []) {
      if (value[req] === undefined || value[req] === null) {
        out.push(
          error('k8s.field.required', `${where(path, kind)} needs ${req}.`, {
            path: pathString([...path, req]),
            source: KUBERNETES_SCHEMA_SOURCE,
          }),
        );
      }
    }
    return;
  }
  if (isMapNode(n)) {
    if (!isObj(value)) return wrong(WANTS.m          );
    for (const [key, child] of Object.entries(value)) checkNode(n.v, child, [...path, key], kind, out);
    return;
  }
  if (isListNode(n)) {
    if (!Array.isArray(value)) return wrong(WANTS.a          );
    value.forEach((item, i) => checkNode(n.i, item, [...path, i], kind, out));
    return;
  }
  if (code === 'o') {
    if (!isObj(value)) wrong(WANTS.o          );
    return;
  }
  if (!fits(code, value)) return wrong(WANTS[code] ?? code);
  if (code === 'B' && typeof value === 'string') {
    const text = value.replace(/[\r\n]/g, '');
    if (text.length % 4 !== 0 || !BASE64.test(text)) {
      out.push(
        error('k8s.field.base64', `${pathString(path)} is not valid base64.`, {
          path: at,
          remediation: 'Encode the value (base64 -w0), or put it in stringData, which takes plain text.',
        }),
      );
    }
    return;
  }
  const allowed = enumOf(n);
  if (allowed && value !== '' && !allowed.includes(value                             )) {
    const options = allowed.filter((a) => a !== '').map(String);
    const guess = typeof value === 'string' ? didYouMean(value, options) : undefined;
    out.push(
      error('k8s.field.enum', `${pathString(path)} cannot be ${described(value)}${guess ? `; did you mean “${guess}”?` : '.'}`, {
        path: at,
        remediation: `One of: ${options.join(', ')}.`,
        source: KUBERNETES_SCHEMA_SOURCE,
      }),
    );
  }
}

/** The schema findings for one object: its kind, its apiVersion, and every field. */
function schemaFindings(doc                         , apiVersion        , kind        )            {
  if (REMOVED[apiVersion] || kind === 'List') return [];
  if (!isBuiltinApiVersion(apiVersion)) {
    const group = groupOf(apiVersion);
    if (isBuiltinGroup(group)) {
      const served = versionsOf(group);
      return [
        warning('k8s.apiVersion.unknown', `Kubernetes ${KUBERNETES_VERSION} does not serve ${apiVersion}.`, {
          path: 'apiVersion',
          remediation: `This group is served as ${served.join(', ')}.`,
          source: KUBERNETES_SCHEMA_SOURCE,
        }),
      ];
    }
    return [
      info('k8s.schema.custom', `${kind} (${apiVersion}) is a custom resource; its fields are checked only by its CustomResourceDefinition, which is not in this file.`, {
        path: 'kind',
      }),
    ];
  }
  const known = kindsOf(apiVersion);
  if (!known.includes(kind)) {
    const elsewhere = apiVersionsOf(kind);
    const guess = didYouMean(kind, known);
    return [
      warning('k8s.kind.unknown', `${apiVersion} has no kind ${kind}${guess ? `; did you mean ${guess}?` : '.'}`, {
        path: 'kind',
        remediation: elsewhere.length
          ? `${kind} is served as ${elsewhere.join(', ')}; change the apiVersion.`
          : guess
            ? `Use ${guess}.`
            : 'Check the kind and apiVersion against kubectl api-resources.',
        source: KUBERNETES_SCHEMA_SOURCE,
      }),
    ];
  }
  const root = kindSchema(apiVersion, kind);
  const out            = [];
  // Not loaded yet (in the browser, until prepare resolves): the rest waits.
  if (root !== undefined) checkNode(root, doc, [], kind, out);
  return out;
}

/** The closed set the schema gives the field at `path`, when there is one. */
function schemaChoices(path      , doc      )                                {
  if (!isObj(doc)) return undefined;
  const apiVersion = str(doc.apiVersion);
  const kind = str(doc.kind);
  if (!apiVersion || !kind) return undefined;
  const root = kindSchema(apiVersion, kind);
  if (root === undefined) return undefined;
  const node = nodeAt(root, path);
  if (node === undefined) return undefined;
  const allowed = enumOf(node);
  const strings = allowed?.filter((v)              => typeof v === 'string' && v !== '');
  return strings?.length ? strings : undefined;
}

function union(...lists                                   )                                {
  const out           = [];
  for (const list of lists) for (const v of list ?? []) if (!out.includes(v)) out.push(v);
  return out.length ? out : undefined;
}

/** The checks that need no schema: apiVersion, kind, name, namespace, secrets, containers. */
function baseFindings(doc      )            {
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
}

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
    // The schema's closed set for this very field, when it has one, over any set known by name alone.
    const bySchema = schemaChoices(path, doc);
    if (bySchema) return union(byContext, bySchema);
    if (byContext) return byContext;
    const key = last(path);
    return typeof key === 'string' ? FIELD_CHOICES[key] : undefined;
  },
  prepare(doc) {
    if (!isObj(doc)) return Promise.resolve();
    const apiVersion = str(doc.apiVersion);
    const kind = str(doc.kind);
    if (!apiVersion || !kind) return Promise.resolve();
    // A schema that cannot be fetched leaves the other checks standing.
    return loadKind(apiVersion, kind).catch(() => undefined);
  },
  validate(doc) {
    const out = baseFindings(doc);
    if (isObj(doc)) {
      const apiVersion = str(doc.apiVersion);
      const kind = str(doc.kind);
      if (apiVersion && kind) out.push(...schemaFindings(doc, apiVersion, kind));
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
