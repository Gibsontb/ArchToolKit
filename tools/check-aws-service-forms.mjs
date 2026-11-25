/** Local browser-to-export regression checks. No cloud access.
 * PLAYWRIGHT_CORE may name an installed Playwright package; CHROME_PATH may select Chrome.
 * node tools/check-aws-service-forms.mjs
 * Optional --validate uses TERRAFORM_PATH to validate downloaded packages afterward.
 * --runtime-only [--region us-gov-west-1] checks navigation/retirement/eligibility without repeating exports.
 */
import { createRequire } from 'node:module';
import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import { openZip } from '../src/core/zip.ts';
import { ROOT, WORK_TMP } from './work.mjs';
import { publicTestKey } from './service-test-ssh.mjs';
import { AWS_SERVICE_AVAILABILITY } from '../src/cloud/aws-service-availability.ts';
import { AWS_RUNTIME_APIS } from '../src/cloud/aws-runtime-apis.ts';
import { AWS_SAGEMAKER_SERVICE } from '../src/cloud/aws-sagemaker-service.ts';
import { AWS_MGN_CUTOVER_SERVICE } from '../src/cloud/aws-mgn-cutover-service.ts';
import { AWS_SCHEDULER_SERVICE } from '../src/cloud/aws-scheduler-service.ts';
import { AWS_PIPES_SERVICE } from '../src/cloud/aws-pipes-service.ts';
import { AWS_REDSHIFT_PROVISIONED_SERVICE } from '../src/cloud/aws-redshift-provisioned-service.ts';
import { AWS_DRS_SERVICE } from '../src/cloud/aws-drs-service.ts';
import { AWS_DIRECTCONNECT_SERVICE } from '../src/cloud/aws-directconnect-service.ts';
import { AWS_STORAGEGATEWAY_SERVICE } from '../src/cloud/aws-storagegateway-service.ts';
import { AWS_MWAA_SERVICE } from '../src/cloud/aws-mwaa-service.ts';
import { AWS_ACCESS_ANALYZER_SERVICE } from '../src/cloud/aws-access-analyzer-service.ts';
import { AWS_APPFLOW_SERVICE } from '../src/cloud/aws-appflow-service.ts';
import { AWS_CLOUDWAN_SERVICE } from '../src/cloud/aws-cloudwan-service.ts';
import { AWS_EKS_POD_IDENTITY_SERVICE } from '../src/cloud/aws-eks-pod-identity-service.ts';
import { AWS_INSTANCE_CONNECT_SERVICE } from '../src/cloud/aws-instance-connect-service.ts';
import { AWS_IVS_SERVICE } from '../src/cloud/aws-ivs-service.ts';
import { AWS_IVS_CHAT_SERVICE } from '../src/cloud/aws-ivs-chat-service.ts';
import { AWS_KINESIS_VIDEO_SERVICE } from '../src/cloud/aws-kinesis-video-service.ts';
import { AWS_WEBRTC_SERVICE } from '../src/cloud/aws-webrtc-service.ts';
import { AWS_WEBRTC_STORAGE_SERVICE } from '../src/cloud/aws-webrtc-storage-service.ts';
import { AWS_ELASTICACHE_SERVERLESS_SERVICE } from '../src/cloud/aws-elasticache-serverless-service.ts';
import { AWS_ELASTICACHE_SHARDED_SERVICE } from '../src/cloud/aws-elasticache-sharded-service.ts';
import { defaultValues } from '../src/kit/blueprint.ts';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright');
const subnet = 'subnet-0123456789abcdef0', secondSubnet = 'subnet-0123456789abcdef1', group = 'sg-0123456789abcdef0';
const role = name => 'arn:aws:iam::123456789012:role/' + name;
const fixtures = [
  ...['Account','Contact','Opportunity'].flatMap(object=>['JSON','CSV'].map(format=>['amazon-appflow','aws_service_appflow_salesforce_s3',{name:'reviewed-export',account:'123456789012',profile:'approved-private-salesforce',instance:'https://approved.my.salesforce.com',bucket:'approved-flow-output',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc',object,format},'aws_appflow_flow'])),
  ...[['2.11.2','mw1.small'],['2.11.0','mw1.medium'],['2.10.3','mw1.large']].map(([version,size])=>['amazon-mwaa','aws_service_mwaa_private',{name:'reviewed-workflows',account:'123456789012',bucket:'approved-airflow-dags',role:'approved-airflow-execution',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc',subnets:['subnet-12345678','subnet-abcdef12'],group:'sg-12345678',version,size},'aws_mwaa_environment']),
  ...['READ_ONLY','READ_WRITE'].flatMap(mode=>['RootSquash','AllSquash'].map(squash=>['aws-storage-gateway','aws_service_storagegateway_nfs',{name:'approved-files',account:'123456789012',gateway:'arn:aws:storagegateway:us-east-1:123456789012:gateway/sgw-1234ABCD',bucket:'approved-file-storage',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc',audit:'/approved/file-audit',clients:'10.20.0.0/24',mode,squash,...(squash==='AllSquash'?{permissions:'OWNER',storage:'S3_INTELLIGENT_TIERING'}:{})},'aws_storagegateway_nfs_file_share'])),
  ...['none','vpc'].map(attachment=>['aws-cloud-wan','aws_service_cloudwan_isolated_core',{name:'isolated-core',account:'123456789012',attachment,edges:['us-east-1','us-west-2'],...(attachment==='vpc'?{vpc:'vpc-12345678',subnets:['subnet-12345678','subnet-abcdef12']}:{})},'aws_networkmanager_core_network']),
  ...[['FRR','eth0'],['CISCO','TenGigabitEthernet0/0/0'],['JUNOS','xe-0/0/0']].map(([vendor,port])=>['aws-direct-connect','aws_service_directconnect_private_vif',{name:'private-vif',account:'123456789012',connection:'dxcon-1234abcd',connection_name:'approved-circuit',gateway:'12345678-abcd-4bcd-8bcd-123456789abc',gateway_name:'approved-gateway',onprem:'10.20.0.0/16',cloud:'10.100.0.0/16',vendor,port},'aws_dx_private_virtual_interface']),
  ...['us-east-1','us-gov-west-1'].flatMap(location=>['DRILL','RECOVERY'].map(mode=>{const partition=location.startsWith('us-gov-')?'aws-us-gov':'aws';return ['aws-elastic-disaster-recovery','aws_service_drs_recovery',{name:'recovery',mode,source:'arn:'+partition+':drs:'+location+':123456789012:source-server/s-0123456789abcdef0',snapshot:'pit-0123456789abcdef0',template:'lt-0123456789abcdef0',subnet,staging:secondSubnet,groups:group,staging_groups:'sg-0123456789abcdef1',kms:'arn:'+partition+':kms:'+location+':123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc'},'terraform_data',undefined,location];})),
  ...['ra3.xlplus','ra3.4xlarge','ra3.16xlarge'].map(node=>['amazon-redshift','aws_service_redshift_provisioned',{name:'warehouse',subnets:[subnet,secondSubnet],clients:[group],kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc',secret_kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abd',log_kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abe',node},'aws_redshift_cluster']),
  ...['SSE-SQS','KMS'].flatMap(encryption=>[false,true].map(fifo=>['amazon-eventbridge-pipes','aws_service_pipes_sqs_lambda',{name:'application',source:'arn:aws:sqs:us-east-1:123456789012:source'+(fifo?'.fifo':''),dlq:'arn:aws:sqs:us-east-1:123456789012:failed'+(fifo?'.fifo':''),target:'arn:aws:lambda:us-east-1:123456789012:function:ApprovedBatch:3',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc',encryption,...(encryption==='KMS'?{queue_key:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abd'}:{})},'aws_pipes_pipe'])),
  ...['RATE','DAILY','WEEKLY','MONTHLY','ONCE'].map(mode=>['amazon-eventbridge-scheduler','aws_service_scheduler_lambda',{name:'nightly',target:'arn:aws:lambda:us-east-1:123456789012:function:ApprovedJob:3',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc',mode,...(mode==='ONCE'?{timestamp:'2027-01-01T03:00:00'}:{})},'aws_scheduler_schedule']),
  ...['valkey7','valkey8','redis7'].map(profile=>['amazon-elasticache','aws_service_elasticache_sharded',{name:'application-shards',account:'123456789012',subnets:[subnet,secondSubnet],clients:[group],parameter_group:'approved-cluster-params',group:'application-group',user:'application-user',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc',profile},'aws_elasticache_replication_group']),
  ...['valkey8','valkey7','redis7'].map(profile=>['amazon-elasticache','aws_service_elasticache_serverless',{name:'application-cache',account:'123456789012',subnets:[subnet,secondSubnet],clients:[group],group:'application-group',user:'application-user',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc',profile,...(profile==='valkey7'?{prescale:true}:{})},'aws_elasticache_serverless_cache']),
  ['amazon-kinesis-video-streams','aws_service_webrtc_storage',{name:'retained-peers',account:'123456789012',channel:'arn:aws:kinesisvideo:us-east-1:123456789012:channel/approved-peer/1234567890123',stream:'arn:aws:kinesisvideo:us-east-1:123456789012:stream/approved-video/1234567890123',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc',master:role('PeerMaster'),viewer:role('PeerViewer'),approved:true},'aws_iam_role_policy'],
  ['amazon-kinesis-video-streams','aws_service_webrtc_signaling',{name:'approved-peers',account:'123456789012',stack_role:role('SignalingStack'),master:role('PeerMaster'),viewer:role('PeerViewer'),approved:true},'aws_cloudformation_stack'],
  ...['LIVE','ARCHIVE'].map(consumer_mode=>['amazon-kinesis-video-streams','aws_service_kinesis_video',{name:'approved-video',account:'123456789012',device:'camera-lab',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc',producer:role('VideoProducer'),consumer:role('VideoConsumer'),approved:true,consumer_mode,retention:consumer_mode==='LIVE'?0:24},'aws_kinesis_video_stream']),
  ['amazon-ivs-chat','aws_service_ivs_chat',{name:'moderated-chat',account:'123456789012',reviewer:'arn:aws:lambda:us-east-1:123456789012:function:ReviewChat:7',logging:'arn:aws:ivschat:us-east-1:123456789012:logging-configuration/AbCdEf123456',log_group:'/approved/chat',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc',approved:true},'aws_ivschat_room'],
  ['amazon-interactive-video-service','aws_service_ivs_channel',{name:'recorded-video',account:'123456789012',playback_key:'arn:aws:ivs:us-east-1:123456789012:playback-key/AbCdEf123456',distribution:true,recording:'EXISTING',recording_arn:'arn:aws:ivs:us-east-1:123456789012:recording-configuration/AbCdEf123456',recording_bucket:'approved-recordings',recording_approved:true},'aws_ivs_channel'],
  ...['BASIC','STANDARD'].map(type=>['amazon-interactive-video-service','aws_service_ivs_channel',{name:'approved-video',account:'123456789012',type,latency:type==='BASIC'?'NORMAL':'LOW',playback_key:'arn:aws:ivs:us-east-1:123456789012:playback-key/AbCdEf123456',distribution:true},'aws_ivs_channel']),
  ...['SSH','RDP'].map(protocol=>['aws-ec2-instance-connect','aws_service_instance_connect',{name:'admin-access',account:'123456789012',subnet,target_group:group,destination:'10.20.30.40',role:role('Admin'),protocol},'aws_ec2_instance_connect_endpoint']),
  ...['READ','WRITE'].map(access=>['amazon-elastic-kubernetes-service','aws_service_eks_pod_identity_s3',{name:'application',cluster:'arn:aws:eks:us-east-1:123456789012:cluster/private-cluster',nodegroup:'application',agent_version:'v1.3.0-eksbuild.1',namespace:'application',service_account:'application',bucket:'application-data',vpce:'vpce-0123456789abcdef0',image:'123456789012.dkr.ecr.us-east-1.amazonaws.com/probes/pod-identity@sha256:'+'a'.repeat(64),access,...(access==='WRITE'?{kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc'}:{})},'aws_eks_pod_identity_association']),
  ...['IMAGE','ARCHIVE'].map(artifact=>['amazon-sagemaker-ai','aws_service_sagemaker_endpoint',{name:'model-serving',image:'123456789012.dkr.ecr.us-east-1.amazonaws.com/inference/model@sha256:'+'a'.repeat(64),kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc',subnets:[subnet,secondSubnet],clients:[group],role:role('ModelApplication'),artifact,...(artifact==='ARCHIVE'?{bucket:'approved-models',key:'releases/v1/model.tar.gz',version:'approved-version',etag:'a'.repeat(32),endpoint:'FIPS',count:2}: {})},'aws_sagemaker_endpoint',...(artifact==='IMAGE'?['amazon-sagemaker-runtime']:[])]),
  ['amazon-sagemaker','aws_service_sagemaker_endpoint',{name:'historical-model',image:'123456789012.dkr.ecr.us-east-1.amazonaws.com/inference/model@sha256:'+'a'.repeat(64),kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc',subnets:[subnet,secondSubnet],clients:[group],role:role('ModelApplication')},'aws_sagemaker_endpoint'],
  ...['aws_service_mgn_pilot','aws_service_mgn_cutover'].flatMap(id=>['AUTO','STANDARD'].map(endpoint=>['aws-application-migration-service',id,{name:'pilot',source:'arn:aws:mgn:us-east-1:123456789012:source-server/s-0123456789abcdef0',template:'lt-0123456789abcdef0',subnet,staging:secondSubnet,groups:group,staging_groups:'sg-0123456789abcdef1',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc',endpoint},'terraform_data'])),
  ['aws-transform-mgn','aws_service_mgn_cutover',{name:'production',source:'arn:aws:mgn:us-east-1:123456789012:source-server/s-0123456789abcdef0',template:'lt-0123456789abcdef0',subnet,staging:secondSubnet,groups:group,staging_groups:'sg-0123456789abcdef1',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc'},'terraform_data'],
  ...['OWNER_DACL','OWNER_DACL_SACL'].map(security=>['aws-datasync','aws_service_datasync_smb_fsx_windows',{name:'windows-migration',agent:'arn:aws:datasync:us-east-1:123456789012:agent/agent-0123456789abcdef0',server:'files.example.com',path:'/Finance$/Reports',user:'SourceReader',domain:'EXAMPLE',ntlm_allowed:true,filesystem:'fs-0123456789abcdef0',group,target_user:'FsxMigration',target_domain:security==='OWNER_DACL'?'EXAMPLE':'OTHER',relationship:security==='OWNER_DACL'?'SAME':'TRUSTED',security,...(security==='OWNER_DACL_SACL'?{overwrite:'ALWAYS'}:{})},'aws_datasync_location_fsx_windows_file_system']),
  ...['EXAMPLE', ''].map(domain => ['aws-datasync', 'aws_service_datasync_smb_s3', { name:'windows-files', agent:'arn:aws:datasync:us-east-1:123456789012:agent/agent-0123456789abcdef0', server:'files.example.com', path:'/Finance$/Reports', user:'MigrationReader', domain, ntlm_allowed:true, bucket:'application-landing', role:role('DataSyncS3'), ...(domain ? {} : { overwrite:'ALWAYS', bandwidth:12.5 }) }, 'aws_datasync_location_smb']),
  ['amazon-elastic-file-system', 'aws_service_efs', { name:'migration-files', subnets:[subnet, secondSubnet], groups:[group], throughput:'elastic', accesspoint:'PRESERVE' }, 'aws_efs_access_point'],
  ['amazon-elastic-file-system', 'aws_service_efs', { name:'application-files', subnets:[subnet, secondSubnet], groups:[group], throughput:'provisioned', mibps:128, accesspoint:'ENFORCE', ap_path:'/applications/payments', ap_uid:2000, ap_gid:3000, ap_permissions:'0700' }, 'aws_efs_access_point'],
  ...['NEVER', 'ALWAYS'].map(overwrite => ['aws-datasync', 'aws_service_datasync_nfs_efs', { name:'application-efs-transfer', agent:'arn:aws:datasync:us-east-1:123456789012:agent/agent-0123456789abcdef0', server:'nfs.example.com', path:'/exports/application', filesystem:'fs-0123456789abcdef0', accesspoint:'fsap-0123456789abcdef0', mount:'fsmt-0123456789abcdef0', subnet, group, role:role('DataSyncEfs'), overwrite, ...(overwrite === 'ALWAYS' ? { version:'NFS3', bandwidth:12.5, logging:'TRANSFER' } : {}) }, 'aws_datasync_location_efs']),
  ...['900', '3600'].map(duration => ['iam-roles-anywhere', 'aws_service_rolesanywhere', { name: 'artifact-reader', ca: 'arn:aws:acm-pca:us-east-1:123456789012:certificate-authority/12345678-abcd-4bcd-8bcd-123456789abc', subject: 'artifact-workload', issuer: 'Workload Issuing CA', bucket: 'application-artifacts', duration, ...(duration === '3600' ? { kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc' } : {}) }, 'aws_rolesanywhere_profile']),
  ...['Linux', 'Windows'].map(os => ['taxonomy:systemsmanagersessionmanager', 'aws_service_ssm_session', { name: 'project-session-' + os.toLowerCase(), os, nodes: ['i-0123456789abcdef0', 'mi-0123456789abcdef1'], operator: role('SessionOperator'), node_roles: [role('ManagedNodes'), role('HybridNodes')], session_kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc', log_kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abd' }, 'aws_ssm_document']),
  ...['WINDOWS', 'AMAZON_LINUX_2', 'AMAZON_LINUX_2023', 'REDHAT_ENTERPRISE_LINUX'].map(os => [os === 'AMAZON_LINUX_2' ? 'amazon-simple-systems-manager-ssm' : 'aws-systems-manager', 'aws_service_ssm_patching', { name: 'application-patching', os, group: 'application-pilot', role: role('PatchWindow'), kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc', ...(os === 'WINDOWS' ? { operation: 'Install', reboot: 'RebootIfNeeded' } : {}), ...(os === 'REDHAT_ENTERPRISE_LINUX' ? { enabled: 'YES', timezone: 'Europe/London', concurrency: 2 } : {}) }, 'aws_ssm_patch_baseline']),
  ...['NEW', 'EXISTING'].map(create => ['amazon-keyspaces-for-apache-cassandra', 'aws_service_keyspaces', { name: 'application_records', keyspace: 'application', create, role: role('CassandraApplication'), kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc', ...(create === 'EXISTING' ? { capacity: 'PROVISIONED', reads: 50, writes: 25, access: 'WRITE', ttl: 3600, timestamps: 'YES', columns: [['tenant', 'text', 'PARTITION', ''], ['region', 'text', 'PARTITION', ''], ['record_id', 'uuid', 'CLUSTERING', 'DESC'], ['summary', 'text', 'STATIC', ''], ['payload', 'text', 'REGULAR', '']] } : {}) }, 'aws_keyspaces_table']),
  ...['NEW', 'EXISTING'].map(host => ['aws-database-migration-service', 'aws_service_dms_postgres', { name: 'application-cdc-' + host.toLowerCase(), mode: 'full-load-and-cdc', host, ...(host === 'NEW' ? { version: '3.5.4', subnets: [subnet, secondSubnet], groups: [group] } : { existing: 'approved-migration-host' }), secret_role: role('DmsSecrets'), source_secret: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:source-migration-abcdef', source_database: 'application', source_certificate: 'arn:aws:dms:us-east-1:123456789012:cert:ABCDEFGHIJKLMNOPQRSTUVWXYZ', target_secret: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:target-migration-abcdef', target_database: 'application', target_certificate: 'arn:aws:dms:us-east-1:123456789012:cert:ABCDEFGHIJKLMNOPQRSTUVWXYZ', tables: [['public', 'customer_records'], ['public', 'order_items']] }, 'aws_dms_replication_task']),
  ...['READ', 'WRITE'].map(access => ['aws-transfer-family', 'aws_service_transfer_efs', { name: 'application-efs-sftp-' + access.toLowerCase(), access, subnets: [subnet, secondSubnet], clients: [group], filesystem: 'fs-0123456789abcdef0', role: role('TransferEfs'), logging_role: role('TransferLogs'), users: 'alice | 1001 | 1001 | ' + publicTestKey('rsa') + '\nalice | 1001 | 1001 | ' + publicTestKey('nistp256') + '\nbob | 1002 | 1002 | ' + publicTestKey('rsa'), ...(access === 'WRITE' ? { policy: 'TransferSecurityPolicy-FIPS-2025-03' } : {}) }, 'aws_transfer_server']),
  ['aws-transfer-family', 'aws_service_transfer_sftp', { name: 'application-sftp-rotation', subnets: [subnet, secondSubnet], groups: [group], bucket: 'application-files', role: role('TransferAccess'), users: [['alice', publicTestKey()], ['bob', publicTestKey()]], additional_keys: 'alice | laptop | ' + publicTestKey('rsa') + '\nalice | recovery | ' + publicTestKey('nistp256') + '\nbob | laptop | ' + publicTestKey('rsa') }, 'aws_transfer_ssh_key'],
  ...['3.9.x', '3.9.x.kraft', '4.2.x.kraft'].map(version => ['amazon-managed-streaming-for-apache-kafka', 'aws_service_msk_provisioned', { name: 'application-standard-kafka', role: role('KafkaApplication'), version, subnets: version === '3.9.x' ? [subnet, secondSubnet] : [subnet, secondSubnet, 'subnet-0123456789abcdef2'], clients: [group], topics: 'orders,events', groups: 'application-workers', kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc', log_kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abd', ...(version === '4.2.x.kraft' ? { per_az: 2, size: 'kafka.m7g.large', access: 'WRITE', create_topics: 'YES' } : {}) }, 'aws_msk_cluster']),
  ...['CRAWL_EVERYTHING', 'CRAWL_NEW_FOLDERS_ONLY'].map(recrawl => ['aws-glue', 'aws_service_glue_crawler', { name: 'application-crawler', database: 'application', role: role('GlueExecution'), bucket: 'application-source', recrawl, ...(recrawl === 'CRAWL_NEW_FOLDERS_ONLY' ? { sample: 25, kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc' } : {}) }, 'aws_glue_crawler']),
  ['amazon-cognito', 'aws_service_cognito_m2m', { name: 'application-machine', domain: 'application-machine-123456789012', scopes: 'read,write' }, 'aws_cognito_resource_server'],
  ...['HA', 'EFS', 'EBS'].map(layout => ['amazon-mq', 'aws_service_mq_activemq', { name: 'application-activemq-' + layout.toLowerCase(), version: '5.18', mode: layout === 'HA' ? 'ACTIVE_STANDBY_MULTI_AZ' : 'SINGLE_INSTANCE', subnets: layout === 'HA' ? [subnet, secondSubnet] : [subnet], ...(layout === 'HA' ? {} : { storage: layout }), clients: [group], admins: ['sg-0123456789abcdef1'], protocols: layout === 'HA' ? ['OpenWire TLS (61617)', 'STOMP TLS (61614)'] : ['AMQP TLS (5671)'], ...(layout === 'HA' ? { access: 'READWRITE', topics: 'events', kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc' } : {}) }, 'aws_mq_broker']),
  ...['valkey-read', 'valkey-write', 'redis-7.0', 'redis-7.1'].map(mode => ['amazon-memorydb', 'aws_service_memorydb', { name: 'application-memorydb-' + mode.replaceAll('.', '-'), engine: mode.startsWith('redis') ? 'redis' : 'valkey', ...(mode.startsWith('redis') ? { redis_version: mode.slice(6) } : {}), role: role('MemoryApplication'), clients: [group], subnets: mode === 'valkey-write' ? [subnet, secondSubnet, 'subnet-0123456789abcdef2'] : [subnet, secondSubnet], ...(mode === 'valkey-write' ? { access: 'READWRITE', replicas: '2', shards: 2, kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc' } : {}) }, 'aws_memorydb_cluster']),
  ...['SINGLE_AZ_1', 'MULTI_AZ_1', 'SINGLE_AZ_2', 'MULTI_AZ_2'].map(deployment => ['amazon-fsx', 'aws_service_fsx_ontap', { name: 'application-ontap-' + deployment.toLowerCase().replaceAll('_', '-'), deployment, subnets: deployment.startsWith('MULTI') ? [subnet, secondSubnet] : [subnet], clients: [group], admins: ['sg-0123456789abcdef1'], client_cidrs: '10.20.0.0/24,10.30.0.0/24', ...(deployment.startsWith('MULTI') ? { routes: 'rtb-0123456789abcdef0' } : {}), ...(deployment === 'MULTI_AZ_2' ? { kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc' } : {}) }, 'aws_fsx_ontap_file_system']),
  ...['NO', 'YES'].map(privateNetwork => [privateNetwork === 'YES' ? 'amazon-managed-service-for-apache-flink' : 'taxonomy:kinesisdataanalytics', 'aws_service_flink', { name: 'application-flink-' + privateNetwork.toLowerCase(), private: privateNetwork, role: role('FlinkExecution'), bucket: 'application-artifacts', key: 'flink/application.jar', object_version: 'approved-version-123', ...(privateNetwork === 'YES' ? { subnets: [subnet, secondSubnet], groups: [group], properties: '{"environment":"pilot"}', kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc' } : {}) }, 'aws_kinesisanalyticsv2_application']),
  ['amazon-neptune', 'aws_service_neptune', { name: 'runtime-graph-setup', reader: role('GraphReader'), subnets: [subnet, secondSubnet], clients: [group] }, 'aws_neptune_cluster', 'amazon-neptunedata'],
  ['amazon-bedrock', 'aws_service_bedrock_inference', { name: 'runtime-model-setup', role: role('Application'), model: 'amazon.nova-micro-v1:0' }, 'aws_iam_role_policy', 'amazon-bedrock-runtime'],
  ['amazon-dynamodb', 'aws_service_dynamodb', { table_name: 'runtime-stream-table', partition_key: 'pk', stream: 'NEW_AND_OLD_IMAGES' }, 'aws_dynamodb_table', 'amazon-dynamodb-streams'],
  ...['X86_64', 'ARM64'].map(architecture => ['amazon-emr', 'aws_service_emr_serverless', { name: 'application-spark-' + architecture.toLowerCase(), architecture, role: role('EmrExecution'), script: 's3://application-artifacts/scripts/example.py', ...(architecture === 'ARM64' ? { private: 'YES', subnets: [subnet, secondSubnet], groups: [group], script_kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc' } : {}) }, 'aws_emrserverless_application']),
  ...['csv', 'json', 'parquet'].map(source_format => ['aws-glue', 'aws_service_glue_s3_etl', { name: 'application-convert-' + source_format, role: role('GlueExecution'), source_bucket: 'application-source', target_bucket: 'application-destination', artifact_bucket: 'application-artifacts', source_format, target_format: source_format === 'parquet' ? 'json' : 'parquet', kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc', ...(source_format === 'json' ? { source_kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abd' } : {}) }, 'aws_glue_job']),
  ...['1', '3', 'SERVERLESS'].map(layout => ['amazon-neptune', 'aws_service_neptune', { name: 'application-graph-' + layout.toLowerCase(), mode: layout === 'SERVERLESS' ? 'SERVERLESS' : 'PROVISIONED', nodes: layout === 'SERVERLESS' ? '2' : layout, subnets: layout === '3' ? [subnet, secondSubnet, 'subnet-0123456789abcdef2'] : [subnet, secondSubnet], clients: [group], reader: role('GraphReader'), ...(layout !== '1' ? { writer: role('GraphWriter'), kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc' } : {}) }, 'aws_neptune_cluster']),
  ...['ENDPOINT', 'PREFIX', 'VPC'].map(mode => ['amazon-managed-grafana', 'aws_service_grafana', { name: 'application-metrics-' + mode.toLowerCase(), identity_region: 'us-east-1', store: 'd-0123456789', admins: '12345678-abcd-4bcd-8bcd-123456789abc', role: role('GrafanaQuery'), ...(mode === 'PREFIX' ? { prefixes: 'pl-0123456789abcdef0' } : { endpoints: 'vpce-0123456789abcdef0' }), ...(mode === 'VPC' ? { outbound: 'YES', subnets: [subnet, secondSubnet], groups: [group], cloudwatch: 'NO', prometheus: 'arn:aws:aps:us-east-1:123456789012:workspace/ws-12345678-abcd-4bcd-8bcd-123456789abc', editors: '12345678-abcd-4bcd-8bcd-123456789abd', viewers: '12345678-abcd-4bcd-8bcd-123456789abe' } : {}) }, 'aws_grafana_workspace']),
  ...['READ', 'WRITE', 'BOTH'].map(access => ['amazon-managed-streaming-for-apache-kafka', 'aws_service_msk_serverless', { name: 'application-kafka-' + access.toLowerCase(), access, role: role('KafkaApplication'), subnets: [subnet, secondSubnet], clients: [group], topics: 'orders,events', ...(access !== 'WRITE' ? { groups: 'application-workers' } : {}), ...(access === 'BOTH' ? { create_topics: 'YES' } : {}) }, 'aws_msk_serverless_cluster']),
  ['amazon-kinesis-firehose', 'aws_service_firehose_s3', { name: 'application-legacy-delivery', source: 'DIRECT', role: role('FirehoseDelivery'), bucket: 'application-delivery', prefix: 'events/' }, 'aws_kinesis_firehose_delivery_stream'],
  ...['1', '2', '3'].map(topology => ['amazon-opensearch-service', 'aws_service_opensearch_domain', { name: 'application-search-' + topology, topology, nodes: Number(topology), subnets: [subnet, secondSubnet, 'subnet-0123456789abcdef2'].slice(0, Number(topology)), clients: [group], admin: role('SearchMaster'), applications: role('SearchApplication'), ...(topology === '3' ? { kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc' } : {}) }, 'aws_opensearch_domain']),
  ...['DIRECT', 'KINESIS'].map(source => ['amazon-data-firehose', 'aws_service_firehose_s3', { name: 'application-delivery-' + source.toLowerCase(), source, role: role('FirehoseDelivery'), bucket: 'application-delivery', prefix: 'events/', ...(source === 'KINESIS' ? { stream: 'arn:aws:kinesis:us-east-1:123456789012:stream/application-events', compression: 'Snappy' } : { buffer_kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc', destination_kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc' }) }, 'aws_kinesis_firehose_delivery_stream']),
  ...['NEW', 'EXISTING'].map(host => ['aws-database-migration-service', 'aws_service_dms_postgres', { name: 'application-migration-' + host.toLowerCase(), host, ...(host === 'NEW' ? { version: '3.5.4', subnets: [subnet, secondSubnet], groups: [group] } : { existing: 'approved-migration-host' }), secret_role: role('DmsSecrets'), source_secret: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:source-migration-abcdef', source_database: 'application', source_certificate: 'arn:aws:dms:us-east-1:123456789012:cert:ABCDEFGHIJKLMNOPQRSTUVWXYZ', target_secret: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:target-migration-abcdef', target_database: 'application', target_certificate: 'arn:aws:dms:us-east-1:123456789012:cert:ABCDEFGHIJKLMNOPQRSTUVWXYZ', tables: [['public', 'customer_records'], ['public', 'order_items']] }, 'aws_dms_replication_task']),
  ['aws-transfer-family', 'aws_service_transfer_sftp', { name: 'application-sftp-read', subnets: [subnet, secondSubnet], groups: [group], bucket: 'application-files', role: role('TransferAccess'), users: [['alice', publicTestKey()], ['bob', publicTestKey()]] }, 'aws_transfer_server'],
  ...['WRITE', 'DELETE'].map(access => ['aws-transfer-family', 'aws_service_transfer_sftp', { name: 'application-sftp-' + access.toLowerCase(), subnets: [subnet, secondSubnet], groups: [group], bucket: 'application-files', role: role('TransferAccess'), access, policy: 'TransferSecurityPolicy-FIPS-2025-03', users: [['alice', publicTestKey('rsa')]], logging_role: role('TransferLogging'), kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc' }, 'aws_transfer_server']),
  ...['EXISTING', 'NEW'].flatMap(registration => ['AUTO_STOP', 'ALWAYS_ON'].map(running => ['amazon-workspaces', 'aws_service_workspaces', { name: 'application-desktops-' + registration.toLowerCase() + '-' + running.toLowerCase(), registration, running, directory: 'd-0123456789', bundle: 'wsb-123456789', users: 'alice,bob', ...(registration === 'NEW' ? { subnets: [subnet, secondSubnet], group } : {}), ...(running === 'ALWAYS_ON' ? { kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc' } : {}) }, 'aws_workspaces_workspace'])),
  ['amazon-bedrock', 'aws_service_bedrock_inference', { name: 'application-inference', role: role('Application'), model: 'amazon.nova-micro-v1:0' }, 'aws_iam_role_policy'],
  ['amazon-bedrock', 'aws_service_bedrock_inference', { name: 'application-inference-stream', role: role('Application'), model: 'amazon.nova-micro-v1:0', mode: 'STREAM', guardrail: 'arn:aws:bedrock:us-east-1:123456789012:guardrail/abc123', guardrail_version: '2' }, 'aws_iam_role_policy'],
  ['amazon-macie-2', 'aws_service_macie_job', { name: 'application-alias-data-review', account: '123456789012', buckets: ['application-records'] }, 'aws_macie2_classification_job'],
  ['amazon-api-gateway', 'aws_service_private_api', { name: 'application-private-api', function: 'arn:aws:lambda:us-east-1:123456789012:function:application', endpoints: 'vpce-0123456789abcdef0', roles: role('Application') }, 'aws_api_gateway_rest_api'],
  ['amazon-api-gateway', 'aws_service_private_api', { name: 'application-private-orders', function: 'arn:aws:lambda:us-east-1:123456789012:function:application', alias: 'release', method: 'POST', path: 'orders', endpoints: 'vpce-0123456789abcdef0,vpce-0123456789abcdef1', roles: role('Application') + ',' + role('Reviewer'), access_log: 'arn:aws:logs:us-east-1:123456789012:log-group:/application/api-access' }, 'aws_api_gateway_rest_api'],
  ...['Standard', 'Enterprise'].flatMap(edition => ['YES', 'NO'].map(logging => ['aws-directory-service', 'aws_service_directory', { name: 'application-directory-' + edition.toLowerCase() + '-' + logging.toLowerCase(), domain: 'ad.example.org', short_name: 'CORP', edition, logging, subnets: [subnet, secondSubnet] }, 'aws_directory_service_directory'])),
  ...['MANAGED', 'SELF'].flatMap(ad => ['SINGLE_AZ_2', 'MULTI_AZ_1'].map(deployment => ['taxonomy:fsxforwindowsfileserver', 'aws_service_fsx_windows', { name: 'application-shares-' + ad.toLowerCase() + '-' + deployment.toLowerCase(), ad, deployment, subnet, ...(deployment === 'MULTI_AZ_1' ? { standby: secondSubnet } : {}), groups: [group], ...(ad === 'MANAGED' ? { directory: 'd-0123456789' } : { domain: 'corp.example.org', dns: '10.100.0.10,10.100.0.11', username: 'fsxjoin', ou: 'OU=FSx,DC=corp,DC=example,DC=org', admin_group: 'FSxAdmins', storage: 'HDD', capacity: 2000 }), ...(ad === 'SELF' && deployment === 'MULTI_AZ_1' ? { audit: 'LOGS', audit_arn: 'arn:aws:logs:us-east-1:123456789012:log-group:/aws/fsx/file-access' } : {}) }, 'aws_fsx_windows_file_system'])),
  ...['1', '2', '3'].map(nodes => ['amazon-documentdb-with-mongodb-compatibility', 'aws_service_docdb', { name: 'application-documents-' + nodes, nodes, subnets: [subnet, secondSubnet, ...(nodes === '3' ? ['subnet-0123456789abcdef2'] : [])], clients: group, ...(nodes === '2' ? { storage: 'iopt1', audit: 'ddl,dml_write', kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-abcd-abcd-123456789abc' } : {}), ...(nodes === '3' ? { audit: 'all' } : {}) }, 'aws_docdb_cluster']),
  ['amazon-mq', 'aws_service_mq_rabbitmq', { name: 'application-broker-single', version: '3.13', mode: 'SINGLE_INSTANCE', subnets: [subnet], clients: group, admins: 'sg-0123456789abcdef1' }, 'aws_mq_broker'],
  ['amazon-mq', 'aws_service_mq_rabbitmq', { name: 'application-broker-cluster', version: '3.13', subnets: [subnet, secondSubnet, 'subnet-0123456789abcdef2'], clients: group, admins: 'sg-0123456789abcdef1', kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-abcd-abcd-123456789abc' }, 'aws_mq_broker'],
  ['amazon-route-53-resolver', 'aws_service_resolver', { name: 'application-inbound-dns', subnets: [subnet, secondSubnet], clients: '10.100.0.0/24,10.101.0.0/24' }, 'aws_route53_resolver_endpoint'],
  ['amazon-route-53-resolver', 'aws_service_resolver', { name: 'application-outbound-dns', direction: 'OUTBOUND', subnets: [subnet, secondSubnet], domains: 'corp.example.org,services.internal', targets: '10.100.0.10,10.100.0.11' }, 'aws_route53_resolver_endpoint'],
  ['amazon-virtual-private-cloud', 'aws_service_nat', { name: 'application-egress', subnet }, 'aws_nat_gateway'],
  ['amazon-virtual-private-cloud', 'aws_service_nat', { name: 'application-egress-existing', subnet, eip_mode: 'EXISTING', allocation: 'eipalloc-0123456789abcdef0', routes: 'CREATE', route_tables: 'rtb-0123456789abcdef0' }, 'aws_nat_gateway'],
  ['amazon-virtual-private-cloud', 'aws_service_nat', { name: 'application-private-nat', subnet, connectivity: 'private', private_ip: '10.0.1.20', routes: 'CREATE', route_tables: 'rtb-0123456789abcdef0', destination: '10.100.0.0/16' }, 'aws_nat_gateway'],
  ...['NONE', 'MANUAL'].map(approval => ['aws-codepipeline', 'aws_service_codepipeline', { name: 'application-release-' + approval.toLowerCase(), pipeline_role: role('Pipeline'), role: role('Build'), source_bucket: 'application-source', source_key: 'source.zip', artifact_bucket: 'application-artifacts', commands: 'mkdir -p dist\nprintf artifact > dist/result.txt', artifact_files: 'dist/**/*', release: 'S3_ZIP', release_bucket: 'application-releases', release_key: 'approved/application.zip', approval, ...(approval === 'MANUAL' ? { review_url: 'https://changes.example.org/123', review_note: 'Review build and test evidence.', release_kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-abcd-abcd-123456789abc' } : {}) }, 'aws_codepipeline']),
  ['aws-codepipeline', 'aws_service_codepipeline', { name: 'application-review', pipeline_role: role('Pipeline'), role: role('Build'), source_bucket: 'application-source', source_key: 'source.zip', artifact_bucket: 'application-artifacts', commands: 'echo review', artifact_files: '**/*', approval: 'MANUAL' }, 'aws_codepipeline'],
  ...['se2-li', 'se2-byol', 'ee-byol'].map(edition => ['amazon-relational-database-service', 'aws_service_rds_oracle', { name: 'application-oracle-' + edition, edition, version: '19.0.0.0.ru-2026-01.rur-2026-01.r1', subnets: [subnet, secondSubnet], clients: group, availability: edition === 'se2-li' ? 'false' : 'true', ...(edition === 'ee-byol' ? { instance: 'db.r6i.2xlarge', kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-abcd-abcd-123456789abc' } : {}) }, 'aws_db_instance']),
  ['amazon-relational-database-service', 'aws_service_rds_sqlserver', { name: 'application-sql-explicit', instance: 'db.m6i.large', subnets: [subnet, secondSubnet], groups: [group], kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-abcd-abcd-123456789abc', secret_kms: 'arn:aws:kms:us-east-1:123456789012:key/22345678-abcd-abcd-abcd-123456789abc' }, 'aws_db_instance'],
  ...['sqlserver-ex', 'sqlserver-web', 'sqlserver-se', 'sqlserver-ee'].map(engine => ['amazon-relational-database-service', 'aws_service_rds_sqlserver', { name: 'application-' + engine, engine, subnets: [subnet, secondSubnet], groups: [group], ...(engine === 'sqlserver-ex' ? {} : { availability: 'true' }) }, 'aws_db_instance']),
  ['amazon-macie', 'aws_service_macie_job', { name: 'application-data-review', account: '123456789012', buckets: ['application-records'] }, 'aws_macie2_classification_job'],
  ['amazon-macie', 'aws_service_macie_job', { name: 'application-data-daily', account: '123456789012', buckets: ['application-records'], prefixes: ['exports/', 'reports/'], sample: 10, frequency: 'DAILY', identifiers: ['12345678-abcd-abcd-abcd-123456789abc'] }, 'aws_macie2_classification_job'],
  ['amazon-macie', 'aws_service_macie_job', { name: 'application-data-weekly', account: '123456789012', buckets: ['application-records'], frequency: 'WEEKLY', weekday: 'FRI', initial: 'yes' }, 'aws_macie2_classification_job'],
  ['amazon-macie', 'aws_service_macie_job', { name: 'application-data-monthly', account: '123456789012', buckets: ['application-records'], frequency: 'MONTHLY', month_day: 15 }, 'aws_macie2_classification_job'],
  ['taxonomy:fsxforlustre', 'aws_service_fsx_lustre', { name: 'application-parallel', subnet, groups: [group] }, 'aws_fsx_lustre_file_system'],
  ['taxonomy:fsxforlustre', 'aws_service_fsx_lustre', { name: 'application-scratch', deployment: 'SCRATCH_2', storage: 2400, subnet, groups: [group], compression: 'NONE' }, 'aws_fsx_lustre_file_system'],
  ['taxonomy:fsxforopenzfs', 'aws_service_fsx_openzfs', { name: 'application-files-ha', deployment: 'MULTI_AZ_1', subnet, standby: secondSubnet, routes: ['rtb-0123456789abcdef0'], endpoint_range: '10.0.250.0/28', groups: [group], clients: ['10.0.0.0/16'] }, 'aws_fsx_openzfs_file_system'],
  ['taxonomy:fsxforopenzfs', 'aws_service_fsx_openzfs', { name: 'application-files', subnet, groups: [group], clients: ['10.0.0.0/16'] }, 'aws_fsx_openzfs_file_system'],
  ['taxonomy:fsxforopenzfs', 'aws_service_fsx_openzfs', { name: 'application-files-az1', deployment: 'SINGLE_AZ_1', throughput1: '128', subnet, groups: [group], clients: ['10.0.1.10/32'], access: 'ro', root: 'no_root_squash', compression: 'LZ4', kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-abcd-abcd-123456789abc' }, 'aws_fsx_openzfs_file_system'],
  ['amazon-simple-email-service', 'aws_service_ses_sending', { name: 'application-mail', sender: 'notifications@example.com', identity: 'example.com', role: role('ApplicationSender') }, 'aws_sesv2_configuration_set'],
  ['amazon-simple-email-service', 'aws_service_ses_sending', { name: 'application-mail-alerts', sender: 'notifications@example.com', role: role('ApplicationSender'), topic: 'arn:aws:sns:us-east-1:123456789012:MailAlerts', bounce: 10, complaint: 2 }, 'aws_cloudwatch_metric_alarm'],
  ['aws-datasync', 'aws_service_datasync_nfs_s3', { name: 'application-files', agent: 'arn:aws:datasync:us-east-1:123456789012:agent/agent-0123456789abcdef0', server: 'nfs.example.com', path: '/exports/application', bucket: 'application-landing', role: role('DataSyncDestination') }, 'aws_datasync_location_nfs'],
  ['aws-datasync', 'aws_service_datasync_nfs_s3', { name: 'application-files-nfs3', agent: 'arn:aws:datasync:us-east-1:123456789012:agent/agent-0123456789abcdef0', server: '10.0.1.10', path: '/exports/application', bucket: 'application-landing', role: role('DataSyncDestination'), version: 'NFS3', overwrite: 'ALWAYS', bandwidth: 12.5, logging: 'TRANSFER' }, 'aws_datasync_task'],
  ['redshift-serverless', 'aws_service_redshift_serverless', { name: 'application-warehouse', subnets: [subnet, secondSubnet, 'subnet-0123456789abcdef2'], groups: [group] }, 'aws_redshiftserverless_namespace'],
  ['redshift-serverless', 'aws_service_redshift_serverless', { name: 'application-warehouse-pair', routing: 'off', subnets: [subnet, secondSubnet], groups: [group], base: '16', maximum: '128', data_role: role('WarehouseData'), kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-abcd-abcd-123456789abc', secret_kms: 'arn:aws:kms:us-east-1:123456789012:key/22345678-abcd-abcd-abcd-123456789abc' }, 'aws_redshiftserverless_workgroup'],
  ['taxonomy:opensearchserverless', 'aws_service_opensearch_serverless', { name: 'application-search', roles: [role('SearchClient')], endpoints: ['vpce-0123456789abcdef0'] }, 'aws_opensearchserverless_collection'],
  ['taxonomy:opensearchserverless', 'aws_service_opensearch_serverless', { name: 'application-vectors', roles: [role('SearchWriter'), role('SearchReader')], network: 'PUBLIC', type: 'VECTORSEARCH', dimensions: 768, access: 'INGEST', dashboards: 'yes', encryption: 'KMS', kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-abcd-abcd-123456789abc' }, 'aws_opensearchserverless_access_policy'],
  ...['codeconnections', 'codestar-connections'].map(service => ['aws-codepipeline', 'aws_service_codepipeline', { name: 'application-git-release', pipeline_role: role('Pipeline'), role: role('CodeBuild'), source: 'GIT', connection: 'arn:aws:' + service + ':us-east-1:123456789012:connection/12345678-abcd-abcd-abcd-123456789abc', repository: 'engineering/Payments', branch: 'release/current', artifact_bucket: 'application-artifacts', commands: 'mkdir -p dist\nprintf artifact > dist/result.txt', artifact_files: 'dist/**/*', trigger: 'POLL' }, 'aws_codepipeline']),
  ['aws-codepipeline', 'aws_service_codepipeline', { name: 'application-release', pipeline_role: role('Pipeline'), role: role('CodeBuild'), source_bucket: 'application-source', source_key: 'releases/source.zip', artifact_bucket: 'application-artifacts', commands: 'mkdir -p dist\nprintf artifact > dist/result.txt', artifact_files: 'dist/**/*' }, 'aws_codepipeline'],
  ['aws-codepipeline', 'aws_service_codepipeline', { name: 'application-polled-release', pipeline_role: role('Pipeline'), role: role('CodeBuild'), source_bucket: 'application-source', source_key: 'releases/source.zip', artifact_bucket: 'application-artifacts', commands: 'mkdir -p dist\nprintf artifact > dist/result.txt', artifact_files: 'dist/**/*', trigger: 'POLL', artifact_kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-abcd-abcd-123456789abc' }, 'aws_codepipeline'],
  ['aws-codebuild', 'aws_service_codebuild', { name: 'application-pipeline-build', role: role('CodeBuild'), source: 'CODEPIPELINE', artifact_bucket: 'application-artifacts', artifact_prefix: 'application-release/', artifact_files: 'dist/**/*', commands: 'mkdir -p dist\nprintf artifact > dist/result.txt' }, 'aws_codebuild_project'],
  ['aws-cloud-map', 'aws_service_cloudmap', { name: 'orders', namespace: 'internal.example.com', vpc: 'vpc-0123456789abcdef0', instances: [['orders-a', '10.0.1.10', ''], ['orders-b', '10.0.2.10', '']] }, 'aws_service_discovery_instance'],
  ['aws-cloud-map', 'aws_service_cloudmap', { name: '_orders._tcp', namespace: 'internal.example.com', vpc: 'vpc-0123456789abcdef0', record: 'SRV', routing: 'WEIGHTED', health: 'HEALTHY', instances: [['orders-a', '10.0.1.10', '8443']] }, 'aws_service_discovery_service'],
  ['aws-batch', 'aws_service_batch_fargate', { name: 'application-batch', image: '123456789012.dkr.ecr.us-east-1.amazonaws.com/application@sha256:' + 'a'.repeat(64), execution_role: role('EcsExecution'), subnets: [subnet], groups: [group], executable: '/app/run' }, 'aws_batch_job_definition'],
  ['aws-batch', 'aws_service_batch_fargate', { name: 'application-spot-batch', image: '123456789012.dkr.ecr.us-east-1.amazonaws.com/application@sha256:' + 'a'.repeat(64), execution_role: role('EcsExecution'), job_role: role('BatchApplication'), subnets: [subnet, secondSubnet], groups: [group], executable: '/app/run', arguments: '--message\nhello world', size: '256:512', capacity: 'FARGATE_SPOT', public_ip: 'ENABLED', attempts: 3 }, 'aws_batch_compute_environment'],
  ['aws-security-hub', 'aws_service_securityhub', { account: '123456789012' }, 'aws_securityhub_account'],
  ['aws-security-hub', 'aws_service_securityhub', { account: '123456789012', baseline: 'fsbp,cis,nist', controls: 'yes' }, 'aws_securityhub_standards_subscription'],
  ['amazon-inspector', 'aws_service_inspector', { account: '123456789012' }, 'aws_inspector2_enabler'],
  ['amazon-inspector', 'aws_service_inspector', { account: '123456789012', lambda_code: 'on', ec2: 'off' }, 'aws_inspector2_enabler'],
  ['amazon-cognito', 'aws_service_cognito', { name: 'application-auth', domain: 'application-signin-123456789012', callbacks: ['https://app.example.com/callback'] }, 'aws_cognito_user_pool'],
  ['amazon-cognito', 'aws_service_cognito', { name: 'application-dev-auth', domain: 'application-dev-signin-123456789012', callbacks: ['http://localhost:3000/callback'], logout: ['https://app.example.com/logout'], registration: 'self', mfa: 'OFF' }, 'aws_cognito_user_pool_client'],
  ['aws-datasync', 'aws_service_datasync_s3', { name: 'application-transfer', source_bucket: 'application-source', destination_bucket: 'application-destination', source_role: role('DataSyncSource'), destination_role: role('DataSyncDestination') }, 'aws_datasync_task'],
  ['aws-datasync', 'aws_service_datasync_s3', { name: 'application-scoped-transfer', source_bucket: 'application-source', destination_bucket: 'application-destination', source_role: role('DataSyncSource'), destination_role: role('DataSyncDestination'), source_prefix: '/exports/', destination_prefix: '/landing/', bandwidth: 12.5, overwrite: 'ALWAYS', tags: 'NONE', logging: 'TRANSFER' }, 'aws_datasync_task'],
  ['amazon-athena', 'aws_service_athena', { name: 'application-query', bucket: 'application-query-results', owner: '123456789012', limit: 0.02 }, 'aws_athena_workgroup'],
  ['amazon-athena', 'aws_service_athena', { name: 'application-query-kms', bucket: 'application-query-results', owner: '123456789012', encryption: 'SSE_KMS', kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-abcd-abcd-123456789abc', engine: 'AUTO' }, 'aws_athena_workgroup'],
  ['aws-codebuild', 'aws_service_codebuild', { name: 'application-build', role: role('CodeBuild'), commands: 'node --version\nprintf "build check"' }, 'aws_codebuild_project'],
  ['aws-codebuild', 'aws_service_codebuild', { name: 'application-source-build', role: role('CodeBuild'), source: 'S3', bucket: 'application-source', key: 'releases/source.zip', version: 'source-version', install: 'npm ci', commands: 'npm test' }, 'aws_codebuild_project'],
  ['amazon-guardduty', 'aws_service_guardduty', { s3: 'ENABLED', malware: 'DISABLED' }, 'aws_guardduty_detector'],
  ['amazon-guardduty', 'aws_service_guardduty', { mode: 'existing', detector: 'a'.repeat(32), eks: 'ENABLED', rds: 'ENABLED', lambda: 'ENABLED' }, 'aws_guardduty_detector_feature'],
  ['aws-budgets', 'aws_service_budgets', { name: 'application-budget', emails: ['owner@example.com'] }, 'aws_budgets_budget'],
  ['aws-budgets', 'aws_service_budgets', { name: 'application-filtered-budget', emails: ['owner@example.com'], basis: 'amortized', credits: 'exclude', forecast: 'no', accounts: ['123456789012'], services: ['Amazon Elastic Compute Cloud - Compute'] }, 'aws_budgets_budget'],
  ['amazon-elastic-file-system', 'aws_service_efs', { name: 'application', subnets: [subnet, secondSubnet], groups: [group] }, 'aws_efs_mount_target'],
  ['amazon-elastic-block-store', 'aws_service_ebs', { name: 'application', subnet }, 'aws_ebs_volume'],
  ['elastic-load-balancing', 'aws_service_alb', { name: 'application', subnets: [subnet, secondSubnet], groups: [group], instances: ['i-0123456789abcdef0'], certificate: 'arn:aws:acm:us-east-1:123456789012:certificate/12345678-abcd-abcd-abcd-123456789abc' }, 'aws_lb_listener'],
  ['amazon-api-gateway', 'aws_service_http_api', { name: 'application', function_name: 'orders' }, 'aws_apigatewayv2_route'],
  ['amazon-elastic-kubernetes-service', 'aws_service_eks', { name: 'application', version: '1.34', subnets: [subnet, secondSubnet], cluster_role: role('Cluster'), node_role: role('Nodes'), admin: role('Admin') }, 'aws_eks_node_group'],
  ['amazon-eventbridge', 'aws_service_eventbridge', { name: 'application', function_name: 'orders' }, 'aws_cloudwatch_event_target'],
  ['aws-step-functions', 'aws_service_stepfunctions', { name: 'application', function_name: 'orders', role: role('Workflow') }, 'aws_sfn_state_machine'],
  ['aws-certificate-manager', 'aws_service_acm', { domain: '*.example.com', alternatives: ['example.com'], zone: 'Z123456789' }, 'aws_acm_certificate_validation'],
  ['aws-backup', 'aws_service_backup', { name: 'application', role: role('Backup'), resources: ['arn:aws:ec2:us-east-1:123456789012:instance/i-0123456789abcdef0'] }, 'aws_backup_selection'],
  ['amazon-elastic-container-service', 'aws_service_ecs_application', { name: 'application', execution_role: role('EcsExecution'), image: '123456789012.dkr.ecr.us-east-1.amazonaws.com/application@sha256:' + 'a'.repeat(64), subnets: [subnet], groups: [group] }, 'aws_ecs_task_definition'],
  ['amazon-ec2-auto-scaling', 'aws_service_autoscaling', { name: 'application', template: 'lt-0123456789abcdef0', subnets: [subnet, secondSubnet] }, 'aws_autoscaling_group'],
  ['amazon-elasticache', 'aws_service_elasticache', { name: 'application', version: '7.2', user_group: 'application-users', subnets: [subnet, secondSubnet], groups: [group] }, 'aws_elasticache_replication_group'],
  ['aws-cloudtrail', 'aws_service_cloudtrail', { name: 'application-audit', bucket: 'example-application-audit-123456789012' }, 'aws_cloudtrail'],
  ['aws-wafv2', 'aws_service_wafv2', { name: 'application' }, 'aws_wafv2_web_acl'],
  ['amazon-cloudwatch', 'aws_service_cloudwatch_dashboard', { name: 'application-dashboard', metrics: [
    ['Functions', 'AWS/Lambda', 'Invocations', 'FunctionName=orders', 'Sum', '300', 'left'],
    ['Functions', 'AWS/Lambda', 'Errors', 'FunctionName=orders', 'Sum', '300', 'right'],
    ['Database', 'AWS/RDS', 'CPUUtilization', 'DBInstanceIdentifier=orders-db', 'Average', '300', 'left'],
  ] }, 'aws_cloudwatch_dashboard'],
  ...['ACCOUNT', 'ORGANIZATION', 'ACCOUNT_UNUSED_ACCESS', 'ORGANIZATION_UNUSED_ACCESS'].map(type => ['taxonomy:iamaccessanalyzer', 'aws_service_access_analyzer', { name: 'application-access', account:'123456789012', type, ...(type.startsWith('ORGANIZATION')?{organization:'o-1234567890'}:{}), ...(type.endsWith('_UNUSED_ACCESS') ? { age: 180 } : {}) }, 'aws_accessanalyzer_analyzer']),
  ['amazon-managed-service-for-prometheus', 'aws_service_prometheus', { name: 'application-metrics' }, 'aws_prometheus_workspace'],
  ['amazon-managed-service-for-prometheus', 'aws_service_prometheus', { name: 'application-metrics-access', writer: role('MetricsWriter'), reader: role('MetricsReader') }, 'aws_iam_role_policy'],
  ['aws-app-runner', 'aws_service_apprunner', { name: 'application', eligible: true, image: '123456789012.dkr.ecr.us-east-1.amazonaws.com/application@sha256:' + 'a'.repeat(64) }, 'aws_apprunner_service'],
  ['aws-app-runner', 'aws_service_apprunner', { name: 'application-public', eligible: true, repository: 'ECR_PUBLIC', image: 'public.ecr.aws/example/application:release' }, 'aws_apprunner_service'],
  ['aws-iam-identity-center', 'aws_service_identity_center', { name: 'ApplicationReadOnly', instance: 'arn:aws:sso:::instance/ssoins-0123456789abcdef' }, 'aws_ssoadmin_permission_set'],
  ['aws-iam-identity-center', 'aws_service_identity_center', { name: 'ApplicationAssigned', instance: 'arn:aws:sso:::instance/ssoins-0123456789abcdef', assign: true, account: '123456789012', principal: '12345678-abcd-abcd-abcd-123456789abc' }, 'aws_ssoadmin_account_assignment'],
  ['aws-lambda', 'aws_service_lambda_sqs', { name: 'application-queue', function_name: 'application', queue: 'arn:aws:sqs:us-east-1:123456789012:application' }, 'aws_lambda_event_source_mapping'],
  ['aws-lambda', 'aws_service_lambda_sqs', { name: 'application-fifo', function_name: 'application', queue: 'arn:aws:sqs:us-east-1:123456789012:application.fifo', partial: true, concurrency: 5, enabled: false }, 'aws_lambda_event_source_mapping'],
  ['aws-appconfig', 'aws_service_appconfig', { name: 'application' }, 'aws_appconfig_deployment'],
  ['aws-appconfig', 'aws_service_appconfig', { name: 'application-staged', deploy: false, schema: '{"type":"object"}', alarm: 'arn:aws:cloudwatch:us-east-1:123456789012:alarm:application-health' }, 'aws_appconfig_environment'],
  ['aws-config', 'aws_service_config', { name: 'application-config', bucket: 'example-application-config-123456789012' }, 'aws_config_configuration_recorder_status'],
  ['aws-config', 'aws_service_config', { name: 'application-config-selected', bucket: 'example-application-selected-config-123456789012', all: false, types: ['AWS::EC2::Instance', 'AWS::S3::Bucket'] }, 'aws_config_configuration_recorder'],
  ['elastic-load-balancing', 'aws_service_nlb', { name: 'application-network', subnets: [subnet], groups: [group], instances: ['i-0123456789abcdef0'], certificate: 'arn:aws:acm:us-east-1:123456789012:certificate/12345678-abcd-abcd-abcd-123456789abc' }, 'aws_lb_listener'],
  ['elastic-load-balancing', 'aws_service_nlb', { name: 'application-tcp', listener: 'TCP', subnets: [subnet], groups: [group], instances: ['i-0123456789abcdef0'] }, 'aws_lb_listener'],
  ['taxonomy:rdsproxy', 'aws_service_rds_proxy', { name: 'application-proxy', target: 'application-db', secret: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:application/database-abcdef', subnets: [subnet, secondSubnet], groups: [group] }, 'aws_db_proxy'],
  ['taxonomy:rdsproxy', 'aws_service_rds_proxy', { name: 'application-instance-proxy', target_type: 'instance', family: 'MYSQL', iam: 'REQUIRED', target: 'application-db', secret: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:application/database-abcdef', subnets: [subnet, secondSubnet], groups: [group] }, 'aws_db_proxy_target'],
  ['amazon-aurora', 'aws_service_aurora', { name: 'application-db', version: '16.6', subnets: [subnet, secondSubnet], groups: [group] }, 'aws_rds_cluster_instance'],
  ['amazon-aurora', 'aws_service_aurora', { name: 'application-serverless', version: '16.6', capacity: 'serverless', subnets: [subnet, secondSubnet], groups: [group] }, 'aws_rds_cluster_instance'],
  ['taxonomy:privatelink', 'aws_service_endpoint', { name: 'private-ssm', vpc: 'vpc-0123456789abcdef0', subnets: [subnet], groups: [group] }, 'aws_vpc_endpoint'],
  ['taxonomy:privatelink', 'aws_service_endpoint', { name: 'private-s3', type: 'Gateway', vpc: 'vpc-0123456789abcdef0', routes: ['rtb-0123456789abcdef0'] }, 'aws_vpc_endpoint'],
  ['amazon-cloudfront', 'aws_service_cloudfront', { name: 'Application static site', bucket: 'example-application-content-123456789012' }, 'aws_cloudfront_distribution'],
  ['amazon-cloudfront', 'aws_service_cloudfront', { name: 'Application custom site', bucket: 'example-application-custom-content-123456789012', aliases: ['site.example.com'], certificate: 'arn:aws:acm:us-east-1:123456789012:certificate/12345678-abcd-abcd-abcd-123456789abc', waf: 'arn:aws:wafv2:us-east-1:123456789012:global/webacl/application/12345678-abcd-abcd-abcd-123456789abc' }, 'aws_cloudfront_distribution'],
  ['taxonomy:kinesisdatastreams', 'aws_service_kinesis', { name: 'application-events' }, 'aws_kinesis_stream'],
  ['taxonomy:kinesisdatastreams', 'aws_service_kinesis', { name: 'application-provisioned', mode: 'PROVISIONED', shards: 2, consumer: 'application' }, 'aws_kinesis_stream_consumer'],
  ['taxonomy:systemsmanagerparameterstore', 'aws_service_parameter', { name: '/production/orders/api-url', value: 'https://orders.example.com' }, 'aws_ssm_parameter'],
  ['taxonomy:systemsmanagerparameterstore', 'aws_service_parameter', { name: '/production/orders/credential', type: 'SecureString' }, 'aws_ssm_parameter'],
  ['aws-wafv2', 'aws_service_wafv2', { name: 'application-allowlist', default_action: 'block', allowed: ['192.0.2.0/24'], count: false, alb: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/application/0123456789abcdef' }, 'aws_wafv2_ip_set'],
  ['amazon-api-gateway', 'aws_service_http_api', { name: 'application-jwt', function_name: 'orders', authorization: 'JWT', issuer: 'https://identity.example.com', audiences: ['orders'], scopes: ['orders:read'] }, 'aws_apigatewayv2_authorizer'],
  ['amazon-elastic-file-system', 'aws_service_efs', { name: 'application-provisioned', subnets: [subnet, secondSubnet], groups: [group], throughput: 'provisioned', mibps: 10 }, 'aws_efs_mount_target'],
  ['amazon-elastic-kubernetes-service', 'aws_service_eks', { name: 'application-restricted', version: '1.34', subnets: [subnet, secondSubnet], cluster_role: role('Cluster'), node_role: role('Nodes'), admin: role('Admin'), endpoint: 'both', public_cidrs: ['192.0.2.0/24'] }, 'aws_eks_node_group'],
];
const onlyAt = process.argv.indexOf('--only');
const requested = onlyAt === -1 ? [] : String(process.argv[onlyAt + 1] ?? '').split(',');
const runtimeOnly=process.argv.includes('--runtime-only'),regionAt=process.argv.indexOf('--region');
const selected = runtimeOnly?[]:onlyAt === -1 ? fixtures : fixtures.filter(fixture => requested.includes(fixture[1]));
assert.ok(runtimeOnly||selected.length, 'No browser fixture matched --only.');
assert.ok(!runtimeOnly||!process.argv.includes('--validate'),'Runtime-only checks have no deployment packages to validate.');
await mkdir(WORK_TMP, { recursive: true });
const work = await mkdtemp(path.join(WORK_TMP, 'aws-service-forms-'));
const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), headless: true, args: ['--disable-crashpad-for-testing'] });
const packages = [];
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const web = path.resolve(ROOT, 'web');
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    const file = path.resolve(web, '.' + decodeURIComponent(url.pathname));
    if (url.hostname !== 'archtoolkit.test' || !file.startsWith(web + path.sep)) return route.abort();
    try { await route.fulfill({ body: await readFile(file), contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' }[path.extname(file)] ?? 'application/octet-stream' }); }
    catch { await route.fulfill({ status: 404, body: 'Missing local file' }); }
  });
  if(runtimeOnly)await page.goto('https://archtoolkit.test/app/add-service.html?provider=aws&region='+encodeURIComponent(regionAt<0?'us-east-1':process.argv[regionAt+1]));
  for (const [index, [service, resource, values, emitted, runtimeSource, fixtureRegion='us-east-1']] of selected.entries()) {
    await page.goto('https://archtoolkit.test/app/add-service.html?provider=aws&region='+encodeURIComponent(fixtureRegion));
    await page.getByLabel('Service', { exact: true }).selectOption(runtimeSource ?? service);
    if (runtimeSource) {
      assert.equal(await page.getByText('No build definition is loaded for this service.', { exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Export deployment package', exact: true }).isDisabled(), true);
      await page.getByRole('button', { name: /^Open .+ setup$/ }).click();
      assert.equal(await page.getByLabel('Service', { exact: true }).inputValue(), service);
      assert.equal(await page.getByLabel('Region / site', { exact: true }).first().inputValue(), fixtureRegion);
    }
    await page.getByLabel('Service resource', { exact: true }).selectOption(resource);
    if (resource === 'aws_service_apprunner') assert.equal(await page.getByRole('link', { name: 'AWS availability details', exact: true }).isVisible(), true);
    for (const [id, value] of Object.entries(values)) {
      const field = page.locator('[data-input=' + id + ']');
      await field.evaluate(element => { for (let parent = element.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true; });
      if (await field.evaluate(element => element.classList.contains('checklist'))) {
        const names = Array.isArray(value) ? value : String(value).split(',').map(name => name.trim()).filter(Boolean);
        for (const checkbox of await field.getByRole('checkbox').all()) await checkbox.setChecked(false);
        for (const name of names) await field.getByRole('checkbox', { name: String(name), exact: true }).setChecked(true);
      }
      else if (Array.isArray(value) && Array.isArray(value[0])) {
        while (await field.locator('tbody tr').count() < value.length) await field.getByRole('button', { name: 'Add row', exact: true }).click();
        for (const [row, cells] of value.entries()) for (const [column, text] of cells.entries()) {
          const cell = field.locator('tbody tr').nth(row).locator('input, select').nth(column);
          if (await cell.evaluate(element => element.tagName === 'SELECT')) await cell.selectOption(String(text)); else await cell.fill(String(text));
        }
      }
      else if (Array.isArray(value)) {
        if (await field.evaluate(element => element.tagName === 'INPUT')) await field.fill(value.join(','));
        else for (const item of value) { const input = field.locator('input').first(); await input.fill(item); await input.press('Enter'); }
      }
      else if (await field.evaluate(element => element.tagName === 'SELECT')) await field.selectOption(String(value));
      else if (typeof value === 'boolean') await field.setChecked(value);
      else if (await field.evaluate(element => element.classList.contains('list-editor'))) {
        for (const item of String(value).split(',').map(item => item.trim()).filter(Boolean)) {
          const input = field.locator('input').first(); await input.fill(item); await input.press('Enter');
        }
      }
      else if (await field.locator('select').count()) {
        const select = field.locator('select');
        const known = await select.locator('option').evaluateAll((options, requested) => options.some(option => option.value === requested), String(value));
        await select.selectOption(known ? String(value) : '__custom__');
        if (!known) await field.locator('input').first().fill(String(value));
      }
      else await field.fill(String(value));
    }
    await page.locator('[data-control=generate]').click();
    const button = page.getByRole('button', { name: 'Export deployment package', exact: true });
    assert.equal(await button.isDisabled(), false, resource + ' did not pass generation\n' + await page.locator('body').textContent());
    const event = page.waitForEvent('download');
    await button.click();
    const download = await event, file = path.join(work, resource + '-' + index + '.zip');
    await download.saveAs(file);
    const zip = openZip(new Uint8Array(await readFile(file)));
    assert.equal(JSON.parse(await zip.text('service-deployment.json')).resource, resource);
    const terraform = await zip.text('main.tf');
    assert.ok(terraform.includes('resource "' + emitted + '"'), resource);
    if (['aws_service_efs', 'aws_service_ebs'].includes(resource)) assert.match(terraform, /tags\s+= \{ Name = "[^"]+" \}/);
    if (resource === 'aws_service_lambda_sqs' && values.partial === true) assert.match(terraform, /ReportBatchItemFailures/);
    if (resource === 'aws_service_lambda_sqs' && values.enabled === false) assert.match(terraform, /enabled\s+= false/);
    if (resource === 'aws_service_config' && values.all === false) assert.match(terraform, /resource_types\s+= \["AWS::EC2::Instance", "AWS::S3::Bucket"\]/);
    if (resource === 'aws_service_appconfig' && values.deploy === false) assert.doesNotMatch(terraform, /resource "aws_appconfig_deployment"/);
    if (resource === 'aws_service_wafv2' && values.count === false) assert.match(terraform, /none\s*\{/);
    if (resource === 'aws_service_wafv2' && values.default_action === 'block') assert.match(terraform, /AllowedClients/);
    if (resource === 'aws_service_cloudwatch_dashboard') { const body = JSON.parse(await zip.text('dashboard.json')); assert.equal(body.widgets.length, 2); assert.equal(body.widgets[0].properties.metrics.length, 2); assert.equal(body.widgets[0].properties.metrics[1].at(-1).yAxis, 'right'); }
    if (resource === 'aws_service_codepipeline') { assert.match(await zip.text('modules/build/main.tf'), /type\s+= "CODEPIPELINE"/); assert.match(await zip.text('modules/build/buildspec.yml'), /artifacts:/); assert.ok(zip.names.includes('modules/build/providers.tf')); }
    if (resource.startsWith('aws_service_datasync_')) {
      for (const name of ['OPERATE.py', 'OPERATOR.md', 'TRANSFER-CONFIG.json']) assert.ok(zip.names.includes(name), resource + ' missing ' + name);
      const config = JSON.parse(await zip.text('TRANSFER-CONFIG.json'));
      assert.equal(config.source.kind, resource === 'aws_service_datasync_s3' ? 's3' : resource.startsWith('aws_service_datasync_smb_') ? 'smb' : 'nfs');
      assert.equal(config.options.OverwriteMode, values.overwrite ?? 'NEVER');
      assert.match(await zip.text('OPERATE.py'), /total_max_attempts/);
    }
    if (resource === 'aws_service_elasticache_sharded') {
      const expected = AWS_ELASTICACHE_SHARDED_SERVICE.build({ ...defaultValues(AWS_ELASTICACHE_SHARDED_SERVICE), aws_region:'us-east-1', ...values });
      assert.deepEqual(expected.findings, []);
      for (const name of ['PREFLIGHT.py','CHECK.py','SHARDED-CONFIG.json']) assert.equal(await zip.text(name), expected.files[name], resource + ' exported stale ' + name);
    }
    if (resource === 'aws_service_elasticache_serverless') {
      const expected = AWS_ELASTICACHE_SERVERLESS_SERVICE.build({ ...defaultValues(AWS_ELASTICACHE_SERVERLESS_SERVICE), aws_region:'us-east-1', ...values });
      assert.deepEqual(expected.findings, []);
      for (const name of ['PREFLIGHT.py','CHECK.py','CACHE-CONFIG.json']) assert.equal(await zip.text(name), expected.files[name], resource + ' exported stale ' + name);
    }
    if (resource === 'aws_service_webrtc_storage') {
      const expected = AWS_WEBRTC_STORAGE_SERVICE.build({ ...defaultValues(AWS_WEBRTC_STORAGE_SERVICE), aws_region:'us-east-1', ...values });
      assert.deepEqual(expected.findings, []);
      for (const name of ['OPERATE.py','STORAGE-CONFIG.json']) assert.equal(await zip.text(name), expected.files[name], resource + ' exported stale ' + name);
    }
    if (resource === 'aws_service_webrtc_signaling') {
      const expected = AWS_WEBRTC_SERVICE.build({ ...defaultValues(AWS_WEBRTC_SERVICE), aws_region:'us-east-1', ...values });
      assert.deepEqual(expected.findings, []);
      for (const name of ['PREFLIGHT.py','CHECK.py','SIGNALING-CONFIG.json','SIGNALING.template.json']) assert.equal(await zip.text(name), expected.files[name], resource + ' exported stale ' + name);
    }
    if (resource === 'aws_service_kinesis_video') {
      const expected = AWS_KINESIS_VIDEO_SERVICE.build({ ...defaultValues(AWS_KINESIS_VIDEO_SERVICE), aws_region:'us-east-1', ...values });
      assert.deepEqual(expected.findings, []);
      for (const name of ['PREFLIGHT.py','CHECK.py','VIDEO-CONFIG.json']) assert.equal(await zip.text(name), expected.files[name], resource + ' exported stale ' + name);
    }
    if (resource === 'aws_service_ivs_chat') {
      const expected = AWS_IVS_CHAT_SERVICE.build({ ...defaultValues(AWS_IVS_CHAT_SERVICE), aws_region:'us-east-1', ...values });
      assert.deepEqual(expected.findings, []);
      for (const name of ['PREFLIGHT.py','CHECK.py','CHAT-CONFIG.json','REVIEW-PERMISSION.example.json']) assert.equal(await zip.text(name), expected.files[name], resource + ' exported stale ' + name);
    }
    if (resource === 'aws_service_ivs_channel') {
      const expected = AWS_IVS_SERVICE.build({ ...defaultValues(AWS_IVS_SERVICE), aws_region:'us-east-1', ...values });
      assert.deepEqual(expected.findings, []);
      for (const name of ['PREFLIGHT.py','CHECK.py','CHANNEL-CONFIG.json']) assert.equal(await zip.text(name), expected.files[name], resource + ' exported stale ' + name);
    }
    if (resource === 'aws_service_instance_connect') {
      const expected = AWS_INSTANCE_CONNECT_SERVICE.build({ ...defaultValues(AWS_INSTANCE_CONNECT_SERVICE), aws_region:'us-east-1', ...values });
      assert.deepEqual(expected.findings, []);
      for (const name of ['PREFLIGHT.py','CHECK.py','CONNECTION-CONFIG.json','CONNECT-EXAMPLE.txt']) assert.equal(await zip.text(name), expected.files[name], resource + ' exported stale ' + name);
    }
    if (resource === 'aws_service_eks_pod_identity_s3') {
      const expected = AWS_EKS_POD_IDENTITY_SERVICE.build({ ...defaultValues(AWS_EKS_POD_IDENTITY_SERVICE), aws_region:'us-east-1', ...values });
      assert.deepEqual(expected.findings, []);
      for (const name of ['PREFLIGHT.py','CHECK.py','CLIENT.py','WORKLOAD-CONFIG.json','smoke-job.yaml']) assert.equal(await zip.text(name), expected.files[name], resource + ' exported stale ' + name);
    }
    if (resource === 'aws_service_appflow_salesforce_s3') {
      const expected=AWS_APPFLOW_SERVICE.build({...defaultValues(AWS_APPFLOW_SERVICE),aws_region:fixtureRegion,...values});
      assert.deepEqual(expected.findings,[]);
      for(const name of ['INSPECT.py','FLOW-CONFIG.json','BUCKET-POLICY-MERGE.json','START-APPROVED.ps1','providers.tf'])assert.equal(await zip.text(name),expected.files[name],resource+' exported stale '+name);
    }
    if (resource === 'aws_service_access_analyzer') {
      const expected=AWS_ACCESS_ANALYZER_SERVICE.build({...defaultValues(AWS_ACCESS_ANALYZER_SERVICE),aws_region:fixtureRegion,...values});
      assert.deepEqual(expected.findings,[]);
      for(const name of ['INSPECT.py','ANALYZER-CONFIG.json','GET-FINDINGS.ps1','providers.tf'])assert.equal(await zip.text(name),expected.files[name],resource+' exported stale '+name);
    }
    if (resource === 'aws_service_mwaa_private') {
      const expected=AWS_MWAA_SERVICE.build({...defaultValues(AWS_MWAA_SERVICE),aws_region:fixtureRegion,...values});
      assert.deepEqual(expected.findings,[]);
      for(const name of ['INSPECT.py','MWAA-CONFIG.json','review_smoke_dag.py'])assert.equal(await zip.text(name),expected.files[name],resource+' exported stale '+name);
    }
    if (resource === 'aws_service_storagegateway_nfs') {
      const expected=AWS_STORAGEGATEWAY_SERVICE.build({...defaultValues(AWS_STORAGEGATEWAY_SERVICE),aws_region:fixtureRegion,...values});
      assert.deepEqual(expected.findings,[]);
      for(const name of ['INSPECT.py','FILESHARE-CONFIG.json'])assert.equal(await zip.text(name),expected.files[name],resource+' exported stale '+name);
    }
    if (resource === 'aws_service_cloudwan_isolated_core') {
      const expected=AWS_CLOUDWAN_SERVICE.build({...defaultValues(AWS_CLOUDWAN_SERVICE),aws_region:fixtureRegion,...values});
      assert.deepEqual(expected.findings,[]);
      for(const name of ['INSPECT.py','CORE-POLICY.json','NETWORK-CONFIG.json','providers.tf'])assert.equal(await zip.text(name),expected.files[name],resource+' exported stale '+name);
    }
    if (resource === 'aws_service_directconnect_private_vif') {
      const expected=AWS_DIRECTCONNECT_SERVICE.build({...defaultValues(AWS_DIRECTCONNECT_SERVICE),aws_region:'us-east-1',...values});
      assert.deepEqual(expected.findings,[]);
      for(const name of ['INSPECT.py','CONNECTION-CONFIG.json','CPE-REVIEW.cfg','variables.tf'])assert.equal(await zip.text(name),expected.files[name],resource+' exported stale '+name);
    }
    if (resource === 'aws_service_drs_recovery') {
      const expected=AWS_DRS_SERVICE.build({...defaultValues(AWS_DRS_SERVICE),aws_region:fixtureRegion,...values});
      assert.deepEqual(expected.findings,[]);
      for(const name of ['OPERATE.py','RECOVERY-CONFIG.json'])assert.equal(await zip.text(name),expected.files[name],resource+' exported stale '+name);
      assert.equal(JSON.parse(await zip.text('service-deployment.json')).region,fixtureRegion);
    }
    if (resource === 'aws_service_redshift_provisioned') {
      const expected=AWS_REDSHIFT_PROVISIONED_SERVICE.build({...defaultValues(AWS_REDSHIFT_PROVISIONED_SERVICE),aws_region:'us-east-1',...values});
      assert.deepEqual(expected.findings,[]);
      for(const name of ['INSPECT.py','WAREHOUSE-CONFIG.json','CHECK.sql'])assert.equal(await zip.text(name),expected.files[name],resource+' exported stale '+name);
    }
    if (resource === 'aws_service_pipes_sqs_lambda') {
      const expected=AWS_PIPES_SERVICE.build({...defaultValues(AWS_PIPES_SERVICE),aws_region:'us-east-1',...values});
      assert.deepEqual(expected.findings,[]);
      for(const name of ['INSPECT.py','PIPE-CONFIG.json'])assert.equal(await zip.text(name),expected.files[name],resource+' exported stale '+name);
    }
    if (resource === 'aws_service_scheduler_lambda') {
      const expected=AWS_SCHEDULER_SERVICE.build({...defaultValues(AWS_SCHEDULER_SERVICE),aws_region:'us-east-1',...values});
      assert.deepEqual(expected.findings,[]);
      for(const name of ['INSPECT.py','SCHEDULE-CONFIG.json'])assert.equal(await zip.text(name),expected.files[name],resource+' exported stale '+name);
    }
    if (resource === 'aws_service_mgn_cutover') {
      const expected = AWS_MGN_CUTOVER_SERVICE.build({ ...defaultValues(AWS_MGN_CUTOVER_SERVICE), aws_region:'us-east-1', ...values });
      assert.deepEqual(expected.findings, []);
      for (const name of ['OPERATE.py','CHECK-TARGET.py','DECIDE.py','CUTOVER-CONFIG.json']) assert.equal(await zip.text(name), expected.files[name], resource + ' exported stale ' + name);
      assert.ok(!zip.names.includes('PILOT-CONFIG.json'));
    }
    if (resource === 'aws_service_sagemaker_endpoint') {
      const expected = AWS_SAGEMAKER_SERVICE.build({ ...defaultValues(AWS_SAGEMAKER_SERVICE), aws_region:'us-east-1', ...values });
      assert.deepEqual(expected.findings, []);
      for (const name of ['PREFLIGHT.py','CHECK.py','CLIENT-CONFIG.json']) assert.equal(await zip.text(name), expected.files[name], resource + ' exported a stale or changed ' + name);
    }
    for (const name of ['SERVICE-SETUP.md', 'IMPLEMENTATION.md']) assert.ok(zip.names.includes(name), resource + ' missing ' + name);
    if (resource === 'aws_service_guardduty' && values.mode === 'existing') await page.locator('[data-input=detector]').fill('b'.repeat(32));
    else if (resource === 'aws_service_guardduty') await page.locator('[data-input=frequency]').selectOption('ONE_HOUR');
    else if (resource === 'aws_service_inspector' || resource === 'aws_service_securityhub') await page.locator('[data-input=account]').fill('210987654321');
    else if ('table_name' in values) await page.locator('[data-input=table_name]').fill('changed-application');
    else await page.locator('[data-input=' + ('domain' in values ? 'domain' : 'name') + ']').fill('domain' in values ? 'api.example.com' : 'changed-application');
    assert.equal(await button.isDisabled(), true, resource + ' retained a stale export');
    packages.push(file);
    console.log(resource + ' passed setup, download and invalidation.');
  }
  const runtimeRegion=await page.getByLabel('Region / site',{exact:true}).first().inputValue();
  for (const [service, runtime] of Object.entries(AWS_RUNTIME_APIS)) {
    await page.getByLabel('Service', { exact: true }).selectOption(service);
    assert.equal(await page.getByLabel('Service resource', { exact: true }).count(), 0, service);
    assert.equal(await page.getByRole('button', { name: 'Export deployment package', exact: true }).isDisabled(), true, service);
    assert.ok((await page.locator('body').textContent()).includes(runtime.message), service);
    await page.getByRole('button', { name: /^Open .+ setup$/ }).click();
    assert.equal(await page.getByLabel('Service', { exact: true }).inputValue(), runtime.setupService);
    assert.equal(await page.getByLabel('Region / site', { exact: true }).first().inputValue(), runtimeRegion);
    assert.ok(await page.getByLabel('Service resource', { exact: true }).count(), runtime.setupService);
    if (AWS_SERVICE_AVAILABILITY[service]?.status === 'existing-customers-only') {
      assert.equal(await page.getByRole('link', { name: 'AWS availability details', exact: true }).isVisible(), true);
      assert.equal(await page.locator('[data-input=service_existing_customer]').inputValue(), 'false');
    }
  }
  console.log('All runtime APIs navigate to separate setup without creating duplicate infrastructure forms.');
  for (const [service, availability] of Object.entries(AWS_SERVICE_AVAILABILITY).filter(([, value]) => value.status === 'retired')) {
    await page.getByLabel('Service', { exact: true }).selectOption(service);
    assert.ok((await page.locator('body').textContent()).includes(availability.message), service);
    assert.equal(await page.getByLabel('Service resource', { exact: true }).count(), 0, service);
    assert.equal(await page.getByRole('button', { name: 'Export deployment package', exact: true }).isDisabled(), true, service);
  }
  await page.getByLabel('Service', { exact: true }).selectOption('aws-cloud9');
  await page.getByLabel('Service resource', { exact: true }).selectOption('res_aws_cloud9_environment_ec2');
  for (const [id, value] of Object.entries({ 'r.name': 'existing-cloud9', 'r.image_id': 'amazonlinux-2023-x86_64', 'r.instance_type': 't3.small' })) {
    const field = page.locator('[data-input="' + id + '"]');
    await field.evaluate(node => { for (let parent = node.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true; });
    await field.fill(value);
  }
  const eligibility = page.locator('[data-input=service_existing_customer]');
  assert.equal(await eligibility.inputValue(), 'false');
  await page.locator('[data-control=generate]').click();
  assert.equal(await page.getByRole('button', { name: 'Export deployment package', exact: true }).isDisabled(), true);
  assert.ok((await page.locator('body').textContent()).includes('Verify that this AWS account already has access'));
  await eligibility.selectOption('true');
  await page.locator('[data-control=generate]').click();
  assert.equal(await page.getByRole('button', { name: 'Export deployment package', exact: true }).isDisabled(), false, (await page.locator('body').textContent()).slice(-12000));
  await eligibility.selectOption('false');
  assert.equal(await page.getByRole('button', { name: 'Export deployment package', exact: true }).isDisabled(), true);
  await page.getByLabel('Build with', { exact: true }).selectOption('cloudformation');
  await page.getByLabel('Service resource', { exact: true }).selectOption('cfn:AWS::Cloud9::EnvironmentEC2');
  for (const [id, value] of Object.entries({ ImageId: 'amazonlinux-2023-x86_64', InstanceType: 't3.small', Name: 'existing-cloud9' })) {
    const field = page.locator('[data-input="' + id + '"]');
    await field.evaluate(node => { for (let parent = node.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true; });
    await field.fill(value);
  }
  const cloudFormationEligibility = page.locator('[data-input=service_existing_customer]');
  assert.equal(await cloudFormationEligibility.inputValue(), 'false');
  await page.locator('[data-control=generate]').click();
  assert.equal(await page.getByRole('button', { name: 'Export deployment package', exact: true }).isDisabled(), true);
  await cloudFormationEligibility.selectOption('true');
  await page.locator('[data-control=generate]').click();
  assert.equal(await page.getByRole('button', { name: 'Export deployment package', exact: true }).isDisabled(), false);
  console.log('Existing-customer eligibility blocks generation and invalidates stale exports without duplicate controls.');
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
console.log('Saved ' + packages.length + ' packages to ' + work);
if (process.argv.includes('--validate')) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'tools/validate-service-packages.mjs'), ...(process.env.TERRAFORM_PATH ? ['--terraform', process.env.TERRAFORM_PATH] : []), ...packages], { stdio: 'inherit', timeout: 30 * 60 * 1000 });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
