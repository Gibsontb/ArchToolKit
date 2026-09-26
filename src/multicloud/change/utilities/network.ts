/**
 * Network utilities (addendum A.9.2): open a port (a security rule, and the
 * guest's own firewall), add a DNS record, add a load-balancer member.
 *
 * The rules and records are Terraform in the landing zone: the security
 * group, NSG, network tag or OCI NSG of a `<network>/<tier>` key of the
 * landing-zone contract, the DNS zone and the load balancer found by name
 * (data sources), never a pasted id; NSX distributed firewall rules on VCF.
 * Windows DNS and the guests' firewalls are Ansible; Infoblox, F5 BIG-IP
 * and VMware Avi Load Balancer are their REST APIs, with the credentials
 * handed to curl on stdin (never an argument, never a file).
 */

import { familyOf } from '../../../core/ip.ts';
import type { BlueprintValues } from '../../../kit/blueprint.ts';
import { code } from '../../plan/execute/lib-sh.ts';
import type { DnsProvider, LbKind, Plan } from '../../plan/types.ts';
import {
  ALL_PLATFORMS, NETWORK_INPUTS, PLATFORM_LABELS, RG_INPUT, VSPHERE_INPUTS, ZONE_INPUT, ansibleProject, error, guestOs, info, instanceLookup,
  locationLocals, locationVars, numVal, on, opt, opts, osInput, platformInput, platformOf, playbook, safeName, serverInput, shq, tfId, tfRoot, val, warning, yq,
  type ChangeStep, type ChangeUtility, type Finding, type Platform, type TfVar, type UtilityResult,
} from './common.ts';
import { q } from '../../../terraform/blueprints/migration/common.ts';

// ---------------------------------------------------------------------------
// Shared: HTTP APIs with the credentials on curl's stdin
// ---------------------------------------------------------------------------

const HTTP_SH = code`http_quote() {
  local s="$1"
  s="$\{s//\\/\\\\}"
  s="$\{s//\"/\\\"}"
  printf '"%s"' "$s"
}
http_creds() {
  local user_var="$1" pass_var="$2"
  if [[ -z "$\{!user_var:-}" ]]; then change_stop 3 "$user_var is not set"; fi
  HTTP_USER="$\{!user_var}"
  atk_secret_to HTTP_PASS "$pass_var"
}
# http_config METHOD URL [BODY] [HEADER]: curl's config, with the credentials: it only ever goes to curl's stdin.
http_config() {
  printf 'silent\nshow-error\nfail\n'
  printf 'user = %s\n' "$(http_quote "$HTTP_USER:$HTTP_PASS")"
  printf 'url = %s\n' "$(http_quote "$2")"
  printf 'request = %s\n' "$(http_quote "$1")"
  if [[ -n "$\{CHANGE_CACERT:-}" ]]; then printf 'cacert = %s\n' "$(http_quote "$CHANGE_CACERT")"; fi
  if [[ -n "$\{4:-}" ]]; then printf 'header = %s\n' "$(http_quote "$4")"; fi
  if [[ -n "$\{3:-}" ]]; then
    printf 'header = "Content-Type: application/json"\n'
    printf 'data = %s\n' "$(http_quote "$3")"
  fi
}
http_get() { http_config GET "$1" "" "$\{2:-}" | curl --config -; }
http_send() {
  atk_log "$1 $2"
  http_config "$@" | atk_run curl --config -
}`;

/** The site CIDRs of `site:<name>` sources, from the plan's requirements. */
function expandSources(text: string, plan: Plan | undefined, findings: Finding[]): string[] {
  const out: string[] = [];
  for (const s of text.split(/[\s,]+/).filter(Boolean)) {
    if (s.startsWith('site:')) {
      const site = plan?.requirements.sites.find((x) => x.name === s.slice(5));
      if (site) out.push(...site.cidrs);
      else findings.push(warning('change.port.site', `No site ${s.slice(5)} in the plan's requirements.`, { path: 'from' }));
    } else if (familyOf(s.split('/')[0]!) === 4 || familyOf(s.split('/')[0]!) === 6) {
      out.push(s.includes('/') ? s : `${s}/${familyOf(s) === 6 ? 128 : 32}`);
    } else {
      findings.push(warning('change.port.source', `${s} is not a CIDR or site:<name>; left out.`, { path: 'from' }));
    }
  }
  return [...new Set(out)];
}

const v6 = (cidr: string): boolean => cidr.includes(':');

// ---------------------------------------------------------------------------
// Open a port / security rule
// ---------------------------------------------------------------------------

interface Rule { readonly sources: readonly string[]; readonly ports: readonly string[]; readonly protocol: 'tcp' | 'udp' | 'icmp'; readonly inbound: boolean; readonly name: string; readonly description: string }

const range = (p: string): [number, number] => {
  const [a = '0', b] = p.split('-');
  return [Number(a), Number(b ?? a)];
};

