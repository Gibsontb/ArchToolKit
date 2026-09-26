import { describe, it } from 'node:test';
import { expect } from '../../../testing/expect.ts';
import { readYaml } from '../../../core/yaml-read.ts';
import { emptyPlan } from '../store.ts';
import { itemId } from '../options.ts';
import type { Plan, Workload } from '../types.ts';
import {
  acceptEdges, aggregateFlows, canonicalIp, FLOWS_CSV_HEADER, flowsCsv, headerSetKey, importFlows, mapFlowHeaders, normaliseProtocol, portClass,
  proposeEdges, reviewRows,
} from './flows.ts';
import { detectCaptureFormat, discoverConnectionsFiles, parseCaptureOutput, splitEndpoint } from './capture.ts';
import { flowQuery, networksFlowsFiles, parseNetworksEntities, planAddresses } from './networks-flows.ts';

function server(name: string, app: string, ips: readonly string[], extra: Partial<Workload> = {}): Workload {
  return {
    id: itemId('workload', name), name, app, env: 'prod', role: 'app', os: 'rhel-9', vcpu: 4, ramGib: 16, disksGib: [100],
    criticality: 'tier2', rpo: '1h', rto: '4h', licence: 'li', dependsOn: [], source: 'manual',
    facts: { ipAddresses: ips }, ...extra,
  };
}

function fixture(): Plan {
  const base = emptyPlan('Flows test', '2026-09-26T10:00:00.000Z');
  return {
    ...base,
    workloads: [
      server('web-01', 'shop', ['10.0.1.10', '2001:db8:0:1::10']),
      server('app-01', 'shop', ['10.0.2.20']),
      server('db-01', 'shop', ['10.0.3.30'], { role: 'db' }),
      server('mail-01', 'mail', ['10.0.4.40']),
    ],
    requirements: { ...base.requirements, sites: [{ name: 'hq', cidrs: ['192.168.0.0/16'], bandwidth: '1g', circuit: 'none' }] },
  };
}

