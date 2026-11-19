import { openXlsx, looksLikeXlsx, type XlsxWorkbook } from '../core/xlsx.ts';
import { parseCsv } from '../core/csv.ts';
import { storeInventory, type StoredEstate, type StoredInventoryFile } from '../kit/estate-store.ts';
import { detectSheet } from '../vmware/rvtools.ts';
import { el, replace } from './dom.ts';
import { card, field, select } from './components.ts';
import { importedWorksheet } from '../vmware/rvtools-views.ts';
import { inventoryTableView } from './inventory-table-view.ts';
export function inventoryWorksheets(entry: StoredEstate) {
  let files = [...(entry.sourceFiles ?? [])];
  let activeFile: StoredInventoryFile | undefined;
  let workbook: XlsxWorkbook | undefined;
  let token = 0;
  const bookFiles = () => files.filter(file => looksLikeXlsx(file.bytes));
  async function open(file: StoredInventoryFile): Promise<XlsxWorkbook> {
    if (activeFile !== file || !workbook) { const result = await openXlsx(file.bytes); activeFile = file; workbook = result; }
    return workbook;
  }
  async function show(root: HTMLElement, sheet: string): Promise<void> {
    const current = ++token;
    const status = el('p', { attrs: { role: 'status' } });
    const content = el('div');
    const choices = bookFiles();
    const csv = files.filter(file => /\.csv$/i.test(file.name) && detectSheet(new TextDecoder().decode(file.bytes)) === sheet);
    const sources = [...choices, ...csv];
    const selector = select(sources.map((file, i) => ({ value: String(i), label: file.name })), '0');
    const attach = el('input', { attrs: { type: 'file', accept: '.xlsx', multiple: true, hidden: true } });
    const attachButton = el('button', { class: 'btn', text: 'Attach original workbook', attrs: { type: 'button' }, on: { click: () => attach.click() } });
    const heading = card(sheet, sources.length > 1 ? field('Source file', selector) : null,
      sources.length ? el('p', { class: 'muted', text: 'Original worksheet values. Blank cells remain unknown. Source files are displayed individually.' }) : el('p', { text: 'Showing fields retained in the imported inventory. Attach the original workbook to include every original column.' }),
      attachButton, attach, status, content);
    replace(root, heading);
    async function read(): Promise<void> {
      const request = ++token; status.textContent = 'Reading ' + sheet + '…';
      replace(content);
      const file = sources[Number(selector.value)];
      if (!file) { status.textContent = 'No original worksheet available.'; return; }
      try {
        let headers: string[] = []; let rows: string[][] = [];
        if (looksLikeXlsx(file.bytes)) {
          const book = await open(file);
          if (request !== token) return;
          if (!book.sheets.includes(sheet)) { status.textContent = 'This workbook does not contain ' + sheet + '.'; return; }
          await book.rows(sheet, (cells, index) => { if (request !== token) return false; if (index === 0) headers = cells; else rows.push(cells); });
        } else {
          const parsed = parseCsv(new TextDecoder().decode(file.bytes)); headers = [...parsed.headers]; rows = parsed.rows;
        }
        if (request !== token) return;
        status.textContent = '';
        inventoryTableView(content, sheet, headers, rows);
      } catch (error) { if (request === token) status.textContent = 'Could not read worksheet. ' + String(error); }
    }
    selector.addEventListener('change', () => void read());
    attach.addEventListener('change', async () => {
      const selected = Array.from(attach.files ?? []); attach.value = '';
      if (!selected.length) return;
      attachButton.disabled = true; status.textContent = 'Checking workbook row counts against this estate…';
      try {
        const additions: StoredInventoryFile[] = [];
        const counts: Record<string, number> = {};
        for (const file of selected) {
          const bytes = new Uint8Array(await file.arrayBuffer()); const book = await openXlsx(bytes);
          for (const tab of book.sheets) {
            const count = await book.rows(tab, () => {});
            counts[tab] = (counts[tab] ?? 0) + Math.max(0, count - 1);
          }
          additions.push({ name: file.name, bytes });
        }
        const expected = Object.entries(entry.inventory.source.tabs ?? {});
        if (!expected.length || expected.some(([tab, count]) => counts[tab] !== count)) throw Error('Worksheet row counts do not match the loaded estate. Import this workbook as a new estate instead.');
        files = additions;
        const saved = await storeInventory(entry.inventory, entry.findings, entry.origin, files);
        activeFile = undefined; workbook = undefined;
        await show(root, sheet);
        if (!saved) root.prepend(el('p', { attrs: { role: 'status' }, text: 'Worksheets attached for this session. Browser storage could not save the source files.' }));
      } catch (error) { status.textContent = String(error); }
      finally { attachButton.disabled = false; }
    });
    if (current === token && sources.length) await read();
    else if (current === token) {
      const view = importedWorksheet(entry.inventory,sheet);
      const sourceRows = entry.inventory.source.tabs?.[sheet];
      status.textContent = view.summary ? 'Storage paths were retained as host summaries. Attach the original workbook for individual path rows.'
        : sourceRows !== undefined && sourceRows !== view.rows.length ? sourceRows + ' source rows; ' + view.rows.length + ' inventory records retained. Guidance-only rows may not be inventory records. Attach the original workbook for all original rows.' : '';
      inventoryTableView(content,sheet,view.headers,view.rows);
    }
  }
  async function names(): Promise<string[]> {
    const result = new Set<string>();
    for (const file of bookFiles()) for (const name of (await open(file)).sheets) result.add(name);
    for (const file of files.filter(file => /\.csv$/i.test(file.name))) {
      const name = detectSheet(new TextDecoder().decode(file.bytes)); if (name) result.add(name);
    }
    return [...result];
  }
  return { show, names, cancel: () => { token++; } };
}
