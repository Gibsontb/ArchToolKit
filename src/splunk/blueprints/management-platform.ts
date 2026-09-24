/**
 * Splunk management: the platform underneath the apps.
 *
 * Clustering, bundle distribution, forwarder management, licensing,
 * monitoring, upgrades and backups. These are the nodes that distribute
 * everything else, so a mistake here is not one broken input — it is a cluster
 * that will not meet its replication factor, a deployment server that tells ten
 * thousand forwarders to restart at once, or an upgrade that skips a version
 * the KV store cannot jump.
 *
 * Nothing here writes a secret. A `pass4SymmKey` is a placeholder in every
 * generated file, and the one script that sets it reads the value from a
 * mode-600 file with shell builtins, so it is never on a command line, never
 * echoed and never in version control. Splunk encrypts it in place on the next
 * restart, using `etc/auth/splunk.secret` — which is why that file is backed
 * up, encrypted, with the configuration it decrypts.
 *
 * Every script applies when run; `--dry-run` previews. Every CLI call assumes
 * the operator ran `splunk login` first, which prompts and caches a session,
 * so no password is ever on argv.
 */

import { bool, num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, info, warning, type Finding } from '../../core/findings.ts';
import { currentEstate } from '../../kit/estate-store.ts';
import { isWorkload } from '../../vmware/inventory.ts';
import { splunkBlueprint, type SplunkBlueprint } from '../from-app.ts';
import { defaultMeta, foldSearch, listOf, searchWindow, splunkName, spreadCron, type SplunkApp } from '../splunk.ts';

const TIER = 'management' as const;
const SOURCE_ARCH = 'Splunk Validated Architectures; Splunk Enterprise Capacity Planning Manual (reference hardware)';

// --- script scaffolding ------------------------------------------------------

/**
 * A bash template that keeps bash's own `${...}` out of TypeScript's way.
 *
 * Written as String.raw, so regexes and backslashes arrive as typed; bash
 * parameter expansion is written `$\{VAR}` in the source and becomes `${VAR}`
 * here. TypeScript `${value}` interpolation still works for generated values.
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
 * The part every generated script shares: usage, strict mode, a private
 * umask, and a `run` that acts when run and only prints when `--dry-run` is
 * given.
 */
