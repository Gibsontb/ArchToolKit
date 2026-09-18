I have what I need. Here's the report.

---

# VCF 9.1 Installer `SddcSpec` — Extracted Schema

**Sources actually reached:**
- `developer.broadcom.com/xapis/vcf-installer-api/` — **worked** for both `latest` (= 9.1.1) and version-pinned `9.1` paths. All data-structure pages fetched individually.
- `github.com/lamw/vcf-91-in-box` — **worked** (branch is `master`, not `main`). All three example specs retrieved in full.
- **TechDocs "Use a JSON Specification File…" — FAILED, 4 attempts, HTTP 403 from the egress proxy (organization policy denial, not a site error).** Tried: the 9.1 path, the 9.0 path, `?print=true`, and the `vcf-9-1-and-later` path shape (404). The PDF asset path 404'd. Sibling TechDocs pages under the same tree *do* load, so this is a per-page/policy block, not a host block. **Nothing in this report is sourced from TechDocs.**
- Broadcom-published OpenAPI/Swagger JSON for the *Installer* — **not found** anywhere public. (A community repo has `sddc-manager-openapi.json`, which is a **different API** — see the trap in §H.)
- Direct `curl` to both developer.broadcom.com and raw.githubusercontent.com is blocked by proxy policy (403 on CONNECT); WebFetch was the only working path.

**Verification legend:** `[V-API]` Broadcom API reference · `[V-SPEC]` real working deployed spec · `[C]` community · `[I]` inferred — *no field name in this report is guessed.*

**Version note:** I diffed pinned `9.1` against `latest` (9.1.1). **Top-level `SddcSpec` is field-identical.** One meaningful difference: the 9.1 pages render real numeric bounds, while the 9.1.1 pages render `maximum: 9223372036854776000` (a float artifact of int64 max) for integer fields. **Trust the 9.1 bounds.**

---

## A. `SddcHostSpec` — the answer is: there is nothing else

This is the most important finding, and it's a negative result. I verified it on **both** the 9.1.1 and the version-pinned 9.1 pages, and against three working specs.

```
SddcHostSpec                                                      [V-API 9.1 + 9.1.1]
  hostname       string    REQUIRED   minLength:0  maxLength:63
                           pattern: ^(([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9\-]*[a-zA-Z0-9])\.)*([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9\-]*[A-Za-z0-9])$
                           "ESX hostname. This value will be prefixed to the DNS subdomain
                            name and should not include the domain name itself. Must also
                            adhere to RFC 1123 naming conventions"
  credentials    SddcCredentials   optional
  sshThumbprint  string    optional
                           "ESX host SSH thumbprint (RSA SHA256) in new deployment scenario
                            or ESX host SSH key (RSA, ECDSA) in reuse existing deployment scenario"
  sslThumbprint  string    optional   "ESX host SSL thumbprint (SHA256)"

SddcCredentials                                                            [V-API]
  username   string   optional
  password   string   REQUIRED
```

**That is the entire structure — four fields.** Answering your specific questions:

