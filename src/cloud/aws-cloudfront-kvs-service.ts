import type {Blueprint} from '../kit/blueprint.ts';
import {error,type Finding} from '../core/findings.ts';
import {blk,dat,output,res,x} from '../terraform/blueprints/migration/common.ts';
import {awsServiceModule} from './aws-service-module.ts';
import {cloudFrontKvsInspection,cloudFrontFlagFunction} from './aws-cloudfront-kvs-files.ts';
export const AWS_CLOUDFRONT_KVS_SERVICE={
  id:'aws_service_cloudfront_kvs_flag',label:'Stage a global nonsecret feature flag and unpublished CloudFront Function',
  description:'New KeyValueStore, one boolean migration flag and runtime2.0 DEVELOPMENT function. No live distribution association, publishing, imports or existing store changes.',
  emits:['aws_cloudfront_key_value_store','aws_cloudfrontkeyvaluestore_key','aws_cloudfront_function'],
  inputs:[{id:'aws_region',label:'Control API location (data is global)',control:'select',default:'us-east-1',options:[{value:'us-east-1',label:'US East1 control API — global edge data'}]},
    {id:'name',label:'New store label (nonsecret)',control:'text'},
    {id:'account',label:'Expected store / function owner account ID',control:'text'},
    {id:'enabled',label:'Initial migration feature flag',control:'select',default:'false',options:[{value:'false',label:'Disabled (false)'},{value:'true',label:'Enabled (true)'}]},
    {id:'approved',label:'Owner approved global nonsecret flag replication and API cryptographic boundary',control:'select',default:'false',options:[{value:'false',label:'Approval not recorded'},{value:'true',label:'Approved global edge flag boundary'}]},
  ],
  build(values):ReturnType<typeof awsServiceModule>{
    const findings:Finding[]=[],reject=(path:string,message:string)=>findings.push(error('aws.cloudfront.kvs.'+path,message,{path}));
    const region=String(values.aws_region??''),name=String(values.name??'').trim(),account=String(values.account??'').trim(),enabled=String(values.enabled??'');
    if(region!=='us-east-1')reject('aws_region','This commercial global workflow uses US East1 control APIs; data is not confined to that region.');
    if(!/^[a-z][a-z0-9_-]{2,49}$/.test(name))reject('name','Use3–50 lowercase letters/digits/underscores/hyphens, no sensitive metadata.');
    if(!/^\d{12}$/.test(account))reject('account','Use the12-digit commercial store/function owner account.');
    if(!['true','false'].includes(enabled))reject('enabled','Select the nonsecret boolean flag value.');
    if(String(values.approved)!=='true')reject('approved','Record owner approval for global nonsecret data and separate KVS API cryptographic boundary.');
    const functionName=name+'-flag';
    const result=awsServiceModule(region,[
      blk('provider',{alias:'control',region,use_fips_endpoint:true,allowed_account_ids:[account]},[],['aws']),
      blk('provider',{alias:'data',region,use_fips_endpoint:false,allowed_account_ids:[account]},[],['aws']),dat('aws_caller_identity','current',{}),
      res('aws_cloudfront_key_value_store','configured',{provider:x('aws.control'),name,comment:'Nonsecret migration feature flag; globally replicated'},[blk('lifecycle',{prevent_destroy:true},[blk('precondition',{condition:x('data.aws_caller_identity.current.account_id == '+JSON.stringify(account)),error_message:'Require exact approved global store/function owner; run INSPECT.py before creation.'}),blk('postcondition',{condition:x('startswith(self.arn, '+JSON.stringify('arn:aws:cloudfront::'+account+':key-value-store/')+')'),error_message:'Actual store ARN must belong to approved global commercial owner.'})])]),
      res('aws_cloudfrontkeyvaluestore_key','flag',{provider:x('aws.data'),key_value_store_arn:x('aws_cloudfront_key_value_store.configured.arn'),key:'migration_enabled',value:enabled},[blk('lifecycle',{prevent_destroy:true})]),
      res('aws_cloudfront_function','configured',{provider:x('aws.control'),name:functionName,runtime:'cloudfront-js-2.0',publish:false,comment:'Unpublished nonsecret flag request header example',code:x('file("FEATURE-FLAG.js")'),key_value_store_associations:x('[aws_cloudfront_key_value_store.configured.arn]'),depends_on:x('[aws_cloudfrontkeyvaluestore_key.flag]')},[blk('lifecycle',{prevent_destroy:true})]),
      output('store_arn','aws_cloudfront_key_value_store.configured.arn'),output('store_id','aws_cloudfront_key_value_store.configured.id'),output('function_arn','aws_cloudfront_function.configured.arn')],GUIDE,findings);
    return {...result,files:{...result.files,'INSPECT.py':cloudFrontKvsInspection,'FEATURE-FLAG.js':cloudFrontFlagFunction,'KVS-CONFIG.json':JSON.stringify({region,name,account,functionName,key:'migration_enabled',value:enabled},null,2)+'\n'}};
  },
} satisfies Blueprint;
const GUIDE=`# Global nonsecret CloudFront feature flag staging

Creates a NEW commercial global KeyValueStore, one migration_enabled boolean key and one unpublished CloudFront Function DEVELOPMENT version using runtime2.0 and exactly that store. This is a real populated, code-associated flag workflow, not an empty generic store. It does not publish the function or attach/change any distribution/cache behavior/origin, send viewer requests, import S3 content or touch an existing store. Only true/false values are accepted: no secrets, tokens, personal data, arbitrary JSON or classified content in keys/state/exports. Native key values are not marked sensitive and appear in Terraform state/plans. Terraform prevent_destroy guards all three resources; no keys_exclusive resource that deletes unlisted keys is emitted.

US East1 is the CONTROL API location, NOT a regional data residency boundary. CloudFront replicates data globally to edge locations and decrypts values in memory when functions execute. Owner must approve actual global replication, civilian/DoD/State classification/ATO/APL/CDM/DoDIN/privacy/CMVP/residency/support/records/key/log/access/cost requirements before any deployment. There is no customer KMS selector here. CloudFront control APIs use the FIPS alias; the account-specific global KeyValueStore data API uses its separate HTTPS/SigV4A endpoint and has no FIPS endpoint in the cited service table. Do not treat control FIPS as data API validation. If the required boundary cannot authorize that offering/global data handling, do not deploy this workflow. This is not a GovCloud/ClassNet recipe.

Prepare approved AWS provider5.100+within the pinned major, protected state and least exact store/function/key deployment/IAM permissions. Data API temporary credentials require STS version2 session tokens and SigV4A support; use owner-approved regional STS/SDK crypto tooling rather than changing account token preferences automatically. The store control ETag and key-content data ETag are different and NOT interchangeable. Native key resource handles data API concurrency; coordinate one authoritative writer and do not use console/SDK writes concurrently with Terraform ownership. No plaintext credentials or automatic global STS setting change is emitted.

Run python INSPECT.py first with approved boto3/botocore and, for data checks, the SDK SigV4A runtime dependencies. It requires exact owner, absent store name and absent DEVELOPMENT/LIVE function names; denied/unsupported API calls do not establish absence. Review global service quotas and existing resource/state ownership. Run terraform init/validate/plan, review boolean value/global resources/charges and owner-apply the approved protected plan. Store/flag creation occurs before function association; publish=false keeps it unpublished. Actual apply still creates global data, not a regional sandbox. No live invocation or user traffic changes occur from this unassociated function.

After apply run python INSPECT.py --check --store-id <exact-store_id>. It checks exact READY store owner/UUID/globalARN, DEVELOPMENT runtime2.0/function identity/storeassociation and absent LIVE version. It separately reads KVS data metadata (oneitem) and only the known nonsecret boolean key; never enumerates arbitrary keys/values. It checks actual value, but does not print it or ETags. Store/function metadata does not prove edge propagation, effective IAM, deployed viewer behavior or no outside distribution associations. Use actual owner API/distribution inventory and appropriate access tests before any publication. The checker does not run TestFunction, publish or invoke the function.

FEATURE-FLAG.js overwrites x-migration-enabled on the REQUEST with true only for the exact stored string true; missing/read errors fail to false. It preserves URI, method, query and other headers. This header is a demonstration feature/cohort signal, not access authorization, a redirect, origin switching or a migrated application. Do not trust a viewer-supplied equivalent header or grant access from this flag. If published later, review origin request forwarding/cache-key behavior and strip external bypass paths; changing a request header can change application behavior/cache variation only if the reviewed distribution/application uses it. Never publish/associate it blindly across behaviors.

Owner testing: test both true/false/readfailure with approved synthetic viewer events in DEVELOPMENT through actual CloudFront TestFunction, inspect computation utilization/permissions/association, wait for approved data propagation and reconcile exact code+flag versions. Do not expose tokens/cookies/body data in test or logs. Independently approve publication to LIVE and an exact viewer-request cache behavior under the existing distribution change process. Capture former function/behavior/flag/config/ETags and a rollback plan. No live publication/distribution edit is generated or run automatically. For migration waves use owner-controlled cohorts and application integrity/latency/side-effect acceptance, not this boolean alone. CloudFront/global edge suitability must be established before using it in any regulated migration.

Cost includes actual KeyValueStore operations/storage and function invocations/distribution delivery/logging; no fixed discount or VM-capacity inference. Keep existing source route/function and evidence until cutover accepted. Rollback reconciles desired flag/code/distribution configuration, actual propagation/cache effects and new writes/side effects. Deleting store/state does not undo prior application behavior. Decommission only after removing approved associations, retention/evidence/owner checks and separately authorized protected-resource changes. TCO/inventory/project integration and broader import/multi-key/bulk-update/use cases remain additional workflows.

https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/kvs-with-functions.html
https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/kvs-with-functions-kvp.html
https://docs.aws.amazon.com/general/latest/gr/cf_region.html
`;
