import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from '../../../testing/expect.ts';
import { itemId } from '../options.ts';
import type { Site, Workload } from '../types.ts';
import {
  maskSecrets, extractPoints, parseCouplingFile, importCoupling, resolveCoupling, resolvePoint, inCidr,
  couplingActions, couplingIssues, couplingGrid, remediationByApp, remediationMarkdown, waveLookup, addDays, isPrivate,
  COUPLING_GRID_COLUMNS, COUPLING_COLLECTOR_FILES, couplingFiles, couplingBundle, renderCouplingCollector,
  type CouplingContext,
} from './index.ts';

const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;
const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0;

// ---------------------------------------------------------------------------
// Masking: secrets are never copied
// ---------------------------------------------------------------------------

describe('secret masking', () => {
  it('masks values of keys named like password, pwd, secret, key or token', () => {
    const cases: [string, string][] = [
      ['Server=db01;Database=crm;User ID=app;Password=hunter2;', 'Server=db01;Database=crm;User ID=app;Password=***;'],
      ['Data Source=db01;Initial Catalog=x;pwd=S3cr3t!;', 'Data Source=db01;Initial Catalog=x;pwd=***;'],
      ['<add key="ApiKey" value="x" /><add name="a" password="p@ss" />', '<add key="***" value="***" /><add name="a" password="***" />'],
      ['<add key="DbPassword" value="hunter2" />', '<add key="***" value="***" />'],
      ['{"apiKey": "abc123", "client_secret": "zzz", "token":"t0k"}', '{"apiKey": "***", "client_secret": "***", "token":"***"}'],
      ['DB_PASSWORD=foo', 'DB_PASSWORD=***'],
      ['AccountKey=AbCd+/==;EndpointSuffix=core.windows.net', 'AccountKey=***;EndpointSuffix=core.windows.net'],
      ['secret: plain-yaml', 'secret: ***'],
      ['redis://:pw@10.1.2.20:6379/0', 'redis://:***@10.1.2.20:6379/0'],
      ['https://svc:Passw0rd@api.partner.com/v1', 'https://svc:***@api.partner.com/v1'],
      ['jdbc:postgresql://10.1.2.9:5432/app', 'jdbc:postgresql://10.1.2.9:5432/app'],
    ];
    for (const [input, masked] of cases) expect(maskSecrets(input)).toBe(masked);
  });
  it('re-masks on import and says so, without keeping the secret', () => {
    const file = {
      kind: 'archtoolkit.coupling', v: 1, server: 'app01', self: { ipv4: ['10.1.2.3'], ipv6: [], macs: [] },
      refs: [{ category: 'connection-string', where: 'C:\\app\\web.config:3', value: 'Server=db01;Password=hunter2' }],
    };
    const p = parseCouplingFile(JSON.stringify(file));
    expect(p.refs[0]!.value).toBe('Server=db01;Password=***');
    expect(JSON.stringify(p).includes('hunter2')).toBe(false);
    expect(p.findings.map((f) => f.code)).toEqual(['coupling.unmasked']);
  });
  it('the collectors mask with the same rule, in the guest', { skip: !hasBash }, () => {
    const script = renderCouplingCollector('coupling-linux.sh');
    const fn = script.slice(script.indexOf('mask() {'), script.indexOf('\n}\n', script.indexOf('mask() {')) + 3);
    const input = ['Password=hunter2;', '{"apiKey": "abc123"}', 'redis://:pw@10.1.2.20:6379', 'DB_PASSWORD=foo', '<add key="DbPassword" value="hunter2" />'].join('\n');
    const r = spawnSync('bash', ['-c', `${fn}\nmask`], { input, encoding: 'utf8' });
    expect(r.stdout.trim().split('\n')).toEqual(input.split('\n').map(maskSecrets));
  });
  it('the Windows collector masks with the same rule', { skip: !hasPwsh }, () => {
    const script = renderCouplingCollector('coupling-windows.ps1');
    const start = script.indexOf('function Hide-Secret');
    const fn = script.slice(start, script.indexOf('\n}\n', start) + 3);
    const inputs = ['Password=hunter2;', '{"apiKey": "abc123"}', 'redis://:pw@10.1.2.20:6379', '<add password="p@ss" />', '<add key="DbPassword" value="hunter2" />'];
    const r = spawnSync('pwsh', ['-NoProfile', '-Command', `${fn}\n${inputs.map((i) => `Hide-Secret '${i}'`).join('\n')}`], { encoding: 'utf8' });
    expect(r.stdout.trim().split(/\r?\n/)).toEqual(inputs.map(maskSecrets));
  });
});

