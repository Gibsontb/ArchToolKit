/**
 * The Firewall & LB tab of the data-centre pane (addendum A.5.5.1): the
 * firewall and load-balancer configurations from the building (Cisco ASA /
 * FTD, PAN-OS, FortiOS, F5 BIG-IP, or the two CSVs) and, optionally, the
 * observed flows, translated to what they become in the target.
 *
 * The Generated rules view merges both sources and marks each rule `config`,
 * `flows` or `both`. Rules that cannot be classified (`any` to `any`, unknown
 * or unresolved endpoints) are listed for review, not translated; VIPs become
 * app ingress items; NAT becomes cloud NAT or public IPs and the partner
 * egress list. The Terraform is `netsec/<platform>.tf` per target platform.
 *
 * The configurations stay in this page: they are not written to the plan
 * (a firewall configuration is not something a plan file should carry).
 */

import { el, append, clear, downloadFile } from '../dom.js';
import { card, field, findingsList, select } from '../components.js';
import { pickFiles, dropZone } from '../multicloud/grid.js';
import { zip } from '../../kit/archive.js';
import { warning,              } from '../../core/findings.js';
import { serviceText,                   } from '../../multicloud/plan/netsec/model.js';
import {
  NETSEC_PARSERS, netsecContext, parseDeviceConfig, translateConfigs,
                                                                                            
} from '../../multicloud/plan/netsec/translate.js';
import { emitTerraform } from '../../multicloud/plan/netsec/emit.js';
import { importFlows,                 } from '../../multicloud/plan/discovery/flows.js';
import { PLATFORM_LABELS } from '../../multicloud/plan/options.js';
                                                                         

/* ------------------------------------------------------------ pure helpers --- */

/**
 * The parser a configuration file needs, from its content (and its name): the
 * page takes several files at once, so each is recognised rather than asked.
 */
export function guessParser(fileName        , text        )                {
  const head = text.slice(0, 20_000);
  const firstLine = (text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '').toLowerCase().replace(/\s/g, '');
  if (/^vip,port/.test(firstLine)) return 'vips-csv';
  if (/^name,src,dst/.test(firstLine) || /(^|,)src,dst(,|$)/.test(firstLine)) return 'csv';
  if (/^\s*config firewall (address|policy|addrgrp|service|vip)\b/m.test(head)) return 'fortios';
  if (/^set (rulebase|address|address-group|service|vsys|deviceconfig|network)\b/m.test(head)) return 'panos';
  if (/^\s*ltm (virtual|pool|monitor|node)\b/m.test(head) || /"class"\s*:\s*"(ADC|AS3)"/.test(head)) return 'f5';
  if (/^\s*(access-list \S+ extended|object-group network|object network|access-group)\b/m.test(head)) return 'cisco_asa';
  const n = fileName.toLowerCase();
  if (n.endsWith('.conf') && n.includes('bigip')) return 'f5';
  return null;
}

const endpointText = (e          )         => {
  switch (e.kind) {
    case 'tier':
      return `${e.app}/${e.component}`;
    case 'site':
      return `site ${e.site}`;
    case 'internet':
      return `internet ${e.cidrs.join(' ')}`;
    case 'any':
      return 'any';
    default:
      return e.written.join(' ');
  }
};

export const SCOPE_LABELS                                      = {
  'app-internal': 'Security group (inside the app)',
  'app-to-app': 'Security groups (app to app)',
  'cloud-firewall': 'Landing zone cloud firewall',
  'internet-ingress': 'App ingress + WAF',
  'on-premises': 'Stays on-premises',
  deny: 'Deny (information)',
  review: 'Review',
  disabled: 'Disabled',
};

/** A translated rule as the table's cells. */
export function ruleCells(r                )           {
  return [
    r.id,
    SCOPE_LABELS[r.scope],
    r.platform ? PLATFORM_LABELS[r.platform] : '',
    endpointText(r.from),
    endpointText(r.to),
    r.services.map(serviceText).join(' '),
    r.action,
    r.origin,
    r.sources.join('; '),
    r.why,
  ];
}

/** Counts per origin and per scope, for the summary line. */
export function translationSummary(t             )                                                                                                                                                                      {
  const origin                                 = { config: 0, flows: 0, both: 0 };
  for (const r of t.rules) origin[r.origin] += 1;
  const translated = t.rules.filter((r) => r.scope !== 'review' && r.scope !== 'disabled' && r.scope !== 'deny' && r.scope !== 'on-premises').length;
  return { origin, review: t.rules.filter((r) => r.scope === 'review').length, translated, ingress: t.ingress.length, nat: t.nat.length };
}

