import { bool } from '../kit/blueprint.ts';
import { error, type Finding } from '../core/findings.ts';
import { formatCidrAny, parseCidrAny } from '../core/ip.ts';
import type { Blueprint } from '../kit/blueprint.ts';
import { blk, output, res, x } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.ts';

const managed = [
  { value: 'AWSManagedRulesCommonRuleSet', label: 'Core rule set' },
  { value: 'AWSManagedRulesKnownBadInputsRuleSet', label: 'Known bad inputs' },
  { value: 'AWSManagedRulesSQLiRuleSet', label: 'SQL injection' },
  { value: 'AWSManagedRulesAmazonIpReputationList', label: 'Amazon IP reputation' },
  { value: 'AWSManagedRulesAnonymousIpList', label: 'Anonymous IP addresses' },
];
export const AWS_WAF_SERVICE = {
  id: 'aws_service_wafv2', label: 'Set up a WAFv2 managed-rule web ACL',
  description: 'Configure an AWS managed-rule baseline for regional resources or CloudFront, optionally associating an existing regional ALB.',
  emits: ['aws_wafv2_web_acl', 'aws_wafv2_web_acl_association', 'aws_wafv2_ip_set'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Web ACL name', control: 'text' },
    { id: 'scope', label: 'Protected resource scope', control: 'select', default: 'REGIONAL', options: [{ value: 'REGIONAL', label: 'Regional' }, { value: 'CLOUDFRONT', label: 'CloudFront — create in us-east-1' }] },
    { id: 'default_action', label: 'Default request action', control: 'select', default: 'allow', options: [{ value: 'allow', label: 'Allow requests not matched by a blocking rule' }, { value: 'block', label: 'Block requests not otherwise allowed' }] },
    { id: 'ip_version', label: 'Allowlist IP family', control: 'select', default: 'IPV4', options: [{ value: 'IPV4', label: 'IPv4' }, { value: 'IPV6', label: 'IPv6' }], showWhen: { input: 'default_action', equals: ['block'] } },
    { id: 'allowed', label: 'Allowed client CIDRs', control: 'text', hint: 'Comma-separated networks for the selected IP family. Default Block requires a nonempty allowlist; /0 is unsupported.', showWhen: { input: 'default_action', equals: ['block'] } },
    { id: 'rules', label: 'AWS managed rule groups', control: 'checklist', default: 'AWSManagedRulesCommonRuleSet,AWSManagedRulesKnownBadInputsRuleSet', options: managed },
    { id: 'count', label: 'Evaluate managed rules in count mode', control: 'toggle', default: true, hint: 'Count mode records rule matches without applying their blocking actions. Review traffic before disabling.' },
    { id: 'samples', label: 'Enable sampled requests', control: 'toggle', default: false, hint: 'Samples can contain request content. Select according to the approved data-handling policy.' },
    { id: 'alb', label: 'Existing Application Load Balancer ARN', control: 'text', showWhen: { input: 'scope', equals: ['REGIONAL'] }, hint: 'Optional ALB in this account and region. Review any existing web ACL association before replacement.' },
  ],
  build(values) {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.wafv2.' + path, message, { path }));
    const location = String(values.aws_region ?? ''), partition = awsServicePartition(location), name = String(values.name ?? ''), scope = String(values.scope ?? ''), action = String(values.default_action ?? ''), alb = String(values.alb ?? '').trim();
    const rules = [...new Set(String(values.rules ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(name)) reject('name', 'Use 1–100 letters, numbers, hyphens or underscores.');
    if (!['REGIONAL', 'CLOUDFRONT'].includes(scope)) reject('scope', 'Select a protected resource scope.');
    if (scope === 'CLOUDFRONT' && location !== 'us-east-1') reject('aws_region', 'CloudFront web ACLs must be created in us-east-1.');
    if (!['allow', 'block'].includes(action)) reject('default_action', 'Select a default action.');
    const ipVersion = String(values.ip_version ?? ''), addresses: string[] = [];
    if (action === 'block') {
      if (!['IPV4', 'IPV6'].includes(ipVersion)) reject('ip_version', 'Select an allowlist IP family.');
      const allowed = [...new Set(String(values.allowed ?? '').split(',').map(value => value.trim()).filter(Boolean))];
      if (!allowed.length || allowed.length > 10000) reject('allowed', 'Enter 1–10,000 approved client CIDRs.');
      for (const cidr of allowed) {
        const parsed = parseCidrAny(cidr);
        if (!parsed || parsed.prefix === 0 || parsed.family !== (ipVersion === 'IPV6' ? 6 : 4)) reject('allowed', 'Use valid CIDRs in the selected family with a nonzero prefix.');
        else addresses.push(formatCidrAny(parsed));
      }
    }
    if (!rules.length || rules.some(rule => !managed.some(option => option.value === rule))) reject('rules', 'Select at least one supported AWS managed rule group.');
    if (scope === 'REGIONAL' && alb && !new RegExp('^arn:' + partition + ':elasticloadbalancing:' + location + ':\\d{12}:loadbalancer/app/[A-Za-z0-9-]+/[a-f0-9]+$').test(alb)) reject('alb', 'Use an Application Load Balancer ARN in the selected region and partition.');
    const visibility = (metric: string) => blk('visibility_config', { cloudwatch_metrics_enabled: true, metric_name: metric, sampled_requests_enabled: bool(values, 'samples') });
    return awsServiceModule(location, [
      ...(action === 'block' ? [res('aws_wafv2_ip_set', 'allowed', { name: name + '-allowed', scope, ip_address_version: ipVersion, addresses })] : []),
      res('aws_wafv2_web_acl', 'configured', { name, scope }, [
        blk('default_action', {}, [blk(action === 'block' ? 'block' : 'allow', {})]), visibility(name),
        ...rules.map((rule, priority) => blk('rule', { name: rule, priority }, [
          blk('override_action', {}, [blk(bool(values, 'count') ? 'count' : 'none', {})]),
          blk('statement', {}, [blk('managed_rule_group_statement', { name: rule, vendor_name: 'AWS' })]), visibility(name + '-' + priority),
        ])),
        ...(action === 'block' ? [blk('rule', { name: 'AllowedClients', priority: rules.length }, [blk('action', {}, [blk('allow', {})]), blk('statement', {}, [blk('ip_set_reference_statement', { arn: x('aws_wafv2_ip_set.allowed.arn') })]), visibility(name + '-allowed')])] : []),
      ]),
      ...(scope === 'REGIONAL' && alb ? [res('aws_wafv2_web_acl_association', 'configured', { resource_arn: alb, web_acl_arn: x('aws_wafv2_web_acl.configured.arn') })] : []),
      output('web_acl_arn', 'aws_wafv2_web_acl.configured.arn'),
    ], `# WAFv2 AWS managed-rule baseline

## Prepare
Confirm managed-rule availability, capacity units, pricing and service support in the selected region or partition. Review existing web ACL associations. This baseline defaults to Allow and evaluates selected AWS rule groups in Count mode. It is not enforcing those groups until Count mode is disabled. Default Block requires an explicit IP allowlist and enforces that allowlist even in managed-rule Count mode. Managed groups evaluate before the client allow rule. The allowlist uses the request source address; review proxy/client address behavior for the protected resource. Sampled requests are off unless selected. Define logging, redaction and retention using the existing logging resource builder when required.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review resource scope, selected rules, count/enforcement behavior and any ALB association. Apply the saved plan. A regional ALB association can replace its existing web ACL; coordinate the change and retain its prior ARN. For CloudFront, create this ACL in us-east-1 and attach web_acl_arn through the distribution's own configuration after review. A standalone ACL protects no resource until associated.

## Verify
Send representative permitted and malicious test requests in an approved environment. Inspect rule-match and request metrics. Review false positives and application behavior before turning Count mode off. Validate body-size handling and oversize behavior for the selected managed groups and resource type. Confirm normal traffic and required uploads still work when enforcing. Managed rule updates can change matches; establish review and monitoring for those updates.

## Recovery
Return managed groups to Count mode while investigating false positives, or restore the preceding ACL association through the owning resource configuration. Keep required evidence according to policy. This form is an AWS managed-rule baseline; custom allowlists, rate-based rules, bot/fraud controls, logging and other resource associations use their corresponding existing builders.

https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups.html
`, findings);
  },
} satisfies Blueprint;
