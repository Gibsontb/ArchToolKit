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
  parseIPv4,
  formatIPv4,
  allocateRange,
  usableRange,
            
} from '../core/net.js';
import { warning, info,              } from '../core/findings.js';
import {
  DEFAULT_MTU,
  VCFMS_RECOMMENDED_IPS,
  INTERNAL_CLUSTER_CIDRS_V4,
} from './sizing-data.js';
import {
  DEFAULT_VCF_VERSION,
  automationIpCount,
  compareVcfVersion,
  defaultApplianceSize,
} from './version.js';
import { PLACEHOLDER_SECRET } from './spec-types.js';
             
           
                  
               
          
               
                     
                    
                    
                    
                
          
          
                  
                
               
              
          
                   
               
                
           
           
                                            
                         
import {
  MANAGEMENT_NETWORK_MODELS,
  managementNetworkModel,
  CLOUD_PROXY_ALWAYS_VM_MANAGEMENT,
                              
} from './management-network.js';
import {
  SCENARIO_RULES,
  scenarioRule,
  resolveFlag,
  componentTakesPart,
  VVF_WITHOUT_MANAGEMENT_SERVICES_PREREQUISITE,
                          
} from './scenarios.js';




export { PLACEHOLDER_SECRET };

                              
                                    
                        
                          
                                                          
                            
                        
     
                                                       
    
                                                                               
                                                                                 
                                                                 
     
                             
                                
                                                                              
                                         
                                    
                                     
                                                        
 

/**
 * Flexible IP pool specification.
 *
 * VCF 9.1 accepts a contiguous range, a CIDR, or an explicit address list, and
 * 9.1.0.400+ supports exclusions. Estates with fragmented free space need the
 * list form, so all three are expressible rather than only the range.
 */
                           
                                                 
                                                         
                                
                                                   
                                        
                                                      
                         
                                                                    
                           
                          
 

                        
             
                        
                    
                                
             

                                    
                        
                                                              
                                  
 

/**
 * One ESX host as the installer wants it.
 *
 * These are the only four fields `SddcHostSpec` defines. There is no per-host
 * IP (it resolves from DNS), and no per-host disk selection anywhere in the
 * API — vSAN claiming is automatic at cluster level.
 */
                            
                                                                         
                            
                             
                             
                                                                          
                                  
                                              
                                  
 

                                 
                                                                              
                                              
                          
                                    
                            
                                       
                                                  
                                
                                                                          
                                                  
                                                                             
                               

                                                                              
     
                                                             
                                                                    
     
                                   
                             
                                    
     
                              
    
                                                                          
                                                                         
                                                 
     
                               

                                                                             
                   
                                
                                

                                                                              
                                   
                                      
                                
                              
                             
     
                                                                   
                                                                              
     
                                         

     
                                                                           
                                                                
     
                                                           
                                  
                                
                                 

                                                                              
                                                                
                                  
                                       
                               
                                                        
                                          
                                         
                                             
                                                                   
                                             

                                                                                
                                 
                            
                                                                          
                              
                                 
                               
                                     

                                                       
                                         

                                                                              
                                
                                     
                              

                                                                              
                                                                      
                               
                                            
                                               
                                    

                                                                       
                                          
                      
                          
                         
                      
                           
                          
      
                        
                          
                         
                      
                           
                          
      
    

                                                                              
                                     
                                       
                                            
                                                                        
                                                               
                                   

                                                                              
                                   
                                   
                             
                           
                                                                     

                                                                              
                                                                                
                   
                          
                                 
                                         
                               
                                            
    

                                                                              
                                   
                                
                             
                                              

                                                                              
                                             
                                                                             
                                                                  

                                                                                
                                       

                                                                         
                             

     
                                                   
    
                                                                              
                                                                           
                                 
     
                                   
           
                 
                     
                
                     
                     
                     
                    
                    
                 
                         
                      
                       
                        
                    
                            
                     
                     
                   
            
     
    

                                                                              
     
                                                                      
    
                                                                               
                                                                            
                                                                          
                                                                                
                                           
     
                                         

                                                                              
                                       
                                       
                                                                  
                                               
                                           
                                 
                                        

                                                                              
                       
                                         
                                     
                                             
                                            
                                            
                                    
    

                                                                              
                                              
 

                              
                          
                                                                            
                                        
                                                              
                                           
 

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
    ipAddressAssignmentMode: plan.assignmentMode ?? 'STATIC',
    // Per-traffic-type teaming — the wizard exposes this per network, and the
    // enum here is lowercase, unlike the uppercase NSX uplink-profile enum.
    teamingPolicy: plan.teamingPolicy ?? 'loadbalance_loadbased',
    activeUplinks: plan.activeUplinks ?? ['uplink1', 'uplink2'],
    standbyUplinks: plan.standbyUplinks ?? [],
    ...(plan.mtu !== undefined ? { mtu: plan.mtu } : {}),
    ...extras,
  };
  return spec;
}

