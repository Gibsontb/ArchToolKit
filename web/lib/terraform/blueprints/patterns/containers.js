/**
 * `<p>_app_containers` (tier pattern `containers`, addendum A.4.1, A.4.7):
 * the Kubernetes cluster an app's containers move to, its node pool and its
 * image registry. Velero (`app_velero`, Ansible) and the `k8s-velero` path
 * move the workloads; the images are copied with crane or skopeo.
 *
 *   AWS     EKS (API authentication, the IPv6 family on a dual-stack network),
 *           a managed node group in the app tier, the core add-ons, ECR
 *   Azure   AKS: private cluster, Azure CNI overlay with Cilium, IPv4 and
 *           IPv6 on a dual-stack network, Entra ID RBAC, Container Insights to
 *           the landing zone's workspace, and ACR with AcrPull for the nodes
 *   Google  GKE: regional, VPC-native (IPV4_IPV6 on a dual-stack subnet),
 *           private nodes, Dataplane V2, Workload Identity, a node pool, and
 *           Artifact Registry
 *   OCI     OKE: enhanced cluster, VCN-native pod networking, IPv4 and IPv6
 *           families on a dual-stack VCN, a node pool across the availability
 *           domains, and an OCI Registry repository
 *   VCF     vSphere Kubernetes Service: a vSphere Namespace on the Supervisor
 *           (storage policy, VM classes) and the VKS Cluster manifest,
 *           cluster.yaml, applied with kubectl to the namespace
 */

import { info, warning,              } from '../../../core/findings.js';
                                                                                                         
import { num as numberOf, str as valueOf } from '../../../kit/blueprint.js';
                                             
import { LANDING_ZONE_SOURCE, attrs, blk, dat, jsonencode, lzRef, output, q, res, rname, x } from '../migration/common.js';
import {
  NETWORK_INPUT,
  PATTERN_GROUP,
  VSPHERE_SERVER_INPUT,
  appInputs,
  appOf,
  ipv6Of,
  namePrefix,
  patternMainTf,
  preamble,
  securityGroupOf,
  subnetOf,
  subnetsOf,
  tagsExpr,
  vsphereProvider,
                       
} from './common.js';

const NODE_SIZES                                                       = {
  aws: ['m7i.large', 'm7i.xlarge', 'm7i.2xlarge', 'c7i.xlarge', 'r7i.xlarge'],
  azure: ['Standard_D4ds_v5', 'Standard_D8ds_v5', 'Standard_D16ds_v5', 'Standard_E8ds_v5'],
  google: ['n2-standard-4', 'n2-standard-8', 'n2-standard-16', 'e2-standard-4'],
  oci: ['VM.Standard.E5.Flex:2', 'VM.Standard.E5.Flex:4', 'VM.Standard.E5.Flex:8'],
  vsphere: ['best-effort-large', 'best-effort-xlarge', 'guaranteed-large', 'guaranteed-xlarge'],
};

function containerInputs(platform                 )                   {
  return [
    ...appInputs(),
    ...(platform === 'vsphere' ? [VSPHERE_SERVER_INPUT] : [NETWORK_INPUT]),
    { id: 'kubernetes_version', label: 'Kubernetes version', control: 'text', default: '', hint: platform === 'vsphere' ? 'The VKS release (e.g. v1.33.1---vmware.1-fips-vkr.2); blank: the Supervisor\'s default.' : 'Blank: the service\'s current default.' },
    { id: 'node_size', label: 'Node size', control: 'combo', default: NODE_SIZES[platform][0], options: NODE_SIZES[platform].map((v) => ({ value: v, label: v })) },
    { id: 'nodes_min', label: 'Nodes (minimum)', control: 'number', default: 3, min: 1, max: 100 },
    { id: 'nodes_max', label: 'Nodes (maximum)', control: 'number', default: 6, min: 1, max: 1000 },
    ...(platform === 'vsphere'
      ? [
          { id: 'supervisor_id', label: 'Supervisor', control: 'text'         , default: 'domain-c10', hint: 'The Supervisor (its cluster id) the namespace is created on.' },
          { id: 'storage_policy', label: 'Storage policy', control: 'text'         , default: 'vSAN Default Storage Policy' },
          { id: 'content_library', label: 'VKS content library', control: 'text'         , default: '', hint: 'The library holding the VKS releases; blank if the Supervisor subscribes to it already.' },
        ]
      : [
          ...(platform === 'azure' ? [{ id: 'admin_group_object_id', label: 'Cluster admin group', control: 'text'         , default: '', hint: 'Entra ID group object id(s) given cluster admin; blank: grant roles with Azure RBAC.' }] : []),
          { id: 'registry', label: 'Image registry', control: 'select'         , default: 'yes', options: [{ value: 'yes', label: 'Create one for the app' }, { value: 'no', label: 'None (use an existing registry)' }] },
          LANDING_ZONE_SOURCE,
        ]),
  ];
}