function bashScript(name: string, purpose: readonly string[], options: readonly ScriptOption[], body: readonly string[]): string[] {
  const usage = options.map((o) => (o.value === undefined ? `[${o.flag}]` : `[${o.flag} ${o.variable}]`)).join(' ');
  return [
    '#!/usr/bin/env bash',
    ...purpose.map((line) => `# ${line}`),
    '#',
    `# Usage: bash bin/${name} [--dry-run]${usage ? ` ${usage}` : ''}`,
    '#   --dry-run   Preview. The script prints what it would do and changes nothing.',
    ...options.map((o) => `#   ${(o.value === undefined ? o.flag : `${o.flag} ${o.variable}`).padEnd(11)} ${o.help}${o.value !== undefined && o.value !== '' ? ` (default: ${o.value})` : ''}`),
    '#',
    '# Run it as the user splunkd runs as. Authenticate the CLI first with',
    '# "splunk login": it prompts, caches a session, and keeps the password off',
    '# the command line, where any user on the host could read it from ps.',
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
 * Sets pass4SymmKey in one stanza of a server.conf, from a mode-600 file.
 *
 * The value is read with `read` and written with `printf`, both bash builtins,
 * so it never appears in a process argument list. Splunk encrypts it on the
 * next start.
 */
function setSecretScript(defaultStanza: string): string[] {
  return bashScript(
    'set-pass4symmkey.sh',
    [
      'Set pass4SymmKey in one stanza of a server.conf, reading the value from a file.',
      'The file must be mode 600 or 400 and hold the key on its first line. The value',
      'is never printed, never passed as an argument, and is encrypted by splunkd on',
      'its next start (with etc/auth/splunk.secret, so keep that file backed up).',
    ],
    [
      { flag: '--stanza', variable: 'STANZA', value: defaultStanza, help: 'Stanza to set it in: clustering, shclustering, general' },
      { flag: '--secret-file', variable: 'SECRET_FILE', value: '', help: 'Mode-600 file holding the key' },
      { flag: '--conf', variable: 'CONF', value: '$SPLUNK_HOME/etc/system/local/server.conf', help: 'server.conf to edit' },
    ],
    sh`
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
      key_re='^[[:space:]]*pass4SymmKey[[:space:]]*='
      tmp=$(mktemp)
      trap 'rm -f "$tmp"' EXIT
      inside=0
      written=0
      if [[ -f "$CONF" ]]; then
        while IFS= read -r line || [[ -n "$line" ]]; do
          if [[ $line =~ $header_re ]]; then
            if [[ $inside -eq 1 && $written -eq 0 ]]; then printf 'pass4SymmKey = %s\n' "$secret"; written=1; fi
            if [[ "$\{BASH_REMATCH[1]}" == "$STANZA" ]]; then inside=1; else inside=0; fi
          elif [[ $inside -eq 1 && $line =~ $key_re ]]; then
            if [[ $written -eq 0 ]]; then printf 'pass4SymmKey = %s\n' "$secret"; written=1; fi
            continue
          fi
          printf '%s\n' "$line"
        done < "$CONF" > "$tmp"
      fi
      if [[ $inside -eq 1 && $written -eq 0 ]]; then printf 'pass4SymmKey = %s\n' "$secret" >> "$tmp"; written=1; fi
      if [[ $written -eq 0 ]]; then printf '\n[%s]\npass4SymmKey = %s\n' "$STANZA" "$secret" >> "$tmp"; fi
      unset secret

      if [[ $EXECUTE -eq 1 ]]; then
        [[ -f "$CONF" ]] && cp -p "$CONF" "$CONF.bak.$(date +%Y%m%d%H%M%S)"
        cat "$tmp" > "$CONF"
        chmod 600 "$CONF"
        echo "pass4SymmKey set in [$STANZA] of $CONF. Restart splunkd; it encrypts the value on start."
      else
        echo "[dry run] would set pass4SymmKey in [$STANZA] of $CONF (value not shown)."
        echo "[dry run] every other change to the file:"
        diff <(grep -v -E "$key_re" "$CONF" 2>/dev/null || true) <(grep -v -E "$key_re" "$tmp") || true
      fi
    `,
  );
}

/** Host names from a textarea, one per line or comma separated, with an optional second word (a site). */
function hostsWithSite(value: string): { host: string; site: string }[] {
  return String(value ?? '')
    .split(/[\n,]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [host = '', site = ''] = line.split(/\s+/);
      return { host, site };
    });
}

function uriOf(host: string, port = 8089): string {
  if (/^https?:\/\//.test(host)) return host;
  return `https://${host.includes(':') ? host : `${host}:${port}`}`;
}

// --- 1. architecture -------------------------------------------------------

interface Sizing {
  readonly perIndexerGb: number;
  readonly byVolume: number;
  readonly minimum: number;
  readonly required: number;
  readonly indexers: number;
  readonly why: string[];
}

function sizeIndexers(dailyGb: number, premium: string, concurrentUsers: number, rf: number, multisite: boolean, sites: number, override: number, siteTotal: number): Sizing {
  const es = premium === 'es' || premium === 'es_itsi';
  const itsi = premium === 'itsi' || premium === 'es_itsi';
  let perIndexerGb = es ? 100 : itsi ? 200 : 300;
  const why = [
    es
      ? 'Enterprise Security: ~100 GB/day per reference indexer. ES correlation searches and data model acceleration run on the indexers and roughly triple the search load per GB.'
      : itsi
        ? 'ITSI: ~200 GB/day per reference indexer. KPI searches run constantly, so capacity sits between a plain deployment and ES.'
        : 'No premium app: ~300 GB/day per reference indexer, the upper end of Splunk’s guidance for the reference hardware with a moderate search load.',
  ];
  if (concurrentUsers > 50) {
    perIndexerGb = Math.round(perIndexerGb * 0.75);
    why.push(`More than 50 concurrent search users: capacity per indexer reduced by a quarter, to ${perIndexerGb} GB/day, because search competes with indexing for the same cores.`);
  }
  const byVolume = Math.max(1, Math.ceil(dailyGb / perIndexerGb));
  let minimum = Math.max(rf, multisite ? siteTotal : rf);
  let required = Math.max(byVolume, minimum);
  if (multisite) {
    required = Math.ceil(required / sites) * sites;
    minimum = Math.ceil(minimum / sites) * sites;
    why.push(`Multisite: rounded up to a multiple of ${sites} so every site carries the same share of ingest and can hold its copies.`);
  }
  return { perIndexerGb, byVolume, minimum, required, indexers: override > 0 ? override : required, why };
}

function architecture(): SplunkBlueprint {
  return splunkBlueprint({
    id: 'splunk_architecture',
    tier: TIER,
    label: 'Deployment architecture and sizing',
    group: 'Design',
    description: 'A Splunk Enterprise design from the daily volume, retention, search load and premium apps: indexer count, search head cluster, replication and search factors, storage per indexer with the arithmetic shown, the management nodes and what may share a host, the ports, and a server.conf skeleton for every role.',
    inputs: [
      { id: 'app_name', label: 'Design package name', control: 'text', default: 'org_platform_design' },
      { id: 'daily_gb', label: 'Daily ingest (GB/day)', control: 'number', default: 500, min: 1, max: 1000000, hint: 'Licensed volume, raw' },
      { id: 'hot_days', label: 'Hot and warm retention (days)', control: 'number', default: 30, min: 1, max: 3650, hint: 'The window on fast disk' },
      { id: 'retention_days', label: 'Total retention (days)', control: 'number', default: 90, min: 1, max: 3650, hint: 'Hot, warm and cold together' },
      { id: 'concurrent_users', label: 'Concurrent search users', control: 'number', default: 20, min: 1, max: 5000 },
      { id: 'premium', label: 'Premium apps', control: 'select', default: 'none', options: [
        { value: 'none', label: 'None' },
        { value: 'es', label: 'Enterprise Security' },
        { value: 'itsi', label: 'IT Service Intelligence' },
        { value: 'es_itsi', label: 'Both ES and ITSI' },
      ] },
      { id: 'es_dedicated', label: 'Premium app on its own search head (cluster)', control: 'toggle', default: true, showWhen: { input: 'premium', notEquals: ['none'] } },
      { id: 'ha', label: 'Availability', control: 'select', default: 'single', options: [
        { value: 'single', label: 'Single site cluster' },
        { value: 'multisite', label: 'Multisite cluster' },
      ] },
      { id: 'sites', label: 'Sites', control: 'number', default: 2, min: 2, max: 6, showWhen: { input: 'ha', equals: ['multisite'] } },
      { id: 'smartstore', label: 'SmartStore (S3-compatible remote storage)', control: 'toggle', default: false },
      { id: 'rf', label: 'Replication factor', control: 'number', default: 3, min: 1, max: 10 },
      { id: 'sf', label: 'Search factor', control: 'number', default: 2, min: 1, max: 10 },
      { id: 'shc_members', label: 'Search head cluster members', control: 'number', default: 3, min: 1, max: 50 },
      { id: 'indexers_override', label: 'Indexer count', control: 'number', default: 0, min: 0, max: 1000, hint: '0 to size from the volume' },
      { id: 'forwarders', label: 'Forwarders (deployment clients)', control: 'number', default: 500, min: 0, max: 200000 },
      { id: 'production', label: 'Production', control: 'toggle', default: true },
    ],
    app: (values: BlueprintValues): SplunkApp => {
      const app = splunkName(str(values, 'app_name', 'org_platform_design'), 'org_platform_design');
      const dailyGb = num(values, 'daily_gb', 500);
      const hotDays = num(values, 'hot_days', 30);
      const retentionDays = num(values, 'retention_days', 90);
      const coldDays = Math.max(0, retentionDays - hotDays);
      const users = num(values, 'concurrent_users', 20);
      const premium = str(values, 'premium', 'none');
      const esDedicated = bool(values, 'es_dedicated', true);
      const multisite = str(values, 'ha', 'single') === 'multisite';
      const sites = multisite ? Math.max(2, num(values, 'sites', 2)) : 1;
      const smartstore = bool(values, 'smartstore', false);
      const rf = num(values, 'rf', 3);
      const sf = num(values, 'sf', 2);
      const shc = num(values, 'shc_members', 3);
      const override = num(values, 'indexers_override', 0);
      const forwarders = num(values, 'forwarders', 500);
      const production = bool(values, 'production', true);
      const findings: Finding[] = [];

      // Multisite factors: two copies at the site that received the data, and
      // at least one at every other site.
      const originRf = Math.min(2, rf);
      const totalRf = Math.max(rf, sites + originRf - 1);
      const originSf = 1;
      const totalSf = Math.max(sf, sites);
      const siteRf = `origin:${originRf},total:${totalRf}`;
      const siteSf = `origin:${originSf},total:${totalSf}`;
      const effectiveRf = multisite ? totalRf : rf;
      const effectiveSf = multisite ? totalSf : sf;

      const sizing = sizeIndexers(dailyGb, premium, users, rf, multisite, sites, override, totalRf);
      const n = sizing.indexers;

      // Storage. Splunk's rule of thumb: rawdata (the compressed journal) is
      // ~15% of raw and the index files (tsidx) ~35%, so ~50% for a searchable
      // copy. Every replicated copy carries rawdata; only searchable copies
      // carry the index files.
      const rawPerCopy = 0.15;
      const tsidxPerCopy = 0.35;
      const perDayCluster = dailyGb * (rawPerCopy * effectiveRf + tsidxPerCopy * effectiveSf);
      const headroom = 1.2;
      const hotPerIndexer = Math.ceil((perDayCluster * hotDays * headroom) / n);
      const coldPerIndexer = Math.ceil((perDayCluster * coldDays * headroom) / n);
      const remoteTotal = Math.ceil(dailyGb * (rawPerCopy + tsidxPerCopy) * retentionDays);
      const cachePerIndexer = Math.ceil((dailyGb * (rawPerCopy + tsidxPerCopy) * hotDays * headroom) / n);

      const es = premium === 'es' || premium === 'es_itsi';
      const itsi = premium === 'itsi' || premium === 'es_itsi';

      if (sf > rf) {
        findings.push(error('splunk.sf-exceeds-rf', `Search factor ${sf} is greater than replication factor ${rf}. A searchable copy is a replicated copy with index files, so there cannot be more of them than copies — the cluster manager will refuse the configuration.`, { remediation: 'Set search_factor ≤ replication_factor.', source: 'server.conf.spec [clustering]' }));
      }
      if (production && rf < 3) {
        findings.push(warning('splunk.rf-below-3', `Replication factor ${rf} in production. With RF 2, one peer down for maintenance leaves a single copy of its buckets; a second failure during that window loses data.`, { remediation: 'Use RF 3 (SF 2) for production unless the data is reproducible.', source: SOURCE_ARCH }));
      }
      if (shc % 2 === 0) {
        findings.push(warning('splunk.shc-even', `${shc} search head cluster members. Captain election needs a majority, and an even number buys no extra failure tolerance over one fewer — ${shc} members survive the loss of ${Math.floor((shc - 1) / 2)}, the same as ${shc - 1}.`, { remediation: `Use ${shc + 1} or ${shc - 1} members.`, source: 'Splunk Distributed Search Manual: SHC captain election' }));
      }
      if (shc < 3) {
        findings.push(warning('splunk.shc-too-small', `${shc} search head${shc === 1 ? '' : 's'}: a search head cluster needs at least three members to elect a captain. ${shc === 1 ? 'A single search head is a valid design, but it is not highly available.' : 'Two members cannot form a cluster.'}`, { source: 'Splunk Distributed Search Manual: SHC system requirements' }));
      }
      if (premium !== 'none' && !esDedicated) {
        findings.push(warning('splunk.premium-shared-sh', `${es ? 'Enterprise Security' : 'ITSI'} on a search head shared with ordinary users. Its correlation searches and accelerations take the scheduler’s capacity, and ad hoc users then see skipped searches and slow dashboards — and a problem in either now affects both.`, { remediation: 'Give the premium app its own search head or search head cluster, as Splunk requires for ES.', source: 'Splunk Enterprise Security installation manual: deployment planning' }));
      }
      if (override > 0 && override < sizing.minimum) {
        findings.push(error('splunk.indexers-below-rf', `${override} indexers cannot hold ${effectiveRf} copies of every bucket on separate peers${multisite ? ` across ${sites} sites` : ''}. The cluster will never meet its replication factor.`, { remediation: `At least ${sizing.minimum} indexers.`, source: 'server.conf.spec [clustering]' }));
      } else if (override > 0 && override < sizing.required) {
        findings.push(warning('splunk.indexers-too-few', `${override} indexers for ${dailyGb} GB/day is ${Math.round(dailyGb / override)} GB/day each, above the ~${sizing.perIndexerGb} GB/day assumed for this workload. Expect indexing queues to block at peak and searches to slow down.`, { remediation: `Size for ${sizing.required} indexers, or confirm the hardware is well above the reference spec.`, source: SOURCE_ARCH }));
      }
      if (hotDays > retentionDays) {
        findings.push(error('splunk.hot-exceeds-total', 'The hot and warm window is longer than the total retention.', { source: 'ArchToolKit' }));
      }
      if (forwarders > 50) {
        findings.push(info('splunk.ds-dedicated', `${forwarders} deployment clients: above about 50, the deployment server should be a dedicated instance rather than colocated with another management role.`, { source: 'Splunk Updating Splunk Enterprise Instances manual: deployment server requirements' }));
      }

      const mgmtRows: string[][] = [
        ['Cluster manager', '1', 'Dedicated for large clusters. May share with the license manager and monitoring console in small deployments.', 'Never on a peer or a search head cluster member.'],
        ['Search head cluster deployer', shc >= 3 ? '1' : '0', 'May share with the cluster manager, license manager or monitoring console (VERIFY against the current Distributed Search manual for your version).', 'Never on a cluster member: the deployer pushes to members and cannot be one.'],
        ['Deployment server', forwarders > 0 ? '1' : '0', forwarders > 50 ? `Dedicated: ${forwarders} clients.` : 'May share with the license manager or monitoring console under ~50 clients.', 'Not on a search head cluster member or an indexer.'],
        ['License manager', '1', 'Commonly shares with the cluster manager or monitoring console.', 'Must run a version equal to or newer than every license peer.'],
        ['Monitoring console', '1', 'May share with the license manager or cluster manager; in a small deployment it can be the cluster manager.', 'Never on a production search head cluster member.'],
        ...(es ? [['Enterprise Security search head(s)', esDedicated ? '1 or a dedicated SHC' : 'shared', 'Dedicated.', 'Never shared with ITSI or general-purpose search.']] : []),
        ...(itsi ? [['ITSI search head(s)', esDedicated ? '1 or a dedicated SHC' : 'shared', 'Dedicated.', 'Never shared with ES.']] : []),
      ];

      const ports: string[][] = [
        ['8089/tcp', 'splunkd management (REST)', 'Every node; cluster manager ↔ peers and search heads; deployer → members; forwarders → deployment server; license peers → license manager'],
        ['8000/tcp', 'Splunk Web', 'Users → search heads, monitoring console'],
        ['9997/tcp', 'Forwarding (splunktcp)', 'Forwarders → indexers (and heavy forwarders). A convention: set in inputs.conf [splunktcp://9997]'],
        ['9887/tcp', 'Indexer cluster replication', 'Peer ↔ peer. The port in Splunk’s documentation examples; any free port, set in [replication_port://<port>] on every peer'],
        ['34567/tcp', 'Search head cluster replication', 'Member ↔ member. The port in Splunk’s documentation examples; any free port, set in [replication_port://<port>] on every member — not the same as the indexer one if colocated'],
        ['8191/tcp', 'KV store', 'Search head cluster member ↔ member ([kvstore] port)'],
        ['8088/tcp', 'HTTP Event Collector', 'Senders → HEC receivers (heavy forwarders or indexers)'],
        ['8065/tcp', 'Application server (Python)', 'Localhost only — no firewall rule needed'],
        ['8080/tcp', 'Replication in older documentation', 'Seen in older examples for [replication_port://8080]; it collides with common web proxies. Use a dedicated port instead'],
      ];

      const licenseStanza = (self: boolean) => ['[license]', `manager_uri = ${self ? 'self' : 'https://lm01.example.com:8089'}`];
      const generalSite = (site: string) => (multisite ? ['[general]', `site = ${site}`, ''] : []);
      const clusteringManager = [
        ...generalSite('site1'),
        '[clustering]',
        'mode = manager',
        `replication_factor = ${rf}`,
        `search_factor = ${sf}`,
        ...(multisite
          ? [
              'multisite = true',
              `available_sites = ${Array.from({ length: sites }, (_, i) => `site${i + 1}`).join(',')}`,
              `site_replication_factor = ${siteRf}`,
              `site_search_factor = ${siteSf}`,
            ]
          : []),
        'cluster_label = idxc1',
        '# Shared by the manager, every peer and every search head of the cluster.',
        '# Set it with bin/set-pass4symmkey.sh from the cluster app, never here.',
        'pass4SymmKey = <REQUIRED: set on the host from a mode-600 file>',
        ...(smartstore ? ['', '# SmartStore: indexes.conf with remotePath = volume:remote_store/$_index_name', '# goes to the peers in manager-apps; the volume is defined there too.'] : []),
        '',
        ...licenseStanza(false),
      ];

      const serverConfs: Record<string, string[]> = {
        'server-conf/cluster-manager.conf': ['# $SPLUNK_HOME/etc/system/local/server.conf on the cluster manager', '', ...clusteringManager],
        'server-conf/indexer-peer.conf': [
          '# $SPLUNK_HOME/etc/system/local/server.conf on every indexer',
          '',
          ...generalSite('siteN   # this peer’s site'),
          '[clustering]',
          'mode = peer',
          'manager_uri = https://cm01.example.com:8089',
          'pass4SymmKey = <REQUIRED: set on the host from a mode-600 file>',
          '',
          '# Peer-to-peer bucket replication. Any free port; the same on every peer.',
          '[replication_port://9887]',
          '',
          ...licenseStanza(false),
        ],
        'server-conf/search-head.conf': [
          '# $SPLUNK_HOME/etc/system/local/server.conf on each search head (and SHC member)',
          '',
          ...(multisite ? ['[general]', '# site0 turns off site affinity: search any site’s copies.', 'site = site1', ''] : []),
          '[clustering]',
          'mode = searchhead',
          'manager_uri = https://cm01.example.com:8089',
          ...(multisite ? ['multisite = true'] : []),
          'pass4SymmKey = <REQUIRED: the indexer cluster key>',
          '',
          ...(shc >= 3
            ? [
                '[shclustering]',
                'disabled = 0',
                'mgmt_uri = https://<this member>:8089',
                'conf_deploy_fetch_url = https://deployer01.example.com:8089',
                'replication_factor = 3',
                'shcluster_label = shc1',
                'pass4SymmKey = <REQUIRED: the search head cluster key, different from the indexer one>',
                '',
                '[replication_port://34567]',
                '',
              ]
            : []),
          ...licenseStanza(false),
        ],
        ...(shc >= 3
          ? {
              'server-conf/shc-deployer.conf': [
                '# $SPLUNK_HOME/etc/system/local/server.conf on the deployer',
                '',
                '[shclustering]',
                'pass4SymmKey = <REQUIRED: the search head cluster key>',
                'shcluster_label = shc1',
                '',
                ...licenseStanza(false),
              ],
            }
          : {}),
        'server-conf/license-manager.conf': ['# $SPLUNK_HOME/etc/system/local/server.conf on the license manager', '', ...licenseStanza(true)],
        'server-conf/deployment-server.conf': [
          '# $SPLUNK_HOME/etc/system/local/server.conf on the deployment server',
          '# The deployment server itself is configured in serverclass.conf; here it',
          '# only needs to report to the license manager.',
          '',
          ...licenseStanza(false),
        ],
        'server-conf/monitoring-console.conf': [
          '# $SPLUNK_HOME/etc/system/local/server.conf on the monitoring console',
          '# Every other node is added as a search peer (Settings > Distributed search),',
          '# then roles are assigned in Monitoring Console > Settings > General Setup.',
          '',
          ...licenseStanza(false),
        ],
      };

      const table = (header: string[], rows: string[][]) => [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)];

      const design = [
        `# Splunk deployment design: ${dailyGb} GB/day, ${retentionDays} days`,
        '',
        '## Inputs',
        '',
        ...table(['Input', 'Value'], [
          ['Daily ingest', `${dailyGb} GB/day`],
          ['Hot/warm retention', `${hotDays} days`],
          ['Cold retention', `${coldDays} days`],
          ['Concurrent search users', String(users)],
          ['Premium apps', premium === 'none' ? 'none' : [es ? 'Enterprise Security' : '', itsi ? 'ITSI' : ''].filter(Boolean).join(', ')],
          ['Availability', multisite ? `multisite, ${sites} sites` : 'single site'],
          ['Storage', smartstore ? 'SmartStore' : 'classic (local hot/warm and cold)'],
        ]),
        '',
        '## Indexers',
        '',
        `**${n} indexers**${override > 0 ? ' (set by hand)' : ''}. Sized ${sizing.required} from the volume and the replication factor.`,
        '',
        `- Assumption: ${sizing.perIndexerGb} GB/day per indexer on Splunk’s reference hardware (the Capacity Planning Manual’s reference indexer: 12+ physical cores, 12+ GB RAM, 800+ IOPS storage — check the current manual for your version). Splunk’s guidance ranges from ~100 GB/day per indexer with Enterprise Security to ~300 GB/day without premium apps. It is a planning figure, not a guarantee: measure queue fill ratios once live.`,
        ...sizing.why.map((w) => `- ${w}`),
        `- ${dailyGb} ÷ ${sizing.perIndexerGb} = ${(dailyGb / sizing.perIndexerGb).toFixed(2)} → ${sizing.byVolume} by volume; at least ${sizing.minimum} to hold ${effectiveRf} copies on separate peers.`,
        '- No spare is included: with one indexer down, the rest carry its ingest. Add one if the per-indexer figure is already near its limit.',
        '',
        '## Replication',
        '',
        ...table(['Setting', 'Value', 'Meaning'], [
          ['replication_factor', String(rf), 'Copies of every bucket kept across the peers'],
          ['search_factor', String(sf), 'Of those, copies with index files (immediately searchable)'],
          ...(multisite
            ? [
                ['site_replication_factor', siteRf, `${originRf} copies at the site that received the data, ${totalRf} in total, so every site has at least one`],
                ['site_search_factor', siteSf, `${originSf} searchable copy at the origin site, ${totalSf} in total`],
              ]
            : []),
        ]),
        '',
        '## Storage per indexer',
        '',
        '- Splunk’s rule of thumb: the compressed rawdata journal is ~15% of raw volume, and the index files (tsidx) are ~35%, so one searchable copy is ~50%. Real ratios vary by source from under 30% to over 100% — measure with `| dbinspect` after a week.',
        '- Every replicated copy holds rawdata; only searchable copies hold index files.',
        `- Per day, cluster-wide: ${dailyGb} × (0.15 × ${effectiveRf} + 0.35 × ${effectiveSf}) = ${perDayCluster.toFixed(1)} GB.`,
        ...(smartstore
          ? [
              `- SmartStore keeps one logical copy of warm buckets in the object store (which provides the durability): ${dailyGb} × 0.50 × ${retentionDays} days = **${remoteTotal} GB** remote.`,
              `- Local cache per indexer, sized to hold the ${hotDays}-day search window plus 20% headroom: ${dailyGb} × 0.50 × ${hotDays} × 1.2 ÷ ${n} = **${cachePerIndexer} GB**. Hot buckets are still replicated to RF on local disk until they roll.`,
            ]
          : [
              `- Hot and warm per indexer: ${perDayCluster.toFixed(1)} × ${hotDays} days × 1.2 headroom ÷ ${n} = **${hotPerIndexer} GB** on fast storage.`,
              `- Cold per indexer: ${perDayCluster.toFixed(1)} × ${coldDays} days × 1.2 ÷ ${n} = **${coldPerIndexer} GB**.`,
            ]),
        '- The 20% headroom is for spikes and for bucket fix-up after a peer failure. Splunk stops indexing when free space on a volume falls below minFreeSpace (5000 MB by default).',
        '',
        '## Search heads',
        '',
        shc >= 3
          ? `- A search head cluster of **${shc} members**, with a deployer. Members need a majority to elect a captain, so an odd count.`
          : `- ${shc} standalone search head${shc === 1 ? '' : 's'}; not a cluster.`,
        ...(premium !== 'none' ? [`- ${es ? 'Enterprise Security' : 'ITSI'}: ${esDedicated ? 'on its own search head or cluster' : '**shared with ordinary search — see findings**'}.`] : []),
        '',
        '## Management nodes',
        '',
        ...table(['Role', 'Count', 'May be colocated', 'Must not'], mgmtRows),
        '',
        '## Ports',
        '',
        ...table(['Port', 'Purpose', 'Between'], ports),
        '',
        '## Server.conf skeletons',
        '',
        ...Object.keys(serverConfs).map((p) => `- \`${p}\``),
        '',
        'Every pass4SymmKey is a placeholder. Set it on the host with the `set-pass4symmkey.sh` script from the indexer cluster or search head cluster package — never in a file that is copied around.',
      ];

      return {
        tier: TIER,
        title: `Splunk design: ${dailyGb} GB/day, ${n} indexers, ${multisite ? `${sites}-site` : 'single-site'} RF${rf}/SF${sf}`,
        app,
        activation: 'restart',
        notes: [
          'This package is a design and a set of server.conf fragments, not an app to install. Each fragment names the host and the file it belongs in.',
          `Indexer count assumes ~${sizing.perIndexerGb} GB/day per reference indexer. Validate against Splunk’s current Capacity Planning Manual and a load test before buying hardware.`,
          'server.conf changes to clustering take effect on restart. Bring up the cluster manager first, then the peers, then the search heads.',
        ],
        before: [
          'splunk version',
          'splunk btool server list clustering --debug',
          'splunk btool server list license --debug',
          '| rest /services/server/info splunk_server=* | table splunk_server, version, numberOfCores, physicalMemoryMB, server_roles',
          '| tstats sum(PREFIX(b=)) as bytes where index=_internal source=*license_usage.log* type=Usage earliest=-30d@d by _time span=1d | eval GB=round(bytes/1024/1024/1024,1)   # VERIFY: or read the License Usage report on the license manager',
        ],
        files: {
          'design.md': design,
          ...serverConfs,
        },
        verify: [
          'splunk show cluster-status --verbose   # on the cluster manager',
          'splunk show shcluster-status --verbose   # on a search head cluster member',
          '| rest /services/cluster/manager/peers splunk_server=local | table label, site, status, bucket_count',
          '| rest /services/server/status/partitions-space splunk_server=* | table splunk_server, mount_point, capacity, free',
          'index=_internal source=*metrics.log group=queue blocked=true | stats count by host, name',
        ],
        backout: [
          '# Nothing is deployed by this package itself.',
          '# To undo a server.conf fragment: restore the .bak of etc/system/local/server.conf and restart splunkd on that node.',
          'splunk btool server list clustering --debug   # confirm what is in effect',
        ],
        findings,
      };
    },
  });
}

// --- 2. indexer cluster ------------------------------------------------------

function indexerCluster(): SplunkBlueprint {
  return splunkBlueprint({
    id: 'splunk_indexer_cluster',
    tier: TIER,
    label: 'Indexer cluster (manager, peers, search heads)',
    group: 'Clustering',
    description: 'server.conf for the cluster manager, every peer and the search heads — single site or multisite — with the scripts that push a bundle safely (validate, check restart, apply), toggle maintenance mode and run a searchable rolling restart.',
    inputs: [
      { id: 'app_name', label: 'Package name', control: 'text', default: 'org_cluster_config' },
      { id: 'cm_host', label: 'Cluster manager', control: 'text', default: 'cm01.example.com' },
      { id: 'peers', label: 'Peers', control: 'textarea', default: 'idx01.example.com site1\nidx02.example.com site1\nidx03.example.com site2\nidx04.example.com site2', hint: 'One per line; add the site after a space for multisite' },
      { id: 'rf', label: 'Replication factor', control: 'number', default: 3, min: 1, max: 10 },
      { id: 'sf', label: 'Search factor', control: 'number', default: 2, min: 1, max: 10 },
      { id: 'multisite', label: 'Multisite', control: 'toggle', default: false },
      { id: 'sites', label: 'Available sites', control: 'text', default: 'site1, site2', showWhen: { input: 'multisite', equals: ['true'] } },
      { id: 'site_rf', label: 'Site replication factor', control: 'text', default: 'origin:2,total:3', showWhen: { input: 'multisite', equals: ['true'] } },
      { id: 'site_sf', label: 'Site search factor', control: 'text', default: 'origin:1,total:2', showWhen: { input: 'multisite', equals: ['true'] } },
      { id: 'manager_site', label: 'Cluster manager site', control: 'text', default: 'site1', showWhen: { input: 'multisite', equals: ['true'] } },
      { id: 'sh_site', label: 'Search head site', control: 'text', default: 'site1', hint: 'site0 to search every site', showWhen: { input: 'multisite', equals: ['true'] } },
      { id: 'replication_port', label: 'Peer replication port', control: 'number', default: 9887, min: 1024, max: 65535 },
      { id: 'receiving_port', label: 'Forwarder receiving port', control: 'number', default: 9997, min: 1024, max: 65535 },
      { id: 'label', label: 'Cluster label', control: 'text', default: 'idxc1' },
    ],
    app: (values: BlueprintValues): SplunkApp => {
      const app = splunkName(str(values, 'app_name', 'org_cluster_config'), 'org_cluster_config');
      const cm = uriOf(str(values, 'cm_host', 'cm01.example.com'));
      const peers = hostsWithSite(str(values, 'peers', ''));
      const rf = num(values, 'rf', 3);
      const sf = num(values, 'sf', 2);
      const multisite = bool(values, 'multisite', false);
      const sites = listOf(str(values, 'sites', 'site1, site2'));
      const siteRf = str(values, 'site_rf', 'origin:2,total:3');
      const siteSf = str(values, 'site_sf', 'origin:1,total:2');
      const managerSite = str(values, 'manager_site', 'site1');
      const shSite = multisite ? String(values['sh_site'] ?? '').trim() : '';
      const replicationPort = num(values, 'replication_port', 9887);
      const receivingPort = num(values, 'receiving_port', 9997);
      const label = splunkName(str(values, 'label', 'idxc1'), 'idxc1');
      const findings: Finding[] = [];

      findings.push(warning('splunk.pass4symmkey-placeholder', 'pass4SymmKey is a placeholder in every generated file. Until it is set — to the same value on the manager, every peer and every search head — peers will not register and searches will not reach them.', { remediation: 'Run bin/set-pass4symmkey.sh --stanza clustering --secret-file <mode-600 file> on each node, then restart.', source: 'ArchToolKit' }));
      if (sf > rf) findings.push(error('splunk.sf-exceeds-rf', `search_factor ${sf} is greater than replication_factor ${rf}; the cluster manager will not start with that.`, { source: 'server.conf.spec [clustering]' }));
      if (rf > peers.length) findings.push(error('splunk.rf-exceeds-peers', `replication_factor ${rf} with ${peers.length} peer${peers.length === 1 ? '' : 's'}: the cluster can never place ${rf} copies on separate peers, and stays incomplete for ever.`, { remediation: `Add peers or lower replication_factor to ${peers.length}.`, source: 'server.conf.spec [clustering]' }));
      if (rf < 3) findings.push(warning('splunk.rf-below-3', `replication_factor ${rf}: one peer down for maintenance leaves a single copy of its buckets.`, { source: SOURCE_ARCH }));
      if (multisite) {
        if (!shSite) findings.push(error('splunk.multisite-sh-no-site', 'Multisite cluster, but the search heads have no site. A search head in a multisite cluster must have [general] site set (site0 to disable site affinity) or it will not search the cluster.', { remediation: 'Set the search head site, or site0.', source: 'Splunk Managing Indexers and Clusters: configure multisite search heads' }));
        const missing = peers.filter((p) => !p.site);
        if (missing.length > 0) findings.push(error('splunk.multisite-peer-no-site', `${missing.map((p) => p.host).join(', ')} ${missing.length === 1 ? 'has' : 'have'} no site. Every peer in a multisite cluster needs [general] site.`, { source: 'server.conf.spec [general] site' }));
        const unknown = peers.filter((p) => p.site && !sites.includes(p.site));
        if (unknown.length > 0) findings.push(error('splunk.multisite-unknown-site', `${unknown.map((p) => `${p.host} (${p.site})`).join(', ')}: site not in available_sites (${sites.join(', ')}).`, { source: 'server.conf.spec [clustering] available_sites' }));
        if (!sites.includes(managerSite)) findings.push(error('splunk.multisite-manager-site', `The cluster manager site ${managerSite} is not in available_sites.`, { source: 'server.conf.spec [clustering]' }));
        const total = Number(/total:(\d+)/.exec(siteRf)?.[1] ?? '0');
        if (total > peers.length) findings.push(error('splunk.site-rf-exceeds-peers', `site_replication_factor total ${total} with ${peers.length} peers.`, { source: 'server.conf.spec [clustering]' }));
      }

      const general = (site: string) => (multisite ? ['[general]', `site = ${site}`, ''] : []);
      const peerFiles: Record<string, string[]> = {};
      const bySite = multisite ? Array.from(new Set(peers.map((p) => p.site || 'site1'))) : ['all'];
      for (const site of bySite) {
        const members = multisite ? peers.filter((p) => (p.site || 'site1') === site) : peers;
        peerFiles[`server-conf/peer${multisite ? `-${site}` : ''}.conf`] = [
          `# $SPLUNK_HOME/etc/system/local/server.conf on: ${members.map((p) => p.host).join(', ')}`,
          '',
          ...general(site),
          '[clustering]',
          'mode = peer',
          `manager_uri = ${cm}`,
          '# The same key as the manager and the search heads.',
          'pass4SymmKey = <REQUIRED: set with bin/set-pass4symmkey.sh --stanza clustering>',
          '',
          '# Bucket replication between peers. Open this port peer to peer only.',
          `[replication_port://${replicationPort}]`,
        ];
      }

      return {
        tier: TIER,
        title: `Indexer cluster ${label}: ${peers.length} peers, RF${rf}/SF${sf}${multisite ? `, ${sites.length} sites` : ''}`,
        app,
        activation: 'restart',
        notes: [
          'Order: the manager first (it waits for peers), then each peer, then the search heads. Each needs a restart after its server.conf changes.',
          'Written for Splunk Enterprise 10.4: mode = manager / peer / searchhead and manager_uri throughout. The old master and slave spellings are not generated.',
          `The peers’ receiving port (${receivingPort}) and their indexes belong in an app in $SPLUNK_HOME/etc/manager-apps on the manager, pushed as the cluster bundle into $SPLUNK_HOME/etc/peer-apps on each peer — not in each peer’s system/local.`,
          'bin/bundle-push.sh validates first and shows whether the bundle needs a restart. A restart-requiring bundle rolls every peer; push it in a change window.',
          'Maintenance mode stops bucket fix-up while a peer is deliberately down. Turn it off afterwards, or the cluster never repairs a real failure.',
          ...(multisite ? [`Search heads: site = ${shSite || '<unset>'}. site0 turns off search affinity, so the search head reads whichever copy answers — use it for a search head that serves every site.`] : []),
        ],
        before: [
          'splunk btool server list clustering --debug',
          'splunk show cluster-status --verbose   # on the manager, if the cluster already exists',
          `nc -zv <peer> ${replicationPort}   # from another peer: replication port reachable`,
          `nc -zv ${cm.replace(/^https:\/\//, '').replace(/:\d+$/, '')} 8089   # from each peer and search head`,
        ],
        files: {
          'server-conf/manager.conf': [
            '# $SPLUNK_HOME/etc/system/local/server.conf on the cluster manager',
            '',
            ...general(managerSite),
            '[clustering]',
            'mode = manager',
            `# ${rf} copies of every bucket, ${sf} of them searchable. SF cannot exceed RF.`,
            `replication_factor = ${rf}`,
            `search_factor = ${sf}`,
            ...(multisite
              ? [
                  '# Multisite: where the copies go. "origin" is the site that received the',
                  '# data; "total" is across all sites. In multisite mode these replace',
                  '# replication_factor and search_factor for placement.',
                  'multisite = true',
                  `available_sites = ${sites.join(',')}`,
                  `site_replication_factor = ${siteRf}`,
                  `site_search_factor = ${siteSf}`,
                ]
              : []),
            `cluster_label = ${label}`,
            '# The shared secret. Set on the host from a mode-600 file, never here.',
            'pass4SymmKey = <REQUIRED: set with bin/set-pass4symmkey.sh --stanza clustering>',
          ],
          ...peerFiles,
          'server-conf/search-head.conf': [
            '# $SPLUNK_HOME/etc/system/local/server.conf on each search head of this cluster',
            '',
            ...(multisite ? ['[general]', '# site0 disables site affinity: search whichever copy answers.', `site = ${shSite || '<REQUIRED: site1 or site0>'}`, ''] : []),
            '[clustering]',
            'mode = searchhead',
            `manager_uri = ${cm}`,
            ...(multisite ? ['multisite = true'] : []),
            'pass4SymmKey = <REQUIRED: set with bin/set-pass4symmkey.sh --stanza clustering>',
          ],
          'server-conf/manager-apps-receiving-inputs.conf': [
            `# $SPLUNK_HOME/etc/manager-apps/org_peer_receiving/local/inputs.conf on the manager,`,
            '# pushed to every peer by bin/bundle-push.sh.',
            `[splunktcp://${receivingPort}]`,
            'disabled = 0',
          ],
          'bin/set-pass4symmkey.sh': setSecretScript('clustering'),
          'bin/bundle-push.sh': bashScript(
            'bundle-push.sh',
            [
              'Validate and push the cluster bundle from the manager (etc/manager-apps).',
              'Always validates and reports whether the push restarts the peers, then',
              'applies; --dry-run stops before the push.',
            ],
            [{ flag: '--skip-restart-check', variable: 'SKIP_CHECK', help: 'Do not stop when the bundle needs a restart' }],
            sh`
              echo "== Validating the bundle (no change to the peers)"
              "$SPLUNK" validate cluster-bundle --check-restart
              echo "== Waiting for validation to finish"
              # The restart check below is only as good as this read: a failed read
              # (not logged in, splunkd down) or a validation still running after five
              # minutes stops the script rather than pushing without the check.
              validated=0
              for _ in $(seq 1 60); do
                if ! status=$("$SPLUNK" show cluster-bundle-status 2>&1); then
                  printf '%s\n' "$status" >&2
                  echo "Could not read the bundle status (run splunk login first). Nothing pushed." >&2
                  exit 1
                fi
                if ! grep -qi "in progress" <<<"$status"; then validated=1; break; fi
                sleep 5
              done
              printf '%s\n' "$status"
              [[ $validated -eq 1 ]] || { echo "Validation still in progress after 5 minutes. Nothing pushed; check again with: $SPLUNK show cluster-bundle-status" >&2; exit 1; }
              if grep -qi "restart.*required\|requires restart\|needs restart" <<<"$status" && [[ $SKIP_CHECK -eq 0 ]]; then
                echo "This bundle restarts the peers (a rolling restart). Re-run with --skip-restart-check inside a change window." >&2
                [[ $EXECUTE -eq 1 ]] && exit 3
              fi
              run "$SPLUNK" apply cluster-bundle --answer-yes
              if [[ $EXECUTE -eq 1 ]]; then
                echo "== Push started. Follow it with: $SPLUNK show cluster-bundle-status"
                echo "== Undo the last push with:     $SPLUNK rollback cluster-bundle"
              fi
            `,
          ),
          'bin/maintenance.sh': bashScript(
            'maintenance.sh',
            [
              'Turn cluster maintenance mode on or off, on the manager.',
              'While on, the manager does not start bucket fix-up for a peer that goes',
              'down, so a planned restart does not trigger a storm of replication.',
            ],
            [{ flag: '--mode', variable: 'MODE', value: 'show', help: 'enable, disable or show' }],
            sh`
              case "$MODE" in
                enable) run "$SPLUNK" enable maintenance-mode --answer-yes ;;
                disable) run "$SPLUNK" disable maintenance-mode ;;
                show) "$SPLUNK" show maintenance-mode ;;
                *) echo "--mode must be enable, disable or show" >&2; exit 2 ;;
              esac
              "$SPLUNK" show maintenance-mode || true
            `,
          ),
          'bin/rolling-restart.sh': bashScript(
            'rolling-restart.sh',
            [
              'Searchable rolling restart of every peer, from the manager. The cluster must',
              'be healthy (RF and SF met) first, or the manager refuses a searchable restart.',
            ],
            [{ flag: '--not-searchable', variable: 'NOT_SEARCHABLE', help: 'Restart without keeping searches running (faster)' }],
            sh`
              "$SPLUNK" show cluster-status --verbose | sed -n 1,40p   # sed reads it all: no SIGPIPE under pipefail
              if [[ $NOT_SEARCHABLE -eq 1 ]]; then
                run "$SPLUNK" rolling-restart cluster-peers
              else
                run "$SPLUNK" rolling-restart cluster-peers -searchable true
              fi
            `,
          ),
        },
        verify: [
          'splunk show cluster-status --verbose   # on the manager: every peer Up, RF and SF met',
          '| rest /services/cluster/manager/peers splunk_server=local | table label, site, status, is_searchable, bucket_count',
          '| rest /services/cluster/manager/generation splunk_server=local | table replication_factor_met, search_factor_met   # VERIFY field names for your version',
          'splunk show cluster-bundle-status',
          '| rest /services/cluster/searchhead/generation splunk_server=local   # on a search head: sees the cluster',
        ],
        backout: [
          '# Per node: restore etc/system/local/server.conf from the .bak the script left, then restart splunkd.',
          'splunk rollback cluster-bundle   # on the manager: back to the previous bundle',
          'splunk disable maintenance-mode   # never leave it on',
        ],
        findings,
      };
    },
  });
}

// --- 3. search head cluster ---------------------------------------------------

function searchHeadCluster(): SplunkBlueprint {
  return splunkBlueprint({
    id: 'splunk_shc',
    tier: TIER,
    label: 'Search head cluster and deployer',
    group: 'Clustering',
    description: 'server.conf for each member and the deployer with the secret set from a file rather than on the command line, the captain bootstrap, and a deployer push script with the push mode and lookup handling decided rather than defaulted.',
    inputs: [
      { id: 'app_name', label: 'Package name', control: 'text', default: 'org_shc_config' },
      { id: 'members', label: 'Members', control: 'textarea', default: 'sh01.example.com\nsh02.example.com\nsh03.example.com', hint: 'One per line' },
      { id: 'deployer', label: 'Deployer', control: 'text', default: 'deployer01.example.com' },
      { id: 'label', label: 'Cluster label', control: 'text', default: 'shc1' },
      { id: 'rf', label: 'Replication factor (search artifacts)', control: 'number', default: 3, min: 1, max: 10 },
      { id: 'replication_port', label: 'Member replication port', control: 'number', default: 34567, min: 1024, max: 65535 },
      { id: 'cm_host', label: 'Indexer cluster manager', control: 'text', default: 'cm01.example.com', hint: 'Empty if the members search standalone indexers' },
      { id: 'push_mode', label: 'Deployer push mode', control: 'select', default: 'merge_to_default', options: [
        { value: 'merge_to_default', label: 'merge_to_default — local merged into default (the default)' },
        { value: 'full', label: 'full — default and local pushed as they are' },
        { value: 'local_only', label: 'local_only — only local, for apps installed on members already' },
        { value: 'default_only', label: 'default_only — only default' },
      ] },
      { id: 'preserve_lookups', label: 'Preserve lookups on push', control: 'toggle', default: true, hint: 'Keep lookup files the members have changed' },
    ],
    app: (values: BlueprintValues): SplunkApp => {
      const app = splunkName(str(values, 'app_name', 'org_shc_config'), 'org_shc_config');
      const members = listOf(str(values, 'members', '')).map((m) => m.replace(/^https?:\/\//, '').replace(/:\d+$/, ''));
      const deployerHost = str(values, 'deployer', 'deployer01.example.com').replace(/^https?:\/\//, '').replace(/:\d+$/, '');
      const deployer = uriOf(deployerHost);
      const label = splunkName(str(values, 'label', 'shc1'), 'shc1');
      const rf = num(values, 'rf', 3);
      const port = num(values, 'replication_port', 34567);
      const cmHost = str(values, 'cm_host', '');
      const pushMode = str(values, 'push_mode', 'merge_to_default');
      const preserve = bool(values, 'preserve_lookups', true);
      const findings: Finding[] = [];

      findings.push(warning('splunk.pass4symmkey-placeholder', 'The search head cluster pass4SymmKey is a placeholder. It must be the same on every member and the deployer, and should differ from the indexer cluster key.', { remediation: 'bin/set-pass4symmkey.sh --stanza shclustering --secret-file <mode-600 file> on each member and the deployer.', source: 'ArchToolKit' }));
      if (members.length < 3) findings.push(error('splunk.shc-too-small', `${members.length} member${members.length === 1 ? '' : 's'}: a search head cluster needs at least three to elect a captain.`, { source: 'Splunk Distributed Search Manual: SHC system requirements' }));
      if (members.length >= 3 && members.length % 2 === 0) findings.push(warning('splunk.shc-even', `${members.length} members: captain election needs a majority, so ${members.length} tolerates no more failures than ${members.length - 1}.`, { source: 'Splunk Distributed Search Manual: captain election' }));
      if (rf > members.length) findings.push(error('splunk.shc-rf-exceeds-members', `Replication factor ${rf} with ${members.length} members.`, { source: 'server.conf.spec [shclustering]' }));
      if (members.some((m) => m.toLowerCase() === deployerHost.toLowerCase())) findings.push(error('splunk.deployer-is-member', `${deployerHost} is both the deployer and a member. The deployer cannot be a cluster member.`, { source: 'Splunk Distributed Search Manual: deployer requirements' }));
      if (pushMode === 'full') findings.push(warning('splunk.push-mode-full', 'deployer_push_mode = full pushes local/ as local/ on the members, where it overrides anything users change through the UI on the next push — and removing a setting from the deployer no longer removes it from the members. Use it only for apps that are wholly owned by the deployer.', { source: 'app.conf.spec [shclustering] deployer_push_mode' }));
      if (!preserve) findings.push(warning('splunk.lookups-overwritten', 'Lookups are not preserved: every push overwrites lookup files the members have updated (with outputlookup, or users editing them) with the deployer’s copy.', { source: 'Splunk Distributed Search Manual: deployer push' }));

      const memberFiles: Record<string, string[]> = {};
      for (const m of members) {
        memberFiles[`server-conf/member-${splunkName(m, 'member')}.conf`] = [
          `# $SPLUNK_HOME/etc/system/local/server.conf on ${m}`,
          '# The same stanza "splunk init shcluster-config" writes, set here so the',
          '# secret never has to be passed with -secret on the command line.',
          '',
          '[shclustering]',
          'disabled = 0',
          `mgmt_uri = ${uriOf(m)}`,
          `# Members fetch the configuration bundle from the deployer here.`,
          `conf_deploy_fetch_url = ${deployer}`,
          `# Copies of each search artifact kept across members.`,
          `replication_factor = ${rf}`,
          `shcluster_label = ${label}`,
          'pass4SymmKey = <REQUIRED: set with bin/set-pass4symmkey.sh --stanza shclustering>',
          '',
          '# Member-to-member artifact replication. Any free port; the same on every',
          '# member, and different from the indexer replication port.',
          `[replication_port://${port}]`,
          ...(cmHost
            ? [
                '',
                '# Search the indexer cluster.',
                '[clustering]',
                'mode = searchhead',
                `manager_uri = ${uriOf(cmHost)}`,
                'pass4SymmKey = <REQUIRED: the indexer cluster key, set with --stanza clustering>',
              ]
            : []),
        ];
      }

      return {
        tier: TIER,
        title: `Search head cluster ${label}: ${members.length} members, deployer ${deployerHost}`,
        app,
        activation: 'restart',
        notes: [
          'Order: configure and set the key on the deployer; configure each member and restart it; then bootstrap the captain once, from any one member.',
          'Writing [shclustering] in server.conf is what "splunk init shcluster-config" does; doing it by file keeps the secret off the command line. VERIFY on your version that btool shows the same settings the CLI would have written.',
          'Bootstrap the captain once, on a fresh cluster only. After that the members elect their own captain; bootstrapping again is for recovering a cluster that has lost its majority.',
          `Deployer push mode: ${pushMode}. merge_to_default (the default) merges each app’s local/ into default/ on the members, so a user’s UI change on a member (in local/) still wins. It is set globally in the deployer’s etc/system/local/app.conf and can be overridden per app in etc/shcluster/apps/<app>/default/app.conf.`,
          preserve ? 'Pushes use -preserve-lookups true: lookup files members have changed are kept, and only new lookups are copied. A lookup you mean to replace needs a new name or deployer_lookups_push_mode = always_overwrite for that app.' : 'Pushes overwrite lookups.',
          'Apps for the members go in $SPLUNK_HOME/etc/shcluster/apps on the deployer — never installed directly on a member, which the next push would not know about.',
        ],
        before: [
          'splunk btool server list shclustering --debug',
          'splunk show shcluster-status --verbose   # if the cluster already exists',
          `nc -zv <member> ${port}   # member to member`,
          'nc -zv <member> 8191   # KV store, member to member',
          `nc -zv ${deployerHost} 8089   # from each member`,
        ],
        files: {
          ...memberFiles,
          'server-conf/deployer.conf': [
            `# $SPLUNK_HOME/etc/system/local/server.conf on ${deployerHost}`,
            '',
            '[shclustering]',
            'pass4SymmKey = <REQUIRED: set with bin/set-pass4symmkey.sh --stanza shclustering>',
            `shcluster_label = ${label}`,
          ],
          'server-conf/deployer-app.conf': [
            `# $SPLUNK_HOME/etc/system/local/app.conf on ${deployerHost}: the push mode for every app,`,
            '# unless an app overrides it in its own default/app.conf [shclustering].',
            '[shclustering]',
            `deployer_push_mode = ${pushMode}`,
            `# What happens to lookups an app ships: preserve_lookups honours the`,
            `# -preserve-lookups flag on each push.`,
            'deployer_lookups_push_mode = preserve_lookups',
          ],
          'bin/set-pass4symmkey.sh': setSecretScript('shclustering'),
          'bin/bootstrap-captain.sh': bashScript(
            'bootstrap-captain.sh',
            ['Bootstrap the first captain of a new search head cluster. Run once, on one member,', 'after every member has been configured and restarted.'],
            [{ flag: '--servers', variable: 'SERVERS', value: members.map((m) => uriOf(m)).join(','), help: 'Every member’s management URI, comma separated' }],
            sh`
              echo "== Members this bootstraps: $SERVERS"
              run "$SPLUNK" bootstrap shcluster-captain -servers_list "$SERVERS"
              if [[ $EXECUTE -eq 1 ]]; then "$SPLUNK" show shcluster-status --verbose; fi
            `,
          ),
          'bin/deployer-push.sh': bashScript(
            'deployer-push.sh',
            [
              'Push etc/shcluster/apps from the deployer to the search head cluster.',
              'The members restart in turn if the bundle needs it.',
            ],
            [{ flag: '--target', variable: 'TARGET', value: uriOf(members[0] ?? 'sh01.example.com'), help: 'Any one member’s management URI' }],
            sh`
              echo "== Apps that will be pushed:"
              ls -1 "$SPLUNK_HOME/etc/shcluster/apps"
              echo "== Current cluster state:"
              { "$SPLUNK" show shcluster-status --verbose | sed -n 1,30p; } || echo "  (could not read the cluster state; the push below reports its own errors)"
              run "$SPLUNK" apply shcluster-bundle -target "$TARGET" -preserve-lookups ${preserve ? 'true' : 'false'} --answer-yes
            `,
          ),
        },
        verify: [
          'splunk show shcluster-status --verbose   # a captain, every member Up',
          'splunk list shcluster-members',
          'splunk show kvstore-status   # on a member: KV store ready on every member',
          '| rest /services/shcluster/member/members splunk_server=local | table label, status, mgmt_uri',
          `| rest /services/shcluster/captain/info splunk_server=local | table label, elected_captain, dynamic_captain`,
        ],
        backout: [
          '# To take a member out: splunk remove shcluster-member (on that member), then clean it with splunk clean all only if it is being rebuilt.',
          '# To undo a push: restore the previous etc/shcluster/apps from backup on the deployer and push again.',
          '# To undo the member config: restore etc/system/local/server.conf from the .bak and restart.',
        ],
        findings,
      };
    },
  });
}

// --- 4. deployment server -----------------------------------------------------

interface ServerClass {
  readonly name: string;
  readonly whitelist: readonly string[];
  readonly os: 'windows' | 'linux' | 'any';
  readonly apps: readonly string[];
  readonly source: string;
}

const MACHINE_TYPES: Record<'windows' | 'linux', string> = {
  windows: 'windows-x64',
  linux: 'linux-x86_64',
};

function estateHosts(): { windows: string[]; linux: string[] } | null {
  const estate = currentEstate();
  const vms = estate?.inventory?.vms ?? [];
  if (vms.length === 0) return null;
  const windows = new Set<string>();
  const linux = new Set<string>();
  for (const vm of vms) {
    if (!isWorkload(vm)) continue;
    const os = `${vm.guestOs ?? ''} ${vm.guestOsTools ?? ''}`.toLowerCase();
    const name = (vm.dnsName || vm.name || '').trim().toLowerCase();
    if (!name) continue;
    if (/windows/.test(os)) windows.add(name);
    else if (/linux|red hat|rhel|centos|ubuntu|debian|suse|sles|oracle|photon|rocky|alma|amazon/.test(os)) linux.add(name);
  }
  return { windows: [...windows].sort(), linux: [...linux].sort() };
}

function deploymentServer(): SplunkBlueprint {
  return splunkBlueprint({
    id: 'splunk_deployment_server',
    tier: TIER,
    label: 'Deployment server classes',
    group: 'Forwarder management',
    description: 'serverclass.conf with classes by operating system, role and site — from the imported estate’s VMs when there is one — the apps mapped with a restart decision each, the deploymentclient app that points the forwarders at it, and a reload script.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_deployment_server' },
      { id: 'ds_host', label: 'Deployment server', control: 'text', default: 'ds01.example.com' },
      { id: 'windows_apps', label: 'Apps for every Windows forwarder', control: 'text', default: 'org_all_forwarder_outputs, Splunk_TA_windows' },
      { id: 'linux_apps', label: 'Apps for every Linux forwarder', control: 'text', default: 'org_all_forwarder_outputs, Splunk_TA_nix' },
      { id: 'use_estate', label: 'Use the imported estate’s VMs for the OS classes', control: 'toggle', default: true, hint: 'Explicit host lists instead of *; ignored with no estate loaded' },
      { id: 'classes', label: 'Role and site classes', control: 'textarea', default: 'web_linux | web*.example.com | linux | org_web_inputs\nsite_dc2 | *.dc2.example.com | any | org_dc2_outputs', hint: 'name | host patterns (comma separated) | windows, linux or any | apps' },
      { id: 'clients', label: 'Forwarders', control: 'number', default: 2000, min: 1, max: 500000 },
      { id: 'phone_home', label: 'Phone home every (seconds)', control: 'number', default: 600, min: 1, max: 86400 },
      { id: 'restart_on_change', label: 'Restart splunkd when an app changes', control: 'toggle', default: true, hint: 'Needed for inputs and outputs changes on a universal forwarder' },
    ],
    app: (values: BlueprintValues): SplunkApp => {
      const app = splunkName(str(values, 'app_name', 'org_deployment_server'), 'org_deployment_server');
      const ds = str(values, 'ds_host', 'ds01.example.com').replace(/^https?:\/\//, '');
      const target = ds.includes(':') ? ds : `${ds}:8089`;
      const clients = num(values, 'clients', 2000);
      const phoneHome = num(values, 'phone_home', 600);
      const restart = bool(values, 'restart_on_change', true);
      const estate = bool(values, 'use_estate', true) ? estateHosts() : null;
      const findings: Finding[] = [];

      const classes: ServerClass[] = [
        { name: 'all_windows', whitelist: estate && estate.windows.length > 0 ? estate.windows : ['*'], os: 'windows', apps: listOf(str(values, 'windows_apps', '')), source: estate ? `${estate.windows.length} Windows VMs in the imported estate` : 'every Windows forwarder' },
        { name: 'all_linux', whitelist: estate && estate.linux.length > 0 ? estate.linux : ['*'], os: 'linux', apps: listOf(str(values, 'linux_apps', '')), source: estate ? `${estate.linux.length} Linux VMs in the imported estate` : 'every Linux forwarder' },
      ];
      for (const line of String(values['classes'] ?? '').split('\n')) {
        if (!line.trim()) continue;
        const [name = '', patterns = '', os = 'any', apps = ''] = line.split('|').map((p) => p.trim());
        if (!name) continue;
        classes.push({ name: splunkName(name, 'class'), whitelist: listOf(patterns), os: os === 'windows' || os === 'linux' ? os : 'any', apps: listOf(apps), source: 'role/site class' });
      }

      const rate = clients / Math.max(1, phoneHome);
      if (rate > 10000 / 60) {
        findings.push(warning('splunk.phone-home-too-frequent', `${clients} forwarders phoning home every ${phoneHome}s is about ${Math.round(rate)} requests a second at the deployment server. Past roughly 10,000 clients at 60 seconds the server spends its time answering phone-homes and app downloads stall.`, { remediation: `Raise phoneHomeIntervalInSecs to at least ${Math.ceil(clients / (10000 / 60))}, or split the fleet across deployment servers.`, source: 'Splunk Updating Splunk Enterprise Instances manual: deployment server scale' }));
      }
      for (const c of classes) {
        if (c.whitelist.includes('*') && c.os === 'any') {
          findings.push(warning('splunk.serverclass-matches-all', `Server class ${c.name} matches every client (whitelist *, no machine type filter). That includes heavy forwarders, and any search head or indexer that is a deployment client — its apps land there too.`, { remediation: 'Narrow it with host patterns or machineTypesFilter.', source: 'serverclass.conf.spec' }));
        }
        if (c.whitelist.length === 0) findings.push(error('splunk.serverclass-empty', `Server class ${c.name} has no host pattern, so it matches nothing.`, { source: 'serverclass.conf.spec' }));
        if (c.apps.length === 0) findings.push(warning('splunk.serverclass-no-apps', `Server class ${c.name} maps no apps.`, { source: 'ArchToolKit' }));
      }
      if (estate === null && bool(values, 'use_estate', true)) {
        findings.push(info('splunk.no-estate', 'No estate is loaded, so the OS classes match every client of that operating system (whitelist * with machineTypesFilter). Import an RVTools export to generate explicit host lists.', { source: 'ArchToolKit' }));
      }

      const conf: string[] = [
        '# $SPLUNK_HOME/etc/system/local/serverclass.conf on the deployment server, or',
        '# in this app. Forwarder Management in Splunk Web writes to system/local and',
        '# cannot edit classes defined in an app — pick one place and keep it there.',
        '[global]',
        '# Where the apps to deploy live on this server.',
        'repositoryLocation = $SPLUNK_HOME/etc/deployment-apps',
        '# Restart the client only when an app actually changed.',
        `restartSplunkd = ${restart ? 'true' : 'false'}`,
        'stateOnClient = enabled',
        '',
      ];
      for (const c of classes) {
        conf.push(`# ${c.source}`, `[serverClass:${c.name}]`);
        c.whitelist.forEach((w, i) => conf.push(`whitelist.${i} = ${w}`));
        if (c.os !== 'any') {
          conf.push(`# Only ${c.os} clients, whatever their name.${c.os === 'linux' ? ' Add linux-aarch64 etc. for other architectures (VERIFY the string with splunk list deploy-clients).' : ''}`);
          conf.push(`machineTypesFilter = ${MACHINE_TYPES[c.os]}`);
        }
        conf.push('');
        for (const a of c.apps) {
          const appName = a.replace(/[^A-Za-z0-9_.-]/g, '_');
          conf.push(`[serverClass:${c.name}:app:${appName}]`, `restartSplunkd = ${restart ? 'true' : 'false'}`, 'stateOnClient = enabled', '');
        }
      }

      return {
        tier: TIER,
        title: `Deployment server ${ds}: ${classes.length} server classes`,
        app,
        activation: 'reload',
        notes: [
          'The apps named in each class must exist in $SPLUNK_HOME/etc/deployment-apps on the deployment server; a class that maps an app that is not there deploys nothing and logs a warning.',
          'Whitelists match the client’s host name, IP address, DNS name or clientName. Blacklists win over whitelists.',
          ...(estate ? [`OS classes use explicit host lists from the imported estate (${estate.windows.length} Windows, ${estate.linux.length} Linux, templates excluded). A VM whose forwarder reports a different host name will not match — check with splunk list deploy-clients.`] : []),
          `Forwarders get the deployment server from the ops/org_all_deploymentclient app, installed with the forwarder (it cannot be deployed by the server it points at). Phone home every ${phoneHome}s.`,
          restart ? 'restartSplunkd = true restarts a forwarder whenever one of its apps changes. For a large class, stage the change: move a few hosts into a canary class first.' : 'restartSplunkd = false: inputs and outputs changes on a universal forwarder will not take effect until something restarts it.',
          'Reload a single class after a change (bin/reload.sh --class <name>); a full reload re-evaluates every client.',
        ],
        before: [
          'splunk btool serverclass list --debug',
          'splunk list deploy-clients   # current clients and what they report as host and machine type',
          'ls $SPLUNK_HOME/etc/deployment-apps',
          '| rest /services/deployment/server/clients splunk_server=local | stats count by utsname',
        ],
        files: {
          'local/serverclass.conf': conf,
          'ops/org_all_deploymentclient/default/deploymentclient.conf': [
            '# Install on every forwarder with the package: $SPLUNK_HOME/etc/apps/org_all_deploymentclient',
            '[deployment-client]',
            `# How often to ask for changes. ${clients} clients at ${phoneHome}s ≈ ${rate.toFixed(1)} requests/s.`,
            `phoneHomeIntervalInSecs = ${phoneHome}`,
            '',
            '[target-broker:deploymentServer]',
            `targetUri = ${target}`,
          ],
          'ops/org_all_deploymentclient/default/app.conf': ['[install]', 'state = enabled', '', '[package]', 'id = org_all_deploymentclient', '', '[ui]', 'is_visible = 0', 'label = Deployment client'],
          'bin/reload.sh': bashScript(
            'reload.sh',
            ['Reload the deployment server after a serverclass or deployment-apps change.', 'With --class, only that class is re-evaluated.'],
            [{ flag: '--class', variable: 'CLASS', value: '', help: 'Server class to reload; empty for all' }],
            sh`
              "$SPLUNK" btool serverclass list --debug > /dev/null
              if [[ -n "$CLASS" ]]; then
                run "$SPLUNK" reload deploy-server -class "$CLASS"
              else
                run "$SPLUNK" reload deploy-server
              fi
            `,
          ),
        },
        verify: [
          'splunk list deploy-clients',
          '| rest /services/deployment/server/clients splunk_server=local | table hostname, ip, utsname, lastPhoneHomeTime, serverClasses',
          'index=_internal sourcetype=splunkd component=DeployedApplication | stats latest(_time) as last by host, app   # on the forwarders’ _internal',
          'splunk btool deploymentclient list --debug   # on a forwarder',
        ],
        backout: [
          '# Remove the class stanzas (or restore serverclass.conf from backup) and run bin/reload.sh.',
          '# With stateOnClient = enabled, an app removed from a class is uninstalled from its clients on their next phone home.',
          'splunk reload deploy-server',
        ],
        findings,
      };
    },
  });
}

// --- 5. license manager -------------------------------------------------------

interface Pool {
  readonly name: string;
  readonly stack: string;
  readonly quotaGb: number | 'MAX';
  readonly peers: string;
  readonly description: string;
}

function licenseManager(): SplunkBlueprint {
  return splunkBlueprint({
    id: 'splunk_license_manager',
    tier: TIER,
    label: 'License manager, pools and usage alerts',
    group: 'Licensing',
    description: 'The license manager and its peers, pools with a quota each so one noisy source cannot use everyone’s licence, and alerts for pool usage, license warnings and the sourcetypes using the most.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_license_alerts' },
      { id: 'lm_host', label: 'License manager', control: 'text', default: 'lm01.example.com' },
      { id: 'pools', label: 'Pools', control: 'textarea', default: 'prod | enterprise | 400 | <prod indexer GUIDs> | Production indexers\nnonprod | enterprise | 100 | <non-prod indexer GUIDs> | Non-production', hint: 'name | stack | quota GB or MAX | peer GUIDs or * | description' },
      { id: 'threshold', label: 'Alert at pool usage (%)', control: 'number', default: 80, min: 10, max: 100 },
      { id: 'email', label: 'Email alerts to', control: 'text', default: '', hint: 'Empty to list in Triggered Alerts only' },
    ],
    app: (values: BlueprintValues): SplunkApp => {
      const app = splunkName(str(values, 'app_name', 'org_license_alerts'), 'org_license_alerts');
      const lm = uriOf(str(values, 'lm_host', 'lm01.example.com'));
      const threshold = num(values, 'threshold', 80);
      const email = str(values, 'email', '');
      const findings: Finding[] = [];
      const pools: Pool[] = [];
      for (const line of String(values['pools'] ?? '').split('\n')) {
        if (!line.trim()) continue;
        const [name = '', stack = 'enterprise', quota = 'MAX', peers = '*', description = ''] = line.split('|').map((p) => p.trim());
        if (!name) continue;
        const q = quota.toUpperCase() === 'MAX' ? 'MAX' : Number(quota);
        pools.push({ name: splunkName(name, 'pool'), stack: stack || 'enterprise', quotaGb: q === 'MAX' || !Number.isFinite(q) ? 'MAX' : q, peers: peers || '*', description });
      }

      if (pools.length === 1 && pools[0]!.peers === '*' && pools[0]!.quotaGb === 'MAX') {
        findings.push(warning('splunk.single-pool-no-quota', 'Every peer is in one pool with no quota. That is Splunk’s default, and it means one runaway source — a debug log left on — can use the whole licence and put every other team into warning.', { remediation: 'Split peers into pools by environment or team, each with a quota.', source: 'Splunk Admin Manual: license pools' }));
      }
      if (pools.filter((p) => p.peers === '*').length > 1) {
        findings.push(error('splunk.pool-wildcard-twice', 'More than one pool claims every peer (*). A peer can belong to only one pool per stack.', { source: 'server.conf.spec [lmpool]' }));
      }
      if (pools.some((p) => p.peers.includes('<'))) {
        findings.push(info('splunk.pool-guids-placeholder', 'Pool peers are placeholders. Each peer’s GUID is in $SPLUNK_HOME/etc/instance.cfg on that peer, or | rest /services/licenser/peers on the license manager.', { source: 'ArchToolKit' }));
      }
      if (pools.length === 0) findings.push(error('splunk.no-pools', 'No pool was described.', { source: 'ArchToolKit' }));

      const alertCommon = (name: string, severity: number, suppressFields: string): string[] => [
        'enableSched = 1',
        `cron_schedule = ${spreadCron(name, 60)}`,
        'alert.track = 1',
        `alert.severity = ${severity}`,
        'counttype = number of events',
        'relation = greater than',
        'quantity = 0',
        'alert.suppress = 1',
        'alert.suppress.period = 4h',
        `alert.suppress.fields = ${suppressFields}`,
        'alert.digest_mode = 0',
        ...(email ? ['action.email = 1', `action.email.to = ${email}`, 'action.email.sendresults = 1'] : []),
      ];

      const usage = 'License - pool usage above threshold';
      const warnings = 'License - warnings in the rolling 30 days';
      const top = 'License - top sourcetypes by volume';

      return {
        tier: TIER,
        title: `License manager ${lm.replace(/^https:\/\//, '')}: ${pools.length} pool${pools.length === 1 ? '' : 's'}`,
        app,
        activation: 'restart',
        notes: [
          'The license manager must run a Splunk version equal to or newer than every peer.',
          'Every indexer (and any heavy forwarder that indexes) is a license peer. Every other node is also pointed at the license manager so it is licensed.',
          'Pools are usually easiest to create with Settings > Licensing or the /services/licenser/pools endpoint; ops/license-manager-pools.conf is the same thing as server.conf, for configuration management.',
          'server.conf quota is in bytes, or MAX for whatever is left in the stack.',
          'license_usage.log is written only on the license manager. The alerts in this app read it from _internal, so the license manager must forward its _internal to the indexers (best practice for every management node), and the app goes on a search head or the monitoring console that searches those indexers.',
          'A license warning is recorded for each day usage exceeds the stack quota. Enforcement rules differ by licence type and version — check the Admin Manual for yours.',
        ],
        before: [
          'splunk btool server list license --debug',
          '| rest /services/licenser/pools splunk_server=local | table title, stack_id, effective_quota, used_bytes, peers',
          '| rest /services/licenser/peers splunk_server=local | table title, label, active_pool_ids',
          '| rest /services/licenser/stacks splunk_server=local | table title, quota',
        ],
        files: {
          'ops/license-manager-server.conf': [
            `# $SPLUNK_HOME/etc/system/local/server.conf on the license manager`,
            '[license]',
            'manager_uri = self',
          ],
          'ops/license-peer-server.conf': [
            '# $SPLUNK_HOME/etc/system/local/server.conf on every other node',
            '[license]',
            `manager_uri = ${lm}`,
          ],
          'ops/license-manager-pools.conf': [
            '# Add to $SPLUNK_HOME/etc/system/local/server.conf on the license manager.',
            '# peers = * or a comma-separated list of peer GUIDs.',
            '',
            ...pools.flatMap((p) => [
              `[lmpool:${p.name}]`,
              ...(p.description ? [`description = ${p.description}`] : []),
              `stack_id = ${p.stack}`,
              `# ${p.quotaGb === 'MAX' ? 'Whatever the stack has left' : `${p.quotaGb} GB/day`}`,
              `quota = ${p.quotaGb === 'MAX' ? 'MAX' : Math.round(p.quotaGb * 1024 ** 3)}`,
              `peers = ${p.peers}`,
              '',
            ]),
          ],
          'default/savedsearches.conf': [
            `[${usage}]`,
            '# used_bytes and effective_quota come from the license manager itself.',
            '# splunk_server_group=dmc_group_license_master is the monitoring console’s',
            '# group for it; use splunk_server=local when this runs on the license manager.',
            ...foldSearch([
              '| rest splunk_server_group=dmc_group_license_master /services/licenser/pools',
              '| eval pct=round(used_bytes/effective_quota*100,1), used_GB=round(used_bytes/1024/1024/1024,2), quota_GB=round(effective_quota/1024/1024/1024,2)',
              `| where pct > ${threshold}`,
              '| table title, stack_id, used_GB, quota_GB, pct',
            ]),
            `description = A license pool is over ${threshold}% of its daily quota.`,
            'dispatch.earliest_time = -5m',
            'dispatch.latest_time = now',
            ...alertCommon(usage, 4, 'title'),
            '',
            `[${warnings}]`,
            '# RolloverSummary is written once a day per stack and pool: b is the',
            '# bytes used, stacksz the stack quota.',
            ...foldSearch([
              'index=_internal source=*license_usage.log* type=RolloverSummary',
              '| eval over=if(b > stacksz, 1, 0)',
              '| bin _time span=1d',
              '| stats max(over) as over by _time, stack',
              '| stats sum(over) as warning_days by stack',
              '| where warning_days > 0',
            ]),
            'description = Days in the last 30 on which a stack went over its quota.',
            'dispatch.earliest_time = -30d@d',
            'dispatch.latest_time = @d',
            ...alertCommon(warnings, 5, 'stack').map((l) => (l.startsWith('cron_schedule') ? `cron_schedule = ${spreadCron(warnings, 1440)}` : l.startsWith('alert.suppress.period') ? 'alert.suppress.period = 24h' : l)),
            '',
            `[${top}]`,
            '# A report, not an alert: yesterday’s licence use by sourcetype, index and pool.',
            ...foldSearch([
              'index=_internal source=*license_usage.log* type=Usage',
              '| stats sum(b) as bytes by st, idx, pool',
              '| eval GB=round(bytes/1024/1024/1024,2)',
              '| sort - GB',
              '| head 20',
              '| rename st as sourcetype, idx as index',
              '| fields sourcetype, index, pool, GB',
            ]),
            'description = The 20 sourcetypes that used the most licence yesterday.',
            'enableSched = 1',
            `cron_schedule = ${spreadCron(top, 1440)}`,
            'dispatch.earliest_time = -1d@d',
            'dispatch.latest_time = @d',
            'display.general.type = statistics',
          ],
          'metadata/default.meta': defaultMeta(['admin', 'sc_admin'], ['admin']),
        },
        verify: [
          '| rest /services/licenser/pools splunk_server=local | table title, stack_id, effective_quota, used_bytes, peers',
          '| rest /services/licenser/peers splunk_server=local | table label, active_pool_ids, warning_count',
          '| rest /services/licenser/messages splunk_server=local | table category, severity, description',
          `| savedsearch "${usage}"`,
          `index=_internal sourcetype=scheduler savedsearch_name="License - *" | table _time, savedsearch_name, status, result_count`,
        ],
        backout: [
          '# Pools: move peers back to the default pool in Settings > Licensing, then delete the new pools.',
          '# Peers: remove [license] manager_uri from server.conf and restart (the node then uses its own licence, if any).',
          `rm -rf $SPLUNK_HOME/etc/apps/${app}   # the alerts`,
        ],
        findings,
      };
    },
  });
}

// --- 6. monitoring console ----------------------------------------------------

interface HealthAlert {
  readonly title: string;
  readonly description: string;
  readonly pipeline: readonly string[];
  readonly every: number;
  readonly suppress: string;
  readonly severity: number;
  readonly earliest?: string;
}

function monitoringConsole(): SplunkBlueprint {
  return splunkBlueprint({
    id: 'splunk_monitoring_console',
    tier: TIER,
    label: 'Monitoring console and platform health alerts',
    group: 'Monitoring',
    description: 'The distributed monitoring console setup as a checklist, the built-in platform alerts to turn on, and an app of the health alerts the console does not ship — skipped searches, indexing latency, blocked queues, missing forwarders, licence, disk, bucket health and HEC errors — each throttled, with a dashboard.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_platform_health' },
      { id: 'email', label: 'Email alerts to', control: 'text', default: '', hint: 'Empty to list in Triggered Alerts only' },
      { id: 'skipped_pct', label: 'Skipped searches above (%)', control: 'number', default: 5, min: 1, max: 100 },
      { id: 'latency_s', label: 'Indexing latency above (seconds, p95)', control: 'number', default: 300, min: 10, max: 86400 },
      { id: 'latency_indexes', label: 'Indexes to measure latency on', control: 'text', default: 'os, wineventlog, network', hint: 'Keep it to a few busy indexes: this one reads raw events' },
      { id: 'missing_minutes', label: 'Forwarder missing after (minutes)', control: 'number', default: 60, min: 5, max: 10080 },
      { id: 'license_pct', label: 'License pool above (%)', control: 'number', default: 80, min: 10, max: 100 },
      { id: 'disk_free_pct', label: 'Disk free below (%)', control: 'number', default: 15, min: 1, max: 90 },
      { id: 'throttle', label: 'Throttle each alert for', control: 'select', default: '1h', options: [
        { value: '30m', label: '30 minutes' },
        { value: '1h', label: '1 hour' },
        { value: '4h', label: '4 hours' },
        { value: '24h', label: '24 hours' },
      ] },
    ],
    app: (values: BlueprintValues): SplunkApp => {
      const app = splunkName(str(values, 'app_name', 'org_platform_health'), 'org_platform_health');
      const email = str(values, 'email', '');
      const skipped = num(values, 'skipped_pct', 5);
      const latency = num(values, 'latency_s', 300);
      const latencyIndexes = listOf(str(values, 'latency_indexes', 'os'));
      const missing = num(values, 'missing_minutes', 60);
      const licensePct = num(values, 'license_pct', 80);
      const diskFree = num(values, 'disk_free_pct', 15);
      const throttle = str(values, 'throttle', '1h');
      const findings: Finding[] = [];

      if (latencyIndexes.length === 0 || latencyIndexes.includes('*')) {
        findings.push(warning('splunk.latency-all-indexes', 'Indexing latency measured across every index reads every raw event of the last 15 minutes, four times an hour. On a busy deployment that search is itself a cause of skipped searches.', { remediation: 'Name a few representative indexes.', source: 'ArchToolKit' }));
      }
      if (!email) findings.push(info('splunk.alerts-no-email', 'No email address: the alerts appear in Activity > Triggered Alerts only.', { source: 'ArchToolKit' }));

      const latencyFilter = latencyIndexes.filter((i) => i !== '*').map((i) => `index=${i}`);
      const alerts: HealthAlert[] = [
        {
          title: 'Platform health - Skipped searches ratio',
          description: `More than ${skipped}% of scheduled searches were skipped on a search head in the last hour.`,
          pipeline: [
            'index=_internal sourcetype=scheduler (status=success OR status=skipped OR status=continued)',
            '| stats count(eval(status="skipped")) as skipped, count as total by host',
            '| eval skipped_pct=round(skipped/total*100,1)',
            `| where skipped_pct > ${skipped}`,
          ],
          every: 60,
          earliest: '-60m@m',
          suppress: 'host',
          severity: 4,
        },
        {
          title: 'Platform health - Indexing latency',
          description: `95th percentile of _indextime - _time above ${latency}s for a sourcetype — data is arriving late, or its timestamps are wrong.`,
          pipeline: [
            `(${latencyFilter.length > 0 ? latencyFilter.join(' OR ') : 'index=main'}) earliest=-15m@m`,
            '| eval lag_s=_indextime-_time',
            '| stats perc95(lag_s) as p95_lag_s, max(lag_s) as max_lag_s, count by index, sourcetype',
            `| where p95_lag_s > ${latency}`,
          ],
          every: 15,
          suppress: 'index,sourcetype',
          severity: 3,
        },
        {
          title: 'Platform health - Blocked queues',
          description: 'A pipeline queue reported blocked repeatedly in the last 15 minutes. The first blocked queue in the chain (parsing, aggregation, typing, indexing) is the bottleneck.',
          pipeline: [
            'index=_internal source=*metrics.log* sourcetype=splunkd group=queue blocked=true',
            '| stats count as blocked_samples by host, name',
            '| where blocked_samples > 5',
          ],
          every: 15,
          suppress: 'host,name',
          severity: 4,
        },
        {
          title: 'Platform health - Missing forwarders',
          description: `A host in the expected_forwarders lookup has sent nothing for ${missing} minutes.`,
          pipeline: [
            '| inputlookup expected_forwarders',
            '| join type=left host [| tstats latest(_time) as last_seen where index=* earliest=-7d by host]',
            '| eval minutes_silent=round((now()-last_seen)/60)',
            `| where isnull(last_seen) OR minutes_silent > ${missing}`,
            '| table host, last_seen, minutes_silent',
          ],
          every: 30,
          suppress: 'host',
          severity: 4,
        },
        {
          title: 'Platform health - License pool usage',
          description: `A license pool is above ${licensePct}% of its daily quota.`,
          pipeline: [
            '| rest splunk_server_group=dmc_group_license_master /services/licenser/pools',
            '| eval pct=round(used_bytes/effective_quota*100,1)',
            `| where pct > ${licensePct}`,
            '| table title, stack_id, used_bytes, effective_quota, pct',
          ],
          every: 60,
          suppress: 'title',
          severity: 4,
        },
        {
          title: 'Platform health - Disk space',
          description: `A Splunk volume has less than ${diskFree}% free. Splunk stops indexing when a volume falls below minFreeSpace.`,
          pipeline: [
            '| rest splunk_server=* /services/server/status/partitions-space',
            '| eval free_mb=coalesce(free, available), pct_free=round(free_mb/capacity*100,1)',
            `| where pct_free < ${diskFree}`,
            '| table splunk_server, mount_point, capacity, free_mb, pct_free',
          ],
          every: 30,
          suppress: 'splunk_server,mount_point',
          severity: 5,
        },
        {
          title: 'Platform health - Indexer cluster bucket health',
          description: 'The indexer cluster does not meet its replication or search factor.',
          pipeline: [
            '| rest splunk_server_group=dmc_group_cluster_master /services/cluster/manager/generation',
            '| where replication_factor_met!="1" OR search_factor_met!="1"',
            '| table splunk_server, replication_factor_met, search_factor_met, generation_id',
          ],
          every: 15,
          suppress: 'splunk_server',
          severity: 5,
        },
        {
          title: 'Platform health - HEC errors',
          description: 'HTTP Event Collector rejected events in the last 15 minutes: bad tokens, disabled tokens, malformed JSON or an index the token may not write to.',
          pipeline: [
            'index=_internal sourcetype=splunkd component=HttpInputDataHandler (log_level=ERROR OR log_level=WARN)',
            '| rex "reply=(?<reply>\\d+)"',
            '| stats count as errors, values(reply) as reply_codes by host',
            '| where errors > 10',
          ],
          every: 15,
          suppress: 'host',
          severity: 3,
        },
      ];

      const saved: string[] = [];
      for (const a of alerts) {
        const window = searchWindow(a.every);
        saved.push(
          `[${a.title}]`,
          ...foldSearch(a.pipeline),
          `description = ${a.description}`,
          'enableSched = 1',
          `cron_schedule = ${spreadCron(a.title, a.every)}`,
          `dispatch.earliest_time = ${a.earliest ?? window.earliest}`,
          `dispatch.latest_time = ${window.latest}`,
          'schedule_window = auto',
          'counttype = number of events',
          'relation = greater than',
          'quantity = 0',
          'alert.track = 1',
          `alert.severity = ${a.severity}`,
          '# One alert per affected thing, then quiet for the throttle period.',
          'alert.digest_mode = 0',
          'alert.suppress = 1',
          `alert.suppress.period = ${throttle}`,
          `alert.suppress.fields = ${a.suppress}`,
          ...(email ? ['action.email = 1', `action.email.to = ${email}`, 'action.email.sendresults = 1', 'action.email.inline = 1'] : []),
          `request.ui_dispatch_app = ${app}`,
          '',
        );
      }

      const studio = JSON.stringify(
        {
          title: 'Platform health',
          description: 'The same searches as the alerts in this app, without the thresholds.',
          dataSources: Object.fromEntries(
            alerts.map((a, i) => [
              `ds_${i}`,
              {
                type: 'ds.search',
                name: a.title.replace('Platform health - ', ''),
                options: {
                  query: a.pipeline.filter((line) => !/^\| where /.test(line)).join('\n'),
                  queryParameters: { earliest: a.earliest ?? searchWindow(a.every).earliest, latest: 'now' },
                  refresh: '5m',
                  refreshType: 'delay',
                },
              },
            ]),
          ),
          visualizations: Object.fromEntries(
            alerts.map((a, i) => [
              `viz_${i}`,
              { type: 'splunk.table', title: a.title.replace('Platform health - ', ''), dataSources: { primary: `ds_${i}` }, options: { count: 10 } },
            ]),
          ),
          inputs: {},
          layout: {
            type: 'grid',
            options: { width: 1440 },
            structure: alerts.map((_, i) => ({ item: `viz_${i}`, type: 'block', position: { x: (i % 2) * 720, y: Math.floor(i / 2) * 300, w: 720, h: 300 } })),
            globalInputs: [],
          },
        },
        null,
        2,
      ).split('\n');

      const platformAlerts = [
        'DMC Alert - Abnormal State of Indexer Processor',
        'DMC Alert - Critical System Physical Memory Usage',
        'DMC Alert - Expired and Soon To Expire Licenses',
        'DMC Alert - Missing forwarders',
        'DMC Alert - Near Critical Disk Usage',
        'DMC Alert - Saturated Event-Processing Queues',
        'DMC Alert - Search Peer Not Responding',
        'DMC Alert - Total License Usage Near Daily Quota',
      ];

      return {
        tier: TIER,
        title: `Monitoring console: ${alerts.length} platform health alerts and a dashboard`,
        app,
        activation: 'reload',
        notes: [
          'Install on the monitoring console. Every search here is search-time: _internal, _introspection, tstats and REST.',
          'Set the monitoring console up first (MC-SETUP.md): the alerts use its server groups (dmc_group_license_master, dmc_group_cluster_master), which exist only after General Setup in distributed mode.',
          'Missing forwarders reads a lookup of hosts you expect. Seed it once from what is reporting now, then edit it: | tstats latest(_time) as last_seen where index=* earliest=-24h by host | fields host | outputlookup expected_forwarders',
          `Indexing latency reads raw events from ${latencyFilter.length > 0 ? latencyIndexes.join(', ') : 'main'} only — measuring every index this way is itself expensive.`,
          `Each alert fires once per affected host (or pool, or index) and is then suppressed for ${throttle}.`,
          'The console’s own platform alerts overlap some of these; turn those on too — they are listed in MC-SETUP.md.',
        ],
        before: [
          '| rest /services/search/distributed/peers splunk_server=local | table title, status, server_roles',
          '| rest /services/server/info splunk_server=local | table server_roles',
          `| rest /servicesNS/-/splunk_monitoring_console/saved/searches splunk_server=local | search title="DMC Alert*" | table title, disabled`,
          'index=_internal sourcetype=scheduler status=skipped earliest=-24h | stats count by savedsearch_name | sort - count',
        ],
        files: {
          'MC-SETUP.md': [
            '# Distributed monitoring console setup',
            '',
            '1. Use a dedicated instance, or the cluster manager/license manager in a small deployment — never a production search head cluster member.',
            '2. Point it at the license manager (server.conf [license] manager_uri) and forward its _internal to the indexers.',
            '3. Settings > Distributed search > Search peers: add every indexer, search head, cluster manager, deployer, deployment server, license manager and heavy forwarder. Indexer cluster peers can instead come from the cluster manager: make the MC a search head of the cluster (server.conf [clustering] mode = searchhead).',
            '4. Monitoring Console > Settings > General Setup: switch to Distributed mode, check every instance’s server roles (indexer, search head, cluster manager, license manager, KV store, deployment server, SHC deployer), set the indexer cluster labels and search head cluster labels, then Apply Changes.',
            '5. Monitoring Console > Settings > Forwarder Monitoring Setup: enable it, with a rebuild interval that suits the fleet size.',
            '6. Monitoring Console > Settings > Alerts Setup: enable the platform alerts and set their actions:',
            ...platformAlerts.map((a) => `   - ${a}`),
            '   (Names as shipped in the splunk_monitoring_console app — VERIFY against your version.)',
            '7. Install this app and seed the expected_forwarders lookup (see DEPLOY.md).',
            '8. After any topology change (a new peer, a new member) re-run General Setup and Apply Changes, or the new instance is not monitored.',
          ],
          'default/savedsearches.conf': saved,
          'default/transforms.conf': ['[expected_forwarders]', '# Seed from what reports now, then maintain it: one host per row, column "host".', 'filename = expected_forwarders.csv'],
          'default/data/ui/views/platform_health.xml': ['<dashboard version="2" theme="dark">', '  <label>Platform health</label>', '  <definition><![CDATA[', ...studio.map((l) => `  ${l}`), '  ]]></definition>', '</dashboard>'],
          'metadata/default.meta': defaultMeta(['admin', 'sc_admin'], ['admin']),
        },
        verify: [
          `| rest /servicesNS/-/${app}/saved/searches splunk_server=local | table title, cron_schedule, disabled, alert.suppress.period`,
          'index=_internal sourcetype=scheduler savedsearch_name="Platform health - *" | stats latest(status) as status, latest(result_count) as results by savedsearch_name',
          '| inputlookup expected_forwarders | stats count',
          `| rest /servicesNS/-/${app}/data/ui/views splunk_server=local | table title, eai:acl.sharing`,
        ],
        backout: [
          `rm -rf $SPLUNK_HOME/etc/apps/${app}`,
          '# or disable one alert: Settings > Searches, reports, and alerts > Edit > Disable',
          '# Platform alerts: Monitoring Console > Settings > Alerts Setup > Disable',
        ],
        findings,
      };
    },
  });
}

