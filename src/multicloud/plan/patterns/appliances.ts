/**
 * Network and security appliances (addendum A.4.2): F5 BIG-IP, Palo Alto
 * Networks, Fortinet FortiGate, Check Point and Cisco.
 *
 * `pattern.appliance.marketplace`: every hyperscaler offers each vendor's
 * image, BYOL and PAYG, but per-SKU availability is unconfirmed here [U] (and
 * the Cisco Catalyst 8000V on OCI in particular [U]). The move is
 * `appliance-rebuild`: deploy the marketplace image, then move the
 * configuration, not the VM. The vendors' managed alternatives (Cloud NGFW
 * for Palo Alto on AWS and Azure) are report-only. Device configuration hands
 * off to the toolkit's Network page.
 */

import { info, warning } from '../../../core/findings.ts';
import { rule, type AnyRule, type RuleContext } from '../decide/engine.ts';
import type { AppPattern, Platform, Workload } from '../types.ts';
import { answersOf, fact, patternOf, workloadTypeOf, type PatternEntry } from './model.ts';

export const APPLIANCE_SOURCES = {
  awsMarketplace: 'https://aws.amazon.com/marketplace',
  azureMarketplace: 'https://azuremarketplace.microsoft.com/',
  googleMarketplace: 'https://console.cloud.google.com/marketplace',
  ociMarketplace: 'https://cloudmarketplace.oracle.com/marketplace/',
  f5Ucs: 'https://my.f5.com/manage/s/article/K13132',
  panorama: 'https://docs.paloaltonetworks.com/panorama',
  cloudNgfw: 'https://docs.paloaltonetworks.com/cloud-ngfw',
  fortigate: 'https://docs.fortinet.com/document/fortigate/latest/administration-guide/702257/configuration-backups-and-reset',
  checkpoint: 'https://support.checkpoint.com/results/sk/sk135172',
} as const;

export const APPLIANCE_PATTERN_IDS: readonly AppPattern[] = ['appliance-f5', 'appliance-paloalto', 'appliance-fortinet', 'appliance-checkpoint', 'appliance-cisco'];

/** Per-vendor configuration move (the runbook step), Ansible modules and the managed alternative. */
const VENDOR: Readonly<Record<string, { readonly move: string; readonly modules: readonly string[]; readonly managed?: Readonly<Partial<Record<Platform, string>>>; readonly source: string }>> = {
  'appliance-f5': { move: 'F5 UCS: tmsh save sys ucs on the source, load sys ucs on the new VE, then re-license; or AS3 / DO declarations.', modules: ['f5networks.f5_modules.bigip_ucs_fetch', 'f5networks.f5_modules.bigip_ucs', 'ansible.builtin.uri'], source: APPLIANCE_SOURCES.f5Ucs },
  'appliance-paloalto': { move: 'Palo Alto: Panorama device groups and templates push the configuration to the new VM-Series.', modules: ['ansible.builtin.uri'], managed: { aws: 'Cloud NGFW for AWS', azure: 'Cloud NGFW for Azure' }, source: APPLIANCE_SOURCES.panorama },
  'appliance-fortinet': { move: 'FortiGate: configuration backup and restore, or FortiManager.', modules: ['fortinet.fortios.fortios_monitor', 'fortinet.fortimanager.fmgr_generic'], source: APPLIANCE_SOURCES.fortigate },
  'appliance-checkpoint': { move: 'Check Point: migrate_server export / import on the management server.', modules: ['check_point.mgmt.cp_mgmt_install_policy'], source: APPLIANCE_SOURCES.checkpoint },
  'appliance-cisco': { move: 'Cisco: the running-config applied to the new virtual appliance.', modules: ['cisco.ios.ios_config', 'ansible.netcommon.cli_config'], source: 'https://www.cisco.com/c/en/us/products/routers/catalyst-8000v-edge-software/index.html' },
};

const MARKETPLACE = `${APPLIANCE_SOURCES.awsMarketplace} ; ${APPLIANCE_SOURCES.azureMarketplace} ; ${APPLIANCE_SOURCES.googleMarketplace} ; ${APPLIANCE_SOURCES.ociMarketplace}`;

