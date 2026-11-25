export const dlmInspection=String.raw`#!/usr/bin/env python3
"""Read-only DLM metadata checks. No snapshot or policy mutation."""
import argparse,json,re,sys
from pathlib import Path
import boto3
from botocore.config import Config

def require(ok,message):
    if not ok: raise ValueError(message)

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--policy')
    parser.add_argument('--expect-enabled',action='store_true')
    args=parser.parse_args()
    require(not args.expect_enabled or args.policy,'Enabled checks require an exact policy ID')
    if args.policy: require(re.fullmatch(r'policy-[a-f0-9]+',args.policy),'Invalid policy ID')
    c=json.loads(Path(__file__).with_name('DLM-CONFIG.json').read_text())
    session=boto3.Session(region_name=c['region'])
    cfg=Config(use_fips_endpoint=True,retries={'mode':'standard','max_attempts':3})
    clients={name:session.client(name,config=cfg) for name in ['sts','ec2','kms','iam','dlm']}
    require(clients['sts'].get_caller_identity()['Account']==c['account'],'Wrong owner account')
    ec2,dlm=clients['ec2'],clients['dlm']
    token=None;seen_tokens=set();volumes={}
    for page in range(100):
        request={'Filters':[{'Name':'tag:'+c['tagKey'],'Values':[c['tagValue']]}],'MaxResults':500}
        if token: request['NextToken']=token
        response=ec2.describe_volumes(**request)
        for v in response.get('Volumes',[]):
            identifier=v['VolumeId']
            require(identifier not in volumes,'Duplicate volume in paginated inventory')
            volumes[identifier]=v
        token=response.get('NextToken')
        if not token: break
        require(token not in seen_tokens,'Repeated volume pagination token');seen_tokens.add(token)
    else: raise ValueError('Volume pagination limit exceeded')
    require(set(volumes)==set(c['volumes']) and len(c['volumes'])==len(set(c['volumes'])),'Tag-target inventory differs from expected exact volume baseline')
    used_keys=set();total=0
    for v in volumes.values():
        require(v.get('State') in ['available','in-use'] and v.get('Encrypted') is True,'Source volume is unhealthy or unencrypted')
        require(not v.get('OutpostArn'),'Unsupported source location')
        require(v.get('KmsKeyId') in c['keys'],'Unexpected source encryption key')
        require({t['Key']:t['Value'] for t in v.get('Tags',[])}.get(c['tagKey'])==c['tagValue'],'Source tag mismatch')
        # DescribeVolumes is account-scoped; source AZ IDs must be ordinary regional AZs.
        zone=v.get('AvailabilityZone','')
        require(re.fullmatch(re.escape(c['region'])+r'[a-z]',zone),'Local/Wavelength/unknown source zone requires separate workflow')
        used_keys.add(v['KmsKeyId']);total+=v['Size']
    require(used_keys==set(c['keys']),'Approved key list must exactly match source keys')
    for arn in sorted(used_keys):
        key=clients['kms'].describe_key(KeyId=arn)['KeyMetadata']
        require(key.get('Arn')==arn and key.get('AWSAccountId')==c['account'] and key.get('KeyManager')=='CUSTOMER' and key.get('KeyState')=='Enabled' and key.get('KeySpec')=='SYMMETRIC_DEFAULT' and key.get('KeyUsage')=='ENCRYPT_DECRYPT','Customer key metadata mismatch')
    role=clients['iam'].get_role(RoleName=c['role'].split('/')[-1])['Role']
    require(role.get('Arn')==c['role'],'Execution role owner/path mismatch')
    trust=role['AssumeRolePolicyDocument']
    if isinstance(trust,str):
        from urllib.parse import unquote
        trust=json.loads(unquote(trust))
    def as_list(value): return value if isinstance(value,list) else [value]
    require(any(s.get('Effect')=='Allow' and 'sts:AssumeRole' in as_list(s.get('Action',[])) and 'dlm.amazonaws.com' in as_list(s.get('Principal',{}).get('Service',[])) for s in trust.get('Statement',[])),'Missing DLM service trust; effective conditions/denies require owner review')
    # This API has no pagination token. Do not invent NextToken/MaxResults parameters.
    summaries=dlm.get_lifecycle_policies().get('Policies',[])
    require(len(summaries)<=1000,'Unexpected lifecycle policy inventory size')
    require(len({p['PolicyId'] for p in summaries})==len(summaries),'Duplicate lifecycle policy summary')
    if not args.policy:
        require(not any(p.get('Description')==c['name'] for p in summaries),'Policy description already exists; reconcile existing policy')
    else:
        p=dlm.get_lifecycle_policy(PolicyId=args.policy)['Policy']
        require(p.get('PolicyId')==args.policy and p.get('PolicyArn')=='arn:aws:dlm:'+c['region']+':'+c['account']+':policy/'+args.policy,'Policy identity/owner mismatch')
        require(p.get('Description')==c['name'] and p.get('ExecutionRoleArn')==c['role'] and p.get('State')==('ENABLED' if args.expect_enabled else 'DISABLED'),'Policy state/role/description mismatch')
        require(not p.get('DefaultPolicy',False),'Default policies are outside this workflow')
        d=p['PolicyDetails']
        require(d.get('PolicyType')=='EBS_SNAPSHOT_MANAGEMENT' and d.get('ResourceTypes')==['VOLUME'] and d.get('ResourceLocations')==['CLOUD'],'Policy type/target location mismatch')
        require(d.get('TargetTags')==[{'Key':c['tagKey'],'Value':c['tagValue']}] and not d.get('Actions') and not d.get('EventSource') and not d.get('Parameters'),'Unexpected policy target/actions/parameters')
        schedules=d.get('Schedules',[]);require(len(schedules)==1,'Expected exactly one schedule')
        s=schedules[0]
        require(s.get('Name')=='reviewed-volume-snapshots' and s.get('CopyTags') is False and s.get('TagsToAdd')==[{'Key':'BackupPlan','Value':c['name']}] and not s.get('VariableTags'),'Snapshot tag configuration mismatch')
        create=s.get('CreateRule',{});retain=s.get('RetainRule',{})
        require(create.get('Interval')==c['interval'] and create.get('IntervalUnit')=='HOURS' and create.get('Times')==[c['time']] and create.get('Location')=='CLOUD' and not create.get('CronExpression') and not create.get('Scripts'),'Creation schedule/location/scripts mismatch')
        require(retain=={'Count':c['retain']},'Retention mismatch')
        require(not any(s.get(k) for k in ['CrossRegionCopyRules','ShareRules','FastRestoreRule','DeprecateRule','ArchiveRule']),'Unreviewed copy/share/restore/archive options')
    print(json.dumps({'metadataVerified':True,'policyState':('ENABLED' if args.expect_enabled else 'DISABLED') if args.policy else 'not-created','sourceVolumes':len(volumes),'sourceCapacityGiB':total,'otherLifecyclePolicies':[{'id':p['PolicyId'],'state':p.get('State'),'type':p.get('PolicyType')} for p in summaries if p['PolicyId']!=args.policy],'targetExpansionPossible':True,'effectivePermissionsProven':False,'snapshotRecoveryProven':False,'ownerOverlapReviewRequired':True},sort_keys=True))

if __name__=='__main__':
    try: main()
    except Exception:
        print('DLM metadata check failed. Review approved configuration, target inventory and permissions; no lifecycle operations were invoked.',file=sys.stderr)
        sys.exit(1)
`;

