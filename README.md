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
  multicloud/ platform routing, capability table, VMware-on-cloud services;
              plan/ the migration planner (intake, rules, design, sizing, patterns,
              execution kit, waves, tracker); change/ the day-2 utilities
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
| Decision rules | Working — explainable placement of every server and database across VCF, AWS, Azure, Google Cloud (GCP) and OCI |
| Terraform authoring kit | Working — scaffold for 5 clouds, network foundation for each, VCF bring-up, every resource of AWS, Azure, GCP, OCI and the six VMware providers, Linux and Windows OS builds |
| Ansible authoring kit | Working — repository scaffold for 7 platforms, vSphere collection and configuration playbooks, every module of the Ansible package (~10,900) across 13 platforms |
| Application Migration | Working — every application from any source, a target architecture on the chosen cloud, Terraform and Ansible per application or stacked |
| Multi-Cloud Migration & Utilities | Working — landing zones, waves, the execution kit per move path, tracking, and day-2 utilities |
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
which `npm run schemas:update` (the Terraform area of `update.bat`) rewrites from
`terraform providers schema -json` — the providers' own schema — and their
registry documentation. Nothing about an argument is transcribed by hand.

    npm run terraform:validate              (-- --scenarios, -- --only nsx_)

runs real `terraform validate`, with the real providers, over what every VMware,
Linux and Windows blueprint generates — each scenario once per choice of every dropdown and yes/no,
so a branch the defaults never take is checked too. It needs the terraform CLI.

### AWS, Azure, Google Cloud (GCP) and OCI: every resource

Each cloud's platform lists, after its hand-written and registry-module
blueprints, every resource its provider has — ~5,200 across `hashicorp/aws`,
`hashicorp/azurerm`, `hashicorp/google` and `oracle/oci` — under the
registry's own service headings, each with every argument as a field, exactly
as for VMware.

