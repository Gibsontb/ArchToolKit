/**
 * The command catalogue, browsable.
 *
 * The generator answers "build me this"; this answers the question that comes
 * first — "what is the command, and what is the thing about it that is going to
 * cost me an afternoon". It is the same relationship the Terraform Map has with
 * the Terraform generator, and for the same reason it is a tab rather than a
 * page: a reference you have to navigate to is a reference nobody opens.
 *
 * Searching is over the task text as much as the command name, because someone
 * looking for "how do I list open ports" does not know the answer is `ss`.
 *
 * Every row can be sent straight to the generator, which wraps it in that
 * language's skeleton — strict mode, logging, a dry run, a loop. That is the
 * link that stops this being a page of things to copy badly.
 */

import { el, append, clear, replace } from './dom.js';
import { card, findingsList } from './components.js';
import { SCRIPT_PLATFORMS,                     } from '../scripts/script.js';
import { catalogFindings, coverage, search,                   } from '../scripts/catalog.js';
import { catalogFor, commandsFor, ALL_COMMANDS } from '../scripts/catalog-index.js';

const PLATFORMS                            = ['powershell', 'python', 'bash', 'cmd'];

const EFFECT_LABEL                                                   = {
  read: 'reads',
  changes: 'changes',
  destructive: 'destructive',
};

/** One command, closed by default: the list is long and the detail is deep. */
function commandRow(command              )              {
  const summary = el(
    'summary',
    {},
    el('code', { class: 'cmd-name', text: command.name }),
    el('span', { class: 'cmd-task', text: command.task }),
    el('span', { class: `pill effect-${command.effect}`, text: EFFECT_LABEL[command.effect] }),
  );
  if (command.deprecated) {
    append(summary, el('span', { class: 'pill warn', text: 'deprecated' }));
  }

  const body = el('div', { class: 'cmd-body' });

  append(body, el('pre', { class: 'code-block', text: command.syntax }));

  if (command.note) {
    append(body, el('p', { class: 'tip', text: command.note }));
  }

  if (command.deprecated) {
    append(
      body,
      el('p', { class: 'tip warn' }, el('strong', { text: 'Deprecated. ' }), el('span', { text: `Use ${command.deprecated} in anything new. It keeps working until the release that removes it, and then stops everywhere at once.` })),
    );
  }

  if (command.parameters && command.parameters.length > 0) {
    const tbody = el('tbody');
    for (const parameter of command.parameters) {
      append(tbody, el('tr', {}, el('td', {}, el('code', { text: parameter.name })), el('td', { text: parameter.what })));
    }
    append(
      body,
      el('div', { class: 'table-wrap' }, el('table', { class: 'data-table' }, el('thead', {}, el('tr', {}, el('th', { text: 'Parameter' }), el('th', { text: 'What it does' }))), tbody)),
    );
  }

  const facts = el('p', { class: 'muted cmd-facts' });
  const bits           = [];
  if (command.module) bits.push(`From ${command.module}.`);
  if (command.availability) bits.push(command.availability.endsWith('.') ? command.availability : `${command.availability}.`);
  if (command.related && command.related.length > 0) bits.push(`See also: ${command.related.map((id) => id.split('.').slice(1).join('.')).join(', ')}.`);
  if (bits.length > 0) {
    facts.textContent = bits.join(' ');
    append(body, facts);
  }

  append(
    body,
    el(
      'div',
      { class: 'btn-row' },
      el('button', {
        class: 'btn btn-small',
        text: 'Copy',
        on: {
          click: (event) => {
            const button = event.currentTarget                     ;
            void navigator.clipboard?.writeText(command.syntax).then(
              () => {
                button.textContent = 'Copied';
                globalThis.setTimeout(() => {
                  button.textContent = 'Copy';
                }, 1500);
              },
              () => {
                button.textContent = 'Copy failed';
              },
            );
          },
        },
      }),
      el('a', {
        class: 'btn btn-small',
        text: 'Wrap it in a script →',
        attrs: {
          href: `scripts.html#build:${command.id}`,
          title: 'Open the generator on this command, wrapped with strict mode, logging and a dry run',
        },
      }),
    ),
  );

  return el('details', { class: 'cmd', attrs: { id: command.id } }, summary, body);
}

