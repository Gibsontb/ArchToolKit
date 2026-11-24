                                                                  
import {error} from '../core/findings.js';
import {cfnTypeSchema,isKnownCfnType,loadCfnType,            } from '../editor/cloudformation-schema.js';
import {awsCloudFormation} from '../editor/profiles/aws.js';
                                           
function field(name       ,spec        ,required        )               {
 const code=typeof spec==='string'?spec:spec[0];const choices=typeof spec==='string'?undefined:spec[1];
 return {id:name,label:name+(required?' *':''),control:choices?'select':code==='b'?'select':code==='n'||code==='i'?'number':code.startsWith('a:')||code.startsWith('o:')||code==='j'?'textarea':'text',
 ...(choices?{options:choices.map(value=>({value,label:value})),blankLabel:'Choose a value'}:code==='b'?{options:[{value:'true',label:'True'},{value:'false',label:'False'}],blankLabel:'Leave unset'}:{}),
 hint:required?'Required by the CloudFormation resource schema':'Optional; blank omits this property',
 ...(code.startsWith('a:')||code.startsWith('o:')||code==='j'?{help:'Enter JSON. Nested required fields and types are validated against the resource schema.'}:{}),section:required?undefined:'Optional properties'};
}
export function awsCloudFormationBuild(type       )                    {
 if(!isKnownCfnType(type))return undefined;
 return {id:'cfn:'+type,label:type,description:'Configure this AWS CloudFormation resource using its registry schema. Existing dependencies must be supplied as resource identifiers or intrinsic references.',emits:[type],load:()=>loadCfnType(type),
 get inputs(){const schema=cfnTypeSchema(type);if(!schema)return [];return Object.entries(schema.p).filter(([name])=>!schema.ro?.includes(name)).sort(([a],[b])=>Number(schema.r?.includes(b)??false)-Number(schema.r?.includes(a)??false)).map(([name,spec])=>field(name,spec,schema.r?.includes(name)??false));},
 build(values){const schema=cfnTypeSchema(type);if(!schema)throw Error('Load the resource schema first');const properties                    ={};const findings=[];
 for(const [name,spec] of Object.entries(schema.p)){
  if(schema.ro?.includes(name))continue;const raw=values[name];if(raw===undefined||raw==='')continue;const code=typeof spec==='string'?spec:spec[0];
  try{if(code==='b'){if(raw!=='true'&&raw!=='false'&&typeof raw!=='boolean')throw Error('Choose True or False');properties[name]=raw===true||raw==='true';}
  else if(code==='n'||code==='i'){const n=Number(raw);if(!Number.isFinite(n)||(code==='i'&&!Number.isInteger(n)))throw Error('Enter a valid '+(code==='i'?'integer':'number'));properties[name]=n;}
  else if(code.startsWith('a:')||code.startsWith('o:')||code==='j')properties[name]=JSON.parse(String(raw));else properties[name]=String(raw);
  }catch(cause){findings.push(error('aws.cfn.input',name+': '+String(cause),{path:name}));}
 }
 const template={AWSTemplateFormatVersion:'2010-09-09',Resources:{Service:{Type:type,DeletionPolicy:'Retain',UpdateReplacePolicy:'Retain',Properties:properties}}};
 findings.push(...(awsCloudFormation.validate?.(template)??[]));
 return {files:{'template.json':JSON.stringify(template,null,2)+'\n'},findings};}
 };
}
