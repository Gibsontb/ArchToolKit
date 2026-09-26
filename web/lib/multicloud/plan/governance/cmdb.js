/**
 * CMDB and asset register (addendum A.10.5).
 *
 *  - `governance/cmdb/new-cis.csv`: the target CIs (name, class, platform,
 *    region, IP addresses, app, environment, owner);
 *  - `retire.csv`: the source CIs retired at decommission;
 *  - `relationships.csv`: app → server / database;
 *  - `update-cmdb.sh` (optional): writes them through the ServiceNow Table
 *    API, idempotent by name plus class; sources get `install_status = 7`
 *    (Retired). Applies by default; `--dry-run` prints the calls.
 *  - `asset-register.csv`: the hardware from the DC exit, with the NIST SP
 *    800-88 sanitisation method, certificate id and disposal date.
 *
 * The class names are ServiceNow's base CMDB classes; instances extend them,
 * so they are marked verify.
 */

import { error, warning,              } from '../../../core/findings.js';
import { osKind } from '../os.js';
                                                                                                       
import { ATK_SECRET_SH, SN_API_SH } from './changes.js';

/** CI class per target platform for a server (verify on the instance). */
export const CMDB_SERVER_CLASS                                            = Object.freeze({
  vmware: 'cmdb_ci_vmware_instance',
  aws: 'cmdb_ci_ec2_instance',
  azure: 'cmdb_ci_azure_instance',
  // No cloud-specific class named in the addendum: the OS class is used.
  google: null,
  oci: null,
});
export const CMDB_DB_CLASS                                              = Object.freeze({
  sqlserver: 'cmdb_ci_db_mssql_instance',
  oracle: 'cmdb_ci_db_ora_instance',
  postgres: 'cmdb_ci_db_postgresql_instance',
  mysql: 'cmdb_ci_db_mysql_instance',
  mariadb: 'cmdb_ci_db_mysql_instance',
});
export const CMDB_SOURCES = Object.freeze([
  'ServiceNow CMDB base classes (cmdb_ci_vmware_instance, cmdb_ci_ec2_instance, cmdb_ci_azure_instance, cmdb_ci_linux_server, cmdb_ci_win_server, cmdb_ci_db_*_instance): verify the class names on the instance.',
  'install_status 7 = Retired in the base choice list: verify.',
]);
export const RETIRED_INSTALL_STATUS = '7';

export function osServerClass(w                      )         {
  const k = osKind(w.os);
  return k === 'windows' ? 'cmdb_ci_win_server' : k === 'linux' ? 'cmdb_ci_linux_server' : 'cmdb_ci_server';
}
export function serverClass(w                      , platform          )         {
  return CMDB_SERVER_CLASS[platform] ?? osServerClass(w);
}
export const dbClass = (d                          )         => CMDB_DB_CLASS[d.engine] ?? 'cmdb_ci_db_instance';