// --- 7. upgrade --------------------------------------------------------------

const VERSIONS = ['9.0', '9.1', '9.2', '9.3', '9.4', '10.0', '10.2', '10.4'] as const;

/**
 * Direct upgrade sources, per target, from Splunk's "How to upgrade Splunk
 * Enterprise" tables. 9.4, 10.0, 10.2 and 10.4 read from those pages; 9.2 and
 * 9.3 are marked VERIFY.
 */
const DIRECT_FROM: Readonly<Record<string, readonly string[]>> = {
  '9.2': ['8.2', '9.0', '9.1'], // VERIFY
  '9.3': ['9.0', '9.1', '9.2'], // VERIFY
  '9.4': ['9.1', '9.2', '9.3'],
  '10.0': ['9.2', '9.3', '9.4'],
  '10.2': ['9.4', '10.0'],
  '10.4': ['10.0', '10.2'],
};

function versionIndex(v: string): number {
  return VERSIONS.indexOf(v as (typeof VERSIONS)[number]);
}

/** The shortest supported path, taking the biggest supported jump each time. */
function upgradePath(from: string, to: string): string[] | null {
  const path = [from];
  let current = from;
  for (let guard = 0; guard < 10 && current !== to; guard++) {
    const candidates = VERSIONS.filter((v) => versionIndex(v) > versionIndex(current) && versionIndex(v) <= versionIndex(to) && (DIRECT_FROM[v] ?? []).includes(current));
    const next = candidates[candidates.length - 1];
    if (!next) return null;
    path.push(next);
    current = next;
  }
  return current === to ? path : null;
}

