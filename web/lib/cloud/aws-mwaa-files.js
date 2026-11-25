export const mwaaInspection=String.raw`import argparse
import json
from pathlib import Path
import boto3
from botocore.config import Config

def require(condition, message):
    if not condition:
        raise RuntimeError(message)

def main():
    parser = argparse.ArgumentParser(description='Read-only MWAA stage inspection; no object bodies, tokens, logs or tasks')
    parser.add_argument('--check', action='store_true', help='Compare the deployed environment and encrypted log groups')
    args = parser.parse_args()
    c = json.loads((Path(__file__).resolve().parent/'MWAA-CONFIG.json').read_text())
    session = boto3.Session(region_name=c['region'])
    cfg = Config(use_fips_endpoint=True, retries={'mode':'standard','total_max_attempts':3})
    def client(name):
        return session.client(name, region_name=c['region'], config=cfg)
    require(client('sts').get_caller_identity()['Account'] == c['account'], 'Wrong AWS account')
    s3 = client('s3')
    bucket_args = {'Bucket':c['bucket'],'ExpectedBucketOwner':c['account']}
    s3.head_bucket(**bucket_args)
    require((s3.get_bucket_location(**bucket_args).get('LocationConstraint') or 'us-east-1') == c['region'], 'Wrong source bucket region')
    require(s3.get_bucket_versioning(**bucket_args).get('Status') == 'Enabled', 'Source bucket versioning required')
    blocks = s3.get_public_access_block(**bucket_args).get('PublicAccessBlockConfiguration',{})
    require(all(blocks.get(k) is True for k in ['BlockPublicAcls','IgnorePublicAcls','BlockPublicPolicy','RestrictPublicBuckets']), 'Require all source bucket public-access blocks')
    # Empty prefix remains required for this first-stage inspection, including postcheck.
    objects = s3.list_objects_v2(**bucket_args, Prefix=c['prefix'], MaxKeys=2)
    require(all(o.get('Key') == c['prefix'] and o.get('Size') == 0 for o in objects.get('Contents',[])) and not objects.get('IsTruncated'), 'DAG prefix is not empty; executable-code publication needs separate owner review')
    kms = client('kms')
    def key_arn(identifier):
        key = kms.describe_key(KeyId=identifier)['KeyMetadata']
        require(key.get('AWSAccountId') == c['account'] and key.get('KeyManager') == 'CUSTOMER' and key.get('KeyState') == 'Enabled' and key.get('KeyUsage') == 'ENCRYPT_DECRYPT' and key.get('KeySpec') == 'SYMMETRIC_DEFAULT' and key.get('Arn') == c['kms'], 'Wrong/disabled/noncustomer/asymmetric key')
        return key['Arn']
    key_arn(c['kms'])
    encryption = s3.get_bucket_encryption(**bucket_args).get('ServerSideEncryptionConfiguration',{}).get('Rules',[])
    require(len(encryption) == 1, 'Require one source bucket default encryption rule')
    default = encryption[0].get('ApplyServerSideEncryptionByDefault',{})
    require(default.get('SSEAlgorithm') == 'aws:kms', 'Require source bucket SSE-KMS for this initial same-key workflow')
    key_arn(default.get('KMSMasterKeyID',''))
    role = client('iam').get_role(RoleName=c['role'])['Role']
    require(role.get('RoleName') == c['role'] and role.get('Arn','').startswith('arn:aws:iam::'+c['account']+':role/'), 'Wrong role/account')
    trust = role.get('AssumeRolePolicyDocument',{})
    if isinstance(trust, str):
        from urllib.parse import unquote
        trust = json.loads(unquote(trust))
    statements = trust.get('Statement',[])
    require(isinstance(statements,list) and len(statements) == 1, 'Dedicated role requires exactly one reviewed trust statement')
    statement = statements[0]
    services = statement.get('Principal',{}).get('Service',[])
    services = [services] if isinstance(services,str) else services
    action = statement.get('Action',[])
    action = [action] if isinstance(action,str) else action
    require(statement.get('Effect') == 'Allow' and set(action) == {'sts:AssumeRole'} and set(services) == {'airflow.amazonaws.com','airflow-env.amazonaws.com'} and set(statement.get('Principal',{})) == {'Service'} and 'NotPrincipal' not in statement, 'Unexpected role trust; effective conditions/permissions still owner-reviewed')
    ec2 = client('ec2')
    groups = ec2.describe_security_groups(GroupIds=[c['group']]).get('SecurityGroups',[])
    require(len(groups) == 1, 'Missing/duplicate group')
    group = groups[0]
    require(group.get('GroupId') == c['group'] and group.get('OwnerId') == c['account'], 'Wrong group owner/identity')
    vpcs = ec2.describe_vpcs(VpcIds=[group['VpcId']]).get('Vpcs',[])
    require(len(vpcs) == 1 and vpcs[0].get('VpcId') == group['VpcId'] and vpcs[0].get('OwnerId') == c['account'] and vpcs[0].get('State') == 'available', 'Wrong/unavailable VPC')
    for attribute,key in [('enableDnsSupport','EnableDnsSupport'),('enableDnsHostnames','EnableDnsHostnames')]:
        require(ec2.describe_vpc_attribute(VpcId=group['VpcId'],Attribute=attribute).get(key,{}).get('Value') is True, 'VPC DNS support/hostnames required')
    subnets = ec2.describe_subnets(SubnetIds=c['subnets']).get('Subnets',[])
    require(len(subnets) == 2 and {s.get('SubnetId') for s in subnets} == set(c['subnets']) and len({s.get('AvailabilityZoneId') for s in subnets}) == 2 and all(s.get('AvailabilityZoneId') for s in subnets), 'Require exact two distinct-AZ subnets')
    for s in subnets:
        require(s.get('OwnerId') == c['account'] and s.get('VpcId') == group['VpcId'] and s.get('State') == 'available' and s.get('MapPublicIpOnLaunch') is False and not s.get('Ipv6Native') and not s.get('OutpostArn') and s.get('AvailableIpAddressCount',0) >= (3 if args.check else 16), 'Wrong/public/unsupported subnet or insufficient address headroom')
    # Read route metadata to reject direct IGW routes. NAT/private endpoint readiness still needs owner tests.
    for s in subnets:
        tables = ec2.describe_route_tables(Filters=[{'Name':'association.subnet-id','Values':[s['SubnetId']]}]).get('RouteTables',[])
        if not tables:
            tables = ec2.describe_route_tables(Filters=[{'Name':'vpc-id','Values':[group['VpcId']]},{'Name':'association.main','Values':['true']}]).get('RouteTables',[])
        require(len(tables) == 1 and tables[0].get('VpcId') == group['VpcId'], 'Missing/ambiguous actual subnet route table')
        require(all(not str(r.get('GatewayId','')).startswith('igw-') and not r.get('EgressOnlyInternetGatewayId') for r in tables[0].get('Routes',[])), 'Direct internet gateway route is outside this private IPv4 workflow')
    self_rules = [r for r in group.get('IpPermissions',[]) if r.get('IpProtocol') == '-1' and any(p.get('GroupId') == c['group'] for p in r.get('UserIdGroupPairs',[]))]
    require(self_rules, 'Require MWAA self-referencing ingress; all other rules/egress/effective NACLs remain owner-reviewed')
    logs = client('logs')
    def exact_log(name):
        matches, token, seen = [], None, set()
        for _ in range(100):
            page = logs.describe_log_groups(logGroupNamePrefix=name, **({'nextToken':token} if token else {}))
            matches += [g for g in page.get('logGroups',[]) if g.get('logGroupName') == name]
            token = page.get('nextToken')
            if not token:
                return matches
            require(token not in seen, 'Repeated log pagination token')
            seen.add(token)
        raise RuntimeError('Log pagination incomplete')
    mwaa = client('mwaa')
    if not args.check:
        token, seen = None, set()
        for _ in range(100):
            page = mwaa.list_environments(MaxResults=25, **({'NextToken':token} if token else {}))
            require(c['name'] not in page.get('Environments',[]), 'Environment name already exists; this package creates a new environment only')
            token = page.get('NextToken')
            if not token:
                break
            require(token not in seen, 'Repeated environment pagination token')
            seen.add(token)
        else:
            raise RuntimeError('Environment pagination incomplete')
        for suffix in ['DAGProcessing','Scheduler','Task','WebServer','Worker']:
            require(not exact_log('airflow-'+c['name']+'-'+suffix), 'Log namespace already exists; do not overwrite/import shared logs')
        print('Owner/empty-prefix/role-trust/key/private-network metadata checked. Service endpoint/egress/role/key/bucket policies, image offering and authorization still require owner review.')
        return
    e = mwaa.get_environment(Name=c['name'])['Environment']
    expected = {'Name':c['name'],'Arn':'arn:aws:airflow:'+c['region']+':'+c['account']+':environment/'+c['name'],'Status':'AVAILABLE','AirflowVersion':c['version'],'EnvironmentClass':c['size'],'SourceBucketArn':'arn:aws:s3:::'+c['bucket'],'DagS3Path':c['prefix'],'ExecutionRoleArn':role['Arn'],'WebserverAccessMode':'PRIVATE_ONLY','EndpointManagement':'SERVICE','MinWorkers':c['min'],'MaxWorkers':c['max'],'Schedulers':2,'MinWebservers':2,'MaxWebservers':2,'WeeklyMaintenanceWindowStart':c['maintenance']}
    for field,value in expected.items():
        require(e.get(field) == value, 'Environment mismatch: '+field)
    key_arn(e.get('KmsKey',''))
    network = e.get('NetworkConfiguration',{})
    require(set(network.get('SubnetIds',[])) == set(c['subnets']) and len(network.get('SubnetIds',[])) == 2 and network.get('SecurityGroupIds') == [c['group']], 'Environment network mismatch')
    require(not e.get('LastUpdate',{}).get('Error') and e.get('LastUpdate',{}).get('Status','SUCCESS') == 'SUCCESS', 'Environment update not clean')
    require(all(not e.get(field) for field in ['PluginsS3Path','PluginsS3ObjectVersion','RequirementsS3Path','RequirementsS3ObjectVersion','StartupScriptS3Path','StartupScriptS3ObjectVersion']), 'Unexpected executable package/startup configuration')
    options = e.get('AirflowConfigurationOptions',{})
    require(set(options) == {'core.dags_are_paused_at_creation','core.load_examples'} and str(options['core.dags_are_paused_at_creation']).lower() == 'true' and str(options['core.load_examples']).lower() == 'false', 'Unexpected Airflow options')
    for category,suffix in [('DagProcessingLogs','DAGProcessing'),('SchedulerLogs','Scheduler'),('TaskLogs','Task'),('WebserverLogs','WebServer'),('WorkerLogs','Worker')]:
        entry = e.get('LoggingConfiguration',{}).get(category,{})
        name = 'airflow-'+c['name']+'-'+suffix
        arn = 'arn:aws:logs:'+c['region']+':'+c['account']+':log-group:'+name
        require(entry.get('Enabled') is True and entry.get('LogLevel') == 'INFO' and entry.get('CloudWatchLogGroupArn') in [arn,arn+':*'], 'Environment logging mismatch: '+category)
        groups = exact_log(name)
        require(len(groups) == 1 and groups[0].get('arn') in [arn,arn+':*'] and groups[0].get('retentionInDays') == c['retention'] and groups[0].get('kmsKeyId') == c['kms'], 'Actual log group key/retention/identity mismatch')
    print('Exact AVAILABLE empty-prefix MWAA environment/log metadata checked. No token, log body, S3 code upload/read, task or service mutation; runtime/IAM/transport/approval still owner-tested.')

if __name__ == '__main__':
    main()
`;
