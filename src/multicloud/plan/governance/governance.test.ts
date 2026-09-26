import { describe, it } from 'node:test';
import { expect } from '../../../testing/expect.ts';
import { openXlsx } from '../../../core/xlsx.ts';
import { openZip } from '../../../core/zip.ts';
import { readYaml } from '../../../core/yaml-read.ts';
import { emptyPlan, emptyTracker } from '../store.ts';
import { itemId } from '../options.ts';
import type {
  App, Database, ItemDecision, Plan, PlanDecision, Platform, RaciRow, Tracker, Workload,
} from '../types.ts';
import { appendAudit, auditCsv, auditEntry, AUDIT_CAP } from './audit.ts';
import { changeRequestFiles, changeRequests, changeRequestsCsv, correlationId, SERVICENOW_CR_FIELDS } from './changes.ts';
import { cmdbFiles, newCis, retireCis } from './cmdb.ts';
import { commsFiles, noticeCriteria, waveViews } from './comms.ts';
import {
  appComplexity, AWS_COMPLEXITY_CRITERIA, awsComplexityScore, awsPriorityScore, bandOf, quadrantOf, valueEffortMatrix,
} from './complexity.ts';
import { ledgerCsv, portabilityLine, reclaimLedger } from './licences.ts';
import { CHECKLISTS, checklistMarkdown, opsFiles, slaRestatement, startOrder, trainingPlan } from './ops-runbooks.ts';
import { LEAPP_INHIBITOR_EXPR, leappInhibitors, osUpgradeFiles, upgradePlan } from './os-upgrade.ts';
import { defaultRaci, parseRaciCsv, raciCsv, rolesWith, validateRaci } from './raci.ts';
import { findRate, parseRateCard, rateCardCsv, rateCardTemplate } from './ratecard.ts';
import {
  capacityGrids, capacityReport, dcExitGrids, dcExitReport, evidencePack, executiveSummary, appDesignDocument, kpis, markdownToHtml,
  raidFiles, reportFileName, statusReport, waveReport, type ReportContext,
} from './reports.ts';
import { checkSignOff, requiredSignOffs, signOffSheet, whoCanSign } from './signoffs.ts';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const SAVED = '2025-01-15T08:00:00.000Z';
const DATE = '2025-03-20';

function server(name: string, app: string, extra: Partial<Workload> = {}): Workload {
  return {
    id: itemId('workload', name), name, app, env: 'prod', role: 'app', os: 'rhel-9', vcpu: 4, ramGib: 16, disksGib: [100, 400],
    criticality: 'tier1', rpo: '1h', rto: '4h', licence: 'li', dependsOn: [], source: 'manual', facts: { ipAddresses: [`10.0.0.${name.length}`] }, ...extra,
  };
}
function decided(id: string, kind: 'workload' | 'database', platform: Platform, method: ItemDecision['method'] = 'replicate'): ItemDecision {
  return { id, kind, disposition: 'rehost', method, options: [{ platform, score: 10, hits: [] }], chosen: { platform, score: 10, hits: [] }, pinned: false, margin: 3, findings: [] };
}

