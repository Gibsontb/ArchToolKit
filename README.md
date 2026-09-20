# ArchToolKit

Offline-first architecture toolkit for multi-cloud, VMware and VMware Cloud Foundation work.

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
  core/      IP/CIDR arithmetic, capacity units, findings
  vcf/       VCF 9.1 sizing data, sizing engine, provenance tagging
  ui/        DOM helpers, shared components, page controllers
  testing/   minimal expect() shim over node:assert
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
| VMware inventory import and analysis | Planned |
| Multi-cloud decision matrix | Planned |
| Application migration and modernization | Planned |
| Terraform authoring kit | Planned |
| Ansible authoring kit | Planned |

## A caution on VCF output

Sizing results and generated specifications are planning aids. Before any real deployment, validate
against a live VCF Installer:

- `POST /v1/sddcs/validations` — validates a spec
- `POST /v1/sddcs/resources-calculation` — the product's own sizing math, which is authoritative and
  should override this toolkit wherever the two disagree

See `docs/vcf-91-groundtruth.md` for the researched schema and sizing data, including an explicit
list of figures that could not be verified.
