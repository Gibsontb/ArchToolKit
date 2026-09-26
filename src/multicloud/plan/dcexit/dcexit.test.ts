import { describe, it } from 'node:test';
import { expect } from '../../../testing/expect.ts';
import { classifyType } from '../../../terraform/catalog.ts';
import { resourceSchema } from '../../../terraform/schema-blueprints.ts';
import type { HclBlock } from '../../../terraform/hcl.ts';
import type { CloudTarget } from '../../../terraform/providers.ts';
import { readYaml } from '../../../core/yaml-read.ts';
import { checkTaskArgs } from '../../../ansible/args-check.ts';
import { classifyModule } from '../../../ansible/catalog.ts';
import { NETWORK_BLUEPRINTS } from '../../../network/blueprints/index.ts';
import type { DcExit, InfraItem, Workload } from '../types.ts';
import { assetRegisterCsv, canDispose, checkAssets, contractTasks, terminateBy } from './contracts.ts';
import { ARCHIVE_TIERS, allowedArchiveDisposition, checkArchives, retentionRegister } from './archive.ts';
import { cronOptions, jobsPlaybook, planJobs, taskTrigger } from './jobs.ts';
import { applyReIp, dnsBlocks, parseDnsCsv, parseInfoblox, parseZoneFile, type DnsZone } from './dns-import.ts';
import {
  BGP_BLUEPRINTS,
  STATIC_BLUEPRINTS,
  exitSequence,
  exitSequenceMarkdown,
  exitWaves,
  handoffOpening,
  lightsOut,
  lightsOutMarkdown,
  networkHandoff,
  subnetDecisions,
  type ExitInput,
} from './sequence.ts';

/* ------------------------------------------------------------------ fixtures --- */

const infra = (id: string, category: InfraItem['category'], name: string, facts: Record<string, string>, extra: Partial<InfraItem> = {}): InfraItem => ({
  id,
  category,
  name,
  disposition: 'retire',
  facts,
  ...extra,
});

const wl = (id: string, app: string, ip: string): Workload =>
  ({ id, name: id, app, env: 'prod', role: 'app', facts: { ipAddresses: [ip] } }) as unknown as Workload;

const WORKLOADS = [wl('shop-web', 'shop', '10.1.1.10'), wl('shop-app', 'shop', '10.1.2.10'), wl('crm-app', 'crm', '10.1.4.10'), wl('hr-app', 'hr', '10.2.5.10')];
const WAVE_OF = new Map([
  ['shop-web', 1],
  ['shop-app', 1],
  ['crm-app', 3],
  ['hr-app', 2],
]);
const WAVE_ENDS = new Map([
  [1, '2026-10-10'],
  [2, '2026-10-24'],
  [3, '2026-11-07'],
]);

