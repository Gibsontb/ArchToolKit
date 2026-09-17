# VMware → Inventory Import (PowerCLI CSV Set)

This folder adds a **canonical PowerCLI CSV export pack** + a browser-based importer page that normalizes the CSV set into a single **inventory.json** object for reuse across the toolkit.

## 1) Export the CSV set

Run:

```powershell
pwsh .\vmware\powercli\Export-PowerCLICsvSet.ps1 -vCenter "vcenter01.domain.local" -OutRoot ".\exports"
```

It writes a timestamped folder:

```
exports\powercli-csvset-YYYYMMDD-HHMMSS\
  vcenters.csv
  datacenters.csv
  clusters.csv
  hosts.csv
  resource_pools.csv
  folders.csv
  datastores.csv
  datastore_clusters.csv
  dvswitches.csv
  dvportgroups.csv
  net_portgroups.csv
  host_vmkernels.csv
  host_pnics.csv
  host_vswitches.csv
  vms.csv
  vm_guest.csv
  vm_disks.csv
  vm_nics.csv
  vm_cdroms.csv
  vm_floppies.csv
  vm_serial_ports.csv
  vm_usb_devices.csv
  vm_snapshots.csv
  vm_rdms.csv
  vm_extra_config.csv
  tags.csv
  tag_assignments.csv
  custom_attributes.csv
  custom_attribute_values.csv
  permissions.csv
```

## 2) Normalize into inventory.json

Open:

- `vmware-inventory-import.html`

Then:
1) **Upload all CSVs** from the export folder (multi-select)
2) Click **Build Inventory JSON**
3) Click **Download inventory.json** (and/or **Save to Toolkit Storage**)

## Notes / common gaps

- `vm_guest.csv` (IPs/OS) depends on VMware Tools. Blank fields are normal.
- Tags + custom attributes are the usual source for `env`, `app`, `owner`, `criticality`.
- For joins, the importer uses Id/MoRef fields (e.g., `VmId`, `HostId`) instead of names.

