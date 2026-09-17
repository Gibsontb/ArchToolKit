\# 11\_DataModels



\## Purpose



This folder is the emerging canonical data layer for ArchToolKit.



It is intended to hold:



\- service catalog data

\- schema definitions

\- structured configuration models

\- normalized source-of-truth content for runtime and automation



\## Current Status



This area is \*\*working but still under stabilization\*\*.



The runtime may still rely on legacy-relative structures in some places, but this folder represents the intended long-term canonical data model location.



\## Current Structure



\- `data/` — service and operational data

\- `schemas/` — validation and structure definitions



\## Rules



\- Preserve structure until runtime dependencies are fully validated

\- Do not arbitrarily rename or relocate files

\- Future versions should reduce legacy coupling and normalize references into this folder

