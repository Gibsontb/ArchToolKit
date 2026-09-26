/**
 * Microsoft server products (addendum A.4.2): Exchange, SharePoint, Dynamics
 * CRM and IIS / .NET applications.
 *
 * - `pattern.exchange.eos`: Exchange 2016 / 2019 left support on 2025-10-14,
 *   so the default is SaaS (Exchange Online, +5) and IaaS only as Exchange
 *   Server Subscription Edition;
 * - `pattern.sharepoint.eos`: SharePoint 2016 / 2019 end on 2026-07-14, the
 *   same logic;
 * - `pattern.dynamics.op2ol`: SaaS only through Microsoft's on-premises-to-
 *   online programme (v9.0 / 9.1 sources);
 * - `pattern.dotnet.runtime`: .NET Framework does not run on Cloud Run, so
 *   Google Cloud (GCP) `paas-web` is eliminated; App2Container is closed to
 *   new customers (2025-11-07), so the AWS route notes AWS Transform for .NET.
 */

import { info, warning } from '../../../core/findings.js';
                                            
import { rule,                                } from '../decide/engine.js';
                                                         
import { answersOf, fact, patternOf, tierPatternOf,                   } from './model.js';

export const MS_SOURCES = {
  eos2025: 'https://learn.microsoft.com/en-us/lifecycle/end-of-support/end-of-support-2025',
  sharepointEos: 'https://learn.microsoft.com/en-us/lifecycle/products/sharepoint-server-2019',
  exchangeMove: 'https://learn.microsoft.com/en-us/exchange/hybrid-deployment/move-mailboxes',
  spmt: 'https://learn.microsoft.com/en-us/sharepointmigration/introducing-the-sharepoint-migration-tool',
  op2ol: 'https://learn.microsoft.com/en-us/dynamics365/guidance/migrate/opol-crm-migration-high-level-overview',
  cloudRun: 'https://docs.cloud.google.com/run/docs/container-contract',
  app2container: 'https://docs.aws.amazon.com/app2container/latest/UserGuide/what-is-a2c.html',
  appServiceAssistant: 'https://learn.microsoft.com/en-us/azure/app-service/app-service-migration-assistant',
}         ;

export const EXCHANGE_EOS = '2025-10-14';
export const SHAREPOINT_EOS = '2026-07-14';

