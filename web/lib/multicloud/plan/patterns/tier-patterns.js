/**
 * Tier patterns (addendum A.4.1, A.2.10): what a component becomes on each
 * target platform, with the Terraform types that build it.
 *
 * Every Terraform type named here is checked against the pinned provider
 * catalog (`terraform/catalog-data.ts`: aws 6.66.0, azurerm 5.7.0, google
 * 8.4.0, oci 9.3.0, vsphere 2.17.1) by `patterns.test.ts`. A platform without
 * the tier pattern is `{ none: <reason> }`; a service with no Terraform
 * resource carries `noTerraform` (a runbook step).
 */

import { DB_SERVICES, CATALOGUED_DB_SERVICES } from '../db-catalog.js';
                                                         
import { fact, isNone,                                                        } from './model.js';

const t = (service        , terraform                   , extra                                            = {})             =>
  Object.freeze({ service, terraform: Object.freeze([...terraform]), ...extra });
const none = (reason        )             => Object.freeze({ none: reason });

const VM                                         = {
  aws: t('Amazon EC2', ['aws_instance']),
  azure: t('Azure Virtual Machines', ['azurerm_linux_virtual_machine', 'azurerm_windows_virtual_machine']),
  google: t('Compute Engine', ['google_compute_instance']),
  oci: t('OCI Compute', ['oci_core_instance']),
  vmware: t('vSphere VM on VMware Cloud Foundation', ['vsphere_virtual_machine']),
};

/** The managed (not IaaS) database services' Terraform types on a platform, from the database catalogue. */
function managedDbTypes(platform          )           {
  const out = new Set        ();
  for (const id of CATALOGUED_DB_SERVICES) {
    const s = DB_SERVICES[id];
    if (s.platform === platform && s.managed) for (const ty of s.terraformTypes) out.add(ty);
  }
  return [...out];
}

const VENDOR_SAAS = 'Vendor SaaS (Exchange Online, SharePoint Online, Dynamics 365, Universal Print, RISE with SAP …): no infrastructure on the platform and no IaC; the move is a runbook plus the vendor\'s migration tooling.';
const SPECIALIST = 'A non-x86 or mainframe hosting partner (IBM Power Virtual Server, Kyndryl Cloud Uplift, Converge IP4G, a mainframe rehost partner): runbook only (A.4.8).';

