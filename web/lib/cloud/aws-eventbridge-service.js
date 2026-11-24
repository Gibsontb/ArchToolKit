import { bool } from '../kit/blueprint.js';
import { error,              } from '../core/findings.js';
                                                     
import { blk, dat, e, jsonencode, output, res, x } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule, awsServiceRegion } from './aws-service-module.js';

export const AWS_EVENTBRIDGE_SERVICE = {
  id: 'aws_service_eventbridge', label: 'Route EventBridge events to Lambda',
  description: 'Configure a matching rule on a new or existing event bus, scoped Lambda permission and an optional new dead-letter queue.',
  emits: ['aws_cloudwatch_event_bus', 'aws_cloudwatch_event_rule', 'aws_cloudwatch_event_target', 'aws_lambda_permission', 'aws_sqs_queue', 'aws_sqs_queue_policy'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Rule name', control: 'text' },
    { id: 'bus_mode', label: 'Event bus', control: 'select', default: 'existing', options: [{ value: 'existing', label: 'Existing event bus' }, { value: 'new', label: 'Create a custom event bus' }] },
    { id: 'bus_name', label: 'Event bus name', control: 'text', default: 'default' },
    { id: 'pattern', label: 'Event pattern (JSON)', control: 'textarea', default: '{\n  "source": ["com.example.orders"],\n  "detail-type": ["OrderCreated"]\n}', hint: 'Match the producer event envelope. Verify the pattern with EventBridge TestEventPattern before deployment.' },
    { id: 'function_name', label: 'Existing Lambda target name', control: 'text', hint: 'Function in this deployment account and region. Its handler must accept the original EventBridge event envelope.' },
    { id: 'attempts', label: 'Maximum delivery retries', control: 'number', default: 185, min: 0, max: 185 },
    { id: 'age', label: 'Maximum event age (seconds)', control: 'number', default: 86400, min: 60, max: 86400 },
    { id: 'dlq', label: 'Create an encrypted delivery dead-letter queue', control: 'toggle', default: true },
    { id: 'enabled', label: 'Enable the rule', control: 'toggle', default: true },
  ],
  build(values) {
    const findings            = [];
    const reject = (path        , message        ) => findings.push(error('aws.eventbridge.' + path, message, { path }));
    const name = String(values.name ?? ''), bus = String(values.bus_name ?? ''), mode = String(values.bus_mode ?? ''), fn = String(values.function_name ?? '');
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) reject('name', 'Use 1–64 letters, numbers, dots, hyphens or underscores.');
    if (!['existing', 'new'].includes(mode)) reject('bus_mode', 'Select an event bus option.');
    if (!/^[A-Za-z0-9_.-]{1,256}$/.test(bus) || (mode === 'new' && (bus === 'default' || bus.startsWith('aws.')))) reject('bus_name', 'Enter a bus name. New custom buses cannot use default or an aws. prefix.');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(fn)) reject('function_name', 'Enter an existing Lambda function name.');
    let pattern         ;
    try { pattern = JSON.parse(String(values.pattern ?? '')); if (!pattern || Array.isArray(pattern) || typeof pattern !== 'object' || !Object.keys(pattern).length) throw new Error(); }
    catch { reject('pattern', 'Enter a nonempty EventBridge event-pattern JSON object.'); }
    if (new TextEncoder().encode(JSON.stringify(pattern) ?? '').length > 4096) reject('pattern', 'Keep the event pattern within 4096 bytes.');
    const attempts = Number(values.attempts), age = Number(values.age);
    if (values.attempts === '' || !Number.isInteger(attempts) || attempts < 0 || attempts > 185) reject('attempts', 'Enter 0–185 delivery retries.');
    if (!Number.isInteger(age) || age < 60 || age > 86400) reject('age', 'Enter an event age from 60–86400 seconds.');
    const deadletter = bool(values, 'dlq');
    return awsServiceModule(String(values.aws_region ?? ''), [
      ...(mode === 'new' ? [res('aws_cloudwatch_event_bus', 'configured', { name: bus })] : [dat('aws_cloudwatch_event_bus', 'configured', { name: bus })]),
      dat('aws_lambda_function', 'target', { function_name: fn }),
      res('aws_cloudwatch_event_rule', 'configured', {
        name, event_bus_name: x((mode === 'new' ? '' : 'data.') + 'aws_cloudwatch_event_bus.configured.name'), event_pattern: JSON.stringify(pattern ?? {}), state: bool(values, 'enabled') ? 'ENABLED' : 'DISABLED',
      }),
      res('aws_lambda_permission', 'events', { statement_id_prefix: 'AllowEventBridge-', action: 'lambda:InvokeFunction', function_name: x('data.aws_lambda_function.target.function_name'), principal: 'events.amazonaws.com', source_arn: x('aws_cloudwatch_event_rule.configured.arn') }),
      ...(deadletter ? [
        res('aws_sqs_queue', 'delivery_failures', { name: name + '-dlq', sqs_managed_sse_enabled: true, message_retention_seconds: 1209600 }),
        res('aws_sqs_queue_policy', 'delivery_failures', {
          queue_url: x('aws_sqs_queue.delivery_failures.id'),
          policy: x(jsonencode({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'events.amazonaws.com' }, Action: 'sqs:SendMessage', Resource: e('aws_sqs_queue.delivery_failures.arn'), Condition: { ArnEquals: { 'aws:SourceArn': e('aws_cloudwatch_event_rule.configured.arn') } } }] })),
        }),
      ] : []),
      res('aws_cloudwatch_event_target', 'configured', {
        rule: x('aws_cloudwatch_event_rule.configured.name'), event_bus_name: x('aws_cloudwatch_event_rule.configured.event_bus_name'), target_id: 'lambda', arn: x('data.aws_lambda_function.target.arn'),
        depends_on: x('[aws_lambda_permission.events' + (deadletter ? ', aws_sqs_queue_policy.delivery_failures' : '') + ']'),
      }, [blk('retry_policy', { maximum_retry_attempts: attempts, maximum_event_age_in_seconds: age }), ...(deadletter ? [blk('dead_letter_config', { arn: x('aws_sqs_queue.delivery_failures.arn') })] : [])]),
      output('rule_arn', 'aws_cloudwatch_event_rule.configured.arn'),
      ...(deadletter ? [output('delivery_failure_queue', 'aws_sqs_queue.delivery_failures.id')] : []),
    ], `# EventBridge rule and Lambda target

## Prepare
Confirm the existing target Lambda accepts the producer's event envelope and handles duplicate delivery idempotently. This form routes events within the deployment account and region. Use a custom bus for application events or an appropriate existing bus for service events. Grant producers events:PutEvents on the intended bus separately. Validate representative matching and nonmatching event envelopes with aws events test-event-pattern before applying the rule.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review the event pattern, bus, target, retries and delivery-failure retention. Apply the saved plan. The rule is enabled on creation. The optional new encrypted SQS queue has a rule-scoped policy; existing queue policies are not replaced.

## Verify
Publish a representative application event to the selected bus, or trigger the intended AWS service event. Check rule matches, invocations, delivery failures and Lambda logs. Test nonmatching events. Test failure delivery and queue monitoring in an isolated environment. EventBridge delivery retries and its DLQ cover delivery failures; Lambda asynchronous execution failures need the function's own retry/destination policy. Monitor and handle both paths.

## Recovery
Disable the rule through a reviewed configuration change before making target corrections. Preserve failed events and redrive only after the cause is fixed, accounting for duplicate processing. Without the delivery DLQ, exhausted deliveries can be lost. Drain and export required failed messages before removing the queue. Scheduler jobs, Pipes, cross-account delivery and non-Lambda targets use their corresponding existing resource builders.

https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-targets.html
https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-use-resource-based.html
`, findings);
  },
}                    ;
