/**
 * The Ansible collections this kit can author for.
 *
 * Since ansible-core 2.10 almost nothing ships in the box: every cloud module
 * lives in a collection that has to be installed, and a playbook that names a
 * module without requiring its collection fails at run time with a message that
 * says the module does not exist. So the kit tracks collections rather than
 * modules, and always emits a requirements.yml alongside the playbook.
 *
 * Versions were read from the Ansible Galaxy API rather than from memory. A
 * wrong version in requirements.yml either pins to a release that does not
 * exist, or silently installs a major line whose modules were renamed.
 *
 * Authentication is described, never generated. Each collection has its own
 * credential chain — environment variables, a cloud CLI profile, a vault — and
 * writing credentials into a playbook or an inventory is how Ansible
 * repositories leak.
 *
 * Verification: V-DOC (galaxy.ansible.com API v3, retrieved 2026-09-20).
 */

                                                                                                                        

                                 
                                                            
                        
                                 
                         
                                                             
                           
                                                             
                                   
                                                                                  
                               
                                                                            
                             
                                                                            
                         
     
                                                                     
                                                     
     
                             
     
                                                                               
                                                       
    
                                                                              
                                                                              
                                                                           
                                                                               
                                                                           
                                                                          
     
                          
 

export const COLLECTIONS                            = [
  {
    name: 'ansible.builtin',
    target: 'general',
    label: 'Ansible built-ins',
    version: 'bundled with ansible-core',
    observedVersion: 'bundled with ansible-core',
    builtin: true,
    credentials: 'None of its own; connection credentials come from the inventory and the connection plugin.',
    note: 'Ships inside ansible-core. Listing it in requirements.yml is an error.',
  },
  {
    name: 'vmware.vmware',
    target: 'vmware',
    label: 'VMware (current)',
    version: '>=2.10.0,<3.0.0',
    observedVersion: '2.10.0',
    credentials:
      'VMWARE_HOST, VMWARE_USER, VMWARE_PASSWORD, or the hostname/username/password module arguments. Prefer a vault-encrypted variable file over either.',
    requires: 'pyVmomi, and vSphere Automation SDK for the modules that use the REST API.',
    note: 'The supported VMware collection. New work belongs here.',
  },
  {
    name: 'vmware.vmware_rest',
    target: 'vmware',
    label: 'VMware vSphere REST API',
    version: '>=4.11.0,<5.0.0',
    observedVersion: '4.11.0',
    credentials: 'VMWARE_HOST, VMWARE_USER, VMWARE_PASSWORD, or per-task vcenter_* arguments.',
    requires: 'aiohttp on the control node. It talks to the vSphere REST API directly, not through pyVmomi.',
    note: 'Generated from the vSphere REST specification, so it tracks the API rather than the SDK.',
  },
  {
    name: 'community.vmware',
    target: 'vmware',
    label: 'VMware (community, legacy)',
    version: '>=6.4.0,<7.0.0',
    observedVersion: '6.4.0',
    credentials: 'VMWARE_HOST, VMWARE_USER, VMWARE_PASSWORD, or module arguments of the same names.',
    requires: 'pyVmomi.',
    note:
      'Still maintained and still carries modules that vmware.vmware has not replaced. Use it where the current collection has no equivalent, not by default.',
  },
  {
    name: 'amazon.aws',
    target: 'aws',
    label: 'Amazon Web Services',
    version: '>=11.4.0,<12.0.0',
    observedVersion: '11.4.0',
    credentials:
      'The standard AWS credential chain: environment variables, a shared profile, SSO, or an instance role. Prefer a profile or SSO over static keys in a variable file.',
    requires: 'boto3 and botocore on the control node.',
    note: 'The supported half of the AWS modules.',
  },
  {
    name: 'community.aws',
    target: 'aws',
    label: 'AWS (community)',
    version: '>=11.1.0,<12.0.0',
    observedVersion: '11.1.0',
    credentials: 'Same credential chain as amazon.aws; it reuses that collection’s connection plugins.',
    requires: 'boto3 and botocore, and amazon.aws, which it depends on.',
    note: 'Services amazon.aws does not cover. It cannot be installed on its own.',
  },
  {
    name: 'azure.azcollection',
    target: 'azure',
    label: 'Microsoft Azure',
    version: '>=4.0.0,<5.0.0',
    observedVersion: '4.0.0',
    credentials:
      'An Azure CLI login, a service principal via AZURE_CLIENT_ID / AZURE_SECRET / AZURE_TENANT / AZURE_SUBSCRIPTION_ID, or a managed identity.',
    requires:
      'A long list of azure-* Python packages. The collection ships a requirements.txt; install it with pip rather than guessing.',
  },
  {
    name: 'google.cloud',
    target: 'google',
    label: 'Google Cloud (GCP)',
    version: '>=1.14.0,<2.0.0',
    observedVersion: '1.14.0',
    credentials:
      'A service account JSON key referenced by path, application default credentials, or a machine account. The key file belongs outside the repository.',
    requires: 'requests and google-auth on the control node.',
  },
  {
    name: 'oracle.oci',
    target: 'oci',
    label: 'Oracle Cloud Infrastructure',
    version: '>=5.5.0,<6.0.0',
    observedVersion: '5.5.0',
    credentials:
      'An OCI config file (~/.oci/config) and API signing key, instance principal, or resource principal. The signing key is never written into a playbook.',
    requires: 'The oci Python SDK on the control node.',
  },
  {
    name: 'ansible.posix',
    target: 'posix',
    label: 'POSIX hosts',
    version: '>=2.2.2,<3.0.0',
    observedVersion: '2.2.2',
    credentials: 'SSH, from the inventory. No credentials of its own.',
  },
  {
    name: 'ansible.windows',
    target: 'windows',
    label: 'Windows hosts',
    version: '>=3.8.0,<4.0.0',
    observedVersion: '3.8.0',
    credentials:
      'WinRM or SSH, configured in the inventory: ansible_user, ansible_password and ansible_connection. Use a vault or Kerberos rather than a plaintext password.',
    requires: 'pywinrm on the control node for the WinRM transport.',
  },
  {
    name: 'microsoft.ad',
    target: 'windows',
    label: 'Active Directory',
    version: '>=1.12.1,<2.0.0',
    observedVersion: '1.12.1',
    credentials:
      'Domain credentials from the inventory or a vault, usually over WinRM with Kerberos. A domain join password never belongs in a playbook.',
    requires: 'A Windows host; the modules run there, not on the control node.',
    note:
      'Where the Active Directory modules live now. ansible.windows 3.8.0 no longer carries win_domain_membership and the rest of the domain modules.',
  },
  {
    name: 'community.general',
    target: 'general',
    label: 'Community general',
    version: '>=13.4.0,<14.0.0',
    observedVersion: '13.4.0',
    credentials: 'Varies by module; most take their own arguments.',
    note: 'Large and broad. Pull it in for a specific module, not as a default.',
  },
  {
    name: 'cisco.ios',
    target: 'network',
    label: 'Cisco IOS and IOS-XE',
    version: 'latest',
    observedVersion: 'not read from Galaxy by this build',
    pinned: false,
    credentials:
      'SSH from the inventory: ansible_user, ansible_password or an SSH key, with ansible_connection=ansible.netcommon.network_cli and ansible_network_os=cisco.ios.ios. Enable secrets belong in a vault, never in a playbook.',
    requires: 'ansible.netcommon on the control node for the network_cli connection.',
  },
  {
    name: 'cisco.nxos',
    target: 'network',
    label: 'Cisco NX-OS',
    version: 'latest',
    observedVersion: 'not read from Galaxy by this build',
    pinned: false,
    credentials: 'SSH or NX-API from the inventory, with ansible_network_os=cisco.nxos.nxos.',
    requires: 'ansible.netcommon on the control node.',
  },
  {
    name: 'cisco.asa',
    target: 'network',
    label: 'Cisco ASA',
    version: 'latest',
    observedVersion: 'not read from Galaxy by this build',
    pinned: false,
    credentials: 'SSH from the inventory, with ansible_network_os=cisco.asa.asa. The enable secret belongs in a vault.',
    requires: 'ansible.netcommon on the control node.',
  },
  {
    name: 'arista.eos',
    target: 'network',
    label: 'Arista EOS',
    version: 'latest',
    observedVersion: 'not read from Galaxy by this build',
    pinned: false,
    credentials: 'SSH or eAPI from the inventory, with ansible_network_os=arista.eos.eos.',
    requires: 'ansible.netcommon on the control node.',
  },
  {
    name: 'ansible.netcommon',
    target: 'network',
    label: 'Network connection plugins',
    version: 'latest',
    observedVersion: 'not read from Galaxy by this build',
    pinned: false,
    credentials: 'None of its own; it provides the network_cli and httpapi connections the vendor collections use.',
  },
  {
    name: 'paloaltonetworks.panos',
    target: 'network',
    label: 'Palo Alto PAN-OS',
    version: 'latest',
    observedVersion: 'not read from Galaxy by this build',
    pinned: false,
    credentials:
      'An API key or username and password for the firewall or Panorama, supplied as a provider dictionary from a vault or the environment.',
    requires: 'pan-os-python on the control node.',
  },
  {
    name: 'fortinet.fortios',
    target: 'network',
    label: 'Fortinet FortiOS',
    version: 'latest',
    observedVersion: 'not read from Galaxy by this build',
    pinned: false,
    credentials: 'A FortiGate API token (ansible_httpapi_*) from a vault, over the httpapi connection.',
    requires: 'ansible.netcommon on the control node.',
  },
  {
    name: 'f5networks.f5_modules',
    target: 'network',
    label: 'F5 BIG-IP',
    version: 'latest',
    observedVersion: 'not read from Galaxy by this build',
    pinned: false,
    credentials:
      'BIG-IP credentials as a provider dictionary from a vault or the environment. An AS3 declaration is posted to the management API; it carries no passwords of its own here.',
    requires: 'A BIG-IP reachable from the control node.',
  },
  {
    // The declarative collection: bigip_as3_deploy lives here, not in
    // f5_modules. It connects over httpapi rather than a provider dictionary.
    // clouddocs.f5.com/products/orchestration/ansible/devel/f5_bigip/modules_2_0/bigip_as3_deploy_module.html
    name: 'f5networks.f5_bigip',
    target: 'network',
    label: 'F5 BIG-IP (declarative: AS3, DO, TS)',
    version: 'latest',
    observedVersion: 'not read from Galaxy by this build',
    pinned: false,
    credentials: 'BIG-IP credentials as ansible_user / ansible_password (httpapi) from a vault.',
    requires: 'ansible.netcommon on the control node, and the AS3 RPM installed on the BIG-IP.',
  },
];

export function collectionFor(name        )                             {
  return COLLECTIONS.find((c) => c.name === name);
}

export function collectionsForTarget(target               )                            {
  return COLLECTIONS.filter((c) => c.target === target);
}

/** Collections that belong in requirements.yml — built-ins never do. */
export function installable(names                   )                            {
  const seen = new Set        ();
  const out                   = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const info = collectionFor(name);
    if (info && !info.builtin) out.push(info);
  }
  return out;
}

/**
 * The collection a fully qualified module name belongs to.
 *
 * An FQCN is namespace.collection.module, so the collection is the first two
 * segments. A short module name has no collection and returns undefined, which
 * is itself worth reporting: short names resolve through the collections search
 * path and are the usual cause of a playbook that runs on one control node and
 * not another.
 */
export function collectionOfModule(module        )                     {
  const parts = module.split('.');
  return parts.length >= 3 ? `${parts[0]}.${parts[1]}` : undefined;
}
