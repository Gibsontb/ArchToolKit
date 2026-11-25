                                                   
import {error,            } from '../core/findings.js';
import {blk,output,res,x} from '../terraform/blueprints/migration/common.js';
import {renderFile} from '../terraform/hcl.js';
import {awsServiceModule,awsServiceRegion} from './aws-service-module.js';
import {AWS_DSQL_SERVICE,buildDsqlRegional} from './aws-dsql-service.js';
const regions=['us-east-1','us-east-2','us-west-2'];
export const AWS_DSQL_MULTIREGION_SERVICE={
  id:'aws_service_dsql_private_pair',label:'Stage two active Aurora DSQL peers with a distinct witness and private endpoints',
  description:'New logical database across two peer regions plus encrypted-log witness, regional customer keys/private endpoints and explicit policy/SQL approval. Existing regional owned networks and one approved application role.',
  emits:[...AWS_DSQL_SERVICE.emits,'aws_dsql_cluster_peering'],
  inputs:[awsServiceRegion,...AWS_DSQL_SERVICE.inputs.filter(input=>!['aws_region','kms','subnets','clients'].includes(input.id)),
    {id:'peer_region',label:'Second active peer region',control:'select',default:'us-west-2',options:regions.map(value=>({value,label:value}))},
    {id:'witness_region',label:'Encrypted transaction-log witness region',control:'select',default:'us-east-2',options:regions.map(value=>({value,label:value})),hint:'All three regions must be distinct and authorized; witness stores encrypted transaction logs, not a data-free location.'},
    {id:'kms',label:'Primary region customer key ARN',control:'text'},
    {id:'subnets',label:'Primary region private endpoint subnet IDs',control:'text'},
    {id:'clients',label:'Primary region permitted client security group IDs',control:'text'},
    {id:'peer_kms',label:'Second peer region customer key ARN',control:'text'},
    {id:'peer_subnets',label:'Second peer region private endpoint subnet IDs',control:'text'},
    {id:'peer_clients',label:'Second peer region permitted client security group IDs',control:'text'},
  ],
  build(values)                                    {
    const primaryRegion=String(values.aws_region??''),peerRegion=String(values.peer_region??''),witnessRegion=String(values.witness_region??''),account=String(values.account??'').trim();
    const findings          =[];
    if(!regions.includes(peerRegion)||peerRegion===primaryRegion)findings.push(error('aws.dsql.pair.peer','Choose a supported peer region distinct from the primary.',{path:'peer_region'}));
    if(!regions.includes(witnessRegion)||new Set([primaryRegion,peerRegion,witnessRegion]).size!==3)findings.push(error('aws.dsql.pair.witness','Choose a third distinct supported and approved witness region.',{path:'witness_region'}));
    const primary=buildDsqlRegional(values,{witnessRegion,peerRegion});
    const secondary=buildDsqlRegional({...values,aws_region:peerRegion,kms:values.peer_kms,subnets:values.peer_subnets,clients:values.peer_clients},{witnessRegion,peerRegion:primaryRegion});
    findings.push(...primary.findings,...secondary.findings.map(f=>({...f,path:({aws_region:'peer_region',kms:'peer_kms',subnets:'peer_subnets',clients:'peer_clients'}                         )[f.path??'']??f.path})));
    const resources=[...(['primary','secondary']         ).map((alias,index)=>blk('provider',{alias,region:index?peerRegion:primaryRegion,use_fips_endpoint:true,allowed_account_ids:[account]},[],['aws'])),
      ...(['primary','secondary']         ).map(site=>blk('module',{source:'./'+site,providers:x('{ aws = aws.'+site+', aws.database = aws.'+site+' }')},[],[site])),
      // Both operations must run concurrently: each native waiter waits for BOTH reciprocal associations.
      res('aws_dsql_cluster_peering','primary',{provider:x('aws.primary'),identifier:x('module.primary.cluster_id'),clusters:x('[module.secondary.cluster_arn]'),witness_region:witnessRegion},[blk('lifecycle',{prevent_destroy:true})]),
      res('aws_dsql_cluster_peering','secondary',{provider:x('aws.secondary'),identifier:x('module.secondary.cluster_id'),clusters:x('[module.primary.cluster_arn]'),witness_region:witnessRegion},[blk('lifecycle',{prevent_destroy:true})]),
      ...(['primary','secondary']         ).flatMap(site=>['cluster_id','cluster_arn','connection_endpoint_id','private_database_hostname'].map(field=>output(site+'_'+field,'module.'+site+'.'+field))),output('witness_region',JSON.stringify(witnessRegion)),
    ];
    const result=awsServiceModule(primaryRegion,resources,GUIDE,findings),files                      ={...result.files,'CHECK-PAIR.py':PAIR};
    const childVersion=renderFile([blk('terraform',{},[blk('required_providers',{aws:x('{ source = "hashicorp/aws", version = "~> 5.0", configuration_aliases = [aws.database] }')})])]);
    for(const [site,component]of [['primary',primary],['secondary',secondary]]         ){
      for(const [path,body]of Object.entries(component.files))if(!['providers.tf','versions.tf','README.md','SERVICE-SETUP.md'].includes(path))files[site+'/'+path]=body;
      files[site+'/versions.tf']=childVersion;
      files[site+'/README.md']='# Regional component\n\nApply only the parent root module. Do not apply/import/destroy this component independently. Use parent SERVICE-SETUP.md and MIGRATION-OPERATIONS.md.\n';
    }
    const operations=primary.files['SERVICE-SETUP.md']??'';
    files['MIGRATION-OPERATIONS.md']='# Shared logical database operations\n\nBootstrap SQL roles/schema ONCE after both network boundaries are approved. Do not load the same logical dataset twice through the two peers.\n\n'+operations.slice(operations.indexOf('Application authorization requires'));
    files['MULTIREGION-CONFIG.json']=JSON.stringify({primaryRegion,peerRegion,witnessRegion,account,name:String(values.name??'')},null,2)+'\n';
    return {...result,files};
  },
}                    ;

