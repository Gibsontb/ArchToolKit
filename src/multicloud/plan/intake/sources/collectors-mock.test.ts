/**
 * Runs every jq-based discovery collector against mock platform CLIs (a fake
 * pvesh, xe, curl, aws, az, gcloud, oci, kubectl on PATH) and parses the
 * output through discovery.ts. Skipped where bash or jq is missing.
 */
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from '../../../../testing/expect.ts';
import { parseKubectlWorkloads, parseKubectlNodes } from '../../sizing/k8s-import.ts';
import { parseDiscovery, renderCollector, type CollectorId } from './index.ts';

const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;
const hasJq = hasBash && spawnSync('bash', ['-c', 'command -v jq']).status === 0;

/** Runs a collector with the given mock executables; returns stdout, and the run directory. */
function run(id: CollectorId, mocks: Record<string, string>, args: string[] = [], env: Record<string, string> = {}): { out: string; dir: string; status: number | null; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), `atk-${id}-`));
  mkdirSync(join(dir, 'bin'));
  for (const [name, body] of Object.entries(mocks)) {
    writeFileSync(join(dir, 'bin', name), `#!/usr/bin/env bash\n${body}`);
    chmodSync(join(dir, 'bin', name), 0o755);
  }
  const script = join(dir, 'collector.sh');
  writeFileSync(script, renderCollector(id).content);
  const r = spawnSync('bash', [script, ...args], {
    encoding: 'utf8', cwd: dir,
    env: { ...process.env, PATH: `${join(dir, 'bin')}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`, ...env },
  });
  return { out: r.stdout, dir, status: r.status, stderr: r.stderr };
}

/** The last argument (curl's URL). */
const CURL_URL = 'cat >/dev/null; for url; do :; done';