function fixture(): Plan {
  const base = emptyPlan('Contoso exit', SAVED);
  const workloads: Workload[] = [
    server('shop-web', 'shop', { role: 'web', dependsOn: ['shop-app'] }),
    server('shop-app', 'shop', { dependsOn: ['shop-db', 'crm-api'] }),
    server('shop-db', 'shop', { role: 'db', os: 'win-2008r2', vcpu: 16, facts: { ipAddresses: ['10.0.0.9'], readiness: [{ id: 'rdm', severity: 'blocker' }] } }),
    server('crm-api', 'crm', { os: 'win-2019', criticality: 'tier3' }),
    server('old-box', 'crm', { os: 'centos-7', upgrade: 'before-move', disposition: 'rehost' }),
  ];
  const databases: Database[] = [{
    id: itemId('database', 'shopdb'), name: 'shopdb', engine: 'sqlserver', edition: 'sql-enterprise', version: 'sql-2016', hosts: ['shop-db'],
    vcpu: 16, ramGib: 64, sizeGib: 800, ha: 'none', dr: 'none', features: [], licence: 'byol-sa', app: 'shop', source: 'manual',
  }];
  const apps: App[] = [
    { id: itemId('app', 'shop'), name: 'shop', owner: 'Retail', criticality: 'tier0', residency: 'eu', latencyToOnPrem: 'tolerant', special: 'none', rpo: '15m', rto: '1h', wave: 1, pattern: 'iis-dotnet' },
    { id: itemId('app', 'crm'), name: 'crm', criticality: 'tier3', residency: 'eu', latencyToOnPrem: 'tolerant', special: 'none', wave: 2, kind: 'cots', users: 200 },
  ];
  const items: Record<string, ItemDecision> = {};
  for (const w of workloads) items[w.id] = decided(w.id, 'workload', w.app === 'crm' ? 'azure' : 'aws', w.name === 'old-box' ? 'rebuild' : 'replicate');
  items[databases[0]!.id] = decided(databases[0]!.id, 'database', 'aws', 'managed-db');
  const decision: PlanDecision = { engineVersion: 't', platforms: ['aws', 'azure'], subsetScores: [{ platforms: ['aws', 'azure'], score: 90 }], items, findings: [] };
  return {
    ...base,
    id: 'abcd1234-ef56-4789-abcd-ef0123456789',
    workloads, databases, apps, decision,
    requirements: { ...base.requirements, frameworks: ['iso27001'], skills: { aws: 'some', azure: 'strong' } },
    execution: {
      pathOverrides: {}, keepDays: { tier0: 30, tier1: 21, tier2: 14, tier3: 7 }, hypercareDays: { tier0: 5, tier1: 4, tier2: 3, tier3: 2 },
      lagSeconds: { server: 60, db: 30 }, dnsZones: [], lbs: [], dataSets: [], vcfImportClusters: [], landingZones: {},
    },
    governance: { raci: [], cr: { system: 'servicenow', perWave: true }, comms: { helpdesk: 'Service desk: ext. 4000', sender: 'Migration office' }, cicd: 'none', environments: ['prod'] },
    dcExit: {
      exitDate: '2025-12-31', dualRunningDays: 30, hardwareRemovalDays: 60, infra: [{ id: 'I1', category: 'storage-array', name: 'array-1', disposition: 'retire', afterWave: 2, facts: {} }],
      external: [{ id: 'X1', kind: 'partner-allowlist', party: 'Bank', direction: 'out', protocol: 'SFTP', endpoint: 'sftp.bank.example', currentIps: ['198.51.100.7'], app: 'shop', noticeDays: 30 }],
      contracts: [{ id: 'C1', kind: 'colocation', vendor: 'DC Co', ends: '2025-12-31', noticeDays: 90 }],
      assets: [{ id: 'A1', kind: 'server', serial: 'SN1', containsData: true }, { id: 'A2', kind: 'switch', containsData: false }],
    },
  };
}

const WAVES = [
  { n: 1, start: '2025-03-01', end: '2025-03-10', apps: ['shop'], items: ['shop-web', 'shop-app', 'shop-db'] },
  { n: 2, start: '2025-04-01', end: '2025-04-10', apps: ['crm'], items: ['crm-api', 'old-box'] },
];
function waves(plan: Plan) {
  return waveViews(plan, {
    waves: WAVES.map((w) => ({ n: w.n, groups: [`g${w.n}`], start: w.start, end: w.end })),
    groups: WAVES.map((w) => ({ id: `g${w.n}`, items: w.items.map((n) => itemId('workload', n)).concat(w.n === 1 ? [itemId('database', 'shopdb')] : []), why: 'app', wave: w.n, method: 'replicate' as const })),
  });
}

