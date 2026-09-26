/**
 * Guest drivers and agents when the hypervisor changes (addendum A.3.5), as
 * data per move path, plus the source platform's own guest tools.
 *
 * For each path: what the migration tool itself does to the guest, and what
 * the kit's post-cutover play (`mig_source_tools`, WP-17) must still do:
 * remove the source platform's tools, install the target's, or a pre-step
 * before replication. `adaptationFor(source, path, os)` resolves one server's
 * steps and the prechecks that apply (for example the Azure-tuned Ubuntu
 * kernel that AWS Transform MGN does not convert).
 */

import { info, warning,              } from '../../../core/findings.js';
                                                                                  

/** A source platform's guest tools: package / service / product names per OS. */
                             
                                    
                                      
                                        
                         
                                      
                          
 

export const SOURCE_GUEST_TOOLS                                                        = Object.freeze({
  vsphere: { label: 'VMware Tools / open-vm-tools', linux: ['open-vm-tools', 'open-vm-tools-desktop'], windows: ['VMware Tools'], verification: 'C', source: 'https://knowledge.broadcom.com/external/article?legacyId=2073803' },
  ahv: { label: 'Nutanix Guest Tools', linux: ['nutanix-guest-agent'], windows: ['Nutanix Guest Tools', 'Nutanix VirtIO'], verification: 'I', source: 'https://portal.nutanix.com/page/documents/details?targetId=Prism-Central-Guide:mul-ngt-pc-uninstall-t.html' },
  xen: { label: 'XenServer VM Tools', linux: ['xe-guest-utilities', 'xenserver-guest-utilities'], windows: ['XenServer VM Tools', 'Citrix VM Tools', 'Citrix XenServer Windows Management Agent'], verification: 'I', source: 'https://docs.xenserver.com/en-us/xenserver/8/vm/windows.html' },
  hyperv: { label: 'Hyper-V Linux daemons', linux: ['hyperv-daemons', 'hyperv-tools', 'linux-cloud-tools-common'], windows: [], verification: 'C', source: 'https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/supported-linux-and-freebsd-virtual-machines-for-hyper-v-on-windows' },
  kvm: { label: 'QEMU guest agent', linux: ['qemu-guest-agent'], windows: ['QEMU guest agent'], verification: 'C', source: 'https://wiki.qemu.org/Features/GuestAgent' },
  proxmox: { label: 'QEMU guest agent', linux: ['qemu-guest-agent'], windows: ['QEMU guest agent'], verification: 'C', source: 'https://pve.proxmox.com/wiki/Qemu-guest-agent' },
  ovirt: { label: 'oVirt / RHV guest agent', linux: ['qemu-guest-agent', 'ovirt-guest-agent'], windows: ['oVirt Guest Tools', 'QEMU guest agent'], verification: 'C', source: 'https://www.ovirt.org/documentation/virtual_machine_management_guide/' },
  aws: { label: 'AWS agents (SSM Agent, EC2Launch, CloudWatch agent)', linux: ['amazon-ssm-agent', 'amazon-cloudwatch-agent', 'ec2-instance-connect'], windows: ['Amazon SSM Agent', 'EC2Launch', 'Amazon CloudWatch Agent'], verification: 'I', source: 'https://docs.aws.amazon.com/systems-manager/latest/userguide/manually-install-ssm-agent-linux.html' },
  azure: { label: 'Azure VM agent', linux: ['walinuxagent', 'WALinuxAgent'], windows: ['Windows Azure VM Agent'], verification: 'I', source: 'https://learn.microsoft.com/en-us/azure/virtual-machines/extensions/agent-linux' },
  google: { label: 'Google guest environment', linux: ['google-guest-agent', 'google-osconfig-agent', 'google-compute-engine'], windows: ['Google Compute Engine Windows guest agent'], verification: 'I', source: 'https://cloud.google.com/compute/docs/images/install-guest-environment' },
  oci: { label: 'Oracle Cloud Agent', linux: ['oracle-cloud-agent'], windows: ['Oracle Cloud Agent'], verification: 'I', source: 'https://docs.oracle.com/en-us/iaas/Content/Compute/Tasks/manage-plugins.htm' },
});

                                                                                                    

                                 
                                         
                          
                                                                  
                                       
                                                                       
                                                                                                
                                                                   
                            
                                                                      
                                                   
                                                                                            
                                             
                         
                                      
                          
 

