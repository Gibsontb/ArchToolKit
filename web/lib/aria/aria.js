/**
 * Aria Operations content, as something you can read.
 *
 * vROps 8.x and VCF Operations 9.x will export what is configured in them —
 * alert and symptom definitions, recommendations, policies, custom groups,
 * super metrics, notification rules, reports, dashboards — and the export is
 * accurate and unreadable. Alert definitions come out as a 5 MB JSON array;
 * dashboards come out as a zip of zips, one archive per dashboard, each one
 * holding a `dashboard.json` with the widget layout in it. Nobody reviews that.
 *
 * Which is the problem, because the questions people actually have about a
 * monitoring platform are questions about the whole of it, not about one
 * object: which alerts is nobody being told about, which symptoms does nothing
 * reference any more, which groups are still on the default policy, which
 * dashboards are duplicates of each other, which reports are defined and never
 * run. Those are answerable from these files and from nowhere else.
 *
 * So this reads the export into one shape, and `findings.ts` asks those
 * questions of it. Nothing leaves the browser: the files are read where they
 * are dropped, and the toolkit has no network calls to make.
 */

                                                                                              

                             
                                  
                                           
                                         
                                             
                            
                                                          
                          
                                                
 

                                  
                      
                        
                                
                               
                                
                               
                                 
                                         
                                                                      
                                  
 

                                    
                      
                        
                               
                                
                                  
                               
                                 
                                             
                        
                             
                          
                                                                  
                                  
                                  
 

                                 
                      
                               
 

                                
                      
                        
                              
                                                              
                             
                                
                                   
                                                                    
                                              
                                                                   
                                             
 

                            
                                
                               
                                         
 

                              
                      
                        
                             
                             
                                
                                       
                                                           
                                   
                                   
 

                              
                      
                        
                           
                                
                             
                                                   
                                        
 

                                   
                      
                        
                            
                               
                            
                                            
                                            
                                                                                  
                                                 
                                                                
                                            
                                      
                                                                
                                                        
 

                                       
                      
                        
                                
                                     
                             
                                 
 

                                   
                      
                        
                                
                                       
                                                                                
                                 
 

                                  
                        
                         
 

                                 
                      
                        
                                
                                       
                                                                  
                                 
 

                            
                                                                           
                      
                        
                           
                          
                            
                               
                                               
                                                       
                                      
                                                                               
                        
 

/** Where each part of the content came from, so the page can say what is missing. */
                             
                        
                        
                           
 

                              
                                              
                                                  
                                                      
                                              
                                          
                                                
                                              
                                                      
                                                
                                            
                                            
                                          
 

export const EMPTY_CONTENT              = {
  alerts: [],
  symptoms: [],
  recommendations: [],
  policies: [],
  groups: [],
  superMetrics: [],
  rules: [],
  templates: [],
  reports: [],
  views: [],
  dashboards: [],
  sources: [],
};

export function isEmpty(content             )          {
  return (
    content.alerts.length === 0 &&
    content.symptoms.length === 0 &&
    content.recommendations.length === 0 &&
    content.policies.length === 0 &&
    content.groups.length === 0 &&
    content.superMetrics.length === 0 &&
    content.rules.length === 0 &&
    content.templates.length === 0 &&
    content.reports.length === 0 &&
    content.views.length === 0 &&
    content.dashboards.length === 0
  );
}

/**
 * Merge two reads, so several files can be dropped one at a time.
 *
 * Field by field rather than record by record, because the same object arrives
 * in two shapes: the XML in the content package carries the policy's disabled
 * alerts and the alert's readable name, while the JSON inventory pulled from
 * the API carries the whole estate. Letting the later file replace the record
 * outright threw away whichever half was richer, which showed up as a policy
 * that suddenly disabled nothing and a report that was never scheduled.
 */
export function merge(a             , b             )              {
  const worth = (value         )          => {
    if (value === undefined || value === null || value === '') return false;
    if (Array.isArray(value)) return value.length > 0;
    return true;
  };

  const combine =                           (left   , right   )    => {
    const out                          = { ...left };
    for (const [key, value] of Object.entries(right)) {
      if (worth(value)) out[key] = value;
    }
    // A count of zero from one file must not overwrite a real count from
    // another, whichever order they were dropped in.
    for (const key of ['scheduleCount', 'attachedRuleCount']) {
      const before = (left                           )[key];
      const after = (right                           )[key];
      if (typeof before === 'number' && typeof after === 'number') out[key] = Math.max(before, after);
    }
    return out     ;
  };

  const pick =                           (left              , right              )               => {
    if (right.length === 0) return left;
    if (left.length === 0) return right;
    const merged = new Map(left.map((item) => [item.id, item]));
    for (const item of right) {
      const already = merged.get(item.id);
      merged.set(item.id, already ? combine(already, item) : item);
    }
    return [...merged.values()];
  };

  return {
    alerts: pick(a.alerts, b.alerts),
    symptoms: pick(a.symptoms, b.symptoms),
    recommendations: pick(a.recommendations, b.recommendations),
    policies: pick(a.policies, b.policies),
    groups: pick(a.groups, b.groups),
    superMetrics: pick(a.superMetrics, b.superMetrics),
    rules: pick(a.rules, b.rules),
    templates: pick(a.templates, b.templates),
    reports: pick(a.reports, b.reports),
    views: pick(a.views, b.views),
    dashboards: pick(a.dashboards, b.dashboards),
    sources: [...a.sources, ...b.sources],
  };
}

const SEVERITY_ORDER                                         = {
  critical: 5,
  immediate: 4,
  warning: 3,
  info: 2,
  auto: 1,
  unknown: 0,
};

export function severityOf(text                    )               {
  const lowered = String(text ?? '').toLowerCase();
  if (lowered === 'critical') return 'critical';
  if (lowered === 'immediate') return 'immediate';
  if (lowered === 'warning') return 'warning';
  if (lowered === 'info' || lowered === 'information') return 'info';
  if (lowered === 'auto') return 'auto';
  return 'unknown';
}

export function highestSeverity(values                         )               {
  let best               = 'unknown';
  for (const value of values) {
    if (SEVERITY_ORDER[value] > SEVERITY_ORDER[best]) best = value;
  }
  return best;
}

/**
 * What an object's severity means when Aria says AUTO.
 *
 * AUTO does not mean "no severity" — it means the alert takes the severity of
 * whichever symptom fired, which is worth saying on the page because a column
 * full of AUTO otherwise reads as missing data.
 */
export const SEVERITY_MEANING                                         = {
  critical: 'Critical — the highest severity Aria raises.',
  immediate: 'Immediate — below critical, above warning.',
  warning: 'Warning.',
  info: 'Information only.',
  auto: 'Takes the severity of whichever symptom fired, rather than a fixed one.',
  unknown: 'The export did not say.',
};

/** Count by a key, highest first — used for every census on the page. */
export function countBy   (items              , key                     )                                                               {
  const counts = new Map                ();
  for (const item of items) {
    const name = key(item) || '(none)';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
