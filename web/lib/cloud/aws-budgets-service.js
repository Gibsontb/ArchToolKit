import { error,              } from '../core/findings.js';
                                                     
import { blk, output, res } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule, awsServiceRegion } from './aws-service-module.js';

export const AWS_BUDGETS_SERVICE = {
  id: 'aws_service_budgets', label: 'Set up a recurring cost budget and alerts',
  description: 'Configure a fixed USD billing budget, cost basis, optional linked-account/service scope and actual/forecast email alerts.',
  emits: ['aws_budgets_budget'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Budget name', control: 'text' },
    { id: 'amount', label: 'Budget limit (USD per period)', control: 'number', default: 1000 },
    { id: 'period', label: 'Budget period', control: 'select', default: 'MONTHLY', options: ['MONTHLY', 'QUARTERLY', 'ANNUALLY'].map(value => ({ value, label: value })) },
    { id: 'basis', label: 'Cost basis', control: 'select', default: 'unblended', options: [{ value: 'unblended', label: 'Unblended costs' }, { value: 'amortized', label: 'Amortized commitments' }] },
    { id: 'credits', label: 'Credits and refunds', control: 'select', default: 'include', options: [{ value: 'include', label: 'Include credits and refunds' }, { value: 'exclude', label: 'Exclude credits and refunds' }] },
    { id: 'accounts', label: 'Linked account IDs', control: 'text', hint: 'Optional comma-separated 12-digit account IDs. Requires access to these accounts in the billing boundary.' },
    { id: 'services', label: 'Billing service names', control: 'text', hint: 'Optional comma-separated exact Cost Explorer Service values. Leave blank for all services.' },
    { id: 'emails', label: 'Alert email recipients', control: 'text', hint: 'Comma-separated email addresses, up to ten recipients.' },
    { id: 'actual', label: 'Actual-spend threshold (%)', control: 'number', default: 80 },
    { id: 'forecast', label: 'Forecast alert', control: 'select', default: 'yes', options: [{ value: 'yes', label: 'Alert when forecast exceeds 100%' }, { value: 'no', label: 'Actual spend only' }] },
  ],
  build(values) {
    const findings            = [];
    const reject = (path        , message        ) => findings.push(error('aws.budgets.' + path, message, { path }));
    const list = (key        ) => [...new Set(String(values[key] ?? '').split(/[,\n]/).map(value => value.trim()).filter(Boolean))];
    const name = String(values.name ?? '').trim(), amount = Number(values.amount), actual = Number(values.actual);
    const period = String(values.period ?? ''), basis = String(values.basis ?? ''), credits = String(values.credits ?? ''), forecast = String(values.forecast ?? '');
    const accounts = list('accounts'), services = list('services'), emails = list('emails');
    if (!name || name.length > 100 || /[\x00-\x1f\x7f:]/.test(name) || name.includes('/action/')) reject('name', 'Enter a budget name up to 100 characters without colons, control characters or /action/.');
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12) reject('amount', 'Enter a positive finite budget limit up to one trillion USD.');
    if (!['MONTHLY', 'QUARTERLY', 'ANNUALLY'].includes(period)) reject('period', 'Select a budget period.');
    if (!['unblended', 'amortized'].includes(basis)) reject('basis', 'Select a cost basis.');
    if (!['include', 'exclude'].includes(credits)) reject('credits', 'Choose how to handle credits and refunds.');
    if (!['yes', 'no'].includes(forecast)) reject('forecast', 'Select forecast alert behavior.');
    if (accounts.some(value => !/^\d{12}$/.test(value))) reject('accounts', 'Use 12-digit linked account IDs.');
    if (services.some(value => value.length > 200 || /[\x00-\x1f]/.test(value))) reject('services', 'Use exact billing service names up to 200 characters.');
    if (!emails.length || emails.length > 10 || emails.some(value => !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(value) || value.length > 320)) reject('emails', 'Enter one to ten valid alert email addresses.');
    if (!Number.isFinite(actual) || actual <= 0 || actual > 1000) reject('actual', 'Use an actual-spend threshold greater than zero and at most 1000%.');
    return awsServiceModule(String(values.aws_region ?? ''), [
      res('aws_budgets_budget', 'configured', { name, budget_type: 'COST', limit_amount: String(amount), limit_unit: 'USD', time_unit: period }, [
        blk('cost_types', { use_amortized: basis === 'amortized', use_blended: false, include_credit: credits === 'include', include_refund: credits === 'include', include_tax: true, include_support: true, include_subscription: true, include_recurring: true, include_upfront: true, include_other_subscription: true, include_discount: true }),
        ...(accounts.length ? [blk('cost_filter', { name: 'LinkedAccount', values: accounts })] : []),
        ...(services.length ? [blk('cost_filter', { name: 'Service', values: services })] : []),
        ...['ACTUAL', ...(forecast === 'yes' ? ['FORECASTED'] : [])].map(type => blk('notification', { comparison_operator: 'GREATER_THAN', threshold: type === 'ACTUAL' ? actual : 100, threshold_type: 'PERCENTAGE', notification_type: type, subscriber_email_addresses: emails })),
      ]), output('budget_id', 'aws_budgets_budget.configured.id'), output('budget_arn', 'aws_budgets_budget.configured.arn'),
    ], `# Recurring AWS cost budget

## Prepare
Confirm billing-management permissions and the intended payer/member account. This budget belongs to the authenticated account. A linked-account filter needs billing visibility; check every exact Service filter against Cost Explorer. USD is the AWS budget limit currency. Review whether amortization or unblended charges and credits/refunds match finance reporting. Budget alert delivery can incur applicable charges; verify current pricing and regional/partition support.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review the amount, period, billing scope, included costs and recipients. Apply the reviewed saved plan. Open AWS Budgets in the billing console and verify the configured scope and alert thresholds. Confirm recipients can receive AWS email through the organization's mail controls.

## Verify
Compare the budget's actual cost with Cost Explorer for the same period, filters and cost basis. Confirm all intended linked accounts are visible. Billing data and alerts have processing delays; forecast alerts require sufficient usage history. Verify notification settings and delivery with the billing owner. A budget does not enforce a spending cap, stop services or calculate a migration TCO. No automated budget action or resource remediation is created.

## Recovery
Correct filters or thresholds through a reviewed plan and recheck cost alignment. Preserve billing evidence before deleting a budget. Removing this budget stops its future monitoring and notifications; it does not delete workloads or cancel commitments. Escalate unexpected charges independently of notification timing.

https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html
`, findings);
  },
}                    ;
