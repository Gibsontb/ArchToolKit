/**
 * Provenance tagging for VCF sizing and schema data.
 *
 * This toolkit generates real deployment configurations, so a number that came
 * from a blog post must never be indistinguishable from one that came from
 * Broadcom's own documentation. Every table entry carries a verification tag,
 * and the UI surfaces it, so the user always knows how much weight a figure
 * can bear.
 */

                          
                                                                   
           
                                                                     
           
                                                                  
            
                                                          
       
                                                      
        

                             
                    
                                      
                                                                 
                           
                                                            
                           
 

export function sourced   (
  value   ,
  verification              ,
  source         ,
  caveat         ,
)             {
  return { value, verification, ...(source ? { source } : {}), ...(caveat ? { caveat } : {}) };
}

const CONFIDENCE_ORDER                               = {
  'V-API': 0,
  'V-DOC': 1,
  'V-SPEC': 2,
  C: 3,
  I: 4,
};

/** True when a figure is official (Broadcom API, docs, or a real working spec). */
export function isAuthoritative(verification              )          {
  return verification === 'V-API' || verification === 'V-DOC' || verification === 'V-SPEC';
}

/**
 * The weakest tag across a set of inputs.
 *
 * A total built from one official and one community number is only as
 * trustworthy as the community number, and reporting it as official would be
 * misleading.
 */
export function weakestVerification(tags                         )               {
  if (tags.length === 0) return 'I';
  return tags.reduce((worst, tag) =>
    CONFIDENCE_ORDER[tag] > CONFIDENCE_ORDER[worst] ? tag : worst,
  );
}

export const VERIFICATION_LABELS                               = {
  'V-API': 'Verified — VCF Installer API reference',
  'V-DOC': 'Verified — Broadcom TechDocs / KB',
  'V-SPEC': 'Verified — real working 9.1.0.0 spec',
  C: 'Community source — indicative only',
  I: 'Inferred — not directly documented',
};
