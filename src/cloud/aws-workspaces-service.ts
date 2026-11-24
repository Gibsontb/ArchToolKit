import { error, type Finding } from '../core/findings.ts';
import type { Blueprint } from '../kit/blueprint.ts';
import { blk, dat, hcl, output, res, x } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.ts';
export const AWS_WORKSPACES_SERVICE = {
  id: 'aws_service_workspaces', label: 'Set up encrypted WorkSpaces Personal desktops',
  description: 'Use an existing WorkSpaces registration or register an existing Microsoft AD, resolve a regional bundle and create encrypted private desktops for existing users.',
  emits: ['aws_workspaces_directory', 'aws_workspaces_workspace'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Desktop group label', control: 'text' },
    { id: 'registration', label: 'Directory registration', control: 'select', default: 'EXISTING', options: [{ value: 'EXISTING', label: 'Existing WorkSpaces Personal directory registration' }, { value: 'NEW', label: 'Register an existing AWS Managed Microsoft AD directory' }] },
    { id: 'directory', label: 'Existing directory ID', control: 'text', hint: 'Already contains the selected users; no new AD forest, user or password is created.' },
    { id: 'subnets', label: 'Existing private desktop subnet IDs', control: 'text', showWhen: { input: 'registration', equals: ['NEW'] }, hint: 'Exactly two comma-separated IDs in supported different AZs and the managed-directory VPC.' },
    { id: 'group', label: 'Existing desktop security group ID', control: 'text', showWhen: { input: 'registration', equals: ['NEW'] }, hint: 'Same-VPC group with approved application/AD connectivity. Do not open RDP to the internet.' },
    { id: 'bundle', label: 'Regional Personal bundle ID', control: 'text', hint: 'Existing wsb-... bundle. Uses its image, compute and root/user storage defaults; verify OS, protocol, licensing and encryption support.' },
    { id: 'users', label: 'Existing AD usernames', control: 'text', hint: 'Comma-separated sAMAccountNames, up to 25 desktops. Check eligibility and existing user desktops first.' },
    { id: 'running', label: 'Running and billing mode', control: 'select', default: 'AUTO_STOP', options: [{ value: 'AUTO_STOP', label: 'AutoStop — hourly use plus recurring base/storage costs' }, { value: 'ALWAYS_ON', label: 'AlwaysOn — monthly running mode' }] },
    { id: 'timeout', label: 'AutoStop timeout (minutes)', control: 'select', default: '60', showWhen: { input: 'running', equals: ['AUTO_STOP'] }, options: [60, 120, 180, 240, 480].map(value => ({ value: String(value), label: String(value) })) },
    { id: 'kms', label: 'Volume encryption KMS key ARN', control: 'text', hint: 'Optional regional symmetric key. Blank resolves the existing alias/aws/workspaces key; that alias must exist before plan. Encrypts both root and user volumes.' },
  ],
  build(values) {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.workspaces.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), partition = awsServicePartition(region), name = String(values.name ?? '').trim(), registration = String(values.registration ?? ''), directory = String(values.directory ?? '').trim(), bundle = String(values.bundle ?? '').trim(), running = String(values.running ?? ''), kms = String(values.kms ?? '').trim();
    const list = (id: string) => [...new Set(String(values[id] ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    const users = list('users'), subnets = registration === 'NEW' ? list('subnets') : [], group = registration === 'NEW' ? String(values.group ?? '').trim() : '', timeout = running === 'AUTO_STOP' ? Number(values.timeout) : 0;
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(name)) reject('name', 'Use a letter followed by up to 99 letters, digits, underscores or hyphens.');
    if (!['EXISTING', 'NEW'].includes(registration)) reject('registration', 'Choose existing registration or new Microsoft AD registration.');
    if (!/^d-[a-f0-9]{10}$/.test(directory)) reject('directory', 'Enter the existing AD/WorkSpaces directory ID.');
    if (!/^wsb-[a-z0-9]{8,63}$/.test(bundle)) reject('bundle', 'Enter an available regional WorkSpaces Personal bundle ID.');
    if (!users.length || users.length > 25 || users.some(user => !/^[A-Za-z0-9_.-]{1,63}$/.test(user)) || new Set(users.map(user => user.toLowerCase())).size !== users.length) reject('users', 'Use 1–25 distinct existing AD usernames without domain prefixes or case-only duplicates.');
    if (!['AUTO_STOP', 'ALWAYS_ON'].includes(running)) reject('running', 'Choose AutoStop or AlwaysOn.');
    if (running === 'AUTO_STOP' && ![60, 120, 180, 240, 480].includes(timeout)) reject('timeout', 'Choose a timeout in 60-minute intervals.');
    if (kms && !new RegExp('^arn:' + partition + ':kms:' + region + ':\\d{12}:key/(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|mrk-[a-f0-9]{32})$').test(kms)) reject('kms', 'Use a regional symmetric KMS key ARN with a UUID or multi-Region key ID.');
    if (registration === 'NEW') {
      if (subnets.length !== 2 || subnets.some(subnet => !/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(subnet))) reject('subnets', 'Use exactly two private subnet IDs in different supported AZs.');
      if (!/^sg-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(group)) reject('group', 'Enter the existing approved desktop security group ID.');
    }
    const directoryRef = registration === 'NEW' ? 'aws_workspaces_directory.configured' : 'data.aws_workspaces_directory.selected';
    const guide = [
      '# Encrypted private WorkSpaces Personal desktops',
      '## Prepare\nSelect an available regional Personal bundle and verify image/OS, protocol, compute, default storage, software licensing and encryption support. The bundle data source resolves its actual properties; this recipe uses those defaults without compute/disk overrides. AutoStop still incurs recurring base/storage costs. Review regional quotas, supported desktop AZs, client access and pricing. Pools, Core, BYOL enablement, custom images and identity-center registrations are separate workflows.',
      'The selected users must already exist in the intended AD directory and be eligible. No user/password is created or exported. Check existing WorkSpaces per user before provisioning.',
      registration === 'NEW' ? 'This package registers an existing same-VPC AWS Managed Microsoft AD directory; it does not create AD. Create and validate workspaces_DefaultRole through the approved IAM process first, including required permissions and service trust. Select two supported private subnet AZs with AD/DNS connectivity and free addresses. The new registration disables automatic public IP assignment and local-administrator grants; self-service permits restart only. Existing registrations must be imported/adopted by their owner, not registered again.' : 'Use an existing WorkSpaces Personal AD registration. Its owner retains subnet, AD, security-group, authentication, self-service and maintenance settings. Automatic public IP assignment must be disabled for this private path; this package does not silently modify the shared registration.',
      '## Implement\nReview private desktop routing, AD/DNS/NACL/security groups, application egress through approved endpoints/NAT and the separate client streaming path. Do not open RDP to the internet. Configure approved device access, MFA/SAML, clipboard/USB/printing/redirection, patching, endpoint protection and DLP through directory/image/client policies. Verify KMS grants and encryption-compatible bundles. No compliant baseline is implied by a new desktop.',
      'Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review directory ownership, bundle properties, users, billing mode, encryption and any new directory defaults; apply the reviewed plan. Blank key selection explicitly resolves the existing alias/aws/workspaces key during plan; if not yet initialized for this account/region, have the account owner establish the approved service key or supply a customer-managed key ARN. The key must be enabled and symmetric; grants/key-policy permissions still need review. Wait for each desktop to reach AVAILABLE or the appropriate AutoStop state. Existing users and directory settings remain separately owned.',
      '## Verify\nUse aws workspaces describe-workspaces --directory-id ' + directory + ' --region ' + region + '. Check intended users, bundle, both encrypted volumes, mode, timeout and private addresses. Test an approved current WorkSpaces client with a designated test user and the registration-code output. Verify sign-in/MFA, group policy, application/FSx access, data controls and endpoint telemetry. Test disconnect/AutoStop/reconnect and user-data persistence. Terraform creation does not prove these controls.',
      '## Recovery\nRecord current desktop/user-profile/application data before changes. Rebuild/restore can affect root and user data differently; validate service recovery behavior and independent backups before use. Keep source desktops/profiles and cutback arrangements until migration acceptance. Removing a user from the configuration plans desktop destruction, blocked by prevent_destroy until explicitly reviewed. Termination can destroy data; deregister only after dependent desktops/services are migrated. Local generation/validation creates no desktop, changes no directory and sends no invitations.',
      'https://docs.aws.amazon.com/workspaces/latest/adminguide/workspaces-access-control.html\nhttps://docs.aws.amazon.com/workspaces/latest/adminguide/encrypt-workspaces.html',
    ].join('\n\n') + '\n';
    return awsServiceModule(region, [
      dat('aws_workspaces_bundle', 'selected', { bundle_id: bundle }),
      dat('aws_kms_key', 'volumes', { key_id: kms || 'alias/aws/workspaces' }),
      ...(registration === 'NEW' ? [
        dat('aws_directory_service_directory', 'selected', { directory_id: directory }),
        dat('aws_iam_role', 'service', { name: 'workspaces_DefaultRole' }),
        dat('aws_subnet', 'selected', { for_each: x('toset(' + JSON.stringify(subnets) + ')'), id: x('each.value') }),
        dat('aws_security_group', 'desktop', { id: group }),
        res('aws_workspaces_directory', 'configured', { directory_id: directory, subnet_ids: subnets, tags: x(hcl({ Name: name })) }, [
          blk('workspace_creation_properties', { custom_security_group_id: group, enable_internet_access: false, enable_maintenance_mode: true, user_enabled_as_local_administrator: false }),
          blk('self_service_permissions', { change_compute_type: false, increase_volume_size: false, rebuild_workspace: false, restart_workspace: true, switch_running_mode: false }),
          blk('lifecycle', { prevent_destroy: true }, [blk('precondition', { condition: x('data.aws_directory_service_directory.selected.type == "MicrosoftAD" && length(distinct([for subnet in data.aws_subnet.selected : subnet.vpc_id])) == 1 && length(distinct([for subnet in data.aws_subnet.selected : subnet.availability_zone])) == 2 && try(data.aws_directory_service_directory.selected.vpc_settings[0].vpc_id, "") == data.aws_security_group.desktop.vpc_id && alltrue([for subnet in data.aws_subnet.selected : subnet.vpc_id == data.aws_security_group.desktop.vpc_id]) && length(data.aws_iam_role.service.arn) > 0'), error_message: 'Use a same-VPC MicrosoftAD directory, approved group, two subnet AZs and the existing WorkSpaces default service role.' })]),
        ]),
      ] : [dat('aws_workspaces_directory', 'selected', { directory_id: directory })]),
      res('aws_workspaces_workspace', 'configured', { for_each: x('toset(' + JSON.stringify(users) + ')'), directory_id: x(directoryRef + '.id'), bundle_id: x('data.aws_workspaces_bundle.selected.id'), user_name: x('each.value'), root_volume_encryption_enabled: true, user_volume_encryption_enabled: true, volume_encryption_key: x('data.aws_kms_key.volumes.arn'), tags: x(hcl({ Name: name })) }, [
        blk('workspace_properties', { running_mode: running, ...(running === 'AUTO_STOP' ? { running_mode_auto_stop_timeout_in_minutes: timeout } : {}) }),
        blk('lifecycle', { prevent_destroy: true }, [
          blk('precondition', { condition: x('data.aws_kms_key.volumes.enabled && data.aws_kms_key.volumes.key_spec == "SYMMETRIC_DEFAULT" && data.aws_kms_key.volumes.key_usage == "ENCRYPT_DECRYPT"'), error_message: 'Use an existing enabled symmetric encryption key with the required WorkSpaces grants.' }),
          ...(registration === 'EXISTING' ? [blk('precondition', { condition: x('try(data.aws_workspaces_directory.selected.workspace_creation_properties[0].enable_internet_access, false) == false'), error_message: 'This private-desktop recipe requires automatic public IP assignment disabled. Have the shared directory owner review/change it separately.' })] : []),
        ]),
      ]),
      output('directory_id', directoryRef + '.id'), output('registration_code', directoryRef + '.registration_code'),
      output('volume_encryption_key_arn', 'data.aws_kms_key.volumes.arn'),
      output('bundle_compute_type', 'data.aws_workspaces_bundle.selected.compute_type[0].name'), output('bundle_root_storage_gib', 'data.aws_workspaces_bundle.selected.root_storage[0].capacity'), output('bundle_user_storage_gib', 'data.aws_workspaces_bundle.selected.user_storage[0].capacity'),
      output('desktops', '{ for user, desktop in aws_workspaces_workspace.configured : user => { id = desktop.id, computer_name = desktop.computer_name, ip_address = desktop.ip_address, state = desktop.state } }'),
    ], guide, findings);
  },
} satisfies Blueprint;
