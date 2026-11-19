import { downloadFile } from '../lib/ui/dom.js';
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
export function reportHtml(title, sections) {
  return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + escapeHtml(title) + '</title>' +
    '<style>body{font:15px system-ui,sans-serif;color:#17253d;margin:2rem auto;padding:0 1rem;max-width:1200px}h1,h2{line-height:1.25}table{border-collapse:collapse;width:100%;margin:1rem 0}th,td{border:1px solid #ccd4df;padding:.6rem;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:#eef1f6}pre{white-space:pre-wrap;font:inherit}@media print{button{display:none}body{margin:0;max-width:none}thead{display:table-header-group}tr{break-inside:avoid}h2{break-after:avoid}}@page{size:landscape;margin:14mm}</style>' +
    '<h1>' + escapeHtml(title) + '</h1><p>Generated ' + escapeHtml(new Date().toLocaleString()) + '</p><button onclick="window.print()">Print / Save PDF</button>' +
    sections.map(section => '<section><h2>' + escapeHtml(section.title) + '</h2>' + (section.text ? '<p>' + escapeHtml(section.text) + '</p>' : '') +
      (section.headers ? '<table><thead><tr>' + section.headers.map(value => '<th>' + escapeHtml(value) + '</th>').join('') + '</tr></thead><tbody>' + section.rows.map(row => '<tr>' + row.map(value => '<td>' + escapeHtml(value) + '</td>').join('') + '</tr>').join('') + '</tbody></table>' : '') + '</section>').join('') + '</html>';
}
export function downloadReport(filename, title, sections) { downloadFile(filename + '.html', reportHtml(title, sections), 'text/html'); }
