/**
 * Config helpers: mask the secrets in a device or application config before
 * it is pasted into a ticket or a chat, and decode Cisco type 7 passwords.
 *
 * Masking keeps the shape of each line — the keyword, the encryption type
 * digit, the rest of the command — and replaces only the value, so the masked
 * config still reads as the original and still diffs cleanly against another
 * masked copy. It is a best effort over the common forms, not a guarantee:
 * the new tab says so, and the count says how much it found.
 *
 * Type 7 is a reversible obfuscation (a fixed XOR key published for decades),
 * not encryption. Decoding it is how people recover a lost line password from
 * their own backup; it is also why `secret` should be used instead.
 */

export const MASK = '<masked>';

                
                      
                                                                                
                         
 

// Each rule captures the secret in one group and the text before it in the
// groups before, so the replacement can rebuild the line around it.
const LINE_RULES                  = [
  // key = value / key: value / "key": "value" — ini, Splunk .conf, YAML, JSON, env files.
  {
    // A prefix is allowed (db_password, SPLUNK_PASSWORD, admin.token); the name must end at the separator.
    re: /(["']?\b[\w.-]*?(?:pass4SymmKey|sslPassword|sslKeysfilePassword|sslPrivateKeyPassword|bindDNpassword|password|passwd|pwd|secret|client[_-]?secret|secret[_-]?key|api[_-]?key|apikey|access[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|token|private[_-]?key|passphrase|community)["']?[ \t]*[:=][ \t]*)("(?:[^"\\]|\\.)*"|'[^']*'|\{\{[^}]*\}\}|\$\{[^}]*\}|[^\s,;#]+)/gi,
    group: 2,
  },
  // Cisco / Junos: password [type] value, secret [type] value, encrypted-password "..."
  {
    re: /(\b(?:password|secret|encrypted-password)[ \t]+)(?!encryption\b|[:=])((?:[0-9][ \t]+)?)("[^"]*"|\S+)/gi,
    group: 3,
  },
  // NTP first, so the general authentication-key rule below does not take "md5" as the key.
  { re: /(\bntp[ \t]+authentication-key[ \t]+\d+[ \t]+md5[ \t]+)(\S+)/gi, group: 2 },
  { re: /(\bauthentication-key[ \t]+)(?!\d+[ \t]+md5\b)((?:[07][ \t]+)?)("[^"]*"|\S+)/gi, group: 3 },
  // OSPF message-digest keys, SNMPv3 auth md5/sha.
  { re: /(\b(?:auth[ \t]+(?:md5|sha[-\d]*)|message-digest-key[ \t]+\d+[ \t]+md5)[ \t]+)((?:[07][ \t]+)?)(\S+)/gi, group: 3 },
  // SNMPv3 privacy passwords: "priv aes 128 PASS", "priv des PASS", NX-OS "priv 0xabc…".
  { re: /(\bpriv[ \t]+(?:(?:3?des|aes)(?:-?\d+)?[ \t]+(?:\d+[ \t]+)?)?)(?!(?:read|write|notify|access|context|match)\b)(\S+)/gi, group: 2 },
  // key-string, pre-shared-key, Junos ascii-text / hexadecimal.
  { re: /(\b(?:key-string|pre-shared-key|ascii-text|hexadecimal)[ \t]+)((?:[0-9][ \t]+)?)("[^"]*"|\S+)/gi, group: 3 },
  // tacacs-server / radius-server ... key [7] value, crypto isakmp key value.
  { re: /(^[ \t]*(?:tacacs-server|radius-server|crypto[ \t]+isakmp)\b.*?\bkey[ \t]+)((?:[0-9][ \t]+)?)(\S+)/gim, group: 3 },
  // "key 7 xxx" / "key 0 xxx" inside a tacacs/radius server block. A bare "key 1" (a key chain entry) is left alone.
  { re: /(^[ \t]+key[ \t]+)([0-9][ \t]+)(\S+)/gim, group: 3 },
  // SNMP communities.
  { re: /(\bsnmp-server[ \t]+community[ \t]+)(\S+)/gi, group: 2 },
  { re: /(\bsnmp-server[ \t]+host[ \t]+\S+[ \t]+(?:(?:informs|traps)[ \t]+)?(?:version[ \t]+(?:1|2c)[ \t]+)?)(?!version\b|informs\b|traps\b)(\S+)/gi, group: 2 },
  { re: /(\bset[ \t]+snmp[ \t]+community[ \t]+)(\S+)/gi, group: 2 },
  // HTTP authorization headers and tokens pasted into scripts.
  { re: /(\bBearer[ \t]+)([A-Za-z0-9\-._~+/]+=*)/g, group: 2 },
  { re: /(\bAuthorization:[ \t]*Basic[ \t]+)([A-Za-z0-9+/]+=*)/gi, group: 2 },
  // Credentials inside URLs: scheme://user:password@host
  { re: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi, group: 2 },
];

const PEM = /(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----)/g;

                             
                        
                         
                                                 
                                    
 

export function maskSecrets(text        )             {
  let count = 0;
  const touched = new Set        ();
  const withoutKeys = text.replace(PEM, (_, begin        , end        ) => {
    count += 1;
    return `${begin}\n${MASK}\n${end}`;
  });
  const lines = withoutKeys.split('\n').map((line, i) => {
    let out = line;
    for (const { re, group } of LINE_RULES) {
      out = out.replace(re, (...args           ) => {
        const groups = args.slice(1, -2)                          ;
        const secret = groups[group - 1] ?? '';
        const quoted = /^(["']).*\1$/s.test(secret) && secret.length >= 2;
        const bare = quoted ? secret.slice(1, -1) : secret;
        // Already masked, or a placeholder rather than a value.
        if (!bare || bare === MASK || /^(\*+|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|%[^%]+%|[|>][-+]?)$/.test(bare)) return args[0]          ;
        count += 1;
        touched.add(i + 1);
        const replacement = quoted ? `${secret[0]}${MASK}${secret[0]}` : MASK;
        return groups.map((g, j) => (j === group - 1 ? replacement : (g ?? ''))).join('');
      });
    }
    return out;
  });
  return { text: lines.join('\n'), count, lines: [...touched].sort((a, b) => a - b) };
}

// --- Cisco type 7 ------------------------------------------------------------------

const XLAT = 'dsfd;kfoA,.iyewrkldJKDHSUBsgvca69834ncxv9873254k;fg87';

/** Decode a type 7 string: two decimal digits of key offset, then hex pairs XORed with the key. */
export function decodeType7(encoded        )         {
  const t = encoded.trim();
  if (!/^\d{2}(?:[0-9A-Fa-f]{2})*$/.test(t) || t.length < 4) throw new Error('Not a type 7 string: two decimal digits, then pairs of hex digits.');
  const seed = Number(t.slice(0, 2));
  if (seed > 52) throw new Error('Not a type 7 string: the first two digits must be 00–52.');
  let out = '';
  for (let i = 2; i < t.length; i += 2) {
    const byte = parseInt(t.slice(i, i + 2), 16);
    out += String.fromCharCode(byte ^ XLAT.charCodeAt((seed + (i - 2) / 2) % XLAT.length));
  }
  return out;
}

/** The reverse, for tests and for checking a decode: the same algorithm the device uses. */
export function encodeType7(plain        , seed = 2)         {
  let out = String(seed).padStart(2, '0');
  for (let i = 0; i < plain.length; i += 1) {
    out += (plain.charCodeAt(i) ^ XLAT.charCodeAt((seed + i) % XLAT.length)).toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

                           
                        
                           
                           
                           
 

/** Every "password 7 …" / "key 7 …" / "md5 7 …" in a config, decoded. */
export function findType7(text        )             {
  const hits             = [];
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/\b(password|key|key-string|md5|authentication-key|secret)[ \t]+7[ \t]+([0-9]{2}[0-9A-Fa-f]+)\b/gi)) {
      try {
        hits.push({ line: i + 1, context: line.trim(), encoded: m[2] , decoded: decodeType7(m[2] ) });
      } catch {
        // Not a well-formed type 7 value; nothing to recover.
      }
    }
  });
  return hits;
}
