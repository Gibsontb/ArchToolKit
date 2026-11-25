import type {Blueprint} from '../kit/blueprint.ts';
import {error,type Finding} from '../core/findings.ts';
import {blk,dat,hcl,output,res,x} from '../terraform/blueprints/migration/common.ts';
import {awsServiceModule,awsServiceRegion} from './aws-service-module.ts';
export const AWS_ACCESSANALYZER_SERVICE={
  id:'aws_service_accessanalyzer',label:'Create an external or unused-access analyzer for an account or organization',
  description:'Protected analyzer with explicit trust zone, optional unused-access age and metadata-only inspection. No automatic policy remediation, archive rules or credential changes.',
  emits:['aws_accessanalyzer_analyzer'],
  inputs:[awsServiceRegion,{id:'name',label:'New analyzer name',control:'text'},
    {id:'account',label:'Expected analyzer owner account ID',control:'text'},
    {id:'analysis',label:'Access analysis',control:'select',default:'EXTERNAL',options:[{value:'EXTERNAL',label:'External access beyond the trust zone'},{value:'UNUSED',label:'Unused IAM access — additional recurring charges'}]},
    {id:'zone',label:'Trust / analysis boundary',control:'select',default:'ACCOUNT',options:[{value:'ACCOUNT',label:'This AWS account'},{value:'ORGANIZATION',label:'AWS organization — management or delegated administrator'}]},
    {id:'organization',label:'Expected AWS organization ID',control:'text',showWhen:{input:'zone',equals:['ORGANIZATION']}},
    {id:'age',label:'Unused-access tracking period (days)',control:'number',default:90,min:1,max:180,showWhen:{input:'analysis',equals:['UNUSED']},hint:'All eligible identities in the selected boundary; no exclusions. Review costs and duplicate analyzers across regions/accounts first.'},
  ],
  build(values):ReturnType<typeof awsServiceModule>{
    const findings:Finding[]=[],reject=(path:string,message:string)=>findings.push(error('aws.accessanalyzer.'+path,message,{path}));
    const region=String(values.aws_region??''),name=String(values.name??'').trim(),account=String(values.account??'').trim(),analysis=String(values.analysis??''),zone=String(values.zone??''),organization=String(values.organization??'').trim(),age=Number(values.age),unused=analysis==='UNUSED',org=zone==='ORGANIZATION';
    if(!['us-east-1','us-east-2','us-west-1','us-west-2'].includes(region))reject('aws_region','Initial FIPS endpoint workflow supports four US commercial regions; other partitions need separate qualification.');
    if(!/^[a-zA-Z][A-Za-z0-9_.-]{0,254}$/.test(name))reject('name','Use1–255 letters/digits/underscore/period/hyphen, beginning with a letter.');
    if(!/^\d{12}$/.test(account))reject('account','Use the12-digit analyzer owner account.');
    if(!['EXTERNAL','UNUSED'].includes(analysis))reject('analysis','Select external or unused-access analysis.');
    if(!['ACCOUNT','ORGANIZATION'].includes(zone))reject('zone','Select account or organization.');
    if(org&&!/^o-[a-z0-9]{10,32}$/.test(organization))reject('organization','Use the exact current organization ID. Existing trusted service access and management/delegated administration must be approved.');
    if(unused&&(!Number.isInteger(age)||age<1||age>180))reject('age','Use an unused-access tracking period from1–180days.');
    const type=zone+(unused?'_UNUSED_ACCESS':''),config={region,name,account,analysis,zone,organization:org?organization:null,age:unused?age:null,type};
    const resources=[blk('provider',{alias:'analysis',region,use_fips_endpoint:true,allowed_account_ids:[account]},[],['aws']),dat('aws_caller_identity','current',{}),...(org?[dat('aws_organizations_organization','selected',{})]:[]),
      res('aws_accessanalyzer_analyzer','configured',{provider:x('aws.analysis'),analyzer_name:name,type,tags:x(hcl({Name:name}))},[
        ...(unused?[blk('configuration',{},[blk('unused_access',{unused_access_age:age})])]:[]),
        blk('lifecycle',{prevent_destroy:true},[blk('precondition',{condition:x(`data.aws_caller_identity.current.account_id == ${JSON.stringify(account)}`+(org?` && data.aws_organizations_organization.selected.id == ${JSON.stringify(organization)} && data.aws_organizations_organization.selected.feature_set == "ALL"`:'')),error_message:'Require exact owner account and, when selected, existing ALL-features organization. INSPECT.py must independently verify management/delegated administration and trusted service access.'})]),
      ]),output('analyzer_arn','aws_accessanalyzer_analyzer.configured.arn')];
    const result=awsServiceModule(region,resources,GUIDE,findings);
    return {...result,files:{...result.files,'ANALYZER-CONFIG.json':JSON.stringify(config,null,2)+'\n','INSPECT.py':INSPECT}};
  },
} satisfies Blueprint;

