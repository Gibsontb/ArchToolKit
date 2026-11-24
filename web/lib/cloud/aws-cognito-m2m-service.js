import { error,              } from '../core/findings.js';
                                                     
import { blk, dat, e, hcl, jsonencode, output, res, x } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.js';
export const AWS_COGNITO_M2M_SERVICE = {
  id: 'aws_service_cognito_m2m', label: 'Set up Cognito machine-to-machine authorization',
  description: 'Dedicated pool, custom API scopes, confidential client-credentials client, protected Secrets Manager storage and an explicit token-request probe.',
  emits: ['aws_cognito_user_pool', 'aws_cognito_resource_server', 'aws_cognito_user_pool_client', 'aws_cognito_user_pool_domain', 'aws_secretsmanager_secret', 'aws_secretsmanager_secret_version'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Machine identity application name', control: 'text' },
    { id: 'domain', label: 'Unique hosted domain prefix', control: 'text', hint: 'This creates a public HTTPS OAuth token endpoint. No browser callback or human sign-in flow is configured.' },
    { id: 'identifier', label: 'API resource identifier', control: 'text', default: 'application-api' },
    { id: 'scopes', label: 'Custom API scope names', control: 'text', default: 'read', hint: 'Comma-separated exact action names. Tokens authorize these scopes; the receiving API must validate signatures and enforce them.' },
    { id: 'minutes', label: 'Access token lifetime (minutes)', control: 'number', default: 15 },
    { id: 'kms', label: 'Optional client-secret KMS key ARN', control: 'text', hint: 'Existing enabled regional symmetric key; otherwise Secrets Manager service-managed encryption. Generated secret still exists in protected Terraform state.' },
  ],
  build(values)                                      {
    const findings            = [];
    const reject = (path        , message        ) => findings.push(error('aws.cognito.m2m.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), partition = awsServicePartition(region), name = String(values.name ?? '').trim(), domain = String(values.domain ?? '').trim(), identifier = String(values.identifier ?? '').trim(), kms = String(values.kms ?? '').trim(), minutes = Number(values.minutes);
    const scopes = [...new Set(String(values.scopes ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) reject('name', 'Use a letter followed by up to 63 letters, digits, underscores or hyphens.');
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain) || /aws|amazon|cognito/.test(domain)) reject('domain', 'Use a unique 1–63 character lowercase domain prefix without reserved aws/amazon/cognito text.');
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(identifier)) reject('identifier', 'Use a literal API identifier up to 100 characters, without slash or wildcard.');
    if (!scopes.length || scopes.length > 20 || scopes.some(value => !/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(value))) reject('scopes', 'Use 1–20 literal action names up to 64 characters, without whitespace, slash or wildcard.');
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) reject('minutes', 'Use 5–1440 access-token minutes.');
    if (kms && !new RegExp('^arn:' + partition + ':kms:' + region + ':\\d{12}:key/(?:[a-f0-9-]{36}|mrk-[a-f0-9]{32})$').test(kms)) reject('kms', 'Use an existing regional symmetric KMS key ARN.');
    const suffix = partition === 'aws-cn' ? 'amazoncognito.com.cn' : 'amazoncognito.com', tokenEndpoint = 'https://' + domain + '.auth.' + region + '.' + suffix + '/oauth2/token';
    const guide = [
      '# Cognito hosted-domain machine-to-machine authorization',
      '## Prepare\nVerify regional Cognito user-pool/domain availability and authorization for the receiving data boundary. The hosted OAuth endpoint is public HTTPS; this recipe does not create a private token endpoint, establish an ATO or configure a FIPS boundary. Machine clients must protect their secret. M2M billing depends on active clients and token request volume, rather than human monthly-active-user pricing; review current Cognito pricing and choose token caching/lifetime accordingly. This is the hosted-domain client_credentials path, not the newer domainless GetClientToken API or a human web sign-in client.',
      '## Deploy\nRun terraform init, terraform validate and terraform plan -out=service.tfplan. Review the dedicated admin-created-user-only pool, custom resource-server scopes, confidential client, domain and secret store, then apply the reviewed plan. User signup is disabled and no human users are created. Only client_credentials OAuth is allowed; SRP/password/custom user authentication flows are not enabled. The refresh-only explicit auth setting cannot mint a human session on this new client; M2M client-credentials responses do not issue refresh/ID tokens. No browser callback/logout fields are needed. Pool deletion protection and Terraform prevent_destroy guard removal.',
      'Cognito generates the client secret and Terraform stores it in Secrets Manager. The secret is not a nonsensitive output or literal archive value, but it still exists in provider state and saved plans: protect backend encryption/access and plan artifacts. The optional key protects the Secrets Manager value, not Cognito JWT signing or pool data. The new secret has a 30-day recovery window and destruction guard. Grant the machine identity only this exact secret GetSecretValue and any required customer-key decrypt through its approved role. This package does not change an application role or automatically rotate its credentials.',
      '## Probe explicitly\nInstall approved requirements.txt. Run python TOKEN-PROBE.py to preview nonsensitive configuration without loading AWS credentials or making network requests. With the approved exact-secret reader role, use --request-token to read the secret and issue one HTTPS client-credentials request for the selected scopes. The probe checks the account, secret client ID and configured endpoint; authenticated redirects are refused, raw secrets/tokens are never printed, and HTTP failure bodies are not echoed. A token request may be billable. The probe reports only response metadata and discards the token; do not use console output as a credential-distribution mechanism.',
      '## Integrate and verify\nUse the issuer/JWKS/client ID/custom scopes outputs to configure the receiving API authorizer. Validate JWT signature using the correct issuer JWKS, expiration, token_use=access, expected client_id (and audience where configured) and required method/path scopes. Decoding a JWT or successfully minting one does not prove authorization at the API. Test allowed scope operations and deny other scopes/clients/issuers, expired tokens and ID tokens. Never place the confidential secret in browser/mobile code. Use a vetted OAuth library and approved in-memory token cache in production; the one-shot probe is not a production token manager.',
      '## Recovery and rotation\nKeep the old client/API policy until replacement-client secret delivery and negative/positive authorization tests pass. Rotate through a reviewed replacement or service-supported secret rotation procedure, update the exact secret reader and callers, and account for previously issued access-token lifetime before revocation/cutover. Terraform cannot promise immediate invalidation of already-issued JWTs at every relying API. Retain configuration and audit evidence; CloudTrail and API/application authentication logs need separate approved collection/retention. No token minting, API call, secret retrieval or user creation runs during local generation.',
      'https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-define-resource-servers.html\nhttps://docs.aws.amazon.com/cognito/latest/developerguide/token-endpoint.html',
    ].join('\n\n') + '\n';
    const result = awsServiceModule(region, [
      dat('aws_caller_identity', 'current', {}), dat('aws_partition', 'current', {}),
      ...(kms ? [dat('aws_kms_key', 'secret', { key_id: kms })] : []),
      res('aws_cognito_user_pool', 'configured', { name, user_pool_tier: 'LITE', deletion_protection: 'ACTIVE', tags: x(hcl({ Name: name })) }, [blk('admin_create_user_config', { allow_admin_create_user_only: true }), blk('lifecycle', { prevent_destroy: true })]),
      res('aws_cognito_resource_server', 'api', { name: identifier, identifier, user_pool_id: x('aws_cognito_user_pool.configured.id') }, scopes.map(scope => blk('scope', { scope_name: scope, scope_description: scope + ' API access' }))),
      res('aws_cognito_user_pool_client', 'machine', { name: name + '-machine', user_pool_id: x('aws_cognito_user_pool.configured.id'), generate_secret: true, allowed_oauth_flows: ['client_credentials'], allowed_oauth_flows_user_pool_client: true, allowed_oauth_scopes: x('aws_cognito_resource_server.api.scope_identifiers'), explicit_auth_flows: ['ALLOW_REFRESH_TOKEN_AUTH'], supported_identity_providers: ['COGNITO'], prevent_user_existence_errors: 'ENABLED', access_token_validity: minutes, id_token_validity: minutes, refresh_token_validity: 1 }, [blk('token_validity_units', { access_token: 'minutes', id_token: 'minutes', refresh_token: 'days' })]),
      res('aws_cognito_user_pool_domain', 'configured', { domain, user_pool_id: x('aws_cognito_user_pool.configured.id') }),
      res('aws_secretsmanager_secret', 'client', { name: name + '/oauth/client', recovery_window_in_days: 30, ...(kms ? { kms_key_id: x('data.aws_kms_key.secret.arn') } : {}), tags: x(hcl({ Name: name })) }, [blk('lifecycle', { prevent_destroy: true }, kms ? [blk('precondition', { condition: x('data.aws_kms_key.secret.enabled && data.aws_kms_key.secret.key_spec == "SYMMETRIC_DEFAULT"'), error_message: 'Use an enabled symmetric secret key.' })] : [])]),
      res('aws_secretsmanager_secret_version', 'client', { secret_id: x('aws_secretsmanager_secret.client.id'), secret_string: x(jsonencode({ client_id: e('aws_cognito_user_pool_client.machine.id'), client_secret: e('aws_cognito_user_pool_client.machine.client_secret') })) }),
      output('jwks_uri', 'format("https://cognito-idp.%s.%s/%s/.well-known/jwks.json", ' + JSON.stringify(region) + ', data.aws_partition.current.dns_suffix, aws_cognito_user_pool.configured.id)'),
      output('machine_configuration', '{ account = data.aws_caller_identity.current.account_id, region = ' + JSON.stringify(region) + ', client_id = aws_cognito_user_pool_client.machine.id, secret_arn = aws_secretsmanager_secret.client.arn, token_endpoint = ' + JSON.stringify(tokenEndpoint) + ', issuer = format("https://cognito-idp.%s.%s/%s", ' + JSON.stringify(region) + ', data.aws_partition.current.dns_suffix, aws_cognito_user_pool.configured.id), scopes = aws_cognito_resource_server.api.scope_identifiers }'),
    ], guide, findings);
    const probe = [
      'import argparse, base64, json, subprocess, urllib.error, urllib.parse, urllib.request',
      'parser = argparse.ArgumentParser(description="Preview configuration or explicitly request an M2M token without printing it")',
      'parser.add_argument("--request-token", action="store_true")',
      'args = parser.parse_args()',
      'config = json.loads(subprocess.check_output(["terraform","output","-json","machine_configuration"], text=True))',
      'if not args.request_token: print(json.dumps(config, indent=2)); raise SystemExit(0)',
      'if config["token_endpoint"] != ' + JSON.stringify(tokenEndpoint) + ': raise RuntimeError("Unexpected token endpoint")',
      'import boto3',
      'session = boto3.Session(region_name=config["region"])',
      'if session.client("sts").get_caller_identity()["Account"] != config["account"]: raise RuntimeError("Unexpected secret-reader account")',
      'secret = json.loads(session.client("secretsmanager").get_secret_value(SecretId=config["secret_arn"])["SecretString"])',
      'if secret["client_id"] != config["client_id"] or not secret.get("client_secret"): raise RuntimeError("Secret does not match this machine client")',
      'class NoRedirect(urllib.request.HTTPRedirectHandler):',
      '    def redirect_request(self, req, fp, code, msg, headers, newurl): raise RuntimeError("Refusing authenticated redirect")',
      'authorization = base64.b64encode((secret["client_id"] + ":" + secret["client_secret"]).encode("utf-8")).decode("ascii")',
      'body = urllib.parse.urlencode({"grant_type":"client_credentials","scope":" ".join(config["scopes"])}).encode("ascii")',
      'request = urllib.request.Request(config["token_endpoint"], data=body, headers={"Authorization":"Basic " + authorization,"Content-Type":"application/x-www-form-urlencoded"}, method="POST")',
      'try:',
      '    with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response: token = json.load(response)',
      'except urllib.error.HTTPError as error: raise RuntimeError("Token request rejected with HTTP status " + str(error.code)) from None',
      'if not token.get("access_token") or token.get("token_type","").lower() != "bearer" or not isinstance(token.get("expires_in"), int) or token["expires_in"] <= 0: raise RuntimeError("Incomplete token response")',
      'if "scope" in token and set(token["scope"].split()) != set(config["scopes"]): raise RuntimeError("Unexpected granted scopes")',
      'print(json.dumps({"request":"accepted","token_type":token["token_type"],"expires_in":token["expires_in"],"token_printed":False}))',
    ].join('\n') + '\n';
    return { ...result, files: { ...result.files, 'TOKEN-PROBE.py': probe, 'requirements.txt': 'boto3>=1.35,<2\n' } };
  },
}                    ;
