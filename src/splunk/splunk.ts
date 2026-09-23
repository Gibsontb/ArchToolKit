/**
 * The Splunk model.
 *
 * Splunk configuration is a set of `.conf` files in an app, and almost every
 * problem people have with it comes from one of three things: the file is in
 * the wrong app, the app is on the wrong tier, or the setting is index-time and
 * was changed after the data was already indexed.
 *
 * So the unit here is an **app**, not a file, and every app says which tier it
 * belongs on and whether it needs a restart. A search head does not parse
 * incoming data, so `props.conf` line breaking there does nothing at all — and
 * that is a change that looks applied, shows no error, and simply has no
 * effect. Saying which tier is not documentation; it is the setting that makes
 * the rest of it work.
 *
 * Nothing here writes a credential. A token, a password or a bind DN goes in
 * Splunk's own credential store or in a `local/` file that is never in version
 * control, and the generated app says which.
 */

import { warning, type Finding } from '../core/findings.ts';

/** Which Splunk tier the generated app is deployed to. */
export type SplunkTier =
  | 'search_head'
  | 'indexer'
  | 'forwarder'
  | 'heavy_forwarder'
  | 'addon'
  | 'management'
  | 'cloud'
  | 'edge';

export interface TierInfo {
  readonly id: SplunkTier;
  readonly label: string;
  /** Where the app goes, and how it gets there. */
  readonly deployTo: string;
  /** What distributes apps to this tier. */
  readonly distributedBy: string;
  /** What this tier does with configuration, which decides what belongs here. */
  readonly responsibility: string;
}

export const TIERS: Readonly<Record<SplunkTier, TierInfo>> = {
  search_head: {
    id: 'search_head',
    label: 'Search head',
    deployTo: '$SPLUNK_HOME/etc/apps/<app>/ on every search head, or on the deployer for a cluster',
    distributedBy: 'The search head cluster deployer: splunk apply shcluster-bundle',
    responsibility:
      'Search-time only: saved searches, alerts, dashboards, macros, field extractions, lookups, tags and data models. Index-time settings here do nothing, silently.',
  },
  indexer: {
    id: 'indexer',
    label: 'Indexer',
    deployTo: '$SPLUNK_HOME/etc/apps/<app>/ on every indexer, or on the cluster master',
    distributedBy: 'The indexer cluster manager: splunk apply cluster-bundle',
    responsibility:
      'Index-time: indexes, retention, line breaking, timestamp recognition, routing and masking. This is the only tier where those take effect for data arriving over a forwarder.',
  },
  forwarder: {
    id: 'forwarder',
    label: 'Forwarder',
    deployTo: '$SPLUNK_HOME/etc/apps/<app>/ on the forwarders, via the deployment server',
    distributedBy: 'The deployment server: a serverclass with this app mapped to the forwarders',
    responsibility:
      'Collection and delivery: what to read, what to listen on, where to send it. A heavy forwarder also parses, which is why index-time settings sometimes belong here too.',
  },
  heavy_forwarder: {
    id: 'heavy_forwarder',
    label: 'Heavy forwarder',
    deployTo: '$SPLUNK_HOME/etc/apps/<app>/ on the heavy forwarders, via the deployment server or by hand',
    distributedBy: 'The deployment server, in a serverclass of its own, separate from the universal forwarders',
    responsibility:
      'Collection that needs parsing before it is sent: syslog aggregation, HEC, modular inputs from add-ons, routing and filtering. Index-time settings take effect here for data it parses, and the indexers then leave that data alone.',
  },
  addon: {
    id: 'addon',
    label: 'Add-on (every tier)',
    deployTo: 'The same add-on on the search heads, the indexers (or the heavy forwarders that parse), and the forwarders that collect',
    distributedBy: 'Each tier’s own mechanism: the deployer, the cluster manager and the deployment server, from one copy of the add-on',
    responsibility:
      'One data source end to end: where it is collected, how it is parsed at index time, and how it is extracted, tagged and mapped to the Common Information Model at search time. Each tier reads the part it is responsible for and ignores the rest, which is why one copy goes everywhere.',
  },
  management: {
    id: 'management',
    label: 'Management (cluster manager, deployer, deployment server, license manager, monitoring console)',
    deployTo: '$SPLUNK_HOME/etc/system/local or an app on the management node itself; peers, members and clients get their part from it',
    distributedBy: 'By hand or by configuration management on the management nodes; they are what distributes everything else',
    responsibility:
      'The platform itself: clustering, bundle distribution, forwarder management, licensing, authentication, roles, TLS, monitoring, backups and upgrades.',
  },
  cloud: {
    id: 'cloud',
    label: 'Splunk Cloud Platform',
    deployTo: 'Your Splunk Cloud stack, through the Admin Config Service (ACS) API or the acs CLI, and private apps through app vetting',
    distributedBy: 'ACS for indexes, HEC tokens, IP allow lists and app installs; Splunk operates the tiers underneath',
    responsibility:
      'What a Cloud customer still controls: indexes, HEC, network access, private and Splunkbase apps, users and roles. No shell, no conf files on the indexers.',
  },
  edge: {
    id: 'edge',
    label: 'Edge Processor, Ingest Processor and OpenTelemetry',
    deployTo: 'Edge Processor instances in your network, the Ingest Processor in Splunk Cloud, or the Splunk OpenTelemetry Collector on hosts and Kubernetes',
    distributedBy: 'The Edge Processor service in the Splunk Cloud tenant, or Helm and your configuration management for the collector',
    responsibility:
      'Filtering, masking and routing before data is indexed — to Splunk, to S3 or elsewhere — written as SPL2 pipelines, and metrics, traces and logs from containers and hosts.',
  },
};

