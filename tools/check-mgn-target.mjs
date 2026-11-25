/** Execute exported production-target checks against local SDK doubles, never AWS. */
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_MGN_CUTOVER_SERVICE as blueprint} from '../src/cloud/aws-mgn-cutover-service.ts';
import {WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'mgn-target-test-'));
const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',name:'production',source:'arn:aws:mgn:us-east-1:123456789012:source-server/s-0123456789abcdef0',template:'lt-0123456789abcdef0',subnet:'subnet-0123456789abcdef0',staging:'subnet-0123456789abcdef1',groups:'sg-0123456789abcdef0',staging_groups:'sg-0123456789abcdef1',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc'});
if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const name of ['CHECK-TARGET.py','DECIDE.py','CUTOVER-CONFIG.json'])writeFileSync(join(work,name),result.files[name]);
writeFileSync(join(work,'harness.py'),String.raw`import contextlib, io, json, pathlib, runpy, sys, types
root=pathlib.Path(__file__).resolve().parent
config=json.loads((root/'CUTOVER-CONFIG.json').read_text())
job_id='mgnjob-0123456789abcdef0'; instance_id='i-0123456789abcdef0'; volume_id='vol-0123456789abcdef0'
class Config:
    def __init__(self,retries,use_fips_endpoint): assert retries==dict(total_max_attempts=1,mode='standard') and use_fips_endpoint==config['fips']
class Session:
    def __init__(self,region_name): assert region_name==config['region']
    def client(self,name,config):
        assert name in ['sts','mgn','ec2'] and isinstance(config,Config); return self
    def get_caller_identity(self): return {'Account':'000000000000' if scenario=='account' else config['account']}
    def describe_jobs(self,**kwargs):
        assert kwargs==dict(filters={'jobIDs':[job_id]},maxResults=2)
        job=dict(jobID=job_id,initiatedBy='START_CUTOVER',type='LAUNCH',status='COMPLETED',participatingServers=[dict(sourceServerID=config['sourceID'],launchStatus='LAUNCHED',launchedEc2InstanceID=instance_id)])
        for case,key,value in [('job-id','jobID','other'),('test-job','initiatedBy','START_TEST'),('terminate-job','type','TERMINATE'),('pending','status','PENDING')]:
            if scenario==case: job[key]=value
        for case,key,value in [('wrong-source','sourceServerID','other'),('failed','launchStatus','FAILED'),('invalid-instance','launchedEc2InstanceID','bad')]:
            if scenario==case: job['participatingServers'][0][key]=value
        if scenario=='multi-source': job['participatingServers']*=2
        return {'items':[job],'nextToken':'page' if scenario=='job-page' else ''}
    def describe_source_servers(self,**kwargs):
        assert kwargs==dict(filters={'sourceServerIDs':[config['sourceID']]},maxResults=2)
        value=dict(arn=config['source'],sourceServerID=config['sourceID'],isArchived=False,lifeCycle={'state':'CUTTING_OVER'},launchedInstance={'ec2InstanceID':instance_id})
        if scenario=='finalized': value['lifeCycle']['state']='CUTOVER'
        if scenario=='replaced-target': value['launchedInstance']['ec2InstanceID']='other'
        if scenario=='archived': value['isArchived']=True
        return {'items':[value],'nextToken':'page' if scenario=='source-page' else ''}
    def describe_instances(self,**kwargs):
        assert kwargs==dict(InstanceIds=[instance_id])
        groups=[{'GroupId':group} for group in config['groups']]
        nic=dict(SubnetId=config['subnet'],Attachment={'DeviceIndex':0},Groups=groups)
        value=dict(InstanceId=instance_id,State={'Name':'running'},InstanceType=config['instance'],SubnetId=config['subnet'],SecurityGroups=groups,NetworkInterfaces=[nic],MetadataOptions={'State':'applied','HttpTokens':'required','HttpEndpoint':'enabled','HttpPutResponseHopLimit':2},RootDeviceName='/dev/sda1',BlockDeviceMappings=[dict(DeviceName='/dev/sda1',Ebs={'VolumeId':volume_id})])
        for case,key,changed in [('instance-id','InstanceId','other'),('instance-type','InstanceType','t2.micro'),('subnet','SubnetId','other'),('public','PublicIpAddress','192.0.2.1'),('groups','SecurityGroups',[]),('profile','IamInstanceProfile',{'Arn':'other'}),('no-devices','BlockDeviceMappings',[]),('root','RootDeviceName','other')]:
            if scenario==case: value[key]=changed
        if scenario=='stopped': value['State']['Name']='stopped'
        if scenario=='two-nics': value['NetworkInterfaces']*=2
        if scenario=='nic-public': nic['Association']={'PublicIp':'192.0.2.1'}
        if scenario=='nic-ipv6': nic['Ipv6Addresses']=[{'Ipv6Address':'2001:db8::1'}]
        if scenario=='nic-ipv6-prefix': nic['Ipv6Prefixes']=[{'Ipv6Prefix':'2001:db8::/80'}]
        if scenario=='nic-groups': nic['Groups']=[]
        if scenario=='imds': value['MetadataOptions']['HttpTokens']='optional'
        if scenario=='imds-pending': value['MetadataOptions']['State']='pending'
        if scenario=='duplicate-volume': value['BlockDeviceMappings']*=2
        return {'Reservations':[dict(OwnerId='000000000000' if scenario=='instance-owner' else config['account'],Instances=[value])],'NextToken':'page' if scenario=='instance-page' else ''}
    def describe_instance_attribute(self,**kwargs):
        assert kwargs==dict(InstanceId=instance_id,Attribute='disableApiTermination')
        return {'DisableApiTermination':{'Value':scenario!='protection'}}
    def describe_volumes(self,**kwargs):
        assert kwargs==dict(VolumeIds=[volume_id])
        value=dict(VolumeId=volume_id,State='in-use',Encrypted=True,KmsKeyId=config['kms'],Attachments=[dict(InstanceId=instance_id,State='attached')])
        for case,key,changed in [('volume-id','VolumeId','other'),('volume-state','State','available'),('unencrypted','Encrypted',False),('wrong-key','KmsKeyId','other')]:
            if scenario==case: value[key]=changed
        if scenario=='attachment': value['Attachments'][0]['InstanceId']='other'
        if scenario=='multiattach': value['Attachments']*=2
        return {'Volumes':[] if scenario=='missing-volume' else [value],'NextToken':'page' if scenario=='volume-page' else ''}
    def finalize_cutover(self,**kwargs):
        assert kwargs==dict(sourceServerID=config['sourceID']); writes.append('finalize')
        if scenario=='ambiguous-finalize': raise RuntimeError('Ambiguous local double')
        return dict(arn=config['source'],sourceServerID='other' if scenario=='receipt-source' else config['sourceID'],lifeCycle={'state':'CUTOVER'})
    def change_server_life_cycle_state(self,**kwargs):
        assert kwargs==dict(sourceServerID=config['sourceID'],lifeCycle={'state':'READY_FOR_CUTOVER'}); writes.append('revert')
        if scenario=='ambiguous-revert': raise RuntimeError('Ambiguous local double')
        return dict(arn='other' if scenario=='receipt-arn' else config['source'],sourceServerID=config['sourceID'],lifeCycle={'state':'READY_FOR_CUTOVER'})
sdk=types.ModuleType('boto3'); sdk.Session=Session; sys.modules['boto3']=sdk
botocore=types.ModuleType('botocore'); botocore.__path__=[]; sys.modules['botocore']=botocore
module=types.ModuleType('botocore.config'); module.Config=Config; sys.modules['botocore.config']=module
scenarios=['valid','invalid-job','account','job-id','test-job','terminate-job','pending','wrong-source','failed','invalid-instance','multi-source','job-page','finalized','replaced-target','archived','source-page','instance-id','instance-type','subnet','public','groups','profile','no-devices','root','stopped','two-nics','nic-public','nic-ipv6','nic-groups','imds','imds-pending','duplicate-volume','instance-owner','instance-page','protection','volume-id','volume-state','unencrypted','wrong-key','attachment','multiattach','missing-volume','volume-page']
scenarios+=['nic-ipv6-prefix']
for scenario in scenarios:
    failure=None; sys.argv=['CHECK-TARGET.py','--job','bad' if scenario=='invalid-job' else job_id]
    with contextlib.redirect_stdout(io.StringIO()) as output:
        try: runpy.run_path(str(root/'CHECK-TARGET.py'),run_name='__main__')
        except Exception as error: failure=error
    assert bool(failure)==(scenario!='valid'),(scenario,failure)
    if scenario=='valid':
        report=json.loads(output.getvalue()); assert report['target_metadata_checked'] and report['volume_count']==1 and not report['application_acceptance_verified'] and not report['cutover_finalized']
print('Passed',len(scenarios),'generated MGN target cases; no AWS or instance/disk/application access.')
finalize=['--finalize','--confirm-application-acceptance','--confirm-recovery-backup','--confirm-rollback-window-closed','--confirm-discard-replication']
revert=['--revert-lifecycle','--confirm-writers-frozen','--confirm-data-reconciled','--confirm-traffic-controlled']
decisions=[('inspect-decision',[],True,[]),('finalize-valid',finalize,True,['finalize']),('revert-valid',revert,True,['revert']),('ambiguous-finalize',finalize,False,['finalize']),('ambiguous-revert',revert,False,['revert']),('receipt-source',finalize,False,['finalize']),('receipt-arn',revert,False,['revert'])]
for flags in [finalize,revert]:
    for flag in flags[1:]: decisions.append(('missing-'+flag,[value for value in flags if value!=flag],False,[]))
    for blocked in ['finalized','replaced-target','wrong-key','failed','multi-source','account']: decisions.append((blocked,flags,False,[]))
for scenario,flags,success,expected_writes in decisions:
    writes=[]; failure=None; sys.argv=['DECIDE.py','--job',job_id]+flags
    with contextlib.redirect_stdout(io.StringIO()) as output:
        try: runpy.run_path(str(root/'DECIDE.py'),run_name='__main__')
        except SystemExit as error:
            if error.code not in [None,0]: failure=error
        except Exception as error: failure=error
    assert bool(failure)!=success,(scenario,failure)
    assert writes==expected_writes,(scenario,writes)
    if scenario=='inspect-decision': assert json.loads(output.getvalue())['cutover_finalized'] is False
    if scenario in ['finalize-valid','revert-valid']:
        report=json.loads(output.getvalue()); assert report['request_accepted'] and not report['traffic_changed'] and not report['reverse_data_copy_performed'] and not report['source_decommissioned']
print('Passed',len(decisions),'generated explicit decision cases; SDK doubles only, no actual finalization/revert or data operations.')
`);
const check=spawnSync(process.env.PYTHON_PATH||'python',[join(work,'harness.py')],{cwd:work,encoding:'utf8',timeout:60000,windowsHide:true});
process.stdout.write(check.stdout||'');process.stderr.write(check.stderr||'');if(check.error)throw check.error;
console.log(work);process.exitCode=check.status??1;