const VMWARE_TOOLS = { linux: ['open-vm-tools'], windows: ['VMware Tools'] }         ;

export const PATH_ADAPTATION                                                      = Object.freeze({
  'aws-mgn': {
    byTool: 'Bootloader changes, hypervisor drivers (ENA / NVMe) and AWS tools are injected by the conversion server.',
    byKit: ['remove-source-tools', 'precheck'],
    note: 'Azure-tuned Ubuntu kernels (linux-azure) are not supported: switch to the generic or linux-aws kernel first. The Hyper-V Linux daemons are removed only when the source was Hyper-V.',
    verification: 'V-DOC', source: 'https://docs.aws.amazon.com/mgn/latest/ug/AWS-Related-FAQ.html',
  },
  'azure-migrate': {
    byTool: 'Windows: SAN policy and the VM agent. Linux (RHEL, SLES, Ubuntu, Debian, OL, Alma, Rocky): Hyper-V drivers in the initramfs (hv_vmbus, hv_storvsc, hv_netvsc), fstab to UUIDs, DHCP, waagent. Other distributions need manual preparation.',
    byKit: ['remove-source-tools'], keeps: ['hyperv'], note: 'Microsoft does not list removal of the source tools [U].',
    verification: 'V-DOC', source: 'https://learn.microsoft.com/en-us/azure/migrate/prepare-for-migration',
  },
  'azure-migrate-hyperv': {
    byTool: 'As Azure Migrate: the Hyper-V drivers are already in the guest.',
    byKit: ['remove-source-tools'], keeps: ['hyperv'], verification: 'V-DOC', source: 'https://learn.microsoft.com/en-us/azure/migrate/prepare-for-migration',
  },
  'azure-migrate-agent': {
    byTool: 'As Azure Migrate, through the Mobility service.',
    byKit: ['remove-source-tools'], keeps: ['hyperv'], note: 'Microsoft does not list removal of the source tools [U].',
    verification: 'V-DOC', source: 'https://learn.microsoft.com/en-us/azure/migrate/prepare-for-migration',
  },
  'gcp-m2vm': {
    byTool: 'Linux: virtio / initrd, guest environment, gVNIC; VMware Tools / open-vm-tools uninstalled. Windows: guest packages, gVNIC, VMware Tools removed, KMS.',
    byKit: ['remove-source-tools'], toolRemoves: ['vsphere'],
    verification: 'V-DOC', source: 'https://docs.cloud.google.com/migrate/virtual-machines/docs/5.0/resources/vm-adaptations',
  },
  'gcp-image-import': {
    byTool: 'As Migrate to Virtual Machines: the image import adapts the OS (virtio, guest environment, gVNIC; VMware Tools removed).',
    byKit: ['remove-source-tools'], toolRemoves: ['vsphere'],
    verification: 'V-DOC', source: 'https://docs.cloud.google.com/migrate/virtual-machines/docs/5.0/migrate/image_import',
  },
  'oci-ocm': {
    byTool: 'Not documented [U].',
    byKit: ['pre-install', 'remove-source-tools'],
    preStep: 'Windows: install virtio-win before replication (the Fedora virtio-win MSI from the URL the user names).',
    verification: 'I', source: 'https://docs.oracle.com/en-us/iaas/Content/cloud-migration/cloud-migration-overview.htm',
  },
  'hcx-osam': {
    byTool: 'The HCX Sentinel prepares the guest for vSphere.',
    byKit: ['install-target-tools', 'remove-source-tools'], install: VMWARE_TOOLS,
    verification: 'V-DOC', source: 'https://techdocs.broadcom.com/us/en/vmware-cis/hcx/vmware-hcx/9-0/vmware-hcx-user-guide-vcf-9-0/migrating-virtual-machines-with-vmware-hcx/understanding-vmware-hcx-os-assisted-migration/supported-guest-operating-systems.html',
  },
  'vcf-converter': {
    byTool: 'vCenter Converter reconfigures the guest for vSphere.',
    byKit: ['install-target-tools', 'remove-source-tools'], install: VMWARE_TOOLS,
    verification: 'V-DOC', source: 'https://techdocs.broadcom.com/us/en/vmware-cis/vsphere/vcenter-converter/9-0/release-notes-conv/vmware-vcenter-converter-standalone-90-release-notes.html',
  },
  rebuild: { byTool: 'None: a fresh image.', byKit: [], verification: 'V-DOC', source: 'addendum A.3.5' },
});

                            
                             
                                       
                        
 

                             
                          
                          
                                       
                                        
                                      
                          
 

