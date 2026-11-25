export const internetMonitorInspection=String.raw`#!/usr/bin/env python3
"""Read monitor/VPC/gateway metadata only; no telemetry/event bodies or mutations."""
import argparse,json,sys
from pathlib import Path
import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
def require(ok,message):
    if not ok: raise ValueError(message)
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--check',action='store_true');args=parser.parse_args()
    c=json.loads(Path(__file__).with_name('INTERNET-CONFIG.json').read_text())
    session=boto3.Session(region_name=c['region']);cfg=Config(use_fips_endpoint=True,retries={'mode':'standard','max_attempts':3})
    require(session.client('sts',config=cfg).get_caller_identity()['Account']==c['account'],'Wrong monitor/VPC owner account')
    ec2=session.client('ec2',config=cfg);client=session.client('internetmonitor',config=cfg)
    vpcs=ec2.describe_vpcs(VpcIds=c['vpcs'])['Vpcs']
    require(len(vpcs)==len(c['vpcs']) and {v['VpcId'] for v in vpcs}==set(c['vpcs']) and all(v.get('OwnerId')==c['account'] and v.get('State')=='available' for v in vpcs),'VPC owner/state/exact inventory mismatch')
    gateways=ec2.describe_internet_gateways(Filters=[{'Name':'attachment.vpc-id','Values':[c['vpcs'][0]]}])['InternetGateways']
    require(len(gateways)==1 and gateways[0].get('OwnerId')==c['account'] and any(a.get('VpcId')==c['vpcs'][0] and a.get('State')=='available' for a in gateways[0].get('Attachments',[])),'First VPC requires an existing owned attached internet gateway')
    try: monitor=client.get_monitor(MonitorName=c['name'])
    except ClientError as error:
        require(not args.check and error.response.get('Error',{}).get('Code')=='ResourceNotFoundException','Monitor lookup failed; absence not established')
        print(json.dumps({'preflightMetadataVerified':True,'existingMonitor':False,'sourceVpcs':len(vpcs),'creationStartsMonitoring':True,'ownerTelemetryLogsAndChargesApprovalRequired':True}));return
    require(args.check,'Monitor exists; reconcile/import through independent owner review')
    arn='arn:aws:internetmonitor:'+c['region']+':'+c['account']+':monitor/'+c['name']
    require(monitor.get('MonitorName')==c['name'] and monitor.get('MonitorArn')==arn and monitor.get('Status')=='ACTIVE','Monitor identity/owner/region/status mismatch')
    actual=monitor.get('Resources',[]);require(len(actual)==len(set(actual)) and set(actual)==set(c['resources']),'Monitored source ARN scope differs')
    require(monitor.get('TrafficPercentageToMonitor')==c['percentage'] and monitor.get('MaxCityNetworksToMonitor')==c['cities'],'Traffic/city-network cap mismatch')
    health=monitor.get('HealthEventsConfig',{})
    require(health.get('AvailabilityScoreThreshold')==c['availability'] and health.get('PerformanceScoreThreshold')==c['performance'],'Health threshold mismatch')
    require(monitor.get('ProcessingStatus') in ['OK','COLLECTING_DATA','INSUFFICIENT_DATA'],'Monitor processing failed/inactive; reconcile before acceptance')
    delivery=monitor.get('InternetMeasurementsLogDelivery',{}).get('S3Config',{})
    require(not delivery or delivery.get('LogDeliveryStatus')=='DISABLED','Unexpected additional S3 telemetry export')
    print(json.dumps({'monitorMetadataVerified':True,'processingStatus':monitor['ProcessingStatus'],'sourceVpcs':len(vpcs),'cityNetworkCap':c['cities'],'requestedTrafficPercentage':c['percentage'],'coverageCompletenessProven':False,'applicationReadinessProven':False,'logEncryptionAndRetentionProven':False,'effectiveAuthorizationProven':False,'ownerTelemetryAndRecoveryReviewRequired':True},sort_keys=True))
if __name__=='__main__':
    try: main()
    except Exception:
        print('Internet Monitor metadata check failed. Reconcile approved source/monitor/telemetry scope and read permissions; no monitoring or network changes were invoked.',file=sys.stderr);sys.exit(1)
`;
