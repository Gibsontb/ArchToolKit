import { bool } from '../kit/blueprint.ts';
import { error, type Finding } from '../core/findings.ts';
import type { Blueprint } from '../kit/blueprint.ts';
import { blk, dat, e, jsonencode, output, res, x } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.ts';

export const AWS_STEPFUNCTIONS_SERVICE = {
  id: 'aws_service_stepfunctions', label: 'Set up a Lambda orchestration workflow',
  description: 'Create a Standard or Express state machine with a Lambda task, bounded retries, execution timeout and retained logs.',
  emits: ['aws_sfn_state_machine', 'aws_cloudwatch_log_group'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'State machine name', control: 'text' },
    { id: 'type', label: 'Workflow type', control: 'select', default: 'STANDARD', options: [{ value: 'STANDARD', label: 'Standard — durable workflow' }, { value: 'EXPRESS', label: 'Express — short, high-volume workflow' }] },
    { id: 'function_name', label: 'Existing Lambda function name', control: 'text', hint: 'Function in the deployment account and region. Receives the execution input as its payload.' },
    { id: 'role', label: 'Existing execution IAM role ARN', control: 'text', hint: 'Trust states.amazonaws.com. Grant invocation of the selected Lambda, log delivery permissions and X-Ray permissions when tracing is enabled.' },
    { id: 'timeout', label: 'Workflow timeout (seconds)', control: 'number', default: 300, min: 1, max: 31536000 },
    { id: 'attempts', label: 'Transient Lambda error retries', control: 'number', default: 3, min: 0, max: 10 },
    { id: 'interval', label: 'Initial retry interval (seconds)', control: 'number', default: 2, min: 1, max: 60 },
    { id: 'retention', label: 'Execution log retention', control: 'select', default: '30', options: [7, 14, 30, 60, 90, 180, 365].map(value => ({ value: String(value), label: value + ' days' })) },
    { id: 'tracing', label: 'Enable X-Ray tracing', control: 'toggle', default: true },
  ],
  build(values) {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.stepfunctions.' + path, message, { path }));
    const name = String(values.name ?? ''), type = String(values.type ?? ''), fn = String(values.function_name ?? '');
    const location = String(values.aws_region ?? ''), partition = awsServicePartition(location), role = String(values.role ?? '');
    const parsed = /^arn:([^:]+):iam::(\d{12}):role\/[A-Za-z0-9+=,.@_/-]+$/.exec(role);
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(name)) reject('name', 'Use 1–80 letters, numbers, hyphens or underscores.');
    if (!['STANDARD', 'EXPRESS'].includes(type)) reject('type', 'Select Standard or Express.');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(fn)) reject('function_name', 'Enter an existing Lambda function name.');
    if (!parsed || parsed[1] !== partition) reject('role', 'Enter an existing execution role ARN in the selected partition.');
    const integer = (key: string, min: number, max: number) => { const value = Number(values[key]); if (values[key] === '' || !Number.isInteger(value) || value < min || value > max) reject(key, 'Enter a whole number from ' + min + ' to ' + max + '.'); return value; };
    const timeout = integer('timeout', 1, type === 'EXPRESS' ? 300 : 31536000), attempts = integer('attempts', 0, 10), interval = integer('interval', 1, 60);
    const retention = Number(values.retention);
    if (![7, 14, 30, 60, 90, 180, 365].includes(retention)) reject('retention', 'Select execution log retention.');
    return awsServiceModule(location, [
      dat('aws_caller_identity', 'current', {}),
      dat('aws_lambda_function', 'task', { function_name: fn }),
      res('aws_cloudwatch_log_group', 'execution', { name: '/aws/vendedlogs/states/' + name, retention_in_days: retention }),
      res('aws_sfn_state_machine', 'configured', {
        name, type, role_arn: role,
        definition: x(jsonencode({ StartAt: 'InvokeLambda', TimeoutSeconds: timeout, States: {
          InvokeLambda: { Type: 'Task', Resource: 'arn:' + partition + ':states:::lambda:invoke', Parameters: { FunctionName: e('data.aws_lambda_function.task.arn'), 'Payload.$': '$' }, OutputPath: '$.Payload',
            Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.AWSLambdaException', 'Lambda.SdkClientException', 'Lambda.TooManyRequestsException'], IntervalSeconds: interval, MaxAttempts: attempts, BackoffRate: 2 }], End: true },
        } })),
      }, [
        blk('logging_configuration', { log_destination: x('"${aws_cloudwatch_log_group.execution.arn}:*"'), include_execution_data: false, level: 'ALL' }),
        blk('tracing_configuration', { enabled: bool(values, 'tracing') }),
        blk('lifecycle', { prevent_destroy: true }, [blk('precondition', { condition: x('data.aws_caller_identity.current.account_id == ' + JSON.stringify(parsed?.[2] ?? '')), error_message: 'Use an execution role in the deployment account.' })]),
      ]),
      output('state_machine_arn', 'aws_sfn_state_machine.configured.arn'),
    ], `# Lambda orchestration with Step Functions

## Prepare
Confirm the selected function handles execution input and duplicate invocations safely. Prepare a states.amazonaws.com-trusted execution role with lambda:InvokeFunction on this function, CloudWatch Logs delivery permissions, and X-Ray permissions if enabled. Scope the trust to the intended source account and state machine. Grant operators the required Step Functions execution permissions separately. Confirm regional support and review Standard versus Express delivery and billing semantics. Express runs are limited to five minutes.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review the task, execution role, overall timeout, transient-error retries, logs and tracing. Apply the saved plan. The generated Amazon States Language definition invokes Lambda synchronously and returns its Payload. Application errors and exhausted transient retries fail the execution. This form covers a single Lambda task; use the existing state-machine definition builder for branching, parallel states, callbacks and other service integrations.

## Verify
Read state_machine_arn. Start a test execution with representative JSON input using the AWS CLI or console. Check the returned payload and execution status. Exercise application errors, timeouts and transient failures in a test environment. Inspect execution logs and traces. Execution payload logging is disabled, but review handler logging and exception messages for sensitive data. Express execution history relies on its configured logs.

## Recovery
Stop affected Standard executions where appropriate and correct the underlying task before retrying or redriving. Express executions cannot be stopped through StopExecution. Avoid duplicate side effects when replaying input. Keep the preceding workflow available through cutover. Type changes replace the state machine and are blocked by Terraform prevent_destroy until explicitly reviewed. Preserve required logs and drain executions before retirement.

https://docs.aws.amazon.com/step-functions/latest/dg/connect-lambda.html
https://docs.aws.amazon.com/step-functions/latest/dg/cw-logs.html
`, findings);
  },
} satisfies Blueprint;