const SAME_FAMILY                                                       = {
  // Moves within VMware keep the VMware tools.
  'hcx-bulk': ['vsphere'], 'hcx-rav': ['vsphere'], 'hcx-vmotion': ['vsphere'], 'hcx-cold': ['vsphere'], 'xvc-vmotion': ['vsphere'], 'vcf-import': ['vsphere'],
};

/**
 * One server's guest adaptation: the tool's part, the kit's steps (with the
 * package names for the guest's OS kind) and the prechecks that apply.
 * `osText` is the raw OS string, for the kernel precheck.
 */
export function adaptationFor(source                            , path          , os        , osText = '')             {
  const src = source ?? 'vsphere';
  const data = PATH_ADAPTATION[path];
  const findings            = [];
  if (!data) {
    const same = SAME_FAMILY[path]?.includes(src);
    return {
      path, byTool: same ? 'Same hypervisor family: the guest keeps its tools.' : 'No guest change by this path.',
      steps: [], findings, verification: 'V-DOC', source: 'addendum A.3.5',
    };
  }
  const steps              = [];
  const tools = SOURCE_GUEST_TOOLS[src];
  const osKey = os === 'windows' ? 'windows' : 'linux';
  if (data.preStep && os === 'windows') steps.push({ action: 'pre-install', packages: ['virtio-win'], text: data.preStep });
  if (data.byKit.includes('install-target-tools') && data.install) {
    steps.push({ action: 'install-target-tools', packages: [...data.install[osKey]], text: `Install ${data.install[osKey].join(', ')} after cutover.` });
  }
  if (data.byKit.includes('remove-source-tools') && tools && !(data.toolRemoves ?? []).includes(src) && !(data.keeps ?? []).includes(src)) {
    const pkgs = tools[osKey];
    // Hyper-V integration services are built into Windows Server 2016+ and Linux kernels: only the Linux daemons go.
    if (pkgs.length > 0) steps.push({ action: 'remove-source-tools', packages: [...pkgs], text: `Remove the ${tools.label} (${pkgs.join(', ')}) after cutover.` });
  }
  if (path === 'aws-mgn' && os === 'linux' && src === 'azure' && /ubuntu/i.test(osText)) {
    findings.push(warning('source.mgn-azure-kernel', 'An Ubuntu guest from Azure runs the linux-azure kernel, which AWS Transform MGN does not convert; switch to the generic or linux-aws kernel before replication.', {
      source: data.source, remediation: 'apt install linux-generic (or linux-aws), reboot into it, then remove linux-azure.',
    }));
    steps.push({ action: 'precheck', packages: ['linux-generic'], text: 'Switch from linux-azure to the generic or linux-aws kernel before replication.' });
  }
  if (data.verification !== 'V-DOC') {
    findings.push(info('source.adaptation-unverified', `The guest changes made by ${path} are not fully documented by the vendor; test the first move of each OS.`, { source: data.source }));
  }
  return { path, byTool: data.byTool, steps, findings, verification: data.verification, source: data.source };
}
