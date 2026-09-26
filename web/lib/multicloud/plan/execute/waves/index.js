/**
 * WP-12: the wave kit — everything under `migration/execute/` that is not a
 * path script (addendum A.6.2, A.7):
 *
 *   waves/wave-<n>/  wave.json precheck.sh replicate.sh test.sh cutover.sh commit.sh
 *                    rollback.sh validate.sh decommission.sh gates.md runbook.md
 *   dns/             dns.sh records.csv
 *   lb/              lb.sh members.csv
 *   ansible/         freeze.yml unfreeze.yml baseline.yml validate.yml identity.yml windows-dns.yml
 *   rightsize-after.sh
 *
 * `waveKit(ctx)` returns them with their findings and controller needs.
 * `WAVE_GENERATORS` lists the script-producing modules, each a render
 * function, for callers that want one file at a time.
 *
 * Wiring (kit.ts, after the path generators and before the contract check):
 *   const wk = waveKit(ctx);
 *   for (const [p, t] of Object.entries(wk.files)) put(p, t, 'waves');
 *   needs.push(...wk.needs);
 *   findings.push(...wk.findings);
 *
 * Pure: no DOM, no file system.
 */

import { info,              } from '../../../../core/findings.js';
import { EXECUTE_DIR } from '../contract.js';
                                               
import { ansibleKitFiles } from './ansible-kit.js';
import { renderCommit } from './commit.js';
import { WAVE_NEEDS, waveFile, waveSpecs,                                 } from './common.js';
import { renderCutover } from './cutover.js';
import { renderDecommission } from './decommission.js';
import { dnsNeeds, dnsRecords, renderDnsSh, renderRecordsCsv, renderWindowsDnsYml } from './dns.js';
import { renderGatesMd } from './gates.js';
import { lbMembers, lbNeeds, renderLbSh, renderMembersCsv } from './lb.js';
import { renderPrecheck } from './precheck.js';
import { RIGHTSIZE_FILE, renderRightsizeAfter } from './rightsize-after.js';
import { renderRollback } from './rollback.js';
import { renderReplicate, renderTest } from './test.js';
import { renderRunbookMd, waveTimeline } from './timeline.js';
import { renderValidate } from './validate.js';

export const WAVE_KIND = 'archtoolkit.migration-wave';

/** One per-wave file and its renderer. */
                                
                                                
                        
                                              
 

/** The per-wave files, in run order. */
export const WAVE_GENERATORS                           = Object.freeze([
  { file: 'precheck.sh', render: renderPrecheck },
  { file: 'replicate.sh', render: renderReplicate },
  { file: 'test.sh', render: renderTest },
  { file: 'cutover.sh', render: renderCutover },
  { file: 'validate.sh', render: renderValidate },
  { file: 'commit.sh', render: renderCommit },
  { file: 'rollback.sh', render: renderRollback },
  { file: 'decommission.sh', render: renderDecommission },
  { file: 'gates.md', render: renderGatesMd },
  { file: 'runbook.md', render: renderRunbookMd },
  { file: 'wave.json', render: renderWaveJson },
]);

/** `waves/wave-<n>/wave.json`: the wave's items with their scripts, criticality, keep and hypercare days, and its timeline. */
export function renderWaveJson(w          )         {
  const body = {
    kind: WAVE_KIND,
    v: 1,
    planId: w.planId,
    wave: w.n,
    ...(w.name ? { name: w.name } : {}),
    ...(w.kind ? { waveKind: w.kind } : {}),
    ...(w.start ? { start: w.start } : {}),
    ...(w.end ? { end: w.end } : {}),
    production: w.production,
    foundationWaves: w.foundationWaves,
    platforms: w.platforms,
    items: w.items.map((i) => ({
      id: i.item.id, name: i.item.name, kind: i.item.kind, app: i.item.app, path: i.item.path, script: i.item.script ?? null,
      source: i.item.source.platform, target: i.item.target.platform ?? null, env: i.env ?? null, criticality: i.criticality,
      keepDays: i.keepDays, hypercareDays: i.hypercareDays, lagSeconds: i.lagSeconds, ...(i.rename ? { rename: i.rename } : {}),
    })),
    timeline: waveTimeline(w).map((r) => ({ id: r.id, label: r.label, offset: r.offset, ...(r.business ? { business: true } : {}), ...(r.date ? { date: r.date } : {}), title: r.title, ...(r.command ? { command: r.command } : {}) })),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

                          
                                          
                                                   
                                        
                                      
                                      
 

export { EXECUTE_DIR };

/** Every wave-kit file for the context's manifest. */
export function waveKit(ctx             )          {
  const waves = waveSpecs(ctx);
  const files                         = {};
  const findings            = [];
  for (const w of waves) for (const g of WAVE_GENERATORS) files[waveFile(w.n, g.file)] = g.render(w);
  const dns = dnsRecords(ctx);
  const lb = lbMembers(ctx);
  findings.push(...dns.findings, ...lb.findings);
  files['dns/dns.sh'] = renderDnsSh();
  files['dns/records.csv'] = renderRecordsCsv(dns.rows);
  files['lb/lb.sh'] = renderLbSh();
  files['lb/members.csv'] = renderMembersCsv(lb.rows);
  Object.assign(files, ansibleKitFiles());
  files['ansible/windows-dns.yml'] = renderWindowsDnsYml();
  files[RIGHTSIZE_FILE] = renderRightsizeAfter();
  const prod = waves.filter((w) => w.production);
  if (prod.length) {
    findings.push(info('exec.waves.landing-zone-gate', `${prod.length} production wave(s) (${prod.map((w) => w.n).join(', ')}) wait for the landing-zone gate: their pre-check needs status/gates/programme-landing-zone.json with decision go.`, { remediation: 'Record the landing-zone gate in the tracker once the foundation items F01–F14 are green.' }));
  }
  const unwaved = ctx.manifest.items.filter((i) => i.wave === null).length;
  if (unwaved) findings.push(info('exec.waves.unwaved', `${unwaved} item(s) are in no wave, so no wave script runs them.`));
  const sorted                         = {};
  for (const k of Object.keys(files).sort()) sorted[k] = files[k] ;
  return { files: sorted, findings, needs: [...WAVE_NEEDS, ...dnsNeeds(dns.rows), ...lbNeeds(lb.rows)], waves };
}
