/**
 * Constraints (`#constraints`, also `#requirements`) on Application
 * Migration: base Screen 5's cards (addendum A.1.2) — Platforms (allowed
 * platforms, how many, regions, the deadline and the application plans'
 * landing-zone mode), Compliance & sovereignty (frameworks, sovereignty,
 * default residency, baseline, keys), Commercial & licensing (cost model,
 * commitments, Microsoft, Oracle, VCF and Linux licences), Operating model &
 * exit (skills, exit strategy, sizing, monitoring, SIEM) and Resilience
 * (backup tiers, DR pattern per criticality).
 *
 * Connectivity (the on-premises sites) and Identity are estate foundations
 * and live on Multi-Cloud Migration & Utilities → Landing zones; their cards
 * are exported here as `mountConnectivity` and `mountIdentity` so that pane
 * mounts the same controls over the same plan fields.
 *
 * Every control is a dropdown or a checklist where the set is closed; every
 * change goes through `ctx.session.update`.
 */

import { el, append, clear } from '../dom.js';
import { card, checkbox, field, findingsList, select } from '../components.js';
import { tableEditor } from '../multi-editors.js';
                                                    
import {
  AD_STRATEGY_OPTIONS, BACKUP_TIER_BY_CRITICALITY, CLOUD_SIGN_IN_OPTIONS, CONNECTION_OPTIONS, COST_MODEL_OPTIONS,
  CRITICALITY_OPTIONS, DNS_STRATEGY_OPTIONS, DR_PATTERN_OPTIONS, EXIT_STRATEGY_OPTIONS, FRAMEWORK_OPTIONS,
  KEY_MANAGEMENT_OPTIONS, LANDING_ZONE_MODE_OPTIONS, LINUX_JOIN_OPTIONS, MAX_PLATFORMS_OPTIONS, MICROSOFT_SA_OPTIONS,
  MONITORING_OPTIONS, ORACLE_LICENCES_OPTIONS, PLATFORM_OPTIONS, PLATFORM_VALUES, RESIDENCY_OPTIONS,
  SECURITY_BASELINE_OPTIONS, SIEM_OPTIONS, SIZE_BY_OPTIONS, SOVEREIGNTY_OPTIONS, YES_NO_OPTIONS, defaultConnection, labelOf,
} from '../../multicloud/plan/options.js';
                                                                                                                         
import {
  BACKUP_TIER_GRID, BLANK_BACKUP_TIER, BLANK_COMMITMENT, BLANK_SITE, BLANK_SKILL, COMMITMENT_GRID, SITE_GRID, SKILL_GRID,
  listFromGrid, listToGrid,                                
} from './grid-model.js';
import { connectivityFindings, constraintFindings, landingZoneState, regionChoices, setLandingZone } from './constraints-model.js';

                                      

const note = (text        ) => el('p', { class: 'small muted', text });

/** Guards a card's own writes, so its session listener does not rebuild it under the cursor. */
                  
                
 

function updateReq(session         , w        , change                                   )       {
  w.busy = true;
  try {
    session.update((p) => ({ ...p, requirements: change(p.requirements) }));
  } finally {
    w.busy = false;
  }
}

/** A select bound to one requirements value. */
function boundSelect                  (
  session         , w        , options                                        , get                        , set                                         , control        ,
)                    {
  const s = select(options, get(session.plan().requirements));
  s.setAttribute('data-control', control);
  s.addEventListener('change', () => updateReq(session, w, (r) => set(r, s.value     )));
  return s;
}

const yes = (b         )               => (b ? 'yes' : 'no');

/** A list grid bound to one requirements list (read whole on every change). */
function boundGrid   (
  session         , w        , columns                          , blank   , get                                   , set                                              ,
  control        , onProblems                             ,
)              {
  const editor = tableEditor(
    { separator: ' | ', columns: columns.map((c) => c.label), headerInValue: false, spaced: true, choices: columns.map((c) => c.options) },
    listToGrid(get(session.plan().requirements), columns),
    () => {
      const hidden = editor.querySelector                     ('textarea.multi-value');
      const { rows, errors } = listFromGrid(hidden?.value ?? '', columns, blank);
      updateReq(session, w, (r) => set(r, rows));
      onProblems?.(errors);
    },
  );
  editor.setAttribute('data-control', control);
  return el('div', { style: { maxWidth: '100%', overflowX: 'auto' } }, editor);
}