function ruleTf(platform: Platform, r: Rule, values: BlueprintValues): { main: string; vars: TfVar[]; providers?: ('nsxt')[] } {
  const blocks: string[] = [locationLocals(platform)];
  const vars = locationVars(platform, values);
  const ports = r.protocol === 'icmp' ? ['-1'] : r.ports;
  switch (platform) {
    case 'aws': {
      const type = r.inbound ? 'aws_vpc_security_group_ingress_rule' : 'aws_vpc_security_group_egress_rule';
      for (const cidr of r.sources) {
        for (const p of ports) {
          const [from, to] = r.protocol === 'icmp' ? [-1, -1] : range(p);
          blocks.push(`resource "${type}" "${tfId(`${cidr}_${p}`)}" {
  security_group_id = var.landing_zone.security_group_ids[local.sg_key]
  ${v6(cidr) ? 'cidr_ipv6' : 'cidr_ipv4'} = ${q(cidr)}
  ip_protocol       = ${q(r.protocol === 'icmp' && v6(cidr) ? 'icmpv6' : r.protocol)}
  from_port         = ${from}
  to_port           = ${to}
  description       = ${q(r.description)}
  tags = {
    Name = ${q(r.name)}
  }
}`);
        }
      }
      break;
    }
    case 'azure': {
      vars.push({ name: 'priority', type: 'number', description: 'The first rule\'s priority (100-4096); the next rules take the next numbers.', value: numVal(values, 'priority', 2000) });
      const proto = r.protocol === 'tcp' ? 'Tcp' : r.protocol === 'udp' ? 'Udp' : 'Icmp';
      const fams = [r.sources.filter((c) => !v6(c)), r.sources.filter(v6)].filter((l) => l.length);
      fams.forEach((cidrs, i) => {
        const other = r.inbound ? 'destination_address_prefix = "*"' : 'source_address_prefix      = "*"';
        blocks.push(`resource "azurerm_network_security_rule" "${i === 0 && !v6(cidrs[0]!) ? 'ipv4' : 'ipv6'}" {
  name                        = ${q(`${r.name}${v6(cidrs[0]!) ? '-v6' : ''}`)}
  priority                    = var.priority + ${i}
  direction                   = ${q(r.inbound ? 'Inbound' : 'Outbound')}
  access                      = "Allow"
  protocol                    = ${q(proto)}
  source_port_range           = "*"
  ${r.protocol === 'icmp' ? 'destination_port_range      = "*"' : `destination_port_ranges     = [${ports.map(q).join(', ')}]`}
  ${r.inbound ? 'source_address_prefixes' : 'destination_address_prefixes'} = [${cidrs.map(q).join(', ')}]
  ${other}
  description                 = ${q(r.description)}
  resource_group_name         = split("/", var.landing_zone.security_group_ids[local.sg_key])[4]
  network_security_group_name = split("/", var.landing_zone.security_group_ids[local.sg_key])[8]
}`);
      });
      break;
    }
    case 'google': {
      const fams = [r.sources.filter((c) => !v6(c)), r.sources.filter(v6)].filter((l) => l.length);
      for (const cidrs of fams) {
        const six = v6(cidrs[0]!);
        const proto = r.protocol === 'icmp' ? (six ? '58' : 'icmp') : r.protocol;
        blocks.push(`resource "google_compute_firewall" "${six ? 'ipv6' : 'ipv4'}" {
  name        = ${q(`${r.name}${six ? '-v6' : ''}`.slice(0, 63))}
  network     = var.landing_zone.network_names[var.network]
  direction   = ${q(r.inbound ? 'INGRESS' : 'EGRESS')}
  priority    = 1000
  description = ${q(r.description)}
  ${r.inbound ? 'source_ranges' : 'destination_ranges'} = [${cidrs.map(q).join(', ')}]
  target_tags = [var.landing_zone.security_group_ids[local.sg_key]]
  allow {
    protocol = ${q(proto)}
${r.protocol === 'icmp' ? '' : `    ports    = [${ports.map(q).join(', ')}]\n`}  }
  log_config {
    metadata = "INCLUDE_ALL_METADATA"
  }
}`);
      }
      break;
    }
    case 'oci': {
      for (const cidr of r.sources) {
        for (const p of ports) {
          const proto = r.protocol === 'tcp' ? '6' : r.protocol === 'udp' ? '17' : v6(cidr) ? '58' : '1';
          const [from, to] = range(p);
          const opt = r.protocol === 'icmp' ? '' : `\n  ${r.protocol}_options {\n    destination_port_range {\n      min = ${from}\n      max = ${to}\n    }\n  }`;
          blocks.push(`resource "oci_core_network_security_group_security_rule" "${tfId(`${cidr}_${p}`)}" {
  network_security_group_id = var.landing_zone.security_group_ids[local.sg_key]
  direction                 = ${q(r.inbound ? 'INGRESS' : 'EGRESS')}
  protocol                  = ${q(proto)}
  ${r.inbound ? 'source      ' : 'destination'}               = ${q(cidr)}
  ${r.inbound ? 'source_type     ' : 'destination_type'}          = "CIDR_BLOCK"
  stateless                 = false
  description               = ${q(r.description)}${opt}
}`);
        }
      }
      break;
    }
    default: {
      vars.length = 0;
      vars.push({ name: 'nsx_manager', type: 'string', description: 'The NSX Manager (the workload domain\'s NSX instance).', value: val(values, 'nsx_manager', 'wld01-nsx01.corp.example.com') });
      const to = val(values, 'to', 'shop');
      const svc = r.protocol === 'icmp'
        ? '  icmp_entry {\n    display_name = "icmp"\n    protocol     = "ICMPv4"\n  }\n  icmp_entry {\n    display_name = "icmpv6"\n    protocol     = "ICMPv6"\n  }'
        : `  l4_port_set_entry {\n    display_name      = ${q(`${r.protocol}-${ports.join('-')}`)}\n    protocol          = ${q(r.protocol.toUpperCase())}\n    destination_ports = [${ports.map(q).join(', ')}]\n  }`;
      const [src, dst] = r.inbound ? ['nsxt_policy_group.peers.path', 'nsxt_policy_group.target.path'] : ['nsxt_policy_group.target.path', 'nsxt_policy_group.peers.path'];
      blocks.length = 0;
      blocks.push(`resource "nsxt_policy_group" "peers" {
  display_name = ${q(`${r.name}-peers`)}
  description  = ${q(r.description)}
  criteria {
    ipaddress_expression {
      ip_addresses = [${r.sources.map(q).join(', ')}]
    }
  }
}

resource "nsxt_policy_group" "target" {
  display_name = ${q(`${r.name}-target`)}
  description  = "The VMs tagged atk_app with the target's name."
  criteria {
    condition {
      key         = "Tag"
      member_type = "VirtualMachine"
      operator    = "EQUALS"
      value       = ${q(`atk_app|${to}`)}
    }
  }
}

resource "nsxt_policy_service" "ports" {
  display_name = ${q(`${r.name}-service`)}
${svc}
}

resource "nsxt_policy_security_policy" "rule" {
  display_name = ${q(r.name)}
  description  = ${q(r.description)}
  category     = "Application"
  locked       = false
  stateful     = true
  rule {
    display_name       = ${q(r.name)}
    source_groups      = [${src}]
    destination_groups = [${dst}]
    services           = [nsxt_policy_service.ports.path]
    action             = "ALLOW"
    ip_version         = "IPV4_IPV6"
    logged             = true
  }
}`);
      return { main: blocks.join('\n\n'), vars, providers: ['nsxt'] };
    }
  }
  return { main: blocks.join('\n\n'), vars };
}

