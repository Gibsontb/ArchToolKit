/**
 * What is wrong with the monitoring, from the export.
 *
 * Browsing the content is worth something; this is worth more. These are the
 * questions nobody can answer from inside the product, because the product
 * shows you one object at a time and every one of these is about the whole:
 *
 *  - an alert definition that no enabled notification rule matches will fire,
 *    sit in the UI, and tell nobody. That is the single most common finding in
 *    a real estate, and it is usually most of the alert definitions.
 *  - an alert whose symptom was deleted can never fire at all, and the UI shows
 *    it as perfectly healthy.
 *  - a custom group still pointed at the Default Policy is not getting the
 *    thresholds someone spent a week tuning.
 *  - a dashboard that was never shared belongs to one person's account, and
 *    leaves with them.
 *  - a report definition with no schedule has never been sent to anyone.
 *
 * Each finding says how many, and what to do. The counts matter: "2,300 alert
 * definitions notify nobody" is a different conversation from "three do".
 */

import { error, info, warning,              } from '../core/findings.js';
import { countBy,                                                               } from './aria.js';

/** VCF Operations' own words for severity, as the notification rule filters spell them. */
function criticalityOf(alert                 )         {
  return alert.severity === 'unknown' ? 'AUTO' : alert.severity.toUpperCase();
}

/**
 * Whether an enabled rule would pass this alert through.
 *
 * Every filter on a rule is "empty means everything", which is the part people
 * get wrong in both directions: a rule with nothing set notifies on the entire
 * estate, and a rule with a resource-kind filter silently stops covering an
 * adapter someone added later.
 */
export function ruleCovers(rule                  , alert                 )          {
  if (!rule.enabled) return false;
  if (rule.ruleType !== 'ALERT') return false;
  if (rule.alertDefinitionIds.length > 0 && !rule.alertDefinitionIds.includes(alert.id)) return false;
  if (rule.resourceKinds.length > 0 && !rule.resourceKinds.includes(alert.resourceKind)) return false;
  if (rule.criticalities.length > 0) {
    const criticality = criticalityOf(alert);
    // AUTO takes whichever symptom's severity fired, so it can match anything.
    if (criticality !== 'AUTO' && !rule.criticalities.includes(criticality)) return false;
  }
  if (rule.impacts.length > 0) {
    const impacts = alert.states.map((state) => state.impact.toUpperCase());
    if (!impacts.some((impact) => rule.impacts.includes(impact))) return false;
  }
  return true;
}

/** Alert definitions that no enabled rule would notify anyone about. */
export function unnotifiedAlerts(content             )                             {
  const rules = content.rules.filter((rule) => rule.enabled);
  if (rules.length === 0) return content.alerts;
  return content.alerts.filter((alert) => !rules.some((rule) => ruleCovers(rule, alert)));
}

/** A mailbox that belongs to one person rather than to a team. */
function looksPersonal(address        )          {
  const local = address.split('@')[0] ?? '';
  // firstname.lastname or firstname_lastname, and not an obvious team name.
  if (!/^[a-z]+[._][a-z](?:[a-z.]*)$/i.test(local)) return false;
  return !/(team|ops|support|alerts?|noc|help|desk|admin|group|dl|it-|svc|service)/i.test(local);
}

