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

## The decision wizard

`wizgen.py` reads `multi-cloud-decision-matrix.html` and writes
`src/multicloud/wizard/steps.ts`: the four steps, every question, every answer
set, every hint, and the order they appear in.

The order is not cosmetic. The questions are laid out two to a row, and a
section heading takes a cell of its own — so dropping one shifts every question
after it into the wrong column. Headings are items in the list for that reason.

Two things an earlier pass missed, both worth knowing if this is ever rerun:

- A checkbox group is written two ways in the original — a bare `<label>` with
  the text after the input, and a `.checkbox-inline` label with a self-closing
  input. Matching only the first silently dropped the F5 usage question.
- Hints are `<div class="hint">`, not `<small>`. Matching the wrong one dropped
  every hint on step 3.

The engine itself is at `src/multicloud/wizard/engine.js`, ported verbatim. It
is JavaScript on purpose: it IS the original JavaScript, and annotating it would
have meant touching every function. The boundary is typed in `engine.d.ts`.

Validation there is deliberately soft — `return true; // soft validation only`.
It names what is missing and lets you carry on, because a generic
recommendation is more use than a blocked form.
