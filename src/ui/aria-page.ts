/**
 * The Aria Operations content viewer.
 *
 * Drop whatever the appliance gave you — the content package, the JSON
 * inventories a script pulled from the suite API, or both — and get the thing
 * the product will not show you: all of it at once, cross-referenced, with the
 * questions answered that are about the whole rather than about one object.
 *
 * Findings first, then a tab per kind. Findings first because the reason to
 * open this is not to browse two thousand alert definitions; it is to find out
 * that two thousand of them notify nobody.
 *
 * Nothing is uploaded, nothing is stored. Close the tab and the export is gone
 * from the browser — which is the right behaviour for a file full of an
 * estate's object names, thresholds and email addresses.
 */

import { el, append, clear, replace } from './dom.ts';
import { card, findingsList, stat, statGrid } from './components.ts';
import { mountTabs, type Pane } from './tab-shell.ts';
import { countBy, isEmpty, merge, EMPTY_CONTENT, SEVERITY_MEANING, type AriaContent, type AriaSeverity } from '../aria/aria.ts';
import { readAriaFile } from '../aria/parse.ts';
import { ariaFindings, ariaSummary, unnotifiedAlerts } from '../aria/findings.ts';
import { mountDashboardView } from './aria-dashboard.ts';
import { mountReportsView, mountViewsView } from './aria-content-view.ts';

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

function severityPill(severity: AriaSeverity): HTMLElement {
  return el('span', {
    class: `pill severity-${severity}`,
    text: severity,
    attrs: { title: SEVERITY_MEANING[severity] },
  });
}

/** A table that can be searched, with a count and a cap on what it draws. */
function browser<T>(options: {
  readonly items: readonly T[];
  readonly columns: readonly { readonly header: string; readonly cell: (item: T) => HTMLElement | string }[];
  readonly search: (item: T) => string;
  readonly empty: string;
  readonly note?: string;
  readonly filters?: readonly { readonly label: string; readonly keep: (item: T) => boolean }[];
}): HTMLElement {
  const LIMIT = 300;
  const wrap = el('div', { class: 'stack' });
  const box = el('input', { attrs: { type: 'search', placeholder: 'Search…', 'aria-label': 'Search' } }) as HTMLInputElement;
  const filterPicker = el('select') as HTMLSelectElement;
  append(filterPicker, el('option', { text: 'Everything', attrs: { value: '' } }));
  for (const filter of options.filters ?? []) {
    append(filterPicker, el('option', { text: filter.label, attrs: { value: filter.label } }));
  }

  const count = el('p', { class: 'muted' });
  const body = el('div', {});

  function matching(): readonly T[] {
    const query = box.value.trim().toLowerCase();
    const chosen = (options.filters ?? []).find((filter) => filter.label === filterPicker.value);
    let items = chosen ? options.items.filter(chosen.keep) : options.items;
    if (query) {
      const terms = query.split(/\s+/);
      items = items.filter((item) => {
        const haystack = options.search(item).toLowerCase();
        return terms.every((term) => haystack.includes(term));
      });
    }
    return items;
  }

  function draw(): void {
    const items = matching();
    count.textContent =
      items.length === 0
        ? options.empty
        : items.length > LIMIT
          ? `${items.length} match. Showing the first ${LIMIT} — narrow the search to see the rest.`
          : `${items.length} of ${options.items.length}.`;

    const head = el('tr');
    for (const column of options.columns) append(head, el('th', { text: column.header }));
    const tbody = el('tbody');
    for (const item of items.slice(0, LIMIT)) {
      const row = el('tr');
      for (const column of options.columns) {
        const cell = column.cell(item);
        append(row, el('td', {}, typeof cell === 'string' ? el('span', { text: cell }) : cell));
      }
      append(tbody, row);
    }
    replace(body, el('div', { class: 'table-wrap' }, el('table', { class: 'data-table' }, el('thead', {}, head), tbody)));
  }

  box.addEventListener('input', draw);
  filterPicker.addEventListener('change', draw);

  append(
    wrap,
    options.note ? el('p', { class: 'tip', text: options.note }) : el('span', {}),
    el(
      'div',
      { class: 'field-row' },
      el('div', { class: 'field' }, el('div', { class: 'field-head' }, el('label', { text: 'Search' })), box),
      (options.filters ?? []).length > 0
        ? el('div', { class: 'field' }, el('div', { class: 'field-head' }, el('label', { text: 'Show' })), filterPicker)
        : el('span', {}),
    ),
    count,
    body,
  );
  draw();
  return wrap;
}

