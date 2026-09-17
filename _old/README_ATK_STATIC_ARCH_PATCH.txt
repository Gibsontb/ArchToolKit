ATK static architecture catalog patch

Rescanned against the uploaded toolkit structure.

Added files:
- ArchToolKit/13_Web/static/cloud-decision-logic-kit/data/aws-architecture-catalog.js
- ArchToolKit/13_Web/static/cloud-tech-navigator/aws-architecture-catalog.js

These are additive only and match the current static-first structure already in the toolkit.
They expose:
  window.CDK.architecture.aws

Load after the existing AWS service catalog files if you want to consume it in the UI/engine.