describe('jq collectors against mock platform CLIs', { skip: !hasJq }, () => {
  it('collect-proxmox.sh', () => {
    const pvesh = String.raw`
case "$2" in
  /cluster/status) echo '[{"type":"cluster","name":"pve-cluster"},{"type":"node","name":"pve1"}]' ;;
  /cluster/resources) echo '[{"vmid":101,"name":"git01","node":"pve1","type":"qemu","status":"running","maxcpu":2,"maxmem":4294967296,"template":0,"tags":"prod;git"},{"vmid":102,"name":"cache01","node":"pve2","type":"lxc","status":"running","maxcpu":1,"maxmem":1073741824},{"vmid":900,"name":"tpl","node":"pve1","type":"qemu","template":1}]' ;;
  /nodes/pve1/qemu/101/config) echo '{"sockets":1,"cores":2,"memory":4096,"bios":"ovmf","efidisk0":"local-lvm:vm-101-disk-1,size=4M","scsi0":"local-lvm:vm-101-disk-0,size=32G","scsi1":"local-lvm:vm-101-disk-2,size=1T","ide2":"none,media=cdrom","net0":"virtio=BC:24:11:AA:BB:CC,bridge=vmbr0","ostype":"l26","description":"Git server"}' ;;
  /nodes/pve1/qemu/101/agent/get-osinfo) echo '{"result":{"pretty-name":"Debian GNU/Linux 12 (bookworm)","version-id":"12"}}' ;;
  /nodes/pve1/qemu/101/agent/network-get-interfaces) echo '{"result":[{"name":"lo","hardware-address":"00:00:00:00:00:00","ip-addresses":[{"ip-address-type":"ipv4","ip-address":"127.0.0.1"}]},{"name":"eth0","hardware-address":"bc:24:11:aa:bb:cc","ip-addresses":[{"ip-address-type":"ipv4","ip-address":"10.4.0.5"},{"ip-address-type":"ipv6","ip-address":"fe80::be24:11ff"},{"ip-address-type":"ipv6","ip-address":"2001:db8:4::5"}]}]}' ;;
  /nodes/pve2/lxc/102/config) echo '{"cores":1,"memory":1024,"rootfs":"local-lvm:vm-102-disk-0,size=8G","net0":"name=eth0,bridge=vmbr0,hwaddr=BC:24:11:AA:BB:CD,ip=dhcp","ostype":"debian","hostname":"cache01"}' ;;
  /nodes/pve2/lxc/102/interfaces) echo '[{"name":"lo","inet":"127.0.0.1/8"},{"name":"eth0","hwaddr":"bc:24:11:aa:bb:cd","inet":"10.4.0.6/24","inet6":"fe80::1/64"}]' ;;
  *) echo "unexpected pvesh $*" >&2; exit 1 ;;
esac`;
    const r = run('proxmox', { pvesh });
    expect(r.stderr).toBe('');
    const p = parseDiscovery(r.out);
    expect(p.file?.source).toEqual({ platform: 'proxmox', manager: 'pve-cluster' });
    const [git, cache] = p.servers;
    expect([git!.name, git!.vcpu, git!.memoryGib, git!.disksGib, git!.facts?.firmware, git!.os, git!.facts?.ipAddresses]).toEqual(['git01', 2, 4, [32, 1024], 'efi', 'debian-12', ['10.4.0.5', '2001:db8:4::5']]);
    expect(git!.sourceRef).toEqual({ platform: 'proxmox', manager: 'pve-cluster', id: '101', host: 'pve1', cluster: 'pve-cluster' });
    expect([cache!.name, cache!.vcpu, cache!.memoryGib, cache!.disksGib, cache!.facts?.ipAddresses]).toEqual(['cache01', 1, 1, [8], ['10.4.0.6']]);
    expect(p.findings.map((f) => f.code)).toContain('plan.sources.lxc');
    rmSync(r.dir, { recursive: true, force: true });
  });

  it('collect-ovirt.sh', () => {
    const curl = String.raw`${CURL_URL}
case "$url" in
  */hosts) echo '{"host":[{"id":"h1","name":"olvm-host1"}]}' ;;
  */clusters) echo '{"cluster":[{"id":"c1","name":"Default"}]}' ;;
  */vms*) echo '{"vm":[{"id":"8f2d","name":"app-olvm01","status":"up","memory":"17179869184","cpu":{"topology":{"sockets":"2","cores":"2","threads":"1"}},"bios":{"type":"q35_ovmf"},"os":{"type":"rhel_8x64"},"host":{"id":"h1"},"cluster":{"id":"c1"},"description":"Payments","guest_operating_system":{"distribution":"Oracle Linux Server","version":{"full_version":"8.9"}},"disk_attachments":{"disk_attachment":[{"bootable":"false","disk":{"provisioned_size":"107374182400","actual_size":"1073741824"}},{"bootable":"true","disk":{"provisioned_size":"64424509440","actual_size":"24051816448"}}]},"nics":{"nic":[{"mac":{"address":"56:6f:1a:2b:3c:4d"},"reported_devices":{"reported_device":[{"ips":{"ip":[{"address":"10.5.0.9","version":"v4"},{"address":"fe80::1","version":"v6"}]}}]}}]}}]}' ;;
  *) echo "unexpected curl $url" >&2; exit 22 ;;
esac`;
    const r = run('ovirt', { curl }, [], { OVIRT_URL: 'https://engine.corp.example', OVIRT_USER: 'admin@internal', OVIRT_PASSWORD: 'pw' });
    expect(r.stderr).toBe('');
    expect(r.out.includes('pw"')).toBe(false);
    const s = parseDiscovery(r.out).servers[0]!;
    expect([s.name, s.vcpu, s.memoryGib, s.disksGib, s.facts?.disksUsedGib, s.facts?.firmware, s.os, s.facts?.ipAddresses]).toEqual(['app-olvm01', 4, 16, [60, 100], [22.4, 1], 'efi', 'ol-8', ['10.5.0.9']]);
    expect(s.sourceRef).toEqual({ platform: 'ovirt', manager: 'engine.corp.example', id: '8f2d', host: 'olvm-host1', cluster: 'Default' });
    rmSync(r.dir, { recursive: true, force: true });
  });

  it('collect-xen.sh', () => {
    const xe = String.raw`
args="$*"
case "$1" in
  pool-list) echo pool-a ;;
  vm-list) echo 'u1' ;;
  host-param-get) echo xs01 ;;
  vbd-list) echo 'vdi1,vdi2' ;;
  vdi-param-get) case "$args" in *vdi1*virtual-size*) echo 107374182400 ;; *vdi1*) echo 59055800320 ;; *virtual-size*) echo 21474836480 ;; *) echo 0 ;; esac ;;
  vif-list) echo 'aa:bb:cc:00:11:22' ;;
  vm-param-get)
    case "$args" in
      *param-name=name-label*) echo ctx-vda01 ;;
      *param-name=power-state*) echo running ;;
      *param-name=VCPUs-max*) echo 4 ;;
      *param-name=memory-static-max*) echo 17179869184 ;;
      *param-name=os-version*) echo 'Microsoft Windows Server 2019 Standard' ;;
      *param-name=name-description*) echo 'Citrix VDA' ;;
      *param-name=HVM-boot-params*) echo uefi ;;
      *param-name=resident-on*) echo h-uuid ;;
      *param-name=networks*) echo '0/ip: 10.6.0.40; 0/ipv4/0: 10.6.0.40; 0/ipv6/0: fe80::1; 0/ipv6/1: 2001:db8:6::40' ;;
    esac ;;
  *) echo "unexpected xe $*" >&2; exit 1 ;;
esac`;
    const r = run('xen', { xe });
    expect(r.stderr).toBe('');
    const s = parseDiscovery(r.out).servers[0]!;
    expect([s.name, s.vcpu, s.memoryGib, s.disksGib, s.facts?.disksUsedGib, s.facts?.firmware, s.os, s.facts?.ipAddresses, s.annotation]).toEqual(['ctx-vda01', 4, 16, [100, 20], [55, 0], 'efi', 'win-2019', ['10.6.0.40', '2001:db8:6::40'], 'Citrix VDA']);
    expect(s.sourceRef).toEqual({ platform: 'xen', manager: 'pool-a', id: 'u1', host: 'xs01', cluster: 'pool-a' });
    rmSync(r.dir, { recursive: true, force: true });
  });

  it('collect-ahv.sh (v4, with categories)', () => {
    const curl = String.raw`${CURL_URL}
case "$url" in
  */prism/v4.0/config/categories*) echo '{"data":[{"extId":"cat-1","key":"App","value":"ERP"},{"extId":"cat-2","key":"Environment","value":"Production"}]}' ;;
  */vmm/v4.1/ahv/config/vms*) echo '{"data":[{"extId":"vm-1","name":"erp-db01","powerState":"ON","numSockets":2,"numCoresPerSocket":4,"numThreadsPerCore":1,"memorySizeBytes":68719476736,"bootConfig":{"$objectType":"vmm.v4.ahv.config.UefiBoot"},"host":{"extId":"host-1"},"cluster":{"extId":"cl-1"},"description":"ERP DB","disks":[{"backingInfo":{"diskSizeBytes":107374182400}},{"backingInfo":{"diskSizeBytes":536870912000}}],"nics":[{"backingInfo":{"macAddress":"50:6b:8d:01:02:03"},"networkInfo":{"ipv4Config":{"ipAddress":{"value":"10.3.0.21"}}}}],"categories":[{"extId":"cat-1"},{"extId":"cat-2"}]}]}' ;;
  *) echo "unexpected curl $url" >&2; exit 22 ;;
esac`;
    const r = run('ahv', { curl }, [], { PRISM_CENTRAL: 'pc01.corp.example', PRISM_USER: 'svc', PRISM_PASSWORD: 'pw' });
    expect(r.stderr).toBe('');
    const s = parseDiscovery(r.out).servers[0]!;
    expect([s.name, s.vcpu, s.memoryGib, s.disksGib, s.facts?.firmware, s.facts?.ipAddresses, s.facts?.powerState]).toEqual(['erp-db01', 8, 64, [100, 500], 'efi', ['10.3.0.21'], 'poweredOn']);
    expect(s.tags).toEqual({ App: 'ERP', Environment: 'Production' });
    rmSync(r.dir, { recursive: true, force: true });
  });

  it('collect-ahv.sh falls back to v3', () => {
    const curl = String.raw`${CURL_URL}
case "$url" in
  */vmm/v4.1/*|*/prism/v4.0/*) exit 22 ;;
  */nutanix/v3/vms/list) echo '{"metadata":{"total_matches":1},"entities":[{"metadata":{"uuid":"u-1","categories":{"App":"ERP"}},"spec":{"name":"erp-app01","description":"app"},"status":{"cluster_reference":{"name":"prod-cl1"},"resources":{"power_state":"ON","num_sockets":2,"num_vcpus_per_socket":2,"memory_size_mib":16384,"host_reference":{"name":"node-3"},"boot_config":{"boot_type":"LEGACY"},"disk_list":[{"disk_size_mib":102400,"device_properties":{"device_type":"DISK"}},{"disk_size_mib":0,"device_properties":{"device_type":"CDROM"}}],"nic_list":[{"mac_address":"50:6b:8d:01:02:04","ip_endpoint_list":[{"ip":"10.3.0.30"}]}]}}}]}' ;;
  *) echo "unexpected curl $url" >&2; exit 22 ;;
esac`;
    const r = run('ahv', { curl }, [], { PRISM_CENTRAL: 'pc01', PRISM_USER: 'svc', PRISM_PASSWORD: 'pw' });
    const s = parseDiscovery(r.out).servers[0]!;
    expect([s.name, s.vcpu, s.memoryGib, s.disksGib, s.facts?.firmware, s.sourceRef?.host, s.tags]).toEqual(['erp-app01', 4, 16, [100], 'bios', 'node-3', { App: 'ERP' }]);
    rmSync(r.dir, { recursive: true, force: true });
  });

  it('collect-aws.sh', () => {
    const aws = String.raw`
case "$*" in
  *sts\ get-caller-identity*) echo 123456789012 ;;
  *describe-volumes*) echo '{"Volumes":[{"VolumeId":"vol-1","Size":50},{"VolumeId":"vol-2","Size":200}]}' ;;
  *describe-instances*) echo '{"Reservations":[{"Instances":[{"InstanceId":"i-0abc","InstanceType":"m5.xlarge","ImageId":"ami-1","State":{"Name":"running"},"Placement":{"AvailabilityZone":"eu-west-1a"},"CpuOptions":{"CoreCount":2,"ThreadsPerCore":2},"BootMode":"uefi","RootDeviceName":"/dev/xvda","PlatformDetails":"Linux/UNIX","BlockDeviceMappings":[{"DeviceName":"/dev/sdf","Ebs":{"VolumeId":"vol-2"}},{"DeviceName":"/dev/xvda","Ebs":{"VolumeId":"vol-1"}}],"NetworkInterfaces":[{"MacAddress":"0a:1b","PrivateIpAddresses":[{"PrivateIpAddress":"172.31.10.20"}],"Association":{"PublicIp":"52.1.2.3"},"Ipv6Addresses":[{"Ipv6Address":"2a05:d018::20"}]}],"Tags":[{"Key":"Name","Value":"crm-api01"},{"Key":"app","Value":"CRM"}]},{"InstanceId":"i-dead","State":{"Name":"terminated"}}]}]}' ;;
  *describe-images*) echo '{"Images":[{"ImageId":"ami-1","Name":"RHEL-9.4.0_HVM-20240605-x86_64","Description":"Red Hat Enterprise Linux 9.4"}]}' ;;
  *) echo "unexpected aws $*" >&2; exit 1 ;;
esac`;
    const r = run('aws', { aws }, ['--regions', 'eu-west-1']);
    expect(r.stderr).toBe('');
    const p = parseDiscovery(r.out);
    expect(p.servers.length).toBe(1);
    const s = p.servers[0]!;
    expect([s.name, s.vcpu, s.memoryGib, s.disksGib, s.facts?.firmware, s.os, s.facts?.ipAddresses]).toEqual(['crm-api01', 4, 16, [50, 200], 'efi', 'rhel-9', ['172.31.10.20', '52.1.2.3', '2a05:d018::20']]);
    expect(s.sourceRef).toEqual({ platform: 'aws', manager: '123456789012', id: 'i-0abc', cluster: 'eu-west-1a', region: 'eu-west-1' });
    expect(s.tags).toEqual({ Name: 'crm-api01', app: 'CRM' });
    rmSync(r.dir, { recursive: true, force: true });
  });

  it('collect-azure.sh', () => {
    const az = String.raw`
case "$*" in
  account\ show*) echo sub-1 ;;
  disk\ list*) echo '[{"id":"/subscriptions/sub-1/resourceGroups/RG-HR/providers/Microsoft.Compute/disks/hr-sql01-os","diskSizeGB":128,"hyperVGeneration":"V2"},{"id":"/subscriptions/sub-1/resourceGroups/rg-hr/providers/Microsoft.Compute/disks/hr-sql01-data","diskSizeGB":1024}]' ;;
  vm\ list*) echo '[{"name":"hr-sql01","id":"/subscriptions/sub-1/resourceGroups/rg-hr/providers/Microsoft.Compute/virtualMachines/hr-sql01","location":"westeurope","resourceGroup":"rg-hr","powerState":"VM running","hardwareProfile":{"vmSize":"Standard_E8s_v5"},"privateIps":"10.20.1.4,fd00:20::4","publicIps":"","macAddresses":"00-0D-3A-00-00-01","storageProfile":{"imageReference":{"offer":"sql2019-ws2019","sku":"enterprise"},"osDisk":{"osType":"Windows","diskSizeGb":null,"managedDisk":{"id":"/subscriptions/sub-1/resourceGroups/rg-hr/providers/Microsoft.Compute/disks/hr-sql01-os"}},"dataDisks":[{"diskSizeGb":null,"managedDisk":{"id":"/subscriptions/sub-1/resourceGroups/rg-hr/providers/Microsoft.Compute/disks/hr-sql01-data"}}]},"tags":{"application":"HR"}}]' ;;
  *) echo "unexpected az $*" >&2; exit 1 ;;
esac`;
    const r = run('azure', { az });
    expect(r.stderr).toBe('');
    const s = parseDiscovery(r.out).servers[0]!;
    expect([s.name, s.vcpu, s.memoryGib, s.disksGib, s.facts?.firmware, s.facts?.ipAddresses, s.facts?.powerState]).toEqual(['hr-sql01', 8, 64, [128, 1024], 'efi', ['10.20.1.4', 'fd00:20::4'], 'poweredOn']);
    expect(s.tags).toEqual({ application: 'HR' });
    rmSync(r.dir, { recursive: true, force: true });
  });

  it('collect-gcp.sh', () => {
    const gcloud = String.raw`
case "$*" in
  config\ get-value*) echo acme-prod ;;
  *disks\ list*) echo '[{"selfLink":"https://www.googleapis.com/compute/v1/projects/acme-prod/zones/europe-west2-a/disks/bi-1","sizeGb":"100"}]' ;;
  *instances\ list*) echo '[{"name":"bi-worker-1","id":"1234567890123456789","zone":"https://www.googleapis.com/compute/v1/projects/acme-prod/zones/europe-west2-a","status":"RUNNING","machineType":"https://www.googleapis.com/compute/v1/projects/acme-prod/zones/europe-west2-a/machineTypes/n2-standard-8","shieldedInstanceConfig":{"enableSecureBoot":false},"disks":[{"boot":true,"source":"https://www.googleapis.com/compute/v1/projects/acme-prod/zones/europe-west2-a/disks/bi-1","guestOsFeatures":[{"type":"UEFI_COMPATIBLE"}],"licenses":["https://www.googleapis.com/compute/v1/projects/rhel-cloud/global/licenses/rhel-9-server"]}],"networkInterfaces":[{"networkIP":"10.30.0.7","ipv6Address":"2600:1900::7","accessConfigs":[{"natIP":"34.1.2.3"}]}],"labels":{"app":"bi"}}]' ;;
  *) echo "unexpected gcloud $*" >&2; exit 1 ;;
esac`;
    const r = run('gcp', { gcloud });
    expect(r.stderr).toBe('');
    const s = parseDiscovery(r.out).servers[0]!;
    expect([s.name, s.vcpu, s.memoryGib, s.disksGib, s.facts?.firmware, s.os, s.facts?.ipAddresses]).toEqual(['bi-worker-1', 8, 32, [100], 'efi', 'rhel-9', ['10.30.0.7', '34.1.2.3', '2600:1900::7']]);
    expect(s.sourceRef).toEqual({ platform: 'google', manager: 'acme-prod', id: '1234567890123456789', cluster: 'europe-west2-a', region: 'europe-west2' });
    rmSync(r.dir, { recursive: true, force: true });
  });

  it('collect-oci.sh', () => {
    const oci = String.raw`
case "$*" in
  *compute\ instance\ list-vnics*) echo '{"data":[{"mac-address":"02:00:17:00:00:01","private-ip":"10.40.0.3","public-ip":null,"ipv6-addresses":["2603:c020::3"]}]}' ;;
  *compute\ instance\ list*) echo '{"data":[{"id":"ocid1.instance.1","display-name":"fin-app01","region":"uk-london-1","availability-domain":"Uocm:LHR-AD-1","lifecycle-state":"RUNNING","shape":"VM.Standard.E5.Flex","shape-config":{"ocpus":2,"vcpus":4,"memory-in-gbs":32},"launch-options":{"firmware":"UEFI_64"},"source-details":{"image-id":"ocid1.image.1"},"freeform-tags":{"app":"Finance"},"defined-tags":{"Ops":{"CostCentre":"F100"}}},{"id":"ocid1.instance.2","lifecycle-state":"TERMINATED"}]}' ;;
  *bv\ volume\ list*) echo '{"data":[{"id":"ocid1.volume.1","size-in-gbs":500}]}' ;;
  *bv\ boot-volume\ list*) echo '{"data":[{"id":"ocid1.bootvolume.1","size-in-gbs":100}]}' ;;
  *compute\ image\ get*) echo '{"data":{"operating-system":"Oracle Linux","operating-system-version":"9"}}' ;;
  *boot-volume-attachment\ list*) echo '{"data":[{"boot-volume-id":"ocid1.bootvolume.1"}]}' ;;
  *volume-attachment\ list*) echo '{"data":[{"volume-id":"ocid1.volume.1","lifecycle-state":"ATTACHED"}]}' ;;
  *) echo "unexpected oci $*" >&2; exit 1 ;;
esac`;
    const r = run('oci', { oci }, [], { OCI_COMPARTMENT_ID: 'ocid1.compartment.1' });
    expect(r.stderr).toBe('');
    const p = parseDiscovery(r.out);
    expect(p.servers.length).toBe(1);
    const s = p.servers[0]!;
    expect([s.name, s.vcpu, s.memoryGib, s.disksGib, s.facts?.firmware, s.os, s.facts?.ipAddresses]).toEqual(['fin-app01', 4, 32, [100, 500], 'efi', 'ol-9', ['10.40.0.3', '2603:c020::3']]);
    expect(s.tags).toEqual({ app: 'Finance', 'Ops.CostCentre': 'F100' });
    rmSync(r.dir, { recursive: true, force: true });
  });

  it('collect-k8s.sh: the kubectl exports and the nodes as discovery', () => {
    const kubectl = String.raw`
case "$*" in
  *deploy,sts,ds*) echo '{"items":[{"kind":"Deployment","metadata":{"name":"web","namespace":"shop","annotations":{"secret":"x"}},"spec":{"replicas":3,"template":{"spec":{"containers":[{"name":"web","image":"x","env":[{"name":"PASSWORD","value":"p"}],"resources":{"requests":{"cpu":"500m","memory":"512Mi"}}}]}}}}]}' ;;
  *nodes*) echo '{"items":[{"metadata":{"name":"k8s-worker-1","labels":{"node-role.kubernetes.io/worker":"","kubernetes.io/arch":"amd64"}},"status":{"capacity":{"cpu":"8","memory":"32868924Ki"},"allocatable":{"cpu":"7910m","memory":"31000000Ki"},"conditions":[{"type":"Ready","status":"True"}],"addresses":[{"type":"InternalIP","address":"10.50.0.11"},{"type":"Hostname","address":"k8s-worker-1"}],"nodeInfo":{"osImage":"Ubuntu 22.04.4 LTS","kubeletVersion":"v1.30.2","containerRuntimeVersion":"containerd://1.7.13","architecture":"amd64"}}}]}' ;;
  *) echo "unexpected kubectl $*" >&2; exit 1 ;;
esac`;
    const r = run('k8s', { kubectl }, ['--out-dir', 'out', '--platform', 'vsphere']);
    expect(r.status).toBe(0);
    const workloadsText = readFileSync(join(r.dir, 'out', 'k8s-workloads.json'), 'utf8');
    expect(workloadsText.includes('PASSWORD')).toBe(false);
    expect(parseKubectlWorkloads(workloadsText).workloads.map((w) => [w.name, w.replicas, w.cpuRequestM, w.memRequestMib])).toEqual([['shop/web', 3, 500, 512]]);
    expect(parseKubectlNodes(readFileSync(join(r.dir, 'out', 'k8s-nodes.json'), 'utf8')).nodes).toBe(1);
    const d = parseDiscovery(readFileSync(join(r.dir, 'out', 'k8s-discovery.json'), 'utf8'));
    const s = d.servers[0]!;
    expect([s.name, s.origin, s.vcpu, s.memoryGib, s.os, s.facts?.ipAddresses]).toEqual(['k8s-worker-1', 'vsphere', 8, 31.3, 'ubuntu-22.04', ['10.50.0.11']]);
    rmSync(r.dir, { recursive: true, force: true });
  });
});
