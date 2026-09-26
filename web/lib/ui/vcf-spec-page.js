/**
 * VCF 9.1 specification builder page.
 *
 * Left: the deployment plan. Right: the generated SddcSpec, the validation
 * findings, and an import panel for checking a spec produced elsewhere — which
 * is how a 9.0-shaped document from another tool gets caught before it reaches
 * an installer.
 *
 * Every control is registered by name and read into a flat record of values;
 * turning that record into a DeploymentPlan is vcf-spec-plan.ts's job, so the
 * whole assembly is testable without a DOM. The deployment scenario decides
 * which blocks show: a block the scenario has no use for is hidden, and the
 * plan assembly ignores it as well, so a hidden field can never leak into the
 * document.
 */

import { el, append, replace, downloadFile, readFileAsText } from './dom.js';
import { fileBar } from './file-bar.js';
import { envelope, openEnvelope, SETTINGS_KINDS, stripSecrets } from '../kit/settings-file.js';
import { isRecord,           } from '../editor/doc.js';
import {
  card,
  field,
  findingsList,
  numberInput,
  select,
  checkbox,
  stat,
  statGrid,
} from './components.js';
import { tableEditor } from './multi-editors.js';
import { countBySeverity, hasErrors,              } from '../core/findings.js';
import {
  buildSddcSpec,
  serializeSpec,
  redactSpec,
                      
                  
                 
} from '../vcf/spec-builder.js';
import { validateSddcSpec, validateSddcSpecJson } from '../vcf/spec-validate.js';
import {
  COLLECTOR_SIZES,
  DOCUMENTED_SIZES,
  HOST_SWITCH_MODES,
  IP_ASSIGNMENT_MODES,
  LACP_MODES,
  LACP_TIMEOUT_MODES,
  LAG_LOAD_BALANCING_MODES,
  NETWORK_TEAMING_POLICIES,
  NSX_TEAMING_POLICIES,
  VCENTER_STORAGE_SIZES,
} from '../vcf/spec-validate.js';
import { SCENARIO_RULES, scenarioRule,                         } from '../vcf/scenarios.js';
import { putHandoff, takeHandoff, unappliedLatest, markApplied, wasApplied } from './handoff.js';
import { mountEstateBar } from './estate-bar.js';
import { sourceClusters, commonHostProfile, planEstate, suggestManagementSource } from '../vcf/estate-plan.js';
import { sizeDeployment } from '../vcf/sizing.js';
import { sizingToPlan, describeSizingHandoff, estateToPlan } from '../vcf/bridge.js';
import {
  MANAGEMENT_NETWORK_MODELS,
  managementNetworkModel,
                              
} from '../vcf/management-network.js';
import { SDDC_SPEC_TOP_LEVEL_KEYS,               } from '../vcf/spec-types.js';
import { EVC_MODES } from '../vcf/spec-types.js';
                                                                           
import {
  INTERNAL_CLUSTER_CIDRS_V4,
  INTERNAL_CLUSTER_CIDRS_V6,
} from '../vcf/sizing-data.js';
import {
  ADVANCED_NETWORKS,
  DVS_SWITCH_GRID,
  EXISTING_COMPONENTS,
  FORM_DEFAULTS,
  FQDN_OVERRIDES,
  IP_POOLS,
  PASSWORDS,
  RESOURCE_POOL_GRID,
  ROOT_CA_GRID,
  SERVICE_SPECS,
  SIZE_PRESET_OPTIONS,
  VERSIONED_COMPONENTS,
  generatedFqdn,
  isSecretControl,
  migrateFields,
  planFromForm,
  scenarioView,
  specSummary,
                
} from './vcf-spec-plan.js';

/** Every value-holding control on the page. */
                                                                          

                
                                
                                
                                                                    
                                             
                                                                             
                                               
                                                  
                                              
                                               
                                                      
 

const STORAGE_OPTIONS = [
  { value: 'vsan-esa', label: 'vSAN ESA' },
  { value: 'vsan-osa', label: 'vSAN OSA' },
  { value: 'nfs', label: 'NFS v3' },
  { value: 'vmfs-fc', label: 'VMFS on FC' },
]         ;

const DVS_OPTIONS                                         = [
  { value: 'default', label: 'Default (1 switch)' },
  { value: 'storage-separation', label: 'Storage separation (2)' },
  { value: 'nsx-separation', label: 'NSX separation (2)' },
  { value: 'storage-and-nsx-separation', label: 'Storage + NSX separation (3)' },
  { value: 'custom', label: 'Custom switch configuration' },
];

const VCENTER_SIZES                                                 = [
  { value: '', label: 'From the preset (else Small)' },
  { value: 'tiny', label: 'Tiny' },
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
  { value: 'xlarge', label: 'X-Large' },
];

