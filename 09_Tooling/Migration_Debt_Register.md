\# Migration Debt Register



\## Purpose



This file tracks known migration debt carried forward from the legacy ATK into ArchToolKit.



---



\## 1. Runtime Coupling



\*\*Status:\*\* Open



The current web runtime remains partially coupled to preserved legacy layout assumptions.



\### Notes

\- Runtime was preserved intentionally to avoid breakage

\- Some references may still assume older relative path behavior

\- Additional cleanup should not be attempted without validation



---



\## 2. Data Model Normalization



\*\*Status:\*\* Open



`11\_DataModels` exists as the intended canonical data layer, but not all runtime interactions may be fully normalized against it yet.



\### Notes

\- `data/` and `schemas/` were preserved

\- Further normalization should happen only after dependency validation



---



\## 3. Script Classification



\*\*Status:\*\* Open



Scripts were migrated for continuity but are not yet fully reorganized by function.



\### Notes

\- Legacy scripts remain staged

\- Future cleanup should classify scripts into clear categories



---



\## 4. Artifact Classification



\*\*Status:\*\* Open



Not all legacy outputs and staged materials have been fully classified as formal artifacts versus support content.



\### Notes

\- `dist`, reports, and similar outputs may require later categorization

\- Productization standards are still evolving



---



\## 5. Support Content Staging



\*\*Status:\*\* Open



Supporting materials such as docs, examples, infra, and reports have been preserved, but not yet fully normalized into final operating categories.



\### Notes

\- This is acceptable during stabilization

\- No further major moves should occur until runtime and data dependencies are fully validated



---



\## Guidance



This debt register exists to control future cleanup work.



It is not a reason to restructure the platform again immediately.



The current priority remains:



1\. preserve runtime stability  

2\. preserve data integrity  

3\. clean incrementally  

4\. modularize only after validation