/**
 * IPv6 counterpart of a network.
 *
 * The API carries no separate v6 fields: an IPv6 network sets
 * `ipAddressVersion: "IPv6"` and puts v6 values in the same `subnet` and
 * `gateway` fields.
 */
function networkSpecV6(
  type             ,
  plan             ,
  extras                           = {},
)                         {
  if (!plan.ipv6Cidr) return null;
  return {
    networkType: type,
    vlanId: plan.vlanId,
    subnet: plan.ipv6Cidr,
    ...(plan.ipv6Gateway ? { gateway: plan.ipv6Gateway } : {}),
    ipAddressVersion: 'IPv6',
    ipAddressAssignmentMode: plan.assignmentMode ?? 'STATIC',
    teamingPolicy: plan.teamingPolicy ?? 'loadbalance_loadbased',
    activeUplinks: plan.activeUplinks ?? ['uplink1', 'uplink2'],
    standbyUplinks: plan.standbyUplinks ?? [],
    ...(plan.mtu !== undefined ? { mtu: plan.mtu } : {}),
    ...extras,
  };
}

/**
 * Build an IPv4 pool in whichever form the plan asks for.
 *
 * Exactly one of addresses / ipRange / cidr must be present, so the branches
 * are mutually exclusive rather than merged.
 */
function buildPool(
  plan                      ,
  sourceCidr             ,
  defaultOffset        ,
  defaultCount        ,
)                  {
  const mode = plan?.mode ?? 'range';

  if (mode === 'addresses') {
    if (!plan?.addresses?.length) return null;
    return { addresses: plan.addresses };
  }

  if (mode === 'cidr') {
    const cidr = plan?.cidr;
    if (!cidr) return null;
    return {
      cidr,
      ...(plan?.excludedAddresses?.length ? { excludedAddresses: plan.excludedAddresses } : {}),
    };
  }

  const cidr = plan?.cidr ? parseCidr(plan.cidr) : sourceCidr;
  if (!cidr) return null;
  const range = allocateRange(cidr, plan?.offset ?? defaultOffset, plan?.count ?? defaultCount);
  if (!range) return null;

  return {
    ipRange: { startIpAddress: formatIPv4(range.start), endIpAddress: formatIPv4(range.end) },
    ...(plan?.excludedAddresses?.length ? { excludedAddresses: plan.excludedAddresses } : {}),
  };
}

/**
 * Flatten a pool to a plain address list.
 *
 * `vcfAutomationSpec.ipPool` is a bare string array rather than an IPv4Pool, so
 * whichever form the plan used has to be expanded here.
 */
