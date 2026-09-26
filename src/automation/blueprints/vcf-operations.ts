/**
 * VCF Operations: automation driven by what the platform already knows.
 *
 * This is the automation that follows the alerts, policies and custom groups
 * the VCF Ops content page reads — same objects, same scope, same four indirections
 * between "power off idle VMs" and which VMs that turns out to be tonight.
 *
 * Most of it is a suite-API payload rather than a script, because that is what
 * the platform actually takes: a notification rule pointed at a webhook plugin,
 * a custom group that decides a scope, a policy that turns an alert on. Each
 * one comes with the script that applies it and the call that puts it back,
 * because a payload with no way to apply it is a screenshot.
 *
 * Where the documented API stops — which policy a maintenance schedule sits
 * in, which metric says a VM has been off for ninety days — the output says so
 * and marks the value to check, rather than inventing a field that looks right.
 * Every script logs in the same way (apply.ts), so the ones that run on a
 * schedule need no token in a crontab.
 */

import { bool, num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, info, warning, type Finding } from '../../core/findings.ts';
import { automationBlueprint, type AutomationBlueprint } from '../from-automation.ts';
import { listOf, slugOf, type Automation } from '../automation.ts';
import { authHeader, authPreamble, readScript, scheduledEnv } from '../apply.ts';
import { FORMAT_SOURCES, contentImportScript, contentPackage, contentStep, importMd, nothingToImportMd, policyMergeScript } from '../vcfops-import.ts';
import { OBJECT_KINDS, kindOf, opsScript, rowsOf, sh } from './vcf-ops-setup-lib.ts';
import { VCF_OPS_POLICY_EDITOR } from './vcf-ops-setup-policy.ts';

const PLATFORM = 'vcf-operations' as const;

/** The scope chain, spelled out. It is the same four steps every time. */
function alertScope(group: string, policy: string): string[] {
  return [
    `The alert fires on an object.`,
    `That object is in the custom group "${group}" — open it and count the members before you turn this on.`,
    `The group is on the policy "${policy}", and the policy decides whether the alert is enabled at all.`,
    `The notification rule below then decides whether the action runs for that alert.`,
  ];
}

const WEEKDAYS: Readonly<Record<string, number>> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

/** "Sunday 02:00" as a cron schedule, or a marked placeholder when it will not parse. */
function cronOf(when: string): string {
  const match = /^\s*([a-z]+)\s+(\d{1,2}):(\d{2})\s*$/i.exec(when);
  const day = match ? WEEKDAYS[match[1]!.toLowerCase()] : undefined;
  if (!match || day === undefined) return '<REQUIRED: minute hour * * weekday>';
  return `${Number(match[3])} ${Number(match[2])} * * ${day}`;
}

