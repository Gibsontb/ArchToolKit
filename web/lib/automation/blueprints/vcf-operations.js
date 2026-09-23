/**
 * VCF Operations: automation driven by what the platform already knows.
 *
 * This is the automation that follows the alerts, policies and custom groups
 * the Aria Ops page reads — same objects, same scope, same four indirections
 * between "power off idle VMs" and which VMs that turns out to be tonight.
 *
 * Almost everything here is a suite-API payload rather than a script, because
 * that is what the platform actually takes: a notification rule with a webhook
 * on it, a custom group that decides a scope, a policy that turns an alert on.
 * Each one comes with the `curl` that applies it and the one that puts it back,
 * because a payload with no way to apply it is a screenshot.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, info, warning,              } from '../../core/findings.js';
import { automationBlueprint,                          } from '../from-automation.js';
import { listOf, slugOf,                 } from '../automation.js';

const PLATFORM = 'vcf-operations'         ;

/** The scope chain, spelled out. It is the same four steps every time. */
function alertScope(group        , policy        )           {
  return [
    `The alert fires on an object.`,
    `That object is in the custom group "${group}" — open it and count the members before you turn this on.`,
    `The group is on the policy "${policy}", and the policy decides whether the alert is enabled at all.`,
    `The notification rule below then decides whether the action runs for that alert.`,
  ];
}

function applyScript(path        , payload        , undoPath        )         {
  return [
    '#!/usr/bin/env bash',
    '# Apply the payload beside this script to VCF Operations.',
    '#',
    '# The token is read from the environment. Nothing here writes a credential',
    '# to disk, and nothing here is idempotent — run it once and check the id it',
    '# returns, rather than running it again when you are not sure.',
    'set -euo pipefail',
    '',
    ': "${VCFOPS_HOST:?set VCFOPS_HOST, e.g. vcfops.example.com}"',
    ': "${VCFOPS_TOKEN:?set VCFOPS_TOKEN — acquire with POST /suite-api/api/auth/token/acquire}"',
    '',
    'DRY_RUN=1',
    '[[ "${1:-}" == "--execute" ]] && DRY_RUN=0',
    '',
    'if (( DRY_RUN )); then',
    `  echo "DRY RUN: would POST ${payload} to https://\${VCFOPS_HOST}${path}"`,
    `  echo "Nothing is changed. Re-run with --execute once you have read ${payload}."`,
    '  exit 0',
    'fi',
    '',
    'curl -sS -f \\',
    '  -X POST "https://${VCFOPS_HOST}' + path + '" \\',
    '  -H "Authorization: vRealizeOpsToken ${VCFOPS_TOKEN}" \\',
    '  -H "Accept: application/json" \\',
    '  -H "Content-Type: application/json" \\',
    `  --data @${payload}`,
    '',
    `# Undo: see ${undoPath}`,
    '',
  ].join('\n');
}

