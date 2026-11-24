import type {Blueprint} from '../kit/blueprint.ts';
import {error,type Finding} from '../core/findings.ts';
import {blk,dat,jsonencode,output,res,x} from '../terraform/blueprints/migration/common.ts';
import {awsServiceModule,awsServicePartition,awsServiceRegion} from './aws-service-module.ts';
import {awsEksPodIdentityFiles} from './aws-eks-pod-identity-files.ts';
const amis=['AL2023_x86_64_STANDARD','AL2_x86_64','BOTTLEROCKET_x86_64','BOTTLEROCKET_x86_64_FIPS'];
export const AWS_EKS_POD_IDENTITY_SERVICE={
  id:'aws_service_eks_pod_identity_s3',label:'Give one EKS service account private scoped S3 access',
  description:'Create a dedicated Pod Identity role and one association on an existing private-API EKS Linux managed node group; export owner-run checks and a credential-free smoke Job.',
  emits:['aws_iam_role','aws_iam_role_policy','aws_eks_pod_identity_association'],
  inputs:[
    awsServiceRegion,{id:'name',label:'Workload identity name',control:'text',hint:'Creates a new dedicated role; do not reuse an existing role name.'},
    {id:'cluster',label:'Existing EKS cluster ARN',control:'text',hint:'Existing ACTIVE private-API cluster, Kubernetes1.29+; this path does not create or change cluster access.'},
    {id:'nodegroup',label:'Existing EC2 Linux x86 managed node group',control:'text'},
    {id:'agent_version',label:'Installed Pod Identity Agent add-on version',control:'text',hint:'Record the approved compatible ACTIVE eks-pod-identity-agent version, such as v1.x.x-eksbuild.x. No add-on is installed or replaced.'},
    {id:'namespace',label:'Existing Kubernetes namespace',control:'text'},
    {id:'service_account',label:'Kubernetes service account name',control:'text',hint:'One new or existing owner-approved SA, with no IRSA role annotation or existing Pod Identity association. No Kubernetes changes run automatically.'},
    {id:'bucket',label:'Existing private S3 bucket',control:'text'},
    {id:'prefix',label:'Allowed S3 prefix',control:'text',default:'application/',hint:'Non-root prefix ending /, without a leading slash or wildcard.'},
    {id:'access',label:'S3 access',control:'select',default:'READ',options:[{value:'READ',label:'Read objects and prefix listing'},{value:'WRITE',label:'Read and put objects — no delete or ACL changes'}]},
    {id:'vpce',label:'Existing S3 VPC endpoint ID',control:'text',hint:'Approved S3 gateway/interface endpoint in the cluster VPC. This new role denies object/list calls outside that endpoint.'},
    {id:'kms',label:'Existing S3 customer KMS key ARN',control:'text',hint:'Optional for commercial SSE-S3; required in this GovCloud recipe. Key grants/policy and object encryption remain owner-managed.'},
    {id:'image',label:'Approved smoke-image ECR URI with SHA256 digest',control:'text',hint:'Same-account/region x86 Linux image with Python3, approved boto3/botocore1.35.0+ already installed and non-root UID1000 support. No image is built or pulled locally.'},
    {id:'endpoint',label:'Workload AWS API endpoints',control:'select',default:'STANDARD',options:[{value:'STANDARD',label:'Standard'},{value:'FIPS',label:'FIPS — supported US regions'}]},
  ],
  build(values):ReturnType<typeof awsServiceModule>{
    const findings:Finding[]=[],reject=(path:string,message:string)=>findings.push(error('aws.eks-pod-identity.'+path,message,{path}));
    const region=String(values.aws_region??''),partition=awsServicePartition(region),name=String(values.name??'').trim(),clusterArn=String(values.cluster??'').trim(),nodegroup=String(values.nodegroup??'').trim(),agentVersion=String(values.agent_version??'').trim(),namespace=String(values.namespace??'').trim(),serviceAccount=String(values.service_account??'').trim(),bucket=String(values.bucket??'').trim(),prefix=String(values.prefix??'').trim(),access=String(values.access??''),vpce=String(values.vpce??'').trim(),kms=String(values.kms??'').trim(),image=String(values.image??'').trim(),endpoint=String(values.endpoint??'');
    const match=/^arn:([^:]+):eks:([^:]+):(\d{12}):cluster\/([A-Za-z0-9][A-Za-z0-9_-]{0,99})$/.exec(clusterArn),account=match?.[3]??'',cluster=match?.[4]??'';
    if(!match||match[1]!==partition||match[2]!==region||!['aws','aws-us-gov'].includes(partition))reject('cluster','Enter the existing cluster ARN in the selected commercial/GovCloud account/region.');
    if(!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(name))reject('name','Use 1–40 lower-case letters/digits/internal hyphens.');
    if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(nodegroup))reject('nodegroup','Enter the existing managed EC2 Linux node-group name.');
    if(!/^v[1-9][0-9]*\.[0-9]+\.[0-9]+-eksbuild\.[1-9][0-9]*$/.test(agentVersion))reject('agent_version','Record the approved installed agent add-on version.');
    for(const [key,value]of [['namespace',namespace],['service_account',serviceAccount]]as const)if(!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value))reject(key,'Use a 1–63 character DNS label in this bounded workflow.');
    if(!/^(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)||bucket.includes('..'))reject('bucket','Enter the existing private bucket name.');
    if(!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\/$/.test(prefix)||prefix.length>900||prefix.split('/').some(part=>part==='.'||part==='..'))reject('prefix','Use a non-root prefix ending / without traversal, wildcard or leading slash.');
    if(!['READ','WRITE'].includes(access))reject('access','Choose read or read/put access.');
    if(!/^vpce-[0-9a-f]{17}$/.test(vpce))reject('vpce','Enter the approved existing S3 endpoint ID.');
    if(kms&&(!kms.startsWith('arn:'+partition+':kms:'+region+':'+account+':key/')||!/^arn:[^:]+:kms:[^:]+:\d{12}:key\/[0-9a-f-]+$/.test(kms)))reject('kms','Use the selected account/region customer key ARN.');
    if(partition==='aws-us-gov'&&!kms)reject('kms','This GovCloud recipe requires a selected customer key.');
    if(!image.startsWith(account+'.dkr.ecr.'+region+'.amazonaws.com/')||!/^\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9][a-z0-9._/-]+@sha256:[0-9a-f]{64}$/.test(image)||image.split('@')[0]!.includes('/../'))reject('image','Use an approved same-account/region private ECR image pinned by digest.');
    const fips=endpoint==='FIPS';
    if(!['STANDARD','FIPS'].includes(endpoint)||fips&&!['us-east-1','us-east-2','us-west-1','us-west-2','us-gov-east-1','us-gov-west-1'].includes(region)||partition==='aws-us-gov'&&!fips)reject('endpoint','Use a supported workload endpoint; GovCloud requires FIPS here. Agent EKS Auth/network configuration is a separate prerequisite.');
    const roleName=name+'-pod',roleArn='arn:'+partition+':iam::'+account+':role/'+roleName,bucketArn='arn:'+partition+':s3:::'+bucket,objects=bucketArn+'/'+prefix+'*';
    const trust={Version:'2012-10-17',Statement:[{Effect:'Allow',Principal:{Service:'pods.eks.amazonaws.com'},Action:['sts:AssumeRole','sts:TagSession'],Condition:{StringEquals:{'aws:RequestTag/eks-cluster-arn':clusterArn,'aws:RequestTag/kubernetes-namespace':namespace,'aws:RequestTag/kubernetes-service-account':serviceAccount}}}]};
    const policy={Version:'2012-10-17',Statement:[
      {Effect:'Allow',Action:['s3:GetBucketLocation'],Resource:bucketArn},
      {Effect:'Allow',Action:['s3:ListBucket'],Resource:bucketArn,Condition:{StringLike:{'s3:prefix':[prefix.slice(0,-1),prefix+'*']}}},
      {Effect:'Deny',Action:['s3:ListBucket'],NotResource:bucketArn},
      {Effect:'Deny',Action:['s3:ListBucket'],Resource:bucketArn,Condition:{StringNotLike:{'s3:prefix':[prefix.slice(0,-1),prefix+'*']}}},
      {Effect:'Allow',Action:['s3:GetObject',...(access==='WRITE'?['s3:PutObject']:[])],Resource:objects},
      {Effect:'Deny',Action:['s3:GetObject','s3:GetObjectVersion','s3:PutObject'],NotResource:objects},
      {Effect:'Deny',Action:['s3:GetObject','s3:GetObjectVersion','s3:PutObject','s3:ListBucket'],Resource:[bucketArn,objects],Condition:{StringNotEquals:{'aws:SourceVpce':vpce}}},
      {Effect:'Deny',Action:['s3:DeleteObject','s3:DeleteObjectVersion','s3:PutObjectAcl'],Resource:'*'},
      ...(access==='READ'?[{Effect:'Deny',Action:['s3:PutObject'],Resource:'*'}]:[]),
      ...(kms?[
        {Effect:'Allow',Action:['kms:DescribeKey'],Resource:kms},
        {Effect:'Allow',Action:['kms:Decrypt',...(access==='WRITE'?['kms:GenerateDataKey']:[])],Resource:kms,Condition:{StringEquals:{'kms:ViaService':'s3.'+region+'.amazonaws.com'},StringLike:{'kms:EncryptionContext:aws:s3:arn':[bucketArn,objects]}}},
      ]:[]),
    ]};
    const config={region,partition,name,cluster,clusterArn,account,nodegroup,agentVersion,namespace,serviceAccount,bucket,prefix,access,vpce,kms,image,fips,roleName,roleArn,trust,policy,amis};
    const result=awsServiceModule(region,[
      dat('aws_caller_identity','current',{}),dat('aws_eks_cluster','selected',{name:cluster}),dat('aws_eks_node_group','selected',{cluster_name:cluster,node_group_name:nodegroup}),dat('aws_eks_addon','agent',{cluster_name:cluster,addon_name:'eks-pod-identity-agent'}),dat('aws_s3_bucket','selected',{bucket}),dat('aws_vpc_endpoint','s3',{id:vpce}),...(kms?[dat('aws_kms_key','selected',{key_id:kms})]:[]),
      res('aws_iam_role','workload',{name:roleName,assume_role_policy:x(jsonencode(trust))},[blk('lifecycle',{prevent_destroy:true},[blk('precondition',{condition:x('data.aws_caller_identity.current.account_id == '+JSON.stringify(account)+' && data.aws_eks_cluster.selected.arn == '+JSON.stringify(clusterArn)+' && data.aws_eks_cluster.selected.status == "ACTIVE" && tonumber(split(".",data.aws_eks_cluster.selected.version)[0]) == 1 && tonumber(split(".",data.aws_eks_cluster.selected.version)[1]) >= 29 && data.aws_eks_cluster.selected.vpc_config[0].endpoint_private_access && !data.aws_eks_cluster.selected.vpc_config[0].endpoint_public_access && data.aws_eks_node_group.selected.status == "ACTIVE" && contains('+JSON.stringify(amis)+',data.aws_eks_node_group.selected.ami_type) && data.aws_eks_addon.agent.addon_version == '+JSON.stringify(agentVersion)+' && data.aws_s3_bucket.selected.region == '+JSON.stringify(region)+' && data.aws_vpc_endpoint.s3.vpc_id == data.aws_eks_cluster.selected.vpc_config[0].vpc_id && contains('+JSON.stringify(['com.amazonaws.'+region+'.s3','com.amazonaws.'+region+'.s3-fips'])+',data.aws_vpc_endpoint.s3.service_name)'+(kms?' && data.aws_kms_key.selected.arn == '+JSON.stringify(kms)+' && data.aws_kms_key.selected.enabled && data.aws_kms_key.selected.key_spec == "SYMMETRIC_DEFAULT" && data.aws_kms_key.selected.key_manager == "CUSTOMER"':'')),error_message:'Require this account active private cluster/Linux x86 managed node group/installed agent, regional bucket and same-VPC S3 endpoint/customer key.'})])]),
      res('aws_iam_role_policy','s3',{name:name+'-s3',role:x('aws_iam_role.workload.name'),policy:x(jsonencode(policy))}),
      res('aws_eks_pod_identity_association','workload',{cluster_name:cluster,namespace,service_account:serviceAccount,role_arn:x('aws_iam_role.workload.arn'),depends_on:x('[aws_iam_role_policy.s3]')},[blk('lifecycle',{prevent_destroy:true})]),
      output('pod_identity_job','{ id = aws_eks_pod_identity_association.workload.association_id, arn = aws_eks_pod_identity_association.workload.association_arn, role = aws_iam_role.workload.arn }'),
    ],GUIDE,findings);
    return{...result,files:{...result.files,...awsEksPodIdentityFiles(config)}};
  },
}satisfies Blueprint;