/** Whether the change takes effect on its own, or needs something restarted. */
export type Activation =
  /** Picked up on its own, or by a reload from the user interface. */
  | 'reload'
  /** Needs the Splunk service restarted on that tier. */
  | 'restart'
  /** Needs a cluster bundle push, which rolls the peers. */
  | 'bundle';

export const ACTIVATION_MEANING: Readonly<Record<Activation, string>> = {
  reload: 'Takes effect without a restart. A debug refresh or a reload of that endpoint is enough.',
  restart: 'Needs splunkd restarted on that tier. On a search head that interrupts running searches; on an indexer it stops ingestion for that peer.',
  bundle: 'Needs a cluster bundle push. That rolls the peers one at a time and can take a while on a large cluster — it is a change window, not a quick fix.',
};

/** One generated app. */
export interface SplunkApp {
  readonly tier: SplunkTier;
  /** What this does, in a line a change record can carry. */
  readonly title: string;
  /** The app directory name, which is also the namespace of everything in it. */
  readonly app: string;
  readonly activation: Activation;
  /** Conf files and their contents, keyed by path within the app. */
  readonly files: Readonly<Record<string, readonly string[]>>;
  /** What to check before deploying it. */
  readonly before: readonly string[];
  /** Searches or commands that prove it worked. */
  readonly verify: readonly string[];
  /** How to take it out again. */
  readonly backout: readonly string[];
  /** Anything the person deploying it has to know. */
  readonly notes?: readonly string[];
  readonly findings?: readonly Finding[];
}

/** An app is only an app if it has an app.conf. */
export function appConf(app: SplunkApp, description: string): string[] {
  return [
    '[install]',
    'is_configured = 0',
    '',
    '[ui]',
    'is_visible = 0',
    `label = ${app.app}`,
    '',
    '[launcher]',
    'author = ArchToolKit',
    `description = ${description}`,
    'version = 1.0.0',
    '',
    '[package]',
    `id = ${app.app}`,
  ];
}

/**
 * Sharing, which is the setting people forget and then cannot explain.
 *
 * Without `default.meta`, a knowledge object is private to whoever created it —
 * and an object created by the deployment has no owner, so it is visible to
 * nobody. The dashboard is there, the search returns nothing, and there is no
 * error anywhere.
 */
