                                                   
import {error,            } from '../core/findings.js';
import {blk,dat,e,jsonencode,output,res,x} from '../terraform/blueprints/migration/common.js';
import {awsServiceModule,awsServicePartition,awsServiceRegion} from './aws-service-module.js';
import {awsSageMakerClients} from './aws-sagemaker-clients.js';
const instances=['ml.m5.large','ml.m5.xlarge','ml.m5.2xlarge','ml.c5.large','ml.c5.xlarge','ml.c5.2xlarge','ml.r5.large','ml.r5.xlarge','ml.r5.2xlarge'];
const fipsRegions=['us-east-1','us-east-2','us-west-1','us-west-2','us-gov-east-1','us-gov-west-1'];
export const AWS_SAGEMAKER_SERVICE={
  id:'aws_service_sagemaker_endpoint',label:'Host one isolated CPU model with private inference access',
  description:'Deploy an approved digest-pinned ECR inference image, optional immutable S3 archive, encrypted real-time hosting and private runtime access for one existing role.',
  emits:['aws_sagemaker_model','aws_sagemaker_endpoint_configuration','aws_sagemaker_endpoint','aws_vpc_endpoint','aws_iam_role','aws_iam_role_policy','aws_cloudwatch_log_group'],
  inputs:[
    awsServiceRegion,{id:'name',label:'Inference endpoint name',control:'text'},
    {id:'release',label:'Model/configuration release',control:'text',default:'v1',hint:'Increment for a new image, artifact or hosting configuration. Review replacement/update costs and rollback before deployment.'},
    {id:'image',label:'Approved ECR image URI with SHA256 digest',control:'text',hint:'Same account/region private ECR image, repo@sha256:…; approved CPU/x86 SageMaker serve/8080 contract. No floating tag.'},
    {id:'artifact',label:'Model files',control:'select',default:'IMAGE',options:[{value:'IMAGE',label:'Packaged in the approved image'},{value:'ARCHIVE',label:'Approved immutable model.tar.gz in S3'}]},
    {id:'bucket',label:'Existing model-artifact S3 bucket',control:'text',showWhen:{input:'artifact',equals:['ARCHIVE']}},
    {id:'key',label:'Immutable artifact object key',control:'text',showWhen:{input:'artifact',equals:['ARCHIVE']},hint:'Dedicated immutable key ending .tar.gz. SageMaker cannot pin an S3 version in this model URL.'},
    {id:'version',label:'Approved current artifact version ID',control:'text',showWhen:{input:'artifact',equals:['ARCHIVE']},hint:'Metadata preflight verifies this is still the current object. Owner must prevent overwriting/replacing the key.'},
    {id:'etag',label:'Approved artifact ETag',control:'text',showWhen:{input:'artifact',equals:['ARCHIVE']},hint:'Metadata match only, not a SHA256/content integrity or safety proof.'},
    {id:'kms',label:'Existing customer KMS key ARN',control:'text',hint:'Same account/region symmetric key for endpoint storage/logs and optional S3 artifact. Owner must configure service/key/grant permissions.'},
    {id:'subnets',label:'Existing private runtime-access subnet IDs',control:'text',hint:'1–3 subnets, distinct AZs in one VPC. These place PrivateLink interfaces, not the hosted model instances.'},
    {id:'clients',label:'Existing authorized client security group IDs',control:'text',hint:'1–5 same-VPC groups permitted to reach the runtime interface on TCP443.'},
    {id:'role',label:'Existing inference application role ARN',control:'text',hint:'This role receives exact-endpoint invoke access and a deny outside the created VPC endpoint. Existing trust/credential delivery stays owner-managed.'},
    {id:'endpoint',label:'Runtime API endpoint',control:'select',default:'STANDARD',options:[{value:'STANDARD',label:'Standard PrivateLink runtime'},{value:'FIPS',label:'FIPS PrivateLink runtime — supported US regions'}]},
    {id:'instance',label:'CPU hosting instance type',control:'select',default:'ml.m5.xlarge',options:instances.map(value=>({value,label:value}))},
    {id:'count',label:'Fixed hosting instance count',control:'number',default:1,hint:'1–4. Hosting and PrivateLink incur ongoing charges after apply; this is not an autoscaler or budget ceiling.'},
    {id:'volume',label:'ML storage per instance (GB)',control:'number',default:30,hint:'1–512; size for extracted model and container needs.'},
    {id:'startup',label:'Container health-check timeout (seconds)',control:'number',default:300},
    {id:'download',label:'Model download/extract timeout (seconds)',control:'number',default:300},
    {id:'retention',label:'Encrypted log retention (days)',control:'select',default:'30',options:[7,14,30,60,90,180,365].map(value=>({value:String(value),label:String(value)}))},
  ],
  build(values)                                    {
    const findings          =[],reject=(path       ,message       )=>findings.push(error('aws.sagemaker.'+path,message,{path}));
    const region=String(values.aws_region??''),partition=awsServicePartition(region),name=String(values.name??'').trim(),release=String(values.release??'').trim(),image=String(values.image??'').trim(),artifact=String(values.artifact??''),kms=String(values.kms??'').trim(),role=String(values.role??'').trim(),endpoint=String(values.endpoint??''),instance=String(values.instance??'');
    const roleMatch=/^arn:([^:]+):iam::(\d{12}):role\/([A-Za-z0-9+=,.@_/-]+)$/.exec(role),account=roleMatch?.[2]??'',roleName=roleMatch?.[3]?.split('/').at(-1)??'';
    const imageMatch=/^(\d{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com\/([a-z0-9][a-z0-9._/-]{0,126})@sha256:([0-9a-f]{64})$/.exec(image);
    if(!['aws','aws-us-gov'].includes(partition))reject('aws_region','This bounded recipe covers commercial AWS and GovCloud partitions.');
    if(!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/.test(name))reject('name','Use 1–40 letters, digits or internal hyphens.');
    if(!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,14}[A-Za-z0-9])?$/.test(release))reject('release','Use a 1–16 character release label with letters/digits/internal hyphens.');
    if(!roleMatch||roleMatch[1]!==partition)reject('role','Enter the existing application role ARN in the selected partition.');
    if(!imageMatch||imageMatch[1]!==account||imageMatch[2]!==region||imageMatch[3] .split('/').some(part=>!part||part==='.'||part==='..'))reject('image','Use an approved same-account/region private ECR repository URI pinned by SHA256 digest.');
    if(!kms.startsWith('arn:'+partition+':kms:'+region+':'+account+':key/')||!/^arn:[^:]+:kms:[^:]+:\d{12}:key\/[0-9a-f-]+$/.test(kms))reject('kms','Enter the selected account/region customer key ARN.');
    const list=(key       )=>[...new Set(String(values[key]??'').split(',').map(item=>item.trim()).filter(Boolean))],subnets=list('subnets'),clients=list('clients');
    if(!subnets.length||subnets.length>3||subnets.some(value=>!/^subnet-(?:[0-9a-f]{8}|[0-9a-f]{17})$/.test(value)))reject('subnets','Choose 1–3 existing private subnets in distinct AZs.');
    if(!clients.length||clients.length>5||clients.some(value=>!/^sg-(?:[0-9a-f]{8}|[0-9a-f]{17})$/.test(value)))reject('clients','Choose 1–5 existing approved client security groups.');
    const fips=endpoint==='FIPS';
    if(!['STANDARD','FIPS'].includes(endpoint)||fips&&!fipsRegions.includes(region)||partition==='aws-us-gov'&&!fips)reject('endpoint','Use a published runtime endpoint; this GovCloud recipe requires FIPS.');
    if(!instances.includes(instance))reject('instance','Choose a supported CPU instance type and verify regional quota/model compatibility.');
    const count=Number(values.count),volume=Number(values.volume),startup=Number(values.startup),download=Number(values.download),retention=Number(values.retention);
    for(const [key,value,min,max]of [['count',count,1,4],['volume',volume,1,512],['startup',startup,60,3600],['download',download,60,3600]]        )if(!Number.isInteger(value)||value<min||value>max)reject(key,'Use an integer from '+min+' to '+max+'.');
    if(![7,14,30,60,90,180,365].includes(retention))reject('retention','Choose log retention.');
    if(!['IMAGE','ARCHIVE'].includes(artifact))reject('artifact','Choose the model artifact mode.');
    const bucket=artifact==='ARCHIVE'?String(values.bucket??'').trim():'',key=artifact==='ARCHIVE'?String(values.key??'').trim():'',version=artifact==='ARCHIVE'?String(values.version??'').trim():'',etag=artifact==='ARCHIVE'?String(values.etag??'').trim().replace(/^"|"$/g,''):'';
    if(artifact==='ARCHIVE'){
      if(!/^(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)||bucket.includes('..'))reject('bucket','Enter the existing private model bucket.');
      if(!/^[A-Za-z0-9_./-]+\.tar\.gz$/.test(key)||key.startsWith('/')||key.includes('//')||key.split('/').some(part=>part==='.'||part==='..')||key.length>1024)reject('key','Use an immutable .tar.gz object key without traversal or query characters.');
      if(!version||version==='null'||version.length>1024||/[\x00-\x1f]/.test(version))reject('version','Record the approved current version in a versioned bucket.');
      if(!/^[0-9a-f]{32}(?:-[1-9][0-9]*)?$/.test(etag))reject('etag','Record the approved object ETag (metadata comparison only).');
    }
    const model=name+'-'+release,endpointArn='arn:'+partition+':sagemaker:'+region+':'+account+':endpoint/'+name,modelArn='arn:'+partition+':sagemaker:'+region+':'+account+':model/'+model,configArn='arn:'+partition+':sagemaker:'+region+':'+account+':endpoint-config/'+model,executionRole='arn:'+partition+':iam::'+account+':role/'+name+'-model';
    const repository=imageMatch?.[3]??'',digest='sha256:'+(imageMatch?.[4]??''),repositoryArn='arn:'+partition+':ecr:'+region+':'+account+':repository/'+repository,logName='/aws/sagemaker/Endpoints/'+name,logArn='arn:'+partition+':logs:'+region+':'+account+':log-group:'+logName;
    const executionPolicy={Version:'2012-10-17',Statement:[
      {Effect:'Allow',Action:['ecr:GetAuthorizationToken'],Resource:'*'},
      {Effect:'Allow',Action:['ecr:BatchCheckLayerAvailability','ecr:GetDownloadUrlForLayer','ecr:BatchGetImage'],Resource:repositoryArn},
      {Effect:'Allow',Action:['logs:CreateLogStream','logs:PutLogEvents','logs:DescribeLogStreams'],Resource:logArn+':*'},
      {Effect:'Allow',Action:['logs:CreateLogGroup'],Resource:[logArn,logArn+':*']},
      {Effect:'Allow',Action:['cloudwatch:PutMetricData'],Resource:'*',Condition:{StringEquals:{'cloudwatch:namespace':['AWS/SageMaker','/aws/sagemaker/Endpoints']}}},
      ...(artifact==='ARCHIVE'?[{Effect:'Allow',Action:['s3:GetObject'],Resource:'arn:'+partition+':s3:::'+bucket+'/'+key},{Effect:'Allow',Action:['s3:ListBucket'],Resource:'arn:'+partition+':s3:::'+bucket,Condition:{StringLike:{'s3:prefix':[key]}}},{Effect:'Allow',Action:['kms:Decrypt','kms:DescribeKey'],Resource:kms}]:[]),
    ]};
    const first='data.aws_subnet.runtime['+JSON.stringify(subnets[0]??'')+']';
    const result=awsServiceModule(region,[
      dat('aws_caller_identity','current',{}),dat('aws_subnet','runtime',{for_each:x('toset('+JSON.stringify(subnets)+')'),id:x('each.value')}),dat('aws_security_group','clients',{for_each:x('toset('+JSON.stringify(clients)+')'),id:x('each.value')}),dat('aws_vpc','runtime',{id:x(first+'.vpc_id')}),dat('aws_iam_role','invoker',{name:roleName}),dat('aws_kms_key','selected',{key_id:kms}),
      dat('aws_ecr_repository','model',{name:repository,registry_id:account}),dat('aws_ecr_image','model',{repository_name:repository,registry_id:account,image_digest:digest}),
      ...(artifact==='ARCHIVE'?[dat('aws_s3_bucket','model',{bucket})]:[]),
      dat('aws_vpc_endpoint_service','runtime',{service_name:'com.amazonaws.'+region+'.sagemaker.runtime'+(fips?'-fips':'')}),
      res('aws_security_group','runtime',{name:name+'-inference',description:'Approved private inference clients',vpc_id:x(first+'.vpc_id')},[blk('ingress',{protocol:'tcp',from_port:443,to_port:443,security_groups:clients})]),
      res('aws_vpc_endpoint','runtime',{vpc_id:x(first+'.vpc_id'),service_name:x('data.aws_vpc_endpoint_service.runtime.service_name'),vpc_endpoint_type:'Interface',subnet_ids:subnets,security_group_ids:x('[aws_security_group.runtime.id]'),private_dns_enabled:false,
        ...(!fips?{policy:x(jsonencode({Version:'2012-10-17',Statement:[{Effect:'Allow',Principal:{AWS:role},Action:'sagemaker:InvokeEndpoint',Resource:endpointArn}]}))}:{})},[
        blk('lifecycle',{},[blk('precondition',{condition:x('data.aws_caller_identity.current.account_id == '+JSON.stringify(account)+' && data.aws_iam_role.invoker.arn == '+JSON.stringify(role)+' && data.aws_kms_key.selected.arn == '+JSON.stringify(kms)+' && data.aws_kms_key.selected.enabled && data.aws_kms_key.selected.key_spec == "SYMMETRIC_DEFAULT" && data.aws_kms_key.selected.key_usage == "ENCRYPT_DECRYPT" && data.aws_kms_key.selected.key_manager == "CUSTOMER" && data.aws_vpc.runtime.enable_dns_support && length(distinct([for subnet in data.aws_subnet.runtime : subnet.vpc_id])) == 1 && length(distinct([for subnet in data.aws_subnet.runtime : subnet.availability_zone_id])) == '+subnets.length+' && alltrue([for subnet in data.aws_subnet.runtime : subnet.owner_id == data.aws_caller_identity.current.account_id && !subnet.map_public_ip_on_launch && !subnet.ipv6_native && subnet.available_ip_address_count >= 4]) && alltrue([for group in data.aws_security_group.clients : group.owner_id == data.aws_caller_identity.current.account_id && group.vpc_id == '+first+'.vpc_id]) && data.aws_ecr_repository.model.arn == '+JSON.stringify(repositoryArn)+' && data.aws_ecr_image.model.image_digest == '+JSON.stringify(digest)+(artifact==='ARCHIVE'?' && data.aws_s3_bucket.model.region == '+JSON.stringify(region):'')),error_message:'Require this account enabled customer key/role/image, DNS-enabled VPC, distinct owned private AZs/free IPs and approved client groups.'})]),
      ]),
      res('aws_cloudwatch_log_group','inference',{name:logName,kms_key_id:kms,retention_in_days:retention},[blk('lifecycle',{prevent_destroy:true})]),
      res('aws_iam_role','model',{name:name+'-model',assume_role_policy:x(jsonencode({Version:'2012-10-17',Statement:[{Effect:'Allow',Principal:{Service:'sagemaker.amazonaws.com'},Action:'sts:AssumeRole',Condition:{ArnLike:{'aws:SourceArn':'arn:'+partition+':sagemaker:'+region+':'+account+':*'}}}]}))}),
      res('aws_iam_role_policy','model',{name:name+'-model',role:x('aws_iam_role.model.name'),policy:x(jsonencode(executionPolicy))}),
      res('aws_iam_role_policy','invoke',{name:name+'-invoke',role:x('data.aws_iam_role.invoker.name'),policy:x(jsonencode({Version:'2012-10-17',Statement:[
        {Effect:'Allow',Action:['sagemaker:InvokeEndpoint'],Resource:endpointArn,Condition:{StringEquals:{'aws:SourceVpce':e('aws_vpc_endpoint.runtime.id')}}},
        {Effect:'Deny',Action:['sagemaker:InvokeEndpoint','sagemaker:InvokeEndpointAsync','sagemaker:InvokeEndpointWithResponseStream'],Resource:endpointArn,Condition:{StringNotEquals:{'aws:SourceVpce':e('aws_vpc_endpoint.runtime.id')}}},
        {Effect:'Deny',Action:['sagemaker:InvokeEndpointAsync','sagemaker:InvokeEndpointWithResponseStream'],Resource:endpointArn},
      ]}))}),
      res('aws_sagemaker_model','configured',{name:model,execution_role_arn:x('aws_iam_role.model.arn'),enable_network_isolation:true,depends_on:x('[aws_iam_role_policy.model, aws_cloudwatch_log_group.inference]')},[
        blk('primary_container',{image,mode:'SingleModel',...(artifact==='ARCHIVE'?{model_data_url:'s3://'+bucket+'/'+key}:{})}),blk('lifecycle',{create_before_destroy:true}),
      ]),
      res('aws_sagemaker_endpoint_configuration','configured',{name:model,kms_key_arn:kms},[
        blk('production_variants',{variant_name:'AllTraffic',model_name:x('aws_sagemaker_model.configured.name'),instance_type:instance,initial_instance_count:count,initial_variant_weight:1,volume_size_in_gb:volume,container_startup_health_check_timeout_in_seconds:startup,model_data_download_timeout_in_seconds:download,enable_ssm_access:false}),blk('lifecycle',{create_before_destroy:true}),
      ]),
      res('aws_sagemaker_endpoint','configured',{name,endpoint_config_name:x('aws_sagemaker_endpoint_configuration.configured.name')},[blk('lifecycle',{prevent_destroy:true})]),
      output('endpoint_name','aws_sagemaker_endpoint.configured.name'),output('runtime_vpce_id','aws_vpc_endpoint.runtime.id'),output('runtime_url','"https://${aws_vpc_endpoint.runtime.dns_entry[0].dns_name}"'),output('execution_role_arn','aws_iam_role.model.arn'),
      output('inference_job','{ vpce = aws_vpc_endpoint.runtime.id, url = "https://${aws_vpc_endpoint.runtime.dns_entry[0].dns_name}", group = aws_security_group.runtime.id }'),
    ],GUIDE,findings);
    return{...result,files:{...result.files,...awsSageMakerClients({region,partition,name,model,account,image,repository,digest,artifact,bucket,key,version,etag,kms,role,executionRole,endpointArn,modelArn,configArn,fips,instance,count,volume,startup,download,logName,retention,subnets,clients})}};
  },
}                   ;

