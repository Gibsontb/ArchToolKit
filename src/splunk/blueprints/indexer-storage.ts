/**
 * Splunk indexer storage beyond S3: SmartStore on Azure Blob and on Google
 * Cloud Storage, and data integrity control.
 *
 * The remote store is where every warm bucket lives once SmartStore is on, so
 * the three things that decide whether it is safe are the same on every cloud:
 * who the indexers authenticate as (and whether a secret ends up in the cluster
 * bundle), whether the objects are encrypted with a key the organisation
 * controls, and whether the indexers check the certificate of the endpoint they
 * upload to. Splunk defaults the last one to off. Here it is on, always.
 *
 * Data integrity control is the other storage question an auditor asks: can you
 * prove a bucket has not been changed since it was written? Splunk can, but
 * only for buckets written after the setting was on, and only if someone runs
 * the check.
 *
 * Every script applies when run; `--dry-run` previews. Nothing here writes a
 * secret: a client secret or account key is read from a mode-600 file by the
 * script that sets it, and is a placeholder everywhere else.
 */

import { num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, warning, type Finding } from '../../core/findings.ts';
import { splunkBlueprint, type SplunkBlueprint } from '../from-app.ts';
import { defaultMeta, listOf, splunkName, type SplunkApp } from '../splunk.ts';

const TIER = 'indexer' as const;
const SOURCE_SPEC = 'indexes.conf.spec (Splunk Enterprise 10.4)';

// --- script scaffolding ------------------------------------------------------

/**
 * A bash template that keeps bash's own `${...}` out of TypeScript's way.
 *
 * Written as String.raw, so regexes and backslashes arrive as typed; bash
 * parameter expansion is written `$\{VAR}` in the source and becomes `${VAR}`
 * here.
 */
function sh(strings: TemplateStringsArray, ...values: unknown[]): string[] {
  const text = String.raw({ raw: strings.raw }, ...values.map((v) => String(v))).replace(/\$\\\{/g, '${');
  const lines = text.replace(/^\n/, '').replace(/\n[ \t]*$/, '').split('\n');
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
  return lines.map((l) => l.slice(Number.isFinite(indent) ? indent : 0));
}

interface ScriptOption {
  readonly flag: string;
  readonly variable: string;
  /** Present for an option that takes a value; absent for a switch that sets the variable to 1. */
  readonly value?: string;
  readonly help: string;
}

function quoteSh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Usage, strict mode, a private umask, no root, and a `run` that acts when
 * run and only prints when `--dry-run` is given.
 */
function bashScript(name: string, purpose: readonly string[], options: readonly ScriptOption[], body: readonly string[], runsAs = 'the user splunkd runs as'): string[] {
  const usage = options.map((o) => (o.value === undefined ? `[${o.flag}]` : `[${o.flag} ${o.variable}]`)).join(' ');
  return [
    '#!/usr/bin/env bash',
    ...purpose.map((line) => `# ${line}`),
    '#',
    `# Usage: bash ${name} [--dry-run]${usage ? ` ${usage}` : ''}`,
    '#   --dry-run   Preview. The script prints what it would do and changes nothing.',
    ...options.map((o) => `#   ${(o.value === undefined ? o.flag : `${o.flag} ${o.variable}`).padEnd(11)} ${o.help}${o.value !== undefined && o.value !== '' ? ` (default: ${o.value})` : ''}`),
    '#',
    `# Run it as ${runsAs}, never as root.`,
    'set -euo pipefail',
    'umask 077',
    'EXECUTE=1',
    ...options.map((o) => `${o.variable}=${o.value === undefined ? '0' : quoteSh(o.value)}`),
    'while [[ $# -gt 0 ]]; do',
    '  case "$1" in',
    '    --dry-run) EXECUTE=0; shift ;;',
    ...options.map((o) => (o.value === undefined ? `    ${o.flag}) ${o.variable}=1; shift ;;` : `    ${o.flag}) ${o.variable}="\${2:?${o.flag} needs a value}"; shift 2 ;;`)),
    '    -h|--help) grep "^#" "$0" | head -40; exit 0 ;;',
    '    *) echo "Unknown option: $1" >&2; exit 2 ;;',
    '  esac',
    'done',
    'if [[ $EUID -eq 0 ]]; then echo "Refusing to run as root: run it as ' + runsAs + '." >&2; exit 1; fi',
    'SPLUNK_HOME="${SPLUNK_HOME:-/opt/splunk}"',
    'SPLUNK="$SPLUNK_HOME/bin/splunk"',
    'run() {',
    '  if [[ $EXECUTE -eq 1 ]]; then printf "+ %s\\n" "$*"; "$@"; else printf "[dry run] %s\\n" "$*"; fi',
    '}',
    '',
    ...body,
  ];
}

/**
 * Sets one key in one stanza of the app's local/indexes.conf on the cluster
 * manager, reading the value from a mode-600 file with shell builtins so it is
 * never on a command line, never echoed and never in version control.
 */
function setRemoteSecretScript(app: string, key: string): string[] {
  return bashScript(
    'bin/set-remote-secret.sh',
    [
      `Set ${key} in [volume:remote_store] of this app's local/indexes.conf on the`,
      'cluster manager, reading the value from a file (mode 600 or 400, the value on',
      'its first line). The value is never printed and never passed as an argument.',
      'Push the bundle afterwards: splunk apply cluster-bundle.',
    ],
    [
      { flag: '--secret-file', variable: 'SECRET_FILE', value: '', help: 'Mode-600 file holding the value' },
      { flag: '--conf', variable: 'CONF', value: `$SPLUNK_HOME/etc/manager-apps/${app}/local/indexes.conf`, help: 'indexes.conf to edit' },
    ],
    sh`
      KEY=${quoteSh(key)}
      STANZA='volume:remote_store'
      CONF="$\{CONF//\$SPLUNK_HOME/$SPLUNK_HOME}"
      [[ -n "$SECRET_FILE" ]] || { echo "--secret-file is required" >&2; exit 2; }
      [[ -r "$SECRET_FILE" ]] || { echo "Cannot read $SECRET_FILE" >&2; exit 1; }
      perm=$(stat -c %a "$SECRET_FILE")
      if [[ "$perm" != "600" && "$perm" != "400" ]]; then
        echo "$SECRET_FILE is mode $perm; make it 600 (chmod 600) before using it" >&2
        exit 1
      fi
      secret=""
      IFS= read -r secret < "$SECRET_FILE" || true
      [[ -n "$secret" ]] || { echo "$SECRET_FILE is empty" >&2; exit 1; }

      header_re='^\[(.*)\][[:space:]]*$'
      key_re=${quoteSh(`^[[:space:]]*${key.replace(/\./g, '\\.')}[[:space:]]*=`)}
      tmp=$(mktemp)
      trap 'rm -f "$tmp"' EXIT
      inside=0
      written=0
      if [[ -f "$CONF" ]]; then
        while IFS= read -r line || [[ -n "$line" ]]; do
          if [[ $line =~ $header_re ]]; then
            if [[ $inside -eq 1 && $written -eq 0 ]]; then printf '%s = %s\n' "$KEY" "$secret"; written=1; fi
            if [[ "$\{BASH_REMATCH[1]}" == "$STANZA" ]]; then inside=1; else inside=0; fi
          elif [[ $inside -eq 1 && $line =~ $key_re ]]; then
            if [[ $written -eq 0 ]]; then printf '%s = %s\n' "$KEY" "$secret"; written=1; fi
            continue
          fi
          printf '%s\n' "$line"
        done < "$CONF" > "$tmp"
      fi
      if [[ $inside -eq 1 && $written -eq 0 ]]; then printf '%s = %s\n' "$KEY" "$secret" >> "$tmp"; written=1; fi
      if [[ $written -eq 0 ]]; then printf '\n[%s]\n%s = %s\n' "$STANZA" "$KEY" "$secret" >> "$tmp"; fi
      unset secret

      if [[ $EXECUTE -eq 1 ]]; then
        mkdir -p "$(dirname "$CONF")"
        [[ -f "$CONF" ]] && cp -p "$CONF" "$CONF.bak.$(date +%Y%m%d%H%M%S)"
        cat "$tmp" > "$CONF"
        chmod 600 "$CONF"
        echo "$KEY set in [$STANZA] of $CONF. Now: $SPLUNK apply cluster-bundle"
      else
        echo "[dry run] would set $KEY in [$STANZA] of $CONF (value not shown)."
      fi
    `,
  );
}

// --- shared SmartStore sizing -------------------------------------------------

interface StoreIndex {
  readonly name: string;
  /** The prefix under the volume; `$_index_name` gives each index its own. */
  readonly prefix: string;
  readonly dailyGb: number;
  readonly retentionDays: number;
}

/** Rows of `index | remote prefix | GB/day | retention days`. */
function storeIndexes(value: string, fallbackRetention: number): StoreIndex[] {
  return String(value ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const [name = '', prefix = '', gb = '', days = ''] = line.split('|').map((p) => p.trim());
      return {
        name: splunkName(name, ''),
        prefix: prefix || '$_index_name',
        dailyGb: Number(gb) > 0 ? Number(gb) : 0,
        retentionDays: Number(days) > 0 ? Math.round(Number(days)) : fallbackRetention,
      };
    })
    .filter((i) => i.name);
}

