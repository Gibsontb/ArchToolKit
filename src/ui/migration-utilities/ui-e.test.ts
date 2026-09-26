/**
 * WP-UI-E: the data-centre pane's model side. Every A.5.5 grid round-trips
 * through CSV, the closed columns are dropdowns that refuse other values,
 * legal hold and sanitisation are enforced in the cells, the lights-out list
 * is computed from the grids, and the generated-rules view marks each rule
 * config, flows or both.
 */

import { describe, it } from 'node:test';
import { expect } from '../../testing/expect.ts';
import { emptyPlan } from '../../multicloud/plan/store.ts';
import { INFRA_DISPOSITION_VALUES, defaultDcExit, itemId } from '../../multicloud/plan/options.ts';
import type { DcExit, InfraItem, Plan, Workload } from '../../multicloud/plan/types.ts';
import { exitSequence, lightsOut } from '../../multicloud/plan/dcexit/sequence.ts';
import { netsecContext, parseDeviceConfig, translateConfigs } from '../../multicloud/plan/netsec/translate.ts';
import { rowCells, applyCells } from '../multicloud/grid-model.ts';
import {
  ALL_GRIDS, ARCHIVES_GRID, ASSETS_GRID, CIRCUITS_GRID, CONTRACTS_GRID, DEVICES_GRID, INFRA_GRIDS, OTHER_GRID, contractStatuses,
  duplicateIds, gridFromCsv, gridToCsv, undecided, type DcGrid,
} from './datacentre-grids.ts';
import { guessParser, ruleCells, translationSummary } from './netsec-view.ts';
import { SUBTABS, dcFindings, exitInputFor, exitWavesCsv, lightsOutStatus, noticeWave, parseReIpMap } from './datacentre.ts';

/* ------------------------------------------------------------------ fixtures --- */

const item = (id: string, category: InfraItem['category'], name: string, facts: Record<string, string>, extra: Partial<InfraItem> = {}): InfraItem => ({ id, category, name, disposition: 'retire', facts, ...extra });

function dc(): DcExit {
  return {
    exitDate: '2026-12-31',
    dualRunningDays: 14,
    hardwareRemovalDays: 30,
    infra: [
      item('d1', 'network-device', 'edge-rtr', { kind: 'router', platform: 'cisco_ios', role: 'wan edge', configFile: 'edge-rtr.cfg' }, { site: 'dc1', model: 'ISR4451' }),
      item('d2', 'network-device', 'fw1', { kind: 'firewall', platform: 'fortios' }, { site: 'dc1' }),
      item('c1', 'circuit', 'p2p-dc1', { kind: 'p2p', provider: 'Carrier', sites: 'dc1', contractEnd: '2027-06-30', noticeDays: '60', device: 'edge-rtr', neighbor: '192.0.2.1', remoteAs: '64500', localAs: '65001', prefixes: '10.9.0.0/16 2001:db8:9::/48', nextHop: '192.0.2.1' }),
      item('c2', 'circuit', 'inet-dc1', { kind: 'internet', provider: 'ISP A', sites: 'dc1', bandwidth: '1 Gbps' }),
      item('s1', 'subnet', 'web', { cidr: '10.1.1.0/24', vlan: '101', strategy: 're-ip', apps: 'shop' }, { site: 'dc1' }),
      item('n1', 'net-service', 'dns1', { kind: 'dns', servers: 'dns1 dns2' }, { vendor: 'Windows DNS' }),
      item('st1', 'storage-array', 'array1', { kind: 'san', rawTib: '200', usedTib: '120.5', protocols: 'FC iSCSI', apps: 'shop' }, { vendor: 'NetApp', site: 'dc1' }),
      item('b1', 'backup', 'Veeam', { appliances: 'vbr1', protectedTib: '80', retentionPolicy: '30 days' }, { disposition: 'replace', target: 'AWS Backup' }),
      item('a1', 'archive', 'tapes-2019', { media: 'tape', location: 'Iron Mountain', retentionUntil: '2031-01-01', legalHold: 'yes' }, { disposition: 'migrate', owner: 'legal' }),
      item('a2', 'archive', 'tapes-2022', { media: 'tape', retentionUntil: '2030-01-01', legalHold: 'no', obligation: 'keep-until-expiry' }, { disposition: 'stays' }),
      item('sec1', 'security-service', 'corp-pki', { kind: 'pki', servers: 'ca1' }, { vendor: 'AD CS', disposition: 'migrate' }),
      item('sec2', 'security-service', 'hsm', { kind: 'hsm', keyMigration: 're-key' }, { vendor: 'Thales', disposition: 'replace', target: 'AWS CloudHSM' }),
      item('o1', 'ops-tool', 'nagios', { kind: 'monitoring', servers: 'mon1' }, { disposition: 'replace', target: 'CloudWatch' }),
      item('j1', 'job', 'nightly-export', { scheduler: 'cron', host: 'shop-app', schedule: '30 2 * * *', command: '/opt/shop/export.sh', runsAs: 'shop', app: 'shop' }, { disposition: 'migrate' }),
      item('x1', 'print', 'print01', { location: 'Floor 2', notes: 'queues for finance' }),
      item('x2', 'ot-iot', 'bms', { location: 'Plant room' }, { disposition: 'stays' }),
    ],
    external: [{ id: 'bank', kind: 'partner-allowlist', party: 'Bank', direction: 'out', protocol: 'sftp', endpoint: 'sftp.bank.example', currentIps: ['10.1.1.10', '203.0.113.20'], app: 'shop', noticeDays: 30 }],
    contracts: [
      { id: 'k1', kind: 'colocation', vendor: 'Colo Ltd', ends: '2027-03-31', noticeDays: 90 },
      { id: 'k2', kind: 'support', vendor: 'Vendor', ends: '2026-06-30', noticeDays: 30, status: 'notice-given' },
    ],
    assets: [
      { id: 'as1', kind: 'server', serial: 'SN1', location: 'R1', containsData: true, sanitisation: 'purge', certificateId: 'CERT-1', disposedOn: '2027-01-10', registerUpdated: true },
      { id: 'as2', kind: 'disk shelf', containsData: true },
      { id: 'as3', kind: 'switch', containsData: false },
    ],
  };
}

