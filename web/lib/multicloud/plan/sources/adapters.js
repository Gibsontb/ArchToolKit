/**
 * Source adapters (addendum A.3.3): the execution kit's power and inventory
 * operations on a source server, whatever it runs on, rendered into
 * `migration/execute/source/` (file keys `source/<file>`, relative to the kit).
 *
 * Every adapter has the same verbs, `state | stop | start | snapshot |
 * delete | rename | tools-remove`, and keeps the kit's contract (A.6.2): it
 * applies by default (`--dry-run` / `-DryRun` prints instead), is idempotent
 * (each verb reads the state first and writes `skipped` when there is nothing
 * to do), takes credentials only from the environment, a mode-600 file or
 * `ATK_VAULT_CMD`, writes one status event per item and step, and uses the
 * kit's exit codes (0, 2, 3, 10, 1). Items are looked up in
 * `manifest/items.json` by id or name; their `source{platform, manager, id,
 * host, cluster, region, bmc}` is the `SourceRef` of the plan row.
 *
 * The non-x86 platforms and `other` share `operator.sh`, where every verb is
 * an operator step (skipped, with the reason); the runbook carries it.
 */

                                                            
import { ADAPTER_COMMON_PS1, ADAPTER_COMMON_SH, ADAPTER_SCRIPTS } from './adapter-scripts.js';

                                                                                                        
export const SOURCE_VERBS                        = Object.freeze(['state', 'stop', 'start', 'snapshot', 'delete', 'rename', 'tools-remove']);

                                    
                        
                                           
                                                          
                         
                                                                                
                                                
                                                                 
                                          
 

const OPERATOR                    = {
  file: 'operator.sh', language: 'bash', calls: 'none: every verb is an operator step (A.4.8)',
  operatorVerbs: ['stop', 'start', 'snapshot', 'delete', 'rename', 'tools-remove'], credentials: [],
};

export const SOURCE_ADAPTERS                                                      = Object.freeze({
  vsphere: { file: 'vsphere.ps1', language: 'powershell', calls: 'Stop-VMGuest then Stop-VM after the timeout / Start-VM / Remove-VM -DeletePermanently', operatorVerbs: [], credentials: ['VCENTER_USER', 'VCENTER_PASSWORD'] },
  hyperv: { file: 'hyperv.ps1', language: 'powershell', calls: 'Stop-VM (Invoke-Command on source.host) / Start-VM / Remove-VM -Force plus the VHDX files', operatorVerbs: [], credentials: ['HYPERV_USER (optional)', 'HYPERV_PASSWORD (optional)'] },
  ahv: { file: 'ahv.sh', language: 'bash', calls: 'v4 $actions/guest-shutdown then power-off / power-on / DELETE vms/{extId} (verify)', operatorVerbs: ['rename'], credentials: ['PRISM_USER', 'PRISM_PASSWORD'] },
  kvm: { file: 'kvm.sh', language: 'bash', calls: 'virsh shutdown then destroy / virsh start / virsh undefine --remove-all-storage --nvram (over ssh)', operatorVerbs: [], credentials: ['ssh keys (KVM_SSH_USER)'] },
  proxmox: { file: 'proxmox.sh', language: 'bash', calls: 'pvesh create …/status/shutdown / …/status/start / pvesh delete … --purge 1 (over ssh)', operatorVerbs: [], credentials: ['ssh keys (PVE_SSH_USER)'] },
  ovirt: { file: 'ovirt.sh', language: 'bash', calls: 'POST /vms/{id}/shutdown then /stop / POST /vms/{id}/start / DELETE /vms/{id}?detach_only=false', operatorVerbs: [], credentials: ['OVIRT_USER', 'OVIRT_PASSWORD'] },
  xen: { file: 'xen.sh', language: 'bash', calls: 'xe vm-shutdown (forced after the timeout) / xe vm-start / xe vm-uninstall force=true', operatorVerbs: [], credentials: ['XE_USER', 'XE_PASSWORD_FILE'] },
  physical: { file: 'physical.sh', language: 'bash', calls: 'Ansible shutdown in the guest / Redfish PowerOn through the BMC / delete: CMDB disposal (operator step)', operatorVerbs: ['snapshot', 'delete', 'rename'], credentials: ['BMC_USER', 'BMC_PASSWORD'] },
  aws: { file: 'aws.sh', language: 'bash', calls: 'aws ec2 stop-instances / start-instances / terminate-instances (DeleteOnTermination checked)', operatorVerbs: [], credentials: ['the AWS CLI chain'] },
  azure: { file: 'azure.ps1', language: 'powershell', calls: 'Stop-AzVM -Force / Start-AzVM / Remove-AzVM -Force plus its disks and NICs', operatorVerbs: [], credentials: ['managed identity or AZURE_FEDERATED_TOKEN_FILE'] },
  google: { file: 'gcp.sh', language: 'bash', calls: 'gcloud compute instances stop / start / delete --delete-disks=all', operatorVerbs: [], credentials: ['gcloud credentials'] },
  oci: { file: 'oci.sh', language: 'bash', calls: 'oci compute instance action SOFTSTOP / START / terminate --preserve-boot-volume false', operatorVerbs: [], credentials: ['the OCI CLI config'] },
  power: OPERATOR, sparc: OPERATOR, itanium: OPERATOR, 'pa-risc': OPERATOR, mainframe: OPERATOR, other: OPERATOR,
});

