export const dsqlInspection=String.raw`import argparse
import json
import re
from pathlib import Path
import boto3
from botocore.config import Config

def require(condition,message):
    if not condition:
        raise RuntimeError(message)

def main():
    parser=argparse.ArgumentParser(description='Read-only DSQL/key/network/policy metadata, no SQL/tokens/data changes')
    parser.add_argument('--cluster',help='Exact Terraform cluster_id output')
    parser.add_argument('--endpoint',help='Exact Terraform connection_endpoint_id output')
    parser.add_argument('--peer-cluster',help='Multi-Region component only: exact peer cluster ID from the shared root outputs')
    parser.add_argument('--emit-policy-review',action='store_true',help='Print proposed actual-ID policy MERGE statements; does NOT apply a policy or certify authorization')
    args=parser.parse_args()
    require(bool(args.cluster)==bool(args.endpoint),'Supply both cluster and endpoint output IDs')
    require(not args.emit_policy_review or args.cluster,'Policy review requires exact deployed resource IDs')
    c=json.loads((Path(__file__).resolve().parent/'DSQL-CONFIG.json').read_text())
    require(not args.peer_cluster or (c.get('witnessRegion') and args.cluster),'Peer ID is only valid for a deployed multi-Region component')
    require(not (c.get('witnessRegion') and args.cluster) or (args.peer_cluster and re.fullmatch(r'[a-z0-9]{26}',args.peer_cluster)),'Multi-Region postcheck requires exact peer cluster ID')
    session=boto3.Session(region_name=c['region'])
    cfg=Config(use_fips_endpoint=True,retries={'mode':'standard','total_max_attempts':3})
    def client(name):
        return session.client(name,region_name=c['region'],config=cfg)
    require(client('sts').get_caller_identity()['Account']==c['account'],'Wrong AWS account')
    key=client('kms').describe_key(KeyId=c['kms'])['KeyMetadata']
    require(key.get('Arn')==c['kms'] and key.get('AWSAccountId')==c['account'] and key.get('KeyManager')=='CUSTOMER' and key.get('KeyState')=='Enabled' and key.get('KeySpec')=='SYMMETRIC_DEFAULT' and key.get('KeyUsage')=='ENCRYPT_DECRYPT','Wrong/unavailable customer symmetric key')
    require(client('iam').get_role(RoleName=c['roleName'])['Role'].get('Arn')==c['role'],'Application IAM role/account mismatch')
    ec2=client('ec2')
    subnets=ec2.describe_subnets(SubnetIds=c['subnets']).get('Subnets',[])
    require(len(subnets)==2 and {s.get('SubnetId') for s in subnets}==set(c['subnets']) and len({s.get('AvailabilityZoneId') for s in subnets})==2 and all(s.get('AvailabilityZoneId') for s in subnets),'Require exact two distinct-AZ subnets')
    vpcs={s.get('VpcId') for s in subnets}
    require(len(vpcs)==1 and None not in vpcs,'Subnets must share one VPC')
    vpc_id=next(iter(vpcs))
    for s in subnets:
        require(s.get('OwnerId')==c['account'] and s.get('State')=='available' and s.get('MapPublicIpOnLaunch') is False and not s.get('Ipv6Native') and not s.get('OutpostArn') and s.get('AvailableIpAddressCount',0)>=(3 if args.cluster else 4),'Wrong/public/unsupported subnet or insufficient address headroom')
    vpc=ec2.describe_vpcs(VpcIds=[vpc_id]).get('Vpcs',[])
    require(len(vpc)==1 and vpc[0].get('VpcId')==vpc_id and vpc[0].get('OwnerId')==c['account'] and vpc[0].get('State')=='available','Wrong/unavailable VPC')
    for attribute,key_name in [('enableDnsSupport','EnableDnsSupport'),('enableDnsHostnames','EnableDnsHostnames')]:
        require(ec2.describe_vpc_attribute(VpcId=vpc_id,Attribute=attribute).get(key_name,{}).get('Value') is True,'VPC DNS support/hostnames required')
    clients=ec2.describe_security_groups(GroupIds=c['clients']).get('SecurityGroups',[])
    require(len(clients)==len(c['clients']) and {g.get('GroupId') for g in clients}==set(c['clients']) and all(g.get('VpcId')==vpc_id and g.get('OwnerId')==c['account'] for g in clients),'Client group membership/owner/VPC mismatch')
    if not args.cluster:
        print('Owner/customer key/role/VPC/subnet/client metadata checked. Key grants, quotas, network/TLS/policy/SQL authorization, backups and data classification still require owner review.')
        return
    require(re.fullmatch(r'[a-z0-9]{26}',args.cluster) and re.fullmatch(r'vpce-(?:[0-9a-f]{8}|[0-9a-f]{17})',args.endpoint),'Use exact Terraform output IDs')
    dsql=client('dsql')
    cluster=dsql.get_cluster(identifier=args.cluster)
    arn='arn:aws:dsql:'+c['region']+':'+c['account']+':cluster/'+args.cluster
    require(cluster.get('identifier')==args.cluster and cluster.get('arn')==arn and cluster.get('status')=='ACTIVE' and cluster.get('deletionProtectionEnabled') is True,'Wrong/unready/unprotected cluster')
    encryption=cluster.get('encryptionDetails',{})
    require(encryption.get('encryptionType')=='CUSTOMER_MANAGED_KMS_KEY' and encryption.get('encryptionStatus')=='ENABLED' and encryption.get('kmsKeyArn')==c['kms'],'Cluster customer encryption not actually ENABLED with selected key')
    topology=cluster.get('multiRegionProperties') or {}
    if c.get('witnessRegion'):
        peer_arn='arn:aws:dsql:'+c['peerRegion']+':'+c['account']+':cluster/'+args.peer_cluster
        peers=topology.get('clusters',[])
        require(topology.get('witnessRegion')==c['witnessRegion'] and len(peers)==len(set(peers)) and set(peers)-{arn}=={peer_arn},'Multi-Region witness/peer association mismatch')
    else:
        require(not any(topology.values()),'Unexpected multi-Region/witness configuration')
    require(cluster.get('tags',{}).get('Name')==c['name'],'Cluster project tag mismatch')
    service=dsql.get_vpc_endpoint_service_name(identifier=args.cluster)['serviceName']
    require(re.fullmatch(r'com\.amazonaws\.'+re.escape(c['region'])+r'\.dsql-[a-z0-9]+',service),'Unexpected connection service format')
    endpoints=ec2.describe_vpc_endpoints(VpcEndpointIds=[args.endpoint]).get('VpcEndpoints',[])
    require(len(endpoints)==1,'Missing/duplicate connection endpoint')
    endpoint=endpoints[0]
    require(endpoint.get('VpcEndpointId')==args.endpoint and endpoint.get('OwnerId')==c['account'] and endpoint.get('VpcId')==vpc_id and endpoint.get('VpcEndpointType')=='Interface' and endpoint.get('State')=='available' and endpoint.get('ServiceName')==service and endpoint.get('PrivateDnsEnabled') is True and endpoint.get('RequesterManaged') is False,'Wrong/unavailable owner/private-DNS cluster connection endpoint')
    require(set(endpoint.get('SubnetIds',[]))==set(c['subnets']) and len(endpoint.get('SubnetIds',[]))==2 and len(endpoint.get('Groups',[]))==1,'Endpoint subnet/group membership mismatch')
    endpoint_group_id=endpoint['Groups'][0]['GroupId']
    groups=ec2.describe_security_groups(GroupIds=[endpoint_group_id]).get('SecurityGroups',[])
    require(len(groups)==1,'Missing endpoint group')
    group=groups[0]
    require(group.get('GroupId')==endpoint_group_id and group.get('OwnerId')==c['account'] and group.get('VpcId')==vpc_id and group.get('GroupName')==c['name']+'-connection' and not group.get('IpPermissionsEgress'),'Wrong endpoint group or unexpected egress')
    allowed=[]
    for rule in group.get('IpPermissions',[]):
        require(rule.get('IpProtocol') in ['tcp','6'] and rule.get('FromPort')==5432 and rule.get('ToPort')==5432 and not rule.get('IpRanges') and not rule.get('Ipv6Ranges') and not rule.get('PrefixListIds'),'Unexpected endpoint ingress/network ranges')
        for pair in rule.get('UserIdGroupPairs',[]):
            require(pair.get('UserId',c['account'])==c['account'] and not pair.get('VpcPeeringConnectionId'),'Cross-account/peered client reference outside scope')
            allowed.append(pair.get('GroupId'))
    require(len(allowed)==len(c['clients']) and set(allowed)==set(c['clients']),'Unexpected/missing endpoint client group rules')
    interfaces=endpoint.get('NetworkInterfaceIds',[])
    require(len(interfaces)==2 and len(set(interfaces))==2,'Missing/duplicate endpoint interfaces')
    nics=ec2.describe_network_interfaces(NetworkInterfaceIds=interfaces).get('NetworkInterfaces',[])
    require(len(nics)==2 and {n.get('NetworkInterfaceId') for n in nics}==set(interfaces) and {n.get('SubnetId') for n in nics}==set(c['subnets']),'Endpoint interface identity/subnet mismatch')
    require(all(n.get('OwnerId')==c['account'] and n.get('VpcId')==vpc_id and n.get('Status')=='in-use' and n.get('PrivateIpAddress') and not n.get('Association',{}).get('PublicIp') and [g.get('GroupId') for g in n.get('Groups',[])]==[endpoint_group_id] for n in nics),'Unexpected endpoint interface owner/IP/group')
    deny={'Sid':'DenyDatabaseConnectionsOutsideApprovedEndpoint','Effect':'Deny','Principal':'*','Action':['dsql:DbConnect','dsql:DbConnectAdmin'],'Resource':arn,'Condition':{'StringNotEquals':{'aws:SourceVpce':args.endpoint}}}
    app_policy={'Version':'2012-10-17','Statement':[{'Effect':'Allow','Action':'dsql:DbConnect','Resource':arn,'Condition':{'StringEquals':{'aws:SourceVpce':args.endpoint}}}]}
    hostname=args.cluster+'.'+service.split('.')[-1]+'.'+c['region']+'.on.aws'
    if args.emit_policy_review:
        print(json.dumps({'clusterPolicyMERGEOnly':{'Version':'2012-10-17','Statement':[deny]},'applicationIdentityPolicyREVIEWOnly':app_policy,'existingApplicationRole':c['role'],'privateDatabaseHostname':hostname,'authorizationProven':False},indent=2))
        return
    policy=dsql.get_cluster_policy(identifier=args.cluster)
    require(policy.get('policyVersion') and deny in json.loads(policy['policy']).get('Statement',[]),'Exact approved endpoint deny boundary missing; emit/review/merge policy before grants/data')
    print(json.dumps({'clusterActive':True,'customerEncryptionEnabled':True,'connectionEndpointAvailable':True,'privateDatabaseHostname':hostname,'networkPolicyVersion':policy['policyVersion'],'authorizationProven':False,'dataIntegrityProven':False,'ownerSqlAndTrafficTestsRequired':True},sort_keys=True))

if __name__=='__main__':
    main()
`;