function tracker(plan: Plan): Tracker {
  const t = emptyTracker(plan.id, SAVED);
  const st = (name: string, state: Tracker['items'][string]['state'], wave: number) => ({ item: itemId('workload', name), kind: 'workload' as const, wave, path: 'aws-mgn' as const, state, since: '2025-03-05T00:00:00Z', flags: [], rollbacks: 0 });
  return {
    ...t,
    items: {
      [itemId('workload', 'shop-web')]: st('shop-web', 'decommissioned', 1),
      [itemId('workload', 'shop-app')]: st('shop-app', 'accepted', 1),
      [itemId('workload', 'shop-db')]: st('shop-db', 'decommissioned', 1),
      [itemId('database', 'shopdb')]: { ...st('shop-db', 'decommissioned', 1), item: itemId('database', 'shopdb'), kind: 'database' as const },
    },
    events: [{ kind: 'archtoolkit.migration-status', v: 1, planId: plan.id, runId: 'r1', at: '2025-03-15T10:00:00Z', wave: 1, item: itemId('workload', 'shop-app'), name: 'shop-app', path: 'aws-mgn', step: 'validate', outcome: 'succeeded', dryRun: false, source: 'validation' }],
    gates: [{ wave: 1, gate: 'G2', decision: 'go', at: '2025-03-04T09:00:00Z', role: 'app-owner', criteria: [{ id: 'c1', auto: true, met: true, detail: 'ok' }] }],
    signoffs: [{ scope: 'app', id: 'shop', kind: 'plan-approved', role: 'app-owner', decision: 'approved', at: '2025-02-01T00:00:00Z', comment: 'Pat | retail' }],
    raid: {
      risks: [{ id: 'R1', risk: 'Licence audit', probability: 3, impact: 5, response: 'reduce', status: 'open' }, { id: 'R2', risk: 'Minor', probability: 1, impact: 1, response: 'accept', status: 'open' }],
      assumptions: [], issues: [{ id: 'I1', issue: 'Firewall change late', severity: 'sev2', wave: 2, blocks: ['crm-api'], opened: '2025-03-18', status: 'open' }],
      decisions: [{ id: 'D1', decision: 'Go for wave 1', by: 'app-owner', date: '2025-03-18', source: 'gate', links: [] }],
    },
    notices: [{ template: 't-14-announce', wave: 1, sentAt: '2025-02-15T00:00:00Z' }],
    decommissions: [
      { item: itemId('workload', 'shop-db'), at: '2025-03-19T00:00:00Z', hostsFreed: 1, backupVerified: true, cmdbUpdated: true },
      { item: itemId('workload', 'shop-web'), at: '2025-03-19T00:00:00Z', backupVerified: true, cmdbUpdated: false },
    ],
  };
}

function ctx(): ReportContext {
  const plan = fixture();
  return { plan, date: DATE, tracker: tracker(plan), waves: waves(plan), changes: [], audit: [auditEntry({ page: 'migration-change', area: 'waves', action: 'move', targets: ['shop'], summary: 'Moved shop to wave 1', role: 'migration-lead' }, '2025-02-01T00:00:00Z')] };
}

