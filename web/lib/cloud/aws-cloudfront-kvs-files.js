export const cloudFrontFlagFunction=String.raw`import cf from 'cloudfront';
async function handler(event) {
  const request = event.request;
  let enabled = false;
  try { enabled = (await cf.kvs().get('migration_enabled')) === 'true'; }
  catch (_) { enabled = false; }
  request.headers['x-migration-enabled'] = { value: enabled ? 'true' : 'false' };
  return request;
}
`;
export const cloudFrontKvsInspection=String.raw`#!/usr/bin/env python3
"""Reads metadata and the exact approved nonsecret boolean flag; never publishes or writes."""
import argparse,json,re,sys
from pathlib import Path
import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
def require(ok,message):
    if not ok: raise ValueError(message)
def absent(method,expected_code,**request):
    try: method(**request)
    except ClientError as error:
        require(error.response.get('Error',{}).get('Code')==expected_code,'Read failed; absence not established');return
    raise ValueError('Resource already exists; reconcile owner/state instead of adopting implicitly')
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--check',action='store_true');parser.add_argument('--store-id');args=parser.parse_args()
    require(bool(args.store_id)==args.check,'Exact store ID is required only for postchecks')
    if args.store_id: require(re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',args.store_id),'Invalid store UUID')
    c=json.loads(Path(__file__).with_name('KVS-CONFIG.json').read_text())
    session=boto3.Session(region_name='us-east-1');control=Config(use_fips_endpoint=True,retries={'mode':'standard','max_attempts':3})
    require(session.client('sts',config=control).get_caller_identity()['Account']==c['account'],'Wrong global resource owner account')
    client=session.client('cloudfront',config=control)
    if not args.check:
        absent(client.describe_key_value_store,'EntityNotFound',Name=c['name'])
        for stage in ['DEVELOPMENT','LIVE']: absent(client.describe_function,'NoSuchFunctionExists',Name=c['functionName'],Stage=stage)
        print(json.dumps({'preflightMetadataVerified':True,'existingNamedResources':False,'dataResidency':'global','ownerGlobalDataCryptoAndStateApprovalRequired':True}));return
    arn='arn:aws:cloudfront::'+c['account']+':key-value-store/'+args.store_id
    store=client.describe_key_value_store(Name=c['name'])['KeyValueStore']
    require(store.get('Name')==c['name'] and store.get('Id')==args.store_id and store.get('ARN')==arn and store.get('Status')=='READY','Store global identity/owner/status mismatch')
    f=client.describe_function(Name=c['functionName'],Stage='DEVELOPMENT')['FunctionSummary']
    require(f.get('Name')==c['functionName'] and f.get('FunctionMetadata',{}).get('FunctionARN')=='arn:aws:cloudfront::'+c['account']+':function/'+c['functionName'] and f.get('FunctionMetadata',{}).get('Stage')=='DEVELOPMENT','Function owner/name/stage mismatch')
    config=f['FunctionConfig'];association=config.get('KeyValueStoreAssociations',{})
    require(config.get('Runtime')=='cloudfront-js-2.0' and association.get('Quantity')==1 and association.get('Items')==[{'KeyValueStoreARN':arn}],'Function runtime/store association mismatch')
    absent(client.describe_function,'NoSuchFunctionExists',Name=c['functionName'],Stage='LIVE')
    # Separate global SigV4A data API; no FIPS endpoint advertised in service table.
    data=session.client('cloudfront-keyvaluestore',config=Config(use_fips_endpoint=False,signature_version='v4a',retries={'mode':'standard','max_attempts':3}))
    metadata=data.describe_key_value_store(KvsARN=arn)
    require(metadata.get('KvsARN')==arn and metadata.get('ItemCount')==1 and metadata.get('Status')=='READY','Data store identity/item count/status mismatch')
    flag=data.get_key(KvsARN=arn,Key=c['key'])
    require(flag.get('Key')==c['key'] and flag.get('Value')==c['value'] and flag.get('ItemCount')==1,'Exact nonsecret flag mismatch')
    print(json.dumps({'storeAndDevelopmentFlagVerified':True,'globalData':True,'developmentFunction':c['functionName'],'liveFunctionAbsent':True,'edgePropagationProven':False,'viewerBehaviorProven':False,'distributionAssociationInventoryProven':False,'effectiveAuthorizationProven':False,'ownerCodeTestPublicationAndCryptoApprovalRequired':True},sort_keys=True))
if __name__=='__main__':
    try: main()
    except Exception:
        print('CloudFront global flag check failed. Reconcile approved owner/store/function/flag/crypto boundary and read permissions; no data writes, function publication or distribution changes were invoked.',file=sys.stderr);sys.exit(1)
`;
