/**
 * The toolkit's version, in one place.
 *
 * Every page shows it beside the brand, so someone reporting a problem — or
 * holding a copy that came from a zip months ago — can say which build they
 * have. `package.json` carries the same number, and a test fails if the two
 * drift apart.
 *
 * Three parts, the usual way round: the first changes when a page works
 * differently enough to retrain someone, the second when something is added,
 * the third for fixes.
 */

export const VERSION = '2.17.0';

/** "Version 2.17.0", as the header prints it. */
export const VERSION_LABEL = `Version ${VERSION}`;