const TYPE_OF: Readonly<Record<string, Workload['workloadType']>> = {
  'appliance-f5': 'appliance-f5', 'appliance-paloalto': 'appliance-paloalto', 'appliance-fortinet': 'appliance-fortinet',
  'appliance-checkpoint': 'appliance-checkpoint', 'appliance-cisco': 'appliance-cisco',
};

export const APPLIANCE_PATTERNS: readonly PatternEntry[] = APPLIANCE_PATTERN_IDS.map((id): PatternEntry => {
  const v = VENDOR[id]!;
  return {
    id,
    family: 'appliances',
    kind: 'infrastructure',
    detectFrom: [TYPE_OF[id]!],
    questions: [
      { key: 'model', label: 'Model / throughput', kind: 'text' },
      { key: 'haPair', label: 'HA pair', kind: 'yesno', default: 'yes' },
      { key: 'licence', label: 'Licence', kind: 'select', options: ['byol', 'payg'], default: 'byol' },
    ],
    rules: ['pattern.appliance.marketplace'],
    components: [{ name: 'Appliances', tier: 'edge', workloadTypes: [TYPE_OF[id]!], tierPattern: 'appliance' }],
    methods: ['appliance-rebuild'],
    artefacts: {
      ansibleModules: v.modules,
      runbook: ['Deploy the marketplace image (accept the plan / subscription), with one NIC per zone.', v.move, 'Device configuration: hand off to the Network page.'],
    },
    status: 'partial',
    facts: [
      fact('Each vendor\'s image is offered on every hyperscaler\'s marketplace, BYOL and PAYG; per-SKU availability varies by region and is not confirmed here.', MARKETPLACE, 'I'),
      fact(v.move, v.source, 'C'),
      ...(id === 'appliance-cisco' ? [fact('Cisco Catalyst 8000V on OCI is not confirmed here.', APPLIANCE_SOURCES.ociMarketplace, 'I')] : []),
      ...(v.managed ? [fact(`Managed alternative: ${Object.values(v.managed).join(', ')} (report-only).`, APPLIANCE_SOURCES.cloudNgfw, 'C')] : []),
    ],
  };
});

const applianceOf = (w: Workload, ctx: RuleContext): string | undefined => {
  const p = patternOf(w, ctx);
  if (p && APPLIANCE_PATTERN_IDS.includes(p)) return p;
  const t = workloadTypeOf(w);
  return t && t.startsWith('appliance-') && t !== 'appliance-other' ? t : undefined;
};

export const APPLIANCE_RULES: readonly AnyRule[] = [
  rule<Workload>({
    id: 'pattern.appliance.marketplace',
    kind: 'workload',
    verification: 'I',
    source: MARKETPLACE,
    applies: (w, ctx) => applianceOf(w, ctx) !== undefined,
    findings: (w, ctx) => [
      info('pattern.appliance.marketplace', `${w.name}: deploy the vendor's marketplace image (${answersOf(w, ctx)['licence'] === 'payg' ? 'PAYG' : 'BYOL'}) and move the configuration, not the VM; confirm the SKU is offered in the target region [U].`, { source: MARKETPLACE }),
    ],
    review: (w, chosen, ctx) => {
      if (!chosen) return [];
      const a = applianceOf(w, ctx)!;
      const out = [];
      if (a === 'appliance-cisco' && chosen.platform === 'oci') {
        out.push(warning('pattern.appliance.cisco-oci', `${w.name}: the Cisco virtual appliance on OCI is not confirmed [U]; check the OCI Marketplace before committing.`, { source: APPLIANCE_SOURCES.ociMarketplace }));
      }
      const managed = VENDOR[a]?.managed?.[chosen.platform];
      if (managed) out.push(info('pattern.appliance.managed-alternative', `${w.name}: ${managed} is the vendor's managed alternative on ${chosen.platform} (report-only).`, { source: APPLIANCE_SOURCES.cloudNgfw }));
      return out;
    },
  }),
];
