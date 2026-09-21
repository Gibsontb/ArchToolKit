/**
 * VCF 9.1 specification builder page.
 *
 * Left: the deployment plan. Right: the generated SddcSpec, the validation
 * findings, and an import panel for checking a spec produced elsewhere — which
 * is how a 9.0-shaped document from another tool gets caught before it reaches
 * an installer.
 */

import { el, append, replace, downloadFile, readFileAsText } from './dom.js';
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
import { countBySeverity, hasErrors,              } from '../core/findings.js';
import {
  buildSddcSpec,
  serializeSpec,
  redactSpec,
                      
                   
                  
                 
} from '../vcf/spec-builder.js';
import { validateSddcSpec, validateSddcSpecJson } from '../vcf/spec-validate.js';
import { SCENARIO_RULES, scenarioRule,                         } from '../vcf/scenarios.js';
import { takeHandoff } from './handoff.js';
import {
  MANAGEMENT_NETWORK_MODELS,
  managementNetworkModel,
                              
} from '../vcf/management-network.js';
import { SDDC_SPEC_TOP_LEVEL_KEYS,               } from '../vcf/spec-types.js';
import { EVC_MODES } from '../vcf/spec-types.js';
                                                                                    
import { DEFAULT_VCF_VERSION } from '../vcf/version.js';
import {
  INTERNAL_CLUSTER_CIDRS_V4,
  INTERNAL_CLUSTER_CIDRS_V6,
} from '../vcf/sizing-data.js';

                    
                           
                                 
                                 
                               
                              
                            
                              
                         
                         
                         
                         
                             
                             
                                
                                
                             
                             
                            
                            
                                            
                              
                              
                                   
                                
                                   
                                 
                              
                                 
                                                                     
                                 
                             
                        
                                  
                              
                                         
                                            
                                     
                               
                               
                                       
                                         
                                             
                              
                                   
                                
                               
                            
                                
                               
                                    
                                       
                                                                        
                         
                          
                          
                             
                            
                                 
                             
                             
                             
                                    
                             
                            
                           
                                   
                                
                                
                           
                                 
                               
                              
                             
                                    
                                     
                                    
                                      
                                      
                                              
                                          
                               
                                        
                                              
                                    
                                          
                                            
                                                  
                                    
                                          
                                           
                                                 
                                          
                              
                           
 

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
];

const VCENTER_SIZES                                            = [
  { value: 'tiny', label: 'Tiny' },
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
  { value: 'xlarge', label: 'X-Large' },
];

const NSX_SIZES                                              = [
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
  { value: 'xlarge', label: 'X-Large' },
];

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