const STORE_INPUTS = [
  { id: 'scope', label: 'Which indexes', control: 'select' as const, default: 'list', options: [
    { value: 'list', label: 'Only the indexes listed, each with its own remote prefix' },
    { value: 'all', label: 'Every index — set in [default]' },
  ] },
  { id: 'indexes', label: 'Indexes', control: 'textarea' as const, default: 'app_prod | $_index_name | 200 | 365\nnetfw | $_index_name | 250 | 180\nosnix | $_index_name | 50 | 90', hint: 'index | remote prefix | GB/day | retention days', showWhen: { input: 'scope', equals: ['list'] } },
  { id: 'daily_gb', label: 'Daily ingest across every index (GB)', control: 'number' as const, default: 500, min: 1, max: 1000000, showWhen: { input: 'scope', equals: ['all'] } },
  { id: 'retention_days', label: 'Retention (days)', control: 'number' as const, default: 365, min: 1, max: 3650, showWhen: { input: 'scope', equals: ['all'] } },
  { id: 'search_days', label: 'Most searches look back (days)', control: 'number' as const, default: 7, min: 1, max: 365, hint: 'The window the cache has to hold, or searches wait for the remote store' },
  { id: 'indexer_count', label: 'Indexers', control: 'number' as const, default: 6, min: 1, max: 1000 },
  { id: 'cache_gb', label: 'Cache disk per indexer (GB)', control: 'number' as const, default: 1500, min: 10, max: 1000000 },
];

interface StorePlan {
  readonly listed: boolean;
  readonly indexes: readonly StoreIndex[];
  readonly dailyGb: number;
  readonly searchDays: number;
  readonly indexers: number;
  readonly cacheGb: number;
  readonly retentionDays: number;
  readonly neededPerIndexerGb: number;
  readonly maxCacheMb: number;
  readonly remoteGb: number;
  readonly findings: Finding[];
}

/**
 * The part of a SmartStore plan that does not depend on the cloud: which
 * indexes, how big the cache must be, and the checks on both.
 */
