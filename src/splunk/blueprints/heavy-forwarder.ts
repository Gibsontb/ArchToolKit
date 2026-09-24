/**
 * Splunk heavy forwarder: the collection tier that has to understand the data
 * before it sends it.
 *
 * Syslog, HEC, the cloud add-ons and DB Connect all land here, and they share
 * one property: the failure is quiet. UDP drops under load and nothing counts
 * what was lost. A drop rule with a loose regex discards a sourcetype and the
 * dashboards simply go flat. A HEC token without an index list writes wherever
 * the client says. Two readers on one Event Hub consumer group steal each
 * other's partitions and each sees half the data. A batch DB input on a large
 * table re-indexes the whole table every run, and the first anyone hears of it
 * is the licence warning.
 *
 * No generated file holds a credential. HEC tokens, database passwords and
 * cloud secrets are read by the scripts from mode-600 files, or entered once
 * in the add-on's own UI, which keeps them in Splunk's credential store. They
 * reach curl through a private header file or a config on stdin, never as an
 * argument, where anyone on the host can read them from the process list.
 */

import { bool, num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, info, warning, type Finding } from '../../core/findings.ts';
import { splunkBlueprint, type SplunkBlueprint } from '../from-app.ts';
import { defaultMeta, listOf, splunkName, type SplunkApp } from '../splunk.ts';

const TIER = 'heavy_forwarder' as const;

// --- helpers ---------------------------------------------------------------

/**
 * A shell script as a template, with bash's own `${...}` written `\${...}`.
 *
 * String.raw keeps backslashes as they are, so `\n` in a printf stays `\n`;
 * the one thing it cannot leave alone is `${`, which is interpolation.
 */
