/**
 * Check everything the Splunk page generates — the counterpart of
 * tools/validate-network-blueprints.mjs.
 *
 * For every Splunk blueprint, built with its defaults and once per other
 * choice of each dropdown and yes/no:
 *   - it builds, and its defaults raise no error;
 *   - every generated .conf and .meta file parses the way splunkd reads it:
 *     stanzas, `key = value`, continuation lines and comments, and no key set
 *     twice in one stanza (splunkd keeps the last and says nothing);
 *   - every stanza and setting is one Splunk has, checked against the
 *     .conf.spec files of the Splunk Enterprise release in
 *     src/splunk/conf-spec-data.ts (npm run splunk:specs), plus the app's own
 *     README/*.conf.spec for a modular input or a custom alert action; a
 *     setting outside any stanza must be one splunkd applies there;
 *   - no file holds a credential: no password, token or key with a literal
 *     value, no private key, no `-auth user:password`.
 * Then each default build that is a real app (conf files, views or lookups,
 * not only scripts and snippets for $SPLUNK_HOME/etc/system/local) is
 * packaged as a .tgz (only its app parts: default, local, metadata, bin,
 * lookups, README — not the ops/ scripts and snippets for the hosts) and
 * inspected with Splunk AppInspect: with --included-tags cloud for an app a
 * Splunk Cloud stack can take (search head, add-on, cloud), and with every
 * check, less Splunk Cloud's own policy (CLOUD_POLICY), for an app on a tier
 * only Enterprise has. Failures and errors fail the run; warnings are listed
 * as information.
 *
 *   npm run splunk:validate                        # everything
 *   npm run splunk:validate -- --tier search_head  # one tier (repeatable)
 *   npm run splunk:validate -- --only splunk_tls   # ids containing this
 *   npm run splunk:validate -- --no-appinspect     # skip AppInspect
 *   npm run splunk:validate -- --warnings          # list AppInspect warnings too
 *
 * AppInspect needs the ~/archtoolkit-ansible environment
 * (tools/setup-ansible-wsl.sh installs splunk-appinspect there); on Windows, in WSL.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SPLUNK_APPS } from '../src/splunk/blueprints/index.ts';
import { defaultValues } from '../src/kit/blueprint.ts';
import { checkAgainstSpec, compileSpec, confTypeOf, credentialProblems, mergeSpecs, parseConf, parseSpec } from '../src/splunk/conf-check.ts';
import { SPLUNK_CONF_SPECS, SPLUNK_SPEC_SOURCE } from '../src/splunk/conf-spec-data.ts';

const argv = process.argv.slice(2);
const many = (flag) => argv.flatMap((a, i) => (a === flag && argv[i + 1] ? [argv[i + 1]] : []));
const only = many('--only');
const tiers = many('--tier');
const noAppInspect = argv.includes('--no-appinspect');
const showWarnings = argv.includes('--warnings');
const VENV = process.env.ARCHTOOLKIT_ANSIBLE_VENV ?? '~/archtoolkit-ansible';

/** Blueprints that refuse at their defaults on purpose, until you confirm something. */
const REFUSE_BY_DESIGN = new Set([]);

/**
 * Files named .conf that are not Splunk configuration, so are not read as
 * one: they belong to the software the app's scripts set up.
 */
const NOT_SPLUNK_CONF = [
  { path: /\/ops\/sc4s\/app_parsers\/[^/]+\.conf$/, reason: 'an SC4S app parser: syslog-ng configuration' },
  { path: /\/ops\/sysctl-[^/]+\.conf$/, reason: 'a Linux sysctl.d file for the SC4S host' },
  { path: /\/ops\/ldap\.conf$/, reason: 'OpenLDAP client configuration (TLS_CACERT) for the search heads' },
  { path: /\/ops\/rsyslog\.d\/[^/]+\.conf$/, reason: 'an rsyslog drop-in for the syslog host' },
];

/**
 * Conf files of a Splunkbase add-on, which are not in core Splunk's spec
 * files: read as conf files, but their settings are the add-on's to define.
 */