function osFirewall(windows: boolean, r: Rule): { open: string; close: string } {
  const name = r.name;
  if (windows) {
    const script = (present: boolean): string => `    - name: ${present ? 'Add' : 'Remove'} the Windows Firewall rule ${name}
      ansible.windows.win_powershell:
        parameters:
          Name: "{{ change_rule }}"
          Protocol: "{{ change_protocol }}"
          Ports: "{{ change_ports }}"
          Sources: "{{ change_sources }}"
        script: |
          param([string] $Name, [string] $Protocol, [string] $Ports, [string] $Sources)
          $Ansible.Changed = $false
          $have = Get-NetFirewallRule -DisplayName $Name -ErrorAction SilentlyContinue
${present
    ? `          if ($have) { return }
          New-NetFirewallRule -DisplayName $Name -Direction Inbound -Action Allow -Protocol $Protocol -LocalPort ($Ports -split ',') -RemoteAddress ($Sources -split ',') | Out-Null
          $Ansible.Changed = $true`
    : `          if (-not $have) { return }
          Remove-NetFirewallRule -DisplayName $Name
          $Ansible.Changed = $true`}
`;
    const vars = `    change_rule: ${yq(name)}
    change_protocol: ${r.protocol.toUpperCase()}
    change_ports: ${yq(r.ports.join(','))}
    change_sources: ${yq(r.sources.join(','))}`;
    return {
      open: playbook(`Open ${r.protocol} ${r.ports.join(' ')} in Windows Firewall`, 'atk_change_windows', script(true), { vars }),
      close: playbook(`Close ${r.protocol} ${r.ports.join(' ')} in Windows Firewall`, 'atk_change_windows', script(false), { vars }),
    };
  }
  const tasks = (present: boolean): string => `    - name: Read the services
      ansible.builtin.service_facts:

    - name: ${present ? 'Allow' : 'Remove'} the rule in firewalld
      ansible.posix.firewalld:
        rich_rule: >-
          rule family="{{ 'ipv6' if ':' in item.0 else 'ipv4' }}" source address="{{ item.0 }}"
          port port="{{ item.1 }}" protocol="{{ change_protocol }}" accept
        permanent: true
        immediate: true
        state: ${present ? 'enabled' : 'disabled'}
      loop: "{{ change_sources | product(change_ports) | list }}"
      when: "'firewalld.service' in ansible_facts.services and ansible_facts.services['firewalld.service'].state == 'running'"

    - name: ${present ? 'Allow' : 'Remove'} the rule in ufw
      community.general.ufw:
        rule: allow
        direction: in
        from_ip: "{{ item.0 }}"
        to_port: "{{ item.1 | replace('-', ':') }}"
        proto: "{{ change_protocol }}"
${present ? '' : '        delete: true\n'}      loop: "{{ change_sources | product(change_ports) | list }}"
      when: "'ufw.service' in ansible_facts.services and ansible_facts.services['ufw.service'].state == 'running'"
`;
  const vars = `    change_protocol: ${r.protocol}
    change_ports:
${r.ports.map((p) => `      - ${yq(p)}`).join('\n')}
    change_sources:
${r.sources.map((s) => `      - ${yq(s)}`).join('\n')}`;
  return {
    open: playbook(`Open ${r.protocol} ${r.ports.join(' ')} in the host firewall`, 'atk_change_linux', tasks(true), { become: true, vars }),
    close: playbook(`Close ${r.protocol} ${r.ports.join(' ')} in the host firewall`, 'atk_change_linux', tasks(false), { become: true, vars }),
  };
}