export const dlmSnapshotInspection=String.raw`#!/usr/bin/env python3
"""Inspect owned DLM snapshot lineage only. Does not restore/read/delete snapshots."""
import argparse,json,re,sys
from datetime import datetime,timezone
from pathlib import Path
import boto3
from botocore.config import Config
def require(ok,message):
    if not ok: raise ValueError(message)
def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--policy',required=True)
    parser.add_argument('--max-age-hours',required=True,type=float)
    args=parser.parse_args()
    require(re.fullmatch(r'policy-[a-f0-9]+',args.policy),'Invalid policy ID')
    require(0<args.max_age_hours<=8760,'Owner must supply an approved freshness bound of0–8760hours')
    c=json.loads(Path(__file__).with_name('DLM-CONFIG.json').read_text())
    session=boto3.Session(region_name=c['region']);cfg=Config(use_fips_endpoint=True,retries={'mode':'standard','max_attempts':3})
    require(session.client('sts',config=cfg).get_caller_identity()['Account']==c['account'],'Wrong owner')
    ec2=session.client('ec2',config=cfg);token=None;tokens=set();ids=set();by_volume={v:[] for v in c['volumes']};pending=0;now=datetime.now(timezone.utc)
    for page in range(100):
        request={'OwnerIds':[c['account']],'Filters':[{'Name':'tag:aws:dlm:lifecycle-policy-id','Values':[args.policy]}],'MaxResults':1000}
        if token: request['NextToken']=token
        response=ec2.describe_snapshots(**request)
        for s in response.get('Snapshots',[]):
            require(s['SnapshotId'] not in ids,'Duplicate snapshot in paginated inventory');ids.add(s['SnapshotId'])
            require(s.get('OwnerId')==c['account'] and s.get('VolumeId') in by_volume,'Snapshot owner/source not in reviewed baseline')
            tags={t['Key']:t['Value'] for t in s.get('Tags',[])}
            require(tags.get('aws:dlm:lifecycle-policy-id')==args.policy and tags.get('aws:dlm:lifecycle-schedule-name')=='reviewed-volume-snapshots','Unexpected snapshot policy/schedule lineage')
            require(s.get('Encrypted') is True and s.get('KmsKeyId') in c['keys'],'Snapshot encryption mismatch')
            require(s.get('StorageTier','standard')=='standard' and not s.get('OutpostArn'),'Unexpected archive/location')
            require(s.get('State') in ['completed','pending'],'Snapshot reported error/unsupported state')
            start=s['StartTime'];require(start.tzinfo is not None and start<=now,'Invalid/future snapshot start time')
            by_volume[s['VolumeId']].append(s)
            if s['State']=='pending': pending+=1
        token=response.get('NextToken')
        if not token: break
        require(token not in tokens,'Repeated snapshot pagination token');tokens.add(token)
    else: raise ValueError('Snapshot pagination limit exceeded')
    reports=[]
    for volume,snapshots in by_volume.items():
        completed=[s for s in snapshots if s['State']=='completed']
        require(completed,'At least one completed snapshot is required for every source volume')
        newest=max(completed,key=lambda s:s['StartTime']);age=(now-newest['StartTime']).total_seconds()/3600
        require(age<=args.max_age_hours,'Newest completed snapshot exceeds approved freshness bound')
        reports.append({'volume':volume,'snapshotCount':len(snapshots),'completedCount':len(completed),'newestCompletedSnapshot':newest['SnapshotId'],'newestStartAgeHours':round(age,2),'configuredRetainCount':c['retain'],'aboveConfiguredCount':len(snapshots)>c['retain']})
    print(json.dumps({'snapshotMetadataVerified':True,'policy':args.policy,'sources':reports,'pendingSnapshots':pending,'retentionEnforcementProven':False,'snapshotRecoveryProven':False,'applicationConsistencyProven':False,'ownerRestoreAndRetentionReviewRequired':True},sort_keys=True))
if __name__=='__main__':
    try: main()
    except Exception:
        print('Snapshot lineage/freshness check failed. No snapshot contents or lifecycle mutations were accessed.',file=sys.stderr);sys.exit(1)
`;
