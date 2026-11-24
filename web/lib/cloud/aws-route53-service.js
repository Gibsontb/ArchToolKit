import { bool } from '../kit/blueprint.js';
import { error,              } from '../core/findings.js';
import { isIpv4Address, isIpv6 } from '../core/ip.js';
                                                     
import { blk, dat, output, res, x } from '../terraform/blueprints/migration/common.js';
import { quote,               } from '../terraform/hcl.js';
import { awsServiceModule, awsServiceRegion } from './aws-service-module.js';

const recordTypes = ['A', 'AAAA', 'CNAME', 'MX', 'TXT'];
const zoneIdPattern = /^Z[A-Z0-9]{1,31}$/;
const domain = (name        ) => name.length <= 253 && name.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
const recordOwner = (name        ) =>
  name === '@' || (name.length <= 253 && name.split('.').every((label, index) => (
    index === 0 && label === '*' || /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/i.test(label)
  )));
const aliasTypes = ['A', 'AAAA'];

export const AWS_ROUTE53_SERVICE            = {
  id: 'aws_service_route53',
  label: 'Set up a Route 53 hosted zone or record',
  description: 'Create a public or private hosted zone, or add one simple DNS record set to an existing hosted zone.',
  emits: ['aws_route53_zone', 'aws_route53_record'],
  inputs: [
    awsServiceRegion,
    { id: 'mode', label: 'DNS configuration', control: 'select', default: 'public', options: [
      { value: 'public', label: 'New public hosted zone' },
      { value: 'private', label: 'New private hosted zone' },
      { value: 'record', label: 'New standard record in an existing hosted zone' },
      { value: 'alias', label: 'New alias record in an existing hosted zone' },
    ] },
    { id: 'zone_name', label: 'Zone domain name', control: 'text', placeholder: 'example.com', showWhen: { input: 'mode', equals: ['public', 'private'] }, hint: 'Use ASCII or Punycode.' },
    { id: 'vpc_id', label: 'Existing VPC ID', control: 'text', showWhen: { input: 'mode', equals: ['private'] }, hint: 'Use a VPC in the selected region with DNS resolution and DNS hostnames enabled.' },
    { id: 'zone_id', label: 'Existing hosted zone ID', control: 'text', showWhen: { input: 'mode', equals: ['record', 'alias'] } },
    { id: 'owner', label: 'Record name relative to the zone', control: 'text', default: '@', showWhen: { input: 'mode', equals: ['record', 'alias'] }, hint: 'Use @ for the apex, www for www.example.com, or *.internal for a wildcard.' },
    { id: 'record_type', label: 'Record type', control: 'select', default: 'A', options: recordTypes.map(value => ({ value, label: value })), showWhen: { input: 'mode', equals: ['record'] } },
    { id: 'alias_type', label: 'Alias record type', control: 'select', default: 'A', options: aliasTypes.map(value => ({ value, label: value })), showWhen: { input: 'mode', equals: ['alias'] } },
    { id: 'ttl', label: 'TTL in seconds', control: 'number', default: 300, min: 0, max: 2147483647, showWhen: { input: 'mode', equals: ['record'] } },
    { id: 'records', label: 'Record values', control: 'textarea', showWhen: { input: 'mode', equals: ['record'] }, hint: 'One value per line. Use IPs for A/AAAA, a fully qualified hostname for CNAME, priority and fully qualified hostname for MX, or plain text for TXT.' },
    { id: 'alias_name', label: 'Alias target DNS name', control: 'text', showWhen: { input: 'mode', equals: ['alias'] } },
    { id: 'alias_zone', label: 'Alias target canonical hosted zone ID', control: 'text', showWhen: { input: 'mode', equals: ['alias'] }, hint: 'Use the eligible AWS target’s canonical zone ID or the same zone ID for another record in this hosted zone.' },
    { id: 'alias_health', label: 'Evaluate target health', control: 'toggle', default: false, showWhen: { input: 'mode', equals: ['alias'] }, hint: 'Leave disabled for targets that do not support health evaluation, including CloudFront.' },
  ],
  build(values) {
    const findings            = [];
    const reject = (path        , message        ) => findings.push(error('aws.route53.' + path, message, { path }));
    const location = String(values.aws_region ?? '');
    const mode = String(values.mode);
    const blocks             = [];

    if (mode === 'public' || mode === 'private') {
      const name = String(values.zone_name ?? '').trim().replace(/\.$/, '');
      const vpcId = String(values.vpc_id ?? '').trim();
      if (!domain(name) || !name.includes('.')) reject('zone_name', 'Enter a domain such as example.com, using ASCII or Punycode.');
      if (mode === 'private' && !/^vpc-(?:[0-9a-f]{8}|[0-9a-f]{17})$/.test(vpcId)) reject('vpc_id', 'Enter an existing VPC ID.');
      blocks.push(
        res('aws_route53_zone', 'configured', { name, force_destroy: false },
          mode === 'private' ? [blk('vpc', { vpc_id: vpcId, vpc_region: location })] : []),
        output('hosted_zone_id', 'aws_route53_zone.configured.zone_id'),
      );
      if (mode === 'public') blocks.push(output('authoritative_name_servers', 'aws_route53_zone.configured.name_servers'));
    } else if (mode === 'record' || mode === 'alias') {
      const zoneId = String(values.zone_id ?? '').trim();
      const owner = String(values.owner ?? '').trim();
      const type = String(mode === 'alias' ? values.alias_type : values.record_type);
      if (!zoneIdPattern.test(zoneId)) reject('zone_id', 'Enter an existing Route 53 hosted zone ID.');
      if (!recordOwner(owner)) reject('owner', 'Enter @ or a name relative to the zone without a trailing dot.');
      if (!(mode === 'alias' ? aliasTypes : recordTypes).includes(type)) reject(mode === 'alias' ? 'alias_type' : 'record_type', 'Select a supported record type.');
      const zone = 'data.aws_route53_zone.selected';
      const name = x(owner === '@' ? zone + '.name' : 'join(".", [' + quote(owner) + ', ' + zone + '.name])');
      const attrs = { zone_id: x(zone + '.zone_id'), name, type, allow_overwrite: false };
      blocks.push(dat('aws_route53_zone', 'selected', { zone_id: zoneId }));
      const ownerLength = owner === '@' ? 0 : owner.length + 1;
      const recordChecks = [blk('lifecycle', {}, [blk('precondition', {
        condition: x('length(trimsuffix(' + zone + '.name, ".")) + ' + ownerLength + ' <= 253'),
        error_message: 'The combined record name and hosted zone exceed the DNS name length limit.',
      })])];
      if (mode === 'alias') {
        const target = String(values.alias_name ?? '').trim().replace(/\.$/, '');
        const targetZone = String(values.alias_zone ?? '').trim();
        if (!domain(target) || !target.includes('.')) reject('alias_name', 'Enter the full DNS name of an eligible alias target.');
        if (!zoneIdPattern.test(targetZone)) reject('alias_zone', 'Enter the alias target canonical hosted zone ID.');
        const evaluateHealth = bool(values, 'alias_health');
        if (evaluateHealth && /(?:^|\.)cloudfront\.net$/i.test(target)) reject('alias_health', 'CloudFront alias records cannot evaluate target health.');
        blocks.push(res('aws_route53_record', 'configured', attrs, [
          blk('alias', { name: target, zone_id: targetZone, evaluate_target_health: evaluateHealth }),
          ...recordChecks,
        ]));
      } else {
        const ttl = Number(values.ttl);
        if (String(values.ttl ?? '').trim() === '' || !Number.isInteger(ttl) || ttl < 0 || ttl > 2147483647) reject('ttl', 'Enter a whole number from 0 to 2147483647.');
        const records = [...new Set(String(values.records ?? '').split(/\r?\n/).map(value => type === 'TXT' ? value : value.trim()).filter(Boolean))];
        if (!records.length) reject('records', 'Enter at least one record value.');
        const fqdn = (value        ) => value.endsWith('.') && domain(value.slice(0, -1)) && value.slice(0, -1).includes('.');
        if (type === 'A' && records.some(value => !isIpv4Address(value))) reject('records', 'Enter IPv4 addresses for an A record.');
        if (type === 'AAAA' && records.some(value => !isIpv6(value))) reject('records', 'Enter IPv6 addresses for an AAAA record.');
        if (type === 'CNAME' && (owner === '@' || records.length !== 1 || !fqdn(records[0] ?? ''))) reject('records', 'A CNAME requires a subdomain and one fully qualified hostname ending in a dot.');
        if (type === 'MX' && records.some(value => {
          const match = /^(\d{1,5})\s+(\S+)$/.exec(value);
          return !match || Number(match[1]) > 65535 || !fqdn(match[2] ?? '');
        })) reject('records', 'Enter MX priority (0–65535) and a fully qualified hostname ending in a dot.');
        if (type === 'TXT' && records.some(value => !/^[\x20-\x7e]{1,255}$/.test(value) || /["\\]/.test(value))) reject('records', 'Use 1–255 printable ASCII characters per TXT value, excluding quotes and backslashes.');
        blocks.push(res('aws_route53_record', 'configured', {
          ...attrs, ttl,
          records,
        }, recordChecks));
      }
      blocks.push(output('record_fqdn', 'aws_route53_record.configured.fqdn'));
    } else reject('mode', 'Select a hosted zone or record configuration.');

    return awsServiceModule(location, blocks, `# Route 53 hosted zone and DNS records

Confirm the AWS account and partition. For a private zone, verify the selected VPC and its DNS attributes. For a record, verify the existing zone ID, inspect its record sets for collisions, and confirm an alias target supports the requested address family and health evaluation. Manage an existing record by importing it into state before applying changes.

Run terraform init, terraform validate, and terraform plan -out=service.tfplan. Confirm the zone or record, TTL, target and state before applying the saved plan. For a new public zone, populate required record sets and test the authoritative servers directly before delegating the domain at its registrar or parent zone. Export the old DNS records and record the current delegation before cutover.

Verify public answers against the new authoritative servers and then against ordinary recursive resolvers after the delegation or record propagates. Verify private answers from an associated VPC using its VPC resolver. If the change breaks resolution, restore the previous record or delegation and allow the old TTL to expire. Keep the previous zone active until rollback is no longer needed. Hosted zone destruction does not force deletion of pre-existing records.

https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/Welcome.html
`, findings);
  },
};
