#!/bin/bash
# Sets up the Ansible the toolkit's Ansible tools read and check against, in
# its own Python virtual environment, kept in the toolkit's folder. Nothing
# goes in the home directory and nothing else on the system changes.
#
# In WSL it is built in WSL's scratch space (/tmp/archtoolkit-ansible), where
# Python runs at full speed, and packed into the toolkit as
# .work/ansible.tar.gz; the tools unpack it there again when WSL has been
# restarted (tools/ansible-env.sh). On Linux or macOS it is .work/ansible.
#
# On Windows, run it inside WSL (Ubuntu):   wsl -d Ubuntu-24.04 -- bash tools/setup-ansible-wsl.sh
# On Linux or macOS, run it as it is.
#
# Installs the full `ansible` package (ansible-core and ~90 collections),
# ansible-lint, and the collections the toolkit targets that the package does
# not include (oracle.oci).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_TOOL="$ROOT/tools/ansible-env.sh"
INWSL=""
grep -qi microsoft /proc/version 2>/dev/null && INWSL=1
if [ -n "$INWSL" ]; then
  VENV="$(bash "$ENV_TOOL" path)"
  # Start from the toolkit's copy, if it has one, so this is an upgrade.
  bash "$ENV_TOOL" here && bash "$ENV_TOOL" restore >/dev/null || true
else
  VENV="$ROOT/.work/ansible"
fi
mkdir -p "$VENV"
# pip's, Ansible's and the linters' caches and settings stay in the environment too.
export PIP_CACHE_DIR="$VENV/cache/pip" XDG_CACHE_HOME="$VENV/cache" XDG_CONFIG_HOME="$VENV/config" \
  ANSIBLE_HOME="$VENV/home" ANSIBLE_LOCAL_TEMP="$VENV/home/tmp" ANSIBLE_COLLECTIONS_PATH="$VENV/collections"

if [ ! -x "$VENV/bin/python3" ]; then
  # --without-pip: Ubuntu leaves ensurepip out unless python3-venv is
  # installed, which needs sudo. pip comes from PyPA's bootstrap instead.
  python3 -m venv --without-pip "$VENV"
fi
if [ ! -x "$VENV/bin/pip" ]; then
  curl -fsSL https://bootstrap.pypa.io/get-pip.py -o "$VENV/get-pip.py"
  "$VENV/bin/python3" "$VENV/get-pip.py" -q
  rm -f "$VENV/get-pip.py"
fi

"$VENV/bin/pip" install -q --upgrade ansible ansible-lint
"$VENV/bin/ansible-galaxy" collection install --upgrade -p "$VENV/collections" oracle.oci
# The VMware collections at the releases the module catalog is read from
# (Galaxy's newest). The ansible package lags them by a major line, and the
# kit's vSphere blueprints are written against the current one: community.vmware
# 7 moved modules to vmware.vmware, and vmware.vmware_rest 5 dropped the
# deprecated ones, so checking against the older bundled copies would pass
# playbooks that fail on a current install.
"$VENV/bin/ansible-galaxy" collection install --upgrade -p "$VENV/collections" \
  vmware.vmware vmware.vmware_rest community.vmware
# The network page's collections the ansible package lags on or leaves out:
# Juniper, Aruba, FMC, ASA, PAN-OS and F5 (npm run network:validate needs them).
"$VENV/bin/ansible-galaxy" collection install --upgrade -p "$VENV/collections" \
  junipernetworks.junos arubanetworks.aoscx cisco.fmcansible \
  cisco.asa paloaltonetworks.panos f5networks.f5_modules f5networks.f5_bigip

# The Data Editor's checks are compared with the real tools too
# (npm run editor:validate): cfn-lint for CloudFormation, kubeconform for
# Kubernetes manifests.
"$VENV/bin/pip" install -q --upgrade cfn-lint
if [ ! -x "$VENV/bin/kubeconform" ]; then
  # sed reads the whole reply: grep -m1 would close the pipe early, and under
  # pipefail curl's "failure writing output" would stop the script.
  KC=$(curl -fsSL https://api.github.com/repos/yannh/kubeconform/releases/latest | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p')
  curl -fsSL "https://github.com/yannh/kubeconform/releases/download/$KC/kubeconform-linux-amd64.tar.gz" | tar -xz -C "$VENV/bin" kubeconform
fi

# The Splunk page's apps are checked with Splunk's own app vetting tool
# (npm run splunk:validate): Splunk AppInspect.
"$VENV/bin/pip" install -q --upgrade splunk-appinspect

# What is installed, kept in the toolkit, so update.bat reruns the checks
# when any of it changes.
VERSIONS="$ROOT/.work/ansible-versions.txt"
{ "$VENV/bin/pip" freeze; "$VENV/bin/ansible-galaxy" collection list -p "$VENV/collections" 2>/dev/null | grep -E '^[a-z0-9_]+\.[a-z0-9_]+ '; } > "$VENV/versions.txt"

"$VENV/bin/ansible" --version | head -1
if [ -n "$INWSL" ]; then
  # Pack it into the toolkit when something changed (or it is not there yet).
  if ! bash "$ENV_TOOL" here || ! cmp -s "$VENV/versions.txt" "$VERSIONS"; then
    bash "$ENV_TOOL" save
  fi
fi
cp "$VENV/versions.txt" "$VERSIONS"
echo "Ansible is in $VENV"
