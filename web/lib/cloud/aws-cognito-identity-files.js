export const cognitoIdentityInspection=String.raw`#!/usr/bin/env python3
"""Pool/role/bucket/key metadata only. No user, token, client secret, credentials or object bodies."""
import argparse,json,re,sys
from pathlib import Path
from urllib.parse import unquote
import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
def require(ok,message):
    if not ok: raise ValueError(message)
def pages(method,**request):
    token=None;seen=set()
    for page in range(100):
        response=method(**request,**({'NextToken':token} if token else {}));yield response
        token=response.get('NextToken')
        if not token:return
        require(token not in seen,'Repeated service pagination token');seen.add(token)
    raise ValueError('Metadata pagination limit exceeded')
def iam_pages(method,**request):
    marker=None;seen=set()
    for page in range(100):
        response=method(**request,**({'Marker':marker} if marker else {}));yield response
        if not response.get('IsTruncated'):return
        marker=response.get('Marker');require(marker and marker not in seen,'Invalid/repeated IAM pagination marker');seen.add(marker)
    raise ValueError('IAM pagination limit exceeded')
def document(value): return json.loads(unquote(value)) if isinstance(value,str) else value
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--identity-pool');args=parser.parse_args()
    c=json.loads(Path(__file__).with_name('IDENTITY-CONFIG.json').read_text())
    if args.identity_pool:require(re.fullmatch(re.escape(c['region'])+r':[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',args.identity_pool),'Invalid exact regional identity pool ID')
    session=boto3.Session(region_name=c['region']);cfg=Config(use_fips_endpoint=True,retries={'mode':'standard','max_attempts':3})
    clients={n:session.client(n,config=cfg) for n in ['sts','cognito-idp','cognito-identity','s3','kms','iam']}
    require(clients['sts'].get_caller_identity()['Account']==c['account'],'Wrong expected source/role owner account')
    user=clients['cognito-idp'].describe_user_pool(UserPoolId=c['userPool'])['UserPool']
    require(user.get('Id')==c['userPool'] and user.get('Arn')=='arn:'+c['partition']+':cognito-idp:'+c['region']+':'+c['account']+':userpool/'+c['userPool'],'Source user pool owner/identity mismatch')
    app_clients=[v for r in pages(clients['cognito-idp'].list_user_pool_clients,UserPoolId=c['userPool'],MaxResults=60) for v in r.get('UserPoolClients',[])]
    require(len({v['ClientId'] for v in app_clients})==len(app_clients),'Duplicate app client metadata')
    selected=[v for v in app_clients if v.get('ClientId')==c['client']];require(len(selected)==1 and selected[0].get('UserPoolId')==c['userPool'],'Exact app client is not in source user pool')
    # Public-client/no-secret and detailed auth settings require independent owner confirmation.
    s3=clients['s3'];base={'Bucket':c['bucket'],'ExpectedBucketOwner':c['account']}
    location=s3.get_bucket_location(**base).get('LocationConstraint') or 'us-east-1';require(location==c['region'],'Bucket region mismatch')
    require(s3.get_bucket_versioning(**base).get('Status')=='Enabled','Bucket versioning must be enabled')
    blocks=s3.get_public_access_block(**base)['PublicAccessBlockConfiguration'];require(all(blocks.get(k) is True for k in ['BlockPublicAcls','IgnorePublicAcls','BlockPublicPolicy','RestrictPublicBuckets']),'All bucket public-access blocks required')
    require(s3.get_bucket_ownership_controls(**base).get('OwnershipControls',{}).get('Rules')==[{'ObjectOwnership':'BucketOwnerEnforced'}],'Bucket ownership controls mismatch')
    rules=s3.get_bucket_encryption(**base)['ServerSideEncryptionConfiguration']['Rules'];require(len(rules)==1,'Expected one default encryption rule');encryption=rules[0]['ApplyServerSideEncryptionByDefault']
    require(encryption.get('SSEAlgorithm')=='aws:kms' and encryption.get('KMSMasterKeyID')==c['kms'],'Bucket default customer encryption key mismatch')
    key=clients['kms'].describe_key(KeyId=c['kms'])['KeyMetadata'];require(key.get('Arn')==c['kms'] and key.get('AWSAccountId')==c['account'] and key.get('KeyManager')=='CUSTOMER' and key.get('KeyState')=='Enabled' and key.get('KeySpec')=='SYMMETRIC_DEFAULT' and key.get('KeyUsage')=='ENCRYPT_DECRYPT','Customer key metadata mismatch')
    pools=[p for r in pages(clients['cognito-identity'].list_identity_pools,MaxResults=60) for p in r.get('IdentityPools',[])];require(len({p['IdentityPoolId'] for p in pools})==len(pools),'Duplicate identity pool inventory')
    if not args.identity_pool:
        require(not any(p.get('IdentityPoolName')==c['name'] for p in pools),'Identity pool name exists; reconcile')
        try: clients['iam'].get_role(RoleName=c['roleName'])
        except ClientError as error:require(error.response.get('Error',{}).get('Code')=='NoSuchEntity','Role lookup failed; absence not established')
        else:raise ValueError('Role name exists; reconcile rather than modify/adopt')
        print(json.dumps({'preflightMetadataVerified':True,'appClientMembershipVerified':True,'publicClientSettingsIndependentlyRequired':True,'allClientAuthenticatedUsersSharePrefix':True,'effectiveAuthorizationProven':False}));return
    selected=[p for p in pools if p['IdentityPoolId']==args.identity_pool];require(len(selected)==1 and selected[0].get('IdentityPoolName')==c['name'],'Exact account-owned identity pool inventory mismatch')
    client=clients['cognito-identity'];pool=client.describe_identity_pool(IdentityPoolId=args.identity_pool)
    require(pool.get('IdentityPoolId')==args.identity_pool and pool.get('IdentityPoolName')==c['name'] and pool.get('AllowUnauthenticatedIdentities') is False and pool.get('AllowClassicFlow') is False,'Pool identity/guest/classic flow mismatch')
    require(pool.get('CognitoIdentityProviders')==[{'ClientId':c['client'],'ProviderName':c['providerName'],'ServerSideTokenCheck':True}] and not any(pool.get(k) for k in ['SupportedLoginProviders','DeveloperProviderName','OpenIdConnectProviderARNs','SamlProviderARNs']),'Unreviewed identity providers or token-check settings')
    roles=client.get_identity_pool_roles(IdentityPoolId=args.identity_pool);require(roles.get('IdentityPoolId')==args.identity_pool and roles.get('Roles')=={'authenticated':c['roleArn']} and not roles.get('RoleMappings'),'Unreviewed role mappings/guest/alternate role')
    iam=clients['iam'];role=iam.get_role(RoleName=c['roleName'])['Role'];require(role.get('Arn')==c['roleArn'] and role.get('RoleName')==c['roleName'] and role.get('MaxSessionDuration')==3600,'Role owner/name/session bound mismatch')
    trust={'Version':'2012-10-17','Statement':[{'Effect':'Allow','Principal':{'Federated':'cognito-identity.amazonaws.com'},'Action':'sts:AssumeRoleWithWebIdentity','Condition':{'StringEquals':{'cognito-identity.amazonaws.com:aud':args.identity_pool},'ForAnyValue:StringLike':{'cognito-identity.amazonaws.com:amr':'authenticated'}}}]}
    require(document(role.get('AssumeRolePolicyDocument'))==trust,'Role trust is not exact authenticated audience')
    names=[name for r in iam_pages(iam.list_role_policies,RoleName=c['roleName'],MaxItems=1000) for name in r.get('PolicyNames',[])];require(names==['prefix-read'],'Unexpected inline role policies')
    require(not [p for r in iam_pages(iam.list_attached_role_policies,RoleName=c['roleName'],MaxItems=1000) for p in r.get('AttachedPolicies',[])],'Unexpected managed role policy')
    policy=iam.get_role_policy(RoleName=c['roleName'],PolicyName='prefix-read');expected=json.loads(Path(__file__).with_name('ACCESS-POLICY-REVIEW.json').read_text())
    require(document(policy.get('PolicyDocument'))==expected,'Role prefix/key access policy mismatch')
    print(json.dumps({'identityPoolRoleMetadataVerified':True,'allClientAuthenticatedUsersSharePrefix':True,'publicClientSettingsIndependentlyRequired':True,'effectiveAuthorizationProven':False,'issuedCredentialRevocationProven':False,'actualObjectEncryptionProven':False,'ownerLiveFederationAndScopeTestsRequired':True},sort_keys=True))
if __name__=='__main__':
    try:main()
    except Exception:
        print('Cognito identity metadata check failed. Reconcile approved pool/client/bucket/key/role scope and read permissions; no users, tokens, credentials or object contents were requested.',file=sys.stderr);sys.exit(1)
`;