- **Per-host management IP:** does not exist. The host's management IP comes from DNS resolution of `hostname` + `dnsSpec.subdomain`. Hosts must be pre-configured and resolvable before the run.
- **Per-host vMotion / vSAN IPs:** **only** via `networkSpecs[].includeIpAddressRanges` (or `includeIpAddress`). The installer allocates from the pool; you cannot pin a specific IP to a specific host. Confirmed by all three working specs, which supply VMOTION/VSAN purely as ranges.
- **Per-host disk / device selection:** **does not exist in the VCF Installer 9.1 API at all.** I pulled the complete data-structure index (~190 types) — there is no `VsanDiskGroupSpec`, no `HostDiskSpec`, no disk/device type of any kind. vSAN ESA NVMe claiming is **fully automatic**, controlled by exactly two booleans at the cluster level (`datastoreSpec.vsanSpec.esaConfig`), not per host.
- **OSA cache + capacity disk groups:** **not expressible in the Installer JSON.** There is no structure for it. (`SddcNetworkConfigProfileSpec.storageType` has a `VSAN` value distinct from `VSAN_ESA`, so OSA is selectable as a *mode*, but the disk-group layout itself has no schema — it's automatic or a day-N SDDC Manager operation.)
- **`hostNetworkSpec` / `vmknics` array / per-host vSwitch config:** **none exist.** All switch/uplink config is cluster-wide in `dvsSpecs[]`. Note `SddcPhysicalNic` exists but is **read-only output** on `SddcNetworkConfigProfileResponse`, not an input.

**Thumbprint formats** (verbatim from the API reference example):
```
sshThumbprint: "SHA256:rVPNWOKE2tZjvmYvKPhtc3ghJ41Vc0G3MwASf4+8+yc"
sslThumbprint: "3D:D0:EE:B5:A0:CC:45:08:5C:4F:84:51:CD:00:B6:41:BB:4A:A2:9A:77:1C:A6:4C:6D:84:5A:D0:4F:68:7A:B8"
```
`sshThumbprint` = `SHA256:` + unpadded base64. `sslThumbprint` = colon-separated uppercase hex, 32 octets (SHA256). Both omittable when `skipEsxThumbprintValidation: true` — all three working specs do exactly that.

---

## B. Dual-stack / IPv6 — exact fields

IPv6 is **not** a global toggle. It appears in exactly three places, and there is **no** `ipv6Pool`, `ipv6Gateway` or `ipv6Prefix` on `SddcNetworkSpec`.

```
SddcNetworkSpec (per network)                                     [V-API 9.1 + 9.1.1]
  ipAddressVersion         string   optional   default: IPv4
                                    enum: IPv4 | IPv6
  ipAddressAssignmentMode  string   optional   default: STATIC
                                    enum: STATIC | DHCP | SLAAC
```
For an IPv6 network you set `ipAddressVersion: "IPv6"` and reuse the **same** `subnet` / `gateway` / `includeIpAddressRanges` fields with IPv6 values. There are no separate v6 fields here. (Caveat: `gateway` carries `maxLength:15` and `subnet` `maxLength:18` — sized for IPv4. Whether the server enforces these for IPv6 is **unverified**.)

```
SddcVspClusterSpec                                                         [V-API]
  ipv4Pool                 IPv4Pool   REQUIRED
  ipv6Pool                 IPv6Pool   optional
  internalClusterCidrIpv4  string     optional  default: 198.18.0.0/15
                           supported: 198.18.0.0/15, 240.0.0.0/15, 250.0.0.0/15
  internalClusterCidrIpv6  string     optional  default: fd00::/111
                           supported: fd00::/111, fd00::0/111, fc00::/111,
                                      fc00::0/111, fc00::4:0/111, fc00::0004:0/111

IPv6Pool                                                                   [V-API]
  cidr               string           optional   e.g. "2001:db8::00/112"
  ipRange            IpRangeV6        optional
  addresses          array[string]    optional
  excludedAddresses  array[string]    optional   "Applies to range and CIDR"

IPv4Pool                                                                   [V-API]
  cidr               string           optional
  ipRange            IpRange          optional
  addresses          array[string]    optional
  excludedAddresses  array[string]    optional
  CONSTRAINT: one of {addresses, ipRange, cidr} is REQUIRED

IpRangeV6                                                                  [V-API]
  startIpAddress   string   REQUIRED   minLength:2  maxLength:39
  endIpAddress     string   REQUIRED   minLength:2  maxLength:39

IpRange                                                                    [V-API]
  startIpAddress   string   REQUIRED   minLength:7  maxLength:15
  endIpAddress     string   REQUIRED   minLength:7  maxLength:15
```

```
VcfManagementComponentsNetworkSpec                                         [V-API]
  networkName   string          REQUIRED   minLength:1
  subnetMask    string          REQUIRED   minLength:7  maxLength:15
  gateway       string          REQUIRED   minLength:7  maxLength:15
  ipv6Gateway   string          optional
  ipv6Prefix    integer(int32)  optional   min:0
```
Note `subnetMask` and `gateway` are **required even on an IPv6-only deployment** — there is no v6-only variant.

**Not IPv6-capable:** `vcfAutomationSpec` has only `internalClusterCidr` (no v6 twin) and `ipPool` (plain string array). `nsxtSpec.ipAddressPoolSpec` subnets are **IPv4-only** — the `cidr` pattern is a hard IPv4 dotted-quad regex.

---

## C. `SecuritySpec` — full definition

```
SecuritySpec                                                               [V-API]
  esxiCertsMode   string             optional   enum: Custom | VMCA
  rootCaCerts     array[RootCaCerts] optional   "Root Certificate Authority certificate list"

RootCaCerts                                                                [V-API]
  alias       string          optional   "Certificate alias"
  certChain   array[string]   optional   "List of Base64 encoded certificates"
```
Both enum values are case-sensitive as shown: `Custom` and `VMCA` (mixed case — *not* `CUSTOM`). Canonical example uses `"esxiCertsMode": "VMCA"`.

---

## D. Remaining nested definitions

### The five "service" specs — all identical, all `{version, size}` only

```
FleetLcmServiceSpec       version: string optional · size: string optional    [V-API]
SddcLcmServiceSpec        version: string optional · size: string optional    [V-API]
FleetDepotServiceSpec     version: string optional · size: string optional    [V-API]
TelemetryAcceptorSpec     version: string optional · size: string optional    [V-API]
SaltSpec                  version: string optional · size: string optional    [V-API]
```
`saltRaasSpec` is typed **`SaltSpec`** (not a separate `SaltRaasSpec` type) — confirmed on both 9.1 and 9.1.1. **Neither `FleetLcmServiceSpec` nor `SddcLcmServiceSpec` has a `hostname` field in the published schema** — see §H.

```
VidbSpec                                                                   [V-API]
  hostname   string   REQUIRED   minLength:1   "VIDB hostname."
  version    string   optional
  size       string   optional   <-- enum NOT published; example value "small"
```
**The `size` enum you asked for is not documented.** I checked both 9.1 and 9.1.1 pages; the description is literally just `"size"` with no enum list. Only `"small"` is attested (from the canonical example). See STILL UNVERIFIED.

```
LicenseServerSpec                                                          [V-API]
  hostname               string    REQUIRED
  version                string    optional
  useExistingDeployment  boolean   optional
  sslThumbprint          string    optional

NfsDatastoreSpec                                                           [V-API]
  datastoreName   string         optional   minLength:0  maxLength:80
  nasVolume       NasVolumeSpec  REQUIRED

NasVolumeSpec                                                              [V-API]
  serverName          array[string]  REQUIRED   minItems:1
  path                string         REQUIRED   minLength:1
  readOnly            boolean        REQUIRED
  userTag             string         optional
  enableBindToVmknic  boolean        optional

VmfsDatastoreSpec                                                          [V-API]
  fcSpec   array[FcSpec]   optional

FcSpec                                                                     [V-API]
  datastoreName   string   optional   minLength:0  maxLength:80

ResourcePoolSpec  (all fields optional)                                    [V-API]
  name                          string          minLength:0  maxLength:80
  type                          string          enum: management | compute | network
  cpuReservationPercentage      integer(int32)  min:0  max:100
  cpuReservationMhz             integer(int64)
  cpuLimit                      integer(int64)
  cpuReservationExpandable      boolean
  cpuSharesLevel                string
  cpuSharesValue                integer(int32)
  memoryReservationPercentage   integer(int32)  min:0  max:100
  memoryReservationMb           integer(int64)
  memoryLimit                   integer(int64)
  memoryReservationExpandable   boolean
  memorySharesLevel             string
  memorySharesValue             integer(int32)
```
Note on `resourcePoolSpecs`: *"If blank, no resource pools will be created. However, if you want to create resource pool, Management Resource Pool is required to be present in the list."*

```
EncryptionConfig                                                           [V-API]
  dataInTransitConfig   DataInTransitConfig   optional

DataInTransitConfig                                                        [V-API]
  enable          boolean         REQUIRED   "Enable vSAN DIT encryption"
  rekeyInterval   integer(int32)  optional   min:0
                  "Periodical rekeying interval in minutes for vSAN DIT encryption"

TransportZone                                                              [V-API]
  name            string   optional   minLength:0  maxLength:255
  transportType   string   REQUIRED   minLength:1   enum: VLAN | OVERLAY

VcfManagementComponentsInfrastructureSpec                                  [V-API]
  localRegionNetwork   VcfManagementComponentsNetworkSpec   optional
  xRegionNetwork       VcfManagementComponentsNetworkSpec   optional
```
`SddcCredentials` and `VcfManagementComponentsNetworkSpec` are in §A and §B above.

> **Operational note on `vcfManagementComponentsInfrastructureSpec` [C]:** William Lam reports that `localRegionNetwork` was originally required but *"just confirmed with Engr that is no longer the case and only xRegion is needed."* He also reports the network must be **VLAN-backed** (NSX overlay is not supported for VCFMS runtime components). Community, not Broadcom-documented.

### Storage & cluster

```
SddcDatastoreSpec                                                          [V-API]
  nfsDatastoreSpec       NfsDatastoreSpec    optional
  vmfsDatastoreSpec      VmfsDatastoreSpec   optional
  vsanSpec               VsanSpec            optional
  existingDatastoreName  string              optional

VsanSpec                                                                   [V-API]
  datastoreName        string            optional   minLength:0  maxLength:80
  vsanDedup            boolean           optional
  esaConfig            VsanEsaConfig     optional
  encryptionConfig     EncryptionConfig  optional
  failuresToTolerate   integer(int32)    optional   min:0  max:3

VsanEsaConfig                                                              [V-API]
  enabled                boolean   optional
  skipHclAutoDiskClaim   boolean   optional
      "Whether to enable or disable vSAN auto disk claim for vSAN ESA cluster"

SddcClusterSpec                                                            [V-API]
  datacenterName      string                  optional  minLength:0 maxLength:80
  clusterName         string                  optional  minLength:0 maxLength:80
  clusterEvcMode      string                  optional
      enum: INTEL_MEROM, INTEL_PENRYN, INTEL_NEALEM, INTEL_WESTMERE,
            INTEL_SANDYBRIDGE, INTEL_IVYBRIDGE, INTEL_HASWELL, INTEL_BROADWELL,
            INTEL_SKYLAKE, INTEL_CASCADELAKE, INTEL_ICELAKE, INTEL_SAPPHIRERAPIDS,
            AMD_REV_E, AMD_REV_F, AMD_GREYHOUND_NO3DNOW, AMD_GREYHOUND,
            AMD_BULLDOZER, AMD_PILEDRIVER, AMD_STREAMROLLER,
            AMD_ZEN, AMD_ZEN2, AMD_ZEN3, AMD_ZEN4
  resourcePoolSpecs   array[ResourcePoolSpec] optional
```
Note `INTEL_NEALEM` — that misspelling is verbatim from Broadcom, reproduce it exactly.

### Appliance specs

```
SddcVcenterSpec                                                            [V-API]
  vcenterHostname        string   REQUIRED   minLength:0  maxLength:63
  rootVcenterPassword    string   REQUIRED   minLength:8  maxLength:20
                         15-20 chars for NEW deployments, 8-20 for existing
  vmSize                 string   optional   enum: xlarge|large|medium|small|tiny
  storageSize            string   optional   enum: lstorage|xlstorage
  ssoDomain              string   optional
  adminUserSsoUsername   string   optional   minLength:1
  adminUserSsoPassword   string   optional   minLength:8   special chars [!$%^]
  version                string   optional
  useExistingDeployment  boolean  optional
  sslThumbprint          string   optional
```
**There is no vCenter IP field** — resolved via DNS.

```
SddcManagerSpec                                                            [V-API]
  hostname               string   REQUIRED   minLength:0  maxLength:63
  rootPassword           string   optional   minLength:15   special [!%@$^#?*]
  sshPassword            string   optional   minLength:15   special [!%@$^#?*]  ('vcf' user)
  localUserPassword      string   optional   minLength:12   special [!%@$^#?*]
  version                string   optional
  useExistingDeployment  boolean  optional
  sslThumbprint          string   optional

SddcNsxtSpec                                                               [V-API]
  nsxtManagers                          array[NsxtManagerSpec]  REQUIRED
  vipFqdn                               string    REQUIRED   minLength:1
  nsxtManagerSize                       string    optional   default: medium
                                                  enum: medium | large | xlarge
  rootNsxtManagerPassword               string    optional   minLength:12
  nsxtAdminPassword                     string    optional   minLength:12
  nsxtAuditPassword                     string    optional   minLength:12
  transportVlanId                       integer(int32)  optional  default: 0
  ipAddressPoolSpec                     IpAddressPoolSpec   optional
  vpcSpec                               VpcSpec             optional
  skipNsxOverlayOverManagementNetwork   boolean   optional
  enableEdgeClusterSync                 boolean   optional
  overlayVtepSpec                       OverlayVtepSpec     optional
  version                               string    optional
  useExistingDeployment                 boolean   optional
  sslThumbprint                         string    optional

NsxtManagerSpec       hostname: string optional                            [V-API]
OverlayVtepSpec       vtepType: string optional  enum: NO_IP               [V-API]
                      (NO_IP disables VTEP creation)

VpcSpec                                                                    [V-API]
  vpcNetworkConfigurationType  string   optional  default: FULL_STACK_VPC
      VpcSpec page enum:      VLAN_BACKED_VPC | FULL_STACK_VPC
      SddcSpec example enum:  VLAN_BACKED_VPC | FULL_STACK_VPC
                              | VPC_UNSUPPORTED | INVALID_TYPE
  dtgwSpec                     DtgwSpec optional

DtgwSpec                                                                   [V-API]
  vlan                   integer(int64)  REQUIRED
  gatewayCidr            string  REQUIRED   IPv4 CIDR pattern
  externalIpBlockCidr    string  REQUIRED   IPv4 CIDR pattern
  privateTgwIpBlockCidr  string  optional   IPv4 CIDR pattern

IpAddressPoolSpec                                                          [V-API]
  name                          string  REQUIRED  minLength:1  pattern ^[a-zA-Z0-9-_]+$
  description                   string  optional
  ignoreUnavailableNsxtCluster  boolean optional
  subnets                       array[IpAddressPoolSubnetSpec]  optional

IpAddressPoolSubnetSpec                                                    [V-API]
  ipAddressPoolRanges  array[IpAddressPoolRangeSpec]  REQUIRED  minItems:1
  cidr                 string  REQUIRED  minLength:1  IPv4 dotted-quad pattern
  gateway              string  REQUIRED  minLength:1

IpAddressPoolRangeSpec                                                     [V-API]
  start  string  REQUIRED  minLength:1  IPv4 pattern
  end    string  REQUIRED  minLength:1  IPv4 pattern
```
Note the asymmetry: `IpRange` uses `startIpAddress`/`endIpAddress`; `IpAddressPoolRangeSpec` (NSX TEP pool) uses `start`/`end`. Easy to get wrong.

```
VcfOperationsSpec                                                          [V-API]
  nodes                  array[VcfOperationsNode]  REQUIRED  minItems:1 maxItems:3
  adminUserPassword      string   optional   minLength:8
  applianceSize          string   optional   default: medium
                         enum: xsmall|small|medium|large|xlarge
                         (xsmall/small unavailable in HA mode)
  loadBalancerFqdn       string   optional
  useExistingDeployment  boolean  optional
  version                string   optional

VcfOperationsNode                                                          [V-API]
  hostname          string  REQUIRED  minLength:1
  rootUserPassword  string  optional  minLength:15
  type              string  optional  enum: master | replica | data
  sslThumbprint     string  optional

VcfOperationsCollectorSpec                                                 [V-API]
  hostname               string   REQUIRED  minLength:1
  rootUserPassword       string   optional  minLength:15
  applianceSize          string   optional  enum: small | standard
  version                string   optional
  useExistingDeployment  boolean  optional
  sslThumbprint          string   optional

VcfAutomationSpec                                                          [V-API]
  hostname               string         REQUIRED
  internalClusterCidr    string         REQUIRED
  platformFqdn           string         optional (required unless useExistingDeployment)
  adminUserPassword      string         optional  minLength:15
  ipPool                 array[string]  optional
  nodePrefix             string         optional  minLength:0 maxLength:57
                                        pattern: ^[a-z0-9][a-z0-9-]*[a-z0-9]$
  size                   string         optional
  version                string         optional
  useExistingDeployment  boolean        optional
  sslThumbprint          string         optional

DnsSpec                                                                    [V-API]
  subdomain     string         REQUIRED  minLength:1
                pattern: ^(([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9\-]*[a-zA-Z0-9])\.)*([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9\-]*[A-Za-z0-9])$
                "Tenant Sub domain. Includes the full domain suffix"
  nameservers   array[string]  optional  MAX 2 ENTRIES; first is primary
```

---

## E. `managementPoolName`

Verbatim from the API reference:

> **"Name for the network pool to be created and associated with the Management Cluster"**  `[V-API]`

Type `string`, optional, **no stated length or pattern constraint**. It names the SDDC Manager *network pool* object (the vMotion/vSAN IP-pool container used for day-N host commissioning), auto-generated if omitted. **All three working specs omit it entirely**, so it is safe to leave out. Canonical example shows only the placeholder `"string"`.

---

## F. Per-traffic-type teaming / uplink config

This maps into **two different, independent places**, with **different enum vocabularies**. This is the single easiest thing to get wrong.

**1. vSphere DVS teaming — per traffic type, on `networkSpecs[]`:** `[V-API]`
```
teamingPolicy    string  optional  default: loadbalance_loadbased
      enum (lowercase): loadbalance_ip | loadbalance_srcmac | loadbalance_srcid
                        | failover_explicit | loadbalance_loadbased
      "Teaming Policy for VSAN and VMOTION network types"
activeUplinks    array[string]  optional
      "specify uplink1 for failover_explicit VSAN Teaming Policy"
standbyUplinks   array[string]  optional
      "specify uplink2 for failover_explicit VSAN Teaming Policy"
```
This is exactly the wizard's per-traffic-type load balancing + active/standby uplink roles. One entry per network type.

**2. NSX uplink profile teaming — cluster-wide, on `dvsSpecs[].nsxTeamings[]`:** `[V-API]`
```
TeamingSpec
  policy          string  REQUIRED  minLength:1
        enum (UPPERCASE): FAILOVER_ORDER | LOADBALANCE_SRCID | LOADBALANCE_SRC_MAC
  activeUplinks   array[string]  REQUIRED  minItems:1
  standByUplinks  array[string]  optional     <-- note capital "B"
```
**Three traps:** `nsxTeamings` is capped at `maxItems: 1`; the NSX enum is UPPERCASE while the DVS enum is lowercase; and NSX spells it **`standByUplinks`** while `networkSpecs` spells it **`standbyUplinks`**.

**3. Physical NIC mapping and LAGs:** `[V-API]`
```
DvsSpec
  dvsName           string   optional   minLength:0  maxLength:80
  networks          array[string]  optional
        VSAN | VMOTION | MANAGEMENT | VM_MANAGEMENT | NFS | FLEET_MANAGEMENT | custom
  mtu               integer(int32) optional   default 9000
  nsxtSwitchConfig  NsxtSwitchConfig  optional
  vmnicsToUplinks   array[VmnicToUplink]  REQUIRED
  nsxTeamings       array[TeamingSpec]    optional  minItems:0  maxItems:1
  lagSpecs          array[LagSpec]        optional

VmnicToUplink       id: string REQUIRED minLength:1 · uplink: string REQUIRED minLength:1

NsxtSwitchConfig
  transportZones             array[TransportZone]  optional
  hostSwitchOperationalMode  string  optional  enum: STANDARD | ENS | ENS_INTERRUPT
                             "Applicable only for the VI Workload Domains"
  ipAssignmentType           string  optional   (no enum published)

LagSpec  (ALL FIVE REQUIRED)
  name               string          REQUIRED  minLength:0  maxLength:16
  uplinksCount       integer(int32)  REQUIRED
  lacpMode           string          REQUIRED  enum: ACTIVE | PASSIVE
  lacpTimeoutMode    string          REQUIRED  enum: SLOW | FAST
  loadBalancingMode  string          REQUIRED  enum:
      SOURCE_MAC, DESTINATION_MAC, SOURCE_AND_DESTINATION_MAC,
      DESTINATION_IP_AND_VLAN, SOURCE_IP_AND_VLAN, SOURCE_AND_DESTINATION_IP_AND_VLAN,
      DESTINATION_TCP_UDP_PORT, SOURCE_TCP_UDP_PORT, SOURCE_AND_DESTINATION_TCP_UDP_PORT,
      DESTINATION_IP_AND_TCP_UDP_PORT, SOURCE_IP_AND_TCP_UDP_PORT,
      SOURCE_AND_DESTINATION_IP_AND_TCP_UDP_PORT, DESTINATION_IP_AND_TCP_UDP_PORT_AND_VLAN,
      SOURCE_IP_AND_TCP_UDP_PORT_AND_VLAN, SOURCE_AND_DESTINATION_IP_AND_TCP_UDP_PORT_AND_VLAN,
      DESTINATION_IP, SOURCE_IP, SOURCE_AND_DESTINATION_IP, VLAN, SOURCE_PORT_ID
```
Note `hostSwitchOperationalMode` is documented *"Applicable only for the VI Workload Domains"*, yet all three working management-domain specs set `"ENS"` and deploy successfully. Treat the doc note as inaccurate or non-enforced.

**Bonus — the wizard's profile picker** is a separate read-only lookup API, not part of `SddcSpec`: `[V-API]`
```
SddcNetworkConfigProfileSpec  (request to GET network config profiles)
  storageType           string  REQUIRED  minLength:1
                        enum: VSAN | VSAN_ESA | NFS | FC
  hostSpecs             array[SddcHostSpec]  REQUIRED  minItems:1
  subdomain             string  optional
  nsxConfigType         string  optional
                        enum: NSX_SEPARATION | NO_NSX_SEPARATION | NSX_SEPARATION_VTEP_LESS
  additionalPortGroups  array[string]  optional   allowed: FLEET_MANAGEMENT

SddcNetworkConfigProfile  (response, all read-only)
  id  enum: DEFAULT | STORAGE_SEPARATION | NSX_SEPARATION | STORAGE_NSX_SEPARATION
  name, description, dvsSpecs[], dvsNameToPortgroupSpecs{}
```
Useful: call this to generate a correct `dvsSpecs` + `networkSpecs` skeleton rather than hand-building it.

---

## G. `workflowType` semantics

```
workflowType   string   optional
   enum: VCF | VCF_COMPLETE | VCF_EXTEND | VVF | VCF_BOOTSTRAP      [V-API 9.1 + 9.1.1]
```

**The only documentation Broadcom publishes is this one sentence** `[V-API]`, verbatim from the `SddcSpec` page:

> *"Type of workflow to initiate creation and/or validation of SDDC. If building a secondary VCF instance to connect it to the fleet, specify workflowType as VCF_EXTEND."*

So:
- **`VCF_EXTEND`** — **documented.** Deploys a *secondary* VCF instance joining an existing fleet. Corroborated structurally: `VcfOperationsSpec.nodes` says *"If building a secondary VCF instance, specify the details of the existing VCF Ops master node"*, and `SddcVspClusterSpec.fleetFqdn` says *"For VVF and primary VCF; omit for secondary VCF instance."* `[V-API]` Lam's write-up also uses VCF_EXTEND for the non-primary-instance case. `[C]`
- **`VCF`** — the standard/primary VCF instance. **All three working specs use `"VCF"`.** `[V-SPEC]`
- **`VVF`** — vSphere Foundation (no SDDC Manager / NSX / fleet). `[I]` — consistent with `fleetFqdn`'s "For VVF and primary VCF" note, but no direct definition published.
- **`VCF_COMPLETE`** and **`VCF_BOOTSTRAP`** — **no published definition anywhere.** I searched Broadcom's API reference, the endpoint pages, and the web. Nothing authoritative exists. Do not emit these.

⚠️ Be aware: a generic fetch of the POST endpoint page yielded gloss text ("Full VCF installation with all components", "Bootstrap workflow for initial setup") for `VCF_COMPLETE`/`VCF_BOOTSTRAP`. **That text is not on the page** — it is model paraphrase of the enum names. I am flagging it rather than reporting it as documentation. Treat these two as undefined.

---

## H. `vspClusterSpec.name`, `fleetLcmSpec.hostname`, `sddcLcmSpec.hostname`

**Verdict: all three are REAL in working specs but ABSENT from the published schema. Emit them, but do not depend on them taking effect.**

| Field | Published schema | Working spec |
|---|---|---|
| `vspClusterSpec.name` | **Not in `SddcVspClusterSpec`** (checked 9.1 + 9.1.1) `[V-API]` | Present: `"name": "vcf-m01-vmsp-01"` `[V-SPEC]` |
| `fleetLcmSpec.hostname` | **Not in `FleetLcmServiceSpec`** — only `{version, size}` `[V-API]` | Present: `"hostname": "vcf-flt01.vcf.lab"` `[V-SPEC]` |
| `sddcLcmSpec.hostname` | **Not in `SddcLcmServiceSpec`** — only `{version, size}` `[V-API]` | Present: `"hostname": "vcf-int01.vcf.lab"` `[V-SPEC]` |

They are **accepted** (the specs deploy successfully, so they are not rejected). But VCF's OpenAPI does not set `additionalProperties: false`, so **unknown fields are silently dropped rather than rejected** — a mechanism independently documented by a community researcher against a real Broadcom OpenAPI file `[C]`. So "the spec works" is *not* evidence these fields do anything.

Strong corroborating signal: in the working specs, `fleetLcmSpec.hostname` (`vcf-flt01.vcf.lab`) is **identical to** `vspClusterSpec.fleetFqdn`, and `sddcLcmSpec.hostname` (`vcf-int01.vcf.lab`) is **identical to** `vspClusterSpec.instanceFqdn`. The real, schema-backed carriers of those values are `fleetFqdn` and `instanceFqdn`. `[I]`

**Recommendation for your generator:** always set `vspClusterSpec.fleetFqdn` and `vspClusterSpec.instanceFqdn` as the authoritative values. Emit the three extra fields for fidelity with known-good specs, but never as the *only* place a value appears.

### ⚠️ A trap to avoid: `hostName` casing

A GitHub issue claims, *"verified against real 9.1.1 OpenAPI spec,"* that `hostSpecs[].hostname` should be **`hostName`** (capital N), and documents a `secondaryAzOverlayVlanId` field. **Do not apply this to the Installer spec.** That issue's stated source is **`sddc-manager-openapi.json`** — the **SDDC Manager API**, a different API for day-N workload-domain/cluster operations (`secondaryAzOverlayVlanId` and `networkSpec.nsxClusterSpec.uplinkProfiles[]` exist only there; neither is anywhere in the Installer's ~190-type index). The Installer API reference says `hostname` on both 9.1 and 9.1.1, and all three real working Installer specs use `hostname` and deploy. **Use `hostname` for `SddcSpec`.** `[V-API]+[V-SPEC]`

