# ATK Decision Report

- Generated: **2026-01-08T23:05:51.946Z**
- Cloud target: **aws**

## Inputs
- Data classification: CJIS
- Internet exposed: Yes
- RTO minutes: 30

## Recommended patterns (top 4)
### Centralized Logging + SIEM Integration  `(ops.central.logging.siem)`
Central collection, retention, and analysis of logs/events with integrations into SIEM/SOAR for response workflows.

**Why it was recommended:**
- Regulated data requires strong identity, encryption key control, auditability, and threat detection.

### Regulated Security Baseline  `(sec.regulated.baseline)`
Baseline controls for regulated workloads (CJIS/FIPS/HIPAA-style): identity hardening, encryption, audit logging, threat detection, and private connectivity preference.

**Why it was recommended:**
- Regulated data requires strong identity, encryption key control, auditability, and threat detection.

### Hub-and-Spoke with Centralized Inspection  `(net.hub_spoke.inspection)`
Standard enterprise network segmentation with shared services, centralized egress/ingress inspection, and consistent routing control.

### WORM Retention + Evidence Vault  `(data.worm.retention)`
Write-once-read-many retention, immutability, and evidentiary storage for sensitive records and audit needs.

## Required capabilities (0)
- (none)

## Preferred capabilities (0)
- (none)

## Resolved cloud services for aws (0)
- (none resolved — check master matrix mappings)

## Capability-to-service detail
- (none)