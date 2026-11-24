import { el } from '../dom.js';
import { field, select } from '../components.js';

export function landingZoneWalkthrough(steps                                                    )              {
  let active=0;
  const picker=select(steps.map((step,index)=>({value:String(index),label:`${index+1}. ${step.label}`})),'0');
  picker.setAttribute('data-control','landing-zone-step');
  const back=el('button',{class:'btn',text:'← Back',attrs:{type:'button'}});
  const next=el('button',{class:'btn btn-primary',text:'Next →',attrs:{type:'button'}});
  const status=el('span',{class:'small muted',attrs:{role:'status'}});
  const update=()=>{
    picker.value=String(active);
    steps.forEach((step,index)=>{step.content.style.display=index===active?'':'none';});
    back.disabled=active===0;next.disabled=active===steps.length-1;
    status.textContent=`Step ${active+1} of ${steps.length}`;
  };
  picker.addEventListener('change',()=>{active=Number(picker.value);update();});
  back.addEventListener('click',()=>{active=Math.max(0,active-1);update();});
  next.addEventListener('click',()=>{active=Math.min(steps.length-1,active+1);update();});
  const root=el('div',{class:'stack',attrs:{'data-control':'landing-zone-walkthrough'}},
    field('Setup step',picker),...steps.map(step=>step.content),el('div',{class:'btn-row'},back,status,next));
  update();return root;
}
