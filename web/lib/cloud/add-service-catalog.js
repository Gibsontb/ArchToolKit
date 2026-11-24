import { AWS_ECS_SERVICE } from './aws-ecs-service.js';
import { AWS_EFS_SERVICE } from './aws-efs-service.js';
import { AWS_EBS_SERVICE } from './aws-ebs-service.js';
import { AWS_ALB_SERVICE } from './aws-alb-service.js';
import { AWS_API_SERVICE } from './aws-api-service.js';
import { AWS_EKS_SERVICE } from './aws-eks-service.js';
import { AWS_EVENTBRIDGE_SERVICE } from './aws-eventbridge-service.js';
import { AWS_STEPFUNCTIONS_SERVICE } from './aws-stepfunctions-service.js';
import { AWS_ACM_SERVICE } from './aws-acm-service.js';
import { AWS_BACKUP_SERVICE } from './aws-backup-service.js';
import { AWS_ECS_APP_SERVICE } from './aws-ecs-app-service.js';
import { AWS_AUTOSCALING_SERVICE } from './aws-autoscaling-service.js';
import { AWS_ELASTICACHE_SERVICE } from './aws-elasticache-service.js';
import { AWS_CLOUDTRAIL_SERVICE } from './aws-cloudtrail-service.js';
import { AWS_WAF_SERVICE } from './aws-waf-service.js';
import { AWS_PARAMETER_SERVICE } from './aws-parameter-service.js';
import { AWS_KINESIS_SERVICE } from './aws-kinesis-service.js';
import { AWS_CLOUDFRONT_SERVICE } from './aws-cloudfront-service.js';
import { AWS_ENDPOINT_SERVICE } from './aws-endpoint-service.js';
import { AWS_AURORA_SERVICE } from './aws-aurora-service.js';
import { AWS_RDS_PROXY_SERVICE } from './aws-rds-proxy-service.js';
import { AWS_NLB_SERVICE } from './aws-nlb-service.js';
import { AWS_CONFIG_SERVICE } from './aws-config-service.js';
import { AWS_APPCONFIG_SERVICE } from './aws-appconfig-service.js';
import { AWS_LAMBDA_SQS_SERVICE } from './aws-lambda-sqs-service.js';
import { AWS_IDENTITY_CENTER_SERVICE } from './aws-identity-center-service.js';
import { AWS_SERVICE_AVAILABILITY,                          } from './aws-service-availability.js';
import { AWS_APPRUNNER_SERVICE } from './aws-apprunner-service.js';
import { AWS_PROMETHEUS_SERVICE } from './aws-prometheus-service.js';
import { AWS_ACCESS_ANALYZER_SERVICE } from './aws-access-analyzer-service.js';
import { AWS_DASHBOARD_SERVICE } from './aws-dashboard-service.js';
import { AWS_BUDGETS_SERVICE } from './aws-budgets-service.js';
import { AWS_CODEBUILD_SERVICE } from './aws-codebuild-service.js';
import { AWS_ATHENA_SERVICE } from './aws-athena-service.js';
import { AWS_DATASYNC_SERVICE } from './aws-datasync-service.js';
import { AWS_DATASYNC_NFS_SERVICE } from './aws-datasync-nfs-service.js';
import { AWS_DATASYNC_EFS_SERVICE } from './aws-datasync-efs-service.js';
import { AWS_DATASYNC_SMB_SERVICE } from './aws-datasync-smb-service.js';
import { AWS_COGNITO_SERVICE } from './aws-cognito-service.js';
import { AWS_INSPECTOR_SERVICE } from './aws-inspector-service.js';
import { AWS_SECURITYHUB_SERVICE } from './aws-securityhub-service.js';
import { AWS_BATCH_SERVICE } from './aws-batch-service.js';
import { AWS_CLOUDMAP_SERVICE } from './aws-cloudmap-service.js';
import { AWS_CODEPIPELINE_SERVICE } from './aws-codepipeline-service.js';
import { AWS_OPENSEARCH_SERVERLESS_SERVICE } from './aws-opensearch-serverless-service.js';
import { AWS_REDSHIFT_SERVERLESS_SERVICE } from './aws-redshift-serverless-service.js';
import { AWS_SES_SERVICE } from './aws-ses-service.js';
import { AWS_FSX_OPENZFS_SERVICE } from './aws-fsx-openzfs-service.js';
import { AWS_FSX_LUSTRE_SERVICE } from './aws-fsx-lustre-service.js';
import { AWS_MACIE_SERVICE } from './aws-macie-service.js';
import { AWS_RDS_SQLSERVER_SERVICE } from './aws-rds-sqlserver-service.js';
import { AWS_RDS_ORACLE_SERVICE } from './aws-rds-oracle-service.js';
import { AWS_NAT_SERVICE } from './aws-nat-service.js';
import { AWS_RESOLVER_SERVICE } from './aws-resolver-service.js';
import { AWS_MQ_SERVICE } from './aws-mq-service.js';
import { AWS_DOCDB_SERVICE } from './aws-docdb-service.js';
import { AWS_FSX_WINDOWS_SERVICE } from './aws-fsx-windows-service.js';
import { AWS_DIRECTORY_SERVICE } from './aws-directory-service.js';
import { AWS_PRIVATE_API_SERVICE } from './aws-private-api-service.js';
import { AWS_SERVICE_SETUP_ALIASES } from './aws-service-setup-aliases.js';
import { AWS_BEDROCK_SERVICE } from './aws-bedrock-service.js';
import { AWS_WORKSPACES_SERVICE } from './aws-workspaces-service.js';
import { AWS_TRANSFER_SERVICE } from './aws-transfer-service.js';
import { AWS_TRANSFER_EFS_SERVICE } from './aws-transfer-efs-service.js';
import { AWS_DMS_SERVICE } from './aws-dms-service.js';
import { AWS_FIREHOSE_SERVICE } from './aws-firehose-service.js';
import { AWS_OPENSEARCH_DOMAIN_SERVICE } from './aws-opensearch-domain-service.js';
import { AWS_MSK_SERVERLESS_SERVICE } from './aws-msk-serverless-service.js';
import { AWS_MSK_PROVISIONED_SERVICE } from './aws-msk-provisioned-service.js';
import { AWS_GRAFANA_SERVICE } from './aws-grafana-service.js';
import { AWS_NEPTUNE_SERVICE } from './aws-neptune-service.js';
import { AWS_GLUE_ETL_SERVICE } from './aws-glue-etl-service.js';
import { AWS_GLUE_CRAWLER_SERVICE } from './aws-glue-crawler-service.js';
import { AWS_KEYSPACES_SERVICE } from './aws-keyspaces-service.js';
import { AWS_SSM_PATCHING_SERVICE } from './aws-ssm-patching-service.js';
import { AWS_SSM_SESSION_SERVICE } from './aws-ssm-session-service.js';
import { AWS_ROLESANYWHERE_SERVICE } from './aws-rolesanywhere-service.js';
import { AWS_EMR_SERVERLESS_SERVICE } from './aws-emr-serverless-service.js';
import { AWS_RUNTIME_APIS } from './aws-runtime-apis.js';
import { AWS_FLINK_SERVICE } from './aws-flink-service.js';
import { AWS_FSX_ONTAP_SERVICE } from './aws-fsx-ontap-service.js';
import { AWS_MEMORYDB_SERVICE } from './aws-memorydb-service.js';
import { AWS_ACTIVEMQ_SERVICE } from './aws-activemq-service.js';
import { AWS_COGNITO_M2M_SERVICE } from './aws-cognito-m2m-service.js';
import { AWS_GUARDDUTY_SERVICE } from './aws-guardduty-service.js';
import { AWS_CLOUDWATCH_SERVICE, AWS_CLOUDWATCH_LOGS_SERVICE } from './aws-observability-services.js';
import { AWS_ROUTE53_SERVICE } from './aws-route53-service.js';
import {AWS_IAM_SERVICE} from './aws-iam-service.js';
import {AWS_SECRETS_SERVICE,AWS_KMS_SERVICE} from './aws-security-services.js';
import {AWS_DYNAMODB_SERVICE,AWS_ECR_SERVICE} from './aws-data-services.js';
import {AWS_LAMBDA_SERVICE} from './aws-lambda-service.js';
import {vpcServiceForm} from './aws-vpc-service.js';
import {AWS_SQS_SERVICE,AWS_SNS_SERVICE} from './aws-messaging-services.js';
import {AWS_RDS_SERVICE} from './aws-rds-service.js';
import {AWS_S3_SERVICE} from './aws-s3-service.js';
import {ec2ServiceForm} from './aws-ec2-service.js';
import {awsServiceBuilds} from './aws-service-wiring.js';
import { IMPORTED_SERVICE_TAXONOMY } from './imported-service-taxonomy.js';
import { services, catalogFor,                   } from './service-catalog.js';
import { TERRAFORM_BLUEPRINTS } from '../terraform/blueprints/index.js';
import { ANSIBLE_BLUEPRINTS } from '../ansible/blueprints/index.js';
                                                     
