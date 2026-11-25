export const networkMonitorInspection=String.raw`#!/usr/bin/env python3
"""Read-only source network and probe metadata. Never sends packets or creates probes."""
import argparse,ipaddress,json,re,sys
from pathlib import Path
import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
def require(ok,message):
    if not ok: raise ValueError(message)
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--probe');args=parser.parse_args()
    if args.probe: require(re.fullmatch(r'probe-[A-Za-z0-9-]{21,64}',args.probe),'Invalid actual probe ID')
    c=json.loads(Path(__file__).with_name('NETWORK-CONFIG.json').read_text())
    session=boto3.Session(region_name=c['region']);cfg=Config(use_fips_endpoint=True,retries={'mode':'standard','max_attempts':3})
    require(session.client('sts',config=cfg).get_caller_identity()['Account']==c['account'],'Wrong source/monitor owner account')
    ec2=session.client('ec2',config=cfg);client=session.client('networkmonitor',config=cfg)
    rows=ec2.describe_subnets(SubnetIds=[c['subnet']])['Subnets'];require(len(rows)==1,'Expected exact source subnet');s=rows[0]
    require(s.get('SubnetId')==c['subnet'] and s.get('OwnerId')==c['account'] and s.get('State')=='available' and not s.get('MapPublicIpOnLaunch') and not s.get('Ipv6Native') and not s.get('OutpostArn') and s.get('AvailableIpAddressCount',0)>=6,'Source owner/private regional subnet/IP planning floor mismatch')
    require(re.fullmatch(re.escape(c['region'])+r'[a-z]',s.get('AvailabilityZone','')),'Local/Wavelength source zones require separate qualification')
    vpc=s['VpcId'];rows=ec2.describe_vpcs(VpcIds=[vpc])['Vpcs'];require(len(rows)==1 and rows[0].get('OwnerId')==c['account'] and rows[0].get('State')=='available','Source VPC owner/state mismatch');v=rows[0]
    destination=ipaddress.ip_address(c['destination'])
    require(destination.version==4 and any(destination in ipaddress.ip_network(n) for n in ['10.0.0.0/8','172.16.0.0/12','192.168.0.0/16']) and str(destination)!='10.0.0.2','Expected approved RFC1918 IPv4 destination')
    cidrs={v['CidrBlock']}|{a['CidrBlock'] for a in v.get('CidrBlockAssociationSet',[]) if a.get('CidrBlockState',{}).get('State')=='associated'}
    require(all(destination not in ipaddress.ip_network(cidr) for cidr in cidrs),'Initial hybrid probe destination must be outside all source VPC CIDRs')
    routes=ec2.describe_route_tables(Filters=[{'Name':'association.subnet-id','Values':[c['subnet']]}])['RouteTables']
    if not routes: routes=ec2.describe_route_tables(Filters=[{'Name':'vpc-id','Values':[vpc]},{'Name':'association.main','Values':['true']}])['RouteTables']
    require(len(routes)==1 and routes[0].get('VpcId')==vpc and routes[0].get('OwnerId')==c['account'],'Ambiguous/foreign effective route table')
    candidates=[]
    for route in routes[0].get('Routes',[]):
        require(not str(route.get('GatewayId','')).startswith('igw-'),'Source subnet has an unreviewed direct internet gateway route')
        cidr=route.get('DestinationCidrBlock')
        if cidr and destination in ipaddress.ip_network(cidr): candidates.append((ipaddress.ip_network(cidr).prefixlen,route))
    require(candidates,'No IPv4 CIDR route to approved hybrid destination; prefix-list-only paths need separate review')
    best=max(candidates,key=lambda item:item[0])[1];require(best.get('State')=='active','Selected longest-prefix route is not active')
    require(any(best.get(key) for key in ['TransitGatewayId','GatewayId','NetworkInterfaceId','InstanceId','VpcPeeringConnectionId','CoreNetworkArn']),'Expected approved routed hybrid path; NAT/default internet path is outside initial scope')
    try: monitor=client.get_monitor(monitorName=c['name'])
    except ClientError as error:
        require(not args.probe and error.response.get('Error',{}).get('Code')=='ResourceNotFoundException','Monitor lookup failed; absence not established')
        print(json.dumps({'preflightMetadataVerified':True,'existingMonitor':False,'routeTable':routes[0]['RouteTableId'],'connectivityProven':False,'ownerTrafficFirewallAndServiceRoleApprovalRequired':True}));return
    require(args.probe,'Monitor already exists; reconcile instead of implicitly adopting')
    arn='arn:aws:networkmonitor:'+c['region']+':'+c['account']+':monitor/'+c['name']
    require(monitor.get('monitorName')==c['name'] and monitor.get('monitorArn')==arn and monitor.get('state')=='ACTIVE' and monitor.get('aggregationPeriod')==c['aggregation'],'Monitor identity/state/aggregation mismatch')
    probes=monitor.get('probes',[]);require(len(probes)==1 and probes[0].get('probeId')==args.probe,'Expected exactly the generated probe, no extra traffic sources')
    probe=client.get_probe(monitorName=c['name'],probeId=args.probe)
    for p in [probes[0],probe]:
        require(p.get('probeId')==args.probe and p.get('probeArn')=='arn:aws:networkmonitor:'+c['region']+':'+c['account']+':probe/'+args.probe and p.get('state')=='ACTIVE' and p.get('sourceArn')==c['sourceArn'] and p.get('vpcId')==vpc and p.get('destination')==c['destination'] and p.get('protocol')==c['protocol'] and p.get('addressFamily')=='IPV4' and p.get('packetSize')==c['packet'],'Probe source/destination/identity/state/settings mismatch')
        require(p.get('destinationPort')==c['port'] if c['protocol']=='TCP' else p.get('destinationPort') in [None,0],'Unexpected destination port')
    print(json.dumps({'probeMetadataVerified':True,'probe':args.probe,'protocol':c['protocol'],'connectivityProven':False,'metricCompletenessProven':False,'applicationReadinessProven':False,'ownerMetricsFirewallAndRecoveryReviewRequired':True},sort_keys=True))
if __name__=='__main__':
    try: main()
    except Exception:
        print('Network Synthetic Monitor metadata check failed. Reconcile approved network/probe scope and read permissions; no active probe or network changes were invoked.',file=sys.stderr);sys.exit(1)
`;
