# ArchToolKit (ATK)

**Version:** 1.1.2  
**Status:** Working Runtime Baseline + Cleanup Pass  

## Purpose

ArchToolKit is the evolved platform structure for the legacy ATK toolkit.

This version preserves the currently working runtime while organizing the broader toolkit into a modular architecture container for future expansion.

ArchToolKit is intended to support:

- Internal architecture governance
- Reusable enterprise architecture tooling
- Productizable toolkit packaging
- Future modular separation of runtime, data, and automation

---

## Current Operating State

ArchToolKit v1.1.2 is a **working migrated baseline**.

The active runtime currently lives in:

- `13_Web/static/`

The currently staged data model areas live in:

- `11_DataModels/data/`
- `11_DataModels/schemas/`

The currently staged automation and legacy script areas live in:

- `12_Scripts/`

Supporting materials and legacy reference content live in:

- `09_Tooling/`

---

## Structural Model

ArchToolKit currently uses this high-level structure:

- `00_Executive/` — executive and strategic doctrine
- `01_Governance/` — governance model and policy structure
- `02_Compliance/` — compliance architecture domain
- `03_Security/` — security architecture domain
- `04_Cloud/` — cloud architecture domain
- `05_Data/` — data architecture domain
- `06_AppModernization/` — application modernization domain
- `07_Operations/` — operations architecture domain
- `08_Financial/` — financial architecture domain
- `09_Tooling/` — supporting materials, legacy support content, migration debt tracking
- `10_Artifacts/` — packaged outputs and exportable artifact targets
- `11_DataModels/` — canonical data layer under stabilization
- `12_Scripts/` — scripts and automation under stabilization
- `13_Web/` — active runtime delivery surface

---

## Important Rule

This version is a **cleanup and stabilization release**.

It is **not** a restructuring release.

The runtime structure remains preserved to avoid breaking working behavior.

---

## Near-Term Direction

The next major architecture step after stabilization is:

- reduce legacy coupling
- normalize data model ownership
- make runtime consume `11_DataModels` more intentionally
- modularize scripts and artifacts without breaking the UI

---

## Baseline Guidance

- `ATK.zip` remains the frozen legacy baseline
- `ArchToolKit_v1.1.1` remains the first working migrated baseline
- `ArchToolKit_v1.1.2` is the cleanup and stabilization baseline