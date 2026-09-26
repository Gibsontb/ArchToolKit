/**
 * Tier-2 provider sheets read back in (the provider methodology, 6(c)):
 *
 * - The AWS Transform MGN inventory import CSV
 *   (https://docs.aws.amazon.com/mgn/latest/ug/import-parameters.html):
 *   `mgn:app:name`, `mgn:wave:name`, `mgn:server:user-provided-id`,
 *   `mgn:server:platform`, `mgn:server:fqdn-for-action-framework`,
 *   `mgn:server:tag:<k>`, `mgn:launch:instance-type`, … It is both an input
 *   and an output of execution (WP-11 writes it); reading it lets a user who
 *   already maintains one bring their app and wave model in.
 * - The Cloud Migration Factory on AWS intake form: `wave_name`, `app_name`,
 *   `server_name`, `server_os_family`, `server_os_version`, `server_fqdn`,
 *   `server_tier`, `server_environment`, `r_type`, `instanceType`, `Tags`,
 *   `private_ip`, …
 *
 * Neither carries the source machine's size, so vCPU and memory are taken
 * from the target instance type when one is given (the AWS catalogue), with
 * a finding that they are target sizes, not measurements. The Migrate to VMs
 * bulk CSV is an execution hand-off (WP-11 exports it) and carries no
 * inventory worth reading back, so it has no parser.
 */

import { info, warning,              } from '../../../../core/findings.js';
import { instanceSpec } from '../../../../kit/instance-specs.js';
import { classifyOs } from '../../os.js';
import { ENV_OPTIONS, optionValue } from '../../options.js';
                                                                             
import { concatIntake, emptyIntake,                                       } from '../adapter.js';
import { intakeFromSourceServers,                                             } from './common.js';
import { cell, list, mapHeader, readTable, skipped,                 } from './table.js';

export const MGN_IMPORT_SOURCE = 'https://docs.aws.amazon.com/mgn/latest/ug/import-parameters.html';
export const CMF_SOURCE = 'https://docs.aws.amazon.com/pdfs/solutions/latest/cloud-migration-factory-on-aws/cloud-migration-factory-on-aws.pdf';

                             
                                   
                                  
                                         
                                                            
                                                         
                               
 

const STRATEGY                                              = {
  rehost: 'rehost', replatform: 'replatform', refactor: 'refactor', rearchitect: 'rearchitect', relocate: 'relocate', revise: 'revise', rebuild: 'rebuild',
  repurchase: 'repurchase', retire: 'retire', retain: 'retain',
};

function fromInstanceType(type        , name        , findings           )                                   {
  if (!type) return { vcpu: 0, ramGib: 0 };
  const spec = instanceSpec('aws', type);
  if (!spec) { findings.push(warning('plan.sources.tier2.unknown-type', `${name}: instance type "${type}" is not in the AWS catalogue.`)); return { vcpu: 0, ramGib: 0 }; }
  return { vcpu: spec.vcpu, ramGib: spec.ramGib };
}

// ---------------------------------------------------------------------------
// MGN import CSV
// ---------------------------------------------------------------------------

                                                                                                                      
export const MGN_HEADERS                       = {
  account: ['mgn:account-id'], region: ['mgn:region'], app: ['mgn:app:name'], wave: ['mgn:wave:name'],
  userId: ['mgn:server:user-provided-id'], platform: ['mgn:server:platform'], fqdn: ['mgn:server:fqdn-for-action-framework'],
  instanceType: ['mgn:launch:instance-type'], privateIp: ['mgn:launch:nic:0:private-ip:0'],
};

export function parseMgnImportCsv(text        , origin                 = 'other')             {
  const t = readTable(text);
  const map = mapHeader(t.header, MGN_HEADERS, [], 'plan.sources.mgn-import', 'The MGN import CSV');
  const findings            = [...map.findings];
  if (map.index.userId === undefined && map.index.fqdn === undefined) {
    return { servers: [], waves: {}, strategies: {}, findings: [...findings, warning('plan.sources.mgn-import.missing-column', 'The MGN import CSV has neither mgn:server:user-provided-id nor mgn:server:fqdn-for-action-framework.', { source: MGN_IMPORT_SOURCE })] };
  }
  const tagCols = t.header.map((h, i) => ({ m: /^mgn:server:tag:(.+)$/i.exec(h.trim()), i })).filter((x) => x.m).map((x) => ({ key: x.m [1] , i: x.i }));
  const servers                 = [];
  const waves                         = {};
  const bad           = [];
  const seen = new Set        ();
  t.rows.forEach((row, i) => {
    const fqdn = cell(row, map, 'fqdn');
    const name = cell(row, map, 'userId') || fqdn.split('.')[0] || '';
    if (!name) { bad.push(t.lines[i] ); return; }
    // The sheet has one row per server per app / wave object; keep the first row per server.
    if (seen.has(name.toLowerCase())) return;
    seen.add(name.toLowerCase());
    const size = fromInstanceType(cell(row, map, 'instanceType'), name, findings);
    const wave = cell(row, map, 'wave');
    if (wave) waves[name] = wave;
    const tags                         = {};
    for (const c of tagCols) if ((row[c.i] ?? '').trim()) tags[c.key] = row[c.i] .trim();
    const ip = cell(row, map, 'privateIp');
    servers.push({
      name,
      ...(cell(row, map, 'app') ? { app: cell(row, map, 'app') } : {}),
      os: classifyOs(cell(row, map, 'platform')),
      vcpu: size.vcpu,
      memoryGib: size.ramGib,
      disksGib: [],
      provisionedGib: 0,
      sourceKey: `mgn/${name}`,
      facts: { powerState: 'unknown', ...(ip ? { ipAddresses: [ip] } : {}), ...(cell(row, map, 'platform') ? { guestOsRaw: cell(row, map, 'platform') } : {}) },
      origin,
      sourceRef: { platform: origin, ...(cell(row, map, 'region') ? { region: cell(row, map, 'region') } : {}) },
      ...(Object.keys(tags).length > 0 ? { tags } : {}),
    });
  });
  findings.push(...skipped('plan.sources.mgn-import.row', 'MGN import', bad, 'no server id or FQDN'));
  if (servers.length > 0) findings.push(info('plan.sources.tier2.target-sizes', `${servers.length} server${servers.length === 1 ? '' : 's'} from the MGN sheet: vCPU and memory are the target instance type's, not measurements, and there are no disks.`, { source: MGN_IMPORT_SOURCE }));
  return { servers, waves, strategies: {}, findings };
}

