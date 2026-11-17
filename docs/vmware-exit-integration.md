# VMware exit integration project plan

Start in **Multi-Cloud Migration & Utilities → Project setup**. Under
**Initiative**, choose the migration scope, then select vSphere or VCF, the
governance and data-handling profiles, and a destination.
Choose a preferred transfer path and cutover approach. Download the project plan with the current
inventory counts, wave dates, phase owners, evidence, and target-specific
workstreams. Set calendar dates after sizing the estate, confirming procurement
lead times and testing a representative pilot. Use measured cutover and rollback
times to set the production outage budget.

## Current implementation and gaps

| Stage | ArchToolKit today | Engineering work |
| --- | --- | --- |
| Discover | VMware Inventory accepts RVTools and collector exports. Application Migration groups workloads, databases and dependencies. The existing source adapters include vSphere, AHV, Hyper-V, Proxmox and oVirt/OLVM. | Capture platform versions, object IDs, storage policies, NSX security objects and rule intent, app write dependencies and operational tooling. Extend inventory and lifecycle adapters for HVM, OpenStack and KubeVirt sources. |
| Design | The decision engine supports AWS, Azure, Google Cloud, OCI and VCF. The data-centre exit and network utilities cover facility and network work, with existing firewall and load-balancer formats. | Extend target placement and design with private-cloud capability checks. Implement NSX inventory normalization and a policy-diff model with direction, rule order, default behavior and explicit handling of unsupported semantics. Test expected allow and deny traffic on the destination. |
| Provision | Generate produces Terraform and Ansible for modeled platforms. The migration kit consumes target infrastructure during cutover and post-configuration. | Add target-provider Terraform modules and adoption state, plus Ansible guest baselines for each qualified landing zone. Separate the platform's own provisioning workflow from per-application resources. Validate HCL against pinned provider versions and test upgrades and rollback. |
| Move | Execute has a manifest, provider path scripts, dry runs, wave locks, gate files, logs, status import, rollback and decommission stages. | Add private-cloud job adapters to the path registry and source/target rules. Validate capabilities and credentials at preflight, persist external job IDs, poll real states and make partial success resumable. Qualify AWS GovCloud, Azure Government and Azure Local as distinct endpoint environments before enabling execution. |
| Authorize | The VMware exit planner exports agency-specific evidence requirements. Execute already supports basic wave approvals and a recorded override. | Keep approval evidence in the agency system of record. Add a versioned authorization policy and verify scope and approver evidence in both UI and controller for restricted routes. Make a federal policy hold immune to generic gate overrides. Include migration appliances, telemetry, state, backups and operator access in the boundary. |

## Delivery sequence

1. **Baseline and scope.** Inventory vCenter, vSAN, NSX, identity, backups,
   networks, Aria and integrations. Group synchronous dependencies and size
   swing capacity using observed storage, compute and synchronization time.
   Owners are the application, infrastructure and network teams.
2. **Run authorization in parallel.** Establish data ownership, public or
   nonpublic handling, CUI category or classified workflow, and approved target
   and staging boundaries. For State, capture DT review or exception, applicable
   acquisition and change control decisions, AO scope, and CDM integration
   evidence. Confirm which current DoD interoperability requirements apply.
   A product listing, STIG or CMVP certificate is an evidence input to the
   authorization decision. Review any intended transfer between boundaries
   through the authorized process before moving data.
3. **Qualify target lanes.** Reuse cloud and VCF adapters. Implement Nutanix Move,
   OpenShift MTV, and Azure Local as separate destinations, in parallel when
   staffing allows. Add dedicated adapters for Windows Server Hyper-V, HPE HVM,
   OpenStack, OLVM, Proxmox and Harvester as the target design is qualified.
   Use the planner’s target-specific landing, migration and acceptance steps.
   The delivery gate is a repeatable nonproduction migration and rollback for
   each supported source version, destination version and guest class.
4. **Pilot and scale.** Apply reviewed Terraform and Ansible. Exercise security
   policies, endpoint agents and restore in an isolated pilot. Promote only
   verified pairs. Sequence workload groups into waves, get the go decision,
   stop writes, perform final sync, switch traffic, run functional and data
   checks, and record results. Keep the source recoverable until commit.
5. **Close the exit.** Verify hypercare results, retention and legal holds,
   recovery, sanitized media and asset disposition. Reuse drained hardware
   only after compatibility and sanitization checks. Reconcile inventory,
   monitoring, CMDB and contracts before removing the old cluster.

## Sources for the federal evidence checklist

- State acquisition and authorization requirements come from the [State IT
  acquisition policy](https://fam.state.gov/fam/05fam/05fam0910.html) and the
  [State authorization handbook](https://fam.state.gov/fam/05fah11/05fah110410.html).
  Record the applicable internal DT decision from the authorized source.
- For DoD interconnections, verify the current requirement and any applicable
  legacy evidence under the [DoDIN APL sunset memo](https://aplits.disa.mil/docs/DoD_CIO_APL_Sunset_Memo.pdf).
  Check CDM acquisition and integration evidence using the [CISA CDM APL
  instructions](https://www.cisa.gov/sites/default/files/2024-04/CDM_%20APL_%20Submission_%20Instructions_2023_v2.pdf).
- Use [NARA CUI guidance](https://www.archives.gov/cui/registry/policy-guidance)
  and [FIPS 199](https://csrc.nist.gov/pubs/fips/199/final) where applicable.
  Validate the exact cryptographic module and mode through the
  [NIST CMVP](https://csrc.nist.gov/Projects/cryptographic-module-validation-program/validated-modules).
  Verify cloud offerings through [FedRAMP](https://www.fedramp.gov/marketplace/guide/)
  and the [DoD Cloud SRG](https://public.cyber.mil/dccs/dccs-documents/) as
  applicable. Use the approved sanitization procedure with
  [NIST SP 800-88 Rev. 2](https://csrc.nist.gov/pubs/sp/800/88/r2/final) as applicable.