---

## Complete verbatim example specs

### 1. Broadcom canonical full-surface example `[V-API]`

From `POST /v1/sddcs` on the Installer API reference. Not deployable (enum placeholders in value positions), but it is the **authoritative field-name-and-nesting reference** — every optional field populated.

```json
{
    "sddcId": "sfo01-m01",
    "workflowType": "One among: VCF, VCF_COMPLETE, VCF_EXTEND, VVF",
    "hostSpecs": [
        {
            "hostname": "esx-1",
            "credentials": { "username": "root", "password": "REDACTED" },
            "sshThumbprint": "SHA256:rVPNWOKE2tZjvmYvKPhtc3ghJ41Vc0G3MwASf4+8+yc",
            "sslThumbprint": "3D:D0:EE:B5:A0:CC:45:08:5C:4F:84:51:CD:00:B6:41:BB:4A:A2:9A:77:1C:A6:4C:6D:84:5A:D0:4F:68:7A:B8"
        }
    ],
    "version": "9.0.0.0",
    "vcenterSpec": {
        "vcenterHostname": "vcenter.rainpole.io",
        "rootVcenterPassword": "REDACTED",
        "vmSize": "medium",
        "storageSize": "lstorage",
        "ssoDomain": "string",
        "adminUserSsoUsername": "string",
        "adminUserSsoPassword": "REDACTED",
        "version": "9.0.0.0.24597083",
        "useExistingDeployment": true,
        "sslThumbprint": "3D:D0:EE:B5:A0:CC:45:08:5C:4F:84:51:CD:00:B6:41:BB:4A:A2:9A:77:1C:A6:4C:6D:84:5A:D0:4F:68:7A:B8"
    },
    "clusterSpec": {
        "datacenterName": "DatacenterName",
        "clusterName": "ClusterName",
        "clusterEvcMode": "One among: INTEL_MEROM, INTEL_PENRYN, INTEL_NEALEM, INTEL_WESTMERE, INTEL_SANDYBRIDGE, INTEL_IVYBRIDGE, INTEL_HASWELL, INTEL_BROADWELL, INTEL_SKYLAKE, INTEL_CASCADELAKE, INTEL_ICELAKE, INTEL_SAPPHIRERAPIDS, AMD_REV_E, AMD_REV_F, AMD_GREYHOUND_NO3DNOW, AMD_GREYHOUND, AMD_BULLDOZER, AMD_PILEDRIVER, AMD_STREAMROLLER, AMD_ZEN, AMD_ZEN2, AMD_ZEN3, AMD_ZEN4",
        "resourcePoolSpecs": [
            {
                "name": "string",
                "type": "string",
                "cpuReservationPercentage": 0,
                "cpuReservationMhz": 0,
                "cpuLimit": 0,
                "cpuReservationExpandable": false,
                "cpuSharesLevel": "string",
                "cpuSharesValue": 0,
                "memoryReservationPercentage": 0,
                "memoryReservationMb": 0,
                "memoryLimit": 0,
                "memoryReservationExpandable": false,
                "memorySharesLevel": "string",
                "memorySharesValue": 0
            }
        ]
    },
    "dvsSpecs": [
        {
            "dvsName": "VdsName",
            "networks": [ "MANAGEMENT" ],
            "mtu": 9000,
            "nsxtSwitchConfig": {
                "transportZones": [
                    { "name": "string", "transportType": "One among: VLAN, OVERLAY" }
                ],
                "hostSwitchOperationalMode": "One among: STANDARD, ENS, ENS_INTERRUPT",
                "ipAssignmentType": "string"
            },
            "vmnicsToUplinks": [ { "id": "vmnic0", "uplink": "uplink1" } ],
            "nsxTeamings": [
                {
                    "policy": "One among: FAILOVER_ORDER, LOADBALANCE_SRCID, LOADBALANCE_SRC_MAC",
                    "activeUplinks": [ "string" ],
                    "standByUplinks": [ "string" ]
                }
            ],
            "lagSpecs": [
                {
                    "name": "string",
                    "uplinksCount": 0,
                    "lacpMode": "One among:ACTIVE, PASSIVE",
                    "loadBalancingMode": "One among:SOURCE_MAC, DESTINATION_MAC, SOURCE_AND_DESTINATION_MAC, DESTINATION_IP_AND_VLAN, SOURCE_IP_AND_VLAN, SOURCE_AND_DESTINATION_IP_AND_VLAN, DESTINATION_TCP_UDP_PORT, SOURCE_TCP_UDP_PORT, SOURCE_AND_DESTINATION_TCP_UDP_PORT, DESTINATION_IP_AND_TCP_UDP_PORT, SOURCE_IP_AND_TCP_UDP_PORT, SOURCE_AND_DESTINATION_IP_AND_TCP_UDP_PORT, DESTINATION_IP_AND_TCP_UDP_PORT_AND_VLAN, SOURCE_IP_AND_TCP_UDP_PORT_AND_VLAN, SOURCE_AND_DESTINATION_IP_AND_TCP_UDP_PORT_AND_VLAN, DESTINATION_IP, SOURCE_IP, SOURCE_AND_DESTINATION_IP, VLAN, SOURCE_PORT_ID",
                    "lacpTimeoutMode": "One among:SLOW, FAST"
                }
            ]
        }
    ],
    "nsxtSpec": {
        "nsxtManagers": [ { "hostname": "string" } ],
        "nsxtManagerSize": "medium",
        "vipFqdn": "string",
        "rootNsxtManagerPassword": "REDACTED",
        "nsxtAdminPassword": "REDACTED",
        "nsxtAuditPassword": "REDACTED",
        "transportVlanId": 1000,
        "ipAddressPoolSpec": {
            "name": "string",
            "description": "string",
            "ignoreUnavailableNsxtCluster": false,
            "subnets": [
                {
                    "ipAddressPoolRanges": [ { "start": "string", "end": "string" } ],
                    "cidr": "string",
                    "gateway": "string"
                }
            ]
        },
        "vpcSpec": {
            "vpcNetworkConfigurationType": "One among: VLAN_BACKED_VPC, FULL_STACK_VPC, VPC_UNSUPPORTED, INVALID_TYPE",
            "dtgwSpec": {
                "vlan": 0,
                "gatewayCidr": "string",
                "externalIpBlockCidr": "string",
                "privateTgwIpBlockCidr": "string"
            }
        },
        "skipNsxOverlayOverManagementNetwork": false,
        "enableEdgeClusterSync": true,
        "overlayVtepSpec": { "vtepType": "One among: NO_IP" },
        "version": "9.0.0.0.24597083",
        "useExistingDeployment": true,
        "sslThumbprint": "3D:D0:EE:B5:A0:CC:45:08:5C:4F:84:51:CD:00:B6:41:BB:4A:A2:9A:77:1C:A6:4C:6D:84:5A:D0:4F:68:7A:B8"
    },
    "networkSpecs": [
        {
            "networkType": "MANAGEMENT",
            "subnet": "10.0.0.250/24",
            "gateway": "10.0.0.250",
            "subnetMask": "255.255.255.0",
            "includeIpAddress": [ "[10.0.0.100]" ],
            "includeIpAddressRanges": [
                { "startIpAddress": "192.168.0.123", "endIpAddress": "192.168.0.128" }
            ],
            "vlanId": 1000,
            "mtu": 0,
            "teamingPolicy": "loadbalance_ip",
            "activeUplinks": [ "string" ],
            "standbyUplinks": [ "string" ],
            "portGroupKey": "string",
            "ipAddressVersion": "IPv6",
            "ipAddressAssignmentMode": "SLAAC"
        }
    ],
    "dnsSpec": {
        "subdomain": "vcf.broadcom.com",
        "nameservers": [ "[172.0.0.4, 172.0.0.5]" ]
    },
    "ntpServers": [ "[10.0.0.100, 10.0.0.101]" ],
    "sddcManagerSpec": {
        "rootPassword": "REDACTED",
        "hostname": "string",
        "sshPassword": "REDACTED",
        "localUserPassword": "REDACTED",
        "version": "9.0.0.0.24597083",
        "useExistingDeployment": true,
        "sslThumbprint": "3D:D0:EE:B5:A0:CC:45:08:5C:4F:84:51:CD:00:B6:41:BB:4A:A2:9A:77:1C:A6:4C:6D:84:5A:D0:4F:68:7A:B8"
    },
    "managementPoolName": "string",
    "ceipEnabled": true,
    "skipEsxThumbprintValidation": false,
    "skipGatewayPingValidation": false,
    "securitySpec": {
        "esxiCertsMode": "VMCA",
        "rootCaCerts": [ { "alias": "string", "certChain": [ "string" ] } ]
    },
    "datastoreSpec": {
        "nfsDatastoreSpec": {
            "datastoreName": "string",
            "nasVolume": {
                "serverName": [ "string" ],
                "path": "string",
                "readOnly": false,
                "userTag": "string",
                "enableBindToVmknic": false
            }
        },
        "vmfsDatastoreSpec": { "fcSpec": [ { "datastoreName": "string" } ] },
        "vsanSpec": {
            "datastoreName": "string",
            "vsanDedup": false,
            "esaConfig": { "enabled": false, "skipHclAutoDiskClaim": false },
            "encryptionConfig": {
                "dataInTransitConfig": { "enable": false, "rekeyInterval": 0 }
            },
            "failuresToTolerate": 3
        },
        "existingDatastoreName": "string"
    },
    "vspClusterSpec": {
        "platformFqdn": "vsp-cluster.rainpole.io",
        "systemUserPassword": "REDACTED",
        "ipv4Pool": {
            "cidr": "10.0.0.0/24",
            "ipRange": { "startIpAddress": "192.168.0.123", "endIpAddress": "192.168.0.128" },
            "addresses": [ "[\"10.0.0.80\", \"10.0.0.81\", \"10.0.0.82\", ...]" ],
            "excludedAddresses": [ "[\"10.0.0.81\", ...]" ]
        },
        "ipv6Pool": {
            "cidr": "2001:db8::00/112",
            "ipRange": { "startIpAddress": "::", "endIpAddress": "2001:0db8:0000:0000:0000:ff00:0042:8329" },
            "addresses": [ "[\"2001:db8::80\", \"2001:db8::81\", \"2001:db8::82\", ...]" ],
            "excludedAddresses": [ "[\"2001:db8::81\", ...]" ]
        },
        "size": "small",
        "internalClusterCidrIpv4": "198.18.0.0/15",
        "internalClusterCidrIpv6": "fd00::/111",
        "instanceFqdn": "instance.rainpole.io",
        "fleetFqdn": "instance.rainpole.io",
        "version": "9.0.0.0.24597083",
        "useExistingDeployment": true,
        "sslThumbprint": "3D:D0:EE:B5:A0:CC:45:08:5C:4F:84:51:CD:00:B6:41:BB:4A:A2:9A:77:1C:A6:4C:6D:84:5A:D0:4F:68:7A:B8"
    },
    "fleetLcmSpec":        { "version": "9.0.0.0.24597083", "size": "small" },
    "sddcLcmSpec":         { "version": "9.0.0.0.24597083", "size": "small" },
    "fleetDepotSpec":      { "version": "9.0.0.0.24597083", "size": "small" },
    "telemetryAcceptorSpec": { "version": "9.0.0.0.24597083", "size": "small" },
    "vidbSpec":  { "hostname": "vidb.vcf.local", "version": "9.0.0.0.24597083", "size": "small" },
    "saltSpec":     { "version": "9.0.0.0.24597083", "size": "small" },
    "saltRaasSpec": { "version": "9.0.0.0.24597083", "size": "small" },
    "vcfOperationsSpec": {
        "nodes": [
            {
                "hostname": "vcfoperations-master.rainpole.io",
                "rootUserPassword": "REDACTED",
                "type": "master",
                "sslThumbprint": "3D:D0:EE:B5:A0:CC:45:08:5C:4F:84:51:CD:00:B6:41:BB:4A:A2:9A:77:1C:A6:4C:6D:84:5A:D0:4F:68:7A:B8"
            }
        ],
        "adminUserPassword": "REDACTED",
        "applianceSize": "medium",
        "loadBalancerFqdn": "string",
        "useExistingDeployment": true,
        "version": "9.0.0.0.24597083"
    },
    "vcfOperationsCollectorSpec": {
        "hostname": "vcf-operations-collector.rainpole.io",
        "rootUserPassword": "REDACTED",
        "applianceSize": "small",
        "version": "9.0.0.0.24597083",
        "useExistingDeployment": true,
        "sslThumbprint": "3D:D0:EE:B5:A0:CC:45:08:5C:4F:84:51:CD:00:B6:41:BB:4A:A2:9A:77:1C:A6:4C:6D:84:5A:D0:4F:68:7A:B8"
    },
    "vcfAutomationSpec": {
        "hostname": "vcfautomation.rainpole.io",
        "platformFqdn": "vsp-platform.rainpole.io",
        "adminUserPassword": "REDACTED",
        "ipPool": [ "['10.0.0.80', '10.0.0.81', '10.0.0.82', '10.0.0.83', '10.0.0.84', '10.0.0.85']" ],
        "internalClusterCidr": "string",
        "nodePrefix": "node-123",
        "size": "small",
        "version": "9.0.0.0.24597083",
        "useExistingDeployment": true,
        "sslThumbprint": "3D:D0:EE:B5:A0:CC:45:08:5C:4F:84:51:CD:00:B6:41:BB:4A:A2:9A:77:1C:A6:4C:6D:84:5A:D0:4F:68:7A:B8"
    },
    "vcfManagementComponentsInfrastructureSpec": {
        "localRegionNetwork": {
            "networkName": "string", "subnetMask": "255.255.255.0",
            "gateway": "10.0.0.250", "ipv6Gateway": "string", "ipv6Prefix": 0
        },
        "xRegionNetwork": {
            "networkName": "string", "subnetMask": "255.255.255.0",
            "gateway": "10.0.0.250", "ipv6Gateway": "string", "ipv6Prefix": 0
        }
    },
    "licenseServerSpec": {
        "hostname": "license-server.rainpole.io",
        "version": "9.0.0.0.24597083",
        "useExistingDeployment": true,
        "sslThumbprint": "3D:D0:EE:B5:A0:CC:45:08:5C:4F:84:51:CD:00:B6:41:BB:4A:A2:9A:77:1C:A6:4C:6D:84:5A:D0:4F:68:7A:B8"
    },
    "vcfInstanceName": "string"
}
```

