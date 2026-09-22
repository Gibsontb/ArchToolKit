/**
 * Any JSON or YAML: no answer sets and no checks beyond the ones every file
 * gets (clear-text secrets). The fallback when nothing else recognises a file.
 */

import { isObj, type Profile } from '../profile.ts';

export const generic: Profile = {
  id: 'generic',
  family: 'generic',
  label: 'Plain JSON or YAML',
  format: 'json',
  detect: () => 0.01,
  itemTitle(value) {
    if (!isObj(value)) return undefined;
    for (const key of ['name', 'Name', 'id', 'Id', 'key', 'title', 'hostname', 'Sid']) {
      const v = value[key];
      if (typeof v === 'string' && v) return v;
    }
    return undefined;
  },
};
