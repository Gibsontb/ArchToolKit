import {awsCloudFormationBuild} from '../cloud/aws-cloudformation-builds.ts';
import {withAwsServiceEligibility} from '../cloud/aws-service-eligibility.ts';
import {awsServiceDelivery} from '../cloud/aws-service-delivery.ts';
import { addServicesFor, type AddService } from '../cloud/add-service-catalog.ts';
import { LANDING_ZONE_TARGETS } from './multicloud/landing-zone-flow.ts';
import { mountGeneratorPage } from './generator-page.ts';
import { card,field,select } from './components.ts';
import { el,replace,downloadFile } from './dom.ts';
import { buildStack } from '../terraform/stack.ts';
import { putHandoff } from './handoff.ts';
import { categories } from '../cloud/service-catalog.ts';
import { placementRegionOptions, regionEnvironment, requiresRestrictedSite, RESTRICTED_SITES } from '../kit/placement-regions.ts';
import { zip } from '../kit/archive.ts';
import type { GeneratorOptions } from './generator-page.ts';

export function mountAddServicePage(root:HTMLElement):void {
  const query=new URLSearchParams(location.search);
  if(query.get('provider')==='azure-local')query.set('provider','azure');
  if(query.get('provider')==='govcloud'){query.set('provider','aws');query.set('environment','govcloud');}
  if(query.get('provider')==='azure-government'){query.set('provider','azure');query.set('environment','azure-government');}
  const platforms=LANDING_ZONE_TARGETS;
  const platform=select([{value:'',label:'Choose a platform'},...platforms],query.get('provider')==='vcf'?'vmware':query.get('provider')??'');
  let region:HTMLInputElement|HTMLSelectElement=select([{value:'',label:'Choose a region'}],'');
  const regionField=el('div');
  const environment=()=>regionEnvironment(platform.value,region.value);
  const account=el('input',{attrs:{type:'text',placeholder:'Account, subscription, project or site reference'}});
  const search=el('input',{attrs:{type:'search',placeholder:'Search services'}});
  const category=select([{value:'',label:'All categories'}],'');
  const service=select([{value:'',label:'Choose a service'}],'');
  const engine=select([{value:'terraform',label:'Terraform'},{value:'ansible',label:'Ansible'}],'terraform');
  const count=el('p',{class:'small muted',attrs:{role:'status'}});
  const details=el('div'),generator=el('div'),implementation=el('div');
  let initialPlacement=true;
  const projectRows=el('div',{class:'stack'});
  type Build=Parameters<NonNullable<GeneratorOptions['onGenerated']>>[0];
  let lastBuild:Build|undefined;
  let generation=0;
  const exportService=el('button',{class:'btn btn-primary',text:'Export deployment package',attrs:{type:'button',disabled:true},on:{click:()=>{
    if(!chosen||!lastBuild||lastBuild.findings.some(f=>f.severity==='error'))return;
    const manifest={kind:'archtoolkit.service-deployment',version:1,platform:platform.value,service:chosen.name,resource:lastBuild.blueprint,engine:engine.value,region:region.value.trim(),account:account.value.trim(),files:Object.keys(lastBuild.files)};
    const files={...lastBuild.files,'service-deployment.json':JSON.stringify(manifest,null,2)};
    const filename=(platform.value+'-'+chosen.name).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/-$/,'')+'-deployment.zip';
    void zip(files,new Date()).then(bytes=>downloadFile(filename,bytes,'application/zip'));
  }}});
  const project:{id:string;platform:string;environment:string;region:string;account:string;service:string;engine:string;files:Readonly<Record<string,string>>}[]=[];
  let sequence=0;
  const projectData=()=>({kind:'archtoolkit.service-project',version:1,services:project.map(({files,...item})=>({...item,files:Object.keys(files)}))});
  const archive=el('button',{class:'btn btn-primary',text:'Download service project',attrs:{type:'button',disabled:true},on:{click:()=>{
    const files:Record<string,string>={'service-project.json':JSON.stringify(projectData(),null,2),'README.md':'# Service project\n\nEach numbered service directory is a separate deployment and state boundary. Review its account, environment, region and variables before running its Terraform or Ansible project. Dependencies and shared resources must be resolved before deployment.\n'};
    for(const item of project)for(const [name,body] of Object.entries(item.files))files[item.id+'-'+item.platform+'/'+name]=body;
    void zip(files,new Date()).then(bytes=>downloadFile('service-project.zip',bytes,'application/zip'));
  }}});
  const add=el('button',{class:'btn',text:'Add configured service to project',attrs:{type:'button',disabled:true},on:{click:()=>{
    if(!chosen||!lastBuild||lastBuild.findings.some(f=>f.severity==='error'))return;
    project.push({id:String(++sequence).padStart(3,'0'),platform:platform.value,environment:environment(),region:region.value.trim(),account:account.value.trim(),service:chosen.name,engine:engine.value,files:{...lastBuild.files}});
    drawProject();
  }}});
  const invalidate=()=>{lastBuild=undefined;add.disabled=true;exportService.disabled=true;replace(implementation);};
  generator.addEventListener('input',invalidate);generator.addEventListener('change',invalidate);
  function drawProject():void{
    archive.disabled=project.length===0;
    replace(projectRows,...project.map(item=>el('div',{class:'field-row'},el('span',{text:item.service+' · '+item.platform+' · '+(item.region||'location not set')+' · '+item.account}),el('button',{class:'btn',text:'Remove',attrs:{type:'button'},on:{click:()=>{project.splice(project.indexOf(item),1);drawProject();}}}))));
  }
  root.append(card('Service selection',field('Platform',platform),regionField,field('Account / project / site',account),field('Search services',search),field('Category',category),field('Service',service),count),details,generator,implementation,card('Deployment package',exportService),card('Service project',add,projectRows,archive));
  let rows:readonly AddService[]=[];
  let chosen:AddService|undefined;
  function filter():void{
    const term=search.value.trim().toLowerCase();
    const shown=rows.filter(row=>(!category.value||(row.categories??[row.category]).includes(category.value))&&(!term||(row.name+' '+row.description).toLowerCase().includes(term)));
    const prior=service.value;
    replace(service,el('option',{text:'Choose a service',attrs:{value:''}}),...shown.map(row=>el('option',{text:row.name,attrs:{value:row.id}})));
    if(shown.some(row=>row.id===prior))service.value=prior;
    count.textContent=shown.length+' of '+rows.length+' catalog entries';
    if(service.value!==chosen?.id)showService();
  }
  function showGenerator():void{
    const currentGeneration=++generation;
    invalidate();replace(generator);if(!chosen||chosen.availability?.status==='retired')return;
    if(!region.checkValidity()){generator.append(card('Placement',el('p',{text:'Select a region for this service placement.'})));return;}
    if(requiresRestrictedSite(platform.value,region.value)){
      const source=RESTRICTED_SITES[platform.value]?.find(site=>site.value===region.value)?.reference;
      generator.append(card('Restricted-site build',el('p',{text:'This site requires its enclave-specific region identifier, endpoints and qualified service definitions. Public-cloud build files are not generated for this selection.'}),source?el('a',{text:'Provider documentation',attrs:{href:source,target:'_blank',rel:'noopener'}}):null));
      return;
    }
    const sourceBlueprints=engine.value==='cloudformation'?chosen.native.flatMap(type=>{const build=awsCloudFormationBuild(type);return build?[build]:[]}):engine.value==='ansible'?chosen.ansible:chosen.terraform;
    const blueprints=platform.value==='aws'?sourceBlueprints.map(build=>withAwsServiceEligibility(build,chosen?.availability)):sourceBlueprints;
    if(!blueprints.length)return;
    mountGeneratorPage(generator,{
      groups:[{target:platform.value,label:platform.selectedOptions[0]!.textContent??platform.value,blueprints}],
      kindLabel:engine.value==='cloudformation'?'CloudFormation':engine.value==='terraform'?'Terraform':'Ansible',noun:'service resource',downloadExtension:engine.value==='cloudformation'?'.json':engine.value==='terraform'?'.tf':'.yml',
      settingsKind:'archtoolkit.add-service.'+engine.value,sharedPlatform:false,
      idleHint:'Configure the service resource and generate its build files.',
      valuesFor:()=>({'p.region':region.value,aws_region:region.value,'r.region':region.value,region:region.value,location:region.value,'p.environment':environment()==='azure-government'?'usgovernment':'public',...(platform.value==='azure'&&account.value?{'p.subscription_id':account.value}:{}),...(platform.value==='google'&&account.value?{'p.project':account.value}:{})}),
      openWith:()=>({blueprint:blueprints[0]!.id,values:{'p.region':region.value,aws_region:region.value,'r.region':region.value,region:region.value,location:region.value,'p.environment':environment()==='azure-government'?'usgovernment':'public',...(platform.value==='azure'&&account.value?{'p.subscription_id':account.value}:{}),...(platform.value==='google'&&account.value?{'p.project':account.value}:{})}}),
      onGenerated:result=>{if(currentGeneration!==generation)return;const files=platform.value==='aws'?{...result.files,'IMPLEMENTATION.md':awsServiceDelivery({service:chosen!.name,region:region.value,account:account.value,engine:engine.value,files:result.files})}:result.files;lastBuild={...result,files};if(platform.value==='aws'&&!result.findings.some(f=>f.severity==='error'))replace(implementation,card('Implementation',el('p',{text:'Export this deployment package with its build files and IMPLEMENTATION.md, or add it to a multi-service project.'}),el('details',{},el('summary',{text:'View deployment instructions'}),el('pre',{text:files['IMPLEMENTATION.md']}))));add.disabled=result.findings.some(f=>f.severity==='error');exportService.disabled=add.disabled;},
      ...(engine.value==='terraform'?{stack:{noun:'service stack',build:(items,lookup,options)=>buildStack(items,lookup,{target:platform.value as never,stackName:options.stackName})}}:{}),
    });
  }
  function showService():void{
    generation++;invalidate();
    chosen=rows.find(row=>row.id===service.value);replace(details);replace(generator);if(!chosen)return;
    const runtime=chosen.runtimeApi,related=runtime?rows.find(row=>row.id===runtime.setupService):undefined;
    const options=chosen.availability?.status==='retired'?[]:[...(chosen.terraform.length?[{value:'terraform',label:'Terraform'}]:[]),...(chosen.ansible.length?[{value:'ansible',label:'Ansible'}]:[]),...(platform.value==='aws'&&chosen.native.some(type=>awsCloudFormationBuild(type))?[{value:'cloudformation',label:'CloudFormation'}]:[])];
    replace(engine,...options.map(option=>el('option',{text:option.label,attrs:{value:option.value}})));
    details.append(card(chosen.name,el('p',{text:chosen.description}),chosen.snapshot?el('p',{class:'small muted',text:'Catalog snapshot: '+chosen.snapshot}):null,
      chosen.availability?el('p',{class:'small'},el('span',{text:chosen.availability.message+' '}),el('a',{text:'AWS availability details',attrs:{href:chosen.availability.reference,target:'_blank',rel:'noopener'}})):null,
      runtime?el('p',{class:'small',text:runtime.message}):null,
      runtime?el('a',{text:'API reference',attrs:{href:runtime.reference,target:'_blank',rel:'noopener'}}):null,
      related?el('button',{class:'btn',text:'Open '+related.name+' setup',attrs:{type:'button'},on:{click:()=>{search.value='';category.value='';filter();service.value=related.id;showService();}}}):null,
      options.length?field('Build with',engine):runtime||chosen.availability?.status==='retired'?null:el('p',{text:chosen.native.length?'Available through provider-native templates. No Terraform or Ansible build definition is loaded for this service.':'No build definition is loaded for this service.'}),
      chosen.native.length?el('details',{},el('summary',{text:'Provider-native resource types'}),el('pre',{text:chosen.native.join('\n')})):null));
    if(platform.value!=='aws'&&chosen.native.length&&!requiresRestrictedSite(platform.value,region.value)){
      const resource=select(chosen.native.map(type=>({value:type,label:type})),chosen.native[0]!);
      details.append(card('Provider-native template',field('Native resource type',resource),el('button',{
        class:'btn',text:'Configure native template',attrs:{type:'button'},on:{click:()=>{
          const aws=resource.value.startsWith('AWS::');
          const document=aws?{AWSTemplateFormatVersion:'2010-09-09',Resources:{Service:{Type:resource.value,Properties:{}}}}:
            {$schema:'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',contentVersion:'1.0.0.0',resources:[{type:resource.value,apiVersion:'',name:'',properties:{}}]};
          putHandoff('spec-to-editor',chosen!.name,document);
          location.assign('data-editor.html?profile='+(aws?'aws-cloudformation':'azure-arm'));
        }},
      })));
    }
    showGenerator();
  }
  function changePlatform():void{
    updateRegions();
    if(initialPlacement&&query.get('region'))region.value=query.get('region')!;
    initialPlacement=false;
    search.value='';chosen=undefined;rows=addServicesFor(platform.value);
    replace(category,el('option',{text:'All categories',attrs:{value:''}}),...[...new Set(rows.flatMap(row=>row.categories??[row.category]))].sort().map(value=>el('option',{text:categories().find(category=>category.id===value)?.label??value,attrs:{value}})));
    replace(details);replace(generator);filter();
    if(['ahv','hpe'].includes(platform.value))details.append(card('Platform integration',el('p',{text:'Platform-native build definitions are not loaded yet.'})));
  }
  function updateRegions():void{
    const choices=placementRegionOptions(platform.value);
    region=choices.length?select([{value:'',label:'Choose a region / site'},...choices],''):el('input',{attrs:{type:'text',placeholder:'Enter the site or platform endpoint'}});
    region.required=choices.length>0;
    region.addEventListener('change',showGenerator);
    replace(regionField,field('Region / site',region));
  }
  account.addEventListener('change',showGenerator);
  platform.addEventListener('change',changePlatform);search.addEventListener('input',filter);category.addEventListener('change',filter);service.addEventListener('change',showService);engine.addEventListener('change',showGenerator);
  changePlatform();
}
const root=typeof document!=='undefined'?document.getElementById('add-service-root'):null;
if(root)mountAddServicePage(root);
