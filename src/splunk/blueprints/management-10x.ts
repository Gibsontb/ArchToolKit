/**
 * Splunk management on 10.x: search peers, the KV store server upgrade, and
 * the health report.
 *
 * Three jobs that are each a handful of commands, and each fails in a way that
 * is easy to miss. A search peer added without its key exchanged is listed and
 * returns nothing. A KV store server upgrade started on a host whose CPU lacks
 * AVX leaves the KV store down, and every lookup and every app that keeps state
 * in it with it. And a health report whose thresholds were never tuned is red
 * so often that nobody looks at it, which is the same as not having one.
 *
 * Every script applies when run; `--dry-run` previews (for the KV store
 * upgrade it runs the CLI's own dry run). Every CLI call assumes the operator
 * ran `splunk login` first, which prompts and caches a session, so no Splunk
 * password is ever on argv from these scripts except where the CLI itself
 * demands one, and that is said where it happens.
 */

import { bool, num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, warning, type Finding } from '../../core/findings.ts';
import { splunkBlueprint, type SplunkBlueprint } from '../from-app.ts';
import { defaultMeta, listOf, type SplunkApp, splunkName } from '../splunk.ts';

const TIER = 'management' as const;

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
function bashScript(name: string, purpose: readonly string[], options: readonly ScriptOption[], body: readonly string[], dryRunHelp = 'Preview. The script prints what it would do and changes nothing.'): string[] {
  const usage = options.map((o) => (o.value === undefined ? `[${o.flag}]` : `[${o.flag} ${o.variable}]`)).join(' ');
  return [
    '#!/usr/bin/env bash',
    ...purpose.map((line) => `# ${line}`),
    '#',
    `# Usage: bash bin/${name} [--dry-run]${usage ? ` ${usage}` : ''}`,
    `#   --dry-run   ${dryRunHelp}`,
    ...options.map((o) => `#   ${(o.value === undefined ? o.flag : `${o.flag} ${o.variable}`).padEnd(11)} ${o.help}${o.value !== undefined && o.value !== '' ? ` (default: ${o.value})` : ''}`),
    '#',
    '# Run it as the user splunkd runs as, never as root. Authenticate the CLI',
    '# first with "splunk login": it prompts, caches a session, and keeps the',
    '# password off the command line.',
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
    'if [[ $EUID -eq 0 ]]; then echo "Refusing to run as root: run it as the user splunkd runs as." >&2; exit 1; fi',
    'SPLUNK_HOME="${SPLUNK_HOME:-/opt/splunk}"',
    'SPLUNK="$SPLUNK_HOME/bin/splunk"',
    'run() {',
    '  if [[ $EXECUTE -eq 1 ]]; then printf "+ %s\\n" "$*"; "$@"; else printf "[dry run] %s\\n" "$*"; fi',
    '}',
    '',
    ...body,
  ];
}

/** Rows of a " | " grid, trimmed, comments and blanks dropped. */
function rows(value: string): string[][] {
  return String(value ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split('|').map((cell) => cell.trim()));
}

const HOST = /^[A-Za-z0-9]([A-Za-z0-9-]{0,62})(\.[A-Za-z0-9]([A-Za-z0-9-]{0,62}))*$|^\d{1,3}(\.\d{1,3}){3}$/;

// --- 4. distributed search peers ------------------------------------------------

interface Peer {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly uri: string;
}

