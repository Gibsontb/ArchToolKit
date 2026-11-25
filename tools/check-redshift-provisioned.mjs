/** Execute generated warehouse inspections using SDK doubles, no credentials or SQL. */
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_REDSHIFT_PROVISIONED_SERVICE as blueprint} from '../src/cloud/aws-redshift-provisioned-service.ts';
import {WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'redshift-provisioned-test-'));
const kms='arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc';
const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',name:'warehouse',subnets:'subnet-0123456789abcdef0,subnet-0123456789abcdef1',clients:'sg-0123456789abcdef0',kms,secret_kms:kms.slice(0,-1)+'d',log_kms:kms.slice(0,-1)+'e'});
if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const name of ['INSPECT.py','WAREHOUSE-CONFIG.json'])writeFileSync(join(work,name),result.files[name]);
writeFileSync(join(work,'harness.py'),String.raw`import contextlib, copy, io, json, pathlib, runpy, sys, types
root=pathlib.Path(__file__).resolve().parent; config=json.loads((root/'WAREHOUSE-CONFIG.json').read_text())
vpc='vpc-0123456789abcdef0'; security='sg-0123456789abcdef1'; secret='arn:aws:secretsmanager:'+config['region']+':'+config['account']+':secret:redshift!warehouse-abcdef'
base={
 'account':config['account'],
 'subnets':[dict(SubnetId=value,VpcId=vpc,AvailabilityZoneId='use1-az'+str(index+1),AvailabilityZone='us-east-1'+chr(97+index),OwnerId=config['account'],MapPublicIpOnLaunch=False,AvailableIpAddressCount=10) for index,value in enumerate(config['subnets'])],
 'clients':[dict(GroupId=value,OwnerId=config['account'],VpcId=vpc) for value in config['clients']],
 'dns':True,
 'offering':dict(NodeType=config['node'],ClusterVersion='1.0',ClusterType='multi-node',AvailabilityZones=[dict(Name='us-east-1'+chr(97+index),SupportedPlatforms=[{'Name':'VPC'}]) for index in range(2)]),
 'cluster':dict(ClusterIdentifier=config['name'],ClusterStatus='available',VpcId=vpc,NodeType=config['node'],NumberOfNodes=config['count'],DBName=config['database'],MasterUsername=config['admin'],PubliclyAccessible=False,Encrypted=True,KmsKeyId=config['kms'],EnhancedVpcRouting=True,MultiAZ='Disabled',AutomatedSnapshotRetentionPeriod=config['snapshots'],ManualSnapshotRetentionPeriod=-1,PreferredMaintenanceWindow=config['maintenanceWindow'],ClusterSubnetGroupName=config['name']+'-subnets',SnapshotScheduleIdentifier=config['name']+'-daily',SnapshotScheduleState='ACTIVE',Endpoint={'Address':'warehouse.example.redshift.amazonaws.com','Port':5439},MasterPasswordSecretArn=secret,MasterPasswordSecretKmsKeyId=config['secretKms'],VpcSecurityGroups=[dict(Status='active',VpcSecurityGroupId=security)],ClusterParameterGroups=[dict(ParameterGroupName=config['name']+'-tls',ParameterApplyStatus='in-sync')]),
 'subnet_group':dict(ClusterSubnetGroupName=config['name']+'-subnets',VpcId=vpc,SubnetGroupStatus='Complete',Subnets=[dict(SubnetIdentifier=value,SubnetStatus='Active') for value in config['subnets']]),
 'schedule':dict(ScheduleIdentifier=config['name']+'-daily',ScheduleDefinitions=[config['snapshotDefinition']],AssociatedClusterCount=1,AssociatedClusters=[dict(ClusterIdentifier=config['name'],ScheduleAssociationState='ACTIVE')]),
 'secret':dict(ARN=secret,RotationEnabled=True,KmsKeyId=config['secretKms']),
 'warehouse_group':dict(GroupId=security,GroupName=config['name']+'-clients',OwnerId=config['account'],VpcId=vpc,IpPermissions=[dict(IpProtocol='tcp',FromPort=5439,ToPort=5439,UserIdGroupPairs=[dict(GroupId=value,UserId=config['account']) for value in config['clients']])]),
 'parameters':[dict(ParameterName='require_ssl',ParameterValue='true'),dict(ParameterName='enable_user_activity_logging',ParameterValue='false')],
 'logging':dict(LoggingEnabled=True,LogDestinationType='cloudwatch',LogExports=['connectionlog','userlog']),
 'logs':[dict(logGroupName=name,kmsKeyId=config['logKms'],retentionInDays=config['retention']) for name in config['logNames']],
}
class Config:
    def __init__(self,retries,use_fips_endpoint): assert retries==dict(total_max_attempts=1,mode='standard') and use_fips_endpoint is True
class Session:
    def __init__(self,region_name): assert region_name==config['region']
    def client(self,name,config):
        assert name in ['sts','kms','ec2','redshift','secretsmanager','logs'] and isinstance(config,Config); return self
    def get_caller_identity(self): return {'Account':data['account']}
    def describe_key(self,**kwargs):
        selected=kwargs['KeyId']; allowed=[config['kms'],config['secretKms'],config['logKms']]
        arn=next((arn for arn in allowed if selected in [arn,arn.split('/')[-1]]), 'other')
        return {'KeyMetadata':dict(Arn=arn,KeyState='Disabled' if scenario=='disabled-key' else 'Enabled',KeySpec='RSA_2048' if scenario=='asymmetric' else 'SYMMETRIC_DEFAULT',KeyUsage='ENCRYPT_DECRYPT',KeyManager='AWS' if scenario=='service-key' else 'CUSTOMER')}
    def describe_subnets(self,**kwargs): assert kwargs==dict(SubnetIds=config['subnets']); return {'Subnets':data['subnets']}
    def describe_vpc_attribute(self,**kwargs): assert kwargs==dict(VpcId=vpc,Attribute='enableDnsSupport'); return {'EnableDnsSupport':{'Value':data['dns']}}
    def describe_security_groups(self,**kwargs):
        if kwargs['GroupIds']==config['clients']: return {'SecurityGroups':data['clients']}
        assert kwargs==dict(GroupIds=[security]); return {'SecurityGroups':[data['warehouse_group']]}
    def describe_orderable_cluster_options(self,**kwargs):
        assert {key:value for key,value in kwargs.items() if key!='Marker'}==dict(ClusterVersion='1.0',NodeType=config['node'],MaxRecords=100)
        if scenario in ['offering-page','offering-repeat'] and not kwargs.get('Marker'): return {'OrderableClusterOptions':[],'Marker':'one'}
        return {'OrderableClusterOptions':[data['offering']],'Marker':'one' if scenario=='offering-repeat' else ''}
    def describe_clusters(self,**kwargs): assert kwargs==dict(ClusterIdentifier=config['name']) and scenario!='preflight'; return {'Clusters':[data['cluster']]}
    def describe_cluster_subnet_groups(self,**kwargs): assert kwargs==dict(ClusterSubnetGroupName=config['name']+'-subnets',MaxRecords=100); return {'ClusterSubnetGroups':[data['subnet_group']]}
    def describe_snapshot_schedules(self,**kwargs): assert kwargs==dict(ScheduleIdentifier=config['name']+'-daily',MaxRecords=100); return {'SnapshotSchedules':[data['schedule']]}
    def describe_secret(self,**kwargs): assert kwargs==dict(SecretId=secret); return data['secret']
    def describe_cluster_parameters(self,**kwargs):
        assert {key:value for key,value in kwargs.items() if key!='Marker'}==dict(ParameterGroupName=config['name']+'-tls',Source='user',MaxRecords=100)
        if scenario in ['parameter-page','parameter-repeat'] and not kwargs.get('Marker'): return {'Parameters':[],'Marker':'one'}
        return {'Parameters':data['parameters'],'Marker':'one' if scenario=='parameter-repeat' else ''}
    def describe_logging_status(self,**kwargs): assert kwargs==dict(ClusterIdentifier=config['name']); return data['logging']
    def describe_log_groups(self,**kwargs):
        assert kwargs['limit']==50 and kwargs['logGroupNamePrefix'] in config['logNames']
        return {'logGroups':[value for value in data['logs'] if value['logGroupName']==kwargs['logGroupNamePrefix']]}
sdk=types.ModuleType('boto3'); sdk.Session=Session; sys.modules['boto3']=sdk
botocore=types.ModuleType('botocore'); botocore.__path__=[]; sys.modules['botocore']=botocore
module=types.ModuleType('botocore.config'); module.Config=Config; sys.modules['botocore.config']=module
cases=[('preflight',[],None),('check',[],None),('offering-page',[],None),('parameter-page',[],None),('offering-repeat',[],None),('parameter-repeat',[],None),('disabled-key',[],None),('asymmetric',[],None),('service-key',[],None),('key-ids',[],None),
 ('account',['account'],'000000000000'),('subnet-owner',['subnets',0,'OwnerId'],'other'),('same-az',['subnets',1,'AvailabilityZoneId'],'use1-az1'),('public-subnet',['subnets',0,'MapPublicIpOnLaunch'],True),('ips',['subnets',0,'AvailableIpAddressCount'],0),('ipv6',['subnets',0,'AssignIpv6AddressOnCreation'],True),('dns',['dns'],False),('client-vpc',['clients',0,'VpcId'],'other'),('client-owner',['clients',0,'OwnerId'],'other'),('offering-type',['offering','NodeType'],'other'),('offering-single',['offering','ClusterType'],'single-node'),('offering-platform',['offering','AvailabilityZones',0,'SupportedPlatforms'],[]),
 ('cluster-id',['cluster','ClusterIdentifier'],'other'),('cluster-state',['cluster','ClusterStatus'],'modifying'),('pending',['cluster','PendingModifiedValues'],{'NumberOfNodes':4}),('cluster-public',['cluster','PubliclyAccessible'],True),('cluster-key',['cluster','KmsKeyId'],'other'),('cluster-unencrypted',['cluster','Encrypted'],False),('multi-az',['cluster','MultiAZ'],'Enabled'),('nodes',['cluster','NumberOfNodes'],4),('cluster-type',['cluster','NodeType'],'other'),('routing',['cluster','EnhancedVpcRouting'],False),('retention',['cluster','AutomatedSnapshotRetentionPeriod'],0),('maintenance',['cluster','PreferredMaintenanceWindow'],'other'),('subnet-group',['cluster','ClusterSubnetGroupName'],'other'),('subnet-membership',['subnet_group','Subnets'],[]),('schedule-link',['cluster','SnapshotScheduleState'],'MODIFYING'),('schedule-def',['schedule','ScheduleDefinitions'],['rate(24 hours)']),('schedule-other-cluster',['schedule','AssociatedClusterCount'],2),('endpoint',['cluster','Endpoint','Port'],5432),('secret-link',['cluster','MasterPasswordSecretArn'],'other'),('secret-key',['cluster','MasterPasswordSecretKmsKeyId'],'other'),('secret-rotation',['secret','RotationEnabled'],False),('secret-deleted',['secret','DeletedDate'],'synthetic'),('secret-metadata-key',['secret','KmsKeyId'],'other'),('extra-group',['cluster','VpcSecurityGroups'],[]),('group-egress',['warehouse_group','IpPermissionsEgress'],[{'IpProtocol':'-1'}]),('group-public',['warehouse_group','IpPermissions',0,'IpRanges'],[{'CidrIp':'0.0.0.0/0'}]),('group-client',['warehouse_group','IpPermissions',0,'UserIdGroupPairs'],[]),('group-port',['warehouse_group','IpPermissions',0,'FromPort'],443),('parameters-pending',['cluster','ClusterParameterGroups',0,'ParameterApplyStatus'],'pending-reboot'),('ssl',['parameters',0,'ParameterValue'],'false'),('query-logging',['parameters',1,'ParameterValue'],'true'),('audit-disabled',['logging','LoggingEnabled'],False),('audit-query-export',['logging','LogExports'],['useractivitylog']),('audit-failure',['logging','LastFailureMessage'],'SYNTHETIC-DO-NOT-PRINT'),('log-key',['logs',0,'kmsKeyId'],'other'),('log-retention',['logs',0,'retentionInDays'],0)]
cases += [('after-create-headroom',[],None),('initial-headroom',[],None)]
for scenario,path,value in cases:
    data=copy.deepcopy(base)
    if path:
        parent=data
        for key in path[:-1]: parent=parent[key]
        parent[path[-1]]=value
    if scenario=='key-ids':
        data['cluster']['KmsKeyId']=config['kms'].split('/')[-1]; data['cluster']['MasterPasswordSecretKmsKeyId']=config['secretKms'].split('/')[-1]
    if scenario in ['after-create-headroom','initial-headroom']:
        for subnet in data['subnets']: subnet['AvailableIpAddressCount']=3
    failure=None; sys.argv=['INSPECT.py']+([] if scenario in ['preflight','initial-headroom'] else ['--check'])
    with contextlib.redirect_stdout(io.StringIO()) as output:
        try: runpy.run_path(str(root/'INSPECT.py'),run_name='__main__')
        except Exception as error: failure=error
    success=scenario in ['preflight','check','offering-page','parameter-page','key-ids','after-create-headroom']
    assert bool(failure)!=success,(scenario,failure)
    assert 'SYNTHETIC-DO-NOT-PRINT' not in output.getvalue()
    if success:
        report=json.loads(output.getvalue()); assert report['cluster_checked']==(scenario!='preflight') and not report['credentials_retrieved'] and not report['sql_executed'] and not report['log_contents_read']
print('Passed',len(cases),'generated provisioned Redshift metadata cases; no AWS, credentials, SQL or log-content access.')
`);
const check=spawnSync(process.env.PYTHON_PATH||'python',[join(work,'harness.py')],{cwd:work,encoding:'utf8',timeout:60000,windowsHide:true});
process.stdout.write(check.stdout||'');process.stderr.write(check.stderr||'');if(check.error)throw check.error;
console.log(work);process.exitCode=check.status??1;
