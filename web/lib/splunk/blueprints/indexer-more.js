/**
 * Splunk indexer, continued: where the buckets live, and what happens to data
 * on the way in.
 *
 * Storage is the part of Splunk that fails slowest and worst. A volume without
 * a size limit fills the disk and stops indexing; a SmartStore cache sized
 * without reference to how far back people search turns every dashboard into
 * an S3 download; and a frozen path nobody tested is a retention promise that
 * was never kept. The ingest settings — metrics conversion and Ingest Actions —
 * share the indexer's other property: they apply once, as the data arrives,
 * and never again.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, warning,              } from '../../core/findings.js';
import { splunkBlueprint,                      } from '../from-app.js';
import { defaultMeta, listOf, splunkName,                } from '../splunk.js';

const TIER = 'indexer'         ;

/** A regex that matches nearly anything is a regex that will drop or mask nearly everything. */
function tooBroad(pattern        )          {
  const p = pattern.trim();
  if (!p) return false;
  if (/^\^?\.[*+]\$?$/.test(p)) return true;
  if (/^\(?\.[*+]\)?/.test(p) && p.length < 12) return true;
  if (/^\\[dws][+*]$/.test(p)) return true;
  if (p.length < 5 && !/^\\b/.test(p)) return true;
  return false;
}

/** Dimension names that are usually one value per event, which is what makes a metrics index unusable. */
const HIGH_CARDINALITY = /(^|_)(id|uuid|guid|session|trace|span|request|req|txn|transaction|user|email|url|uri|path|ip|src_ip|client_ip|timestamp|ts)($|_)/i;