export const openPort: ChangeUtility = {
  id: 'open-port',
  label: 'Open a port / security rule',
  category: 'network',
  description: 'A rule on the tier\'s security group (AWS security group rule, Azure NSG rule, Google Cloud firewall rule on the tier\'s network tag, OCI NSG rule) or an NSX distributed firewall policy on VCF, one rule per address family; and the same ports in the guest firewall (firewalld or ufw, Windows Firewall). An expiry date adds expire.sh, which rolls it back on the day.',
  platforms: ALL_PLATFORMS,
  risk: 'medium',
  reversible: true,
  rollback: 'Removes the rule (terraform destroy) and closes the ports in the guest firewall.',
  source: 'A.9.2',
  inputs: [
    platformInput(ALL_PLATFORMS),
    { id: 'from', label: 'From', control: 'text', default: '10.20.0.0/16 fd00:20::/48', hint: 'CIDRs of either family, or site:<name> for a site\'s ranges from the plan.' },
    { id: 'to', label: 'To (app or server)', control: 'combo', default: 'shop', from: 'app', hint: 'The app (VCF: its atk_app tag) or the server whose guest firewall opens.' },
    { id: 'ports', label: 'Ports', control: 'text', default: '443', hint: 'Space-separated; a range as 8000-8100.' },
    { id: 'protocol', label: 'Protocol', control: 'select', default: 'tcp', options: [opt('tcp', 'TCP'), opt('udp', 'UDP'), opt('icmp', 'ICMP')] },
    { id: 'direction', label: 'Direction', control: 'select', default: 'inbound', options: [opt('inbound', 'Inbound'), opt('outbound', 'Outbound')] },
    { id: 'priority', label: 'Priority', control: 'number', default: 2000, min: 100, max: 4096, ...on('azure') },
    { id: 'nsx_manager', label: 'NSX Manager', control: 'text', default: 'wld01-nsx01.corp.example.com', ...on('vmware') },
    { id: 'guest', label: 'Guest firewall', control: 'select', default: 'no', options: [opt('no', 'Leave it'), opt('yes', 'Open it on the servers too')] },
    { id: 'servers', label: 'Servers (guest firewall)', control: 'text', default: '', from: 'server', hint: 'Space-separated.', showWhen: { input: 'guest', equals: ['yes'] } },
    osInput(),
    { id: 'expires', label: 'Expires', control: 'text', default: '', placeholder: 'YYYY-MM-DD', hint: 'Optional: expire.sh rolls the rule back on this day.' },
    ...NETWORK_INPUTS,
  ],
  build(values, ctx): UtilityResult {
    const platform = platformOf(values, openPort);
    const findings: Finding[] = [];
    const sources = expandSources(val(values, 'from', '10.20.0.0/16'), ctx.plan, findings);
    if (!sources.length) findings.push(error('change.port.no-source', 'No source addresses: give CIDRs or site:<name>.', { path: 'from' }));
    const protocol = (val(values, 'protocol', 'tcp') as Rule['protocol']);
    const ports = val(values, 'ports', '443').split(/[\s,]+/).filter((p) => /^\d+(-\d+)?$/.test(p));
    if (!ports.length && protocol !== 'icmp') findings.push(error('change.port.no-port', 'No valid ports.', { path: 'ports' }));
    const inbound = val(values, 'direction', 'inbound') === 'inbound';
    const to = val(values, 'to', 'shop');
    const name = safeName(`atk-${to}-${protocol}-${ports.join('-') || 'icmp'}-${inbound ? 'in' : 'out'}`, 60);
    if (sources.some((s) => /\/0$/.test(s))) findings.push(warning('change.port.any', `The rule opens ${ports.join(' ')} to the whole internet (a /0 source).`, { path: 'from' }));
    if (!sources.some(v6) && platform !== 'vmware') findings.push(info('change.port.ipv4-only', 'Only IPv4 sources: add the IPv6 ranges too on a dual-stack network.', { path: 'from' }));
    const rule: Rule = { sources, ports: ports.length ? ports : ['0'], protocol, inbound, name, description: `Opened by change utility open-port for ${to}` };
    const tf = ruleTf(platform, rule, values);
    const files: Record<string, string> = tfRoot({
      platform, header: `${inbound ? 'Inbound' : 'Outbound'} ${protocol} ${ports.join(' ')} for ${to}, from ${sources.join(' ')}.`, main: tf.main, variables: tf.vars,
      ...(tf.providers ? { vmwareProviders: tf.providers } : {}),
    });
    const apply: ChangeStep[] = [{ kind: 'terraform', title: 'Add the security rule', dir: 'terraform', lz: platform !== 'vmware' }];
    const rollback: ChangeStep[] = [{ kind: 'terraform-destroy', title: 'Remove the security rule', dir: 'terraform', lz: platform !== 'vmware' }];
    if (val(values, 'guest', 'no') === 'yes' && inbound && protocol !== 'icmp') {
      const servers = val(values, 'servers', '').split(/\s+/).filter(Boolean);
      if (!servers.length) findings.push(warning('change.port.no-servers', 'Guest firewall chosen but no servers named.', { path: 'servers' }));
      const windows = servers.length > 0 && guestOs(ctx.plan, servers[0]!, values) === 'windows';
      const fw = osFirewall(windows, rule);
      Object.assign(files, ansibleProject(servers.map((s) => ({ name: s, windows: guestOs(ctx.plan, s, values) === 'windows' })), { 'open.yml': fw.open, 'close.yml': fw.close }, windows ? ['ansible.windows'] : ['ansible.posix', 'community.general']));
      apply.push({ kind: 'ansible', title: 'Open the ports in the guest firewall', playbook: 'open.yml' });
      rollback.unshift({ kind: 'ansible', title: 'Close the ports in the guest firewall', playbook: 'close.yml' });
    }
    const expires = val(values, 'expires');
    if (expires && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) findings.push(error('change.port.expiry', 'The expiry is a date, YYYY-MM-DD.', { path: 'expires' }));
    return {
      platform, target: to, route: 'mixed', summary: `Open ${protocol} ${ports.join(' ')} ${inbound ? 'to' : 'from'} ${to} ${inbound ? 'from' : 'to'} ${sources.join(' ')} on ${PLATFORM_LABELS[platform]}${expires ? `, until ${expires}` : ''}`,
      files, findings, apply, rollback, needs: [],
      ...(expires && /^\d{4}-\d{2}-\d{2}$/.test(expires) ? { expires } : {}),
    };
  },
};

// ---------------------------------------------------------------------------
// Add a DNS record
// ---------------------------------------------------------------------------

const DEFAULT_PROVIDER: Readonly<Record<Platform, DnsProvider>> = { aws: 'route53', azure: 'azure-dns', google: 'cloud-dns', oci: 'oci-dns', vmware: 'windows-dns' };
const PROVIDER_PLATFORM: Readonly<Record<DnsProvider, Platform>> = {
  route53: 'aws', 'azure-dns': 'azure', 'azure-private-dns': 'azure', 'cloud-dns': 'google', 'oci-dns': 'oci', 'windows-dns': 'vmware', infoblox: 'vmware',
};
const PROVIDER_LABELS: Readonly<Record<DnsProvider, string>> = {
  route53: 'Amazon Route 53', 'azure-dns': 'Azure DNS', 'azure-private-dns': 'Azure Private DNS', 'cloud-dns': 'Cloud DNS (Google Cloud (GCP))', 'oci-dns': 'OCI DNS', 'windows-dns': 'Windows DNS (a domain controller)', infoblox: 'Infoblox (WAPI)',
};
const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'SRV'] as const;

