ATK loader/wiring patch

What was wrong:
- The architecture files already exist in the toolkit:
  - 13_Web/static/cloud-decision-logic-kit/data/aws-architecture-catalog.js
  - 13_Web/static/cloud-decision-logic-kit/engine/architecture-engine.js
  - 13_Web/static/cloud-tech-navigator/aws-architecture-catalog.js
- But the HTML pages were not loading them, so window.CDK.engine was undefined.

Patched files:
- 13_Web/static/cloud-decision-logic-kit/aws-decision-matrix.html
- 13_Web/static/cloud-tech-navigator/cloud-tech-navigator.html
- 13_Web/static/cloud-tech-navigator.html
- 13_Web/static/index.html

After applying, hard refresh the browser and test:
window.CDK
window.CDK.engine.buildArchitecture(["ec2","rds","cloudfront","route53","waf"])
