/**
 * Unix, legacy and mainframe: honest paths (addendum A.4.8).
 *
 * These are NOT automated. The Factory produces the assessment, a sourced
 * target recommendation and a runbook; it never produces replication scripts
 * that cannot exist. They are tracked on the path `specialist`, and their
 * state moves only by manual transitions.
 *
 * `pattern.legacy.specialist` places them honestly:
 * - AIX, IBM i and mainframe: no x86 platform carries them as they are, so
 *   every platform is eliminated; the targets are hosting partners (IBM Power
 *   Virtual Server, IBM Power for Google Cloud (Converge), Kyndryl Cloud Uplift
 *   on Azure; AWS Transform for mainframe, Azure rehost partners, Google Cloud
 *   Mainframe Refactor / Dual Run) — unless the workload is re-platformed to
 *   Linux x86 (disposition replatform / refactor);
 * - Solaris x86: OCI (Oracle Solaris 11.4 Marketplace image) and VCF;
 * - Solaris SPARC: no SPARC in any public cloud [U]; Charon-SSP emulation on
 *   an x86 VM;
 * - HP-UX on PA-RISC: Charon-PAR emulation; HP-UX on Itanium: re-platform
 *   only (no emulator), and HP-UX 11i v3 standard support ended 2025-12-31
 *   (`pattern.hpux.eos`, an error).
 */

import { error, info } from '../../../core/findings.js';
import { rule,                                } from '../decide/engine.js';
                                                                                
import { answersOf, fact, patternOf, workloadTypeOf,                              } from './model.js';

export const LEGACY_SOURCES = {
  powerVs: 'https://cloud.ibm.com/docs/power-iaas',
  converge: 'https://convergetp.com/converge-ip4g/',
  kyndryl: 'https://www.skytap.com/skytap-on-azure/',
  solarisOci: 'https://blogs.oracle.com/solaris/oracle-solaris-now-available-in-the-oci-marketplace',
  charonSsp: 'https://www.stromasys.com/solution/charon-ssp-sun-sparc-virtualization/',
  charonPar: 'https://learn.microsoft.com/azure/architecture/example-scenario/mainframe/hp-ux-stromasys-charon-par',
  m2: 'https://docs.aws.amazon.com/m2/latest/userguide/what-is-m2.html',
  azureMainframe: 'https://learn.microsoft.com/en-us/azure/architecture/browse/?terms=mainframe',
  googleMainframe: 'https://cloud.google.com/solutions/mainframe-modernization',
}         ;

                                                                                                   
export const LEGACY_TYPES                        = ['aix', 'ibm-i', 'solaris-sparc', 'solaris-x86', 'hp-ux', 'mainframe'];

/** The honest target options per type (report and runbook), each sourced. */
export const LEGACY_TARGETS                                                = {
  aix: [
    fact('IBM Power Virtual Server (IBM Cloud), moved with mksysb restore or Global Replication Services.', LEGACY_SOURCES.powerVs),
    fact('IBM Power for Google Cloud (Converge IP4G).', LEGACY_SOURCES.converge, 'C'),
    fact('Kyndryl Cloud Uplift on Azure (formerly Skytap on Azure; not retired).', LEGACY_SOURCES.kyndryl, 'C'),
    fact('Re-platform to Linux on x86 (a refactor).', LEGACY_SOURCES.powerVs, 'I'),
  ],
  'ibm-i': [
    fact('IBM Power Virtual Server (IBM Cloud), moved with a savesys / save-restore or Global Replication Services.', LEGACY_SOURCES.powerVs),
    fact('IBM Power for Google Cloud (Converge IP4G).', LEGACY_SOURCES.converge, 'C'),
    fact('Kyndryl Cloud Uplift on Azure (formerly Skytap on Azure).', LEGACY_SOURCES.kyndryl, 'C'),
  ],
  'solaris-x86': [fact('Oracle Solaris 11.4 images are in the OCI Marketplace: a VM on OCI.', LEGACY_SOURCES.solarisOci)],
  'solaris-sparc': [
    fact('No public cloud offers SPARC hardware.', LEGACY_SOURCES.charonSsp, 'I'),
    fact('Charon-SSP emulates SPARC on an x86 VM (the emulator vendor\'s documented size).', LEGACY_SOURCES.charonSsp, 'C'),
    fact('Or re-platform (Solaris x86 on OCI, or Linux).', LEGACY_SOURCES.solarisOci, 'I'),
  ],
  'hp-ux': [
    fact('Charon-PAR emulates HP-UX on PA-RISC (PA-RISC only) on an x86 VM.', LEGACY_SOURCES.charonPar),
    fact('HP-UX on Itanium: re-platform only; no emulator exists. HP-UX 11i v3 standard support ended 2025-12-31.', LEGACY_SOURCES.charonPar, 'C'),
  ],
  mainframe: [
    fact('AWS Transform for mainframe (the AWS Mainframe Modernization managed runtime is closed to new customers).', LEGACY_SOURCES.m2),
    fact('Azure mainframe rehost partner patterns.', LEGACY_SOURCES.azureMainframe),
    fact('Google Cloud Mainframe Refactor and Dual Run.', LEGACY_SOURCES.googleMainframe),
  ],
};

