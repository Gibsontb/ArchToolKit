                                                   
import {error,            } from '../core/findings.js';
import {blk,dat,hcl,output,res,x} from '../terraform/blueprints/migration/common.js';
import {awsServiceModule,awsServiceRegion} from './aws-service-module.js';
import {appFlowInspection} from './aws-appflow-files.js';
export const AWS_APPFLOW_SERVICE={
  id:'aws_service_appflow_salesforce_s3',label:'Stage an on-demand Salesforce export to an approved S3 prefix',
  description:'New flow using an existing private Salesforce profile, explicit Id/Name projection and customer data key. No connector credentials, automatic transfer, field discovery expansion or existing bucket-policy replacement.',
  emits:['aws_appflow_flow'],
  inputs:[awsServiceRegion,{id:'name',label:'New flow name',control:'text'},
    {id:'account',label:'Expected AWS owner account ID',control:'text'},
    {id:'profile',label:'Existing private Salesforce profile name',control:'text'},
    {id:'instance',label:'Expected Salesforce organization URL',control:'text',hint:'Approved exact HTTPS my.salesforce.com instance. Existing PrivateLink profile must already be provisioned.'},
    {id:'object',label:'Salesforce source object',control:'select',default:'Account',options:['Account','Contact','Opportunity'].map(value=>({value,label:value}))},
    {id:'fields',label:'Approved fields to export',control:'checklist',default:'Id,Name',options:[{value:'Id',label:'Id'},{value:'Name',label:'Name'}],hint:'This initial workflow explicitly projects only these fields. New/custom fields are not imported automatically.'},
    {id:'bucket',label:'Existing same-owner destination bucket',control:'text'},
    {id:'prefix',label:'Dedicated destination prefix',control:'text',default:'salesforce-export/'},
    {id:'kms',label:'Existing flow / destination customer KMS key ARN',control:'text'},
    {id:'format',label:'Destination file format',control:'select',default:'JSON',options:[{value:'JSON',label:'JSON'},{value:'CSV',label:'CSV'}]},
  ],
  build(values)                                    {
    const findings          =[],reject=(path       ,message       )=>findings.push(error('aws.appflow.'+path,message,{path}));
    const region=String(values.aws_region??''),name=String(values.name??'').trim(),account=String(values.account??'').trim(),profile=String(values.profile??'').trim(),instance=String(values.instance??'').trim(),object=String(values.object??''),fields=String(values.fields??'').split(',').map(value=>value.trim()).filter(Boolean),bucket=String(values.bucket??'').trim(),prefix=String(values.prefix??'').trim(),kms=String(values.kms??'').trim(),format=String(values.format??'');
    if(!['us-east-1','us-east-2','us-west-1','us-west-2'].includes(region))reject('aws_region','Initial workflow uses the four US commercial AppFlow FIPS API regions; other regions/partitions need qualification.');
    if(!/^[a-z][a-z0-9-]{1,38}[a-z0-9]$/.test(name))reject('name','Use3–40 lowercase letters/digits/internal hyphens.');
    if(!/^\d{12}$/.test(account))reject('account','Use the12-digit flow/profile/bucket/key owner account.');
    if(!/^[A-Za-z0-9][A-Za-z0-9_!@#+=.-]{0,127}$/.test(profile))reject('profile','Use the exact existing connector profile name. No credential values.');
    if(!/^https:\/\/[A-Za-z0-9-]+(?:\.sandbox)?\.my\.salesforce\.com\/?$/.test(instance))reject('instance','Use the approved exact commercial Salesforce organization HTTPS URL; no paths/queries/credentials.');
    if(!['Account','Contact','Opportunity'].includes(object))reject('object','Choose a qualified source object.');
    if(!fields.length||new Set(fields).size!==fields.length||fields.some(value=>!['Id','Name'].includes(value)))reject('fields','Select one or both explicitly supported fields; metadata must confirm current retrievability/type.');
    if(!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)||bucket.startsWith('xn--')||/-s3alias$|--ol-s3$|--x-s3$|--table-s3$/.test(bucket))reject('bucket','Use a general-purpose existing bucket name without periods/reserved aliases.');
    if(!/^[A-Za-z0-9][A-Za-z0-9_/-]{0,198}\/$/.test(prefix)||prefix.includes('//'))reject('prefix','Use a dedicated prefix ending / without empty path components.');
    const key=/^arn:aws:kms:([a-z0-9-]+):(\d{12}):key\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.exec(kms);
    if(!key||key[1]!==region||key[2]!==account)reject('kms','Use an existing same-region/owner customer symmetric key ARN.');
    if(!['JSON','CSV'].includes(format))reject('format','Choose JSON or CSV.');
    const flowArn='arn:aws:appflow:'+region+':'+account+':flow/'+name,bucketArn='arn:aws:s3:::'+bucket;
    const condition={StringEquals:{'aws:SourceAccount':account},ArnEquals:{'aws:SourceArn':flowArn}};
    const statements=[{Sid:'ApprovedAppFlowBucketMetadata',Effect:'Allow',Principal:{Service:'appflow.amazonaws.com'},Action:['s3:GetBucketAcl','s3:ListBucketMultipartUploads'],Resource:bucketArn,Condition:condition},{Sid:'ApprovedAppFlowPrefixWrites',Effect:'Allow',Principal:{Service:'appflow.amazonaws.com'},Action:['s3:PutObject','s3:PutObjectAcl','s3:AbortMultipartUpload','s3:ListMultipartUploadParts'],Resource:bucketArn+'/'+prefix+'*',Condition:condition}];
    const config={region,name,account,profile,instance:instance.replace(/\/$/,''),object,fields,bucket,prefix,kms,format,flowArn};
    const result=awsServiceModule(region,[blk('provider',{alias:'transfer',region,use_fips_endpoint:true,allowed_account_ids:[account]},[],['aws']),dat('aws_caller_identity','current',{}),dat('aws_s3_bucket','selected',{bucket}),dat('aws_kms_key','selected',{key_id:kms}),
      res('aws_appflow_flow','configured',{provider:x('aws.transfer'),name,kms_arn:kms,tags:x(hcl({Name:name}))},[
        blk('source_flow_config',{connector_type:'Salesforce',connector_profile_name:profile},[blk('source_connector_properties',{},[blk('salesforce',{object,enable_dynamic_field_update:false,include_deleted_records:false,data_transfer_api:'REST_SYNC'})])]),
        blk('destination_flow_config',{connector_type:'S3'},[blk('destination_connector_properties',{},[blk('s3',{bucket_name:bucket,bucket_prefix:prefix},[blk('s3_output_format_config',{file_type:format},[blk('aggregation_config',{aggregation_type:'None'}),blk('prefix_config',{prefix_type:'PATH',prefix_format:'DAY',prefix_hierarchy:['EXECUTION_ID']})])])])]),
        blk('trigger_config',{trigger_type:'OnDemand'}),
        blk('task',{task_type:'Filter',source_fields:fields},[blk('connector_operator',{salesforce:'PROJECTION'})]),
        ...fields.map(field=>blk('task',{task_type:'Map',source_fields:[field],destination_field:field,task_properties:x(hcl({SOURCE_DATA_TYPE:field==='Id'?'id':'string',DESTINATION_DATA_TYPE:field==='Id'?'id':'string'}))},[blk('connector_operator',{salesforce:'NO_OP'})])),
        blk('lifecycle',{prevent_destroy:true},[blk('precondition',{condition:x(`data.aws_caller_identity.current.account_id == ${JSON.stringify(account)} && data.aws_s3_bucket.selected.region == ${JSON.stringify(region)} && data.aws_kms_key.selected.arn == ${JSON.stringify(kms)} && data.aws_kms_key.selected.key_state == "Enabled" && data.aws_kms_key.selected.key_manager == "CUSTOMER" && data.aws_kms_key.selected.key_spec == "SYMMETRIC_DEFAULT" && data.aws_kms_key.selected.key_usage == "ENCRYPT_DECRYPT"`),error_message:'Require exact owner, regional destination and enabled customer symmetric key. Existing profile, bucket/key policy, data authorization and source schema need the generated inspection and owner review.'})]),
      ]),output('flow_arn','aws_appflow_flow.configured.arn'),output('flow_status','aws_appflow_flow.configured.flow_status')],GUIDE,findings);
    return {...result,files:{...result.files,'INSPECT.py':appFlowInspection,'START-APPROVED.ps1':START,'FLOW-CONFIG.json':JSON.stringify(config,null,2)+'\n','BUCKET-POLICY-MERGE.json':JSON.stringify({Version:'2012-10-17',Statement:statements},null,2)+'\n'}};
  },
}                    ;

const START=String.raw`param([switch]$ApproveTransfer)
$ErrorActionPreference = 'Stop'
if (-not $ApproveTransfer) { throw 'Owner-approved real Salesforce-to-S3 transfer requires -ApproveTransfer. No transfer requested.' }
$null = Get-Command aws -ErrorAction Stop
$null = Get-Command python -ErrorAction Stop
$configuration = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'FLOW-CONFIG.json') -Raw | ConvertFrom-Json
$requestPath = Join-Path $PSScriptRoot 'TRANSFER-REQUEST.json'
$receiptPath = Join-Path $PSScriptRoot 'TRANSFER-RECEIPT.json'
if ((Test-Path -LiteralPath $requestPath) -or (Test-Path -LiteralPath $receiptPath)) { throw 'Existing transfer request/receipt: reconcile its actual state. Do not start or retry blindly.' }
& python (Join-Path $PSScriptRoot 'INSPECT.py') --check
if ($LASTEXITCODE -ne 0) { throw 'Exact not-yet-run flow preflight failed. No transfer requested.' }
$request = @{ flowName = $configuration.name; flowArn = $configuration.flowArn; region = $configuration.region; clientToken = [guid]::NewGuid().ToString(); createdUtc = [DateTime]::UtcNow.ToString('o') }
$bytes = [System.Text.Encoding]::UTF8.GetBytes(($request | ConvertTo-Json))
# Reserve the request BEFORE the network call. Concurrent/repeated invocations cannot overwrite it.
$stream = [System.IO.File]::Open($requestPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
$priorAttempts = $env:AWS_MAX_ATTEMPTS
try {
    $env:AWS_MAX_ATTEMPTS = '1'
    $response = & aws appflow start-flow --flow-name $configuration.name --region $configuration.region --endpoint-url ('https://appflow-fips.' + $configuration.region + '.amazonaws.com') --client-token $request.clientToken --output json --no-cli-pager
    if ($LASTEXITCODE -ne 0) { throw 'Transfer result ambiguous/failed. Request retained; reconcile it without starting again.' }
    $receipt = ($response -join [Environment]::NewLine) | ConvertFrom-Json
    if (($receipt.flowArn -ne $configuration.flowArn) -or ($receipt.executionId -notmatch '^[A-Za-z0-9_-]{1,256}$')) { throw 'Unexpected response identity. Request retained for reconciliation; do not retry.' }
    $record = @{ flowArn = $receipt.flowArn; executionId = $receipt.executionId; clientToken = $request.clientToken }
    $receiptBytes = [System.Text.Encoding]::UTF8.GetBytes(($record | ConvertTo-Json))
    $receiptStream = [System.IO.File]::Open($receiptPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try { $receiptStream.Write($receiptBytes, 0, $receiptBytes.Length) } finally { $receiptStream.Dispose() }
    Write-Host ('Request accepted; execution receipt: ' + $receipt.executionId + '. This is not completion or data-integrity proof.')
    Write-Host 'Use INSPECT.py --check --execution <exact receipt ID> to inspect this run. Preserve request and receipt files.'
} finally {
    $env:AWS_MAX_ATTEMPTS = $priorAttempts
}
`;

const GUIDE=`# On-demand Salesforce to S3 flow

New flow only, existing approved Salesforce PrivateLink profile and same-owner/region destination/customer data key. Initial commercial US four FIPS API regions, Account/Contact/Opportunity, explicit Id/Name fields, REST_SYNC and JSON/CSV. No connector creation/OAuth credential capture, scheduled/event triggers, SaaS writes, custom/new fields, deleted records, Map_all, masking, incremental load or automatic transfer. These are bounded initial variants, not all AppFlow connectors/features. Existing generic flow/profile builders remain available separately. Terraform5.100 CreateFlow sends creation/configuration only and does not call StartFlow; OnDemand has no schedule. Flow creation can still contact connector/schema metadata and create/use service key grants; it is not a promise of no service-side effects.

Owner must first create/approve the existing Salesforce connection outside this package, including actual API-enabled org/app permissions, least privilege, PrivateLink provisioned connection, source region/residency and credentials/key lifecycle. Profile metadata/credential secret ARN is not proof of authorization or effective private data transport. No secret/token values are entered/exported/retrieved. Account/Contact/Opportunity can contain regulated/PII data even when only Id/Name are selected. Verify exact instance, source schema field retrieval/types, quotas and data volume before any run. No automatic field expansion or deleted-record ingestion. Id maps as id, Name as string; the inspector must verify current connector metadata before use.

Review civilian/DoD/State data/classification/ATO/SSP/APL/CDM/DoDIN/CMVP/privacy/records/residency/transfer/support boundaries including Salesforce, AWS service intermediates, output and logs. A FIPS API endpoint or Salesforce PrivateLink flag does not authorize all hops or certify a cryptographic module. AppFlow temporarily stages transferred data in an intermediate S3 bucket encrypted with the selected flow key; AWS documents a7day lifecycle for that intermediate bucket. Account for this boundary/retention before approval; deleting the flow is not immediate intermediate-data erasure. Destination encryption does not retroactively change existing objects or protect source connection secrets by itself.

Existing bucket policy must already permit exact-flow service writes. BUCKET-POLICY-MERGE.json is a proposed statement MERGE, not a complete replacement policy and never applied automatically. Owner reviews unique statement IDs, exact SourceAccount/SourceArn and destination prefix alongside existing denies, ownership/versioning/public blocks/retention/ObjectLock/replication/endpoint policies. Source-IP allowlists alone are unsuitable because AppFlow uses a VPC endpoint for S3 delivery. Existing customer key/service grants/key policy must allow the approved flow; review AppFlow's service-side key-policy/grant behavior, do not overwrite a shared key policy or guess a broad grant. Native flow creation does not attach the console's automatic S3 bucket permissions. Verify the owner-approved merge before plan/apply.

Run python INSPECT.py with approved boto3/botocore and metadata credentials. It checks exact owner/private provisioned profile/instance, metadata-and-authorization PrivateLink flag, selected schema fields/retrievable types, same-owner/region versioned private destination/default exact customer key, literal approved bucket-policy merge statements and empty destination prefix. It does not read records/object bodies or secret values and does not prove effective deny/key/endpoint policies or data-plane encryption/authorization. Existing flow names are rejected. Run init/validate/plan in an approved protected state boundary after owner preflight. Review the one exact new on-demand flow, projection plus individual mappings, customer key and all data boundaries. Apply only the approved plan. Run python INSPECT.py --check afterward: it compares exact flow/source/destination/key/trigger/tasks and requires no prior execution or output data. Do not treat Active/Draft flow metadata as a successful data transfer. Restrict StartFlow permissions.

Only after independent owner change approval, run START-APPROVED.ps1 -ApproveTransfer with approved Python and AWS CLI2. It reruns the exact first-stage check, reserves TRANSFER-REQUEST.json with CreateNew before the network call, supplies its saved UUID client token and verified regional FIPS endpoint to one StartFlow CLI invocation with AWS_MAX_ATTEMPTS=1, verifies response flow ARN/execution ID and saves TRANSFER-RECEIPT.json exclusively. It restores the prior retry environment setting. Existing request/receipt blocks another invocation; preserve these files and reconcile ambiguous results without deleting them to retry. Local reservation is not a global lock across copies/operators and does not prove an exactly-once transfer. Coordinate single-run ownership independently. The script is exported only; this toolkit never runs it automatically.

Starting transfers real Salesforce records into S3 and can consume API/transfer/KMS/request charges. This is a full on-demand extract of selected fields, not CDC. After submission run python INSPECT.py --check --execution <exact-receipt-ID>; it reads bounded execution metadata, requires the unique exact receipt Successful with no reported errors and prints record/byte counts, dataIntegrityProven:false and owner reconciliation required. A still-running/failed/unknown run fails inspection; it does not start/retry anything. Independently verify intended S3 run prefix, record integrity/counts/classification/encryption/retention and permitted/denied access in the authorized boundary. Control-plane Successful is not a complete migration. Source-specific size/API quotas and deleted/late/changing source records need a reconciliation strategy.

For repeated or production migration, approve immutable source/destination ownership, filters/delta/CDC logic, deterministic deduplication/checkpoints, failed-record handling, API limits and downstream consumers separately. This initial flow has no SaaS mutations or automatic cutover, and no scheduler to stop. Rollback quiesces owner-triggered transfers/consumers, reconciles exact execution outputs and restores previous approved consumer/source state; deleting objects/flow does not undo downstream work or immediately purge intermediates. prevent_destroy protects accidental flow removal, not in-place updates or remote service operations. Retain actual run receipts/policy/data/records/key/state evidence and separately authorize decommission.

https://docs.aws.amazon.com/appflow/latest/userguide/create-flow-api.html
https://docs.aws.amazon.com/appflow/latest/userguide/salesforce.html
https://docs.aws.amazon.com/appflow/latest/userguide/s3-policies-management.html
https://docs.aws.amazon.com/appflow/latest/userguide/data-protection.html
https://docs.aws.amazon.com/general/latest/gr/appflow.html
`;