import { HYPERV_SERVICES } from './hyperv-services.js';
import { EXIT_TARGETS } from '../multicloud/plan/dcexit/vmware-exit.js';

                             
                     
                       
                           
                          
                                         
                              
                                          
                                        
                                    
                            
                                             
                                
                                                                                                        
 
const allAnsible=ANSIBLE_BLUEPRINTS.flatMap(group=>group.blueprints);
const cache=new Map                              ();
const cloudOf=(platform       )                       =>['aws','azure','google','oci'].includes(platform)?platform                :undefined;
const privateMatch                                ={
  power:/^mod_community_general_aix_/,
  sparc:/^mod_community_general_solaris_zone$/,
  physical:/^mod_community_general_(?:redfish_|ipmi_)/,
  xen:/^mod_community_general_xenserver_/,
  kvm:/^mod_community_libvirt_/,
  proxmox:/^(?:mod_community_proxmox_|pc_proxmox_)/,
  openstack:/^(?:mod_openstack_cloud_|pc_openstack_)/,
  olvm:/^(?:mod_ovirt_ovirt_|pc_ovirt_)/,
  openshift:/^mod_(?:kubevirt_core_|kubernetes_core_|community_okd_)/,
  harvester:/^mod_(?:kubevirt_core_|kubernetes_core_)/,
};