/** The folder the adapters go in, relative to `migration/execute/` (the kit's file keys). */
export const SOURCE_ADAPTER_DIR = 'source';

/**
 * A source adapter as the wave scripts call it (WP-12, `execute/waves/common.ts`):
 *   bash:       source/<file>.sh  VERB --item ID [--wave N] [--dry-run] [--timeout MIN] [--step STEP] [--path PATH]
 *   PowerShell: source/<file>.ps1 VERB -Item ID [-Wave N] [-DryRun] [-TimeoutMinutes MIN] [-Step STEP] [-Path PATH]
 */
                                   
                                    
                                        
                        
                              
                                                                          
                              
 

/** Every source platform's adapter, in the shape the wave scripts consume. */
export const SOURCE_ADAPTER_REFS                                                     = Object.freeze(Object.fromEntries(
  (Object.keys(SOURCE_ADAPTERS)                    ).map((p) => {
    const a = SOURCE_ADAPTERS[p];
    return [p, { platform: p, file: `${SOURCE_ADAPTER_DIR}/${a.file}`, lang: a.language === 'powershell' ? 'ps1' : 'sh', automated: a.file !== 'operator.sh' }];
  }),
)                                            );

/** One adapter's text, ready to run (the shared part spliced in). */
export function renderSourceAdapter(platform                )                                    {
  const info = SOURCE_ADAPTERS[platform];
  const raw = ADAPTER_SCRIPTS[info.file];
  if (raw === undefined) throw new Error(`missing adapter text ${info.file}`);
  const common = info.language === 'bash' ? ADAPTER_COMMON_SH : ADAPTER_COMMON_PS1;
  return { path: `${SOURCE_ADAPTER_DIR}/${info.file}`, content: raw.replace('# @@adapter-common@@\n', () => common) };
}

/**
 * The adapters a set of servers needs (one per distinct origin; rows with no
 * origin are vSphere), or every adapter when no rows are given. Path (relative
 * to `migration/execute/`) → text, for the execution kit.
 */
export function renderSourceAdapters(workloads                                      )                         {
  const platforms = workloads ? [...new Set(workloads.map((w) => w.origin ?? 'vsphere'))] : (Object.keys(SOURCE_ADAPTERS)                    );
  const out                         = {};
  for (const p of platforms.sort()) {
    const r = renderSourceAdapter(p);
    out[r.path] = r.content;
  }
  return out;
}

/** The command line an orchestrator runs for one verb on one item. */
export function adapterCommand(platform                , verb            , item        , opts                                         = {})         {
  const info = SOURCE_ADAPTERS[platform];
  const q = (s        )         => `'${s.replace(/'/g, `'\\''`)}'`;
  if (info.language === 'powershell') {
    return `pwsh -NoProfile -File source/${info.file} ${verb} -Item ${q(item)}${opts.newName ? ` -NewName ${q(opts.newName)}` : ''}${opts.dryRun ? ' -DryRun' : ''}`;
  }
  return `source/${info.file} ${verb} --item ${q(item)}${opts.newName ? ` --new-name ${q(opts.newName)}` : ''}${opts.dryRun ? ' --dry-run' : ''}`;
}