function dc(over: Partial<DcExit> = {}): DcExit {
  return {
    exitDate: '2026-12-31',
    dualRunningDays: 14,
    hardwareRemovalDays: 30,
    infra: [
      infra('s1', 'subnet', 'web', { cidr: '10.1.1.0/24', vlan: '101', strategy: 're-ip' }, { site: 'dc1' }),
      infra('s2', 'subnet', 'crm', { cidr: '10.1.4.0/24', vlan: '104' }, { site: 'dc1' }),
      infra('s3', 'subnet', 'hr', { cidr: '10.2.5.0/24', vlan: '205', strategy: 'keep-ip-l2-extension' }, { site: 'dc2' }),
      infra('s4', 'subnet', 'app', { cidr: '10.1.2.0/24', vlan: '102', strategy: 'keep-ip-cloud', apps: 'crm' }, { site: 'dc1' }),
      infra('c-inet', 'circuit', 'inet-dc2', { kind: 'internet', provider: 'ISP A', sites: 'dc2' }),
      infra('c-mpls', 'circuit', 'mpls', { kind: 'mpls', provider: 'Carrier', sites: 'dc1 dc2', contractEnd: '2027-06-30', noticeDays: '60' }),
      infra('c-p2p', 'circuit', 'p2p-dc1', { kind: 'p2p', sites: 'dc1', device: 'edge-rtr', neighbor: '192.0.2.1', remoteAs: '64500', localAs: '65001', prefixes: '10.9.0.0/16 2001:db8:9::/48', nextHop: '192.0.2.1' }, { afterWave: 1 }),
      infra('d1', 'network-device', 'edge-rtr', { kind: 'router', platform: 'cisco_ios' }, { site: 'dc1' }),
      infra('d2', 'network-device', 'fw1', { kind: 'firewall', platform: 'fortios' }, { site: 'dc1' }),
      infra('n1', 'net-service', 'dns1', { kind: 'dns' }),
      infra('st1', 'storage-array', 'array1', { kind: 'san', apps: 'shop' }, { site: 'dc1' }),
      infra('a1', 'archive', 'tapes-2019', { media: 'tape', retentionUntil: '2031-01-01', legalHold: 'yes' }, { site: 'dc1' }),
      infra('a2', 'archive', 'tapes-2022', { media: 'tape', retentionUntil: '2030-01-01', legalHold: 'no', obligation: 'keep-until-expiry' }, { disposition: 'migrate', site: 'dc1' }),
    ],
    external: [{ id: 'bank', kind: 'partner-allowlist', party: 'Bank', direction: 'out', protocol: 'sftp', endpoint: 'sftp.bank.example', currentIps: ['10.1.1.10'], noticeDays: 30 }],
    contracts: [
      { id: 'k1', kind: 'colocation', vendor: 'Colo Ltd', ends: '2027-03-31', noticeDays: 90 },
      { id: 'k2', kind: 'support', vendor: 'Vendor', ends: '2026-06-30', noticeDays: 30 },
    ],
    assets: [
      { id: 'as1', kind: 'server', serial: 'SN1', containsData: true, sanitisation: 'purge', certificateId: 'CERT-1', disposedOn: '2027-01-10', registerUpdated: true },
      { id: 'as2', kind: 'disk shelf', containsData: true, disposedOn: '2027-01-10' },
      { id: 'as3', kind: 'switch', containsData: false },
    ],
    ...over,
  };
}

const input = (d: DcExit = dc()): ExitInput => ({
  dcExit: d,
  workloads: WORKLOADS,
  waveOf: WAVE_OF,
  waveEnds: WAVE_ENDS,
  targetOf: (id) => (id === 'hr-app' ? 'aws' : 'vmware'),
  today: '2026-09-26',
});

function schemaProblems(block: HclBlock): string[] {
  const type = block.labels?.[0] as string;
  const schema = resourceSchema(type) as { a: [string, string, string][]; b?: [string, unknown, number, number, unknown][] } | undefined;
  if (!schema) return [`${type}: no schema`];
  const out: string[] = [];
  const walk = (b: HclBlock, s: { a: [string, string, string][]; b?: [string, unknown, number, number, unknown][] }, path: string): void => {
    const attrs = new Set(s.a.map((a) => a[0]));
    const blocks = new Map((s.b ?? []).map((x) => [x[0], x]));
    for (const a of b.attributes ?? []) if (!attrs.has(a.name)) out.push(`${path}.${a.name}: not in the schema`);
    for (const a of s.a) if (a[2].startsWith('r') && !(b.attributes ?? []).some((x) => x.name === a[0])) out.push(`${path}.${a[0]}: required and missing`);
    for (const c of b.blocks ?? []) {
      const def = blocks.get(c.type);
      if (!def) out.push(`${path}.${c.type}: block not in the schema`);
      else walk(c, def[4] as never, `${path}.${c.type}`);
    }
  };
  walk(block, schema, type);
  return out;
}
const target = (type: string): CloudTarget => (type.startsWith('azurerm_') ? 'azure' : (type.split('_')[0] as CloudTarget));

/* --------------------------------------------------------------------- tests --- */

