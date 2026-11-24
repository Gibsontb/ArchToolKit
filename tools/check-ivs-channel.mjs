/** Generated IVS metadata scripts with local SDK doubles; no streaming or secret retrieval. */
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_IVS_SERVICE as blueprint} from '../src/cloud/aws-ivs-service.ts';
import {WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'ivs-channel-test-'));
const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',name:'approved-video',account:'123456789012',playback_key:'arn:aws:ivs:us-east-1:123456789012:playback-key/AbCdEf-123456',distribution:true});
if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const name of ['PREFLIGHT.py','CHECK.py','CHANNEL-CONFIG.json'])writeFileSync(join(work,name),result.files[name]);
writeFileSync(join(work,'harness.py'),String.raw`import contextlib, io, json, pathlib, runpy, subprocess, sys, types
root=pathlib.Path(__file__).resolve().parent;config=json.loads((root/'CHANNEL-CONFIG.json').read_text())
job={'arn':'arn:aws:ivs:us-east-1:123456789012:channel/AbCdEf123456','ingest_endpoint':'example.global-contribute.live-video.net','playback_url':'https://example.playback.live-video.net/channel.m3u8'}
class Config:
    def __init__(self,**kwargs): assert kwargs['retries']['total_max_attempts']==1
class Session:
    def __init__(self,**kwargs): assert kwargs==dict(region_name=config['region'])
    def client(self,name,**kwargs): assert name in ['sts','ivs','s3'];return self
    def get_caller_identity(self):return {'Account':'other' if case=='account' else config['account']}
    def get_playback_key_pair(self,**kwargs):
        assert kwargs==dict(arn=config['key'])
        return {'keyPair':{'arn':'other' if case=='key' else config['key'],'fingerprint':'' if case=='fingerprint' else 'fingerprint'}}
    def get_channel(self,**kwargs):
        assert kwargs==dict(arn=job['arn'])
        channel=dict(arn=job['arn'],name=config['name'],type=config['type'],latencyMode=config['latency'],authorized=True,recordingConfigurationArn=config['recordingArn'],insecureIngest=False,multitrackInputConfiguration={'enabled':False},ingestEndpoint=job['ingest_endpoint'],playbackUrl=job['playback_url'])
        changes={'unauthorized':('authorized',False),'insecure':('insecureIngest',True),'recording':('recordingConfigurationArn','other'),'type':('type','BASIC'),'latency':('latencyMode','NORMAL'),'endpoint':('ingestEndpoint','other'),'multitrack':('multitrackInputConfiguration',{'enabled':True}),'name':('name','other'),'arn':('arn','other')}
        if case in changes: key,value=changes[case];channel[key]=value
        return {'channel':channel}
    def get_recording_configuration(self,**kwargs):
        assert kwargs==dict(arn=config['recordingArn'])
        return {'recordingConfiguration':{'arn':config['recordingArn'],'state':'FAILED' if case=='recording-state' else 'ACTIVE','destinationConfiguration':{'s3':{'bucketName':'other' if case=='recording-bucket' else config['bucket']}}}}
    def owner(self,kwargs): assert kwargs==dict(Bucket=config['bucket'],ExpectedBucketOwner=config['account'])
    def get_bucket_location(self,**kwargs):self.owner(kwargs);return {'LocationConstraint':'us-west-2' if case=='bucket-region' else None}
    def get_public_access_block(self,**kwargs):
        self.owner(kwargs);return {'PublicAccessBlockConfiguration':{key:case!='public-bucket' for key in ['BlockPublicAcls','IgnorePublicAcls','BlockPublicPolicy','RestrictPublicBuckets']}}
    def get_bucket_encryption(self,**kwargs):
        self.owner(kwargs);return {'ServerSideEncryptionConfiguration':{'Rules':[{'ApplyServerSideEncryptionByDefault':{'SSEAlgorithm':'aws:kms' if case=='bucket-kms' else 'AES256'}}]}}
boto=types.ModuleType('boto3');boto.Session=Session;core=types.ModuleType('botocore');cfg=types.ModuleType('botocore.config');cfg.Config=Config
sys.modules.update({'boto3':boto,'botocore':core,'botocore.config':cfg})
def output(arguments,**kwargs):
    assert arguments==['terraform','output','-json','ivs_channel'] and kwargs['timeout']==30
    return json.dumps(job)
subprocess.check_output=output
count=0
for script,scenarios in [('PREFLIGHT.py',['ok','account','key','fingerprint']),('CHECK.py',['ok','account','key','fingerprint','unauthorized','insecure','recording','type','latency','endpoint','multitrack','name','arn'])]:
    for case in scenarios:
        sys.argv=[script];error=None;captured=io.StringIO()
        try:
            with contextlib.redirect_stdout(captured):runpy.run_path(str(root/script),run_name='__main__')
        except Exception as exc:error=exc
        assert (error is None)==(case=='ok'),(script,case,error)
        if error is None:assert json.loads(captured.getvalue())['stream_key_retrieved'] is False
        count+=1
print(str(count)+' generated metadata cases passed; no streaming/key retrieval')
config.update(recordingArn='arn:aws:ivs:us-east-1:123456789012:recording-configuration/AbCdEf123456',bucket='approved-recordings')
(root/'CHANNEL-CONFIG.json').write_text(json.dumps(config))
count=0
for script in ['PREFLIGHT.py','CHECK.py']:
    for case in ['recording-ok','recording-state','recording-bucket','bucket-region','public-bucket','bucket-kms']:
        sys.argv=[script];error=None
        try:
            with contextlib.redirect_stdout(io.StringIO()):runpy.run_path(str(root/script),run_name='__main__')
        except Exception as exc:error=exc
        assert (error is None)==(case=='recording-ok'),(script,case,error)
        count+=1
print(str(count)+' existing-recording metadata cases passed; no S3 object operations')
`);
const run=spawnSync(process.env.PYTHON_PATH||'python',[join(work,'harness.py')],{encoding:'utf8'});
process.stdout.write(run.stdout||'');process.stderr.write(run.stderr||'');
if(run.status!==0)throw new Error('IVS metadata checks failed: '+work);
console.log(work);