export function defaultMeta(readRoles: readonly string[] = ['*'], writeRoles: readonly string[] = ['admin', 'power']): string[] {
  return [
    '[]',
    'access = read : [ ' + readRoles.join(', ') + ' ], write : [ ' + writeRoles.join(', ') + ' ]',
    'export = system',
  ];
}

/** The app, rendered as the files it actually is. */
/**
 * Files that take a `#` comment, and so get the generated-by header.
 *
 * Everything else is left exactly as written: a lookup CSV whose first line is
 * a comment has that comment as its column names, JSON and XML with a comment
 * do not parse, a device configuration (.cfg, .txt) is pasted into a CLI that
 * rejects a line it does not know, and a script's shebang has to stay on line
 * one.
 */
const HASH_COMMENT = /\.(conf|meta|spec|ya?ml|ps1|psm1|sh|bash|py|env|example|ini|service|properties)$/i;

export function renderApp(app: SplunkApp, name: string): Record<string, string> {
  const out: Record<string, string> = {};
  const header = ['# ' + app.title, '# Generated by ArchToolKit. Review before deploying.'];
  for (const [path, lines] of Object.entries(app.files)) {
    let body: readonly string[] = lines;
    if (HASH_COMMENT.test(path)) {
      body = lines[0]?.startsWith('#!') ? [lines[0], ...header, ...lines.slice(1)] : [...header, '', ...lines];
    }
    out[`${app.app}/${path}`] = `${body.join('\n')}\n`;
  }
  return out;
}

/** The deployment note that travels with the app, for the ticket. */
export function renderRecord(app: SplunkApp, name: string): string[] {
  const tier = TIERS[app.tier];
  return [
    `**Tier:** ${tier.label}  `,
    `**Activation:** ${ACTIVATION_MEANING[app.activation]}`,
    '',
    '## Where it goes',
    '',
    `- ${tier.deployTo}`,
    `- Distributed by: ${tier.distributedBy}`,
    `- This tier is responsible for: ${tier.responsibility}`,
    '',
    ...(app.notes && app.notes.length > 0 ? ['## Before you deploy it', '', ...app.notes.map((n) => `- ${n}`), ''] : []),
    '## Check first',
    '',
    ...app.before.map((line) => `- \`${line}\``),
    '',
    '## Files',
    '',
    ...Object.keys(app.files).map((path) => `- \`${app.app}/${path}\``),
    '',
    '## Verify',
    '',
    ...app.verify.map((line) => `- \`${line}\``),
    '',
    '## Back out',
    '',
    ...app.backout.map((line) => `- \`${line}\``),
    '',
    '---',
    '',
    'No credential is written into a generated file. Tokens, passwords and bind accounts go in Splunk’s credential store, or in a `local/` file kept out of version control.',
  ];
}

/**
 * The checks that apply to every generated app.
 *
 * The two that matter most: a setting written to the wrong tier does nothing
 * and says nothing, and an index-time setting changed after the fact does not
 * apply to data that is already indexed. Both look like the change worked.
 */
