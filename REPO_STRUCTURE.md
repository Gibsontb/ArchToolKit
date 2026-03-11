\# ArchToolKit Repository Structure



\## Purpose



This document defines the \*\*official repository layout for ArchToolKit\*\*.



The goal is to prevent structural drift and maintain a stable platform architecture.



The root folder name \*\*must never change\*\*.



Repository name:



ArchToolKit



Versioning is tracked in:



VERSION.md



---



\# Core Platform Layout

ArchToolKit/

│

├── 00\_Executive

├── 01\_Governance

├── 02\_Compliance

├── 03\_Security

├── 04\_Cloud

├── 05\_Data

├── 06\_AppModernization

├── 07\_Operations

├── 08\_Financial

├── 09\_Tooling

├── 10\_Artifacts

├── 11\_DataModels

├── 12\_Scripts

├── 13\_Web

│

├── README.md

├── VERSION.md

├── REPO\_STRUCTURE.md

└── .gitignore



---



\# Folder Roles



\## 00–08 Architecture Domains



These folders contain architecture doctrine and structured guidance for each architecture discipline.



They represent the \*\*conceptual architecture framework\*\*.



They are not runtime folders.



---



\## 09\_Tooling



Supporting materials and migration context.



Examples include:



\- documentation

\- examples

\- infrastructure notes

\- reports

\- migration registers



This folder supports the platform but is \*\*not runtime code\*\*.



---



\## 10\_Artifacts



Exportable or distributable outputs.



Examples:



\- packaged reports

\- templates

\- decision matrices

\- toolkit deliverables



Artifacts are intended to be reusable outputs of the platform.



---



\## 11\_DataModels



Canonical structured data used by the toolkit.



Examples:



\- service catalog

\- schema definitions

\- configuration models

\- normalized data structures



This folder represents the \*\*source-of-truth data layer\*\*.



---



\## 12\_Scripts



Automation and operational scripts.



Examples:



\- validation scripts

\- data generators

\- maintenance utilities

\- infrastructure automation



Scripts support the platform but are separate from the web runtime.



---



\## 13\_Web



Active runtime delivery surface.



Current runtime location:13\_Web/static/





This contains the working web UI.



Important rule:



Do not restructure runtime paths without verifying application behavior.



---



\# Structural Rules



1\. The repository root folder name must remain:



ArchToolKit



2\. Version numbers must never be embedded in folder names.



Versioning belongs only in:



\- VERSION.md

\- Git tags



3\. Major structural changes must update:



\- REPO\_STRUCTURE.md

\- VERSION.md



4\. Runtime components must remain isolated from doctrine folders.



5\. Data models should evolve toward `11\_DataModels` as the canonical source.



---



\# Current State



ArchToolKit is currently in a \*\*post-migration stabilization phase\*\* following the migration from the legacy ATK structure.



Future versions will incrementally modularize the platform while preserving runtime stability.



---



\# Governance Principle



The repository structure is considered \*\*part of the platform architecture\*\*.



Changes should be deliberate and documented.



Uncontrolled restructuring is discouraged.





