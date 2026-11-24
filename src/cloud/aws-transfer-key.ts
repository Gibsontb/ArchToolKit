/** Structural OpenSSH public-key validation. The service still validates actual key material. */
export function transferPublicKey(text: string, fips: boolean): string | undefined {
  const [type = '', encoded = ''] = text.trim().split(/\s+/);
  if (!/^(?:ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521))$/.test(type) || (fips && type === 'ssh-ed25519') || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > 8192) return undefined;
  try {
    const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
    let offset = 0;
    const read = () => {
      if (offset + 4 > bytes.length) throw new Error('Truncated SSH string');
      const size = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0); offset += 4;
      if (offset + size > bytes.length) throw new Error('Invalid SSH length');
      const value = bytes.slice(offset, offset + size); offset += size; return value;
    };
    const ascii = (value: Uint8Array) => String.fromCharCode(...value);
    if (ascii(read()) !== type) return undefined;
    if (type === 'ssh-ed25519') {
      const key = read(); if (key.length !== 32 || !key.some(value => value !== 0)) return undefined;
    } else if (type === 'ssh-rsa') {
      const exponent = read(), modulus = read();
      if (!exponent.length || exponent.length > 8 || (exponent[0]! & 128) || !(exponent.at(-1)! & 1) || !modulus.length || (modulus[0]! & 128)) return undefined;
      if (exponent.reduce((value, byte) => (value << 8n) + BigInt(byte), 0n) < 3n) return undefined;
      const unsigned = modulus[0] === 0 ? modulus.slice(1) : modulus;
      if (!unsigned.length || !unsigned[0] || !(unsigned.at(-1)! & 1)) return undefined;
      const bits = (unsigned.length - 1) * 8 + 32 - Math.clz32(unsigned[0]!);
      if (![2048, 3072, 4096].includes(bits)) return undefined;
    } else {
      const curve = type.substring('ecdsa-sha2-'.length), declared = ascii(read()), point = read();
      const length = { nistp256: 65, nistp384: 97, nistp521: 133 }[curve];
      if (declared !== curve || point.length !== length || point[0] !== 4) return undefined;
    }
    return offset === bytes.length ? type + ' ' + btoa(String.fromCharCode(...bytes)) : undefined;
  } catch { return undefined; }
}
