/**
 * The pattern model (addendum A.4.1): what a catalogue entry states, the
 * sourced facts it rests on, and the small helpers the pattern rules use to
 * find an item's app, app plan, answers and tier pattern.
 *
 * Every fact carries a source URL and a verification tag. `V-DOC` was read
 * from the vendor's own page; `C` is a community or secondary source; `I` is
 * inferred or recalled and not re-read — the UI shows it as "[U]" (unverified)
 * through `verificationBadge`.
 *
 * No behaviour beyond lookups lives here, and nothing here imports a family
 * file, so every family can import it without a cycle.
 */

                                                       
import { isDatabase,               } from '../decide/disposition.js';
             
                                                                                                                    
                                                    
                     

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

                       
                        
                                              
                          
                                      
 

export const fact = (text        , source        , verification               = 'V-DOC')       => Object.freeze({ text, source, verification });

/** '' for vendor-verified, '[C]' for a community source, '[U]' for inferred / unverified. */
export function verificationBadge(v              )                     {
  return v === 'I' ? '[U]' : v === 'C' ? '[C]' : '';
}

/** A fact the UI must flag: not verified from the vendor's own documentation. */
export const isUnverified = (f                            )          => f.verification === 'I' || f.verification === 'C';

// ---------------------------------------------------------------------------
// Tier patterns per platform
// ---------------------------------------------------------------------------

/** What a tier pattern becomes on one platform. */
                             
                                               
                           
                                                                                     
                                        
                                                                                                     
                                
                         
                           
 
/** The tier pattern does not exist on the platform: the reason. */
                                                   
                                               

export const isNone = (o            )                => 'none' in o;

                                  
                           
                                                               
                                  
 

// ---------------------------------------------------------------------------
// Pattern entries
// ---------------------------------------------------------------------------

                                                                                                                     
                                                          

/**
 * - `automated`: the Factory generates the target and the move.
 * - `partial`: the target is generated; some steps are vendor tools run by hand (runbook).
 * - `honest-path`: assessment, a sourced target recommendation and a runbook only; nothing is automated
 *   because the replication cannot exist (non-x86, mainframe).
 */
                                                                    

                                                                  
                                 
                                                                           
                       
                         
                              
                                      
                                       
                         
                            
 

                                    
                        
                               
                                                          
                                                   
                                  
                                    
                                                                    
                                                                          
                                                                    
                                                 
 

                                   
                                                                                                                            
                                                                              
                                                                                 
                                              
                                                                                                                        
                                            
                                                                   
                                       
 

                               
                          
                                 
                         
                                                                         
                                               
                                                
                                                     
                                    
                                                    
                                                     
                                                       
                                       
                                                         
                                  
                                 
                                                                    
                                  
                                                                                   
                                                   
 

/** A score for a tier pattern of a pattern's component, optionally only on some platforms / answers. */
                                 
                                    
                         
                                            
                        
                          
                          
                                      
                                           
                                                               
                                                                               
                                                           
                               
 

// ---------------------------------------------------------------------------
// Rule helpers: an item's app, plan, answers, tier pattern and type
// ---------------------------------------------------------------------------

export function appPlanFor(app                 , ctx                           )                      {
  if (!app) return undefined;
  return (ctx.plan.appPlans ?? []).find((p) => p.app === app.id);
}

export function patternOf(item          , ctx             )                         {
  return ctx.appOf(item)?.pattern;
}

export function answersOf(item          , ctx             )                                   {
  return appPlanFor(ctx.appOf(item), ctx)?.answers ?? {};
}

/** The pattern component that carries the item on a platform's variant (else the chosen platform's, else any). */
export function componentOf(item          , ctx             , platform           )                               {
  const ap = appPlanFor(ctx.appOf(item), ctx);
  if (!ap) return undefined;
  const holds = (c                  )          => (isDatabase(item) ? c.databases.includes(item.name) : c.servers.includes(item.name));
  const find = (p                      )                               => {
    if (!p) return undefined;
    for (const c of ap.variants[p] ?? []) if (c.kind === 'pattern' && holds(c)) return c;
    return undefined;
  };
  const direct = find(platform) ?? find(ap.platform);
  if (direct) return direct;
  for (const list of Object.values(ap.variants)) {
    for (const c of list ?? []) if (c.kind === 'pattern' && holds(c) && c.tierPattern) return c;
  }
  return undefined;
}

/** The tier pattern set for the item's component on `platform` (undefined = the pattern's default). */
export function tierPatternOf(item          , ctx             , platform          )                          {
  return componentOf(item, ctx, platform)?.tierPattern;
}

/** The workload's type: the set one, else a detection at or above the threshold. */
export function workloadTypeOf(w          )                           {
  if (w.workloadType && w.workloadType !== 'unknown') return w.workloadType;
  const d = w.facts?.detection;
  return d && d.confidence >= 0.7 && d.type !== 'unknown' ? d.type : undefined;
}

/** A number from a component setting, then an answer, else undefined. */
export function numberAnswer(item          , ctx             , settingKey        , answerKey        )                     {
  const c = componentOf(item, ctx);
  const raw = c?.settings[settingKey] ?? answersOf(item, ctx)[answerKey];
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