const TIER                                                             = {
  vm: { perPlatform: VM, facts: [] },
  'vmware-service': {
    perPlatform: {
      aws: t('Amazon Elastic VMware Service (EVS)', [], { noTerraform: 'The pinned AWS provider has no EVS resource: the environment is created by runbook (console / API).', source: 'https://docs.aws.amazon.com/evs/latest/userguide/what-is-evs.html' }),
      azure: t('Azure VMware Solution', ['azurerm_vmware_private_cloud']),
      google: t('Google Cloud VMware Engine', ['google_vmwareengine_private_cloud']),
      oci: t('Oracle Cloud VMware Solution', ['oci_ocvp_sddc']),
      vmware: t('VMware Cloud Foundation (owned hardware)', ['vsphere_virtual_machine'], { note: 'Relocation within VCF (HCX / cross-vCenter vMotion).' }),
    },
    facts: [],
  },
  'paas-web': {
    perPlatform: {
      aws: t('AWS Elastic Beanstalk', ['aws_elastic_beanstalk_application', 'aws_elastic_beanstalk_environment']),
      azure: t('Azure App Service', ['azurerm_service_plan', 'azurerm_windows_web_app', 'azurerm_linux_web_app']),
      google: t('Cloud Run', ['google_cloud_run_v2_service'], { note: 'Linux containers only: .NET 8+ or other Linux runtimes; .NET Framework does not run on Cloud Run.' }),
      oci: none('OCI has no managed web-app runtime: use OKE (containers) or a VM.'),
      vmware: none('VCF has no managed web-app runtime: use VKS (containers) or a VM.'),
    },
    facts: [fact('Cloud Run runs Linux containers only, so .NET Framework applications need Windows nodes on GKE or a VM.', 'https://docs.cloud.google.com/run/docs/container-contract', 'V-DOC')],
  },
  containers: {
    perPlatform: {
      aws: t('Amazon EKS', ['aws_eks_cluster', 'aws_eks_node_group']),
      azure: t('Azure Kubernetes Service', ['azurerm_kubernetes_cluster', 'azurerm_kubernetes_cluster_node_pool']),
      google: t('Google Kubernetes Engine', ['google_container_cluster', 'google_container_node_pool']),
      oci: t('OCI Kubernetes Engine (OKE)', ['oci_containerengine_cluster', 'oci_containerengine_node_pool']),
      vmware: t('vSphere Kubernetes Service (VKS)', ['vsphere_supervisor'], { note: 'The Supervisor is a data source / prerequisite; the workload cluster is a Cluster manifest applied to it.' }),
    },
    facts: [],
  },
  serverless: {
    perPlatform: {
      aws: t('AWS Lambda', ['aws_lambda_function']),
      azure: t('Azure Functions', ['azurerm_linux_function_app']),
      google: t('Cloud Run functions', ['google_cloudfunctions2_function']),
      oci: t('OCI Functions', ['oci_functions_application', 'oci_functions_function']),
      vmware: none('VCF has no functions service: build the function as a container on VKS.'),
    },
    facts: [],
  },
  'static-site': {
    perPlatform: {
      aws: t('Amazon S3 + CloudFront', ['aws_s3_bucket', 'aws_cloudfront_distribution']),
      azure: t('Azure Static Web Apps', ['azurerm_static_web_app']),
      google: t('Cloud Storage + a backend bucket on the load balancer', ['google_storage_bucket', 'google_compute_backend_bucket']),
      oci: t('Object Storage + OCI Load Balancer', ['oci_objectstorage_bucket', 'oci_load_balancer_load_balancer']),
      vmware: none('VCF has no static-site service: serve it from a web VM or a container.'),
    },
    facts: [],
  },
  'api-gateway': {
    perPlatform: {
      aws: t('Amazon API Gateway (HTTP API)', ['aws_apigatewayv2_api']),
      azure: t('Azure API Management', ['azurerm_api_management']),
      google: t('API Gateway', ['google_api_gateway_api', 'google_api_gateway_gateway']),
      oci: t('OCI API Gateway', ['oci_apigateway_gateway']),
      vmware: none('VCF has no API gateway service: run one (e.g. an ingress controller) on VKS.'),
    },
    facts: [],
  },
  batch: {
    perPlatform: {
      aws: t('AWS Batch', ['aws_batch_compute_environment', 'aws_batch_job_queue']),
      azure: t('Azure Batch', ['azurerm_batch_account', 'azurerm_batch_pool']),
      google: t('Dataflow', ['google_dataflow_job']),
      oci: t('OCI Data Flow', ['oci_dataflow_application']),
      vmware: none('VCF has no managed batch service: run the scheduler on VMs.'),
    },
    facts: [],
  },
  workflow: {
    perPlatform: {
      aws: t('AWS Step Functions', ['aws_sfn_state_machine']),
      azure: t('Azure Data Factory', ['azurerm_data_factory']),
      google: t('Workflows', ['google_workflows_workflow']),
      oci: none('OCI has no workflow service in the pinned provider: use Functions + a queue.'),
      vmware: none('VCF has no workflow service: run an orchestrator on VMs or VKS.'),
    },
    facts: [],
  },
  'object-storage': {
    perPlatform: {
      aws: t('Amazon S3', ['aws_s3_bucket']),
      azure: t('Azure Blob Storage', ['azurerm_storage_account', 'azurerm_storage_container']),
      google: t('Cloud Storage', ['google_storage_bucket']),
      oci: t('OCI Object Storage', ['oci_objectstorage_bucket']),
      vmware: none('VCF has no object store in the vSphere provider: use an S3-compatible appliance or the target cloud.'),
    },
    facts: [],
  },
  'managed-db': {
    perPlatform: {
      aws: t('A managed database service (per the database catalogue)', managedDbTypes('aws')),
      azure: t('A managed database service (per the database catalogue)', managedDbTypes('azure')),
      google: t('A managed database service (per the database catalogue)', managedDbTypes('google')),
      oci: t('A managed database service (per the database catalogue)', managedDbTypes('oci')),
      vmware: none('The database catalogue has no managed database service on VCF: the database runs in a VM.'),
    },
    facts: [],
  },
  'file-service': {
    perPlatform: {
      aws: t('Amazon FSx for Windows File Server / FSx for NetApp ONTAP', ['aws_fsx_windows_file_system', 'aws_fsx_ontap_file_system', 'aws_fsx_ontap_volume']),
      azure: t('Azure Files (+ Azure File Sync) / Azure NetApp Files', ['azurerm_storage_account', 'azurerm_storage_share', 'azurerm_storage_sync', 'azurerm_netapp_account', 'azurerm_netapp_pool', 'azurerm_netapp_volume']),
      google: t('Filestore / Google Cloud NetApp Volumes', ['google_filestore_instance', 'google_netapp_storage_pool', 'google_netapp_volume']),
      oci: t('OCI File Storage', ['oci_file_storage_file_system', 'oci_file_storage_mount_target', 'oci_file_storage_export']),
      vmware: t('File server VM', ['vsphere_virtual_machine'], { note: 'VCF has no managed file service: the file server stays a VM.' }),
    },
    facts: [],
  },
  'vdi-service': {
    perPlatform: {
      aws: t('Amazon WorkSpaces (Personal / Pools)', ['aws_workspaces_directory', 'aws_workspaces_workspace', 'aws_workspaces_pool']),
      azure: t('Azure Virtual Desktop', ['azurerm_virtual_desktop_host_pool', 'azurerm_virtual_desktop_application_group', 'azurerm_virtual_desktop_workspace', 'azurerm_virtual_desktop_workspace_application_group_association', 'azurerm_virtual_desktop_scaling_plan']),
      google: none('Google Cloud has no first-party desktop service: session-host VMs with Omnissa Horizon on Google Cloud VMware Engine, or Citrix DaaS.'),
      oci: t('OCI Secure Desktops', ['oci_desktops_desktop_pool']),
      vmware: t('Omnissa Horizon on VCF (session-host VMs)', ['vsphere_virtual_machine'], { note: 'Horizon is an Omnissa product; the desktops are VMs.' }),
    },
    facts: [fact('AWS maps persistent desktops to WorkSpaces Personal and non-persistent ones to WorkSpaces Pools.', 'https://docs.aws.amazon.com/workspaces/latest/adminguide/managing-wsp-pools.html')],
  },
  saas: {
    perPlatform: { aws: t('Vendor SaaS', [], { noTerraform: VENDOR_SAAS }), azure: t('Vendor SaaS', [], { noTerraform: VENDOR_SAAS }), google: t('Vendor SaaS', [], { noTerraform: VENDOR_SAAS }), oci: t('Vendor SaaS', [], { noTerraform: VENDOR_SAAS }), vmware: t('Vendor SaaS', [], { noTerraform: VENDOR_SAAS }) },
    facts: [],
  },
  'sap-certified': {
    perPlatform: {
      aws: t('Amazon EC2 SAP-certified instance types', ['aws_instance']),
      azure: t('Azure SAP-certified VM sizes (optionally Azure Center for SAP solutions)', ['azurerm_linux_virtual_machine', 'azurerm_workloads_sap_three_tier_virtual_instance', 'azurerm_netapp_volume_group_sap_hana']),
      google: t('Compute Engine SAP-certified machine types', ['google_compute_instance']),
      oci: t('OCI Compute SAP-certified shapes', ['oci_core_instance'], { note: 'OCI certified shapes are not confirmed from an Oracle page here [U].' }),
      vmware: t('vSphere VM within the SAP notes for VCF 9', ['vsphere_virtual_machine']),
    },
    facts: [],
  },
  'managed-messaging': {
    perPlatform: {
      aws: t('Amazon MQ (ActiveMQ / RabbitMQ)', ['aws_mq_broker', 'aws_mq_configuration']),
      azure: t('Azure Service Bus', ['azurerm_servicebus_namespace', 'azurerm_servicebus_queue']),
      google: none('Google Cloud has no managed AMQP / JMS broker (Pub/Sub is a different model): run the broker on a VM.'),
      oci: t('OCI Queue', ['oci_queue_queue']),
      vmware: none('VCF has no managed broker: run it on a VM.'),
    },
    facts: [fact('Amazon MQ supports ActiveMQ and RabbitMQ only.', 'https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/welcome.html')],
  },
  'managed-kafka': {
    perPlatform: {
      aws: t('Amazon MSK', ['aws_msk_cluster']),
      azure: t('Azure Event Hubs (Kafka endpoint)', ['azurerm_eventhub_namespace']),
      google: t('Google Cloud Managed Service for Apache Kafka', ['google_managed_kafka_cluster', 'google_managed_kafka_topic']),
      oci: t('OCI Streaming with Apache Kafka', ['oci_managed_kafka_kafka_cluster']),
      vmware: none('VCF has no managed Kafka: run it on VMs or VKS.'),
    },
    facts: [],
  },
  'managed-cache': {
    perPlatform: {
      aws: t('Amazon ElastiCache / Amazon MemoryDB', ['aws_elasticache_replication_group', 'aws_memorydb_cluster']),
      azure: t('Azure Managed Redis', ['azurerm_managed_redis']),
      google: t('Memorystore', ['google_memorystore_instance']),
      oci: t('OCI Cache', ['oci_redis_redis_cluster']),
      vmware: none('VCF has no managed cache: run Redis / Valkey on a VM.'),
    },
    facts: [fact('Azure Cache for Redis retires (Enterprise tiers 2027-03-31, the other tiers 2028-09-30); Azure Managed Redis is the target.', 'https://learn.microsoft.com/en-us/azure/azure-cache-for-redis/retirement-faq')],
  },
  'managed-search': {
    perPlatform: {
      aws: t('Amazon OpenSearch Service', ['aws_opensearch_domain']),
      azure: none('Azure has no first-party OpenSearch / Elasticsearch service: Elastic Cloud (a marketplace SaaS, report-only) or a VM.'),
      google: none('Google Cloud has no first-party OpenSearch / Elasticsearch service: Elastic Cloud (report-only) or a VM.'),
      oci: t('OCI Search with OpenSearch', ['oci_opensearch_opensearch_cluster']),
      vmware: none('VCF has no managed search: run it on VMs.'),
    },
    facts: [],
  },
  appliance: {
    perPlatform: {
      aws: t('AWS Marketplace AMI (by product code)', ['aws_instance']),
      azure: t('Azure Marketplace image with its plan agreement', ['azurerm_marketplace_agreement', 'azurerm_linux_virtual_machine']),
      google: t('Vendor image project (Google Cloud Marketplace)', ['google_compute_instance']),
      oci: t('OCI Marketplace listing (app catalog subscription)', ['oci_core_app_catalog_listing_resource_version_agreement', 'oci_core_app_catalog_subscription', 'oci_core_instance']),
      vmware: t('Vendor OVA on vSphere', ['vsphere_virtual_machine']),
    },
    facts: [],
  },
  specialist: {
    perPlatform: { aws: t('Specialist partner', [], { noTerraform: SPECIALIST }), azure: t('Specialist partner', [], { noTerraform: SPECIALIST }), google: t('Specialist partner', [], { noTerraform: SPECIALIST }), oci: t('Specialist partner', [], { noTerraform: SPECIALIST }), vmware: t('Specialist partner', [], { noTerraform: SPECIALIST }) },
    facts: [],
  },
  retire: {
    perPlatform: { aws: none('Retired: nothing is built.'), azure: none('Retired: nothing is built.'), google: none('Retired: nothing is built.'), oci: none('Retired: nothing is built.'), vmware: none('Retired: nothing is built.') },
    facts: [],
  },
  retain: {
    perPlatform: { aws: none('Retained on premises.'), azure: none('Retained on premises.'), google: none('Retained on premises.'), oci: none('Retained on premises.'), vmware: none('Retained on premises.') },
    facts: [],
  },
};

export const TIER_PATTERNS                                                 = Object.freeze(
  Object.fromEntries((Object.keys(TIER)                 ).map((id) => [id, Object.freeze({ id, ...TIER[id] })]))                                        ,
);

/** What a tier pattern becomes on a platform. */
export const tierTarget = (tp             , platform          )             => TIER_PATTERNS[tp].perPlatform[platform];

/** The tier pattern exists on the platform (as a service, even one built by runbook). */
export function tierAvailable(tp             , platform          )          {
  return !isNone(tierTarget(tp, platform));
}

/** Tier patterns where the item keeps a database service of its own choosing, and whether that service must be managed. */
export const DB_TIER_MANAGED                                                  = {
  'managed-db': true, 'managed-cache': true, 'managed-search': true,
  vm: false, 'sap-certified': false, 'vmware-service': false,
};

/** Every Terraform type the tier patterns name on a platform. */
export function tierTerraformTypes(platform          )           {
  const out = new Set        ();
  for (const info of Object.values(TIER_PATTERNS)) {
    const o = info.perPlatform[platform];
    if (!isNone(o)) for (const ty of o.terraform) out.add(ty);
  }
  return [...out].sort();
}
