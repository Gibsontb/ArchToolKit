/**
 * The Aria kit's own checks.
 *
 * The fixtures here are invented: made-up object names, made-up thresholds, an
 * example.com address. A real export is one customer's estate, thresholds and
 * mailboxes, and belongs nowhere near a repository — which is also what the
 * page says to the person using it.
 *
 * What is worth testing is the part that is easy to get quietly wrong: reading
 * a shape and getting nothing back, merging two files and losing the richer
 * half, and a coverage rule that says an alert is notified when it is not.
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { hasErrors } from '../core/findings.ts';
import { countBy, highestSeverity, merge, severityOf, EMPTY_CONTENT, type AriaContent } from './aria.ts';
import { decodeEntities, elements, readAriaFile, sniffJson, textOf, AriaError } from './parse.ts';
import { ariaFindings, ariaSummary, ruleCovers, unnotifiedAlerts } from './findings.ts';
import { zip } from '../testing/xlsx-fixture.ts';
import { openZip, looksLikeZip, stripBom } from '../core/zip.ts';

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);

// --- fixtures, all invented -------------------------------------------------

const ALERTS_JSON = JSON.stringify([
  {
    id: 'AlertDefinition-Example-DatastoreFull',
    name: 'Datastore is nearly full',
    description: 'The datastore has little space left.',
    adapterKindKey: 'VMWARE',
    resourceKindKey: 'Datastore',
    waitCycles: 1,
    cancelCycles: 2,
    states: [
      {
        severity: 'CRITICAL',
        'base-symptom-set': { symptomSetOperator: 'AND', symptomDefinitionIds: ['SymptomDefinition-Example-SpaceLow'] },
        impact: { impactType: 'BADGE', detail: 'health' },
        recommendationPriorityMap: { 'Recommendation-Example-AddCapacity': 1, 'Recommendation-Example-Delete': 2 },
      },
    ],
  },
  {
    id: 'AlertDefinition-Example-Orphan',
    name: 'Points at a symptom that is gone',
    adapterKindKey: 'VMWARE',
    resourceKindKey: 'VirtualMachine',
    states: [{ severity: 'WARNING', 'base-symptom-set': { symptomDefinitionIds: ['SymptomDefinition-Example-Deleted'] }, impact: { detail: 'risk' } }],
  },
  {
    id: 'AlertDefinition-Example-NoSymptoms',
    name: 'Cannot ever fire',
    adapterKindKey: 'VMWARE',
    resourceKindKey: 'HostSystem',
    states: [{ severity: 'WARNING', 'base-symptom-set': { symptomDefinitionIds: [] }, impact: { detail: 'health' } }],
  },
]);

const SYMPTOMS_JSON = JSON.stringify([
  {
    id: 'SymptomDefinition-Example-SpaceLow',
    name: 'Free space below 10%',
    adapterKindKey: 'VMWARE',
    resourceKindKey: 'Datastore',
    state: { severity: 'CRITICAL', condition: { type: 'CONDITION_HT', key: 'capacity|used_space_pct', operator: 'GT', value: '90.0', thresholdType: 'STATIC' } },
  },
  {
    id: 'SymptomDefinition-Example-Unused',
    name: 'Nothing references this',
    adapterKindKey: 'VMWARE',
    resourceKindKey: 'Datastore',
    state: { severity: 'WARNING', condition: { key: 'capacity|used_space_pct', operator: 'GT', value: '80.0', thresholdType: 'DYNAMIC' } },
  },
]);

const RULES_JSON = JSON.stringify([
  {
    id: 'rule-1',
    name: 'Storage team',
    enabled: true,
    ruleType: 'ALERT',
    criticalities: ['CRITICAL'],
    resourceKindFilters: [{ resourceKind: 'Datastore', adapterKind: 'VMWARE' }],
    alertDefinitionIdFilters: { values: [] },
    properties: [
      { name: 'emailaddr', value: 'storage-team@example.com' },
      { name: 'resend', value: '60' },
    ],
    pluginId: 'plugin-1',
  },
  {
    id: 'rule-2',
    name: 'Turned off last year',
    enabled: false,
    ruleType: 'ALERT',
    criticalities: [],
    resourceKindFilters: [],
    alertDefinitionIdFilters: { values: [] },
    properties: [{ name: 'emailaddr', value: 'alex.mercer@example.com' }],
    pluginId: 'plugin-1',
  },
]);

const GROUPS_JSON = JSON.stringify([
  {
    id: 'group-1',
    resourceKey: { name: 'Production VMs', adapterKindKey: 'Container', resourceKindKey: 'Environment' },
    policy: 'policy-default',
    autoResolveMembership: true,
    membershipDefinition: {
      includedResources: [],
      excludedResources: [],
      rules: [
        {
          resourceKindKey: { resourceKind: 'VirtualMachine', adapterKind: 'VMWARE' },
          propertyConditionRules: [{ key: 'summary|tag', stringValue: 'Production', compareOperator: 'CONTAINS' }],
          statConditionRules: [],
          resourceNameConditionRules: [],
          relationshipConditionRules: [],
          resourceTagConditionRules: [],
        },
      ],
    },
  },
  {
    id: 'group-2',
    resourceKey: { name: 'Never populated', adapterKindKey: 'Container', resourceKindKey: 'Environment' },
    policy: 'policy-tuned',
    membershipDefinition: { includedResources: [], excludedResources: [], rules: [] },
  },
]);

const POLICIES_JSON = JSON.stringify([
  { id: 'policy-default', name: 'Default Policy', defaultPolicy: true },
  { id: 'policy-tuned', name: 'Production Policy', defaultPolicy: false, priority: 1 },
]);

const POLICIES_XML = `<?xml version="1.0" encoding="UTF-8"?><PolicyContent>
  <Policies>
    <Policy description="" key="policy-tuned" name="Production Policy" parentPolicy="policy-default">
      <PackageSettings>
        <Alerts adapterKind="VMWARE" resourceKind="HostSystem">
          <Alert enabled="false" id="AlertDefinition-Example-NoSymptoms"/>
          <Alert enabled="true" id="AlertDefinition-Example-DatastoreFull"/>
        </Alerts>
      </PackageSettings>
    </Policy>
  </Policies>
</PolicyContent>`;

const SYMPTOMS_XML = `<?xml version="1.0" encoding="UTF-8"?><alertContent>
  <SymptomDefinitions>
    <SymptomDefinition adapterKind="VMWARE" id="SymptomDefinition-Example-SpaceLow" name="Free space below 10%" resourceKind="Datastore">
      <State severity="critical">
        <Condition key="capacity|used_space_pct" operator="&gt;" thresholdType="static" type="metric" value="90.0" valueType="numeric"/>
      </State>
    </SymptomDefinition>
  </SymptomDefinitions>
</alertContent>`;

const SUPER_METRICS_JSON = JSON.stringify({
  'sm-one': { name: 'Free ports on the port group', formula: '${this, metric=summary|max_num_ports}-${this, metric=summary|used_num_ports}' },
  'sm-two': { name: 'A placeholder nobody finished', formula: '0' },
  'sm-three': { name: 'Built on another', formula: '${this, metric=Super Metric|sm_00000000-0000-0000-0000-000000000000} * 2' },
});

async function read(name: string, text: string): Promise<AriaContent> {
  return readAriaFile(name, bytes(text));
}

// --- the XML helpers --------------------------------------------------------

describe('aria/parse: reading XML without a parser', () => {
  it('finds elements and their attributes, self-closed or not', () => {
    const found = elements('<a x="1"/><a x="2">inner</a>', 'a');
    expect(found.length).toBe(2);
    expect(found[0]?.attrs['x']).toBe('1');
    expect(found[1]?.inner).toBe('inner');
  });

  it('matches the right closing tag when the same tag is nested', () => {
    const found = elements('<p><p>inner</p>outer</p>', 'p');
    expect(found[0]?.inner).toBe('<p>inner</p>outer');
  });

  it('decodes the entities an export actually uses', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &#65;')).toBe('a & b <c> A');
    expect(textOf('<Title>Cisco UCS &amp; more</Title>', 'Title')).toBe('Cisco UCS & more');
  });
});

// --- reading each shape -----------------------------------------------------

describe('aria/parse: recognising a file by its shape', () => {
  it('tells the inventories apart without looking at the name', () => {
    expect(sniffJson(JSON.parse(ALERTS_JSON))).toBe('alerts');
    expect(sniffJson(JSON.parse(SYMPTOMS_JSON))).toBe('symptoms');
    expect(sniffJson(JSON.parse(RULES_JSON))).toBe('rules');
    expect(sniffJson(JSON.parse(GROUPS_JSON))).toBe('groups');
    expect(sniffJson(JSON.parse(POLICIES_JSON))).toBe('policies');
    expect(sniffJson([{ id: 'r1', description: 'Do the thing.' }])).toBe('recommendations');
  });

  it('reads an alert definition, including the recommendation map', async () => {
    const content = await read('alerts.json', ALERTS_JSON);
    expect(content.alerts.length).toBe(3);
    const first = content.alerts[0];
    expect(first?.name).toBe('Datastore is nearly full');
    expect(first?.severity).toBe('critical');
    expect(first?.states[0]?.symptomIds).toEqual(['SymptomDefinition-Example-SpaceLow']);
    // A map of id to priority, not a list. Read as a list it returns nothing,
    // and every alert looks as though it has no advice attached.
    expect(first?.states[0]?.recommendationIds).toEqual(['Recommendation-Example-AddCapacity', 'Recommendation-Example-Delete']);
  });

  it('survives a byte-order mark, which PowerShell writes and JSON.parse refuses', async () => {
    const content = await read('alerts.json', `﻿${ALERTS_JSON}`);
    expect(content.alerts.length).toBe(3);
  });

  it('reads a symptom’s condition, from JSON or from XML', async () => {
    const fromJson = await read('symptoms.json', SYMPTOMS_JSON);
    expect(fromJson.symptoms[0]?.key).toBe('capacity|used_space_pct');
    expect(fromJson.symptoms[0]?.thresholdType).toBe('STATIC');

    const fromXml = await read('symptomdefs.xml', SYMPTOMS_XML);
    expect(fromXml.symptoms.length).toBe(1);
    expect(fromXml.symptoms[0]?.severity).toBe('critical');
    expect(fromXml.symptoms[0]?.operator).toBe('>');
  });

  it('reads a group’s membership rules as something readable', async () => {
    const content = await read('groups.json', GROUPS_JSON);
    expect(content.groups.length).toBe(2);
    expect(content.groups[0]?.rules[0]?.conditions[0]).toBe('summary|tag CONTAINS Production');
    expect(content.groups[1]?.rules.length).toBe(0);
  });

  it('reads super metrics from the object-keyed file and spots what they depend on', async () => {
    const content = await read('supermetrics.json', SUPER_METRICS_JSON);
    expect(content.superMetrics.length).toBe(3);
    const chained = content.superMetrics.find((metric) => metric.name === 'Built on another');
    expect(chained?.dependsOn).toEqual(['00000000-0000-0000-0000-000000000000']);
  });

  it('reads the policies XML, including which alerts a policy turns off', async () => {
    const content = await read('policies.xml', POLICIES_XML);
    expect(content.policies.length).toBe(1);
    expect(content.policies[0]?.disabledAlerts).toEqual(['AlertDefinition-Example-NoSymptoms']);
    expect(content.policies[0]?.parentPolicyId).toBe('policy-default');
  });

  it('says what it does not recognise rather than reading it as nothing', async () => {
    let message = '';
    try {
      await read('something.json', '[{"unrelated": true}]');
    } catch (error) {
      message = error instanceof AriaError ? error.message : String(error);
    }
    expect(message.includes('does not recognise')).toBe(true);
  });
});

// --- merging ----------------------------------------------------------------

describe('aria/aria: merging what came from several files', () => {
  it('keeps the richer half of a record whichever order the files arrive in', async () => {
    const fromXml = await read('policies.xml', POLICIES_XML);
    const fromJson = await read('policies.json', POLICIES_JSON);

    // The JSON inventory has the whole list; the XML has what each policy
    // disables. Letting the later file replace the record threw one away.
    const forwards = merge(fromXml, fromJson);
    const backwards = merge(fromJson, fromXml);
    for (const merged of [forwards, backwards]) {
      const tuned = merged.policies.find((policy) => policy.id === 'policy-tuned');
      expect(tuned?.disabledAlerts?.length).toBe(1);
      expect(tuned?.priority).toBe(1);
      expect(merged.policies.length).toBe(2);
    }
  });

  it('does not double a file dropped twice', async () => {
    const once = await read('alerts.json', ALERTS_JSON);
    expect(merge(once, once).alerts.length).toBe(3);
  });

  it('counts by a key, most first', () => {
    expect(countBy(['a', 'b', 'a'], (x) => x)).toEqual([
      { name: 'a', count: 2 },
      { name: 'b', count: 1 },
    ]);
  });

  it('reads severity the way the export spells it', () => {
    expect(severityOf('CRITICAL')).toBe('critical');
    expect(severityOf('auto')).toBe('auto');
    expect(severityOf('')).toBe('unknown');
    expect(highestSeverity(['info', 'critical', 'warning'])).toBe('critical');
  });
});

// --- coverage and findings --------------------------------------------------

async function estate(): Promise<AriaContent> {
  let content = EMPTY_CONTENT;
  for (const [name, text] of [
    ['alerts.json', ALERTS_JSON],
    ['symptoms.json', SYMPTOMS_JSON],
    ['rules.json', RULES_JSON],
    ['groups.json', GROUPS_JSON],
    ['policies.json', POLICIES_JSON],
    ['supermetrics.json', SUPER_METRICS_JSON],
  ] as const) {
    content = merge(content, await read(name, text));
  }
  return content;
}

describe('aria/findings: what is wrong with the monitoring', () => {
  it('only counts an enabled rule as covering an alert', async () => {
    const content = await estate();
    const rule = content.rules[0];
    const disabled = content.rules[1];
    const datastore = content.alerts.find((alert) => alert.resourceKind === 'Datastore');
    const vm = content.alerts.find((alert) => alert.resourceKind === 'VirtualMachine');
    if (!rule || !disabled || !datastore || !vm) throw new Error('fixture');

    expect(ruleCovers(rule, datastore)).toBe(true);
    // Wrong object kind for this rule's filter.
    expect(ruleCovers(rule, vm)).toBe(false);
    // The disabled rule has no filters at all and still covers nothing.
    expect(ruleCovers(disabled, vm)).toBe(false);
  });

  it('lists the alerts nobody would hear about', async () => {
    const content = await estate();
    const unnotified = unnotifiedAlerts(content).map((alert) => alert.id);
    expect(unnotified).toEqual(['AlertDefinition-Example-Orphan', 'AlertDefinition-Example-NoSymptoms']);
  });

  it('treats every alert as unnotified when there are no rules at all', async () => {
    const content = await read('alerts.json', ALERTS_JSON);
    expect(unnotifiedAlerts(content).length).toBe(3);
  });

  it('finds the things that cannot be seen one object at a time', async () => {
    const content = await estate();
    const codes = ariaFindings(content).map((finding) => finding.code);

    expect(codes.includes('aria.alerts.unnotified')).toBe(true);
    expect(codes.includes('aria.alerts.missing-symptom')).toBe(true);
    expect(codes.includes('aria.alerts.no-symptoms')).toBe(true);
    expect(codes.includes('aria.symptoms.orphan')).toBe(true);
    expect(codes.includes('aria.rules.disabled')).toBe(true);
    expect(codes.includes('aria.groups.default-policy')).toBe(true);
    expect(codes.includes('aria.groups.empty')).toBe(true);
    expect(codes.includes('aria.supermetrics.constant')).toBe(true);
    expect(codes.includes('aria.privacy')).toBe(true);
  });

  it('calls a deleted symptom an error, because that alert can never fire', async () => {
    const content = await estate();
    const findings = ariaFindings(content);
    expect(hasErrors(findings)).toBe(true);
    expect(findings.find((finding) => finding.code === 'aria.alerts.missing-symptom')?.severity).toBe('error');
  });

  it('spots a personal mailbox but not a team one', async () => {
    const content = await estate();
    const finding = ariaFindings(content).find((f) => f.code === 'aria.rules.personal-mailbox');
    expect(finding !== undefined).toBe(true);
    expect(finding?.path?.includes('alex.mercer@example.com')).toBe(true);
    expect(finding?.path?.includes('storage-team@example.com')).toBe(false);
  });

  it('says nothing at all about an empty read', () => {
    const findings = ariaFindings(EMPTY_CONTENT);
    expect(findings.length).toBe(1);
    expect(findings[0]?.code).toBe('aria.privacy');
    expect(hasErrors(findings)).toBe(false);
  });

  it('summarises what came in, with the notified count beside the alerts', async () => {
    const content = await estate();
    const summary = ariaSummary(content);
    const alerts = summary.find((entry) => entry.label === 'Alert definitions');
    expect(alerts?.value).toBe(3);
    expect(alerts?.note).toBe('1 notify someone');
  });
});

// --- the content package ----------------------------------------------------

const DASHBOARD_JSON = JSON.stringify({
  uuid: 'dash-1',
  dashboards: [
    {
      id: 'dash-1',
      name: 'Datastore capacity',
      shared: true,
      columnCount: 2,
      creationTime: 1700000000000,
      widgets: [
        { type: 'View', title: 'Used space by datastore', config: { viewDefinitionId: 'view-1' } },
        { type: 'Scoreboard', title: 'Headroom', config: {} },
      ],
    },
  ],
});

const VIEWS_XML = `<?xml version="1.0" encoding="UTF-8"?><Content><Views>
  <ViewDef id="view-1"><Title>Used space by datastore</Title><Description/><SubjectType adapterKind="VMWARE" resourceKind="Datastore" type="descendant"/></ViewDef>
  <ViewDef id="view-2"><Title>On no dashboard</Title><Description/><SubjectType adapterKind="VMWARE" resourceKind="HostSystem" type="descendant"/></ViewDef>
</Views></Content>`;

describe('core/zip: reading an archive with nothing but the platform', () => {
  it('reads back what it was given, stored or deflated', async () => {
    const bytes = await zip({ 'a.txt': 'hello', 'b.txt': 'world' }, ['b.txt']);
    expect(looksLikeZip(bytes)).toBe(true);
    const archive = openZip(bytes);
    expect(archive.names).toEqual(['a.txt', 'b.txt']);
    expect(await archive.text('a.txt')).toBe('hello');
    expect(await archive.text('b.txt')).toBe('world');
  });

  it('takes the byte-order mark off text, so JSON.parse does not refuse it', async () => {
    const archive = openZip(await zip({ 'x.json': '\ufeff{"a":1}' }));
    expect(await archive.text('x.json')).toBe('{"a":1}');
    expect(stripBom('\ufeffabc')).toBe('abc');
  });

  it('says so rather than returning nothing when it is not a zip', () => {
    let message = '';
    try {
      openZip(new TextEncoder().encode('not a zip at all, just some text'));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message.includes('not a zip')).toBe(true);
  });
});

describe('aria/parse: the content package', () => {
  it('reads the whole package, including the zip inside the zip', async () => {
    const dashboardArchive = await zip({ 'dashboard/dashboard.json': DASHBOARD_JSON });
    const viewsArchive = await zip({ 'content.xml': VIEWS_XML });
    const pkg = await zip({
      'alertdefs.xml': `<?xml version="1.0"?><alertContent><AlertDefinitions>
        <AlertDefinition adapterKind="VMWARE" description="Little space left." id="AlertDefinition-Example-DatastoreFull" name="Datastore is nearly full" resourceKind="Datastore">
          <State severity="critical"><SymptomSet applyOn="self" operator="and" ref="SymptomDefinition-Example-SpaceLow"/><Impact key="health" type="badge"/></State>
        </AlertDefinition>
      </AlertDefinitions></alertContent>`,
      'symptomdefs.xml': SYMPTOMS_XML,
      'policies.xml': POLICIES_XML,
      'customgroups.json': JSON.stringify({ customGroups: JSON.parse(GROUPS_JSON), customGroupTypes: [] }),
      'supermetrics.json': SUPER_METRICS_JSON,
      'notificationrules.json': JSON.stringify({ NotificationRules: JSON.parse(RULES_JSON) }),
      'views.zip': viewsArchive,
      'dashboards/dash-1': dashboardArchive,
      'reportschedules/sched-1': JSON.stringify({ reportSchedules: [{ reportScheduleID: 's1', reportDefinitionID: 'report-1' }] }),
    });

    const content = await readAriaFile('export.zip', pkg);
    expect(content.alerts.length).toBe(1);
    expect(content.alerts[0]?.name).toBe('Datastore is nearly full');
    expect(content.symptoms.length).toBe(1);
    expect(content.policies.length).toBe(1);
    expect(content.groups.length).toBe(2);
    expect(content.superMetrics.length).toBe(3);
    expect(content.rules.length).toBe(2);
    expect(content.views.length).toBe(2);
    expect(content.dashboards.length).toBe(1);
    expect(content.dashboards[0]?.widgets.length).toBe(2);
    // The view a widget shows, which is what makes "this dashboard is broken"
    // answerable without opening it.
    expect(content.dashboards[0]?.viewIds).toEqual(['view-1']);
  });

  it('reads a single dashboard archive dropped on its own', async () => {
    const dashboardArchive = await zip({ 'dashboard/dashboard.json': DASHBOARD_JSON });
    const content = await readAriaFile('dash-1', dashboardArchive);
    expect(content.dashboards.length).toBe(1);
    expect(content.dashboards[0]?.shared).toBe(true);
  });

  it('notices a view that no dashboard uses, and one a dashboard wants but has not got', async () => {
    const viewsArchive = await zip({ 'content.xml': VIEWS_XML });
    const dashboardArchive = await zip({
      'dashboard/dashboard.json': JSON.stringify({
        dashboards: [{ id: 'dash-2', name: 'Missing its view', shared: false, widgets: [{ type: 'View', title: 'gone', config: { viewDefinitionId: 'view-404' } }] }],
      }),
    });
    const pkg = await zip({ 'views.zip': viewsArchive, 'dashboards/dash-2': dashboardArchive });
    const content = await readAriaFile('export.zip', pkg);
    const codes = ariaFindings(content).map((finding) => finding.code);
    expect(codes.includes('aria.dashboards.missing-view')).toBe(true);
    expect(codes.includes('aria.views.unused')).toBe(true);
    expect(codes.includes('aria.dashboards.unshared')).toBe(true);
  });
});
