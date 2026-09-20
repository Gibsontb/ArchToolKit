# Ansible kit

Terraform builds an estate; Ansible reads one and reconfigures it. The two kits
are separate on purpose — they solve different problems and are pinned to
different registries — but both are fed by the same VMware inventory model.

## What is generated

**Repository scaffold** (`src/ansible/scaffold.ts`)

| File | Why |
| --- | --- |
| `requirements.yml` | Since ansible-core 2.10 almost nothing ships in the box. A playbook that names a module without requiring its collection fails with "module not found". |
| `ansible.cfg` | Settings are stated rather than inherited, so changing one is a decision. `host_key_checking` stays **on**. |
| `inventory/hosts.yml` | Cloud and vSphere work runs from the control node against an API, so it targets `localhost` with `ansible_python_interpreter: {{ ansible_playbook_python }}`. |
| `group_vars/all/vault.yml` | A template with no values, gitignored until it is encrypted. |
| `.gitignore` | Keys, `.vault_pass`, and the unencrypted vault file. |

**vSphere playbooks** (`src/ansible/vmware.ts`)

- `collect.yml` — gathers clusters, hosts and VMs and writes `to_nice_json`
  files the inventory importer reads. The three gathers are separate tasks
  because they fail separately.
- `clusters.yml` — cluster settings from an imported inventory, rendered as the
  tasks that would produce them.

## Rules the kit enforces

- **No credential is ever written.** Every `vmware.vmware` module falls back to
  `VMWARE_HOST`, `VMWARE_USER`, `VMWARE_PASSWORD`, `VMWARE_PORT` and
  `VMWARE_VALIDATE_CERTS`, so the playbooks name none of them. A literal-looking
  value in a `password`-shaped argument is an **error**, and handling one without
  `no_log` is a warning.
- **Missing data is not a change.** A cluster whose HA state the inventory did
  not record produces no HA task. Writing `enable: false` for a field nobody
  collected would turn a gap in the data into a change to the estate.
- **Enumerations are checked, not guessed.** `Fully Automated`, `FullyAutomated`
  and `fullyAutomated` all mean the same cluster; only one is a value
  `cluster_drs` accepts. Anything unrecognised is reported and left at the
  module's default rather than written through.
- **Short module names are flagged.** `copy` resolves through the collections
  search path, which differs between control nodes.
- **What cannot be expressed is said.** `vmware.vmware` 2.10.0 has no EVC or
  vSAN cluster module, so those are reported rather than invented.

## The catalog

`src/ansible/catalog-data.ts` holds 3,929 module names across 11 collections,
fetched from Ansible Galaxy. It is committed so the toolkit works air-gapped,
and it records the version each list came from and the date it was fetched, so
it can report its own age instead of quietly pretending to be current.

Refresh it with `update-catalog.bat` (which also refreshes the Terraform
catalog) or `npm run ansible:update`. Galaxy has no endpoint that lists a
collection's modules; the fetcher reads the published version's file manifest,
where every module is a file under `plugins/modules/`.

The catalog answers *does this module exist*. It does not know what each module
accepts — inventing that would be the same mistake as generating modules from
memory — so every generated playbook says so and points at
`ansible-playbook --check --diff`.

## Collections and versions

Read from the Galaxy API on 2026-09-20, all non-deprecated:

| Collection | Version | Notes |
| --- | --- | --- |
| `vmware.vmware` | 2.10.0 | The supported collection. New work belongs here. |
| `vmware.vmware_rest` | 4.11.0 | Generated from the vSphere REST specification. Needs `aiohttp`. |
| `community.vmware` | 6.4.0 | Still maintained, and still carries modules `vmware.vmware` has not replaced. Off by default. |
| `amazon.aws` | 11.4.0 | |
| `community.aws` | 11.1.0 | Depends on `amazon.aws`; cannot be installed alone. |
| `azure.azcollection` | 4.0.0 | Ships its own `requirements.txt`. |
| `google.cloud` | 1.14.0 | |
| `oracle.oci` | 5.5.0 | 2,016 modules — the largest by far. |
| `ansible.posix` | 2.2.2 | |
| `ansible.windows` | 3.8.0 | |
| `community.general` | 13.4.0 | Pull in for a specific module, not as a default. |

`ansible.builtin` ships inside ansible-core and is never listed in
`requirements.yml`; asking Galaxy for it returns a 404.

## The YAML writer

`src/ansible/yaml.ts` is dependency-free, because adding one would break the
air-gapped constraint. Quoting is where a naive YAML writer goes wrong, and the
failures are quiet — a value that parses as the wrong type rather than failing:

- `no`, `off`, `y`, `n` are booleans in YAML 1.1, which Ansible still follows.
  An unquoted Norwegian country code becomes `false`.
- `1.10` is a float and parses as `1.1`. Version numbers lose their patch.
- `0755` is octal, `1:30` is sexagesimal, `0x1F` is hex.
- A leading `- ? : , [ ] { } # & * ! | > ' " % @ \`` changes the line's meaning.

It quotes on doubt rather than on a list of characters it happens to remember.