const workload = (name: string, app: string, ip: string, role: Workload['role'] = 'app'): Workload =>
  ({ id: itemId('workload', name), name, app, env: 'prod', role, os: 'rhel-9', vcpu: 2, ramGib: 8, disksGib: [64], criticality: 'tier2', rpo: '4h', rto: '4h', licence: 'li', dependsOn: [], source: 'manual', pin: 'aws', facts: { ipAddresses: [ip] } }) as unknown as Workload;

function plan(over: Partial<Plan> = {}): Plan {
  return { ...emptyPlan('DC Test', '2026-09-26T00:00:00.000Z'), id: 'plan-uie', mode: 'dc-exit', dcExit: dc(), workloads: [workload('shop-web', 'shop', '10.1.1.10', 'web'), workload('shop-app', 'shop', '10.1.2.10')], ...over };
}

/* --------------------------------------------------------------------- tests --- */

describe('the data-centre grids', () => {
  it('cover every A.5.5 area', () => {
    const ids = ALL_GRIDS.map((g) => g.id);
    expect(ids).toEqual(['dc-devices', 'dc-circuits', 'dc-subnets', 'dc-netservices', 'dc-arrays', 'dc-backup', 'dc-archives', 'dc-security', 'dc-ops', 'dc-jobs', 'dc-other', 'dc-external', 'dc-contracts', 'dc-assets']);
    const categories = new Set(INFRA_GRIDS.flatMap((g) => g.read({ ...defaultDcExit(), infra: dc().infra }).map((i) => i.category)));
    expect([...categories].sort()).toEqual(['archive', 'backup', 'circuit', 'job', 'net-service', 'network-device', 'ot-iot', 'print', 'ops-tool', 'security-service', 'storage-array', 'subnet'].sort());
    expect(SUBTABS.map((t) => t.id)).toEqual(['network', 'storage', 'security', 'operations', 'other', 'partners', 'facility', 'netsec', 'sequence', 'people']);
  });

  it('every grid round-trips through CSV', () => {
    for (const g of ALL_GRIDS as readonly DcGrid<{ id: string }>[]) {
      const rows = g.read(dc());
      expect(`${g.id} ${rows.length > 0}`).toBe(`${g.id} true`);
      const csv = gridToCsv(g, rows);
      const back = gridFromCsv(g, csv, [], new Set());
      expect(back.findings.filter((f) => f.code === 'dc.csv-cell')).toEqual([]);
      expect(back.rows.map((r) => rowCells(r, g.columns))).toEqual(rows.map((r) => rowCells(r, g.columns)));
      expect(gridToCsv(g, back.rows)).toBe(csv);
      // Writing the rows back leaves the data centre as it was.
      expect(g.read(g.write(dc(), rows))).toEqual(rows);
    }
  });

  it('imports by heading, not position, and merges on the first column', () => {
    const csv = 'Notice days,Vendor,Contract,Ends,Kind\n45,New Vendor,k1,2027-03-31,colocation\n30,Power Co,k3,2027-01-31,power\n';
    const r = gridFromCsv(CONTRACTS_GRID, csv, dc().contracts, new Set());
    expect(r.rows.map((c) => [c.id, c.vendor, c.noticeDays])).toEqual([['k1', 'New Vendor', 45], ['k2', 'Vendor', 30], ['k3', 'Power Co', 30]]);
    expect(r.findings.some((f) => f.code === 'dc.csv-missing')).toBe(true);
    const noKey = gridFromCsv(CONTRACTS_GRID, 'Vendor\nX\n', [], new Set());
    expect(noKey.findings[0]?.code).toBe('dc.csv-columns');
  });

  it('keeps the disposition a closed set on every infrastructure grid', () => {
    for (const g of INFRA_GRIDS) {
      const col = g.columns.find((c) => c.key === 'disposition');
      expect(col?.options?.map((o) => o.value)).toEqual(['', ...INFRA_DISPOSITION_VALUES]);
      const row = g.create(new Set());
      const r = applyCells(row, g.columns, rowCells(row, g.columns).map((c, i) => (g.columns[i]?.key === 'disposition' ? 'demolish' : c)));
      expect(r.errors.length).toBe(1);
    }
    // Every dropdown column refuses a value it does not offer.
    for (const g of ALL_GRIDS as readonly DcGrid<{ id: string }>[]) {
      const row = g.read(dc())[0] as { id: string };
      g.columns.forEach((c, i) => {
        if (!c.options) return;
        const cells = rowCells(row, g.columns);
        cells[i] = 'not-a-choice';
        expect(`${g.id}.${c.key} ${applyCells(row, g.columns, cells).errors.length}`).toBe(`${g.id}.${c.key} 1`);
      });
    }
  });

  it('refuses retiring an archive under legal hold, and disposing of an unsanitised asset', () => {
    const a1 = dc().infra.find((i) => i.id === 'a1') as InfraItem;
    const r = applyCells(a1, ARCHIVES_GRID.columns, rowCells(a1, ARCHIVES_GRID.columns).map((c, i) => (ARCHIVES_GRID.columns[i]?.key === 'disposition' ? 'retire' : c)));
    expect(r.errors[0]).toContain('dc.legal-hold');
    expect(r.row.disposition).toBe('migrate');
    const a2 = { ...(dc().infra.find((i) => i.id === 'a2') as InfraItem), disposition: 'retire' as const };
    const hold = applyCells(a2, ARCHIVES_GRID.columns, rowCells(a2, ARCHIVES_GRID.columns).map((c, i) => (ARCHIVES_GRID.columns[i]?.key === 'legalHold' ? 'yes' : c)));
    expect(hold.errors[0]).toContain('dc.legal-hold');

    const as2 = dc().assets[1]!;
    const col = ASSETS_GRID.columns.findIndex((c) => c.key === 'disposedOn');
    const refused = applyCells(as2, ASSETS_GRID.columns, rowCells(as2, ASSETS_GRID.columns).map((c, i) => (i === col ? '2027-01-10' : c)));
    expect(refused.errors[0]).toContain('dc.sanitise');
    const cells = rowCells(as2, ASSETS_GRID.columns);
    cells[ASSETS_GRID.columns.findIndex((c) => c.key === 'sanitisation')] = 'destroy';
    cells[ASSETS_GRID.columns.findIndex((c) => c.key === 'certificateId')] = 'CERT-2';
    cells[col] = '2027-01-10';
    expect(applyCells(as2, ASSETS_GRID.columns, cells).row.disposedOn).toBe('2027-01-10');
  });

  it('checks dates and numbers, and writes facts under the engines’ names', () => {
    const c = CIRCUITS_GRID.create(new Set(['circuit-1']));
    expect(c.id).toBe('circuit-2');
    const cells = rowCells(c, CIRCUITS_GRID.columns);
    const at = (key: string) => CIRCUITS_GRID.columns.findIndex((x) => x.key === key);
    cells[at('name')] = 'mpls-1';
    cells[at('kind')] = 'MPLS';
    cells[at('contractEnd')] = '30/06/2027';
    cells[at('remoteAs')] = '64500';
    const r = applyCells(c, CIRCUITS_GRID.columns, cells);
    expect(r.errors.length).toBe(1);
    expect(r.row.facts).toEqual({ kind: 'mpls', remoteAs: '64500' });
    const other = OTHER_GRID.create(new Set());
    expect(other.category).toBe('other');
    expect(DEVICES_GRID.columns.find((x) => x.key === 'platform')?.options?.some((o) => o.value === 'cisco_asa')).toBe(true);
  });

  it('finds duplicate ids, undecided items and the contract statuses', () => {
    const d = { ...dc(), contracts: [...dc().contracts, { id: 'k1', kind: 'power' as const, vendor: 'x', ends: '2027-01-01', noticeDays: 0 }] };
    expect(duplicateIds(d).map((f) => f.path)).toEqual(['contract.k1']);
    const u = { ...dc(), infra: dc().infra.map((i) => (i.id === 'd1' ? { ...i, disposition: undefined } : i)) };
    expect(undecided(u)).toEqual([{ grid: 'Network devices', count: 1 }]);
    expect(contractStatuses(dc())).toEqual({ k2: 'notice-given' });
  });
});

