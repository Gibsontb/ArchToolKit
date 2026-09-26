/**
 * The migration system end to end (WP-10, addendum A.12.3): a data-centre
 * exit from every source, through both pages' engines, to the zips.
 *
 * The fixture (src/testing/multicloud-fixture.ts) is 40 vSphere VMs from an
 * RVTools workbook, 6 Hyper-V VMs, 4 physical servers with utilisation and
 * 3 AWS instances from the collectors' discovery files; an SAP S/4HANA
 * system (HANA 1 TiB), Exchange 2019, Citrix (300 users, medium), a
 * Kubernetes platform (20 deployments), a 12 TiB file server and one new API
 * service; an ASA and a FortiGate configuration, two circuits and a
 * legal-hold archive; mode `dc-exit`.
 *
 * The chain is the one the pages run: intake (Sources) → types and patterns
 * confirmed (Servers, Applications) → recommendation and choice per app →
 * decision with the pattern rules → design with the pattern mappers →
 * sizing → Terraform and Ansible → waves → the execution kit → governance
 * and reports → network and security translation → the exit sequence → one
 * utility → the Generate project. Every step's findings are collected, and
 * every generated file is held to the house rules.
 */

import { before, describe, it } from 'node:test';
import { expect } from '../../testing/expect.ts';
import { ENGINE, buildE2e, type E2e, type Step } from '../../testing/multicloud-e2e.ts';
import { twentyDeployments } from '../../testing/multicloud-fixture.ts';
import { zip } from '../../kit/archive.ts';
import { archiveProject, projectDate } from '../../ui/multicloud/project.ts';
import { stackArchive } from '../../ui/application-migration/generate-model.ts';
import { bundleViolations } from '../change/index.ts';
import { decideApps } from './apps/recommend.ts';
import { collectorBundle } from './intake/sources/collectors.ts';
import { CREDENTIAL_PATTERNS, FOOTPRINT_PATTERNS, contractViolations } from './execute/contract.ts';
import { resolvePlanPaths } from './execute/paths.ts';
import { PATTERN_CATALOG, SAP_CERTIFIED, defaultTierPattern, patternTargets } from './patterns/index.ts';
import type { Plan, Platform } from './types.ts';

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

let E: E2e;
/** A second, independent run of the whole chain: the bytes must not differ. */
let E2: E2e;
before(async () => {
  E = await buildE2e();
  E2 = await buildE2e();
});

const errorsOf = (steps: readonly Step[]): string[] =>
  steps.flatMap((s) => s.findings.filter((f) => f.severity === 'error').map((f) => `${s.step}: ${f.code} ${f.path ?? ''} ${f.message}`));
const PLATFORMS: readonly Platform[] = ['aws', 'azure', 'google', 'oci', 'vmware'];

describe('e2e: the chain runs from every source to the project', () => {
  it('takes in 40 vSphere VMs, 6 Hyper-V VMs, 4 physical servers and 3 AWS instances', () => {
    const origins = (o: string): number => E.plan.workloads.filter((w) => !w.synthetic && (w.origin ?? 'vsphere') === o).length;
    expect(origins('vsphere')).toBe(40);
    expect(origins('hyperv')).toBe(6);
    expect(origins('physical')).toBe(4);
    expect(origins('aws')).toBe(3);
    expect(E.plan.mode).toBe('dc-exit');
  });

  it('proposes the specialised patterns from the confirmed types', () => {
    expect(E.proposed['S4']).toBe('sap-s4hana');
    expect(E.proposed['Citrix']).toBe('citrix-vad');
    expect(E.proposed['Platform']).toBe('kubernetes');
    expect(E.proposed['Directory']).toBe('ad-ds');
  });

  it('raises no error finding anywhere in the chain', () => {
    expect(errorsOf(E.steps)).toEqual([]);
  });

  it('places every item it moves on the platform its app was placed on, and uses all five platforms', () => {
    const misplaced: string[] = [];
    for (const ap of E.plan.appPlans ?? []) {
      const app = E.plan.apps.find((a) => a.id === ap.app)!;
      const ids = [...E.plan.workloads.filter((w) => w.app === app.name).map((w) => w.id), ...E.plan.databases.filter((d) => d.app === app.name).map((d) => d.id)];
      for (const id of ids) {
        const d = E.decision.items[id];
        if (!d || d.method === 'none') continue;
        if (d.chosen?.platform !== ap.platform) misplaced.push(`${id}: ${d.chosen?.platform ?? 'unplaced'} (app on ${ap.platform})`);
      }
    }
    expect(misplaced).toEqual([]);
    expect(new Set((E.plan.appPlans ?? []).map((p) => p.platform))).toEqual(new Set(PLATFORMS));
    expect((E.plan.appPlans ?? []).every((p) => p.status === 'planned')).toBe(true);
  });
});

