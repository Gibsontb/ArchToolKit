import { error, type Finding } from '../core/findings.ts';
import type { Blueprint } from '../kit/blueprint.ts';
import { blk, dat, hcl, jsonencode, output, res, x } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.ts';

export const AWS_GRAFANA_SERVICE = {
  id: 'aws_service_grafana', label: 'Set up a restricted Managed Grafana workspace',
  description: 'IAM Identity Center groups, customer-managed query role, restricted workspace ingress, optional private data-source networking and explicit data-source setup code.',
  emits: ['aws_grafana_workspace', 'aws_grafana_role_association', 'aws_iam_role_policy'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Workspace name', control: 'text' },
    { id: 'version', label: 'Regional Grafana version', control: 'text', default: '10.4', hint: 'Run the exported version preflight to verify current regional CreateWorkspace availability.' },
    { ...awsServiceRegion, id: 'identity_region', label: 'IAM Identity Center home region' },
    { id: 'store', label: 'Existing Identity Store ID', control: 'text', hint: 'Existing organization Identity Center instance; no directory, users or groups are created.' },
    { id: 'admins', label: 'Administrator group IDs', control: 'text', hint: 'Comma-separated existing Identity Center group IDs; at least one required.' },
    { id: 'editors', label: 'Editor group IDs', control: 'text', hint: 'Optional comma-separated group IDs; keep role groups distinct.' },
    { id: 'viewers', label: 'Viewer group IDs', control: 'text', hint: 'Optional comma-separated group IDs.' },
    { id: 'role', label: 'Existing Grafana data-source role ARN', control: 'text', hint: 'Same-account role trusted by grafana.amazonaws.com. Adds named query-only permissions; does not change role trust.' },
    { id: 'cloudwatch', label: 'CloudWatch metric data source', control: 'select', default: 'YES', options: [{ value: 'YES', label: 'Include metric/alarms read access' }, { value: 'NO', label: 'Do not include CloudWatch' }] },
    { id: 'prometheus', label: 'Existing Prometheus workspace ARN', control: 'text', hint: 'Optional same-account regional AMP workspace. Adds query/metadata permissions for that workspace only.' },
    { id: 'endpoints', label: 'Allowed Grafana workspace VPC endpoint IDs', control: 'text', hint: 'Up to five existing grafana-workspace interface endpoints. At least one endpoint or prefix list is required.' },
    { id: 'prefixes', label: 'Allowed public client prefix list IDs', control: 'text', hint: 'Up to five existing IPv4 managed prefix lists of approved public source addresses. Private ranges are ignored by Grafana; use an endpoint for private clients.' },
    { id: 'outbound', label: 'Private VPC data-source connection', control: 'select', default: 'NO', options: [{ value: 'NO', label: 'No outbound VPC connection' }, { value: 'YES', label: 'Use existing private subnets and security groups' }] },
    { id: 'subnets', label: 'Private data-source subnet IDs', control: 'text', showWhen: { input: 'outbound', equals: ['YES'] }, hint: '2–6 subnets across at least two normal AZs, same default-tenancy VPC; at least 15 free IPv4 addresses per subnet.' },
    { id: 'groups', label: 'Outbound connection security group IDs', control: 'text', showWhen: { input: 'outbound', equals: ['YES'] }, hint: '1–5 existing same-VPC groups with approved data-source egress. Outbound VPC routing does not restrict browser ingress.' },
  ],
  build(values): ReturnType<typeof awsServiceModule> {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.grafana.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), identityRegion = String(values.identity_region ?? ''), partition = awsServicePartition(region), name = String(values.name ?? '').trim(), version = String(values.version ?? '').trim(), store = String(values.store ?? '').trim(), role = String(values.role ?? '').trim(), amp = String(values.prometheus ?? '').trim(), cloudwatch = String(values.cloudwatch ?? ''), outbound = String(values.outbound ?? '');
    const list = (id: string) => [...new Set(String(values[id] ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    const admins = list('admins'), editors = list('editors'), viewers = list('viewers'), endpoints = list('endpoints'), prefixes = list('prefixes'), subnets = outbound === 'YES' ? list('subnets') : [], groups = outbound === 'YES' ? list('groups') : [];
    const groupIds = [...admins, ...editors, ...viewers];
    const match = new RegExp('^arn:' + partition + ':iam::(\\d{12}):role/([A-Za-z0-9+=,.@_/-]*[A-Za-z0-9+=,.@_-])$').exec(role), account = match?.[1] ?? '';
    const ampMatch = new RegExp('^arn:' + partition + ':aps:' + region + ':' + (account || '\\d{12}') + ':workspace/(ws-[a-f0-9-]{36})$').exec(amp);
    if (!/^[A-Za-z0-9][A-Za-z0-9_. -]{0,99}$/.test(name)) reject('name', 'Use 1–100 letters, digits, spaces, periods, underscores or hyphens.');
    if (!/^[1-9][0-9]?\.[0-9]{1,2}$/.test(version)) reject('version', 'Use an exact available regional major.minor version.');
    if (!awsServiceRegion.options!.some(option => option.value === identityRegion) || awsServicePartition(identityRegion) !== partition) reject('identity_region', 'Select the Identity Center home region in this partition.');
    if (!/^(?:d-[a-f0-9]{10}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(store)) reject('store', 'Use the existing organization Identity Store ID.');
    if (!admins.length) reject('admins', 'Select at least one existing administrator group.');
    for (const [id, ids] of [['admins', admins], ['editors', editors], ['viewers', viewers]] as const) if (ids.length > 20 || ids.some(value => !/^(?:[a-f0-9]{10}-)?[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value))) reject(id, 'Use up to 20 existing group IDs, not names or IAM role ARNs.');
    if (new Set(groupIds).size !== groupIds.length) reject('admins', 'Use distinct groups for administrator, editor and viewer roles.');
    if (!match) reject('role', 'Use an existing same-account Grafana query role ARN.');
    if (!['YES', 'NO'].includes(cloudwatch)) reject('cloudwatch', 'Select whether CloudWatch metrics are included.');
    if (amp && !ampMatch) reject('prometheus', 'Use a same-account regional Prometheus workspace ARN.');
    if (cloudwatch === 'NO' && !amp) reject('prometheus', 'Select at least one data source.');
    if (!endpoints.length && !prefixes.length) reject('endpoints', 'Provide at least one existing allowed workspace endpoint or public prefix list.');
    if (endpoints.length > 5 || endpoints.some(value => !/^vpce-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('endpoints', 'Use up to five workspace interface endpoint IDs.');
    if (prefixes.length > 5 || prefixes.some(value => !/^pl-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('prefixes', 'Use up to five managed prefix list IDs.');
    if (!['YES', 'NO'].includes(outbound)) reject('outbound', 'Choose whether to configure private data-source networking.');
    if (outbound === 'YES') {
      if (subnets.length < 2 || subnets.length > 6 || subnets.some(value => !/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('subnets', 'Use 2–6 existing private subnets across at least two AZs.');
      if (!groups.length || groups.length > 5 || groups.some(value => !/^sg-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('groups', 'Use 1–5 existing outbound groups in the subnet VPC.');
    }
    const statements = [
      ...(cloudwatch === 'YES' ? [{ Effect: 'Allow', Action: ['cloudwatch:ListMetrics', 'cloudwatch:GetMetricData', 'cloudwatch:GetMetricStatistics', 'cloudwatch:DescribeAlarms', 'cloudwatch:DescribeAlarmsForMetric', 'cloudwatch:DescribeAlarmHistory'], Resource: '*' }] : []),
      ...(amp ? [{ Effect: 'Allow', Action: ['aps:DescribeWorkspace', 'aps:QueryMetrics', 'aps:GetLabels', 'aps:GetSeries', 'aps:GetMetricMetadata'], Resource: amp }] : []),
    ];
    const networkCondition = 'alltrue([for endpoint in data.aws_vpc_endpoint.allowed : endpoint.state == "available" && endpoint.vpc_endpoint_type == "Interface" && endswith(endpoint.service_name, ".grafana-workspace")]) && alltrue([for prefix in data.aws_ec2_managed_prefix_list.allowed : prefix.address_family == "IPv4" && length(prefix.entries) > 0 && length(prefix.entries) <= 100 && alltrue([for entry in prefix.entries : entry.cidr != "0.0.0.0/0"])])';
    const guide = [
      '# Restricted Amazon Managed Grafana workspace',
      '## Prepare\nUse an existing organization IAM Identity Center instance and groups. Set its actual home region independently of the workspace region. Run PREFLIGHT.ps1 for current regional Grafana version availability. Confirm this managed service/region and data-source boundary is approved for the actual data; no FIPS/ATO/classification approval is implied. The existing query role must trust grafana.amazonaws.com for the account with appropriately scoped source ARN conditions and deployment PassRole permissions. The package adds read permissions and leaves existing role policies/trust intact. Output role_trust_example_json supplies a workspace-specific trust example after creation for owner review; it is not applied automatically.',
      '## Network\nInbound workspace access and outbound data-source networking are separate controls. The workspace always requires at least one allowed grafana-workspace interface endpoint or managed prefix list. Endpoint security groups/DNS/client routes remain prerequisites; a grafana API endpoint is not a workspace endpoint. Prefix lists must contain approved PUBLIC client source addresses; private ranges are ignored by this service, so private client addresses require the workspace interface endpoint. IPv6 lists/dual-stack are outside this recipe. Terraform rejects empty/global IPv4 lists but does not decide whether every public CIDR meets agency policy. Optional outbound VPC networking uses existing groups and private subnets in normal AZs with 15 free IPv4 addresses each and default tenancy. After enabling it, provide working routes/endpoints/DNS for every data source and alert destination; enabling it can break previously working data-source access.',
      '## Deploy and sign in\nRun terraform init, terraform validate and terraform plan -out=service.tfplan; review exact groups, current-account customer-managed role, version, inbound restrictions and optional outbound network, then apply the reviewed plan. Wait for workspace ACTIVE. Use IAM Identity Center sign-in as a member of the administrator group, verify editor/viewer membership and reject unassigned users and disallowed network sources. Group role associations grant workspace roles; existing identity lifecycle, MFA and assignments remain with the identity owner. Keep at least one working administrator group. SAML, organization-wide StackSets, Enterprise licensing and user creation are separate workflows.',
      '## Data-source setup\nCloudWatch permissions are metrics/alarms only, not Logs, X-Ray, EC2/tag discovery or write APIs. Where AWS metric APIs require wildcard resource scope, the policy states that scope explicitly. Prometheus permissions are scoped to the selected workspace; no broad workspace discovery is granted. After sign-in, create a short-lived, minimally privileged Grafana service-account token through the approved operator process and set GRAFANA_TOKEN only in the process environment. Preview python SETUP-DATASOURCES.py, then run it with --apply from an allowed network to configure the exported exact data-source UIDs. Existing UIDs are refused without --replace-existing. The script performs explicit sequential API writes with no automatic retries; inspect earlier successes if a later request fails. No token is generated or stored in Terraform state/files. Data-source permissions do not themselves create dashboards or ingest metrics.',
      '## Verify and recover\nCheck the AWS workspace status/version, Identity Center home instance, role associations, role trust and effective query policy. Test a known CloudWatch namespace/metric or AMP query through the configured data source and verify no unapproved namespace/data-source expansion or role assumption. Export dashboard JSON, alert rules and data-source definitions to the approved configuration repository, test recreation in an isolated workspace, and retain the old workspace until query/access/alert acceptance. Data-source configuration and dashboards are not automatically restored by Terraform. Rotate/revoke the setup token after use. prevent_destroy is a Terraform guard, not a service deletion lock. No cloud requests or Grafana writes occur during local generation.',
      'https://docs.aws.amazon.com/grafana/latest/userguide/AMG-configure-nac.html\nhttps://docs.aws.amazon.com/grafana/latest/userguide/AMG-configure-vpc.html\nhttps://docs.aws.amazon.com/grafana/latest/userguide/AMG-manage-permissions.html',
    ].join('\n\n') + '\n';
    const result = awsServiceModule(region, [
      blk('provider', { region: identityRegion, alias: 'identitycenter' }, [], ['aws']),
      dat('aws_caller_identity', 'current', {}), dat('aws_iam_role', 'query', { name: match?.[2]?.split('/').at(-1) ?? '' }),
      dat('aws_ssoadmin_instances', 'identity', { provider: x('aws.identitycenter') }),
      dat('aws_identitystore_group', 'selected', { provider: x('aws.identitycenter'), for_each: x('toset(' + JSON.stringify(groupIds) + ')'), identity_store_id: store, group_id: x('each.value') }),
      dat('aws_vpc_endpoint', 'allowed', { for_each: x('toset(' + JSON.stringify(endpoints) + ')'), id: x('each.value') }),
      dat('aws_ec2_managed_prefix_list', 'allowed', { for_each: x('toset(' + JSON.stringify(prefixes) + ')'), id: x('each.value') }),
      ...(outbound === 'YES' ? [
        dat('aws_subnet', 'selected', { for_each: x('toset(' + JSON.stringify(subnets) + ')'), id: x('each.value') }),
        dat('aws_security_group', 'outbound', { for_each: x('toset(' + JSON.stringify(groups) + ')'), id: x('each.value') }),
        dat('aws_vpc', 'selected', { id: x('data.aws_subnet.selected[' + JSON.stringify(subnets[0] ?? '') + '].vpc_id') }),
        dat('aws_availability_zones', 'normal', { state: 'available' }, [blk('filter', { name: 'zone-type', values: ['availability-zone'] })]),
      ] : []),
      res('aws_iam_role_policy', 'query', { name: name.replaceAll(' ', '-') + '-grafana-query', role: x('data.aws_iam_role.query.name'), policy: x(jsonencode({ Version: '2012-10-17', Statement: statements })) }),
      res('aws_grafana_workspace', 'configured', { name, grafana_version: version, account_access_type: 'CURRENT_ACCOUNT', permission_type: 'CUSTOMER_MANAGED', authentication_providers: ['AWS_SSO'], role_arn: role, data_sources: [...(cloudwatch === 'YES' ? ['CLOUDWATCH'] : []), ...(amp ? ['PROMETHEUS'] : [])], tags: x(hcl({ Name: name })), depends_on: x('[aws_iam_role_policy.query]') }, [
        blk('network_access_control', { prefix_list_ids: prefixes, vpce_ids: endpoints }),
        ...(outbound === 'YES' ? [blk('vpc_configuration', { subnet_ids: subnets, security_group_ids: groups })] : []),
        blk('lifecycle', { prevent_destroy: true }, [blk('precondition', { condition: x('data.aws_caller_identity.current.account_id == ' + JSON.stringify(account) + ' && data.aws_iam_role.query.arn == ' + JSON.stringify(role) + ' && contains(tolist(data.aws_ssoadmin_instances.identity.identity_store_ids), ' + JSON.stringify(store) + ') && length(data.aws_identitystore_group.selected) == ' + groupIds.length + ' && ' + networkCondition + (outbound === 'YES' ? ' && data.aws_vpc.selected.instance_tenancy == "default" && length(distinct([for subnet in data.aws_subnet.selected : subnet.vpc_id])) == 1 && length(distinct([for subnet in data.aws_subnet.selected : subnet.availability_zone])) >= 2 && alltrue([for subnet in data.aws_subnet.selected : subnet.available_ip_address_count >= 15 && contains(data.aws_availability_zones.normal.names, subnet.availability_zone)]) && alltrue([for group in data.aws_security_group.outbound : group.vpc_id == data.aws_vpc.selected.id])' : '')), error_message: 'Verify the account/query role, home-region Identity Center groups, restricted workspace network and outbound subnet/AZ/capacity settings.' })]),
      ]),
      ...([['ADMIN', admins], ['EDITOR', editors], ['VIEWER', viewers]] as const).filter(([, ids]) => ids.length).map(([roleName, ids]) => res('aws_grafana_role_association', roleName.toLowerCase(), { workspace_id: x('aws_grafana_workspace.configured.id'), role: roleName, group_ids: ids })),
      output('workspace_endpoint', 'aws_grafana_workspace.configured.endpoint'), output('workspace_id', 'aws_grafana_workspace.configured.id'),
      output('role_trust_example_json', 'jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "grafana.amazonaws.com" }, Action = "sts:AssumeRole", Condition = { StringEquals = { "aws:SourceAccount" = ' + JSON.stringify(account) + ' }, ArnEquals = { "aws:SourceArn" = aws_grafana_workspace.configured.arn } } }] })'),
    ], guide, findings);
    const sources = [
      ...(cloudwatch === 'YES' ? [{ uid: 'archtoolkit-cloudwatch', name: 'CloudWatch metrics', type: 'cloudwatch', access: 'proxy', jsonData: { authType: 'default', defaultRegion: region } }] : []),
      ...(amp ? [{ uid: 'archtoolkit-prometheus', name: 'Managed Prometheus', type: 'prometheus', access: 'proxy', url: 'https://aps-workspaces.' + region + (partition === 'aws-cn' ? '.amazonaws.com.cn' : '.amazonaws.com') + '/workspaces/' + (ampMatch?.[1] ?? ''), jsonData: { httpMethod: 'POST', sigV4Auth: true, sigV4AuthType: 'default', sigV4Region: region } }] : []),
    ];
    const preflight = [
      "$ErrorActionPreference = 'Stop'",
      "$raw = aws grafana list-versions --region '" + region + "' --output json",
      "if ($LASTEXITCODE -ne 0) { throw 'Could not read regional Grafana versions.' }",
      '$metadata = $raw | ConvertFrom-Json',
      "if ($metadata.grafanaVersions -notcontains '" + version + "') { throw 'Selected Grafana version is not available for a new workspace in this region.' }",
      "Write-Host 'Regional version is available. Terraform plan verifies identity and network metadata; no workspace has been created by this check.'",
    ].join('\n') + '\n';
    return { ...result, files: { ...result.files, 'PREFLIGHT.ps1': preflight, 'DATA-SOURCES.json': JSON.stringify(sources, null, 2) + '\n', 'SETUP-DATASOURCES.py': grafanaSetup } };
  },
} satisfies Blueprint;

const grafanaSetup = [
  'import argparse, json, os, pathlib, subprocess, urllib.error, urllib.request',
  'parser = argparse.ArgumentParser(description="Preview or explicitly configure the exported Grafana data sources")',
  'parser.add_argument("--apply", action="store_true")',
  'parser.add_argument("--replace-existing", action="store_true")',
  'args = parser.parse_args()',
  'sources = json.loads((pathlib.Path(__file__).resolve().parent / "DATA-SOURCES.json").read_text(encoding="utf-8"))',
  'if not args.apply:',
  '    print(json.dumps(sources, indent=2)); raise SystemExit(0)',
  'token = os.environ.get("GRAFANA_TOKEN")',
  'if not token: raise RuntimeError("Set a short-lived approved GRAFANA_TOKEN in the process environment")',
  'endpoint = subprocess.check_output(["terraform", "output", "-raw", "workspace_endpoint"], text=True).strip()',
  'if not endpoint or "/" in endpoint or ":" in endpoint or any(c.isspace() for c in endpoint): raise RuntimeError("Invalid workspace endpoint")',
  'class NoRedirect(urllib.request.HTTPRedirectHandler):',
  '    def redirect_request(self, req, fp, code, msg, headers, newurl): raise RuntimeError("Refusing authenticated redirect")',
  'opener = urllib.request.build_opener(NoRedirect())',
  'def request(method, path, payload=None):',
  '    data = None if payload is None else json.dumps(payload).encode("utf-8")',
  '    headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json"}',
  '    with opener.open(urllib.request.Request("https://" + endpoint + path, data=data, headers=headers, method=method), timeout=30) as response: return json.load(response)',
  'operations = []',
  'for source in sources:',
  '    path = "/api/datasources/uid/" + source["uid"]',
  '    try: request("GET", path)',
  '    except urllib.error.HTTPError as error:',
  '        if error.code != 404: raise',
  '        operations.append(("POST", "/api/datasources", source))',
  '    else:',
  '        if not args.replace_existing: raise RuntimeError("Data-source UID already exists: " + source["uid"])',
  '        operations.append(("PUT", path, source))',
  'for method, path, source in operations:',
  '    result = request(method, path, source)',
  '    print(source["uid"], result.get("message", "Request accepted"))',
  'print("Configuration requests completed. Test each data-source query and revoke the setup token after use.")',
].join('\n') + '\n';
