export const ontapInspection=String.raw`#!/usr/bin/env python3
"""Read FSx/EC2/KMS metadata only. Never retrieves admin credentials or ONTAP data."""
import argparse,ipaddress,json,re,sys
from pathlib import Path
import boto3
from botocore.config import Config
def require(ok,message):
    if not ok: raise ValueError(message)
def main():
    parser=argparse.ArgumentParser()
    for name in ['filesystem','svm','volume']: parser.add_argument('--'+name)
    args=parser.parse_args();post=bool(args.filesystem or args.svm or args.volume)
    require(not post or all([args.filesystem,args.svm,args.volume]),'Supply all three exact resource IDs for postchecks')
    if post:
        for value,pattern in [(args.filesystem,r'fs-[a-f0-9]{8,17}'),(args.svm,r'svm-[a-f0-9]{17}'),(args.volume,r'fsvol-[a-f0-9]{17}')]: require(re.fullmatch(pattern,value),'Invalid resource ID')
    c=json.loads(Path(__file__).with_name('ONTAP-CONFIG.json').read_text())
    session=boto3.Session(region_name=c['region']);cfg=Config(use_fips_endpoint=True,retries={'mode':'standard','max_attempts':3})
    clients={name:session.client(name,config=cfg) for name in ['sts','ec2','kms','fsx']}
    require(clients['sts'].get_caller_identity()['Account']==c['account'],'Wrong expected owner account')
    ec2=clients['ec2'];fsx=clients['fsx'];subnets=ec2.describe_subnets(SubnetIds=c['subnets'])['Subnets']
    require(len(subnets)==len(c['subnets']) and {s['SubnetId'] for s in subnets}==set(c['subnets']),'Subnet inventory mismatch')
    vpcs={s['VpcId'] for s in subnets};require(len(vpcs)==1,'Subnets must share one owned VPC');vpc=next(iter(vpcs))
    require(len({s['AvailabilityZoneId'] for s in subnets})==(2 if c['multi'] else 1),'Subnet AZ placement mismatch')
    for s in subnets:
        require(s.get('OwnerId')==c['account'] and s.get('State')=='available' and not s.get('MapPublicIpOnLaunch') and not s.get('Ipv6Native') and s.get('AvailableIpAddressCount',0)>=6 and not s.get('OutpostArn'),'Private regional subnet owner/health/IP planning floor mismatch')
    v=ec2.describe_vpcs(VpcIds=[vpc])['Vpcs'];require(len(v)==1 and v[0].get('OwnerId')==c['account'] and v[0].get('State')=='available','VPC owner/state mismatch')
    for attr,response_key in [('enableDnsSupport','EnableDnsSupport'),('enableDnsHostnames','EnableDnsHostnames')]: require(ec2.describe_vpc_attribute(VpcId=vpc,Attribute=attr).get(response_key,{}).get('Value') is True,'VPC DNS must be enabled')
    groups=set(c['clients']+c['admins']);actual=ec2.describe_security_groups(GroupIds=sorted(groups))['SecurityGroups']
    require(len(actual)==len(groups) and {g['GroupId'] for g in actual}==groups and all(g.get('OwnerId')==c['account'] and g.get('VpcId')==vpc for g in actual),'Client/admin group ownership mismatch')
    if c['multi']:
        endpoint=ipaddress.ip_network(c['endpointCidr'],strict=True);token=None;seen=set()
        for page in range(100):
            request={'Filters':[{'Name':'vpc-id','Values':[vpc]}],'MaxResults':1000}
            if token: request['NextToken']=token
            response=ec2.describe_subnets(**request)
            for s in response.get('Subnets',[]): require(not endpoint.overlaps(ipaddress.ip_network(s['CidrBlock'])),'Floating endpoint range overlaps an existing VPC subnet')
            token=response.get('NextToken')
            if not token: break
            require(token not in seen,'Repeated VPC subnet pagination token');seen.add(token)
        else: raise ValueError('VPC subnet pagination limit exceeded')
        routes=ec2.describe_route_tables(RouteTableIds=c['routes'])['RouteTables']
        require(len(routes)==len(c['routes']) and {r['RouteTableId'] for r in routes}==set(c['routes']) and all(r.get('OwnerId')==c['account'] and r.get('VpcId')==vpc for r in routes),'Route table ownership mismatch')
        # Existing endpoint route conflicts/remote propagation require independent owner review.
    if c['kms']:
        k=clients['kms'].describe_key(KeyId=c['kms'])['KeyMetadata']
        require(k.get('Arn')==c['kms'] and k.get('KeyState')=='Enabled' and k.get('KeySpec')=='SYMMETRIC_DEFAULT' and k.get('KeyUsage')=='ENCRYPT_DECRYPT','Selected symmetric key metadata mismatch')
        # Cross-account customer keys require independent grants/policy review; original form permits them.
    if not post:
        token=None;seen=set()
        for page in range(100):
            request={'MaxResults':100}
            if token: request['NextToken']=token
            response=fsx.describe_file_systems(**request)
            require(not any(any(t['Key']=='Name' and t['Value']==c['name'] for t in f.get('Tags',[])) for f in response.get('FileSystems',[])),'Filesystem name already exists; reconcile before creation')
            token=response.get('NextToken')
            if not token: break
            require(token not in seen,'Repeated filesystem pagination token');seen.add(token)
        else: raise ValueError('Filesystem pagination limit exceeded')
    else:
        rows=fsx.describe_file_systems(FileSystemIds=[args.filesystem])['FileSystems'];require(len(rows)==1,'Expected exactly one filesystem');f=rows[0]
        prefix='arn:'+c['partition']+':fsx:'+c['region']+':'+c['account']+':'
        require(f.get('FileSystemId')==args.filesystem and f.get('ResourceARN')==prefix+'file-system/'+args.filesystem and f.get('OwnerId')==c['account'] and f.get('FileSystemType')=='ONTAP' and f.get('Lifecycle')=='AVAILABLE','Filesystem identity/owner/lifecycle mismatch')
        require(f.get('VpcId')==vpc and set(f.get('SubnetIds',[]))==set(c['subnets']) and f.get('StorageCapacity')==c['storage'] and f.get('StorageType')=='SSD','Filesystem network/capacity mismatch')
        if c['kms']: require(f.get('KmsKeyId')==c['kms'],'Filesystem key mismatch')
        o=f['OntapConfiguration']
        require(o.get('DeploymentType')==c['deployment'] and o.get('HAPairs',1)==1 and o.get('ThroughputCapacityPerHAPair',o.get('ThroughputCapacity'))==c['throughput'] and o.get('AutomaticBackupRetentionDays')==c['retention'] and o.get('PreferredSubnetId')==c['subnets'][0],'ONTAP topology/throughput/backup mismatch')
        require(o.get('DiskIopsConfiguration',{}).get('Mode')=='AUTOMATIC','Unexpected SSD IOPS mode')
        require(not any(a.get('Status') not in ['COMPLETED','UPDATED_OPTIMIZING'] for a in f.get('AdministrativeActions',[])),'Pending/failed filesystem change requires reconciliation')
        nics=f.get('NetworkInterfaceIds',[]);require(nics and len(nics)==len(set(nics)),'Expected unique actual filesystem interfaces')
        interfaces=ec2.describe_network_interfaces(NetworkInterfaceIds=nics)['NetworkInterfaces']
        require(len(interfaces)==len(nics) and {n['NetworkInterfaceId'] for n in interfaces}==set(nics) and all(n.get('OwnerId')==c['account'] and n.get('VpcId')==vpc and n.get('Status')=='in-use' and n.get('SubnetId') in c['subnets'] and not n.get('Association',{}).get('PublicIp') for n in interfaces),'Filesystem interface network mismatch')
        attached={g['GroupId'] for n in interfaces for g in n.get('Groups',[])};require(len(attached)==1,'Expected exactly the generated filesystem security group')
        generated=ec2.describe_security_groups(GroupIds=sorted(attached))['SecurityGroups'];require(len(generated)==1,'Missing filesystem security group');g=generated[0]
        require(g.get('OwnerId')==c['account'] and g.get('VpcId')==vpc and g.get('GroupName')==c['name']+'-ontap' and not g.get('IpPermissionsEgress'),'Unexpected filesystem group owner/name/egress')
        expected={(2049,identifier) for identifier in c['clients']}|{(port,identifier) for port in [22,443] for identifier in c['admins']};actual=set()
        for rule in g.get('IpPermissions',[]):
            require(rule.get('IpProtocol')=='tcp' and rule.get('FromPort')==rule.get('ToPort') and not any(rule.get(k) for k in ['IpRanges','Ipv6Ranges','PrefixListIds']),'Unexpected filesystem group ingress')
            for pair in rule.get('UserIdGroupPairs',[]):
                require(pair.get('UserId')==c['account'],'Unexpected ingress group owner');actual.add((rule['FromPort'],pair['GroupId']))
        require(actual==expected,'Filesystem group grants differ from approved client/admin groups')
        if c['multi']: require(set(o.get('RouteTableIds',[]))==set(c['routes']) and o.get('EndpointIpAddressRange')==c['endpointCidr'],'Floating endpoint/routes mismatch')
        srows=fsx.describe_storage_virtual_machines(StorageVirtualMachineIds=[args.svm])['StorageVirtualMachines'];require(len(srows)==1,'Expected exactly one SVM');s=srows[0]
        require(s.get('StorageVirtualMachineId')==args.svm and s.get('FileSystemId')==args.filesystem and s.get('ResourceARN')==prefix+'storage-virtual-machine/'+args.filesystem+'/'+args.svm and s.get('Name')==c['svm'] and s.get('Lifecycle')=='CREATED' and s.get('RootVolumeSecurityStyle')=='UNIX' and not s.get('ActiveDirectoryConfiguration'),'SVM identity/lifecycle/security style mismatch')
        require(s.get('Endpoints',{}).get('Nfs',{}).get('DNSName'),'Missing actual NFS endpoint')
        rows=fsx.describe_volumes(VolumeIds=[args.volume])['Volumes'];require(len(rows)==1,'Expected exactly one volume');v=rows[0];ov=v['OntapConfiguration']
        require(v.get('VolumeId')==args.volume and v.get('ResourceARN')==prefix+'volume/'+args.filesystem+'/'+args.volume and v.get('FileSystemId')==args.filesystem and v.get('VolumeType')=='ONTAP' and v.get('Name')==c['volume'] and v.get('Lifecycle')=='CREATED','Volume identity/lifecycle mismatch')
        require(ov.get('StorageVirtualMachineId')==args.svm and ov.get('JunctionPath')=='/'+c['volume'] and ov.get('SizeInMegabytes')==c['volumeGib']*1024 and ov.get('SecurityStyle')=='UNIX' and ov.get('OntapVolumeType')=='RW' and ov.get('VolumeStyle')=='FLEXVOL' and ov.get('StorageEfficiencyEnabled') is True and ov.get('SnapshotPolicy')=='default' and ov.get('TieringPolicy',{}).get('Name')=='NONE' and not ov.get('SnaplockConfiguration'),'Volume configuration mismatch')
    print(json.dumps({'metadataVerified':True,'phase':'post-deployment' if post else 'preflight','expectedAccount':c['account'],'vpc':vpc,'ontapExportsConfiguredProven':False,'protocolAuthenticationProven':False,'dataIntegrityProven':False,'restoreFailoverProven':False,'ownerNetworkPolicyAndRecoveryReviewRequired':True},sort_keys=True))
if __name__=='__main__':
    try: main()
    except Exception:
        print('ONTAP metadata check failed. Review approved configuration and read permissions; no credentials, ONTAP writes, mounts or data operations were requested.',file=sys.stderr);sys.exit(1)
`;
