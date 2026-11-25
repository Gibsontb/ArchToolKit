/** Read-only metadata checks. Acceptance and routing stay under owner change control. */
export const cloudWanInspection=String.raw`import argparse
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
        page = getattr(client, method)(**kwargs, **({'NextToken': token} if token else {}))
        result.extend(page.get(field, []))
        token = page.get('NextToken')
        if not token:
            return result
        require(token not in seen, 'Repeated pagination token; inspection incomplete')
        seen.add(token)
    raise RuntimeError('Pagination limit exceeded; inspection incomplete')

def main():
    parser = argparse.ArgumentParser(description='Read-only Cloud WAN owner/network/policy/attachment metadata inspection')
    parser.add_argument('--core', help='Exact core_network_id output')
    parser.add_argument('--global-id', help='Exact global_network_id output')
    parser.add_argument('--attachment', help='Exact attachment_id output, required for a VPC postcheck')
    parser.add_argument('--require-available', action='store_true', help='Require separately accepted AVAILABLE attachment instead of pending acceptance')
    args = parser.parse_args()
    require(bool(args.core) == bool(args.global_id), 'Supply both core and global IDs')
    require(not args.attachment or args.core, 'Attachment postcheck requires core/global IDs')
    require(not args.require_available or args.attachment, 'Availability check requires exact attachment ID')
    root = Path(__file__).resolve().parent
    c = json.loads((root/'NETWORK-CONFIG.json').read_text())
    desired = json.loads((root/'CORE-POLICY.json').read_text())
    session = boto3.Session(region_name=c['region'])
    config = Config(use_fips_endpoint=True, retries={'mode': 'standard', 'total_max_attempts': 3})
    sts = session.client('sts', region_name=c['region'], config=config)
    require(sts.get_caller_identity()['Account'] == c['account'], 'Wrong AWS account')
    vpc_arn = None
    subnet_arns = []
    if c['attachment'] == 'vpc':
        ec2 = session.client('ec2', region_name=c['region'], config=config)
        vpcs = ec2.describe_vpcs(VpcIds=[c['vpc']]).get('Vpcs', [])
        require(len(vpcs) == 1, 'Require exactly one selected VPC')
        vpc = vpcs[0]
        require(vpc.get('VpcId') == c['vpc'] and vpc.get('OwnerId') == c['account'] and vpc.get('State') == 'available', 'Wrong/unavailable VPC')
        for attribute, key in [('enableDnsSupport', 'EnableDnsSupport'), ('enableDnsHostnames', 'EnableDnsHostnames')]:
            response = ec2.describe_vpc_attribute(VpcId=c['vpc'], Attribute=attribute)
            require(response.get(key, {}).get('Value') is True, 'VPC DNS support/hostnames required')
        subnets = ec2.describe_subnets(SubnetIds=c['subnets']).get('Subnets', [])
        require(len(subnets) == len(c['subnets']) and {s.get('SubnetId') for s in subnets} == set(c['subnets']), 'Missing/duplicate subnet metadata')
        require(len({s.get('AvailabilityZoneId') for s in subnets}) == len(subnets) and all(s.get('AvailabilityZoneId') for s in subnets), 'Require distinct actual Availability Zones')
        for s in subnets:
            require(s.get('OwnerId') == c['account'] and s.get('VpcId') == c['vpc'] and s.get('State') == 'available', 'Wrong/unavailable subnet')
            require(s.get('MapPublicIpOnLaunch') is False and not s.get('Ipv6Native') and not s.get('OutpostArn'), 'Require ordinary private IPv4 regional subnets')
            require(s.get('AvailableIpAddressCount', 0) >= (1 if args.core else 3), 'Insufficient subnet address headroom')
            expected = 'arn:aws:ec2:'+c['region']+':'+c['account']+':subnet/'+s['SubnetId']
            require(s.get('SubnetArn') == expected, 'Unexpected subnet ARN')
            subnet_arns.append(expected)
        vpc_arn = 'arn:aws:ec2:'+c['region']+':'+c['account']+':vpc/'+c['vpc']
    if not args.core:
        print('Account and selected VPC metadata checked. Quotas, costs, route/security/authorization and new network plan still require owner review.')
        return
    require(re.fullmatch(r'core-network-[0-9a-f]{8,17}', args.core) is not None and re.fullmatch(r'global-network-[0-9a-f]{8,17}', args.global_id) is not None, 'Invalid exact output IDs')
    nm = session.client('networkmanager', region_name='us-west-2', config=config)
    core = nm.get_core_network(CoreNetworkId=args.core)['CoreNetwork']
    arn = 'arn:aws:networkmanager::'+c['account']+':core-network/'+args.core
    require(core.get('CoreNetworkId') == args.core and core.get('CoreNetworkArn') == arn and core.get('GlobalNetworkId') == args.global_id and core.get('State') == 'AVAILABLE', 'Wrong/unavailable owner core/global network')
    require(core.get('Description') == c['name'] and not core.get('NetworkFunctionGroups'), 'Unexpected core configuration')
    edges = core.get('Edges', [])
    require(len(edges) == len(c['edges']) and {e.get('EdgeLocation') for e in edges} == set(c['edges']), 'Actual core edges differ')
    asns = [e.get('Asn') for e in edges]
    require(all(isinstance(a, int) and c['start'] <= a <= c['end'] for a in asns) and len(set(asns)) == len(asns), 'Unexpected/reused actual edge ASN')
    segments = core.get('Segments', [])
    require(len(segments) == len(c['segments']) and {s.get('Name') for s in segments} == set(c['segments']) and all(not s.get('SharedSegments') for s in segments), 'Unexpected/shared actual core segments')
    policy = nm.get_core_network_policy(CoreNetworkId=args.core, Alias='LIVE')['CoreNetworkPolicy']
    require(policy.get('CoreNetworkId') == args.core and policy.get('Alias') == 'LIVE' and not policy.get('PolicyErrors') and json.loads(policy['PolicyDocument']) == desired, 'LIVE policy mismatch/error')
    attachments = pages(nm, 'list_attachments', 'Attachments', CoreNetworkId=args.core, MaxResults=100)
    if c['attachment'] == 'none':
        require(not args.attachment and not attachments, 'Unexpected attachment on core-only network')
        print('Exact AVAILABLE core/edges/ASNs/isolated LIVE policy checked; no attachments. Data-plane/approval not proven.')
        return
    require(args.attachment and re.fullmatch(r'attachment-[0-9a-f]{8,17}', args.attachment) is not None, 'Supply exact attachment output')
    require(len(attachments) == 1 and attachments[0].get('AttachmentId') == args.attachment, 'Unexpected/missing core attachment')
    response = nm.get_vpc_attachment(AttachmentId=args.attachment)['VpcAttachment']
    a = response['Attachment']
    require(a.get('AttachmentId') == args.attachment and a.get('CoreNetworkId') == args.core and a.get('CoreNetworkArn') == arn and a.get('AttachmentType') == 'VPC' and a.get('OwnerAccountId') == c['account'] and a.get('ResourceArn') == vpc_arn and a.get('EdgeLocation') == c['region'], 'Wrong attachment identity/owner/VPC/region')
    require(not a.get('LastModificationErrors') and not a.get('NetworkFunctionGroupName') and not a.get('ProposedNetworkFunctionGroupChange'), 'Attachment error/network-function change needs owner review')
    require(a.get('State') == ('AVAILABLE' if args.require_available else 'PENDING_ATTACHMENT_ACCEPTANCE'), 'Attachment is not in requested stable state')
    rule = next(r for r in desired['attachment-policies'] if r['action']['segment'] == c['segment'] and any(t['type'] == 'region' and t['value'] == c['region'] for t in r['conditions']))
    proposed = a.get('ProposedSegmentChange')
    if proposed:
        require(not args.require_available and proposed.get('SegmentName') == c['segment'] and proposed.get('AttachmentPolicyRuleNumber') == rule['rule-number'] and not a.get('SegmentName'), 'Unexpected proposed segment/rule or existing association')
    else:
        require(a.get('SegmentName') == c['segment'] and a.get('AttachmentPolicyRuleNumber') == rule['rule-number'], 'Attachment segment/rule mismatch')
    require({t['Key']:t['Value'] for t in a.get('Tags', [])}.get('stage') == c['segment'], 'Attachment tag mismatch')
    require(set(response.get('SubnetArns', [])) == set(subnet_arns) and len(response.get('SubnetArns', [])) == len(subnet_arns), 'Attachment subnet mismatch')
    options = response.get('Options', {})
    require(options.get('ApplianceModeSupport') is False and options.get('Ipv6Support') is False and options.get('SecurityGroupReferencingSupport', False) is False, 'Unexpected attachment options')
    print('Exact core/LIVE policy/VPC attachment checked: '+a['State']+'. No accept, policy, route or traffic changes made. Effective routing/isolation/authorization still require owner tests.')

if __name__ == '__main__':
    main()
`;
