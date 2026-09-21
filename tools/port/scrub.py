#!/usr/bin/env python3
"""Take the court out of the toolkit.

The previous toolkit was written for one customer, and it shows: every
default in it is `court-vpc`, `CourtSessions`, `Court-DC1`, and the prose
talks about court-to-court links and a subscription per court. None of that
is wrong, it is just not universal, and this kit is.

So the names become ordinary ones — `app-vpc`, `AppSessions`, `DC1` — and the
prose says tenant or site where it said court. Nothing changes meaning: a
landing zone per court and a landing zone per tenant are the same pattern with
the audience taken out.

This lives in the porting pipeline rather than being a one-off edit, because
the blueprints and the maps are generated from `_old`. A sweep over the output
would be undone by the next `gen.py` run; a sweep in the pipeline holds.

CJIS is deliberately left alone where it names the compliance framework — it
sits beside FedRAMP, ITAR and CMMC in the migration tool's list, and a kit that
cannot say CJIS is less useful to everyone, not more universal. Where CJIS was
an *example* — a tag value, a folder called IL5 — it is generalised like the
rest.

    from scrub import scrub          # in the generators
    python3 tools/port/scrub.py FILE…   # one-off, over files already written
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

#: Ordered. The specific spellings first, so the general rules below cannot
#: turn `court-app-01` into `app-app-01` on their way past.
REPLACEMENTS: list[tuple[str, str]] = [
    # --- prose, before any of the identifiers inside it are rewritten ------
    ("every court, tenant, or environment", "every tenant or environment"),
    ("“Court-to-court / court-to-datacenter” connectivity", "“Site-to-site / site-to-datacenter” connectivity"),
    ("Court-to-court and court-to-datacenter links", "Site-to-site and site-to-datacenter links"),
    ("Court-to-Court Secure Link", "Site-to-Site Secure Link"),
    ("Court-to-Datacenter Hybrid Link", "Site-to-Datacenter Hybrid Link"),
    ("Court-Isolated Subscription", "Isolated Subscription"),
    ("“Court subscription bootstrap”", "“Subscription bootstrap”"),
    ("Court Landing Zone in OCI", "Landing Zone in OCI"),
    ("Hybrid Court Connectivity", "Hybrid Connectivity"),
    ("Secure Court Project", "Secure Tenant Project"),
    ("for_each over courts", "for_each over tenants"),
    ("VCN module per court", "VCN module per tenant"),
    ("per environment or per court/tenant", "per environment or per tenant"),
    ("per court or tenant", "per tenant"),
    ("per court, tenant", "per tenant"),
    ("court metadata", "tenant metadata"),
    ("adding a court is a map entry", "adding a tenant is a map entry"),
    ("court-specific", "tenant-specific"),
    ("Courts IT / Clerk’s Office", "Platform Team / Application Owner"),
    ("Courts IT", "Platform Team"),
    ("Court case management system.", "Line-of-business application."),
    ("Justice / law enforcement data", "Criminal justice information"),

    # --- names that need their own answer ---------------------------------
    ("CourtCaseMgmt", "AppSystem"),
    ("CourtSessions", "AppSessions"),
    ("COURTATP", "APPATP"),
    ("courtadmin", "dbadmin"),
    ("court_analytics", "app_analytics"),
    ("court_admins", "platform_admins"),
    ("court-admins", "platform-admins"),
    ("Court-DC", "DC"),
    ("courts.example.gov", "app.example.com"),
    (".court.local", ".example.local"),
    ("court.internal.", "app.internal."),
    ("courtvcn", "appvcn"),
    ("stcourtprod001", "stappprod001"),
    ("courtstoracct01", "appstoracct01"),
    ("courtarchive001", "apparchive001"),
    ("courtlinux01", "applinux01"),

    # `court-app` would otherwise become `app-app`.
    ("app-court-prod", "app-prod"),
    ("vm-court-app-01", "vm-app-01"),
    ("court-app-01", "app-01"),
    ("court-app-sg", "app-sg"),
    ("court-app", "app"),

    # --- the CJIS examples, which are examples rather than the framework --
    ("/Court/Prod/IL5", "/Prod/Restricted"),
    ("Court/Prod/IL5", "Prod/Restricted"),
    ("System of record: AppSystem; Data class: CJIS", "System of record: AppSystem; Data class: Restricted"),
    ('default: "CJIS", hint: "e.g. CJIS, PHI, FOUO"', 'default: "Restricted", hint: "e.g. Restricted, PHI, FOUO"'),
    ("CJIS-controlled workload", "Restricted workload"),
    ("CJIS-controlled", "restricted"),

    # A Windows domain, which is a name like any other.
    ("COURT\\\\", "CORP\\\\"),
    ("COURT\\", "CORP\\"),

    # --- everything left ---------------------------------------------------
    ("court-", "app-"),
    ("Court-", "App-"),
    ("courts", "tenants"),
    ("Courts", "Tenants"),
]

#: A bare `court` or `Court` left over — a database called `court`, a sentence
#: that still says court. Done last and as a whole word, so it cannot chew
#: through a name one of the rules above already settled.
WORD = [
    (re.compile(r"\bcourt\b"), "app"),
    (re.compile(r"\bCourt\b"), "App"),
]


def scrub(text: str) -> str:
    for old, new in REPLACEMENTS:
        text = text.replace(old, new)
    for pattern, new in WORD:
        text = pattern.sub(new, text)
    return text


def main(paths: list[str]) -> int:
    changed = 0
    for name in paths:
        path = Path(name)
        before = path.read_text(encoding="utf-8")
        after = scrub(before)
        if after == before:
            continue
        path.write_text(after, encoding="utf-8", newline="\n")
        hits = sum(1 for a, b in zip(before.split("\n"), after.split("\n")) if a != b)
        print(f"  {name}: {hits} line(s)")
        changed += 1
    print(f"\n{changed} file(s) changed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
