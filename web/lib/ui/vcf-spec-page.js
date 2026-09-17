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
import { buildSddcSpec, serializeSpec, redactSpec,                                      } from '../vcf/spec-builder.js';
import { validateSddcSpec, validateSddcSpecJson } from '../vcf/spec-validate.js';
import { SDDC_SPEC_TOP_LEVEL_KEYS,               } from '../vcf/spec-types.js';
                                                                           

                    
                           
                                 
                                 
                               
                                  
                            
                              
                         
                         
                         
                         
                             
                             
                                
                                
                             
                             
                            
                            
                             
                        
                             
                                 
                             
                                
                           
                                 
                               
                              
                             
                                    
                                     
                                    
                                      
                                      
                               
                           
 

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

export function mountVcfSpecPage(root             )       {
  const controls = {}            ;
  const outputPane = el('div', { class: 'stack' });
  const inputsPane = buildInputs(controls, () => render());

  append(root, el('div', { class: 'split' }, el('div', {}, inputsPane), outputPane));

  function currentPlan()                 {
    const num = (input                  , fallback        )         => {
      const parsed = Number(input.value);
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    const list = (input                  )           =>
      input.value
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);

    const storage = controls.storage.value                             ;
    const vsanSelected = storage === 'vsan-esa' || storage === 'vsan-osa';

    return {
      sddcId: controls.sddcId.value.trim() || 'vcf-m01',
      vcfInstanceName: controls.instanceName.value.trim() || undefined,
      domainSuffix: controls.domainSuffix.value.trim() || 'vcf.lab',
      namePrefix: controls.namePrefix.value.trim() || undefined,
      instanceRole: controls.instanceRole.value                           ,
      esxHostnameBase: controls.esxBase.value.trim() || 'esx',
      hostCount: Math.max(1, num(controls.hostCount, 4)),
      dnsServers: [controls.dns1.value.trim(), controls.dns2.value.trim()].filter(Boolean),
      ntpServers: [controls.ntp1.value.trim(), controls.ntp2.value.trim()].filter(Boolean),
      management: { cidr: controls.mgmtCidr.value.trim(), vlanId: num(controls.mgmtVlan, 30) },
      vmotion: { cidr: controls.vmotionCidr.value.trim(), vlanId: num(controls.vmotionVlan, 40) },
      ...(vsanSelected
        ? { vsan: { cidr: controls.vsanCidr.value.trim(), vlanId: num(controls.vsanVlan, 50) } }
        : {}),
      hostTep: { cidr: controls.tepCidr.value.trim(), vlanId: num(controls.tepVlan, 60) },
      pnicsPerHost: Math.max(1, num(controls.pnicsPerHost, 2)),
      storage,
      failuresToTolerate: num(controls.ftt, 1),
      profile: controls.profile.value                   ,
      vcenterSize: controls.vcenterSize.value                 ,
      nsxManagerSize: controls.nsxSize.value                   ,
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
      ...(controls.brownfield.checked
        ? {
            existing: {
              vcenter: { fqdn: '', sslThumbprint: undefined },
            },
          }
        : {}),
    };
  }

  function render()       {
    const plan = currentPlan();
    const built = buildSddcSpec(plan);
    const validation = validateSddcSpec(built.spec, {
      secondaryInstance: plan.instanceRole === 'secondary',
    });
    replace(outputPane, ...buildOutput(built.spec, built.findings, validation, controls));
  }

  render();
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
  controls.instanceRole = bind(
    select(
      [
        { value: 'primary', label: 'Primary — new fleet' },
        { value: 'secondary', label: 'Secondary — join existing fleet' },
      ],
      'primary',
    ),
  );
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

  const automation = checkbox('Include VCF Automation', true);
  controls.includeAutomation = bind(automation.input);
  const operations = checkbox('Include VCF Operations', true);
  controls.includeOperations = bind(operations.input);
  const brownfield = checkbox('Reuse an existing vCenter (brownfield)', false);
  controls.brownfield = bind(brownfield.input);
  const redact = checkbox('Redact secrets in output', false);
  controls.redact = bind(redact.input);

  return el(
    'div',
    { class: 'stack' },
    card(
      'Instance',
      field('SDDC ID', controls.sddcId, '3-20 characters, alphanumeric and hyphens.'),
      field('Instance name', controls.instanceName),
      field('Domain suffix', controls.domainSuffix),
      field('Name prefix', controls.namePrefix, 'Component FQDNs are built from this.'),
      field('Fleet position', controls.instanceRole),
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
      'Storage and scale',
      field('Principal storage', controls.storage),
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
    ),
    card(
      'Switching and NSX',
      field('vDS profile', controls.dvsProfile),
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
      el('div', { class: 'field' }, operations.wrap),
      el('div', { class: 'field' }, automation.wrap),
      el('div', { class: 'field' }, brownfield.wrap),
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
