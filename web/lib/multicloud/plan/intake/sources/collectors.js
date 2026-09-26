/**
 * The discovery collectors the Sources screen hands out (addendum A.3.2), for
 * platforms with no standard export and for what only the guest knows
 * (installed software, services, listening ports, connections, utilisation).
 *
 * Every collector writes the same `archtoolkit.discovery` v1 file, read by
 * `discovery.ts`; `collect-k8s.sh` also writes the kubectl exports the
 * Kubernetes sizing import reads. None writes a user name, the collector's
 * host name or a path, and credentials come from the environment, a mode-600
 * file or the vault hook (`ATK_VAULT_CMD`), never from the scripts.
 *
 * The scripts are static text (`collector-scripts.ts`): nothing is templated
 * per plan, so the same bundle can be handed to any team. `collectorBundle`
 * zips them reproducibly (fixed date, sorted entries).
 */

import { zip } from '../../../../kit/archive.js';
                                                     
import { COLLECTOR_COMMON_SH, COLLECTOR_SCRIPTS } from './collector-scripts.js';

                                                                                              
                                                                  

                                
                           
                        
                                                                                                    
                                    
                                           
                          
                                    
                                                                        
                                          
                                                 
                                                 
                          
 

export const COLLECTORS                           = Object.freeze([
  { id: 'hyperv', file: 'collect-hyperv.ps1', platform: 'hyperv', language: 'powershell', runsOn: 'a Hyper-V host or cluster node', needs: ['Hyper-V module', 'FailoverClusters module (-Cluster)'], credentials: [], output: 'discovery', source: 'https://learn.microsoft.com/en-us/powershell/module/hyper-v/get-vm' },
  { id: 'scvmm', file: 'collect-scvmm.ps1', platform: 'hyperv', language: 'powershell', runsOn: 'a host with the VMM console', needs: ['VirtualMachineManager module'], credentials: [], output: 'discovery', source: 'https://learn.microsoft.com/en-us/powershell/module/virtualmachinemanager/get-scvirtualmachine' },
  { id: 'ahv', file: 'collect-ahv.sh', platform: 'ahv', language: 'bash', runsOn: 'the migration controller (reaches Prism Central on 9440)', needs: ['curl', 'jq'], credentials: ['PRISM_CENTRAL', 'PRISM_USER', 'PRISM_PASSWORD'], output: 'discovery', source: 'https://developers.nutanix.com/api-reference?namespace=vmm&version=v4.1' },
  { id: 'libvirt', file: 'collect-libvirt.sh', platform: 'kvm', language: 'bash', runsOn: 'a KVM host (or with LIBVIRT_DEFAULT_URI)', needs: ['virsh', 'jq', 'xmllint (optional)'], credentials: [], output: 'discovery', source: 'https://libvirt.org/manpages/virsh.html' },
  { id: 'proxmox', file: 'collect-proxmox.sh', platform: 'proxmox', language: 'bash', runsOn: 'a Proxmox VE node, as root', needs: ['pvesh', 'jq'], credentials: [], output: 'discovery', source: 'https://pve.proxmox.com/pve-docs/api-viewer/' },
  { id: 'ovirt', file: 'collect-ovirt.sh', platform: 'ovirt', language: 'bash', runsOn: 'the migration controller (reaches the engine)', needs: ['curl', 'jq'], credentials: ['OVIRT_URL', 'OVIRT_USER', 'OVIRT_PASSWORD'], output: 'discovery', source: 'https://ovirt.github.io/ovirt-engine-api-model/master/' },
  { id: 'xen', file: 'collect-xen.sh', platform: 'xen', language: 'bash', runsOn: 'the pool master (or with XE_HOST)', needs: ['xe', 'jq'], credentials: ['XE_HOST', 'XE_USER', 'XE_PASSWORD_FILE'], output: 'discovery', source: 'https://docs.xenserver.com/en-us/xenserver/8/command-line-interface.html' },
  { id: 'windows', file: 'collect-windows.ps1', platform: 'physical', language: 'powershell', runsOn: 'each Windows guest (discover.yml runs it)', needs: ['Windows PowerShell 5.1 or PowerShell 7'], credentials: [], output: 'discovery', source: 'https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.diagnostics/get-counter' },
  { id: 'linux', file: 'collect-linux.sh', platform: 'physical', language: 'bash', runsOn: 'each Linux guest (discover.yml runs it)', needs: ['bash 4', 'iproute2', 'util-linux', 'sysstat (optional)'], credentials: [], output: 'discovery', source: 'https://man7.org/linux/man-pages/man8/ss.8.html' },
  { id: 'aws', file: 'collect-aws.sh', platform: 'aws', language: 'bash', runsOn: 'the migration controller', needs: ['aws CLI v2', 'jq'], credentials: ['the AWS CLI chain'], output: 'discovery', source: 'https://docs.aws.amazon.com/cli/latest/reference/ec2/describe-instances.html' },
  { id: 'azure', file: 'collect-azure.sh', platform: 'azure', language: 'bash', runsOn: 'the migration controller', needs: ['az CLI', 'jq'], credentials: ['the az sign-in'], output: 'discovery', source: 'https://learn.microsoft.com/en-us/cli/azure/vm#az-vm-list' },
  { id: 'gcp', file: 'collect-gcp.sh', platform: 'google', language: 'bash', runsOn: 'the migration controller', needs: ['gcloud', 'jq'], credentials: ['gcloud credentials'], output: 'discovery', source: 'https://cloud.google.com/sdk/gcloud/reference/compute/instances/list' },
  { id: 'oci', file: 'collect-oci.sh', platform: 'oci', language: 'bash', runsOn: 'the migration controller', needs: ['oci CLI', 'jq'], credentials: ['OCI_COMPARTMENT_ID', 'the OCI CLI config'], output: 'discovery', source: 'https://docs.oracle.com/en-us/iaas/tools/oci-cli/latest/oci_cli_docs/cmdref/compute/instance/list.html' },
  { id: 'k8s', file: 'collect-k8s.sh', platform: 'other', language: 'bash', runsOn: 'the migration controller (kubectl context)', needs: ['kubectl', 'jq'], credentials: ['the kubeconfig'], output: 'discovery+k8s', source: 'https://kubernetes.io/docs/reference/kubectl/' },
]                                   );

