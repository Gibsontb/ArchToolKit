# Decision rules: the matrix, the plan's rule sets and the pattern rules

The question is not "which cloud is best" — nobody can answer that. It is
"given these constraints, which of the five is left, and why". The five are AWS,
Azure, Google Cloud (GCP), OCI and VMware Cloud Foundation.

The rules answer it for every server and database of a migration plan, and every
application's recommendation on Application Migration is read from their output
(`docs/application-migration.md`). There is one engine and three layers of rules:

| Layer | Where | What it holds |
| --- | --- | --- |
| The decision matrix | `src/multicloud/platforms.ts`, `services.ts`, `vmware-on-cloud.ts`, `decide.ts` | The five platforms, the capability table (product and Terraform resource type per platform), the VMware-on-cloud services, and `decide()`, which routes one workload profile. |
| The plan's rule sets | `src/multicloud/plan/decide/` (`RULES`, `RULE_SETS`) | Every rule `decidePlan` runs over every item of a plan, in evaluation order. |
| The pattern rules | `src/multicloud/plan/patterns/rules.ts` (`PATTERN_RULES`) | The app-level rules (the chosen cloud, the tier pattern) and the rules each application pattern brings (SAP, Oracle applications, Microsoft, VDI, file, middleware, Kubernetes, legacy, appliances). |

The Multi-Cloud Decision & Onboarding Wizard that used to put the matrix on a page
of its own is retired. `decide()` is kept as a library: it turns one profile into a
one-workload plan, scores it with the plan engine's rules, and maps the result back,
so the two can never disagree.

## Why it produces reasons rather than a winner

A matrix that outputs a winner and no reasoning cannot be argued with and cannot be
reviewed, so it gets ignored the first time someone disagrees with it. Every rule
states what it looked at, which way it pushed and where the claim comes from; the
application workspace's Compare tab and the decision record (`decision/app-record.md`
in every generated app project) show each platform's score broken down into the
rules that produced it.

Two kinds of rule are kept apart on purpose:

- **Rules that score** encode something structural: licensing that genuinely is
  cheaper on one platform, a workload shape that genuinely does not move.
- **Rules that only report.** Region coverage, sovereign offerings and pricing
  change constantly and cannot be checked from an offline toolkit. Scoring on a
  stale region list would be a confident wrong answer, which is worse than an
  honest gap, so those raise a finding and move nothing.

A margin that small is reported as too close to call rather than resolved.

## How the engine decides

`decidePlan(plan, options)` (`plan/decide/engine.ts`) is pure: the same plan always
gives the same decision, and the engine version is stored with it.

1. a disposition and a method per workload (`disposition.ts`);
2. the options per item: the five platforms for a workload; every service that runs
   the engine, per platform, for a database;
3. every rule per option, summed into a score, with eliminations;
4. the estate subset: at most `requirements.maxPlatforms` platforms carry the estate
   (`estate.ts`); pins force their platform in;
5. assignment inside the subset;
6. the affinity pass (`affinity.ts`);
7. margins, findings and database coupling (`db.hosts-follow`: a database lands with
   the servers that host it).

A rule is data: an object built with `rule({ id, kind, verification, source, applies,
evaluate, findings, review })`, where `kind` is `workload`, `database` or `any`, and
`verification` is the provenance tag (`V-DOC`, `C`, `I` …). To add a rule set, write
`rules/<topic>.ts` and add it to `RULE_SETS`; nothing else changes. Callers add rules
without a second engine through `extraRules` (`withRules(...)` builds a registry with
extras appended). Greenfield items are decided by the same rules, less the
migration-only ones (`shape.short-timeline`, `shape.relocate-suits-vmware-services`,
`shape.relocate-at-scale`, and any rule with `migrationOnly: true`).

## The plan's rule sets (`RULE_SETS`)

| Set | Rules |
| --- | --- |
| `eliminations` | `policy.excluded`, `shape.physical-dongle`, `shape.relocate-needs-vmware`, `db.rac-needs-exadata`, `db.feature-unsupported`, `db.size-limit`, `db.edition-mismatch`, `lic.oracle.se2-cap`, `residency.government`, `os.no-image-rebuild` |
| `shape` | `shape.dc-rebuild`, `shape.retain`, `shape.relocate-suits-vmware-services`, `shape.relocate-at-scale`, `shape.refactor-needs-managed-services`, `shape.latency-critical`, `shape.latency-sensitive`, `shape.short-timeline`, `shape.large-memory`, `shape.gpu` |
| `commercial` | `commercial.existing-commitment`, `commercial.operational-skills`, `exit.portable-first`, `exit.managed-first`, `lic.vcf.portable`, `lic.linux.byos` |
| `licensing-microsoft` | `lic.ms.ahb`, `lic.ms.fvb`, `lic.ms.dedicated-host`, `lic.ms.sql-mobility`, `lic.ms.sql-sa-position`, `lic.ms.esu-free` |
| `licensing-oracle` | `lic.oracle.oci-core-factor`, `lic.oracle.odb-in-cloud`, `lic.oracle.vmware-cluster`, `lic.oracle.support-rewards`, `lic.oracle.rds-se2-li` |
| `databases` | `db.managed-default`, `db.sql-instance-features`, `db.sql-fci`, `db.oracle-rac`, `db.oracle-dataguard`, `db.hosts-follow` |
| `report-only` | `residency.check-regions`, `sovereignty.differs-in-shape`, `os.eol`, `os.unknown`, `db.version-eol`, `portfolio.cloud-differs` |

When two rules eliminate the same option, the first one in this order is recorded as
the reason. Rule ids that `decide()` always emitted are kept as aliases
(`policy.excluded` also reports as `excluded-by-policy`, `shape.physical-dongle` as
`physical-dongle`).