function upgrade(): SplunkBlueprint {
  return splunkBlueprint({
    id: 'splunk_upgrade',
    tier: TIER,
    label: 'Upgrade runbook',
    group: 'Lifecycle',
    description: 'An upgrade runbook to Splunk Enterprise 10.x for your topology: the supported path, prechecks (KV store server version and CPU, Python 3.13, Simple XML and jQuery, TLS 1.2+, service user, disk), the order — management nodes, search head cluster rolling upgrade, indexer rolling upgrade, KV store server upgrade, heavy then universal forwarders — and a script for each step, with --dry-run to preview.',
    inputs: [
      { id: 'app_name', label: 'Package name', control: 'text', default: 'org_upgrade_runbook' },
      { id: 'from', label: 'Current version', control: 'select', default: '9.4', options: VERSIONS.slice(0, -1).map((v) => ({ value: v, label: `${v}.x` })) },
      { id: 'to', label: 'Target version', control: 'select', default: '10.4', options: ['10.0', '10.2', '10.4'].map((v) => ({ value: v, label: `${v}.x` })) },
      { id: 'splunk_user', label: 'Service user', control: 'text', default: 'splunk', hint: 'The non-root account splunkd runs as; the scripts start it as this user' },
      { id: 'idx_cluster', label: 'Indexer cluster', control: 'toggle', default: true },
      { id: 'shc', label: 'Search head cluster', control: 'toggle', default: true },
      { id: 'heavy_forwarders', label: 'Heavy forwarders', control: 'toggle', default: true },
      { id: 'universal_forwarders', label: 'Universal forwarders', control: 'toggle', default: true },
      { id: 'package', label: 'Package format', control: 'select', default: 'tgz', options: [
        { value: 'tgz', label: '.tgz' },
        { value: 'rpm', label: '.rpm' },
        { value: 'deb', label: '.deb' },
      ] },
      { id: 'es', label: 'Enterprise Security or ITSI installed', control: 'toggle', default: false },
    ],
    app: (values: BlueprintValues): SplunkApp => {
      const app = splunkName(str(values, 'app_name', 'org_upgrade_runbook'), 'org_upgrade_runbook');
      const from = str(values, 'from', '9.4');
      const to = str(values, 'to', '10.4');
      const splunkUser = str(values, 'splunk_user', 'splunk').trim();
      const idx = bool(values, 'idx_cluster', true);
      const shc = bool(values, 'shc', true);
      const hf = bool(values, 'heavy_forwarders', true);
      const uf = bool(values, 'universal_forwarders', true);
      const pkg = str(values, 'package', 'tgz');
      const premium = bool(values, 'es', false);
      const findings: Finding[] = [];

      const path = versionIndex(from) >= versionIndex(to) ? null : upgradePath(from, to);
      if (versionIndex(from) >= versionIndex(to)) {
        findings.push(error('splunk.upgrade-not-forward', `${from} to ${to} is not an upgrade. Splunk does not support downgrades; going back means restoring from backup.`, { source: 'Splunk Installation Manual' }));
      } else if (!path) {
        findings.push(error('splunk.upgrade-no-path', `No supported path from ${from} to ${to} in the table this runbook knows. Check "How to upgrade Splunk Enterprise" for ${to}.`, { source: 'Splunk Installation Manual: supported upgrade paths' }));
      } else if (path.length > 2) {
        findings.push(warning('splunk.upgrade-multi-hop', `${from} cannot go directly to ${to}; the supported path is ${path.join(' → ')}. Each hop is a full upgrade of every tier — let each one settle (KV store migrated, cluster healthy) before starting the next.`, { source: 'Splunk Installation Manual: supported upgrade paths (VERIFY for your exact maintenance releases)' }));
      }
      if (path?.some((v) => v === '9.2' || v === '9.3')) {
        findings.push(info('splunk.upgrade-path-verify', 'The path goes through 9.2 or 9.3, whose supported sources are not confirmed in this runbook’s table. VERIFY against that version’s upgrade documentation.', { source: 'ArchToolKit' }));
      }
      if (!/^[a-z_][a-z0-9_-]*$/.test(splunkUser) || splunkUser === 'root') {
        findings.push(error('splunk.upgrade-service-user', `"${splunkUser || '(empty)'}" cannot be the service user: splunkd must run as a non-root account, and Splunk 10 refuses to start as root without --run-as-root.`, { remediation: 'Name the account splunkd runs as today, or create one (splunk) and chown $SPLUNK_HOME to it before the upgrade.', source: 'Splunk Enterprise 10 release notes' }));
      }
      if (premium) {
        findings.push(warning('splunk.upgrade-premium-compat', 'Enterprise Security and ITSI support specific Splunk Enterprise versions. Check the premium app’s compatibility matrix for the target before upgrading the platform — it may need upgrading first, or a newer platform may not be supported yet.', { source: 'Splunk products version compatibility matrix' }));
      }
      const to102 = versionIndex(to) >= versionIndex('10.2');
      const to104 = versionIndex(to) >= versionIndex('10.4');

      const hops = path ?? [from, to];
      const steps: string[] = [
        `# Splunk Enterprise upgrade runbook: ${from} → ${to}`,
        '',
        `Supported path: **${hops.join(' → ')}**${path ? '' : ' (not supported — see findings)'}. Repeat the whole runbook for each hop.`,
        '',
        'Always follow the upgrade instructions for the version you are going *to*. Read its "About upgrading — READ THIS FIRST" and release notes.',
        '',
        '## 0. Prechecks (every node) — bin/00-precheck.sh',
        '',
        '- Back up: bin/backup-before-upgrade (or the splunk_backup package): $SPLUNK_HOME/etc and the KV store on every search head.',
        '- App compatibility: install the Splunk Platform Upgrade Readiness App (Splunkbase 5483) on a search head and clear its findings (Python 3 and jQuery 3.5). From 10.4, Splunk also validates configuration against its schemas at startup. Check every Splunkbase add-on’s supported versions.',
        `- Python: 10.0 removed Python 2.7 and 3.7 and runs 3.9 only; ${to104 ? '10.4 adds Python 3.13 and deprecates 3.9. Apps should declare python.required = 3.9, 3.13 (read from 10.2) and ship no compiled binary modules; an app that pins python.version = python2 or python3.7 must be updated first.' : 'an app that pins python.version = python2 or python3.7 must be updated first.'}`,
        `- Dashboards: ${to104 ? 'Simple XML dashboards at version="1.0" (jQuery 2) and HTML dashboards do not load on 10.4.' : 'Simple XML version="1.0" (jQuery 2) and HTML dashboards are removed in 10.4.'} Rebuild them in Dashboard Studio, or move Simple XML to version="1.1" and test it; bin/00-precheck.sh lists them.`,
        '- KV store storage engine: must be wiredTiger (splunk show kvstore-status --verbose). Migrate an old mmapv1 store first: splunk migrate kvstore-storage-engine --target-engine wiredTiger (VERIFY for your version).',
        `- KV store server version: 9.4 moves the server to 7.0 on upgrade; 10.2 and later move it to 8.0 (MongoDB 8).${to104 ? ' Version 4.2 is removed in 10.4, so every KV store must already be at 7.0 or later before upgrading to 10.4 — see step 4.' : ''}`,
        `- KV store CPU and OS: ${to102 ? 'KV store 8.0 needs AVX, SSE4.2 and AES-NI on x86_64 and glibc 2.27 or later.' : 'KV store 7.0 needs AVX on x86_64.'} bin/00-precheck.sh checks /proc/cpuinfo and glibc on each node.`,
        `- Service user: splunkd runs as ${splunkUser}, never root. Splunk 10 refuses to start as root on Linux without --run-as-root, which this runbook does not use; if splunkd runs as root today, chown $SPLUNK_HOME to ${splunkUser} and move it first. On Windows, 10.2 no longer runs as Local System or Administrator.`,
        ...(to102 ? ['- 10.2 clusters need their Postgres ports open between members (VERIFY which ports in the 10.2 release notes).'] : []),
        `- TLS: ${to104 ? '10.4 removes TLS 1.0 and 1.1 and rejects SHA-1 signed certificates.' : '10.4 will remove TLS 1.0 and 1.1 and reject SHA-1 signed certificates; fix them now.'} sslVersions must be tls1.2 (tls1.3 is accepted from 10.4); check cipherSuite and certificate expiry (splunk btool server list sslConfig; openssl x509 -enddate).`,
        '- Removed in 10.x: hybrid search (use Federated Search), Hadoop Data Roll, the populate_lookup alert action (use the lookup action), some Search API v1 endpoints (use v2), Node.js. Read the release notes’ "Deprecated and removed" list for every version in the path.',
        '- Disk: at least the size of the new package plus $SPLUNK_HOME/etc free; ext2 file systems must be moved to ext3 or later first.',
        '- Premium apps: confirm ES/ITSI compatibility with the target.',
        '',
        '## 1. Management nodes — bin/10-upgrade-node.sh on each',
        '',
        '1. License manager (it must be at least as new as its peers).',
        ...(idx ? ['2. Cluster manager. Run splunk show cluster-status --verbose first — it must be healthy.'] : []),
        '3. Monitoring console.',
        '4. Deployment server (it must be at least as new as its clients).',
        '',
      ];
      if (shc) {
        steps.push(
          '## 2. Search head cluster — rolling upgrade (bin/30-search-head-cluster.sh)',
          '',
          '1. On any member: `bash bin/30-search-head-cluster.sh --phase init` (splunk upgrade-init shcluster-members).',
          '2. For each member, **the captain last** (the first upgraded member becomes captain when it restarts):',
          '   - `--phase detain` (manual detention on; wait until it has no active searches)',
          '   - `bash bin/10-upgrade-node.sh --package <file>`',
          '   - `--phase release` (manual detention off), then check `splunk show shcluster-status --verbose`.',
          '3. `--phase finalize` (splunk upgrade-finalize shcluster-members).',
          '4. Upgrade the deployer immediately afterwards: it must run the same version as the members.',
          '',
        );
      } else {
        steps.push('## 2. Search heads', '', 'Upgrade each standalone search head with bin/10-upgrade-node.sh.', '');
      }
      if (idx) {
        steps.push(
          '## 3. Indexer cluster peers — rolling upgrade (bin/20-indexer-cluster.sh)',
          '',
          '1. On the cluster manager: `--phase init` (splunk upgrade-init cluster-peers; puts the cluster in maintenance mode for the upgrade).',
          '2. For each peer, one at a time (in a multisite cluster, a site at a time):',
          '   - on the peer: `--phase offline` (splunk offline: finishes in-flight searches and hands off primaries)',
          '   - `bash bin/10-upgrade-node.sh --package <file>` (upgrades and starts it)',
          '   - on the manager: `--phase status` until the peer is Up and the cluster is searchable.',
          '3. On the manager: `--phase finalize` (splunk upgrade-finalize cluster-peers).',
          '4. No bundle pushes, rolling restarts or peer additions until finalized.',
          '',
        );
      } else {
        steps.push('## 3. Indexers', '', 'Upgrade each indexer with bin/10-upgrade-node.sh. Forwarders buffer while one is down if they load-balance across several.', '');
      }
      steps.push(
        '## 4. KV store server upgrade (bin/40-kvstore-upgrade.sh)',
        '',
        `Once every search head of a hop is on the new version, the KV store server has to follow it: 9.4 moves it to 7.0 and 10.2 and later to 8.0, on startup by default.${to104 ? ' 10.4 no longer ships 4.2: a KV store still on 4.2 must reach 7.0 or later on 9.4, 10.0 or 10.2 before the hop to 10.4.' : ''}`,
        '',
        `1. Check: \`bash bin/40-kvstore-upgrade.sh --phase status\` (splunk show kvstore-status --verbose). Expect serverVersion ${to102 ? '8.0' : '7.0'} and status ready.`,
        `2. If it has not moved on its own, preview with \`--phase check\` (Splunk’s own dry run: ${shc ? 'splunk start-shcluster-upgrade kvstore -isDryRun true' : 'splunk start-standalone-upgrade kvstore -dryRun true'}), then \`--phase upgrade\`.`,
        `3. Follow it with \`--phase progress\` (${shc ? 'splunk show shcluster-kvupgrade-status' : 'splunk show standalone-kvupgrade-status'}) until it completes${shc ? '; `--phase stop` (splunk stop-shcluster-upgrade kvstore) halts a cluster upgrade that is going wrong' : ''}.`,
        '4. To control the timing yourself, set server.conf [kvstore] kvstoreUpgradeOnStartupEnabled = false on the search heads before the binary upgrade, and run this step in its own window.',
        '',
      );
      if (hf) steps.push('## 5. Heavy forwarders', '', 'One at a time, with bin/10-upgrade-node.sh. A heavy forwarder must not be newer than the indexers it sends to.', '');
      if (uf) steps.push('## 6. Universal forwarders', '', 'Last. With the package manager or your configuration management — the deployment server cannot upgrade the forwarder binary. Forwarders may run older versions than the indexers (check the forwarder compatibility matrix); they must not be newer.', '');
      steps.push('## Rollback', '', 'Splunk does not downgrade in place. Stop splunkd, restore $SPLUNK_HOME (binaries and etc) and the KV store from the pre-upgrade backup, and start the old version. A cluster that has been finalized on the new version cannot rejoin old peers.');

      const needKv8 = to102 ? 1 : 0;
      const at104 = to104 ? 1 : 0;
      const installCmd =
        pkg === 'rpm'
          ? 'run rpm -U --replacepkgs "$PACKAGE"'
          : pkg === 'deb'
            ? 'run dpkg -i "$PACKAGE"'
            : 'run tar -xzf "$PACKAGE" -C "$(dirname "$SPLUNK_HOME")"';

      return {
        tier: TIER,
        title: `Upgrade runbook: Splunk ${from} → ${to}${path && path.length > 2 ? ` via ${path.slice(1, -1).join(', ')}` : ''}`,
        app,
        activation: 'restart',
        notes: [
          `Supported path: ${hops.join(' → ')}. Read from Splunk’s upgrade path tables for 9.4, 10.0, 10.2 and 10.4; recheck them for your exact maintenance release.`,
          'Order: license manager, cluster manager, monitoring console and deployment server; then search heads (rolling, captain last, then the deployer); then indexer peers (rolling); then the KV store server; then heavy forwarders; then universal forwarders.',
          `Every script applies when run; add --dry-run first to preview the commands it would run. bin/10-upgrade-node.sh may run as root for the package install; it hands $SPLUNK_HOME to ${splunkUser} and starts splunkd as ${splunkUser}. Nothing here uses --run-as-root.`,
          'Back up $SPLUNK_HOME/etc and the KV store before anything else — rollback is a restore, not a downgrade.',
        ],
        before: [
          'splunk version',
          'splunk show kvstore-status --verbose',
          'splunk show cluster-status --verbose   # on the cluster manager',
          'splunk show shcluster-status --verbose   # on a member',
          '| rest /services/server/info splunk_server=* | table splunk_server, version, os_name, server_roles',
          '| rest /services/kvstore/status splunk_server=* | table splunk_server, current.storageEngine, current.serverVersion   # VERIFY field names',
          '| rest /servicesNS/-/-/data/ui/views splunk_server=local count=0 | search eai:data="*version=\\"1.0\\"*" OR eai:type=html | table title, eai:acl.app, eai:type   # dashboards 10.4 will not load (VERIFY the eai:type value for HTML dashboards)',
        ],
        files: {
          'RUNBOOK.md': steps,
          'bin/00-precheck.sh': bashScript(
            '00-precheck.sh',
            [
              'Read-only checks before upgrading this node. Changes nothing, with or without --dry-run.',
              'Every section runs even when one finds nothing; the exit code is the verdict:',
              '0 = no blocking problem found, 1 = at least one PROBLEM line to fix first.',
            ],
            [{ flag: '--min-free-gb', variable: 'MIN_FREE_GB', value: '5', help: 'Free space needed on the $SPLUNK_HOME file system' }],
            sh`
              # Diagnostic pipelines end in "|| true" or sit inside { ...; } || true: under
              # set -euo pipefail a grep that matches nothing would otherwise stop the
              # script at that section. Only problem() decides the exit code.
              problems=0
              problem() { echo "  PROBLEM: $*"; problems=$((problems + 1)); }

              echo "== Version"
              if [[ -x "$SPLUNK" ]]; then "$SPLUNK" version || problem "$SPLUNK version failed"; else problem "$SPLUNK not found or not executable (set SPLUNK_HOME)"; fi

              echo "== Running as"
              pid=$( { head -1 "$SPLUNK_HOME/var/run/splunk/splunkd.pid"; } 2>/dev/null || true)
              if [[ -n "$pid" ]]; then
                owner=$(ps -o user= -p "$pid" 2>/dev/null | tr -d ' ' || true)
                if [[ -z "$owner" ]]; then echo "  splunkd not running (stale pid file)"
                elif [[ "$owner" == root ]]; then problem "splunkd runs as root. Splunk 10 will not start as root without --run-as-root: chown -R ${splunkUser} $SPLUNK_HOME and run it as ${splunkUser} first"
                else echo "  $owner"; fi
              else
                echo "  splunkd not running"
              fi
              home_owner=$(stat -c %U "$SPLUNK_HOME" 2>/dev/null || true)
              [[ -z "$home_owner" || "$home_owner" == ${quoteSh(splunkUser)} ]] || problem "$SPLUNK_HOME is owned by $home_owner, not ${splunkUser}"

              echo "== Disk"
              { df -h "$SPLUNK_HOME" | tail -1; } || true
              avail_kb=$( { df -Pk "$SPLUNK_HOME" | awk 'NR == 2 { print $4 }'; } 2>/dev/null || true)
              if [[ "$avail_kb" =~ ^[0-9]+$ ]]; then
                (( avail_kb >= MIN_FREE_GB * 1024 * 1024 )) || problem "only $((avail_kb / 1024 / 1024)) GB free on the $SPLUNK_HOME file system; need at least $MIN_FREE_GB GB for the etc backup and the new version"
              else
                problem "could not read free space for $SPLUNK_HOME"
              fi

              echo "== File system type"
              { df -T "$SPLUNK_HOME" | tail -1 | awk '{print "  " $2}'; } 2>/dev/null || echo "  unknown"

              # The KV store server Splunk 10.0 runs is MongoDB 7 (AVX on x86_64);
              # 10.2 and later move it to MongoDB 8, which also needs SSE4.2, AES-NI
              # and glibc 2.27 or later.
              echo "== CPU flags for the KV store server"
              arch=$(uname -m)
              for f in avx sse4_2 aes; do
                if grep -qw "$f" /proc/cpuinfo 2>/dev/null; then echo "  $f: yes"
                elif [[ "$arch" == x86_64 && ( "$f" == avx || ${needKv8} -eq 1 ) ]]; then problem "CPU has no $f: the KV store server in the target version will not start on this host"
                else echo "  $f: missing ($arch)"; fi
              done
              if [[ ${needKv8} -eq 1 ]]; then
                glibc=$( { ldd --version 2>/dev/null | head -1 | grep -Eo '[0-9]+\.[0-9]+$'; } || true)
                if [[ -z "$glibc" ]]; then echo "  glibc: unknown"
                elif [[ "$(printf '%s\n2.27\n' "$glibc" | sort -V | head -1)" != 2.27 ]]; then problem "glibc $glibc: KV store 8.0 needs 2.27 or later"
                else echo "  glibc: $glibc"; fi
              fi

              echo "== KV store"
              kv=$("$SPLUNK" show kvstore-status --verbose 2>/dev/null || true)
              if [[ -z "$kv" ]]; then
                echo "  (no KV store on this node, or not logged in: run splunk login first)"
              else
                { printf '%s\n' "$kv" | grep -Ei "storageEngine|serverVersion|status"; } || true
                if printf '%s\n' "$kv" | grep -Eqi '^[[:space:]]*status[[:space:]]*:[[:space:]]*failed'; then problem "KV store status is failed; fix it before upgrading"; fi
                if printf '%s\n' "$kv" | grep -Eqi 'mmapv1'; then problem "KV store storage engine is mmapv1; migrate to wiredTiger first"; fi
                kvver=$( { printf '%s\n' "$kv" | grep -Ei 'serverVersion' | head -1 | grep -Eo '[0-9]+\.[0-9]+'; } || true)
                if [[ ${at104} -eq 1 && -n "$kvver" && "$(printf '%s\n7.0\n' "$kvver" | sort -V | head -1)" != 7.0 ]]; then
                  problem "KV store server $kvver: 10.4 removes 4.2. Upgrade it to 7.0 or later on the current version first (bin/40-kvstore-upgrade.sh)"
                fi
              fi

              echo "== Python versions declared by apps"
              pinned=$( { grep -HsE "^python\.(version|required)" "$SPLUNK_HOME"/etc/apps/*/default/*.conf "$SPLUNK_HOME"/etc/apps/*/local/*.conf || true; } | sed "s#^$SPLUNK_HOME/etc/apps/##" | sort)
              if [[ -n "$pinned" ]]; then printf '%s\n' "$pinned" | awk -F: '{ print "  " $0 }' | sed -n 1,20p; else echo "  none declared"; fi
              old=$( { printf '%s\n' "$pinned" | grep -E "python\.version[[:space:]]*=[[:space:]]*(python2|python3\.7|default)" || true; } | cut -d/ -f1 | sort -u)
              [[ -z "$old" ]] || problem "apps pinned to Python 2 or 3.7, which 10.x removed: $(printf '%s ' $old)"
              binmods=$( { find "$SPLUNK_HOME"/etc/apps -name "*.so" -path "*/bin/*" 2>/dev/null || true; } | sed "s#^$SPLUNK_HOME/etc/apps/##" | cut -d/ -f1 | sort -u)
              [[ -z "$binmods" ]] || echo "  compiled Python modules (rebuild for 3.13 or remove): $(printf '%s ' $binmods)"

              echo "== Dashboards 10.4 will not load (Simple XML 1.0 / jQuery 2, HTML)"
              legacy=$( { grep -lsE '<(dashboard|form)[^>]*version="1\.0"' "$SPLUNK_HOME"/etc/apps/*/default/data/ui/views/*.xml "$SPLUNK_HOME"/etc/apps/*/local/data/ui/views/*.xml "$SPLUNK_HOME"/etc/users/*/*/local/data/ui/views/*.xml || true; } | sed "s#^$SPLUNK_HOME/etc/##")
              html=$( { ls -1 "$SPLUNK_HOME"/etc/apps/*/*/data/ui/html/*.html 2>/dev/null || true; } | sed "s#^$SPLUNK_HOME/etc/##")
              if [[ -n "$legacy$html" ]]; then
                printf '%s\n' $legacy $html | sed -n 1,30p | awk '{ print "  " $0 }'
                if [[ ${at104} -eq 1 ]]; then problem "Simple XML version 1.0 or HTML dashboards found: rebuild them in Dashboard Studio (or move Simple XML to version 1.1) before 10.4"; fi
              else
                echo "  none found (VERIFY with the Upgrade Readiness App: dashboards with no version attribute are not listed here)"
              fi

              echo "== TLS settings"
              ssl=$("$SPLUNK" btool server list sslConfig 2>/dev/null || true)
              { printf '%s\n' "$ssl" | grep -E "sslVersions|cipherSuite|serverCert"; } || echo "  (no sslConfig read)"
              if [[ ${at104} -eq 1 ]]; then
                weak=$( { "$SPLUNK" btool server list 2>/dev/null; "$SPLUNK" btool outputs list 2>/dev/null; "$SPLUNK" btool inputs list 2>/dev/null; "$SPLUNK" btool web list 2>/dev/null; } | grep -E "^sslVersions[[:space:]]*=" | grep -Ei "tls1\.0|tls1\.1|ssl3|\*" || true)
                [[ -z "$weak" ]] || problem "sslVersions still allows TLS 1.0/1.1, which 10.4 removes: $(printf '%s' "$weak" | sort -u | tr '\n' ';')"
              fi
              cert=$(printf '%s\n' "$ssl" | awk -F' = ' '/^serverCert/ { print $2; exit }')
              cert="$\{cert//\$SPLUNK_HOME/$SPLUNK_HOME}"
              if [[ -n "$cert" && -f "$cert" ]]; then
                openssl x509 -noout -enddate -in "$cert" || problem "cannot read $cert"
                if ! openssl x509 -noout -checkend 0 -in "$cert" >/dev/null 2>&1; then problem "server certificate $cert has expired"
                elif ! openssl x509 -noout -checkend $((30 * 86400)) -in "$cert" >/dev/null 2>&1; then echo "  warning: $cert expires within 30 days"; fi
                if [[ ${at104} -eq 1 ]] && openssl x509 -noout -text -in "$cert" 2>/dev/null | grep -qi "Signature Algorithm: sha1"; then problem "server certificate $cert is SHA-1 signed; 10.4 rejects it"; fi
              else
                echo "  server certificate: default or not found"
              fi

              echo "== Clustering role"
              { "$SPLUNK" btool server list clustering 2>/dev/null | grep -E "^mode"; } || echo "  not clustered"
              echo "== Search head clustering"
              { "$SPLUNK" btool server list shclustering 2>/dev/null | grep -E "^disabled"; } || echo "  no shclustering stanza"

              echo
              if [[ $problems -gt 0 ]]; then
                echo "Precheck: $problems PROBLEM(s) above. Fix them before upgrading this node."
                exit 1
              fi
              echo "Precheck: no blocking problem found. Read the sections above as well."
            `,
          ),
          'bin/10-upgrade-node.sh': bashScript(
            '10-upgrade-node.sh',
            [
              `Upgrade this node in place from a ${pkg} package: stop, back up etc, install, start.`,
              'In a cluster, run it only at the point the runbook says (after offline or detention).',
              `Run as root only for the package install: splunkd itself is stopped and started`,
              `as the service user, and $SPLUNK_HOME is handed back to it. No --run-as-root.`,
            ],
            [
              { flag: '--package', variable: 'PACKAGE', value: '', help: `The Splunk ${to} .${pkg} package on this host` },
              { flag: '--user', variable: 'SPLUNK_USER', value: splunkUser, help: 'The non-root account splunkd runs as' },
              { flag: '--backup-dir', variable: 'BACKUP_DIR', value: '/var/tmp/splunk-upgrade', help: 'Where the etc backup goes' },
              { flag: '--no-stop', variable: 'NO_STOP', help: 'splunkd is already stopped (for example after splunk offline)' },
            ],
            sh`
              [[ -n "$PACKAGE" && -f "$PACKAGE" ]] || { echo "--package must name the downloaded package" >&2; exit 2; }
              [[ "$SPLUNK_USER" != root ]] || { echo "--user must not be root: Splunk 10 does not run as root" >&2; exit 2; }
              id "$SPLUNK_USER" >/dev/null || { echo "No such user: $SPLUNK_USER" >&2; exit 2; }
              # splunkd commands run as the service user, whoever runs this script.
              as_splunk() { if [[ $EUID -eq 0 ]]; then sudo -u "$SPLUNK_USER" -- "$@"; else "$@"; fi; }
              if [[ $EUID -ne 0 && "$(id -un)" != "$SPLUNK_USER" ]]; then echo "Run as root (for the package) or as $SPLUNK_USER." >&2; exit 2; fi
              echo "== Checksum of the package (compare with the one on splunk.com):"
              sha512sum "$PACKAGE"
              ${pkg === 'tgz' ? sh`
              # The tarball is unpacked into the parent of SPLUNK_HOME, so its single
              # top-level directory must be SPLUNK_HOME's own name (splunk for Splunk
              # Enterprise). Anything else would land beside the install, not over it.
              want=$(basename "$SPLUNK_HOME")
              top=$(tar -tzf "$PACKAGE" | awk -F/ '{ sub(/^\.\//, "") } $1 != "" && $1 != "." { print $1 }' | sort -u)
              if [[ "$top" != "$want" ]]; then
                echo "Refusing: $PACKAGE unpacks to '$(printf '%s' "$top" | tr '\n' ' ')' but SPLUNK_HOME is $SPLUNK_HOME (needs '$want')." >&2
                echo "Extract it by hand, or run with SPLUNK_HOME set to the directory it should replace." >&2
                exit 2
              fi
              echo "== Package unpacks to $want/ under $(dirname "$SPLUNK_HOME")"`.join(`\n${' '.repeat(14)}`) : ''}
              stamp=$(date +%Y%m%d%H%M%S)
              run mkdir -p "$BACKUP_DIR"
              if [[ $NO_STOP -eq 0 ]]; then run as_splunk "$SPLUNK" stop; fi
              run tar -czf "$BACKUP_DIR/etc-$(hostname -s)-$stamp.tgz" -C "$SPLUNK_HOME" etc
              ${installCmd}
              if [[ $EUID -eq 0 ]]; then run chown -R "$SPLUNK_USER:" "$SPLUNK_HOME"; fi
              run as_splunk "$SPLUNK" start --accept-license --answer-yes --no-prompt
              if [[ $EXECUTE -eq 1 ]]; then "$SPLUNK" version; fi
            `,
          ),
          ...(idx
            ? {
                'bin/20-indexer-cluster.sh': bashScript(
                  '20-indexer-cluster.sh',
                  ['Rolling upgrade of indexer cluster peers. init, status and finalize run on the', 'cluster manager; offline runs on the peer about to be upgraded.'],
                  [{ flag: '--phase', variable: 'PHASE', value: 'status', help: 'init, offline, status or finalize' }],
                  sh`
                    case "$PHASE" in
                      init)
                        "$SPLUNK" show cluster-status --verbose | sed -n 1,40p   # sed reads it all: no SIGPIPE under pipefail
                        run "$SPLUNK" upgrade-init cluster-peers ;;
                      offline)
                        run "$SPLUNK" offline ;;
                      status)
                        "$SPLUNK" show cluster-status --verbose ;;
                      finalize)
                        run "$SPLUNK" upgrade-finalize cluster-peers ;;
                      *) echo "--phase must be init, offline, status or finalize" >&2; exit 2 ;;
                    esac
                  `,
                ),
              }
            : {}),
          ...(shc
            ? {
                'bin/30-search-head-cluster.sh': bashScript(
                  '30-search-head-cluster.sh',
                  ['Rolling upgrade of a search head cluster. init and finalize run on any member;', 'detain and release run on the member being upgraded.'],
                  [{ flag: '--phase', variable: 'PHASE', value: 'status', help: 'init, detain, release, status or finalize' }],
                  sh`
                    case "$PHASE" in
                      init)
                        "$SPLUNK" show shcluster-status --verbose | sed -n 1,40p
                        run "$SPLUNK" upgrade-init shcluster-members ;;
                      detain)
                        run "$SPLUNK" edit shcluster-config -manual_detention on
                        echo "Wait until this member runs no searches:"
                        echo "  $SPLUNK list shcluster-member-info | grep active" ;;
                      release)
                        run "$SPLUNK" edit shcluster-config -manual_detention off ;;
                      status)
                        "$SPLUNK" show shcluster-status --verbose ;;
                      finalize)
                        run "$SPLUNK" upgrade-finalize shcluster-members ;;
                      *) echo "--phase must be init, detain, release, status or finalize" >&2; exit 2 ;;
                    esac
                  `,
                ),
              }
            : {}),
          'bin/40-kvstore-upgrade.sh': bashScript(
            '40-kvstore-upgrade.sh',
            [
              `Upgrade the KV store server after the binaries (${to102 ? '8.0 on 10.2 and later' : '7.0 on 9.4 and 10.0'}).`,
              shc ? 'A search head cluster upgrades from any one member; standalone search heads each run it.' : 'Run it on each search head.',
            ],
            [
              { flag: '--phase', variable: 'PHASE', value: 'status', help: 'status, check, upgrade, progress or stop' },
              { flag: '--scope', variable: 'SCOPE', value: shc ? 'shcluster' : 'standalone', help: 'shcluster (from one member) or standalone' },
            ],
            sh`
              case "$SCOPE" in shcluster|standalone) ;; *) echo "--scope must be shcluster or standalone" >&2; exit 2 ;; esac
              case "$PHASE" in
                status)
                  "$SPLUNK" show kvstore-status --verbose ;;
                check)
                  # Splunk's own dry run: reports whether the upgrade can proceed, changes nothing.
                  if [[ "$SCOPE" == shcluster ]]; then "$SPLUNK" start-shcluster-upgrade kvstore -isDryRun true
                  else "$SPLUNK" start-standalone-upgrade kvstore -dryRun true; fi ;;
                upgrade)
                  "$SPLUNK" show kvstore-status --verbose | sed -n 1,20p
                  if [[ "$SCOPE" == shcluster ]]; then run "$SPLUNK" start-shcluster-upgrade kvstore
                  else run "$SPLUNK" start-standalone-upgrade kvstore; fi
                  if [[ $EXECUTE -eq 1 ]]; then echo "== Started. Follow it with: bash bin/40-kvstore-upgrade.sh --phase progress --scope $SCOPE"; fi ;;
                progress)
                  if [[ "$SCOPE" == shcluster ]]; then "$SPLUNK" show shcluster-kvupgrade-status
                  else "$SPLUNK" show standalone-kvupgrade-status; fi ;;
                stop)
                  [[ "$SCOPE" == shcluster ]] || { echo "stop applies to a search head cluster upgrade only" >&2; exit 2; }
                  run "$SPLUNK" stop-shcluster-upgrade kvstore ;;
                *) echo "--phase must be status, check, upgrade, progress or stop" >&2; exit 2 ;;
              esac
            `,
          ),
        },
        verify: [
          'splunk version   # on every node',
          '| rest /services/server/info splunk_server=* | stats count by version',
          `splunk show kvstore-status --verbose   # ready, wiredTiger, serverVersion ${to102 ? '8.0' : '7.0'}`,
          'splunk show cluster-status --verbose   # RF and SF met',
          'splunk show shcluster-status --verbose   # captain elected, all members up',
          'index=_internal sourcetype=splunkd log_level=ERROR earliest=-1h | stats count by component | sort - count',
        ],
        backout: [
          '# There is no in-place downgrade.',
          'splunk stop',
          '# restore the previous binaries (package or tarball) and: tar -xzf <backup>/etc-<host>-<stamp>.tgz -C $SPLUNK_HOME',
          'splunk restore kvstore -archiveName <pre-upgrade archive>   # on search heads, after starting the old version',
        ],
        findings,
      };
    },
  });
}