const nodeCounts = (values                 )                               => {
  const min = Math.max(1, numberOf(values, 'nodes_min', 3));
  return { min, max: Math.max(min, numberOf(values, 'nodes_max', 6)) };
};
const wantsRegistry = (values                 )          => valueOf(values, 'registry', 'yes') !== 'no';

// ---------------------------------------------------------------------------

function awsContainers(values                 , findings           )             {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const net = rname(valueOf(values, 'network', 'prod'));
  const v6 = ipv6Of(lz, net);
  const tags = x(tagsExpr(app, 'aws'));
  const { min, max } = nodeCounts(values);
  const version = valueOf(values, 'kubernetes_version');
  const assume = (service        ) => x(jsonencode({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: service }, Action: 'sts:AssumeRole' }] }));
  const blocks             = [
    ...preamble('aws', values),
    res('aws_iam_role', 'eks_cluster', { name: x(`"${pfx}-eks-cluster"`), assume_role_policy: assume('eks.amazonaws.com'), tags }),
    res('aws_iam_role_policy_attachment', 'eks_cluster', { role: x('aws_iam_role.eks_cluster.name'), policy_arn: 'arn:aws:iam::aws:policy/AmazonEKSClusterPolicy' }),
    res('aws_iam_role', 'eks_nodes', { name: x(`"${pfx}-eks-nodes"`), assume_role_policy: assume('ec2.amazonaws.com'), tags }),
    ...['AmazonEKSWorkerNodePolicy', 'AmazonEC2ContainerRegistryReadOnly', 'AmazonSSMManagedInstanceCore'].map((p) =>
      res('aws_iam_role_policy_attachment', `eks_nodes_${p.replace(/^Amazon/, '').toLowerCase()}`, { role: x('aws_iam_role.eks_nodes.name'), policy_arn: `arn:aws:iam::aws:policy/${p}` }),
    ),
    res('aws_iam_role_policy_attachment', 'eks_nodes_cni', { role: x('aws_iam_role.eks_nodes.name'), policy_arn: 'arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy' }),
    res('aws_iam_role_policy', 'eks_nodes_cni_ipv6', {
      count: x(`${v6} ? 1 : 0`),
      name: 'cni-ipv6',
      role: x('aws_iam_role.eks_nodes.id'),
      policy: x(jsonencode({
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Action: ['ec2:AssignIpv6Addresses', 'ec2:DescribeInstances', 'ec2:DescribeTags', 'ec2:DescribeNetworkInterfaces', 'ec2:DescribeInstanceTypes'], Resource: '*' },
          { Effect: 'Allow', Action: ['ec2:CreateTags'], Resource: 'arn:aws:ec2:*:*:network-interface/*' },
        ],
      })),
    }, [], 'An IPv6 cluster\'s VPC CNI assigns IPv6 prefixes: the AWS-documented policy (AmazonEKS_CNI_Policy covers IPv4 only).'),
    res('aws_eks_cluster', 'app', {
      name: x(`"${pfx}"`),
      role_arn: x('aws_iam_role.eks_cluster.arn'),
      version: version || undefined,
      enabled_cluster_log_types: ['api', 'audit', 'authenticator', 'controllerManager', 'scheduler'],
      bootstrap_self_managed_addons: false,
      deletion_protection: app.criticality === 'tier0' || app.criticality === 'tier1',
      tags,
      depends_on: x('[aws_iam_role_policy_attachment.eks_cluster]'),
    }, [
      blk('access_config', { authentication_mode: 'API', bootstrap_cluster_creator_admin_permissions: true }),
      blk('vpc_config', { subnet_ids: x(subnetsOf(lz, net, 'app')), security_group_ids: x(`[${securityGroupOf(lz, net, 'app')}]`), endpoint_private_access: true, endpoint_public_access: false }),
      blk('kubernetes_network_config', { ip_family: x(`${v6} ? "ipv6" : "ipv4"`) }),
      blk('upgrade_policy', { support_type: 'STANDARD' }),
    ]),
    res('aws_eks_node_group', 'app', {
      cluster_name: x('aws_eks_cluster.app.name'),
      node_group_name: 'app',
      node_role_arn: x('aws_iam_role.eks_nodes.arn'),
      subnet_ids: x(subnetsOf(lz, net, 'app')),
      ami_type: 'AL2023_x86_64_STANDARD',
      instance_types: [valueOf(values, 'node_size', 'm7i.large')],
      capacity_type: 'ON_DEMAND',
      tags,
      depends_on: x('[aws_iam_role_policy_attachment.eks_nodes_eksworkernodepolicy, aws_iam_role_policy_attachment.eks_nodes_cni, aws_eks_addon.vpc_cni]'),
    }, [
      blk('scaling_config', { min_size: min, desired_size: min, max_size: max }),
      blk('update_config', { max_unavailable: 1 }),
    ]),
  ];
  for (const addon of ['vpc-cni', 'kube-proxy', 'coredns', 'eks-pod-identity-agent']) {
    blocks.push(
      res('aws_eks_addon', addon.replace(/-/g, '_'), {
        cluster_name: x('aws_eks_cluster.app.name'),
        addon_name: addon,
        resolve_conflicts_on_create: 'OVERWRITE',
        resolve_conflicts_on_update: 'PRESERVE',
        tags,
        depends_on: addon === 'coredns' ? x('[aws_eks_node_group.app]') : undefined,
      }),
    );
  }
  if (wantsRegistry(values)) {
    blocks.push(
      res('aws_ecr_repository', 'app', { name: x(`"${pfx}"`), image_tag_mutability: 'IMMUTABLE', tags }, [blk('image_scanning_configuration', { scan_on_push: true }), blk('encryption_configuration', { encryption_type: 'AES256' })]),
      output('registry_url', 'aws_ecr_repository.app.repository_url'),
    );
  }
  blocks.push(output('cluster_name', 'aws_eks_cluster.app.name'), output('cluster_endpoint', 'aws_eks_cluster.app.endpoint'));
  findings.push(info('tf.app.eks-ip-family', 'The cluster\'s IP family is fixed when it is created: IPv6 on a dual-stack network (pods and services get IPv6; IPv4 egress goes through the node\'s address).', { source: 'https://docs.aws.amazon.com/eks/latest/userguide/cni-ipv6.html' }));
  return blocks;
}