const ADDON_CONF = {
  'google_cloud_pubsub_inputs.conf': 'Splunk Add-on for Google Cloud Platform (Splunkbase 3088)',
  'db_connections.conf': 'Splunk DB Connect (Splunkbase 2686)',
  'db_inputs.conf': 'Splunk DB Connect (Splunkbase 2686)',
};

/**
 * Modular input types of a Splunkbase add-on in an inputs.conf: the stanza
 * and its settings are declared by the add-on's own README/inputs.conf.spec,
 * which is not in this app, so they are parsed but not spec-checked.
 */
const ADDON_INPUTS = {
  aws_s3: 'Splunk Add-on for AWS (Splunkbase 1876): generic S3 input',
  aws_sqs_based_s3: 'Splunk Add-on for AWS (Splunkbase 1876): SQS-based S3 input',
  mscs_azure_event_hub: 'Splunk Add-on for Microsoft Cloud Services (Splunkbase 3110): Azure Event Hub input',
};

/**
 * Settings splunkd reads on any modular input, in the scheme's own stanza
 * ([<scheme>]) or an instance ([<scheme>://<name>]), which an app's
 * README/inputs.conf.spec need not repeat. inputs.conf.spec lists
 * python.version and python.required in its "Modular Inputs" section — which
 * sits after [remote_queue:<name>] in the file, so reads as part of it — and
 * interval is the scheduling setting splunkd applies to every modular input
 * ("Modular inputs configuration", Splunk developer documentation).
 */
const MODULAR_INPUT_SETTINGS = ['interval', 'python.version', 'python.required', 'disabled', 'start_by_shell', 'run_introspection'];

/**
 * Spec findings that are the spec's gap, not the blueprint's: a setting
 * splunkd reads that its .conf.spec does not list where it is used.
 */
const SPEC_ALLOW = [
  {
    conf: 'inputs.conf',
    key: 'disabled',
    reason:
      'inputs.conf.spec 10.4 lists disabled under only some input types, but splunkd honours it on every input stanza: it is how Settings > Data inputs turns one on and off, and Splunk’s own default inputs.conf sets it on monitor and script stanzas.',
  },
];

/**
 * Which AppInspect checks an app gets. AppInspect is Splunk's vetting for
 * Splunkbase and Splunk Cloud: of its checks, every one but the aarch64 check
 * carries the `cloud` tag, and there is no Enterprise-only set. So:
 *   - an app a Splunk Cloud stack can take (search head, add-on, cloud tier)
 *     is inspected with --included-tags cloud, and every failure counts;
 *   - an app for a tier only Splunk Enterprise has (indexers, management
 *     nodes, forwarders) is inspected with every check, and the failures of
 *     the checks in CLOUD_POLICY below — Splunk Cloud's rules about what a
 *     customer may configure on a stack Splunk runs — are not counted, since
 *     that app never goes to a Cloud stack.
 */
const CLOUD_TIERS = new Set(['search_head', 'addon', 'cloud']);