export const cognitoFederationCheck=String.raw`#!/usr/bin/env python3
"""EXPLICIT owner-approved live federation test. Never prints tokens or temporary credentials."""
import argparse,base64,getpass,json,re,subprocess,sys,time
from datetime import datetime,timezone
from pathlib import Path
import boto3
from botocore.config import Config
def require(ok,message):
    if not ok:raise ValueError(message)
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--identity-pool',required=True);parser.add_argument('--confirm-approved-federation',action='store_true');args=parser.parse_args()
    require(args.confirm_approved_federation,'Explicit approved federation confirmation required')
    root=Path(__file__).resolve().parent;c=json.loads((root/'IDENTITY-CONFIG.json').read_text())
    require(re.fullmatch(re.escape(c['region'])+r':[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',args.identity_pool),'Invalid exact regional identity pool ID')
    checked=subprocess.run([sys.executable,str(root/'INSPECT.py'),'--identity-pool',args.identity_pool],capture_output=True,text=True)
    require(checked.returncode==0,'Owner metadata inspection failed; no federation attempted')
    token=getpass.getpass('Approved user-pool ID token (hidden): ')
    require(len(token)<=32768 and re.fullmatch(r'[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+',token),'Invalid bounded ID-token representation')
    encoded=token.split('.')[1];claims=json.loads(base64.urlsafe_b64decode(encoded+'='*((-len(encoded))%4)))
    require(claims.get('token_use')=='id' and claims.get('aud')==c['client'] and claims.get('iss')=='https://'+c['providerName'] and float(claims.get('exp',0))>time.time() and float(claims.get('nbf',0))<=time.time(),'Wrong/expired/not-yet-valid token claims')
    # Local claims checks only reject mismatches. Cognito validates the actual signature/token.
    config=Config(use_fips_endpoint=True,retries={'mode':'standard','max_attempts':1});session=boto3.Session(region_name=c['region']);client=session.client('cognito-identity',config=config)
    logins={c['providerName']:token};identity=client.get_id(AccountId=c['account'],IdentityPoolId=args.identity_pool,Logins=logins)['IdentityId']
    require(re.fullmatch(re.escape(c['region'])+r':[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',identity),'Unexpected identity ID region/format')
    response=client.get_credentials_for_identity(IdentityId=identity,Logins=logins);require(response.get('IdentityId')==identity,'Credential identity mismatch');credentials=response['Credentials']
    require(isinstance(credentials.get('Expiration'),datetime) and credentials['Expiration'].tzinfo is not None and credentials['Expiration']>datetime.now(timezone.utc),'Temporary credentials are expired or lack expiration')
    temporary=boto3.Session(region_name=c['region'],aws_access_key_id=credentials['AccessKeyId'],aws_secret_access_key=credentials['SecretKey'],aws_session_token=credentials['SessionToken'])
    caller=temporary.client('sts',config=config).get_caller_identity();expected='arn:'+c['partition']+':sts::'+c['account']+':assumed-role/'+c['roleName']+'/'
    require(caller.get('Account')==c['account'] and caller.get('Arn','').startswith(expected) and len(caller['Arn'])>len(expected),'Federated credential role/account mismatch')
    print(json.dumps({'authenticatedRoleVerified':True,'sharedPrefixReadProven':False,'outOfScopeDenialProven':False,'credentialRevocationProven':False,'ownerApplicationAndObjectAuthorizationTestsRequired':True},sort_keys=True))
if __name__=='__main__':
    try:main()
    except Exception:
        print('Approved federation check failed. Token/credential details are suppressed; reconcile metadata, user/client authorization and temporary-role policy through the owner process.',file=sys.stderr);sys.exit(1)
`;
