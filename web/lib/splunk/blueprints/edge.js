/**
 * Splunk at the edge: Edge Processor and Ingest Processor pipelines, and the
 * Splunk OpenTelemetry Collector on Kubernetes and on hosts.
 *
 * What these have in common is that they decide what reaches an index before
 * it is licensed. That is the whole of their value, which is why a pipeline
 * that only says `from $source | into $destination` is worth nothing but an
 * extra hop, and why a masking pattern broad enough to hit timestamps and IP
 * addresses is worse than none — it destroys the fields every search needs and
 * does it before anything is stored.
 *
 * The collector blueprints are about the token. The HEC token is a credential
 * that can write to every index it is allowed; in Kubernetes it belongs in a
 * Secret that exists before the chart does, and on a host in a root-only
 * environment file — never in values.yaml, never in a Helm release's history,
 * never on an installer's command line.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, info, warning,              } from '../../core/findings.js';
import { splunkBlueprint,                      } from '../from-app.js';
import { listOf, splunkName,                } from '../splunk.js';

const TIER = 'edge'         ;

/** Masking patterns, as PCRE2 inside SPL2 slashes. */
const MASKS                                                                                  = {
  card: { regex: '\\b(?:\\d[ -]?){12,15}(\\d{4})\\b', replacement: 'XXXX-XXXX-XXXX-\\1', label: 'Payment card numbers, keeping the last four' },
  ssn: { regex: '\\b\\d{3}-\\d{2}-(\\d{4})\\b', replacement: 'XXX-XX-\\1', label: 'US Social Security numbers, keeping the last four' },
  email: { regex: '\\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\\.[A-Za-z]{2,})\\b', replacement: '<redacted>@\\1', label: 'Email addresses, keeping the domain' },
};

/** A line every real log has, which no masking pattern should touch. */
const INNOCENT_SAMPLE = '2026-09-23T12:00:01.123Z host=web01 src=10.1.2.3 dst=192.0.2.10 port=443 status=200 bytes=5120 user=alice duration_ms=37';

function maskTooBroad(regex        )          {
  if (/^(\.\*|\.\+|\\d\+|\\w\+|\\S\+|\[\^\s\]\+|\\d\*|\\w\*)$/.test(regex.trim())) return true;
  try {
    // JavaScript is close enough to PCRE2 for the patterns people write here.
    return new RegExp(regex).test(INNOCENT_SAMPLE);
  } catch {
    return false;
  }
}

