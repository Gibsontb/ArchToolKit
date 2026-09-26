/**
 * Oracle applications (addendum A.4.2): E-Business Suite, PeopleSoft, JD
 * Edwards, Siebel and WebLogic applications.
 *
 * - `pattern.oracle-apps.oci-tooling`: OCI +3 for EBS and PeopleSoft, which
 *   have Oracle's own provisioning (EBS Cloud Manager, PeopleSoft Cloud
 *   Manager) there;
 * - `pattern.oracle-apps.mtr`: other clouds are allowed where the app's
 *   certification / minimum technical requirements allow (report-only).
 */

import { info } from '../../../core/findings.js';
                                                         
import { rule,              } from '../decide/engine.js';
                                              
import { fact, patternOf,                                        } from './model.js';

const EBS_LIFT = 'https://docs.oracle.com/en/solutions/lift-shift-oracle-e-business-suite/';
const MTR = 'https://learn.microsoft.com/en-us/azure/virtual-machines/workloads/oracle/oracle-overview';

export const ORACLE_APP_IDS                        = ['oracle-ebs', 'peoplesoft', 'jd-edwards', 'siebel', 'weblogic'];
const CLOUD_MANAGER                          = new Set(['oracle-ebs', 'peoplesoft']);

const QUESTIONS                            = [
  { key: 'release', label: 'Release', kind: 'text' },
  { key: 'dbVersion', label: 'Database version', kind: 'select', options: ['oracle-12.1', 'oracle-12.2', 'oracle-19c', 'oracle-26ai'], default: 'oracle-19c' },
  { key: 'tiers', label: 'Tiers', kind: 'select', options: ['single', 'multi'], default: 'multi' },
  { key: 'users', label: 'Users', kind: 'number' },
];

const FACTS = [
  fact('Lifting E-Business Suite to OCI uses EBS Cloud Manager for provisioning; PeopleSoft has PeopleSoft Cloud Manager.', EBS_LIFT),
  fact('Oracle applications run on other clouds where their certification / minimum technical requirements allow (for example JD Edwards 9.2 on any MTR-compliant cloud).', MTR, 'C'),
  fact('EBS 12.2 on 19c moves with Zero Downtime Migration.', 'https://docs.oracle.com/en/database/oracle/zero-downtime-migration/', 'C'),
];

function entry(id            , detectFrom                            )               {
  return {
    id,
    family: 'oracle-apps',
    kind: 'cots',
    detectFrom,
    questions: QUESTIONS,
    rules: [...(CLOUD_MANAGER.has(id) ? ['pattern.oracle-apps.oci-tooling'] : []), 'pattern.oracle-apps.mtr'],
    components: [
      { name: 'Application tier', tier: 'app', workloadTypes: detectFrom, tierPattern: 'vm', alternatives: ['vmware-service'] },
      { name: 'Database', tier: 'data', workloadTypes: ['db-host'], tierPattern: 'managed-db', alternatives: ['vm'] },
    ],
    methods: ['rebuild', 'oracle-zdm-physical', 'oracle-zdm-logical', 'oracle-dataguard'],
    artefacts: {
      ansibleModules: ['ansible.builtin.command', 'ansible.builtin.template'],
      runbook: [
        ...(CLOUD_MANAGER.has(id) ? [`${id === 'oracle-ebs' ? 'EBS' : 'PeopleSoft'} Cloud Manager provisioning on OCI (an OCI runbook step).`] : []),
        'Confirm the target against the application\'s certification / MTR before the move.',
        ...(id === 'weblogic' ? ['WebLogic: a VM, or the WebLogic for OCI / Azure marketplace offers (runbook).'] : []),
      ],
    },
    sizing: 'server',
    status: 'partial',
    facts: FACTS,
  };
}

export const ORACLE_APP_PATTERNS                          = [
  entry('oracle-ebs', ['oracle-ebs']),
  entry('peoplesoft', ['peoplesoft']),
  entry('jd-edwards', ['jd-edwards']),
  entry('siebel', ['siebel']),
  entry('weblogic', ['weblogic']),
];

export const ORACLE_APP_RULES                     = [
  rule          ({
    id: 'pattern.oracle-apps.oci-tooling',
    kind: 'any',
    verification: 'V-DOC',
    source: EBS_LIFT,
    applies: (item, ctx) => CLOUD_MANAGER.has(patternOf(item, ctx) ?? 'generic'),
    evaluate: (_item, o) => (o.platform === 'oci' ? { delta: 3, reason: 'Oracle\'s own provisioning (EBS / PeopleSoft Cloud Manager) runs on OCI.' } : undefined),
  }),
  rule          ({
    id: 'pattern.oracle-apps.mtr',
    kind: 'any',
    verification: 'C',
    source: MTR,
    applies: (item, ctx) => ORACLE_APP_IDS.includes(patternOf(item, ctx) ?? 'generic'),
    review: (item, chosen) =>
      chosen && chosen.platform !== 'oci'
        ? [info('pattern.oracle-apps.mtr', `${item.name}: on ${chosen.platform}, confirm the application's certification / minimum technical requirements for that cloud.`, { source: MTR })]
        : [],
  }),
];
