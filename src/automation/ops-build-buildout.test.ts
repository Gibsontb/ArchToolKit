/**
 * VCF Operations build: views, reports, application monitoring and HCX.
 *
 * Every blueprint in vcf-ops-build.ts builds from its defaults and from each
 * select option and toggle flipped, writes XML that parses, JSON that parses
 * and bash that bash reads, and keeps the house rules. Then the view and report
 * shapes are checked against the element names real exports carry, and the
 * findings each blueprint exists to raise.
 */

import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { expect } from '../testing/expect.ts';
import { defaultValues, type BlueprintValues } from '../kit/blueprint.ts';
import { hasErrors } from '../core/findings.ts';
import { stableId } from './vcfops-import.ts';
import { VCF_OPS_BUILD, parseReportContent, parseTelegrafRows, parseViewColumns } from './blueprints/vcf-ops-build.ts';

const MINE = VCF_OPS_BUILD;
const find = (id: string) => {
  const blueprint = MINE.find((b) => b.id === id);
  if (!blueprint) throw new Error(`missing ${id}`);
  return blueprint;
};

function variants(id: string): { label: string; values: BlueprintValues }[] {
  const blueprint = find(id);
  const base = defaultValues(blueprint);
  const out: { label: string; values: BlueprintValues }[] = [{ label: 'defaults', values: { ...base } }];
  for (const input of blueprint.inputs) {
    if (input.control === 'select') for (const option of input.options ?? []) out.push({ label: `${input.id}=${option.value}`, values: { ...base, [input.id]: option.value } });
    if (input.control === 'toggle') out.push({ label: `${input.id}=${String(!base[input.id])}`, values: { ...base, [input.id]: !base[input.id] } });
  }
  // The custom view and each of its presentations, not only the templates.
  if (id === 'vcfops_view') {
    for (const presentation of ['list', 'summary', 'trend', 'distribution', 'text', 'image']) out.push({ label: `custom ${presentation}`, values: { ...base, template: 'custom', presentation } });
    for (const breakdown of ['time', 'property', 'relationship']) out.push({ label: `custom breakdown ${breakdown}`, values: { ...base, template: 'custom', breakdown } });
    for (const buckets of ['discrete', 'ranges', 'equal']) out.push({ label: `distribution ${buckets}`, values: { ...base, template: 'custom', presentation: 'distribution', buckets } });
  }
  return out;
}

const build = (id: string, overrides: BlueprintValues = {}) => find(id).build({ ...defaultValues(find(id)), ...overrides }, id);
const codes = (id: string, overrides: BlueprintValues = {}) => (build(id, overrides).findings ?? []).map((f) => f.code);
const allCodes = (id: string, overrides: BlueprintValues = {}) => (find(id).automation({ ...defaultValues(find(id)), ...overrides }, id).findings ?? []).map((f) => f.code);
const file = (id: string, path: string, overrides: BlueprintValues = {}) => build(id, overrides).files[path] ?? '';

const bash = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0;

/** Well-formed enough: every open tag closed in order (no DTD, no CDATA here). */
function xmlProblems(text: string): string[] {
  const stack: string[] = [];
  const problems: string[] = [];
  const body = text.replace(/<\?xml[^>]*\?>/, '');
  for (const match of body.matchAll(/<(\/?)([A-Za-z][\w.-]*)([^>]*?)(\/?)>/g)) {
    const [, close, tag, , self] = match;
    if (self) continue;
    if (close) {
      if (stack.pop() !== tag) problems.push(`unexpected </${tag}>`);
    } else stack.push(tag!);
  }
  if (stack.length > 0) problems.push(`unclosed ${stack.join(', ')}`);
  if (/<[^>]*<(?!\/)/.test(body.replace(/<!--.*?-->/g, ''))) problems.push('a < inside a tag');
  return problems;
}

