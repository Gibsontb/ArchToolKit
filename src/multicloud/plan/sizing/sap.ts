/**
 * The `sap` engine (addendum A.2.8.7, A.4.4).
 *
 * - HANA: the smallest SAP-certified type (instance-specs.ts `SAP_HANA_CERTIFIED`)
 *   with memory ≥ the HANA memory × 1.0 — HANA sizing is already a memory
 *   quantity, so no comfort factor, and never below the host's nameplate.
 *   No certified type large enough: the platform is out, naming the largest.
 * - NetWeaver application servers by SAPS: ceil(SAPS / (SAPS per type × 0.65)),
 *   0.65 being SAP's target utilisation (verify). SAPS per type is published
 *   for AWS; elsewhere it is unknown [U] and the app servers go to the server
 *   engine.
 * - Disk layout from the HANA memory: /hana/data 1.2 ×, /hana/log 0.5 × up to
 *   512 GiB, /hana/shared 1 × up to 1 TiB, /usr/sap 50 GiB (SAP's HANA TDI
 *   storage guideline; verify against each cloud's SAP storage guide).
 * - VMware: a VM up to 16 TiB / 240 vCPU (SAP notes 3663150 / 3703816).
 */

import { error, info, warning, type Finding } from '../../../core/findings.ts';
import { SAP_HANA_FETCHED_AT, SPEC_SOURCES, sapHanaTypes, type SpecPlatform } from '../../../kit/instance-specs.ts';
import { vsphereSize } from '../design/compute.ts';
import type { AppComponent, Plan, Platform, SizingRow, Workload } from '../types.ts';
import type { SizingEngine } from './index.ts';
import { appPlanOf, gib, isPattern, num, reason, rec, serversOf, sizeServer, str, type SizingPolicyExt } from './server.ts';

/** SAP's target utilisation for application-server SAPS (verify). */
export const SAP_TARGET_UTILISATION = 0.65;
/** VCF 9 on Intel Xeon 6: the SAP HANA VM limits (Broadcom, 2026-01-19). */
export const VCF_HANA_MAX = { memoryGib: 16384, vcpu: 240, source: 'https://blogs.vmware.com/cloud-foundation/2026/01/19/sap-hana-and-sap-netweaver-support-for-vsphere-in-vmware-cloud-foundation-9-0-on-intel-xeon-6-cpus-with-p-core-systems/' } as const;
/** HANA storage ratios (SAP HANA TDI storage requirements; verify per cloud guide). */
export const HANA_DISK_RATIOS = {
  data: 1.2, log: 0.5, logMaxGib: 512, shared: 1, sharedMaxGib: 1024, usrSapGib: 50,
  source: 'https://www.sap.com/documents/2015/03/74cdb554-5a7c-0010-82c7-eda71af511fa.html', verification: 'I',
} as const;
/** Default NetWeaver application-server type where SAPS is published (AWS). */
export const SAP_APP_TYPE: Readonly<Partial<Record<Platform, string>>> = { aws: 'r7i.8xlarge' };

export interface SapInput {
  readonly component: string;
  readonly hanaMemoryGib: number;
  readonly saps?: number;
  readonly use?: 'oltp' | 'olap';
  readonly ha: boolean;
  readonly hanaHosts: readonly Workload[];
  readonly appServers: readonly Workload[];
  readonly appType?: string;
}

export function hanaDisks(memGib: number): { mount: string; gib: number }[] {
  const r = HANA_DISK_RATIOS;
  return [
    { mount: '/hana/data', gib: Math.ceil(memGib * r.data) },
    { mount: '/hana/log', gib: Math.ceil(Math.min(memGib * r.log, r.logMaxGib)) },
    { mount: '/hana/shared', gib: Math.ceil(Math.min(memGib * r.shared, r.sharedMaxGib)) },
    { mount: '/usr/sap', gib: r.usrSapGib },
  ];
}

/** The certified type for a HANA memory, or null with the largest there is. */
export function certifiedFor(platform: Platform, memGib: number, use?: 'oltp' | 'olap') {
  if (platform === 'vmware') return null;
  const list = sapHanaTypes(platform as SpecPlatform, use);
  return { fit: list.find((t) => t.memoryGib >= memGib) ?? null, largest: list[list.length - 1] ?? null, list };
}