const GUIDE=`# Isolated single-model CPU inference with private runtime access

## Qualify the image, artifact and boundary
Use an approved same-account/region private ECR x86 CPU image pinned by SHA256 digest. It must implement SageMaker's serve/8080, /ping and /invocations contracts and contain all required code/dependencies. No image is built, scanned or executed locally by this package. Review provenance, vulnerabilities, licenses, model behavior and resource sizing. Network isolation is always enabled: container has no outbound network or AWS credentials, while SageMaker still fetches approved images/model data separately. This recipe omits model VpcConfig; the client PrivateLink subnets place API interfaces, not model instances. It cannot host containers requiring outbound dependencies, training, notebooks, Marketplace acceptance, GPU/accelerators, serverless, async, multi-model, cross-region inference or streaming through this workflow.

Optional artifact mode requires an approved versioned private regional SSE-KMS .tar.gz object. Run PREFLIGHT.py before plan/apply: checks current HEAD version/ETag/key/region/public blocks and ECR digest metadata without downloading the archive/image. SageMaker's model URL cannot pin the supplied S3 version; the owner must enforce immutable-key controls through deployment/updates. Version/ETag checks are a point-in-time metadata check, not integrity/safety proof or protection against a later overwrite. Verify archive content, paths/links, model format and extracted space separately. Image-packaged mode grants no artifact-bucket access.

Review applicable civilian/DoD/State authorization/classification, allowed destination/transfer boundary, data/log/model/backup/key handling, STIG/SRG/cryptographic validation evidence, privacy/residency/records and interconnection requirements before deployment/data submission. Region/GovCloud/FIPS/network isolation are not ATO, APL, CDM, DoDIN or classification approval. Container code can log inputs/outputs; review its behavior, encrypted log retention and access. No data capture, core dump or SSM access is enabled here.

## IAM, key, network and costs
New execution role uses the service-required regional/account SageMaker SourceArn ending :*; AWS explicitly says not to replace this with one model or endpoint ARN for inference. Its data permissions are scoped to selected ECR repository, exact optional artifact, selected key and retained log group. It receives no SageMakerFullAccess or generic EC2/VPC permissions. Container network isolation does not authorize the model/image. Deployment identity needs reviewed iam:PassRole and KMS CreateGrant for endpoint volume encryption; key owner must allow required service/grant access and regional CloudWatch Logs encryption context. No shared KMS, bucket, repository, role trust or VPC route/DNS policies are overwritten.

The existing invoker role receives an exact-endpoint synchronous InvokeEndpoint allow from the created SourceVpce plus an explicit deny for inference outside it and unsupported async/stream modes on this endpoint. This affects that role's other policies for this endpoint; it is not an account-wide ban on every other identity. Review every other identity/resource policy that could invoke the endpoint. Standard runtime interface additionally restricts its endpoint policy; FIPS runtime endpoint policies are unsupported by AWS, so FIPS omits custom endpoint policy and relies on identity/network controls. GovCloud requires FIPS in this recipe; verify actual endpoint service/region support. Private DNS remains false: use the exported runtime_url with SDK signing and TLS certificate verification to avoid modifying shared VPC DNS. This path accepts clients on the selected same-VPC SGs over TCP443; on-prem CIDRs/proxy access need separate network design. Routes/NACLs and client credentials/egress stay owner-managed.

Hosting instances/volumes, interface endpoints, storage, logs and requests incur charges once applied, even with no invocation. Fixed1–4 instances is not an autoscaler, budget limit or an HA guarantee. Confirm capacity/regional quotas, model RAM/CPU/volume, serving latency and price quotes. KMS/log/bucket/repository prerequisites, controls and recovery copies need owners. Installing private runtime access does not by itself create private control-plane access; configure approved SageMaker/EC2/STS/KMS/IAM metadata paths separately where required.

## Deploy and check
Run PREFLIGHT.py with an approved metadata-reader identity, then terraform init/validate/plan -out=service.tfplan. Review existing invoker-role policy changes, model/container execution, capacity/costs, encryption, key grants and access boundaries. Apply only the reviewed plan. Endpoint creation actually starts model-serving compute; generation/local verification does not. Wait for InService and run CHECK.py in the approved network using the exported runtime URL. Metadata-reader permissions for exact endpoint/config/model and EC2 endpoint description are separate prerequisites; CHECK.py does not require or attach broad policies. It inspects actual endpoint/config/model/network-isolation and private access metadata by default; no inference payload is sent.

To make one approved billable pilot call use CHECK.py --invoke <approved-payload-file> --confirm-inference, optionally --output <new-approved-response-file>. Pilot payload is bounded to1MiB, retries disabled, response body is not printed and optional output uses exclusive creation. An ambiguous failure can still process/bill the request; inspect available execution/log evidence before repeating, with no idempotency guarantee. Input/output retention and semantic correctness need independent owner review. An InService endpoint or successful request is not application acceptance, security certification or model-quality assurance.

## Update, recovery and retirement
Increment release for image/artifact/hosting changes; model and configuration create before previous definitions are removed. Do not reuse an existing release name for a ForceNew change. Endpoint updates can replace serving capacity and incur overlap; review rollout/rollback and representative tests. Keep previous approved image digest/artifact/version and configuration evidence so owners can restore a prior reviewed release. No automatic canary or alarm-driven rollback is claimed. Endpoint/log prevent_destroy are Terraform guards, not service-side deletion locks. Deletion, log/backup retention, role-policy cleanup, recovery and source-model retirement require owner approval and explicit reviewed configuration. The package does not delete artifacts or change production clients automatically.

https://docs.aws.amazon.com/sagemaker/latest/dg/mkt-algo-model-internet-free.html
https://docs.aws.amazon.com/sagemaker/latest/dg/interface-vpc-endpoint.html
https://docs.aws.amazon.com/sagemaker/latest/dg/security_iam_id-based-policy-examples.html
https://docs.aws.amazon.com/sagemaker/latest/dg/security-confused-deputy-prevention.html
https://docs.aws.amazon.com/sagemaker/latest/dg/your-algorithms-inference-code.html
https://docs.aws.amazon.com/sagemaker/latest/dg/api-permissions-reference.html
`;