function azureContainers(values                 )             {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const net = rname(valueOf(values, 'network', 'prod'));
  const v6 = ipv6Of(lz, net);
  const tags = x(tagsExpr(app, 'azure'));
  const rg = `${lz}.resource_group[${q(net)}]`;
  const { min, max } = nodeCounts(values);
  const version = valueOf(values, 'kubernetes_version');
  const subnet = subnetOf(lz, net, 'app');
  const admins = valueOf(values, 'admin_group_object_id').split(/[\s,]+/).filter(Boolean);
  const blocks             = [
    ...preamble('azure', values),
    dat('azurerm_client_config', 'aks', {}),
    res('azurerm_kubernetes_cluster', 'app', {
      name: x(`"${pfx}-aks"`),
      resource_group_name: x(rg),
      location: x(`${lz}.location`),
      dns_prefix: x(`"${pfx}"`),
      kubernetes_version: version || undefined,
      sku_tier: app.criticality === 'tier0' || app.criticality === 'tier1' ? 'Standard' : 'Free',
      private_cluster_enabled: true,
      private_dns_zone_id: 'System',
      local_account_disabled: true,
      role_based_access_control_enabled: true,
      oidc_issuer_enabled: true,
      workload_identity_enabled: true,
      azure_policy_enabled: true,
      automatic_upgrade_channel: 'patch',
      node_os_upgrade_channel: 'NodeImage',
      image_cleaner_enabled: true,
      image_cleaner_interval_hours: 48,
      tags,
    }, [
      blk('default_node_pool', {
        name: 'system',
        vm_size: valueOf(values, 'node_size', 'Standard_D4ds_v5'),
        vnet_subnet_id: x(subnet),
        zones: x(`${lz}.zones`),
        auto_scaling_enabled: true,
        min_count: min,
        max_count: max,
        os_sku: 'AzureLinux',
        temporary_name_for_rotation: 'systemtmp',
        tags,
      }, [blk('upgrade_settings', { max_surge: '33%' })]),
      blk('identity', { type: 'SystemAssigned' }),
      blk('node_provisioning_profile', { mode: 'Manual' }),
      blk('network_profile', {
        network_plugin: 'azure',
        network_plugin_mode: 'overlay',
        network_data_plane: 'cilium',
        network_policy: 'cilium',
        load_balancer_sku: 'standard',
        ip_versions: x(`${v6} ? ["IPv4", "IPv6"] : ["IPv4"]`),
      }),
      blk('azure_active_directory_role_based_access_control', { azure_rbac_enabled: true, tenant_id: x('data.azurerm_client_config.aks.tenant_id'), admin_group_object_ids: admins.length > 0 ? admins : undefined }),
      blk('oms_agent', { log_analytics_workspace_id: x(`${lz}.log_destination`), msi_auth_for_monitoring_enabled: true }),
      blk('key_vault_secrets_provider', { secret_rotation_enabled: true }),
      blk('maintenance_window_auto_upgrade', { frequency: 'Weekly', interval: 1, duration: 4, day_of_week: 'Sunday', start_time: '02:00', utc_offset: '+00:00' }),
    ]),
    res('azurerm_role_assignment', 'aks_subnet', { scope: x(subnet), role_definition_name: 'Network Contributor', principal_id: x('azurerm_kubernetes_cluster.app.identity[0].principal_id') }, [], 'The cluster manages load balancer addresses in its subnet.'),
  ];
  if (wantsRegistry(values)) {
    blocks.push(
      res('azurerm_container_registry', 'app', {
        name: x(`substr(replace(lower("${pfx}acr"), "/[^a-z0-9]/", ""), 0, 50)`),
        resource_group_name: x(rg),
        location: x(`${lz}.location`),
        sku: 'Premium',
        admin_enabled: false,
        anonymous_pull_enabled: false,
        zone_redundancy_enabled: true,
        tags,
      }),
      res('azurerm_role_assignment', 'aks_acr_pull', { scope: x('azurerm_container_registry.app.id'), role_definition_name: 'AcrPull', principal_id: x('azurerm_kubernetes_cluster.app.kubelet_identity[0].object_id') }),
      output('registry_login_server', 'azurerm_container_registry.app.login_server'),
    );
  }
  blocks.push(output('cluster_name', 'azurerm_kubernetes_cluster.app.name'), output('private_fqdn', 'azurerm_kubernetes_cluster.app.private_fqdn'));
  return blocks;
}

