import { emptyPlan } from '../multicloud/plan/store.js';
import { PROJECT_DESTINATION_KEY } from '../multicloud/plan/dcexit/vmware-exit.js';
import { mount } from './multicloud/design.js';
import { landingZoneTarget } from './multicloud/landing-zone-flow.js';
import { card, field } from './components.js';
import { el } from './dom.js';
                                                   
                                                  
                                                        

/** Dedicated project storage. No migration plan, source inventory or tracker is loaded. */
const KEY='archtoolkit.landing-zone.project.v1';
export function mountLandingZonePage(root            ,project            )      {
  let plan={...emptyPlan('Landing zone'),mode:'landing-zone'         }        ;
  try{
    const saved=JSON.parse(localStorage.getItem(KEY)??'null');
    if(saved?.mode==='landing-zone'&&saved?.requirements&&saved?.designOverrides)plan={...plan,...saved,apps:[],appPlans:[],workloads:[],databases:[],mode:'landing-zone'};
  }catch{/* Start a fresh design if storage is unavailable. */}
  const query=new URLSearchParams(location.search);
  const hashTarget=location.hash.startsWith('#landing-zones:')?location.hash.slice('#landing-zones:'.length):'';
  const target=landingZoneTarget(hashTarget||query.get('provider')||query.get('platform')||'',query.get('environment')??'');
  const provider=target==='govcloud'?'aws':target==='azure-government'?'azure':target;
  if(provider)plan={...plan,designOverrides:{...plan.designOverrides,[PROJECT_DESTINATION_KEY]:provider}};
  if(query.get('region')&&['aws','azure','google','oci'].includes(provider))plan={...plan,requirements:{...plan.requirements,regions:{...plan.requirements.regions,[provider]:{primary:query.get('region') }}}};
  const listeners=new Set                                         ();
  const status=el('span',{class:'small muted',attrs:{role:'status'}});
  const persist=()=>{try{localStorage.setItem(KEY,JSON.stringify(plan));status.textContent='Design saved in this browser';}catch{status.textContent='Design held for this session';}};
  const session={
    plan:()=>plan,dirty:()=>false,stored:()=>true,
    update:(change                  )=>{plan={...change(plan),mode:'landing-zone',savedAt:new Date().toISOString()};persist();for(const listener of listeners)listener(plan,'edit');},
    subscribe:(listener                                        )=>{listeners.add(listener);return()=>listeners.delete(listener);},
  }               ;
  const name=el('input',{attrs:{type:'text',value:plan.name}});
  name.addEventListener('change',()=>session.update(current=>({...current,name:name.value.trim()||'Landing zone'})));
  project.append(card('Landing-zone project',field('Project name',name),status));
  persist();
  mount(root,{page:'migration-utilities',pane:'landing-zones',session,arg:()=>'',onArg:()=>()=>{},go:()=>{},refresh:async()=>{}}               );
}
const root=typeof document!=='undefined'?document.getElementById('landing-zone-root'):null;
const project=typeof document!=='undefined'?document.getElementById('landing-zone-project'):null;
if(root&&project)mountLandingZonePage(root,project);