export const MICROSOFT_PATTERNS                          = [
  {
    id: 'exchange',
    family: 'microsoft',
    kind: 'cots',
    detectFrom: ['exchange'],
    questions: [
      { key: 'version', label: 'Exchange version', kind: 'select', options: ['2013', '2016', '2019', 'se'], default: '2019' },
      { key: 'mailboxes', label: 'Mailboxes', kind: 'number' },
      { key: 'totalGib', label: 'Total mailbox size', kind: 'number', unit: 'GiB' },
      { key: 'archive', label: 'Archive mailboxes', kind: 'yesno', default: 'no' },
    ],
    rules: ['pattern.exchange.eos'],
    components: [{ name: 'Mailbox servers', tier: 'app', workloadTypes: ['exchange'], tierPattern: 'saas', alternatives: ['vm'] }],
    methods: ['saas-exchange'],
    artefacts: {
      runbook: [
        'Run the Hybrid Configuration Wizard (a GUI step).',
        'Per wave: New-MigrationEndpoint -ExchangeRemoteMove, New-MigrationBatch with the wave\'s batch CSV (EmailAddress), Start-MigrationBatch, Complete-MigrationBatch.',
      ],
      ansibleModules: ['ansible.windows.win_powershell'],
    },
    status: 'partial',
    facts: [
      fact('Exchange Server 2016 and 2019 reached end of support on 2025-10-14; Exchange Server Subscription Edition is the supported on-premises version.', MS_SOURCES.eos2025),
      fact('Mailboxes move to Exchange Online with remote move migration batches in a hybrid deployment.', MS_SOURCES.exchangeMove),
    ],
    preferences: [
      { tierPattern: 'saas', delta: 5, rule: 'pattern.exchange.eos', reason: 'Exchange 2016 / 2019 are past support: Exchange Online is the default.', source: MS_SOURCES.eos2025, verification: 'V-DOC', when: { key: 'version', values: ['2013', '2016', '2019'] } },
    ],
  },
  {
    id: 'sharepoint',
    family: 'microsoft',
    kind: 'cots',
    detectFrom: ['sharepoint'],
    questions: [
      { key: 'version', label: 'SharePoint version', kind: 'select', options: ['2013', '2016', '2019', 'se'], default: '2019' },
      { key: 'siteCollections', label: 'Site collections', kind: 'number' },
      { key: 'contentGib', label: 'Content', kind: 'number', unit: 'GiB' },
    ],
    rules: ['pattern.sharepoint.eos'],
    components: [
      { name: 'SharePoint farm', tier: 'app', workloadTypes: ['sharepoint'], tierPattern: 'saas', alternatives: ['vm'] },
      { name: 'Content databases', tier: 'data', workloadTypes: ['db-host'], tierPattern: 'vm' },
    ],
    methods: ['saas-sharepoint'],
    artefacts: {
      ansibleModules: ['ansible.windows.win_powershell'],
      runbook: ['SharePoint Migration Tool PowerShell per site list: Register-SPMTMigration, Add-SPMTTask, Start-SPMTMigration (verify the cmdlets against the SPMT version).'],
    },
    status: 'partial',
    facts: [
      fact('SharePoint Server 2016 and 2019 reach end of support on 2026-07-14.', MS_SOURCES.sharepointEos),
      fact('The SharePoint Migration Tool moves sites to SharePoint Online.', MS_SOURCES.spmt, 'C'),
    ],
    preferences: [
      { tierPattern: 'saas', delta: 5, rule: 'pattern.sharepoint.eos', reason: 'SharePoint 2016 / 2019 support ends 2026-07-14: SharePoint Online is the default.', source: MS_SOURCES.sharepointEos, verification: 'V-DOC', when: { key: 'version', values: ['2013', '2016', '2019'] } },
    ],
  },
  {
    id: 'dynamics-crm',
    family: 'microsoft',
    kind: 'cots',
    detectFrom: ['dynamics-crm'],
    questions: [{ key: 'crmVersion', label: 'CRM version', kind: 'select', options: ['8.x', '9.0', '9.1'], default: '9.1' }],
    rules: ['pattern.dynamics.op2ol'],
    components: [
      { name: 'CRM servers', tier: 'app', workloadTypes: ['dynamics-crm'], tierPattern: 'saas', alternatives: ['vm'] },
      { name: 'Organisation databases', tier: 'data', workloadTypes: ['db-host'], tierPattern: 'vm' },
    ],
    methods: ['rebuild'],
    artefacts: { runbook: ['Microsoft\'s on-premises-to-online migration programme (v9.0 / 9.1 sources); earlier versions upgrade first.'] },
    status: 'partial',
    facts: [fact('Dynamics 365 on-premises moves online through Microsoft\'s on-premises-to-online programme, from v9.0 / 9.1.', MS_SOURCES.op2ol)],
    preferences: [
      { tierPattern: 'saas', delta: 3, rule: 'pattern.dynamics.op2ol', reason: 'Dynamics 365 online through the on-premises-to-online programme (v9.0 / 9.1 sources).', source: MS_SOURCES.op2ol, verification: 'V-DOC', when: { key: 'crmVersion', values: ['9.0', '9.1'] } },
    ],
  },
  {
    id: 'iis-dotnet',
    family: 'microsoft',
    kind: 'home-grown',
    detectFrom: ['iis-dotnet'],
    questions: [{ key: 'dotnetRuntime', label: '.NET runtime', kind: 'select', options: ['framework-4x', 'net-6-plus'], default: 'framework-4x' }],
    rules: ['pattern.dotnet.runtime'],
    components: [{ name: 'Web tier', tier: 'web', workloadTypes: ['iis-dotnet'], tierPattern: 'vm', perPlatform: { azure: 'paas-web' }, alternatives: ['paas-web', 'containers', 'vm'] }],
    methods: ['rebuild', 'aws-mgn', 'azure-migrate', 'gcp-m2vm', 'oci-ocm'],
    artefacts: {
      ansibleModules: ['ansible.windows.win_feature', 'ansible.windows.win_powershell'],
      runbook: ['Assess with the App Service Migration Assistant, then zip-deploy (az webapp deploy --src-path) or rebuild.'],
    },
    sizing: 'server',
    status: 'automated',
    facts: [
      fact('Cloud Run runs Linux containers: .NET Framework applications do not run there.', MS_SOURCES.cloudRun),
      fact('AWS App2Container is closed to new customers from 2025-11-07; AWS Transform for .NET is the modernisation route.', MS_SOURCES.app2container, 'C'),
      fact('The App Service Migration Assistant assesses IIS sites for App Service.', MS_SOURCES.appServiceAssistant),
    ],
    preferences: [
      { tierPattern: 'paas-web', delta: 0, rule: 'pattern.dotnet.runtime', reason: '.NET Framework does not run on Cloud Run (Linux only): use Windows nodes on GKE or a VM.', source: MS_SOURCES.cloudRun, verification: 'V-DOC', platforms: ['google'], when: { key: 'dotnetRuntime', values: ['framework-4x'] }, eliminate: true },
      { tierPattern: 'paas-web', delta: 2, rule: 'pattern.dotnet.runtime', reason: 'App Service runs IIS / .NET sites as a managed platform.', source: MS_SOURCES.appServiceAssistant, verification: 'V-DOC', platforms: ['azure'] },
    ],
  },
];

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function eosRule(id        , pattern                           , eos        , product        , online        , source        )          {
  return rule          ({
    id,
    kind: 'any',
    verification: 'V-DOC',
    source,
    applies: (item, ctx) => patternOf(item, ctx) === pattern,
    findings: (item, ctx) => {
      const v = answersOf(item, ctx)['version'] ?? '';
      if (v === 'se') return [info(id, `${item.name}: ${product} Subscription Edition is supported on IaaS; ${online} remains the SaaS alternative.`, { source })];
      const past = ctx.today > eos;
      return [warning(id, `${item.name}: ${product} ${v || '2016 / 2019'} ${past ? 'left' : 'leaves'} support on ${eos}. ${online} is the default; on IaaS it runs only as ${product} Subscription Edition.`, {
        source,
        remediation: `Move to ${online}, or upgrade to ${product} Subscription Edition before (or as) it moves.`,
      })];
    },
  });
}