export function mountCommandsPage(root             )       {
  let platform                 = 'powershell';
  let query = '';
  let effect                              = '';

  const picker = el('select')                     ;
  for (const id of PLATFORMS) {
    append(picker, el('option', { text: `${SCRIPT_PLATFORMS[id].label} (${commandsFor(id).length})`, attrs: { value: id } }));
  }

  const box = el('input', {
    attrs: { type: 'search', placeholder: 'list open ports, stale accounts, why is the disk full…', 'aria-label': 'Search the catalogue' },
  })                    ;

  const effectPicker = el('select')                     ;
  for (const [value, label] of [['', 'Any effect'], ['read', 'Reads only'], ['changes', 'Changes something'], ['destructive', 'Destructive']]         ) {
    append(effectPicker, el('option', { text: label, attrs: { value } }));
  }

  const controls = card(
    'Commands',
    el(
      'p',
      { class: 'muted' },
      el('span', { text: `${ALL_COMMANDS.length} commands across four languages. Search by what you are trying to do, not by the name — the task text is weighted above it.` }),
    ),
    el(
      'div',
      { class: 'field-row' },
      el('div', { class: 'field' }, el('div', { class: 'field-head' }, el('label', { text: 'Language' })), picker),
      el('div', { class: 'field' }, el('div', { class: 'field-head' }, el('label', { text: 'Search' })), box),
      el('div', { class: 'field' }, el('div', { class: 'field-head' }, el('label', { text: 'Effect' })), effectPicker),
    ),
    el('p', { class: 'muted cmd-count' }),
  );

  const results = el('div', { class: 'cmd-results' });
  const findings = el('div', {});

  function matching()                          {
    const commands = commandsFor(platform).filter((command) => (effect === '' ? true : command.effect === effect));
    return query.trim() === '' ? commands : search(commands, query, 200);
  }

  function draw()       {
    const commands = matching();
    const count = controls.querySelector('.cmd-count');
    if (count) {
      count.textContent =
        query.trim() === ''
          ? `${commands.length} commands in ${catalogFor(platform).length} groups. Every one carries the thing about it that is not in the help.`
          : `${commands.length} matching “${query.trim()}”, best first.`;
    }

    clear(results);

    if (commands.length === 0) {
      append(results, el('p', { class: 'empty', text: 'Nothing matches. Try the task rather than the command — "open ports" rather than "ss".' }));
    } else if (query.trim() === '') {
      // Unsearched, the catalogue reads best in its own groups.
      for (const group of catalogFor(platform)) {
        const inGroup = group.commands.filter((command) => (effect === '' ? true : command.effect === effect));
        if (inGroup.length === 0) continue;
        const section = el('section', { class: 'card cmd-group' }, el('div', { class: 'card-title' }, el('h2', { text: group.name }), el('span', { class: 'pill', text: String(inGroup.length) })));
        for (const command of inGroup) append(section, commandRow(command));
        append(results, section);
      }
    } else {
      const section = el('section', { class: 'card cmd-group' }, el('div', { class: 'card-title' }, el('h2', { text: 'Results' })));
      for (const command of commands) append(section, commandRow(command));
      append(results, section);
    }

    const rows = coverage(catalogFor(platform));
    replace(
      findings,
      card(
        'What the catalogue says',
        findingsList(catalogFindings(commandsFor(platform))),
        el(
          'div',
          { class: 'table-wrap' },
          el(
            'table',
            { class: 'data-table' },
            el('thead', {}, el('tr', {}, el('th', { text: 'Group' }), el('th', { text: 'Commands' }), el('th', { text: 'With a note' }))),
            el(
              'tbody',
              {},
              ...rows.map((row) => el('tr', {}, el('td', { text: row.group }), el('td', { text: String(row.count) }), el('td', { text: `${row.withNotes}` }))),
            ),
          ),
        ),
      ),
    );
  }

  picker.addEventListener('change', () => {
    platform = (picker.value                  ) ?? 'powershell';
    draw();
  });
  effectPicker.addEventListener('change', () => {
    effect = effectPicker.value                 ;
    draw();
  });
  box.addEventListener('input', () => {
    query = box.value;
    draw();
  });

  clear(root);
  append(root, controls, results, findings);

  // A link from elsewhere — scripts.html#commands:sh.ss — opens on that command.
  const wanted = (globalThis.location?.hash ?? '').split(':')[1];
  if (wanted) {
    const owner = ALL_COMMANDS.find((command) => command.id === wanted);
    if (owner) {
      platform = owner.platform;
      picker.value = owner.platform;
      draw();
      const open = root.querySelector                    (`details[id="${CSS.escape(owner.id)}"]`);
      if (open) {
        open.open = true;
        open.scrollIntoView({ block: 'center' });
      }
      return;
    }
  }

  draw();
}