describe('contracts and assets', () => {
  it('terminate by = min(ends, exit date) − notice days', () => {
    expect(terminateBy('2027-03-31', 90, '2026-12-31')).toBe('2026-10-02');
    expect(terminateBy('2027-03-31', 90)).toBe('2026-12-31');
    expect(terminateBy('2026-06-30', 30, '2026-12-31')).toBe('2026-05-31');
    expect(terminateBy('2028-02-29', 0, '2030-01-01')).toBe('2028-02-29');
    expect(terminateBy('soon', 10)).toBeNull();
  });

  it('dates every contract and circuit, and errors when the date has passed', () => {
    const { tasks, findings } = contractTasks(dc(), '2026-09-26');
    expect(tasks.map((t) => [t.id, t.terminateBy])).toEqual([
      ['k2', '2026-05-31'],
      ['k1', '2026-10-02'],
      ['c-mpls', '2026-11-01'],
    ]);
    expect(tasks.find((t) => t.id === 'k2')?.overdue).toBe(true);
    expect(findings.filter((f) => f.code === 'dc.terminate-by-past').map((f) => f.path)).toEqual(['contracts.k2']);
    expect(contractTasks(dc(), '2026-09-26', { k2: 'terminated' }).findings.some((f) => f.code === 'dc.terminate-by-past')).toBe(false);
  });

  it('an asset holding data needs a NIST SP 800-88 method and a certificate before disposal', () => {
    const findings = checkAssets(dc().assets);
    expect(findings.filter((f) => f.code === 'dc.sanitise').map((f) => f.path)).toEqual(['assets.as2']);
    expect(canDispose(dc().assets[0]!)).toBe(true);
    expect(canDispose(dc().assets[1]!)).toBe(false);
    expect(assetRegisterCsv(dc().assets).split('\n')[1]).toBe('as1,server,SN1,,yes,purge,CERT-1,2027-01-10,yes');
  });
});

describe('archives', () => {
  it('a legal-hold archive cannot be retired', () => {
    const findings = checkArchives(dc().infra, '2026-09-26');
    expect(findings.some((f) => f.code === 'dc.legal-hold' && f.severity === 'error' && f.path === 'infra.a1')).toBe(true);
    const a1 = dc().infra.find((i) => i.id === 'a1') as InfraItem;
    expect(allowedArchiveDisposition(a1, 'retire')).toBe(false);
    expect(allowedArchiveDisposition(a1, 'migrate')).toBe(true);
  });
  it('builds the retention register', () => {
    const rows = retentionRegister(dc().infra, '2026-09-26');
    expect(rows.map((r) => [r.id, r.legalHold, r.obligation ?? null])).toEqual([
      ['a1', true, null],
      ['a2', false, 'keep-until-expiry'],
    ]);
  });
  it('names archive tiers whose Terraform types are in the catalogue', () => {
    for (const [p, tier] of Object.entries(ARCHIVE_TIERS)) {
      if ('none' in tier) continue;
      expect(`${p} ${classifyType(target(tier.terraform), tier.terraform)}`).toBe(`${p} resource`);
    }
  });
});