// ---------------------------------------------------------------------------
// The collectors
// ---------------------------------------------------------------------------

describe('coupling collectors', () => {
  it('bash -n and the PowerShell parser pass', () => {
    if (hasBash) {
      const r = spawnSync('bash', ['-n'], { input: renderCouplingCollector('coupling-linux.sh'), encoding: 'utf8' });
      expect(r.stderr).toBe('');
    }
    if (hasPwsh) {
      const dir = mkdtempSync(join(tmpdir(), 'atk-ps-'));
      try {
        const f = join(dir, 'c.ps1');
        writeFileSync(f, renderCouplingCollector('coupling-windows.ps1'));
        const r = spawnSync('pwsh', ['-NoProfile', '-Command', `$t=$null;$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${f}',[ref]$t,[ref]$e);$e.Count`], { encoding: 'utf8' });
        expect(r.stdout.trim()).toBe('0');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });
  it('the bundle carries both collectors, the play and a README, reproducibly', async () => {
    const files = couplingFiles();
    expect(Object.keys(files).sort()).toEqual([...COUPLING_COLLECTOR_FILES, 'README.md'].sort());
    expect(files['discover-coupling.yml']).toContain('ansible.windows.win_powershell');
    const a = await couplingBundle();
    const b = await couplingBundle();
    expect(a.length === b.length && a.every((v, i) => v === b[i])).toBe(true);
  });
  it('coupling-linux.sh on a fixture tree: literals, connection strings, secrets masked', { skip: !hasBash || process.platform === 'win32' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'atk-cpl-'));
    try {
      mkdirSync(join(dir, 'app'));
      writeFileSync(join(dir, 'app', 'app.properties'), 'db.url=jdbc:postgresql://10.1.2.9:5432/app\ndb.password=S3cret!\nmail.host=smtp.corp.example\n');
      writeFileSync(join(dir, 'coupling-linux.sh'), renderCouplingCollector('coupling-linux.sh'));
      const r = spawnSync('bash', [join(dir, 'coupling-linux.sh'), '--roots', join(dir, 'app'), '--domains', 'corp.example', '--max-files', '50'], { encoding: 'utf8' });
      expect(r.status).toBe(0);
      expect(r.stdout.includes('S3cret')).toBe(false);
      const p = parseCouplingFile(r.stdout, ['corp.example']);
      const mine = p.refs.filter((x) => x.where.includes('app.properties'));
      expect(mine.map((x) => x.category).sort()).toEqual(['connection-string', 'smtp']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------
// Import and resolution
// ---------------------------------------------------------------------------

const workload = (name: string, app: string, ips: string[], over: Partial<Workload> = {}): Workload => ({
  id: `workload:${name}`, name, app, env: 'prod', role: 'app', os: 'rhel-9', vcpu: 2, ramGib: 8, disksGib: [50], criticality: 'tier2', rpo: '4h', rto: '4h',
  licence: 'rhel-byos', dependsOn: [], source: 'estate', facts: { ipAddresses: ips }, ...over,
});
const WORKLOADS: Workload[] = [
  workload('crm-app01', 'CRM', ['10.1.2.3']),
  workload('crm-db01', 'CRM', ['10.1.2.9', '2001:db8::9'], { ipStrategy: 're-ip' }),
  workload('erp-db01', 'ERP', ['10.3.0.21'], { ipStrategy: 'keep-ip-cloud' }),
  workload('fs01', 'Files', ['10.9.9.10']),
];
const SITES: Site[] = [{ name: 'london', cidrs: ['10.200.0.0/16', 'fd00:200::/48'], bandwidth: '1g', circuit: 'none' }];

const FILE = {
  kind: 'archtoolkit.coupling', v: 1, collectedAt: '2026-09-20', server: 'crm-app01', os: 'linux',
  self: { fqdn: 'crm-app01.corp.example', ipv4: ['10.1.2.3'], ipv6: [], macs: ['00:50:56:aa:bb:cc'] },
  refs: [
    { category: 'connection-string', where: '/opt/crm/app.properties:14', value: 'db.url=jdbc:postgresql://10.1.2.9:5432/crm', points: ['10.1.2.9'] },
    { category: 'connection-string', where: '/opt/crm/app.properties:15', value: 'erp.url=jdbc:oracle:thin:@erp-db01:1521:ERP' },
    { category: 'hosts', where: '/etc/hosts:9', value: '10.1.2.9 crm-db01 crm-db01.corp.example' },
    { category: 'share', where: '/etc/fstab:12', value: '//fs01/crm /mnt/crm cifs credentials=/root/.smb,vers=3.0 0 0' },
    { category: 'licence', where: '/opt/flexlm/license.dat:1', value: 'SERVER crm-app01 005056aabbcc 27000', binding: 'mac', mac: '00:50:56:aa:bb:cc' },
    { category: 'certificate', where: '/etc/nginx/conf.d/crm.conf', value: 'CN=crm.corp.example', subject: 'CN=crm.corp.example', sans: ['crm.corp.example', 'crm'], notAfter: '2026-11-10' },
    { category: 'smtp', where: '/etc/postfix/main.cf', value: 'relayhost = [smtp.corp.example]:25' },
    { category: 'service-account', where: 'systemd:crm.service', value: 'crmsvc' },
    { category: 'scheduled-job', where: 'cron:crmsvc', value: '/opt/crm/bin/nightly-export.sh --to sftp.partner.example', schedule: '0 2 * * *', runAs: 'crmsvc', scheduler: 'cron' },
    { category: 'config', where: '/opt/crm/partner.yml:3', value: 'endpoint: https://api.partner.example/v2' },
    { category: 'config', where: '/opt/crm/local.yml:1', value: 'self: http://10.1.2.3:8080/health' },
    { category: 'snmp', where: '/etc/snmp/snmpd.conf:40', value: 'trap2sink 10.200.1.5 ***' },
    { category: 'time', where: 'chrony', value: 'server ntp1.corp.example', timezone: 'Europe/London' },
    { category: 'bogus', where: 'x', value: 'y' },
  ],
};

describe('import and resolution', () => {
  it('parses, drops self references and unknown categories, and re-derives the points', () => {
    const p = parseCouplingFile(JSON.stringify(FILE), ['corp.example']);
    expect(p.refs.length).toBe(13);
    expect(p.findings.map((f) => f.code)).toEqual(['coupling.category']);
    expect(p.refs[1]!.points).toEqual(['erp-db01']);
    expect(p.refs[3]!.points).toContain('fs01');
    expect(p.refs.find((r) => r.where.startsWith('/opt/crm/local.yml'))!.points).toEqual([]);
    expect(p.refs[4]!.points).toEqual([]);
  });
  it('extracts IPv4, IPv6, UNC, URL, key=value and JDBC hosts, and estate FQDNs', () => {
    expect(extractPoints('Server=tcp:sql01,1433;Data Source=db02')).toEqual(['sql01', 'db02']);
    expect(extractPoints('\\\\fs01\\share and https://svc:***@api.x.com/a and [2001:db8::1]:443')).toEqual(['2001:db8::1', 'fs01', 'api.x.com']);
    expect(extractPoints('see app.corp.example and 12:30:45 and ::', ['corp.example'])).toEqual(['app.corp.example']);
  });
  it('resolves to servers by IP (both families) and by name, to sites by CIDR, else external', () => {
    const ctx = { workloads: WORKLOADS, sites: SITES };
    expect(resolvePoint('10.1.2.9', ctx)).toEqual({ point: '10.1.2.9', kind: 'server', name: 'crm-db01', app: 'CRM', by: 'ip' });
    expect(resolvePoint('2001:DB8::9', ctx).name).toBe('crm-db01');
    expect(resolvePoint('crm-db01.corp.example', ctx).by).toBe('fqdn');
    expect(resolvePoint('10.200.1.5', ctx)).toEqual({ point: '10.200.1.5', kind: 'site', name: 'site:london', by: 'cidr' });
    expect(resolvePoint('fd00:200::7', ctx).kind).toBe('site');
    expect(resolvePoint('api.partner.example', ctx).kind).toBe('external');
    expect([inCidr('10.1.2.3', '10.1.0.0/16'), inCidr('10.2.0.1', '10.1.0.0/16'), inCidr('2001:db8::1', '2001:db8::/32'), inCidr('2001:db9::1', '2001:db8::/32')]).toEqual([true, false, true, false]);
    expect([isPrivate('10.0.0.1'), isPrivate('100.64.1.1'), isPrivate('52.1.1.1'), isPrivate('fs01'), isPrivate('api.x.com')]).toEqual([true, true, false, true, false]);
  });
});

// ---------------------------------------------------------------------------
// Rules, issues and the checklist
// ---------------------------------------------------------------------------

describe('remediation rules', () => {
  const waves = {
    waves: [{ n: 1, groups: ['g1'], start: '2026-11-01', end: '2026-11-15' }, { n: 2, groups: ['g2'], start: '2026-12-01', end: '2026-12-15' }],
    groups: [
      { id: 'g1', items: ['workload:crm-db01'], why: 'db first', wave: 1, method: 'replicate' as const },
      { id: 'g2', items: ['workload:crm-app01', 'workload:fs01', 'workload:erp-db01'], why: 'app', wave: 2, method: 'replicate' as const },
    ],
  };
  const ctx: CouplingContext = { workloads: WORKLOADS, waveOf: waveLookup(waves, WORKLOADS), on: '2026-09-26', domains: ['corp.example'] };
  const imported = importCoupling([JSON.stringify(FILE)], ['corp.example']);
  const resolved = resolveCoupling(imported.refs, { workloads: WORKLOADS, sites: SITES });
  const out = couplingActions(resolved, ctx);
  const by = (rule: string) => out.actions.filter((a) => a.rule === rule);

  it('an IP literal of a re-IP server is a blocker for the wave the address changes in', () => {
    const blockers = by('coupling.ip-literal-reip');
    expect(blockers.map((b) => [b.where, b.wave, b.due, b.severity])).toEqual([
      ['/opt/crm/app.properties:14', 1, '2026-10-27', 'blocker'],
      ['/etc/hosts:9', 1, '2026-10-27', 'blocker'],
    ]);
    expect(blockers[0]!.items).toEqual([itemId('workload', 'crm-app01'), itemId('workload', 'crm-db01')]);
    expect(out.findings.map((f) => f.code)).toContain('coupling.blockers');
  });
  it('a literal of a server that keeps its address is only advice', () => {
    const keep = resolveCoupling([{ server: 'crm-app01', category: 'config', where: 'x:1', value: 'erp=10.3.0.21', points: ['10.3.0.21'] }], { workloads: WORKLOADS });
    const a = couplingActions(keep, ctx).actions;
    expect(a.map((x) => x.rule)).toEqual(['coupling.dependency', 'coupling.ip-literal']);
    const same = resolveCoupling([{ server: 'crm-app01', category: 'config', where: 'x:1', value: 'db=10.3.0.21', points: ['10.3.0.21'] }], { workloads: WORKLOADS.map((w) => (w.name === 'erp-db01' ? { ...w, app: 'CRM' } : w)) });
    expect(couplingActions(same, { ...ctx, workloads: WORKLOADS.map((w) => (w.name === 'erp-db01' ? { ...w, app: 'CRM' } : w)) }).actions.map((x) => x.rule)).toEqual(['coupling.ip-literal']);
  });
  it('the other rules: hosts, dependency edge, share, licence T−30, certificate in the window, SMTP, service account, jobs, SNMP / time, external', () => {
    expect(by('coupling.hosts-entry').length).toBe(1);
    expect(out.edges).toEqual([{ from: 'CRM', to: 'ERP', kind: 'sync' }, { from: 'CRM', to: 'Files', kind: 'sync' }]);
    const lic = by('coupling.licence-binding')[0]!;
    expect([lic.severity, lic.wave, lic.due]).toEqual(['warning', 2, addDays('2026-12-01', -30)]);
    const cert = by('coupling.certificate')[0]!;
    expect(cert.severity).toBe('error');
    expect(cert.action).toContain('SANs: crm.corp.example, crm');
    expect(by('coupling.smtp-relay')[0]!.action).toContain('Amazon SES');
    expect(by('coupling.service-account')[0]!.action).toContain('crmsvc');
    expect(out.jobs).toEqual([{ job: 'cron:crmsvc', scheduler: 'cron', host: 'crm-app01', schedule: '0 2 * * *', command: '/opt/crm/bin/nightly-export.sh --to sftp.partner.example', runsAs: 'crmsvc', app: 'CRM', target: 'ansible.builtin.cron on the target host' }]);
    expect(by('coupling.monitoring-time').length).toBe(2);
    expect(out.external.map((e) => [e.endpoint, e.kind, e.protocol])).toEqual([['api.partner.example', 'outbound-saas', 'https']]);
  });
  it('a certificate that outlives the wave is a warning', () => {
    const later = resolveCoupling([{ server: 'crm-app01', category: 'certificate', where: 'c', value: 'CN=x', points: [], notAfter: '2027-06-01' }], { workloads: WORKLOADS });
    expect(couplingActions(later, ctx).actions[0]!.severity).toBe('warning');
  });
  it('"Create tasks": item-linked RAID issues with due dates; info stays out unless asked', () => {
    const issues = couplingIssues(out.actions, { opened: '2026-09-26' });
    expect(issues.every((i) => i.origin === 'coupling' && i.status === 'open')).toBe(true);
    const blocker = issues.find((i) => i.severity === 'sev1')!;
    expect([blocker.wave, blocker.due, blocker.blocks]).toEqual([1, '2026-10-27', [itemId('workload', 'crm-app01'), itemId('workload', 'crm-db01')]]);
    expect(issues.some((i) => i.severity === 'sev4')).toBe(false);
    expect(couplingIssues(out.actions, { opened: '2026-09-26', includeInfo: true }).some((i) => i.severity === 'sev4')).toBe(true);
    expect(new Set(issues.map((i) => i.id)).size).toBe(issues.length);
  });
  it('the grid and the per-app checklist', () => {
    expect(COUPLING_GRID_COLUMNS).toEqual(['Server', 'Category', 'Where', 'Value (masked)', 'Points to', 'Resolves to', 'Action', 'Due', 'Status']);
    const grid = couplingGrid(out.actions);
    expect(grid[0]!.length).toBe(COUPLING_GRID_COLUMNS.length);
    expect(grid.every((r) => !r.join(' ').includes('hunter2'))).toBe(true);
    const lists = remediationByApp(out.actions);
    expect(Object.keys(lists)).toEqual(['CRM']);
    expect(lists.CRM![0]!.severity).toBe('blocker');
    const md = remediationMarkdown('CRM', lists.CRM!);
    expect(md.split('\n')[0]).toBe('## Coupling remediation: CRM');
    expect(md).toContain('- [ ] **blocker** crm-app01: Replace 10.1.2.9 with the FQDN before cutover');
  });
  it('the Windows collector output shape imports too', () => {
    const win = { ...FILE, os: 'windows', server: 'CRM-APP01', refs: [{ category: 'certificate', where: 'cert:LocalMachine\\My\\AB12', value: 'CN=crm.corp.example', subject: 'CN=crm.corp.example', issuer: 'CN=Corp CA', notAfter: '2027-01-31', sans: ['crm.corp.example'], bindings: ['0.0.0.0:443'], thumbprint: 'AB12' }] };
    const p = parseCouplingFile(win);
    expect(p.refs[0]!.bindings).toEqual(['0.0.0.0:443']);
    expect(p.refs[0]!.issuer).toBe('CN=Corp CA');
    expect(readFileSync !== undefined).toBe(true);
  });
});
