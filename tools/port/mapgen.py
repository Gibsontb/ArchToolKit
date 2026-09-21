#!/usr/bin/env python3
"""Port the Terraform Map pages into `src/terraform/map-data.ts`.

The originals are four standalone HTML pages under
`_old/13_Web/static/terraform/`, each a reference map for a cloud: seven or
eight domain sections, each with a tagline, one or more tables saying which
resource does which job, sometimes a starter `terraform {}` block, and
sometimes a collapsed worked example in HCL.

Three of them port. The fourth, `terraform-aws.html`, is a mislabelled copy of
the Azure map — its title says "Azure Terraform Map", its body holds 54
`azurerm_*` names and not one `aws_*` — so there is no AWS map in the originals
to bring across. That one is written in `map-aws.ts` instead, and this script
leaves it alone.

The text is taken verbatim. What changes is the shape: out of HTML and into
data, so one page renders all four and every resource name in them is checked
against the committed provider catalog the same way the blueprints are.

The tables do not share a column set — some are Domain/Services/Resources/
Pattern, others Service/Resources/What You Decide — so the headers travel with
each table rather than being flattened into a fixed shape that would need
inventing content for the columns an original did not have. Each row also
carries the resource-shaped names found anywhere in it, which is what the
catalog check reads.

    python3 tools/port/mapgen.py
"""

from __future__ import annotations

import html
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scrub import scrub  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
OLD = ROOT / "_old" / "13_Web" / "static" / "terraform"
OUT = ROOT / "src" / "terraform" / "map-data.ts"

# file -> (target id as the rest of the toolkit spells it, label)
PAGES = [
    ("terraform-azure.html", "azure", "Azure"),
    ("terraform-gcp.html", "google", "GCP"),
    ("terraform-oracle.html", "oci", "OCI"),
]

#: A Terraform resource type, as opposed to a provider name or an attribute.
RESOURCE_SHAPED = re.compile(r"^[a-z][a-z0-9]*(_[a-z0-9]+)+$")


def text(fragment: str) -> str:
    """Tags out, entities decoded, whitespace collapsed."""
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", fragment))).strip()


def code(fragment: str) -> str:
    """Same, but newlines and indentation are the point."""
    return html.unescape(re.sub(r"<[^>]+>", "", fragment)).strip("\n")


def names_in(fragment: str) -> list[str]:
    """The resource types named in a fragment, in order, without duplicates.

    Only `<code>` spans count, and only those shaped like a resource type. The
    same styling is used for provider names, attributes and the occasional
    inline literal, and calling one of those a missing resource would be noise.
    """
    found: list[str] = []
    for span in re.findall(r"<code>(.*?)</code>", fragment, re.S):
        name = text(span)
        if RESOURCE_SHAPED.match(name) and name not in found:
            found.append(name)
    return found


def parse_tables(inner: str) -> list[dict]:
    tables = []
    for table in re.findall(r"<table[^>]*>(.*?)</table>", inner, re.S):
        headers = [text(th) for th in re.findall(r"<th[^>]*>(.*?)</th>", table, re.S)]
        rows = []
        for row in re.findall(r"<tr>(.*?)</tr>", table, re.S):
            cells_html = re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)
            if not cells_html:
                continue
            rows.append(
                {
                    "cells": [text(c) for c in cells_html],
                    "resources": names_in(row),
                }
            )
        if rows:
            tables.append({"headers": headers, "rows": rows})
    return tables


def parse_examples(inner: str) -> list[dict]:
    """The `<details>` blocks: a worked example, collapsed."""
    examples = []
    for block in re.findall(r"<details[^>]*>(.*?)</details>", inner, re.S):
        summary = re.search(r"<summary>(.*?)</summary>", block, re.S)
        label = re.search(r'<span class="tf-summary-label">(.*?)</span>', block, re.S)
        note = re.search(r'<span class="tf-summary-note">(.*?)</span>', block, re.S)
        body = re.search(r"<code>(.*?)</code>", block[summary.end() :] if summary else block, re.S)
        example = {
            "title": text(label.group(1)) if label else (text(summary.group(1))[:80] if summary else "Example"),
        }
        if note:
            example["note"] = text(note.group(1))
        if body:
            example["code"] = code(body.group(1))
        if "code" in example:
            examples.append(example)
    return examples


