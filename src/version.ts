// Single source of truth for the wux-review version.
//
// Stamped at release build time via `bun build --define
// 'process.env.WUX_REVIEW_VERSION="<tag>"'` (see docs/releasing.md, added in the
// repo-scaffold issue). Source/dev runs — and a set-but-empty stamp — fall back
// to a non-CalVer sentinel so tooling can tell a dev build from a real release.
export const VERSION = process.env.WUX_REVIEW_VERSION || "0.0.0-dev";