const GUIDE=`# EKS Pod Identity for one private scoped S3 workload

## Existing cluster, node and network prerequisites
Use an existing ACTIVE Kubernetes1.29+ private-API EKS cluster and ACTIVE EC2 Linux x86 managed node group with an approved compatible ACTIVE eks-pod-identity-agent add-on. This recipe does not create/update a cluster, add-on, node role, node image, Kubernetes namespace or shared network. Auto Mode, Fargate, Windows, hybrid/self-managed/ARM nodes, cross-account roles, IRSA, target-role chaining and application migration remain separate workflows. Existing node role must authorize eks-auth:AssumeRoleForPodIdentity; private nodes need EKS Auth PrivateLink, approved ECR image pulling, DNS/STS/S3/key routes and relevant SG/NACL/NetworkPolicy rules. Agent listens on IPv4 and IPv6; nodes with IPv6 loopback disabled need the separately reviewed agent IPv6 configuration. Confirm the agent is healthy on the selected nodes, not merely add-on ACTIVE metadata.

Choose the existing approved S3 gateway/interface endpoint in this cluster's VPC. Data calls are explicitly denied outside it; confirm endpoint policy, DNS/routing and FIPS behavior where required. Workload SDK FIPS mode does not configure the agent's EKS Auth endpoint or prove cryptographic-module validation. GovCloud requires workload FIPS and a customer key in this bounded recipe. Verify actual region/agent/endpoint support and applicable data authorization/classification, allowed boundary, STIG/SRG/crypto evidence, privacy/records/residency, key/log/backup/CDM/APL/interconnection requirements with owners. No certification/ATO/classification or account-wide authorization is inferred.

## Identity and data boundaries
Use one owner-approved namespace/service account with no existing Pod Identity association or IRSA role annotation. Run PREFLIGHT.py --context <approved-kubectl-context> before Terraform: context must use the actual AWS cluster API endpoint with TLS verification, then SA metadata is read. Existing SA RBAC/admission/workload ownership remains owner-managed. Example SA YAML is for reviewed creation only if absent; do not blindly apply it to an existing account. No static AWS keys, tokens, private kubeconfig credentials or IAM user are generated, printed or stored here.

New dedicated role trusts pods.eks.amazonaws.com for AssumeRole/TagSession only with exact cluster ARN/namespace/SA request tags. Tags must remain enabled (provider5 cannot model the newer disable-session-tags/target-role fields; CHECK.py rejects disabled tags/chaining). Prefix permissions are read/list or read/put; explicit object denies bound access to the prefix/selected endpoint, and deletes/ACL changes are denied. READ additionally denies writes. No shared role/trust/bucket/key/endpoint policy is changed. Review all effective resource/identity policies: this is not a complete bucket-account policy audit. KMS cryptographic access is limited to S3 in the selected region and the approved bucket/prefix encryption context; DescribeKey is separate. S3 Bucket Keys use the bucket ARN context, so prefix enforcement still relies on the explicit S3 denies, not a prefix-specific bucket-key claim. Other effective key/resource policies remain owner-reviewed. Selected KMS access/default bucket encryption and existing-object keys are owner prerequisites; defaults do not prove every object uses that key. Backups/Object Lock/retention/application semantics need owners.

## Build and verify association
Run preflight, terraform init/validate and plan -out=service.tfplan. Review the new role, exact namespace/SA mapping, data actions/key/endpoint and irreversible operational effects before applying the saved plan. No Kubernetes manifest is applied and no S3 object is read/written by generation or Terraform. Preflight refuses existing associations instead of replacing/importing them. After apply run CHECK.py --context <approved-context> to compare exact applied association/role trust/inline policy and infrastructure metadata. Existing approved IAM/EKS/S3/EC2/KMS metadata permissions and Kubernetes read access are prerequisites; no broad administrator policy is attached.

## Explicit workload smoke test
Use the approved digest-pinned x86 image with Python3 and current approved boto3/botocore1.35.0+ preinstalled and non-root UID1000/read-only-root support. Pod Identity's minimum SDK is1.34.41; this probe uses1.35.0+ for conditional puts. Review smoke-job.yaml (ConfigMap and Job) and service-account.example.yaml. Use server dry-run/admission review, then explicitly create only approved Kubernetes objects in the selected context/namespace. Job selects the given managed node group, never uses host networking/privileged mode, has bounded resources/deadline/no retries and does not create RBAC. It retains results for owner evidence/cleanup. Existing SA permissions/admission can still affect a pod; review them independently.

Default CLIENT.py in the Job only verifies container-role credential provider and expected STS role; no S3 request is made. It requires canonical EKS injected credential URI/token-file path, rejects static/IRSA/profile credential overrides and disables IMDS fallback. No tokens/keys/credential response is printed. Default SDK credential-chain precedence can otherwise silently use old/static/node identities; verify the actual running Job/environment/agent, not just an association record. Token/IMDS/network/RBAC controls are not automatic pod isolation.

For a separately approved object metadata check, run CLIENT.py --head <relative-key> inside the workload; it requests HEAD only under the configured prefix, not the object body. WRITE mode optionally supports CLIENT.py --put-test --confirm-write: creates one UUID synthetic probe object with IfNoneMatch and selected SSE-KMS where configured. It never deletes/overwrites objects and leaves the probe for approved retention/owner cleanup. No automatic application copy, bulk/multipart transfer, identity migration or real data test is claimed. One SDK attempt; inspect ambiguous request results before manually repeating. Data/metadata handling, object integrity, effective permissions and application acceptance need independent tests.

## Recovery and lifecycle
Keep the previous reviewed workload/identity configuration and source data. Association/role prevent_destroy is a Terraform guard, not immediate credential revocation or a service-side deletion lock. Pods/agents can cache temporary credentials; changing/removing mappings/policies does not guarantee immediate invalidation. Rollback/revocation, pod replacement, logs/evidence, probe cleanup and role/SA retirement require owners and tested propagation assumptions. Do not delete a shared SA, add-on or cluster to reverse this integration.

https://docs.aws.amazon.com/eks/latest/userguide/pod-id-role.html
https://docs.aws.amazon.com/eks/latest/userguide/pod-id-abac.html
https://docs.aws.amazon.com/eks/latest/userguide/pod-id-agent-setup.html
https://docs.aws.amazon.com/eks/latest/userguide/pod-id-minimum-sdk.html
https://docs.aws.amazon.com/eks/latest/userguide/pod-id-how-it-works.html
`;
