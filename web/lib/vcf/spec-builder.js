/**
 * `SddcSpec` generation from a deployment plan.
 *
 * Takes the handful of decisions an architect actually makes — naming, subnets,
 * VLANs, storage, scale, greenfield or brownfield — and derives a complete VCF
 * 9.1 specification, including the components the existing public builders omit
 * entirely: `vspClusterSpec`, `vidbSpec`, `licenseServerSpec`, the fleet
 * services, VPC/DTGW, and LACP.
 *
 * Secrets are never invented. Any password the plan does not supply is emitted
 * as a placeholder that validation then flags, so a spec can be reviewed and
 * shared safely before credentials are added.
 */

import {
  parseCidr,
  formatIPv4,
  allocateRange,
  usableRange,
            
} from '../core/net.js';
import { warning, info,              } from '../core/findings.js';
import {
  DEFAULT_MTU,
  VCFMS_RECOMMENDED_IPS,
  AUTOMATION_IP_COUNT,
  INTERNAL_CLUSTER_CIDRS_V4,
} from './sizing-data.js';
import { PLACEHOLDER_SECRET } from './spec-types.js';
             
           
                  
               
          
               
                     
                    
                    
                    
                
          
          
                  
                
               
              
          
                   
               
                         




export { PLACEHOLDER_SECRET };

                              
                                    
                        
                          
                                                          
                            
                        
 

                        
             
                        
                    
                                
             

                                    
                        
                                                              
                                  
 

                                 
                                                                              
                                              
                          
                                    
                            
                                       
                                                  
                                
                                                                          
                                                  
                                                                             
                               

                                                                              
                                                                 
                                   
                             
                                    

                                                                             
                   
                                
                                

                                                                              
                                   
                                      
                                
                              
                             
                                         
                                  
                                
                                 

                                                                              
                                                                
                                  
                                       
                               
                                                       
                            
                              

                                                                              
                                     
                                       
                                            
                                                                        
                                                               
                                   

                                                                              
                                   
                                   
                             
                           
                                                                     

                                                                              
                                                                                
                   
                          
                                 
                                         
                                           
    

                                                                              
                                   
                                
                             
                                              

                                                                              
                                             
                                                                             
                                                                  

                                                                                
                                       

                                                                         
                             

     
                                                   
    
                                                                              
                                                                           
                                 
     
                                   
           
                 
                     
                
                     
                     
                     
                    
                    
                 
                         
                      
                       
                        
                    
                            
                     
                     
                   
            
     
    

                                                                              
                                       
                                       
                                 
                                        

                                                                              
                       
                                         
                                     
                                             
                                            
                                            
                                    
    

                                                                              
                                              
 

                              
                          
                                                                            
                                        
                                                              
                                           
 

function fqdn(shortName        , domain        )         {
  return `${shortName}.${domain}`.toLowerCase();
}

function gatewayFor(plan             , cidr      )         {
  return plan.gateway ?? formatIPv4(usableRange(cidr).first);
}

function pad(n        , width = 2)         {
  return String(n).padStart(width, '0');
}

function networkSpec(
  type             ,
  plan             ,
  extras                           = {},
)                         {
  const cidr = parseCidr(plan.cidr);
  if (!cidr) return null;
  const spec                  = {
    networkType: type,
    vlanId: plan.vlanId,
    subnet: plan.cidr,
    gateway: gatewayFor(plan, cidr),
    ipAddressVersion: 'IPv4',
    ipAddressAssignmentMode: 'STATIC',
    teamingPolicy: 'loadbalance_loadbased',
    activeUplinks: ['uplink1', 'uplink2'],
    standbyUplinks: [],
    ...(plan.mtu !== undefined ? { mtu: plan.mtu } : {}),
    ...extras,
  };
  return spec;
}

/**
 * vDS layout.
 *
 * The 9.1 installer offers Default (one switch), Storage Traffic Separation
 * (two), NSX Traffic Separation (two), Storage and NSX Separation (three), and
 * Custom. Each switch needs its own uplinks, so the available vmnics are split
 * across them.
 */
