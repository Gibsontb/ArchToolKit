/** Execute actual DRS operator script against local SDK doubles, never AWS. */
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_DRS_SERVICE as blueprint} from '../src/cloud/aws-drs-service.ts';
import {WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'drs-test-'));
const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',name:'recovery',source:'arn:aws:drs:us-east-1:123456789012:source-server/s-0123456789abcdef0',snapshot:'pit-0123456789abcdef0',template:'lt-0123456789abcdef0',subnet:'subnet-0123456789abcdef0',staging:'subnet-0123456789abcdef1',groups:'sg-0123456789abcdef0',staging_groups:'sg-0123456789abcdef1',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc'});
if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const name of ['OPERATE.py','RECOVERY-CONFIG.json'])writeFileSync(join(work,name),result.files[name]);
writeFileSync(join(work,'harness.py'),String.raw`import contextlib, copy, datetime, io, json, pathlib, runpy, sys, types
root=pathlib.Path(__file__).resolve().parent; config=json.loads((root/'RECOVERY-CONFIG.json').read_text())
job_id='drsjob-0123456789abcdef0'; ebs_id='snap-0123456789abcdef0'
timestamp=(datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(minutes=30)).isoformat(timespec='milliseconds').replace('+00:00','Z')
base={
 'source':dict(arn=config['source'],sourceServerID=config['sourceID'],replicationDirection='FAILOVER',stagingArea={'status':'NOT_EXTENDED','stagingAccountID':config['account']},lastLaunchResult='NOT_STARTED',dataReplicationInfo={'dataReplicationState':'DISCONNECTED'}),
 'replication':dict(sourceServerID=config['sourceID'],stagingAreaSubnetId=config['staging'],replicationServersSecurityGroupsIDs=config['stagingGroups'],associateDefaultSecurityGroup=False,createPublicIP=False,dataPlaneRouting='PRIVATE_IP',ebsEncryption='CUSTOM',ebsEncryptionKeyArn=config['kms'],internetProtocol='IPV4'),
 'launch':dict(sourceServerID=config['sourceID'],ec2LaunchTemplateID=config['template'],launchDisposition='STOPPED',copyPrivateIp=False,copyTags=False,postLaunchEnabled=False,targetInstanceTypeRightSizingMethod='NONE',recoveryMode='OPTIMAL'),
 'template':dict(InstanceType=config['instance'],DisableApiTermination=True,NetworkInterfaces=[dict(DeviceIndex=0,SubnetId=config['subnet'],Groups=config['groups'],AssociatePublicIpAddress=False)],MetadataOptions={'HttpTokens':'required','HttpEndpoint':'enabled','HttpPutResponseHopLimit':2},BlockDeviceMappings=[{'DeviceName':'/dev/sda1','Ebs':{'Encrypted':True,'KmsKeyId':config['kms']}}],UserData='SYNTHETIC-DO-NOT-PRINT'),
 'snapshot':dict(snapshotID=config['snapshot'],sourceServerID=config['sourceID'],expectedTimestamp=timestamp,timestamp=timestamp,ebsSnapshots=[ebs_id]),
 'ebs':dict(SnapshotId=ebs_id,OwnerId=config['account'],State='completed',Encrypted=True,KmsKeyId=config['kms']),
 'subnets':[dict(SubnetId=value,VpcId='vpc-0123456789abcdef0',OwnerId=config['account'],MapPublicIpOnLaunch=False,AvailableIpAddressCount=10) for value in sorted(set([config['subnet'],config['staging']]))],
 'key':dict(Arn=config['kms'],KeyState='Enabled',KeySpec='SYMMETRIC_DEFAULT',KeyUsage='ENCRYPT_DECRYPT',KeyManager='CUSTOMER'),
 'recovery':dict(recoveryInstanceID='i-0123456789abcdef0',ec2InstanceID='i-0123456789abcdef0',sourceServerID=config['sourceID'],jobID=job_id,isDrill=True,ec2InstanceState='STOPPED',pointInTimeSnapshotDateTime=timestamp),
 'instance':dict(InstanceId='i-0123456789abcdef0',State={'Name':'stopped'},InstanceType=config['instance'],SubnetId=config['subnet'],SecurityGroups=[{'GroupId':value} for value in config['groups']],NetworkInterfaces=[dict(SubnetId=config['subnet'],Groups=[{'GroupId':value} for value in config['groups']],Attachment={'DeviceIndex':0})],MetadataOptions={'State':'applied','HttpTokens':'required','HttpEndpoint':'enabled','HttpPutResponseHopLimit':2},RootDeviceName='/dev/sda1',BlockDeviceMappings=[dict(DeviceName='/dev/sda1',Ebs={'VolumeId':'vol-0123456789abcdef0'})]),
 'volume':dict(VolumeId='vol-0123456789abcdef0',State='in-use',Encrypted=True,KmsKeyId=config['kms'],Attachments=[dict(InstanceId='i-0123456789abcdef0',State='attached')]),
}
class Config:
    def __init__(self,retries,use_fips_endpoint): assert retries==dict(total_max_attempts=1,mode='standard') and use_fips_endpoint is True
class Session:
    def __init__(self,region_name): assert region_name==config['region']
    def client(self,name,config):
        assert name in ['sts','drs','ec2','kms'] and isinstance(config,Config); return self
    def get_caller_identity(self): return {'Account':'000000000000' if scenario=='account' else config['account']}
    def describe_source_servers(self,**kwargs): assert kwargs==dict(filters={'sourceServerIDs':[config['sourceID']]},maxResults=2); return {'items':[data['source']],'nextToken':'page' if scenario=='source-page' else ''}
    def get_replication_configuration(self,**kwargs): assert kwargs==dict(sourceServerID=config['sourceID']); return data['replication']
    def get_launch_configuration(self,**kwargs): assert kwargs==dict(sourceServerID=config['sourceID']); return data['launch']
    def describe_launch_templates(self,**kwargs): assert kwargs==dict(LaunchTemplateIds=[config['template']]); return {'LaunchTemplates':[dict(LaunchTemplateId=config['template'],DefaultVersionNumber=2 if scenario=='version' else config['version'])]}
    def describe_launch_template_versions(self,**kwargs): assert kwargs==dict(LaunchTemplateId=config['template'],Versions=[str(config['version'])]); return {'LaunchTemplateVersions':[dict(VersionNumber=config['version'],LaunchTemplateData=data['template'])]}
    def describe_subnets(self,**kwargs): assert kwargs==dict(SubnetIds=sorted(set([config['subnet'],config['staging']]))); return {'Subnets':data['subnets']}
    def describe_security_groups(self,**kwargs):
        assert kwargs==dict(GroupIds=sorted(set(config['groups']+config['stagingGroups'])))
        return {'SecurityGroups':[dict(GroupId=value,OwnerId='other' if scenario=='group-owner' else config['account'],VpcId='other' if scenario=='group-vpc' else 'vpc-0123456789abcdef0') for value in kwargs['GroupIds']]}
    def describe_key(self,**kwargs): assert kwargs==dict(KeyId=config['kms']); return {'KeyMetadata':data['key']}
    def get_ebs_encryption_by_default(self): return {'EbsEncryptionByDefault':scenario!='default-encryption'}
    def get_ebs_default_kms_key_id(self): return {'KmsKeyId':'other' if scenario=='default-key' else config['kms']}
    def describe_recovery_snapshots(self,**kwargs):
        assert {key:value for key,value in kwargs.items() if key!='nextToken'}==dict(sourceServerID=config['sourceID'],order='DESC',maxResults=100)
        if scenario in ['snapshot-page','snapshot-repeat'] and not kwargs.get('nextToken'): return {'items':[],'nextToken':'one'}
        return {'items':[data['snapshot']]* (2 if scenario=='snapshot-duplicate' else 1),'nextToken':'one' if scenario=='snapshot-repeat' else ''}
    def describe_snapshots(self,**kwargs): assert kwargs==dict(SnapshotIds=[ebs_id],OwnerIds=[config['account']]); return {'Snapshots':[data['ebs']]}
    def job(self):
        value=dict(jobID=job_id,type='LAUNCH',initiatedBy='START_DRILL' if drill else 'START_RECOVERY',status='PENDING',participatingServers=[dict(sourceServerID=config['sourceID'],launchStatus='PENDING')])
        if scenario=='receipt-id': value['jobID']='other'
        if scenario in ['receipt-source','job-source']: value['participatingServers'][0]['sourceServerID']='other'
        if scenario in ['receipt-type','job-type']: value['type']='TERMINATE'
        if scenario=='job-mode': value['initiatedBy']='START_RECOVERY' if drill else 'START_DRILL'
        if scenario in ['receipt-resources','job-resources']: value['participatingResources']=[{'resourceID':'other'}]
        if scenario=='pending-membership': value.pop('participatingServers')
        if scenario.startswith('target-'):
            value['status']='PENDING' if scenario=='target-pending' else 'COMPLETED'; value['participatingServers'][0].update(launchStatus='LAUNCHED',recoveryInstanceID='i-0123456789abcdef0')
        return value
    def start_recovery(self,**kwargs):
        assert kwargs==dict(isDrill=drill,sourceServers=[dict(sourceServerID=config['sourceID'],recoverySnapshotID=config['snapshot'])]); writes.append(kwargs)
        if scenario=='ambiguous': raise RuntimeError('Local ambiguous SDK result')
        return {'job':self.job()}
    def describe_jobs(self,**kwargs): assert kwargs==dict(filters={'jobIDs':[job_id]},maxResults=2); return {'items':[self.job()]}
    def describe_recovery_instances(self,**kwargs): assert kwargs==dict(filters={'recoveryInstanceIDs':['i-0123456789abcdef0']},maxResults=2); return {'items':[data['recovery']]}
    def describe_instances(self,**kwargs): assert kwargs==dict(InstanceIds=['i-0123456789abcdef0']); return {'Reservations':[dict(OwnerId=config['account'],Instances=[data['instance']])]}
    def describe_instance_attribute(self,**kwargs): assert kwargs==dict(InstanceId='i-0123456789abcdef0',Attribute='disableApiTermination'); return {'DisableApiTermination':{'Value':scenario!='target-no-protection'}}
    def describe_volumes(self,**kwargs): assert kwargs==dict(VolumeIds=['vol-0123456789abcdef0']); return {'Volumes':[data['volume']]}
sdk=types.ModuleType('boto3'); sdk.Session=Session; sys.modules['boto3']=sdk
botocore=types.ModuleType('botocore'); botocore.__path__=[]; sys.modules['botocore']=botocore
module=types.ModuleType('botocore.config'); module.Config=Config; sys.modules['botocore.config']=module
cases=[('inspect',[],None),('launch',[],None),('missing-launch-confirm',[],None),('missing-point-confirm',[],None),('missing-operation-confirm',[],None),('source-page',[],None),('account',[],None),('version',[],None),('group-owner',[],None),('group-vpc',[],None),('default-encryption',[],None),('default-key',[],None),('snapshot-page',[],None),('snapshot-repeat',[],None),('snapshot-duplicate',[],None),('ambiguous',[],None),('receipt-id',[],None),('receipt-source',[],None),('receipt-type',[],None),('receipt-resources',[],None),('pending-membership',[],None),('job',[],None),('job-source',[],None),('job-type',[],None),('job-mode',[],None),('job-resources',[],None),
 ('source-id',['source','sourceServerID'],'other'),('failback',['source','replicationDirection'],'FAILBACK'),('network',['source','sourceNetworkID'],'sn-other'),('extended',['source','stagingArea','status'],'EXTENDED'),('staging-account',['source','stagingArea','stagingAccountID'],'other'),('existing-instance',['source','recoveryInstanceId'],'i-0123456789abcdef0'),('pending-launch',['source','lastLaunchResult'],'PENDING'),('replication-public',['replication','createPublicIP'],True),('replication-route',['replication','dataPlaneRouting'],'PUBLIC_IP'),('replication-key',['replication','ebsEncryptionKeyArn'],'other'),('replication-default-group',['replication','associateDefaultSecurityGroup'],True),('replication-ip',['replication','internetProtocol'],'IPV6'),('copy-ip',['launch','copyPrivateIp'],True),('copy-tags',['launch','copyTags'],True),('post-launch',['launch','postLaunchEnabled'],True),('fast',['launch','recoveryMode'],'FAST'),('into-existing',['launch','launchIntoInstanceProperties'],{'launchIntoEC2InstanceID':'i-0123456789abcdef0'}),('instance',['template','InstanceType'],'t2.micro'),('public',['template','NetworkInterfaces',0,'AssociatePublicIpAddress'],True),('fixed-ip',['template','NetworkInterfaces',0,'PrivateIpAddress'],'10.0.0.1'),('ipv6-prefix',['template','NetworkInterfaces',0,'Ipv6Prefixes'],[{'Ipv6Prefix':'2001:db8::/80'}]),('imds',['template','MetadataOptions','HttpTokens'],'optional'),('profile',['template','IamInstanceProfile'],{'Arn':'other'}),('disk-key',['template','BlockDeviceMappings',0,'Ebs','KmsKeyId'],'other'),('subnet-owner',['subnets',0,'OwnerId'],'other'),('subnet-public',['subnets',0,'MapPublicIpOnLaunch'],True),('ips',['subnets',0,'AvailableIpAddressCount'],0),('key-disabled',['key','KeyState'],'Disabled'),('snapshot-id',['snapshot','snapshotID'],'other'),('snapshot-source',['snapshot','sourceServerID'],'other'),('snapshot-pending',['snapshot','timestamp'],''),('snapshot-old',['snapshot','timestamp'],'2020-01-01T00:00:00Z'),('snapshot-future',['snapshot','timestamp'],'2199-01-01T00:00:00Z'),('snapshot-empty',['snapshot','ebsSnapshots'],[]),('snapshot-owner',['ebs','OwnerId'],'other'),('snapshot-state',['ebs','State'],'pending'),('snapshot-unencrypted',['ebs','Encrypted'],False),('snapshot-key',['ebs','KmsKeyId'],'other')]
cases += [('target-valid',[],None),('target-pending',[],None),('target-no-protection',[],None),('target-source',['recovery','sourceServerID'],'other'),('target-job',['recovery','jobID'],'other'),('target-state',['recovery','ec2InstanceState'],'TERMINATED'),('target-public',['instance','PublicIpAddress'],'192.0.2.1'),('target-group',['instance','SecurityGroups'],[]),('target-nic',['instance','NetworkInterfaces',0,'Association'],{'PublicIp':'192.0.2.1'}),('target-ipv6',['instance','NetworkInterfaces',0,'Ipv6Prefixes'],[{'Ipv6Prefix':'2001:db8::/80'}]),('target-imds',['instance','MetadataOptions','HttpTokens'],'optional'),('target-profile',['instance','IamInstanceProfile'],{'Arn':'other'}),('target-root',['instance','RootDeviceName'],'other'),('target-volume-key',['volume','KmsKeyId'],'other'),('target-volume-unencrypted',['volume','Encrypted'],False),('target-volume-attachment',['volume','Attachments'],[])]
total=0
for drill in [True,False]:
    config['mode']='DRILL' if drill else 'RECOVERY'; (root/'RECOVERY-CONFIG.json').write_text(json.dumps(config))
    for scenario,path,value in cases:
        data=copy.deepcopy(base); data['launch']['launchDisposition']='STOPPED' if drill else 'STARTED'; writes=[]; failure=None
        data['recovery'].update(isDrill=drill,ec2InstanceState='STOPPED' if drill else 'RUNNING'); data['instance']['State']['Name']='stopped' if drill else 'running'
        if path:
            parent=data
            for key in path[:-1]: parent=parent[key]
            parent[path[-1]]=value
        flags=['--launch','--confirm-launch','--confirm-recovery-point']+(['--confirm-isolation'] if drill else ['--confirm-incident','--confirm-fencing'])
        if scenario=='inspect': flags=[]
        if scenario=='missing-launch-confirm': flags.remove('--confirm-launch')
        if scenario=='missing-point-confirm': flags.remove('--confirm-recovery-point')
        if scenario=='missing-operation-confirm': flags.remove('--confirm-isolation' if drill else '--confirm-fencing')
        if scenario.startswith('job'): flags=['--job',job_id]
        if scenario.startswith('target-'): flags=['--job',job_id,'--check-target']
        sys.argv=['OPERATE.py']+flags
        with contextlib.redirect_stdout(io.StringIO()) as output:
            try: runpy.run_path(str(root/'OPERATE.py'),run_name='__main__')
            except SystemExit as error:
                if error.code not in [None,0]: failure=error
            except Exception as error: failure=error
        success=scenario in ['inspect','launch','snapshot-page','pending-membership','job','target-valid'] or drill and scenario=='target-no-protection'
        assert bool(failure)!=success,(drill,scenario,failure)
        assert len(writes)==int(scenario in ['launch','snapshot-page','ambiguous','receipt-id','receipt-source','receipt-type','receipt-resources','pending-membership']),(drill,scenario,writes)
        assert 'SYNTHETIC-DO-NOT-PRINT' not in output.getvalue()
        if scenario=='inspect': assert json.loads(output.getvalue())['source_replication_state']=='DISCONNECTED' and not json.loads(output.getvalue())['launch_requested']
        if scenario=='target-valid':
            report=json.loads(output.getvalue()); assert report['target_metadata_checked'] and report['volume_count']==1 and not report['selected_pit_and_data_integrity_verified'] and not report['application_acceptance_verified']
        total+=1
print('Passed',total,'generated DRS drill/recovery cases; SDK doubles only, no AWS or recovery/data operations.')
`);
const check=spawnSync(process.env.PYTHON_PATH||'python',[join(work,'harness.py')],{cwd:work,encoding:'utf8',timeout:60000,windowsHide:true});
process.stdout.write(check.stdout||'');process.stderr.write(check.stderr||'');if(check.error)throw check.error;
console.log(work);process.exitCode=check.status??1;
