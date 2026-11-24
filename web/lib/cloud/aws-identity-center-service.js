import { bool } from '../kit/blueprint.js';
import { error,              } from '../core/findings.js';
                                                     
import { blk, dat, output, res, x } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.js';

export const AWS_IDENTITY_CENTER_SERVICE = {
  id: 'aws_service_identity_center', label: 'Set up an Identity Center permission set',
  description: 'Create a permission set in an existing organization instance, attach an AWS-managed policy and optionally assign a user or group to one account.',
  emits: ['aws_ssoadmin_permission_set', 'aws_ssoadmin_managed_policy_attachment', 'aws_ssoadmin_account_assignment'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Permission set name', control: 'text' },
    { id: 'instance', label: 'Existing organization Identity Center instance ARN', control: 'text', hint: 'Select its home region above. Existing identity source, users and groups must already be configured.' },
    { id: 'policy', label: 'AWS-managed policy name or path', control: 'combo', default: 'ReadOnlyAccess', options: ['ReadOnlyAccess', 'job-function/ViewOnlyAccess', 'PowerUserAccess', 'AdministratorAccess'].map(value => ({ value, label: value })), hint: 'Use an existing AWS-managed policy path. Review its effective privileges, boundaries and organization controls.' },
    { id: 'duration', label: 'Account session duration', control: 'select', default: 'PT1H', options: Array.from({ length: 12 }, (_, index) => ({ value: 'PT' + (index + 1) + 'H', label: (index + 1) + ' hour' + (index ? 's' : '') })) },
    { id: 'assign', label: 'Include account assignment', control: 'toggle', default: false },
    { id: 'account', label: 'Target AWS account ID', control: 'text', showWhen: { input: 'assign', equals: ['true'] } },
    { id: 'principal_type', label: 'Assigned identity type', control: 'select', default: 'GROUP', options: [{ value: 'GROUP', label: 'Group' }, { value: 'USER', label: 'User' }], showWhen: { input: 'assign', equals: ['true'] } },
    { id: 'principal', label: 'Existing identity-store principal ID', control: 'text', hint: 'The actual group/user ID from this instance’s identity store, not a display name or IAM ARN.', showWhen: { input: 'assign', equals: ['true'] } },
  ],
  build(values) {
    const findings            = [];
    const reject = (path        , message        ) => findings.push(error('aws.identity-center.' + path, message, { path }));
    const location = String(values.aws_region ?? ''), partition = awsServicePartition(location), name = String(values.name ?? ''), instance = String(values.instance ?? ''), policy = String(values.policy ?? ''), duration = String(values.duration ?? '');
    const assign = bool(values, 'assign'), account = String(values.account ?? ''), principalType = String(values.principal_type ?? ''), principal = String(values.principal ?? '');
    if (!/^[A-Za-z0-9_+=,.@-]{1,32}$/.test(name)) reject('name', 'Use 1–32 permission-set name characters.');
    if (!new RegExp('^arn:' + partition + ':sso:::instance/(?:sso)?ins-[A-Za-z0-9-]{16}$').test(instance)) reject('instance', 'Use an organization Identity Center instance ARN in the selected partition.');
    if (!/^[A-Za-z0-9_+=,.@/-]{1,512}$/.test(policy) || policy.startsWith('/') || policy.endsWith('/') || policy.includes('//')) reject('policy', 'Enter an AWS-managed policy name or path, without an ARN prefix.');
    if (!/^PT(?:[1-9]|1[0-2])H$/.test(duration)) reject('duration', 'Select a duration from 1–12 hours.');
    if (assign) {
      if (!/^\d{12}$/.test(account)) reject('account', 'Enter the target 12-digit AWS account ID.');
      if (!['USER', 'GROUP'].includes(principalType)) reject('principal_type', 'Select a user or group.');
      if (!/^(?:[a-f0-9]{10}-)?[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(principal)) reject('principal', 'Enter the existing identity-store principal ID.');
    }
    return awsServiceModule(location, [
      dat('aws_ssoadmin_instances', 'available', {}),
      res('aws_ssoadmin_permission_set', 'configured', { name, instance_arn: instance, session_duration: duration }, [blk('lifecycle', {}, [blk('precondition', { condition: x('contains(tolist(data.aws_ssoadmin_instances.available.arns), ' + JSON.stringify(instance) + ')'), error_message: 'Use an accessible organization instance in its configured home region.' })])]),
      res('aws_ssoadmin_managed_policy_attachment', 'configured', { instance_arn: instance, permission_set_arn: x('aws_ssoadmin_permission_set.configured.arn'), managed_policy_arn: 'arn:' + partition + ':iam::aws:policy/' + policy }),
      ...(assign ? [res('aws_ssoadmin_account_assignment', 'configured', { instance_arn: instance, permission_set_arn: x('aws_ssoadmin_permission_set.configured.arn'), target_type: 'AWS_ACCOUNT', target_id: account, principal_type: principalType, principal_id: principal, depends_on: x('[aws_ssoadmin_managed_policy_attachment.configured]') })] : []),
      output('permission_set_arn', 'aws_ssoadmin_permission_set.configured.arn'),
    ], `# IAM Identity Center permission set

## Prepare
Use an existing organization instance in its home region and an authorized management/delegated-administrator identity. Verify the target account belongs to the intended organization and that the selected principal ID belongs to this instance's identity store. Review effective AWS-managed policy permissions, session duration, SCPs and any other access controls. This form does not enable Identity Center, federate an identity provider, create users/groups or configure MFA.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review the exact policy, instance and optional principal/account assignment. Apply the saved plan. With assignment disabled, the permission set has no new account assignment. With assignment included, applying grants the selected principal the configured access in the target account. Existing permission sets and assignments must be imported and reviewed before managing them in this state.

## Verify
Confirm permission-set provisioning and assignment status. Test access through the intended user's portal/CLI session, including expected allowed and denied actions, target account and session duration. Confirm group membership and identity-provider synchronization. Review effective access rather than treating a successful assignment API call as proof of least privilege.

## Recovery
Remove or change the assignment through a reviewed configuration update and verify provisioning status. Do not assume removing an assignment immediately invalidates all active credentials; use the applicable session-revocation process when required. Keep a reviewed administrative recovery path during identity changes. Customer-managed policies, inline policies, permission boundaries, application assignments and additional accounts use their corresponding existing builders.

https://docs.aws.amazon.com/singlesignon/latest/userguide/permissionsetsconcept.html
`, findings);
  },
}                    ;
