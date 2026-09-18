/**
 * VCF 9.1 `SddcSpec` — the VCF Installer bring-up document.
 *
 * Field names here are transcribed from the VCF Installer API reference
 * (`POST /v1/sddcs`, 9.1.1) and cross-checked against a real working 9.1.0.0
 * spec. They are deliberately exact, including the inconsistencies:
 *
 *  - `IpAddressPoolRangeSpec` uses `start` / `end`, while `IpRange` (used in
 *    `networkSpecs[].includeIpAddressRanges` and `IPv4Pool.ipRange`) uses
 *    `startIpAddress` / `endIpAddress`. Two different range shapes in one
 *    document.
 *  - `TeamingSpec.standByUplinks` has a capital B, unlike
 *    `SddcNetworkSpec.standbyUplinks`.
 *
 * Getting either wrong produces a spec the installer rejects, so they are not
 * "tidied up" here.
 *
 * VCF 9 replaced Cloud Builder with the VCF Installer appliance, but the
 * request body type name did not change — it is still `SddcSpec`.
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

                                  
                   
                   
 

/** Range shape used by networkSpecs and IPv4Pool. */
                          
                         
                       
 

/** IPv6 range. Same field names as IpRange but wider length bounds (2-39). */
                            
                         
                       
 

/** Range shape used by the NSX host TEP pool. Note: start/end, not *IpAddress. */
                                         
                
              
 

                                          
               
                  
                                                
 

                                    
                                  
               
                       
                                         
                                      
 

/** One of cidr / ipRange / addresses is required. */
                           
                
                    
                                                                     
                       
                                              
                               
 

                           
                
                                                                
                      
                       
                               
 

// ---------------------------------------------------------------------------
// Core specs
// ---------------------------------------------------------------------------

                          
                                                            
                    
                                                   
                         
 

                         
                
                   
             
          
         
                      
                  

                           
                    
                        
                       
                       
                            

                                               
                                                                  

                                  
                           
     
                                                                            
                                                                           
                   
     
                          
                  
                   
                      
               
                              
                                     
                                
                           
                                                              
                            
                                               
                        
                                      
                                                    
 

                                                                             
                                                          

                                  
                      
                          
                                                                  
                              
                         
                                   
                     
                                     
                                
                                
                   
                                  
                                                             
                         
 

                               
                                                                                
                   
                                
                                                                         
                         
                         
 

/**
 * EVC baselines.
 *
 * Two spellings below are Broadcom's own and are reproduced verbatim:
 * `INTEL_NEALEM` (not NEHALEM) and `AMD_STREAMROLLER` (not STEAMROLLER).
 * Correcting them would produce a value the installer rejects.
 */
                     
                 
                  
                  
                    
                       
                     
                   
                     
                   
                       
                   
                          
               
               
                           
                   
                   
                    
                      
             
              
              
              
                  

                                   
                      
                
                                              
                          
                          
                    
                                     
                             
                                    
                             
                             
                       
                                        
                               
                                       
 

                                  
                                   
                          
                                   
                       
                           
                                         
 

                                
               
                                    
 

                                   
                                   
                                               
                                                                   
                            
 

                              
                                                                         
                         
                          
                                                           
                                   
 

                                  
                
                     
                                
                             
                        
                                        
                              
                         
                                         
                                     
                                
                                                
                                              
                                         
                                                         
                    
               
                               
          
                     

/** LACP. Exposed in the UI for the first time in 9.1; previously API-only. */
                          
                      
               
                       
                                 
                                   
                                          
 

                                
                      
             
                       
                 
 

                          
                                                 
                   
                           
                      
               
                                      
                                   
                      
                                     
                              
 

                           
                        
                      
                              
                                
 

                          
                               
                       
                      
                       
                     
                      
 

                                  
                   
 

/** Only medium | large | xlarge are accepted for VCF bring-up. */
                                                            

/**
 * Overlay VTEP configuration.
 *
 * `NO_IP` disables VTEP creation entirely — the TEP-less deployment mode added
 * in 9.1.1.
 */
                                  
                     
 

                               
                                  
                  
                                                                      
                                    
                          
                                   
                             
                             
                   
                                    
                       
                                        
                    
                                                
                                          
                                  
                                      
                                    
                   
                                  
                         
 

                                
                   
                                 
 

                                   
                         
                    
                           
    
 

                           
                                                 
                         
                                       
                      
     
                                                                          
                                                               
     
                              
                            
                                      
 

                            
                       
               
                     
                   
                               
 

                                   
                        
                       
 

                                    
                                      
 

                                    
                      
                                      
                                        
                                            
                                 
 

                                  
                      
                   
                                                                       
                        
                                       
                       
                                                   
                             
                   
                                  
                         
 

                              
                
                      
 

                               
                                    
                              
 

