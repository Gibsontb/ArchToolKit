/** Explicit lifecycle evidence. Pricing/API-directory presence is not availability evidence. */
export interface ServiceAvailability {
  readonly status: 'existing-customers-only' | 'retired';
  readonly effective: string;
  readonly checked: string;
  readonly message: string;
  readonly reference: string;
}
// Exact retired products only. Partial feature retirements must not disable active successors.
// AWS General Reference, checked against the project date on 2026-11-23.
const shutdownReference = 'https://docs.aws.amazon.com/general/latest/gr/full_shutdown_services.html';
const shutdowns: readonly [string, string][] = [
  ['aws-app-mesh', '2026-09-30'],
  ['cloudwatch-evidently', '2025-10-17'],
  ['taxonomy:codestar', '2024-07-25'],
  ['taxonomy:deepcomposer', '2025-09-17'],
  ['taxonomy:deeplens', '2024-01-31'],
  ['amazon-elastic-transcoder', '2025-11-13'],
  ['aws-elemental-mediastore', '2025-11-12'],
  ['aws-elemental-mediastore-data-plane', '2025-11-12'],
  ['amazon-finspace', '2026-10-07'],
  ['finspace-public-api', '2026-10-07'],
  ['inspector-classic', '2026-05-20'],
  ['aws-iot-1-click', '2025-01-29'],
  ['aws-iot-analytics', '2025-12-15'],
  ['aws-iot-events', '2026-05-20'],
  ['taxonomy:iotroborunner', '2024-03-14'],
  ['aws-iot-things-graph', '2022-11-09'],
  ['amazon-lookout-for-equipment', '2026-10-07'],
  ['amazon-lookout-for-metrics', '2025-10-10'],
  ['amazon-lookout-for-vision', '2025-10-31'],
  ['amazon-mechanical-turk', '2026-09-29'],
  ['amazon-nimble-studio', '2024-06-30'],
  ['aws-opsworks', '2024-05-01'],
  ['aws-panorama', '2026-05-20'],
  ['aws-private-5g', '2025-05-20'],
  ['aws-proton', '2026-10-07'],
  ['amazon-quantum-ledger-database', '2025-07-31'],
  ['aws-robomaker', '2025-09-10'],
  ['taxonomy:servermigrationservice', '2023-04-01'],
  ['aws-simspace-weaver', '2026-03-31'],
  ['aws-snowball-edge', '2025-11-12'],
  ['taxonomy:snowmobile', '2024-03-14'],
  ['amazon-sumerian', '2023-03-01'],
  ['waf-classic', '2026-10-07'],
  ['waf-classic-regional', '2026-10-07'],
  ['amazon-workdocs', '2025-04-25'],
  ['amazon-worklink', '2021-11-30'],
];
export const AWS_SERVICE_AVAILABILITY: Readonly<Record<string, ServiceAvailability>> = {
  'aws-cloud9': { status: 'existing-customers-only', effective: '2024-07-25', checked: '2026-11-23', message: 'AWS Cloud9 is closed to new customers. Verify that this account already has service access before planning more Cloud9 resources.', reference: 'https://docs.aws.amazon.com/cloud9/latest/user-guide/history.html' },
  'amazon-cloudsearch': { status: 'existing-customers-only', effective: '2024-07-25', checked: '2026-11-23', message: 'Amazon CloudSearch is closed to new customers. Existing customers can continue; review account eligibility and the OpenSearch migration path.', reference: 'https://aws.amazon.com/blogs/big-data/transition-from-amazon-cloudsearch-to-amazon-opensearch-service/' },
  'amazon-cloudsearch-domain': { status: 'existing-customers-only', effective: '2024-07-25', checked: '2026-11-23', message: 'CloudSearch runtime access requires an existing eligible CloudSearch account. This API entry does not provide new-customer onboarding.', reference: 'https://aws.amazon.com/blogs/big-data/transition-from-amazon-cloudsearch-to-amazon-opensearch-service/' },
  'amazon-forecast': { status: 'existing-customers-only', effective: '2024-07-29', checked: '2026-11-23', message: 'Amazon Forecast is closed to new customers. Verify existing account eligibility; evaluate the documented transition for a new implementation.', reference: 'https://aws.amazon.com/blogs/machine-learning/transition-your-amazon-forecast-usage-to-amazon-sagemaker-canvas/' },
  'amazon-forecast-query-service': { status: 'existing-customers-only', effective: '2024-07-29', checked: '2026-11-23', message: 'Forecast query APIs require an existing eligible Forecast account and prepared predictor/forecast resources.', reference: 'https://aws.amazon.com/blogs/machine-learning/transition-your-amazon-forecast-usage-to-amazon-sagemaker-canvas/' },
  'amazon-codecatalyst': { status: 'existing-customers-only', effective: '2025-11-07', checked: '2026-11-23', message: 'CodeCatalyst is closed to new customers. Existing customers can use existing spaces; creating new spaces is no longer available.', reference: 'https://docs.aws.amazon.com/codecatalyst/latest/userguide/migration.html' },
  'aws-systems-manager-incident-manager': { status: 'existing-customers-only', effective: '2025-11-07', checked: '2026-11-23', message: 'Incident Manager accepts existing customers only, in accounts where it was already enabled. Check account access before building additional resources.', reference: 'https://docs.aws.amazon.com/incident-manager/latest/userguide/incident-manager-availability-change.html' },
  'aws-systems-manager-incident-manager-contacts': { status: 'existing-customers-only', effective: '2025-11-07', checked: '2026-11-23', message: 'Incident Manager contacts require an existing eligible Incident Manager account; this resource API does not reopen new-customer access.', reference: 'https://docs.aws.amazon.com/incident-manager/latest/userguide/incident-manager-availability-change.html' },
  'ssm-incident-manager-incidents': { status: 'existing-customers-only', effective: '2025-11-07', checked: '2026-11-23', message: 'Incident Manager incident resources require an existing account where the service was already enabled.', reference: 'https://docs.aws.amazon.com/incident-manager/latest/userguide/incident-manager-availability-change.html' },
  ...Object.fromEntries(shutdowns.map(([id, effective]) => [id, {
    status: 'retired' as const, effective, checked: '2026-11-23',
    message: 'AWS lists this product in full shutdown as of ' + effective + '. This historical entry cannot generate a new deployment.',
    reference: shutdownReference,
  }])),
  'amazon-honeycode': {
    status: 'retired', effective: '2024-02-29', checked: '2026-11-23',
    message: 'Amazon Honeycode ended on February 29, 2024. This historical catalog entry cannot be used for a new deployment.',
    reference: 'https://aws.amazon.com/blogs/aws/introducing-amazon-honeycode-build-web-mobile-apps-without-writing-code/',
  },
  'aws-app-runner': {
    status: 'existing-customers-only', effective: '2026-04-30', checked: '2026-11-20',
    message: 'Existing App Runner customers only. AWS closed the service to new customers on April 30, 2026; existing customers can continue creating resources.',
    reference: 'https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html',
  },
};
