export const appFlowInspection=String.raw`import argparse
import json
import re
from pathlib import Path
import boto3
from botocore.config import Config

def require(condition, message):
    if not condition:
        raise RuntimeError(message)

def pages(client, method, field, **kwargs):
    result, seen, token = [], set(), None
    for _ in range(100):
        response = getattr(client,method)(**kwargs, **({'nextToken':token} if token else {}))
        result += response.get(field,[])
        token = response.get('nextToken')
        if not token:
            return result
        require(token not in seen, 'Repeated pagination token; inspection incomplete')
        seen.add(token)
    raise RuntimeError('Pagination bound exceeded; inspection incomplete')

def main():
    parser = argparse.ArgumentParser(description='Read-only AppFlow/Salesforce schema/S3 metadata inspection; never transfers records')
    parser.add_argument('--check',action='store_true',help='Compare the newly deployed, not-yet-run flow')
    parser.add_argument('--execution',help='Exact separately authorized execution receipt; requires --check, does not start a transfer')
    args = parser.parse_args()
    require(not args.execution or args.check, 'Execution receipt inspection requires --check')
    require(not args.execution or re.fullmatch(r'[A-Za-z0-9_-]{1,256}',args.execution), 'Invalid execution receipt')
    root = Path(__file__).resolve().parent
    c = json.loads((root/'FLOW-CONFIG.json').read_text())
    session = boto3.Session(region_name=c['region'])
    cfg = Config(use_fips_endpoint=True,retries={'mode':'standard','total_max_attempts':3})
    def client(name):
        return session.client(name,region_name=c['region'],config=cfg)
    require(client('sts').get_caller_identity()['Account'] == c['account'], 'Wrong AWS account')
    app = client('appflow')
    profiles = pages(app,'describe_connector_profiles','connectorProfileDetails',connectorProfileNames=[c['profile']],connectorType='Salesforce',maxResults=100)
    require(len(profiles) == 1, 'Require exact existing Salesforce profile')
    p = profiles[0]
    require(p.get('connectorProfileArn') == 'arn:aws:appflow:'+c['region']+':'+c['account']+':connectorprofile/'+c['profile'] and p.get('connectorProfileName') == c['profile'] and p.get('connectorType') == 'Salesforce' and p.get('connectionMode') == 'Private', 'Wrong owner/region/profile or not private')
    state = p.get('privateConnectionProvisioningState',{})
    require(state.get('status') == 'CREATED' and not state.get('failureCause') and not state.get('failureMessage'), 'Salesforce PrivateLink connection not provisioned')
    salesforce = p.get('connectorProfileProperties',{}).get('Salesforce',{})
    require(str(salesforce.get('instanceUrl','')).rstrip('/') == c['instance'], 'Wrong Salesforce organization instance')
    # MetadataAndAuthorization is checked explicitly; it is distinct from the connectionMode flag.
    require(salesforce.get('usePrivateLinkForMetadataAndAuthorization') is True, 'Metadata/authorization PrivateLink not enabled in this bounded workflow')
    schema = app.describe_connector_entity(connectorProfileName=c['profile'],connectorType='Salesforce',connectorEntityName=c['object']).get('connectorEntityFields',[])
    for field in c['fields']:
        matches = [f for f in schema if f.get('identifier') == field]
        require(len(matches) == 1 and matches[0].get('sourceProperties',{}).get('isRetrievable') is True and not matches[0].get('isDeprecated'), 'Selected source field not uniquely retrievable')
        expected = 'id' if field == 'Id' else 'string'
        require(matches[0].get('supportedFieldTypeDetails',{}).get('v1',{}).get('fieldType') == expected, 'Source field type differs from reviewed mapping')
    s3 = client('s3')
    bucket_args = {'Bucket':c['bucket'],'ExpectedBucketOwner':c['account']}
    s3.head_bucket(**bucket_args)
    require((s3.get_bucket_location(**bucket_args).get('LocationConstraint') or 'us-east-1') == c['region'], 'Wrong destination region')
    blocks = s3.get_public_access_block(**bucket_args).get('PublicAccessBlockConfiguration',{})
    require(all(blocks.get(k) is True for k in ['BlockPublicAcls','IgnorePublicAcls','BlockPublicPolicy','RestrictPublicBuckets']), 'Destination public access blocks required')
    require(s3.get_bucket_versioning(**bucket_args).get('Status') == 'Enabled', 'Destination versioning required for owner recovery procedure')
    kms = client('kms')
    def key_arn(identifier):
        key = kms.describe_key(KeyId=identifier)['KeyMetadata']
        require(key.get('Arn') == c['kms'] and key.get('AWSAccountId') == c['account'] and key.get('KeyManager') == 'CUSTOMER' and key.get('KeyState') == 'Enabled' and key.get('KeyUsage') == 'ENCRYPT_DECRYPT' and key.get('KeySpec') == 'SYMMETRIC_DEFAULT', 'Wrong/disabled/noncustomer/asymmetric flow/data key')
        return key['Arn']
    key_arn(c['kms'])
    rules = s3.get_bucket_encryption(**bucket_args).get('ServerSideEncryptionConfiguration',{}).get('Rules',[])
    require(len(rules) == 1 and rules[0].get('ApplyServerSideEncryptionByDefault',{}).get('SSEAlgorithm') == 'aws:kms', 'Require destination SSE-KMS')
    key_arn(rules[0]['ApplyServerSideEncryptionByDefault'].get('KMSMasterKeyID',''))
    policy = json.loads(s3.get_bucket_policy(**bucket_args)['Policy'])
    desired = json.loads((root/'BUCKET-POLICY-MERGE.json').read_text())
    require(all(statement in policy.get('Statement',[]) for statement in desired['Statement']), 'Exact reviewed bucket-policy merge statements absent; do not overwrite existing policy automatically')
    # Presence of allow statements does NOT prove effective SCP/boundary/key/endpoint/resource permissions.
    if not args.execution:
        objects = s3.list_objects_v2(**bucket_args,Prefix=c['prefix'],MaxKeys=1)
        require(not objects.get('Contents') and not objects.get('IsTruncated'), 'Destination prefix already contains data; first-transfer staging review required')
    if not args.check:
        flows = pages(app,'list_flows','flows',maxResults=100)
        require(all(f.get('flowName') != c['name'] for f in flows), 'Flow name already exists; no import/replacement in this new-only package')
        print('Owner/private profile/instance/schema/bucket/data-key/policy-merge/empty-prefix metadata checked. No records transferred; effective permissions/authorization/temporary storage boundary remain owner-reviewed.')
        return
    flow = app.describe_flow(flowName=c['name'])
    require(flow.get('flowName') == c['name'] and flow.get('flowArn') == c['flowArn'] and flow.get('flowStatus') in ['Draft','Active'], 'Wrong/unready exact flow')
    key_arn(flow.get('kmsArn',''))
    require(flow.get('triggerConfig',{}).get('triggerType') == 'OnDemand' and not flow.get('triggerConfig',{}).get('triggerProperties'), 'Unexpected automatic trigger')
    require(not flow.get('metadataCatalogConfig'), 'Unexpected data catalog side effects')
    source = flow.get('sourceFlowConfig',{})
    require(source.get('connectorType') == 'Salesforce' and source.get('connectorProfileName') == c['profile'] and set(source.get('sourceConnectorProperties',{})) == {'Salesforce'} and not source.get('incrementalPullConfig') and not source.get('apiVersion'), 'Unexpected source configuration')
    require(source['sourceConnectorProperties']['Salesforce'] == {'object':c['object'],'enableDynamicFieldUpdate':False,'includeDeletedRecords':False,'dataTransferApi':'REST_SYNC'}, 'Source object/flags/API mismatch')
    destinations = flow.get('destinationFlowConfigList',[])
    require(len(destinations) == 1 and destinations[0].get('connectorType') == 'S3' and not destinations[0].get('connectorProfileName') and not destinations[0].get('apiVersion'), 'Unexpected destination connector')
    dest = destinations[0].get('destinationConnectorProperties',{}).get('S3',{})
    require(dest.get('bucketName') == c['bucket'] and dest.get('bucketPrefix') == c['prefix'], 'Wrong destination bucket/prefix')
    output = dest.get('s3OutputFormatConfig',{})
    require(output.get('fileType') == c['format'] and output.get('aggregationConfig',{}).get('aggregationType') == 'None' and output.get('prefixConfig') == {'prefixType':'PATH','prefixFormat':'DAY','prefixHierarchy':['EXECUTION_ID']}, 'Destination output format/prefix mismatch')
    expected = [{'taskType':'Filter','sourceFields':c['fields'],'connectorOperator':{'Salesforce':'PROJECTION'}}]+[{'taskType':'Map','sourceFields':[f],'destinationField':f,'connectorOperator':{'Salesforce':'NO_OP'},'taskProperties':{'SOURCE_DATA_TYPE':'id' if f=='Id' else 'string','DESTINATION_DATA_TYPE':'id' if f=='Id' else 'string'}} for f in c['fields']]
    tasks = flow.get('tasks',[])
    normalized = [{k:v for k,v in task.items() if not (k=='taskProperties' and v=={})} for task in tasks]
    canonical = lambda task: json.dumps({**task,**({'sourceFields':sorted(task['sourceFields'])} if 'sourceFields' in task else {})},sort_keys=True)
    require(sorted(map(canonical,normalized)) == sorted(map(canonical,expected)), 'Unexpected task/projection/mapping; never allow Map_all or new fields silently')
    records = pages(app,'describe_flow_execution_records','flowExecutions',flowName=c['name'],maxResults=100)
    if not args.execution:
        require(not records and not flow.get('lastRunExecutionDetails'), 'Flow has prior/active execution; first-transfer stage check cannot certify it')
        print('Exact not-yet-run on-demand flow configuration checked. No start, records, credentials, key/policy changes or data transfer. Owner approval remains required.')
        return
    matches = [r for r in records if r.get('executionId') == args.execution]
    require(len(matches) == 1 and matches[0].get('executionStatus') == 'Successful', 'Exact run missing/duplicated/not Successful; do not retry a transfer blindly')
    execution = matches[0].get('executionResult',{})
    require(not execution.get('errorInfo',{}).get('putFailuresCount') and not execution.get('errorInfo',{}).get('executionMessage'), 'Run reports errors/failures; owner reconciliation required')
    require(isinstance(execution.get('recordsProcessed'),int) and execution['recordsProcessed'] >= 0, 'Record count unavailable; reconciliation incomplete')
    print(json.dumps({'executionId':args.execution,'status':'Successful','recordsProcessed':execution['recordsProcessed'],'bytesProcessed':execution.get('bytesProcessed'),'bytesWritten':execution.get('bytesWritten'),'dataIntegrityProven':False,'ownerReconciliationRequired':True},sort_keys=True))

if __name__ == '__main__':
    main()
`;