function cloudServices(cloud             )             {
  const source=services(cloud);
  const shortNames                                ={'amazon-elastic-compute-cloud':'Amazon EC2 — Elastic Compute Cloud','amazon-simple-storage-service':'Amazon S3 — Simple Storage Service','amazon-relational-database-service':'Amazon RDS — Relational Database Service','amazon-virtual-private-cloud':'Amazon VPC — Virtual Private Cloud'};
  const rows=source.map(service=>({id:service.id,name:shortNames[service.id]??service.name,category:String(service.category),description:service.description??service.note??'',terraform:[]               ,ansible:[]               ,native:[...(service.cloudformation??[]),...(service.arm??[])],snapshot:catalogFor(cloud).fetched}));
  const shared={id:'shared-platform-components',name:'Account and shared platform components',category:'management-governance',description:'Supporting configurations and integrations that span provider services.',terraform:[]               ,ansible:[]               ,native:[]            ,snapshot:catalogFor(cloud).fetched};
  const normalize=(text       )=>text.toLowerCase().replace(/[^a-z0-9]/g,'');
  const strip=(text       )=>text.replace(/^(?:aws_|azurerm_|google_|oci_|gcp_)/,'').replace(/^azure_rm_/,'');
  const aliases=source.map(service=>new Set([
    normalize(service.id),normalize(service.name),...(service.aka??[]).map(normalize),
    ...service.terraform.map(type=>normalize(strip(type))),
    ...service.terraform.map(type=>normalize(strip(type).split('_')[0] )).filter(value=>value.length>=3&&!['core','storage','network','compute','identity','folder','project','organization'].includes(value)),
  ]));
  const byResource=(type       )=>source.findIndex(service=>service.terraform.includes(type));
  const preferred                             =cloud==='aws'?[
    [/^(?:ec2_vpc|vpc)/,'aws_vpc'],[/^(?:ec2|ami)/,'aws_instance'],[/^s3/,'aws_s3_bucket'],[/^rds/,'aws_db_instance'],[/^dynamodb/,'aws_dynamodb_table'],[/^sns/,'aws_sns_topic'],[/^sqs/,'aws_sqs_queue'],[/^lambda/,'aws_lambda_function'],[/^eks/,'aws_eks_cluster'],[/^ecs/,'aws_ecs_cluster'],[/^(?:elb|alb|nlb)/,'aws_lb'],[/^cloudwatch/,'aws_cloudwatch_metric_alarm'],[/^iam/,'aws_iam_role'],[/^route53/,'aws_route53_zone'],
  ]:cloud==='azure'?[
    [/^(?:vm_|vmss|azure_rm_virtualmachine|azure_rm_availability)/,'azurerm_linux_virtual_machine'],[/^(?:vnet|azure_rm_virtualnetwork|azure_rm_subnet)/,'azurerm_virtual_network'],[/^(?:storage|azure_rm_storage)/,'azurerm_storage_account'],[/^(?:sql|azure_rm_sql)/,'azurerm_mssql_server'],[/^(?:app_service|azure_rm_webapp)/,'azurerm_linux_web_app'],[/^(?:aks|azure_rm_aks)/,'azurerm_kubernetes_cluster'],
  ]:cloud==='google'?[
    [/^gce/,'google_compute_instance'],[/^gcs/,'google_storage_bucket'],[/^gke/,'google_container_cluster'],[/^cloud_sql/,'google_sql_database_instance'],
  ]:[
    [/^(?:compute|oci_compute)/,'oci_core_instance'],[/^(?:object_bucket|oci_objectstorage)/,'oci_objectstorage_bucket'],[/^(?:vcn|oci_network)/,'oci_core_vcn'],[/^(?:autonomous_database|oci_database_autonomous)/,'oci_database_autonomous_database'],[/^oke/,'oci_containerengine_cluster'],
  ];
  const bind=(blueprint          ,method                      )=>{
    const targets=new Set        ();
    for(const type of blueprint.emits){const index=byResource(type);if(index>=0)targets.add(index);}
    if(blueprint.id.startsWith('res_')){const index=byResource(blueprint.id.slice(4));if(index>=0)targets.add(index);}
    if(targets.size===0){
      const names=[blueprint.id,...blueprint.emits.map(type=>type.split('.').at(-1) )].map(name=>name.replace(/^mod_[^_]+_[^_]+_/,'').replace(/^(?:awsmod_|azmod_|gcpmod_|ocimod_)/,''));
      for(const [pattern,resource] of preferred)if(names.some(name=>pattern.test(name))){const index=byResource(resource);if(index>=0)targets.add(index);}
      if(targets.size===0){
        const values=names.map(name=>normalize(strip(name)));
        let best=0,index=-1;
        aliases.forEach((names,i)=>{for(const alias of names)if(alias.length>=3&&values.some(value=>value===alias||value.startsWith(alias))&&alias.length>best){best=alias.length;index=i;}});
        if(index>=0)targets.add(index);
      }
    }
    if(!targets.size)shared[method].push(blueprint);else for(const index of targets)rows[index] [method].push(blueprint);
  };
  for(const blueprint of TERRAFORM_BLUEPRINTS.find(group=>group.target===cloud)?.blueprints??[])bind(blueprint,'terraform');
  for(const blueprint of ANSIBLE_BLUEPRINTS.find(group=>group.target===cloud)?.blueprints??[])bind(blueprint,'ansible');
  // Public product names and provider API namespaces are different catalog entries.
  // Expose the same real definitions under the public product as well.
  const productLinks                                =cloud==='azure'?{
    'virtual-machines':/virtual_machine|virtualmachine|^vm_/, 'azure-sql-database':/mssql|sql_db|azure_rm_sql/,
    'azure-kubernetes-service-aks':/kubernetes_cluster|azure_rm_aks|^aks_/,
  }:cloud==='google'?{
    'compute-engine':/google_compute_|gcp_compute_|^gce_/, 'cloud-sql':/google_sql_|gcp_sql_|^cloud_sql_/,
    'cloud-storage':/google_storage_|gcp_storage_|^gcs_/,
  }:cloud==='oci'?{
    'compute-virtual-machine':/^res_oci_core_instance|oci_compute_.*instance|^compute_instance/,
    'cloud-infrastructure-kubernetes-engine-oke':/containerengine|oke_cluster/,
  }:{};
  for(const [id,pattern] of Object.entries(productLinks)){
    const row=rows.find(row=>row.id===id);if(!row)continue;
    for(const method of ['terraform','ansible']         ){
      const all=method==='terraform'?TERRAFORM_BLUEPRINTS.find(group=>group.target===cloud)?.blueprints:ANSIBLE_BLUEPRINTS.find(group=>group.target===cloud)?.blueprints;
      for(const blueprint of all??[])if(pattern.test(blueprint.id+' '+blueprint.emits.join(' '))&&!row[method].includes(blueprint))row[method].push(blueprint);
    }
  }
  if(shared.terraform.length||shared.ansible.length)rows.push(shared);
  const primaryBuilds                                ={
    'amazon-elastic-compute-cloud':'aws_ec2_instance','amazon-simple-storage-service':'res_aws_s3_bucket',
    'virtual-machines':'azure_module_vm','cloud-sql':'res_google_sql_database_instance','cloud-storage':'res_google_storage_bucket',
    'compute-virtual-machine':'res_oci_core_instance',
  };
  for(const row of rows)row.terraform.sort((a,b)=>{
    const score=(blueprint          )=>blueprint.id===primaryBuilds[row.id]?-100:/mig_|estate/.test(blueprint.id)?100:blueprint.id.startsWith('res_')?10:0;
    return score(a)-score(b);
  });
  return rows;
}


