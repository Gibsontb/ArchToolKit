/** Generated storage-association operator with local SDK doubles; no live changes or media. */
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {awsWebrtcStorageFiles} from '../src/cloud/aws-webrtc-storage-files.ts';
import {WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'webrtc-storage-test-'));
const files=awsWebrtcStorageFiles({region:'us-east-1',account:'123456789012',channel:'arn:aws:kinesisvideo:us-east-1:123456789012:channel/approved-peer/1234567890123',stream:'arn:aws:kinesisvideo:us-east-1:123456789012:stream/approved-video/1234567890123',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc',retention:24});
for(const[name,body]of Object.entries(files))writeFileSync(join(work,name),body);
writeFileSync(join(work,'harness.py'),String.raw`import contextlib, io, json, pathlib, runpy, sys, types
root=pathlib.Path(__file__).resolve().parent;original=json.loads((root/'STORAGE-CONFIG.json').read_text())
class Config:
    def __init__(self,**kwargs): assert kwargs['retries']['total_max_attempts']==1
class Session:
    def __init__(self,**kwargs): assert kwargs==dict(region_name=config['region'])
    def client(self,name,**kwargs): assert name in ['sts','kms','kinesisvideo'];calls.append(name);return self
    def get_caller_identity(self):return {'Account':'other' if case=='account' else config['account']}
    def describe_key(self,**kwargs):
        assert kwargs==dict(KeyId=config['kms'])
        return {'KeyMetadata':{'Arn':config['kms'],'KeyState':'Disabled' if case=='key-state' else 'Enabled','KeyManager':'CUSTOMER','KeySpec':'SYMMETRIC_DEFAULT','KeyUsage':'ENCRYPT_DECRYPT'}}
    def describe_signaling_channel(self,**kwargs):
        assert kwargs==dict(ChannelARN=config['channel'])
        return {'ChannelInfo':dict(ChannelARN=config['channel'],ChannelStatus='CREATING' if case=='channel-state' else 'ACTIVE',ChannelType='SINGLE_MASTER')}
    def describe_stream(self,**kwargs):
        assert kwargs==dict(StreamARN=config['stream'])
        return {'StreamInfo':dict(StreamARN=config['stream'],Status='ACTIVE',KmsKeyId='other' if case=='stream-key' else config['kms'],DataRetentionInHours=0 if case=='retention' else config['retention'])}
    def describe_media_storage_configuration(self,**kwargs):
        assert kwargs==dict(ChannelARN=config['channel'])
        enabled=case in ['already','conflicting-channel','inconsistent']
        return {'MediaStorageConfiguration':{'Status':'ENABLED' if enabled else 'DISABLED',**({'StreamARN':'other' if case=='conflicting-channel' else config['stream']} if enabled else {})}}
    def describe_mapped_resource_configuration(self,**kwargs):
        assert kwargs==dict(StreamARN=config['stream'],MaxResults=1)
        return {'MappedResourceConfigurationList':[{'ARN':'other' if case=='conflicting-stream' else config['channel']}] if case in ['already','conflicting-channel','conflicting-stream'] else [],**({'NextToken':'more'} if case=='pagination' else {})}
    def update_media_storage_configuration(self,**kwargs):
        assert kwargs==dict(ChannelARN=config['channel'],MediaStorageConfiguration={'Status':'ENABLED','StreamARN':config['stream']})
        writes.append(kwargs)
        if case=='ambiguous': raise RuntimeError('SECRET-SENTINEL')
        return {}
boto=types.ModuleType('boto3');boto.Session=Session;core=types.ModuleType('botocore');cfg=types.ModuleType('botocore.config');cfg.Config=Config
sys.modules.update({'boto3':boto,'botocore':core,'botocore.config':cfg})
confirm=['--enable','--confirm-topology-change','--confirm-retained-media']
cases=[('inspect',[],True),('enable',confirm,True),('already',confirm,True),('no-confirm',['--enable'],False),('partial-confirm',['--enable','--confirm-topology-change'],False),('ambiguous',confirm,False)]
cases += [(case,confirm,False) for case in ['account','key-state','channel-state','stream-key','retention','conflicting-channel','conflicting-stream','inconsistent','pagination','govcloud','wrong-boundary']]
for case,args,success in cases:
    config=dict(original);calls=[];writes=[];captured=io.StringIO();error=None
    if case=='govcloud':config['region']='us-gov-west-1'
    if case=='wrong-boundary':config['stream']=config['stream'].replace('123456789012:','000000000000:')
    (root/'STORAGE-CONFIG.json').write_text(json.dumps(config));sys.argv=['OPERATE.py']+args
    try:
        with contextlib.redirect_stdout(captured):runpy.run_path(str(root/'OPERATE.py'),run_name='__main__')
    except SystemExit as exc:
        if exc.code not in [0,None]:error=exc
    except Exception as exc:error=exc
    assert (error is None)==success,(case,error)
    assert len(writes)==(1 if case in ['enable','ambiguous'] else 0),(case,writes)
    assert 'SECRET-SENTINEL' not in captured.getvalue()+str(error)
    if case in ['no-confirm','partial-confirm','govcloud','wrong-boundary']:assert not calls
print(str(len(cases))+' generated operator cases passed; local SDK doubles only')
`);
const run=spawnSync(process.env.PYTHON_PATH||'python',[join(work,'harness.py')],{encoding:'utf8'});
process.stdout.write(run.stdout||'');process.stderr.write(run.stderr||'');
if(run.status!==0)throw new Error('Storage operator checks failed: '+work);
console.log(work);