function buildDvsSpecs(plan                , findings           )            {
  const profile = plan.dvsProfile ?? 'default';
  const vmnics = plan.vmnics ?? ['vmnic0', 'vmnic1'];
  const mtu = plan.dvsMtu ?? DEFAULT_MTU;
  const prefix = plan.namePrefix ?? plan.sddcId;

  const toUplinks = (nics          )                  =>
    nics.map((id, i) => ({ id, uplink: `uplink${i + 1}` }));

  const overlayConfig = {
    transportZones: [
      { name: `${prefix}-overlay-tz`, transportType: 'OVERLAY'          },
      { name: `${prefix}-vlan-tz`, transportType: 'VLAN'          },
    ],
  };

  const lagSpecs                   = plan.lacp
    ? [{ name: plan.lacp.name ?? `${prefix}-lag01`.slice(0, 16), ...plan.lacp }]
    : null;

  const teamings = [
    {
      policy: 'LOADBALANCE_SRCID'         ,
      activeUplinks: toUplinks(vmnics).map((u) => u.uplink),
      standByUplinks: null,
    },
  ];

  const storageNetworks                = [];
  if (plan.storage === 'vsan-esa' || plan.storage === 'vsan-osa') storageNetworks.push('VSAN');
  if (plan.nfs) storageNetworks.push('NFS');

  const coreNetworks                = ['MANAGEMENT', 'VM_MANAGEMENT', 'VMOTION'];
  if (plan.fleetManagement) coreNetworks.push('FLEET_MANAGEMENT');

  const needed                             = {
    default: 1,
    'storage-separation': 2,
    'nsx-separation': 2,
    'storage-and-nsx-separation': 3,
    custom: 1,
  };
  const switchCount = needed[profile];

  if (vmnics.length < switchCount * 2) {
    findings.push(
      warning(
        'vcf.build.insufficient-vmnics',
        `The "${profile}" vDS profile wants ${switchCount} switch(es) with redundant uplinks, which needs ${switchCount * 2} vmnics; ${vmnics.length} supplied.`,
        {
          path: 'vmnics',
          remediation: 'Add vmnics, or use the default single-switch profile.',
          source: 'VCF 9.1 vDS profiles',
        },
      ),
    );
  }

  const chunk = Math.max(1, Math.floor(vmnics.length / switchCount));
  const slice = (index        )           =>
    vmnics.slice(index * chunk, index === switchCount - 1 ? undefined : (index + 1) * chunk);

  if (profile === 'default' || profile === 'custom') {
    return [
      {
        dvsName: `${prefix}-vds01`,
        networks: [...coreNetworks, ...storageNetworks],
        mtu,
        nsxtSwitchConfig: overlayConfig,
        vmnicsToUplinks: toUplinks(vmnics),
        nsxTeamings: teamings,
        lagSpecs,
      },
    ];
  }

  if (profile === 'storage-separation') {
    return [
      {
        dvsName: `${prefix}-vds01`,
        networks: coreNetworks,
        mtu,
        nsxtSwitchConfig: overlayConfig,
        vmnicsToUplinks: toUplinks(slice(0)),
        nsxTeamings: teamings,
        lagSpecs,
      },
      {
        dvsName: `${prefix}-vds02-storage`,
        networks: storageNetworks,
        mtu,
        vmnicsToUplinks: toUplinks(slice(1)),
      },
    ];
  }

  if (profile === 'nsx-separation') {
    return [
      {
        dvsName: `${prefix}-vds01`,
        networks: [...coreNetworks, ...storageNetworks],
        mtu,
        vmnicsToUplinks: toUplinks(slice(0)),
      },
      {
        dvsName: `${prefix}-vds02-nsx`,
        mtu,
        nsxtSwitchConfig: overlayConfig,
        vmnicsToUplinks: toUplinks(slice(1)),
        nsxTeamings: teamings,
        lagSpecs,
      },
    ];
  }

  return [
    {
      dvsName: `${prefix}-vds01`,
      networks: coreNetworks,
      mtu,
      vmnicsToUplinks: toUplinks(slice(0)),
    },
    {
      dvsName: `${prefix}-vds02-storage`,
      networks: storageNetworks,
      mtu,
      vmnicsToUplinks: toUplinks(slice(1)),
    },
    {
      dvsName: `${prefix}-vds03-nsx`,
      mtu,
      nsxtSwitchConfig: overlayConfig,
      vmnicsToUplinks: toUplinks(slice(2)),
      nsxTeamings: teamings,
      lagSpecs,
    },
  ];
}

