/**
 * Several blueprints assembled into one thing.
 *
 * Terraform calls it a root module — a `terraform apply` that stands up a
 * whole landing zone; Ansible calls it a site playbook — one
 * `ansible-playbook` run that configures the lot. Both pages hold the same
 * list of items and hand it to their own builder, so this is the vocabulary
 * they share.
 */

                                                   
                                                                 

                            
                                                                           
                      
                               
                                                                                  
                         
                                   
 

                                 
                                                                     
                              
                                                          
                        
                                                                                
                           
                             
 

                             
                                                   
                                        
                                                                  
                                                 
 

                                                                    

                               
                           
                                                                                  
                              
 

/** A file name and an identifier from an item's label. */
export function slug(label        , fallback        )         {
  const s = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || fallback;
}

/** `01-`, `02-`: the order the list is in, for reading. */
export function numbered(index        , name        , extension        )         {
  return `${String(index + 1).padStart(2, '0')}-${name}${extension}`;
}