### 2. Real working one-node vSAN ESA spec `[V-SPEC]`

`lamw/vcf-91-in-box` @ `master`, `config/one-node-vsan-esa.json`. **This one actually deploys.** Passwords redacted.

```json
{
    "version": "9.1.0.0",
    "vcfInstanceName": "VMUG x Intel x Micron VCF 9.1 Instance",
    "sddcId": "vcf-m01",
    "ceipEnabled": true,
    "skipEsxThumbprintValidation": true,
    "workflowType": "VCF",
    "dnsSpec": {
        "subdomain": "vcf.lab",
        "nameservers": [ "192.168.30.29" ]
    },
    "ntpServers": [ "96.19.94.82" ],
    "hostSpecs": [
        {
            "hostname": "esx01.vcf.lab",
            "credentials": { "username": "root", "password": "REDACTED" }
        }
    ],
    "networkSpecs": [
        {
            "networkType": "MANAGEMENT",
            "ipAddressVersion": "IPv4",
            "subnet": "172.30.0.0/24",
            "gateway": "172.30.0.1",
            "vlanId": "30",
            "activeUplinks": [ "uplink1" ],
            "portGroupKey": "DVPG_FOR_MANAGEMENT",
            "standbyUplinks": [],
            "teamingPolicy": "loadbalance_loadbased"
        },
        {
            "networkType": "VM_MANAGEMENT",
            "ipAddressVersion": "IPv4",
            "subnet": "172.30.0.0/24",
            "gateway": "172.30.0.1",
            "vlanId": "30",
            "activeUplinks": [ "uplink1" ],
            "portGroupKey": "DVPG_FOR_VM_MANAGEMENT",
            "standbyUplinks": [],
            "teamingPolicy": "loadbalance_loadbased"
        },
        {
            "networkType": "VMOTION",
            "ipAddressVersion": "IPv4",
            "subnet": "172.30.40.0/24",
            "gateway": "172.30.40.1",
            "vlanId": "40",
            "mtu": 9000,
            "includeIpAddressRanges": [
                { "startIpAddress": "172.30.40.10", "endIpAddress": "172.30.40.20" }
            ],
            "activeUplinks": [ "uplink1" ],
            "portGroupKey": "DVPG_FOR_VMOTION",
            "standbyUplinks": [],
            "teamingPolicy": "loadbalance_loadbased"
        },
        {
            "networkType": "VSAN",
            "ipAddressVersion": "IPv4",
            "subnet": "172.30.50.0/24",
            "gateway": "172.30.50.1",
            "vlanId": "50",
            "mtu": 9000,
            "includeIpAddressRanges": [
                { "startIpAddress": "172.30.50.2", "endIpAddress": "172.30.50.4" }
            ],
            "activeUplinks": [ "uplink1" ],
            "portGroupKey": "DVPG_FOR_VSAN",
            "standbyUplinks": [],
            "teamingPolicy": "loadbalance_loadbased"
        }
    ],
    "vspClusterSpec": {
        "ipv4Pool": {
            "ipRange": { "startIpAddress": "172.30.0.33", "endIpAddress": "172.30.0.46" }
        },
        "platformFqdn": "vcf-msr01.vcf.lab",
        "instanceFqdn": "vcf-int01.vcf.lab",
        "fleetFqdn": "vcf-flt01.vcf.lab",
        "systemUserPassword": "REDACTED",
        "size": "small",
        "name": "vcf-m01-vmsp-01",
        "internalClusterCidrIpv4": "198.18.0.0/15"
    },
    "vcfAutomationSpec": {
        "ipPool": [
            "172.30.0.65", "172.30.0.66", "172.30.0.67",
            "172.30.0.68", "172.30.0.69", "172.30.0.70"
        ],
        "hostname": "auto01.vcf.lab",
        "platformFqdn": "vcf-asr01.vcf.lab",
        "adminUserPassword": "REDACTED",
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
            "subnets": [
                {
                    "cidr": "172.30.60.0/24",
                    "gateway": "172.30.60.1",
                    "ipAddressPoolRanges": [
                        { "start": "172.30.60.10", "end": "172.30.60.20" }
                    ]
                }
            ]
        },
        "nsxtManagerSize": "medium",
        "vipFqdn": "nsx01.vcf.lab",
        "rootNsxtManagerPassword": "REDACTED",
        "nsxtAdminPassword": "REDACTED",
        "nsxtAuditPassword": "REDACTED",
        "useExistingDeployment": false,
        "vpcSpec": {
            "dtgwSpec": {
                "vlan": "70",
                "gatewayCidr": "172.30.70.1/24",
                "externalIpBlockCidr": "172.30.70.0/26",
                "privateTgwIpBlockCidr": "172.31.0.0/16"
            }
        },
        "nsxtManagers": [ { "hostname": "nsx01a.vcf.lab" } ]
    },
    "vcfOperationsSpec": {
        "applianceSize": "small",
        "useExistingDeployment": false,
        "adminUserPassword": "REDACTED",
        "nodes": [
            {
                "hostname": "vcf01.vcf.lab",
                "rootUserPassword": "REDACTED",
                "type": "master"
            }
        ]
    },
    "vcfOperationsCollectorSpec": {
        "applianceSize": "small",
        "hostname": "vcf-proxy01.vcf.lab",
        "rootUserPassword": "REDACTED",
        "useExistingDeployment": false
    },
    "licenseServerSpec": { "hostname": "vcf-lic01.vcf.lab" },
    "vidbSpec": { "hostname": "vcf-idb01.vcf.lab" },
    "saltSpec": {},
    "saltRaasSpec": {},
    "telemetryAcceptorSpec": {},
    "fleetLcmSpec": { "hostname": "vcf-flt01.vcf.lab" },
    "sddcLcmSpec": { "hostname": "vcf-int01.vcf.lab" },
    "fleetDepotSpec": {},
    "vcenterSpec": {
        "vcenterHostname": "vc01.vcf.lab",
        "adminUserSsoPassword": "REDACTED",
        "rootVcenterPassword": "REDACTED",
        "vmSize": "small",
        "storageSize": "lstorage",
        "ssoDomain": "vsphere.local",
        "useExistingDeployment": false
    },
    "clusterSpec": {
        "datacenterName": "VCF-Datacenter",
        "clusterName": "VCF-Mgmt-Cluster"
    },
    "datastoreSpec": {
        "vsanSpec": {
            "vsanDedup": false,
            "failuresToTolerate": 1,
            "esaConfig": { "enabled": true },
            "datastoreName": "vsanDatastore",
            "encryptionConfig": { "dataInTransitConfig": { "enable": false } }
        }
    },
    "dvsSpecs": [
        {
            "dvsName": "vcf-m01-cl01-vds01",
            "networks": [ "MANAGEMENT", "VM_MANAGEMENT", "VMOTION", "VSAN" ],
            "mtu": 9000,
            "nsxtSwitchConfig": {
                "transportZones": [
                    { "name": "vcf-overlay-TZ", "transportType": "OVERLAY" },
                    { "transportType": "VLAN", "name": "vcf-vlan-TZ" }
                ],
                "hostSwitchOperationalMode": "ENS"
            },
            "vmnicsToUplinks": [ { "id": "vmnic1", "uplink": "uplink1" } ],
            "nsxTeamings": [
                {
                    "policy": "LOADBALANCE_SRCID",
                    "activeUplinks": [ "uplink1" ],
                    "standByUplinks": null
                }
            ],
            "lagSpecs": null
        }
    ],
    "sddcManagerSpec": {
        "hostname": "sddcm01.vcf.lab",
        "localUserPassword": "REDACTED",
        "useExistingDeployment": true
    }
}
```