function googleContainers(values                 )             {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const net = rname(valueOf(values, 'network', 'prod'));
  const v6 = ipv6Of(lz, net);
  const labels = x(tagsExpr(app, 'google'));
  const project = `${lz}.project`;
  const { min, max } = nodeCounts(values);
  const version = valueOf(values, 'kubernetes_version');
  const perZone = (n        ) => `ceil(${n} / length(${lz}.zones))`;
  const blocks             = [
    ...preamble('google', values),
    res('google_container_cluster', 'app', {
      name: x(`"${pfx}"`),
      project: x(project),
      location: x(`${lz}.region`),
      network: x(`${lz}.network_ids[${q(net)}]`),
      subnetwork: x(subnetOf(lz, net, 'app')),
      networking_mode: 'VPC_NATIVE',
      datapath_provider: 'ADVANCED_DATAPATH',
      remove_default_node_pool: true,
      initial_node_count: 1,
      min_master_version: version || undefined,
      deletion_protection: app.criticality === 'tier0' || app.criticality === 'tier1',
      resource_labels: labels,
      enable_shielded_nodes: true,
    }, [
      blk('ip_allocation_policy', { stack_type: x(`${v6} ? "IPV4_IPV6" : "IPV4"`) }),
      blk('private_cluster_config', { enable_private_nodes: true, enable_private_endpoint: true }),
      blk('master_authorized_networks_config', {}, [
        { type: 'dynamic', labels: ['cidr_blocks'], attributes: attrs({ for_each: x(`[for c in ${lz}.mgmt_cidrs : c if !strcontains(c, ":")]`) }), blocks: [blk('content', { cidr_block: x('cidr_blocks.value'), display_name: 'management' })] },
      ]),
      blk('release_channel', { channel: 'REGULAR' }),
      blk('workload_identity_config', { workload_pool: x(`"\${${project}}.svc.id.goog"`) }),
      blk('binary_authorization', { evaluation_mode: 'PROJECT_SINGLETON_POLICY_ENFORCE' }),
      blk('maintenance_policy', {}, [blk('daily_maintenance_window', { start_time: '02:00' })]),
    ]),
    res('google_container_node_pool', 'app', {
      name: 'app',
      project: x(project),
      location: x(`${lz}.region`),
      cluster: x('google_container_cluster.app.name'),
      initial_node_count: x(perZone(min)),
    }, [
      blk('autoscaling', { total_min_node_count: min, total_max_node_count: max, location_policy: 'BALANCED' }),
      blk('management', { auto_repair: true, auto_upgrade: true }),
      blk('node_config', {
        machine_type: valueOf(values, 'node_size', 'n2-standard-4'),
        service_account: x(`${lz}.service_account`),
        oauth_scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        tags: x(`[${securityGroupOf(lz, net, 'app')}]`),
        labels,
      }, [blk('workload_metadata_config', { mode: 'GKE_METADATA' }), blk('shielded_instance_config', { enable_secure_boot: true, enable_integrity_monitoring: true })]),
    ]),
  ];
  if (wantsRegistry(values)) {
    blocks.push(
      res('google_artifact_registry_repository', 'app', { repository_id: x(`"${pfx}"`), project: x(project), location: x(`${lz}.region`), format: 'DOCKER', labels }, [blk('docker_config', { immutable_tags: true })]),
      output('registry', '"${google_artifact_registry_repository.app.location}-docker.pkg.dev/${google_artifact_registry_repository.app.project}/${google_artifact_registry_repository.app.repository_id}"'),
    );
  }
  blocks.push(output('cluster_name', 'google_container_cluster.app.name'), output('endpoint', 'google_container_cluster.app.endpoint'));
  return blocks;
}