function dnsTf(provider: DnsProvider, fqdn: string, name: string, zone: string, type: string, records: readonly string[], ttl: number, values: BlueprintValues): { main: string; vars: TfVar[] } {
  const platform = PROVIDER_PLATFORM[provider];
  const vars: TfVar[] = [];
  const list = `[${records.map(q).join(', ')}]`;
  switch (provider) {
    case 'route53':
      return {
        vars,
        main: `data "aws_route53_zone" "zone" {
  name         = ${q(zone)}
  private_zone = ${val(values, 'private', 'no') === 'yes'}
}

resource "aws_route53_record" "record" {
  zone_id = data.aws_route53_zone.zone.zone_id
  name    = ${q(fqdn)}
  type    = ${q(type)}
  ttl     = ${ttl}
  records = ${list}
}`,
      };
    case 'azure-dns':
    case 'azure-private-dns': {
      vars.push({ name: 'dns_resource_group', type: 'string', description: 'The DNS zone\'s resource group; blank: the landing zone\'s shared one.', value: val(values, 'dns_resource_group') });
      const p = provider === 'azure-dns' ? 'azurerm_dns' : 'azurerm_private_dns';
      const t = type.toLowerCase();
      const body = type === 'A' || type === 'AAAA' ? `  records             = ${list}`
        : type === 'CNAME' ? `  record              = ${q(records[0] ?? '')}`
        : type === 'TXT' ? records.map((r) => `  record {\n    value = ${q(r)}\n  }`).join('\n')
        : records.map((r) => {
          const [priority = '0', weight = '0', port = '0', target = ''] = r.split(/\s+/);
          return `  record {\n    priority = ${Number(priority)}\n    weight   = ${Number(weight)}\n    port     = ${Number(port)}\n    target   = ${q(target)}\n  }`;
        }).join('\n');
      return {
        vars,
        main: `locals {
  dns_rg = var.dns_resource_group != "" ? var.dns_resource_group : var.landing_zone.resource_group["shared"]
}

data "${p}_zone" "zone" {
  name                = ${q(zone)}
  resource_group_name = local.dns_rg
}

resource "${p}_${t}_record" "record" {
  name                = ${q(name || '@')}
  zone_name           = data.${p}_zone.zone.name
  resource_group_name = local.dns_rg
  ttl                 = ${ttl}
${body}
}`,
      };
    }
    case 'cloud-dns': {
      const rr = records.map((r) => (type === 'TXT' ? `"\\"${r.replace(/"/g, '')}\\""` : q(type === 'CNAME' && !r.endsWith('.') ? `${r}.` : r)));
      return {
        vars,
        main: `data "google_dns_managed_zone" "zone" {
  name = ${q(val(values, 'managed_zone') || zone.replace(/\.$/, '').replace(/\./g, '-'))}
}

resource "google_dns_record_set" "record" {
  managed_zone = data.google_dns_managed_zone.zone.name
  name         = ${q(`${fqdn}.`)}
  type         = ${q(type)}
  ttl          = ${ttl}
  rrdatas      = [${rr.join(', ')}]
}`,
      };
    }
    default: {
      const view = val(values, 'view_id');
      vars.push({ name: 'view_id', type: 'string', description: 'The private view the zone is in (a private zone); blank for a public zone.', value: view });
      return {
        vars,
        main: `resource "oci_dns_rrset" "record" {
  zone_name_or_id = ${q(zone)}
  domain          = ${q(fqdn)}
  rtype           = ${q(type)}
  compartment_id  = var.landing_zone.compartment_id
  view_id         = var.view_id != "" ? var.view_id : null
  scope           = var.view_id != "" ? "PRIVATE" : null
${records.map((r) => `  items {\n    domain = ${q(fqdn)}\n    rdata  = ${q(r)}\n    rtype  = ${q(type)}\n    ttl    = ${ttl}\n  }`).join('\n')}
}`,
      };
    }
  }
  void platform;
}

function windowsDns(zone: string, name: string, type: string, records: readonly string[], ttl: number, present: boolean): string {
  return playbook(`${present ? 'Add' : 'Remove'} ${type} ${name}.${zone} in Windows DNS`, 'atk_change_windows', `    - name: ${present ? 'Add' : 'Remove'} the record on the DNS server
      ansible.windows.win_dns_record:
        zone: "{{ change_zone }}"
        name: "{{ change_name }}"
        type: "{{ change_type }}"
${present ? `        value: "{{ change_values }}"\n        ttl: "{{ change_ttl }}"\n` : ''}        state: ${present ? 'present' : 'absent'}
`, {
    facts: false,
    vars: `    change_zone: ${yq(zone)}
    change_name: ${yq(name || '@')}
    change_type: ${type}
    change_ttl: ${ttl}
    change_values:
${records.map((r) => `      - ${yq(r)}`).join('\n')}`,
  });
}

/** Infoblox WAPI: the record's object type and its value field. */
const WAPI: Readonly<Record<string, [string, string]>> = { A: ['record:a', 'ipv4addr'], AAAA: ['record:aaaa', 'ipv6addr'], CNAME: ['record:cname', 'canonical'], TXT: ['record:txt', 'text'] };

function infobloxSh(fqdn: string, type: string, records: readonly string[], ttl: number, view: string, present: boolean): string {
  const [obj, field] = WAPI[type] ?? ['record:a', 'ipv4addr'];
  const lines = records.map((r) => code`record=${shq(r)}
ref="$(http_get "$WAPI/${obj}?name=${encodeURIComponent(fqdn)}&${field}=$(jq -rn --arg v "$record" '$v|@uri')&view=${encodeURIComponent(view)}" | jq -r '.[0]._ref // empty')"
${present
    ? code`if [[ -n "$ref" ]]; then atk_log "${fqdn} ${type} $record is there already"; else
  http_send POST "$WAPI/${obj}" "$(jq -nc --arg n ${shq(fqdn)} --arg v "$record" --arg view ${shq(view)} --argjson ttl ${ttl} '{name: $n, ${field}: $v, view: $view, ttl: $ttl, use_ttl: true}')"
fi`
    : code`if [[ -z "$ref" ]]; then atk_log "${fqdn} ${type} $record is gone already"; else http_send DELETE "$WAPI/$ref"; fi`}`);
  return `${HTTP_SH}\nif [[ -z "\${INFOBLOX_HOST:-}" ]]; then change_stop 3 "INFOBLOX_HOST is not set"; fi\nhttp_creds INFOBLOX_USER INFOBLOX_PASSWORD\nWAPI="https://$INFOBLOX_HOST/wapi/\${INFOBLOX_WAPI_VERSION:-v2.12}"\n${lines.join('\n')}`;
}