function poolToAddresses(pool          )           {
  if (pool.addresses?.length) return pool.addresses;
  if (pool.ipRange) {
    const start = parseIPv4(pool.ipRange.startIpAddress);
    const end = parseIPv4(pool.ipRange.endIpAddress);
    if (start === null || end === null || end < start) return [];
    const excluded = new Set(pool.excludedAddresses ?? []);
    const out           = [];
    for (let addr = start; addr <= end; addr += 1) {
      const text = formatIPv4(addr);
      if (!excluded.has(text)) out.push(text);
    }
    return out;
  }
  if (pool.cidr) {
    const cidr = parseCidr(pool.cidr);
    if (!cidr) return [];
    const { first, last } = usableRange(cidr);
    const excluded = new Set(pool.excludedAddresses ?? []);
    const out           = [];
    for (let addr = first; addr <= last && out.length < 256; addr += 1) {
      const text = formatIPv4(addr);
      if (!excluded.has(text)) out.push(text);
    }
    return out;
  }
  return [];
}

/** IPv6 pool. Only the explicit-address and CIDR forms are derivable offline. */
function buildPoolV6(plan                      )                  {
  if (!plan) return null;
  if (plan.addresses?.length) return { addresses: plan.addresses };
  if (plan.cidr) {
    return {
      cidr: plan.cidr,
      ...(plan.excludedAddresses?.length ? { excludedAddresses: plan.excludedAddresses } : {}),
    };
  }
  return null;
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
        // Dedup and compression is an OSA-only feature and conflicts with ESA.
        vsanDedup: esa ? false : (plan.vsanDedup ?? false),
        failuresToTolerate: ftt,
        esaConfig: {
          enabled: esa,
          ...(esa && plan.skipHclAutoDiskClaim !== undefined
            ? { skipHclAutoDiskClaim: plan.skipHclAutoDiskClaim }
            : {}),
        },
        encryptionConfig: {
          dataInTransitConfig: {
            enable: plan.vsanEncryptionInTransit ?? false,
            ...(plan.vsanEncryptionInTransit && plan.vsanRekeyIntervalMinutes !== undefined
              ? { rekeyInterval: plan.vsanRekeyIntervalMinutes }
              : {}),
          },
        },
      },
    };
  }

  if (plan.storage === 'nfs') {
    const servers = plan.nfsServers?.length
      ? plan.nfsServers
      : plan.nfsServer
        ? [plan.nfsServer]
        : [];
    if (servers.length === 0) {
      findings.push(
        warning('vcf.build.nfs-no-server', 'NFS storage selected but no server address was supplied.', {
          path: 'nfsServers',
          remediation: 'Add at least one NFS server address; the API requires a non-empty list.',
          source: 'VCF Installer API — NasVolumeSpec',
        }),
      );
    }
    return {
      nfsDatastoreSpec: {
        datastoreName: plan.datastoreName ?? 'nfsDatastore',
        nasVolume: {
          serverName: servers.length > 0 ? servers : [PLACEHOLDER_SECRET],
          path: plan.nfsPath ?? '/export/vcf',
          // readOnly is REQUIRED by the API, so it is always emitted.
          readOnly: plan.nfsReadOnly ?? false,
          ...(plan.nfsUserTag ? { userTag: plan.nfsUserTag } : {}),
          ...(plan.nfsBindToVmknic !== undefined
            ? { enableBindToVmknic: plan.nfsBindToVmknic }
            : {}),
        },
      },
    };
  }

  const vmfsNames = plan.vmfsDatastoreNames?.length
    ? plan.vmfsDatastoreNames
    : [plan.datastoreName ?? 'vmfsDatastore'];

  return {
    vmfsDatastoreSpec: {
      fcSpec: vmfsNames.map((datastoreName) => ({ datastoreName })),
    },
  };
}

/**
 * Infer the scenario from a plan written before scenarios were modelled.
 *
 * Only the VCF rows are inferable: a vSphere Foundation platform and a
 * deferred-component run look identical to a plain VCF plan apart from the
 * workflowType, so those must be asked for explicitly.
 */
function deriveScenario(plan                )                     {
  const converging = Boolean(
    plan.existing?.vcenter || plan.existing?.nsx || plan.existing?.datastoreName,
  );
  const secondary = plan.instanceRole === 'secondary';

  if (plan.workflowType === 'VVF') return converging ? 'converge-to-vvf' : 'new-vvf';
  if (plan.workflowType === 'VCF_COMPLETE') return 'deferred-components';
  if (secondary) return converging ? 'converge-to-vcf-instance' : 'new-vcf-instance';
  return converging ? 'converge-to-vcf-fleet' : 'new-vcf-fleet';
}

