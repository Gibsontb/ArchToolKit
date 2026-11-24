import { error,              } from '../core/findings.js';
                                                     
import { blk, dat, e, hcl, jsonencode, output, res, x } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule, awsServiceRegion } from './aws-service-module.js';

export const AWS_DIRECTORY_SERVICE = {
  id: 'aws_service_directory', label: 'Set up AWS Managed Microsoft AD',
  description: 'Standard/Enterprise managed AD in two existing private subnet AZs, protected creation-time admin credentials, optional retained domain-controller logs and client join script.',
  emits: ['aws_directory_service_directory', 'aws_directory_service_log_subscription', 'aws_cloudwatch_log_group', 'aws_cloudwatch_log_resource_policy'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Directory label', control: 'text' },
    { id: 'domain', label: 'AD DNS domain', control: 'text', hint: 'New fully qualified domain name, e.g. ad.example.org. Check name ownership and conflicts with existing AD/DNS/private hosted zones.' },
    { id: 'short_name', label: 'AD NetBIOS name', control: 'text', hint: '1–15 letters/digits/hyphens; must not be all numeric or conflict with a trusted domain.' },
    { id: 'edition', label: 'Managed Microsoft AD edition', control: 'select', default: 'Standard', options: [{ value: 'Standard', label: 'Standard' }, { value: 'Enterprise', label: 'Enterprise' }] },
    { id: 'subnets', label: 'Existing private directory subnet IDs', control: 'text', hint: 'Exactly two comma-separated IDs in one VPC and different AZs. AWS initially creates two domain controllers.' },
    { id: 'logging', label: 'Domain controller security log forwarding', control: 'select', default: 'YES', options: [{ value: 'YES', label: 'Create retained CloudWatch log group and subscription' }, { value: 'NO', label: 'Configure separately' }] },
    { id: 'log_days', label: 'Security log retention (days)', control: 'select', default: '90', showWhen: { input: 'logging', equals: ['YES'] }, options: [7, 14, 30, 60, 90, 180, 365].map(value => ({ value: String(value), label: String(value) })) },
  ],
  build(values)                                      {
    const findings            = [];
    const reject = (path        , message        ) => findings.push(error('aws.directory.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), name = String(values.name ?? '').trim(), domain = String(values.domain ?? '').trim().toLowerCase(), shortName = String(values.short_name ?? '').trim().toUpperCase(), edition = String(values.edition ?? ''), logging = String(values.logging ?? ''), logDays = Number(values.log_days);
    const subnets = [...new Set(String(values.subnets ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,59}$/.test(name)) reject('name', 'Use a letter followed by up to 59 letters, digits, underscores or hyphens.');
    if (domain.length > 253 || !domain.includes('.') || domain.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) reject('domain', 'Use a valid fully qualified AD DNS domain without wildcards/empty labels.');
    if (!/^[A-Z0-9](?:[A-Z0-9-]{0,13}[A-Z0-9])?$/.test(shortName) || /^\d+$/.test(shortName)) reject('short_name', 'Use a nonnumeric NetBIOS name, 1–15 letters/digits with internal hyphens.');
    if (!['Standard', 'Enterprise'].includes(edition)) reject('edition', 'Select Standard or Enterprise Managed Microsoft AD.');
    if (subnets.length !== 2 || subnets.some(subnet => !/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(subnet))) reject('subnets', 'Use exactly two subnet IDs in one VPC across different AZs.');
    if (!['YES', 'NO'].includes(logging)) reject('logging', 'Choose security log forwarding.');
    if (logging === 'YES' && ![7, 14, 30, 60, 90, 180, 365].includes(logDays)) reject('log_days', 'Choose security log retention.');
    const result = awsServiceModule(region, [
      blk('variable', { type: x('string'), sensitive: true, nullable: false, description: 'Creation-time Admin password, supplied through approved secret injection. The provider retains it in Terraform state.' }, [blk('validation', { condition: x('length(var.directory_admin_password) >= 8 && length(var.directory_admin_password) <= 64 && can(regex("^[ -~]+$", var.directory_admin_password)) && !strcontains(lower(var.directory_admin_password), "admin") && length([for pattern in ["[A-Z]", "[a-z]", "[0-9]", "[^A-Za-z0-9[:space:]]"] : pattern if can(regex(pattern, var.directory_admin_password))]) >= 3'), error_message: 'Use 8–64 printable ASCII characters, no word admin, and at least three categories: uppercase, lowercase, digit, nonwhitespace special character.' })], ['directory_admin_password']),
      dat('aws_subnet', 'selected', { for_each: x('toset(' + JSON.stringify(subnets) + ')'), id: x('each.value') }),
      dat('aws_vpc', 'selected', { id: x('data.aws_subnet.selected[' + JSON.stringify(subnets[0] ?? '') + '].vpc_id') }),
      res('aws_directory_service_directory', 'configured', { name: domain, short_name: shortName, type: 'MicrosoftAD', edition, password: x('var.directory_admin_password'), enable_sso: false, tags: x(hcl({ Name: name })) }, [blk('vpc_settings', { vpc_id: x('data.aws_vpc.selected.id'), subnet_ids: subnets }), blk('lifecycle', { prevent_destroy: true }, [blk('precondition', { condition: x('length(distinct([for subnet in data.aws_subnet.selected : subnet.vpc_id])) == 1 && length(distinct([for subnet in data.aws_subnet.selected : subnet.availability_zone])) == 2 && data.aws_vpc.selected.enable_dns_support && data.aws_vpc.selected.enable_dns_hostnames'), error_message: 'Directory subnets must span two AZs in one VPC with DNS support and hostnames enabled.' })])]),
      ...(logging === 'YES' ? [
        res('aws_cloudwatch_log_group', 'directory', { name: '/aws/directoryservice/' + name, retention_in_days: logDays }),
        res('aws_cloudwatch_log_resource_policy', 'directory', { policy_name: name + '-directory-logs', policy_document: x(jsonencode({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'ds.amazonaws.com' }, Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Resource: e('"${aws_cloudwatch_log_group.directory.arn}:*"') }] })) }),
        res('aws_directory_service_log_subscription', 'configured', { directory_id: x('aws_directory_service_directory.configured.id'), log_group_name: x('aws_cloudwatch_log_group.directory.name'), depends_on: x('[aws_cloudwatch_log_resource_policy.directory]') }),
      ] : []),
      output('directory_id', 'aws_directory_service_directory.configured.id'), output('domain_name', 'aws_directory_service_directory.configured.name'), output('dns_server_ips', 'sort(tolist(aws_directory_service_directory.configured.dns_ip_addresses))'), output('directory_security_group_id', 'aws_directory_service_directory.configured.security_group_id'),
    ], `# AWS Managed Microsoft AD

## Prepare
Plan the new AD namespace, NetBIOS name, edition/object capacity, delegated administration and client DNS before creation. AWS Managed Microsoft AD is a managed AD forest; it does not import the existing forest, automatically migrate users or establish a trust. Use private routed subnets in different AZs with sufficient free addresses, VPC DNS support and hostnames. Review existing DNS/Resolver/private-zone namespace conflicts, directory quotas and ongoing two-controller costs. The service creates a directory security group; review its required AD/DNS/Kerberos/LDAP/RPC/time rules and surrounding NACL/client rules through the documented network baseline. This recipe does not enable SSO, additional DCs, hybrid/multi-region AD, trusts or directory sharing.

## Implement
Provide directory_admin_password through approved secret injection at deployment. The initial account is Admin. Sensitive marking hides normal output but the provider retains this password in state/plans; protect encrypted state, saved plans and operator access. Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review forest identity, edition, both subnet AZs and log permissions; apply the reviewed plan and wait for ACTIVE. Store/bootstrap the account through approved identity operations, create delegated groups/OUs and establish administration/credential recovery procedures. Do not treat changing this Terraform variable as ongoing user/password management; use supported AD/Directory Service procedures and review future plans for replacements.

Security log forwarding ${logging === 'YES' ? 'creates a group with explicit retention, a Directory Service principal policy scoped to that group, and a directory subscription. Check regional CloudWatch resource-policy quota before applying; coordinate with existing log-policy owners.' : 'is left for the approved existing logging workflow.'} Validate audit policy, events, access and retention against the applicable baseline; a log subscription alone does not establish compliance or authorization.

## Client setup
From an authorized domain-joined administration system, configure delegations/users/groups through supported AD tools. JOIN-WINDOWS.ps1 initially prints the output DNS addresses and planned domain only. Its explicit -ConfigureDns and -JoinDomain switches change the selected client: use an elevated Windows PowerShell session, provide -InterfaceAlias for DNS changes, and enter a delegated join credential in the secure prompt. Record previous DNS settings before changing them. The script does not restart Windows; schedule a restart and verify the secure channel afterward. Do not use domain-wide Admin for routine client joins. EC2 seamless join, Linux realm/SSSD and DHCP option-set changes need their corresponding workflows.

## Verify
Use aws ds describe-directories --directory-ids <output-id> --region ${region}; verify ACTIVE, edition, VPC/subnets and both DNS servers. Test name resolution and required connectivity to both controllers from each intended client subnet. After an approved test-client join/restart, inspect Test-ComputerSecureChannel, Kerberos sign-in, group policy and delegated permissions. Verify representative security events arrive at the configured log sink. If this directory will back FSx, select its directory ID in the separate FSx Windows setup and validate FSx administration groups and client trust.

## Recovery
Record/test supported directory snapshot and recovery procedures, delegated credential recovery and dependent-service restoration. Additional controllers and separate-AZ placement do not replace a recovery plan. Remove or migrate dependent FSx, joined clients, trusts and directory applications before deleting a directory; destruction is blocked by prevent_destroy until explicitly reviewed. Restore client DNS settings if a join is rolled back; a directory deletion is not an account/data migration rollback. Local generation/validation creates no directory, changes no client DNS and performs no domain join.

https://docs.aws.amazon.com/directoryservice/latest/admin-guide/ms_ad_getting_started.html
https://docs.aws.amazon.com/directoryservice/latest/admin-guide/ms_ad_enable_log_forwarding.html
`, findings);
    return { ...result, files: { ...result.files, 'JOIN-WINDOWS.ps1': `param([string]$InterfaceAlias, [switch]$ConfigureDns, [switch]$JoinDomain)
$ErrorActionPreference = 'Stop'
$domainName = terraform output -raw domain_name
if ($LASTEXITCODE -ne 0 -or -not $domainName) { throw 'Read the applied directory domain from this package state first.' }
$dnsJson = terraform output -json dns_server_ips
if ($LASTEXITCODE -ne 0) { throw 'Could not read directory DNS outputs.' }
$dnsServers = @($dnsJson | ConvertFrom-Json)
Write-Host ('Domain: ' + $domainName + '; DNS: ' + ($dnsServers -join ', '))
if ($ConfigureDns) {
  if (-not $InterfaceAlias) { throw 'Provide the exact client InterfaceAlias before changing DNS.' }
  Set-DnsClientServerAddress -InterfaceAlias $InterfaceAlias -ServerAddresses $dnsServers
}
if ($JoinDomain) {
  $joinCredential = Get-Credential -Message 'Delegated domain join credential; do not use routine domain-wide Admin access'
  Add-Computer -DomainName $domainName -Credential $joinCredential -PassThru
  Write-Host 'Domain join requested. Schedule a client restart and verify its secure channel.'
}
` } };
  },
}                    ;
