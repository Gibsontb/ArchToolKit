/** Run the actual generated pilot script with local SDK doubles, never AWS. */
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_MGN_SERVICE} from '../src/cloud/aws-mgn-service.ts';
import {AWS_MGN_CUTOVER_SERVICE} from '../src/cloud/aws-mgn-cutover-service.ts';
import {WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'mgn-operator-test-'));
const production=process.argv.includes('--cutover'),blueprint=production?AWS_MGN_CUTOVER_SERVICE:AWS_MGN_SERVICE;
const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',name:'pilot',source:'arn:aws:mgn:us-east-1:123456789012:source-server/s-0123456789abcdef0',template:'lt-0123456789abcdef0',subnet:'subnet-0123456789abcdef0',staging:'subnet-0123456789abcdef1',groups:'sg-0123456789abcdef0',staging_groups:'sg-0123456789abcdef1',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc'});
if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const name of ['OPERATE.py',production?'CUTOVER-CONFIG.json':'PILOT-CONFIG.json'])writeFileSync(join(work,name),result.files[name]);
writeFileSync(join(work,'harness.py'),String.raw`import contextlib, copy, io, json, pathlib, runpy, sys, types
root=pathlib.Path(__file__).resolve().parent
production=(root/'CUTOVER-CONFIG.json').exists()
config=json.loads((root/('CUTOVER-CONFIG.json' if production else 'PILOT-CONFIG.json')).read_text())
job_id='mgnjob-0123456789abcdef0'
class Config:
    def __init__(self,retries,use_fips_endpoint):
        assert retries==dict(total_max_attempts=1,mode='standard') and use_fips_endpoint==config['fips']
class Session:
    def __init__(self,region_name): assert region_name==config['region']
    def client(self,name,config):
        assert name in ['sts','mgn','ec2','kms'] and isinstance(config,Config); return self
    def get_caller_identity(self): return {'Account':'000000000000' if scenario=='account' else config['account']}
    def describe_source_servers(self,**kwargs):
        assert kwargs==dict(filters={'sourceServerIDs':[config['sourceID']]},maxResults=2)
        if scenario=='sdk': raise RuntimeError('synthetic SDK metadata failure')
        source=dict(arn=config['source'],sourceServerID=config['sourceID'],isArchived=False,replicationType='AGENT_BASED',lifeCycle={'state':'READY_FOR_TEST'},dataReplicationInfo={'dataReplicationState':'CONTINUOUS','lagDuration':'PT20S'})
        if scenario=='source': source['arn']='other'
        if scenario=='archived': source['isArchived']=True
        if scenario=='agentless': source['replicationType']='SNAPSHOT_SHIPPING'
        source['lifeCycle']['state']='READY_FOR_CUTOVER' if production else 'READY_FOR_TEST'
        if production: source['dataReplicationInfo']['lagDuration']='PT0S'
        if scenario=='lifecycle': source['lifeCycle']['state']='READY_FOR_TEST' if production else 'READY_FOR_CUTOVER'
        if scenario=='existing-instance': source['launchedInstance']={'ec2InstanceID':'i-0123456789abcdef0'}
        if scenario=='replication-state': source['dataReplicationInfo']['dataReplicationState']='DISCONNECTED'
        if scenario=='replication-error': source['dataReplicationInfo']['dataReplicationError']={'error':'SNAPSHOTS_FAILURE'}
        if scenario=='lag': source['dataReplicationInfo']['lagDuration']='PT61S'
        if scenario=='hour-lag': source['dataReplicationInfo']['lagDuration']='PT1H'
        if scenario=='fractional-lag': source['dataReplicationInfo']['lagDuration']='PT0.5S'
        if scenario=='zero-lag': source['dataReplicationInfo']['lagDuration']='PT0S'
        if scenario=='empty-lag': source['dataReplicationInfo']['lagDuration']='PT'
        if scenario=='day-lag': source['dataReplicationInfo']['lagDuration']='P1D'
        return {'items':[source],'nextToken':'other' if scenario=='source-page' else ''}
    def get_replication_configuration(self,**kwargs):
        assert kwargs=={'sourceServerID':config['sourceID']}
        value=dict(sourceServerID=config['sourceID'],stagingAreaSubnetId=config['staging'],replicationServersSecurityGroupsIDs=config['stagingGroups'],createPublicIP=False,dataPlaneRouting='PRIVATE_IP',ebsEncryption='CUSTOM',ebsEncryptionKeyArn=config['kms'],useFipsEndpoint=config['fips'],storageConfiguration={'storageType':'EBS'},internetProtocol='IPV4')
        for test,key,changed in [('staging','stagingAreaSubnetId','other'),('staging-group','replicationServersSecurityGroupsIDs',['other']),('staging-public','createPublicIP',True),('staging-route','dataPlaneRouting','PUBLIC_IP'),('staging-key','ebsEncryptionKeyArn','other'),('staging-encryption','ebsEncryption','DEFAULT'),('fips','useFipsEndpoint',False),('replication-ipv6','internetProtocol','IPV6')]:
            if scenario==test: value[key]=changed
        if scenario=='fsx-staging': value['storageConfiguration']['storageType']='FSX'
        return value
    def get_launch_configuration(self,**kwargs):
        assert kwargs=={'sourceServerID':config['sourceID']}
        value=dict(sourceServerID=config['sourceID'],ec2LaunchTemplateID=config['template'],launchDisposition='STOPPED',copyPrivateIp=False,targetInstanceTypeRightSizingMethod='NONE')
        if production: value['launchDisposition']='STARTED'
        for test,key,changed in [('launch-source','sourceServerID','other'),('launch-template','ec2LaunchTemplateID','other'),('started','launchDisposition','STARTED'),('copy-ip','copyPrivateIp',True),('rightsize','targetInstanceTypeRightSizingMethod','BASIC')]:
            if scenario==test: value[key]=changed
        if production and scenario=='started': value['launchDisposition']='STOPPED'
        if scenario=='launch-action': value['postLaunchActions']={'ssmDocuments':[{'ssmDocumentName':'other'}]}
        return value
    def list_source_server_actions(self,**kwargs):
        assert kwargs==dict(sourceServerID=config['sourceID'],maxResults=1000)
        return {'items':[{'active':True}] if scenario=='source-action' else [{'active':False}],'nextToken':'other' if scenario=='action-page' else ''}
    def describe_launch_templates(self,**kwargs):
        assert kwargs=={'LaunchTemplateIds':[config['template']]}
        return {'LaunchTemplates':[{'LaunchTemplateId':config['template'],'DefaultVersionNumber':2 if scenario=='version' else config['version']}]}
    def describe_launch_template_versions(self,**kwargs):
        assert kwargs==dict(LaunchTemplateId=config['template'],Versions=[str(config['version'])])
        nic=dict(DeviceIndex=0,SubnetId=config['subnet'],Groups=config['groups'],AssociatePublicIpAddress=False)
        value=dict(InstanceType=config['instance'],NetworkInterfaces=[nic],MetadataOptions={'HttpTokens':'required','HttpEndpoint':'enabled','HttpPutResponseHopLimit':2},UserData='SYNTHETIC-DO-NOT-PRINT',BlockDeviceMappings=[{'DeviceName':'/dev/sda1','Ebs':{'Encrypted':True,'KmsKeyId':config['kms']}}])
        if production: value['DisableApiTermination']=scenario!='no-protection'
        if scenario=='instance': value['InstanceType']='t2.micro'
        if scenario=='top-groups': value['SecurityGroupIds']=['other']
        if scenario=='two-nics': value['NetworkInterfaces'].append(copy.deepcopy(nic))
        if scenario=='nic-subnet': nic['SubnetId']='other'
        if scenario=='nic-group': nic['Groups']=['other']
        if scenario=='public-ip': nic['AssociatePublicIpAddress']=True
        if scenario=='existing-nic': nic['NetworkInterfaceId']='eni-other'
        if scenario=='fixed-ip': nic['PrivateIpAddress']='10.0.0.5'
        if scenario=='ipv6': nic['Ipv6AddressCount']=1
        if scenario=='ipv6-prefix': nic['Ipv6Prefixes']=[{'Ipv6Prefix':'2001:db8::/80'}]
        if scenario=='ipv6-prefix-count': nic['Ipv6PrefixCount']=1
        if scenario=='imds': value['MetadataOptions']['HttpTokens']='optional'
        if scenario=='hop-limit': value['MetadataOptions']['HttpPutResponseHopLimit']=3
        if scenario=='profile': value['IamInstanceProfile']={'Arn':'other'}
        if scenario=='profile-name': value['IamInstanceProfile']={'Name':'other'}
        if scenario=='disk-encryption': value['BlockDeviceMappings'][0]['Ebs']['Encrypted']=False
        if scenario=='disk-key': value['BlockDeviceMappings'][0]['Ebs']['KmsKeyId']='other'
        return {'LaunchTemplateVersions':[{'VersionNumber':config['version'],'LaunchTemplateData':value}]}
    def describe_subnets(self,**kwargs):
        assert set(kwargs['SubnetIds'])==set([config['subnet'],config['staging']])
        values=[dict(SubnetId=subnet,VpcId='vpc-0123456789abcdef0',OwnerId=config['account'],MapPublicIpOnLaunch=False,AvailableIpAddressCount=10) for subnet in kwargs['SubnetIds']]
        for test,key,changed in [('subnet-owner','OwnerId','000000000000'),('subnet-vpc','VpcId','other'),('subnet-public','MapPublicIpOnLaunch',True),('subnet-ips','AvailableIpAddressCount',0),('subnet-ipv6','AssignIpv6AddressOnCreation',True)]:
            if scenario==test: values[0][key]=changed
        return {'Subnets':values}
    def describe_security_groups(self,**kwargs):
        assert set(kwargs['GroupIds'])==set(config['groups']+config['stagingGroups'])
        values=[dict(GroupId=group,VpcId='other' if scenario=='group-vpc' else 'vpc-0123456789abcdef0',OwnerId=config['account']) for group in kwargs['GroupIds']]
        return {'SecurityGroups':values}
    def describe_key(self,**kwargs):
        assert kwargs=={'KeyId':config['kms']}
        return {'KeyMetadata':dict(Arn=config['kms'],KeyState='Disabled' if scenario=='key-state' else 'Enabled',KeySpec='RSA_2048' if scenario=='key-type' else 'SYMMETRIC_DEFAULT',KeyUsage='ENCRYPT_DECRYPT',KeyManager='CUSTOMER')}
    def get_ebs_encryption_by_default(self): return {'EbsEncryptionByDefault':scenario!='default-encryption'}
    def get_ebs_default_kms_key_id(self): return {'KmsKeyId':'other' if scenario=='default-key' else config['kms']}
    def job(self):
        value=dict(jobID=job_id,initiatedBy='START_TEST',type='LAUNCH',status='PENDING',participatingServers=[{'sourceServerID':config['sourceID'],'launchStatus':'PENDING'}])
        if production: value['initiatedBy']='START_CUTOVER'
        if scenario in ['job-source','receipt-source']: value['participatingServers'][0]['sourceServerID']='other'
        if scenario=='job-cutover': value['initiatedBy']='START_TEST' if production else 'START_CUTOVER'
        if scenario=='pending-membership': value.pop('participatingServers')
        if scenario=='receipt-id': value['jobID']='other'
        return value
    def start_test(self,**kwargs):
        assert not production
        return self.launch(**kwargs)
    def start_cutover(self,**kwargs):
        assert production
        return self.launch(**kwargs)
    def launch(self,**kwargs):
        writes.append(kwargs); assert kwargs=={'sourceServerIDs':[config['sourceID']]}
        if scenario=='ambiguous': raise RuntimeError('synthetic ambiguous start failure')
        return {'job':self.job()}
    def describe_jobs(self,**kwargs):
        assert kwargs==dict(filters={'jobIDs':[job_id]},maxResults=2)
        return {'items':[self.job()]}
sdk=types.ModuleType('boto3'); sdk.Session=Session; sys.modules['boto3']=sdk
botocore=types.ModuleType('botocore'); botocore.__path__=[]; sys.modules['botocore']=botocore
module=types.ModuleType('botocore.config'); module.Config=Config; sys.modules['botocore.config']=module
scenarios=['inspect','test','missing-confirm','account','sdk','source','source-page','archived','agentless','lifecycle','existing-instance','replication-state','replication-error','lag','hour-lag','fractional-lag','zero-lag','empty-lag','day-lag','staging','staging-group','staging-public','staging-route','staging-key','staging-encryption','fips','replication-ipv6','fsx-staging','launch-source','launch-template','started','copy-ip','rightsize','launch-action','source-action','action-page','version','instance','top-groups','two-nics','nic-subnet','nic-group','public-ip','existing-nic','fixed-ip','ipv6','imds','hop-limit','profile','profile-name','disk-encryption','disk-key','subnet-owner','subnet-vpc','subnet-public','subnet-ips','subnet-ipv6','group-vpc','key-state','key-type','default-encryption','default-key','ambiguous','receipt-id','receipt-source','pending-membership','job','job-source','job-cutover']
scenarios+=['ipv6-prefix','ipv6-prefix-count']
if production: scenarios+=['no-protection','missing-freeze','missing-backup','missing-acceptance']
for scenario in scenarios:
    writes=[]; failure=None
    args=[] if scenario=='inspect' else ['--test','--confirm-launch']
    if scenario=='missing-confirm': args=['--test']
    if scenario.startswith('job'): args=['--job',job_id]
    if production and '--test' in args:
        args[0]='--cutover'
        args+=['--confirm-write-freeze','--confirm-backup','--confirm-acceptance']
        for case,flag in [('missing-freeze','--confirm-write-freeze'),('missing-backup','--confirm-backup'),('missing-acceptance','--confirm-acceptance')]:
            if scenario==case: args.remove(flag)
    sys.argv=['OPERATE.py']+args
    with contextlib.redirect_stdout(io.StringIO()) as output:
        try: runpy.run_path(str(root/'OPERATE.py'),run_name='__main__')
        except SystemExit as error:
            if error.code not in [None,0]: failure=error
        except Exception as error: failure=error
    success=scenario in ['inspect','test','fractional-lag','zero-lag','pending-membership','job']
    assert bool(failure)!=success,(scenario,failure)
    assert len(writes)==int(scenario in ['test','fractional-lag','zero-lag','ambiguous','receipt-id','receipt-source','pending-membership']),(scenario,writes)
    assert 'SYNTHETIC-DO-NOT-PRINT' not in output.getvalue()
    if scenario=='inspect': assert json.loads(output.getvalue())['launch_requested'] is False
    if scenario=='pending-membership': assert json.loads(output.getvalue())['membership_pending'] is True
print('Passed',len(scenarios),'generated MGN operator cases; no AWS, agent access, launch or data movement.')
`);
const check=spawnSync(process.env.PYTHON_PATH||'python',[join(work,'harness.py')],{cwd:work,encoding:'utf8',timeout:60000,windowsHide:true});
process.stdout.write(check.stdout||'');process.stderr.write(check.stderr||'');if(check.error)throw check.error;
console.log(work);process.exitCode=check.status??1;