function script(strings: TemplateStringsArray, ...values: unknown[]): string[] {
  return String.raw(strings, ...values)
    .replace(/\\\$\{/g, '${')
    .replace(/^\n/, '')
    .split('\n');
}

/** A value safe inside bash single quotes. */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Lines of a textarea, with comments and blanks dropped. */
function rows(value: string): string[] {
  return String(value ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

/** The columns of a `a | b | c` row. */
function cols(line: string): string[] {
  return line.split('|').map((part) => part.trim());
}

/** A regex that matches nearly anything is a regex that will drop nearly everything. */
function tooBroad(pattern: string): boolean {
  const p = pattern.trim();
  if (!p) return true;
  if (/^\^?\.[*+]?\$?$/.test(p)) return true;
  if (/^\(?\.[*+]\)?/.test(p) && p.length < 12) return true;
  if (/^\\[dwsS][+*]?$/.test(p)) return true;
  if (p.length < 4 && !/^\\b/.test(p)) return true;
  return false;
}

/** The shared bash prelude for Splunk REST: private files, a private work dir, one curl. */
function restPrelude(): string[] {
  return script`
die() { printf 'error: %s\n' "$*" >&2; exit 2; }
note() { printf '%s\n' "$*" >&2; }

# A secret file must be readable by its owner only. Anything looser and this
# script refuses, because the secret has already leaked to whoever else can read it.
check_private() {
  local f=$1 mode
  [ -f "$f" ] || die "not found: $f"
  mode=$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f")
  case "$mode" in
    600|400) ;;
    *) die "$f is mode $mode. Run: chmod 600 $f  (refusing to use a secret other users can read)" ;;
  esac
}

command -v curl >/dev/null || die "curl is required"
command -v jq >/dev/null || die "jq is required"

umask 077
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

CURL_TLS=()
[ -n "$CA_FILE" ] && CURL_TLS=(--cacert "$CA_FILE")

# The Authorization header goes in a private file and reaches curl through -H @file,
# so the token is never an argument and never shows up in ps or shell history.
load_token() {
  check_private "$TOKEN_FILE"
  local t=""
  IFS= read -r t < "$TOKEN_FILE" || [ -n "$t" ]
  t=\${t%$'\r'}
  [ -n "$t" ] || die "$TOKEN_FILE is empty"
  printf 'Authorization: Bearer %s\n' "$t" > "$WORK/auth.h"
}

# api METHOD PATH [curl args...]  - prints the body, fails on HTTP errors.
api() {
  local method=$1 path=$2; shift 2
  curl -sS --fail -X "$method" -H @"$WORK/auth.h" \${CURL_TLS[@]+"\${CURL_TLS[@]}"} \
    "$SPLUNK_URL$path" "$@"
}

enc() { jq -rn --arg v "$1" '$v|@uri'; }
`;
}

/** A dry-run wrapper for cloud CLIs: runs the command, or prints it when --dry-run was given. */
function runWrapper(): string[] {
  return script`
# Every change goes through run: executed when run, only printed with --dry-run.
run() {
  if [ "$EXECUTE" = 1 ]; then
    "$@"
  else
    printf 'would run:'; printf ' %q' "$@"; printf '\n'
  fi
}
`;
}

// --- SC4S ------------------------------------------------------------------

/** The indexes SC4S maps its sources to out of the box (SC4S docs, "Splunk setup"). */
const SC4S_INDEXES = ['email', 'epav', 'epintel', 'fireeye', 'gitops', 'infraops', 'netauth', 'netdlp', 'netdns', 'netfw', 'netids', 'netipam', 'netlb', 'netops', 'netproxy', 'netwaf', 'osnix', 'oswinsec', 'print'];

const SC4S_PROTOCOLS: Record<string, string> = { udp: 'UDP', tcp: 'TCP', tls: 'TLS', rfc6587: 'RFC6587', rfc5426: 'RFC5426' };

// --- AWS -------------------------------------------------------------------

const AWS_DECODERS: Record<string, string> = {
  CloudTrail: 'aws:cloudtrail',
  VPCFlowLogs: 'aws:cloudwatchlogs:vpcflow',
  ELBAccessLogs: 'aws:elb:accesslogs',
  S3AccessLogs: 'aws:s3:accesslogs',
  CloudFrontAccessLogs: 'aws:cloudfront:accesslogs',
  Config: 'aws:config',
};

/** https://sqs.eu-west-2.amazonaws.com/111122223333/name → its ARN and region. */
function sqsArn(url: string): { arn: string; region: string } | null {
  const m = /^https:\/\/sqs\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?\/(\d{12})\/([A-Za-z0-9_.-]+)$/.exec(url.trim());
  if (!m) return null;
  return { arn: `arn:aws:sqs:${m[1]}:${m[2]}:${m[3]}`, region: m[1]! };
}

// --- DB Connect ------------------------------------------------------------

const DBX_TYPES: Record<string, { type: string; port: number; driver: string }> = {
  mssql: { type: 'generic_mssql', port: 1433, driver: 'Splunk DBX Add-on for Microsoft SQL Server JDBC' },
  oracle: { type: 'oracle', port: 1521, driver: 'Splunk DBX Add-on for Oracle JDBC' },
  postgres: { type: 'postgres', port: 5432, driver: 'Splunk DBX Add-on for Postgres JDBC' },
  mysql: { type: 'mysql', port: 3306, driver: 'Splunk DBX Add-on for MySQL JDBC' },
};

// --- blueprints ------------------------------------------------------------

export const HEAVY_FORWARDER_BLUEPRINTS: readonly SplunkBlueprint[] = [
  // 5. Splunk Connect for Syslog --------------------------------------------
  splunkBlueprint({
    id: 'splunk_sc4s',
    tier: TIER,
    label: 'Syslog: SC4S or rsyslog to files',
    group: 'Syslog',
    description: 'Splunk Connect for Syslog in a container under systemd, with dedicated ports per vendor, a TLS listener, index overrides and the HEC token from a secret — or the classic alternative: rsyslog writing per-host files that a forwarder monitors, with logrotate.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_syslog' },
      { id: 'collector', label: 'Collector', control: 'select', default: 'sc4s', options: [
        { value: 'sc4s', label: 'SC4S — Splunk Connect for Syslog, straight to HEC' },
        { value: 'rsyslog', label: 'rsyslog to per-host files, read by a forwarder' },
      ] },
      { id: 'runtime', label: 'Container runtime', control: 'select', default: 'podman', options: [
        { value: 'podman', label: 'Podman — the token as a podman secret' },
        { value: 'docker', label: 'Docker — the token in a separate mode-600 env file' },
      ], showWhen: { input: 'collector', equals: ['sc4s'] } },
      { id: 'hec_url', label: 'HEC URL', control: 'text', default: 'https://splunk-hec.corp.example.com:8088', hint: 'The indexers’ HEC, through a load balancer', showWhen: { input: 'collector', equals: ['sc4s'] } },
      { id: 'tls_verify', label: 'Verify the HEC certificate', control: 'toggle', default: true, showWhen: { input: 'collector', equals: ['sc4s'] } },
      { id: 'tls_listener', label: 'TLS syslog listener on 6514', control: 'toggle', default: true, showWhen: { input: 'collector', equals: ['sc4s'] } },
      { id: 'sources', label: 'Dedicated ports', control: 'textarea', default: 'cisco_asa | udp | 5005 | cisco:asa | netfw\npan_panos | tcp | 5010 | pan:log | netfw\nfortinet_fortios | udp | 5015 | fortigate_log | netfw', hint: 'vendor_product | udp/tcp/tls/rfc6587 | port | sourcetype | index — the last two are used by rsyslog; SC4S decides them itself' },
      { id: 'overrides', label: 'Index overrides (splunk_metadata.csv)', control: 'textarea', default: 'pan_panos_threat | netids', hint: 'SC4S key | index', showWhen: { input: 'collector', equals: ['sc4s'] } },
      { id: 'peak_eps', label: 'Peak events per second, all sources', control: 'number', default: 3000, min: 1, max: 10000000 },
      { id: 'log_root', label: 'Log root', control: 'text', default: '/var/log/remote', showWhen: { input: 'collector', equals: ['rsyslog'] } },
      { id: 'keep_days', label: 'Days kept on disk', control: 'number', default: 7, min: 1, max: 365, showWhen: { input: 'collector', equals: ['rsyslog'] } },
    ],
    app: (values: BlueprintValues): SplunkApp => {
      const app = splunkName(str(values, 'app_name', 'org_syslog'), 'org_syslog');
      const collector = str(values, 'collector', 'sc4s');
      const runtime = str(values, 'runtime', 'podman');
      const hecUrl = str(values, 'hec_url', '').trim();
      const tlsVerify = bool(values, 'tls_verify', true);
      const tlsListener = bool(values, 'tls_listener', true);
      const eps = num(values, 'peak_eps', 3000);
      const logRoot = (str(values, 'log_root', '/var/log/remote').trim() || '/var/log/remote').replace(/\/+$/, '');
      const keepDays = num(values, 'keep_days', 7);
      const findings: Finding[] = [];

      const sources = rows(str(values, 'sources', ''))
        .map((line) => {
          const [vp = '', proto = 'udp', port = '', sourcetype = '', index = ''] = cols(line);
          return { vp: splunkName(vp, ''), proto: proto.toLowerCase(), port: Number(port) || 0, sourcetype: sourcetype || 'syslog', index: splunkName(index, 'main') };
        })
        .filter((s) => s.vp && s.port > 0);
      const overrides = rows(str(values, 'overrides', ''))
        .map((line) => {
          const [key = '', index = ''] = cols(line);
          return { key: splunkName(key, ''), index: splunkName(index, '') };
        })
        .filter((o) => o.key && o.index);

      for (const s of sources) {
        if (!SC4S_PROTOCOLS[s.proto]) {
          findings.push(error('splunk.sc4s-protocol', `"${s.proto}" for ${s.vp} is not a protocol SC4S listens on. Use udp, tcp, tls, rfc6587 or rfc5426.`, { source: 'SC4S docs — sources' }));
        }
        if (s.port < 1024 && collector === 'rsyslog') {
          findings.push(info('splunk.syslog-low-port', `${s.vp} on port ${s.port} needs rsyslog to bind a privileged port; it does as root, but a non-root rsyslog needs CAP_NET_BIND_SERVICE.`, { source: 'ArchToolKit' }));
        }
      }
      const seenPorts = new Map<string, string>();
      for (const s of sources) {
        const key = `${s.proto === 'udp' ? 'udp' : 'tcp'}/${s.port}`;
        const other = seenPorts.get(key);
        if (other) findings.push(error('splunk.syslog-port-clash', `${s.vp} and ${other} both listen on ${key}. The second one will fail to bind.`, { source: 'ArchToolKit' }));
        seenPorts.set(key, s.vp);
      }
      const udpOnly = sources.length > 0 && sources.every((s) => s.proto === 'udp');
      if (eps >= 5000 && (udpOnly || sources.length === 0)) {
        findings.push(
          warning('splunk.syslog-udp-high-volume', `At ${eps} events/second everything arrives over UDP. UDP has no back-pressure: when the receive buffer is full the kernel discards datagrams, and nothing on either side counts what was lost.`, {
            remediation: 'Move the high-volume sources to TCP or TLS on their own ports, raise net.core.rmem_max as ops/sysctl does, and watch netstat -su for receive buffer errors.',
            source: 'SC4S docs — performance and UDP',
          }),
        );
      }
      if (sources.length === 0 && eps >= 1000) {
        findings.push(
          warning('splunk.syslog-no-dedicated-ports', `No dedicated ports: every source shares 514 at ${eps} events/second. SC4S then identifies each message by its content, which is slower, and a device whose format does not match a parser lands in the fallback sourcetype.`, {
            remediation: 'Give each high-volume vendor its own port (SC4S_LISTEN_<VENDOR>_<PRODUCT>_<PROTOCOL>_PORT), so the port decides the parser.',
            source: 'SC4S docs — sources',
          }),
        );
      }
      if (collector === 'rsyslog' && sources.length === 0) {
        findings.push(error('splunk.rsyslog-no-sources', 'rsyslog to files needs at least one dedicated port: the port is what decides the directory, and the directory decides the sourcetype and index.', { source: 'ArchToolKit' }));
      }

      if (collector === 'sc4s') {
        if (!/^https:\/\//.test(hecUrl)) {
          findings.push(warning('splunk.sc4s-hec-plaintext', `The HEC URL "${hecUrl}" is not https. Every syslog message, and the HEC token with each request, crosses the network in clear.`, { source: 'ArchToolKit' }));
        }
        if (!tlsVerify) {
          findings.push(warning('splunk.sc4s-no-tls-verify', 'SC4S will accept any certificate from the HEC endpoint, so anything that can intercept the connection receives the token and the data.', { remediation: 'Leave TLS verification on and put the issuing CA in /opt/sc4s/tls/trusted.pem.', source: 'ArchToolKit' }));
        }

        const envFile = [
          '# /opt/sc4s/env_file — read by the container at start.',
          '# The HEC token is deliberately not in this file. It reaches the container',
          runtime === 'podman'
            ? '# as the podman secret sc4s_hec_token (see ops/sc4s-setup.sh), so it is never on disk in clear here.'
            : '# from /opt/sc4s/hec_token.env, mode 600, written by ops/sc4s-setup.sh from a token file.',
          '',
          '# The indexers’ HEC, through a load balancer. SC4S must send to the indexers',
          '# directly, not through a heavy forwarder. VERIFY the separator if you list',
          '# several URLs instead of a load balancer.',
          `SC4S_DEST_SPLUNK_HEC_DEFAULT_URL=${hecUrl}`,
          `SC4S_DEST_SPLUNK_HEC_DEFAULT_TLS_VERIFY=${tlsVerify ? 'yes' : 'no'}`,
          '',
          '# Disk buffer: when HEC is unreachable, events queue on disk under',
          '# /var/lib/syslog-ng instead of being dropped. On by default; stated here',
          '# so nobody turns it off without noticing.',
          'SC4S_DEST_SPLUNK_HEC_DEFAULT_DISKBUFF_ENABLE=yes',
          'SC4S_DEST_SPLUNK_HEC_DEFAULT_DISKBUFF_RELIABLE=no',
          '',
          ...(tlsListener
            ? [
                '# TLS listener. The key and certificate are /opt/sc4s/tls/server.key and',
                '# server.pem (PEM, key without a passphrase); extra CAs go in trusted.pem.',
                'SC4S_SOURCE_TLS_ENABLE=yes',
                'SC4S_LISTEN_DEFAULT_TLS_PORT=6514',
                '',
              ]
            : []),
          '# Dedicated ports: the port, not the message content, picks the parser.',
          '# Format: SC4S_LISTEN_<VENDOR>_<PRODUCT>_<PROTOCOL>_PORT, comma-separated',
          '# ports with no spaces.',
          ...sources.map((s) => `SC4S_LISTEN_${s.vp.toUpperCase()}_${SC4S_PROTOCOLS[s.proto] ?? 'UDP'}_PORT=${s.port}`),
          ...(sources.some((s) => s.vp === 'fortinet_fortios')
            ? ['', '# Fortinet add-on 1.6 and later expects fortigate_* sourcetypes, not fgt_*.', 'SC4S_OPTION_FORTINET_SOURCETYPE_PREFIX=fortigate']
            : []),
        ];

        const metadataCsv = [
          '# /opt/sc4s/local/context/splunk_metadata.csv — key,metadata,value.',
          '# Only overrides go here; every key not listed keeps SC4S’s own index.',
          ...overrides.map((o) => `${o.key},index,${o.index}`),
        ];

        const podmanUnit = [
          '# /etc/systemd/system/sc4s.service',
          '[Unit]',
          'Description=SC4S Container',
          'Wants=NetworkManager.service network-online.target',
          'After=NetworkManager.service network-online.target',
          '',
          '[Install]',
          'WantedBy=multi-user.target',
          '',
          '[Service]',
          '# Pin a released version in production instead of latest, so a restart is not an upgrade.',
          'Environment="SC4S_IMAGE=ghcr.io/splunk/splunk-connect-for-syslog/container3:latest"',
          '# The disk buffer lives in this volume; losing it loses whatever was queued.',
          'Environment="SC4S_PERSIST_MOUNT=splunk-sc4s-var:/var/lib/syslog-ng"',
          'Environment="SC4S_LOCAL_MOUNT=/opt/sc4s/local:/etc/syslog-ng/conf.d/local:z"',
          'Environment="SC4S_ARCHIVE_MOUNT=/opt/sc4s/archive:/var/lib/syslog-ng/archive:z"',
          'Environment="SC4S_TLS_MOUNT=/opt/sc4s/tls:/etc/syslog-ng/tls:z"',
          'TimeoutStartSec=0',
          'ExecStartPre=/usr/bin/podman pull $SC4S_IMAGE',
          'ExecStartPre=/usr/bin/bash -c "/usr/bin/systemctl set-environment SC4SHOST=$(hostname -s)"',
          '# The token is injected from the podman secret as an environment variable.',
          'ExecStart=/usr/bin/podman run \\',
          '        -e "SC4S_CONTAINER_HOST=${SC4SHOST}" \\',
          '        -v "$SC4S_PERSIST_MOUNT" \\',
          '        -v "$SC4S_LOCAL_MOUNT" \\',
          '        -v "$SC4S_ARCHIVE_MOUNT" \\',
          '        -v "$SC4S_TLS_MOUNT" \\',
          '        --env-file=/opt/sc4s/env_file \\',
          '        --secret=sc4s_hec_token,type=env,target=SC4S_DEST_SPLUNK_HEC_DEFAULT_TOKEN \\',
          '        --health-cmd="/healthcheck.sh" \\',
          '        --health-interval=10s --health-retries=6 --health-timeout=6s \\',
          '        --network host \\',
          '        --name SC4S \\',
          '        --rm $SC4S_IMAGE',
          'Restart=on-abnormal',
        ];
        const dockerUnit = [
          '# /etc/systemd/system/sc4s.service',
          '[Unit]',
          'Description=SC4S Container',
          'Wants=NetworkManager.service network-online.target docker.service',
          'After=NetworkManager.service network-online.target docker.service',
          'Requires=docker.service',
          '',
          '[Install]',
          'WantedBy=multi-user.target',
          '',
          '[Service]',
          '# Pin a released version in production instead of latest, so a restart is not an upgrade.',
          'Environment="SC4S_IMAGE=ghcr.io/splunk/splunk-connect-for-syslog/container3:latest"',
          'Environment="SC4S_PERSIST_MOUNT=splunk-sc4s-var:/var/lib/syslog-ng"',
          'Environment="SC4S_LOCAL_MOUNT=/opt/sc4s/local:/etc/syslog-ng/conf.d/local:z"',
          'Environment="SC4S_ARCHIVE_MOUNT=/opt/sc4s/archive:/var/lib/syslog-ng/archive:z"',
          'Environment="SC4S_TLS_MOUNT=/opt/sc4s/tls:/etc/syslog-ng/tls:z"',
          'TimeoutStartSec=0',
          'ExecStartPre=/usr/bin/docker pull $SC4S_IMAGE',
          'ExecStartPre=/usr/bin/bash -c "/usr/bin/systemctl set-environment SC4SHOST=$(hostname -s)"',
          'ExecStartPre=-/usr/bin/docker rm -f SC4S',
          '# Two env files: the settings, and the token alone in a mode-600 file.',
          'ExecStart=/usr/bin/docker run \\',
          '        -e "SC4S_CONTAINER_HOST=${SC4SHOST}" \\',
          '        -v "$SC4S_PERSIST_MOUNT" \\',
          '        -v "$SC4S_LOCAL_MOUNT" \\',
          '        -v "$SC4S_ARCHIVE_MOUNT" \\',
          '        -v "$SC4S_TLS_MOUNT" \\',
          '        --env-file=/opt/sc4s/env_file \\',
          '        --env-file=/opt/sc4s/hec_token.env \\',
          '        --health-cmd="/healthcheck.sh" \\',
          '        --health-interval=10s --health-retries=6 --health-timeout=6s \\',
          '        --network host \\',
          '        --name SC4S \\',
          '        --rm $SC4S_IMAGE',
          'Restart=on-abnormal',
        ];

        const setup = [
          '#!/usr/bin/env bash',
          '# Install SC4S from this app’s ops/ directory. Run as root on the syslog host.',
          '#',
          '# usage: sc4s-setup.sh --hec-token-file /root/.sc4s/hec.token [--dry-run]',
          '#',
          '# The token file must be mode 600. Its content reaches',
          runtime === 'podman' ? '# podman secret create on stdin, never as an argument.' : '# /opt/sc4s/hec_token.env (mode 600) through a redirect, never as an argument.',
          'set -euo pipefail',
          'SRC=$(cd "$(dirname "$0")" && pwd)',
          'HEC_TOKEN_FILE=""; EXECUTE=1',
          'while [ $# -gt 0 ]; do',
          '  case $1 in',
          '    --hec-token-file) HEC_TOKEN_FILE=$2; shift 2 ;;',
          '    --dry-run) EXECUTE=0; shift ;;',
          '    *) printf "unknown option: %s\\n" "$1" >&2; exit 2 ;;',
          '  esac',
          'done',
          ...script`
die() { printf 'error: %s\n' "$*" >&2; exit 2; }
[ -n "$HEC_TOKEN_FILE" ] || die "--hec-token-file is required"
[ -f "$HEC_TOKEN_FILE" ] || die "not found: $HEC_TOKEN_FILE"
mode=$(stat -c %a "$HEC_TOKEN_FILE")
case "$mode" in 600|400) ;; *) die "$HEC_TOKEN_FILE is mode $mode; chmod 600 it first" ;; esac
[ "$(id -u)" = 0 ] || [ "$EXECUTE" = 0 ] || die "run as root"
command -v ${runtime} >/dev/null || die "${runtime} is not installed"
`,
          ...runWrapper(),
          ...script`
umask 077
run mkdir -p /opt/sc4s/local/context /opt/sc4s/archive /opt/sc4s/tls
run install -m 0644 "$SRC/env_file" /opt/sc4s/env_file
run install -m 0644 "$SRC/splunk_metadata.csv" /opt/sc4s/local/context/splunk_metadata.csv
run install -m 0644 "$SRC/sc4s.service" /etc/systemd/system/sc4s.service
run install -m 0644 "$SRC/sysctl-sc4s.conf" /etc/sysctl.d/60-sc4s.conf
run sysctl --system
run ${runtime} volume create splunk-sc4s-var
`,
          ...(runtime === 'podman'
            ? script`
# The secret is created from stdin with the trailing newline stripped; a newline
# would become part of the token and every HEC request would fail with 403.
if [ "$EXECUTE" = 1 ]; then
  podman secret rm sc4s_hec_token >/dev/null 2>&1 || true
  tr -d '\r\n' < "$HEC_TOKEN_FILE" | podman secret create sc4s_hec_token - >/dev/null
  printf 'podman secret sc4s_hec_token created\n' >&2
else
  printf 'would create podman secret sc4s_hec_token from %s (stdin)\n' "$HEC_TOKEN_FILE"
fi
`
            : script`
# The token goes in its own env file, mode 600, written through a redirect.
if [ "$EXECUTE" = 1 ]; then
  { printf 'SC4S_DEST_SPLUNK_HEC_DEFAULT_TOKEN='; tr -d '\r\n' < "$HEC_TOKEN_FILE"; printf '\n'; } > /opt/sc4s/hec_token.env
  chmod 600 /opt/sc4s/hec_token.env
  printf '/opt/sc4s/hec_token.env written (mode 600)\n' >&2
else
  printf 'would write /opt/sc4s/hec_token.env (mode 600) from %s\n' "$HEC_TOKEN_FILE"
fi
`),
          ...script`
${tlsListener ? '[ -f /opt/sc4s/tls/server.pem ] && [ -f /opt/sc4s/tls/server.key ] || printf "note: put server.pem and server.key in /opt/sc4s/tls before starting, or the TLS listener fails\\n" >&2' : ': # no TLS listener'}
run systemctl daemon-reload
run systemctl enable --now sc4s
printf 'Next: journalctl -u sc4s -f   and search index=* sourcetype=sc4s:events\n' >&2
`,
        ];

        const indexesConf = [
          '# For the INDEXERS (via the cluster manager), not this host. SC4S expects',
          '# these to exist; a message for an index that does not exist is rejected',
          '# by HEC with a 400 and SC4S retries it until the disk buffer fills.',
          '# _metrics (SC4S operational metrics) already exists as a metrics index.',
          ...[...new Set([...SC4S_INDEXES, ...overrides.map((o) => o.index)])].flatMap((index) => [
            `[${index}]`,
            `homePath = $SPLUNK_DB/${index}/db`,
            `coldPath = $SPLUNK_DB/${index}/colddb`,
            `thawedPath = $SPLUNK_DB/${index}/thaweddb`,
            '',
          ]),
        ];

        const sysctl = [
          '# /etc/sysctl.d/60-sc4s.conf',
          '# A bigger UDP receive buffer is the difference between a burst being',
          '# absorbed and a burst being dropped by the kernel. The values are the ones',
          '# the SC4S docs recommend.',
          'net.core.rmem_default = 17039360',
          'net.core.rmem_max = 17039360',
          '# The container runtime needs forwarding for host networking.',
          'net.ipv4.ip_forward = 1',
        ];

        return {
          tier: TIER,
          title: `SC4S syslog on ${runtime}: ${sources.length} dedicated port${sources.length === 1 ? '' : 's'}${tlsListener ? ' + TLS 6514' : ''}`,
          app,
          activation: 'reload',
          notes: [
            'SC4S is not a Splunk app: the files under ops/ are copied onto the syslog host by ops/sc4s-setup.sh. The app directory is a convenient way to version and ship them; nothing in splunkd changes.',
            `Create one HEC token for SC4S on the indexers first. Leave its allowed indexes blank or list every index SC4S writes to, including _metrics: a message for an index outside the list gets a 400 from HEC. Leave indexer acknowledgement off for this token (VERIFY against the SC4S docs for your version).`,
            'SC4S sends to the indexers’ HEC directly. Putting a heavy forwarder between them adds a parsing hop that SC4S already did, and a single point of failure.',
            'Run at least two SC4S hosts behind a network load balancer or an anycast/VRRP address for UDP. A syslog source that sends to one IP has no retry: when that host is down, the messages are gone.',
            'Index overrides: splunk_metadata.csv keys are SC4S’s own vendor_product keys (cisco_asa, pan_panos_traffic, pan_panos_threat, fortinet_fortios_traffic…). Find a source’s key on its page in the SC4S docs.',
            `Expected indexes: ${SC4S_INDEXES.join(', ')} and _metrics. ops/indexes.conf creates them for the indexers.`,
            'VERIFY: the dedicated-port variable name of each vendor on its SC4S source page — most follow SC4S_LISTEN_<VENDOR>_<PRODUCT>_<PROTOCOL>_PORT, but a few use other names (PAN-OS documents SC4S_LISTEN_PAN_PANOS_TCP_PORT and an RFC6587 variant).',
            runtime === 'podman' ? 'VERIFY: --secret with type=env needs podman 3.1 or later.' : 'Docker reads both env files at start; hec_token.env stays mode 600 and root-owned.',
          ],
          before: [
            `curl -sS -o /dev/null -w '%{http_code}\\n' ${hecUrl}/services/collector/health   # 200 from the syslog host`,
            `${runtime} --version`,
            'ss -lunt | grep -E ":(514|6514|601)\\b"   # nothing else already listening',
            '| rest /services/data/indexes splunk_server=* | search title IN (netfw, netops, netids, osnix) | stats count by title   # on the search head: the indexes exist',
          ],
          files: {
            'ops/env_file': envFile,
            'ops/splunk_metadata.csv': metadataCsv,
            'ops/sc4s.service': runtime === 'podman' ? podmanUnit : dockerUnit,
            'ops/sysctl-sc4s.conf': sysctl,
            'ops/sc4s-setup.sh': setup,
            ...(runtime === 'docker' ? { 'ops/hec_token.env.example': ['# Written by sc4s-setup.sh to /opt/sc4s/hec_token.env, mode 600. Never commit the real one.', 'SC4S_DEST_SPLUNK_HEC_DEFAULT_TOKEN=<REQUIRED — written by sc4s-setup.sh from the token file>'] } : {}),
            'ops/indexes.conf': indexesConf,
          },
          verify: [
            'systemctl status sc4s; journalctl -u sc4s -n 50 --no-pager',
            `${runtime} exec SC4S /healthcheck.sh && echo healthy`,
            'logger -n 127.0.0.1 -P 514 -d "sc4s test from $(hostname)"   # then search for it',
            'index=* sourcetype=sc4s:events earliest=-15m | stats count by host   # SC4S startup and self-check events',
            'index=netfw earliest=-15m | stats count by sourcetype, host',
            'index=* sourcetype=sc4s:fallback earliest=-24h | stats count by host   # messages no parser recognised — each host here needs a dedicated port or a filter',
            'netstat -su | grep -Ei "receive buffer errors|packet receive errors"   # rising numbers are UDP loss',
          ],
          backout: [
            'systemctl disable --now sc4s',
            `${runtime} volume inspect splunk-sc4s-var   # the disk buffer: drain or keep it before removing`,
            'rm /etc/systemd/system/sc4s.service && systemctl daemon-reload',
            runtime === 'podman' ? 'podman secret rm sc4s_hec_token' : 'rm -f /opt/sc4s/hec_token.env',
            '# Point the devices back at the previous collector before stopping this one.',
          ],
          findings,
        };
      }

      // --- rsyslog to files, read by a forwarder ------------------------------
      const rootDepth = logRoot.split('/').filter(Boolean).length;
      const hostSegment = rootDepth + 2;
      const rsyslog = [
        '# /etc/rsyslog.d/60-splunk-remote.conf',
        '# One port per vendor, one directory per vendor, one file per sending host.',
        '# The forwarder then takes sourcetype and index from the directory and the',
        '# host from the path — nothing depends on parsing the message.',
        'module(load="imudp")',
        'module(load="imtcp")',
        '',
        ...sources.flatMap((s) => [
          `template(name="t_${s.vp}" type="string" string="${logRoot}/${s.vp}/%FROMHOST%/syslog.log")`,
          `ruleset(name="rs_${s.vp}") {`,
          `  action(type="omfile" dynaFile="t_${s.vp}" dirCreateMode="0750" fileCreateMode="0640" asyncWriting="on" flushOnTXEnd="off" ioBufferSize="64k")`,
          '  stop',
          '}',
          ...(s.proto === 'tls'
            ? [`# TLS for ${s.vp}: needs the gtls stream driver and certificates configured`, '# globally for imtcp (VERIFY for your rsyslog version); listening as TCP here.']
            : []),
          `input(type="${s.proto === 'udp' ? 'imudp' : 'imtcp'}" port="${s.port}" ruleset="rs_${s.vp}")`,
          '',
        ]),
        '# %FROMHOST% is the sender as rsyslog sees it (reverse DNS, or the IP).',
        '# The hostname inside the message is often missing or wrong on appliances.',
      ];
      const logrotate = [
        `# /etc/logrotate.d/splunk-remote`,
        `# Daily, ${keepDays} days kept. delaycompress leaves yesterday’s file readable,`,
        '# so the forwarder can finish it after the rename; compressed files are',
        '# excluded by the monitor stanza and never re-read.',
        `${logRoot}/*/*/syslog.log {`,
        '    daily',
        `    rotate ${keepDays}`,
        '    missingok',
        '    notifempty',
        '    compress',
        '    delaycompress',
        '    sharedscripts',
        '    postrotate',
        '        /usr/bin/systemctl kill -s HUP rsyslog.service >/dev/null 2>&1 || true',
        '    endscript',
        '}',
      ];
      const inputs = sources.flatMap((s) => [
        `# ${s.vp}: port ${s.proto}/${s.port}. host_segment ${hostSegment} is the directory under ${logRoot}/${s.vp}/.`,
        `[monitor://${logRoot}/${s.vp}]`,
        `whitelist = /syslog\\.log(\\.1)?$`,
        `host_segment = ${hostSegment}`,
        `sourcetype = ${s.sourcetype}`,
        `index = ${s.index}`,
        'disabled = 0',
        '',
      ]);

      return {
        tier: TIER,
        title: `Syslog with rsyslog to files: ${sources.length} source${sources.length === 1 ? '' : 's'} under ${logRoot}`,
        app,
        activation: 'restart',
        notes: [
          'The app itself holds the monitor stanzas and goes on the forwarder running on the syslog host (universal or heavy). The rsyslog and logrotate files under ops/ are copied into /etc by hand or configuration management.',
          'The files are the buffer: if the indexers are unreachable, the forwarder stops reading and rsyslog keeps writing. Size the disk for the outage you want to survive — peak events/second × average event size × seconds of outage.',
          `At ${eps} events/second, check the disk: roughly ${Math.ceil((eps * 400 * 86400) / 1024 ** 3)}GB a day at 400 bytes an event, before compression.`,
          'syslog-ng is equivalent: a source per port, a destination file("/var/log/remote/<vendor>/${HOST}/syslog.log" create-dirs(yes)), and the same monitor stanzas.',
          'SELinux: rsyslog may only bind the ports it is allowed; semanage port -a -t syslogd_port_t -p udp <port> for each.',
          'Make sure the add-on for each vendor (Cisco ASA, Palo Alto Networks, Fortinet FortiGate) is on the indexers or this forwarder if it is heavy, or the sourcetype will not be split and extracted.',
        ],
        before: [
          'rsyslogd -N1 -f /etc/rsyslog.d/60-splunk-remote.conf   # syntax check',
          'ss -lunt | grep -E ":(514|5005|5010|5015)\\b"',
          `df -h ${logRoot}`,
          'splunk cmd btool inputs list monitor --debug',
        ],
        files: {
          'default/inputs.conf': inputs,
          'ops/rsyslog.d/60-splunk-remote.conf': rsyslog,
          'ops/logrotate.d/splunk-remote': logrotate,
          'metadata/default.meta': defaultMeta(),
        },
        verify: [
          `ls ${logRoot}/*/   # one directory per sending host`,
          'logrotate -d /etc/logrotate.d/splunk-remote',
          'splunk list monitor | grep remote',
          ...sources.slice(0, 3).map((s) => `index=${s.index} sourcetype=${s.sourcetype} earliest=-15m | stats count by host`),
          'index=_internal sourcetype=splunkd component=TailReader OR component=WatchedFile log_level!=INFO earliest=-1h | stats count by message',
        ],
        backout: [
          `rm -rf $SPLUNK_HOME/etc/apps/${app} && splunk restart`,
          'rm /etc/rsyslog.d/60-splunk-remote.conf && systemctl restart rsyslog',
          `# The files under ${logRoot} stay until logrotate removes them.`,
        ],
        findings,
      };
    },
  }),

  // 6. Heavy forwarder routing ---------------------------------------------
  splunkBlueprint({
    id: 'splunk_hf_routing',
    tier: TIER,
    label: 'Routing, filtering and cloning',
    group: 'Routing',
    description: 'Route events by host, source or sourcetype and a regex: to another indexer group, to a third-party syslog receiver, to both, or to nullQueue — plus CLONE_SOURCETYPE — with the forwarder not indexing locally.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_hf_routing' },
      { id: 'default_group', label: 'Default output group', control: 'text', default: 'primary_indexers' },
      { id: 'groups', label: 'Indexer groups', control: 'textarea', default: 'primary_indexers | idx1.corp.example.com:9997, idx2.corp.example.com:9997\nsoc_siem | soc-idx.partner.example.com:9997', hint: 'name | host:port, host:port' },
      { id: 'syslog_groups', label: 'Syslog receivers', control: 'textarea', default: 'legacy_siem | siem.corp.example.com:514 | tcp', hint: 'name | host:port | tcp/udp' },
      { id: 'rules', label: 'Rules', control: 'textarea', default: 'sourcetype:pan:log | ,TRAFFIC,start, | drop |\nsourcetype:pan:log | ,THREAT, | copy | soc_siem\nhost:dmz-* | . | syslog | legacy_siem\nsourcetype:linux_secure | sshd\\[\\d+\\] | clone | linux_secure:sshd', hint: 'sourcetype:X, host:X or source:X | regex | drop / route / copy / syslog / clone | target' },
      { id: 'index_locally', label: 'Also index on this forwarder', control: 'toggle', default: false },
      { id: 'use_ack', label: 'Indexer acknowledgement (useACK)', control: 'toggle', default: true },
      { id: 'tls', label: 'TLS to the indexer groups', control: 'toggle', default: true },
      { id: 'tls_versions', label: 'TLS versions', control: 'select', default: 'tls1.2', options: [
        { value: 'tls1.2', label: 'TLS 1.2' },
        { value: 'tls1.2, tls1.3', label: 'TLS 1.2 and 1.3' },
      ], showWhen: { input: 'tls', equals: ['true'] } },
      { id: 'client_cert', label: 'Forwarder certificate (clientCert)', control: 'text', default: '$SPLUNK_HOME/etc/auth/mycerts/hf-client.pem', hint: 'Certificate and key in one PEM', showWhen: { input: 'tls', equals: ['true'] } },
      { id: 'compressed', label: 'Compress on the wire', control: 'toggle', default: false, hint: 'Splunk-to-Splunk compression; the receiving port needs compressed = true too' },
    ],
    app: (values: BlueprintValues): SplunkApp => {
      const app = splunkName(str(values, 'app_name', 'org_hf_routing'), 'org_hf_routing');
      const defaultGroup = splunkName(str(values, 'default_group', 'primary_indexers'), 'primary_indexers');
      const indexLocally = bool(values, 'index_locally', false);
      const useAck = bool(values, 'use_ack', true);
      const tls = bool(values, 'tls', true);
      const tlsVersions = str(values, 'tls_versions', 'tls1.2') === 'tls1.2, tls1.3' ? 'tls1.2, tls1.3' : 'tls1.2';
      const clientCert = str(values, 'client_cert', '$SPLUNK_HOME/etc/auth/mycerts/hf-client.pem').trim();
      const compressed = bool(values, 'compressed', false);
      const findings: Finding[] = [];
      if (tls && !clientCert) {
        findings.push(error('splunk.routing-no-cert', 'TLS is on but no forwarder certificate (clientCert) is given, so no indexer group can be reached over TLS.', { source: 'outputs.conf spec' }));
      }
      if (!tls) {
        findings.push(warning('splunk.routing-plaintext', 'Without TLS, everything this forwarder sends to the indexer groups crosses the network in clear — including the copies sent to another organisation.', { source: 'ArchToolKit' }));
      }

      const groups = rows(str(values, 'groups', '')).map((line) => {
        const [name = '', servers = ''] = cols(line);
        return { name: splunkName(name, ''), servers: listOf(servers) };
      }).filter((g) => g.name);
      const syslogGroups = rows(str(values, 'syslog_groups', '')).map((line) => {
        const [name = '', server = '', type = 'tcp'] = cols(line);
        return { name: splunkName(name, ''), server, type: type.toLowerCase() === 'udp' ? 'udp' : 'tcp' };
      }).filter((g) => g.name && g.server);
      const groupNames = new Set(groups.map((g) => g.name));
      const syslogNames = new Set(syslogGroups.map((g) => g.name));

      type Rule = { n: number; stanza: string; on: string; regex: string; action: string; target: string };
      const rules: Rule[] = [];
      rows(str(values, 'rules', '')).forEach((line, i) => {
        const [on = '', regex = '', action = '', target = ''] = cols(line);
        const m = /^(sourcetype|host|source):(.+)$/.exec(on);
        const act = action.toLowerCase();
        if (!m) {
          findings.push(error('splunk.routing-bad-match', `Rule ${i + 1}: "${on}" must be sourcetype:<name>, host:<pattern> or source:<pattern>.`, { source: 'ArchToolKit' }));
          return;
        }
        if (!['drop', 'route', 'copy', 'syslog', 'clone'].includes(act)) {
          findings.push(error('splunk.routing-bad-action', `Rule ${i + 1}: "${action}" is not drop, route, copy, syslog or clone.`, { source: 'ArchToolKit' }));
          return;
        }
        const stanza = m[1] === 'sourcetype' ? `[${m[2]}]` : `[${m[1]}::${m[2]}]`;
        rules.push({ n: i + 1, stanza, on, regex, action: act, target });
      });

      for (const r of rules) {
        if (r.action === 'drop' && tooBroad(r.regex)) {
          findings.push(
            error('splunk.routing-broad-drop', `Rule ${r.n} sends everything matching "${r.regex || '(empty)'}" on ${r.on} to nullQueue — which is effectively all of it. Dropped events are not indexed, not counted and cannot be recovered, and the only symptom is dashboards going quiet.`, {
              remediation: 'Anchor the regex to something specific in the event (a field value, a log type), test it with | regex on indexed data first, and if the intent really is to drop the whole source, stop collecting it at the input instead.',
              source: 'ArchToolKit',
            }),
          );
        }
        if ((r.action === 'route' || r.action === 'copy') && !listOf(r.target).every((t) => groupNames.has(splunkName(t, '')))) {
          findings.push(error('splunk.routing-unknown-group', `Rule ${r.n} routes to "${r.target}", which is not one of the indexer groups. Events routed to a group that does not exist are dropped by the output processor.`, { source: 'ArchToolKit' }));
        }
        if (r.action === 'syslog' && !syslogNames.has(splunkName(r.target, ''))) {
          findings.push(error('splunk.routing-unknown-syslog', `Rule ${r.n} sends to syslog group "${r.target}", which is not defined.`, { source: 'ArchToolKit' }));
        }
        if (r.action === 'clone' && !r.target) {
          findings.push(error('splunk.routing-clone-target', `Rule ${r.n} clones without naming the new sourcetype.`, { source: 'ArchToolKit' }));
        }
        if (r.action === 'clone') {
          findings.push(info('splunk.routing-clone-licence', `Rule ${r.n} indexes each matching event twice (as ${r.on.split(':').slice(1).join(':')} and as ${r.target}); both copies count against the licence.`, { source: 'ArchToolKit' }));
        }
      }
      if (!groupNames.has(defaultGroup)) {
        findings.push(error('splunk.routing-no-default-group', `The default group "${defaultGroup}" is not in the indexer groups, so everything not explicitly routed has nowhere to go.`, { source: 'ArchToolKit' }));
      }
      if (rules.some((r) => r.action === 'syslog' || r.action === 'copy' || r.action === 'route')) {
        findings.push(
          warning('splunk.routing-blocking-group', 'With more than one output group, a group that cannot deliver blocks the whole pipeline once its queue is full — a third-party receiver going down stops delivery to your own indexers too.', {
            remediation: 'Set dropEventsOnQueueFull on the secondary tcpout groups (as generated here) so they shed their copy instead of blocking, and monitor them.',
            source: 'outputs.conf.spec — dropEventsOnQueueFull, blockOnCloning',
          }),
        );
      }

      const transformName = (r: Rule) => `hf_${r.action}_${r.n}`;
      const byStanza = new Map<string, Rule[]>();
      for (const r of rules) byStanza.set(r.stanza, [...(byStanza.get(r.stanza) ?? []), r]);

      const props = [
        '# Index-time transforms, applied here because this forwarder parses the data.',
        '# Once parsed, the indexers do not parse it again, so these do not belong on',
        '# the indexers as well.',
        '#',
        '# Transforms in one class run left to right. For the queue, the last',
        '# transform to set it wins, which is how "drop everything except X" is',
        '# written: a nullQueue transform first, then an indexQueue one.',
        '#',
        '# A props stanza binds to the sourcetype the event ARRIVED with. A sourcetype',
        '# that another transform assigns (pan:log becoming pan:traffic in the Palo',
        '# Alto add-on) never triggers its own TRANSFORMS- here — match the original.',
        ...[...byStanza.entries()].flatMap(([stanza, rs]) => [stanza, `TRANSFORMS-hf_routing = ${rs.map(transformName).join(', ')}`, '']),
      ];

      const transforms = rules.flatMap((r) => {
        const head = [`# Rule ${r.n}: ${r.on}, /${r.regex}/ → ${r.action}${r.target ? ` ${r.target}` : ''}`, `[${transformName(r)}]`, `REGEX = ${r.regex || '.'}`];
        switch (r.action) {
          case 'drop':
            return [...head, 'DEST_KEY = queue', 'FORMAT = nullQueue', ''];
          case 'route':
            return [...head, '# Only to this group: _TCP_ROUTING replaces the default group for these events.', 'DEST_KEY = _TCP_ROUTING', `FORMAT = ${listOf(r.target).map((t) => splunkName(t, '')).join(',')}`, ''];
          case 'copy':
            return [...head, '# To the default group AND this one — listing both is what makes it a copy.', 'DEST_KEY = _TCP_ROUTING', `FORMAT = ${[defaultGroup, ...listOf(r.target).map((t) => splunkName(t, ''))].join(',')}`, ''];
          case 'syslog':
            return [...head, '# Sent as syslog in addition to the normal tcpout delivery.', 'DEST_KEY = _SYSLOG_ROUTING', `FORMAT = ${splunkName(r.target, '')}`, ''];
          default:
            return [...head, '# The clone goes through parsing again under the new sourcetype, so its', '# own props (and routing) apply to it.', `CLONE_SOURCETYPE = ${r.target}`, ''];
        }
      });

      const outputs = [
        '[tcpout]',
        `defaultGroup = ${defaultGroup}`,
        ...(indexLocally
          ? ['# This forwarder also indexes a local copy. That needs a licence and disk, and', '# it is searchable only if a search head is pointed at it.', 'indexAndForward = true']
          : ['# Forward only. A heavy forwarder is a full Splunk instance and will happily', '# index a copy locally if told to; it should not.', 'indexAndForward = false']),
        '',
        ...groups.flatMap((g) => [
          `[tcpout:${g.name}]`,
          `server = ${g.servers.join(', ')}`,
          `useACK = ${useAck}`,
          ...(tls
            ? [
                '# The CA chain is sslRootCAPath in server.conf [sslConfig]; the key password',
                '# (sslPassword) goes in local/outputs.conf on the forwarder.',
                `clientCert = ${clientCert}`,
                `sslVersions = ${tlsVersions}`,
                'sslVerifyServerCert = true',
                'sslVerifyServerName = true',
              ]
            : []),
          ...(compressed ? ['compressed = true'] : []),
          ...(g.name !== defaultGroup
            ? ['# A secondary destination sheds its copy after 60 seconds of being unable to', '# deliver, rather than blocking delivery to the default group.', 'dropEventsOnQueueFull = 60']
            : []),
          '',
        ]),
        ...syslogGroups.flatMap((g) => [
          '# Only events routed with _SYSLOG_ROUTING go here; there is no default syslog group.',
          `[syslog:${g.name}]`,
          `server = ${g.server}`,
          `type = ${g.type}`,
          '# <13> is user.notice. The receiver gets _raw with this header prepended.',
          'priority = <13>',
          ...(g.type === 'udp' ? ['# UDP: anything over 1024 bytes is truncated by many receivers.', 'maxEventSize = 1024'] : []),
          '',
        ]),
      ];

      return {
        tier: TIER,
        title: `Heavy forwarder routing: ${rules.length} rule${rules.length === 1 ? '' : 's'} over ${groups.length} indexer group${groups.length === 1 ? '' : 's'}${syslogGroups.length ? ` and ${syslogGroups.length} syslog` : ''}`,
        app,
        activation: 'restart',
        notes: [
          'Routing only acts on data this forwarder parses: inputs it runs itself, and data from universal forwarders. Data already parsed ("cooked") by another heavy forwarder passes through untouched.',
          'nullQueue drops are permanent and silent. Before deploying a drop rule, run its regex over a day of indexed data: index=<idx> sourcetype=<st> | regex _raw="<regex>" | stats count — that count is what disappears.',
          'Syslog output sends _raw after parsing, not the original datagram; a receiver that expects the device’s own header may need timestampformat or a different priority.',
          ...(tls
            ? [`Every indexer group is TLS ${tlsVersions === 'tls1.2' ? '1.2' : '1.2 or 1.3'} with the indexer certificate and host name verified. A group run by another organisation usually needs its own clientCert and CA: change that group’s stanza, and put its CA in the bundle sslRootCAPath points at.`]
            : []),
          'Deploy to the heavy forwarders through their own serverclass; a restart is needed for props, transforms and outputs.',
        ],
        before: [
          'splunk cmd btool outputs list --debug',
          'splunk cmd btool props list --debug | grep -B2 TRANSFORMS',
          ...rules.filter((r) => r.action === 'drop').map((r) => `index=* ${r.on.startsWith('sourcetype:') ? `sourcetype=${r.on.slice(11)}` : r.on.replace(':', '=')} earliest=-24h | regex _raw="${r.regex}" | stats count   # what rule ${r.n} would drop per day`),
          ...syslogGroups.map((g) => `nc -vz ${g.server.replace(':', ' ')}   # reachability of ${g.name}`),
        ],
        files: {
          'default/props.conf': props,
          'default/transforms.conf': transforms,
          'default/outputs.conf': outputs,
          'metadata/default.meta': defaultMeta(),
        },
        verify: [
          'splunk list forward-server',
          'splunk cmd btool transforms list --debug | grep -A4 "^\\[hf_"',
          'index=_internal host=<this forwarder> source=*metrics.log group=tcpout_connections earliest=-15m | stats sum(kb) by name   # every group is receiving',
          'index=_internal host=<this forwarder> source=*metrics.log group=queue earliest=-15m | stats max(current_size_kb) by name   # a queue that stays full is a blocked group',
          ...rules.filter((r) => r.action === 'clone').map((r) => `index=* sourcetype=${r.target} earliest=-15m | stats count by host`),
          'index=_internal host=<this forwarder> component=TcpOutputProc log_level!=INFO earliest=-1h | stats count by message',
        ],
        backout: [
          `rm -rf $SPLUNK_HOME/etc/apps/${app}`,
          'splunk restart',
          '# Events dropped while the rules were in place are not recoverable.',
        ],
        findings,
      };
    },
  }),

  // 7. HTTP Event Collector -------------------------------------------------
  splunkBlueprint({
    id: 'splunk_hec',
    tier: TIER,
    label: 'HTTP Event Collector',
    group: 'HEC',
    description: 'HEC on the heavy forwarders: TLS on 8088, thread settings, one token restricted to the indexes it may write, the token created through REST and saved to a private file, client examples with and without acknowledgement, and the load-balancer rule ACK needs.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_hec' },
      { id: 'port', label: 'HEC port', control: 'number', default: 8088, min: 1, max: 65535 },
      { id: 'ssl', label: 'TLS', control: 'toggle', default: true },
      { id: 'io_threads', label: 'Dedicated I/O threads', control: 'number', default: 2, min: 0, max: 64, hint: 'Roughly one per 2–4 cores on a HEC-only forwarder' },
      { id: 'token_name', label: 'Token name', control: 'text', default: 'app_events' },
      { id: 'default_index', label: 'Default index', control: 'text', default: 'app_prod' },
      { id: 'allowed_indexes', label: 'Allowed indexes', control: 'textarea', default: 'app_prod\napp_dev', hint: 'Empty = any index' },
      { id: 'sourcetype', label: 'Default sourcetype', control: 'text', default: 'app:events' },
      { id: 'use_ack', label: 'Indexer acknowledgement (useACK)', control: 'toggle', default: false },
      { id: 'lb', label: 'In front of the forwarders', control: 'select', default: 'sticky', options: [
        { value: 'none', label: 'Nothing — one forwarder' },
        { value: 'sticky', label: 'A load balancer with sticky sessions' },
        { value: 'roundrobin', label: 'A load balancer, round robin, no stickiness' },
      ] },
      { id: 'token_source', label: 'How the token is made', control: 'select', default: 'rest', options: [
        { value: 'rest', label: 'Splunk generates it — ops/create-hec-token.sh through REST' },
        { value: 'conf', label: 'Stanza in inputs.conf, value set in local/ on each forwarder' },
      ] },
      { id: 'splunk_url', label: 'Management URL', control: 'text', default: 'https://hf1.corp.example.com:8089' },
      { id: 'hec_url', label: 'HEC URL clients use', control: 'text', default: 'https://hec.corp.example.com:8088' },
    ],
    app: (values: BlueprintValues): SplunkApp => {
      const app = splunkName(str(values, 'app_name', 'org_hec'), 'org_hec');
      const port = num(values, 'port', 8088);
      const ssl = bool(values, 'ssl', true);
      const ioThreads = num(values, 'io_threads', 2);
      const tokenName = splunkName(str(values, 'token_name', 'app_events'), 'app_events');
      const defaultIndex = splunkName(str(values, 'default_index', 'app_prod'), 'main');
      const allowed = listOf(str(values, 'allowed_indexes', '')).map((i) => splunkName(i, '')).filter(Boolean);
      const sourcetype = str(values, 'sourcetype', 'app:events').trim() || 'app:events';
      const useAck = bool(values, 'use_ack', false);
      const lb = str(values, 'lb', 'sticky');
      const tokenSource = str(values, 'token_source', 'rest');
      const splunkUrl = str(values, 'splunk_url', 'https://localhost:8089').trim();
      const hecUrl = str(values, 'hec_url', 'https://localhost:8088').trim();
      const findings: Finding[] = [];

      if (allowed.length === 0) {
        findings.push(
          warning('splunk.hec-any-index', `Token ${tokenName} has no allowed index list, so any client holding it can write to any index — including _internal, _audit or another team’s security index — just by naming it in the event.`, {
            remediation: 'List the indexes this token may write to. The default index must be one of them.',
            source: 'inputs.conf.spec — [http://<name>] indexes',
          }),
        );
      } else if (!allowed.includes(defaultIndex)) {
        findings.push(error('splunk.hec-default-not-allowed', `The default index ${defaultIndex} is not in the allowed list (${allowed.join(', ')}). Every event that does not name an index will be rejected.`, { source: 'ArchToolKit' }));
      }
      if (useAck && lb === 'roundrobin') {
        findings.push(
          error('splunk.hec-ack-no-sticky', 'Acknowledgement is on behind a round-robin load balancer. The client polls /services/collector/ack on whichever forwarder the balancer picks, which is usually not the one that holds its ack IDs, so acks never come back and the client resends — duplicates, and eventually a full channel.', {
            remediation: 'Make the balancer sticky (by its own cookie, or by source IP), or turn acknowledgement off for this token.',
            source: 'docs.splunk.com — About HTTP Event Collector indexer acknowledgment',
          }),
        );
      }
      if (!ssl) {
        findings.push(warning('splunk.hec-no-tls', 'HEC without TLS sends the token in clear with every request. Anyone who can see the traffic can write to these indexes.', { source: 'ArchToolKit' }));
      }
      if (useAck) {
        findings.push(info('splunk.hec-ack-cost', 'With acknowledgement, the client must send a channel id with every request and poll for acks; clients that do neither get errors. Enable it only for clients written to use it (Firehose, the OpenTelemetry collector, your own).', { source: 'ArchToolKit' }));
      }

      const tokenStanza = [
        `[http://${tokenName}]`,
        ...(tokenSource === 'conf'
          ? [
              '# The token value is never in this file. On each forwarder, put the same',
              '# GUID in local/inputs.conf under this stanza (every forwarder behind the',
              '# load balancer must accept the same token), then set disabled = 0 there.',
              'token = <REQUIRED — generated by Splunk; set in local/ on each forwarder>',
              'disabled = 1',
            ]
          : []),
        `index = ${defaultIndex}`,
        ...(allowed.length > 0 ? ['# The only indexes an event may name; anything else is rejected with an error.', `indexes = ${allowed.join(',')}`] : ['# No indexes list: the client may write to any index.']),
        `sourcetype = ${sourcetype}`,
        `useACK = ${useAck ? 1 : 0}`,
        '# Behind a load balancer, take the client address from X-Forwarded-For (VERIFY',
        '# proxied_ip is accepted for HEC tokens on your version).',
        `connection_host = ${lb === 'none' ? 'ip' : 'proxied_ip'}`,
        '# Never allow ?token= in the URL: it lands in proxy and access logs.',
        'allowQueryStringAuth = false',
      ];

      const inputs = [
        '# Global HEC settings. They apply to every token on this instance. This app',
        '# sorts before splunk_httpinput, whose default has HEC disabled, so these win.',
        '[http]',
        'disabled = 0',
        `port = ${port}`,
        `enableSSL = ${ssl ? 1 : 0}`,
        ...(ssl
          ? [
              '# Replace Splunk’s default certificate, which is identical on every install.',
              'serverCert = $SPLUNK_HOME/etc/auth/hec/server.pem',
              '# The key passphrase is set in local/ (Splunk encrypts it on restart), never here.',
              'sslPassword =',
              'sslVersions = tls1.2',
            ]
          : []),
        '# Threads that do nothing but network I/O for HEC. 0 lets Splunk decide;',
        '# VERIFY the default for your version before relying on it.',
        `dedicatedIoThreads = ${ioThreads}`,
        '# Threads for TLS processing; 0 = one per CPU.',
        'maxThreads = 0',
        '# Concurrent connections; 0 = derived from the file descriptor limit.',
        'maxSockets = 0',
        '# Tokens are managed on this instance, not pushed from a deployment server.',
        'useDeploymentServer = 0',
        '',
        ...(tokenSource === 'conf'
          ? tokenStanza
          : [
              '# The token stanza is created by ops/create-hec-token.sh through REST, which',
              '# writes it — with the GUID Splunk generates — to this app’s local/inputs.conf:',
              ...tokenStanza.map((l) => `#   ${l}`),
              '#   token = <generated by Splunk>',
            ]),
      ];

      const createScript = [
        '#!/usr/bin/env bash',
        `# Create HEC token "${tokenName}" through REST and save the value to a private file.`,
        '#',
        '# usage: create-hec-token.sh --token-file ~/.splunk/admin.token --out ~/.splunk/hec-' + tokenName + '.token \\',
        '#          [--use-existing-token FILE] [--url https://hf:8089] [--cacert ca.pem] [--dry-run]',
        '#',
        '# First forwarder: Splunk generates the GUID and the script writes it to --out',
        '# (mode 600). Every other forwarder behind the same load balancer: pass that',
        '# file as --use-existing-token so they all accept the same token. VERIFY that',
        '# your version accepts the token parameter on create.',
        '#',
        '# The value is never printed and never an argument: it goes to curl in a config',
        '# on stdin (curl -K -) and comes back into a file through jq.',
        'set -euo pipefail',
        `SPLUNK_URL=${shq(splunkUrl)}`,
        `APP=${shq(app)}`,
        `NAME=${shq(tokenName)}`,
        `INDEX=${shq(defaultIndex)}`,
        `INDEXES=${shq(allowed.join(','))}`,
        `SOURCETYPE=${shq(sourcetype)}`,
        `USEACK=${useAck ? 1 : 0}`,
        'TOKEN_FILE=""; OUT_FILE=""; EXISTING_FILE=""; CA_FILE=""; EXECUTE=1',
        'while [ $# -gt 0 ]; do',
        '  case $1 in',
        '    --url) SPLUNK_URL=$2; shift 2 ;;',
        '    --token-file) TOKEN_FILE=$2; shift 2 ;;',
        '    --out) OUT_FILE=$2; shift 2 ;;',
        '    --use-existing-token) EXISTING_FILE=$2; shift 2 ;;',
        '    --cacert) CA_FILE=$2; shift 2 ;;',
        '    --dry-run) EXECUTE=0; shift ;;',
        '    *) printf "unknown option: %s\\n" "$1" >&2; exit 2 ;;',
        '  esac',
        'done',
        '',
        ...restPrelude(),
        ...script`
[ -n "$TOKEN_FILE" ] || die "--token-file is required"
[ -n "$EXISTING_FILE" ] || [ -n "$OUT_FILE" ] || die "--out is required when Splunk generates the token"
load_token

EP="/servicesNS/nobody/$APP/data/inputs/http"
# The entity name of a token is http://<name>.
# 200 = exists, 404 = absent; anything else (401, 403, TLS, unreachable) stops
# here rather than being mistaken for "absent".
code=$(curl -sS -o /dev/null -w '%{http_code}' -H @"$WORK/auth.h" \${CURL_TLS[@]+"\${CURL_TLS[@]}"} \
  "$SPLUNK_URL$EP/$(enc "http://$NAME")?output_mode=json") || die "cannot reach $SPLUNK_URL"
case "$code" in
  200) note "Token $NAME already exists on $SPLUNK_URL. Nothing to do; delete it first to recreate."; exit 0 ;;
  404) ;;
  *) die "checking for token $NAME returned HTTP $code" ;;
esac

note "Would create http://$NAME in app $APP: index=$INDEX indexes=\${INDEXES:-<any>} sourcetype=$SOURCETYPE useACK=$USEACK"
if [ "$EXECUTE" != 1 ]; then
  note "Dry run: nothing was changed. Run it without --dry-run to apply."
  exit 0
fi

cfg_escape() { local s=$1; s=\${s//\\/\\\\}; s=\${s//\"/\\\"}; printf '%s' "$s"; }
{
  printf 'data-urlencode = "name=%s"\n' "$NAME"
  printf 'data-urlencode = "index=%s"\n' "$INDEX"
  [ -n "$INDEXES" ] && printf 'data-urlencode = "indexes=%s"\n' "$INDEXES"
  printf 'data-urlencode = "sourcetype=%s"\n' "$SOURCETYPE"
  printf 'data-urlencode = "useACK=%s"\n' "$USEACK"
  printf 'data-urlencode = "output_mode=json"\n'
  if [ -n "$EXISTING_FILE" ]; then
    check_private "$EXISTING_FILE"
    v=""; IFS= read -r v < "$EXISTING_FILE" || [ -n "$v" ]
    v=\${v%$'\r'}
    printf 'data-urlencode = "token=%s"\n' "$(cfg_escape "$v")"
    unset v
  fi
} | curl -sS --fail -K - -X POST -H @"$WORK/auth.h" \${CURL_TLS[@]+"\${CURL_TLS[@]}"} "$SPLUNK_URL$EP" > "$WORK/resp.json"

if [ -z "$EXISTING_FILE" ]; then
  # jq -e fails on null/absent, and "// empty" turns null into no output, so a
  # response without a token can never be written out as the string "null".
  # The value lands in a mode-600 temp file next to --out and is renamed into
  # place only once it is known to be non-empty.
  tmp_out=$(mktemp "$OUT_FILE.XXXXXX") || die "cannot write next to $OUT_FILE"
  chmod 600 "$tmp_out"
  if ! jq -er '.entry[0].content.token // empty' "$WORK/resp.json" > "$tmp_out" || [ ! -s "$tmp_out" ]; then
    rm -f "$tmp_out"
    die "Splunk answered but the response has no token (entry[0].content.token). The input may exist without a readable token: check $EP and read the token from local/inputs.conf."
  fi
  mv -f "$tmp_out" "$OUT_FILE"
  note "Token saved to $OUT_FILE (mode 600). Copy it to the other forwarders' --use-existing-token."
fi
note "Created. Test it with ops/hec-send.sh and the token file."
`,
      ];

      const sendScript = [
        '#!/usr/bin/env bash',
        '# Send test events to HEC with the token read from a mode-600 file.',
        '#',
        '# usage: hec-send.sh ~/.splunk/hec-' + tokenName + '.token [--ack] [--cacert ca.pem]',
        '#',
        '# The header is built by printf inside a process substitution, so the token',
        '# is never an argument to curl and never in ps output or shell history.',
        'set -euo pipefail',
        `HEC_URL=${shq(hecUrl)}`,
        'HEC_TOKEN_FILE=${1:?usage: hec-send.sh TOKEN_FILE [--ack] [--cacert FILE]}; shift',
        'ACK=0; CA=()',
        'while [ $# -gt 0 ]; do',
        '  case $1 in',
        '    --ack) ACK=1; shift ;;',
        '    --cacert) CA=(--cacert "$2"); shift 2 ;;',
        '    *) printf "unknown option: %s\\n" "$1" >&2; exit 2 ;;',
        '  esac',
        'done',
        ...script`
mode=$(stat -c %a "$HEC_TOKEN_FILE" 2>/dev/null || stat -f %Lp "$HEC_TOKEN_FILE")
case "$mode" in 600|400) ;; *) printf '%s is mode %s; chmod 600 it\n' "$HEC_TOKEN_FILE" "$mode" >&2; exit 2 ;; esac
auth() { printf 'Authorization: Splunk %s\n' "$(tr -d '\r\n' < "$HEC_TOKEN_FILE")"; }

if [ "$ACK" = 0 ]; then
  # Without acknowledgement: a 200 means HEC accepted it, not that it is indexed.
  curl -sS --fail \${CA[@]+"\${CA[@]}"} -H @<(auth) \
    "$HEC_URL/services/collector/event" \
    -d '{"event":{"message":"hec test","source_host":"'"$(hostname)"'"},"sourcetype":"${sourcetype}","index":"${defaultIndex}"}'
  echo
  exit 0
fi

# With acknowledgement: every request carries a channel, the response carries
# an ackId, and the client polls /ack on the SAME forwarder until it is true.
CHANNEL=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen)
resp=$(curl -sS --fail \${CA[@]+"\${CA[@]}"} -H @<(auth) -H "X-Splunk-Request-Channel: $CHANNEL" \
  "$HEC_URL/services/collector/event" \
  -d '{"event":{"message":"hec ack test"},"sourcetype":"${sourcetype}","index":"${defaultIndex}"}')
ack_id=$(printf '%s' "$resp" | jq -er '.ackId // empty') || { printf 'no ackId in the response: is useACK enabled on this token?\n' >&2; exit 1; }
printf 'channel %s ackId %s\n' "$CHANNEL" "$ack_id"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 3
  state=$(curl -sS --fail \${CA[@]+"\${CA[@]}"} -H @<(auth) -H "X-Splunk-Request-Channel: $CHANNEL" \
    "$HEC_URL/services/collector/ack" -d '{"acks":['"$ack_id"']}' | jq -r ".acks[\"$ack_id\"]")
  printf 'ack %s: %s\n' "$ack_id" "$state"
  [ "$state" = true ] && exit 0
done
printf 'not acknowledged after 30s — a non-sticky load balancer is the usual cause\n' >&2
exit 1
`,
      ];

      return {
        tier: TIER,
        title: `HEC on :${port}${ssl ? ' (TLS)' : ''}: token ${tokenName} → ${allowed.length ? allowed.join(', ') : 'any index'}${useAck ? ' with ACK' : ''}`,
        app,
        activation: 'restart',
        notes: [
          'HEC on heavy forwarders parses events here and forwards them; the indexers never see the token. Put the forwarders behind a load balancer and give clients only the balancer’s name.',
          lb === 'sticky'
            ? 'Sticky sessions: HEC acknowledgement lives on the forwarder that received the event. Make the balancer sticky by its own cookie (AWS ALB/ELB duration-based stickiness, which Kinesis Firehose requires) or by source IP. VERIFY what your clients honour — many HEC clients ignore cookies, so source-IP affinity is the safer default.'
            : lb === 'roundrobin'
              ? 'Round robin works for HEC without acknowledgement. With acknowledgement it does not; see the finding.'
              : 'A single forwarder is a single point of failure for every client using this token.',
          'Health check for the balancer: GET /services/collector/health on the HEC port — no token needed; returns 200 when HEC can accept data and 503 when its queues are full.',
          tokenSource === 'rest'
            ? `ops/create-hec-token.sh writes the token stanza into ${app}/local/inputs.conf. If a deployment server manages this app, set excludeFromUpdate = $app_root$/local in its serverclass, or the next deploy replaces local/ and the token disappears.`
            : 'The token value lives only in local/inputs.conf on each forwarder, which must be excluded from version control and from deployment-server updates (excludeFromUpdate = $app_root$/local).',
          'Rotate a token by creating a second one, moving clients, then deleting the first. A token cannot be changed in place without every client breaking at once.',
          'dedicatedIoThreads and maxThreads are starting points; VERIFY against the HEC performance guidance for your version and core count.',
        ],
        before: [
          `curl -sk -o /dev/null -w '%{http_code}\\n' ${hecUrl}/services/collector/health`,
          'splunk cmd btool inputs list http --debug',
          `| rest /services/data/indexes splunk_server=* | search title IN (${[defaultIndex, ...allowed].join(', ')}) | stats count by title   # the indexes exist on the indexers`,
          `ss -ltn | grep :${port}`,
        ],
        files: {
          'default/inputs.conf': inputs,
          ...(tokenSource === 'rest' ? { 'ops/create-hec-token.sh': createScript } : {}),
          'ops/hec-send.sh': sendScript,
          'metadata/default.meta': defaultMeta(['admin'], ['admin']),
        },
        verify: [
          `curl -sS -H @auth.h ${splunkUrl}/servicesNS/nobody/${app}/data/inputs/http?output_mode=json | jq '.entry[] | {name, index: .content.index, indexes: .content.indexes, useACK: .content.useACK, disabled: .content.disabled}'`,
          `ops/hec-send.sh ~/.splunk/hec-${tokenName}.token${useAck ? ' --ack' : ''}`,
          `index=${defaultIndex} sourcetype="${sourcetype}" earliest=-15m | stats count by host`,
          'index=_internal sourcetype=splunkd component=HttpInputDataHandler log_level!=INFO earliest=-1h | stats count by message   # invalid token, incorrect index, disabled token',
          'index=_introspection sourcetype=http_event_collector_metrics earliest=-1h | timechart sum(data.num_of_requests) by data.token_name   # VERIFY field names',
        ],
        backout: [
          `curl -sS -H @auth.h -X DELETE ${splunkUrl}/servicesNS/nobody/${app}/data/inputs/http/http%3A%2F%2F${tokenName}`,
          `rm -rf $SPLUNK_HOME/etc/apps/${app} && splunk restart`,
          '# Clients using the token get 403 from that point: move them first.',
        ],
        findings,
      };
    },
  }),

  // 8. AWS ------------------------------------------------------------------
  splunkBlueprint({
    id: 'splunk_aws',
    tier: TIER,
    label: 'AWS: SQS-based S3 inputs',
    group: 'Cloud sources',
    description: 'Splunk Add-on for AWS on a heavy forwarder: SQS-based S3 inputs for CloudTrail, VPC Flow Logs, ELB and S3 access logs, authenticated by an assumed IAM role rather than keys, with the least-privilege policy and trust policy written out.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_aws_inputs' },
      { id: 'auth', label: 'Authenticate with', control: 'select', default: 'role', options: [
        { value: 'role', label: 'The forwarder’s instance role, assuming a collector role' },
        { value: 'keys', label: 'An access key and secret key' },
      ] },
      { id: 'aws_account', label: 'Account name in the add-on', control: 'text', default: 'hf_instance_role', hint: 'Configuration > Account: the EC2 instance role the add-on discovered' },
      { id: 'role_name', label: 'IAM role name in the add-on', control: 'text', default: 'log_collector', hint: 'Configuration > IAM Role', showWhen: { input: 'auth', equals: ['role'] } },
      { id: 'role_arn', label: 'Collector role ARN', control: 'text', default: 'arn:aws:iam::111122223333:role/splunk-log-collector', showWhen: { input: 'auth', equals: ['role'] } },
      { id: 'hf_role_arn', label: 'Forwarder instance role ARN', control: 'text', default: 'arn:aws:iam::444455556666:role/splunk-hf-instance', showWhen: { input: 'auth', equals: ['role'] } },
      { id: 'input_type', label: 'Input type', control: 'select', default: 'sqs', options: [
        { value: 'sqs', label: 'SQS-based S3 — S3 event notifications to a queue' },
        { value: 'generic', label: 'Generic S3 — list the bucket' },
      ] },
      { id: 'sources', label: 'Sources', control: 'textarea', default: 'cloudtrail | CloudTrail | https://sqs.eu-west-2.amazonaws.com/111122223333/splunk-cloudtrail | aws_cloudtrail\nvpcflow | VPCFlowLogs | https://sqs.eu-west-2.amazonaws.com/111122223333/splunk-vpcflow | aws_vpcflow\nelb | ELBAccessLogs | https://sqs.eu-west-2.amazonaws.com/111122223333/splunk-elb | aws_elb\ns3access | S3AccessLogs | https://sqs.eu-west-2.amazonaws.com/111122223333/splunk-s3access | aws_s3access', hint: 'name | CloudTrail/VPCFlowLogs/ELBAccessLogs/S3AccessLogs/CloudFrontAccessLogs/Config | queue URL (bucket for generic S3) | index' },
      { id: 'buckets', label: 'Log buckets', control: 'textarea', default: 'acme-org-cloudtrail\nacme-vpcflow-logs\nacme-elb-logs\nacme-s3-access-logs' },
      { id: 'kms_key', label: 'KMS key ARN for the logs (if SSE-KMS)', control: 'text', default: '' },
      { id: 'interval', label: 'Polling interval (seconds)', control: 'number', default: 300, min: 30, max: 86400 },
    ],
    app: (values: BlueprintValues): SplunkApp => {
      const app = splunkName(str(values, 'app_name', 'org_aws_inputs'), 'org_aws_inputs');
      const keys = str(values, 'auth', 'role') === 'keys';
      const account = str(values, 'aws_account', 'hf_instance_role').trim();
      const roleName = str(values, 'role_name', 'log_collector').trim();
      const roleArn = str(values, 'role_arn', '').trim();
      const hfRoleArn = str(values, 'hf_role_arn', '').trim();
      const generic = str(values, 'input_type', 'sqs') === 'generic';
      const buckets = listOf(str(values, 'buckets', ''));
      const kmsKey = str(values, 'kms_key', '').trim();
      const interval = num(values, 'interval', 300);
      const findings: Finding[] = [];

      const sources = rows(str(values, 'sources', '')).map((line) => {
        const [name = '', decoder = '', where = '', index = ''] = cols(line);
        return { name: splunkName(name, ''), decoder, where, index: splunkName(index, 'aws') };
      }).filter((s) => s.name);

      for (const s of sources) {
        if (!AWS_DECODERS[s.decoder]) {
          findings.push(error('splunk.aws-decoder', `${s.name}: "${s.decoder}" is not one of the decoders this generates (${Object.keys(AWS_DECODERS).join(', ')}).`, { source: 'Splunk Add-on for AWS — SQS-based S3' }));
        }
        if (!generic && !sqsArn(s.where)) {
          findings.push(error('splunk.aws-queue-url', `${s.name}: "${s.where}" is not an SQS queue URL (https://sqs.<region>.amazonaws.com/<account>/<queue>).`, { source: 'ArchToolKit' }));
        }
      }
      if (keys) {
        findings.push(
          error('splunk.aws-access-keys', 'Static access keys are long-lived, sit in the add-on’s account on every forwarder that has it, and are the credential most often found leaked. The add-on uses the EC2 instance role, and can assume a role in another account, with no key at all.', {
            remediation: 'Run the forwarder on EC2 with an instance profile (or on-premises with IAM Roles Anywhere), let the add-on discover it as an account, and assume the collector role with the policies in ops/.',
            source: 'Splunk Add-on for AWS — Configure accounts / IAM roles',
          }),
        );
      }
      if (generic) {
        findings.push(
          warning('splunk.aws-generic-s3', 'The generic S3 input lists the bucket to find new objects. On a busy log bucket that listing grows without end, it cannot be spread across forwarders without duplicates, and a restart can re-read or skip objects. The add-on’s own docs recommend SQS-based S3 for scale.', {
            remediation: 'Send the bucket’s object-created notifications to SQS (through SNS if others need them) and use the SQS-based S3 input; several forwarders can then share one queue.',
            source: 'Splunk Add-on for AWS — SQS-based S3 input',
          }),
        );
      }

      const queues = generic ? [] : sources.map((s) => sqsArn(s.where)).filter((q): q is { arn: string; region: string } => q !== null);

      const inputs = sources.flatMap((s) => {
        const st = AWS_DECODERS[s.decoder] ?? 'aws:s3';
        if (generic) {
          return [
            `# ${s.name}: generic S3 — see the finding; prefer SQS-based S3.`,
            `[aws_s3://${s.name}]`,
            `aws_account = ${account}`,
            ...(keys ? [] : [`aws_iam_role = ${roleName}`]),
            `bucket_name = ${s.where}`,
            '# VERIFY the key_name prefix and host_name for your bucket region.',
            'key_name =',
            `sourcetype = ${st}`,
            `index = ${s.index}`,
            `polling_interval = ${interval}`,
            'disabled = 0',
            '',
          ];
        }
        const q = sqsArn(s.where);
        return [
          `# ${s.name}: ${s.decoder}. S3 notifies the queue of each new object; the input`,
          '# reads the message, fetches the object, and deletes the message only after',
          '# the object is indexed. Several forwarders can share one queue.',
          `[aws_sqs_based_s3://${s.name}]`,
          `aws_account = ${account}`,
          ...(keys ? [] : ['# The role the account assumes before reading. Its ARN is set in the add-on', '# (Configuration > IAM Role) under this name.', `aws_iam_role = ${roleName}`]),
          `sqs_queue_url = ${s.where}`,
          `sqs_queue_region = ${q?.region ?? '<region>'}`,
          `s3_file_decoder = ${s.decoder}`,
          `sourcetype = ${st}`,
          `index = ${s.index}`,
          `interval = ${interval}`,
          '# 1–10 messages per receive; 10 is the most efficient.',
          'sqs_batch_size = 10',
          '# Checks the queue has a dead-letter queue, so a poison message does not',
          '# loop for ever.',
          'using_dlq = 1',
          'disabled = 0',
          '',
        ];
      });

      const collectorPolicy = {
        Version: '2012-10-17',
        Statement: [
          ...(queues.length > 0
            ? [{ Sid: 'ReadQueues', Effect: 'Allow', Action: ['sqs:GetQueueUrl', 'sqs:ReceiveMessage', 'sqs:SendMessage', 'sqs:DeleteMessage', 'sqs:ChangeMessageVisibility', 'sqs:GetQueueAttributes', 'sqs:ListQueues'], Resource: queues.map((q) => q.arn) }]
            : []),
          ...(generic ? [{ Sid: 'ListBuckets', Effect: 'Allow', Action: ['s3:ListBucket', 's3:GetBucketLocation'], Resource: buckets.map((b) => `arn:aws:s3:::${b}`) }] : []),
          { Sid: 'ReadLogObjects', Effect: 'Allow', Action: ['s3:GetObject', 's3:GetObjectVersion'], Resource: buckets.map((b) => `arn:aws:s3:::${b}/*`) },
          ...(kmsKey ? [{ Sid: 'DecryptLogs', Effect: 'Allow', Action: ['kms:Decrypt'], Resource: kmsKey }] : []),
        ],
      };
      const trustPolicy = {
        Version: '2012-10-17',
        Statement: [{ Sid: 'SplunkHeavyForwarders', Effect: 'Allow', Principal: { AWS: hfRoleArn || '<forwarder instance role ARN>' }, Action: 'sts:AssumeRole' }],
      };
      const hfPolicy = {
        Version: '2012-10-17',
        Statement: [{ Sid: 'AssumeCollector', Effect: 'Allow', Action: 'sts:AssumeRole', Resource: roleArn || '<collector role ARN>' }],
      };

      return {
        tier: TIER,
        title: `AWS ${generic ? 'generic S3' : 'SQS-based S3'} inputs: ${sources.map((s) => s.decoder).join(', ')}`,
        app,
        activation: 'restart',
        notes: [
          'Install the Splunk Add-on for AWS (Splunk_TA_aws) on this heavy forwarder and on the search heads (for field extractions and CIM mapping). The inputs here reference an account and an IAM role by name; both are set up in the add-on first.',
          keys
            ? 'Access keys, if you must: enter them only in the add-on (Configuration > Account), which stores them in Splunk’s credential store. Never in a conf file.'
            : `Accounts: on EC2, the add-on discovers the instance role and lists it under Configuration > Account — use that name as "${account}". Then Configuration > IAM Role: name "${roleName}", ARN ${roleArn}. Attach ops/iam-forwarder-instance-policy.json to the forwarder role and create the collector role with ops/iam-collector-trust.json and ops/iam-collector-policy.json.`,
          'Each queue needs an S3 event notification (s3:ObjectCreated:*) from its bucket, a dead-letter queue with a redrive policy, and a visibility timeout longer than the time to fetch the largest object (the add-on docs suggest 5 minutes).',
          'CloudTrail: use the organisation trail’s bucket and one queue; do not also collect CloudTrail with the CloudTrail or CloudWatch Logs input, or events arrive twice.',
          'CloudWatch metrics: the aws_cloudwatch input polls GetMetricData and gets expensive quickly — collect metrics with the Splunk OpenTelemetry collector or Metric Streams instead. CloudWatch Logs: prefer a subscription filter to Firehose, delivering to HEC, over polling.',
          'VERIFY every stanza field name against the add-on version you install; this follows the SQS-based S3 documentation (aws_account, aws_iam_role, sqs_queue_url, sqs_queue_region, s3_file_decoder, sqs_batch_size, using_dlq).',
          'The inputs can sit in this app rather than inside Splunk_TA_aws; they then do not show on the add-on’s Inputs page. VERIFY that is acceptable to whoever operates the add-on.',
        ],
        before: [
          'aws sts get-caller-identity   # on the forwarder: the instance role',
          `aws sts assume-role --role-arn ${roleArn || '<collector role>'} --role-session-name splunk-test --query Credentials.Expiration`,
          ...queues.slice(0, 2).map((q) => `aws sqs get-queue-attributes --queue-url ${sources.find((s) => sqsArn(s.where)?.arn === q.arn)?.where} --attribute-names ApproximateNumberOfMessages RedrivePolicy VisibilityTimeout`),
          '| rest /services/data/indexes splunk_server=* | search title=aws* | stats count by title',
        ],
        files: {
          'default/inputs.conf': inputs,
          ...(keys ? {} : {
            'ops/iam-collector-policy.json': JSON.stringify(collectorPolicy, null, 2).split('\n'),
            'ops/iam-collector-trust.json': JSON.stringify(trustPolicy, null, 2).split('\n'),
            'ops/iam-forwarder-instance-policy.json': JSON.stringify(hfPolicy, null, 2).split('\n'),
          }),
          ...(keys ? { 'ops/iam-collector-policy.json': JSON.stringify(collectorPolicy, null, 2).split('\n') } : {}),
          'metadata/default.meta': defaultMeta(),
        },
        verify: [
          'splunk cmd btool inputs list aws_sqs_based_s3 --debug',
          ...sources.map((s) => `index=${s.index} sourcetype=${AWS_DECODERS[s.decoder] ?? '*'} earliest=-1h | stats count, max(_time) as latest by source | eval lag_s=now()-latest`),
          'index=_internal source=*splunk_ta_aws_aws_sqs_based_s3*.log* log_level=ERROR earliest=-1h | stats count by message   # VERIFY log file name',
          'aws sqs get-queue-attributes --queue-url <queue> --attribute-names ApproximateNumberOfMessages   # a queue that keeps growing means the input is behind',
        ],
        backout: [
          `rm -rf $SPLUNK_HOME/etc/apps/${app} && splunk restart`,
          '# Messages stay in the queues until their retention expires; re-enabling picks up from there.',
        ],
        findings,
      };
    },
  }),

  // 9. Azure ----------------------------------------------------------------
  splunkBlueprint({
    id: 'splunk_azure',
    tier: TIER,
    label: 'Azure: Event Hub, diagnostics and Entra ID',
    group: 'Cloud sources',
    description: 'Splunk Add-on for Microsoft Cloud Services reading Event Hubs on a dedicated consumer group, with an az CLI script that streams resource diagnostic logs, the Activity log and Entra ID sign-ins and audit logs to those hubs.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_azure_inputs' },
      { id: 'account', label: 'Azure app account in the add-on', control: 'text', default: 'splunk_eventhub_reader', hint: 'Configuration > Azure App Account — client secret entered there' },
      { id: 'app_id', label: 'Application (client) ID', control: 'text', default: '00000000-0000-0000-0000-000000000000' },
      { id: 'subscription', label: 'Subscription ID', control: 'text', default: '11111111-1111-1111-1111-111111111111' },
      { id: 'resource_group', label: 'Event Hub resource group', control: 'text', default: 'rg-splunk-ingest' },
      { id: 'namespace', label: 'Event Hub namespace', control: 'text', default: 'acme-splunk-ehns', hint: 'The short name; .servicebus.windows.net is added' },
      { id: 'consumer_group', label: 'Consumer group', control: 'text', default: 'splunk', hint: 'Splunk’s own, never $Default' },
      { id: 'resource_hub', label: 'Hub for resource and activity logs', control: 'text', default: 'azure-resource-logs' },
      { id: 'resource_index', label: 'Index for resource logs', control: 'text', default: 'azure' },
      { id: 'activity', label: 'Stream the subscription Activity log', control: 'toggle', default: true },
      { id: 'resources', label: 'Resources to stream diagnostics from', control: 'textarea', default: '/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-prod/providers/Microsoft.KeyVault/vaults/kv-prod\n/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-prod/providers/Microsoft.Network/azureFirewalls/fw-prod', hint: 'One resource ID per line' },
      { id: 'entra', label: 'Stream Entra ID sign-ins and audit', control: 'toggle', default: true },
      { id: 'entra_hub', label: 'Hub for Entra ID', control: 'text', default: 'entra-logs', showWhen: { input: 'entra', equals: ['true'] } },
      { id: 'entra_index', label: 'Index for Entra ID', control: 'text', default: 'azure_entra', showWhen: { input: 'entra', equals: ['true'] } },
      { id: 'forwarders', label: 'Heavy forwarders reading these hubs', control: 'number', default: 1, min: 1, max: 50 },
      { id: 'blob_checkpoint', label: 'Checkpoint in a storage account', control: 'toggle', default: false, hint: 'Needed when more than one forwarder reads a hub' },
      { id: 'storage_account', label: 'Checkpoint storage account (name in the add-on)', control: 'text', default: 'splunk_checkpoints', showWhen: { input: 'blob_checkpoint', equals: ['true'] } },
    ],
    app: (values: BlueprintValues): SplunkApp => {
      const app = splunkName(str(values, 'app_name', 'org_azure_inputs'), 'org_azure_inputs');
      const account = str(values, 'account', 'splunk_eventhub_reader').trim();
      const appId = str(values, 'app_id', '').trim();
      const subscription = str(values, 'subscription', '').trim();
      const rg = str(values, 'resource_group', '').trim();
      const nsShort = str(values, 'namespace', '').trim().replace(/\.servicebus\.windows\.net$/, '');
      const nsFqdn = `${nsShort}.servicebus.windows.net`;
      const cg = str(values, 'consumer_group', 'splunk').trim() || '$Default';
      const resourceHub = str(values, 'resource_hub', 'azure-resource-logs').trim();
      const resourceIndex = splunkName(str(values, 'resource_index', 'azure'), 'azure');
      const activity = bool(values, 'activity', true);
      const resources = rows(str(values, 'resources', ''));
      const entra = bool(values, 'entra', true);
      const entraHub = str(values, 'entra_hub', 'entra-logs').trim();
      const entraIndex = splunkName(str(values, 'entra_index', 'azure_entra'), 'azure_entra');
      const forwarders = num(values, 'forwarders', 1);
      const blob = bool(values, 'blob_checkpoint', false);
      const storage = str(values, 'storage_account', '').trim();
      const findings: Finding[] = [];

      if (/^\$?default$/i.test(cg)) {
        findings.push(
          warning('splunk.azure-shared-consumer-group', 'The input reads the $Default consumer group, which every other reader of the hub uses unless told otherwise (Stream Analytics, a Function, a second SIEM). Readers on one consumer group compete for the same partitions: each gets part of the data and checkpoints over the others.', {
            remediation: 'Create a consumer group for Splunk alone (the script does) and use it here.',
            source: 'Azure Event Hubs — consumer groups',
          }),
        );
      }
      if (forwarders > 1 && !blob) {
        findings.push(
          error('splunk.azure-multi-reader-no-checkpoint', `${forwarders} forwarders read the same hub with local checkpoints. Each keeps its own position, so every event is collected ${forwarders} times.`, {
            remediation: 'Turn on blob checkpointing with a storage account, so the forwarders share partition ownership and position — or run the input on one forwarder only.',
            source: 'Splunk Add-on for Microsoft Cloud Services — Event Hub input, blob_checkpoint_enabled',
          }),
        );
      }
      if (entra && entraHub === resourceHub && entraIndex !== resourceIndex) {
        findings.push(error('splunk.azure-hub-index-clash', 'Entra ID and resource logs share one hub but are meant for different indexes. One input reads a hub, and it has one index.', { source: 'ArchToolKit' }));
      }
      if (!/^[0-9a-f-]{36}$/i.test(appId)) {
        findings.push(warning('splunk.azure-app-id', `"${appId}" does not look like an application (client) ID; the role assignment in the script will fail.`, { source: 'ArchToolKit' }));
      }

      const hubs = [{ hub: resourceHub, index: resourceIndex, name: splunkName(`eh_${resourceHub}`, 'eh_resources') }, ...(entra && entraHub !== resourceHub ? [{ hub: entraHub, index: entraIndex, name: splunkName(`eh_${entraHub}`, 'eh_entra') }] : [])];

      const inputs = hubs.flatMap((h) => [
        `# ${h.hub} on ${nsFqdn}, consumer group ${cg}.`,
        `[mscs_azure_event_hub://${h.name}]`,
        '# The Azure app account from the add-on. Its client secret was entered in the',
        '# add-on UI and is in Splunk’s credential store — not in any file.',
        `account = ${account}`,
        `event_hub_namespace = ${nsFqdn}`,
        `event_hub_name = ${h.hub}`,
        `consumer_group = ${cg}`,
        `index = ${h.index}`,
        'sourcetype = mscs:azure:eventhub',
        '# How long to wait for a batch, and how many events per batch.',
        'max_wait_time = 300',
        'max_batch_size = 300',
        '# AMQP over WebSocket (443) passes most proxies; plain AMQP needs 5671/5672 out.',
        'use_amqp_over_websocket = 1',
        ...(blob
          ? ['# Shared checkpoints: the forwarders divide the partitions between them.', 'blob_checkpoint_enabled = 1', `storage_account = ${storage}`, `container_name = ${splunkName(`${h.hub}-checkpoints`, 'checkpoints').replace(/_/g, '-')}`]
          : ['blob_checkpoint_enabled = 0']),
        'interval = 3600',
        'disabled = 0',
        '',
      ]);

      const diag = [
        '#!/usr/bin/env bash',
        '# Create the consumer group, the send rule, the reader role assignment and the',
        '# diagnostic settings that stream logs to the hubs. Applies when run; --dry-run previews.',
        '#',
        '# usage: azure-diagnostics.sh [--dry-run]   (after az login, with rights to',
        '#        the namespace, the resources and — for Entra ID — Security Administrator)',
        'set -euo pipefail',
        'EXECUTE=1',
        '[ "${1:-}" = --dry-run ] && EXECUTE=0',
        `SUB=${shq(subscription)}`,
        `RG=${shq(rg)}`,
        `NS=${shq(nsShort)}`,
        `CG=${shq(cg)}`,
        `APP_ID=${shq(appId)}`,
        `RESOURCE_HUB=${shq(resourceHub)}`,
        `ENTRA_HUB=${shq(entraHub)}`,
        'RESOURCES=(',
        ...resources.map((r) => `  ${shq(r)}`),
        ')',
        ...runWrapper(),
        ...script`
command -v az >/dev/null || { echo "az CLI is required" >&2; exit 2; }
umask 077
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
run az account set --subscription "$SUB"

# Splunk's own consumer group on each hub, so it competes with no other reader.
for hub in "$RESOURCE_HUB"${entra && entraHub !== resourceHub ? ' "$ENTRA_HUB"' : ''}; do
  run az eventhubs eventhub consumer-group create --resource-group "$RG" --namespace-name "$NS" --eventhub-name "$hub" --name "$CG"
done

# Reader: the Splunk app registration may receive, and nothing else.
NS_ID="/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.EventHub/namespaces/$NS"
run az role assignment create --assignee "$APP_ID" --role "Azure Event Hubs Data Receiver" --scope "$NS_ID"

# Writer: diagnostic settings need a namespace rule with Manage, Send and Listen.
run az eventhubs namespace authorization-rule create --resource-group "$RG" --namespace-name "$NS" --name diag-to-splunk --rights Manage Send Listen
RULE_ID="$NS_ID/authorizationRules/diag-to-splunk"

# Resource logs: every log category (categoryGroup allLogs) to the resource hub.
for rid in "\${RESOURCES[@]}"; do
  run az monitor diagnostic-settings create --name to-splunk --resource "$rid" \
    --event-hub "$RESOURCE_HUB" --event-hub-rule "$RULE_ID" \
    --logs '[{"categoryGroup":"allLogs","enabled":true}]'
done
`,
        ...(activity
          ? script`
# The subscription Activity log. VERIFY the parameter names for your az version.
run az monitor diagnostic-settings subscription create --name to-splunk --location global \
  --event-hub-name "$RESOURCE_HUB" --event-hub-auth-rule "$RULE_ID" \
  --logs '[{"category":"Administrative","enabled":true},{"category":"Security","enabled":true},{"category":"Policy","enabled":true},{"category":"Alert","enabled":true},{"category":"ServiceHealth","enabled":true}]'
`
          : []),
        ...(entra
          ? script`
# Entra ID: tenant-level diagnostic settings, through the ARM API. Sign-in logs
# need an Entra ID P1 or P2 licence.
cat > "$WORK/entra.json" <<EOF
{
  "properties": {
    "eventHubAuthorizationRuleId": "$RULE_ID",
    "eventHubName": "$ENTRA_HUB",
    "logs": [
      {"category": "AuditLogs", "enabled": true},
      {"category": "SignInLogs", "enabled": true},
      {"category": "NonInteractiveUserSignInLogs", "enabled": true},
      {"category": "ServicePrincipalSignInLogs", "enabled": true},
      {"category": "ManagedIdentitySignInLogs", "enabled": true}
    ]
  }
}
EOF
run az rest --method put \
  --url "https://management.azure.com/providers/microsoft.aadiam/diagnosticSettings/to-splunk?api-version=2017-04-01" \
  --body @"$WORK/entra.json"
`
          : []),
        '[ "$EXECUTE" = 1 ] || echo "Dry run: nothing was changed. Run it without --dry-run to apply." >&2',
      ];

      return {
        tier: TIER,
        title: `Azure Event Hub inputs on ${nsShort}: ${hubs.map((h) => h.hub).join(', ')} (consumer group ${cg})`,
        app,
        activation: 'restart',
        notes: [
          'Install the Splunk Add-on for Microsoft Cloud Services (Splunk_TA_microsoft-cloudservices) on this forwarder and the search heads. Create the Azure app account in the add-on (Configuration > Azure App Account: client ID, tenant ID and client secret). The secret is entered there, once, and kept in Splunk’s credential store — never in a file.',
          'The client secret expires (Entra ID allows at most 24 months). Put its expiry in the team calendar; when it lapses the input stops with an authentication error and nothing else warns.',
          'Entra ID sign-ins and audit arrive as JSON records with a category field (SignInLogs, AuditLogs…); they stay sourcetype mscs:azure:eventhub. VERIFY whether your add-on version splits the records array into one event per record.',
          'One hub per kind of data keeps retention and throughput units separate. A Standard namespace with too few throughput units throttles the diagnostic settings, and Azure drops what it cannot send.',
          'Network: the forwarder needs 443 to the namespace for AMQP over WebSocket, and to login.microsoftonline.com.',
          'VERIFY the stanza name mscs_azure_event_hub:// against the add-on version you install; the field names follow its Event Hub input documentation.',
        ],
        before: [
          `az eventhubs eventhub list --resource-group ${rg} --namespace-name ${nsShort} --query "[].{name:name, partitions:partitionCount}" -o table`,
          `az eventhubs eventhub consumer-group list --resource-group ${rg} --namespace-name ${nsShort} --eventhub-name ${resourceHub} -o table`,
          `nc -vz ${nsFqdn} 443`,
          'bash ops/azure-diagnostics.sh --dry-run   # prints every change',
        ],
        files: {
          'default/inputs.conf': inputs,
          'ops/azure-diagnostics.sh': diag,
          'metadata/default.meta': defaultMeta(),
        },
        verify: [
          'splunk cmd btool inputs list mscs_azure_event_hub --debug',
          ...hubs.map((h) => `index=${h.index} sourcetype=mscs:azure:eventhub earliest=-1h | stats count by source`),
          ...(entra ? [`index=${entraIndex} sourcetype=mscs:azure:eventhub earliest=-1h | spath | stats count by category, body.category`] : []),
          'index=_internal source=*mscs_azure_event_hub*.log* (ERROR OR WARNING) earliest=-1h | stats count by message   # VERIFY log file name',
          `az monitor metrics list --resource /subscriptions/${subscription}/resourceGroups/${rg}/providers/Microsoft.EventHub/namespaces/${nsShort} --metric IncomingMessages OutgoingMessages ThrottledRequests --interval PT1H -o table`,
        ],
        backout: [
          `rm -rf $SPLUNK_HOME/etc/apps/${app} && splunk restart`,
          'az monitor diagnostic-settings delete --name to-splunk --resource <resource id>   # per resource, to stop paying for the stream',
          'az rest --method delete --url "https://management.azure.com/providers/microsoft.aadiam/diagnosticSettings/to-splunk?api-version=2017-04-01"',
        ],
        findings,
      };
    },
  }),

  // 10. Google Cloud --------------------------------------------------------
  splunkBlueprint({
    id: 'splunk_gcp',
    tier: TIER,
    label: 'Google Cloud: Pub/Sub log sink',
    group: 'Cloud sources',
    description: 'Splunk Add-on for Google Cloud Platform pulling from a Pub/Sub subscription fed by a filtered log sink, created by a gcloud script — with the service account key kept out of files, and avoided altogether where the forwarder can use an attached identity.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_gcp_inputs' },
      { id: 'scope', label: 'Sink scope', control: 'select', default: 'organization', options: [
        { value: 'project', label: 'One project' },
        { value: 'organization', label: 'The organisation, including every child project' },
      ] },
      { id: 'org_id', label: 'Organisation ID', control: 'text', default: '123456789012', showWhen: { input: 'scope', equals: ['organization'] } },
      { id: 'project', label: 'Logging project (topic and subscription)', control: 'text', default: 'acme-logging' },
      { id: 'topic', label: 'Topic', control: 'text', default: 'splunk-logs' },
      { id: 'subscription', label: 'Subscription', control: 'text', default: 'splunk-logs-sub' },
      { id: 'filter', label: 'Log filter', control: 'textarea', default: 'logName:"cloudaudit.googleapis.com"', hint: 'Logging query language; empty sends everything' },
      { id: 'service_account', label: 'Reader service account', control: 'text', default: 'splunk-reader@acme-logging.iam.gserviceaccount.com' },
      { id: 'credential', label: 'Credential', control: 'select', default: 'ui_key', options: [
        { value: 'adc', label: 'The forwarder’s attached identity (GCE service account / workload identity)' },
        { value: 'ui_key', label: 'Service account key pasted in the add-on UI' },
        { value: 'file', label: 'Key JSON file shipped with the app' },
      ] },
      { id: 'credential_name', label: 'Credential name in the add-on', control: 'text', default: 'splunk_reader' },
      { id: 'index', label: 'Index', control: 'text', default: 'gcp' },
    ],
    app: (values: BlueprintValues): SplunkApp => {
      const app = splunkName(str(values, 'app_name', 'org_gcp_inputs'), 'org_gcp_inputs');
      const scope = str(values, 'scope', 'organization');
      const orgId = str(values, 'org_id', '').trim();
      const project = str(values, 'project', 'acme-logging').trim();
      const topic = str(values, 'topic', 'splunk-logs').trim();
      const subscription = str(values, 'subscription', 'splunk-logs-sub').trim();
      const filter = str(values, 'filter', '').trim().replace(/\s*\n\s*/g, ' ');
      const sa = str(values, 'service_account', '').trim();
      const credential = str(values, 'credential', 'ui_key');
      const credName = str(values, 'credential_name', 'splunk_reader').trim();
      const index = splunkName(str(values, 'index', 'gcp'), 'gcp');
      const findings: Finding[] = [];

      if (credential === 'file') {
        findings.push(
          error('splunk.gcp-key-in-app', 'A service account key JSON shipped with the app is a non-expiring credential in every copy of the app: the deployment server, backups and version control. Anyone with the file is the service account.', {
            remediation: 'Paste the key into the add-on’s Credentials page, where it is stored encrypted, or use the attached identity and no key at all.',
            source: 'Google Cloud — best practices for managing service account keys',
          }),
        );
      } else if (credential === 'ui_key') {
        findings.push(
          info('splunk.gcp-key-rotation', 'A service account key does not expire by default. Give this one subscriber rights only (the script does), rotate it on a schedule, and consider an organisation policy that sets key expiry.', {
            source: 'Google Cloud — service account keys',
          }),
        );
      } else {
        findings.push(
          warning('splunk.gcp-adc-verify', 'Using the forwarder’s attached identity avoids a key entirely, but VERIFY that your version of the add-on can authenticate without a key JSON before depending on it; older versions require one.', { source: 'ArchToolKit' }),
        );
      }
      if (!filter) {
        findings.push(
          warning('splunk.gcp-no-filter', `The sink has no filter, so every log entry in ${scope === 'organization' ? 'every project in the organisation' : 'the project'} is exported — load balancer requests, GKE container logs and all. That is usually many times the audit volume, and it is all licence.`, {
            remediation: 'Start with audit logs (logName:"cloudaudit.googleapis.com") and add sources deliberately.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (scope === 'organization' && !/^\d+$/.test(orgId)) {
        findings.push(error('splunk.gcp-org-id', `"${orgId}" is not a numeric organisation ID.`, { source: 'ArchToolKit' }));
      }

      const pubsubConf = [
        '# Splunk_TA_google-cloudplatform/local/google_cloud_pubsub_inputs.conf',
        '# This file belongs INSIDE the add-on’s local/, not in this app: the add-on',
        '# reads its inputs from its own conf file. Creating the input in the add-on',
        '# UI (Inputs > Cloud Pub/Sub) writes the same thing. VERIFY the file name for',
        '# your version — the docs name both google_pubsub_inputs.conf and the spec',
        '# google_cloud_pubsub_inputs.conf.spec.',
        `[${splunkName(`pubsub_${subscription}`, 'pubsub')}]`,
        '# A credential defined in the add-on (Configuration > Google Credentials).',
        `google_credentials_name = ${credName}`,
        `google_project = ${project}`,
        `google_subscriptions = ${subscription}`,
        `index = ${index}`,
        '# Sourcetypes are assigned by the add-on from the log name (4.0 and later):',
        '# google:gcp:pubsub:audit:admin_activity, …:audit:data_access, …:message.',
        'disabled = 0',
      ];

      const sinkParent = scope === 'organization' ? ['--organization="$ORG"', '--include-children'] : ['--project="$LOG_PROJECT"'];
      const sink = [
        '#!/usr/bin/env bash',
        '# Topic, subscription, log sink and IAM for the Splunk Pub/Sub input. Applies when run; --dry-run previews.',
        '#',
        '# usage: gcp-log-sink.sh [--dry-run]   (after gcloud auth login, as someone who',
        `#        can create ${scope === 'organization' ? 'organisation' : 'project'} sinks and set Pub/Sub IAM)`,
        'set -euo pipefail',
        'EXECUTE=1',
        '[ "${1:-}" = --dry-run ] && EXECUTE=0',
        `LOG_PROJECT=${shq(project)}`,
        `ORG=${shq(orgId)}`,
        `TOPIC=${shq(topic)}`,
        `SUB=${shq(subscription)}`,
        `SA=${shq(sa)}`,
        `FILTER=${shq(filter)}`,
        'SINK=splunk-sink',
        ...runWrapper(),
        ...script`
command -v gcloud >/dev/null || { echo "gcloud is required" >&2; exit 2; }

run gcloud pubsub topics create "$TOPIC" --project="$LOG_PROJECT"
# Seven days of retention covers a long forwarder outage; unacknowledged
# messages are redelivered, so nothing is lost while Splunk is down.
run gcloud pubsub subscriptions create "$SUB" --project="$LOG_PROJECT" --topic="$TOPIC" \
  --ack-deadline=60 --message-retention-duration=7d

# The sink. Its filter is the licence bill: keep it deliberate.
run gcloud logging sinks create "$SINK" "pubsub.googleapis.com/projects/$LOG_PROJECT/topics/$TOPIC" \
  ${sinkParent.join(' ')} \${FILTER:+"--log-filter=$FILTER"}

# The sink writes as its own service identity, which must be allowed to publish.
if [ "$EXECUTE" = 1 ]; then
  WRITER=$(gcloud logging sinks describe "$SINK" ${sinkParent[0]} --format='value(writerIdentity)')
  [ -n "$WRITER" ] || { echo "the sink $SINK has no writerIdentity; the publisher binding cannot be made" >&2; exit 1; }
else
  WRITER='<the sink writerIdentity>'
fi
run gcloud pubsub topics add-iam-policy-binding "$TOPIC" --project="$LOG_PROJECT" \
  --member="$WRITER" --role=roles/pubsub.publisher

# The reader: subscriber on this subscription only, and nothing on the project.
run gcloud pubsub subscriptions add-iam-policy-binding "$SUB" --project="$LOG_PROJECT" \
  --member="serviceAccount:$SA" --role=roles/pubsub.subscriber
run gcloud pubsub subscriptions add-iam-policy-binding "$SUB" --project="$LOG_PROJECT" \
  --member="serviceAccount:$SA" --role=roles/pubsub.viewer
`,
        ...(credential === 'adc'
          ? ['', '# No key: attach the service account to the forwarder VM (or bind it through', '# workload identity) and let the add-on use Application Default Credentials.', 'echo "Attach $SA to the forwarder instance: gcloud compute instances set-service-account <vm> --service-account=$SA --scopes=cloud-platform" >&2']
          : ['', '# A key is needed. Create it straight into a private file, paste it into the', '# add-on UI, then delete the file: it should exist nowhere else.', 'echo "Key: (umask 077; gcloud iam service-accounts keys create ~/.gcp-splunk-key.json --iam-account=$SA) — paste it into the add-on, then shred -u ~/.gcp-splunk-key.json" >&2']),
        '[ "$EXECUTE" = 1 ] || echo "Dry run: nothing was changed. Run it without --dry-run to apply." >&2',
      ];

      return {
        tier: TIER,
        title: `GCP Pub/Sub input: ${scope === 'organization' ? `org ${orgId}` : project} → ${project}/${subscription} → index ${index}`,
        app,
        activation: 'restart',
        notes: [
          'Install the Splunk Add-on for Google Cloud Platform (Splunk_TA_google-cloudplatform) on this forwarder and the search heads. Create the credential under Configuration > Google Credentials, then the Cloud Pub/Sub input — or copy ops/google_cloud_pubsub_inputs.conf into the add-on’s local/.',
          credential === 'adc'
            ? 'No key: the forwarder authenticates as its attached service account. VERIFY add-on support first (see the finding).'
            : 'The key JSON is pasted into the add-on UI once, where Splunk encrypts it. It is not in this app, not on the deployment server and not in version control; delete the downloaded copy after pasting.',
          'Pull or push: at high volume Google’s Pub/Sub-to-Splunk Dataflow template pushes to HEC instead, and scales without the forwarder. The pull input here is simpler and fine up to a few thousand messages a second — VERIFY for your volume.',
          'An organisation sink with --include-children catches new projects automatically. A project sink misses them.',
          'The subscription has seven days of retention; if the input is down longer than that, the oldest messages are gone.',
        ],
        before: [
          `gcloud pubsub subscriptions describe ${subscription} --project=${project}`,
          `gcloud logging read '${filter.replace(/'/g, "'\\''") || 'timestamp>="-1h"'}' ${scope === 'organization' ? `--organization=${orgId}` : `--project=${project}`} --freshness=1h --limit=5   # what the filter matches`,
          'bash ops/gcp-log-sink.sh --dry-run   # preview',
        ],
        files: {
          'ops/google_cloud_pubsub_inputs.conf': pubsubConf,
          'ops/gcp-log-sink.sh': sink,
          'metadata/default.meta': defaultMeta(),
        },
        verify: [
          `gcloud logging sinks describe splunk-sink ${scope === 'organization' ? `--organization=${orgId}` : `--project=${project}`}`,
          `gcloud monitoring time-series list --project=${project} --filter='metric.type="pubsub.googleapis.com/subscription/num_undelivered_messages" AND resource.labels.subscription_id="${subscription}"' --interval-start-time=$(date -u -d '-1 hour' +%FT%TZ)   # a backlog that keeps growing means the input is behind — VERIFY command form`,
          `index=${index} sourcetype=google:gcp:pubsub:* earliest=-1h | stats count by sourcetype`,
          'index=_internal source=*google_cloud_pubsub*.log* ERROR earliest=-1h | stats count by message   # VERIFY log file name',
        ],
        backout: [
          'Disable the Pub/Sub input in the add-on, then:',
          `gcloud logging sinks delete splunk-sink ${scope === 'organization' ? `--organization=${orgId}` : `--project=${project}`}   # stops the export (and its cost)`,
          `gcloud pubsub subscriptions delete ${subscription} --project=${project}`,
          'Delete the service account key in IAM if one was created.',
        ],
        findings,
      };
    },
  }),

  // 11. DB Connect ----------------------------------------------------------
  splunkBlueprint({
    id: 'splunk_dbconnect',
    tier: TIER,
    label: 'DB Connect inputs',
    group: 'Databases',
    description: 'Splunk DB Connect on a heavy forwarder: a read-only TLS connection, the identity created through REST from a private file, and rising-column inputs with a checkpoint, query timeouts and bounded batches — batch inputs kept to small tables.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_dbx_inputs' },
      { id: 'connection', label: 'Connection name', control: 'text', default: 'erp_prod' },
      { id: 'db_type', label: 'Database', control: 'select', default: 'mssql', options: [
        { value: 'mssql', label: 'Microsoft SQL Server' },
        { value: 'oracle', label: 'Oracle' },
        { value: 'postgres', label: 'PostgreSQL' },
        { value: 'mysql', label: 'MySQL' },
      ] },
      { id: 'host', label: 'Database host', control: 'text', default: 'erp-db.corp.example.com' },
      { id: 'port', label: 'Port (0 = the default for the database)', control: 'number', default: 0, min: 0, max: 65535 },
      { id: 'database', label: 'Database / service name', control: 'text', default: 'erp' },
      { id: 'identity', label: 'Identity name', control: 'text', default: 'erp_reader' },
      { id: 'db_user', label: 'Database user', control: 'text', default: 'svc_splunk_reader' },
      { id: 'ssl', label: 'TLS to the database', control: 'toggle', default: true },
      { id: 'readonly', label: 'Read-only connection', control: 'toggle', default: true },
      { id: 'inputs', label: 'Inputs', control: 'textarea', default: 'erp_audit | rising | dbo.audit_log | audit_id | created_at | 300 | erp | erp:audit | 50000000\nerp_users | batch | dbo.app_users |  |  | 86400 | erp | erp:users | 20000', hint: 'name | rising/batch | table | rising column | timestamp column | interval s | index | sourcetype | approx rows' },
      { id: 'query_timeout', label: 'Query timeout (seconds)', control: 'number', default: 60, min: 1, max: 3600 },
      { id: 'max_rows', label: 'Max rows per run (rising)', control: 'number', default: 100000, min: 0, max: 100000000, hint: '0 = unlimited' },
      { id: 'splunk_url', label: 'Management URL of this forwarder', control: 'text', default: 'https://hf-dbx.corp.example.com:8089' },
    ],
    app: (values: BlueprintValues): SplunkApp => {
      const app = splunkName(str(values, 'app_name', 'org_dbx_inputs'), 'org_dbx_inputs');
      const connection = splunkName(str(values, 'connection', 'erp_prod'), 'erp_prod');
      const dbType = DBX_TYPES[str(values, 'db_type', 'mssql')] ?? DBX_TYPES.mssql!;
      const host = str(values, 'host', '').trim();
      const port = num(values, 'port', 0) || dbType.port;
      const database = str(values, 'database', '').trim();
      const identity = splunkName(str(values, 'identity', 'erp_reader'), 'erp_reader');
      const dbUser = str(values, 'db_user', '').trim();
      const ssl = bool(values, 'ssl', true);
      const readonly = bool(values, 'readonly', true);
      const queryTimeout = num(values, 'query_timeout', 60);
      const maxRows = num(values, 'max_rows', 100000);
      const splunkUrl = str(values, 'splunk_url', 'https://localhost:8089').trim();
      const findings: Finding[] = [];

      const dbInputs = rows(str(values, 'inputs', '')).map((line) => {
        const [name = '', mode = 'rising', table = '', rising = '', ts = '', interval = '', index = '', sourcetype = '', approx = ''] = cols(line);
        return {
          name: splunkName(name, ''),
          mode: mode.toLowerCase() === 'batch' ? 'batch' : 'rising',
          table,
          rising,
          ts,
          interval: Number(interval) || 3600,
          index: splunkName(index, 'main'),
          sourcetype: sourcetype || `dbx:${splunkName(name, 'input')}`,
          rowsApprox: Number(approx) || 0,
        };
      }).filter((i) => i.name && i.table);

      if (dbInputs.length === 0) {
        findings.push(error('splunk.dbx-no-inputs', 'No inputs were listed.', { source: 'ArchToolKit' }));
      }
      for (const i of dbInputs) {
        if (i.mode === 'batch' && i.rowsApprox >= 100000 && i.interval < 3600) {
          findings.push(
            warning('splunk.dbx-batch-large-table', `${i.name} re-reads all ~${i.rowsApprox.toLocaleString('en')} rows of ${i.table} every ${i.interval}s — about ${Math.round((i.rowsApprox * 86400) / i.interval).toLocaleString('en')} events a day, nearly all duplicates, every one counted against the licence and a full scan on the database each time.`, {
              remediation: 'Use a rising column (an identity or a monotonically increasing modified sequence) so each run reads only new rows, or run the batch once a day into a lookup instead of an index.',
              source: 'DB Connect — batch vs rising inputs',
            }),
          );
        }
        if (i.mode === 'rising' && !i.rising) {
          findings.push(error('splunk.dbx-no-rising-column', `${i.name} is a rising input without a rising column; DB Connect cannot save a checkpoint and the input will not start.`, { source: 'db_inputs.conf.spec — tail_rising_column_name' }));
        }
        if (i.mode === 'rising' && /(time|date|_at$|_ts$|^ts$|modified|updated)/i.test(i.rising)) {
          findings.push(
            warning('splunk.dbx-timestamp-rising-column', `${i.name} rises on ${i.rising}, which looks like a timestamp. Timestamps are not unique: rows committed with the same value as the checkpoint after a run are skipped for good by "> ?", and rows committed late with an earlier value are never read.`, {
              remediation: 'Rise on a unique, increasing key (an identity column or a sequence). Keep the timestamp for _time via the timestamp column.',
              source: 'ArchToolKit',
            }),
          );
        }
        if (i.interval < 60) {
          findings.push(warning('splunk.dbx-short-interval', `${i.name} runs every ${i.interval}s. A run that takes longer than the interval overlaps the next, and the database sees a query every few seconds for little gain.`, { source: 'ArchToolKit' }));
        }
      }
      if (!readonly) {
        findings.push(warning('splunk.dbx-not-readonly', 'The connection is not read-only. DB Connect also runs ad-hoc SQL from dbxquery; with a writable connection and a login that can write, a search can change the database.', { remediation: 'Set readonly and give the database user SELECT on the listed tables only.', source: 'ArchToolKit' }));
      }
      if (!ssl) {
        findings.push(warning('splunk.dbx-no-tls', 'The JDBC connection is not encrypted; the login and every row cross the network in clear.', { source: 'ArchToolKit' }));
      }

      const connections = [
        '# The connection. The password is not here or in any file in this app: the',
        `# identity "${identity}" is created with ops/create-dbx-identity.sh (or in DB`,
        '# Connect > Configuration > Identities) and DB Connect stores it encrypted.',
        `[${connection}]`,
        `connection_type = ${dbType.type}`,
        `host = ${host}`,
        `port = ${port}`,
        `database = ${database}`,
        `identity = ${identity}`,
        `jdbcUseSSL = ${ssl ? 'true' : 'false'}`,
        '# Read-only at the JDBC level too, so dbxquery cannot write.',
        `readonly = ${readonly ? 'true' : 'false'}`,
        'disabled = 0',
      ];

      const inputsConf = dbInputs.flatMap((i) => {
        const cols_ = i.ts ? `t.${i.ts} AS splunk_event_time, t.*` : 't.*';
        const query = i.mode === 'rising' ? `SELECT ${cols_} FROM ${i.table} t WHERE t.${i.rising} > ? ORDER BY t.${i.rising} ASC` : `SELECT ${cols_} FROM ${i.table} t`;
        return [
          i.mode === 'rising'
            ? `# ${i.name}: rising on ${i.rising}. Each run reads rows above the checkpoint (the ?), in order, and saves the last value it indexed.`
            : `# ${i.name}: batch — the whole table every run. Keep batch for small reference tables.`,
          `[${i.name}]`,
          `connection = ${connection}`,
          `mode = ${i.mode}`,
          `query = ${query}`,
          ...(i.mode === 'rising' ? [`tail_rising_column_name = ${i.rising}`] : []),
          ...(i.ts
            ? ['# _time from the row, not from when it was read. The timestamp is selected', '# first so its position is known.', 'index_time_mode = dbColumn', 'input_timestamp_column_number = 1']
            : ['# No timestamp column: _time is the time of the run.', 'index_time_mode = current']),
          `interval = ${i.interval}`,
          `index = ${i.index}`,
          `sourcetype = ${i.sourcetype}`,
          `source = dbx:${connection}:${i.name}`,
          `# The query is cancelled after this many seconds, rather than holding locks.`,
          `query_timeout = ${queryTimeout}`,
          ...(i.mode === 'rising' && maxRows > 0 ? ['# A bounded catch-up: after an outage, each run reads at most this many rows', '# and the next run continues from the checkpoint.', `max_rows = ${maxRows}`] : ['max_rows = 0']),
          'fetch_size = 300',
          'batch_upload_size = 1000',
          'disabled = 0',
          '',
        ];
      });

      const identityScript = [
        '#!/usr/bin/env bash',
        `# Create the DB Connect identity "${identity}" from a password file, through REST.`,
        '#',
        '# usage: create-dbx-identity.sh --token-file ~/.splunk/admin.token --password-file ~/.dbx/erp.pw \\',
        '#          [--url https://hf:8089] [--cacert ca.pem] [--dry-run]',
        '#',
        '# Both files mode 600. The password is read by jq from the file into the JSON',
        '# body, which reaches curl on stdin — never an argument, never printed.',
        '# VERIFY the endpoint for your DB Connect version; the UI (Configuration >',
        '# Identities) does the same thing.',
        'set -euo pipefail',
        `SPLUNK_URL=${shq(splunkUrl)}`,
        `IDENTITY=${shq(identity)}`,
        `DB_USER=${shq(dbUser)}`,
        'TOKEN_FILE=""; PASSWORD_FILE=""; CA_FILE=""; EXECUTE=1',
        'while [ $# -gt 0 ]; do',
        '  case $1 in',
        '    --url) SPLUNK_URL=$2; shift 2 ;;',
        '    --token-file) TOKEN_FILE=$2; shift 2 ;;',
        '    --password-file) PASSWORD_FILE=$2; shift 2 ;;',
        '    --cacert) CA_FILE=$2; shift 2 ;;',
        '    --dry-run) EXECUTE=0; shift ;;',
        '    *) printf "unknown option: %s\\n" "$1" >&2; exit 2 ;;',
        '  esac',
        'done',
        '',
        ...restPrelude(),
        ...script`
[ -n "$TOKEN_FILE" ] || die "--token-file is required"
[ -n "$PASSWORD_FILE" ] || die "--password-file is required"
load_token
check_private "$PASSWORD_FILE"

EP="/servicesNS/nobody/splunk_app_db_connect/db_connect/dbxproxy/identities"
note "Identity $IDENTITY for user $DB_USER at $SPLUNK_URL$EP"
if [ "$EXECUTE" != 1 ]; then
  note "Dry run: would create identity $IDENTITY from $PASSWORD_FILE. Nothing was changed. Run it without --dry-run to apply."
  exit 0
fi

jq -n --arg name "$IDENTITY" --arg user "$DB_USER" --rawfile pw "$PASSWORD_FILE" \
  '{name: $name, username: $user, password: ($pw | rtrimstr("\n") | rtrimstr("\r"))}' \
  | api POST "$EP" -H 'Content-Type: application/json' --data-binary @- -o /dev/null
note "Identity $IDENTITY created. Test the connection: DB Connect > Configuration > Connections > ${connection} > Validate."
`,
      ];

      return {
        tier: TIER,
        title: `DB Connect ${connection} (${dbType.type}): ${dbInputs.map((i) => `${i.name} ${i.mode}`).join(', ')}`,
        app,
        activation: 'restart',
        notes: [
          `Install Splunk DB Connect (splunk_app_db_connect), a supported Java runtime (VERIFY the JRE version for your DB Connect release), and the JDBC driver add-on — here the ${dbType.driver}. DB Connect runs on a heavy forwarder, never on a universal forwarder, and not on a search head cluster member for inputs.`,
          'Identities hold the password encrypted in DB Connect’s own store. Create the identity before deploying this app, or the connection fails validation and the inputs do not start.',
          'Checkpoints for rising inputs are kept by DB Connect (in the KV store from 3.10, per the checkpoint_key setting). Do not disable the KV store on this forwarder, and back it up: losing a checkpoint re-reads the table from the start. VERIFY for your version.',
          'Grant the database user SELECT on the listed tables only, and an index on each rising column, or every run is a full scan.',
          'SELECT t.* follows schema changes silently: a new column appears in the events, a dropped one disappears. List columns explicitly for anything a detection depends on.',
          'VERIFY the connection_type names (generic_mssql, oracle, postgres, mysql) against db_connection_types.conf in your DB Connect version, and that connections and inputs are read from this app rather than only from splunk_app_db_connect.',
        ],
        before: [
          `nc -vz ${host} ${port}`,
          `| rest /servicesNS/nobody/splunk_app_db_connect/db_connect/dbxproxy/connections splunk_server=local   # VERIFY endpoint`,
          `| dbxquery connection=${connection} query="SELECT COUNT(*) FROM ${dbInputs[0]?.table ?? '<table>'}"   # after the connection exists`,
          'splunk cmd btool db_inputs list --debug',
        ],
        files: {
          'default/db_connections.conf': connections,
          'default/db_inputs.conf': inputsConf,
          'ops/create-dbx-identity.sh': identityScript,
          'metadata/default.meta': defaultMeta(['admin', 'db_connect_admin'], ['admin', 'db_connect_admin']),
        },
        verify: [
          ...dbInputs.map((i) => `index=${i.index} sourcetype=${i.sourcetype} earliest=-24h | stats count, max(_time) as latest | eval lag_s=now()-latest`),
          'index=_internal sourcetype=dbx_job_metrics earliest=-24h | stats count, avg(duration) as avg_s, sum(read_count) as rows by input_name, status   # VERIFY field names',
          'index=_internal sourcetype=dbx_server log_level=ERROR earliest=-1h | stats count by message',
          `| dbxquery connection=${connection} query="SELECT 1"`,
        ],
        backout: [
          `rm -rf $SPLUNK_HOME/etc/apps/${app} && splunk restart`,
          '# The identity and the checkpoints remain in DB Connect; delete them there if the input is gone for good.',
        ],
        findings,
      };
    },
  }),
];