const PAIR=String.raw`import argparse
import json
from pathlib import Path
import re
import subprocess
import sys

def main():
    parser=argparse.ArgumentParser(description='Read-only checks for BOTH new DSQL peers and their exact reciprocal/witness/network metadata')
    parser.add_argument('--preflight',action='store_true')
    parser.add_argument('--primary-cluster')
    parser.add_argument('--secondary-cluster')
    parser.add_argument('--primary-endpoint')
    parser.add_argument('--secondary-endpoint')
    parser.add_argument('--emit-policy-review',action='store_true')
    args=parser.parse_args()
    ids=[args.primary_cluster,args.secondary_cluster,args.primary_endpoint,args.secondary_endpoint]
    if args.preflight:
        if any(ids) or args.emit_policy_review:
            parser.error('Preflight accepts no deployed IDs or policy output flag')
    elif not all(ids) or not all(re.fullmatch(r'[a-z0-9]{26}',value) for value in ids[:2]) or not all(re.fullmatch(r'vpce-(?:[0-9a-f]{8}|[0-9a-f]{17})',value) for value in ids[2:]):
        parser.error('Supply exact BOTH cluster IDs and BOTH endpoint IDs from root outputs')
    root=Path(__file__).resolve().parent
    result={}
    for site,cluster,peer,endpoint in [('primary',args.primary_cluster,args.secondary_cluster,args.primary_endpoint),('secondary',args.secondary_cluster,args.primary_cluster,args.secondary_endpoint)]:
        command=[sys.executable,str(root/site/'INSPECT.py')]
        if not args.preflight:
            command+=['--cluster',cluster,'--peer-cluster',peer,'--endpoint',endpoint]
            if args.emit_policy_review:
                command+=['--emit-policy-review']
        check=subprocess.run(command,capture_output=True,text=True)
        if check.returncode!=0:
            raise RuntimeError(site+' metadata inspection failed; run that exact regional INSPECT.py inside the approved diagnostic boundary. No SQL/policy change requested.')
        result[site]=check.stdout.strip() if args.preflight else json.loads(check.stdout)
    result.update({'bothComponentChecksPassed':True,'atomicSnapshotProven':False,'logicalDatabaseIntegrityProven':False,'ownerTrafficFailoverSqlApprovalRequired':True})
    print(json.dumps(result,indent=2))

if __name__=='__main__':
    main()
`;

