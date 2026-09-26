#!/bin/bash
# Sets up the Ansible the toolkit's Ansible tools read and check against, in
# its own Python virtual environment: ~/archtoolkit-ansible. Nothing else on
# the system changes; deleting that folder removes it all.
#
# On Windows, run it inside WSL (Ubuntu):   wsl -d Ubuntu-24.04 -- bash tools/setup-ansible-wsl.sh
# On Linux or macOS, run it as it is.
#
# Installs the full `ansible` package (ansible-core and ~90 collections),
# ansible-lint, and the collections the toolkit targets that the package does
# not include (oracle.oci).
set -euo pipefail

VENV="${ARCHTOOLKIT_ANSIBLE_VENV:-$HOME/archtoolkit-ansible}"

if [ ! -x "$VENV/bin/python3" ]; then
  # --without-pip: Ubuntu leaves ensurepip out unless python3-venv is
  # installed, which needs sudo. pip comes from PyPA's bootstrap instead.
  python3 -m venv --without-pip "$VENV"
fi
if [ ! -x "$VENV/bin/pip" ]; then
  curl -fsSL https://bootstrap.pypa.io/get-pip.py -o /tmp/get-pip.py
  "$VENV/bin/python3" /tmp/get-pip.py -q
fi

"$VENV/bin/pip" install -q --upgrade ansible ansible-lint
"$VENV/bin/ansible-galaxy" collection install --upgrade -p "$VENV/collections" oracle.oci
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
  KC=$(curl -fsSL https://api.github.com/repos/yannh/kubeconform/releases/latest | grep -m1 '"tag_name"' | cut -d'"' -f4)
  curl -fsSL "https://github.com/yannh/kubeconform/releases/download/$KC/kubeconform-linux-amd64.tar.gz" | tar -xz -C "$VENV/bin" kubeconform
fi

"$VENV/bin/ansible" --version | head -1
echo "Ansible is in $VENV"