/**
 * Infer the management network model from the networks a plan supplies.
 *
 * Naming an overlay segment is the strongest signal, then a dedicated network;
 * with neither, the components share the Instance-level port group. Stretched
 * cannot be inferred — a second region is a deliberate choice, not a side
 * effect of the networks present.
 */
function deriveManagementNetworkModel(plan                )                         {
  if (plan.managementComponentNetworks?.xRegion) return 'dedicated-vlan-overlay';
  if (plan.fleetManagement) return 'dedicated-vlan';
  return 'shared-vlan';
}

/** Every management network model, for UI listing. */
export const VCF_MANAGEMENT_NETWORK_MODELS = MANAGEMENT_NETWORK_MODELS;

/** Every scenario the builder can produce, for UI listing. */
export const DEPLOYMENT_SCENARIOS = SCENARIO_RULES;

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
  // Several documented defaults move between patch releases, so they are
  // resolved against the version actually being deployed.
  const targetVersion = plan.version ?? DEFAULT_VCF_VERSION;

  // --- deployment scenario -------------------------------------------------
  // Broadcom's decision table fixes workflowType and which components take part
  // for each supported scenario. Resolving it once here keeps every downstream
  // choice consistent with a single published row, instead of each component
  // deciding for itself and drifting out of agreement with the others.
  const scenario                     = plan.scenario ?? deriveScenario(plan);
  const rule = scenarioRule(scenario);

  // Where the fleet-level components live is a named model, so a spec can state
  // which one it represents instead of landing in one by accident.
  const networkModel = managementNetworkModel(
    plan.managementNetworkModel ?? deriveManagementNetworkModel(plan),
  );

  /** Presence of a component whose column is a presence column, not a flag. */
  const includes = (
    cell                                     ,
    requested                     ,
    column        ,
  )          => {
    const { value, conflict } = resolveFlag(cell, requested, true);
    if (conflict) {
      findings.push(
        warning(
          'vcf.build.scenario-conflict',
          `The plan asks for ${column}, but "${rule.label}" does not include that component.`,
          {
            path: column,
            remediation: `Choose a scenario that includes it, or drop ${column} from the plan.`,
            source: 'VCF 9.1 Deployment — Use a JSON Specification File',
          },
        ),
      );
    }
    return value;
  };

  /** Warn when the plan's brownfield inputs disagree with the scenario's row. */
  const checkExisting = (
    cell                                  ,
    supplied         ,
    column        ,
  )       => {
    if (cell === 'either' || cell === 'na') return;
    const expected = cell === 'true';
    if (supplied !== expected) {
      findings.push(
        warning(
          'vcf.build.scenario-existing-mismatch',
          `"${rule.label}" expects ${column} useExistingDeployment to be ${expected}, but the plan ${supplied ? 'supplies' : 'does not supply'} an existing component.`,
          {
            path: column,
            remediation: expected
              ? `Add existing.${column} with its FQDN and SSL thumbprint, or pick a scenario that deploys it new.`
              : `Remove existing.${column}, or pick a converge scenario.`,
            source: 'VCF 9.1 Deployment — Use a JSON Specification File',
          },
        ),
      );
    }
  };

  checkExisting(rule.vcenterExisting, plan.existing?.vcenter !== undefined, 'vcenter');
  checkExisting(rule.nsxExisting, plan.existing?.nsx !== undefined, 'nsx');
  checkExisting(
    rule.operationsExisting,
    secondary || plan.existing?.operations !== undefined,
    'operations',
  );
  checkExisting(rule.automationExisting, plan.existing?.automation !== undefined, 'automation');

  if (plan.workflowType && plan.workflowType !== rule.workflowType) {
    findings.push(
      warning(
        'vcf.build.workflow-type-override',
        `workflowType "${plan.workflowType}" was supplied, but "${rule.label}" is documented as "${rule.workflowType}". The plan's value is used.`,
        {
          path: 'workflowType',
          source: 'VCF 9.1 Deployment — Use a JSON Specification File',
        },
      ),
    );
  }

  const includeNsx = componentTakesPart(rule, rule.nsxExisting);
  const includeManagementServices = includes(
    rule.managementServices,
    plan.includeManagementServices,
    'includeManagementServices',
  );
  const includeLicenseServer = includes(rule.licenseServer, undefined, 'licenseServerSpec');
  const includeIdentityBroker = includes(
    rule.identityBroker,
    plan.includeIdentityBroker,
    'includeIdentityBroker',
  );

  if (rule.workflowType === 'VVF' && !includeManagementServices) {
    findings.push(
      warning(
        'vcf.build.vvf-without-management-services',
        'A vSphere Foundation platform without VCF management services requires the VCF Installer appliance to be reconfigured before this spec is uploaded. No JSON field expresses this step.',
        {
          remediation: VVF_WITHOUT_MANAGEMENT_SERVICES_PREREQUISITE,
          source: 'VCF 9.1 Deployment — Use a JSON Specification File',
        },
      ),
    );
  }

  findings.push(
    info('vcf.build.scenario', `Built as "${rule.label}" (workflowType ${rule.workflowType}).`, {
      source: 'VCF 9.1 Deployment — Use a JSON Specification File',
    }),
  );
  for (const override of rule.supersedesTable ?? []) {
    findings.push(
      info(
        'vcf.build.scenario-table-superseded',
        `${override.column} is set to ${override.used}, not the ${override.tableValue} in Broadcom's summary table. ${override.reason}`,
        {
          path: override.column,
          source: 'VCF 9.1 Deployment — Deploy Deferred Components on NSX Overlay Segments',
        },
      ),
    );
  }


                                                                    

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
  // Explicit host detail wins; otherwise names are generated from the base.
  const hostSpecs                 = (plan.hosts?.length
    ? plan.hosts
    : Array.from(
        { length: plan.hostCount },
        (_, i)            => ({ hostname: `${plan.esxHostnameBase}${pad(i + 1)}` }),
      )
  ).map((entry, i) => ({
    hostname: entry.hostname,
    credentials: {
      username: entry.username ?? 'root',
      password:
        entry.password ??
        plan.esxRootPassword ??
        secret('esxRoot', `hostSpecs[${i}].credentials.password`),
    },
    ...(entry.sshThumbprint ? { sshThumbprint: entry.sshThumbprint } : {}),
    ...(entry.sslThumbprint ? { sslThumbprint: entry.sslThumbprint } : {}),
  }));

  // Thumbprints are only omittable when validation is explicitly skipped.
  const missingThumbprints = hostSpecs.filter((h) => !h.sslThumbprint && !h.sshThumbprint).length;
  if (missingThumbprints > 0) {
    findings.push(
      info(
        'vcf.build.hosts-without-thumbprints',
        `${missingThumbprints} host(s) have no SSH or SSL thumbprint, so skipEsxThumbprintValidation must stay true.`,
        {
          path: 'hostSpecs',
          remediation:
            'Supply per-host thumbprints to validate host identity during bring-up, or leave validation skipped.',
          source: 'VCF Installer API — SddcHostSpec',
        },
      ),
    );
  }

  const duplicateHostnames = hostSpecs
    .map((h) => h.hostname)
    .filter((name, i, all) => all.indexOf(name) !== i);
  if (duplicateHostnames.length > 0) {
    findings.push(
      warning(
        'vcf.build.duplicate-hostnames',
        `Duplicate host name(s): ${[...new Set(duplicateHostnames)].join(', ')}.`,
        { path: 'hosts' },
      ),
    );
  }

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

  // Dual stack: emit an IPv6 twin for every network that defines an ipv6Cidr.
  // The API has no dual-stack field, so a network carrying both address
  // families is expressed as two entries sharing a VLAN.
  if (plan.dualStack) {
    const v6Candidates                                           = [
      ['MANAGEMENT', plan.management],
      ['VM_MANAGEMENT', vmMgmtPlan],
      ['VMOTION', plan.vmotion],
      ['VSAN', plan.vsan],
      ['NFS', plan.nfs],
      ['FLEET_MANAGEMENT', plan.fleetManagement],
    ];

    let emitted = 0;
    for (const [type, netPlan] of v6Candidates) {
      if (!netPlan?.ipv6Cidr) continue;
      const v6 = networkSpecV6(type, netPlan, {
        portGroupKey: `${prefix}-pg-${type.toLowerCase().replace(/_/g, '-')}-v6`,
      });
      if (v6) {
        networkSpecs.push(v6);
        emitted += 1;
      }
    }

    if (emitted === 0) {
      findings.push(
        warning(
          'vcf.build.dual-stack-without-v6',
          'Dual stack is enabled but no network defines an IPv6 prefix, so no IPv6 networks were emitted.',
          { path: 'dualStack', remediation: 'Set ipv6Cidr on the networks that should carry IPv6.' },
        ),
      );
    } else {
      findings.push(
        info(
          'vcf.build.dual-stack',
          `Emitted ${emitted} IPv6 network(s). Note the API declares maxLength 15 on gateway and 18 on subnet, sized for IPv4; whether those bounds are relaxed for IPv6 is not documented.`,
          { source: 'VCF Installer API — SddcNetworkSpec' },
        ),
      );
    }
  }

  // --- NSX -----------------------------------------------------------------
  const tepCidr = parseCidr(plan.hostTep.cidr);
  const tepCount = plan.tepPool?.count ?? plan.hostCount * (plan.pnicsPerHost ?? 2);
  const tepRange = tepCidr
    ? allocateRange(tepCidr, plan.tepPool?.offset ?? 9, Math.max(tepCount, 1))
    : null;

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
  // The shared model puts fleet-level components on the port group the
  // Instance-level components already use, which is the VM management network
  // when one is planned separately from management.
  const sharedHomeCidr = plan.vmManagement ? parseCidr(plan.vmManagement.cidr) : mgmtCidr;
  const vcfmsHomeCidr =
    networkModel.requiresDedicatedNetwork && plan.fleetManagement
      ? parseCidr(plan.fleetManagement.cidr)
      : sharedHomeCidr;
  const vcfmsPool = buildPool(plan.vcfmsPool, vcfmsHomeCidr, 31, VCFMS_RECOMMENDED_IPS);
  const vcfmsRange = vcfmsPool;
  const vcfmsIpv6 = buildPoolV6(plan.vcfmsIpv6Pool);

  const vspClusterSpec                     = {
    platformFqdn: name('vspPlatform', `${prefix}-msr01`),
    instanceFqdn: name('vspInstance', `${prefix}-int01`),
    // A secondary instance joins an existing fleet and must omit fleetFqdn.
    ...(secondary ? {} : { fleetFqdn: name('vspFleet', `${prefix}-flt01`) }),
    ipv4Pool: vcfmsPool ?? {},
    ...(vcfmsIpv6 ? { ipv6Pool: vcfmsIpv6 } : {}),
    ...(plan.internalClusterCidrIpv6
      ? { internalClusterCidrIpv6: plan.internalClusterCidrIpv6 }
      : {}),
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
        applianceSize: plan.opsSize ?? defaultApplianceSize(targetVersion, ha),
        ...(ha ? { loadBalancerFqdn: name('opsLoadBalancer', `${prefix}-ops`) } : {}),
        // A secondary instance attaches to the fleet's existing Operations.
        ...(secondary || plan.existing?.operations ? { useExistingDeployment: true } : {}),
      }
    : undefined;

  // --- Automation ----------------------------------------------------------
  // VVF has no VCF Automation at all, which the table records as n/a.
  const includeAutomation =
    componentTakesPart(rule, rule.automationExisting) && plan.includeAutomation !== false;
  const automationPool = buildPool(
    plan.automationPool,
    vcfmsHomeCidr,
    31 + VCFMS_RECOMMENDED_IPS,
    automationIpCount(targetVersion),
  );

  const vcfAutomationSpec                                = includeAutomation
    ? {
        hostname: name('automation', `${prefix}-auto01`),
        platformFqdn: name('automationPlatform', `${prefix}-asr01`),
        internalClusterCidr: plan.internalClusterCidr ?? INTERNAL_CLUSTER_CIDRS_V4[0],
        adminUserPassword: secret('automationAdmin', 'vcfAutomationSpec.adminUserPassword'),
        nodePrefix: `${prefix}-node-01`.toLowerCase(),
        // vcfAutomationSpec.ipPool is a plain string array, not an IPv4Pool,
        // so whichever pool form was chosen is flattened to addresses here.
        ...(automationPool ? { ipPool: poolToAddresses(automationPool) } : {}),
        size: plan.automationSize ?? defaultApplianceSize(targetVersion, ha),
        ...(plan.existing?.automation ? { useExistingDeployment: true } : {}),
      }
    : undefined;

  if (includeAutomation && !automationPool) {
    findings.push(
      warning(
        'vcf.build.automation-pool-not-allocated',
        `Could not allocate ${automationIpCount(targetVersion)} VCF Automation addresses after the VCFMS pool.`,
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

  // --- VCF management component networks -----------------------------------
  // Community reporting says only xRegionNetwork is required now, and that the
  // network must be VLAN-backed rather than NSX overlay.
  const mc = plan.managementComponentNetworks;
  const managementInfrastructure                                                        =
    mc?.local || mc?.xRegion
      ? {
          ...(mc.local ? { localRegionNetwork: mc.local } : {}),
          ...(mc.xRegion ? { xRegionNetwork: mc.xRegion } : {}),
        }
      : undefined;

  // --- target version -------------------------------------------------------
  // The version drives the Automation pool size and the appliance size
  // defaults, so a typo here changes the document rather than being cosmetic.
  if (compareVcfVersion(targetVersion, '9.1.0.0') < 0) {
    findings.push(
      warning(
        'vcf.build.version-below-9-1',
        `version "${targetVersion}" is below 9.1.0.0. This builder emits the 9.1 schema, which earlier releases do not accept.`,
        {
          path: 'version',
          remediation: `Target ${DEFAULT_VCF_VERSION} unless a specific earlier 9.1 patch is required.`,
          source: 'VCF Installer API — SddcSpec',
        },
      ),
    );
  }

  // --- management network model --------------------------------------------
  findings.push(
    info(
      'vcf.build.management-network-model',
      `Fleet-level components follow the ${networkModel.label}. ${networkModel.summary}`,
      { source: 'VCF 9.1 Design Library — VCF Management Network Detailed Design' },
    ),
  );

  if (networkModel.requiresDedicatedNetwork && !plan.fleetManagement) {
    findings.push(
      warning(
        'vcf.build.management-network-missing-dedicated',
        `${networkModel.label} requires a dedicated network for the fleet-level components, but none was planned. They fall back to the shared port group, which is a different model.`,
        {
          path: 'fleetManagement',
          remediation:
            'Add a fleetManagement network, or choose the VCF Management Shared VLAN Network Model.',
          source: 'VCF 9.1 Design Library — VCF Management Network Detailed Design',
        },
      ),
    );
  }

  if (!networkModel.requiresDedicatedNetwork && plan.fleetManagement) {
    findings.push(
      warning(
        'vcf.build.management-network-unused-dedicated',
        `${networkModel.label} shares the Instance-level port group, but a dedicated fleetManagement network was planned. It is emitted but the model does not place components on it.`,
        {
          path: 'fleetManagement',
          remediation: 'Choose a dedicated model, or drop the fleetManagement network.',
          source: 'VCF 9.1 Design Library — VCF Management Network Detailed Design',
        },
      ),
    );
  }

  if (networkModel.requiresOverlaySegment && !plan.managementComponentNetworks?.xRegion) {
    findings.push(
      warning(
        'vcf.build.management-network-missing-overlay',
        `${networkModel.label} places the remaining fleet-level components on an NSX overlay segment, but no segment was named.`,
        {
          path: 'managementComponentNetworks.xRegion',
          remediation:
            'Name the overlay segment with its networkName, subnetMask and gateway; all three are required.',
          source: 'VCF 9.1 Design Library — VCF Management Network Detailed Design',
        },
      ),
    );
  }

  if (networkModel.stretched && !plan.managementComponentNetworks?.local) {
    findings.push(
      warning(
        'vcf.build.management-network-missing-local-region',
        'A stretched overlay segment provides fleet disaster recovery across two regions, so a local region network is expected alongside the cross-region one.',
        {
          path: 'managementComponentNetworks.local',
          remediation:
            'Add the local region network, or choose the non-stretched overlay model.',
          source: 'VCF 9.1 Design Library — VCF Management Network Detailed Design',
        },
      ),
    );
  }

  if (includeOps) {
    findings.push(
      info('vcf.build.cloud-proxy-network', CLOUD_PROXY_ALWAYS_VM_MANAGEMENT, {
        path: 'vcfOperationsCollectorSpec',
        source: 'VCF 9.1 Design Library — VCF Management Dedicated VLAN Network Model',
      }),
    );
  }

  // --- assemble ------------------------------------------------------------
  const spec           = {
    sddcId: plan.sddcId,
    version: targetVersion,
    vcfInstanceName: plan.vcfInstanceName ?? plan.sddcId,
    // Taken from the scenario's own row. A secondary instance joining an
    // existing fleet must declare VCF_EXTEND rather than VCF, and a vSphere
    // Foundation platform must declare VVF; emitting the wrong one is a silent
    // misconfiguration rather than a rejected document.
    workflowType: plan.workflowType ?? rule.workflowType,
    ceipEnabled: plan.ceipEnabled ?? false,
    // Validation can only be enforced when every host carries a thumbprint.
    skipEsxThumbprintValidation: missingThumbprints > 0,
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
    ...(managementInfrastructure
      ? { vcfManagementComponentsInfrastructureSpec: managementInfrastructure }
      : {}),

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

    ...(includeNsx ? { nsxtSpec } : {}),

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

    // Fleet and lifecycle services. An empty object signals "deploy with
    // defaults", which is how a real working 9.1 spec expresses them. The LCM
    // hostnames mirror the vsp FQDNs, so they travel with vspClusterSpec rather
    // than being emitted on their own.
    ...(includeManagementServices
      ? {
          vspClusterSpec,
          fleetLcmSpec: { hostname: name('vspFleet', `${prefix}-flt01`) },
          sddcLcmSpec: { hostname: name('vspInstance', `${prefix}-int01`) },
        }
      : {}),
    fleetDepotSpec: {},
    telemetryAcceptorSpec: {},
    saltSpec: {},
    saltRaasSpec: {},

    ...(includeIdentityBroker
      ? { vidbSpec: { hostname: name('identityBroker', `${prefix}-idb01`) } }
      : {}),
    ...(includeLicenseServer
      ? { licenseServerSpec: { hostname: name('licenseServer', `${prefix}-lic01`) } }
      : {}),

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

  // VCF_BOOTSTRAP is the only workflowType left in the enum with no published
  // definition. VCF_COMPLETE is documented as the deferred-components workflow.
  if (plan.workflowType === 'VCF_BOOTSTRAP') {
    findings.push(
      warning(
        'vcf.build.undocumented-workflow-type',
        'workflowType "VCF_BOOTSTRAP" appears in the API enum but Broadcom publishes no definition of what it does.',
        {
          path: 'workflowType',
          remediation:
            'Use VCF for a new fleet, VCF_EXTEND for a further instance, VCF_COMPLETE for deferred components, or VVF for vSphere Foundation.',
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