function storePlan(values: BlueprintValues, store: string): StorePlan {
  const listed = str(values, 'scope', 'list') === 'list';
  const retentionAll = num(values, 'retention_days', 365);
  const indexes = listed ? storeIndexes(str(values, 'indexes', ''), retentionAll) : [];
  const dailyGb = listed ? indexes.reduce((s, i) => s + i.dailyGb, 0) : num(values, 'daily_gb', 500);
  const searchDays = num(values, 'search_days', 7);
  const indexers = Math.max(1, num(values, 'indexer_count', 6));
  const cacheGb = num(values, 'cache_gb', 1500);
  const findings: Finding[] = [];

  // On disk a bucket is about half the raw size (compressed raw plus tsidx).
  // The cache holds the search window's buckets across the indexers, plus 30%
  // for hot buckets and the next search.
  const onDiskPerDayGb = dailyGb * 0.5;
  const neededPerIndexerGb = Math.ceil(((onDiskPerDayGb * searchDays) / indexers) * 1.3);
  const maxCacheMb = Math.floor(cacheGb * 1024 * 0.85);
  const remoteGb = listed ? Math.ceil(indexes.reduce((s, i) => s + i.dailyGb * 0.5 * i.retentionDays, 0)) : Math.ceil(onDiskPerDayGb * retentionAll);

  if (listed && indexes.length === 0) {
    findings.push(error('splunk.smartstore-no-indexes', 'Only listed indexes were chosen, and none were listed.'));
  }
  const prefixes = new Map<string, string>();
  for (const index of indexes) {
    if (!/^[A-Za-z0-9_$./-]+$/.test(index.prefix) || index.prefix.startsWith('/') || index.prefix.includes('..')) {
      findings.push(error('splunk.smartstore-prefix', `The remote prefix "${index.prefix}" for ${index.name} is not a relative path under the volume. remotePath would not resolve and the index would not start.`, { source: SOURCE_SPEC }));
    }
    // $_index_name expands to the index's own name, so compare what it becomes.
    const resolved = index.prefix.replace(/\$_index_name/g, index.name);
    const other = prefixes.get(resolved);
    if (other) {
      findings.push(error('splunk.smartstore-shared-prefix', `${other} and ${index.name} both upload to ${store}/${resolved}. Two indexes in one remote prefix overwrite each other's bucket metadata, and both become unsearchable.`, { remediation: 'Give every index its own prefix; $_index_name does that.', source: SOURCE_SPEC }));
    } else {
      prefixes.set(resolved, index.name);
    }
    if (index.dailyGb === 0) {
      findings.push(warning('splunk.smartstore-no-volume', `${index.name} has no GB/day, so it adds nothing to the cache sizing and gets no maxGlobalDataSizeMB — age alone will freeze it.`));
    }
  }
  if (cacheGb < neededPerIndexerGb * 0.5) {
    findings.push(
      error('splunk.smartstore-cache-too-small', `Each indexer's cache is ${cacheGb}GB, but ${searchDays} days of searching at ${dailyGb}GB/day needs about ${neededPerIndexerGb}GB per indexer. Most searches will download buckets first, and the cache will evict what the next search needs.`, {
        remediation: `Size the cache for at least ${neededPerIndexerGb}GB per indexer, or add indexers.`,
      }),
    );
  } else if (cacheGb < neededPerIndexerGb) {
    findings.push(warning('splunk.smartstore-cache-tight', `The cache (${cacheGb}GB per indexer) is below the ${neededPerIndexerGb}GB that ${searchDays} days of searching needs. Searches at the edge of the window will fetch from the remote store.`));
  }

  return { listed, indexes, dailyGb, searchDays, indexers, cacheGb, retentionDays: retentionAll, neededPerIndexerGb, maxCacheMb, remoteGb, findings };
}

/** The index stanzas: each listed index on the volume, or every index through [default]. */
function indexStanzas(plan: StorePlan): string[] {
  const retention = (days: number, gbPerDay: number) => [
    `# Retention: ${days} days, after which the bucket is removed from the remote`,
    '# store (frozen). In SmartStore the size limit is global — across the whole',
    '# cluster and the remote store — not per indexer.',
    `frozenTimePeriodInSecs = ${days * 86400}`,
    ...(gbPerDay > 0 ? [`maxGlobalDataSizeMB = ${Math.ceil(gbPerDay * 0.5 * days * 1024 * 1.1)}`] : []),
  ];
  if (!plan.listed) {
    return [
      '# Every index — including ones created later — uses SmartStore.',
      '[default]',
      'remotePath = volume:remote_store/$_index_name',
      'repFactor = auto',
      'maxDataSize = auto',
      ...retention(plan.retentionDays, 0),
      '',
    ];
  }
  return plan.indexes.flatMap((index) => [
    `[${index.name}]`,
    `homePath = $SPLUNK_DB/${index.name}/db`,
    `coldPath = $SPLUNK_DB/${index.name}/colddb`,
    '# thawedPath cannot be on a volume, and is never remote.',
    `thawedPath = $SPLUNK_DB/${index.name}/thaweddb`,
    `remotePath = volume:remote_store/${index.prefix}`,
    'repFactor = auto',
    'maxDataSize = auto',
    ...retention(index.retentionDays, index.dailyGb),
    '',
  ]);
}

function cacheManager(plan: StorePlan): string[] {
  return [
    '# The cache manager decides what stays on local disk. VERIFY that your',
    '# version distributes server.conf [cachemanager] through the cluster',
    '# bundle; if not, set it in $SPLUNK_HOME/etc/system/local on each peer.',
    '[cachemanager]',
    `# 85% of the ${plan.cacheGb}GB cache disk, in MB. Beyond this the least recently`,
    '# used buckets are evicted, and a search that needs them waits for a download.',
    `max_cache_size = ${plan.maxCacheMb}`,
    'eviction_policy = lru',
    '# Buckets newer than this are not evicted while anything older can be.',
    'hotlist_recency_secs = 86400',
    '# Bloom filters and small metadata files are kept longer: they are tiny',
    '# and let a search skip a bucket without downloading it.',
    'hotlist_bloom_filter_recency_hours = 360',
    '# Free space the cache manager keeps in reserve, in MB.',
    'eviction_padding = 5120',
  ];
}

function sizingNote(plan: StorePlan, store: string): string[] {
  return [
    `Cache sizing: ${plan.dailyGb}GB/day raw is about ${(plan.dailyGb * 0.5).toFixed(0)}GB/day on disk. ${plan.searchDays} days of that across ${plan.indexers} indexers, with 30% headroom, is about ${plan.neededPerIndexerGb}GB per indexer. The cache disk here is ${plan.cacheGb}GB; max_cache_size is 85% of it (${plan.maxCacheMb}MB) so the partition never fills.`,
    `Remote store: about ${plan.remoteGb}GB in ${store} at the retention given — one copy, because the object store is the durability. The cluster replication factor still applies to hot buckets only.`,
  ];
}

const SMARTSTORE_ONE_WAY = 'Migration is one way. Existing warm and cold buckets upload on the first restart after the bundle is applied, and an index on SmartStore cannot be converted back to local storage. Start with one non-critical index in the list.';

const TLS_VERSIONS = [
  { value: 'tls1.2', label: 'TLS 1.2' },
  { value: 'tls1.2,tls1.3', label: 'TLS 1.2 and 1.3 (1.3 needs 10.4)' },
];

// --- 1. SmartStore on Azure Blob -----------------------------------------------