export function mountVcfSpecPage(root             )       {
  const controls = {}            ;
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
  const inputsPane = buildInputs(controls, () => render());

  const hostTable = new HostTable(
    () => render(),
    () => ({
      base: controls.esxBase.value.trim() || 'esx',
      count: Math.max(1, Number(controls.hostCount.value) || 4),
    }),
  );

  // Changing the host count adjusts the table without discarding typed detail.
  controls.hostCount.addEventListener('change', () => hostTable.syncCount());

  /**
   * Values a sizing result determined that no control represents.
   *
   * The IP pool counts are the reason this exists: sizing works out how many
   * addresses each pool needs, the builder allocates them from the subnets, and
   * there is no sensible form field in between. Keeping them here lets the
   * emitted pools match the sizing that justified them.
   */
  let inherited                          = {};

  const inbound = takeHandoff                         ('sizing-to-spec');
  if (inbound) {
    inherited = inbound.payload;
    applySizingPlan(controls, inbound.payload);
    hostTable.syncCount();
    if (inbound.payload.hosts && inbound.payload.hosts.length > 0) hostTable.load(inbound.payload.hosts);
    append(
      root,
      el(
        'div',
        { class: 'section-note', style: { marginBottom: 'var(--space-4)' } },
        el('strong', { text: 'Prefilled from your sizing. ' }),
        el('span', {
          text: inbound.payload.hosts
            ? `${inbound.origin}. Hosts, DNS, NTP, domain and the management, vMotion and vSAN networks were read from the estate — check them, then fill in the component names.`
            : `${inbound.origin}. Names, domains and VLANs still need filling in.`,
        }),
      ),
    );
  }

  append(inputsPane, hostTable.element);
  append(root, el('div', { class: 'split' }, el('div', {}, inputsPane), outputPane));

  function currentPlan()                 {
    const num = (input                  , fallback        )         => {
      const parsed = Number(input.value);
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    // Controls win over anything inherited; what survives is only the fields no
    // control represents.
    const inheritedPlan = inherited;
    const list = (input                  )           =>
      input.value
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);

    const storage = controls.storage.value                             ;
    const vsanSelected = storage === 'vsan-esa' || storage === 'vsan-osa';
    const scenario = controls.scenario.value                      ;
    const rule = scenarioRule(scenario);
    const model = managementNetworkModel(
      controls.managementNetworkModel.value                          ,
    );
    const overlaySegment = controls.overlaySegment.value.trim();

    return {
      ...inheritedPlan,
      sddcId: controls.sddcId.value.trim() || 'vcf-m01',
      vcfInstanceName: controls.instanceName.value.trim() || undefined,
      domainSuffix: controls.domainSuffix.value.trim() || 'vcf.lab',
      namePrefix: controls.namePrefix.value.trim() || undefined,
      scenario,
      // A further instance joins an existing fleet; the scenario decides that,
      // so the two can no longer disagree.
      instanceRole: rule.workflowType === 'VCF_EXTEND' ? 'secondary' : 'primary',
      esxHostnameBase: controls.esxBase.value.trim() || 'esx',
      hostCount: Math.max(1, num(controls.hostCount, 4)),
      hosts: hostTable.entries,
      dnsServers: [controls.dns1.value.trim(), controls.dns2.value.trim()].filter(Boolean),
      ntpServers: [controls.ntp1.value.trim(), controls.ntp2.value.trim()].filter(Boolean),
      // A gateway or MTU the estate supplied survives while the subnet is unchanged.
      management: keep(inheritedPlan.management, controls.mgmtCidr.value.trim(), num(controls.mgmtVlan, 30)),
      vmotion: keep(inheritedPlan.vmotion, controls.vmotionCidr.value.trim(), num(controls.vmotionVlan, 40)),
      ...(vsanSelected
        ? { vsan: keep(inheritedPlan.vsan, controls.vsanCidr.value.trim(), num(controls.vsanVlan, 50)) }
        : {}),
      hostTep: { cidr: controls.tepCidr.value.trim(), vlanId: num(controls.tepVlan, 60) },
      ...(controls.vmMgmtCidr.value.trim()
        ? {
            vmManagement: {
              cidr: controls.vmMgmtCidr.value.trim(),
              vlanId: num(controls.vmMgmtVlan, 30),
            },
          }
        : {}),
      ...(controls.managementPoolName.value.trim()
        ? { managementPoolName: controls.managementPoolName.value.trim() }
        : {}),
      internalClusterCidr: controls.internalClusterCidr.value,
      dualStack: controls.dualStack.checked,
      ...(controls.dualStack.checked
        ? { internalClusterCidrIpv6: controls.internalClusterCidrIpv6.value }
        : {}),
      ...(controls.esxiCertsMode.value
        ? { esxiCertsMode: controls.esxiCertsMode.value                      }
        : {}),
      ceipEnabled: controls.ceipEnabled.checked,
      managementNetworkModel: model.model,
      ...(model.requiresDedicatedNetwork && controls.fleetCidr.value.trim()
        ? {
            fleetManagement: {
              cidr: controls.fleetCidr.value.trim(),
              vlanId: num(controls.fleetVlan, 80),
            },
          }
        : {}),
      ...(model.requiresOverlaySegment && overlaySegment
        ? {
            managementComponentNetworks: {
              xRegion: {
                networkName: overlaySegment,
                subnetMask: controls.overlayMask.value.trim(),
                gateway: controls.overlayGateway.value.trim(),
              },
              // The stretched model spans two regions, so the cross-region
              // segment is joined by a region-local one.
              ...(model.stretched && controls.localSegment.value.trim()
                ? {
                    local: {
                      networkName: controls.localSegment.value.trim(),
                      subnetMask: controls.localMask.value.trim(),
                      gateway: controls.localGateway.value.trim(),
                    },
                  }
                : {}),
            },
          }
        : {}),
      pnicsPerHost: Math.max(1, num(controls.pnicsPerHost, 2)),
      storage,
      failuresToTolerate: num(controls.ftt, 1),
      ...(controls.datastoreName.value.trim()
        ? { datastoreName: controls.datastoreName.value.trim() }
        : {}),
      ...(vsanSelected
        ? {
            vsanDedup: controls.vsanDedup.checked,
            skipHclAutoDiskClaim: controls.skipHclAutoDiskClaim.checked,
            vsanEncryptionInTransit: controls.vsanEncryptionInTransit.checked,
            ...(controls.vsanEncryptionInTransit.checked
              ? { vsanRekeyIntervalMinutes: num(controls.vsanRekeyMinutes, 1440) }
              : {}),
          }
        : {}),
      ...(storage === 'nfs'
        ? {
            nfsServers: list(controls.nfsServers),
            nfsPath: controls.nfsPath.value.trim(),
            nfsReadOnly: controls.nfsReadOnly.checked,
            ...(controls.nfsUserTag.value.trim()
              ? { nfsUserTag: controls.nfsUserTag.value.trim() }
              : {}),
            nfsBindToVmknic: controls.nfsBindToVmknic.checked,
          }
        : {}),
      ...(storage === 'vmfs-fc' ? { vmfsDatastoreNames: list(controls.vmfsDatastoreNames) } : {}),
      profile: controls.profile.value                   ,
      version: controls.version.value.trim() || DEFAULT_VCF_VERSION,
      vcenterSize: controls.vcenterSize.value                 ,
      nsxManagerSize: controls.nsxSize.value                   ,
      ...(controls.opsSize.value
        ? { opsSize: controls.opsSize.value                              }
        : {}),
      ...(controls.vspSize.value
        ? { vspSize: controls.vspSize.value                              }
        : {}),
      ...(controls.automationSize.value ? { automationSize: controls.automationSize.value } : {}),
      ...(controls.evcMode.value ? { evcMode: controls.evcMode.value            } : {}),
      tepLess: controls.tepLess.checked,
      dvsMtu: num(controls.dvsMtu, 9000),
      ...(controls.datacenterName.value.trim()
        ? { datacenterName: controls.datacenterName.value.trim() }
        : {}),
      ...(controls.clusterName.value.trim()
        ? { clusterName: controls.clusterName.value.trim() }
        : {}),
      dvsProfile: controls.dvsProfile.value              ,
      vmnics: list(controls.vmnics),
      ...(controls.enableLacp.checked
        ? {
            lacp: {
              uplinksCount: 2,
              lacpMode: 'ACTIVE'         ,
              lacpTimeoutMode: 'FAST'         ,
              loadBalancingMode: 'SOURCE_AND_DESTINATION_IP'         ,
            },
          }
        : {}),
      ...(controls.enableVpc.checked
        ? {
            vpcNetworkConfigurationType: 'FULL_STACK_VPC'         ,
            dtgw: {
              vlan: num(controls.dtgwVlan, 70),
              gatewayCidr: controls.dtgwGatewayCidr.value.trim(),
              externalIpBlockCidr: controls.dtgwExternalCidr.value.trim(),
              privateTgwIpBlockCidr: controls.dtgwPrivateCidr.value.trim(),
            },
          }
        : {}),
      includeAutomation: controls.includeAutomation.checked,
      includeOperations: controls.includeOperations.checked,
      includeManagementServices: controls.includeManagementServices.checked,
      includeIdentityBroker: controls.includeIdentityBroker.checked,
      // A converge scenario reuses an existing vCenter by definition, so the
      // checkbox only has to cover the greenfield rows.
      ...(existingBlock(controls, rule) ?? {}),
    };
  }

  /**
   * Reflect the chosen scenario in the component toggles.
   *
   * Most scenarios fix whether a component takes part, and only a couple leave
   * it open. Showing a live checkbox the builder is going to override would be
   * a lie, so a fixed cell disables the control and shows its real value.
   */
  /** Grey out the fleet-network and overlay inputs the chosen model does not use. */
  function syncNetworkModelControls()       {
    const model = managementNetworkModel(
      controls.managementNetworkModel.value                          ,
    );
    for (const input of [controls.fleetCidr, controls.fleetVlan]) {
      input.disabled = !model.requiresDedicatedNetwork;
    }
    for (const input of [controls.overlaySegment, controls.overlayMask, controls.overlayGateway]) {
      input.disabled = !model.requiresOverlaySegment;
    }
    // Only the stretched model has a second region to name.
    controls.localRegionFields.hidden = !model.stretched;
  }

  /**
   * Show only the storage detail the chosen type uses.
   *
   * The dropdown has always offered NFS and VMFS on FC; without these fields a
   * spec came out with a placeholder server name and could not deploy.
   */
  function syncStorageControls()       {
    const storage = controls.storage.value;
    const vsan = storage === 'vsan-esa' || storage === 'vsan-osa';
    controls.nfsFields.hidden = storage !== 'nfs';
    controls.vmfsFields.hidden = storage !== 'vmfs-fc';
    controls.vsanFields.hidden = !vsan;
    controls.ftt.disabled = !vsan;
    // Dedup and compression is an OSA capability; ESA has neither knob.
    controls.vsanDedup.disabled = storage !== 'vsan-osa';
    controls.skipHclAutoDiskClaim.disabled = storage !== 'vsan-esa';
    controls.vsanRekeyMinutes.disabled = !controls.vsanEncryptionInTransit.checked;
    controls.internalClusterCidrIpv6.disabled = !controls.dualStack.checked;
  }

  function syncScenarioControls()       {
    const rule = scenarioRule(controls.scenario.value                      );
    const apply = (input                  , cell                                     )       => {
      const fixed = cell !== 'either';
      input.disabled = fixed;
      if (fixed) input.checked = cell === 'true';
    };
    apply(controls.includeManagementServices, rule.managementServices);
    apply(controls.includeIdentityBroker, rule.identityBroker);

    // Reused components only need naming when the scenario actually reuses any.
    const reuses =
      rule.vcenterExisting === 'true' ||
      rule.nsxExisting !== 'false' ||
      rule.operationsExisting === 'true' ||
      rule.automationExisting === 'true';
    controls.existingFields.hidden = !reuses && !controls.brownfield.checked;

    // NSX and Automation are absent from vSphere Foundation entirely.
    const automationFixed = rule.automationExisting === 'na' && rule.workflowType === 'VVF';
    controls.includeAutomation.disabled = automationFixed;
    if (automationFixed) controls.includeAutomation.checked = false;
  }

  function render()       {
    syncScenarioControls();
    syncNetworkModelControls();
    syncStorageControls();
    const plan = currentPlan();
    const key = JSON.stringify(plan);
    if (key === lastRenderKey) return;
    lastRenderKey = key;
    const built = buildSddcSpec(plan);
    const validation = validateSddcSpec(built.spec, {
      secondaryInstance: plan.instanceRole === 'secondary',
    });
    replace(outputPane, ...buildOutput(built.spec, built.findings, validation, controls));
  }

  render();
}