export const NEW_CI_COLUMNS = Object.freeze(['name', 'class', 'platform', 'region', 'ip_addresses', 'app', 'environment', 'owner']         );
export const RETIRE_COLUMNS = Object.freeze(['name', 'class', 'app', 'install_status', 'retired_on']         );
export const RELATIONSHIP_COLUMNS = Object.freeze(['parent', 'parent_class', 'type', 'child', 'child_class']         );
export const ASSET_COLUMNS = Object.freeze(['id', 'kind', 'serial', 'location', 'contains_data', 'sanitisation', 'certificate_id', 'disposed_on', 'register_updated']         );

                                            
const csvField = (t        )         => (/[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);
export function rowsCsv(columns                   , rows                )         {
  return `${[columns.join(','), ...rows.map((r) => columns.map((c) => csvField(r[c] ?? '')).join(','))].join('\n')}\n`;
}

const APP_CLASS = 'cmdb_ci_business_app';

/** Where each item lands: the design first, then the decision, then nowhere. */
function landing(plan      , design                          , id        )                                                     {
  for (const p of design?.platforms ?? []) {
    if (p.compute.some((c) => c.workload === id) || p.databases.some((d) => d.database === id)) return { platform: p.platform, region: p.region };
  }
  const chosen = plan.decision?.items[id]?.chosen?.platform;
  return chosen ? { platform: chosen, region: plan.requirements.regions[chosen]?.primary ?? '' } : undefined;
}

/** The target CIs. A keep-IP server keeps its addresses; a re-IP one gets them at build. */
export function newCis(plan      , design               )        {
  const owner = (app        ) => plan.apps.find((a) => a.name === app)?.owner ?? '';
  const rows        = [];
  for (const w of plan.workloads) {
    const at = landing(plan, design, w.id);
    if (!at || w.disposition === 'retire') continue;
    const keep = w.ipStrategy === 'keep-ip-l2-extension' || w.ipStrategy === 'keep-ip-cloud' || at.platform === 'vmware';
    rows.push({
      name: w.rename ?? w.name, class: serverClass(w, at.platform), platform: at.platform, region: at.region,
      ip_addresses: keep ? (w.facts?.ipAddresses ?? []).join(' ') : '', app: w.app, environment: w.env, owner: owner(w.app),
    });
  }
  for (const d of plan.databases) {
    const at = landing(plan, design, d.id);
    if (!at) continue;
    rows.push({ name: d.name, class: dbClass(d), platform: at.platform, region: at.region, ip_addresses: '', app: d.app, environment: '', owner: owner(d.app) });
  }
  return rows.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
}

/** The source CIs to retire: decommissioned items (tracker), else every item planned to move or retire. */
export function retireCis(plan      , tracker                                 )        {
  const done = new Map((tracker?.decommissions ?? []).map((d) => [d.item, d.at.slice(0, 10)]));
  const rows        = [];
  for (const w of plan.workloads) {
    if (w.disposition === 'retain') continue;
    if (tracker && !done.has(w.id)) continue;
    const cls = (w.origin ?? 'vsphere') === 'vsphere' ? 'cmdb_ci_vmware_instance' : osServerClass(w);
    rows.push({ name: w.name, class: cls, app: w.app, install_status: RETIRED_INSTALL_STATUS, retired_on: done.get(w.id) ?? '' });
  }
  return rows.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
}

/** App → server and app → database, "Depends on::Used by". */
export function relationships(plan      , design               )        {
  const rows        = [];
  for (const w of plan.workloads) {
    const at = landing(plan, design, w.id);
    rows.push({ parent: w.app, parent_class: APP_CLASS, type: 'Depends on::Used by', child: w.rename ?? w.name, child_class: at ? serverClass(w, at.platform) : osServerClass(w) });
  }
  for (const d of plan.databases) rows.push({ parent: d.app, parent_class: APP_CLASS, type: 'Depends on::Used by', child: d.name, child_class: dbClass(d) });
  return rows.sort((a, b) => `${a.parent}${a.child}`.localeCompare(`${b.parent}${b.child}`));
}

/** The asset register, with findings for data-bearing assets without a sanitisation record. */
export function assetRegister(plan                      )                                       {
  const findings            = [];
  const rows = (plan.dcExit?.assets ?? []).map((a, i)      => {
    const path = `dcExit.assets[${i}]`;
    if (a.containsData && !a.sanitisation) {
      findings.push(error('asset.sanitisation-missing', `Asset ${a.id} holds data and has no sanitisation method (NIST SP 800-88: clear, purge or destroy).`, {
        path, source: 'https://csrc.nist.gov/pubs/sp/800/88/r1/final',
      }));
    }
    if (a.disposedOn && a.containsData && !a.certificateId) {
      findings.push(warning('asset.certificate-missing', `Asset ${a.id} was disposed of without a sanitisation certificate id.`, { path }));
    }
    return {
      id: a.id, kind: a.kind, serial: a.serial ?? '', location: a.location ?? '', contains_data: a.containsData ? 'yes' : 'no',
      sanitisation: a.sanitisation ?? '', certificate_id: a.certificateId ?? '', disposed_on: a.disposedOn ?? '', register_updated: a.registerUpdated ? 'yes' : 'no',
    };
  });
  return { rows, findings };
}

/** update-cmdb.sh: upserts by name + class, retires sources. Applies by default. */
export function updateCmdbScript()         {
  return [
    '#!/usr/bin/env bash',
    '# Write new-cis.csv, retire.csv and relationships.csv to the ServiceNow CMDB (Table API).',
    '# Applies by default; --dry-run prints each call instead. Idempotent by name + class.',
    '# Needs SN_INSTANCE, SN_USER and SN_PASSWORD (or SN_PASSWORD_FILE, mode 600, or ATK_VAULT_CMD).',
    'set -euo pipefail',
    'DRY_RUN=0',
    'for a in "$@"; do case "$a" in --dry-run) DRY_RUN=1 ;; *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;; esac; done',
    'cd "$(dirname "$0")"',
    '',
    ...ATK_SECRET_SH,
    '',
    ...SN_API_SH,
    '',
    '# CSV rows as JSON objects (header = keys). The files are written by the toolkit: no embedded newlines.',
    'csv_json() { jq -R -s -c \'split("\\n") | map(select(length > 0)) | (.[0] | split(",")) as $h | .[1:][] | split(",") | [$h, .] | transpose | map({(.[0]): (.[1] // "")}) | add\' "$1"; }',
    '',
    'failed=0',
    'upsert() {',
    '  local class="$1" name="$2" body="$3" sys',
    '  sys=$(sn GET "/api/now/table/${class}" -G --data-urlencode "sysparm_query=name=${name}" --data-urlencode "sysparm_fields=sys_id" \\',
    '    --data-urlencode "sysparm_limit=1" | jq -r \'.result[0].sys_id // empty\') || { failed=1; return; }',
    '  local verb=create; [[ -n "$sys" ]] && verb=update',
    '  if (( DRY_RUN )); then echo "would ${verb} ${class} ${name}: ${body}"; return; fi',
    '  if [[ -n "$sys" ]]; then sn PATCH "/api/now/table/${class}/${sys}" --data "$body" >/dev/null || { failed=1; return; }',
    '  else sn POST "/api/now/table/${class}" --data "$body" >/dev/null || { failed=1; return; }; fi',
    '  echo "${verb}d ${class} ${name}"',
    '}',
    '',
    'while IFS= read -r ci; do',
    '  upsert "$(jq -r .class <<<"$ci")" "$(jq -r .name <<<"$ci")" "$(jq -c \'{name, ip_address: (.ip_addresses | split(" ")[0] // ""), environment, short_description: ("App: " + .app)}\' <<<"$ci")"',
    'done < <(csv_json new-cis.csv)',
    '',
    'while IFS= read -r ci; do',
    '  upsert "$(jq -r .class <<<"$ci")" "$(jq -r .name <<<"$ci")" "$(jq -c \'{install_status}\' <<<"$ci")"',
    'done < <(csv_json retire.csv)',
    '',
    'echo "Relationships: import relationships.csv with an import set into cmdb_rel_ci, or add them in the CI\'s related items."',
    'exit $(( failed ? 10 : 0 ))',
    '',
  ].join('\n');
}

                                                                                                            

export function cmdbFiles(plan      , options                                                                                                                   = {})            {
  const assets = assetRegister(plan);
  const files                         = {
    'governance/cmdb/new-cis.csv': rowsCsv(NEW_CI_COLUMNS, newCis(plan, options.design)),
    'governance/cmdb/retire.csv': rowsCsv(RETIRE_COLUMNS, retireCis(plan, options.tracker)),
    'governance/cmdb/relationships.csv': rowsCsv(RELATIONSHIP_COLUMNS, relationships(plan, options.design)),
    'governance/cmdb/asset-register.csv': rowsCsv(ASSET_COLUMNS, assets.rows),
  };
  if (options.script !== false) files['governance/cmdb/update-cmdb.sh'] = updateCmdbScript();
  return { files, findings: assets.findings };
}