That is ~170,000 arguments, far too much to load before the page can open. So
the page carries only an index (`src/terraform/cloud-schema-index.ts`) and
fetches a resource's schema from `web/data/terraform/<provider>/` when it is
picked — a file of ~40 resources, rarely more than 200 KB. It is all committed,
so it works air-gapped like everything else. Nested blocks deeper than five
levels (AWS WAF's rule statements go fourteen deep) are one box of HCL rather
than a form.

The rules a provider checks in code rather than in its schema — "one of
`a` or `b` must be set", "at least two `host` blocks" — are found by

    npm run rules:discover                  (-- res_aws_ for one cloud)

which runs `terraform validate` over every per-resource blueprint with nothing
filled in, reads the errors, and records each rule in
`src/terraform/resource-rules-data.ts` until a round finds nothing new. Re-run it
after refreshing the schemas.

`update.bat`, area T, does the whole refresh — resource catalog, provider
schemas, rule discovery, `terraform validate` over every blueprint on every
platform — then the rebuild and the tests, and asks before it commits and
pushes. About two hours; needs Node, terraform and git.

Whatever area it runs, `update.bat` skips what is current: a download that
passed in the last 20 hours, and a check whose inputs have not changed since it
last passed (`update.bat all /yes /force` runs everything). `terraform validate`
loads 40 blueprints at a time (`ARCHTOOLKIT_TF_BATCH`) and stops the provider
processes each round leaves, so memory stays flat. Everything the update and
the tools download, cache and build — the Ansible environment in WSL, the
Terraform provider cache, working directories, the test log — stays in `.work/`
inside the toolkit's folder, found from where the folder is: nothing in a home
directory or the system temp directory, and no fixed drive. Deleting `.work/`
removes all of it.

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

Every module and argument name was read from `vmware.vmware` 2.11.0's own
documentation. No credential is written into a generated file: every module in
the collection falls back to `VMWARE_HOST`, `VMWARE_USER` and `VMWARE_PASSWORD`,
so the playbooks name none of them. A literal-looking password is an error, and
handling a secret without `no_log` is a warning.

Missing data is never a change. A cluster whose HA state the inventory did not
record produces no HA task, because writing `enable: false` for a field nobody
collected would turn a gap in the data into a change to the estate.

Details in `docs/ansible-kit.md`.

### Every module, every option

After each platform's playbooks, the Ansible page lists every module of the
Ansible package (~90 collections) and `oracle.oci` — ~10,900 modules — each a
blueprint with every option its documentation gives: required options up top,
optional ones in a collapsible section, suboptions in their own, documented
choices as a closed dropdown. A `no_log` option is a vault variable, never a
value, and a required option left empty becomes a variable in
`group_vars/all.yml` to fill in. Six platforms are new, made of modules only:
network devices, containers and Kubernetes, databases, storage and server
hardware, private clouds, and everything else.

Each download is a runnable project — the playbook shaped for where the module
runs (API modules from localhost, network modules over `network_cli` or
`httpapi` with their network OS set, the rest against inventory hosts),
`requirements.yml` pinned to the collection version read, `ansible.cfg`, an
inventory and a README.

The options come from `ansible-doc -j` against a real Ansible install, and
are fetched by the page a collection at a time from `web/data/ansible/` like
the cloud Terraform schemas. Ansible does not run on Windows, so the tools use
their own environment inside WSL, set up by `tools/setup-ansible-wsl.sh`:

    npm run ansible:schemas     every option of every module (ansible-doc)
    npm run ansible:rules       rules modules check in code (ansible-lint)
    npm run ansible:validate    ansible-lint's argument check and --syntax-check
                                over every blueprint as generated

`update.bat`, area A, runs the whole refresh — update Ansible, catalog,
schemas, rules, validation, rebuild, tests — and asks before it commits.

## Network device configuration

339 changes across twelve platforms: Cisco IOS/IOS-XE, NX-OS, IOS-XR, the
Catalyst 9800, ASA, Secure Firewall through FMC, Arista EOS, Juniper Junos,
Aruba AOS-CX, Palo Alto PAN-OS (and Panorama), Fortinet FortiOS and F5 BIG-IP.
Every change carries what to capture first, the configuration in the device's
own syntax, what proves it worked and the exact back-out, plus the playbook
that applies it (each platform's `*_config` module, its object modules, AS3,
or one FMC API operation per task) and a change record. Steps collect into a
change list, which also writes the whole device's configuration merged.

    npm run network:validate    every blueprint, every choice: builds, module
                                options, whole-device merge per platform, and
                                ansible-playbook --syntax-check in WSL

`update.bat`, area N, updates the vendor collections, revalidates everything,
rebuilds, runs the tests, and asks before it commits.

## Splunk

Deployable Splunk apps, conf snippets and scripts for Splunk Enterprise 10.4,
Splunk Cloud Platform 10.5 (ACS), forwarders and ingest, grouped by the tier
each one goes on. Every setting is checked against Splunk's own `.conf.spec`
files, and every app against Splunk AppInspect:

    npm run splunk:specs        the Splunk Enterprise .conf.spec settings, from
                                Splunk's published spec files (cached in
                                src/splunk/conf-spec-data.ts)
    npm run splunk:versions     is Splunk Enterprise or Cloud newer than the
                                page's target (flagged, never failed)
    npm run splunk:validate     every blueprint, every choice: builds, every
                                .conf parses (no key set twice), every setting
                                is in the spec, no credential in any file, and
                                each app inspected with Splunk AppInspect in WSL

`update.bat`, area S, updates AppInspect, refreshes the spec settings, checks
the versions, revalidates, rebuilds, runs the tests, and asks before it
commits.

## Data Editor

Open a JSON or YAML file, edit it as a form or as text, and have it checked
against its vendor's own schema as you go: Terraform JSON against the provider
schemas the Terraform page uses, Ansible playbooks against every module's
options, CloudFormation against AWS's registry schemas, ARM templates against
Microsoft's published schemas, Kubernetes manifests against the release's
OpenAPI spec, F5 AS3/DO against F5's schemas, and the VCF spec against the
spec builder's validator. Schema chunks load only for what the file names.

    npm run editor:update           F5 AS3 / DO schemas
    npm run editor:cloudformation   CloudFormation registry schemas
    npm run editor:kubernetes       the latest Kubernetes release's schema
    npm run editor:arm              Azure ARM schemas (GITHUB_TOKEN if rate limited)
    npm run editor:validate         the editor against terraform validate,
                                    ansible-lint, cfn-lint and kubeconform over
                                    tools/editor-corpus

