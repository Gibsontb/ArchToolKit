/**
 * File and print (addendum A.4.2, A.4.6).
 *
 * - `pattern.file.service`: prefer the platform's managed file service (+2)
 *   when it carries the protocol; the NetApp-based services (FSx for NetApp
 *   ONTAP, Azure NetApp Files, Google Cloud NetApp Volumes) +3 more when the
 *   source is ONTAP (SnapMirror).
 * - Share cutover is a DFS Namespace target switch (`Set-DfsnFolderTarget`)
 *   when DFS-N exists, else a DNS CNAME switch. ACLs survive robocopy
 *   /COPY:DATSOU and Storage Mover; DataSync copies them with
 *   `SecurityDescriptorCopyFlags` = OWNER_DACL_SACL (verify).
 */

import { info } from '../../../core/findings.js';
import { rule,                                } from '../decide/engine.js';
                                                                  
import { answersOf, fact, patternOf, tierPatternOf,                   } from './model.js';

export const FILE_SOURCES = {
  fsx: 'https://docs.aws.amazon.com/fsx/latest/WindowsGuide/what-is.html',
  fsxOntap: 'https://docs.aws.amazon.com/fsx/latest/ONTAPGuide/what-is-fsx-ontap.html',
  azureFiles: 'https://learn.microsoft.com/en-us/azure/storage/files/storage-files-introduction',
  anf: 'https://learn.microsoft.com/en-us/azure/azure-netapp-files/azure-netapp-files-introduction',
  filestore: 'https://docs.cloud.google.com/filestore/docs/overview',
  netappVolumes: 'https://docs.cloud.google.com/netapp/volumes/docs/discover/overview',
  ociFss: 'https://docs.oracle.com/en-us/iaas/Content/File/Concepts/filestorageoverview.htm',
  datasync: 'https://docs.aws.amazon.com/datasync/latest/userguide/API_Options.html',
  storageMover: 'https://learn.microsoft.com/en-us/azure/storage-mover/service-overview',
  storageTransfer: 'https://docs.cloud.google.com/storage-transfer/docs/on-prem-set-up',
  dfsn: 'https://learn.microsoft.com/en-us/powershell/module/dfsn/set-dfsnfoldertarget',
  printbrm: 'https://learn.microsoft.com/en-us/troubleshoot/windows-server/printing/back-up-restore-printers',
  universalPrint: 'https://learn.microsoft.com/en-us/universal-print/fundamentals/universal-print-whatis',
}         ;

export const FILE_PATTERN_IDS                        = ['file-server', 'nas'];
                                                  

/** Which protocols the platform's managed file service carries (any of its services). */
export const FILE_PROTOCOLS                                                      = {
  aws: ['smb', 'nfs', 'both'],
  azure: ['smb', 'nfs', 'both'],
  google: ['smb', 'nfs', 'both'],
  oci: ['nfs'],
  vmware: [],
};
/** Platforms with a NetApp ONTAP-based managed service (SnapMirror from an ONTAP source). */
export const ONTAP_PLATFORMS                      = ['aws', 'azure', 'google'];

const QUESTIONS                            = [
  { key: 'tib', label: 'Data', kind: 'number', unit: 'TiB' },
  { key: 'files', label: 'Files', kind: 'number', unit: 'millions' },
  { key: 'protocol', label: 'Protocol', kind: 'select', options: ['smb', 'nfs', 'both'], default: 'smb' },
  { key: 'adAcls', label: 'AD ACLs', kind: 'yesno', default: 'yes' },
  { key: 'changeRate', label: 'Change rate', kind: 'number', unit: '%/day', default: '2' },
  { key: 'ontap', label: 'Source is NetApp ONTAP', kind: 'yesno', default: 'no' },
  { key: 'dfsn', label: 'DFS Namespaces in use', kind: 'yesno', default: 'no' },
];

const TRANSFER                                         = {
  aws: ['aws_datasync_location_smb', 'aws_datasync_location_nfs', 'aws_datasync_task'],
  azure: ['azurerm_storage_mover', 'azurerm_storage_mover_agent', 'azurerm_storage_mover_source_endpoint', 'azurerm_storage_mover_target_endpoint', 'azurerm_storage_mover_project', 'azurerm_storage_mover_job_definition', 'azurerm_storage_sync_group', 'azurerm_storage_sync_cloud_endpoint'],
  google: ['google_storage_transfer_agent_pool', 'google_storage_transfer_job'],
};