export const dnsRecord: ChangeUtility = {
  id: 'dns-record',
  label: 'Add a DNS record',
  category: 'network',
  description: 'A record in the zone\'s own DNS: Route 53, Azure DNS or Azure Private DNS, Cloud DNS or OCI DNS in Terraform (the zone found by name); Windows DNS through a domain controller (win_dns_record); Infoblox through its WAPI.',
  platforms: ALL_PLATFORMS,
  risk: 'low',
  reversible: true,
  rollback: 'Deletes the record (terraform destroy, state absent, or a WAPI DELETE).',
  source: 'A.9.2',
  inputs: [
    platformInput(ALL_PLATFORMS),
    { id: 'provider', label: 'DNS', control: 'select', default: '', blankLabel: 'The platform\'s own DNS (VCF: Windows DNS)', options: (Object.keys(PROVIDER_LABELS) as DnsProvider[]).map((p) => opt(p, PROVIDER_LABELS[p])) },
    { id: 'zone', label: 'Zone', control: 'combo', default: 'corp.example.com', from: 'dns-zone' },
    { id: 'name', label: 'Name', control: 'text', default: 'shop', hint: 'Relative to the zone; @ for the zone apex.' },
    { id: 'type', label: 'Type', control: 'select', default: 'A', options: opts(RECORD_TYPES) },
    { id: 'value', label: 'Value', control: 'text', default: '10.40.10.21', hint: 'Space-separated for several; SRV: "priority weight port target" separated by commas.' },
    { id: 'ttl', label: 'TTL (seconds)', control: 'number', default: 300, min: 30, max: 86400 },
    { id: 'private', label: 'Private zone', control: 'select', default: 'no', options: [opt('no', 'No'), opt('yes', 'Yes')], ...on('aws') },
    { id: 'dns_resource_group', label: 'Zone resource group', control: 'text', default: '', ...on('azure') },
    { id: 'managed_zone', label: 'Managed zone name', control: 'text', default: '', hint: 'Blank: the zone with dots as hyphens.', ...on('google') },
    { id: 'view_id', label: 'Private view OCID', control: 'text', default: '', ...on('oci') },
    { id: 'dns_server', label: 'DNS server (Windows DNS)', control: 'text', default: 'dc01.corp.example.com', showWhen: { input: 'provider', equals: ['windows-dns', ''] } },
    { id: 'infoblox_view', label: 'Infoblox view', control: 'text', default: 'default', showWhen: { input: 'provider', equals: ['infoblox'] } },
  ],
  build(values): UtilityResult {
    let platform = platformOf(values, dnsRecord);
    const findings: Finding[] = [];
    const provider = (val(values, 'provider') || DEFAULT_PROVIDER[platform]) as DnsProvider;
    const own = PROVIDER_PLATFORM[provider];
    if (own !== 'vmware' && own !== platform) {
      findings.push(info('change.dns.platform', `${PROVIDER_LABELS[provider]} is ${PLATFORM_LABELS[own]}'s: the record is made there.`));
      platform = own;
    }
    const zone = val(values, 'zone', 'corp.example.com').replace(/\.$/, '');
    const name = val(values, 'name', 'shop').replace(/^@$/, '');
    const fqdn = name ? `${name}.${zone}` : zone;
    const type = val(values, 'type', 'A');
    const ttl = numVal(values, 'ttl', 300);
    const records = type === 'SRV' ? val(values, 'value').split(',').map((s) => s.trim()).filter(Boolean) : type === 'TXT' ? [val(values, 'value')] : val(values, 'value').split(/\s+/).filter(Boolean);
    if (!records.length) findings.push(error('change.dns.value', 'The record needs a value.', { path: 'value' }));
    for (const r of type === 'A' || type === 'AAAA' ? records : []) {
      if (familyOf(r) !== (type === 'A' ? 4 : 6)) findings.push(error('change.dns.family', `${r} is not an IPv${type === 'A' ? 4 : 6} address.`, { path: 'value' }));
    }
    if (type === 'CNAME' && records.length > 1) findings.push(error('change.dns.cname', 'A CNAME has one value.', { path: 'value' }));
    if (type === 'A') findings.push(info('change.dns.aaaa', 'On a dual-stack network, add the AAAA record for the name too.'));
    const summary = `Add ${type} ${fqdn} → ${records.join(', ')} in ${PROVIDER_LABELS[provider]}`;
    if (provider === 'windows-dns') {
      const server = val(values, 'dns_server', 'dc01.corp.example.com');
      const files = ansibleProject([{ name: server, windows: true }], { 'record.yml': windowsDns(zone, name, type, records, ttl, true), 'remove.yml': windowsDns(zone, name, type, records, ttl, false) }, ['ansible.windows']);
      return {
        platform, target: fqdn, route: 'ansible', summary, files, findings,
        apply: [{ kind: 'ansible', title: `Add ${type} ${fqdn} on ${server}`, playbook: 'record.yml' }],
        rollback: [{ kind: 'ansible', title: `Remove ${type} ${fqdn} from ${server}`, playbook: 'remove.yml' }],
        needs: [],
      };
    }
    if (provider === 'infoblox') {
      if (type === 'SRV') findings.push(error('change.dns.infoblox-srv', 'SRV records through Infoblox are not generated here; add them in Grid Manager.', { path: 'type' }));
      const view = val(values, 'infoblox_view', 'default');
      return {
        platform, target: fqdn, route: 'cli', summary, files: {}, findings,
        apply: [{ kind: 'sh', title: `Add ${type} ${fqdn} in Infoblox`, body: infobloxSh(fqdn, type, records, ttl, view, true) }],
        rollback: [{ kind: 'sh', title: `Delete ${type} ${fqdn} from Infoblox`, body: infobloxSh(fqdn, type, records, ttl, view, false) }],
        needs: ['curl', 'jq'],
        notes: ['Infoblox: INFOBLOX_HOST and INFOBLOX_USER in the environment; the password from INFOBLOX_PASSWORD, INFOBLOX_PASSWORD_FILE (mode 600) or ATK_VAULT_CMD. CHANGE_CACERT names the CA bundle to trust. WAPI version: INFOBLOX_WAPI_VERSION (default v2.12, unverified for your Grid).'],
      };
    }
    const tf = dnsTf(provider, fqdn, name, zone, type, records, ttl, values);
    return {
      platform, target: fqdn, route: 'terraform', summary, findings,
      files: tfRoot({ platform, header: summary, main: tf.main, variables: tf.vars }),
      apply: [{ kind: 'terraform', title: `Add ${type} ${fqdn}`, dir: 'terraform', lz: true }],
      rollback: [{ kind: 'terraform-destroy', title: `Delete ${type} ${fqdn}`, dir: 'terraform', lz: true }],
      needs: [],
    };
  },
};

