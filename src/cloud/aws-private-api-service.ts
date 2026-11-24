import { error, type Finding } from '../core/findings.ts';
import type { Blueprint } from '../kit/blueprint.ts';
import { blk, dat, e, hcl, jsonencode, output, res, x } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.ts';
export const AWS_PRIVATE_API_SERVICE = {
  id: 'aws_service_private_api', label: 'Set up a private IAM-authenticated REST API',
  description: 'Existing Lambda REST proxy behind approved execute-api interface endpoints, explicit role/endpoint deny boundaries, stage throttling and caller-policy output.',
  emits: ['aws_api_gateway_rest_api', 'aws_api_gateway_method', 'aws_api_gateway_integration', 'aws_api_gateway_rest_api_policy', 'aws_api_gateway_deployment', 'aws_api_gateway_stage', 'aws_lambda_permission'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Private API name', control: 'text' },
    { id: 'stage', label: 'Deployment stage', control: 'text', default: 'prod' },
    { id: 'path', label: 'Single resource path segment', control: 'text', default: 'service', hint: 'For example health or orders, without a slash. This recipe creates one concrete route, not a wildcard proxy.' },
    { id: 'method', label: 'HTTP method', control: 'select', default: 'GET', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map(value => ({ value, label: value })) },
    { id: 'function', label: 'Existing Lambda function ARN', control: 'text', hint: 'Unqualified function ARN in this account/region. It must implement API Gateway REST Lambda proxy request/response format.' },
    { id: 'alias', label: 'Existing Lambda alias or published version', control: 'text', hint: 'Optional; pin a reviewed existing alias/version instead of invoking the unqualified function.' },
    { id: 'endpoints', label: 'Approved execute-api interface endpoint IDs', control: 'text', hint: 'Comma-separated existing regional endpoint IDs with private DNS enabled and approved HTTPS routing/security/endpoint policies.' },
    { id: 'roles', label: 'Approved caller IAM role ARNs', control: 'text', hint: 'Comma-separated existing roles in the selected partition. Requests require SigV4 temporary credentials; role trust, identity permissions and endpoint policy must allow access.' },
    { id: 'rate', label: 'Steady request limit / second', control: 'number', default: 100 },
    { id: 'burst', label: 'Request burst limit', control: 'number', default: 200 },
    { id: 'access_log', label: 'Existing access log group ARN', control: 'text', hint: 'Optional regional CloudWatch log group. Regional API Gateway account logging role and sink permissions/retention must already be configured.' },
  ],
  build(values) {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.private-api.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), partition = awsServicePartition(region), name = String(values.name ?? '').trim(), stage = String(values.stage ?? '').trim(), path = String(values.path ?? '').trim(), method = String(values.method ?? ''), fn = String(values.function ?? '').trim(), alias = String(values.alias ?? '').trim(), log = String(values.access_log ?? '').trim();
    const list = (id: string) => [...new Set(String(values[id] ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    const endpoints = list('endpoints'), roles = list('roles'), rate = Number(values.rate), burst = Number(values.burst);
    const functionMatch = new RegExp('^arn:' + partition + ':lambda:' + region + ':(\\d{12}):function:[A-Za-z0-9_-]{1,64}$').exec(fn);
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(name)) reject('name', 'Use a letter followed by up to 79 letters, digits, underscores or hyphens.');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(stage)) reject('stage', 'Use 1–128 letters, digits, underscores or hyphens.');
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(path)) reject('path', 'Use a single concrete path segment with letters, digits, underscores or hyphens.');
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method)) reject('method', 'Choose the HTTP method.');
    if (!functionMatch) reject('function', 'Use an existing unqualified Lambda function ARN in the selected region/partition.');
    if (alias && (!/^[A-Za-z0-9_-]{1,128}$/.test(alias) || alias === '$LATEST')) reject('alias', 'Use an existing alias or published version, or leave blank.');
    if (!endpoints.length || endpoints.length > 5 || endpoints.some(id => !/^vpce-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(id))) reject('endpoints', 'Use 1–5 existing regional execute-api interface endpoint IDs.');
    if (!roles.length || roles.length > 10 || roles.some(role => !new RegExp('^arn:' + partition + ':iam::\\d{12}:role/[A-Za-z0-9+=,.@_/-]+$').test(role))) reject('roles', 'Use 1–10 explicit existing IAM role ARNs in the selected partition.');
    if (!Number.isFinite(rate) || rate < 1 || rate > 10000) reject('rate', 'Use 1–10,000 steady requests/second within your account quota.');
    if (!Number.isInteger(burst) || burst < 1 || burst > 5000) reject('burst', 'Use 1–5,000 burst requests within your account quota.');
    if (log && !new RegExp('^arn:' + partition + ':logs:' + region + ':\\d{12}:log-group:[A-Za-z0-9_./#-]+$').test(log)) reject('access_log', 'Use a regional log group ARN without a trailing :*.');
    const apiScope = e('"${aws_api_gateway_rest_api.configured.execution_arn}/*"');
    return awsServiceModule(region, [
      dat('aws_caller_identity', 'current', {}), dat('aws_partition', 'current', {}),
      dat('aws_lambda_function', 'selected', { function_name: fn, ...(alias ? { qualifier: alias } : {}) }),
      dat('aws_vpc_endpoint', 'selected', { for_each: x('toset(' + JSON.stringify(endpoints) + ')'), id: x('each.value') }),
      res('aws_api_gateway_rest_api', 'configured', { name, tags: x(hcl({ Name: name })) }, [blk('endpoint_configuration', { types: ['PRIVATE'], vpc_endpoint_ids: endpoints }), blk('lifecycle', {}, [blk('precondition', { condition: x('data.aws_caller_identity.current.account_id == ' + JSON.stringify(functionMatch?.[1] ?? '') + ' && alltrue([for endpoint in data.aws_vpc_endpoint.selected : endpoint.vpc_endpoint_type == "Interface" && endpoint.state == "available" && endpoint.private_dns_enabled && endswith(endpoint.service_name, ' + JSON.stringify('.' + region + '.execute-api') + ')])'), error_message: 'Lambda must belong to this account and endpoints must be available execute-api interfaces in the region with private DNS enabled.' })])]),
      res('aws_api_gateway_rest_api_policy', 'configured', { rest_api_id: x('aws_api_gateway_rest_api.configured.id'), policy: x(jsonencode({ Version: '2012-10-17', Statement: [
        { Effect: 'Allow', Principal: { AWS: roles }, Action: 'execute-api:Invoke', Resource: apiScope },
        { Effect: 'Deny', Principal: '*', Action: 'execute-api:Invoke', Resource: apiScope, Condition: { StringNotEquals: { 'aws:SourceVpce': endpoints } } },
        { Effect: 'Deny', Principal: '*', Action: 'execute-api:Invoke', Resource: apiScope, Condition: { ArnNotEquals: { 'aws:PrincipalArn': roles } } },
      ] })) }),
      res('aws_api_gateway_resource', 'configured', { rest_api_id: x('aws_api_gateway_rest_api.configured.id'), parent_id: x('aws_api_gateway_rest_api.configured.root_resource_id'), path_part: path }),
      res('aws_api_gateway_method', 'configured', { rest_api_id: x('aws_api_gateway_rest_api.configured.id'), resource_id: x('aws_api_gateway_resource.configured.id'), http_method: method, authorization: 'AWS_IAM' }),
      res('aws_api_gateway_integration', 'configured', { rest_api_id: x('aws_api_gateway_rest_api.configured.id'), resource_id: x('aws_api_gateway_resource.configured.id'), http_method: x('aws_api_gateway_method.configured.http_method'), integration_http_method: 'POST', type: 'AWS_PROXY', uri: x(alias ? 'data.aws_lambda_function.selected.qualified_invoke_arn' : 'data.aws_lambda_function.selected.invoke_arn'), timeout_milliseconds: 29000 }),
      res('aws_lambda_permission', 'gateway', { statement_id: name + '-gateway', action: 'lambda:InvokeFunction', function_name: fn, ...(alias ? { qualifier: alias } : {}), principal: 'apigateway.amazonaws.com', source_arn: x('"${aws_api_gateway_rest_api.configured.execution_arn}/*/' + method + '/' + path + '"') }),
      res('aws_api_gateway_deployment', 'configured', { rest_api_id: x('aws_api_gateway_rest_api.configured.id'), triggers: x('{ configuration = sha1(jsonencode([aws_api_gateway_method.configured, aws_api_gateway_integration.configured, aws_api_gateway_rest_api_policy.configured.policy])) }'), depends_on: x('[aws_lambda_permission.gateway]') }, [blk('lifecycle', { create_before_destroy: true })]),
      res('aws_api_gateway_stage', 'configured', { rest_api_id: x('aws_api_gateway_rest_api.configured.id'), deployment_id: x('aws_api_gateway_deployment.configured.id'), stage_name: stage, tags: x(hcl({ Name: name + '-' + stage })) }, log ? [blk('access_log_settings', { destination_arn: log, format: JSON.stringify({ requestId: '$context.requestId', extendedRequestId: '$context.extendedRequestId', requestTime: '$context.requestTime', httpMethod: '$context.httpMethod', resourcePath: '$context.resourcePath', status: '$context.status', responseLength: '$context.responseLength' }) })] : []),
      res('aws_api_gateway_method_settings', 'configured', { rest_api_id: x('aws_api_gateway_rest_api.configured.id'), stage_name: x('aws_api_gateway_stage.configured.stage_name'), method_path: '*/*' }, [blk('settings', { metrics_enabled: true, throttling_rate_limit: rate, throttling_burst_limit: burst, data_trace_enabled: false, logging_level: 'OFF' })]),
      output('api_id', 'aws_api_gateway_rest_api.configured.id'), output('invoke_url', JSON.stringify('https://${aws_api_gateway_rest_api.configured.id}.execute-api.' + region + '.${data.aws_partition.current.dns_suffix}/' + stage + '/' + path)),
      output('caller_policy_json', jsonencode({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'execute-api:Invoke', Resource: e('"${aws_api_gateway_rest_api.configured.execution_arn}/' + stage + '/' + method + '/' + path + '"') }] })),
    ], `# Private IAM REST API with Lambda proxy

## Prepare
Prepare an existing Lambda implementing the REST API proxy event/response contract; HTTP API v2 payload format is different. Choose an existing reviewed alias/published version where practical. Prepare regional execute-api interface endpoints with private DNS, approved private routing, HTTPS security rules and endpoint policies. Their private DNS affects resolution of default public execute-api endpoints in the VPC; review that DNS impact first. Private REST APIs use the service-supported dualstack model; this recipe does not force an IPv4-only API or change endpoint address families. On-premises clients need an approved private connection and DNS path.

Select caller roles whose trust and credential lifecycle are already controlled. This API requires SigV4 and explicitly denies requests from any unlisted endpoint or caller role ARN. Those denies also restrict otherwise broad same-account identity permissions. Cross-account callers still require the appropriate identity permission and endpoint policy. The package does not change caller role policies/trust. Export terraform output -raw caller_policy_json to a JSON file after apply and have the IAM owner attach the exact route/stage permission through the existing identity process. Do not put access keys in this package. Resource/network restrictions do not establish an ATO or authorize data transfer.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review private endpoints, explicit role/endpoint denies, method/path, Lambda qualifier and permission, stage and request limits; apply the saved reviewed plan. Configuration changes hash the method/integration/policy into a new deployment, then update the stage. If an access-log sink was supplied, its approved retention/permissions and the regional API Gateway account logging role must already be configured. Execution payload tracing/logging is off; method metrics are enabled. Throttling is best-effort request control, not a guaranteed cost or concurrency ceiling.

## Verify
Inspect REST API endpoint configuration, resource policy, deployed stage and Lambda permission. From a permitted private client, assume an allowed role through your normal identity process and make a SigV4 request using a maintained SDK/request signer, signing service execute-api and region ${region}. Verify REST proxy status/body and expected application behavior. An unsigned request, unlisted role and unlisted endpoint must fail; test each separately. Validate IPv4/IPv6 behavior for the actual endpoint configuration. Verify throttling/metrics, any access logs and Lambda observability, without logging credentials or sensitive bodies. Browser CORS, custom domains, authorizers, additional routes and application deployment are separate features.

## Recovery
Record the accepted deployment ID, Lambda alias/version and policy before change. Roll back by restoring reviewed configuration/alias and deploying it, or point the stage to an approved prior deployment through the owning configuration. A stage rollback does not undo application writes. Endpoint/DNS or caller-policy changes can affect other APIs; coordinate their owners before modifying/removing shared dependencies. Preserve logs and acceptance evidence. Local generation/validation does not invoke Lambda, assume caller roles or make API requests.

https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-private-apis.html
https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-resource-policies-examples.html
`, findings);
  },
} satisfies Blueprint;
