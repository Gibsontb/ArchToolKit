/** Actual exported ONTAP metadata inspector with SDK doubles, no live FSx/NFS/SSH. */
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_FSX_ONTAP_SERVICE as blueprint} from '../src/cloud/aws-fsx-ontap-service.ts';
import {WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'ontap-inspect-'));
const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',name:'reviewed-ontap',account:'123456789012',subnets:'subnet-12345678,subnet-abcdef12',clients:'sg-12345678',admins:'sg-abcdef12',client_cidrs:'10.20.0.0/24',routes:'rtb-12345678',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc'});if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const name of ['INSPECT.py','ONTAP-CONFIG.json'])writeFileSync(join(work,name),result.files[name]);
writeFileSync(join(work,'test.py'),String.raw`import contextlib,copy,io,json,runpy,sys,types
from pathlib import Path
root=Path(__file__).resolve().parent;c=json.loads((root/'ONTAP-CONFIG.json').read_text());filesystem='fs-'+'a'*17;svm='svm-'+'b'*17;volume='fsvol-'+'c'*17;vpc='vpc-12345678';prefix='arn:aws:fsx:us-east-1:'+c['account']+':'
group='sg-00000000';nics=['eni-12345678','eni-abcdef12']
base={'account':c['account'],'subnets':[{'SubnetId':id,'VpcId':vpc,'OwnerId':c['account'],'State':'available','MapPublicIpOnLaunch':False,'AvailableIpAddressCount':20,'AvailabilityZoneId':'use1-az'+str(i+1),'CidrBlock':'10.'+str(20+i)+'.0.0/24'} for i,id in enumerate(c['subnets'])],
'vpc':{'VpcId':vpc,'OwnerId':c['account'],'State':'available'},'dns':True,'groups':[{'GroupId':id,'VpcId':vpc,'OwnerId':c['account']} for id in c['clients']+c['admins']],'routes':[{'RouteTableId':c['routes'][0],'VpcId':vpc,'OwnerId':c['account']}],
'key':{'Arn':c['kms'],'KeyState':'Enabled','KeySpec':'SYMMETRIC_DEFAULT','KeyUsage':'ENCRYPT_DECRYPT'},'existing':[],
'filesystem':{'FileSystemId':filesystem,'ResourceARN':prefix+'file-system/'+filesystem,'OwnerId':c['account'],'FileSystemType':'ONTAP','Lifecycle':'AVAILABLE','VpcId':vpc,'SubnetIds':c['subnets'],'StorageCapacity':c['storage'],'StorageType':'SSD','KmsKeyId':c['kms'],'NetworkInterfaceIds':nics,'OntapConfiguration':{'DeploymentType':c['deployment'],'HAPairs':1,'ThroughputCapacityPerHAPair':c['throughput'],'AutomaticBackupRetentionDays':c['retention'],'PreferredSubnetId':c['subnets'][0],'DiskIopsConfiguration':{'Mode':'AUTOMATIC'},'RouteTableIds':c['routes'],'EndpointIpAddressRange':c['endpointCidr']}},
'svm':{'StorageVirtualMachineId':svm,'FileSystemId':filesystem,'ResourceARN':prefix+'storage-virtual-machine/'+filesystem+'/'+svm,'Name':c['svm'],'Lifecycle':'CREATED','RootVolumeSecurityStyle':'UNIX','Endpoints':{'Nfs':{'DNSName':'svm.private.fsx.us-east-1.amazonaws.com'}}},
'volume':{'VolumeId':volume,'ResourceARN':prefix+'volume/'+filesystem+'/'+volume,'FileSystemId':filesystem,'VolumeType':'ONTAP','Name':c['volume'],'Lifecycle':'CREATED','OntapConfiguration':{'StorageVirtualMachineId':svm,'JunctionPath':'/'+c['volume'],'SizeInMegabytes':c['volumeGib']*1024,'SecurityStyle':'UNIX','OntapVolumeType':'RW','VolumeStyle':'FLEXVOL','StorageEfficiencyEnabled':True,'SnapshotPolicy':'default','TieringPolicy':{'Name':'NONE'}}},
'nics':[{'NetworkInterfaceId':id,'OwnerId':c['account'],'VpcId':vpc,'Status':'in-use','SubnetId':c['subnets'][i],'Groups':[{'GroupId':group}]} for i,id in enumerate(nics)],
'generated':{'GroupId':group,'GroupName':c['name']+'-ontap','VpcId':vpc,'OwnerId':c['account'],'IpPermissionsEgress':[],'IpPermissions':[{'IpProtocol':'tcp','FromPort':p,'ToPort':p,'UserIdGroupPairs':[{'UserId':c['account'],'GroupId':c['clients'][0] if p==2049 else c['admins'][0]}]} for p in [2049,22,443]]}}
class Config:
 def __init__(self,**kw): assert kw['use_fips_endpoint'] is True
class Session:
 def __init__(self,**kw): assert kw=={'region_name':c['region']}
 def client(self,name,**kw): assert name in ['sts','ec2','kms','fsx'];return self
 def get_caller_identity(self): return {'Account':data['account']}
 def describe_subnets(self,**kw):
  if 'SubnetIds' in kw: assert kw=={'SubnetIds':c['subnets']};return {'Subnets':data['subnets']}
  assert kw['Filters']==[{'Name':'vpc-id','Values':[vpc]}] and kw['MaxResults']==1000
  if scenario=='overlap': return {'Subnets':[{'CidrBlock':c['endpointCidr']}]}
  if scenario=='subnet-pages': return {'Subnets':data['subnets'][1:] if kw.get('NextToken') else data['subnets'][:1],**({} if kw.get('NextToken') else {'NextToken':'two'})}
  if scenario=='subnet-token': return {'Subnets':[],'NextToken':'repeat'}
  return {'Subnets':data['subnets']}
 def describe_vpcs(self,**kw): assert kw=={'VpcIds':[vpc]};return {'Vpcs':[data['vpc']]}
 def describe_vpc_attribute(self,**kw): assert kw['VpcId']==vpc;return {('EnableDnsSupport' if kw['Attribute']=='enableDnsSupport' else 'EnableDnsHostnames'):{'Value':data['dns']}}
 def describe_security_groups(self,**kw):
  if kw['GroupIds']==[group]: return {'SecurityGroups':[data['generated']]}
  assert kw['GroupIds']==sorted(c['clients']+c['admins']);return {'SecurityGroups':data['groups']}
 def describe_route_tables(self,**kw): assert kw=={'RouteTableIds':c['routes']};return {'RouteTables':data['routes']}
 def describe_key(self,**kw): assert kw=={'KeyId':c['kms']};return {'KeyMetadata':data['key']}
 def describe_file_systems(self,**kw):
  if 'FileSystemIds' in kw: assert kw=={'FileSystemIds':[filesystem]};return {'FileSystems':[data['filesystem']]}
  assert kw.get('MaxResults')==100
  if scenario=='fs-pages': return {'FileSystems':data['existing'],**({} if kw.get('NextToken') else {'NextToken':'two'})}
  if scenario=='fs-token': return {'FileSystems':[],'NextToken':'repeat'}
  return {'FileSystems':data['existing']}
 def describe_storage_virtual_machines(self,**kw): assert kw=={'StorageVirtualMachineIds':[svm]};return {'StorageVirtualMachines':[data['svm']]}
 def describe_volumes(self,**kw): assert kw=={'VolumeIds':[volume]};return {'Volumes':[data['volume']]}
 def describe_network_interfaces(self,**kw): assert kw=={'NetworkInterfaceIds':nics};return {'NetworkInterfaces':data['nics']}
sys.modules['boto3']=types.SimpleNamespace(Session=Session);sys.modules['botocore']=types.ModuleType('botocore');sys.modules['botocore.config']=types.SimpleNamespace(Config=Config)
cases=['preflight','subnet-pages','fs-pages','check','wrong-account','wrong-subnet-owner','public-subnet','low-ips','same-az','wrong-vpc','dns','wrong-client','wrong-route','overlap','subnet-token','fs-token','disabled-key','existing','filesystem-owner','filesystem-state','filesystem-key','deployment','throughput','backups','routes','svm-state','svm-owner','svm-style','svm-ad','volume-state','volume-size','volume-svm','volume-tier','volume-style','public-nic','extra-group','public-ingress','extra-egress','missing-group-rule','pending-change','partial-ids']
post=['check','filesystem-owner','filesystem-state','filesystem-key','deployment','throughput','backups','routes','svm-state','svm-owner','svm-style','svm-ad','volume-state','volume-size','volume-svm','volume-tier','volume-style','public-nic','extra-group','public-ingress','extra-egress','missing-group-rule','pending-change']
for scenario in cases:
 data=copy.deepcopy(base);flags=['--filesystem',filesystem,'--svm',svm,'--volume',volume] if scenario in post else [];f=data['filesystem'];o=f['OntapConfiguration'];s=data['svm'];ov=data['volume']['OntapConfiguration']
 if scenario=='wrong-account': data['account']='000000000000'
 if scenario=='wrong-subnet-owner': data['subnets'][0]['OwnerId']='000000000000'
 if scenario=='public-subnet': data['subnets'][0]['MapPublicIpOnLaunch']=True
 if scenario=='low-ips': data['subnets'][0]['AvailableIpAddressCount']=5
 if scenario=='same-az': data['subnets'][1]['AvailabilityZoneId']='use1-az1'
 if scenario=='wrong-vpc': data['vpc']['OwnerId']='000000000000'
 if scenario=='dns': data['dns']=False
 if scenario=='wrong-client': data['groups'][0]['OwnerId']='000000000000'
 if scenario=='wrong-route': data['routes'][0]['VpcId']='vpc-other'
 if scenario=='disabled-key': data['key']['KeyState']='Disabled'
 if scenario=='existing': data['existing']=[{'Tags':[{'Key':'Name','Value':c['name']}]}]
 if scenario=='filesystem-owner': f['OwnerId']='000000000000'
 if scenario=='filesystem-state': f['Lifecycle']='MISCONFIGURED'
 if scenario=='filesystem-key': f['KmsKeyId']='other'
 if scenario=='deployment': o['DeploymentType']='SINGLE_AZ_1'
 if scenario=='throughput': o['ThroughputCapacityPerHAPair']=999
 if scenario=='backups': o['AutomaticBackupRetentionDays']=0
 if scenario=='routes': o['RouteTableIds']=[]
 if scenario=='svm-state': s['Lifecycle']='AVAILABLE'
 if scenario=='svm-owner': s['ResourceARN']=s['ResourceARN'].replace(c['account'],'000000000000')
 if scenario=='svm-style': s['RootVolumeSecurityStyle']='NTFS'
 if scenario=='svm-ad': s['ActiveDirectoryConfiguration']={'NetBiosName':'other'}
 if scenario=='volume-state': data['volume']['Lifecycle']='FAILED'
 if scenario=='volume-size': ov['SizeInMegabytes']=1
 if scenario=='volume-svm': ov['StorageVirtualMachineId']='other'
 if scenario=='volume-tier': ov['TieringPolicy']['Name']='AUTO'
 if scenario=='volume-style': ov['VolumeStyle']='FLEXGROUP'
 if scenario=='public-nic': data['nics'][0]['Association']={'PublicIp':'192.0.2.1'}
 if scenario=='extra-group': data['nics'][0]['Groups'].append({'GroupId':'sg-extra'})
 if scenario=='public-ingress': data['generated']['IpPermissions'][0]['IpRanges']=[{'CidrIp':'0.0.0.0/0'}]
 if scenario=='extra-egress': data['generated']['IpPermissionsEgress']=[{'IpProtocol':'-1'}]
 if scenario=='missing-group-rule': data['generated']['IpPermissions'].pop()
 if scenario=='pending-change': f['AdministrativeActions']=[{'Status':'FAILED'}]
 if scenario=='partial-ids': flags=['--filesystem',filesystem]
 sys.argv=['INSPECT.py']+flags;failure=None
 with contextlib.redirect_stdout(io.StringIO()) as out,contextlib.redirect_stderr(io.StringIO()):
  try: runpy.run_path(str(root/'INSPECT.py'),run_name='__main__')
  except BaseException as error: failure=error
 success=scenario in ['preflight','subnet-pages','fs-pages','check'];assert bool(failure)!=success,(scenario,failure)
 if success:
  report=json.loads(out.getvalue());assert report['metadataVerified'] is True and report['ontapExportsConfiguredProven'] is False and report['restoreFailoverProven'] is False
print(str(len(cases))+' ONTAP metadata/pagination/topology/owner/group cases passed; no AWS/NFS/SSH/data operations')
original=copy.deepcopy(c)
for deployment,throughput in [('SINGLE_AZ_1',128),('MULTI_AZ_1',128),('SINGLE_AZ_2',1536),('MULTI_AZ_2',384)]:
 scenario='variant';c=copy.deepcopy(original);data=copy.deepcopy(base)
 c.update(deployment=deployment,multi=deployment.startswith('MULTI'),generation2=deployment.endswith('_2'),throughput=throughput,kms='')
 if not c['multi']:
  c['subnets']=c['subnets'][:1];c['routes']=[];c['endpointCidr']='';data['subnets']=data['subnets'][:1];data['nics']=data['nics'][:1];nics=[nics[0]]
 else: nics=['eni-12345678','eni-abcdef12']
 data['filesystem']['NetworkInterfaceIds']=nics;data['filesystem']['SubnetIds']=c['subnets'];o=data['filesystem']['OntapConfiguration'];o['DeploymentType']=deployment
 if deployment.endswith('_1'): o.pop('ThroughputCapacityPerHAPair');o['ThroughputCapacity']=throughput
 else: o['ThroughputCapacityPerHAPair']=throughput
 (root/'ONTAP-CONFIG.json').write_text(json.dumps(c));sys.argv=['INSPECT.py','--filesystem',filesystem,'--svm',svm,'--volume',volume]
 with contextlib.redirect_stdout(io.StringIO()) as out: runpy.run_path(str(root/'INSPECT.py'),run_name='__main__')
 assert json.loads(out.getvalue())['metadataVerified'] is True
(root/'ONTAP-CONFIG.json').write_text(json.dumps(original))
print('Four generation/topology/provider-managed-key metadata variants passed')
`);
const check=spawnSync(process.env.PYTHON_PATH||'python',[join(work,'test.py')],{encoding:'utf8',windowsHide:true});process.stdout.write((check.stdout||'')+(check.stderr||''));if(check.error)throw check.error;if(check.status!==0)throw new Error('Inspect '+work);console.log(work);
