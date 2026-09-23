/**
 * Splunk indexer: where the data actually lands.
 *
 * Indexes and their retention, and the parsing settings that decide what an
 * event even is. These are the settings that are only correctable by
 * re-indexing, which is why getting them right before the data arrives matters
 * more here than anywhere else in Splunk.
 *
 * Two things are worth saying plainly and are said in every generated app: a
 * `props.conf` deployed to a search head does nothing for data arriving over a
 * forwarder, and none of it applies retroactively.
 */

import { bool, num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, warning, type Finding } from '../../core/findings.ts';
import { splunkBlueprint, type SplunkBlueprint } from '../from-app.ts';
import { defaultMeta, listOf, splunkName, type SplunkApp } from '../splunk.ts';

const TIER = 'indexer' as const;

export const INDEXER_BLUEPRINTS: readonly SplunkBlueprint[] = [
  splunkBlueprint({
    id: 'splunk_index',
    tier: TIER,
    label: 'Index with retention and sizing',
    group: 'Indexes',
    description: 'An index sized from the daily volume and the retention you actually need, with the frozen path decision made rather than defaulted — because the default deletes.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_indexes' },
      { id: 'index_name', label: 'Index name', control: 'text', default: 'app_prod' },
      { id: 'daily_gb', label: 'Daily volume (GB)', control: 'number', default: 20, min: 1, max: 100000 },
      { id: 'retention_days', label: 'Retention (days)', control: 'number', default: 90, min: 1, max: 3650 },
      { id: 'hot_days', label: 'Keep searchable on fast disk for (days)', control: 'number', default: 7, min: 1, max: 365 },
      { id: 'compression', label: 'Expected compression', control: 'select', default: '0.5', options: [
        { value: '0.35', label: 'Structured text — about 35% of raw' },
        { value: '0.5', label: 'Mixed — about 50%' },
        { value: '0.7', label: 'Already compact or binary — about 70%' },
      ] },
      { id: 'frozen', label: 'When data ages out', control: 'select', default: 'delete', options: [
        { value: 'delete', label: 'Delete it' },
        { value: 'archive', label: 'Move it to a frozen archive path' },
      ] },
      { id: 'frozen_path', label: 'Frozen path', control: 'text', default: '/splunk/frozen/$_index_name', showWhen: { input: 'frozen', equals: ['archive'] } },
      { id: 'replication', label: 'Cluster replication factor', control: 'select', default: 'auto', options: [
        { value: 'auto', label: 'The cluster default' },
        { value: '0', label: 'Not replicated — a standalone indexer' },
      ] },
      { id: 'tstats_only', label: 'Metrics index', control: 'toggle', default: false, hint: 'For numeric measurements rather than events — far smaller, and only readable with mstats' },
    ],
    app: (values: BlueprintValues): SplunkApp => {
      const app = splunkName(str(values, 'app_name', 'org_indexes'), 'org_indexes');
      const index = splunkName(str(values, 'index_name', 'app_prod'), 'app_prod');
      const dailyGb = num(values, 'daily_gb', 20);
      const retentionDays = num(values, 'retention_days', 90);
      const hotDays = num(values, 'hot_days', 7);
      const compression = Number(str(values, 'compression', '0.5')) || 0.5;
      const archive = str(values, 'frozen', 'delete') === 'archive';
      const metrics = bool(values, 'tstats_only', false);
      const findings: Finding[] = [];

      // Raw is compressed; the index files are roughly a third again on top.
      const perDayGb = dailyGb * compression * 1.35;
      const totalGb = Math.ceil(perDayGb * retentionDays);
      const hotGb = Math.ceil(perDayGb * hotDays);
      const maxTotalMb = Math.ceil(totalGb * 1024 * 1.1); // 10% headroom
      const frozenSeconds = retentionDays * 86400;

      if (hotDays >= retentionDays) {
        findings.push(error('splunk.hot-exceeds-retention', 'The hot and warm window is as long as the whole retention, so nothing ever rolls to cold. That is valid only if there is no separate cold storage.', { source: 'ArchToolKit' }));
      }
      if (!archive) {
        findings.push(
          warning('splunk.frozen-deletes', `Data older than ${retentionDays} days is deleted and cannot be recovered. If there is any retention obligation on this data, set a frozen archive path instead — it is one setting, and it cannot be applied retroactively to buckets already gone.`, {
            source: 'ArchToolKit',
          }),
        );
      }
      if (retentionDays > 365 && !archive) {
        findings.push(warning('splunk.long-retention-hot', `${retentionDays} days of searchable retention at ${dailyGb}GB/day is about ${totalGb}GB per index, on every replicated copy. Confirm that is budgeted.`, { source: 'ArchToolKit' }));
      }
      if (metrics) {
        findings.push(
          warning('splunk.metrics-index', 'A metrics index holds measurements, not events. `search` and `tstats` cannot read it — only `mstats` and `mpreview` can. Sending ordinary log events to it silently drops them.', {
            source: 'ArchToolKit',
          }),
        );
      }

      return {
        tier: TIER,
        title: `Index ${index}: ${dailyGb}GB/day, ${retentionDays} days`,
        app,
        activation: 'bundle',
        notes: [
          `Sizing: ${dailyGb}GB/day × ${compression} compression × 1.35 for the index files ≈ ${perDayGb.toFixed(1)}GB a day, ${totalGb}GB over ${retentionDays} days. maxTotalDataSizeMB is set to ${maxTotalMb} — about 10% above that — so a volume spike does not silently start freezing data early.`,
          'Both limits apply: whichever of size or age is reached first rolls the bucket to frozen. An index that hits its size limit starts deleting the oldest data regardless of the retention setting, and nothing alerts.',
          `Hot and warm holds about ${hotGb}GB, which is the window that should be on the fastest disk.`,
          ...(archive ? ['The frozen script is not automatic: Splunk moves the bucket to the frozen path and forgets about it. Whatever backs that path up, and whatever thaws from it, is yours to build and to test.'] : []),
          'Creating the index does not route anything to it. A sourcetype or an input has to name it, which is a separate change on the forwarder.',
        ],
        before: [
          '| rest /services/data/indexes | table title, currentDBSizeMB, maxTotalDataSizeMB, frozenTimePeriodInSecs',
          `| dbinspect index=${index}`,
          '| rest /services/server/status/partitions-space | table mount_point, available, capacity',
          '| rest /services/cluster/config | table replication_factor, search_factor',
        ],
        files: {
          'default/indexes.conf': [
            `[${index}]`,
            ...(metrics ? ['datatype = metric'] : []),
            `homePath = $SPLUNK_DB/${index}/db`,
            `coldPath = $SPLUNK_DB/${index}/colddb`,
            `thawedPath = $SPLUNK_DB/${index}/thaweddb`,
            '',
            `# ${dailyGb}GB/day at ${Math.round(compression * 100)}% compression, ${retentionDays} days retention.`,
            `# Both limits apply — whichever is reached first rolls data to frozen.`,
            `maxTotalDataSizeMB = ${maxTotalMb}`,
            `frozenTimePeriodInSecs = ${frozenSeconds}`,
            '',
            '# Hot and warm is the searchable-on-fast-disk window.',
            `homePath.maxDataSizeMB = ${hotGb * 1024}`,
            'maxHotBuckets = 10',
            'maxWarmDBCount = 300',
            '',
            '# A bucket rolls when it fills or when it spans this long, whichever',
            '# comes first. Capping the span keeps bucket time ranges tight, which',
            '# is what makes a time-bounded search skip buckets it does not need.',
            'maxDataSize = auto_high_volume',
            'maxHotSpanSecs = 86400',
            '',
            ...(archive
              ? [
                  `# Frozen data is moved here and forgotten about. Backing it up and`,
                  `# thawing from it is not Splunk's job.`,
                  `coldToFrozenDir = ${str(values, 'frozen_path', '')}`,
                ]
              : ['# No coldToFrozenDir, so data older than the retention is deleted.']),
            ...(str(values, 'replication', 'auto') === '0' ? ['', 'repFactor = 0'] : ['', '# Replicated at the cluster default.', 'repFactor = auto']),
          ],
          'metadata/default.meta': defaultMeta(),
        },
        verify: [
          `| rest /services/data/indexes | search title=${index} | table title, currentDBSizeMB, maxTotalDataSizeMB, frozenTimePeriodInSecs, totalEventCount`,
          `| dbinspect index=${index} | stats count by state`,
          `index=${index} | head 1`,
          `| rest /services/cluster/master/indexes | search title=${index}   # on the cluster manager`,
          '| rest /services/server/status/partitions-space | table mount_point, available',
        ],
        backout: [
          `# Removing the stanza does not delete the data. To remove both:`,
          `# 1. Take the stanza out of ${app}/default/indexes.conf and push the bundle.`,
          `# 2. splunk clean eventdata -index ${index}    (stops ingestion, deletes everything)`,
          `# There is no undo for step 2.`,
        ],
        findings,
      };
    },
  }),

  splunkBlueprint({
    id: 'splunk_sourcetype',
    tier: TIER,
    label: 'Sourcetype parsing',
    group: 'Parsing',
    description: 'The five settings that decide what an event is and when it happened — the ones that cannot be fixed later without re-indexing, and that Splunk guesses badly without.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_parsing' },
      { id: 'sourcetype', label: 'Sourcetype', control: 'text', default: 'app:json' },
      { id: 'format', label: 'Format', control: 'select', default: 'json', options: [
        { value: 'json', label: 'JSON, one object per line' },
        { value: 'line', label: 'One event per line' },
        { value: 'multiline', label: 'Multi-line, each event starting with a timestamp' },
        { value: 'csv', label: 'Delimited, with a header' },
        { value: 'syslog', label: 'Syslog' },
      ] },
      { id: 'timestamp_prefix', label: 'What comes before the timestamp', control: 'text', default: '"timestamp":"', hint: 'A literal or a regex — empty if it is first' },
      { id: 'timestamp_format', label: 'Timestamp format', control: 'text', default: '%Y-%m-%dT%H:%M:%S.%3N%Z', hint: 'strptime, Splunk flavoured' },
      { id: 'event_start', label: 'A new event starts with', control: 'text', default: '^\\d{4}-\\d{2}-\\d{2}', showWhen: { input: 'format', equals: ['multiline'] } },
      { id: 'delimiter', label: 'Delimiter', control: 'select', default: ',', options: [
        { value: ',', label: 'Comma' },
        { value: '\\t', label: 'Tab' },
        { value: '|', label: 'Pipe' },
      ], showWhen: { input: 'format', equals: ['csv'] } },
      { id: 'target_index', label: 'Route to index', control: 'text', default: '', hint: 'Empty to leave the input to decide' },
      { id: 'mask_pattern', label: 'Mask before indexing', control: 'text', default: '', hint: 'A regex whose first group is replaced — for card numbers and the like' },
      { id: 'drop_pattern', label: 'Drop events matching', control: 'text', default: '', hint: 'Noise that should never be indexed at all' },
      { id: 'truncate', label: 'Truncate events at (bytes)', control: 'number', default: 10000, min: 0, max: 1000000 },
    ],
    app: (values: BlueprintValues): SplunkApp => {
      const app = splunkName(str(values, 'app_name', 'org_parsing'), 'org_parsing');
      const sourcetype = str(values, 'sourcetype', 'app:json');
      const format = str(values, 'format', 'json');
      const prefix = str(values, 'timestamp_prefix', '');
      const timeFormat = str(values, 'timestamp_format', '');
      const targetIndex = splunkName(str(values, 'target_index', ''), '');
      const mask = str(values, 'mask_pattern', '');
      const drop = str(values, 'drop_pattern', '');
      const truncate = num(values, 'truncate', 10000);
      const findings: Finding[] = [];

      if (!timeFormat) {
        findings.push(
          error('splunk.no-time-format', 'Without TIME_FORMAT, Splunk guesses. It guesses wrongly on anything ambiguous — 03/04/2026 is two different dates — and every event indexed with the wrong time stays wrong.', {
            remediation: 'Set TIME_FORMAT from a real sample line.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (!prefix && format !== 'syslog') {
        findings.push(
          warning('splunk.no-time-prefix', 'Without TIME_PREFIX, Splunk looks for a timestamp anywhere in the first 128 characters — and will happily find a version number, a request id or a duration and use that instead.', {
            remediation: 'Anchor it with what immediately precedes the real timestamp.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (truncate === 0) {
        findings.push(
          warning('splunk.no-truncate', 'TRUNCATE = 0 means no limit. One malformed line with no line breaks becomes a single enormous event that can stall the pipeline.', { source: 'ArchToolKit' }),
        );
      }
      if (drop) {
        findings.push(
          warning('splunk.dropping-events', 'Dropped events are gone: not indexed, not licensed, not recoverable. Confirm against a sample that the pattern matches only what you mean, because there is no way to tell later what it discarded.', {
            source: 'ArchToolKit',
          }),
        );
      }
      if (mask) {
        findings.push(
          warning('splunk.masking-is-index-time', 'Masking happens before indexing, so the original never reaches disk — which is the point. It also means a mistake in the pattern loses data permanently, and that events already indexed still hold the unmasked value.', {
            source: 'ArchToolKit',
          }),
        );
      }

      const lineBreaker =
        format === 'multiline'
          ? `([\\r\\n]+)(?=${str(values, 'event_start', '^\\d{4}')})`
          : '([\\r\\n]+)';

      return {
        tier: TIER,
        title: `Sourcetype ${sourcetype}: line breaking and timestamps`,
        app,
        activation: 'bundle',
        notes: [
          'These are index-time settings. They must be on the tier that parses the data — the indexers, or the heavy forwarder if there is one in the path. On a search head they do nothing at all, with no error.',
          'None of it is retroactive. Events already indexed keep the parsing they got; the only correction is to re-index them.',
          'Test before deploying: `splunk cmd btool props list ' + sourcetype + ' --debug` shows what is in effect and where it came from, and the Add Data preview shows how a sample file would break.',
          ...(format === 'json' ? ['INDEXED_EXTRACTIONS = json extracts the fields at index time, which makes them available to tstats but grows the index. KV_MODE = json extracts at search time instead: smaller index, slower searches. This uses index-time, which is the usual choice for JSON that is searched a lot.'] : []),
          `SHOULD_LINEMERGE = false with an explicit LINE_BREAKER is both faster and more predictable than letting Splunk merge lines. It is the single most valuable setting here.`,
          ...(targetIndex ? [`Events are routed to the index "${targetIndex}" regardless of what the input says. That index has to exist on every indexer, or the data is dropped.`] : []),
        ],
        before: [
          `splunk cmd btool props list ${sourcetype} --debug`,
          `index=* sourcetype=${sourcetype} | head 5`,
          `index=* sourcetype=${sourcetype} | eval delta=_indextime-_time | stats avg(delta), max(delta)   # a large delta means the timestamp is being read wrongly`,
          'index=_internal sourcetype=splunkd component=DateParserVerbose | tail 20',
        ],
        files: {
          'default/props.conf': [
            `[${sourcetype}]`,
            '',
            '# What an event is. An explicit LINE_BREAKER with SHOULD_LINEMERGE off',
            '# is both faster and far more predictable than line merging.',
            'SHOULD_LINEMERGE = false',
            `LINE_BREAKER = ${lineBreaker}`,
            `TRUNCATE = ${truncate}`,
            '',
            '# When it happened. Without both of these Splunk guesses, and a wrong',
            '# guess is permanent for every event indexed with it.',
            ...(prefix ? [`TIME_PREFIX = ${prefix}`] : ['# TIME_PREFIX not set — the timestamp is expected at the start of the event.']),
            ...(timeFormat ? [`TIME_FORMAT = ${timeFormat}`] : []),
            'MAX_TIMESTAMP_LOOKAHEAD = 40',
            '',
            '# Reject an event whose timestamp is implausible rather than indexing',
            '# it under the wrong day.',
            'MAX_DAYS_AGO = 30',
            'MAX_DAYS_HENCE = 2',
            '',
            ...(format === 'json' ? ['# Field extraction at index time: searchable with tstats, larger index.', 'INDEXED_EXTRACTIONS = json', 'KV_MODE = none', ''] : []),
            ...(format === 'csv'
              ? [
                  'INDEXED_EXTRACTIONS = csv',
                  `FIELD_DELIMITER = ${str(values, 'delimiter', ',')}`,
                  'HEADER_FIELD_LINE_NUMBER = 1',
                  'KV_MODE = none',
                  '',
                ]
              : []),
            ...(format === 'syslog' ? ['# Syslog priority and host are handled by the standard rules.', 'TRANSFORMS-syslog = syslog-host', ''] : []),
            'category = Custom',
            `description = ${sourcetype}, configured by ArchToolKit`,
            '',
            ...(targetIndex || drop || mask
              ? [
                  '# Index-time transforms, applied in this order.',
                  `TRANSFORMS-archtoolkit = ${[...(drop ? ['drop_noise'] : []), ...(targetIndex ? ['route_index'] : [])].join(', ')}`,
                  ...(mask ? [`SEDCMD-mask = s/${mask}/***MASKED***/g`] : []),
                ]
              : []),
          ],
          ...(targetIndex || drop
            ? {
                'default/transforms.conf': [
                  ...(drop
                    ? [
                        '[drop_noise]',
                        `REGEX = ${drop}`,
                        'DEST_KEY = queue',
                        'FORMAT = nullQueue',
                        '# Dropped here means never indexed, never licensed, never recoverable.',
                        '',
                      ]
                    : []),
                  ...(targetIndex
                    ? [
                        '[route_index]',
                        'REGEX = .',
                        'DEST_KEY = _MetaData:Index',
                        `FORMAT = ${targetIndex}`,
                        '# The index has to exist on every indexer or the data is dropped.',
                      ]
                    : []),
                ],
              }
            : {}),
          'metadata/default.meta': defaultMeta(),
        },
        verify: [
          `splunk cmd btool props list ${sourcetype} --debug`,
          `index=${targetIndex || '*'} sourcetype=${sourcetype} | head 20 | table _time, _raw`,
          `index=${targetIndex || '*'} sourcetype=${sourcetype} | eval delta=_indextime-_time | stats avg(delta) as avg_delta, max(delta) as max_delta`,
          `index=${targetIndex || '*'} sourcetype=${sourcetype} | stats count by punct | head 10   # several punct patterns means line breaking is wrong`,
          'index=_internal sourcetype=splunkd component=AggregatorMiningProcessor | tail 20',
          ...(drop ? ['index=_internal sourcetype=splunkd component=nullQueue | tail 10'] : []),
        ],
        backout: [
          `# Remove the stanza and push the bundle. Events already indexed keep`,
          `# whatever parsing they were given — the settings are not retroactive`,
          `# in either direction.`,
          `rm -rf $SPLUNK_HOME/etc/apps/${app}   # then: splunk apply cluster-bundle`,
        ],
        findings,
      };
    },
  }),
];