/** Merge taxonomy labels without dropping or cloning original build definitions. */
function applyTaxonomy(platform       ,rows             )             {
  const entries=IMPORTED_SERVICE_TAXONOMY[platform                                          ];
  if(!entries)return rows;
  const normalize=(value       )=>value.toLowerCase().replace(/\([^)]*\)/g,'').replace(/^(?:amazon|aws|microsoft azure|azure|google cloud|google|vmware|red hat)\s+/,'').replace(/[^a-z0-9]/g,'');
  const aliases                      ={ec2:'elasticcomputecloud',s3:'simplestorageservice',rds:'relationaldatabaseservice',vpc:'virtualprivatecloud'};
  const key=(value       )=>{const normalized=normalize(value.split(' — ')[0] );return aliases[normalized]??normalized;};
  const groups=new Map                                                              ();
  for(const entry of entries){if(/^(?:Terraform|Ansible)\b/i.test(entry.name))continue;const id=key(('vendor' in entry?entry.vendor+' ':'')+entry.name);const group=groups.get(id)??{name:('vendor' in entry?entry.vendor+' — ':'')+entry.name,categories:[],description:'description' in entry?entry.description+('automationDriver' in entry?' Reference automation: '+entry.automationDriver:''):undefined};if(!group.categories.includes(entry.category))group.categories.push(entry.category);groups.set(id,group);}
  for(const [id,group] of groups){
    const matches=rows.filter(row=>key(row.name)===id||key(row.id.replace(/-/g,' '))===id);
    if(matches.length){for(const row of matches){const index=rows.indexOf(row);rows[index]={...row,category:group.categories[0] ,categories:group.categories};}}
    else rows.push({id:'taxonomy:'+id,name:group.name,category:group.categories[0] ,categories:group.categories,description:group.description??'Listed in the supplied service catalog. A native build definition is not yet mapped.',terraform:[],ansible:[],native:[]});
  }
  return rows;
}