function distributedSearch(): SplunkBlueprint {
  return splunkBlueprint({
    id: 'splunk_distsearch_peers',
    tier: TIER,
    label: 'Distributed search peers',
    group: 'Distributed search',
    description: 'Adds non-clustered indexers as search peers of a search head: either with splunk add search-server, which exchanges the keys for you, or as distsearch.conf with a script that copies the search head’s trusted.pem to every peer.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_search_peers' },
      { id: 'method', label: 'Add them with', control: 'select', default: 'cli', options: [
        { value: 'cli', label: 'splunk add search-server — exchanges keys, no restart' },
        { value: 'conf', label: 'distsearch.conf, and trusted.pem copied to each peer' },
      ] },
      { id: 'peers', label: 'Search peers', control: 'textarea', default: 'idx01.example.com | 8089 | admin\nidx02.example.com | 8089 | admin\nidx03.example.com | 8089 | admin', hint: 'peer | management port | remote user' },
      { id: 'sh_name', label: 'Search head serverName', control: 'text', default: 'sh01', hint: 'serverName in its server.conf [general]; the peers file its key under this name', showWhen: { input: 'method', equals: ['conf'] } },
      { id: 'ssh_user', label: 'SSH user on the peers', control: 'text', default: 'splunk', hint: 'The account splunkd runs as there, so the key is owned by it', showWhen: { input: 'method', equals: ['conf'] } },
      { id: 'peer_home', label: 'SPLUNK_HOME on the peers', control: 'text', default: '/opt/splunk', showWhen: { input: 'method', equals: ['conf'] } },
    ],
    app: (values: BlueprintValues): SplunkApp => {
      const app = splunkName(str(values, 'app_name', 'org_search_peers'), 'org_search_peers');
      const cli = str(values, 'method', 'cli') === 'cli';
      const shName = str(values, 'sh_name', 'sh01');
      const sshUser = str(values, 'ssh_user', 'splunk');
      const peerHome = str(values, 'peer_home', '/opt/splunk').replace(/\/+$/, '');
      const findings: Finding[] = [];

      const peers: Peer[] = [];
      const seen = new Set<string>();
      for (const [rawHost = '', rawPort = '', user = ''] of rows(str(values, 'peers', ''))) {
        const host = rawHost.replace(/^https?:\/\//, '').replace(/:\d+$/, '').replace(/\/.*$/, '');
        const port = Number(rawPort || 8089);
        if (!HOST.test(host)) {
          findings.push(error('splunk.distsearch-host', `"${rawHost}" is not a host name or IPv4 address.`));
          continue;
        }
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          findings.push(error('splunk.distsearch-port', `"${rawPort}" is not a port for ${host}.`));
          continue;
        }
        if ([9997, 8088, 8000, 514].includes(port)) {
          findings.push(error('splunk.distsearch-not-management-port', `${host}:${port} is ${port === 9997 ? 'the forwarder receiving port' : port === 8088 ? 'the HTTP Event Collector port' : port === 8000 ? 'Splunk Web' : 'syslog'}, not splunkd’s management port. The search head would never reach the peer’s REST API.`, { remediation: 'Use the peer’s management port, 8089 unless server.conf moves it.' }));
          continue;
        }
        if (cli && !user) {
          findings.push(error('splunk.distsearch-no-user', `${host} has no remote user. splunk add search-server authenticates to the peer as an admin user to exchange keys.`));
          continue;
        }
        const uri = `https://${host}:${port}`;
        if (seen.has(uri)) {
          findings.push(warning('splunk.distsearch-duplicate', `${uri} is listed twice. The second add fails, and in distsearch.conf the peer is searched once anyway.`));
          continue;
        }
        seen.add(uri);
        peers.push({ host, port, user, uri });
      }
      if (peers.length === 0 && findings.length === 0) {
        findings.push(error('splunk.distsearch-no-peers', 'No search peer is listed.'));
      }
      if (!cli && !/^[A-Za-z0-9_.-]+$/.test(shName)) {
        findings.push(error('splunk.distsearch-sh-name', `"${shName}" is not a serverName. The peers look for the key in distServerKeys/<serverName>/, and would not find it.`));
      }

      const peerLines = peers.map((p) => quoteSh(`${p.uri} ${p.user || '-'}`));

      const cliScript = bashScript(
        'add-search-peers.sh',
        [
          'Add each search peer to this search head with splunk add search-server,',
          'which authenticates to the peer and exchanges the keys. No restart.',
          '',
          'The CLI takes the remote password as an argument, so while each add runs',
          'the password is visible in the process list to other users on this host.',
          'Run it on a search head nobody else is logged in to, from a mode-600',
          'file (--password-file) or at the prompt, and change the password after',
          'if that matters here.',
        ],
        [{ flag: '--password-file', variable: 'PASSWORD_FILE', value: '', help: 'Mode-600 file with the remote user’s password on its first line (otherwise it prompts, once per user)' }],
        sh`
          PEERS=(${peerLines.join(' ')})
          declare -A secret_for=()
          password_for() {
            local user="$1" value=""
            if [[ -n "$\{secret_for[$user]+x}" ]]; then return 0; fi
            if [[ -n "$PASSWORD_FILE" ]]; then
              perm=$(stat -c %a "$PASSWORD_FILE")
              [[ "$perm" == "600" || "$perm" == "400" ]] || { echo "$PASSWORD_FILE is mode $perm; chmod 600 it first" >&2; exit 1; }
              IFS= read -r value < "$PASSWORD_FILE" || true
            else
              IFS= read -r -s -p "Password for $user on the peers: " value < /dev/tty; echo
            fi
            [[ -n "$value" ]] || { echo "No password for $user" >&2; exit 1; }
            secret_for[$user]="$value"
          }

          failed=0
          for entry in "$\{PEERS[@]}"; do
            uri="$\{entry%% *}"
            user="$\{entry#* }"
            if [[ $EXECUTE -eq 0 ]]; then
              printf '[dry run] %s add search-server %s -remoteUsername %s -remotePassword ****\n' "$SPLUNK" "$uri" "$user"
              continue
            fi
            password_for "$user"
            printf '+ %s add search-server %s -remoteUsername %s -remotePassword ****\n' "$SPLUNK" "$uri" "$user"
            if ! "$SPLUNK" add search-server "$uri" -remoteUsername "$user" -remotePassword "$\{secret_for[$user]}"; then
              echo "  failed: $uri (already a peer, unreachable, or the credentials were refused)" >&2
              failed=$((failed + 1))
            fi
          done
          secret_for=()
          if [[ $EXECUTE -eq 1 ]]; then "$SPLUNK" list search-server || true; fi
          [[ $failed -eq 0 ]] || exit 1
        `,
      );

      const pemScript = bashScript(
        'copy-trusted-pem.sh',
        [
          'Copy this search head’s public key (etc/auth/distServerKeys/trusted.pem) to',
          `every peer, as distServerKeys/${shName}/trusted.pem, over ssh as the user`,
          'splunkd runs as there. Each peer reads it on its next restart; --restart-peers',
          'restarts them one at a time after the copy.',
        ],
        [
          { flag: '--ssh-user', variable: 'SSH_USER', value: sshUser, help: 'ssh user on the peers' },
          { flag: '--restart-peers', variable: 'RESTART', help: 'Restart splunkd on each peer after its copy' },
        ],
        sh`
          SH_NAME=${quoteSh(shName)}
          PEER_HOME=${quoteSh(peerHome)}
          PEER_HOSTS=(${peers.map((p) => quoteSh(p.host)).join(' ')})
          KEY="$SPLUNK_HOME/etc/auth/distServerKeys/trusted.pem"
          [[ -r "$KEY" ]] || { echo "Cannot read $KEY: run this on the search head" >&2; exit 1; }
          name=$("$SPLUNK" btool server list general 2>/dev/null | awk -F' = ' '/^serverName/ { print $2; exit }' || true)
          if [[ -n "$name" && "$name" != "$SH_NAME" ]]; then
            echo "This search head's serverName is $name, not $SH_NAME. The peers would file the key under the wrong name." >&2
            exit 1
          fi
          for host in "$\{PEER_HOSTS[@]}"; do
            dest="$PEER_HOME/etc/auth/distServerKeys/$SH_NAME"
            run ssh "$SSH_USER@$host" "mkdir -p '$dest'"
            run scp "$KEY" "$SSH_USER@$host:$dest/trusted.pem"
            if [[ $RESTART -eq 1 ]]; then run ssh "$SSH_USER@$host" "'$PEER_HOME/bin/splunk' restart"; fi
          done
        `,
      );

      return {
        tier: TIER,
        title: `Search peers for ${cli ? 'this search head' : shName}: ${peers.length} ${peers.length === 1 ? 'peer' : 'peers'}`,
        app,
        activation: cli ? 'reload' : 'restart',
        notes: [
          'For non-clustered indexers only. A search head joins an indexer cluster through server.conf [clustering] mode = searchhead and manager_uri, and gets its peers from the manager; listing cluster peers here as well searches them twice.',
          ...(cli
            ? [
                'bin/add-search-peers.sh applies when run; --dry-run prints each add with the password masked. Run "splunk login" on the search head first.',
                'In a search head cluster, run it on every member: search peers are not replicated between members.',
              ]
            : [
                'default/distsearch.conf lists the peers. It takes effect when the search head restarts; the peers accept its searches once they have its trusted.pem and have restarted.',
                `bin/copy-trusted-pem.sh copies $SPLUNK_HOME/etc/auth/distServerKeys/trusted.pem from this search head to ${peerHome}/etc/auth/distServerKeys/${shName}/trusted.pem on each peer, as ${sshUser}. It applies when run; --dry-run prints the ssh and scp commands.`,
              ]),
        ],
        before: [
          ...peers.slice(0, 3).map((p) => `curl -sk -o /dev/null -w '%{http_code}\\n' ${p.uri}/services/server/info   # 401 means reachable`),
          'splunk list search-server',
          '| rest /services/search/distributed/peers splunk_server=local | table title, status, version, server_roles',
        ],
        files: {
          ...(cli
            ? { 'bin/add-search-peers.sh': cliScript }
            : {
                'default/distsearch.conf': [
                  '# Search peers of this search head. Each needs this search head’s',
                  `# trusted.pem in distServerKeys/${shName}/ (bin/copy-trusted-pem.sh).`,
                  '[distributedSearch]',
                  `servers = ${peers.map((p) => p.uri).join(',')}`,
                ],
                'bin/copy-trusted-pem.sh': pemScript,
              }),
          'metadata/default.meta': defaultMeta(),
        },
        verify: [
          'splunk list search-server',
          '| rest /services/search/distributed/peers splunk_server=local | table title, status, is_https, version',
          'index=_internal earliest=-15m | stats count by splunk_server   # every peer answers',
          'index=_internal sourcetype=splunkd component=DistributedPeer* log_level!=INFO earliest=-1h | stats count by message',
        ],
        backout: cli
          ? [...peers.map((p) => `splunk remove search-server ${p.uri}`)]
          : [
              `rm -rf $SPLUNK_HOME/etc/apps/${app} && splunk restart   # on the search head`,
              `# on each peer: rm -rf ${peerHome}/etc/auth/distServerKeys/${shName} && splunk restart`,
            ],
        findings,
      };
    },
  });
}