export const VCF_OPERATIONS_AUTOMATIONS: readonly AutomationBlueprint[] = [
  automationBlueprint({
    id: 'vcfops_notify_webhook',
    platform: PLATFORM,
    label: 'A notification rule: send alerts through any outbound instance',
    group: 'Notification',
    description:
      'A notification rule that sends matching alerts through an outbound instance — webhook, email, Slack, ServiceNow, SNMP trap or log file — filtered by severity, alert type and subtype, impact, control state and status, object scope (a custom group, an object and its descendants, or a tag), object kind, object tags and named alert definitions, with the payload template and the per-channel settings (recipients, resend, maximum notifications, Slack channel, ServiceNow fields). The script looks the instance, template and scope up by name, and updates a rule of the same name rather than making a second one.',
    inputs: [
      { id: 'rule_name', label: 'Rule name', control: 'text', default: 'Critical infrastructure to runbook' },
      {
        id: 'channel',
        label: 'Send through',
        control: 'select',
        options: [
          { value: 'WebhookPlugin', label: 'Webhook Notification Plugin' },
          { value: 'StandardEmailPlugin', label: 'Standard Email Plugin' },
          { value: 'SlackPlugin', label: 'Slack Plugin' },
          { value: 'ServiceNowPlugin', label: 'Service-Now Notification Plugin' },
          { value: 'SNMPTrapPlugin', label: 'SNMP Trap Plugin' },
          { value: 'LogFilePlugin', label: 'Log File Plugin' },
        ],
        default: 'WebhookPlugin',
      },
      { id: 'plugin_instance', label: 'Outbound instance name', control: 'text', default: 'Runbook webhook', hint: 'As created by the outbound instance blueprint; looked up by name' },
      { id: 'endpoint', label: 'Webhook URL (on the instance)', control: 'text', default: 'https://runbooks.example.com/hooks/vcfops', hint: 'Set on the instance, not on this rule. Used here only to check it', showWhen: { input: 'channel', equals: ['WebhookPlugin'] } },
      { id: 'template', label: 'Payload template', control: 'text', default: '', hint: 'Its name; empty for the plugin’s default', showWhen: { input: 'channel', equals: ['WebhookPlugin', 'StandardEmailPlugin', 'SlackPlugin', 'ServiceNowPlugin'] } },
      { id: 'recipients', label: 'Recipients', control: 'text', default: 'platform-oncall@example.com', hint: 'Comma-separated; team addresses', showWhen: { input: 'channel', equals: ['StandardEmailPlugin'] } },
      { id: 'cc', label: 'CC', control: 'text', default: '', showWhen: { input: 'channel', equals: ['StandardEmailPlugin'] } },
      { id: 'resend_minutes', label: 'Notify again every (minutes, 0 = never)', control: 'number', default: 0, min: 0, max: 10080, showWhen: { input: 'channel', equals: ['StandardEmailPlugin'] } },
      { id: 'max_notifications', label: 'Maximum notifications per alert (0 = no limit)', control: 'number', default: 3, min: 0, max: 100, showWhen: { input: 'channel', equals: ['StandardEmailPlugin'] } },
      { id: 'delay_minutes', label: 'Delay before notifying (minutes)', control: 'number', default: 0, min: 0, max: 1440, showWhen: { input: 'channel', equals: ['StandardEmailPlugin'] } },
      { id: 'slack_channel', label: 'Slack channel (empty for the instance’s)', control: 'text', default: '', showWhen: { input: 'channel', equals: ['SlackPlugin'] } },
      { id: 'sn_fields', label: 'ServiceNow fields', control: 'textarea', default: 'assignment_group | Platform Operations\ncategory | Infrastructure', hint: 'Field | Value', showWhen: { input: 'channel', equals: ['ServiceNowPlugin'] } },
      {
        id: 'criticality',
        label: 'Only these severities',
        control: 'select',
        options: [
          { value: 'CRITICAL', label: 'Critical only' },
          { value: 'CRITICAL,IMMEDIATE', label: 'Critical and immediate' },
          { value: 'CRITICAL,IMMEDIATE,WARNING', label: 'Critical, immediate and warning' },
          { value: '', label: 'Every severity — see the warning' },
        ],
        default: 'CRITICAL,IMMEDIATE',
      },
      {
        id: 'alert_type',
        label: 'Alert type',
        control: 'select',
        options: [
          { value: '', label: 'Any type' },
          { value: 'Virtualization/Hypervisor', label: 'Virtualization / hypervisor' },
          { value: 'Hardware (OSI)', label: 'Hardware (OSI)' },
          { value: 'Storage', label: 'Storage' },
          { value: 'Network', label: 'Network' },
          { value: 'Application', label: 'Application' },
        ],
        default: '',
      },
      {
        id: 'alert_subtype',
        label: 'Alert subtype',
        control: 'select',
        options: [
          { value: '', label: 'Any subtype' },
          { value: 'Availability', label: 'Availability' },
          { value: 'Performance', label: 'Performance' },
          { value: 'Capacity', label: 'Capacity' },
          { value: 'Compliance', label: 'Compliance' },
          { value: 'Configuration', label: 'Configuration' },
        ],
        default: '',
      },
      {
        id: 'impact',
        label: 'Impact',
        control: 'select',
        options: [
          { value: '', label: 'Any impact' },
          { value: 'HEALTH', label: 'Health' },
          { value: 'RISK', label: 'Risk' },
          { value: 'EFFICIENCY', label: 'Efficiency' },
        ],
        default: '',
      },
      {
        id: 'control_state',
        label: 'Control state',
        control: 'select',
        options: [
          { value: 'OPEN', label: 'Open only' },
          { value: 'OPEN,ASSIGNED', label: 'Open and assigned' },
          { value: 'OPEN,ASSIGNED,SUSPENDED', label: 'Open, assigned and suspended' },
        ],
        default: 'OPEN',
      },
      { id: 'on_update', label: 'Also send when the alert is updated', control: 'toggle', default: true },
      { id: 'on_cancel', label: 'Also send when the alert is cancelled', control: 'toggle', default: true, hint: 'So a ticket the alert opened can be closed by the same channel' },
      {
        id: 'scope',
        label: 'Objects',
        control: 'select',
        options: [
          { value: 'all', label: 'Any object' },
          { value: 'group', label: 'Members of a custom group' },
          { value: 'object', label: 'An object and its descendants' },
          { value: 'tag', label: 'Objects with a tag (Category:Value)' },
        ],
        default: 'all',
      },
      { id: 'scope_value', label: 'Group, object or tag', control: 'text', default: 'Production hosts', showWhen: { input: 'scope', equals: ['group', 'object', 'tag'] } },
      { id: 'resource_kinds', label: 'Only these object kinds', control: 'text', default: 'HostSystem, Datastore, ClusterComputeResource', hint: 'Comma-separated; ADAPTER/Kind for kinds outside vCenter. Empty means every kind, which is wider than it sounds' },
      { id: 'tag_filter', label: 'Advanced: only objects with these tags', control: 'textarea', default: '', hint: 'Category | Value' },
      { id: 'alert_ids', label: 'Only these alert definitions', control: 'textarea', default: '', hint: 'One id per line. Empty means every alert definition that passes the filters above' },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const ruleName = str(values, 'rule_name', 'Alert notification');
      const channel = str(values, 'channel', 'WebhookPlugin');
      const instance = str(values, 'plugin_instance', '');
      const endpoint = str(values, 'endpoint', '');
      const template = ['WebhookPlugin', 'StandardEmailPlugin', 'SlackPlugin', 'ServiceNowPlugin'].includes(channel) ? str(values, 'template', '') : '';
      const criticalities = listOf(str(values, 'criticality', ''));
      const alertType = str(values, 'alert_type', '');
      const alertSubtype = str(values, 'alert_subtype', '');
      const impact = str(values, 'impact', '');
      const controlStates = listOf(str(values, 'control_state', 'OPEN'));
      const onUpdate = bool(values, 'on_update', true);
      const onCancel = bool(values, 'on_cancel', true);
      const scopeKind = str(values, 'scope', 'all');
      const scopeValue = scopeKind === 'all' ? '' : str(values, 'scope_value', '');
      const kinds = listOf(str(values, 'resource_kinds', ''));
      const tagRows = rowsOf(str(values, 'tag_filter', ''));
      const alertIds = listOf(str(values, 'alert_ids', ''));
      const recipients = listOf(str(values, 'recipients', ''));
      const cc = listOf(str(values, 'cc', ''));
      const resend = num(values, 'resend_minutes', 0);
      const maxNotify = num(values, 'max_notifications', 3);
      const delay = num(values, 'delay_minutes', 0);
      const snFields = rowsOf(str(values, 'sn_fields', ''));
      const base = slugOf(name || ruleName, 'notification-rule');
      const channelLabel: Record<string, string> = { WebhookPlugin: 'webhook', StandardEmailPlugin: 'email', SlackPlugin: 'Slack', ServiceNowPlugin: 'ServiceNow', SNMPTrapPlugin: 'SNMP trap', LogFilePlugin: 'log file' };
      const via = channelLabel[channel] ?? channel;

      const findings: Finding[] = [];
      if (criticalities.length === 0 && kinds.length === 0 && alertIds.length === 0 && scopeKind === 'all' && !alertType && !impact && tagRows.length === 0) {
        findings.push(
          warning('vcfops.rule.catch-all', 'This rule has no filters at all, so it notifies on every alert in the estate.', {
            remediation: 'A rule that notifies on everything is a rule people filter to a folder within a fortnight. Narrow it to the severity and object kinds that warrant acting.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (/[?&](token|key|secret|signature)=/i.test(endpoint)) {
        findings.push(
          error('vcfops.rule.secret-in-url', 'The webhook URL carries a secret in its query string.', {
            remediation: 'It will be stored on the plugin instance, exported with the content, and written to every log along the way. Put the secret in the plugin’s authentication or a header instead.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (!instance) findings.push(error('vcfops.rule.no-instance', 'No outbound instance named, so the rule has nowhere to send.', { source: 'ArchToolKit' }));
      if (channel === 'StandardEmailPlugin' && recipients.length === 0) findings.push(error('vcfops.rule.no-recipient', 'An email rule with no recipients sends to nobody.', { source: 'ArchToolKit' }));
      if (channel === 'StandardEmailPlugin' && resend > 0 && resend < 30) findings.push(warning('vcfops.rule.resend', `Resending every ${resend} minutes is a mail storm on a long outage.`, { remediation: 'An hour or more, with a maximum number of notifications, keeps the reminder without the flood.', source: 'ArchToolKit' }));
      if (channel === 'StandardEmailPlugin' && resend > 0 && maxNotify === 0) findings.push(warning('vcfops.rule.unbounded', 'Resend is on with no maximum, so an alert nobody fixes mails forever.', { source: 'ArchToolKit' }));
      if (scopeKind === 'tag' && !/^[^:]+:.+$/.test(scopeValue)) findings.push(error('vcfops.rule.tag-form', `"${scopeValue}" is not Category:Value.`, { source: 'ArchToolKit' }));
      if (scopeKind !== 'all' && !scopeValue) findings.push(error('vcfops.rule.no-scope', 'The object scope is set but empty.', { source: 'ArchToolKit' }));
      if (channel === 'LogFilePlugin') findings.push(info('vcfops.rule.logfile', 'A log file reaches nobody until something reads it; collect the folder with log management.', { source: 'ArchToolKit' }));
      if (controlStates.includes('SUSPENDED')) findings.push(warning('vcfops.rule.suspended', 'Suspended alerts are ones somebody has deliberately parked; notifying on them undoes that.', { source: 'ArchToolKit' }));

      const properties: { name: string; value: string }[] =
        channel === 'StandardEmailPlugin'
          ? [
              { name: 'emailaddr', value: recipients.join(',') },
              ...(cc.length > 0 ? [{ name: 'emailaddrCC', value: cc.join(',') }] : []),
              { name: 'resendAlert', value: String(resend) },
              { name: 'maxNotify', value: String(maxNotify) },
              { name: 'delayAlert', value: String(delay) },
            ]
          : channel === 'SlackPlugin' && str(values, 'slack_channel', '')
            ? [{ name: 'channel', value: str(values, 'slack_channel', '') }]
            : channel === 'ServiceNowPlugin'
              ? snFields.filter((row) => row[0]).map((row) => ({ name: row[0] ?? '', value: row[1] ?? '' }))
              : [];

      // Fields as documented for POST /api/notifications/rules. There is no
      // enabled flag and no URL here: the URL belongs to the plugin instance.
      const [tagCategory, ...tagValue] = scopeValue.split(':');
      const tagFilters = [...tagRows.filter((row) => row[0]).map((row) => ({ category: row[0] ?? '', value: row[1] ?? '' })), ...(scopeKind === 'tag' ? [{ category: tagCategory ?? '', value: tagValue.join(':') }] : [])];
      const payload = {
        name: ruleName,
        pluginId: `<set by apply.sh from the outbound instance "${instance}">`,
        ...(template ? { templateId: `<set by apply.sh from the payload template "${template}">` } : {}),
        alertControlStates: controlStates,
        alertStatuses: ['NEW', ...(onUpdate ? ['UPDATED'] : []), ...(onCancel ? ['CANCELED'] : [])],
        ...(criticalities.length > 0 ? { criticalities } : {}),
        ...(kinds.length > 0 ? { resourceKindFilters: kinds.map((kind) => kindOf(kind)) } : {}),
        ...(alertType ? { alertTypeFilters: [{ type: alertType, subTypes: alertSubtype ? [alertSubtype] : [] }] } : alertSubtype ? { alertTypeFilters: [{ type: '', subTypes: [alertSubtype] }] } : {}),
        ...(impact ? { alertImpacts: [impact] } : {}),
        ...(scopeKind === 'group' || scopeKind === 'object' ? { resourceFilter: { resourceId: `<set by apply.sh from the ${scopeKind} "${scopeValue}">`, relation: scopeKind === 'group' ? ['SELF', 'CHILD'] : ['SELF', 'DESCENDANT'] } } : {}),
        ...(tagFilters.length > 0 ? { resourceTagFilters: tagFilters } : {}),
        ...(alertIds.length > 0 ? { alertDefinitionIdFilters: { values: alertIds } } : {}),
        ...(properties.length > 0 ? { properties } : {}),
      };

      const rulesExport = `${JSON.stringify({ NotificationRules: [{ ...payload, enabled: true }] }, null, 2)}\n`;
      const apply = opsScript({
        about: [
          `Create or update the notification rule "${ruleName}", sending through the outbound`,
          `instance "${instance}". The instance${template ? ', the payload template' : ''}${scopeKind === 'group' || scopeKind === 'object' ? ' and the scope' : ''} are looked up by name.`,
        ],
        body: [
          `PLUGIN_ID=$(plugin_id ${sh(instance)})`,
          `TYPE=$(api GET alertplugins | jq -r --arg i "$PLUGIN_ID" '[(.notificationPluginInstances[]?, .pluginInstances[]?) | select(.pluginId == $i) | .pluginTypeId] | .[0] // ""')`,
          `[[ "$TYPE" == ${sh(channel)} ]] || echo "WARNING: \\"${instance.replace(/"/g, '')}\\" is a \${TYPE} instance, not ${channel}; the channel settings in this rule are for ${channel}." >&2`,
          ...(template
            ? [
                `TEMPLATE_ID=$( { api GET notifications/templates || true; } | jq -r --arg n ${sh(template)} '[.. | objects | select(.name? == $n) | (.id // .templateId)] | .[0] // empty')`,
                `[[ -n "$TEMPLATE_ID" ]] || { echo "VERIFY: no payload template named ${template.replace(/"/g, '')} found at GET /suite-api/api/notifications/templates. Create it first, or check the path on your release." >&2; exit 1; }`,
              ]
            : ['TEMPLATE_ID=""']),
          scopeKind === 'group' ? `SCOPE_ID=$(group_id ${sh(scopeValue)})` : scopeKind === 'object' ? `SCOPE_ID=$(resource_id ${sh(scopeValue)})` : 'SCOPE_ID=""',
          'RULES=$(api GET notifications/rules)',
          `RULE_ID=$(jq -r --arg n ${sh(ruleName)} '[.. | objects | select(.name? == $n and .pluginId? != null) | .id] | .[0] // empty' <<<"$RULES")`,
          `body() { jq --arg p "$PLUGIN_ID" --arg t "$TEMPLATE_ID" --arg s "$SCOPE_ID" --arg id "$RULE_ID" '.pluginId = $p | (if $t != "" then .templateId = $t else del(.templateId) end) | (if $s != "" then .resourceFilter.resourceId = $s else . end) | (if $id != "" then .id = $id else . end)' "$HERE/${base}.json"; }`,
          'if [[ -n "$RULE_ID" ]]; then',
          '  body | send PUT notifications/rules >/dev/null',
          '  echo "Updated rule ${RULE_ID}."',
          'else',
          '  echo "Created rule $(body | send POST notifications/rules | jq -r \'.id // empty\')."',
          'fi',
        ],
        undo: 'DELETE /suite-api/api/notifications/rules/{id}, or delete the rule in the interface. The outbound instance stays for anything else that uses it.',
      });

      return {
        platform: PLATFORM,
        title: `${ruleName} — send matching alerts by ${via} through "${instance}"`,
        effect: 'read',
        trigger: {
          kind: 'alert',
          detail: alertIds.length > 0 ? `${alertIds.length} named alert definitions, at ${criticalities.join(' or ') || 'any severity'}` : `Any alert definition at ${criticalities.join(' or ') || 'any severity'}${alertType ? `, type ${alertType}${alertSubtype ? ` / ${alertSubtype}` : ''}` : ''}${kinds.length > 0 ? ` on ${kinds.join(', ')}` : ''}`,
          worstCase: `once when each alert is raised${onUpdate ? ', again each time it is updated' : ''}${onCancel ? ', and once when it is cancelled' : ''}${channel === 'StandardEmailPlugin' && resend > 0 ? `, plus a reminder every ${resend} minutes up to ${maxNotify || 'no'} limit` : ''}`,
        },
        scope: {
          what: `${kinds.length > 0 ? `Alerts on ${kinds.join(', ')}` : 'Alerts on every object kind'}${scopeKind === 'group' ? ` in the custom group "${scopeValue}"` : scopeKind === 'object' ? ` on "${scopeValue}" and everything under it` : scopeKind === 'tag' ? ` on objects tagged ${scopeValue}` : ''}.`,
          decidedBy: [
            `Severity: ${criticalities.join(', ') || 'any'}; control state: ${controlStates.join(', ')}; status: ${payload.alertStatuses.join(', ')}.`,
            alertType || alertSubtype ? `Alert type ${alertType || 'any'} / subtype ${alertSubtype || 'any'}.` : 'Any alert type.',
            impact ? `Impact: ${impact.toLowerCase()}.` : 'Any impact.',
            scopeKind === 'all' ? 'No object scope.' : `Object scope: ${scopeKind} "${scopeValue}"${scopeKind === 'group' ? ', whose membership is a rule somebody else edits' : ''}.`,
            kinds.length > 0 ? `The object-kind filter: ${kinds.join(', ')}.` : 'No object-kind filter, so every kind.',
            ...(tagRows.length > 0 ? [`Object tags: ${tagRows.map((row) => `${row[0]}:${row[1] ?? ''}`).join(', ')}.`] : []),
            alertIds.length > 0 ? `${alertIds.length} named alert definitions.` : 'No named alerts, so every definition that passes the filters.',
            'Whether each of those alert definitions is enabled in the policy that applies to the object.',
          ],
          ifWrong: `The ${via} receiver gets more than it can cope with and somebody mutes it, which is worse than never having built it.`,
        },
        guardrails: [
          { rule: 'Severity and object kind are filtered', because: 'An unfiltered rule posts every informational alert in the estate and trains people to ignore the channel.' },
          { rule: `Control state ${controlStates.join(', ')}`, because: 'An alert somebody has suspended stops notifying unless you say otherwise.' },
          { rule: 'The instance, template and scope are looked up by name, and a rule of the same name is updated', because: 'A rule pointed at the wrong instance id sends nowhere, silently; a second copy sends twice.' },
          ...(channel === 'StandardEmailPlugin' ? [{ rule: `At most ${maxNotify || 'unlimited'} notification(s) per alert`, because: 'A reminder is useful; a hundred of them is a filter rule.' }] : []),
        ],
        dryRun: [
          'Run apply.sh --dry-run: it resolves the names and prints the rule as it would be sent.',
          channel === 'WebhookPlugin' ? 'Point the webhook instance at a request bin first, apply this rule, and let it run for an hour. Count what arrives.' : 'Let it run for an hour against a test recipient or channel and count what arrives. That count is what the receiver has to survive on a bad night.',
        ],
        undo: [
          'DELETE /suite-api/api/notifications/rules/{id} (the id apply.sh printed), or delete the rule in the interface.',
          'Deleting the rule leaves the outbound instance in place for anything else that uses it.',
        ],
        told: [channel === 'StandardEmailPlugin' ? `${recipients.join(', ') || 'Nobody'}${cc.length > 0 ? `, copied to ${cc.join(', ')}` : ''}.` : `The ${via} receiver behind "${instance}". Nothing else is notified — this rule replaces no mailbox unless you delete the mailbox rule as well.`],
        requires: [
          `The outbound instance "${instance}" (${channel}) — the outbound instance blueprint in this kit makes one.`,
          ...(template ? [`The payload template "${template}".`] : []),
          ...(scopeKind === 'group' ? [`The custom group "${scopeValue}".`] : scopeKind === 'object' ? [`The object "${scopeValue}", with a unique name.`] : []),
          'VCFOPS_TOKEN, or VCFOPS_USER with VCFOPS_PASSWORD_FILE so the script logs in for itself.',
        ],
        files: {
          [`${base}.json`]: `${JSON.stringify(payload, null, 2)}\n`,
          'apply.sh': apply,
          'import/notification-rule.json': rulesExport,
          ...contentPackage({ 'notificationrules.json': rulesExport }, { notificationRules: 1 }),
          'import-content.sh': contentImportScript({ what: `the notification rule "${ruleName}"`, contentType: 'NOTIFICATION_RULES', needles: [`"name": ${JSON.stringify(ruleName)}`, `"name":${JSON.stringify(ruleName)}`] }),
          'IMPORT.md': importMd({
            title: `the notification rule "${ruleName}"`,
            steps: [
              { heading: 'First, the outbound instance', files: [], how: [`"${instance}" has to exist: generate it with the outbound instance blueprint in this kit, or add it under Infrastructure Operations → Configurations → Outbound Settings.`] },
              { heading: 'The rule, by the REST API', files: [`${base}.json`, 'apply.sh'], how: ['./apply.sh (add --dry-run first to preview) — looks up the instance, template and scope by name, then POST (or PUT, for a rule of the same name) /suite-api/api/notifications/rules. This is the confirmed route.'] },
              {
                heading: 'Or: the rule as a file',
                files: ['import/notification-rule.json'],
                how: ['Fill in the <set by apply.sh> ids by hand first, then Infrastructure Operations → Configurations → Notifications → ⋯ → Import, and choose import/notification-rule.json: {"NotificationRules": [the rule]}, the wrapper a content export uses.'],
                verify: ['the notification-rule import in the interface and its file shape are not documented; the wrapper is the one content exports hold, and the rule inside is the REST body. If the dialog rejects it, use apply.sh.'],
              },
              contentStep('NOTIFICATION_RULES'),
            ],
            sources: FORMAT_SOURCES,
          }),
        },
        notes: [
          'The URL, authentication and proxy are properties of the outbound instance, not of this rule.',
          'VERIFY: alertTypeFilters, alertImpacts, resourceTagFilters and the per-channel properties (emailaddr, resendAlert, maxNotify, delayAlert, channel, and the ServiceNow field names) are the names recent releases use; compare with GET /suite-api/api/notifications/rules for a rule set the same way in the interface.',
          'Filters are "empty means everything" in both directions: a rule with nothing set covers the estate, and a rule with an object-kind filter silently stops covering an adapter somebody adds next year.',
        ],
        findings,
      };
    },
  }),

  automationBlueprint({
    id: 'vcfops_scope_group',
    platform: PLATFORM,
    label: 'A custom group: the full criteria builder',
    group: 'Scope',
    description:
      'A custom group of any type (Environment, Function, Location, Department, Application or your own) over any object kind — VMs, ESX hosts, clusters, vSAN clusters, datastores and datastore clusters, distributed switches and port groups, NSX objects, Supervisor namespaces, VKS clusters, datacenters, vCenters, VCF instances — built from criteria sets (any set may match), each with metric, property, name, tag and relationship rules, plus static includes and excludes. Built with an opt-in tag and an exclusion tag from the start, so an object can be taken out of scope by tagging it rather than by editing the automation at two in the morning.',
    inputs: [
      { id: 'group_name', label: 'Group name', control: 'text', default: 'Automation — safe to act on' },
      {
        id: 'group_type',
        label: 'Group type',
        control: 'select',
        options: [
          { value: 'Environment', label: 'Environment' },
          { value: 'Function', label: 'Function' },
          { value: 'Location', label: 'Location' },
          { value: 'Department', label: 'Department' },
          { value: 'Application', label: 'Application' },
          { value: 'custom', label: 'A type of your own' },
        ],
        default: 'Environment',
      },
      { id: 'custom_type', label: 'Type name', control: 'text', default: 'Automation scope', showWhen: { input: 'group_type', equals: ['custom'] } },
      { id: 'object_kind', label: 'Object kind (criteria set 1)', control: 'select', options: OBJECT_KINDS, default: 'VMWARE/VirtualMachine' },
      { id: 'include_tag', label: 'Include objects tagged', control: 'text', default: 'automation:allowed', hint: 'An opt-in tag. Safer than opting the estate in and excluding from it' },
      { id: 'exclude_tag', label: 'Never touch objects tagged', control: 'text', default: 'automation:never', hint: 'The escape hatch. Leave this set' },
      { id: 'name_excludes', label: 'Never touch names containing', control: 'text', default: 'dc, sql, prod-db', hint: 'A crude second net, on purpose' },
      {
        id: 'criteria',
        label: 'More criteria',
        control: 'textarea',
        default: '1 | - | name | - | NOT_STARTS_WITH | vCLS-',
        hint: 'Set | Object kind (- for set 1’s) | Rule: metric, property, name, tag, relationship | Key (metric or property key, tag category, or child/parent/descendant/ancestor) | Operator | Value',
      },
      { id: 'include_objects', label: 'Always include', control: 'textarea', default: '', hint: 'Object kind | Name' },
      { id: 'exclude_objects', label: 'Always exclude', control: 'textarea', default: '', hint: 'Object kind | Name' },
      { id: 'auto_resolve', label: 'Keep membership updated', control: 'toggle', default: true },
      { id: 'policy_name', label: 'Put the group on this policy', control: 'text', default: 'Production Policy' },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const groupName = str(values, 'group_name', 'Automation scope');
      const typeChoice = str(values, 'group_type', 'Environment');
      const groupType = typeChoice === 'custom' ? str(values, 'custom_type', 'Custom') : typeChoice;
      const kindValue = str(values, 'object_kind', 'VMWARE/VirtualMachine');
      const primary = kindOf(kindValue);
      const includeTag = str(values, 'include_tag', '');
      const excludeTag = str(values, 'exclude_tag', '');
      const nameExcludes = listOf(str(values, 'name_excludes', ''));
      const criteria = rowsOf(str(values, 'criteria', ''));
      const includes = rowsOf(str(values, 'include_objects', ''));
      const excludes = rowsOf(str(values, 'exclude_objects', ''));
      const autoResolve = bool(values, 'auto_resolve', true);
      const policy = str(values, 'policy_name', 'Default Policy');
      const base = slugOf(name || groupName, 'custom-group');
      const kindLabel = (value: string) => OBJECT_KINDS.find((option) => option.value === value)?.label ?? value;

      const findings: Finding[] = [];
      if (!excludeTag) {
        findings.push(
          warning('vcfops.group.no-escape', 'There is no exclusion tag on this group.', {
            remediation: 'Without one, taking a single object out of scope means editing the group while the automation is live. Set one and leave it set.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (!includeTag) {
        findings.push(
          warning('vcfops.group.opt-out', 'This group opts the whole object kind in and then excludes from it.', {
            remediation: 'An opt-in tag is the safer shape: anything new is outside the automation until somebody says otherwise, rather than inside it until somebody notices.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (!autoResolve) {
        findings.push(warning('vcfops.group.static', 'Membership is resolved once and then frozen.', { remediation: 'A group with fixed members drifts out of date silently. Leave it updating unless the list is meant to be a snapshot.', source: 'ArchToolKit' }));
      }

      // Criteria sets: set 1 is the object kind above with the tag and name rules; more come from the rows.
      interface Rule { readonly rule: string; readonly key: string; readonly op: string; readonly value: string }
      const sets = new Map<string, { kind: string; rules: Rule[] }>([['1', { kind: kindValue, rules: [] }]]);
      const RULES = new Set(['metric', 'property', 'name', 'tag', 'relationship']);
      const RELATIONS = new Set(['child', 'parent', 'descendant', 'ancestor']);
      for (const row of criteria) {
        const [set = '1', kind = '-', rule = '', key = '', op = '', value = ''] = row;
        const r = rule.toLowerCase();
        if (row.length !== 6 || !RULES.has(r) || !op) {
          findings.push(error('vcfops.group.bad-criterion', `Criterion "${row.join(' | ')}" needs Set | Object kind | Rule | Key | Operator | Value, with the rule one of metric, property, name, tag, relationship.`, { source: 'ArchToolKit' }));
          continue;
        }
        if (r === 'relationship' && !RELATIONS.has(key.toLowerCase())) findings.push(error('vcfops.group.bad-relation', `"${key}" is not child, parent, descendant or ancestor.`, { source: 'ArchToolKit' }));
        if (r === 'metric' && !Number.isFinite(Number(value))) findings.push(error('vcfops.group.metric-value', `A metric rule compares numbers; "${value}" is not one.`, { source: 'ArchToolKit' }));
        const entry = sets.get(set) ?? { kind: kind === '-' || !kind ? kindValue : kind, rules: [] };
        if (set === '1' && kind !== '-' && kind && kind !== kindValue) findings.push(warning('vcfops.group.set1-kind', `Set 1 is ${kindValue}; the row "${row.join(' | ')}" names ${kind}, which is ignored.`, { source: 'ArchToolKit' }));
        if (set !== '1' && kind !== '-' && kind) entry.kind = kind;
        entry.rules.push({ rule: r, key, op: op.toUpperCase(), value });
        sets.set(set, entry);
      }
      if (sets.size > 1) findings.push(info('vcfops.group.or', `${sets.size} criteria sets: an object that matches any one of them is a member. The opt-in and exclusion tags are in set 1 only — put them in every set if they should hold for all.`, { source: 'ArchToolKit' }));
      for (const [set, entry] of sets) if (set !== '1' && !OBJECT_KINDS.some((option) => option.value === entry.kind)) findings.push(info('vcfops.group.free-kind', `Set ${set} uses ${entry.kind}, which is not in the list; check it against GET /suite-api/api/adapterkinds.`, { source: 'ArchToolKit' }));

      const setRules = (set: string, entry: { kind: string; rules: Rule[] }) => {
        const k = kindOf(entry.kind);
        const first = set === '1';
        const numeric = (value: string) => value.trim() !== '' && Number.isFinite(Number(value));
        return {
          resourceKindKey: { resourceKind: k.resourceKind, adapterKind: k.adapterKind },
          statConditionRules: entry.rules.filter((r) => r.rule === 'metric').map((r) => ({ key: r.key, doubleValue: Number(r.value), compareOperator: r.op })),
          propertyConditionRules: [
            ...(first && includeTag ? [{ key: 'summary|tag', stringValue: includeTag, compareOperator: 'CONTAINS' }] : []),
            ...(first && excludeTag ? [{ key: 'summary|tag', stringValue: excludeTag, compareOperator: 'NOT_CONTAINS' }] : []),
            ...entry.rules.filter((r) => r.rule === 'property').map((r) => (numeric(r.value) && !/CONTAINS|STARTS|ENDS|REGEX/.test(r.op) ? { key: r.key, doubleValue: Number(r.value), compareOperator: r.op } : { key: r.key, stringValue: r.value, compareOperator: r.op })),
          ],
          resourceNameConditionRules: [
            ...(first ? nameExcludes.map((fragment) => ({ name: fragment, compareOperator: 'NOT_CONTAINS' })) : []),
            ...entry.rules.filter((r) => r.rule === 'name').map((r) => ({ name: r.value, compareOperator: r.op })),
          ],
          relationshipConditionRules: entry.rules.filter((r) => r.rule === 'relationship').map((r) => ({ relation: r.key.toUpperCase(), name: r.value, compareOperator: r.op })),
          resourceTagConditionRules: entry.rules.filter((r) => r.rule === 'tag').map((r) => ({ category: r.key, stringValue: r.value, compareOperator: r.op })),
        };
      };

      const payload = {
        resourceKey: {
          name: groupName,
          adapterKindKey: 'Container',
          resourceKindKey: groupType,
          resourceIdentifiers: [],
        },
        policy: `<set by apply.sh from the policy "${policy}">`,
        autoResolveMembership: autoResolve,
        membershipDefinition: {
          includedResources: [] as string[],
          excludedResources: [] as string[],
          rules: [...sets.entries()].map(([set, entry]) => setRules(set, entry)),
        },
      };

      // The same group in the shape Custom Groups → Export writes (notoriousbdg exports).
      const exportRules = (set: string, entry: { kind: string; rules: Rule[] }) => [
        ...(set === '1' && includeTag ? [{ ruleType: 'StringMetricPropertyRule', ruleMetricKey: 'summary|tag', isProperty: true, ruleStringOperator: 'CONTAINS', ruleStringValue: includeTag }] : []),
        ...(set === '1' && excludeTag ? [{ ruleType: 'StringMetricPropertyRule', ruleMetricKey: 'summary|tag', isProperty: true, ruleStringOperator: 'NOT_CONTAINS', ruleStringValue: excludeTag }] : []),
        ...(set === '1' ? nameExcludes.map((fragment) => ({ ruleType: 'ResourceNameRule', ruleStringOperator: 'NOT_CONTAINS', ruleStringValue: fragment })) : []),
        ...entry.rules.map((r) =>
          r.rule === 'name'
            ? { ruleType: 'ResourceNameRule', ruleStringOperator: r.op, ruleStringValue: r.value }
            : r.rule === 'metric'
              ? { ruleType: 'NumericMetricPropertyRule', ruleMetricKey: r.key, isProperty: false, ruleOperator: r.op, ruleValue: Number(r.value) }
              : r.rule === 'property'
                ? { ruleType: 'StringMetricPropertyRule', ruleMetricKey: r.key, isProperty: true, ruleStringOperator: r.op, ruleStringValue: r.value }
                : r.rule === 'tag'
                  ? { ruleType: 'ResourceTagRule', ruleTagCategory: r.key, ruleStringOperator: r.op, ruleStringValue: r.value }
                  : { ruleType: 'RelationshipRule', ruleRelation: r.key.toUpperCase(), ruleStringOperator: r.op, ruleStringValue: r.value },
        ),
      ];
      const groupExport = `${JSON.stringify(
        {
          customGroups: [
            {
              resourceKind: groupType,
              adapterKind: 'Container',
              name: groupName,
              description: `Put on the policy "${policy}".`,
              autoResolveMembership: autoResolve,
              started: true,
              membershipDefinition: { ruleGroups: [...sets.entries()].map(([set, entry]) => ({ ...kindOf(entry.kind), rules: exportRules(set, entry) })).map((group) => ({ resourceKind: group.resourceKind, adapterKind: group.adapterKind, rules: group.rules })) },
            },
          ],
        },
        null,
        2,
      )}\n`;

      const apply = opsScript({
        about: [
          `Create or update the custom group "${groupName}" (type ${groupType}) and put it on the policy "${policy}".`,
          'The policy, the group type and every static include and exclude are looked up by name;',
          'a group of the same name is updated rather than duplicated. It prints the member count.',
        ],
        body: [
          `POLICY_ID=$(policy_id ${sh(policy)})`,
          `TYPE=${sh(groupType)}`,
          'if ! api GET resources/groups/types | jq -e --arg t "$TYPE" \'[.. | objects | select(.key? == $t or .name? == $t)] | length > 0\' >/dev/null; then',
          ...(typeChoice === 'custom'
            ? ['  jq -n --arg t "$TYPE" \'{name: $t}\' | send POST resources/groups/types >/dev/null', '  echo "Created the group type ${TYPE}."']
            : ['  echo "VERIFY: this instance has no group type ${TYPE}. The types it has:" >&2', '  api GET resources/groups/types | jq -r \'[.. | objects | (.key? // .name? // empty) | strings] | unique | .[]\' >&2', '  exit 1']),
          'fi',
          'INC="[]"; EXC="[]"',
          ...includes.map((row) => { const k = kindOf(row[0] ?? ''); return `INC=$(jq -c --arg i "$(resource_id ${sh(row[1] ?? '')} ${sh(k.adapterKind)} ${sh(k.resourceKind)})" '. + [$i]' <<<"$INC")`; }),
          ...excludes.map((row) => { const k = kindOf(row[0] ?? ''); return `EXC=$(jq -c --arg i "$(resource_id ${sh(row[1] ?? '')} ${sh(k.adapterKind)} ${sh(k.resourceKind)})" '. + [$i]' <<<"$EXC")`; }),
          `GROUP_ID=$(api GET "resources/groups?pageSize=10000" | jq -r --arg n ${sh(groupName)} '[.groups[]? | select(.resourceKey.name == $n) | .id] | .[0] // empty')`,
          `body() { jq --arg p "$POLICY_ID" --argjson inc "$INC" --argjson exc "$EXC" --arg id "$GROUP_ID" '.policy = $p | .membershipDefinition.includedResources = $inc | .membershipDefinition.excludedResources = $exc | (if $id != "" then .id = $id else . end)' "$HERE/${base}.json"; }`,
          'if [[ -n "$GROUP_ID" ]]; then',
          '  body | send PUT resources/groups >/dev/null',
          '  echo "Updated ${GROUP_ID}."',
          'else',
          '  GROUP_ID=$(body | send POST resources/groups | jq -r \'.id // empty\')',
          '  echo "Created ${GROUP_ID}."',
          'fi',
          'if (( ! DRY_RUN )); then',
          '  sleep 10',
          '  echo "Members now: $(api GET "resources/groups/${GROUP_ID}/members?pageSize=1" | jq -r \'.pageInfo.totalCount // "unknown"\'). Read the list before any automation points at it."',
          'fi',
        ],
        undo: 'DELETE /suite-api/api/resources/groups/{id}. Deleting a group does not touch its members.',
      });

      const decided = [...sets.entries()].map(([set, entry]) => {
        const parts = [
          ...(set === '1' && includeTag ? [`tagged ${includeTag}`] : []),
          ...(set === '1' && excludeTag ? [`not tagged ${excludeTag}`] : []),
          ...(set === '1' && nameExcludes.length > 0 ? [`name not containing ${nameExcludes.join(', ')}`] : []),
          ...entry.rules.map((r) => (r.rule === 'relationship' ? `${r.key} of an object whose name ${r.op} ${r.value}` : `${r.rule} ${r.rule === 'name' ? '' : `${r.key} `}${r.op} ${r.value}`)),
        ];
        return `Set ${set}: ${kindLabel(entry.kind)}${parts.length > 0 ? ` — ${parts.join('; ')}` : ' — every one'}.`;
      });

      return {
        platform: PLATFORM,
        title: `${groupName} — the scope an automation may act on`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Nothing. A group does not act; it decides what may be acted on.' },
        scope: {
          what: `${kindLabel(kindValue)}${includeTag ? ` tagged ${includeTag}` : ''}${excludeTag ? `, never those tagged ${excludeTag}` : ''}${sets.size > 1 ? `, or anything matching the other ${sets.size - 1} criteria set(s)` : ''}.`,
          decidedBy: [
            ...decided,
            ...(sets.size > 1 ? ['An object matching any one set is a member.'] : []),
            ...(includes.length > 0 ? [`Always in: ${includes.map((row) => row[1]).join(', ')}.`] : []),
            ...(excludes.length > 0 ? [`Always out: ${excludes.map((row) => row[1]).join(', ')}.`] : []),
          ],
          ifWrong: 'Every automation scoped to this group inherits the mistake at once. This is the single object worth reviewing twice.',
        },
        guardrails: [
          ...(excludeTag ? [{ rule: `Anything tagged ${excludeTag} is out`, because: 'Somebody needs a way to take one object out of an automation at speed without editing the automation.' }] : []),
          ...(nameExcludes.length > 0 ? [{ rule: `Names containing ${nameExcludes.join(', ')} are out`, because: 'A crude second net, deliberately. Tags get removed by accident; a naming convention rarely does.' }] : []),
          ...(excludes.length > 0 ? [{ rule: `${excludes.length} object(s) always excluded`, because: 'The ones that must never be touched, named rather than inferred.' }] : []),
          ...(autoResolve ? [{ rule: 'Membership resolves automatically', because: 'A group with fixed members drifts out of date silently, which is the other way scope goes wrong.' }] : [{ rule: 'Membership is a snapshot', because: 'Chosen on purpose: re-apply to refresh it.' }]),
        ],
        dryRun: [
          'Run apply.sh --dry-run: it resolves the policy, type and static objects and prints the group body.',
          'After applying it prints the member count. Open the group and read the member list before any automation points at it; if the count is not within an order of magnitude of what you expected, look again.',
        ],
        undo: ['DELETE /suite-api/api/resources/groups/{id}. Deleting a group does not touch its members.'],
        told: ['Nobody. A group is configuration; it is the automations pointed at it that act.'],
        requires: [`The policy "${policy}".`, ...(includes.length + excludes.length > 0 ? ['The statically included and excluded objects, with unique names.'] : [])],
        files: {
          [`${base}.json`]: `${JSON.stringify(payload, null, 2)}\n`,
          'apply.sh': apply,
          'import/custom-group.json': groupExport,
          ...contentPackage({ 'customgroups.json': groupExport }, { customGroups: 1 }),
          'import-content.sh': contentImportScript({ what: `the custom group "${groupName}"`, contentType: 'CUSTOM_GROUPS', needles: [`"name": ${JSON.stringify(groupName)}`, `"name":${JSON.stringify(groupName)}`] }),
          'IMPORT.md': importMd({
            title: `the custom group "${groupName}"`,
            steps: [
              { heading: 'By the REST API', files: [`${base}.json`, 'apply.sh'], how: ['./apply.sh (add --dry-run first to preview) — looks up the policy, group type and static objects, then POST (or PUT, for a group of the same name) /suite-api/api/resources/groups. This route sets the policy and the static members too.'] },
              {
                heading: 'Or: the group, as a file',
                files: ['import/custom-group.json'],
                how: [
                  'Inventory → Custom Groups → ⋯ → Import (8.x: Environment → Custom Groups → gear → Import Custom Group(s)), and choose import/custom-group.json — {"customGroups": [...]} in the shape the interface exports, one rule group per criteria set.',
                  `Then open the group, check the member count, and set its policy to "${policy}" (the export shape has no policy and no static members).`,
                ],
                verify: [
                  'the name rules are written as ruleType "ResourceNameRule"; the tag rules on summary|tag as a StringMetricPropertyRule, the type real exports use.',
                  ...(criteria.some((row) => /^(tag|relationship)$/i.test(row[2] ?? '')) ? ['ResourceTagRule and RelationshipRule are not in the exports this was checked against; if the import drops them, use apply.sh.'] : []),
                ],
              },
              contentStep('CUSTOM_GROUPS'),
            ],
            sources: FORMAT_SOURCES,
          }),
        },
        notes: [
          `Put the group on "${policy}" rather than the default policy. A group on the default policy gets the same thresholds as everything else, which makes the group pointless.`,
          'Tag conditions on summary|tag read vSphere tags. The tag has to be assigned in vCenter, and the adapter has to have collected since. A tag rule (Rule "tag") uses the 9.x tag condition, by category and value.',
          'Operators: EQ, NOT_EQ, LT, LT_EQ, GT, GT_EQ for numbers; EQ, NOT_EQ, CONTAINS, NOT_CONTAINS, STARTS_WITH, NOT_STARTS_WITH, ENDS_WITH, NOT_ENDS_WITH, REGEX, NOT_REGEX for text.',
          'VERIFY: the NSX, Supervisor, VKS and VCF object kinds are the keys their integrations publish; check them with GET /suite-api/api/adapterkinds/{adapter kind}/resourcekinds.',
        ],
        findings,
      };
    },
  }),

  automationBlueprint({
    id: 'vcfops_reclaim_schedule',
    platform: PLATFORM,
    label: 'Reclaim idle and oversized VMs on a schedule',
    group: 'Automation Central',
    description:
      'The reclamation most estates talk about and few turn on: old snapshots, long powered-off VMs, oversized VMs. Generated as a script rather than a job, because the guardrails that matter — a cap on how much one run may touch, a list read before anything acts — are only real if something enforces them. The script does; Automation Central has no per-run cap.',
    inputs: [
      { id: 'job_name', label: 'Job name', control: 'text', default: 'Monthly reclamation' },
      {
        id: 'what',
        label: 'What to reclaim',
        control: 'select',
        options: [
          { value: 'snapshots', label: 'Delete snapshots older than N days' },
          { value: 'powered-off', label: 'Delete VMs powered off for N days' },
          { value: 'oversized', label: 'List oversized VMs (report only)' },
        ],
        default: 'snapshots',
      },
      { id: 'older_than', label: 'Older than (days)', control: 'number', default: 30, min: 1, max: 365, showWhen: { input: 'what', equals: ['snapshots', 'powered-off'] } },
      { id: 'group_name', label: 'Only within group', control: 'text', default: 'Automation — safe to act on' },
      { id: 'max_objects', label: 'Never touch more than (objects per run)', control: 'number', default: 25, min: 1, max: 500 },
      { id: 'window', label: 'Run at', control: 'text', default: 'Sunday 02:00', hint: 'Day and 24-hour time, in the time zone of the host that runs it. Outside the change freeze, inside the maintenance window' },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const jobName = str(values, 'job_name', 'Reclamation');
      const what = str(values, 'what', 'snapshots');
      const olderThan = num(values, 'older_than', 30);
      const group = str(values, 'group_name', 'Automation — safe to act on');
      const cap = num(values, 'max_objects', 25);
      const window = str(values, 'window', 'Sunday 02:00');
      const base = slugOf(name || jobName, 'reclaim');

      interface Spec {
        readonly title: string;
        readonly effect: 'irreversible' | 'read';
        readonly undo: string[];
        readonly query: string;
        /** The stat that decides, and whether its key is one the script can default. */
        readonly statKey: string;
        readonly statNote: string;
        readonly threshold: number;
        readonly requireOff: boolean;
        readonly action: string;
      }
      const WHAT: Record<string, Spec> = {
        snapshots: {
          title: `delete snapshots older than ${olderThan} days`,
          effect: 'irreversible',
          undo: ['A deleted snapshot cannot be restored. What it protected is gone with it.', 'The only real undo is a backup of the VM taken before the run.'],
          query: `the stat Disk Space|Snapshot|Age (Days) is ${olderThan} or more`,
          statKey: 'diskspace|snapshot|age',
          statNote: 'VERIFY: the key of "Disk Space|Snapshot|Age (Days)". Check it with GET /suite-api/api/resources/{id}/statkeys on one VM that has a snapshot.',
          threshold: olderThan,
          requireOff: false,
          action: 'Delete Unused Snapshots for VM',
        },
        'powered-off': {
          title: `delete VMs powered off for more than ${olderThan} days`,
          effect: 'irreversible',
          undo: ['Restore from backup. There is no other way back.'],
          query: `powered off now (sys|poweredOn is 0), and a powered-off-duration stat of ${olderThan * 1440} minutes or more`,
          statKey: '',
          statNote: 'REQUIRED: VCF Operations has no built-in "powered off for N days" metric. Create a super metric that counts minutes powered off (reset when sys|poweredOn is 1) and set STAT_KEY to its key. It only counts from the day it is created.',
          threshold: olderThan * 1440,
          requireOff: true,
          action: 'Delete Powered Off VM',
        },
        oversized: {
          title: 'list oversized VMs',
          effect: 'read',
          undo: ['Nothing to undo. It lists; it does not resize.'],
          query: 'the stat summary|oversized is 1',
          statKey: 'summary|oversized',
          statNote: 'VERIFY: the key of the Oversized flag on a VM, with GET /suite-api/api/resources/{id}/statkeys.',
          threshold: 1,
          requireOff: false,
          action: '',
        },
      };
      const spec = WHAT[what] ?? WHAT['snapshots']!;
      const acts = spec.effect !== 'read';

      const findings: Finding[] = [];
      if (acts && cap > 100) {
        findings.push(
          warning('vcfops.reclaim.cap', `A cap of ${cap} objects in one run is high for something that cannot be undone.`, {
            remediation: 'The cap exists so that a wrong scope is a small incident rather than a large one. Twenty-five is a sensible first number.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (what === 'powered-off' && olderThan < 30) {
        findings.push(
          warning('vcfops.reclaim.hasty', `Deleting VMs powered off for only ${olderThan} days will catch machines somebody turned off on purpose last month.`, {
            remediation: 'Ninety days is the number most estates settle on, with a move-to-folder phase first.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (what === 'powered-off') {
        findings.push(
          info('vcfops.reclaim.no-off-metric', 'How long a VM has been powered off is not a built-in metric, so this needs a super metric before it can find anything.', {
            remediation: 'Create the super metric, let it run past the threshold, and only then schedule this. Until it has, every VM looks recently powered off.',
            source: 'ArchToolKit',
          }),
        );
      }

      const cron = cronOf(window);
      const script = [
        '#!/usr/bin/env bash',
        `# ${jobName}: ${spec.title}, within the custom group "${group}".`,
        '#',
        acts
          ? `# Run it and it acts on at most ${cap} of them, largest first, through the VCF Operations action API, and writes what it sent to a log. With --dry-run it only lists what it would act on and changes nothing.`
          : '# Reads only. It lists; there is no --execute.',
        '#',
        '# Scope is the group members, filtered by one stat. Members that do not report the stat are left out.',
        'set -euo pipefail',
        '',
        ...authPreamble(PLATFORM),
        `: "\${GROUP_ID:?set GROUP_ID to the id of the custom group \\"${group}\\"}"`,
        'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
        '',
        `MAX_OBJECTS=${cap}  # the cap. Change it here, in review, not on the command line.`,
        `THRESHOLD=${spec.threshold}`,
        `# ${spec.statNote}`,
        spec.statKey ? `STAT_KEY="\${STAT_KEY:-${spec.statKey}}"` : ': "${STAT_KEY:?set STAT_KEY to the key of your powered-off-duration super metric, in minutes}"',
        `REQUIRE_OFF=${spec.requireOff}`,
        'LOG_DIR="${LOG_DIR:-.}"',
        '',
        ...(acts ? ['EXECUTE=1', '[[ "${1:-}" == "--dry-run" ]] && EXECUTE=0'] : ['EXECUTE=0']),
        ...(acts ? [] : ['[[ "${1:-}" == "--execute" ]] && { echo "This one is report only." >&2; exit 2; }']),
        '',
        'api() {',
        '  local method="$1" path="$2"; shift 2',
        `  curl -sS -f -X "$method" "https://\${VCFOPS_HOST}\${path}" -H "${authHeader(PLATFORM)}" -H "Accept: application/json" "$@"`,
        '}',
        '',
        'members=$(api GET "/suite-api/api/resources/groups/${GROUP_ID}/members?pageSize=10000" |',
        `  jq -c '[.resourceList[]? | select(.resourceKey.resourceKindKey == "VirtualMachine") | {id: .identifier, name: .resourceKey.name}]')`,
        'if [[ "$(jq length <<<"$members")" == 0 ]]; then',
        '  echo "The group has no VM members. Nothing to do."',
        '  exit 0',
        'fi',
        '',
        'stats=$(jq -n --argjson m "$members" --arg k "$STAT_KEY" \'{resourceId: [$m[].id], statKey: [$k, "sys|poweredOn"], maxSamples: 1}\' |',
        '  api POST /suite-api/api/resources/stats/latest/query -H "Content-Type: application/json" --data @-)',
        '',
        'candidates=$(jq -c --argjson m "$members" --arg k "$STAT_KEY" --argjson t "$THRESHOLD" --argjson off "$REQUIRE_OFF" \'',
        '  ($m | map({(.id): .name}) | add) as $names',
        '  | [ .values[]?',
        '      | .resourceId as $id',
        '      | ([."stat-list".stat[]? | {(.statKey.key): ((.data // []) | last)}] | add // {}) as $s',
        '      | {id: $id, name: $names[$id], value: $s[$k], on: $s["sys|poweredOn"]}',
        '      | select(.value != null and .value >= $t)',
        '      | select(($off | not) or .on == 0) ]',
        '  | sort_by(-.value)\' <<<"$stats")',
        '',
        'total=$(jq length <<<"$candidates")',
        'echo "${total} of the group\'s VMs match (${STAT_KEY} >= ${THRESHOLD})."',
        'jq -r \'.[] | "  \\(.value)\\t\\(.name)\\t\\(.id)"\' <<<"$candidates"',
        ...(acts
          ? [
              'selected=$(jq -c --argjson n "$MAX_OBJECTS" \'.[:$n]\' <<<"$candidates")',
              'if (( total > MAX_OBJECTS )); then',
              '  echo "WARNING: ${total} match; only the first ${MAX_OBJECTS} would be acted on. The rest wait for the next run." >&2',
              'fi',
              '',
              'if (( ! EXECUTE )); then',
              '  if [[ -n "${ACTION_ID:-}" && "$total" != 0 ]]; then',
              '    echo "What the action would be sent for the first of them (populated, not run):"',
              '    jq -n --arg id "$(jq -r \'.[0].id\' <<<"$selected")" \'{contextResourceId: [$id]}\' |',
              '      api POST "/suite-api/api/actions/${ACTION_ID}/query" -H "Content-Type: application/json" --data @- | jq \'.actionExecution // .["action-execution"]\'',
              '  fi',
              '  echo "Dry run: nothing was changed. Read the list in full, then run it without --dry-run to apply."',
              '  exit 0',
              'fi',
              '',
              `: "\${ACTION_ID:?set ACTION_ID: GET /suite-api/api/actiondefinitions and take the id of the action named like \\"${spec.action}\\"}"`,
              'LOG="${LOG_DIR}/reclaim-$(date +%Y%m%d-%H%M%S).log"',
              'for id in $(jq -r \'.[].id\' <<<"$selected"); do',
              '  body=$(jq -n --arg id "$id" \'{contextResourceId: [$id]}\' |',
              '    api POST "/suite-api/api/actions/${ACTION_ID}/query" -H "Content-Type: application/json" --data @- |',
              '    jq -c \'.actionExecution // .["action-execution"]\')',
              '  if [[ -z "$body" || "$body" == null ]]; then',
              '    echo "The action could not be populated for ${id}; stopping here." >&2',
              '    exit 1',
              '  fi',
              '  echo "$(date -u +%FT%TZ) send ${id} ${body}" >>"$LOG"',
              '  task=$(api POST "/suite-api/api/actions/${ACTION_ID}" -H "Content-Type: application/json" --data "$body" | jq -r \'.values[]?\')',
              '  echo "$(date -u +%FT%TZ) ${id} task ${task}" | tee -a "$LOG"',
              'done',
              'echo "Done. Check each task with GET /suite-api/api/actions/{taskId}/status; the log is ${LOG}."',
            ]
          : ['(( total > 0 )) && exit 1', 'exit 0']),
        '',
      ].join('\n');

      const crontab = [
        `# ${jobName}. Written enabled: the line below is active once installed.`,
        `# Fill in GROUP_ID${acts ? ' and ACTION_ID' : ''}${spec.statKey ? '' : ' and STAT_KEY'} before installing it. Cron runs in the host's time zone.`,
        '# No secret here: the script logs in from the password file.',
        `${cron} ${scheduledEnv(PLATFORM)} GROUP_ID=<id>${acts ? ' ACTION_ID=<id>' : ''}${spec.statKey ? '' : ' STAT_KEY=<key>'} LOG_DIR=/var/log/vcf-automation /opt/vcf-automation/${base}.sh >>/var/log/vcf-automation/${base}.log 2>&1`,
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `${jobName} — ${spec.title}`,
        effect: spec.effect,
        trigger: { kind: 'schedule', detail: `${window}, from cron on the host that runs it`, worstCase: acts ? `once a week, up to ${cap} objects each time` : 'once a week, a list' },
        scope: {
          what: `VMs in the custom group "${group}" where ${spec.query}.`,
          decidedBy: [
            `Membership of the custom group "${group}", read at the start of each run.`,
            `The stat: ${spec.query}. A VM that does not report it is left out.`,
            ...(acts ? [`The cap: at most ${cap} objects in any one run, largest value first.`] : []),
            ...(acts ? [`What the action "${spec.action}" does with the parameters VCF Operations populates for it — the dry run prints them.`] : []),
          ],
          ifWrong: acts
            ? `Up to ${cap} objects are destroyed per run, and they do not come back. This is why the cap is in the script.`
            : 'A wrong list, read by somebody who then acts on it by hand.',
        },
        guardrails: [
          ...(acts
            ? [
                { rule: `At most ${cap} objects in one run, enforced by the script`, because: 'A wrong scope with a cap is an incident; a wrong scope without one is an outage.' },
                { rule: 'It prints the full list before it acts, and --dry-run stops there', because: 'The list it prints is the only place a wrong scope is visible before it acts.' },
                { rule: 'Stops at the first object the action cannot be populated for', because: 'An action that does not fit one VM is a sign it does not fit the rest.' },
              ]
            : [{ rule: 'It only reads', because: 'Resizing is a change a person makes from this list, not something a schedule does.' }]),
          ...(spec.requireOff ? [{ rule: 'Powered off now, as well as for long enough', because: 'A super metric that has stopped updating still says ninety days. The live power state is the second check.' }] : []),
          { rule: 'VMs that do not report the stat are left out', because: 'A missing number is not a zero, and it is not a match either.' },
        ],
        dryRun: [
          'Run the script with --dry-run. It prints every match with its value, and, if ACTION_ID is set, the action body it would send for the first.',
          'Read the list in full — not the count, the list.',
          'Expect to find something in it that should not be. That is what the exclusion tag on the group is for.',
        ],
        undo: spec.undo,
        told: acts
          ? ['The script writes each object and the task id it started to a log in LOG_DIR.', 'Wire the log or the cron mail somewhere a person reads — a run log nobody reads is not a record.']
          : ['Whoever reads the cron output. It exits 1 when it finds anything, so a scheduler can alert on that.'],
        requires: [
          `The custom group "${group}" to exist and to be narrower than you first think, and its id in GROUP_ID.`,
          'jq, curl, and VCFOPS_USER with VCFOPS_PASSWORD_FILE for the scheduled run.',
          ...(acts ? [`The action "${spec.action}" (name as in your release — verify it) enabled, with a vCenter account that has the rights to do this and no more.`] : []),
          ...(spec.statKey ? [] : ['A super metric that measures how long a VM has been powered off.']),
        ],
        files: {
          [`${base}.sh`]: script,
          'crontab.txt': crontab,
          'IMPORT.md': nothingToImportMd(jobName, [
            `${base}.sh goes on a host of your own (in /usr/local/bin) and crontab.txt in the service account's crontab — it is a script run against the API, not content VCF Operations imports.`,
            'The script acts when run; add --dry-run first to list what it would act on and stop. The crontab line is written active.',
          ]),
        },
        notes: [
          'Reclamation is where automation earns its keep and where it does the most damage. Both facts are about the same property: it acts on many objects at once.',
          `Scope comes from ${spec.statKey ? `the stat ${spec.statKey}` : 'STAT_KEY'}. ${spec.statNote}`,
          ...(acts ? ['The action body is whatever POST /suite-api/api/actions/{id}/query populates for each VM, sent back unchanged. If the populated parameters are not what you expect — which snapshots, which age — this script is not right for your release; stop and use the interface.'] : []),
          'Automation Central in the interface has a Reclaim job that does the same on a schedule, with a preview of the affected VMs. It has no per-run cap, which is why this is a script.',
          'Orphaned disks are not here: there is no documented suite-API call that lists them. Use the Reclaim page in the interface.',
          'The account the action runs as decides what is actually possible. Give it exactly the rights for this job rather than an administrator, and the blast radius is bounded by vCenter as well as by the cap.',
        ],
        findings,
      };
    },
  }),

  automationBlueprint({
    id: 'vcfops_maintenance_window',
    platform: PLATFORM,
    label: 'Silence alerts during a maintenance window',
    group: 'Automation Central',
    description:
      'A one-off, daily, weekly or monthly maintenance window in a named time zone — either as a maintenance schedule taken up through a policy, or by putting the group’s members into maintenance through the API for exactly the length of the window, from cron — plus the thing people forget: the check that it actually ended. A window that never closes is an estate with no alerting and nobody aware of it.',
    inputs: [
      { id: 'window_name', label: 'Window name', control: 'text', default: 'Monthly patching' },
      { id: 'group_name', label: 'Applies to group', control: 'text', default: 'Production hosts' },
      {
        id: 'method',
        label: 'How',
        control: 'select',
        options: [
          { value: 'schedule', label: 'A maintenance schedule, through a policy' },
          { value: 'api', label: 'The group’s members into maintenance by API, from cron' },
        ],
        default: 'schedule',
      },
      { id: 'policy_name', label: 'Through the policy', control: 'text', default: 'Production hosts — maintenance', hint: 'A maintenance schedule takes effect only as part of a policy, on every object that policy covers', showWhen: { input: 'method', equals: ['schedule'] } },
      {
        id: 'recurrence',
        label: 'Repeats',
        control: 'select',
        options: [
          { value: 'MONTHLY', label: 'Monthly, on a week and weekday' },
          { value: 'WEEKLY', label: 'Weekly' },
          { value: 'DAILY', label: 'Daily' },
          { value: 'ONCE', label: 'Once' },
        ],
        default: 'MONTHLY',
      },
      {
        id: 'week',
        label: 'Week of the month',
        control: 'select',
        options: [
          { value: 'FIRST', label: 'First' },
          { value: 'SECOND', label: 'Second' },
          { value: 'THIRD', label: 'Third' },
          { value: 'FOURTH', label: 'Fourth' },
          { value: 'LAST', label: 'Last' },
        ],
        default: 'THIRD',
        showWhen: { input: 'recurrence', equals: ['MONTHLY'] },
      },
      {
        id: 'weekday',
        label: 'Day',
        control: 'select',
        options: ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'].map((day) => ({ value: day, label: day.charAt(0) + day.slice(1).toLowerCase() })),
        default: 'SATURDAY',
        showWhen: { input: 'recurrence', equals: ['MONTHLY', 'WEEKLY'] },
      },
      { id: 'date', label: 'Date', control: 'text', default: '2026-11-21', hint: 'YYYY-MM-DD', showWhen: { input: 'recurrence', equals: ['ONCE'] } },
      { id: 'start_time', label: 'Starts at', control: 'text', default: '22:00', hint: '24-hour HH:MM' },
      {
        id: 'timezone',
        label: 'Time zone',
        control: 'combo',
        options: ['UTC', 'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Kolkata', 'Australia/Sydney'].map((zone) => ({ value: zone, label: zone })),
        default: 'UTC',
      },
      { id: 'hours', label: 'Length (hours)', control: 'number', default: 6, min: 1, max: 24 },
      { id: 'max_objects', label: 'Refuse if the group has more than (objects)', control: 'number', default: 200, min: 1, max: 10000, showWhen: { input: 'method', equals: ['api'] } },
      { id: 'alert_on_overrun', label: 'Raise an alert if it has not ended', control: 'toggle', default: true },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const windowName = str(values, 'window_name', 'Maintenance');
      const group = str(values, 'group_name', 'Production hosts');
      const method = str(values, 'method', 'schedule');
      const policy = str(values, 'policy_name', 'Production hosts — maintenance');
      const recurrence = str(values, 'recurrence', 'MONTHLY');
      const week = str(values, 'week', 'THIRD');
      const weekday = str(values, 'weekday', 'SATURDAY');
      const date = str(values, 'date', '');
      const startTime = str(values, 'start_time', '22:00');
      const timezone = str(values, 'timezone', 'UTC');
      const hours = num(values, 'hours', 6);
      const cap = num(values, 'max_objects', 200);
      const overrun = bool(values, 'alert_on_overrun', true);
      const base = slugOf(name || windowName, 'maintenance-window');
      const viaApi = method === 'api';

      const time = /^(\d{1,2}):(\d{2})$/.exec(startTime);
      const hour = time ? Number(time[1]) : 0;
      const minute = time ? Number(time[2]) : 0;
      const findings: Finding[] = [];
      if (!overrun) {
        findings.push(
          error('vcfops.window.no-overrun-check', 'Nothing will tell you if this maintenance window fails to end.', {
            remediation: 'A window that stays open is an estate with alerting switched off and no symptom. Turn the overrun check on.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (hours > 12) {
        findings.push(
          warning('vcfops.window.long', `A ${hours}-hour window is a long time to be blind.`, {
            remediation: 'Consider two shorter windows rather than one long one, so the estate is watched between them.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (!time || hour > 23 || minute > 59) findings.push(error('vcfops.window.bad-time', `"${startTime}" is not a 24-hour HH:MM time.`, { source: 'ArchToolKit' }));
      if (recurrence === 'ONCE' && !/^\d{4}-\d{2}-\d{2}$/.test(date)) findings.push(error('vcfops.window.bad-date', `"${date}" is not a YYYY-MM-DD date.`, { source: 'ArchToolKit' }));
      if (recurrence === 'DAILY' && hours > 8) findings.push(warning('vcfops.window.daily-long', `${hours} hours every day is a third of the estate’s life without alerting.`, { source: 'ArchToolKit' }));
      if (viaApi && recurrence === 'MONTHLY' && week === 'LAST') findings.push(info('vcfops.window.last-week', 'Cron has no "last weekday of the month"; the crontab line runs on days 22–31 and checks that a week later is next month.', { source: 'ArchToolKit' }));

      const when =
        recurrence === 'ONCE' ? `${date} ${startTime}` : recurrence === 'DAILY' ? `every day at ${startTime}` : recurrence === 'WEEKLY' ? `every ${weekday.toLowerCase()} at ${startTime}` : `the ${week.toLowerCase()} ${weekday.toLowerCase()} of every month at ${startTime}`;

      // Fields as documented for the maintenance-schedule and schedule data structures.
      const schedule = {
        key: windowName,
        schedule: {
          scheduleType: recurrence,
          ...(recurrence === 'MONTHLY' ? { months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], weeksOfTheMonth: [week], daysOfTheWeek: [weekday] } : {}),
          ...(recurrence === 'WEEKLY' ? { daysOfTheWeek: [weekday], recurrence: 1 } : {}),
          ...(recurrence === 'DAILY' ? { recurrence: 1 } : {}),
          ...(recurrence === 'ONCE' ? { startDate: date } : {}),
          hour,
          minuteOfTheHour: minute,
          duration: hours * 60,
          timeZone: timezone,
        },
      };

      // cron for the API method: the start, in the window's own time zone.
      const DOW: Record<string, number> = { SUNDAY: 0, MONDAY: 1, TUESDAY: 2, WEDNESDAY: 3, THURSDAY: 4, FRIDAY: 5, SATURDAY: 6 };
      const DAYS: Record<string, string> = { FIRST: '1-7', SECOND: '8-14', THIRD: '15-21', FOURTH: '22-28', LAST: '22-31' };
      const dow = DOW[weekday] ?? 6;
      const [year, month, day] = date.split('-').map(Number);
      const startCron =
        recurrence === 'ONCE' ? `${minute} ${hour} ${day ?? 1} ${month ?? 1} *` : recurrence === 'DAILY' ? `${minute} ${hour} * * *` : recurrence === 'WEEKLY' ? `${minute} ${hour} * * ${dow}` : `${minute} ${hour} ${DAYS[week] ?? '15-21'} * *`;
      const guard =
        recurrence === 'MONTHLY'
          ? `[ "$(date +\\%w)" = ${dow} ]${week === 'LAST' ? ' && [ "$(date -d +7days +\\%m)" != "$(date +\\%m)" ]' : ''} && `
          : recurrence === 'ONCE'
            ? `[ "$(date +\\%Y)" = ${year ?? 2026} ] && `
            : '';

      const enter = opsScript({
        about: [
          `Put every member of the custom group "${group}" into maintenance for ${hours} hours,`,
          'through the API. VCF Operations takes each object out again when the duration ends.',
          `Refuses if the group has more than ${cap} members: a group that has grown is not a`,
          'maintenance window, it is an outage of the monitoring.',
        ],
        body: [
          `MAX=${cap}`,
          `MINUTES=${hours * 60}`,
          `GID=$(group_id ${sh(group)})`,
          'MEMBERS=$(api GET "resources/groups/${GID}/members?pageSize=10000" | jq -r \'[.resourceList[]? | .identifier] | .[]\')',
          'COUNT=$(grep -c . <<<"$MEMBERS" || true)',
          `if (( COUNT > MAX )); then echo "${group.replace(/"/g, '')} has \${COUNT} members, more than \${MAX}. Nothing was put into maintenance." >&2; exit 1; fi`,
          'echo "${COUNT} object(s) into maintenance for ${MINUTES} minutes."',
          'for id in $MEMBERS; do',
          '  if (( DRY_RUN )); then echo "DRY RUN: would PUT resources/${id}/maintained?duration=${MINUTES}"; continue; fi',
          '  api PUT "resources/${id}/maintained?duration=${MINUTES}" >/dev/null',
          'done',
        ],
        undo: 'DELETE /suite-api/api/resources/{id}/maintained for each object ends it early. Collection resumes; the gap is not replayed.',
      });

      const endHour = (hour + hours + 1) % 24;
      const checkAt = `${minute} ${endHour} * * *`;
      const check = readScript(PLATFORM, `Is anything still in maintenance that should not be? Run daily, an hour after "${windowName}" is due to end.`, [
        '# Every object VCF Operations has in maintenance right now, scheduled or manual.',
        '# This is estate-wide, not just this window: outside a window nothing should be',
        '# in maintenance, and anything that is has alerting off without a symptom.',
        'found=$(get "/suite-api/api/resources?resourceState=MAINTAINED&resourceState=MAINTAINED_MANUAL&pageSize=1000" |',
        '  jq -r \'.resourceList[]? | "\\(.resourceKey.resourceKindKey)\\t\\(.resourceKey.name)\\t\\(.identifier)"\')',
        'if [[ -n "$found" ]]; then',
        `  echo "WARNING: still in maintenance after \\"${windowName}\\" should have ended:" >&2`,
        '  echo "$found" >&2',
        '  echo "To end it for an object: DELETE /suite-api/api/resources/maintained?id=<identifier>" >&2',
        '  exit 1',
        'fi',
        'echo "Nothing is in maintenance."',
      ]);

      const scheduleApply = opsScript({
        about: [`Create the maintenance schedule "${windowName}" (${when}, ${timezone}, ${hours} hours), or update the one of the same name.`],
        body: [
          `EXISTING=$(api GET maintenanceschedules | jq -r --arg n ${sh(windowName)} '[.. | objects | select(.key? == $n) | (.id // .key)] | .[0] // empty')`,
          'if [[ -n "$EXISTING" ]]; then',
          `  jq --arg id "$EXISTING" '. + {id: $id}' "$HERE/${base}.json" | send PUT maintenanceschedules >/dev/null`,
          '  echo "Updated the schedule ${EXISTING}."',
          'else',
          `  jq . "$HERE/${base}.json" | send POST maintenanceschedules >/dev/null`,
          `  echo "Created the schedule ${windowName.replace(/"/g, '')}."`,
          'fi',
          `echo "Now attach it to the policy ${policy.replace(/"/g, '')}: see attach-to-policy.txt (no documented API call does this)."`,
        ],
        undo: 'remove it from the policy, or DELETE /suite-api/api/maintenanceschedules with its id.',
      });

      const cronFiles = [
        `# ${windowName}. Written active. Cron runs in CRON_TZ where the cron supports it (cronie does);`,
        '# otherwise in the host’s zone — make that the window’s zone. No secret here: the scripts log in from the password file.',
        `CRON_TZ=${timezone}`,
        ...(viaApi ? [`${startCron} ${guard}${scheduledEnv(PLATFORM)} /opt/vcf-automation/${base}/enter-maintenance.sh >>/var/log/vcf-automation/${base}.log 2>&1`] : []),
        ...(overrun ? [`${checkAt} ${scheduledEnv(PLATFORM)} /opt/vcf-automation/${base}/overrun-check.sh >>/var/log/vcf-automation/overrun-check.log 2>&1 || logger -t vcf-automation "maintenance overrun: ${windowName}"`] : []),
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `${windowName} — stop alerting on "${group}" for ${hours} hours, ${when} (${timezone})`,
        effect: 'reversible',
        trigger: { kind: 'schedule', detail: `${when} ${timezone}, for ${hours} hours${viaApi ? ', started by cron' : ''}`, worstCase: `${hours} hours ${recurrence === 'DAILY' ? 'a day' : recurrence === 'WEEKLY' ? 'a week' : recurrence === 'ONCE' ? 'once' : 'a month'} with no alerting and no collection on ${viaApi ? `up to ${cap} objects` : 'everything the policy covers'}` },
        scope: viaApi
          ? {
              what: `The members of the custom group "${group}" at the moment the window starts — at most ${cap}.`,
              decidedBy: [`Membership of "${group}", read when cron starts the window.`, `The cap: more than ${cap} members and nothing is put into maintenance.`],
              ifWrong: 'Collection and alerting are off for objects you did not mean to include, for the length of the window, and nothing reports that they are off.',
            }
          : {
              what: `Every object the policy "${policy}" covers, of the object type the schedule is set on in that policy — which should be exactly the group "${group}".`,
              decidedBy: [
                `The policy "${policy}": the schedule has no effect until it is part of a policy.`,
                `The groups that policy is assigned to — "${group}" and nothing else, if this is right.`,
                'The object type the schedule is selected on inside the policy.',
                'Policy priority: a higher-priority policy on the same object wins, and then this window does not apply to it.',
              ],
              ifWrong: 'Collection and alerting are off for objects you did not mean to include, for the length of the window, and nothing reports that they are off.',
            },
        guardrails: [
          { rule: `Bounded to ${hours} hours`, because: 'A maintenance window with no end is the commonest way an estate ends up unmonitored for a month.' },
          ...(viaApi ? [{ rule: `Refuses a group of more than ${cap} objects`, because: 'A scope group that has quietly grown should not take the monitoring of the estate with it.' }] : []),
          ...(overrun ? [{ rule: 'A daily check exits 1 if anything is still in maintenance', because: 'This is the only symptom of a window that stuck open. Without it, nothing is wrong and nothing is watching.' }] : []),
        ],
        dryRun: [
          viaApi ? 'Run enter-maintenance.sh --dry-run: it reads the group and lists each object it would put into maintenance.' : 'Run apply.sh --dry-run; it prints what it would send.',
          ...(viaApi ? [] : [`After attaching it to "${policy}", open two or three objects in "${group}" and check that the policy shown is "${policy}" — then one object outside the group, to check it is not.`]),
        ],
        undo: [
          viaApi ? 'Remove the crontab line. To end a window early: DELETE /suite-api/api/resources/{id}/maintained for each object.' : 'Remove the schedule from the policy, or delete it: DELETE /suite-api/api/maintenanceschedules with its id, or Delete under Maintenance Schedules in the interface.',
          'Collection resumes when maintenance ends; what happened during the window was not collected and is not replayed.',
        ],
        told: overrun ? ['Whoever reads the overrun check’s output. It exits 1, so the scheduler that runs it can alert. Send it somewhere a human reads at the weekend, because that is when this runs.'] : ['Nobody. Consider turning the overrun check on.'],
        requires: [`The custom group "${group}".`, ...(viaApi ? ['A host with cron, curl and jq, and VCFOPS_USER with VCFOPS_PASSWORD_FILE.'] : [`A policy "${policy}" assigned to that group and nothing else.`])],
        files: {
          'IMPORT.md': importMd({
            title: `the maintenance window "${windowName}"`,
            steps: viaApi
              ? [{ heading: 'The start, from cron', files: ['enter-maintenance.sh', 'crontab.txt'], how: [`enter-maintenance.sh (and overrun-check.sh) in /opt/vcf-automation/${base} on a host of your own, crontab.txt in its crontab. Nothing is imported: the objects are put into maintenance with PUT /suite-api/api/resources/{id}/maintained?duration=<minutes>.`] }]
              : [
                  { heading: 'The schedule', files: [`${base}.json`, 'apply.sh'], how: ['./apply.sh (add --dry-run first to preview) — POST (or PUT, for one of the same name) /suite-api/api/maintenanceschedules. There is no file import for maintenance schedules.'] },
                  { heading: 'Attach it to the policy', files: ['attach-to-policy.txt'], how: [`In the interface, as attach-to-policy.txt says: the schedule takes effect only through "${policy}", and no documented API call attaches it.`] },
                  ...(overrun ? [{ heading: 'The overrun check', files: ['overrun-check.sh', 'crontab.txt'], how: ['overrun-check.sh in /opt/vcf-automation on a host of your own, crontab.txt in its crontab. It only reads.'] }] : []),
                ],
          }),
          ...(viaApi
            ? { 'enter-maintenance.sh': enter }
            : {
                [`${base}.json`]: `${JSON.stringify(schedule, null, 2)}\n`,
                'apply.sh': scheduleApply,
                'attach-to-policy.txt': [
                  `Attach "${windowName}" to "${policy}" — in the interface; there is no documented API call for this step.`,
                  '',
                  '1. Infrastructure Operations → Configurations → Maintenance Schedules: check the schedule is listed with the right day, time, length and time zone.',
                  `2. Infrastructure Operations → Configurations → Policies: open "${policy}" for editing.`,
                  `3. Select the object type the objects in "${group}" are, and set its maintenance schedule to "${windowName}".`,
                  `4. Check the policy is assigned to "${group}" and to nothing else, and that no higher-priority policy covers the same objects.`,
                  '5. Save. The window applies from its next start.',
                  '',
                ].join('\n'),
              }),
          ...(overrun ? { 'overrun-check.sh': check } : {}),
          ...(viaApi || overrun ? { 'crontab.txt': cronFiles } : {}),
        },
        notes: [
          'Maintenance does more than silence alerts: while an object is in maintenance VCF Operations stops collecting from it and cancels its active alerts. The morning after, there is a gap in the charts, not a queue of suppressed alerts.',
          ...(viaApi
            ? ['The API method needs no policy and applies to exactly the group’s members at the start of each window; it depends on the cron host being up at that moment.']
            : [`VERIFY: the payload is written with scheduleType ${recurrence}${recurrence === 'MONTHLY' ? ', weeksOfTheMonth and daysOfTheWeek' : ''} and timeZone ${timezone}. After applying, read the schedule back in the interface and check it says what you meant.`]),
          'A maintenance window stops alerting. It does not stop an automation firing — check whether anything scheduled overlaps it.',
        ],
        findings,
      };
    },
  }),

  automationBlueprint({
    id: 'vcfops_capacity_report',
    platform: PLATFORM,
    label: 'Email a capacity report on a schedule',
    group: 'Reporting',
    description:
      'The safest automation there is, and the one most often left undone: a report that actually arrives. Daily, weekly (on chosen days), monthly (on a day of the month) or quarterly, every N periods, at a set time, for an object or a custom group, through a named outbound email instance. The script looks the report definition, the object and the email instance up by name.',
    inputs: [
      { id: 'report_name', label: 'Report definition', control: 'text', default: 'Cluster capacity' },
      { id: 'recipients', label: 'Send to', control: 'text', default: 'platform-team@example.com', hint: 'A team address. A person’s mailbox stops working the week they change role' },
      {
        id: 'cadence',
        label: 'How often',
        control: 'select',
        options: [
          { value: 'daily', label: 'Daily' },
          { value: 'weekly', label: 'Weekly' },
          { value: 'monthly', label: 'Monthly' },
          { value: 'quarterly', label: 'Quarterly' },
        ],
        default: 'monthly',
      },
      { id: 'every', label: 'Every (periods)', control: 'number', default: 1, min: 1, max: 12, hint: 'Every 2 weeks, every 6 months …' },
      { id: 'weekdays', label: 'On', control: 'checklist', options: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'].map((day) => ({ value: day, label: day.charAt(0) + day.slice(1).toLowerCase() })), default: 'MONDAY', showWhen: { input: 'cadence', equals: ['weekly'] } },
      { id: 'day_of_month', label: 'Day of the month', control: 'number', default: 1, min: 1, max: 28, showWhen: { input: 'cadence', equals: ['monthly', 'quarterly'] } },
      { id: 'start_time', label: 'At (GMT)', control: 'text', default: '07:00', hint: 'HH:MM. Schedules made through the API run in GMT' },
      { id: 'start_date', label: 'First run on or after', control: 'text', default: '', hint: 'YYYY-MM-DD; empty for today' },
      {
        id: 'scope_kind',
        label: 'Run it for',
        control: 'select',
        options: [
          { value: 'object', label: 'An object (vSphere World, a vCenter, a cluster …)' },
          { value: 'group', label: 'A custom group' },
        ],
        default: 'object',
      },
      { id: 'scope_object', label: 'Object or group name', control: 'text', default: 'vSphere World' },
      { id: 'email_instance', label: 'Outbound email instance', control: 'text', default: '', hint: 'Its name; empty to use the default one' },
      { id: 'formats', label: 'Formats', control: 'text', default: 'pdf, csv' },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const reportName = str(values, 'report_name', 'Capacity');
      const recipients = listOf(str(values, 'recipients', ''));
      const cadence = str(values, 'cadence', 'monthly');
      const every = Math.max(1, num(values, 'every', 1));
      const weekdays = listOf(str(values, 'weekdays', 'MONDAY'));
      const dayOfMonth = num(values, 'day_of_month', 1);
      const startTime = str(values, 'start_time', '07:00');
      const startDate = str(values, 'start_date', '');
      const scopeKind = str(values, 'scope_kind', 'object');
      const scopeObject = str(values, 'scope_object', 'vSphere World');
      const emailInstance = str(values, 'email_instance', '');
      const formats = listOf(str(values, 'formats', 'pdf'));
      const base = slugOf(name || reportName, 'report-schedule');
      const time = /^(\d{1,2}):(\d{2})$/.exec(startTime);

      const findings: Finding[] = [];
      const personal = recipients.filter((address) => /^[a-z]+[._][a-z]/i.test(address.split('@')[0] ?? '') && !/(team|ops|support|alerts?|noc|group|dl|it-)/i.test(address));
      if (personal.length > 0) {
        findings.push(
          warning('vcfops.report.personal-mailbox', `${personal.join(', ')} looks like an individual rather than a team.`, {
            remediation: 'When that person changes role the report stops being read and nothing reports that it has. Send it to a distribution list.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (recipients.length === 0) {
        findings.push(error('vcfops.report.no-recipient', 'No recipients, so this report is generated and delivered to nobody.', { source: 'ArchToolKit' }));
      }
      if (!time || Number(time[1]) > 23 || Number(time[2]) > 59) findings.push(error('vcfops.report.bad-time', `"${startTime}" is not a 24-hour HH:MM time.`, { source: 'ArchToolKit' }));
      if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) findings.push(error('vcfops.report.bad-date', `"${startDate}" is not a YYYY-MM-DD date.`, { source: 'ArchToolKit' }));
      if (cadence === 'weekly' && weekdays.length === 0) findings.push(error('vcfops.report.no-day', 'A weekly schedule with no day never runs.', { source: 'ArchToolKit' }));
      if (cadence === 'daily' && every === 1) findings.push(info('vcfops.report.daily', 'A capacity report every day is read for a week and then filtered. Weekly is usually the useful rhythm.', { source: 'ArchToolKit' }));

      // Fields as documented for POST /api/reportdefinitions/{id}/schedules.
      const schedule = {
        reportDefinitionId: '<set by apply.sh from the report name>',
        resourceId: ['<set by apply.sh from the object or group name>'],
        reportScheduleType: cadence === 'daily' ? 'DAILY' : cadence === 'weekly' ? 'WEEKLY' : 'MONTHLY',
        recurrence: cadence === 'quarterly' ? 3 * every : every,
        ...(cadence === 'weekly' ? { daysOfTheWeek: weekdays } : {}),
        ...(cadence === 'monthly' || cadence === 'quarterly' ? { dayOfTheMonth: dayOfMonth } : {}),
        startDate: startDate || '<set by apply.sh: today>',
        startHour: time ? Number(time[1]) : 7,
        startMinute: time ? Number(time[2]) : 0,
        emailAddresses: recipients,
        ...(emailInstance ? { emailPluginId: `<set by apply.sh from the outbound instance "${emailInstance}">` } : {}),
      };

      const apply = opsScript({
        about: [
          `Schedule the report "${reportName}" for ${scopeObject}, ${cadence}, to ${recipients.join(', ') || 'nobody'}.`,
          'Schedules created through the API run in GMT, whatever the interface shows for',
          'schedules made by hand. The report, the object and the email instance are looked up by name;',
          'an existing schedule for the same object is reported and not duplicated (--again to add one anyway).',
        ],
        body: [
          'AGAIN=0; for arg in "$@"; do [[ "$arg" == --again ]] && AGAIN=1; done',
          `REPORT_ID=$(report_definition_id ${sh(reportName)})`,
          scopeKind === 'group' ? `RESOURCE_ID=$(group_id ${sh(scopeObject)})` : `RESOURCE_ID=$(resource_id ${sh(scopeObject)})`,
          emailInstance ? `PLUGIN_ID=$(plugin_id ${sh(emailInstance)})` : 'PLUGIN_ID=""',
          startDate ? `START=${sh(startDate)}` : 'START=$(date -u +%Y-%m-%d)',
          'if (( ! AGAIN )) && api GET "reportdefinitions/${REPORT_ID}/schedules" | jq -e --arg r "$RESOURCE_ID" \'[.. | objects | select((.resourceId? // []) | index($r))] | length > 0\' >/dev/null; then',
          `  echo "${reportName.replace(/"/g, '')} already has a schedule for ${scopeObject.replace(/"/g, '')}. Nothing was changed; run with --again to add another." >&2`,
          '  exit 1',
          'fi',
          `jq --arg d "$REPORT_ID" --arg r "$RESOURCE_ID" --arg p "$PLUGIN_ID" --arg s "$START" '.reportDefinitionId = $d | .resourceId = [$r] | .startDate = $s | (if $p != "" then .emailPluginId = $p else del(.emailPluginId) end)' "$HERE/${base}.json" |`,
          '  send POST "reportdefinitions/${REPORT_ID}/schedules" | jq -c \'{id}\'',
        ],
        undo: 'GET /suite-api/api/reportdefinitions/{id}/schedules to find the schedule id, then DELETE /suite-api/api/reportdefinitions/{id}/schedules/{scheduleId}.',
      });

      const period = cadence === 'daily' ? 'day' : cadence === 'weekly' ? 'week' : cadence === 'quarterly' ? 'quarter' : 'month';
      const whenText = `${every > 1 ? `every ${every} ${period}s` : `every ${period}`}${cadence === 'weekly' ? ` on ${weekdays.map((day) => day.charAt(0) + day.slice(1).toLowerCase()).join(', ')}` : ''}${cadence === 'monthly' || cadence === 'quarterly' ? ` on day ${dayOfMonth}` : ''}, at ${startTime} GMT`;

      return {
        platform: PLATFORM,
        title: `${reportName} — sent ${cadence} to ${recipients.join(', ') || 'nobody'}`,
        effect: 'read',
        trigger: { kind: 'schedule', detail: `${whenText} — schedules made through the API run in GMT`, worstCase: `once ${cadence === 'weekly' ? `on each of ${weekdays.length} day(s) a week` : `a ${period}`}` },
        scope: {
          what: `The report "${reportName}", run against the ${scopeKind === 'group' ? 'custom group' : 'object'} ${scopeObject}.`,
          decidedBy: ['The report definition itself and the views in it.', `The ${scopeKind === 'group' ? 'custom group' : 'object'} it is run for: ${scopeObject}.`],
          ifWrong: 'Somebody gets a report about the wrong part of the estate and, because it looks plausible, acts on it.',
        },
        guardrails: [
          { rule: 'It only reads', because: 'A report changes nothing. This is the one automation that is safe to turn on before you have thought about it.' },
          ...(recipients.length > 0 ? [{ rule: 'Goes to a named list', because: 'A scheduled report with no recipient is a file generated onto an appliance and deleted by retention.' }] : []),
          { rule: 'An existing schedule for the same object is not duplicated', because: 'Two schedules are two emails, and the second one teaches people to ignore both.' },
        ],
        dryRun: ['Run apply.sh --dry-run: it looks the names up and prints the schedule as it would be sent.', 'Run the report once by hand for the same object and read it. A report nobody has read once will not be read monthly.'],
        undo: [
          'GET /suite-api/api/reportdefinitions/{id}/schedules to find the schedule id, then DELETE /suite-api/api/reportdefinitions/{id}/schedules/{scheduleId}.',
          'Or delete it from the report definition’s schedules in the interface. Nothing else changes.',
        ],
        told: recipients.length > 0 ? [`${recipients.join(', ')}, ${whenText}.`] : ['Nobody, which makes this schedule pointless.'],
        requires: [
          `The report definition "${reportName}".`,
          `The ${scopeKind === 'group' ? 'custom group' : 'object'} "${scopeObject}", with a unique name. The API takes one per schedule.`,
          emailInstance ? `The outbound email instance "${emailInstance}".` : 'An outbound email instance, allowed through to your relay. With more than one, name it.',
        ],
        files: {
          [`${base}.json`]: `${JSON.stringify(schedule, null, 2)}\n`,
          'apply.sh': apply,
          'IMPORT.md': importMd({
            title: `the schedule for "${reportName}"`,
            steps: [
              { heading: 'The report definition', files: [], how: [`"${reportName}" has to exist first — import it with the report blueprint in this kit (its cover page, contents, footer, orientation and views are set on the definition), or use a built-in report.`] },
              { heading: 'The schedule', files: [`${base}.json`, 'apply.sh'], how: ['./apply.sh (add --dry-run first to preview) — looks the report, object and email instance up, then POST /suite-api/api/reportdefinitions/{id}/schedules. A schedule is not something VCF Operations imports from a file.'] },
            ],
          }),
        },
        notes: [
          `Formats: ${formats.join(', ')}. The schedule has no format field — formats are set on the report definition itself, so check them there. PDF is what people read; CSV is what they actually use, because the first thing anybody does with a capacity report is sort it.`,
          'The time is GMT. For a report that should land at 07:00 somewhere else, change the time, and remember that GMT does not move for daylight saving.',
          'Publishing to a network share is removed in VCF Operations 9.1; email is the delivery.',
          'VERIFY: dayOfTheMonth and emailPluginId are the schedule field names of recent releases; compare with GET /suite-api/api/reportdefinitions/{id}/schedules for a schedule made in the interface.',
        ],
        findings,
      };
    },
  }),

  automationBlueprint({
    id: 'vcfops_policy_toggle',
    platform: PLATFORM,
    label: 'Turn alert definitions on or off in a policy',
    group: 'Policy',
    description:
      'Where an alert that "should be firing" usually went. Generates the policy override that enables or disables a named set of alert definitions, with the current state recorded first so it can be put back exactly.',
    inputs: [
      { id: 'policy_name', label: 'Policy', control: 'text', default: 'Production Policy' },
      {
        id: 'direction',
        label: 'What to do',
        control: 'select',
        options: [
          { value: 'enable', label: 'Turn these alerts on' },
          { value: 'disable', label: 'Turn these alerts off' },
        ],
        default: 'enable',
      },
      { id: 'alert_ids', label: 'Alert definition ids', control: 'textarea', default: 'AlertDefinition-VMWARE-DatastoreUsage\nAlertDefinition-VMWARE-HostMemContentionManyVMs', hint: 'One per line. The VCF Ops content page lists them' },
      { id: 'object_kind', label: 'On object kind', control: 'text', default: 'HostSystem' },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const policy = str(values, 'policy_name', 'Production Policy');
      const direction = str(values, 'direction', 'enable');
      const ids = listOf(str(values, 'alert_ids', ''));
      const kind = str(values, 'object_kind', 'HostSystem');
      const base = slugOf(name || `${policy}-${direction}`, 'policy-override');
      const enabling = direction === 'enable';

      const findings: Finding[] = [];
      if (ids.length === 0) {
        findings.push(error('vcfops.policy.nothing', 'No alert definitions named, so this override does nothing.', { source: 'ArchToolKit' }));
      }
      if (!enabling && ids.length > 20) {
        findings.push(
          warning('vcfops.policy.mass-disable', `Turning off ${ids.length} alert definitions at once leaves a large hole in the monitoring.`, {
            remediation: 'Disabling in bulk is how an estate ends up with 2,000 definitions and nothing watching. Disable what is noisy, and fix what is noisy for a reason.',
            source: 'ArchToolKit',
          }),
        );
      }

      const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<PolicyContent>',
        '    <Policies>',
        `        <Policy description="Override" key="&lt;REQUIRED — the policy id&gt;" name="${policy}">`,
        '            <PackageSettings>',
        `                <Alerts adapterKind="VMWARE" resourceKind="${kind}">`,
        ...ids.map((id) => `                    <Alert enabled="${enabling}" id="${id}"/>`),
        '                </Alerts>',
        '            </PackageSettings>',
        '        </Policy>',
        '    </Policies>',
        '</PolicyContent>',
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `${policy} — ${enabling ? 'enable' : 'disable'} ${ids.length} alert definition${ids.length === 1 ? '' : 's'} on ${kind}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Applied once, by a person, as a change.' },
        scope: {
          what: `Every object the policy "${policy}" applies to.`,
          decidedBy: [
            `The custom groups that "${policy}" is assigned to.`,
            'The policy priority order — a higher-priority policy on the same object wins.',
            `The ${ids.length} named alert definitions, on ${kind} only.`,
          ],
          ifWrong: enabling
            ? 'Alerts start firing across a wider set of objects than expected, and the notification rules send all of it.'
            : 'Alerts stop firing on objects you did not mean to include, and nothing at all reports that they have stopped.',
        },
        guardrails: [
          { rule: 'Export the policy before applying this', because: 'The export is the undo. There is no other one, and the interface will not tell you what the previous value was.' },
          { rule: 'Named definitions only, on one object kind', because: 'A policy edit that changes a whole package changes settings nobody reviewed.' },
        ],
        dryRun: [
          'Run export-first.sh and keep the zip. That file is both the dry run and the undo.',
          'Diff it against this override so that what changes is exactly the list above and nothing else.',
        ],
        undo: ['Re-import the policy export taken before the change (POST /suite-api/api/policies/import?forceImport=true with the zip, or Import under Policies). Keep it with the change record; it is small and it is the only way back.'],
        told: ['Nobody automatically. A policy change is silent, which is why it belongs in a change record rather than in somebody’s afternoon.'],
        requires: [`The policy "${policy}" and its id.`, 'An export of the policy as it is now.'],
        files: {
          'merge-policy.sh': policyMergeScript(`${base}.xml`, policy),
          'IMPORT.md': importMd({
            title: `${enabling ? 'enabling' : 'disabling'} ${ids.length} alert definition${ids.length === 1 ? '' : 's'} in "${policy}"`,
            steps: [
              { heading: 'Take the undo', files: ['export-first.sh'], how: [`POLICY_ID=<id of "${policy}"> ./export-first.sh — the policy as it is now, as a zip that re-imports.`] },
              {
                heading: 'Merge and import',
                files: [`${base}.xml`, 'merge-policy.sh'],
                how: [
                  `${base}.xml is the change, not a policy to import: a policy file holds all of a policy's overrides, so importing this one alone would drop every other override "${policy}" has.`,
                  'POLICY_ID=… ./merge-policy.sh exports the policy, sets these <Alert enabled> values in it and writes import/policy-merged.zip, then imports that zip (--dry-run stops before the import) (POST /suite-api/api/policies/import?forceImport=true, multipart field policy).',
                  'Or import import/policy-merged.zip yourself: Configure → Policies → ⋯ → Import (8.x: Administration → Policies → Policy Library → Import).',
                ],
              },
            ],
            sources: FORMAT_SOURCES,
          }),
          [`${base}.xml`]: xml,
          'export-first.sh': [
            '#!/usr/bin/env bash',
            '# Take the export that is your only undo, before changing anything.',
            '#',
            '# The export is a zip, meant to be re-imported into the same version only.',
            'set -euo pipefail',
            ...authPreamble(PLATFORM),
            ': "${POLICY_ID:?set POLICY_ID — GET /suite-api/api/policies and match by name}"',
            '',
            'out="policy-before-$(date +%Y%m%d-%H%M%S).zip"',
            'curl -sS -f \\',
            '  "https://${VCFOPS_HOST}/suite-api/api/policies/export?id=${POLICY_ID}" \\',
            `  -H "${authHeader(PLATFORM)}" \\`,
            '  -o "$out"',
            '',
            'echo "Saved ${out}. Keep it with the change record — it is the undo."',
            '',
          ].join('\n'),
        },
        notes: [
          'A policy inherits from its parent. Setting an alert to enabled here overrides the parent for objects this policy applies to, and changes nothing anywhere else.',
          'If an alert still does not fire after enabling it, the next things to check are whether its symptoms still exist and whether a higher-priority policy applies to the object.',
        ],
        findings,
      };
    },
  }),
  ...VCF_OPS_POLICY_EDITOR,
];
