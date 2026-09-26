/**
 * VCF Operations setup and operations: the build-out.
 *
 * Every blueprint in this area builds from its defaults and from each select
 * option and toggle flipped, writes JSON that parses and bash that bash will
 * read, and keeps the house rules: VCF 9.1 names only, nothing retired, no
 * footprint, no credential in a file, and an apply script rather than a note
 * to type things in. Then the findings each one exists to raise.
 */

import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { expect } from '../testing/expect.ts';
import { defaultValues, type BlueprintValues } from '../kit/blueprint.ts';
import { hasErrors } from '../core/findings.ts';
import { VCF_OPERATIONS_SETUP } from './blueprints/vcf-operations-setup.ts';
import { VCF_OPERATIONS_AUTOMATIONS } from './blueprints/vcf-operations.ts';
import { rowsOf, kindOf, isIpv6, bareIpv6InUrl } from './blueprints/vcf-ops-setup-lib.ts';

const MINE = [...VCF_OPERATIONS_SETUP, ...VCF_OPERATIONS_AUTOMATIONS];
const automationFor = (id: string) => MINE.find((blueprint) => blueprint.id === id);

function variants(id: string): { label: string; values: BlueprintValues }[] {
  const blueprint = automationFor(id);
  if (!blueprint) throw new Error(`missing ${id}`);
  const base = defaultValues(blueprint);
  const out: { label: string; values: BlueprintValues }[] = [{ label: 'defaults', values: { ...base } }];
  for (const input of blueprint.inputs) {
    if (input.control === 'select') for (const option of input.options ?? []) out.push({ label: `${input.id}=${option.value}`, values: { ...base, [input.id]: option.value } });
    if (input.control === 'toggle') out.push({ label: `${input.id}=${String(!base[input.id])}`, values: { ...base, [input.id]: !base[input.id] } });
  }
  return out;
}

function build(id: string, overrides: BlueprintValues = {}) {
  const blueprint = automationFor(id);
  if (!blueprint) throw new Error(`missing ${id}`);
  return blueprint.build({ ...defaultValues(blueprint), ...overrides }, id);
}
const codes = (id: string, overrides: BlueprintValues = {}) => (build(id, overrides).findings ?? []).map((finding) => finding.code);
const text = (id: string, overrides: BlueprintValues = {}) => Object.values(build(id, overrides).files).join('\n');

const bash = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0;

