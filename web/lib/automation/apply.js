/**
 * The apply script every platform gets.
 *
 * Each target takes a payload over REST and each one authenticates differently.
 * The script around the call is the same everywhere, and that sameness is the
 * point: the token comes from the environment, the first run only says what it
 * sends, and `--dry-run` prints what it would send without changing anything.
 *
 * Nothing here is idempotent. A POST that half-worked and is run again makes a
 * second object, so the script says to check the id it returned rather than to
 * run it again when unsure.
 */

                                                                                                                     

                      
                        
                         
                               
                           
                          
                         
                                                                   
                   
                          
                          
                          
                               
                                
                                                                                
                              
                                                                                
                            
                                                                              
                                
                                                                                
                                                                                 
    
 

const AUTH                                            = {
  'vcf-operations': {
    host: 'VCFOPS_HOST',
    token: 'VCFOPS_TOKEN',
    hostExample: 'vcfops.example.com',
    acquire: 'POST /suite-api/api/auth/token/acquire',
    header: 'Authorization: OpsToken ${VCFOPS_TOKEN}',
    label: 'VCF Operations',
    login: { path: '/suite-api/api/auth/token/acquire', body: '{username: $u, password: $p}', pick: '.token', secretVar: 'VCFOPS_PASSWORD_FILE', secretHint: 'a file holding the password of VCFOPS_USER, mode 600' },
  },
  'vcf-operations-logs': {
    host: 'VCFLOGS_HOST',
    token: 'VCFLOGS_TOKEN',
    hostExample: 'vcflogs.example.com:9543',
    acquire: 'POST /api/v2/sessions — the standalone 8.18 / 9.0 appliance only; 9.1 log management has no /api/v2',
    header: 'Authorization: Bearer ${VCFLOGS_TOKEN}',
    // Only the move to 9.1 still talks to the standalone appliance, to export
    // what it had. Everything on 9.1 log management goes through VCF Operations.
    label: 'VCF Operations for Logs (standalone 8.18 / 9.0)',
    login: { path: '/api/v2/sessions', body: '{username: $u, password: $p, provider: "Local"}', pick: '.sessionId', secretVar: 'VCFLOGS_PASSWORD_FILE', secretHint: 'a file holding the password of VCFLOGS_USER, mode 600' },
  },
  'vcf-automation': {
    host: 'VCFA_HOST',
    token: 'VCFA_TOKEN',
    hostExample: 'vcfa.example.com',
    acquire: 'POST /oauth/tenant/<org>/token, exchanging an organization API token',
    header: 'Authorization: Bearer ${VCFA_TOKEN}',
    label: 'VCF Automation',
    // VCF Automation 9: an API token made under My Account → API Tokens,
    // exchanged per organization for a bearer token that lasts about an hour.
    login: {
      path: '/oauth/tenant/${VCFA_ORG}/token',
      body: 'grant_type=refresh_token',
      pick: '.access_token',
      secretVar: 'VCFA_API_TOKEN_FILE',
      secretHint: 'a file holding an organization API token (My Account → API Tokens), mode 600',
      form: true,
      formField: 'refresh_token',
      needs: [{ name: 'VCFA_ORG', hint: 'the organization name, as it appears in its login URL' }],
    },
  },
  // VCF 9.1: the fleet-wide APIs in VCF Operations (fleet management, tags,
  // certificates, passwords, lifecycle) take a Bearer token from the VCF
  // Identity Broker, exchanged for an API token issued to an API client in
  // VCF Operations. The access token lasts about half an hour.
  'vcf-fleet': {
    host: 'VCFOPS_HOST',
    token: 'VCF_ACCESS_TOKEN',
    hostExample: 'vcfops.example.com',
    acquire: 'POST https://<identity broker>/acs/t/CUSTOMER/token, exchanging an API token',
    header: 'Authorization: Bearer ${VCF_ACCESS_TOKEN}',
    label: 'VCF Operations fleet management',
    login: {
      path: '/acs/t/CUSTOMER/token',
      body: 'grant_type=urn:custom:vcf:params:oauth:grant-type:api-token',
      pick: '.access_token',
      secretVar: 'VCF_API_TOKEN_FILE',
      secretHint: 'a file holding an API token issued to an API client in VCF Operations, mode 600',
      hostVar: 'VCF_IDB_HOST',
      form: true,
    },
  },
  'sddc-manager': {
    host: 'SDDC_HOST',
    token: 'SDDC_TOKEN',
    hostExample: 'sddc-manager.example.com',
    acquire: 'POST /v1/tokens',
    header: 'Authorization: Bearer ${SDDC_TOKEN}',
    label: 'SDDC Manager',
    login: { path: '/v1/tokens', body: '{username: $u, password: $p}', pick: '.accessToken', secretVar: 'SDDC_PASSWORD_FILE', secretHint: 'a file holding the password of SDDC_USER, mode 600' },
  },
};

                            
                                            
                        
                                            
                           
                                                                   
                                
 

