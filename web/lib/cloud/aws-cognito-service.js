import { error,              } from '../core/findings.js';
                                                     
import { blk, e, jsonencode, output, res, x } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule, awsServiceRegion } from './aws-service-module.js';

export const AWS_COGNITO_SERVICE = {
  id: 'aws_service_cognito', label: 'Set up a Cognito web application sign-in',
  description: 'Create an email-sign-in user pool, public authorization-code client, hosted domain and deploy-time OIDC configuration.',
  emits: ['aws_cognito_user_pool', 'aws_cognito_user_pool_client', 'aws_cognito_user_pool_domain'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'User pool / application name', control: 'text' },
    { id: 'domain', label: 'Hosted sign-in domain prefix', control: 'text', hint: 'Unique lowercase prefix in this region. The classic hosted sign-in UI is used.' },
    { id: 'callbacks', label: 'Allowed callback URLs', control: 'text', hint: 'Comma-separated exact HTTPS callback URLs. HTTP is allowed only on localhost, 127.0.0.1 or [::1] for development.' },
    { id: 'logout', label: 'Allowed logout URLs', control: 'text', hint: 'Optional comma-separated exact HTTPS logout URLs, with the same local-development exception.' },
    { id: 'registration', label: 'User registration', control: 'select', default: 'admin', options: [{ value: 'admin', label: 'Administrators create users' }, { value: 'self', label: 'Allow self-registration with email verification' }] },
    { id: 'mfa', label: 'Multifactor authentication', control: 'select', default: 'ON', options: [{ value: 'ON', label: 'Require authenticator-app TOTP' }, { value: 'OFF', label: 'Do not require MFA' }] },
    { id: 'password', label: 'Minimum password length', control: 'number', default: 14, hint: '12–99 characters; uppercase, lowercase, numbers and symbols are required.' },
    { id: 'access', label: 'Access / ID token lifetime (minutes)', control: 'number', default: 60 },
    { id: 'refresh', label: 'Refresh token lifetime (days)', control: 'number', default: 30 },
  ],
  build(values) {
    const findings            = [];
    const reject = (path        , message        ) => findings.push(error('aws.cognito.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), name = String(values.name ?? '').trim(), domain = String(values.domain ?? '').trim();
    const list = (id        ) => [...new Set(String(values[id] ?? '').split(/[,\n]/).map(value => value.trim()).filter(Boolean))];
    const callbacks = list('callbacks'), logout = list('logout'), registration = String(values.registration ?? ''), mfa = String(values.mfa ?? ''), password = Number(values.password), access = Number(values.access), refresh = Number(values.refresh);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(name)) reject('name', 'Use 1–120 letters, numbers, dots, underscores or hyphens.');
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain) || /aws|amazon|cognito/.test(domain)) reject('domain', 'Use 1–63 lowercase letters, numbers or internal hyphens; avoid reserved aws, amazon and cognito text.');
    const validURL = (value        ) => {
      try { const url = new URL(value); return value.length <= 1024 && !url.hash && !url.username && !url.password && !/[\s*]/.test(value) && (url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)); } catch { return false; }
    };
    if (!callbacks.length || callbacks.length > 100 || callbacks.some(value => !validURL(value))) reject('callbacks', 'Enter 1–100 exact HTTPS callback URLs without credentials, fragments or wildcards; HTTP loopback is development-only.');
    if (logout.length > 100 || logout.some(value => !validURL(value))) reject('logout', 'Use up to 100 exact approved logout URLs, with HTTPS or development loopback.');
    if (!['admin', 'self'].includes(registration)) reject('registration', 'Select a registration mode.');
    if (!['ON', 'OFF'].includes(mfa)) reject('mfa', 'Choose required TOTP or MFA off.');
    if (!Number.isInteger(password) || password < 12 || password > 99) reject('password', 'Use a whole minimum password length from 12 to 99.');
    if (!Number.isInteger(access) || access < 5 || access > 1440) reject('access', 'Use 5–1440 whole minutes for access and ID tokens.');
    if (!Number.isInteger(refresh) || refresh < 1 || refresh > 3650) reject('refresh', 'Use 1–3650 whole days for refresh tokens.');
    return awsServiceModule(region, [
      res('aws_cognito_user_pool', 'configured', { name, user_pool_tier: 'LITE', username_attributes: ['email'], auto_verified_attributes: ['email'], mfa_configuration: mfa, deletion_protection: 'ACTIVE' }, [
        blk('username_configuration', { case_sensitive: false }),
        blk('admin_create_user_config', { allow_admin_create_user_only: registration === 'admin' }),
        blk('password_policy', { minimum_length: password, require_lowercase: true, require_uppercase: true, require_numbers: true, require_symbols: true, temporary_password_validity_days: 3 }),
        blk('account_recovery_setting', {}, [blk('recovery_mechanism', { name: 'verified_email', priority: 1 })]),
        blk('user_attribute_update_settings', { attributes_require_verification_before_update: ['email'] }),
        ...(mfa === 'ON' ? [blk('software_token_mfa_configuration', { enabled: true })] : []),
        blk('verification_message_template', { default_email_option: 'CONFIRM_WITH_CODE' }),
        blk('lifecycle', { prevent_destroy: true }),
      ]),
      res('aws_cognito_user_pool_domain', 'configured', { domain, user_pool_id: x('aws_cognito_user_pool.configured.id'), managed_login_version: 1 }),
      res('aws_cognito_user_pool_client', 'configured', { name: name + '-web', user_pool_id: x('aws_cognito_user_pool.configured.id'), generate_secret: false, allowed_oauth_flows_user_pool_client: true, allowed_oauth_flows: ['code'], allowed_oauth_scopes: ['openid', 'email', 'profile'], supported_identity_providers: ['COGNITO'], callback_urls: callbacks, ...(logout.length ? { logout_urls: logout } : {}), default_redirect_uri: callbacks[0] ?? '', prevent_user_existence_errors: 'ENABLED', enable_token_revocation: true, explicit_auth_flows: ['ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'], access_token_validity: access, id_token_validity: access, refresh_token_validity: refresh }, [blk('token_validity_units', { access_token: 'minutes', id_token: 'minutes', refresh_token: 'days' })]),
      output('user_pool_id', 'aws_cognito_user_pool.configured.id'), output('client_id', 'aws_cognito_user_pool_client.configured.id'),
      output('oidc_client_json', jsonencode({ authority: e('"https://${aws_cognito_user_pool.configured.endpoint}"'), client_id: e('aws_cognito_user_pool_client.configured.id'), redirect_uri: callbacks[0] ?? '', response_type: 'code', scope: 'openid email profile' })),
    ], `# Cognito email sign-in for a public web application

## Prepare
Confirm the regional domain prefix is available, approved application origins and exact callback/logout routes. This creates a new Lite-tier email-sign-in pool, public client and classic hosted UI. Existing users are not imported. Built-in Cognito email has restricted sending quotas; plan a verified SES sending configuration and delivery tests before production onboarding at scale. Review regional availability, identity-data handling, costs, quotas, registration and recovery policy. User attributes and username choices can require replacement later; deletion protections deliberately prevent accidental identity loss.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review registration, TOTP, password/token policy and every redirect URL, then apply the saved plan. Export terraform output -raw oidc_client_json into the web application's OIDC configuration. Use a maintained OIDC client library with authorization code, PKCE S256, unpredictable state and nonce, exact redirect matching and secure token handling. PKCE must be implemented by the client; this Terraform client configuration does not enforce it for every caller. Never add a client secret to browser code. Discovery under the authority identifies the authorization, token and JWKS endpoints.

## Verify
With administrator-only registration, create a test account through an authorized Cognito administrator and complete the invitation/password flow. With self-registration, test email-code verification. When TOTP is required, enroll an authenticator and test sign-in, recovery and denied access without the second factor. Test successful callback, rejected unregistered callback, expired token and logout/revocation behavior. APIs must verify signature, exact issuer, token_use and the correct client/audience claims; apply authorization separately. Account recovery needs a verified email. Do not log tokens, codes or personal identity information in unapproved destinations.

## Recovery
Keep existing application authentication during pilot cutover. Restore prior client configuration if integration fails and invalidate affected sessions through the authorized identity operator. Refresh-token revocation does not make an already-issued JWT disappear from offline verifiers; account for access-token lifetime. Preserve identity records and recovery evidence. Pool deletion is blocked in AWS and Terraform; removing it requires explicit reviewed changes. This path does not configure federation, custom SES email, custom domains, user migration triggers, custom resource-server scopes, Identity Pools or application/API authorization.

https://docs.aws.amazon.com/cognito/latest/developerguide/using-pkce-in-authorization-code.html
`, findings);
  },
}                    ;
