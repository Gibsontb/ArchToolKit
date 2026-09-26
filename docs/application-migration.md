# Application Migration

`web/app/migration.html` plans every application: its servers, databases and
dependencies from any source, its non-functionals and pattern, and a target
architecture on the one cloud chosen for it (AWS, Azure, Google Cloud (GCP),
OCI or VMware Cloud Foundation). Each application is designed in the
**Multi-Cloud Decision & Onboarding Wizard** (its Design, `#app:<slug>`): one
cloud at a time, the steps on the left and that cloud's services card by card
on the right. The page generates Terraform, Ansible and a pipeline for one
application or a stack of them, in the form the chosen cloud takes, and saves
the application plans that Multi-Cloud Migration & Utilities (`multicloud.html`,
see `docs/migration-and-utilities.md`) moves. It also sets up a new service on
its own, with no inventory at all.

It replaces the retired migration rating page (intake form, six ratings,
readiness score, route, portfolio tab); its addresses still work (see
[Old addresses](#old-addresses)). The decision wizard is back, as each
application's Design.

The shell is `src/ui/application-migration-page.ts` over `src/ui/plan-shell.ts`;
which panes show is `src/ui/page-modes.ts`. Each pane is a module loaded with
`import()` the first time it opens.

## One plan, two pages

Both pages read and write one `Plan` (`archtoolkit.multicloud-plan`), kept in
IndexedDB (store `plan`, key `current`). Application Migration writes the intake
rows, the apps, the application plans (`Plan.appPlans`), the sizing overrides and
the constraints; Migration & Utilities reads them.

The page header holds:

- **Plan mode** (below), shared with the other page;
- **Open Migration & Utilities →**;
- the file bar: **Save** (JSON, YAML or TXT), **Load**, **Clear**. Credentials are
  never written to the file.

Saving is guarded: a page writes only when the stored plan is still the one it
loaded. When the other page (or another tab) saved in between and this page has
unsaved edits, a banner offers **Reload** (drop the edit) or **Keep mine**
(overwrite). With nothing unsaved the page reloads the plan silently
(`src/ui/plan-sync.ts`, `BroadcastChannel('archtoolkit.plan')`).

## Panes

The step bar reads Sources · Servers · Databases · Applications · Constraints ·
Stack. Sizing and the application workspace are panes without a step number.

| Address | Pane | What it does |
| --- | --- | --- |
| `#sources` | Sources | Brings servers, databases and apps in from any source (below), then the app grouping rules, the collectors and the dependency imports. |
| `#servers` (also `#workloads`) | Servers | Every server from every source in one grid: Name, App, Source, Type, Type check, Env, Role, OS, vCPU, RAM, Basis, Disks, IP addresses (IPv4 and IPv6), IP strategy, Rename, Upgrade, Criticality, RPO, RTO, Licence, Residency, Disposition, Depends on, Pin. Filters and paging first, then bulk edit, **Regroup** and **Confirm detected types**. |
| `#databases` | Databases | One row per database instance (engine, edition, version, hosts, size, HA, DR, features, licence, app, pinned service), and the database catalogue: every service on every platform that runs an engine. |
| `#applications` | Applications | The application catalogue: kind, pattern, owner, criticality, servers, databases, sources, the recommended cloud, the chosen cloud, margin, status and complexity. Place the selected apps on their recommendation, save them as planned, start a **New application** (greenfield), or open the **Dependency map** (a synchronous edge that crosses platforms is red). |
| `#app:<slug>[/step-<n>]` | Design | One application in the decision wizard (below). `#app:` with no application offers **Set up a new service**, **Migrate an application** and **Change a running service**. The old tab addresses (`#app:billing/target`, `/sizing`, `/generate` …) open the step that now holds that content. |
| `#constraints` (also `#requirements`) | Constraints | Platforms (allowed platforms, how many, regions, deadline, the landing-zone mode of the app plans), Compliance & sovereignty, Commercial & licensing, Operating model & exit, Resilience. Connectivity and Identity are estate foundations and live on Migration & Utilities `#landing-zones`. |
| `#sizing` | Sizing | The sizing policy (every field a dropdown), the load model's assumptions, and every app's sizing in one grid with filters, bulk **Accept** and totals. |
| `#stack` | Stack | Select apps (✓, App, Platform, Status, Components, Findings), **Select planned**, **Save application plans**, **Export selected** (an app-slice plan file, loadable on both pages), and generate one stacked project. |

With no address the page opens on Applications when the plan has apps, else on
Sources. In `single` mode with exactly one app, it opens that app's workspace.

### The application's Design: the decision wizard

The Design is the original Multi-Cloud Decision & Onboarding Wizard, rebuilt as
a reusable mount (`mountDecisionWizard` in `src/ui/decision-wizard.ts`) and
opened for one application (`src/ui/application-migration/workspace.ts`). Its
engine (`src/multicloud/wizard/engine.js`) reads the answers by element id, so
one wizard is mounted on a page at a time.

- **The header**: "Designing *app*, currently for *Microsoft Azure*", the
  application picker and the **Cloud** dropdown (AWS, Azure, Google Cloud, OCI,
  VCF 9.1). The cloud is remembered per application (`AppPlan.design.cloud`)
  and IS the app's chosen platform: switching it calls `chooseAppPlatform` (the
  cloud's component set is kept, or translated), allows the cloud if it was not
  allowed, and redoes the recommendation for that cloud only. Nothing shows the
  clouds side by side.
- **The left card**: "Step *N* · *Title*", "Step *N* of *M*", the provider's
  phase for the step, the questions two to a row with a hint under each, and
  Back / Next (Finish on the last step). An answer that came from the plan is
  marked "from the plan".
- **The right card**: "*Provider* recommendation · Based on your answers so
  far", the answer pills, Generate recommendation, Full view, Print and Save as
  Word, and the cards: Compute pattern, Data & storage, Integration & messaging,
  Ops, resilience & governance, Security & network controls, Controls & cyber
  checklist, Migration & onboarding focus (with how the provider does it),
  Migration path per server / database, Connectivity & cross-cloud connectors,
  Licensing, DR pattern by cloud, Assumptions & gaps, Sizing & environment
  footprint (the matrix and the per-server sizes), What gets built on *cloud*,
  and the Implementation playbook. It updates as you answer. Under each engine
  card, "What gets built on *cloud*" names each service with its Terraform
  resources or Ansible role, read from the real generators
  (`src/multicloud/plan/apps/built.ts`); anything the wizard names that the
  generator cannot build is listed as **named, not generated** with the reason.
  Full view, Print and Word carry all of it.

The engine's card texts use the 2026 service names (AWS Transform MGN, Amazon
EVS, Cloud Run functions, Infrastructure Manager, OCI Kubernetes Engine,
Oracle Integration 3 …) and write a VCF 9.1 recommendation in Broadcom's names
(VCF Automation, VCF Operations, NSX, vSAN, vSphere Kubernetes Service, HCX,
VMware Live Recovery).

The **initiative type** in step 1 chooses the flow, and the steps and their
words follow the chosen provider's method (`src/multicloud/wizard/wording.ts`,
`provider-flows.ts`: Azure "test migration → migrate → complete migration →
stabilization", Google Cloud "test-clone → cut-over → finalize", AWS "move
group", "hypercare", OCI "migration project", "mark migration complete", waves
labelled "(ArchToolKit wave)", VCF "Mobility Group", "switchover"; the Rs in
the provider's list, "Replace" on Azure and OCI):

| Flow | Steps |
| --- | --- |
| Migrate an application | Initiative & basics → Source & inventory (servers, databases, OS support, readiness) → Strategy (the R) → Design: data & integration → Design: non-functional, security & tooling → Design: sizing & environments (per-server sizes) → Foundation: landing zone & connectivity → Build: Terraform & Ansible → Replicate & test → Cutover & rollback → Hypercare & decommission |
| Set up a new service | Initiative & basics → What it is & its expected load (the load profile) → the three Design steps → Foundation (reused or built) → Build: Terraform, Ansible & pipeline → Deploy & smoke test → Hand over |
| Change a running service | Initiative & basics → The service & the change (a server of the app, and a change from the Utilities catalogue for the cloud) → Apply the change, with rollback (opens the utility on Migration & Utilities with the app, server and cloud filled in) → Record it |

Everything the old workspace tabs held is inside the step it belongs to, or an
**Advanced** disclosure there: the recommendation scores (step 1), the
assessment (Source), the target (Strategy), components and configuration
(Design: data), the application's non-functionals (Design: non-functional), the
sizing grid (Design: sizing), connectors, dependencies and coupling
(Foundation), and the generator (Build).

**Answers.** The questions are the original's, plus the application pattern,
the database target, the data-centre link, the cross-cloud connectors and the
link bandwidth. They are prefilled from the plan (`answersFromApp` in
`src/multicloud/estate-answers.ts`, which extends the estate mapping): the
initiative (migrate or new), the name and pattern, the architecture, the source
platform, the data pattern (from the databases), the sensitivity (from the
frameworks), the criticality, RPO and RTO (the app's, else the strictest of its
servers'), the uptime (a new app's SLO), the data-volume band (disks and
databases), the environments (the servers' or the load profile's), the R (the
app's route, else its servers' dispositions), the identity, keys and SIEM, F5
(an F5 appliance among the servers) and the data-centre link (the sites). Only
the answers the user gives are stored (`AppPlan.design.answers`), so the prefill
follows the plan and never overwrites a changed answer; they persist and sync
with the rest of the plan. The strategy answer is also the app's route, which
the decision places its workloads by, so the execution kit's path per server
follows from it.

**Answers → what gets built.** `src/multicloud/plan/apps/wizard-map.ts` maps the
answers to the app's components on the chosen cloud (`WIZARD_MAP`): the compute
pattern (the R for a migration that keeps its servers; else the architecture,
team strengths and traffic, cloud by cloud as the engine's cards choose) sets
the web and app tiers' tier pattern; the database target and the data pattern
set the data tier's; the integration pattern adds an integration component; an
F5 perimeter adds an F5 BIG-IP appliance; each cross-cloud connector adds a
`<p>_app_connector` component. A tier pattern the cloud does not have is left
and reported, and a tier pattern the user set on Components is kept
(`settings.atk_wizard_tp` records what the wizard set). Generate builds from
this.

**Connectors.** `src/multicloud/plan/apps/connectors.ts` lists every link the
app needs, named on both ends, with bandwidth, latency, availability, the
Terraform resources on each end (all in `terraform/catalog-data.ts`), the
vendor source and its verification tag (facts as of 2026-09-26):

| Pair | Connector |
| --- | --- |
| Data centre ↔ cloud | ExpressRoute / Direct Connect / Cloud Interconnect / FastConnect with a site-to-site VPN backup, or the VPN alone; built by the landing zone's Connectivity item (`<p>_mig_connectivity`) from the sites on Constraints. On VCF: the NSX Tier-0 uplinks (BGP) or NSX IPsec VPN, and HCX (the HCX provider is not in the catalogue: a runbook step). |
| Azure ↔ OCI | Oracle Interconnect for Microsoft Azure (paired regions) |
| Google Cloud ↔ OCI | Oracle Interconnect for Google Cloud (Partner Cross-Cloud Interconnect for OCI) |
| AWS ↔ Google Cloud | AWS Interconnect – multicloud (GA on AWS since 2026-04-14; Partner Cross-Cloud Interconnect for AWS is Preview on Google's side). The AWS end has no hashicorp/aws resource yet: the Direct Connect gateway is built and the interconnect is accepted by runbook. |
| Google Cloud ↔ Azure | Google Cross-Cloud Interconnect (ExpressRoute Direct on the Azure side) |
| AWS ↔ OCI | Oracle Interconnect for AWS (us-ashburn-1 ↔ us-east-1) |
| AWS ↔ Azure | AWS Interconnect – multicloud with Azure is a preview with no Terraform: the site-to-site VPN is built |
| Any pair, or when asked | Site-to-site IPsec VPN (NSX IPsec VPN on VCF) |

Each app's stack builds its own end (`<p>_app_connector`,
`src/terraform/blueprints/patterns/connectors.ts`); the peer app's stack builds
the other. The first application designed on a cloud builds that cloud's
landing zone and its connectivity (`included`); the later ones reuse it
(`shared`), unless the landing zone is designed on Migration & Utilities.

**How each cloud takes it** (`src/multicloud/plan/apps/deploy-paths.ts`,
labelled in What gets built, the Build step and the generated README): AWS and
Azure take the Terraform root module (the execution kit carries the AWS
Transform MGN, Cloud Migration Factory and Azure Migrate hand-offs); Google
Cloud gets `deploy/google-infra-manager/` and the
`gcloud infra-manager deployments apply` command; OCI gets
`deploy/oci-resource-manager-stack.zip` (the root module at the zip root, no
backend block, a `schema.yaml`) and `oci resource-manager stack create`; VCF
gets the vSphere Terraform and a VCF Automation cloud template
(`deploy/vcf-automation/`). Infrastructure Manager and Resource Manager run
Terraform 1.5, so a stack that needs 1.7 (import blocks with for_each, as a
replicated VM's adoption does) or 1.11 is not packaged for them: the README
says to apply it with the Terraform CLI.

**What Migration & Utilities reads from it**: the chosen cloud, the components
and connectors (its landing-zone cards list each platform's connectors and who
builds the landing zone), the landing-zone decision, the route and so each
server's and database's path in the execution kit, the waves and the project
zip. Application Migration also works on its own: a new service goes from the
wizard to a download without opening the other page.

### Recommendation

There is one engine: `decidePlan(plan, { extraRules: PATTERN_RULES })`
(`src/multicloud/plan/decide/`, with the pattern rules of
`src/multicloud/plan/patterns/rules.ts`) scores every item on every platform and
service, and the per-app view is read from its output
(`src/multicloud/plan/apps/recommend.ts`). An app's score on a platform is the sum
of its items' best options there; an item with no option makes the platform
ineligible and the eliminating rule is named. The recommendation is read from a
decision made without the app's own choice, so a choice never recommends itself.
Choosing a platform writes `AppPlan.platform`, and the rule `app.chosen-platform`
then keeps every item of the app on it (an item pinned elsewhere keeps its pin).
The rules are described in `docs/multicloud-matrix.md`.

## Plan modes

The **Plan mode** dropdown is in both page headers (`Plan.mode`). A pane shows when
the mode needs it **or** the plan already has data for it, so changing the mode
never hides or deletes work.

| Mode | Label | Application Migration shows |
| --- | --- | --- |
| `dc-exit` | Data-centre exit | Everything. |
| `migrate` (default) | Migrate applications | Everything. |
| `single` | One application or service | Everything; with no address, and exactly one app in the plan, the page opens that app's workspace. |
| `new` | New services only (nothing moves) | Sources, Servers and Databases are hidden until the plan has something that migrates (or servers / databases); Applications starts with **New application**, and a new app's Design runs the new-service flow. |

Apps are `migrate` or `new` (`AppPlan.origin`) whatever the mode, so a plan can mix both.

## Sources

Every source lands in the same rows (servers, databases, apps). The Sources pane
offers, in order:

1. **Import the old portfolio** — the retired rating page's apps, read from this browser's
   IndexedDB store `portfolio` (never deleted), or a portfolio file it exported (JSON or CSV).
2. **The plan** — its name and the merge mode every import uses.
3. **VMware estate (RVTools)** — the estate the Inventory page imported (RVTools or the
   PowerCLI collector JSON), with scope, powered-off handling and the app / env / owner attributes.
4. **Provider and collector files** — each read by column header, never by position, with
   its layout's verification shown.
5. **CSV and manual entry** — the templates `workloads.csv`, `databases.csv`, `apps.csv`
   and `sites.csv`, a CSV import, or rows typed on Servers and Databases.
6. **App grouping rules** and **Regroup the servers now**.
7. **Collectors** — the bundle per source platform, and the coupling collectors.
8. **Coupling files** and **Dependencies from network flows** — proposed as dependencies in a
   review grid; only the ticked rows are written.

The intake adapters (`src/multicloud/plan/intake/`):

| Adapter id | Label | Module |
| --- | --- | --- |
| `vmware` | VMware estate (RVTools, PowerCLI or vCenter) | `intake/from-inventory.ts` |
| `csv` | CSV file (workloads, databases or apps) | `intake/csv.ts` |
| `portfolio` | Migration portfolio (this browser) | `intake/from-portfolio.ts` |
| `discovery` | Collector files (Hyper-V, SCVMM, Nutanix AHV, KVM, Proxmox, oVirt / OLVM, Xen, physical, AWS, Azure, Google Cloud (GCP), OCI) | `intake/sources/discovery.ts` |
| `azure-migrate-csv` | Azure Migrate CSV (import template or assessment export) | `intake/sources/azure-migrate-csv.ts` |
| `migration-center-csv` | Google Migration Center tables (vmInfo, diskInfo, perfInfo, tagInfo) | `intake/sources/migration-center-csv.ts` |
| `aws-import-csv` | AWS Migration Hub import template (CSV) | `intake/sources/aws-import-csv.ts` |
| `ahv-csv` | Nutanix Prism Central VM export (CSV) | `intake/sources/ahv-csv.ts` |
| `mgn-import-csv` | AWS Transform MGN inventory import CSV | `intake/sources/tier2.ts` |
| `cmf-intake-csv` | Cloud Migration Factory on AWS intake form (CSV) | `intake/sources/tier2.ts` |

Two more readers add to rows already in the plan rather than creating them: a
performance time series from any monitoring tool (`intake/sources/perf-csv.ts`,
utilisation by server, then the sizing basis is re-applied) and the Azure Migrate
agentless dependency export (`intake/sources/azure-dependency-csv.ts`, proposed as
dependency edges; nothing is accepted automatically).

**The discovery file.** Every collector writes the same JSON (`archtoolkit.discovery`
v1), so there is one parser. The collectors (`intake/sources/collectors.ts`) are:

| File | Platform | Runs on |
| --- | --- | --- |
| `collect-hyperv.ps1` | Hyper-V | a Hyper-V host or cluster node |
| `collect-scvmm.ps1` | Hyper-V (SCVMM) | a host with the VMM console |
| `collect-ahv.sh` | Nutanix AHV | the migration controller (Prism Central v4 API) |
| `collect-libvirt.sh` | KVM | a KVM host |
| `collect-proxmox.sh` | Proxmox VE | a Proxmox VE node |
| `collect-ovirt.sh` | oVirt / RHV / OLVM | the migration controller |
| `collect-xen.sh` | Xen / XCP-ng | the pool master |
| `collect-windows.ps1`, `collect-linux.sh` | any guest (physical included) | each guest; also installed software, services, listening ports, connections and utilisation |
| `collect-aws.sh`, `collect-azure.sh`, `collect-gcp.sh`, `collect-oci.sh` | the clouds | the migration controller |
| `collect-k8s.sh` | Kubernetes | the migration controller (kubectl context) |

Collectors take credentials from the environment (or the cloud CLIs' own credential
chains) and never write them; the file carries no user name, collector host or path,
and `collectedAt` is a date only. IBM Power, SPARC, HP-UX (Itanium, PA-RISC) and
mainframe have no collector: their intake is a CSV with `origin` set.

## Sizing

Every component is sized by each engine that applies (`src/multicloud/plan/sizing/`):
servers, storage per volume, Kubernetes, databases, SAP, VDI, file, VCF hosts, and the
load model for new apps. Utilisation (when a collector or performance file gave it)
wins over nameplate, per the policy on `#sizing`. Each row shows the demand, the
recommendation, whether it fits, the reasons and up to three alternatives. An
**Override** is stored in `Plan.sizing.overrides` and wins over the engines (one that
fails the demand is kept with a warning); **Accept all** clears them.

## Generation: per app and stacked

One app and a stack of apps are the same code with a different selection:
`generateAppStack(plan, appIds, options)` (`src/multicloud/plan/apps/generate.ts`).
It places each app on its chosen cloud (else its recommendation, so an app never
straddles clouds) and writes:

```
<app-slug>/                    one app  (a stack: <plan-slug>-apps/)
  README.md
  app-plan.json                the slice as a plan file, loadable on both pages
  decision/app-record.md       each app's comparison and reasons
  terraform/<platform>/        one root module per platform, every selected app on it
    …                          the stack's .tf files, README.md
    cutover.auto.tfvars.example
    archtoolkit-terraform-settings.json   opens this stack on the Terraform page
  ansible/                     site.yml, playbooks, roles, inventories, group_vars,
                               vault.yml.example, archtoolkit-ansible-settings.json
  <CI/CD files>                the pipeline for the chosen system (GitHub Actions,
                               Azure DevOps or GitLab CI) and the state-store bootstrap
```

The landing zone is **shared** (the app stacks read `var.landing_zone`, filled from the
landing-zone project with the one-line `terraform output -json landing_zone` bridge
written in the README) or **included** (each stack builds its own). Before generating,
the schema of every resource and module component is fetched, so a component added from
the pickers is built into the stack; an error finding blocks Download and names the app.
The archive is dated from the plan's `savedAt`: the same plan gives the same bytes, and
nothing about the machine or the user is written. Everything applies as generated;
credentials come from environment variables, Ansible Vault (`vault_*` with
`no_log: true`), sensitive Terraform variables or the cloud's own secret stores.

## Old addresses

| Address | Goes to |
| --- | --- |
| `migration.html#intake`, `#ratings`, `#results`, `#portfolio`, `#help` (the retired rating page) | Applications (they are `alsoMatches` of `#applications`) |
| `migration.html#workloads` | Servers |
| `migration.html#apps` | Applications |
| `migration.html#requirements` | Constraints |
| `migration-portfolio.html` | `migration.html#sources` (redirect) |
| `multicloud.html#sources`, `#workloads`, `#databases`, `#apps`, `#requirements`, `#decision`, `#design` (the retired planner's steps) | `migration.html#sources`, `#servers`, `#databases`, `#applications`, `#constraints`, `#applications`, `#applications` (`location.replace`) |

## Where it hands over

- **From VMware Inventory**: **Plan the applications** opens `migration.html#sources`,
  whose VMware estate card reads the estate the Inventory page stored.
- **To Migration & Utilities**: the saved application plans, through the shared plan.
  Missing landing zones link to `multicloud.html#landing-zones`; the Coupling tab links
  to `multicloud.html#raid`.
- **To the Terraform and Ansible pages**: each generated `terraform/<platform>/` holds
  `archtoolkit-terraform-settings.json`, and `ansible/` holds
  `archtoolkit-ansible-settings.json`. **Load** either on its page to see and edit the
  same stack or site that was generated.