function smartstoreAzure(): SplunkBlueprint {
  return splunkBlueprint({
    id: 'splunk_smartstore_azure',
    tier: TIER,
    label: 'SmartStore on Azure Blob',
    group: 'Storage',
    description: 'Warm buckets in an Azure Blob container with the indexers as a cache: a service principal or account key whose secret is set from a file and never written into the app, server-side encryption with Microsoft or Key Vault keys, certificate and host name verification on, a remote prefix per index, and the cache sized from ingest and search window.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_smartstore_azure' },
      { id: 'remote_path', label: 'Remote path', control: 'text', default: 'azure://splunk-smartstore/prod-cluster', hint: 'azure://container/prefix — one prefix per cluster, never shared' },
      { id: 'endpoint', label: 'Blob endpoint', control: 'text', default: 'https://acmesplunkprod.blob.core.windows.net', hint: 'https://<storage account>.blob.core.windows.net' },
      { id: 'auth', label: 'Authenticate with', control: 'select', default: 'sp', options: [
        { value: 'sp', label: 'A service principal (tenant, client id, client secret)' },
        { value: 'key', label: 'The storage account access key' },
      ] },
      { id: 'tenant_id', label: 'Tenant id', control: 'text', default: '00000000-0000-0000-0000-000000000000', showWhen: { input: 'auth', equals: ['sp'] } },
      { id: 'client_id', label: 'Client (application) id', control: 'text', default: '11111111-1111-1111-1111-111111111111', showWhen: { input: 'auth', equals: ['sp'] } },
      { id: 'encryption', label: 'Encryption', control: 'select', default: 'azure-sse-ms', options: [
        { value: 'azure-sse-ms', label: 'azure-sse-ms — Microsoft managed keys' },
        { value: 'azure-sse-kv', label: 'azure-sse-kv — customer managed keys in Key Vault' },
        { value: 'azure-sse-c', label: 'azure-sse-c — customer provided keys' },
      ] },
      { id: 'tls_versions', label: 'TLS versions', control: 'select', default: 'tls1.2', options: TLS_VERSIONS },
      { id: 'ca_path', label: 'CA bundle for the endpoint', control: 'text', default: '', placeholder: '$SPLUNK_HOME/etc/auth/cacert.pem', hint: 'Empty: the Splunk default CA list' },
      ...STORE_INPUTS,
    ],
    app: (values: BlueprintValues): SplunkApp => {
      const app = splunkName(str(values, 'app_name', 'org_smartstore_azure'), 'org_smartstore_azure');
      const remotePath = str(values, 'remote_path', '').replace(/\/+$/, '');
      const endpoint = str(values, 'endpoint', '').replace(/\/+$/, '');
      const sp = str(values, 'auth', 'sp') === 'sp';
      const tenant = str(values, 'tenant_id', '');
      const client = str(values, 'client_id', '');
      const encryption = str(values, 'encryption', 'azure-sse-ms');
      const tls = str(values, 'tls_versions', 'tls1.2');
      const caPath = str(values, 'ca_path', '');
      const plan = storePlan(values, remotePath || 'azure://');
      const findings: Finding[] = [...plan.findings];

      const pathMatch = /^azure:\/\/([a-z0-9](?:[a-z0-9]|-(?!-)){1,61}[a-z0-9])(\/.*)?$/.exec(remotePath);
      const container = pathMatch?.[1] ?? '<container>';
      const account = /^https:\/\/([a-z0-9]{3,24})\.blob\./.exec(endpoint)?.[1] ?? '<storage account>';
      const secretKey = sp ? 'remote.azure.client_secret' : 'remote.azure.secret_key';

      if (!pathMatch) {
        findings.push(error('splunk.smartstore-azure-path', `"${remotePath}" is not an azure://container/prefix path with a valid container name (3–63 lower-case letters, digits and single hyphens). The volume will not initialise and every index on it will fail to start.`, { source: SOURCE_SPEC }));
      }
      if (!/^https:\/\//.test(endpoint)) {
        findings.push(error('splunk.smartstore-azure-endpoint', `The endpoint "${endpoint}" is not https. Buckets would travel in clear and the certificate checks below would have nothing to check.`, { remediation: 'Use https://<storage account>.blob.core.windows.net, or the private endpoint name.' }));
      }
      const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (sp && (!guid.test(tenant) || !guid.test(client))) {
        findings.push(error('splunk.smartstore-azure-sp', 'A service principal needs its tenant id and client id, both GUIDs. Without them every upload is refused and the indexers stop rolling buckets to warm.'));
      }
      if (!sp) {
        findings.push(
          warning('splunk.smartstore-azure-account-key', 'The storage account key grants full control of every container in the account, never expires on its own, and travels to every peer in the cluster bundle.', {
            remediation: 'Use a service principal with Storage Blob Data Contributor on this container only (ops/azure-blob-access.sh assigns it).',
          }),
        );
      }

      const encryptionLines =
        encryption === 'azure-sse-ms'
          ? ['# Server-side encryption with Microsoft managed keys.', 'remote.azure.encryption = azure-sse-ms']
          : encryption === 'azure-sse-kv'
            ? ['# Server-side encryption with a customer managed key in Key Vault. The key', '# settings are named in the VERIFY note in DEPLOY.md.', 'remote.azure.encryption = azure-sse-kv']
            : ['# Server-side encryption with a key Splunk provides on every request. The key', '# settings are named in the VERIFY note in DEPLOY.md.', 'remote.azure.encryption = azure-sse-c'];

      return {
        tier: TIER,
        title: `SmartStore on ${remotePath || 'Azure Blob'}: ${plan.listed ? `${plan.indexes.length} indexes` : 'every index'}`,
        app,
        activation: 'bundle',
        notes: [
          ...sizingNote(plan, 'Azure Blob'),
          `The ${sp ? 'client secret' : 'account key'} is not in this app. On the cluster manager run bin/set-remote-secret.sh --secret-file <mode-600 file>: it writes ${secretKey} into local/indexes.conf of this app under manager-apps, and the bundle push carries it to the peers. Keep local/ out of version control.`,
          'VERIFY: whether splunkd encrypts remote.azure secrets in place on restart in your version. If it does not, the value stays readable to anyone who can read the peers’ etc/peer-apps.',
          ...(sp ? [`VERIFY: the role assignment. ops/azure-blob-access.sh assigns Storage Blob Data Contributor to the client id on the container; confirm against the SmartStore on Azure documentation for your version that nothing account-wide is needed.`] : []),
          ...(encryption !== 'azure-sse-ms' ? [`VERIFY: ${encryption} needs the key (Key Vault key or encryption scope for azure-sse-kv, the customer key for azure-sse-c) named with the remote.azure.${encryption}.* settings that indexes.conf.spec lists for your version. They are not written here; add them to local/indexes.conf with bin/set-remote-secret.sh or by hand before the bundle push.`] : []),
          'VERIFY: the container is taken from the path. remote.azure.container_name is not set here.',
          'SmartStore settings must be identical on every peer. Deploy them only through the cluster manager bundle, never by hand on one indexer.',
          SMARTSTORE_ONE_WAY,
        ],
        before: [
          `az storage container show --name ${container} --account-name ${account} --auth-mode login   # the container exists`,
          `curl -sS -o /dev/null -w '%{http_code} %{ssl_verify_result}\\n' ${endpoint}/   # from an indexer: TLS verifies (0) and the endpoint answers`,
          'splunk cmd btool indexes list volume:remote_store --debug',
          '| rest /services/data/indexes splunk_server=* | table splunk_server, title, currentDBSizeMB, remotePath',
          '| rest /services/server/status/partitions-space splunk_server=* | table splunk_server, mount_point, available, capacity',
        ],
        files: {
          'default/indexes.conf': [
            '# Every warm bucket for the indexes below is uploaded here. The prefix',
            '# belongs to this cluster alone: two clusters writing to one prefix',
            '# corrupt each other.',
            '[volume:remote_store]',
            'storageType = remote',
            `path = ${remotePath}`,
            `remote.azure.endpoint = ${endpoint}`,
            '',
            ...(sp
              ? [
                  '# Service principal. The secret is set by bin/set-remote-secret.sh into',
                  '# local/indexes.conf on the cluster manager, never here.',
                  `remote.azure.tenant_id = ${tenant}`,
                  `remote.azure.client_id = ${client}`,
                  'remote.azure.client_secret = <set in local/ by bin/set-remote-secret.sh>',
                ]
              : [
                  '# Storage account key. The key is set by bin/set-remote-secret.sh into',
                  '# local/indexes.conf on the cluster manager, never here.',
                  `remote.azure.access_key = ${account}`,
                  'remote.azure.secret_key = <set in local/ by bin/set-remote-secret.sh>',
                ]),
            '',
            ...encryptionLines,
            '',
            '# Check the endpoint certificate and that it names this host. Splunk',
            '# defaults both to false.',
            'remote.azure.sslVerifyServerCert = true',
            'remote.azure.sslVerifyServerName = true',
            `remote.azure.sslVersions = ${tls}`,
            ...(caPath ? [`remote.azure.sslRootCAPath = ${caPath}`] : []),
            '',
            ...indexStanzas(plan),
          ],
          'default/server.conf': cacheManager(plan),
          'bin/set-remote-secret.sh': setRemoteSecretScript(app, secretKey),
          ...(sp
            ? {
                'ops/azure-blob-access.sh': bashScript(
                  'ops/azure-blob-access.sh',
                  [
                    'Create the container if it is missing and give the service principal',
                    'Storage Blob Data Contributor on that container only. Run it where the',
                    'Azure CLI is signed in (az login) as someone who can assign roles.',
                  ],
                  [
                    { flag: '--account-id', variable: 'ACCOUNT_ID', value: '', help: 'Resource id of the storage account (az storage account show --query id)' },
                  ],
                  sh`
                    [[ -n "$ACCOUNT_ID" ]] || { echo "--account-id is required" >&2; exit 2; }
                    run az storage container create --name ${quoteSh(container)} --account-name ${quoteSh(account)} --auth-mode login
                    run az role assignment create --assignee ${quoteSh(client)} --role "Storage Blob Data Contributor" --scope "$ACCOUNT_ID/blobServices/default/containers/${container}"
                  `,
                  'an administrator with the Azure CLI signed in',
                ),
              }
            : {}),
          'metadata/default.meta': defaultMeta(),
        },
        verify: [
          'splunk cmd btool indexes list volume:remote_store --debug',
          'splunk cmd btool server list cachemanager --debug',
          `splunk cmd splunkd rfs -- ls --starts-with volume:remote_store/${plan.indexes[0]?.prefix.replace(/\$_index_name/g, plan.indexes[0]?.name ?? '') ?? '<index>'}`,
          'index=_internal sourcetype=splunkd component=CacheManager* log_level=ERROR earliest=-1h | stats count by splunk_server, message',
          'index=_internal source=*metrics.log group=cachemgr_download earliest=-24h | timechart sum(kb) as kb_downloaded   # sustained downloads mean the cache is too small',
          'index=_internal sourcetype=splunkd log_level=ERROR (Azure* OR AzureBlob* OR RemoteStorage*) earliest=-1h | stats count by component, message   # VERIFY the component name',
        ],
        backout: [
          '# Before any bucket has uploaded: remove remotePath from the stanzas and push the bundle.',
          '# After buckets have uploaded there is no backout to local storage. Leave the',
          '# volume in place; removing it orphans every warm bucket and those indexes',
          '# stop being searchable.',
          `az storage blob list --container-name ${container} --account-name ${account} --auth-mode login --num-results 20 -o table   # what is already remote`,
        ],
        findings,
      };
    },
  });
}

