/**
 * Access utilities (added): add a user or a group (local on the servers, or
 * in Active Directory through a domain controller), and grant cloud access
 * (a group membership or a role on the landing zone's scope).
 *
 * Passwords are ansible-vault variables (`vault_user_password`, used only
 * when the account is created, with `no_log`); nothing in the bundle holds
 * one. Cloud access is additive: a membership or one role assignment, never
 * an authoritative policy that would drop the grants already there.
 */

import type { BlueprintValues } from '../../../kit/blueprint.ts';
import { q } from '../../../terraform/blueprints/migration/common.ts';
import {
  ALL_PLATFORMS, PLATFORM_LABELS, VSPHERE_INPUTS, ansibleProject, error, guestOs, info, locationLocals, locationVars, on, opt, osInput, platformInput, platformOf,
  playbook, psq, serverInput, tfRoot, val, vcfTool, warning, yq,
  type ChangeUtility, type Finding, type TfVar, type UtilityResult,
} from './common.ts';

// ---------------------------------------------------------------------------
// Users and groups
// ---------------------------------------------------------------------------

function linuxBook(kind: string, name: string, groups: readonly string[], key: string, sudo: boolean, present: boolean): string {
  const tasks: string[] = [];
  if (kind === 'group') {
    tasks.push(`    - name: Group ${name} ${present ? 'present' : 'absent'}
      ansible.builtin.group:
        name: "{{ change_name }}"
        state: ${present ? 'present' : 'absent'}`);
    if (sudo) {
      tasks.push(`    - name: Sudo for the group ${present ? 'granted' : 'removed'}
      community.general.sudoers:
        name: "atk-{{ change_name }}"
        group: "{{ change_name }}"
        commands: ALL
        state: ${present ? 'present' : 'absent'}`);
    }
  } else if (kind === 'membership') {
    tasks.push(present
      ? `    - name: ${name} added to the groups
      ansible.builtin.user:
        name: "{{ change_name }}"
        groups: "{{ change_groups }}"
        append: true`
      : `    - name: ${name} removed from the groups
      ansible.builtin.command:
        argv: [gpasswd, --delete, "{{ change_name }}", "{{ item }}"]
      loop: "{{ change_groups }}"
      register: change_gpasswd
      changed_when: change_gpasswd.rc == 0
      failed_when: false`);
  } else {
    if (present) {
      tasks.push(`    - name: User ${name} present (password locked; key login)
      ansible.builtin.user:
        name: "{{ change_name }}"
        groups: "{{ change_groups }}"
        append: true
        shell: /bin/bash
        create_home: true
        password_lock: true
        state: present`);
      if (key) {
        tasks.push(`    - name: The user's SSH public key
      ansible.posix.authorized_key:
        user: "{{ change_name }}"
        key: "{{ change_ssh_key }}"
        state: present`);
      }
    } else {
      tasks.push(`    - name: User ${name} absent (the home directory is kept)
      ansible.builtin.user:
        name: "{{ change_name }}"
        state: absent
        remove: false`);
    }
  }
  const vars = `    change_name: ${yq(name)}
    change_groups:${groups.length ? `\n${groups.map((g) => `      - ${yq(g)}`).join('\n')}` : ' []'}${key ? `\n    change_ssh_key: ${yq(key)}` : ''}`;
  return playbook(`${present ? 'Add' : 'Remove'} ${kind} ${name} (Linux)`, 'atk_change_linux', tasks.join('\n\n') + '\n', { become: true, vars });
}

