/**
 * Hand-written Linux scenario blueprints: several resources built together.
 *
 * Terraform's part in running a Linux estate is the edge of it, and these are
 * the builds an engineer reaches for there:
 *
 *   First boot    cloud-init user-data for a new VM
 *   Keys & PKI    an SSH key pair; an internal CA issuing server certificates
 *   DNS           A/AAAA/CNAME/PTR/TXT/MX/SRV records on BIND over RFC 2136
 *   Ansible       an inventory and a playbook run against it
 *   Over SSH      bootstrap commands; a service account with sshd hardening;
 *                 packages, services and firewall; an Active Directory join;
 *                 a config file with validate-and-restart; an NFS mount
 *   Naming        hostnames from a naming convention
 *
 * Everything run over SSH is a `terraform_data` with provisioners (Terraform
 * 1.4+ has it built in, so no null provider is needed for it), starts with
 * `set -o errexit`, uses the chosen distribution family's package manager,
 * firewall and service names, and is written to be safe to run twice. Secrets
 * are sensitive variables or generated values, never text in the file.
 */

                                                                        
import { error, warning,              } from '../../core/findings.js';
import { scenario, q, items, pairs, on, n } from './scenario-common.js';
import { render, resource, data, output,                     } from './hcl-builder.js';

const GROUP = 'Linux · Scenarios (several resources together)';
const SSH_SECTION = 'SSH connection';

// --- HCL helpers -------------------------------------------------------------

/** A bare object key where HCL allows one, quoted otherwise. */
function hkey(key        )         {
  return /^[A-Za-z_][\w-]*$/.test(key) ? key : q(key);
}

/** `[...]` of HCL expressions, one per line, indented for a value at `ind`. */
function mlist(exprs                   , ind        )         {
  if (exprs.length === 0) return '[]';
  return `[\n${exprs.map((e) => `${ind}  ${e},`).join('\n')}\n${ind}]`;
}

/** `{ key = expr }` over several lines, keys aligned, for a value at `ind`. */
function hmap(entries                                        , ind        )         {
  if (entries.length === 0) return '{}';
  const width = Math.max(...entries.map(([k]) => hkey(k).length));
  return `{\n${entries.map(([k, v]) => `${ind}  ${hkey(k).padEnd(width)} = ${v}`).join('\n')}\n${ind}}`;
}

/** `["a", "b"]` of quoted strings on one line. */
function slist(values                   )         {
  return `[${values.map(q).join(', ')}]`;
}

function locals(body                 )         {
  return `locals {\n${render(body, '  ')}\n}`;
}

function variable(name        , description        , opts                                            = {})         {
  const body         = [
    ['description', q(description)],
    ['type', 'string'],
    opts.default !== undefined && ['default', q(opts.default)],
    opts.sensitive && ['sensitive', 'true'],
  ];
  return `variable "${name}" {\n${render(body, '  ')}\n}`;
}

function sensitiveOutput(name        , value        , description        )         {
  return `output "${name}" {\n${render([['description', q(description)], ['value', value], ['sensitive', 'true']], '  ')}\n}`;
}