describe('the sequence, lights-out and people views', () => {
  it('builds the exit sequence from the plan, with the circuit rollback for the Network page', () => {
    const p = plan({ apps: [{ id: itemId('app', 'shop'), name: 'shop', criticality: 'tier2', residency: 'any', latencyToOnPrem: 'tolerant', special: 'none', wave: 2 }] });
    const seq = exitSequence(exitInputFor(p, undefined, undefined, '2026-09-26'));
    expect(seq.waves.length).toBeGreaterThan(0);
    const circuit = seq.waves.flatMap((w) => w.steps).find((s) => s.item === 'c1');
    expect(circuit?.afterWave).toBe(2);
    expect(circuit?.handoff?.map((h) => h.blueprint)).toEqual(['ios_bgp_peer', 'ios_static_route', 'ios_static_route']);
    const csv = exitWavesCsv(seq);
    expect(csv.split('\n')[0]).toBe('wave,label,after_app_wave,date,step,kind,title,action,rollback');
    expect(csv).toContain('exit-circuit-c1');
    const findings = dcFindings(p, seq, '2026-09-26');
    expect(findings.some((f) => f.code === 'dc.terminate-by-past')).toBe(false);
    expect(findings.some((f) => f.code === 'dc.sanitise-pending')).toBe(true);
    expect(findings[0]?.severity === 'error' || findings.every((f) => f.severity !== 'error')).toBe(true);
  });

  it('computes the lights-out list from the grids', () => {
    const p = plan();
    const open = lightsOut(dcOf(p), lightsOutStatus(p, { cmdb: false, evidence: false }, '2026-09-26'));
    expect(open.find((c) => c.id === 'lo.powered-off')?.auto).toBe(false);
    expect(open.find((c) => c.id === 'lo.circuits')?.met).toBe(false);
    const d = dc();
    const done: DcExit = {
      ...d,
      infra: d.infra.map((i) => ({ ...i, facts: { ...i.facts, done: 'yes', ...(i.category === 'archive' ? { obligation: 'migrate-to-archive-tier' } : {}) } })),
      contracts: d.contracts.map((c) => ({ ...c, status: 'terminated' as const })),
      assets: d.assets.map((a) => ({ ...a, sanitisation: 'destroy' as const, certificateId: `C-${a.id}`, disposedOn: '2027-01-10', registerUpdated: true })),
    };
    const off = (w: Workload): Workload => ({ ...w, facts: { ...w.facts, powerState: 'poweredOff' } }) as Workload;
    const finished = plan({ dcExit: done, workloads: plan().workloads.map(off) });
    // The circuit's own contract (c1) counts as a contract to terminate.
    const status = lightsOutStatus(finished, { cmdb: true, evidence: true }, '2026-09-26');
    const closed = lightsOut(done, { ...status, contractStatus: { ...status.contractStatus, c1: 'terminated' } });
    expect(closed.filter((c) => !c.met).map((c) => c.id)).toEqual([]);
  });

  it('reads the re-IP map and picks the notice wave', () => {
    const m = parseReIpMap('10.1.1.10 10.100.1.10\n2001:db8::1 | 2001:db8:100::1\n# note\nbroken line here\n');
    expect([...m.map.entries()]).toEqual([['10.1.1.10', '10.100.1.10'], ['2001:db8::1', '2001:db8:100::1']]);
    expect(m.bad).toEqual(['broken line here']);
    const views = [{ n: 1, apps: ['crm'], items: [] }, { n: 2, apps: ['shop'], items: [] }];
    expect(noticeWave(views, 'shop').n).toBe(2);
    expect(noticeWave(views, 'hr').n).toBe(1);
    expect(noticeWave([], undefined).n).toBe(0);
  });
});

