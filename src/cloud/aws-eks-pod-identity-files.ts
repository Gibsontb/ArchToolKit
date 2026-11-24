type PodConfig=Record<'region'|'partition'|'name'|'cluster'|'clusterArn'|'account'|'nodegroup'|'agentVersion'|'namespace'|'serviceAccount'|'bucket'|'prefix'|'access'|'vpce'|'kms'|'image'|'roleName'|'roleArn',string>&{fips:boolean;trust:unknown;policy:unknown;amis:string[]};
export function awsEksPodIdentityFiles(config:PodConfig):Record<string,string>{
  const files:Record<string,string>={'WORKLOAD-CONFIG.json':JSON.stringify(config,null,2)+'\n','CLIENT.py':CLIENT,'PREFLIGHT.py':OPERATOR,'CHECK.py':OPERATOR};
  const metadata={namespace:config.namespace};
  // Stable content-versioned name avoids mounting an older probe ConfigMap.
  // This labels configuration revisions; it is not a cryptographic integrity claim.
  let revision=14695981039346656037n;
  for(const char of files['WORKLOAD-CONFIG.json']!+CLIENT)revision=BigInt.asUintN(64,(revision^BigInt(char.charCodeAt(0)))*1099511628211n);
  const configMapName=config.name+'-probe-'+revision.toString(16).padStart(16,'0');
  files['service-account.example.yaml']=JSON.stringify({apiVersion:'v1',kind:'ServiceAccount',metadata:{...metadata,name:config.serviceAccount}},null,2)+'\n';
  const configMap={apiVersion:'v1',kind:'ConfigMap',metadata:{...metadata,name:configMapName},immutable:true,data:{'CLIENT.py':CLIENT,'WORKLOAD-CONFIG.json':files['WORKLOAD-CONFIG.json']}};
  const job={apiVersion:'batch/v1',kind:'Job',metadata:{...metadata,generateName:config.name+'-probe-'},spec:{backoffLimit:0,activeDeadlineSeconds:120,template:{spec:{serviceAccountName:config.serviceAccount,nodeSelector:{'kubernetes.io/os':'linux','eks.amazonaws.com/nodegroup':config.nodegroup},hostNetwork:false,restartPolicy:'Never',securityContext:{runAsNonRoot:true,runAsUser:1000,runAsGroup:1000,seccompProfile:{type:'RuntimeDefault'}},containers:[{name:'probe',image:config.image,imagePullPolicy:'IfNotPresent',command:['python3','/workload/CLIENT.py'],env:[{name:'AWS_REGION',value:config.region},{name:'AWS_DEFAULT_REGION',value:config.region},{name:'AWS_EC2_METADATA_DISABLED',value:'true'},{name:'PYTHONDONTWRITEBYTECODE',value:'1'},{name:'HOME',value:'/tmp'}],securityContext:{allowPrivilegeEscalation:false,readOnlyRootFilesystem:true,capabilities:{drop:['ALL']}},resources:{requests:{cpu:'100m',memory:'128Mi'},limits:{cpu:'250m',memory:'256Mi'}},volumeMounts:[{name:'workload',mountPath:'/workload',readOnly:true},{name:'tmp',mountPath:'/tmp'}]}],volumes:[{name:'workload',configMap:{name:config.name+'-probe'}},{name:'tmp',emptyDir:{sizeLimit:'16Mi'}}]}}}};
  job.spec.template.spec.volumes[0]!.configMap!.name=configMapName;
  files['smoke-job.yaml']=JSON.stringify(configMap,null,2)+'\n---\n'+JSON.stringify(job,null,2)+'\n';
  return files;
}
const CLIENT=[
  'import argparse, json, os, pathlib, re, uuid',
  'import boto3, botocore',
  'from botocore.config import Config',
  'parser=argparse.ArgumentParser(description="Identity only by default; explicit prefix metadata/synthetic write probes")',
  'mode=parser.add_mutually_exclusive_group(); mode.add_argument("--head"); mode.add_argument("--put-test",action="store_true"); parser.add_argument("--confirm-write",action="store_true"); args=parser.parse_args()',
  'config=json.loads((pathlib.Path(__file__).resolve().parent/"WORKLOAD-CONFIG.json").read_text())',
  'for module in [boto3,botocore]:',
  '    version=re.match(r"([0-9]+)[.]([0-9]+)[.]([0-9]+)",module.__version__)',
  '    if not version or tuple(map(int,version.groups()))<(1,35,0): raise RuntimeError("Use the approved current SDK image, boto3/botocore1.35.0+ with conditional-put support")',
  'if any(os.environ.get(key) for key in ["AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY","AWS_SESSION_TOKEN","AWS_WEB_IDENTITY_TOKEN_FILE","AWS_ROLE_ARN","AWS_PROFILE","AWS_DEFAULT_PROFILE","AWS_SHARED_CREDENTIALS_FILE"]): raise RuntimeError("Remove earlier static/IRSA/profile credential providers; no credential value is printed")',
  'if os.environ.get("AWS_EC2_METADATA_DISABLED","").lower()!="true": raise RuntimeError("Disable IMDS fallback for this probe")',
  'if os.environ.get("AWS_CONTAINER_CREDENTIALS_FULL_URI") not in ["http://169.254.170.23/v1/credentials","http://[fd00:ec2::23]/v1/credentials"] or os.environ.get("AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE")!="/var/run/secrets/pods.eks.amazonaws.com/serviceaccount/eks-pod-identity-token": raise RuntimeError("Require canonical injected EKS Pod Identity provider endpoints/token path")',
  'session=boto3.Session(region_name=config["region"]); options=Config(retries={"total_max_attempts":1,"mode":"standard"},use_fips_endpoint=config["fips"])',
  'try: credentials=session.get_credentials()',
  'except Exception: raise RuntimeError("Pod credentials unavailable; inspect approved agent/network diagnostics without printing tokens") from None',
  'if credentials is None or credentials.method!="container-role": raise RuntimeError("Expected container-role provider, not node/static/IRSA fallback")',
  'try: caller=session.client("sts",config=options).get_caller_identity()',
  'except Exception: raise RuntimeError("Pod identity check failed; credential/error details are suppressed") from None',
  'expected="arn:"+config["partition"]+":sts::"+config["account"]+":assumed-role/"+config["roleName"]+"/"',
  'if caller.get("Account")!=config["account"] or not caller.get("Arn","").startswith(expected): raise RuntimeError("Unexpected workload role; no keys/tokens are printed")',
  'if not args.head and not args.put_test: print(json.dumps({"identity_checked":True,"role":config["roleArn"],"s3_request_sent":False})); raise SystemExit(0)',
  's3=session.client("s3",config=options)',
  'if args.head:',
  '    relative=args.head',
  '    if relative.startswith("/") or any(part in ["",".",".."] for part in relative.split("/")) or any(ord(char)<32 for char in relative) or len((config["prefix"]+relative).encode())>1024: raise RuntimeError("Use an approved relative object key within the prefix")',
  '    try: head=s3.head_object(Bucket=config["bucket"],Key=config["prefix"]+relative,ExpectedBucketOwner=config["account"])',
  '    except Exception: raise RuntimeError("Approved object metadata request failed; details suppressed") from None',
  '    print(json.dumps({"head_checked":True,"content_length":head.get("ContentLength"),"object_body_read":False})); raise SystemExit(0)',
  'if config["access"]!="WRITE" or not args.confirm_write: raise RuntimeError("Synthetic write requires WRITE mode and --confirm-write after retention/data-owner review")',
  'if "IfNoneMatch" not in s3.meta.service_model.operation_model("PutObject").input_shape.members: raise RuntimeError("Approved image SDK must support conditional PutObject")',
  'key=config["prefix"]+"pod-identity-probe-"+uuid.uuid4().hex+".txt"',
  'request={"Bucket":config["bucket"],"Key":key,"ExpectedBucketOwner":config["account"],"Body":b"ArchToolKit synthetic Pod Identity probe","ContentType":"text/plain","IfNoneMatch":"*"}',
  'if config["kms"]: request.update(ServerSideEncryption="aws:kms",SSEKMSKeyId=config["kms"])',
  'try: result=s3.put_object(**request)',
  'except Exception: raise RuntimeError("Synthetic write failed or outcome is ambiguous; investigate before repeating, with no automatic retry") from None',
  'print(json.dumps({"synthetic_object_created":True,"key":key,"version_id":result.get("VersionId"),"deleted":False,"application_acceptance_verified":False}))',
].join('\n')+'\n';

