I have comprehensive ground truth. Here is the report.

---

# VCF 9.1.x Ground Truth Report — Deployment Spec Schema, Sizing, Deployment Paths, Inventory Collection

**Research date:** 2026-09-17 · **Target:** VCF 9.1.x (API reference served as **9.1.1 (Latest)**)

## Verification legend

| Tag | Meaning |
|---|---|
| **[V-API]** | Verified from the official VCF Installer API reference on developer.broadcom.com |
| **[V-DOC]** | Verified from official Broadcom TechDocs or a Broadcom KB article |
| **[V-SPEC]** | Verified from a real, complete, working 9.1.0.0 spec file (William Lam's `vcf-91-in-box`) |
| **[C]** | Community / unofficial source — treat as indicative, not authoritative |
| **[I]** | Inferred by me — not directly stated anywhere I found |

---

# 1. VCF 9.1 Deployment Spec JSON Schema

## 1.1 What it is actually called

**The 9.1 bring-up input JSON is still called `SddcSpec`.** **[V-API]**

VCF 9 replaced Cloud Builder with the **VCF Installer appliance**, but the top-level request body type name did *not* change. Confirmed:

- **Endpoint:** `POST /v1/sddcs` — "Start VCF installation", request body type **`SddcSpec`** **[V-API]**
- **UI path:** the VCF Installer wizard exposes a **"DEPLOY USING JSON SPEC"** option that takes this file **[V-SPEC]** (repo instructions)
- There is **no separate "InstallerSpec"/"BringupSpec" type** in 9.1.

> **Note:** `SddcInstallerRequest` and `SddcNetworkConfigProfileSpec` also exist as sibling types that embed `SddcHostSpec`, but the deployment body is `SddcSpec`. **[V-API]**

## 1.2 VCF Installer API surface (`/v1/sddcs`) **[V-API]**

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/sddcs` | **Start VCF installation** (body = `SddcSpec`) |
| GET | `/v1/sddcs` | Retrieve all VCF installation tasks |
| GET | `/v1/sddcs/{id}` | Retrieve task by ID |
| PATCH | `/v1/sddcs/{id}` | Retry failed installation |
| GET | `/v1/sddcs/{id}/spec` | **Retrieve the input specification of a task** |
| GET | `/v1/sddcs/latest` | Latest installation task |
| POST | `/v1/sddcs/validations` | **Perform specification validation** |
| GET | `/v1/sddcs/validations` , `/{id}` , `/latest` | Retrieve validation results |
| POST | `/v1/sddcs/resources-calculation` | **Calculate required infrastructure resources** ← sizing engine |
| GET | `/v1/sddcs/resources-calculation/{id}` | Retrieve resource calculation results |
| POST | `/v1/sddcs/network-config-profiles` | Get network profiles |
| POST | `/v1/sddcs/installer-mode` | Get VCF Installer appliance mode |
| POST | `/v1/sddcs/vcenter-discovery` | Discover existing vCenter topology (brownfield) |
| POST | `/v1/sddcs/vcenter-discovery/networks` | Discover existing vCenter networks |
| POST | `/v1/sddcs/vcfops-discovery` | Discover existing VCF Operations topology |
| POST | `/v1/sddcs/sddcm-discovery` | Discover existing SDDC Manager topology |

**This is the single most important finding for your tool:** `POST /v1/sddcs/resources-calculation` takes the *same* `SddcSpec` body and returns a `CapacityValidation` with required vs. available capacity. **Your sizing calculator can defer to the product's own math rather than reimplementing it.** **[V-API]**

Other API categories on the Installer appliance: Bundles, Ceip, Depot Settings, Flexible Product Patches, Proxy Configuration, Releases, System, Tasks, Tokens, Trusted Certificates, Vcf Installer, Vcf Services. **[V-API]**

## 1.3 `SddcSpec` top-level keys (complete) **[V-API]**

| Key | Type | Req? | Notes |
|---|---|---|---|
| `sddcId` | string | **Yes** | 3–20 chars, alphanumeric + hyphens |
| `vcenterSpec` | `SddcVcenterSpec` | **Yes** | |
| `networkSpecs` | array\<`SddcNetworkSpec`\> | **Yes** | |
| `dnsSpec` | `DnsSpec` | **Yes** | |
| `workflowType` | string enum | No | `VCF`, `VCF_COMPLETE`, `VCF_EXTEND`, `VVF`, `VCF_BOOTSTRAP` |
| `vcfInstanceName` | string | No | 1–300 chars |
| `version` | string | No | e.g. `"9.1.0.0"` |
| `hostSpecs` | array\<`SddcHostSpec`\> | No | |
| `clusterSpec` | `SddcClusterSpec` | No | |
| `dvsSpecs` | array\<`DvsSpec`\> | No | |
| `nsxtSpec` | `SddcNsxtSpec` | No | |
| `ntpServers` | array\<string\> | No | |
| `sddcManagerSpec` | `SddcManagerSpec` | No | |
| `managementPoolName` | string | No | Network pool name |
| `ceipEnabled` | boolean | No | |
| `skipEsxThumbprintValidation` | boolean | No | |
| `skipGatewayPingValidation` | boolean | No | |
| `securitySpec` | `SecuritySpec` | No | |
| `datastoreSpec` | `SddcDatastoreSpec` | No | |
| `vspClusterSpec` | `SddcVspClusterSpec` | No | **vSphere Supervisor cluster** |
| `fleetLcmSpec` | `FleetLcmServiceSpec` | No | |
| `sddcLcmSpec` | `SddcLcmServiceSpec` | No | |
| `fleetDepotSpec` | `FleetDepotServiceSpec` | No | |
| `telemetryAcceptorSpec` | `TelemetryAcceptorSpec` | No | |
| `vidbSpec` | `VidbSpec` | No | **VCF Identity Broker** |
| `saltSpec` | `SaltSpec` | No | |
| `saltRaasSpec` | `SaltRaasSpec` | No | |
| `vcfOperationsSpec` | `VcfOperationsSpec` | No | |
| `vcfOperationsCollectorSpec` | `VcfOperationsCollectorSpec` | No | |
| `vcfAutomationSpec` | `VcfAutomationSpec` | No | |
| `vcfManagementComponentsInfrastructureSpec` | `VcfManagementComponentsInfrastructureSpec` | No | |
| `licenseServerSpec` | `LicenseServerSpec` | No | |

**Removed in 9.1:** `vcfOperationsFleetManagementSpec` was a **VCF 9.0 field that no longer exists in 9.1**. Justin Raley's validator explicitly rejects it with the message *"Removed 9.0 field vcfOperationsFleetManagementSpec…"*. Corroborated by KB 440630: *"VCF Fleet Management Appliance is no longer available in 9.1."* **[V-SPEC + V-DOC]** — **your builder must not emit this key for 9.1.**

## 1.4 Nested object schemas (exact field names) **[V-API]**

### `DnsSpec`
```
subdomain    (string, REQUIRED)  "Tenant Sub domain. Includes the full domain suffix"
nameservers  (array<string>)     first = primary; MAX 2 entries
```

### `SddcNetworkSpec` (array member of `networkSpecs`)
```
networkType              (string, REQUIRED)  VSAN | VMOTION | MANAGEMENT | VM_MANAGEMENT |
                                             NFS | FLEET_MANAGEMENT | <custom>
vlanId                   (int32,  REQUIRED)
subnet                   (string)  7-18 chars
gateway                  (string)  7-15 chars
subnetMask               (string)  7-15 chars
mtu                      (int32)
includeIpAddress         (array<string>)
includeIpAddressRanges   (array<IpRange>)     { startIpAddress, endIpAddress }
teamingPolicy            (enum)    loadbalance_ip | loadbalance_srcmac | loadbalance_srcid |
                                   failover_explicit | loadbalance_loadbased  (default: loadbalance_loadbased)
activeUplinks            (array<string>)
standbyUplinks           (array<string>)
portGroupKey             (string)  0-80 chars; autogenerated if null
ipAddressVersion         (enum)    IPv4 | IPv6   (default IPv4)
ipAddressAssignmentMode  (enum)    STATIC | DHCP | SLAAC  (default STATIC)
```
> `FLEET_MANAGEMENT` as a `networkType` is new relative to VCF 5.x and is how the separate VCF management network is expressed. **[V-API]**

### `SddcVcenterSpec`
```
vcenterHostname      (string, REQUIRED)  0-63
rootVcenterPassword  (string, REQUIRED)  new deploy: 15-20 chars; brownfield conversion: 8-20
vmSize               (enum)  tiny | small | medium | large | xlarge
storageSize          (enum)  lstorage | xlstorage
ssoDomain            (string)
adminUserSsoUsername (string)  defaults to "administrator"
adminUserSsoPassword (string)
version              (string)
useExistingDeployment(boolean)
sslThumbprint        (string)  SHA256; required when useExistingDeployment
```

### `SddcHostSpec`
```
hostname      (string, REQUIRED)  short name only — prefixed to dnsSpec.subdomain; RFC1123; 0-63
credentials   (SddcCredentials)   { username, password }
sshThumbprint (string)  RSA SHA256 (new deploy) / SSH key RSA|ECDSA (reuse existing)
sslThumbprint (string)  SHA256
```

### `SddcClusterSpec`
```
datacenterName    (string)  auto-generated if blank
clusterName       (string)  auto-generated if blank
clusterEvcMode    (enum)  INTEL_MEROM … INTEL_SAPPHIRERAPIDS, AMD_REV_E … AMD_ZEN4
resourcePoolSpecs (array<ResourcePoolSpec>)
```

### `DvsSpec` (array member of `dvsSpecs`)
```
dvsName          (string)  ≤80, auto-generated if blank
networks         (array<string>)  same enum as networkType
mtu              (int32)  DEFAULT 9000
nsxtSwitchConfig (NsxtSwitchConfig)
vmnicsToUplinks  (array<VmnicToUplink>, REQUIRED)  { id: "vmnic0", uplink: "uplink1" }
nsxTeamings      (array<TeamingSpec>)  0-1 items
lagSpecs         (array<LagSpec>)
```

**`NsxtSwitchConfig`**
```
transportZones           (array<TransportZone>)  { name, transportType: OVERLAY|VLAN }
hostSwitchOperationalMode(enum)  STANDARD | ENS | ENS_INTERRUPT   (VI WLD only per docs)
ipAssignmentType         (string)
```

**`TeamingSpec`**
```
policy         (enum, REQUIRED)  FAILOVER_ORDER | LOADBALANCE_SRCID | LOADBALANCE_SRC_MAC
activeUplinks  (array<string>, REQUIRED, min 1)
standByUplinks (array<string>)     <-- note capital "B"
```

**`LagSpec`**
```
name             (string, REQUIRED)  ≤16
uplinksCount     (int32,  REQUIRED)
lacpMode         (enum,   REQUIRED)  ACTIVE | PASSIVE
lacpTimeoutMode  (enum,   REQUIRED)  SLOW | FAST
loadBalancingMode(enum,   REQUIRED)  SOURCE_MAC | DESTINATION_MAC | SOURCE_AND_DESTINATION_MAC |
    DESTINATION_IP_AND_VLAN | SOURCE_IP_AND_VLAN | SOURCE_AND_DESTINATION_IP_AND_VLAN |
    DESTINATION_TCP_UDP_PORT | SOURCE_TCP_UDP_PORT | SOURCE_AND_DESTINATION_TCP_UDP_PORT |
    DESTINATION_IP_AND_TCP_UDP_PORT | SOURCE_IP_AND_TCP_UDP_PORT |
    SOURCE_AND_DESTINATION_IP_AND_TCP_UDP_PORT | DESTINATION_IP_AND_TCP_UDP_PORT_AND_VLAN |
    SOURCE_IP_AND_TCP_UDP_PORT_AND_VLAN | SOURCE_AND_DESTINATION_IP_AND_TCP_UDP_PORT_AND_VLAN |
    DESTINATION_IP | SOURCE_IP | SOURCE_AND_DESTINATION_IP | VLAN | SOURCE_PORT_ID
```
> LACP in the **UI** is new in 9.1 (previously API-only). **[V-DOC]**

### `SddcNsxtSpec`
```
nsxtManagers        (array<NsxtManagerSpec>, REQUIRED)   NsxtManagerSpec = { hostname }
vipFqdn             (string, REQUIRED)
nsxtManagerSize     (enum)  medium | large | xlarge   (default medium)  <-- NO "small" here
rootNsxtManagerPassword (string, min 12)
nsxtAdminPassword       (string, min 12)
nsxtAuditPassword       (string, min 12)
transportVlanId     (int32)  default 0
ipAddressPoolSpec   (IpAddressPoolSpec)   <-- Host TEP pool
vpcSpec             (VpcSpec)
skipNsxOverlayOverManagementNetwork (boolean)
enableEdgeClusterSync (boolean)   only when importing existing NSX
version             (string)
useExistingDeployment (boolean)
sslThumbprint       (string)
```

**`IpAddressPoolSpec`** (Host TEP)
```
name        (string, REQUIRED)  pattern ^[a-zA-Z0-9-_]+$
description (string)
ignoreUnavailableNsxtCluster (boolean)
subnets     (array<IpAddressPoolSubnetSpec>)
   └ cidr, gateway, ipAddressPoolRanges: [ { start, end } ]    <-- NOTE: "start"/"end",
                                                                   NOT startIpAddress/endIpAddress
```
> **Gotcha for your builder:** `IpAddressPoolRangeSpec` uses `start`/`end`, while `IpRange` (used in `networkSpecs.includeIpAddressRanges` and `IPv4Pool.ipRange`) uses `startIpAddress`/`endIpAddress`. Two different range shapes in one document. **[V-API + V-SPEC]**

**`VpcSpec`**
```
vpcNetworkConfigurationType (enum)  VLAN_BACKED_VPC | FULL_STACK_VPC | VPC_UNSUPPORTED |
                                    INVALID_TYPE   (default FULL_STACK_VPC)
dtgwSpec (DtgwSpec)  = { vlan (int), gatewayCidr, externalIpBlockCidr, privateTgwIpBlockCidr }
```

### `SddcDatastoreSpec`
```
vsanSpec             (VsanSpec)
nfsDatastoreSpec     (NfsDatastoreSpec)   { datastoreName, nasVolume: { serverName[], path,
                                             readOnly, userTag, enableBindToVmknic } }
vmfsDatastoreSpec    (VmfsDatastoreSpec)  { fcSpec: [ { datastoreName } ] }
existingDatastoreName(string)   for converting legacy environments
```

**`VsanSpec`**
```
datastoreName      (string)  ≤80, auto-generated if blank
vsanDedup          (boolean)  dedup+compression (single flag, OSA only)
failuresToTolerate (int32)  min 0, max 3
esaConfig          (VsanEsaConfig) = { enabled (bool), skipHclAutoDiskClaim (bool) }
encryptionConfig   (EncryptionConfig) = { dataInTransitConfig: { enable, rekeyInterval } }
```
> API doc lists `failuresToTolerate` **default 3** in one rendering and min0/max3 in another — see UNVERIFIED §5. Lam's working spec uses `1`. **[V-API / V-SPEC conflict]**

### `SddcManagerSpec`
```
hostname            (string, REQUIRED)  ≤63
rootPassword        (string)  min 15, needs upper/lower/digit/special [!%@$^#?*]
sshPassword         (string)  min 15  — the 'vcf' user
localUserPassword   (string)  min 12  — built-in admin account
version             (string)
useExistingDeployment (boolean)
sslThumbprint       (string)
```

### `SecuritySpec`
```
esxiCertsMode (enum)  Custom | VMCA
rootCaCerts   (array<RootCaCerts>)  { alias, certChain: [string] }
```

## 1.5 VCF 9.x-specific components

### `VcfOperationsSpec`
```
nodes            (array<VcfOperationsNode>, REQUIRED, 1-3)
                    VcfOperationsNode = { hostname (REQ), rootUserPassword (min 15),
                                          type: master|replica|data, sslThumbprint }
adminUserPassword(string, min 8)
applianceSize    (enum)  Simple model: xsmall | small | medium | large | xlarge
                         HA model:     small | medium | large | xlarge    (default medium)
loadBalancerFqdn (string)
useExistingDeployment (boolean)   <-- set true for a SECONDARY VCF instance in an existing fleet
version          (string)
```

### `VcfOperationsCollectorSpec` (the Cloud Proxy)
```
hostname         (string, REQUIRED)
rootUserPassword (string, min 15)
applianceSize    (enum)  small | standard     (default small)
version, useExistingDeployment, sslThumbprint
```

### `VcfAutomationSpec`
```
hostname            (string, REQUIRED)
internalClusterCidr (string, REQUIRED)  must be globally unique
platformFqdn        (string)  required unless useExistingDeployment
adminUserPassword   (string)  min 15
ipPool              (array<string>)
nodePrefix          (string)  0-57, lowercase alnum + hyphens, must start/end alphanumeric
size                (string)
version, useExistingDeployment, sslThumbprint
```

### `SddcVspClusterSpec` — **vSphere Supervisor / VCF Management Services runtime**
```
platformFqdn            (string, REQUIRED)  short name ≤63
instanceFqdn            (string, REQUIRED)
fleetFqdn               (string)  provide for VVF and the PRIMARY VCF instance;
                                  OMIT when building a secondary instance
ipv4Pool                (IPv4Pool, REQUIRED)
ipv6Pool                (IPv6Pool)
systemUserPassword      (string)  min 15 — vmware-system-user + admin@vsp.local
size                    (string)  small | small_ha | medium | large
                                  (small_ha = management VSP cluster ONLY, not consumption/Automation)
internalClusterCidrIpv4 (string)  ONLY: 198.18.0.0/15 | 240.0.0.0/15 | 250.0.0.0/15
internalClusterCidrIpv6 (string)  ONLY: fd00::/111 | fd00::0/111 | fc00::/111 |
                                        fc00::0/111 | fc00::4:0/111 | fc00::0004:0/111
version, useExistingDeployment, sslThumbprint
```

**`IPv4Pool`** — one of `cidr` / `ipRange` / `addresses` is required
```
cidr              (string)
ipRange           (IpRange)  { startIpAddress, endIpAddress }
addresses         (array<string>)
excludedAddresses (array<string>)   applies to range and CIDR only
```
> Non-contiguous allocation via `addresses`/`excludedAddresses` is **new in 9.1** (and `9.1.0.400+` for the UI). **[V-DOC]**

### Fleet/LCM/service specs
```
fleetLcmSpec        → FleetLcmServiceSpec    { version, size }
sddcLcmSpec         → SddcLcmServiceSpec     { version, size }
fleetDepotSpec      → FleetDepotServiceSpec
telemetryAcceptorSpec → TelemetryAcceptorSpec
saltSpec            → SaltSpec
saltRaasSpec        → SaltRaasSpec
vidbSpec            → VidbSpec  { hostname (REQUIRED), version, size }   <-- VCF Identity Broker
licenseServerSpec   → LicenseServerSpec { hostname (REQUIRED), version,
                                          useExistingDeployment, sslThumbprint }
```

### `VcfManagementComponentsInfrastructureSpec`
```
localRegionNetwork (VcfManagementComponentsNetworkSpec)
xRegionNetwork     (VcfManagementComponentsNetworkSpec)
   └ { networkName, subnetMask, gateway, ipv6Gateway, ipv6Prefix }
```

## 1.6 A real, complete, working 9.1.0.0 `SddcSpec` **[V-SPEC]**

From `lamw/vcf-91-in-box` → `config/three-node-vsan-esa.json`. This is the highest-fidelity artifact found — verbatim key structure (values redacted/abbreviated):

```json
{
  "version": "9.1.0.0",
  "vcfInstanceName": "William Lam VCF 9.1 Instance",
  "sddcId": "vcf-m01",
  "ceipEnabled": true,
  "skipEsxThumbprintValidation": true,
  "workflowType": "VCF",
  "dnsSpec": { "subdomain": "vcf.lab", "nameservers": ["192.168.30.29"] },
  "ntpServers": ["96.19.94.82"],
  "hostSpecs": [
    { "hostname": "esx01.vcf.lab", "credentials": { "username": "root", "password": "…" } },
    … x3 ],
  "networkSpecs": [
    { "networkType": "MANAGEMENT",    "ipAddressVersion": "IPv4",
      "subnet": "172.30.0.0/24",  "gateway": "172.30.0.1",  "vlanId": "30",
      "activeUplinks": ["uplink1"], "portGroupKey": "DVPG_FOR_MANAGEMENT",
      "standbyUplinks": [], "teamingPolicy": "loadbalance_loadbased" },
    { "networkType": "VM_MANAGEMENT", … same VLAN 30, portGroupKey "DVPG_FOR_VM_MANAGEMENT" },
    { "networkType": "VMOTION", "subnet": "172.30.40.0/24", "vlanId": "40", "mtu": 9000,
      "includeIpAddressRanges": [{ "startIpAddress": "172.30.40.10",
                                   "endIpAddress": "172.30.40.20" }], … },
    { "networkType": "VSAN",    "subnet": "172.30.50.0/24", "vlanId": "50", "mtu": 9000,
      "includeIpAddressRanges": [{ "startIpAddress": "172.30.50.2",
                                   "endIpAddress": "172.30.50.4" }], … }
  ],
  "vspClusterSpec": {
    "ipv4Pool": { "ipRange": { "startIpAddress": "172.30.0.33",
                               "endIpAddress": "172.30.0.46" } },
    "platformFqdn": "vcf-msr01.vcf.lab",
    "instanceFqdn": "vcf-int01.vcf.lab",
    "fleetFqdn":    "vcf-flt01.vcf.lab",
    "systemUserPassword": "…",
    "size": "small",
    "name": "vcf-m01-vmsp-01",
    "internalClusterCidrIpv4": "198.18.0.0/15"
  },
  "vcfAutomationSpec": {
    "ipPool": ["172.30.0.65", … 6 addresses …],
    "hostname": "auto01.vcf.lab",
    "platformFqdn": "vcf-asr01.vcf.lab",
    "adminUserPassword": "…",
    "nodePrefix": "vcf-m01-node-01",
    "internalClusterCidr": "198.18.0.0/15",
    "useExistingDeployment": false,
    "size": "small"
  },
  "nsxtSpec": {
    "transportVlanId": "60",
    "ipAddressPoolSpec": {
      "name": "vcf-m01-cl01-tep01",
      "description": "ESXi Host Overlay TEP IP Pool",
      "subnets": [ { "cidr": "172.30.60.0/24", "gateway": "172.30.60.1",
                     "ipAddressPoolRanges": [ { "start": "172.30.60.10",
                                                "end": "172.30.60.20" } ] } ]
    },
    "nsxtManagerSize": "medium",
    "vipFqdn": "nsx01.vcf.lab",
    "rootNsxtManagerPassword": "…", "nsxtAdminPassword": "…", "nsxtAuditPassword": "…",
    "useExistingDeployment": false,
    "vpcSpec": { "dtgwSpec": { "vlan": "70", "gatewayCidr": "172.30.70.1/24",
                               "externalIpBlockCidr": "172.30.70.0/26",
                               "privateTgwIpBlockCidr": "172.31.0.0/16" } },
    "nsxtManagers": [ { "hostname": "nsx01a.vcf.lab" } ]
  },
  "vcfOperationsSpec": {
    "applianceSize": "small", "useExistingDeployment": false, "adminUserPassword": "…",
    "nodes": [ { "hostname": "vcf01.vcf.lab", "rootUserPassword": "…", "type": "master" } ]
  },
  "vcfOperationsCollectorSpec": { "applianceSize": "small",
      "hostname": "vcf-proxy01.vcf.lab", "rootUserPassword": "…",
      "useExistingDeployment": false },
  "licenseServerSpec":     { "hostname": "vcf-lic01.vcf.lab" },
  "vidbSpec":              { "hostname": "vcf-idb01.vcf.lab" },
  "saltSpec": {}, "saltRaasSpec": {}, "telemetryAcceptorSpec": {}, "fleetDepotSpec": {},
  "fleetLcmSpec":          { "hostname": "vcf-flt01.vcf.lab" },
  "sddcLcmSpec":           { "hostname": "vcf-int01.vcf.lab" },
  "vcenterSpec": {
    "vcenterHostname": "vc01.vcf.lab", "adminUserSsoPassword": "…",
    "rootVcenterPassword": "…", "vmSize": "small", "storageSize": "lstorage",
    "ssoDomain": "vsphere.local", "useExistingDeployment": false
  },
  "clusterSpec": { "datacenterName": "VCF-Datacenter", "clusterName": "VCF-Mgmt-Cluster" },
  "datastoreSpec": {
    "vsanSpec": { "vsanDedup": false, "failuresToTolerate": 1,
                  "esaConfig": { "enabled": true }, "datastoreName": "vsanDatastore",
                  "encryptionConfig": { "dataInTransitConfig": { "enable": false } } }
  },
  "dvsSpecs": [ {
    "dvsName": "vcf-m01-cl01-vds01",
    "networks": ["MANAGEMENT","VM_MANAGEMENT","VMOTION","VSAN"],
    "mtu": 9000,
    "nsxtSwitchConfig": {
      "transportZones": [ { "name": "vcf-overlay-TZ", "transportType": "OVERLAY" },
                          { "name": "vcf-vlan-TZ",    "transportType": "VLAN" } ],
      "hostSwitchOperationalMode": "ENS" },
    "vmnicsToUplinks": [ { "id": "vmnic1", "uplink": "uplink1" } ],
    "nsxTeamings": [ { "policy": "LOADBALANCE_SRCID",
                       "activeUplinks": ["uplink1"], "standByUplinks": null } ],
    "lagSpecs": null
  } ],
  "sddcManagerSpec": { "hostname": "sddcm01.vcf.lab",
                       "localUserPassword": "…", "useExistingDeployment": true }
}
```

### Critical deltas between the published schema and the real working spec — **read before building**

| Observation | Impact |
|---|---|
| `vlanId` and `transportVlanId` are emitted as **strings** (`"30"`, `"60"`) despite the schema declaring `integer(int32)` | The installer coerces. Emit integers to be safe, but don't reject string input. **[V-SPEC]** |
| `vspClusterSpec.name` is present in the working spec but **is NOT in the documented `SddcVspClusterSpec`** | Undocumented-but-accepted field. Flag to user; consider emitting. **[V-SPEC vs V-API conflict]** |
| `fleetLcmSpec.hostname` and `sddcLcmSpec.hostname` are present, but `FleetLcmServiceSpec`/`SddcLcmServiceSpec` document only `{version, size}` | Same as above — published schema appears incomplete. **[V-SPEC vs V-API conflict]** |
| `saltSpec`, `saltRaasSpec`, `telemetryAcceptorSpec`, `fleetDepotSpec` are present as **empty objects `{}`** | Presence appears to be the "deploy with defaults" signal. **[V-SPEC]** |
| `vcfAutomationSpec.ipPool` has **6** addresses; TechDocs says VCF Automation needs **5 IPs (3 active + 2 buffer)** | Discrepancy — see UNVERIFIED §5. |
| `sddcManagerSpec.useExistingDeployment: true` | In this topology the Installer appliance converts itself into SDDC Manager. Not the general greenfield case. **[V-SPEC]** |
| `nsxTeamings[].standByUplinks` — note the **capital B** | Easy typo source. **[V-API + V-SPEC agree]** |

## 1.7 Licensing in the JSON **[V-DOC]**

- VCF 9.1 is **per-core subscription**. Licenses are assigned to **vCenter instances**; connected components are licensed automatically. **New in 9.1:** you may assign licenses **directly to ESX hosts and vSAN clusters**, overriding the automatic assignment.
- **Minimum consumption: 16 cores per physical CPU.** A CPU with 8 cores still consumes 16. (Exception: **VCF Edge = 8-core minimum per CPU**.) Example from the docs: 2 hosts × 2 CPUs × 24 cores = **96 cores**.
- **vSAN** is a separate add-on measured in **TiB**, pooled: a 300-core VCF subscription + 50 TiB add-on = one vSAN license of **350 TiB**.
- **License-later behavior:** products run in **evaluation mode for up to 90 days**. After 90 days unlicensed: management operations are prevented, hosts disconnect from vCenter, and workloads are blocked.
- **In the JSON:** there are **no license-key fields in `SddcSpec`.** The only licensing-related key is `licenseServerSpec` (`hostname`, `version`, `useExistingDeployment`, `sslThumbprint`). Licensing is performed **post-deployment** via VCF Operations / the **VCF Business Services Console**. The **License Server is a mandatory component** for VCF and VVF in 9.1. **[V-API + V-DOC]**

## 1.8 Published schema / reference URLs

There is **no downloadable standalone JSON Schema file** that I could locate. **[UNVERIFIED — see §5]** The authoritative machine-readable surface is:

- `https://developer.broadcom.com/xapis/vcf-installer-api/latest/` (versions 9.1.1 / 9.1 / 9.0 selectable)
- `.../latest/data-structures/SddcSpec/` and siblings
- `.../latest/v1/sddcs/post/`
- Example specs: `lamw/vcf-91-in-box` → `config/{one,two,three}-node-vsan-esa.json`

---

# 2. Sizing Rules

## 2.1 Management domain minimums

| Item | Value | Verification |
|---|---|---|
| **Hosts, mgmt domain, vSAN, single AZ** | **4** | **[V-DOC]** KB 392993 |
| **Hosts, mgmt domain, vSAN stretched (2 AZ)** | **8** (4 per site) | **[V-DOC]** KB 392993 |
| **Hosts, greenfield mgmt cluster (any storage)** | **4 minimum** | **[V-DOC]** VCF blog, Deployment Pathways |
| **Non-vSAN storage in mgmt domain** | **Not supported** for initial greenfield deployment — use a workload domain | **[V-DOC]** KB 392993 |
| **Hosts, converge/import path, vSAN** | **3** vSAN-ready nodes | **[V-DOC]** VCF blog |
| **Hosts, converge/import path, NFS or VMFS-FC** | **2** | **[V-DOC]** VCF blog |
| **vSAN stretched converge (9.1.1+)** | **2 ESX per AZ + witness** | **[V-DOC]** |
| **2-node vSAN ROBO** | Supported for *simple* convergence configs | **[V-DOC]** |
| **1/2/3-host lab deployments** | Possible only with unsupported installer feature-flag workarounds (e.g. `feature.vcf.vgl-29121.single.host.domain=true`) | **[C]** williamlam.com |
| **Per-host memory** | ~1 TB per host recommended for 9.1 mgmt domain | **[C]** — *community estimate, not an official minimum* |
| **Per-host NICs** | 1× 10 GbE + BMC absolute min; **25 GbE recommended for vSAN ESA**; 4 NICs min / 6 recommended per some guides | **[C]** |
| **Boot device** | No SD cards. ≤512 GB host RAM: USB/SD/SATADOM ≥32 GB; >512 GB host RAM: SATADOM or disk ≥16 GB (SLC SATADOM) | **[V-DOC]** vSAN 9.1 HW reqs |
| **Single hardware vendor across mgmt hosts** | Required | **[C]** |
| **vSAN disks must have no existing partitions** | Required | **[V-DOC]** (VI WLD prereqs) |

## 2.2 Aggregate management-plane sizing — **OFFICIAL** **[V-DOC]**

From TechDocs *VCF Fleet Sizing Models* (9.1). **This is the single best table for a sizing calculator.**

**First VCF instance** (includes fleet-wide services):

| Profile | vCPU | RAM | Disk |
|---|---|---|---|
| Simple | 76 | 251 GB | 7,448 GB |
| HA – Small | 106 | 335 GB | 8,422 GB |
| HA – Medium | 184 | 656 GB | 11,445 GB |
| HA – Large | 298 | 949 GB | 15,357 GB |

**Each additional VCF instance** in an existing fleet:

| Profile | vCPU | RAM | Disk |
|---|---|---|---|
| Simple | 34 | 111 GB | 4,562 GB |
| HA – Small | 62 | 187 GB | 5,462 GB |
| HA – Medium | 74 | 244 GB | 5,813 GB |
| HA – Large | 120 | 353 GB | 8,321 GB |

> Delta first-vs-additional = the fleet-level services (Fleet LCM, Identity Broker, License Server, Fleet Depot, Telemetry Acceptor, fleet VSP). **[I]**

## 2.3 Per-component breakdown **[C]** — community, corroborates the official aggregate

| Component | Simple: vCPU / RAM / Disk | HA: vCPU / RAM / Disk |
|---|---|---|
| VCF Management Services (VSP runtime) | 40 / 82 GB / 3,000 GB | 84 / 174 GB / 3,600 GB |
| VCF Automation | 24 / 96 GB / 600 GB | 72 / 288 GB / 2,700 GB |
| NSX Manager | 6 / 24 GB / 300 GB (×1) | 18 / 72 GB / 900 GB (×3) |
| VCF Operations | 4 / 16 GB / 274 GB | 24 / 96 GB / 822 GB |
| Cloud Proxy (Ops Collector) | 4 / 16 GB / 144 GB | 8 / 48 GB / 144 GB |
| vCenter | 4 / 21 GB / 1,519 GB | 8 / 30 GB / 1,658 GB |

Additional Day-N: NSX Edge ×2 @ 8 vCPU / 32 GB; Log management ~8 vCPU / 16 GB; Real-time metrics ~16 vCPU / 20 GB; License Server 2 vCPU / 4 GB. **[C]**

> The "**~40 vCPU / 82 GB** smallest VCF Management Services footprint" figure is independently reported by two community sources — reasonably reliable, still **[C]**.

## 2.4 Appliance sizing tables

### vCenter **[C]** (enum names **[V-API]**)
| Size (`vmSize`) | vCPU | Memory | Storage |
|---|---|---|---|
| `tiny` | 2 | 14 GB | 579 GB |
| `small` | 4 | 21 GB | 694 GB |
| `medium` | 8 | 30 GB | 908 GB |
| `large` | 16 | 39 GB | 1,358 GB |
| `xlarge` | 24 | 58 GB | 2,283 GB |

`storageSize` enum: `lstorage` | `xlstorage` **[V-API]**

### NSX Manager **[C]** (enum **[V-API]**)
| Size | vCPU | Memory | Storage |
|---|---|---|---|
| Extra Small | 2 | 8 GB | 300 GB |
| Small | 4 | 16 GB | 300 GB |
| `medium` (default) | 6 | 24 GB | 300 GB |
| `large` | 12 | 48 GB | 300 GB |
| `xlarge` | 24 | 96 GB | 400 GB |

> **Important:** `SddcNsxtSpec.nsxtManagerSize` accepts **only `medium`, `large`, `xlarge`** — xsmall/small exist as NSX form factors but are **not selectable for VCF bring-up**. **[V-API]**

### NSX Edge VM — **OFFICIAL, VCF 9.1** **[V-DOC]**
| Size | vCPU | Memory | Disk | Guidance |
|---|---|---|---|---|
| Small | 2 | 4 GB | 200 GB | Lab / PoC only |
| Medium | 4 | 8 GB | 200 GB | Production w/ LB |
| Large | 8 | 32 GB | 200 GB | Production w/ LB |
| XLarge | 16 | 64 GB | 200 GB | Production w/ LB |

Minimum **2 Edge nodes** per centralized Edge cluster; max **10 edges per cluster**; each node reserves full CPU and memory. **[V-DOC]**

### SDDC Manager **[C]**
Single size: **4 vCPU / 16 GB / 980 GB**.

### VCF Operations — **OFFICIAL (KB 397782, written for 9.0)** **[V-DOC, version caveat]**
| Size | vCPU | Default RAM | Max RAM | Max objects (single node) | Max metrics (single node) |
|---|---|---|---|---|---|
| `xsmall` | 2 | 8 GB | 16 GB | 700 | 140,000 |
| `small` | 4 | 16 GB | 32 GB | 10,000 | 1,600,000 |
| `medium` | 8 | 32 GB | 64 GB | 30,000 | 5,000,000 |
| `large` | 16 | 48 GB | 96 GB | 44,000 | 8,000,000 |
| `xlarge` | 24 | 128 GB | 256 GB | 100,000 | 20,000,000 |

Cluster maxima:
| Size | Max nodes | Max objects/cluster | Max metrics/cluster |
|---|---|---|---|
| Small | 2 | 12,000 | 2,800,000 |
| Medium | 8 | 136,000 | 32,000,000 |
| Large | 16 | 576,000 | 81,600,000 |
| Extra Large | 12 | 1,056,000 | 126,000,000 |

Constraints: **all nodes must be the same size** (no mixing); **<5 ms** latency between nodes, **<300 ms** for extended; datastore latency **<10 ms** (peaks ≤15 ms). **[V-DOC]**

### VCF Operations Collector / Cloud Proxy — **OFFICIAL** **[V-DOC]**
| Type | Size (`applianceSize`) | Max objects | Max metrics | vCPU | RAM |
|---|---|---|---|---|---|
| Cloud Proxy | `small` | 16,000 | 2,400,000 | 2 | 8 GB |
| Cloud Proxy | `standard` | 80,000 | 12,000,000 | 4 | 32 GB |
| Unified Cloud Proxy | small | 16,000 | 2,400,000 | 4 | 16 GB |
| Unified Cloud Proxy | standard | 80,000 | 12,000,000 | 8 | 48 GB |

Enum for `VcfOperationsCollectorSpec.applianceSize` is **`small` | `standard`** **[V-API]** — matches.

### VCF Automation **[C]**
| Size | Nodes | vCPU | RAM | Disk |
|---|---|---|---|---|
| Small | 1 | 24 | 96 GB | 455 GB |
| Medium | 3 | 72 | 288 GB | 1,002 GB |
| Large | 3 | 96 | 384 GB | 1,290 GB |

> **Hard planning constraint:** a VCF Automation node requires **24 vCPU**, so an ESXi host with only 16 logical CPUs cannot run it. This is a documented real-world deployment failure. **[C]**

### vSphere Supervisor / VSP cluster
`size` enum: **`small` | `small_ha` | `medium` | `large`**; `small_ha` is management-VSP-only and cannot be used for a consumption (VCF Automation) VSP cluster. **[V-API]** — **vCPU/RAM/disk per tier: NOT FOUND, see §5.**

### VCF Operations for Logs / for Networks **[C]**
- Logs: Small 4 vCPU/8 GB · Medium 8/16 · Large 16/32
- Networks Platform: Medium 8/32 · Large 12/48 · X-Large 16/64
- Networks Collector: Medium 4/12 · Large 8/16 · X-Large 8/24 · 2X-Large 16/48

### VCF Fleet Manager appliance **[C]**
4 vCPU / 12 GB / 194 GB — **but note this appliance is removed in 9.1** per KB 440630. Treat as 9.0-only. **[V-DOC on removal]**

### VCF Identity Broker (`vidbSpec`), License Server, VCF Installer appliance
**Sizing NOT FOUND — see §5.** `VidbSpec` exposes a `size` field but the enum values are undocumented. **[V-API]**

## 2.5 vSAN ESA vs OSA in 9.1

| Question | Answer | Verification |
|---|---|---|
| **Is ESA mandatory for the management domain?** | **No.** The 9.1 Installer wizard offers vSAN (**ESA or OSA**), VMFS-on-FC, and NFS v3 as principal storage for the management domain. ESA is strongly *recommended*, not required. | **[V-DOC]** wizard docs + vSAN Design Guide: *"strongly encouraged for all new cluster designs to be vSAN ESA instead of OSA"* |
| **Is vSAN mandatory for the mgmt domain?** | **Yes for greenfield** — non-vSAN clusters are not supported in the management domain at initial deployment. (Brownfield convergence relaxes this.) | **[V-DOC]** KB 392993 |
| **ESA device requirements** | NVMe only. "Each storage pool must have at least one NVMe TLC device." No RAID controllers, no tri-mode controllers. | **[V-DOC]** |
| **ESA host memory minimum** | **128 GB** | **[V-DOC]** |
| **OSA cache** | ≥1 SAS/SATA SSD or PCIe flash, ≥10% of anticipated capacity | **[V-DOC]** |
| **OSA capacity** | ≥1 SAS/NL-SAS magnetic (hybrid) or ≥1 SSD/PCIe (all-flash); HBA or RAID controller in passthrough/RAID-0 | **[V-DOC]** |
| **Not supported for convergence** | vSAN OSA clusters with **compression-only** activation; vVols (deprecated in v9) | **[V-DOC]** |
| **Compression in 9.1 ESA** | Enabled by default | **[V-DOC]** design guide |

### Slack space and FTT/RAID overhead **[V-DOC]** (vSAN Design Guide)

**Auto-RAID** is new in VCF 9.1 and changes the math: *"capacity views will reflect true usable space accounting for host rebuilds, operational needs, and RAID overhead."*

| Cluster type | RAID | Capacity overhead multiplier |
|---|---|---|
| Standard, 3–5 hosts | RAID-5 (2+1) | **1.5×** |
| Standard, 6+ hosts | RAID-6 | **1.5×** |
| Stretched, 3–5 per site | Mirror + RAID-5 | **3.0×** |
| Stretched, 6+ per site | Mirror + RAID-6 | **3.0×** |
| 2-node | Host mirroring | **2.0×** |

> Key simplification: *"RAID 5 and RAID 6 have the same capacity overhead consideration"* under Auto-RAID (before compression/dedup savings).

**Slack space:**
- Legacy (pre-vSAN 7 U1) rule of thumb: **25–30%** — no longer the blanket recommendation.
- With **fault domains** configured: maintain **~25% free capacity** (the operational/host-rebuild reserve toggles are unavailable).
- With Auto-RAID and no fault domains: rely on the product's reported usable capacity rather than a fixed slack %.

**Minimum hosts by RAID level (standard cluster):** <3 hosts → RAID-0 (FTT=0); **3–5 hosts → RAID-5 (2+1), FTT=1**; **6+ hosts → RAID-6, FTT=2**.
**With fault domains (3 hosts per FD):** FTT=1 RAID-5 → **12 hosts** (4 FDs); FTT=2 RAID-6 → **21 hosts** (7 FDs). **[V-DOC]**

**ESA ReadyNode profiles:** the canonical table lives at `compatibilityguide.broadcom.com/pages/vsan-esa-readynode-hardware-guidance` — **I could not extract it** (the page is a JS app). **See §5.**

## 2.6 Workload domain minimums and scaling **[V-DOC]**

Prerequisites for a VI workload domain in 9.1:
- Hosts commissioned with the target storage type; express patches matching the management domain
- SSD/NVMe with **no pre-existing partitions** for vSAN; vLCM image in the library for vSAN
- **Static IP pool or DHCP on the Host TEP VLAN** (exception: TEP-less deployments, 9.1.1+)
- **Each host needs at least one physical NIC on a standard switch**
- Available network pool with free IPs
- vCenter and NSX Manager FQDNs/IPs must be DNS-resolvable
- **9.1.1+: the first cluster cannot share a vSphere Distributed Switch**
- Dual-stack domains: SDDC Manager in dual-stack mode; **an IPv4 range must be reserved for NSX Overlay (IPv6 unsupported there)**
- vVols requires a VASA provider

VI WLD wizard fields: domain name (3–20 chars), deployment type, vSphere Supervisor toggle, dual-stack toggle, SSO domain; vCenter FQDN/IP/gateway; cluster name, vLCM image, vSphere Zone; NSX Manager (new/existing) + deployment size + appliance sizes + FQDNs + VPC config + gateway connectivity model; storage type + params; host selection; vDS profile or custom; Supervisor settings (name, Service CIDR, control plane, NSX project, VPC profile, private/workload networks, DNS/NTP).

**Explicit per-cluster host minimum for a 9.1 VI WLD was NOT stated on the page I read — see §5.**

## 2.7 Network requirements

**Networks / VLANs.** The `networkType` enum is the authoritative list: `MANAGEMENT`, `VM_MANAGEMENT`, `VMOTION`, `VSAN`, `NFS`, `FLEET_MANAGEMENT`, plus custom types. **[V-API]**

Lam's minimal working 9.1 deployment uses **5 distinct VLANs**: management (shared by MANAGEMENT + VM_MANAGEMENT), vMotion, vSAN, Host TEP (`transportVlanId`), and the DTGW/VPC uplink VLAN. **[V-SPEC]** One community guide states **7 VLANs minimum** for a management domain. **[C]**

**MTU** **[V-API / V-DOC / C]**
| Traffic | MTU | Verification |
|---|---|---|
| vDS default (`DvsSpec.mtu`) | **9000** | **[V-API]** |
| Physical switch fabric | 9216 | **[C]** |
| vSAN, vMotion, Host Overlay, Edge Overlay | 9000 | **[C]** |
| NSX overlay absolute minimum | ≥1600 (1700 recommended) | **[C]** |
| BGP peering | 1500–9000 permitted | **[V-DOC]** |
| `SddcNetworkSpec.mtu` valid range (builder-observed) | 1280–9190 | **[C]** (Justin Raley validator) |

**DNS** **[V-DOC]** — forward (A) **and** reverse (PTR) must both resolve before the Installer runs; every FQDN and IP unique; **all FQDNs lowercase**; `.local` and similar suffixes unsupported; `DnsSpec.nameservers` max 2 entries **[V-API]**; two DNS servers recommended on every appliance.

**NTP** **[C]** — two external time sources per site, two A records, one CNAME for round-robin; AD DCs synced to the same source. `ntpServers` is a plain string array. **[V-API]**

**TEP / Edge routing** **[V-DOC]**
- Host TEP pool: static IP pool recommended, sized ≥ `hosts × pNICs` + growth (e.g. 4 hosts × 2 pNICs = 8 IPs min) **[C]**; expressed as `nsxtSpec.ipAddressPoolSpec` **[V-API]**
- Edge TEP may reuse the Host TEP VLAN; Edge TEP MTU must match host MTU within the same overlay transport zone
- BGP: **2 BGP peers on a ToR** with interface IP, local ASN and BGP password; a reserved local ASN for Tier-0 uplinks. BGP/ECMP is required **only** for NSX Centralized Connectivity with Edge clusters.
- `internalClusterCidrIpv4` for VSP/Automation is restricted to **198.18.0.0/15, 240.0.0.0/15, 250.0.0.0/15** and must not collide with anything in the environment **[V-API]**

## 2.8 IP address and FQDN requirements — **OFFICIAL** **[V-DOC]**

First VCF instance:

| Component | Simple | HA | Network |
|---|---|---|---|
| vCenter | 1 FQDN | 1 FQDN | mgmt |
| ESX hosts | 1 FQDN + 1 IP per host | same | mgmt |
| vMotion | 1 IP per host | same | vMotion |
| vSAN | 1 IP per host | same | vSAN |
| NSX Manager nodes | 1 FQDN | **3 FQDNs** | mgmt |
| NSX Manager cluster VIP | 1 FQDN | 1 FQDN | mgmt |
| SDDC Manager | 1 FQDN | 1 FQDN | mgmt |
| VCF Operations Primary | 1 FQDN | 1 FQDN | mgmt |
| VCF Operations Replica | — | 1 FQDN | mgmt |
| VCF Operations Data | — | 1 FQDN | mgmt |
| VCF Operations Load Balancer | — | 1 FQDN (optional) | mgmt |
| Cloud Proxy | 1 FQDN | 1 FQDN | mgmt |
| License Server | 1 FQDN | 1 FQDN | mgmt |
| VCF Automation | 1 FQDN | 1 FQDN | VCF mgmt network |
| VCF services runtime (Automation) | 1 FQDN | 1 FQDN | VCF mgmt network |
| **VCF Automation nodes** | **5 IPs** (3 active + 2 buffer) | 5 IPs | VM mgmt by default |
| Fleet components | 1 FQDN | 1 FQDN | VCF mgmt network |
| Instance components | 1 FQDN | 1 FQDN | VCF mgmt network |
| VCF services runtime (Management) | 1 FQDN | 1 FQDN | VCF mgmt network |
| **VCF services runtime nodes (VCFMS)** | **min 12 IPs, recommended 30** | same | VCF mgmt network |
| Identity broker | 1 FQDN | 1 FQDN | VCF mgmt network |

Day-N: Log management **6 IPs + 2 per replica**; Real-time metrics **6 IPs**; Ops for Networks Platform **1 IP**; Collector **1 IP**. **[V-DOC]**

> The **12-IP VCFMS minimum** is also stated as a hard prerequisite in the 9.1 upgrade KB. **[V-DOC]** In 9.1.0.400+ these can be **non-contiguous** via `IPv4Pool.addresses` / `excludedAddresses`. **[V-DOC + V-API]**

## 2.9 Fleet-level considerations

- **There is no fixed maximum number of VCF instances per fleet.** Capacity is governed by **VCF Operations objects and metrics**, not by vCenter/host counts. A 1-node XL Ops appliance supports 100K objects / 20M metrics; a 16-node XL cluster supports ~1M objects / 126M metrics. Network latency and bandwidth are co-determinants. **[C — williamlam.com, but consistent with the official KB 397782 numbers]**
- Use the **"additional VCF instance"** column of §2.2 for each instance beyond the first. **[V-DOC]**
- Fleet deployment models: Basic (single site) · Site HA (across AZs, fault domains, stretched/multi-rack) · DR (across regions, VMware Live Recovery) · Fault Domains + DR. Large or geographically dispersed estates may need **multiple fleets**. **[V-DOC]**
- Secondary-instance JSON signals: `vcfOperationsSpec.useExistingDeployment = true` with the **existing master node's** details and password; **omit `vspClusterSpec.fleetFqdn`**. **[V-API]**

---

# 3. Greenfield vs Brownfield

## 3.1 Greenfield **[V-DOC]**

VCF Installer appliance → wizard or **"DEPLOY USING JSON SPEC"**. Wizard step sequence (9.1):

1. Login (`admin@local`)
2. Deployment type: **new VCF fleet** vs **new VCF Instance in an existing fleet**
3. Existing components (optional): existing VCF Operations 9.1, existing vCenter *(not recommended for new deployments)*, vCenter already registered with NSX Manager, existing VCF Automation
4. Deployment model & scale: **High Availability** (production) or **Simple**; size **Small** (default in 9.1.1+) / Medium / Large (HA only)
5. Network configuration: management network (VM vs VCF management separation), IPv4 / IPv6 / dual-stack, vMotion, storage, **VPC network type (Full Stack or VLAN-Backed)**, **VPC gateway connectivity (Centralized or Distributed)**. Optionally skip Ops/Automation for later custom-network deployment.
6. Storage type: vSAN (**ESA or OSA**, FTT, dedup/compression), VMFS-on-FC (pre-mounted), NFS v3 (pre-configured)
7. Prerequisites review — includes **"PRE-FILL GENERATED FQDNs IN WIZARD"**
8. General: version, VCF Instance Name, management domain name, CEIP, DNS servers, NTP servers, DNS domain, **password auto-generation toggle**
9. ESX host details
10. Network details: ESX Management / VM Management / VCF Management port groups, **VCF Management Services IP range**, **VCF Automation IP range (5 IPs)** (both contiguous or non-contiguous in 9.1.0.400+), vMotion, vSAN/NFS, NSX Host Overlay; MTU per traffic type
11. VCF management components: Ops Primary/Replica/Data FQDNs, LB FQDN, Cloud Proxy, License Server, Fleet components, Instance components, Identity broker, VCF services runtime FQDN, internal cluster CIDRs (v4 and v6)
12. vCenter details
13. Storage details
14. vDS: profile (**Default** / **Storage Traffic Separation** (2 switches) / **NSX Traffic Separation** (2 switches) / **Storage and NSX Traffic Separation** (3 switches) / **Custom**) with uplink or **LACP** config, NIC mapping, per-traffic-type load balancing and uplink roles
15. NSX Manager details (Distributed Connectivity: VLAN ID + gateway CIDR matching the ToR default gateway)
16. SDDC Manager details
17. Review → 18. Validation → 19. Deploy

Post-deployment: save auto-generated passwords, license via **VCF Business Services Console**, deploy remaining components, configure SDDC Manager file-based backups, apply DRS anti-affinity rules for HA Ops.

New in 9.1: default deployment of VCF management services (services runtime, fleet lifecycle, identity broker); **LACP in the UI**; **auto-generated complex passwords** for system-managed and break-glass accounts; custom networking for Ops/Automation (separate vDS and NSX segments); an integrated **planning workflow** that generates CPU/memory/storage/VLAN/FQDN requirements with infrastructure validation. **[V-DOC]**

## 3.2 Brownfield — **YES, fully supported in 9.1** **[V-DOC]**

Two distinct paths:

**A. Converge** — an existing vSphere estate becomes the **management domain** of a new VCF instance in a new or existing fleet.
**B. Import** — an existing vCenter becomes a **VI workload domain** inside an already-running VCF instance.

API support: `POST /v1/sddcs/vcenter-discovery`, `/vcenter-discovery/networks`, `/vcfops-discovery`, `/sddcm-discovery`. **[V-API]**
JSON support: `useExistingDeployment: true` + `sslThumbprint` (SHA256) on `vcenterSpec`, `nsxtSpec`, `sddcManagerSpec`, `vcfOperationsSpec`, `vcfOperationsCollectorSpec`, `vcfAutomationSpec`, `vspClusterSpec`, `licenseServerSpec`; plus `datastoreSpec.existingDatastoreName` and `nsxtSpec.enableEdgeClusterSync`. **[V-API]**

### Supported components **[V-DOC]**
Aria Operations · Aria Automation · NSX · vCenter · ESX · vSAN — all convergeable. **NSX 4.2.1 or later**, registered with a vCenter **not** using Enhanced Linked Mode, converges at its current version.

### Supported scenarios **[V-DOC]**
1. vCenter + ESX (± vSAN/NSX)
2. + Aria Operations
3. + Aria Suite Lifecycle + Aria Operations
4. + Aria Suite Lifecycle + Aria Automation
5. + Aria Suite Lifecycle + Aria Operations + Aria Automation

### Supported / not supported **[V-DOC]**

| Area | Supported | **Not supported** |
|---|---|---|
| Storage | vSAN, NFS v3, VMFS, NFS 4.1, iSCSI; vSAN stretched (9.1.1+, ≥2 ESX/AZ + witness); 2-node vSAN ROBO; shared datastores writable by all hosts | **vVols** (deprecated in v9); **vSAN OSA with compression-only** |
| Network | **vDS 8.0 or later**; static VMkernel IPs; static **and** dynamic NSX Host TEP; vCenter with existing NSX registration (no ELM); NSX Bare Metal and VM Edge nodes | **Cisco virtual switches**; **vCenter without a vDS**; **dynamically allocated VMkernel IPs**; multiple NSX Managers per vCenter; **vCenter with ELM + existing NSX** |
| Compute | vCenter VM on a managed cluster; vSphere Configuration Profiles; **vLCM images**; **fully automated DRS**; standalone hosts if another qualified cluster exists; Supervisor-enabled clusters | **vCenter with Enhanced Linked Mode**; vCenter VM on a different vCenter's cluster; **manual/partial DRS**; **baseline-based LCM**; **VCHA**; **partial cluster imports** |

NSX handling: SDDC Manager imports NSX Manager credentials, registers them in inventory, and explicitly trusts node certificates. Both HA (3-node) and simple (1-node) NSX models supported. **[V-DOC]**

Post-convergence limitations: cannot add hosts without vSphere Client access; limited password management for imported ESX hosts via the VCF Operations console. **[V-DOC]**

Host minimums: **3 vSAN-ready nodes** or **2 hosts with NFS/VMFS-on-FC**. **[V-DOC]**

**Version rule:** *"Component versions determine available features — the earliest version defines the effective VCF version across your entire instance."* **[V-DOC]**

**Note on 9.0 → 9.1 change:** in 9.0, *"existing vCenter environments with NSX installed are not initially supported to be converged."* **9.1 removes this**: the Installer now supports existing vCenter 8.0 U3a+ with NSX Manager 4.2+ without manual component upgrades. **[V-DOC]** — this is a significant 9.1 improvement.

## 3.3 Upgrade paths to 9.1 **[V-DOC]**

Supported sources: **VCF 5.2.x or 9.0.x** · **vSphere Foundation 5.2.x or 9.0.x** · **vSphere + ESX only 8.x or 9.0.x** · **NSX 4.x** · **Aria/Operations 8.x**.

Four path families **[C — williamlam.com]**: (1) vSphere 8.x + Aria Ops 8.x (3 options); (2) NSX 4.x + vSphere 8.x + Aria Ops 8.x (single route); (3) Aria Automation 8.x + NSX 4.x + vSphere 8.x + Aria Ops 8.x; (4) **VCF 5.x direct** (with or without Aria Automation).

Mandatory pre-upgrade steps **[V-DOC, KB 440630]**:
1. Deploy **VCF Management Services** — **minimum 12 IP addresses**; mandatory for VCF, optional for VVF
2. Install the **centralized License Server** — mandatory for both VCF and VVF
3. **Upgrade VCF Operations first**, before any lifecycle-management workflows

Hard constraints:
- *"A mandatory component upgrade sequence must be followed"*; incorrect sequence causes errors. There is **no single linear sequence published** — it is path-dependent.
- **If NSX 4.x is present, the only option is Option A: VCF Installer workflows with convert/import operations.** Independent component upgrades are not supported in that case.
- **VCF Fleet Management Appliance is removed in 9.1** — do not use it for upgrades.
- vSphere 8.x is **EOS Oct 2027**. **[C]**

---

# 4. vCenter Inventory Collection

## 4.1 vSphere Automation REST API (vSphere 9.x) — `/api/...`

| Need | Endpoint |
|---|---|
| Hosts | `GET /api/vcenter/host` (filters: `clusters`, `datacenters`, `folders`, `names`, `connection_states`) |
| Clusters | `GET /api/vcenter/cluster` |
| Datacenters | `GET /api/vcenter/datacenter` |
| Datastores | `GET /api/vcenter/datastore` , `GET /api/vcenter/datastore/{id}` (capacity, free_space, type) |
| Datastore inventory lookup | `GET /api/vcenter/inventory/datastore` **[V-DOC — confirmed to exist]** |
| VMs | `GET /api/vcenter/vm` (summary: `power_state`, `cpu_count`, `memory_size_MiB`), `GET /api/vcenter/vm/{vm}` (full incl. disks/NICs) |
| Networks | `GET /api/vcenter/network` |
| Resource pools | `GET /api/vcenter/resource-pool` |
| Folders | `GET /api/vcenter/folder` |
| Auth | `POST /api/session` → `vmware-api-session-id` header |

**Critical limitation:** the REST API surface does **not** expose CPU model/socket/core-per-socket detail, per-host NIC inventory, pNIC speeds, vDS/uplink topology, or historical utilization. **For sizing you must use the vSphere Web Services (SOAP/vim25) API or PowerCLI.** **[I — based on the documented REST surface]**

## 4.2 PowerCLI — the practical route

**Core inventory (VMware.PowerCLI):**

| Data | Cmdlet / property path |
|---|---|
| Connect | `Connect-VIServer` |
| Clusters | `Get-Cluster` → `HAEnabled`, `DrsEnabled`, `DrsAutomationLevel`, `EVCMode` |
| Hosts | `Get-VMHost` → `Name`, `Version`, `Build`, `ConnectionState`, `PowerState`, `NumCpu`, `CpuTotalMhz`, `CpuUsageMhz`, `MemoryTotalGB`, `MemoryUsageGB`, `Manufacturer`, `Model`, `ProcessorType` |
| **CPU sockets / cores-per-socket** | `(Get-VMHost).ExtensionData.Hardware.CpuInfo` → `NumCpuPackages`, `NumCpuCores`, `NumCpuThreads`, `Hz`; `.Hardware.CpuPkg[0].Description` for the CPU model string |
| Host NICs | `Get-VMHostNetworkAdapter`; `(Get-VMHost).ExtensionData.Config.Network.Pnic` → `LinkSpeed.SpeedMb` |
| VMkernel / IPs | `Get-VMHostNetworkAdapter -VMKernel` |
| Datastores | `Get-Datastore` → `CapacityGB`, `FreeSpaceGB`, `Type` (VMFS/NFS/vsan); `Get-DatastoreCluster` |
| vSAN | `Get-VsanClusterConfiguration`, `Get-VsanDisk`, `Get-VsanDiskGroup`, `Get-VsanSpaceUsage` |
| VMs | `Get-VM` → `Name`, `PowerState`, `NumCpu`, `CoresPerSocket`, `MemoryGB`, `ProvisionedSpaceGB`, `UsedSpaceGB`, `GuestId`, `HardwareVersion` |
| VM guest / tools | `Get-VMGuest` → `OSFullName`, `IPAddress`, `ToolsVersion` |
| VM disks / NICs | `Get-HardDisk` (`CapacityGB`, `StorageFormat` = Thin/Thick), `Get-NetworkAdapter` |
| Virtual switches | `Get-VirtualSwitch`, `Get-VDSwitch` (`Mtu`, `NumUplinkPorts`), `Get-VDPortgroup` (`VlanConfiguration`) |
| Snapshots | `Get-Snapshot` |
| **Actual utilization** | `Get-Stat -Entity <host\|vm> -Stat cpu.usage.average, mem.usage.average, mem.consumed.average, disk.usage.average, net.usage.average -Start/-Finish -IntervalMins` |
| Licensing | `Get-View ServiceInstance` → `LicenseManager`; `(Get-View LicenseManager).Licenses` |

**VCF-specific (VCF PowerCLI 9.0 SDK)** **[V-DOC]**

| Module | Covers |
|---|---|
| `VMware.Sdk.Vcf.Installer` | **VCF Installer API — bring-up / `SddcSpec`** |
| `VMware.Sdk.Vcf.SddcManager` | SDDC Manager API (post-deployment) |
| `VMware.Sdk.Vcf.Ops` | VCF Operations API |
| `VMware.Sdk.vSphere` | vCenter API |
| `VMware.Sdk.Nsx.Policy` | NSX API |
| `VMware.Sdk.Srm` | SRM API |

Conventions: **`Initialize-*`** builds a request body client-side (no server call); **`Invoke-*`** executes against the server. Discovery: **`Get-VcfInstallerOperation`**, **`Get-VcfSddcManagerOperation`** map API endpoints to cmdlets. The older community module `PowerVCF` (`Get-VCFHost`, `Start-CloudBuilderSDDC`, etc.) targets VCF 4.x/5.x and is **not** the 9.x path. **[V-DOC]**

> For your builder: `Initialize-*` cmdlets in `VMware.Sdk.Vcf.Installer` mirror the `SddcSpec` sub-structures and are a useful cross-check on field names.

## 4.3 RVTools — sheet and column names **[V-DOC]** (Azure Migrate's documented required subset)

RVTools exports **27 sheets**: `vInfo, vCPU, vMemory, vDisk, vPartition, vNetwork, vCD, vUSB, vSnapshot, vTools, vSource, vRP, vCluster, vHost, vHBA, vNIC, vSwitch, vPort, dvSwitch, dvPort, vSC_VMK, vDatastore, vMultiPath, vFileInfo, vLicense, vHealth, vMetaData` **[C — virtualFrog/Invar, which reimplements them]**

Exact column headers for the sizing-relevant sheets **[V-DOC]**:

**`vInfo`** — `VM`, `VM UUID`, `Powerstate`, `CPUs`, `Memory`, `Provisioned MiB`, `In use MiB`, `OS according to the configuration file`

**`vHost`** — `Host`, `Cluster`, `Datacenter`, `Config status`, `in Maintenance Mode`, `in Quarantine Mode`, **`CPU Model`**, **`Speed`**, **`#CPU`**, **`Cores per CPU`**, **`# Cores`**, `CPU usage %`, **`# Memory`**, `Memory usage %`, `VM Used memory`, `VM Memory Swapped`, `VM Memory Ballooned`, `#NICs`, **`# vCPUs`**, **`vRAM`**, `ESX Version`, `Vendor`, `Model`, `Object ID`, `UUID`

**`vDatastore`** — `Name`, `Object ID`, `Type`, `Hosts`, `Capacity MiB`, `Provisioned MiB`, `In Use MiB`

**`vPartition`** — `VM`, `VM UUID`, `Capacity MiB`, `Consumed MiB`
**`vMemory`** — `VM`, `VM UUID`, `Size MiB`, `Reservation`
**`vDisk`** — `VM`, `VM UUID`, `Shared Bus`, `Controller`
**`vNetwork`** — `VM`, `VM UUID`, `Switch`, `Connected`
**`vSnapshot`** — `VM`, `VM UUID`, `Powerstate`, `Size MiB (vmsn)`, `Size MiB (total)`, `Quiesced`, `Datacenter`, `Cluster`, `Host`
**`dvPort`** — `Object ID`, `Port`, `Switch`, `Type`, **`VLAN`**, `Allow Promiscuous`, `Mac changes`, `Forged Transmits`

> **Sizing mapping:** `vHost.# Cores` × host count → license core count (apply the **16-core-per-CPU floor** using `#CPU` and `Cores per CPU`). `vHost.# vCPUs` / `vHost.# Cores` → current consolidation ratio; target ≤2:1 vCPU:pCPU per VCF guidance **[C]**. `vInfo.In use MiB` vs `Provisioned MiB` → thin-provisioning delta for vSAN capacity planning. `dvPort.VLAN` → existing VLAN inventory for the network plan.
>
> **Caveat:** RVTools captures point-in-time `CPU usage %` / `Memory usage %` only — **no historical peaks**. For credible sizing, supplement with `Get-Stat` or VCF Operations/Aria Operations time-series. **[I]**

---

# 5. Analysis of the two existing builders

## 5.1 Justin Raley — `justinraley.com/.../WordPress-VCF-JSON-Builder/app/` (v1.0.4)

**Positioning:** a **planning-first** tool. Title: *"VCF JSON Builder 9.1"*. Sections: *"Your management environment"* → *"01 Deployment plan"* → *"02 Installer specification"*. Two outputs: **"Download planning JSON"** and **"Create starter SddcSpec →"**.

**Fields collected** (from the rendered page + `core.js`): Instance prefix · Domain suffix · VCF version · ESXi hostname base · ESXi host count (3/4/5/6) · Management subnet · Management VLAN · vMotion VLAN · vSAN VLAN · VM management VLAN · Transport/TEP VLAN · TEP subnet · Primary DNS · Primary NTP · vCenter FQDN · SDDC Manager FQDN · DVS name · Storage type (vSAN ESA / vSAN OSA / NFS v3 / VMFS-FC) · Datastore name · NSX Manager VIP FQDN.

**Internal field keys:** `jsonPrefix, jsonDomain, jsonVcenter, jsonSddcManager, jsonNsxVip, jsonHostBase, jsonVersion, jsonHostCount, jsonManagementSubnet, jsonTepSubnet, jsonManagementVlan, jsonVmotionVlan, jsonVsanVlan, jsonVmManagementVlan, jsonTepVlan, jsonDns, jsonNtp, jsonDvs, jsonDatastore`

**Exact emitted `SddcSpec` — `VcfBuilder.starter()`, verbatim:**
```js
{
  sddcId, workflowType:'VCF', version, vcfInstanceName,
  hostSpecs: [{ hostname, credentials:{username:'root', password:'<required>'},
                sslThumbprint:'<required>' }],
  vcenterSpec: { vcenterHostname, rootVcenterPassword:'<required>', vmSize,
                 ssoDomain, adminUserSsoPassword:'<required>' },
  clusterSpec: { datacenterName, clusterName },
  dnsSpec: { subdomain, nameservers }, ntpServers,
  networkSpecs: [
    { networkType:'MANAGEMENT', subnet, subnetMask, gateway, vlanId },
    { networkType:'VMOTION',       vlanId },
    { networkType:'VSAN',          vlanId },
    { networkType:'VM_MANAGEMENT', vlanId }
  ],
  ceipEnabled:false, skipEsxThumbprintValidation:false, skipGatewayPingValidation:false,
  // conditional:
  datastoreSpec: { vsanSpec: { datastoreName, esaConfig:{enabled:<type==='vsan-esa'>},
                               failuresToTolerate } }
}
```

**Validation constants:** host count **3–64** (PoC) / **4–64** (production); VLAN **0–4094**; MTU **1280–9190**; management subnet must fit **10 + hostCount** addresses; production profile requires **≥4 hosts**; import limit 2 MB. Output filenames: `{sddcId}-planning-draft.json`, `{sddcId}-vcf91-review-required.json`. Rejects a foreign planning schema `labis.vcf-deployment-draft/v1`.

**What it does NOT emit:** `nsxtSpec` (despite collecting the NSX VIP FQDN), `sddcManagerSpec` (despite collecting the FQDN), `dvsSpecs` (despite collecting DVS name), `vcfOperationsSpec`, `vcfOperationsCollectorSpec`, `vcfAutomationSpec`, `vspClusterSpec`, `vidbSpec`, `licenseServerSpec`, `fleetLcmSpec`/`sddcLcmSpec`/`fleetDepotSpec`/`saltSpec`/`saltRaasSpec`/`telemetryAcceptorSpec`, `securitySpec`, `managementPoolName`, NFS/VMFS datastore specs, TEP pool, per-host IPs. Output is explicitly marked **incomplete pending manual additions for "9.1 component services and topology"** — hence the `-review-required` filename.

**Its one genuinely valuable behaviour to copy:** `checkSpec()` validates an imported native `SddcSpec` and **rejects the removed 9.0 field `vcfOperationsFleetManagementSpec`**. That is correct, current, and worth replicating.

## 5.2 VirtualBytes — `tools.virtualbytes.io/vcf-json-builder`

**Positioning:** a **full installer-schema generator**. Targets **VCF 9.0.2** per its own help page. Client-side only; explicitly states nothing is transmitted to a server. Nine tabs plus a shared "defaults" block.

**Fields collected:**
- **Defaults:** instance prefix, domain suffix, ESX hostname base, host count, VCF version, management/vMotion/vSAN/VM/TEP CIDRs + VLAN IDs
- **Overview:** SDDC ID, VCF Instance Name, Workflow Type (VCF / VVF), DNS + NTP servers, datacenter name, cluster name, global password, CEIP toggle
- **Hosts:** per host — hostname, management IP, root password, vMotion IP, vSAN IP, TEP IP, **cache + capacity disk identifiers (OSA)** or **storage-tier devices (ESA)**, SSL thumbprint
- **vCenter:** FQDN, VM size (Tiny/Small/Medium/Large/XL), SSO domain, root password, SSO admin password
- **Networking:** DVS name, MTU, vmnic→uplink mappings, NSX uplink teaming policy, load-balancing policy, active/standby/unused uplinks, network segments (CIDR/VLAN pairs)
- **NSX:** 3-node NSX Manager cluster + VIP FQDN, appliance size, root/admin/audit/CLI passwords, transport VLAN ID, TEP pool name/description/CIDR/gateway, TEP IP range start/end, overlay zone name, transport type (OVERLAY/VLAN)
- **Storage:** vSAN ESA (NVMe device paths per host) / vSAN OSA (cache + capacity per disk group) / NFS (server IP/FQDN, export path, datastore name) / VMFS-FC (LUN WWN, datastore name); FTT; dedup+compression toggle
- **Operations:** VCF Operations admin password + appliance size; **Fleet Management** hostname + root/admin passwords; Operations Collector hostname, root password, appliance size
- **Automation** (optional): include toggle, appliance FQDN, node prefix, node 1–3 IPs, upgrade reserve IP, internal cluster CIDR, admin password

**Output:** *"a single JSON document that matches the VCF Installer schema"*. **The exact emitted key names are not published** and I could not retrieve the bundle (host blocked by egress policy; the help page describes fields, not keys). **[UNVERIFIED — §6]**

**Gaps for 9.1:** the presence of a distinct **"Fleet Management"** section with hostname + passwords maps to the **9.0-era `vcfOperationsFleetManagementSpec`**, which is **removed in 9.1**. It also has no `vspClusterSpec` (vSphere Supervisor / VCF Management Services runtime), no `vidbSpec`, no `licenseServerSpec`, no `vpcSpec`/DTGW, no LACP (`lagSpecs`), no dual-stack, and no non-contiguous IP pool support.

## 5.3 What "match or exceed" requires

| Capability | Raley | VirtualBytes | Your tool must |
|---|---|---|---|
| Full 9.1 `SddcSpec` (all 31 top-level keys) | No (~12) | Partial, 9.0-shaped | **Yes** |
| `vspClusterSpec` (VSP / VCFMS) | No | No | **Yes — mandatory in 9.1** |
| `vidbSpec`, `licenseServerSpec`, `fleetLcmSpec`, `sddcLcmSpec`, `fleetDepotSpec`, `saltSpec`, `saltRaasSpec`, `telemetryAcceptorSpec` | No | No | **Yes** |
| `vpcSpec` / `dtgwSpec` (VPC + Distributed TGW) | No | No | **Yes** |
| `lagSpecs` (LACP, new in 9.1 UI) | No | No | **Yes** |
| Dual-stack (`ipAddressVersion`, `ipv6Pool`, `internalClusterCidrIpv6`) | No | No | **Yes** |
| Non-contiguous IP pools (`addresses` / `excludedAddresses`) | No | No | **Yes** |
| Brownfield (`useExistingDeployment` + `sslThumbprint` per component) | No | No | **Yes — major differentiator** |
| Rejects removed `vcfOperationsFleetManagementSpec` | **Yes** | No (emits its 9.0 equivalent) | **Yes** |
| vDS profile presets (Default / Storage Sep / NSX Sep / Both / Custom) | No | Partial | **Yes** |
| IP/FQDN count calculator (12–30 VCFMS, 5 Automation, per-host ×3) | No | No | **Yes** |
| Call `POST /v1/sddcs/validations` + `/resources-calculation` | No | No | **Yes — strong differentiator** |

---

# 6. UNVERIFIED / NEEDS CONFIRMATION

Ordered by risk to a tool that generates real deployment configs.

### Blocking — must confirm before shipping

1. **The official TechDocs page "Use a JSON Specification File to Deploy VCF or VVF" (9.1) was unreachable.** Six attempts, all returned HTTP 403 from the fetch proxy (other TechDocs pages loaded fine, so this is an access artifact, not a dead link). URL: `techdocs.broadcom.com/.../9-1/deployment/deploying-a-new-vmware-cloud-foundation-or-vmware-vsphere-foundation-private-cloud-/use-a-json-specification-to-deploy-vmware-cloud-foundation-or-vmware-vsphere-foundation.html`. **Everything in §1 comes from the API reference and a real working spec instead. Read this page before shipping.**

2. **Undocumented-but-accepted fields.** `vspClusterSpec.name`, `fleetLcmSpec.hostname`, `sddcLcmSpec.hostname` appear in a working 9.1.0.0 spec but are **absent from the published data structures**. I cannot tell whether they are required, optional-but-honoured, or silently ignored. **Confirm against a live Installer via `POST /v1/sddcs/validations`.**

3. **`vlanId` / `transportVlanId` type.** Schema says `integer(int32)`; the working spec uses **strings**. Unknown whether integers are equally accepted (very likely) — but unknown whether *either* is rejected in some 9.1.x patch. **Test both.**

4. **`vcfAutomationSpec.ipPool` size.** TechDocs says **5 IPs** (3 active + 2 buffer); the working spec supplies **6**. Unresolved.

5. **`VsanSpec.failuresToTolerate` default.** One API rendering says *"default: 3"*, another says *min 0 / max 3* with no default. A default of 3 would be surprising (FTT=3 needs 7+ hosts). The working spec sets `1` explicitly. **Always emit this field explicitly; never rely on the default.**

6. **No downloadable JSON Schema / OpenAPI spec file located.** I found no `.json`/`.yaml` schema artifact. There may be a Swagger/OpenAPI document served by the Installer appliance itself (e.g. at `/v1/api-docs` or via the "REST API Index" / "Data Structures" links on the developer portal) — **not confirmed.** Worth checking on a live appliance; it would let you generate your form from the schema.

### Important gaps

7. **VCF Installer appliance's own resource requirements** (vCPU / RAM / disk / OVA filename). The 9.1 and 9.0 TechDocs pages both 403'd. One community source lists 4 vCPU / 16 GB but labels it "SDDC Manager (VCF Installer)", conflating two appliances — **do not trust it.**

8. **vSphere Supervisor / VSP cluster sizing per tier** (`small`, `small_ha`, `medium`, `large`): vCPU/RAM/disk not found. Only the ~40 vCPU / 82 GB aggregate "VCF Management Services" figure, which is community-sourced.

9. **VCF Identity Broker (`vidbSpec`) sizing** — not found. The `size` field exists but its enum is undocumented.

10. **License Server sizing** — only a community figure (2 vCPU / 4 GB).

11. **`FleetLcmServiceSpec.size` / `SddcLcmServiceSpec.size` / `VidbSpec.size` enum values** — the API documents the field as a bare `string` with description `"size"`. No enum published.

12. **vSAN ESA ReadyNode profile table** (ESA-AF-0/2/4/6/8: cores, RAM, NVMe count and size, NIC speed, raw capacity per node). `compatibilityguide.broadcom.com/pages/vsan-esa-readynode-hardware-guidance` is a JS application that returns no data to a fetcher. **Requires a real browser session.**

13. **Explicit minimum host count per cluster for a 9.1 VI workload domain** — not stated on the page I read. Historically 3 (vSAN) / 2 (external storage), and the convergence docs support 2-node vSAN ROBO, but I did not find a 9.1 statement for *new* VI WLD clusters.

14. **Max VCF instances / hosts / workload domains per fleet** — no fixed numbers published; governed by VCF Operations objects/metrics. The VMware Configuration Maximums tool is the stated authority and I did not query it.

15. **VCF Operations sizing table is from the 9.0 KB (397782).** I found no 9.1-specific revision. The 9.1 API enum matches 9.0's sizes, so it is probably unchanged — **not confirmed.**

16. **VirtualBytes builder's exact emitted JSON keys.** Its JS bundle is unreachable (`tools.virtualbytes.io` blocked by this session's egress policy; `curl` returned `CONNECT tunnel failed, 403`). Field *labels* are documented on its help page; key *names* are not. Also note the help page targets **9.0.2**, not 9.1.

17. **`SaltSpec`, `SaltRaasSpec`, `FleetDepotServiceSpec`, `TelemetryAcceptorSpec` field definitions** — not individually retrieved. The working spec passes them as empty objects `{}`, which appears sufficient.

18. **`NfsDatastoreSpec` / `VmfsDatastoreSpec` nested field details** were obtained second-hand via the `SddcDatastoreSpec` page rather than from their own pages. Field names (`nasVolume.serverName[]`, `path`, `readOnly`, `userTag`, `enableBindToVmknic`; `fcSpec[].datastoreName`) are **moderately confident, not fully verified.**

19. **`ResourcePoolSpec`, `EncryptionConfig`, `IPv6Pool`, `TransportZone`, `RootCaCerts`, `SddcCredentials`** — referenced and partially characterised, but their own pages were not fetched.

20. **Per-host memory "~1 TB" and "7 VLANs minimum"** are community figures with no official backing found. The official docs give no single per-host RAM minimum for the management domain beyond vSAN ESA's 128 GB floor.

### Deliberately not asserted

- I found **no license-key field anywhere in `SddcSpec`.** If your tool has a "license key" input, it does **not** belong in the deployment JSON — licensing is a post-deployment action in VCF Operations / Business Services Console. I am confident of this but flag it because it contradicts VCF 4.x/5.x muscle memory, where `licenseFile`/per-component license keys existed in the bring-up spec.
- The `workflowType` enum includes `VCF_COMPLETE`, `VCF_EXTEND` and `VCF_BOOTSTRAP` — **I found no documentation explaining what these mean or when to use them.** Only `VCF` and `VVF` are surfaced by the community builders. Do not expose the others without confirming semantics.

---

# Sources

**Official — Broadcom Developer Portal (VCF Installer API, 9.1.1 latest)**
- [VCF Installer API overview](https://developer.broadcom.com/xapis/vcf-installer-api/latest/)
- [Vcf Installer endpoint category](https://developer.broadcom.com/xapis/vcf-installer-api/latest/vcf-installer/)
- [POST /v1/sddcs](https://developer.broadcom.com/xapis/vcf-installer-api/latest/v1/sddcs/post/)
- [POST /v1/sddcs/resources-calculation](https://developer.broadcom.com/xapis/vcf-installer-api/latest/v1/sddcs/resources-calculation/post/)
- [POST /v1/sddcs/installer-mode](https://developer.broadcom.com/xapis/vcf-installer-api/latest/v1/sddcs/installer-mode/post/)
- [Data structures index](https://developer.broadcom.com/xapis/vcf-installer-api/latest/data-structures/)
- [SddcSpec](https://developer.broadcom.com/xapis/vcf-installer-api/latest/data-structures/SddcSpec/) · [SddcNetworkSpec](https://developer.broadcom.com/xapis/vcf-installer-api/latest/data-structures/SddcNetworkSpec/) · [SddcVcenterSpec](https://developer.broadcom.com/xapis/vcf-installer-api/latest/data-structures/SddcVcenterSpec/) · [SddcHostSpec](https://developer.broadcom.com/xapis/vcf-installer-api/latest/data-structures/SddcHostSpec/) · [SddcClusterSpec](https://developer.broadcom.com/xapis/vcf-installer-api/latest/data-structures/SddcClusterSpec/) · [SddcNsxtSpec](https://developer.broadcom.com/xapis/vcf-installer-api/latest/data-structures/SddcNsxtSpec/) · [NsxtManagerSpec](https://developer.broadcom.com/xapis/vcf-installer-api/latest/data-structures/NsxtManagerSpec/) · [DvsSpec](https://developer.broadcom.com/xapis/vcf-installer-api/latest/data-structures/DvsSpec/) · [NsxtSwitchConfig](https://developer.broadcom.com/xapis/vcf-installer-api/latest/data-structures/NsxtSwitchConfig/) · [TeamingSpec](https://developer.broadcom.com/xapis/vcf-installer-api/latest/data-structures/TeamingSpec/) · [VmnicToUplink](https://developer.broadcom.com/xapis/vcf-installer-api/latest/data-structures/VmnicToUplink/) · [LagSpec](https://developer.broadcom.com/xapis/vcf-installer-api/latest/data-structures/LagSpec/) · [SddcDatastoreSpec](https://developer.broadcom.com/xapis/vcf-installer-api/latest/data-structures/SddcDatastoreSpec/) · [VsanSpec](https://developer.broadcom.com/xapis/vcf-installer-api/latest/data-structures/VsanSpec/) · [VsanEsaConfig](https://developer.broadcom.com/xapis/vcf-installer-api/latest/data-structures/VsanEsaConfig/) · [SddcManagerSpec](https://developer.broadcom.com/xapis/vcf-installer-api/latest/data-structures/SddcManagerSpec/) · [DnsSpec](https://developer.broadcom.com/xapis/vcf-installer-api/latest/data-structures/DnsSpec/) · [SecuritySpec](https://developer.broadcom.com/xapis/vcf-installer-api/latest/data-structures/SecuritySpec/) · [IpAddressPoolSpec](https://developer.broadcom.com/xapis/vcf-installer-api/latest/data-structures/IpAddressPoolSpec/) · [IPv4Pool](https://developer.broadcom.com/xapis/vcf-installer-api/latest/data-structures/IPv4Pool/) · [VpcSpec](https://developer.broadcom.com/xapis/vcf-installer-api/latest/data-structures/VpcSpec/) · [SddcVspClusterSpec](https://developer.broadcom.com/xapis/vcf-installer-api/latest/data-structures/SddcVspClusterSpec/) · [VcfOperationsSpec](https://developer.broadcom.com/xapis/vcf-installer-api/latest/data-structures/VcfOperationsSpec/) · [VcfOperationsNode](https://developer.broadcom.com/xapis/vcf-installer-api/latest/data-structures/VcfOperationsNode/) · [VcfOperationsCollectorSpec](https://developer.broadcom.com/xapis/vcf-installer-api/latest/data-structures/VcfOperationsCollectorSpec/) · [VcfAutomationSpec](https://developer.broadcom.com/xapis/vcf-installer-api/latest/data-structures/VcfAutomationSpec/) · [VcfManagementComponentsInfrastructureSpec](https://developer.broadcom.com/xapis/vcf-installer-api/latest/data-structures/VcfManagementComponentsInfrastructureSpec/) · [LicenseServerSpec](https://developer.broadcom.com/xapis/vcf-installer-api/latest/data-structures/LicenseServerSpec/) · [VidbSpec](https://developer.broadcom.com/xapis/vcf-installer-api/latest/data-structures/VidbSpec/) · [FleetLcmServiceSpec](https://developer.broadcom.com/xapis/vcf-installer-api/latest/data-structures/FleetLcmServiceSpec/) · [SddcLcmServiceSpec](https://developer.broadcom.com/xapis/vcf-installer-api/latest/data-structures/SddcLcmServiceSpec/) · [CapacityValidation](https://developer.broadcom.com/xapis/vcf-installer-api/latest/data-structures/CapacityValidation/)
- [Vcenter Inventory Datastore (vSphere Automation API)](https://developer.broadcom.com/xapis/vsphere-automation-api/latest/api/vcenter/inventory/datastore/get/) · [vSphere Web Services API](https://developer.broadcom.com/xapis/vsphere-web-services-api/latest/) · [VCF PowerCLI](https://developer.broadcom.com/powercli)

**Official — Broadcom TechDocs (VCF 9.1)**
- [Deployment, Convergence, and Upgrade (9.1)](https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-1/deployment.html)
- [Deploy a New VCF Fleet or VCF Instance — Installer wizard](https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-1/deployment/deploying-a-new-vmware-cloud-foundation-or-vmware-vsphere-foundation-private-cloud-/deploy-a-new-vcf-fleet-or-a-new-vcf-instance.html)
- [Use a JSON Specification File to Deploy VCF/VVF (9.1)](https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-1/deployment/deploying-a-new-vmware-cloud-foundation-or-vmware-vsphere-foundation-private-cloud-/use-a-json-specification-to-deploy-vmware-cloud-foundation-or-vmware-vsphere-foundation.html) — **could not fetch (403)**
- [Deploy VCF Installer (9.1)](https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-1/deployment/deploying-a-new-vmware-cloud-foundation-or-vmware-vsphere-foundation-private-cloud-/preparing-your-environment/deploy-the-vmware-cloud-foundation-installer-appliance.html) — **could not fetch (403)**
- [Converging Existing vSphere Infrastructure to VCF/VVF (9.1)](https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-1/deployment/converging-your-existing-vsphere-infrastructure-to-a-vcf-or-vvf-platform-.html)
- [Supported and Not Supported Configurations to Converge (9.1)](https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-1/deployment/converging-your-existing-vsphere-infrastructure-to-a-vcf-or-vvf-platform-/supported-and-not-supported-configurations.html)
- [Supported Components and Scenarios to Converge (9.1)](https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-1/deployment/converging-your-existing-vsphere-infrastructure-to-a-vcf-or-vvf-platform-/supported-scenarios-to-converge-to-vcf.html)
- [Upgrading to VCF 9.1](https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-1/deployment/upgrading-cloud-foundation.html) · [Upgrade Sequence to 9.1](https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-1/release-notes/vmware-cloud-foundation-9-1-0-0-release-notes/upgrade-sequence-to-91.html) · [Deploy VCF Management Services as Part of Upgrade](https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-1/deployment/upgrading-cloud-foundation/deploy-vcf-management-services.html)
- [What's New — VCF Installer (9.1)](https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-1/release-notes/vmware-cloud-foundation-9-1-0-0-release-notes/what-s-new/whats-new-installer.html) · [What's New — CLI/API/SDK (9.1)](https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-1/release-notes/vmware-cloud-foundation-9-1-0-0-release-notes/what-s-new/whats-new-vcf-cli-api-sdk.html)
- [Licensing Model (9.1)](https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-1/licensing/licensing-overview/licensing-model.html) · [Licensing Overview (9.1)](https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-1/licensing/licensing-overview.html)
- [VCF Fleet Sizing Models (9.1)](https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-1/design/vmware-cloud-foundation-concepts/vcf-fleet-sizing-models-9-x.html) · [VCF Fleet Deployment Models (9.1)](https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-1/design/vmware-cloud-foundation-concepts/vcf-operations-deployment-models.html)
- [First VCF Instance FQDNs and IP Addresses (9.1)](https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-1/planning-and-preparation/vcf-components-fqdns-and-ip-addresses/first-vcf-instance-fqdns-and-ip-addresses.html) · [Planning and Preparation Workbook](https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-0/planning-and-preparation.html)
- [Hardware Requirements for vSAN (9.1)](https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-1/vsan-deployment-administration-and-monitoring/vsan-planning-and-deployment/requirements-for-creating-a-virtual-san-cluster/hardware-requirements-for-virtual-san.html)
- [Configure Centralized Network Connectivity with Edge Clusters (9.1)](https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-1/building-your-private-cloud-infrastructure/managing-network-connectivity-in-vcenter/managing-centralized-network-connectivity-with-edge-clusters.html)
- [Create a New Workload Domain (9.1)](https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-1/building-your-private-cloud-infrastructure/working-with-workload-domains/deploy-a-vi-workload-domain-using-the-sddc-manager-ui.html) · [Import an Existing vCenter to Create a Workload Domain (9.0)](https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-0/building-your-private-cloud-infrastructure/working-with-workload-domains/import-an-existing-vcenter-to-create-a-workload-domain.html)

**Official — Broadcom KB**
- [KB 392993 — Minimum ESXi hosts on vSAN for VCF Management Domain](https://knowledge.broadcom.com/external/article/392993/minimum-number-of-esxi-hosts-required-on.html)
- [KB 397782 — VCF Operations 9.0 Sizing Guidelines](https://knowledge.broadcom.com/external/article/397782/vcf-operations-90-sizing-guidelines.html)
- [KB 440630 — Upgrade Sequence and Related Issues for VCF/VVF 9.1](https://knowledge.broadcom.com/external/article/440630/upgrade-sequence-and-related-issues-for.html)
- [KB 424770 — Retry VCF 9.0 Installer workflow by modifying the deployment workflow JSON SPEC](https://knowledge.broadcom.com/external/article/424770/retry-vcf-90-installer-workflow-by-modif.html)
- [KB 403604 — Changing the form factor of NSX Manager in VCF](https://knowledge.broadcom.com/external/article/403604/changing-the-form-factor-of-nsx-manager.html)

**Official — VMware/Broadcom blogs and papers**
- [Deployment Pathways for VMware Cloud Foundation 9](https://blogs.vmware.com/cloud-foundation/2025/07/03/vcf-9-0-deployment-pathways/)
- [How to Converge a vSphere Environment to VCF 9.0](https://blogs.vmware.com/cloud-foundation/2026/02/05/how-to-converge-a-vmware-vsphere-environment-to-vmware-cloud-foundation-9-0/)
- [Auto-RAID in vSAN for VCF 9.1](https://blogs.vmware.com/cloud-foundation/2026/05/08/auto-raid-in-vsan-for-vcf-9-1/)
- [Demystifying VCF PowerCLI 9.0 SDK](https://blogs.vmware.com/cloud-foundation/2025/07/02/demystifying-vcf-powercli-9-0-sdk/)
- [vSAN Design Guide](https://www.vmware.com/docs/vmware-vsan-design-guide)
- [vSAN ESA ReadyNode Hardware Guidance](https://compatibilityguide.broadcom.com/pages/vsan-esa-readynode-hardware-guidance) — **could not extract (JS app)**

**Community**
- [lamw/vcf-91-in-box](https://github.com/lamw/vcf-91-in-box) — **source of the complete working 9.1.0.0 SddcSpec**
- [William Lam — Additional IP allocation options for VCFMS in 9.1](https://williamlam.com/2026/05/vcf-9-1-additional-ip-allocation-options-for-vcf-management-services-vcfms-in-vcf-installer-and-sddc-manager.html) · [Demystifying Supported Upgrade Paths to 9.1](https://williamlam.com/2026/05/vcf-9-1-demystifying-supported-upgrade-paths-to-9-1.html) · [Installer & SDDC Manager Lab Workarounds](https://williamlam.com/2026/05/vcf-9-1-comprehensive-vcf-installer-sddc-manager-configuration-workarounds-for-lab-deployments.html) · [How many VCF Instances can a VCF Fleet support?](https://williamlam.com/2025/10/how-many-vmware-cloud-foundation-vcf-instances-can-a-vcf-fleet-support.html)
- [driftar — VCF 9 Appliance Sizing (non-official)](https://www.driftar.ch/2026/02/20/vcf-9-appliance-sizing-information/)
- [Leaha's Blog — VCF 9.1.x Ultimate Deployment Guide](https://blog.leaha.co.uk/2026/05/06/vcf-9-1-x-ultimate-deployment-guide/)
- [VCF 9.1 Deployment Planning — Prerequisites](https://vcf-planning.hollebollevsan.nl/docs/prerequisites/)
- [Digital Thought Disruption — Minimum Viable VCF 9.1](https://digitalthoughtdisruption.com/2026/07/26/minimum-viable-vcf-9-1-infrastructure-operational-footprint/) · [Brownfield vSphere to VCF 9.1](https://digitalthoughtdisruption.com/2026/07/25/brownfield-vsphere-vcf-9-1-import-converge-rebuild/)
- [Devyn Harrington — Deploying a Complete VCF 9.1 Management Domain](https://devynharrington.com/homelab/deploying-a-complete-vcf-9-1-management-domain-nested-esxi-nsx-recovery-and-automation/)
- [Cloud Blogger — VCF Automation 9 Sizing Matrix](https://cloudblogger.co.in/2026/04/10/vcf-automation-9-sizing-matrix/)
- [Tom Fojta — VCF 9 Importing Brownfield Environment](https://fojta.wordpress.com/2025/07/10/vcf-9-importing-brownfield-environment/)
- [virtualFrog/Invar — RVTools-compatible inventory exporter](https://github.com/virtualFrog/Invar)
- [Azure Migrate — RVTools XLSX required sheets/columns](https://learn.microsoft.com/en-us/azure/migrate/tutorial-import-vmware-using-rvtools-xlsx?view=migrate)

**The two builders analysed**
- [Justin Raley VCF JSON Builder](https://justinraley.com/wp-content/plugins/WordPress-VCF-JSON-Builder/app/index.html?ver=1.0.4) (logic: `app/app.js`, `app/core.js`)
- [VirtualBytes VCF JSON Builder](https://tools.virtualbytes.io/vcf-json-builder) · [its help page](https://tools.virtualbytes.cloud/help/vcf-json-builder) · [VCF Upgrade Path Advisor](https://tools.virtualbytes.io/vcf-upgrade-advisor)

---

**Access note:** `justinraley.com` and `tools.virtualbytes.io` are blocked for direct `curl` by this session's egress policy (403 on CONNECT); I retrieved them through WebFetch instead. The one TechDocs page on JSON specifications returned 403 through WebFetch on all six attempts while neighbouring TechDocs pages succeeded — treat that as the single most important gap to close.agentId: a7a18cb59588c2b44 (use SendMessage with to: 'a7a18cb59588c2b44', summary: '<5-10 word recap>' to continue this agent)
<usage>subagent_tokens: 212868
tool_uses: 134
duration_ms: 1364070</usage>