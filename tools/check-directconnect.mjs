/** Inspect exported Direct Connect script with local SDK doubles, no circuit or keys. */
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_DIRECTCONNECT_SERVICE as blueprint} from '../src/cloud/aws-directconnect-service.ts';
import {WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'directconnect-test-'));
const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',name:'private-vif',account:'123456789012',connection:'dxcon-1234abcd',connection_name:'approved-circuit',gateway:'12345678-abcd-4bcd-8bcd-123456789abc',gateway_name:'approved-gateway',onprem:'10.20.0.0/16',cloud:'10.100.0.0/16'});
if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const name of ['INSPECT.py','CONNECTION-CONFIG.json'])writeFileSync(join(work,name),result.files[name]);
writeFileSync(join(work,'harness.py'),String.raw`import contextlib, copy, io, json, pathlib, runpy, sys, types
root=pathlib.Path(__file__).resolve().parent; config=json.loads((root/'CONNECTION-CONFIG.json').read_text()); vif_id='dxvif-1234abcd'
base={
 'connection':dict(connectionId=config['connection'],connectionName=config['connectionName'],ownerAccount=config['account'],region=config['region'],connectionState='available',macSecCapable=True,encryptionMode='must_encrypt',portEncryptionStatus='Encryption Up',macSecKeys=[{'ckn':'SYNTHETIC-DO-NOT-PRINT','secretARN':'SYNTHETIC-DO-NOT-PRINT'}]),
 'gateway':dict(directConnectGatewayId=config['gateway'],directConnectGatewayName=config['gatewayName'],ownerAccount=config['account'],directConnectGatewayState='available',amazonSideAsn=config['amazonAsn']),
 'association':dict(directConnectGatewayId=config['gateway'],directConnectGatewayOwnerAccount=config['account'],associationState='associated',associatedGateway={'id':'vgw-0123456789abcdef0','type':'virtualPrivateGateway','ownerAccount':config['account'],'region':config['region']},allowedPrefixesToDirectConnectGateway=[{'cidr':value} for value in config['cloud']]),
 'vif':dict(virtualInterfaceId=vif_id,virtualInterfaceName=config['name'],ownerAccount=config['account'],connectionId=config['connection'],directConnectGatewayId=config['gateway'],virtualInterfaceType='private',addressFamily='ipv4',vlan=config['vlan'],asn=config['customerAsn'],amazonSideAsn=config['amazonAsn'],amazonAddress=config['amazon'],customerAddress=config['customer'],mtu=1500,siteLinkEnabled=False,virtualInterfaceState='available',authKey='SYNTHETIC-DO-NOT-PRINT',bgpPeers=[dict(addressFamily='ipv4',amazonAddress=config['amazon'],customerAddress=config['customer'],bgpPeerState='available',bgpStatus='down',authKey='SYNTHETIC-DO-NOT-PRINT')]),
}
class Config:
    def __init__(self,retries,use_fips_endpoint): assert retries==dict(total_max_attempts=1,mode='standard') and use_fips_endpoint is True
class Session:
    def __init__(self,region_name): assert region_name==config['region']
    def client(self,name,config): assert name in ['sts','directconnect'] and isinstance(config,Config); return self
    def get_caller_identity(self): return {'Account':'000000000000' if scenario=='account' else config['account']}
    def describe_connections(self,**kwargs): assert kwargs==dict(connectionId=config['connection']); return {'connections':[data['connection']]}
    def describe_direct_connect_gateways(self,**kwargs): assert kwargs==dict(directConnectGatewayId=config['gateway'],maxResults=100); return {'directConnectGateways':[data['gateway']]}
    def describe_direct_connect_gateway_associations(self,**kwargs):
        assert {key:value for key,value in kwargs.items() if key!='nextToken'}==dict(directConnectGatewayId=config['gateway'],maxResults=100)
        if scenario in ['association-page','association-repeat'] and not kwargs.get('nextToken'): return {'directConnectGatewayAssociations':[],'nextToken':'one'}
        return {'directConnectGatewayAssociations':[] if scenario=='association-none' else [data['association']],'nextToken':'one' if scenario=='association-repeat' else ''}
    def describe_virtual_interfaces(self,**kwargs):
        assert kwargs==dict(connectionId=config['connection'])
        if scenario in ['preflight','association-page']: return {'virtualInterfaces':[]}
        if scenario=='quota': return {'virtualInterfaces':[dict(virtualInterfaceId='other-'+str(index),virtualInterfaceType='private',vlan=index+200,virtualInterfaceState='available') for index in range(50)]}
        return {'virtualInterfaces':[data['vif']]}
sdk=types.ModuleType('boto3'); sdk.Session=Session; sys.modules['boto3']=sdk
botocore=types.ModuleType('botocore'); botocore.__path__=[]; sys.modules['botocore']=botocore
module=types.ModuleType('botocore.config'); module.Config=Config; sys.modules['botocore.config']=module
cases=[('preflight',[],None),('check',[],None),('up',[],None),('require-up-down',[],None),('association-page',[],None),('association-repeat',[],None),('association-none',[],None),('vlan-conflict',[],None),('quota',[],None),('account',[],None),
 ('connection-id',['connection','connectionId'],'other'),('connection-name',['connection','connectionName'],'other'),('connection-owner',['connection','ownerAccount'],'other'),('connection-region',['connection','region'],'us-west-2'),('connection-down',['connection','connectionState'],'down'),('hosted',['connection','vlan'],101),('lag',['connection','lagId'],'dxlag-other'),('macsec-incapable',['connection','macSecCapable'],False),('macsec-mode',['connection','encryptionMode'],'should_encrypt'),('macsec-down',['connection','portEncryptionStatus'],'Encryption Down'),('gateway-id',['gateway','directConnectGatewayId'],'other'),('gateway-owner',['gateway','ownerAccount'],'other'),('gateway-state',['gateway','directConnectGatewayState'],'pending'),('gateway-asn',['gateway','amazonSideAsn'],65001),
 ('association-pending',['association','associationState'],'associating'),('association-region',['association','associatedGateway','region'],'us-west-2'),('association-owner',['association','associatedGateway','ownerAccount'],'other'),('association-transit',['association','associatedGateway','type'],'transitGateway'),('association-core',['association','associatedCoreNetwork'],{'id':'core-network-other'}),('association-prefix',['association','allowedPrefixesToDirectConnectGateway'],[{'cidr':'10.101.0.0/16'}]),
 ('vif-owner',['vif','ownerAccount'],'other'),('vif-source',['vif','connectionId'],'other'),('vif-gateway',['vif','directConnectGatewayId'],'other'),('vif-transit',['vif','virtualInterfaceType'],'transit'),('vif-ipv6',['vif','addressFamily'],'ipv6'),('vif-asn',['vif','asn'],65001),('vif-cloud-asn',['vif','amazonSideAsn'],64513),('vif-mtu',['vif','mtu'],9001),('vif-sitelink',['vif','siteLinkEnabled'],True),('vif-vgw',['vif','virtualGatewayId'],'vgw-other'),('vif-state',['vif','virtualInterfaceState'],'confirming'),('vif-amazon-ip',['vif','amazonAddress'],'169.254.101.1/30'),('vif-customer-ip',['vif','customerAddress'],'169.254.101.2/30'),('peer-state',['vif','bgpPeers',0,'bgpPeerState'],'pending'),('peer-address',['vif','bgpPeers',0,'amazonAddress'],'169.254.101.1/30'),('peer-unknown-state',['vif','bgpPeers',0,'bgpStatus'],'not-a-state')]
for scenario,path,value in cases:
    data=copy.deepcopy(base)
    if path:
        parent=data
        for key in path[:-1]: parent=parent[key]
        parent[path[-1]]=value
    if scenario=='up': data['vif']['bgpPeers'][0]['bgpStatus']='up'
    flags=[] if scenario in ['preflight','association-page','vlan-conflict','quota'] else ['--vif',vif_id]
    if scenario in ['up','require-up-down']: flags+=['--require-bgp-up']
    sys.argv=['INSPECT.py']+flags; failure=None
    with contextlib.redirect_stdout(io.StringIO()) as output:
        try: runpy.run_path(str(root/'INSPECT.py'),run_name='__main__')
        except Exception as error: failure=error
    success=scenario in ['preflight','check','up','association-page']
    assert bool(failure)!=success,(scenario,failure)
    assert 'SYNTHETIC-DO-NOT-PRINT' not in output.getvalue()
    if success:
        report=json.loads(output.getvalue()); assert not report['bgp_or_macsec_keys_printed_or_written'] and not report['cpe_or_routes_changed'] and not report['data_plane_or_classification_acceptance_verified']
print('Passed',len(cases),'generated DirectConnect metadata cases; no AWS, circuit, CPE, routes or real credentials.')
`);
const check=spawnSync(process.env.PYTHON_PATH||'python',[join(work,'harness.py')],{cwd:work,encoding:'utf8',timeout:60000,windowsHide:true});
process.stdout.write(check.stdout||'');process.stderr.write(check.stderr||'');if(check.error)throw check.error;
console.log(work);process.exitCode=check.status??1;