/** A census table — what kinds of thing there are and how many of each. */
function census(title: string, rows: readonly { readonly name: string; readonly count: number }[], limit = 20): HTMLElement {
  const tbody = el('tbody');
  for (const row of rows.slice(0, limit)) {
    append(tbody, el('tr', {}, el('td', { text: row.name }), el('td', { text: String(row.count) })));
  }
  return card(
    title,
    el('div', { class: 'table-wrap' }, el('table', { class: 'data-table' }, el('thead', {}, el('tr', {}, el('th', { text: 'Kind' }), el('th', { text: 'Count' }))), tbody)),
    rows.length > limit ? el('p', { class: 'muted', text: `${rows.length - limit} more not shown.` }) : el('span', {}),
  );
}

// ---------------------------------------------------------------------------
// The panes
// ---------------------------------------------------------------------------

function panesFor(content: AriaContent): Pane[] {
  const panes: Pane[] = [];
  const unnotified = new Set(unnotifiedAlerts(content).map((alert) => alert.id));
  const symptomsById = new Map(content.symptoms.map((symptom) => [symptom.id, symptom]));
  const policyById = new Map(content.policies.map((policy) => [policy.id, policy]));

  panes.push({
    id: 'findings',
    label: 'Findings',
    mount: (container) => {
      const summary = ariaSummary(content).filter((entry) => entry.value > 0);
      append(
        container,
        card(
          'What is in the export',
          statGrid(...summary.map((entry) => stat({ label: entry.label, value: entry.value, sub: entry.note }))),
        ),
        card('Findings', findingsList(ariaFindings(content))),
        card(
          'Files read',
          el(
            'div',
            { class: 'table-wrap' },
            el(
              'table',
              { class: 'data-table' },
              el('thead', {}, el('tr', {}, el('th', { text: 'File' }), el('th', { text: 'Holds' }), el('th', { text: 'Records' }))),
              el('tbody', {}, ...content.sources.map((s) => el('tr', {}, el('td', { text: s.name }), el('td', { text: s.kind }), el('td', { text: String(s.records) })))),
            ),
          ),
        ),
      );
    },
  });

  if (content.alerts.length > 0) {
    panes.push({
      id: 'alerts',
      label: `Alerts (${content.alerts.length})`,
      mount: (container) => {
        append(
          container,
          card(
            'Alert definitions',
            browser({
              items: [...content.alerts].sort((a, b) => a.name.localeCompare(b.name)),
              note: 'Notified means an enabled notification rule matches it. Everything else fires into the interface and reaches nobody.',
              search: (alert) => `${alert.name} ${alert.id} ${alert.adapterKind} ${alert.resourceKind} ${alert.description ?? ''}`,
              filters: [
                { label: 'Nobody is notified', keep: (alert) => unnotified.has(alert.id) },
                { label: 'Critical only', keep: (alert) => alert.severity === 'critical' },
                { label: 'No recommendation', keep: (alert) => alert.states.every((state) => state.recommendationIds.length === 0) },
                { label: 'No symptoms at all', keep: (alert) => alert.states.every((state) => state.symptomIds.length === 0) },
                { label: 'A symptom is missing', keep: (alert) => alert.states.some((state) => state.symptomIds.some((id) => !symptomsById.has(id))) },
              ],
              empty: 'No alert definitions match.',
              columns: [
                { header: 'Alert', cell: (alert) => el('span', { text: alert.name || alert.id }) },
                { header: 'Severity', cell: (alert) => severityPill(alert.severity) },
                { header: 'Object', cell: (alert) => `${alert.resourceKind}` },
                { header: 'Adapter', cell: (alert) => alert.adapterKind },
                { header: 'Symptoms', cell: (alert) => String(alert.states.reduce((n, state) => n + state.symptomIds.length, 0)) },
                {
                  header: 'Notified',
                  cell: (alert) =>
                    unnotified.has(alert.id)
                      ? el('span', { class: 'pill warn', text: 'nobody' })
                      : el('span', { class: 'pill', text: 'yes' }),
                },
              ],
            }),
          ),
          census('By adapter', countBy(content.alerts, (alert) => alert.adapterKind)),
        );
      },
    });
  }

  if (content.symptoms.length > 0) {
    const used = new Set(content.alerts.flatMap((alert) => alert.states.flatMap((state) => state.symptomIds)));
    panes.push({
      id: 'symptoms',
      label: `Symptoms (${content.symptoms.length})`,
      mount: (container) => {
        append(
          container,
          card(
            'Symptom definitions',
            browser({
              items: [...content.symptoms].sort((a, b) => a.name.localeCompare(b.name)),
              note: 'A dynamic threshold is one Aria works out for itself from the object’s own history; a static one is a number somebody typed.',
              search: (symptom) => `${symptom.name} ${symptom.id} ${symptom.adapterKind} ${symptom.resourceKind} ${symptom.key ?? ''}`,
              filters: [
                { label: 'Used by no alert', keep: (symptom) => !used.has(symptom.id) },
                { label: 'Dynamic threshold', keep: (symptom) => (symptom.thresholdType ?? '').toUpperCase() !== 'STATIC' },
                { label: 'Critical only', keep: (symptom) => symptom.severity === 'critical' },
              ],
              empty: 'No symptoms match.',
              columns: [
                { header: 'Symptom', cell: (symptom) => symptom.name || symptom.id },
                { header: 'Severity', cell: (symptom) => severityPill(symptom.severity) },
                { header: 'Object', cell: (symptom) => symptom.resourceKind },
                { header: 'Condition', cell: (symptom) => el('code', { text: [symptom.key, symptom.operator, symptom.value].filter(Boolean).join(' ') || '—' }) },
                { header: 'Threshold', cell: (symptom) => symptom.thresholdType ?? '—' },
              ],
            }),
          ),
        );
      },
    });
  }

  if (content.rules.length > 0 || content.templates.length > 0) {
    panes.push({
      id: 'notifications',
      label: 'Notifications',
      mount: (container) => {
        append(
          container,
          card(
            'Notification rules',
            el('p', { class: 'tip', text: 'Every filter on a rule means “everything” when it is empty. That cuts both ways: a rule with nothing set notifies on the whole estate, and a rule with an object-kind filter quietly stops covering an adapter added later.' }),
            browser({
              items: content.rules,
              search: (rule) => `${rule.name} ${Object.values(rule.properties).join(' ')}`,
              empty: 'No notification rules.',
              columns: [
                { header: 'Rule', cell: (rule) => rule.name },
                { header: 'On', cell: (rule) => (rule.enabled ? el('span', { class: 'pill', text: 'enabled' }) : el('span', { class: 'pill warn', text: 'disabled' })) },
                { header: 'Severity', cell: (rule) => (rule.criticalities.length > 0 ? rule.criticalities.join(', ') : 'any') },
                { header: 'Object kinds', cell: (rule) => (rule.resourceKinds.length > 0 ? rule.resourceKinds.join(', ') : 'any') },
                { header: 'Alerts', cell: (rule) => (rule.alertDefinitionIds.length > 0 ? `${rule.alertDefinitionIds.length} named` : 'any') },
                { header: 'Sends to', cell: (rule) => el('code', { text: Object.entries(rule.properties).filter(([key]) => /mail|addr|recipient/i.test(key)).map(([, value]) => value).join(', ') || '—' }) },
              ],
            }),
          ),
          content.templates.length > 0
            ? card(
                'Templates',
                browser({
                  items: content.templates,
                  search: (template) => `${template.name} ${template.pluginTypeId}`,
                  empty: 'No templates.',
                  columns: [
                    { header: 'Template', cell: (template) => template.name },
                    { header: 'Plugin', cell: (template) => template.pluginTypeId },
                    { header: 'Rules using it', cell: (template) => String(template.attachedRuleCount) },
                    { header: 'Editable', cell: (template) => (template.editable ? 'yes' : 'no') },
                  ],
                }),
              )
            : el('span', {}),
        );
      },
    });
  }

  if (content.policies.length > 0 || content.groups.length > 0) {
    panes.push({
      id: 'policies',
      label: 'Policies and groups',
      mount: (container) => {
        append(
          container,
          content.policies.length > 0
            ? card(
                'Policies',
                el('p', { class: 'tip', text: 'Priority decides which policy wins when an object is in more than one group. The alerts a policy turns off are where an alert that “should be firing” usually went.' }),
                browser({
                  items: [...content.policies].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99) || a.name.localeCompare(b.name)),
                  search: (policy) => `${policy.name} ${policy.description ?? ''}`,
                  empty: 'No policies.',
                  columns: [
                    { header: 'Policy', cell: (policy) => (policy.isDefault ? el('span', {}, el('span', { text: policy.name }), el('span', { class: 'pill', text: 'default' })) : el('span', { text: policy.name })) },
                    { header: 'Priority', cell: (policy) => (policy.priority === undefined ? '—' : String(policy.priority)) },
                    { header: 'Inherits from', cell: (policy) => (policy.parentPolicyId ? policyById.get(policy.parentPolicyId)?.name ?? policy.parentPolicyId : '—') },
                    { header: 'Alerts off', cell: (policy) => String(policy.disabledAlerts?.length ?? 0) },
                    { header: 'Groups on it', cell: (policy) => String(content.groups.filter((group) => group.policyId === policy.id).length) },
                  ],
                }),
              )
            : el('span', {}),
          content.groups.length > 0
            ? card(
                'Custom groups',
                browser({
                  items: [...content.groups].sort((a, b) => a.name.localeCompare(b.name)),
                  search: (group) => `${group.name} ${group.groupKind} ${group.rules.flatMap((rule) => rule.conditions).join(' ')}`,
                  filters: [
                    { label: 'On the default policy', keep: (group) => Boolean(group.policyId && policyById.get(group.policyId)?.isDefault) },
                    { label: 'Permanently empty', keep: (group) => group.rules.length === 0 && group.explicitMembers === 0 },
                    { label: 'Members picked by hand', keep: (group) => group.explicitMembers > 0 },
                  ],
                  empty: 'No groups match.',
                  columns: [
                    { header: 'Group', cell: (group) => group.name },
                    { header: 'Kind', cell: (group) => group.groupKind },
                    { header: 'Policy', cell: (group) => (group.policyId ? policyById.get(group.policyId)?.name ?? group.policyId : '—') },
                    { header: 'Rules', cell: (group) => el('code', { text: group.rules.flatMap((rule) => rule.conditions).join(' · ') || (group.explicitMembers > 0 ? `${group.explicitMembers} named members` : 'none') }) },
                  ],
                }),
              )
            : el('span', {}),
        );
      },
    });
  }

  if (content.superMetrics.length > 0) {
    panes.push({
      id: 'metrics',
      label: `Super metrics (${content.superMetrics.length})`,
      mount: (container) => {
        const rows = el('div', { class: 'stack' });
        for (const metric of [...content.superMetrics].sort((a, b) => a.name.localeCompare(b.name))) {
          const summary = el('summary', {}, el('span', { class: 'cmd-name', text: metric.name }));
          if (metric.dependsOn.length > 0) append(summary, el('span', { class: 'pill', text: `reads ${metric.dependsOn.length} other` }));
          append(
            rows,
            el(
              'details',
              { class: 'cmd' },
              summary,
              el(
                'div',
                { class: 'cmd-body' },
                metric.description ? el('p', { class: 'muted', text: metric.description }) : el('span', {}),
                el('pre', { class: 'code-block', text: metric.formula }),
              ),
            ),
          );
        }
        append(
          container,
          card(
            'Super metrics',
            el('p', { class: 'tip', text: 'A super metric that reads another one is a chain the interface does not show you. Changing the bottom of it changes dashboards nobody connected to it.' }),
            rows,
          ),
        );
      },
    });
  }

  if (content.dashboards.length > 0) {
    panes.push({
      id: 'dashboards',
      label: `Dashboards (${content.dashboards.length})`,
      // One dashboard at a time, and a way to get to any other. Everything
      // else that was here — a searchable table, a wall of thumbnails, a
      // widget census — was a second and third way to do the same job, and
      // three ways to do one job is not a feature.
      mount: (container) => mountDashboardView(container, content.dashboards, content.views),
    });
  }

  // Views and reports get the same treatment as dashboards: one at a time,
  // with a dropdown and Previous and Next. They are separate tabs because a
  // view is a thing and a report is a stack of them, and mixing the two made
  // both harder to find.
  if (content.views.length > 0) {
    panes.push({
      id: 'views',
      label: `Views (${content.views.length})`,
      mount: (container) => mountViewsView(container, content.views, content.dashboards, content.reports),
    });
  }

  if (content.reports.length > 0) {
    panes.push({
      id: 'reports',
      label: `Reports (${content.reports.length})`,
      mount: (container) => mountReportsView(container, content.reports, content.views, content.dashboards),
    });
  }

  return panes;
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export function mountAriaPage(root: HTMLElement): void {
  let content: AriaContent = EMPTY_CONTENT;

  const input = el('input', {
    attrs: { type: 'file', accept: '.zip,.json,.xml', multiple: true, hidden: 'hidden' },
  }) as HTMLInputElement;

  const status = el('p', { class: 'muted' });
  const errors = el('div', {});
  const results = el('div', {});

  const bar = el(
    'div',
    { class: 'estate-bar' },
    el('strong', { text: 'Drop the export here. ' }),
    el('span', {
      class: 'muted',
      text: 'The content package (.zip) from Aria Operations, the dashboards folder from it, or the JSON inventories pulled from the suite API — in any combination, in any order.',
    }),
    el('span', { class: 'estate-actions' }, el('button', { class: 'btn btn-small', text: 'Choose files…', on: { click: () => input.click() } }), input),
    status,
  );

  async function load(files: readonly File[]): Promise<void> {
    if (files.length === 0) return;
    const problems: string[] = [];
    for (const [index, file] of files.entries()) {
      status.textContent = `Reading ${file.name} (${index + 1} of ${files.length})…`;
      try {
        const read = await readAriaFile(file.name, await file.arrayBuffer());
        content = merge(content, read);
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
      }
    }

    status.textContent = isEmpty(content) ? 'Nothing read yet.' : `${content.sources.length} file${content.sources.length === 1 ? '' : 's'} read. Drop more to add to it.`;

    replace(
      errors,
      problems.length > 0
        ? card('Not read', el('ul', {}, ...problems.map((problem) => el('li', { text: problem }))))
        : el('span', {}),
    );

    draw();
  }

  function draw(): void {
    clear(results);
    if (isEmpty(content)) {
      append(
        results,
        card(
          'What this reads',
          el('p', { text: 'Aria Operations will export what is configured in it, and the export is accurate and unreadable — alert definitions as a five-megabyte JSON array, dashboards as a zip of zips. This reads all of it at once and answers the questions that are about the whole rather than about one object.' }),
          el(
            'ul',
            {},
            el('li', { text: 'Which alert definitions match no enabled notification rule — they fire, sit in the interface, and tell nobody.' }),
            el('li', { text: 'Which alerts point at a symptom that has been deleted, and so can never fire at all.' }),
            el('li', { text: 'Which custom groups are still on the default policy, and are therefore doing nothing.' }),
            el('li', { text: 'Which dashboards are private copies of a shared one, and which reports have never been scheduled.' }),
          ),
          el('p', { class: 'tip', text: 'Everything is read in this browser. Nothing is uploaded and nothing is kept — close the tab and it is gone. An Aria export carries estate names, thresholds and email addresses, so keep the file out of a repository and out of a ticket.' }),
          el(
            'p',
            { class: 'muted' },
            el('strong', { text: 'Where to get it: ' }),
            el('span', { text: 'Administration → Content → and export alert definitions, symptom definitions, recommendations, policies, custom groups, super metrics, notification settings, views, reports and dashboards. Anything you leave out is simply a tab that does not appear here.' }),
          ),
        ),
      );
      return;
    }

    const panes = panesFor(content);
    const host = el('div', {});
    append(results, host);
    mountTabs(host, panes, 'findings');
  }

  input.addEventListener('change', () => void load(Array.from(input.files ?? [])));
  for (const event of ['dragover', 'dragenter'] as const) {
    bar.addEventListener(event, (e) => {
      e.preventDefault();
      bar.classList.add('dragging');
    });
  }
  bar.addEventListener('dragleave', () => bar.classList.remove('dragging'));
  bar.addEventListener('drop', (e) => {
    e.preventDefault();
    bar.classList.remove('dragging');
    void load(Array.from((e as DragEvent).dataTransfer?.files ?? []));
  });

  clear(root);
  append(root, bar, errors, results);
  draw();
}

const root = document.getElementById('aria-root');
if (root) mountAriaPage(root);