const INSPECT=String.raw`import argparse
import json
from pathlib import Path
import boto3
from botocore.config import Config

def require(condition, message):
    if not condition:
        raise RuntimeError(message)

def pages(client, method, field, token_in='nextToken', token_out='nextToken', **kwargs):
    result, seen, token = [], set(), None
    for _ in range(100):
        response = getattr(client,method)(**kwargs, **({token_in:token} if token else {}))
        result += response.get(field,[])
        token = response.get(token_out)
        if not token:
            return result
        require(token not in seen, 'Repeated pagination token; review incomplete')
        seen.add(token)
    raise RuntimeError('Pagination bound exceeded; review incomplete')

def main():
    parser = argparse.ArgumentParser(description='Read-only analyzer identity/scope inspection and optional aggregate findings counts')
    parser.add_argument('--check',action='store_true',help='Inspect deployed analyzer instead of preflight')
    parser.add_argument('--findings',action='store_true',help='Read findings metadata into memory and print counts only; requires --check')
    args = parser.parse_args()
    require(not args.findings or args.check, 'Findings require exact deployed analyzer check')
    c = json.loads((Path(__file__).resolve().parent/'ANALYZER-CONFIG.json').read_text())
    session = boto3.Session(region_name=c['region'])
    cfg = Config(use_fips_endpoint=True,retries={'mode':'standard','total_max_attempts':3})
    def client(name):
        return session.client(name,region_name=c['region'],config=cfg)
    require(client('sts').get_caller_identity()['Account'] == c['account'], 'Wrong AWS account')
    if c['zone'] == 'ORGANIZATION':
        orgs = client('organizations')
        org = orgs.describe_organization()['Organization']
        require(org.get('Id') == c['organization'] and org.get('FeatureSet') == 'ALL', 'Wrong organization or not ALL features')
        services = pages(orgs,'list_aws_service_access_for_organization','EnabledServicePrincipals','NextToken','NextToken',MaxResults=20)
        require(any(s.get('ServicePrincipal') == 'access-analyzer.amazonaws.com' for s in services), 'Trusted service access not already enabled')
        if org.get('MasterAccountId') != c['account']:
            admins = pages(orgs,'list_delegated_administrators','DelegatedAdministrators','NextToken','NextToken',ServicePrincipal='access-analyzer.amazonaws.com',MaxResults=20)
            require(any(a.get('Id') == c['account'] and a.get('State',a.get('Status')) == 'ACTIVE' for a in admins), 'Not current management/delegated administrator')
    analyzer = client('accessanalyzer')
    listed = pages(analyzer,'list_analyzers','analyzers',type=c['type'])
    if not args.check:
        require(not listed, 'An analyzer of this type already exists in the selected owner/region; review/reuse it instead of duplicating this new-only package')
        print('Account/organization prerequisites and selected-region analyzer absence checked. Review service-linked role, supported scope/quotas, authorization and any unused-access recurring charges before apply.')
        return
    arn = 'arn:aws:access-analyzer:'+c['region']+':'+c['account']+':analyzer/'+c['name']
    require(sum(a.get('arn') == arn and a.get('name') == c['name'] for a in listed) == 1, 'Expected analyzer missing/duplicated in metadata')
    a = analyzer.get_analyzer(analyzerName=c['name'])['analyzer']
    require(a.get('arn') == arn and a.get('name') == c['name'] and a.get('type') == c['type'] and a.get('status') == 'ACTIVE' and not a.get('statusReason'), 'Wrong/inactive analyzer or status reason requires review')
    config = a.get('configuration') or {}
    if c['analysis'] == 'UNUSED':
        require(set(config) == {'unusedAccess'} and config['unusedAccess'].get('unusedAccessAge') == c['age'] and not config['unusedAccess'].get('analysisRule',{}).get('exclusions'), 'Unused analysis age/scope/exclusions mismatch')
    else:
        require(not config, 'Unexpected external analyzer configuration')
        require(not pages(analyzer,'list_archive_rules','archiveRules',analyzerName=c['name']), 'Unexpected automatic archive rules hide findings from this baseline')
    result = {'analyzerActive':True,'analysis':c['analysis'],'zone':c['zone'],'authorizationProven':False,'scanCompletenessProven':False}
    if args.findings:
        method = 'list_findings' if c['analysis'] == 'EXTERNAL' else 'list_findings_v2'
        findings = pages(analyzer,method,'findings',analyzerArn=arn)
        ids = [f.get('id') for f in findings]
        require(all(ids) and len(set(ids)) == len(ids), 'Missing/duplicate finding IDs; scan incomplete')
        counts = {'ACTIVE':0,'ARCHIVED':0,'RESOLVED':0}
        errors = 0
        for f in findings:
            require(f.get('status') in counts, 'Unknown finding status; review incomplete')
            counts[f['status']] += 1
            errors += int(bool(f.get('error')))
        result.update({'findings':counts,'findingErrors':errors,'ownerReviewRequired':True})
    print(json.dumps(result,sort_keys=True))

if __name__ == '__main__':
    main()
`;

