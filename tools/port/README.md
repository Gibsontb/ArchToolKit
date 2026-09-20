# Porting the previous toolkit's generators

`parse.py` and `gen.py` read `_old/13_Web/static/terraform.html` and
`ansible.html`, pull `TERRA_DEFS` and `SCENARIO_DEFS` out of them, and write
`src/terraform/blueprints/` and `src/ansible/blueprints/`.

The inputs and the templates are the originals, unchanged. What the generator
adds around them:

- `type: "text"` becomes `control: 'text'`, to match the new input model.
- Region lists become re-export shims onto `src/kit/regions.ts`, so the two
  generators cannot drift apart about which regions exist.
- A handful of free-text inputs with genuinely closed answer sets become
  dropdowns (see `INPUT_OVERRIDES`). Sizes, shapes, SKUs and engine versions
  are deliberately left as text: those lists run to hundreds of values and
  change between releases, and a dropdown missing a valid one is worse than a
  text box.
- Module names that moved or were renamed since the originals were written are
  corrected (see `MODULE_RENAMES`). Every replacement was looked up in the
  committed Galaxy catalog.
- `plugins/modules/*.ps1` and `*.yml` count as modules, not just `*.py`.

Rerun with:

    python3 tools/port/parse.py && python3 tools/port/gen.py

It is kept because the originals are the source of truth for these templates.
If one of them is corrected in `_old`, rerunning brings the correction across
rather than requiring the same edit twice.