/**
 * The environment lines every script opens with.
 *
 * A token can be handed in directly, which suits a person at a terminal. A
 * scheduled job cannot do that — tokens expire within hours — so when no token
 * is set and a secret file is, the script logs in for itself. The secret is
 * read from a file only its owner can read and sent on stdin, so it never
 * appears in a crontab, a process list or the shell history.
 */
export function authPreamble(target             )           {
  const auth = AUTH[target];
  const login = auth.login;
  const user = auth.token.replace(/_TOKEN$/, '_USER');
  const needsUser = login.body.includes('$u');
  const loginHost = login.hostVar ?? auth.host;
  const exchange = login.form
    ? [
        // The API token goes in the form body on stdin, never on the command line.
        `  ${auth.token}=$( { printf '%s&${login.formField ?? 'api_token'}=' '${login.body}'; jq -jn --rawfile p "$${login.secretVar}" '$p | rtrimstr("\\n") | @uri'; } |`,
        `    curl -sS -f -X POST "https://\${${loginHost}}${login.path}" -H "Accept: application/json" -H "Content-Type: application/x-www-form-urlencoded" --data-binary @- | jq -r '${login.pick}')`,
      ]
    : [
        `  ${auth.token}=$(jq -n ${needsUser ? `--arg u "$${user}" ` : ''}--rawfile p "$${login.secretVar}" '($p | rtrimstr("\\n")) as $p | ${login.body}' |`,
        `    curl -sS -f -X POST "https://\${${loginHost}}${login.path}" -H "Accept: application/json" -H "Content-Type: application/json" --data @- | jq -r '${login.pick}')`,
      ];
  return [
    `if [[ -z "\${${auth.token}:-}" && -n "\${${login.secretVar}:-}" ]]; then`,
    `  : "\${${loginHost}:?set ${loginHost}${login.hostVar ? ' to the VCF Identity Broker host (often the management vCenter)' : `, e.g. ${auth.hostExample}`}}"`,
    ...(needsUser ? [`  : "\${${user}:?set ${user} to the service account that ${login.secretVar} belongs to}"`] : []),
    ...(login.needs ?? []).map((need) => `  : "\${${need.name}:?set ${need.name} to ${need.hint}}"`),
    '  command -v jq >/dev/null || { echo "jq is required to log in" >&2; exit 2; }',
    ...exchange,
    'fi',
    `: "\${${auth.host}:?set ${auth.host}, e.g. ${auth.hostExample}}"`,
    `: "\${${auth.token}:?set ${auth.token} (${auth.acquire}), or set ${login.secretVar} to ${login.secretHint}}"`,
    ...headerFileLines(target),
  ];
}

/** The environment a scheduled job needs, for a crontab line: no secret in it. */
export function scheduledEnv(target             , account = 'svc-automation')         {
  const auth = AUTH[target];
  const user = auth.token.replace(/_TOKEN$/, '_USER');
  const needsUser = auth.login.body.includes('$u');
  const name = auth.login.secretVar.toLowerCase().replace(/_file$/, '').replace(/_/g, '-');
  const idb = auth.login.hostVar ? ` ${auth.login.hostVar}=vcenter-mgmt.example.com` : '';
  return `${auth.host}=${auth.hostExample.split(':')[0]}${idb}${needsUser ? ` ${user}=${account}` : ''} ${auth.login.secretVar}=/etc/vcf-automation/${name}`;
}

