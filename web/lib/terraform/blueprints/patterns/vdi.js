/**
 * `<p>_app_vdi_service` (tier pattern `vdi-service`, addendum A.4.2 VDI,
 * A.4.5): desktops as a service. The move is a rebuild (new images, FSLogix
 * profiles); the session hosts themselves are `<p>_mig_compute` rows sized by
 * `sessionHosts` (the density rule), and FSLogix is configured by the Ansible
 * play `app_fslogix`.
 *
 *   Azure   Azure Virtual Desktop: a host pool (pooled, breadth-first, or
 *           personal), its desktop application group, a workspace and their
 *           association, a scaling plan on the pool, the premium Azure Files
 *           share FSLogix profiles live on (private endpoint), and the
 *           diagnostics to the landing zone's workspace
 *   AWS     WorkSpaces: the directory registered in two subnets, then
 *           WorkSpaces Personal (one per user, persistent) or a WorkSpaces
 *           Pool (non-persistent), volumes encrypted with the landing zone key
 *   OCI     OCI Secure Desktops: a desktop pool in the app tier with its
 *           availability schedule and device policy
 *
 * Google Cloud and VCF have no first-party desktop service: session-host VMs
 * with Omnissa Horizon (on GCVE or VCF) or Citrix DaaS; no blueprint.
 */

import { info,              } from '../../../core/findings.js';
                                                                                            
import { num as numberOf, str as valueOf } from '../../../kit/blueprint.js';
                                             
import { LANDING_ZONE_SOURCE, blk, ident, lzRef, output, q, res, rname, variable, x } from '../migration/common.js';
import { NETWORK_INPUT, PATTERN_GROUP, appInputs, appOf, listOf, namePrefix, patternMainTf, preamble, securityGroupOf, subnetOf, tagsExpr } from './common.js';

                                        

function vdiInputs(platform          )                   {
  return [
    ...appInputs(),
    NETWORK_INPUT,
    { id: 'persistent', label: 'Desktops', control: 'select', default: 'no', options: [{ value: 'no', label: 'Non-persistent (pooled)' }, { value: 'yes', label: 'Persistent (one per user)' }] },
    { id: 'users', label: 'Users', control: 'number', default: 200, min: 1, hint: 'Named users.' },
    { id: 'concurrent', label: 'Concurrent sessions', control: 'number', default: 120, min: 1 },
    ...(platform === 'azure'
      ? [
          { id: 'max_sessions', label: 'Sessions per host', control: 'number'         , default: 16, min: 1, max: 999, hint: 'From the density rule (users per vCPU × host vCPU).' },
          { id: 'profile_gib', label: 'FSLogix profile share (GiB)', control: 'number'         , default: 2048, min: 100 },
          { id: 'time_zone', label: 'Scaling plan time zone', control: 'text'         , default: 'GMT Standard Time', hint: 'A Windows time zone name.' },
        ]
      : platform === 'aws'
        ? [
            { id: 'directory_id', label: 'Directory (AD Connector or Managed AD) id', control: 'text'         , default: '', hint: 'The identity item\'s directory, or an AD Connector to the domain; blank: a variable.' },
            { id: 'bundle_id', label: 'Bundle id', control: 'text'         , default: '', hint: 'The WorkSpaces bundle (a Windows Server 2022 or Windows 11 BYOL bundle); blank: a variable.' },
            { id: 'user_names', label: 'Users (persistent)', control: 'text'         , default: '', hint: 'Directory user names, space-separated: one WorkSpace each.' },
            { id: 'compute', label: 'Compute type', control: 'select'         , default: 'STANDARD', options: ['VALUE', 'STANDARD', 'PERFORMANCE', 'POWER', 'POWERPRO'].map((v) => ({ value: v, label: v })) },
          ]
        : [
            { id: 'image_id', label: 'Desktop image OCID', control: 'text'         , default: '', hint: 'A custom image prepared for Secure Desktops; blank: a variable.' },
            { id: 'image_name', label: 'Desktop image name', control: 'text'         , default: 'win11-desktop' },
            { id: 'shape', label: 'Shape', control: 'text'         , default: 'Flex Low' },
            { id: 'backup_policy_id', label: 'Storage backup policy OCID', control: 'text'         , default: '', hint: 'Blank: a variable (the Bronze / Silver / Gold policy of the region).' },
            { id: 'contact', label: 'Contact', control: 'text'         , default: 'desktops@example.com' },
          ]),
    LANDING_ZONE_SOURCE,
  ];
}

