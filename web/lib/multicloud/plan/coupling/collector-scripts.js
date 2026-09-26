/**
 * The hidden-coupling collectors' text (addendum A.2.9), embedded verbatim
 * and rendered by `collectors.ts`. Both mask secrets in the guest (the same
 * rule as `maskSecrets` in import.ts) before anything is written. Checked
 * with `bash -n` or the PowerShell parser in coupling.test.ts.
 */

export const COUPLING_SCRIPTS                                   = Object.freeze({
  "coupling-linux.sh": `#!/usr/bin/env bash
# coupling-linux.sh: hidden coupling on a Linux server, as an
# archtoolkit.coupling v1 file (addendum A.2.9).
#
# Finds what ties this server to others by address or name: the hosts file,
# address / FQDN / UNC / URL literals and connection strings in configuration
# (/etc, /opt, /srv, and the working directories and environment files of
# systemd services; text files under 1 MiB), tnsnames.ora and odbc.ini, cron
# and systemd timers, service accounts and sudoers entries, NFS / CIFS
# mounts, CUPS printers, the SMTP relay, SNMP trap targets, TLS certificates
# bound in nginx / Apache / HAProxy, licence files (FlexLM / RLM SERVER and
# HOST lines, and this server's MAC addresses in configuration), and the
# time source and zone.
#
# Secrets are never copied: any value of a key or connection-string part
# named like password, pwd, secret, key or token is written as ***, and so
# is the password in a URL and the community in an SNMP trap line.
#
# Usage: coupling-linux.sh [--domains corp.example,example.org] [--roots /app,/data/app]
#                          [--max-files 5000] [--out FILE]
# Needs: bash 4+, GNU grep / sed / awk, find. openssl for certificate details.
# Run as root to read every configuration file.

# No pipefail: a grep that finds nothing is not an error here.
set -eu

DOMAINS=""
ROOTS=""
MAX_FILES=5000
MAX_REFS=4000
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --domains) DOMAINS="\${2:?--domains needs a list}"; shift 2 ;;
    --roots) ROOTS="\${2:?--roots needs a list}"; shift 2 ;;
    --max-files) MAX_FILES="\${2:?--max-files needs a number}"; shift 2 ;;
    --out) OUT="\${2:?--out needs a file}"; shift 2 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT
REFS="$TMPD/refs"
: > "$REFS"

js() {
  local s="\${1-}"
  s="\${s//\\\\/\\\\\\\\}"; s="\${s//\\"/\\\\\\"}"; s="\${s//$'\\t'/ }"; s="\${s//$'\\r'/}"; s="\${s//$'\\n'/ }"
  printf '"%s"' "$(printf '%s' "$s" | tr -d '\\000-\\037')"
}
jarr() { local first=1 line; printf '['; while IFS= read -r line; do [ -n "$line" ] || continue; [ "$first" = 1 ] || printf ','; first=0; js "$line"; done; printf ']'; }

# Masks secrets in one line of text (keep in step with coupling/import.ts maskSecrets).
mask() {
  sed -E \\
    -e 's/(key[[:space:]]*=[[:space:]]*"[^"]*(password|pwd|secret|token|key)[^"]*"[[:space:]]+value[[:space:]]*=[[:space:]]*")[^"]*/\\1***/Ig' \\
    -e 's/((password|passwd|pwd|secret|token|[A-Za-z0-9_.-]*key)[[:space:]]*["'"'"']?[[:space:]]*[=:][[:space:]]*["'"'"']?)[^;"'"'"'[:space:]<>,&)]+/\\1***/Ig' \\
    -e 's#(://[^:/@[:space:]]*:)[^@/[:space:]]+@#\\1***@#g'
}

# The literals a line points at: IPv4, IPv6, estate FQDNs, UNC hosts, URL hosts.
points() {
  local line="$1" dom
  {
    grep -oE '(^|[^0-9.])([0-9]{1,3}\\.){3}[0-9]{1,3}([^0-9.]|$)' <<<"$line" | grep -oE '([0-9]{1,3}\\.){3}[0-9]{1,3}' \\
      | grep -vE '^(127\\.|0\\.0\\.0\\.0|255\\.|169\\.254\\.)' || true
    grep -oE '\\[?([0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\\]?' <<<"$line" | tr -d '[]' | grep -viE '^(fe80|::1$)' || true
    grep -oE '\\\\\\\\[A-Za-z0-9._-]+' <<<"$line" | sed 's/^\\\\\\\\//' || true
    grep -oE '[a-zA-Z][a-zA-Z0-9+.-]*://([^/:@[:space:]]+(:[^/@[:space:]]*)?@)?[^/:@[:space:]"'"'"'<>,;]+' <<<"$line" | sed -E 's#^[^:]+://##; s#^[^@]*@##' || true
    grep -oiE '(host|server|data source|address|addr)[[:space:]]*=[[:space:]]*[A-Za-z0-9._-]+' <<<"$line" | sed -E 's/^[^=]*=[[:space:]]*//' || true
    grep -oE '@(//)?[A-Za-z0-9._-]+:[0-9]+' <<<"$line" | sed -E 's#^@(//)?##; s#:[0-9]+$##' || true
    for dom in \${DOMAINS//,/ }; do grep -oiE "[a-z0-9-]+(\\.[a-z0-9-]+)*\\.\${dom//./\\\\.}" <<<"$line" || true; done
  } | sort -u | awk 'NR <= 20'
}

# ref category where value [extra-json-fields]
ref() {
  local n
  n="$(wc -l < "$REFS")"
  [ "$n" -lt "$MAX_REFS" ] || return 0
  local value
  value="$(printf '%s' "$3" | mask | cut -c1-400)"
  printf '{"category":"%s","where":%s,"value":%s,"points":%s%s}\\n' "$1" "$(js "$2")" "$(js "$value")" \\
    "$(points "$value" | jarr)" "\${4:+,$4}" >> "$REFS"
}

is_comment() { [[ "$1" =~ ^[[:space:]]*(#|;|//|<!--|\\*|REM[[:space:]]) ]]; }

# ---- hosts file -----------------------------------------------------------------
if [ -r /etc/hosts ]; then
  n=0
  while IFS= read -r line; do
    n=$((n + 1))
    is_comment "$line" && continue
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    [[ "$line" =~ ^[[:space:]]*(127\\.|::1|ff0|fe00|0\\.0\\.0\\.0) ]] && continue
    ref hosts "/etc/hosts:$n" "$line"
  done < /etc/hosts
fi

# ---- configuration literals and connection strings ------------------------------
CONN='Data Source=|Server=|jdbc:|\\(DESCRIPTION=|mongodb(\\+srv)?://|postgres(ql)?://|mysql://|mariadb://|sqlserver://|redis://|amqps?://'
LIT='([0-9]{1,3}\\.){3}[0-9]{1,3}|([0-9a-fA-F]{1,4}:){3,7}[0-9a-fA-F]{1,4}|\\\\\\\\[A-Za-z0-9._-]+\\\\|[a-z][a-z0-9+.-]*://'
for dom in \${DOMAINS//,/ }; do LIT="$LIT|\\\\.\${dom//./\\\\.}"; done
LIT="$LIT|$CONN"
# The given roots and the services' own directories first, then /opt, /srv and /etc,
# so the file cap cuts the least specific places.
roots=()
for r in \${ROOTS//,/ }; do roots+=("$r"); done
if command -v systemctl >/dev/null 2>&1; then
  while IFS= read -r d; do
    case "$d" in ''|/|/root|/var|/var/lib|/usr|/usr/*|/tmp|/home|/run|/run/*|/proc*|/sys*|/etc|/etc/default|/etc/sysconfig) continue ;; esac
    [ -d "$d" ] && roots+=("$d")
  done < <(
    systemctl show --type=service --all -p WorkingDirectory -p EnvironmentFiles 2>/dev/null \\
      | sed -nE 's/^WorkingDirectory=(.+)$/\\1/p; s/^EnvironmentFiles=-?([^ ]+).*$/\\1/p' \\
      | while IFS= read -r p; do if [ -d "$p" ]; then echo "$p"; else dirname "$p"; fi; done | sort -u)
fi
roots+=(/opt /srv /etc)
for r in "\${roots[@]}"; do
  [ -d "$r" ] || continue
  # Distribution-owned trees and backups hold vendor addresses, not this estate's coupling.
  find "$r" -xdev \\( -path '/etc/ssl' -o -path '/etc/pki' -o -path '/etc/ca-certificates' -o -path '/etc/cloud' -o -path '/etc/xml' \\
      -o -path '/etc/update-motd.d' -o -path '/etc/apport' -o -path '/etc/logcheck' -o -path '/etc/dpkg' -o -path '/etc/groff' \\
      -o -path '/etc/PackageKit' -o -path '/etc/update-manager' -o -path '/etc/fonts' -o -path '/etc/X11' -o -path '/etc/alternatives' \\
      -o -path '/etc/selinux' -o -path '/etc/apparmor.d' -o -path '/etc/pam.d' -o -path '/etc/security' -o -path '/etc/bash_completion.d' \\
      -o -path '/etc/yum.repos.d' -o -path '/etc/apt' -o -path '/etc/zypp' -o -path '/etc/dnf' -o -path '/etc/snmp' \\
      -o -name '.git' -o -name 'node_modules' \\) -prune -o -type f -size -1024k \\
    ! -name '*.pem' ! -name '*.crt' ! -name '*.key' ! -name 'shadow*' ! -name 'gshadow*' ! -name '*.so*' ! -name '*.jar' \\
    ! -name '*.pyc' ! -name '*.gz' ! -name '*.zip' ! -name '*.bak' ! -name '*.old' ! -name '*.orig' ! -name '*.tmpl' \\
    ! -name '*.dpkg-*' ! -name '*.rpmnew' ! -name '*.rpmsave' ! -name '*.md' ! -name '*.html' ! -name '*.htm' ! -name '*.map' \\
    ! -name '*.min.js' ! -name '*.css' ! -name '*~' -print 2>/dev/null | sort || true
done | awk -v m="$MAX_FILES" '!seen[$0]++ && ++n <= m' > "$TMPD/files"
if [ -s "$TMPD/files" ]; then
  tr '\\n' '\\0' < "$TMPD/files" | xargs -0 grep -InHE -m 50 "$LIT" 2>/dev/null | while IFS= read -r hit; do
    file="\${hit%%:*}"; rest="\${hit#*:}"; lineno="\${rest%%:*}"; text="\${rest#*:}"
    is_comment "$text" && continue
    [ "$file" = /etc/hosts ] && continue
    cat=config
    if grep -qiE "$CONN" <<<"$text"; then cat=connection-string
    elif grep -qiE 'smtp|mailhost|mail\\.host|relayhost|mail_server' <<<"$text"; then cat=smtp
    elif grep -qiE '^[[:space:]]*(server|pool|peer)[[:space:]]' <<<"$text" && [[ "$file" =~ (chrony|ntp) ]]; then cat=time
    elif [[ "$file" =~ /etc/snmp/ ]]; then continue
    fi
    ref "$cat" "$file:$lineno" "$(printf '%s' "$text" | sed -E 's/^[[:space:]]+//')"
  done
fi
for f in /etc/tnsnames.ora /etc/oracle/tnsnames.ora \${ORACLE_HOME:+"$ORACLE_HOME/network/admin/tnsnames.ora"} \${TNS_ADMIN:+"$TNS_ADMIN/tnsnames.ora"}; do
  [ -r "$f" ] || continue
  grep -noiE 'HOST[[:space:]]*=[[:space:]]*[^)[:space:]]+' "$f" | while IFS=: read -r n text; do ref connection-string "$f:$n" "(DESCRIPTION=(ADDRESS=($text)))"; done || true
done
for f in /etc/odbc.ini /usr/local/etc/odbc.ini; do
  [ -r "$f" ] || continue
  grep -nE '^[[:space:]]*(Server|Servername|Host|Address)[[:space:]]*=' "$f" | while IFS=: read -r n text; do ref connection-string "$f:$n" "$text"; done || true
done

# ---- scheduled jobs -------------------------------------------------------------
for f in /var/spool/cron/crontabs/* /var/spool/cron/*; do
  [ -f "$f" ] && [ -r "$f" ] || continue
  owner="$(basename "$f")"
  grep -vE '^[[:space:]]*(#|$|[A-Z_]+=)' "$f" | while IFS= read -r line; do
    sched="$(awk '{ if ($1 ~ /^@/) print $1; else print $1, $2, $3, $4, $5 }' <<<"$line")"
    cmd="$(awk '{ if ($1 ~ /^@/) { $1 = "" } else { $1 = $2 = $3 = $4 = $5 = "" }; sub(/^ +/, ""); print }' <<<"$line")"
    ref scheduled-job "cron:$owner" "$cmd" "\\"schedule\\":$(js "$sched"),\\"runAs\\":$(js "$owner"),\\"scheduler\\":\\"cron\\""
  done
done
for f in /etc/crontab /etc/cron.d/*; do
  [ -f "$f" ] && [ -r "$f" ] || continue
  case "$(basename "$f")" in archtoolkit-util|e2scrub_all|anacron|0hourly|sysstat|popularity-contest|raid-check|php) continue ;; esac
  grep -vE '^[[:space:]]*(#|$|[A-Z_]+=)' "$f" | while IFS= read -r line; do
    case "$line" in *run-parts*) continue ;; esac
    sched="$(awk '{ if ($1 ~ /^@/) print $1; else print $1, $2, $3, $4, $5 }' <<<"$line")"
    user="$(awk '{ if ($1 ~ /^@/) print $2; else print $6 }' <<<"$line")"
    cmd="$(awk '{ if ($1 ~ /^@/) { $1 = $2 = "" } else { $1 = $2 = $3 = $4 = $5 = $6 = "" }; sub(/^ +/, ""); print }' <<<"$line")"
    ref scheduled-job "$f" "$cmd" "\\"schedule\\":$(js "$sched"),\\"runAs\\":$(js "$user"),\\"scheduler\\":\\"cron\\""
  done
done
for d in /etc/cron.hourly /etc/cron.daily /etc/cron.weekly /etc/cron.monthly; do
  [ -d "$d" ] || continue
  for f in "$d"/*; do
    case "$(basename "$f")" in apport|apt-compat|dpkg|logrotate|man-db|mlocate|plocate|popularity-contest|sysstat|0anacron|raid-check|rpm|makewhatis.cron|logwatch|update-notifier-common|bsdmainutils|passwd|exim4-base|cracklib-runtime|0yum*|dnf-*|e2scrub_all|.placeholder|mdadm|apt-show-versions|google-chrome) continue ;; esac
    [ -f "$f" ] && ref scheduled-job "$d" "$f" "\\"schedule\\":$(js "\${d#/etc/cron.}"),\\"runAs\\":\\"root\\",\\"scheduler\\":\\"cron\\""; done
done
if command -v systemctl >/dev/null 2>&1; then
  systemctl list-timers --all --no-legend 2>/dev/null | awk '{ for (i = 1; i <= NF; i++) if ($i ~ /\\.timer$/) { t = $i; a = $(i + 1); print t, a; break } }' \\
    | while read -r timer unit; do
        case "$timer" in systemd-*|apt-*|dnf-*|fstrim*|logrotate*|man-db*|motd-news*|e2scrub*|phpsessionclean*|archtoolkit-*|dpkg-*|apport-*|snapd.*|ua-timer*|update-notifier-*|fwupd-*|sysstat-*|mdcheck*|mdmonitor*|mlocate*|plocate*|anacron*|unbound-anchor*|raid-check*|rhsmcertd*|insights-client*|dnf-makecache*|zypper-*|btrfs-*|packagekit*) continue ;; esac
        cmd="$(systemctl show -p ExecStart --value "$unit" 2>/dev/null | sed -nE 's/.*argv\\[\\]=([^;]*);.*/\\1/p' | awk 'NR <= 1')"
        sched="$(systemctl show -p TimersCalendar --value "$timer" 2>/dev/null | sed -nE 's/.*OnCalendar=([^;]*);.*/\\1/p' | awk 'NR <= 1')"
        user="$(systemctl show -p User --value "$unit" 2>/dev/null)"
        ref scheduled-job "systemd:$timer" "\${cmd:-$unit}" "\\"schedule\\":$(js "$sched"),\\"runAs\\":$(js "\${user:-root}"),\\"scheduler\\":\\"systemd-timer\\""
      done
fi

# ---- service accounts -----------------------------------------------------------
if command -v systemctl >/dev/null 2>&1; then
  systemctl list-units --type=service --all --no-legend --plain 2>/dev/null | awk '{ print $1 }' | while read -r unit; do
    case "$unit" in user@*|systemd-*|getty@*|serial-getty@*) continue ;; esac
    user="$(systemctl show -p User --value "$unit" 2>/dev/null || true)"
    case "$user" in ''|root|nobody|systemd-*|man|uuidd|messagebus|polkitd|chrony|_chrony|ntp|syslog|dbus|avahi|colord|rtkit|geoclue|tss|sssd|nscd|postfix|dnsmasq|pulse|whoopsie|kernoops|usbmux|fwupd-refresh|_apt|landscape|[0-9]*) continue ;; esac
    ref service-account "systemd:$unit" "$user"
  done
fi
for f in /etc/sudoers /etc/sudoers.d/*; do
  [ -f "$f" ] && [ -r "$f" ] || continue
  grep -nE 'NOPASSWD' "$f" | grep -vE '^[0-9]+:[[:space:]]*#' | while IFS=: read -r n text; do ref service-account "$f:$n" "$text"; done || true
done

# ---- mounts ---------------------------------------------------------------------
if [ -r /etc/fstab ]; then
  grep -nE '^[^#].*[[:space:]](nfs4?|cifs|smb3?|glusterfs|ceph)[[:space:]]' /etc/fstab | while IFS=: read -r n text; do ref share "/etc/fstab:$n" "$text"; done || true
fi
mount -t nfs,nfs4,cifs,smb3 2>/dev/null | while IFS= read -r line; do ref share mount "$line"; done || true

# ---- printers -------------------------------------------------------------------
lpstat -v 2>/dev/null | while IFS= read -r line; do ref printer cups "$line"; done || true

# ---- SMTP relay -----------------------------------------------------------------
if command -v postconf >/dev/null 2>&1; then
  relay="$(postconf -h relayhost 2>/dev/null || true)"
  [ -n "$relay" ] && ref smtp /etc/postfix/main.cf "relayhost = $relay"
fi
[ -r /etc/mail/sendmail.cf ] && grep -nE '^DS.+' /etc/mail/sendmail.cf | while IFS=: read -r n text; do ref smtp "/etc/mail/sendmail.cf:$n" "$text"; done || true

# ---- SNMP trap targets (the community is masked) --------------------------------
if [ -r /etc/snmp/snmpd.conf ]; then
  grep -nE '^[[:space:]]*(trapsink|trap2sink|informsink)[[:space:]]' /etc/snmp/snmpd.conf | while IFS=: read -r n text; do
    ref snmp "/etc/snmp/snmpd.conf:$n" "$(awk '{ if (NF >= 3) $3 = "***"; print }' <<<"$text")"
  done || true
fi

# ---- certificates ---------------------------------------------------------------
{
  grep -rhoE '^[[:space:]]*ssl_certificate[[:space:]]+[^;]+' /etc/nginx 2>/dev/null | awk '{ print $2 }'
  grep -rhoiE '^[[:space:]]*SSLCertificateFile[[:space:]]+[^[:space:]]+' /etc/httpd /etc/apache2 2>/dev/null | awk '{ print $2 }'
  grep -rhoE '[[:space:]]crt[[:space:]]+[^[:space:]]+' /etc/haproxy 2>/dev/null | awk '{ print $2 }'
} | tr -d '"'"'"';' | sort -u | while IFS= read -r cert; do
  [ -r "$cert" ] || { ref certificate "$cert" "$cert" '"unreadable":true'; continue; }
  if command -v openssl >/dev/null 2>&1; then
    subj="$(openssl x509 -in "$cert" -noout -subject 2>/dev/null | sed 's/^subject= *//')"
    issuer="$(openssl x509 -in "$cert" -noout -issuer 2>/dev/null | sed 's/^issuer= *//')"
    end="$(openssl x509 -in "$cert" -noout -enddate 2>/dev/null | sed 's/^notAfter=//')"
    endiso="$(date -u -d "$end" +%Y-%m-%d 2>/dev/null || true)"
    sans="$(openssl x509 -in "$cert" -noout -text 2>/dev/null | awk '/Subject Alternative Name/ { getline; print }' | tr ',' '\\n' | sed -E 's/^[[:space:]]*(DNS|IP Address)://' | jarr)"
    ref certificate "$cert" "$subj" "\\"subject\\":$(js "$subj"),\\"issuer\\":$(js "$issuer"),\\"notAfter\\":$(js "$endiso"),\\"sans\\":$sans"
  else
    ref certificate "$cert" "$cert"
  fi
done

# ---- licence bindings -----------------------------------------------------------
for r in "\${roots[@]}" /usr/local; do [ -d "$r" ] && find "$r" -xdev -type f -size -1024k \\( -iname '*.lic' -o -iname 'license.dat' -o -iname 'licence.dat' \\) 2>/dev/null; done \\
  | awk '!seen[$0]++ && ++n <= 500' \\
  | while IFS= read -r f; do
      grep -nE '^[[:space:]]*(SERVER|HOST)[[:space:]]+' "$f" 2>/dev/null | while IFS=: read -r n text; do
        ref licence "$f:$n" "$text" "\\"binding\\":\\"host-id\\""
      done || true
    done
for ifc in /sys/class/net/*; do
  mac="$(cat "$ifc/address" 2>/dev/null || true)"
  case "$mac" in ''|00:00:00:00:00:00) continue ;; esac
  plain="\${mac//:/}"
  if [ -s "$TMPD/files" ]; then
    tr '\\n' '\\0' < "$TMPD/files" | xargs -0 grep -InHiE -m 5 "\${mac}|\${mac//:/-}|\${plain}" 2>/dev/null | awk 'NR <= 20' | while IFS= read -r hit; do
      file="\${hit%%:*}"; rest="\${hit#*:}"; lineno="\${rest%%:*}"; text="\${rest#*:}"
      ref licence "$file:$lineno" "$text" "\\"binding\\":\\"mac\\",\\"mac\\":$(js "$mac")"
    done || true
  fi
done

# ---- time ------------------------------------------------------------------------
tz="$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || readlink /etc/localtime 2>/dev/null | sed 's#.*/zoneinfo/##' || true)"
if command -v chronyc >/dev/null 2>&1; then
  chronyc -n sources 2>/dev/null | awk '/^\\^/ { print $2 }' | while read -r src; do ref time chrony "server $src" "\\"timezone\\":$(js "$tz")"; done || true
else
  for f in /etc/chrony.conf /etc/chrony/chrony.conf /etc/ntp.conf /etc/systemd/timesyncd.conf; do
    [ -r "$f" ] && grep -nE '^[[:space:]]*(server|pool|NTP=)' "$f" | while IFS=: read -r n text; do ref time "$f:$n" "$text" "\\"timezone\\":$(js "$tz")"; done || true
  done
fi

# ---- the file -------------------------------------------------------------------
name="$(hostname -s 2>/dev/null || uname -n)"
fqdn="$(hostname -f 2>/dev/null || true)"
v4="$(ip -o -4 addr show scope global 2>/dev/null | awk '{ split($4, a, "/"); print a[1] }' | jarr)"
v6="$(ip -o -6 addr show scope global 2>/dev/null | awk '{ split($4, a, "/"); print a[1] }' | jarr)"
macs="$(cat /sys/class/net/*/address 2>/dev/null | grep -v '^00:00:00:00:00:00$' | sort -u | jarr)"
{
  printf '{"kind":"archtoolkit.coupling","v":1,"collectedAt":"%s","server":%s,"os":"linux",' "$(date -u +%Y-%m-%d)" "$(js "$name")"
  printf '"self":{"fqdn":%s,"ipv4":%s,"ipv6":%s,"macs":%s},"refs":[' "$(js "$fqdn")" "$v4" "$v6" "$macs"
  paste -sd, "$REFS"
  printf ']}\\n'
} | if [ -n "$OUT" ]; then (umask 077; cat > "$OUT"); else cat; fi
`,
  "coupling-windows.ps1": `<#
.SYNOPSIS
  Hidden coupling on a Windows server, as an archtoolkit.coupling v1 file
  (addendum A.2.9).

.DESCRIPTION
  Finds what ties this server to others by address or name: the hosts file;
  address / FQDN / UNC / URL literals and connection strings in the
  configuration of IIS sites (Get-Website physical paths), services (their
  image folders) and Program Files (*.config, *.ini, *.json, *.xml, *.properties,
  *.env, *.yml under 1 MiB); ODBC DSNs; SQL Server client aliases;
  tnsnames.ora; scheduled tasks outside \\Microsoft\\ (actions and principal);
  service accounts (Win32_Service.StartName, IIS application pool
  identities); mapped drives (Get-SmbMapping and persistent mappings);
  printers and their ports; SMTP settings in configuration; SNMP trap
  targets; certificate bindings (netsh http show sslcert, IIS https
  bindings) and the machine's certificates (Cert:\\LocalMachine\\My: subject,
  SANs, expiry, issuer); licence files (FlexLM / RLM SERVER and HOST lines)
  and this server's MAC addresses in configuration; the time source
  (w32tm) and time zone.

  Secrets are never copied: any value of a key or connection-string part
  named like password, pwd, secret, key or token is written as ***, and so
  is the password in a URL and the SNMP community. Runs on Windows
  PowerShell 5.1 and PowerShell 7; run elevated to read every setting.

.EXAMPLE
  .\\coupling-windows.ps1 -Domains corp.example -OutFile app01-coupling.json
#>
[CmdletBinding()]
param(
  [string[]]$Domains = @(),
  [string[]]$Roots = @(),
  [int]$MaxFiles = 5000,
  # Scan only -Roots for configuration (not IIS sites, service folders, Program Files, ProgramData).
  [switch]$OnlyRoots,
  [string]$OutFile
)
$ErrorActionPreference = 'Continue'
$refs = New-Object System.Collections.Generic.List[object]
$MaxRefs = 4000

# Keep in step with coupling/import.ts maskSecrets.
function Hide-Secret([string]$Text) {
  if (-not $Text) { return $Text }
  $Text = [regex]::Replace($Text, '(?i)(key\\s*=\\s*"[^"]*(?:password|pwd|secret|token|key)[^"]*"\\s+value\\s*=\\s*")[^"]*', '$1***')
  $t = [regex]::Replace($Text,'(?i)((?:password|passwd|pwd|secret|token|[a-z0-9_.-]*key)\\s*["'']?\\s*[=:]\\s*["'']?)[^;"''\\s<>,&)]+', '$1***')
  return [regex]::Replace($t, '(?i)(://[^:/@\\s]*:)[^@/\\s]+@', '$1***@')
}

function Get-Points([string]$Line) {
  $p = New-Object System.Collections.Generic.List[string]
  foreach ($m in [regex]::Matches($Line, '(?<![0-9.])(?:[0-9]{1,3}\\.){3}[0-9]{1,3}(?![0-9.])')) { if ($m.Value -notmatch '^(127\\.|0\\.0\\.0\\.0|255\\.|169\\.254\\.)') { $p.Add($m.Value) } }
  foreach ($m in [regex]::Matches($Line, '\\\\\\\\([A-Za-z0-9._-]+)')) { $p.Add($m.Groups[1].Value) }
  foreach ($m in [regex]::Matches($Line, '(?i)[a-z][a-z0-9+.-]*://(?:[^/:@\\s]+(?::[^/@\\s]*)?@)?([^/:@\\s"''<>,;]+)')) { $p.Add($m.Groups[1].Value) }
  foreach ($m in [regex]::Matches($Line, '(?i)(?:host|server|data source|address|addr)\\s*=\\s*(?:tcp:)?([A-Za-z0-9._-]+)')) { $p.Add($m.Groups[1].Value) }
  foreach ($m in [regex]::Matches($Line, '@(?://)?([A-Za-z0-9._-]+):[0-9]+')) { $p.Add($m.Groups[1].Value) }
  foreach ($d in $Domains) { foreach ($m in [regex]::Matches($Line, '(?i)[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.' + [regex]::Escape($d))) { $p.Add($m.Value) } }
  return @($p | Sort-Object -Unique | Select-Object -First 20)
}

function Add-Ref([string]$Category, [string]$Where, [string]$Value, [hashtable]$Extra = @{}) {
  if ($refs.Count -ge $MaxRefs) { return }
  $v = Hide-Secret $Value
  if ($v.Length -gt 400) { $v = $v.Substring(0, 400) }
  $r = [ordered]@{ category = $Category; where = $Where; value = $v; points = @(Get-Points $v) }
  foreach ($k in $Extra.Keys) { $r[$k] = $Extra[$k] }
  $refs.Add($r)
}

# ---- hosts file ------------------------------------------------------------------
$hosts = Join-Path $env:SystemRoot 'System32\\drivers\\etc\\hosts'
if (Test-Path $hosts) {
  $n = 0
  foreach ($line in Get-Content $hosts) {
    $n++
    if ($line -match '^\\s*(#|$)' -or $line -match '^\\s*(127\\.|::1)') { continue }
    Add-Ref 'hosts' "hosts:$n" $line.Trim()
  }
}

# ---- configuration roots --------------------------------------------------------
$rootList = New-Object System.Collections.Generic.List[string]
foreach ($r in $Roots) { $rootList.Add($r) }
if (-not $OnlyRoots) {
try {
  Import-Module WebAdministration -ErrorAction Stop
  foreach ($site in Get-Website) { $rootList.Add([Environment]::ExpandEnvironmentVariables($site.PhysicalPath)) }
} catch { }
foreach ($svc in Get-CimInstance Win32_Service) {
  $path = [string]$svc.PathName
  if ($path -match '^"([^"]+)"' -or $path -match '^(\\S+)') {
    $dir = Split-Path -Parent $Matches[1] -ErrorAction SilentlyContinue
    if ($dir -and $dir -notmatch '^[A-Za-z]:\\\\Windows(\\\\|$)' -and (Test-Path $dir)) { $rootList.Add($dir) }
  }
}
$rootList.Add($env:ProgramFiles)
if (\${env:ProgramFiles(x86)}) { $rootList.Add(\${env:ProgramFiles(x86)}) }
$rootList.Add($env:ProgramData)
}

$include = '*.config', '*.ini', '*.json', '*.xml', '*.properties', '*.env', '*.yml', '*.yaml', '*.conf', '*.cfg', '*.udl', '*.dsn', 'tnsnames.ora', '*.lic', 'license.dat'
$files = New-Object System.Collections.Generic.List[string]
$seen = @{}
foreach ($root in ($rootList | Select-Object -Unique)) {
  if ($files.Count -ge $MaxFiles) { break }
  if (-not (Test-Path $root)) { continue }
  Get-ChildItem -Path $root -Recurse -File -Include $include -ErrorAction SilentlyContinue |
    Where-Object { $_.Length -lt 1MB -and $_.FullName -notmatch '\\\\(Microsoft\\\\Windows|WindowsApps|Windows Defender|Package Cache|Microsoft\\\\Crypto|\\.git|node_modules)\\\\' } |
    Select-Object -First ([math]::Max(0, $MaxFiles - $files.Count)) |
    ForEach-Object {
      if ($files.Count -lt $MaxFiles -and -not $seen.ContainsKey($_.FullName)) { $seen[$_.FullName] = $true; $files.Add($_.FullName) }
    }
}

$conn = 'Data Source=|Server=|jdbc:|\\(DESCRIPTION=|mongodb(\\+srv)?://|postgres(ql)?://|mysql://|mariadb://|sqlserver://|redis://|amqps?://'
$lit = '(?i)(?:[0-9]{1,3}\\.){3}[0-9]{1,3}|(?:[0-9a-fA-F]{1,4}:){3,7}[0-9a-fA-F]{1,4}|\\\\\\\\[A-Za-z0-9._-]+\\\\|[a-z][a-z0-9+.-]*://'
foreach ($d in $Domains) { $lit += '|\\.' + [regex]::Escape($d) }
$lit += '|' + $conn
foreach ($f in $files) {
  if ($f -match '\\.lic$|license\\.dat$') { continue }
  $hits = Select-String -Path $f -Pattern $lit -ErrorAction SilentlyContinue | Select-Object -First 50
  foreach ($h in $hits) {
    $text = $h.Line.Trim()
    if ($text -match '^(#|;|//|<!--|REM\\s)') { continue }
    $cat = 'config'
    if ($text -match "(?i)$conn") { $cat = 'connection-string' }
    elseif ($text -match '(?i)smtp|mailhost|mail\\.host|mailSettings|deliveryMethod') { $cat = 'smtp' }
    Add-Ref $cat ('{0}:{1}' -f $f, $h.LineNumber) $text
  }
}

# ODBC DSNs and SQL client aliases
foreach ($key in 'HKLM:\\SOFTWARE\\ODBC\\ODBC.INI', 'HKLM:\\SOFTWARE\\WOW6432Node\\ODBC\\ODBC.INI') {
  if (-not (Test-Path $key)) { continue }
  foreach ($dsn in Get-ChildItem $key -ErrorAction SilentlyContinue) {
    if ($dsn.PSChildName -eq 'ODBC Data Sources') { continue }
    $p = Get-ItemProperty $dsn.PSPath
    $parts = foreach ($name in 'Server', 'Servername', 'Host', 'Address', 'Database', 'Driver') { if ($p.PSObject.Properties[$name]) { '{0}={1}' -f $name, $p.$name } }
    if ($parts) { Add-Ref 'connection-string' ("odbc:{0}" -f $dsn.PSChildName) ($parts -join ';') }
  }
}
foreach ($key in 'HKLM:\\SOFTWARE\\Microsoft\\MSSQLServer\\Client\\ConnectTo', 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\MSSQLServer\\Client\\ConnectTo') {
  if (-not (Test-Path $key)) { continue }
  $p = Get-ItemProperty $key
  foreach ($prop in $p.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' }) {
    Add-Ref 'connection-string' ("sql-alias:{0}" -f $prop.Name) ('{0} -> {1}' -f $prop.Name, $prop.Value)
  }
}
foreach ($dir in @($env:TNS_ADMIN, $(if ($env:ORACLE_HOME) { Join-Path $env:ORACLE_HOME 'network\\admin' })) | Where-Object { $_ }) {
  $tns = Join-Path $dir 'tnsnames.ora'
  if (Test-Path $tns) {
    foreach ($h in Select-String -Path $tns -Pattern '(?i)HOST\\s*=\\s*[^)\\s]+') { Add-Ref 'connection-string' ('{0}:{1}' -f $tns, $h.LineNumber) ('(DESCRIPTION=(ADDRESS=({0})))' -f $h.Matches[0].Value) }
  }
}

# ---- scheduled tasks ------------------------------------------------------------
try {
  foreach ($task in Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskPath -notlike '\\Microsoft\\*' -and $_.TaskName -ne 'ArchToolKit utilisation' }) {
    $when = @($task.Triggers | ForEach-Object { $_.CimClass.CimClassName -replace '^MSFT_Task', '' -replace 'Trigger$', '' }) -join ', '
    foreach ($a in @($task.Actions)) {
      if (-not $a.PSObject.Properties['Execute']) { continue }
      Add-Ref 'scheduled-job' ("task:{0}{1}" -f $task.TaskPath, $task.TaskName) (('{0} {1}' -f $a.Execute, $a.Arguments).Trim()) @{ schedule = $when; runAs = [string]$task.Principal.UserId; scheduler = 'task-scheduler' }
    }
  }
} catch { }

# ---- service accounts -----------------------------------------------------------
foreach ($svc in Get-CimInstance Win32_Service) {
  $acct = [string]$svc.StartName
  if (-not $acct -or $acct -match '^(LocalSystem|NT AUTHORITY\\\\|NT SERVICE\\\\|\\.\\\\LocalSystem)') { continue }
  Add-Ref 'service-account' ("service:{0}" -f $svc.Name) $acct
}
try {
  foreach ($pool in Get-ChildItem IIS:\\AppPools -ErrorAction Stop) {
    $pm = $pool.processModel
    if ($pm.identityType -eq 'SpecificUser') { Add-Ref 'service-account' ("app-pool:{0}" -f $pool.Name) ([string]$pm.userName) }
  }
} catch { }

# ---- mapped drives --------------------------------------------------------------
try { foreach ($m in Get-SmbMapping -ErrorAction Stop) { Add-Ref 'share' ("smb-mapping:{0}" -f $m.LocalPath) ([string]$m.RemotePath) } } catch { }
foreach ($hive in Get-ChildItem 'Registry::HKEY_USERS' -ErrorAction SilentlyContinue) {
  $net = Join-Path $hive.PSPath 'Network'
  if (-not (Test-Path $net)) { continue }
  foreach ($drive in Get-ChildItem $net -ErrorAction SilentlyContinue) {
    Add-Ref 'share' ("net-use:{0}:" -f $drive.PSChildName) ([string](Get-ItemProperty $drive.PSPath).RemotePath)
  }
}

# ---- printers -------------------------------------------------------------------
try {
  $ports = @{}
  foreach ($port in Get-PrinterPort -ErrorAction Stop) { if ($port.PSObject.Properties['PrinterHostAddress'] -and $port.PrinterHostAddress) { $ports[$port.Name] = $port.PrinterHostAddress } }
  foreach ($pr in Get-Printer -ErrorAction Stop) {
    $target = if ($ports.ContainsKey($pr.PortName)) { $ports[$pr.PortName] } else { $pr.PortName }
    if ($pr.Type -eq 'Connection' -or $ports.ContainsKey($pr.PortName)) { Add-Ref 'printer' ("printer:{0}" -f $pr.Name) ('{0} -> {1}' -f $pr.Name, $target) @{ shared = [bool]$pr.Shared } }
  }
} catch { }

# ---- SNMP trap targets (the community is masked) --------------------------------
$trap = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\SNMP\\Parameters\\TrapConfiguration'
if (Test-Path $trap) {
  foreach ($community in Get-ChildItem $trap) {
    $p = Get-ItemProperty $community.PSPath
    foreach ($prop in $p.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' }) { Add-Ref 'snmp' 'snmp:TrapConfiguration' ('trap {0} community ***' -f $prop.Value) }
  }
}

# ---- certificates ---------------------------------------------------------------
$bound = @{}
$sslcert = netsh http show sslcert 2>$null
$endpoint = $null
foreach ($line in $sslcert) {
  if ($line -match '^\\s*(IP:port|Hostname:port)\\s*:\\s*(\\S+)') { $endpoint = $Matches[2] }
  elseif ($line -match '^\\s*Certificate Hash\\s*:\\s*([0-9a-fA-F]+)' -and $endpoint) { $bound[$Matches[1].ToUpper()] = @($bound[$Matches[1].ToUpper()]) + $endpoint | Where-Object { $_ } }
}
try {
  foreach ($b in Get-WebBinding -Protocol https -ErrorAction Stop) {
    if ($b.certificateHash) { $bound[$b.certificateHash.ToUpper()] = @($bound[$b.certificateHash.ToUpper()]) + ('iis:' + $b.bindingInformation) | Where-Object { $_ } }
  }
} catch { }
foreach ($c in Get-ChildItem Cert:\\LocalMachine\\My -ErrorAction SilentlyContinue) {
  $sans = @()
  try { $sans = @($c.DnsNameList | ForEach-Object { $_.Unicode }) } catch { }
  $bindings = @($bound[$c.Thumbprint.ToUpper()])
  Add-Ref 'certificate' ("cert:LocalMachine\\My\\{0}" -f $c.Thumbprint) $c.Subject @{
    subject = $c.Subject; issuer = $c.Issuer; notAfter = $c.NotAfter.ToUniversalTime().ToString('yyyy-MM-dd'); sans = $sans
    bindings = @($bindings | Where-Object { $_ }); thumbprint = $c.Thumbprint
  }
}

# ---- licence bindings -----------------------------------------------------------
foreach ($f in $files | Where-Object { $_ -match '\\.lic$|license\\.dat$' }) {
  foreach ($h in Select-String -Path $f -Pattern '^\\s*(SERVER|HOST)\\s+' -ErrorAction SilentlyContinue) { Add-Ref 'licence' ('{0}:{1}' -f $f, $h.LineNumber) $h.Line.Trim() @{ binding = 'host-id' } }
}
$macs = @(Get-CimInstance Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=True' | ForEach-Object { $_.MACAddress } | Where-Object { $_ })
foreach ($mac in $macs) {
  $plain = $mac -replace '[:-]', ''
  $pattern = '(?i)' + [regex]::Escape($mac) + '|' + [regex]::Escape(($mac -replace ':', '-')) + '|' + $plain
  foreach ($h in ($files | ForEach-Object { Select-String -Path $_ -Pattern $pattern -ErrorAction SilentlyContinue } | Select-Object -First 20)) {
    Add-Ref 'licence' ('{0}:{1}' -f $h.Path, $h.LineNumber) $h.Line.Trim() @{ binding = 'mac'; mac = $mac }
  }
}

# ---- time -----------------------------------------------------------------------
$tz = try { (Get-TimeZone).Id } catch { [string](Get-CimInstance Win32_TimeZone).StandardName }
$ntp = (w32tm /query /configuration 2>$null | Select-String '^\\s*NtpServer\\s*:\\s*(.+?)\\s*(\\(|$)' | Select-Object -First 1)
if ($ntp) { Add-Ref 'time' 'w32tm' ('NtpServer {0}' -f $ntp.Matches[0].Groups[1].Value) @{ timezone = $tz } }
else { Add-Ref 'time' 'w32tm' 'domain hierarchy (NT5DS)' @{ timezone = $tz } }

# ---- the file -------------------------------------------------------------------
$ips = @(Get-CimInstance Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=True' | ForEach-Object { $_.IPAddress } | Where-Object { $_ -and $_ -notmatch '^(fe80|169\\.254\\.)' })
$cs = Get-CimInstance Win32_ComputerSystem
$fqdn = ''
if ($cs.PartOfDomain) { $fqdn = '{0}.{1}' -f $env:COMPUTERNAME, $cs.Domain }
$self = [ordered]@{}
$self.fqdn = $fqdn
$self.ipv4 = @($ips | Where-Object { $_ -notmatch ':' } | ForEach-Object { [string]$_ })
$self.ipv6 = @($ips | Where-Object { $_ -match ':' } | ForEach-Object { [string]$_ })
$self.macs = @($macs | ForEach-Object { [string]$_ })
$doc = [ordered]@{}
$doc.kind = 'archtoolkit.coupling'
$doc.v = 1
$doc.collectedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')
$doc.server = $env:COMPUTERNAME
$doc.os = 'windows'
$doc.self = $self
$doc.refs = $refs.ToArray()
$json = $doc | ConvertTo-Json -Depth 6 -Compress
if ($OutFile) { [IO.File]::WriteAllText($OutFile, $json, (New-Object Text.UTF8Encoding $false)) } else { Write-Output $json }
exit 0
`,
  "discover-coupling.yml": `---
# discover-coupling.yml: runs the hidden-coupling collectors on every host of
# the inventory and brings one archtoolkit.coupling file per host back to
# reports/coupling/ on the controller, for the Coupling tab.
#
#   ansible-playbook -i inventory discover-coupling.yml -e '{"atk_domains": ["corp.example"]}'
#
# atk_domains: the estate's DNS suffixes (FQDN literals in these domains are
# reported); atk_roots: extra application folders to scan. Secrets are masked
# in the guest before anything leaves it. Credentials come from the inventory
# (vault variables), never from this file.
- name: Discover hidden coupling
  hosts: "{{ atk_hosts | default('all') }}"
  gather_facts: true
  gather_subset:
    - min
  vars:
    atk_domains: []
    atk_roots: []
    atk_max_files: 5000
    atk_out: "{{ playbook_dir }}/reports/coupling"
    atk_windows_dir: 'C:\\ProgramData\\ArchToolKit'
  tasks:
    - name: Create the report folder on the controller  # noqa: run-once[task]
      ansible.builtin.file:
        path: "{{ atk_out }}"
        state: directory
        mode: "0700"
      delegate_to: localhost
      run_once: true
      become: false

    - name: Run the Linux coupling collector
      ansible.builtin.script:
        cmd: >-
          coupling-linux.sh --max-files {{ atk_max_files | int }}
          {% if atk_domains | length > 0 %}--domains {{ atk_domains | join(',') | quote }}{% endif %}
          {% if atk_roots | length > 0 %}--roots {{ atk_roots | join(',') | quote }}{% endif %}
      become: true
      register: atk_linux
      changed_when: false
      when: ansible_facts['os_family'] != 'Windows'

    - name: Copy the Windows coupling collector
      ansible.windows.win_copy:
        src: coupling-windows.ps1
        dest: "{{ atk_windows_dir }}\\\\coupling-windows.ps1"
      when: ansible_facts['os_family'] == 'Windows'

    - name: Run the Windows coupling collector
      ansible.windows.win_powershell:
        script: |
          param([string[]]$Domains, [string[]]$Roots, [int]$MaxFiles, [string]$Dir)
          & (Join-Path $Dir 'coupling-windows.ps1') -Domains $Domains -Roots $Roots -MaxFiles $MaxFiles
        parameters:
          Domains: "{{ atk_domains }}"
          Roots: "{{ atk_roots }}"
          MaxFiles: "{{ atk_max_files | int }}"
          Dir: "{{ atk_windows_dir }}"
      register: atk_windows
      changed_when: false
      when: ansible_facts['os_family'] == 'Windows'

    - name: Save the Linux coupling file
      ansible.builtin.copy:
        content: "{{ atk_linux.stdout }}"
        dest: "{{ atk_out }}/{{ inventory_hostname }}.json"
        mode: "0600"
      delegate_to: localhost
      become: false
      when: ansible_facts['os_family'] != 'Windows'

    - name: Save the Windows coupling file
      ansible.builtin.copy:
        content: "{{ atk_windows.output | join('') }}"
        dest: "{{ atk_out }}/{{ inventory_hostname }}.json"
        mode: "0600"
      delegate_to: localhost
      become: false
      when: ansible_facts['os_family'] == 'Windows'
`,
});