function ociContainers(values                 )             {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const net = rname(valueOf(values, 'network', 'prod'));
  const v6 = ipv6Of(lz, net);
  const tags = x(tagsExpr(app, 'oci'));
  const comp = `${lz}.compartment_id`;
  const { min } = nodeCounts(values);
  const [shape = 'VM.Standard.E5.Flex', ocpus = '2'] = valueOf(values, 'node_size', 'VM.Standard.E5.Flex:2').split(':');
  const version = valueOf(values, 'kubernetes_version');
  const subnet = subnetOf(lz, net, 'app');
  const nsg = securityGroupOf(lz, net, 'app');
  const blocks             = [
    ...preamble('oci', values),
    dat('oci_containerengine_cluster_option', 'oke', { cluster_option_id: 'all', compartment_id: x(comp) }),
    res('oci_containerengine_cluster', 'app', {
      compartment_id: x(comp),
      name: x(`"${pfx}"`),
      vcn_id: x(`${lz}.network_ids[${q(net)}]`),
      kubernetes_version: version ? version : x('reverse(sort(data.oci_containerengine_cluster_option.oke.kubernetes_versions))[0]'),
      type: 'ENHANCED_CLUSTER',
      freeform_tags: tags,
    }, [
      blk('cluster_pod_network_options', { cni_type: 'OCI_VCN_IP_NATIVE' }),
      blk('endpoint_config', { subnet_id: x(subnet), is_public_ip_enabled: false, nsg_ids: x(`[${nsg}]`) }),
      blk('options', { ip_families: x(`${v6} ? ["IPv4", "IPv6"] : ["IPv4"]`), service_lb_subnet_ids: x(`[${subnetOf(lz, net, 'web')}]`) }),
    ]),
    dat('oci_containerengine_node_pool_option', 'oke', { node_pool_option_id: x('oci_containerengine_cluster.app.id'), compartment_id: x(comp) }),
    res('oci_containerengine_node_pool', 'app', {
      compartment_id: x(comp),
      cluster_id: x('oci_containerengine_cluster.app.id'),
      name: 'app',
      kubernetes_version: x('oci_containerengine_cluster.app.kubernetes_version'),
      node_shape: shape,
      freeform_tags: tags,
    }, [
      blk('node_shape_config', { ocpus: Number(ocpus) || 2, memory_in_gbs: (Number(ocpus) || 2) * 16 }),
      blk('node_source_details', {
        source_type: 'IMAGE',
        image_id: x(`[for s in data.oci_containerengine_node_pool_option.oke.sources : s.image_id if strcontains(s.source_name, trimprefix(oci_containerengine_cluster.app.kubernetes_version, "v")) && !strcontains(s.source_name, "aarch64") && !strcontains(s.source_name, "GPU")][0]`),
      }),
      blk('node_config_details', { size: min, nsg_ids: x(`[${nsg}]`), is_pv_encryption_in_transit_enabled: true }, [
        { type: 'dynamic', labels: ['placement_configs'], attributes: attrs({ for_each: x(`${lz}.zones`) }), blocks: [blk('content', { availability_domain: x('placement_configs.value'), subnet_id: x(subnet) })] },
        blk('node_pool_pod_network_option_details', { cni_type: 'OCI_VCN_IP_NATIVE', pod_subnet_ids: x(`[${subnet}]`), pod_nsg_ids: x(`[${nsg}]`) }),
      ]),
      blk('node_pool_cycling_details', { is_node_cycling_enabled: true, maximum_surge: '1', maximum_unavailable: '0' }),
    ]),
  ];
  if (wantsRegistry(values)) {
    blocks.push(
      res('oci_artifacts_container_repository', 'app', { compartment_id: x(comp), display_name: x(`"${pfx}"`), is_immutable: true, is_public: false, freeform_tags: tags }),
      output('registry_path', 'oci_artifacts_container_repository.app.display_name', 'The repository, under <region>.ocir.io/<namespace>/.'),
    );
  }
  blocks.push(output('cluster_id', 'oci_containerengine_cluster.app.id'));
  return blocks;
}

