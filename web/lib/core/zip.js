/**
 * Reading a zip, with nothing but the platform.
 *
 * `src/core/xlsx.ts` already has a zip reader inside it, but that one is built
 * for a different problem: a 150 MB sheet that has to be streamed a chunk at a
 * time and never held whole. An Aria Operations export is the opposite shape —
 * a few hundred small entries, several of which are themselves zips — so what
 * is wanted here is an entry's bytes, in hand, so the nested archive can be
 * opened in turn.
 *
 * `DecompressionStream('deflate-raw')` does the inflating, which is in every
 * current browser and in Node 18+, so this stays a zero-dependency toolkit that
 * works from a folder on a laptop with no network.
 */

export class ZipError extends Error {}

                           
                        
                                                       
                          
                                  
                                    
                                     
 

                             
                                        
                                                 
                                    
                             
                                           
                                      
 

/** True when the bytes begin with a local file header. */
export function looksLikeZip(bytes            )          {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
}

function readDirectory(bytes            )             {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // The end-of-central-directory record is in the last 22 bytes plus up to
  // 64 KiB of comment, so it is found by scanning backwards for its signature.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('This is not a zip file: no central directory was found.');

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const entries             = [];

  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      throw new ZipError('The zip directory is damaged.');
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function inflate(bytes            , entry          )                      {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = entry.localHeaderOffset;
  if (view.getUint32(at, true) !== 0x04034b50) {
    throw new ZipError(`The entry ${entry.name} is damaged.`);
  }
  // The local header repeats the name and carries its own extra field, whose
  // length can differ from the central directory's copy.
  const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
  const data = bytes.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return data.slice();
  if (entry.method !== 8) throw new ZipError(`The entry ${entry.name} uses an unsupported compression method.`);

  const source = new ReadableStream            ({
    start(controller) {
      controller.enqueue(data.slice());
      controller.close();
    },
  });
  const stream = source.pipeThrough(new DecompressionStream('deflate-raw')                                                      );

  const chunks               = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
    }
  }

  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}

export function openZip(data                          )             {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const entries = readDirectory(bytes);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const decoder = new TextDecoder();

  const find = (name        )           => {
    const entry = byName.get(name);
    if (!entry) throw new ZipError(`The zip has no entry called ${name}.`);
    return entry;
  };

  return {
    entries,
    names: entries.map((entry) => entry.name),
    has: (name) => byName.has(name),
    bytes: (name) => inflate(bytes, find(name)),
    text: async (name) => {
      const raw = await inflate(bytes, find(name));
      // A file written by PowerShell's Out-File or Set-Content often carries a
      // byte-order mark, which JSON.parse refuses with a message that blames
      // the first character rather than the mark.
      return stripBom(decoder.decode(raw));
    },
  };
}

/** Remove a UTF-8 byte-order mark, which JSON.parse will not forgive. */
export function stripBom(text        )         {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
