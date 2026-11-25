/** DSQL exported inspection and explicit connection code using SDK/SQL doubles only. */
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_DSQL_SERVICE as blueprint} from '../src/cloud/aws-dsql-service.ts';
import {WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'dsql-inspect-'));
const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',name:'reviewed-database',account:'123456789012',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc',subnets:'subnet-12345678,subnet-abcdef12',clients:'sg-12345678',role:'arn:aws:iam::123456789012:role/application'});
if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const name of ['INSPECT.py','DSQL-CONFIG.json','CHECK-CONNECTION.py'])writeFileSync(join(work,name),result.files[name]);
writeFileSync(join(work,'ca.pem'),'SYNTHETIC-CA-NOT-A-REAL-CERTIFICATE');
writeFileSync(join(work,'test.py'),String.raw`import contextlib, copy, io, json, runpy, sys, traceback, types
from pathlib import Path
root=Path(__file__).resolve().parent; c=json.loads((root/'DSQL-CONFIG.json').read_text())
cluster='a'*26; endpoint='vpce-12345678'; group_id='sg-abcdef12'; vpc='vpc-12345678'; service='com.amazonaws.'+c['region']+'.dsql-cell1'
arn='arn:aws:dsql:'+c['region']+':'+c['account']+':cluster/'+cluster
deny={'Sid':'DenyDatabaseConnectionsOutsideApprovedEndpoint','Effect':'Deny','Principal':'*','Action':['dsql:DbConnect','dsql:DbConnectAdmin'],'Resource':arn,'Condition':{'StringNotEquals':{'aws:SourceVpce':endpoint}}}
base={'account':c['account'],'caller':'arn:aws:sts::'+c['account']+':assumed-role/'+c['roleName']+'/fixture',
 'key':{'Arn':c['kms'],'AWSAccountId':c['account'],'KeyManager':'CUSTOMER','KeyState':'Enabled','KeySpec':'SYMMETRIC_DEFAULT','KeyUsage':'ENCRYPT_DECRYPT'},'role':c['role'],
 'subnets':[{'SubnetId':id,'VpcId':vpc,'OwnerId':c['account'],'State':'available','MapPublicIpOnLaunch':False,'AvailableIpAddressCount':20,'AvailabilityZoneId':'use1-az'+str(i+1)} for i,id in enumerate(c['subnets'])],
 'vpc':{'VpcId':vpc,'OwnerId':c['account'],'State':'available'},'dns':True,'clients':[{'GroupId':id,'VpcId':vpc,'OwnerId':c['account']} for id in c['clients']],
 'cluster':{'identifier':cluster,'arn':arn,'status':'ACTIVE','deletionProtectionEnabled':True,'encryptionDetails':{'encryptionType':'CUSTOMER_MANAGED_KMS_KEY','encryptionStatus':'ENABLED','kmsKeyArn':c['kms']},'tags':{'Name':c['name']}},
 'service':service,'endpoint':{'VpcEndpointId':endpoint,'OwnerId':c['account'],'VpcId':vpc,'VpcEndpointType':'Interface','State':'available','ServiceName':service,'PrivateDnsEnabled':True,'RequesterManaged':False,'SubnetIds':c['subnets'],'Groups':[{'GroupId':group_id}],'NetworkInterfaceIds':['eni-12345678','eni-abcdef12']},
 'group':{'GroupId':group_id,'OwnerId':c['account'],'VpcId':vpc,'GroupName':c['name']+'-connection','IpPermissionsEgress':[],'IpPermissions':[{'IpProtocol':'tcp','FromPort':5432,'ToPort':5432,'UserIdGroupPairs':[{'GroupId':id,'UserId':c['account']} for id in c['clients']]}]},
 'nics':[{'NetworkInterfaceId':id,'OwnerId':c['account'],'VpcId':vpc,'SubnetId':c['subnets'][i],'Status':'in-use','PrivateIpAddress':'10.20.'+str(i)+'.5','Groups':[{'GroupId':group_id}]} for i,id in enumerate(['eni-12345678','eni-abcdef12'])],
 'policy':{'Version':'2012-10-17','Statement':[deny]}}
token_calls=0; sql_calls=0
class Config:
 def __init__(self,**kwargs): assert kwargs['use_fips_endpoint'] is True
class Session:
 def __init__(self,**kwargs): assert kwargs=={'region_name':c['region']}
 def client(self,name,**kwargs): assert name in ['sts','kms','iam','ec2','dsql']; assert kwargs['region_name']==c['region']; return self
 def get_caller_identity(self): return {'Account':data['account'],'Arn':data['caller']}
 def describe_key(self,**kwargs): assert kwargs=={'KeyId':c['kms']}; return {'KeyMetadata':data['key']}
 def get_role(self,**kwargs): assert kwargs=={'RoleName':c['roleName']}; return {'Role':{'Arn':data['role']}}
 def describe_subnets(self,**kwargs): assert kwargs=={'SubnetIds':c['subnets']}; return {'Subnets':data['subnets']}
 def describe_vpcs(self,**kwargs): assert kwargs=={'VpcIds':[vpc]}; return {'Vpcs':[data['vpc']]}
 def describe_vpc_attribute(self,**kwargs): assert kwargs['VpcId']==vpc; return {{'enableDnsSupport':'EnableDnsSupport','enableDnsHostnames':'EnableDnsHostnames'}[kwargs['Attribute']]:{'Value':data['dns']}}
 def describe_security_groups(self,**kwargs):
  if kwargs=={'GroupIds':c['clients']}: return {'SecurityGroups':data['clients']}
  assert kwargs=={'GroupIds':[group_id]}; return {'SecurityGroups':[data['group']]}
 def get_cluster(self,**kwargs): assert kwargs=={'identifier':cluster}; return data['cluster']
 def get_vpc_endpoint_service_name(self,**kwargs): assert kwargs=={'identifier':cluster}; return {'serviceName':data['service']}
 def describe_vpc_endpoints(self,**kwargs): assert kwargs=={'VpcEndpointIds':[endpoint]}; return {'VpcEndpoints':[data['endpoint']]}
 def describe_network_interfaces(self,**kwargs): assert kwargs=={'NetworkInterfaceIds':['eni-12345678','eni-abcdef12']}; return {'NetworkInterfaces':data['nics']}
 def get_cluster_policy(self,**kwargs): assert kwargs=={'identifier':cluster}; return {'policy':json.dumps(data['policy']),'policyVersion':'1'}
 def generate_db_connect_auth_token(self,**kwargs):
  global token_calls
  assert kwargs=={'Hostname':hostname,'Region':c['region'],'ExpiresIn':900}; token_calls+=1; return 'SYNTHETIC-SECRET-NOT-TO-PRINT'
sdk=types.ModuleType('boto3'); sdk.Session=Session; sys.modules['boto3']=sdk; sys.modules['botocore']=types.ModuleType('botocore'); module=types.ModuleType('botocore.config'); module.Config=Config; sys.modules['botocore.config']=module
cases=[('preflight',[],None),('check',[],None),('emit',[],None),('account',['account'],'other'),('key-owner',['key','AWSAccountId'],'other'),('key-state',['key','KeyState'],'Disabled'),('key-type',['key','KeySpec'],'RSA_2048'),('role',['role'],'other'),('subnet-owner',['subnets',0,'OwnerId'],'other'),('subnet-az',['subnets',1,'AvailabilityZoneId'],'use1-az1'),('subnet-public',['subnets',0,'MapPublicIpOnLaunch'],True),('subnet-ipv6',['subnets',0,'Ipv6Native'],True),('subnet-capacity',['subnets',0,'AvailableIpAddressCount'],2),('dns',['dns'],False),('client-owner',['clients',0,'OwnerId'],'other'),
 ('cluster-arn',['cluster','arn'],'other'),('cluster-state',['cluster','status'],'IDLE'),('cluster-delete',['cluster','deletionProtectionEnabled'],False),('cluster-key',['cluster','encryptionDetails','kmsKeyArn'],'other'),('cluster-encryption',['cluster','encryptionDetails','encryptionStatus'],'UPDATING'),('cluster-multi',['cluster','multiRegionProperties'],{'witnessRegion':'us-west-2'}),('service',['service'],'com.amazonaws.us-east-1.dsql'),
 ('endpoint-service',['endpoint','ServiceName'],'other'),('endpoint-owner',['endpoint','OwnerId'],'other'),('endpoint-dns',['endpoint','PrivateDnsEnabled'],False),('endpoint-state',['endpoint','State'],'pending'),('endpoint-subnets',['endpoint','SubnetIds'],['other']),('endpoint-egress',['group','IpPermissionsEgress'],[{'IpProtocol':'-1'}]),('endpoint-port',['group','IpPermissions',0,'FromPort'],0),('endpoint-public',['group','IpPermissions',0,'IpRanges'],[{'CidrIp':'0.0.0.0/0'}]),('endpoint-clients',['group','IpPermissions',0,'UserIdGroupPairs'],[]),('nic-owner',['nics',0,'OwnerId'],'other'),('nic-public',['nics',0,'Association'],{'PublicIp':'203.0.113.1'}),('policy-missing',['policy','Statement'],[]),('policy-broad',['policy','Statement',0,'Condition','StringNotEquals','aws:SourceVpce'],'other')]
for scenario,path,value in cases:
 data=copy.deepcopy(base)
 if path:
  parent=data
  for key in path[:-1]: parent=parent[key]
  parent[path[-1]]=value
 flags=[] if scenario=='preflight' else ['--cluster',cluster,'--endpoint',endpoint]
 if scenario=='emit': flags+=['--emit-policy-review']
 sys.argv=['INSPECT.py']+flags; failure=None
 with contextlib.redirect_stdout(io.StringIO()) as output:
  try: runpy.run_path(str(root/'INSPECT.py'),run_name='__main__')
  except Exception as error: failure=error
 success=scenario in ['preflight','check','emit']; assert bool(failure)!=success,(scenario,failure)
 if scenario=='emit':
  report=json.loads(output.getvalue()); assert report['clusterPolicyMERGEOnly']['Statement']==[deny] and report['applicationIdentityPolicyREVIEWOnly']['Statement'][0]['Action']=='dsql:DbConnect' and report['authorizationProven'] is False
 if scenario=='check': assert json.loads(output.getvalue())['authorizationProven'] is False
 assert token_calls==0 and sql_calls==0
original_config=copy.deepcopy(c)
c.update({'witnessRegion':'us-east-2','peerRegion':'us-west-2'})
(root/'DSQL-CONFIG.json').write_text(json.dumps(c))
peer_id='b'*26; peer_arn='arn:aws:dsql:us-west-2:'+c['account']+':cluster/'+peer_id
multi_cases=['both-members','peer-only','wrong-witness','wrong-peer','extra-peer','duplicate-member','missing-peer-id','self-only']
for scenario in multi_cases:
 data=copy.deepcopy(base)
 data['cluster']['multiRegionProperties']={'witnessRegion':c['witnessRegion'],'clusters':[arn,peer_arn]}
 if scenario=='peer-only': data['cluster']['multiRegionProperties']['clusters']=[peer_arn]
 if scenario=='wrong-witness': data['cluster']['multiRegionProperties']['witnessRegion']='us-west-2'
 if scenario=='wrong-peer': data['cluster']['multiRegionProperties']['clusters']=[arn,'other']
 if scenario=='extra-peer': data['cluster']['multiRegionProperties']['clusters'].append('other')
 if scenario=='duplicate-member': data['cluster']['multiRegionProperties']['clusters'].append(arn)
 if scenario=='self-only': data['cluster']['multiRegionProperties']['clusters']=[arn]
 sys.argv=['INSPECT.py','--cluster',cluster,'--endpoint',endpoint]+([] if scenario=='missing-peer-id' else ['--peer-cluster',peer_id]); failure=None
 with contextlib.redirect_stdout(io.StringIO()) as output:
  try: runpy.run_path(str(root/'INSPECT.py'),run_name='__main__')
  except Exception as error: failure=error
 assert bool(failure)!=(scenario in ['both-members','peer-only']),(scenario,failure)
 assert token_calls==0 and sql_calls==0
c.clear();c.update(original_config);(root/'DSQL-CONFIG.json').write_text(json.dumps(c))
class Connection:
 def __enter__(self): return self
 def __exit__(self,*args): return False
 def execute(self,sql):
  assert sql=='SELECT current_user, current_database()'; return self
 def fetchone(self): return ('admin','postgres') if scenario=='sql-role' else (c['dbRole'],'postgres')
def connect(**kwargs):
 global sql_calls
 sql_calls+=1
 assert kwargs=={'host':hostname,'dbname':'postgres','user':c['dbRole'],'password':'SYNTHETIC-SECRET-NOT-TO-PRINT','sslmode':'verify-full','sslrootcert':str(root/'ca.pem'),'connect_timeout':10,'autocommit':True,'application_name':c['name']}
 if scenario=='sql-error': raise RuntimeError('SYNTHETIC-SECRET-NOT-TO-PRINT')
 return Connection()
pg=types.ModuleType('psycopg'); pg.connect=connect; sys.modules['psycopg']=pg
hostname=cluster+'.dsql-cell1.'+c['region']+'.on.aws'
connection_cases=['no-approval','wrong-caller','wrong-host','missing-ca','sql-error','sql-role','success']
for scenario in connection_cases:
 data=copy.deepcopy(base); token_calls=0; sql_calls=0
 if scenario=='wrong-caller': data['caller']='arn:aws:iam::'+c['account']+':root'
 flags=['--hostname',('evil.example.com' if scenario=='wrong-host' else hostname),'--ca',str(root/('missing.pem' if scenario=='missing-ca' else 'ca.pem'))]
 if scenario!='no-approval': flags+=['--confirm-approved-connect']
 sys.argv=['CHECK-CONNECTION.py']+flags; failure=None
 with contextlib.redirect_stdout(io.StringIO()) as output:
  try: runpy.run_path(str(root/'CHECK-CONNECTION.py'),run_name='__main__')
  except Exception as error: failure=error
 assert bool(failure)!=(scenario=='success'),(scenario,failure)
 assert 'SYNTHETIC-SECRET-NOT-TO-PRINT' not in output.getvalue()
 if failure: assert 'SYNTHETIC-SECRET-NOT-TO-PRINT' not in ''.join(traceback.format_exception(type(failure),failure,failure.__traceback__))
 assert token_calls==(1 if scenario in ['sql-error','sql-role','success'] else 0) and sql_calls==token_calls
print(str(len(cases))+' single metadata/policy, '+str(len(multi_cases))+' multi membership and '+str(len(connection_cases))+' explicit SQL/token double cases passed; no AWS/SQL/data/credential operations')
`);
const check=spawnSync(process.env.PYTHON_PATH||'python',[join(work,'test.py')],{encoding:'utf8',windowsHide:true});process.stdout.write((check.stdout||'')+(check.stderr||''));if(check.error)throw check.error;if(check.status!==0)throw new Error('Inspect '+work);console.log(work);