export const dsqlConnectionCheck=String.raw`import argparse
import json
import re
from pathlib import Path
import boto3
from botocore.config import Config
import psycopg

def main():
    parser=argparse.ArgumentParser(description='Explicit owner-approved application-role TLS/SQL identity check only')
    parser.add_argument('--hostname',required=True,help='Exact private_database_hostname Terraform output')
    parser.add_argument('--ca',required=True,help='Approved local CA bundle for TLS verify-full')
    parser.add_argument('--confirm-approved-connect',action='store_true')
    args=parser.parse_args()
    if not args.confirm_approved_connect:
        raise RuntimeError('Requires owner-approved network/policy/SQL authorization and --confirm-approved-connect; no connection attempted')
    c=json.loads((Path(__file__).resolve().parent/'DSQL-CONFIG.json').read_text())
    if not re.fullmatch(r'[a-z0-9]{26}\.dsql-[a-z0-9]+\.'+re.escape(c['region'])+r'\.on\.aws',args.hostname):
        raise RuntimeError('Use exact verified cluster-cell private hostname, not a generic/public/third-party host')
    ca=Path(args.ca).resolve()
    if not ca.is_file():
        raise RuntimeError('Approved CA bundle missing')
    session=boto3.Session(region_name=c['region'])
    cfg=Config(use_fips_endpoint=True,retries={'mode':'standard','total_max_attempts':3})
    caller=session.client('sts',region_name=c['region'],config=cfg).get_caller_identity()
    if caller.get('Account')!=c['account'] or not re.fullmatch(r'arn:aws:sts::'+c['account']+r':assumed-role/'+re.escape(c['roleName'])+r'/[^/]+',caller.get('Arn','')):
        raise RuntimeError('Assume the exact approved application IAM role first; admin/user identity is not accepted')
    try:
        client=session.client('dsql',region_name=c['region'],config=cfg)
        token=client.generate_db_connect_auth_token(Hostname=args.hostname,Region=c['region'],ExpiresIn=900)
        with psycopg.connect(host=args.hostname,dbname='postgres',user=c['dbRole'],password=token,sslmode='verify-full',sslrootcert=str(ca),connect_timeout=10,autocommit=True,application_name=c['name']) as connection:
            result=connection.execute('SELECT current_user, current_database()').fetchone()
            if result!=(c['dbRole'],'postgres'):
                raise RuntimeError('Unexpected database role/database')
        token=None
    except Exception:
        raise RuntimeError('Application connection/identity check failed; token/raw connection error suppressed. Inspect diagnostics only within the approved protected boundary.') from None
    print(json.dumps({'applicationRoleConnectionValidated':True,'database':'postgres','tlsMode':'verify-full','applicationDataMigrated':False,'networkPolicyProven':False},sort_keys=True))

if __name__=='__main__':
    main()
`;