/** Splunk Cloud policy checks, not counted for an app on an Enterprise-only tier; each with why it does not apply there. */
const CLOUD_POLICY = {
  check_indexes_conf_properties: 'Cloud allows only homePath/coldPath/thawedPath/frozenTimePeriodInSecs/datatype/repFactor in indexes.conf because Splunk sizes a Cloud stack; an Enterprise indexer app sets retention, sizing and SmartStore itself.',
  check_for_index_volume_usage: 'Cloud forbids volumes because Splunk owns the stack’s storage; volumes are how Enterprise indexers bound disk use.',
  check_indexes_conf_only_uses_splunk_db_variable: 'Cloud requires $SPLUNK_DB paths; Enterprise hot and cold volumes live on their own mounts.',
  check_validate_default_indexes_not_modified: 'Cloud forbids changing _audit and the other default indexes; enabling data integrity control on _audit is an Enterprise indexer setting.',
  check_lower_cased_index_names: 'Flags _audit for its leading underscore: the index is Splunk’s own, configured here, not created.',
  check_no_default_stanzas: 'Cloud forbids [default]/[general] stanzas in Splunk’s conf files; on an Enterprise node they are how a setting applies to every stanza (indexes.conf [default], workload_pools.conf [general], serverclass.conf [global]).',
  check_if_outputs_conf_exists: 'Cloud forbids forwarding from the stack; forwarding is what a forwarder or heavy forwarder app is for.',
  check_inputs_conf_for_udp: 'Cloud has no UDP inputs; a forwarder listening for syslog on UDP is an Enterprise forwarder.',
  check_inputs_conf_for_ssl: 'Cloud manages the receiving TLS; an Enterprise node’s [SSL] stanza is its own.',
  check_inputs_conf_for_http_global_usage: 'Cloud creates HEC tokens through ACS; on an Enterprise heavy forwarder HEC is configured in inputs.conf (with the token left empty).',
  check_server_conf_only_contains_custom_conf_sync_stanzas_or_diag_stanza: 'Cloud forbids server.conf settings on a stack Splunk runs; TLS and KV store settings are the Enterprise node’s own.',
  check_web_conf: 'Cloud allows only [endpoint:*]/[expose:*] in web.conf; an Enterprise node sets its own Splunk Web TLS.',
  check_stanza_of_authentication_conf: 'Cloud allows only role mapping; LDAP strategies and the admin role mapping are an Enterprise node’s authentication.',
  check_authorize_conf_for_tokens_auth: 'Cloud forbids [tokens_auth]; token authentication is an Enterprise node setting.',
  check_serverclass_conf_deny_list: 'serverclass.conf belongs on a deployment server, which Cloud does not have.',
  check_deploymentclient_conf_deny_list: 'deploymentclient.conf belongs on a forwarder, which is not a Cloud stack.',
  check_that_local_does_not_exist: 'Cloud forbids local/ in a package; the deployment server’s serverclass.conf is written by the server itself into local/, and the app ships it there.',
  check_health_conf_deny_list: 'sc_admin cannot configure the health report in Cloud; an Enterprise node can.',
  check_workload_pools_conf_deny_list: 'Cloud forbids workload management configuration; Enterprise workload management is configured this way.',
  check_workload_rules_conf_deny_list: 'Cloud forbids workload management configuration; Enterprise workload management is configured this way.',
  check_reload_trigger_for_all_custom_confs: 'The "custom" conf files are DB Connect’s own (db_connections.conf, db_inputs.conf), which DB Connect reloads; the app does not define them.',
  check_inputs_conf_spec_stanzas_has_python_version_property:
    'Asks for the deprecated python.version; on 10.x the modular input sets python.required, which AppInspect’s own future check (check_modular_inputs_python_required) asks for. The blueprint’s "Also runs on 9.x" choice adds python.version.',
};

/**
 * AppInspect failures on a Cloud-capable app that are AppInspect's view, not
 * a problem with the app: by blueprint and check, with the reason.
 */
const APPINSPECT_ALLOW = [
  {
    id: 'splunk_webhook_alert',
    check: 'check_alert_actions_exe_exist',
    reason: 'The app adds an allow list to Splunk’s built-in [webhook] alert action; the executable is Splunk’s own, in the alert_webhook app, which AppInspect does not look at.',
  },
  {
    id: 'splunk_federated_search',
    check: 'check_indexes_conf_properties',
    reason: 'A [federated:<name>] stanza is a federated index (federated.provider, federated.dataset), which AppInspect reads as an ordinary index.',
  },
  {
    id: 'splunk_federated_search',
    check: 'check_lower_cased_index_names',
    reason: 'federated:<name> is the stanza form Splunk requires for a federated index; the colon is not part of an index name.',
  },
  {
    id: 'splunk_datamodel',
    check: 'check_for_datamodel_acceleration',
    reason: 'Accelerating the data model is what the blueprint is for, and on Enterprise it applies as shipped. Cloud vetting wants the package unaccelerated and acceleration turned on after install.',
  },
];

/**
 * Directories and files of a generated app that are not part of the app:
 * scripts and snippets for the hosts ($SPLUNK_HOME/etc/system/local, SC4S,
 * device configuration) and the runbooks. AppInspect sees only the app.
 */
const APP_PARTS = /^(default|local|metadata|bin|lookups|README|appserver|static)\/|^app\.manifest$|^README(\.[a-z]+)?$/;
/** What makes a folder a real app rather than a bundle of scripts: configuration, views or lookups. */
const REAL_APP = /^(default\/(?!app\.conf$).+|local\/.+|lookups\/.+)$/;

