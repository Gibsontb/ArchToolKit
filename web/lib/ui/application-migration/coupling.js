/**
 * The workspace's Coupling tab (addendum A.2.9): the hidden coupling that
 * breaks moves — an IP in a config file, a hosts entry, a licence bound to a
 * MAC address, a certificate binding — turned into remediation actions.
 *
 * The coupling collectors' files (`archtoolkit.coupling`, values masked) are
 * read here for this app's servers; each reference is resolved (a server, an
 * app, a site, or external) and the rules give the action, its severity and,
 * where the server re-IPs, a blocker. The grid is
 * `Server | Category | Where | Value (masked) | Points to | Resolves to |
 * Action | Due | Status`, and the remediation checklist is worst first. The
 * app's external links (partners, SFTP, inbound APIs …) are listed from the
 * plan.
 *
 * The actions are held for this page session; the tracker's RAID issues are
 * created on Migration & Utilities, which owns the tracker.
 */

import { el, append, downloadFile, readFileAsText } from '../dom.js';
import { findingsList } from '../components.js';
                                                      
import { appWorkloads } from '../../multicloud/plan/apps/components.js';
import { importCoupling, resolveCoupling } from '../../multicloud/plan/coupling/import.js';
import { COUPLING_GRID_COLUMNS, couplingActions, couplingGrid, remediationByApp, remediationMarkdown,                     } from '../../multicloud/plan/coupling/rules.js';
import { EXTERNAL_KIND_OPTIONS, labelOf, slugName } from '../../multicloud/plan/options.js';
                                                           
import { button, buttonRow, chip, note, rowsTable, textInput,                         } from './kit.js';

                                                                                                          
const STATE = new Map                       ();

/** The coupling actions of one app, from the collector files' texts. */
export function appCouplingActions(plan      , appName        , texts                   , domains                   )                                                     {
  const imported = importCoupling([...texts], domains);
  const resolved = resolveCoupling(imported.refs, { workloads: plan.workloads, sites: plan.requirements.sites });
  const acts = couplingActions(resolved, { workloads: plan.workloads, domains });
  const mine = new Set(plan.workloads.filter((w) => w.app === appName).map((w) => w.name.toLowerCase()));
  return { actions: acts.actions.filter((a) => a.app === appName || mine.has(a.server.toLowerCase())), findings: [...imported.findings, ...acts.findings] };
}

const SEVERITY_TONE                                 = { blocker: 'danger', error: 'danger', warning: 'warn', info: 'neutral' };

function pickFiles()                  {
  return new Promise((resolve) => {
    const input = el('input', { attrs: { type: 'file', accept: '.json,application/json', multiple: true } })                    ;
    input.addEventListener('change', () => resolve(Array.from(input.files ?? [])));
    input.click();
  });
}

export function renderCoupling(view         )              {
  const { app } = view;
  const state = STATE.get(app.id) ?? { actions: [], findings: [], files: 0, domains: '' };
  const servers = appWorkloads(view.plan, app).filter((w) => !w.synthetic);
  const domains = textInput(state.domains, (v) => { STATE.set(app.id, { ...state, domains: v }); }, { placeholder: 'corp.example.com', label: 'Estate DNS suffixes', control: 'coupling-domains' });
  const importBtn = button('Read coupling files…', () => {
    void pickFiles().then(async (files) => {
      if (files.length === 0) return;
      const texts = await Promise.all(files.map(readFileAsText));
      const doms = (STATE.get(app.id)?.domains ?? state.domains).split(/[\s,]+/).filter(Boolean);
      const r = appCouplingActions(view.current(), app.name, texts, doms);
      STATE.set(app.id, { actions: r.actions, findings: r.findings, files: files.length, domains: doms.join(' ') });
      view.redraw();
    });
  }, { primary: true, control: 'coupling-import' });

  const checklist = remediationByApp(state.actions)[app.name] ?? [];
  const grid = couplingGrid(state.actions);
  const external = (view.plan.dcExit?.external ?? []).filter((x) => x.app === app.name);
  const root = el('div', {},
    el('section', { class: 'card', attrs: { 'data-control': 'coupling' } },
      el('div', { class: 'card-title' }, el('h2', { text: 'Coupling' })),
      note(`Hidden coupling of ${app.name}'s ${servers.length} server(s): read the files the coupling collectors wrote (download the collectors on Sources). Secrets are masked by the collectors and again on import; nothing secret is kept.`),
      el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)', alignItems: 'flex-end' } },
        el('label', { class: 'field', style: { flex: '1 1 14rem', margin: '0' } }, el('span', { class: 'small muted', text: 'Estate DNS suffixes (internal names)' }), domains),
        importBtn),
      state.files > 0 ? note(`${state.actions.length} action(s) from ${state.files} file(s), held for this session.`) : null,
      state.findings.length > 0 ? findingsList(state.findings) : null,
      rowsTable([...COUPLING_GRID_COLUMNS], grid.map((row, i) => {
        const a = state.actions[i] ;
        return [...row.slice(0, 6), el('span', {}, chip(a.severity, SEVERITY_TONE[a.severity] ?? 'neutral'), ` ${row[6]}`), row[7] ?? '', row[8] ?? ''];
      }), { control: 'coupling-grid', empty: 'No coupling read for this application yet.' })),
    el('section', { class: 'card', attrs: { 'data-control': 'coupling-checklist' } },
      el('div', { class: 'card-title' }, el('h2', { text: 'Remediation checklist' })),
      checklist.length === 0 ? note('No open coupling actions.') : el('ul', {}, ...checklist.map((c) => el('li', { class: 'small' }, chip(c.severity, SEVERITY_TONE[c.severity] ?? 'neutral'), ` ${c.server}: ${c.text} (${c.where}${c.due ? `; due ${c.due}` : ''})`))),
      buttonRow(
        button('Download the checklist', () => downloadFile(`${slugName(app.name) || 'app'}-coupling.md`, remediationMarkdown(app.name, checklist), 'text/markdown'), { control: 'coupling-download', disabled: checklist.length === 0 }),
        el('a', { class: 'btn', text: 'RAID on Migration & Utilities →', attrs: { href: 'multicloud.html#raid' } }))),
    el('section', { class: 'card' },
      el('div', { class: 'card-title' }, el('h2', { text: 'External links' })),
      note('Partners, SFTP, inbound APIs and user access paths that must be told about the move (entered on Migration & Utilities, Data centre).'),
      rowsTable(['Kind', 'Party', 'Direction', 'Protocol', 'Endpoint', 'Current IPs', 'Notice (days)'], external.map((x) => [
        labelOf(EXTERNAL_KIND_OPTIONS, x.kind), x.party, x.direction, x.protocol, x.endpoint, x.currentIps.join(', '), String(x.noticeDays),
      ]), { empty: 'No external links recorded for this application.' })));
  append(root);
  return root;
}
