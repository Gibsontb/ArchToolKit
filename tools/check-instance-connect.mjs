/** Generated metadata scripts with SDK doubles only. No AWS or tunnel access. */
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_INSTANCE_CONNECT_SERVICE as blueprint} from '../src/cloud/aws-instance-connect-service.ts';
import {WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'instance-connect-test-'));
const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',name:'admin-access',account:'123456789012',subnet:'subnet-0123456789abcdef0',target_group:'sg-0123456789abcdef0',destination:'10.20.30.40',role:'arn:aws:iam::123456789012:role/Admin'});
if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const name of ['PREFLIGHT.py','CHECK.py','CONNECTION-CONFIG.json'])writeFileSync(join(work,name),result.files[name]);
writeFileSync(join(work,'harness.py'),String.raw`import contextlib, io, json, pathlib, runpy, subprocess, sys, types
root=pathlib.Path(__file__).resolve().parent
config=json.loads((root/'CONNECTION-CONFIG.json').read_text())
job={'id':'eice-0123456789abcdef0','arn':'arn:aws:ec2:us-east-1:123456789012:instance-connect-endpoint/eice-0123456789abcdef0','security_group':'sg-0123456789abcdef1'}
class Config:
    def __init__(self,**kwargs): assert kwargs['retries']['total_max_attempts']==1
class Session:
    def __init__(self,**kwargs): assert kwargs==dict(region_name=config['region'])
    def client(self,name,**kwargs): assert name in ['sts','ec2']; return self
    def get_caller_identity(self): return {'Account':'other' if case=='account' else config['account']}
    def describe_subnets(self,**kwargs):
        assert kwargs=={'SubnetIds':[config['subnet']]}
        return {'Subnets':[dict(SubnetId=config['subnet'],OwnerId=config['account'],VpcId='vpc-owned',State='available',Ipv6Native=False,Ipv6CidrBlockAssociationSet=[{}] if case=='ipv6' else [],MapPublicIpOnLaunch=case=='public-subnet',AvailableIpAddressCount=0 if case=='no-ips' else 20)]}
    def describe_security_groups(self,**kwargs):
        if kwargs=={'GroupIds':[job['security_group']]}:
            return {'SecurityGroups':[dict(GroupId=job['security_group'],OwnerId=config['account'],VpcId='vpc-owned',IpPermissionsEgress=[dict(IpProtocol='-1' if case=='broad-egress' else 'tcp',FromPort=config['port'],ToPort=config['port'],UserIdGroupPairs=[dict(GroupId=config['group'])])])]}
        assert kwargs=={'GroupIds':[config['group']]}
        return {'SecurityGroups':[dict(GroupId=config['group'],OwnerId=config['account'],VpcId='other' if case=='group-vpc' else 'vpc-owned',IpPermissions=[] if case=='no-ingress' else [dict(IpProtocol='tcp',FromPort=config['port'],ToPort=config['port'],UserIdGroupPairs=[dict(GroupId=job['security_group'],UserId=config['account'])])])]}
    def describe_instances(self,**kwargs):
        assert kwargs['Filters'][0]['Values']==[config['destination']]
        interface=dict(VpcId='vpc-owned',PrivateIpAddresses=[dict(PrivateIpAddress='10.0.0.1' if case=='wrong-ip' else config['destination'])],Groups=[dict(GroupId='other' if case=='wrong-interface-group' else config['group'])])
        instance=dict(InstanceId='i-0123456789abcdef0',NetworkInterfaces=[interface])
        if case in ['windows','rdp-ok']: instance['Platform']='windows'
        return {'Reservations':[dict(OwnerId='other' if case=='target-owner' else config['account'],Instances=[instance,instance] if case=='ambiguous' else [instance])],**({'NextToken':'more'} if case=='instance-page' else {})}
    def describe_instance_connect_endpoints(self):
        endpoint=dict(InstanceConnectEndpointId=job['id'],InstanceConnectEndpointArn=job['arn'],OwnerId=config['account'],VpcId='vpc-owned',SubnetId=config['subnet'],PreserveClientIp=case=='preserve-ip',IpAddressType='dualstack' if case=='dualstack' else 'ipv4',State='create-in-progress' if case=='creating' else 'create-complete',SecurityGroupIds=['other'] if case=='endpoint-group' else [job['security_group']])
        return {'InstanceConnectEndpoints':[endpoint] if script=='CHECK.py' or case=='existing' else [],**({'NextToken':'more'} if case=='endpoint-page' else {})}
boto=types.ModuleType('boto3');boto.Session=Session;core=types.ModuleType('botocore');cfg=types.ModuleType('botocore.config');cfg.Config=Config
sys.modules.update({'boto3':boto,'botocore':core,'botocore.config':cfg})
def output(arguments,**kwargs):
    assert arguments==['terraform','output','-json','instance_connect_endpoint'] and kwargs['timeout']==30
    return json.dumps(job)
subprocess.check_output=output
count=0
for script,scenarios in [('PREFLIGHT.py',['ok','account','ipv6','public-subnet','no-ips','group-vpc','wrong-ip','wrong-interface-group','windows','target-owner','ambiguous','instance-page','existing','endpoint-page']),('CHECK.py',['ok','preserve-ip','dualstack','creating','endpoint-group','no-ingress','broad-egress'])]:
    for case in scenarios:
        sys.argv=[script];error=None;captured=io.StringIO()
        try:
            with contextlib.redirect_stdout(captured):runpy.run_path(str(root/script),run_name='__main__')
        except Exception as exc:error=exc
        assert (error is None)==(case=='ok'),(script,case,error)
        if error is None: assert json.loads(captured.getvalue())['tunnel_opened'] is False
        count+=1
print(str(count)+' local generated metadata cases passed; no AWS/tunnel operations')
config['port']=3389
(root/'CONNECTION-CONFIG.json').write_text(json.dumps(config))
for case in ['rdp-ok','rdp-linux']:
    script='CHECK.py';sys.argv=[script];error=None
    try:
        with contextlib.redirect_stdout(io.StringIO()):runpy.run_path(str(root/script),run_name='__main__')
    except Exception as exc:error=exc
    assert (error is None)==(case=='rdp-ok'),(case,error)
print('2 RDP platform variant checks passed')
`);
const run=spawnSync(process.env.PYTHON_PATH||'python',[join(work,'harness.py')],{encoding:'utf8'});
process.stdout.write(run.stdout||'');process.stderr.write(run.stderr||'');
if(run.status!==0)throw new Error('Instance Connect check failed: '+work);
console.log(work);
