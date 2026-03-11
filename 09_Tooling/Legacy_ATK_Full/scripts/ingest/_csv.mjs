import fs from "node:fs";

export function readCsv(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const rows = parseCsv(raw);
  if (!rows.length) return [];
  const headers = rows[0].map((h) => (h ?? "").toString().trim());
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.every((c) => (c ?? "").toString().trim() === "")) continue;
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c] || `col_${c}`;
      obj[key] = (r[c] ?? "").toString().trim();
    }
    out.push(obj);
  }
  return out;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
      continue;
    }

    if (ch === '"') { inQuotes = true; continue; }

    if (ch === ",") { row.push(field); field = ""; continue; }

    if (ch === "\r" && next === "\n") { row.push(field); field = ""; rows.push(row); row = []; i++; continue; }
    if (ch === "\n") { row.push(field); field = ""; rows.push(row); row = []; continue; }

    field += ch;
  }

  row.push(field);
  rows.push(row);

  while (rows.length && rows[rows.length - 1].every((c) => (c ?? "").toString().trim() === "")) rows.pop();
  return rows;
}
