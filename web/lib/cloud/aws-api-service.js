import { error,              } from '../core/findings.js';
                                                     
import { blk, dat, output, res, x } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule, awsServiceRegion } from './aws-service-module.js';

export const AWS_API_SERVICE = {
  id: 'aws_service_http_api', label: 'Set up a Lambda-backed HTTP API',
  description: 'Create an HTTP API route, Lambda invocation permission, throttled stage and retained access logs.',
  emits: ['aws_apigatewayv2_api', 'aws_apigatewayv2_integration', 'aws_apigatewayv2_route', 'aws_apigatewayv2_stage', 'aws_lambda_permission', 'aws_cloudwatch_log_group'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'API name', control: 'text' },
    { id: 'function_name', label: 'Existing Lambda function name', control: 'text', hint: 'A function in this deployment account and region that accepts the selected API Gateway payload format.' },
    { id: 'method', label: 'HTTP method', control: 'select', default: 'GET', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ANY'].map(value => ({ value, label: value })) },
    { id: 'path', label: 'Route path', control: 'text', default: '/health', hint: 'For example /orders or /orders/{id}. A terminal {proxy+} matches nested paths.' },
    { id: 'authorization', label: 'Authorization', control: 'select', default: 'AWS_IAM', options: [
      { value: 'AWS_IAM', label: 'IAM — signed requests' }, { value: 'JWT', label: 'JWT — existing identity provider' }, { value: 'NONE', label: 'Public — no route authentication' },
    ] },
    { id: 'issuer', label: 'JWT issuer URL', control: 'text', showWhen: { input: 'authorization', equals: ['JWT'] } },
    { id: 'audiences', label: 'JWT audiences', control: 'text', hint: 'Comma-separated application audience identifiers.', showWhen: { input: 'authorization', equals: ['JWT'] } },
    { id: 'scopes', label: 'Required JWT scopes', control: 'text', hint: 'Optional comma-separated scopes. API Gateway requires at least one listed scope.', showWhen: { input: 'authorization', equals: ['JWT'] } },
    { id: 'payload', label: 'Lambda payload format', control: 'select', default: '2.0', options: [{ value: '2.0', label: '2.0' }, { value: '1.0', label: '1.0' }] },
    { id: 'stage', label: 'Stage name', control: 'text', default: 'prod' },
    { id: 'rate', label: 'Requests per second', control: 'number', min: 1, default: 100 },
    { id: 'burst', label: 'Burst limit', control: 'number', min: 1, default: 200 },
    { id: 'retention', label: 'Access log retention', control: 'select', default: '30', options: [7, 14, 30, 60, 90, 180, 365].map(value => ({ value: String(value), label: value + ' days' })) },
  ],
  build(values) {
    const findings            = [];
    const reject = (path        , message        ) => findings.push(error('aws.http-api.' + path, message, { path }));
    const name = String(values.name ?? '').trim(), fn = String(values.function_name ?? '').trim();
    const method = String(values.method ?? ''), path = String(values.path ?? ''), auth = String(values.authorization ?? '');
    const stage = String(values.stage ?? ''), payload = String(values.payload ?? '');
    const list = (key        ) => [...new Set(String(values[key] ?? '').split(',').map(item => item.trim()).filter(Boolean))];
    const audiences = list('audiences'), scopes = list('scopes'), issuer = String(values.issuer ?? '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(name)) reject('name', 'Use 1–100 letters, numbers, hyphens or underscores.');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(fn)) reject('function_name', 'Enter the existing Lambda function name.');
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ANY'].includes(method)) reject('method', 'Select an HTTP method.');
    if (!/^\/(?:[A-Za-z0-9._~-]+|\{[A-Za-z0-9_]+\}|\{proxy\+\})?(?:\/(?:[A-Za-z0-9._~-]+|\{[A-Za-z0-9_]+\}|\{proxy\+\}))*$/.test(path) || path.length > 300 || /\{proxy\+\}.+/.test(path)) reject('path', 'Enter a route path with optional named parameters or a terminal {proxy+}.');
    if (!['AWS_IAM', 'JWT', 'NONE'].includes(auth)) reject('authorization', 'Select route authorization.');
    if (auth === 'JWT') {
      try { const url = new URL(issuer); if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error(); }
      catch { reject('issuer', 'Enter an HTTPS identity-provider issuer URL without credentials, a query or a fragment.'); }
      if (!audiences.length || audiences.length > 50 || audiences.some(item => item.length > 255)) reject('audiences', 'Enter 1–50 audience identifiers of at most 255 characters.');
      if (scopes.length > 10 || scopes.some(item => /\s/.test(item) || item.length > 64)) reject('scopes', 'Enter at most ten scopes, each up to 64 characters without spaces.');
    }
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(stage)) reject('stage', 'Use a stage name of letters, numbers, hyphens or underscores.');
    if (!['1.0', '2.0'].includes(payload)) reject('payload', 'Select the Lambda payload format.');
    const integer = (key        ) => { const value = Number(values[key]); if (!Number.isInteger(value) || value < 1 || value > 1000000) reject(key, 'Enter a whole number from 1 to 1,000,000 and confirm account quotas.'); return value; };
    const rate = integer('rate'), burst = integer('burst'), retention = Number(values.retention);
    if (![7, 14, 30, 60, 90, 180, 365].includes(retention)) reject('retention', 'Select access log retention.');
    return awsServiceModule(String(values.aws_region ?? ''), [
      dat('aws_lambda_function', 'backend', { function_name: fn }),
      res('aws_apigatewayv2_api', 'configured', { name, protocol_type: 'HTTP' }),
      res('aws_cloudwatch_log_group', 'access', { name: '/aws/apigateway/' + name, retention_in_days: retention }),
      res('aws_apigatewayv2_integration', 'backend', {
        api_id: x('aws_apigatewayv2_api.configured.id'), integration_type: 'AWS_PROXY',
        integration_uri: x('data.aws_lambda_function.backend.invoke_arn'), integration_method: 'POST', payload_format_version: payload, timeout_milliseconds: 30000,
      }),
      ...(auth === 'JWT' ? [res('aws_apigatewayv2_authorizer', 'jwt', {
        api_id: x('aws_apigatewayv2_api.configured.id'), name: name + '-jwt', authorizer_type: 'JWT', identity_sources: ['$request.header.Authorization'],
      }, [blk('jwt_configuration', { audience: audiences, issuer })])] : []),
      res('aws_apigatewayv2_route', 'configured', {
        api_id: x('aws_apigatewayv2_api.configured.id'), route_key: method + ' ' + path,
        target: x('"integrations/${aws_apigatewayv2_integration.backend.id}"'), authorization_type: auth,
        ...(auth === 'JWT' ? { authorizer_id: x('aws_apigatewayv2_authorizer.jwt.id'), authorization_scopes: scopes } : {}),
      }),
      res('aws_apigatewayv2_stage', 'configured', {
        api_id: x('aws_apigatewayv2_api.configured.id'), name: stage, auto_deploy: true,
        depends_on: x('[aws_apigatewayv2_route.configured, aws_lambda_permission.gateway]'),
      }, [blk('default_route_settings', { throttling_rate_limit: rate, throttling_burst_limit: burst }),
        blk('access_log_settings', { destination_arn: x('aws_cloudwatch_log_group.access.arn'), format: JSON.stringify({ requestId: '$context.requestId', routeKey: '$context.routeKey', status: '$context.status', responseLength: '$context.responseLength', integrationError: '$context.integrationErrorMessage' }) })]),
      res('aws_lambda_permission', 'gateway', {
        statement_id_prefix: 'AllowHttpApi-', action: 'lambda:InvokeFunction', function_name: x('data.aws_lambda_function.backend.function_name'),
        principal: 'apigateway.amazonaws.com', source_arn: x('"${aws_apigatewayv2_api.configured.execution_arn}/' + stage + '/*/*"'),
      }),
      output('api_endpoint', 'aws_apigatewayv2_stage.configured.invoke_url'),
    ], `# Lambda-backed HTTP API

## Prepare
Use an existing Lambda in the selected account and region. Verify its handler accepts the selected payload format and returns an API Gateway proxy response. Confirm HTTP API availability and account throttling limits in this region. This creates a public regional endpoint; IAM or JWT controls route access. For private REST APIs, custom domains, CORS, WebSocket APIs or VPC-link integrations, use the respective existing resource builders.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review the route, authentication, invocation permission, log retention and throttling. Apply the saved plan. Stage auto-deployment publishes subsequent route changes. No function code or execution-role permissions are modified.

## Verify
Read api_endpoint and append the route path. For IAM, grant callers execute-api:Invoke only for the intended API, stage, method and path and send SigV4-signed requests. For JWT, test valid, expired, wrong-issuer, wrong-audience and missing-scope tokens. For public access, confirm unauthenticated requests are intended. Test the successful response, Lambda failure handling and throttling. Inspect access logs and Lambda metrics before routing production traffic.

## Recovery
Keep the preceding application endpoint during cutover. Restore its client configuration or DNS if verification fails. Apply the previous reviewed configuration to reverse route changes. Review retention and export required access evidence before removing the log group. This package does not establish an authorization boundary or grant production approval.

https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api.html
https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-access-control-iam.html
`, findings);
  },
}                    ;