/** The VKS Cluster manifest (Cluster API with a ClusterClass), applied with kubectl in the vSphere Namespace. */
function vksManifest(values                 , name        , namespace        , findings           )         {
  const { min, max } = nodeCounts(values);
  const version = valueOf(values, 'kubernetes_version') || 'v1.33.1---vmware.1-fips-vkr.2';
  const vmClass = valueOf(values, 'node_size', 'best-effort-large');
  const policy = rname(valueOf(values, 'storage_policy', 'vSAN Default Storage Policy'));
  findings.push(
    warning('tf.app.vks-manifest', 'cluster.yaml uses the builtin-generic-v3.4.0 ClusterClass and the VKS release name given; check both against the Supervisor (kubectl get clusterclass,kr -n <namespace>) before applying, since they change with each VKS release.', {
      source: 'https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vsphere-supervisor-services-and-standalone-components/latest/managing-vsphere-kubernetes-service-clusters-and-workloads.html',
    }),
  );
  return [
    '# The VKS workload cluster: kubectl apply -f cluster.yaml in the vSphere Namespace below,',
    '# after terraform apply has created the namespace (kubectl vsphere login to the Supervisor first).',
    'apiVersion: cluster.x-k8s.io/v1beta1',
    'kind: Cluster',
    'metadata:',
    `  name: ${name}`,
    `  namespace: ${namespace}`,
    '  labels:',
    `    atk_app: ${rname(appOf(values).name)}`,
    'spec:',
    '  clusterNetwork:',
    '    pods:',
    '      cidrBlocks: ["192.168.156.0/20"]',
    '    services:',
    '      cidrBlocks: ["10.96.0.0/12"]',
    '    serviceDomain: cluster.local',
    '  topology:',
    '    class: builtin-generic-v3.4.0',
    '    classNamespace: vmware-system-vks-public',
    `    version: ${version}`,
    '    controlPlane:',
    '      replicas: 3',
    '    workers:',
    '      machineDeployments:',
    '        - class: node-pool',
    '          name: app',
    `          replicas: ${min}`,
    '          metadata:',
    '            annotations:',
    `              cluster.x-k8s.io/cluster-api-autoscaler-node-group-min-size: "${min}"`,
    `              cluster.x-k8s.io/cluster-api-autoscaler-node-group-max-size: "${max}"`,
    '    variables:',
    '      - name: vmClass',
    `        value: ${vmClass}`,
    '      - name: storageClass',
    `        value: ${policy}`,
    '',
  ].join('\n');
}