/**
 * Assemble the brownfield `existing` block.
 *
 * A converge or deferred-component scenario is defined by what it reuses, so the
 * FQDN and thumbprint of each reused component have to be collectable. Emitting
 * `existing.vcenter` with an empty name, as this page did before, declared a
 * reuse the installer could not act on.
 */
/**
 * Push the sizing-determined part of a plan into the form.
 *
 * Only what sizing actually decides is written. Names, domains, VLANs and
 * subnets are left alone: sizing has no view on them, and filling them with
 * plausible-looking defaults would disguise a guess as a derivation.
 */
function keep(from                         , cidr        , vlanId        )              {
  return from && from.cidr === cidr ? { ...from, cidr, vlanId } : { cidr, vlanId };
}

function applySizingPlan(controls          , plan                         )       {
  if (plan.hostCount !== undefined) controls.hostCount.value = String(plan.hostCount);
  if (plan.storage) controls.storage.value = plan.storage;
  if (plan.profile) controls.profile.value = plan.profile;
  if (plan.failuresToTolerate !== undefined) {
    controls.ftt.value = String(plan.failuresToTolerate);
  }
  if (plan.scenario) controls.scenario.value = plan.scenario;
  if (plan.pnicsPerHost !== undefined) controls.pnicsPerHost.value = String(plan.pnicsPerHost);
  if (plan.includeAutomation !== undefined) {
    controls.includeAutomation.checked = plan.includeAutomation;
  }
  if (plan.automationSize) controls.automationSize.value = plan.automationSize;
  // What the imported estate knows: the hosts' own DNS, NTP and domain, and the
  // converged cluster's networks.
  if (plan.domainSuffix) controls.domainSuffix.value = plan.domainSuffix;
  if (plan.dnsServers) {
    controls.dns1.value = plan.dnsServers[0] ?? '';
    controls.dns2.value = plan.dnsServers[1] ?? '';
  }
  if (plan.ntpServers) {
    controls.ntp1.value = plan.ntpServers[0] ?? '';
    controls.ntp2.value = plan.ntpServers[1] ?? '';
  }
  const net = (n                         , cidr                  , vlan                  )       => {
    if (!n) return;
    cidr.value = n.cidr;
    vlan.value = String(n.vlanId);
  };
  net(plan.management, controls.mgmtCidr, controls.mgmtVlan);
  net(plan.vmotion, controls.vmotionCidr, controls.vmotionVlan);
  net(plan.vsan, controls.vsanCidr, controls.vsanVlan);
}