const persistentOf = (values                 )          => valueOf(values, 'persistent', 'no') === 'yes';

function azureVdi(values                 , findings           )             {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const net = rname(valueOf(values, 'network', 'prod'));
  const tags = x(tagsExpr(app, 'azure'));
  const rg = `${lz}.resource_group[${q(net)}]`;
  const personal = persistentOf(values);
  const account = `substr(replace(lower("${pfx}prof"), "/[^a-z0-9]/", ""), 0, 24)`;
  const schedule = (name        , days                   ) =>
    blk('schedule', {
      name,
      days_of_week: [...days],
      ramp_up_start_time: '07:00',
      ramp_up_load_balancing_algorithm: 'BreadthFirst',
      ramp_up_minimum_hosts_percent: 20,
      ramp_up_capacity_threshold_percent: 60,
      peak_start_time: '09:00',
      peak_load_balancing_algorithm: 'BreadthFirst',
      ramp_down_start_time: '18:00',
      ramp_down_load_balancing_algorithm: 'DepthFirst',
      ramp_down_minimum_hosts_percent: 10,
      ramp_down_force_logoff_users: false,
      ramp_down_wait_time_minutes: 45,
      ramp_down_notification_message: 'Please save your work: this session host is being scaled in within 45 minutes.',
      ramp_down_capacity_threshold_percent: 90,
      ramp_down_stop_hosts_when: 'ZeroActiveSessions',
      off_peak_start_time: '20:00',
      off_peak_load_balancing_algorithm: 'DepthFirst',
    });
  const blocks             = [
    ...preamble('azure', values),
    res('azurerm_virtual_desktop_host_pool', 'app', {
      name: x(`"${pfx}-hp"`),
      resource_group_name: x(rg),
      location: x(`${lz}.location`),
      type: personal ? 'Personal' : 'Pooled',
      load_balancer_type: personal ? 'Persistent' : 'BreadthFirst',
      personal_desktop_assignment_type: personal ? 'Automatic' : undefined,
      maximum_sessions_allowed: personal ? undefined : numberOf(values, 'max_sessions', 16),
      preferred_app_group_type: 'Desktop',
      start_vm_on_connect: true,
      validate_environment: false,
      public_network_access: 'Enabled',
      custom_rdp_properties: 'audiocapturemode:i:1;audiomode:i:0;drivestoredirect:s:;redirectclipboard:i:1;redirectprinters:i:1;enablerdsaadauth:i:1;',
      tags,
    }, [blk('scheduled_agent_updates', { enabled: true, use_session_host_timezone: true }, [blk('schedule', { day_of_week: 'Saturday', hour_of_day: 2 })])]),
    res('azurerm_virtual_desktop_application_group', 'desktop', {
      name: x(`"${pfx}-dag"`),
      resource_group_name: x(rg),
      location: x(`${lz}.location`),
      type: 'Desktop',
      host_pool_id: x('azurerm_virtual_desktop_host_pool.app.id'),
      default_desktop_display_name: app.name,
      tags,
    }),
    res('azurerm_virtual_desktop_workspace', 'app', { name: x(`"${pfx}-ws"`), resource_group_name: x(rg), location: x(`${lz}.location`), friendly_name: app.name, tags }),
    res('azurerm_virtual_desktop_workspace_application_group_association', 'app', { workspace_id: x('azurerm_virtual_desktop_workspace.app.id'), application_group_id: x('azurerm_virtual_desktop_application_group.desktop.id') }),
  ];
  if (!personal) {
    blocks.push(
      res('azurerm_virtual_desktop_scaling_plan', 'app', {
        name: x(`"${pfx}-scaling"`),
        resource_group_name: x(rg),
        location: x(`${lz}.location`),
        time_zone: valueOf(values, 'time_zone', 'GMT Standard Time'),
        friendly_name: `${app.name} scaling`,
        tags,
      }, [
        schedule('weekdays', ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']),
        blk('host_pool', { hostpool_id: x('azurerm_virtual_desktop_host_pool.app.id'), scaling_plan_enabled: true }),
      ]),
    );
    findings.push(info('tf.app.avd-scaling-role', 'The scaling plan acts through the Azure Virtual Desktop service principal: assign it "Desktop Virtualization Power On Off Contributor" on the subscription (a one-time tenant step).', { source: 'https://learn.microsoft.com/en-us/azure/virtual-desktop/service-principal-assign-roles' }));
  }
  // FSLogix profile containers on premium Azure Files, reached privately.
  blocks.push(
    res('azurerm_storage_account', 'profiles', {
      name: x(account),
      resource_group_name: x(rg),
      location: x(`${lz}.location`),
      account_kind: 'FileStorage',
      account_tier: 'Premium',
      account_replication_type: 'ZRS',
      min_tls_version: 'TLS1_2',
      public_network_access: 'Disabled',
      allow_nested_items_to_be_public: false,
      tags,
    }, [blk('share_properties', {}, [blk('smb', { versions: ['SMB3.1.1'], authentication_types: ['Kerberos'], channel_encryption_type: ['AES-256-GCM'] })])]),
    res('azurerm_storage_share', 'profiles', { name: 'profiles', storage_account_id: x('azurerm_storage_account.profiles.id'), quota: numberOf(values, 'profile_gib', 2048), enabled_protocol: 'SMB', access_tier: 'Premium' }),
    res('azurerm_private_endpoint', 'profiles', {
      name: x(`"${pfx}-prof-pe"`),
      resource_group_name: x(rg),
      location: x(`${lz}.location`),
      subnet_id: x(subnetOf(lz, net, 'app')),
      tags,
    }, [blk('private_service_connection', { name: 'file', private_connection_resource_id: x('azurerm_storage_account.profiles.id'), subresource_names: ['file'], is_manual_connection: false })]),
    res('azurerm_monitor_diagnostic_setting', 'host_pool', {
      name: 'landing-zone',
      target_resource_id: x('azurerm_virtual_desktop_host_pool.app.id'),
      log_analytics_workspace_id: x(`${lz}.log_destination`),
    }, [blk('enabled_log', { category_group: 'allLogs' })]),
    output('host_pool_id', 'azurerm_virtual_desktop_host_pool.app.id', 'Session hosts join with a registration token from this pool (the execution kit asks for it at run time).'),
    output('fslogix_path', '"\\\\\\\\${azurerm_storage_account.profiles.name}.file.core.windows.net\\\\profiles"', 'The VHDLocations value app_fslogix writes.'),
  );
  findings.push(info('tf.app.avd-sessionhosts', 'The session hosts are compute rows (sized by the density rule); the storage account is joined to AD DS for Kerberos with AzFilesHybrid, a runbook step.', { source: 'https://learn.microsoft.com/en-us/azure/virtual-desktop/fslogix-profile-container-configure-azure-files-active-directory' }));
  return blocks;
}

function awsVdi(values                 , findings           )             {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const net = rname(valueOf(values, 'network', 'prod'));
  const tags = x(tagsExpr(app, 'aws'));
  const personal = persistentOf(values);
  const blocks             = [...preamble('aws', values)];
  const dir = valueOf(values, 'directory_id');
  if (!dir) blocks.push(variable(`${app.id}_workspaces_directory_id`, 'string', 'The directory WorkSpaces registers (AWS Managed Microsoft AD or an AD Connector).'));
  const bundle = valueOf(values, 'bundle_id');
  if (!bundle) blocks.push(variable(`${app.id}_workspaces_bundle_id`, 'string', 'The WorkSpaces bundle id the desktops are created from.'));
  const dirRef = dir ? q(dir) : `var.${app.id}_workspaces_directory_id`;
  const bundleRef = bundle ? q(bundle) : `var.${app.id}_workspaces_bundle_id`;
  blocks.push(
    res('aws_workspaces_directory', 'app', {
      directory_id: x(dirRef),
      subnet_ids: x(`slice(${lz}.zone_subnet_ids[${q(net)}], 0, 2)`),
      workspace_type: 'PERSONAL',
      tags,
    }, [
      blk('self_service_permissions', { change_compute_type: false, increase_volume_size: false, rebuild_workspace: true, restart_workspace: true, switch_running_mode: false }),
      blk('workspace_access_properties', { device_type_windows: 'ALLOW', device_type_osx: 'ALLOW', device_type_web: 'ALLOW', device_type_ios: 'ALLOW', device_type_android: 'ALLOW', device_type_linux: 'ALLOW', device_type_zeroclient: 'DENY', device_type_chromeos: 'ALLOW' }),
      blk('workspace_creation_properties', { custom_security_group_id: x(securityGroupOf(lz, net, 'app')), enable_internet_access: false, enable_maintenance_mode: true, user_enabled_as_local_administrator: false }),
    ]),
  );
  if (personal) {
    const users = listOf(values, 'user_names');
    if (users.length === 0) findings.push(info('tf.app.workspaces-no-users', 'No user names yet: the directory is registered and WorkSpaces are added per user later (user_names).', { path: 'user_names' }));
    for (const u of users) {
      blocks.push(
        res('aws_workspaces_workspace', ident('ws', u), {
          directory_id: x('aws_workspaces_directory.app.id'),
          bundle_id: x(bundleRef),
          user_name: u,
          root_volume_encryption_enabled: true,
          user_volume_encryption_enabled: true,
          volume_encryption_key: x(`${lz}.kms_key_id == null ? "alias/aws/workspaces" : ${lz}.kms_key_id`),
          tags,
        }, [blk('workspace_properties', { compute_type_name: valueOf(values, 'compute', 'STANDARD'), running_mode: 'AUTO_STOP', running_mode_auto_stop_timeout_in_minutes: 60, root_volume_size_gib: 80, user_volume_size_gib: 50 })]),
      );
    }
  } else {
    blocks.push(
      res('aws_workspaces_pool', 'app', {
        pool_name: x(`"${pfx}-pool"`),
        description: `${app.name} non-persistent desktops`,
        bundle_id: x(bundleRef),
        directory_id: x('aws_workspaces_directory.app.id'),
        running_mode: 'AUTO_STOP',
        tags,
      }, [blk('capacity', { desired_user_sessions: numberOf(values, 'concurrent', 120) })]),
    );
    findings.push(info('tf.app.workspaces-pools-directory', 'WorkSpaces Pools use a POOLS directory with SAML 2.0 sign-in (and the AD config for domain join): register the directory for Pools as the service documents; the PERSONAL directory here is the default (verify before applying).', { source: 'https://docs.aws.amazon.com/workspaces/latest/adminguide/managing-wsp-pools.html' }));
  }
  blocks.push(output('directory_registration', 'aws_workspaces_directory.app.registration_code'));
  return blocks;
}

function ociVdi(values                 , findings           )             {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const net = rname(valueOf(values, 'network', 'prod'));
  const tags = x(tagsExpr(app, 'oci'));
  const blocks             = [...preamble('oci', values)];
  const image = valueOf(values, 'image_id');
  if (!image) blocks.push(variable(`${app.id}_desktop_image_id`, 'string', 'The OCID of the desktop image prepared for OCI Secure Desktops.'));
  const policy = valueOf(values, 'backup_policy_id');
  if (!policy) blocks.push(variable(`${app.id}_desktop_backup_policy_id`, 'string', 'The OCID of the block volume backup policy for the desktops\' storage.'));
  const concurrent = numberOf(values, 'concurrent', 120);
  blocks.push(
    res('oci_desktops_desktop_pool', 'app', {
      compartment_id: x(`${lz}.compartment_id`),
      availability_domain: x(`${lz}.zones[0]`),
      display_name: x(`"${pfx}-desktops"`),
      contact_details: valueOf(values, 'contact', 'desktops@example.com'),
      shape_name: valueOf(values, 'shape', 'Flex Low'),
      maximum_size: numberOf(values, 'users', 200),
      standby_size: Math.max(1, Math.ceil(concurrent * 0.1)),
      are_privileged_users: false,
      is_storage_enabled: persistentOf(values),
      storage_size_in_gbs: 50,
      storage_backup_policy_id: x(policy ? q(policy) : `var.${app.id}_desktop_backup_policy_id`),
      are_volumes_preserved: persistentOf(values),
      nsg_ids: x(`[${securityGroupOf(lz, net, 'app')}]`),
      freeform_tags: tags,
    }, [
      blk('availability_policy', {}, [blk('start_schedule', { cron_expression: '0 0 7 ? * MON-FRI', timezone: 'UTC' }), blk('stop_schedule', { cron_expression: '0 0 20 ? * MON-FRI', timezone: 'UTC' })]),
      blk('device_policy', { audio_mode: 'TODESKTOP', cdm_mode: 'NONE', clipboard_mode: 'FROMDESKTOP', is_display_enabled: true, is_keyboard_enabled: true, is_pointer_enabled: true, is_printing_enabled: true }),
      blk('image', { image_id: x(image ? q(image) : `var.${app.id}_desktop_image_id`), image_name: valueOf(values, 'image_name', 'win11-desktop') }),
      blk('network_configuration', { subnet_id: x(subnetOf(lz, net, 'app')), vcn_id: x(`${lz}.network_ids[${q(net)}]`) }),
    ]),
    output('desktop_pool_id', 'oci_desktops_desktop_pool.app.id'),
  );
  findings.push(info('tf.app.oci-desktops-values', 'The device-policy modes (audio, clipboard, drive mapping) and the availability cron format are from the OCI Secure Desktops API: check them against the tenancy\'s console before applying.', { source: 'https://docs.oracle.com/en-us/iaas/secure-desktops/home.htm' }));
  return blocks;
}

const EMITS                                                = {
  azure: [
    'azurerm_virtual_desktop_host_pool', 'azurerm_virtual_desktop_application_group', 'azurerm_virtual_desktop_workspace', 'azurerm_virtual_desktop_workspace_application_group_association',
    'azurerm_virtual_desktop_scaling_plan', 'azurerm_storage_account', 'azurerm_storage_share', 'azurerm_private_endpoint', 'azurerm_monitor_diagnostic_setting',
  ],
  aws: ['aws_workspaces_directory', 'aws_workspaces_workspace', 'aws_workspaces_pool'],
  oci: ['oci_desktops_desktop_pool'],
};
const SERVICE                                     = { azure: 'Azure Virtual Desktop', aws: 'Amazon WorkSpaces', oci: 'OCI Secure Desktops' };

function vdi(platform          )            {
  return {
    id: `${platform}_app_vdi_service`,
    label: `App desktops on ${SERVICE[platform]}`,
    group: PATTERN_GROUP,
    description: {
      azure: 'An AVD host pool (pooled breadth-first, or personal), its desktop application group, a workspace, a weekday scaling plan, the premium Azure Files share for FSLogix profiles behind a private endpoint, and diagnostics to the landing zone.',
      aws: 'The directory registered with WorkSpaces in two subnets of the app tier (no internet access, no local admin), then a WorkSpace per user (persistent) or a WorkSpaces Pool (non-persistent), volumes encrypted.',
      oci: 'An OCI Secure Desktops pool in the app tier with a weekday availability schedule, a device policy and optional persistent storage.',
    }[platform],
    inputs: vdiInputs(platform),
    emits: EMITS[platform],
    build: (values                 ) => {
      const findings            = [];
      const blocks = platform === 'azure' ? azureVdi(values, findings) : platform === 'aws' ? awsVdi(values, findings) : ociVdi(values, findings);
      return { files: { 'main.tf': patternMainTf(blocks, `${SERVICE[platform]}: ${appOf(values).name}`) }, findings };
    },
  };
}

export const VDI_BLUEPRINTS                       = (['azure', 'aws', 'oci']         ).map(vdi);
