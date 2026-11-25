export const storageGatewayInspection=String.raw`import argparse
import ipaddress
import json
import re
from pathlib import Path
import boto3
from botocore.config import Config

def require(condition, message):
    if not condition:
        raise RuntimeError(message)

def main():
    parser = argparse.ArgumentParser(description='Read-only S3 File Gateway metadata inspection; no file or object bodies')
    parser.add_argument('--share', help='Exact Terraform file_share_arn output after apply')
    args = parser.parse_args()
    c = json.loads((Path(__file__).resolve().parent/'FILESHARE-CONFIG.json').read_text())
    session = boto3.Session(region_name=c['region'])
    cfg = Config(use_fips_endpoint=True, retries={'mode':'standard','total_max_attempts':3})
    def client(name):
        return session.client(name, region_name=c['region'], config=cfg)
    require(client('sts').get_caller_identity()['Account'] == c['account'], 'Wrong AWS account')
    sg = client('storagegateway')
    gateway = sg.describe_gateway_information(GatewayARN=c['gateway'])
    require(gateway.get('GatewayARN') == c['gateway'] and gateway.get('GatewayType') == 'FILE_S3' and gateway.get('GatewayState') == 'STATE_RUNNING' and gateway.get('EndpointType') == 'FIPS', 'Require exact running S3 File Gateway with FIPS metadata')
    private = [ipaddress.ip_network(n) for n in ['10.0.0.0/8','172.16.0.0/12','192.168.0.0/16']]
    interfaces = gateway.get('GatewayNetworkInterfaces', [])
    require(interfaces and all(i.get('Ipv4Address') and any(ipaddress.ip_address(i['Ipv4Address']) in network for network in private) and not i.get('Ipv6Address') for i in interfaces), 'Require reviewed private IPv4 gateway NICs')
    cache = sg.describe_cache(GatewayARN=c['gateway'])
    require(cache.get('GatewayARN') == c['gateway'] and cache.get('DiskIds') and cache.get('CacheAllocatedInBytes',0) > 0, 'Require existing allocated gateway cache; capacity/disk health still owner-validated')
    s3 = client('s3')
    bucket_args = {'Bucket':c['bucket'],'ExpectedBucketOwner':c['account']}
    s3.head_bucket(**bucket_args)
    location = s3.get_bucket_location(**bucket_args).get('LocationConstraint') or 'us-east-1'
    require(location == c['region'], 'Bucket region mismatch')
    require(s3.get_bucket_versioning(**bucket_args).get('Status') == 'Enabled', 'Bucket versioning required for owner recovery procedure')
    blocks = s3.get_public_access_block(**bucket_args).get('PublicAccessBlockConfiguration',{})
    require(all(blocks.get(k) is True for k in ['BlockPublicAcls','IgnorePublicAcls','BlockPublicPolicy','RestrictPublicBuckets']), 'Require all bucket public-access blocks')
    ownership = s3.get_bucket_ownership_controls(**bucket_args).get('OwnershipControls',{}).get('Rules',[])
    require(len(ownership) == 1 and ownership[0].get('ObjectOwnership') == 'BucketOwnerEnforced', 'Require bucket-owner-enforced ownership')
    rules = s3.get_bucket_encryption(**bucket_args).get('ServerSideEncryptionConfiguration',{}).get('Rules',[])
    require(len(rules) == 1, 'Require one bucket default encryption rule')
    encryption = rules[0].get('ApplyServerSideEncryptionByDefault',{})
    require(encryption.get('SSEAlgorithm') == 'aws:kms', 'Require SSE-KMS, not SSE-S3 or DSSE in this provider5 workflow')
    kms = client('kms')
    def check_key(identifier):
        key = kms.describe_key(KeyId=identifier)['KeyMetadata']
        require(key.get('AWSAccountId') == c['account'] and key.get('KeyManager') == 'CUSTOMER' and key.get('KeyState') == 'Enabled' and key.get('KeyUsage') == 'ENCRYPT_DECRYPT' and key.get('KeySpec') == 'SYMMETRIC_DEFAULT', 'Require enabled owner customer symmetric key')
        require(key.get('Arn','').startswith('arn:aws:kms:'+c['region']+':'+c['account']+':key/'), 'Wrong key region/owner')
        return key['Arn']
    require(check_key(c['kms']) == c['kms'] and check_key(encryption.get('KMSMasterKeyID','')) == c['kms'], 'Bucket and share key mismatch')
    logs = client('logs')
    groups, token, seen = [], None, set()
    for _ in range(100):
        page = logs.describe_log_groups(logGroupNamePrefix=c['audit'], **({'nextToken':token} if token else {}))
        groups += [g for g in page.get('logGroups',[]) if g.get('logGroupName') == c['audit']]
        token = page.get('nextToken')
        if not token:
            break
        require(token not in seen, 'Repeated log pagination token')
        seen.add(token)
    else:
        raise RuntimeError('Log metadata pagination incomplete')
    require(len(groups) == 1, 'Require exact existing audit log group')
    audit = groups[0]
    audit_arn = 'arn:aws:logs:'+c['region']+':'+c['account']+':log-group:'+c['audit']
    require(audit.get('arn') in [audit_arn,audit_arn+':*'] and audit.get('retentionInDays',0) >= 30 and audit.get('kmsKeyId'), 'Wrong/unretained/unencrypted audit group')
    check_key(audit['kmsKeyId'])
    # Scan metadata for all shares in this account/region, not just the selected gateway.
    shares, marker, seen = [], None, set()
    for _ in range(100):
        page = sg.list_file_shares(Limit=100, **({'Marker':marker} if marker else {}))
        shares += page.get('FileShareInfoList',[])
        marker = page.get('NextMarker')
        if not marker:
            break
        require(marker not in seen, 'Repeated share pagination marker')
        seen.add(marker)
    else:
        raise RuntimeError('Share metadata pagination incomplete')
    target = 'arn:aws:s3:::'+c['bucket']+'/'+c['prefix']
    selected = None
    for item in shares:
        share_arn = item.get('FileShareARN')
        require(share_arn, 'Missing share ARN')
        if item.get('FileShareType') == 'NFS':
            info = sg.describe_nfs_file_shares(FileShareARNList=[share_arn]).get('NFSFileShareInfoList',[])
        elif item.get('FileShareType') == 'SMB':
            info = sg.describe_smb_file_shares(FileShareARNList=[share_arn]).get('SMBFileShareInfoList',[])
        else:
            raise RuntimeError('Unsupported existing share type; independent overlap review required')
        require(len(info) == 1 and info[0].get('FileShareARN') == share_arn, 'Incomplete share metadata')
        share = info[0]
        require(re.fullmatch(r'arn:aws:s3:::[a-z0-9][a-z0-9.-]{1,61}[a-z0-9](?:/.*)?', share.get('LocationARN','')) is not None, 'Existing access-point/alias/unknown location needs independent overlap review')
        if args.share and share_arn == args.share:
            require(selected is None and item['FileShareType'] == 'NFS', 'Duplicate/wrong selected share')
            selected = share
            continue
        source = share.get('LocationARN','').rstrip('/')+'/'
        require(share.get('LocationARN'), 'Unknown existing location needs overlap review')
        require(not target.startswith(source) and not source.startswith(target), 'Existing NFS/SMB share overlaps selected bucket/prefix')
    if not args.share:
        print('Owner/gateway/cache/bucket/key/log metadata and account-region share overlap checked. External writers, policies, transport and application behavior need owner review.')
        return
    require(re.fullmatch(r'arn:aws:storagegateway:'+c['region']+':'+c['account']+r':share/share-[0-9A-Fa-f]{8,17}', args.share) is not None and selected is not None, 'Supply exact existing output share ARN')
    s = selected
    expected = {'GatewayARN':c['gateway'],'LocationARN':target,'Role':'arn:aws:iam::'+c['account']+':role/'+c['role'],'FileShareName':c['name'],'FileShareStatus':'AVAILABLE','KMSEncrypted':True,'AuditDestinationARN':audit_arn,'ReadOnly':c['mode']=='READ_ONLY','Squash':c['squash'],'DefaultStorageClass':c['storage'],'ObjectACL':'bucket-owner-full-control','RequesterPays':False,'GuessMIMETypeEnabled':False}
    for key, value in expected.items():
        actual = s.get(key)
        if key == 'AuditDestinationARN' and actual == audit_arn+':*':
            actual = audit_arn
        require(actual == value, 'Share metadata mismatch: '+key)
    require(check_key(s.get('KMSKey','')) == c['kms'], 'Share key mismatch')
    require(set(s.get('ClientList',[])) == set(c['clients']) and len(s.get('ClientList',[])) == len(c['clients']), 'Share client mismatch')
    require(s.get('CacheAttributes',{}).get('CacheStaleTimeoutInSeconds') == c['ttl'], 'Share cache TTL mismatch')
    defaults = s.get('NFSFileShareDefaults',{})
    require(defaults.get('OwnerId') == c['uid'] and defaults.get('GroupId') == c['gid'] and defaults.get('FileMode') == c['fileMode'] and defaults.get('DirectoryMode') == c['directoryMode'], 'Share default identity/mode mismatch')
    require(not s.get('VPCEndpointDNSName') and s.get('EncryptionType','SseKms') == 'SseKms' and json.loads(s.get('NotificationPolicy') or '{}') == {}, 'Unexpected endpoint/encryption/notification configuration')
    print('Exact AVAILABLE NFS share metadata checked. No mount, file/object reads, writes, cache refresh, key or policy mutation. Effective permissions/audit delivery/application/authorization remain owner-tested.')

if __name__ == '__main__':
    main()
`;
