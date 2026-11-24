import { error, type Finding } from '../core/findings.ts';
import type { Blueprint } from '../kit/blueprint.ts';
import { blk, dat, e, hcl, jsonencode, output, res, x } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.ts';

export const AWS_PROMETHEUS_SERVICE = {
  id: 'aws_service_prometheus', label: 'Set up a managed Prometheus workspace',
  description: 'Create a protected metrics workspace, optional role-scoped ingest/query policies and deploy-time remote-write YAML.',
  emits: ['aws_prometheus_workspace', 'aws_iam_role_policy'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Workspace alias', control: 'text' },
    { id: 'kms', label: 'Existing workspace KMS key ARN', control: 'text', hint: 'Optional symmetric customer-managed key in the selected region. Review its policy before deployment.' },
    { id: 'writer', label: 'Existing metrics-writer IAM role ARN', control: 'text', hint: 'Optional. Adds only aps:RemoteWrite for this workspace to the existing agent role.' },
    { id: 'reader', label: 'Existing metrics-query IAM role ARN', control: 'text', hint: 'Optional. Adds workspace query, metadata, series and label permissions to an existing query role.' },
  ],
  build(values) {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.prometheus.' + path, message, { path }));
    const location = String(values.aws_region ?? ''), partition = awsServicePartition(location), name = String(values.name ?? '').trim(), kms = String(values.kms ?? '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(name)) reject('name', 'Use 1–100 letters, numbers, dots, hyphens or underscores.');
    if (kms && !new RegExp('^arn:' + partition + ':kms:' + location + ':\\d{12}:key/[A-Za-z0-9-]+$').test(kms)) reject('kms', 'Use a KMS key ARN in the selected region and partition.');
    const roles = ['writer', 'reader'].flatMap(key => {
      const arn = String(values[key] ?? '').trim();
      if (!arn) return [];
      const parsed = /^arn:([^:]+):iam::(\d{12}):role\/([A-Za-z0-9+=,.@_/-]+)$/.exec(arn);
      if (!parsed || parsed[1] !== partition) reject(key, 'Enter an existing IAM role ARN in the selected partition.');
      return [{ key, account: parsed?.[2] ?? '', name: parsed?.[3]?.split('/').at(-1) ?? '' }];
    });
    return awsServiceModule(location, [
      dat('aws_caller_identity', 'current', {}),
      res('aws_prometheus_workspace', 'configured', { alias: name, ...(kms ? { kms_key_arn: kms } : {}) }, [blk('lifecycle', { prevent_destroy: true }, roles.length ? [blk('precondition', { condition: x('alltrue([for account in ' + JSON.stringify(roles.map(role => role.account)) + ' : account == data.aws_caller_identity.current.account_id])'), error_message: 'This workflow attaches permissions only to roles in the deployment account.' })] : [])]),
      ...roles.map(role => res('aws_iam_role_policy', role.key, { name: name + '-metrics-' + role.key, role: role.name, policy: x(jsonencode({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: role.key === 'writer' ? ['aps:RemoteWrite'] : ['aps:QueryMetrics', 'aps:GetSeries', 'aps:GetLabels', 'aps:GetMetricMetadata'], Resource: e('aws_prometheus_workspace.configured.arn') }] })) })),
      output('workspace_id', 'aws_prometheus_workspace.configured.id'), output('workspace_arn', 'aws_prometheus_workspace.configured.arn'),
      output('remote_write_yaml', 'yamlencode(' + hcl({ remote_write: [{ url: e('"${aws_prometheus_workspace.configured.prometheus_endpoint}api/v1/remote_write"'), sigv4: { region: location } }] }) + ')'),
    ], `# Managed Prometheus workspace and agent integration

## Prepare
Confirm regional support, metric volume/cardinality, retention requirements, ingestion/query quotas and pricing. Prepare an existing compatible Prometheus server or agent and its workload identity. Optional writer/reader fields modify inline policies on those existing roles; review other workloads sharing them. Use distinct identities when ingest and query responsibilities differ. Review a customer-managed KMS key policy when selected.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review workspace encryption and exact role permissions, then apply the saved plan. Run terraform output -raw remote_write_yaml and merge its remote_write block into the existing agent configuration. This generated configuration contains the real workspace endpoint and SigV4 region after apply. The agent's credential chain must use the authorized writer identity; no access keys are exported. Preserve existing scrape jobs and validate configuration before restarting or reloading the agent.

## Verify
Confirm remote-write requests succeed and the send queue drains. Query a known metric using an authorized SigV4 query client and verify labels, timestamps, expected series and freshness. Test denied access from an unauthorized identity. Monitor ingestion failures, dropped samples, cardinality and query limits. This creates a workspace and integration configuration, not a running scraper, dashboard, alert manager or metric retention policy.

## Recovery
Keep the preceding metrics destination during cutover. Restore the previous agent configuration if ingestion fails and investigate identity, network, signing region or quotas. Plan for agent WAL/backlog limits and duplicates when replaying. Terraform prevent_destroy requires an explicit reviewed change before workspace deletion. Preserve required metric evidence and retention obligations. Managed scrapers, alerting, recording rules and cross-account access use their corresponding existing builders.

https://docs.aws.amazon.com/prometheus/latest/userguide/AMP-onboard-ingest-metrics.html
`, findings);
  },
} satisfies Blueprint;
