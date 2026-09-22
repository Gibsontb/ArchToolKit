/**
 * What is known about an application, and what the evaluation makes of it.
 *
 * One shape, used by the intake form, the portfolio, the CSV import and the
 * exported record, so an application evaluated last month reads the same as
 * one evaluated today.
 */

                                                       
                                                    

                          
                                                                        
                                      
                                   
                                 
                                   
                                  
                                       
                                        
                                          
                                       
                                  
 

                        
                               
                                        
                                   
                                  
                                   
                                            
 

                              
                        
                         
                                    
                            
                            
                                
                                                                   
                                               
                                
                             
                            
                                   
                                    
                                       
                          
                                    
                              
                            
                         
                                         
                        
                            
 

                                                                                              
                                             

                             
                             
                        
                             
                        
                                  
                      
                                                                  
                                          
                                   
                                                                   
                                               
 

                                 
                      
                                    
                                  
                               
                                                                                   
                          
 

export const DEFAULT_RATINGS          = {
  cloudCompatibility: 3,
  technicalDebt: 3,
  vendorLockRisk: 3,
  complianceComplexity: 3,
  architectureModularity: 3,
  refactorEffort: 3,
};

export const NO_GATES        = {
  isObsolete: false,
  vendorSaaSAvailable: false,
  mustStayOnPrem: false,
  hardwareBound: false,
  mainframeBound: false,
  dataSovereigntyRequired: false,
};

export const EMPTY_APPLICATION              = {
  name: '',
  owner: '',
  criticality: 'High',
  rtoHours: 24,
  rpoHours: 4,
  workloadType: 'General LOB App',
  enterpriseStandardCloud: '',
  primaryStack: '',
  osRuntime: '',
  database: '',
  hostingPlatform: '',
  integrationTypes: '',
  architecturePattern: '',
  vendor: '',
  integrationCount: 5,
  dataSizeGb: 200,
  identity: '',
  notes: '',
  compliance: [],
  gates: NO_GATES,
  ratings: DEFAULT_RATINGS,
};
