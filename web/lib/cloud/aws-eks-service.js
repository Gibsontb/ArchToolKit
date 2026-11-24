import { error,              } from '../core/findings.js';
                                                     
import { blk, dat, output, res, x } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.js';

export const AWS_EKS_SERVICE = {
  id: 'aws_service_eks', label: 'Set up an EKS cluster with managed nodes',
  description: 'Create an IPv4 EKS cluster and an encrypted AL2023 x86-64 managed node group in an existing VPC.',
  emits: ['aws_eks_cluster', 'aws_eks_node_group', 'aws_launch_template', 'aws_eks_access_entry', 'aws_eks_access_policy_association', 'aws_cloudwatch_log_group'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Cluster name', control: 'text' },
    { id: 'version', label: 'Kubernetes version', control: 'text', hint: 'Enter a version offered for new EKS clusters in this region. Review its support dates and add-on compatibility.' },
    { id: 'subnets', label: 'Existing cluster and node subnet IDs', control: 'text', hint: 'Comma-separated private IPv4 subnet IDs across at least two Availability Zones in one VPC. Provide NAT or required VPC endpoints.' },
    { id: 'cluster_role', label: 'Existing cluster IAM role ARN', control: 'text', hint: 'Trust eks.amazonaws.com and attach AmazonEKSClusterPolicy or an approved equivalent.' },
    { id: 'node_role', label: 'Existing node IAM role ARN', control: 'text', hint: 'Separate EC2-trusted role with EKS worker, ECR pull and IPv4 VPC CNI permissions. Prefer a separate CNI role after bootstrap.' },
    { id: 'admin', label: 'Cluster administrator IAM role ARN', control: 'text', hint: 'An existing role authorized for cluster-wide administration. The deployment principal receives no automatic Kubernetes administrator access.' },
    { id: 'endpoint', label: 'API endpoint access', control: 'select', default: 'private', options: [{ value: 'private', label: 'Private endpoint' }, { value: 'both', label: 'Private plus restricted public endpoint' }] },
    { id: 'public_cidrs', label: 'Allowed public API IPv4 CIDRs', control: 'text', hint: 'Comma-separated approved IPv4 ranges. Unrestricted 0.0.0.0/0 is excluded by this form.', showWhen: { input: 'endpoint', equals: ['both'] } },
    { id: 'instance_type', label: 'Node instance type', control: 'combo', default: 'm6i.large', options: ['m6i.large', 'm6i.xlarge', 'm7i.large', 'm7i.xlarge', 'm5.large', 'm5.xlarge'].map(value => ({ value, label: value })), hint: 'An available x86-64 EC2 type compatible with the selected EKS optimized AL2023 AMI.' },
    { id: 'capacity', label: 'Node purchase option', control: 'select', default: 'ON_DEMAND', options: [{ value: 'ON_DEMAND', label: 'On-demand' }, { value: 'SPOT', label: 'Spot — interruption tolerant workloads' }] },
    { id: 'minimum', label: 'Minimum nodes', control: 'number', default: 2, min: 1 },
    { id: 'desired', label: 'Desired nodes', control: 'number', default: 2, min: 1 },
    { id: 'maximum', label: 'Maximum nodes', control: 'number', default: 4, min: 1 },
    { id: 'disk', label: 'Node root disk (GiB)', control: 'number', default: 50, min: 20, max: 16384 },
    { id: 'retention', label: 'Control plane log retention', control: 'select', default: '90', options: [7, 14, 30, 60, 90, 180, 365].map(value => ({ value: String(value), label: value + ' days' })) },
  ],
  build(values) {
    const findings            = [];
    const reject = (path        , message        ) => findings.push(error('aws.eks.' + path, message, { path }));
    const location = String(values.aws_region ?? ''), partition = awsServicePartition(location);
    const name = String(values.name ?? ''), version = String(values.version ?? ''), endpoint = String(values.endpoint ?? '');
    const list = (key        ) => [...new Set(String(values[key] ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    const subnets = list('subnets'), cidrs = list('public_cidrs');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(name)) reject('name', 'Use 1–100 letters, numbers, hyphens or underscores.');
    if (!/^1\.[1-9][0-9]$/.test(version)) reject('version', 'Enter a regionally supported Kubernetes version such as 1.xx.');
    if (subnets.length < 2 || subnets.length > 16 || subnets.some(value => !/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('subnets', 'Enter 2–16 valid existing subnet IDs.');
    const roles                           = {};
    for (const key of ['cluster_role', 'node_role', 'admin']) {
      const parsed = /^arn:([^:]+):iam::(\d{12}):role\/([A-Za-z0-9+=,.@_/-]+)$/.exec(String(values[key] ?? ''));
      if (!parsed || parsed[1] !== partition) reject(key, 'Enter an existing IAM role ARN in the selected partition.');
      roles[key] = parsed ?? [];
    }
    if (values.cluster_role === values.node_role) reject('node_role', 'Use separate cluster and node IAM roles.');
    if (values.admin === values.cluster_role || values.admin === values.node_role) reject('admin', 'Use a separate administrator role assumed by authorized operators.');
    if (!['private', 'both'].includes(endpoint)) reject('endpoint', 'Select API endpoint access.');
    const validCidr = (value        ) => {
      const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(value);
      if (!parts || parts.slice(1, 5).some(octet => Number(octet) > 255) || Number(parts[5]) < 1 || Number(parts[5]) > 32) return false;
      const address = parts.slice(1, 5).reduce((sum, octet) => sum * 256 + Number(octet), 0);
      return address % 2 ** (32 - Number(parts[5])) === 0;
    };
    if (endpoint === 'both' && (!cidrs.length || cidrs.length > 40 || cidrs.some(cidr => !validCidr(cidr)))) reject('public_cidrs', 'Enter 1–40 valid network IPv4 CIDRs with prefix lengths 1–32.');
    const type = String(values.instance_type ?? ''), capacity = String(values.capacity ?? '');
    if (!/^[a-z][a-z0-9-]*\.[a-z0-9]+$/.test(type)) reject('instance_type', 'Select an x86-64 EC2 instance type.');
    if (!['ON_DEMAND', 'SPOT'].includes(capacity)) reject('capacity', 'Select a node purchase option.');
    const integer = (key        , min        , max        ) => { const value = Number(values[key]); if (!Number.isInteger(value) || value < min || value > max) reject(key, 'Enter a whole number from ' + min + ' to ' + max + '.'); return value; };
    const minimum = integer('minimum', 1, 1000), desired = integer('desired', 1, 1000), maximum = integer('maximum', 1, 1000), disk = integer('disk', 20, 16384);
    if (minimum > desired || desired > maximum) reject('desired', 'Keep minimum ≤ desired ≤ maximum. Confirm the managed-node-group quota.');
    const retention = Number(values.retention);
    if (![7, 14, 30, 60, 90, 180, 365].includes(retention)) reject('retention', 'Select control plane log retention.');
    return awsServiceModule(location, [
      dat('aws_caller_identity', 'current', {}),
      dat('aws_subnet', 'selected', { for_each: x('toset(' + JSON.stringify(subnets) + ')'), id: x('each.value') }),
      dat('aws_ec2_instance_type', 'node', { instance_type: type }),
      res('aws_cloudwatch_log_group', 'cluster', { name: '/aws/eks/' + name + '/cluster', retention_in_days: retention }),
      res('aws_eks_cluster', 'configured', {
        name, version, role_arn: String(values.cluster_role ?? ''), enabled_cluster_log_types: ['api', 'audit', 'authenticator', 'controllerManager', 'scheduler'],
        depends_on: x('[aws_cloudwatch_log_group.cluster]'),
      }, [
        blk('access_config', { authentication_mode: 'API', bootstrap_cluster_creator_admin_permissions: false }),
        blk('vpc_config', { subnet_ids: subnets, endpoint_private_access: true, endpoint_public_access: endpoint === 'both', ...(endpoint === 'both' ? { public_access_cidrs: cidrs } : {}) }),
        blk('kubernetes_network_config', { ip_family: 'ipv4' }),
        blk('lifecycle', { prevent_destroy: true }, [
          blk('precondition', { condition: x('length(toset([for subnet in data.aws_subnet.selected : subnet.vpc_id])) == 1 && length(toset([for subnet in data.aws_subnet.selected : subnet.availability_zone_id])) >= 2'), error_message: 'Choose subnets in one VPC across at least two Availability Zones.' }),
          blk('precondition', { condition: x('alltrue([for subnet in data.aws_subnet.selected : !subnet.ipv6_native && subnet.available_ip_address_count >= 6])'), error_message: 'EKS needs IPv4 subnets with at least six free addresses each; budget additional addresses for nodes, pods and upgrades.' }),
          blk('precondition', { condition: x('alltrue([for account in ' + JSON.stringify(Object.values(roles).map(role => role[2] ?? '')) + ' : account == data.aws_caller_identity.current.account_id])'), error_message: 'Use cluster, node and administrator roles from the deployment account.' }),
          blk('precondition', { condition: x('contains(data.aws_ec2_instance_type.node.supported_architectures, "x86_64")'), error_message: 'This node group uses an x86-64 AMI.' }),
        ]),
      ]),
      res('aws_eks_access_entry', 'admin', { cluster_name: x('aws_eks_cluster.configured.name'), principal_arn: String(values.admin ?? ''), type: 'STANDARD' }),
      res('aws_eks_access_policy_association', 'admin', { cluster_name: x('aws_eks_cluster.configured.name'), principal_arn: x('aws_eks_access_entry.admin.principal_arn'), policy_arn: 'arn:' + partition + ':eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy' }, [blk('access_scope', { type: 'cluster' })]),
      res('aws_launch_template', 'nodes', { name_prefix: name + '-nodes-' }, [
        blk('block_device_mappings', { device_name: '/dev/xvda' }, [blk('ebs', { volume_size: disk, volume_type: 'gp3', encrypted: true, delete_on_termination: true })]),
        blk('metadata_options', { http_endpoint: 'enabled', http_tokens: 'required', http_put_response_hop_limit: 2 }),
      ]),
      res('aws_eks_node_group', 'configured', {
        cluster_name: x('aws_eks_cluster.configured.name'), node_group_name: 'application', node_role_arn: String(values.node_role ?? ''), subnet_ids: subnets,
        ami_type: 'AL2023_x86_64_STANDARD', instance_types: [type], capacity_type: capacity,
      }, [blk('scaling_config', { min_size: minimum, desired_size: desired, max_size: maximum }), blk('update_config', { max_unavailable: 1 }),
        blk('launch_template', { id: x('aws_launch_template.nodes.id'), version: x('aws_launch_template.nodes.latest_version') })]),
      output('cluster_name', 'aws_eks_cluster.configured.name'), output('cluster_endpoint', 'aws_eks_cluster.configured.endpoint'),
    ], `# EKS cluster and managed nodes

## Prepare
Verify the selected Kubernetes version, regional EKS availability, instance capacity and account quotas. Prepare existing private IPv4 subnets in one DNS-enabled VPC across at least two supported AZs. Allow cluster/node communication and provide NAT or ECR, S3, STS and other required endpoints. Size free subnet addresses for pods and rolling upgrades, beyond the control plane minimum. Prepare separate cluster and EC2 node IAM roles with the policies described in the form and iam:PassRole permission for the deployer. Review those role policies and trust independently.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review the chosen version, restricted endpoint, administrator role, node count, encrypted disks and recurring costs. Apply the saved plan. AWS bootstraps default networking add-ons. This form uses managed AL2023 x86-64 nodes and IPv4; Fargate, Auto Mode, Windows/GPU nodes and custom networking use their corresponding existing builders.

## Verify
From a host that can reach the private endpoint, assume the configured administrator role. Run aws eks update-kubeconfig --name ${name} --region ${location} --role-arn ${String(values.admin ?? '')}. Run kubectl get nodes and kubectl get pods -A. Confirm nodes are Ready, CoreDNS is available, pod networking and DNS work, and control-plane audit logs arrive. Test application deployment and node replacement before onboarding workloads. Install and authorize required CSI drivers, ingress controllers, workload identities and backup tooling separately. No application workload or persistent-volume migration is performed by this package.

## Recovery
Retain the old cluster during cutover. Back up persistent volumes and application configuration before moving traffic. Respect disruption budgets when scaling or updating nodes. Kubernetes minor-version downgrades are unsupported; restore workloads into a compatible cluster instead. The cluster has Terraform prevent_destroy. Review and explicitly remove that protection only during approved retirement after data recovery has been tested.

https://docs.aws.amazon.com/eks/latest/userguide/create-cluster.html
https://docs.aws.amazon.com/eks/latest/userguide/network-reqs.html
`, findings);
  },
}                    ;