### 3. Two-node and three-node variants `[V-SPEC]`

I retrieved both in full and **diffed them against the one-node spec.** They are **byte-identical except for two things**:
1. `vcfInstanceName` is `"William Lam VCF 9.1 Instance"` in both (vs. the VMUG string in one-node).
2. `hostSpecs[]` gains entries — two-node adds `esx02.vcf.lab`, three-node adds `esx02.vcf.lab` and `esx03.vcf.lab`, each with the identical `{username: root, password: ...}` block.

**Everything else — including the VSAN range `172.30.50.2–172.30.50.4`, `failuresToTolerate: 1`, and the single-uplink `vmnicsToUplinks` — is unchanged across 1/2/3 hosts.** Notably `failuresToTolerate: 1` is used even on a one-node cluster. So rather than reprint two near-identical 200-line blobs: take spec #2 and append host entries.

### 4. Real `vcfManagementComponentsInfrastructureSpec` fragments `[C]`

From William Lam's non-management-network write-ups — the only real-world usage of this structure I found:

```json
"vcfManagementComponentsInfrastructureSpec": {
  "localRegionNetwork": {
    "networkName": "DVPG_FOR_FLEET_MANAGEMENT",
    "subnetMask": "255.255.255.0",
    "gateway": "172.30.70.1"
  },
  "xRegionNetwork": {
    "networkName": "DVPG_FOR_FLEET_MANAGEMENT",
    "subnetMask": "255.255.255.0",
    "gateway": "172.30.70.1"
  }
}
```
`networkName` is a **vSphere portgroup name**, not a subnet/CIDR. Note it matches `additionalPortGroups: ["FLEET_MANAGEMENT"]` from the network-config-profile API.

