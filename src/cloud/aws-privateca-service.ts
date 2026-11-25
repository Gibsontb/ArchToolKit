import type {Blueprint} from '../kit/blueprint.ts';
import {error,type Finding} from '../core/findings.ts';
import {blk,dat,hcl,output,res,x} from '../terraform/blueprints/migration/common.ts';
import {awsServiceModule,awsServiceRegion} from './aws-service-module.ts';
import {privateCaInspection,privateCaCsrExport} from './aws-privateca-files.ts';
export const PCA_PROFILES={rsa2048:{key:'RSA_2048',sign:'SHA256WITHRSA'},rsa4096:{key:'RSA_4096',sign:'SHA384WITHRSA'},p256:{key:'EC_prime256v1',sign:'SHA256WITHECDSA'},p384:{key:'EC_secp384r1',sign:'SHA384WITHECDSA'}}as const;
export const AWS_PRIVATECA_SERVICE={
  id:'aws_service_privateca_subordinate',label:'Stage a general-purpose enterprise subordinate CA and export its CSR',
  description:'New hardware-protected subordinate key/CSR with OCSP configuration, awaiting enterprise parent signature. Monthly CA charges start at creation. No new root trust, automatic activation or issuance grants.',
  emits:['aws_acmpca_certificate_authority'],
  inputs:[awsServiceRegion,{id:'name',label:'Authority resource label',control:'text'},
    {id:'account',label:'Expected authority owner account ID',control:'text'},
    {id:'common_name',label:'Approved CA subject common name',control:'text'},
    {id:'organization',label:'Approved subject organization',control:'text'},
    {id:'unit',label:'Subject organizational unit (optional)',control:'text'},
    {id:'country',label:'Subject country code',control:'text',default:'US'},
    {id:'profile',label:'Owner-approved CA key / issuance signing profile',control:'select',default:'rsa4096',options:[{value:'rsa2048',label:'RSA2048 / SHA256-RSA'},{value:'rsa4096',label:'RSA4096 / SHA384-RSA'},{value:'p256',label:'ECDSA P256 / SHA256-ECDSA'},{value:'p384',label:'ECDSA P384 / SHA384-ECDSA'}]},
    {id:'approved',label:'PKI owner approved subordinate CSR, HSM standard, OCSP and charges from creation',control:'select',default:'false',options:[{value:'false',label:'Approval not recorded'},{value:'true',label:'Approved enterprise subordinate staging'}]},
  ],
  build(values):ReturnType<typeof awsServiceModule>{
    const findings:Finding[]=[],reject=(path:string,message:string)=>findings.push(error('aws.privateca.'+path,message,{path}));
    const text=(key:string)=>String(values[key]??'').trim(),region=text('aws_region'),name=text('name'),account=text('account'),commonName=text('common_name'),organization=text('organization'),unit=text('unit'),country=text('country'),profile=text('profile');
    if(!['us-east-1','us-east-2','us-west-1','us-west-2'].includes(region))reject('aws_region','Initial workflow covers four US commercial Private CA FIPS regions. GovCloud endpoint/HSM offering requires separate qualification, not an invented FIPS URL.');
    if(!/^[a-z][a-z0-9-]{1,38}[a-z0-9]$/.test(name))reject('name','Use3–40 lowercase letters/digits/internal hyphens.');
    if(!/^\d{12}$/.test(account))reject('account','Use the12-digit CA owner account.');
    for(const [key,value]of [['common_name',commonName],['organization',organization],['unit',unit]]as const)if((key!=='unit'||value)&&(!/^[A-Za-z0-9][A-Za-z0-9 ._-]{1,63}$/.test(value)))reject(key,'Use2–64 approved subject characters: letters, digits, spaces, dots, underscores/hyphens; subject metadata is not secret-safe storage.');
    if(!/^[A-Z]{2}$/.test(country))reject('country','Use the approved two-letter uppercase country code.');
    if(!(profile in PCA_PROFILES))reject('profile','Select a supported key/signing profile and verify parent/client compatibility.');
    if(text('approved')!=='true')reject('approved','Record PKI owner approval for key/subject/HSM/OCSP and immediate CA charges.');
    const algorithm=PCA_PROFILES[profile as keyof typeof PCA_PROFILES]??PCA_PROFILES.rsa4096,subject={CommonName:commonName,Organization:organization,Country:country,...(unit?{OrganizationalUnit:unit}:{})};
    const result=awsServiceModule(region,[blk('provider',{alias:'authority',region,use_fips_endpoint:true,allowed_account_ids:[account]},[],['aws']),dat('aws_caller_identity','current',{}),
      res('aws_acmpca_certificate_authority','configured',{provider:x('aws.authority'),type:'SUBORDINATE',usage_mode:'GENERAL_PURPOSE',enabled:true,key_storage_security_standard:'FIPS_140_2_LEVEL_3_OR_HIGHER',permanent_deletion_time_in_days:30,tags:x(hcl({Name:name}))},[
        blk('certificate_authority_configuration',{key_algorithm:algorithm.key,signing_algorithm:algorithm.sign},[blk('subject',{common_name:commonName,organization,country,...(unit?{organizational_unit:unit}:{})})]),
        blk('revocation_configuration',{},[blk('ocsp_configuration',{enabled:true})]),
        blk('lifecycle',{prevent_destroy:true},[blk('precondition',{condition:x('data.aws_caller_identity.current.account_id == '+JSON.stringify(account)),error_message:'Require exact PKI owner account and prior subject/HSM/revocation/parent approval; pending CAs already incur charges.'}),blk('postcondition',{condition:x('startswith(self.arn, '+JSON.stringify('arn:aws:acm-pca:'+region+':'+account+':certificate-authority/')+')'),error_message:'Actual CA ARN must match approved owner and region.'})]),
      ]),output('certificate_authority_arn','aws_acmpca_certificate_authority.configured.arn'),output('certificate_signing_request','aws_acmpca_certificate_authority.configured.certificate_signing_request','Public CSR with controlled infrastructure subject metadata; export only to approved PKI boundary.',true)],GUIDE,findings);
    return {...result,files:{...result.files,'INSPECT.py':privateCaInspection,'GET-CSR.ps1':privateCaCsrExport,'CA-CONFIG.json':JSON.stringify({region,name,account,profile,algorithm,subject,storage:'FIPS_140_2_LEVEL_3_OR_HIGHER'},null,2)+'\n'}};
  },
} satisfies Blueprint;
const GUIDE=`# Enterprise subordinate Private CA CSR staging and owner activation procedure

Creates one GENERAL_PURPOSE SUBORDINATE key/authority with exact approved subject/key/signing profile, requested FIPS_140_2_LEVEL_3_OR_HIGHER key-storage standard, AWS-managed OCSP and30day deletion recovery window. Initial four US commercial FIPS control API regions. Native enabled=true does NOT mean usable issuance: a new subordinate is PENDING_CERTIFICATE until an approved parent-signed CA certificate/chain is imported. The pinned provider reads pending as enabled (status is not DISABLED), so setting enabled=false is not a substitute for a staging security boundary. No self-signed root, trust-store installation, certificate issuance, ACM grants/resource policy/RAM sharing, parent signing or activation is automated. Root/short-lived/CRL/customOCSP/connector/PQC and GovCloud HSM/endpoint designs are separate unqualified variants.

AWS bills a monthly CA price starting at CREATE, including pending staging. Do not assume waiting for parent signing or no issued certificates means free. Approve cost/cleanup ownership and parent signing timeline first. Initial four classic profiles are explicitly paired; parent signature algorithm and this subordinate's later issuance algorithm are different decisions. Verify actual parent/client/HSM capabilities and policy; don't infer current ML-DSA/RSA3072/P521 support from a newer API when this workflow/pinnedprovider5.100hasn'tqualifiedit. The storage-standard enum namesFIPS140-2; it is NOT blanket FIPS140-3/CMVP authorization. Obtain exact offering/module/version/mode evidence and PKI policy approval, with no silent downgrade toLevel2.

Before creating a key approve actual civilian/DoD/State classification/ATO/SSP/APL/CDM/DoDIN/CMVP, subject/CSR/certificate/serial/log metadata, privacy/residency/records/retention, PKI hierarchy/policy OIDs/name constraints/path length/key usages/validity/revocation/client reachability, root trust ownership and incident procedures. No private key is exportable through this package; certificates/CSR are public-key material but subject metadata can still be sensitive. FIPS control API and HSM labels do not prove complete PKI/application compliance. OCSP depends on client support/reachable responder and actual certificate AIA; it is not proof revocation is enforced, and it doesn't replace an approved CRL/offline-boundary design where required.

Run python INSPECT.py preflight with approved boto3/botocore. It checks exact caller and paginated SELF-owned CA inventory/tags for a conflicting Name; no signing/key/CSR retrieval or writes. Names are tags, not a concurrency lock; coordinate exact resource/state ownership. Run terraform init/validate/plan with protected state, review new key/subject/revocation/monthly charges and owner-apply. New CA should be PENDING_CERTIFICATE; wait for service completion and run python INSPECT.py --ca <exact-certificate_authority_arn>. It checks actual owner/region/type/state/profile/subject/HSM standard/OCSP/noCRL/newtag; no active issuance/trust is implied. Terraform prevent_destroy and30day deletion window are guards, not immutable key/evidence retention or automatic cost shutdown.

Export public CSR from the protected applied module using powershell -NoProfile -File GET-CSR.ps1 -OutputPath <approved-new-local-path>. The PS5-compatible helper reads ONLY terraform output -raw certificate_signing_request, validates the CSR PEM envelope and creates a new UTF8withoutBOM file without overwriting. It does not generate/export a private key, send a CSR to an issuer or print subject/CSR body. The output is marked sensitive in Terraform to keep normal apply output from dumping infrastructure metadata; state still contains it. Verify exact CA ARN/module context and CSR public key/subject/signature through approved PKI tooling before submitting it through the authorized enterprise signing process.

Parent signing is a PKI authorization, not a checkbox the toolkit can prove. The parent PKI owner must verify the exact CSR/public key/approved subject and sign a subordinate CA certificate with reviewed critical basicConstraints CA=true, intended path-length constraints (leaf-issuingonly pathLen0 where approved), keyCertSign/cRLSign, policies/name constraints/AIA/CDP, validity inside all parents and approved algorithms. Do not create a new root or broaden client trust to bypass a rejected chain. Obtain the complete approved parent chain and independently pinned trusted root through the authorized channel; preserve provenance, fingerprints, serials and approvals.

Owner validation reference with an approved OpenSSL installation (not run automatically):
openssl req -in subordinate.csr.pem -noout -verify -subject
openssl x509 -in signed-subordinate.pem -noout -text -fingerprint -sha256
openssl verify -x509_strict -purpose any -CAfile approved-root.pem -untrusted parent-chain.pem signed-subordinate.pem
Compare CSR and signed certificate public-key/SPKI SHA256, exact subject/validity/key usages/path constraints/criticalextensions and the independently approved root fingerprint. The verify command does not by itself prove legal PKI policy, current OCSP/CRL revocation or client trust; verify those separately. Never include a private key in these files or upload it to AWS Private CA.

ONLY after PKI owner validation/change approval, manually import the signed public CA certificate and chain using the exact returned ARN and selected regional FIPS endpoint:
aws acm-pca import-certificate-authority-certificate --certificate-authority-arn <exact-returned-arn> --certificate fileb://signed-subordinate.pem --certificate-chain fileb://parent-chain.pem --region <selected-region> --endpoint-url https://acm-pca-fips.<selected-region>.amazonaws.com
This is a REAL activation when the owner executes it; no import command is run by toolkit export/inspection. Preserve certificate/chain ownership and state under the approved process. If managing activation later with native aws_acmpca_certificate_authority_certificate, import/reconcile that state separately instead of duplicating activation or replacing a key. No parent certificate/private key is embedded in this package.

After approved import run python INSPECT.py --ca <exact-arn> --active. It requires actual ACTIVE/profile/subject/HSM/OCSP metadata, no ACM service permissions and no resource-based policy in this initial flow. Same-account IAM deployment/issuer permissions are NOT disproved by absence of ACM grants/resource policy: independently restrict issuance roles/templates/subject/validity and test allowed/denied issuance with PKI owners before service use. The checker reads no certificate bodies or private keys and does not issue/revoke certificates or prove chain trust/client revocation. Integrate active validated issuer with the separate RolesAnywhere or private certificate builder only after PKI acceptance; do not grant broad issuer/ACM permissions as a troubleshooting shortcut.

Migration flow: inventory existing roots/intermediates/certificate consumers/expiry/revocation/trust/pinning, approve hierarchy/overlap/issuerpolicy, stagekey/CSR and parent signing, verify chain/activation, rehearse short controlled client/server certificate issuance and actual trust/mTLS/revocation/renewal/failure paths, map source/target identities without copying private keys, cut over exact clients/services under one owner, retain old issuer/revocation availability until all dependent certificates/trust paths are resolved. Capture evidence in project plan. Disabling an old CA can stop issuance while supporting revocation; deleting/replacing a CA can disrupt all dependents and automatic ACM renewal. No expiry/revocation/client-trust claim follows from ACTIVE alone.

Budget actual CAmonths from creation, issuance/OCSP/audit/storage/network/overlap and operational PKI costs using current regional terms, not VM CPU/RAM. Recovery/rotation/decommission require PKI approval, audit/certificate inventory, retained revocation/evidence and dependent client migration. prevent_destroy doesn't stop fees or outside API deletion, and deleting Terraform state leaves the authority live/billable. Retain state, approved chains/CSRs/serials/logs/records and reconcile parent revocation/successor trust before separately authorizing deletion. No automated trust distribution or TCO/project integration is claimed complete.

https://docs.aws.amazon.com/privateca/latest/userguide/create-CA.html
https://docs.aws.amazon.com/privateca/latest/userguide/PCACertInstall.html
https://docs.aws.amazon.com/privateca/latest/userguide/ca-lifecycle.html
https://docs.aws.amazon.com/general/latest/gr/pca.html
`;