const envOf = (): Record<string, string | undefined> => (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const cwdOf = (): string => (globalThis as { process?: { cwd(): string } }).process?.cwd() ?? '';

/** No user name, machine name, working directory, "generated by" or run-time date. */
function assertNoFootprints(text: string): void {
  const env = envOf();
  for (const v of [env.USERNAME, env.USER, env.COMPUTERNAME, env.HOSTNAME]) {
    if (v && v.length > 2) expect(text.toLowerCase().includes(v.toLowerCase())).toBe(false);
  }
  const cwd = cwdOf();
  if (cwd) expect(text.includes(cwd)).toBe(false);
  expect(/generated (by|on|at)/i.test(text)).toBe(false);
  expect(text.includes(new Date().toISOString().slice(0, 10))).toBe(false);
}

// ---------------------------------------------------------------------------

describe('RACI', () => {
  const plan = fixture();
  const raci = defaultRaci(plan);

  it('has exactly one A per activity, and run rows per platform', () => {
    expect(raci.every((r) => rolesWith(r, 'A').length === 1)).toBe(true);
    expect(validateRaci(raci).filter((f) => f.severity === 'error')).toEqual([]);
    expect(raci.filter((r) => r.activity.startsWith('Patching')).map((r) => r.activity)).toEqual(['Patching — Amazon Web Services', 'Patching — Microsoft Azure']);
  });

  it('rejects an activity with no A or two', () => {
    const bad: RaciRow[] = [
      { activity: 'Nobody', phase: 'migrate', cells: { network: 'R' } },
      { activity: 'Two', phase: 'migrate', cells: { network: 'A', security: 'A', dba: 'R' } },
    ];
    const codes = validateRaci(bad).filter((f) => f.severity === 'error').map((f) => f.code);
    expect(codes).toEqual(['raci.one-accountable', 'raci.one-accountable']);
  });

  it('round-trips through CSV', () => {
    const back = parseRaciCsv(raciCsv(raci));
    expect(back.rows).toEqual(raci);
    expect(back.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });
});

describe('sign-offs', () => {
  const plan = fixture();
  const raci = defaultRaci(plan);
  const t = tracker(plan);

  it('lets only R / A roles sign, and records the role only', () => {
    expect(whoCanSign(raci, 'plan-approved')).toEqual(['migration-lead', 'app-owner']);
    expect(checkSignOff(raci, { scope: 'app', id: 'shop', kind: 'plan-approved', role: 'vendor', decision: 'approved', at: DATE }).map((f) => f.code)).toEqual(['signoff.role']);
    expect(checkSignOff(raci, { scope: 'app', id: 'shop', kind: 'plan-approved', role: 'app-owner', decision: 'approved', at: DATE })).toEqual([]);
  });

  it('lists what is needed, with state, and prints the sheet', () => {
    const req = requiredSignOffs(plan, raci, t, { shop: 1, crm: 2 });
    expect(req.find((r) => r.kind === 'plan-approved' && r.id === 'shop')?.state).toBe('approved');
    expect(req.find((r) => r.kind === 'go' && r.id === 'wave-1')?.state).toBe('missing');
    expect(req.some((r) => r.kind === 'lights-out')).toBe(false);
    const sheet = signOffSheet('shop', raci, t, 1);
    expect(sheet).toContain('| Role | Decision | Date | Comment |');
    expect(sheet).toContain('| Application owner | Approved | 2025-02-01 | Pat \\| retail |');
  });
});

describe('communications', () => {
  const c = ctx();
  const plan = c.plan;
  const wave = c.waves![0]!;
  const files = commsFiles({ plan, wave, raci: defaultRaci(plan), ...(plan.execution ? { execution: plan.execution } : {}), ...(plan.governance ? { governance: plan.governance } : {}) });

  it('renders every notice as md and txt, filled from the plan, sending nothing', () => {
    const md = files['governance/comms/wave-1/t-14-announce.md'] ?? '';
    expect(md).toContain('shop');
    expect(md).toContain('2025-03-01 to 2025-03-10');
    expect(md).toContain('Service desk: ext. 4000');
    expect(md).toContain('for 30 days after the cutover');
    expect(files['governance/comms/wave-1/t-14-announce.txt']).not.toContain('**');
    expect(Object.keys(files)).toContain('governance/comms/wave-1/t-28-commit.md');
    expect(Object.keys(files)).toContain('governance/comms/wave-1/partner-ip-change-X1.md');
    expect(files['governance/comms/wave-1/partner-ip-change-X1.md']).toContain('**Send by:** 2025-01-30');
    expect(files['governance/comms/wave-1/README.md']).toContain('Nothing here is sent automatically');
    expect(Object.keys(files).some((p) => p.includes('dc-exit-milestone'))).toBe(false);
  });

  it('gives G1 its notice criteria', () => {
    const crit = noticeCriteria(c.tracker!, 1);
    expect(crit.map((x) => [x.id, x.met])).toEqual([['notice.t-14-announce', true], ['notice.t-2-reminder', false]]);
  });
});

describe('change requests', () => {
  const c = ctx();
  const drafts = changeRequests(c.plan, c.waves!, { on: DATE, ...(c.plan.execution ? { execution: c.plan.execution } : {}), changeRecords: [{ id: 'chg-1', utility: 'resize', target: 'crm-api', summary: 'Resize to 8 vCPU', values: { size: 'D8s_v5' }, generatedAt: SAVED }] });

  it('writes the CSV with the ServiceNow change_request field names', () => {
    const csv = changeRequestsCsv(drafts);
    expect(csv.split('\n')[0]).toBe('short_description,description,justification,implementation_plan,backout_plan,test_plan,risk,impact,start_date,end_date,cmdb_ci,correlation_id');
    expect([...SERVICENOW_CR_FIELDS]).toHaveLength(12);
    expect(drafts.map((d) => d.id)).toEqual(['wave-1', 'wave-2', 'change-chg-1']);
    expect(drafts[0]!.record.correlation_id).toBe('atk-abcd1234-wave-1');
    expect(correlationId(c.plan, 'x')).toBe('atk-abcd1234-x');
    expect(drafts[0]!.record.risk).toBe('2');
    expect(drafts[0]!.record.impact).toBe('1');
    expect(drafts[0]!.record.start_date).toBe('2025-03-01 00:00:00');
  });

  it('generates an idempotent, apply-by-default ServiceNow script with no credential in it', () => {
    const files = changeRequestFiles(drafts);
    const sh = files['governance/changes/create-change-requests.sh'] ?? '';
    expect(sh).toContain('sysparm_query=correlation_id=');
    expect(sh).toContain('--dry-run');
    expect(sh).toContain('atk_secret SN_PASSWORD');
    expect(sh).toContain('POST /api/now/table/change_request');
    expect(sh.includes('-u "$SN_USER')).toBe(false);
    expect(files['governance/changes/wave-1.md']).toContain('## Backout plan');
    expect(JSON.parse(files['governance/changes/change-requests.json'] ?? '[]')).toHaveLength(3);
  });
});

describe('CMDB and asset register', () => {
  const c = ctx();

  it('classes the target CIs per platform and retires the decommissioned sources', () => {
    const cis = newCis(c.plan);
    expect(cis.find((r) => r.name === 'shop-web')?.class).toBe('cmdb_ci_ec2_instance');
    expect(cis.find((r) => r.name === 'crm-api')?.class).toBe('cmdb_ci_azure_instance');
    expect(cis.find((r) => r.name === 'shopdb')?.class).toBe('cmdb_ci_db_mssql_instance');
    const retire = retireCis(c.plan, c.tracker);
    expect(retire.map((r) => r.name)).toEqual(['shop-db', 'shop-web']);
    expect(retire.every((r) => r.install_status === '7')).toBe(true);
  });

  it('flags a data-bearing asset with no sanitisation', () => {
    const out = cmdbFiles(c.plan);
    expect(out.findings.map((f) => f.code)).toEqual(['asset.sanitisation-missing']);
    expect(out.files['governance/cmdb/asset-register.csv']?.split('\n')[0]).toBe('id,kind,serial,location,contains_data,sanitisation,certificate_id,disposed_on,register_updated');
    expect(out.files['governance/cmdb/update-cmdb.sh']).toContain('install_status');
  });
});

describe('licence reclaim', () => {
  const c = ctx();

  it('frees licences per decommissioned item, and Oracle clusters once empty', () => {
    const ledger = reclaimLedger(c.plan, c.tracker!, {
      oracleClusters: [
        { name: 'ora-a', hosts: 2, coresPerHost: 16, items: [itemId('workload', 'shop-db')] },
        { name: 'ora-b', hosts: 2, coresPerHost: 16, items: [itemId('workload', 'shop-db'), itemId('workload', 'crm-api')] },
      ],
    });
    expect(ledger.map((r) => `${r.licence}:${r.count}:${r.source}`)).toEqual(['oracle-processor:16:cluster ora-a', 'rhel:1:shop-web', 'windows-core:16:shop-db']);
    expect(ledgerCsv(ledger).split('\n')[0]).toBe('Licence,Count,Source,Freed on,Reassigned to,Status');
    expect(portabilityLine({ licence: 'sql-core', count: 16 }, { kind: 'sql-core', count: 8, model: 'licence-mobility', note: '' }, 'aws'))
      .toBe('SQL Server cores: 16 freed; 8 needed on Amazon Web Services via Licence Mobility (8 spare).');
  });
});

describe('rate card', () => {
  it('round-trips, skips bad rows, and finds a rate by region then region-less', () => {
    const csv = 'platform,region,category,key,unit,rate,currency,source\naws,eu-west-1,compute,m7i.xlarge,hour,0.2,USD,My EDP rates 2025\naws,,compute,m7i.xlarge,hour,0.25,USD,list\nmars,,compute,x,hour,1,USD,\naws,,storage,gp3,gib-month,,USD,\n';
    const { card, findings } = parseRateCard(csv);
    expect(card.rows).toHaveLength(2);
    expect(findings.map((f) => f.code)).toEqual(['ratecard.platform']);
    expect(findRate(card, { platform: 'aws', region: 'eu-west-1', category: 'compute', key: 'M7I.XLARGE' })?.rate).toBe(0.2);
    expect(findRate(card, { platform: 'aws', region: 'us-east-1', category: 'compute', key: 'm7i.xlarge' })?.rate).toBe(0.25);
    expect(parseRateCard(rateCardCsv(card)).card).toEqual(card);
    const template = rateCardTemplate(fixture());
    expect(template.split('\n')[0]).toBe('platform,region,category,key,unit,rate,currency,source');
    expect(template).toContain('on-prem,,facility,colocation-month');
  });
});

describe('audit trail', () => {
  it('keeps only the contract fields, no identity', () => {
    const e = auditEntry({ page: 'application-migration', area: 'apps', action: 'switch', targets: ['shop'], summary: 'x', user: 'alice', host: 'pc1' } as never, '2025-01-01T00:00:00Z');
    expect(Object.keys(e).sort()).toEqual(['action', 'area', 'at', 'page', 'summary', 'targets']);
    expect(auditCsv([e]).split('\n')[0]).toBe('at,page,area,action,targets,summary,role');
  });

  it('caps at 20,000, dropping the oldest, and warns near the cap', () => {
    const e = (i: number) => auditEntry({ page: 'migration-change', area: 'a', action: String(i), summary: '' }, '2025-01-01T00:00:00Z');
    const full = Array.from({ length: AUDIT_CAP }, (_, i) => e(i));
    const next = appendAudit(full, e(AUDIT_CAP));
    expect(next.entries).toHaveLength(AUDIT_CAP);
    expect(next.entries[0]?.action).toBe('1');
    expect(next.findings[0]?.code).toBe('audit.trimmed');
    expect(appendAudit(full.slice(0, 19_500), e(1)).findings[0]?.code).toBe('audit.near-cap');
  });
});

describe('complexity, the AWS sheet and value × effort', () => {
  const plan = fixture();

  it('scores A.10.17 from its listed factors', () => {
    const c = appComplexity(plan, 'shop', { on: DATE });
    const pts = Object.fromEntries(c.factors.map((f) => [f.id, f.points]));
    expect(pts.servers).toBe(16);
    expect(pts.databases).toBe(3);
    expect(pts['sync-edges']).toBe(2);
    expect(pts['external-links']).toBe(2);
    expect(pts.blockers).toBe(3);
    expect(pts.eol).toBe(2);
    expect(pts.downtime).toBe(2);
    expect(pts.pattern).toBe(1);
    expect(pts['cross-platform']).toBe(3);
    expect(c.score).toBe(Math.min(100, Math.round(c.factors.reduce((s, f) => s + f.points, 0) * 10) / 10));
    expect(c.band).toBe(bandOf(c.score));
    expect(c.risk).toBe('High');
    expect(bandOf(29.9)).toBe('Low');
    expect(bandOf(60)).toBe('Medium');
    expect(bandOf(60.1)).toBe('High');
  });

  it('builds the AWS complexity sheet: 8 business + 9 technical criteria', () => {
    expect(AWS_COMPLEXITY_CRITERIA.filter((c) => c.group === 'business')).toHaveLength(8);
    expect(AWS_COMPLEXITY_CRITERIA.filter((c) => c.group === 'technical')).toHaveLength(9);
    const s = awsComplexityScore(plan, 'crm', { 'aws-complexity.business-impact': '2', 'aws-complexity.storage': '5' }, DATE);
    expect(s.criteria.find((c) => c.id === 'business-impact')?.basis).toBe('answer');
    expect(s.criteria.find((c) => c.id === 'storage')?.score).toBe(5);
    expect(s.criteria.find((c) => c.id === 'server-count')?.basis).toBe('derived');
    expect(s.criteria.find((c) => c.id === 'users')?.score).toBe(2);
    expect(s.criteria.find((c) => c.id === 'staff-availability')?.basis).toBe('unanswered');
    expect(s.total).toBe(s.business + s.technical);
    const p = awsPriorityScore(plan, 'crm', DATE, 'azure');
    expect(p.attributes.find((a) => a.id === 'ops-maturity')?.score).toBe(80);
    expect(p.normalised).toBeGreaterThan(0);
  });

  it('places apps in the four value × effort quadrants', () => {
    expect(quadrantOf('high', 'low')).toEqual({ quadrant: 'quick-win', label: 'Quick wins', priority: 'High', wave: 1, value: 'high', effort: 'low' });
    expect(quadrantOf('low', 'high').wave).toBe(4);
    const m = valueEffortMatrix(plan, { on: DATE });
    expect(m.find((x) => x.app === 'shop')?.quadrant).toBe('strategic');
    expect(m.find((x) => x.app === 'shop')?.valueBasis).toBe('assumed');
  });
});

describe('operations: runbooks, training, SLA, checklists', () => {
  const plan = fixture();
  const raci = defaultRaci(plan);

  it('orders start-up by dependency, and reports a cycle', () => {
    expect(startOrder(plan, 'shop').order).toEqual(['shop-db', 'shop-app', 'shop-web']);
    const cyc = { ...plan, workloads: plan.workloads.map((w) => (w.name === 'shop-db' ? { ...w, dependsOn: ['shop-web'] } : w)) };
    const r = startOrder(cyc, 'shop');
    expect(r.order).toHaveLength(3);
    expect(r.findings[0]?.code).toBe('ops.start-order-cycle');
  });

  it('restates the SLA as a product of provider SLAs and flags a shortfall', () => {
    const s = slaRestatement(plan, 'shop');
    expect(s.required).toBe(99.99);
    expect(s.components.map((c) => c.name)).toEqual(['Compute', 'Database']);
    expect(s.composite).toBe(Math.round(0.9999 * 0.9995 * 1e6) / 1e4);
    expect(s.meets).toBe(false);
    expect(s.findings[0]?.code).toBe('sla.below-requirement');
    expect(slaRestatement(plan, 'shop', { overrides: { Database: 99.995, Compute: 99.999 } }).meets).toBe(true);
  });

  it('writes the runbooks, training plan and checklists', () => {
    const { files } = opsFiles(plan, raci);
    expect(files['runbooks/ops/shop.md']).toContain('1. shop-db');
    expect(files['runbooks/ops/shop.md']).toContain('aws backup start-restore-job');
    expect(trainingPlan(plan, raci).rows.map((r) => [r.platform, r.gap])).toEqual([['aws', true], ['azure', false]]);
    expect(CHECKLISTS.filter((c) => c.kind === 'hypercare').map((c) => c.id)).toEqual(['H01', 'H02', 'H03', 'H04', 'H05', 'H06', 'H07']);
    expect(CHECKLISTS.filter((c) => c.kind === 'decommission')).toHaveLength(7);
    expect(CHECKLISTS.filter((c) => c.kind === 'day-2')).toHaveLength(8);
    expect(checklistMarkdown('hypercare', 'azure')).toContain('Stabilization');
    expect(files['governance/checklists/governance.md']).toContain('RAID log');
  });
});

describe('OS upgrade plays', () => {
  const plan = fixture();

  it('the Leapp play fails on inhibitors, before it upgrades', () => {
    const { files } = osUpgradeFiles(plan, DATE);
    const yml = files['os-upgrade/os-upgrade-rhel.yml'] ?? '';
    const play = (readYaml(yml).documents[0] as { tasks: { name: string; when?: string; 'ansible.builtin.fail'?: unknown; 'ansible.builtin.command'?: string }[] }[])[0]!;
    const names = play.tasks.map((t) => t.name);
    const stop = names.indexOf('Stop when Leapp reports inhibitors');
    const upgrade = names.indexOf('Upgrade');
    expect(stop).toBeGreaterThan(-1);
    expect(stop).toBeLessThan(upgrade);
    expect(play.tasks[stop]?.['ansible.builtin.fail']).toBeDefined();
    expect(play.tasks[stop]?.when).toBe('leapp_inhibitors | length > 0');
    const collect = play.tasks[names.indexOf('Collect inhibitor titles')] as unknown as { 'ansible.builtin.set_fact': { leapp_inhibitors: string } };
    expect(collect['ansible.builtin.set_fact'].leapp_inhibitors).toContain(LEAPP_INHIBITOR_EXPR);
    expect(LEAPP_INHIBITOR_EXPR).toContain("selectattr('flags', 'contains', 'inhibitor')");
    expect(LEAPP_INHIBITOR_EXPR).toContain("selectattr('groups', 'contains', 'inhibitor')");
    expect(play.tasks[upgrade]?.['ansible.builtin.command']).toContain('leapp upgrade');
    expect(leappInhibitors({ entries: [{ title: 'a', flags: ['inhibitor'] }, { title: 'b', groups: ['inhibitor'] }, { title: 'c', groups: ['error'] }] })).toEqual(['a', 'b']);
    expect(files['os-upgrade/os-upgrade-oracle-linux.yml']).toContain('--oraclelinux');
    expect(files['os-upgrade/os-upgrade-windows.yml']).toContain('/auto upgrade /quiet /imageindex');
    expect(files['os-upgrade/os-upgrade-ubuntu.yml']).toContain('do-release-upgrade -f DistUpgradeViewNonInteractive');
  });

  it('flags EOL without an upgrade, and paths that do not exist', () => {
    const p = { ...plan, workloads: [...plan.workloads, { ...plan.workloads[3]!, id: 'w:x', name: 'x', upgrade: 'during-move' as const }] };
    const { findings, rows } = upgradePlan(p, DATE);
    const codes = findings.map((f) => f.code);
    expect(codes).toContain('os.eol');
    expect(codes).toContain('os.upgrade.no-path');
    expect(codes).toContain('os.upgrade.during-move');
    expect(rows.find((r) => r.workload === 'shop-db')?.upgrade).toBe('none');
  });
});

describe('reports', () => {
  it('re-opens the xlsx reports with openXlsx with identical cells', async () => {
    const c = ctx();
    const cap = await capacityReport(c);
    const book = await openXlsx(cap.xlsx);
    const grids = capacityGrids(c);
    expect(book.sheets).toEqual(grids.map((g) => g.name));
    for (const g of grids) {
      const rows: string[][] = [];
      await book.rows(g.name, (cells) => {
        rows.push(cells);
      });
      expect(rows).toEqual([[...g.columns], ...g.rows.map((r) => r.map((v) => (v === undefined || v === null ? '' : typeof v === 'boolean' ? (v ? 'True' : 'False') : String(v))))].map((r) => {
        const x = [...r];
        while (x.length && x[x.length - 1] === '') x.pop();
        return x;
      }));
    }
    const dc = await dcExitReport(c);
    expect((await openXlsx(dc.xlsx)).sheets).toEqual(dcExitGrids(c.plan).map((g) => g.name));
  });

  it('is byte-identical across two runs', async () => {
    const a = await evidencePack(ctx());
    const b = await evidencePack(ctx());
    expect(a.bytes.length).toBe(b.bytes.length);
    expect(a.bytes.every((x, i) => x === b.bytes[i])).toBe(true);
    const x1 = (await capacityReport(ctx())).xlsx;
    const x2 = (await capacityReport(ctx())).xlsx;
    expect(x1.every((x, i) => x === x2[i]) && x1.length === x2.length).toBe(true);
    expect(executiveSummary(ctx()).doc).toBe(executiveSummary(ctx()).doc);
  });

  it('carries no user or machine info', async () => {
    const c = ctx();
    const texts = [
      executiveSummary(c).markdown, executiveSummary(c).html, executiveSummary(c).doc,
      appDesignDocument(c, 'shop').html, waveReport(c, 1).html, statusReport(c),
      ...Object.values((await evidencePack(c)).files),
    ];
    for (const t of texts) assertNoFootprints(t);
    expect(reportFileName(c, 'status-report', 'md')).toBe('contoso-exit-status-report-2025-03-20.md');
  });

  it('builds the evidence pack with every part', async () => {
    const pack = await evidencePack(ctx());
    const names = openZip(pack.bytes).names;
    for (const p of ['README.md', 'audit/audit.csv', 'decisions/raid-decisions.csv', 'gates/wave-1-G2-2025-03-04.json', 'signoffs/shop.md', 'changes/wave-1.md',
      'changes/change-requests.csv', 'changes/utility-log.csv', 'validation/validation-events.csv', 'validation/backup-verification.csv', 'assets/asset-register.csv',
      'licences/licence-ledger.csv', 'governance/raci.csv', 'controls.md']) expect(names).toContain(p);
    expect(pack.files['README.md']).toContain('Plan saved 2025-01-15');
  });

  it('writes the status report, KPIs and RAID exports', () => {
    const c = ctx();
    const k = kpis(c);
    expect(k.inScope).toBe(6);
    expect(k.cutOver).toBe(4);
    expect(k.decommissioned).toBe(3);
    expect(k.migratedVsPlan).toEqual({ planned: 4, done: 4 });
    expect(k.pctByCount).toBe(67);
    const s = statusReport(c);
    expect(s).toContain('**RAG: Amber.**');
    for (const h of ['## Progress by wave', '## Done this period', '## Planned next period', '## Top five risks', '## Open Sev 1 / Sev 2 issues', '## Blockers', '## Decisions this period', '## Burn-down', '## Decommission due']) expect(s).toContain(h);
    expect(s).toContain('| Wave | Items | Planned end | Cut over | Validated | Decommissioned | % | Forecast end | On track |');
    expect(s).toContain('Wave 2 from 2025-04-01');
    const raid = raidFiles(c.tracker!);
    expect(raid['raid-risks.csv']?.split('\n')[0]).toBe('ID,Risk,Wave,App,Probability,Impact,Score,Owner,Response,Mitigation,Status,Review by');
    expect(raid['raid-risks.csv']).toContain(',15,');
  });

  it('renders HTML safely with print CSS', () => {
    const html = markdownToHtml('# T <x>\n\n| a | b |\n|---|---|\n| <script> | 1 |\n', 'T');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('@media print');
    expect(html.includes('<script>')).toBe(false);
  });
});
