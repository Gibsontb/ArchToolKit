/** Verified catalog names for the same control-plane setup. Runtime APIs and billing items are not aliases. */
export const AWS_SERVICE_SETUP_ALIASES = {
  'amazon-simple-systems-manager-ssm': { canonical: 'aws-systems-manager', reference: 'https://docs.aws.amazon.com/systems-manager/latest/APIReference/Welcome.html' },
  'amazon-kinesis-firehose': { canonical: 'amazon-data-firehose', reference: 'https://docs.aws.amazon.com/firehose/latest/APIReference/' },
  'amazon-elastic-mapreduce': { canonical: 'amazon-emr', reference: 'https://docs.aws.amazon.com/emr/latest/ManagementGuide/emr-what-is-emr.html' },
  'amazon-managed-service-for-apache-flink': { canonical: 'taxonomy:kinesisdataanalytics', reference: 'https://docs.aws.amazon.com/managed-flink/latest/java/what-is.html' },
  'amazon-macie-2': { canonical: 'amazon-macie', reference: 'https://docs.aws.amazon.com/macie/latest/APIReference/Welcome.html' },
}         ;
