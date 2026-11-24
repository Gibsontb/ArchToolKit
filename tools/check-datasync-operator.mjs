/** Execute exported operator code against local SDK doubles; never contact AWS. */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultValues } from '../src/kit/blueprint.ts';
import { AWS_DATASYNC_SERVICE } from '../src/cloud/aws-datasync-service.ts';
import { AWS_DATASYNC_NFS_SERVICE } from '../src/cloud/aws-datasync-nfs-service.ts';
import { AWS_DATASYNC_EFS_SERVICE } from '../src/cloud/aws-datasync-efs-service.ts';
import { AWS_DATASYNC_SMB_SERVICE } from '../src/cloud/aws-datasync-smb-service.ts';
import { AWS_DATASYNC_FSX_WINDOWS_SERVICE } from '../src/cloud/aws-datasync-fsx-windows-service.ts';
import { WORK_TMP } from './work.mjs';
const work = mkdtempSync(join(WORK_TMP, 'datasync-operator-test-'));
const role = 'arn:aws:iam::123456789012:role/DataSync';
for (const [name, blueprint, inputs] of [
  ['s3', AWS_DATASYNC_SERVICE, { source_bucket:'application-source', source_prefix:'/exports/', source_role:role, destination_bucket:'application-destination', destination_prefix:'/landing/', destination_role:role }],
  ['nfs', AWS_DATASYNC_NFS_SERVICE, { server:'nfs.example.com', path:'/exports/application', agent:'arn:aws:datasync:us-east-1:123456789012:agent/agent-0123456789abcdef0', bucket:'application-destination', role }],
  ['efs', AWS_DATASYNC_EFS_SERVICE, { server:'nfs.example.com', path:'/exports/application', agent:'arn:aws:datasync:us-east-1:123456789012:agent/agent-0123456789abcdef0', filesystem:'fs-0123456789abcdef0', accesspoint:'fsap-0123456789abcdef0', mount:'fsmt-0123456789abcdef0', subnet:'subnet-0123456789abcdef0', group:'sg-0123456789abcdef0', role }],
  ['smb', AWS_DATASYNC_SMB_SERVICE, { server:'files.example.com', path:'/Finance$/Reports', user:'MigrationReader', domain:'EXAMPLE', ntlm_allowed:true, agent:'arn:aws:datasync:us-east-1:123456789012:agent/agent-0123456789abcdef0', bucket:'application-destination', role }],
  ['fsx', AWS_DATASYNC_FSX_WINDOWS_SERVICE, { server:'files.example.com', path:'/Finance$/Reports', user:'MigrationReader', domain:'EXAMPLE', ntlm_allowed:true, agent:'arn:aws:datasync:us-east-1:123456789012:agent/agent-0123456789abcdef0', filesystem:'fs-0123456789abcdef0',group:'sg-0123456789abcdef0',target_user:'FsxMigration',target_domain:'EXAMPLE' }],
]) {
  const result = blueprint.build({ ...defaultValues(blueprint), aws_region:'us-east-1', name:'application-transfer', ...inputs });
  if (result.findings.length) throw new Error(JSON.stringify(result.findings));
  mkdirSync(join(work, name));
  for (const file of ['OPERATE.py', 'TRANSFER-CONFIG.json']) writeFileSync(join(work, name, file), result.files[file]);
}
writeFileSync(join(work, 'harness.py'), String.raw`import contextlib, copy, io, json, pathlib, runpy, subprocess, sys, types
root = pathlib.Path(__file__).resolve().parent
base = 'arn:aws:datasync:us-east-1:123456789012:'
job = dict(account='123456789012', task=base+'task/task-0123456789abcdef0', source=base+'location/loc-0123456789abcdef0', destination=base+'location/loc-0123456789abcdef1', log='arn:aws:logs:us-east-1:123456789012:log-group:/aws/datasync/application-transfer')
execution = job['task']+'/execution/exec-0123456789abcdef0'
class Config:
    def __init__(self, retries): assert retries == dict(total_max_attempts=1, mode='standard')
class Session:
    def __init__(self, region_name): assert region_name == 'us-east-1'
    def client(self, name, **kwargs):
        assert name in ['sts','datasync','s3','efs','ec2','fsx']
        if name == 'datasync': assert isinstance(kwargs['config'], Config)
        return self
    def get_caller_identity(self): return {'Account':'000000000000' if scenario == 'account' else job['account']}
    def describe_task(self, **kwargs):
        assert kwargs == {'TaskArn':job['task']}
        task = dict(TaskArn=job['task'], Name=config['name'], TaskMode='BASIC', Status='AVAILABLE', SourceLocationArn=job['source'], DestinationLocationArn=job['destination'], CloudWatchLogGroupArn=job['log'], Options=dict(config['options'],PreserveDeletedFiles='PRESERVE',TransferMode='CHANGED',VerifyMode='ONLY_FILES_TRANSFERRED',TaskQueueing='DISABLED'))
        if scenario == 'direction': task['DestinationLocationArn'] = job['source']
        if scenario == 'identity': task['Name'] = 'other'
        if scenario == 'log': task['CloudWatchLogGroupArn'] = 'other'
        if scenario == 'log-suffix': task['CloudWatchLogGroupArn'] += ':*'
        if scenario == 'mode': task['TaskMode'] = 'ENHANCED'
        if scenario == 'options': task['Options']['PreserveDeletedFiles'] = 'REMOVE'
        if scenario == 'verify': task['Options']['VerifyMode'] = 'NONE'
        if scenario == 'bandwidth': task['Options']['BytesPerSecond'] = 100
        if scenario == 'queue': task['Options']['TaskQueueing'] = 'ENABLED'
        if scenario == 'fsx-security': task['Options']['SecurityDescriptorCopyFlags'] = 'NONE'
        if scenario == 'filter': task['Includes'] = [{'FilterType':'SIMPLE_PATTERN','Value':'/other'}]
        if scenario == 'schedule': task['Schedule'] = {'ScheduleExpression':'rate(1 hour)'}
        if scenario == 'manifest': task['ManifestConfig'] = {'Action':'TRANSFER'}
        if scenario == 'report': task['TaskReportConfig'] = {'OutputType':'STANDARD'}
        if scenario == 'busy': task['Status'] = 'RUNNING'
        if scenario in ['previous-success','previous-error','previous-active','previous-foreign']: task['CurrentTaskExecutionArn'] = execution if scenario != 'previous-foreign' else 'other'
        return task
    def describe_location_s3(self, **kwargs):
        key = 'source' if kwargs['LocationArn'] == job['source'] else 'destination'
        location = config[key]
        value = dict(LocationArn=job[key],LocationUri='s3://'+location['bucket']+location['prefix'],S3Config={'BucketAccessRoleArn':location['role']},S3StorageClass='STANDARD')
        if scenario == 'uri': value['LocationUri'] += 'other'
        if scenario == 'role': value['S3Config']['BucketAccessRoleArn'] = 'other'
        if scenario == 'storage': value['S3StorageClass'] = 'GLACIER'
        if scenario == 'outposts': value['AgentArns'] = ['other']
        return value
    def describe_location_nfs(self, **kwargs):
        assert kwargs == {'LocationArn':job['source']}
        source = config['source']
        value = dict(LocationArn=job['source'],LocationUri='nfs://'+source['server']+source['path'],OnPremConfig={'AgentArns':[source['agent']]},MountOptions={'Version':source['version']})
        if scenario == 'nfs-path': value['LocationUri'] += '/other'
        if scenario == 'nfs-version': value['MountOptions']['Version'] = 'NFS3'
        if scenario == 'nfs-agent': value['OnPremConfig']['AgentArns'] = ['other']
        return value
    def describe_location_smb(self, **kwargs):
        assert kwargs == {'LocationArn':job['source']}
        source = config['source']
        value = dict(LocationArn=job['source'],LocationUri='smb://'+source['server']+source['path'],AgentArns=[source['agent']],MountOptions={'Version':'SMB3'},AuthenticationType='NTLM',User=source['user'],Domain=source['domain'])
        if scenario == 'smb-path': value['LocationUri'] += '/other'
        if scenario == 'smb-protocol': value['MountOptions']['Version'] = 'SMB2'
        if scenario == 'smb-agent': value['AgentArns'] = ['other']
        if scenario == 'smb-auth': value['AuthenticationType'] = 'KERBEROS'
        if scenario == 'smb-user': value['User'] = 'other'
        if scenario == 'smb-domain': value['Domain'] = 'other'
        if scenario == 'smb-local': value['Domain'] = None
        return value
    def describe_location_fsx_windows(self, **kwargs):
        assert kwargs == {'LocationArn':job['destination']}
        value = dict(LocationArn=job['destination'],LocationUri='fsxw://us-east-1.fs-0123456789abcdef0/share/migration',SecurityGroupArns=['arn:aws:ec2:us-east-1:123456789012:security-group/sg-0123456789abcdef0'],User=config['destination']['user'],Domain=config['destination']['domain'])
        if scenario == 'uri': value['LocationUri'] += 'other'
        if scenario == 'fsx-user': value['User'] = 'other'
        if scenario == 'fsx-domain': value['Domain'] = 'other'
        if scenario == 'fsx-group': value['SecurityGroupArns'] = ['other']
        return value
    def describe_file_systems(self, **kwargs):
        if 'FileSystemId' in kwargs: return self.describe_efs_file_systems(**kwargs)
        assert kwargs == {'FileSystemIds':[config['destination']['filesystem']]}
        value = dict(ResourceARN='arn:aws:fsx:us-east-1:123456789012:file-system/fs-0123456789abcdef0',OwnerId=job['account'],FileSystemType='WINDOWS',Lifecycle='AVAILABLE',KmsKeyId='mock-key',WindowsConfiguration={'AutomaticBackupRetentionDays':7},VpcId='vpc-0123456789abcdef0')
        if scenario == 'fsx-backup': value['WindowsConfiguration']['AutomaticBackupRetentionDays'] = 0
        if scenario == 'fsx-type': value['FileSystemType'] = 'LUSTRE'
        if scenario == 'fsx-state': value['Lifecycle'] = 'CREATING'
        if scenario == 'fsx-encryption': value['KmsKeyId'] = ''
        if scenario == 'fsx-arn': value['ResourceARN'] = 'other'
        return {'FileSystems':[value]}
    def describe_agent(self, **kwargs):
        assert kwargs == {'AgentArn':config['source']['agent']}
        return {'AgentArn':config['source']['agent'], 'Status':'OFFLINE' if scenario == 'offline' else 'ONLINE'}
    def get_bucket_versioning(self, **kwargs):
        assert kwargs == {'Bucket':config['destination']['bucket']}
        return {'Status':'Suspended' if scenario == 'versioning' else 'Enabled'}
    def get_bucket_location(self, **kwargs):
        assert kwargs['Bucket'] in [config['destination']['bucket'],config['source'].get('bucket')]
        return {'LocationConstraint':'us-west-2' if scenario == 'region' else None}
    def describe_location_efs(self, **kwargs):
        assert kwargs == {'LocationArn':job['destination']}
        value = dict(LocationArn=job['destination'],LocationUri='efs://us-east-1.fs-0123456789abcdef0/',AccessPointArn='arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0123456789abcdef0',FileSystemAccessRoleArn=config['destination']['role'],InTransitEncryption='TLS1_2',Ec2Config={'SubnetArn':'arn:aws:ec2:us-east-1:123456789012:subnet/subnet-0123456789abcdef0','SecurityGroupArns':['arn:aws:ec2:us-east-1:123456789012:security-group/sg-0123456789abcdef0']})
        if scenario == 'uri': value['LocationUri'] += 'other'
        if scenario == 'role': value['FileSystemAccessRoleArn'] = 'other'
        if scenario == 'efs-tls': value['InTransitEncryption'] = 'NONE'
        if scenario == 'efs-ap': value['AccessPointArn'] = 'other'
        if scenario == 'efs-group': value['Ec2Config']['SecurityGroupArns'] = ['other']
        return value
    def describe_efs_file_systems(self, **kwargs):
        assert kwargs == {'FileSystemId':config['destination']['filesystem']}
        value = dict(FileSystemArn='arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-0123456789abcdef0',OwnerId=job['account'],Encrypted=True,LifeCycleState='available')
        if scenario == 'efs-encryption': value['Encrypted'] = False
        if scenario == 'efs-state': value['LifeCycleState'] = 'updating'
        return {'FileSystems':[value]}
    def describe_access_points(self, **kwargs):
        assert kwargs == {'AccessPointId':config['destination']['accesspoint']}
        value = dict(AccessPointArn='arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0123456789abcdef0',FileSystemId=config['destination']['filesystem'],LifeCycleState='available',RootDirectory={'Path':config['destination']['path']})
        if scenario == 'efs-root': value['RootDirectory']['Path'] = '/'
        if scenario == 'efs-posix': value['PosixUser'] = {'Uid':1000,'Gid':1000}
        return {'AccessPoints':[value]}
    def describe_mount_targets(self, **kwargs):
        assert kwargs == {'MountTargetId':config['destination']['mount']}
        value = dict(MountTargetId=config['destination']['mount'],FileSystemId=config['destination']['filesystem'],OwnerId=job['account'],LifeCycleState='available',VpcId='vpc-0123456789abcdef0',AvailabilityZoneId='use1-az1')
        if scenario == 'efs-mount': value['FileSystemId'] = 'other'
        return {'MountTargets':[value]}
    def describe_subnets(self, **kwargs):
        assert kwargs == {'SubnetIds':[config['destination']['subnet']]}
        value = dict(OwnerId=job['account'],AvailabilityZoneId='use1-az1',VpcId='vpc-0123456789abcdef0',MapPublicIpOnLaunch=False,AvailableIpAddressCount=10)
        if scenario == 'efs-az': value['AvailabilityZoneId'] = 'use1-az2'
        if scenario == 'efs-vpc': value['VpcId'] = 'other'
        if scenario == 'efs-public': value['MapPublicIpOnLaunch'] = True
        if scenario == 'efs-ips': value['AvailableIpAddressCount'] = 0
        return {'Subnets':[value]}
    def describe_vpcs(self, **kwargs):
        assert kwargs == {'VpcIds':['vpc-0123456789abcdef0']}
        return {'Vpcs':[{'InstanceTenancy':'dedicated' if scenario == 'efs-tenancy' else 'default'}]}
    def describe_security_groups(self, **kwargs):
        assert kwargs == {'GroupIds':[config['destination']['group']]}
        rule = {'IpProtocol':'tcp','FromPort':2049,'ToPort':2049,'UserIdGroupPairs':[{'GroupId':config['destination']['group']}]}
        value = dict(GroupId=config['destination']['group'],OwnerId=job['account'],VpcId='vpc-0123456789abcdef0',IpPermissions=[copy.deepcopy(rule)],IpPermissionsEgress=[copy.deepcopy(rule)])
        if scenario == 'efs-ingress': value['IpPermissions'] = []
        if scenario == 'efs-egress': value['IpPermissionsEgress'][0]['ToPort'] = 2048
        if scenario == 'efs-group-vpc': value['VpcId'] = 'other'
        if scenario == 'efs-all-egress': value['IpPermissionsEgress'] = [{'IpProtocol':'-1','IpRanges':[{'CidrIp':'0.0.0.0/0'}]}]
        return {'SecurityGroups':[value]}
    def describe_mount_target_security_groups(self, **kwargs):
        assert kwargs == {'MountTargetId':config['destination']['mount']}
        return {'SecurityGroups':['other' if scenario == 'efs-mount-group' else config['destination']['group']]}
    def describe_backup_policy(self, **kwargs):
        assert kwargs == {'FileSystemId':config['destination']['filesystem']}
        return {'BackupPolicy':{'Status':'DISABLED' if scenario == 'efs-backup' else 'ENABLED'}}
    def describe_task_execution(self, **kwargs):
        reads.append(kwargs)
        assert kwargs == {'TaskExecutionArn':execution}
        return dict(TaskExecutionArn='other' if scenario == 'execution-drift' else execution, Status='TRANSFERRING' if scenario == 'previous-active' else 'ERROR' if scenario == 'previous-error' else 'SUCCESS',FilesTransferred=42, BytesWritten=1234, Result={'VerifyStatus':'SUCCESS'})
    def start_task_execution(self, **kwargs):
        writes.append(kwargs)
        assert kwargs == {'TaskArn':job['task']}
        if scenario == 'ambiguous': raise RuntimeError('synthetic ambiguous transport failure')
        return {'TaskExecutionArn':'other' if scenario == 'receipt' else execution}
sdk = types.ModuleType('boto3'); sdk.Session = Session; sys.modules['boto3'] = sdk
botocore = types.ModuleType('botocore'); botocore.__path__ = []; sys.modules['botocore'] = botocore
module = types.ModuleType('botocore.config'); module.Config = Config; sys.modules['botocore.config'] = module
def outputs(command, text):
    assert command == ['terraform','output','-json','operator_job'] and text
    value = dict(job)
    if scenario == 'job-arn': value['task'] = 'other'
    if kind == 'fsx': value['destination_uri'] = 'fsxw://us-east-1.fs-0123456789abcdef0/share/migration'
    if scenario == 'fsx-job-uri': value['destination_uri'] = 'other'
    return json.dumps(value)
subprocess.check_output = outputs
count = 0
for kind in ['s3','nfs','efs','smb','fsx']:
    original = json.loads((root/kind/'TRANSFER-CONFIG.json').read_text())
    scenarios = ['inspect','start','missing-confirm','overwrite','overwrite-confirm','account','job-arn','identity','direction','log','log-suffix','mode','options','verify','bandwidth','queue','filter','schedule','manifest','report','busy','uri','role','storage','outposts','versioning','region','previous-success','previous-error','previous-active','previous-foreign','ambiguous','receipt','execution','execution-foreign','execution-drift']
    if kind in ['nfs','efs']: scenarios += ['nfs-path','nfs-version','nfs-agent','offline']
    if kind == 'smb': scenarios += ['smb-path','smb-protocol','smb-agent','smb-auth','smb-user','smb-domain','smb-local','offline']
    if kind == 'fsx':
        scenarios = [item for item in scenarios if item not in ['role','storage','outposts','versioning','region']]
        scenarios += ['smb-path','smb-protocol','smb-agent','smb-auth','smb-user','smb-domain','offline','fsx-user','fsx-domain','fsx-group','fsx-backup','fsx-type','fsx-state','fsx-encryption','fsx-arn','fsx-job-uri','fsx-security']
    if kind == 'efs':
        scenarios = [item for item in scenarios if item not in ['storage','outposts','versioning','region']]
        scenarios += ['efs-tls','efs-ap','efs-group','efs-encryption','efs-state','efs-root','efs-posix','efs-mount','efs-az','efs-vpc','efs-public','efs-ips','efs-mount-group','efs-backup','efs-tenancy','efs-ingress','efs-egress','efs-group-vpc','efs-all-egress']
    for scenario in scenarios:
        config = copy.deepcopy(original); writes = []; reads = []
        if scenario == 'smb-local': config['source']['domain'] = ''
        if scenario in ['overwrite','overwrite-confirm']: config['options']['OverwriteMode'] = 'ALWAYS'
        (root/kind/'TRANSFER-CONFIG.json').write_text(json.dumps(config))
        args = [] if scenario in ['inspect','log-suffix'] else ['--start','--confirm-transfer']
        if scenario == 'missing-confirm': args = ['--start']
        if scenario == 'overwrite-confirm': args += ['--confirm-overwrite']
        if scenario.startswith('execution'): args = ['--execution','other' if scenario == 'execution-foreign' else execution]
        sys.argv = ['OPERATE.py'] + args
        failure = None
        with contextlib.redirect_stdout(io.StringIO()) as output:
            try: runpy.run_path(str(root/kind/'OPERATE.py'), run_name='__main__')
            except SystemExit as error:
                if error.code not in [None,0]: failure = error
            except Exception as error: failure = error
        success = scenario in ['inspect','start','overwrite-confirm','log-suffix','previous-success','previous-error','execution','efs-all-egress','smb-local']
        assert bool(failure) != success, (kind,scenario,failure)
        should_write = scenario in ['start','overwrite-confirm','previous-success','previous-error','ambiguous','receipt','efs-all-egress','smb-local']
        assert len(writes) == int(should_write), (kind,scenario,writes)
        if scenario == 'execution':
            data = json.loads(output.getvalue()); assert data['FilesTransferred'] == 42 and data['Result']['VerifyStatus'] == 'SUCCESS'
        if scenario == 'inspect': assert json.loads(output.getvalue())['copy_started'] is False
        count += 1
print('Passed',count,'generated DataSync operator cases; no AWS calls, object reads or data movement.')
`);
const result = spawnSync(process.env.PYTHON_PATH || 'python', [join(work, 'harness.py')], { cwd:work, encoding:'utf8', timeout:60000, windowsHide:true });
process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
if (result.error) throw result.error;
console.log(work);
process.exitCode = result.status ?? 1;
