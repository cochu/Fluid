/**
 * Build identifier shown by the on-screen version tag.
 *
 * This file is updated automatically by `tools/stamp-version.sh` right
 * before every commit / push so the running page always advertises the
 * commit it was built from. We keep it as a separate ES module (rather
 * than inline in index.html) so the build stamp survives bundling and
 * remains a single, easy-to-rewrite source of truth.
 *
 * The string is intentionally short — the UI layer prefixes it with
 * "v" and shows it as a discreet badge top-left.
 */
export const BUILD_VERSION = '7d6e076-2026-04-20';