// ---------------------------------------------------------------------------
// Add a load-balancer member
// ---------------------------------------------------------------------------

const LB_OF: Readonly<Record<Platform, Exclude<LbKind, 'none'>>> = { aws: 'aws-elbv2', azure: 'azure-lb', google: 'gcp-neg', oci: 'oci-lb', vmware: 'avi' };

function lbTf(platform: Platform, values: BlueprintValues, port: number, weight: number): { main: string; vars: TfVar[] } {
  const t = instanceLookup(platform);
  const vars: TfVar[] = [
    ...locationVars(platform, values),
    { name: 'server', type: 'string', description: 'The member server (found by name).', value: val(values, 'server', 'web01') },
    { name: 'pool', type: 'string', description: 'The target group / backend pool / NEG / backend set.', value: val(values, 'pool', 'shop-web') },
    { name: 'port', type: 'number', description: 'The member port.', value: port },
  ];
  const head = `${locationLocals(platform)}\n\n${t.hcl}`;
  switch (platform) {
    case 'aws':
      return { vars, main: `${head}

data "aws_lb_target_group" "pool" {
  name = var.pool
}

resource "aws_lb_target_group_attachment" "member" {
  target_group_arn = data.aws_lb_target_group.pool.arn
  target_id        = ${t.id}
  port             = var.port
}` };
    case 'azure':
      vars.push({ name: 'lb', type: 'string', description: 'The load balancer.', value: val(values, 'lb', 'shop-lb') });
      return { vars, main: `${head}

data "azurerm_lb" "lb" {
  name                = var.lb
  resource_group_name = local.rg
}

data "azurerm_lb_backend_address_pool" "pool" {
  name            = var.pool
  loadbalancer_id = data.azurerm_lb.lb.id
}

resource "azurerm_lb_backend_address_pool_address" "member" {
  name                    = var.server
  backend_address_pool_id = data.azurerm_lb_backend_address_pool.pool.id
  virtual_network_id      = var.landing_zone.network_ids[var.network]
  ip_address              = ${t.ref}.private_ip_address
}` };
    case 'google':
      return { vars, main: `${head}

resource "google_compute_network_endpoint" "member" {
  network_endpoint_group = var.pool
  zone                   = local.zone
  instance               = ${t.ref}.name
  ip_address             = ${t.ref}.network_interface[0].network_ip
  port                   = var.port
}` };
    default:
      vars.push({ name: 'lb', type: 'string', description: 'The load balancer\'s display name.', value: val(values, 'lb', 'shop-lb') });
      vars.push({ name: 'weight', type: 'number', description: 'The backend weight.', value: weight });
      return { vars, main: `${head}

data "oci_load_balancer_load_balancers" "lb" {
  compartment_id = var.landing_zone.compartment_id
  display_name   = var.lb
}

data "oci_core_vnic_attachments" "member" {
  compartment_id = var.landing_zone.compartment_id
  instance_id    = ${t.id}
}

data "oci_core_vnic" "member" {
  vnic_id = data.oci_core_vnic_attachments.member.vnic_attachments[0].vnic_id
}

resource "oci_load_balancer_backend" "member" {
  load_balancer_id = data.oci_load_balancer_load_balancers.lb.load_balancers[0].id
  backendset_name  = var.pool
  ip_address       = data.oci_core_vnic.member.private_ip_address
  port             = var.port
  weight           = var.weight
}` };
  }
}