function addressesOf(rule                  )           {
  const raw = Object.entries(rule.properties)
    .filter(([key]) => /mail|addr|recipient|to/i.test(key))
    .map(([, value]) => value)
    .join(';');
  return raw
    .split(/[;,\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.includes('@'));
}

export function ariaFindings(content             )            {
  const findings            = [];
  const SOURCE = 'ArchToolKit, from the export';

  // --- notification ---------------------------------------------------------

  const enabledRules = content.rules.filter((rule) => rule.enabled);
  const disabledRules = content.rules.filter((rule) => !rule.enabled);

  if (content.alerts.length > 0 && content.rules.length === 0) {
    findings.push(
      warning('aria.rules.none', `${content.alerts.length} alert definitions are configured and the export contains no notification rules at all.`, {
        remediation: 'Either the notification rules were not exported, or nothing is being sent anywhere. Check which before assuming the first.',
        source: SOURCE,
      }),
    );
  } else if (content.alerts.length > 0 && enabledRules.length === 0) {
    findings.push(
      error('aria.rules.all-disabled', `All ${content.rules.length} notification rules are disabled. Every alert fires into the interface and reaches nobody.`, {
        remediation: 'Enable the rules that should be live, or delete them so the next person does not assume they are working.',
        source: SOURCE,
      }),
    );
  }

  if (content.alerts.length > 0 && enabledRules.length > 0) {
    const unnotified = unnotifiedAlerts(content);
    const share = Math.round((unnotified.length / content.alerts.length) * 100);
    if (unnotified.length > 0) {
      findings.push(
        warning(
          'aria.alerts.unnotified',
          `${unnotified.length} of ${content.alerts.length} alert definitions (${share}%) match no enabled notification rule. They will fire, appear in the interface, and tell nobody.`,
          {
            remediation:
              'That is normal for the definitions shipped with adapters you do not use, and not normal for the ones you tuned. Filter the alert list by "not notified" and check the criticals first.',
            source: SOURCE,
          },
        ),
      );
    }

    const catchAll = enabledRules.filter(
      (rule) => rule.alertDefinitionIds.length === 0 && rule.resourceKinds.length === 0 && rule.criticalities.length === 0 && rule.impacts.length === 0,
    );
    if (catchAll.length > 0) {
      findings.push(
        warning('aria.rules.catch-all', `${catchAll.length} enabled notification rule${catchAll.length === 1 ? ' has' : 's have'} no filters at all, so ${catchAll.length === 1 ? 'it notifies' : 'they notify'} on every alert in the estate: ${catchAll.map((rule) => rule.name).join(', ')}.`, {
          remediation: 'A rule that notifies on everything is a rule people filter to a folder. Narrow it to the criticality and object kinds that warrant waking someone.',
          source: SOURCE,
        }),
      );
    }
  }

  if (disabledRules.length > 0 && enabledRules.length > 0) {
    findings.push(
      warning('aria.rules.disabled', `${disabledRules.length} notification rule${disabledRules.length === 1 ? ' is' : 's are'} disabled: ${disabledRules.map((rule) => rule.name).join(', ')}.`, {
        remediation: 'A disabled rule looks configured in every review. Delete it, or note in its name why it is off.',
        source: SOURCE,
      }),
    );
  }

  const personal = content.rules.flatMap((rule) =>
    addressesOf(rule)
      .filter(looksPersonal)
      .map((address) => `${rule.name} → ${address}`),
  );
  if (personal.length > 0) {
    findings.push(
      warning('aria.rules.personal-mailbox', `${personal.length} notification destination${personal.length === 1 ? ' is' : 's are'} an individual's mailbox rather than a team address.`, {
        remediation: 'When that person moves team, the alert stops reaching anyone and nothing reports that it has. Send to a distribution list or a queue.',
        path: personal.slice(0, 5).join('; '),
        source: SOURCE,
      }),
    );
  }

  const unusedTemplates = content.templates.filter((template) => template.attachedRuleCount === 0);
  if (unusedTemplates.length > 0 && content.templates.length > 0) {
    findings.push(
      info('aria.templates.unused', `${unusedTemplates.length} of ${content.templates.length} notification templates are attached to no rule.`, {
        remediation: 'Mostly the defaults for plugins nobody configured — ServiceNow, Slack, SNMP. Worth knowing before someone assumes an integration exists.',
        source: SOURCE,
      }),
    );
  }

  // --- alerts, symptoms and recommendations ---------------------------------

  const symptomIds = new Set(content.symptoms.map((symptom) => symptom.id));
  const recommendationIds = new Set(content.recommendations.map((recommendation) => recommendation.id));

  if (content.symptoms.length > 0) {
    const broken = content.alerts.filter((alert) =>
      alert.states.some((state) => state.symptomIds.some((id) => !symptomIds.has(id))),
    );
    if (broken.length > 0) {
      findings.push(
        error('aria.alerts.missing-symptom', `${broken.length} alert definition${broken.length === 1 ? '' : 's'} reference a symptom that is not in the export. An alert whose symptom is gone can never fire.`, {
          remediation: 'Check whether the symptom was deleted or simply not exported. If it was deleted, the alert is dead and the object it watches is unmonitored.',
          path: broken.slice(0, 5).map((alert) => alert.name || alert.id).join('; '),
          source: SOURCE,
        }),
      );
    }

    const orphanSymptoms = content.symptoms.filter(
      (symptom) => !content.alerts.some((alert) => alert.states.some((state) => state.symptomIds.includes(symptom.id))),
    );
    if (orphanSymptoms.length > 0) {
      findings.push(
        info('aria.symptoms.orphan', `${orphanSymptoms.length} of ${content.symptoms.length} symptom definitions are referenced by no alert definition.`, {
          remediation: 'Harmless, but they are the residue of alerts that were deleted and the ones somebody built and never finished wiring up.',
          source: SOURCE,
        }),
      );
    }
  }

  if (content.recommendations.length > 0) {
    const missing = content.alerts.filter((alert) =>
      alert.states.some((state) => state.recommendationIds.some((id) => !recommendationIds.has(id))),
    );
    if (missing.length > 0) {
      findings.push(
        warning('aria.alerts.missing-recommendation', `${missing.length} alert definition${missing.length === 1 ? '' : 's'} point at a recommendation that is not in the export.`, {
          remediation: 'The alert still fires; the person who receives it is told nothing about what to do.',
          path: missing.slice(0, 5).map((alert) => alert.name || alert.id).join('; '),
          source: SOURCE,
        }),
      );
    }
  }

  if (content.alerts.length > 0) {
    const noAdvice = content.alerts.filter((alert) => alert.states.every((state) => state.recommendationIds.length === 0));
    if (noAdvice.length > 0) {
      findings.push(
        info('aria.alerts.no-recommendation', `${noAdvice.length} of ${content.alerts.length} alert definitions carry no recommendation.`, {
          remediation: 'An alert with no recommendation arrives at 3am as a sentence and a link. The ones you wrote yourself are the ones worth fixing.',
          source: SOURCE,
        }),
      );
    }

    const noSymptoms = content.alerts.filter((alert) => alert.states.every((state) => state.symptomIds.length === 0));
    if (noSymptoms.length > 0) {
      findings.push(
        warning('aria.alerts.no-symptoms', `${noSymptoms.length} alert definition${noSymptoms.length === 1 ? ' has' : 's have'} no symptoms on any state, so nothing can ever make ${noSymptoms.length === 1 ? 'it' : 'them'} fire.`, {
          path: noSymptoms.slice(0, 5).map((alert) => alert.name || alert.id).join('; '),
          source: SOURCE,
        }),
      );
    }
  }

  if (content.recommendations.length > 0 && content.alerts.length > 0) {
    const used = new Set(content.alerts.flatMap((alert) => alert.states.flatMap((state) => state.recommendationIds)));
    const orphans = content.recommendations.filter((recommendation) => !used.has(recommendation.id));
    if (orphans.length > 0) {
      findings.push(
        info('aria.recommendations.orphan', `${orphans.length} of ${content.recommendations.length} recommendations are attached to no alert.`, { source: SOURCE }),
      );
    }
  }

  // --- policies and groups ---------------------------------------------------

  const policyById = new Map(content.policies.map((policy) => [policy.id, policy]));
  const defaultPolicy = content.policies.find((policy) => policy.isDefault);

  if (content.groups.length > 0 && defaultPolicy) {
    const onDefault = content.groups.filter((group) => group.policyId === defaultPolicy.id);
    if (onDefault.length > 0) {
      findings.push(
        warning('aria.groups.default-policy', `${onDefault.length} of ${content.groups.length} custom groups are still on "${defaultPolicy.name}".`, {
          remediation:
            'A group exists to give a set of objects different thresholds. One left on the default policy is getting the same thresholds as everything else, which means the group is doing nothing.',
          path: onDefault.slice(0, 5).map((group) => group.name).join('; '),
          source: SOURCE,
        }),
      );
    }
  }

  if (content.groups.length > 0) {
    const empty = content.groups.filter((group) => group.rules.length === 0 && group.explicitMembers === 0);
    if (empty.length > 0) {
      findings.push(
        warning('aria.groups.empty', `${empty.length} custom group${empty.length === 1 ? ' has' : 's have'} no membership rules and no named members, so ${empty.length === 1 ? 'it is' : 'they are'} permanently empty.`, {
          path: empty.slice(0, 5).map((group) => group.name).join('; '),
          source: SOURCE,
        }),
      );
    }

    if (content.policies.length > 0) {
      const missingPolicy = content.groups.filter((group) => group.policyId && !policyById.has(group.policyId));
      if (missingPolicy.length > 0) {
        findings.push(
          error('aria.groups.missing-policy', `${missingPolicy.length} custom group${missingPolicy.length === 1 ? ' points' : 's point'} at a policy that is not in the export.`, {
            path: missingPolicy.slice(0, 5).map((group) => group.name).join('; '),
            source: SOURCE,
          }),
        );
      }

      const used = new Set(content.groups.map((group) => group.policyId).filter(Boolean));
      const unused = content.policies.filter((policy) => !policy.isDefault && !used.has(policy.id));
      if (unused.length > 0) {
        findings.push(
          info('aria.policies.unused', `${unused.length} of ${content.policies.length} policies are not assigned to any custom group in this export.`, {
            remediation: 'They may be assigned to objects directly or inherited by a child policy, so this is a list to check rather than a list to delete.',
            path: unused.slice(0, 6).map((policy) => policy.name).join('; '),
            source: SOURCE,
          }),
        );
      }
    }
  }

  const bigOverrides = content.policies
    .filter((policy) => (policy.disabledAlerts?.length ?? 0) > 0)
    .sort((a, b) => (b.disabledAlerts?.length ?? 0) - (a.disabledAlerts?.length ?? 0));
  if (bigOverrides.length > 0) {
    findings.push(
      info('aria.policies.disabled-alerts', `${bigOverrides.length} polic${bigOverrides.length === 1 ? 'y turns' : 'ies turn'} alert definitions off: ${bigOverrides.slice(0, 5).map((policy) => `${policy.name} (${policy.disabledAlerts?.length})`).join(', ')}.`, {
        remediation: 'This is where an alert that "should be firing" usually went. Check the policy that applies to the object before re-tuning the symptom.',
        source: SOURCE,
      }),
    );
  }

  // --- super metrics ---------------------------------------------------------

  if (content.superMetrics.length > 0) {
    const known = new Set(content.superMetrics.map((metric) => metric.id.toLowerCase()));

    const constant = content.superMetrics.filter((metric) => /^\s*-?\d+(\.\d+)?\s*$/.test(metric.formula));
    if (constant.length > 0) {
      findings.push(
        warning('aria.supermetrics.constant', `${constant.length} super metric${constant.length === 1 ? ' is' : 's are'} a constant rather than a formula: ${constant.map((metric) => `${metric.name} = ${metric.formula.trim()}`).join(', ')}.`, {
          remediation: 'Usually a placeholder left behind by a management pack, and anything charting it is charting a flat line.',
          source: SOURCE,
        }),
      );
    }

    const dangling = content.superMetrics.filter((metric) => metric.dependsOn.some((id) => !known.has(id) && id !== metric.id.toLowerCase()));
    if (dangling.length > 0) {
      findings.push(
        error('aria.supermetrics.missing-dependency', `${dangling.length} super metric${dangling.length === 1 ? '' : 's'} read another super metric that is not in the export: ${dangling.slice(0, 4).map((metric) => metric.name).join(', ')}.`, {
          remediation: 'A super metric whose input is gone returns nothing, and everything built on top of it silently stops reporting.',
          source: SOURCE,
        }),
      );
    }

    const chained = content.superMetrics.filter((metric) => metric.dependsOn.some((id) => id !== metric.id.toLowerCase()));
    if (chained.length > 0) {
      findings.push(
        info('aria.supermetrics.chained', `${chained.length} super metric${chained.length === 1 ? ' is' : 's are'} built on other super metrics.`, {
          remediation: 'Worth knowing before editing one: the chain is not visible in the interface, so changing the bottom of it changes dashboards nobody connected to it.',
          source: SOURCE,
        }),
      );
    }
  }

  // --- dashboards, views and reports -----------------------------------------

  if (content.dashboards.length > 0) {
    const byName = countBy(content.dashboards, (dashboard) => dashboard.name);
    const duplicates = byName.filter((entry) => entry.count > 1);
    if (duplicates.length > 0) {
      const extra = duplicates.reduce((total, entry) => total + entry.count - 1, 0);
      findings.push(
        warning('aria.dashboards.duplicates', `${duplicates.length} dashboard name${duplicates.length === 1 ? ' is' : 's are'} used more than once — ${extra} more dashboards than distinct names.`, {
          remediation: 'Almost always personal copies of one shared dashboard. The copies stop tracking the original the moment it is improved.',
          path: duplicates.slice(0, 5).map((entry) => `${entry.name} ×${entry.count}`).join('; '),
          source: SOURCE,
        }),
      );
    }

    const unshared = content.dashboards.filter((dashboard) => !dashboard.shared);
    if (unshared.length > 0) {
      findings.push(
        warning('aria.dashboards.unshared', `${unshared.length} of ${content.dashboards.length} dashboards are not shared with anyone.`, {
          remediation: 'They live in one account. When that person changes role the dashboard goes with them, and the work that went into it is gone.',
          source: SOURCE,
        }),
      );
    }

    const empty = content.dashboards.filter((dashboard) => dashboard.widgets.length === 0);
    if (empty.length > 0) {
      findings.push(info('aria.dashboards.empty', `${empty.length} dashboard${empty.length === 1 ? ' has' : 's have'} no widgets on ${empty.length === 1 ? 'it' : 'them'}.`, { source: SOURCE }));
    }

    if (content.views.length > 0) {
      const viewIds = new Set(content.views.map((view) => view.id));
      const referenced = new Set(content.dashboards.flatMap((dashboard) => dashboard.viewIds));
      const missing = [...referenced].filter((id) => !viewIds.has(id));
      if (missing.length > 0) {
        findings.push(
          warning('aria.dashboards.missing-view', `${missing.length} view${missing.length === 1 ? '' : 's'} used by a dashboard ${missing.length === 1 ? 'is' : 'are'} not in the export.`, {
            remediation: 'Either the views were not exported with the dashboards, or the widget shows an error where a table should be. Export the views and drop them in to tell the two apart.',
            source: SOURCE,
          }),
        );
      }
      const unusedViews = content.views.filter((view) => !referenced.has(view.id));
      if (unusedViews.length > 0) {
        findings.push(
          info('aria.views.unused', `${unusedViews.length} of ${content.views.length} view definitions are not on any dashboard in this export.`, {
            remediation: 'Views are also used directly and in reports, so this is not dead content — but it is where the unfinished ones are.',
            source: SOURCE,
          }),
        );
      }
    }
  }

  if (content.reports.length > 0) {
    const unscheduled = content.reports.filter((report) => report.scheduleCount === 0);
    if (unscheduled.length === content.reports.length) {
      findings.push(
        info('aria.reports.no-schedules', `None of the ${content.reports.length} report definitions have a schedule in this export.`, {
          remediation: 'Either the schedules were not exported, or every report is run by hand. Export reportschedules to tell the two apart.',
          source: SOURCE,
        }),
      );
    } else if (unscheduled.length > 0) {
      findings.push(
        warning('aria.reports.unscheduled', `${unscheduled.length} of ${content.reports.length} report definitions have no schedule, so nobody receives them.`, {
          remediation: 'A report that is defined and never sent is a report somebody asked for once. Schedule it or delete it.',
          source: SOURCE,
        }),
      );
    }
  }

  // --- the standing note -----------------------------------------------------

  findings.push(
    info('aria.privacy', 'These files stay on this machine. Nothing here is uploaded, and the toolkit makes no network calls.', {
      remediation: 'An Operations export contains estate names, email addresses and alerting thresholds — keep it out of a repository and out of a ticket attachment.',
      source: 'ArchToolKit',
    }),
  );

  return findings;
}

/** The counts the page puts across the top. */
export function ariaSummary(content             )                                                                                        {
  const unnotified = content.alerts.length > 0 ? unnotifiedAlerts(content).length : 0;
  return [
    { label: 'Alert definitions', value: content.alerts.length, note: content.alerts.length > 0 ? `${content.alerts.length - unnotified} notify someone` : undefined },
    { label: 'Symptoms', value: content.symptoms.length },
    { label: 'Recommendations', value: content.recommendations.length },
    { label: 'Policies', value: content.policies.length },
    { label: 'Custom groups', value: content.groups.length },
    { label: 'Super metrics', value: content.superMetrics.length },
    { label: 'Notification rules', value: content.rules.length, note: `${content.rules.filter((rule) => rule.enabled).length} enabled` },
    { label: 'Dashboards', value: content.dashboards.length, note: `${content.dashboards.filter((dashboard) => dashboard.shared).length} shared` },
    { label: 'Views', value: content.views.length },
    { label: 'Reports', value: content.reports.length, note: `${content.reports.filter((report) => report.scheduleCount > 0).length} scheduled` },
  ];
}
