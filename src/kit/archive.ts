/**
 * Zip and tar.gz, written in the browser with no library.
 *
 * Every page generates a set of files with paths. What a target system imports
 * is almost never a loose file: VCF Operations takes a content zip, Splunk an
 * app package (.spl or .tgz), an ABX action a zip, and everything else is a
 * folder the scripts expect to find their payloads in. So the download is an
 * archive that keeps every path, and scripts keep their executable bit.
 *
 * A path segment that itself ends in an archive extension is packaged as an
 * archive inside the archive: `import/content.zip/dashboards/a.json` becomes a
 * file `import/content.zip` holding `dashboards/a.json`. That is how a page
 * says "this part is a package to upload as it stands" without writing binary.
 *
 * Zip entries are stored rather than deflated: import dialogs care about the
 * format, not the ratio, and a stored zip is a few dozen lines. The tar is
 * compressed with the platform's own gzip (CompressionStream), available in
 * every current browser and in Node.
 */

export type ArchiveInput = Readonly<Record<string, string | Uint8Array>>;

const encoder = new TextEncoder();

function bytesOf(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? encoder.encode(content) : content;
}

/** Scripts keep their executable bit, so an unzipped `apply.sh` runs as it is. */
function isExecutable(path: string): boolean {
  return /\.(sh|bash|py|ps1)$/i.test(path) || /(^|\/)bin\/[^/.]+$/.test(path);
}

// --- nested archives ---------------------------------------------------------

const NESTED = /^(.*?[^/]+\.(zip|tgz|spl|tar\.gz))\/(.+)$/i;

/**
 * Turn `a/b.zip/c/d.json` entries into a single `a/b.zip` entry whose content
 * is that archive, recursively. Everything else passes through.
 */
export async function packNested(files: ArchiveInput): Promise<Record<string, Uint8Array>> {
  const flat: Record<string, Uint8Array> = {};
  const groups = new Map<string, { kind: string; files: Record<string, string | Uint8Array> }>();
  for (const [path, content] of Object.entries(files)) {
    const match = NESTED.exec(path);
    if (!match) {
      flat[path] = bytesOf(content);
      continue;
    }
    const [, archive = '', kind = 'zip', inner = ''] = match;
    const group = groups.get(archive) ?? { kind: kind.toLowerCase(), files: {} };
    group.files[inner] = content;
    groups.set(archive, group);
  }
  for (const [archive, group] of groups) {
    flat[archive] = group.kind === 'zip' ? await zip(group.files) : await tarGz(group.files);
  }
  return flat;
}

// --- zip ---------------------------------------------------------------------

let crcTable: Uint32Array | null = null;

export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** DOS date and time for the zip headers. */
function dosDateTime(date: Date): { time: number; date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** A stored (uncompressed) zip, UTF-8 names, Unix permissions. */
export async function zip(files: ArchiveInput, when = new Date()): Promise<Uint8Array> {
  const entries = Object.entries(await packNested(files)).sort(([a], [b]) => a.localeCompare(b));
  const { time, date } = dosDateTime(when);
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const [path, data] of entries) {
    const name = encoder.encode(path.replace(/^\/+/, ''));
    const crc = crc32(data);
    const mode = isExecutable(path) ? 0o100755 : 0o100644;

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    locals.push(local, data);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, (3 << 8) | 20, true); // made by Unix, so the mode is honoured
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(38, (mode << 16) >>> 0, true); // external attributes: Unix mode
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);

    offset += local.length + data.length;
  }

  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  return concat([...locals, ...centrals, end]);
}

// --- tar.gz -------------------------------------------------------------------

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function tarHeader(path: string, size: number, mode: number, mtime: number, type: '0' | '5'): Uint8Array {
  const header = new Uint8Array(512);
  let name = path;
  let prefix = '';
  // ustar: 100-byte name, 155-byte prefix. Split on a slash when it is longer.
  if (encoder.encode(name).length > 100) {
    const cut = path.lastIndexOf('/', 155);
    prefix = path.slice(0, cut);
    name = path.slice(cut + 1);
    if (encoder.encode(name).length > 100 || encoder.encode(prefix).length > 155) {
      throw new Error(`Path too long for a tar archive: ${path}`);
    }
  }
  const put = (text: string, at: number) => header.set(encoder.encode(text), at);
  put(name, 0);
  put(octal(mode, 8), 100);
  put(octal(0, 8), 108); // uid
  put(octal(0, 8), 116); // gid
  put(octal(size, 12), 124);
  put(octal(mtime, 12), 136);
  put('        ', 148); // checksum placeholder
  put(type, 156);
  put('ustar\0', 257);
  put('00', 263);
  put(prefix, 345);
  let sum = 0;
  for (const byte of header) sum += byte;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return header;
}

/** A ustar archive, gzipped. Directories are written so the layout is explicit. */
export async function tarGz(files: ArchiveInput, when = new Date()): Promise<Uint8Array> {
  const entries = Object.entries(await packNested(files)).sort(([a], [b]) => a.localeCompare(b));
  const mtime = Math.floor(when.getTime() / 1000);
  const parts: Uint8Array[] = [];
  const dirs = new Set<string>();
  for (const [path] of entries) {
    const segments = path.split('/');
    for (let i = 1; i < segments.length; i++) dirs.add(`${segments.slice(0, i).join('/')}/`);
  }
  for (const dir of [...dirs].sort()) parts.push(tarHeader(dir, 0, 0o755, mtime, '5'));
  for (const [path, data] of entries) {
    parts.push(tarHeader(path, data.length, isExecutable(path) ? 0o755 : 0o644, mtime, '0'));
    parts.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(1024));
  return gzip(concat(parts));
}

async function gzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
