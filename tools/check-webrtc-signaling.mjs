/** Generated signaling metadata checks with local SDK doubles; no ICE, connections or media. */
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_WEBRTC_SERVICE as blueprint} from '../src/cloud/aws-webrtc-service.ts';
import {WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'webrtc-signaling-test-'));
const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',name:'approved-peers',account:'123456789012',stack_role:'arn:aws:iam::123456789012:role/deploy/SignalingStack',master:'arn:aws:iam::123456789012:role/devices/PeerMaster',viewer:'arn:aws:iam::123456789012:role/apps/PeerViewer',approved:true});
if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const name of ['PREFLIGHT.py','CHECK.py','SIGNALING-CONFIG.json'])writeFileSync(join(work,name),result.files[name]);
writeFileSync(join(work,'harness.py'),String.raw`import contextlib, io, json, pathlib, runpy, subprocess, sys, types
root=pathlib.Path(__file__).resolve().parent;config=json.loads((root/'SIGNALING-CONFIG.json').read_text())
job={'arn':'arn:aws:kinesisvideo:us-east-1:123456789012:channel/approved-peers/1234567890123','stack':'arn:aws:cloudformation:us-east-1:123456789012:stack/approved-peers-signaling/example'}
class Config:
    def __init__(self,**kwargs): assert kwargs['retries']['total_max_attempts']==1
class Session:
    def __init__(self,**kwargs): assert kwargs==dict(region_name=config['region'])
    def client(self,name,**kwargs): assert name in ['sts','iam','cloudformation','kinesisvideo'];return self
    def get_caller_identity(self):return {'Account':'other' if case=='account' else config['account']}
    def get_role(self,**kwargs):
        matches=[role for role in [config['stackRole'],config['master'],config['viewer']] if role.rsplit('/',1)[1]==kwargs['RoleName']]
        assert len(matches)==1
        return {'Role':{'Arn':'other' if case=='role' else matches[0]}}
    def describe_stacks(self,**kwargs):
        assert kwargs==dict(StackName=job['stack'])
        return {'Stacks':[dict(StackId=job['stack'],StackName=config['name']+'-signaling',RoleARN='other' if case=='stack-role' else config['stackRole'],StackStatus='ROLLBACK_COMPLETE' if case=='stack-state' else 'CREATE_COMPLETE',Outputs=[dict(OutputKey='ChannelArn',OutputValue='other' if case=='stack-output' else job['arn'])])]}
    def describe_signaling_channel(self,**kwargs):
        assert kwargs==dict(ChannelARN=job['arn'])
        return {'ChannelInfo':dict(ChannelARN=job['arn'],ChannelName='other' if case=='name' else config['name'],ChannelType='FULL_MESH' if case=='type' else 'SINGLE_MASTER',ChannelStatus='CREATING' if case=='state' else 'ACTIVE',SingleMasterConfiguration={'MessageTtlSeconds':120 if case=='ttl' else config['ttl']})}
    def describe_media_storage_configuration(self,**kwargs):
        assert kwargs==dict(ChannelARN=job['arn'])
        return {'MediaStorageConfiguration':{'Status':'ENABLED' if case=='storage-enabled' else 'DISABLED',**({'StreamARN':'arn:stream'} if case=='storage-stream' else {})}}
boto=types.ModuleType('boto3');boto.Session=Session;core=types.ModuleType('botocore');cfg=types.ModuleType('botocore.config');cfg.Config=Config
sys.modules.update({'boto3':boto,'botocore':core,'botocore.config':cfg})
def output(arguments,**kwargs):
    assert arguments==['terraform','output','-json','webrtc_signaling'] and kwargs['timeout']==30
    return json.dumps({**job,'arn':'arn:aws:kinesisvideo:us-west-2:000000000000:channel/other/123'} if case=='boundary' else job)
subprocess.check_output=output
count=0
for script,scenarios in [('PREFLIGHT.py',['ok','account','role']),('CHECK.py',['ok','account','role','stack-role','stack-state','stack-output','name','type','state','ttl','boundary','storage-enabled','storage-stream'])]:
    for case in scenarios:
        sys.argv=[script];error=None;captured=io.StringIO()
        try:
            with contextlib.redirect_stdout(captured):runpy.run_path(str(root/script),run_name='__main__')
        except Exception as exc:error=exc
        assert (error is None)==(case=='ok'),(script,case,error)
        if error is None:assert json.loads(captured.getvalue())['ice_credentials_requested'] is False
        count+=1
print(str(count)+' generated metadata cases passed; no ICE/signaling/media requests')
`);
const run=spawnSync(process.env.PYTHON_PATH||'python',[join(work,'harness.py')],{encoding:'utf8'});
process.stdout.write(run.stdout||'');process.stderr.write(run.stderr||'');
if(run.status!==0)throw new Error('Signaling metadata checks failed: '+work);
console.log(work);