/** The Ansible play that runs the guest collectors and fetches their files. */
export const DISCOVER_PLAYBOOK = 'discover.yml';

/** The collectors that cover a source platform (the guest collectors cover every one). */
export function collectorsFor(platform                )                  {
  const own = COLLECTORS.filter((c) => c.platform === platform && c.id !== 'windows' && c.id !== 'linux');
  const guest = ['power', 'sparc', 'itanium', 'pa-risc', 'mainframe'].includes(platform) ? [] : COLLECTORS.filter((c) => c.id === 'windows' || c.id === 'linux');
  return [...own, ...guest];
}

/** One collector's text, ready to run (bash collectors get the shared part spliced in). */
export function renderCollector(id             )                                    {
  const info = COLLECTORS.find((c) => c.id === id);
  if (!info) throw new Error(`unknown collector ${id}`);
  const raw = COLLECTOR_SCRIPTS[info.file];
  if (raw === undefined) throw new Error(`missing collector text ${info.file}`);
  return { path: info.file, content: raw.replace('# @@common@@\n', () => COLLECTOR_COMMON_SH) };
}

function readme(ids                        )         {
  const rows = COLLECTORS.filter((c) => ids.includes(c.id)).map((c) => `| \`${c.file}\` | ${c.runsOn} | ${c.needs.join(', ')} | ${c.credentials.length > 0 ? c.credentials.map((v) => `\`${v}\``).join(', ') : 'none'} |`);
  return [
    '# Discovery collectors',
    '',
    'Each script writes one `archtoolkit.discovery` v1 JSON file. Import the files on the Sources screen',
    '(**Collector files**); several files from several platforms can be imported together.',
    '',
    '| Script | Runs on | Needs | Credentials (environment) |',
    '|---|---|---|---|',
    ...rows,
    '',
    '## Guests: `discover.yml`',
    '',
    '```',
    'ansible-playbook -i inventory discover.yml                                    # inventory now',
    'ansible-playbook -i inventory discover.yml -e atk_mode=start -e atk_days=14   # start utilisation sampling',
    'ansible-playbook -i inventory discover.yml                                    # after the window: with percentiles',
    'ansible-playbook -i inventory discover.yml -e atk_mode=stop                   # remove the sampling schedules',
    '```',
    '',
    'The files land in `reports/discovery/<host>.json`.',
    '',
    '## Credentials',
    '',
    'A credential `NAME` is read from `$NAME`, else from the file named in `$NAME_FILE` (mode 600),',
    'else from `$ATK_VAULT_CMD NAME` (for example `vault kv get -field=value secret/migration/NAME`).',
    'The cloud collectors use their CLI\'s own sign-in. Nothing is written but the output file, and the',
    'output holds no user name, collector host name or path.',
    '',
  ].join('\n');
}

/** Bundle files: path → text (the collectors, discover.yml and a README). */
export function collectorFiles(ids                         = COLLECTORS.map((c) => c.id))                         {
  const files                         = {};
  for (const id of ids) {
    const r = renderCollector(id);
    files[r.path] = r.content;
  }
  if (ids.includes('windows') || ids.includes('linux')) files[DISCOVER_PLAYBOOK] = COLLECTOR_SCRIPTS[DISCOVER_PLAYBOOK] ;
  files['README.md'] = readme(ids);
  return files;
}

/** The fixed timestamp that keeps the zip reproducible. */
export const BUNDLE_DATE = new Date(1980, 0, 1);

/** The collectors as one reproducible zip (under `discovery/`). */
export async function collectorBundle(ids                         )                      {
  const files = collectorFiles(ids);
  return zip(Object.fromEntries(Object.entries(files).map(([p, c]) => [`discovery/${p}`, c])), BUNDLE_DATE);
}
