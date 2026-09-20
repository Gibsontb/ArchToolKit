# Multi-cloud decision matrix

The question is not "which cloud is best" — nobody can answer that. It is
"given these constraints, which of the five is left, and why".

## Why it produces reasons rather than a winner

A matrix that outputs a winner and no reasoning cannot be argued with and
cannot be reviewed, so it gets ignored the first time someone disagrees with
it. Every rule here states what it looked at, which way it pushed and where the
claim comes from, and the page shows each platform's score broken down into the
rules that produced it.

Two kinds of rule are kept apart on purpose:

- **Rules that score** encode something structural: licensing that genuinely is
  cheaper on one platform, a workload shape that genuinely does not move.
- **Rules that only report.** Region coverage, sovereign offerings and pricing
  change constantly and cannot be checked from an offline toolkit. Scoring on a
  stale region list would be a confident wrong answer, which is worse than an
  honest gap, so those raise a finding and move nothing.

A margin of one point is reported as too close to call rather than resolved.

## The rules that eliminate

| Rule | Effect |
| --- | --- |
| Policy exclusion | Eliminates the named platforms outright. |
| Physical licence dongle | Eliminates all four hyperscalers. A dongle has to be plugged into something, and none of them will plug it in. |

## What is deliberately current

The VMware-on-hyperscaler row decides most real migrations and goes stale
fastest — all four services changed hands, versions or licensing model between
2024 and 2026. Each entry carries its own provenance, and a claim that was not
confirmed against the vendor's own material is tagged **Inferred** with a
caveat rather than filled in from what the others do.

| Service | VCF versions | Verified |
| --- | --- | --- |
| Amazon EVS | 9.1, 9.0, 5.2.1 — inside your own VPC, on EC2 bare metal, 22 regions | Vendor |
| Azure VMware Solution | VCF private clouds; portable VCF subscriptions supported | Vendor (licensing) |
| Google Cloud VMware Engine | Not confirmed | Inferred |
| Oracle Cloud VMware Solution | Not confirmed | Inferred |

Two rules changed because the market did:

- **Portable VCF subscriptions.** Licences bought from Broadcom can be carried
  onto Azure VMware Solution rather than repurchased. That turns "which cloud
  already has our licences" from a constraint into a question of infrastructure
  price. Whether the same holds for GCVE and OCVS was *not* confirmed, and the
  matrix says so instead of assuming.
- **Oracle Database no longer forces OCI.** Oracle Database@AWS went generally
  available in July 2025 and is now in 20 regions, alongside Oracle
  Database@Azure and @Google Cloud. What remains is a *region* constraint on
  those three, not a platform constraint — so the rule reports the region
  question rather than routing every Oracle estate to OCI.

## The capability table checks itself

Every entry carries the Terraform resource type as well as the product name,
and a test checks all of them against the committed provider catalog. A
resource renamed in a provider release fails the suite instead of quietly
becoming wrong, and choosing a platform hands the Terraform kit a type it can
actually emit.

Product names are indicative and labelled as such. Resource types are checked.
A blank cell is a genuine gap, not an omission — vSphere has no managed
Kubernetes here, and pretending otherwise would be the whole failure mode of a
table like this.

## What the inventory can and cannot tell it

An RVTools export knows how many machines there are, what they run and how big
they are. It does not know why they exist, what they talk to, or when the lease
expires. So `profileFromInventory` fills in the machine count, guest OS
families and the machines large enough to narrow the instance shapes — and then
says plainly that the databases, the latency tolerance and the deadline are not
in any export, and those three move the answer more than anything that is.

## Where the answer goes

A decision has to become something. Once a platform leads by more than a point,
the page hands off:

- the Terraform provider for its network foundation,
- the Ansible collection family for its repository spine,
- and, for a rehost onto a hyperscaler, the VMware service that keeps the guest
  unchanged — which means the toolkit's VCF sizing and spec pages still apply.