function buildDatastoreSpec(plan                , findings           )                    {
  if (plan.existing?.datastoreName) {
    return { existingDatastoreName: plan.existing.datastoreName };
  }

  if (plan.storage === 'vsan-esa' || plan.storage === 'vsan-osa') {
    const esa = plan.storage === 'vsan-esa';
    // The API documentation is inconsistent about the FTT default, so it is
    // always emitted explicitly. 6+ hosts can sustain FTT=2.
    const ftt = plan.failuresToTolerate ?? (plan.hostCount >= 6 ? 2 : 1);
    if (plan.failuresToTolerate === undefined) {
      findings.push(
        info(
          'vcf.build.ftt-derived',
          `failuresToTolerate set to ${ftt} from a ${plan.hostCount}-host cluster. Emitted explicitly because the documented default is ambiguous.`,
          { path: 'datastoreSpec.vsanSpec.failuresToTolerate' },
        ),
      );
    }
    return {
      vsanSpec: {
        datastoreName: plan.datastoreName ?? 'vsanDatastore',
        vsanDedup: esa ? false : (plan.vsanDedup ?? false),
        failuresToTolerate: ftt,
        esaConfig: { enabled: esa },
        encryptionConfig: { dataInTransitConfig: { enable: false } },
      },
    };
  }

  if (plan.storage === 'nfs') {
    return {
      nfsDatastoreSpec: {
        datastoreName: plan.datastoreName ?? 'nfsDatastore',
        nasVolume: {
          serverName: plan.nfsServer ? [plan.nfsServer] : [PLACEHOLDER_SECRET],
          path: plan.nfsPath ?? '/export/vcf',
          readOnly: false,
        },
      },
    };
  }

  return {
    vmfsDatastoreSpec: {
      fcSpec: [{ datastoreName: plan.datastoreName ?? 'vmfsDatastore' }],
    },
  };
}

/**
 * Build a complete VCF 9.1 SddcSpec from a deployment plan.
 */