const GUIDE=`# IAM Access Analyzer and migration access review

Create one new protected external or unused-access analyzer with account or existing organization boundary. Initial four US commercial FIPS-endpoint regions; other partitions and internal-access/configuration variants require separate qualification. Existing analyzers, permissions, credential policies, organization trusted-service/delegation configuration and archive rules are NOT modified. Both catalog names refer to the same analyzer control plane. AWS may create/use its service-linked role AWSServiceRoleForAccessAnalyzer during analyzer creation; the approved deploying principal needs the documented service-linked-role permission. Do not delete that shared role as rollback.

External analysis evaluates supported resource-based policies beyond the selected trust zone, not every identity policy or network data path. Organization zone treats member accounts as trusted: it is not evidence of least privilege between members or their workloads. External analyzers are regional; enable/review each required region independently. Unused analysis assesses eligible IAM roles/users/permissions against selected age, not whether removal is business-safe. It adds recurring per-role/user/analyzer charges; avoid duplicates in multiple regions or both management/delegated accounts. All eligible identities in selected boundary are in scope, no exclusions. Age is not a universal compliance rule or a retention policy. This package does not automatically disable identities/keys/permissions.

Organization scope requires existing ALL-features organization and preapproved Access Analyzer trusted service access. Use the current management account or registered active delegated administrator. The inspector checks actual organization ID, trusted service principal and paginated current delegation metadata; it never enables access/registers delegation. Changing delegation can disable old organization analyzers and findings access. Record owner/management change authority and preserve evidence before organization changes. Account scope needs no Organizations read permissions.

Review civilian/DoD/State data/classification/APL/CDM/DoDIN/FIPSmodule/ATO/SSP/privacy/records/residency/support boundaries for service analysis metadata, resource names/principals and findings. FIPS endpoint selection alone is not CMVP validation or authorization. The helper receives resource/principal/finding metadata in memory but prints only aggregate counts, not full findings/policies/identities. Use an approved metadata inspection boundary and restricted credentials/logs; do not turn SDK debug logging on. No message/object/log bodies, plaintext secrets or policy documents are fetched.

Run python INSPECT.py with approved boto3/botocore and metadata credentials before deployment. It checks selected owner/organization eligibility and rejects any existing same-type analyzer in that region for this new-only workflow; reuse/review existing analyzers separately rather than importing/replacing them. Check global duplicate unused analyzers/costs and actual quotas outside this regional check. Run terraform init/validate/plan in a protected state boundary, review exact analyzer type/name/age/organization and service-linked-role implications, then owner-apply the approved plan. Type/config/name changes may force replacement blocked by prevent_destroy.

Run python INSPECT.py --check afterward to verify exact account/region/name/type/ACTIVE analyzer, configuration age/no exclusions and absence of external archive rules. Add --findings to read all bounded pages of findings metadata and print ACTIVE/ARCHIVED/RESOLVED/error counts only. It uses ListFindings for external analysis and ListFindingsV2 for unused analysis. No automatic archive, status change, remediation, rescan or policy validation/generation occurs. Pagination inconsistencies fail rather than showing a misleading partial count. Counts are not an atomic snapshot; concurrent finding changes may require a fresh owner review.

ACTIVE analyzer or zero findings is not complete scan, effective least privilege, a clean migration gate or an ATO. Initial scans and policy-change findings can be delayed; unsupported resources and analysis errors require review. Reconcile expected inventory/resource types/account membership/regions, actual scan timestamps/coverage/error evidence and classification requirements with the inventory/migration plan. Review actual findings in the authorized AWS console, identify intended trust versus unapproved access, assign owner/expiry/exception/change records and evaluate proposals against real workload dependencies. Archive only through a separately approved, narrowly scoped rule/change process; do not hide findings to pass cutover.

Use owner-approved before/after policy evidence and permitted/denied application tests during migration. Unused findings require seasonal/DR/break-glass/service-role/last-used-data limitations and rollback review before least-privilege changes. No one-click revoke/delete is emitted. Preserve findings and configuration evidence within the authorized records boundary. prevent_destroy protects accidental analyzer deletion; destroying it loses findings visibility and does not revoke risky access. Restore monitoring/ownership under change authority, retain required evidence and separately authorize decommission. No live AWS operations are performed by local export/verification.

https://docs.aws.amazon.com/IAM/latest/UserGuide/access-analyzer-getting-started.html
https://docs.aws.amazon.com/IAM/latest/UserGuide/access-analyzer-delegated-administrator.html
https://docs.aws.amazon.com/general/latest/gr/access-analyzer.html
https://docs.aws.amazon.com/access-analyzer/latest/APIReference/API_ListFindings.html
`;