/** A shell word in single quotes. */
function sq(value        )         {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Lines of a textarea, trimmed, blanks and # comments dropped. */
function lines(value         )           {
  return String(value ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

/** A quoted HCL string that ends in a newline, as a file's content should (q() trims). */
function qFile(text        )         {
  return `${q(text).slice(0, -1)}\\n"`;
}

function fqdn(name        )         {
  return name.endsWith('.') ? name : `${name}.`;
}

// --- distribution families ---------------------------------------------------

                                         

const DISTRO_INPUT                 = {
  id: 'distro',
  label: 'Distribution family',
  control: 'select',
  options: [
    { value: 'rhel', label: 'RHEL / Rocky / Alma / Oracle Linux (dnf, firewalld)' },
    { value: 'debian', label: 'Debian / Ubuntu (apt, ufw)' },
    { value: 'suse', label: 'SLES / openSUSE (zypper, firewalld)' },
  ],
  default: 'rhel',
};

function distroOf(v                         )         {
  const d = String(v.distro ?? 'rhel');
  return d === 'debian' || d === 'suse' ? d : 'rhel';
}

const PKG                                                                                                                        = {
  rhel: {
    refresh: 'sudo dnf -y makecache',
    upgrade: 'sudo dnf -y upgrade',
    install: (p) => `sudo dnf -y install ${p.join(' ')}`,
    // needs-restarting comes with dnf-plugins-core; exit 1 means a reboot is due.
    rebootIfRequired: ['sudo dnf -y install dnf-plugins-core', 'if ! sudo dnf needs-restarting -r >/dev/null; then sudo shutdown -r +1 "Terraform: reboot required"; fi'],
  },
  debian: {
    refresh: 'sudo apt-get update -q',
    upgrade: 'sudo DEBIAN_FRONTEND=noninteractive apt-get -y -q -o Dpkg::Options::=--force-confold dist-upgrade',
    install: (p) => `sudo DEBIAN_FRONTEND=noninteractive apt-get -y -q install ${p.join(' ')}`,
    rebootIfRequired: ['if [ -f /var/run/reboot-required ]; then sudo shutdown -r +1 "Terraform: reboot required"; fi'],
  },
  suse: {
    refresh: 'sudo zypper --non-interactive refresh',
    upgrade: 'sudo zypper --non-interactive update',
    install: (p) => `sudo zypper --non-interactive install ${p.join(' ')}`,
    // Exit 102 means a reboot is due, 0 that none is.
    rebootIfRequired: ['if ! sudo zypper needs-rebooting >/dev/null; then sudo shutdown -r +1 "Terraform: reboot required"; fi'],
  },
};

/** The SSH daemon's systemd unit. */
const SSHD_UNIT                         = { rhel: 'sshd', debian: 'ssh', suse: 'sshd' };

/** Commands that open ports ("443/tcp") or named services ("https") and turn the firewall on. */
function firewallCommands(distro        , openings          , sshPort        )           {
  if (distro === 'debian') {
    return [
      PKG.debian.install(['ufw']),
      // SSH first, so enabling ufw cannot cut off this session.
      `sudo ufw allow ${sshPort}/tcp`,
      ...openings.map((o) => `sudo ufw allow ${o}`),
      'sudo ufw --force enable',
    ];
  }
  return [
    PKG[distro].install(['firewalld']),
    'sudo systemctl enable --now firewalld',
    ...openings.map((o) => (o.includes('/') ? `sudo firewall-cmd --permanent --add-port=${o}` : `sudo firewall-cmd --permanent --add-service=${o}`)),
    'sudo firewall-cmd --reload',
  ];
}

/** Wait for first-boot cloud-init to finish, where there is one, so package locks are free. */
const WAIT_FOR_CLOUD_INIT = 'if command -v cloud-init >/dev/null 2>&1; then sudo cloud-init status --wait >/dev/null || true; fi';

// --- SSH connection ----------------------------------------------------------

function sshInputs(defaults                                    = {})                   {
  return [
    { id: 'hosts', label: 'Target hosts', control: 'textarea', default: defaults.hosts ?? '10.0.0.21\n10.0.0.22', hint: 'IP address or DNS name, one per line' },
    { id: 'ssh_user', label: 'SSH user', control: 'text', default: defaults.user ?? 'ansible', hint: 'with passwordless sudo' },
    { id: 'ssh_private_key_path', label: 'SSH private key', control: 'text', default: '~/.ssh/id_ed25519', hint: 'path on the Terraform runner', section: SSH_SECTION },
    { id: 'ssh_port', label: 'SSH port', control: 'number', default: 22, min: 1, max: 65535, section: SSH_SECTION },
    { id: 'use_bastion', label: 'Through a bastion host', control: 'toggle', default: false, section: SSH_SECTION },
    { id: 'bastion_host', label: 'Bastion host', control: 'text', default: 'bastion.example.com', section: SSH_SECTION, showWhen: { input: 'use_bastion', equals: ['true'] } },
    { id: 'bastion_user', label: 'Bastion user', control: 'text', default: 'jump', section: SSH_SECTION, showWhen: { input: 'use_bastion', equals: ['true'] }, hint: 'same private key' },
  ];
}

function hostsOf(v                         , findings           )           {
  const hosts = [...new Set(items(v.hosts))];
  if (hosts.length === 0) {
    findings.push(error('linux.ssh.no-hosts', 'Name at least one target host.', { path: 'hosts' }));
    return ['10.0.0.21'];
  }
  return hosts;
}

/** The private key path variable every SSH scenario reads its key through. */
function sshKeyVariable(v                         )         {
  return variable('ssh_private_key_path', 'Private key Terraform connects over SSH with (never stored in the configuration)', {
    default: String(v.ssh_private_key_path ?? '').trim() || '~/.ssh/id_ed25519',
  });
}

/** `connection {}` for a resource that has `for_each` over host names. */
function connection(v                         )      {
  const bastion = on(v.use_bastion);
  return {
    b: 'connection',
    body: [
      ['type', '"ssh"'],
      ['host', 'each.key'],
      ['port', String(n(v.ssh_port, 22))],
      ['user', q(v.ssh_user || 'ansible')],
      ['private_key', 'file(pathexpand(var.ssh_private_key_path))'],
      ['timeout', '"5m"'],
      bastion && ['bastion_host', q(v.bastion_host)],
      bastion && ['bastion_user', q(v.bastion_user)],
      bastion && ['bastion_private_key', 'file(pathexpand(var.ssh_private_key_path))'],
    ],
  };
}

/**
 * A `terraform_data` per host that runs `commandsLocal` over SSH, re-run
 * whenever `triggers` changes.
 */
function sshRun(v                         , name        , opts                                                                       )         {
  return resource('terraform_data', name, [
    ['for_each', 'toset(local.hosts)'],
    ['triggers_replace', opts.triggers],
    connection(v),
    ...(opts.before ?? []),
    { b: 'provisioner "remote-exec"', body: [['inline', opts.commandsLocal]] },
  ]);
}

// --- bootstrap over SSH ------------------------------------------------------

const remoteExec = scenario('null', {
  id: 'linux_null_remote_exec',
  label: 'Bootstrap over SSH (remote-exec)',
  group: GROUP,
  description:
    'Runs a list of shell commands on each host over SSH with a terraform_data remote-exec provisioner, optionally uploading a file first and waiting for cloud-init to finish. Editing the commands re-runs them on the next apply.',
  inputs: [
    ...sshInputs({ hosts: '10.0.0.21', user: 'cloud-user' }),
    {
      id: 'commands',
      label: 'Commands',
      control: 'textarea',
      default: 'sudo dnf -y upgrade\nsudo systemctl enable --now chronyd\nsudo hostnamectl set-hostname app01.example.com',
      hint: 'one shell command per line, run in order; stops at the first failure',
    },
    { id: 'wait_cloud_init', label: 'Wait for cloud-init first', control: 'toggle', default: true, hint: 'avoids package-lock races on a new VM' },
    { id: 'upload', label: 'Upload a file first', control: 'toggle', default: false },
    { id: 'upload_source', label: 'Local file', control: 'text', default: 'files/bootstrap.sh', hint: 'path on the Terraform runner', showWhen: { input: 'upload', equals: ['true'] } },
    { id: 'upload_destination', label: 'Remote path', control: 'text', default: '/tmp/bootstrap.sh', hint: 'writable by the SSH user', showWhen: { input: 'upload', equals: ['true'] } },
  ],
  emits: ['terraform_data'],
  body: (v) => {
    const findings            = [];
    const hosts = hostsOf(v, findings);
    const commands = lines(v.commands);
    if (commands.length === 0) findings.push(warning('linux.bootstrap.no-commands', 'No commands given; the provisioner only checks the connection.', { path: 'commands' }));
    const upload = on(v.upload);
    const all = ['set -o errexit', on(v.wait_cloud_init) && WAIT_FOR_CLOUD_INIT, ...commands].filter(Boolean)            ;
    const hcl = [
      sshKeyVariable(v),
      locals([
        ['hosts', slist(hosts)],
        ['bootstrap_commands', mlist(all.map(q), '  ')],
      ]),
      sshRun(v, 'bootstrap', {
        triggers: upload ? `[local.bootstrap_commands, ${q(v.upload_source)}, ${q(v.upload_destination)}]` : 'local.bootstrap_commands',
        commandsLocal: 'local.bootstrap_commands',
        before: upload
          ? [{ b: 'provisioner "file"', body: [['source', q(v.upload_source)], ['destination', q(v.upload_destination)]] }]
          : [],
      }),
      output('bootstrapped_hosts', 'keys(terraform_data.bootstrap)', 'Hosts the commands ran on'),
    ];
    return { hcl: hcl.join('\n\n'), findings };
  },
});

// --- cloud-init user-data ------------------------------------------------------

const TIMEZONES = ['UTC', 'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney'];

const cloudInit = scenario('cloudinit', {
  id: 'linux_cloud_init_user_data',
  label: 'cloud-init user-data for a new VM',
  group: GROUP,
  alsoUses: ['local'],
  description:
    'A cloudinit_config (data source) with a #cloud-config part (hostname, timezone, users with sudo and SSH keys, packages, files, commands, NTP) and an optional shell-script part. Hand the rendered output to vSphere as extra_config guestinfo.userdata with guestinfo.userdata.encoding = "gzip+base64", or to AWS as user_data_base64 (user_data when not encoded).',
  inputs: [
    { id: 'hostname', label: 'Hostname', control: 'text', default: 'app01' },
    { id: 'domain', label: 'DNS domain', control: 'text', default: 'example.com', hint: 'FQDN = hostname.domain' },
    { id: 'timezone', label: 'Time zone', control: 'combo', options: TIMEZONES.map((t) => ({ value: t, label: t })), default: 'UTC' },
    {
      id: 'users',
      label: 'Users',
      control: 'textarea',
      default: 'deploy=ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyReplaceMe deploy@example.com',
      hint: 'name=public SSH key, one per line; a name may repeat for several keys',
    },
    { id: 'sudo', label: 'Users get sudo', control: 'select', options: [{ value: 'nopasswd', label: 'Yes, without a password' }, { value: 'password', label: 'Yes, with their password' }, { value: 'none', label: 'No' }], default: 'nopasswd' },
    { id: 'packages', label: 'Packages', control: 'textarea', default: 'open-vm-tools\nchrony\ncurl', hint: 'one per line' },
    { id: 'package_update', label: 'Refresh package metadata', control: 'toggle', default: true },
    { id: 'package_upgrade', label: 'Upgrade all packages on first boot', control: 'toggle', default: false },
    { id: 'write_files', label: 'Files', control: 'textarea', default: '/etc/motd=Managed by Terraform. Unauthorised access prohibited.', hint: 'path=content, one per line; \\n in content for a new line' },
    { id: 'runcmd', label: 'Commands (runcmd)', control: 'textarea', default: 'systemctl enable --now chronyd', hint: 'one per line, run once as root at the end of first boot' },
    { id: 'ntp_servers', label: 'NTP servers', control: 'text', default: 'ntp1.example.com, ntp2.example.com', hint: 'blank = the image default' },
    { id: 'script_part', label: 'Add a shell-script part', control: 'toggle', default: false },
    {
      id: 'script',
      label: 'Shell script',
      control: 'textarea',
      default: 'echo "first boot at $(date -Is)" >> /var/log/first-boot.log',
      hint: 'bash, one command per line; runs after the #cloud-config part',
      showWhen: { input: 'script_part', equals: ['true'] },
    },
    { id: 'gzip', label: 'Gzip', control: 'toggle', default: true, section: 'Encoding' },
    { id: 'base64_encode', label: 'Base64 encode', control: 'toggle', default: true, section: 'Encoding', showWhen: { input: 'gzip', equals: ['false'] }, hint: 'always on with gzip' },
    { id: 'write_file', label: 'Also write it to a file', control: 'toggle', default: false, section: 'Output' },
    { id: 'output_path', label: 'File path', control: 'text', default: 'out/user-data', section: 'Output', showWhen: { input: 'write_file', equals: ['true'] } },
  ],
  emits: ['local_file'], // cloudinit_config is a data source; the resource is deprecated
  body: (v) => {
    const findings            = [];
    const host = String(v.hostname ?? '').trim() || 'app01';
    const domain = String(v.domain ?? '').trim();
    const fq = domain ? `${host}.${domain}` : host;
    const sudo = String(v.sudo ?? 'nopasswd');
    const ind = '    ';

    // Users: keys grouped by name, in the order the names first appear.
    const keys = new Map                  ();
    for (const [name, key] of pairs(v.users)) {
      if (!key) {
        findings.push(warning('linux.cloudinit.user-no-key', `User "${name}" has no SSH key and a locked password, so cannot log in.`, { path: 'users' }));
      }
      keys.set(name, [...(keys.get(name) ?? []), ...(key ? [key] : [])]);
    }
    const users = [
      '"default"',
      ...[...keys].map(([name, k]) =>
        hmap(
          [
            ['name', q(name)],
            ['shell', '"/bin/bash"'],
            ['lock_passwd', 'true'],
            ...(sudo === 'none' ? [] : [['sudo', q(sudo === 'nopasswd' ? 'ALL=(ALL) NOPASSWD:ALL' : 'ALL=(ALL) ALL')]         ]),
            ['ssh_authorized_keys', slist(k)],
          ],
          `${ind}  `,
        ),
      ),
    ];
    const files = pairs(v.write_files).map(([path, content]) =>
      hmap(
        [
          ['path', q(path)],
          ['content', qFile(content.replace(/\\n/g, '\n'))],
          ['owner', '"root:root"'],
          ['permissions', '"0644"'],
        ],
        `${ind}  `,
      ),
    );
    const packages = lines(v.packages);
    const runcmd = lines(v.runcmd);
    const ntp = items(v.ntp_servers);

    const config                     = [
      ['hostname', q(host)],
      ['fqdn', q(fq)],
      ['prefer_fqdn_over_hostname', 'true'],
      ['manage_etc_hosts', 'true'],
      ['timezone', q(v.timezone || 'UTC')],
      ['ssh_pwauth', 'false'],
      ['disable_root', 'true'],
      ['package_update', String(on(v.package_update))],
      ['package_upgrade', String(on(v.package_upgrade))],
      ['users', mlist(users, ind)],
    ];
    if (packages.length) config.push(['packages', mlist(packages.map(q), ind)]);
    if (files.length) config.push(['write_files', mlist(files, ind)]);
    if (ntp.length) config.push(['ntp', hmap([['enabled', 'true'], ['servers', slist(ntp)]], ind)]);
    if (runcmd.length) config.push(['runcmd', mlist(runcmd.map(q), ind)]);

    const gzip = on(v.gzip);
    // The provider refuses gzip without base64.
    const base64 = gzip || on(v.base64_encode);
    const parts         = [
      ['gzip', String(gzip)],
      ['base64_encode', String(base64)],
      {
        b: 'part',
        body: [
          ['filename', '"cloud-config.yaml"'],
          ['content_type', '"text/cloud-config"'],
          ['content', '"#cloud-config\\n${yamlencode(local.cloud_config)}"'],
        ],
      },
    ];
    if (on(v.script_part)) {
      const script = ['#!/bin/bash', 'set -euo pipefail', ...lines(v.script)].join('\n');
      parts.push({ b: 'part', body: [['filename', '"first-boot.sh"'], ['content_type', '"text/x-shellscript"'], ['content', qFile(script)]] });
    }
    const hcl = [
      `locals {\n  cloud_config = ${hmap(config, '  ')}\n}`,
      data('cloudinit_config', 'user_data', parts),
      on(v.write_file)
        ? resource('local_file', 'user_data', [
            ['filename', q(v.output_path || 'out/user-data')],
            ['content', 'data.cloudinit_config.user_data.rendered'],
            ['file_permission', '"0640"'],
          ])
        : '',
      output('user_data', 'data.cloudinit_config.user_data.rendered', base64 ? 'Rendered user-data, base64 encoded' : 'Rendered user-data'),
    ];
    return { hcl: hcl.filter(Boolean).join('\n\n'), findings };
  },
});

// --- SSH key pair --------------------------------------------------------------

const KEY_ALGORITHMS                         = {
  ed25519: [['algorithm', '"ED25519"']],
  rsa4096: [['algorithm', '"RSA"'], ['rsa_bits', '4096']],
  ecdsa384: [['algorithm', '"ECDSA"'], ['ecdsa_curve', '"P384"']],
};

const sshKeyPair = scenario('tls', {
  id: 'linux_ssh_key_pair',
  label: 'SSH key pair',
  group: GROUP,
  alsoUses: ['local'],
  description:
    'Generates an SSH key pair with tls_private_key, writes the private key (0600) and the .pub file to disk, and outputs the OpenSSH public key and its SHA-256 fingerprint for cloud-init or authorized_keys. The private key is also held in the state, so keep the state encrypted.',
  inputs: [
    { id: 'key_name', label: 'Key name', control: 'text', default: 'deploy_ed25519', hint: 'file name' },
    {
      id: 'algorithm',
      label: 'Algorithm',
      control: 'select',
      options: [
        { value: 'ed25519', label: 'Ed25519 (recommended)' },
        { value: 'rsa4096', label: 'RSA 4096' },
        { value: 'ecdsa384', label: 'ECDSA P-384' },
      ],
      default: 'ed25519',
    },
    { id: 'key_dir', label: 'Directory', control: 'text', default: 'keys', hint: 'on the Terraform runner, relative to the working directory' },
  ],
  emits: ['tls_private_key', 'local_sensitive_file', 'local_file'],
  body: (v) => {
    const alg = KEY_ALGORITHMS[String(v.algorithm)] ?? KEY_ALGORITHMS.ed25519 ;
    const path = `${String(v.key_dir ?? 'keys').trim().replace(/\/+$/, '') || 'keys'}/${String(v.key_name ?? '').trim() || 'deploy_ed25519'}`;
    return [
      resource('tls_private_key', 'ssh', alg),
      resource('local_sensitive_file', 'private_key', [
        ['filename', q(path)],
        ['content', 'tls_private_key.ssh.private_key_openssh'],
        ['file_permission', '"0600"'],
        ['directory_permission', '"0700"'],
      ]),
      resource('local_file', 'public_key', [
        ['filename', q(`${path}.pub`)],
        ['content', 'tls_private_key.ssh.public_key_openssh'],
        ['file_permission', '"0644"'],
      ]),
      output('public_key_openssh', 'trimspace(tls_private_key.ssh.public_key_openssh)', 'Public key, for authorized_keys or cloud-init'),
      output('public_key_fingerprint', 'tls_private_key.ssh.public_key_fingerprint_sha256', 'SHA-256 fingerprint of the public key'),
      output('private_key_path', 'local_sensitive_file.private_key.filename', 'Where the private key was written'),
    ].join('\n\n');
  },
});

// --- internal CA and server certificates ------------------------------------

const CERT_KEYS                         = {
  ecdsa_p384: [['algorithm', '"ECDSA"'], ['ecdsa_curve', '"P384"']],
  ecdsa_p256: [['algorithm', '"ECDSA"'], ['ecdsa_curve', '"P256"']],
  rsa_4096: [['algorithm', '"RSA"'], ['rsa_bits', '4096']],
  rsa_2048: [['algorithm', '"RSA"'], ['rsa_bits', '2048']],
};

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const isIp = (s        )          => IPV4.test(s) || (s.includes(':') && /^[0-9a-f:.]+$/i.test(s));

const internalCa = scenario('tls', {
  id: 'linux_internal_ca_certs',
  label: 'Internal CA + server certificates',
  group: GROUP,
  alsoUses: ['local'],
  description:
    'A private root CA (self-signed, cert_sign and crl_sign) that issues a certificate per server with DNS and IP subject alternative names, for server and optionally client authentication; writes the CA certificate, each full chain and each key as PEM files. Keys live in the state too — for lab and internal services, not a replacement for an enterprise PKI.',
  inputs: [
    { id: 'ca_common_name', label: 'CA name', control: 'text', default: 'Example Internal Root CA' },
    { id: 'organization', label: 'Organization', control: 'text', default: 'Example Ltd' },
    {
      id: 'servers',
      label: 'Servers',
      control: 'textarea',
      default: 'web01.example.com=www.example.com, 10.0.0.21\napi01.example.com=api.example.com, 10.0.0.22',
      hint: 'common name=extra DNS names and IPs, comma separated; one server per line',
    },
    {
      id: 'key_algorithm',
      label: 'Key algorithm',
      control: 'select',
      options: [
        { value: 'ecdsa_p384', label: 'ECDSA P-384' },
        { value: 'ecdsa_p256', label: 'ECDSA P-256' },
        { value: 'rsa_4096', label: 'RSA 4096' },
        { value: 'rsa_2048', label: 'RSA 2048' },
      ],
      default: 'ecdsa_p384',
    },
    { id: 'client_auth', label: 'Also valid for client authentication', control: 'toggle', default: false, hint: 'mutual TLS' },
    { id: 'ca_validity_years', label: 'CA validity', control: 'number', default: 10, min: 1, max: 30, hint: 'years', section: 'Validity' },
    { id: 'cert_validity_days', label: 'Server certificate validity', control: 'number', default: 397, min: 1, max: 3650, hint: 'days', section: 'Validity' },
    { id: 'renew_days', label: 'Renew before expiry', control: 'number', default: 30, min: 0, hint: 'days; re-issued on the next apply inside this window', section: 'Validity' },
    { id: 'write_files', label: 'Write PEM files', control: 'toggle', default: true, section: 'Output' },
    { id: 'pki_dir', label: 'Directory', control: 'text', default: 'pki', section: 'Output', showWhen: { input: 'write_files', equals: ['true'] } },
    { id: 'write_ca_key', label: 'Also write the CA private key', control: 'toggle', default: false, section: 'Output', showWhen: { input: 'write_files', equals: ['true'] } },
  ],
  emits: ['tls_private_key', 'tls_self_signed_cert', 'tls_cert_request', 'tls_locally_signed_cert', 'local_file', 'local_sensitive_file'],
  body: (v) => {
    const findings            = [];
    const keyAlg = CERT_KEYS[String(v.key_algorithm)] ?? CERT_KEYS.ecdsa_p384 ;
    const servers = pairs(v.servers);
    if (servers.length === 0) {
      findings.push(error('linux.pki.no-servers', 'Name at least one server to issue a certificate for.', { path: 'servers' }));
      servers.push(['app01.example.com', '']);
    }
    const entries = servers.map(([cn, rest])                   => {
      const sans = items(rest.replace(/\s+/g, ','));
      const dns = [cn, ...sans.filter((s) => !isIp(s))];
      const ips = sans.filter(isIp);
      return [cn, hmap([['dns_names', slist([...new Set(dns)])], ['ip_addresses', slist(ips)]], '    ')];
    });
    const org = String(v.organization ?? '').trim();
    const uses = ['digital_signature', 'key_encipherment', 'server_auth', ...(on(v.client_auth) ? ['client_auth'] : [])];
    const dir = String(v.pki_dir ?? 'pki').trim().replace(/\/+$/, '') || 'pki';

    const out = [
      locals([['servers', hmap(entries, '  ')]]),
      resource('tls_private_key', 'ca', keyAlg),
      resource('tls_self_signed_cert', 'ca', [
        ['private_key_pem', 'tls_private_key.ca.private_key_pem'],
        ['is_ca_certificate', 'true'],
        ['set_subject_key_id', 'true'],
        ['validity_period_hours', String(Math.round(n(v.ca_validity_years, 10) * 8766))],
        ['allowed_uses', slist(['cert_signing', 'crl_signing', 'digital_signature'])],
        { b: 'subject', body: [['common_name', q(v.ca_common_name || 'Internal Root CA')], org && ['organization', q(org)]] },
      ]),
      resource('tls_private_key', 'server', [['for_each', 'local.servers'], ...keyAlg]),
      resource('tls_cert_request', 'server', [
        ['for_each', 'local.servers'],
        ['private_key_pem', 'tls_private_key.server[each.key].private_key_pem'],
        ['dns_names', 'each.value.dns_names'],
        ['ip_addresses', 'each.value.ip_addresses'],
        { b: 'subject', body: [['common_name', 'each.key'], org && ['organization', q(org)]] },
      ]),
      resource('tls_locally_signed_cert', 'server', [
        ['for_each', 'local.servers'],
        ['cert_request_pem', 'tls_cert_request.server[each.key].cert_request_pem'],
        ['ca_private_key_pem', 'tls_private_key.ca.private_key_pem'],
        ['ca_cert_pem', 'tls_self_signed_cert.ca.cert_pem'],
        ['validity_period_hours', String(Math.round(n(v.cert_validity_days, 397) * 24))],
        ['early_renewal_hours', String(Math.round(n(v.renew_days, 30) * 24))],
        ['set_subject_key_id', 'true'],
        ['allowed_uses', slist(uses)],
      ]),
    ];
    if (on(v.write_files)) {
      out.push(
        resource('local_file', 'ca_cert', [['filename', q(`${dir}/ca.crt`)], ['content', 'tls_self_signed_cert.ca.cert_pem'], ['file_permission', '"0644"']]),
        resource('local_file', 'server_cert', [
          ['for_each', 'local.servers'],
          ['filename', `"${q(dir).slice(1, -1)}/\${each.key}.crt"`],
          // Leaf first, then the CA: the full chain a server presents.
          ['content', '"${tls_locally_signed_cert.server[each.key].cert_pem}${tls_self_signed_cert.ca.cert_pem}"'],
          ['file_permission', '"0644"'],
        ]),
        resource('local_sensitive_file', 'server_key', [
          ['for_each', 'local.servers'],
          ['filename', `"${q(dir).slice(1, -1)}/\${each.key}.key"`],
          ['content', 'tls_private_key.server[each.key].private_key_pem'],
          ['file_permission', '"0600"'],
        ]),
      );
      if (on(v.write_ca_key)) {
        out.push(resource('local_sensitive_file', 'ca_key', [['filename', q(`${dir}/ca.key`)], ['content', 'tls_private_key.ca.private_key_pem'], ['file_permission', '"0600"']]));
      }
    }
    out.push(
      output('ca_cert_pem', 'tls_self_signed_cert.ca.cert_pem', 'CA certificate, to add to trust stores'),
      output('server_cert_pem', '{ for cn, cert in tls_locally_signed_cert.server : cn => cert.cert_pem }', 'Certificate of each server, by common name'),
    );
    return { hcl: out.join('\n\n'), findings };
  },
});

// --- BIND DNS records ------------------------------------------------------------

const bindRecords = scenario('dns', {
  id: 'linux_bind_dns_records',
  label: 'BIND DNS records (RFC 2136)',
  group: GROUP,
  description:
    'A, AAAA, CNAME, TXT, MX and SRV records in one zone, sent to BIND (or any RFC 2136 server) as TSIG-signed dynamic updates, with matching PTR records for every A record in the /24 reverse zones. The zones must allow updates with this key.',
  inputs: [
    { id: 'zone', label: 'Zone', control: 'text', default: 'example.com.', hint: 'trailing dot added if missing' },
    { id: 'ttl', label: 'TTL', control: 'number', default: 3600, min: 0, hint: 'seconds' },
    { id: 'a_records', label: 'A records', control: 'textarea', default: 'web01=10.0.0.21\nweb02=10.0.0.22\napi01=10.0.0.31', hint: 'name=IPv4, one per line; repeat a name for several addresses; @ for the zone apex' },
    { id: 'ptr', label: 'PTR records for the A records', control: 'toggle', default: true, hint: 'in <c.b.a>.in-addr.arpa.' },
    { id: 'aaaa_records', label: 'AAAA records', control: 'textarea', default: 'web01=2001:db8:10::21', hint: 'name=IPv6, one per line' },
    { id: 'cname_records', label: 'CNAME records', control: 'textarea', default: 'www=web01\napi=api01', hint: 'alias=target; a target without a dot is in this zone' },
    { id: 'txt_records', label: 'TXT records', control: 'textarea', default: '@=v=spf1 mx -all', hint: 'name=text, one per line' },
    { id: 'mx_records', label: 'MX records', control: 'textarea', default: '@=10 mail1.example.com.\n@=20 mail2.example.com.', hint: 'name=preference exchange' },
    { id: 'srv_records', label: 'SRV records', control: 'textarea', default: '_ldap._tcp=0 100 389 dc01.example.com.', hint: '_service._proto=priority weight port target' },
  ],
  emits: ['dns_a_record_set', 'dns_aaaa_record_set', 'dns_cname_record', 'dns_ptr_record', 'dns_txt_record_set', 'dns_mx_record_set', 'dns_srv_record_set'],
  body: (v) => {
    const findings            = [];
    const zone = fqdn(String(v.zone ?? '').trim() || 'example.com.');
    const target = (name        )         => (name.includes('.') ? fqdn(name) : `${name}.${zone}`);
    const group = (value         )                        => {
      const m = new Map                  ();
      for (const [name, val] of pairs(value)) if (val) m.set(name, [...(m.get(name) ?? []), val]);
      return m;
    };
    const setMap = (m                       )         => hmap([...m].map(([k, vals]) => [k, slist(vals)]), '  ');
    const apexName = ['name', 'each.key == "@" ? null : each.key']         ;
    const common         = [['zone', 'local.zone'], ['ttl', 'local.ttl']];

    const a = group(v.a_records);
    const aaaa = group(v.aaaa_records);
    const cname = pairs(v.cname_records).filter(([, t]) => t);
    const txt = group(v.txt_records);
    const mx = new Map                ();
    for (const [name, rest] of pairs(v.mx_records)) {
      const [pref, exch] = rest.split(/\s+/);
      if (!exch || !/^\d+$/.test(pref ?? '')) {
        findings.push(error('linux.dns.mx', `MX "${name}=${rest}" needs "preference exchange", such as 10 mail1.example.com.`, { path: 'mx_records' }));
        continue;
      }
      mx.set(name, `${mx.get(name) ?? ''}${mx.has(name) ? ', ' : ''}{ preference = ${Number(pref)}, exchange = ${q(target(exch))} }`);
    }
    const srv = new Map                ();
    for (const [name, rest] of pairs(v.srv_records)) {
      const [pri, wt, port, tgt] = rest.split(/\s+/);
      if (!tgt || ![pri, wt, port].every((x) => /^\d+$/.test(x ?? ''))) {
        findings.push(error('linux.dns.srv', `SRV "${name}=${rest}" needs "priority weight port target".`, { path: 'srv_records' }));
        continue;
      }
      srv.set(name, `${srv.get(name) ?? ''}${srv.has(name) ? ', ' : ''}{ priority = ${Number(pri)}, weight = ${Number(wt)}, port = ${Number(port)}, target = ${q(target(tgt))} }`);
    }
    const ptr                     = [];
    if (on(v.ptr)) {
      for (const [name, ips] of a) {
        for (const ip of ips) {
          const m = IPV4.exec(ip);
          if (!m) {
            findings.push(error('linux.dns.a', `"${ip}" for ${name} is not an IPv4 address.`, { path: 'a_records' }));
            continue;
          }
          ptr.push([ip, hmap([['zone', q(`${m[3]}.${m[2]}.${m[1]}.in-addr.arpa.`)], ['name', q(m[4] ?? '')], ['ptr', q(name === '@' ? zone : `${name}.${zone}`)]], '    ')]);
        }
      }
      if (ptr.length) findings.push(warning('linux.dns.reverse-zones', 'PTR records go in the /24 reverse zones (c.b.a.in-addr.arpa.); those zones must exist on the server and accept updates with the same key.', { path: 'ptr' }));
    }

    const loc         = [['zone', q(zone)], ['ttl', String(n(v.ttl, 3600))]];
    const out           = [];
    if (a.size) {
      loc.push(['a_records', setMap(a)]);
      out.push(resource('dns_a_record_set', 'records', [['for_each', 'local.a_records'], ...common, apexName, ['addresses', 'each.value']]));
    }
    if (ptr.length) {
      loc.push(['ptr_records', hmap(ptr, '  ')]);
      out.push(resource('dns_ptr_record', 'records', [['for_each', 'local.ptr_records'], ['zone', 'each.value.zone'], ['name', 'each.value.name'], ['ptr', 'each.value.ptr'], ['ttl', 'local.ttl']]));
    }
    if (aaaa.size) {
      loc.push(['aaaa_records', setMap(aaaa)]);
      out.push(resource('dns_aaaa_record_set', 'records', [['for_each', 'local.aaaa_records'], ...common, apexName, ['addresses', 'each.value']]));
    }
    if (cname.length) {
      loc.push(['cname_records', hmap(cname.map(([alias, t]) => [alias, q(target(t))]), '  ')]);
      out.push(resource('dns_cname_record', 'records', [['for_each', 'local.cname_records'], ...common, ['name', 'each.key'], ['cname', 'each.value']]));
    }
    if (txt.size) {
      loc.push(['txt_records', setMap(txt)]);
      out.push(resource('dns_txt_record_set', 'records', [['for_each', 'local.txt_records'], ...common, apexName, ['txt', 'each.value']]));
    }
    if (mx.size) {
      loc.push(['mx_records', hmap([...mx].map(([k, val]) => [k, `[${val}]`]), '  ')]);
      out.push(
        resource('dns_mx_record_set', 'records', [
          ['for_each', 'local.mx_records'],
          ...common,
          apexName,
          { b: 'dynamic "mx"', body: [['for_each', 'each.value'], { b: 'content', body: [['preference', 'mx.value.preference'], ['exchange', 'mx.value.exchange']] }] },
        ]),
      );
    }
    if (srv.size) {
      loc.push(['srv_records', hmap([...srv].map(([k, val]) => [k, `[${val}]`]), '  ')]);
      out.push(
        resource('dns_srv_record_set', 'records', [
          ['for_each', 'local.srv_records'],
          ...common,
          ['name', 'each.key'],
          {
            b: 'dynamic "srv"',
            body: [['for_each', 'each.value'], { b: 'content', body: [['priority', 'srv.value.priority'], ['weight', 'srv.value.weight'], ['port', 'srv.value.port'], ['target', 'srv.value.target']] }],
          },
        ]),
      );
    }
    if (out.length === 0) findings.push(warning('linux.dns.empty', 'No records given.', { path: 'a_records' }));
    return { hcl: [locals(loc), ...out].join('\n\n'), findings };
  },
});

// --- Ansible playbook run --------------------------------------------------------

const ansiblePlaybook = scenario('ansible', {
  id: 'linux_ansible_playbook',
  label: 'Run an Ansible playbook',
  group: GROUP,
  description:
    'An Ansible inventory in the state (an ansible_group and an ansible_host per host, readable by the cloud.terraform.terraform_provider inventory plugin) and an ansible_playbook run against each host, with extra vars, tags, check mode and an optional vault. ansible-playbook must be installed on the Terraform runner.',
  inputs: [
    { id: 'group_name', label: 'Inventory group', control: 'text', default: 'webservers' },
    { id: 'hosts', label: 'Hosts', control: 'textarea', default: 'web01.example.com=10.0.0.21\nweb02.example.com=10.0.0.22', hint: 'inventory name=address to connect to, one per line' },
    { id: 'playbook', label: 'Playbook', control: 'text', default: 'playbooks/site.yml', hint: 'path on the Terraform runner' },
    { id: 'extra_vars', label: 'Extra vars', control: 'textarea', default: 'app_version=1.4.2\napp_env=production', hint: 'name=value, one per line' },
    { id: 'tags', label: 'Tags', control: 'text', default: '', hint: 'comma separated; blank = all tasks' },
    { id: 'check_mode', label: 'Check mode (dry run)', control: 'toggle', default: false },
    { id: 'diff_mode', label: 'Show diffs', control: 'toggle', default: false },
    { id: 'replayable', label: 'Run on every apply', control: 'toggle', default: true, hint: 'off = only when first created' },
    { id: 'ansible_user', label: 'SSH user', control: 'text', default: 'ansible', section: 'Connection' },
    { id: 'ssh_private_key_path', label: 'SSH private key', control: 'text', default: '~/.ssh/id_ed25519', section: 'Connection', hint: 'path on the Terraform runner' },
    { id: 'become', label: 'Become root (sudo)', control: 'toggle', default: true, section: 'Connection' },
    { id: 'use_vault', label: 'Use an Ansible vault', control: 'toggle', default: false, section: 'Vault' },
    { id: 'vault_file', label: 'Vault file', control: 'text', default: 'group_vars/all/vault.yml', section: 'Vault', showWhen: { input: 'use_vault', equals: ['true'] } },
    { id: 'vault_password_file', label: 'Vault password file', control: 'text', default: '~/.ansible/vault-pass.txt', section: 'Vault', showWhen: { input: 'use_vault', equals: ['true'] }, hint: 'kept out of the repository' },
    { id: 'vault_id', label: 'Vault ID', control: 'text', default: '', section: 'Vault', showWhen: { input: 'use_vault', equals: ['true'] }, hint: 'blank = default' },
  ],
  emits: ['ansible_group', 'ansible_host', 'ansible_playbook', 'ansible_vault'],
  body: (v) => {
    const findings            = [];
    const hosts = pairs(v.hosts).map(([name, addr])                   => [name, addr || name]);
    if (hosts.length === 0) {
      findings.push(error('linux.ansible.no-hosts', 'Name at least one host.', { path: 'hosts' }));
      hosts.push(['app01.example.com', '10.0.0.21']);
    }
    const extra = pairs(v.extra_vars).map(([k, val])                   => [k, q(val)]);
    const tags = items(v.tags);
    const vault = on(v.use_vault);
    const vaultId = String(v.vault_id ?? '').trim();
    const group = String(v.group_name ?? '').trim() || 'all_hosts';
    const out = [
      variable('ssh_private_key_path', 'Private key Ansible connects with', { default: String(v.ssh_private_key_path ?? '').trim() || '~/.ssh/id_ed25519' }),
      locals([
        ['hosts', hmap(hosts.map(([name, addr]) => [name, q(addr)]), '  ')],
        [
          'connection_vars',
          hmap(
            [
              ['ansible_user', q(v.ansible_user || 'ansible')],
              ['ansible_ssh_private_key_file', 'pathexpand(var.ssh_private_key_path)'],
              ['ansible_become', q(String(on(v.become)))],
            ],
            '  ',
          ),
        ],
        ['extra_vars', hmap(extra, '  ')],
      ]),
      resource('ansible_group', 'group', [['name', q(group)], ['variables', 'local.connection_vars']]),
      resource('ansible_host', 'hosts', [
        ['for_each', 'local.hosts'],
        ['name', 'each.key'],
        ['groups', '[ansible_group.group.name]'],
        ['variables', '{ ansible_host = each.value }'],
      ]),
      vault
        ? resource('ansible_vault', 'secrets', [
            ['vault_file', q(v.vault_file)],
            ['vault_password_file', q(v.vault_password_file)],
            vaultId && ['vault_id', q(vaultId)],
          ])
        : '',
      resource('ansible_playbook', 'run', [
        ['for_each', 'ansible_host.hosts'],
        ['name', 'each.value.name'],
        ['groups', 'each.value.groups'],
        ['playbook', q(v.playbook || 'playbooks/site.yml')],
        ['replayable', String(on(v.replayable))],
        ['check_mode', String(on(v.check_mode))],
        ['diff_mode', String(on(v.diff_mode))],
        tags.length > 0 && ['tags', slist(tags)],
        // The playbook's own inventory holds only the name, so the connection travels as extra vars.
        ['extra_vars', 'merge(local.connection_vars, { ansible_host = local.hosts[each.key] }, local.extra_vars)'],
        vault && ['vault_files', '[ansible_vault.secrets.vault_file]'],
        vault && ['vault_password_file', 'ansible_vault.secrets.vault_password_file'],
        vault && vaultId && ['vault_id', 'ansible_vault.secrets.vault_id'],
      ]),
      output('inventory_hosts', 'local.hosts', 'Inventory name and address of each host'),
    ];
    return { hcl: out.filter(Boolean).join('\n\n'), findings };
  },
});

// --- service account and SSH hardening ------------------------------------

const serviceAccount = scenario('random', {
  id: 'linux_service_account_hardening',
  label: 'Service account + SSH hardening',
  group: GROUP,
  description:
    'Creates a service account on each host over SSH with a generated password, sudo rights (optionally without a password) and its authorized SSH keys, then turns off root and password logins in sshd, checks the configuration with sshd -t and restarts it. The password is a sensitive output.',
  inputs: [
    ...sshInputs(),
    DISTRO_INPUT,
    { id: 'service_user', label: 'Service account', control: 'text', default: 'svc-app' },
    { id: 'authorized_keys', label: 'Its SSH public keys', control: 'textarea', default: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyReplaceMe svc-app@example.com', hint: 'one per line; replaces authorized_keys' },
    { id: 'sudo', label: 'Grant sudo', control: 'toggle', default: true },
    { id: 'nopasswd', label: 'sudo without a password', control: 'toggle', default: true, showWhen: { input: 'sudo', equals: ['true'] } },
    { id: 'password_length', label: 'Password length', control: 'number', default: 32, min: 16, max: 128, section: 'Password' },
    { id: 'disable_root_login', label: 'PermitRootLogin no', control: 'toggle', default: true, section: 'sshd' },
    { id: 'disable_password_auth', label: 'PasswordAuthentication no', control: 'toggle', default: true, section: 'sshd', hint: 'key-only logins' },
  ],
  emits: ['random_password', 'terraform_data'],
  body: (v) => {
    const findings            = [];
    const hosts = hostsOf(v, findings);
    const distro = distroOf(v);
    const user = String(v.service_user ?? '').trim() || 'svc-app';
    if (!/^[a-z_][a-z0-9_-]*$/.test(user)) findings.push(error('linux.account.name', `"${user}" is not a valid Linux user name.`, { path: 'service_user' }));
    const keys = lines(v.authorized_keys);
    if (keys.length === 0 && on(v.disable_password_auth)) {
      findings.push(warning('linux.account.no-keys', 'With password logins off and no SSH key, the service account cannot log in over SSH.', { path: 'authorized_keys' }));
    }
    const u = sq(user);
    const sudoers = `/etc/sudoers.d/${user}`;
    const settings           = [...(on(v.disable_root_login) ? ['PermitRootLogin no'] : []), ...(on(v.disable_password_auth) ? ['PasswordAuthentication no'] : [])];
    const commands           = [
      'set -o errexit',
      `id -u ${u} >/dev/null 2>&1 || sudo useradd --create-home --shell /bin/bash --comment 'Service account (Terraform)' ${u}`,
      `H=$(getent passwd ${u} | cut -d: -f6)`,
      `G=$(id -gn ${u})`,
      `sudo install -d -m 0700 -o ${u} -g "$G" "$H/.ssh"`,
      keys.length > 0 ? `printf '%s\\n' ${keys.map(sq).join(' ')} | sudo tee "$H/.ssh/authorized_keys" >/dev/null` : `sudo touch "$H/.ssh/authorized_keys"`,
      `sudo chown ${u}:"$G" "$H/.ssh/authorized_keys"`,
      `sudo chmod 0600 "$H/.ssh/authorized_keys"`,
    ];
    if (on(v.sudo)) {
      commands.push(
        `echo ${sq(`${user} ALL=(ALL) ${on(v.nopasswd) ? 'NOPASSWD: ' : ''}ALL`)} | sudo tee ${sudoers} >/dev/null`,
        `sudo chmod 0440 ${sudoers}`,
        `sudo visudo -cf ${sudoers}`,
      );
    } else {
      commands.push(`sudo rm -f ${sudoers}`);
    }
    if (settings.length > 0) {
      // A drop-in wins where sshd_config includes them (first match counts); the main file is edited too for releases that do not.
      commands.push(
        `if grep -qE '^Include[[:space:]]+/etc/ssh/sshd_config\\.d/' /etc/ssh/sshd_config; then printf '%s\\n' ${settings.map(sq).join(' ')} | sudo tee /etc/ssh/sshd_config.d/00-terraform-hardening.conf >/dev/null; fi`,
        ...settings.map((s) => {
          const [key] = s.split(' ');
          return `sudo sed -i -E 's/^#?[[:space:]]*${key}[[:space:]].*/${s}/' /etc/ssh/sshd_config`;
        }),
        'sudo /usr/sbin/sshd -t',
        `sudo systemctl restart ${SSHD_UNIT[distro]}`,
      );
    }
    const hcl = [
      sshKeyVariable(v),
      resource('random_password', 'service_account', [
        ['length', String(n(v.password_length, 32))],
        ['min_upper', '2'],
        ['min_lower', '2'],
        ['min_numeric', '2'],
        ['min_special', '2'],
        // No quotes, $, \ or backticks, so the password is safe inside single quotes.
        ['override_special', '"!#%*()-_=+[]{}<>:?"'],
      ]),
      locals([
        ['hosts', slist(hosts)],
        ['account_commands', mlist(commands.map(q), '  ')],
        // Separate, so the settings above are not hidden as sensitive in the plan.
        ['password_command', `"printf '%s:%s\\\\n' ${sq(user)} '\${random_password.service_account.result}' | sudo chpasswd"`],
      ]),
      resource('terraform_data', 'service_account', [
        ['for_each', 'toset(local.hosts)'],
        ['triggers_replace', '[local.account_commands, random_password.service_account.id]'],
        connection(v),
        { b: 'provisioner "remote-exec"', body: [['inline', 'concat(local.account_commands, [local.password_command])']] },
      ]),
      sensitiveOutput('service_account_password', 'random_password.service_account.result', `Password of ${user} (for console and sudo)`),
    ];
    return { hcl: hcl.join('\n\n'), findings };
  },
});

// --- packages, services and firewall ------------------------------------------

const packagesFirewall = scenario('null', {
  id: 'linux_packages_services_firewall',
  label: 'Packages, services and firewall',
  group: GROUP,
  description:
    'Over SSH on each host: refreshes (and optionally upgrades) packages with dnf, apt or zypper, installs a package list, enables and starts services, opens ports in firewalld or ufw, and schedules a reboot a minute later when the updates need one. Edits re-run it on the next apply.',
  inputs: [
    ...sshInputs(),
    DISTRO_INPUT,
    { id: 'packages', label: 'Packages', control: 'textarea', default: 'nginx\nchrony', hint: 'one per line; names differ by distribution' },
    { id: 'upgrade', label: 'Upgrade all packages first', control: 'toggle', default: false },
    { id: 'services', label: 'Services to enable and start', control: 'textarea', default: 'nginx', hint: 'systemd unit names, one per line' },
    { id: 'firewall', label: 'Configure the firewall', control: 'toggle', default: true, hint: 'firewalld, or ufw on Debian / Ubuntu' },
    { id: 'ports', label: 'Open', control: 'textarea', default: '80/tcp\n443/tcp', hint: 'port/protocol or a service name (https), one per line; SSH stays open', showWhen: { input: 'firewall', equals: ['true'] } },
    { id: 'reboot_if_required', label: 'Reboot if the updates need it', control: 'toggle', default: false, hint: 'scheduled one minute after' },
  ],
  emits: ['terraform_data'],
  body: (v) => {
    const findings            = [];
    const hosts = hostsOf(v, findings);
    const distro = distroOf(v);
    const pkg = PKG[distro];
    const packages = items(v.packages);
    const services = items(v.services);
    const openings = lines(v.ports).filter((p) => {
      const ok = /^\d{1,5}(-\d{1,5})?\/(tcp|udp)$/.test(p) || /^[a-z][a-z0-9-]*$/.test(p);
      if (!ok) findings.push(error('linux.firewall.port', `"${p}" is neither port/protocol (443/tcp) nor a service name.`, { path: 'ports' }));
      return ok;
    });
    if (distro === 'debian') {
      // ufw writes ranges with a colon.
      openings.forEach((o, i) => (openings[i] = o.replace(/^(\d+)-(\d+)\//, '$1:$2/')));
    }
    const commands = [
      'set -o errexit',
      WAIT_FOR_CLOUD_INIT,
      pkg.refresh,
      on(v.upgrade) && pkg.upgrade,
      packages.length > 0 && pkg.install(packages),
      ...services.map((s) => `sudo systemctl enable --now ${s}`),
      ...(on(v.firewall) ? firewallCommands(distro, openings, n(v.ssh_port, 22)) : []),
      ...(on(v.reboot_if_required) ? pkg.rebootIfRequired : []),
    ].filter(Boolean)            ;
    const hcl = [
      sshKeyVariable(v),
      locals([
        ['hosts', slist(hosts)],
        ['setup_commands', mlist(commands.map(q), '  ')],
      ]),
      sshRun(v, 'packages', { triggers: 'local.setup_commands', commandsLocal: 'local.setup_commands' }),
      output('configured_hosts', 'keys(terraform_data.packages)', 'Hosts the packages, services and firewall were applied to'),
    ];
    return { hcl: hcl.join('\n\n'), findings };
  },
});

// --- Active Directory join ---------------------------------------------------------

const AD_PACKAGES                           = {
  rhel: ['realmd', 'sssd', 'adcli', 'krb5-workstation', 'oddjob', 'oddjob-mkhomedir', 'samba-common-tools'],
  debian: ['realmd', 'sssd', 'sssd-tools', 'adcli', 'krb5-user', 'libnss-sss', 'libpam-sss', 'packagekit', 'samba-common-bin'],
  suse: ['realmd', 'sssd', 'sssd-ad', 'adcli', 'krb5-client', 'samba-client'],
};

const MKHOMEDIR                           = {
  rhel: ['sudo authselect enable-feature with-mkhomedir', 'sudo systemctl enable --now oddjobd'],
  debian: ['sudo pam-auth-update --enable mkhomedir'],
  suse: ['sudo pam-config -a --mkhomedir'],
};

const adJoin = scenario('null', {
  id: 'linux_ad_join_realmd',
  label: 'Join an Active Directory domain (realmd/SSSD)',
  group: GROUP,
  description:
    'Installs realmd, SSSD, adcli and Kerberos on each host, joins the domain with `realm join` into the given OU (the join password is a sensitive variable piped over stdin, never on a command line), restricts logins to AD groups, grants an AD group sudo, and creates home directories on first login. Skips the join when the host is already a member.',
  inputs: [
    ...sshInputs(),
    DISTRO_INPUT,
    { id: 'domain', label: 'AD domain', control: 'text', default: 'example.com', hint: 'DNS name; the hosts must resolve its SRV records' },
    { id: 'join_user', label: 'Join account', control: 'text', default: 'svc-domainjoin', hint: 'password in var.ad_join_password' },
    { id: 'computer_ou', label: 'Computer OU', control: 'text', default: 'OU=Linux,OU=Servers,DC=example,DC=com', hint: 'blank = the default Computers container' },
    { id: 'permitted_groups', label: 'Groups allowed to log in', control: 'textarea', default: 'linux-admins\nlinux-users', hint: 'one per line; blank = every domain user' },
    { id: 'sudo_group', label: 'Group with sudo', control: 'text', default: 'linux-admins', hint: 'blank = none' },
    { id: 'fully_qualified_names', label: 'Fully qualified names (user@domain)', control: 'toggle', default: false, section: 'SSSD' },
    { id: 'mkhomedir', label: 'Create home directories on first login', control: 'toggle', default: true, section: 'SSSD' },
  ],
  emits: ['terraform_data'],
  body: (v) => {
    const findings            = [];
    const hosts = hostsOf(v, findings);
    const distro = distroOf(v);
    const domain = String(v.domain ?? '').trim().toLowerCase() || 'example.com';
    const ou = String(v.computer_ou ?? '').trim();
    const fqn = on(v.fully_qualified_names);
    const groups = lines(v.permitted_groups);
    const sudoGroup = String(v.sudo_group ?? '').trim();
    const qualify = (g        )         => (fqn && !g.includes('@') ? `${g}@${domain}` : g);
    const join = [
      'sudo realm join',
      `--user=${sq(String(v.join_user ?? '').trim() || 'svc-domainjoin')}`,
      ou && `--computer-ou=${sq(ou)}`,
      '--membership-software=adcli',
      sq(domain),
    ].filter(Boolean).join(' ');
    const commands           = [
      'set -o errexit',
      WAIT_FOR_CLOUD_INIT,
      PKG[distro].refresh,
      PKG[distro].install(AD_PACKAGES[distro]),
    ];
    const settings = [
      `sudo sed -i -E 's/^use_fully_qualified_names.*/use_fully_qualified_names = ${fqn ? 'True' : 'False'}/' /etc/sssd/sssd.conf`,
      `sudo sed -i -E 's|^fallback_homedir.*|fallback_homedir = ${fqn ? '/home/%u@%d' : '/home/%u'}|' /etc/sssd/sssd.conf`,
      ...(on(v.mkhomedir) ? MKHOMEDIR[distro] : []),
      ...(groups.length > 0 ? ['sudo realm deny --all', `sudo realm permit --groups ${groups.map((g) => sq(qualify(g))).join(' ')}`] : ['sudo realm permit --all']),
      ...(sudoGroup
        ? [
            `echo ${sq(`%${qualify(sudoGroup).replace(/ /g, '\\ ')} ALL=(ALL) ALL`)} | sudo tee /etc/sudoers.d/ad-admins >/dev/null`,
            'sudo chmod 0440 /etc/sudoers.d/ad-admins',
            'sudo visudo -cf /etc/sudoers.d/ad-admins',
          ]
        : ['sudo rm -f /etc/sudoers.d/ad-admins']),
      'sudo systemctl restart sssd',
    ];
    const hcl = [
      sshKeyVariable(v),
      variable('ad_join_password', `Password of the account that joins hosts to ${domain}`, { sensitive: true }),
      locals([
        ['hosts', slist(hosts)],
        ['prepare_commands', mlist(commands.map(q), '  ')],
        // realm reads the password from stdin when it is not a terminal.
        [
          'join_command',
          `"if ! realm list --name-only | grep -qix ${sq(domain)}; then printf '%s' '\${replace(var.ad_join_password, "'", "'\\\\''")}' | ${join.replace(/"/g, '\\"')}; fi"`,
        ],
        ['sssd_commands', mlist(settings.map(q), '  ')],
      ]),
      resource('terraform_data', 'ad_join', [
        ['for_each', 'toset(local.hosts)'],
        ['triggers_replace', '[local.prepare_commands, local.sssd_commands]'],
        connection(v),
        { b: 'provisioner "remote-exec"', body: [['inline', 'concat(local.prepare_commands, [local.join_command], local.sssd_commands)']] },
      ]),
      output('joined_hosts', 'keys(terraform_data.ad_join)', `Hosts joined to ${domain}`),
    ];
    return { hcl: hcl.join('\n\n'), findings };
  },
});

// --- config file with validate and restart ---------------------------------------

const deployConfig = scenario('local', {
  id: 'linux_deploy_config_file',
  label: 'Deploy a config file and restart a service',
  group: GROUP,
  description:
    'Uploads a configuration file to each host (from the text here or a file on the Terraform runner), installs it with the owner and mode given, keeps the previous copy, runs a validation command that restores the previous file when it fails, and reloads or restarts the service. A change to the content re-deploys it.',
  inputs: [
    ...sshInputs(),
    { id: 'content_source', label: 'Content from', control: 'select', options: [{ value: 'inline', label: 'The text below' }, { value: 'file', label: 'A file on the Terraform runner' }], default: 'inline' },
    {
      id: 'content',
      label: 'File content',
      control: 'textarea',
      default: 'server {\n    listen 80;\n    server_name app.example.com;\n    location / {\n        proxy_pass http://127.0.0.1:8080;\n    }\n}',
      showWhen: { input: 'content_source', equals: ['inline'] },
    },
    { id: 'source_path', label: 'Local file', control: 'text', default: 'files/app.conf', showWhen: { input: 'content_source', equals: ['file'] } },
    { id: 'destination', label: 'Remote path', control: 'text', default: '/etc/nginx/conf.d/app.conf' },
    { id: 'validate_command', label: 'Validate with', control: 'text', default: 'sudo nginx -t', hint: 'blank = no check' },
    { id: 'restart_command', label: 'Then run', control: 'text', default: 'sudo systemctl reload nginx', hint: 'reload or restart' },
    { id: 'owner', label: 'Owner', control: 'text', default: 'root', section: 'Permissions' },
    { id: 'file_group', label: 'Group', control: 'text', default: 'root', section: 'Permissions' },
    { id: 'mode', label: 'Mode', control: 'text', default: '0644', section: 'Permissions' },
  ],
  emits: ['terraform_data'],
  body: (v) => {
    const findings            = [];
    const hosts = hostsOf(v, findings);
    const dest = String(v.destination ?? '').trim() || '/etc/app.conf';
    const mode = String(v.mode ?? '').trim() || '0644';
    if (!/^[0-7]{3,4}$/.test(mode)) findings.push(error('linux.config.mode', `"${mode}" is not an octal file mode.`, { path: 'mode' }));
    const tmp = `/tmp/terraform-${dest.split('/').pop() || 'config'}`;
    const d = sq(dest);
    const bak = sq(`${dest}.bak`);
    const validate = String(v.validate_command ?? '').trim();
    const restart = String(v.restart_command ?? '').trim();
    const commands = [
      'set -o errexit',
      `if [ -f ${d} ]; then sudo cp -a ${d} ${bak}; fi`,
      `sudo install -D -m ${mode} -o ${sq(String(v.owner || 'root'))} -g ${sq(String(v.file_group || 'root'))} ${sq(tmp)} ${d}`,
      `rm -f ${sq(tmp)}`,
      validate && `if ! ${validate}; then if [ -f ${bak} ]; then sudo cp -a ${bak} ${d}; fi; echo 'Validation failed; previous file restored.' >&2; exit 1; fi`,
      restart,
    ].filter(Boolean)            ;
    const fromFile = String(v.content_source) === 'file';
    const hcl = [
      sshKeyVariable(v),
      // Read at plan time, so a missing file is a plan error, not a validate one.
      fromFile ? `data "local_file" "config" {\n  filename = ${q(v.source_path || 'files/app.conf')}\n}` : '',
      locals([
        ['hosts', slist(hosts)],
        ['config_content', fromFile ? 'data.local_file.config.content' : qFile(String(v.content ?? '').replace(/\r/g, ''))],
        ['deploy_commands', mlist(commands.map(q), '  ')],
      ]),
      sshRun(v, 'config', {
        triggers: '[sha256(local.config_content), local.deploy_commands]',
        commandsLocal: 'local.deploy_commands',
        before: [{ b: 'provisioner "file"', body: [['content', 'local.config_content'], ['destination', q(tmp)]] }],
      }),
      output('config_sha256', 'sha256(local.config_content)', `SHA-256 of ${dest} as deployed`),
    ];
    return { hcl: hcl.filter(Boolean).join('\n\n'), findings };
  },
});

// --- NFS mount ------------------------------------------------------------------------

const NFS_CLIENT                         = { rhel: 'nfs-utils', debian: 'nfs-common', suse: 'nfs-client' };

const nfsMount = scenario('null', {
  id: 'linux_nfs_mount',
  label: 'NFS mount (fstab) over SSH',
  group: GROUP,
  description:
    'Installs the NFS client on each host, creates the mount point, adds one /etc/fstab entry (left alone when the mount point already has one) and mounts it, so the share comes back after a reboot.',
  inputs: [
    ...sshInputs(),
    DISTRO_INPUT,
    { id: 'nfs_server', label: 'NFS server', control: 'text', default: 'nas01.example.com' },
    { id: 'export_path', label: 'Export', control: 'text', default: '/exports/data' },
    { id: 'mount_point', label: 'Mount point', control: 'text', default: '/mnt/data' },
    {
      id: 'nfs_version',
      label: 'NFS version',
      control: 'select',
      options: [
        { value: '4.2', label: 'NFSv4.2' },
        { value: '4.1', label: 'NFSv4.1' },
        { value: '3', label: 'NFSv3' },
      ],
      default: '4.2',
    },
    { id: 'mount_options', label: 'Options', control: 'text', default: 'rw,hard,noatime,_netdev', hint: 'vers= is added', section: 'Advanced' },
  ],
  emits: ['terraform_data'],
  body: (v) => {
    const findings            = [];
    const hosts = hostsOf(v, findings);
    const distro = distroOf(v);
    const mp = String(v.mount_point ?? '').trim().replace(/\/+$/, '') || '/mnt/data';
    if (!mp.startsWith('/') || /\s/.test(mp)) findings.push(error('linux.nfs.mount-point', 'The mount point must be an absolute path without spaces.', { path: 'mount_point' }));
    const version = String(v.nfs_version ?? '4.2');
    const fstype = version === '3' ? 'nfs' : 'nfs4';
    const opts = [...items(v.mount_options).filter((o) => !o.startsWith('vers=')), `vers=${version}`].join(',');
    const entry = `${String(v.nfs_server ?? '').trim()}:${String(v.export_path ?? '').trim()} ${mp} ${fstype} ${opts} 0 0`;
    const escaped = mp.replace(/[.[\]\\*^$/]/g, (c) => (c === '/' ? '/' : `\\${c}`));
    const commands = [
      'set -o errexit',
      PKG[distro].install([NFS_CLIENT[distro]]),
      `sudo mkdir -p ${sq(mp)}`,
      `grep -qE '^[^#]*[[:space:]]${escaped}[[:space:]]' /etc/fstab || echo ${sq(entry)} | sudo tee -a /etc/fstab >/dev/null`,
      'sudo systemctl daemon-reload',
      `mountpoint -q ${sq(mp)} || sudo mount ${sq(mp)}`,
    ];
    const hcl = [
      sshKeyVariable(v),
      locals([
        ['hosts', slist(hosts)],
        ['mount_commands', mlist(commands.map(q), '  ')],
      ]),
      sshRun(v, 'nfs_mount', { triggers: 'local.mount_commands', commandsLocal: 'local.mount_commands' }),
      output('fstab_entry', q(entry), 'The line added to /etc/fstab'),
    ];
    return { hcl: hcl.join('\n\n'), findings };
  },
});

// --- hostnames from a naming convention --------------------------------------------

const hostnames = scenario('random', {
  id: 'linux_hostnames',
  label: 'Hostnames from a naming convention',
  group: GROUP,
  description:
    'Builds a set of hostnames and FQDNs from site, environment and role codes with a numbered, random-hex or random-word suffix, stable across applies (random values only change when the prefix does), for use by VM, DNS and cloud-init blueprints.',
  inputs: [
    { id: 'site', label: 'Site code', control: 'text', default: 'lon' },
    { id: 'environment', label: 'Environment', control: 'select', options: ['prd', 'stg', 'uat', 'dev', 'tst'].map((e) => ({ value: e, label: e })), default: 'prd' },
    { id: 'role', label: 'Role', control: 'text', default: 'web' },
    { id: 'count', label: 'How many', control: 'number', default: 3, min: 1, max: 99 },
    {
      id: 'style',
      label: 'Suffix',
      control: 'select',
      options: [
        { value: 'sequence', label: 'Numbered (01, 02, …)' },
        { value: 'hex', label: 'Random hex (a1b2c3)' },
        { value: 'pet', label: 'Random words (brave-otter)' },
      ],
      default: 'sequence',
    },
    { id: 'domain', label: 'DNS domain', control: 'text', default: 'example.com' },
  ],
  emits: ['random_id', 'random_pet'],
  body: (v) => {
    const count = Math.max(1, Math.round(n(v.count, 3)));
    const clean = (s         , d        )         => String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '') || d;
    const prefix = [clean(v.site, 'lon'), clean(v.environment, 'prd'), clean(v.role, 'web')].join('-');
    const style = String(v.style ?? 'sequence');
    const out           = [locals([['prefix', q(prefix)], ['domain', q(String(v.domain ?? '').trim() || 'example.com')], ['host_count', String(count)]])];
    let names        ;
    if (style === 'hex') {
      out.push(resource('random_id', 'suffix', [['count', 'local.host_count'], ['byte_length', '3'], ['keepers', '{ prefix = local.prefix }']]));
      names = '[for id in random_id.suffix : "${local.prefix}-${id.hex}"]';
    } else if (style === 'pet') {
      out.push(resource('random_pet', 'suffix', [['count', 'local.host_count'], ['length', '2'], ['prefix', 'local.prefix'], ['separator', '"-"'], ['keepers', '{ prefix = local.prefix }']]));
      names = 'random_pet.suffix[*].id';
    } else {
      names = '[for i in range(1, local.host_count + 1) : format("%s%02d", local.prefix, i)]';
    }
    out.push(
      locals([['hostnames', names]]),
      output('hostnames', 'local.hostnames', 'Short hostnames'),
      output('fqdns', '[for h in local.hostnames : "${h}.${local.domain}"]', 'Fully qualified names'),
    );
    return out.join('\n\n');
  },
});

export const LINUX_SCENARIOS                       = [
  remoteExec,
  cloudInit,
  sshKeyPair,
  internalCa,
  bindRecords,
  ansiblePlaybook,
  serviceAccount,
  packagesFirewall,
  adJoin,
  deployConfig,
  nfsMount,
  hostnames,
];