The eliminations are statements that an option does not work — policy forbids it, the
service cannot carry the feature, the licence does not allow it — not that it is worse:

| Rule | Effect |
| --- | --- |
| `policy.excluded` | Eliminates every platform not in `requirements.allowed`. |
| `shape.physical-dongle` | Eliminates the four hyperscalers for an app with a physical licence dongle. A dongle has to be plugged into something, and none of them will plug it in. |
| `shape.relocate-needs-vmware` | A relocation (HCX / vMotion) needs VMware at the target: VCF, or the hyperscaler's VMware service. |
| `db.rac-needs-exadata`, `db.feature-unsupported`, `db.size-limit` | A database service that cannot run Oracle RAC, a feature in use, or the database's size. |
| `db.edition-mismatch` | SQL Server Express or Developer in production on Amazon RDS. |
| `lic.oracle.se2-cap` | Oracle Standard Edition 2 BYOL over its vCPU cap in an Authorized Cloud Environment. |
| `residency.government` | A government region is required and the platform's region is not one. |
| `os.no-image-rebuild` | A rebuild onto a platform with no image for the OS. |

## The pattern rules (`PATTERN_RULES`)

Passed as `decidePlan(plan, { extraRules: PATTERN_RULES })` by the application
recommendation (`plan/apps/recommend.ts`), so they show in the reasons like any other
rule.

- **Structural**, for every app: `app.chosen-platform` eliminates the other platforms
  for every item of an app whose platform is chosen (an item pinned elsewhere keeps its
  pin); `app.tier-pattern` keeps a component's items on its tier pattern's services (a
  platform without the tier pattern is eliminated; a database keeps only managed or only
  IaaS services); `app.pin-conflict` reports a pin that differs from the app's choice.
- **Databases**: `pattern.db.managed-nosql`.
- **Per pattern**: `pattern.sap.hana-certified`, `pattern.sap.hana-certified-oci`,
  `pattern.sap.anydb-support`, `pattern.sap.vcf-notes`, `pattern.oracle-apps.oci-tooling`,
  `pattern.oracle-apps.mtr`, `pattern.exchange.eos`, `pattern.sharepoint.eos`,
  `pattern.dynamics.op2ol`, `pattern.dotnet.runtime`, `pattern.vdi.density`,
  `pattern.vdi.horizon`, `pattern.vdi.broker`, `pattern.file.service`,
  `pattern.mq.amazon-mq`, `pattern.jboss.app-service`, `pattern.websphere.liberty`,
  `pattern.infra.rebuild`, `pattern.k8s.target`, `pattern.legacy.specialist`,
  `pattern.hpux.eos`, `pattern.appliance.marketplace`.

An application's recommendation is read from a decision made without its own choice,
so a choice never recommends itself.

## What is deliberately current

The VMware-on-hyperscaler row decides most real migrations and goes stale fastest —
all four services changed hands, versions or licensing model between 2024 and 2026.
Each entry carries its own provenance, and a claim that was not confirmed against the
vendor's own material is tagged **Inferred** with a caveat rather than filled in from
what the others do.

| Service | VCF versions | Verified |
| --- | --- | --- |
| Amazon EVS | 9.1, 9.0, 5.2.1 — inside your own VPC, on EC2 bare metal, 22 regions | Vendor |
| Azure VMware Solution | VCF private clouds; portable VCF subscriptions supported | Vendor (licensing) |
| Google Cloud VMware Engine | Not confirmed | Inferred |
| Oracle Cloud VMware Solution | Not confirmed | Inferred |

Two rules changed because the market did:

- **Portable VCF subscriptions** (`lic.vcf.portable`). Licences bought from Broadcom
  can be carried onto Azure VMware Solution rather than repurchased. That turns "which
  cloud already has our licences" from a constraint into a question of infrastructure
  price. Whether the same holds for GCVE and OCVS was *not* confirmed, and the rule says
  so instead of assuming.
- **Oracle Database no longer forces OCI** (`lic.oracle.odb-in-cloud`). Oracle
  Database@AWS went generally available in July 2025, alongside Oracle Database@Azure
  and @Google Cloud. What remains is a *region* constraint on those three, not a platform
  constraint — so the rules report the region question rather than routing every Oracle
  estate to OCI.

## The capability table checks itself

Every entry carries the Terraform resource type as well as the product name, and a
test checks all of them against the committed provider catalog. A resource renamed in
a provider release fails the suite instead of quietly becoming wrong, and choosing a
platform hands the Terraform generation a type it can actually emit.

Product names are indicative and labelled as such. Resource types are checked. A blank
cell is a genuine gap, not an omission — vSphere has no managed Kubernetes here, and
pretending otherwise would be the whole failure mode of a table like this.

## What the inventory can and cannot tell it

An RVTools export knows how many machines there are, what they run and how big they
are. It does not know why they exist, what they talk to, or when the lease expires.
Application Migration's Sources read the estate into servers, and the collectors, the
performance and dependency imports and the coupling scan add what they can — but the
latency tolerance, the deadline and the licensing position are in no export, and those
move the answer more than anything that is. They are set on Constraints and per app.

## Where the answer goes

A decision has to become something. Once an application's cloud is chosen (or its
recommendation accepted):

- the Target tab shows its developed presence there, and Generate writes its Terraform
  and Ansible (per app or stacked), each Terraform root module with a settings file the
  Terraform page opens;
- Migration & Utilities designs the landing zones for the platforms in use, and the
  move path of every item follows from the source and the target
  (`docs/migration-and-utilities.md`);
- for a relocation onto a VMware service, the VCF Sizing and spec pages still apply.