// ---------------------------------------------------------------------------
// VCF 9.x components
// ---------------------------------------------------------------------------

                                    
                   
                      
                            
                                       
                         
 

                                    
                   
                             
                     
                             
                                                                   
                                                                     
                            
                                                                         
                                  
                   
 

                                             
                   
                      
                            
                       
                                       
                   
                                  
                         
 

                                    
                   
                                 
                              
                                               
                        
                      
                             
                    
                                                                              
                      
                
                   
                                  
                         
 

/** vSphere Supervisor / VCF Management Services runtime. */
                                     
                            
                       
                       
                                                                        
                     
                     
                      
                                                               
                              
                                                                        
                                                   
                                                                   
                                   
                                   
     
                                                                    
                                                                  
     
                
                   
                                  
                         
 

/**
 * Fleet and lifecycle service specs.
 *
 * The API documents these as `{ version, size }` only, but a real working spec
 * also carries `hostname` on fleetLcmSpec and sddcLcmSpec. The published schema
 * appears incomplete, so hostname is modelled as optional.
 */
                                      
                    
                   
                
 

                                     
                    
                   
                
 

/** Passed as an empty object to deploy with defaults. */
                                        
                    
                   
                
 

                                        
                    
                   
                
 

                           
                    
                   
                
 

                               
                    
                   
                
 

/** VCF Identity Broker. */
                           
                   
                   
                                       
                
 

/** Centralized License Server — mandatory in 9.1 for VCF and VVF. */
                                    
                   
                   
                                  
                         
 

                                                     
                       
                      
                   
                       
                      
 

                                                            
                                                          
                                                      
 

// ---------------------------------------------------------------------------
// Top-level document
// ---------------------------------------------------------------------------

                                                                                           

/**
 * The VCF Installer bring-up document.
 *
 * Required: sddcId, vcenterSpec, networkSpecs, dnsSpec.
 */
                           
                                              
                 
                               
                                  
                   

                              
                     
                           
                       
                   
                             
                                
                       
                          
                        
                                    
                              
                        
                                        
                                      
                              
                                    
                                      
                                     
                                   
                                         
                                                
                      
                      
                              
                                        
                                                          
                                        
                                                                                        
                                        
 

/**
 * Every top-level key the 9.1 schema defines, for completeness checking.
 */
export const SDDC_SPEC_TOP_LEVEL_KEYS = [
  'sddcId',
  'vcenterSpec',
  'networkSpecs',
  'dnsSpec',
  'workflowType',
  'vcfInstanceName',
  'version',
  'hostSpecs',
  'clusterSpec',
  'dvsSpecs',
  'nsxtSpec',
  'ntpServers',
  'sddcManagerSpec',
  'managementPoolName',
  'ceipEnabled',
  'skipEsxThumbprintValidation',
  'skipGatewayPingValidation',
  'securitySpec',
  'datastoreSpec',
  'vspClusterSpec',
  'fleetLcmSpec',
  'sddcLcmSpec',
  'fleetDepotSpec',
  'telemetryAcceptorSpec',
  'vidbSpec',
  'saltSpec',
  'saltRaasSpec',
  'vcfOperationsSpec',
  'vcfOperationsCollectorSpec',
  'vcfAutomationSpec',
  'vcfManagementComponentsInfrastructureSpec',
  'licenseServerSpec',
]         ;

export const SDDC_SPEC_REQUIRED_KEYS = ['sddcId', 'vcenterSpec', 'networkSpecs', 'dnsSpec']         ;

/**
 * Emitted by the builder wherever a plan supplies no secret.
 *
 * A spec carrying placeholders is deliberately incomplete rather than wrong, so
 * validation reports these as "not yet supplied" instead of failing them
 * against password complexity rules — which would be both misleading and noisy.
 */
export const PLACEHOLDER_SECRET = '<REQUIRED>';

export function isPlaceholderSecret(value         )          {
  return value === PLACEHOLDER_SECRET;
}

/**
 * Keys that existed in VCF 9.0 and were REMOVED in 9.1.
 *
 * `vcfOperationsFleetManagementSpec` corresponded to the VCF Fleet Management
 * Appliance, which KB 440630 confirms is no longer available in 9.1. A spec
 * carrying it is a 9.0 document and will not deploy on 9.1.
 */
export const REMOVED_IN_91_KEYS = ['vcfOperationsFleetManagementSpec']         ;