`update.bat`, area E, refreshes every schema, revalidates, rebuilds, runs
the tests, and asks before it commits.

## Application Migration

`migration.html` plans every application: its servers, databases and
dependencies from any source (VMware, Hyper-V, Nutanix AHV, KVM, Proxmox, oVirt,
Xen, physical, another cloud, or a CSV for IBM Power, SPARC, HP-UX and
mainframe), and a target architecture on the one cloud chosen for it — AWS,
Azure, Google Cloud (GCP), OCI or VMware Cloud Foundation. Each application is
designed in the Multi-Cloud Decision & Onboarding Wizard: the cloud chosen in
the header, the steps on the left (migrate an application, set up a new service,
or change a running service, in the chosen provider's own words), and that
cloud's services card by card on the right, with the connectors to the data
centre and to dependencies on other clouds, what gets built, the playbook, and
Full view, Print and Word export. A new service needs no inventory at all.

| Pane | What it does |
| --- | --- |
| `#sources` | The imported VMware estate, collector files (one discovery format for every hypervisor, guest and cloud), the provider import formats (Azure Migrate, Google Migration Center, AWS Migration Hub, Prism Central, AWS Transform MGN, Cloud Migration Factory), CSV and manual entry, the old portfolio, the app grouping rules, and the collectors to download. Every table is read by column header, never by position. |
| `#servers`, `#databases` | Every server and database from every source in one grid each, with detected types, the sizing basis, IP strategy and OS upgrade. |
| `#applications` | The application catalogue, the dependency map, and **New application** for a greenfield service. |
| `#app:<slug>` | One application's Design: the decision wizard. Its answers are prefilled from the plan and stored on it; its cloud is the app's platform; the answers drive the components, connectors and landing-zone decision; components, sizing, dependencies, coupling, assessment and the target sit in the steps' Advanced sections; the Build step generates it. |
| `#constraints` | Platforms, compliance and sovereignty, commercial and licensing, operating model and exit, resilience. |
| `#sizing` | The sizing policy and every application's sizing, from utilisation where a collector measured it. |
| `#stack` | Pick applications and generate one stacked project. |

Generation is the same code for one application or a stack: one Terraform root
module per platform holding every selected app on it (on a shared landing zone,
or including its own), the Ansible for their servers, the CI/CD pipeline, the
app plan and the decision record, plus each cloud's own deployment path (an
Infrastructure Manager root module for Google Cloud, a Resource Manager stack
.zip for OCI, a VCF Automation cloud template for VCF). The archive is dated
from the plan, so the same plan gives the same bytes. Details in `docs/application-migration.md`.

## Multi-Cloud Migration & Utilities

`multicloud.html` (Migration & Utilities in the menu) takes the application
plans and moves them, then keeps changing the estate. It shares one plan with
Application Migration; a **Plan mode** in both headers (data-centre exit, migrate
applications, one application, new services only) decides which panes matter,
and a pane with data in it always shows.

| Pane | What it does |
| --- | --- |
| `#overview` | The application plans and the estate check: placements, landing zones needed, licences, the read-only decision tables, capacity, quotas and transfer time. |
| `#landing-zones` | One card per platform: networks, connectivity, identity, backup and DR, governance, the relocate target; generates each landing zone. |
| `#capacity` | Totals per platform and region, quotas, licences, and estimates from your own rate card. |
| `#datacentre` | Data-centre exit: network, storage, security, operations, partners, facility, firewall and load-balancer translation, the exit sequence and lights-out. |
| `#waves` | Move groups, waves and capacity; `#waves:governance` for RACI, communications, change requests, CMDB and sign-offs. |
| `#execute` | The execution settings per path (`#execute:settings`) and the wave console (`#execute:<wave>/<stage>`). |
| `#board`, `#timeline`, `#raid`, `#reports` | The tracker, fed by the status files the generated scripts write. |
| `#generate` | The migration project: plan, landing zones, app stacks, Ansible, the execution kit, waves, governance, reports, pipeline and collectors, as one archive. |
| `#utilities` | Day-2 changes without a migration (`#utilities:<utility-id>`), and **Deploy a new service**. |

