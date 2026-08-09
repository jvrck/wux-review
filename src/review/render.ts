import type { ConsolidatedFinding, VerdictEnvelope } from "./consolidate";

// Exit codes: 0 = approve, 2 = block. (Expected user-facing errors —
// WuxReviewError — exit 1, distinct from a clean "blocked" result, so CI can
// tell a real review block from a tool failure.)
export function exitCodeFor(envelope: VerdictEnvelope): number {
  return envelope.verdict === "block" ? 2 : 0;
}

// Out-of-band presentation aids that never appear in the consolidated --json
// envelope: `perReviewer` (per-agent comment bucketing), `round` (#100 header / CLI
// signal), `persistentUnproven` (#101 demotion tag), and `repro` (#101 proof — a
// per-leg map surfaced in the verdict comment + human view, kept off the stable
// machine envelope). Dropping them keeps the JSON shape exactly the spec envelope.
const OUT_OF_BAND_KEYS = new Set(["perReviewer", "round", "persistentUnproven", "repro"]);

export function renderJson(envelope: VerdictEnvelope): string {
  return JSON.stringify(envelope, (key, value) => (OUT_OF_BAND_KEYS.has(key) ? undefined : value), 2);
}

export function renderHuman(envelope: VerdictEnvelope): string {
  const lines: string[] = [];
  lines.push(envelope.verdict === "block" ? "✗ BLOCK" : "✓ APPROVE");
  lines.push(`reviewers: claude ${envelope.reviewers.claude} · codex ${envelope.reviewers.codex}`);
  lines.push(`session: ${envelope.session}`);

  // Only the advisory buckets tag `persistent-unproven`: a finding still in MUST-FIX
  // is genuinely blocking (via a leg that did NOT demote it), so tagging it there
  // would misread as non-blocking (#101).
  section(lines, "MUST-FIX", envelope.must_fix, false);
  section(lines, "NICE-FIX", envelope.nice_fix, true);
  section(lines, "NITS", envelope.nits, true);

  if (envelope.must_fix.length === 0 && envelope.nice_fix.length === 0 && envelope.nits.length === 0) {
    lines.push("");
    lines.push("No findings.");
  }
  return lines.join("\n");
}

function section(lines: string[], title: string, findings: ConsolidatedFinding[], advisory: boolean): void {
  if (findings.length === 0) {
    return;
  }
  lines.push("");
  lines.push(`${title} (${findings.length})`);
  for (const finding of findings) {
    const where = finding.line === null ? finding.file : `${finding.file}:${finding.line}`;
    // A demoted-after-refutation finding is tagged so the operator sees it was a
    // blocker that lost its block power to the ledger, not a plain advisory — but
    // only in the advisory buckets (a still-blocking must-fix is never tagged).
    const tag = advisory && isPersistentUnproven(finding) ? " `persistent-unproven`" : "";
    lines.push(`  • [${finding.lens}] ${where} — ${finding.finding} (raised by ${finding.raised_by.join(", ")})${tag}`);
    // Surface the leg's runnable proof so a human can verify / re-run it (one-lined,
    // matching the PR-comment rendering) (#101).
    for (const repro of reprosOf(finding)) {
      lines.push(`      repro: ${repro.replace(/\s+/g, " ").trim()}`);
    }
  }
}

// True if the refutation-ledger guard demoted this finding for any leg that raised
// it (#101). Used only for display; the flag is per-leg and out-of-band.
function isPersistentUnproven(finding: ConsolidatedFinding): boolean {
  return finding.persistentUnproven !== undefined && Object.values(finding.persistentUnproven).some(Boolean);
}

// The distinct repro commands any leg attached to this finding (#101), for display.
function reprosOf(finding: ConsolidatedFinding): string[] {
  if (finding.repro === undefined) {
    return [];
  }
  return [...new Set(Object.values(finding.repro).filter((r): r is string => typeof r === "string" && r.trim() !== ""))];
}
