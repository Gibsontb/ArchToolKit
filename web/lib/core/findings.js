/**
 * Findings are the universal currency for anything the toolkit wants to tell the
 * user about their input: schema violations, sizing shortfalls, unsupported
 * brownfield topologies, migration blockers.
 *
 * Every engine in the toolkit emits Findings rather than throwing or returning
 * bare booleans, so the UI can render them uniformly and the user always gets
 * the *reason*, not just a red border.
 */

                                                    

                          
                                                                         
                        
                              
                                                              
                           
                                                                           
                         
                                          
                                
     
                                                                               
                                                                       
     
                           
 

export function error(
  code        ,
  message        ,
  extra                                                          = {},
)          {
  return { code, message, severity: 'error', ...extra };
}

export function warning(
  code        ,
  message        ,
  extra                                                          = {},
)          {
  return { code, message, severity: 'warning', ...extra };
}

export function info(
  code        ,
  message        ,
  extra                                                          = {},
)          {
  return { code, message, severity: 'info', ...extra };
}

export function hasErrors(findings                    )          {
  return findings.some((f) => f.severity === 'error');
}

export function countBySeverity(
  findings                    ,
)                           {
  const counts                           = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}

/** Errors first, then warnings, then info; stable within a severity. */
export function sortFindings(findings                    )            {
  const rank                           = { error: 0, warning: 1, info: 2 };
  return [...findings].sort((a, b) => rank[a.severity] - rank[b.severity]);
}
