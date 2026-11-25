export const detectiveInspection=String.raw`#!/usr/bin/env python3
"""Read-only graph/membership/package metadata, never enables or investigates."""
import argparse,json,re,sys
from pathlib import Path
import boto3
from botocore.config import Config
def require(ok,message):
    if not ok: raise ValueError(message)
def pages(method,key,**request):
    token=None;tokens=set()
    for page in range(100):
        response=method(**request,**({'NextToken':token} if token else {}))
        yield response.get(key,[])
        token=response.get('NextToken')
        if not token: return
        require(token not in tokens,'Repeated Detective pagination token');tokens.add(token)
    raise ValueError('Detective pagination limit exceeded')
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--graph');args=parser.parse_args()
    c=json.loads(Path(__file__).with_name('DETECTIVE-CONFIG.json').read_text())
    if args.graph: require(re.fullmatch('arn:aws:detective:'+re.escape(c['region'])+':'+c['account']+r':graph:[a-f0-9]{32}',args.graph),'Unexpected graph region/owner/identifier')
    session=boto3.Session(region_name=c['region']);cfg=Config(use_fips_endpoint=True,retries={'mode':'standard','max_attempts':3})
    require(session.client('sts',config=cfg).get_caller_identity()['Account']==c['account'],'Wrong graph administrator account')
    client=session.client('detective',config=cfg)
    graphs=[g for page in pages(client.list_graphs,'GraphList',MaxResults=100) for g in page]
    require(len({g['Arn'] for g in graphs})==len(graphs),'Duplicate graph returned by pagination')
    if not args.graph:
        require(not graphs,'An administrator graph already exists; reconcile rather than enabling/adopting implicitly')
        print(json.dumps({'preflightMetadataVerified':True,'existingAdministratorGraphs':0,'creationStartsIngestion':True,'ownerOrgEnrollmentAndTelemetryApprovalRequired':True}));return
    require(len(graphs)==1 and graphs[0]['Arn']==args.graph,'Expected exact unique account-owned administrator graph')
    require(client.list_tags_for_resource(ResourceArn=args.graph).get('Tags',{}).get('Name')==c['name'],'Graph tag mismatch')
    members=[m for page in pages(client.list_members,'MemberDetails',GraphArn=args.graph,MaxResults=100) for m in page]
    require(len({m['AccountId'] for m in members})==len(members),'Duplicate member account metadata')
    for member in members:
        require(member.get('AccountId')==c['account'] and member.get('AdministratorId',member.get('MasterId'))==c['account'] and member.get('GraphArn')==args.graph,'Unexpected member/administrator account or graph')
        require(member.get('Status')=='ENABLED' and not member.get('DisabledReason'),'Administrator ingestion member is not healthy')
    packages={}
    for page in pages(client.list_datasource_packages,'DatasourcePackages',GraphArn=args.graph,MaxResults=100):
        require(isinstance(page,dict),'Invalid data-source package response')
        require(not set(page)&set(packages),'Duplicate data-source package metadata');packages.update(page)
    require(set(packages)==set(c['approvedPackages']),'Actual source packages differ from approved default package scope')
    require(all(value.get('DatasourcePackageIngestState')=='STARTED' for value in packages.values()),'A source package is not STARTED')
    print(json.dumps({'graphMetadataVerified':True,'administratorAccount':c['account'],'memberRows':len(members),'sourcePackages':{k:v['DatasourcePackageIngestState'] for k,v in packages.items()},'ingestionCompletenessProven':False,'effectiveAuthorizationProven':False,'orgAutoEnableDisabledProven':False,'incidentDetectionProven':False,'ownerUsageRetentionAndEvidenceReviewRequired':True},sort_keys=True))
if __name__=='__main__':
    try: main()
    except Exception:
        print('Detective metadata check failed. Reconcile approved graph/account/package scope and read permissions; no service enablement or investigation was invoked.',file=sys.stderr);sys.exit(1)
`;