const blueprints = SPLUNK_APPS.filter((b) => tiers.length === 0 || tiers.includes(b.tier)).filter((b) => (only.length > 0 ? only.some((o) => b.id.includes(o)) : true));
if (blueprints.length === 0) {
  console.error('No blueprints matched.');
  process.exit(1);
}

function variants(blueprint) {
  const base = defaultValues(blueprint);
  const out = [{ label: blueprint.id, values: base, isDefault: true }];
  for (const input of blueprint.inputs) {
    const choices = input.control === 'toggle' ? [true, false] : input.control === 'select' ? (input.options ?? []).map((o) => o.value) : [];
    for (const value of choices) {
      if (String(value) === String(base[input.id])) continue;
      out.push({ label: `${blueprint.id} [${input.id}=${value}]`, values: { ...base, [input.id]: value } });
    }
  }
  return out;
}

const compiled = new Map();
const known = new Set(Object.keys(SPLUNK_CONF_SPECS));
function specFor(type, appSpecs) {
  const own = appSpecs[`${type}.spec`];
  if (own) return compileSpec(SPLUNK_CONF_SPECS[type] ? mergeSpecs(SPLUNK_CONF_SPECS[type], own) : own);
  if (!SPLUNK_CONF_SPECS[type]) return null;
  if (!compiled.has(type)) compiled.set(type, compileSpec(SPLUNK_CONF_SPECS[type]));
  return compiled.get(type);
}

