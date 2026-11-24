import { error, type Finding } from '../core/findings.ts';
import type { Blueprint } from '../kit/blueprint.ts';
import { blk, output, res, variable, x } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.ts';

export const AWS_PARAMETER_SERVICE = {
  id: 'aws_service_parameter', label: 'Set up a Parameter Store parameter',
  description: 'Create a String, StringList or encrypted SecureString parameter with explicit tier and deployment-time secret input.',
  emits: ['aws_ssm_parameter'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Parameter name or path', control: 'text', hint: 'For example /production/orders/api-url. This form supports up to 900 characters and 15 hierarchy levels.' },
    { id: 'description', label: 'Description', control: 'text' },
    { id: 'type', label: 'Parameter type', control: 'select', default: 'String', options: [{ value: 'String', label: 'String — non-secret text' }, { value: 'StringList', label: 'StringList — non-secret comma-separated values' }, { value: 'SecureString', label: 'SecureString — supply secret during deployment' }] },
    { id: 'value', label: 'Non-secret parameter value', control: 'textarea', showWhen: { input: 'type', equals: ['String', 'StringList'] } },
    { id: 'tier', label: 'Parameter tier', control: 'select', default: 'Standard', options: [{ value: 'Standard', label: 'Standard — up to 4 KiB' }, { value: 'Advanced', label: 'Advanced — up to 8 KiB, additional charges' }] },
    { id: 'kms', label: 'Existing KMS key ARN', control: 'text', showWhen: { input: 'type', equals: ['SecureString'] }, hint: 'Optional regional symmetric encryption key. Blank uses the Systems Manager managed key.' },
  ],
  build(values) {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.parameter.' + path, message, { path }));
    const name = String(values.name ?? ''), description = String(values.description ?? ''), type = String(values.type ?? ''), tier = String(values.tier ?? ''), value = String(values.value ?? ''), kms = String(values.kms ?? '').trim();
    const location = String(values.aws_region ?? ''), partition = awsServicePartition(location), secure = type === 'SecureString';
    if (!/^\/?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(name) || name.length > 900 || name.replace(/^\//, '').split('/').length > 15 || /^\/?(?:aws|ssm)/i.test(name) || (name.includes('/') && !name.startsWith('/'))) reject('name', 'Enter an absolute hierarchical path or a simple name, up to 900 characters and 15 levels, without reserved aws/ssm prefixes.');
    if (description.length > 1024) reject('description', 'Keep the description within 1024 characters.');
    if (!['String', 'StringList', 'SecureString'].includes(type)) reject('type', 'Select a parameter type.');
    if (!['Standard', 'Advanced'].includes(tier)) reject('tier', 'Select a parameter tier.');
    if (!secure) {
      const bytes = new TextEncoder().encode(value).length;
      if (!bytes || bytes > (tier === 'Advanced' ? 8192 : 4096) || /\{\{.*?\}\}/s.test(value)) reject('value', 'Enter a nonempty value within the tier size limit, without nested parameter references.');
      if (type === 'StringList' && value.split(',').some(item => !item.trim())) reject('value', 'Use nonempty comma-separated list values. Commas within a list item are unsupported.');
    }
    if (secure && kms && !new RegExp('^arn:' + partition + ':kms:' + location + ':\\d{12}:key/[A-Za-z0-9-]+$').test(kms)) reject('kms', 'Use a KMS key ARN in the selected partition and region.');
    return awsServiceModule(location, [
      ...(secure ? [variable('secure_parameter_value', 'string', 'Supply securely during deployment. Terraform state and saved plans can contain this value; do not commit it.', { sensitive: true, nullable: false })] : []),
      res('aws_ssm_parameter', 'configured', { name, description, type, tier, data_type: 'text', value: secure ? x('var.secure_parameter_value') : value, ...(secure && kms ? { key_id: kms } : {}) }, [blk('lifecycle', { prevent_destroy: true })]),
      output('parameter_arn', 'aws_ssm_parameter.configured.arn'), output('parameter_version', 'aws_ssm_parameter.configured.version'),
    ], `# Systems Manager Parameter Store

## Prepare
Choose the approved account, region, hierarchy, type and tier. Non-secret text values are included in the generated files. SecureString values are supplied through the sensitive secure_parameter_value deployment input and are never entered in this form. Secure Terraform state and saved plans because they can contain the secret. Confirm existing parameter ownership and import an existing parameter before managing it; this form does not overwrite an unrelated parameter automatically.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. For SecureString, supply secure_parameter_value through the approved secret-injection mechanism. Respect the selected tier's 4 KiB or 8 KiB limit and Parameter Store value restrictions. Review IAM and KMS access, then apply the saved plan. Parameter updates create versions. Advanced-to-Standard downgrade is unsupported; replacing or deleting this parameter is blocked by prevent_destroy until explicitly reviewed.

## Verify
Use describe-parameters to inspect metadata and version. Test retrieval from the intended application role. SecureString consumers need authorized ssm:GetParameter and KMS decryption access; avoid logging decrypted values. Test denied access from an unauthorized principal. StringList consumers receive a comma-separated value. Applications must refresh cached values according to their own configuration behavior.

## Recovery
Keep the previous approved value through the application's rollback window. An authorized operator can retrieve a retained prior version and publish it as a new current version; do not expose it in logs. Parameter version history is bounded and is not a backup system. Coordinate external credential changes before reverting secrets. Parameter policies, labels, sharing and automatic credential rotation use their corresponding existing builders or Secrets Manager.

https://docs.aws.amazon.com/systems-manager/latest/userguide/systems-manager-parameter-store.html
`, findings);
  },
} satisfies Blueprint;
