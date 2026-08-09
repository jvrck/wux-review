import { findingKey } from "./consolidate";
import type { Finding, ReviewResult } from "./types";

// Sticky-approve guard (#91). A reviewer leg must not spuriously flip to `block`
// on a later round of a `--session` re-review by escalating — to a must-fix — a
// finding it had already surfaced AND approved alongside earlier in the session.
// Only a GENUINELY NEW must-fix, one whose identity the leg never approved-with,
// may block: this is a backstop, not a weakening — a new changed-line defect still
// blocks.
//
// `stickyKeys` is the leg's accumulated set of approved-with finding identities
// (findingKey — severity is not part of the identity, so an escalation matches).
// It is carried across ALL rounds, including intervening blocks, so a point the
// leg once accepted cannot be revived as a blocker two rounds later after an
// unrelated block clears (the multi-round gap a last-round-only check would miss).
// Any current must-fix whose identity is in the set is demoted to `nice-fix` (it
// still surfaces) and the leg's verdict is recomputed; a must-fix not in the set
// is a new finding and is kept as-is.
//
// An empty set (a leg that has never approved in this session) leaves every
// finding untouched, so a leg that has only ever blocked keeps all its must-fixes.
// Because the set is only ever grown from APPROVING rounds — which by construction
// contain no must-fixes — the guard never demotes a finding that was a genuine
// must-fix before: no weakening. It is per-leg, so reviewer independence holds;
// cross-leg consolidation happens afterwards in `consolidate`.
export function applyStickyApprove(current: ReviewResult, stickyKeys: Set<string>): ReviewResult {
  if (stickyKeys.size === 0) {
    return current;
  }
  let demoted = false;
  const findings: Finding[] = current.findings.map((finding) => {
    if (finding.severity === "must-fix" && stickyKeys.has(findingKey(finding))) {
      demoted = true;
      return { ...finding, severity: "nice-fix" };
    }
    return finding;
  });
  if (!demoted) {
    return current;
  }
  const verdict = findings.some((f) => f.severity === "must-fix") ? "block" : "approve";
  return { reviewer: current.reviewer, findings, verdict };
}

// The leg's sticky set for the NEXT round. A BLOCK round adds nothing (the leg
// accepted none of its findings as non-blocking); an APPROVE round adds every
// finding identity present in it (the leg approved WITH them, so it may not later
// escalate one to a blocking must-fix). Idempotent and order-independent.
export function nextStickyKeys(prior: string[], result: ReviewResult): string[] {
  if (result.verdict !== "approve") {
    return prior;
  }
  const set = new Set(prior);
  for (const finding of result.findings) {
    set.add(findingKey(finding));
  }
  return [...set];
}