describe('jobs', () => {
  const items: InfraItem[] = [
    infra('j1', 'job', 'nightly-export', { scheduler: 'cron', host: 'shop-app', schedule: '30 2 * * *', command: '/opt/shop/export.sh', runsAs: 'shop' }),
    infra('j2', 'job', 'weekly-report', { scheduler: 'task-scheduler', host: 'rpt-01', schedule: '0 6 * * 1,5', command: '"C:\\Reports\\run.exe" --weekly', runsAs: 'CORP\\svc-report' }),
    infra('j3', 'job', 'cleanup', { scheduler: 'task-scheduler', host: 'rpt-01', schedule: '0 1 * * *', command: 'C:\\Tools\\cleanup.cmd', runsAs: 'SYSTEM' }),
    infra('j4', 'job', 'db-maint', { scheduler: 'sql-agent', host: 'sql-01', dbTarget: 'paas' }),
    infra('j5', 'job', 'batch', { scheduler: 'control-m', host: 'batch-01' }),
    infra('j6', 'job', 'stop-dev', { scheduler: 'cron', host: 'ops', target: 'oci-resource-scheduler' }),
  ];
  const plan = planJobs(items);

  it('picks the mechanism per scheduler and target', () => {
    expect(plan.jobs.map((j) => j.mechanism)).toEqual([
      'ansible.builtin.cron',
      'community.windows.win_scheduled_task',
      'community.windows.win_scheduled_task',
      'runbook',
      'runbook',
      'oci_resource_scheduler_schedule',
    ]);
    expect(plan.findings.some((f) => f.code === 'dc.job-sql-agent')).toBe(true);
    expect(classifyType('oci', 'oci_resource_scheduler_schedule')).toBe('resource');
    expect(classifyType('aws', 'aws_scheduler_schedule')).toBe('resource');
    expect(classifyType('google', 'google_cloud_scheduler_job')).toBe('resource');
  });

  it('reads cron schedules into cron options and Task Scheduler triggers', () => {
    expect(cronOptions('30 2 * * *')).toEqual({ minute: '30', hour: '2', day: '*', month: '*', weekday: '*' });
    expect(cronOptions('@daily')).toEqual({ special_time: 'daily' });
    expect(taskTrigger('0 6 * * 1,5')).toEqual({ type: 'weekly', start_boundary: '2000-01-01T06:00:00', days_of_week: 'monday,friday' });
    expect(taskTrigger('*/5 * * * *')).toBeNull();
  });

  it('writes a playbook whose every task passes the module schemas, with the password in the vault', () => {
    const out = jobsPlaybook(plan.jobs);
    expect(out.vaultVars).toEqual(['vault_job_j2_password']);
    const doc = readYaml(out.text).documents[0] as { hosts: string; tasks: Record<string, unknown>[] }[];
    expect(doc.map((p) => p.hosts)).toEqual(['rpt-01', 'shop-app']);
    for (const play of doc) {
      for (const task of play.tasks) {
        const module = Object.keys(task).find((k) => k.includes('.')) as string;
        expect(classifyModule(module) === 'unknown').toBe(false);
        expect(checkTaskArgs(module, task[module] as never)).toEqual([]);
      }
    }
    const secretTask = doc[0]?.tasks[0] as Record<string, unknown>;
    expect(secretTask.no_log).toBe(true);
    expect(out.text).not.toContain('Generated by');
  });
});

describe('DNS import', () => {
  const INFOBLOX = JSON.stringify({
    zone_auth: [{ _ref: 'zone_auth/x:corp.example/default', fqdn: 'corp.example', view: 'default' }],
    'record:a': [
      { name: 'shop.corp.example', ipv4addr: '10.1.1.10', zone: 'corp.example', ttl: 300 },
      { name: 'shop.corp.example', ipv4addr: '10.1.1.11', zone: 'corp.example', ttl: 300 },
    ],
    'record:aaaa': [{ name: 'shop.corp.example', ipv6addr: '2001:db8:1:1::10', zone: 'corp.example', ttl: 300 }],
    'record:cname': [{ name: 'www.corp.example', canonical: 'shop.corp.example', zone: 'corp.example', ttl: 300 }],
  });
  const ZONE = `$ORIGIN corp.example.
$TTL 3600
@   IN SOA ns1.corp.example. hostmaster.corp.example. (
        2026092601 ; serial
        3600 600 86400 300 )
@        IN NS   ns1
shop 300 IN A    10.1.1.10
         300 IN A 10.1.1.11
shop 300 IN AAAA 2001:db8:1:1::10
www  300 IN CNAME shop
mail     IN MX   10 mx1
`;
  const CSV = `HostName,RecordType,TimeToLive,RecordData
shop,A,00:05:00,10.1.1.10
shop,A,00:05:00,10.1.1.11
shop,AAAA,00:05:00,2001:db8:1:1::10
www,CNAME,00:05:00,shop.corp.example.
@,NS,01:00:00,ns1.corp.example.
`;
  const expected = [
    { name: 'shop', type: 'A', ttl: 300, values: ['10.1.1.10', '10.1.1.11'] },
    { name: 'shop', type: 'AAAA', ttl: 300, values: ['2001:db8:1:1::10'] },
    { name: 'www', type: 'CNAME', ttl: 300, values: ['shop.corp.example'] },
  ];

  it('Infoblox WAPI, a zone file and a Get-DnsServerResourceRecord CSV give the same records', () => {
    expect(parseInfoblox(INFOBLOX).zones[0]?.records).toEqual(expected);
    const zf = parseZoneFile(ZONE, 'corp.example');
    expect(zf.zones[0]?.records).toEqual(expected);
    expect(zf.findings.some((f) => f.code === 'dc.dns-skipped')).toBe(true);
    expect(parseDnsCsv(CSV, 'corp.example').zones[0]?.records).toEqual(expected);
  });

  it('rewrites addresses through a re-IP map, per family', () => {
    const zones = parseInfoblox(INFOBLOX).zones;
    const out = applyReIp(zones, new Map([['10.1.1.10', '10.100.1.10'], ['2001:db8:1:1::10', '2001:db8:100::10']]));
    expect(out.changed).toBe(2);
    expect(out.zones[0]?.records[0]?.values).toEqual(['10.100.1.10', '10.1.1.11']);
  });

  it('writes private zones whose types are catalogued and whose blocks match the schema', () => {
    const zones: DnsZone[] = parseInfoblox(INFOBLOX).zones as DnsZone[];
    for (const p of ['aws', 'azure', 'google', 'oci'] as const) {
      const { blocks } = dnsBlocks(zones, p);
      const resources = blocks.filter((b) => b.type === 'resource');
      expect(resources.length).toBeGreaterThan(3);
      for (const b of resources) {
        const type = b.labels?.[0] as string;
        expect(`${type} ${classifyType(target(type), type)}`).toBe(`${type} resource`);
      }
      expect(resources.flatMap(schemaProblems)).toEqual([]);
    }
    expect(dnsBlocks(zones, 'vmware').findings[0]?.code).toBe('dc.dns-vmware');
  });
});