// --- 5. KV store server upgrade -----------------------------------------------------

/** The KV store server version each Splunk release upgrades to on its own. */
const KV_TARGET: Readonly<Record<string, string>> = { '9.4': '7.0', '10.0': '7.0', '10.2': '8.0', '10.4': '8.0' };

function kvstoreUpgrade(): SplunkBlueprint {
  return splunkBlueprint({
    id: 'splunk_kvstore_upgrade',
    tier: TIER,
    label: 'KV store server upgrade',
    group: 'Lifecycle',
    description: 'Upgrades the KV store server by hand, on a standalone search head or a search head cluster: prechecks (KV store status, AVX, SSE4.2 and AES-NI, glibc), a KV store backup first, the upgrade with the CLI’s own dry run behind --dry-run, and status polling until it finishes or fails.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_kvstore_upgrade' },
      { id: 'topology', label: 'Topology', control: 'select', default: 'shc', options: [
        { value: 'shc', label: 'Search head cluster — run on one member' },
        { value: 'standalone', label: 'Standalone search head or other single node' },
      ] },
      { id: 'splunk_version', label: 'Splunk Enterprise version running', control: 'select', default: '10.2', options: ['9.4', '10.0', '10.2', '10.4'].map((v) => ({ value: v, label: `${v}.x` })) },
      { id: 'current_server', label: 'KV store server version now', control: 'select', default: '7.0', hint: 'splunk show kvstore-status --verbose', options: [
        { value: '4.2', label: '4.2' },
        { value: '7.0', label: '7.0' },
        { value: '8.0', label: '8.0' },
      ] },
      { id: 'backup', label: 'Back up the KV store first', control: 'toggle', default: true },
      { id: 'poll_minutes', label: 'Wait for the upgrade (minutes)', control: 'number', default: 60, min: 5, max: 1440 },
      { id: 'stop_auto', label: 'Stop the automatic upgrade on restart', control: 'toggle', default: false, hint: 'server.conf [kvstore] kvstoreUpgradeOnStartupEnabled = false' },
    ],
    app: (values: BlueprintValues): SplunkApp => {
      const app = splunkName(str(values, 'app_name', 'org_kvstore_upgrade'), 'org_kvstore_upgrade');
      const shc = str(values, 'topology', 'shc') === 'shc';
      const version = str(values, 'splunk_version', '10.2');
      const current = str(values, 'current_server', '7.0');
      const backup = bool(values, 'backup', true);
      const pollMinutes = Math.max(5, num(values, 'poll_minutes', 60));
      const stopAuto = bool(values, 'stop_auto', false);
      const target = KV_TARGET[version] ?? '8.0';
      const findings: Finding[] = [];

      if (version === '10.4' && current === '4.2') {
        findings.push(
          error('splunk.kvstore-42-on-104', 'KV store server 4.2 is removed in Splunk 10.4, so a 10.4 node cannot run it and there is nothing to upgrade from.', {
            remediation: 'Upgrade the KV store server to 7.0 on 10.2 or earlier before upgrading Splunk to 10.4, or restore the KV store from a backup onto a node that is already on 7.0 or later.',
            source: 'Splunk Enterprise 10.4 release notes: removed features',
          }),
        );
      } else if (Number(current) >= Number(target)) {
        findings.push(warning('splunk.kvstore-already-current', `The KV store server is already ${current}, and Splunk ${version} upgrades it to ${target} at most. The upgrade command has nothing to do.`));
      }
      if (!backup) {
        findings.push(warning('splunk.kvstore-no-backup', 'No KV store backup before the upgrade. A failed server upgrade is recovered by restoring a backup; without one, every collection — lookups, app state, Enterprise Security notables and the like — is at risk.'));
      }

      const status = shc ? 'show shcluster-kvupgrade-status' : 'show standalone-kvupgrade-status';
      const start = shc ? 'start-shcluster-upgrade kvstore' : 'start-standalone-upgrade kvstore';
      const dryFlag = shc ? '-isDryRun true' : '-dryRun true';
      const glibcNeeded = target === '8.0';

      return {
        tier: TIER,
        title: `KV store server upgrade to ${target}: ${shc ? 'search head cluster' : 'standalone'} on Splunk ${version}`,
        app,
        activation: stopAuto ? 'restart' : 'reload',
        notes: [
          `Splunk ${version} upgrades the KV store server to ${target} on its own when splunkd starts, unless server.conf [kvstore] kvstoreUpgradeOnStartupEnabled = false. These scripts are for doing it deliberately, in a window, after the checks.`,
          `KV store server ${target} (MongoDB ${target.split('.')[0]}) needs x86_64 CPUs with AVX, SSE4.2 and AES-NI${glibcNeeded ? ', and glibc 2.27 or later' : ''}. bin/00-kvstore-precheck.sh checks them and the KV store status and exits 1 on a problem.`,
          ...(backup ? ['bin/10-kvstore-backup.sh takes a KV store backup with splunk backup kvstore -archiveName and waits until the archive is written to $SPLUNK_DB/kvstorebackup. Copy it off the host.'] : []),
          `bin/20-kvstore-upgrade.sh runs the precheck${backup ? ', refuses to start without a backup from the last 24 hours,' : ''} then splunk ${start}, and polls splunk ${status} every 30 seconds for up to ${pollMinutes} minutes. It applies when run; --dry-run runs the CLI’s own dry run (${dryFlag}) instead, which checks the upgrade can proceed and changes nothing.`,
          ...(shc ? ['In a search head cluster, run the upgrade on one member only; it upgrades every member in turn. Run the precheck on every member first.'] : []),
          'VERIFY: the exact wording of the upgrade status output in your version. The script treats a line matching complet or success as done, and fail or abort as failed; anything else keeps it polling.',
          ...(stopAuto ? ['VERIFY: kvstoreUpgradeOnStartupEnabled is honoured from an app’s default/server.conf in your version; if btool shows it but the upgrade still runs on restart, set it in $SPLUNK_HOME/etc/system/local/server.conf on each node.'] : []),
        ],
        before: [
          'splunk show kvstore-status --verbose',
          "grep -o -w -E 'avx|sse4_2|aes' /proc/cpuinfo | sort -u",
          'ldd --version | head -1   # glibc',
          ...(shc ? ['splunk show shcluster-status --verbose'] : []),
          '| rest /services/kvstore/status splunk_server=* | table splunk_server, current.status, current.serverVersion   # VERIFY field names',
        ],
        files: {
          'bin/00-kvstore-precheck.sh': bashScript(
            '00-kvstore-precheck.sh',
            [
              `Read-only checks before upgrading the KV store server to ${target}. Changes`,
              'nothing, with or without --dry-run. Exit 0: no blocking problem; 1: fix the',
              'PROBLEM lines first.',
            ],
            [],
            sh`
              problems=0
              problem() { echo "  PROBLEM: $*"; problems=$((problems + 1)); }

              echo "== KV store status"
              kv=$("$SPLUNK" show kvstore-status --verbose 2>&1 || true)
              if [[ -z "$kv" ]]; then
                problem "no KV store status: splunkd down, or not logged in (splunk login)"
              else
                { printf '%s\n' "$kv" | grep -Ei "status|serverVersion|storageEngine|replicationStatus"; } || true
                if grep -Eqi '^[[:space:]]*status[[:space:]]*:[[:space:]]*(failed|starting|disabled)' <<< "$kv"; then problem "KV store is not ready; fix it before upgrading"; fi
                if grep -Eqi 'storageEngine[[:space:]]*:[[:space:]]*mmapv1' <<< "$kv"; then problem "KV store uses mmapv1; migrate to wiredTiger first"; fi
              fi

              echo "== CPU flags"
              arch=$(uname -m)
              if [[ "$arch" != x86_64 ]]; then
                echo "  $arch: AVX, SSE4.2 and AES-NI are x86_64 flags; check Splunk's platform support for $arch"
              else
                for f in avx sse4_2 aes; do
                  if grep -qw "$f" /proc/cpuinfo; then echo "  $f: yes"; else problem "CPU has no $f: KV store server ${target} will not start on this host"; fi
                done
              fi

              echo "== glibc"
              glibc=$(ldd --version 2>&1 | sed -n '1s/.* \([0-9][0-9]*\.[0-9][0-9]*\)$/\1/p')
              if [[ -z "$glibc" ]]; then
                echo "  could not read the glibc version"
              else
                echo "  $glibc"
                major=$\{glibc%%.*}; minor=$\{glibc#*.}
                ${glibcNeeded ? `if (( major < 2 || (major == 2 && minor < 27) )); then problem "glibc $glibc is older than 2.27, which KV store server ${target} needs"; fi` : ': # no glibc floor for this KV store server version'}
              fi

              echo "== Free space for the backup"
              { df -h "$\{SPLUNK_DB:-$SPLUNK_HOME/var/lib/splunk}" | tail -1; } || true
            `.concat(
              shc
                ? sh`
                    echo "== Search head cluster"
                    { "$SPLUNK" show shcluster-status --verbose 2>&1 | sed -n 1,25p; } || problem "cannot read the search head cluster status"
                  `
                : [],
              sh`

              echo
              if [[ $problems -gt 0 ]]; then echo "Precheck: $problems PROBLEM(s). Do not upgrade this node yet."; exit 1; fi
              echo "Precheck: no blocking problem found."
            `,
            ),
          ),
          ...(backup
            ? {
                'bin/10-kvstore-backup.sh': bashScript(
                  '10-kvstore-backup.sh',
                  ['Back up the KV store before the server upgrade, and wait for the archive.'],
                  [{ flag: '--timeout-min', variable: 'TIMEOUT_MIN', value: '30', help: 'How long to wait for the archive' }],
                  sh`
                    dir="$\{SPLUNK_DB:-$SPLUNK_HOME/var/lib/splunk}/kvstorebackup"
                    name="kvstore-preupgrade-$(hostname -s)-$(date +%Y%m%d%H%M%S)"
                    run "$SPLUNK" backup kvstore -archiveName "$name"
                    [[ $EXECUTE -eq 1 ]] || exit 0
                    deadline=$(( $(date +%s) + TIMEOUT_MIN * 60 ))
                    until ls "$dir/$name"* >/dev/null 2>&1; do
                      (( $(date +%s) < deadline )) || { echo "No archive $name in $dir after $TIMEOUT_MIN minutes" >&2; exit 1; }
                      sleep 10
                    done
                    ls -l "$dir/$name"*
                    echo "Backup written. Copy it off this host before upgrading."
                  `,
                ),
              }
            : {}),
          'bin/20-kvstore-upgrade.sh': bashScript(
            '20-kvstore-upgrade.sh',
            [
              `Upgrade the KV store server ${shc ? 'across the search head cluster (run on one member)' : 'on this node'}, then poll`,
              'its status until it completes, fails, or the wait runs out.',
            ],
            [
              { flag: '--poll-min', variable: 'POLL_MIN', value: String(pollMinutes), help: 'Minutes to wait for the upgrade' },
              { flag: '--skip-precheck', variable: 'SKIP_PRECHECK', help: 'Do not run 00-kvstore-precheck.sh first' },
            ],
            sh`
              here=$(cd "$(dirname "$0")" && pwd)
              if [[ $SKIP_PRECHECK -eq 0 ]]; then
                bash "$here/00-kvstore-precheck.sh" || { echo "Precheck failed; not upgrading." >&2; exit 1; }
              fi
            `.concat(
              backup
                ? sh`
                    dir="$\{SPLUNK_DB:-$SPLUNK_HOME/var/lib/splunk}/kvstorebackup"
                    recent=$(find "$dir" -maxdepth 1 -name 'kvstore-preupgrade-*' -mmin -1440 2>/dev/null || true)
                    if [[ $EXECUTE -eq 1 && -z "$recent" ]]; then
                      echo "No KV store backup from the last 24 hours in $dir. Run bin/10-kvstore-backup.sh first." >&2
                      exit 1
                    fi
                  `
                : [],
              sh`

              if [[ $EXECUTE -eq 0 ]]; then
                # The preview is the CLI's own dry run: it checks the upgrade can proceed and changes nothing.
                printf '+ %s %s %s\n' "$SPLUNK" ${quoteSh(start)} ${quoteSh(dryFlag)}
                "$SPLUNK" ${start} ${dryFlag}
                "$SPLUNK" ${status} || true
                exit 0
              fi
              printf '+ %s %s\n' "$SPLUNK" ${quoteSh(start)}
              "$SPLUNK" ${start}

              deadline=$(( $(date +%s) + POLL_MIN * 60 ))
              while :; do
                out=$("$SPLUNK" ${status} 2>&1 || true)
                sed -n 1,20p <<< "$out"
                if grep -Eqi 'fail|abort' <<< "$out"; then echo "KV store upgrade failed. Read the status above and splunkd.log (component KVStore*)." >&2; exit 1; fi
                if grep -Eqi 'complet|success' <<< "$out"; then echo "Done."; break; fi
                (( $(date +%s) < deadline )) || { echo "Still running after $POLL_MIN minutes; keep watching: $SPLUNK ${status}" >&2; exit 1; }
                sleep 30
              done
              "$SPLUNK" show kvstore-status --verbose | grep -Ei "status|serverVersion" || true
            `,
            ),
            `Run the CLI's own dry run (${dryFlag}): it checks the upgrade can proceed and changes nothing.`,
          ),
          ...(stopAuto
            ? {
                'default/server.conf': [
                  '# The KV store server is upgraded by bin/20-kvstore-upgrade.sh, in a window,',
                  '# not by splunkd on the next restart.',
                  '[kvstore]',
                  'kvstoreUpgradeOnStartupEnabled = false',
                ],
              }
            : {}),
          'metadata/default.meta': defaultMeta(),
        },
        verify: [
          'splunk show kvstore-status --verbose   # ready, and serverVersion is ' + target,
          `splunk ${status}`,
          'index=_internal sourcetype=splunkd component=KVStore* log_level=ERROR earliest=-1h | stats count by splunk_server, message',
          '| rest /services/kvstore/status splunk_server=* | table splunk_server, current.status, current.serverVersion   # VERIFY field names',
        ],
        backout: [
          ...(shc ? [`splunk stop-shcluster-upgrade kvstore   # stops an upgrade still in progress`] : []),
          '# A completed server upgrade is not reversed in place. Restore the pre-upgrade backup:',
          'splunk restore kvstore -archiveName <kvstore-preupgrade-archive>',
          ...(stopAuto ? [`rm -rf $SPLUNK_HOME/etc/apps/${app} && splunk restart   # lets splunkd upgrade the KV store on start again`] : []),
        ],
        findings,
      };
    },
  });
}

