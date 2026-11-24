import { error, type Finding } from '../core/findings.ts';
import type { Blueprint } from '../kit/blueprint.ts';
import { blk, dat, output, res, x } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule, awsServiceRegion } from './aws-service-module.ts';

export const AWS_ACM_SERVICE = {
  id: 'aws_service_acm', label: 'Request and DNS-validate a public TLS certificate',
  description: 'Issue a regional ACM certificate using an existing public Route 53 zone, including wildcard and alternative names.',
  emits: ['aws_acm_certificate', 'aws_route53_record', 'aws_acm_certificate_validation'],
  inputs: [
    awsServiceRegion,
    { id: 'domain', label: 'Primary certificate domain', control: 'text', hint: 'ASCII or Punycode domain, optionally beginning with *. All names must belong to the selected hosted zone.' },
    { id: 'alternatives', label: 'Alternative domain names', control: 'text', hint: 'Optional comma-separated names. This form supports up to ten total distinct domains.' },
    { id: 'zone', label: 'Existing public Route 53 hosted zone ID', control: 'text', hint: 'Its public name servers must be authoritative for the requested domains.' },
    { id: 'algorithm', label: 'Certificate key algorithm', control: 'select', default: 'RSA_2048', options: [{ value: 'RSA_2048', label: 'RSA 2048' }, { value: 'EC_prime256v1', label: 'ECDSA P-256' }, { value: 'EC_secp384r1', label: 'ECDSA P-384' }] },
  ],
  build(values) {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.acm.' + path, message, { path }));
    const domain = String(values.domain ?? '').trim().toLowerCase();
    const alternatives = [...new Set(String(values.alternatives ?? '').split(',').map(value => value.trim().toLowerCase()).filter(value => value && value !== domain))];
    const domains = [domain, ...alternatives], zone = String(values.zone ?? '').trim(), algorithm = String(values.algorithm ?? '');
    const validDomain = (value: string) => {
      const plain = value.replace(/^\*\./, '');
      return plain.length <= 253 && plain.includes('.') && plain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) && !/^\d+(?:\.\d+){3}$/.test(plain);
    };
    if (!validDomain(domain) || domain.length > 64) reject('domain', 'Enter a valid primary domain up to 64 characters, optionally with a leading wildcard.');
    if (domains.length > 10 || alternatives.some(value => !validDomain(value))) reject('alternatives', 'Enter valid alternative domains, up to ten total distinct names.');
    if (!/^Z[A-Z0-9]{2,31}$/.test(zone)) reject('zone', 'Enter an existing public Route 53 hosted zone ID.');
    if (!['RSA_2048', 'EC_prime256v1', 'EC_secp384r1'].includes(algorithm)) reject('algorithm', 'Select a supported certificate key algorithm.');
    return awsServiceModule(String(values.aws_region ?? ''), [
      dat('aws_route53_zone', 'validation', { zone_id: zone, private_zone: false }),
      res('aws_acm_certificate', 'configured', { domain_name: domain, subject_alternative_names: alternatives, validation_method: 'DNS', key_algorithm: algorithm }, [
        blk('lifecycle', { create_before_destroy: true }, [blk('precondition', {
          condition: x('alltrue([for domain in ' + JSON.stringify(domains) + ' : trimprefix(domain, "*.") == trimsuffix(data.aws_route53_zone.validation.name, ".") || endswith(trimprefix(domain, "*."), ".${trimsuffix(data.aws_route53_zone.validation.name, ".")}")])'),
          error_message: 'All certificate domains must belong to the selected public hosted zone. Verify any delegated child zones are authoritative.',
        })]),
      ]),
      res('aws_route53_record', 'validation', {
        for_each: x('{ for domain, records in { for option in aws_acm_certificate.configured.domain_validation_options : trimprefix(option.domain_name, "*.") => { name = option.resource_record_name, type = option.resource_record_type, value = option.resource_record_value }... } : domain => records[0] }'),
        zone_id: x('data.aws_route53_zone.validation.zone_id'), name: x('each.value.name'), type: x('each.value.type'), ttl: 60, records: x('[each.value.value]'), allow_overwrite: false,
      }),
      res('aws_acm_certificate_validation', 'configured', {
        certificate_arn: x('aws_acm_certificate.configured.arn'), validation_record_fqdns: x('[for record in aws_route53_record.validation : record.fqdn]'),
      }, [blk('timeouts', { create: '45m' })]),
      output('validated_certificate_arn', 'aws_acm_certificate_validation.configured.certificate_arn'),
    ], `# Public ACM certificate with DNS validation

## Prepare
Confirm ownership of every requested name, public DNS delegation, CAA authorization for Amazon issuance and regional ACM support. Select the region of the consuming regional service; CloudFront viewer certificates require us-east-1. This form uses one existing public Route 53 zone. Delegated subdomains may require their own authoritative zone. Wildcards cover one label and do not cover the apex automatically; include the apex explicitly when required.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review the names, public zone, key algorithm and validation records. Apply the saved plan. Identical wildcard/apex DNS validation records are deduplicated. Existing records are not overwritten; import a pre-existing validation record into the intended state or coordinate ownership before applying. Issuance can wait up to 45 minutes. A pending certificate is not ready for use.

## Verify
Confirm the certificate status is ISSUED and its SANs, algorithm and region match the application. Read validated_certificate_arn and use it in the consuming listener or service. Test the deployed endpoint with its actual hostname. Keep DNS validation records to support managed renewal, and monitor renewal and expiry. DNS validation does not create an application DNS record or HTTPS listener.

## Recovery
Keep the previous issued certificate attached until the replacement is validated and the endpoint passes testing. Correct DNS delegation or CAA records when issuance fails. Reattach the previous certificate if application validation fails. Review certificate associations before deletion and preserve validation records used by other certificates. Private CA, imported certificates and external DNS use their corresponding existing builders.

https://docs.aws.amazon.com/acm/latest/userguide/dns-validation.html
`, findings);
  },
} satisfies Blueprint;