function existingBlock(
  controls          ,
  rule                                 ,
)                                               {
  const part = (fqdnInput                  , thumbInput                  ) => {
    const fqdn = fqdnInput.value.trim();
    if (!fqdn) return undefined;
    const sslThumbprint = thumbInput.value.trim();
    return { fqdn, ...(sslThumbprint ? { sslThumbprint } : {}) };
  };

  const vcenter =
    part(controls.existingVcenterFqdn, controls.existingVcenterThumbprint) ??
    // The scenario fixes vCenter as existing even when no detail was typed;
    // keep declaring it so the mismatch finding stays accurate.
    (controls.brownfield.checked || rule.vcenterExisting === 'true'
      ? { fqdn: controls.existingVcenterFqdn.value.trim() }
      : undefined);
  const nsx = part(controls.existingNsxFqdn, controls.existingNsxThumbprint);
  const sddcManager = part(
    controls.existingSddcManagerFqdn,
    controls.existingSddcManagerThumbprint,
  );
  const operations = part(controls.existingOpsFqdn, controls.existingOpsThumbprint);
  const automation = part(
    controls.existingAutomationFqdn,
    controls.existingAutomationThumbprint,
  );
  const datastoreName = controls.existingDatastoreName.value.trim();

  if (!vcenter && !nsx && !sddcManager && !operations && !automation && !datastoreName) {
    return undefined;
  }
  return {
    existing: {
      ...(vcenter ? { vcenter } : {}),
      ...(nsx ? { nsx } : {}),
      ...(sddcManager ? { sddcManager } : {}),
      ...(operations ? { operations } : {}),
      ...(automation ? { automation } : {}),
      ...(datastoreName ? { datastoreName } : {}),
    },
  };
}