// --- 6. splunkd health report ----------------------------------------------------------

interface Threshold {
  readonly feature: string;
  readonly indicator: string;
  readonly yellow: string;
  readonly red: string;
}

const NAME = /^[a-z0-9_]+$/;

function healthReport(): SplunkBlueprint {
  return splunkBlueprint({
    id: 'splunk_health_report',
    tier: TIER,
    label: 'splunkd health report tuning',
    group: 'Monitoring',
    description: 'health.conf for the splunkd health report: indicator thresholds tuned per feature, alerts on by colour and duration, sent by email or webhook (with the webhook on the allow list), and features muted or snoozed until a date.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_health_report' },
      { id: 'thresholds', label: 'Indicator thresholds', control: 'textarea', default: 'disk_space | disk_space_remaining_multiple_minfreespace | 2 | 1\nbuckets | percent_small_buckets_created_last_24h | 30 | 50\nsearches_skipped | percent_searches_skipped_high_priority_last_24h | 5 | 10', hint: 'feature | indicator | yellow | red' },
      { id: 'threshold_color', label: 'Alert at', control: 'select', default: 'red', options: [
        { value: 'red', label: 'Red only' },
        { value: 'yellow', label: 'Yellow and red' },
      ] },
      { id: 'min_duration', label: 'Only after it has lasted (seconds)', control: 'number', default: 300, min: 0, max: 86400 },
      { id: 'email', label: 'Send by email', control: 'toggle', default: true },
      { id: 'email_to', label: 'Email to', control: 'text', default: 'splunk-ops@example.com, platform-oncall@example.com', hint: 'Comma separated', showWhen: { input: 'email', equals: ['true'] } },
      { id: 'webhook', label: 'Send to a webhook', control: 'toggle', default: false },
      { id: 'webhook_url', label: 'Webhook URL', control: 'text', default: 'https://hooks.example.com/splunk-health', showWhen: { input: 'webhook', equals: ['true'] } },
      { id: 'muted', label: 'Features with alerts off', control: 'text', default: '', hint: 'Comma separated — their colour still shows, they do not alert' },
      { id: 'snooze', label: 'Snooze features until a date', control: 'toggle', default: false },
      { id: 'snoozed', label: 'Snoozed features', control: 'textarea', default: 'searches_skipped | 2026-12-31', hint: 'feature | snooze until (YYYY-MM-DD)', showWhen: { input: 'snooze', equals: ['true'] } },
    ],
    app: (values: BlueprintValues): SplunkApp => {
      const app = splunkName(str(values, 'app_name', 'org_health_report'), 'org_health_report');
      const color = str(values, 'threshold_color', 'red');
      const minDuration = Math.max(0, Math.round(num(values, 'min_duration', 300)));
      const email = bool(values, 'email', true);
      const recipients = email ? listOf(str(values, 'email_to', '')) : [];
      const webhook = bool(values, 'webhook', false);
      const url = webhook ? str(values, 'webhook_url', '') : '';
      const muted = listOf(str(values, 'muted', ''));
      const snooze = bool(values, 'snooze', false);
      const findings: Finding[] = [];

      const thresholds: Threshold[] = [];
      const seen = new Set<string>();
      for (const [feature = '', indicator = '', yellow = '', red = ''] of rows(str(values, 'thresholds', ''))) {
        if (!NAME.test(feature) || !NAME.test(indicator)) {
          findings.push(error('splunk.health-name', `"${feature}" / "${indicator}" is not a feature and indicator name (lower-case letters, digits and underscores). splunkd ignores a stanza it does not know.`));
          continue;
        }
        if (!/^\d+(\.\d+)?$/.test(yellow) || !/^\d+(\.\d+)?$/.test(red)) {
          findings.push(error('splunk.health-threshold', `${feature} ${indicator}: the thresholds "${yellow}" and "${red}" must both be numbers.`));
          continue;
        }
        if (Number(yellow) === Number(red)) {
          findings.push(warning('splunk.health-same-threshold', `${feature} ${indicator}: yellow and red are both ${yellow}, so the indicator goes straight from green to red and yellow never warns.`));
        }
        const key = `${feature}:${indicator}`;
        if (seen.has(key)) {
          findings.push(warning('splunk.health-duplicate', `${key} is listed twice; the later row wins.`));
        }
        seen.add(key);
        thresholds.push({ feature, indicator, yellow, red });
      }

      if (email && recipients.length === 0) {
        findings.push(error('splunk.health-no-recipient', 'Email is on but nobody is listed to receive it.'));
      }
      const badAddress = recipients.filter((r) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r));
      if (badAddress.length > 0) {
        findings.push(error('splunk.health-email', `${badAddress.join(', ')} ${badAddress.length === 1 ? 'is not an email address' : 'are not email addresses'}.`));
      }
      let host = '';
      if (webhook) {
        try {
          const parsed = new URL(url);
          host = parsed.host;
          if (parsed.protocol === 'http:') {
            findings.push(warning('splunk.health-webhook-http', `${url} is plain http: the health details, host names included, travel in clear.`, { remediation: 'Use an https endpoint.' }));
          } else if (parsed.protocol !== 'https:') {
            findings.push(error('splunk.health-webhook-url', `${url} is not an http or https URL.`));
          }
        } catch {
          findings.push(error('splunk.health-webhook-url', `"${url}" is not a URL.`));
        }
      }
      if (!email && !webhook) {
        findings.push(warning('splunk.health-no-action', 'Alerts are on but go nowhere: neither email nor a webhook is chosen. The colours change in the health report and nobody is told.'));
      }

      const snoozes: { feature: string; until: number; date: string }[] = [];
      if (snooze) {
        for (const [feature = '', date = ''] of rows(str(values, 'snoozed', ''))) {
          const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
          const until = match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 1000 : NaN;
          if (!NAME.test(feature) || !Number.isFinite(until)) {
            findings.push(error('splunk.health-snooze', `"${feature} | ${date}" is not a feature and a YYYY-MM-DD date.`));
            continue;
          }
          if (until * 1000 < Date.now()) {
            findings.push(warning('splunk.health-snooze-past', `${feature} is snoozed until ${date}, which has passed; the snooze does nothing.`));
          }
          snoozes.push({ feature, until, date });
        }
      }
      for (const m of muted) {
        if (!NAME.test(m)) findings.push(error('splunk.health-muted-name', `"${m}" is not a feature name.`));
      }

      // One stanza per feature, whatever combination of thresholds, mute and snooze it has.
      const features = [...new Set([...thresholds.map((t) => t.feature), ...muted.filter((m) => NAME.test(m)), ...snoozes.map((s) => s.feature)])];
      const featureStanzas = features.flatMap((feature) => [
        `[feature:${feature}]`,
        ...thresholds.filter((t) => t.feature === feature).flatMap((t) => [`indicator:${t.indicator}:yellow = ${t.yellow}`, `indicator:${t.indicator}:red = ${t.red}`]),
        ...(muted.includes(feature) ? ['# Alerts off for this feature; its colour still shows in the health report.', 'alert.disabled = 1'] : []),
        ...snoozes.filter((s) => s.feature === feature).flatMap((s) => [`# Snoozed until ${s.date} 00:00 UTC.`, `snooze_end_time = ${s.until}`]),
        '',
      ]);
      const allowPattern = host ? `^https://${host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/.*$` : '';

      return {
        tier: TIER,
        title: `Health report: ${thresholds.length} tuned ${thresholds.length === 1 ? 'indicator' : 'indicators'}, alerts at ${color} by ${[email ? 'email' : '', webhook ? 'webhook' : ''].filter(Boolean).join(' and ') || 'nothing'}`,
        app,
        activation: 'restart',
        notes: [
          'Install it on each instance whose health report should use these thresholds, and on the monitoring console for the distributed health report. health.conf is read by splunkd on that node only.',
          'VERIFY: every feature and indicator name against $SPLUNK_HOME/etc/system/default/health.conf for your version (splunk btool health list --debug). A name splunkd does not know is ignored without an error.',
          'Some indicators are worse when higher (percentages of skipped searches) and some when lower (disk space as a multiple of minFreeSpace); yellow and red follow the same direction as the default for that indicator.',
          ...(email ? ['Email uses the mail server in alert_actions.conf [email] on this node. Check it sends before relying on it.'] : []),
          ...(webhook ? [`default/alert_actions.conf puts ${host} on the webhook allow list (allowlist.health_report). VERIFY that your version applies the webhook allow list to health report alerts as well as to saved searches.`] : []),
        ],
        before: [
          'splunk btool health list --debug',
          ...thresholds.slice(0, 3).map((t) => `splunk btool health list feature:${t.feature} --debug`),
          ...(email ? ['splunk btool alert_actions list email --debug | grep -E "mailserver|use_tls|use_ssl"'] : []),
        ],
        files: {
          'default/health.conf': [
            '# Alerts on, at the colour chosen, once a feature has been in it this long.',
            '[health_reporter]',
            'alert.disabled = 0',
            `alert.threshold_color = ${color}`,
            `alert.min_duration_sec = ${minDuration}`,
            '',
            ...featureStanzas,
            ...(email ? ['[alert_action:email]', 'disabled = 0', `action.to = ${recipients.join(',')}`, ''] : []),
            ...(webhook ? ['[alert_action:webhook]', 'disabled = 0', `action.url = ${url}`, ''] : []),
          ],
          ...(webhook && allowPattern ? { 'default/alert_actions.conf': ['# Health report alerts may post only to this endpoint.', '[webhook]', `allowlist.health_report = ${allowPattern}`] } : {}),
          'metadata/default.meta': defaultMeta(),
        },
        verify: [
          'splunk btool health list --debug | grep -v "system/default"',
          'index=_internal source=*health.log earliest=-1h | stats latest(color) as color by node_path   # VERIFY field names',
          'index=_internal sourcetype=splunkd component=HealthReporter* log_level!=INFO earliest=-1h | stats count by message',
          ...(email ? ['index=_internal sourcetype=splunk_python sendemail earliest=-24h | stats count by log_level'] : []),
        ],
        backout: [`rm -rf $SPLUNK_HOME/etc/apps/${app} && splunk restart`],
        findings,
      };
    },
  });
}

export const MANAGEMENT_10X_BLUEPRINTS: readonly SplunkBlueprint[] = [distributedSearch(), kvstoreUpgrade(), healthReport()];
