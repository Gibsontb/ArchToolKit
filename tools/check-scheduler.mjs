/** Run generated Scheduler metadata checks with SDK doubles only. */
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_SCHEDULER_SERVICE as blueprint} from '../src/cloud/aws-scheduler-service.ts';
import {WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'scheduler-test-'));
const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',name:'nightly',target:'arn:aws:lambda:us-east-1:123456789012:function:ApprovedJob:3',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc'});
if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const name of ['INSPECT.py','SCHEDULE-CONFIG.json'])writeFileSync(join(work,name),result.files[name]);
writeFileSync(join(work,'harness.py'),String.raw`import contextlib, io, json, pathlib, runpy, sys, types
root=pathlib.Path(__file__).resolve().parent; config=json.loads((root/'SCHEDULE-CONFIG.json').read_text())
class Config:
    def __init__(self,retries,use_fips_endpoint): assert retries==dict(total_max_attempts=1,mode='standard') and use_fips_endpoint is True
class Session:
    def __init__(self,region_name): assert region_name==config['region']
    def client(self,name,config):
        assert name in ['sts','kms','lambda','scheduler','sqs'] and isinstance(config,Config); return self
    def get_caller_identity(self): return {'Account':'000000000000' if scenario=='account' else config['account']}
    def describe_key(self,**kwargs):
        assert kwargs==dict(KeyId=config['kms'])
        value=dict(Arn=config['kms'],KeyState='Enabled',KeySpec='SYMMETRIC_DEFAULT',KeyUsage='ENCRYPT_DECRYPT',KeyManager='CUSTOMER')
        for case,key,changed in [('key-arn','Arn','other'),('disabled','KeyState','Disabled'),('asymmetric','KeySpec','RSA_2048'),('service-key','KeyManager','AWS')]:
            if scenario==case: value[key]=changed
        return {'KeyMetadata':value}
    def get_function_configuration(self,**kwargs):
        assert kwargs==dict(FunctionName=config['functionName'],Qualifier=config['version'])
        value=dict(FunctionArn=config['target'],Version=config['version'],State='Active',LastUpdateStatus='Successful',Environment={'Variables':{'PRIVATE':'SYNTHETIC-DO-NOT-PRINT'}})
        for case,key,changed in [('function-arn','FunctionArn','other'),('function-version','Version','$LATEST'),('function-state','State','Inactive'),('function-update','LastUpdateStatus','InProgress')]:
            if scenario==case: value[key]=changed
        return value
    def get_schedule_group(self,**kwargs):
        assert kwargs==dict(Name=config['group']); assert scenario!='preflight'
        return dict(Arn='other' if scenario=='group-arn' else config['groupArn'],State='DELETING' if scenario=='group-state' else 'ACTIVE')
    def get_schedule(self,**kwargs):
        assert kwargs==dict(Name=config['name'],GroupName=config['group'])
        target=dict(Arn=config['target'],RoleArn=config['roleArn'],Input=config['input'],DeadLetterConfig={'Arn':config['queueArn']},RetryPolicy={'MaximumRetryAttempts':config['attempts'],'MaximumEventAgeInSeconds':config['age']})
        value=dict(Arn=config['scheduleArn'],State='DISABLED',KmsKeyArn=config['kms'],ScheduleExpression=config['expression'],ScheduleExpressionTimezone=config['timezone'],FlexibleTimeWindow={'Mode':'OFF'},Target=target)
        for case,key,changed in [('schedule-arn','Arn','other'),('enabled','State','ENABLED'),('schedule-key','KmsKeyArn','other'),('expression','ScheduleExpression','rate(1 minute)'),('timezone','ScheduleExpressionTimezone','America/New_York'),('window','FlexibleTimeWindow',{'Mode':'FLEXIBLE'}),('start','StartDate','other'),('end','EndDate','other'),('delete-after','ActionAfterCompletion','DELETE')]:
            if scenario==case: value[key]=changed
        for case,key,changed in [('target','Arn','other'),('role','RoleArn','other'),('input','Input','{"private":"SYNTHETIC-DO-NOT-PRINT"}'),('bad-json','Input','bad'),('dlq','DeadLetterConfig',{'Arn':'other'}),('retries','RetryPolicy',{'MaximumRetryAttempts':0})]:
            if scenario==case: target[key]=changed
        return value
    def get_queue_url(self,**kwargs):
        assert kwargs==dict(QueueName=config['queue'],QueueOwnerAWSAccountId=config['account']); return {'QueueUrl':'https://sqs.us-east-1.amazonaws.com/123456789012/'+config['queue']}
    def get_queue_attributes(self,**kwargs):
        assert set(kwargs['AttributeNames'])==set(['QueueArn','SqsManagedSseEnabled','FifoQueue','MessageRetentionPeriod'])
        value=dict(QueueArn=config['queueArn'],SqsManagedSseEnabled='true',FifoQueue='false',MessageRetentionPeriod='1209600')
        for case,key,changed in [('queue-arn','QueueArn','other'),('queue-encryption','SqsManagedSseEnabled','false'),('fifo','FifoQueue','true'),('retention','MessageRetentionPeriod','60')]:
            if scenario==case: value[key]=changed
        return {'Attributes':value}
sdk=types.ModuleType('boto3'); sdk.Session=Session; sys.modules['boto3']=sdk
botocore=types.ModuleType('botocore'); botocore.__path__=[]; sys.modules['botocore']=botocore
module=types.ModuleType('botocore.config'); module.Config=Config; sys.modules['botocore.config']=module
scenarios=['preflight','check','account','key-arn','disabled','asymmetric','service-key','function-arn','function-version','function-state','function-update','group-arn','group-state','schedule-arn','enabled','schedule-key','expression','timezone','window','start','end','delete-after','target','role','input','bad-json','dlq','retries','queue-arn','queue-encryption','fifo','retention']
for scenario in scenarios:
    failure=None; sys.argv=['INSPECT.py']+([] if scenario=='preflight' else ['--check'])
    with contextlib.redirect_stdout(io.StringIO()) as output:
        try: runpy.run_path(str(root/'INSPECT.py'),run_name='__main__')
        except Exception as error: failure=error
    assert bool(failure)==(scenario not in ['preflight','check']),(scenario,failure)
    assert 'SYNTHETIC-DO-NOT-PRINT' not in output.getvalue()
    if scenario in ['preflight','check']:
        report=json.loads(output.getvalue()); assert report['schedule_checked']==(scenario=='check') and not report['target_invoked'] and not report['messages_read']
print('Passed',len(scenarios),'generated Scheduler metadata cases; no AWS, invocation or message operations.')
`);
const check=spawnSync(process.env.PYTHON_PATH||'python',[join(work,'harness.py')],{cwd:work,encoding:'utf8',timeout:60000,windowsHide:true});
process.stdout.write(check.stdout||'');process.stderr.write(check.stderr||'');if(check.error)throw check.error;
console.log(work);process.exitCode=check.status??1;
