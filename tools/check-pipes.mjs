/** Execute exported Pipes inspections against SDK doubles. Never read SQS messages. */
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_PIPES_SERVICE as blueprint} from '../src/cloud/aws-pipes-service.ts';
import {WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'pipes-test-'));
const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',name:'application',source:'arn:aws:sqs:us-east-1:123456789012:source',dlq:'arn:aws:sqs:us-east-1:123456789012:failed',target:'arn:aws:lambda:us-east-1:123456789012:function:ApprovedBatch:3',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc'});
if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const name of ['INSPECT.py','PIPE-CONFIG.json'])writeFileSync(join(work,name),result.files[name]);
writeFileSync(join(work,'harness.py'),String.raw`import contextlib, copy, io, json, pathlib, runpy, sys, types
root=pathlib.Path(__file__).resolve().parent; original=json.loads((root/'PIPE-CONFIG.json').read_text())
class Config:
    def __init__(self,retries,use_fips_endpoint): assert retries==dict(total_max_attempts=1,mode='standard') and use_fips_endpoint is True
class Session:
    def __init__(self,region_name): assert region_name==config['region']
    def client(self,name,config):
        assert name in ['sts','kms','lambda','sqs','pipes'] and isinstance(config,Config); return self
    def get_caller_identity(self): return {'Account':'000000000000' if scenario=='account' else config['account']}
    def describe_key(self,**kwargs):
        assert kwargs['KeyId'] in [config['kms'],config['queueKey'],'alias/queue']
        arn=config['queueKey'] if kwargs['KeyId']=='alias/queue' else kwargs['KeyId']
        value=dict(Arn=arn,KeyState='Enabled',KeySpec='SYMMETRIC_DEFAULT',KeyUsage='ENCRYPT_DECRYPT',KeyManager='CUSTOMER')
        for case,key,changed in [('key-arn','Arn','other'),('key-disabled','KeyState','Disabled'),('key-spec','KeySpec','RSA_2048'),('key-usage','KeyUsage','SIGN_VERIFY'),('service-key','KeyManager','AWS')]:
            if scenario==case: value[key]=changed
        if scenario=='queue-key' and kwargs['KeyId']=='alias/queue': value['Arn']='other'
        return {'KeyMetadata':value}
    def get_function_configuration(self,**kwargs):
        assert kwargs==dict(FunctionName=config['functionName'],Qualifier=config['version'])
        value=dict(FunctionArn=config['target'],Version=config['version'],State='Active',LastUpdateStatus='Successful',Timeout=30,Environment={'Variables':{'PRIVATE':'SYNTHETIC-DO-NOT-PRINT'}})
        for case,key,changed in [('function-arn','FunctionArn','other'),('function-version','Version','$LATEST'),('function-state','State','Inactive'),('function-update','LastUpdateStatus','InProgress'),('function-timeout','Timeout',61)]:
            if scenario==case: value[key]=changed
        return value
    def get_queue_url(self,**kwargs):
        assert kwargs['QueueName'] in [config['queueName'],config['dlqName']] and kwargs['QueueOwnerAWSAccountId']==config['account']
        return {'QueueUrl':'https://sqs.us-east-1.amazonaws.com/'+config['account']+'/'+kwargs['QueueName']}
    def get_queue_attributes(self,**kwargs):
        assert set(kwargs['AttributeNames'])==set(['QueueArn','FifoQueue','VisibilityTimeout','MessageRetentionPeriod','RedrivePolicy','SqsManagedSseEnabled','KmsMasterKeyId'])
        dead=kwargs['QueueUrl'].endswith('/'+config['dlqName'])
        value=dict(QueueArn=config['dlq'] if dead else config['source'],FifoQueue='true' if config['fifo'] else 'false',VisibilityTimeout='180',MessageRetentionPeriod='1209600' if dead else '345600',RedrivePolicy=json.dumps({'deadLetterTargetArn':config['dlq'],'maxReceiveCount':5}) if not dead else '{}')
        if config['encryption']=='KMS': value['KmsMasterKeyId']='alias/queue'
        else: value['SqsManagedSseEnabled']='true'
        for case,key,changed in [('queue-arn','QueueArn','other'),('queue-type','FifoQueue','true' if not config['fifo'] else 'false'),('queue-unencrypted','SqsManagedSseEnabled','false'),('visibility','VisibilityTimeout','179'),('redrive-absent','RedrivePolicy','{}'),('redrive-wrong','RedrivePolicy',json.dumps({'deadLetterTargetArn':'other','maxReceiveCount':5})),('redrive-count','RedrivePolicy',json.dumps({'deadLetterTargetArn':config['dlq'],'maxReceiveCount':0})),('redrive-json','RedrivePolicy','bad'),('source-retention','MessageRetentionPeriod','0')]:
            if scenario==case and not dead: value[key]=changed
        if scenario=='dlq-retention' and dead: value['MessageRetentionPeriod']='60'
        if scenario=='dlq-arn' and dead: value['QueueArn']='other'
        if scenario=='sse-with-kms' and not dead: value['KmsMasterKeyId']='alias/queue'
        return {'Attributes':value}
    def describe_pipe(self,**kwargs):
        assert kwargs==dict(Name=config['name']) and scenario!='preflight'
        value=dict(Arn=config['pipeArn'],Source=config['source'],Target=config['target'],RoleArn=config['roleArn'],KmsKeyIdentifier=config['kms'],DesiredState='RUNNING' if config['enabled'] else 'STOPPED',CurrentState='RUNNING' if config['enabled'] else 'STOPPED',SourceParameters={'SqsQueueParameters':{'BatchSize':config['batch'],'MaximumBatchingWindowInSeconds':config['window']}},TargetParameters={'LambdaFunctionParameters':{'InvocationType':'REQUEST_RESPONSE'}},LogConfiguration={'Level':'OFF'})
        for case,key,changed in [('pipe-arn','Arn','other'),('pipe-source','Source','other'),('pipe-target','Target','other'),('pipe-role','RoleArn','other'),('pipe-key','KmsKeyIdentifier','other'),('desired-state','DesiredState','RUNNING'),('current-state','CurrentState','STARTING'),('enrichment','Enrichment','other')]:
            if scenario==case: value[key]=changed
        if scenario=='batch': value['SourceParameters']['SqsQueueParameters']['BatchSize']=10
        if scenario=='window': value['SourceParameters']['SqsQueueParameters']['MaximumBatchingWindowInSeconds']=1
        if scenario=='filter': value['SourceParameters']['FilterCriteria']={'Filters':[{'Pattern':'{}'}]}
        if scenario=='alternate-source': value['SourceParameters']['KinesisStreamParameters']={}
        if scenario=='async': value['TargetParameters']['LambdaFunctionParameters']['InvocationType']='FIRE_AND_FORGET'
        if scenario=='transform': value['TargetParameters']['InputTemplate']='{"private":"SYNTHETIC-DO-NOT-PRINT"}'
        if scenario=='empty-defaults': value['SourceParameters']['FilterCriteria']={'Filters':[]}; value['TargetParameters']['InputTemplate']=''
        if scenario=='log-level': value['LogConfiguration']['Level']='ERROR'
        if scenario=='log-data': value['LogConfiguration']['IncludeExecutionData']=['ALL']
        if scenario=='log-destination': value['LogConfiguration']['S3LogDestination']={'BucketName':'other'}
        return value
sdk=types.ModuleType('boto3'); sdk.Session=Session; sys.modules['boto3']=sdk
botocore=types.ModuleType('botocore'); botocore.__path__=[]; sys.modules['botocore']=botocore
module=types.ModuleType('botocore.config'); module.Config=Config; sys.modules['botocore.config']=module
scenarios=['preflight','check','empty-defaults','account','key-arn','key-disabled','key-spec','key-usage','service-key','function-arn','function-version','function-state','function-update','function-timeout','queue-arn','queue-type','queue-unencrypted','visibility','redrive-absent','redrive-wrong','redrive-count','redrive-json','source-retention','dlq-retention','dlq-arn','sse-with-kms','pipe-arn','pipe-source','pipe-target','pipe-role','pipe-key','desired-state','current-state','enrichment','batch','window','filter','alternate-source','async','transform','log-level','log-data','log-destination','kms-valid','queue-key','fifo-valid','running-valid']
for scenario in scenarios:
    config=copy.deepcopy(original)
    if scenario in ['kms-valid','queue-key']: config['encryption']='KMS'; config['queueKey']=config['kms'][:-1]+'d'
    if scenario=='fifo-valid':
        config['fifo']=True
        for key in ['source','queueName','dlq','dlqName']: config[key]+='.fifo'
    if scenario=='running-valid': config['enabled']=True
    (root/'PIPE-CONFIG.json').write_text(json.dumps(config))
    failure=None; sys.argv=['INSPECT.py']+([] if scenario=='preflight' else ['--check'])
    with contextlib.redirect_stdout(io.StringIO()) as output:
        try: runpy.run_path(str(root/'INSPECT.py'),run_name='__main__')
        except Exception as error: failure=error
    success=scenario in ['preflight','check','empty-defaults','kms-valid','fifo-valid','running-valid']
    assert bool(failure)!=success,(scenario,failure)
    assert 'SYNTHETIC-DO-NOT-PRINT' not in output.getvalue()
    if success:
        report=json.loads(output.getvalue()); assert report['pipe_checked']==(scenario!='preflight') and not report['messages_read_or_deleted'] and not report['target_invoked']
print('Passed',len(scenarios),'generated Pipes metadata cases; no AWS, queue messages, Lambda invocation or pipe start.')
`);
const check=spawnSync(process.env.PYTHON_PATH||'python',[join(work,'harness.py')],{cwd:work,encoding:'utf8',timeout:60000,windowsHide:true});
process.stdout.write(check.stdout||'');process.stderr.write(check.stderr||'');if(check.error)throw check.error;
console.log(work);process.exitCode=check.status??1;
