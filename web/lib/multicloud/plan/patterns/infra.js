/**
 * Core infrastructure (addendum A.4.2): AD DS, DNS, DHCP, AD CS, NTP and jump
 * hosts. `pattern.infra.rebuild`: these are always rebuilt, never replicated
 * (the base `shape.dc-rebuild` generalised). DHCP is retired when every scope's
 * subnets move (the cloud networks hand out addresses); jump hosts are retired
 * in favour of the platform's own bastion.
 */

import { info } from '../../../core/findings.js';
import { rule,              } from '../decide/engine.js';
                                                        
import { fact, patternOf, workloadTypeOf,                   } from './model.js';

export const INFRA_SOURCES = {
  dcPromotion: 'https://learn.microsoft.com/en-us/windows-server/identity/ad-ds/deploy/install-active-directory-domain-services--level-100-',
  dhcp: 'https://learn.microsoft.com/en-us/powershell/module/dhcpserver/export-dhcpserver',
  adcs: 'https://learn.microsoft.com/en-us/troubleshoot/windows-server/certificates-and-public-key-infrastructure-pki/move-certification-authority-to-another-server',
  dnsExport: 'https://learn.microsoft.com/en-us/powershell/module/dnsserver/export-dnsserverzone',
  w32tm: 'https://learn.microsoft.com/en-us/windows-server/networking/windows-time-service/windows-time-service-tools-and-settings',
}         ;

export const INFRA_PATTERN_IDS                        = ['ad-ds', 'dns', 'dhcp', 'adcs', 'ntp', 'jump-host'];

const RUNBOOK                                              = {
  'ad-ds': ['Build new DCs on the target, promote them, move the FSMO roles, then demote the old DCs.'],
  dns: ['AD-integrated zones replicate with the new DCs; file-backed zones move with Export-DnsServerZone and a copy.'],
  dhcp: ['Export-DhcpServer -File dhcp.xml -Leases, then Import-DhcpServer -File dhcp.xml -BackupPath … -Leases; retire when every scope\'s subnets move.'],
  adcs: [
    'Back up the CA database and key (Backup-CARoleService; the key password comes from the vault).',
    'Export HKLM\\SYSTEM\\CurrentControlSet\\Services\\CertSvc\\Configuration.',
    'Install AD CS on the new server with the same CA name and key, restore, and republish the CRL / AIA.',
  ],
  ntp: ['Point the PDC emulator at the cloud time sources: w32tm /config /manualpeerlist:… /syncfromflags:manual /reliable:yes.'],
  'jump-host': ['Retire in favour of the platform\'s bastion (Session Manager, Azure Bastion, IAP, OCI Bastion).'],
};

const QUESTIONS                                                      = {
  'ad-ds': [{ key: 'domains', label: 'Domains', kind: 'text' }],
  dns: [{ key: 'zones', label: 'Zones', kind: 'text' }],
  dhcp: [{ key: 'scopes', label: 'DHCP scopes', kind: 'number' }],
  adcs: [{ key: 'caTiers', label: 'CA tiers', kind: 'select', options: ['root-offline-issuing', 'enterprise-root-only'], default: 'root-offline-issuing' }],
  ntp: [],
  'jump-host': [],
};

const TYPES                                                       = {
  'ad-ds': ['ad-ds'], dns: ['dns'], dhcp: ['dhcp'], adcs: ['adcs'], ntp: ['ntp'], 'jump-host': ['jump-host'],
};

export const INFRA_PATTERNS                          = INFRA_PATTERN_IDS.map((id)               => ({
  id,
  family: 'infra',
  kind: 'infrastructure',
  detectFrom: TYPES[id] ,
  questions: QUESTIONS[id] ,
  rules: ['pattern.infra.rebuild'],
  components: [{ name: 'Servers', tier: 'infra', workloadTypes: TYPES[id] , tierPattern: id === 'jump-host' ? 'retire' : 'vm', alternatives: id === 'dhcp' ? ['retire', 'vm'] : ['vm'] }],
  methods: id === 'jump-host' ? ['retire'] : ['rebuild'],
  artefacts: {
    ansibleModules: ['ansible.windows.win_powershell', 'ansible.windows.win_feature', ...(id === 'ad-ds' ? ['microsoft.ad.domain_controller'] : [])],
    runbook: RUNBOOK[id] ,
  },
  status: 'automated',
  facts: [
    ...(id === 'dhcp' ? [fact('Export-DhcpServer / Import-DhcpServer move scopes, options and leases.', INFRA_SOURCES.dhcp)] : []),
    ...(id === 'adcs' ? [fact('A CA moves by backup and restore with the same CA name and key.', INFRA_SOURCES.adcs)] : []),
    ...(id === 'dns' ? [fact('Export-DnsServerZone writes a file-backed zone for copying.', INFRA_SOURCES.dnsExport)] : []),
    ...(id === 'ntp' ? [fact('w32tm configures the PDC emulator\'s time sources.', INFRA_SOURCES.w32tm)] : []),
    ...(id === 'ad-ds' ? [fact('Domain controllers are promoted fresh, never replicated (USN rollback).', INFRA_SOURCES.dcPromotion)] : []),
  ],
}));

const INFRA_TYPES = new Set(['ad-ds', 'dns', 'dhcp', 'adcs', 'ntp', 'jump-host']);

export const INFRA_RULES                     = [
  rule          ({
    id: 'pattern.infra.rebuild',
    kind: 'workload',
    verification: 'V-DOC',
    source: INFRA_SOURCES.dcPromotion,
    applies: (w, ctx) => INFRA_PATTERN_IDS.includes(patternOf(w, ctx) ?? 'generic') || INFRA_TYPES.has(workloadTypeOf(w) ?? ''),
    findings: (w, ctx) => {
      const kind = workloadTypeOf(w) ?? patternOf(w, ctx) ?? '';
      if (kind === 'dhcp') return [info('pattern.infra.dhcp-retire', `${w.name}: the cloud networks hand out addresses, so DHCP is retired once every scope's subnets have moved; until then it is rebuilt (Export-DhcpServer / Import-DhcpServer).`, { source: INFRA_SOURCES.dhcp })];
      if (kind === 'jump-host') return [info('pattern.infra.jump-retire', `${w.name}: retire the jump host in favour of the platform's own bastion.`)];
      if (kind === 'adcs') return [info('pattern.infra.adcs', `${w.name}: the CA is rebuilt with the same name and key and its database restored (the key password from the vault, never in a file).`, { source: INFRA_SOURCES.adcs })];
      return [info('pattern.infra.rebuild', `${w.name}: core infrastructure is rebuilt on the target, not replicated.`, { source: INFRA_SOURCES.dcPromotion })];
    },
  }),
];