describe('flows import: header variants', () => {
  it('reads the canonical flows.csv', () => {
    const r = importFlows(`${FLOWS_CSV_HEADER}\n10.0.2.20,10.0.3.30,1433,tcp,12,2026-09-01T00:00:00Z,2026-09-07T00:00:00Z,5000,java,\n`);
    expect(r.missing).toEqual([]);
    expect(r.flows).toEqual([{ sourceIp: '10.0.2.20', destIp: '10.0.3.30', destPort: 1433, protocol: 'tcp', observations: 12, firstSeen: '2026-09-01T00:00:00Z', lastSeen: '2026-09-07T00:00:00Z', bytes: 5000, process: 'java' }]);
  });

  it('maps nfdump -o csv (sa, da, sp, dp, pr, ibyt) and turns replies round', () => {
    const csv = [
      'ts,te,td,sa,da,sp,dp,pr,flg,fwd,stos,ipkt,ibyt',
      '2026-09-01 10:00:00,2026-09-01 10:00:05,5.0,10.0.2.20,10.0.3.30,51514,1433,TCP,.AP.SF,0,0,10,1200',
      '2026-09-01 10:00:00,2026-09-01 10:00:05,5.0,10.0.3.30,10.0.2.20,1433,51514,TCP,.AP.SF,0,0,8,64000',
      'Summary',
      'flows,bytes,packets,avg_bps,avg_pps,avg_bpp',
      '2,65200,18,0,0,0',
    ].join('\n');
    const r = importFlows(csv);
    expect(r.mapping.sourceIp).toBe('sa');
    expect(r.mapping.destPort).toBe('dp');
    expect(r.mapping.bytes).toBe('ibyt');
    expect(r.flows).toHaveLength(1);
    expect(r.flows[0]).toEqual({ sourceIp: '10.0.2.20', destIp: '10.0.3.30', destPort: 1433, protocol: 'tcp', observations: 2, firstSeen: '2026-09-01T10:00:00', lastSeen: '2026-09-01T10:00:05', bytes: 65200 });
    expect(r.findings.map((f) => f.code)).toContain('flows.replies-flipped');
  });

  it('maps a SIEM export with spelled-out headers', () => {
    const csv = 'Source IP,Destination IP,Destination Port,Protocol,Flow Count,Bytes\n10.0.1.10,10.0.2.20,8443,6,4,900\n';
    const r = importFlows(csv);
    expect(r.missing).toEqual([]);
    expect(r.flows[0]).toEqual({ sourceIp: '10.0.1.10', destIp: '10.0.2.20', destPort: 8443, protocol: 'tcp', observations: 4, bytes: 900 });
  });

  it('maps AWS VPC flow logs (srcaddr, dstaddr, dstport, numeric protocol, epoch times)', () => {
    const csv = 'version,account-id,interface-id,srcaddr,dstaddr,srcport,dstport,protocol,packets,bytes,start,end,action,log-status\n'
      + '2,123456789012,eni-1,10.0.2.20,10.0.3.30,40000,1433,6,5,700,1788000000,1788000060,ACCEPT,OK\n';
    const r = importFlows(csv);
    expect(r.mapping.sourceIp).toBe('srcaddr');
    expect(r.flows[0]?.firstSeen).toBe(new Date(1788000000 * 1000).toISOString().replace('.000Z', 'Z'));
    expect(r.flows[0]?.protocol).toBe('tcp');
  });

  it('asks for a mapping when a required column is missing, and uses a remembered one', () => {
    const csv = 'client,server,svc\n10.0.2.20,10.0.3.30,1433\n';
    const first = importFlows(csv);
    expect(first.missing).toEqual(['sourceIp', 'destIp', 'destPort']);
    expect(first.flows).toHaveLength(0);
    expect(first.findings[0]?.code).toBe('flows.mapping-needed');
    const second = importFlows(csv, { mapping: { sourceIp: 'client', destIp: 'server', destPort: 'svc' } });
    expect(second.flows).toHaveLength(1);
    expect(headerSetKey(['Client', 'SERVER', 'svc'])).toBe(headerSetKey(['svc', 'client', 'server']));
    expect(mapFlowHeaders(['client', 'server', 'svc'], { sourceIp: 'client' }).missing).toEqual(['destIp', 'destPort']);
  });

  it('drops the repeated headers of concatenated per-host files', () => {
    const one = `${FLOWS_CSV_HEADER}\n10.0.2.20,10.0.3.30,1433,tcp,3,,,,java,\n`;
    const r = importFlows(one + one);
    expect(r.flows).toHaveLength(1);
    expect(r.flows[0]?.observations).toBe(6);
  });

  it('normalises addresses and protocols', () => {
    expect(canonicalIp('[2001:DB8:0:1:0:0:0:10]')).toBe('2001:db8:0:1::10');
    expect(canonicalIp('::ffff:10.0.0.5')).toBe('10.0.0.5');
    expect(canonicalIp('fe80::1%eth0')).toBe('fe80::1');
    expect(canonicalIp('not-an-ip')).toBe('');
    expect(normaliseProtocol('17')).toBe('udp');
    expect(normaliseProtocol('IPv6-ICMP')).toBe('icmp');
  });
});

