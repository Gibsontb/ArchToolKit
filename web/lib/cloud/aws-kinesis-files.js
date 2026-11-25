export const kinesisInspection=String.raw`#!/usr/bin/env python3
"""Exact stream/consumer/KMS metadata only. Never reads or writes records."""
import argparse,json,re,sys
from pathlib import Path
import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
def require(ok,message):
    if not ok: raise ValueError(message)
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--check',action='store_true');args=parser.parse_args()
    c=json.loads(Path(__file__).with_name('KINESIS-CONFIG.json').read_text())
    fips=c['region'] in ['us-east-1','us-east-2','us-west-1','us-west-2','us-gov-east-1','us-gov-west-1']
    session=boto3.Session(region_name=c['region']);cfg=Config(use_fips_endpoint=fips,retries={'mode':'standard','max_attempts':3})
    require(session.client('sts',config=cfg).get_caller_identity()['Account']==c['account'],'Wrong stream owner account')
    client=session.client('kinesis',config=cfg);keys=session.client('kms',config=cfg)
    expected_key=None
    if c['kms']:
        expected_key=keys.describe_key(KeyId=c['kms'])['KeyMetadata']
        require(expected_key.get('Arn')==c['kms'] and expected_key.get('KeyManager')=='CUSTOMER' and expected_key.get('KeyState')=='Enabled' and expected_key.get('KeySpec')=='SYMMETRIC_DEFAULT' and expected_key.get('KeyUsage')=='ENCRYPT_DECRYPT','Selected customer encryption key mismatch')
    arn='arn:'+c['partition']+':kinesis:'+c['region']+':'+c['account']+':stream/'+c['name']
    try: stream=client.describe_stream_summary(StreamARN=arn)['StreamDescriptionSummary']
    except ClientError as error:
        require(not args.check and error.response.get('Error',{}).get('Code')=='ResourceNotFoundException','Stream lookup failed; absence not established')
        print(json.dumps({'preflightMetadataVerified':True,'existingStream':False,'fipsMetadataEndpointSelected':fips,'ownerPoliciesAndCapacityReviewRequired':True}));return
    require(args.check,'Stream already exists; reconcile/import through owner change control')
    require(stream.get('StreamARN')==arn and stream.get('StreamName')==c['name'] and stream.get('StreamStatus')=='ACTIVE','Stream identity/owner/state mismatch')
    require(stream.get('StreamModeDetails',{}).get('StreamMode')==c['mode'] and stream.get('RetentionPeriodHours')==c['retention'] and stream.get('EncryptionType')=='KMS','Stream mode/retention/encryption mismatch')
    require(isinstance(stream.get('OpenShardCount'),int) and stream['OpenShardCount']>0 and (c['mode']!='PROVISIONED' or stream['OpenShardCount']==c['shards']),'Open shard count mismatch')
    if not expected_key: expected_key=keys.describe_key(KeyId='alias/aws/kinesis')['KeyMetadata'];require(expected_key.get('KeyManager')=='AWS','Expected AWS-managed Kinesis key')
    require(expected_key.get('KeyState')=='Enabled' and expected_key.get('KeySpec')=='SYMMETRIC_DEFAULT' and expected_key.get('KeyUsage')=='ENCRYPT_DECRYPT','Encryption key unhealthy')
    actual=stream.get('KeyId');allowed=[expected_key.get('Arn'),expected_key.get('KeyId')]+([] if c['kms'] else ['alias/aws/kinesis'])
    require(actual and actual in allowed,'Actual stream encryption key does not resolve to approved key')
    consumers={};token=None;tokens=set()
    for page in range(100):
        request={'StreamARN':arn,'MaxResults':100}
        if token: request['NextToken']=token
        response=client.list_stream_consumers(**request)
        for consumer in response.get('Consumers',[]):
            name=consumer['ConsumerName'];require(name not in consumers,'Duplicate consumer in paginated inventory');consumers[name]=consumer
        token=response.get('NextToken')
        if not token: break
        require(token not in tokens,'Repeated consumer pagination token');tokens.add(token)
    else: raise ValueError('Consumer pagination limit exceeded')
    require(set(consumers)==({c['consumer']} if c['consumer'] else set()),'Registered fanout consumers differ from approved exact scope')
    for name,consumer in consumers.items():
        ca=consumer.get('ConsumerARN','');require(re.fullmatch(re.escape(arn+'/consumer/'+name)+r':[0-9]+',ca) and consumer.get('ConsumerStatus')=='ACTIVE','Consumer ARN/state mismatch')
        d=client.describe_stream_consumer(ConsumerARN=ca)['ConsumerDescription']
        require(d.get('ConsumerARN')==ca and d.get('StreamARN')==arn and d.get('ConsumerName')==name and d.get('ConsumerStatus')=='ACTIVE','Actual consumer identity mismatch')
    print(json.dumps({'streamMetadataVerified':True,'consumerRegistrations':len(consumers),'openShards':stream['OpenShardCount'],'fipsMetadataEndpointSelected':fips,'recordIntegrityProven':False,'consumerApplicationRunningProven':False,'effectivePolicyAuthorizationProven':False,'ownerReplayAndCutoverReviewRequired':True},sort_keys=True))
if __name__=='__main__':
    try: main()
    except Exception:
        print('Kinesis metadata check failed. Reconcile approved stream/consumer/key/account and read permissions; no records, policies or stream mutations were requested.',file=sys.stderr);sys.exit(1)
`;
