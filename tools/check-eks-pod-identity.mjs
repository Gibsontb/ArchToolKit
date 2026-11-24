/** Exercise generated workload clients with local SDK doubles; no network or credentials. */
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_EKS_POD_IDENTITY_SERVICE as blueprint} from '../src/cloud/aws-eks-pod-identity-service.ts';
import {WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'eks-pod-identity-test-'));
const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',name:'application',cluster:'arn:aws:eks:us-east-1:123456789012:cluster/private-cluster',nodegroup:'application',agent_version:'v1.3.0-eksbuild.1',namespace:'application',service_account:'application',bucket:'application-data',vpce:'vpce-0123456789abcdef0',image:'123456789012.dkr.ecr.us-east-1.amazonaws.com/probes/pod-identity@sha256:'+'a'.repeat(64),access:'WRITE'});
if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const name of ['CLIENT.py','PREFLIGHT.py','CHECK.py','WORKLOAD-CONFIG.json'])writeFileSync(join(work,name),result.files[name]);
writeFileSync(join(work,'harness.py'),String.raw`import contextlib, io, json, os, pathlib, runpy, sys, types
root=pathlib.Path(__file__).resolve().parent
original=json.loads((root/'WORKLOAD-CONFIG.json').read_text())
class Config:
    def __init__(self,**kwargs):
        assert kwargs['retries']=={'total_max_attempts':1,'mode':'standard'}
        assert kwargs['use_fips_endpoint']==config['fips']
class Session:
    def __init__(self,**kwargs): assert kwargs['region_name']==original['region']
    def get_credentials(self):
        if case=='credential-error': raise RuntimeError('SECRET-SENTINEL')
        return types.SimpleNamespace(method='iam-role' if case=='node-role' else 'container-role')
    def client(self,name,**kwargs):
        assert name in ['sts','s3']; calls.append(name)
        self.meta=types.SimpleNamespace(service_model=types.SimpleNamespace(operation_model=lambda name:types.SimpleNamespace(input_shape=types.SimpleNamespace(members={} if case=='old-put-model' else {'IfNoneMatch':True}))))
        return self
    def get_caller_identity(self):
        if case=='sts-error': raise RuntimeError('SECRET-SENTINEL')
        return {'Account':'000000000000' if case=='account' else original['account'],'Arn':'other' if case=='role' else 'arn:aws:sts::'+original['account']+':assumed-role/'+original['roleName']+'/probe'}
    def head_object(self,**kwargs):
        assert kwargs=={'Bucket':original['bucket'],'Key':original['prefix']+'approved.txt','ExpectedBucketOwner':original['account']}
        operations.append('head')
        if case=='head-error': raise RuntimeError('SECRET-SENTINEL')
        return {'ContentLength':42}
    def put_object(self,**kwargs):
        assert kwargs['Bucket']==original['bucket'] and kwargs['ExpectedBucketOwner']==original['account']
        assert kwargs['Key'].startswith(original['prefix']+'pod-identity-probe-') and kwargs['IfNoneMatch']=='*'
        assert kwargs['Body']==b'ArchToolKit synthetic Pod Identity probe'
        operations.append('put')
        if case=='put-error': raise RuntimeError('SECRET-SENTINEL')
        return {'VersionId':'test-version'}
boto=types.ModuleType('boto3'); boto.Session=Session
core=types.ModuleType('botocore'); cfg=types.ModuleType('botocore.config'); cfg.Config=Config
sys.modules.update({'boto3':boto,'botocore':core,'botocore.config':cfg})
cases=[('identity',[],True),('head',['--head','approved.txt'],True),('put',['--put-test','--confirm-write'],True),('no-confirm',['--put-test'],False),('read-only',['--put-test','--confirm-write'],False),('old-put-model',['--put-test','--confirm-write'],False),('put-error',['--put-test','--confirm-write'],False),('head-error',['--head','approved.txt'],False),('traversal',['--head','../other'],False),('absolute',['--head','/other'],False),('empty-component',['--head','a//b'],False)]
cases += [(name,[],False) for name in ['credential-error','sts-error','node-role','account','role','old-sdk','uri','token','imds']]
blocked=['AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','AWS_WEB_IDENTITY_TOKEN_FILE','AWS_ROLE_ARN','AWS_PROFILE','AWS_DEFAULT_PROFILE','AWS_SHARED_CREDENTIALS_FILE']
cases += [(key,[],False) for key in blocked]
saved=dict(os.environ)
try:
    for case,args,success in cases:
        calls=[];operations=[]; output=io.StringIO(); config=dict(original)
        for key in list(os.environ):
            if key.startswith('AWS_'): del os.environ[key]
        os.environ.update(AWS_EC2_METADATA_DISABLED='true',AWS_CONTAINER_CREDENTIALS_FULL_URI='http://169.254.170.23/v1/credentials',AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE='/var/run/secrets/pods.eks.amazonaws.com/serviceaccount/eks-pod-identity-token')
        if case in blocked: os.environ[case]='SECRET-SENTINEL'
        if case=='uri': os.environ['AWS_CONTAINER_CREDENTIALS_FULL_URI']='http://example.invalid/credentials'
        if case=='token': os.environ['AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE']='/other'
        if case=='imds': os.environ['AWS_EC2_METADATA_DISABLED']='false'
        if case=='read-only': config['access']='READ'
        boto.__version__=core.__version__='1.34.0' if case=='old-sdk' else '1.44.0'
        (root/'WORKLOAD-CONFIG.json').write_text(json.dumps(config));sys.argv=['CLIENT.py']+args
        error=None
        try:
            with contextlib.redirect_stdout(output): runpy.run_path(str(root/'CLIENT.py'),run_name='__main__')
        except SystemExit as exc:
            if exc.code not in [0,None]: error=exc
        except Exception as exc: error=exc
        assert (error is None)==success,(case,error)
        assert 'SECRET-SENTINEL' not in output.getvalue()+str(error),case
        if case=='identity': assert calls==['sts'] and not operations
        if case in blocked or case in ['old-sdk','uri','token','imds']: assert not calls
        if case=='put-error': assert operations==['put']
        if success: json.loads(output.getvalue())
    print(str(len(cases))+' generated-client cases passed; local doubles only')
    class Operator(Session):
        def client(self,name,**kwargs):
            assert name in ['sts','eks','ec2','s3','iam','kms']; return self
        def describe_cluster(self,**kwargs):
            return {'cluster':{'arn':original['clusterArn'],'endpoint':'https://selected.eks.amazonaws.com','status':'CREATING' if case=='cluster-state' else 'ACTIVE','version':'1.28' if case=='cluster-version' else '1.33','computeConfig':{'enabled':case=='auto-mode'},'resourcesVpcConfig':{'endpointPrivateAccess':True,'endpointPublicAccess':case=='public-api','vpcId':'vpc-selected'}}}
        def describe_nodegroup(self,**kwargs):
            return {'nodegroup':{'clusterName':original['cluster'],'nodegroupName':original['nodegroup'],'status':'ACTIVE','amiType':'WINDOWS_CORE_2022_x86_64' if case=='windows' else original['amis'][0]}}
        def describe_addon(self,**kwargs):
            return {'addon':{'addonName':'eks-pod-identity-agent','status':'ACTIVE','addonVersion':'other' if case=='agent-version' else original['agentVersion'],'health':{'issues':[{'code':'issue'}] if case=='agent-health' else []}}}
        def describe_vpc_endpoints(self,**kwargs):
            return {'VpcEndpoints':[{'VpcEndpointId':original['vpce'],'State':'available','VpcId':'other' if case=='endpoint-vpc' else 'vpc-selected','ServiceName':'com.amazonaws.us-east-1.s3'}]}
        def get_bucket_location(self,**kwargs):
            assert kwargs=={'Bucket':original['bucket'],'ExpectedBucketOwner':original['account']}
            return {'LocationConstraint':'us-west-2' if case=='bucket-region' else None}
        def get_public_access_block(self,**kwargs):
            return {'PublicAccessBlockConfiguration':{key:case!='public-bucket' for key in ['BlockPublicAcls','IgnorePublicAcls','BlockPublicPolicy','RestrictPublicBuckets']}}
        def list_pod_identity_associations(self,**kwargs):
            assert kwargs==dict(clusterName=original['cluster'],namespace=original['namespace'],serviceAccount=original['serviceAccount'],maxResults=2)
            return {'associations':[{}] if case=='existing' else [],**({'nextToken':'more'} if case=='pagination' else {})}
        def describe_pod_identity_association(self,**kwargs):
            return {'association':dict(associationId='a-test',associationArn='arn:association',clusterName=original['cluster'],namespace='other' if case=='association-namespace' else original['namespace'],serviceAccount=original['serviceAccount'],roleArn=original['roleArn'],disableSessionTags=case=='disabled-tags',targetRoleArn='other' if case=='chaining' else '')}
        def get_role(self,**kwargs): return {'Role':{'Arn':original['roleArn'],'AssumeRolePolicyDocument':{} if case=='trust' else original['trust']}}
        def get_role_policy(self,**kwargs): return {'PolicyDocument':{} if case=='policy' else original['policy']}
        def describe_key(self,**kwargs): return {'KeyMetadata':{'Arn':config['kms'],'KeyState':'Disabled' if case=='kms-disabled' else 'Enabled','KeyManager':'CUSTOMER','KeySpec':'SYMMETRIC_DEFAULT','KeyUsage':'ENCRYPT_DECRYPT'}}
    import subprocess
    real_output=subprocess.check_output
    def terraform(arguments,**kwargs):
        if arguments[0]=='kubectl':
            assert kwargs['timeout']==30 and kwargs['stderr']==subprocess.PIPE
            assert arguments[:3]==['kubectl','--context','approved']
            if case=='context-error': raise subprocess.CalledProcessError(1,arguments,stderr='SECRET-SENTINEL')
            if arguments[3]=='config':
                assert '--raw' not in arguments
                if 'insecure-skip' in arguments[-1]: return 'true' if case=='insecure' else ''
                return 'https://other' if case=='wrong-context' else 'https://selected.eks.amazonaws.com'
            assert arguments[3:5]==['get','serviceaccount']
            return json.dumps({'metadata':{'name':original['serviceAccount'],'namespace':original['namespace'],'annotations':{'eks.amazonaws.com/role-arn':'other'} if case=='irsa' else {}}})
        assert arguments==['terraform','output','-json','pod_identity_job']
        return json.dumps({'role':original['roleArn'],'id':'a-test','arn':'arn:association'})
    subprocess.check_output=terraform; boto.Session=Operator
    boto.__version__=core.__version__='1.44.0'
    (root/'WORKLOAD-CONFIG.json').write_text(json.dumps(original))
    count=0
    try:
        for script,scenarios in [('PREFLIGHT.py',['ok','cluster-state','cluster-version','auto-mode','public-api','windows','agent-version','agent-health','endpoint-vpc','bucket-region','public-bucket','existing','pagination']),('CHECK.py',['ok','association-namespace','disabled-tags','chaining','trust','policy'])]:
            for case in scenarios:
                sys.argv=[script]; error=None
                try:
                    with contextlib.redirect_stdout(io.StringIO()): runpy.run_path(str(root/script),run_name='__main__')
                except Exception as exc: error=exc
                assert (error is None)==(case=='ok'),(script,case,error)
                count+=1
        for case in ['context-ok','wrong-context','insecure','irsa','context-error','kms-ok','kms-disabled','fips-ok']:
            config=dict(original)
            if case.startswith('kms'): config['kms']='arn:aws:kms:us-east-1:123456789012:key/test'
            config['fips']=case=='fips-ok'
            (root/'WORKLOAD-CONFIG.json').write_text(json.dumps(config))
            sys.argv=['PREFLIGHT.py']+(['--context','approved'] if case.startswith('context') or case in ['wrong-context','insecure','irsa'] else [])
            error=None
            try:
                with contextlib.redirect_stdout(io.StringIO()): runpy.run_path(str(root/'PREFLIGHT.py'),run_name='__main__')
            except Exception as exc: error=exc
            assert (error is None)==case.endswith('-ok'),(case,error)
            assert 'SECRET-SENTINEL' not in str(error)
            count+=1
        print(str(count)+' generated operator metadata cases passed; local doubles only')
    finally: subprocess.check_output=real_output
finally:
    os.environ.clear(); os.environ.update(saved)
    (root/'WORKLOAD-CONFIG.json').write_text(json.dumps(original))
`);
const run=spawnSync(process.env.PYTHON_PATH||'python',[join(work,'harness.py')],{encoding:'utf8'});
process.stdout.write(run.stdout||'');process.stderr.write(run.stderr||'');
if(run.status!==0)throw new Error('Pod Identity client checks failed: '+work);
console.log(work);
