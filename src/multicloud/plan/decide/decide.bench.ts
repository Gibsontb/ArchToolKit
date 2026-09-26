/**
 * Benchmark (not a test): decidePlan on 5,000 workloads and 500 databases.
 * The budget is 500 ms in Node.
 *
 *   node --experimental-strip-types --no-warnings src/multicloud/plan/decide/decide.bench.ts
 */

import { defaultRequirements } from '../options.ts';
import { PLAN_KIND } from '../types.ts';
import type { Database, DbEngine, OsId, Plan, Workload } from '../types.ts';
import { decidePlan } from './engine.ts';

const OS: readonly OsId[] = ['win-2019', 'win-2022', 'win-2016', 'win-2012r2', 'rhel-8', 'rhel-9', 'ubuntu-22.04', 'ol-8', 'sles-15', 'centos-7', 'debian-12'];
const ROLES = ['web', 'app', 'db', 'file', 'batch', 'middleware', 'messaging', 'ad-dc', 'appliance'] as const;
const ENGINES: readonly DbEngine[] = ['oracle', 'sqlserver', 'postgres', 'mysql', 'mariadb'];

export function benchPlan(workloads = 5000, databases = 500): Plan {
  const ws: Workload[] = [];
  for (let i = 0; i < workloads; i += 1) {
    const os = OS[i % OS.length]!;
    ws.push({
      id: `w:vm-${i}`,
      name: `vm-${i}`,
      app: `app-${i % 250}`,
      env: i % 4 === 0 ? 'dev' : 'prod',
      role: ROLES[i % ROLES.length]!,
      os,
      vcpu: 2 + (i % 8) * 2,
      ramGib: 8 + (i % 16) * 8,
      disksGib: [80, 200],
      criticality: (['tier0', 'tier1', 'tier2', 'tier3'] as const)[i % 4]!,
      rpo: '4h',
      rto: '4h',
      licence: os.startsWith('win-') ? (i % 3 === 0 ? 'byol-sa' : 'li') : 'li',
      dependsOn: i % 10 === 0 ? [`vm-${i + 1}`] : [],
      ...(i % 97 === 0 ? { facts: { readiness: [{ id: 'rdm-physical', severity: 'blocker' as const }] } } : {}),
      source: 'estate',
    });
  }
  const ds: Database[] = [];
  for (let i = 0; i < databases; i += 1) {
    const engine = ENGINES[i % ENGINES.length]!;
    ds.push({
      id: `d:db-${i}`,
      name: `db-${i}`,
      engine,
      edition: engine === 'oracle' ? (i % 2 ? 'oracle-ee' : 'oracle-se2') : engine === 'sqlserver' ? 'sql-enterprise' : 'community',
      version: engine === 'oracle' ? 'oracle-19c' : engine === 'sqlserver' ? 'sql-2019' : engine === 'postgres' ? 'pg-15' : 'mysql-8.0',
      hosts: [`vm-${i * 10 + 2}`],
      vcpu: 4 + (i % 4) * 4,
      ramGib: 32,
      sizeGib: 500,
      ha: engine === 'oracle' && i % 10 === 0 ? 'rac' : engine === 'sqlserver' ? 'sql-ag' : 'none',
      dr: 'none',
      features: engine === 'sqlserver' ? ['agent-jobs'] : [],
      licence: engine === 'oracle' ? 'oracle-processor' : engine === 'sqlserver' ? 'byol-sa' : 'community',
      app: `app-${(i * 10 + 2) % 250}`,
      source: 'estate',
    });
  }
  const req = defaultRequirements();
  return {
    kind: PLAN_KIND,
    version: 1,
    id: 'bench',
    name: 'bench',
    savedAt: '2026-09-26',
    workloads: ws,
    databases: ds,
    apps: [],
    edges: [],
    requirements: {
      ...req,
      maxPlatforms: 3,
      commitments: [{ platform: 'azure', agreement: 'macc' }],
      skills: { azure: 'some', aws: 'strong' },
      licensing: { ...req.licensing, microsoftSa: 'yes-some', oracle: 'processor' },
    },
    designOverrides: {},
    waveSettings: { mode: 'default', maxPerWave: 50, parallel: 1, weeks: 2, freezes: [] },
  };
}

const p = benchPlan();
decidePlan(p, { today: '2026-09-26' }); // warm-up
const runs = 5;
const times: number[] = [];
let decision;
for (let i = 0; i < runs; i += 1) {
  const t0 = performance.now();
  decision = decidePlan(p, { today: '2026-09-26' });
  times.push(performance.now() - t0);
}
times.sort((a, b) => a - b);
const median = times[Math.floor(runs / 2)]!;
const placed = Object.values(decision!.items).filter((d) => d.chosen).length;
console.log(`decidePlan: ${p.workloads.length} workloads + ${p.databases.length} databases`);
console.log(`  runs (ms): ${times.map((t) => t.toFixed(1)).join(', ')}; median ${median.toFixed(1)} ms (budget 500 ms) -> ${median < 500 ? 'PASS' : 'FAIL'}`);
console.log(`  platforms: ${decision!.platforms.join(', ')}; ${placed} items placed; ${decision!.findings.length} plan findings`);