### 5. `vspClusterSpec.ipv4Pool` — all three allocation forms `[C]`

```json
"ipv4Pool": { "ipRange": { "startIpAddress": "172.30.0.145", "endIpAddress": "172.30.0.158",
                           "excludedAddresses": ["172.30.0.144", "172.30.0.145"] } }

"ipv4Pool": { "cidr": "172.30.0.144/28",
              "excludedAddresses": ["172.30.0.157", "172.30.0.158"] }

"ipv4Pool": { "addresses": ["172.30.0.144", "172.30.0.146", "172.30.0.148", "..."] }
```
⚠️ In the first form the blog places `excludedAddresses` **inside** `ipRange`. The published schema puts `excludedAddresses` as a **sibling of** `ipRange`, on `IPv4Pool`. `[V-API]` The schema position is almost certainly correct; the blog's nesting likely silently drops. **Emit it as a sibling of `ipRange`.**

---

## Type-consistency traps for your generator

1. **`vlanId` and `transportVlanId` are `integer` in the schema, but every working spec passes them as quoted strings** (`"vlanId": "30"`, `"transportVlanId": "60"`, `"vlan": "70"`). The server coerces. The canonical example uses bare ints (`1000`). Either works; ints are schema-correct.
2. **`standbyUplinks` (networkSpecs, lowercase b) vs `standByUplinks` (nsxTeamings, capital B)** — genuinely different spellings in the same document.
3. **Lowercase teaming enums on `networkSpecs`, UPPERCASE on `nsxTeamings`.**
4. **`IpRange` = `startIpAddress`/`endIpAddress`; `IpAddressPoolRangeSpec` = `start`/`end`.**
5. **`esxiCertsMode` values are mixed-case: `Custom`, `VMCA`.**
6. **`nsxTeamings` maxItems is 1.**
7. **`dnsSpec.nameservers` max 2 entries.**
8. Empty objects (`"saltSpec": {}`, `"fleetDepotSpec": {}`) are valid and are how the working specs request default deployment.
9. `null` is accepted for optional arrays (`"lagSpecs": null`, `"standByUplinks": null`).
10. **Unknown fields are silently dropped, not rejected** `[C]` — a successful deploy never proves a field took effect.