const GUIDE=`# New Aurora DSQL multi-Region private pair

One logical database with TWO new active peer clusters and a THIRD distinct witness region. Initial qualified region set US east1/east2/west2, all three selected explicitly. Both peer regions need owner-approved customer symmetric keys (ordinary or multi-Region KMS key ARNs), existing owned private2AZ subnet pairs/client groups/DNS and the same dedicated existing application IAM role. The witness stores encrypted transaction logs, has no user query endpoint and no encryption keys; it is not data-free. Include all three regions in civilian/DoD/State classification, residency, records, cryptography, support and authorization approval. This is not conversion/import of an existing single-Region cluster or a no-data replication simulation.

Primary/secondary are deployment labels, not active/passive roles. Both endpoints present the same strongly consistent logical database and can accept application reads/writes. Review cross-region write latency, quorum/availability/failure behavior, DPU/storage/replication/PrivateLink/key/backup/support charges and real quotas. Independent regional key policies/grants and lifecycle must remain usable; a key failure can affect cluster availability. Do not treat active-active as an application exactly-once/backup/data-corruption recovery solution.

The root module contains primary/secondary regional modules and TWO reciprocal aws_dsql_cluster_peering resources using the pinned5.100 provider. Each cluster is first created with the common witness in PENDING_SETUP; the native peering calls update BOTH associations and wait for ACTIVE. They MUST run concurrently: retain Terraform parallelism of at least2 and do not add a dependency between the two peering resources or target/apply one alone. No serial peer1-wait-then-peer2 procedure. Initial resources use explicit providers per region and child configuration_aliases; no credentials/local-exec/provider configuration is hidden inside child modules. Apply only the parent root.

Peering resource deletion is a provider NO-OP; removing its state does not undo the AWS association. Witness changes can require cluster replacement; never remove protection or replace/depeer a populated logical database as rollback. Partial/timeout/ambiguous peering requires actual get-cluster/state reconciliation before retry/import. If remote peering became ACTIVE without state being recorded, the native creator only accepts PENDING_SETUP and cannot simply create it again. Preserve both cluster/endpoint IDs and owner-approved state recovery/import decisions. No automatic retry/delete/cleanup of live peers is performed.

Run python CHECK-PAIR.py --preflight with approved boto3/botocore and metadata credentials; it checks BOTH regional key/role/network/client dependencies. Confirm regional offering, key grants, endpoint capacity, quotas and dsql:PutMultiRegionProperties/AddPeerCluster permissions including the witness as required by AWS. Run init/validate/plan from this root in a protected state boundary. Review both regions/witness, new clusters/endpoints/SGs, reciprocal links, existing dependencies and cost. Owner-apply the saved plan with parallelism>=2. Do not apply regional subdirectories independently.

After approved apply run python CHECK-PAIR.py --primary-cluster <primary_cluster_id> --secondary-cluster <secondary_cluster_id> --primary-endpoint <primary_connection_endpoint_id> --secondary-endpoint <secondary_connection_endpoint_id> --emit-policy-review. Each component checks its exact owner/ACTIVE/encryption/deletion protection, actual peer association and witness, private connection service/DNS/endpoint/subnet/ENI/client-group security. Output contains actual-ID policy MERGE proposals and application identity-policy REVIEW statements; it does not apply permissions. Owner merges each cluster's explicit DbConnect/Admin deny outside THAT approved regional endpoint and reviews both scoped application policies. Existing policies/concurrent versions/denies must be preserved. Native cluster-policy resource is not in pinned5.100; no unsupported Terraform is emitted.

Repeat the same CHECK-PAIR.py command without --emit-policy-review after owner policy approval. Both exact endpoint-deny statements are required, but checks are separate metadata snapshots, not atomic authorization/traffic/integrity proof. PrivateLink does not turn off public endpoints. DSQL Block Public Access policy reasoning is distinct from denying public network paths. Test permitted/denied clients/admins/outside-endpoint access, TLSverifyfull, actual DNS forwarding, route/NACL controls, region failure and return paths before data. Control FIPS endpoints do not certify data-plane modules or an ATO.

Use MIGRATION-OPERATIONS.md for reviewed PostgreSQL16 subset/schema/loader/copy/reconciliation/backup/cutover procedure. Bootstrap the application SQL role/schema ONCE on the shared logical database, not once per endpoint. Review each regional AUTHORIZE-REVIEW.sql reference before execution; both map the SAME role/schema. Grant no application DbConnectAdmin. After both network boundaries and exact-cluster IAM DbConnect policies are approved, run primary/CHECK-CONNECTION.py and secondary/CHECK-CONNECTION.py separately with each exact private hostname, approved CA bundle and --confirm-approved-connect while assuming the same application IAM role. They only sign in-memory900second app tokens and SELECT role/database; never run them automatically. No shared data is loaded twice just because there are two peers.

Verify current application transaction conflicts/retry/idempotency and actual cross-peer consistency, source snapshot/deltas, key/backup restoration, audit/metric delivery, cutover ownership and rollback with an approved representative dataset. Keep a single controlled migration/load owner and reconcile all writes. Capture actual evidence within the authorized records boundary; ACTIVE, reciprocal metadata or an identity query does not mean the application migrated. Keep old source/recovery path until signoff. No live AWS/SQL/data/token/network-policy/peering operations are run by local export/testing.

https://docs.aws.amazon.com/aurora-dsql/latest/userguide/multi-region-aws-cli.html
https://docs.aws.amazon.com/aurora-dsql/latest/userguide/data-protection.html
https://docs.aws.amazon.com/aurora-dsql/latest/userguide/privatelink-managing-clusters.html
https://raw.githubusercontent.com/hashicorp/terraform-provider-aws/v5.100.0/internal/service/dsql/cluster_peering.go
`;