export const HPUX_EOS = '2025-12-31';

const RUNBOOK                                                  = {
  aix: ['Assess the LPARs (mksysb, rootvg size, application stack).', 'Choose the partner target; the partner moves the images (mksysb restore / GRS).', 'Or re-platform to Linux x86 as a refactor.'],
  'ibm-i': ['Assess the partitions and save strategy.', 'Choose the partner target; restore from savesys / save media or replicate with GRS.'],
  'solaris-x86': ['Deploy the Oracle Solaris 11.4 OCI Marketplace image (a VM).', 'Move the zones / applications (archive and restore, or reinstall).'],
  'solaris-sparc': ['Size the x86 VM from the emulator vendor\'s guidance; install Charon-SSP.', 'Move the disk images into the emulated SPARC host; or re-platform.'],
  'hp-ux': ['PA-RISC: size the x86 VM for Charon-PAR and move the disk images.', 'Itanium: re-platform (no emulator exists).'],
  mainframe: ['Portfolio assessment with the provider\'s mainframe programme or partner.', 'Choose rehost (partner runtime), refactor (AWS Transform / Mainframe Refactor) or replace.'],
};

const QUESTIONS                            = [
  { key: 'osVersion', label: 'OS version', kind: 'text' },
  { key: 'hpuxHardware', label: 'HP-UX hardware', kind: 'select', options: ['itanium', 'pa-risc'], default: 'itanium' },
  { key: 'target', label: 'Target direction', kind: 'select', options: ['partner', 'emulate', 're-platform', 'retain'], default: 'partner' },
];

export const LEGACY_PATTERNS                          = LEGACY_TYPES.map((id)               => ({
  id,
  family: 'legacy',
  kind: 'packaged',
  detectFrom: [id                ],
  questions: QUESTIONS,
  rules: ['pattern.legacy.specialist', ...(id === 'hp-ux' ? ['pattern.hpux.eos'] : [])],
  components: [{ name: 'Servers', tier: 'app', workloadTypes: [id                ], tierPattern: id === 'solaris-x86' ? 'vm' : 'specialist', alternatives: id === 'solaris-x86' ? ['specialist'] : ['vm', 'retain'] }],
  methods: ['specialist'],
  artefacts: { runbook: RUNBOOK[id] },
  status: id === 'solaris-x86' ? 'partial' : 'honest-path',
  facts: LEGACY_TARGETS[id],
}));