describe('flows: proposal, review and accept', () => {
  const flows = aggregateFlows([
    { sourceIp: '10.0.2.20', destIp: '10.0.3.30', destPort: 1433, protocol: 'tcp', observations: 10, process: 'java' },
    { sourceIp: '2001:db8:0:1:0:0:0:10', destIp: '10.0.2.20', destPort: 8443, protocol: 'tcp', observations: 5 },
    { sourceIp: '10.0.2.20', destIp: '10.0.4.40', destPort: 25, protocol: 'tcp', observations: 2 },
    { sourceIp: '192.168.5.5', destIp: '10.0.1.10', destPort: 443, protocol: 'tcp', observations: 50 },
    { sourceIp: '10.0.2.20', destIp: '203.0.113.9', destPort: 443, protocol: 'tcp', observations: 3, destName: 'api.partner.example' },
    { sourceIp: '198.51.100.1', destIp: '198.51.100.2', destPort: 80, protocol: 'tcp', observations: 1 },
  ]);
  const plan = fixture();
  const proposed = proposeEdges(flows, plan);

  it('matches servers by either address family, sites by CIDR, and groups the rest as external', () => {
    const pairs = proposed.edges.map((e) => `${e.from}->${e.to}:${e.port}`);
    expect(pairs).toContain('app-01->db-01:1433');
    expect(pairs).toContain('web-01->app-01:8443');
    expect(pairs).toContain('site:hq->web-01:443');
    expect(pairs).toContain('app-01->external:203.0.113.9:443');
    expect(pairs.some((p) => p.includes('198.51.100'))).toBe(false);
    expect(proposed.external.map((x) => x.ip)).toEqual(['203.0.113.9']);
    expect(proposed.external[0]?.name).toBe('api.partner.example');
  });

  it('proposes the kind by port class and accepts nothing on its own', () => {
    const kind = (to: string, port: number) => proposed.edges.find((e) => e.to === to && e.port === port)?.proposedKind;
    expect(kind('db-01', 1433)).toBe('sync');
    expect(kind('mail-01', 25)).toBe('async');
    expect(portClass(6379).cls).toBe('cache');
    expect(portClass(389).kind).toBe('sync');
    expect(portClass(88).cls).toBe('kerberos');
    expect(proposed.edges.every((e) => e.accept === false)).toBe(true);
    expect(reviewRows(proposed.edges)[0]).toHaveLength(8);
  });

  it('writes only the accepted edges, and fills Depends on', () => {
    const accepted = proposed.edges.filter((e) => e.to === 'db-01' || e.from === 'site:hq' || e.toKind === 'external');
    const next = acceptEdges(plan, accepted);
    expect(next.edges).toEqual([{ from: 'app-01', to: 'db-01', kind: 'sync' }]);
    expect(next.workloads.find((w) => w.name === 'app-01')?.dependsOn).toEqual(['db-01']);
    expect(next.workloads.find((w) => w.name === 'app-01')?.edited).toContain('dependsOn');
    expect(next.workloads.find((w) => w.name === 'web-01')?.dependsOn).toEqual([]);
    expect(acceptEdges(plan, [])).toBe(plan);
  });

  it('writes flows.csv that reads back the same', () => {
    const back = importFlows(flowsCsv(flows)).flows;
    expect(back).toEqual(flows);
  });
});

