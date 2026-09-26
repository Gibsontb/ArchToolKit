/**
 * The plan's half of each recommendation card, as HTML for the wizard's
 * results (so Full view, Print and Save as Word carry it): under each engine
 * card, what THIS plan builds for it on the chosen cloud ("What gets built on
 * <cloud>": each service with its Terraform resources or Ansible role, and
 * "named, not generated" with the reason); and the cards the engine does not
 * write: Migration path per server / database, Connectivity & cross-cloud
 * connectors, Licensing and What gets built.
 *
 * Every plan value is escaped: names come from imported inventories.
 */

import type { BuiltItem, DesignResult } from '../../multicloud/plan/apps/built.ts';
import type { AppConnector, ConnectorOption } from '../../multicloud/plan/apps/connectors.ts';
import type { WizardCard } from '../../multicloud/plan/apps/wizard-map.ts';
import { providerTerm } from '../../multicloud/plan/methodology.ts';
import { PLATFORM_LABELS } from '../../multicloud/plan/options.ts';
import type { Platform } from '../../multicloud/plan/types.ts';
import { PROVIDER_FLOWS } from '../../multicloud/wizard/provider-flows.ts';

export const esc = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const code = (xs: readonly string[], max = 6): string =>
  xs.length === 0 ? '' : ` <span class="result-types">${xs.slice(0, max).map((x) => `<code>${esc(x)}</code>`).join(' ')}${xs.length > max ? ` +${xs.length - max}` : ''}</span>`;

function itemLi(b: BuiltItem): string {
  if (!b.generated) {
    return `<li class="not-generated"><strong>Named, not generated:</strong> ${esc(b.service)}${code(b.builds)} <em>${esc(b.reason ?? '')}</em></li>`;
  }
  return `<li><strong>${esc(b.service)}</strong> <span class="muted">(${esc(b.by)})</span>${code(b.builds)}${b.detail ? `<br><span class="muted">${esc(b.detail)}</span>` : ''}</li>`;
}

/** "What gets built on <cloud>" for one card. */
export function planBlock(r: DesignResult, card: WizardCard): string {
  const items = r.built.filter((b) => b.card === card);
  if (items.length === 0) return '';
  return `<div class="result-built"><p><strong>What gets built on ${esc(PLATFORM_LABELS[r.platform])}</strong></p><ul>${items.map(itemLi).join('')}</ul></div>`;
}

/** The migration card's provider flow: its phases, what comes first, discovery, tools per source, cutover and its words. */
export function providerFlowHtml(p: Platform, kind: 'migration' | 'new-service' | 'change'): string {
  const f = PROVIDER_FLOWS[p];
  const tools = f.tools.map(([s, t]) => `<li>${esc(s)}: ${esc(t)}</li>`).join('');
  return `<div class="result-built">
    <p><strong>How ${esc(f.name)} does it</strong> <span class="muted">(${esc(f.framework)})</span></p>
    <p>${f.phases.map(([n], i) => `${i + 1}. ${esc(n)}`).join(' → ')}</p>
    <p><strong>Set up first:</strong> ${esc(f.first)} <strong>Connect:</strong> ${esc(f.connect)}</p>
    ${kind === 'migration' ? `<p><strong>Discover:</strong> ${esc(f.discover)}</p><ul>${tools}</ul><p><strong>Cutover and rollback:</strong> ${esc(f.cutover)}</p><p><strong>Gates:</strong> ${esc(f.gates)}</p>` : ''}
    <p class="muted"><strong>Their words:</strong> ${esc(f.words)} ${esc(f.note)}</p>
  </div>`;
}