---

## STILL UNVERIFIED

Explicitly unresolved. **Nothing above was filled in by guessing to cover these.**

1. **TechDocs "Use a JSON Specification File…" (9.1 and 9.0) — HTTP 403, organization egress-policy denial, 4 attempts** (9.1 path, 9.0 path, `?print=true`, `vcf-9-1-and-later` shape → 404; PDF asset → 404). Sibling pages load, so the block is page-specific. **Zero content in this report comes from TechDocs.** If Broadcom documents per-host or OSA disk-group fields anywhere, this is the one place I could not check — though the API reference's complete type index strongly indicates no such fields exist.
2. **No published Installer OpenAPI/Swagger JSON.** No `/v1/api-docs` or `swagger.json` copy exists publicly; the appliance serves it only at runtime. All schema here is from rendered HTML reference pages, which may omit constraints present in the raw spec.
3. **`VidbSpec.size` enum — not published.** Description is literally `"size"`. Only `"small"` attested.
4. **`SaltSpec.size`, `FleetLcmServiceSpec.size`, `SddcLcmServiceSpec.size`, `FleetDepotServiceSpec.size`, `TelemetryAcceptorSpec.size`, `VcfAutomationSpec.size` — no enums published.** Only `"small"` attested for each.
5. **`VidbSpec.hostname` is REQUIRED but `vidbSpec` itself is optional** — whether omitting the whole block is valid is untested (working specs always include it).
6. **`VCF_COMPLETE` and `VCF_BOOTSTRAP` semantics — no documentation exists anywhere.** Do not emit.
7. **`NsxtSwitchConfig.ipAssignmentType` — no enum published**, no example value.
8. **`VpcSpec.vpcNetworkConfigurationType` enum conflict:** the type page lists 2 values, the `SddcSpec` example lists 4 (adds `VPC_UNSUPPORTED`, `INVALID_TYPE`). The latter two read like internal/sentinel states. Unresolved which are settable.
9. **IPv6 length constraints:** `SddcNetworkSpec.gateway` is `maxLength:15` and `subnet` `maxLength:18` — too short for many IPv6 literals, yet `ipAddressVersion: "IPv6"` is valid on the same object. Whether the server relaxes these for IPv6 is **unverified**, and I found **no working dual-stack spec** to confirm against. Treat IPv6 on `networkSpecs` as untested.
10. **`excludedAddresses` placement** in `IPv4Pool` — schema says sibling of `ipRange`; a community example nests it inside. Not empirically resolved.
11. **`managementPoolName` format/pattern** — no constraint published; all working specs omit it.
12. **Whether `vspClusterSpec.name`, `fleetLcmSpec.hostname`, `sddcLcmSpec.hostname` have any runtime effect** (§H) — they are accepted, but given no-`additionalProperties:false`, acceptance proves nothing.
13. **`hostSwitchOperationalMode`** documented as *"Applicable only for the VI Workload Domains"* yet set to `ENS` in working management-domain specs. Doc note appears wrong or unenforced; actual behavior unverified.
14. **OSA cache/capacity disk-group specification** — confirmed absent from the Installer API type index, but I could not positively confirm *where* it is configured instead (presumably automatic claiming or a day-N SDDC Manager operation). The `VSAN` vs `VSAN_ESA` split in `SddcNetworkConfigProfileSpec.storageType` shows OSA is a selectable mode; the disk-group layout has no input schema.

