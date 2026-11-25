                                                   
import {error} from '../core/findings.js';
import {AWS_ACCESSANALYZER_SERVICE as implementation} from './aws-accessanalyzer-service.js';
const types=[{value:'ACCOUNT',label:'Account — external access'},{value:'ORGANIZATION',label:'Organization — external access'},{value:'ACCOUNT_UNUSED_ACCESS',label:'Account — unused access'},{value:'ORGANIZATION_UNUSED_ACCESS',label:'Organization — unused access'}];
/** Preserve the established form ID and analysis/type dropdown while strengthening its implementation. */
export const AWS_ACCESS_ANALYZER_SERVICE={
 ...implementation,id:'aws_service_access_analyzer',
 inputs:[...implementation.inputs.filter(input=>!['analysis','zone','organization','age'].includes(input.id)),{id:'type',label:'Analysis and trust scope',control:'select',default:'ACCOUNT',options:types},{id:'organization',label:'Expected AWS organization ID',control:'text',showWhen:{input:'type',equals:['ORGANIZATION','ORGANIZATION_UNUSED_ACCESS']}},{id:'age',label:'Unused access age (days)',control:'number',default:90,min:1,max:180,showWhen:{input:'type',equals:['ACCOUNT_UNUSED_ACCESS','ORGANIZATION_UNUSED_ACCESS']}}],
 build(values)                                        {
  const type=String(values.type??''),unused=type.endsWith('_UNUSED_ACCESS'),age=Number(values.age);
  const result=implementation.build({...values,analysis:unused?'UNUSED':'EXTERNAL',zone:type.startsWith('ORGANIZATION')?'ORGANIZATION':'ACCOUNT'});
  if(!types.some(option=>option.value===type))result.findings.push(error('aws.access-analyzer.type','Select an analyzer type and trust scope.',{path:'type'}));
  if(unused&&(!Number.isInteger(age)||age<1||age>180))result.findings.push(error('aws.access-analyzer.age','Use an unused-access age from1–180days.',{path:'age'}));
  return {...result,files:{...result.files,'GET-FINDINGS.ps1':'$ErrorActionPreference = "Stop"\r\npython (Join-Path $PSScriptRoot "INSPECT.py") --check --findings\r\nif ($LASTEXITCODE -ne 0) { throw "Analyzer inspection failed." }\r\n'}};
 },
}                    ;
