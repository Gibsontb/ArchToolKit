ATK Topology Renderer Patch

Adds:
- 13_Web/static/cloud-decision-logic-kit/engine/architecture-renderer.js

Updates:
- 13_Web/static/index.html

What it does:
- Loads the AWS service inventory, architecture catalog, graph engine, and new renderer on the main static index page.
- Adds an "AWS Architecture Preview" section with service checkboxes.
- Renders the inferred architecture by layer and lists resolved edges.
- Stores the latest rendered graph on window.__ATK_LAST_GRAPH__ for debugging.

After applying:
1. Open 13_Web/static/index.html
2. Hard refresh
3. Use the AWS Architecture Preview section
4. Optional console checks:
   window.CDK
   window.__ATK_LAST_GRAPH__