describe('ops build build-out: every blueprint, every option', () => {
  it('has the blueprints this area owns', () => {
    for (const id of ['vcfops_view', 'vcfops_report', 'vcfops_app_monitoring', 'vcfops_hcx_lifecycle', 'vcfops_integrations_hcx', 'vcfops_dashboard']) {
      expect(find(id).platform).toBe('vcf-operations');
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
            if (path.endsWith('.xml')) for (const p of xmlProblems(body)) problems.push(`${blueprint.id} ${variant.label}: ${path}: ${p}`);
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
    for (const id of ['vcfops_view', 'vcfops_report', 'vcfops_app_monitoring', 'vcfops_hcx_lifecycle']) {
      for (const variant of variants(id)) {
        for (const [path, body] of Object.entries(find(id).build(variant.values, id).files)) {
          if (!path.endsWith('.sh')) continue;
          const result = spawnSync('bash', ['-n'], { input: body, encoding: 'utf8' });
          if (result.status !== 0) problems.push(`${id} ${variant.label} ${path}: ${result.stderr.trim().slice(0, 200)}`);
        }
      }
    }
    expect([...new Set(problems)]).toEqual([]);
  });

  it('keeps the house rules in every file: 9.1 names, nothing retired, no footprint, no share publishing', () => {
    const problems: string[] = [];
    for (const blueprint of MINE) {
      const labels = [blueprint.label, blueprint.description, ...blueprint.inputs.flatMap((input) => [input.label, input.hint ?? '', input.help ?? '', ...(input.options ?? []).map((option) => option.label)])].join('\n');
      if (/\bESXi\b|\bAria\b|vRealize|vROps|Service Broker/.test(labels)) problems.push(`${blueprint.id}: old name in the form`);
      for (const variant of variants(blueprint.id)) {
        for (const [path, body] of Object.entries(blueprint.build(variant.values, blueprint.id).files)) {
          if (path === 'README.md') continue;
          if (/archtoolkit|generated by/i.test(body)) problems.push(`${blueprint.id} ${variant.label} ${path}: footprint`);
          if (/\bESXi\b|vRealize|vROps|Service Broker|\bAria\b/.test(body)) problems.push(`${blueprint.id} ${variant.label} ${path}: old name`);
          if (/relativePath|networkShare|NetworkShare/.test(body)) problems.push(`${blueprint.id} ${variant.label} ${path}: network-share publishing`);
        }
      }
    }
    expect([...new Set(problems)]).toEqual([]);
  });
});

describe('vcfops_view: every presentation, as the exports write it', () => {
  const xmlOf = (overrides: BlueprintValues) => file('vcfops_view', 'import/view.xml', { template: 'custom', ...overrides });

  it('keeps the template views the dashboards point at, by name-derived id', () => {
    expect(file('vcfops_view', 'import/view.xml').includes(`<ViewDef id="${stableId('view:Cluster capacity overview')}">`)).toBe(true);
    // The certificate template reads the infrastructure-health certificate objects, with no <REQUIRED> left.
    const certs = file('vcfops_view', 'import/view.xml', { template: 'certs' });
    expect(certs).toContain('resourceKind="CERTIFICATE"');
    expect(certs).toContain('CERTIFICATE_INFO|NO_OF_DAYS_TO_EXPIRE');
    expect(certs.includes('REQUIRED')).toBe(false);
  });

  it('writes list, summary, trend, distribution, text and image with the right provider and presentation', () => {
    expect(xmlOf({ presentation: 'list' })).toContain('<DataProvider dataType="list-view"');
    expect(xmlOf({ presentation: 'summary' })).toContain('<Presentation type="summary"/>');
    expect(xmlOf({ presentation: 'summary' })).toContain('name="aggregation" value="SUM"');
    const trend = xmlOf({ presentation: 'trend', forecast_days: 30, columns: 'cpu|usage_average | CPU | avg' });
    expect(trend).toContain('<DataProvider dataType="trend-view"');
    expect(trend).toContain('<Presentation type="line-chart"/>');
    for (const t of ['NONE', 'TREND', 'FORECAST']) expect(trend).toContain(`<Item value="${t}"/>`);
    expect(trend).toContain('name="forecastDays" value="30"');
    const noLine = xmlOf({ presentation: 'trend', trend_line: false, columns: 'cpu|usage_average | CPU | current' });
    expect(noLine.includes('"TREND"')).toBe(false);
    for (const chart of ['bar-chart', 'pie-chart', 'donut-chart']) expect(xmlOf({ presentation: 'distribution', distribution_chart: chart })).toContain(`<Presentation type="${chart}"/>`);
    expect(xmlOf({ presentation: 'distribution' })).toContain('<DataProvider dataType="distribution-view"');
    const text = xmlOf({ presentation: 'text', text_body: '<b>Hello</b>' });
    expect(text).toContain('<Presentation type="text">');
    expect(text).toContain('value="&lt;b&gt;Hello&lt;/b&gt;"');
    expect(text.includes('<SubjectType')).toBe(false);
    const image = build('vcfops_view', { template: 'custom', presentation: 'image' });
    expect(image.files['import/view.xml']).toContain('<Presentation type="image">');
    expect(image.files['import/view.xml']).toContain('&lt;REQUIRED: IMAGE_BASE64');
    expect(image.files['embed-image.sh']).toContain('IMAGE_BASE64');
    expect((image.findings ?? []).some((f) => f.code === 'vcfops.view.image')).toBe(true);
  });

  it('writes each column’s transformation, percentile, unit and sort', () => {
    const view = xmlOf({ columns: 'cpu|usage_average | Avg | avg | percent\ncpu|readyPct | P99 | percentile 99 | percent\nmem|guest_usage | Max | max | gb\ndisk|x | Min | min |\nnet|y | Sum | sum |\ncpu|z | First | first |\ncpu|w | Last | last |\nconfig|createDate | Created | timestamp |', sort_column: 'P99' });
    for (const t of ['AVG', 'PERCENTILE', 'MAX', 'MIN', 'SUM', 'FIRST', 'LAST', 'TIMESTAMP']) expect(view).toContain(`<Item value="${t}"/>`);
    expect(view).toContain('name="percentile" value="99"');
    expect(view).toContain('name="preferredUnitId" value="gb"');
    expect(view.match(/sortCriteria" value="true"/g)?.length).toBe(1);
    expect(parseViewColumns('a|b | A | percentile', 90).columns[0]?.percentile).toBe(90);
    // The old three-cell form still reads.
    expect(parseViewColumns('config|x | X | property', 95).columns[0]?.property).toBe(true);
    expect(parseViewColumns('a|b | A | median', 95).problems.length).toBe(1);
  });

  it('writes time ranges, top-N, visibility, subjects and the subject filter', () => {
    const rel = xmlOf({ time_mode: 'relative', time_unit: 'DAYS', time_count: 30 });
    expect(rel).toContain('name="unit" value="DAYS"');
    expect(rel).toContain('name="count" value="30"');
    expect(xmlOf({ time_mode: 'advanced' })).toContain('name="startPeriod" value="PREVIOUS"');
    expect(xmlOf({ time_mode: 'absolute' })).toContain('name="advancedTimeMode" value="true"');
    expect(allCodes('vcfops_view', { template: 'custom', time_mode: 'absolute' })).toContain('vcfops.view.absolute-range');
    expect(codes('vcfops_view', { template: 'custom', time_mode: 'absolute', time_from: '2026-06-30', time_to: '2026-01-01' })).toContain('vcfops.view.bad-range');
    expect(xmlOf({ top_n: 10 })).toContain('name="listTopResultSize" value="10"');
    const hidden = xmlOf({ visibility: 'dashboard' });
    expect(hidden.includes('<Usage>report</Usage>')).toBe(false);
    expect(hidden).toContain('<Usage>dashboard</Usage>');
    expect(codes('vcfops_view', { visibility: '' })).toContain('vcfops.view.invisible');
    const multi = xmlOf({ more_kinds: 'HostSystem', columns: 'cpu|usage_average | CPU | current\nsummary|parentCluster | Cluster | property | | VirtualMachine' });
    expect(multi).toContain('resourceKind="HostSystem" type="descendant"');
    // An unbound column on a multi-subject view carries no kind; a bound one does.
    const firstItem = multi.slice(multi.indexOf('cpu|usage_average'), multi.indexOf('</Item>', multi.indexOf('cpu|usage_average')));
    expect(firstItem.includes('resourceKind')).toBe(false);
    expect(codes('vcfops_view', { template: 'custom', columns: 'a|b | A | current | | Datastore' })).toContain('vcfops.view.column-kind');
    expect(xmlOf({ subject_relation: 'descendant' }).includes('type="self"')).toBe(false);
    const filtered = xmlOf({ subject_filter: 'properties | summary|runtime|powerState | NOT_CONTAINS | Powered Off\nmetrics | cpu|usage_average | GREATER_THAN | 50' });
    expect(filtered).toContain('filter="[[{&quot;condition&quot;:&quot;NOT_CONTAINS&quot;');
    expect(filtered).toContain('&quot;isStringMetric&quot;:false,&quot;value&quot;:50');
    expect(codes('vcfops_view', { template: 'custom', subject_filter: 'properties | x|y | LIKE | z' })).toContain('vcfops.view.bad-filter');
  });

  it('breaks down by period, property or relationship, and reads related columns', () => {
    expect(xmlOf({ breakdown: 'time', breakdown_unit: 'MONTHS' })).toContain('name="breakdownBy" value="MONTHS"');
    expect(xmlOf({ breakdown: 'relationship' })).toContain('name="relatedRelationType" value="ANCESTOR"');
    const byProperty = xmlOf({ breakdown: 'property', breakdown_property: 'summary|parentHost' });
    expect(byProperty.indexOf('summary|parentHost')).toBeLessThan(byProperty.indexOf('cpu|usage_average'));
    expect(parseViewColumns('descendant(VirtualMachine) cpu|usage_average | VM CPU | avg', 95).columns[0]?.related?.relation).toBe('DESCENDANT');
  });

  it('buckets a distribution the way that works for a property, and says when it will not', () => {
    const discrete = xmlOf({ presentation: 'distribution', columns: 'summary|version | Version | property', kind: 'HostSystem' });
    expect(discrete).toContain('name="dynamicCalcFunction" value="DISCRETE"');
    expect(discrete).toContain('name="isStringAttribute" value="true"');
    expect(codes('vcfops_view', { template: 'custom', presentation: 'distribution', buckets: 'equal', columns: 'summary|version | Version | property' })).toContain('vcfops.view.distribution-property');
    expect(xmlOf({ presentation: 'distribution', buckets: 'ranges', bucket_ranges: '0-2, 2-5' })).toContain('name="dynamicCalcFunction" value="SIMPLEMAXMIN"');
    expect(codes('vcfops_view', { template: 'custom', presentation: 'distribution', buckets: 'ranges', bucket_ranges: 'lots' })).toContain('vcfops.view.bad-ranges');
  });

  it('catches a bad key, a sort on nothing, and a trend over a property', () => {
    expect(codes('vcfops_view', { template: 'custom', columns: 'cpu||usage | Broken | current' })).toContain('vcfops.view.bad-key');
    expect(codes('vcfops_view', { sort_column: 'Nothing like it' })).toContain('vcfops.view.sort-column');
    expect(codes('vcfops_view', { template: 'custom', presentation: 'trend' })).toContain('vcfops.view.trend-property');
  });

  it('offers every common object type in the kind combo', () => {
    const kinds = (find('vcfops_view').inputs.find((i) => i.id === 'kind')?.options ?? []).map((o) => o.value);
    for (const kind of ['VirtualMachine', 'HostSystem', 'ClusterComputeResource', 'Datastore', 'VMwareAdapter Instance', 'GuestCluster', 'Namespace', 'VirtualAndPhysicalSANAdapter/VirtualSANDCCluster', 'NSXTAdapter/TransportNode', 'KubernetesAdapter/K8S-Namespace']) expect(kinds).toContain(kind);
    expect(find('vcfops_view').inputs.find((i) => i.id === 'kind')?.control).toBe('combo');
  });
});

describe('vcfops_report: cadence, content and delivery', () => {
  it('mixes views and dashboards, with cover, TOC, footer and orientation', () => {
    const xml = file('vcfops_report', 'import/report.xml');
    expect(xml).toContain('<ContentType>Dashboard</ContentType>');
    expect(xml).toContain(`<ContentKey>${stableId('dashboard:Cluster capacity overview')}</ContentKey>`);
    expect(xml).toContain(`<ContentKey>${stableId('view:Reclamation')}</ContentKey>`);
    expect(xml).toContain('<ColorizeListView>true</ColorizeListView>');
    const bare = file('vcfops_report', 'import/report.xml', { cover_page: false, toc: false, footer: false, content: 'view | Reclamation | Portrait | no' });
    expect(bare.includes('COVER_PAGE')).toBe(false);
    expect(bare.includes('TABLE_OF_CONTENTS')).toBe(false);
    expect(bare).toContain('<ShowPageFooter>false</ShowPageFooter>');
    expect(bare).toContain('<ContentOrientation>Portrait</ContentOrientation>');
    expect(parseReportContent('Cluster capacity overview', 'Landscape').rows[0]?.type).toBe('View');
    expect(parseReportContent('dashboard | id:0f03a591-0e03-43fe-ad03-a26b0c03a0d8 | |', 'Landscape').rows[0]?.id).toBe('0f03a591-0e03-43fe-ad03-a26b0c03a0d8');
  });

  it('schedules daily, weekly and monthly with recurrence, through the named email instance, for an object or a group', () => {
    const weekly = JSON.parse(file('vcfops_report', 'vcfops-report-schedule.json', { cadence: 'weekly', weekdays: 'MONDAY, FRIDAY', every: 2 })) as Record<string, unknown>;
    expect(weekly['reportScheduleType']).toBe('WEEKLY');
    expect(weekly['recurrence']).toBe(2);
    expect(weekly['daysOfTheWeek']).toEqual(['MONDAY', 'FRIDAY']);
    expect('relativePath' in weekly).toBe(false);
    const daily = JSON.parse(file('vcfops_report', 'vcfops-report-schedule.json', { cadence: 'daily' })) as Record<string, unknown>;
    expect(daily['reportScheduleType']).toBe('DAILY');
    const monthly = JSON.parse(file('vcfops_report', 'vcfops-report-schedule.json', { day_of_month: 15 })) as Record<string, unknown>;
    expect(monthly['dayOfTheMonth']).toBe(15);
    const script = file('vcfops_report', 'schedule-report.sh', { email_instance: 'Team mail', subject_mode: 'group', subject_name: 'Production' });
    expect(script).toContain('alertplugins');
    expect(script).toContain('StandardEmailPlugin');
    expect(script).toContain('resources/groups');
    expect(script).toContain('--again');
  });

  it('catches what would make a schedule deliver nothing', () => {
    expect(codes('vcfops_report', { recipients: '' })).toContain('vcfops.report.no-recipient');
    expect(codes('vcfops_report', { recipients: 'not-an-address' })).toContain('vcfops.report.bad-address');
    expect(codes('vcfops_report', { cadence: 'weekly', weekdays: '' })).toContain('vcfops.report.no-day');
    expect(codes('vcfops_report', { start_time: '25:00' })).toContain('vcfops.report.bad-time');
    expect(codes('vcfops_report', { content: '' })).toContain('vcfops.report.no-views');
    expect(codes('vcfops_report', { content: 'widget | x | |' })).toContain('vcfops.report.bad-section');
    expect(codes('vcfops_report', { formats: 'csv' })).toContain('vcfops.report.csv-dashboard');
    expect(codes('vcfops_report', { day_of_month: 31 })).toContain('vcfops.report.short-month');
  });
});

describe('vcfops_app_monitoring: Telegraf through a cloud proxy', () => {
  it('writes every plugin as an open-source Telegraf input, with accounts from the environment', () => {
    const plugins = 'apache | web01 | status_path=/server-status?auto |\nnginx | web02:8080 | |\nmysql | db01:3306 | user=svc | MYSQL\npostgres | db02 | dbname=app | PG\nmssql | sql01 | | SQL\niis | web03 | |\nping | 2001:db8::1 | count=5 |\ncustom | /opt/checks/app.sh | timeout=10s |';
    const toml = file('vcfops_app_monitoring', 'telegraf.d/vcfops-inputs.conf', { plugins });
    for (const input of ['apache', 'nginx', 'mysql', 'postgresql', 'sqlserver', 'win_perf_counters', 'ping', 'exec']) expect(toml).toContain(`[[inputs.${input}]]`);
    expect(toml).toContain('${MYSQL_PASSWORD}');
    expect(toml).toContain('${PG_USER}');
    expect(toml).toContain('ipv6 = true');
    expect(toml).toContain('tcp(db01:3306)');
    const apply = file('vcfops_app_monitoring', 'apply-app-monitoring.sh', { plugins });
    expect(apply).toContain('applications/agents');
    expect(apply).toContain('SQL_PASSWORD');
    expect(apply).toContain('Manage Telegraf Agents');
  });

  it('onboards open-source Telegraf with the cloud proxy helper, testing first', () => {
    const script = file('vcfops_app_monitoring', 'onboard-telegraf.sh', { agent: 'opensource', plugins: 'ping | 10.0.0.1 | |' });
    expect(script).toContain('opensource -c "$PROXY"');
    expect(script).toContain('telegraf --config-directory "$WORK" --test');
    expect(script).toContain('EnvironmentFile=/etc/telegraf/vcfops.env');
    expect(script).toContain('systemctl enable telegraf');
  });

  it('catches missing accounts, unknown plugins, IIS on the Linux route and relative scripts', () => {
    const rows = parseTelegrafRows('mysql | db01 | |\nredis | r1 | |\ncustom | app.sh | |\nmysql | db01 | password=x | MYSQL');
    expect(rows.problems.length).toBe(4);
    expect(codes('vcfops_app_monitoring', { plugins: 'mysql | db01 | |' })).toContain('vcfops.telegraf.bad-row');
    expect(codes('vcfops_app_monitoring', { agent: 'opensource', plugins: 'iis | web01 | |' })).toContain('vcfops.telegraf.iis-linux');
    expect(codes('vcfops_app_monitoring', { interval: 10 })).toContain('vcfops.telegraf.interval');
    expect(codes('vcfops_app_monitoring', { vms: '' })).toContain('vcfops.telegraf.no-targets');
  });
});

describe('vcfops_hcx_lifecycle: HCX through fleet lifecycle', () => {
  it('upgrades through a plan, the enhanced precheck, a backup and a change reference', () => {
    const script = file('vcfops_hcx_lifecycle', 'hcx-lifecycle.sh');
    expect(script).toContain('componentsFilter: ["HCX"]');
    expect(script).toContain('"precheckType":"ENHANCED"');
    expect(script).toContain('need_change');
    expect(script).toContain('/backups');
    expect(find('vcfops_hcx_lifecycle').automation(defaultValues(find('vcfops_hcx_lifecycle')), 'x').effect).toBe('irreversible');
  });

  it('deploys from a spec with passwords from files, dual stack when asked', () => {
    const out = build('vcfops_hcx_lifecycle', { action: 'deploy', ipv6: '2001:db8::40/64', ipv6_gateway: '2001:db8::1' });
    const spec = JSON.parse(out.files['hcx-deploy.json']!) as { spec: { network: { ipv6?: { address: string } }; adminPassword: string } };
    expect(spec.spec.network.ipv6?.address).toBe('2001:db8::40');
    expect(spec.spec.adminPassword.startsWith('<set by')).toBe(true);
    expect(out.files['hcx-lifecycle.sh']).toContain('HCX_ADMIN_PASSWORD_FILE');
    expect(codes('vcfops_hcx_lifecycle', { action: 'deploy', ip: '10.0.10.40' })).toContain('vcfops.hcxlcm.bad-ip');
    expect(codes('vcfops_hcx_lifecycle', { action: 'deploy', ipv6: '2001:db8::40/64' })).toContain('vcfops.hcxlcm.bad-ipv6-gateway');
    expect(codes('vcfops_hcx_lifecycle', { target_version: 'latest' })).toContain('vcfops.hcxlcm.bad-version');
  });

  it('adds the HCX management pack account afterwards, and only reads for an inventory', () => {
    expect(file('vcfops_hcx_lifecycle', 'hcx-lifecycle.sh')).toContain('HCXAdapter');
    expect(file('vcfops_hcx_lifecycle', 'hcx-lifecycle.sh', { add_account: false }).includes('HCXAdapter')).toBe(false);
    expect(find('vcfops_hcx_lifecycle').automation({ ...defaultValues(find('vcfops_hcx_lifecycle')), action: 'inventory' }, 'x').effect).toBe('read');
  });
});
