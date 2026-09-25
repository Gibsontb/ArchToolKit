"""
Dump every Ansible module's options, compacted, as JSON — the Ansible
counterpart of `terraform providers schema -json`.

Run by tools/fetch-ansible-schemas.mjs, next to an Ansible install (in WSL on
Windows). It reads `ansible-doc -j` — each module's DOCUMENTATION, which is
what `ansible-doc` and the docs site show and what ansible-lint checks
arguments against — and keeps only what the blueprints use:

  module:  { d: short description, a: [option rows], b: [suboption groups],
             al: { alias: option } }
  option:  [name, type, flags, description, choices?, default?]
             type   s string/path/raw, n int/float, b bool, ls/ln list of
                    strings/numbers, m dict, x anything else (YAML),
                    h a group past the form's depth, written as YAML
             flags  r required or o optional, then s when no_log (a secret)
  group:   [name, mode, required, 0, { a, b }]
             mode   1 a dict, l a list of dicts

    python3 ansible-doc-dump.py OUT.json [--depth 5] [--batch 150]
"""

import json
import re
import subprocess
import sys

DESCRIPTION_MAX = 220
MARKUP = re.compile(r"\b(?:[ICBMOVEPU]|RV|L)\(([^)]*)\)")


def text(description):
    """The first sentence or so, with Ansible's I()/C()/O() markup taken off."""
    if isinstance(description, list):
        description = " ".join(str(d) for d in description)
    clean = MARKUP.sub(lambda m: m.group(1).split(",")[0].split("=")[0], str(description or ""))
    clean = re.sub(r"\s+", " ", clean).strip()
    if len(clean) <= DESCRIPTION_MAX:
        return clean
    cut = clean[:DESCRIPTION_MAX]
    stop = cut.rfind(". ")
    return cut[: stop + 1] if stop > 80 else cut.rsplit(" ", 1)[0] + "…"


def type_code(option):
    kind = option.get("type", "str")
    elements = option.get("elements", "str")
    if kind in ("bool", "boolean"):
        return "b"
    if kind in ("int", "float"):
        return "n"
    if kind == "list":
        if elements in ("int", "float"):
            return "ln"
        if elements in ("str", "path", "sid", "bytes", "bits"):
            return "ls"
        return "x"
    if kind == "dict":
        return "m"
    if kind in ("json", "jsonarg", "raw", "any"):
        return "x"
    return "s"


def compact(options, depth, max_depth):
    a, b = [], []
    aliases = {}
    for name, option in sorted((options or {}).items()):
        if not isinstance(option, dict):
            continue
        for alias in option.get("aliases") or []:
            aliases[str(alias)] = name
        required = bool(option.get("required"))
        flags = ("r" if required else "o") + ("s" if option.get("no_log") else "")
        sub = option.get("suboptions") or option.get("options")
        if sub and isinstance(sub, dict):
            mode = "l" if option.get("type") == "list" else 1
            if depth + 1 > max_depth:
                a.append([name, "h", flags, (text(option.get("description")) + " Written as YAML.").strip()])
            else:
                b.append([name, mode, 1 if required else 0, 0, compact(sub, depth + 1, max_depth)])
            continue
        row = [name, type_code(option), flags, text(option.get("description"))]
        choices = option.get("choices")
        default = option.get("default")
        if isinstance(choices, dict):
            choices = list(choices.keys())
        if isinstance(choices, list) and len(choices) >= 1:
            row.append([str(c) for c in choices])
        elif default is not None:
            row.append(None)
        if default is not None and not isinstance(default, (dict, list)):
            row.append(str(default).lower() if isinstance(default, bool) else str(default))
        a.append(row)
    a.sort(key=lambda r: (0 if r[2].startswith("r") else 1, r[0]))
    b.sort(key=lambda r: (0 if r[2] else 1, r[0]))
    out = {"a": a}
    if b:
        out["b"] = b
    if aliases:
        # Other names the module accepts for an option: alias -> option.
        out["al"] = aliases
    return out


_FINDER = None