describe('exit sequence', () => {
  const seq = exitSequence(input());
  const stepOf = (item: string) => seq.waves.flatMap((w) => w.steps).find((s) => s.item === item);
  const decisions = subnetDecisions(input()).subnets;

  it('exit waves follow the last app wave that uses each subnet or circuit', () => {
    expect(seq.waves.map((w) => [w.label, w.afterWave])).toEqual([
      ['E1', 1],
      ['E2', 2],
      ['E3', 3],
    ]);
    for (const s of decisions) expect((stepOf(s.id)?.afterWave ?? -1) >= s.lastWave).toBe(true);
    expect(stepOf('s1')?.exitWave).toBe('E1');
    expect(stepOf('s3')?.exitWave).toBe('E2');
    expect(stepOf('s4')?.afterWave).toBe(3);
    expect(stepOf('c-inet')?.afterWave).toBe(2);
    // p2p-dc1 was set to go after wave 1, but crm (wave 3) still uses dc1.
    expect(stepOf('c-p2p')?.afterWave).toBe(3);
    expect(seq.findings.some((f) => f.code === 'dc.cut-too-early' && f.path === 'infra.c-p2p')).toBe(true);
    expect(stepOf('c-mpls')?.afterWave).toBe(3);
  });

  it('dates exit waves at the app wave end plus dual running, and cuts the MPLS last', () => {
    expect(seq.waves.map((w) => w.date)).toEqual(['2026-10-24', '2026-11-07', '2026-11-21']);
    const e3 = seq.waves[2]!.steps.map((s) => s.kind);
    expect(e3.indexOf('firewall-rules')).toBeLessThan(e3.indexOf('firewall'));
    expect(e3.indexOf('firewall')).toBeLessThan(e3.indexOf('circuit'));
    const circuits = seq.waves[2]!.steps.filter((s) => s.kind === 'circuit').map((s) => s.item);
    expect(circuits).toEqual(['c-p2p', 'c-mpls']);
    expect(e3[e3.length - 1]).toBe('contract');
    expect(stepOf('k1')?.date).toBe('2026-10-02');
  });

  it('checks the IP strategy per subnet', () => {
    expect(seq.findings.some((f) => f.code === 'ip.l2-needs-vmware' && f.path === 'infra.s3')).toBe(true);
    expect(seq.findings.some((f) => f.code === 'ip.keep-ip-spans-waves' && f.path === 'infra.s4')).toBe(true);
    expect(decisions.find((s) => s.id === 's1')?.notices).toEqual(['bank']);
    expect(stepOf('s3')?.title).toContain('Unextend');
  });

  it('prefills the circuit-cut rollback for the device platform, for network.html', () => {
    const payload = networkHandoff(seq, 'plan-1');
    expect(payload.changes.map((c) => c.blueprint)).toEqual(['ios_bgp_peer', 'ios_static_route', 'ios_static_route']);
    const bgp = payload.changes[0]!;
    expect(bgp.values).toEqual({ local_as: 65001, neighbor: '192.0.2.1', remote_as: 64500, peer_description: 'p2p-dc1' });
    expect(payload.changes[2]?.values.prefix).toBe('2001:db8:9::/48');
    const opening = handoffOpening(bgp, NETWORK_BLUEPRINTS);
    expect(opening?.platform).toBe('cisco_ios');
    expect(opening?.dropped).toEqual([]);
    expect(handoffOpening({ ...bgp, blueprint: 'nope' }, NETWORK_BLUEPRINTS)).toBeNull();
  });

  it('every BGP and static-route mapping names a real blueprint and only its inputs', () => {
    const facts = { localAs: '65001', neighbor: '192.0.2.1', remoteAs: '64500', routerId: '10.255.0.1', nextHop: '192.0.2.1', interface: 'outside' };
    const check = (platform: string, blueprint: string, values: Record<string, unknown>): void => {
      const group = NETWORK_BLUEPRINTS.find((g) => g.target === platform);
      const bp = group?.blueprints.find((b) => b.id === blueprint);
      expect(`${platform}/${blueprint} ${bp ? 'found' : 'missing'}`).toBe(`${platform}/${blueprint} found`);
      const inputs = new Set(bp?.inputs.map((i) => i.id));
      expect(Object.keys(values).filter((k) => !inputs.has(k))).toEqual([]);
    };
    for (const [p, m] of Object.entries(BGP_BLUEPRINTS)) check(p, m.blueprint, m.values(facts, 'circuit-1', 'dev-1'));
    for (const [p, m] of Object.entries(STATIC_BLUEPRINTS)) check(p, m.blueprint, m.values(['10.9.0.0/16', '10.8.0.0/16'], facts, 'circuit-1', 'dev-1'));
  });

  it('gives exit waves as Wave records of kind exit, with G5 on the last, and the markdown', () => {
    const waves = exitWaves(seq);
    expect(waves.every((w) => w.kind === 'exit')).toBe(true);
    expect(waves.map((w) => w.n)).toEqual([4, 5, 6]);
    expect(waves[2]?.gates).toEqual(['G5']);
    const md = exitSequenceMarkdown(seq);
    expect(md).toContain('## E1: after app wave 1 (2026-10-24)');
    expect(md).toContain('Rollback:');
    expect(md).toContain('ios_bgp_peer');
  });

  it('warns when an exit wave falls after the exit date', () => {
    const late = exitSequence(input(dc({ exitDate: '2026-11-01' })));
    expect(late.findings.filter((f) => f.code === 'dc.after-exit-date').length).toBeGreaterThan(0);
  });
});