const OPERATOR=[
  'import argparse, json, pathlib, re, subprocess',
  'import boto3',
  'from botocore.config import Config',
  'parser=argparse.ArgumentParser(description="Read-only preflight or applied association check; no Kubernetes writes")',
  'parser.add_argument("--context"); args=parser.parse_args()',
  'config=json.loads((pathlib.Path(__file__).resolve().parent/"WORKLOAD-CONFIG.json").read_text()); applied=pathlib.Path(__file__).name=="CHECK.py"',
  'session=boto3.Session(region_name=config["region"]); options=Config(retries={"total_max_attempts":1,"mode":"standard"},use_fips_endpoint=config["fips"])',
  'if session.client("sts",config=options).get_caller_identity()["Account"]!=config["account"]: raise RuntimeError("Unexpected operator account")',
  'eks=session.client("eks",config=options); cluster=eks.describe_cluster(name=config["cluster"])["cluster"]',
  'version=cluster.get("version","").split("."); network=cluster.get("resourcesVpcConfig",{})',
  'if cluster.get("arn")!=config["clusterArn"] or cluster.get("status")!="ACTIVE" or len(version)!=2 or version[0]!="1" or not version[1].isdigit() or int(version[1])<29 or network.get("endpointPrivateAccess") is not True or network.get("endpointPublicAccess") is not False or cluster.get("computeConfig",{}).get("enabled"): raise RuntimeError("Require exact ACTIVE private-API1.29+ non-AutoMode cluster")',
  'nodes=eks.describe_nodegroup(clusterName=config["cluster"],nodegroupName=config["nodegroup"])["nodegroup"]',
  'if nodes.get("clusterName")!=config["cluster"] or nodes.get("nodegroupName")!=config["nodegroup"] or nodes.get("status")!="ACTIVE" or nodes.get("amiType") not in config["amis"]: raise RuntimeError("Require selected ACTIVE EC2 Linux x86 managed node group")',
  'agent=eks.describe_addon(clusterName=config["cluster"],addonName="eks-pod-identity-agent")["addon"]',
  'if agent.get("addonName")!="eks-pod-identity-agent" or agent.get("status")!="ACTIVE" or agent.get("addonVersion")!=config["agentVersion"] or agent.get("health",{}).get("issues"): raise RuntimeError("Require approved ACTIVE healthy installed Pod Identity agent version")',
  'endpoints=session.client("ec2",config=options).describe_vpc_endpoints(VpcEndpointIds=[config["vpce"]])["VpcEndpoints"]',
  'if len(endpoints)!=1 or endpoints[0].get("VpcEndpointId")!=config["vpce"] or endpoints[0].get("State")!="available" or endpoints[0].get("VpcId")!=network.get("vpcId") or endpoints[0].get("ServiceName") not in ["com.amazonaws."+config["region"]+".s3","com.amazonaws."+config["region"]+".s3-fips"]: raise RuntimeError("Require actual available S3 endpoint in cluster VPC")',
  's3=session.client("s3",config=options); owner={"Bucket":config["bucket"],"ExpectedBucketOwner":config["account"]}',
  'region=s3.get_bucket_location(**owner).get("LocationConstraint") or "us-east-1"',
  'if ("eu-west-1" if region=="EU" else region)!=config["region"]: raise RuntimeError("Bucket region differs")',
  'blocks=s3.get_public_access_block(**owner)["PublicAccessBlockConfiguration"]',
  'if not all(blocks.get(key) is True for key in ["BlockPublicAcls","IgnorePublicAcls","BlockPublicPolicy","RestrictPublicBuckets"]): raise RuntimeError("Require all four private-bucket public blocks")',
  'if config["kms"]:',
  '    key=session.client("kms",config=options).describe_key(KeyId=config["kms"])["KeyMetadata"]',
  '    if key.get("Arn")!=config["kms"] or key.get("KeyState")!="Enabled" or key.get("KeyManager")!="CUSTOMER" or key.get("KeySpec")!="SYMMETRIC_DEFAULT" or key.get("KeyUsage")!="ENCRYPT_DECRYPT": raise RuntimeError("Require exact enabled symmetric customer key")',
  'if args.context:',
  '    def kube(arguments):',
  '        try: return subprocess.check_output(["kubectl","--context",args.context]+arguments,text=True,timeout=30,stderr=subprocess.PIPE).strip()',
  '        except (subprocess.SubprocessError,OSError): raise RuntimeError("Read-only Kubernetes context check failed; inspect approved local diagnostics") from None',
  '    server=kube(["config","view","--minify","-o","jsonpath={.clusters[0].cluster.server}"])',
  '    insecure=kube(["config","view","--minify","-o","jsonpath={.clusters[0].cluster.insecure-skip-tls-verify}"])',
  '    if server!=cluster.get("endpoint") or insecure.lower()=="true": raise RuntimeError("Kubectl context must use actual selected API endpoint with TLS verification")',
  '    account=json.loads(kube(["get","serviceaccount",config["serviceAccount"],"--namespace",config["namespace"],"-o","json"]))',
  '    metadata=account.get("metadata",{})',
  '    if metadata.get("name")!=config["serviceAccount"] or metadata.get("namespace")!=config["namespace"] or metadata.get("annotations",{}).get("eks.amazonaws.com/role-arn"): raise RuntimeError("Require exact owner-approved SA without IRSA role annotation")',
  'iam=session.client("iam",config=options)',
  'if not applied:',
  '    existing=eks.list_pod_identity_associations(clusterName=config["cluster"],namespace=config["namespace"],serviceAccount=config["serviceAccount"],maxResults=2)',
  '    if existing.get("associations") or existing.get("nextToken"): raise RuntimeError("Existing association requires separate owner adoption/replacement; this recipe does not take it over")',
  'else:',
  '    job=json.loads(subprocess.check_output(["terraform","output","-json","pod_identity_job"],text=True))',
  '    if job.get("role")!=config["roleArn"] or not isinstance(job.get("id"),str) or not job["id"]: raise RuntimeError("Unexpected applied association identity")',
  '    association=eks.describe_pod_identity_association(clusterName=config["cluster"],associationId=job["id"])["association"]',
  '    expected={"associationId":job["id"],"associationArn":job["arn"],"clusterName":config["cluster"],"namespace":config["namespace"],"serviceAccount":config["serviceAccount"],"roleArn":config["roleArn"]}',
  '    if any(association.get(key)!=value for key,value in expected.items()) or association.get("disableSessionTags",False) or association.get("targetRoleArn"): raise RuntimeError("Association differs or unsupported disabled session tags/role chaining")',
  '    role=iam.get_role(RoleName=config["roleName"])["Role"]',
  '    if role.get("Arn")!=config["roleArn"] or role.get("AssumeRolePolicyDocument")!=config["trust"]: raise RuntimeError("Workload role trust differs")',
  '    if iam.get_role_policy(RoleName=config["roleName"],PolicyName=config["name"]+"-s3").get("PolicyDocument")!=config["policy"]: raise RuntimeError("Workload inline data policy differs")',
  'print(json.dumps({"metadata_checked":True,"association_checked":applied,"kubernetes_sa_checked":bool(args.context),"actual_pod_credentials_or_s3_data_access_proven":False,"kubernetes_or_data_writes":False}))',
].join('\n')+'\n';
