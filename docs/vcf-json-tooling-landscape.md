# VCF 9.1 deployment JSON — the tooling landscape

Researched 2026-09-17. Answers the question: what produces a VCF 9.1 `SddcSpec`,
what is official, and where does ArchToolKit fit.

## Short answer

Broadcom's first-party builder is **the VCF Installer's own deployment wizard**.
At the **Review** step, before you deploy, there is a **Download JSON Spec**
button. TechDocs describes the intended loop directly:

> "You can also download the JSON specification file, make the necessary
> changes, and then upload the modified JSON specification file from the VCF
> Installer homepage."

There is **no standalone Broadcom web tool, desktop utility or supported
PowerShell cmdlet** that generates a 9.1 spec outside the appliance.

## The three export points in the Installer

| Stage | Control | Produces |
| --- | --- | --- |
| Plan → Review Prerequisites | Download as JSON Template | Prerequisites BOM: hosts, vCPU, RAM, storage, FQDNs, IP pools |
| Deploy → Review | Download JSON Spec | The full `SddcSpec`, before deployment starts |
| Post-deployment | Download JSON Spec | As-built record, passwords excluded |

**The wizard does not expose every field the schema supports.** Dual-stack
networking and a non-default internal cluster CIDR are both documented as things
you must add by hand-editing the exported JSON. That is Broadcom's own guidance,
not a workaround.

## What the Installer API does and does not do

It validates and deploys; it does not generate.

- `POST /v1/sddcs/validations` — validate a spec you already have
- `POST /v1/sddcs/resources-calculation` — the product's own sizing math
- `POST /v1/sddcs` — deploy
- `vcenter-discovery`, `vcfops-discovery`, `sddcm-discovery` — brownfield discovery

Spec generation is UI-only.

## Status of the Excel workbooks

**Deployment Parameter Workbook — retired.** The .xlsx that Cloud Builder
consumed in VCF 4.x/5.x does not exist for 9.x. The 9.1 Installer accepts JSON
only; it will not take a spreadsheet of any kind.

**Planning and Preparation Workbook — exists, but is not machine-readable.**
Published for 9.0, 9.1 and 9.1.1 as a design and sizing artifact. It has no JSON
export and no Installer integration. Broadcom's documented workflow is to fill it
in and then retype it into the wizard: the fields are ordered to match the wizard
sequence precisely so transcription is mechanical.

## Other producers of a 9.1 spec

| Tool | Official? | Input | Installer-consumable output |
| --- | --- | --- | --- |
| Installer wizard | Yes | Guided UI | Yes, native |
| `VCF.JSONGenerator` | `vmware` GitHub org, "provided as is" | Completed P&P workbook | Yes |
| vcfplanning.lcoscia.fr | Community | Web form | Claimed |
| VirtualBytes VCF JSON Builder | Community | Web form | Targets 9.0.2; 9.1 unconfirmed |
| pauldiee/VCF9-DeploymentPlanning | Community | Questionnaire | No — planning docs only |
| VCF Sizer | Does not exist | — | — |

`VCF.JSONGenerator` is worth knowing about. It sits in the official `vmware`
GitHub organization under a Broadcom license but states plainly that it is
provided as is, with no support entitlement — do not present it to a customer as
supported. Version 9.1.0.1007 supports 9.1 despite a stale README. Notably it
generates more than bring-up: workload domain, vSphere cluster, edge cluster,
network pool and host commissioning files, and Day-N fleet management specs.

## Where ArchToolKit fits

The appliance does not care how a spec was authored. `Deploy using JSON Spec`
accepts a valid `SddcSpec` regardless of origin, which makes offline authoring a
first-class input path rather than a workaround.

What this toolkit does that the alternatives do not:

- Runs with no appliance and no network, before any hardware exists
- Emits the fields the wizard will not collect, so there is no hand-edit step
- Validates specs produced by *other* tools against the 9.1 schema, which catches
  9.0-shaped documents before they reach an installer
- Carries provenance on every sizing figure

What it does not do, by design: deploy, discover live topology, or validate
against real infrastructure. `POST /v1/sddcs/validations` remains authoritative;
the offline validator is a stand-in for the round trip you cannot make, not a
replacement for it.

## Conformance

`src/vcf/__fixtures__/real-specs.ts` holds two specs from `lamw/vcf-91-in-box`
that deployed real 9.1.0.0 instances. `conformance.test.ts` asserts they pass
validation with zero errors. If the validator rejects a spec that actually
deployed, the validator is wrong.

## Sources

- [VCF Installer deployment wizard (TechDocs)](https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-0/deployment/deploying-a-new-vmware-cloud-foundation-or-vmware-vsphere-foundation-private-cloud-/deploy-a-new-vcf-fleet-or-a-new-vcf-instance.html)
- [VCF 9.1 release notes — Installer](https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-1/release-notes/vmware-cloud-foundation-9-1-0-0-release-notes/what-s-new/whats-new-installer.html)
- [Planning and Preparation Workbook 9.1](https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-1/planning-and-preparation.html)
- [Deployment Parameter Workbook, 5.2 and earlier](https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-5-2-and-earlier/5-2/vmware-cloud-foundation-architecture-and-deployment-guide-5-2/deploying-cloud-foundation-deployment/deploy-the-management-domain-using-vmware-cloud-builder-deployment/about-the-deployment-parameter-workbook-deployment.html)
- [VCF.JSONGenerator](https://github.com/vmware/powershell-module-for-vmware-cloud-foundation-jsongenerator) · [PS Gallery](https://www.powershellgallery.com/packages/VCF.JSONGenerator)
- [lamw/vcf-91-in-box](https://github.com/lamw/vcf-91-in-box)
- [Planning a Successful VCF 9.0 Deployment (VCF blog)](https://blogs.vmware.com/cloud-foundation/2025/07/28/planning-a-successful-vmware-cloud-foundation-9-0-deployment/)

### Not reachable from this environment

- TechDocs "Use a JSON Specification File to Deploy..." (9.1) — HTTP 403
- TechDocs .xlsx asset downloads — HTTP 403, so workbook tabs were not enumerated directly