def parse_section(section_id: str, inner: str) -> dict:
    # The worked examples are pulled out first so their HCL — which is full of
    # <code> and resource names — is not also scraped as table content.
    examples = parse_examples(inner)
    without_examples = re.sub(r"<details[^>]*>.*?</details>", " ", inner, flags=re.S)

    heading = re.search(r"<h2>(.*?)</h2>", without_examples, re.S)
    badge = re.search(r'<span class="tf-badge">(.*?)</span>', without_examples, re.S)
    tagline = re.search(r'<p class="tf-tagline">(.*?)</p>', without_examples, re.S)

    tables = parse_tables(without_examples)

    # Some sections use a bullet list where others use a table, and the bullets
    # carry the same thing: "GKE: google_container_cluster,
    # google_container_node_pool." Those become a table of their own so their
    # resources are checked like any other; bullets that name none stay prose.
    notes: list[str] = []
    listed: list[dict] = []
    for li in re.findall(r"<li>(.*?)</li>", without_examples, re.S):
        line = text(li)
        if not line:
            continue
        resources = names_in(li)
        if not resources:
            notes.append(line)
            continue
        label = line.split(":", 1)[0].strip() if ":" in line else line
        listed.append({"cells": [label, ", ".join(resources)], "resources": resources})
    if listed:
        tables.append({"headers": ["Area", "Resources"], "rows": listed})

    blocks = [
        code(m)
        for m in re.findall(r'<div class="tf-code">\s*<code>(.*?)</code>', without_examples, re.S)
    ]

    section: dict = {"id": section_id}
    if heading:
        # "3. Networking & Connectivity" — the number is position, not name.
        section["title"] = re.sub(r"^\d+\.\s*", "", text(heading.group(1)))
    if badge:
        section["badge"] = text(badge.group(1))
    if tagline:
        section["tagline"] = text(tagline.group(1))
    if tables:
        section["tables"] = tables
    if notes:
        section["notes"] = notes
    if blocks:
        section["code"] = blocks
    if examples:
        section["examples"] = examples
    return section


def parse_page(path: Path) -> dict:
    source = path.read_text(encoding="utf-8", errors="replace")
    body = source[source.find("<body") :]

    title = re.search(r'<h1 class="page-title"[^>]*>(.*?)</h1>', body, re.S)
    blurb = re.search(r"<nav class=\"tf-nav\">.*?<p>(.*?)</p>", body, re.S)

    sections = [
        parse_section(sid, inner)
        for sid, inner in re.findall(
            r'<section id="([^"]+)" class="tf-section">(.*?)</section>', body, re.S
        )
    ]
    return {
        "title": text(title.group(1)) if title else path.stem,
        "blurb": text(blurb.group(1)) if blurb else "",
        "sections": sections,
    }


HEADER = '''/**
 * The Terraform Maps — GENERATED from the previous toolkit, do not edit by hand.
 *
 * A reference map per cloud: which resource does which job, in which domain,
 * with the pattern the previous toolkit recommended around it. This is the
 * content of `_old/13_Web/static/terraform/terraform-{azure,gcp,oracle}.html`,
 * taken verbatim and turned into data so one page renders all of them and every
 * name in them is checked against the committed provider catalog.
 *
 * The AWS map is not here. `_old/.../terraform-aws.html` is a mislabelled copy
 * of the Azure one — its title reads "Azure Terraform Map", its body holds 54
 * `azurerm_*` names and no `aws_*` at all — so there was nothing to port. It is
 * written in map-aws.ts instead, to the same domains.
 *
 * Regenerate with: python3 tools/port/mapgen.py
 */

import type { CloudMap } from './map.ts';

'''


def main() -> None:
    parts = [HEADER]
    exports = []
    for filename, target, label in PAGES:
        page = parse_page(OLD / filename)
        const = f"{target.upper()}_MAP"
        exports.append(const)
        payload = {"target": target, "label": label, **page}
        parts.append(
            f"export const {const}: CloudMap = "
            + json.dumps(payload, indent=2, ensure_ascii=False)
            + ";\n"
        )

        rows = sum(len(t["rows"]) for s in page["sections"] for t in s.get("tables", []))
        names = {
            n
            for s in page["sections"]
            for t in s.get("tables", [])
            for r in t["rows"]
            for n in r["resources"]
        }
        examples = sum(len(s.get("examples", [])) for s in page["sections"])
        print(
            f"  {label:6} {len(page['sections'])} sections, {rows:3} rows, "
            f"{len(names):3} resources, {examples} worked example(s)"
        )

    OUT.write_text(scrub("\n".join(parts)), encoding="utf-8", newline="\n")
    print(f"\nWrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
