/**
 * The estate strip at the top of every tool page.
 *
 * Import once, anywhere: the RVTools workbook as RVTools writes it, its tabs as
 * CSV, or a collector JSON. The strip says whose estate every page is working
 * from, and offers the three things you might want to do about it — import a
 * different one, look at it, or forget it.
 */

import { el, append, replace, readFileAsText } from './dom.ts';
import { formatCount } from '../core/units.ts';
import type { Finding } from '../core/findings.ts';
import { importRvToolsFiles, importRvToolsWorkbook, looksLikeXlsx } from '../vmware/rvtools.ts';
import { importCollectorJson } from '../vmware/powercli.ts';
import { mergeInventories, type Inventory } from '../vmware/inventory.ts';
import {
  forgetInventory,
  loadInventory,
  storeInventory,
  summarise,
  type StoredEstate,
} from '../kit/estate-store.ts';

export interface ImportedEstate {
  readonly inventory: Inventory;
  readonly findings: readonly Finding[];
  readonly origin: string;
}

/** Read whatever was dropped: workbook, CSV tabs, collector JSON, or a mix. */
export async function importEstateFiles(
  files: readonly File[],
  onProgress?: (message: string) => void,
): Promise<ImportedEstate> {
  const inventories: Inventory[] = [];
  const findings: Finding[] = [];
  const csv: { name: string; content: string }[] = [];

  for (const file of files) {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (looksLikeXlsx(head) || /\.xlsx$/i.test(file.name)) {
      onProgress?.(`Opening ${file.name}…`);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await importRvToolsWorkbook(bytes, {
        label: file.name,
        onProgress: (p) =>
          onProgress?.(p.tab ? `Reading ${p.tab} (${p.done + 1} of ${p.total})…` : 'Assembling the estate…'),
      });
      inventories.push(result.inventory);
      findings.push(...result.findings);
      continue;
    }
    const content = await readFileAsText(file);
    if (/\.json$/i.test(file.name) || content.trimStart().startsWith('{')) {
      const result = importCollectorJson(content);
      inventories.push(result.inventory);
      findings.push(...result.findings);
    } else {
      csv.push({ name: file.name, content });
    }
  }
  if (csv.length > 0) {
    onProgress?.(`Reading ${csv.length} CSV file(s)…`);
    const result = importRvToolsFiles(csv);
    inventories.push(result.inventory);
    findings.push(...result.findings);
  }

  const origin = files.length === 1 ? (files[0] as File).name : `${files.length} files`;
  return { inventory: mergeInventories(inventories), findings, origin };
}

export interface EstateBarOptions {
  /** Called once with whatever is stored, and again after every import or forget. */
  readonly onEstate: (estate: StoredEstate | null) => void;
  /** What the page does with an estate, for the empty-state line. */
  readonly purpose: string;
}

/** Mount the strip. Resolves once the stored estate, if any, has been read. */
export async function mountEstateBar(root: HTMLElement, options: EstateBarOptions): Promise<StoredEstate | null> {
  const bar = el('div', { class: 'estate-bar' });
  root.prepend(bar);

  const input = el('input', {
    attrs: { type: 'file', accept: '.xlsx,.csv,.json', multiple: true, hidden: 'hidden' },
  }) as HTMLInputElement;
  const status = el('span', { class: 'estate-status' });

  async function load(files: File[]): Promise<void> {
    if (files.length === 0) return;
    try {
      const imported = await importEstateFiles(files, (m) => {
        status.textContent = m;
      });
      status.textContent = 'Saving…';
      await storeInventory(imported.inventory, imported.findings, imported.origin);
      const entry = await loadInventory();
      render(entry);
      options.onEstate(entry);
    } catch (err) {
      status.textContent = `Could not read that: ${(err as Error).message}`;
    }
  }
  input.addEventListener('change', () => void load(Array.from(input.files ?? [])));
  bar.addEventListener('dragover', (e) => {
    e.preventDefault();
    bar.classList.add('dragging');
  });
  bar.addEventListener('dragleave', () => bar.classList.remove('dragging'));
  bar.addEventListener('drop', (e) => {
    e.preventDefault();
    bar.classList.remove('dragging');
    void load(Array.from((e as DragEvent).dataTransfer?.files ?? []));
  });

  const importButton = el('button', {
    class: 'btn btn-small',
    text: 'Import RVTools…',
    on: { click: () => input.click() },
  });

  function render(entry: StoredEstate | null): void {
    if (!entry) {
      replace(
        bar,
        el('strong', { text: 'No estate loaded. ' }),
        el('span', { class: 'muted', text: `Import an RVTools export (the .xlsx as it is) to ${options.purpose}.` }),
        el('span', { class: 'estate-actions' }, importButton, input),
        status,
      );
      return;
    }
    const s = summarise(entry);
    const inv = entry.inventory;
    const when = inv.source.collectedAt ? ` · collected ${inv.source.collectedAt.replace('T', ' ').slice(0, 16)}` : '';
    replace(
      bar,
      el('strong', { text: 'Estate: ' }),
      el('span', {
        text: `${entry.origin} — ${formatCount(s.vms)} VMs, ${formatCount(s.hosts)} hosts, ${formatCount(s.clusters)} clusters, ${s.vcenters} vCenter${s.vcenters === 1 ? '' : 's'}${when}`,
      }),
      el(
        'span',
        { class: 'estate-actions' },
        el('a', { class: 'btn btn-small', text: 'Open', attrs: { href: 'inventory.html' } }),
        importButton,
        el('button', {
          class: 'btn btn-small',
          text: 'Forget',
          attrs: { title: 'Delete the estate from this browser' },
          on: {
            click: async () => {
              await forgetInventory();
              status.textContent = '';
              render(null);
              options.onEstate(null);
            },
          },
        }),
        input,
      ),
      status,
    );
    status.textContent = '';
  }

  append(bar, el('span', { class: 'muted', text: 'Reading the stored estate…' }));
  const entry = await loadInventory();
  render(entry);
  options.onEstate(entry);
  return entry;
}
