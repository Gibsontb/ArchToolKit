/** Verified catalog names for the same control-plane setup. Runtime APIs and billing items are not aliases. */
export const AWS_SERVICE_SETUP_ALIASES = {
  'amazon-cognito-identity-provider': { canonical: 'amazon-cognito', reference: 'https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/Welcome.html' },
  'amazon-kinesis': { canonical: 'taxonomy:kinesisdatastreams', reference: 'https://docs.aws.amazon.com/kinesis/latest/APIReference/Welcome.html' },
  'amazon-prometheus-service': { canonical: 'amazon-managed-service-for-prometheus', reference: 'https://docs.aws.amazon.com/prometheus/latest/APIReference/Welcome.html' },
  'aws-single-sign-on-admin': { canonical: 'aws-iam-identity-center', reference: 'https://docs.aws.amazon.com/singlesignon/latest/APIReference/API_CreatePermissionSet.html' },
  'opensearch-service-serverless': { canonical: 'taxonomy:opensearchserverless', reference: 'https://docs.aws.amazon.com/opensearch-service/latest/ServerlessAPIReference/Welcome.html' },
  'access-analyzer': { canonical: 'taxonomy:iamaccessanalyzer', reference: 'https://docs.aws.amazon.com/access-analyzer/latest/APIReference/API_GetAnalyzer.html' },
  'aws-identity-and-access-management-access-analyzer': { canonical: 'taxonomy:iamaccessanalyzer', reference: 'https://docs.aws.amazon.com/access-analyzer/latest/APIReference/API_GetAnalyzer.html' },
  // June 2026 product rename: same MGN APIs/replication engine, not the broader Transform agentic platform.
  'aws-transform-mgn': { canonical: 'aws-application-migration-service', reference: 'https://aws.amazon.com/about-aws/whats-new/2026/06/aws-transform-mgn-rebrand/' },
  // Historical SageMaker API/CloudFormation entry; not the newer Unified Studio/Lakehouse platform.
  'amazon-sagemaker': { canonical: 'amazon-sagemaker-ai', reference: 'https://docs.aws.amazon.com/sagemaker/latest/dg/whatis.html' },
  'amazon-simple-systems-manager-ssm': { canonical: 'aws-systems-manager', reference: 'https://docs.aws.amazon.com/systems-manager/latest/APIReference/Welcome.html' },
  'amazon-kinesis-firehose': { canonical: 'amazon-data-firehose', reference: 'https://docs.aws.amazon.com/firehose/latest/APIReference/' },
  'amazon-elastic-mapreduce': { canonical: 'amazon-emr', reference: 'https://docs.aws.amazon.com/emr/latest/ManagementGuide/emr-what-is-emr.html' },
  'amazon-managed-service-for-apache-flink': { canonical: 'taxonomy:kinesisdataanalytics', reference: 'https://docs.aws.amazon.com/managed-flink/latest/java/what-is.html' },
  'amazon-macie-2': { canonical: 'amazon-macie', reference: 'https://docs.aws.amazon.com/macie/latest/APIReference/Welcome.html' },
}         ;
