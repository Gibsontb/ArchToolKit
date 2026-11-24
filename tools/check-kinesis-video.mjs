/** Generated metadata checks against local SDK doubles only; no media operations. */
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_KINESIS_VIDEO_SERVICE as blueprint} from '../src/cloud/aws-kinesis-video-service.ts';
import {WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'kinesis-video-test-'));
const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',name:'approved-video',account:'123456789012',device:'camera-lab',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc',producer:'arn:aws:iam::123456789012:role/devices/VideoProducer',consumer:'arn:aws:iam::123456789012:role/apps/VideoConsumer',approved:true});
if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const name of ['PREFLIGHT.py','CHECK.py','VIDEO-CONFIG.json'])writeFileSync(join(work,name),result.files[name]);
writeFileSync(join(work,'harness.py'),String.raw`import contextlib, io, json, pathlib, runpy, subprocess, sys, types
root=pathlib.Path(__file__).resolve().parent;config=json.loads((root/'VIDEO-CONFIG.json').read_text())
arn='arn:aws:kinesisvideo:us-east-1:123456789012:stream/approved-video/1234567890123'
class Config:
    def __init__(self,**kwargs): assert kwargs['retries']['total_max_attempts']==1
class Session:
    def __init__(self,**kwargs): assert kwargs==dict(region_name=config['region'])
    def client(self,name,**kwargs): assert name in ['sts','kms','iam','kinesisvideo'];return self
    def get_caller_identity(self):return {'Account':'other' if case=='account' else config['account']}
    def describe_key(self,**kwargs):
        assert kwargs==dict(KeyId=config['kms'])
        return {'KeyMetadata':{'Arn':'other' if case=='key-arn' else config['kms'],'KeyState':'Disabled' if case=='key-state' else 'Enabled','KeyManager':'AWS' if case=='key-manager' else 'CUSTOMER','KeySpec':'RSA_2048' if case=='asymmetric' else 'SYMMETRIC_DEFAULT','KeyUsage':'ENCRYPT_DECRYPT'}}
    def get_role(self,**kwargs):
        matched=[role for role in [config['producer'],config['consumer']] if role.rsplit('/',1)[1]==kwargs['RoleName']]
        assert len(matched)==1
        return {'Role':{'Arn':'other' if case=='role' else matched[0]}}
    def describe_stream(self,**kwargs):
        assert kwargs==dict(StreamARN=arn)
        stream=dict(StreamARN=arn,StreamName=config['name'],DeviceName=config['device'],DataRetentionInHours=config['retention'],MediaType='video/x-matroska',KmsKeyId=config['kms'],Status='ACTIVE')
        changes={'retention':('DataRetentionInHours',0),'stream-key':('KmsKeyId','other'),'state':('Status','CREATING'),'device':('DeviceName','other'),'media':('MediaType','other'),'name':('StreamName','other')}
        if case in changes:key,value=changes[case];stream[key]=value
        return {'StreamInfo':stream}
boto=types.ModuleType('boto3');boto.Session=Session;core=types.ModuleType('botocore');cfg=types.ModuleType('botocore.config');cfg.Config=Config
sys.modules.update({'boto3':boto,'botocore':core,'botocore.config':cfg})
def output(arguments,**kwargs):
    assert arguments==['terraform','output','-json','video_stream'] and kwargs['timeout']==30
    return json.dumps('arn:aws:kinesisvideo:us-west-2:000000000000:stream/other/123' if case=='boundary' else arn)
subprocess.check_output=output
count=0;base=['ok','account','key-arn','key-state','key-manager','asymmetric','role']
for script,scenarios in [('PREFLIGHT.py',base),('CHECK.py',base+['retention','stream-key','state','device','media','name','boundary'])]:
    for case in scenarios:
        sys.argv=[script];error=None;captured=io.StringIO()
        try:
            with contextlib.redirect_stdout(captured):runpy.run_path(str(root/script),run_name='__main__')
        except Exception as exc:error=exc
        assert (error is None)==(case=='ok'),(script,case,error)
        if error is None:assert json.loads(captured.getvalue())['media_uploaded_read_or_played'] is False
        count+=1
print(str(count)+' generated metadata cases passed; no media/endpoint/token operations')
`);
const run=spawnSync(process.env.PYTHON_PATH||'python',[join(work,'harness.py')],{encoding:'utf8'});
process.stdout.write(run.stdout||'');process.stderr.write(run.stderr||'');
if(run.status!==0)throw new Error('Kinesis Video checks failed: '+work);
console.log(work);