const FACTS = [
  fact('Amazon FSx for Windows File Server (SMB, AD-joined) and FSx for NetApp ONTAP (SMB / NFS / multiprotocol, SnapMirror).', `${FILE_SOURCES.fsx} ; ${FILE_SOURCES.fsxOntap}`),
  fact('Azure Files (SMB / NFS, with Azure File Sync) and Azure NetApp Files.', `${FILE_SOURCES.azureFiles} ; ${FILE_SOURCES.anf}`),
  fact('Filestore is NFS; Google Cloud NetApp Volumes carries SMB and NFS.', `${FILE_SOURCES.filestore} ; ${FILE_SOURCES.netappVolumes}`),
  fact('OCI File Storage is NFS.', FILE_SOURCES.ociFss),
  fact('Storage Transfer Service reads SMB only as a share mounted on the Linux agent host.', FILE_SOURCES.storageTransfer),
  fact('DataSync copies owner, DACL and SACL with SecurityDescriptorCopyFlags = OWNER_DACL_SACL (verify for the source).', FILE_SOURCES.datasync, 'C'),
];

export const FILE_PATTERNS                          = [
  ...(['file-server', 'nas']         ).map((id)               => ({
    id,
    family: 'file',
    kind: 'infrastructure',
    detectFrom: id === 'file-server' ? ['file-server'] : ['nas-gateway'],
    questions: QUESTIONS,
    rules: ['pattern.file.service'],
    components: [{ name: 'Shares', tier: 'file', workloadTypes: ['file-server', 'nas-gateway'], tierPattern: 'file-service', alternatives: ['vm'] }],
    methods: ['rebuild'],
    artefacts: {
      terraform: TRANSFER,
      ansibleModules: ['ansible.windows.win_powershell', 'community.windows.win_robocopy', 'ansible.posix.synchronize'],
      runbook: [
        'ONTAP to a cloud ONTAP service: SnapMirror (runbook).',
        'Cutover: Set-DfsnFolderTarget / New-DfsnFolderTarget when DFS-N exists, else a DNS CNAME switch.',
        'Fallback copy: robocopy /MIR /COPY:DATSOU, or rsync -aHAX.',
      ],
    },
    sizing: 'file',
    status: 'automated',
    facts: FACTS,
  })),
  {
    id: 'print',
    family: 'file',
    kind: 'infrastructure',
    detectFrom: ['print'],
    questions: [{ key: 'printers', label: 'Printers', kind: 'number' }, { key: 'universalPrint', label: 'Consider Universal Print', kind: 'yesno', default: 'no' }],
    rules: [],
    components: [{ name: 'Print servers', tier: 'infra', workloadTypes: ['print'], tierPattern: 'vm', alternatives: ['saas'] }],
    methods: ['rebuild'],
    artefacts: { ansibleModules: ['ansible.windows.win_command', 'ansible.windows.win_feature'], runbook: ['printbrm -b on the source, printbrm -r on the new server; or Universal Print (SaaS).'] },
    status: 'automated',
    facts: [fact('Printers move with printbrm backup (-b) and restore (-r).', FILE_SOURCES.printbrm), fact('Universal Print is Microsoft\'s cloud print service.', FILE_SOURCES.universalPrint)],
    preferences: [{ tierPattern: 'saas', delta: 2, rule: 'pattern.print.universal', reason: 'Universal Print replaces the print server.', source: FILE_SOURCES.universalPrint, verification: 'V-DOC', when: { key: 'universalPrint', values: ['yes'] } }],
  },
];

const isFile = (w          , ctx             )          => FILE_PATTERN_IDS.includes(patternOf(w, ctx) ?? 'generic');
const protocolOf = (a                                  )               => (a['protocol'] === 'nfs' || a['protocol'] === 'both' ? a['protocol'] : 'smb');

export const FILE_RULES                     = [
  rule          ({
    id: 'pattern.file.service',
    kind: 'workload',
    verification: 'V-DOC',
    source: `${FILE_SOURCES.fsx} ; ${FILE_SOURCES.azureFiles} ; ${FILE_SOURCES.filestore} ; ${FILE_SOURCES.ociFss}`,
    applies: isFile,
    evaluate: (w, o, ctx) => {
      const tp = tierPatternOf(w, ctx, o.platform);
      if (tp && tp !== 'file-service') return undefined;
      const a = answersOf(w, ctx);
      const protocol = protocolOf(a);
      if (!FILE_PROTOCOLS[o.platform].includes(protocol)) return undefined;
      const ontap = a['ontap'] === 'yes' && ONTAP_PLATFORMS.includes(o.platform);
      return ontap
        ? { delta: 5, reason: 'A managed NetApp ONTAP service carries the shares, and SnapMirror moves them from the ONTAP source.' }
        : { delta: 2, reason: `The managed file service carries ${protocol === 'both' ? 'SMB and NFS' : protocol.toUpperCase()}.` };
    },
    review: (w, _chosen, ctx) =>
      answersOf(w, ctx)['dfsn'] === 'yes'
        ? [info('pattern.file.dfsn', `${w.name}: shares cut over by switching the DFS Namespace folder targets (Set-DfsnFolderTarget).`, { source: FILE_SOURCES.dfsn })]
        : [],
  }),
];
