export const privateCaInspection=String.raw`#!/usr/bin/env python3
"""Private CA metadata only. No CSR/certificate bodies, issuance, activation, grants or keys."""
import argparse,json,re,sys
from pathlib import Path
import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
def require(ok,message):
    if not ok:raise ValueError(message)
def pages(method,key,**request):
    token=None;seen=set()
    for page in range(100):
        r=method(**request,**({'NextToken':token} if token else {}));yield r.get(key,[])
        token=r.get('NextToken')
        if not token:return
        require(token not in seen,'Repeated CA metadata pagination token');seen.add(token)
    raise ValueError('CA metadata pagination limit exceeded')
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--ca');parser.add_argument('--active',action='store_true');args=parser.parse_args()
    require(not args.active or args.ca,'Active checks require exact authority ARN')
    c=json.loads(Path(__file__).with_name('CA-CONFIG.json').read_text());prefix='arn:aws:acm-pca:'+c['region']+':'+c['account']+':certificate-authority/'
    if args.ca:require(re.fullmatch(re.escape(prefix)+r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',args.ca),'Unexpected CA owner/region/identifier')
    session=boto3.Session(region_name=c['region']);cfg=Config(use_fips_endpoint=True,retries={'mode':'standard','max_attempts':3})
    require(session.client('sts',config=cfg).get_caller_identity()['Account']==c['account'],'Wrong CA owner account');client=session.client('acm-pca',config=cfg)
    if not args.ca:
        authorities=[a for page in pages(client.list_certificate_authorities,'CertificateAuthorities',ResourceOwner='SELF',MaxResults=100) for a in page]
        require(len({a['Arn'] for a in authorities})==len(authorities),'Duplicate CA inventory')
        for authority in authorities:
            require(authority['Arn'].startswith(prefix),'Unexpected authority owner in SELF inventory')
            tags=[t for page in pages(client.list_tags,'Tags',CertificateAuthorityArn=authority['Arn'],MaxResults=100) for t in page]
            require(not any(t.get('Key')=='Name' and t.get('Value')==c['name'] for t in tags),'Authority label already exists; reconcile state/ownership')
        print(json.dumps({'preflightMetadataVerified':True,'existingSameLabelAuthority':False,'monthlyChargesStartAtCreation':True,'parentTrustAndKeyBoundaryApprovalRequired':True}));return
    authority=client.describe_certificate_authority(CertificateAuthorityArn=args.ca)['CertificateAuthority'];config=authority['CertificateAuthorityConfiguration']
    require(authority.get('Arn')==args.ca and authority.get('Type')=='SUBORDINATE' and authority.get('Status')==('ACTIVE' if args.active else 'PENDING_CERTIFICATE') and authority.get('UsageMode')=='GENERAL_PURPOSE' and authority.get('KeyStorageSecurityStandard')==c['storage'],'Authority identity/type/state/usage/key-storage mismatch')
    require(config.get('KeyAlgorithm')==c['algorithm']['key'] and config.get('SigningAlgorithm')==c['algorithm']['sign'] and config.get('Subject')==c['subject'],'Authority algorithm/subject mismatch')
    revocation=authority.get('RevocationConfiguration',{});ocsp=revocation.get('OcspConfiguration',{})
    require(ocsp.get('Enabled') is True and not ocsp.get('OcspCustomCname') and not revocation.get('CrlConfiguration',{}).get('Enabled'),'OCSP/CRL configuration differs from approved initial scope')
    tags=[t for page in pages(client.list_tags,'Tags',CertificateAuthorityArn=args.ca,MaxResults=100) for t in page];require([t['Value'] for t in tags if t.get('Key')=='Name']==[c['name']],'Authority tag mismatch/duplicate')
    if args.active:
        require(not [p for page in pages(client.list_permissions,'Permissions',CertificateAuthorityArn=args.ca,MaxResults=100) for p in page],'Unexpected ACM issuance/renewal grants')
        try:policy=client.get_policy(ResourceArn=args.ca).get('Policy','')
        except ClientError as error:require(error.response.get('Error',{}).get('Code')=='ResourceNotFoundException','Policy lookup failed; absence not established')
        else:require(not policy or not json.loads(policy).get('Statement'),'Unexpected CA resource-based policy; owner qualification required')
    print(json.dumps({'authorityMetadataVerified':True,'state':authority['Status'],'parentChainTrustProven':False,'sameAccountIssuerPermissionsProven':False,'clientRevocationProven':False,'cmvpAuthorizationProven':False,'ownerPkiSigningAndRecoveryReviewRequired':True},sort_keys=True))
if __name__=='__main__':
    try:main()
    except Exception:
        print('Private CA metadata check failed. Reconcile approved owner/subject/key/revocation/permission scope; no keys, CSR/certificate bodies or signing/activation operations were requested.',file=sys.stderr);sys.exit(1)
`;
export const privateCaCsrExport=String.raw`param([Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
$csr = & terraform output -raw certificate_signing_request
if ($LASTEXITCODE -ne 0) { throw 'Terraform CSR output failed. Use the approved applied CA module/state.' }
$pem = (($csr -join [Environment]::NewLine).Trim()) + [Environment]::NewLine
if ($pem -notmatch '\A-----BEGIN CERTIFICATE REQUEST-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE REQUEST-----\r?\n\z') { throw 'Expected only a public CSR PEM envelope.' }
$destination = [System.IO.Path]::GetFullPath($OutputPath)
if (-not [System.IO.Directory]::Exists([System.IO.Path]::GetDirectoryName($destination))) { throw 'Choose an existing approved output directory.' }
$encoding = New-Object System.Text.UTF8Encoding($false)
$bytes = $encoding.GetBytes($pem)
$stream = New-Object System.IO.FileStream($destination, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
Write-Output 'Public CSR written as UTF8 without BOM to the approved new file. Verify its signature, subject and key with the PKI owner.'
`;
