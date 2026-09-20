# Foundation schema verification

The resource catalog answers *does this type exist*. It does not answer *does
this type take this argument*, and that is the failure that costs an afternoon:
a configuration that initialises, plans, and then rejects an argument name that
was right two major versions ago.

`tools/verify-foundation-schemas.mjs` closes that gap. It runs the foundation
emitters, parses the HCL they actually produce, and checks every argument name
against that resource's own documentation in the Terraform Registry for the
current provider version.

    npm run verify:schemas

Parsing the emitters' own output rather than a hand-kept list is deliberate. A
list would drift from the emitters the first time one changed, and a check that
drifts is worse than no check.

## Result, 2026-09-20

**Every argument the foundations emit is documented, across all five providers.**

| Provider | Version | Resources checked | Undocumented arguments |
| --- | --- | --- | --- |
| `hashicorp/aws` | 6.65.0 | 8 | 0 |
| `hashicorp/azurerm` | 5.6.0 | 5 | 0 |
| `hashicorp/google` | 8.3.0 | 5 | 0 |
| `oracle/oci` | 9.2.0 | 5 | 0 |
| `vmware/vsphere` | 2.17.1 | 6 | 0 |

## Why some required arguments are not emitted

The tool also reports required arguments the foundation does not set, as
**REVIEW** rather than as an error. The registry documentation flattens nested
block requirements into the same list, so a required argument of an *optional*
block appears there too. Each of the current entries was looked at:

| Resource | Reported | Why it is correct |
| --- | --- | --- |
| `aws_security_group` | `from_port`, `to_port`, `protocol` | Required inside the deprecated inline `ingress`/`egress` blocks. The kit uses the separate `aws_vpc_security_group_ingress_rule` and `_egress_rule` resources instead, which is the current pattern. |
| `azurerm_virtual_network` | `address_prefixes`, `service`, `service_delegation`, `id`, `enable`, `enforcement`, `number_of_ip_addresses` | All required inside optional nested blocks — inline `subnet`, `delegation.service_delegation`, `ip_address_pool`, `encryption`. The kit emits subnets as separate `azurerm_subnet` resources. |
| `azurerm_subnet` | `service`, `service_delegation`, `id`, `number_of_ip_addresses` | Required inside the optional `delegation` and `ip_address_pool` blocks. |
| `oci_core_security_list` | `type` | Required inside the optional `icmp_options` block. |
| `oci_core_vcn` | `byoipv6range_id`, `ipv6cidr_block` | Required inside the optional `byoipv6cidr_details` block. |
| `vsphere_distributed_virtual_switch` | `host_system_id`, `primary_vlan_id`, `secondary_vlan_id`, `pvlan_type` | Required inside the optional `host` and `pvlan_mapping` blocks. The registry confirms `host` itself is Optional, so a VDS is validly created without one. |

If a new entry appears here after a provider release, it needs the same look —
the tool cannot tell a genuinely missing required argument from a nested one,
and pretending it could would turn an honest advisory into a wrong verdict.

## What it still does not check

Value types, enumerations and the interactions between arguments. Those come
from `terraform validate` and `terraform plan` against a real provider binary,
which an offline toolkit cannot run. Every generated configuration says so.
