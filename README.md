# ArchToolKit

Offline-first architecture toolkit for multi-cloud, VMware, VMware Cloud Foundation and network
device work.

Runs entirely in the browser. No server, no network calls, no telemetry, and **no dependencies** —
there is no `node_modules`, no bundler and no package registry involved at any point. It is designed
to work from a laptop with no internet, from an internal web server, or from a zip carried into an
air-gapped environment.

## Requirements

Node.js 22.6 or newer, only for building and testing. The built output is plain ES modules that any
modern browser loads directly.

## Quick start

```bash
node tools/build.mjs      # compile src/ -> web/lib/
node tools/serve.mjs      # serve web/ at http://127.0.0.1:8080
```

Or both at once, with rebuild-on-save:

```bash
npm run dev
```

Then open <http://127.0.0.1:8080/>.

> ES modules cannot be loaded over `file://` in most browsers, so the local server is needed during
> development. For distribution, serve `web/` from any static host.

### On a machine with no Node

A work PC or an air-gapped box often has no Node and no way to install it. The toolkit still runs
there, because the built pages are committed in `web/lib`:

1. On GitHub, **Code → Download ZIP**, and extract it anywhere.
2. Double-click `start.bat`.

With no Node on the PATH, `start.bat` serves the prebuilt pages with Windows PowerShell instead
(`tools/serve.ps1`): localhost only, no administrator rights, nothing installed. If a policy blocks
scripts, run it directly:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\serve.ps1
```

Only `start.bat --dev`, which rebuilds on every change, needs Node.

If the default port is taken or reserved, the server walks forward to the next free one and tells
you which it used. To pick one explicitly:

```bash
node tools/serve.mjs --port 3000
```

**Windows note.** Hyper-V, WSL and Docker reserve blocks of TCP ports, and binding inside a reserved
block fails with `EACCES` even as administrator with nothing listening. Port 8080 often falls inside
one. The server handles this automatically; to see the reserved ranges yourself:

```powershell
netsh interface ipv4 show excludedportrange protocol=tcp
```

Run the tests:

```bash
npm test
```

## How the build works

There is no TypeScript compiler here and nothing to install. `tools/build.mjs` uses Node's built-in
`stripTypeScriptTypes` to remove type annotations, rewrites relative `./x.ts` import specifiers to
`./x.js`, and writes plain ES modules to `web/lib/`. Type stripping is whitespace-preserving, so
line numbers in browser stack traces still match the TypeScript source.

Full type *checking* is optional and needs `tsc`, which is not required to build or run:

```bash
npx tsc --noEmit      # only if you have TypeScript available
```

## Layout

```
src/
  core/       IP/CIDR arithmetic, capacity units, findings
  vcf/        VCF 9.1 sizing data, sizing engine, provenance tagging
  vmware/     inventory model, RVTools and PowerCLI import, analysis
  multicloud/ platform routing, capability table, VMware-on-cloud services
  terraform/  HCL writer, provider registry, foundations, resource catalog
  ansible/    YAML writer, collection registry, playbooks, module catalog
  ui/         DOM helpers, shared components, page controllers
  testing/    minimal expect() shim over node:assert