/* ------------------------------------------------------------------- view --- */

                        
                          
                            
                                
 

                                    
                            
                                                    
                               
 

const btn = (text        , control        , onClick            , extra = '')                    =>
  el('button', { class: `btn btn-small ${extra}`.trim(), text, attrs: { type: 'button', 'data-control': control }, on: { click: onClick } })                     ;

function simpleTable(headers                   , rows                                         , control        )              {
  const body = el('tbody');
  for (const r of rows) append(body, el('tr', {}, ...r.map((c) => el('td', {}, c))));
  return el('div', { class: 'table-wrap', attrs: { 'data-control': control } }, el('table', { class: 'data-table' }, el('thead', {}, el('tr', {}, ...headers.map((h) => el('th', { text: h })))), body));
}

const originBadge = (o                )              => el('span', { class: `badge ${o === 'both' ? 'good' : o === 'flows' ? 'warn' : ''}`.trim(), text: o, attrs: { 'data-origin': o } });

/** Mount the tab into `root`; returns a refresh to call when the plan changes. */
export function mountNetsecView(root             , options                   )             {
  const configs                 = [];
  let flows               = [];
  let flowNote = '';
  const messages            = [];
  let originFilter                      = '';
  let scopeFilter                 = '';

  // ---- input ---------------------------------------------------------------------
  const parserOptions = [{ value: 'auto', label: 'Recognise from the content' }, ...NETSEC_PARSERS.map((p) => ({ value: p.id, label: p.label }))];
  const parserSel = select(parserOptions, 'auto');
  parserSel.setAttribute('data-control', 'netsec-parser');
  const deviceIn = el('input', { attrs: { type: 'text', placeholder: 'edge-fw1', 'data-control': 'netsec-device' } })                    ;
  const paste = el('textarea', { class: 'mono', attrs: { rows: '6', spellcheck: 'false', placeholder: 'Paste a running configuration, a bigip.conf, AS3 JSON, firewall-rules.csv or vips.csv…', 'data-control': 'netsec-paste' }, style: { width: '100%' } })                       ;
  const listSlot = el('div', { attrs: { 'data-control': 'netsec-configs' } });
  const flowSlot = el('div', { class: 'small', attrs: { 'data-control': 'netsec-flows' } });
  const inputMsgs = el('div', { attrs: { role: 'status' } });
  const output = el('div', { class: 'stack' });

  const add = (name        , text        , chosen        )       => {
    const platform = chosen === 'auto' ? guessParser(name, text) : chosen;
    if (!platform) {
      messages.push(warning('netsec.unrecognised', `${name}: the format was not recognised; pick the platform and add it again.`));
      return;
    }
    const device = deviceIn.value.trim() || name.replace(/\.[a-z0-9]+$/i, '') || platform;
    const parsed = parseDeviceConfig(platform, text, device);
    if (!parsed) return;
    const at = configs.findIndex((c) => c.device === device);
    if (at >= 0) configs.splice(at, 1, { device, platform, parsed });
    else configs.push({ device, platform, parsed });
  };
  const addFiles = (files                                  )       => {
    messages.length = 0;
    for (const f of files) {
      if (/flow/i.test(f.name) && /source_?ip|srcaddr|src ip|sa,/i.test(f.text.slice(0, 400))) loadFlows(f.text, f.name);
      else add(f.name, f.text, parserSel.value);
    }
    deviceIn.value = '';
    refresh();
  };
  const loadFlows = (text        , name        )       => {
    const r = importFlows(text);
    flows = [...r.flows];
    flowNote = r.missing.length ? `${name}: no column for ${r.missing.join(', ')}.` : `${name}: ${r.flows.length} flow${r.flows.length === 1 ? '' : 's'}.`;
    messages.push(...r.findings);
  };

  const flowPaste = el('textarea', { class: 'mono', attrs: { rows: '3', spellcheck: 'false', placeholder: 'source_ip,dest_ip,dest_port,protocol,observations,first_seen,last_seen,bytes', 'data-control': 'netsec-flows-paste' }, style: { width: '100%' } })                       ;

  const inputCard = card(
    'Firewall and load-balancer configurations',
    el('p', { class: 'small muted', text: 'Add each device’s configuration: Cisco ASA / FTD (ASA syntax), PAN-OS (set format), FortiOS, F5 BIG-IP (bigip.conf or AS3), or firewall-rules.csv / vips.csv. Files can be dropped on this card. They are read in this page only and not saved in the plan.' }),
    el('div', { class: 'two' }, field('Platform', parserSel), field('Device name', deviceIn, 'Blank: the file name.')),
    paste,
    el('div', { class: 'btn-row', style: { marginTop: 'var(--space-2)' } },
      btn('Add pasted configuration', 'netsec-add', () => {
        if (!paste.value.trim()) return;
        messages.length = 0;
        add(deviceIn.value.trim() || 'pasted', paste.value, parserSel.value);
        paste.value = '';
        deviceIn.value = '';
        refresh();
      }, 'btn-primary'),
      btn('Upload files…', 'netsec-upload', () => void pickFiles('.txt,.cfg,.conf,.json,.csv,.set,.log', true).then(addFiles)),
    ),
    listSlot,
    el('h3', { text: 'Observed flows (optional)', style: { marginTop: 'var(--space-4)' } }),
    el('p', { class: 'small muted', text: 'flows.csv from VCF Operations for Networks, a NetFlow / IPFIX collector or the guest capture. With flows, each rule is marked config, flows or both; a config rule no flow used in 30 days is flagged unused (and kept), a flow no rule allows is flagged undocumented.' }),
    flowPaste,
    el('div', { class: 'btn-row', style: { marginTop: 'var(--space-2)' } },
      btn('Use pasted flows', 'netsec-flows-add', () => {
        if (!flowPaste.value.trim()) return;
        messages.length = 0;
        loadFlows(flowPaste.value, 'pasted flows');
        flowPaste.value = '';
        refresh();
      }),
      btn('Upload flows.csv…', 'netsec-flows-upload', () => void pickFiles('.csv,text/csv', false).then((fs) => {
        messages.length = 0;
        for (const f of fs) loadFlows(f.text, f.name);
        refresh();
      })),
      btn('Clear flows', 'netsec-flows-clear', () => {
        flows = [];
        flowNote = '';
        refresh();
      }),
    ),
    flowSlot,
    inputMsgs,
  );
  dropZone(inputCard, addFiles);
  append(root, inputCard, output);

  function renderInputs()       {
    clear(listSlot);
    if (configs.length === 0) append(listSlot, el('p', { class: 'small muted', text: 'No configuration added yet.' }));
    else {
      append(listSlot, simpleTable(
        ['Device', 'Platform', 'Rules', 'NAT', 'VIPs', ''],
        configs.map((c, i) => [
          c.device,
          NETSEC_PARSERS.find((p) => p.id === c.platform)?.label ?? c.platform,
          String(c.parsed.rules.length),
          String(c.parsed.nats.length),
          String(c.parsed.vips.length),
          btn('Remove', `netsec-remove-${i}`, () => {
            configs.splice(i, 1);
            refresh();
          }),
        ]),
        'netsec-config-list',
      ));
    }
    flowSlot.textContent = flowNote || (flows.length ? `${flows.length} flows.` : 'No flows loaded.');
    clear(inputMsgs);
    if (messages.length) append(inputMsgs, findingsList(messages));
  }

  function renderOutput()       {
    clear(output);
    if (configs.length === 0 && flows.length === 0) return;
    const plan = options.plan();
    const t = translateConfigs(configs.map((c) => c.parsed), netsecContext(plan, options.decision()), { flows, today: options.today() });
    const emitted = emitTerraform(t, { prefix: plan.name || 'mig' });
    const sum = translationSummary(t);

    // Generated rules.
    const originSel = select([{ value: '', label: 'Every origin' }, { value: 'config', label: 'config' }, { value: 'flows', label: 'flows' }, { value: 'both', label: 'both' }], originFilter);
    originSel.setAttribute('data-control', 'netsec-origin-filter');
    originSel.setAttribute('aria-label', 'Filter by origin');
    originSel.addEventListener('change', () => ((originFilter = originSel.value                       ), renderOutput()));
    const scopeSel = select([{ value: '', label: 'Every scope' }, ...Object.entries(SCOPE_LABELS).map(([value, label]) => ({ value, label }))], scopeFilter);
    scopeSel.setAttribute('data-control', 'netsec-scope-filter');
    scopeSel.setAttribute('aria-label', 'Filter by scope');
    scopeSel.addEventListener('change', () => ((scopeFilter = scopeSel.value                      ), renderOutput()));
    const shown = t.rules.filter((r) => (!originFilter || r.origin === originFilter) && (!scopeFilter || r.scope === scopeFilter));
    append(output, card(
      'Generated rules',
      el('p', { class: 'small', attrs: { 'data-control': 'netsec-summary' }, text: `${t.rules.length} rule${t.rules.length === 1 ? '' : 's'}: ${sum.translated} translated, ${sum.review} for review. Origin: ${sum.origin.config} config, ${sum.origin.flows} flows, ${sum.origin.both} both.` }),
      el('div', { class: 'filter-row' }, originSel, scopeSel),
      simpleTable(
        ['ID', 'Becomes', 'Platform', 'From', 'To', 'Services', 'Action', 'Origin', 'Source rules', 'Why'],
        shown.map((r) => {
          const cells                    = ruleCells(r);
          cells[7] = originBadge(r.origin);
          return cells;
        }),
        'netsec-rules',
      ),
    ));

    // Review list.
    const review = t.rules.filter((r) => r.scope === 'review');
    append(output, card(
      'For review (not translated)',
      el('p', { class: 'small muted', text: '“any” to “any”, endpoints that are not a known server, site or public address, FQDN objects and unresolved names are listed here, never guessed.' }),
      review.length
        ? simpleTable(['ID', 'From', 'To', 'Services', 'Source rules', 'Why'], review.map((r) => [r.id, r.from.written.join(' '), r.to.written.join(' '), r.services.map(serviceText).join(' '), r.sources.join('; '), r.why]), 'netsec-review')
        : el('p', { class: 'small', text: 'Nothing to review.' }),
    ));

    // Ingress.
    append(output, card(
      'Ingress items (from the VIPs)',
      t.ingress.length
        ? simpleTable(
          ['VIP', 'App', 'Platform', 'Blueprint', 'Listener', 'Members', 'Health check', 'Persistence', 'Exposure', 'LB', 'WAF'],
          t.ingress.map((i) => [
            i.name, i.app ?? '—', i.platform ? PLATFORM_LABELS[i.platform] : '—', i.blueprint ?? '—', `${i.listener.protocol}/${i.listener.port}`,
            i.members.map((m) => `${m.server ?? m.address}:${m.port}`).join(' '), `${i.healthCheck.kind}${i.healthCheck.path ? ` ${i.healthCheck.path}` : ''} :${i.healthCheck.port}`,
            i.persistence, i.ingress.exposure, i.ingress.lb, i.ingress.waf ? 'yes' : 'no',
          ]),
          'netsec-ingress',
        )
        : el('p', { class: 'small', text: 'No VIPs in the configurations.' }),
    ));

    // NAT and egress.
    if (t.nat.length || t.egress.length) {
      append(output, card(
        'NAT and partner egress',
        t.nat.length ? simpleTable(['NAT', 'Kind', 'Inside', 'Outside', 'Becomes', 'Platform'], t.nat.map((n) => [n.nat.name, n.nat.kind, n.nat.real.join(' '), n.nat.mapped.join(' '), n.becomes, n.platform ? PLATFORM_LABELS[n.platform] : '—']), 'netsec-nat') : null,
        t.egress.length ? simpleTable(['Egress address today', 'Inside', 'Apps', 'Notify'], t.egress.map((e) => [e.current, e.inside.join(' '), e.apps.join(' '), e.notices.join(' ') || '—']), 'netsec-egress') : null,
      ));
    }

    // Terraform.
    const files = emitted.files;
    append(output, card(
      'Terraform',
      el('p', { class: 'small muted', text: emitted.platforms.length ? `One file per target platform: ${emitted.platforms.map((p) => `${p.path} (${p.types.length} resource types)`).join(', ')}. Ids come in as variables; nothing is applied from here.` : 'No rule lands on a target platform yet: each needs its servers decided onto a platform.' }),
      el('div', { class: 'btn-row' },
        ...emitted.platforms.map((p) => btn(`Download netsec-${p.platform}.tf`, `netsec-tf-${p.platform}`, () => downloadFile(`netsec-${p.platform}.tf`, p.text, 'text/plain'))),
        btn('Download netsec.zip', 'netsec-zip', () => void zip(files, new Date(Date.UTC(2000, 0, 1))).then((bytes) => downloadFile('netsec.zip', bytes, 'application/zip')), 'btn-primary'),
        btn('rules.csv', 'netsec-rules-csv', () => downloadFile('rules.csv', files['netsec/rules.csv'] ?? '', 'text/csv')),
        btn('review.csv', 'netsec-review-csv', () => downloadFile('review.csv', files['netsec/review.csv'] ?? '', 'text/csv')),
      ),
    ));

    append(output, card('Translation checks', findingsList([...t.findings, ...emitted.findings], 'No issues found.')));
  }

  function refresh()       {
    renderInputs();
    renderOutput();
  }
  refresh();
  return refresh;
}