function windowsBook(kind: string, name: string, groups: readonly string[], present: boolean): string {
  const tasks: string[] = [];
  if (kind === 'group') {
    tasks.push(`    - name: Local group ${name} ${present ? 'present' : 'absent'}
      ansible.windows.win_group:
        name: "{{ change_name }}"
        state: ${present ? 'present' : 'absent'}`);
  } else if (kind === 'membership') {
    tasks.push(`    - name: ${name} ${present ? 'added to' : 'removed from'} the local groups
      ansible.windows.win_group_membership:
        name: "{{ item }}"
        members:
          - "{{ change_name }}"
        state: ${present ? 'present' : 'absent'}
      loop: "{{ change_groups }}"`);
  } else {
    tasks.push(present
      ? `    - name: Local user ${name} present (the password is set when it is created)
      ansible.windows.win_user:
        name: "{{ change_name }}"
        password: "{{ vault_user_password }}"
        update_password: on_create
        password_never_expires: false
        groups: "{{ change_groups }}"
        groups_action: add
        state: present
      no_log: true`
      : `    - name: Local user ${name} absent
      ansible.windows.win_user:
        name: "{{ change_name }}"
        state: absent`);
  }
  const vars = `    change_name: ${yq(name)}
    change_groups:${groups.length ? `\n${groups.map((g) => `      - ${yq(g)}`).join('\n')}` : ' []'}`;
  return playbook(`${present ? 'Add' : 'Remove'} ${kind} ${name} (Windows)`, 'atk_change_windows', tasks.join('\n\n') + '\n', { vars });
}

function adBook(kind: string, name: string, groups: readonly string[], ou: string, present: boolean): string {
  const path = ou ? `\n        path: "{{ change_ou }}"` : '';
  const tasks: string[] = [];
  if (kind === 'group') {
    tasks.push(`    - name: AD group ${name} ${present ? 'present' : 'absent'}
      microsoft.ad.group:
        name: "{{ change_name }}"
        scope: global
        category: security${present ? path : ''}
        state: ${present ? 'present' : 'absent'}`);
  } else if (kind === 'membership') {
    tasks.push(`    - name: ${name} ${present ? 'added to' : 'removed from'} the AD groups
      microsoft.ad.user:
        identity: "{{ change_name }}"
        groups:
          ${present ? 'add' : 'remove'}: "{{ change_groups }}"
        state: present`);
  } else {
    tasks.push(present
      ? `    - name: AD user ${name} present (the password is set when it is created)
      microsoft.ad.user:
        name: "{{ change_name }}"
        sam_account_name: "{{ change_name }}"
        password: "{{ vault_user_password }}"
        update_password: when_changed
        enabled: true${path}
        groups:
          add: "{{ change_groups }}"
        state: present
      no_log: true`
      : `    - name: AD user ${name} absent
      microsoft.ad.user:
        identity: "{{ change_name }}"
        state: absent`);
  }
  const vars = `    change_name: ${yq(name)}
    change_ou: ${yq(ou)}
    change_groups:${groups.length ? `\n${groups.map((g) => `      - ${yq(g)}`).join('\n')}` : ' []'}`;
  return playbook(`${present ? 'Add' : 'Remove'} AD ${kind} ${name}`, 'atk_change_windows', tasks.join('\n\n') + '\n', { vars, facts: false });
}