describe('e2e: SAP S/4HANA (HANA 1 TiB)', () => {
  const certified = (p: Platform, type: string): boolean => SAP_CERTIFIED.some((t) => t.platform === p && t.type === type && t.memoryGib >= 1024);
  const platformOf = (): Platform => (E.plan.appPlans ?? []).find((x) => x.app === 'a:s4')!.platform!;

  it('designs the HANA server once, on a certified type with the memory', () => {
    const p = platformOf();
    expect(E.decision.items['w:s4p-hana01']!.chosen!.platform).toBe(p);
    const compute = E.design.platforms.find((x) => x.platform === p)!.compute.filter((c) => c.workload === 'w:s4p-hana01');
    expect(compute.length).toBe(1);
    expect(`${compute[0]!.size} ${certified(p, compute[0]!.size ?? '')}`).toBe(`${compute[0]!.size} true`);
  });

  it('sizes HANA once, and only on certified types', () => {
    const rows = E.sizing['a:s4']!.flatMap((r) => r.rows);
    const hana = rows.filter((r) => r.key.startsWith('sap-hana:'));
    expect(hana.length).toBe(1);
    for (const row of [...hana, ...rows.filter((r) => r.key === 'server:s4p-hana01')]) {
      expect(`${row.key} ${row.choice} ${certified(platformOf(), row.choice)}`).toBe(`${row.key} ${row.choice} true`);
    }
  });

  it('leaves open only the platforms with a certified type of 1 TiB, and moves by HANA System Replication', () => {
    const recommendation = E.recommendations['a:s4']!;
    for (const pp of recommendation.perPlatform) {
      if (!pp.eligible || pp.platform === 'vmware') continue;
      expect(`${pp.platform}: ${SAP_CERTIFIED.some((t) => t.platform === pp.platform && t.memoryGib >= 1024)}`).toBe(`${pp.platform}: true`);
    }
    expect(E.kit.resolutions.get('w:s4p-hana01')!.path).toBe('sap-hsr');
  });
});

describe('e2e: Exchange 2019', () => {
  it('defaults its mailbox component to Exchange Online (saas) on every platform, with the end-of-support warning', () => {
    const mailbox = PATTERN_CATALOG.exchange.components.find((c) => c.workloadTypes?.includes('exchange'))!;
    for (const p of PLATFORMS) expect(`${p}: ${defaultTierPattern(mailbox, p)}`).toBe(`${p}: saas`);
    // The design reads the placed variant's unset tier pattern as that default.
    const placed = (E.plan.appPlans ?? []).find((x) => x.app === 'a:mail')!.platform!;
    const t = patternTargets(E.plan, placed).filter((x) => x.app === 'a:mail');
    expect(t.length).toBeGreaterThan(0);
    expect(t.every((x) => x.tierPattern === 'saas')).toBe(true);
    expect(E.steps.some((s) => s.findings.some((f) => f.code === 'pattern.exchange.eos'))).toBe(true);
  });

  it('moves by Exchange Online remote moves once the app is routed to repurchase', () => {
    const plan: Plan = { ...E.plan, apps: E.plan.apps.map((a) => (a.name === 'Mail' ? { ...a, route: 'repurchase' as const } : a)) };
    const paths = resolvePlanPaths(plan, decideApps(plan, ENGINE));
    expect(paths.workloads.filter((r) => r.item.startsWith('w:exch-')).map((r) => r.path)).toEqual(['saas-exchange', 'saas-exchange']);
  });

  it('defaults the decision and the move path to saas with no route set', {
    todo: 'DEFECT: the saas default reaches the design (patternTargets) but not the decision: an unset tier pattern is not read as the template default by the disposition or the path resolver, so the Exchange servers are rehost / azure-migrate',
  }, () => {
    expect(E.decision.items['w:exch-mbx01']!.disposition).toBe('repurchase');
    expect(E.kit.resolutions.get('w:exch-mbx01')!.path).toBe('saas-exchange');
  });
});