**The execution kit** (`migration/execute/`) gives every server and database a
move path from its source and target — HCX (Bulk, Replication Assisted vMotion,
vMotion, Cold, OS Assisted), cross-vCenter vMotion, VCF Import, vCenter
Converter, AWS Transform MGN, Azure Migrate, Migrate to Virtual Machines,
Compute Engine image import, Oracle Cloud Migrations, rebuild, and the native
or managed database paths (ZDM, Data Guard, DMS, the Managed Instance link,
logical replication …) — and generates the scripts that replicate, test, cut
over, switch DNS and load balancers, validate, roll back and decommission, wave
by wave. Every script applies by default (`--dry-run` is opt-in), is
idempotent, takes credentials only from the environment, a mode-600 file or a
vault hook, uses one set of verbs and exit codes, and writes
`archtoolkit.migration-status` events that the Board imports.

**Utilities** are 24 small day-2 changes — add or resize a server, add or extend
a disk, open a port, a DNS record, a load-balancer member, a patch run, tags, a
node pool, a budget, rotate a certificate, grant access, add any resource or
module, and more — each a bundle with `apply.sh` (applies by default) and
`rollback.sh`. Details in `docs/migration-and-utilities.md`.

## Decision rules

Not "which cloud is best" — nobody can answer that. Given a set of constraints,
which of the five platforms is left for each server and database, and why. Every
rule states what it looked at, which way it pushed and where the claim came
from, so any of them can be read and disagreed with on its own, and a margin
that small is reported as too close to call rather than resolved.

Rules that encode something structural score. Rules about region coverage,
sovereign offerings and pricing only report, because those change constantly and
cannot be checked from an offline toolkit. The plan's rule sets (eliminations,
shape, commercial, Microsoft and Oracle licensing, databases, report-only) run
over every item, and each application pattern adds its own rules.

The capability table checks itself: every entry carries the Terraform resource
type as well as the product name, and a test validates all of them against the
committed provider catalog. A blank cell is a genuine gap, not an omission.

Details in `docs/multicloud-matrix.md`.

## Catalogs

Both kits hand-write the parts worth getting exactly right and consult a catalog
for the rest — roughly 5,600 Terraform resources and 4,500 data sources across
ten providers, and 3,929 Ansible modules across eleven collections. Far too many
to maintain by hand, and changing with every release.

    update.bat                (areas T, A and C; or: npm run catalog:update, npm run ansible:update)

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

### Cloud service catalog

One list of every service AWS, Azure, Google Cloud and OCI offer, for the rest
of the toolkit to pick services from: the official name, a common category
(compute, containers, database, networking …) mapped from the provider's own
grouping, and the Terraform resources that build each one, plus the matching
CloudFormation types (AWS) or ARM types (Azure). A service no Terraform resource
builds stays in the list, marked `buildable: 'none'`.

    update.bat                (area L; or: npm run services:update -- --cloud aws|azure|google|oci)

runs `tools/fetch-service-catalog.mjs` once per cloud, each writing its own
`src/cloud/service-catalog-<cloud>.ts`; `src/cloud/service-catalog.ts` reads the
four as one. The services come from the providers' own public lists — the AWS
documentation product list, Price List offer index and botocore; Microsoft
Learn's resource-provider table and the Azure Retail Prices API; the Google
Cloud Services Summary and the Google APIs Discovery directory; Oracle's
price-list API and OCI API reference — and the resources are grouped by the
Terraform registry's own subcategory for each provider, at the versions in the
Terraform catalog. Names are matched exactly (brand prefix and punctuation
aside), never guessed: a registry subcategory no official list names is kept as
a service of its own, flagged as such, and every subcategory or namespace that
could not be placed is listed in the file's `unmatched`, with the reason. A list
that cannot be read leaves that cloud's file as it was.

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