const dcOf = (p: Plan): DcExit => p.dcExit ?? defaultDcExit();

describe('the firewall and load-balancer view', () => {
  const ASA = `hostname edge-asa
object network WEB-NET
 subnet 10.1.1.0 255.255.255.0
object network APP
 host 10.1.2.10
access-list INSIDE extended permit tcp object WEB-NET object APP eq 8443
access-list INSIDE extended permit tcp any any eq ssh
access-group INSIDE in interface inside
`;

  it('recognises each format from its content', () => {
    expect(guessParser('a.txt', ASA)).toBe('cisco_asa');
    expect(guessParser('p.txt', 'set address WEB ip-netmask 10.1.1.0/24\nset rulebase security rules r1 action allow\n')).toBe('panos');
    expect(guessParser('f.conf', 'config firewall address\n    edit "WEB"\n        set subnet 10.1.1.0 255.255.255.0\n    next\nend\nconfig firewall service custom\n    edit "tcp-8443"\n        set tcp-portrange 8443\n')).toBe('fortios');
    expect(guessParser('bigip.conf', 'ltm virtual /Common/vs_web {\n}\n')).toBe('f5');
    expect(guessParser('as3.json', '{"class": "AS3", "declaration": {}}')).toBe('f5');
    expect(guessParser('r.csv', 'name,src,dst,service,action\n')).toBe('csv');
    expect(guessParser('v.csv', 'vip,port,protocol,members,monitor\n')).toBe('vips-csv');
    expect(guessParser('x.txt', 'hello')).toBeNull();
  });

  it('marks generated rules config, flows or both, and lists any-any for review', () => {
    const p = plan();
    const parsed = parseDeviceConfig('cisco_asa', ASA, 'edge-asa');
    expect(parsed).not.toBeNull();
    const flows = [
      { sourceIp: '10.1.1.10', destIp: '10.1.2.10', destPort: 8443, protocol: 'tcp', observations: 10, lastSeen: '2026-09-20' },
      { sourceIp: '10.1.2.10', destIp: '10.1.1.10', destPort: 5432, protocol: 'tcp', observations: 3, lastSeen: '2026-09-20' },
    ];
    const t = translateConfigs([parsed!], netsecContext(p), { flows, today: '2026-09-26' });
    const sum = translationSummary(t);
    expect(sum.origin.both).toBeGreaterThan(0);
    expect(sum.origin.flows).toBeGreaterThan(0);
    expect(sum.origin.config).toBeGreaterThan(0);
    expect(sum.review).toBe(1);
    const review = t.rules.find((r) => r.scope === 'review');
    expect(ruleCells(review!)[1]).toBe('Review');
    const web = t.rules.find((r) => r.origin === 'both');
    expect(ruleCells(web!)[3]).toBe('shop/web');
    expect(ruleCells(web!)[7]).toBe('both');
  });
});