describe('e2e: Citrix, the file server and the physical servers', () => {
  it('sizes Citrix for 300 medium users', () => {
    const vdi = E.sizing['a:citrix']!.flatMap((r) => r.rows).filter((r) => r.key.startsWith('vdi:'));
    expect(vdi.length).toBeGreaterThan(0);
    for (const row of vdi) {
      expect(row.demand['users']).toBe(300);
      expect(row.fits).toBe(true);
    }
  });

  it('sizes the 12 TiB file server as a file service that holds it', () => {
    const file = E.sizing['a:files']!.flatMap((r) => r.rows).filter((r) => r.key.startsWith('file:'));
    expect(file.length).toBe(1);
    expect(file[0]!.fits).toBe(true);
    expect(Number(file[0]!.demand['capacityGib'])).toBeGreaterThanOrEqual(12 * 1024);
  });

  it('sizes the physical servers from utilisation, below their nameplate', () => {
    const physical = E.plan.workloads.filter((w) => w.origin === 'physical');
    expect(physical.length).toBe(4);
    const rows = E.sizing['a:billing']!.flatMap((r) => r.rows);
    for (const w of physical) {
      const plate = w.facts!.nameplate!;
      expect(w.basis).toBe('utilisation');
      expect(w.vcpu).toBeLessThan(plate.cores);
      expect(w.ramGib).toBeLessThan(plate.ramGib);
      const row = rows.find((r) => r.key === `server:${w.name}`)!;
      expect(row.fits).toBe(true);
      expect(Number(row.detail['vcpu'])).toBeLessThan(plate.cores);
      expect(Number(row.detail['ramGib'])).toBeLessThan(plate.ramGib);
    }
  });
});

describe('e2e: the Kubernetes platform (20 deployments)', () => {
  it('fits every pool: allocatable at the target utilisation covers the requests', () => {
    const pools = E.sizing['a:platform']!.flatMap((r) => r.rows).filter((r) => r.key.startsWith('pool:'));
    expect(pools.length).toBeGreaterThan(0);
    for (const pool of pools) {
      const count = Number(pool.detail['count']);
      expect(pool.fits).toBe(true);
      expect(count * Number(pool.detail['allocCpuMillis']) * 0.7).toBeGreaterThanOrEqual(Number(pool.demand['cpuMillis']));
      expect(count * Number(pool.detail['allocMemMib']) * 0.7).toBeGreaterThanOrEqual(Number(pool.demand['memMib']));
    }
    const wanted = twentyDeployments().reduce((n, d) => n + d.replicas * d.cpuRequestM, 0);
    expect(pools.reduce((n, p) => n + Number(p.demand['cpuMillis']), 0)).toBe(wanted);
  });

  it('moves the cluster with Velero', () => {
    const paths = [...E.kit.resolutions.values()].filter((r) => r.item.startsWith('w:k8s-')).map((r) => r.path);
    expect(paths.length).toBe(8);
    expect(new Set(paths)).toEqual(new Set(['k8s-velero']));
  });
});

describe('e2e: the new API service', () => {
  it('has a stack (Terraform for its platform) and a pipeline', () => {
    expect(Object.keys(E.stack.result.files).filter((f) => f.endsWith('.tf')).length).toBeGreaterThan(0);
    expect(E.stack.pipeline.some((f) => f.endsWith('.github/workflows/infra.yml'))).toBe(true);
    expect(E.stack.findings.filter((f) => f.severity === 'error')).toEqual([]);
    // In the Generate project it is one of the AWS app stack's items, which the project's pipeline deploys.
    const root = E.project.root;
    expect(Object.keys(E.project.files).some((f) => f.startsWith(`${root}/apps/aws/prod/`) && f.includes('orders-api'))).toBe(true);
    expect(E.project.files[`${root}/.github/workflows/infra.yml`] ?? '').toContain('apps/aws/prod');
  });

  it('is deployed, not migrated', () => {
    const items = [...E.kit.resolutions.values()].filter((r) => r.item.startsWith('w:orders-api'));
    expect(items.length).toBeGreaterThan(0);
    expect(new Set(items.map((r) => r.path))).toEqual(new Set(['deploy']));
    expect(E.decision.items[items[0]!.item]!.disposition).toBe('new');
  });
});