## Working across the tools

The tools answer consecutive questions, and each hands its result to the next
rather than making you retype it:

    inventory  ->  sizing  ->  spec builder
    what is there   what it must become   the document that builds it

    inventory  ->  Application Migration  ->  Migration & Utilities  ->  Terraform / Ansible /
    what is there   where each app goes        how the estate moves       VCF Sizing / Network

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
- **Application Migration** — its Sources pane loads the estate's VMs as servers,
  with the app, environment and owner taken from the attributes you pick.

From a sizing
result, **Continue in the spec builder** carries the host count, storage type,
failures to tolerate, deployment scenario and the IP pool counts, so the pools a
specification emits match the sizing that justified them.

The migration flow, and what hands over at each step:

1. **VMware Inventory → Application Migration.** **Plan the applications** on the
   inventory page opens `migration.html#sources`, where **Load from the estate**
   reads the stored estate into servers. Other sources (collector files, provider
   exports, CSV) are added on the same pane.
2. **Application Migration → Migration & Utilities.** Both pages read and write one
   plan in this browser, so the saved application plans, their chosen clouds and
   the constraints are simply there on `multicloud.html`; each page links to the
   other, and a banner resolves a save made on the other page while this one had
   unsaved edits. Links run both ways: a missing landing zone on an app's Target
   tab opens `multicloud.html#landing-zones`, and the estate check links each app
   back to `migration.html#app:<slug>`.
3. **→ Terraform and Ansible.** Every generated Terraform root module
   (`terraform/<platform>/`, per app, stacked or the landing zone) carries
   `archtoolkit-terraform-settings.json`, and the generated `ansible/` carries
   `archtoolkit-ansible-settings.json`. **Load** either on the Terraform or Ansible
   page and the same stack or site opens there, editable (a Terraform stack
   rebuilds byte for byte).
4. **→ VCF Sizing.** A landing zone whose relocate target is VMware (VCF on your
   own hardware, or Amazon EVS, AVS, GCVE or OCVS) shows a first host count and
   **Open VCF Sizing →**, which sizes the fleet properly from the same stored estate.
5. **→ Network.** In a data-centre exit, the exit sequence's circuit cuts are sent to
   `network.html`, which opens on the BGP-peer or static-route change for each device,
   prefilled.
6. **Back to Inventory.** Once a tracker exists, the inventory's VM table shows a
   read-only **Migration** column (state and wave) and links to the board.

A handoff between pages applies once and lives only for the browser tab, so
reloading a page never silently re-applies a decision that has since changed.
Each step remains usable on its own; nothing requires starting at the beginning.

## Spec builder inputs

The form covers every field of the VCF 9.1 / 9.1.1 installer's `SddcSpec`, for
all eight deployment scenarios (new fleet, a new instance in an existing fleet,
converge, deferred components, VVF and VCF management services on VVF): sizing
presets, every existing component with its thumbprint, custom vDS switches with
LACP and teaming, VPC and TEP modes, per-network settings, IP pools, resource
pools, root CA chains and every FQDN override. Passwords are optional: leave
them and the builder emits `<REQUIRED>` placeholders and reports them, or let the
installer generate the ones VCF 9.1 can. Nothing secret is saved with the
settings.

## Keeping VCF sizing and the spec builder current

    npm run vcf:workbook   appliance sizes from Broadcom's Planning and Preparation
                           Workbook(s), read into src/vcf/workbook-data.ts, which
                           the sizing reads directly
    npm run vcf:schema     the spec builder's schema against the published VCF
                           Installer API; lists any field or value it lacks

`update.bat`, area V, runs both, rebuilds, runs the tests (which fail if a workbook
table the sizing relies on moved) and asks before it commits.

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