tools/       build, serve and dev scripts (zero dependencies)
web/         static shell — HTML, CSS, and generated lib/
docs/        design notes and research
_old/        the previous toolkit, kept for reference and data mining
```

`web/lib/` is generated. It is gitignored; run the build before serving.

## Design principles

**One canonical source for shared data.** The previous toolkit forked its cloud service catalogs
across two directories, and the copies drifted — AWS at 21 KB in one place and 33 KB in the other.
Every tool here imports the same module.

**Provenance on every number.** This toolkit generates real deployment configurations, so a figure
from a blog post must never be indistinguishable from one in Broadcom's documentation. Sizing data
is tagged `V-API`, `V-DOC`, `V-SPEC`, `C` (community) or `I` (inferred), the UI shows the tag, and a
computed total inherits the weakest tag of its inputs.

**Findings, not booleans.** Engines return structured findings with a severity, the offending field
path, a remediation and a source — never a bare pass/fail.

**Logic separate from UI.** Nothing in `src/core` or `src/vcf` touches the DOM. The engines are
importable from Node, testable without a browser, and reusable from a CLI or a future front end.

## Status

| Tool | State |
| --- | --- |
| VCF 9.1 sizing | Working — greenfield, brownfield converge/import, fleet scale |
| VCF 9.1 `SddcSpec` builder | Working — all 8 documented deployment scenarios |
| VMware inventory import and analysis | Working — RVTools and PowerCLI import, analysis, readiness |
| Multi-cloud decision matrix | Working — explainable routing across VCF, AWS, Azure, Google Cloud and OCI |
| Terraform authoring kit | Working — scaffold for 5 clouds, network foundation for each, VCF bring-up, every resource of the six VMware providers, Linux and Windows OS builds |
| Ansible authoring kit | Working — repository scaffold for 7 platforms, vSphere collection and configuration playbooks |
| Application migration and modernization | Working — single-application evaluation and portfolio wave planning |
| Data editor | Working — JSON and YAML for VCF, Ansible, Terraform, AWS, Google, Azure, Oracle, F5 and Kubernetes |

## Terraform authoring

The kit emits three kinds of output:

- **Scaffold** — `required_providers`, a state backend, provider blocks and
  variables, for any combination of AWS, Azure, Google, OCI, vSphere and VCF.
- **Network foundation** — a private network, subnets, egress and ingress rules,
  written in each cloud's own nouns from one description.
- **VCF bring-up** — a `vcf_instance` resource generated from an `SddcSpec`.

Provider source addresses and versions were read from the Terraform Registry,
and every resource was written against that provider's published schema. Where a
provider cannot express something, the kit reports it rather than inventing a
block: the VCF provider's compatibility matrix stops at 9.0.0 and has no blocks
for the components 9.1 added, and each of those is named in the findings.

Credentials are never written into generated files. Each provider's own
authentication method is described in a comment, and the VCF emitter turns every
password into a `sensitive` variable.

### VMware: every resource, every argument

The two VMware platforms on the Terraform page cover the whole VMware stack:

| Platform | Providers |
| --- | --- |
| VMware vSphere / vCenter | `vmware/vsphere` |
| VMware Cloud Foundation | `vmware/vcf` (SDDC Manager), `vmware/nsxt` (NSX), `vmware/avi` (Avi Load Balancer), `vmware/vra` (VCF Automation), `vmware/vcd` (Cloud Director) |

Each product offers two kinds of blueprint, under its own headings in the picker:

- **Scenarios** — hand-written builds of several resources together: a VM cloned
  and customised from a template, a cluster with HA, DRS and its hosts, a
  distributed switch and its port groups, a Tier-1 gateway with segments and a
  three-tier distributed firewall, an Avi virtual service with its pool and
  health monitor, a workload domain, a tenant organization and VDC.
- **One blueprint per resource** — all ~600 resources the six providers have,
  each with every argument it takes as a field: required ones up top, optional
  ones in a collapsible section, nested blocks behind a tick box. Arguments the
  documentation gives a closed set for are dropdowns. A sensitive argument is
  never a text box, and a required argument left empty becomes a variable.
  Any field takes a reference (`data.vsphere_datacenter.dc.id`, `var.x`) as
  well as a value.

The per-resource forms are generated from `src/terraform/vmware-schema-data.ts`,
which `npm run schemas:update` (step 6 of `update-catalog.bat`) rewrites from
`terraform providers schema -json` — the providers' own schema — and their
registry documentation. Nothing about an argument is transcribed by hand.

    npm run terraform:validate              (-- --scenarios, -- --only nsx_)

runs real `terraform validate`, with the real providers, over what every VMware,
Linux and Windows blueprint generates — each scenario once per choice of every dropdown and yes/no,
so a branch the defaults never take is checked too. It needs the terraform CLI.

### Linux and Windows

Terraform does not configure an operating system the way Ansible does, but it
owns the pieces around one, and the two OS platforms offer those the same way —
scenarios first, then every resource of every provider involved, generated from
`src/terraform/os-schema-data.ts`:

| Platform | Providers |
| --- | --- |
| Linux | `hashicorp/cloudinit`, `hashicorp/tls`, `hashicorp/dns` (TSIG, for BIND), `ansible/ansible`, `hashicorp/local`, `hashicorp/random`, `hashicorp/null` |
| Windows | `hashicorp/ad` (Active Directory over WinRM), `hashicorp/dns` (GSS-TSIG, for AD-integrated zones), `hashicorp/tls`, `ansible/ansible`, `hashicorp/local`, `hashicorp/random`, `hashicorp/null` |

The scenarios cover cloud-init for a new VM, SSH keys, an internal CA, DNS
records, Ansible runs, bootstrap and hardening over SSH, domain joins, Active
Directory OUs, groups, users and GPOs, and roles and features over WinRM.
Passwords are generated with `random_password` or read from sensitive variables;
none is ever a default.

## Ansible authoring

Terraform builds an estate; Ansible reads one and reconfigures it. The kit emits
a repository scaffold — `requirements.yml` with collections pinned to the major
line Galaxy reported, an `ansible.cfg` that leaves host key checking **on**, an
inventory, and a vault template that is gitignored until it is encrypted — and,
for vSphere, two real playbooks: one that collects an estate into JSON the
inventory importer reads, and one that renders an imported cluster's settings
back as the tasks that would produce them.

Every module and argument name was read from `vmware.vmware` 2.10.0's own
documentation. No credential is written into a generated file: every module in
the collection falls back to `VMWARE_HOST`, `VMWARE_USER` and `VMWARE_PASSWORD`,
so the playbooks name none of them. A literal-looking password is an error, and
handling a secret without `no_log` is a warning.

Missing data is never a change. A cluster whose HA state the inventory did not
record produces no HA task, because writing `enable: false` for a field nobody
collected would turn a gap in the data into a change to the estate.

Details in `docs/ansible-kit.md`.

## Multi-cloud decision matrix

Not "which cloud is best" — nobody can answer that. Given a set of constraints,
which of the five platforms is left, and why. Every rule states what it looked
at, which way it pushed and where the claim came from, so any of them can be
read and disagreed with on its own, and a margin of one point is reported as too
close to call rather than resolved.

Rules that encode something structural score. Rules about region coverage,
sovereign offerings and pricing only report, because those change constantly and
cannot be checked from an offline toolkit.

The capability table checks itself: every entry carries the Terraform resource
type as well as the product name, and a test validates all of them against the
committed provider catalog. A blank cell is a genuine gap, not an omission.

Details in `docs/multicloud-matrix.md`.

## Catalogs

Both kits hand-write the parts worth getting exactly right and consult a catalog
for the rest — roughly 5,600 Terraform resources and 4,500 data sources across
ten providers, and 3,929 Ansible modules across eleven collections. Far too many
to maintain by hand, and changing with every release.

    update-catalog.bat        (or: npm run catalog:update, npm run ansible:update)

fetches both lists — from the Terraform Registry and from Ansible Galaxy — and
rewrites `src/terraform/catalog-data.ts` and `src/ansible/catalog-data.ts`, both
of which are committed so the toolkit still works air-gapped. Each catalog records the version every list came from and the date it was
fetched, and reports when it is old, when entries are missing, and when the
version it was built from no longer matches the one the kit pins.

The batch file checks Node, runs both fetches, offers to check the generated
Terraform against the provider schemas, and offers to rebuild so the pages pick
the new catalogs up. If it cannot reach a registry it says so and leaves that
catalog exactly as it was — a failed refresh never empties one.

Not knowing a resource is kept distinct from knowing it is wrong: an uncatalogued
provider or collection produces a warning, not a rejection.

## Schema verification

The catalog answers *does this type exist*. It does not answer *does this type
take this argument*.

    npm run verify:schemas

runs the foundation emitters, parses the HCL they actually produce, and checks
every argument name against that resource's own documentation in the Terraform
Registry for the current provider version. Parsing the emitters' own output
rather than a hand-kept list is deliberate — a list drifts the first time an
emitter changes, and a check that drifts is worse than no check.

As of 2026-09-20: zero undocumented arguments across 29 resources and five
providers. See `docs/terraform-schema-verification.md`.

## Checks

    npm test            unit suite, no dependencies, runs anywhere
    npm run typecheck   full type check (tsc, optional)
    npm run test:browser mounts every page in a real browser

The browser check needs Playwright, which is deliberately not a dependency —
the toolkit has to build and run air-gapped — so it skips with a note when
Playwright is absent, and a skipped check is not a failure:

    npm install --no-save playwright && npx playwright install chromium

It exists because two defects passed a green unit suite and a clean typecheck:
a redraw triggered by the blur of clicking a button destroyed that button
mid-click, and a `let` declared below the code that reached it left a page dead
on arrival. Neither is visible without a browser.

## Working across the three tools

The tools answer consecutive questions, and each hands its result to the next
rather than making you retype it:

    inventory  ->  sizing  ->  spec builder
    what is there   what it must become   the document that builds it

    inventory  ->  multi-cloud  ->  Terraform / Ansible
    what is there   where it goes    what builds it there

Import the RVTools `.xlsx` once, on any page — it is read in the browser with
no library (the zip is inflated by `DecompressionStream`, the sheets streamed),
all 27 tabs, scoped by vCenter — and it is kept in this browser's IndexedDB
until **Forget** is pressed. Every page reads it:

- **Inventory** — totals, clusters with their demand and RDMs counted once per
  LUN, VCF host readiness, and a per-VM check of what blocks or complicates a
  move (physical RDMs, shared disks, mounted ISOs, snapshots, unsupported OSes).
- **Sizing** — plans the fleet: a management domain (a converged cluster or new
  hosts) and a workload domain per source vCenter, each source cluster resized
  onto the chosen target host, then sizes the management domain as before.
- **Spec builder** — takes the converged cluster's hosts, DNS, NTP, domain and
  its management, vMotion and vSAN networks with their VLANs and MTUs.
- **Terraform** — a VCF landing zone for a cluster (port groups with VLANs,
  folders, resource pools, custom attributes, DRS rules) or a cloud rehost with
  every VM sized onto a real instance type and a disk per VMDK.
- **Ansible** — an inventory of a cluster's VMs, and plays for before the move
  (snapshots, the readiness worklist) and after it (DRS rules, attributes).
- **Multi-cloud** — answers the wizard's questions the estate can answer.

From a sizing
result, **Continue in the spec builder** carries the host count, storage type,
failures to tolerate, deployment scenario and the IP pool counts, so the pools a
specification emits match the sizing that justified them.

The decision matrix takes the estate rather than the sizing result: it reads
machine counts, guest OS families and the machines large enough to narrow the
instance shapes, then says plainly that the databases, the latency tolerance and
the deadline are in no export and move the answer more than anything that is.
Once a platform leads by more than a point, it hands off to the Terraform and
Ansible kits.

A handoff applies once and lives only for the browser tab, so reloading a page
never silently re-applies a decision that has since changed. Each step remains
usable on its own; nothing requires starting at the beginning.

## Spec builder inputs

The form covers the fields a form can express. Structured and rarely-used parts
of `SddcSpec` — resource pools, root CA chains, explicit IP pool ranges and
per-component FQDN overrides — are reached by pasting a specification into the
import panel, which validates it the same way. Credentials are deliberately not
collected in the browser: the builder emits `<REQUIRED>` placeholders and reports
them, and VCF 9.1 can generate complex passwords during installation.

## A caution on VCF output

Sizing results and generated specifications are planning aids. Before any real deployment, validate
against a live VCF Installer:

- `POST /v1/sddcs/validations` — validates a spec
- `POST /v1/sddcs/resources-calculation` — the product's own sizing math, which is authoritative and
  should override this toolkit wherever the two disagree

See `docs/vcf-91-groundtruth.md` for the researched schema and sizing data, including an explicit
list of figures that could not be verified.

## Licence and disclaimer

ArchToolKit © 2026 Theodore Gibson. **All rights reserved.**

This version is free to use as supplied, for your own work or inside your organisation. Copying it
to anyone outside your organisation, modifying it, deriving anything from it, reusing its code or
data elsewhere, and selling it or charging for it are **not** permitted without the author's written
permission. The full terms are in [`LICENSE`](LICENSE). Output you produce with the toolkit is
yours; the licence governs the toolkit itself.

**No warranty, no liability.** Everything the toolkit produces — sizing figures, specifications,
Terraform, Ansible, declarations, migration routes and risk bands — is a draft for a human to
review, not a finished artefact and not professional advice. Generated code is unreviewed code:
plan or dry-run it, and test it somewhere that does not matter before it touches production.
Compliance and regulatory references are informational only. Use is at your own risk.