def argument_spec(fqcn):
    """
    The module's own argument_spec, for a module that documents no options.

    Oracle ships most of oracle.oci without documentation ("Due to size
    constraints we have not included the documentation in the module"); its
    options exist only in code. Importing the module and stopping its main()
    at the point it builds its AnsibleModule gives the spec — what ansible-lint
    does too — which has the documentation's shape, less the descriptions.
    """
    import importlib
    import os

    global _FINDER
    if _FINDER is None:
        # ansible_collections.* only imports through Ansible's own loader.
        from ansible.utils.collection_loader._collection_finder import _AnsibleCollectionFinder

        paths = [p for p in os.environ.get("ANSIBLE_COLLECTIONS_PATH", "").split(":") if p]
        _FINDER = _AnsibleCollectionFinder(paths=[os.path.expanduser(p) for p in paths])
        _FINDER._install()

    namespace, collection, name = fqcn.split(".")
    module = importlib.import_module(f"ansible_collections.{namespace}.{collection}.plugins.modules.{name}")
    captured = {}

    class Stop(Exception):
        pass

    def capture(*args, **kwargs):
        captured.update(kwargs.get("argument_spec") or (args[0] if args and isinstance(args[0], dict) else {}))
        raise Stop()

    for attribute in ("AnsibleModule", "OCIAnsibleModule"):
        if hasattr(module, attribute):
            setattr(module, attribute, capture)
    # Some modules read sys.argv or exit on their own; neither may reach this run.
    saved = sys.argv
    sys.argv = [name]
    try:
        module.main()
    except (Stop, SystemExit):
        pass
    finally:
        sys.argv = saved
    return captured


def main():
    out_path = sys.argv[1]
    max_depth = int(sys.argv[sys.argv.index("--depth") + 1]) if "--depth" in sys.argv else 5
    batch = int(sys.argv[sys.argv.index("--batch") + 1]) if "--batch" in sys.argv else 150
    doc = sys.argv[sys.argv.index("--ansible-doc") + 1] if "--ansible-doc" in sys.argv else "ansible-doc"

    listing = json.loads(subprocess.run([doc, "-t", "module", "-l", "-j"], capture_output=True, text=True, check=True).stdout)
    names = sorted(listing)
    modules = {}
    for i in range(0, len(names), batch):
        part = names[i : i + batch]
        run = subprocess.run([doc, "-t", "module", "-j", *part], capture_output=True, text=True)
        try:
            docs = json.loads(run.stdout)
        except json.JSONDecodeError:
            # One broken module's docs fail the whole batch; take them one at a time.
            docs = {}
            for name in part:
                one = subprocess.run([doc, "-t", "module", "-j", name], capture_output=True, text=True)
                try:
                    docs.update(json.loads(one.stdout))
                except json.JSONDecodeError:
                    print(f"  {name}: documentation unreadable, skipped", file=sys.stderr)
        for name, entry in docs.items():
            info = (entry or {}).get("doc") or {}
            options = info.get("options")
            short = info.get("short_description")
            if not options:
                # Undocumented options: read them from the module's code instead.
                try:
                    options = argument_spec(name)
                except Exception:  # a module that will not import keeps its (empty) docs
                    options = None
                if options and not short:
                    short = name.split(".")[-1].replace("_", " ")
            body = compact(options, 0, max_depth)
            body["d"] = text(short)
            modules[name] = body
        print(f"  {min(i + batch, len(names))} of {len(names)} modules", file=sys.stderr, flush=True)

    versions = {}
    listed = subprocess.run(["ansible-galaxy", "collection", "list", "--format", "json"], capture_output=True, text=True)
    try:
        for path in json.loads(listed.stdout).values():
            for collection, meta in path.items():
                versions.setdefault(collection, meta.get("version"))
    except json.JSONDecodeError:
        pass
    core = subprocess.run([doc, "--version"], capture_output=True, text=True).stdout.split("\n")[0]
    try:
        from importlib.metadata import version

        package = version("ansible")
    except Exception:  # ansible-core alone has no `ansible` package version
        package = None
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"package": package, "core": core, "collections": versions, "modules": modules}, f)


if __name__ == "__main__":
    main()
