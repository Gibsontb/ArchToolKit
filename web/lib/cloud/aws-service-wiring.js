                                                   
/** Explicit product-to-resource mappings; never inferred from partial product names. */
export const AWS_SERVICE_RESOURCES                           =[
 [/^AWS IAM Identity Center$/i,/^aws_ssoadmin_/],
 [/^AWS IAM Access Analyzer$/i,/^aws_accessanalyzer_/],
 [/^AWS Client VPN$/i,/^aws_ec2_client_vpn_/],
 [/^AWS Cloud WAN$/i,/^aws_networkmanager_(?:core_network|vpc_attachment|connect_attachment|connect_peer|site_to_site_vpn_attachment|transit_gateway_peering|transit_gateway_route_table_attachment)/],
 [/^AWS Cost Anomaly Detection$/i,/^aws_ce_anomaly_/],
 [/^AWS Private Certificate Authority$/i,/^aws_acmpca_/],
 [/^AWS PrivateLink$/i,/^aws_vpc_endpoint(?:_|$)/],
 [/^AWS Site-to-Site VPN$/i,/^aws_(?:vpn_connection|vpn_gateway|customer_gateway)(?:_|$)/],
 [/^AWS Systems Manager$/i,/^aws_ssm_/],
 [/^AWS Systems Manager Parameter Store$/i,/^aws_ssm_parameter$/],
 [/^AWS Systems Manager Session Manager$/i,/^aws_ssm_(?:document|association)$/],
 [/^AWS Auto Scaling$/i,/^aws_(?:appautoscaling_|autoscaling_)/],
 [/^AWS Resource Groups & Tag Editor$/i,/^aws_resourcegroups_(?:group|resource)$/],
 [/^Amazon Transcribe Medical$/i,/^aws_transcribe_medical_vocabulary$/],
 [/^Amazon Kinesis Data Analytics \(Managed Service for Apache Flink\)$/i,/^aws_kinesisanalyticsv2_/],
 [/^Amazon Aurora$/i,/^aws_rds_cluster(?:_|$)/],
 [/^Amazon RDS Proxy$/i,/^aws_db_proxy(?:_|$)/],
 [/^Amazon FSx for Lustre$/i,/^aws_fsx_lustre_file_system$/],
 [/^Amazon FSx for NetApp ONTAP$/i,/^aws_fsx_ontap_/],
 [/^Amazon FSx for OpenZFS$/i,/^aws_fsx_openzfs_/],
 [/^Amazon FSx for Windows File Server$/i,/^aws_fsx_windows_file_system$/],
 [/^Amazon Kinesis Data Streams$/i,/^aws_kinesis_stream(?:_|$)/],
 [/^Amazon Data Firehose$/i,/^aws_kinesis_firehose_delivery_stream$/],
 [/^Amazon OpenSearch Serverless$/i,/^aws_opensearchserverless_/],
 [/^Amazon Managed Service for Prometheus$/i,/^aws_prometheus_/],
 [/^Amazon VPC IP Address Manager \(IPAM\)$/i,/^aws_vpc_ipam(?:_|$)/],
 [/^Amazon Connect$/i,/^aws_connect_/],
 [/^Agents for Amazon Bedrock$/i,/^aws_bedrockagent_agent(?:_|$)/],
 [/^Amazon Bedrock Managed Knowledge Base$/i,/^aws_bedrockagent_(?:knowledge_base|data_source)/],
 [/^Amazon S3 Express One Zone$/i,/^aws_s3_directory_bucket$/],
 [/^Amazon S3 Object Lambda$/i,/^aws_s3control_object_lambda_/],
 [/^Amazon RDS Custom$/i,/^aws_rds_custom_db_engine_version$/],
 [/^Amazon SageMaker HyperPod$/i,/^aws_sagemaker_hyperpod_/],
 [/^Amazon SageMaker Studio$/i,/^aws_sagemaker_(?:domain|user_profile|space|app)$/],
 [/^Amazon SageMaker Ground Truth$/i,/^aws_sagemaker_(?:workteam|workforce|labeling_job)$/],
];
export function awsServiceBuilds(name       ,blueprints                     )            {
 const patterns=AWS_SERVICE_RESOURCES.filter(([product])=>product.test(name)).map(([,resources])=>resources);
 return blueprints.filter(blueprint=>blueprint.id.startsWith('res_')&&patterns.some(pattern=>pattern.test(blueprint.id.slice(4))));
}
