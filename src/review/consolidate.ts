import type { ReviewerName, ReviewResult, Severity, Verdict } from "./types";

// One consolidated finding in the verdict envelope. Severity is implied by the
// bucket it lands in, so it is not repeated here; raised_by records which
// reviewer(s) flagged it.
export interface ConsolidatedFinding {
  lens: string;
  file: string;
  line: number | null;
  finding: string;
  raised_by: ReviewerName[];
  // Each reviewer's OWN severity for this finding. The consolidated bucket above
  // is the max across reviewers (it drives the verdict + the consolidated
  // render); this lets a per-agent comment bucket the finding by what THAT
  // reviewer actually rated, instead of the escalated max. Optional so
  // hand-built envelopes keep working — renderAgentComment falls back to the
  // consolidated bucket when it is absent. Excluded from the consolidated
  // --json by renderJson, so the verdict envelope shape is unchanged.
  perReviewer?: Partial<Record<ReviewerName, Severity>>;
  // Per-leg flag: this finding was demoted from a must-fix to advisory by the
  // refutation-ledger guard for that reviewer (#101). Per-leg (not a single
  // boolean) so a finding that is a genuine must-fix for one leg but a demoted
  // `persistent-unproven` for the other is tagged correctly in each leg's comment.
  // Out-of-band like `perReviewer`: excluded from the --json envelope by renderJson.
  persistentUnproven?: Partial<Record<ReviewerName, boolean>>;
  // Each raising leg's runnable proof for this finding (#101), so a human can see —
  // and run — the evidence behind a blocking finding in the verdict comment.
  // Per-leg (legs may supply different repros). Present only for findings that carry
  // a repro. Out-of-band like the fields above: excluded from the --json envelope.
  repro?: Partial<Record<ReviewerName, string>>;
}

export interface VerdictEnvelope {
  verdict: Verdict;
  must_fix: ConsolidatedFinding[];
  nice_fix: ConsolidatedFinding[];
  nits: ConsolidatedFinding[];
  reviewers: { claude: Verdict; codex: Verdict };
  session: string;
  // The 1-based round number for this review within its `--session` (#100). The
  // pipeline stamps it from the session state (round 1 on the first review of a
  // session or a one-shot; incremented each re-review). Consumed by the PR-comment
  // header and the CLI's posted-verdict signal so a re-review's in-place comment
  // edit is detectable. Like `perReviewer`, it is an out-of-band presentation aid
  // and is excluded from the consolidated `--json` envelope (renderJson), so that
  // machine payload is unchanged. Absent → treated as round 1.
  round?: number;
}

const SEVERITY_RANK: Record<Severity, number> = { "must-fix": 3, "nice-fix": 2, nit: 1 };

interface Entry extends ConsolidatedFinding {
  severity: Severity;
  // Always set while consolidating (every entry is created with its raiser's
  // severity), so the merge loop can read/update it without a null check.
  perReviewer: Partial<Record<ReviewerName, Severity>>;
  // Always set (sparse: only true entries recorded), so the loop can write without
  // a null check (#101).
  persistentUnproven: Partial<Record<ReviewerName, boolean>>;
  // Always set (sparse: only legs that supplied a repro), same rationale (#101).
  repro: Partial<Record<ReviewerName, string>>;
}

// Consolidate the two reviewers' findings into one verdict:
// - union all findings, deduping exact overlaps (same file/line/lens/text) and
//   merging raised_by;
// - a merged finding keeps the most severe assessment (so either reviewer's
//   must-fix counts: block-on-any-must-fix). v1 does NOT promote a nit that both
//   reviewers happen to raise (max(nit, nit) is still nit), keeping it simple
//   and legible;
// - verdict = block iff any must-fix remains, else approve. Nits never block.
export function consolidate(claude: ReviewResult, codex: ReviewResult, session: string): VerdictEnvelope {
  const byKey = new Map<string, Entry>();
  for (const result of [claude, codex]) {
    for (const finding of result.findings) {
      const key = findingKey(finding);
      const existing = byKey.get(key);
      if (existing) {
        if (!existing.raised_by.includes(result.reviewer)) {
          existing.raised_by.push(result.reviewer);
        }
        if (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[existing.severity]) {
          existing.severity = finding.severity;
        }
        // Retain THIS reviewer's own severity (keeping the higher one if the
        // same reviewer happens to raise the finding twice), independent of the
        // consolidated max above.
        const own = existing.perReviewer[result.reviewer];
        if (own === undefined || SEVERITY_RANK[finding.severity] > SEVERITY_RANK[own]) {
          existing.perReviewer[result.reviewer] = finding.severity;
        }
        if (finding.persistentUnproven === true) {
          existing.persistentUnproven[result.reviewer] = true;
        }
        if (finding.repro !== undefined && finding.repro.trim() !== "") {
          existing.repro[result.reviewer] = finding.repro;
        }
      } else {
        byKey.set(key, {
          lens: finding.lens,
          file: finding.file,
          line: finding.line,
          finding: finding.finding,
          raised_by: [result.reviewer],
          severity: finding.severity,
          perReviewer: { [result.reviewer]: finding.severity },
          persistentUnproven: finding.persistentUnproven === true ? { [result.reviewer]: true } : {},
          repro: finding.repro !== undefined && finding.repro.trim() !== "" ? { [result.reviewer]: finding.repro } : {},
        });
      }
    }
  }

  const entries = [...byKey.values()];
  const bucket = (severity: Severity): ConsolidatedFinding[] =>
    entries.filter((e) => e.severity === severity).map(strip);

  const must_fix = bucket("must-fix");
  return {
    verdict: must_fix.length > 0 ? "block" : "approve",
    must_fix,
    nice_fix: bucket("nice-fix"),
    nits: bucket("nit"),
    reviewers: { claude: claude.verdict, codex: codex.verdict },
    session,
  };
}

function strip(entry: Entry): ConsolidatedFinding {
  // Drop the bucket severity, and omit the sparse per-leg maps when empty so a
  // finding with no demotion / no repro carries no empty `{}` noise (keeps
  // hand-built-envelope equality and the consolidated shape clean).
  const { severity: _severity, persistentUnproven, repro, ...rest } = entry;
  return {
    ...rest,
    ...(Object.keys(persistentUnproven).length > 0 ? { persistentUnproven } : {}),
    ...(Object.keys(repro).length > 0 ? { repro } : {}),
  };
}

// A pure-ASCII, collision-safe key for a finding's IDENTITY. JSON.stringify
// escapes any non-ASCII bytes and quotes each part, so distinct (file, line, lens,
// text) tuples can never collide and the source stays plain text. Text is
// normalized (lowercased, whitespace-collapsed) so findings differing only in
// case or whitespace merge (genuinely different wording is left distinct — v1
// dedupe is conservative). Severity is deliberately NOT part of the key: this is
// used both to dedupe here AND by the sticky-approve guard (sticky.ts) to match a
// current finding against a prior-round one, where an escalation of the same
// finding (nit → must-fix) must still match. Exported for that reuse.
export function findingKey(finding: { file: string; line: number | null; lens: string; finding: string }): string {
  const text = finding.finding.toLowerCase().replace(/\s+/g, " ").trim();
  return JSON.stringify([finding.file, finding.line, finding.lens, text]);
}