export const VCF_OPERATIONS_AUTOMATIONS                                 = [
  automationBlueprint({
    id: 'vcfops_notify_webhook',
    platform: PLATFORM,
    label: 'Send an alert to a webhook',
    group: 'Notification',
    description:
      'A notification rule that posts an alert to a webhook — a runbook, a ticket queue, a chat channel — rather than to a mailbox nobody reads. This is the piece that closes the gap the Aria Ops page keeps finding: alert definitions that fire and tell nobody.',
    inputs: [
      { id: 'rule_name', label: 'Rule name', control: 'text', default: 'Critical infrastructure to runbook' },
      { id: 'endpoint', label: 'Webhook URL', control: 'text', default: 'https://runbooks.example.com/hooks/vcfops', hint: 'Where the alert is posted. No secret in the URL — see the note' },
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
      { id: 'resource_kinds', label: 'Only these object kinds', control: 'text', default: 'HostSystem, Datastore, ClusterComputeResource', hint: 'Empty means every kind, which is wider than it sounds' },
      { id: 'alert_ids', label: 'Only these alert definitions', control: 'textarea', default: '', hint: 'One id per line. Empty means every alert definition that passes the filters above' },
      { id: 'resend_minutes', label: 'Resend every (minutes)', control: 'number', default: 60, min: 0, max: 1440, hint: '0 sends once and never again' },
    ],
    automation: (values                 , name        )             => {
      const ruleName = str(values, 'rule_name', 'Alert to webhook');
      const endpoint = str(values, 'endpoint', '');
      const criticalities = listOf(str(values, 'criticality', ''));
      const kinds = listOf(str(values, 'resource_kinds', ''));
      const alertIds = listOf(str(values, 'alert_ids', ''));
      const resend = num(values, 'resend_minutes', 60);
      const base = slugOf(name || ruleName, 'notification-rule');

      const findings            = [];
      if (criticalities.length === 0 && kinds.length === 0 && alertIds.length === 0) {
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
            remediation: 'It will be stored in the rule, exported with the content, and written to every log along the way. Use a header on the webhook plugin instead.',
            source: 'ArchToolKit',
          }),
        );
      }

      const payload = {
        name: ruleName,
        pluginId: '<REQUIRED — the id of the webhook plugin instance>',
        enabled: true,
        ruleType: 'ALERT',
        alertStatuses: ['NEW', 'UPDATED'],
        criticalities,
        resourceKindFilters: kinds.map((kind) => ({ resourceKind: kind, adapterKind: 'VMWARE' })),
        alertDefinitionIdFilters: { values: alertIds },
        properties: [
          { name: 'url', value: endpoint },
          { name: 'resend', value: String(resend) },
        ],
      };

      return {
        platform: PLATFORM,
        title: `${ruleName} — post matching alerts to a webhook`,
        effect: 'read',
        trigger: {
          kind: 'alert',
          detail: alertIds.length > 0 ? `${alertIds.length} named alert definitions, at ${criticalities.join(' or ') || 'any severity'}` : `Any alert definition at ${criticalities.join(' or ') || 'any severity'}${kinds.length > 0 ? ` on ${kinds.join(', ')}` : ''}`,
          worstCase: resend > 0 ? `once per alert and again every ${resend} minutes while it stays open` : 'once per alert',
        },
        scope: {
          what: kinds.length > 0 ? `Alerts on ${kinds.join(', ')}.` : 'Alerts on every object kind.',
          decidedBy: [
            'The severity filter on this rule.',
            kinds.length > 0 ? `The object-kind filter: ${kinds.join(', ')}.` : 'No object-kind filter, so every kind.',
            alertIds.length > 0 ? `${alertIds.length} named alert definitions.` : 'No named alerts, so every definition that passes the filters.',
            'Whether each of those alert definitions is enabled in the policy that applies to the object.',
          ],
          ifWrong: 'The endpoint receives more than it can cope with and somebody mutes it, which is worse than never having built it.',
        },
        guardrails: [
          { rule: 'Severity and object kind are filtered', because: 'An unfiltered rule posts every informational alert in the estate and trains people to ignore the channel.' },
          ...(resend > 0 ? [{ rule: `Resends every ${resend} minutes rather than continuously`, because: 'A resend of zero means one message, which is missed; a resend of one minute means a thousand, which is muted.' }] : []),
        ],
        dryRun: [
          'Point the URL at a request bin first and let it run for an hour.',
          'Count what arrives. That count is what the endpoint has to survive on a bad night, not on a quiet one.',
        ],
        undo: [
          'DELETE /suite-api/api/notifications/rules/{id} with the id the apply script printed.',
          'Or set enabled to false and leave it, which keeps the configuration visible to the next person.',
        ],
        told: ['The webhook endpoint itself. Nothing else is notified — this rule replaces no mailbox unless you delete the mailbox rule as well.'],
        requires: [
          'A webhook plugin instance configured in VCF Operations, and its id.',
          'A token from POST /suite-api/api/auth/token/acquire, in VCFOPS_TOKEN.',
        ],
        files: {
          [`${base}.json`]: `${JSON.stringify(payload, null, 2)}\n`,
          'apply.sh': applyScript('/suite-api/api/notifications/rules', `${base}.json`, 'README.md'),
        },
        notes: [
          'The plugin id is not guessable. GET /suite-api/api/notifications/plugins and take the id of the webhook instance you mean.',
          'Filters are "empty means everything" in both directions: a rule with nothing set covers the estate, and a rule with an object-kind filter silently stops covering an adapter somebody adds next year.',
        ],
        findings,
      };
    },
  }),

  automationBlueprint({
    id: 'vcfops_scope_group',
    platform: PLATFORM,
    label: 'A custom group to scope automation',
    group: 'Scope',
    description:
      'The group that decides what an automation may touch. Built with an exclusion tag in it from the start, so an object can be taken out of scope by tagging it rather than by editing the automation at two in the morning.',
    inputs: [
      { id: 'group_name', label: 'Group name', control: 'text', default: 'Automation — safe to act on' },
      {
        id: 'object_kind',
        label: 'Object kind',
        control: 'select',
        options: [
          { value: 'VirtualMachine', label: 'Virtual machines' },
          { value: 'HostSystem', label: 'ESXi hosts' },
          { value: 'Datastore', label: 'Datastores' },
          { value: 'ClusterComputeResource', label: 'Clusters' },
        ],
        default: 'VirtualMachine',
      },
      { id: 'include_tag', label: 'Include objects tagged', control: 'text', default: 'automation:allowed', hint: 'An opt-in tag. Safer than opting the estate in and excluding from it' },
      { id: 'exclude_tag', label: 'Never touch objects tagged', control: 'text', default: 'automation:never', hint: 'The escape hatch. Leave this set' },
      { id: 'name_excludes', label: 'Never touch names containing', control: 'text', default: 'dc, sql, prod-db', hint: 'A crude second net, on purpose' },
      { id: 'policy_name', label: 'Put the group on this policy', control: 'text', default: 'Production Policy' },
    ],
    automation: (values                 , name        )             => {
      const groupName = str(values, 'group_name', 'Automation scope');
      const kind = str(values, 'object_kind', 'VirtualMachine');
      const includeTag = str(values, 'include_tag', '');
      const excludeTag = str(values, 'exclude_tag', '');
      const nameExcludes = listOf(str(values, 'name_excludes', ''));
      const policy = str(values, 'policy_name', 'Default Policy');
      const base = slugOf(name || groupName, 'custom-group');

      const findings            = [];
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

      const payload = {
        resourceKey: {
          name: groupName,
          adapterKindKey: 'Container',
          resourceKindKey: 'Environment',
          resourceIdentifiers: [],
        },
        policy: '<REQUIRED — the id of the policy named below>',
        autoResolveMembership: true,
        membershipDefinition: {
          includedResources: [],
          excludedResources: [],
          rules: [
            {
              resourceKindKey: { resourceKind: kind, adapterKind: 'VMWARE' },
              propertyConditionRules: [
                ...(includeTag ? [{ key: 'summary|tag', stringValue: includeTag, compareOperator: 'CONTAINS' }] : []),
                ...(excludeTag ? [{ key: 'summary|tag', stringValue: excludeTag, compareOperator: 'NOT_CONTAINS' }] : []),
              ],
              resourceNameConditionRules: nameExcludes.map((fragment) => ({ name: fragment, compareOperator: 'NOT_CONTAINS' })),
              statConditionRules: [],
              relationshipConditionRules: [],
              resourceTagConditionRules: [],
            },
          ],
        },
      };

      return {
        platform: PLATFORM,
        title: `${groupName} — the scope an automation may act on`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Nothing. A group does not act; it decides what may be acted on.' },
        scope: {
          what: `${kind} objects${includeTag ? ` tagged ${includeTag}` : ''}${excludeTag ? `, never those tagged ${excludeTag}` : ''}.`,
          decidedBy: [
            `Object kind: ${kind}.`,
            includeTag ? `Must carry the tag ${includeTag}.` : 'No opt-in tag — every object of that kind is a candidate.',
            excludeTag ? `Must not carry the tag ${excludeTag}.` : 'No exclusion tag.',
            nameExcludes.length > 0 ? `Name must not contain: ${nameExcludes.join(', ')}.` : 'No name exclusions.',
          ],
          ifWrong: 'Every automation scoped to this group inherits the mistake at once. This is the single object worth reviewing twice.',
        },
        guardrails: [
          ...(excludeTag ? [{ rule: `Anything tagged ${excludeTag} is out`, because: 'Somebody needs a way to take one object out of an automation at speed without editing the automation.' }] : []),
          ...(nameExcludes.length > 0 ? [{ rule: `Names containing ${nameExcludes.join(', ')} are out`, because: 'A crude second net, deliberately. Tags get removed by accident; a naming convention rarely does.' }] : []),
          { rule: 'Membership resolves automatically', because: 'A group with fixed members drifts out of date silently, which is the other way scope goes wrong.' },
        ],
        dryRun: [
          'Create the group, open it, and read the member list before any automation points at it.',
          'Compare the count against what you expected. If it is within an order of magnitude, look again.',
        ],
        undo: ['DELETE /suite-api/api/resources/groups/{id}. Deleting a group does not touch its members.'],
        told: ['Nobody. A group is configuration; it is the automations pointed at it that act.'],
        requires: [`The policy "${policy}" to exist, and its id — GET /suite-api/api/policies.`],
        files: {
          [`${base}.json`]: `${JSON.stringify(payload, null, 2)}\n`,
          'apply.sh': applyScript('/suite-api/api/resources/groups', `${base}.json`, 'README.md'),
        },
        notes: [
          `Put the group on "${policy}" rather than the default policy. A group on the default policy gets the same thresholds as everything else, which makes the group pointless.`,
          'Tag conditions read vSphere tags through summary|tag. The tag has to be assigned in vCenter, and the adapter has to have collected since.',
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
      'The reclamation most estates talk about and few turn on: powered-off VMs, idle VMs, oversized VMs, orphaned disks and old snapshots. Generated as a scheduled job with a cap on how much one run may touch, because the failure mode is not "it did nothing" — it is "it did all of it at once".',
    inputs: [
      { id: 'job_name', label: 'Job name', control: 'text', default: 'Monthly reclamation' },
      {
        id: 'what',
        label: 'What to reclaim',
        control: 'select',
        options: [
          { value: 'snapshots', label: 'Delete snapshots older than N days' },
          { value: 'powered-off', label: 'Delete VMs powered off for N days' },
          { value: 'orphaned', label: 'Delete orphaned disks' },
          { value: 'oversized', label: 'Right-size oversized VMs' },
        ],
        default: 'snapshots',
      },
      { id: 'older_than', label: 'Older than (days)', control: 'number', default: 30, min: 1, max: 365 },
      { id: 'group_name', label: 'Only within group', control: 'text', default: 'Automation — safe to act on' },
      { id: 'max_objects', label: 'Never touch more than (objects per run)', control: 'number', default: 25, min: 1, max: 500 },
      { id: 'snapshot_first', label: 'Snapshot before changing a VM', control: 'toggle', default: true, showWhen: { input: 'what', equals: ['oversized'] } },
      { id: 'window', label: 'Run at', control: 'text', default: 'Sunday 02:00', hint: 'Outside the change freeze, inside the maintenance window' },
    ],
    automation: (values                 , name        )             => {
      const jobName = str(values, 'job_name', 'Reclamation');
      const what = str(values, 'what', 'snapshots');
      const olderThan = num(values, 'older_than', 30);
      const group = str(values, 'group_name', 'Automation — safe to act on');
      const cap = num(values, 'max_objects', 25);
      const snapshotFirst = bool(values, 'snapshot_first', true);
      const window = str(values, 'window', 'Sunday 02:00');
      const base = slugOf(name || jobName, 'reclaim');

      const WHAT                                                                                                          = {
        snapshots: {
          title: `delete snapshots older than ${olderThan} days`,
          effect: 'irreversible',
          undo: ['A deleted snapshot cannot be restored. What it protected is gone with it.', 'The only real undo is a backup of the VM taken before the run.'],
          query: `snapshot age > ${olderThan} days`,
        },
        'powered-off': {
          title: `delete VMs powered off for more than ${olderThan} days`,
          effect: 'irreversible',
          undo: ['Restore from backup. There is no other way back.', 'Consider moving to a folder and waiting a further 30 days instead of deleting — the generated job supports that as its first phase.'],
          query: `power state = off for > ${olderThan} days`,
        },
        orphaned: {
          title: 'delete orphaned virtual disks',
          effect: 'irreversible',
          undo: ['Restore from backup. An orphaned disk that turns out not to be orphaned is somebody’s data.'],
          query: 'disk not attached to any registered VM',
        },
        oversized: {
          title: 'right-size oversized VMs',
          effect: 'reversible',
          undo: ['Set the CPU and memory back to what the run recorded. The job writes the previous values into its own log before changing anything.'],
          query: 'demand well below allocation over the last 30 days',
        },
      };
      const spec = WHAT[what] ?? WHAT['snapshots'] ;

      const findings            = [];
      if (cap > 100) {
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

      const job = {
        name: jobName,
        description: `ArchToolKit — ${spec.title}, within "${group}", at most ${cap} per run.`,
        schedule: { recurrence: window, timeZone: '<REQUIRED — e.g. America/New_York>' },
        enabled: false,
        scope: { customGroup: group, objectQuery: spec.query },
        limits: { maxObjectsPerRun: cap, requireDryRunFirst: true },
        ...(what === 'oversized' ? { safety: { snapshotBefore: snapshotFirst, recordPreviousSizing: true } } : {}),
      };

      return {
        platform: PLATFORM,
        title: `${jobName} — ${spec.title}`,
        effect: spec.effect,
        trigger: { kind: 'schedule', detail: `${window}, in the time zone you set`, worstCase: `once a week, up to ${cap} objects each time` },
        scope: {
          what: `Objects in the custom group "${group}" matching: ${spec.query}.`,
          decidedBy: [
            `Membership of the custom group "${group}".`,
            `The query: ${spec.query}.`,
            `The cap: at most ${cap} objects in any one run.`,
          ],
          ifWrong: spec.effect === 'irreversible'
            ? `Up to ${cap} objects are destroyed per run, and they do not come back. This is why the cap is here and why the job is created disabled.`
            : `Up to ${cap} VMs are resized, which is reversible but will be noticed.`,
        },
        guardrails: [
          { rule: `At most ${cap} objects in one run`, because: 'A wrong scope with a cap is an incident; a wrong scope without one is an outage.' },
          { rule: 'Created disabled', because: 'Nothing generated here starts running because a file was applied. Somebody has to turn it on deliberately.' },
          { rule: 'Dry run required before the first real run', because: 'The list it prints is the only place a wrong scope is visible before it acts.' },
          ...(what === 'oversized' && snapshotFirst ? [{ rule: 'Snapshot before resizing', because: 'A resize that needs backing out at 3am needs something to back out to — and the snapshot is deleted by the job on success.' }] : []),
          ...(what === 'powered-off' ? [{ rule: 'Move to a holding folder before deleting', because: 'A VM in a folder for thirty days is recoverable by anyone; a deleted VM needs the backup team.' }] : []),
        ],
        dryRun: [
          'The job is generated with enabled:false and requireDryRunFirst:true.',
          'Run it once in report mode and read the object list in full — not the count, the list.',
          'Expect to find something in it that should not be. That is what the exclusion tag on the group is for.',
        ],
        undo: spec.undo,
        told: [
          'The job writes what it touched to its own run log.',
          'Wire it to the notification rule in this kit so that the record leaves the appliance — a run log nobody reads is not a record.',
        ],
        requires: [
          `The custom group "${group}" to exist and to be narrower than you first think.`,
          'Actions enabled in VCF Operations, with a vCenter account that has the rights to do what this job does — and no more.',
        ],
        files: {
          [`${base}.json`]: `${JSON.stringify(job, null, 2)}\n`,
          'apply.sh': applyScript('/suite-api/api/actions/jobs', `${base}.json`, 'README.md'),
        },
        notes: [
          'Reclamation is where automation earns its keep and where it does the most damage. Both facts are about the same property: it acts on many objects at once.',
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
      'A recurring maintenance schedule so patching does not page anybody, plus the thing people forget: the check that it actually ended. A window that never closes is an estate with no alerting and nobody aware of it.',
    inputs: [
      { id: 'window_name', label: 'Window name', control: 'text', default: 'Monthly patching' },
      { id: 'group_name', label: 'Applies to group', control: 'text', default: 'Production hosts' },
      { id: 'starts', label: 'Starts', control: 'text', default: 'Third Saturday 22:00' },
      { id: 'hours', label: 'Length (hours)', control: 'number', default: 6, min: 1, max: 24 },
      { id: 'alert_on_overrun', label: 'Raise an alert if it has not ended', control: 'toggle', default: true },
    ],
    automation: (values                 , name        )             => {
      const windowName = str(values, 'window_name', 'Maintenance');
      const group = str(values, 'group_name', 'Production hosts');
      const starts = str(values, 'starts', 'Third Saturday 22:00');
      const hours = num(values, 'hours', 6);
      const overrun = bool(values, 'alert_on_overrun', true);
      const base = slugOf(name || windowName, 'maintenance-window');

      const findings            = [];
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

      const schedule = {
        name: windowName,
        description: `ArchToolKit — suppress alerting on "${group}" for ${hours} hours from ${starts}.`,
        recurrence: starts,
        durationMinutes: hours * 60,
        timeZone: '<REQUIRED — e.g. America/New_York>',
        appliesTo: { customGroup: group },
        suppressNotifications: true,
      };

      return {
        platform: PLATFORM,
        title: `${windowName} — stop alerting on "${group}" for ${hours} hours`,
        effect: 'reversible',
        trigger: { kind: 'schedule', detail: `${starts}, for ${hours} hours`, worstCase: `${hours} hours a month with no alerting on that group` },
        scope: {
          what: `Every object in the custom group "${group}".`,
          decidedBy: [`Membership of "${group}" at the moment the window opens.`, 'Objects added to the group mid-window are covered from the next evaluation.'],
          ifWrong: 'Alerting is off for objects you did not mean to include, for the length of the window, and nothing reports that it is off.',
        },
        guardrails: [
          { rule: `Bounded to ${hours} hours`, because: 'A maintenance schedule with no end is the commonest way an estate ends up unmonitored for a month.' },
          ...(overrun ? [{ rule: 'An alert fires if the window has not closed on time', because: 'This is the only symptom of a window that stuck open. Without it, nothing is wrong and nothing is watching.' }] : []),
        ],
        dryRun: ['Create it, then check the objects it covers before the first window opens — a group is easy to widen by accident.'],
        undo: ['DELETE the schedule, or end the window early from the interface. Alerts resume immediately; anything that fired during the window was suppressed, not queued.'],
        told: overrun ? ['An overrun alert, if the window does not close. Send it somewhere a human reads at the weekend, because that is when this runs.'] : ['Nobody. Consider turning the overrun check on.'],
        requires: [`The custom group "${group}".`],
        files: {
          [`${base}.json`]: `${JSON.stringify(schedule, null, 2)}\n`,
          ...(overrun
            ? {
                'overrun-check.sh': [
                  '#!/usr/bin/env bash',
                  '# Does a maintenance window that should have closed still look open?',
                  '#',
                  '# Run this an hour after the window was due to end. It reads only; it',
                  '# changes nothing and closes nothing, because closing a window that is',
                  '# genuinely still needed is its own incident.',
                  'set -euo pipefail',
                  ': "${VCFOPS_HOST:?}"',
                  ': "${VCFOPS_TOKEN:?}"',
                  '',
                  'curl -sS -f \\',
                  '  "https://${VCFOPS_HOST}/suite-api/api/maintenanceschedules" \\',
                  '  -H "Authorization: vRealizeOpsToken ${VCFOPS_TOKEN}" \\',
                  '  -H "Accept: application/json" |',
                  `  grep -q '"name"[[:space:]]*:[[:space:]]*"${windowName}"' &&`,
                  `  echo "WARNING: ${windowName} still present — check whether the window closed" >&2`,
                  '',
                ].join('\n'),
              }
            : {}),
          'apply.sh': applyScript('/suite-api/api/maintenanceschedules', `${base}.json`, 'README.md'),
        },
        notes: [
          'Suppressed is not the same as not raised. The alerts still exist in the interface afterwards, which is useful the morning after a patching run that went badly.',
          'A maintenance window silences alerting. It does not stop an automation firing — check whether anything scheduled overlaps it.',
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
      'The safest automation there is, and the one most often left undone: a report that actually arrives. The Aria Ops page finds report definitions with no schedule at all — this is the schedule.',
    inputs: [
      { id: 'report_name', label: 'Report definition', control: 'text', default: 'Cluster capacity' },
      { id: 'recipients', label: 'Send to', control: 'text', default: 'platform-team@example.com', hint: 'A team address. A person’s mailbox stops working the week they change role' },
      {
        id: 'cadence',
        label: 'How often',
        control: 'select',
        options: [
          { value: 'weekly', label: 'Weekly' },
          { value: 'monthly', label: 'Monthly' },
          { value: 'quarterly', label: 'Quarterly' },
        ],
        default: 'monthly',
      },
      { id: 'formats', label: 'Formats', control: 'text', default: 'pdf, csv' },
      { id: 'scope_object', label: 'Run it for', control: 'text', default: 'vSphere World' },
    ],
    automation: (values                 , name        )             => {
      const reportName = str(values, 'report_name', 'Capacity');
      const recipients = listOf(str(values, 'recipients', ''));
      const cadence = str(values, 'cadence', 'monthly');
      const formats = listOf(str(values, 'formats', 'pdf'));
      const scopeObject = str(values, 'scope_object', 'vSphere World');
      const base = slugOf(name || reportName, 'report-schedule');

      const findings            = [];
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

      const schedule = {
        reportSchedules: [
          {
            reportDefinitionID: '<REQUIRED — GET /suite-api/api/reportdefinitions and match by name>',
            resourceRef: { name: scopeObject, resourceKind: 'vSphere World', adapterKind: 'VMWARE' },
            recurrence: { recurrenceType: cadence === 'weekly' ? 'WeeklyRecurrence' : cadence === 'quarterly' ? 'MonthlyDayRecurrence' : 'MonthlyDayRecurrence', recurrencePeriod: cadence === 'quarterly' ? 3 : 1, recurrenceStartHour: 7, recurrenceStartMinute: 0, recurrenceTimeZoneID: '<REQUIRED>' },
            emailRecipients: recipients.join(';'),
            sendEmail: recipients.length > 0,
            uploadReport: false,
            locale: 'en',
          },
        ],
      };

      return {
        platform: PLATFORM,
        title: `${reportName} — sent ${cadence} to ${recipients.join(', ') || 'nobody'}`,
        effect: 'read',
        trigger: { kind: 'schedule', detail: `${cadence}, at 07:00 in the time zone you set`, worstCase: cadence === 'weekly' ? 'once a week' : 'once a month' },
        scope: {
          what: `The report "${reportName}", run against ${scopeObject}.`,
          decidedBy: ['The report definition itself and the views in it.', `The object it is run for: ${scopeObject}.`],
          ifWrong: 'Somebody gets a report about the wrong part of the estate and, because it looks plausible, acts on it.',
        },
        guardrails: [
          { rule: 'It only reads', because: 'A report changes nothing. This is the one automation that is safe to turn on before you have thought about it.' },
          ...(recipients.length > 0 ? [{ rule: 'Goes to a named list', because: 'A scheduled report with no recipient is a file generated onto an appliance and deleted by retention.' }] : []),
        ],
        dryRun: ['Run the report once by hand for the same object and read it. A report nobody has read once will not be read monthly.'],
        undo: ['DELETE /suite-api/api/reports/schedules/{id}. Nothing else changes.'],
        told: recipients.length > 0 ? [`${recipients.join(', ')}, every ${cadence === 'weekly' ? 'week' : cadence === 'quarterly' ? 'quarter' : 'month'}.`] : ['Nobody, which makes this schedule pointless.'],
        requires: [`The report definition "${reportName}" to exist, and its id.`, 'An outbound mail plugin configured, and allowed through to your relay.'],
        files: {
          [`${base}.json`]: `${JSON.stringify(schedule, null, 2)}\n`,
          'apply.sh': applyScript('/suite-api/api/reports/schedules', `${base}.json`, 'README.md'),
        },
        notes: [
          `Formats requested: ${formats.join(', ')}. PDF is what people read; CSV is what they actually use, because the first thing anybody does with a capacity report is sort it.`,
          'If the report has never been scheduled before, check the mail plugin first. A schedule that silently fails to send looks identical to one that is working.',
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
      { id: 'alert_ids', label: 'Alert definition ids', control: 'textarea', default: 'AlertDefinition-VMWARE-DatastoreUsage\nAlertDefinition-VMWARE-HostMemContentionManyVMs', hint: 'One per line. The Aria Ops page lists them' },
      { id: 'object_kind', label: 'On object kind', control: 'text', default: 'HostSystem' },
    ],
    automation: (values                 , name        )             => {
      const policy = str(values, 'policy_name', 'Production Policy');
      const direction = str(values, 'direction', 'enable');
      const ids = listOf(str(values, 'alert_ids', ''));
      const kind = str(values, 'object_kind', 'HostSystem');
      const base = slugOf(name || `${policy}-${direction}`, 'policy-override');
      const enabling = direction === 'enable';

      const findings            = [];
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
        `        <Policy description="ArchToolKit override" key="&lt;REQUIRED — the policy id&gt;" name="${policy}">`,
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
          'GET the policy and save it. That file is both the dry run and the undo.',
          'Diff it against this override so that what changes is exactly the list above and nothing else.',
        ],
        undo: ['Re-import the policy export taken before the change. Keep it with the change record; it is small and it is the only way back.'],
        told: ['Nobody automatically. A policy change is silent, which is why it belongs in a change record rather than in somebody’s afternoon.'],
        requires: [`The policy "${policy}" and its id.`, 'An export of the policy as it is now.'],
        files: {
          [`${base}.xml`]: xml,
          'export-first.sh': [
            '#!/usr/bin/env bash',
            '# Take the export that is your only undo, before changing anything.',
            'set -euo pipefail',
            ': "${VCFOPS_HOST:?}"',
            ': "${VCFOPS_TOKEN:?}"',
            ': "${POLICY_ID:?set POLICY_ID — GET /suite-api/api/policies and match by name}"',
            '',
            'curl -sS -f \\',
            '  "https://${VCFOPS_HOST}/suite-api/api/policies/${POLICY_ID}/export" \\',
            '  -H "Authorization: vRealizeOpsToken ${VCFOPS_TOKEN}" \\',
            '  -o "policy-before-$(date +%Y%m%d-%H%M%S).xml"',
            '',
            'echo "Saved. Keep this with the change record — it is the undo."',
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
];