/**
 * The header an authenticated call carries, for scripts that build their own:
 * a reference to the private header file authPreamble writes, used as
 * `-H "${authHeader(target)}"`, so the token itself is never an argument. Only
 * valid in a script that has run authPreamble for the same target.
 */
export function authHeader(target             )         {
  return `@\${${headerVar(target)}}`;
}

/**
 * The token goes to curl as `-H @file`, from a file only this user can read,
 * rather than as an argument: an argument is visible to every user on the host
 * through ps and /proc for as long as the call runs. The file is removed when
 * the script exits. Needs curl 7.55 or later.
 */
function headerFileLines(target             )           {
  const auth = AUTH[target];
  const name = headerVar(target);
  return [
    `${name}="$(umask 077; mktemp "\${TMPDIR:-/tmp}/auth.XXXXXX")"`,
    `trap 'rm -f "$${name}"' EXIT`,
    `printf '%s\\n' "${auth.header}" > "$${name}"`,
  ];
}

function headerVar(target             )         {
  return `AUTH_HDR_${target.replace(/[^a-z]/gi, '_').toUpperCase()}`;
}

export function hostVar(target             )         {
  return AUTH[target].host;
}

/**
 * A script that sends one or more payloads. `--dry-run` only prints them.
 *
 * Calls run in order and the script stops at the first that fails, because
 * the later ones usually refer to what the earlier ones created.
 */
export function applyScript(target             , calls                      , undo        )         {
  const auth = AUTH[target];
  const lines = [
    '#!/usr/bin/env bash',
    `# Apply the payloads beside this script to ${auth.label}.`,
    '#',
    '# The token is read from the environment; nothing here writes a credential to',
    '# disk. With --dry-run it only prints what it would send.',
    '#',
    '# Not idempotent. If a run fails part way, check what was created before',
    '# running it again, or you will have two of something.',
    'set -euo pipefail',
    '',
    ...authPreamble(target),
    '',
    'DRY_RUN=0',
    '[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1',
    '',
    'send() {',
    '  local method="$1" path="$2" file="$3" type="$4"',
    '  if (( DRY_RUN )); then',
    `    echo "DRY RUN: would \${method} \${file} to https://\${${auth.host}}\${path}"`,
    '    return 0',
    '  fi',
    `  echo "\${method} \${path}"`,
    '  curl -sS -f \\',
    `    -X "\${method}" "https://\${${auth.host}}\${path}" \\`,
    `    -H "${authHeader(target)}" \\`,
    '    -H "Accept: application/json" \\',
    '    -H "Content-Type: ${type}" \\',
    '    --data @"${file}"',
    '  echo',
    '}',
    '',
    ...calls.map((call) => `send ${call.method} '${call.path}' '${call.payload}' '${call.contentType ?? 'application/json'}'`),
    '',
    'if (( DRY_RUN )); then',
    '  echo "Dry run: nothing was changed. Run it without --dry-run to apply."',
    'fi',
    '',
    `# Undo: ${undo}`,
    '',
  ];
  return lines.join('\n');
}

/**
 * A read-only script: runs GETs, prints what it found, and exits non-zero when a
 * check fails so a scheduler can alert on the exit code.
 */
export function readScript(target             , purpose        , body                   )         {
  return [
    '#!/usr/bin/env bash',
    `# ${purpose}`,
    '#',
    '# Reads only. Exits 1 when something needs attention, so whatever runs it on',
    '# a schedule can alert on the exit code rather than on reading the output.',
    'set -euo pipefail',
    '',
    ...authPreamble(target),
    '',
    'get() {',
    `  curl -sS -f "https://\${${AUTH[target].host}}$1" -H "${authHeader(target)}" -H "Accept: application/json"`,
    '}',
    '',
    'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
    '',
    ...body,
    '',
  ].join('\n');
}