export const userGroup: ChangeUtility = {
  id: 'user-group',
  label: 'Add a user or group',
  category: 'access',
  description: 'A user, a group or a group membership: local on the servers (Linux user, group, SSH key and a sudo rule for a group; Windows local user and group), or in Active Directory through a domain controller (microsoft.ad). Passwords are ansible-vault variables, set only when the account is created.',
  platforms: ALL_PLATFORMS,
  risk: 'medium',
  reversible: true,
  rollback: 'Removes the user or group it created (a Linux home directory is kept) or the memberships it added.',
  source: 'added',
  inputs: [
    platformInput(ALL_PLATFORMS),
    { id: 'directory', label: 'Where', control: 'select', default: 'local', options: [opt('local', 'Local on the servers'), opt('ad', 'Active Directory')] },
    { id: 'kind', label: 'What', control: 'select', default: 'user', options: [opt('user', 'A user'), opt('group', 'A group'), opt('membership', 'Add a user to groups')] },
    { id: 'name', label: 'Name', control: 'text', default: 'svc-report' },
    { id: 'groups', label: 'Groups', control: 'text', default: '', hint: 'Space-separated: the groups the user joins.' },
    { ...serverInput('Servers', 'app01'), hint: 'Space-separated.', showWhen: { input: 'directory', equals: ['local'] } },
    osInput(),
    { id: 'ssh_key', label: 'SSH public key (Linux)', control: 'textarea', default: '', hint: 'The public key only.', showWhen: { input: 'os', equals: ['linux'] } },
    { id: 'sudo', label: 'Sudo for the group (Linux)', control: 'select', default: 'no', options: [opt('no', 'No'), opt('yes', 'Yes')], showWhen: { input: 'kind', equals: ['group'] } },
    { id: 'dc', label: 'Domain controller', control: 'text', default: 'dc01.corp.example.com', showWhen: { input: 'directory', equals: ['ad'] } },
    { id: 'ou', label: 'OU', control: 'text', default: '', hint: 'Distinguished name; blank for the default container.', showWhen: { input: 'directory', equals: ['ad'] } },
  ],
  build(values, ctx): UtilityResult {
    const platform = platformOf(values, userGroup);
    const findings: Finding[] = [];
    const kind = val(values, 'kind', 'user');
    const name = val(values, 'name', 'svc-report');
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) findings.push(error('change.user.name', 'A user or group name is letters, digits, ., _ and -.', { path: 'name' }));
    const groups = val(values, 'groups').split(/[\s,]+/).filter(Boolean);
    if (kind === 'membership' && !groups.length) findings.push(error('change.user.groups', 'Name the groups to add the user to.', { path: 'groups' }));
    const key = val(values, 'ssh_key');
    if (key && /PRIVATE KEY/.test(key)) findings.push(error('change.user.private-key', 'That is a private key: give the public key only.', { path: 'ssh_key' }));
    let files: Record<string, string>;
    let target: string;
    if (val(values, 'directory', 'local') === 'ad') {
      const dc = val(values, 'dc', 'dc01.corp.example.com');
      const ou = val(values, 'ou');
      files = ansibleProject([{ name: dc, windows: true }], { 'add.yml': adBook(kind, name, groups, ou, true), 'remove.yml': adBook(kind, name, groups, ou, false) }, ['microsoft.ad']);
      target = `${name} (AD)`;
    } else {
      const servers = val(values, 'server', 'app01').split(/[\s,]+/).filter(Boolean);
      const windows = servers.length > 0 && guestOs(ctx.plan, servers[0]!, values) === 'windows';
      const sudo = val(values, 'sudo', 'no') === 'yes' && !windows;
      files = ansibleProject(servers.map((s) => ({ name: s, windows })), {
        'add.yml': windows ? windowsBook(kind, name, groups, true) : linuxBook(kind, name, groups, key, sudo, true),
        'remove.yml': windows ? windowsBook(kind, name, groups, false) : linuxBook(kind, name, groups, key, sudo, false),
      }, windows ? ['ansible.windows'] : ['ansible.posix', 'community.general']);
      target = `${name} on ${servers.join(' ')}`;
    }
    if (kind === 'user') findings.push(info('change.user.vault', 'A Windows or AD user\'s first password is the ansible-vault variable vault_user_password; Linux users are created with the password locked (SSH keys, or AD logins).'));
    return {
      platform, target, route: 'ansible', summary: `Add ${kind} ${name}${groups.length ? ` (groups ${groups.join(', ')})` : ''}`, files, findings,
      apply: [{ kind: 'ansible', title: `Add ${kind} ${name}`, playbook: 'add.yml' }],
      rollback: [{ kind: 'ansible', title: `Remove ${kind} ${name}`, playbook: 'remove.yml' }],
      needs: [],
    };
  },
};

// ---------------------------------------------------------------------------
// Grant cloud access
// ---------------------------------------------------------------------------