const frameworkOnGooglePaas = (item          , ctx             )          =>
  answersOf(item, ctx)['dotnetRuntime'] !== 'net-6-plus' && tierPatternOf(item, ctx, 'google') === 'paas-web';

export const MICROSOFT_RULES                     = [
  eosRule('pattern.exchange.eos', 'exchange', EXCHANGE_EOS, 'Exchange Server', 'Exchange Online', MS_SOURCES.eos2025),
  eosRule('pattern.sharepoint.eos', 'sharepoint', SHAREPOINT_EOS, 'SharePoint Server', 'SharePoint Online', MS_SOURCES.sharepointEos),
  rule          ({
    id: 'pattern.dynamics.op2ol',
    kind: 'any',
    verification: 'V-DOC',
    source: MS_SOURCES.op2ol,
    applies: (item, ctx) => patternOf(item, ctx) === 'dynamics-crm',
    findings: (item, ctx) => {
      const v = answersOf(item, ctx)['crmVersion'] ?? '';
      return [info('pattern.dynamics.op2ol', `${item.name}: Dynamics 365 online is reached through Microsoft's on-premises-to-online programme from v9.0 / 9.1${v && v !== '9.0' && v !== '9.1' ? `; ${v} upgrades first` : ''}.`, { source: MS_SOURCES.op2ol })];
    },
  }),
  rule          ({
    id: 'pattern.dotnet.runtime',
    kind: 'workload',
    verification: 'V-DOC',
    source: MS_SOURCES.cloudRun,
    applies: (w, ctx) => patternOf(w, ctx) === 'iis-dotnet',
    evaluate: (w, o, ctx) =>
      o.platform === 'google' && frameworkOnGooglePaas(w, ctx)
        ? { eliminate: true, reason: '.NET Framework does not run on Cloud Run (Linux containers only): choose Windows nodes on GKE or a VM for Google Cloud (GCP).' }
        : undefined,
    review: (w, chosen) =>
      chosen?.platform === 'aws'
        ? [info('pattern.dotnet.app2container', `${w.name}: AWS App2Container is closed to new customers (2025-11-07); for a managed .NET route on AWS use AWS Transform for .NET, else Elastic Beanstalk or a VM.`, { source: MS_SOURCES.app2container })]
        : [],
  }),
];
