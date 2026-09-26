# Multi-Cloud Migration & Utilities

`web/app/multicloud.html` (nav label **Migration & Utilities**) takes the
application plans made on Application Migration (`docs/application-migration.md`)
and the estate, and runs the move: the placement check, landing zones, waves,
execution per path, test, cutover, rollback, DNS and load-balancer switching,
validation, decommission and a tracking board. Its second area, **Utilities**, makes
day-2 changes without a migration, each as a small Terraform and / or Ansible bundle.

The file name `multicloud.html` is kept from the retired Multi-Cloud Decision &
Onboarding Wizard, which this page replaces; the wizard's old addresses are sent
on (see [Old addresses](#old-addresses)).

The shell is `src/ui/migration-utilities-page.ts` over `src/ui/plan-shell.ts`; which
panes show is `src/ui/page-modes.ts`. It shares the plan, the plan-mode dropdown, the
file bar and the conflict banner with Application Migration (see "One plan, two pages"
there). It also owns two records of its own in the same IndexedDB store: the
**tracker** (key `tracker`) and the **utility log** (key `changes`).

## Panes

The step bar has two areas, **Migrate** and **Utilities**.

| Address | Pane | What it does |
| --- | --- | --- |
| `#overview` | Overview | The saved application plans, their platforms and statuses, and the estate check (read-only; overrides are made per app on Application Migration): where each app lands, the platforms in use against the maximum, the landing zones needed and their state, licence totals, the decision tables (each row links to `migration.html#app:<slug>`), capacity and quotas, and transfer time. |
| `#landing-zones` | Landing zones | One card per platform the plan lands on: region, name prefix, account / subscription / project / compartment, networks and carved subnets, zones, bastion, log retention; the landing-zone mode (**shared** or **included**); connectivity and identity (the estate-wide Connectivity and Identity cards sit above the platform cards); backup and DR; the relocate target; governance (tag enforcement, required tags, baseline policies, budgets); and **Generate landing zone (<platform>)**, which downloads `terraform/<platform>/`. |
| `#capacity` | Estate capacity | Totals per platform, landing zone and region; quota checks; licence counts; estimates from your own rate card. |
| `#datacentre` | Data centre | Data-centre exit: everything in the building that is not a server. Sub-views `#datacentre:network`, `storage`, `security`, `operations`, `other`, `partners`, `facility`, `netsec` (firewall and load-balancer translation from Cisco ASA / FTD, PAN-OS, FortiOS, F5 BIG-IP or CSV), `sequence` (exit waves, circuit cuts, lights-out checklist, the exit report) and `people`. |
| `#waves` | Waves | Wave settings, the team's capacity per window, capacity per wave and what limited it, move groups against waves (a group's wave can be pinned), and the data-centre exit waves. `#waves:governance`: RACI, communications, change requests, the CMDB and asset register, and the sign-off matrix. |
| `#execute` | Execute | `#execute:settings`: the execution settings per path (stored in `plan.execution`). `#execute:<wave>/<stage>`: the wave console, stages replicate, test, cutover, validate and decommission. |
| `#board` | Board | Import status files (zip, jsonl, json; drag and drop) and watch the states change; save, load or clear the tracker file. Filters (Wave, App, Platform, Path, State, Flag, Owner) and three views: by workload, by wave (state bar and G1–G4 gate chips), by app. Manual transitions need a reason and are recorded as events with `source: manual`. |
| `#timeline` | Timeline | The timeline, the T-minus gates, the burn-down and the cumulative flow. |
| `#raid` | RAID | Risks, assumptions, issues, decisions and blockers. |
| `#reports` | Reports | Status reports and metrics, the evidence pack, and **Reconcile with estate** after a newer RVTools import. |
| `#generate` | Generate | The migration project as one archive (below). |
| `#utilities` | Utilities | The utility catalogue, the utility log, and **Deploy a new service**. A utility's form is `#utilities:<utility-id>` (for example `#utilities:add-disk`). |

With no address the page opens on the Board when the tracker has any item past
`planned`, else on Overview.

When a tracker exists, the VMware Inventory page's VM table gains a read-only
**Migration** column (`<state> · wave <n>`) and an **Open the board** link to
`multicloud.html#board`.

## Plan modes

The same **Plan mode** dropdown as Application Migration. A pane shows when the mode
needs it **or** the plan has data for it; mode changes never delete data.

| Mode | Label | Migration & Utilities shows |
| --- | --- | --- |
| `dc-exit` | Data-centre exit | Everything, including Data centre; waves include the exit waves. |
| `migrate` (default) | Migrate applications | Everything but Data centre (unless the plan has data-centre data). |
| `single` | One application or service | As `migrate`, and the programme views (Estate capacity, Timeline) are hidden unless the plan has more than one app. |
| `new` | New services only (nothing moves) | Waves, Execute and the Board are hidden until the plan has something that migrates (the Board also comes back when the tracker has items). **Deploy a new service** is the path. |

## Old addresses

| Address | Goes to |
| --- | --- |
| `multicloud.html#sources` | `migration.html#sources` |
| `multicloud.html#workloads` | `migration.html#servers` |
| `multicloud.html#databases` | `migration.html#databases` |
| `multicloud.html#apps` | `migration.html#applications` |
| `multicloud.html#requirements` | `migration.html#constraints` |
| `multicloud.html#decision`, `#design` | `migration.html#applications` |
| `multicloud.html#waves`, `#generate` | stay on this page |
| `multicloud.html#changes` (an earlier name for Utilities) | `#utilities` |

The redirects use `location.replace`, on load and when such an address is typed later.

## Move paths

Execution needs to know which tool moves each item: its **path**
(`src/multicloud/plan/execute/paths.ts`: `resolveMovePath` / `movePathFor` for a
server, `resolveDbPath` / `dbPathFor` for a database). A path override
(`plan.execution.pathOverrides`) that is not valid for the item's source, target or
OS is refused with the reason, and the default applies.

### Server paths (`MovePath`)

`hcx-bulk`, `hcx-rav`, `hcx-vmotion`, `hcx-cold`, `hcx-osam`, `xvc-vmotion`,
`vcf-import`, `vcf-converter`, `aws-mgn`, `azure-migrate`, `azure-migrate-hyperv`,
`azure-migrate-agent`, `gcp-m2vm`, `gcp-image-import`, `oci-ocm`, `rebuild`,
`with-db`, `retire`, `specialist`, `deploy`, and the pattern paths `sap-hsr`,
`sap-backup-restore`, `saas-exchange`, `saas-sharepoint`, `k8s-velero`,
`appliance-rebuild`.

The default, first match wins:

| Condition | Path |
| --- | --- |
| not moved and retired | `retire` |
| not moved and replaced by a product (repurchase) | `saas-exchange` / `saas-sharepoint` for Exchange / SharePoint (Online), else `retire` |
| a new service (or a new app's sized placeholder) | `deploy` |
| method `rebuild` | `rebuild` |
| method `managed-db` (the server is not moved; its database is) | `with-db` |
| a non-x86 source (IBM Power, SPARC, Itanium, PA-RISC, mainframe) or a legacy Unix / mainframe workload type | `specialist` |
| a component of a pattern: SAP HANA | `sap-hsr` (or `sap-backup-restore`) |
| Kubernetes / OpenShift nodes | `k8s-velero` |
| a network appliance | `appliance-rebuild` |
| vSphere to VCF, the source cluster listed in `plan.execution.vcfImportClusters` | `vcf-import` |
| vSphere to VMware, powered off | `hcx-cold` |
| vSphere to VMware, latency-critical app or tier 0 | `hcx-rav` |
| vSphere to VMware, otherwise | `hcx-bulk` |
| anything else | the source × target matrix below |

`hcx-vmotion`, `hcx-rav` and `xvc-vmotion` need a powered-on VM; `xvc-vmotion` and
`vcf-import` need VCF on premises as the target; `hcx-vmotion` and `hcx-rav` need the
network extended (`exec.hcx.needs-extension` otherwise). A path whose tool does not
support the guest OS is not valid.

**Source × target** (`src/multicloud/plan/execute/matrix.ts`; the default first,
then the alternatives; `rebuild` is always valid):

| Source ↓ / Target → | VCF (on premises) | AVS / GCVE / OCVS / EVS | AWS | Azure | Google Cloud (GCP) | OCI |
| --- | --- | --- | --- | --- | --- | --- |
| vSphere | `hcx-bulk` / `hcx-rav`, `hcx-vmotion`, `hcx-cold`, `xvc-vmotion`, `vcf-import` | `hcx-bulk` / `hcx-rav`, `hcx-vmotion`, `hcx-cold` | `aws-mgn` | `azure-migrate` / `azure-migrate-agent` | `gcp-m2vm` | `oci-ocm` |
| Hyper-V | `hcx-osam` / `vcf-converter` | `hcx-osam` | `aws-mgn` | `azure-migrate-hyperv` / `azure-migrate-agent` | `gcp-image-import` | `rebuild` |
| Nutanix AHV | `vcf-converter` (unconfirmed) | `vcf-converter` (unconfirmed) | `aws-mgn` | `azure-migrate-agent` (unconfirmed) | `gcp-image-import` | `rebuild` |
| KVM | `hcx-osam` / `vcf-converter` | `hcx-osam` / `vcf-converter` | `aws-mgn` | `azure-migrate-agent` | `gcp-image-import` | `rebuild` |
| Proxmox VE | `vcf-converter` | `vcf-converter` | `aws-mgn` | `azure-migrate-agent` | `gcp-image-import` | `rebuild` |
| oVirt / RHV / OLVM | `vcf-converter` | `vcf-converter` | `aws-mgn` | `azure-migrate-agent` | `gcp-image-import` | `rebuild` (OLVM as a source unconfirmed) |
| Xen | `vcf-converter` | `vcf-converter` | `aws-mgn` | `azure-migrate-agent` | `gcp-image-import` | `rebuild` |
| Physical x86 | `vcf-converter` | `vcf-converter` | `aws-mgn` | `azure-migrate-agent` | `rebuild` | `rebuild` |
| AWS EC2 | `vcf-converter` (unconfirmed) | `vcf-converter` (unconfirmed) | `rebuild` (in-cloud) | `azure-migrate-agent` | `gcp-m2vm` | `oci-ocm` |
| Azure VM | `vcf-converter` (unconfirmed) | `vcf-converter` (unconfirmed) | `aws-mgn` | `rebuild` (in-cloud) | `gcp-m2vm` | `rebuild` |
| Google Cloud (GCP) | `vcf-converter` (unconfirmed) | `vcf-converter` (unconfirmed) | `aws-mgn` | `azure-migrate-agent` | `rebuild` (in-cloud) | `rebuild` |
| OCI | `vcf-converter` (unconfirmed) | `vcf-converter` (unconfirmed) | `aws-mgn` | `azure-migrate-agent` (unconfirmed) | `gcp-image-import` | `rebuild` (in-cloud) |
| Power, SPARC, Itanium, PA-RISC, mainframe | `specialist` | `specialist` | `specialist` | `specialist` | `specialist` | `specialist` |
| Other / unknown | `rebuild` | `rebuild` | `rebuild` | `rebuild` | `rebuild` | `rebuild` |

"Unconfirmed" cells carry verification `I` and raise `exec.path.unverified`. A rebuild
forced by a missing tool raises `exec.path.no-replication-tool` (`exec.oci.source-unsupported`
for OCI).

### Database paths (`DbMovePath`)

`with-vm`, `oracle-zdm-physical`, `oracle-zdm-logical`, `oracle-dataguard`,
`oracle-rman`, `oracle-datapump`, `oci-dms`, `aws-dms`, `azure-dms`,
`azure-pg-migration`, `gcp-dms`, `sql-ag-seeding`, `sql-log-shipping`,
`sql-backup-url`, `sql-mi-link`, `sql-mi-lrs`, `sql-rds-native`, `pg-logical`,
`pg-dump`, `mysql-replication`, `mysql-dump`, `db2-backup-restore`, `db2-hadr`,
`ase-dump-load`, `informix-backup-restore`, `mongo-mongosync`, `redis-replicaof`,
`redis-rdb-import`, `cassandra-zdm-proxy`, `cassandra-ring-join`,
`es-snapshot-restore`, `es-reindex-remote`.

A database on IaaS whose host servers are all replicated or relocated moves inside
them: `with-vm` (the engine's native path is the alternative). Otherwise the engine and
the target service decide:

| Engine | Target service | Default | Alternatives |
| --- | --- | --- | --- |
| Oracle | OCI Base Database, ExaCS, Oracle Database@ Exadata / Base Database | `oracle-zdm-physical` | `oracle-dataguard`, `oracle-rman` |
| Oracle | Autonomous Database (OCI, @AWS, @Azure, @Google Cloud) | `oracle-zdm-logical` | `oci-dms`, `oracle-datapump` |
| Oracle | Amazon RDS / RDS Custom | `aws-dms` | `oracle-datapump` |
| Oracle | a rebuilt VM | `oracle-dataguard` | `oracle-rman`, `oracle-datapump` |
| SQL Server | Azure SQL Managed Instance, 2016–2025 source | `sql-mi-link` | `sql-mi-lrs` |
| SQL Server | Azure SQL Managed Instance, older source | `sql-mi-lrs` | |
| SQL Server | Azure SQL Database | `azure-dms` | |
| SQL Server | Amazon RDS | `sql-rds-native` | `aws-dms` |
| SQL Server | Cloud SQL | `gcp-dms` | |
| SQL Server | a rebuilt VM, with an availability group / without | `sql-ag-seeding` / `sql-log-shipping` | each other, `sql-backup-url` |
| PostgreSQL | Amazon RDS / Aurora | `aws-dms` | `pg-logical` |
| PostgreSQL | Azure Database for PostgreSQL Flexible Server | `azure-pg-migration` | `pg-logical` |
| PostgreSQL | Cloud SQL / AlloyDB | `gcp-dms` | `pg-logical` |
| PostgreSQL | OCI PostgreSQL, or a VM | `pg-logical` | `pg-dump` |
| MySQL / MariaDB | Cloud SQL | MySQL `gcp-dms`; MariaDB `mysql-dump` | |
| MySQL / MariaDB | HeatWave | MySQL `oci-dms`; MariaDB `mysql-dump` | `mysql-replication` |
| MySQL / MariaDB | Amazon RDS / Aurora | `mysql-replication` | `aws-dms`, `mysql-dump` |
| MySQL / MariaDB | Azure Database for MySQL, or a VM | `mysql-replication` | `mysql-dump` |
| Db2 | Amazon RDS for Db2 / a VM | `db2-backup-restore` / `db2-hadr` | `db2-backup-restore` |
| SAP ASE, Informix | a VM | `ase-dump-load`, `informix-backup-restore` | |
| MongoDB | Amazon DocumentDB / Azure DocumentDB, Autonomous Database (MongoDB API) or a VM | `aws-dms` / `mongo-mongosync` | |
| Redis | a VM / a managed cache | `redis-replicaof` / `redis-rdb-import` | `redis-rdb-import` |
| Cassandra | Keyspaces / Azure Managed Instance for Apache Cassandra or a VM | `cassandra-zdm-proxy` / `cassandra-ring-join` | `cassandra-zdm-proxy` (VM) |
| Elasticsearch / OpenSearch | Amazon OpenSearch, OCI OpenSearch or a VM | `es-snapshot-restore` | `es-reindex-remote` |
| SAP HANA | | moves with its server on `sap-hsr` | |

### Warnings a path carries

`pathFindings` adds: **no automatic fallback** for `aws-mgn` (AWS Transform MGN has no
failback), `hcx-rav`, `gcp-m2vm`, `oracle-zdm-physical` and `oracle-zdm-logical`; a
tool that is **retired, closed to new customers or renamed** (for example "AWS
Application Migration Service is now AWS Transform MGN"); and for HCX paths,
Broadcom's **network underlay minimums** (vMotion and Replication Assisted vMotion
250 Mbps, or 150 Mbps with WAN Optimization, which is in VCF 9.1 and not 9.0; Bulk,
Cold and OS Assisted Migration 50 Mbps; loss and latency limits) against the slowest
site link.

## The execution kit

`executionKit(plan, decision, design, waves)` (`src/multicloud/plan/execute/kit.ts`)
writes `migration/execute/`: every workload and database gets its path, the manifest
lists the items with a path, each item goes to the generator registered for its path
(`execute/registry.ts`), and the kit adds its libraries, schema, manifest, controller
check and README. The files are sorted and carry no footprint, so the same plan gives
the same kit byte for byte. Only the files the plan's paths need are written:

```
migration/execute/
  README.md                    prerequisites, credential variables and vault hooks, verbs,
                               options, exit codes, the paths in this kit, the warnings
  controller-check.sh          checks every tool, PowerShell module and Ansible collection
                               the plan's paths need; exits 3 naming what is missing
  lib/atk.sh  lib/Atk.psm1     the shared library that enforces the contract
  status.schema.json           JSON Schema of the status event
  manifest/items.json          every in-scope item: path, script, source, target, DNS,
  manifest/items.tsv           load balancer, services, checks (the tsv is for bash without jq)
  manifest/waves.json          the waves: window, items, gates, freeze
  hooks/README.md              put executables in hooks/<wave>/pre-cutover.d/ or post-cutover.d/
  source/                      source adapters: vsphere.ps1 hyperv.ps1 ahv.sh kvm.sh proxmox.sh
                               ovirt.sh xen.sh physical.sh aws.sh azure.ps1 gcp.sh oci.sh,
                               operator.sh (non-x86 and unknown: every verb is an operator step)
  paths/
    core/core.sh               retire, with-db, with-vm, specialist
    hcx/hcx.ps1                hcx-bulk, hcx-rav, hcx-vmotion, hcx-cold, hcx-osam
                               (+ network-mappings.json, mobility-groups.json, underlay.json)
    xvc-vmotion/xvc.ps1
    vcf-import/vcf-import.ps1
    vcf-converter/converter.ps1  (+ jobs/<item>.json)
    rebuild/rebuild.sh         (+ data-sets.csv)
    aws-mgn/mgn.sh             (+ replication-template.json, servers.json, mgn-import.csv,
                               cmf-intake.csv)
    azure-migrate/azmigrate.ps1  azure-migrate, azure-migrate-hyperv, azure-migrate-agent
    gcp-m2vm/m2vm.sh  gcp-m2vm/image-import.sh
    oci-ocm/ocm.sh             (+ target-assets.csv, target-assets.json)
    sap/sap.sh  m365/exchange.ps1  m365/sharepoint.sh  velero/velero.sh  appliance/appliance.sh
    db/<one script per database path in use>  (+ zdm/<db>.rsp, aws-dms/<db>.table-mappings.json,
                               README-*.md; db2/, ase/, informix/, mongo/, redis/,
                               cassandra/, es/ for the other engines)
    pending/pending.sh         a path whose generator is not installed: every verb fails and says so
  dns/dns.sh  dns/records.csv  records.csv: fqdn,type,old,new,ttl,provider,zone,private,item
  lb/lb.sh    lb/members.csv
  ansible/                     freeze.yml unfreeze.yml baseline.yml validate.yml identity.yml
                               windows-dns.yml, and per path mgn-agent.yml hcx-sentinel.yml
                               rebuild-copy.yml rebuild-services.yml …
  waves/wave-<n>/              wave.json precheck.sh replicate.sh test.sh cutover.sh commit.sh
                               rollback.sh validate.sh decommission.sh gates.md runbook.md
  rightsize-after.sh
status/                        created at run time beside migration/: events.jsonl, gates/,
                               ids/, logs/, baseline/, dns/ …
```

Bash 4.4 or later (with `jq`) drives the AWS, Google Cloud (GCP) and OCI CLIs, REST
calls, the open-source databases, ZDM and every wave orchestrator; PowerShell 7 is used
where the tool only exists there (HCX and vCenter through VCF PowerCLI, Az.Migrate,
the SQL Server tooling, Hyper-V). One Linux host, the migration controller, runs the kit.

Besides the scripts, the kit writes each provider's own execution format where one
exists: the MGN import CSV and the Cloud Migration Factory intake form, the OCI target
assets, the HCX mobility groups.

### The script contract

Every script the kit generates (`execute/contract.ts`, enforced at run time by
`lib/atk.sh` and `lib/Atk.psm1`, and statically by `contractViolations`, which runs
over every generated file):

1. **It applies by default.** `--dry-run` (`-DryRun`) is opt-in: every mutating call is
   printed instead of run, read-only calls still run, and each step writes an event
   with `dryRun: true`. There is no `--yes`, no prompt and no "first run only prints".
2. **It is idempotent.** Each mutating step reads the current state first and writes a
   `skipped` event when the item is already there. Anything created is named
   `atk-<plan-id-8>-<wave>-<item-slug>` and found by that name or tag; `status/ids/`
   is only a cache. A re-run after a failure resumes.
3. **Credentials come from the environment or a vault, never from a file the kit
   writes.** `atk_secret NAME` / `Get-AtkSecret NAME` returns `$NAME`, else the
   contents of `$NAME_FILE` (which must be mode 600, else exit 3), else the output of
   `$ATK_VAULT_CMD NAME`. Cloud CLIs use their own credential chains. Secrets go to
   tools on stdin or in the environment, never as arguments, and are redacted from the
   logs.
4. **It writes machine-readable status** (below).
5. **It can roll back**: every path script has a `rollback` verb, and every wave a
   `rollback.sh`.
6. **One set of verbs**: `prepare`, `replicate`, `test`, `test-cleanup`, `cutover`,
   `commit`, `rollback`, `finalize`, `status`; **one set of options**: `--wave N`,
   `--item <id|name>` (repeatable), `--dry-run`, `--gate-override "<reason>"`, `--once`
   (replicate and status: poll once and exit, for cron), `--timeout <minutes>`.
7. **One set of exit codes**:

   | Code | Meaning |
   | --- | --- |
   | 0 | Everything succeeded (or was already done). |
   | 1 | Anything else (a lock held by another run, an unexpected error). |
   | 2 | Usage: an unknown verb, option or item. |
   | 3 | A tool, module or credential is missing. |
   | 4 | A gate is not open. |
   | 5 | A pre-check failed. |
   | 10 | Some items failed; the others succeeded (see the events). |

8. **A lock per wave and a redacted log per run** (`status/logs/<runId>.log`).
9. **No footprints**: no author, date, user, host or path in any generated file; events
   carry only the time of the event.

The source adapters (`source/`) keep the same contract with their own verbs:
`state`, `stop`, `start`, `snapshot`, `delete`, `rename`, `tools-remove`.

### Gates

The wave scripts check gate files `status/gates/wave-<n>-<gate>.json`
(`archtoolkit.migration-gate`), which the tracker exports. A gate is named `G1`–`G5`
or by its alias: **G1 Ready** (`ready`), **G2 Go** (`go`, checked by `cutover.sh`
before the freeze; exit 4 when closed), **G3 Commit** (`commit`, the point of no
return, needed by `commit.sh`), **G4 Decommission** (`decommission`) and **G5
Lights-out** (`lights-out`, data-centre exit). `--gate-override "<reason>"` proceeds
through a closed gate and records the reason. Production waves also wait for the
landing-zone gate, `status/gates/programme-landing-zone.json`.

### Status events and the tracker

`atk_event` appends one line per step to `status/events.jsonl`, under a lock:

```json
{ "kind": "archtoolkit.migration-status", "v": 1, "planId": "…", "runId": "…",
  "at": "<UTC time>", "wave": 3, "item": "w:app01", "name": "app01",
  "path": "aws-mgn", "step": "cutover", "outcome": "succeeded", "dryRun": false,
  "state": "cut-over", "detail": "…", "data": { "targetIpv4": "…" } }
```

- `path` is a move path, a database path, or a channel: `orchestrator`, `dns`, `lb`,
  `change` (a utility) or `gate`.
- `step` is one of `precheck`, `prepare`, `replicate`, `in-sync`, `test`,
  `test-cleanup`, `freeze`, `final-sync`, `stop-source`, `cutover`, `start-target`,
  `adopt`, `dns-switch`, `lb-switch`, `post-config`, `identity`, `validate`, `commit`,
  `accept`, `rollback`, `decommission`, `finalize`, `notice`, `gate`, `deploy`, `manual`.
- `outcome` is `started`, `succeeded`, `failed` or `skipped`.
- `state` moves an item through `planned`, `prepared`, `replicating`, `in-sync`,
  `testing`, `tested`, `cutting-over`, `cut-over`, `validated`, `accepted`,
  `decommissioned`.

No user, host or path goes in an event. The Board imports the files (`*.jsonl`,
`*.json`, a zip of `status/`, and the Ansible validation reports
`archtoolkit.validation`) into the tracker (`src/multicloud/plan/track/import.ts`):
events of another plan are rejected, unknown items are matched by name, duplicates are
dropped (importing the same file twice changes nothing), and the item states are
re-derived. The tracker file itself is `archtoolkit.migration-tracker`.

## Generate: the migration project

`#generate` picks the parts, generates, shows the file tree, a viewer and each part's
findings, and downloads one zip (or tar.gz) dated from the plan's `savedAt`
(`src/ui/multicloud/project.ts`). Everything sits under `<plan-slug>/`:

| Part | Folder | What it holds |
| --- | --- | --- |
| Plan | `plan/` | `plan.json`, the plan itself, loadable on both pages. |
| Landing zones | `terraform/<platform>/` | The landing zone, identity, connectivity and governance per platform, with `archtoolkit-terraform-settings.json` for the Terraform page. |
| App stacks | `apps/<platform>/<env>/` | Every app on a platform in one root module per environment, on the shared landing zone. |
| Per-app projects | `apps/slices/<app>/` | One project per selected application (as generated on Application Migration). |
| Ansible | `ansible/` | The site, inventories and roles for every planned server, with `archtoolkit-ansible-settings.json` for the Ansible page. |
| Execution kit | `migration/execute/` | Above. |
| Waves | `migration/` | `waves.csv`, `move-groups.csv`, and `exit-sequence.md` in data-centre exit mode. |
| Governance | `governance/` | RACI, communications per wave, change requests, CMDB feeds and the operations runbooks. |
| Reports | `reports/`, `capacity/` | The executive summary (Markdown and HTML), the capacity grids, `capacity/fetch-quotas.sh`. |
| Pipeline | `images/`, `ci/`, `backend-bootstrap/` | Golden images (Packer), the CI/CD pipeline (GitHub Actions, GitLab CI or Azure DevOps) and the state-store bootstrap. |
| Collectors | `discovery/`, `coupling/` | The discovery and coupling collectors to run on the sources. |

plus `README.md`. Every part is ticked by default except Per-app projects, which need
apps picked.

## Utilities

Small day-2 changes without a migration (`src/multicloud/change/`). Each utility is a
form (dropdowns fed from the plan, the landing zones, the app plans and the tracker's
cut-over targets) that produces a **change bundle**:

```
change-<yyyymmdd>-<utility>-<target-slug>/
  terraform/             a root module on the landing-zone variables contract; existing
                         resources found by data sources (atk_* tags and names), never pasted ids
  ansible/               a playbook and its inventory (group atk_change)
  scripts/               PowerShell (VCF PowerCLI) when a step needs it
  stack/                 when the change is to something an app stack manages: the stack's
                         files before and after, and the diff (the plan is updated, not drifted)
  apply.sh               applies by default; --dry-run = terraform plan + ansible-playbook --check --diff
  rollback.sh            undoes it
  expire.sh              only with an expiry date: runs rollback.sh on or after it
  README.md  change.json the inputs (to regenerate), the plan update, the change request's plans
  lib/  manifest/        the execution kit's library and a one-item manifest
```

The scripts keep the execution kit's contract and write status events with
`path: "change"` and `item: <change id>` (step `deploy` for the apply, `rollback` for
the rollback). The **utility log** (grid `Id | Utility | Target | Summary | Generated |
Applied | Rolled back | CR`, key `changes`) imports those events to fill in Applied and
Rolled back.

The catalogue (`UTILITIES`), by id:

| Id | Utility | Platforms |
| --- | --- | --- |
| `add-server` | Add a server / VM | all five |
| `resize-server` | Resize a server | all five |
| `add-disk` | Add a disk | all five |
| `extend-disk` | Extend a disk | all five |
| `add-database` | Add a database | all five |
| `open-port` | Open a port / security rule | all five |
| `dns-record` | Add a DNS record | all five |
| `lb-member` | Add a load-balancer member | all five |
| `snapshot-backup` | Snapshot now / backup policy | all five |
| `patch-run` | Patch run | all five |
| `tags` | Tag changes | all five |
| `scale-node-pool` | Scale a node pool | all five |
| `file-share` | Add a file share | AWS, Azure, Google Cloud (GCP), OCI |
| `monitoring-alert` | Add a monitoring alert | AWS, Azure, Google Cloud (GCP), OCI |
| `power` | Power: start, stop or restart | all five |
| `budget` | Budget | AWS, Azure, Google Cloud (GCP), OCI |
| `add-any` | Add any resource or module | all five |
| `remove-server` | Remove a server | all five |
| `rotate-certificate` | Rotate a certificate | all five |
| `restart-service` | Restart a service | all five |
| `install-package` | Install or remove software | all five |
| `user-group` | Add a user or group | all five |
| `grant-access` | Grant cloud access | all five |
| `deploy-service` | Deploy a new service | all five |

"All five" is VMware Cloud Foundation, AWS, Azure, Google Cloud (GCP) and OCI.

### Deploy a new service

A new-origin application plan (status planned or approved) is deployed into an existing
landing zone with no waves, replication or cutover (`change/deploy.ts`):

1. pick the app plan and the environment (dev, test, preprod, prod);
2. generate the app stack for that environment in `shared` landing-zone mode, its
   Ansible, and the pipeline when the plan has a CI/CD system;
3. wire the ingress DNS names (a Windows DNS or Infoblox zone is a listed step), the
   security rules the app's dependencies need (listed, with `open-port`), and the
   monitoring and backup tags the stack carries;
4. validate with the app's smoke checks (HTTP, TCP) from the controller;
5. track: events on the `deploy` path with the app as the item move it `planned` →
   `prepared` → `validated`; `accepted` is a person's call.

## Where it hands over

- **From Application Migration**: the application plans, through the shared plan; the
  estate check links each app back to `migration.html#app:<slug>`.
- **To VCF Sizing**: a landing zone's **Relocate target** shows a first host count (a
  naive sum) and **Open VCF Sizing →**, where the real sizing is done from the stored estate.
- **To the Network page**: in data-centre exit, the circuit cuts of the exit sequence are
  handed to `network.html` (session handoff `plan-to-network`), which opens on the BGP-peer
  or static-route change for each device, prefilled.
- **To the Terraform and Ansible pages**: the generated `terraform/<platform>/` and
  `ansible/` folders carry `archtoolkit-terraform-settings.json` and
  `archtoolkit-ansible-settings.json`; **Load** them on those pages to see and edit the
  same stack or site.
