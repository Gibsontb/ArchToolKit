/** Ephemeral public test keys only. No private key is exported, logged or retained. */
import { generateKeyPairSync } from 'node:crypto';
const field = value => { const data = Buffer.isBuffer(value) ? value : Buffer.from(value), size = Buffer.alloc(4); size.writeUInt32BE(data.length); return Buffer.concat([size, data]); };
const integer = value => { const data = Buffer.from(value, 'base64url'); return field(data[0] & 128 ? Buffer.concat([Buffer.from([0]), data]) : data); };
export function publicTestKey(type = 'ed25519', bits = 2048) {
  if (type === 'ed25519') {
    const key = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' });
    return 'ssh-ed25519 ' + Buffer.concat([field('ssh-ed25519'), field(Buffer.from(key.x, 'base64url'))]).toString('base64');
  }
  if (type === 'rsa') {
    const key = generateKeyPairSync('rsa', { modulusLength: bits }).publicKey.export({ format: 'jwk' });
    return 'ssh-rsa ' + Buffer.concat([field('ssh-rsa'), integer(key.e), integer(key.n)]).toString('base64');
  }
  const curve = { nistp256: 'prime256v1', nistp384: 'secp384r1', nistp521: 'secp521r1' }[type];
  if (!curve) throw new Error('Unsupported test-key type');
  const key = generateKeyPairSync('ec', { namedCurve: curve }).publicKey.export({ format: 'jwk' }), name = 'ecdsa-sha2-' + type;
  return name + ' ' + Buffer.concat([field(name), field(type), field(Buffer.concat([Buffer.from([4]), Buffer.from(key.x, 'base64url'), Buffer.from(key.y, 'base64url')]))]).toString('base64');
}
