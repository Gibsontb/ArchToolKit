/** Actual Private CA metadata inspector with SDK doubles; never creates/signs/activates CAs. */
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_PRIVATECA_SERVICE as blueprint,PCA_PROFILES} from '../src/cloud/aws-privateca-service.ts';
import {WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'privateca-inspect-'));const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',name:'reviewed-subordinate',account:'123456789012',common_name:'Approved Issuing CA G2',organization:'Approved Organization',approved:'true'});if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const name of ['INSPECT.py','CA-CONFIG.json'])writeFileSync(join(work,name),result.files[name]);writeFileSync(join(work,'profiles.json'),JSON.stringify(PCA_PROFILES));
writeFileSync(join(work,'test.py'),String.raw`import contextlib,copy,io,json,runpy,sys,types
from pathlib import Path
root=Path(__file__).resolve().parent;c=json.loads((root/'CA-CONFIG.json').read_text());original=copy.deepcopy(c);arn='arn:aws:acm-pca:'+c['region']+':'+c['account']+':certificate-authority/12345678-abcd-4bcd-8bcd-123456789abc'
base={'account':c['account'],'inventory':[],'tags':[{'Key':'Name','Value':c['name']}],'authority':{'Arn':arn,'Type':'SUBORDINATE','Status':'PENDING_CERTIFICATE','UsageMode':'GENERAL_PURPOSE','KeyStorageSecurityStandard':c['storage'],'CertificateAuthorityConfiguration':{'KeyAlgorithm':c['algorithm']['key'],'SigningAlgorithm':c['algorithm']['sign'],'Subject':c['subject']},'RevocationConfiguration':{'OcspConfiguration':{'Enabled':True},'CrlConfiguration':{'Enabled':False}}},'permissions':[],'policy':None,'policyError':'ResourceNotFoundException'}
class ClientError(Exception):
 def __init__(self,code):self.response={'Error':{'Code':code}}
class Config:
 def __init__(self,**kw):assert kw['use_fips_endpoint'] is True
class Session:
 def __init__(self,**kw):assert kw=={'region_name':c['region']}
 def client(self,name,**kw):assert name in ['sts','acm-pca'];return self
 def get_caller_identity(self):return {'Account':data['account']}
 def list_certificate_authorities(self,**kw):
  assert kw['ResourceOwner']=='SELF' and kw['MaxResults']==100
  if scenario=='ca-pages':return {'CertificateAuthorities':[] if kw.get('NextToken') else data['inventory'],**({} if kw.get('NextToken') else {'NextToken':'two'})}
  if scenario=='ca-token':return {'CertificateAuthorities':[],'NextToken':'repeat'}
  return {'CertificateAuthorities':data['inventory']}
 def list_tags(self,**kw):
  assert kw['CertificateAuthorityArn']==arn and kw['MaxResults']==100
  if scenario=='tag-pages':return {'Tags':data['tags'] if kw.get('NextToken') else [],**({} if kw.get('NextToken') else {'NextToken':'two'})}
  if scenario=='tag-token':return {'Tags':[],'NextToken':'repeat'}
  return {'Tags':data['tags']}
 def describe_certificate_authority(self,**kw):assert kw=={'CertificateAuthorityArn':arn};return {'CertificateAuthority':data['authority']}
 def list_permissions(self,**kw):
  assert kw['CertificateAuthorityArn']==arn and kw['MaxResults']==100
  if scenario=='permission-pages':return {'Permissions':[] if not kw.get('NextToken') else data['permissions'],**({} if kw.get('NextToken') else {'NextToken':'two'})}
  if scenario=='permission-token':return {'Permissions':[],'NextToken':'repeat'}
  return {'Permissions':data['permissions']}
 def get_policy(self,**kw):
  assert kw=={'ResourceArn':arn}
  if data['policy'] is None:raise ClientError(data['policyError'])
  return {'Policy':json.dumps(data['policy'])}
sys.modules['boto3']=types.SimpleNamespace(Session=Session);sys.modules['botocore']=types.ModuleType('botocore');sys.modules['botocore.config']=types.SimpleNamespace(Config=Config);sys.modules['botocore.exceptions']=types.SimpleNamespace(ClientError=ClientError)
cases=['preflight','ca-pages','pending','active','tag-pages','permission-pages','owner','existing-label','duplicate-ca','ca-token','tag-token','wrong-arn','root-type','wrong-state','short-lived','hsm-downgrade','key-profile','sign-profile','subject','ocsp-off','custom-ocsp','crl-enabled','tag-name','acm-grant','resource-policy','policy-denied','permission-token','active-no-arn']
active=['active','permission-pages','acm-grant','resource-policy','policy-denied','permission-token']
for scenario in cases:
 data=copy.deepcopy(base);flags=[] if scenario in ['preflight','ca-pages','existing-label','duplicate-ca','ca-token'] else ['--ca',arn];a=data['authority']
 if scenario in active:a['Status']='ACTIVE';flags+=['--active']
 if scenario=='owner':data['account']='000000000000'
 if scenario in ['existing-label','duplicate-ca']:data['inventory']=[{'Arn':arn}]
 if scenario=='duplicate-ca':data['inventory']*=2
 if scenario=='wrong-arn':a['Arn']='foreign'
 if scenario=='root-type':a['Type']='ROOT'
 if scenario=='wrong-state':a['Status']='DISABLED'
 if scenario=='short-lived':a['UsageMode']='SHORT_LIVED_CERTIFICATE'
 if scenario=='hsm-downgrade':a['KeyStorageSecurityStandard']='FIPS_140_2_LEVEL_2_OR_HIGHER'
 if scenario=='key-profile':a['CertificateAuthorityConfiguration']['KeyAlgorithm']='RSA_2048'
 if scenario=='sign-profile':a['CertificateAuthorityConfiguration']['SigningAlgorithm']='SHA256WITHRSA'
 if scenario=='subject':a['CertificateAuthorityConfiguration']['Subject']['CommonName']='Unreviewed CA'
 if scenario=='ocsp-off':a['RevocationConfiguration']['OcspConfiguration']['Enabled']=False
 if scenario=='custom-ocsp':a['RevocationConfiguration']['OcspConfiguration']['OcspCustomCname']='unreviewed.example'
 if scenario=='crl-enabled':a['RevocationConfiguration']['CrlConfiguration']['Enabled']=True
 if scenario=='tag-name':data['tags']=[]
 if scenario=='acm-grant':data['permissions']=[{'Principal':'acm.amazonaws.com','Actions':['IssueCertificate']}]
 if scenario=='resource-policy':data['policy']={'Version':'2012-10-17','Statement':[{'Effect':'Allow','Principal':'*'}]}
 if scenario=='policy-denied':data['policyError']='AccessDeniedException'
 if scenario=='active-no-arn':flags=['--active']
 sys.argv=['INSPECT.py']+flags;failure=None
 with contextlib.redirect_stdout(io.StringIO()) as out,contextlib.redirect_stderr(io.StringIO()):
  try:runpy.run_path(str(root/'INSPECT.py'),run_name='__main__')
  except BaseException as error:failure=error
 success=scenario in ['preflight','ca-pages','pending','active','tag-pages','permission-pages'];assert bool(failure)!=success,(scenario,failure)
 if success and scenario not in ['preflight','ca-pages']:
  report=json.loads(out.getvalue());assert report['authorityMetadataVerified'] is True and report['parentChainTrustProven'] is False and report['sameAccountIssuerPermissionsProven'] is False
for profile,pair in json.loads((root/'profiles.json').read_text()).items():
 c=copy.deepcopy(original);c['profile']=profile;c['algorithm']=pair;data=copy.deepcopy(base);data['authority']['CertificateAuthorityConfiguration'].update(KeyAlgorithm=pair['key'],SigningAlgorithm=pair['sign']);scenario='profile';(root/'CA-CONFIG.json').write_text(json.dumps(c));sys.argv=['INSPECT.py','--ca',arn]
 with contextlib.redirect_stdout(io.StringIO()):runpy.run_path(str(root/'INSPECT.py'),run_name='__main__')
(root/'CA-CONFIG.json').write_text(json.dumps(original))
print(str(len(cases))+' Private CA metadata/state/profile/revocation/permission cases and4profile variants passed; SDK doubles only')
`);
const check=spawnSync(process.env.PYTHON_PATH||'python',[join(work,'test.py')],{encoding:'utf8',windowsHide:true});process.stdout.write((check.stdout||'')+(check.stderr||''));if(check.error)throw check.error;if(check.status!==0)throw new Error('Inspect '+work);console.log(work);