function vsphereContainers(values                 , findings           )                                           {
  const app = appOf(values);
  const namespace = rname(app.slug, valueOf(values, 'component') || 'k8s').slice(0, 63);
  const library = valueOf(values, 'content_library');
  const blocks             = [
    ...vsphereProvider(values),
    dat('vsphere_storage_policy', 'vks', { name: valueOf(values, 'storage_policy', 'vSAN Default Storage Policy') }),
    ...(library ? [dat('vsphere_content_library', 'vks', { name: library })] : []),
    res('vsphere_namespace', 'app', {
      name: namespace,
      supervisor: valueOf(values, 'supervisor_id', 'domain-c10'),
      storage_policies: x('[data.vsphere_storage_policy.vks.id]'),
    }, [blk('vm_service', { vm_classes: [valueOf(values, 'node_size', 'best-effort-large')], content_libraries: library ? x('[data.vsphere_content_library.vks.id]') : undefined })]),
    output('namespace', 'vsphere_namespace.app.name', 'Apply cluster.yaml here.'),
  ];
  return { blocks, manifest: vksManifest(values, rname(app.slug, 'vks'), namespace, findings) };
}

const EMITS                                                       = {
  aws: ['aws_iam_role', 'aws_iam_role_policy_attachment', 'aws_iam_role_policy', 'aws_eks_cluster', 'aws_eks_node_group', 'aws_eks_addon', 'aws_ecr_repository'],
  azure: ['azurerm_kubernetes_cluster', 'azurerm_role_assignment', 'azurerm_container_registry'],
  google: ['google_container_cluster', 'google_container_node_pool', 'google_artifact_registry_repository'],
  oci: ['oci_containerengine_cluster', 'oci_containerengine_node_pool', 'oci_artifacts_container_repository'],
  vsphere: ['vsphere_namespace'],
};
const SERVICE                                            = { aws: 'Amazon EKS', azure: 'AKS', google: 'GKE', oci: 'OKE', vsphere: 'vSphere Kubernetes Service' };

function containers(platform                 )            {
  return {
    id: `${platform}_app_containers`,
    label: `App containers on ${SERVICE[platform]}`,
    group: PATTERN_GROUP,
    description: {
      aws: 'An EKS cluster (private endpoint, API access entries, the IPv6 family on a dual-stack network, control-plane logs), a managed AL2023 node group in the app tier, the VPC CNI, kube-proxy, CoreDNS and Pod Identity add-ons, and an ECR repository with scan on push.',
      azure: 'A private AKS cluster (Azure CNI overlay with Cilium, IPv4 and IPv6 on a dual-stack network, Entra ID RBAC with local accounts off, workload identity, Container Insights), an autoscaling zonal node pool, and a Premium ACR the nodes pull from.',
      google: 'A regional private GKE cluster (VPC-native, IPV4_IPV6 on a dual-stack subnet, Dataplane V2, Workload Identity, Binary Authorization, shielded nodes), an autoscaling node pool, and an Artifact Registry repository with immutable tags.',
      oci: 'An enhanced OKE cluster (private endpoint, VCN-native pod networking, IPv4 and IPv6 on a dual-stack VCN), a node pool across the availability domains with node cycling, and a private OCI Registry repository.',
      vsphere: 'A vSphere Namespace on the Supervisor (storage policy, VM class, VKS content library) and cluster.yaml, the VKS Cluster manifest applied into it.',
    }[platform],
    inputs: containerInputs(platform),
    emits: EMITS[platform],
    build: (values                 )              => {
      const findings            = [];
      const header = `${SERVICE[platform]}: ${appOf(values).name}`;
      if (platform === 'vsphere') {
        const { blocks, manifest } = vsphereContainers(values, findings);
        return { files: { 'main.tf': patternMainTf(blocks, header), 'cluster.yaml': manifest }, findings };
      }
      const blocks =
        platform === 'aws' ? awsContainers(values, findings)
        : platform === 'azure' ? azureContainers(values)
        : platform === 'google' ? googleContainers(values)
        : ociContainers(values);
      return { files: { 'main.tf': patternMainTf(blocks, header) }, findings };
    },
  };
}

export const CONTAINER_BLUEPRINTS                       = (['aws', 'azure', 'google', 'oci', 'vsphere']         ).map(containers);