// ---------------------------------------------------------------------------
// Cloud Migration Factory intake form
// ---------------------------------------------------------------------------

                                                                                                                                                                        
export const CMF_HEADERS                       = {
  wave: ['wave_name'], app: ['app_name'], account: ['aws_accountid'], region: ['aws_region'], server: ['server_name'],
  osFamily: ['server_os_family'], osVersion: ['server_os_version'], fqdn: ['server_fqdn'], tier: ['server_tier'],
  env: ['server_environment'], rType: ['r_type'], instanceType: ['instanceType'], tags: ['Tags'], privateIp: ['private_ip'],
};

export function parseCmfIntakeCsv(text        , origin                 = 'other')             {
  const t = readTable(text);
  const map = mapHeader(t.header, CMF_HEADERS, ['server'], 'plan.sources.cmf-intake', 'The Cloud Migration Factory intake form');
  const findings            = [...map.findings];
  if (!map.ok) return { servers: [], waves: {}, strategies: {}, findings };
  const servers                 = [];
  const waves                         = {};
  const strategies                                    = {};
  const bad           = [];
  t.rows.forEach((row, i) => {
    const name = cell(row, map, 'server');
    if (!name) { bad.push(t.lines[i] ); return; }
    const osText = [cell(row, map, 'osVersion') || cell(row, map, 'osFamily')].join(' ');
    const size = fromInstanceType(cell(row, map, 'instanceType'), name, findings);
    const wave = cell(row, map, 'wave');
    if (wave) waves[name] = wave;
    const r = STRATEGY[cell(row, map, 'rType').toLowerCase().replace(/[^a-z]/g, '')];
    if (r) strategies[name] = r;
    const envCell = cell(row, map, 'env');
    const env = envCell ? optionValue(ENV_OPTIONS, envCell) : undefined;
    const tags                         = {};
    for (const pair of list(cell(row, map, 'tags'), /;\s*/)) { const at = pair.indexOf('='); if (at > 0) tags[pair.slice(0, at).trim()] = pair.slice(at + 1).trim(); }
    const tier = cell(row, map, 'tier');
    const ip = cell(row, map, 'privateIp');
    servers.push({
      name,
      ...(cell(row, map, 'app') ? { app: cell(row, map, 'app') } : {}),
      ...(env ? { env: env        } : {}),
      os: classifyOs(osText),
      guestOs: osText,
      vcpu: size.vcpu,
      memoryGib: size.ramGib,
      disksGib: [],
      provisionedGib: 0,
      ...(tier ? { annotation: `tier ${tier}` } : {}),
      sourceKey: `cmf/${name}`,
      facts: { powerState: 'unknown', guestOsRaw: osText, ...(ip ? { ipAddresses: [ip] } : {}) },
      origin,
      sourceRef: { platform: origin, ...(cell(row, map, 'region') ? { region: cell(row, map, 'region') } : {}) },
      ...(Object.keys(tags).length > 0 ? { tags } : {}),
    });
  });
  findings.push(...skipped('plan.sources.cmf-intake.row', 'intake form', bad, 'no server_name'));
  if (servers.length > 0) findings.push(info('plan.sources.tier2.target-sizes', `${servers.length} server${servers.length === 1 ? '' : 's'} from the intake form: vCPU and memory are the target instance type's, not measurements, and there are no disks.`, { source: CMF_SOURCE }));
  return { servers, waves, strategies, findings };
}

export function intakeFromTier2(kind               , texts                   , opts                                                             = {})               {
  const parsed = texts.map((t) => (kind === 'mgn' ? parseMgnImportCsv(t, opts.origin) : parseCmfIntakeCsv(t, opts.origin)));
  return concatIntake([{ ...emptyIntake(), findings: parsed.flatMap((p) => p.findings) }, intakeFromSourceServers(parsed.flatMap((p) => p.servers), { ...opts, basis: false })]);
}

export const MGN_IMPORT_CSV_ADAPTER                                                                                                                   = {
  id: 'mgn-import-csv',
  label: 'AWS Transform MGN inventory import CSV',
  itemSource: 'estate',
  parse: (input, options) => intakeFromTier2('mgn', input.files, options ?? {}),
};

export const CMF_INTAKE_CSV_ADAPTER                                                                                                                   = {
  id: 'cmf-intake-csv',
  label: 'Cloud Migration Factory on AWS intake form (CSV)',
  itemSource: 'estate',
  parse: (input, options) => intakeFromTier2('cmf', input.files, options ?? {}),
};
