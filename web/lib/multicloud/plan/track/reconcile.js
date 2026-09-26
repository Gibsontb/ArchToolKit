/**
 * Reconcile the tracker with a newer estate import (addendum A.8.6): what the
 * estate says now against where the tracker says each item is.
 *
 * | Finding | Condition |
 * |---|---|
 * | `track.reconcile.source-still-on` (error) | at or after `cut-over`, and the source VM is powered on |
 * | `track.reconcile.decom-still-present` | `decommissioned`, and the VM is still in the inventory |
 * | `track.reconcile.missing-source` | before `cut-over`, and the VM is not in the inventory |
 * | `track.reconcile.new-vm` | a workload VM in the estate that is not in the plan (suggests Add to plan) |
 * | `track.reconcile.hosts-free` | a host with no VMs whose planned VMs were all decommissioned (suggests a DecomRecord host entry) |
 *
 * A workload is matched to a VM by its `sourceKey` (vCenter and name), then by
 * name, case-insensitive. Only estate-sourced workloads (with a `sourceKey`,
 * or `origin` vSphere / unset and `source: 'estate'`) are expected in the
 * inventory. Each finding's `path` is the item id (the VM or host name for the
 * last two).
 */

                                                         
import { currentEstate } from '../../../kit/estate-store.js';
import { isWorkload, scopedKey,                                  } from '../../../vmware/inventory.js';
import { ITEM_STATE_RANK } from '../options.js';
                                                           

/** Reconcile against `inventory`, or the estate the page has loaded (`currentEstate()`); [] when there is neither. */
export function reconcileEstate(tracker         , plan      , inventory                        = currentEstate()?.inventory)            {
  if (!inventory) return [];
  const byKey = new Map                     ();
  const byName = new Map                     ();
  for (const vm of inventory.vms) {
    if (!isWorkload(vm)) continue;
    byKey.set(scopedKey(vm.vcenter, vm.name).toLowerCase(), vm);
    if (!byName.has(vm.name.toLowerCase())) byName.set(vm.name.toLowerCase(), vm);
  }
  const find = (w          )                          =>
    (w.sourceKey ? byKey.get(w.sourceKey.toLowerCase()) : undefined) ?? byName.get(w.name.toLowerCase());
  const fromEstate = (w          )          => !!w.sourceKey || (w.source === 'estate' && (!w.origin || w.origin === 'vsphere'));

  const out            = [];
  const matched = new Set             ();
  for (const w of plan.workloads) {
    const vm = find(w);
    if (vm) matched.add(vm);
    const s = tracker.items[w.id];
    if (!s || s.removed || !fromEstate(w)) continue;
    const rank = ITEM_STATE_RANK[s.state];
    if (s.state === 'decommissioned') {
      if (vm) {
        out.push({
          code: 'track.reconcile.decom-still-present', severity: 'warning', path: w.id,
          message: `${w.name} is decommissioned in the tracker but is still in the estate (${vm.powerState}).`,
          remediation: 'Delete the source VM, or correct the tracker with a manual transition.',
        });
      }
    } else if (rank >= ITEM_STATE_RANK['cut-over']) {
      if (vm?.powerState === 'poweredOn') {
        out.push({
          code: 'track.reconcile.source-still-on', severity: 'error', path: w.id,
          message: `${w.name} is ${s.state} in the tracker, but its source VM is powered on.`,
          remediation: 'Power the source off (it is the rollback point, kept powered off), or roll the item back if the target is not serving.',
        });
      }
    } else if (!vm && s.path !== 'retire') {
      out.push({
        code: 'track.reconcile.missing-source', severity: 'warning', path: w.id,
        message: `${w.name} is ${s.state} in the tracker, but its VM is not in the newer estate.`,
        remediation: 'Find out whether it was moved, renamed or deleted outside the plan.',
      });
    }
  }

  for (const vm of inventory.vms) {
    if (!isWorkload(vm) || matched.has(vm)) continue;
    out.push({
      code: 'track.reconcile.new-vm', severity: 'info', path: vm.name,
      message: `${vm.name} is in the estate but not in the plan.`,
      remediation: 'Add to plan, or record why it stays.',
    });
  }

  const occupied = new Set(inventory.vms.filter((v) => v.host).map((v) => (v.host          ).toLowerCase()));
  const planned = new Map                    ();
  for (const w of plan.workloads) {
    const host = w.sourceRef?.host;
    if (host) planned.set(host.toLowerCase(), [...(planned.get(host.toLowerCase()) ?? []), w]);
  }
  for (const h of inventory.hosts) {
    const key = h.name.toLowerCase();
    const was = planned.get(key) ?? [];
    if (occupied.has(key) || !was.length) continue;
    if (was.every((w) => tracker.items[w.id]?.state === 'decommissioned')) {
      out.push({
        code: 'track.reconcile.hosts-free', severity: 'info', path: h.name,
        message: `${h.name} has no VMs left; its ${was.length} planned VM${was.length === 1 ? ' was' : 's were'} decommissioned.`,
        remediation: 'Record the freed host on the decommission record.',
      });
    }
  }
  return out;
}