// --- 2. SmartStore on Google Cloud Storage ------------------------------------------

function smartstoreGcs(): SplunkBlueprint {
  return splunkBlueprint({
    id: 'splunk_smartstore_gcs',
    tier: TIER,
    label: 'SmartStore on Google Cloud Storage',
    group: 'Storage',
    description: 'Warm buckets in a Cloud Storage bucket with the indexers as a cache: the VM’s own service account, a named one, or a key file under etc/auth; Google, Cloud KMS or customer supplied encryption; certificate and host name verification on; a remote prefix per index; and the cache sized from ingest and search window.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_smartstore_gcs' },
      { id: 'remote_path', label: 'Remote path', control: 'text', default: 'gs://acme-splunk-smartstore-prod/indexes', hint: 'gs://bucket/prefix — one prefix per cluster, never shared' },
      { id: 'project_id', label: 'Project id', control: 'text', default: 'acme-logging-prod' },
      { id: 'auth', label: 'Authenticate with', control: 'select', default: 'vm', options: [
        { value: 'vm', label: 'The VM’s default service account — no key on disk' },
        { value: 'email', label: 'A named service account the VM can act as' },
        { value: 'file', label: 'A service account key file in etc/auth' },
      ] },
      { id: 'service_account_email', label: 'Service account', control: 'text', default: 'splunk-smartstore@acme-logging-prod.iam.gserviceaccount.com', showWhen: { input: 'auth', equals: ['email'] } },
      { id: 'credential_file', label: 'Key file name', control: 'text', default: 'gcs-smartstore.json', hint: 'A file name in $SPLUNK_HOME/etc/auth', showWhen: { input: 'auth', equals: ['file'] } },
      { id: 'encryption', label: 'Encryption', control: 'select', default: 'gcp-sse-kms', options: [
        { value: 'gcp-sse-gcp', label: 'gcp-sse-gcp — Google managed keys' },
        { value: 'gcp-sse-kms', label: 'gcp-sse-kms — a Cloud KMS key you manage' },
        { value: 'gcp-sse-c', label: 'gcp-sse-c — customer supplied keys' },
      ] },
      { id: 'kms_location', label: 'KMS location', control: 'combo', default: 'europe-west2', showWhen: { input: 'encryption', equals: ['gcp-sse-kms'] }, options: [
        'global', 'us', 'europe', 'asia', 'us-central1', 'us-east1', 'us-east4', 'us-west1', 'europe-west1', 'europe-west2', 'europe-west3', 'europe-west4', 'europe-north1', 'asia-southeast1', 'asia-northeast1', 'australia-southeast1',
      ].map((value) => ({ value, label: value })) },
      { id: 'kms_key_ring', label: 'KMS key ring', control: 'text', default: 'splunk', showWhen: { input: 'encryption', equals: ['gcp-sse-kms'] } },
      { id: 'kms_key', label: 'KMS key', control: 'text', default: 'smartstore', showWhen: { input: 'encryption', equals: ['gcp-sse-kms'] } },
      { id: 'tls_versions', label: 'TLS versions', control: 'select', default: 'tls1.2', options: TLS_VERSIONS },
      { id: 'ca_path', label: 'CA bundle for the endpoint', control: 'text', default: '', placeholder: '$SPLUNK_HOME/etc/auth/cacert.pem', hint: 'Empty: the Splunk default CA list' },
      ...STORE_INPUTS,
    ],
    app: (values: BlueprintValues): SplunkApp => {
      const app = splunkName(str(values, 'app_name', 'org_smartstore_gcs'), 'org_smartstore_gcs');
      const remotePath = str(values, 'remote_path', '').replace(/\/+$/, '');
      const project = str(values, 'project_id', '');
      const auth = str(values, 'auth', 'vm');
      const email = str(values, 'service_account_email', '');
      const keyFile = str(values, 'credential_file', '');
      const encryption = str(values, 'encryption', 'gcp-sse-kms');
      const kmsLocation = str(values, 'kms_location', '');
      const kmsRing = str(values, 'kms_key_ring', '');
      const kmsKey = str(values, 'kms_key', '');
      const tls = str(values, 'tls_versions', 'tls1.2');
      const caPath = str(values, 'ca_path', '');
      const plan = storePlan(values, remotePath || 'gs://');
      const findings: Finding[] = [...plan.findings];

      const pathMatch = /^gs:\/\/([a-z0-9][a-z0-9._-]{1,61}[a-z0-9])(\/.*)?$/.exec(remotePath);
      const bucket = pathMatch?.[1] ?? '<bucket>';

      if (!pathMatch) {
        findings.push(error('splunk.smartstore-gcs-path', `"${remotePath}" is not a gs://bucket/prefix path with a valid bucket name. The volume will not initialise and every index on it will fail to start.`, { source: SOURCE_SPEC }));
      }
      if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) {
        findings.push(error('splunk.smartstore-gcs-project', `"${project}" is not a Google Cloud project id (6–30 lower-case letters, digits and hyphens, starting with a letter).`));
      }
      if (auth === 'email' && !/^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/.test(email)) {
        findings.push(error('splunk.smartstore-gcs-sa', `"${email}" is not a service account address (name@project.iam.gserviceaccount.com).`));
      }
      if (auth === 'file') {
        if (!keyFile || /[\\/]/.test(keyFile)) {
          findings.push(error('splunk.smartstore-gcs-key-path', `remote.gs.credential_file is a file name in $SPLUNK_HOME/etc/auth, not a path; "${keyFile}" would not be found.`, { source: SOURCE_SPEC }));
        }
        findings.push(
          warning('splunk.smartstore-gcs-key-file', 'A service account key file never expires on its own and has to be copied to every indexer. Anyone who can read etc/auth on one peer can read and delete the whole remote store.', {
            remediation: 'Run the indexers as the VM’s service account, or name one the VM can act as, and delete the key.',
          }),
        );
      }
      if (encryption === 'gcp-sse-kms' && (!kmsLocation || !kmsRing || !kmsKey)) {
        findings.push(error('splunk.smartstore-gcs-kms', 'Cloud KMS encryption needs the key’s location, key ring and key. Without them every upload fails.'));
      }

      const credentialLines =
        auth === 'vm'
          ? ['# No credential. Splunk uses the VM’s default service account, whose tokens', '# rotate on their own and never appear in the bundle.']
          : auth === 'email'
            ? ['# The VM acts as this service account; no key is on disk.', `remote.gs.service_account_email = ${email}`]
            : ['# A key file in $SPLUNK_HOME/etc/auth on every peer. It is not in this app:', '# copy it there (mode 600, owned by the splunk user) before the bundle push.', `remote.gs.credential_file = ${keyFile}`];

      const encryptionLines =
        encryption === 'gcp-sse-kms'
          ? [
              '# Encryption with a Cloud KMS key. The service account needs',
              '# roles/cloudkms.cryptoKeyEncrypterDecrypter on it (ops/gcs-access.sh).',
              'remote.gs.encryption = gcp-sse-kms',
              `remote.gs.gcp_kms.locations = ${kmsLocation}`,
              `remote.gs.gcp_kms.key_ring = ${kmsRing}`,
              `remote.gs.gcp_kms.key = ${kmsKey}`,
            ]
          : encryption === 'gcp-sse-c'
            ? [
                '# Encryption with customer supplied keys. The key type setting is named in',
                '# the VERIFY note in DEPLOY.md and must be added before the bundle push.',
                'remote.gs.encryption = gcp-sse-c',
              ]
            : ['# Encryption with Google managed keys.', 'remote.gs.encryption = gcp-sse-gcp'];

      const member = auth === 'email' ? `serviceAccount:${email}` : '';

      return {
        tier: TIER,
        title: `SmartStore on ${remotePath || 'Google Cloud Storage'}: ${plan.listed ? `${plan.indexes.length} indexes` : 'every index'}`,
        app,
        activation: 'bundle',
        notes: [
          ...sizingNote(plan, 'Cloud Storage'),
          ...(auth === 'vm' ? ['Every indexer VM must run as the same service account, and that account needs roles/storage.objectAdmin on the bucket (ops/gcs-access.sh --member serviceAccount:<email>).'] : []),
          ...(encryption === 'gcp-sse-c' ? ['VERIFY: gcp-sse-c needs remote.gs.encryption.gcp-sse-c.key_type and the key settings indexes.conf.spec lists with it for your version. They are not written here; add them in local/indexes.conf on the cluster manager, never in version control.'] : []),
          ...(encryption === 'gcp-sse-kms' ? ['VERIFY: whether the Cloud Storage service agent (service-<project number>@gs-project-accounts.iam.gserviceaccount.com) also needs roles/cloudkms.cryptoKeyEncrypterDecrypter on the key in your setup. ops/gcs-access.sh grants it to the Splunk service account only.'] : []),
          'SmartStore settings must be identical on every peer. Deploy them only through the cluster manager bundle, never by hand on one indexer.',
          SMARTSTORE_ONE_WAY,
        ],
        before: [
          `gcloud storage buckets describe gs://${bucket} --project ${project}   # the bucket exists, and its location matches the KMS key`,
          'curl -sS -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email   # on an indexer: the account Splunk will use',
          `gcloud storage ls ${remotePath}/   # from an indexer: reachability and permission`,
          'splunk cmd btool indexes list volume:remote_store --debug',
          '| rest /services/data/indexes splunk_server=* | table splunk_server, title, currentDBSizeMB, remotePath',
        ],
        files: {
          'default/indexes.conf': [
            '# Every warm bucket for the indexes below is uploaded here. The prefix',
            '# belongs to this cluster alone: two clusters writing to one prefix',
            '# corrupt each other.',
            '[volume:remote_store]',
            'storageType = remote',
            `path = ${remotePath}`,
            `remote.gs.project_id = ${project}`,
            '',
            ...credentialLines,
            '',
            ...encryptionLines,
            '',
            '# Check the endpoint certificate and that it names this host. Splunk',
            '# defaults both to false.',
            'remote.gs.sslVerifyServerCert = true',
            'remote.gs.sslVerifyServerName = true',
            `remote.gs.sslVersionsForClient = ${tls}`,
            ...(caPath ? [`remote.gs.sslRootCAPath = ${caPath}`] : []),
            '',
            ...indexStanzas(plan),
          ],
          'default/server.conf': cacheManager(plan),
          'ops/gcs-access.sh': bashScript(
            'ops/gcs-access.sh',
            [
              encryption === 'gcp-sse-kms' ? 'Give the Splunk service account object access on the bucket and' : 'Give the Splunk service account object access on the bucket.',
              ...(encryption === 'gcp-sse-kms' ? ['encrypt/decrypt on the Cloud KMS key.'] : []),
              'Run it where gcloud is signed in as someone who can set IAM policy.',
            ],
            [{ flag: '--member', variable: 'MEMBER', value: member, help: 'serviceAccount:<email> Splunk runs as' }],
            sh`
              [[ "$MEMBER" == serviceAccount:* ]] || { echo "--member must be serviceAccount:<email>" >&2; exit 2; }
              run gcloud storage buckets add-iam-policy-binding gs://${bucket} --member="$MEMBER" --role=roles/storage.objectAdmin
              ${encryption === 'gcp-sse-kms' ? `run gcloud kms keys add-iam-policy-binding ${quoteSh(kmsKey)} --keyring=${quoteSh(kmsRing)} --location=${quoteSh(kmsLocation)} --project=${quoteSh(project)} --member="$MEMBER" --role=roles/cloudkms.cryptoKeyEncrypterDecrypter` : ''}
            `,
            'an administrator with gcloud signed in',
          ),
          'metadata/default.meta': defaultMeta(),
        },
        verify: [
          'splunk cmd btool indexes list volume:remote_store --debug',
          'splunk cmd btool server list cachemanager --debug',
          `splunk cmd splunkd rfs -- ls --starts-with volume:remote_store/${plan.indexes[0]?.prefix.replace(/\$_index_name/g, plan.indexes[0]?.name ?? '') ?? '<index>'}`,
          'index=_internal sourcetype=splunkd component=CacheManager* log_level=ERROR earliest=-1h | stats count by splunk_server, message',
          'index=_internal source=*metrics.log group=cachemgr_download earliest=-24h | timechart sum(kb) as kb_downloaded   # sustained downloads mean the cache is too small',
          `gcloud storage ls --recursive ${remotePath}/ | head -20   # buckets are arriving`,
        ],
        backout: [
          '# Before any bucket has uploaded: remove remotePath from the stanzas and push the bundle.',
          '# After buckets have uploaded there is no backout to local storage. Leave the',
          '# volume in place; removing it orphans every warm bucket and those indexes',
          '# stop being searchable.',
          `gcloud storage du --summarize ${remotePath}/   # what is already remote`,
        ],
        findings,
      };
    },
  });
}