function applianceSh(kind: 'f5-bigip' | 'avi', pool: string, address: string, port: number, weight: number, present: boolean): string {
  const six = address.includes(':');
  if (kind === 'f5-bigip') {
    const p = pool.replace(/^\//, '');
    const [part, name] = p.includes('/') ? [p.split('/')[0]!, p.split('/').slice(1).join('/')] : ['Common', p];
    const member = `${address}${six ? '.' : ':'}${port}`;
    return code`${HTTP_SH}
if [[ -z "$\{F5_HOST:-}" ]]; then change_stop 3 "F5_HOST is not set"; fi
http_creds F5_USER F5_PASSWORD
URL="https://$F5_HOST/mgmt/tm/ltm/pool/~${part}~${name}/members"
have="$(http_get "$URL/~${part}~${member}" 2> /dev/null || true)"
${present
      ? code`if [[ -n "$have" ]]; then atk_log "${member} is a member already"; else
  http_send POST "$URL" ${shq(JSON.stringify({ name: member, address, ratio: weight }))}
fi`
      : code`if [[ -z "$have" ]]; then atk_log "${member} is not a member"; else http_send DELETE "$URL/~${part}~${member}"; fi`}`;
  }
  return code`${HTTP_SH}
if [[ -z "$\{AVI_HOST:-}" ]]; then change_stop 3 "AVI_HOST is not set"; fi
http_creds AVI_USER AVI_PASSWORD
HDR="X-Avi-Version: $\{AVI_API_VERSION:-22.1.3}"
ref="$(http_get "https://$AVI_HOST/api/pool?name=${encodeURIComponent(pool)}" "$HDR" | jq -r '.results[0].uuid // empty')"
if [[ -z "$ref" ]]; then change_stop 5 "no Avi pool named ${pool}"; fi
POOL="$(http_get "https://$AVI_HOST/api/pool/$ref" "$HDR")"
n="$(jq --arg ip ${shq(address)} '[.servers[]? | select(.ip.addr == $ip)] | length' <<< "$POOL")"
${present
    ? code`if (( n > 0 )); then atk_log "${address} is in the pool already"; else
  http_send PUT "https://$AVI_HOST/api/pool/$ref" "$(jq -c --arg ip ${shq(address)} --argjson port ${port} --argjson ratio ${weight} '.servers = ((.servers // []) + [{ip: {addr: $ip, type: "${six ? 'V6' : 'V4'}"}, port: $port, ratio: $ratio, enabled: true}])' <<< "$POOL")" "$HDR"
fi`
    : code`if (( n == 0 )); then atk_log "${address} is not in the pool"; else
  http_send PUT "https://$AVI_HOST/api/pool/$ref" "$(jq -c --arg ip ${shq(address)} '.servers |= map(select(.ip.addr != $ip))' <<< "$POOL")" "$HDR"
fi`}`;
}

export const lbMember: ChangeUtility = {
  id: 'lb-member',
  label: 'Add a load-balancer member',
  category: 'network',
  description: 'A server into a load balancer\'s pool: an ELB target group attachment, an Azure Load Balancer backend address, a Google Cloud network endpoint, an OCI load balancer backend (Terraform, everything found by name); F5 BIG-IP (iControl REST) and VMware Avi Load Balancer (its API) on VCF.',
  platforms: ALL_PLATFORMS,
  risk: 'medium',
  reversible: true,
  rollback: 'Takes the member out of the pool again.',
  source: 'A.9.2',
  inputs: [
    platformInput(ALL_PLATFORMS),
    { id: 'lb_kind', label: 'Load balancer', control: 'select', default: '', blankLabel: 'The platform\'s own (VCF: VMware Avi Load Balancer)', options: [opt('f5-bigip', 'F5 BIG-IP'), opt('avi', 'VMware Avi Load Balancer')], ...on('vmware') },
    { id: 'lb', label: 'Load balancer name', control: 'combo', default: 'shop-lb', from: 'lb', ...on('azure', 'oci') },
    { id: 'pool', label: 'Pool', control: 'text', default: 'shop-web', hint: 'The target group, backend pool, NEG, backend set, F5 pool (/Partition/pool) or Avi pool.' },
    serverInput('Member', 'web03'),
    { id: 'address', label: 'Member address', control: 'text', default: '10.50.10.23', hint: 'F5 and Avi: the member\'s IP address (IPv4 or IPv6).', ...on('vmware') },
    { id: 'port', label: 'Port', control: 'number', default: 443, min: 1, max: 65535 },
    { id: 'weight', label: 'Weight', control: 'number', default: 1, min: 1, max: 100, ...on('oci', 'vmware') },
    ...NETWORK_INPUTS, RG_INPUT, ZONE_INPUT, ...VSPHERE_INPUTS,
  ],
  build(values): UtilityResult {
    const platform = platformOf(values, lbMember);
    const findings: Finding[] = [];
    const server = val(values, 'server', 'web03');
    const pool = val(values, 'pool', 'shop-web');
    const port = numVal(values, 'port', 443);
    const weight = numVal(values, 'weight', 1);
    if (platform === 'vmware') {
      const kind = (val(values, 'lb_kind') || 'avi') as 'f5-bigip' | 'avi';
      const address = val(values, 'address');
      if (!familyOf(address)) findings.push(error('change.lb.address', 'F5 and Avi members need the server\'s IP address.', { path: 'address' }));
      return {
        platform, target: `${pool}/${server}`, route: 'cli', summary: `Add ${server} (${address}:${port}) to the ${kind === 'avi' ? 'Avi' : 'F5'} pool ${pool}`, files: {}, findings,
        apply: [{ kind: 'sh', title: `Add ${server} to ${pool}`, body: applianceSh(kind, pool, address, port, weight, true) }],
        rollback: [{ kind: 'sh', title: `Take ${server} out of ${pool}`, body: applianceSh(kind, pool, address, port, weight, false) }],
        needs: ['curl', 'jq'],
        notes: [kind === 'avi'
          ? 'VMware Avi Load Balancer: AVI_HOST and AVI_USER in the environment; the password from AVI_PASSWORD, AVI_PASSWORD_FILE or ATK_VAULT_CMD; AVI_API_VERSION (default 22.1.3, check your controller).'
          : 'F5 BIG-IP: F5_HOST and F5_USER in the environment; the password from F5_PASSWORD, F5_PASSWORD_FILE or ATK_VAULT_CMD.', 'CHANGE_CACERT names the CA bundle to trust for the appliance\'s certificate.'],
      };
    }
    if (platform === 'aws' && weight !== 1) findings.push(info('change.lb.weight', 'ELB target groups have no per-target weight.'));
    const tf = lbTf(platform, values, port, weight);
    return {
      platform, target: `${pool}/${server}`, route: 'terraform', summary: `Add ${server}:${port} to ${pool} (${LB_OF[platform]}) on ${PLATFORM_LABELS[platform]}`, findings,
      files: tfRoot({ platform, header: `Add ${server} to the pool ${pool}.`, main: tf.main, variables: tf.vars }),
      apply: [{ kind: 'terraform', title: `Add ${server} to ${pool}`, dir: 'terraform', lz: true }],
      rollback: [{ kind: 'terraform-destroy', title: `Take ${server} out of ${pool}`, dir: 'terraform', lz: true }],
      needs: [],
      notes: ['A pool the app stack manages (its ingress) takes its members from the stack: add the server to the app instead (Add a server with the component), so the next apply keeps it.'],
    };
  },
};

export const NETWORK_UTILITIES: readonly ChangeUtility[] = [openPort, dnsRecord, lbMember];
export { HTTP_SH };