**Sources:** [VCF Installer API — SddcSpec](https://developer.broadcom.com/xapis/vcf-installer-api/latest/data-structures/SddcSpec/) · [data-structures index](https://developer.broadcom.com/xapis/vcf-installer-api/latest/data-structures/) · [POST /v1/sddcs](https://developer.broadcom.com/xapis/vcf-installer-api/latest/v1/sddcs/post/) · [9.1-pinned SddcSpec](https://developer.broadcom.com/xapis/vcf-installer-api/9.1/data-structures/SddcSpec/) · [lamw/vcf-91-in-box](https://github.com/lamw/vcf-91-in-box) · [one-node-vsan-esa.json](https://github.com/lamw/vcf-91-in-box/blob/master/config/one-node-vsan-esa.json) · [VCFMS IP allocation options](https://williamlam.com/2026/05/vcf-9-1-additional-ip-allocation-options-for-vcf-management-services-vcfms-in-vcf-installer-and-sddc-manager.html) · [VCFMS to non-management network](https://williamlam.com/2026/06/vcf-9-1-deploying-vcf-management-services-vcfms-to-non-management-network-during-vcf-upgrade.html) · [VCFA to non-management network](https://williamlam.com/2026/06/vcf-9-1-deploying-vcf-automation-vcfa-to-non-management-network.html) · [pauldiee/VCF9-DeploymentPlanning#342](https://github.com/pauldiee/VCF9-DeploymentPlanning/issues/342) · [TechDocs JSON spec page (403, inaccessible)](https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-1/deployment/deploying-a-new-vmware-cloud-foundation-or-vmware-vsphere-foundation-private-cloud-/use-a-json-specification-to-deploy-vmware-cloud-foundation-or-vmware-vsphere-foundation.html)agentId: a9b4c2812715dc80b (use SendMessage with to: 'a9b4c2812715dc80b', summary: '<5-10 word recap>' to continue this agent)
<usage>subagent_tokens: 172962
tool_uses: 94
duration_ms: 855662</usage>