export const EDGE_BLUEPRINTS                             = [
  splunkBlueprint({
    id: 'splunk_edge_pipeline',
    tier: TIER,
    label: 'Edge or Ingest Processor pipeline (SPL2)',
    group: 'Edge Processor',
    description: 'An SPL2 pipeline that earns its place: drop the noise, mask what must not be stored, extract the fields routing needs, and send a full-fidelity copy to S3 while only the useful part is indexed — with the source type and destinations it needs and the steps to apply it.',
    inputs: [
      { id: 'app_name', label: 'Package name', control: 'text', default: 'org_edge_pipelines' },
      { id: 'processor', label: 'Runs on', control: 'select', default: 'edge', options: [
        { value: 'edge', label: 'Edge Processor — in your network' },
        { value: 'ingest', label: 'Ingest Processor — in Splunk Cloud' },
      ] },
      { id: 'pipeline_name', label: 'Pipeline name', control: 'text', default: 'cisco_asa_reduce' },
      { id: 'sourcetype', label: 'Partition: sourcetype', control: 'text', default: 'cisco:asa', hint: 'The data this pipeline takes; everything else passes to the default destination' },
      { id: 'drop', label: 'Drop', control: 'select', default: 'regex', options: [
        { value: 'none', label: 'Nothing' },
        { value: 'regex', label: 'Events matching a pattern' },
        { value: 'field', label: 'Events where an extracted field has a value' },
      ] },
      { id: 'drop_regex', label: 'Drop events matching', control: 'text', default: '%ASA-(6|7)-(302013|302014|302015|302016|305011|305012|710005)', showWhen: { input: 'drop', equals: ['regex'] } },
      { id: 'extract', label: 'Extract a field', control: 'toggle', default: true },
      { id: 'extract_regex', label: 'Extraction (named groups)', control: 'text', default: '%ASA-(?P<severity>\\d)-(?P<message_id>\\d{6})', showWhen: { input: 'extract', equals: ['true'] } },
      { id: 'drop_field', label: 'Drop where', control: 'text', default: 'severity == "7"', showWhen: { input: 'drop', equals: ['field'] } },
      { id: 'mask', label: 'Mask', control: 'select', default: 'none', options: [
        { value: 'none', label: 'Nothing' },
        { value: 'card', label: MASKS.card .label },
        { value: 'ssn', label: MASKS.ssn .label },
        { value: 'email', label: MASKS.email .label },
        { value: 'custom', label: 'A pattern of my own' },
      ] },
      { id: 'mask_regex', label: 'Mask pattern', control: 'text', default: 'password=\\S+', showWhen: { input: 'mask', equals: ['custom'] } },
      { id: 'mask_replacement', label: 'Replace with', control: 'text', default: 'password=<redacted>', showWhen: { input: 'mask', equals: ['custom'] } },
      { id: 'index', label: 'Splunk index', control: 'text', default: 'netfw' },
      { id: 'route', label: 'Destinations', control: 'select', default: 'splunk_and_s3', options: [
        { value: 'splunk', label: 'Splunk only' },
        { value: 'splunk_and_s3', label: 'Full copy to S3 first, reduced data to Splunk' },
        { value: 'split', label: 'Dropped events to S3 instead of discarding them' },
      ] },
      { id: 's3_bucket', label: 'S3 bucket', control: 'text', default: 'org-splunk-archive', showWhen: { input: 'route', equals: ['splunk_and_s3', 'split'] } },
      { id: 'sample', label: 'Sample 1 in N of what is left', control: 'number', default: 1, min: 1, max: 1000, hint: '1 = keep everything' },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_edge_pipelines'), 'org_edge_pipelines');
      const edge = str(values, 'processor', 'edge') === 'edge';
      const name = splunkName(str(values, 'pipeline_name', 'pipeline'), 'pipeline');
      const sourcetype = str(values, 'sourcetype', '').replace(/"/g, '');
      const drop = str(values, 'drop', 'regex');
      const dropRegex = str(values, 'drop_regex', '').replace(/\//g, '\\/');
      const extract = bool(values, 'extract', true);
      const extractRegex = str(values, 'extract_regex', '').replace(/\//g, '\\/');
      const dropField = str(values, 'drop_field', '');
      const maskKind = str(values, 'mask', 'none');
      const mask =
        maskKind === 'custom'
          ? { regex: str(values, 'mask_regex', ''), replacement: str(values, 'mask_replacement', '<redacted>'), label: 'Custom' }
          : MASKS[maskKind];
      const index = splunkName(str(values, 'index', ''), 'main');
      const route = str(values, 'route', 'splunk');
      const bucket = str(values, 's3_bucket', '');
      const sample = Math.max(1, Math.round(num(values, 'sample', 1)));
      const findings            = [];

      const filters = (drop === 'regex' && dropRegex) || (drop === 'field' && dropField && extract);
      if (!filters && !mask && route === 'splunk' && sample === 1) {
        findings.push(
          warning('splunk.edge-pipeline-no-effect', 'This pipeline neither drops, masks, samples nor routes anything. It adds a hop and a component to run, and every byte still reaches the index.', {
            remediation: 'Drop the events nobody searches, or send the full copy to S3 and index the useful part.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (drop === 'field' && !extract) {
        findings.push(error('splunk.edge-drop-field-no-extract', 'Dropping on a field needs that field extracted first; with extraction off the condition is never true and nothing is dropped.', { source: 'ArchToolKit' }));
      }
      if (mask && maskTooBroad(mask.regex)) {
        findings.push(
          error('splunk.edge-mask-too-broad', `The mask pattern ${mask.regex} matches an ordinary log line (${INNOCENT_SAMPLE}). It will overwrite timestamps, addresses or ports before anything is stored, and there is no getting them back.`, {
            remediation: 'Anchor the pattern on the key or the structure of the secret (password=\\S+, a card number with its Luhn length), not on digits or words in general.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (route !== 'splunk' && !bucket) {
        findings.push(error('splunk.edge-no-bucket', 'S3 routing is selected but no bucket was named.', { source: 'ArchToolKit' }));
      }
      if (route === 'split' && !filters) {
        findings.push(warning('splunk.edge-split-nothing', 'Routing dropped events to S3 needs a drop condition; with none, nothing goes to S3.', { source: 'ArchToolKit' }));
      }
      if (sample > 1) {
        findings.push(
          warning('splunk.edge-sampling', `Sampling 1 in ${sample} makes every count, sum and threshold in every search over this data wrong by a factor of ${sample}, and makes a single-event detection miss ${sample - 1} times in ${sample}. It is for volume metrics, not security data.`, {
            source: 'ArchToolKit',
          }),
        );
      }

      const dropCondition = drop === 'regex' && dropRegex ? `match(_raw, /${dropRegex}/)` : drop === 'field' && dropField ? dropField : '';
      const s3 = `$${edge ? 'aws_s3' : 'aws_s3'}_${name}`;
      const spl2           = [
        ...(route === 'split' ? ['import route from /splunk.ingest.commands', ''] : []),
        `$pipeline = | from $source`,
        `// The partition: only ${sourcetype || 'this data'}. Set it in the pipeline editor as the partition; it appears here as a where.`,
        ...(sourcetype ? [`| where sourcetype == "${sourcetype}"`] : []),
        ...(route === 'splunk_and_s3'
          ? ['// A complete, unreduced copy to S3 before anything is dropped or masked', '// (move the thru after the mask if S3 must not hold the unmasked data).', `| thru [ | into ${s3} ]`]
          : []),
        ...(extract && extractRegex ? ['// Extract the fields the filter and routing need.', `| rex field=_raw /${extractRegex}/`] : []),
        ...(dropCondition
          ? route === 'split'
            ? ['// Dropped events go to S3 instead of the index.', `| route ${dropCondition}, [ | into ${s3} ]`]
            : ['// Drop what nobody searches.', `| where NOT (${dropCondition})`]
          : []),
        ...(mask ? [`// Mask: ${mask.label}.`, `| eval _raw = replace(_raw, /${mask.regex.replace(/\//g, '\\/')}/, "${mask.replacement.replace(/"/g, '\\"')}")`] : []),
        ...(sample > 1 ? [`// Keep 1 in ${sample}. VERIFY random() is available to pipelines on your release.`, `| where random() % ${sample} == 0`] : []),
        `| eval index = "${index}"`,
        '// Drop the fields extracted only for the pipeline, so they are not indexed.',
        ...(extract && extractRegex ? [`| fields - ${[...extractRegex.matchAll(/\(\?P?<([A-Za-z_][A-Za-z0-9_]*)>/g)].map((m) => m[1]).join(', ') || '_none_'}`] : []),
        `| into $destination;`,
      ];

      return {
        tier: TIER,
        title: `${edge ? 'Edge' : 'Ingest'} Processor pipeline ${name} for ${sourcetype || 'all data'}`,
        app,
        activation: 'reload',
        notes: [
          `A pipeline is created in the Splunk Cloud tenant (Data Management → Pipelines), then applied to ${edge ? 'one or more Edge Processors' : 'the Ingest Processor'}. It takes effect within a minute or two of applying; there is no restart.`,
          'SPL2 is not SPL: where uses ==, regular expressions are PCRE2 between slashes, and each pipeline reads from $source and writes to $destination. VERIFY the pipeline in the editor\u2019s preview against a sample of real events before applying it.',
          `Data that matches no pipeline partition goes to the ${edge ? 'Edge Processor' : 'Ingest Processor'}\u2019s default destination. Set one, or unmatched data is dropped.`,
          ...(route !== 'splunk' ? ['The S3 copy is raw events as JSON (or Parquet on Ingest Processor), partitioned by date. It is cheap to keep and expensive to search: plan how you would read it back (Federated Search for Amazon S3, Athena) before relying on it.'] : []),
          ...(mask ? ['Masking at the edge is irreversible. That is the point for regulated data, and a reason to test the pattern on a day of real events first.'] : []),
        ],
        before: [
          `index=* sourcetype="${sourcetype}" earliest=-24h | eval bytes=len(_raw) | stats count sum(bytes) as bytes by index   # baseline volume`,
          ...(drop === 'regex' && dropRegex ? [`index=* sourcetype="${sourcetype}" earliest=-24h | regex _raw="${str(values, 'drop_regex', '')}" | stats count   # what the drop would remove`] : []),
          `| rest /services/data/indexes | search title=${index}   # the index exists on the destination`,
          'Data Management → Edge Processors: the instances are Healthy and receiving data from this source.',
        ],
        files: {
          [`pipelines/${name}.md`]: [
            '',
            `Paste the SPL2 below into a new pipeline in Data Management → Pipelines (${edge ? 'Edge Processor' : 'Ingest Processor'}), set the partition to sourcetype = ${sourcetype || '(any)'}, choose the destinations named in destinations.md, preview, save, and apply.`,
            '',
            '```',
            ...spl2,
            '```',
            '',
            'VERIFY: SPL2 syntax against "Edge Processor pipeline syntax" in the Splunk docs for your tenant\u2019s release — the command set grows with each release.',
          ],
          'pipelines/destinations.md': [
            '',
            '## Destinations this pipeline uses',
            '',
            `- **$destination** — Splunk platform. ${edge ? 'An S2S destination to the indexers (or Splunk Cloud), with TLS and the forwarder certificate the indexers expect; or a HEC destination with a token scoped to' : 'The Splunk Cloud stack the Ingest Processor belongs to; the index must exist, and be allowed:'} \`${index}\`.`,
            ...(route !== 'splunk'
              ? [
                  `- **${s3}** — Amazon S3. Bucket \`${bucket}\`, prefix \`${sourcetype.replace(/[^A-Za-z0-9_-]/g, '_') || 'data'}/\`, in the bucket's own region. Authenticate with an IAM role the ${edge ? 'Edge Processor host' : 'Splunk Cloud tenant'} can assume, never with access keys in the destination. The bucket needs a lifecycle rule; nothing expires by default.`,
                ]
              : []),
            '',
            '## Source type',
            '',
            `Data from universal forwarders arrives at an Edge Processor unbroken. Define a source type \`${sourcetype}\` in Data Management → Source types with the event breaking this data needs (for syslog-style data: break before each line), or events arrive as multi-line blobs and every where and rex acts on the wrong unit.`,
            '',
            '## Getting data to the processor',
            '',
            edge
              ? '- Forwarders: an outputs.conf app pointing at the Edge Processor instances on their S2S port (9997 by default), in place of or alongside the indexers.\n- Syslog: send directly to the Edge Processor\u2019s syslog port.\n- HEC: point clients at the Edge Processor\u2019s HEC endpoint with a token the Edge Processor accepts.'
              : '- The Ingest Processor sees data arriving at the Splunk Cloud stack; no change to forwarders is needed.',
            '',
            '## Deploy',
            '',
            '1. Create the destinations above (Data Management → Destinations).',
            '2. Create the source type if the data comes from forwarders.',
            `3. New pipeline → partition sourcetype = ${sourcetype} → paste the SPL2 → Preview against a captured sample → Save.`,
            `4. Apply to ${edge ? 'a single Edge Processor first' : 'the Ingest Processor'}; compare volume and a known search before and after.`,
            '5. Roll out to the remaining instances.',
          ],
        },
        verify: [
          `index=${index} sourcetype="${sourcetype}" earliest=-15m | stats count by host   # still arriving`,
          `index=${index} sourcetype="${sourcetype}" earliest=-24h | eval bytes=len(_raw) | timechart span=1h sum(bytes)   # the drop in volume, at the hour you applied it`,
          ...(dropCondition && drop === 'regex' ? [`index=${index} sourcetype="${sourcetype}" earliest=-15m | regex _raw="${str(values, 'drop_regex', '')}" | stats count   # should be 0`] : []),
          ...(mask ? [`index=${index} sourcetype="${sourcetype}" earliest=-15m | regex _raw="${mask.regex.replace(/"/g, '\\"')}" | stats count   # should be 0 unmasked`] : []),
          ...(route !== 'splunk' ? [`aws s3 ls s3://${bucket}/ --recursive | tail   # objects arriving`] : []),
          'Data Management → Edge Processors → the instance → pipeline metrics: events in, events out, per destination.',
        ],
        backout: [
          `Data Management → Pipelines → ${name} → Remove from ${edge ? 'each Edge Processor' : 'the Ingest Processor'}. Data then flows to the default destination unprocessed.`,
          '# Events already dropped or masked are gone; the S3 copy, if taken before the drop, still has them.',
        ],
        findings,
      };
    },
  }),

  splunkBlueprint({
    id: 'splunk_otel_k8s',
    tier: TIER,
    label: 'OpenTelemetry Collector for Kubernetes (Helm)',
    group: 'OpenTelemetry',
    description: 'Helm values for the Splunk OpenTelemetry Collector sending container logs and cluster metrics to Splunk HEC, with the HEC token in a Kubernetes Secret that exists before the chart, TLS verified, and kube-system noise excluded.',
    inputs: [
      { id: 'app_name', label: 'Package name', control: 'text', default: 'org_otel_k8s' },
      { id: 'cluster_name', label: 'Cluster name', control: 'text', default: 'prod-k8s-01' },
      { id: 'distribution', label: 'Distribution', control: 'select', default: 'other', options: [
        { value: 'other', label: 'Other / on-premises' },
        { value: 'eks', label: 'Amazon EKS' },
        { value: 'aks', label: 'Azure AKS' },
        { value: 'gke', label: 'Google GKE' },
        { value: 'openshift', label: 'Red Hat OpenShift' },
      ] },
      { id: 'hec_endpoint', label: 'HEC endpoint', control: 'text', default: 'https://http-inputs-example.splunkcloud.com:443/services/collector/event' },
      { id: 'index', label: 'Logs index', control: 'text', default: 'k8s_logs' },
      { id: 'metrics', label: 'Send metrics', control: 'toggle', default: true },
      { id: 'metrics_index', label: 'Metrics index', control: 'text', default: 'k8s_metrics', showWhen: { input: 'metrics', equals: ['true'] } },
      { id: 'namespace', label: 'Namespace', control: 'text', default: 'splunk-otel' },
      { id: 'release', label: 'Helm release', control: 'text', default: 'splunk-otel-collector' },
      { id: 'token_source', label: 'HEC token from', control: 'select', default: 'secret', options: [
        { value: 'secret', label: 'An existing Kubernetes Secret' },
        { value: 'set_file', label: 'A file, passed with --set-file' },
        { value: 'values', label: 'values.yaml' },
      ] },
      { id: 'secret_name', label: 'Secret name', control: 'text', default: 'splunk-otel-hec', showWhen: { input: 'token_source', equals: ['secret'] } },
      { id: 'insecure', label: 'Skip TLS verification', control: 'toggle', default: false },
      { id: 'exclude_system', label: 'Exclude kube-system and the collector\u2019s own logs', control: 'toggle', default: true },
      { id: 'exclude_namespaces', label: 'Also exclude namespaces', control: 'text', default: '', placeholder: 'monitoring, istio-system' },
      { id: 'cpu_limit', label: 'Agent CPU limit', control: 'text', default: '500m' },
      { id: 'memory_limit', label: 'Agent memory limit', control: 'text', default: '1Gi' },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_otel_k8s'), 'org_otel_k8s');
      const cluster = str(values, 'cluster_name', 'k8s').replace(/[^A-Za-z0-9._-]/g, '-');
      const distribution = str(values, 'distribution', 'other');
      const endpoint = str(values, 'hec_endpoint', '');
      const index = splunkName(str(values, 'index', 'k8s_logs'), 'k8s_logs');
      const metrics = bool(values, 'metrics', true);
      const metricsIndex = splunkName(str(values, 'metrics_index', 'k8s_metrics'), 'k8s_metrics');
      const ns = splunkName(str(values, 'namespace', 'splunk-otel'), 'splunk_otel').replace(/_/g, '-');
      const release = splunkName(str(values, 'release', 'splunk-otel-collector'), 'splunk_otel_collector').replace(/_/g, '-');
      const tokenSource = str(values, 'token_source', 'secret');
      const secretName = splunkName(str(values, 'secret_name', 'splunk-otel-hec'), 'splunk_otel_hec').replace(/_/g, '-');
      const insecure = bool(values, 'insecure', false);
      const excludeNs = [...(bool(values, 'exclude_system', true) ? ['kube-system', ns] : []), ...listOf(str(values, 'exclude_namespaces', ''))];
      const findings            = [];

      if (insecure) {
        findings.push(
          error('splunk.otel-insecure-skip-verify', 'insecureSkipVerify: true sends the HEC token to whatever answers on that address, without checking it is Splunk. Anyone who can intercept the traffic gets a token that can write to your indexes, and every log from the cluster.', {
            remediation: 'Leave it false. For a private CA, put the CA certificate in the Secret as splunk_platform_hec_ca_file and set splunkPlatform.caFile.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (tokenSource === 'values') {
        findings.push(
          error('splunk.otel-token-in-values', 'A token in values.yaml is a credential in whatever repository holds the values, and in every Helm release secret for as long as the history is kept.', {
            remediation: 'Create the Secret first (ops/create-secret.sh) and set secret.create: false.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (tokenSource === 'set_file') {
        findings.push(
          warning('splunk.otel-token-in-release', 'With --set-file the token is not in the values file, but Helm stores the computed values in the release secret, so it is still in the cluster in every retained revision.', {
            remediation: 'An existing Secret keeps the token out of Helm entirely.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (endpoint.startsWith('http://')) {
        findings.push(error('splunk.otel-hec-plaintext', 'The HEC endpoint is plain HTTP, so the token and every log cross the network in clear.', { source: 'ArchToolKit' }));
      }
      if (!['eks', 'gke', 'openshift'].includes(distribution) && !cluster) {
        findings.push(error('splunk.otel-no-cluster-name', 'clusterName is required outside EKS, GKE and OpenShift.', { source: 'ArchToolKit' }));
      }

      const valuesYaml           = [
        '# Splunk OpenTelemetry Collector for Kubernetes: Splunk Platform (HEC) only.',
        '# Chart: splunk-otel-collector-chart/splunk-otel-collector. Check each key',
        '# against the values.yaml of the chart version you install:',
        '#   helm show values splunk-otel-collector-chart/splunk-otel-collector',
        '',
        '# k8s.cluster.name on every log and metric. Required outside EKS, GKE and',
        '# OpenShift, where it is discovered.',
        `clusterName: ${cluster}`,
        ...(distribution !== 'other' ? [`distribution: ${distribution}`] : []),
        '',
        'splunkPlatform:',
        `  endpoint: ${endpoint}`,
        `  index: ${index}`,
        ...(metrics ? [`  metricsIndex: ${metricsIndex}`] : []),
        '  logsEnabled: true',
        `  metricsEnabled: ${metrics}`,
        '  # Verify the HEC certificate. For a private CA, add the CA to the Secret',
        '  # as splunk_platform_hec_ca_file and set caFile here.',
        `  insecureSkipVerify: ${insecure}`,
        ...(tokenSource === 'values'
          ? ['  # A token here is a credential in version control — see the finding.', '  token: "<REQUIRED: HEC token>"']
          : ['  # No token here. It comes from the Secret named below.']),
        '',
        'secret:',
        ...(tokenSource === 'secret'
          ? [
              '  # The Secret exists before the chart (ops/create-secret.sh), with the',
              '  # token under the key splunk_platform_hec_token.',
              '  create: false',
              `  name: ${secretName}`,
              '  validateSecret: true',
            ]
          : ['  # The chart creates the Secret from splunkPlatform.token.', '  create: true']),
        '',
        '# logsEngine is deprecated: native OpenTelemetry log collection is the only',
        '# engine in current charts (fluentd was removed). Leave it unset.',
        '',
        'logsCollection:',
        '  containers:',
        '    enabled: true',
        ...(excludeNs.length > 0
          ? [
              '    # The control plane and the collector\u2019s own logs: high volume, low',
              '    # value, and the collector logging about itself loops.',
              '    excludePaths:',
              ...excludeNs.map((n) => `      - /var/log/pods/${n}_*/*/*.log`),
            ]
          : []),
        '',
        'agent:',
        '  # One agent per node. Limits keep a log storm on one node from starving',
        '  # the workloads; if the agent is OOM-killed, raise memory rather than',
        '  # removing the limit.',
        '  resources:',
        '    limits:',
        `      cpu: ${str(values, 'cpu_limit', '500m')}`,
        `      memory: ${str(values, 'memory_limit', '1Gi')}`,
        '',
        'clusterReceiver:',
        `  enabled: ${metrics}`,
      ];

      return {
        tier: TIER,
        title: `Splunk OTel Collector on ${cluster} to ${index}${metrics ? ` and ${metricsIndex}` : ''}`,
        app,
        activation: 'restart',
        notes: [
          `Both indexes must exist, ${metrics ? `and ${metricsIndex} must be a metrics index, ` : ''}and the HEC token must be allowed to write to them. Data for an index the token may not use is rejected with a 400 that shows up only in the collector\u2019s logs.`,
          'ops/install.sh is a dry run by default: it renders the chart and shows the diff. --execute installs.',
          ...(tokenSource === 'secret' ? ['Rotate the token by updating the Secret and restarting the agent DaemonSet (kubectl rollout restart); the chart never needs to know.'] : []),
          'The agent runs as a DaemonSet with host paths mounted read-only to /var/log/pods. On OpenShift it needs the privileged SCC the chart creates; on hardened clusters check the PodSecurity admission level of the namespace.',
        ],
        before: [
          'kubectl version; helm version',
          `kubectl get ns ${ns} || kubectl create ns ${ns}`,
          ...(tokenSource === 'secret' ? [`kubectl -n ${ns} get secret ${secretName} -o jsonpath='{.data}' | jq 'keys'   # expect splunk_platform_hec_token`] : []),
          `curl -sS -o /dev/null -w "%{http_code}\\n" ${endpoint.replace(/\/services\/collector.*$/, '')}/services/collector/health   # 200 from a pod network, with the certificate verified`,
          `| rest /services/data/indexes | search title IN (${index}${metrics ? `, ${metricsIndex}` : ''}) | table title, datatype`,
        ],
        files: {
          'helm/values.yaml': valuesYaml,
          ...(tokenSource === 'secret'
            ? {
                'ops/create-secret.sh': [
                  '# Create the HEC token Secret from a mode-600 file. The token is read by',
                  '# kubectl from the file; it is never on a command line or in a manifest.',
                  '# The file must contain the token only, with no trailing newline:',
                  '#   umask 077; printf %s "<token>" > ~/.splunk/hec.token   (typed at a prompt, not in history)',
                  '# Usage: bash create-secret.sh [token file]   (dry run)   --execute to act',
                  'set -euo pipefail',
                  'EXECUTE=0; ARGS=()',
                  'for a in "$@"; do [[ "$a" == "--execute" ]] && EXECUTE=1 || ARGS+=("$a"); done',
                  'TOKEN_FILE="${ARGS[0]:-$HOME/.splunk/hec.token}"',
                  `NS="${ns}"`,
                  `SECRET="${secretName}"`,
                  '[[ -f "$TOKEN_FILE" ]] || { echo "No token file: $TOKEN_FILE" >&2; exit 1; }',
                  'perm="$(stat -c %a "$TOKEN_FILE" 2>/dev/null || stat -f %Lp "$TOKEN_FILE")"',
                  '[[ "$perm" == "600" || "$perm" == "400" ]] || { echo "$TOKEN_FILE must be mode 600." >&2; exit 1; }',
                  '[[ "$(tail -c1 "$TOKEN_FILE" | od -An -c | tr -d " ")" != "\\n" ]] || { echo "$TOKEN_FILE ends in a newline; the token would include it." >&2; exit 1; }',
                  'cmd=(kubectl -n "$NS" create secret generic "$SECRET" --from-file=splunk_platform_hec_token="$TOKEN_FILE" --dry-run=client -o yaml)',
                  'if (( EXECUTE )); then',
                  '  "${cmd[@]}" | kubectl apply -f -',
                  '  kubectl -n "$NS" get secret "$SECRET" -o jsonpath="{.data}" | jq "keys"',
                  'else',
                  '  echo "DRY RUN: ${cmd[*]} | kubectl apply -f -"',
                  'fi',
                ],
              }
            : {}),
          'ops/install.sh': [
            '# Install or upgrade the collector. Dry run by default: renders the chart',
            '# against the cluster and prints it; --execute installs.',
            '# Usage: bash install.sh [--execute]',
            'set -euo pipefail',
            'EXECUTE=0; [[ "${1:-}" == "--execute" ]] && EXECUTE=1',
            'HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
            `NS="${ns}"`,
            `RELEASE="${release}"`,
            'CHART="splunk-otel-collector-chart/splunk-otel-collector"',
            '# Pin the chart version you tested: CHART_VERSION=0.xxx.0 bash install.sh',
            'VERSION_ARGS=(); [[ -n "${CHART_VERSION:-}" ]] && VERSION_ARGS=(--version "$CHART_VERSION")',
            'helm repo add splunk-otel-collector-chart https://signalfx.github.io/splunk-otel-collector-chart >/dev/null 2>&1 || true',
            'helm repo update splunk-otel-collector-chart >/dev/null',
            ...(tokenSource === 'set_file'
              ? [
                  'TOKEN_FILE="${TOKEN_FILE:-$HOME/.splunk/hec.token}"',
                  '[[ -f "$TOKEN_FILE" ]] || { echo "No token file: $TOKEN_FILE" >&2; exit 1; }',
                  'TOKEN_ARGS=(--set-file "splunkPlatform.token=$TOKEN_FILE")',
                ]
              : ['TOKEN_ARGS=()']),
            'args=(upgrade --install "$RELEASE" "$CHART" -n "$NS" --create-namespace -f "$HERE/../helm/values.yaml" "${VERSION_ARGS[@]}" "${TOKEN_ARGS[@]}")',
            'if (( EXECUTE )); then',
            '  helm "${args[@]}" --wait --timeout 10m',
            '  kubectl -n "$NS" get pods -l app=splunk-otel-collector -o wide',
            'else',
            '  echo "DRY RUN: helm ${args[*]} --dry-run"',
            '  helm "${args[@]}" --dry-run >/dev/null && echo "Chart renders against the cluster. Re-run with --execute."',
            'fi',
          ],
        },
        verify: [
          `kubectl -n ${ns} get ds,deploy,pods -l release=${release}`,
          `kubectl -n ${ns} logs ds/${release}-agent --tail=50 | grep -iE "error|refused|x509|400"`,
          `index=${index} k8s.cluster.name="${cluster}" earliest=-15m | stats count by k8s.namespace.name | sort - count`,
          ...(excludeNs.includes('kube-system') ? [`index=${index} k8s.cluster.name="${cluster}" k8s.namespace.name=kube-system earliest=-15m | stats count   # should be 0`] : []),
          ...(metrics ? [`| mstats count(_value) where index=${metricsIndex} k8s.cluster.name="${cluster}" earliest=-15m by metric_name | head 20`] : []),
        ],
        backout: [
          `helm uninstall ${release} -n ${ns}`,
          ...(tokenSource === 'secret' ? [`kubectl -n ${ns} delete secret ${secretName}   # and revoke the HEC token in Splunk`] : ['# Revoke the HEC token in Splunk.']),
        ],
        findings,
      };
    },
  }),

  splunkBlueprint({
    id: 'splunk_otel_host',
    tier: TIER,
    label: 'OpenTelemetry Collector on Linux and Windows hosts',
    group: 'OpenTelemetry',
    description: 'An agent_config.yaml for the Splunk OpenTelemetry Collector on a host — host metrics and log files to Splunk HEC — with the token read from SPLUNK_HEC_TOKEN in a root-only environment file, and the installer used without the token on its command line.',
    inputs: [
      { id: 'app_name', label: 'Package name', control: 'text', default: 'org_otel_host' },
      { id: 'platform', label: 'Hosts', control: 'select', default: 'linux', options: [
        { value: 'linux', label: 'Linux' },
        { value: 'windows', label: 'Windows' },
      ] },
      { id: 'hec_url', label: 'HEC URL', control: 'text', default: 'https://http-inputs-example.splunkcloud.com:443/services/collector' },
      { id: 'logs_index', label: 'Logs index', control: 'text', default: 'os_logs' },
      { id: 'metrics_index', label: 'Metrics index', control: 'text', default: 'os_metrics' },
      { id: 'log_paths', label: 'Log files', control: 'textarea', default: '/var/log/app/*.log', hint: 'One glob per line' },
      { id: 'interval', label: 'Metrics interval (seconds)', control: 'number', default: 60, min: 10, max: 3600 },
      { id: 'event_logs', label: 'Windows event logs', control: 'toggle', default: true, showWhen: { input: 'platform', equals: ['windows'] } },
      { id: 'insecure', label: 'Skip TLS verification', control: 'toggle', default: false },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_otel_host'), 'org_otel_host');
      const windows = str(values, 'platform', 'linux') === 'windows';
      const hecUrl = str(values, 'hec_url', '');
      const logsIndex = splunkName(str(values, 'logs_index', 'os_logs'), 'os_logs');
      const metricsIndex = splunkName(str(values, 'metrics_index', 'os_metrics'), 'os_metrics');
      const paths = str(values, 'log_paths', '')
        .split('\n')
        .map((p) => p.trim())
        .filter(Boolean);
      const interval = Math.max(10, num(values, 'interval', 60));
      const eventLogs = windows && bool(values, 'event_logs', true);
      const insecure = bool(values, 'insecure', false);
      const findings            = [];

      if (insecure) {
        findings.push(error('splunk.otel-insecure-skip-verify', 'insecure_skip_verify sends the HEC token to whatever answers on that address without checking it is Splunk.', { remediation: 'Leave it false; for a private CA set tls.ca_file.', source: 'ArchToolKit' }));
      }
      if (hecUrl.startsWith('http://')) {
        findings.push(error('splunk.otel-hec-plaintext', 'The HEC URL is plain HTTP, so the token and every event cross the network in clear.', { source: 'ArchToolKit' }));
      }
      for (const p of paths) {
        if (/^\/var\/log\/?(\*\*?)?(\/\*\*?)?$|^\/(\*\*?)?$|^[A-Za-z]:\\\*?$/.test(p)) {
          findings.push(error('splunk.otel-glob-too-broad', `"${p}" reads every file under it, binary and rotated ones included.`, { remediation: 'Name the files.', source: 'ArchToolKit' }));
        }
      }
      if (paths.length === 0 && !eventLogs) {
        findings.push(info('splunk.otel-metrics-only', 'No log files: the collector will send host metrics only.', { source: 'ArchToolKit' }));
      }

      const configPath = windows ? 'C:\\ProgramData\\Splunk\\OpenTelemetry Collector\\vcf-config.yaml' : '/etc/otel/collector/vcf-config.yaml';
      const tls = ['    tls:', `      insecure_skip_verify: ${insecure}`];
      const logsPipelineReceivers = [...(paths.length > 0 ? ['filelog'] : []), ...(eventLogs ? ['windowseventlog/system', 'windowseventlog/application', 'windowseventlog/security'] : [])];
      const config           = [
        `# Splunk OpenTelemetry Collector agent config for ${windows ? 'Windows' : 'Linux'} hosts,`,
        '# sending to Splunk Platform HEC. Installed as',
        `#   ${configPath}`,
        '# and selected with SPLUNK_CONFIG in the environment. The token is',
        '# ${env:SPLUNK_HEC_TOKEN}, set only in the root-only environment file.',
        '',
        'extensions:',
        '  health_check:',
        '    endpoint: 127.0.0.1:13133',
        '',
        'receivers:',
        '  hostmetrics:',
        `    collection_interval: ${interval}s`,
        '    scrapers:',
        '      cpu: {}',
        '      disk: {}',
        '      filesystem: {}',
        '      load: {}',
        '      memory: {}',
        '      network: {}',
        '      paging: {}',
        '      # processes (counts) is cheap; process (per-process) is not — it',
        '      # emits a series per process per interval. Enable it deliberately.',
        '      processes: {}',
        ...(paths.length > 0
          ? [
              '  filelog:',
              '    include:',
              ...paths.map((p) => `      - ${JSON.stringify(p)}`),
              '    # Rotated and compressed copies are the same data again.',
              '    exclude:',
              '      - "**/*.gz"',
              '      - "**/*.[0-9]"',
              '    # end: only new lines on first start. beginning: read what is there.',
              '    start_at: end',
              '    include_file_path: true',
              '    # Keep read positions across restarts, or every restart re-reads.',
              '    storage: file_storage/checkpoints',
            ]
          : []),
        ...(eventLogs
          ? ['system', 'application', 'security'].flatMap((c) => [`  windowseventlog/${c}:`, `    channel: ${c}`, '    start_at: end', '    storage: file_storage/checkpoints'])
          : []),
        '',
        'processors:',
        '  memory_limiter:',
        '    check_interval: 2s',
        '    limit_percentage: 20',
        '    spike_limit_percentage: 5',
        '  batch: {}',
        '  resourcedetection:',
        '    detectors: [system, env]',
        '    override: true',
        '',
        'exporters:',
        '  splunk_hec/logs:',
        '    token: "${env:SPLUNK_HEC_TOKEN}"',
        '    endpoint: "${env:SPLUNK_HEC_URL}"',
        `    index: ${logsIndex}`,
        '    source: otel',
        `    sourcetype: ${windows ? 'otel:windows' : 'otel:linux'}`,
        ...tls,
        '  splunk_hec/metrics:',
        '    token: "${env:SPLUNK_HEC_TOKEN}"',
        '    endpoint: "${env:SPLUNK_HEC_URL}"',
        `    index: ${metricsIndex}`,
        '    source: otel',
        '    sourcetype: otel',
        ...tls,
        '',
        ...(paths.length > 0 || eventLogs
          ? ['extensions/storage: {}', '']
          : []),
        'service:',
        `  extensions: [health_check${paths.length > 0 || eventLogs ? ', file_storage/checkpoints' : ''}]`,
        '  pipelines:',
        '    metrics:',
        '      receivers: [hostmetrics]',
        '      processors: [memory_limiter, batch, resourcedetection]',
        '      exporters: [splunk_hec/metrics]',
        ...(logsPipelineReceivers.length > 0
          ? ['    logs:', `      receivers: [${logsPipelineReceivers.join(', ')}]`, '      processors: [memory_limiter, batch, resourcedetection]', '      exporters: [splunk_hec/logs]']
          : []),
      ];
      // file_storage belongs under extensions:, not as a top-level key.
      const storageAt = config.indexOf('extensions/storage: {}');
      if (storageAt >= 0) {
        config.splice(storageAt, 2);
        const extAt = config.indexOf('extensions:');
        config.splice(extAt + 3, 0, '  file_storage/checkpoints:', `    directory: ${windows ? '"C:\\\\ProgramData\\\\Splunk\\\\OpenTelemetry Collector\\\\storage"' : '/var/lib/otelcol/file_storage'}`);
      }

      return {
        tier: TIER,
        title: `Splunk OTel Collector on ${windows ? 'Windows' : 'Linux'} hosts to ${logsIndex} and ${metricsIndex}`,
        app,
        activation: 'restart',
        notes: [
          'The installer normally takes the token as an argument, which puts it in the process list and shell history of whoever runs it. The install script here passes a placeholder, then writes the real token into the environment file from a mode-600 file, and restarts the service.',
          windows
            ? 'On Windows the collector service reads its environment from the service\u2019s registry key. VERIFY the location for your collector version (older MSIs used HKLM:\\SOFTWARE\\Splunk\\OpenTelemetry Collector), and restrict read on that key to SYSTEM and Administrators — service keys are readable by Users by default.'
            : 'The environment file is read by systemd as root before the service drops to its own user, so it can be root:root 600.',
          `${metricsIndex} must be a metrics index and ${logsIndex} an event index, and the HEC token must be allowed to write to both.`,
          ...(windows && paths.some((p) => p.startsWith('/')) ? ['The log paths look like Linux paths; on Windows use C:\\\\path\\\\*.log.'] : []),
        ],
        before: [
          windows ? 'Get-Service splunk-otel-collector -ErrorAction SilentlyContinue' : 'systemctl status splunk-otel-collector --no-pager || true',
          `curl -sS -o /dev/null -w "%{http_code}\\n" ${hecUrl.replace(/\/services\/collector.*$/, '')}/services/collector/health`,
          `| rest /services/data/indexes | search title IN (${logsIndex}, ${metricsIndex}) | table title, datatype`,
        ],
        files: {
          'otel/agent_config.yaml': config,
          [windows ? 'otel/environment.example.txt' : 'otel/splunk-otel-collector.conf.example']: [
            '# The collector\u2019s environment. Lives at',
            windows ? '#   the service registry key (see the install script)' : '#   /etc/otel/collector/splunk-otel-collector.conf  (root:root, mode 600)',
            '# The install script writes it; this is what it contains.',
            `SPLUNK_CONFIG=${configPath}`,
            `SPLUNK_HEC_URL=${hecUrl}`,
            '# Written by the install script from the token file. Never commit a value here.',
            'SPLUNK_HEC_TOKEN=',
            'SPLUNK_MEMORY_TOTAL_MIB=512',
          ],
          ...(windows
            ? {
                'ops/install-windows.ps1': [
                  '# Install the Splunk OTel Collector on this Windows host and point it at',
                  '# the config in this package. Dry run by default; -Execute to act.',
                  '# The token is read from a file readable only by Administrators and',
                  '# SYSTEM, and written to the service environment — never an argument.',
                  'param(',
                  '  [switch]$Execute,',
                  "  [string]$Msi,",
                  "  [string]$TokenFile = 'C:\\ProgramData\\Splunk\\hec.token'",
                  ')',
                  "$ErrorActionPreference = 'Stop'",
                  `$ConfigPath = '${configPath}'`,
                  `$HecUrl = '${hecUrl}'`,
                  "$Service = 'splunk-otel-collector'",
                  "if (-not (Test-Path $TokenFile)) { throw \"No token file: $TokenFile\" }",
                  '$acl = Get-Acl $TokenFile',
                  "$wide = $acl.Access | Where-Object { $_.IdentityReference -match 'Everyone|Users|Authenticated Users' }",
                  'if ($wide) { throw "$TokenFile is readable by $($wide.IdentityReference -join \', \'); restrict it to Administrators and SYSTEM." }',
                  'if (-not $Execute) {',
                  '  Write-Host "DRY RUN: msiexec /i $Msi /qn   (no token on the command line)"',
                  '  Write-Host "DRY RUN: copy agent_config.yaml to $ConfigPath"',
                  '  Write-Host "DRY RUN: set SPLUNK_CONFIG, SPLUNK_HEC_URL, SPLUNK_HEC_TOKEN in the $Service service environment; restart"',
                  '  return',
                  '}',
                  "if (-not $Msi) { throw 'Pass -Msi <splunk-otel-collector MSI>. VERIFY the MSI properties for your version; do not pass SPLUNK_ACCESS_TOKEN on the command line.' }",
                  "$p = Start-Process msiexec.exe -ArgumentList @('/i', $Msi, '/qn', '/norestart') -Wait -PassThru",
                  "if ($p.ExitCode -notin 0, 3010) { throw \"msiexec exit $($p.ExitCode)\" }",
                  'New-Item -ItemType Directory -Force -Path (Split-Path $ConfigPath) | Out-Null',
                  "Copy-Item (Join-Path $PSScriptRoot '..\\otel\\agent_config.yaml') $ConfigPath -Force",
                  '$hec = (Get-Content -Raw $TokenFile).Trim()',
                  '# VERIFY: current collector versions read the service Environment value.',
                  "$key = \"HKLM:\\SYSTEM\\CurrentControlSet\\Services\\$Service\"",
                  "$envList = @(\"SPLUNK_CONFIG=$ConfigPath\", \"SPLUNK_HEC_URL=$HecUrl\", \"SPLUNK_HEC_TOKEN=$hec\", 'SPLUNK_MEMORY_TOTAL_MIB=512')",
                  "Set-ItemProperty -Path $key -Name Environment -Type MultiString -Value $envList",
                  'Remove-Variable hec, envList',
                  'Restart-Service $Service',
                  'Get-Service $Service',
                ],
              }
            : {
                'ops/install-linux.sh': [
                  '# Install the Splunk OTel Collector on this Linux host and point it at',
                  '# the config in this package. Run as root. Dry run by default.',
                  '# Usage: sudo bash install-linux.sh [--execute]',
                  '# Env:   TOKEN_FILE=/root/.splunk/hec.token  (mode 600, the token only)',
                  'set -euo pipefail',
                  'EXECUTE=0; [[ "${1:-}" == "--execute" ]] && EXECUTE=1',
                  'HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
                  'TOKEN_FILE="${TOKEN_FILE:-/root/.splunk/hec.token}"',
                  `CONFIG="${configPath}"`,
                  `HEC_URL="${hecUrl}"`,
                  'ENV_FILE=/etc/otel/collector/splunk-otel-collector.conf',
                  '(( EUID == 0 )) || { echo "Run as root." >&2; exit 1; }',
                  '[[ -f "$TOKEN_FILE" ]] || { echo "No token file: $TOKEN_FILE" >&2; exit 1; }',
                  '[[ "$(stat -c %a "$TOKEN_FILE")" == "600" ]] || { echo "$TOKEN_FILE must be mode 600." >&2; exit 1; }',
                  'run() { if (( EXECUTE )); then "$@"; else printf "DRY RUN:"; printf " %q" "$@"; printf "\\n"; fi; }',
                  '',
                  'if ! systemctl list-unit-files splunk-otel-collector.service >/dev/null 2>&1; then',
                  '  run curl -fsSL https://dl.signalfx.com/splunk-otel-collector.sh -o /tmp/splunk-otel-collector.sh',
                  '  # A placeholder token: the real one is written to the env file below,',
                  '  # so it is never in the process list. VERIFY these installer options',
                  '  # (sh splunk-otel-collector.sh --help) for your installer version.',
                  '  run sh /tmp/splunk-otel-collector.sh --mode agent --without-instrumentation \\',
                  '    --splunk-platform-url "$HEC_URL" --splunk-platform-token PLACEHOLDER-REPLACED-BELOW \\',
                  '    --collector-config "$CONFIG"',
                  'fi',
                  'run install -D -m 644 "$HERE/../otel/agent_config.yaml" "$CONFIG"',
                  '',
                  '# Rewrite the env file: keep what the installer wrote, replace these keys.',
                  'if (( EXECUTE )); then',
                  '  umask 077',
                  '  tmp="$(mktemp)"; trap \'rm -f "$tmp"\' EXIT',
                  '  { [[ -f "$ENV_FILE" ]] && grep -vE "^(SPLUNK_CONFIG|SPLUNK_HEC_URL|SPLUNK_HEC_TOKEN)=" "$ENV_FILE" || true',
                  '    printf "SPLUNK_CONFIG=%s\\n" "$CONFIG"',
                  '    printf "SPLUNK_HEC_URL=%s\\n" "$HEC_URL"',
                  '    printf "SPLUNK_HEC_TOKEN=%s\\n" "$(<"$TOKEN_FILE")"',
                  '  } > "$tmp"',
                  '  install -m 600 -o root -g root "$tmp" "$ENV_FILE"',
                  '  systemctl restart splunk-otel-collector',
                  '  sleep 5; systemctl is-active splunk-otel-collector',
                  '  curl -fsS http://127.0.0.1:13133/ && echo',
                  'else',
                  '  echo "DRY RUN: write SPLUNK_CONFIG, SPLUNK_HEC_URL and SPLUNK_HEC_TOKEN (from $TOKEN_FILE) into $ENV_FILE, mode 600; restart"',
                  'fi',
                ],
              }),
        },
        verify: [
          windows ? 'Get-Service splunk-otel-collector; Invoke-WebRequest http://127.0.0.1:13133/ -UseBasicParsing' : 'systemctl is-active splunk-otel-collector && curl -fsS http://127.0.0.1:13133/',
          windows ? 'Get-WinEvent -LogName Application -MaxEvents 20 | Where-Object ProviderName -match otel' : 'journalctl -u splunk-otel-collector --since -10m | grep -iE "error|x509|40[0-9]"',
          `| mstats count(_value) where index=${metricsIndex} host=<this host> earliest=-15m by metric_name | head 20`,
          ...(paths.length > 0 || eventLogs ? [`index=${logsIndex} host=<this host> earliest=-15m | stats count by source`] : []),
        ],
        backout: [
          windows ? 'msiexec /x <the collector MSI> /qn' : 'systemctl disable --now splunk-otel-collector; yum remove -y splunk-otel-collector || apt-get remove -y splunk-otel-collector',
          windows ? '# Remove the Environment value from the service key if the MSI leaves it.' : 'rm -f /etc/otel/collector/splunk-otel-collector.conf   # it holds the token',
          '# Revoke the HEC token in Splunk if these hosts no longer need it.',
        ],
        findings,
      };
    },
  }),
];