/** Every definition comes directly from the existing Terraform/Ansible systems. */
export function addServicesFor(platform       )                      {
  const key=platform==='vcf'?'vmware':platform;
  if(!['vmware','vsphere'].includes(key)&&!EXIT_TARGETS.some(target=>target.id===key)&&!TERRAFORM_BLUEPRINTS.some(group=>group.target===key)&&!ANSIBLE_BLUEPRINTS.some(group=>group.target===key))return [];
  const cached=cache.get(key);if(cached)return cached;
  const cloud=cloudOf(key);
  const tfTargets=cloud?[cloud]:key==='vmware'?['vcf','vsphere']:key==='vmware-cloud'?['vsphere']:[key];
  const terraform=TERRAFORM_BLUEPRINTS.filter(group=>tfTargets.includes(group.target)).flatMap(group=>group.blueprints);
  if(key==='azure-local')terraform.push(...(TERRAFORM_BLUEPRINTS.find(group=>group.target==='azure')?.blueprints??[]).filter(blueprint=>blueprint.emits.some(type=>type.startsWith('azurerm_stack_hci_'))));
  const rows             =cloud?cloudServices(cloud):terraform.map(blueprint=>({id:'tf:'+blueprint.id,name:blueprint.label,category:blueprint.group??'Platform services',description:blueprint.description,terraform:[blueprint],ansible:[],native:[],...(cloud?{snapshot:catalogFor(cloud).fetched}:{})}));
  const group=ANSIBLE_BLUEPRINTS.find(group=>group.target===(key==='vmware'||key==='vmware-cloud'?'vsphere':key));
  const ansible=key==='hyperv'?HYPERV_SERVICES:(group?.blueprints??allAnsible.filter(blueprint=>privateMatch[key]?.test(blueprint.id)));
  if(!cloud)rows.push(...ansible.map(blueprint=>({id:'ansible:'+blueprint.id,name:blueprint.label,category:blueprint.group??'Platform services',description:blueprint.description,terraform:[],ansible:[blueprint],native:[]})));
  const merged=applyTaxonomy(key,rows);
  if(key==='aws'){
    const macie = merged.find(row => row.id === 'amazon-macie');
    if (macie) merged[merged.indexOf(macie)] = { ...macie, terraform: [AWS_MACIE_SERVICE, ...macie.terraform] };
    const lustre = merged.find(row => row.id === 'taxonomy:fsxforlustre');
    if (lustre) merged[merged.indexOf(lustre)] = { ...lustre, terraform: [AWS_FSX_LUSTRE_SERVICE, ...lustre.terraform] };
    const openZfs = merged.find(row => row.id === 'taxonomy:fsxforopenzfs');
    if (openZfs) merged[merged.indexOf(openZfs)] = { ...openZfs, terraform: [AWS_FSX_OPENZFS_SERVICE, ...openZfs.terraform] };
    const emailService = merged.find(row => row.id === 'amazon-simple-email-service');
    if (emailService) merged[merged.indexOf(emailService)] = { ...emailService, terraform: [AWS_SES_SERVICE, ...emailService.terraform] };
    const redshiftServerless = merged.find(row => row.id === 'redshift-serverless');
    if (redshiftServerless) merged[merged.indexOf(redshiftServerless)] = { ...redshiftServerless, terraform: [AWS_REDSHIFT_SERVERLESS_SERVICE, ...redshiftServerless.terraform] };
    const serverlessSearch = merged.find(row => row.id === 'taxonomy:opensearchserverless');
    if (serverlessSearch) merged[merged.indexOf(serverlessSearch)] = { ...serverlessSearch, terraform: [AWS_OPENSEARCH_SERVERLESS_SERVICE, ...serverlessSearch.terraform] };
    const codePipeline = merged.find(row => row.id === 'aws-codepipeline');
    if (codePipeline) merged[merged.indexOf(codePipeline)] = { ...codePipeline, terraform: [AWS_CODEPIPELINE_SERVICE, ...codePipeline.terraform] };
    const cloudMap = merged.find(row => row.id === 'aws-cloud-map');
    if (cloudMap) merged[merged.indexOf(cloudMap)] = { ...cloudMap, terraform: [AWS_CLOUDMAP_SERVICE, ...cloudMap.terraform] };
    const batch = merged.find(row => row.id === 'aws-batch');
    if (batch) merged[merged.indexOf(batch)] = { ...batch, terraform: [AWS_BATCH_SERVICE, ...batch.terraform] };
    const securityHub = merged.find(row => row.id === 'aws-security-hub');
    if (securityHub) merged[merged.indexOf(securityHub)] = { ...securityHub, terraform: [AWS_SECURITYHUB_SERVICE, ...securityHub.terraform] };
    const inspector = merged.find(row => row.id === 'amazon-inspector');
    if (inspector) merged[merged.indexOf(inspector)] = { ...inspector, terraform: [AWS_INSPECTOR_SERVICE, ...inspector.terraform] };
    const cognito = merged.find(row => row.id === 'amazon-cognito');
    if (cognito) merged[merged.indexOf(cognito)] = { ...cognito, terraform: [AWS_COGNITO_SERVICE, ...cognito.terraform] };
    const dataSync = merged.find(row => row.id === 'aws-datasync');
    if (dataSync) merged[merged.indexOf(dataSync)] = { ...dataSync, terraform: [AWS_DATASYNC_SERVICE, AWS_DATASYNC_NFS_SERVICE, AWS_DATASYNC_EFS_SERVICE, AWS_DATASYNC_SMB_SERVICE, ...dataSync.terraform] };
    const athena = merged.find(row => row.id === 'amazon-athena');
    if (athena) merged[merged.indexOf(athena)] = { ...athena, terraform: [AWS_ATHENA_SERVICE, ...athena.terraform] };
    const codeBuild = merged.find(row => row.id === 'aws-codebuild');
    if (codeBuild) merged[merged.indexOf(codeBuild)] = { ...codeBuild, terraform: [AWS_CODEBUILD_SERVICE, ...codeBuild.terraform] };
    const guardDuty = merged.find(row => row.id === 'amazon-guardduty');
    if (guardDuty) merged[merged.indexOf(guardDuty)] = { ...guardDuty, terraform: [AWS_GUARDDUTY_SERVICE, ...guardDuty.terraform] };
    const budgets = merged.find(row => row.id === 'aws-budgets');
    if (budgets) merged[merged.indexOf(budgets)] = { ...budgets, terraform: [AWS_BUDGETS_SERVICE, ...budgets.terraform] };
    const accessAnalyzer = merged.find(row => row.id === 'taxonomy:iamaccessanalyzer');
    if (accessAnalyzer) merged[merged.indexOf(accessAnalyzer)] = { ...accessAnalyzer, terraform: [AWS_ACCESS_ANALYZER_SERVICE, ...accessAnalyzer.terraform] };
    const prometheus = merged.find(row => row.id === 'amazon-managed-service-for-prometheus');
    if (prometheus) merged[merged.indexOf(prometheus)] = { ...prometheus, terraform: [AWS_PROMETHEUS_SERVICE, ...prometheus.terraform] };
    const runner = merged.find(row => row.id === 'aws-app-runner');
    if (runner) merged[merged.indexOf(runner)] = { ...runner, terraform: [AWS_APPRUNNER_SERVICE, ...runner.terraform] };
    for (let index = 0; index < merged.length; index++) {
      const row = merged[index] , availability = AWS_SERVICE_AVAILABILITY[row.id];
      if (availability) merged[index] = { ...row, availability };
    }
    const identityCenter = merged.find(row => row.id === 'aws-iam-identity-center');
    if (identityCenter) merged[merged.indexOf(identityCenter)] = { ...identityCenter, terraform: [AWS_IDENTITY_CENTER_SERVICE, ...identityCenter.terraform] };
    const appConfig = merged.find(row => row.id === 'aws-appconfig');
    if (appConfig) merged[merged.indexOf(appConfig)] = { ...appConfig, terraform: [AWS_APPCONFIG_SERVICE, ...appConfig.terraform] };
    const configService = merged.find(row => row.id === 'aws-config');
    if (configService) merged[merged.indexOf(configService)] = { ...configService, terraform: [AWS_CONFIG_SERVICE, ...configService.terraform] };
    const proxy = merged.find(row => row.id === 'taxonomy:rdsproxy');
    if (proxy) merged[merged.indexOf(proxy)] = { ...proxy, terraform: [AWS_RDS_PROXY_SERVICE, ...proxy.terraform] };
    const aurora = merged.find(row => row.id === 'amazon-aurora');
    if (aurora) merged[merged.indexOf(aurora)] = { ...aurora, terraform: [AWS_AURORA_SERVICE, ...aurora.terraform] };
    const endpoint = merged.find(row => row.id === 'taxonomy:privatelink');
    if (endpoint) merged[merged.indexOf(endpoint)] = { ...endpoint, terraform: [AWS_ENDPOINT_SERVICE, ...endpoint.terraform] };
    const edge = merged.find(row => row.id === 'amazon-cloudfront');
    if (edge) merged[merged.indexOf(edge)] = { ...edge, terraform: [AWS_CLOUDFRONT_SERVICE, ...edge.terraform] };
    const stream = merged.find(row => row.id === 'taxonomy:kinesisdatastreams');
    if (stream) merged[merged.indexOf(stream)] = { ...stream, terraform: [AWS_KINESIS_SERVICE, ...stream.terraform] };
    const parameter = merged.find(row => row.id === 'taxonomy:systemsmanagerparameterstore');
    if (parameter) merged[merged.indexOf(parameter)] = { ...parameter, terraform: [AWS_PARAMETER_SERVICE, ...parameter.terraform] };
    const waf = merged.find(row => row.id === 'aws-wafv2');
    if (waf) merged[merged.indexOf(waf)] = { ...waf, terraform: [AWS_WAF_SERVICE, ...waf.terraform] };
    const trail = merged.find(row => row.id === 'aws-cloudtrail');
    if (trail) merged[merged.indexOf(trail)] = { ...trail, terraform: [AWS_CLOUDTRAIL_SERVICE, ...trail.terraform] };
    const cacheService = merged.find(row => row.id === 'amazon-elasticache');
    if (cacheService) merged[merged.indexOf(cacheService)] = { ...cacheService, terraform: [AWS_ELASTICACHE_SERVICE, ...cacheService.terraform] };
    const scaling = merged.find(row => row.id === 'amazon-ec2-auto-scaling');
    if (scaling) merged[merged.indexOf(scaling)] = { ...scaling, terraform: [AWS_AUTOSCALING_SERVICE, ...scaling.terraform] };
    const ecsApp = merged.find(row => row.id === 'amazon-elastic-container-service');
    if (ecsApp) merged[merged.indexOf(ecsApp)] = { ...ecsApp, terraform: [AWS_ECS_APP_SERVICE, ...ecsApp.terraform] };
    const backup = merged.find(row => row.id === 'aws-backup');
    if (backup) merged[merged.indexOf(backup)] = { ...backup, terraform: [AWS_BACKUP_SERVICE, ...backup.terraform] };
    const acm = merged.find(row => row.id === 'aws-certificate-manager');
    if (acm) merged[merged.indexOf(acm)] = { ...acm, terraform: [AWS_ACM_SERVICE, ...acm.terraform] };
    const steps = merged.find(row => row.id === 'aws-step-functions');
    if (steps) merged[merged.indexOf(steps)] = { ...steps, terraform: [AWS_STEPFUNCTIONS_SERVICE, ...steps.terraform] };
    const events = merged.find(row => row.id === 'amazon-eventbridge');
    if (events) merged[merged.indexOf(events)] = { ...events, terraform: [AWS_EVENTBRIDGE_SERVICE, ...events.terraform] };
    const eks = merged.find(row => row.id === 'amazon-elastic-kubernetes-service');
    if (eks) merged[merged.indexOf(eks)] = { ...eks, terraform: [AWS_EKS_SERVICE, ...eks.terraform] };
    const api = merged.find(row => row.id === 'amazon-api-gateway');
    if (api) merged[merged.indexOf(api)] = { ...api, terraform: [AWS_API_SERVICE, AWS_PRIVATE_API_SERVICE, ...api.terraform] };
    const elb = merged.find(row => row.id === 'elastic-load-balancing');
    if (elb) merged[merged.indexOf(elb)] = { ...elb, terraform: [AWS_ALB_SERVICE, AWS_NLB_SERVICE, ...elb.terraform] };
    const ebs = merged.find(row => row.id === 'amazon-elastic-block-store');
    if (ebs) merged[merged.indexOf(ebs)] = { ...ebs, terraform: [AWS_EBS_SERVICE, ...ebs.terraform] };
    const efs = merged.find(row => row.id === 'amazon-elastic-file-system');
    if (efs) merged[merged.indexOf(efs)] = { ...efs, terraform: [AWS_EFS_SERVICE, ...efs.terraform] };
    for(const [id,form] of [['amazon-simple-queue-service',AWS_SQS_SERVICE],['amazon-simple-notification-service',AWS_SNS_SERVICE],['amazon-dynamodb',AWS_DYNAMODB_SERVICE],['amazon-elastic-container-registry',AWS_ECR_SERVICE],['aws-secrets-manager',AWS_SECRETS_SERVICE],['aws-key-management-service',AWS_KMS_SERVICE],['aws-identity-and-access-management',AWS_IAM_SERVICE],['amazon-cloudwatch',AWS_CLOUDWATCH_SERVICE],['amazon-cloudwatch-logs',AWS_CLOUDWATCH_LOGS_SERVICE],['amazon-route-53',AWS_ROUTE53_SERVICE],['amazon-elastic-container-service',AWS_ECS_SERVICE]]         ){const row=merged.find(row=>row.id===id);if(row)merged[merged.indexOf(row)]={...row,terraform:[form,...row.terraform]};}
    const dashboards = merged.find(row => row.id === 'amazon-cloudwatch');
    if (dashboards) merged[merged.indexOf(dashboards)] = { ...dashboards, terraform: [AWS_CLOUDWATCH_SERVICE, AWS_DASHBOARD_SERVICE, ...dashboards.terraform.filter(form => form !== AWS_CLOUDWATCH_SERVICE)] };
    const lambda=merged.find(row=>row.id==='aws-lambda');
    if(lambda)merged[merged.indexOf(lambda)]={...lambda,terraform:[AWS_LAMBDA_SERVICE,AWS_LAMBDA_SQS_SERVICE,...lambda.terraform]};
    const rds=merged.find(row=>row.id==='amazon-relational-database-service');
    if(rds)merged[merged.indexOf(rds)]={...rds,terraform:[AWS_RDS_SERVICE,AWS_RDS_SQLSERVER_SERVICE,AWS_RDS_ORACLE_SERVICE,...rds.terraform]};
    const s3=merged.find(row=>row.id==='amazon-simple-storage-service');
    if(s3)merged[merged.indexOf(s3)]={...s3,terraform:[AWS_S3_SERVICE,...s3.terraform]};
    const vpc=merged.find(row=>row.id==='amazon-virtual-private-cloud');
    const resolver=merged.find(row=>row.id==='amazon-route-53-resolver');
    if(resolver)merged[merged.indexOf(resolver)]={...resolver,terraform:[AWS_RESOLVER_SERVICE,...resolver.terraform]};
    const mq=merged.find(row=>row.id==='amazon-mq');
    if(mq)merged[merged.indexOf(mq)]={...mq,terraform:[AWS_MQ_SERVICE,...mq.terraform]};
    const docdb=merged.find(row=>row.id==='amazon-documentdb-with-mongodb-compatibility');
    if(docdb)merged[merged.indexOf(docdb)]={...docdb,terraform:[AWS_DOCDB_SERVICE,...docdb.terraform]};
    const fsxWindows=merged.find(row=>row.id==='taxonomy:fsxforwindowsfileserver');
    if(fsxWindows)merged[merged.indexOf(fsxWindows)]={...fsxWindows,terraform:[AWS_FSX_WINDOWS_SERVICE,...fsxWindows.terraform]};
    const directory=merged.find(row=>row.id==='aws-directory-service');
    if(directory)merged[merged.indexOf(directory)]={...directory,terraform:[AWS_DIRECTORY_SERVICE,...directory.terraform]};
    const bedrock=merged.find(row=>row.id==='amazon-bedrock');
    if(bedrock)merged[merged.indexOf(bedrock)]={...bedrock,terraform:[AWS_BEDROCK_SERVICE,...bedrock.terraform]};
    const workspaces=merged.find(row=>row.id==='amazon-workspaces');
    if(workspaces)merged[merged.indexOf(workspaces)]={...workspaces,terraform:[AWS_WORKSPACES_SERVICE,...workspaces.terraform]};
    const transfer=merged.find(row=>row.id==='aws-transfer-family');
    if(transfer)merged[merged.indexOf(transfer)]={...transfer,terraform:[AWS_TRANSFER_SERVICE,AWS_TRANSFER_EFS_SERVICE,...transfer.terraform]};
    const dms=merged.find(row=>row.id==='aws-database-migration-service');
    if(dms)merged[merged.indexOf(dms)]={...dms,terraform:[AWS_DMS_SERVICE,...dms.terraform]};
    const firehose=merged.find(row=>row.id==='amazon-data-firehose');
    if(firehose)merged[merged.indexOf(firehose)]={...firehose,terraform:[AWS_FIREHOSE_SERVICE,...firehose.terraform]};
    const searchDomain=merged.find(row=>row.id==='amazon-opensearch-service');
    if(searchDomain)merged[merged.indexOf(searchDomain)]={...searchDomain,terraform:[AWS_OPENSEARCH_DOMAIN_SERVICE,...searchDomain.terraform]};
    const kafka=merged.find(row=>row.id==='amazon-managed-streaming-for-apache-kafka');
    if(kafka)merged[merged.indexOf(kafka)]={...kafka,terraform:[AWS_MSK_SERVERLESS_SERVICE,AWS_MSK_PROVISIONED_SERVICE,...kafka.terraform]};
    const grafana=merged.find(row=>row.id==='amazon-managed-grafana');
    if(grafana)merged[merged.indexOf(grafana)]={...grafana,terraform:[AWS_GRAFANA_SERVICE,...grafana.terraform]};
    const neptune=merged.find(row=>row.id==='amazon-neptune');
    if(neptune)merged[merged.indexOf(neptune)]={...neptune,terraform:[AWS_NEPTUNE_SERVICE,...neptune.terraform]};
    const glueEtl=merged.find(row=>row.id==='aws-glue');
    if(glueEtl)merged[merged.indexOf(glueEtl)]={...glueEtl,terraform:[AWS_GLUE_ETL_SERVICE,AWS_GLUE_CRAWLER_SERVICE,...glueEtl.terraform]};
    const keyspaces = merged.find(row => row.id === 'amazon-keyspaces-for-apache-cassandra');
    if(keyspaces)merged[merged.indexOf(keyspaces)]={...keyspaces,terraform:[AWS_KEYSPACES_SERVICE,...keyspaces.terraform]};
    const systemsManager = merged.find(row => row.id === 'aws-systems-manager');
    if(systemsManager)merged[merged.indexOf(systemsManager)]={...systemsManager,terraform:[AWS_SSM_PATCHING_SERVICE,AWS_SSM_SESSION_SERVICE,...systemsManager.terraform]};
    const sessions = merged.find(row => row.id === 'taxonomy:systemsmanagersessionmanager');
    if(sessions)merged[merged.indexOf(sessions)]={...sessions,terraform:[AWS_SSM_SESSION_SERVICE,...sessions.terraform]};
    const rolesAnywhere = merged.find(row => row.id === 'iam-roles-anywhere');
    if(rolesAnywhere)merged[merged.indexOf(rolesAnywhere)]={...rolesAnywhere,terraform:[AWS_ROLESANYWHERE_SERVICE,...rolesAnywhere.terraform]};
    const emrServerless=merged.find(row=>row.id==='amazon-emr');
    if(emrServerless)merged[merged.indexOf(emrServerless)]={...emrServerless,terraform:[AWS_EMR_SERVERLESS_SERVICE,...emrServerless.terraform]};
    const flink=merged.find(row=>row.id==='taxonomy:kinesisdataanalytics');
    if(flink)merged[merged.indexOf(flink)]={...flink,terraform:[AWS_FLINK_SERVICE,...flink.terraform]};
    const ontap=merged.find(row=>row.id==='amazon-fsx');
    if(ontap)merged[merged.indexOf(ontap)]={...ontap,terraform:[AWS_FSX_ONTAP_SERVICE,...ontap.terraform]};
    const memorydb=merged.find(row=>row.id==='amazon-memorydb');
    if(memorydb)merged[merged.indexOf(memorydb)]={...memorydb,terraform:[AWS_MEMORYDB_SERVICE,...memorydb.terraform]};
    const activemq=merged.find(row=>row.id==='amazon-mq');
    if(activemq)merged[merged.indexOf(activemq)]={...activemq,terraform:[...activemq.terraform.filter(form=>form.id.startsWith('aws_service_')),AWS_ACTIVEMQ_SERVICE,...activemq.terraform.filter(form=>!form.id.startsWith('aws_service_'))]};
    const cognitoM2m=merged.find(row=>row.id==='amazon-cognito');
    if(cognitoM2m)merged[merged.indexOf(cognitoM2m)]={...cognitoM2m,terraform:[...cognitoM2m.terraform.filter(form=>form.id.startsWith('aws_service_')),AWS_COGNITO_M2M_SERVICE,...cognitoM2m.terraform.filter(form=>!form.id.startsWith('aws_service_'))]};
    const vpcOriginal=vpc?.terraform.find(blueprint=>blueprint.id==='aws_vpc_baseline');
    if(vpc&&vpcOriginal)merged[merged.indexOf(vpc)]={...vpc,terraform:[vpcServiceForm(vpcOriginal),AWS_NAT_SERVICE,...vpc.terraform]};
    const ec2=merged.find(row=>row.id==='amazon-elastic-compute-cloud');
    const original=ec2?.terraform.find(blueprint=>blueprint.id==='aws_ec2_instance');
    if(ec2&&original)merged[merged.indexOf(ec2)]={...ec2,terraform:[ec2ServiceForm(original),...ec2.terraform]};
    for(let index=0;index<merged.length;index++){
      const row=merged[index] ;
      const builds=awsServiceBuilds(row.name,terraform);
      if(builds.length)merged[index]={...row,terraform:[...new Set([...row.terraform,...builds])]};
    }
    for(const [id, runtimeApi] of Object.entries(AWS_RUNTIME_APIS)) {
      const index=merged.findIndex(row=>row.id===id);
      if(index>=0)merged[index]={...merged[index] ,runtimeApi};
    }
    for(const [id, alias] of Object.entries(AWS_SERVICE_SETUP_ALIASES)) {
      const index=merged.findIndex(row=>row.id===id), canonical=merged.find(row=>row.id===alias.canonical);
      if(index>=0&&canonical) {
        const row=merged[index] ;
        merged[index]={...row,setupAliasOf:canonical.id,terraform:[...new Set([...canonical.terraform,...row.terraform])],ansible:[...new Set([...canonical.ansible,...row.ansible])],native:[...new Set([...row.native,...canonical.native])],...(canonical.availability?{availability:canonical.availability}:{})};
      }
    }
  }
  if(key==='azure'){
    const local=merged.find(row=>row.id==='azure-local');
    if(local){const index=merged.indexOf(local);merged[index]={...local,category:'Hybrid + Multicloud',categories:['Hybrid + Multicloud'],description:'Hybrid infrastructure running on customer-managed hardware, connected to Azure. Configure the site, hosts and networking in the selected build definition.',terraform:[...new Set([...local.terraform,...terraform.filter(blueprint=>blueprint.emits.some(type=>type.startsWith('azurerm_stack_hci_')))])]};}
  }
  merged.sort((a,b)=>a.name.localeCompare(b.name));cache.set(key,merged);return merged;
}

/** Additional targets exposed by the source tools, beyond infrastructure vendors. */
export function additionalServicePlatforms()                                       {
  const all=[...TERRAFORM_BLUEPRINTS,...ANSIBLE_BLUEPRINTS].filter(group=>['aws','azure','google','oci','vcf','vsphere',...EXIT_TARGETS.map(target=>target.id)].includes(group.target));
  return [...new Map(all.map(group=>[group.target,{value:group.target,label:group.label}])).values()];
}