function grantTf(platform: 'aws' | 'azure' | 'google' | 'oci', values: BlueprintValues): { main: string; vars: TfVar[] } {
  const principal = platform === 'azure' ? val(values, 'object_id') : val(values, 'principal', 'jdoe');
  const group = val(values, 'group', 'shop-operators');
  switch (platform) {
    case 'aws':
      return {
        vars: [],
        main: `resource "aws_iam_user_group_membership" "grant" {
  user   = ${q(principal)}
  groups = [${q(group)}]
}`,
      };
    case 'azure': {
      const vars: TfVar[] = [...locationVars('azure', values)];
      return {
        vars,
        main: `${locationLocals('azure')}

data "azurerm_resource_group" "scope" {
  name = local.rg
}

resource "azurerm_role_assignment" "grant" {
  scope                = data.azurerm_resource_group.scope.id
  role_definition_name = ${q(val(values, 'role', 'Reader'))}
  principal_id         = ${q(principal)}
  description          = "Granted by change utility grant-access"
}`,
      };
    }
    case 'google':
      return {
        vars: [],
        main: `resource "google_cloud_identity_group_membership" "grant" {
  group = ${q(group.startsWith('groups/') ? group : `groups/${group}`)}
  preferred_member_key {
    id = ${q(principal)}
  }
  roles {
    name = "MEMBER"
  }
}`,
      };
    default:
      return {
        vars: [{ name: 'tenancy_ocid', type: 'string', description: 'The tenancy OCID (users and groups live in the root compartment).', value: val(values, 'tenancy_ocid') }],
        main: `data "oci_identity_users" "user" {
  compartment_id = var.tenancy_ocid
  name           = ${q(principal)}
}

data "oci_identity_groups" "group" {
  compartment_id = var.tenancy_ocid
  name           = ${q(group)}
}

resource "oci_identity_user_group_membership" "grant" {
  user_id  = data.oci_identity_users.user.users[0].id
  group_id = data.oci_identity_groups.group.groups[0].id
}`,
      };
  }
}