describe('guest capture', () => {
  it('generates the playbook and scripts: ss / netstat / Get-NetTCPConnection, every 10 minutes for 7 days', () => {
    const files = discoverConnectionsFiles();
    const yml = files['discovery/discover-connections.yml'] ?? '';
    const doc = readYaml(yml).documents[0] as { vars?: Record<string, unknown> }[];
    expect(Array.isArray(doc)).toBe(true);
    expect(doc[0]?.vars).toEqual({ discovery_action: 'start', discovery_days: 7, discovery_interval_minutes: 10 });
    expect(yml).toContain('ansible.builtin.cron');
    expect(yml).toContain('community.windows.win_scheduled_task');
    expect(files['discovery/files/capture-linux.sh']).toContain('ss -Htnp state established');
    expect(files['discovery/files/capture-linux.sh']).toContain('netstat -tnp');
    expect(files['discovery/files/capture-windows.ps1']).toContain('Get-NetTCPConnection -State Established');
    expect(files['discovery/files/aggregate-linux.sh']).toContain(FLOWS_CSV_HEADER);
    expect(/--dry-run|password/i.test(Object.values(files).join('\n'))).toBe(false);
  });

  it('parses raw ss output, using the listening ports when given', () => {
    const ss = [
      '0      0      10.0.2.20:51514     10.0.3.30:1433   users:(("java",pid=812,fd=41))',
      '0      0      [::ffff:10.0.2.20]:8443  [::ffff:10.0.1.10]:40022 users:(("java",pid=812,fd=50))',
      '0      0      127.0.0.1:5432      127.0.0.1:41000  users:(("postgres",pid=1,fd=1))',
    ].join('\n');
    expect(detectCaptureFormat(ss)).toBe('ss');
    const flows = parseCaptureOutput(ss, { listening: [8443] });
    expect(flows.map((f) => `${f.sourceIp}>${f.destIp}:${f.destPort}:${f.process}`)).toEqual([
      '10.0.1.10>10.0.2.20:8443:java',
      '10.0.2.20>10.0.3.30:1433:java',
    ]);
  });

  it('parses netstat, Get-NetTCPConnection CSV and the samples file', () => {
    const netstat = 'Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name\n'
      + 'tcp        0      0 10.0.2.20:51514         10.0.3.30:1433          ESTABLISHED 812/java\n'
      + 'tcp        0      0 10.0.2.20:22            192.168.5.5:60000       ESTABLISHED 99/sshd\n';
    expect(detectCaptureFormat(netstat)).toBe('netstat');
    expect(parseCaptureOutput(netstat).map((f) => `${f.sourceIp}>${f.destIp}:${f.destPort}`)).toEqual(['10.0.2.20>10.0.3.30:1433', '192.168.5.5>10.0.2.20:22']);
    const ps = '#TYPE Microsoft.Management.Infrastructure.CimInstance\n"LocalAddress","LocalPort","RemoteAddress","RemotePort","State","OwningProcess"\n'
      + '"10.0.4.40","49700","10.0.3.30","1433","Established","4242"\n"10.0.4.40","25","10.0.2.20","50000","Established","4"\n';
    expect(detectCaptureFormat(ps)).toBe('get-nettcpconnection');
    expect(parseCaptureOutput(ps).map((f) => `${f.sourceIp}>${f.destIp}:${f.destPort}`)).toEqual(['10.0.2.20>10.0.4.40:25', '10.0.4.40>10.0.3.30:1433']);
    const samples = '2026-09-01T00:00:00Z\t10.0.2.20\t10.0.3.30\t1433\tjava\n2026-09-01T00:10:00Z\t10.0.2.20\t10.0.3.30\t1433\tjava\n';
    expect(parseCaptureOutput(samples)).toEqual([{ sourceIp: '10.0.2.20', destIp: '10.0.3.30', destPort: 1433, protocol: 'tcp', observations: 2, firstSeen: '2026-09-01T00:00:00Z', lastSeen: '2026-09-01T00:10:00Z', process: 'java' }]);
    expect(splitEndpoint('[2001:db8::5]:443')).toEqual({ ip: '2001:db8::5', port: 443 });
  });
});

describe('VCF Operations for Networks flows', () => {
  it('generates a read-only script with the Networks login, batched searches and the address list', () => {
    const files = networksFlowsFiles(fixture(), { batch: 2 });
    const sh = files['discovery/networks-flows.sh'] ?? '';
    expect(sh).toContain('/api/ni/auth/token');
    expect(sh).toContain('/search/ql');
    expect(sh).toContain('/entities/fetch');
    expect(sh).toContain('VCFNET_PASSWORD_FILE');
    expect(sh).toContain('BATCH=2');
    expect(sh).toContain(FLOWS_CSV_HEADER);
    expect(files['discovery/server-ips.txt']).toBe(`${planAddresses(fixture()).join('\n')}\n`);
    expect(planAddresses(fixture())).toContain('2001:db8:0:1::10');
    expect(flowQuery(['10.0.0.1', '10.0.0.2'], 'source', 30)).toBe("flows where source ip address in ('10.0.0.1', '10.0.0.2') in last 30 days");
  });

  it('parses fetched flow entities', () => {
    const flows = parseNetworksEntities({ results: [{ entity: { source_ip: { ip_address: '10.0.2.20' }, destination_ip: { ip_address: '10.0.3.30' }, port: { start: 1433 }, protocol: 'TCP', destination_vm: { name: 'db-01' } } }, { entity: {} }] });
    expect(flows).toEqual([{ sourceIp: '10.0.2.20', destIp: '10.0.3.30', destPort: 1433, protocol: 'tcp', observations: 1, destName: 'db-01' }]);
  });
});
