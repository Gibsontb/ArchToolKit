/**
 * STUB — Sources (`#sources`) on Application Migration (`migration.html`).
 *
 * Mounted by the page shell (WP-14) through `mount(root, ctx)`; WP-UI-A
 * replaces this body with the real pane and keeps the export.
 */

import { stubPane } from '../pane-stub.js';
                                                    
import { portfolioImportCard } from '../legacy-portfolio.js';

export function mount(root             , ctx             )       {
  stubPane(root, ctx, {
    title: "Sources",
    does: "Bring in servers and applications from any source: the VMware estate, collector files, CSV (the toolkit's templates, the Azure Migrate import CSV, the Migration Center CSV), the old portfolio, or manual entry. Also the app grouping rules and the collector bundle download.",
    owner: "WP-UI-A",
    // The old portfolio stays importable, first on Sources (A.1.5).
    extra: [portfolioImportCard(ctx.session)],
  });
}