// --- 3. Data integrity control ------------------------------------------------------

function dataIntegrity(): SplunkBlueprint {
  return splunkBlueprint({
    id: 'splunk_data_integrity',
    tier: TIER,
    label: 'Data integrity control',
    group: 'Storage',
    description: 'Hashes every slice of raw data as it is indexed, for the indexes that need to prove they were not altered, and a script that runs splunk check-integrity across them on each indexer and exits non-zero on any failure — ready for cron and for an auditor.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_data_integrity' },
      { id: 'scope', label: 'Which indexes', control: 'select', default: 'list', options: [
        { value: 'list', label: 'Only the indexes listed' },
        { value: 'all', label: 'Every index — set in [default]' },
      ] },
      { id: 'indexes', label: 'Indexes', control: 'text', default: 'wineventlog, linux_secure, netfw, _audit', hint: 'Comma separated', showWhen: { input: 'scope', equals: ['list'] } },
      { id: 'check_indexes', label: 'Indexes the check script covers', control: 'text', default: 'wineventlog, linux_secure, netfw, _audit', hint: 'Comma separated', showWhen: { input: 'scope', equals: ['all'] } },
      { id: 'schedule', label: 'Run the check', control: 'select', default: 'weekly', options: [
        { value: 'daily', label: 'Daily, from cron' },
        { value: 'weekly', label: 'Weekly, from cron' },
        { value: 'manual', label: 'By hand only' },
      ] },
      { id: 'log_dir', label: 'Results directory', control: 'text', default: '$SPLUNK_HOME/var/log/splunk', hint: 'Where each run writes its report; under var/log/splunk it is indexed into _internal' },
    ],
    app: (values: BlueprintValues): SplunkApp => {
      const app = splunkName(str(values, 'app_name', 'org_data_integrity'), 'org_data_integrity');
      const all = str(values, 'scope', 'list') === 'all';
      const clean = (v: string) => listOf(v).map((i) => i.trim().toLowerCase()).filter((i) => /^[a-z0-9_][a-z0-9_-]*$/.test(i));
      const raw = listOf(str(values, all ? 'check_indexes' : 'indexes', ''));
      const indexes = clean(str(values, all ? 'check_indexes' : 'indexes', ''));
      const schedule = str(values, 'schedule', 'weekly');
      const logDir = str(values, 'log_dir', '$SPLUNK_HOME/var/log/splunk').replace(/\/+$/, '');
      const findings: Finding[] = [];

      if (!all && indexes.length === 0) {
        findings.push(error('splunk.integrity-no-indexes', 'No index is listed, so nothing would be hashed and the check would have nothing to check.'));
      }
      const rejected = raw.filter((i) => !indexes.includes(i.trim().toLowerCase()));
      if (rejected.length > 0) {
        findings.push(error('splunk.integrity-index-name', `${rejected.join(', ')} ${rejected.length === 1 ? 'is not an index name' : 'are not index names'} Splunk accepts (lower-case letters, digits, underscores and hyphens).`));
      }
      if (all && indexes.length === 0) {
        findings.push(warning('splunk.integrity-nothing-checked', 'Every index is hashed, but the check script lists no index to verify. Hashes nobody checks prove nothing.'));
      }

      const cron = schedule === 'daily' ? '17 3 * * *' : '17 3 * * 0';

      return {
        tier: TIER,
        title: `Data integrity control: ${all ? 'every index' : indexes.join(', ')}`,
        app,
        activation: 'bundle',
        notes: [
          'Only buckets written after this is applied carry hashes. Buckets already on disk are not covered and check-integrity reports them as having no hash files.',
          'VERIFY: splunk generate-hash-files -index <name> can add hashes to existing buckets in your version. Those hashes prove only that nothing changed after they were generated, not before.',
          'VERIFY: data integrity control is supported on SmartStore indexes in your version before enabling it on one.',
          'Hashing adds a little CPU and disk per slice (l1Hashes and l2Hash files in each bucket). It does not change what is searchable.',
          `bin/check-integrity.sh runs splunk check-integrity -index <name> for each index on the indexer it runs on, writes the output to ${logDir}/integrity-<index>-<stamp>.log and exits 1 if any index fails. It applies when run; --dry-run prints the commands.`,
          ...(schedule !== 'manual' ? [`Cron (${schedule}), on every indexer, as the splunk user: ${cron} bash $SPLUNK_HOME/etc/peer-apps/${app}/bin/check-integrity.sh`] : []),
        ],
        before: [
          '| rest /services/data/indexes splunk_server=* | table splunk_server, title, enableDataIntegrityControl, remotePath',
          'splunk cmd btool indexes list --debug | grep -i enableDataIntegrityControl',
        ],
        files: {
          'default/indexes.conf': [
            '# Hash each slice of raw data as it is written, so a later change to the',
            '# bucket on disk can be detected with splunk check-integrity. The indexes',
            '# themselves are defined in their own app; this only adds the setting.',
            ...(all
              ? ['[default]', 'enableDataIntegrityControl = true']
              : indexes.flatMap((index) => [`[${index}]`, 'enableDataIntegrityControl = true', ''])),
          ],
          'bin/check-integrity.sh': bashScript(
            'bin/check-integrity.sh',
            [
              'Verify the integrity hashes of every bucket in the listed indexes on this',
              'indexer. Exits 0 when every index passes, 1 when any fails.',
            ],
            [
              { flag: '--indexes', variable: 'INDEXES', value: indexes.join(','), help: 'Comma separated indexes to check' },
              { flag: '--log-dir', variable: 'LOG_DIR', value: logDir, help: 'Where each report is written' },
            ],
            sh`
              LOG_DIR="$\{LOG_DIR//\$SPLUNK_HOME/$SPLUNK_HOME}"
              [[ -n "$INDEXES" ]] || { echo "--indexes is empty: nothing to check" >&2; exit 2; }
              stamp=$(date +%Y%m%d%H%M%S)
              failed=0
              run mkdir -p "$LOG_DIR"
              IFS=',' read -r -a list <<< "$INDEXES"
              for index in "$\{list[@]}"; do
                index="$\{index//[[:space:]]/}"
                [[ -n "$index" ]] || continue
                report="$LOG_DIR/integrity-$index-$stamp.log"
                if [[ $EXECUTE -eq 1 ]]; then
                  echo "== $index"
                  if "$SPLUNK" check-integrity -index "$index" > "$report" 2>&1; then
                    echo "  passed ($report)"
                  else
                    echo "  FAILED ($report)"
                    failed=$((failed + 1))
                  fi
                else
                  printf '[dry run] %s check-integrity -index %s > %s\n' "$SPLUNK" "$index" "$report"
                fi
              done
              if [[ $failed -gt 0 ]]; then
                echo "$failed index(es) failed the integrity check. Read the reports before anything else touches those buckets."
                exit 1
              fi
            `,
          ),
          'metadata/default.meta': defaultMeta(),
        },
        verify: [
          `splunk cmd btool indexes list ${all ? 'default' : (indexes[0] ?? '<index>')} --debug | grep enableDataIntegrityControl`,
          `bash $SPLUNK_HOME/etc/peer-apps/${app}/bin/check-integrity.sh --dry-run`,
          `splunk check-integrity -index ${indexes[0] ?? '<index>'}   # after the next bucket has rolled`,
          'index=_internal source=*integrity-*.log earliest=-7d | stats latest(_raw) by source',
        ],
        backout: [
          '# Remove the app from manager-apps and push the bundle. Buckets already hashed keep',
          '# their hash files; new buckets are written without them.',
          `rm -rf $SPLUNK_HOME/etc/manager-apps/${app} && splunk apply cluster-bundle`,
        ],
        findings,
      };
    },
  });
}

export const INDEXER_STORAGE_BLUEPRINTS: readonly SplunkBlueprint[] = [smartstoreAzure(), smartstoreGcs(), dataIntegrity()];
