/**
 * A network foundation, described once and emitted for any cloud.
 *
 * Every cloud asks the same first question — a private network, some subnets, a
 * way out to the internet, and rules about what may enter — and then answers it
 * with entirely different nouns. A VPC is a VNet is a VCN. This holds the
 * question; the per-cloud modules hold each answer.
 *
 * The shape is deliberately small. It covers what an architect decides early and
 * has to keep consistent across clouds, not everything a provider can express.
 * Anything past this belongs in hand-written Terraform: a generator that tries to
 * cover every argument becomes one nobody can predict.
 */

                                                   
                                                  

                                   
                                                                 
                        
                        
                                                                                  
                            
     
                                                                           
                                                                             
     
                         
 

                                 
                                                                
                        
                        
                                                
                           
                                                   
                                                                                   
                                                   
                                               
                                                                                   
                                  
                                                                              
                               
                                                                     
                            
                                                            
                                      
 

                                   
                                                   
                                        
 

                                                                           

/** Sanitise a name for use as a Terraform identifier. */
export function identifier(...parts                   )         {
  return parts
    .join('_')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_');
}

/** Sanitise a name for use as a cloud resource name. */
export function resourceName(...parts                   )         {
  return parts
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

export const FOUNDATION_TARGETS                         = [
  'aws',
  'azure',
  'google',
  'oci',
  'vsphere',
];
