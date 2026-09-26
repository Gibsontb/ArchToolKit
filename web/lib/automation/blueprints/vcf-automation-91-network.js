/**
 * VCF Automation 9.1 All Apps networking, protection and namespace objects:
 * Avi load balancing for a namespace, transit gateway NAT, IPsec VPN and
 * external connections, Live Recovery replication, VKS-supported Velero
 * backups, and the standalone namespace objects (volume, Secret, VM service).
 *
 * Sources: VCF Automation 9.1 what's new (Avi load balancer self-service with
 * quota; multiple transit gateways with NAT and IPsec VPN; multiple external
 * connections), VCF 9.1 support notes (BYO Velero deprecated in favour of the
 * VKS-supported Velero), the Avi Kubernetes Operator CRDs (HostRule, HTTPRule,
 * L4Rule), the NSX 9 Policy API for projects and transit gateways, the vSphere
 * Replication and Live Site Recovery REST APIs, Velero's Schedule and Backup
 * objects, and VM Operator's VirtualMachineService.
 *
 * Paths that could not be confirmed against a 9.1 system are marked VERIFY and
 * the scripts stop, rather than guess, when a path answers anything unexpected.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, info, warning,              } from '../../core/findings.js';
import { automationBlueprint,                          } from '../from-automation.js';
import { listOf,                 } from '../automation.js';
import { importMd, kubeStep, manualStep } from '../vcfa-import.js';
import { packageNameOf, toPackage } from '../vro/to-package.js';
import { familyOf, parseCidrAny } from '../../core/ip.js';
import { labelsOf, nsxConfig, nsxEnsureLines, nsxScript, nsxWorkflow, portOf, rowsOf, vcenterAuthLines, vcenterTagLines,                                                       } from './vcf-automation-91-kit.js';

const isIp = (text        )          => text !== '' && !text.includes('/') && familyOf(text) !== null;

// ---------------------------------------------------------------------------
// Avi load balancer for a namespace

function aviLoadBalancer(kit           )                      {
  const { PLATFORM, SRC, ALL_APPS, AREA, json, label, q, kubeScript, k8sYaml, kubeWorkflow, kubeConfig } = kit;
  return automationBlueprint({
    id: 'vcfa91_avi_load_balancer',
    platform: PLATFORM,
    label: 'An Avi load balancer for a namespace: L4 or L7, VIP, pool, health monitor, TLS',
    group: 'VCF Automation 9.1 — networking',
    description:
      '9.1 Avi load balancing as self-service for an All Apps namespace: a LoadBalancer VirtualMachineService (VMs) or Service (pods) that makes the Avi virtual service, its VIP from the namespace’s IP block and its pool from a label selector; for L7 an Ingress with the TLS certificate and host; an Avi health monitor through the AKO L4Rule or HTTPRule; and a check against the namespace’s load balancer quota before anything is created.',
    inputs: [
      { id: 'namespace', label: 'Namespace', control: 'text', default: 'team-a-prod-q4m8z' },
      { id: 'lb_name', label: 'Name', control: 'text', default: 'web-lb' },
      {
        id: 'backend',
        label: 'Pool members',
        control: 'select',
        options: [
          { value: 'vm', label: 'VM Service VMs (VirtualMachineService)' },
          { value: 'service', label: 'Pods in the namespace (Service)' },
        ],
        default: 'vm',
      },
      {
        id: 'vm_api',
        label: 'VM Operator API',
        control: 'select',
        options: [
          { value: 'v1alpha5', label: 'v1alpha5' },
          { value: 'v1alpha4', label: 'v1alpha4' },
          { value: 'v1alpha3', label: 'v1alpha3' },
        ],
        default: 'v1alpha5',
        showWhen: { input: 'backend', equals: ['vm'] },
      },
      { id: 'selector', label: 'Members labelled', control: 'text', default: 'app=web01' },
      {
        id: 'layer',
        label: 'Virtual service',
        control: 'select',
        options: [
          { value: 'L4', label: 'L4 — TCP/UDP, one VIP per service' },
          { value: 'L7', label: 'L7 — HTTP(S) Ingress with host and TLS' },
        ],
        default: 'L4',
      },
      { id: 'ports', label: 'Ports', control: 'textarea', default: 'https | TCP | 443 | 443', hint: 'name | protocol | port | target port', help: 'Protocol TCP or UDP. For L7 the first row is the backend port the Ingress sends to.' },
      { id: 'vip', label: 'Requested VIP', control: 'text', default: '', placeholder: 'empty: the next free address of the IP block', hint: 'IPv4 or IPv6' },
      { id: 'dual_stack', label: 'IPv6 VIP as well (dual stack)', control: 'toggle', default: false, showWhen: { input: 'backend', equals: ['service'] } },
      {
        id: 'health',
        label: 'Health monitor',
        control: 'select',
        options: [
          { value: 'System-TCP', label: 'TCP connect (System-TCP)' },
          { value: 'System-HTTP', label: 'HTTP (System-HTTP)' },
          { value: 'System-HTTPS', label: 'HTTPS (System-HTTPS)' },
          { value: 'System-Ping', label: 'Ping (System-Ping)' },
          { value: 'none', label: 'The Avi cloud default' },
        ],
        default: 'System-TCP',
      },
      { id: 'host', label: 'Host name', control: 'text', default: 'shop.example.com', showWhen: { input: 'layer', equals: ['L7'] } },
      { id: 'tls_secret', label: 'TLS certificate (kubernetes.io/tls Secret)', control: 'text', default: 'shop-tls', hint: 'Empty: plain HTTP', showWhen: { input: 'layer', equals: ['L7'] } },
      { id: 'check_quota', label: 'Stop when the load balancer quota is used up', control: 'toggle', default: true },
    ],
    automation: (values                 , name        )             => {
      const ns = str(values, 'namespace', 'team-a');
      const lb = label(str(values, 'lb_name', 'lb'), 'lb');
      const vmBackend = str(values, 'backend', 'vm') === 'vm';
      const vmApi = str(values, 'vm_api', 'v1alpha5');
      const selector = labelsOf(str(values, 'selector', ''));
      const l7 = str(values, 'layer', 'L4') === 'L7';
      const vip = str(values, 'vip', '');
      const dual = !vmBackend && bool(values, 'dual_stack', false);
      const health = str(values, 'health', 'System-TCP');
      const host = str(values, 'host', '');
      const tls = l7 ? str(values, 'tls_secret', '') : '';
      const quota = bool(values, 'check_quota', true);
      void name;

      const findings            = [];
      if (Object.keys(selector).length === 0) findings.push(error('vcfa91.avi.no-selector', 'No label selector: the pool would be empty.', { source: SRC }));
      const ports = rowsOf(str(values, 'ports', '')).flatMap(({ cells, line }) => {
        const [pname = '', proto = 'TCP', port = '', target = ''] = cells;
        const p = portOf(port);
        const t = portOf(target || port);
        if (!p || !t || p.endPort || t.endPort) {
          findings.push(error('vcfa91.avi.port', `Could not read the ports of "${line}".`, { remediation: 'name | TCP or UDP | port | target port', source: SRC }));
          return [];
        }
        if (!['TCP', 'UDP'].includes(proto.toUpperCase())) findings.push(error('vcfa91.avi.protocol', `"${proto}" is not TCP or UDP.`, { path: line, source: SRC }));
        return [{ name: label(pname || `p${p.port}`, `p${p.port}`), protocol: proto.toUpperCase(), port: p.port, targetPort: t.port }];
      });
      if (ports.length === 0) findings.push(error('vcfa91.avi.no-ports', 'No port is listed.', { source: SRC }));
      if (vip && !isIp(vip)) findings.push(error('vcfa91.avi.vip', `"${vip}" is not an IP address.`, { source: SRC }));
      if (l7 && !/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/i.test(host)) findings.push(error('vcfa91.avi.host', `"${host}" is not a host name.`, { source: SRC }));
      if (l7 && !tls) findings.push(warning('vcfa91.avi.no-tls', `The L7 virtual service for ${host} is plain HTTP.`, { remediation: 'Name a kubernetes.io/tls Secret in the namespace (see "Namespace objects") and it terminates TLS on the Avi service engine.', source: SRC }));
      if (l7 && ports.some((p) => p.protocol === 'UDP')) findings.push(error('vcfa91.avi.l7-udp', 'An L7 (HTTP) virtual service has no UDP.', { source: SRC }));
      if (!l7 && ['System-HTTP', 'System-HTTPS'].includes(health) && ports.some((p) => p.protocol === 'UDP')) findings.push(warning('vcfa91.avi.health-udp', `${health} cannot check a UDP pool.`, { source: SRC }));
      if (!quota) findings.push(info('vcfa91.avi.no-quota-check', 'The quota is not checked first: when it is used up the Service is created and stays without an address.', { source: SRC }));
      if (vmBackend && (vip.includes(':') || dual)) findings.push(warning('vcfa91.avi.vm-ipv6', 'An IPv6 VIP for a VirtualMachineService depends on the Supervisor network and Avi cloud being dual stack.', { remediation: 'VERIFY with kubectl explain virtualmachineservice.spec; the NSX VPC operator carves IPv4 subnets.', source: SRC }));

      const svcKind = vmBackend ? 'VirtualMachineService' : 'Service';
      const svcApi = vmBackend ? `vmoperator.vmware.com/${vmApi}` : 'v1';
      const svcPlural = vmBackend ? 'virtualmachineservices' : 'services';
      const ruleName = `${lb}-rule`;
      const annotations                         = {};
      if (!l7 && health !== 'none') annotations['ako.vmware.com/l4rule'] = ruleName;
      const objects                     = [
        {
          plural: svcPlural,
          object: {
            apiVersion: svcApi,
            kind: svcKind,
            metadata: { name: l7 ? `${lb}-backend` : lb, namespace: ns, labels: { 'vcf.automation/managed': 'true' }, ...(Object.keys(annotations).length ? { annotations } : {}) },
            spec: {
              type: l7 ? 'ClusterIP' : 'LoadBalancer',
              selector,
              ports: ports.map((p) => ({ name: p.name, protocol: p.protocol, port: p.port, targetPort: p.targetPort })),
              ...(!l7 && vip ? { loadBalancerIP: vip } : {}),
              ...(dual ? { ipFamilyPolicy: 'RequireDualStack', ipFamilies: ['IPv4', 'IPv6'] } : {}),
            },
          },
        },
      ];
      if (!l7 && health !== 'none') {
        objects.push({
          plural: 'l4rules',
          object: { apiVersion: 'ako.vmware.com/v1alpha2', kind: 'L4Rule', metadata: { name: ruleName, namespace: ns }, spec: { backendProperties: ports.map((p) => ({ port: p.port, protocol: p.protocol, healthMonitorRefs: [health] })) } },
        });
      }
      if (l7) {
        const first = ports[0];
        objects.push({
          plural: 'ingresses',
          object: {
            apiVersion: 'networking.k8s.io/v1',
            kind: 'Ingress',
            metadata: { name: lb, namespace: ns, labels: { 'vcf.automation/managed': 'true' } },
            spec: {
              ingressClassName: 'avi-lb',
              ...(tls ? { tls: [{ hosts: [host], secretName: tls }] } : {}),
              rules: [{ host, http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: `${lb}-backend`, port: { number: first ? first.port : 80 } } } }] } }],
            },
          },
        });
        if (health !== 'none') {
          objects.push({
            plural: 'httprules',
            object: { apiVersion: 'ako.vmware.com/v1beta1', kind: 'HTTPRule', metadata: { name: ruleName, namespace: ns }, spec: { fqdn: host, paths: [{ target: '/', healthMonitors: [health] }] } },
          });
        }
        if (vip) {
          objects.push({
            plural: 'hostrules',
            object: { apiVersion: 'ako.vmware.com/v1beta1', kind: 'HostRule', metadata: { name: `${lb}-host`, namespace: ns }, spec: { virtualhost: { fqdn: host, enableVirtualHost: true } } },
          });
          findings.push(info('vcfa91.avi.l7-vip', 'An L7 Ingress shares the Avi parent virtual service of the namespace; a requested VIP applies to L4 only.', { remediation: 'The VIP of an Ingress is the shared L7 VIP; ask for a dedicated VIP with an L4 service.', source: SRC }));
        }
      }
      const served = [...new Set(objects.map((o) => o.object.apiVersion).filter((v) => v !== 'v1'))];
      const yaml = k8sYaml(objects.map((o) => ({ comment: o.object.apiVersion.startsWith('ako.') ? [`VERIFY: kubectl explain ${o.object.kind.toLowerCase()}.spec — the AKO CRDs the Supervisor's Avi integration serves`] : undefined, object: o.object })));
      const quotaPre = String.raw`var QUOTA = ${JSON.stringify(quota && !l7)};
if (QUOTA) {
  var rq = kubeGet(collectionPath("v1", ${JSON.stringify(ns)}, "resourcequotas")) || { items: [] };
  for (var qi = 0; qi < (rq.items || []).length; qi++) {
    var st = rq.items[qi].status || {};
    var hard = st.hard && st.hard["services.loadbalancers"];
    if (hard === undefined) continue;
    var used = Number((st.used && st.used["services.loadbalancers"]) || 0);
    System.log("Load balancer quota " + rq.items[qi].metadata.name + ": " + used + " of " + hard + " used.");
    if (used >= Number(hard)) throw new Error("The load balancer quota of " + ${JSON.stringify(ns)} + " is used up (" + used + " of " + hard + "); nothing was created. Ask the organization administrator for more.");
  }
}`;
      const pkg = toPackage({
        packageName: packageNameOf('vcfa91', 'avi', ns, lb),
        description: `Creates the Avi ${l7 ? 'L7' : 'L4'} load balancer ${lb} in the All Apps namespace ${ns}.`,
        categoryPath: `${AREA}/Load balancers/${ns}/${lb}`,
        workflow: {
          name: `Create load balancer ${lb}`,
          description: `${quota && !l7 ? 'Checks the namespace load balancer quota, then creates' : 'Creates'}, in namespace ${ns} through its Kubernetes API, ${objects.map((o) => `the ${o.object.kind} ${o.object.metadata.name}`).join(', ')} — each that does not exist, never changing one that does. With dryRun true each is validated on the server (dryRun=All) and nothing is created.`,
          inputs: [kit.DRY_RUN_INPUT],
          outputs: kit.KUBE_OUTPUTS,
          script: kubeWorkflow({ resource: 'objects.json', served, pre: quotaPre }),
        },
        config: kubeConfig(`Create load balancer ${lb}`, '', objects.length),
        resources: [{ name: 'objects.json', content: json(objects) }],
      });

      const pre = [
        `NS=${q(ns)}`,
        ...(quota && !l7
          ? [
              '# The load balancer quota: stop before creating a Service that would never get an address.',
              "read -r USED HARD < <(kubectl get resourcequota -n \"$NS\" -o json | jq -r '[.items[].status | select(.hard[\"services.loadbalancers\"] != null) | [(.used[\"services.loadbalancers\"] // \"0\"), .hard[\"services.loadbalancers\"]]][0] // [\"0\",\"\"] | @tsv')",
              'if [[ -n "${HARD}" ]]; then',
              '  echo "Load balancer quota: ${USED} of ${HARD} used"',
              '  (( USED < HARD )) || { echo "The load balancer quota of ${NS} is used up; nothing was created." >&2; exit 2; }',
              'else echo "No services.loadbalancers quota on ${NS}."; fi',
            ]
          : []),
        `echo "Pool members (${Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(',')}):"`,
        `kubectl get ${vmBackend ? 'vm' : 'pods'} -n "$NS" -l ${q(Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(','))} || true`,
        '',
      ];

      return {
        platform: PLATFORM,
        title: `Avi ${l7 ? 'L7' : 'L4'} load balancer ${lb} in ${ns}`,
        effect: 'reversible',
        trigger: { kind: 'request', detail: 'A project member exposing an application, or a pipeline after the VMs or pods are up.' },
        scope: {
          what: `${l7 ? `https://${host}` : `VIP ${vip || '(next free)'}`} → ${vmBackend ? 'VMs' : 'pods'} labelled ${Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(',')} in ${ns}, ports ${ports.map((p) => `${p.protocol}/${p.port}`).join(', ')}.`,
          decidedBy: ['The label selector: every VM or pod that has, or later gets, those labels joins the pool.', 'The namespace’s IP block, which the VIP comes from, and its load balancer quota.', 'The Avi cloud and service engine group the provider delegated to the organization.'],
          ifWrong: 'A selector that matches too much sends traffic to things never meant to serve it; a VIP from a public block exposes whatever listens on those ports.',
        },
        guardrails: [
          { rule: 'Stops unless the current context is EXPECT_CONTEXT', because: 'The context is the scope.' },
          ...(quota && !l7 ? [{ rule: 'Stops when the namespace load balancer quota is used up', because: 'Otherwise the Service is created and waits with no address, and the next request finds the quota taken by it.' }] : []),
          { rule: 'kubectl create, never apply; each object only when it does not exist', because: 'An existing load balancer is not repointed at a different pool by a rerun.' },
          { rule: 'A server-side dry run first (--dry-run, or the dryRun input)', because: 'Admission checks the quota, the IP block and the AKO objects before an address is taken.' },
        ],
        dryRun: ['Run the workflow with dryRun true, or scripts/create-lb.sh --dry-run: a server-side dry run, nothing created.'],
        undo: [`kubectl delete -f ${lb}.k8s.yaml — the VIP goes back to the IP block and the quota is freed.`],
        told: ['Kubernetes events on the Service and Ingress (AKO reports virtual service errors there).', 'The Avi Controller’s own events for the virtual service.', 'The workflow log (AUDIT lines), its summary output and the webhook when set.'],
        requires: ['Avi load balancing delegated to the organization by the provider, with a load balancer quota (9.1).', `The members already labelled ${Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(',')}.`, ...(tls ? [`The kubernetes.io/tls Secret ${tls} in ${ns}.`] : [])],
        files: {
          ...pkg.files,
          [`${lb}.k8s.yaml`]: yaml,
          'scripts/create-lb.sh': kubeScript(`Create the Avi load balancer ${lb} in ${ns}.`, pre, [`${lb}.k8s.yaml`], `kubectl delete -f ${lb}.k8s.yaml`),
          'IMPORT.md': importMd({
            subject: `The Avi load balancer ${lb} in ${ns}: an Orchestrator workflow that creates it through the namespace's Kubernetes API, and the same objects as ${lb}.k8s.yaml for kubectl.`,
            orgs: ALL_APPS,
            steps: [...pkg.importSteps, kubeStep('Or: the load balancer with kubectl', 'scripts/create-lb.sh', [`${lb}.k8s.yaml`], ['The script checks the load balancer quota and lists the pool members first.'])],
            auth: ['kube', 'vcfa91'],
            verify: [
              'VERIFY: the AKO CRDs served in a Supervisor namespace (kubectl api-resources --api-group=ako.vmware.com): L4Rule (v1alpha2, service annotation ako.vmware.com/l4rule), HTTPRule and HostRule (v1beta1), and the Ingress class name (kubectl get ingressclass).',
              'The quota key services.loadbalancers is the Kubernetes ResourceQuota one; VERIFY that the 9.1 organization load balancer quota is enforced through it (kubectl describe resourcequota -n <namespace>).',
              kit.KUBE_VERIFY,
            ],
          }),
        },
        notes: [
          'A LoadBalancer VirtualMachineService makes VM Operator create a Service, which the Avi Kubernetes Operator turns into a virtual service with a VIP from the namespace’s IP block.',
          'Health monitors are Avi profile names; System-TCP, System-HTTP, System-HTTPS and System-Ping exist on every Avi Controller. A custom one must exist in the tenant first.',
        ],
        findings,
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Transit gateway: NAT, IPsec VPN, external connection

const NAT_ACTIONS = ['SNAT', 'DNAT', 'REFLEXIVE', 'NO_SNAT', 'NO_DNAT'];

function transitGateway(kit           )                      {
  const { PLATFORM, SRC, ALL_APPS, PROVIDER, AREA, json, label } = kit;
  return automationBlueprint({
    id: 'vcfa91_transit_gateway',
    platform: PLATFORM,
    label: 'Transit gateway services: NAT, IPsec VPN and an external connection',
    group: 'VCF Automation 9.1 — networking',
    description:
      '9.1 lets an organization have several transit gateways with NAT and IPsec VPN, and several external connections. This writes them as NSX Policy API objects in the organization’s NSX project: SNAT/DNAT/reflexive rules on the transit gateway (or a VPC), a policy-based IPsec VPN with its own IKE profile and the pre-shared key read from a file at run time, and the transit gateway’s attachment to a provider gateway or distributed VLAN connection.',
    inputs: [
      { id: 'nsx_project', label: 'NSX project of the organization', control: 'text', default: 'team-a', hint: 'GET /policy/api/v1/orgs/default/projects' },
      { id: 'tgw', label: 'Transit gateway', control: 'text', default: 'default' },
      {
        id: 'nat_on',
        label: 'NAT on',
        control: 'select',
        options: [
          { value: 'transit-gateway', label: 'The transit gateway' },
          { value: 'vpc', label: 'A VPC' },
          { value: 'none', label: 'No NAT' },
        ],
        default: 'transit-gateway',
      },
      { id: 'vpc', label: 'VPC', control: 'text', default: 'region1-default-vpc', showWhen: { input: 'nat_on', equals: ['vpc'] } },
      {
        id: 'nat_rules',
        label: 'NAT rules',
        control: 'textarea',
        default: 'SNAT | 10.10.0.0/16 | any | 203.0.113.10 | any\nDNAT | any | 203.0.113.20 | 10.10.1.5 | tcp/443',
        hint: 'action | source | destination | translated | service',
        help: `Action: ${NAT_ACTIONS.join(', ')}. Addresses IPv4, a CIDR or "any". Service "any" or tcp/443, udp/53.`,
        showWhen: { input: 'nat_on', notEquals: ['none'] },
      },
      { id: 'ipsec', label: 'IPsec VPN', control: 'toggle', default: true },
      { id: 'vpn_name', label: 'VPN name', control: 'text', default: 'to-dc2', showWhen: { input: 'ipsec', equals: ['true'] } },
      { id: 'peer_address', label: 'Peer address', control: 'text', default: '198.51.100.10', showWhen: { input: 'ipsec', equals: ['true'] } },
      { id: 'peer_id', label: 'Peer id', control: 'text', default: '', hint: 'Empty: the peer address', showWhen: { input: 'ipsec', equals: ['true'] } },
      { id: 'local_address', label: 'Local endpoint address', control: 'text', default: '203.0.113.2', hint: 'From the external IP block', showWhen: { input: 'ipsec', equals: ['true'] } },
      { id: 'local_cidrs', label: 'Local networks', control: 'text', default: '10.10.0.0/16', hint: 'Comma separated; IPv4 or IPv6', showWhen: { input: 'ipsec', equals: ['true'] } },
      { id: 'remote_cidrs', label: 'Remote networks', control: 'text', default: '192.168.0.0/16', hint: 'Comma separated; IPv4 or IPv6', showWhen: { input: 'ipsec', equals: ['true'] } },
      {
        id: 'ike_version',
        label: 'IKE version',
        control: 'select',
        options: [
          { value: 'IKE_V2', label: 'IKEv2' },
          { value: 'IKE_V1', label: 'IKEv1' },
          { value: 'IKE_FLEX', label: 'Flex (v2, falls back to v1)' },
        ],
        default: 'IKE_V2',
        showWhen: { input: 'ipsec', equals: ['true'] },
      },
      {
        id: 'ike_encryption',
        label: 'IKE encryption',
        control: 'select',
        options: [
          { value: 'AES_256', label: 'AES-256 with SHA2-256' },
          { value: 'AES_128', label: 'AES-128 with SHA2-256' },
          { value: 'AES_GCM_256', label: 'AES-GCM-256 (IKEv2)' },
          { value: 'AES_GCM_128', label: 'AES-GCM-128 (IKEv2)' },
        ],
        default: 'AES_256',
        showWhen: { input: 'ipsec', equals: ['true'] },
      },
      {
        id: 'dh_group',
        label: 'Diffie-Hellman group',
        control: 'select',
        options: [
          { value: 'GROUP14', label: 'Group 14 (2048-bit MODP)' },
          { value: 'GROUP19', label: 'Group 19 (ECP 256)' },
          { value: 'GROUP20', label: 'Group 20 (ECP 384)' },
          { value: 'GROUP21', label: 'Group 21 (ECP 521)' },
        ],
        default: 'GROUP14',
        showWhen: { input: 'ipsec', equals: ['true'] },
      },
      { id: 'external', label: 'Attach an external connection', control: 'toggle', default: false },
      {
        id: 'connection_type',
        label: 'Connection',
        control: 'select',
        options: [
          { value: 'gateway', label: 'Provider gateway connection (Tier-0)' },
          { value: 'distributed-vlan', label: 'Distributed VLAN connection' },
        ],
        default: 'gateway',
        showWhen: { input: 'external', equals: ['true'] },
      },
      { id: 'connection_name', label: 'Connection name', control: 'text', default: 'provider-gw-01', showWhen: { input: 'external', equals: ['true'] } },
    ],
    automation: (values                 , name        )             => {
      const project = label(str(values, 'nsx_project', 'default'), 'default');
      const tgw = label(str(values, 'tgw', 'default'), 'default');
      const natOn = str(values, 'nat_on', 'transit-gateway');
      const vpc = label(str(values, 'vpc', 'vpc'), 'vpc');
      const ipsec = bool(values, 'ipsec', true);
      const vpnName = label(str(values, 'vpn_name', 'vpn'), 'vpn');
      const peer = str(values, 'peer_address', '');
      const peerId = str(values, 'peer_id', peer);
      const localAddress = str(values, 'local_address', '');
      const localCidrs = listOf(str(values, 'local_cidrs', ''));
      const remoteCidrs = listOf(str(values, 'remote_cidrs', ''));
      const ikeVersion = str(values, 'ike_version', 'IKE_V2');
      const enc = str(values, 'ike_encryption', 'AES_256');
      const dh = str(values, 'dh_group', 'GROUP14');
      const external = bool(values, 'external', false);
      const connType = str(values, 'connection_type', 'gateway');
      const connName = label(str(values, 'connection_name', 'connection'), 'connection');
      void name;

      const findings            = [];
      const base = `/orgs/default/projects/${project}`;
      const tgwPath = `${base}/transit-gateways/${tgw}`;
      const natPath = natOn === 'vpc' ? `${base}/vpcs/${vpc}/nat/USER/nat-rules` : `${tgwPath}/nat/USER/nat-rules`;
      const objects              = [];

      const addr = (text        , what        , line        )                     => {
        if (text.toLowerCase() === 'any' || text === '') return undefined;
        const fam = familyOf(text);
        if (fam === 6) {
          findings.push(error('vcfa91.tgw.nat-ipv6', `${what} ${text} is IPv6: NAT on an NSX transit gateway or VPC is IPv4 (NAT64 is a separate feature).`, { path: line, source: SRC }));
          return undefined;
        }
        if (fam !== 4) {
          findings.push(error('vcfa91.tgw.nat-address', `${what} "${text}" is not an IPv4 address or CIDR.`, { path: line, source: SRC }));
          return undefined;
        }
        return text;
      };
      if (natOn !== 'none') {
        rowsOf(str(values, 'nat_rules', '')).forEach(({ cells, line }, i) => {
          const [action = '', src = 'any', dst = 'any', translated = '', service = 'any'] = cells;
          const act = action.toUpperCase();
          if (!NAT_ACTIONS.includes(act)) {
            findings.push(error('vcfa91.tgw.nat-action', `"${action}" is not a NAT action (${NAT_ACTIONS.join(', ')}).`, { path: line, source: SRC }));
            return;
          }
          const s = addr(src, 'Source', line);
          const d = addr(dst, 'Destination', line);
          const t = addr(translated, 'Translated address', line);
          if (['SNAT', 'DNAT', 'REFLEXIVE'].includes(act) && !t) findings.push(error('vcfa91.tgw.nat-translated', `${act} needs a translated address.`, { path: line, source: SRC }));
          if (act === 'DNAT' && !d) findings.push(error('vcfa91.tgw.dnat-destination', 'DNAT needs the destination (public) address.', { path: line, source: SRC }));
          if (act === 'SNAT' && !s) findings.push(warning('vcfa91.tgw.snat-any', 'SNAT from any source translates everything leaving, including other VPCs on the gateway.', { path: line, source: SRC }));
          const id = `${act.toLowerCase().replace('_', '-')}-${i + 1}`;
          let servicePath                    ;
          const sm = /^(tcp|udp)\/(\S+)$/i.exec(service);
          if (sm) {
            const p = portOf(sm[2] );
            if (!p) findings.push(error('vcfa91.tgw.nat-service', `"${service}" is not proto/port.`, { path: line, source: SRC }));
            else {
              const svcId = `nat-${sm[1] .toLowerCase()}-${p.port}${p.endPort ? `-${p.endPort}` : ''}`;
              servicePath = `${base}/infra/services/${svcId}`;
              if (!objects.some((o) => o.path === servicePath)) {
                objects.push({ label: `service ${sm[1] .toUpperCase()}/${sm[2]}`, path: servicePath, file: `nsx/service-${svcId}.json`, body: { display_name: svcId, service_entries: [{ resource_type: 'L4PortSetServiceEntry', id: svcId, l4_protocol: sm[1] .toUpperCase(), destination_ports: [p.endPort ? `${p.port}-${p.endPort}` : String(p.port)] }] } });
              }
            }
          } else if (service.toLowerCase() !== 'any') findings.push(error('vcfa91.tgw.nat-service', `"${service}" is not "any" or proto/port.`, { path: line, source: SRC }));
          objects.push({
            label: `${act} rule ${id}`,
            path: `${natPath}/${id}`,
            file: `nsx/nat-${id}.json`,
            body: { display_name: id, action: act, enabled: true, logging: false, sequence_number: (i + 1) * 10, ...(s ? { source_network: s } : {}), ...(d ? { destination_network: d } : {}), ...(t ? { translated_network: t } : {}), ...(servicePath ? { service: servicePath } : {}) },
          });
        });
      }

      if (ipsec) {
        if (!isIp(peer)) findings.push(error('vcfa91.tgw.peer', `"${peer}" is not an IP address.`, { source: SRC }));
        if (!isIp(localAddress)) findings.push(error('vcfa91.tgw.local', `"${localAddress}" is not an IP address.`, { source: SRC }));
        if (peer.includes(':') !== localAddress.includes(':')) findings.push(error('vcfa91.tgw.endpoint-family', 'The peer and local endpoints must be the same address family.', { source: SRC }));
        for (const c of [...localCidrs, ...remoteCidrs]) if (parseCidrAny(c) === null || !c.includes('/')) findings.push(error('vcfa91.tgw.vpn-cidr', `"${c}" is not a CIDR.`, { source: SRC }));
        if (localCidrs.length === 0 || remoteCidrs.length === 0) findings.push(error('vcfa91.tgw.vpn-networks', 'A policy-based VPN needs local and remote networks.', { source: SRC }));
        if (ikeVersion === 'IKE_V1') findings.push(warning('vcfa91.tgw.ikev1', 'IKEv1 is kept for old peers only.', { remediation: 'Use IKEv2 unless the peer cannot.', source: SRC }));
        if (enc.startsWith('AES_GCM') && ikeVersion === 'IKE_V1') findings.push(error('vcfa91.tgw.gcm-v1', 'AES-GCM for IKE needs IKEv2.', { source: SRC }));
        if (dh === 'GROUP14') findings.push(info('vcfa91.tgw.dh', 'Group 14 is the widest-supported choice; 19–21 are stronger if the peer supports them.', { source: SRC }));
        const svc = `${tgwPath}/ipsec-vpn-services/${vpnName}-svc`;
        const ikeId = `${vpnName}-ike`;
        objects.push({ label: `IKE profile ${ikeId}`, path: `${base}/infra/ipsec-vpn-ike-profiles/${ikeId}`, file: `nsx/ike-${ikeId}.json`, body: { display_name: ikeId, ike_version: ikeVersion, encryption_algorithms: [enc], ...(enc.startsWith('AES_GCM') ? {} : { digest_algorithms: ['SHA2_256'] }), dh_groups: [dh], sa_life_time: 86400 } });
        objects.push({ label: `IPsec VPN service on ${tgw}`, path: svc, file: `nsx/ipsec-service.json`, body: { display_name: `${vpnName}-svc`, enabled: true } });
        objects.push({ label: `local endpoint ${localAddress}`, path: `${svc}/local-endpoints/${vpnName}-le`, file: `nsx/ipsec-local-endpoint.json`, body: { display_name: `${vpnName}-le`, local_address: localAddress, local_id: localAddress } });
        objects.push({
          label: `IPsec session ${vpnName} to ${peer}`,
          path: `${svc}/sessions/${vpnName}`,
          file: 'nsx/ipsec-session.json',
          needsPsk: true,
          body: {
            resource_type: 'PolicyBasedIPSecVpnSession',
            display_name: vpnName,
            enabled: true,
            peer_address: peer,
            peer_id: peerId || peer,
            authentication_mode: 'PSK',
            ike_profile_path: `${base}/infra/ipsec-vpn-ike-profiles/${ikeId}`,
            tunnel_profile_path: '/infra/ipsec-vpn-tunnel-profiles/nsx-default-l3vpn-tunnel-profile',
            dpd_profile_path: '/infra/ipsec-vpn-dpd-profiles/nsx-default-l3vpn-dpd-profile',
            local_endpoint_path: `${svc}/local-endpoints/${vpnName}-le`,
            rules: [{ id: `${vpnName}-rule`, action: 'PROTECT', enabled: true, sources: localCidrs.map((subnet) => ({ subnet })), destinations: remoteCidrs.map((subnet) => ({ subnet })) }],
          },
        });
      }

      if (external) {
        const connectionPath = connType === 'gateway' ? `/infra/gateway-connections/${connName}` : `/infra/distributed-vlan-connections/${connName}`;
        objects.push({ label: `attachment of ${tgw} to ${connName}`, path: `${tgwPath}/attachments/${connName}`, file: `nsx/attachment-${connName}.json`, body: { display_name: connName, connection_path: connectionPath } });
      }
      if (objects.length === 0) findings.push(error('vcfa91.tgw.nothing', 'Nothing to create: no NAT rule, no VPN and no external connection.', { source: SRC }));

      const writtenFiles                         = {};
      for (const o of objects) writtenFiles[o.file] = json(o.body);
      const script = nsxScript({
        purpose: `Transit gateway ${tgw} of NSX project ${project}: ${objects.length} object(s).`,
        body: [
          `echo "Transit gateway: $(nsx_get ${JSON.stringify(tgwPath)} | jq -r '.display_name // .id')" || { echo "No transit gateway ${tgw} in project ${project} (VERIFY: GET /policy/api/v1${base}/transit-gateways)" >&2; exit 1; }`,
          ...nsxEnsureLines(objects),
        ],
        undo: `DELETE each path in the reverse order (session, local endpoint, service, IKE profile, NAT rules, services, attachment): NAT and the tunnel stop at once.`,
      });

      const pkg = toPackage({
        packageName: packageNameOf('vcfa91', 'tgw', project, tgw),
        description: `Creates NAT, IPsec VPN and external connection objects on transit gateway ${tgw} of NSX project ${project}.`,
        categoryPath: `${AREA}/Transit gateways/${project}/${tgw}`,
        workflow: {
          name: `Transit gateway ${tgw} services`,
          description: `Creates, through the NSX Policy API, ${objects.map((o) => o.label).join('; ')} — each only when nothing is at its path. ${ipsec ? 'The IPsec pre-shared key comes from the ipsecPsk SecureString at run time. ' : ''}With dryRun true it reads and reports only.`,
          inputs: [kit.DRY_RUN_INPUT],
          outputs: kit.KUBE_OUTPUTS,
          script: nsxWorkflow('nsx-objects.json'),
        },
        config: (() => {
          const c = nsxConfig(`transit gateway ${tgw}`, Math.max(1, objects.length), kit);
          return ipsec ? { ...c, attributes: [...c.attributes, { name: 'ipsecPsk', type: 'SecureString'         , description: `The pre-shared key of the IPsec session ${vpnName}. Stored encrypted, never logged.` }] } : c;
        })(),
        resources: [{ name: 'nsx-objects.json', content: json(objects.map((o) => ({ label: o.label, path: o.path, body: o.body, ...(o.needsPsk ? { needsPsk: true } : {}) }))) }],
      });

      return {
        platform: PLATFORM,
        title: `Transit gateway ${tgw}: ${[natOn !== 'none' ? 'NAT' : '', ipsec ? 'IPsec VPN' : '', external ? 'external connection' : ''].filter(Boolean).join(', ') || 'nothing'}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'An organization administrator connecting the organization to another site or exposing a service, or the provider doing it for them.' },
        scope: {
          what: `Transit gateway ${tgw} of NSX project ${project}: ${objects.length} object(s).`,
          decidedBy: ['The NSX project, which is the organization’s; nothing here reaches another organization.', `The NAT rules, evaluated by sequence number on ${natOn === 'vpc' ? `VPC ${vpc}` : `transit gateway ${tgw}`}.`, 'The VPN local and remote networks, which decide what is encrypted and sent to the peer.'],
          ifWrong: 'A DNAT rule to the wrong inside address exposes it; a VPN rule with a remote network that overlaps a local one black-holes that traffic.',
        },
        guardrails: [
          { rule: 'Each object is created only when nothing is at its path (GET first, PATCH only on 404)', because: 'PATCH on NSX would otherwise overwrite a rule someone changed in the portal.' },
          { rule: 'The script stops when a GET answers anything but 200 or 404', because: 'A path that moved on this NSX release is reported, not written blindly.' },
          ...(ipsec ? [{ rule: 'The pre-shared key is never written: it joins the body at run time from a mode-600 file or a SecureString', because: 'A key in a JSON file ends up in a repository.' }] : []),
        ],
        dryRun: ['scripts/apply-tgw.sh --dry-run and the workflow with dryRun true read and print what they would create.'],
        undo: ['DELETE the paths in the reverse order of creation (session, local endpoint, VPN service, IKE profile, NAT rules, services, attachment).'],
        told: ['The NSX audit log.', 'The peer’s VPN logs when the tunnel comes up.', 'The workflow log (AUDIT lines), its summary output and the webhook when set.'],
        requires: ['VCF Automation 9.1 with the organization’s transit gateway, and an NSX account with rights in the project (provider), or the organization portal (Networking → Transit Gateways) for an organization administrator.', ...(ipsec ? ['IPSEC_PSK_FILE (script) or ipsecPsk (workflow) holding the key agreed with the peer.'] : [])],
        files: {
          ...pkg.files,
          ...writtenFiles,
          'scripts/apply-tgw.sh': script,
          'IMPORT.md': importMd({
            subject: `Transit gateway ${tgw} services in NSX project ${project}: an Orchestrator workflow and a script that create them through the NSX Policy API.`,
            orgs: `${PROVIDER}; ${ALL_APPS} (the same objects appear in the organization portal)`,
            steps: [
              ...pkg.importSteps,
              manualStep('Or: the script', [`\`NSX_HOST=… NSX_USER=… NSX_PASSWORD_FILE=…${ipsec ? ' IPSEC_PSK_FILE=…' : ''} ./scripts/apply-tgw.sh\`; \`--dry-run\` only reads.`]),
              manualStep('As an organization administrator instead', ['VCF Automation 9.1 has no documented tenant API for these; in the organization portal: Networking → Transit Gateways → <gateway> → NAT / IPsec VPN / External Connections, with the values in the nsx/*.json files.']),
            ],
            auth: [],
            verify: [
              'VERIFY: the NSX 9 multi-tenancy paths under /orgs/default/projects/<project>/transit-gateways/<tgw> for nat/USER/nat-rules, ipsec-vpn-services (local-endpoints, sessions) and attachments; GET /policy/api/v1/orgs/default/projects/<project>/transit-gateways lists what is there.',
              'NatRule, IPSecVpnIkeProfile, PolicyBasedIPSecVpnSession and L4PortSetServiceEntry bodies follow the NSX Policy API; the default tunnel and DPD profiles are nsx-default-l3vpn-tunnel-profile and nsx-default-l3vpn-dpd-profile.',
              'The NSX project that belongs to an organization: VCF Automation creates it when the organization gets regional networking; match it by name or by its tags.',
            ],
          }),
        },
        notes: [
          'NSX NAT here is IPv4. The VPN carries IPv6 networks where both endpoints and NSX support it (VERIFY on your NSX release).',
          'Credentials: NSX_PASSWORD_FILE and IPSEC_PSK_FILE are mode-600 files; neither value is ever on a command line or in a written file.',
        ],
        findings,
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Live Recovery replication

function liveRecovery(kit           )                      {
  const { PLATFORM, SRC, ALL_APPS, PROVIDER, json } = kit;
  return automationBlueprint({
    id: 'vcfa91_live_recovery',
    platform: PLATFORM,
    label: 'Live Recovery replication for a namespace’s VMs, and a protection group by tag',
    group: 'VCF Automation 9.1 — protection',
    description:
      'Protection for All Apps VMs through VMware Live Recovery: the VMs of a namespace, a vSphere tag or a list, replicated by vSphere Replication to the paired site with an RPO, point-in-time copies, compression and encryption, and optionally a Live Site Recovery protection group holding them, so a recovery plan can run them.',
    inputs: [
      {
        id: 'select_by',
        label: 'Which VMs',
        control: 'select',
        options: [
          { value: 'namespace', label: 'Every VM of a namespace' },
          { value: 'tag', label: 'VMs with a vSphere tag' },
          { value: 'names', label: 'VMs named' },
        ],
        default: 'namespace',
      },
      { id: 'namespace', label: 'Namespace', control: 'text', default: 'team-a-prod-q4m8z', showWhen: { input: 'select_by', equals: ['namespace'] } },
      { id: 'tag', label: 'Tag (Category:Tag)', control: 'text', default: 'Protection:gold', showWhen: { input: 'select_by', equals: ['tag'] } },
      { id: 'vm_names', label: 'VM names', control: 'text', default: 'web01, web02', showWhen: { input: 'select_by', equals: ['names'] } },
      { id: 'vcenter', label: 'Protected vCenter', control: 'text', default: 'vcenter-wld01.example.com' },
      { id: 'target_site', label: 'Recovery site (paired vCenter name)', control: 'text', default: 'vcenter-wld01-dr.example.com' },
      { id: 'target_datastore', label: 'Recovery datastore', control: 'text', default: 'vsan-dr-wld01' },
      {
        id: 'rpo',
        label: 'RPO',
        control: 'select',
        options: [
          { value: '1', label: '1 minute (vSAN to vSAN)' },
          { value: '5', label: '5 minutes' },
          { value: '15', label: '15 minutes' },
          { value: '30', label: '30 minutes' },
          { value: '60', label: '1 hour' },
          { value: '240', label: '4 hours' },
          { value: '1440', label: '24 hours' },
        ],
        default: '15',
      },
      { id: 'mpit_instances', label: 'Point-in-time copies per day', control: 'number', default: 3, min: 0, max: 24, hint: '0: none' },
      { id: 'mpit_days', label: 'Days of point-in-time copies', control: 'number', default: 5, min: 0, max: 24 },
      { id: 'compression', label: 'Compress replication traffic', control: 'toggle', default: true },
      { id: 'encryption', label: 'Encrypt replication traffic', control: 'toggle', default: true },
      { id: 'protection_group', label: 'Also create a protection group', control: 'toggle', default: true },
      { id: 'pg_name', label: 'Protection group', control: 'text', default: 'team-a-prod', showWhen: { input: 'protection_group', equals: ['true'] } },
    ],
    automation: (values                 , name        )             => {
      const by = str(values, 'select_by', 'namespace');
      const ns = str(values, 'namespace', '');
      const tag = str(values, 'tag', '');
      const names = listOf(str(values, 'vm_names', ''));
      const vcenter = str(values, 'vcenter', '');
      const site = str(values, 'target_site', '');
      const ds = str(values, 'target_datastore', '');
      const rpo = Number(str(values, 'rpo', '15'));
      const instances = num(values, 'mpit_instances', 3);
      const days = num(values, 'mpit_days', 5);
      const compression = bool(values, 'compression', true);
      const encryption = bool(values, 'encryption', true);
      const pg = bool(values, 'protection_group', true);
      const pgName = str(values, 'pg_name', 'protection-group');
      void name;

      const findings            = [];
      if (by === 'tag' && !/^[^:]+:[^:]+$/.test(tag)) findings.push(error('vcfa91.lr.tag', `"${tag}" is not Category:Tag.`, { source: SRC }));
      if (by === 'names' && names.length === 0) findings.push(error('vcfa91.lr.no-vms', 'No VM is named.', { source: SRC }));
      if (by === 'namespace' && !ns) findings.push(error('vcfa91.lr.no-namespace', 'No namespace is named.', { source: SRC }));
      if (!site || !ds) findings.push(error('vcfa91.lr.target', 'The recovery site and datastore are both needed.', { source: SRC }));
      if (rpo === 1) findings.push(info('vcfa91.lr.rpo1', 'An RPO of 1 minute needs vSAN (ESA or OSA) at both sites.', { source: SRC }));
      if (instances * days > 24) findings.push(error('vcfa91.lr.mpit', `${instances} copies a day for ${days} days is ${instances * days} point-in-time instances; vSphere Replication keeps at most 24.`, { source: SRC }));
      if (!encryption) findings.push(warning('vcfa91.lr.clear', 'Replication traffic is not encrypted between the sites.', { source: SRC }));
      if (by === 'namespace') findings.push(info('vcfa91.lr.namespace', 'New VMs in the namespace are not protected until this runs again; schedule it.', { source: SRC }));

      const spec = { rpo, mpit_enabled: instances > 0 && days > 0, mpit_instances: instances, mpit_days: days, network_compression_enabled: compression, lwd_encryption_enabled: encryption, auto_replicate_new_disks: true, quiesce_enabled: false };

      const select =
        by === 'namespace'
          ? [
              `NS=${JSON.stringify(ns)}`,
              '# A vSphere namespace is a resource pool of the same name; its VMs are the namespace VMs.',
              "RP=$(vc GET \"/api/vcenter/resource-pool?names=$(jq -rn --arg n \"$NS\" '$n|@uri')\" | jq -r '.[0].resource_pool // empty')",
              '[[ -n "$RP" ]] || { echo "No resource pool for namespace ${NS} in vCenter" >&2; exit 1; }',
              "mapfile -t VMS < <(vc GET \"/api/vcenter/vm?resource_pools=${RP}\" | jq -r '.[].name')",
            ]
          : by === 'tag'
            ? [
                ...vcenterTagLines(),
                `TAG_ID=$(tag_id ${JSON.stringify(tag)})`,
                "IDS=$(vc POST \"/api/cis/tagging/tag-association/${TAG_ID}?action=list-attached-objects\" | jq -r '[.[] | select(.type == \"VirtualMachine\") | .id] | join(\",\")')",
                'mapfile -t VMS < <([[ -n "$IDS" ]] && vc GET "/api/vcenter/vm?vms=${IDS}" | jq -r \'.[].name\')',
              ]
            : [`VMS=(${names.map((n) => JSON.stringify(n)).join(' ')})`];

      const script = [
        '#!/usr/bin/env bash',
        `# Replicate ${by === 'namespace' ? `the VMs of namespace ${ns}` : by === 'tag' ? `the VMs tagged ${tag}` : names.join(', ')} to ${site}${pg ? `, and group them in protection group ${pgName}` : ''}.`,
        '#',
        '# Applies when run. With --dry-run this only reads and prints what it would configure.',
        '# VMs that are already replicated are left as they are.',
        'set -euo pipefail',
        'cd "$(dirname "$0")/.."',
        'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
        'DRY_RUN=0',
        '[[ " $* " == *" --dry-run "* ]] && DRY_RUN=1',
        `VCENTER_HOST="\${VCENTER_HOST:-${vcenter}}"`,
        ...vcenterAuthLines(),
        '',
        ': "${VR_HOST:?set VR_HOST to the vSphere Replication appliance of the protected site}"',
        ': "${VR_USER:?set VR_USER (a vCenter account with the VRM replication privileges)}"',
        ': "${VR_PASSWORD_FILE:?set VR_PASSWORD_FILE to a mode-600 file}"',
        ': "${REMOTE_PASSWORD_FILE:?set REMOTE_PASSWORD_FILE to a mode-600 file holding the recovery-site vCenter password of REMOTE_USER}"',
        ': "${REMOTE_USER:?set REMOTE_USER for the recovery-site vCenter}"',
        'for f in "$VR_PASSWORD_FILE" "$REMOTE_PASSWORD_FILE"; do',
        '  P=$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f"); [[ "$P" == 600 || "$P" == 400 ]] || { echo "$f must be mode 600" >&2; exit 2; }',
        'done',
        "basic_cfg() { jq -rn --arg u \"$1\" --rawfile p \"$2\" '\"user = \\(($u + \":\" + ($p | rtrimstr(\"\\n\"))) | tojson)\"'; }",
        'VR="https://${VR_HOST}/api/rest/vr/v2"',
        '# The x-dr-session id goes to curl from a private header file, never as an argument.',
        'DR_HDR=$(umask 077; mktemp "${TMPDIR:-/tmp}/dr.XXXXXX")',
        "trap 'rm -f \"$VC_HDR\" \"$DR_HDR\"' EXIT",
        "SID=$(curl -sS -f -K <(basic_cfg \"$VR_USER\" \"$VR_PASSWORD_FILE\") -X POST \"${VR}/session\" -H 'Accept: application/json' | jq -r '.session_id // empty')",
        '[[ -n "$SID" ]] || { echo "vSphere Replication login returned no session" >&2; exit 1; }',
        "printf 'x-dr-session: %s\\n' \"$SID\" > \"$DR_HDR\"",
        'vr() { local method="$1" path="$2"; shift 2; curl -sS -f -X "$method" "${VR}${path}" -H "@${DR_HDR}" -H "Accept: application/json" -H "Content-Type: application/json" "$@"; }',
        '',
        `SITE=${JSON.stringify(site)}`,
        "PAIRING=$(vr GET /pairings | jq -c --arg s \"$SITE\" '[.list[]? | select(.remote_vc_server.name == $s)][0] // empty')",
        '[[ -n "$PAIRING" ]] || { echo "No pairing with ${SITE}: pair the sites in VMware Live Recovery first." >&2; exit 1; }',
        "PID=$(jq -r .pairing_id <<<\"$PAIRING\"); LOCAL_VC=$(jq -r .local_vc_server.id <<<\"$PAIRING\"); REMOTE_VC=$(jq -r .remote_vc_server.id <<<\"$PAIRING\")",
        '# The recovery site needs its own login on the same session.',
        'curl -sS -f -K <(basic_cfg "$REMOTE_USER" "$REMOTE_PASSWORD_FILE") -X POST "${VR}/pairings/${PID}/remote-session" -H "@${DR_HDR}" -H "Accept: application/json" >/dev/null',
        `DS=${JSON.stringify(ds)}`,
        "DS_ID=$(vr GET \"/pairings/${PID}/vcenters/${REMOTE_VC}/datastores\" | jq -r --arg d \"$DS\" '[.list[]? | select(.name == $d) | .id][0] // empty')",
        '[[ -n "$DS_ID" ]] || { echo "No datastore ${DS} at ${SITE}" >&2; exit 1; }',
        '',
        ...select,
        '(( ${#VMS[@]} > 0 )) || { echo "No VM matched; nothing to do."; exit 0; }',
        "REPLICATED=$(vr GET \"/pairings/${PID}/replications\" | jq -r '[.list[]?.name] | join(\"\\n\")')",
        'SPECS="[]"',
        'VM_IDS="[]"',
        'for name in "${VMS[@]}"; do',
        '  if grep -qxF "$name" <<<"$REPLICATED"; then echo "Exists, left as it is: replication of ${name}"; continue; fi',
        "  V=$(vr GET \"/pairings/${PID}/vcenters/${LOCAL_VC}/vms?filter_property=name&filter=$(jq -rn --arg n \"$name\" '$n|@uri')\" | jq -c --arg n \"$name\" '[.list[]? | select(.name == $n)][0] // empty')",
        '  [[ -n "$V" ]] || { echo "VM ${name} is not visible to vSphere Replication" >&2; exit 1; }',
        "  VID=$(jq -r .id <<<\"$V\")",
        "  DISKS=$(vr GET \"/pairings/${PID}/vcenters/${LOCAL_VC}/vms/${VID}/disks\" | jq -c --arg ds \"$DS_ID\" '[.list[]? | {disk_data: ., enabled_for_replication: true, use_seeds: false, destination_datastore_id: $ds}]')",
        "  SPECS=$(jq -c --arg vm \"$VID\" --arg vc \"$REMOTE_VC\" --argjson disks \"$DISKS\" --slurpfile base replication-spec.json '. + [$base[0] + {vm_id: $vm, target_vc_id: $vc, disks: $disks}]' <<<\"$SPECS\")",
        "  VM_IDS=$(jq -c --arg vm \"$VID\" '. + [$vm]' <<<\"$VM_IDS\")",
        '  echo "To replicate: ${name}"',
        'done',
        "if [[ \"$(jq length <<<\"$SPECS\")\" -gt 0 ]]; then",
        '  if (( DRY_RUN )); then echo "DRY RUN: would POST ${VR}/pairings/${PID}/replications for $(jq length <<<"$SPECS") VM(s)"; else',
        '    vr POST "/pairings/${PID}/replications" --data-binary "$SPECS" >/dev/null && echo "Replication configured for $(jq length <<<"$SPECS") VM(s)"',
        '  fi',
        'fi',
        ...(pg
          ? [
              '',
              '# The protection group, in Live Site Recovery (VERIFY the /api/rest/srm/v2 paths on your release).',
              ': "${SRM_HOST:?set SRM_HOST to the Live Site Recovery appliance of the protected site}"',
              'SRM="https://${SRM_HOST}/api/rest/srm/v2"',
              "SSID=$(curl -sS -f -K <(basic_cfg \"$VR_USER\" \"$VR_PASSWORD_FILE\") -X POST \"${SRM}/session\" -H 'Accept: application/json' | jq -r '.session_id // empty')",
              "printf 'x-dr-session: %s\\n' \"$SSID\" > \"$DR_HDR\"",
              `PG=${JSON.stringify(pgName)}`,
              "SRM_PID=$(curl -sS -f -H \"@${DR_HDR}\" \"${SRM}/pairings\" -H 'Accept: application/json' | jq -r --arg s \"$SITE\" '[.list[]? | select(.remote_vc_server.name == $s) | .pairing_id][0] // empty')",
              'curl -sS -f -K <(basic_cfg "$REMOTE_USER" "$REMOTE_PASSWORD_FILE") -X POST "${SRM}/pairings/${SRM_PID}/remote-session" -H "@${DR_HDR}" >/dev/null',
              "if curl -sS -f -H \"@${DR_HDR}\" \"${SRM}/pairings/${SRM_PID}/protected-site/protection-groups\" -H 'Accept: application/json' | jq -e --arg n \"$PG\" '[.list[]? | select(.name == $n)] | length > 0' >/dev/null; then",
              '  echo "Exists, left as it is: protection group ${PG} (add new VMs to it in Live Site Recovery)"',
              'elif (( DRY_RUN )); then echo "DRY RUN: would create protection group ${PG}"',
              'else',
              "  jq -n --arg n \"$PG\" --arg vc \"$LOCAL_VC\" --argjson vms \"$VM_IDS\" '{name: $n, description: \"Replicated VMs\", replication_type: \"HBR\", protected_vc_guid: $vc, hbr_spec: {vms: $vms}}' \\",
              '    | curl -sS -f -X POST "${SRM}/pairings/${SRM_PID}/protected-site/protection-groups" -H "@${DR_HDR}" -H "Accept: application/json" -H "Content-Type: application/json" --data-binary @- >/dev/null',
              '  echo "Created protection group ${PG}"',
              'fi',
            ]
          : []),
        '',
        'if (( DRY_RUN )); then echo "Dry run: nothing was changed. Run it without --dry-run to apply."; fi',
        '',
        '# Undo: stop replication per VM in VMware Live Recovery (DELETE /pairings/<id>/replications/<id>); the replica at the recovery site is removed with it.',
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `Live Recovery replication to ${site}${pg ? ` in protection group ${pgName}` : ''}`,
        effect: 'reversible',
        trigger: { kind: by === 'namespace' ? 'schedule' : 'manual', detail: by === 'namespace' ? `Run after VMs are added to ${ns}, or nightly, so new VMs are protected.` : 'When a VM is tagged or listed for protection.' },
        scope: {
          what: `${by === 'namespace' ? `VMs of namespace ${ns}` : by === 'tag' ? `VMs tagged ${tag}` : names.join(', ')}: RPO ${rpo} minute(s) to ${ds} at ${site}.`,
          decidedBy: [by === 'namespace' ? `The resource pool of namespace ${ns} in vCenter, at the time of the run.` : by === 'tag' ? `Who carries the tag ${tag} at the time of the run.` : 'The names listed.', 'The site pairing to the recovery vCenter.', 'The recovery datastore’s free space.'],
          ifWrong: 'Replicating the wrong VMs uses recovery-site storage and replication bandwidth other protected VMs need to meet their RPO.',
        },
        guardrails: [
          { rule: 'VMs already replicated are left as they are', because: 'Reconfiguring a replication restarts its full sync.' },
          { rule: 'The run stops when the pairing, the datastore or a VM is not found', because: 'A partial configuration looks protected in the list and is not.' },
          { rule: 'Passwords come from mode-600 files and session ids from private header files', because: 'Neither shows in ps or shell history.' },
        ],
        dryRun: ['scripts/protect.sh --dry-run reads everything and prints what it would configure.'],
        undo: ['Stop the replication of each VM (and remove it from the protection group) in VMware Live Recovery. The replica is deleted.'],
        told: ['VMware Live Recovery shows each replication, its RPO compliance and alarms; vCenter raises RPO-violation alarms.', 'The script output (log it from cron).'],
        requires: ['VMware Live Recovery (vSphere Replication, and Live Site Recovery for the protection group) at both sites, paired.', 'Accounts at both vCenters with the replication privileges.', 'VCF Automation 9.1 organizations see the protection of their VMs when the provider enables Live Recovery for them.'],
        files: {
          'replication-spec.json': json(spec),
          'scripts/protect.sh': script,
          'IMPORT.md': importMd({
            subject: `Live Recovery replication of ${by === 'namespace' ? `namespace ${ns}` : by === 'tag' ? `VMs tagged ${tag}` : 'the VMs named'} to ${site}: a script against the vSphere Replication${pg ? ' and Live Site Recovery' : ''} REST API${pg ? 's' : ''}.`,
            orgs: `${PROVIDER}; ${ALL_APPS} (their VMs)`,
            steps: [
              manualStep('Run it', [`\`VCENTER_USER=… VCENTER_PASSWORD_FILE=… VR_HOST=… VR_USER=… VR_PASSWORD_FILE=… REMOTE_USER=… REMOTE_PASSWORD_FILE=…${pg ? ' SRM_HOST=…' : ''} ./scripts/protect.sh\`; \`--dry-run\` only reads. Schedule it${by === 'namespace' ? ' nightly' : ''} to pick up new VMs.`]),
              manualStep('Self-service in VCF Automation', ['VERIFY: where the 9.1 organization portal offers Protect on a VM, the organization administrator can do the same per VM; there is no documented VCF Automation API for it, so this script works at the Live Recovery layer.']),
            ],
            auth: [],
            verify: [
              'VERIFY: the vSphere Replication REST API v2 paths and fields (/session, /pairings, /pairings/<id>/remote-session, /vcenters/<id>/vms and /disks and /datastores, POST /pairings/<id>/replications with rpo, mpit_*, network_compression_enabled, lwd_encryption_enabled, disks[].destination_datastore_id).',
              ...(pg ? ['VERIFY: the Live Site Recovery REST API v2 protection group (POST /pairings/<id>/protected-site/protection-groups with replication_type HBR and hbr_spec.vms).'] : []),
            ],
          }),
        },
        notes: ['A namespace’s VMs are the VMs of its resource pool; VKS nodes are replaced rather than recovered, so protect the workloads (Velero) rather than the node VMs.', 'Point-in-time copies: at most 24 instances in total.'],
        findings,
      };
    },
  });
}

// ---------------------------------------------------------------------------
// VKS-supported Velero

function velero(kit           )                      {
  const { PLATFORM, SRC, ALL_APPS, q, k8sYaml } = kit;
  return automationBlueprint({
    id: 'vcfa91_vks_velero',
    platform: PLATFORM,
    label: 'VKS-supported Velero: install, S3 target, scheduled backups with retention',
    group: 'VCF Automation 9.1 — protection',
    description:
      'Backup for a VKS cluster the supported way in 9.1 (bring-your-own Velero is deprecated): the Velero VKS standard package with its data values, credentials for an S3-compatible target kept in a Secret made from files, a Schedule with retention and the namespaces it covers, and a first backup straight away.',
    inputs: [
      { id: 'cluster', label: 'VKS cluster', control: 'text', default: 'team-a-prod-01' },
      { id: 'package_version', label: 'Velero package version', control: 'text', default: '1.16.2+vmware.1-vks.1', hint: 'vcf package available list velero.kubernetes.vmware.com' },
      { id: 's3_url', label: 'S3 endpoint', control: 'text', default: 'https://s3.example.com:9000' },
      { id: 'bucket', label: 'Bucket', control: 'text', default: 'vks-backups' },
      { id: 'prefix', label: 'Prefix', control: 'text', default: 'team-a-prod-01' },
      { id: 'region', label: 'Region', control: 'text', default: 'us-east-1' },
      { id: 'schedule', label: 'Schedule (cron)', control: 'text', default: '0 1 * * *' },
      { id: 'retention_days', label: 'Keep for (days)', control: 'number', default: 30, min: 1, max: 3650 },
      { id: 'include', label: 'Namespaces', control: 'text', default: '*', hint: 'Comma separated; * for all' },
      { id: 'exclude', label: 'Except', control: 'text', default: 'kube-system, velero, vmware-system-*', hint: 'Comma separated' },
      {
        id: 'volumes',
        label: 'Volume data',
        control: 'select',
        options: [
          { value: 'fs-backup', label: 'File-system backup (node agent, Kopia) to S3' },
          { value: 'csi', label: 'CSI snapshots, data moved to S3' },
          { value: 'none', label: 'Resources only, no volume data' },
        ],
        default: 'fs-backup',
      },
      { id: 'backup_now', label: 'Take a first backup now', control: 'toggle', default: true },
    ],
    automation: (values                 , name        )             => {
      const cluster = str(values, 'cluster', 'cluster');
      const version = str(values, 'package_version', '');
      const s3 = str(values, 's3_url', '');
      const bucket = str(values, 'bucket', '');
      const prefix = str(values, 'prefix', '');
      const region = str(values, 'region', 'us-east-1');
      const cron = str(values, 'schedule', '0 1 * * *');
      const days = num(values, 'retention_days', 30);
      const include = listOf(str(values, 'include', '*'));
      const exclude = listOf(str(values, 'exclude', ''));
      const volumes = str(values, 'volumes', 'fs-backup');
      const now = bool(values, 'backup_now', true);
      void name;

      const findings            = [];
      if (!/^https?:\/\/[^\s/]+/.test(s3)) findings.push(error('vcfa91.velero.url', `"${s3}" is not an http(s) URL.`, { source: SRC }));
      if (/^http:\/\//.test(s3)) findings.push(warning('vcfa91.velero.http', 'The S3 endpoint is plain HTTP: backups, including Secrets, cross the network unencrypted.', { source: SRC }));
      if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) findings.push(error('vcfa91.velero.bucket', `"${bucket}" is not an S3 bucket name.`, { source: SRC }));
      if (cron.split(/\s+/).length !== 5) findings.push(error('vcfa91.velero.cron', `"${cron}" is not a five-field cron expression.`, { source: SRC }));
      if (volumes === 'none') findings.push(warning('vcfa91.velero.no-data', 'Only Kubernetes objects are backed up; persistent volume data is not.', { source: SRC }));
      if (days < 7) findings.push(info('vcfa91.velero.short', `Backups kept ${days} day(s): a problem found after that has nothing to restore from.`, { source: SRC }));
      if (!/^\d+\.\d+\.\d+\+vmware\.\d+/.test(version)) findings.push(warning('vcfa91.velero.version', `"${version}" does not look like a VKS package version.`, { remediation: 'vcf package available list velero.kubernetes.vmware.com -n <package namespace>', source: SRC }));

      const values_ = {
        namespace: 'velero',
        credential: { useDefaultSecret: false, existingSecret: 'velero-s3' },
        backupStorageLocation: { bucket, prefix, provider: 'aws', config: { region, s3ForcePathStyle: 'true', s3Url: s3 } },
        volumeSnapshotLocation: { snapshotsEnabled: volumes === 'csi', provider: 'aws', config: { region } },
        deployNodeAgent: volumes === 'fs-backup',
        features: volumes === 'csi' ? 'EnableCSI' : '',
      };
      const template = {
        includedNamespaces: include,
        excludedNamespaces: exclude,
        ttl: `${days * 24}h0m0s`,
        storageLocation: 'default',
        snapshotVolumes: volumes === 'csi',
        ...(volumes === 'fs-backup' ? { defaultVolumesToFsBackup: true } : {}),
        ...(volumes === 'csi' ? { snapshotMoveData: true } : {}),
      };
      const scheduleObj = { apiVersion: 'velero.io/v1', kind: 'Schedule', metadata: { name: `${cluster}-daily`.slice(0, 63), namespace: 'velero' }, spec: { schedule: cron, useOwnerReferencesInBackup: false, template } };
      const yaml = k8sYaml([{ comment: ['Velero Schedule: velero.io/v1, as the VKS Velero package serves it.'], object: scheduleObj }]);
      const valuesYaml = k8sYaml([{ comment: ['Data values for the Velero VKS package. VERIFY the schema: vcf package available get velero.kubernetes.vmware.com/<version> --values-schema'], object: values_ }]).replace(/^---\n/, '');

      const script = [
        '#!/usr/bin/env bash',
        `# Install the VKS-supported Velero on ${cluster}, point it at s3://${bucket}/${prefix}, and schedule backups.`,
        '#',
        '# Applies when run. With --dry-run: server-side dry runs, no package install.',
        `# Run it in the context of the VKS cluster (vcf cluster kubeconfig get ${cluster}; kubectl config use-context …).`,
        'set -euo pipefail',
        'cd "$(dirname "$0")/.."',
        'command -v kubectl >/dev/null || { echo "kubectl is required" >&2; exit 2; }',
        'command -v vcf >/dev/null || { echo "the VCF CLI (vcf package) is required" >&2; exit 2; }',
        ': "${EXPECT_CONTEXT:?set EXPECT_CONTEXT to the kubectl context of the VKS cluster}"',
        '[[ "$(kubectl config current-context)" == "$EXPECT_CONTEXT" ]] || { echo "Current context is not $EXPECT_CONTEXT" >&2; exit 2; }',
        ': "${S3_ACCESS_KEY_FILE:?set S3_ACCESS_KEY_FILE to a mode-600 file holding the access key id}"',
        ': "${S3_SECRET_KEY_FILE:?set S3_SECRET_KEY_FILE to a mode-600 file holding the secret access key}"',
        'for f in "$S3_ACCESS_KEY_FILE" "$S3_SECRET_KEY_FILE"; do',
        '  P=$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f"); [[ "$P" == 600 || "$P" == 400 ]] || { echo "$f must be mode 600" >&2; exit 2; }',
        'done',
        'MODE=()',
        'DRY_RUN=0',
        '[[ " $* " == *" --dry-run "* ]] && { MODE=(--dry-run=server); DRY_RUN=1; }',
        `PKG="\${VELERO_PACKAGE:-velero.kubernetes.vmware.com}"`,
        `VERSION=${q(version)}`,
        'PKG_NS="${PACKAGE_NAMESPACE:-vcf-packages}"',
        '',
        'kubectl get ns velero >/dev/null 2>&1 || kubectl create namespace velero "${MODE[@]}"',
        '# The S3 credentials, as the AWS plugin reads them: built from the files, never on a command line.',
        'if kubectl get secret velero-s3 -n velero >/dev/null 2>&1; then echo "Exists, left as it is: Secret velero-s3"; else',
        "  kubectl create secret generic velero-s3 -n velero \"${MODE[@]}\" --from-file=cloud=<(printf '[default]\\naws_access_key_id=%s\\naws_secret_access_key=%s\\n' \"$(tr -d '\\n' < \"$S3_ACCESS_KEY_FILE\")\" \"$(tr -d '\\n' < \"$S3_SECRET_KEY_FILE\")\")",
        'fi',
        'if vcf package installed get velero -n "$PKG_NS" >/dev/null 2>&1; then echo "Exists, left as it is: package velero"',
        'elif (( DRY_RUN )); then echo "DRY RUN: would install ${PKG} ${VERSION} with velero-values.yaml"',
        'else vcf package install velero -p "$PKG" -v "$VERSION" --values-file velero-values.yaml -n "$PKG_NS" --create-namespace',
        'fi',
        'if (( ! DRY_RUN )); then',
        '  echo "Waiting for the backup storage location to be Available…"',
        '  for _ in $(seq 1 30); do',
        "    [[ \"$(kubectl get backupstoragelocation default -n velero -o jsonpath='{.status.phase}' 2>/dev/null)\" == Available ]] && break; sleep 10",
        '  done',
        "  [[ \"$(kubectl get backupstoragelocation default -n velero -o jsonpath='{.status.phase}')\" == Available ]] || { echo \"The backup storage location is not Available: kubectl describe bsl default -n velero\" >&2; exit 1; }",
        'fi',
        `kubectl get schedule ${q(scheduleObj.metadata.name)} -n velero >/dev/null 2>&1 && echo "Exists, left as it is: Schedule ${scheduleObj.metadata.name}" || kubectl create "\${MODE[@]}" -f velero-schedule.k8s.yaml`,
        ...(now
          ? [
              '# A first backup from the schedule’s template, so there is one to test a restore with today.',
              `jq -n --argjson t ${q(JSON.stringify(template))} '{apiVersion: "velero.io/v1", kind: "Backup", metadata: {generateName: "${cluster}-first-", namespace: "velero"}, spec: $t}' | kubectl create "\${MODE[@]}" -f -`,
            ]
          : []),
        'if (( DRY_RUN )); then echo "Dry run: nothing was changed. Run it without --dry-run to apply."; fi',
        '',
        '# Undo: kubectl delete schedule -n velero <name>; vcf package installed delete velero -n "$PKG_NS". Backups already in the bucket stay until their TTL.',
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `Velero on ${cluster}: ${cron}, kept ${days} day(s)`,
        effect: 'reversible',
        trigger: { kind: 'schedule', detail: `Velero runs the Schedule at ${cron} (cluster time zone, UTC by default).`, worstCase: 'once per cron tick; a backup still running when the next is due is followed by the next' },
        scope: {
          what: `Namespaces ${include.join(', ')}${exclude.length ? ` except ${exclude.join(', ')}` : ''} of ${cluster}, ${volumes === 'none' ? 'objects only' : 'with volume data'}, to s3://${bucket}/${prefix}.`,
          decidedBy: ['includedNamespaces and excludedNamespaces in the Schedule, evaluated at each run — new namespaces are included when * is.', 'The S3 credentials’ rights on the bucket.', volumes === 'fs-backup' ? 'The node agent on each worker, which reads the volumes.' : volumes === 'csi' ? 'The CSI driver’s snapshots, then the data mover.' : 'Nothing reads volume data.'],
          ifWrong: 'A backup that misses a namespace is discovered at restore time; one that includes too much fills the bucket and slows every run.',
        },
        guardrails: [
          { rule: 'Stops unless the current context is EXPECT_CONTEXT', because: 'Velero installed on the wrong cluster backs up the wrong cluster to the right bucket.' },
          { rule: 'The S3 keys come from mode-600 files into a Secret, never onto a command line or into the values file', because: 'The values file ends up in a repository.' },
          { rule: 'Nothing that exists is replaced: the package, the Secret and the Schedule are each created only when missing', because: 'A rerun does not repoint a working backup at a new target.' },
          { rule: 'The run waits for the backup storage location to be Available', because: 'A Schedule against an unreachable bucket fails every night quietly.' },
        ],
        dryRun: ['scripts/install-velero.sh --dry-run: server-side dry runs and no package install.'],
        undo: ['kubectl delete schedule -n velero <name>; vcf package installed delete velero. Backups in the bucket stay until their TTL expires; delete them with velero backup delete.'],
        told: ['kubectl get backups -n velero, and Velero’s metrics (velero_backup_failure_total) for alerting.', 'The bucket’s own access log.'],
        requires: [`The VKS standard package repository on ${cluster}.`, `An S3-compatible bucket ${bucket} and keys with write access to ${prefix}.`, 'kubectl and the VCF CLI in the cluster’s context.'],
        files: {
          'velero-values.yaml': valuesYaml,
          'velero-schedule.k8s.yaml': yaml,
          'scripts/install-velero.sh': script,
          'IMPORT.md': importMd({
            subject: `Velero on the VKS cluster ${cluster}: the VKS package, its S3 target and a Schedule, installed by one script in the cluster’s context.`,
            orgs: ALL_APPS,
            steps: [
              manualStep('Log in to the cluster', [`\`vcf cluster kubeconfig get ${cluster}\` (from the namespace context), then \`kubectl config use-context <cluster context>\`.`]),
              manualStep('Run it', ['`EXPECT_CONTEXT=<cluster context> S3_ACCESS_KEY_FILE=… S3_SECRET_KEY_FILE=… ./scripts/install-velero.sh`; `--dry-run` first.']),
              manualStep('Test a restore', ['`velero restore create --from-backup <first backup> --namespace-mappings <ns>:<ns>-restore-test` into a scratch namespace, and check the application there.']),
            ],
            auth: ['kube'],
            verify: [
              'VERIFY: the package name velero.kubernetes.vmware.com (VELERO_PACKAGE overrides it) and the data-values schema (credential.existingSecret, backupStorageLocation, deployNodeAgent) with vcf package available get … --values-schema.',
              'Schedule and Backup (velero.io/v1: schedule, template.includedNamespaces, ttl, defaultVolumesToFsBackup, snapshotMoveData) are Velero’s own API.',
            ],
          }),
        },
        notes: ['9.1 deprecates bring-your-own Velero on VKS in favour of the VKS-supported Velero package; supervisor namespaces themselves use the Velero plugin for vSphere Supervisor service.', 'Retention is the Backup TTL: Velero deletes the backup and its data at expiry.'],
        findings,
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Namespace objects: volume, Secret, VirtualMachineService

function namespaceObjects(kit           )                      {
  const { PLATFORM, SRC, ALL_APPS, AREA, json, label, q, kubeScript, k8sYaml, kubeWorkflow, kubeConfig } = kit;
  return automationBlueprint({
    id: 'vcfa91_namespace_object',
    platform: PLATFORM,
    label: 'A namespace object on its own: volume (PVC), Secret, or VM service',
    group: 'VCF Automation 9.1 — consumption',
    description:
      'The small objects of an All Apps namespace, each on its own: a PersistentVolumeClaim with storage class, size, access and volume mode; a Secret (Opaque, TLS or registry) whose values are read from files or environment variables at run time and never written; or a VirtualMachineService (ClusterIP or LoadBalancer) over VMs by label.',
    inputs: [
      {
        id: 'kind',
        label: 'Object',
        control: 'select',
        options: [
          { value: 'pvc', label: 'Volume (PersistentVolumeClaim)' },
          { value: 'secret', label: 'Secret' },
          { value: 'vmservice', label: 'VM service (VirtualMachineService)' },
        ],
        default: 'pvc',
      },
      { id: 'namespace', label: 'Namespace', control: 'text', default: 'team-a-dev-x7k2p' },
      { id: 'obj_name', label: 'Name', control: 'text', default: 'data-01' },
      { id: 'storage_class', label: 'Storage class', control: 'text', default: 'vsan-default-storage-policy', showWhen: { input: 'kind', equals: ['pvc'] } },
      { id: 'size_gib', label: 'Size (GiB)', control: 'number', default: 50, min: 1, max: 62000, showWhen: { input: 'kind', equals: ['pvc'] } },
      {
        id: 'access_mode',
        label: 'Access',
        control: 'select',
        options: [
          { value: 'ReadWriteOnce', label: 'ReadWriteOnce — one node' },
          { value: 'ReadWriteOncePod', label: 'ReadWriteOncePod — one pod' },
          { value: 'ReadWriteMany', label: 'ReadWriteMany — file volume (vSAN File Services)' },
          { value: 'ReadOnlyMany', label: 'ReadOnlyMany' },
        ],
        default: 'ReadWriteOnce',
        showWhen: { input: 'kind', equals: ['pvc'] },
      },
      {
        id: 'volume_mode',
        label: 'Volume mode',
        control: 'select',
        options: [
          { value: 'Filesystem', label: 'Filesystem' },
          { value: 'Block', label: 'Block (raw device)' },
        ],
        default: 'Filesystem',
        showWhen: { input: 'kind', equals: ['pvc'] },
      },
      {
        id: 'secret_type',
        label: 'Secret type',
        control: 'select',
        options: [
          { value: 'Opaque', label: 'Opaque — keys and values' },
          { value: 'kubernetes.io/tls', label: 'TLS certificate and key' },
          { value: 'kubernetes.io/dockerconfigjson', label: 'Registry credentials (.dockerconfigjson)' },
        ],
        default: 'Opaque',
        showWhen: { input: 'kind', equals: ['secret'] },
      },
      { id: 'secret_keys', label: 'Keys (Opaque)', control: 'text', default: 'username, password', hint: 'Comma separated; each value is read from the file in env SECRET_<KEY>_FILE', showWhen: { input: 'kind', equals: ['secret'] } },
      {
        id: 'svc_type',
        label: 'Service type',
        control: 'select',
        options: [
          { value: 'ClusterIP', label: 'ClusterIP — inside the namespace' },
          { value: 'LoadBalancer', label: 'LoadBalancer — a VIP (Avi or NSX)' },
        ],
        default: 'ClusterIP',
        showWhen: { input: 'kind', equals: ['vmservice'] },
      },
      { id: 'svc_selector', label: 'VMs labelled', control: 'text', default: 'app=db01', showWhen: { input: 'kind', equals: ['vmservice'] } },
      { id: 'svc_ports', label: 'Ports', control: 'textarea', default: 'postgres | TCP | 5432 | 5432', hint: 'name | protocol | port | target port', showWhen: { input: 'kind', equals: ['vmservice'] } },
      {
        id: 'vm_api',
        label: 'VM Operator API',
        control: 'select',
        options: [
          { value: 'v1alpha5', label: 'v1alpha5' },
          { value: 'v1alpha4', label: 'v1alpha4' },
          { value: 'v1alpha3', label: 'v1alpha3' },
        ],
        default: 'v1alpha5',
        showWhen: { input: 'kind', equals: ['vmservice'] },
      },
    ],
    automation: (values                 , name        )             => {
      const kind = str(values, 'kind', 'pvc');
      const ns = str(values, 'namespace', 'team-a');
      const objName = label(str(values, 'obj_name', 'object'), 'object');
      const findings            = [];
      void name;

      let object                  ;
      let served           = [];
      let scriptPre           = [];
      let what = '';
      let secretKeys           = [];
      const secretType = str(values, 'secret_type', 'Opaque');
      if (kind === 'secret') {
        secretKeys = secretType === 'kubernetes.io/tls' ? ['tls.crt', 'tls.key'] : secretType === 'kubernetes.io/dockerconfigjson' ? ['.dockerconfigjson'] : listOf(str(values, 'secret_keys', ''));
        if (secretKeys.length === 0) findings.push(error('vcfa91.nsobj.no-keys', 'An Opaque Secret needs at least one key.', { source: SRC }));
        for (const k of secretKeys) if (!/^[-._a-zA-Z0-9]+$/.test(k)) findings.push(error('vcfa91.nsobj.key', `"${k}" is not a valid Secret key.`, { source: SRC }));
        object = { plural: 'secrets', object: { apiVersion: 'v1', kind: 'Secret', metadata: { name: objName, namespace: ns, labels: { 'vcf.automation/managed': 'true' } }, type: secretType } };
        what = `Secret ${objName} (${secretType}, keys ${secretKeys.join(', ')})`;
      } else if (kind === 'vmservice') {
        const api = str(values, 'vm_api', 'v1alpha5');
        const selector = labelsOf(str(values, 'svc_selector', ''));
        const type = str(values, 'svc_type', 'ClusterIP');
        if (Object.keys(selector).length === 0) findings.push(error('vcfa91.nsobj.no-selector', 'A VM service with no selector sends traffic to no VM.', { source: SRC }));
        const ports = rowsOf(str(values, 'svc_ports', '')).flatMap(({ cells, line }) => {
          const [pn = '', proto = 'TCP', port = '', target = ''] = cells;
          const p = portOf(port);
          const t = portOf(target || port);
          if (!p || !t || p.endPort || t.endPort || !['TCP', 'UDP'].includes(proto.toUpperCase())) {
            findings.push(error('vcfa91.nsobj.port', `Could not read "${line}".`, { remediation: 'name | TCP or UDP | port | target port', source: SRC }));
            return [];
          }
          return [{ name: label(pn || `p${p.port}`, `p${p.port}`), protocol: proto.toUpperCase(), port: p.port, targetPort: t.port }];
        });
        if (ports.length === 0) findings.push(error('vcfa91.nsobj.no-ports', 'No port is listed.', { source: SRC }));
        if (type === 'LoadBalancer') findings.push(info('vcfa91.nsobj.lb', 'A LoadBalancer takes an address from the namespace’s IP block and counts against its load balancer quota; "An Avi load balancer for a namespace" checks the quota and adds health monitors.', { source: SRC }));
        object = { plural: 'virtualmachineservices', object: { apiVersion: `vmoperator.vmware.com/${api}`, kind: 'VirtualMachineService', metadata: { name: objName, namespace: ns, labels: { 'vcf.automation/managed': 'true' } }, spec: { type, selector, ports } } };
        served = [`vmoperator.vmware.com/${api}`];
        scriptPre = [`kubectl get vm -n ${q(ns)} -l ${q(Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(','))} || true`];
        what = `VirtualMachineService ${objName} (${type}) over VMs ${Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(',')}`;
      } else {
        const sc = str(values, 'storage_class', '');
        const size = num(values, 'size_gib', 50);
        const access = str(values, 'access_mode', 'ReadWriteOnce');
        const mode = str(values, 'volume_mode', 'Filesystem');
        if (!kit.LABEL.test(sc)) findings.push(error('vcfa91.nsobj.storage-class', `"${sc}" is not a storage class name.`, { remediation: 'kubectl get storageclass in the namespace context lists the ones it may use.', source: SRC }));
        if (access === 'ReadWriteMany') findings.push(info('vcfa91.nsobj.rwx', 'ReadWriteMany needs vSAN File Services enabled for the Supervisor; VM Service VMs cannot mount a file volume as a disk.', { source: SRC }));
        if (access === 'ReadWriteMany' && mode === 'Block') findings.push(error('vcfa91.nsobj.rwx-block', 'A file volume (ReadWriteMany) cannot be a raw block device.', { source: SRC }));
        object = { plural: 'persistentvolumeclaims', object: { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: objName, namespace: ns, labels: { 'vcf.automation/managed': 'true' } }, spec: { accessModes: [access], volumeMode: mode, storageClassName: sc, resources: { requests: { storage: `${size}Gi` } } } } };
        what = `PersistentVolumeClaim ${objName}: ${size} GiB of ${sc}, ${access}, ${mode}`;
      }
      if (!kit.LABEL.test(objName)) findings.push(error('vcfa91.nsobj.name', `"${objName}" is not a Kubernetes name.`, { source: SRC }));

      const isSecret = kind === 'secret';
      const envOf = (k        ) => `SECRET_${k.replace(/[^A-Za-z0-9]/g, '_').replace(/^_+/, '').toUpperCase()}_FILE`;
      const secretScript = [
        '#!/usr/bin/env bash',
        `# Create the ${secretType} Secret ${objName} in ${ns}, with each value read from a mode-600 file.`,
        '#',
        '# Applies when run. With --dry-run this is a server-side dry run.',
        'set -euo pipefail',
        'command -v kubectl >/dev/null || { echo "kubectl is required" >&2; exit 2; }',
        ': "${EXPECT_CONTEXT:?set EXPECT_CONTEXT to the kubectl context this is meant for}"',
        '[[ "$(kubectl config current-context)" == "$EXPECT_CONTEXT" ]] || { echo "Current context is not $EXPECT_CONTEXT" >&2; exit 2; }',
        'MODE=()',
        '[[ " $* " == *" --dry-run "* ]] && MODE=(--dry-run=server)',
        `NS=${q(ns)}`,
        `if kubectl get secret ${q(objName)} -n "$NS" >/dev/null 2>&1; then echo "Exists, left as it is: Secret ${objName}"; exit 0; fi`,
        ...secretKeys.flatMap((k) => [
          `: "\${${envOf(k)}:?set ${envOf(k)} to a mode-600 file holding ${k}}"`,
          `P=$(stat -c %a "$${envOf(k)}" 2>/dev/null || stat -f %Lp "$${envOf(k)}"); [[ "$P" == 600 || "$P" == 400 ]] || { echo "$${envOf(k)} must be mode 600" >&2; exit 2; }`,
        ]),
        '# --from-file reads each value from its file: nothing secret is on the command line.',
        `kubectl create secret generic ${q(objName)} -n "$NS" --type=${q(secretType)} "\${MODE[@]}" ${secretKeys.map((k) => `--from-file=${q(k)}="$${envOf(k)}"`).join(' ')}`,
        `kubectl label secret ${q(objName)} -n "$NS" vcf.automation/managed=true "\${MODE[@]}" >/dev/null 2>&1 || true`,
        'if [[ ${#MODE[@]} -gt 0 ]]; then echo "Server-side dry run only. Nothing was created."; fi',
        '',
        `# Undo: kubectl delete secret ${objName} -n ${ns}`,
        '',
      ].join('\n');

      const secretPre = String.raw`var KEYS = ${JSON.stringify(secretKeys)};
var vals = null;
try { vals = JSON.parse(String(settings.secretValues || "")); } catch (e) { vals = null; }
if (!vals || typeof vals !== "object") throw new Error("Set secretValues in " + SETTINGS_NAME + " to a JSON object with the keys " + KEYS.join(", ") + "; nothing was created.");
var sd = {};
for (var k = 0; k < KEYS.length; k++) {
  if (vals[KEYS[k]] === undefined || vals[KEYS[k]] === null || String(vals[KEYS[k]]) === "") throw new Error("secretValues has no value for " + KEYS[k] + "; nothing was created.");
  sd[KEYS[k]] = String(vals[KEYS[k]]);
}
items[0].object.stringData = sd;`;

      const pkg = toPackage({
        packageName: packageNameOf('vcfa91', 'nsobject', ns, objName),
        description: `Creates the ${what} in the All Apps namespace ${ns}.`,
        categoryPath: `${AREA}/Namespace objects/${ns}/${objName}`,
        workflow: {
          name: `Create ${object.object.kind} ${objName}`,
          description: `Creates the ${what} in namespace ${ns} through its Kubernetes API unless it exists, never changing one that does.${isSecret ? ' The values come from the secretValues SecureString at run time and are never logged or written.' : ''} With dryRun true it is validated on the server (dryRun=All) and nothing is created.`,
          inputs: [kit.DRY_RUN_INPUT],
          outputs: kit.KUBE_OUTPUTS,
          script: kubeWorkflow({ resource: 'object.json', served, pre: isSecret ? secretPre : undefined }),
        },
        config: kubeConfig(`Create ${object.object.kind} ${objName}`, '', 1, isSecret ? [{ name: 'secretValues', type: 'SecureString', description: `JSON object of the values: {${secretKeys.map((k) => `"${k}": "…"`).join(', ')}}. Stored encrypted, never logged.` }] : []),
        resources: [{ name: 'object.json', content: json([object]) }],
      });

      return {
        platform: PLATFORM,
        title: `${object.object.kind} ${objName} in ${ns}`,
        effect: 'reversible',
        trigger: { kind: 'request', detail: 'A project member or pipeline preparing a namespace for a workload.' },
        scope: {
          what: `${what}, in namespace ${ns}.`,
          decidedBy: ['The kubectl context (organization, project, namespace), which the script checks.', kind === 'pvc' ? 'The storage classes and storage quota of the namespace.' : kind === 'vmservice' ? 'The label selector: every VM that has, or later gets, the labels.' : 'Who can read Secrets in the namespace.'],
          ifWrong: kind === 'secret' ? 'A Secret in the wrong namespace is readable by that team.' : kind === 'pvc' ? 'A large volume in the wrong namespace takes that team’s storage quota.' : 'A selector that matches too much sends traffic to the wrong VMs.',
        },
        guardrails: [
          { rule: 'Stops unless the current context is EXPECT_CONTEXT', because: 'The context is the scope.' },
          { rule: 'kubectl create, never apply; left as it is when it exists', because: kind === 'pvc' ? 'A volume is never resized or replaced by a rerun.' : 'An existing object is never overwritten.' },
          ...(isSecret ? [{ rule: 'Values are read from mode-600 files (script) or a SecureString (workflow); none is written to a file', because: 'A Secret manifest with values in it ends up in a repository.' }] : []),
        ],
        dryRun: ['The workflow with dryRun true, or the script with --dry-run: a server-side dry run.'],
        undo: [`kubectl delete ${object.object.kind.toLowerCase()} ${objName} -n ${ns}${kind === 'pvc' ? ' — the data on the volume is deleted with it (reclaim policy Delete)' : ''}.`],
        told: ['Kubernetes events and the Supervisor audit log.', 'The workflow log (AUDIT lines), its summary output and the webhook when set.'],
        requires: ['An All Apps namespace, and kubectl with the VCF CLI in its context.'],
        files: {
          ...pkg.files,
          ...(isSecret
            ? { 'scripts/create-secret.sh': secretScript }
            : {
                [`${objName}.k8s.yaml`]: k8sYaml([{ object: object.object }]),
                'scripts/create-object.sh': kubeScript(`Create ${what} in ${ns}.`, scriptPre, [`${objName}.k8s.yaml`], `kubectl delete -f ${objName}.k8s.yaml`),
              }),
          'IMPORT.md': importMd({
            subject: `The ${what} in ${ns}: an Orchestrator workflow that creates it through the namespace's Kubernetes API, and a script for kubectl.`,
            orgs: ALL_APPS,
            steps: [
              ...pkg.importSteps,
              isSecret
                ? manualStep('Or: the Secret with kubectl', [`\`EXPECT_CONTEXT=<context> ${secretKeys.map((k) => `${envOf(k)}=<file>`).join(' ')} ./scripts/create-secret.sh\`; \`--dry-run\` is a server-side dry run. Each value is read from its mode-600 file.`])
                : kubeStep('Or: with kubectl', 'scripts/create-object.sh', [`${objName}.k8s.yaml`]),
            ],
            auth: ['kube', 'vcfa91'],
            verify: [...(kind === 'vmservice' ? ['The VirtualMachineService apiVersion: kubectl api-versions | grep vmoperator.'] : []), kit.KUBE_VERIFY],
          }),
        },
        findings,
      };
    },
  });
}

export function vcfa91Network(kit           )                        {
  return [aviLoadBalancer(kit), transitGateway(kit), liveRecovery(kit), velero(kit), namespaceObjects(kit)];
}