describe('lights-out', () => {
  it('is computed from every grid, and met when everything is done', () => {
    const open = lightsOut(dc(), { today: '2026-09-26' });
    expect(open.map((c) => c.id)).toEqual(['lo.dispositions', 'lo.powered-off', 'lo.circuits', 'lo.contracts', 'lo.sanitised', 'lo.archives', 'lo.register', 'lo.evidence']);
    expect(open.every((c) => !c.met)).toBe(true);

    const d = dc();
    const finished: DcExit = {
      ...d,
      infra: d.infra.map((i) => (i.id === 'a1' ? { ...i, disposition: 'migrate', facts: { ...i.facts, obligation: 'migrate-to-archive-tier', done: 'yes' } } : { ...i, facts: { ...i.facts, done: 'yes' } })),
      assets: d.assets.map((a) => ({ ...a, sanitisation: a.sanitisation ?? 'destroy', certificateId: a.certificateId ?? `CERT-${a.id}`, disposedOn: '2027-01-10', registerUpdated: true })),
    };
    const closed = lightsOut(finished, { today: '2026-09-26', poweredOnSources: [], contractStatus: { k1: 'terminated', k2: 'terminated', 'c-mpls': 'terminated' }, cmdbUpdated: true, evidenceComplete: true });
    expect(closed.filter((c) => !c.met).map((c) => c.id)).toEqual([]);
    expect(lightsOutMarkdown(closed)).toContain('- [x] Every circuit is cut');
  });
});