// --- 8. backup -----------------------------------------------------------------

function backup(): SplunkBlueprint {
  return splunkBlueprint({
    id: 'splunk_backup',
    tier: TIER,
    label: 'Configuration and KV store backup',
    group: 'Lifecycle',
    description: 'Scheduled, encrypted backups of $SPLUNK_HOME/etc (with splunk.secret, without which the encrypted passwords in it are useless), the KV store, and the cluster manager, deployer or deployment server bundle — with retention and the restore steps written down.',
    inputs: [
      { id: 'app_name', label: 'Package name', control: 'text', default: 'org_platform_backup' },
      { id: 'role', label: 'Node role', control: 'select', default: 'search_head', options: [
        { value: 'search_head', label: 'Search head or SHC member (KV store)' },
        { value: 'cluster_manager', label: 'Cluster manager (manager-apps)' },
        { value: 'deployer', label: 'SHC deployer (shcluster/apps)' },
        { value: 'deployment_server', label: 'Deployment server (deployment-apps)' },
        { value: 'other', label: 'Other (etc only)' },
      ] },
      { id: 'dest', label: 'Backup destination', control: 'text', default: '/backup/splunk', hint: 'Off the Splunk volume; ideally a mount that is itself backed up' },
      { id: 'retention_days', label: 'Keep backups for (days)', control: 'number', default: 14, min: 1, max: 3650 },
      { id: 'exclude_lookups', label: 'Exclude large lookup files', control: 'toggle', default: true },
      { id: 'lookup_mb', label: 'Lookup size limit (MB)', control: 'number', default: 50, min: 1, max: 100000, showWhen: { input: 'exclude_lookups', equals: ['true'] } },
      { id: 'kvstore', label: 'Back up the KV store', control: 'toggle', default: true },
      { id: 'encrypt', label: 'Encrypt the archives', control: 'toggle', default: true, hint: 'They contain splunk.secret' },
      { id: 'schedule', label: 'Schedule', control: 'select', default: 'daily', options: [
        { value: 'daily', label: 'Daily' },
        { value: 'weekly', label: 'Weekly (Sunday)' },
      ] },
      { id: 'hour', label: 'At hour (local)', control: 'number', default: 2, min: 0, max: 23 },
    ],
    app: (values: BlueprintValues): SplunkApp => {
      const app = splunkName(str(values, 'app_name', 'org_platform_backup'), 'org_platform_backup');
      const role = str(values, 'role', 'search_head');
      const dest = str(values, 'dest', '/backup/splunk');
      const retention = num(values, 'retention_days', 14);
      const excludeLookups = bool(values, 'exclude_lookups', true);
      const lookupMb = num(values, 'lookup_mb', 50);
      const kv = bool(values, 'kvstore', true);
      const encrypt = bool(values, 'encrypt', true);
      const schedule = str(values, 'schedule', 'daily');
      const hour = Math.min(23, Math.max(0, Math.round(num(values, 'hour', 2))));
      const findings: Finding[] = [];

      if (!encrypt) findings.push(warning('splunk.backup-unencrypted', 'The archive contains etc/auth/splunk.secret together with every password Splunk encrypted with it. Unencrypted, anyone who can read the backup can decrypt them all.', { remediation: 'Encrypt the archives, or at minimum keep them mode 600 on a restricted mount.', source: 'Splunk Admin Manual: splunk.secret' }));
      if (/^\/opt\/splunk|\$SPLUNK_HOME|\/splunk\/var/.test(dest)) findings.push(warning('splunk.backup-same-volume', `Backups to ${dest} are on the Splunk volume: a disk failure takes the backup with it, and they eat the space indexing needs.`, { source: 'ArchToolKit' }));
      if (kv && !['search_head', 'other'].includes(role)) findings.push(info('splunk.kvstore-on-role', 'KV store backup is on for a node whose role does not usually use the KV store; the script skips it if the KV store is not running.', { source: 'ArchToolKit' }));
      if (excludeLookups) findings.push(info('splunk.lookups-excluded', `Lookup files over ${lookupMb} MB are left out. If any of those are not reproducible (edited by hand, or built from data since expired), back them up another way.`, { source: 'ArchToolKit' }));

      const bundleDir = role === 'cluster_manager' ? 'etc/manager-apps' : role === 'deployer' ? 'etc/shcluster' : role === 'deployment_server' ? 'etc/deployment-apps' : '';
      const cron = `${spreadCron(app, 1440).split(' ')[0]} ${hour} * * ${schedule === 'weekly' ? '0' : '*'}`;

      return {
        tier: TIER,
        title: `Backup on a ${role.replace(/_/g, ' ')}: etc${kv ? ', KV store' : ''}${bundleDir ? `, ${bundleDir}` : ''}, ${schedule}`,
        app,
        activation: 'reload',
        notes: [
          'Install on each node to be backed up: the scripts in bin/, the cron entry from ops/cron.d/ into /etc/cron.d/ (it runs as the splunk user).',
          'etc/auth/splunk.secret is included on purpose: every encrypted password in etc (pass4SymmKey, sslPassword, bind passwords) can only be decrypted with the splunk.secret that encrypted it. A restore without it leaves every one of them unusable.',
          encrypt ? `Archives are encrypted with openssl (AES-256, PBKDF2) using a key file: create it once with (umask 077; openssl rand -base64 48 > /etc/splunk-backup.key) and keep a copy of it somewhere other than the backups. The key is read with -pass file:, never on the command line.` : 'Archives are not encrypted.',
          ...(kv ? ['The KV store backup is taken through the REST API with a token read from a mode-600 file (create a token for a service account with the admin role, or a role with the needed capability — VERIFY which capability your version requires). The archive lands in $SPLUNK_DB/kvstorebackup ($SPLUNK_HOME/var/lib/splunk/kvstorebackup by default) and is copied to the destination only once kvstore/status reports backupRestoreStatus=Ready again; the script exits 1 on an HTTP error, a Failed status or a timeout (--timeout-min, default 30).', 'In a search head cluster, back up the KV store on one member; it holds the whole replicated store.'] : []),
          ...(bundleDir ? [`${bundleDir} is also archived separately, because it is what you need first to rebuild a ${role.replace(/_/g, ' ')}.`] : []),
          `Backups older than ${retention} days (etc, bundle and KV store archives from this host) are removed from ${dest} — never with --dry-run, and only after a run in which every archive succeeded. An archive is written as NAME.partial and renamed when complete, so a file with a normal name is never a truncated one.`,
          'Output of both cron jobs goes to $SPLUNK_HOME/var/log/splunk/splunk-backup.log, a directory the splunk user owns; each script exits non-zero when anything failed.',
          'Test a restore on a spare instance at least once. A backup that has never been restored is a hope.',
        ],
        before: [
          `df -h ${dest}`,
          'ls -l $SPLUNK_HOME/etc/auth/splunk.secret',
          'splunk show kvstore-status',
          `du -sh $SPLUNK_HOME/etc${bundleDir ? ` $SPLUNK_HOME/${bundleDir}` : ''}`,
          `find $SPLUNK_HOME/etc -path '*/lookups/*' -type f -size +${lookupMb}M -exec ls -lh {} +`,
        ],
        files: {
          'bin/backup-config.sh': bashScript(
            'backup-config.sh',
            [
              `Archive $SPLUNK_HOME/etc (including etc/auth/splunk.secret)${bundleDir ? ` and ${bundleDir}` : ''} to the destination,`,
              `${encrypt ? 'encrypted with a key file, ' : ''}then prune archives older than the retention.`,
            ],
            [
              { flag: '--dest', variable: 'DEST', value: dest, help: 'Backup destination directory' },
              { flag: '--retention-days', variable: 'RETENTION', value: String(retention), help: 'Delete archives older than this' },
              { flag: '--lookup-mb', variable: 'LOOKUP_MB', value: excludeLookups ? String(lookupMb) : '0', help: 'Leave out lookup files larger than this (0 keeps all)' },
              ...(encrypt ? [{ flag: '--key-file', variable: 'KEY_FILE', value: '/etc/splunk-backup.key', help: 'Mode-600 encryption key file' }] : []),
            ],
            sh`
              stamp=$(date +%Y%m%d%H%M%S)
              host=$(hostname -s)
              ${encrypt ? sh`
              perm=$(stat -c %a "$KEY_FILE" 2>/dev/null || echo missing)
              [[ "$perm" == "600" || "$perm" == "400" ]] || { echo "$KEY_FILE must exist with mode 600 (is $perm)" >&2; exit 1; }`.join('\n') : ''}
              excludes=$(mktemp)
              trap 'rm -f "$excludes"' EXIT
              if [[ "$LOOKUP_MB" -gt 0 ]]; then
                ( cd "$SPLUNK_HOME" && find etc -path '*/lookups/*' -type f -size +"$LOOKUP_MB"M ) > "$excludes"
                echo "== Leaving out $(wc -l < "$excludes") lookup file(s) over $LOOKUP_MB MB"
              fi
              run mkdir -p "$DEST"

              # Each archive is written to NAME.partial and renamed only when every
              # stage of the pipe succeeded, so a file with a normal name is always a
              # complete archive and the retention prune never counts a broken one.
              # GNU tar exits 1 when a file changed while it was read (splunkd
              # rewrites some files in etc all the time); that archive is still
              # usable, so 1 is accepted and 2 or more is a failure.
              failures=0
              archive() {
                local name=$1; shift
                local out="$DEST/$name-$host-$stamp.tgz${encrypt ? '.enc' : ''}"
                local tmp="$out.partial" rc_tar rc_out rc
                if [[ $EXECUTE -eq 1 ]]; then
                  set +e
                  tar --warning=no-file-changed -C "$SPLUNK_HOME" -X "$excludes" -czf - "$@" ${encrypt ? '| openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:$KEY_FILE" ' : ''}> "$tmp"
                  rc=("$\{PIPESTATUS[@]}")
                  set -e
                  rc_tar=$\{rc[0]}; rc_out=$\{rc[1]:-0}
                  if [[ $rc_tar -le 1 && $rc_out -eq 0 && -s "$tmp" ]]; then
                    [[ $rc_tar -eq 1 ]] && echo "  note: some files changed while $name was archived (tar exit 1); the archive is complete"
                    chmod 600 "$tmp"
                    mv -f "$tmp" "$out"
                    echo "+ wrote $out ($(du -h "$out" | cut -f1))"
                  else
                    rm -f "$tmp"
                    echo "FAILED: $name archive (tar exit $rc_tar${encrypt ? ', openssl exit $rc_out' : ''}); nothing written" >&2
                    failures=$((failures + 1))
                  fi
                else
                  echo "[dry run] tar --warning=no-file-changed -C $SPLUNK_HOME -X <excludes> -czf - $*${encrypt ? ' | openssl enc -aes-256-cbc -pbkdf2 -pass file:$KEY_FILE' : ''} > $tmp && mv $tmp $out"
                fi
              }

              archive etc etc
              ${bundleDir ? `archive bundle ${bundleDir}` : ''}

              # Old archives are pruned only after a fully successful run, so a job
              # that keeps failing never deletes the last good backups.
              if [[ $failures -gt 0 ]]; then
                echo "$failures archive(s) failed; old backups in $DEST left in place" >&2
                exit 1
              fi
              # Both what this script writes (etc-/bundle-HOST-STAMP.tgz[.enc]) and what
              # backup-kvstore.sh copies (kv-HOST-STAMP*.tar.gz), plus stale .partial files.
              echo "== Pruning archives older than $RETENTION days in $DEST"
              if [[ $EXECUTE -eq 1 ]]; then
                find "$DEST" -maxdepth 1 -type f \( -name "*-$host-*.tgz*" -o -name "kv-$host-*.tar.gz" -o -name "kv-$host-*.partial" \) -mtime +"$RETENTION" -print -delete
              else
                if [[ -d "$DEST" ]]; then
                  find "$DEST" -maxdepth 1 -type f \( -name "*-$host-*.tgz*" -o -name "kv-$host-*.tar.gz" -o -name "kv-$host-*.partial" \) -mtime +"$RETENTION" -print | sed 's/^/[dry run] would delete /'
                fi
              fi
            `,
          ),
          ...(kv
            ? {
                'bin/backup-kvstore.sh': bashScript(
                  'backup-kvstore.sh',
                  [
                    'Take a KV store backup through splunkd’s REST API and copy it to the destination.',
                    'The token is read from a mode-600 file and passed to curl in a private header',
                    'file, so it is never on the command line.',
                  ],
                  [
                    { flag: '--token-file', variable: 'TOKEN_FILE', value: '/etc/splunk-backup.token', help: 'Mode-600 file holding a Splunk authentication token' },
                    { flag: '--dest', variable: 'DEST', value: dest, help: 'Backup destination directory' },
                    { flag: '--cacert', variable: 'CACERT', value: '', help: 'CA bundle for splunkd’s certificate (default: system trust store)' },
                    { flag: '--mgmt', variable: 'MGMT', value: 'https://127.0.0.1:8089', help: 'This node’s management URI' },
                    { flag: '--timeout-min', variable: 'TIMEOUT_MIN', value: '30', help: 'Give up (and exit 1) if the backup is not finished after this long' },
                  ],
                  sh`
                    if ! "$SPLUNK" status >/dev/null 2>&1; then echo "splunkd is not running" >&2; exit 1; fi
                    perm=$(stat -c %a "$TOKEN_FILE" 2>/dev/null || echo missing)
                    [[ "$perm" == "600" || "$perm" == "400" ]] || { echo "$TOKEN_FILE must exist with mode 600 (is $perm)" >&2; exit 1; }
                    name="kv-$(hostname -s)-$(date +%Y%m%d%H%M%S)"
                    work=$(mktemp -d)
                    trap 'rm -rf "$work"' EXIT
                    hdr="$work/auth.h"
                    tok=""
                    IFS= read -r tok < "$TOKEN_FILE" || true   # a last line with no newline still reads; checked below
                    tok=$\{tok%$'\r'}
                    [[ -n "$tok" ]] || { echo "$TOKEN_FILE is empty" >&2; exit 1; }
                    printf 'Authorization: Bearer %s\n' "$tok" > "$hdr"
                    unset tok
                    tls=()
                    [[ -n "$CACERT" ]] && tls=(--cacert "$CACERT")

                    # Prints "<status> <backupRestoreStatus>" from GET /services/kvstore/status
                    # (entry[0].content.current; REST API reference, KV store endpoints).
                    # Returns non-zero on an HTTP error (--fail) or when either field is
                    # missing, so an error is never mistaken for "not Busy".
                    # Parsed with the Python that ships with Splunk: no jq on the host needed.
                    kv_state() {
                      curl -sS --fail "$\{tls[@]}" -H @"$hdr" "$MGMT/services/kvstore/status?output_mode=json" > "$work/status.json" || return 1
                      "$SPLUNK" cmd python3 -c 'import json,sys
                    c = json.load(open(sys.argv[1]))["entry"][0]["content"]["current"]
                    s, b = c.get("status"), c.get("backupRestoreStatus")
                    if not s or not b: sys.exit(1)
                    print(s, b)' "$work/status.json" 2>/dev/null
                    }

                    echo "== KV store status"
                    state=$(kv_state) || { echo "could not read KV store status from $MGMT (HTTP error, or no status/backupRestoreStatus in the response)" >&2; exit 1; }
                    read -r kv_status kv_brs <<< "$state"
                    echo "  status=$kv_status backupRestoreStatus=$kv_brs"
                    # Splunk docs: both must be ready before a backup is taken.
                    if [[ "$kv_status" != ready || "$kv_brs" != Ready ]]; then
                      echo "KV store is not ready for a backup (need status=ready, backupRestoreStatus=Ready)" >&2
                      exit 1
                    fi
                    src="$\{SPLUNK_DB:-$SPLUNK_HOME/var/lib/splunk}/kvstorebackup"
                    tries=$(( TIMEOUT_MIN * 60 / 5 ))
                    if [[ $EXECUTE -eq 1 ]]; then
                      # POST /services/kvstore/backup/create is the REST form of
                      # "splunk backup kvstore -archiveName" (REST API reference).
                      curl -sS --fail "$\{tls[@]}" -H @"$hdr" -X POST "$MGMT/services/kvstore/backup/create" --data-urlencode "archiveName=$name" -o /dev/null
                      echo "+ backup $name started; waiting up to $TIMEOUT_MIN min for backupRestoreStatus=Ready"
                      # Finished = backupRestoreStatus back to Ready AND the archive present
                      # with a size that has stopped changing (a small store can finish
                      # between two polls, so Busy may never be seen). Busy keeps waiting;
                      # Failed or any other value, or the timeout, is a failure.
                      f=""; last=-1; finished=0; kv_brs=""
                      for _ in $(seq 1 "$tries"); do
                        sleep 5
                        if ! state=$(kv_state); then echo "  status read failed; retrying" >&2; continue; fi
                        read -r kv_status kv_brs <<< "$state"
                        case "$kv_brs" in
                          Busy) continue ;;
                          Ready) ;;
                          *) echo "KV store backup ended with backupRestoreStatus=$kv_brs" >&2; exit 1 ;;
                        esac
                        f=$(find "$src" -maxdepth 1 -type f -name "$name*" -print 2>/dev/null | sed -n 1p)
                        [[ -n "$f" ]] || continue
                        size=$(stat -c %s "$f")
                        if [[ "$size" -gt 0 && "$size" -eq "$last" ]]; then finished=1; break; fi
                        last=$size
                      done
                      if [[ $finished -ne 1 ]]; then
                        echo "KV store backup $name did not finish within $TIMEOUT_MIN min (last backupRestoreStatus=$\{kv_brs:-unknown}, archive: $\{f:-none}); nothing copied" >&2
                        exit 1
                      fi
                      mkdir -p "$DEST"
                      base=$(basename "$f")
                      cp -p "$f" "$DEST/$base.partial"
                      chmod 600 "$DEST/$base.partial"
                      mv -f "$DEST/$base.partial" "$DEST/$base"
                      echo "+ copied $base to $DEST"
                    else
                      echo "[dry run] POST $MGMT/services/kvstore/backup/create archiveName=$name"
                      echo "[dry run] wait for backupRestoreStatus=Ready (up to $TIMEOUT_MIN min), then copy $src/$name* to $DEST"
                      echo "[dry run] interactive equivalent: $SPLUNK backup kvstore -archiveName $name"
                    fi
                  `,
                ),
              }
            : {}),
          'ops/cron.d/splunk-backup': [
            '# /etc/cron.d/splunk-backup — runs as the splunk user.',
            'SHELL=/bin/bash',
            'SPLUNK_HOME=/opt/splunk',
            '# The log goes to $SPLUNK_HOME/var/log/splunk, which the splunk user owns (a',
            '# splunk-user job cannot create a file in /var/log). Splunk\'s default monitor of',
            '# that directory normally indexes it into _internal, so a failed run is searchable',
            '# (VERIFY: splunk btool inputs list monitor:///opt/splunk/var/log/splunk). Both',
            '# scripts exit non-zero on any failure, so cron also mails MAILTO if it is set.',
            `${cron} splunk bash $SPLUNK_HOME/etc/apps/${app}/bin/backup-config.sh >> $SPLUNK_HOME/var/log/splunk/splunk-backup.log 2>&1`,
            ...(kv ? [`${cron.replace(/^\d+/, (m) => String((Number(m) + 15) % 60))} splunk bash $SPLUNK_HOME/etc/apps/${app}/bin/backup-kvstore.sh >> $SPLUNK_HOME/var/log/splunk/splunk-backup.log 2>&1`] : []),
          ],
          'RESTORE.md': [
            '# Restoring a Splunk node from these backups',
            '',
            '1. Install the same Splunk version the backup was taken from (splunk version is recorded in etc/splunk.version inside the archive).',
            '2. Stop splunkd: `splunk stop`.',
            ...(encrypt ? ['3. Decrypt and unpack: `openssl enc -d -aes-256-cbc -pbkdf2 -pass file:/etc/splunk-backup.key -in etc-<host>-<stamp>.tgz.enc | tar -C $SPLUNK_HOME -xzf -`'] : ['3. Unpack: `tar -C $SPLUNK_HOME -xzf etc-<host>-<stamp>.tgz`']),
            '4. Confirm `etc/auth/splunk.secret` came back with the rest and is mode 400 or 600, owned by the splunk user. Without the original splunk.secret, every encrypted password in etc is unreadable and must be set again.',
            '5. Restore any lookups that were excluded for size.',
            '6. Start: `splunk start`, then check `splunk btool check` and `index=_internal log_level=ERROR earliest=-15m`.',
            ...(kv ? ['7. KV store: copy the archive into $SPLUNK_HOME/var/lib/splunk/kvstorebackup/ and run `splunk restore kvstore -archiveName <name>` (after `splunk login`). In a search head cluster, follow the SHC restore procedure — restoring on one member while others run can be overwritten by replication (VERIFY the steps for your version).'] : []),
            ...(bundleDir ? [`8. ${role === 'cluster_manager' ? 'Cluster manager: check etc/manager-apps, then `splunk validate cluster-bundle --check-restart` before any push.' : role === 'deployer' ? 'Deployer: check etc/shcluster/apps, then push with bin/deployer-push.sh from the SHC package.' : 'Deployment server: check etc/deployment-apps and serverclass.conf, then `splunk reload deploy-server`.'}`] : []),
          ],
        },
        verify: [
          `ls -l ${dest}`,
          encrypt ? `openssl enc -d -aes-256-cbc -pbkdf2 -pass file:/etc/splunk-backup.key -in ${dest}/etc-<host>-<stamp>.tgz.enc | tar -tzf - | grep -c splunk.secret` : `tar -tzf ${dest}/etc-<host>-<stamp>.tgz | grep -c splunk.secret`,
          'ls -l $SPLUNK_HOME/var/lib/splunk/kvstorebackup',
          'tail -50 $SPLUNK_HOME/var/log/splunk/splunk-backup.log',
          'index=_internal source=*splunk-backup.log (FAILED OR "did not finish" OR "not ready" OR "could not") earliest=-7d',
        ],
        backout: ['rm /etc/cron.d/splunk-backup', `rm -rf $SPLUNK_HOME/etc/apps/${app}`, '# The archives in the destination are left in place; delete them by hand if they are no longer wanted.'],
        findings,
      };
    },
  });
}

export const MANAGEMENT_PLATFORM_BLUEPRINTS: readonly SplunkBlueprint[] = [
  architecture(),
  indexerCluster(),
  searchHeadCluster(),
  deploymentServer(),
  licenseManager(),
  monitoringConsole(),
  upgrade(),
  backup(),
];
