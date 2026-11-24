import { error, type Finding } from '../core/findings.ts';
import type { Blueprint } from '../kit/blueprint.ts';
import { blk, dat, e, jsonencode, output, res, x } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.ts';

export const AWS_OPENSEARCH_SERVERLESS_SERVICE = {
  id: 'aws_service_opensearch_serverless', label: 'Set up an OpenSearch Serverless collection',
  description: 'Configure search/time-series/vector collections, encryption, explicit public/private network policy and existing-role data access.',
  emits: ['aws_opensearchserverless_collection', 'aws_opensearchserverless_security_policy', 'aws_opensearchserverless_access_policy', 'aws_iam_role_policy'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Collection name', control: 'text' },
    { id: 'type', label: 'Collection type', control: 'select', default: 'SEARCH', options: [{ value: 'SEARCH', label: 'Search' }, { value: 'TIMESERIES', label: 'Time series' }, { value: 'VECTORSEARCH', label: 'Vector search' }] },
    { id: 'dimensions', label: 'Vector dimensions', control: 'number', default: 1536, showWhen: { input: 'type', equals: ['VECTORSEARCH'] }, hint: 'Example index embedding dimensions; must match the embedding model and supported vector engine limits.' },
    { id: 'encryption', label: 'Encryption key', control: 'select', default: 'AWS', options: [{ value: 'AWS', label: 'AWS-owned encryption key' }, { value: 'KMS', label: 'Customer-managed regional KMS key' }] },
    { id: 'kms', label: 'KMS key ARN', control: 'text', showWhen: { input: 'encryption', equals: ['KMS'] } },
    { id: 'network', label: 'Collection network access', control: 'select', default: 'PRIVATE', options: [{ value: 'PRIVATE', label: 'Private — existing OpenSearch Serverless VPC endpoints' }, { value: 'PUBLIC', label: 'Public endpoint — IAM and data policies still required' }] },
    { id: 'endpoints', label: 'Existing OpenSearch Serverless VPC endpoint IDs', control: 'text', showWhen: { input: 'network', equals: ['PRIVATE'] }, hint: 'Comma-separated vpce IDs for OpenSearch Serverless-managed endpoints in the selected region.' },
    { id: 'roles', label: 'Existing client IAM role ARNs', control: 'text', hint: 'Comma-separated role ARNs in this account. Adds a scoped inline API policy to each existing role.' },
    { id: 'access', label: 'Data permissions for these roles', control: 'select', default: 'READ', options: [{ value: 'READ', label: 'Read documents and describe indexes' }, { value: 'INGEST', label: 'Create/update indexes, ingest and read documents' }] },
    { id: 'dashboards', label: 'OpenSearch Dashboards access', control: 'select', default: 'no', options: [{ value: 'no', label: 'API clients only' }, { value: 'yes', label: 'Also allow Dashboards for these roles' }] },
  ],
  build(values): ReturnType<typeof awsServiceModule> {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.opensearch-serverless.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), partition = awsServicePartition(region), name = String(values.name ?? '').trim(), type = String(values.type ?? ''), encryption = String(values.encryption ?? ''), kms = encryption === 'KMS' ? String(values.kms ?? '').trim() : '', network = String(values.network ?? ''), access = String(values.access ?? ''), dashboards = String(values.dashboards ?? '');
    if (!/^[a-z][a-z0-9-]{1,18}[a-z0-9]$/.test(name)) reject('name', 'Use 3–20 lowercase letters, numbers or internal hyphens, beginning with a letter. Policy suffixes need the remaining name space.');
    if (!['SEARCH', 'TIMESERIES', 'VECTORSEARCH'].includes(type)) reject('type', 'Choose a collection type.');
    if (!['AWS', 'KMS'].includes(encryption)) reject('encryption', 'Choose encryption key ownership.');
    if (encryption === 'KMS' && !new RegExp('^arn:' + partition + ':kms:' + region + ':\\d{12}:key/[A-Za-z0-9-]+$').test(kms)) reject('kms', 'Use a customer-managed KMS key ARN in the selected region and partition.');
    if (!['PRIVATE', 'PUBLIC'].includes(network)) reject('network', 'Choose private or public endpoint access.');
    if (!['READ', 'INGEST'].includes(access)) reject('access', 'Choose client data permissions.');
    if (!['yes', 'no'].includes(dashboards)) reject('dashboards', 'Choose dashboard access.');
    const list = (key: string) => [...new Set(String(values[key] ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    const endpoints = network === 'PRIVATE' ? list('endpoints') : [], roleArns = list('roles');
    if (network === 'PRIVATE' && (!endpoints.length || endpoints.length > 20 || endpoints.some(value => !/^vpce-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value)))) reject('endpoints', 'Enter 1–20 existing Serverless-managed VPC endpoint IDs.');
    if (!roleArns.length || roleArns.length > 10) reject('roles', 'Enter 1–10 existing client role ARNs.');
    const roles = roleArns.map(arn => {
      const parsed = /^arn:([^:]+):iam::(\d{12}):role\/([A-Za-z0-9+=,.@_/-]+)$/.exec(arn);
      if (!parsed || parsed[1] !== partition) reject('roles', 'Use IAM role ARNs in the selected partition.');
      return { arn, account: parsed?.[2] ?? '', name: parsed?.[3]?.split('/').at(-1) ?? '' };
    });
    const dimensions = Number(values.dimensions);
    if (type === 'VECTORSEARCH' && (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 16000)) reject('dimensions', 'Use 1–16,000 whole dimensions and verify the chosen embedding engine/model limits.');
    const networkRules = [{ ResourceType: 'collection', Resource: ['collection/' + name] }, ...(dashboards === 'yes' ? [{ ResourceType: 'dashboard', Resource: ['collection/' + name] }] : [])];
    const result = awsServiceModule(region, [
      dat('aws_caller_identity', 'current', {}),
      res('aws_opensearchserverless_security_policy', 'encryption', { name: name + '-encryption', type: 'encryption', policy: JSON.stringify({ Rules: [{ ResourceType: 'collection', Resource: ['collection/' + name] }], AWSOwnedKey: encryption === 'AWS', ...(encryption === 'KMS' ? { KmsARN: kms } : {}) }) }),
      res('aws_opensearchserverless_security_policy', 'network', { name: name + '-network', type: 'network', policy: JSON.stringify([{ Rules: networkRules, AllowFromPublic: network === 'PUBLIC', ...(network === 'PRIVATE' ? { SourceVPCEs: endpoints } : {}) }]) }),
      res('aws_opensearchserverless_access_policy', 'clients', { name: name + '-clients', type: 'data', policy: JSON.stringify([{ Principal: roleArns, Rules: [{ ResourceType: 'collection', Resource: ['collection/' + name], Permission: ['aoss:DescribeCollectionItems'] }, { ResourceType: 'index', Resource: ['index/' + name + '/*'], Permission: ['aoss:DescribeIndex', 'aoss:ReadDocument', ...(access === 'INGEST' ? ['aoss:CreateIndex', 'aoss:UpdateIndex', 'aoss:WriteDocument'] : [])] }] }]) }),
      res('aws_opensearchserverless_collection', 'configured', { name, type, standby_replicas: 'ENABLED', depends_on: x('[aws_opensearchserverless_security_policy.encryption, aws_opensearchserverless_security_policy.network, aws_opensearchserverless_access_policy.clients]') }, [blk('lifecycle', { prevent_destroy: true }, [blk('precondition', { condition: x('alltrue([for account in ' + JSON.stringify(roles.map(role => role.account)) + ' : account == data.aws_caller_identity.current.account_id])'), error_message: 'Managed client roles must belong to the deployment account.' })])]),
      ...roles.map((role, index) => res('aws_iam_role_policy', 'client_' + index, { name: name + '-data-api', role: role.name, policy: x(jsonencode({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['aoss:APIAccessAll'], Resource: e('aws_opensearchserverless_collection.configured.arn') }, ...(dashboards === 'yes' ? [{ Effect: 'Allow', Action: ['aoss:DashboardsAccessAll'], Resource: e('"arn:' + partition + ':aoss:' + region + ':${data.aws_caller_identity.current.account_id}:dashboards/default"') }] : [])] })) })),
      output('collection_endpoint', 'aws_opensearchserverless_collection.configured.collection_endpoint'), output('dashboard_endpoint', 'aws_opensearchserverless_collection.configured.dashboard_endpoint'), output('collection_id', 'aws_opensearchserverless_collection.configured.id'),
    ], `# OpenSearch Serverless collection and access setup

## Prepare
Review regional availability, collection type, OCU/storage costs and quotas. Standby replicas are explicitly enabled. Prepare existing client IAM roles and coordinate their other policies. Private mode requires existing OpenSearch Serverless-managed VPC endpoints and reachable client networking/DNS; ordinary OpenSearch endpoints are not interchangeable. Customer-managed KMS encryption requires key-policy/grant permissions and an eligible regional key. The collection name/type and encryption configuration have lifecycle constraints; review replacement before applying changes.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review encryption, all matching network/data policies, client role permissions and private/public access. Apply the saved reviewed plan and wait for collection ACTIVE. This package creates a collection, not an index or dataset. Read the collection_endpoint output and configure a supported OpenSearch client with AWS SigV4 service name aoss, the selected region and the approved role credential chain. Never place static access keys in exported configuration. INGEST roles can use the generated INDEX-MAPPING.json to create an application-index through a signed PUT /application-index request, then upload approved sample documents. READ roles require an index/data provisioned by a separate authorized writer.

## Verify
Check collection state with aws opensearchserverless batch-get-collection --ids <collection_id> --region ${region}. From the intended client network/role, test signed index description and search, then ingest only when INGEST was selected. Verify unauthorized roles and networks are denied. Vector index dimensions must match the embedding model; the generated mapping uses Faiss HNSW/L2 and must be reviewed for the application. Time-series indexing has different supported operations and document-ID behavior. Index mappings and actual data are external to Terraform here.

Network policy, IAM API permission and data policy all participate in authorization. Permissions are additive across applicable policies; inspect existing policies for broader public/data grants. Optional Dashboards IAM access uses AWS's account/region dashboards/default resource, while network/data rules target this collection; review existing role grants to other collections. Disabling the optional dashboard grant does not revoke unrelated existing policies. No explicit deny policy is created.

## Recovery
Stop/redirect ingestion before changing permissions or mappings. Keep reproducible source data and an approved index/data recovery strategy; this package does not create backups or prove restore. Restore previous reviewed network/data policies if legitimate access breaks and account for propagation. Collection deletion is blocked by prevent_destroy; review retained data, costs and ownership before removing protection. Private endpoint provisioning, ingestion pipelines, Bedrock integration, custom per-index roles, encryption rotation and provisioned OpenSearch domains require additional workflows.

https://docs.aws.amazon.com/opensearch-service/latest/developerguide/serverless-data-access.html
`, findings);
    const mapping = type === 'VECTORSEARCH' ? { settings: { 'index.knn': true }, mappings: { properties: { content: { type: 'text' }, embedding: { type: 'knn_vector', dimension: dimensions, method: { name: 'hnsw', engine: 'faiss', space_type: 'l2' } } } } } : { mappings: { properties: { content: { type: 'text' }, timestamp: { type: 'date' } } } };
    return { ...result, files: { ...result.files, 'INDEX-MAPPING.json': JSON.stringify(mapping, null, 2) + '\n' } };
  },
} satisfies Blueprint;