/** A card that rebuilds itself when the plan changes elsewhere (not for its own edits). */
function liveCard(root             , session         , build                                        )       {
  const body = el('div');
  const w         = { busy: false };
  append(root, body);
  const rebuild = () => {
    clear(body);
    build(body, w);
  };
  rebuild();
  session.subscribe((_plan, kind) => {
    if (kind === 'saved' || w.busy) return;
    if (kind === 'edit' && body.contains(document.activeElement)) return;
    rebuild();
  });
}

// ---------------------------------------------------------------------------
// Connectivity and Identity (reused by Landing zones)
// ---------------------------------------------------------------------------

/**
 * The Connectivity card: the on-premises sites grid (the VPN peer and the
 * CIDRs take IPv4 or IPv6) and the connection to each target.
 */
export function mountConnectivity(root             , ctx                              )       {
  const session = ctx.session;
  liveCard(root, session, (body, w) => {
    const checks = el('div');
    const errors = el('div');
    const showChecks = (problems           = []) => {
      clear(errors);
      if (problems.length > 0) append(errors, el('ul', { class: 'small' }, ...problems.map((p) => el('li', { text: p }))));
      clear(checks);
      append(checks, findingsList(connectivityFindings(session.plan().requirements), 'The sites read cleanly.'));
    };
    const r = session.plan().requirements;
    const conn = boundSelect(session, w, CONNECTION_OPTIONS, (x) => x.connection, (x, v) => ({ ...x, connection: v }), 'connection');
    conn.addEventListener('change', () => showChecks());
    append(body, card('Hybrid connectivity',
      note('The on-premises sites the landing zones connect to. The VPN peer may be IPv4 or IPv6; list the CIDRs of both families, space separated.'),
      boundGrid(session, w, SITE_GRID, BLANK_SITE, (x) => x.sites, (x, rows) => ({ ...x, sites: rows }), 'sites-grid', (e) => showChecks(e)),
      errors,
      el('div', { class: 'field-grid' },
        field('Connection to each target', conn, `Suggested: ${labelOf(CONNECTION_OPTIONS, defaultConnection(r.sites))}.`)),
      checks));
    showChecks();
  });
}

/** The Identity card: AD strategy, domain, OU, Linux join, cloud sign-in, DNS. */
export function mountIdentity(root             , ctx                              )       {
  const session = ctx.session;
  liveCard(root, session, (body, w) => {
    const id = session.plan().requirements.identity;
    const setId = (patch                                   ) => updateReq(session, w, (r) => ({ ...r, identity: { ...r.identity, ...patch } }));
    const text = (value                    , control        , onInput                     , placeholder        ) => {
      const i = el('input', { attrs: { type: 'text', placeholder, 'data-control': control } })                    ;
      i.value = value ?? '';
      i.addEventListener('input', () => onInput(i.value.trim()));
      return i;
    };
    append(body, card('Identity',
      note('How servers join a directory in the targets, and how people sign in to the clouds. Managed AD is not offered on OCI: extend-dcs is used there.'),
      el('div', { class: 'field-grid' },
        field('AD strategy', boundSelect(session, w, AD_STRATEGY_OPTIONS, (r) => r.identity.adStrategy, (r, v) => ({ ...r, identity: { ...r.identity, adStrategy: v } }), 'ad-strategy')),
        field('AD domain (FQDN)', text(id.domain, 'ad-domain', (v) => setId({ domain: v || undefined }), 'corp.example.com')),
        field('Computer OU (DN)', text(id.computerOu, 'ad-ou', (v) => setId({ computerOu: v || undefined }), 'OU=Servers,DC=corp,DC=example,DC=com')),
        field('Linux joins AD', boundSelect(session, w, LINUX_JOIN_OPTIONS, (r) => r.identity.linuxJoin, (r, v) => ({ ...r, identity: { ...r.identity, linuxJoin: v } }), 'linux-join')),
        field('Cloud sign-in', boundSelect(session, w, CLOUD_SIGN_IN_OPTIONS, (r) => r.identity.cloudSignIn, (r, v) => ({ ...r, identity: { ...r.identity, cloudSignIn: v } }), 'cloud-sign-in')),
        field('DNS', boundSelect(session, w, DNS_STRATEGY_OPTIONS, (r) => r.identity.dns, (r, v) => ({ ...r, identity: { ...r.identity, dns: v } }), 'dns-strategy')))));
  });
}