export function sizeSap(input: SapInput, platform: Platform, policy: SizingPolicyExt): { rows: SizingRow[]; findings: Finding[] } {
  const rows: SizingRow[] = [];
  const findings: Finding[] = [];
  const need = input.hanaMemoryGib;
  const nodes = input.ha ? 2 : 1;

  if (need > 0) {
    let choice = '';
    let fits = false;
    const reasons = [reason(`HANA memory ${gib(need)} GiB (× 1.0: HANA sizing is already memory; no comfort factor).`)];
    const alternatives: string[] = [];
    const detail: Record<string, string | number> = { memoryGib: need, nodes };
    if (platform === 'vmware') {
      const vcpu = Math.min(VCF_HANA_MAX.vcpu, Math.max(8, Math.ceil(need / 16)));
      fits = need <= VCF_HANA_MAX.memoryGib;
      choice = fits ? vsphereSize(vcpu, Math.ceil(need)) : '';
      reasons.push(reason(`A VM within SAP's VCF 9 limits (${VCF_HANA_MAX.memoryGib / 1024} TiB, ${VCF_HANA_MAX.vcpu} vCPU; SAP notes 3663150, 3703816).`, { source: VCF_HANA_MAX.source }));
      if (!fits) findings.push(error('size.sap.vcf-too-large', `HANA at ${gib(need)} GiB is above the ${VCF_HANA_MAX.memoryGib} GiB a VCF 9 VM is supported for.`, { source: VCF_HANA_MAX.source }));
    } else {
      const c = certifiedFor(platform, need, input.use)!;
      if (c.fit) {
        choice = c.fit.type;
        fits = true;
        detail['certifiedMemoryGib'] = c.fit.memoryGib;
        detail['vcpu'] = c.fit.vcpu;
        if (c.fit.saps) detail['saps'] = c.fit.saps;
        reasons.push(reason(`${c.fit.type} (${c.fit.vcpu} vCPU / ${c.fit.memoryGib} GiB) is the smallest SAP HANA certified type with the memory${c.fit.note ? `; ${c.fit.note}` : ''}.`, { source: c.fit.source, fact: `sap-hana:${platform}:${c.fit.type}` }));
        alternatives.push(...c.list.filter((t) => t.memoryGib >= need && t.type !== c.fit!.type).slice(0, 3).map((t) => t.type));
        if (c.fit.verification !== 'V-DOC') findings.push(warning('size.sap.unverified-certification', `${c.fit.type}: its SAP HANA certification is not confirmed from a ${platform} page; check SAP's directory.`, { source: SPEC_SOURCES.sapDirectory }));
      } else {
        findings.push(error('size.sap.no-certified', `No ${platform} SAP HANA certified type has ${gib(need)} GiB${c.largest ? `; the largest is ${c.largest.type} (${c.largest.memoryGib} GiB)` : ''}.`, { source: c.largest?.source ?? SPEC_SOURCES.sapDirectory, remediation: 'Scale out (where certified), or choose another platform.' }));
      }
    }
    findings.push(info('size.sap.check-directory', `SAP HANA certification changes monthly (lists read ${SAP_HANA_FETCHED_AT}); check SAP's certified hardware directory before ordering.`, { source: SPEC_SOURCES.sapDirectory }));
    rows.push({ key: `sap-hana:${input.component}`, demand: { memoryGib: need }, choice, detail, fits, reasons, alternatives });

    for (const d of hanaDisks(need)) {
      rows.push({
        key: `sap-disk:${input.component}:${d.mount}`, demand: { memoryGib: need }, choice: `${d.gib} GiB`,
        detail: { mount: d.mount, sizeGib: d.gib }, fits: true,
        reasons: [reason(`${d.mount} from HANA memory (SAP TDI storage guideline; verify against the cloud's SAP storage guide).`, { source: HANA_DISK_RATIOS.source, assumption: true })],
        alternatives: [],
      });
    }
  }

  // NetWeaver application servers
  if (input.saps && input.saps > 0) {
    const type = input.appType ?? SAP_APP_TYPE[platform];
    const perType = type && platform !== 'vmware' ? sapHanaTypes(platform as SpecPlatform).find((t) => t.type === type)?.saps : undefined;
    if (type && perType) {
      const count = Math.max(input.ha ? 2 : 1, Math.ceil(input.saps / (perType * SAP_TARGET_UTILISATION)));
      rows.push({
        key: `sap-app:${input.component}`, demand: { saps: input.saps }, choice: type,
        detail: { count, sapsPerType: perType },
        fits: true,
        reasons: [reason(`${count} × ${type}: ${input.saps} SAPS ÷ (${perType} SAPS × ${SAP_TARGET_UTILISATION} target utilisation).`, { source: SPEC_SOURCES.sapAws }), reason(`SAP's ${SAP_TARGET_UTILISATION} target utilisation is not confirmed (verify).`, { assumption: true })],
        alternatives: [],
      });
    } else {
      findings.push(warning('size.sap.saps-unknown', `No published SAPS for a ${platform} application-server type [U]; the application servers are sized from their vCPU and memory.`));
      for (const w of input.appServers) {
        const r = sizeServer(w, platform, policy, { peak: true });
        rows.push({ ...r.row, key: `sap-app:${input.component}:${w.name}` });
        findings.push(...r.findings);
      }
    }
  }
  return { rows, findings };
}

const SAP_TYPES = new Set(['sap-hana', 'sap-netweaver', 'sap-java']);

export const sapEngine: SizingEngine<SapInput> = {
  id: 'sap',
  applies: (c) => isPattern(c) && (c.tierPattern === 'sap-certified' || SAP_TYPES.has(c.workloadType ?? '') || !!c.settings['sap.hanaMemoryGib'] || !!c.settings['sap.saps']),
  inputs(c: AppComponent, plan: Plan): SapInput {
    const servers = serversOf(c, plan);
    const answers = appPlanOf(c, plan)?.answers ?? {};
    const hanaHosts = servers.filter((w) => w.workloadType === 'sap-hana' || (isPattern(c) && c.workloadType === 'sap-hana'));
    const fromHosts = Math.max(0, ...hanaHosts.map((w) => w.facts?.nameplate?.ramGib ?? w.ramGib));
    const mem = num(c, 'sap.hanaMemoryGib', Number(answers['hanaMemoryGib'] ?? answers['hana-memory'] ?? Number.NaN));
    const saps = num(c, 'sap.saps', Number(answers['saps'] ?? Number.NaN));
    const use = str(c, 'sap.use', answers['use'] ?? '');
    return {
      component: c.id,
      hanaMemoryGib: Math.max(Number.isFinite(mem) ? mem : 0, fromHosts),
      ...(Number.isFinite(saps) ? { saps } : {}),
      ...(use === 'oltp' || use === 'olap' ? { use } : {}),
      ha: (str(c, 'sap.ha', answers['ha'] ?? 'no')) === 'yes',
      hanaHosts,
      appServers: servers.filter((w) => !hanaHosts.includes(w)),
      ...(str(c, 'sap.appType') ? { appType: str(c, 'sap.appType') } : {}),
    };
  },
  size(input, platform, policy) {
    const r = sizeSap(input, platform, policy);
    return rec('sap', platform, r.rows, r.findings);
  },
};