describe('e2e: waves and the data-centre exit', () => {
  it('puts the exit waves after the last app wave, in number and in date', () => {
    const apps = E.waves.waves.filter((w) => w.kind !== 'exit');
    const exits = E.waves.waves.filter((w) => w.kind === 'exit');
    expect(exits.length).toBeGreaterThan(0);
    const lastApp = Math.max(...apps.map((w) => w.n));
    const lastEnd = apps.map((w) => w.end ?? '').sort().pop()!;
    for (const w of exits) {
      expect(w.n).toBeGreaterThan(lastApp);
      expect(`wave ${w.n} starts ${w.start}: ${(w.start ?? '') >= lastEnd}`).toBe(`wave ${w.n} starts ${w.start}: true`);
    }
  });

  it('cuts nothing while an app wave still uses it', () => {
    expect(E.exit.findings.filter((f) => f.code === 'dc.cut-too-early')).toEqual([]);
    expect(E.exit.waves.length).toBeGreaterThan(0);
  });

  it('translates both firewalls into the target platforms\' rules', () => {
    expect(E.netsec.translation.rules.length).toBeGreaterThan(0);
    const devices = new Set(E.netsec.translation.rules.flatMap((r) => r.sources.map((s) => s.split(':')[0])));
    expect(devices.has('dc1-edge-asa')).toBe(true);
    expect(devices.has('dc1-core-fgt')).toBe(true);
    expect(Object.keys(E.netsec.emitted.files).some((f) => /^netsec\/(aws|azure|google|oci|vmware)\.tf$/.test(f))).toBe(true);
  });

  it('keeps the legal-hold archive, and hands both circuits to the Network page', () => {
    const md = E.files['dcexit/exit-sequence.md']!;
    expect(md).toContain('mpls-dc1');
    expect(md).toContain('inet-dc1');
    const handoffs = E.exit.waves.flatMap((w) => w.steps.flatMap((s) => s.handoff ?? []));
    expect(new Set(handoffs.map((h) => h.circuit))).toEqual(new Set(['mpls-dc1', 'inet-dc1']));
    expect(E.steps.flatMap((s) => s.findings).some((f) => f.code === 'dc.legal-hold')).toBe(false);
  });
});

describe('e2e: the generated files', () => {
  it('keeps the execution contract in every script of the kit and of the utility', () => {
    expect(Object.entries(E.kit.files).flatMap(([p, t]) => contractViolations(p, t))).toEqual([]);
    expect(bundleViolations(E.change)).toEqual([]);
  });

  it('holds no credential literal and no footprint in any file', () => {
    const bad: string[] = [];
    for (const [path, text] of Object.entries(E.files)) {
      for (const re of [...CREDENTIAL_PATTERNS, ...FOOTPRINT_PATTERNS]) {
        const m = re.exec(text);
        if (m) bad.push(`${path}: ${m[0].slice(0, 40)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('uses VMware Cloud Foundation 9.1 names only', () => {
    const OLD = /\bAria\b|vRealize|\bvRA\b|\bvROps\b|\bESXi\b|Service Broker/;
    const bad = Object.entries(E.files).filter(([, t]) => OLD.test(t)).map(([p, t]) => `${p}: ${OLD.exec(t)![0]}`);
    expect(bad).toEqual([]);
  });

  it('generates the same files on a second run', () => {
    expect(Object.keys(E2.files).sort()).toEqual(Object.keys(E.files).sort());
    expect(Object.keys(E.files).filter((k) => E.files[k] !== E2.files[k])).toEqual([]);
  });

  it('builds every archive byte for byte the same twice', async () => {
    const pairs: [string, () => Promise<Uint8Array>, () => Promise<Uint8Array>][] = [
      ['project.zip', () => archiveProject(E.plan, E.project.files, 'zip'), () => archiveProject(E2.plan, E2.project.files, 'zip')],
      ['project.tar.gz', () => archiveProject(E.plan, E.project.files, 'tar.gz'), () => archiveProject(E2.plan, E2.project.files, 'tar.gz')],
      ['stack.zip', () => stackArchive(E.plan, E.stack.files), () => stackArchive(E2.plan, E2.stack.files)],
      ['execute.zip', () => zip(E.kit.files, projectDate(E.plan)), () => zip(E2.kit.files, projectDate(E2.plan))],
      ['change.zip', () => zip(E.change.files, projectDate(E.plan)), () => zip(E2.change.files, projectDate(E2.plan))],
      ['collectors.zip', () => collectorBundle(), () => collectorBundle()],
    ];
    for (const [name, one, two] of pairs) {
      const a = await one();
      const b = await two();
      expect(`${name}: ${a.length > 0 && a.length === b.length && a.every((x, i) => x === b[i])}`).toBe(`${name}: true`);
    }
  });
});