// ---------------------------------------------------------------------------
// The Constraints pane
// ---------------------------------------------------------------------------

export function mount(root             , ctx             )       {
  const session = ctx.session;
  const checks = el('div');
  const renderChecks = () => {
    clear(checks);
    append(checks, findingsList(constraintFindings(session.plan()), 'The constraints are consistent.'));
  };

  // ---- Platforms ---------------------------------------------------------------
  liveCard(root, session, (body, w) => {
    const r = session.plan().requirements;
    const allowed = el('div', { class: 'checkbox-grid', attrs: { 'data-control': 'allowed-platforms' } });
    for (const o of PLATFORM_OPTIONS) {
      const c = checkbox(o.label, r.allowed.includes(o.value));
      c.input.addEventListener('change', () => updateReq(session, w, (x) => ({
        ...x,
        allowed: PLATFORM_VALUES.filter((p) => (p === o.value ? c.input.checked : x.allowed.includes(p))),
      })));
      c.input.addEventListener('change', () => renderRegions());
      append(allowed, c.wrap);
    }
    const regions = el('div', { class: 'stack' });
    const regionRow = (p          ) => {
      const cur = session.plan().requirements.regions[p];
      const setRegion = (patch                                   ) => updateReq(session, w, (x) => {
        const prev = x.regions[p] ?? { primary: '' };
        const next = { ...prev, ...patch };
        if (!next.dr) delete (next                   ).dr;
        return { ...x, regions: { ...x.regions, [p]: next } };
      });
      if (p === 'vmware') {
        const primary = el('input', { attrs: { type: 'text', placeholder: 'vcenter.example.com', 'data-control': 'region-vmware' } })                    ;
        primary.value = cur?.primary ?? '';
        primary.addEventListener('input', () => setRegion({ primary: primary.value.trim() }));
        const dr = el('input', { attrs: { type: 'text', placeholder: 'DR vCenter (optional)' } })                    ;
        dr.value = cur?.dr ?? '';
        dr.addEventListener('input', () => setRegion({ dr: dr.value.trim() }));
        return el('div', { class: 'field-grid' }, field(`${labelOf(PLATFORM_OPTIONS, p)}: vCenter (FQDN)`, primary), field('DR vCenter', dr));
      }
      const primary = select(regionChoices(p, cur?.primary, '(choose)'), cur?.primary ?? '');
      primary.setAttribute('data-control', `region-${p}`);
      primary.addEventListener('change', () => setRegion({ primary: primary.value }));
      const dr = select(regionChoices(p, cur?.dr, 'No DR region'), cur?.dr ?? '');
      dr.addEventListener('change', () => setRegion({ dr: dr.value }));
      return el('div', { class: 'field-grid' }, field(`${labelOf(PLATFORM_OPTIONS, p)}: primary region`, primary), field('DR region', dr));
    };
    const renderRegions = () => {
      clear(regions);
      for (const p of session.plan().requirements.allowed) append(regions, regionRow(p));
    };
    renderRegions();

    const timeline = el('input', { attrs: { type: 'number', min: '1', step: '1', 'data-control': 'timeline-months' } })                    ;
    timeline.value = String(r.timelineMonths);
    timeline.addEventListener('input', () => {
      const n = Number(timeline.value);
      if (Number.isInteger(n) && n > 0) updateReq(session, w, (x) => ({ ...x, timelineMonths: n }));
    });

    const lzState = landingZoneState(session.plan());
    const lz = select([
      ...(lzState === 'mixed' ? [{ value: 'mixed', label: 'Mixed (set per application)' }] : []),
      ...(lzState === 'none' ? [{ value: 'none', label: 'No application plans yet' }] : []),
      ...LANDING_ZONE_MODE_OPTIONS,
    ], lzState);
    lz.setAttribute('data-control', 'landing-zone-mode');
    lz.disabled = lzState === 'none';
    lz.addEventListener('change', () => {
      if (lz.value !== 'shared' && lz.value !== 'included') return;
      const mode = lz.value                   ;
      w.busy = true;
      try {
        session.update((p) => setLandingZone(p, mode));
      } finally {
        w.busy = false;
      }
    });

    append(body, card('Platforms',
      el('div', { class: 'field' }, el('label', { text: 'Allowed platforms' }), allowed),
      el('div', { class: 'field-grid' },
        field('Most platforms in the result', boundSelect(session, w, MAX_PLATFORMS_OPTIONS, (x) => String(x.maxPlatforms)                     , (x, v) => ({ ...x, maxPlatforms: Number(v)                 }), 'max-platforms')),
        field('Deadline: months until the source must be empty', timeline),
        field('Landing zone for the application plans', lz, 'Shared: the landing zone is designed once on Migration & Utilities. Included: each app’s project brings its own. Changing it sets every application plan.')),
      regions));
  });

  // ---- Compliance & sovereignty ----------------------------------------------------
  liveCard(root, session, (body, w) => {
    const r = session.plan().requirements;
    const frameworks = el('div', { class: 'checkbox-grid', attrs: { 'data-control': 'frameworks' } });
    for (const o of FRAMEWORK_OPTIONS) {
      const c = checkbox(o.label, r.frameworks.includes(o.value));
      c.input.addEventListener('change', () => updateReq(session, w, (x) => ({
        ...x,
        frameworks: FRAMEWORK_OPTIONS.map((f) => f.value).filter((f) => (f === o.value ? c.input.checked : x.frameworks.includes(f))),
      })));
      append(frameworks, c.wrap);
    }
    append(body, card('Compliance & sovereignty',
      el('div', { class: 'field' }, el('label', { text: 'Frameworks' }), frameworks),
      el('div', { class: 'field-grid' },
        field('Sovereignty', boundSelect(session, w, SOVEREIGNTY_OPTIONS, (x) => x.sovereignty, (x, v) => ({ ...x, sovereignty: v }), 'sovereignty')),
        field('Default residency', boundSelect(session, w, RESIDENCY_OPTIONS, (x) => x.defaultResidency, (x, v) => ({ ...x, defaultResidency: v }), 'default-residency'), 'For servers and apps that do not set their own.'),
        field('Security baseline', boundSelect(session, w, SECURITY_BASELINE_OPTIONS, (x) => x.securityBaseline, (x, v) => ({ ...x, securityBaseline: v }), 'security-baseline')),
        field('Encryption keys', boundSelect(session, w, KEY_MANAGEMENT_OPTIONS, (x) => x.keys, (x, v) => ({ ...x, keys: v }), 'keys')))));
  });

  // ---- Commercial & licensing ------------------------------------------------------
  liveCard(root, session, (body, w) => {
    const errs = el('div');
    const lic = (key                                 , label        , control        , hint         ) => field(label, boundSelect(
      session, w, YES_NO_OPTIONS, (x) => yes(Boolean(x.licensing[key])), (x, v) => ({ ...x, licensing: { ...x.licensing, [key]: v === 'yes' } }), control,
    ), hint);
    append(body, card('Commercial & licensing',
      el('div', { class: 'field-grid' },
        field('Cost model', boundSelect(session, w, COST_MODEL_OPTIONS, (x) => x.costModel, (x, v) => ({ ...x, costModel: v }), 'cost-model')),
        field('Microsoft Software Assurance', boundSelect(session, w, MICROSOFT_SA_OPTIONS, (x) => x.licensing.microsoftSa, (x, v) => ({ ...x, licensing: { ...x.licensing, microsoftSa: v } }), 'microsoft-sa')),
        lic('windowsPre2019Licences', 'Windows licences bought before 2019-10-01', 'windows-pre-2019', 'For dedicated hosts.'),
        field('Oracle licences', boundSelect(session, w, ORACLE_LICENCES_OPTIONS, (x) => x.licensing.oracle, (x, v) => ({ ...x, licensing: { ...x.licensing, oracle: v } }), 'oracle-licences')),
        lic('oracleSupportRewards', 'Oracle Support Rewards wanted', 'oracle-support-rewards'),
        lic('portableVcf', 'Portable VCF subscription', 'portable-vcf'),
        lic('linuxBring', 'RHEL / SLES subscriptions portable (Cloud Access / BYOS)', 'linux-bring')),
      el('div', { class: 'field' }, el('label', { text: 'Commitments' }),
        boundGrid(session, w, COMMITMENT_GRID, BLANK_COMMITMENT, (x) => x.commitments, (x, rows) => ({ ...x, commitments: rows }), 'commitments-grid', (e) => {
          clear(errs);
          if (e.length > 0) append(errs, el('ul', { class: 'small' }, ...e.map((m) => el('li', { text: m }))));
        })),
      errs));
  });

  // ---- Operating model & exit --------------------------------------------------------
  liveCard(root, session, (body, w) => {
    const skillRows = (r              )             => PLATFORM_VALUES.filter((p) => r.skills[p] !== undefined).map((p) => ({ platform: p, skill: r.skills[p]  }));
    append(body, card('Operating model & exit',
      el('div', { class: 'field-grid' },
        field('Exit strategy', boundSelect(session, w, EXIT_STRATEGY_OPTIONS, (x) => x.exit, (x, v) => ({ ...x, exit: v }), 'exit-strategy')),
        field('Size compute by', boundSelect(session, w, SIZE_BY_OPTIONS, (x) => x.sizeBy, (x, v) => ({ ...x, sizeBy: v }), 'size-by'), 'Applies to servers whose basis is allocated.'),
        field('Monitoring', boundSelect(session, w, MONITORING_OPTIONS, (x) => x.monitoring, (x, v) => ({ ...x, monitoring: v }), 'monitoring')),
        field('SIEM', boundSelect(session, w, SIEM_OPTIONS, (x) => x.siem, (x, v) => ({ ...x, siem: v }), 'siem'))),
      el('div', { class: 'field' }, el('label', { text: 'Skills per platform' }),
        boundGrid(session, w, SKILL_GRID, BLANK_SKILL, skillRows, (x, rows) => ({ ...x, skills: Object.fromEntries(rows.map((s) => [s.platform, s.skill])) }), 'skills-grid'))));
  });

  // ---- Resilience ----------------------------------------------------------------------
  liveCard(root, session, (body, w) => {
    const drRow = el('div', { class: 'field-grid' });
    for (const c of CRITICALITY_OPTIONS) {
      const crit = c.value               ;
      append(drRow, field(`DR pattern: ${c.label}`, boundSelect(session, w, DR_PATTERN_OPTIONS, (x) => x.drPattern[crit], (x, v) => ({ ...x, drPattern: { ...x.drPattern, [crit]: v } }), `dr-${crit}`)));
    }
    append(body, card('Resilience',
      el('div', { class: 'field' }, el('label', { text: 'Backup tiers' }),
        boundGrid(session, w, BACKUP_TIER_GRID, BLANK_BACKUP_TIER, (x) => x.backupTiers, (x, rows) => ({ ...x, backupTiers: rows }), 'backup-tiers-grid')),
      el('p', { class: 'small muted', text: `Tier by criticality: ${CRITICALITY_OPTIONS.map((c) => `${c.label} → ${BACKUP_TIER_BY_CRITICALITY[c.value               ]}`).join(' · ')}.` }),
      drRow));
  });

  append(root,
    card('Connectivity and identity',
      el('p', { class: 'small' }, 'The on-premises sites, the connection to each cloud and the directory are estate foundations: they are set on ',
        el('a', { text: 'Migration & Utilities → Landing zones', attrs: { href: 'multicloud.html#landing-zones' } }), '.')),
    card('Checks', checks));
  renderChecks();
  session.subscribe((_p, kind) => {
    if (kind !== 'saved') renderChecks();
  });
}

