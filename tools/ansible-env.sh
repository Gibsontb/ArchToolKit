#!/bin/bash
# The Ansible environment, kept in the toolkit and run from WSL's own disk.
#
# The toolkit holds it as one file, .work/ansible.tar.gz, so the folder is
# still the only place anything lives and can be carried anywhere whole.
# Python reads a Windows drive slowly from WSL (the checks ran 3.5 times
# slower from E:), so it is unpacked to WSL's scratch space and run from
# there. /tmp is emptied when WSL restarts; the next run unpacks it again.
#
#   bash tools/ansible-env.sh restore   unpack if missing or out of date; prints the path
#   bash tools/ansible-env.sh save      pack the scratch copy back into the toolkit
#   bash tools/ansible-env.sh path      the scratch path, without unpacking
#   bash tools/ansible-env.sh here      exit 0 if this WSL distro is the one that built it
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACK="$ROOT/.work/ansible.tar.gz"
DISTRO_FILE="$ROOT/.work/ansible.distro"
RUN="/tmp/archtoolkit-ansible"

case "${1:-}" in
  path)
    echo "$RUN"
    ;;
  here)
    # The environment's Python links to this distro's own; another distro
    # can see the pack on the shared drive but could not run it.
    [ -f "$DISTRO_FILE" ] && [ "$(cat "$DISTRO_FILE")" = "${WSL_DISTRO_NAME:-}" ] && [ -f "$PACK" ]
    ;;
  restore)
    [ -f "$PACK" ] || { echo "No Ansible environment in the toolkit yet: run tools/setup-ansible-wsl.sh" >&2; exit 1; }
    stamp="$(stat -c %Y "$PACK")"
    if [ ! -x "$RUN/bin/python3" ] || [ "$(cat "$RUN/.packed" 2>/dev/null)" != "$stamp" ]; then
      echo "Unpacking the Ansible environment to $RUN..." >&2
      rm -rf "$RUN" && mkdir -p "$RUN"
      tar -xzf "$PACK" -C "$RUN"
      echo "$stamp" > "$RUN/.packed"
    fi
    echo "$RUN"
    ;;
  save)
    mkdir -p "$ROOT/.work"
    tar -czf "$PACK.part" -C "$RUN" --exclude=./cache --exclude=./home/tmp --exclude=./.packed .
    mv -f "$PACK.part" "$PACK"
    stat -c %Y "$PACK" > "$RUN/.packed"
    echo "${WSL_DISTRO_NAME:-}" > "$DISTRO_FILE"
    echo "Packed into $PACK ($(du -h "$PACK" | cut -f1))" >&2
    ;;
  *)
    echo "usage: ansible-env.sh restore|save|path|here" >&2
    exit 2
    ;;
esac