/** Every problem with one build's files. */
function fileProblems(files) {
  const out = [];
  // An app's own spec files: README/inputs.conf.spec for a modular input, README/alert_actions.conf.spec for an alert action.
  const appSpecs = {};
  for (const [path, text] of Object.entries(files)) {
    const m = /\/README\/([^/]+\.conf\.spec)$/.exec(path);
    if (!m) continue;
    let spec = parseSpec(text);
    if (spec.stanzas.length === 0) out.push(`${path}: the spec file declares no stanza`);
    if (m[1] === 'inputs.conf.spec') {
      // Each modular input scheme it declares, with what splunkd reads on any modular input.
      const schemes = [...new Set(spec.stanzas.map((s) => /^([\w.-]+):\/\//.exec(s.pattern)?.[1]).filter(Boolean))];
      spec = mergeSpecs(spec, { global: [], stanzas: schemes.flatMap((s) => [{ pattern: s, keys: MODULAR_INPUT_SETTINGS }, { pattern: `${s}://<name>`, keys: MODULAR_INPUT_SETTINGS }]) });
    }
    appSpecs[m[1]] = spec;
  }
  for (const [path, text] of Object.entries(files)) {
    for (const p of credentialProblems(path, text)) out.push(`${path}:${p.line}: credential: ${p.message}`);
    if (!/\.(conf|meta)$/.test(path)) continue;
    if (NOT_SPLUNK_CONF.some((n) => n.path.test(path))) continue;
    const base = path.split('/').pop();
    const type = ADDON_CONF[base] ? null : confTypeOf(path, text, known) ?? (appSpecs[`${base}.spec`] ? base : null);
    if (!type && !ADDON_CONF[base]) {
      out.push(`${path}: not a conf file Splunk ${SPLUNK_SPEC_SOURCE.release} has a spec for, and its comments do not say which one it is`);
      continue;
    }
    const conf = parseConf(text);
    for (const p of conf.problems) out.push(`${path}:${p.line}: ${p.message}`);
    const spec = type ? specFor(type, appSpecs) : null;
    if (!spec) continue;
    const ours = type === 'inputs.conf' ? { ...conf, stanzas: conf.stanzas.filter((s) => !ADDON_INPUTS[/^([\w.-]+?)(:\/\/|$)/.exec(s.name ?? '')?.[1]]) } : conf;
    for (const p of checkAgainstSpec(ours, spec, type)) {
      const key = /^(\S+)/.exec(p.message)?.[1];
      if (SPEC_ALLOW.some((a) => a.conf === type && a.key === key)) continue;
      out.push(`${path}:${p.line}: ${p.message}`);
    }
  }
  return out;
}

const problems = new Map();
const fail = (label, message) => problems.set(label, [...(problems.get(label) ?? []), message]);
const work = mkdtempSync(join(tmpdir(), 'archtoolkit-splunk-validate-'));
const packaged = [];
let builds = 0;
let confFiles = 0;

for (const blueprint of blueprints) {
  const atDefaults = new Set();
  for (const { label, values, isDefault } of variants(blueprint)) {
    builds++;
    let result;
    try {
      result = blueprint.build(values, blueprint.id);
    } catch (err) {
      fail(label, `build threw: ${err.message}`);
      continue;
    }
    if (isDefault && !REFUSE_BY_DESIGN.has(blueprint.id)) {
      for (const f of (result.findings ?? []).filter((f) => f.severity === 'error')) fail(label, `error at the defaults: ${f.message}`);
    }
    confFiles += Object.keys(result.files).filter((p) => /\.(conf|meta)$/.test(p)).length;
    // A problem the defaults already have is reported once, not once per choice.
    for (const p of fileProblems(result.files)) {
      if (isDefault) atDefaults.add(p);
      else if (atDefaults.has(p)) continue;
      fail(label, p);
    }
    if (!isDefault) continue;
    const app = blueprint.app(values, blueprint.id).app;
    const inApp = Object.entries(result.files)
      .filter(([path]) => path.startsWith(`${app}/`))
      .map(([path, text]) => [path.slice(app.length + 1), text])
      .filter(([rel]) => APP_PARTS.test(rel));
    if (!inApp.some(([rel]) => REAL_APP.test(rel))) continue;
    const dir = join(work, 'apps', blueprint.id, app);
    for (const [rel, text] of inApp) {
      mkdirSync(join(dir, rel, '..'), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    packaged.push({ id: blueprint.id, app, cloud: CLOUD_TIERS.has(blueprint.tier) });
  }
}

// AppInspect, on each real app packaged as a .tgz.
function wslPath(path) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(path);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : path;
}
function findDistro() {
  if (process.env.ARCHTOOLKIT_WSL_DISTRO) return process.env.ARCHTOOLKIT_WSL_DISTRO;
  const listed = spawnSync('wsl', ['-l', '-q'], { encoding: 'utf16le' });
  const distros = (listed.stdout ?? '').split(/\r?\n/).map((d) => d.replace(/\0/g, '').trim()).filter(Boolean);
  for (const distro of distros.filter((d) => !d.startsWith('docker-desktop'))) {
    if (spawnSync('wsl', ['-d', distro, '--', 'bash', '-lc', `test -x ${VENV}/bin/splunk-appinspect`]).status === 0) return distro;
  }
  return null;
}

let inspected = 0;
let appInspectVersion = '';
const warnings = [];
if (!noAppInspect && packaged.length > 0) {
  const onWindows = process.platform === 'win32';
  const root = onWindows ? wslPath(work) : work;
  writeFileSync(join(work, 'cloud.txt'), packaged.filter((p) => p.cloud).map((p) => p.id).join('\n') + '\n');
  // Copied to the Linux side first: files on /mnt/c are all mode 777, and
  // AppInspect fails any conf file with execute permission. In the package,
  // only bin/ scripts are executable, as a real app would be.
  writeFileSync(
    join(work, 'appinspect.sh'),
    `#!/bin/bash
set -uo pipefail
export PATH=${VENV}/bin:$PATH
src='${root}'
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
splunk-appinspect list version 2>/dev/null | grep -o '[0-9][0-9.]*' | head -1 > "$src/version.txt"
inspect() {
  id=$1
  mkdir -p "$tmp/$id" && cp -r "$src/apps/$id/." "$tmp/$id/"
  find "$tmp/$id" -type d -exec chmod 755 {} +
  find "$tmp/$id" -type f -exec chmod 644 {} +
  find "$tmp/$id" -path '*/bin/*' -type f \\( -name '*.sh' -o -name '*.py' \\) -exec chmod 755 {} +
  app=$(ls "$tmp/$id")
  tar -czf "$tmp/$id.tgz" -C "$tmp/$id" --owner=0 --group=0 "$app"
  tags=()
  grep -qx "$id" "$src/cloud.txt" && tags=(--included-tags cloud)
  splunk-appinspect inspect "$tmp/$id.tgz" --mode test "\${tags[@]}" --data-format json --output-file "$tmp/$id.json" >/dev/null 2>"$tmp/$id.err" || true
  if [ -s "$tmp/$id.json" ]; then cp "$tmp/$id.json" "$src/results/$id.json"; else cp "$tmp/$id.err" "$src/results/$id.err"; fi
}
export -f inspect
export src tmp
mkdir -p "$src/results"
ls "$src/apps" | xargs -P 4 -I{} bash -c 'inspect {}'
`,
  );
  let ran = false;
  if (onWindows) {
    const distro = findDistro();
    if (!distro) console.log(`\nSkipping AppInspect: no WSL distro has it in ${VENV} (wsl -d Ubuntu-24.04 -- bash tools/setup-ansible-wsl.sh).`);
    else {
      console.log(`Inspecting ${packaged.length} apps with Splunk AppInspect in WSL (${distro})…`);
      execFileSync('wsl', ['-d', distro, '--', 'bash', `${root}/appinspect.sh`], { stdio: ['ignore', 'inherit', 'inherit'] });
      ran = true;
    }
  } else {
    console.log(`Inspecting ${packaged.length} apps with Splunk AppInspect…`);
    execFileSync('bash', [join(work, 'appinspect.sh')], { stdio: ['ignore', 'inherit', 'inherit'] });
    ran = true;
  }
  if (ran) {
    appInspectVersion = existsSync(join(work, 'version.txt')) ? readFileSync(join(work, 'version.txt'), 'utf8').trim() : '';
    const results = join(work, 'results');
    for (const { id, cloud } of packaged) {
      const json = join(results, `${id}.json`);
      if (!existsSync(json)) {
        const err = existsSync(join(results, `${id}.err`)) ? readFileSync(join(results, `${id}.err`), 'utf8').trim().split('\n').pop() : 'no report';
        fail(id, `AppInspect did not run: ${err}`);
        continue;
      }
      inspected++;
      const report = JSON.parse(readFileSync(json, 'utf8'));
      for (const r of report.reports ?? []) {
        for (const group of r.groups ?? []) {
          for (const check of group.checks ?? []) {
            const messages = (check.messages ?? []).map((m) => String(m.message ?? '').replace(/\s+/g, ' ').trim());
            if (check.result === 'failure' || check.result === 'error') {
              if (!cloud && CLOUD_POLICY[check.name]) continue;
              if (APPINSPECT_ALLOW.some((a) => a.id === id && a.check === check.name)) continue;
              for (const m of messages.length > 0 ? messages : [check.description]) fail(id, `AppInspect ${check.result}: ${check.name}: ${m}`);
            } else if (check.result === 'warning') {
              for (const m of messages) warnings.push(`${id}: ${check.name}: ${m}`);
            }
          }
        }
      }
    }
  }
}

for (const [label, lines] of problems) {
  console.log(`\n✗ ${label}`);
  for (const l of lines.slice(0, 12)) console.log(`    ${String(l).split('\n')[0].slice(0, 300)}`);
  if (lines.length > 12) console.log(`    … and ${lines.length - 12} more`);
}
if (warnings.length > 0) {
  console.log(`\nAppInspect warnings (information only): ${warnings.length}${showWarnings ? '' : ' — list them with --warnings'}`);
  if (showWarnings) for (const w of warnings) console.log(`    ${w.slice(0, 300)}`);
}
const failed = new Set([...problems.keys()].map((k) => k));
console.log(
  `\n${builds - failed.size} of ${builds} builds (${blueprints.length} blueprints, ${confFiles} conf files) pass the build, conf, spec and credential checks` +
    ` against Splunk Enterprise ${SPLUNK_SPEC_SOURCE.release}` +
    `${inspected ? `; ${inspected} apps inspected with Splunk AppInspect ${appInspectVersion}` : ''}.`,
);
rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
process.exit(problems.size > 0 ? 1 : 0);