const NSX_SIZES                                                   = [
  { value: '', label: 'From the preset (else Medium)' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
  { value: 'xlarge', label: 'X-Large' },
];

/** The passwords the installer generates when left blank, and the ones that stay required. */
const AUTO_PASSWORDS_NOTE =
  'Generated by the installer when blank: vCenter root and SSO administrator, NSX root, admin and audit, SDDC Manager root, vcf and local administrator, the VCF management services system user, the VCF Operations admin and the VCF Automation admin. ' +
  'Still required: the ESX root password, the VCF Operations node and cloud proxy root passwords, and every password of a component that already exists (the existing vCenter, NSX, SDDC Manager, and the fleet’s VCF Operations admin on a new instance).';

function textInput(value        , placeholder = '')                   {
  return el('input', {
    attrs: { type: 'text', value, ...(placeholder ? { placeholder } : {}) },
  })                    ;
}

/**
 * Per-host detail editor.
 *
 * The installer takes four fields per host and nothing more, but every one of
 * them is per-host: real estates are not sequentially named, and each host has
 * its own credentials and thumbprints. Generating esx01..esxNN and offering no
 * way to edit them is not usable for anything but a lab.
 */
class HostTable {
           element             ;
          rows              = [];
                   body             ;
                   summary             ;
  // Declared explicitly rather than as constructor parameter properties, which
  // are not erasable syntax and so cannot be type-stripped by the build.
                   onChange            ;
                   getDefaults                                       ;

  constructor(onChange            , getDefaults                                       ) {
    this.onChange = onChange;
    this.getDefaults = getDefaults;
    this.body = el('tbody');
    this.summary = el('div', { class: 'field-hint' });

    const regenerate = el('button', {
      class: 'btn',
      text: 'Regenerate from name base',
      attrs: { type: 'button' },
      on: { click: () => this.seed(true) },
    });

    const addRow = el('button', {
      class: 'btn',
      text: 'Add host',
      attrs: { type: 'button' },
      on: {
        click: () => {
          const { base } = this.getDefaults();
          this.rows.push({ hostname: `${base}${String(this.rows.length + 1).padStart(2, '0')}` });
          this.render();
          this.onChange();
        },
      },
    });

    this.element = el(
      'section',
      { class: 'card' },
      el(
        'div',
        { class: 'card-title' },
        el('h2', { text: 'ESX hosts' }),
        el('div', { class: 'btn-row' }, addRow, regenerate),
      ),
      el('p', {
        class: 'muted small',
        text: 'Short names only — the DNS subdomain is appended automatically. Thumbprints are optional; without them the spec must skip thumbprint validation.',
      }),
      el(
        'div',
        { class: 'table-wrap', style: { marginTop: 'var(--space-3)' } },
        el(
          'table',
          {},
          el(
            'thead',
            {},
            el(
              'tr',
              {},
              el('th', { text: '#' }),
              el('th', { text: 'Hostname' }),
              el('th', { text: 'Root password' }),
              el('th', { text: 'SSH thumbprint' }),
              el('th', { text: 'SSL thumbprint' }),
              el('th', { text: '' }),
            ),
          ),
          this.body,
        ),
      ),
      this.summary,
    );

    // Do not notify: the owning const is not yet assigned at this point.
    this.seed(true, false);
  }

  /**
   * Rebuild the list from the name base and count.
   *
   * `notify` is false during construction: the owner holds this instance in a
   * `const` that is still in its temporal dead zone, so calling back into the
   * page's render at that point throws. The owner renders once itself after
   * construction instead.
   */
  seed(force = false, notify = true)       {
    const { base, count } = this.getDefaults();

    if (force) {
      this.rows = Array.from({ length: count }, (_, i) => ({
        hostname: `${base}${String(i + 1).padStart(2, '0')}`,
      }));
    } else {
      // Grow or shrink to match the count, preserving anything already typed.
      while (this.rows.length < count) {
        this.rows.push({
          hostname: `${base}${String(this.rows.length + 1).padStart(2, '0')}`,
        });
      }
      if (this.rows.length > count) this.rows.length = count;
    }

    this.render();
    if (notify) this.onChange();
  }

  /** Match the row count to the host-count field without discarding edits. */
  syncCount()       {
    const { count } = this.getDefaults();
    if (count !== this.rows.length) this.seed(false);
  }

  /** Replace the rows with known hosts — the cluster being converged. */
  load(rows                      )       {
    this.rows = rows.map((r) => ({ ...r }));
    this.render();
  }

  get entries()              {
    return this.rows.filter((row) => row.hostname.trim().length > 0);
  }

          render()       {
    replace(this.body);

    this.rows.forEach((row, index) => {
      const cell = (
        value        ,
        placeholder        ,
        apply                        ,
        type = 'text',
      )              => {
        const input = el('input', {
          attrs: { type, value, placeholder },
          style: { fontSize: '0.82rem', padding: '0.3rem 0.45rem' },
        })                    ;
        input.addEventListener('input', () => {
          apply(input.value);
          this.updateSummary();
          this.onChange();
        });
        return el('td', {}, input);
      };

      const remove = el('button', {
        class: 'btn',
        text: '✕',
        attrs: { type: 'button', title: 'Remove this host' },
        style: { padding: '0.2rem 0.5rem' },
        on: {
          click: () => {
            this.rows.splice(index, 1);
            this.render();
            this.onChange();
          },
        },
      });

      append(
        this.body,
        el(
          'tr',
          {},
          el('td', { class: 'num muted', text: String(index + 1) }),
          cell(row.hostname, 'esx01', (next) => {
            this.rows[index] = { ...(this.rows[index]             ), hostname: next };
          }),
          cell(
            row.password ?? '',
            'inherit',
            (next) => {
              this.rows[index] = {
                ...(this.rows[index]             ),
                password: next || undefined,
              };
            },
            'password',
          ),
          cell(row.sshThumbprint ?? '', 'SHA256:...', (next) => {
            this.rows[index] = {
              ...(this.rows[index]             ),
              sshThumbprint: next || undefined,
            };
          }),
          cell(row.sslThumbprint ?? '', 'AA:BB:CC:...', (next) => {
            this.rows[index] = {
              ...(this.rows[index]             ),
              sslThumbprint: next || undefined,
            };
          }),
          el('td', {}, remove),
        ),
      );
    });

    this.updateSummary();
  }

          updateSummary()       {
    const total = this.rows.length;
    const withThumbprints = this.rows.filter((r) => r.sslThumbprint || r.sshThumbprint).length;
    const withPasswords = this.rows.filter((r) => r.password).length;
    this.summary.textContent =
      `${total} host(s) · ${withPasswords} with an individual password · ` +
      `${withThumbprints} with a thumbprint` +
      (withThumbprints < total ? ' — thumbprint validation will be skipped' : '');
  }
}


/**
 * Show or hide a block.
 *
 * Set on the style rather than the `hidden` attribute: `.stack` and
 * `.field-row` set their own display, which beats the attribute's.
 */
function show(node                         , on         )       {
  if (node) node.style.display = on ? '' : 'none';
}

export function mountVcfSpecPage(root             )       {
  /**
   * Serialized plan from the last render, so an unchanged form is not redrawn.
   *
   * See the sizing page for why: a redraw triggered by the blur of clicking a
   * button destroys that button mid-click.
   *
   * Declared here, before anything that can reach `render`. A `let` is not
   * hoisted the way a function declaration is, and applying an inbound handoff
   * renders during mount — declaring this below that point left the whole page
   * dead on arrival with a temporal-dead-zone error.
   */
  let lastRenderKey = '';
  const outputPane = el('div', { class: 'stack' });
  const form = buildInputs(() => render());
  const controls = form.controls;
  const text = (name        )         => (controls[name]?.value ?? '').trim();

  const hostTable = new HostTable(
    () => render(),
    () => ({
      base: text('esxBase') || 'esx',
      count: Math.max(1, Number(text('hostCount')) || 4),
    }),
  );

  // Changing the host count adjusts the table without discarding typed detail.
  controls.hostCount?.addEventListener('change', () => hostTable.syncCount());

  /**
   * Values a sizing result determined that no control represents.
   *
   * The IP pool counts are the reason this exists: sizing works out how many
   * addresses each pool needs, the builder allocates them from the subnets, and
   * the pool controls only override what they are given. Keeping them here lets
   * the emitted pools match the sizing that justified them.
   */
  let inherited                          = {};

  // Where the prefill came from, above the form.
  const notice = el('div', {});

  /** Every control's value, by its name. Secrets only when asked for: they are never saved. */
  function values(includeSecrets = true)                       {
    const out                       = {};
    for (const [key, node] of Object.entries(controls)) {
      if (!includeSecrets && isSecretControl(key)) continue;
      out[key] = node instanceof HTMLInputElement && node.type === 'checkbox' ? node.checked : node.value;
    }
    return out;
  }

  /** Put saved values back into the form. Returns the names that could not be. */
  function restore(fields                      )           {
    const skipped           = [];
    for (const [key, value] of Object.entries(migrateFields(fields))) {
      const node = controls[key];
      // A secret is never restored, even from a hand-edited file.
      if (isSecretControl(key)) continue;
      if (node instanceof HTMLInputElement) {
        if (node.type === 'checkbox') node.checked = value === true;
        else node.value = value === null ? '' : String(value);
      } else if (node instanceof HTMLSelectElement) {
        const v = String(value ?? '');
        if ([...node.options].some((o) => o.value === v)) node.value = v;
        else skipped.push(key);
      } else if (node instanceof HTMLTextAreaElement) {
        const reset = form.grids.get(key);
        if (reset) reset(String(value ?? ''));
        else node.value = String(value ?? '');
      } else skipped.push(key);
    }
    return skipped;
  }

  // Where Clear goes back to: the form as the page draws it, before any prefill.
  const defaults = values(false);
  const defaultHosts = hostTable.entries;
  const clearSecrets = ()       => {
    for (const [key, node] of Object.entries(controls)) if (isSecretControl(key)) node.value = '';
  };

  append(
    root,
    fileBar({
      noun: 'the builder settings',
      fileName: () => `${text('sddcId') || 'vcf'}-builder-settings`,
      header: () => [
        `ArchToolKit VCF spec builder settings for ${text('sddcId') || 'vcf'}`,
        'Load this file on the VCF spec builder to carry on. Passwords are not saved.',
      ],
      save: () =>
        envelope('archtoolkit.vcf-spec-builder', {
          fields: values(false),
          hosts: stripSecrets(hostTable.entries                   ),
          inherited: stripSecrets(inherited                   ),
        })                   ,
      load: (value, name) => {
        // A minimal document has no hostSpecs, so vcenterSpec is checked too.
        if (isRecord(value) && ('hostSpecs' in value || 'vcenterSpec' in value) && ('sddcId' in value || 'workflowType' in value)) {
          throw new Error('that is a deployment specification, not builder settings. Open it in the Data editor to change it.');
        }
        const opened = openEnvelope(value, 'archtoolkit.vcf-spec-builder', SETTINGS_KINDS);
        if ('error' in opened) throw new Error(opened.error);
        const file = opened.ok;
        restore(defaults);
        clearSecrets();
        const skipped = isRecord(file.fields) ? restore(file.fields) : [];
        inherited = isRecord(file.inherited) ? (file.inherited                                      ) : {};
        hostTable.syncCount();
        if (Array.isArray(file.hosts)) hostTable.load(file.hosts                          );
        replace(notice);
        lastRenderKey = '';
        render();
        const passwords = ' Passwords are not kept in the file; type them again.';
        return `Loaded ${name}.${skipped.length ? ` ${skipped.length} field${skipped.length === 1 ? '' : 's'} could not be set (${skipped.slice(0, 4).join(', ')}).` : ''}${passwords}`;
      },
      clear: () => {
        restore(defaults);
        clearSecrets();
        inherited = {};
        hostTable.syncCount();
        hostTable.load(defaultHosts);
        replace(notice);
        lastRenderKey = '';
        render();
      },
    }),
    notice,
  );

  /** Fill the form from a sizing result or an estate, and say so. */
  function applyInbound(origin        , payload                         , from                     )       {
    inherited = payload;
    applySizingPlan(form, payload);
    hostTable.syncCount();
    if (payload.hosts && payload.hosts.length > 0) hostTable.load(payload.hosts);
    replace(
      notice,
      el(
        'div',
        { class: 'section-note', style: { marginBottom: 'var(--space-4)' } },
        el('strong', { text: from === 'sizing' ? 'Prefilled from your sizing. ' : 'Prefilled from your estate. ' }),
        el('span', {
          text: payload.hosts
            ? `${origin}. Hosts, DNS, NTP, domain and the management, vMotion and vSAN networks were read from the estate — check them, then fill in the component names.`
            : `${origin}. Names, domains and VLANs still need filling in.`,
        }),
      ),
    );
  }

  // A result sent with Continue wins; otherwise the latest sizing this tab
  // has not applied yet. Either way the latest is then marked applied, so a
  // reload keeps whatever has been edited here since.
  const latest = unappliedLatest                         ('sizing-to-spec');
  const inbound = takeHandoff                         ('sizing-to-spec') ?? latest;
  if (latest) markApplied('sizing-to-spec', latest.createdAt);
  if (inbound) applyInbound(inbound.origin, inbound.payload, 'sizing');

  append(form.element, hostTable.element);
  form.blocks.hostTable = hostTable.element;
  append(root, el('div', { class: 'split' }, el('div', {}, form.element), outputPane));

  function currentPlan()                 {
    // Controls win over anything inherited; what survives is only the fields no
    // control represents.
    return planFromForm(values(), hostTable.entries, inherited);
  }

  function render()       {
    syncForm(form);
    const plan = currentPlan();
    const key = JSON.stringify(plan);
    if (key === lastRenderKey) return;
    lastRenderKey = key;
    const built = buildSddcSpec(plan);
    const validation = validateSddcSpec(built.spec, {
      secondaryInstance: plan.instanceRole === 'secondary',
    });
    replace(outputPane, ...buildOutput(built.spec, built.findings, validation, form));
  }

  render();

  // No sizing in this tab, but an estate imported: size it on the defaults the
  // sizing page opens with, and fill the form from that — once per estate.
  void mountEstateBar(root, {
    purpose: 'fill this specification from its management cluster',
    onEstate: (entry) => {
      if (!entry || inbound || wasApplied('estate-to-spec', entry.savedAt)) return;
      const clusters = sourceClusters(entry.inventory);
      const host = commonHostProfile(entry.inventory.hosts);
      if (!host || clusters.length === 0) return;
      const managementSource = suggestManagementSource(clusters);
      const plan = planEstate(entry.inventory, { host, managementSource });
      const result = sizeDeployment(plan.management);
      applyInbound(
        `${describeSizingHandoff(result)} — ${entry.origin}, on the sizing page's defaults`,
        {
          ...sizingToPlan(result),
          ...estateToPlan(entry.inventory, managementSource === 'new' ? undefined : managementSource),
        },
        'estate',
      );
      markApplied('estate-to-spec', entry.savedAt);
      render();
    },
  });
}

/**
 * Reflect the scenario and the other choices in the form.
 *
 * Most scenarios fix whether a component takes part, and only a couple leave
 * it open. Showing a live checkbox the builder is going to override would be
 * a lie, so a fixed cell disables the control and shows its real value, and a
 * block the scenario has no use for is hidden (the plan assembly ignores it
 * too, so nothing hidden reaches the document).
 */
function syncForm(form      )       {
  const c = form.controls;
  const b = form.blocks;
  const value = (name        )         => (c[name]?.value ?? '').trim();
  const on = (name        )          => (c[name]                                )?.checked === true;
  const disable = (names                   , off         )       => {
    for (const name of names) if (c[name]) c[name].disabled = off;
  };
  const input = (name        )                   => c[name]                    ;

  // --- scenario ---------------------------------------------------------------
  const scenario = (value('scenario') || 'new-vcf-fleet')                      ;
  const rule = scenarioRule(scenario);
  const view = scenarioView(scenario, on('brownfield'));
  const fix = (name        , cell                                     , open = false)       => {
    const fixed = cell !== 'either' && !open;
    c[name] .disabled = fixed;
    if (fixed) input(name).checked = cell === 'true';
  };
  fix('includeManagementServices', rule.managementServices);
  fix('includeIdentityBroker', rule.identityBroker, view.identityBrokerOptional);
  // NSX and Automation are absent from vSphere Foundation entirely.
  c.includeAutomation .disabled = !view.automation;
  if (!view.automation) input('includeAutomation').checked = false;

  show(b.licenseServer, view.licenseServerOptional);
  show(b.identityBrokerModel, view.identityBrokerOptional);
  show(b.identityBrokerSize, view.identityBroker);
  show(b.automationOptions, view.automation);
  show(b.automationOptionsMore, view.automation);
  show(b.automationPool, view.automation);
  show(b.vspName, view.managementServices);
  show(b.nsxBrownfield, view.nsxMayExist);
  show(b.nsxOptions, view.nsx);

  for (const component of EXISTING_COMPONENTS) show(b[`existing_${component.key}`], view.existing[component.key]);
  show(b.existingNsxNodes, view.existing.nsx);
  show(b.existingDatastore, view.existingDatastore);
  show(b.existingFields, view.anyExisting || view.existingDatastore);

  const shapeOption = (c.documentShape                     ).options[0];
  if (shapeOption) shapeOption.textContent = `Scenario default (${view.defaultShape})`;
  // A minimal document carries no hosts, DNS, switches or NSX, so their
  // sections go with it.
  const minimal = (value('documentShape') || view.defaultShape) === 'minimal';
  show(b.minimalNote, minimal);
  show(b.hostsCard, !minimal);
  show(b.servicesCard, !minimal);
  show(b.hostTable, !minimal);
  show(b.switchingCard, !minimal);

  if (form.hints.opsAdmin) {
    form.hints.opsAdmin.textContent = view.existingOpsAdminPassword
      ? 'Required: the fleet’s existing VCF Operations admin password. A new instance references the existing VCF Operations, so it cannot be generated.'
      : 'VCF Operations admin. Blank: a placeholder, or generated by the installer with the option above.';
  }
  if (form.hints.vcenterRoot) {
    form.hints.vcenterRoot.textContent =
      rule.vcenterExisting === 'true'
        ? 'The existing vCenter’s root password (8-20 characters); it cannot be generated.'
        : '15-20 characters.';
  }

  // --- sizing -----------------------------------------------------------------
  const preset = value('sizePreset');
  c.profile .disabled = preset !== '';

  // --- networks and model -------------------------------------------------------
  const model = managementNetworkModel((value('managementNetworkModel') || 'shared-vlan')                          );
  disable(['fleetCidr', 'fleetVlan', 'fleetV6Cidr', 'fleetV6Gateway'], !model.requiresDedicatedNetwork);
  show(b.net_fleet, model.requiresDedicatedNetwork);
  // Only the stretched model has a second region to name.
  show(b.localRegionFields, model.stretched);
  c.localIpv6Gateway .disabled = !model.stretched;
  if (form.hints.overlaySegment) {
    form.hints.overlaySegment.textContent = model.requiresOverlaySegment
      ? 'Required: the NSX overlay segment the fleet-level components are placed on (xRegionNetwork).'
      : 'Optional: the port group the fleet-level components are placed on (xRegionNetwork). Blank derives it from the fleet network’s port group, or the VM management port group on a converge.';
  }

  // --- storage ------------------------------------------------------------------
  const storage = value('storage');
  const vsan = storage === 'vsan-esa' || storage === 'vsan-osa';
  const nfs = storage === 'nfs';
  show(b.nfsFields, nfs);
  show(b.vmfsFields, storage === 'vmfs-fc');
  show(b.vsanFields, vsan);
  show(b.vsanNetwork, vsan);
  show(b.nfsNetwork, nfs);
  show(b.net_vsan, vsan);
  show(b.net_nfs, nfs);
  c.ftt .disabled = !vsan;
  // Dedup and compression is an OSA capability; ESA has neither knob.
  c.vsanDedup .disabled = storage !== 'vsan-osa';
  c.skipHclAutoDiskClaim .disabled = storage !== 'vsan-esa';
  c.vsanRekeyMinutes .disabled = !on('vsanEncryptionInTransit');

  // --- dual stack -----------------------------------------------------------------
  const dual = on('dualStack');
  c.internalClusterCidrIpv6 .disabled = !dual;
  // The IPv6 half of every network appears with dual stack, and vSAN's or NFS's
  // only when that is the storage.
  show(b.ipv6Fields, dual);
  show(b.fleetIpv6Fields, dual);
  disable(['vsanV6Cidr', 'vsanV6Gateway'], !vsan);
  disable(['nfsV6Cidr', 'nfsV6Gateway'], !nfs);
  disable(['vmMgmtV6Cidr', 'vmMgmtV6Gateway'], !value('vmMgmtCidr'));

  // --- switching ------------------------------------------------------------------
  const custom = value('dvsProfile') === 'custom';
  show(b.customSwitches, custom);
  c.vmnics .disabled = custom;
  show(b.lacpParameters, on('enableLacp') || custom);

  // --- TEPs and VPC -----------------------------------------------------------------
  const vpc = value('vpcMode');
  const vlanBacked = vpc === 'vlan-backed';
  const tepLess = input('tepLess');
  // VLAN-backed VPC is the TEP-less deployment seen from the other side.
  if (vlanBacked) tepLess.checked = true;
  tepLess.disabled = vlanBacked;
  show(b.dtgw, vpc === 'full-distributed');
  show(b.vlanBackedNote, vlanBacked);
  const noTeps = tepLess.checked;
  const tepMode = value('tepMode');
  disable(['tepMode', 'tepCidr', 'tepVlan', 'tepGateway'], noTeps);
  c.tepPoolName .disabled = noTeps || tepMode === 'dhcp';
  c.ignoreUnavailableNsxtCluster .disabled = noTeps || tepMode === 'dhcp';
  show(b.tepPool, !noTeps && tepMode === 'static');

  // --- FQDN overrides: the generated name as each placeholder ---------------------------
  const prefix = value('namePrefix') || value('sddcId') || 'vcf-m01';
  const domain = value('domainSuffix') || 'vcf.lab';
  for (const o of FQDN_OVERRIDES) {
    const node = c[`fqdn_${o.key}`]                                ;
    if (node) node.placeholder = generatedFqdn(o.suffix, prefix, domain);
  }
}

/**
 * Push the sizing-determined part of a plan into the form.
 *
 * Only what sizing actually decides is written. Names, domains, VLANs and
 * subnets are left alone: sizing has no view on them, and filling them with
 * plausible-looking defaults would disguise a guess as a derivation.
 */
function applySizingPlan(form      , plan                         )       {
  const c = form.controls;
  const set = (name        , v                    )       => {
    if (v !== undefined && c[name]) c[name].value = v;
  };
  const tick = (name        , v                     )       => {
    if (v !== undefined && c[name]) (c[name]                    ).checked = v;
  };
  if (plan.hostCount !== undefined) set('hostCount', String(plan.hostCount));
  set('storage', plan.storage);
  set('profile', plan.profile);
  set('sizePreset', plan.sizePreset);
  if (plan.failuresToTolerate !== undefined) set('ftt', String(plan.failuresToTolerate));
  set('scenario', plan.scenario);
  if (plan.pnicsPerHost !== undefined) set('pnicsPerHost', String(plan.pnicsPerHost));
  tick('includeAutomation', plan.includeAutomation);
  set('automationSize', plan.automationSize);
  // What the imported estate knows: the hosts' own DNS, NTP and domain, and the
  // converged cluster's networks.
  set('domainSuffix', plan.domainSuffix);
  if (plan.dnsServers) {
    set('dns1', plan.dnsServers[0] ?? '');
    set('dns2', plan.dnsServers[1] ?? '');
  }
  if (plan.ntpServers) {
    set('ntp1', plan.ntpServers[0] ?? '');
    set('ntp2', plan.ntpServers[1] ?? '');
  }
  const net = (n                                          , stem        )       => {
    if (!n) return;
    set(`${stem}Cidr`, n.cidr);
    set(`${stem}Vlan`, String(n.vlanId));
    // The estate's IPv6 prefix, when its VMkernel adapters carry one.
    set(`${stem}V6Cidr`, n.ipv6Cidr ?? '');
    set(`${stem}V6Gateway`, n.ipv6Gateway ?? '');
  };
  net(plan.management, 'mgmt');
  net(plan.vmotion, 'vmotion');
  net(plan.vsan, 'vsan');
  tick('dualStack', plan.dualStack);
}

/** A grid of " | " rows (src/ui/multi-editors.ts), kept in a textarea the page reads like any control. */
function gridEditor(
  spec          ,
  initial        ,
  onChange            ,
)                                                                                   {
  const columns = spec.hint.split(' | ');
  const shape                                    = {
    separator: ' | ',
    columns,
    headerInValue: false,
    spaced: true,
    choices: columns.map((col) => {
      const offered = spec.options.filter((o) => o.group === col);
      return offered.length > 0 ? offered : undefined;
    }),
  };
  const value = el('textarea', { attrs: { hidden: true } })                       ;
  const host = el('div', {});
  const mount = (text        )       => {
    value.value = text;
    const editor = tableEditor(shape, text, () => {
      const inner = editor.querySelector('textarea.multi-value')                              ;
      value.value = inner?.value ?? '';
      onChange();
    });
    replace(host, editor);
  };
  mount(initial);
  return { wrap: el('div', {}, host, value), value, reset: mount };
}

/** A collapsed section for the settings most plans leave at their defaults. */
function advanced(title        , ...children               )              {
  return el(
    'details',
    { class: 'input-section' },
    el('summary', { text: title }),
    el('div', { class: 'input-section-list', style: { maxHeight: 'none' } }, ...children),
  );
}

function row(...children               )              {
  return el('div', { class: 'field-row' }, ...children);
}

function buildInputs(onChange            )       {
  const controls                          = {};
  const blocks                              = {};
  const hints                              = {};
  const grids = new Map                                ();
  const D = FORM_DEFAULTS;
  const def = (name        )         => String(D[name] ?? '');

  const register =                    (name        , node   )    => {
    node.addEventListener('change', onChange);
    node.addEventListener('input', onChange);
    controls[name] = node;
    return node;
  };
  const txt = (name        , placeholder = '')                   => register(name, textInput(def(name), placeholder));
  const num = (name        , min        , max        )                   =>
    register(name, numberInput(Number(def(name)), { min, max }));
  /** A number that may be left blank, meaning "the default". */
  const optNum = (name        , placeholder        , min        , max        )                   =>
    register(
      name,
      el('input', { attrs: { type: 'number', min, max, placeholder, value: def(name) } })                    ,
    );
  const pick = (name        , options                                             )                    =>
    register(name, select(options, def(name)));
  const choices = (values                   , blank         )                                     => [
    ...(blank !== undefined ? [{ value: '', label: blank }] : []),
    ...values.map((v) => ({ value: v, label: v })),
  ];
  const tick = (name        , label        )              => {
    const box = checkbox(label, D[name] === true);
    register(name, box.input);
    return el('div', { class: 'field' }, box.wrap);
  };
  /** A secret: never pre-filled, never saved, never offered to the browser's autofill. */
  const secret = (name        , placeholder = '')                   =>
    register(
      name,
      el('input', { attrs: { type: 'password', autocomplete: 'new-password', placeholder, value: '' } })                    ,
    );
  const grid = (name        , spec          )              => {
    const g = gridEditor(spec, def(name), onChange);
    controls[name] = g.value;
    grids.set(name, g.reset);
    return g.wrap;
  };
  const hint = (key        , textValue = '')              => {
    const node = el('div', { class: 'field-hint', text: textValue });
    hints[key] = node;
    return node;
  };
  const block =                        (key        , node   )    => {
    blocks[key] = node;
    return node;
  };

  // --- instance ---------------------------------------------------------------
  const instanceCard = card(
    'Instance',
    field('SDDC ID', txt('sddcId'), '3-20 characters, alphanumeric and hyphens.'),
    field('Instance name', txt('instanceName', 'Defaults to the SDDC ID')),
    field('Domain suffix', txt('domainSuffix')),
    field('Name prefix', txt('namePrefix', 'Prefix for component FQDNs'), 'Component FQDNs are built from this.'),
    field(
      'Target version',
      txt('version', 'Target VCF version, e.g. 9.1.1.0'),
      'Drives the VCF Automation pool size and the appliance size defaults.',
    ),
    field(
      'Deployment scenario',
      pick(
        'scenario',
        SCENARIO_RULES.map((rule) => ({ value: rule.scenario, label: `${rule.label} (${rule.workflowType})` })),
      ),
      'Sets the workflow type and which components take part, from the eight scenarios Broadcom publishes.',
    ),
    field(
      'Document shape',
      pick('documentShape', [
        { value: '', label: 'Scenario default' },
        { value: 'full', label: 'Full: every bring-up block' },
        { value: 'minimal', label: 'Minimal: only the component blocks' },
      ]),
      'Minimal is what Broadcom’s samples use for deferred components and VCF management services for VVF: no hosts, networks, switches, NSX, datastore or cluster.',
    ),
    tick('skipGatewayPingValidation', 'Skip gateway ping validation (skipGatewayPingValidation)'),
    block(
      'minimalNote',
      el('div', {
        class: 'section-note',
        text: 'Minimal document: hosts, DNS, NTP, switches, NSX, the datastore and the cluster are not emitted, so the Hosts, Services and Switching sections are hidden. The existing vCenter (and SDDC Manager) and the component blocks are all it carries.',
      }),
    ),
  );

  // --- hosts ------------------------------------------------------------------
  const hostsCard = block('hostsCard', card(
    'Hosts',
    row(field('ESX name base', txt('esxBase')), field('Host count', num('hostCount', 1, 64))),
    row(field('vmnics', txt('vmnics')), field('pNICs per host', num('pnicsPerHost', 1, 8))),
    field(
      'ESX root password (all hosts)',
      secret('esxRootPassword', 'Placeholder when blank'),
      'Used for every host without its own password in the table below. Never saved.',
    ),
  ));

  const servicesCard = block('servicesCard', card(
    'Services',
    row(field('DNS 1', txt('dns1')), field('DNS 2', txt('dns2'))),
    row(field('NTP 1', txt('ntp1')), field('NTP 2', txt('ntp2'))),
  ));

  // --- networks -----------------------------------------------------------------
  const v6Row = (label        , stem        , cidrPlaceholder        , gatewayPlaceholder        )              =>
    row(field(`${label} IPv6 prefix`, txt(`${stem}V6Cidr`, cidrPlaceholder)), field('IPv6 gateway', txt(`${stem}V6Gateway`, gatewayPlaceholder)));
  // IPv6 halves of the networks. Placeholders only: a documentation prefix
  // typed in for someone would end up in a real spec.
  const ipv6Fields = block(
    'ipv6Fields',
    el(
      'div',
      { class: 'stack' },
      el('p', {
        class: 'muted small',
        text: 'Each network with an IPv6 prefix is emitted a second time with ipAddressVersion IPv6 on the same VLAN. Host TEPs stay IPv4: the installer’s TEP pool takes no IPv6.',
      }),
      v6Row('Management', 'mgmt', 'e.g. 2001:db8:30::/64', 'e.g. 2001:db8:30::1'),
      v6Row('VM management', 'vmMgmt', 'Defaults to the management IPv6 network', 'IPv6 gateway'),
      v6Row('vMotion', 'vmotion', 'e.g. 2001:db8:40::/64', 'Optional; blank if not routed'),
      v6Row('vSAN', 'vsan', 'e.g. 2001:db8:50::/64', 'Optional; blank if not routed'),
      v6Row('NFS', 'nfs', 'e.g. 2001:db8:90::/64', 'Optional; blank if not routed'),
    ),
  );

  const networkAdvancedBlock = (id        , label        )              => {
    const n = (f        )         => `net_${id}_${f}`;
    return block(
      `net_${id}`,
      el(
        'div',
        { class: 'stack' },
        el('strong', { text: label }),
        row(
          field('Port group name', txt(n('portGroup'), 'Generated when blank'), 'portGroupKey, max 80 characters. With an existing vCenter, the port group that is really there.'),
          field('Gateway', txt(n('gateway'), 'First usable address')),
        ),
        row(
          field('MTU', optNum(n('mtu'), 'Default', 1280, 9190)),
          field('Address assignment', pick(n('assignment'), choices(IP_ASSIGNMENT_MODES, 'Default (STATIC)'))),
        ),
        row(
          field('Teaming policy', pick(n('teaming'), choices(NETWORK_TEAMING_POLICIES, 'Default (loadbalance_loadbased)'))),
          field('Active uplinks', txt(n('active'), 'uplink1, uplink2')),
          field('Standby uplinks', txt(n('standby'), 'None')),
        ),
        field('IP ranges', txt(n('ranges'), 'start-end, start-end'), 'includeIpAddressRanges; replaces the range carved at a fixed offset.'),
        field('IP addresses', txt(n('addresses'), 'Comma separated'), 'includeIpAddress: individual host VMkernel addresses.'),
      ),
    );
  };

  const networksCard = card(
    'Networks',
    row(field('Management CIDR', txt('mgmtCidr')), field('VLAN', num('mgmtVlan', 0, 4094))),
    row(field('VM management CIDR', txt('vmMgmtCidr', 'Defaults to the management network')), field('VLAN', num('vmMgmtVlan', 0, 4094))),
    row(field('vMotion CIDR', txt('vmotionCidr')), field('VLAN', num('vmotionVlan', 0, 4094))),
    block('vsanNetwork', row(field('vSAN CIDR', txt('vsanCidr')), field('VLAN', num('vsanVlan', 0, 4094)))),
    block(
      'nfsNetwork',
      el(
        'div',
        {},
        row(field('NFS CIDR', txt('nfsCidr')), field('VLAN', num('nfsVlan', 0, 4094))),
        el('div', { class: 'field-hint', text: 'The NFS VMkernel network the hosts mount the principal datastore over. Blank CIDR: no NFS network (the builder then reports it missing).' }),
      ),
    ),
    row(field('Host TEP CIDR', txt('tepCidr')), field('VLAN', num('tepVlan', 0, 4094)), field('TEP gateway', txt('tepGateway', 'First usable address'))),
    tick('dualStack', 'Dual stack (emit IPv6 alongside IPv4)'),
    ipv6Fields,
    advanced(
      'Per-network advanced settings',
      el('p', { class: 'muted small', text: 'Blank keeps the builder’s default. The fleet network’s settings apply with a dedicated model.' }),
      ...ADVANCED_NETWORKS.map((n) => networkAdvancedBlock(n.id, n.label)),
    ),
  );

  // --- fleet-level components ------------------------------------------------------
  const poolBlock = (id        , label        )              => {
    const p = (f        )         => `pool_${id}_${f}`;
    return block(
      id === 'automation' ? 'automationPool' : id === 'tep' ? 'tepPool' : `pool_${id}`,
      el(
        'div',
        { class: 'stack' },
        el('strong', { text: label }),
        row(
          field(
            'Form',
            pick(p('mode'), [
              { value: 'range', label: 'Range (allocated)' },
              { value: 'cidr', label: 'CIDR' },
              { value: 'addresses', label: 'Address list' },
            ]),
          ),
          field('CIDR', txt(p('cidr'), 'Range: source subnet. CIDR: the pool')),
        ),
        row(field('Offset', optNum(p('offset'), 'Default', 0, 65535)), field('Count', optNum(p('count'), 'From sizing', 1, 65535))),
        field('Addresses', txt(p('addresses'), 'Comma separated'), 'Address list form: non-contiguous addresses.'),
        field('Excluded addresses', txt(p('excluded'), 'Comma separated'), 'Carved out of a range or CIDR (9.1.0.400+ in the UI).'),
      ),
    );
  };

  const fleetCard = card(
    'Fleet-level components',
    field(
      'Management network model',
      pick('managementNetworkModel', MANAGEMENT_NETWORK_MODELS.map((m) => ({ value: m.model, label: m.label }))),
      'Where VCF Operations, Automation, the Identity Broker, the License Server and VCF management services live. The cloud proxy always stays on VM management.',
    ),
    row(field('Fleet network CIDR', txt('fleetCidr', 'Dedicated fleet-level components network')), field('VLAN', num('fleetVlan', 0, 4094))),
    field('Network pool name', txt('managementPoolName', 'Auto-generated when blank')),
    field(
      'Services runtime internal CIDR',
      pick('internalClusterCidr', INTERNAL_CLUSTER_CIDRS_V4.map((c) => ({ value: c, label: c }))),
      'Routed internally by the runtime; only these values are supported.',
    ),
    field(
      'Internal CIDR (IPv6)',
      pick('internalClusterCidrIpv6', INTERNAL_CLUSTER_CIDRS_V6.map((c) => ({ value: c, label: c }))),
      'Used with dual stack, ticked under Networks.',
    ),
    block(
      'fleetIpv6Fields',
      el(
        'div',
        { class: 'stack' },
        v6Row('Fleet network', 'fleet', 'e.g. 2001:db8:80::/64', 'e.g. 2001:db8:80::1'),
        field('Management services IPv6 pool', txt('vcfmsIpv6Pool', 'Blank: a range from the services network’s IPv6 prefix'), 'An IPv6 CIDR, or addresses separated by commas.'),
        field('Placement network IPv6 gateway/prefix', txt('overlayIpv6Gateway', 'e.g. 2001:db8:11::1/64')),
        field('Local segment IPv6 gateway/prefix', txt('localIpv6Gateway', 'e.g. 2001:db8:12::1/64'), 'Stretched model only.'),
      ),
    ),
    el(
      'div',
      { class: 'field' },
      el('label', { text: 'Placement network (port group or NSX segment)' }),
      txt('overlaySegment', 'Port group or segment name'),
      hint('overlaySegment'),
    ),
    row(field('Subnet mask', txt('overlayMask')), field('Gateway', txt('overlayGateway'))),
    block(
      'localRegionFields',
      el(
        'div',
        { class: 'stack' },
        field('Local region segment', txt('localSegment', 'Local region segment name'), 'The region-local network of the stretched model. VERIFY: Broadcom documents no example of localRegionNetwork.'),
        row(field('Local subnet mask', txt('localMask')), field('Local gateway', txt('localGateway'))),
      ),
    ),
    advanced(
      'IP pools',
      el('p', { class: 'muted small', text: 'Untouched pools keep the builder’s allocation, with the counts from sizing when it sent any.' }),
      ...IP_POOLS.map((p) => poolBlock(p.id, p.label)),
    ),
  );

  // --- storage and scale ------------------------------------------------------------
  const storageCard = card(
    'Storage and scale',
    field('Principal storage', pick('storage', STORAGE_OPTIONS)),
    field('Datastore name', txt('datastoreName', 'Auto-generated when blank')),
    block(
      'vsanFields',
      el(
        'div',
        { class: 'stack' },
        tick('vsanDedup', 'Deduplication and compression (OSA only)'),
        // skipHclAutoDiskClaim: true skips the HCL check during automatic
        // claiming, so incompatible disks are claimed too. It is not "skip
        // the claim".
        tick('skipHclAutoDiskClaim', 'Allow auto-claim of HCL-incompatible disks (ESA)'),
        tick('vsanEncryptionInTransit', 'Data-in-transit encryption'),
        field('Rekey interval (minutes)', num('vsanRekeyMinutes', 30, 10080)),
      ),
    ),
    block(
      'nfsFields',
      el(
        'div',
        { class: 'stack' },
        field('NFS servers', txt('nfsServers', 'One or more server addresses, comma separated'), 'Required; the API rejects an empty list.'),
        field('Export path', txt('nfsPath')),
        field('User tag', txt('nfsUserTag', 'Optional annotation')),
        tick('nfsReadOnly', 'Mount read-only'),
        tick('nfsBindToVmknic', 'Bind to the NFS network VMkernel NIC'),
        el('div', { class: 'field-hint', text: 'The NFS network itself (CIDR and VLAN) is under Networks.' }),
      ),
    ),
    block(
      'vmfsFields',
      el('div', { class: 'stack' }, field('VMFS datastore names', txt('vmfsDatastoreNames', 'One name per LUN, comma separated'), 'One entry per FC LUN.')),
    ),
    field('Failures to tolerate', num('ftt', 0, 3)),
    field(
      'Sizing preset',
      pick('sizePreset', [{ value: '', label: 'None: the profile and the sizes below' }, ...SIZE_PRESET_OPTIONS]),
      'Broadcom’s fleet sizing models. Sets every size and count; any size chosen below still overrides it.',
    ),
    field(
      'Profile',
      pick('profile', [
        { value: 'simple', label: 'Simple (1 node each)' },
        { value: 'ha', label: 'High Availability (3 nodes)' },
      ]),
      'Ignored when a preset is chosen.',
    ),
    row(
      field('vCenter size', pick('vcenterSize', VCENTER_SIZES)),
      field('vCenter storage', pick('vcenterStorageSize', choices(VCENTER_STORAGE_SIZES, 'Default (lstorage)'))),
    ),
    row(
      field('NSX Manager size', pick('nsxSize', NSX_SIZES)),
      field('NSX Managers', pick('nsxManagerCount', [
        { value: '', label: 'From the preset or profile' },
        { value: '1', label: '1' },
        { value: '3', label: '3' },
      ])),
    ),
    row(
      field('VCF Operations size', pick('opsSize', choices(['xsmall', 'small', 'medium', 'large', 'xlarge'], 'From the preset or version'))),
      field('VCF Operations nodes', pick('opsNodeCount', [
        { value: '', label: 'From the preset or profile' },
        { value: '1', label: '1 (master)' },
        { value: '2', label: '2 (master, replica)' },
        { value: '3', label: '3 (master, replica, data)' },
      ])),
    ),
    row(
      field('VCF Operations load balancer', pick('opsLoadBalancer', [
        { value: '', label: 'Default (HA with more than one node)' },
        { value: 'true', label: 'Emit loadBalancerFqdn' },
        { value: 'false', label: 'None' },
      ]), 'The name is the VCF Operations load balancer FQDN override, or generated.'),
      field('Cloud proxy size', pick('collectorSize', choices(COLLECTOR_SIZES, 'From the preset (else small)'))),
    ),
    row(
      field('Management services size', pick('vspSize', choices(['small', 'small_ha', 'medium', 'large'], 'From the preset or profile'))),
      block('automationOptions', field('VCF Automation size', pick('automationSize', choices(['small', 'medium', 'large'], 'From the preset or version')))),
    ),
    row(
      field('EVC baseline', pick('evcMode', [{ value: '', label: 'None' }, ...EVC_MODES.map((m) => ({ value: m, label: m }))])),
    ),
    row(field('Datacenter name', txt('datacenterName', 'Auto-generated when blank')), field('Cluster name', txt('clusterName', 'Auto-generated when blank'))),
    advanced(
      'Resource pools',
      el('p', { class: 'muted small', text: 'clusterSpec.resourcePoolSpecs. Blank cells are left out. Limits and reservations in MHz and MB; -1 is unlimited.' }),
      grid('resourcePools', RESOURCE_POOL_GRID),
    ),
  );

  // --- switching and NSX ------------------------------------------------------------
  const switchingCard = block('switchingCard', card(
    'Switching and NSX',
    field('vDS profile', pick('dvsProfile', DVS_OPTIONS)),
    block(
      'customSwitches',
      el(
        'div',
        { class: 'field' },
        el('label', { text: 'Switches' }),
        grid('dvsSwitches', DVS_SWITCH_GRID),
        el('div', {
          class: 'field-hint',
          text: 'One row per switch. Networks: traffic types, comma separated (custom names allowed). vmnics: vmnic0:uplink1, vmnic1:uplink2, or plain vmnic0, vmnic1. Transport zones: name:OVERLAY, name:VLAN (blank: one of each). Active and Standby: the NSX teaming uplinks. LACP yes: this switch uses the LACP parameters below.',
        }),
      ),
    ),
    field('vDS MTU', num('dvsMtu', 1500, 9190)),
    row(
      field('NSX teaming policy', pick('nsxTeamingPolicy', choices(NSX_TEAMING_POLICIES, 'Default (LOADBALANCE_SRCID)'))),
      field('Host switch mode', pick('hostSwitchOperationalMode', choices(HOST_SWITCH_MODES, 'Not emitted'))),
    ),
    row(
      field('NSX active uplinks', txt('nsxActiveUplinks', 'Every uplink not on standby')),
      field('NSX standby uplinks', txt('nsxStandbyUplinks', 'None')),
    ),
    tick('enableLacp', 'Use LACP (LAG) on the NSX switch'),
    block(
      'lacpParameters',
      el(
        'div',
        { class: 'stack' },
        row(field('LAG name', txt('lacpName', 'Generated; max 16 characters')), field('Uplinks', num('lacpUplinksCount', 2, 32))),
        row(field('LACP mode', pick('lacpMode', choices(LACP_MODES))), field('Timeout', pick('lacpTimeoutMode', choices(LACP_TIMEOUT_MODES)))),
        field('Load balancing', pick('lacpLoadBalancingMode', choices(LAG_LOAD_BALANCING_MODES))),
      ),
    ),
    block(
      'nsxOptions',
      el(
        'div',
        { class: 'stack' },
        row(
          field('Host TEP addressing', pick('tepMode', [
            { value: 'static', label: 'Static IP pool' },
            { value: 'existing-pool', label: 'Reuse an existing pool' },
            { value: 'dhcp', label: 'DHCP (no pool; VERIFY)' },
          ])),
          field('TEP pool name', txt('tepPoolName', 'Generated when blank')),
        ),
        tick('ignoreUnavailableNsxtCluster', 'Ignore an unavailable NSX cluster when reusing the pool (ignoreUnavailableNsxtCluster)'),
        tick('tepLess', 'TEP-less deployment (9.1.1+)'),
        field(
          'VPC',
          pick('vpcMode', [
            { value: '', label: 'Not configured' },
            { value: 'full-distributed', label: 'Full stack, distributed connectivity (DTGW)' },
            { value: 'full-centralized', label: 'Full stack, centralized connectivity (no DTGW)' },
            { value: 'vlan-backed', label: 'VLAN-backed (9.1.1+)' },
          ]),
        ),
        block(
          'vlanBackedNote',
          el('div', {
            class: 'section-note',
            text: 'A VLAN-backed VPC is the TEP-less deployment: overlayVtepSpec.vtepType NO_IP, no host TEPs, no TEP pool and no distributed transit gateway.',
          }),
        ),
        block(
          'dtgw',
          el(
            'div',
            { class: 'stack' },
            row(field('DTGW VLAN', num('dtgwVlan', 0, 4094)), field('Gateway CIDR', txt('dtgwGatewayCidr'))),
            row(field('External IP block', txt('dtgwExternalCidr')), field('Private TGW block', txt('dtgwPrivateCidr'))),
          ),
        ),
        field(
          'Skip NSX overlay over the management network',
          pick('skipNsxOverlayOverManagementNetwork', [
            { value: '', label: 'Not emitted' },
            { value: 'true', label: 'true' },
            { value: 'false', label: 'false' },
          ]),
          'Documented for an existing vCenter being converted; Broadcom’s greenfield sample sets it true.',
        ),
        block(
          'nsxBrownfield',
          el(
            'div',
            { class: 'field' },
            tick('enableEdgeClusterSync', 'Sync the existing NSX Edge clusters (enableEdgeClusterSync)'),
            el('div', {
              class: 'field-hint',
              text: 'Existing NSX only. Warning: importing with this on triggers a one-time reset of the NSX Edge node passwords.',
            }),
          ),
        ),
      ),
    ),
  ));

  // --- components -----------------------------------------------------------------
  const existingRow = (key        , label        , stem        , placeholder        )              =>
    block(
      `existing_${key}`,
      row(field(`${label} FQDN`, txt(`${stem}Fqdn`, placeholder)), field('SSL thumbprint', txt(`${stem}Thumbprint`, 'SHA256 thumbprint'))),
    );
  const placeholders                         = {
    vcenter: 'vcenter.example.com',
    nsx: 'nsx.example.com',
    sddcManager: 'sddc-manager.example.com',
    operations: 'ops.example.com',
    automation: 'automation.example.com',
    licenseServer: 'license.example.com',
    collector: 'cloud-proxy.example.com',
    managementServices: 'services.example.com',
  };
  const existingFields = block(
    'existingFields',
    el(
      'div',
      { class: 'stack' },
      el('p', { class: 'muted small', text: 'Only the components this scenario can reuse are offered. A reused component is referenced by its FQDN and SHA256 SSL thumbprint.' }),
      ...EXISTING_COMPONENTS.flatMap((c) => [
        existingRow(c.key, c.label, c.stem, placeholders[c.key] ?? ''),
        ...(c.key === 'nsx'
          ? [block('existingNsxNodes', field('NSX Manager node FQDNs', txt('existingNsxNodes', 'nsx-a.example.com, nsx-b.example.com, nsx-c.example.com'), 'Blank: nsxtManagers carries the VIP FQDN.'))]
          : []),
      ]),
      block('existingDatastore', field('Existing datastore', txt('existingDatastoreName', 'Existing datastore to reuse'))),
    ),
  );

  const componentsCard = card(
    'Components',
    field('ESXi certificate mode', pick('esxiCertsMode', [
      { value: '', label: 'Installer default' },
      { value: 'VMCA', label: 'VMCA' },
      { value: 'Custom', label: 'Custom' },
    ])),
    el(
      'div',
      { class: 'field' },
      el('label', { text: 'Root CA certificates' }),
      grid('rootCaCerts', ROOT_CA_GRID),
      el('div', { class: 'field-hint', text: 'securitySpec.rootCaCerts: Base64-encoded certificates, the chain comma separated. Required for the Custom mode.' }),
    ),
    tick('ceipEnabled', 'Join the Customer Experience Improvement Program'),
    tick('includeOperations', 'Include VCF Operations'),
    tick('includeAutomation', 'Include VCF Automation'),
    tick('includeManagementServices', 'Include VCF management services'),
    tick('includeIdentityBroker', 'Include Identity Broker'),
    block(
      'identityBrokerModel',
      field('Identity broker model', pick('identityBrokerModel', [
        { value: '', label: 'From the checkbox above' },
        { value: 'instance', label: 'Instance (on VCF management services; vidbSpec)' },
        { value: 'embedded', label: 'Embedded (a vCenter service; no vidbSpec)' },
      ]), 'Embedded is one broker per instance, for lab and proof-of-concept use. Mandatory Instance brokers leave no choice.'),
    ),
    block('identityBrokerSize', field('Identity broker size', pick('identityBrokerSize', choices(DOCUMENTED_SIZES, 'Not emitted')))),
    block(
      'licenseServer',
      el(
        'div',
        { class: 'field' },
        tick('includeLicenseServer', 'Include the License Server'),
        el('div', { class: 'field-hint', text: 'Required only when the existing VCF Operations does not already have one.' }),
      ),
    ),
    row(
      field('vCenter SSO domain', txt('vcenterSsoDomain', 'vsphere.local')),
      field('SSO administrator', txt('vcenterSsoUsername', 'administrator@<SSO domain>')),
    ),
    block(
      'automationOptionsMore',
      row(
        field('VCF Automation node prefix', txt('automationNodePrefix', '<prefix>-node-01'), 'Lowercase, up to 57 characters.'),
        field('VCF Automation internal CIDR', pick('automationInternalClusterCidr', choices(INTERNAL_CLUSTER_CIDRS_V4, 'Same as the services runtime'))),
      ),
    ),
    block('vspName', field('VCF management services cluster name', txt('vspName', '<prefix>-vmsp-01'), 'vspClusterSpec.name: in working specs, not in the published schema.')),
    tick('includeFleetServiceSpecs', 'Emit the fleet service blocks (fleetDepotSpec, telemetryAcceptorSpec, saltSpec, saltRaasSpec)'),
    advanced(
      'Fleet and lifecycle service sizes',
      el('p', { class: 'muted small', text: 'Free text; the API publishes no enum. Blank: no size emitted.' }),
      ...SERVICE_SPECS.map((s) => field(s.label, txt(`size_${s.key}`, 'Not emitted'))),
    ),
    advanced(
      'Component versions',
      el('p', { class: 'muted small', text: 'Pins each block’s version field. Blank: none emitted, and the installer uses its bundled version.' }),
      ...VERSIONED_COMPONENTS.map((v) => field(v.label, txt(`ver_${v.key}`, 'Not pinned'))),
    ),
    advanced(
      'Component FQDN overrides',
      el('p', { class: 'muted small', text: 'Each placeholder is the generated name. An existing component’s own FQDN wins over its override.' }),
      ...FQDN_OVERRIDES.map((o) => field(o.label, txt(`fqdn_${o.key}`))),
    ),
    tick('brownfield', 'Reuse an existing vCenter (brownfield)'),
    existingFields,
    tick('redact', 'Redact secrets in output'),
  );
  // --- passwords ---------------------------------------------------------------------
  const passwordsCard = card(
    'Passwords',
    el('p', { class: 'muted small', text: 'Never pre-filled and never saved in the settings file. Blank emits a placeholder the validator flags.' }),
    tick('autoGeneratePasswords', 'Let the installer generate passwords'),
    el('div', { class: 'field-hint', text: AUTO_PASSWORDS_NOTE }),
    el('div', { class: 'field' }, el('label', { text: 'VCF Operations admin password' }), secret('password_opsAdmin'), hint('opsAdmin')),
    advanced(
      'Other passwords',
      ...PASSWORDS.map((p) =>
        el(
          'div',
          { class: 'field' },
          el('label', { text: `${p.label} password` }),
          secret(`password_${p.key}`, p.generated ? 'Placeholder, or generated' : 'Placeholder when blank'),
          p.key === 'vcenterRoot' ? hint('vcenterRoot') : el('span'),
        ),
      ),
    ),
  );

  const element = el(
    'div',
    { class: 'stack' },
    instanceCard,
    hostsCard,
    servicesCard,
    networksCard,
    fleetCard,
    storageCard,
    switchingCard,
    componentsCard,
    passwordsCard,
  );

  return { element, controls, blocks, hints, grids };
}

function buildOutput(
  spec          ,
  buildFindings                    ,
  validation                    ,
  form      ,
)                {
  const all = [...buildFindings, ...validation];
  const counts = countBySeverity(all);
  const emitted = Object.keys(spec).length;
  const output = (form.controls.redact                                )?.checked ? redactSpec(spec) : spec;
  const json = serializeSpec(output);

  const summary = card(
    'Specification',
    statGrid(
      stat({
        label: 'Status',
        value: hasErrors(all) ? 'Invalid' : counts.warning > 0 ? 'Review' : 'Valid',
        tone: hasErrors(all) ? 'danger' : counts.warning > 0 ? 'warn' : 'ok',
        sub: `${counts.error} error${counts.error === 1 ? '' : 's'}, ${counts.warning} warning${counts.warning === 1 ? '' : 's'}`,
      }),
      stat({
        label: 'Top-level keys',
        value: `${emitted} / ${SDDC_SPEC_TOP_LEVEL_KEYS.length}`,
        sub: 'of the 9.1 schema',
      }),
      stat({
        label: 'Size',
        value: `${(json.length / 1024).toFixed(1)} KB`,
        sub: specSummary(spec),
      }),
    ),
    el(
      'div',
      { class: 'btn-row', style: { marginTop: 'var(--space-4)' } },
      el('button', {
        class: 'btn btn-primary',
        text: 'Download SddcSpec',
        on: { click: () => downloadFile(`${spec.sddcId}-sddcspec-9.1.json`, json) },
      }),
      el('button', {
        class: 'btn',
        text: 'Edit as JSON',
        attrs: { title: 'Open this specification in the editor, field by field' },
        on: {
          click: () => {
            putHandoff('spec-to-editor', `${spec.sddcId}-sddcspec-9.1.json`, spec);
            globalThis.location.assign('data-editor.html?profile=vcf-spec');
          },
        },
      }),
      el('button', {
        class: 'btn',
        text: 'Copy JSON',
        on: {
          click: (event) => {
            void navigator.clipboard?.writeText(json);
            const button = event.currentTarget                     ;
            const original = button.textContent;
            button.textContent = 'Copied';
            setTimeout(() => {
              button.textContent = original;
            }, 1200);
          },
        },
      }),
    ),
    el('div', {
      class: 'section-note',
      text: 'Built against the documented 9.1 schema. Validate with POST /v1/sddcs/validations on a live VCF Installer before deploying — that check is authoritative, this one is not.',
    }),
  );

  const specCard = card(
    'Generated JSON',
    el('div', { class: 'table-wrap', style: { maxHeight: '560px', overflow: 'auto' } },
      el('pre', { class: 'mono', style: { margin: '0', padding: 'var(--space-4)', fontSize: '0.78rem', lineHeight: '1.5' } }, json),
    ),
  );

  const findingsCard = card(
    'Findings',
    findingsList(all, 'No issues. Every documented constraint this tool checks is satisfied.'),
  );

  return [summary, specCard, findingsCard, buildImportCard()];
}

/**
 * Import panel.
 *
 * Checking someone else's spec is as useful as generating one — a document
 * from a 9.0-era builder carries `vcfOperationsFleetManagementSpec`, which the
 * validator rejects outright.
 */
function buildImportCard()              {
  const results = el('div');

  const fileInput = el('input', {
    attrs: { type: 'file', accept: '.json,application/json' },
  })                    ;

  const textArea = el('textarea', {
    attrs: { rows: '6', placeholder: 'Or paste an existing SddcSpec here…' },
  })                       ;

  const check = (json        )       => {
    if (!json.trim()) {
      replace(results, el('div', { class: 'empty', text: 'Nothing to validate.' }));
      return;
    }
    const findings = validateSddcSpecJson(json);
    const counts = countBySeverity(findings);
    replace(
      results,
      statGrid(
        stat({
          label: 'Result',
          value: hasErrors(findings) ? 'Rejected' : counts.warning > 0 ? 'Review' : 'Valid for 9.1',
          tone: hasErrors(findings) ? 'danger' : counts.warning > 0 ? 'warn' : 'ok',
          sub: `${counts.error} error${counts.error === 1 ? '' : 's'}, ${counts.warning} warning${counts.warning === 1 ? '' : 's'}`,
        }),
      ),
      el('div', { style: { marginTop: 'var(--space-4)' } }, findingsList(findings)),
    );
  };

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) void readFileAsText(file).then(check);
  });

  return card(
    'Validate an existing specification',
    el('p', {
      class: 'muted small',
      text: 'Check a spec produced by another tool against the 9.1 schema. Documents built for 9.0 are rejected — the fleet management appliance they reference no longer exists. Nothing is uploaded; validation runs in this page.',
    }),
    el('div', { class: 'field', style: { marginTop: 'var(--space-4)' } }, fileInput),
    el('div', { class: 'field' }, textArea),
    el(
      'div',
      { class: 'btn-row' },
      el('button', { class: 'btn', text: 'Validate', on: { click: () => check(textArea.value) } }),
    ),
    el('div', { style: { marginTop: 'var(--space-4)' } }, results),
  );
}

const target = typeof document !== 'undefined' ? document.getElementById('vcf-spec-root') : null;
if (target) mountVcfSpecPage(target               );
