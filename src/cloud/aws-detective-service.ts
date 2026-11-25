import type {Blueprint} from '../kit/blueprint.ts';
import {error,type Finding} from '../core/findings.ts';
import {blk,dat,hcl,output,res,x} from '../terraform/blueprints/migration/common.ts';
import {awsServiceModule,awsServiceRegion} from './aws-service-module.ts';
import {detectiveInspection} from './aws-detective-files.ts';
export const AWS_DETECTIVE_SERVICE={
  id:'aws_service_detective_graph',label:'Enable a new account-owned Detective behavior graph',
  description:'New regional behavior graph starts telemetry ingestion immediately when applied. Existing graphs require reconciliation; no member invitations, organization enrollment or findings remediation.',
  emits:['aws_detective_graph'],
  inputs:[awsServiceRegion,{id:'name',label:'Graph label (no sensitive data)',control:'text'},
    {id:'account',label:'Expected graph administrator account ID',control:'text'},
    {id:'approved',label:'Owner approved default ingestion, retention and charges',control:'select',default:'false',options:[{value:'false',label:'Approval not recorded'},{value:'true',label:'Core, EKS audit and AWS security findings approved'}],hint:'New graphs enable both optional source packages by default. This provider workflow cannot pre-disable them before initial ingestion.'},
  ],
  build(values):ReturnType<typeof awsServiceModule>{
    const findings:Finding[]=[],reject=(path:string,message:string)=>findings.push(error('aws.detective.'+path,message,{path}));
    const region=String(values.aws_region??''),name=String(values.name??'').trim(),account=String(values.account??'').trim(),approved=String(values.approved)==='true';
    if(!['us-east-1','us-east-2','us-west-1','us-west-2'].includes(region))reject('aws_region','Initial workflow covers four US commercial Detective FIPS regions; other partitions/regions need qualification.');
    if(!/^[a-z][a-z0-9-]{1,38}[a-z0-9]$/.test(name))reject('name','Use3–40 lowercase letters/digits/internal hyphens, without sensitive metadata.');
    if(!/^\d{12}$/.test(account))reject('account','Use the12-digit graph administrator account.');
    if(!approved)reject('approved','Graph creation immediately enables telemetry ingestion, including both default optional packages. Record owner approval before generating this enablement plan.');
    const result=awsServiceModule(region,[
      blk('provider',{alias:'investigation',region,use_fips_endpoint:true,allowed_account_ids:[account]},[],['aws']),
      dat('aws_caller_identity','current',{}),
      res('aws_detective_graph','configured',{provider:x('aws.investigation'),tags:x(hcl({Name:name}))},[
        blk('lifecycle',{prevent_destroy:true},[blk('precondition',{condition:x('data.aws_caller_identity.current.account_id == '+JSON.stringify(account)),error_message:'Require exact approved graph administrator account; run INSPECT.py to reconcile existing graphs before apply.'}),
          blk('postcondition',{condition:x('startswith(self.graph_arn, '+JSON.stringify('arn:aws:detective:'+region+':'+account+':graph:')+')'),error_message:'Graph ARN must match the approved region and administrator account.'})]),
      ]),output('graph_arn','aws_detective_graph.configured.graph_arn')],GUIDE,findings);
    return {...result,files:{...result.files,'INSPECT.py':detectiveInspection,'DETECTIVE-CONFIG.json':JSON.stringify({region,name,account,approvedPackages:['DETECTIVE_CORE','EKS_AUDIT','ASFF_SECURITYHUB_FINDING']},null,2)+'\n'}};
  },
} satisfies Blueprint;
const GUIDE=`# Account-owned Detective behavior graph enablement

This is actual service ENABLEMENT when an owner applies the plan, not an empty/disabled graph. Creating the graph starts ingestion immediately. New graphs enable core CloudTrail/VPC flow/available GuardDuty data plus EKS audit and ASFF AWS security findings packages by default. The pinned AWS5.100 graph resource has no data-source package switch, retention selector or customer-key selector; none is fabricated. If any default data source is outside the approved boundary, do not apply this workflow and do not rely on a later disable command to prevent initial collection. Source-package controls and organization/member designs require separate qualification. No graph/member/org mutation is performed by local export or the metadata inspector.

Initial four US commercial FIPS control API regions. Native provider alias restricts expected administrator account and region. Existing graphs must be reconciled/imported under independent owner review: CreateGraph can return the same existing graph instead of creating a new one, so a matching Terraform create plan is not proof the account has no graph. Run python INSPECT.py before plan; it paginates all account-owned administrator graphs and requires none. Do not reset/delete a graph to make preflight pass. Owner must coordinate graph creation/state ownership against concurrent changes; inspection and apply are not atomic.

Before enablement approve actual telemetry contents, civilian/DoD/State classification, ATO/SSP/APL/CDM/DoDIN, privacy, CMVP, residency, retention/records/legal-hold, investigator permissions/support and expected ingestion fees. Metadata/logs/findings may contain sensitive identifiers. Detective retains received source data for up to one year; it is not a configurable archival/immutable evidence repository. Independent service streams do not use/reconfigure existing CloudTrail/VPC flow log destinations. There is no requirement to enable GuardDuty for48hours before Detective: AWS removed that prerequisite in2024. Do not create redundant trails/flow logs/GuardDuty as an invented prerequisite. Align investigation administrators with existing GuardDuty/SecurityHub ownership where appropriate under a separately reviewed organization design.

Review the protected backend, least deployment/investigator roles, service roles, data-protection model, log API access and quotas. Run terraform init/validate/plan and owner-apply only the approved enablement plan. Graph prevent_destroy blocks ordinary Terraform deletion but is not an immutable-data guarantee or protection against separate AWS API callers. This package creates no broad investigator/admin IAM policy, member invitation/email, account autoenrollment or organization administrator. Do not call DeleteGraph as rollback.

After apply run python INSPECT.py --graph <exact-graph_arn>. It checks exact account/region/graph ownership/list uniqueness/name tag, paginated member metadata rejects accounts beyond the expected administrator, and exact three approved STARTED source-package metadata. It reports counts/state only, not emails, findings, resource activities or raw event bodies. An optional package can be STARTED without that source producing events; metadata state is not ingestion completeness, incident detection, retention or effective authorization proof. The inspector does not call organization-only APIs and does not prove org autoenable is off; an existing delegated-administrator/autoenrollment setting requires independent review before applying this account-only workflow.

Allow initial extraction time and independently verify approved examples/coverage in the console inside the authorized investigation boundary. Do not inject incidents or retrieve sensitive investigation data through this checker. Validate allowed/denied investigator access, audit trails, data sources, timeliness, incident handoff and evidence preservation. Preserve approvals/actual graph/state/source-package/investigator evidence in the project plan. Data ingestion is billed by actual volume per account/package/Region; free trial eligibility is service-determined, not assumed or resettable. Use actual service usage and current regional pricing for TCO rather than VM CPU/storage sizing or fixed invented savings. Cost integration remains separately required.

For a migration project enable the approved target-account monitoring before pilot/waves, retain source investigation and evidence boundaries through overlap, align account identities/time windows without combining unrelated classifications, and verify target findings/log coverage before source decommission. This does not copy an existing graph's historical data to another account/Region or migrate application data. Recovery/change control must preserve evidence outside the graph as required; disabling/deleting can remove access and data and does not undo prior collection. Separately authorize any source-package changes, member/org enrollment or decommission; preserve incident records/legal holds and independently confirm deletion/retention obligations.

https://docs.aws.amazon.com/detective/latest/APIReference/API_CreateGraph.html
https://docs.aws.amazon.com/detective/latest/userguide/source-data-types-EKS.html
https://docs.aws.amazon.com/detective/latest/userguide/source-data-types-asff.html
https://docs.aws.amazon.com/detective/latest/userguide/detective-source-data-about.html
https://docs.aws.amazon.com/detective/latest/userguide/doc-history.html
https://docs.aws.amazon.com/general/latest/gr/detective.html
`;
