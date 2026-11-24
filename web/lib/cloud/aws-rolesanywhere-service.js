import { error,              } from '../core/findings.js';
                                                     
import { blk, dat, e, hcl, jsonencode, output, res, x } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.js';
const regions = ['us-east-1','us-east-2','us-west-1','us-west-2','af-south-1','ap-east-1','ap-east-2','ap-south-1','ap-south-2','ap-southeast-1','ap-southeast-2','ap-southeast-3','ap-southeast-4','ap-southeast-5','ap-southeast-6','ap-southeast-7','ap-northeast-1','ap-northeast-2','ap-northeast-3','ca-central-1','ca-west-1','eu-central-1','eu-central-2','eu-west-1','eu-west-2','eu-west-3','eu-north-1','eu-south-1','eu-south-2','il-central-1','mx-central-1','me-south-1','me-central-1','sa-east-1','us-gov-east-1','us-gov-west-1'];
export const AWS_ROLESANYWHERE_SERVICE = {
  id: 'aws_service_rolesanywhere', label: 'Set up certificate-based on-premises S3 access',
  description: 'Existing AWS Private CA, disabled trust anchor/profile, new certificate-restricted role and exact S3-prefix read scope. Includes inspect/activation code and temporary-credential client configuration.',
  emits: ['aws_rolesanywhere_trust_anchor', 'aws_rolesanywhere_profile', 'aws_iam_role', 'aws_iam_role_policy'],
  inputs: [
    { ...awsServiceRegion, options: awsServiceRegion.options .filter(option => regions.includes(option.value)), hint: 'Regions currently listed for Roles Anywhere by AWS; this recipe does not qualify China/isolated/sovereign sites.' },
    { id: 'name', label: 'Workload access name', control: 'text' },
    { id: 'ca', label: 'Existing issuing AWS Private CA ARN', control: 'text', hint: 'Same account/region, ACTIVE. Certificate issuance, protected workload private keys and approved revocation publication remain PKI-owner responsibilities.' },
    { id: 'subject', label: 'Exact workload certificate Subject CN', control: 'text', hint: 'Literal identity, no wildcard. PKI issuance must prevent unauthorized reuse of this CN.' },
    { id: 'issuer', label: 'Exact issuing CA Common Name', control: 'text', hint: 'This bounded recipe uses a workload certificate issued directly by the selected Private CA.' },
    { id: 'bucket', label: 'Existing private S3 bucket', control: 'text' },
    { id: 'prefix', label: 'Allowed artifact/data prefix', control: 'text', default: 'approved/', hint: 'Literal prefix ending in /. Only object reads and scoped listing are granted, not migration writes.' },
    { id: 'kms', label: 'Optional object encryption KMS key ARN', control: 'text', hint: 'Exact same-account regional key for source objects. Mixed-key datasets require a separately reviewed extension.' },
    { id: 'duration', label: 'Temporary credential lifetime', control: 'select', default: '900', options: [{ value: '900', label: '15 minutes' }, { value: '1800', label: '30 minutes' }, { value: '3600', label: '60 minutes' }] },
  ],
  build(values)                                      {
    const findings            = [], reject = (path        , message        ) => findings.push(error('aws.rolesanywhere.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), partition = awsServicePartition(region), name = String(values.name ?? '').trim(), ca = String(values.ca ?? '').trim(), subject = String(values.subject ?? '').trim(), issuer = String(values.issuer ?? '').trim(), bucket = String(values.bucket ?? '').trim(), prefix = String(values.prefix ?? '').trim(), kms = String(values.kms ?? '').trim(), duration = Number(values.duration);
    const match = new RegExp('^arn:' + partition + ':acm-pca:' + region + ':(\\d{12}):certificate-authority/[a-f0-9-]{36}$').exec(ca), account = match?.[1] ?? '';
    if (!regions.includes(region)) reject('aws_region', 'Choose a currently documented Roles Anywhere region.');
    if (!/^[A-Za-z][A-Za-z0-9_-]{2,39}$/.test(name)) reject('name', 'Use a letter followed by 2–39 letters, digits, underscores or hyphens.');
    if (!match) reject('ca', 'Use an existing same-account regional AWS Private CA ARN.');
    if (!/^[A-Za-z0-9][A-Za-z0-9_+=,.@-]{1,60}$/.test(subject)) reject('subject', 'Use an exact 2–61 character workload CN with supported identity characters and no wildcard.');
    if (!/^[A-Za-z0-9][A-Za-z0-9 _+=,.@:/-]{0,127}$/.test(issuer)) reject('issuer', 'Use the exact issuing CA Common Name without wildcard/control characters.');
    if (!/^(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes('..')) reject('bucket', 'Use an existing same-account regional private bucket.');
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,198}\/$/.test(prefix) || prefix.includes('//') || prefix.split('/').some(part => ['.', '..'].includes(part))) reject('prefix', 'Use a literal relative prefix ending in /, without wildcard/traversal.');
    if (kms && !new RegExp('^arn:' + partition + ':kms:' + region + ':' + account + ':key/(?:[a-f0-9-]{36}|mrk-[a-f0-9]{32})$').test(kms)) reject('kms', 'Use an existing same-account regional object-encryption key ARN.');
    if (![900, 1800, 3600].includes(duration)) reject('duration', 'Choose a listed credential duration.');
    const bucketArn = 'arn:' + partition + ':s3:::' + bucket;
    const policy = { Version: '2012-10-17', Statement: [
      { Effect: 'Allow', Action: ['s3:GetBucketLocation'], Resource: bucketArn },
      { Effect: 'Allow', Action: ['s3:ListBucket'], Resource: bucketArn, Condition: { StringLike: { 's3:prefix': [prefix, prefix + '*'] } } },
      { Effect: 'Allow', Action: ['s3:GetObject', 's3:GetObjectVersion'], Resource: bucketArn + '/' + prefix + '*' },
      ...(kms ? [{ Effect: 'Allow', Action: ['kms:Decrypt', 'kms:DescribeKey'], Resource: kms }] : []),
    ] };
    const trust = { Version: '2012-10-17', Statement: [{
      Effect: 'Allow', Principal: { Service: 'rolesanywhere.amazonaws.com' }, Action: ['sts:AssumeRole', 'sts:TagSession', 'sts:SetSourceIdentity'],
      Condition: { ArnEquals: { 'aws:SourceArn': e('aws_rolesanywhere_trust_anchor.configured.arn') }, StringEquals: { 'aws:SourceAccount': account, 'aws:PrincipalTag/x509Subject/CN': subject, 'aws:PrincipalTag/x509Issuer/CN': issuer } },
    }] };
    const guide = [
      '# Certificate-based workload S3 access',
      '## Prepare PKI and source data\nThis bounded workflow uses an existing AWS Private CA to authenticate an on-premises workload for read-only access to one S3 prefix. External CA bundles, arbitrary managed-policy profiles, certificate issuance, HSM/TPM/PKCS11 provisioning and workload deployment are separate extensions. Use a directly issued X.509v3 workload certificate with Digital Signature, non-CA constraints, SHA256-or-stronger signing, correct validity and the exact subject/issuer CNs. Enforce unique authorized CN issuance, rotation and protected private-key custody in the PKI process. The generator never requests, creates, reads or stores a workload private key or static AWS access key.',
      'Verify bucket ownership/private blocks, allowed data boundary, existing object keys/versions, encryption/key policy and network access. Only scoped S3 reads/listing and optional exact-key decrypt are granted. The same policy is a profile session-policy intersection, not an extra grant. Trust requires the canonical anchor ARN, source account and exact certificate identity tags; an arbitrary certificate from a trusted CA is not sufficient. Review current service/partition availability and costs, CloudTrail coverage and identity/source-identity behavior before deployment.',
      '## Provision disabled resources\nRun terraform init, terraform validate and terraform plan -out=service.tfplan. Review the Private CA metadata/identity, disabled anchor/profile, new dedicated role/trust, session-policy intersection, prefix and duration; apply the reviewed plan. Both resources remain disabled after creation. Terraform ignores later enabled-state changes so explicit owner activation is not silently undone by apply. The anchor/profile/role have prevent_destroy. No existing role trust or account-wide PKI setting is replaced.',
      '## Configure revocation before activation\nCurrent AWS supports imported CRLs and automatic CDP checking; provider5 does not expose automatic crlDpRevocationEnabled. After owner-configured Private CA CRL publication, run OPERATE.py --enable-cdp --confirm-publication while both resources remain disabled. It verifies current metadata/CRL-publication configuration and sends the explicit automatic-CDP update through the current API; use a current approved SDK supporting this field. The PKI owner must first verify approved HTTP(S) CRL distribution points in every issued workload certificate. The service can ignore missing/unsupported CDPs, so merely enabling the anchor flag is not proof of effective revocation. Establish reachable current CRLs, publication/refresh alarms and an issuance policy requiring valid CDPs. Do not make protected CA/CRL data public just to satisfy this workflow without the approved publication design. OCSP is not a Roles Anywhere substitute. Imported-CRL-only operations require a separate extension here. Changes to CA validity require an explicit trust-anchor update, not just a CA renewal.',
      '## Inspect and activate explicitly\nInstall approved requirements.txt dependencies. Run OPERATE.py to inspect the exact applied account, CA/issuer, anchor/profile source and restrictions, new role/trust/policy, bucket ownership/private blocks and automatic-revocation flag. Default inspection never enables access. Once PKI/certificate/CDP/revocation, data-owner and recovery checks are accepted, use OPERATE.py --activate --confirm-pki. It requires actual automatic-CDP checking and matching profile identity mappings, enables the anchor then profile if needed, and reports request acceptance. These writes are not atomic and are not retried; inspect partial state after an error. This does not mint credentials or prove a leaf certificate/chain/key or live revocation outcome.',
      '## Configure the workload\nReview terraform output -raw aws_config_example, replace the approved helper/certificate/private-key file placeholders and write a protected standalone AWS config. Install the official aws_signing_helper through the approved software process. Use the SDK/CLI normal credential_process path so the helper returns temporary credentials directly to the SDK; do not run the helper merely to print credential JSON into a terminal/log. Use an approved CA-signed client certificate and protected private key on the workload. No generated file includes private-key material. Test aws sts get-caller-identity with this explicit profile, then authorized-prefix reads and denials for other prefixes/writes/roles using disposable approved data. The identity check obtains temporary credentials when the owner runs it; it is never executed during generation/local tests.',
      '## Rotate, revoke and recover\nTest an actual revoked certificate and unavailable/expired CRL, unauthorized CN/issuer, wrong account/anchor and disabled profile. Automatic CRL refresh can take time; do not promise immediate revocation. Existing temporary credentials can remain valid until expiration unless separately revoked through approved IAM session controls. Disabling the profile/anchor prevents new issuance, not proof of invalidating every issued credential. Preserve audit evidence, rotate certs with tested overlap, verify replacement clients and only then revoke old certificates. Document partial activation/rollback and recovery for CA/key outages. No credential, object read, cloud apply or activation occurs during local generation/validation.',
      'https://docs.aws.amazon.com/rolesanywhere/latest/userguide/trust-model.html\nhttps://docs.aws.amazon.com/rolesanywhere/latest/userguide/credential-helper.html\nhttps://docs.aws.amazon.com/rolesanywhere/latest/userguide/getting-started.html',
    ].join('\n\n') + '\n';
    const result = awsServiceModule(region, [
      dat('aws_caller_identity', 'current', {}), dat('aws_acmpca_certificate_authority', 'issuer', { arn: ca }), dat('aws_s3_bucket', 'source', { bucket }),
      ...(kms ? [dat('aws_kms_key', 'source', { key_id: kms })] : []),
      res('aws_rolesanywhere_trust_anchor', 'configured', { name, enabled: false, tags: x(hcl({ Name: name })) }, [
        blk('source', { source_type: 'AWS_ACM_PCA' }, [blk('source_data', { acm_pca_arn: ca })]),
        blk('lifecycle', { prevent_destroy: true, ignore_changes: x('[enabled]') }, [blk('precondition', { condition: x('data.aws_caller_identity.current.account_id == ' + JSON.stringify(account) + ' && data.aws_acmpca_certificate_authority.issuer.status == "ACTIVE" && data.aws_s3_bucket.source.region == ' + JSON.stringify(region) + (kms ? ' && data.aws_kms_key.source.enabled && data.aws_kms_key.source.key_spec == "SYMMETRIC_DEFAULT"' : '')), error_message: 'Use this account active issuing CA, regional source bucket and enabled symmetric object key.' })]),
      ]),
      res('aws_iam_role', 'reader', { name: name + '-certificate-reader', max_session_duration: 3600, assume_role_policy: x(jsonencode(trust)) }, [blk('lifecycle', { prevent_destroy: true })]),
      res('aws_iam_role_policy', 'reader', { name: name + '-source-read', role: x('aws_iam_role.reader.id'), policy: x(jsonencode(policy)) }),
      res('aws_rolesanywhere_profile', 'configured', { name, enabled: false, duration_seconds: duration, role_arns: x('[aws_iam_role.reader.arn]'), session_policy: x(jsonencode(policy)), tags: x(hcl({ Name: name })), depends_on: x('[aws_iam_role_policy.reader]') }, [blk('lifecycle', { prevent_destroy: true, ignore_changes: x('[enabled]') })]),
      output('roles_anywhere_job', '{ account = data.aws_caller_identity.current.account_id, region = ' + JSON.stringify(region) + ', anchor = aws_rolesanywhere_trust_anchor.configured.id, anchor_arn = aws_rolesanywhere_trust_anchor.configured.arn, profile = aws_rolesanywhere_profile.configured.id, profile_arn = aws_rolesanywhere_profile.configured.arn, role = aws_iam_role.reader.name, role_arn = aws_iam_role.reader.arn }'),
      output('aws_config_example', 'format(' + JSON.stringify('[profile ' + name + ']\nregion = ' + region + '\ncredential_process = "/approved/aws_signing_helper" credential-process --certificate "/approved/workload-cert.pem" --private-key "/protected/workload-key.pem" --trust-anchor-arn "%s" --profile-arn "%s" --role-arn "%s" --session-duration ' + duration + '\n') + ', aws_rolesanywhere_trust_anchor.configured.arn, aws_rolesanywhere_profile.configured.arn, aws_iam_role.reader.arn)'),
    ], guide, findings);
    const config = { name, region, partition, account, ca, subject, issuer, bucket, prefix, duration, policy };
    return { ...result, files: { ...result.files, 'ACCESS-CONFIG.json': JSON.stringify(config, null, 2) + '\n', 'OPERATE.py': rolesAnywhereOperator, 'requirements.txt': 'boto3>=1.44,<2\n' } };
  },
}                    ;

const rolesAnywhereOperator = [
  'import argparse, json, pathlib, subprocess, datetime, boto3',
  'from botocore.config import Config',
  'parser = argparse.ArgumentParser(); actions = parser.add_mutually_exclusive_group(); actions.add_argument("--activate", action="store_true"); actions.add_argument("--enable-cdp", action="store_true"); parser.add_argument("--confirm-pki", action="store_true"); parser.add_argument("--confirm-publication", action="store_true"); args = parser.parse_args()',
  'config = json.loads((pathlib.Path(__file__).resolve().parent / "ACCESS-CONFIG.json").read_text(encoding="utf-8"))',
  'job = json.loads(subprocess.check_output(["terraform", "output", "-json", "roles_anywhere_job"], text=True))',
  'if job["account"] != config["account"] or job["region"] != config["region"] or job["role"] != config["name"] + "-certificate-reader": raise RuntimeError("Unexpected applied account/region/role")',
  'prefix = "arn:" + config["partition"] + ":rolesanywhere:" + config["region"] + ":" + config["account"] + ":"',
  'if job["anchor_arn"] != prefix + "trust-anchor/" + job["anchor"] or job["profile_arn"] != prefix + "profile/" + job["profile"] or job["role_arn"] != "arn:" + config["partition"] + ":iam::" + config["account"] + ":role/" + job["role"]: raise RuntimeError("Unexpected canonical resource ARNs")',
  'session = boto3.Session(region_name=config["region"])',
  'if session.client("sts").get_caller_identity()["Account"] != config["account"]: raise RuntimeError("Unexpected operator account")',
  'ca = session.client("acm-pca").describe_certificate_authority(CertificateAuthorityArn=config["ca"])["CertificateAuthority"]',
  'if ca.get("Arn") != config["ca"] or ca.get("Status") != "ACTIVE" or ca.get("CertificateAuthorityConfiguration", {}).get("Subject", {}).get("CommonName") != config["issuer"]: raise RuntimeError("Require exact ACTIVE issuing CA/subject CN")',
  'now = datetime.datetime.now(datetime.timezone.utc)',
  'if ca.get("NotBefore") is None or ca.get("NotAfter") is None or ca["NotBefore"] > now or ca["NotAfter"] <= now: raise RuntimeError("Issuing CA is outside its validity period")',
  'service = session.client("rolesanywhere", config=Config(retries={"total_max_attempts":1,"mode":"standard"}))',
  'anchor = service.get_trust_anchor(trustAnchorId=job["anchor"])["trustAnchor"]',
  'profile = service.get_profile(profileId=job["profile"])["profile"]',
  'if anchor.get("trustAnchorArn") != job["anchor_arn"] or anchor.get("name") != config["name"] or anchor.get("source", {}).get("sourceType") != "AWS_ACM_PCA" or anchor["source"].get("sourceData", {}).get("acmPcaArn") != config["ca"]: raise RuntimeError("Trust anchor differs from package")',
  'if profile.get("profileArn") != job["profile_arn"] or profile.get("name") != config["name"] or profile.get("roleArns") != [job["role_arn"]] or profile.get("durationSeconds") != config["duration"] or json.loads(profile.get("sessionPolicy") or "{}") != config["policy"]: raise RuntimeError("Profile role/duration/session policy differs")',
  'mappings = {item["certificateField"]: {rule["specifier"] for rule in item.get("mappingRules", [])} for item in profile.get("attributeMappings", [])}',
  'if not all("CN" in mappings.get(field, set()) for field in ["x509Subject", "x509Issuer"]): raise RuntimeError("Require subject/issuer CN attribute mappings")',
  'iam = session.client("iam"); role = iam.get_role(RoleName=job["role"])["Role"]',
  'expected_trust = {"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"rolesanywhere.amazonaws.com"},"Action":["sts:AssumeRole","sts:TagSession","sts:SetSourceIdentity"],"Condition":{"ArnEquals":{"aws:SourceArn":job["anchor_arn"]},"StringEquals":{"aws:SourceAccount":config["account"],"aws:PrincipalTag/x509Subject/CN":config["subject"],"aws:PrincipalTag/x509Issuer/CN":config["issuer"]}}}]}',
  'actual_trust = role.get("AssumeRolePolicyDocument", {})',
  'if len(actual_trust.get("Statement", [])) == 1: actual_trust["Statement"][0]["Action"] = sorted(actual_trust["Statement"][0].get("Action", [])); expected_trust["Statement"][0]["Action"] = sorted(expected_trust["Statement"][0]["Action"])',
  'if role.get("Arn") != job["role_arn"] or actual_trust != expected_trust: raise RuntimeError("Actual role trust differs")',
  'if iam.get_role_policy(RoleName=job["role"], PolicyName=config["name"] + "-source-read").get("PolicyDocument") != config["policy"]: raise RuntimeError("Actual role data policy differs")',
  's3 = session.client("s3"); s3.head_bucket(Bucket=config["bucket"], ExpectedBucketOwner=config["account"])',
  'location = s3.get_bucket_location(Bucket=config["bucket"], ExpectedBucketOwner=config["account"]).get("LocationConstraint") or "us-east-1"',
  'if ("eu-west-1" if location == "EU" else location) != config["region"]: raise RuntimeError("Source bucket region differs")',
  'blocks = s3.get_public_access_block(Bucket=config["bucket"], ExpectedBucketOwner=config["account"])["PublicAccessBlockConfiguration"]',
  'if not all(blocks.get(flag) is True for flag in ["BlockPublicAcls","IgnorePublicAcls","BlockPublicPolicy","RestrictPublicBuckets"]): raise RuntimeError("Require all four source-bucket public blocks")',
  'if not args.activate and not args.enable_cdp: print(json.dumps({"metadata_checked":True,"anchor_enabled":anchor.get("enabled",False),"profile_enabled":profile.get("enabled",False),"automatic_cdp":anchor.get("crlDpRevocationEnabled",False),"credentials_minted":False})); raise SystemExit(0)',
  'if args.enable_cdp:',
  '    if not args.confirm_publication: raise RuntimeError("CDP setup requires --confirm-publication after approved certificate CDPs, CRL publication/reachability and refresh monitoring")',
  '    if anchor.get("enabled") or profile.get("enabled"): raise RuntimeError("This initial CDP setup requires both resources disabled; review changes to live authentication separately")',
  '    crl = ca.get("RevocationConfiguration", {}).get("CrlConfiguration", {})',
  '    if crl.get("Enabled") is not True or not crl.get("S3BucketName"): raise RuntimeError("Private CA must have owner-configured CRL publication before enabling this path")',
  '    if anchor.get("crlDpRevocationEnabled") is not True: service.update_trust_anchor(trustAnchorId=job["anchor"], crlDpRevocationEnabled=True)',
  '    print("Automatic-CDP setting request accepted; inspect the actual flag and validate certificate CDPs/revocation before activation. Access remains disabled."); raise SystemExit(0)',
  'if not args.confirm_pki: raise RuntimeError("Activation also requires --confirm-pki after approved client certificate/issuance/CDP/revocation and data-owner review")',
  'if anchor.get("crlDpRevocationEnabled") is not True: raise RuntimeError("PKI owner must configure and verify automatic CDP revocation checking before activation")',
  'if not anchor.get("enabled"): service.enable_trust_anchor(trustAnchorId=job["anchor"])',
  'if not profile.get("enabled"): service.enable_profile(profileId=job["profile"])',
  'print("Activation requests accepted; inspect actual state and test certificate/revocation/temporary-credential behavior. No credentials minted by this script.")',
].join('\n') + '\n';