export function standingFindings(app: SplunkApp): Finding[] {
  const findings: Finding[] = [];

  const indexTime = /^\s*(LINE_BREAKER|SHOULD_LINEMERGE|TIME_PREFIX|TIME_FORMAT|MAX_TIMESTAMP_LOOKAHEAD|TRUNCATE|TRANSFORMS-|SEDCMD-)/;
  const hasIndexTime = Object.entries(app.files).some(([path, lines]) => path.includes('props.conf') && lines.some((line) => indexTime.test(line)));

  if (hasIndexTime && app.tier === 'search_head') {
    findings.push(
      warning('splunk.index-time-on-search-head', 'This app contains index-time settings but is written for a search head, where they have no effect on data arriving from forwarders. The change will appear to apply and will do nothing.', {
        remediation: 'Put line breaking, timestamp recognition and index-time transforms on the indexers, or on the heavy forwarder that parses the data.',
        source: 'ArchToolKit',
      }),
    );
  }

  if (hasIndexTime) {
    findings.push(
      warning('splunk.index-time-not-retroactive', 'Index-time settings apply only to data indexed after they are in place. Events already in the index keep whatever parsing they got, and the only way to correct them is to re-index.', {
        source: 'ArchToolKit',
      }),
    );
  }

  for (const [path, lines] of Object.entries(app.files)) {
    for (const line of lines) {
      if (line.trim().startsWith('#')) continue;
      if (/^\s*(password|token|passAuth|bindDNpassword|clientSecret)\s*=\s*\S/i.test(line) && !/\$|<|REQUIRED/.test(line)) {
        findings.push(
          warning('splunk.credential-literal', `A line in ${path} looks like it sets a credential directly. Splunk encrypts a password in place on restart, which means the plain text has already been on disk and in version control.`, {
            remediation: 'Leave the value empty in the generated app and set it through Settings, or through the storage/passwords endpoint, after deployment.',
            source: 'ArchToolKit',
          }),
        );
        break;
      }
    }
  }

  if (!Object.keys(app.files).some((path) => path.endsWith('app.conf'))) {
    findings.push(warning('splunk.no-app-conf', 'Without an app.conf this directory is not a complete app, and some deployment paths will skip it.', { source: 'ArchToolKit' }));
  }

  return findings;
}

// --- SPL helpers -----------------------------------------------------------

/** A comma or newline separated list, cleaned up. */
export function listOf(value: string): string[] {
  return String(value ?? '')
    .split(/[,\n]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

/** A name Splunk will accept for an app, a macro or a saved search. */
export function splunkName(value: string, fallback: string): string {
  const cleaned = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

/** A saved search title, which may have spaces but not the characters Splunk reserves. */
export function searchTitle(value: string, fallback: string): string {
  const cleaned = String(value ?? '')
    .trim()
    .replace(/[\[\]\\/]/g, ' ')
    .replace(/\s+/g, ' ');
  return cleaned || fallback;
}

/**
 * Fold a long SPL pipeline so a conf file stays readable.
 *
 * A `.conf` continues a value onto the next line with a trailing backslash, and
 * a search written as one 400-character line is why nobody ever edits these in
 * the file.
 */
export function foldSearch(pipeline: readonly string[]): string[] {
  const parts = pipeline.map((line) => line.trim()).filter(Boolean);
  if (parts.length === 0) return ['search = '];
  if (parts.length === 1) return [`search = ${parts[0]}`];
  return [`search = ${parts[0]} \\`, ...parts.slice(1, -1).map((line) => `    ${line} \\`), `    ${parts[parts.length - 1]}`];
}

/**
 * A cron expression that does not put every search on the same minute.
 *
 * Splunk schedules everything at :00 by default, and on a busy search head that
 * is the reason searches get skipped. Spreading them by a stable offset derived
 * from the name costs nothing and fixes it.
 */
export function spreadCron(name: string, everyMinutes: number): string {
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) % 997;
  if (everyMinutes >= 1440) return `${hash % 60} ${hash % 6} * * *`;
  if (everyMinutes >= 60) {
    const hours = Math.max(1, Math.round(everyMinutes / 60));
    return `${hash % 60} */${hours} * * *`;
  }
  const minutes = Math.max(1, everyMinutes);
  return `${hash % minutes}-59/${minutes} * * * *`;
}

/**
 * The window a scheduled search looks at, given how often it runs.
 *
 * The overlap is deliberate: events arrive late, and a search whose window
 * exactly matches its schedule misses whatever indexed a second after it ran.
 */
export function searchWindow(everyMinutes: number): { earliest: string; latest: string } {
  const lookback = Math.round(everyMinutes * 1.2) + 1;
  return { earliest: `-${lookback}m@m`, latest: 'now' };
}