/** The legacy type of a workload: its type, else its origin (decisive for non-x86), else the app's pattern. */
export function legacyTypeOf(w          , ctx              )                         {
  const t = workloadTypeOf(w);
  if (t && (LEGACY_TYPES                     ).includes(t)) return t              ;
  switch (w.origin) {
    case 'power': return /\b(ibm ?i|os\/?400|i5\/os)\b/i.test(w.facts?.guestOsRaw ?? '') ? 'ibm-i' : 'aix';
    case 'sparc': return 'solaris-sparc';
    case 'itanium':
    case 'pa-risc': return 'hp-ux';
    case 'mainframe': return 'mainframe';
    default: break;
  }
  const p                         = ctx ? patternOf(w, ctx) : undefined;
  return p && (LEGACY_TYPES                     ).includes(p) ? (p              ) : undefined;
}

function hpuxItanium(w          , ctx             )          {
  if (w.origin === 'pa-risc') return false;
  if (w.origin === 'itanium') return true;
  return answersOf(w, ctx)['hpuxHardware'] !== 'pa-risc';
}

const replatformed = (w          )          => w.disposition === 'replatform' || w.disposition === 'refactor' || w.disposition === 'retire' || w.disposition === 'retain';
const X86_ONLY_NOTE = 'runs on a specialist partner (runbook only; see the target options)';

export const LEGACY_RULES                     = [
  rule          ({
    id: 'pattern.legacy.specialist',
    kind: 'workload',
    verification: 'C',
    source: `${LEGACY_SOURCES.powerVs} ; ${LEGACY_SOURCES.solarisOci} ; ${LEGACY_SOURCES.charonSsp} ; ${LEGACY_SOURCES.charonPar} ; ${LEGACY_SOURCES.m2}`,
    applies: (w, ctx) => legacyTypeOf(w, ctx) !== undefined && !replatformed(w),
    evaluate: (w, o, ctx) => {
      const t = legacyTypeOf(w, ctx) ;
      const p           = o.platform;
      switch (t) {
        case 'aix':
        case 'ibm-i':
        case 'mainframe':
          return { eliminate: true, reason: `${t === 'mainframe' ? 'A mainframe workload' : t === 'aix' ? 'AIX' : 'IBM i'} cannot run on ${p} as it is: it ${X86_ONLY_NOTE}, or re-platform it.` };
        case 'solaris-x86':
          if (p === 'oci') return { delta: 2, reason: 'Oracle Solaris 11.4 is in the OCI Marketplace.' };
          if (p === 'vmware') return { delta: 0, reason: 'Solaris x86 runs as a vSphere guest [U: check the Broadcom compatibility guide].' };
          return { eliminate: true, reason: `${p} offers no Solaris image.` };
        case 'solaris-sparc':
          return { delta: -2, reason: 'No SPARC in any public cloud [U]: only through Charon-SSP emulation on an x86 VM.' };
        case 'hp-ux':
          return hpuxItanium(w, ctx)
            ? { eliminate: true, reason: 'HP-UX on Itanium has no emulator: re-platform only.' }
            : { delta: -2, reason: 'HP-UX on PA-RISC only through Charon-PAR emulation on an x86 VM.' };
        default:
          return undefined;
      }
    },
    findings: (w, ctx) => {
      const t = legacyTypeOf(w, ctx) ;
      return [info('pattern.legacy.honest-path', `${w.name}: ${t} is an honest path — assessment, a target recommendation and a runbook; nothing is replicated automatically. Options: ${LEGACY_TARGETS[t].map((f) => f.text).join(' / ')}`, {
        source: LEGACY_TARGETS[t][0] .source,
        remediation: 'Choose a partner target, emulation or a re-platform (set the disposition to replatform / refactor to plan it on x86).',
      })];
    },
  }),
  rule          ({
    id: 'pattern.hpux.eos',
    kind: 'workload',
    verification: 'C',
    source: LEGACY_SOURCES.charonPar,
    applies: (w, ctx) => legacyTypeOf(w, ctx) === 'hp-ux' && ctx.today > HPUX_EOS,
    findings: (w) => [error('pattern.hpux.eos', `${w.name}: HP-UX 11i v3 standard support ended ${HPUX_EOS}.`, {
      source: LEGACY_SOURCES.charonPar,
      remediation: 'Plan the re-platform; Itanium has no emulator, and PA-RISC only Charon-PAR.',
    })],
  }),
];