export function buildSddcSpec(plan                )              {
  const findings            = [];
  const placeholders           = [];
  const domain = plan.domainSuffix.toLowerCase();
  const prefix = plan.namePrefix ?? plan.sddcId;
  const ha = plan.profile === 'ha';
  const secondary = plan.instanceRole === 'secondary';

                                                                    

  /** Resolve a component FQDN, honouring any per-component override. */
  const name = (key         , shortName        )         =>
    plan.fqdnOverrides?.[key] ?? fqdn(shortName, domain);

  const secret = (key        , path        )         => {
    const value = plan.passwords?.[key];
    if (value) return value;
    placeholders.push(path);
    return PLACEHOLDER_SECRET;
  };

  // --- hosts ---------------------------------------------------------------
  const hostSpecs                 = Array.from({ length: plan.hostCount }, (_, i) => ({
    hostname: `${plan.esxHostnameBase}${pad(i + 1)}`,
    credentials: {
      username: 'root',
      password: plan.esxRootPassword ?? secret('esxRoot', 'hostSpecs[].credentials.password'),
    },
  }));

  // --- networks ------------------------------------------------------------
  const networkSpecs                    = [];
  const mgmtCidr = parseCidr(plan.management.cidr);

  const mgmt = networkSpec('MANAGEMENT', plan.management, {
    portGroupKey: `${prefix}-pg-mgmt`,
  });
  if (mgmt) networkSpecs.push(mgmt);

  // VM management commonly shares the management VLAN; the installer still
  // wants it declared as its own network with its own port group.
  const vmMgmtPlan = plan.vmManagement ?? plan.management;
  const vmMgmt = networkSpec('VM_MANAGEMENT', vmMgmtPlan, {
    portGroupKey: `${prefix}-pg-vm-mgmt`,
  });
  if (vmMgmt) networkSpecs.push(vmMgmt);

  const vmotionCidr = parseCidr(plan.vmotion.cidr);
  const vmotion = networkSpec('VMOTION', { mtu: DEFAULT_MTU, ...plan.vmotion }, {
    portGroupKey: `${prefix}-pg-vmotion`,
    ...(vmotionCidr
      ? {
          includeIpAddressRanges: (() => {
            const range = allocateRange(vmotionCidr, 9, Math.max(plan.hostCount, 1));
            return range
              ? [{ startIpAddress: formatIPv4(range.start), endIpAddress: formatIPv4(range.end) }]
              : [];
          })(),
        }
      : {}),
  });
  if (vmotion) networkSpecs.push(vmotion);

  if (plan.vsan && (plan.storage === 'vsan-esa' || plan.storage === 'vsan-osa')) {
    const vsanCidr = parseCidr(plan.vsan.cidr);
    const vsan = networkSpec('VSAN', { mtu: DEFAULT_MTU, ...plan.vsan }, {
      portGroupKey: `${prefix}-pg-vsan`,
      ...(vsanCidr
        ? {
            includeIpAddressRanges: (() => {
              const range = allocateRange(vsanCidr, 1, Math.max(plan.hostCount, 1));
              return range
                ? [{ startIpAddress: formatIPv4(range.start), endIpAddress: formatIPv4(range.end) }]
                : [];
            })(),
          }
        : {}),
    });
    if (vsan) networkSpecs.push(vsan);
  }

  if (plan.nfs) {
    const nfs = networkSpec('NFS', { mtu: DEFAULT_MTU, ...plan.nfs }, {
      portGroupKey: `${prefix}-pg-nfs`,
    });
    if (nfs) networkSpecs.push(nfs);
  }

  if (plan.fleetManagement) {
    const fleet = networkSpec('FLEET_MANAGEMENT', plan.fleetManagement, {
      portGroupKey: `${prefix}-pg-fleet`,
    });
    if (fleet) networkSpecs.push(fleet);
  }

  // --- NSX -----------------------------------------------------------------
  const tepCidr = parseCidr(plan.hostTep.cidr);
  const tepCount = plan.hostCount * (plan.pnicsPerHost ?? 2);
  const tepRange = tepCidr ? allocateRange(tepCidr, 9, Math.max(tepCount, 1)) : null;

  const nsxtSpec               = {
    nsxtManagers: ha
      ? ([1, 2, 3]         ).map((n) => ({
          hostname: name(`nsxManager${n}`           , `${prefix}-nsx${pad(n)}`),
        }))
      : [{ hostname: name('nsxManager1', `${prefix}-nsx01`) }],
    vipFqdn: name('nsxVip', `${prefix}-nsx`),
    nsxtManagerSize: plan.nsxManagerSize ?? 'medium',
    rootNsxtManagerPassword: secret('nsxRoot', 'nsxtSpec.rootNsxtManagerPassword'),
    nsxtAdminPassword: secret('nsxAdmin', 'nsxtSpec.nsxtAdminPassword'),
    nsxtAuditPassword: secret('nsxAudit', 'nsxtSpec.nsxtAuditPassword'),
    transportVlanId: plan.hostTep.vlanId,
    ...(tepCidr && tepRange
      ? {
          ipAddressPoolSpec: {
            name: `${prefix}-tep01`,
            description: 'ESXi host overlay TEP IP pool',
            subnets: [
              {
                cidr: plan.hostTep.cidr,
                gateway: gatewayFor(plan.hostTep, tepCidr),
                // Note: start/end here, unlike the startIpAddress/endIpAddress
                // used by networkSpecs. This asymmetry is in the API itself.
                ipAddressPoolRanges: [
                  { start: formatIPv4(tepRange.start), end: formatIPv4(tepRange.end) },
                ],
              },
            ],
          },
        }
      : {}),
    ...(plan.tepLess ? { overlayVtepSpec: { vtepType: 'NO_IP'          } } : {}),
    ...(plan.existing?.nsx
      ? {
          useExistingDeployment: true,
          sslThumbprint: plan.existing.nsx.sslThumbprint ?? PLACEHOLDER_SECRET,
          enableEdgeClusterSync: true,
        }
      : {}),
  };

  // A TEP-less deployment creates no host overlay VTEPs, so a TEP pool would
  // be meaningless alongside it.
  if (plan.tepLess) {
    delete (nsxtSpec                                   ).ipAddressPoolSpec;
    findings.push(
      info(
        'vcf.build.tep-less',
        'TEP-less deployment selected: no host overlay TEP pool is emitted.',
        { source: 'VCF 9.1.1 TEP-less deployments' },
      ),
    );
  }

  if (plan.dtgw) {
    nsxtSpec.vpcSpec = {
      vpcNetworkConfigurationType: plan.vpcNetworkConfigurationType ?? 'FULL_STACK_VPC',
      dtgwSpec: {
        vlan: plan.dtgw.vlan,
        gatewayCidr: plan.dtgw.gatewayCidr,
        externalIpBlockCidr: plan.dtgw.externalIpBlockCidr,
        privateTgwIpBlockCidr: plan.dtgw.privateTgwIpBlockCidr,
      },
    };
  } else if (plan.vpcNetworkConfigurationType) {
    nsxtSpec.vpcSpec = { vpcNetworkConfigurationType: plan.vpcNetworkConfigurationType };
  }

  if (tepCidr && !tepRange) {
    findings.push(
      warning(
        'vcf.build.tep-pool-not-allocated',
        `Could not fit ${tepCount} TEP addresses in ${plan.hostTep.cidr}.`,
        { path: 'hostTep.cidr', remediation: 'Use a larger TEP subnet.' },
      ),
    );
  }

  // --- VCF Management Services (vSphere Supervisor) ------------------------
  // The VCFMS pool lives in the management subnet unless a dedicated fleet
  // management network was planned.
  const vcfmsHomeCidr = plan.fleetManagement ? parseCidr(plan.fleetManagement.cidr) : mgmtCidr;
  const vcfmsRange = vcfmsHomeCidr
    ? allocateRange(vcfmsHomeCidr, 31, VCFMS_RECOMMENDED_IPS)
    : null;

  const vspClusterSpec                     = {
    platformFqdn: name('vspPlatform', `${prefix}-msr01`),
    instanceFqdn: name('vspInstance', `${prefix}-int01`),
    // A secondary instance joins an existing fleet and must omit fleetFqdn.
    ...(secondary ? {} : { fleetFqdn: name('vspFleet', `${prefix}-flt01`) }),
    ipv4Pool: vcfmsRange
      ? { ipRange: { startIpAddress: formatIPv4(vcfmsRange.start), endIpAddress: formatIPv4(vcfmsRange.end) } }
      : {},
    systemUserPassword: secret('vspSystem', 'vspClusterSpec.systemUserPassword'),
    size: plan.vspSize ?? (ha ? 'small_ha' : 'small'),
    internalClusterCidrIpv4: plan.internalClusterCidr ?? INTERNAL_CLUSTER_CIDRS_V4[0],
    // Present in a real working spec but absent from the published schema.
    name: `${prefix}-vmsp-01`,
  };

  if (!vcfmsRange) {
    findings.push(
      warning(
        'vcf.build.vcfms-pool-not-allocated',
        `Could not fit ${VCFMS_RECOMMENDED_IPS} VCF Management Services addresses in the management subnet.`,
        {
          path: 'vspClusterSpec.ipv4Pool',
          remediation:
            'Widen the management subnet, or add a dedicated FLEET_MANAGEMENT network for these components.',
          source: 'VCF 9.1 IP requirements',
        },
      ),
    );
  }

  // --- Operations ----------------------------------------------------------
  const includeOps = plan.includeOperations !== false;
  const vcfOperationsSpec                                = includeOps
    ? {
        nodes: ha
          ? [
              { hostname: name('opsPrimary', `${prefix}-ops01`), type: 'master', rootUserPassword: secret('opsRoot', 'vcfOperationsSpec.nodes[0].rootUserPassword') },
              { hostname: name('opsReplica', `${prefix}-ops02`), type: 'replica', rootUserPassword: secret('opsRoot', 'vcfOperationsSpec.nodes[1].rootUserPassword') },
              { hostname: name('opsData', `${prefix}-ops03`), type: 'data', rootUserPassword: secret('opsRoot', 'vcfOperationsSpec.nodes[2].rootUserPassword') },
            ]
          : [
              {
                hostname: name('opsPrimary', `${prefix}-ops01`),
                type: 'master',
                rootUserPassword: secret('opsRoot', 'vcfOperationsSpec.nodes[0].rootUserPassword'),
              },
            ],
        adminUserPassword: secret('opsAdmin', 'vcfOperationsSpec.adminUserPassword'),
        applianceSize: plan.opsSize ?? (ha ? 'medium' : 'small'),
        ...(ha ? { loadBalancerFqdn: name('opsLoadBalancer', `${prefix}-ops`) } : {}),
        // A secondary instance attaches to the fleet's existing Operations.
        ...(secondary || plan.existing?.operations ? { useExistingDeployment: true } : {}),
      }
    : undefined;

  // --- Automation ----------------------------------------------------------
  const includeAutomation = plan.includeAutomation !== false;
  const automationRange = vcfmsHomeCidr
    ? allocateRange(vcfmsHomeCidr, 31 + VCFMS_RECOMMENDED_IPS, AUTOMATION_IP_COUNT)
    : null;

  const vcfAutomationSpec                                = includeAutomation
    ? {
        hostname: name('automation', `${prefix}-auto01`),
        platformFqdn: name('automationPlatform', `${prefix}-asr01`),
        internalClusterCidr: plan.internalClusterCidr ?? INTERNAL_CLUSTER_CIDRS_V4[0],
        adminUserPassword: secret('automationAdmin', 'vcfAutomationSpec.adminUserPassword'),
        nodePrefix: `${prefix}-node-01`.toLowerCase(),
        ...(automationRange
          ? {
              ipPool: Array.from({ length: AUTOMATION_IP_COUNT }, (_, i) =>
                formatIPv4(automationRange.start + i),
              ),
            }
          : {}),
        size: plan.automationSize ?? (ha ? 'medium' : 'small'),
        ...(plan.existing?.automation ? { useExistingDeployment: true } : {}),
      }
    : undefined;

  if (includeAutomation && !automationRange) {
    findings.push(
      warning(
        'vcf.build.automation-pool-not-allocated',
        `Could not allocate ${AUTOMATION_IP_COUNT} VCF Automation addresses after the VCFMS pool.`,
        { path: 'vcfAutomationSpec.ipPool' },
      ),
    );
  }

  // --- security ------------------------------------------------------------
  const securitySpec                           = plan.esxiCertsMode
    ? {
        esxiCertsMode: plan.esxiCertsMode,
        ...(plan.rootCaCerts ? { rootCaCerts: plan.rootCaCerts } : {}),
      }
    : undefined;

  if (plan.esxiCertsMode === 'Custom' && !plan.rootCaCerts?.length) {
    findings.push(
      warning(
        'vcf.build.custom-certs-without-ca',
        'esxiCertsMode is Custom but no root CA certificates were supplied.',
        {
          path: 'rootCaCerts',
          remediation: 'Provide the Base64-encoded CA chain, or use VMCA-issued certificates.',
          source: 'VCF Installer API — SecuritySpec',
        },
      ),
    );
  }

  // --- assemble ------------------------------------------------------------
  const spec           = {
    sddcId: plan.sddcId,
    version: plan.version ?? '9.1.0.0',
    vcfInstanceName: plan.vcfInstanceName ?? plan.sddcId,
    // Broadcom documents this explicitly: a secondary instance joining an
    // existing fleet must declare VCF_EXTEND, not VCF. Emitting VCF for a
    // secondary is a silent misconfiguration.
    workflowType: plan.workflowType ?? (secondary ? 'VCF_EXTEND' : 'VCF'),
    ceipEnabled: plan.ceipEnabled ?? false,
    skipEsxThumbprintValidation: false,
    skipGatewayPingValidation: false,

    dnsSpec: {
      subdomain: domain,
      nameservers: plan.dnsServers.slice(0, 2),
    },
    ntpServers: plan.ntpServers,

    hostSpecs,
    networkSpecs,

    clusterSpec: {
      datacenterName: plan.datacenterName ?? `${prefix}-dc01`,
      clusterName: plan.clusterName ?? `${prefix}-cl01`,
      ...(plan.evcMode ? { clusterEvcMode: plan.evcMode } : {}),
      ...(plan.resourcePools ? { resourcePoolSpecs: plan.resourcePools } : {}),
    },

    ...(plan.managementPoolName ? { managementPoolName: plan.managementPoolName } : {}),
    ...(securitySpec ? { securitySpec } : {}),

    vcenterSpec: {
      vcenterHostname: name('vcenter', `${prefix}-vc01`),
      rootVcenterPassword: secret('vcenterRoot', 'vcenterSpec.rootVcenterPassword'),
      vmSize: plan.vcenterSize ?? 'small',
      storageSize: 'lstorage',
      ssoDomain: 'vsphere.local',
      adminUserSsoUsername: 'administrator',
      adminUserSsoPassword: secret('ssoAdmin', 'vcenterSpec.adminUserSsoPassword'),
      ...(plan.existing?.vcenter
        ? {
            useExistingDeployment: true,
            sslThumbprint: plan.existing.vcenter.sslThumbprint ?? PLACEHOLDER_SECRET,
          }
        : {}),
    },

    nsxtSpec,

    datastoreSpec: buildDatastoreSpec(plan, findings),

    dvsSpecs: buildDvsSpecs(plan, findings),

    sddcManagerSpec: {
      hostname: name('sddcManager', `${prefix}-sddcm01`),
      rootPassword: secret('sddcManagerRoot', 'sddcManagerSpec.rootPassword'),
      sshPassword: secret('sddcManagerSsh', 'sddcManagerSpec.sshPassword'),
      localUserPassword: secret('sddcManagerLocal', 'sddcManagerSpec.localUserPassword'),
      ...(plan.existing?.sddcManager
        ? {
            useExistingDeployment: true,
            sslThumbprint: plan.existing.sddcManager.sslThumbprint ?? PLACEHOLDER_SECRET,
          }
        : {}),
    },

    vspClusterSpec,

    // Fleet and lifecycle services. An empty object signals "deploy with
    // defaults", which is how a real working 9.1 spec expresses them.
    fleetLcmSpec: { hostname: name('vspFleet', `${prefix}-flt01`) },
    sddcLcmSpec: { hostname: name('vspInstance', `${prefix}-int01`) },
    fleetDepotSpec: {},
    telemetryAcceptorSpec: {},
    saltSpec: {},
    saltRaasSpec: {},

    vidbSpec: { hostname: name('identityBroker', `${prefix}-idb01`) },
    licenseServerSpec: { hostname: name('licenseServer', `${prefix}-lic01`) },

    ...(vcfOperationsSpec ? { vcfOperationsSpec } : {}),
    ...(includeOps
      ? {
          vcfOperationsCollectorSpec: {
            hostname: name('opsCollector', `${prefix}-proxy01`),
            rootUserPassword: secret('opsCollectorRoot', 'vcfOperationsCollectorSpec.rootUserPassword'),
            applianceSize: 'small',
          },
        }
      : {}),
    ...(vcfAutomationSpec ? { vcfAutomationSpec } : {}),
  };

  if (secondary) {
    findings.push(
      info(
        'vcf.build.secondary-instance',
        'Built as a secondary instance: workflowType is VCF_EXTEND, vspClusterSpec.fleetFqdn is omitted, and VCF Operations uses the existing fleet deployment.',
        { source: 'VCF Installer API — SddcSpec.workflowType' },
      ),
    );
  }

  // VCF_COMPLETE and VCF_BOOTSTRAP appear in the enum but Broadcom publishes no
  // definition for either, so emitting one is a guess about deployment behaviour.
  if (plan.workflowType === 'VCF_COMPLETE' || plan.workflowType === 'VCF_BOOTSTRAP') {
    findings.push(
      warning(
        'vcf.build.undocumented-workflow-type',
        `workflowType "${plan.workflowType}" appears in the API enum but Broadcom publishes no definition of what it does.`,
        {
          path: 'workflowType',
          remediation: 'Use VCF for a primary instance, VCF_EXTEND for a secondary, or VVF for vSphere Foundation.',
          source: 'VCF Installer API — SddcSpec',
        },
      ),
    );
  }

  if (placeholders.length > 0) {
    findings.push(
      warning(
        'vcf.build.placeholder-secrets',
        `${placeholders.length} credential field(s) contain "${PLACEHOLDER_SECRET}" and must be filled before deployment.`,
        {
          remediation:
            'VCF 9.1 can auto-generate complex passwords during installation; alternatively supply them in the plan.',
        },
      ),
    );
  }

  findings.push(
    info(
      'vcf.build.not-validated',
      'This specification has not been validated by a VCF Installer. Run POST /v1/sddcs/validations before deploying.',
      { source: 'VCF Installer API' },
    ),
  );

  return { spec, findings, placeholders };
}

/** Serialize a spec with stable key ordering for diffing between runs. */
export function serializeSpec(spec          )         {
  return `${JSON.stringify(spec, null, 2)}\n`;
}

/**
 * Redact every placeholder and supplied secret, for sharing a spec for review.
 */
export function redactSpec(spec          )           {
  const SECRET_KEY = /password|thumbprint|secret|token/i;
  const walk = (value         )          => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const out                          = {};
      for (const [key, inner] of Object.entries(value                           )) {
        out[key] = SECRET_KEY.test(key) && typeof inner === 'string' ? '<REDACTED>' : walk(inner);
      }
      return out;
    }
    return value;
  };
  return walk(spec)            ;
}