describe('ops setup build-out: every blueprint, every option', () => {
  it('has the blueprints this area owns', () => {
    for (const id of ['vcfops_adapter_instance', 'vcfops_outbound_plugin', 'vcfops_access', 'vcfops_custom_properties', 'vcfops_global_settings', 'vcfops_notify_webhook', 'vcfops_scope_group', 'vcfops_reclaim_schedule', 'vcfops_maintenance_window', 'vcfops_capacity_report', 'vcfops_policy_toggle', 'vcfops_policy_editor']) {
      expect(MINE.some((blueprint) => blueprint.id === id)).toBe(true);
      expect(automationFor(id)?.platform).toBe('vcf-operations');
    }
  });

  it('builds clean from defaults, and every variant builds with its contract', () => {
    const problems: string[] = [];
    for (const blueprint of MINE) {
      if (hasErrors(build(blueprint.id).findings ?? [])) problems.push(`${blueprint.id}: errors at defaults: ${(build(blueprint.id).findings ?? []).filter((f) => f.severity === 'error').map((f) => f.code).join(', ')}`);
      for (const variant of variants(blueprint.id)) {
        try {
          const automation = blueprint.automation(variant.values, blueprint.id);
          if (!automation.trigger.detail || !automation.scope.what || automation.undo.length === 0 || automation.told.length === 0) problems.push(`${blueprint.id} ${variant.label}: contract`);
          if (automation.effect !== 'read' && (automation.guardrails.length === 0 || automation.dryRun.length === 0)) problems.push(`${blueprint.id} ${variant.label}: no guardrail or dry run`);
          const files = blueprint.build(variant.values, blueprint.id).files;
          if (!files['IMPORT.md']?.startsWith('# Importing: ')) problems.push(`${blueprint.id} ${variant.label}: IMPORT.md`);
          for (const [path, body] of Object.entries(files)) {
            if (path.endsWith('.json')) {
              try {
                JSON.parse(body);
              } catch (failure) {
                problems.push(`${blueprint.id} ${variant.label}: ${path}: ${String(failure)}`);
              }
            }
            if (path.endsWith('.sh') && !body.startsWith('#!/usr/bin/env bash')) problems.push(`${blueprint.id} ${variant.label}: ${path} shebang`);
          }
        } catch (failure) {
          problems.push(`${blueprint.id} ${variant.label}: threw ${String(failure)}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('writes bash that bash parses', { skip: !bash }, () => {
    const problems: string[] = [];
    for (const blueprint of MINE) {
      for (const variant of variants(blueprint.id)) {
        for (const [path, body] of Object.entries(blueprint.build(variant.values, blueprint.id).files)) {
          if (!path.endsWith('.sh')) continue;
          const result = spawnSync('bash', ['-n'], { input: body, encoding: 'utf8' });
          if (result.status !== 0) problems.push(`${blueprint.id} ${variant.label} ${path}: ${result.stderr.trim().slice(0, 200)}`);
        }
      }
    }
    expect([...new Set(problems)]).toEqual([]);
  });

  it('keeps the house rules in every file: 9.1 names, nothing retired, no footprint', () => {
    const problems: string[] = [];
    for (const blueprint of MINE) {
      const labels = [blueprint.label, blueprint.description, ...blueprint.inputs.flatMap((input) => [input.label, input.hint ?? '', ...(input.options ?? []).map((option) => option.label)])].join('\n');
      if (/\bESXi\b|\bAria\b|vRealize|vROps|Service Broker/.test(labels)) problems.push(`${blueprint.id}: old name in the form`);
      for (const variant of variants(blueprint.id)) {
        for (const [path, body] of Object.entries(blueprint.build(variant.values, blueprint.id).files)) {
          // The shared README names the platform's 8.x names on purpose (renderReadme).
          if (path === 'README.md') continue;
          if (/archtoolkit|generated by/i.test(body)) problems.push(`${blueprint.id} ${variant.label} ${path}: footprint`);
          if (/\bESXi\b|vRealize|vROps|Service Broker/.test(body)) problems.push(`${blueprint.id} ${variant.label} ${path}: old name`);
          if (/SyslogPlugin/.test(body)) problems.push(`${blueprint.id} ${variant.label} ${path}: retired Syslog plugin`);
        }
      }
    }
    expect([...new Set(problems)]).toEqual([]);
  });
});

describe('ops setup build-out: the lib', () => {
  it('reads " | " rows, keeping metric keys that have a pipe in them', () => {
    expect(rowsOf('a | cpu|readyPct | on\n# comment\n\nb | c')).toEqual([['a', 'cpu|readyPct', 'on'], ['b', 'c']]);
    expect(kindOf('HostSystem')).toEqual({ adapterKind: 'VMWARE', resourceKind: 'HostSystem' });
    expect(kindOf('NSXTAdapter/TransportNode')).toEqual({ adapterKind: 'NSXTAdapter', resourceKind: 'TransportNode' });
    expect(isIpv6('2001:db8::10')).toBe(true);
    expect(isIpv6('vc01.example.com')).toBe(false);
    expect(bareIpv6InUrl('https://2001:db8::10/hook')).toBe(true);
    expect(bareIpv6InUrl('https://[2001:db8::10]:443/hook')).toBe(false);
  });
});

describe('vcfops_outbound_plugin: the six 9.1 plugins', () => {
  it('offers Slack, Service-Now and Log File, and not Syslog', () => {
    const kinds = (automationFor('vcfops_outbound_plugin')?.inputs.find((input) => input.id === 'kind')?.options ?? []).map((option) => option.value);
    expect(kinds).toEqual(['StandardEmailPlugin', 'WebhookPlugin', 'SlackPlugin', 'ServiceNowPlugin', 'SNMPTrapPlugin', 'LogFilePlugin']);
    expect(codes('vcfops_outbound_plugin', { kind: 'SyslogPlugin' })).toContain('vcfops.outbound.syslog-retired');
  });

  it('reads every secret from the environment and enables what it creates', () => {
    const email = text('vcfops_outbound_plugin');
    expect(email).toContain('env.SMTP_PASSWORD');
    expect(email).toContain('alertplugins/${ID}/enable/true');
    expect(email).toContain('"name": "SECURE_CONNECTION_TYPE"');
    expect(text('vcfops_outbound_plugin', { kind: 'SlackPlugin' })).toContain('env.SLACK_WEBHOOK_URL');
    expect(text('vcfops_outbound_plugin', { kind: 'ServiceNowPlugin', proxy: true, proxy_user: 'svc-proxy' })).toContain('env.PROXY_PASSWORD');
    expect(text('vcfops_outbound_plugin', { kind: 'WebhookPlugin', webhook_auth: 'OAUTH2' })).toContain('env.WEBHOOK_CLIENT_SECRET');
    expect(text('vcfops_outbound_plugin', { kind: 'WebhookPlugin', webhook_auth: 'CERTIFICATE' })).toContain('--rawfile v "${WEBHOOK_CLIENT_CERT_FILE:-/dev/null}"');
    const v3 = text('vcfops_outbound_plugin', { kind: 'SNMPTrapPlugin' });
    expect(v3).toContain('env.SNMP_AUTH_PASSWORD');
    expect(v3).toContain('env.SNMP_PRIV_PASSWORD');
    expect(text('vcfops_outbound_plugin', { kind: 'LogFilePlugin' })).toContain('alertOutputFolder');
  });

  it('checks the plugin type and its fields on the instance before sending', () => {
    expect(text('vcfops_outbound_plugin', { kind: 'SlackPlugin' })).toContain('api GET alertplugins/types');
  });

  it('flags cleartext, a literal secret header, a secret in the URL, weak SNMP and a bare IPv6 URL', () => {
    expect(codes('vcfops_outbound_plugin', { email_security: 'NONE' })).toContain('vcfops.outbound.cleartext-login');
    expect(codes('vcfops_outbound_plugin', { kind: 'WebhookPlugin', headers: 'Authorization | Bearer abc' })).toContain('vcfops.outbound.header-secret');
    expect(codes('vcfops_outbound_plugin', { kind: 'WebhookPlugin', headers: 'Authorization | env:HOOK_AUTH' })).not.toContain('vcfops.outbound.header-secret');
    expect(text('vcfops_outbound_plugin', { kind: 'WebhookPlugin', headers: 'Authorization | env:HOOK_AUTH' })).toContain('HOOK_AUTH');
    expect(codes('vcfops_outbound_plugin', { kind: 'WebhookPlugin', webhook_url: 'https://h.example.com/x?token=1' })).toContain('vcfops.outbound.secret-in-url');
    expect(codes('vcfops_outbound_plugin', { kind: 'WebhookPlugin', webhook_url: 'https://2001:db8::10/x' })).toContain('vcfops.outbound.ipv6-url');
    expect(codes('vcfops_outbound_plugin', { kind: 'SNMPTrapPlugin', snmp_auth: 'MD5' })).toContain('vcfops.outbound.snmp-weak');
    expect(codes('vcfops_outbound_plugin', { kind: 'SNMPTrapPlugin', snmp_version: 'v2c' })).toContain('vcfops.outbound.cleartext');
    expect(codes('vcfops_outbound_plugin', { kind: 'WebhookPlugin', webhook_auth: 'NONE' })).toContain('vcfops.outbound.no-auth');
  });
});

describe('vcfops_notify_webhook: a notification rule for any instance', () => {
  it('looks the instance up by name and updates a rule of the same name', () => {
    const all = text('vcfops_notify_webhook');
    expect(all).toContain('plugin_id ');
    expect(all).toContain('send PUT notifications/rules');
    expect(all).toContain('send POST notifications/rules');
  });

  it('writes the channel settings and filters', () => {
    const email = JSON.parse(build('vcfops_notify_webhook', { channel: 'StandardEmailPlugin', resend_minutes: 60 }).files['vcfops-notify-webhook.json']!);
    expect(email.properties.map((p: { name: string }) => p.name)).toEqual(['emailaddr', 'resendAlert', 'maxNotify', 'delayAlert']);
    const filtered = JSON.parse(build('vcfops_notify_webhook', { alert_type: 'Storage', alert_subtype: 'Capacity', impact: 'RISK', scope: 'group', control_state: 'OPEN,ASSIGNED', tag_filter: 'Environment | Production' }).files['vcfops-notify-webhook.json']!);
    expect(filtered.alertTypeFilters).toEqual([{ type: 'Storage', subTypes: ['Capacity'] }]);
    expect(filtered.alertImpacts).toEqual(['RISK']);
    expect(filtered.resourceFilter.relation).toEqual(['SELF', 'CHILD']);
    expect(filtered.alertControlStates).toEqual(['OPEN', 'ASSIGNED']);
    expect(filtered.resourceTagFilters).toEqual([{ category: 'Environment', value: 'Production' }]);
    expect(text('vcfops_notify_webhook', { scope: 'group' })).toContain('group_id ');
  });

  it('keeps the secret-in-URL check and adds the email ones', () => {
    expect(codes('vcfops_notify_webhook', { endpoint: 'https://hooks.example.com/x?token=abc123' })).toContain('vcfops.rule.secret-in-url');
    expect(codes('vcfops_notify_webhook', { channel: 'StandardEmailPlugin', recipients: '' })).toContain('vcfops.rule.no-recipient');
    expect(codes('vcfops_notify_webhook', { channel: 'StandardEmailPlugin', resend_minutes: 5 })).toContain('vcfops.rule.resend');
    expect(codes('vcfops_notify_webhook', { channel: 'StandardEmailPlugin', resend_minutes: 60, max_notifications: 0 })).toContain('vcfops.rule.unbounded');
    expect(codes('vcfops_notify_webhook', { scope: 'tag', scope_value: 'nocolon' })).toContain('vcfops.rule.tag-form');
    expect(codes('vcfops_notify_webhook', { criticality: '', resource_kinds: '' })).toContain('vcfops.rule.catch-all');
  });
});

describe('vcfops_adapter_instance: an account of any kind', () => {
  it('offers the 9.1 account kinds and checks them on the instance', () => {
    const kinds = (automationFor('vcfops_adapter_instance')?.inputs.find((input) => input.id === 'kind')?.options ?? []).map((option) => option.value);
    expect(kinds).toEqual(['vcenter', 'vcf', 'nsx', 'vcfa', 'networks', 'hcx', 'kubernetes', 'live_recovery', 'snmp']);
    const all = text('vcfops_adapter_instance', { kind: 'nsx' });
    expect(all).toContain('adapterkinds/${AK}/credentialkinds');
    expect(all).toContain('collector_group_id ');
    expect(all).toContain('monitoringstate/start');
    expect(all).toContain('send PATCH adapters');
    expect(all).toContain('env.NSX_PASSWORD');
  });

  it('takes Kubernetes and SNMP credentials in their own shapes', () => {
    expect(text('vcfops_adapter_instance', { kind: 'kubernetes', k8s_auth: 'kubeconfig' })).toContain('K8S_KUBECONFIG_FILE');
    expect(text('vcfops_adapter_instance', { kind: 'snmp' })).toContain('env.SNMP_PRIV_PASSWORD');
    expect(codes('vcfops_adapter_instance', { kind: 'snmp', snmp_version: 'v2c' })).toContain('vcfops.adapter.snmp-v2c');
  });

  it('still refuses an administrator account, and notices a single NSX node', () => {
    expect(codes('vcfops_adapter_instance', { account: 'administrator@vsphere.local' })).toContain('vcfops.adapter.admin-account');
    expect(codes('vcfops_adapter_instance', { kind: 'nsx', nsx_vip: false })).toContain('vcfops.adapter.nsx-node');
    // Advice (info) is not shown on the page, so read it from the automation itself.
    const bp = automationFor('vcfops_adapter_instance')!;
    expect((bp.automation({ ...defaultValues(bp), vcenter: '2001:db8::20' }, 'x').findings ?? []).map((f) => f.code)).toContain('vcfops.adapter.ipv6');
  });
});

describe('vcfops_access: roles, users and scope', () => {
  it('builds a custom role from permission names and scopes by name', () => {
    const files = build('vcfops_access', { role: 'custom' }).files;
    expect(files['permissions.txt']).toContain('Dashboards');
    expect(Object.values(files).join('\n')).toContain('api GET auth/privileges');
    expect(Object.values(files).join('\n')).toContain('auth_source_id ');
    expect(Object.values(files).join('\n')).toContain('group_id ');
  });

  it('takes a local user password from the environment only', () => {
    const all = text('vcfops_access', { principal: 'user' });
    expect(all).toContain('env.LOCAL_USER_PASSWORD');
    expect(all).toContain('send POST auth/users');
    expect(codes('vcfops_access', { principal: 'user' })).toContain('vcfops.access.local-user');
  });

  it('warns on an unscoped admin role and a grant to a person', () => {
    expect(codes('vcfops_access', { role: 'Administrator', scope_kind: 'all' })).toContain('vcfops.access.unscoped');
    expect(codes('vcfops_access', { group: 'jane.doe@example.com' })).toContain('vcfops.access.person');
    expect(text('vcfops_access', { scope_kind: 'objects' })).toContain('resource_id ');
  });
});

describe('vcfops_scope_group: the criteria builder', () => {
  it('writes criteria sets, tag and relationship rules and static members', () => {
    const files = build('vcfops_scope_group', {
      group_type: 'custom',
      criteria: '1 | - | metric | cpu|usage_average | GT | 10\n2 | VMWARE/HostSystem | relationship | descendant | EQ | Cluster-A\n2 | VMWARE/HostSystem | tag | Environment | EQ | Production',
      include_objects: 'VMWARE/VirtualMachine | jump-01',
      exclude_objects: 'VMWARE/VirtualMachine | dc-01',
    }).files;
    const body = JSON.parse(files['vcfops-scope-group.json']!);
    expect(body.resourceKey.resourceKindKey).toBe('Automation scope');
    expect(body.membershipDefinition.rules.length).toBe(2);
    expect(body.membershipDefinition.rules[0].statConditionRules).toEqual([{ key: 'cpu|usage_average', doubleValue: 10, compareOperator: 'GT' }]);
    expect(body.membershipDefinition.rules[1].resourceKindKey).toEqual({ resourceKind: 'HostSystem', adapterKind: 'VMWARE' });
    expect(body.membershipDefinition.rules[1].relationshipConditionRules).toEqual([{ relation: 'DESCENDANT', name: 'Cluster-A', compareOperator: 'EQ' }]);
    expect(body.membershipDefinition.rules[1].resourceTagConditionRules).toEqual([{ category: 'Environment', stringValue: 'Production', compareOperator: 'EQ' }]);
    const exported = JSON.parse(files['import/custom-group.json']!);
    expect(exported.customGroups[0].membershipDefinition.ruleGroups.length).toBe(2);
    const script = files['apply.sh']!;
    expect(script).toContain('send POST resources/groups/types');
    expect(script).toContain("resource_id 'jump-01'");
    expect(script).toContain("resource_id 'dc-01'");
    expect(script).toContain('policy_id ');
  });

  it('says ESX, not ESXi, and offers the object kinds beyond vSphere', () => {
    const options = automationFor('vcfops_scope_group')?.inputs.find((input) => input.id === 'object_kind')?.options ?? [];
    expect(options.some((option) => option.label === 'ESX hosts')).toBe(true);
    for (const value of ['VMWARE/StoragePod', 'VMWARE/DistributedVirtualPortgroup', 'VirtualAndPhysicalSANAdapter/VirtualSANDCCluster', 'NSXTAdapter/LogicalSwitch', 'VMWARE/Namespace', 'VcfAdapter/VCFSystem']) {
      expect(options.some((option) => option.value === value)).toBe(true);
    }
  });

  it('catches a bad criterion and a frozen membership', () => {
    expect(codes('vcfops_scope_group', { criteria: '1 | - | colour | x | EQ | y' })).toContain('vcfops.group.bad-criterion');
    expect(codes('vcfops_scope_group', { criteria: '1 | - | relationship | sibling | EQ | y' })).toContain('vcfops.group.bad-relation');
    expect(codes('vcfops_scope_group', { auto_resolve: false })).toContain('vcfops.group.static');
    expect(codes('vcfops_scope_group', { exclude_tag: '' })).toContain('vcfops.group.no-escape');
  });
});

describe('vcfops_policy_editor: export, merge, import, assign', () => {
  it('merges every section into the export and imports the whole policy', () => {
    const files = build('vcfops_policy_editor', { sections: 'alerts,symptoms,metrics,capacity,workload,profiles,groups' }).files;
    const xml = files['vcfops-policy-editor.xml']!;
    for (const element of ['<Alerts adapterKind="VMWARE" resourceKind="HostSystem">', '<Symptom id="SymptomDefinition-VMWARE-HostMemUsageHigh" enabled="true" threshold="90"/>', '<AttributeKind key="mem|host_usagePct" enabled="true" kpi="true"/>', '<CapacityAnalysis ', '<WorkloadAutomation ', '<CustomProfile name="Small VM" vcpu="2" memoryMB="4096" diskGB="60"/>']) {
      expect(xml).toContain(element);
    }
    const script = files['merge-policy.sh']!;
    expect(script).toContain('/suite-api/api/policies/import?forceImport=true');
    expect(script).toContain('policy=@');
    expect(script).toContain('policies/export?id=');
    expect(script).toContain('--allow-new');
    expect(script).toContain("group_id 'Production VMs'");
    expect(script).toContain('send POST policies');
    expect(Object.keys(files).some((path) => path.startsWith('import/'))).toBe(false);
  });

  it('does not create the policy when told not to', () => {
    expect(text('vcfops_policy_editor', { create: false })).not.toContain('send POST policies');
  });

  it('raises the findings it exists for', () => {
    expect(codes('vcfops_policy_editor', { policy_name: 'Default Policy' })).toContain('vcfops.policyed.default');
    expect(codes('vcfops_policy_editor', { sections: '' })).toContain('vcfops.policyed.nothing');
    expect(codes('vcfops_policy_editor', { alert_rows: 'VMWARE/HostSystem | AlertDefinition-x | on | yes' })).toContain('vcfops.policyed.automate');
    expect(codes('vcfops_policy_editor', { alert_rows: 'VMWARE/HostSystem | AlertDefinition-x | maybe | no' })).toContain('vcfops.policyed.bad-alert-row');
    expect(codes('vcfops_policy_editor', { sections: 'workload', wa_balance: 'AGGRESSIVE' })).toContain('vcfops.policyed.aggressive');
    expect(codes('vcfops_policy_editor', { sections: 'metrics', metric_rows: 'VMWARE/HostSystem | cpu|x | sometimes' })).toContain('vcfops.policyed.bad-metric-row');
  });

  it('leaves the policy toggle working', () => {
    const files = build('vcfops_policy_toggle').files;
    expect(files['merge-policy.sh']).toContain('policy=@');
    expect(hasErrors(build('vcfops_policy_toggle').findings ?? [])).toBe(false);
  });
});

describe('vcfops_capacity_report: scheduling depth', () => {
  it('writes daily, weekly and monthly schedules with their days', () => {
    const weekly = JSON.parse(build('vcfops_capacity_report', { cadence: 'weekly', weekdays: 'MONDAY,THURSDAY', every: 2 }).files['vcfops-capacity-report.json']!);
    expect(weekly.reportScheduleType).toBe('WEEKLY');
    expect(weekly.daysOfTheWeek).toEqual(['MONDAY', 'THURSDAY']);
    expect(weekly.recurrence).toBe(2);
    const quarterly = JSON.parse(build('vcfops_capacity_report', { cadence: 'quarterly', day_of_month: 5 }).files['vcfops-capacity-report.json']!);
    expect(quarterly.recurrence).toBe(3);
    expect(quarterly.dayOfTheMonth).toBe(5);
    expect(JSON.parse(build('vcfops_capacity_report', { cadence: 'daily' }).files['vcfops-capacity-report.json']!).reportScheduleType).toBe('DAILY');
  });

  it('looks up the report, object or group and email instance by name', () => {
    const all = text('vcfops_capacity_report', { scope_kind: 'group', email_instance: 'Platform team mail relay' });
    expect(all).toContain('report_definition_id ');
    expect(all).toContain('group_id ');
    expect(all).toContain("plugin_id 'Platform team mail relay'");
    expect(codes('vcfops_capacity_report', { start_time: '7am' })).toContain('vcfops.report.bad-time');
    expect(codes('vcfops_capacity_report', { recipients: '' })).toContain('vcfops.report.no-recipient');
  });
});

describe('vcfops_maintenance_window: recurrence, time zone, and objects by API', () => {
  it('writes each recurrence in the named time zone', () => {
    const weekly = JSON.parse(build('vcfops_maintenance_window', { recurrence: 'WEEKLY', weekday: 'SUNDAY', timezone: 'Europe/London' }).files['vcfops-maintenance-window.json']!);
    expect(weekly.schedule.scheduleType).toBe('WEEKLY');
    expect(weekly.schedule.daysOfTheWeek).toEqual(['SUNDAY']);
    expect(weekly.schedule.timeZone).toBe('Europe/London');
    const once = JSON.parse(build('vcfops_maintenance_window', { recurrence: 'ONCE' }).files['vcfops-maintenance-window.json']!);
    expect(once.schedule.startDate).toBe('2026-11-21');
  });

  it('puts the group into maintenance by API from cron, with a cap', () => {
    const files = build('vcfops_maintenance_window', { method: 'api' }).files;
    expect(files['enter-maintenance.sh']).toContain('maintained?duration=${MINUTES}');
    expect(files['enter-maintenance.sh']).toContain('MAX=200');
    expect(files['crontab.txt']).toContain('0 22 15-21 * * [ "$(date +\\%w)" = 6 ]');
    expect(files['crontab.txt']).toContain('CRON_TZ=UTC');
  });

  it('still insists on the overrun check, and catches a bad time', () => {
    expect(codes('vcfops_maintenance_window', { alert_on_overrun: false })).toContain('vcfops.window.no-overrun-check');
    expect(codes('vcfops_maintenance_window', { start_time: '25:00' })).toContain('vcfops.window.bad-time');
  });
});

describe('vcfops_custom_properties and vcfops_global_settings', () => {
  it('sets properties from the CSV with a cap and an undo file', () => {
    const files = build('vcfops_custom_properties').files;
    expect(files['properties.csv']!.split('\n')[0]).toBe('object,key,value');
    expect(files['apply.sh']).toContain('resources/${id}/properties');
    expect(files['apply.sh']).toContain('MAX_CHANGES=50');
    expect(files['apply.sh']).toContain('undo-${STAMP}.csv');
    expect(build('vcfops_custom_properties', { schedule: 'daily' }).files['crontab.txt']).toContain('0 5 * * *');
    expect(codes('vcfops_custom_properties', { rows: 'object,key,value\nvm1,Owner,x' })).toContain('vcfops.props.flat-key');
    expect(codes('vcfops_custom_properties', { rows: 'object,key,value\nvm1,summary|runtime|x,y' })).toContain('vcfops.props.collected-key');
    expect(codes('vcfops_custom_properties', { rows: 'object,key,value\nvm1,Custom|A,1\nvm1,Custom|A,2' })).toContain('vcfops.props.duplicate');
  });

  it('exports the global settings first and changes only the ticked ones', () => {
    const files = build('vcfops_global_settings').files;
    expect(JSON.parse(files['vcfops-global-settings.json']!)).toEqual({ SESSION_TIMEOUT: '30', DELETED_OBJECTS_RETENTION: '336' });
    expect(files['apply.sh']).toContain('globalsettings-before-');
    expect(codes('vcfops_global_settings', { settings: 'session_timeout', session_timeout: 480 })).toContain('vcfops.global.long-session');
    expect(codes('vcfops_global_settings', { settings: '' })).toContain('vcfops.global.nothing');
  });
});
