export const appInsightsInspection=String.raw`#!/usr/bin/env python3
"""Owned EC2 group/SSM/monitor metadata only, never installs agents or sends commands."""
import argparse,json,sys
from pathlib import Path
import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
def require(ok,message):
    if not ok: raise ValueError(message)
def pages(method,**request):
    token=None;tokens=set()
    for page in range(100):
        response=method(**request,**({'NextToken':token} if token else {}));yield response
        token=response.get('NextToken')
        if not token: return
        require(token not in tokens,'Repeated metadata pagination token');tokens.add(token)
    raise ValueError('Metadata pagination limit exceeded')
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--check',action='store_true');args=parser.parse_args()
    c=json.loads(Path(__file__).with_name('APPINSIGHTS-CONFIG.json').read_text())
    session=boto3.Session(region_name=c['region']);cfg=Config(use_fips_endpoint=True,retries={'mode':'standard','max_attempts':3})
    clients={n:session.client(n,config=cfg) for n in ['sts','resource-groups','ec2','ssm','autoscaling','application-insights']}
    require(clients['sts'].get_caller_identity()['Account']==c['account'],'Wrong expected group/instance owner account')
    rg=clients['resource-groups'];ec2=clients['ec2'];app=clients['application-insights']
    group=rg.get_group(Group=c['group'])['Group'];require(group.get('GroupArn')==c['groupArn'] and group.get('Name')==c['group'],'Exact resource group owner/region/name mismatch')
    q=rg.get_group_query(Group=c['group'])['GroupQuery'];require(q.get('GroupName')==c['group'],'Group query name mismatch');rq=q['ResourceQuery']
    require(rq.get('Type')=='TAG_FILTERS_1_0','Expected EC2-only tag group, not account/stack scope')
    query=json.loads(rq['Query']);require(query=={'ResourceTypeFilters':['AWS::EC2::Instance'],'TagFilters':[{'Key':c['tagKey'],'Values':[c['tagValue']]}]},'Group query differs from exact approved single EC2 tag selector')
    resources=[]
    for response in pages(rg.list_group_resources,Group=c['group'],MaxResults=50):
        require(not response.get('QueryErrors'),'Resource group query errors prevent exact inventory')
        if 'Resources' in response:
            for item in response['Resources']:
                require(not item.get('Status',{}).get('Name'),'Group membership unresolved or unexpected status')
                resources.append(item['Identifier'])
        else: resources+=response.get('ResourceIdentifiers',[])
    actual=[r['ResourceArn'] for r in resources]
    require(len(actual)==len(set(actual)) and set(actual)==set(c['resources']) and all(r.get('ResourceType')=='AWS::EC2::Instance' for r in resources),'Group resources differ from exact unique EC2 baseline')
    discovered=[]
    for response in pages(ec2.describe_instances,Filters=[{'Name':'tag:'+c['tagKey'],'Values':[c['tagValue']]}],MaxResults=100):
        discovered += [i for reservation in response.get('Reservations',[]) for i in reservation.get('Instances',[]) if i.get('State',{}).get('Name')!='terminated']
    ids=[i['InstanceId'] for i in discovered];require(len(ids)==len(set(ids)) and set(ids)==set(c['instances']),'Independent tag discovery differs from approved EC2 baseline')
    for i in discovered:
        tags={t['Key']:t['Value'] for t in i.get('Tags',[])}
        require(i.get('State',{}).get('Name')=='running' and i.get('IamInstanceProfile',{}).get('Arn','').startswith('arn:'+c['partition']+':iam::'+c['account']+':instance-profile/') and tags.get(c['tagKey'])==c['tagValue'] and 'aws:autoscaling:groupName' not in tags,'Expected running owned-profile EC2 instance without ASG membership')
    managed=[i for response in pages(clients['ssm'].describe_instance_information,Filters=[{'Key':'InstanceIds','Values':c['instances']}],MaxResults=50) for i in response.get('InstanceInformationList',[])]
    mids=[i['InstanceId'] for i in managed];require(len(mids)==len(set(mids)) and set(mids)==set(c['instances']) and all(i.get('PingStatus')=='Online' and i.get('ResourceType')=='EC2Instance' and i.get('PlatformType') in ['Linux','Windows'] and i.get('AgentVersion') for i in managed),'Exact EC2 nodes must be SSM Online with supported platform metadata')
    for response in pages(clients['autoscaling'].describe_tags,Filters=[{'Name':'key','Values':[c['tagKey']]},{'Name':'value','Values':[c['tagValue']]}],MaxRecords=100): require(not response.get('Tags'),'Matching Auto Scaling tags could expand Application Insights discovery')
    try: info=app.describe_application(ResourceGroupName=c['group'],AccountId=c['account'])['ApplicationInfo']
    except ClientError as error:
        require(not args.check and error.response.get('Error',{}).get('Code')=='ResourceNotFoundException','Application lookup failed; absence not established')
        print(json.dumps({'preflightMetadataVerified':True,'expectedEc2Instances':len(ids),'groupCanExpand':True,'initialInstrumentationChangesGuests':True,'ownerPermissionsTelemetryAndStackApprovalRequired':True}));return
    require(args.check,'Application exists; reconcile before new initial instrumentation')
    require(info.get('AccountId')==c['account'] and info.get('ResourceGroupName')==c['group'] and info.get('DiscoveryType')=='RESOURCE_GROUP_BASED','Application owner/group/discovery mismatch')
    require(info.get('AutoConfigEnabled') is False and info.get('CWEMonitorEnabled') is True and info.get('OpsCenterEnabled') is False and info.get('AttachMissingPermission') is False and not info.get('OpsItemSNSTopicArn') and not info.get('SNSNotificationArn') and not info.get('Remarks'),'Unreviewed application automation/permissions/notifications or configuration remarks')
    components=[comp for response in pages(app.list_components,ResourceGroupName=c['group'],AccountId=c['account'],MaxResults=40) for comp in response.get('ApplicationComponentList',[])]
    names=[comp['ComponentName'] for comp in components];require(names and len(names)==len(set(names)) and len(names)<=20,'Expected unique bounded components')
    covered=[]
    for comp in components:
        require(comp.get('Monitor') is True and comp.get('Tier')=='DEFAULT' and not comp.get('ComponentRemarks'),'Initial component monitoring/configuration is not qualified DEFAULT scope')
        result=app.describe_component(ResourceGroupName=c['group'],AccountId=c['account'],ComponentName=comp['ComponentName']);actual=result['ApplicationComponent']
        require(actual.get('ComponentName')==comp['ComponentName'] and actual.get('Monitor') is True and actual.get('Tier')=='DEFAULT' and not actual.get('ComponentRemarks'),'Actual component configuration mismatch')
        members=result.get('ResourceList',[]);require(members and set(members)<=set(c['resources']),'Component contains resources outside approved baseline');covered+=members
    require(len(covered)==len(set(covered)) and set(covered)==set(c['resources']),'Components duplicate or omit expected instance coverage')
    print(json.dumps({'applicationComponentMetadataVerified':True,'expectedEc2Instances':len(ids),'monitoredComponents':len(names),'groupCanExpand':True,'actualTelemetryProven':False,'guestAgentConfigurationProven':False,'applicationReadinessProven':False,'effectivePermissionsProven':False,'ownerStackLogsAndRecoveryReviewRequired':True},sort_keys=True))
if __name__=='__main__':
    try: main()
    except Exception:
        print('Application Insights metadata check failed. Reconcile approved group/instance/agent/component scope and read permissions; no agent commands, IAM attachments, logs or instrumentation changes were invoked.',file=sys.stderr);sys.exit(1)
`;