export const INDEXER_MORE_BLUEPRINTS                             = [
  // --- SmartStore -----------------------------------------------------------
  splunkBlueprint({
    id: 'splunk_smartstore',
    tier: TIER,
    label: 'SmartStore on S3',
    group: 'Storage',
    description: 'Warm buckets in S3 with the indexers as a cache: the remote volume authenticated by an IAM role rather than keys, encrypted with KMS, and the cache sized from how much people ingest and how far back they search.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_smartstore' },
      { id: 'remote_path', label: 'Remote path', control: 'text', default: 's3://acme-splunk-smartstore-prod/indexes', hint: 's3://bucket/prefix — one prefix per cluster, never shared' },
      { id: 'endpoint', label: 'S3 endpoint', control: 'text', default: 'https://s3.eu-west-2.amazonaws.com' },
      { id: 'region', label: 'Region', control: 'text', default: 'eu-west-2' },
      { id: 'auth', label: 'Authenticate with', control: 'select', default: 'role', options: [
        { value: 'role', label: 'The instance profile or IRSA role — no keys on disk' },
        { value: 'keys', label: 'Access key and secret key' },
      ] },
      { id: 'encryption', label: 'Encryption', control: 'select', default: 'sse-kms', options: [
        { value: 'sse-kms', label: 'SSE-KMS with a customer managed key' },
        { value: 'sse-s3', label: 'SSE-S3 — S3 managed keys' },
        { value: 'none', label: 'None set by Splunk' },
      ] },
      { id: 'kms_key', label: 'KMS key ARN or id', control: 'text', default: 'arn:aws:kms:eu-west-2:111122223333:key/REPLACE-ME', showWhen: { input: 'encryption', equals: ['sse-kms'] } },
      { id: 'scope', label: 'Which indexes', control: 'select', default: 'all', options: [
        { value: 'all', label: 'Every index — set in [default]' },
        { value: 'list', label: 'Only the indexes listed' },
      ] },
      { id: 'indexes', label: 'Indexes', control: 'textarea', default: 'app_prod\nnetfw\nosnix', showWhen: { input: 'scope', equals: ['list'] } },
      { id: 'daily_gb', label: 'Daily ingest across these indexes (GB)', control: 'number', default: 500, min: 1, max: 1000000 },
      { id: 'search_days', label: 'Most searches look back (days)', control: 'number', default: 7, min: 1, max: 365, hint: 'The window the cache has to hold, or searches wait for S3' },
      { id: 'indexer_count', label: 'Indexers', control: 'number', default: 6, min: 1, max: 1000 },
      { id: 'cache_gb', label: 'Cache disk per indexer (GB)', control: 'number', default: 1500, min: 10, max: 1000000 },
      { id: 'retention_days', label: 'Retention (days)', control: 'number', default: 365, min: 1, max: 3650 },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_smartstore'), 'org_smartstore');
      const remotePath = str(values, 'remote_path', '').trim().replace(/\/+$/, '');
      const endpoint = str(values, 'endpoint', '').trim();
      const region = str(values, 'region', '').trim();
      const keys = str(values, 'auth', 'role') === 'keys';
      const encryption = str(values, 'encryption', 'sse-kms');
      const kmsKey = str(values, 'kms_key', '').trim();
      const listed = str(values, 'scope', 'all') === 'list';
      const indexes = listed ? listOf(str(values, 'indexes', '')).map((i) => splunkName(i, '')).filter(Boolean) : [];
      const dailyGb = num(values, 'daily_gb', 500);
      const searchDays = num(values, 'search_days', 7);
      const indexers = Math.max(1, num(values, 'indexer_count', 6));
      const cacheGb = num(values, 'cache_gb', 1500);
      const retentionDays = num(values, 'retention_days', 365);
      const findings            = [];

      // On disk a bucket is about half the raw size (compressed raw plus the
      // tsidx files). The cache has to hold the search window's worth of
      // buckets, spread across the indexers, plus hot buckets and headroom.
      const onDiskPerDayGb = dailyGb * 0.5;
      const neededPerIndexerGb = Math.ceil(((onDiskPerDayGb * searchDays) / indexers) * 1.3);
      const maxCacheMb = Math.floor(cacheGb * 1024 * 0.85);
      const totalRemoteGb = Math.ceil(onDiskPerDayGb * retentionDays);
      const perIndexGlobalMb = indexes.length > 0 ? Math.ceil((totalRemoteGb * 1024 * 1.1) / indexes.length) : 0;
      const bucketMatch = /^s3:\/\/([^/]+)(\/.*)?$/.exec(remotePath);
      const bucket = bucketMatch?.[1] ?? '<bucket>';
      const prefix = (bucketMatch?.[2] ?? '').replace(/^\//, '');

      if (!bucketMatch) {
        findings.push(error('splunk.smartstore-path', `"${remotePath}" is not an s3://bucket/prefix path. The volume will not initialise and every index that uses it will fail to start.`, { source: 'ArchToolKit' }));
      }
      if (keys) {
        findings.push(
          error('splunk.smartstore-access-keys', 'Static access keys in indexes.conf sit on every indexer and in every copy of the cluster bundle, and they never expire. Splunk uses the instance or pod role automatically when both key settings are empty.', {
            remediation: 'Attach an instance profile (EC2) or an IRSA service account role (EKS) with the policy in ops/, and leave remote.s3.access_key and remote.s3.secret_key empty.',
            source: 'docs.splunk.com — SmartStore on S3 security strategies',
          }),
        );
      }
      if (encryption === 'none') {
        findings.push(
          warning('splunk.smartstore-no-encryption', 'Splunk is not asking S3 to encrypt the buckets. If the bucket has no default encryption either, every warm bucket — every log the organisation has — is stored in clear.', {
            remediation: 'Use sse-kms with a customer managed key, or at least sse-s3, and enforce it with a bucket policy.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (encryption === 'sse-kms' && (!kmsKey || /REPLACE/.test(kmsKey))) {
        findings.push(warning('splunk.smartstore-kms-key', 'SSE-KMS is selected but the key is still a placeholder. The indexers will fail every upload until it names a real key the role can use.', { source: 'ArchToolKit' }));
      }
      if (cacheGb < neededPerIndexerGb * 0.5) {
        findings.push(
          error('splunk.smartstore-cache-too-small', `Each indexer's cache is ${cacheGb}GB, but ${searchDays} days of searching at ${dailyGb}GB/day needs about ${neededPerIndexerGb}GB per indexer. Most searches will download buckets from S3 first, and the cache will evict what the next search needs.`, {
            remediation: `Size the cache for at least ${neededPerIndexerGb}GB per indexer, or add indexers.`,
            source: 'ArchToolKit',
          }),
        );
      } else if (cacheGb < neededPerIndexerGb) {
        findings.push(
          warning('splunk.smartstore-cache-tight', `The cache (${cacheGb}GB per indexer) is below the ${neededPerIndexerGb}GB that ${searchDays} days of searching needs. Searches at the edge of the window will fetch from S3.`, {
            source: 'ArchToolKit',
          }),
        );
      }
      if (listed && indexes.length === 0) {
        findings.push(error('splunk.smartstore-no-indexes', 'Only listed indexes were chosen, and none were listed.', { source: 'ArchToolKit' }));
      }
      findings.push(
        warning('splunk.smartstore-one-way', 'Enabling SmartStore on an existing index is one way. Its buckets are uploaded and the index cannot be converted back to local storage — the only way out is to re-index or to export.', {
          source: 'docs.splunk.com — Migrate existing data on an indexer cluster to SmartStore',
        }),
      );

      const remoteLines = [
        '# Every warm bucket for the indexes below is uploaded here. The',
        '# prefix belongs to this cluster alone: two clusters writing to one',
        '# prefix corrupt each other.',
        '[volume:remote_store]',
        'storageType = remote',
        `path = ${remotePath}`,
        `remote.s3.endpoint = ${endpoint}`,
        `remote.s3.auth_region = ${region}`,
        'remote.s3.signature_version = v4',
        '',
        ...(keys
          ? [
              '# Keys are set here only because role authentication was not chosen.',
              '# Put the real values in local/indexes.conf on the cluster manager,',
              '# never in version control, and rotate them.',
              'remote.s3.access_key = <REQUIRED — set in local/, not here>',
              'remote.s3.secret_key = <REQUIRED — set in local/, not here>',
            ]
          : [
              '# No keys. With both of these empty, Splunk takes credentials from the',
              '# EC2 instance profile or the pod’s IRSA role, which rotate on their',
              '# own and never appear in the bundle.',
              'remote.s3.access_key =',
              'remote.s3.secret_key =',
            ]),
        '',
        ...(encryption === 'sse-kms'
          ? [
              '# Server-side encryption with a customer managed key. The role needs',
              '# kms:GenerateDataKey and kms:Decrypt on this key, or uploads fail.',
              'remote.s3.encryption = sse-kms',
              `remote.s3.kms.key_id = ${kmsKey}`,
              `remote.s3.kms.auth_region = ${region}`,
            ]
          : encryption === 'sse-s3'
            ? ['# Server-side encryption with S3 managed keys.', 'remote.s3.encryption = sse-s3']
            : ['# Splunk is not asking for encryption. Only the bucket default protects this data.', 'remote.s3.encryption = none']),
        '',
      ];

      const retentionLines = (globalMb        ) => [
        `# Retention: ${retentionDays} days, after which the bucket is removed from S3`,
        '# (frozen). In SmartStore the size limit is global — across the whole',
        '# cluster and the remote store — not per indexer.',
        `frozenTimePeriodInSecs = ${retentionDays * 86400}`,
        ...(globalMb > 0 ? [`maxGlobalDataSizeMB = ${globalMb}`] : ['# maxGlobalDataSizeMB = 0 (unlimited) — age alone freezes data. Set it per index.']),
      ];

      return {
        tier: TIER,
        title: `SmartStore on ${remotePath || 'S3'}: ${listed ? `${indexes.length} indexes` : 'every index'}`,
        app,
        activation: 'bundle',
        notes: [
          `Cache sizing: ${dailyGb}GB/day raw is about ${onDiskPerDayGb.toFixed(0)}GB/day on disk. ${searchDays} days of that across ${indexers} indexers, with 30% headroom for hot buckets and the next search, is about ${neededPerIndexerGb}GB per indexer. The cache disk here is ${cacheGb}GB; max_cache_size is set to 85% of it (${maxCacheMb}MB) so the partition never fills.`,
          `Remote store: about ${totalRemoteGb}GB in S3 at ${retentionDays} days — one copy, because S3 is the durability. Replication factor on the cluster still applies to hot buckets only.`,
          'SmartStore settings must be identical on every peer. Deploy them only through the cluster manager bundle, never by hand on one indexer.',
          'Migration is one way. Existing warm and cold buckets upload on the first restart after this is applied, which is a large, long burst of S3 traffic — plan it as a change window, and test on one non-critical index first by using the listed-indexes scope.',
          'homePath, coldPath and thawedPath are still required. coldPath is not used for SmartStore indexes, and thawedPath is where restored frozen buckets go — it stays local.',
          'maxDataSize should stay at auto (750MB). Larger buckets make every cache miss a bigger download.',
          'VERIFY: an IRSA role (EKS web identity) is supported by the Splunk Operator. On a self-managed install outside Kubernetes, use an EC2 instance profile.',
          'ops/smartstore-iam-policy.json: s3:ListBucket, PutObject, GetObject and DeleteObject are the permissions Splunk documents for SmartStore; ListBucketVersions and DeleteObjectVersion are needed because remote.s3.supports_versioning defaults to true. GetBucketLocation has its own statement without the s3:prefix condition, which it never carries.',
          ...(prefix ? [`VERIFY: listing is restricted to the prefix ${prefix}/. If S3Client logs AccessDenied on a list after the bundle push (the verify search below), SmartStore is listing outside it — drop the Condition from the "List" statement.`] : []),
        ],
        before: [
          `aws s3 ls ${remotePath}/ --region ${region}   # from an indexer, with its own role — proves reachability and permission`,
          'aws sts get-caller-identity   # on an indexer: the role Splunk will use',
          'splunk cmd btool indexes list volume:remote_store --debug',
          '| rest /services/data/indexes | table title, currentDBSizeMB, homePath, remotePath',
          '| rest /services/server/status/partitions-space | table mount_point, available, capacity',
          `splunk cmd splunkd rfs -- ls --starts-with volume:remote_store   # after the bundle push, on a peer`,
        ],
        files: {
          'default/indexes.conf': [
            ...remoteLines,
            ...(listed
              ? indexes.flatMap((index) => [
                  `[${index}]`,
                  `homePath = $SPLUNK_DB/${index}/db`,
                  `coldPath = $SPLUNK_DB/${index}/colddb`,
                  '# thawedPath cannot be on a volume, and is never remote.',
                  `thawedPath = $SPLUNK_DB/${index}/thaweddb`,
                  '# $_index_name keeps each index in its own prefix under the volume.',
                  'remotePath = volume:remote_store/$_index_name',
                  'repFactor = auto',
                  'maxDataSize = auto',
                  ...retentionLines(perIndexGlobalMb),
                  '',
                ])
              : [
                  '# Every index — including ones created later — uses SmartStore.',
                  '[default]',
                  'remotePath = volume:remote_store/$_index_name',
                  'repFactor = auto',
                  'maxDataSize = auto',
                  ...retentionLines(0),
                  '',
                  '# Internal indexes can stay local if preferred: give _internal,',
                  '# _audit and friends an empty remotePath in their own stanzas.',
                ]),
          ],
          'default/server.conf': [
            '# The cache manager decides what stays on local disk. VERIFY that your',
            '# version distributes server.conf [cachemanager] through the cluster',
            '# bundle; if not, set it in $SPLUNK_HOME/etc/system/local on each peer.',
            '[cachemanager]',
            `# 85% of the ${cacheGb}GB cache disk, in MB. Beyond this the least recently`,
            '# used buckets are evicted, and a search that needs them waits for S3.',
            `max_cache_size = ${maxCacheMb}`,
            'eviction_policy = lru',
            '# Buckets whose data is newer than this are not evicted while anything',
            '# older can be. The default (one day) protects the busiest window.',
            'hotlist_recency_secs = 86400',
            '# Bloom filters and small metadata files are kept longer: they are tiny',
            '# and let a search skip a bucket without downloading it.',
            'hotlist_bloom_filter_recency_hours = 360',
            '# Free space the cache manager keeps in reserve, in MB.',
            'eviction_padding = 5120',
          ],
          'ops/smartstore-iam-policy.json': [
            JSON.stringify(
              {
                Version: '2012-10-17',
                Statement: [
                  // GetBucketLocation carries no s3:prefix key, so it cannot share the
                  // prefix-conditioned statement (it would always be denied). It is not
                  // in Splunk's SmartStore list; it is here for the aws s3 checks in
                  // "before" and for SDKs that resolve the bucket region.
                  { Sid: 'BucketLocation', Effect: 'Allow', Action: ['s3:GetBucketLocation'], Resource: `arn:aws:s3:::${bucket}` },
                  // Listing. ListBucketVersions: remote.s3.supports_versioning defaults to
                  // true, and freezing then deletes every version (SmartStore on S3
                  // security strategies). With a prefix, listing is limited to it.
                  {
                    Sid: 'List',
                    Effect: 'Allow',
                    Action: ['s3:ListBucket', 's3:ListBucketVersions'],
                    Resource: `arn:aws:s3:::${bucket}`,
                    ...(prefix ? { Condition: { StringLike: { 's3:prefix': [prefix, `${prefix}/`, `${prefix}/*`] } } } : {}),
                  },
                  { Sid: 'Objects', Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:DeleteObjectVersion', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts'], Resource: `arn:aws:s3:::${bucket}/${prefix ? `${prefix}/` : ''}*` },
                  ...(encryption === 'sse-kms' ? [{ Sid: 'Kms', Effect: 'Allow', Action: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'], Resource: kmsKey || '<kms key arn>' }] : []),
                ],
              },
              null,
              2,
            ),
          ],
          'metadata/default.meta': defaultMeta(),
        },
        verify: [
          'splunk cmd btool indexes list volume:remote_store --debug',
          'splunk cmd btool server list cachemanager --debug',
          `splunk cmd splunkd rfs -- ls --starts-with volume:remote_store/${indexes[0] ?? '<index>'}`,
          '| rest /services/admin/cacheman/_metrics splunk_server=* | table splunk_server, *',
          'index=_internal sourcetype=splunkd component=CacheManager* log_level=ERROR earliest=-1h | stats count by splunk_server, message',
          'index=_internal source=*metrics.log group=cachemgr_download earliest=-24h | timechart sum(kb) as kb_downloaded   # sustained downloads mean the cache is too small',
          'index=_internal sourcetype=splunkd component=S3Client log_level=ERROR earliest=-1h | stats count by message',
        ],
        backout: [
          '# Before any bucket has uploaded: remove remotePath from the stanzas and push the bundle.',
          '# After buckets have uploaded there is no backout to local storage — that is the',
          '# one-way property. Leave the volume in place; removing it orphans every warm',
          '# bucket in S3 and those indexes stop being searchable.',
          `aws s3 ls ${remotePath}/ --recursive --summarize | tail -2   # what is already remote`,
        ],
        findings,
      };
    },
  }),

  // --- Classic volumes ------------------------------------------------------
  splunkBlueprint({
    id: 'splunk_volumes',
    tier: TIER,
    label: 'Hot and cold volumes',
    group: 'Storage',
    description: 'Classic local storage: a hot/warm volume on fast disk and a cold volume on cheap disk, both capped so the partition can never fill, with every index placed on them and the frozen archive decided.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_volumes' },
      { id: 'hot_path', label: 'Hot and warm path', control: 'text', default: '/splunk/hot' },
      { id: 'hot_size_gb', label: 'Hot volume limit (GB)', control: 'number', default: 1800, min: 0, max: 1000000, hint: 'About 90% of the partition — 0 means no limit' },
      { id: 'cold_path', label: 'Cold path', control: 'text', default: '/splunk/cold' },
      { id: 'cold_size_gb', label: 'Cold volume limit (GB)', control: 'number', default: 9000, min: 0, max: 1000000 },
      { id: 'thawed_root', label: 'Thawed path root', control: 'text', default: '/splunk/thawed' },
      { id: 'thawed_on_volume', label: 'Put thawedPath on the cold volume', control: 'toggle', default: false, hint: 'Not supported by Splunk' },
      { id: 'indexes', label: 'Indexes', control: 'textarea', default: 'app_prod | 50 | 90 | 7\nnetfw | 200 | 180 | 14\nosnix | 30 | 90 | 7', hint: 'name | GB/day | retention days | hot days' },
      { id: 'frozen', label: 'When data ages out', control: 'select', default: 'dir', options: [
        { value: 'delete', label: 'Delete it' },
        { value: 'dir', label: 'Move it to a directory (NFS)' },
        { value: 's3', label: 'Archive it to S3 with a script' },
      ] },
      { id: 'frozen_dir', label: 'Frozen directory', control: 'text', default: '/mnt/splunk_archive', showWhen: { input: 'frozen', equals: ['dir'] } },
      { id: 'frozen_s3', label: 'Archive bucket', control: 'text', default: 's3://acme-splunk-frozen/archive', showWhen: { input: 'frozen', equals: ['s3'] } },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_volumes'), 'org_volumes');
      const hotPath = str(values, 'hot_path', '/splunk/hot').replace(/\/+$/, '');
      const coldPath = str(values, 'cold_path', '/splunk/cold').replace(/\/+$/, '');
      const thawedRoot = str(values, 'thawed_root', '/splunk/thawed').replace(/\/+$/, '');
      const hotGb = num(values, 'hot_size_gb', 1800);
      const coldGb = num(values, 'cold_size_gb', 9000);
      const thawedOnVolume = bool(values, 'thawed_on_volume', false);
      const frozen = str(values, 'frozen', 'dir');
      const frozenDir = str(values, 'frozen_dir', '/mnt/splunk_archive').replace(/\/+$/, '');
      const frozenS3 = str(values, 'frozen_s3', '').replace(/\/+$/, '');
      const findings            = [];

      const indexes = str(values, 'indexes', '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [name, gb, days, hot] = line.split('|').map((p) => p.trim());
          const retention = Number(days) || 90;
          const hotDays = Math.min(Number(hot) || 7, retention);
          const daily = Number(gb) || 1;
          const perDay = daily * 0.5; // compressed raw + tsidx
          return {
            name: splunkName(name ?? '', ''),
            daily,
            retention,
            hotDays,
            hotGb: Math.ceil(perDay * hotDays),
            coldGb: Math.ceil(perDay * (retention - hotDays)),
          };
        })
        .filter((i) => i.name);
      const hotNeeded = indexes.reduce((s, i) => s + i.hotGb, 0);
      const coldNeeded = indexes.reduce((s, i) => s + i.coldGb, 0);

      if (hotGb === 0 || coldGb === 0) {
        findings.push(
          error('splunk.volume-no-limit', `The ${hotGb === 0 ? 'hot' : 'cold'} volume has no maxVolumeDataSizeMB, so nothing stops the indexes on it from filling the partition. When it fills, splunkd stops indexing (minFreeSpace) and forwarders start blocking.`, {
            remediation: 'Set the limit to about 90% of the partition. Splunk then rolls or freezes the oldest buckets on that volume first.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (thawedOnVolume) {
        findings.push(
          error('splunk.thawed-on-volume', 'thawedPath cannot be defined in terms of a volume — indexes.conf says so explicitly, and the index will fail to load. Thawed buckets are also outside volume size management by design.', {
            remediation: 'Give thawedPath a plain directory path, as the default here does.',
            source: 'indexes.conf.spec — thawedPath',
          }),
        );
      }
      if (hotGb > 0 && hotNeeded > hotGb) {
        findings.push(
          warning('splunk.hot-volume-undersized', `The listed indexes need about ${hotNeeded}GB of hot/warm for their hot windows, but the hot volume is capped at ${hotGb}GB. Buckets will roll to cold sooner than the hot days say.`, {
            source: 'ArchToolKit',
          }),
        );
      }
      if (coldGb > 0 && coldNeeded > coldGb) {
        findings.push(
          warning('splunk.cold-volume-undersized', `The listed indexes need about ${coldNeeded}GB of cold for their retention, but the cold volume is capped at ${coldGb}GB. The volume limit wins: the oldest data is frozen early, whatever frozenTimePeriodInSecs says, and nothing alerts.`, {
            source: 'ArchToolKit',
          }),
        );
      }
      if (frozen === 'delete') {
        findings.push(warning('splunk.frozen-deletes', 'Frozen data is deleted. If any of these indexes has a retention obligation beyond its searchable window, archive instead.', { source: 'ArchToolKit' }));
      }
      if (indexes.length === 0) {
        findings.push(error('splunk.volumes-no-indexes', 'No indexes were listed, so the volumes are defined and nothing uses them.', { source: 'ArchToolKit' }));
      }

      const scriptPath = `$SPLUNK_HOME/etc/apps/${app}/bin/archive_bucket.sh`;
      const sizing = [
        '# Sizing (on disk ≈ 50% of raw):',
        '#   index            GB/day  retention  hot days  hot GB  cold GB',
        ...indexes.map((i) => `#   ${i.name.padEnd(16)} ${String(i.daily).padStart(6)}  ${String(i.retention).padStart(9)}  ${String(i.hotDays).padStart(8)}  ${String(i.hotGb).padStart(6)}  ${String(i.coldGb).padStart(7)}`),
        `#   total                                        ${String(hotNeeded).padStart(6)}  ${String(coldNeeded).padStart(7)}`,
        `#   volume limits                                ${String(hotGb).padStart(6)}  ${String(coldGb).padStart(7)}`,
      ];

      return {
        tier: TIER,
        title: `Volumes: hot ${hotGb}GB at ${hotPath}, cold ${coldGb}GB at ${coldPath}, ${indexes.length} indexes`,
        app,
        activation: 'bundle',
        notes: [
          `Hot/warm needs about ${hotNeeded}GB and cold about ${coldNeeded}GB for the indexes listed, per indexer copy. In a cluster, multiply by the replication factor and divide by the number of indexers.`,
          'maxVolumeDataSizeMB is the setting that protects the partition. When a volume reaches it, Splunk rolls the oldest warm bucket to cold (hot volume) or freezes the oldest cold bucket (cold volume) — across all indexes on it, oldest first. That is data leaving early, silently, which is why the per-index limits and the volume limits must agree.',
          'thawedPath cannot use a volume. It is a plain directory per index, outside volume management.',
          ...(frozen === 'dir' ? [`coldToFrozenDir moves the bucket to ${frozenDir}/<index>/ and forgets it. The NFS mount must be up on every indexer: if it is missing Splunk logs an error and retries, and cold keeps growing until the volume limit freezes — which with the mount down means deletes.`] : []),
          ...(frozen === 's3'
            ? [
                'The archive script copies each frozen bucket to S3 with the indexer’s instance role. Splunk deletes the bucket only when the script exits 0, so a failing script keeps data — and fills cold.',
                `The script is inert until ${app}/local/archive_execute exists on the indexer (a dry run exits 1, so nothing is deleted). Create that file once a dry run has logged the right copy command.`,
              ]
            : []),
          'Moving an existing index onto a volume means moving its bucket directories while splunkd is stopped. The paths change; the buckets do not.',
        ],
        before: [
          `df -h ${hotPath} ${coldPath} ${thawedRoot}`,
          'splunk cmd btool indexes list --debug | grep -E "^\\[volume:|maxVolumeDataSizeMB|homePath|coldPath|thawedPath"',
          '| rest /services/data/indexes | table title, homePath_expanded, coldPath_expanded, currentDBSizeMB, maxTotalDataSizeMB',
          '| rest /services/server/status/partitions-space | table mount_point, available, capacity',
          ...(frozen === 'dir' ? [`mount | grep ${frozenDir} && sudo -u splunk touch ${frozenDir}/.write_test && rm ${frozenDir}/.write_test`] : []),
          ...(frozen === 's3' ? [`aws s3 ls ${frozenS3}/   # as the splunk user, with the instance role`] : []),
        ],
        files: {
          'default/indexes.conf': [
            ...sizing,
            '',
            '# Fast disk: hot and warm buckets, the searchable-quickly window.',
            '[volume:hot]',
            `path = ${hotPath}`,
            ...(hotGb > 0 ? ['# When the volume reaches this, the oldest warm bucket rolls to cold.', `maxVolumeDataSizeMB = ${hotGb * 1024}`] : ['# No maxVolumeDataSizeMB — nothing stops this volume filling the disk.']),
            '',
            '# Cheap disk: cold buckets, the rest of the retention.',
            '[volume:cold]',
            `path = ${coldPath}`,
            ...(coldGb > 0 ? ['# When the volume reaches this, the oldest cold bucket is frozen, early.', `maxVolumeDataSizeMB = ${coldGb * 1024}`] : ['# No maxVolumeDataSizeMB — nothing stops this volume filling the disk.']),
            '',
            ...indexes.flatMap((i) => [
              `[${i.name}]`,
              `homePath = volume:hot/${i.name}/db`,
              `coldPath = volume:cold/${i.name}/colddb`,
              ...(thawedOnVolume
                ? ['# INVALID: thawedPath cannot reference a volume. The index will not load.', `thawedPath = volume:cold/${i.name}/thaweddb`]
                : ['# thawedPath cannot be on a volume. Restored buckets live here, unmanaged.', `thawedPath = ${thawedRoot}/${i.name}/thaweddb`]),
              `# ${i.daily}GB/day: ${i.hotDays} days hot (~${i.hotGb}GB), ${i.retention} days in total.`,
              `homePath.maxDataSizeMB = ${Math.max(1, i.hotGb) * 1024}`,
              `coldPath.maxDataSizeMB = ${Math.max(1, i.coldGb) * 1024}`,
              `frozenTimePeriodInSecs = ${i.retention * 86400}`,
              ...(frozen === 'dir' ? [`coldToFrozenDir = ${frozenDir}/${i.name}`] : []),
              ...(frozen === 's3' ? [`coldToFrozenScript = "${scriptPath}"`] : []),
              '',
            ]),
          ],
          ...(frozen === 's3'
            ? {
                'bin/archive_bucket.sh': [
                  '#!/usr/bin/env bash',
                  '# Called by splunkd as: archive_bucket.sh <bucket directory>',
                  '# Exit 0 only when the bucket is safely in S3 — splunkd deletes it',
                  '# locally on exit 0, and retries later on anything else.',
                  '#',
                  '# Dry run by default: until local/archive_execute exists, the copy is',
                  '# only logged and the script exits 1, so no bucket is ever deleted',
                  '# without having been archived.',
                  'set -euo pipefail',
                  'bucket_dir="${1:?bucket directory}"',
                  'app_dir="$(cd "$(dirname "$0")/.." && pwd)"',
                  `dest="${frozenS3}"`,
                  '# .../<index>/colddb/db_<newest>_<oldest>_<id>',
                  'index="$(basename "$(dirname "$(dirname "$bucket_dir")")")"',
                  'name="$(basename "$bucket_dir")"',
                  '',
                  '# Only rawdata is needed to rebuild a bucket; the tsidx files are',
                  '# regenerated by splunk rebuild when it is thawed.',
                  'cmd=(aws s3 cp --recursive --only-show-errors "$bucket_dir/rawdata" "$dest/$index/$name/rawdata")',
                  '',
                  'if [[ ! -f "$app_dir/local/archive_execute" ]]; then',
                  '  echo "DRY RUN (bucket kept): ${cmd[*]}" >&2',
                  '  exit 1',
                  'fi',
                  '',
                  '"${cmd[@]}"',
                  '# Confirm the journal arrived before letting splunkd delete the bucket.',
                  'aws s3 ls "$dest/$index/$name/rawdata/journal.zst" >/dev/null 2>&1 \\',
                  '  || aws s3 ls "$dest/$index/$name/rawdata/journal.gz" >/dev/null 2>&1',
                  'echo "archived $bucket_dir to $dest/$index/$name" >&2',
                ],
              }
            : {}),
          'metadata/default.meta': defaultMeta(),
        },
        verify: [
          'splunk cmd btool indexes list volume:hot --debug',
          'splunk cmd btool indexes list volume:cold --debug',
          `| rest /services/data/indexes | search title IN (${indexes.map((i) => i.name).join(', ')}) | table title, homePath_expanded, coldPath_expanded, thawedPath_expanded, currentDBSizeMB`,
          `| dbinspect index=${indexes[0]?.name ?? '<index>'} | stats count, sum(sizeOnDiskMB) by state`,
          'index=_internal sourcetype=splunkd component=VolumeManager OR component=BucketMover earliest=-24h | stats count by component, log_level',
          'index=_internal sourcetype=splunkd "freezing" earliest=-7d | stats count by idx   # data leaving; compare against retention',
        ],
        backout: [
          '# The stanzas can be reverted and the bundle pushed, but only while the',
          '# bucket directories are still where the old paths expect them. If buckets',
          '# were moved to the volume paths, move them back with splunkd stopped first.',
          `rm -rf $SPLUNK_HOME/etc/manager-apps/${app}   # on the cluster manager, then: splunk apply cluster-bundle`,
        ],
        findings,
      };
    },
  }),

  // --- Metrics --------------------------------------------------------------
  splunkBlueprint({
    id: 'splunk_metrics',
    tier: TIER,
    label: 'Metrics index and log-to-metrics',
    group: 'Ingest',
    description: 'A metrics index and a way to fill it: converting structured log events into metric data points at ingest, or receiving statsd, collectd or HEC metrics — with the dimensions chosen so the index stays small and fast.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_metrics' },
      { id: 'metrics_index', label: 'Metrics index', control: 'text', default: 'app_metrics' },
      { id: 'retention_days', label: 'Retention (days)', control: 'number', default: 395, min: 1, max: 3650 },
      { id: 'source', label: 'Metrics come from', control: 'select', default: 'logs', options: [
        { value: 'logs', label: 'Log events, converted at ingest' },
        { value: 'statsd', label: 'statsd over UDP' },
        { value: 'collectd', label: 'collectd write_http to HEC' },
        { value: 'hec', label: 'HEC metric events from an application' },
      ] },
      { id: 'sourcetype', label: 'Log sourcetype', control: 'text', default: 'app:perf', showWhen: { input: 'source', equals: ['logs'] } },
      { id: 'format', label: 'Log format', control: 'select', default: 'json', options: [
        { value: 'json', label: 'JSON' },
        { value: 'kv', label: 'key=value pairs' },
      ], showWhen: { input: 'source', equals: ['logs'] } },
      { id: 'measures', label: 'Measures', control: 'text', default: 'cpu_pct, mem_mb, latency_ms, requests', hint: 'Numeric fields that become metrics — or _ALLNUMS_', showWhen: { input: 'source', equals: ['logs'] } },
      { id: 'dimensions', label: 'Keep only these dimensions', control: 'text', default: 'host, service, region, env', hint: 'Empty keeps every other field as a dimension', showWhen: { input: 'source', equals: ['logs'] } },
      { id: 'drop_dims', label: 'Never these as dimensions', control: 'text', default: 'request_id, trace_id, session_id', showWhen: { input: 'source', equals: ['logs'] } },
      { id: 'statsd_port', label: 'statsd port', control: 'number', default: 8125, min: 1024, max: 65535, showWhen: { input: 'source', equals: ['statsd'] } },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_metrics'), 'org_metrics');
      const index = splunkName(str(values, 'metrics_index', 'app_metrics'), 'app_metrics');
      const retentionDays = num(values, 'retention_days', 395);
      const source = str(values, 'source', 'logs');
      const sourcetype = str(values, 'sourcetype', 'app:perf');
      const format = str(values, 'format', 'json');
      const measures = listOf(str(values, 'measures', ''));
      const dimensions = listOf(str(values, 'dimensions', ''));
      const dropDims = listOf(str(values, 'drop_dims', ''));
      const statsdPort = num(values, 'statsd_port', 8125);
      const schema = `metric-schema:${splunkName(sourcetype, 'metrics')}_metrics`;
      const findings            = [];

      if (source === 'logs') {
        if (measures.length === 0) {
          findings.push(error('splunk.metrics-no-measures', 'No measures were given, so no event produces a metric data point and every converted event is dropped from the metrics index.', { source: 'ArchToolKit' }));
        }
        const risky = dimensions.filter((d) => HIGH_CARDINALITY.test(d));
        if (risky.length > 0) {
          findings.push(
            warning('splunk.metrics-high-cardinality', `${risky.join(', ')} ${risky.length === 1 ? 'looks' : 'look'} like one value per event. Every distinct dimension combination is a separate time series, and a request id as a dimension makes the metrics index larger and slower than the logs it came from.`, {
              remediation: 'Keep dimensions to things with tens or hundreds of values — host, service, region — and leave identifiers in the log events.',
              source: 'ArchToolKit',
            }),
          );
        }
        if (dimensions.length === 0 && dropDims.length === 0) {
          findings.push(
            warning('splunk.metrics-all-dimensions', 'With no dimension list, every non-measure field in the event becomes a dimension — including ids, messages and timestamps — which is the usual way a metrics index gets high cardinality.', {
              source: 'ArchToolKit',
            }),
          );
        }
        if (measures.includes('_ALLNUMS_')) {
          findings.push(warning('splunk.metrics-allnums', '_ALLNUMS_ makes every numeric field a measure, including status codes, ports and ids that happen to be numbers.', { source: 'ArchToolKit' }));
        }
      }
      if (source === 'statsd') {
        findings.push(warning('splunk.udp-syslog-loss', 'statsd is UDP: datagrams dropped under load are gone without a trace. That is normally acceptable for metrics; confirm it is here.', { source: 'ArchToolKit' }));
      }

      const mstats = measures.find((m) => m !== '_ALLNUMS_') ?? 'cpu_pct';
      const mstatsExamples =
        source === 'logs'
          ? [
              `| mstats avg(${mstats}) WHERE index=${index} span=5m BY host`,
              `| mstats max(_value) WHERE index=${index} metric_name=${mstats} span=1h BY ${dimensions[1] ?? 'host'}`,
              `| mcatalog values(metric_name) WHERE index=${index}`,
              `| mcatalog values(_dims) WHERE index=${index}`,
            ]
          : source === 'statsd'
            ? [`| mcatalog values(metric_name) WHERE index=${index}`, `| mstats avg(_value) WHERE index=${index} metric_name=* span=1m BY metric_name`]
            : source === 'collectd'
              ? [`| mstats avg(_value) WHERE index=${index} metric_name=cpu.* span=5m BY host`, `| mcatalog values(metric_name) WHERE index=${index}`]
              : [`| mstats avg(_value) WHERE index=${index} metric_name=* span=5m BY metric_name`, `| mcatalog values(_dims) WHERE index=${index}`];

      return {
        tier: TIER,
        title: `Metrics index ${index} from ${source === 'logs' ? `${sourcetype} events` : source}`,
        app,
        activation: 'bundle',
        notes: [
          'A metrics index stores one numeric value per data point with a metric name and its dimensions. It is far smaller and faster than events for the same numbers — and only mstats, mcatalog and mpreview can read it. search and tstats see nothing.',
          'Licensing: a metrics data point is counted at a fixed small size (150 bytes, VERIFY for your licence type) rather than its raw length, which is usually much cheaper than the log line it replaced.',
          ...(source === 'logs'
            ? [
                `Log-to-metrics conversion is index-time: the props and transforms here must be on whichever tier parses ${sourcetype} — the indexers, or the heavy forwarder if one is in the path. The input sending ${sourcetype} must send it to index=${index}; the schema converts it on the way in.`,
                `Each measure becomes a metric named after the field (${measures.slice(0, 2).join(', ')}…). Every field not a measure becomes a dimension unless the dimension lists here say otherwise.`,
                format === 'json'
                  ? 'JSON is converted from index-time extracted fields (INDEXED_EXTRACTIONS = json), which the schema needs — search-time fields do not exist yet at ingest.'
                  : 'key=value is extracted at index time by a WRITE_META transform, because the schema only sees index-time fields.',
              ]
            : []),
          ...(source === 'statsd' ? [`statsd metrics arrive on UDP ${statsdPort} with sourcetype statsd, which Splunk parses into metric data points natively. Dotted names (web.requests.count) become the metric name; dimensions need the statsd tag extension or a custom transform.`] : []),
          ...(source === 'collectd'
            ? ['collectd sends with its write_http plugin to /services/collector/raw with sourcetype collectd_http, which Splunk converts natively. Point the HEC token for collectd at this index only — the HEC blueprint builds that token.']
            : []),
          ...(source === 'hec'
            ? ['An application sends to /services/collector with "event": "metric" and each metric as a "metric_name:<name>" field, dimensions as ordinary fields. Several measures can share one payload. The HEC token must allow this index.']
            : []),
        ],
        before: [
          `| rest /services/data/indexes datatype=metric | table title, currentDBSizeMB, frozenTimePeriodInSecs`,
          ...(source === 'logs' ? [`index=* sourcetype=${sourcetype} earliest=-1h | head 5`, `index=* sourcetype=${sourcetype} earliest=-4h | fieldsummary | table field, distinct_count   # a dimension with thousands of values is a mistake`] : []),
          `splunk cmd btool props list ${source === 'logs' ? sourcetype : source === 'statsd' ? 'statsd' : 'collectd_http'} --debug`,
        ],
        files: {
          'default/indexes.conf': [
            `[${index}]`,
            '# Metric data points, not events. Only mstats and mcatalog read it.',
            'datatype = metric',
            `homePath = $SPLUNK_DB/${index}/db`,
            `coldPath = $SPLUNK_DB/${index}/colddb`,
            `thawedPath = $SPLUNK_DB/${index}/thaweddb`,
            `frozenTimePeriodInSecs = ${retentionDays * 86400}`,
            'repFactor = auto',
            '# Metric buckets are small; a day per bucket keeps mstats time pruning tight.',
            'maxHotSpanSecs = 86400',
          ],
          ...(source === 'logs'
            ? {
                'default/props.conf': [
                  `[${sourcetype}]`,
                  ...(format === 'json'
                    ? ['# The schema reads index-time fields, so JSON is extracted at index time.', 'INDEXED_EXTRACTIONS = json', 'KV_MODE = none']
                    : ['# key=value pairs extracted at index time so the schema can see them.', `TRANSFORMS-kv_to_fields = ${splunkName(sourcetype, 'metrics')}_kv`]),
                  '',
                  '# Turn each event into metric data points on the way into the index.',
                  `METRIC-SCHEMA-TRANSFORMS = ${schema}`,
                ],
                'default/transforms.conf': [
                  ...(format === 'kv'
                    ? [
                        `[${splunkName(sourcetype, 'metrics')}_kv]`,
                        'REGEX = (\\w+)=("[^"]*"|[^\\s,;]+)',
                        'FORMAT = $1::$2',
                        'REPEAT_MATCH = true',
                        'WRITE_META = true',
                        '',
                      ]
                    : []),
                  `[${schema}]`,
                  '# Fields that become measures — one metric data point each.',
                  `METRIC-SCHEMA-MEASURES = ${measures.join(', ')}`,
                  ...(dimensions.length > 0
                    ? ['# Only these fields are kept as dimensions. Everything else is dropped', '# from the data point — which is what keeps cardinality down.', `METRIC-SCHEMA-WHITELIST-DIMS = ${dimensions.join(', ')}`]
                    : []),
                  ...(dropDims.length > 0 ? ['# Never dimensions: one value per event would make one time series per event.', `METRIC-SCHEMA-BLACKLIST-DIMS = ${dropDims.join(', ')}`] : []),
                ],
              }
            : {}),
          ...(source === 'statsd'
            ? {
                'default/inputs.conf': [
                  '# statsd listener. Receiving on an indexer directly is fine for modest',
                  '# volume; at scale, put it on a heavy forwarder.',
                  `[udp://${statsdPort}]`,
                  'disabled = 0',
                  `index = ${index}`,
                  'sourcetype = statsd',
                  'no_appending_timestamp = true',
                ],
              }
            : {}),
          'ops/mstats-examples.spl': mstatsExamples,
          'metadata/default.meta': defaultMeta(),
        },
        verify: [
          ...mstatsExamples.slice(0, 2),
          `| mcatalog values(metric_name) WHERE index=${index}`,
          `| mstats dc(_dims) WHERE index=${index} metric_name=* BY metric_name   # VERIFY syntax; the aim is the series count per metric`,
          'index=_internal sourcetype=splunkd component=MetricSchemaProcessor OR component=MetricsProcessor log_level=WARN earliest=-1h | stats count by message',
        ],
        backout: [
          `# Remove the props/transforms (conversion stops; events for ${index} are then rejected,`,
          '# because a metrics index does not accept events) and redirect the input first.',
          '# The index stanza can stay: removing it does not delete the data.',
          `rm -rf $SPLUNK_HOME/etc/manager-apps/${app}   # on the cluster manager, then: splunk apply cluster-bundle`,
        ],
        findings,
      };
    },
  }),

  // --- Ingest Actions -------------------------------------------------------
  splunkBlueprint({
    id: 'splunk_ingest_actions',
    tier: TIER,
    label: 'Ingest Actions: filter, mask, route to S3',
    group: 'Ingest',
    description: 'An Ingest Actions ruleset for one sourcetype: drop the noise, mask what must never be indexed, and send a copy — or all of it — to an S3 destination written with a role, partitioned by day.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_ingest_actions' },
      { id: 'sourcetype', label: 'Sourcetype', control: 'text', default: 'pan:traffic' },
      { id: 'ruleset', label: 'Ruleset name', control: 'text', default: 'pan_traffic_reduce' },
      { id: 'filter_regex', label: 'Drop events matching', control: 'text', default: ',allow,.*,53,.*,dns,', hint: 'Empty for no filter' },
      { id: 'mask_regex', label: 'Mask', control: 'text', default: '\\b(\\d{4})[ -]?\\d{4}[ -]?\\d{4}[ -]?(\\d{4})\\b', hint: 'Empty for no masking' },
      { id: 'mask_replace', label: 'Replace with', control: 'text', default: '\\1-XXXX-XXXX-\\2' },
      { id: 'route', label: 'Route to S3', control: 'toggle', default: true },
      { id: 'route_regex', label: 'Route events matching', control: 'text', default: '.', hint: '. for every event', showWhen: { input: 'route', equals: ['true'] } },
      { id: 'keep_copy', label: 'Keep a copy in Splunk too', control: 'toggle', default: true, showWhen: { input: 'route', equals: ['true'] } },
      { id: 'dest_name', label: 'Destination name', control: 'text', default: 's3_archive', showWhen: { input: 'route', equals: ['true'] } },
      { id: 's3_path', label: 'S3 path', control: 'text', default: 's3://acme-splunk-ia-archive/pan', showWhen: { input: 'route', equals: ['true'] } },
      { id: 'region', label: 'Region', control: 'text', default: 'eu-west-2', showWhen: { input: 'route', equals: ['true'] } },
      { id: 'partition', label: 'Partition by', control: 'select', default: 'day', options: [
        { value: 'day', label: 'Day — YYYY/MM/DD' },
        { value: 'month', label: 'Month — YYYY/MM' },
        { value: 'year', label: 'Year — YYYY' },
        { value: 'legacy', label: 'Legacy — latest event time per batch' },
      ], showWhen: { input: 'route', equals: ['true'] } },
      { id: 'out_format', label: 'Format', control: 'select', default: 'ndjson', options: [
        { value: 'ndjson', label: 'NDJSON — event plus metadata, re-ingestable' },
        { value: 'json', label: 'JSON' },
        { value: 'raw', label: 'Raw event text only' },
      ], showWhen: { input: 'route', equals: ['true'] } },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_ingest_actions'), 'org_ingest_actions');
      const sourcetype = str(values, 'sourcetype', 'pan:traffic').trim();
      const ruleset = splunkName(str(values, 'ruleset', 'ruleset'), 'ruleset');
      const filterRegex = str(values, 'filter_regex', '');
      const maskRegex = str(values, 'mask_regex', '');
      const maskReplace = str(values, 'mask_replace', 'XXXX');
      const route = bool(values, 'route', true);
      const routeRegex = str(values, 'route_regex', '.') || '.';
      const keepCopy = bool(values, 'keep_copy', true);
      const dest = splunkName(str(values, 'dest_name', 's3_archive'), 's3_archive');
      const s3Path = str(values, 's3_path', '').trim().replace(/\/+$/, '');
      const region = str(values, 'region', 'eu-west-2').trim();
      const partition = str(values, 'partition', 'day');
      const outFormat = str(values, 'out_format', 'ndjson');
      const findings            = [];

      // Eval string literals: backslashes and quotes escaped once more.
      const evalStr = (s        ) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
      const rules                                      = [];
      if (filterRegex) {
        const name = `_rule:${ruleset}:filter:regex:drop01`;
        rules.push({
          name,
          lines: [
            `[${name}]`,
            '# Drop: matching events go to the null queue — never indexed, never licensed.',
            `INGEST_EVAL = queue=if(match(_raw, ${evalStr(filterRegex)}), "nullQueue", queue)`,
            'STOP_PROCESSING_IF = queue == "nullQueue"',
          ],
        });
      }
      if (maskRegex) {
        const name = `_rule:${ruleset}:mask:regex:mask01`;
        rules.push({
          name,
          lines: [
            `[${name}]`,
            '# Mask: the replacement is what reaches disk. The original never does.',
            `INGEST_EVAL = _raw:=replace(_raw, ${evalStr(maskRegex)}, ${evalStr(maskReplace)})`,
          ],
        });
      }
      if (route) {
        const name = `_rule:${ruleset}:route:eval:route01`;
        const destination = keepCopy ? `rfs:${dest},_splunk_` : `rfs:${dest}`;
        const condition = routeRegex === '.' ? 'true()' : `match(_raw, ${evalStr(routeRegex)})`;
        rules.push({
          name,
          lines: [
            `[${name}]`,
            keepCopy
              ? '# Route a copy to S3 and keep indexing. VERIFY: "_splunk_" as the name of the local-indexing destination — build the same rule once in the Ingest Actions page and compare the generated stanza.'
              : '# Route to S3 only: matching events are NOT indexed in Splunk.',
            `INGEST_EVAL = 'pd:_destinationKey' = if((${condition}), "${destination}", 'pd:_destinationKey')`,
            `STOP_PROCESSING_IF = NOT isnull('pd:_destinationKey') AND 'pd:_destinationKey' != "" AND (isnull('pd:_doRouteClone') OR 'pd:_doRouteClone' == "")`,
          ],
        });
      }

      if (rules.length === 0) {
        findings.push(error('splunk.ia-empty-ruleset', 'The ruleset has no filter, no mask and no route, so it does nothing.', { source: 'ArchToolKit' }));
      }
      if (route && !keepCopy) {
        findings.push(
          warning('splunk.ia-route-without-copy', `Events matching the route go to S3 and are not indexed. Nothing in Splunk will find them — no search, no alert, no correlation — and bringing them back means re-ingesting from ${s3Path || 'S3'}.`, {
            remediation: 'If the intention is an archive copy, turn "Keep a copy in Splunk too" on. Route-only is right only for data you have decided never to search.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (route && routeRegex === '.' && !keepCopy) {
        findings.push(error('splunk.ia-route-everything', `Every ${sourcetype} event is routed away from Splunk. That is the whole sourcetype removed from the indexes.`, { source: 'ArchToolKit' }));
      }
      if (tooBroad(maskRegex)) {
        findings.push(
          warning('splunk.ia-mask-too-broad', `The mask "${maskRegex}" will match far more than the value it is meant to hide — masked data is permanently lost, and a broad mask can erase most of every event.`, {
            remediation: 'Anchor it with \\b or with the key that precedes the value, and test it against real samples in the Ingest Actions preview.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (tooBroad(filterRegex)) {
        findings.push(error('splunk.ia-filter-too-broad', `The drop filter "${filterRegex}" matches nearly every event. They would all be discarded before indexing, permanently.`, { source: 'ArchToolKit' }));
      }
      if (route && !/^s3:\/\/[^/]+/.test(s3Path)) {
        findings.push(error('splunk.ia-s3-path', `"${s3Path}" is not an s3://bucket/prefix path.`, { source: 'ArchToolKit' }));
      }
      findings.push(
        warning('splunk.ia-hand-written', 'Splunk documents rulesets as created through the Ingest Actions page or the /services/data/ingest/rulesets endpoint. These stanzas mirror what that page writes; the page will open them, but check a preview there before relying on them.', {
          source: 'docs.splunk.com — Use ingest actions to improve the data input process',
        }),
      );

      return {
        tier: TIER,
        title: `Ingest Actions ruleset ${ruleset} on ${sourcetype}`,
        app,
        activation: 'bundle',
        notes: [
          'Ingest Actions run where the data is parsed: on the indexers, or on a heavy forwarder when one parses first. Deploy the ruleset to that tier. VERIFY: RULESET- settings are documented as also applying on the indexers to data a heavy forwarder has already parsed, unlike TRANSFORMS-.',
          'A sourcetype can have only one RULESET. A second one for the same sourcetype replaces this, it does not add to it.',
          'Rules apply in the order listed in RULESET-: drop first so the rest does less work, then mask, then route — so what reaches S3 is masked too.',
          ...(maskRegex ? ['Masking happens before indexing and before routing. The unmasked value never reaches disk or S3 — and a wrong pattern loses data for good. Test in the Ingest Actions preview with real samples first.'] : []),
          ...(route
            ? [
                `The destination writes with the indexer’s own role: remote.s3.access_key and remote.s3.secret_key are left empty, as for SmartStore. The role needs s3:PutObject on ${s3Path || 'the bucket'} (and kms:GenerateDataKey if the bucket uses KMS).`,
                'At most eight S3 or file system destinations exist per instance, and one object must stay under AWS’s 5GB single-upload limit or it is lost — keep the default batch size.',
                `partitionBy = ${partition}${partition === 'legacy' ? '' : ', sourcetype'} lays objects out as <prefix>/<date>/... so Athena, or a later re-ingest, can read one day at a time.`,
                keepCopy ? 'A copy stays in Splunk, so licence use does not change — this is an archive, not a saving.' : 'Routed events are not indexed and not licensed.',
              ]
            : []),
        ],
        before: [
          `splunk cmd btool props list ${sourcetype} --debug | grep -E "RULESET|TRANSFORMS"   # a sourcetype has one RULESET`,
          `index=* sourcetype=${sourcetype} earliest=-1h | head 20`,
          ...(filterRegex ? [`index=* sourcetype=${sourcetype} earliest=-1h | regex _raw=${JSON.stringify(filterRegex)} | stats count   # what would be dropped`] : []),
          ...(maskRegex ? [`index=* sourcetype=${sourcetype} earliest=-1h | regex _raw=${JSON.stringify(maskRegex)} | head 20 | table _raw   # what would be masked`] : []),
          ...(route ? [`aws s3 ls ${s3Path}/ --region ${region}   # from an indexer, with its role`] : []),
          '| rest /services/data/ingest/rulesets | table title, *   # VERIFY endpoint on your version',
        ],
        files: {
          'default/props.conf': [
            `[${sourcetype}]`,
            '# One ruleset per sourcetype. Rules run in this order.',
            `RULESET-${ruleset} = ${rules.map((r) => r.name).join(', ')}`,
            `RULESET_DESC-${ruleset} = ${[filterRegex ? 'drop' : '', maskRegex ? 'mask' : '', route ? `route to ${dest}` : ''].filter(Boolean).join(', ')}`,
          ],
          'default/transforms.conf': rules.flatMap((r) => [...r.lines, '']),
          ...(route
            ? {
                'default/outputs.conf': [
                  '# An Ingest Actions S3 destination. Settings mirror SmartStore’s S3 ones.',
                  `[rfs:${dest}]`,
                  `path = ${s3Path}`,
                  `description = Ingest Actions archive for ${sourcetype}`,
                  `remote.s3.endpoint = https://s3.${region}.amazonaws.com`,
                  `remote.s3.auth_region = ${region}`,
                  'remote.s3.signature_version = v4',
                  'remote.s3.supports_versioning = true',
                  '# Empty keys: the instance or IRSA role is used, and nothing secret is here.',
                  'remote.s3.access_key =',
                  'remote.s3.secret_key =',
                  'remote.s3.encryption = sse-s3',
                  `partitionBy = ${partition === 'legacy' ? 'legacy' : `${partition}, sourcetype`}`,
                  `format = ${outFormat}`,
                  ...(outFormat === 'ndjson' ? ['# Keep index-time fields so a re-ingest can restore them.', 'format.ndjson.index_time_fields = true'] : []),
                  'compression = gzip',
                ],
              }
            : {}),
          'metadata/default.meta': defaultMeta(),
        },
        verify: [
          `splunk cmd btool props list ${sourcetype} --debug | grep RULESET`,
          `splunk cmd btool transforms list --debug | grep -A3 "_rule:${ruleset}"`,
          ...(route ? [`splunk cmd btool outputs list rfs:${dest} --debug`, `aws s3 ls ${s3Path}/ --recursive | tail -5`] : []),
          `index=* sourcetype=${sourcetype} earliest=-15m | stats count   # compare with the rate before`,
          ...(maskRegex ? [`index=* sourcetype=${sourcetype} earliest=-15m | regex _raw=${JSON.stringify(maskRegex)} | stats count   # should be 0 — masked values no longer match`] : []),
          'index=_internal sourcetype=splunkd (component=RfsOutputProcessor OR component=IngestActions* OR component=S3Client) log_level=ERROR earliest=-1h | stats count by component, message   # VERIFY component names',
        ],
        backout: [
          `rm -rf $SPLUNK_HOME/etc/manager-apps/${app}   # on the cluster manager, then: splunk apply cluster-bundle`,
          '# Events dropped or masked while the ruleset was in place stay dropped or masked.',
          ...(route ? [`# Objects already written to ${s3Path} stay there; delete them separately if unwanted.`] : []),
        ],
        findings,
      };
    },
  }),
];