function buildInputs(controls          , onChange            )              {
  const bind =                        (node   )    => {
    node.addEventListener('change', onChange);
    node.addEventListener('input', onChange);
    return node;
  };

  controls.sddcId = bind(textInput('vcf-m01'));
  controls.instanceName = bind(textInput('', 'Defaults to the SDDC ID'));
  controls.domainSuffix = bind(textInput('vcf.lab'));
  controls.namePrefix = bind(textInput('vcf-m01', 'Prefix for component FQDNs'));
  controls.scenario = bind(
    select(
      SCENARIO_RULES.map((rule) => ({
        value: rule.scenario,
        label: `${rule.label} (${rule.workflowType})`,
      })),
      'new-vcf-fleet',
    ),
  );
  controls.managementNetworkModel = bind(
    select(
      MANAGEMENT_NETWORK_MODELS.map((m) => ({ value: m.model, label: m.label })),
      'shared-vlan',
    ),
  );
  controls.fleetCidr = bind(textInput('172.30.80.0/24', 'Dedicated fleet-level components network'));
  controls.fleetVlan = bind(numberInput(80, { min: 0, max: 4094 }));
  controls.overlaySegment = bind(textInput('', 'NSX overlay segment name'));
  controls.overlayMask = bind(textInput('255.255.255.0'));
  controls.overlayGateway = bind(textInput('192.168.11.1'));
  controls.localSegment = bind(textInput('', 'Local region segment name'));
  controls.localMask = bind(textInput('255.255.255.0'));
  controls.localGateway = bind(textInput('192.168.12.1'));

  controls.esxBase = bind(textInput('esx'));
  controls.hostCount = bind(numberInput(4, { min: 1, max: 64 }));

  controls.dns1 = bind(textInput('192.168.30.29'));
  controls.dns2 = bind(textInput('192.168.30.30'));
  controls.ntp1 = bind(textInput('192.168.30.1'));
  controls.ntp2 = bind(textInput('192.168.30.2'));

  controls.mgmtCidr = bind(textInput('172.30.0.0/24'));
  controls.mgmtVlan = bind(numberInput(30, { min: 0, max: 4094 }));
  controls.vmotionCidr = bind(textInput('172.30.40.0/24'));
  controls.vmotionVlan = bind(numberInput(40, { min: 0, max: 4094 }));
  controls.vsanCidr = bind(textInput('172.30.50.0/24'));
  controls.vsanVlan = bind(numberInput(50, { min: 0, max: 4094 }));
  controls.tepCidr = bind(textInput('172.30.60.0/24'));
  controls.tepVlan = bind(numberInput(60, { min: 0, max: 4094 }));

  controls.storage = bind(select(STORAGE_OPTIONS         , 'vsan-esa'));
  controls.ftt = bind(numberInput(1, { min: 0, max: 3 }));
  controls.profile = bind(
    select(
      [
        { value: 'simple', label: 'Simple (1 node each)' },
        { value: 'ha', label: 'High Availability (3 nodes)' },
      ],
      'simple',
    ),
  );
  controls.vcenterSize = bind(select(VCENTER_SIZES, 'small'));
  controls.nsxSize = bind(select(NSX_SIZES, 'medium'));

  controls.dvsProfile = bind(select(DVS_OPTIONS, 'default'));
  controls.vmnics = bind(textInput('vmnic0, vmnic1'));
  controls.pnicsPerHost = bind(numberInput(2, { min: 1, max: 8 }));

  const lacp = checkbox('Use LACP (LAG)', false);
  controls.enableLacp = bind(lacp.input);

  const vpc = checkbox('Configure VPC with Distributed TGW', false);
  controls.enableVpc = bind(vpc.input);
  controls.dtgwVlan = bind(numberInput(70, { min: 0, max: 4094 }));
  controls.dtgwGatewayCidr = bind(textInput('172.30.70.1/24'));
  controls.dtgwExternalCidr = bind(textInput('172.30.70.0/26'));
  controls.dtgwPrivateCidr = bind(textInput('172.31.0.0/16'));

  controls.version = bind(
    textInput(DEFAULT_VCF_VERSION, 'Target VCF version, e.g. 9.1.1.0'),
  );
  const sizeOptions = (values                   , autoLabel = 'Default for the version'  
                                     ) => [
    { value: '', label: autoLabel },
    ...values.map((v) => ({ value: v, label: v })),
  ];
  controls.opsSize = bind(
    select(sizeOptions(['xsmall', 'small', 'medium', 'large', 'xlarge']), ''),
  );
  controls.vspSize = bind(select(sizeOptions(['small', 'small_ha', 'medium', 'large']), ''));
  controls.automationSize = bind(select(sizeOptions(['small', 'medium', 'large']), ''));
  controls.evcMode = bind(
    select(
      [{ value: '', label: 'None' }, ...EVC_MODES.map((m) => ({ value: m, label: m }))],
      '',
    ),
  );
  controls.dvsMtu = bind(numberInput(9000, { min: 1500, max: 9190 }));
  controls.datacenterName = bind(textInput('', 'Auto-generated when blank'));
  controls.clusterName = bind(textInput('', 'Auto-generated when blank'));

  controls.vmMgmtCidr = bind(textInput('', 'Defaults to the management network'));
  controls.vmMgmtVlan = bind(numberInput(30, { min: 0, max: 4094 }));
  controls.managementPoolName = bind(textInput('', 'Auto-generated when blank'));
  controls.internalClusterCidr = bind(
    select(
      INTERNAL_CLUSTER_CIDRS_V4.map((c) => ({ value: c, label: c })),
      INTERNAL_CLUSTER_CIDRS_V4[0],
    ),
  );
  controls.internalClusterCidrIpv6 = bind(
    select(
      INTERNAL_CLUSTER_CIDRS_V6.map((c) => ({ value: c, label: c })),
      INTERNAL_CLUSTER_CIDRS_V6[0],
    ),
  );
  controls.esxiCertsMode = bind(
    select(
      [
        { value: '', label: 'Installer default' },
        { value: 'VMCA', label: 'VMCA' },
        { value: 'Custom', label: 'Custom' },
      ],
      '',
    ),
  );
  controls.vsanRekeyMinutes = bind(numberInput(1440, { min: 30, max: 10080 }));

  const vsanDedup = checkbox('Deduplication and compression (OSA only)', false);
  controls.vsanDedup = bind(vsanDedup.input);
  const skipHcl = checkbox('Skip automatic disk claim (ESA)', false);
  controls.skipHclAutoDiskClaim = bind(skipHcl.input);
  const vsanDit = checkbox('Data-in-transit encryption', false);
  controls.vsanEncryptionInTransit = bind(vsanDit.input);
  const dualStack = checkbox('Dual stack (emit IPv6 alongside IPv4)', false);
  controls.dualStack = bind(dualStack.input);
  const ceip = checkbox('Join the Customer Experience Improvement Program', false);
  controls.ceipEnabled = bind(ceip.input);

  controls.datastoreName = bind(textInput('', 'Auto-generated when blank'));
  controls.nfsServers = bind(textInput('', 'One or more server addresses, comma separated'));
  controls.nfsPath = bind(textInput('/export/vcf'));
  controls.nfsUserTag = bind(textInput('', 'Optional annotation'));
  controls.vmfsDatastoreNames = bind(textInput('', 'One name per LUN, comma separated'));

  const tepLess = checkbox('TEP-less deployment (9.1.1+)', false);
  controls.tepLess = bind(tepLess.input);

  const nfsReadOnly = checkbox('Mount read-only', false);
  controls.nfsReadOnly = bind(nfsReadOnly.input);
  const nfsBind = checkbox('Bind to the NFS network VMkernel NIC', false);
  controls.nfsBindToVmknic = bind(nfsBind.input);

  const automation = checkbox('Include VCF Automation', true);
  controls.includeAutomation = bind(automation.input);
  const operations = checkbox('Include VCF Operations', true);
  controls.includeOperations = bind(operations.input);
  const managementServices = checkbox('Include VCF management services', true);
  controls.includeManagementServices = bind(managementServices.input);
  const identityBroker = checkbox('Include Identity Broker', true);
  controls.includeIdentityBroker = bind(identityBroker.input);
  const brownfield = checkbox('Reuse an existing vCenter (brownfield)', false);
  controls.brownfield = bind(brownfield.input);

  const existingPair = (placeholder        )                                       => [
    bind(textInput('', placeholder)),
    bind(textInput('', 'SHA256 thumbprint')),
  ];
  [controls.existingVcenterFqdn, controls.existingVcenterThumbprint] =
    existingPair('vcenter.example.com');
  [controls.existingNsxFqdn, controls.existingNsxThumbprint] = existingPair('nsx.example.com');
  [controls.existingSddcManagerFqdn, controls.existingSddcManagerThumbprint] =
    existingPair('sddc-manager.example.com');
  [controls.existingOpsFqdn, controls.existingOpsThumbprint] = existingPair('ops.example.com');
  [controls.existingAutomationFqdn, controls.existingAutomationThumbprint] =
    existingPair('automation.example.com');
  controls.existingDatastoreName = bind(textInput('', 'Existing datastore to reuse'));
  const redact = checkbox('Redact secrets in output', false);
  controls.redact = bind(redact.input);

  // Built before the layout so the storage sections can be shown or hidden by
  // reference rather than by re-querying the DOM.
  controls.nfsFields = el(
    'div',
    { class: 'stack' },
    field('NFS servers', controls.nfsServers, 'Required; the API rejects an empty list.'),
    field('Export path', controls.nfsPath),
    field('User tag', controls.nfsUserTag),
    el('div', { class: 'field' }, nfsReadOnly.wrap),
    el('div', { class: 'field' }, nfsBind.wrap),
  );
  controls.vmfsFields = el(
    'div',
    { class: 'stack' },
    field('VMFS datastore names', controls.vmfsDatastoreNames, 'One entry per FC LUN.'),
  );
  const existingRow = (
    label        ,
    fqdnInput                  ,
    thumbInput                  ,
  )              =>
    el(
      'div',
      { class: 'field-row' },
      field(`${label} FQDN`, fqdnInput),
      field('SSL thumbprint', thumbInput),
    );

  controls.existingFields = el(
    'div',
    { class: 'stack' },
    existingRow('vCenter', controls.existingVcenterFqdn, controls.existingVcenterThumbprint),
    existingRow('NSX Manager', controls.existingNsxFqdn, controls.existingNsxThumbprint),
    existingRow(
      'SDDC Manager',
      controls.existingSddcManagerFqdn,
      controls.existingSddcManagerThumbprint,
    ),
    existingRow('VCF Operations', controls.existingOpsFqdn, controls.existingOpsThumbprint),
    existingRow(
      'VCF Automation',
      controls.existingAutomationFqdn,
      controls.existingAutomationThumbprint,
    ),
    field('Existing datastore', controls.existingDatastoreName),
  );

  controls.localRegionFields = el(
    'div',
    { class: 'stack' },
    field('Local region segment', controls.localSegment, 'The region-local network of the stretched model.'),
    el(
      'div',
      { class: 'field-row' },
      field('Local subnet mask', controls.localMask),
      field('Local gateway', controls.localGateway),
    ),
  );
  controls.vsanFields = el(
    'div',
    { class: 'stack' },
    el('div', { class: 'field' }, vsanDedup.wrap),
    el('div', { class: 'field' }, skipHcl.wrap),
    el('div', { class: 'field' }, vsanDit.wrap),
    field('Rekey interval (minutes)', controls.vsanRekeyMinutes),
  );

  return el(
    'div',
    { class: 'stack' },
    card(
      'Instance',
      field('SDDC ID', controls.sddcId, '3-20 characters, alphanumeric and hyphens.'),
      field('Instance name', controls.instanceName),
      field('Domain suffix', controls.domainSuffix),
      field('Name prefix', controls.namePrefix, 'Component FQDNs are built from this.'),
      field(
        'Target version',
        controls.version,
        'Drives the VCF Automation pool size and the appliance size defaults.',
      ),
      field(
        'Deployment scenario',
        controls.scenario,
        'Sets the workflow type and which components take part, from the eight scenarios Broadcom publishes.',
      ),
    ),
    card(
      'Hosts',
      el(
        'div',
        { class: 'field-row' },
        field('ESX name base', controls.esxBase),
        field('Host count', controls.hostCount),
      ),
      el(
        'div',
        { class: 'field-row' },
        field('vmnics', controls.vmnics),
        field('pNICs per host', controls.pnicsPerHost),
      ),
    ),
    card(
      'Services',
      el('div', { class: 'field-row' }, field('DNS 1', controls.dns1), field('DNS 2', controls.dns2)),
      el('div', { class: 'field-row' }, field('NTP 1', controls.ntp1), field('NTP 2', controls.ntp2)),
    ),
    card(
      'Networks',
      el(
        'div',
        { class: 'field-row' },
        field('Management CIDR', controls.mgmtCidr),
        field('VLAN', controls.mgmtVlan),
      ),
      el(
        'div',
        { class: 'field-row' },
        field('VM management CIDR', controls.vmMgmtCidr),
        field('VLAN', controls.vmMgmtVlan),
      ),
      el(
        'div',
        { class: 'field-row' },
        field('vMotion CIDR', controls.vmotionCidr),
        field('VLAN', controls.vmotionVlan),
      ),
      el(
        'div',
        { class: 'field-row' },
        field('vSAN CIDR', controls.vsanCidr),
        field('VLAN', controls.vsanVlan),
      ),
      el(
        'div',
        { class: 'field-row' },
        field('Host TEP CIDR', controls.tepCidr),
        field('VLAN', controls.tepVlan),
      ),
    ),
    card(
      'Fleet-level components',
      field(
        'Management network model',
        controls.managementNetworkModel,
        'Where VCF Operations, Automation, the Identity Broker, the License Server and VCF management services live. The cloud proxy always stays on VM management.',
      ),
      el(
        'div',
        { class: 'field-row' },
        field('Fleet network CIDR', controls.fleetCidr),
        field('VLAN', controls.fleetVlan),
      ),
      field('Network pool name', controls.managementPoolName),
      field(
        'Services runtime internal CIDR',
        controls.internalClusterCidr,
        'Routed internally by the runtime; only these values are supported.',
      ),
      el('div', { class: 'field' }, dualStack.wrap),
      field('Internal CIDR (IPv6)', controls.internalClusterCidrIpv6),
      field('NSX overlay segment', controls.overlaySegment, 'Segment name, for the overlay models.'),
      el(
        'div',
        { class: 'field-row' },
        field('Segment subnet mask', controls.overlayMask),
        field('Segment gateway', controls.overlayGateway),
      ),
      controls.localRegionFields,
    ),
    card(
      'Storage and scale',
      field('Principal storage', controls.storage),
      field('Datastore name', controls.datastoreName),
      controls.vsanFields,
      controls.nfsFields,
      controls.vmfsFields,
      el(
        'div',
        { class: 'field-row' },
        field('Failures to tolerate', controls.ftt),
        field('Profile', controls.profile),
      ),
      el(
        'div',
        { class: 'field-row' },
        field('vCenter size', controls.vcenterSize),
        field('NSX Manager size', controls.nsxSize),
      ),
      el(
        'div',
        { class: 'field-row' },
        field('VCF Operations size', controls.opsSize),
        field('Management services size', controls.vspSize),
      ),
      el(
        'div',
        { class: 'field-row' },
        field('VCF Automation size', controls.automationSize),
        field('EVC baseline', controls.evcMode),
      ),
      el(
        'div',
        { class: 'field-row' },
        field('Datacenter name', controls.datacenterName),
        field('Cluster name', controls.clusterName),
      ),
    ),
    card(
      'Switching and NSX',
      field('vDS profile', controls.dvsProfile),
      field('vDS MTU', controls.dvsMtu),
      el('div', { class: 'field' }, tepLess.wrap),
      el('div', { class: 'field' }, lacp.wrap),
      el('div', { class: 'field' }, vpc.wrap),
      el(
        'div',
        { class: 'field-row' },
        field('DTGW VLAN', controls.dtgwVlan),
        field('Gateway CIDR', controls.dtgwGatewayCidr),
      ),
      el(
        'div',
        { class: 'field-row' },
        field('External IP block', controls.dtgwExternalCidr),
        field('Private TGW block', controls.dtgwPrivateCidr),
      ),
    ),
    card(
      'Components',
      field('ESXi certificate mode', controls.esxiCertsMode),
      el('div', { class: 'field' }, ceip.wrap),
      el('div', { class: 'field' }, operations.wrap),
      el('div', { class: 'field' }, automation.wrap),
      el('div', { class: 'field' }, managementServices.wrap),
      el('div', { class: 'field' }, identityBroker.wrap),
      el('div', { class: 'field' }, brownfield.wrap),
      controls.existingFields,
      el('div', { class: 'field' }, redact.wrap),
    ),
  );
}

function buildOutput(
  spec          ,
  buildFindings                    ,
  validation                    ,
  controls          ,
)                {
  const all = [...buildFindings, ...validation];
  const counts = countBySeverity(all);
  const emitted = Object.keys(spec).length;
  const output = controls.redact.checked ? redactSpec(spec) : spec;
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
        sub: `${spec.hostSpecs?.length ?? 0} hosts, ${spec.networkSpecs.length} networks`,
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