/** Migration path per server / database, with the provider's words for the test run and cutover. */
export function pathsHtml(r: DesignResult, kind: 'migration' | 'new-service' | 'change'): string {
  const p = r.platform;
  if (kind !== 'migration') {
    return `<p>A ${kind === 'new-service' ? 'new service' : 'change to a running service'}: nothing moves. ${kind === 'new-service' ? 'The stack is deployed through the pipeline, then smoke-tested.' : 'The change bundle from Utilities applies to the stack that manages the service.'}</p>`;
  }
  if (r.paths.length === 0) return '<p>No server or database of this application is moved.</p>';
  const rows = r.paths.map((x) => `<tr><td>${esc(x.item)}</td><td>${x.kind === 'server' ? 'Server' : 'Database'}</td><td><strong>${esc(x.label)}</strong>${x.target ? `<br><span class="muted">to ${esc(x.target)}</span>` : ''}</td><td>${esc(x.why)}</td></tr>`).join('');
  return `<p>Each item's execution method on ${esc(PLATFORM_LABELS[p])}, from the decision and the source (overrides on Migration &amp; Utilities → Execute). The move runs as <strong>${esc(providerTerm('test-run', p))}</strong> → <strong>${esc(providerTerm('cutover', p))}</strong> → <strong>${esc(providerTerm('hypercare', p))}</strong>; the way back is <strong>${esc(providerTerm('rollback', p))}</strong>. It moves as one ${esc(providerTerm('move-group', p).toLowerCase())} in a ${esc(PROVIDER_FLOWS[p].waveLabel.toLowerCase())}.</p>
    <div class="table-scroll"><table class="sizing-table"><thead><tr><th>Item</th><th>Kind</th><th>Method</th><th>Why</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

const endName = (e: string): string => (e === 'on-prem' ? 'The data centre' : PLATFORM_LABELS[e as Platform] ?? e);

function sideCell(o: ConnectorOption, end: string): string {
  const s = o.sides.find((x) => x.end === end);
  if (!s) return '';
  return `${esc(s.service)}${code(s.terraform)}${s.noTerraform ? `<br><em>${esc(s.noTerraform)}</em>` : ''}`;
}

/** Connectivity & cross-cloud connectors: every link, both ends named. */
export function connectivityHtml(r: DesignResult): string {
  const here = r.platform;
  if (r.connectors.length === 0) return `<p>No link is needed: no data-centre link was asked for and no dependency sits on another cloud.</p>`;
  const row = (c: AppConnector): string => {
    const o = c.option;
    const tag = o.verification === 'V-DOC' ? '' : ` <span class="badge warn" title="${o.verification === 'I' ? 'Inferred' : 'Community source'}">[${o.verification === 'I' ? 'U' : 'C'}]</span>`;
    return `<tr>
      <td><strong>${esc(o.name)}</strong>${o.status === 'preview' ? ' <span class="badge warn">preview</span>' : ''}${tag}<br><span class="muted">${c.purpose === 'data-centre' ? 'Back to the data centre' : `${c.direction === 'in' ? `${esc(c.peer)} depends on this app` : c.direction === 'both' ? `Both ways with ${esc(c.peer)}` : `This app depends on ${esc(c.peer)}`}${c.kinds?.length ? ` (${esc(c.kinds.join(', '))})` : ''}`}</span></td>
      <td>${sideCell(o, here)}</td>
      <td><strong>${esc(endName(c.there))}</strong><br>${sideCell(o, c.there)}</td>
      <td>${esc(o.bandwidth)}<br><span class="muted">${esc(o.latency)}</span>${o.availability ? `<br><span class="muted">${esc(o.availability)}</span>` : ''}</td>
      <td>${c.build.generated ? `<strong>Generated</strong>: ${esc(c.build.by ?? '')}` : `<strong>Named, not generated</strong>: ${esc(c.build.reason ?? '')}`}${o.notes ? `<br><span class="muted">${esc(o.notes)}</span>` : ''}${c.alternatives.length ? `<br><span class="muted">Other options: ${c.alternatives.map((a) => esc(a.name)).join('; ')}</span>` : ''}<br>${o.sources.map((s) => `<a href="${esc(s)}" target="_blank" rel="noopener noreferrer">${esc(new URL(s).host)}</a>`).join(' ')}</td>
    </tr>`;
  };
  return `<p>Every link this application needs on ${esc(PLATFORM_LABELS[here])}, named on both ends. The other end of a cross-cloud connector is built by the peer application's own stack.</p>
    <div class="table-scroll"><table class="sizing-table"><thead><tr><th>Link</th><th>This end (${esc(PLATFORM_LABELS[here])})</th><th>Other end</th><th>Bandwidth · latency</th><th>In the stack</th></tr></thead><tbody>${r.connectors.map(row).join('')}</tbody></table></div>
    <p><strong>Landing zone:</strong> ${esc(r.landingZone.text)}</p>`;
}

/** Licensing: what the decision counts for the app on the cloud. */
export function licensingHtml(r: DesignResult): string {
  if (r.licences.length === 0) return `<p>No licence to count on ${esc(PLATFORM_LABELS[r.platform])}: licence-included images and managed services, or open-source software.</p>`;
  return `<ul>${r.licences.map((l) => `<li><strong>${l.count} ${esc(l.kind)}</strong> (${esc(l.model)}). <span class="muted">${esc(l.note)}</span></li>`).join('')}</ul>
    <p class="muted">Counted by the decision engine from the licensing facts (cores per VM, the minimums per server, the vendor's rules on each cloud).</p>`;
}

/** Per-server and per-database sizes on the cloud. */
export function sizingPlanHtml(r: DesignResult): string {
  const parts: string[] = [];
  if (r.compute.length > 0) {
    parts.push(`<p><strong>Per server on ${esc(PLATFORM_LABELS[r.platform])}</strong></p><div class="table-scroll"><table class="sizing-table"><thead><tr><th>Server</th><th>Size</th><th>vCPU · GiB</th><th>Disks</th><th>Arrives by</th></tr></thead><tbody>${r.compute.map((c) => `<tr><td>${esc(c.name)}</td><td><strong>${esc(c.size)}</strong></td><td>${c.vcpu} · ${c.ramGib}</td><td>${esc(c.disks)}</td><td>${esc(c.method || '—')}</td></tr>`).join('')}</tbody></table></div>`);
  }
  if (r.databases.length > 0) {
    parts.push(`<p><strong>Per database</strong></p><div class="table-scroll"><table class="sizing-table"><thead><tr><th>Database</th><th>Service</th><th>Class / shape</th><th>HA</th><th>Storage</th></tr></thead><tbody>${r.databases.map((d) => `<tr><td>${esc(d.name)}</td><td>${esc(d.service)}</td><td><strong>${esc(d.shape)}</strong></td><td>${esc(d.ha)}</td><td>${d.storageGib} GiB</td></tr>`).join('')}</tbody></table></div>`);
  }
  return parts.join('');
}

const CARD_TITLES: Readonly<Record<WizardCard, string>> = {
  compute: 'Compute', data: 'Data & storage', integration: 'Integration & messaging', ops: 'Ops, resilience & governance', security: 'Security & network', connectivity: 'Connectivity', migration: 'Migration',
};

/** What gets built on the cloud: everything, by card, then how the cloud takes it. */
export function builtHtml(r: DesignResult): string {
  const cards = (Object.keys(CARD_TITLES) as WizardCard[]).filter((c) => r.built.some((b) => b.card === c));
  const made = r.built.filter((b) => b.generated).length;
  const named = r.built.filter((b) => !b.generated).length;
  return `<p><strong>${made}</strong> item(s) generated, <strong>${named}</strong> named but not generated, on ${esc(PLATFORM_LABELS[r.platform])}. <strong>How ${esc(PLATFORM_LABELS[r.platform])} takes it:</strong> ${esc(r.deploy)}</p>
    ${cards.map((c) => `<p><strong>${esc(CARD_TITLES[c])}</strong></p><ul>${r.built.filter((b) => b.card === c).map(itemLi).join('')}</ul>`).join('')}`;
}

/** The plan's findings worth a design review (errors and warnings), for Assumptions & gaps. */
export function gapsHtml(r: DesignResult): string {
  const top = r.findings.filter((f) => f.severity === 'error' || f.severity === 'warning').slice(0, 10);
  if (top.length === 0) return '';
  return `<div class="result-built"><p><strong>From the plan</strong></p><ul>${top.map((f) => `<li>${f.severity === 'error' ? '⚠️ ' : ''}${esc(f.message)}</li>`).join('')}</ul></div>`;
}