export const grantAccess: ChangeUtility = {
  id: 'grant-access',
  label: 'Grant cloud access',
  category: 'access',
  description: 'Adds one grant, never a whole policy: an IAM user to an IAM group (AWS), a role on the landing zone\'s resource group (Azure), a member of a Google group (Google Cloud (GCP), the group holds the IAM roles), a user to an IAM group (OCI), a vCenter permission on a folder (VCF).',
  platforms: ALL_PLATFORMS,
  risk: 'high',
  reversible: true,
  rollback: 'Removes the grant (terraform destroy, or Remove-VIPermission).',
  source: 'added',
  inputs: [
    platformInput(ALL_PLATFORMS),
    { id: 'principal', label: 'Who', control: 'text', default: 'jdoe', hint: 'AWS and OCI: the IAM user name; Google Cloud: the member\'s email; VCF: DOMAIN\\name.', ...on('aws', 'google', 'oci', 'vmware') },
    { id: 'object_id', label: 'Object id', control: 'text', default: '00000000-0000-0000-0000-000000000000', hint: 'The Entra ID object id of the user, group or service principal.', ...on('azure') },
    { id: 'group', label: 'Group', control: 'text', default: 'shop-operators', hint: 'AWS and OCI: the IAM group; Google Cloud: the group id (groups/…).', ...on('aws', 'google', 'oci') },
    { id: 'role', label: 'Role', control: 'combo', default: 'Reader', options: [opt('Reader'), opt('Contributor'), opt('Virtual Machine Contributor'), opt('Virtual Machine User Login'), opt('Virtual Machine Administrator Login')], ...on('azure') },
    { id: 'network', label: 'Landing-zone network', control: 'combo', default: 'prod', hint: 'The resource group of this network is the scope.', ...on('azure') },
    { id: 'resource_group', label: 'Resource group', control: 'text', default: '', ...on('azure') },
    { id: 'tenancy_ocid', label: 'Tenancy OCID', control: 'text', default: '', ...on('oci') },
    { id: 'vcf_role', label: 'vCenter role', control: 'combo', default: 'ReadOnly', options: [opt('ReadOnly'), opt('VirtualMachineUser'), opt('VirtualMachinePowerUser'), opt('Admin')], ...on('vmware') },
    { id: 'folder', label: 'VM folder', control: 'text', default: 'shop', ...on('vmware') },
    ...VSPHERE_INPUTS,
  ],
  build(values): UtilityResult {
    const platform = platformOf(values, grantAccess);
    const findings: Finding[] = [];
    const principal = platform === 'azure' ? val(values, 'object_id') : val(values, 'principal', 'jdoe');
    if (platform === 'vmware') {
      const role = val(values, 'vcf_role', 'ReadOnly');
      const folder = val(values, 'folder', 'shop');
      if (role === 'Admin') findings.push(warning('change.grant.admin', 'The Admin role on a folder is broad: prefer a narrower role.', { path: 'vcf_role' }));
      const body = `$principal = ${psq(principal)}
$folder = Get-Folder -Server $vc -Name ${psq(folder)} -Type VM -ErrorAction Stop | Select-Object -First 1
$role = Get-VIRole -Server $vc -Name ${psq(role)} -ErrorAction Stop
$have = Get-VIPermission -Server $vc -Entity $folder -Principal $principal -ErrorAction SilentlyContinue | Where-Object { $_.Entity.Id -eq $folder.Id }
if ($Mode -eq 'apply') {
  if ($have -and $have.Role -eq $role.Name) { Write-AtkLog "$principal has $($role.Name) on the folder already" }
  else { Invoke-AtkStep "grant $principal the $($role.Name) role on $($folder.Name)" { New-VIPermission -Server $vc -Entity $folder -Principal $principal -Role $role -Propagate:$true | Out-Null } }
} else {
  if ($have) { Invoke-AtkStep "remove the permission of $principal on $($folder.Name)" { Remove-VIPermission -Permission $have -Confirm:$false } }
}`;
      return {
        platform, target: `${principal} on ${folder}`, route: 'cli', summary: `Grant ${principal} ${role} on the VM folder ${folder}`, findings,
        files: { 'scripts/grant.ps1': vcfTool('scripts/grant.ps1', 'A vCenter permission (apply) or its removal (rollback).', body) },
        apply: [{ kind: 'pwsh', title: `Grant ${principal} ${role}`, file: 'scripts/grant.ps1', args: ['apply'] }],
        rollback: [{ kind: 'pwsh', title: `Remove ${principal}'s permission`, file: 'scripts/grant.ps1', args: ['rollback'] }],
        needs: [],
      };
    }
    if (platform === 'azure' && !/^[0-9a-f-]{36}$/i.test(principal)) findings.push(error('change.grant.object-id', 'On Azure the principal is an Entra ID object id (a GUID).', { path: 'object_id' }));
    if (platform === 'azure' && /^0{8}-/.test(principal)) findings.push(warning('change.grant.sample', 'The object id is the sample: give the real one.', { path: 'object_id' }));
    if (platform === 'oci' && !val(values, 'tenancy_ocid')) findings.push(warning('change.grant.tenancy', 'Give the tenancy OCID.', { path: 'tenancy_ocid' }));
    const tf = grantTf(platform, values);
    const what = platform === 'azure' ? `${val(values, 'role', 'Reader')} on the landing zone's resource group` : `the group ${val(values, 'group', 'shop-operators')}`;
    return {
      platform, target: principal, route: 'terraform', summary: `Grant ${principal} ${what} (${PLATFORM_LABELS[platform]})`, findings,
      files: tfRoot({ platform, header: `One grant for ${principal}.`, main: tf.main, variables: tf.vars }),
      apply: [{ kind: 'terraform', title: `Grant ${principal} ${what}`, dir: 'terraform', lz: true }],
      rollback: [{ kind: 'terraform-destroy', title: `Remove the grant of ${principal}`, dir: 'terraform', lz: true }],
      needs: [],
    };
  },
};

export const ACCESS_UTILITIES: readonly ChangeUtility[] = [userGroup, grantAccess];
