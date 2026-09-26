/**
 * Splunk search head: the things people actually build.
 *
 * Saved searches and reports, alerts, dashboards, macros, lookups, event types
 * and data model acceleration. All of it search-time, which is what a search
 * head is for — index-time settings here do nothing at all, silently, and the
 * standing checks say so if one turns up.
 *
 * Every generated search is written the way a search that has to run on a
 * schedule should be: the index and sourcetype first so the filter happens at
 * the earliest possible point, no leading wildcards, `tstats` where the data
 * model allows it, and a time window that overlaps its schedule so a late event
 * is not missed.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, warning,              } from '../../core/findings.js';
import { splunkBlueprint,                      } from '../from-app.js';
import { defaultMeta, foldSearch, listOf, searchTitle, searchWindow, splunkName, spreadCron,                } from '../splunk.js';

const TIER = 'search_head'         ;

export const SEARCH_HEAD_BLUEPRINTS                             = [
  splunkBlueprint({
    id: 'splunk_saved_search',
    tier: TIER,
    label: 'Saved search or report',
    group: 'Searches',
    description: 'A search written the way one that runs on a schedule has to be: filtered at the index, no leading wildcards, and a window that overlaps its own schedule.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_reporting' },
      { id: 'title', label: 'Search name', control: 'text', default: 'Failed logins by source' },
      { id: 'index', label: 'Index', control: 'text', default: 'wineventlog' },
      { id: 'sourcetype', label: 'Sourcetype', control: 'text', default: 'WinEventLog:Security' },
      { id: 'filter', label: 'Filter', control: 'text', default: 'EventCode=4625', hint: 'Field=value terms — these run at the index, so put as much here as possible' },
      { id: 'shape', label: 'What it produces', control: 'select', default: 'stats', options: [
        { value: 'stats', label: 'A table — stats by field' },
        { value: 'timechart', label: 'A time series — timechart' },
        { value: 'top', label: 'A top N list' },
        { value: 'raw', label: 'Raw events' },
      ] },
      { id: 'by_fields', label: 'Group by', control: 'text', default: 'Account_Name, src_ip', showWhen: { input: 'shape', equals: ['stats', 'timechart', 'top'] } },
      { id: 'aggregation', label: 'Aggregate', control: 'select', default: 'count', options: [
        { value: 'count', label: 'count' },
        { value: 'dc', label: 'distinct count' },
        { value: 'sum', label: 'sum' },
        { value: 'avg', label: 'average' },
      ], showWhen: { input: 'shape', equals: ['stats', 'timechart'] } },
      { id: 'aggregation_field', label: 'Aggregate field', control: 'text', default: '', hint: 'Leave empty for count', showWhen: { input: 'aggregation', notEquals: ['count'] } },
      { id: 'schedule', label: 'Run', control: 'select', default: 'none', options: [
        { value: 'none', label: 'On demand only' },
        { value: '15', label: 'Every 15 minutes' },
        { value: '60', label: 'Hourly' },
        { value: '1440', label: 'Daily' },
      ] },
      { id: 'timerange', label: 'Time range', control: 'text', default: '-24h@h', hint: 'For an on-demand search' },
      { id: 'accelerate', label: 'Accelerate the report', control: 'toggle', default: false, hint: 'Only for a search run often over a long window' },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_reporting'), 'org_reporting');
      const title = searchTitle(str(values, 'title', 'Saved search'), 'Saved search');
      const index = splunkName(str(values, 'index', ''), 'main');
      const sourcetype = str(values, 'sourcetype', '');
      const filter = str(values, 'filter', '');
      const shape = str(values, 'shape', 'stats');
      const byFields = listOf(str(values, 'by_fields', ''));
      const aggregation = str(values, 'aggregation', 'count');
      const aggregationField = str(values, 'aggregation_field', '');
      const schedule = str(values, 'schedule', 'none');
      const scheduled = schedule !== 'none';
      const everyMinutes = Number(schedule) || 60;
      const findings            = [];

      if (!str(values, 'index', '')) {
        findings.push(
          error('splunk.no-index', 'No index was given, so the search reads every index the user can see. On a large deployment that is the difference between a search that finishes and one that gets skipped.', {
            remediation: 'Always name the index. It is the single most effective thing in any Splunk search.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (filter.startsWith('*')) {
        findings.push(
          error('splunk.leading-wildcard', 'A leading wildcard cannot use the index, so this scans every event in the time range rather than looking terms up.', {
            remediation: 'Anchor the term, or match on an extracted field instead.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (aggregation !== 'count' && !aggregationField) {
        findings.push(error('splunk.no-aggregation-field', `${aggregation} needs a field to work on.`, { source: 'ArchToolKit' }));
      }
      if (bool(values, 'accelerate', false) && !scheduled) {
        findings.push(
          warning('splunk.acceleration-unscheduled', 'Report acceleration builds and maintains a summary in the background whether the report is used or not. On a report nobody runs on a schedule that is disk and CPU for nothing.', {
            source: 'ArchToolKit',
          }),
        );
      }
      if (shape === 'raw' && scheduled) {
        findings.push(
          warning('splunk.scheduled-raw', 'A scheduled search returning raw events keeps every matching event in its dispatch directory until it expires. A busy one fills the search head’s disk, and the symptom is skipped searches rather than a disk alert.', {
            remediation: 'Summarise with stats before the results are returned.',
            source: 'ArchToolKit',
          }),
        );
      }

      const aggregate = aggregation === 'count' ? 'count' : `${aggregation}(${aggregationField}) as ${aggregation}_${splunkName(aggregationField, 'value')}`;
      const pipeline = [
        `index=${index}${sourcetype ? ` sourcetype=${/[\s*]/.test(sourcetype) ? `"${sourcetype}"` : sourcetype}` : ''}${filter ? ` ${filter}` : ''}`,
        ...(shape === 'stats' ? [`| stats ${aggregate}${byFields.length ? ` by ${byFields.join(', ')}` : ''}`, '| sort - count'] : []),
        ...(shape === 'timechart' ? [`| timechart span=${everyMinutes >= 1440 ? '1h' : '5m'} ${aggregate}${byFields.length ? ` by ${byFields[0]}` : ''}`] : []),
        ...(shape === 'top' ? [`| top limit=20 ${byFields.join(', ') || 'source'}`] : []),
        ...(shape === 'raw' ? ['| table _time, host, source, _raw'] : []),
      ];

      const window = searchWindow(everyMinutes);

      return {
        tier: TIER,
        title: `Saved search: ${title}`,
        app,
        activation: 'reload',
        notes: [
          'The index and sourcetype come first deliberately. Splunk filters at the index for those terms, so everything named there is work the search never has to do.',
          ...(scheduled
            ? [
                `The schedule is offset rather than on the hour. Splunk puts everything on :00 by default, and a search head with forty searches all starting at once is where "search skipped" comes from.`,
                `The window (${window.earliest} to ${window.latest}) is slightly longer than the interval on purpose: an event that indexes a second after the search runs would otherwise never be seen.`,
              ]
            : []),
          ...(bool(values, 'accelerate', false) ? ['Acceleration summarises in the background. The first build covers the whole retention period and can be heavy — start it outside business hours.'] : []),
        ],
        before: [
          `| rest /servicesNS/-/${app}/saved/searches | search title="${title}"`,
          `index=${index} ${sourcetype ? `sourcetype=${sourcetype}` : ''} | head 5`,
          `| tstats count where index=${index} by sourcetype`,
        ],
        files: {
          'default/savedsearches.conf': [
            `[${title}]`,
            ...foldSearch(pipeline),
            `description =`,
            ...(scheduled
              ? [
                  'enableSched = 1',
                  `cron_schedule = ${spreadCron(title, everyMinutes)}`,
                  `dispatch.earliest_time = ${window.earliest}`,
                  `dispatch.latest_time = ${window.latest}`,
                  'schedule_window = auto',
                  'dispatch.ttl = 2p',
                ]
              : ['enableSched = 0', `dispatch.earliest_time = ${str(values, 'timerange', '-24h@h')}`, 'dispatch.latest_time = now']),
            ...(bool(values, 'accelerate', false) ? ['auto_summarize = 1', 'auto_summarize.dispatch.earliest_time = -30d@d', 'auto_summarize.cron_schedule = */10 * * * *'] : []),
            ...(shape !== 'raw' ? ['display.general.type = statistics'] : ['display.general.type = events']),
            'request.ui_dispatch_app = ' + app,
            'request.ui_dispatch_view = search',
          ],
          'metadata/default.meta': defaultMeta(),
        },
        verify: [
          `| rest /servicesNS/-/${app}/saved/searches | search title="${title}" | table title, cron_schedule, disabled`,
          `| savedsearch "${title}"`,
          ...(scheduled ? ['index=_internal sourcetype=scheduler savedsearch_name="' + title + '" | table _time, status, run_time, result_count'] : []),
          ...(scheduled ? ['index=_internal sourcetype=scheduler status=skipped | stats count by savedsearch_name'] : []),
        ],
        backout: [`rm -rf $SPLUNK_HOME/etc/apps/${app}`, 'splunk reload deploy-server   # or restart the search head', `# Or, to disable only this search: | rest /servicesNS/-/${app}/saved/searches/${encodeURIComponent(title)} disabled=1`],
        findings,
      };
    },
  }),

  splunkBlueprint({
    id: 'splunk_alert',
    tier: TIER,
    label: 'Alert',
    group: 'Alerting',
    description: 'A scheduled alert with the two things most alerts are missing: throttling, so it does not fire a hundred times for one incident, and a condition that means something.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_alerts' },
      { id: 'title', label: 'Alert name', control: 'text', default: 'Disk filling on a production host' },
      { id: 'index', label: 'Index', control: 'text', default: 'os' },
      { id: 'sourcetype', label: 'Sourcetype', control: 'text', default: 'df' },
      { id: 'search', label: 'Search', control: 'textarea', default: '| stats latest(PercentUsedSpace) as used by host, MountedOn\n| where used > 90', hint: 'The pipeline after the index filter' },
      { id: 'frequency', label: 'Run every', control: 'select', default: '15', options: [
        { value: '5', label: '5 minutes' },
        { value: '15', label: '15 minutes' },
        { value: '60', label: 'Hour' },
        { value: '1440', label: 'Day' },
      ] },
      { id: 'condition', label: 'Fire when', control: 'select', default: 'results', options: [
        { value: 'results', label: 'The search returns anything' },
        { value: 'count_gt', label: 'More than N results' },
        { value: 'custom', label: 'A custom condition' },
      ] },
      { id: 'threshold', label: 'N', control: 'number', default: 5, min: 0, showWhen: { input: 'condition', equals: ['count_gt'] } },
      { id: 'custom_condition', label: 'Condition', control: 'text', default: 'search used > 95', showWhen: { input: 'condition', equals: ['custom'] } },
      { id: 'severity', label: 'Severity', control: 'select', default: '4', options: [
        { value: '1', label: 'Info' },
        { value: '2', label: 'Low' },
        { value: '3', label: 'Medium' },
        { value: '4', label: 'High' },
        { value: '5', label: 'Critical' },
      ] },
      { id: 'throttle_field', label: 'Throttle per', control: 'text', default: 'host', hint: 'One alert per value of this field — empty for one alert overall' },
      { id: 'throttle_minutes', label: 'Throttle for (minutes)', control: 'number', default: 60, min: 0, max: 10080 },
      { id: 'action', label: 'Action', control: 'select', default: 'email', options: [
        { value: 'email', label: 'Email' },
        { value: 'webhook', label: 'Webhook' },
        { value: 'ticket', label: 'Email, and write to a summary index for reporting' },
        { value: 'none', label: 'List it in Triggered Alerts only' },
      ] },
      { id: 'recipients', label: 'Recipients', control: 'text', default: 'platform-oncall@example.com', showWhen: { input: 'action', equals: ['email', 'ticket'] } },
      { id: 'webhook_url', label: 'Webhook URL', control: 'text', default: 'https://hooks.example.com/splunk', showWhen: { input: 'action', equals: ['webhook'] } },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_alerts'), 'org_alerts');
      const title = searchTitle(str(values, 'title', 'Alert'), 'Alert');
      const index = splunkName(str(values, 'index', ''), 'main');
      const everyMinutes = Number(str(values, 'frequency', '15')) || 15;
      const condition = str(values, 'condition', 'results');
      const throttleField = str(values, 'throttle_field', '');
      const throttleMinutes = num(values, 'throttle_minutes', 60);
      const action = str(values, 'action', 'email');
      const findings            = [];

      if (throttleMinutes === 0) {
        findings.push(
          warning('splunk.no-throttle', 'Without throttling this fires on every run for as long as the condition holds. A disk that stays full for a weekend produces one alert every fifteen minutes until Monday, and the recipients learn to ignore it.', {
            remediation: 'Throttle per host for at least as long as it takes someone to act.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (throttleMinutes > 0 && !throttleField) {
        findings.push(
          warning('splunk.throttle-global', 'Throttling with no field suppresses the whole alert, so a second host hitting the same problem during the window is never reported. Throttling per host is almost always what was meant.', {
            source: 'ArchToolKit',
          }),
        );
      }
      if (throttleMinutes > 0 && throttleMinutes < everyMinutes) {
        findings.push(warning('splunk.throttle-shorter-than-schedule', `A throttle of ${throttleMinutes} minutes on a search that runs every ${everyMinutes} suppresses nothing.`, { source: 'ArchToolKit' }));
      }
      if (everyMinutes <= 5) {
        findings.push(
          warning('splunk.frequent-alert', 'A search every five minutes is twelve searches an hour, for ever. On a search head with many of them that is the usual cause of skipped searches — check the scheduler before adding more.', {
            source: 'ArchToolKit',
          }),
        );
      }
      if (action === 'email' && !str(values, 'recipients', '')) {
        findings.push(error('splunk.no-recipients', 'The action is email and no recipient was given, so the alert fires and nobody hears about it.', { source: 'ArchToolKit' }));
      }

      const window = searchWindow(everyMinutes);
      const pipeline = [
        `index=${index}${str(values, 'sourcetype', '') ? ` sourcetype=${str(values, 'sourcetype', '')}` : ''}`,
        ...str(values, 'search', '')
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
      ];

      return {
        tier: TIER,
        title: `Alert: ${title}`,
        app,
        activation: 'reload',
        notes: [
          'It is enabled and scheduled as soon as the app is deployed. Test it before deploying: run the search over the last week with the condition as a `where`, and count how many times it would have fired. An alert that would have fired two hundred times is not an alert.',
          ...(throttleMinutes > 0
            ? [`Throttling suppresses ${throttleField ? `each ${throttleField}` : 'the alert'} for ${throttleMinutes} minutes after it fires. The condition can keep being true; the notification stops.`]
            : []),
          'The severity is metadata, not behaviour. It shows in Triggered Alerts and can be read by whatever consumes the webhook — it does not change when or how the alert fires.',
          ...(action === 'webhook'
            ? ['Add the webhook URL to the webhook allow list: alert_actions.conf [webhook] allowlist.<name> = <regex> (editing it needs the edit_webhook_allow_list capability). VERIFY on your version whether the list is enforced by default (enable_allowlist); where it is, a URL that matches no entry is not called.']
            : []),
          ...(action === 'ticket' ? ['Results are also written to a summary index, so "how often did this fire last quarter" is a search rather than an archaeology exercise through email.'] : []),
        ],
        before: [
          `index=${index} earliest=-7d | ${str(values, 'search', '').split('\n')[0]?.replace(/^\|\s*/, '') ?? 'stats count'}`,
          `| rest /servicesNS/-/${app}/saved/searches | search title="${title}"`,
          'index=_internal sourcetype=scheduler status=skipped earliest=-24h | stats count by savedsearch_name',
        ],
        files: {
          'default/savedsearches.conf': [
            `[${title}]`,
            ...foldSearch(pipeline),
            'description = Tested against history before deployment.',
            'enableSched = 1',
            `cron_schedule = ${spreadCron(title, everyMinutes)}`,
            `dispatch.earliest_time = ${window.earliest}`,
            `dispatch.latest_time = ${window.latest}`,
            'schedule_window = auto',
            'dispatch.ttl = 4p',
            '',
            '# What makes it fire.',
            ...(condition === 'results'
              ? ['counttype = number of events', 'relation = greater than', 'quantity = 0']
              : condition === 'count_gt'
                ? ['counttype = number of events', 'relation = greater than', `quantity = ${num(values, 'threshold', 5)}`]
                : ['counttype = custom', `alert_condition = ${str(values, 'custom_condition', '')}`]),
            'alert.track = 1',
            `alert.severity = ${str(values, 'severity', '4')}`,
            'alert.digest_mode = 1',
            '',
            ...(throttleMinutes > 0
              ? [
                  '# Throttling. Without this, one incident is one alert per run.',
                  'alert.suppress = 1',
                  `alert.suppress.period = ${throttleMinutes}m`,
                  ...(throttleField ? [`alert.suppress.fields = ${throttleField}`] : []),
                  '',
                ]
              : []),
            ...(action === 'email' || action === 'ticket'
              ? [
                  'action.email = 1',
                  `action.email.to = ${str(values, 'recipients', '')}`,
                  `action.email.subject = [Splunk ${['', 'Info', 'Low', 'Medium', 'High', 'Critical'][Number(str(values, 'severity', '4'))]}] ${title} — $result.host$`,
                  'action.email.format = table',
                  'action.email.sendresults = 1',
                  'action.email.inline = 1',
                  'action.email.include.results_link = 1',
                  'action.email.include.search = 1',
                  'action.email.include.trigger_time = 1',
                ]
              : []),
            ...(action === 'webhook'
              ? ['action.webhook = 1', `action.webhook.param.url = ${str(values, 'webhook_url', '')}`, '# The webhook payload carries the first result only; summarise before this fires.']
              : []),
            ...(action === 'ticket'
              ? [
                  '',
                  '# Also written to a summary index, so alert history is searchable.',
                  'action.summary_index = 1',
                  'action.summary_index._name = summary',
                  `action.summary_index.alert_name = ${title}`,
                  `action.summary_index.severity = ${str(values, 'severity', '4')}`,
                ]
              : []),
          ],
          'metadata/default.meta': defaultMeta(),
        },
        verify: [
          `| rest /servicesNS/-/${app}/saved/searches | search title="${title}" | table title, cron_schedule, alert.suppress.period, disabled`,
          `index=_internal sourcetype=scheduler savedsearch_name="${title}" | table _time, status, result_count`,
          `index=_audit action=alert_fired ss_name="${title}" | table _time, severity`,
          ...(action === 'email' ? ['index=_internal sourcetype=splunkd component=SendEmail | tail 20'] : []),
        ],
        backout: [`rm -rf $SPLUNK_HOME/etc/apps/${app}`, `# Or disable only this alert: | rest /servicesNS/-/${app}/saved/searches/${encodeURIComponent(title)} disabled=1`],
        findings,
      };
    },
  }),

  splunkBlueprint({
    id: 'splunk_dashboard',
    tier: TIER,
    label: 'Dashboard',
    group: 'Dashboards',
    description: 'A Dashboard Studio dashboard with a time picker and a filter that actually reach every panel, and a base search so six panels are not six separate searches over the same data.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_dashboards' },
      { id: 'title', label: 'Dashboard title', control: 'text', default: 'Service overview' },
      { id: 'index', label: 'Index', control: 'text', default: 'app' },
      { id: 'sourcetype', label: 'Sourcetype', control: 'text', default: 'app:json' },
      { id: 'panels', label: 'Panels', control: 'textarea', default: 'Requests over time | timechart | | \nErrors by endpoint | table | status>=500 | endpoint\nSlowest endpoints | table | | endpoint', hint: 'Title | type (timechart, chart, table, single) | filter | group by' },
      { id: 'filter_field', label: 'Filter dropdown on', control: 'text', default: 'environment', hint: 'A token every panel uses — empty for none' },
      { id: 'base_search', label: 'Share one base search', control: 'toggle', default: true },
      { id: 'refresh', label: 'Auto refresh', control: 'select', default: 'none', options: [
        { value: 'none', label: 'Off' },
        { value: '5m', label: 'Every 5 minutes' },
        { value: '1m', label: 'Every minute' },
      ] },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_dashboards'), 'org_dashboards');
      const title = searchTitle(str(values, 'title', 'Dashboard'), 'Dashboard');
      const id = splunkName(title, 'dashboard');
      const index = splunkName(str(values, 'index', ''), 'main');
      const sourcetype = str(values, 'sourcetype', '');
      const filterField = str(values, 'filter_field', '');
      const baseSearch = bool(values, 'base_search', true);
      const refresh = str(values, 'refresh', 'none');
      const panels = str(values, 'panels', '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [panelTitle, type, filter, by] = line.split('|').map((p) => p.trim());
          return { title: panelTitle ?? 'Panel', type: (type ?? 'table').toLowerCase(), filter: filter ?? '', by: by ?? '' };
        });
      const findings            = [];

      if (panels.length === 0) findings.push(error('splunk.no-panels', 'No panel was described, so the dashboard would be empty.', { source: 'ArchToolKit' }));
      if (panels.length > 8 && !baseSearch) {
        findings.push(
          warning('splunk.many-independent-searches', `${panels.length} panels each running their own search means ${panels.length} concurrent searches every time someone opens this. A base search runs once and every panel works from its results.`, {
            source: 'ArchToolKit',
          }),
        );
      }
      if (refresh === '1m') {
        findings.push(
          warning('splunk.aggressive-refresh', 'A dashboard refreshing every minute re-runs every panel every minute for as long as a browser tab is open — including the one somebody left open on a spare monitor in March.', {
            source: 'ArchToolKit',
          }),
        );
      }
      if (baseSearch && panels.some((p) => p.type === 'timechart')) {
        findings.push(
          warning('splunk.base-search-transforming', 'A base search that is already transformed cannot feed a timechart panel unless the base keeps _time. Keep the base search as a filter — a plain search with no stats — and let each panel transform it.', {
            source: 'ArchToolKit',
          }),
        );
      }

      const base = `index=${index}${sourcetype ? ` sourcetype=${sourcetype}` : ''}${filterField ? ` ${filterField}=$${filterField}_token$` : ''}`;
      const transform = (panel                              ) =>
        panel.type === 'timechart' ? `| timechart span=5m count${panel.by ? ` by ${panel.by}` : ''}` : `| stats count${panel.by ? ` by ${panel.by}` : ''} | sort - count`;
      const vizType = (type        ) => (type === 'timechart' ? 'splunk.line' : type === 'chart' ? 'splunk.column' : type === 'single' ? 'splunk.singlevalue' : 'splunk.table');
      const timeParameters = { earliest: '$global_time.earliest$', latest: '$global_time.latest$' };
      const refreshOptions = refresh !== 'none' ? { refresh, refreshType: 'delay' } : {};

      // Dashboard Studio. With a base search, each panel is a ds.chain that
      // post-processes the one ds_base search, so a page view is one search.
      const studioJson = JSON.stringify(
        {
          title,
          description: '',
          visualizations: Object.fromEntries(
            panels.map((panel, panelIndex) => [
              `viz_${panelIndex}`,
              {
                type: vizType(panel.type),
                title: panel.title,
                dataSources: { primary: `ds_${panelIndex}` },
                ...(panel.type === 'timechart' ? { options: { legendDisplay: 'bottom' } } : panel.type === 'table' ? { options: { count: 20 } } : {}),
              },
            ]),
          ),
          dataSources: {
            ...(baseSearch
              ? { ds_base: { type: 'ds.search', name: 'Base search', options: { query: base, queryParameters: timeParameters, ...refreshOptions } } }
              : {}),
            ...Object.fromEntries(
              panels.map((panel, panelIndex) => [
                `ds_${panelIndex}`,
                baseSearch
                  ? { type: 'ds.chain', name: panel.title, options: { extend: 'ds_base', query: `${panel.filter ? `| search ${panel.filter} ` : ''}${transform(panel)}` } }
                  : { type: 'ds.search', name: panel.title, options: { query: `${base}${panel.filter ? ` ${panel.filter}` : ''} ${transform(panel)}`, queryParameters: timeParameters, ...refreshOptions } },
              ]),
            ),
            ...(filterField
              ? {
                  ds_filter: {
                    type: 'ds.search',
                    name: `${filterField} values`,
                    options: { query: `index=${index}${sourcetype ? ` sourcetype=${sourcetype}` : ''} | stats count by ${filterField} | sort - count`, queryParameters: { earliest: '-7d@d', latest: 'now' } },
                  },
                }
              : {}),
          },
          inputs: {
            input_global_trp: {
              type: 'input.timerange',
              title: 'Time range',
              options: { token: 'global_time', defaultValue: '-24h@h,now' },
            },
            ...(filterField
              ? {
                  input_filter: {
                    type: 'input.dropdown',
                    title: filterField,
                    dataSources: { primary: 'ds_filter' },
                    options: { token: `${filterField}_token`, defaultValue: '*', items: '>frame(label, value) | prepend(formattedStatics) | objects()' },
                    context: {
                      formattedConfig: { number: { prefix: '' } },
                      formattedStatics: '>statics | formatByType(formattedConfig)',
                      statics: [['All'], ['*']],
                      label: `>primary | seriesByName("${filterField}") | renameSeries("label") | formatByType(formattedConfig)`,
                      value: `>primary | seriesByName("${filterField}") | renameSeries("value") | formatByType(formattedConfig)`,
                    },
                  },
                }
              : {}),
          },
          layout: {
            type: 'grid',
            options: { width: 1200, height: Math.max(1, Math.ceil(panels.length / 2)) * 300 },
            structure: panels.map((_, panelIndex) => ({
              item: `viz_${panelIndex}`,
              type: 'block',
              position: { x: (panelIndex % 2) * 600, y: Math.floor(panelIndex / 2) * 300, w: 600, h: 300 },
            })),
            globalInputs: ['input_global_trp', ...(filterField ? ['input_filter'] : [])],
          },
        },
        null,
        2,
      ).split('\n');


      return {
        tier: TIER,
        title: `Dashboard: ${title}`,
        app,
        activation: 'reload',
        notes: [
          'The time picker is a token every panel reads, so changing it changes the whole page. A panel with its own hard-coded time range ignores the picker, which is the most common reason a dashboard "does not respond".',
          ...(baseSearch ? ['The base search runs once and every panel post-processes it. Without that, opening this page starts one search per panel at the same moment.'] : []),
          'Dashboard Studio (a version="2" view holding the JSON definition). Splunk Enterprise 10.4 no longer loads Simple XML version="1.0" or HTML dashboards, so Studio is the format generated. Edit it in the Studio editor, or change the JSON and redeploy.',
          `Without \`metadata/default.meta\` the dashboard is private to nobody and nobody can see it. That file is included.`,
        ],
        before: [`| rest /servicesNS/-/${app}/data/ui/views | search title="${title}"`, `index=${index}${sourcetype ? ` sourcetype=${sourcetype}` : ''} | head 5`, ...(filterField ? [`index=${index} | stats count by ${filterField}`] : [])],
        files: {
          [`default/data/ui/views/${id}.xml`]: ['<dashboard version="2" theme="light">', `  <label>${title.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</label>`, '  <definition><![CDATA[', ...studioJson.map((l) => `  ${l}`), '  ]]></definition>', '</dashboard>'],
          'metadata/default.meta': defaultMeta(),
        },
        verify: [
          `| rest /servicesNS/-/${app}/data/ui/views | search title="${title}" | table title, eai:acl.sharing, eai:acl.perms.read`,
          `# Open it: /app/${app}/${id}`,
          'index=_internal sourcetype=splunkd component=SearchParser log_level=ERROR | tail 20',
          'index=_audit action=search search="*" | search savedsearch_name="" | head 10',
        ],
        backout: [`rm $SPLUNK_HOME/etc/apps/${app}/default/data/ui/views/${id}.xml`, 'splunk _internal call /admin/views/_reload -auth <user>:<password>'],
        findings,
      };
    },
  }),

  splunkBlueprint({
    id: 'splunk_macro_lookup',
    tier: TIER,
    label: 'Macro and lookup',
    group: 'Knowledge objects',
    description: 'The two things that stop the same filter being copied into forty searches: a macro for the logic, and a lookup for the table of values it needs.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_knowledge' },
      { id: 'macro_name', label: 'Macro name', control: 'text', default: 'production_hosts' },
      { id: 'macro_arguments', label: 'Arguments', control: 'text', default: '', hint: 'Comma separated — empty for none' },
      { id: 'macro_definition', label: 'Macro definition', control: 'textarea', default: 'index=os [| inputlookup production_hosts.csv | fields host | format]', hint: 'The SPL the macro expands to' },
      { id: 'lookup_name', label: 'Lookup name', control: 'text', default: 'production_hosts', hint: 'Empty for a macro on its own' },
      { id: 'lookup_fields', label: 'Lookup columns', control: 'text', default: 'host, environment, owner, tier', showWhen: { input: 'lookup_name', notEquals: [''] } },
      { id: 'lookup_key', label: 'Match on', control: 'text', default: 'host', showWhen: { input: 'lookup_name', notEquals: [''] } },
      { id: 'automatic', label: 'Apply automatically', control: 'select', default: 'none', options: [
        { value: 'none', label: 'Only where a search calls it' },
        { value: 'sourcetype', label: 'To every event of a sourcetype' },
      ], showWhen: { input: 'lookup_name', notEquals: [''] } },
      { id: 'automatic_sourcetype', label: 'Sourcetype', control: 'text', default: 'df', showWhen: { input: 'automatic', equals: ['sourcetype'] } },
      { id: 'case_sensitive', label: 'Case sensitive match', control: 'toggle', default: false },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_knowledge'), 'org_knowledge');
      const macro = splunkName(str(values, 'macro_name', 'macro'), 'macro');
      const args = listOf(str(values, 'macro_arguments', ''));
      const definition = str(values, 'macro_definition', '');
      const lookup = splunkName(str(values, 'lookup_name', ''), '');
      const lookupFields = listOf(str(values, 'lookup_fields', ''));
      const key = str(values, 'lookup_key', 'host');
      const automatic = str(values, 'automatic', 'none') === 'sourcetype';
      const findings            = [];

      if (!definition) findings.push(error('splunk.empty-macro', 'The macro has no definition, so calling it expands to nothing and the search silently changes meaning.', { source: 'ArchToolKit' }));
      if (args.length > 0 && !args.every((a) => definition.includes(`$${a}$`))) {
        findings.push(
          error('splunk.macro-argument-unused', `The macro takes arguments that its definition never uses: ${args.filter((a) => !definition.includes(`$${a}$`)).join(', ')}. A caller supplying them will see them silently discarded.`, {
            remediation: 'Reference each argument as $name$ in the definition.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (lookup && lookupFields.length > 0 && !lookupFields.includes(key)) {
        findings.push(error('splunk.lookup-key-missing', `The match field "${key}" is not one of the lookup's columns, so the lookup can never match.`, { source: 'ArchToolKit' }));
      }
      if (automatic) {
        findings.push(
          warning('splunk.automatic-lookup-cost', 'An automatic lookup runs for every event of that sourcetype in every search, whether the search uses the fields or not. On a high-volume sourcetype that is a permanent tax on every search.', {
            remediation: 'Prefer calling the lookup explicitly where it is needed, unless the fields are wanted almost everywhere.',
            source: 'ArchToolKit',
          }),
        );
      }

      return {
        tier: TIER,
        title: `Macro \`${macro}\`${lookup ? ` and lookup ${lookup}` : ''}`,
        app,
        activation: 'reload',
        notes: [
          'A macro is called with backticks: `' + macro + (args.length ? `(${args.map((_, i) => `arg${i + 1}`).join(',')})` : '') + '`. Getting the backticks wrong is the usual reason it "does not work".',
          ...(lookup
            ? [
                `The CSV itself goes in ${app}/lookups/${lookup}.csv. The generated file has the header row only — the content is yours, and it is the part that has to stay current.`,
                'A lookup CSV over about 50MB should be a KV store collection instead. A large CSV is read from disk on every search that touches it.',
              ]
            : []),
          ...(automatic ? ['An automatic lookup adds its output fields at search time. They will not appear in an index-time field summary, and `| fields` will not find them unless the lookup has run.'] : []),
        ],
        before: [`| rest /servicesNS/-/${app}/admin/macros | search title="${macro}*"`, ...(lookup ? [`| inputlookup ${lookup}.csv | head 5`, `| rest /servicesNS/-/${app}/data/lookup-table-files`] : [])],
        files: {
          'default/macros.conf': [
            `[${macro}${args.length ? `(${args.length})` : ''}]`,
            `definition = ${definition}`,
            ...(args.length ? [`args = ${args.join(', ')}`] : []),
            `description =`,
            'iseval = 0',
            ...(args.length ? ['', '# Validation runs before expansion, so a bad argument fails clearly', '# rather than producing a search that quietly matches nothing.', `validation = ${args.map((a) => `isnotnull($${a}$)`).join(' AND ')}`, 'errormsg = Every argument is required.'] : []),
          ],
          ...(lookup
            ? {
                [`lookups/${lookup}.csv`]: [lookupFields.join(',')],
                'default/transforms.conf': [
                  `[${lookup}]`,
                  `filename = ${lookup}.csv`,
                  ...(bool(values, 'case_sensitive', false) ? [] : ['case_sensitive_match = false']),
                  '# max_matches = 1 makes this a straight enrichment rather than a join',
                  '# that multiplies rows — which is what happens by default.',
                  'max_matches = 1',
                ],
                ...(automatic
                  ? {
                      'default/props.conf': [
                        `[${str(values, 'automatic_sourcetype', '')}]`,
                        `LOOKUP-${lookup} = ${lookup} ${key} OUTPUT ${lookupFields.filter((f) => f !== key).join(', ')}`,
                      ],
                    }
                  : {}),
              }
            : {}),
          'metadata/default.meta': defaultMeta(),
        },
        verify: [
          `| \`${macro}${args.length ? `(${args.map(() => '"test"').join(',')})` : ''}\` | head 5`,
          ...(lookup ? [`| inputlookup ${lookup}.csv | head 10`, `| makeresults | eval ${key}="example" | lookup ${lookup} ${key}`] : []),
          ...(automatic ? [`sourcetype=${str(values, 'automatic_sourcetype', '')} | fields ${lookupFields.join(', ')} | head 5`] : []),
          '| rest /servicesNS/-/-/admin/macros | search title="' + macro + '*" | table title, definition',
        ],
        backout: [`rm -rf $SPLUNK_HOME/etc/apps/${app}`, '| rest /services/admin/conf-times   # confirm the reload', '# Any search calling the macro will now fail with "could not find macro" — find them first:', `index=_audit action=search | search search="*\`${macro}\`*" | stats count by user`],
        findings,
      };
    },
  }),

  splunkBlueprint({
    id: 'splunk_datamodel',
    tier: TIER,
    label: 'Data model and acceleration',
    group: 'Knowledge objects',
    description: 'A data model over a sourcetype, accelerated so `tstats` can answer in a second what a raw search takes minutes to do — with the disk cost stated rather than discovered.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_datamodels' },
      { id: 'model_name', label: 'Data model', control: 'text', default: 'Application_Events' },
      { id: 'index', label: 'Index', control: 'text', default: 'app' },
      { id: 'sourcetype', label: 'Sourcetype', control: 'text', default: 'app:json' },
      { id: 'fields', label: 'Fields', control: 'textarea', default: 'host | string\nendpoint | string\nstatus | number\nduration_ms | number\nuser | string', hint: 'name | string|number|boolean|timestamp' },
      { id: 'accelerate', label: 'Accelerate', control: 'toggle', default: true },
      { id: 'summary_range', label: 'Summarise the last', control: 'select', default: '7d', options: [
        { value: '1d', label: 'Day' },
        { value: '7d', label: '7 days' },
        { value: '30d', label: '30 days' },
        { value: '1y', label: 'Year' },
      ], showWhen: { input: 'accelerate', equals: ['true'] } },
      { id: 'daily_gb', label: 'Daily volume for this sourcetype (GB)', control: 'number', default: 10, min: 0, max: 100000, hint: 'Used to estimate the summary size' },
      { id: 'tstats_example', label: 'Include a tstats example search', control: 'toggle', default: true },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_datamodels'), 'org_datamodels');
      const model = str(values, 'model_name', 'Model').replace(/[^A-Za-z0-9_]/g, '_');
      const index = splunkName(str(values, 'index', ''), 'main');
      const sourcetype = str(values, 'sourcetype', '');
      const accelerate = bool(values, 'accelerate', true);
      const range = str(values, 'summary_range', '7d');
      const dailyGb = num(values, 'daily_gb', 10);
      const fields = str(values, 'fields', '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [name, type] = line.split('|').map((p) => p.trim());
          return { name: name ?? 'field', type: (type ?? 'string').toLowerCase() };
        });
      const findings            = [];

      if (fields.length === 0) findings.push(error('splunk.no-fields', 'A data model with no fields accelerates nothing.', { source: 'ArchToolKit' }));

      const days = range === '1d' ? 1 : range === '7d' ? 7 : range === '30d' ? 30 : 365;
      // A tsidx summary is roughly 3% of raw for a model with a handful of fields.
      const summaryGb = Math.round(dailyGb * days * 0.03 * 10) / 10;

      if (accelerate) {
        findings.push(
          warning('splunk.acceleration-disk', `Accelerating ${range} of a ${dailyGb}GB/day sourcetype costs roughly ${summaryGb}GB of tsidx summary per indexer, and it is rebuilt continuously. Confirm the indexers have that spare before deploying.`, {
            remediation: 'Check with: | rest /services/admin/summarization | table summary.id, summary.size',
            source: 'ArchToolKit',
          }),
        );
        if (days >= 365) {
          findings.push(
            warning('splunk.acceleration-long-range', 'A year of acceleration takes a very long time to build the first time and is rarely what is wanted. Most searches against a model look at days, not months.', {
              source: 'ArchToolKit',
            }),
          );
        }
      }

      const typeOf = (type        ) => (type === 'number' ? 'number' : type === 'boolean' ? 'boolean' : type === 'timestamp' ? 'timestamp' : 'string');

      const json = JSON.stringify(
        {
          modelName: model,
          displayName: model.replace(/_/g, ' '),
          description: '',
          objectSummary: { Event: 1, Transaction: 0, Search: 0 },
          objects: [
            {
              objectName: model,
              displayName: model.replace(/_/g, ' '),
              parentName: 'BaseEvent',
              comment: '',
              fields: [
                { fieldName: '_time', owner: 'BaseEvent', type: 'timestamp', required: true, multivalue: false, hidden: false, editable: false, displayName: 'Time' },
                { fieldName: 'host', owner: 'BaseEvent', type: 'string', required: false, multivalue: false, hidden: false, editable: false, displayName: 'Host' },
                { fieldName: 'source', owner: 'BaseEvent', type: 'string', required: false, multivalue: false, hidden: false, editable: false, displayName: 'Source' },
                { fieldName: 'sourcetype', owner: 'BaseEvent', type: 'string', required: false, multivalue: false, hidden: false, editable: false, displayName: 'Sourcetype' },
                ...fields.map((field) => ({
                  fieldName: field.name,
                  owner: model,
                  type: typeOf(field.type),
                  required: false,
                  multivalue: false,
                  hidden: false,
                  editable: true,
                  displayName: field.name.replace(/_/g, ' '),
                })),
              ],
              calculations: [],
              constraints: [{ search: `index=${index}${sourcetype ? ` sourcetype=${sourcetype}` : ''}`, owner: model }],
              lineage: model,
            },
          ],
        },
        null,
        2,
      ).split('\n');

      return {
        tier: TIER,
        title: `Data model ${model}${accelerate ? `, accelerated over ${range}` : ''}`,
        app,
        activation: accelerate ? 'restart' : 'reload',
        notes: [
          'The constraint is what decides which events are in the model. Everything the model can answer is bounded by it, so make it as specific as the data allows.',
          ...(accelerate
            ? [
                `Acceleration builds a tsidx summary on every indexer — roughly ${summaryGb}GB for ${range} at ${dailyGb}GB/day. The first build covers the whole range and is heavy; start it outside business hours.`,
                'Only `tstats` reads the summary. An ordinary `| datamodel` search does not, and will be no faster than searching the raw data.',
                'A field added to the model later is not in the existing summary. The summary rebuilds, which costs as much as the first build did.',
              ]
            : []),
          'The field names here should match a standard where one exists — the Common Information Model, if the rest of the deployment uses it. Inventing field names makes the model useless to anything that expects CIM.',
        ],
        before: [
          `index=${index}${sourcetype ? ` sourcetype=${sourcetype}` : ''} | head 5`,
          `index=${index}${sourcetype ? ` sourcetype=${sourcetype}` : ''} | fieldsummary | table field, count, distinct_count`,
          '| rest /services/admin/summarization | table summary.id, summary.size, summary.complete',
          '| dbinspect index=' + index + ' | stats sum(sizeOnDiskMB) as MB',
        ],
        files: {
          [`default/data/models/${model}.json`]: json,
          ...(accelerate
            ? {
                'default/datamodels.conf': [
                  `[${model}]`,
                  'acceleration = 1',
                  `acceleration.earliest_time = -${range}`,
                  'acceleration.cron_schedule = */15 * * * *',
                  'acceleration.max_concurrent = 2',
                  '# backfill_time keeps the first build from trying to do the whole',
                  '# range in one go on a busy indexer.',
                  `acceleration.backfill_time = -${range}`,
                  'acceleration.manual_rebuilds = 0',
                ],
              }
            : {}),
          ...(bool(values, 'tstats_example', true)
            ? {
                'default/savedsearches.conf': [
                  `[${model} — tstats example]`,
                  `search = | tstats ${accelerate ? 'summariesonly=t ' : ''}count from datamodel=${model} where nodename=${model} by ${model}.${fields[0]?.name ?? 'host'}, _time span=1h \\`,
                  `    | rename ${model}.* as *`,
                  `description = An example of reading the model with tstats, which is the only way acceleration helps.`,
                  'enableSched = 0',
                  'dispatch.earliest_time = -24h@h',
                  'dispatch.latest_time = now',
                ],
              }
            : {}),
          'metadata/default.meta': defaultMeta(),
        },
        verify: [
          `| datamodel ${model} search | head 5`,
          `| tstats ${accelerate ? 'summariesonly=t ' : ''}count from datamodel=${model}`,
          ...(accelerate
            ? [
                `| rest /services/admin/summarization | search summary.id="*${model}*" | table summary.id, summary.complete, summary.size, summary.access_count`,
                `# Wait for summary.complete to reach 1.0 before relying on summariesonly=t`,
              ]
            : []),
          `index=_internal sourcetype=splunkd component=DataModelAcceleration | tail 20`,
        ],
        backout: [
          ...(accelerate ? [`# Disable acceleration first, which deletes the summary:`, `| rest /servicesNS/-/${app}/datamodel/model/${model}/acceleration acceleration=0`] : []),
          `rm -rf $SPLUNK_HOME/etc/apps/${app}`,
          'splunk restart',
        ],
        findings,
      };
    },
  }),

  splunkBlueprint({
    id: 'splunk_detection',
    tier: TIER,
    label: 'Correlation search (detection)',
    group: 'Security',
    description: 'A scheduled detection written as security content is written: a documented purpose, a false-positive note, risk attribution and a notable — not just a search that fires.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_detections' },
      { id: 'title', label: 'Detection name', control: 'text', default: 'Brute force against a privileged account' },
      { id: 'technique', label: 'MITRE ATT&CK technique', control: 'text', default: 'T1110', hint: 'The technique id, so this maps to a framework' },
      { id: 'datamodel', label: 'Read from', control: 'select', default: 'datamodel', options: [
        { value: 'datamodel', label: 'An accelerated data model, with tstats' },
        { value: 'raw', label: 'Raw events' },
      ] },
      { id: 'model_name', label: 'Data model', control: 'text', default: 'Authentication', showWhen: { input: 'datamodel', equals: ['datamodel'] } },
      { id: 'index', label: 'Index', control: 'text', default: 'wineventlog', showWhen: { input: 'datamodel', equals: ['raw'] } },
      { id: 'condition', label: 'Detection logic', control: 'textarea', default: '| stats count, values(Authentication.user) as user, dc(Authentication.user) as user_count by Authentication.src\n| where count > 20 AND user_count > 5', hint: 'The pipeline after the source' },
      { id: 'frequency', label: 'Run every', control: 'select', default: '60', options: [
        { value: '15', label: '15 minutes' },
        { value: '60', label: 'Hour' },
        { value: '1440', label: 'Day' },
      ] },
      { id: 'risk_object', label: 'Risk object field', control: 'text', default: 'src', hint: 'What the risk score attaches to' },
      { id: 'risk_object_type', label: 'Risk object type', control: 'select', default: 'system', options: [
        { value: 'system', label: 'System' },
        { value: 'user', label: 'User' },
        { value: 'other', label: 'Other' },
      ] },
      { id: 'risk_score', label: 'Risk score', control: 'number', default: 40, min: 1, max: 100 },
      { id: 'create_notable', label: 'Also create a notable', control: 'toggle', default: false, hint: 'Off means risk only — the modern pattern is to notable on accumulated risk, not per detection' },
      { id: 'false_positives', label: 'Known false positives', control: 'text', default: 'Vulnerability scanners and service accounts with expired passwords' },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_detections'), 'org_detections');
      const title = searchTitle(str(values, 'title', 'Detection'), 'Detection');
      const useModel = str(values, 'datamodel', 'datamodel') === 'datamodel';
      const model = str(values, 'model_name', 'Authentication').replace(/[^A-Za-z0-9_]/g, '_');
      const index = splunkName(str(values, 'index', ''), 'main');
      const everyMinutes = Number(str(values, 'frequency', '60')) || 60;
      const riskObject = str(values, 'risk_object', 'src');
      const riskScore = num(values, 'risk_score', 40);
      const notable = bool(values, 'create_notable', false);
      const falsePositives = str(values, 'false_positives', '');
      const findings            = [];

      if (!falsePositives) {
        findings.push(
          warning('splunk.no-false-positive-note', 'A detection with no documented false positives is one the analyst on shift has to work out for themselves, at three in the morning, from first principles.', {
            remediation: 'Write down what legitimately triggers this. It is the most useful line in the whole detection.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (notable) {
        findings.push(
          warning('splunk.notable-per-detection', 'A notable per detection is how a queue reaches four hundred open events nobody reads. The modern pattern is to attribute risk here and raise one notable when accumulated risk on an object crosses a threshold.', {
            source: 'ArchToolKit',
          }),
        );
      }
      if (riskScore > 80) {
        findings.push(
          warning('splunk.high-risk-score', `A score of ${riskScore} from a single detection will cross most risk thresholds on its own, which makes the accumulation pointless. Scores in the 20–50 range let corroborating detections do their job.`, {
            source: 'ArchToolKit',
          }),
        );
      }
      if (useModel) {
        findings.push(
          warning('splunk.summariesonly-gap', 'summariesonly=t reads the acceleration summary only. Data that has arrived since the last summary build is invisible to it, so a detection can miss the most recent events — which for a detection is exactly the wrong ones.', {
            remediation: 'Either accept the lag and say so, or use summariesonly=f and pay for the search.',
            source: 'ArchToolKit',
          }),
        );
      }

      const window = searchWindow(everyMinutes);
      const source = useModel ? `| tstats summariesonly=t count from datamodel=${model} where nodename=${model}` : `index=${index}`;
      const pipeline = [
        source,
        ...str(values, 'condition', '')
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
        `| rename ${useModel ? `${model}.* as *` : '* as *'}`,
        `| eval risk_object=${riskObject}, risk_object_type="${str(values, 'risk_object_type', 'system')}", risk_score=${riskScore}`,
        `| eval mitre_technique="${str(values, 'technique', '')}"`,
      ];

      return {
        tier: TIER,
        title: `Detection: ${title}`,
        app,
        activation: 'reload',
        notes: [
          `It is enabled and scheduled as soon as the app is deployed, so tune it before deploying. Run the search over thirty days and count how often it would have fired: \`${title}\` firing fifty times a day is noise, not a detection.`,
          `Known false positives: ${falsePositives || '(none recorded — write them down)'}`,
          notable
            ? 'This raises a notable every time it fires. Watch the queue for the first two weeks and be ready to turn it into risk-only.'
            : 'This attributes risk rather than raising a notable. A separate risk-based search raises one notable when an object accumulates enough risk from several detections — which is the point of scoring.',
          `Mapped to MITRE ATT&CK ${str(values, 'technique', '')}. That mapping is what lets coverage be measured against the framework rather than counted as "we have 200 detections".`,
          'Enterprise Security is assumed for the risk and notable actions. Without it, those two action stanzas do nothing and the search still works as an alert.',
        ],
        before: [
          `${source} ${str(values, 'condition', '').split('\n')[0] ?? ''} earliest=-30d | stats count`,
          `| rest /servicesNS/-/${app}/saved/searches | search title="${title}"`,
          ...(useModel ? [`| rest /services/admin/summarization | search summary.id="*${model}*" | table summary.complete`] : []),
        ],
        files: {
          'default/savedsearches.conf': [
            `[${title}]`,
            ...foldSearch(pipeline),
            `description = ${title}. MITRE ${str(values, 'technique', '')}.`,
            '',
            '# Documentation the analyst reads at 3am, kept with the detection',
            '# rather than in a wiki that is one reorganisation from being lost.',
            `action.correlationsearch.enabled = 1`,
            `action.correlationsearch.label = ${title}`,
            `action.correlationsearch.annotations = {"mitre_attack": ["${str(values, 'technique', '')}"]}`,
            ...(falsePositives ? [`action.notable.param.rule_description = Known false positives: ${falsePositives}`] : []),
            '',
            'enableSched = 1',
            `cron_schedule = ${spreadCron(title, everyMinutes)}`,
            `dispatch.earliest_time = ${window.earliest}`,
            `dispatch.latest_time = ${window.latest}`,
            'schedule_window = auto',
            'dispatch.rt_backfill = 1',
            'dispatch.ttl = 4p',
            'counttype = number of events',
            'relation = greater than',
            'quantity = 0',
            'alert.track = 1',
            `alert.severity = ${riskScore >= 60 ? '5' : riskScore >= 40 ? '4' : '3'}`,
            '',
            '# Risk attribution. One detection rarely proves anything; several',
            '# against the same object usually do.',
            'action.risk = 1',
            `action.risk.param._risk_object = ${riskObject}`,
            `action.risk.param._risk_object_type = ${str(values, 'risk_object_type', 'system')}`,
            `action.risk.param._risk_score = ${riskScore}`,
            `action.risk.param._risk_message = ${title} on $result.${riskObject}$`,
            ...(notable
              ? [
                  '',
                  'action.notable = 1',
                  `action.notable.param.rule_title = ${title}`,
                  `action.notable.param.security_domain = access`,
                  `action.notable.param.severity = ${riskScore >= 60 ? 'critical' : riskScore >= 40 ? 'high' : 'medium'}`,
                  `action.notable.param.drilldown_name = View the events for $result.${riskObject}$`,
                  `action.notable.param.drilldown_search = ${useModel ? `| tstats count from datamodel=${model} where ${model}.${riskObject}="$result.${riskObject}$" by _time` : `index=${index} ${riskObject}="$result.${riskObject}$"`}`,
                  '',
                  '# Without throttling, one brute force attempt is one notable per run.',
                  'alert.suppress = 1',
                  'alert.suppress.period = 24h',
                  `alert.suppress.fields = ${riskObject}`,
                ]
              : []),
          ],
          'metadata/default.meta': defaultMeta(['*'], ['admin', 'ess_admin']),
        },
        verify: [
          `| savedsearch "${title}"`,
          `index=_internal sourcetype=scheduler savedsearch_name="${title}" earliest=-24h | table _time, status, result_count, run_time`,
          `index=risk search_name="${title}" | stats count by risk_object, risk_score`,
          ...(notable ? [`index=notable source="${title}" | table _time, ${riskObject}, severity`] : []),
          `# Coverage: | rest /servicesNS/-/-/saved/searches | search action.correlationsearch.enabled=1 | table title, action.correlationsearch.annotations`,
        ],
        backout: [`| rest /servicesNS/-/${app}/saved/searches/${encodeURIComponent(title)} disabled=1`, `rm -rf $SPLUNK_HOME/etc/apps/${app}`, '# Risk and notable events already raised stay where they are — they are data, not configuration.'],
        findings,
      };
    },
  }),
];
