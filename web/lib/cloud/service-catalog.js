/**
 * The cloud service catalog: every service AWS, Azure, Google Cloud and OCI
 * list, under its official name and category, with the Terraform resources
 * (and CloudFormation or ARM types) that build it.
 *
 * The data is generated per cloud by tools/fetch-service-catalog.mjs from the
 * providers' own lists and the Terraform registry, one file per cloud
 * (./service-catalog-<cloud>.ts), and is read here as one catalog. Nothing in
 * it is hand-written: a service the sources could not place is listed in
 * `unmatched` with the reason, not guessed at.
 *
 * Each resource's arguments are not repeated here; they are in the provider
 * schemas (src/terraform/cloud-schema-index.ts and web/data/terraform/).
 */

import { SERVICE_CATALOG_AWS } from './service-catalog-aws.js';
import { SERVICE_CATALOG_AZURE } from './service-catalog-azure.js';
import { SERVICE_CATALOG_GOOGLE } from './service-catalog-google.js';
import { SERVICE_CATALOG_OCI } from './service-catalog-oci.js';

                                                              

                               
             
                
                
             
              
                
                       
                           
                
               
           
                           
               
                     
                        
         
            

                                  
                                 
                         
 

/**
 * How a service can be built from the toolkit: with Terraform, only with the
 * provider's own templates (CloudFormation or ARM), or not at all.
 */
                                                        

                               
                                                              
                      
                                                                
                        
                                       
                                                                      
                                           
                                
                                                                              
                                        
                                                               
                                              
                                                                 
                                   
     
                                                                             
                                                                              
                                                                      
     
                                             
                                
                                                                      
                           
                                                               
                                     
     
                                                                          
                                                                          
                                                                     
     
                             
                         
                                         
                                   
                                                            
                           
                             
                                
 

                                
                      
                        
                       
                                                   
                         
 

/** Something the generator could not place, and why. */
                                 
                                                                                                               
                        
                          
                                               
                         
                                     
 

                                 
                            
                                                                     
                                  
                                 
                                    
                                            
                                              
                                        
                                          
                                         
                              
                                            
 

                                   
                               
                                       
                           
                                                                            
                                             
                                   
                                                                          
                                                 
                                                
                                             
 

const DATA                                                   = {
  aws: SERVICE_CATALOG_AWS,
  azure: SERVICE_CATALOG_AZURE,
  google: SERVICE_CATALOG_GOOGLE,
  oci: SERVICE_CATALOG_OCI,
};

const CATEGORIES                             = [
  { id: 'compute', label: 'Compute' },
  { id: 'containers', label: 'Containers' },
  { id: 'serverless', label: 'Serverless' },
  { id: 'storage', label: 'Storage' },
  { id: 'database', label: 'Database' },
  { id: 'networking', label: 'Networking' },
  { id: 'security-identity', label: 'Security & identity' },
  { id: 'management-governance', label: 'Management & governance' },
  { id: 'monitoring', label: 'Monitoring' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'ai-ml', label: 'AI / ML' },
  { id: 'integration-messaging', label: 'Integration & messaging' },
  { id: 'migration', label: 'Migration' },
  { id: 'developer-tools', label: 'Developer tools' },
  { id: 'end-user-computing', label: 'End-user computing' },
  { id: 'iot', label: 'IoT' },
  { id: 'other', label: 'Other' },
];

export const SERVICE_CLOUDS                          = ['aws', 'azure', 'google', 'oci'];

/** The common categories, in display order. */
export function categories()                             {
  return CATEGORIES;
}

/** The whole generated record for one cloud: sources, summary, unmatched. */
export function catalogFor(cloud              )                   {
  return DATA[cloud];
}

/** Every service of a cloud, by id. */
export function services(cloud              )                          {
  return DATA[cloud].services;
}

const byId = new Map                                         ();
function idIndex(cloud              )                            {
  let map = byId.get(cloud);
  if (!map) {
    map = new Map(DATA[cloud].services.map((s) => [s.id, s]));
    byId.set(cloud, map);
  }
  return map;
}

export function serviceById(cloud              , id        )                           {
  return idIndex(cloud).get(id);
}

/** The services of a cloud grouped by common category, in category order; empty categories are left out. */
export function servicesByCategory(cloud              )                                                          {
  const out = new Map                                   ();
  for (const c of CATEGORIES) out.set(c.id, []);
  for (const s of DATA[cloud].services) out.get(s.category)?.push(s);
  for (const [k, v] of out) {
    if (v.length === 0) out.delete(k);
    else v.sort((a, b) => a.name.localeCompare(b.name));
  }
  return out;
}

                                   
                                        
                                             
                                  
 

/** What builds a service: its Terraform resource types, and CloudFormation or ARM types. */
export function resourcesFor(cloud              , serviceId        )                   {
  const s = serviceById(cloud, serviceId);
  return {
    terraform: s?.terraform ?? [],
    cloudformation: s?.cloudformation ?? [],
    arm: s?.arm ?? [],
  };
}

                                
                               
                                 
 

let owners                                        ;

/**
 * The service a Terraform resource type (aws_db_instance), CloudFormation type
 * (AWS::RDS::DBInstance) or ARM type (Microsoft.Sql/servers) belongs to.
 * ARM types are compared without case, as Azure does.
 */
export function serviceForResource(type        )                            {
  if (!owners) {
    owners = new Map();
    for (const cloud of SERVICE_CLOUDS) {
      for (const service of DATA[cloud].services) {
        for (const t of service.terraform) owners.set(t, { cloud, service });
        for (const t of service.cloudformation ?? []) owners.set(t, { cloud, service });
        for (const t of service.arm ?? []) owners.set(t.toLowerCase(), { cloud, service });
      }
    }
  }
  return owners.get(type) ?? owners.get(type.toLowerCase());
}
