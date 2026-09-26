/**
 * The hidden-coupling collectors (addendum A.2.9): `coupling-windows.ps1`,
 * `coupling-linux.sh` and the play that runs them, `discover-coupling.yml`.
 * They write `archtoolkit.coupling` v1 files (read by `import.ts`) with every
 * secret masked in the guest. Static text, zipped reproducibly.
 */

import { zip } from '../../../kit/archive.js';
import { COUPLING_SCRIPTS } from './collector-scripts.js';

export const COUPLING_COLLECTOR_FILES = Object.freeze(['coupling-linux.sh', 'coupling-windows.ps1', 'discover-coupling.yml']         );
                                                                              

export function renderCouplingCollector(file                       )         {
  const text = COUPLING_SCRIPTS[file];
  if (text === undefined) throw new Error(`missing coupling collector ${file}`);
  return text;
}

const README = `# Coupling collectors

Each script writes one \`archtoolkit.coupling\` v1 JSON file per server: what ties it to other servers
by address or name (hosts file, configuration literals and connection strings, scheduled jobs,
service accounts, mounted shares, printers, SMTP relays, SNMP targets, certificate bindings, licence
bindings and the time source). Import the files on the application's Coupling tab.

Secrets are never copied: any value of a key or connection-string part named like password, pwd,
secret, key or token is written as \`***\` in the guest, and masked again on import.

\`\`\`
ansible-playbook -i inventory discover-coupling.yml -e '{"atk_domains": ["corp.example"]}'
\`\`\`

The files land in \`reports/coupling/<host>.json\`. To run one by hand:

- Linux (as root): \`./coupling-linux.sh --domains corp.example --out app01-coupling.json\`
- Windows (elevated): \`.\\coupling-windows.ps1 -Domains corp.example -OutFile app01-coupling.json\`
`;

/** Path → text: the two collectors, the play and a README. */
export function couplingFiles()                         {
  const files                         = {};
  for (const f of COUPLING_COLLECTOR_FILES) files[f] = renderCouplingCollector(f);
  files['README.md'] = README;
  return files;
}

/** The coupling collectors as one reproducible zip (under `coupling/`). */
export async function couplingBundle()                      {
  return zip(Object.fromEntries(Object.entries(couplingFiles()).map(([p, c]) => [`coupling/${p}`, c])), new Date(1980, 0, 1));
}
